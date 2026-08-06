import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { execFileSync, spawn } from "child_process";
import { join } from "path";
import { randomBytes, scryptSync, createHmac, timingSafeEqual } from "crypto";
import { connect } from "net";
import { validateUserName } from "../validation.ts";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus, AuthUser, UserManager } from "../auth-provider.ts";
import { randomName } from "../auth-provider.ts";

/**
 * portal provider — self-contained Node forward-auth login portal.
 *
 * The green answer to authelia on platforms without binaries (notably
 * Windows, where authelia/pomerium ship no artifacts): spawns a tiny Node
 * HTTP server (Node is already present in any environment that can run this
 * package) that speaks the same forward-auth protocol as authelia:
 *
 *   GET {basePath}/api/authz/auth-request   nginx auth_request probe
 *   GET {basePath}/login                    portal page
 *   POST {basePath}/login                   credential check → signed cookie
 *
 * Security model (1FA baseline, see docs/config.md):
 *   - passwords hashed with scrypt (node:crypto, random 16B salt, 64B key)
 *   - session cookie = base64url(expiry.name) + HMAC-SHA256 signature,
 *     verified with timingSafeEqual; HttpOnly + SameSite=Strict
 *   - login rate-limited per IP (5 attempts / minute sliding window)
 *   - server binds 127.0.0.1 only; forwarded via nginx auth_request
 *   - (optional) cookie Secure via PORTAL_SECURE=1 env for https tunnels
 *
 * Users live in cacheDir/tmp/portal/users.json and are managed through the
 * standard UserManager interface (list/add/set-password/remove).
 */

export interface PortalAuthProviderOptions {
  port?: number;
  basePath?: string;
  /** Embedder's deployment base path (host /dev): the DEFAULT post-login
   *  redirect target (next) when the login form carries none — /dev/portal/...
   *  deployments redirect to /dev instead of /. */
  deployBasePath?: string;
  /** Bootstrap user (only created when the db is empty). */
  user?: { name: string; password: string; displayName?: string };
  /** Per-site storage dir (P1); default = cacheDir/tmp/portal. */
  storageDir?: string;
  /** Site (auth realm) this instance belongs to. */
  site?: string;
}

interface PortalUserRecord {
  displayName: string;
  salt: string;
  hash: string;
  /** Base32 TOTP secret (RFC 6238) when the user has 2FA enrolled. */
  totpSecret?: string;
  /** New TOTP secret awaiting first-code activation (never enforced until
   *  verified — prevents an API caller from silently replacing a user's 2FA). */
  totpPending?: string;
}

/**
 * TOTP verification for the PARENT process (used by totpActivate). The portal
 * HTTP server is a generated subprocess script carrying its own copy of this
 * logic; the parent needs an independent implementation to activate pending
 * enrollments (RFC 6238, SHA-1, 30s steps, ±1 window).
 */
function verifyTotpParent(secretB32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secretB32).toUpperCase().replace(/=+$/, "");
  const key = Buffer.alloc((clean.length * 5) >> 3);
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return false;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      key[idx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (idx === 0) return false;
  const step = Math.floor(Date.now() / 30_000);
  for (let off = -1; off <= 1; off++) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + off));
    const hmac = createHmac("sha1", key).update(counter).digest();
    const o = hmac[hmac.length - 1]! & 0x0f;
    const num = ((hmac[o]! & 0x7f) << 24) | (hmac[o + 1]! << 16) | (hmac[o + 2]! << 8) | hmac[o + 3]!;
    const otp = String(num % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(otp), Buffer.from(code))) return true;
  }
  return false;
}

export class PortalAuthProvider implements AuthProvider, UserManager {
  readonly type = "portal";
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
  #opts: PortalAuthProviderOptions;
  #dir = "";
  #usersFile = "";
  #serverFile = "";
  #port = 0;
  #basePath = "/portal";
  #deployBasePath = "";
  #secret = "";
  #proc: ReturnType<typeof spawn> | null = null;
  #creds = { name: "admin", password: "" };

