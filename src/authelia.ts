import { spawn, execFileSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { roleEnv } from "./marker.ts";
import { base32Encode } from "./providers/portal.ts";
import { randomAlnum } from "./auth-provider.ts";
import { validateUserName, validateDisplayName, validateEmail, yamlEscape } from "./validation.ts";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus, AuthUser } from "./auth-provider.ts";

/**
 * Authelia auth provider (built-in default, design.md §5.3).
 *
 * Green start: resolve authelia binary (PATH > cache > download) → generate
 * configuration.yml (base-path /authelia, file auth backend, sqlite storage,
 * filesystem notifier, NTP disabled, session WITHOUT cookies) + an empty
 * config-tunnels.yml (session + access_control live HERE — Authelia does not
 * merge section contents across files, so the dynamic-registration file must
 * carry the complete sections) → `authelia config validate` → spawn with the
 * authelia role marker.
 *
 * Dynamic registration: append host to session.cookies + access_control rules
 * in config-tunnels.yml (session.secret copied from the main config), then
 * `config validate` + restart. Random hosts work (non-PSL cookie domains).
 */

const DEFAULT_BASE_PATH = "/authelia";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end >= 0 && stat[end + 2] === "Z") return false;
    }
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface AutheliaProviderOptions {
  port?: number;
  basePath?: string;
  sessionSecret?: string;
  policy?: AuthPolicy["policy"];
  user?: { name: string; password: string; displayName?: string };
  externalReloadCmd?: string;
  /** Per-site storage dir (P1); default = cacheDir/tmp/authelia. */
  storageDir?: string;
  /** Per-site data dir (sqlite/notifications); default = cacheDir/data/authelia. */
  dataDir?: string;
  /** Site (auth realm) this instance belongs to. */
  site?: string;
}

interface UserRecord {
  name: string;
  displayName: string;
  email?: string;
  /** argon2 hash (kept internal — never exposed via AuthUser). */
  passwordHash: string;
}

/** Parse users_database.yml into records (passwords kept for round-trips). */
function parseUsersYaml(raw: string): UserRecord[] {
  const out: UserRecord[] = [];
  const lines = raw.split("\n");
  let cur: UserRecord | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const userHead = /^\s{2}([^:\s][^:]*):\s*$/.exec(line);
    if (userHead) {
      if (cur) out.push(cur);
      cur = { name: userHead[1]!, displayName: "", passwordHash: "" };
      continue;
    }
    if (!cur) continue;
    const kv = /^\s{4}(displayname|password|email):\s*["']?([^"'\n]*)["']?/.exec(line);
    if (kv) {
      if (kv[1] === "displayname") cur.displayName = kv[2]!;
      else if (kv[1] === "password") cur.passwordHash = kv[2]!;
      else cur.email = kv[2]!;
    }
  }
  if (cur) out.push(cur);
  return out.filter((u) => u.name && !u.name.startsWith("#") && u.name !== "users");
}

/** Serialize records back to users_database.yml. Values are YAML-escaped
 *  (double-quoted strings escape `\` and `"`) — usernames are additionally
 *  restricted by validateUserName so the `name:` keys can never carry a
 *  newline/colon that would restructure the document. */
export function serializeUsers(users: UserRecord[]): string {
  const esc = (s: string) => yamlEscape(s);
  return (
    "users:\n" +
    users
      .map(
        (u) =>
          `  ${u.name}:\n` +
          `    displayname: "${esc(u.displayName || u.name)}"\n` +
          `    password: "${esc(u.passwordHash)}"\n` +
          `    email: "${esc(u.email ?? `${u.name}@localhost`)}"\n`,
      )
      .join("")
  );
}

async function readUsersFile(usersDb: string): Promise<UserRecord[]> {
  try {
    return parseUsersYaml(readFileSync(usersDb, "utf8"));
  } catch {
    return [];
  }
}

export class AutheliaProvider implements AuthProvider {
  readonly type = "authelia";
  /** Site (auth realm) this instance belongs to ("default" when absent). */
  readonly site: string;
  readonly capabilities = {
    localGateway: true,
    edgeAuth: false,
    randomDomain: true,
    multiHost: true,
    needsSessionStore: true,
  };

