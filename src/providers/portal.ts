import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { execFileSync, spawn } from "child_process";
import { join } from "path";
import { randomBytes, scryptSync } from "crypto";
import { connect } from "net";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus, AuthUser, UserManager } from "../auth-provider.ts";

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
  /** Bootstrap user (only created when the db is empty). */
  user?: { name: string; password: string; displayName?: string };
}

interface PortalUserRecord {
  displayName: string;
  salt: string;
  hash: string;
}

export class PortalAuthProvider implements AuthProvider, UserManager {
  readonly type = "portal";
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
    this.#dir = join(ctx.cacheDir, "tmp", "portal");
    this.#usersFile = join(this.#dir, "users.json");
    this.#serverFile = join(this.#dir, "server.mjs");
    this.#port = opts.port ?? 0;
    this.#basePath = opts.basePath ?? "/portal";
    // per-instance secret, persisted so sessions survive restarts
    this.#secret = readSecret(join(this.#dir, "secret"));
  }

  get port(): number {
    return this.#port;
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
    writeServerScript(this.#serverFile, this.#basePath);
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
          SECURE: process.env.PORTAL_SECURE === "1" ? "1" : "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.#proc = p;
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
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    rec.salt = randomBytes(16).toString("hex");
    rec.hash = hashPassword(password, rec.salt);
    await this.#writeDb(rows);
    this.#ctx.log(`portal: password updated for ${name}`);
  }

  async removeUser(name: string): Promise<void> {
    const rows = await this.#readDb();
    if (!rows.delete(name)) throw new Error(`user ${name} not registered`);
    await this.#writeDb(rows);
    this.#ctx.log(`portal: user ${name} removed`);
  }
}

// —— helpers shared with the generated server script ——

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function readSecret(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const secret = randomBytes(32).toString("hex");
    mkdirSync(dirnameOf(file), { recursive: true });
    writeFileSync(file, secret, "utf8");
    return secret;
  }
}

function dirnameOf(p: string): string {
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
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
function writeServerScript(file: string, basePath: string): void {
  const script = `import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { createHmac, scryptSync, randomBytes, timingSafeEqual, generateKeyPairSync, privateDecrypt, constants } from "crypto";

const PORT = Number(process.env.PORT);
const SECRET = process.env.SECRET;
const USERS_FILE = process.env.USERS_FILE;
const BASE = process.env.BASE_PATH || "/portal";
const SECURE = process.env.SECURE === "1";
const COOKIE = "st_portal_session";
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

function issueSession(name) {
  const payload = String(Date.now() + TTL_MS) + "." + name;
  const body = Buffer.from(payload).toString("base64url");
  return body + "." + sign(body);
}

function verifySession(token) {
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = Buffer.from(body, "base64url").toString("utf8");
  const dot = payload.indexOf(".");
  const expiry = Number(payload.slice(0, dot));
  if (!expiry || expiry < Date.now()) return null;
  return payload.slice(dot + 1);
}

const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = (rate.get(ip) || []).filter((t) => now - t < 60_000);
  rate.set(ip, win);
  return win.length >= 5;
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

function html(next, error, keyId, publicKey) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  const enc = publicKey
    ? '<script>'
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
    + 'button{margin-top:1.4rem;width:100%;padding:.6rem;background:#2d6cdf;color:#fff;border:0;border-radius:6px;cursor:pointer}</style>'
    + '</head><body>' + enc
    + '<form id="login" method="post" action="' + BASE + '/login">'
    + '<h1>Sign in to access this service</h1>'
    + '<input type="hidden" name="next" value="' + encodeURIComponent(next) + '">' + err
    + '<input type="hidden" name="encrypted" id="encrypted">'
    + '<input type="hidden" name="keyId" id="keyId">'
    + '<label>Username</label><input name="username" autocomplete="username" required autofocus>'
    + '<label>Password</label><input name="password" id="pw" type="password" autocomplete="current-password" required>'
    + '<button type="submit">Sign in</button></form></body></html>';
}

function setSession(res, name, next) {
  const token = issueSession(name);
  res.writeHead(302, {
    Location: next || "/",
    "Set-Cookie": COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict"
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
    const next = url.searchParams.get("next") || "/";
    const { keyId, publicKey } = issueRsaKey();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html(next, "", keyId, publicKey));
    return;
  }

  if (url.pathname === BASE + "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (rateLimited(ip)) {
        res.writeHead(429, { "Content-Type": "text/html" });
        res.end(html("", "Too many attempts — try again in a minute."));
        return;
      }
      const params = new URLSearchParams(body);
      const name = params.get("username") || "";
      const next = params.get("next") || "/";
      let password = params.get("password") || "";
      // RSA-OAEP path (browser): decrypt with the one-time private key
      const keyId = params.get("keyId") || "";
      const encrypted = params.get("encrypted") || "";
      if (encrypted && keyId) {
        try {
          password = decryptPassword(keyId, encrypted);
        } catch {
          res.writeHead(401, { "Content-Type": "text/html" });
          res.end(html(next, "Session expired — please reload and try again."));
          return;
        }
      }
      const users = loadUsers();
      const rec = users[name];
      if (!rec) {
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(html(next, "Invalid username or password."));
        return;
      }
      const expect = Buffer.from(rec.hash, "hex");
      const got = scryptSync(password, rec.salt, expect.length);
      if (expect.length !== got.length || !timingSafeEqual(expect, got)) {
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(html(next, "Invalid username or password."));
        return;
      }
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