  constructor(ctx: ProviderContext, opts: PortalAuthProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#creds = {
      name: opts.user?.name ?? "admin",
      password: opts.user?.password ?? randomBytes(9).toString("base64url"),
    };
    this.#dir = opts.storageDir ?? join(ctx.cacheDir, "tmp", "portal");
    this.#usersFile = join(this.#dir, "users.json");
    this.#serverFile = join(this.#dir, "server.mjs");
    this.#port = opts.port ?? 0;
    this.#basePath = opts.basePath ?? "/portal";
    this.#deployBasePath = (opts.deployBasePath ?? "").replace(/\/+$/, "");
    this.site = opts.site ?? "default";
    // per-instance random secret — NOT persisted: exposes are lifecycle-only,
    // so a restart kills the tunnels and the public hosts change. A persisted
    // cookie secret would keep sessions valid only for the OLD (dead) hosts.
    this.#secret = randomBytes(32).toString("hex");
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
    this.#basePath = path;
    await this.#restart(); // server script + env use the new base path
    this.#ctx.log(`portal: base path → ${path}`);
  }

  status(): AuthProviderStatus {
    return { running: this.#proc !== null && this.#proc.exitCode === null, port: this.#port };
  }

  async validate(): Promise<string[]> {
    const problems: string[] = [];
    if (!this.#creds.password) problems.push("portal auth requires a password");
    return problems;
  }

  async prepare(): Promise<AuthProviderStatus> {
    mkdirSync(this.#dir, { recursive: true });
    writeServerScript(this.#serverFile, this.#basePath, this.#deployBasePath, this.site);
    if (!existsSync(this.#usersFile)) {
      await this.addUser(this.#creds.name, this.#creds.password, this.#opts.user?.displayName ?? "Administrator");
      this.#ctx.log(`portal: bootstrapped initial user ${this.#creds.name}`);
    }
    return this.status();
  }

  async start(): Promise<AuthProviderStatus> {
    if (this.status().running) return this.status();
    await this.prepare();
    for (let attempt = 0; ; attempt++) {
      if (!this.#port) this.#port = await this.#ctx.pickPort();
      const p = spawn(process.execPath, [this.#serverFile], {
        env: {
          ...process.env,
          PORT: String(this.#port),
          SECRET: this.#secret,
          USERS_FILE: this.#usersFile,
          BASE_PATH: this.#basePath,
          DEPLOY_BASE_PATH: this.#deployBasePath,
          SECURE: process.env.PORTAL_SECURE === "1" ? "1" : "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.#proc = p;
      this.#ctx.registerPid("portal", p.pid ?? 0);
      p.stdout?.on("data", (d) => this.#ctx.log(`[portal] ${String(d).trim()}`));
      p.stderr?.on("data", (d) => this.#ctx.log(`[portal] ${String(d).trim()}`));
      try {
        await waitTcp(this.#port, 10_000);
        // confirm it is OUR portal (401 on the auth probe) — a squatter on
        // the port (e.g. nginx that raced us) would answer differently
        await probePortal(this.#port, this.#basePath);
        this.#ctx.log(`portal: listening on 127.0.0.1:${this.#port}`);
        return this.status();
      } catch (err) {
        await killQuiet(p);
        this.#proc = null;
        this.#port = 0;
        if (attempt >= 4) throw err;
        this.#ctx.log(`portal: port ${this.#port} raced — retrying`);
      }
    }
  }

  async stop(): Promise<void> {
    const p = this.#proc;
    this.#proc = null;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      p.once("exit", () => resolve());
      p.kill();
      setTimeout(() => {
        if (p.exitCode === null) p.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
  }

  /** Restart so user-db changes take effect (portal loads users at boot). */
  async #restart(): Promise<void> {
    const wasRunning = this.status().running;
    await this.stop();
    if (wasRunning) await this.start();
  }

  renderNginxAuth(): string {
    return ""; // gateway wires auth_request → {basePath}/api/authz/auth-request
  }

  /** 默认 basePath：随机趣味名（避免与 app 路由冲突）。 */
  defaultBasePath(): string {
    return `/portal-${randomName()}`;
  }

  /** 未认证跳转：portal 登录页（next 参数带回原路径）。 */
  loginRedirect(basePath: string, scheme: "http" | "https"): string {
    return `${scheme}://$host${basePath}/login?next=$request_uri`;
  }

  async registerHost(_host: string, _policy?: AuthPolicy): Promise<void> {
    // stateless forward-auth — cookies follow the request host, nothing to register
  }

  async unregisterHost(_host: string): Promise<void> {
    // nothing to unregister
  }

  async listHosts(): Promise<string[]> {
    return [];
  }

  // —— UserManager (users.json, scrypt hashes) ——

  async #readDb(): Promise<Map<string, PortalUserRecord>> {
    const out = new Map<string, PortalUserRecord>();
    try {
      const data = JSON.parse(readFileSync(this.#usersFile, "utf8")) as Record<string, PortalUserRecord>;
      for (const [name, rec] of Object.entries(data)) out.set(name, rec);
    } catch {
      // missing/corrupt → empty db
    }
    return out;
  }

  async #writeDb(rows: Map<string, PortalUserRecord>): Promise<void> {
    mkdirSync(this.#dir, { recursive: true });
    const file = `${this.#usersFile}.${process.pid}.tmp`;
    writeFileSync(file, JSON.stringify(Object.fromEntries(rows), null, 2), "utf8");
    try {
      execFileSync("chmod", ["600", file], { stdio: "ignore" });
    } catch {
      // best-effort
    }
    execFileSync("mv", [file, this.#usersFile], { stdio: "ignore" });
    await this.#restart();
  }

  async listUsers(): Promise<AuthUser[]> {
    const rows = await this.#readDb();
    return [...rows.entries()].map(([name, rec]) => ({ name, displayName: rec.displayName }));
  }

  async addUser(name: string, password: string, displayName?: string): Promise<void> {
    // users.json is JSON (escaping-safe), but the name is also used as a
    // cookie subject + otpauth label — keep the same charset gate everywhere.
    validateUserName(name);
    const rows = await this.#readDb();
    const isNew = !rows.has(name);
    const salt = randomBytes(16).toString("hex");
    rows.set(name, {
      displayName: displayName ?? name,
      salt,
      hash: hashPassword(password, salt),
    });
    await this.#writeDb(rows);
    this.#ctx.log(`portal: user ${name} ${isNew ? "added" : "updated"}`);
  }

  async setUserPassword(name: string, password: string): Promise<void> {
    validateUserName(name);
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    rec.salt = randomBytes(16).toString("hex");
    rec.hash = hashPassword(password, rec.salt);
    await this.#writeDb(rows);
    this.#ctx.log(`portal: password updated for ${name}`);
  }

  async removeUser(name: string): Promise<void> {
    validateUserName(name);
    const rows = await this.#readDb();
    if (!rows.delete(name)) throw new Error(`user ${name} not registered`);
    await this.#writeDb(rows);
    this.#ctx.log(`portal: user ${name} removed`);
  }

  // —— TOTP 2FA management ——

  /** Enroll TOTP for a user. Returns the base32 secret + otpauth URL. */
  async totpEnroll(name: string): Promise<{ secret: string; otpauthUrl: string }> {
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    const secret = base32Encode(randomBytes(20));
    // Pending until the user proves they hold the secret (first TOTP code) —
    // the existing totpSecret (if any) stays enforced meanwhile, so a caller
    // of the management API cannot silently take over a user's 2FA.
    rec.totpPending = secret;
    await this.#writeDb(rows);
    const label = encodeURIComponent(`${name}@service-tunnels`);
    this.#ctx.log(`portal: TOTP enrolled for ${name}`);
    return {
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=service-tunnels&algorithm=SHA1&digits=6&period=30`,
    };
  }

  /** Disable TOTP for a user. */
  async totpDisable(name: string): Promise<void> {
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    if (!rec.totpSecret) throw new Error(`user ${name} has no TOTP enrolled`);
    delete rec.totpSecret;
    await this.#writeDb(rows);
    this.#ctx.log(`portal: TOTP disabled for ${name}`);
  }

  /** Whether a user has TOTP enrolled (pending = awaiting activation). */
  async totpStatus(name: string): Promise<{ enrolled: boolean; pending: boolean }> {
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    return { enrolled: Boolean(rec.totpSecret), pending: Boolean(rec.totpPending) };
  }

  /** Activate a pending TOTP enrollment with the first code from the user's
   *  authenticator. Only after a correct code is verified does the pending
   *  secret replace the active one (standard TOTP flow). */
  async totpActivate(name: string, code: string): Promise<{ activated: boolean }> {
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    if (!rec.totpPending) throw new Error(`user ${name} has no pending TOTP enrollment`);
    if (!verifyTotpParent(rec.totpPending, code)) throw new Error("invalid verification code");
    rec.totpSecret = rec.totpPending;
    delete rec.totpPending;
    await this.#writeDb(rows);
    this.#ctx.log(`portal: TOTP activated for ${name}`);
    return { activated: true };
  }
}

// —— helpers shared with the generated server script ——

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

async function probePortal(port: number, basePath: string): Promise<void> {
  const { request } = await import("http");
  await new Promise<void>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: `${basePath}/api/authz/auth-request`, method: "GET" },
      (res) => {
        res.resume();
        if (res.statusCode === 401) resolve();
        else reject(new Error(`portal probe returned ${res.statusCode} (not our portal)`));
      },
    );
    req.on("error", reject);
    req.setTimeout(3_000, () => req.destroy(new Error("portal probe timeout")));
    req.end();
  });
}

async function killQuiet(p: ReturnType<typeof spawn>): Promise<void> {
  if (p.exitCode !== null) return;
  p.kill();
  await new Promise((r) => {
    p.once("exit", r);
    setTimeout(r, 1_500).unref();
  });
  if (p.exitCode === null) p.kill("SIGKILL");
}

function waitTcp(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`portal: port ${port} did not open`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** The generated portal server (ESM, written to cacheDir/tmp/portal/server.mjs). */
function writeServerScript(file: string, basePath: string, deployBasePath = "", site = "default"): void {
  const script = `import { createServer } from "http";
import { readFileSync, writeFileSync } from "fs";
import { createHmac, scryptSync, randomBytes, timingSafeEqual, generateKeyPairSync, privateDecrypt, constants } from "crypto";

const PORT = Number(process.env.PORT);
const SECRET = process.env.SECRET;
const USERS_FILE = process.env.USERS_FILE;
const BASE = process.env.BASE_PATH || "/portal";
const DEPLOY = process.env.DEPLOY_BASE_PATH || "";
const SECURE = process.env.SECURE === "1";
const COOKIE = "st_portal${site === "default" ? "" : "_" + site}_session";
const COOKIE2 = "st_portal${site === "default" ? "" : "_" + site}_2fa";
const SITE = ${JSON.stringify(site)};
const TTL_MS = 7 * 24 * 3600 * 1000;

function loadUsers() {
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function issueSession(name, cookieName = COOKIE, ttl = TTL_MS) {
  // cookieName is mixed into the payload so a 2FA ticket can never be
  // replayed as a full session cookie (or vice versa)
  const payload = String(Date.now() + ttl) + "." + cookieName + "." + name;
  const body = Buffer.from(payload).toString("base64url");
  return body + "." + sign(body);
}

function verifySession(token, cookieName = COOKIE) {
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = Buffer.from(body, "base64url").toString("utf8");
  const parts = payload.split(".");
  const expiry = Number(parts[0]);
  if (!expiry || expiry < Date.now()) return null;
  if (parts[1] !== cookieName) return null;
  return parts.slice(2).join(".");
}

// —— TOTP (RFC 6238, SHA-1, 30s steps, ±1 window) ————————————————
function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, "")) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function verifyTotp(secretB32, code) {
  if (!/^\\d{6}$/.test(code)) return false;
  const key = base32Decode(secretB32);
  if (!key || !key.length) return false;
  const step = Math.floor(Date.now() / 30_000);
  for (let off = -1; off <= 1; off++) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + off));
    const hmac = createHmac("sha1", key).update(counter).digest();
    const o = hmac[hmac.length - 1] & 0x0f;
    const num = ((hmac[o] & 0x7f) << 24) | (hmac[o + 1] << 16) | (hmac[o + 2] << 8) | hmac[o + 3];
    const otp = String(num % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(otp), Buffer.from(code))) return true;
  }
  return false;
}

function escapeAttr(s) {
  // raw next in the hidden field (NOT URL-encoded): the browser form-encodes
  // on submit + URLSearchParams decodes server-side, so pre-encoding would
  // stack encodings every redirect and break the post-login redirect to /
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function totpPage(next, error, host) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  return '<!doctype html><html><head><meta charset="utf-8"><title>Two-factor</title>'
    + '<style>body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7}'
    + 'form{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:22rem}'
    + 'h1{font-size:1.15rem;margin:0 0 .3rem}p.hint{font-size:.85rem;color:#666;margin:0 0 .6rem}'
    + 'p.meta{font-size:.72rem;color:#888;margin:0 0 1rem;line-height:1.6}p.meta b{color:#555}'
    + 'input{width:100%;box-sizing:border-box;padding:.55rem;border:1px solid #d0d3da;border-radius:6px;letter-spacing:.35em;text-align:center}'
    + 'button{margin-top:1.2rem;width:100%;padding:.6rem;background:#2d6cdf;color:#fff;border:0;border-radius:6px;cursor:pointer}</style>'
    + '</head><body><form method="post" action="' + BASE + '/login/2fa">'
    + '<h1>Two-factor authentication</h1>'
    + '<p class="hint">Enter the 6-digit code from your authenticator app.</p>'
    + (SITE || host ? '<p class="meta">Site: <b>' + SITE + '</b><br>Domain: <b>' + escapeAttr(host || "") + '</b></p>' : "")
    + '<input type="hidden" name="next" value="' + escapeAttr(next) + '">' + err
    + '<input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>'
    + '<button type="submit">Verify</button></form></body></html>';
}

// —— brute-force protection (authelia-style) ————————————————
// Per-account AND per-IP sliding window: FIND_MS (5 min) window, MAX_RETRIES
// (5) failures → banned for BAN_MS (15 min); repeated bans escalate 2x/4x.
// State persists to BRUTE_FILE so bans survive process restarts.
const BRUTE_FILE = USERS_FILE.replace(/users\.json$/, "brute.json");
const FIND_MS = 5 * 60_000;
const MAX_RETRIES = 5;
const BAN_MS = 15 * 60_000;
function loadBrute() {
  try { return JSON.parse(readFileSync(BRUTE_FILE, "utf8")); } catch { return { accounts: {}, ips: {} }; }
}
function saveBrute(b) {
  try { writeFileSync(BRUTE_FILE, JSON.stringify(b)); } catch { /* best-effort */ }
}
function sweepFailures(list, now) {
  return (list || []).filter((t) => now - t < FIND_MS);
}
function banState(account, ip) {
  const now = Date.now();
  const b = loadBrute();
  const acct = b.accounts[account];
  const addr = b.ips[ip];
  const acctUntil = acct && acct.bannedUntil > now ? acct.bannedUntil : 0;
  const ipUntil = addr && addr.bannedUntil > now ? addr.bannedUntil : 0;
  return Math.max(acctUntil, ipUntil);
}
function recordFailure(account, ip) {
  const now = Date.now();
  const b = loadBrute();
  const acct = b.accounts[account] || (b.accounts[account] = { fails: [], strikes: 0, bannedUntil: 0 });
  const addr = b.ips[ip] || (b.ips[ip] = { fails: [], strikes: 0, bannedUntil: 0 });
  for (const t of [acct, addr]) {
    t.fails = sweepFailures(t.fails, now);
    t.fails.push(now);
    if (t.fails.length >= MAX_RETRIES) {
      const factor = Math.pow(2, Math.min(t.strikes, 4));
      t.bannedUntil = now + BAN_MS * factor;
      t.strikes += 1;
      t.fails = [];
    }
  }
  saveBrute(b);
}
function clearFailures(account, ip) {
  const b = loadBrute();
  if (b.accounts[account]) b.accounts[account].fails = [];
  if (b.ips[ip]) b.ips[ip].fails = [];
  saveBrute(b);
}

// —— login password transport: RSA-OAEP front-end encryption ————————
// The tunnel edge (cloudflared/Cloudflare) sees HTTP POST bodies, so the
// plaintext password would leave this machine. Instead every login page
// issues a fresh one-time RSA keypair (2048-bit, 5 min TTL); the browser
// encrypts the password with the public key (WebCrypto) and we decrypt with
// the private key that NEVER leaves this process. Key ids are single-use —
// a captured ciphertext cannot be replayed.
const rsaKeys = new Map();
const RSA_TTL_MS = 5 * 60_000;
function issueRsaKey() {
  cleanupRsaKeys();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = randomBytes(8).toString("hex");
  rsaKeys.set(keyId, { privateKey, expires: Date.now() + RSA_TTL_MS });
  return { keyId, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}
function cleanupRsaKeys() {
  const now = Date.now();
  for (const [id, k] of rsaKeys) if (k.expires < now) rsaKeys.delete(id);
}
function decryptPassword(keyId, encryptedB64) {
  const pair = rsaKeys.get(keyId);
  rsaKeys.delete(keyId); // one-time use — replay of a captured ciphertext fails
  if (!pair || pair.expires < Date.now()) throw new Error("stale or unknown key id");
  try {
    return privateDecrypt(
      { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(encryptedB64, "base64"),
    ).toString("utf8");
  } catch {
    throw new Error("decryption failed");
  }
}

function html(next, error, keyId, publicKey, host) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  const noJs = '<noscript><p class="warn">JavaScript is disabled — the password will be sent unencrypted. Enable JavaScript for encrypted sign-in.</p></noscript>'
    + '<p id="js-warn" class="warn" style="display:none">This browser has no WebCrypto (crypto.subtle) — the password will be sent unencrypted. Use a modern browser for encrypted sign-in.</p>';
  const enc = publicKey
    ? '<script>if (!window.crypto || !crypto.subtle) { var w = document.getElementById("js-warn"); if (w) w.style.display = "block"; }</script>'
      + '<script>'
      + 'const PUB="' + publicKey + '";'
      + 'const KEY_ID="' + keyId + '";'
      + 'function b64ToBuf(b){const bin=atob(b);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer;}'
      + 'document.addEventListener("DOMContentLoaded",async()=>{'
      + 'const f=document.getElementById("login");'
      + 'f.addEventListener("submit",async(e)=>{'
      + 'e.preventDefault();'
      + 'const pw=document.getElementById("pw").value;'
      + 'const key=await crypto.subtle.importKey("spki",b64ToBuf(PUB),{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);'
      + 'const enc=new Uint8Array(await crypto.subtle.encrypt({name:"RSA-OAEP"},key,new TextEncoder().encode(pw)));'
      + 'let b="";for(const x of enc)b+=String.fromCharCode(x);'
      + 'document.getElementById("encrypted").value=btoa(b);'
      + 'document.getElementById("keyId").value=KEY_ID;'
      + 'document.getElementById("pw").value="";'
      + 'f.submit();'
      + '});});</script>'
    : "";
  return '<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>'
    + '<style>body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7}'
    + 'form{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:22rem}'
    + 'h1{font-size:1.15rem;margin:0 0 1.2rem}label{display:block;font-size:.8rem;color:#666;margin:.8rem 0 .25rem}'
    + 'input{width:100%;box-sizing:border-box;padding:.55rem;border:1px solid #d0d3da;border-radius:6px}'
    + 'button{margin-top:1.4rem;width:100%;padding:.6rem;background:#2d6cdf;color:#fff;border:0;border-radius:6px;cursor:pointer}'
    + 'p.warn{background:#fdf3e0;border:1px solid #f0c36d;color:#8a6d1a;font-size:.8rem;padding:.5rem .7rem;border-radius:6px;margin:1rem 0 .2rem;line-height:1.4}'
    + 'p.meta{font-size:.72rem;color:#888;margin:0 0 1rem;line-height:1.6}p.meta b{color:#555}</style>'
    + '</head><body>' + enc
    + '<form id="login" method="post" action="' + BASE + '/login">'
    + '<h1>Sign in to access this service</h1>'
    + (SITE || host ? '<p class="meta">Site: <b>' + SITE + '</b><br>Domain: <b>' + escapeAttr(host || "") + '</b></p>' : "")
    + '<input type="hidden" name="next" value="' + escapeAttr(next) + '">' + err + noJs
    + '<input type="hidden" name="encrypted" id="encrypted">'
    + '<input type="hidden" name="keyId" id="keyId">'
    + '<label>Username</label><input name="username" autocomplete="username" required autofocus>'
    + '<label>Password</label><input name="password" id="pw" type="password" autocomplete="current-password" required>'
    + '<button type="submit">Sign in</button></form></body></html>';
}

function setSession(res, name, next, cookieName = COOKIE, ttl = TTL_MS) {
  const token = issueSession(name, cookieName, ttl);
  res.writeHead(302, {
    Location: next || "/",
    "Set-Cookie": cookieName + "=" + token + "; Path=/; HttpOnly; SameSite=Strict"
      + (SECURE ? "; Secure" : ""),
  });
  res.end();
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");

  if (url.pathname === BASE + "/api/authz/auth-request" && req.method === "GET") {
    const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim())
      .find((c) => c.startsWith(COOKIE + "="));
    const name = cookie ? verifySession(cookie.slice(COOKIE.length + 1)) : null;
    if (!name) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    res.writeHead(200, { "X-St-Auth-User": name });
    res.end("ok");
    return;
  }

  if (url.pathname === BASE + "/login" && req.method === "GET") {
    const next = url.searchParams.get("next") || DEPLOY || "/";
    const { keyId, publicKey } = issueRsaKey();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html(next, "", keyId, publicKey, req.headers.host || ""));
    return;
  }

  if (url.pathname === BASE + "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const name = params.get("username") || "";
      const next = params.get("next") || DEPLOY || "/";
      // brute-force gate: account/IP banned → 429 with Retry-After
      const bannedUntil = banState(name, ip);
      if (bannedUntil > Date.now()) {
        res.writeHead(429, {
          "Content-Type": "text/html",
          "Retry-After": String(Math.ceil((bannedUntil - Date.now()) / 1000)),
        });
        res.end(html(next, "Too many failed attempts — account is temporarily locked.", undefined, undefined, req.headers.host || ""));
        return;
      }
      let password = params.get("password") || "";
      // RSA-OAEP path (browser): decrypt with the one-time private key
      const keyId = params.get("keyId") || "";
      const encrypted = params.get("encrypted") || "";
      if (encrypted && keyId) {
        try {
          password = decryptPassword(keyId, encrypted);
        } catch {
          res.writeHead(401, { "Content-Type": "text/html" });
          res.end(html(next, "Session expired — please reload and try again.", undefined, undefined, req.headers.host || ""));
          return;
        }
      }
      const users = loadUsers();
      const rec = users[name];
      const expect = rec ? Buffer.from(rec.hash, "hex") : null;
      const got = expect ? scryptSync(password, rec.salt, expect.length) : null;
      const bad = !expect || expect.length !== got.length || !timingSafeEqual(expect, got);
      if (bad) {
        recordFailure(name, ip);
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(html(next, "Invalid username or password.", undefined, undefined, req.headers.host || ""));
        return;
      }
      clearFailures(name, ip);
      // TOTP second factor when the user has one enrolled
      if (rec.totpSecret) {
        const tmp = issueSession(name, COOKIE2, 5 * 60_000);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": COOKIE2 + "=" + tmp + "; Path=/; HttpOnly; SameSite=Strict",
        });
        res.end(totpPage(next, "", req.headers.host || ""));
        return;
      }
      setSession(res, name, next);
    });
    return;
  }

  // TOTP second-factor step
  if (url.pathname === BASE + "/login/2fa" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const next = params.get("next") || DEPLOY || "/";
      const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim())
        .find((c) => c.startsWith(COOKIE2 + "="));
      const name = cookie ? verifySession(cookie.slice(COOKIE2.length + 1), COOKIE2) : null;
      if (!name) {
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(totpPage(next, "Session expired — please sign in again.", req.headers.host || ""));
        return;
      }
      const users = loadUsers();
      const rec = users[name];
      if (!rec || !rec.totpSecret || !verifyTotp(rec.totpSecret, params.get("code") || "")) {
        recordFailure(name, ip);
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(totpPage(next, "Invalid code.", req.headers.host || ""));
        return;
      }
      clearFailures(name, ip);
      setSession(res, name, next);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}).listen(PORT, "127.0.0.1");
`;
  mkdirSync(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".", { recursive: true });
  writeFileSync(file, script, "utf8");
}