  #ctx: ProviderContext;
  #opts: AutheliaProviderOptions;
  #child: ChildProcess | null = null;
  #port: number;
  #basePath: string;
  #dataDir: string;
  #tmpDir: string;
  #mainConfig = "";
  #tunnelConfig = "";
  #usersDb = "";
  #bin: string | null = null;
  /** Registered public hosts (persisted in config-tunnels.yml). */
  #hosts = new Map<string, AuthPolicy["policy"]>();

  constructor(ctx: ProviderContext, opts: AutheliaProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#port = opts.port ?? 0;
    this.#basePath = opts.basePath ?? ""; // 内置默认交给 defaultBasePath();非空会让 deployBasePath 合并失效
    this.#tmpDir = opts.storageDir ?? join(ctx.cacheDir, "tmp", "authelia");
    this.#dataDir = opts.dataDir ?? join(ctx.cacheDir, "data", "authelia");
    this.#mainConfig = join(this.#tmpDir, "configuration.yml");
    this.#tunnelConfig = join(this.#tmpDir, "config-tunnels.yml");
    this.#usersDb = join(this.#tmpDir, "users_database.yml");
    this.site = opts.site ?? "default";
  }

  get port(): number {
    return this.#port;
  }

  get basePath(): string {
    return this.#basePath;
  }

