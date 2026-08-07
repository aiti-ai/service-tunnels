import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { execFileSync, spawn } from "child_process";
import { dirname, join } from "path";
import { connect } from "net";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus, AuthToken, TokenManager } from "../auth-provider.ts";

/**
 * token provider — Bearer-token auth for tunnel API 请求 (machine clients).
 *
 * The lightest option for programmatic access: no login page, no cookies, no
 * browser — a client just sends `Authorization: Bearer <token>` and the
 * request passes (or gets a plain 401). Tokens are generated through the
 * standard TokenManager interface (list/create/revoke), carry a description
 * and an optional expiry, and live in the site's storage dir — managed per
 * site exactly like users (`--site`), never shared across sites.
 *
 * Security model:
 *   - tokens are random (st_ + 192-bit base64url), shown ONCE at creation
 *   - the store keeps only a SHA-256 hash (db leak ≠ usable tokens)
 *   - verification is constant-time (timingSafeEqual) and fail-closed:
 *     unknown/expired/malformed token → 401 (never 200)
 *   - verification happens IN-PROCESS in the decision API (embedded hosts,
 *     same reason as basic: rewrite can't preserve vhost Host) AND at the
 *     nginx gateway via auth_request → a tiny local Node probe
 *
 * Tokens live in cacheDir/tmp/token/tokens.json (0600); the probe server is a
 * generated ESM script (like portal) reading that file per request — no
 * restart needed after create/revoke.
 */

export interface TokenAuthProviderOptions {
  port?: number;
  /** Per-site storage dir (P1); default = cacheDir/tmp/token. */
  storageDir?: string;
  /** Site (auth realm) this instance belongs to. */
  site?: string;
}

interface TokenRecord {
  id: string;
  description: string;
  createdAt: number;
  /** epoch ms; null = never expires. */
  expiresAt: number | null;
  /** sha256(token) — never the raw secret. */
  hash: string;
}

/** SHA-256 of a token (the only thing the store keeps). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 解析 token 有效期表达式 → epoch ms（null = 永不过期）。CLI（--expires）与
 * UI（创建表单）共用同一解析：
 *   - 缺省/"never" → null
 *   - ISO 8601（如 2026-01-01 或 2026-01-01T00:00:00Z）→ Date.parse
 *   - 相对时长（如 +2h、+30d、+7d12h、+90m、+1y）→ now + 时长
 *   - 纯数字 → 视为 epoch ms
 * 无效值抛错（fail-closed，不静默接受垃圾）。
 */
export function parseTokenExpiry(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (s === "never" || s === "0") return null;
  if (/^\d+$/.test(s)) return Number(s);
  const rel = /^\+?(\d+)([smhdwy])(\d+([smhdwy]))?$/.exec(s);
  if (rel) {
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
    const now = Date.now();
    let ms = Number(rel[1]!) * (unitMs[rel[2]!] ?? 0);
    if (rel[3]) {
      const sub = /^(\d+)([smhdwy])$/.exec(rel[3]!);
      if (sub) ms += Number(sub[1]!) * (unitMs[sub[2]!] ?? 0);
    }
    if (ms > 0) return now + ms;
  }
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return iso;
  throw new Error(`invalid token expiry ${JSON.stringify(s)} (ISO date, +2h/+30d relative, or epoch ms; "never" = no expiry)`);
}

/** 随机 token：`st_` 前缀 + 24 字节 base64url（≈192-bit 熵）。前缀便于识别
 *  （日志/配置里一眼认出是 service-tunnels 的 token）。 */
