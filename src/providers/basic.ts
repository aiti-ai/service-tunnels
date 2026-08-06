import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { validateUserName } from "../validation.ts";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus, AuthUser, UserManager } from "../auth-provider.ts";

/**
 * basic provider — nginx auth_basic with an htpasswd file.
 *
 * The lightest option: no local auth process, no Redis. Every registered host
 * is protected by HTTP Basic credentials. Credentials live in
 * cacheDir/tmp/basic/htpasswd (0600); the hash is generated with `openssl
 * passwd -apr1` (nginx auth_basic supports APR1 but NOT bcrypt), falling back
 * to `htpasswd` (crypt) when openssl is missing.
 *
 * Implements UserManager: the htpasswd file IS the local user database.
 */

export interface BasicAuthProviderOptions {
  user?: { name: string; password: string };
  /** Per-site storage dir (P1); default = cacheDir/tmp/basic. */
  storageDir?: string;
  /** Site (auth realm) this instance belongs to. */
  site?: string;
}

export class BasicAuthProvider implements AuthProvider, UserManager {
  readonly type = "basic";
  /** nginx auth_basic：无 forward-auth 探针、无 basePath、无登录页。 */
  readonly gatewayMode = "basic" as const;

  /** basic 无 basePath（nginx auth_basic 不需要）。 */
  defaultBasePath(): string {
    return "";
  }
  /** Site (auth realm) this instance belongs to ("default" when absent). */
  readonly site: string;
  readonly capabilities = {
    localGateway: true,
    edgeAuth: false,
    randomDomain: true,
    multiHost: true,
    needsSessionStore: false,
  };

  #ctx: ProviderContext;
  #opts: BasicAuthProviderOptions;
  #htpasswd = "";
  #creds = { name: "admin", password: "" };

  constructor(ctx: ProviderContext, opts: BasicAuthProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#creds = {
      name: opts.user?.name ?? "admin",
      password: opts.user?.password ?? randomSecret(12),
    };
    this.#htpasswd = opts.storageDir ? join(opts.storageDir, "htpasswd") : join(ctx.cacheDir, "tmp", "basic", "htpasswd");
    this.site = opts.site ?? "default";
  }

  get htpasswdFile(): string {
    return this.#htpasswd;
  }

  status(): AuthProviderStatus {
    return { running: true }; // stateless — nothing to run
  }

  async prepare(): Promise<AuthProviderStatus> {
    mkdirSync(dirname(this.#htpasswd), { recursive: true });
    // Only bootstrap the initial user when the db is empty — later runs must
    // NOT wipe users added via addUser().
    if (!existsSync(this.#htpasswd) || readFileSync(this.#htpasswd, "utf8").trim() === "") {
      await this.addUser(this.#creds.name, this.#creds.password);
      this.#ctx.log(`basic: bootstrapped initial user ${this.#creds.name}`);
    }
    return this.status();
  }

  async start(): Promise<AuthProviderStatus> {
    return this.prepare();
  }

  async stop(): Promise<void> {
    // nothing to stop
  }

  async validate(): Promise<string[]> {
    const problems: string[] = [];
    if (!this.#creds.password) problems.push("basic auth requires a password");
    return problems;
  }

  renderNginxAuth(): string {
    return `auth_basic "service-tunnels"; auth_basic_user_file ${this.#htpasswd};`;
  }

  async registerHost(_host: string, _policy?: AuthPolicy): Promise<void> {
    // basic auth applies to every host — nothing per-host to register
  }

  async unregisterHost(_host: string): Promise<void> {
    // nothing to unregister
  }

  async listHosts(): Promise<string[]> {
    return [];
  }

  // —— UserManager ——

  /** APR1 hash via openssl stdin (never in argv); htpasswd crypt fallback. */
  async #hash(password: string): Promise<string> {
    try {
      const out = execFileSync(
        "openssl",
        ["passwd", "-apr1", "-stdin"],
        { input: password, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
      );
      return out.trim();
    } catch {
      const out = execFileSync(
        "htpasswd",
        ["-nb", "x", password],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return out.trim().split(":")[1] ?? "";
    }
  }

  async #readDb(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      for (const line of readFileSync(this.#htpasswd, "utf8").split("\n")) {
        const i = line.indexOf(":");
        if (i > 0) out.set(line.slice(0, i), line.slice(i + 1));
      }
    } catch {
      // missing file → empty db
    }
    return out;
  }

  async #writeDb(rows: Map<string, string>): Promise<void> {
    mkdirSync(dirname(this.#htpasswd), { recursive: true });
    const file = `${this.#htpasswd}.${process.pid}.tmp`;
    writeFileSync(file, [...rows.entries()].map(([n, h]) => `${n}:${h}`).join("\n") + "\n", "utf8");
    try {
      execFileSync("chmod", ["600", file], { stdio: "ignore" });
    } catch {
      // best-effort
    }
    execFileSync("mv", [file, this.#htpasswd], { stdio: "ignore" });
  }

  async listUsers(): Promise<AuthUser[]> {
    const rows = await this.#readDb();
    return [...rows.keys()].map((name) => ({ name, displayName: name }));
  }

  async addUser(name: string, password: string, displayName?: string): Promise<void> {
    // username becomes a htpasswd LINE (`name:hash`) — a `:` or newline in
    // the name would inject a fake user entry
    validateUserName(name);
    const rows = await this.#readDb();
    const isNew = !rows.has(name);
    rows.set(name, await this.#hash(password));
    await this.#writeDb(rows);
    this.#ctx.log(`basic: user ${name} ${isNew ? "added" : "updated"}`);
  }

  async setUserPassword(name: string, password: string): Promise<void> {
    validateUserName(name);
    const rows = await this.#readDb();
    if (!rows.has(name)) throw new Error(`user ${name} not registered`);
    rows.set(name, await this.#hash(password));
    await this.#writeDb(rows);
    this.#ctx.log(`basic: password updated for ${name}`);
  }

  async removeUser(name: string): Promise<void> {
    validateUserName(name);
    const rows = await this.#readDb();
    if (!rows.delete(name)) throw new Error(`user ${name} not registered`);
    await this.#writeDb(rows);
    this.#ctx.log(`basic: user ${name} removed`);
  }
}

function randomSecret(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