  /** Re-bind base path (registry caches instances per type). */
  async setBasePath(path: string): Promise<void> {
    if (path === this.#basePath) return;
    const wasRunning = this.status().running;
    this.#basePath = path;
    await this.prepare(); // regenerate configs with the new base path
    if (wasRunning) await this.#validateAndRestart();
    this.#ctx.log(`authelia: base path → ${path}`);
  }

  async #resolveBin(): Promise<string> {
    if (this.#bin) return this.#bin;
    this.#bin = await this.#ctx.resolveTool("authelia");
    return this.#bin;
  }

  status(): AuthProviderStatus {
    return {
      running: Boolean(this.#child && alive(this.#child.pid ?? 0)),
      port: this.#port,
    };
  }

  async validate(): Promise<string[]> {
    const problems: string[] = [];
    try {
      await this.#resolveBin();
    } catch (err) {
      problems.push(`authelia binary unavailable: ${(err as Error).message}`);
    }
    try {
      const { execFileSync } = await import("child_process");
      execFileSync("which", ["redis-server"], { stdio: "ignore" });
    } catch {
      problems.push("redis-server not found (authelia needs a session store)");
    }
    return problems;
  }

  renderNginxAuth(): string {
    // The gateway wires auth_request to ${basePath}/api/authz/auth-request
    // automatically (see gateway.ts); this provider needs no extra snippet.
    return "";
  }

  /** 未认证跳转：authelia 门户根（rd 参数），不是 /login（authelia 无此入口）。 */
  loginRedirect(basePath: string, scheme: "http" | "https"): string {
    return `${scheme}://$host${basePath}/?rd=${scheme}://$host$request_uri`;
  }

  /** 默认 basePath：authelia server.address 只允许 [a-z0-9]（无横线）。 */
  defaultBasePath(): string {
    return `/authelia${randomAlnum(8)}`;
  }

  /** Generate both configs + users db. Idempotent. */
  async prepare(): Promise<AuthProviderStatus> {
    await this.#resolveBin();
    mkdirSync(this.#tmpDir, { recursive: true });
    mkdirSync(join(this.#dataDir, "sqlite"), { recursive: true });

    // Persist secrets across restarts: a regenerated encryption_key would
    // fail to decrypt the sqlite database created with the previous key.
    const encryptionKey = this.#existingMainValue("encryption_key") ?? randomSecret(32);
    const secret = this.#opts.sessionSecret ?? this.#existingTunnelSecret() ?? randomSecret(32);
    // users_database.yml — only bootstrap the initial user when the db is
    // empty (addUser/setUserPassword manage it afterwards; never overwrite)
    if ((await this.listUsers()).length === 0) {
      const user = this.#opts.user ?? { name: "admin", password: randomSecret(12) };
      await this.addUser(user.name, user.password, user.displayName ?? "Administrator");
    }

    writeFileSync(
      this.#mainConfig,
      `# service-tunnels authelia — main config (dynamic parts live in config-tunnels.yml)
server:
  address: 'tcp://127.0.0.1:${this.#port}/${this.#basePath.replace(/^\//, "")}'
  # authelia v4.38+ requires the authz implementations to be declared, otherwise
  # /api/authz/auth-request returns 400 for every request (nginx auth_request
  # then 500s). Declare the two nginx-relevant implementations.
  endpoints:
    authz:
      auth-request:
        implementation: 'AuthRequest'
      forward-auth:
        implementation: 'ForwardAuth'
log:
  level: warn
identity_validation:
  reset_password:
    jwt_secret: '${randomSecret(32)}'
authentication_backend:
  file:
    path: '${this.#usersDb}'
    password:
      algorithm: argon2id
storage:
  encryption_key: '${encryptionKey}'
  local:
    path: '${join(this.#dataDir, "sqlite", "authelia.db")}'
notifier:
  filesystem:
    filename: '${join(this.#dataDir, "notification.txt")}'
ntp:
  disable_startup_check: true
`,
      "utf8",
    );

    // config-tunnels.yml: complete session + access_control sections.
    // NOTE: no #restoreHosts here — #hosts is the in-memory source of truth
    // (registerHost fills it). A fresh provider starts EMPTY so a restarted
    // service-tunnels clears stale hosts from previous runs instead of
    // resurrecting dead exposes' session cookies / access_control entries.
    writeFileSync(this.#tunnelConfig, this.#renderTunnelConfig(secret), "utf8");
    try { chmodSync(this.#tunnelConfig, 0o600); } catch {}

    // validate before first start
    const bin = await this.#resolveBin();
    execFileSync(bin, ["config", "validate", "--config", this.#mainConfig, "--config", this.#tunnelConfig], {
      stdio: "ignore",
    });
    this.#ctx.log(`authelia config validated (${this.#basePath}, port ${this.#port || "auto"})`);
    return this.status();
  }

  #renderTunnelConfig(secret: string): string {
    const hosts = [...this.#hosts.keys()];
    const cookieHosts = hosts.length ? hosts : ["127.0.0.1"]; // authelia requires ≥1 cookie domain
    const portal = (h: string) => `https://${h}${this.#basePath}`;
    return `session:
  name: '${this.site === "default" ? "authelia_session" : `authelia_${this.site}_session`}'
  secret: '${secret}'
  cookies:
${cookieHosts.map((h) => `    - domain: '${h}'\n      authelia_url: '${portal(h)}'`).join("\n")}
access_control:
  default_policy: deny
  rules:
${hosts.map((h) => `    - domain:\n        - '${h}'\n      policy: ${this.#hosts.get(h) ?? "two_factor"}`).join("\n") || `    - domain: '**'\n      policy: deny`}
`;
  }

  /** Restore hosts from config-tunnels.yml (persisted across restarts). */
  async start(): Promise<AuthProviderStatus> {
    if (this.#child && alive(this.#child.pid ?? 0)) return this.status();
    if (!this.#port) this.#port = await this.#ctx.pickPort();
    await this.prepare();
    const bin = await this.#resolveBin();
    const child = spawn(
      bin,
      [
        "--config", this.#mainConfig,
        "--config", this.#tunnelConfig,
      ],
      {
        env: { ...process.env, ...roleEnv("authelia") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (c) => this.#ctx.log(`authelia[out]: ${c.toString().trim()}`));
    child.stderr?.on("data", (c) => this.#ctx.log(`authelia[err]: ${c.toString().trim()}`));
    this.#child = child;
    this.#ctx.registerInternal("authelia", this.#port);
    this.#ctx.registerPid("authelia", child.pid ?? 0);
    // wait for readiness
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && alive(child.pid ?? 0)) {
      if (this.#port && (await this.#ready())) return this.status();
      await new Promise((r) => setTimeout(r, 150));
      if (child.exitCode !== null) throw new Error(`authelia exited during startup (${child.exitCode})`);
    }
    if (!this.#port) throw new Error("authelia failed to bind a port");
    if (child.exitCode !== null) throw new Error(`authelia exited during startup (${child.exitCode})`);
    throw new Error("authelia did not become ready in time");
  }

  async #ready(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = _connect(this.#port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        resolve(false);
      });
      s.setTimeout(500, () => {
        s.destroy();
        resolve(false);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // gone
      }
      // wait for the old instance to actually die (port must be free before
      // a restart can rebind it)
      const pid = child.pid;
      if (pid) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && alive(pid)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (alive(pid)) {
          try {
            child.kill("SIGKILL");
          } catch {
            // gone
          }
        }
      }
      this.#child = null;
    }
    this.#ctx.unregisterInternal("authelia");
  }

  async registerHost(host: string, policy?: AuthPolicy): Promise<void> {
    if (this.status().running && this.#opts.externalReloadCmd) {
      // operator-managed authelia: external reload command
      execFileSync(this.#opts.externalReloadCmd, { shell: true, stdio: "ignore" });
      return;
    }
    const secret = this.#sessionSecret();
    this.#hosts.set(host, policy?.policy ?? this.#opts.policy ?? "two_factor");
    writeFileSync(this.#tunnelConfig, this.#renderTunnelConfig(secret), "utf8");
    try { chmodSync(this.#tunnelConfig, 0o600); } catch {}
    await this.#validateAndRestart();
    this.#ctx.log(`authelia: registered ${host}`);
  }

  async unregisterHost(host: string): Promise<void> {
    const secret = this.#sessionSecret();
    this.#hosts.delete(host);
    writeFileSync(this.#tunnelConfig, this.#renderTunnelConfig(secret), "utf8");
    try { chmodSync(this.#tunnelConfig, 0o600); } catch {}
    await this.#validateAndRestart();
  }

  async listHosts(): Promise<string[]> {
    return [...this.#hosts.keys()];
  }

  #sessionSecret(): string {
    return this.#existingTunnelSecret() ?? this.#opts.sessionSecret ?? randomSecret(32);
  }

  /** Value of a `key: '...'` line in the main config (persisted secrets). */
  #existingMainValue(key: string): string | null {
    try {
      const raw = readFileSync(this.#mainConfig, "utf8");
      const m = new RegExp(`^\\s*${key}:\\s*'([^']+)'`, "m").exec(raw);
      return m ? m[1]! : null;
    } catch {
      return null;
    }
  }

  /** session.secret from config-tunnels.yml (persisted across restarts). */
  #existingTunnelSecret(): string | null {
    try {
      const raw = readFileSync(this.#tunnelConfig, "utf8");
      const m = /^\s*secret:\s*'([^']+)'/m.exec(raw);
      return m ? m[1]! : null;
    } catch {
      return null;
    }
  }

  async #validateAndRestart(): Promise<void> {
    const wasRunning = this.status().running;
    // config files may not exist yet when users are managed before the first
    // expose; the file write still lands and takes effect on next start
    if (!wasRunning) return;
    const bin = await this.#resolveBin();
    execFileSync(bin, ["config", "validate", "--config", this.#mainConfig, "--config", this.#tunnelConfig], {
      stdio: "ignore",
    });
    await this.stop();
    await this.start();
  }

  /** Registered users (no secrets). */
  async listUsers(): Promise<AuthUser[]> {
    const records = await readUsersFile(this.#usersDb);
    return records.map(({ name, displayName, email }) => ({ name, displayName, email }));
  }

  /** Add a user (or update displayName/email). Restarts authelia if running. */
  async addUser(name: string, password: string, displayName?: string, email?: string): Promise<void> {
    // username becomes a YAML key + a totp export filename — charset gate is
    // the root fix for both injection surfaces; displayName/email are escaped
    // in serializeUsers.
    validateUserName(name);
    validateDisplayName(displayName);
    validateEmail(email);
    const records = await readUsersFile(this.#usersDb);
    const existing = records.find((r) => r.name === name);
    if (existing) {
      existing.displayName = displayName ?? existing.displayName;
      existing.email = email ?? existing.email;
    } else {
      records.push({
        name,
        displayName: displayName ?? name,
        email: email ?? `${name}@localhost`,
        passwordHash: await this.#hashPassword(password),
      });
    }
    // the db dir is only created by start(); writes must work before start
    mkdirSync(this.#tmpDir, { recursive: true });
    writeFileSync(this.#usersDb, serializeUsers(records), "utf8");
    try { chmodSync(this.#usersDb, 0o600); } catch {}
    await this.#validateAndRestart();
    this.#ctx.log(`authelia: user ${name} ${existing ? "updated" : "added"}`);
  }

  /** Change a user's password. Restarts authelia if running. */
  async setUserPassword(name: string, password: string): Promise<void> {
    validateUserName(name);
    const records = await readUsersFile(this.#usersDb);
    const rec = records.find((r) => r.name === name);
    if (!rec) throw new Error(`user ${name} not registered`);
    rec.passwordHash = await this.#hashPassword(password);
    mkdirSync(this.#tmpDir, { recursive: true });
    writeFileSync(this.#usersDb, serializeUsers(records), "utf8");
    try { chmodSync(this.#usersDb, 0o600); } catch {}
    await this.#validateAndRestart();
    this.#ctx.log(`authelia: password updated for ${name}`);
  }

  /** Remove a user. Restarts authelia if running. */
  async removeUser(name: string): Promise<void> {
    validateUserName(name);
    const records = await readUsersFile(this.#usersDb);
    const next = records.filter((r) => r.name !== name);
    if (next.length === records.length) throw new Error(`user ${name} not registered`);
    writeFileSync(this.#usersDb, serializeUsers(next), "utf8");
    await this.#validateAndRestart();
    this.#ctx.log(`authelia: user ${name} removed`);
  }

  // —— TOTP 2FA management (via authelia's storage CLI) ————————————————————
  // authelia stores TOTP secrets ENCRYPTED in its sqlite storage (NOT the
  // users yaml we write for passwords), and the web API demands an elevation
  // flow to register them. The storage CLI is a trusted operator path: it
  // encrypts with the storage key and writes the credential directly — no
  // elevation, same {secret, otpauthUrl} contract as portal.

  /** Ensure configs + storage schema exist so the storage CLI can run. */
  async #ensureStorageReady(): Promise<string> {
    if (!existsSync(this.#mainConfig) || !existsSync(join(this.#dataDir, "sqlite"))) {
      await this.prepare();
    }
    const bin = await this.#resolveBin();
    // migrate ONLY on a fresh db — `migrate up` exits non-zero with "schema
    // already up to date" once migrated, so calling it unconditionally would
    // break every subsequent TOTP operation.
    const dbPath = join(this.#dataDir, "sqlite", "authelia.db");
    if (!existsSync(dbPath)) {
      execFileSync(bin, ["storage", "migrate", "up", "--config", this.#mainConfig], { stdio: "ignore" });
    }
    return bin;
  }

  /** Enroll TOTP for a user (base32 secret written via authelia's CLI). */
  async totpEnroll(name: string): Promise<{ secret: string; otpauthUrl: string }> {
    validateUserName(name);
    const rec = (await readUsersFile(this.#usersDb)).find((r) => r.name === name);
    if (!rec) throw new Error(`user ${name} not registered`);
    const bin = await this.#ensureStorageReady();
    const secret = base32Encode(randomBytes(20));
    execFileSync(
      bin,
      ["storage", "user", "totp", "generate", name, "--secret", secret, "--force", "--config", this.#mainConfig],
      { stdio: "ignore" },
    );
    const label = encodeURIComponent(`${name}@service-tunnels`);
    this.#ctx.log(`authelia: TOTP enrolled for ${name}`);
    return {
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=service-tunnels&algorithm=SHA1&digits=6&period=30`,
    };
  }

  /** Whether the user has a TOTP credential in storage. */
  async totpStatus(name: string): Promise<{ enrolled: boolean }> {
    // name is interpolated into the export FILE name — the charset gate
    // blocks path traversal (../) here.
    validateUserName(name);
    const bin = await this.#ensureStorageReady();
    const outFile = join(this.#tmpDir, `totp-export-${name}.yml`);
    // export exits non-zero when NO configurations exist (e.g. right after
    // disable) — treat that as "not enrolled", not an error.
    try {
      execFileSync(bin, ["storage", "user", "totp", "export", "--file", outFile, "--config", this.#mainConfig], { stdio: "ignore" });
      return { enrolled: readFileSync(outFile, "utf8").includes(`username: ${name}`) };
    } catch {
      return { enrolled: false };
    }
  }

  /** Delete a user's TOTP credential. */
  async totpDisable(name: string): Promise<void> {
    validateUserName(name);
    const bin = await this.#ensureStorageReady();
    execFileSync(bin, ["storage", "user", "totp", "delete", name, "--config", this.#mainConfig], { stdio: "ignore" });
    this.#ctx.log(`authelia: TOTP disabled for ${name}`);
  }

  async #hashPassword(password: string): Promise<string> {
    const bin = await this.#resolveBin();
    // `authelia crypto hash generate argon2 --password <pw>` prints the hash
    const out = execFileSync(bin, ["crypto", "hash", "generate", "argon2", "--password", password], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /(\$argon2id\$[^\s]+)/.exec(out);
    if (!m) throw new Error("authelia: failed to generate argon2 hash");
    return m[1]!;
  }
}

function randomSecret(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// TCP probe
import { connect as _connect } from "net";