export function generateToken(): string {
  return `st_${randomBytes(24).toString("base64url")}`;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 校验 Bearer token 是否命中站点的 tokens.json（sha256 hash + 有效期）。
 * 用于决策 API 进程内校验 token 认证——嵌入方宿主应用的 middleware 无法在
 * rewrite 时保留 vhost Host，nginx gateway 的 server_name 匹配不到会落到默认
 * server，绕过 auth_request；故 token 改在决策层校验，通过后直接 pipe 到服务。
 * 严格只认 `Bearer <token>`（RFC 6750，scheme 大小写不敏感）。
 */
export function verifyBearerToken(authorization: string | undefined, tokensFile: string): boolean {
  if (!authorization) return false;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return false;
  const token = m[1]!;
  if (!existsSync(tokensFile)) return false;
  const want = hashToken(token);
  let rows: Record<string, TokenRecord>;
  try {
    rows = JSON.parse(readFileSync(tokensFile, "utf8")) as Record<string, TokenRecord>;
  } catch {
    return false;
  }
  const now = Date.now();
  for (const rec of Object.values(rows)) {
    if (!rec || typeof rec.hash !== "string") continue;
    if (rec.expiresAt !== null && rec.expiresAt !== undefined && now > rec.expiresAt) continue;
    if (timingSafeEqualStrings(rec.hash, want)) return true;
  }
  return false;
}

export class TokenAuthProvider implements AuthProvider, TokenManager {
  readonly type = "token";
  /** nginx auth_request 探针（无登录页、无 basePath）。 */
  readonly gatewayMode = "token" as const;
  /** 认证探针路径（固定——token 无 basePath，与 basic 不同 nginx 无法原生
   *  校验 Bearer，必须 auth_request 到探针服务）。 */
  readonly authzPath = "/token-authz/auth";
  /** 直达 provider 的路径前缀：无登录页/回调——不需要。 */
  readonly providerPaths: string[] = [];

  /** token 无 basePath（无登录页）。 */
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
  #opts: TokenAuthProviderOptions;
  #dir = "";
  #tokensFile = "";
  #serverFile = "";
  #port = 0;
  #proc: ReturnType<typeof spawn> | null = null;

  constructor(ctx: ProviderContext, opts: TokenAuthProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#dir = opts.storageDir ?? join(ctx.cacheDir, "tmp", "token");
    this.#tokensFile = join(this.#dir, "tokens.json");
    this.#serverFile = join(this.#dir, "server.mjs");
    this.#port = opts.port ?? 0;
    this.site = opts.site ?? "default";
  }

  get port(): number {
    return this.#port;
  }

  /** tokens 文件路径（决策 API 进程内校验用）。 */
  get tokensFile(): string {
    return this.#tokensFile;
  }

  status(): AuthProviderStatus {
    return { running: this.#proc !== null && this.#proc.exitCode === null, port: this.#port };
  }

  async validate(): Promise<string[]> {
    return [];
  }

  async prepare(): Promise<AuthProviderStatus> {
    mkdirSync(this.#dir, { recursive: true });
    writeServerScript(this.#serverFile);
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
          TOKENS_FILE: this.#tokensFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.#proc = p;
      this.#ctx.registerPid("token", p.pid ?? 0);
      p.stdout?.on("data", (d) => this.#ctx.log(`[token] ${String(d).trim()}`));
      p.stderr?.on("data", (d) => this.#ctx.log(`[token] ${String(d).trim()}`));
      try {
        await waitTcp(this.#port, 10_000);
        // confirm it is OUR probe (401 on the authz path) — a squatter on the
        // port (e.g. nginx that raced us) would answer differently
        await probeToken(this.#port);
        this.#ctx.log(`token: listening on 127.0.0.1:${this.#port}`);
        return this.status();
      } catch (err) {
        await killQuiet(p);
        this.#proc = null;
        this.#port = 0;
        if (attempt >= 4) throw err;
        this.#ctx.log(`token: port ${this.#port} raced — retrying`);
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

  renderNginxAuth(): string {
    return ""; // gateway wires auth_request → /token-authz/auth
  }

  async registerHost(_host: string, _policy?: AuthPolicy): Promise<void> {
    // token auth applies to every host — nothing per-host to register
  }

  async unregisterHost(_host: string): Promise<void> {
    // nothing to unregister
  }

  async listHosts(): Promise<string[]> {
    return [];
  }

  // —— TokenManager (tokens.json, sha256 hashes) ——

  async #readDb(): Promise<Map<string, TokenRecord>> {
    const out = new Map<string, TokenRecord>();
    try {
      const data = JSON.parse(readFileSync(this.#tokensFile, "utf8")) as Record<string, TokenRecord>;
      for (const [id, rec] of Object.entries(data)) {
        if (rec && typeof rec === "object") out.set(id, rec);
      }
    } catch {
      // missing/corrupt → empty db
    }
    return out;
  }

  async #writeDb(rows: Map<string, TokenRecord>): Promise<void> {
    mkdirSync(this.#dir, { recursive: true });
    const file = `${this.#tokensFile}.${process.pid}.tmp`;
    writeFileSync(file, JSON.stringify(Object.fromEntries(rows), null, 2), "utf8");
    try {
      execFileSync("chmod", ["600", file], { stdio: "ignore" });
    } catch {
      // best-effort
    }
    execFileSync("mv", [file, this.#tokensFile], { stdio: "ignore" });
  }

  /** 已过期 token 从 db 惰性清除（读取即过滤 + 移除）。 */
  async #sweepExpired(rows: Map<string, TokenRecord>): Promise<boolean> {
    const now = Date.now();
    let changed = false;
    for (const [id, rec] of rows) {
      if (rec.expiresAt !== null && rec.expiresAt !== undefined && now > rec.expiresAt) {
        rows.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  async listTokens(): Promise<AuthToken[]> {
    const rows = await this.#readDb();
    if (await this.#sweepExpired(rows)) await this.#writeDb(rows);
    return [...rows.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((rec) => ({ id: rec.id, description: rec.description, createdAt: rec.createdAt, expiresAt: rec.expiresAt }));
  }

  async createToken(opts?: { description?: string; expiresAt?: number | null }): Promise<AuthToken> {
    const rows = await this.#readDb();
    await this.#sweepExpired(rows);
    const token = generateToken();
    const id = randomBytes(8).toString("hex");
    const expiresAt = opts?.expiresAt === undefined || opts.expiresAt === null ? null : opts.expiresAt;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      throw new Error("token expiresAt must be a future epoch-ms timestamp (or null for never)");
    }
    rows.set(id, {
      id,
      description: (opts?.description ?? "").trim().slice(0, 256),
      createdAt: Date.now(),
      expiresAt,
      hash: hashToken(token),
    });
    await this.#writeDb(rows);
    this.#ctx.log(`token: created ${id}${expiresAt ? ` (expires ${new Date(expiresAt).toISOString()})` : " (never expires)"}`);
    return {
      id,
      description: rows.get(id)!.description,
      createdAt: rows.get(id)!.createdAt,
      expiresAt,
      token, // 只此一次返回原始 token
    };
  }

  async revokeToken(id: string): Promise<void> {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error(`invalid token id ${JSON.stringify(id)}`);
    const rows = await this.#readDb();
    if (!rows.delete(id)) throw new Error(`token ${id} not registered`);
    await this.#writeDb(rows);
    this.#ctx.log(`token: revoked ${id}`);
  }
}

// —— helpers shared with the generated probe server ——

async function probeToken(port: number): Promise<void> {
  const { request } = await import("http");
  await new Promise<void>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/token-authz/auth", method: "GET" },
      (res) => {
        res.resume();
        if (res.statusCode === 401) resolve();
        else reject(new Error(`token probe returned ${res.statusCode} (not our probe)`));
      },
    );
    req.on("error", reject);
    req.setTimeout(3_000, () => req.destroy(new Error("token probe timeout")));
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
        if (Date.now() - start > timeoutMs) reject(new Error(`token: port ${port} did not open`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** The generated token probe server (ESM, written to cacheDir/tmp/token/server.mjs).
 *  只回答 nginx auth_request 探针：校验 `Authorization: Bearer` 命中 tokens.json
 *  且未过期 → 200；否则 401（nginx 直接把 401 回给客户端，带 WWW-Authenticate）。
 *  每请求读文件——创建/撤销 token 无需重启。 */
function writeServerScript(file: string): void {
  const script = `import { createServer } from "http";
import { readFileSync } from "fs";
import { createHash, timingSafeEqual } from "crypto";

const PORT = Number(process.env.PORT);
const TOKENS_FILE = process.env.TOKENS_FILE;

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function loadTokens() {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function verify(authorization) {
  if (!authorization) return false;
  const m = /^Bearer\\s+(\\S+)$/i.exec(authorization.trim());
  if (!m) return false;
  const want = hashToken(m[1]);
  const now = Date.now();
  for (const rec of Object.values(loadTokens())) {
    if (!rec || typeof rec.hash !== "string") continue;
    if (rec.expiresAt != null && now > rec.expiresAt) continue;
    const a = Buffer.from(rec.hash);
    const b = Buffer.from(want);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/token-authz/auth" && req.method === "GET") {
    if (verify(req.headers.authorization)) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(401, {
      "Content-Type": "text/plain",
      "WWW-Authenticate": 'Bearer realm="service-tunnels"',
    });
    res.end("unauthorized");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}).listen(PORT, "127.0.0.1");
`;
  mkdirSync(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".", { recursive: true });
  writeFileSync(file, script, "utf8");
}
