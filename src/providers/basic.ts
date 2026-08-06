import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { createHash, timingSafeEqual } from "crypto";
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


/** md5-crypt (APR1) — 与 `openssl passwd -apr1` / Apache htpasswd 兼容。 */
export function md5Crypt(password: string, salt: string): string {
  const magic = "$apr1$";
  const md5 = (d: string | Buffer) => createHash("md5").update(d as Buffer).digest();
  let ctx = createHash("md5");
  ctx.update(password + magic + salt);
  let ctx1 = createHash("md5");
  ctx1.update(password + salt + password);
  const final = ctx1.digest();
  for (let i = password.length; i > 0; i -= 16) ctx.update(final.subarray(0, Math.max(0, Math.min(16, i))));
  for (let i = password.length; i > 0; i >>= 1) ctx.update(i & 1 ? "\x00" : String(password[0]));
  let digest = ctx.digest();
  for (let i = 0; i < 1000; i++) {
    const c = createHash("md5");
    c.update(i & 1 ? password : digest);
    if (i % 3) c.update(salt);
    if (i % 7) c.update(password);
    c.update(i & 1 ? digest : password);
    digest = c.digest();
  }
  const itoa64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const to64 = (v: number, n: number): string => {
    let s = "";
    while (n-- > 0) { s += itoa64[v & 0x3f]; v >>= 6; }
    return s;
  };
  let out = "";
  out += to64((digest[0]! << 16) | (digest[6]! << 8) | digest[12]!, 4);
  out += to64((digest[1]! << 16) | (digest[7]! << 8) | digest[13]!, 4);
  out += to64((digest[2]! << 16) | (digest[8]! << 8) | digest[14]!, 4);
  out += to64((digest[3]! << 16) | (digest[9]! << 8) | digest[15]!, 4);
  out += to64((digest[4]! << 16) | (digest[10]! << 8) | digest[5]!, 4);
  out += to64(digest[11]!, 2);
  return magic + salt + "$" + out;
}

/**
 * 校验 HTTP Basic 凭证是否命中 htpasswd 文件(APR1 hash;其他 hash 类型一律
 * 拒绝,防误放行)。用于决策 API 进程内校验 basic 认证——嵌入方(pi-web)的
 * Next middleware 无法在 rewrite 时保留 vhost Host,nginx gateway 的
 * server_name 匹配不到会落到默认 server,绕过 auth_basic;故 basic 改在
 * 决策层校验,通过后直接 pipe 到服务。
 */
export function verifyHtpasswd(authorization: string | undefined, htpasswdFile: string): boolean {
  if (!authorization || !authorization.startsWith("Basic ")) return false;
  let decoded: string;
  try { decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8"); } catch { return false; }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  if (!user || !existsSync(htpasswdFile)) return false;
  let line = "";
  for (const l of readFileSync(htpasswdFile, "utf8").split(/\r?\n/)) {
    if (l.startsWith(user + ":")) { line = l; break; }
  }
  if (!line) return false;
  const hash = line.slice(line.indexOf(":") + 1);
  if (!hash.startsWith("$apr1$")) return false; // 仅 APR1(nginx auth_basic 支持的) —— 其余 fail-closed
  const m = /^\$apr1\$([^$]{1,8})\$([^$]{1,64})$/.exec(hash);
  if (!m) return false;
  // md5Crypt 返回完整 $apr1$salt$hash,与 htpasswd 的 hash 段比较
  return timingSafeEqualStrings(md5Crypt(password, m[1]!).split("$").pop()!, m[2]!);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
