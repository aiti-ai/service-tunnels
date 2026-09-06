import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, copyFileSync } from "fs";
import { execFileSync, spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomBytes, scryptSync, createHmac, timingSafeEqual, createHash } from "crypto";
import { connect } from "net";
import { validateUserName } from "../validation.ts";
import { spawnNode } from "../spawn-node.ts";
import { download as justgetDownload } from "../vendor/justget/justget.mjs";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus, AuthUser, UserManager, BiometricManager } from "../auth-provider.ts";
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
 * Successful login keeps the classic 302 to `next`; the loading transition is
 * handled client-side: submitting the form instantly pops a full-screen
 * transition page (spinner), which stays up until the 302 lands — a failed
 * login returns the login page and the overlay simply disappears.
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
  /** @deprecated `user` 不再被 `prepare()` 用于自动创建 admin 用户；
   *  安装者需要显式创建真实用户时请调用 `addUser()`；全新安装的初始访问途径为
   *  break-glass（env `SERVICE_TUNNELS_PORTAL_INITIAL_USER/PASSWORD` / CLI
   *  `--provider-set initialUser.name=…` / `opts.initialUser`，缺省自动生成
   *  随机凭据写入配置目录 `initial-user.txt`）。*/
  user?: { name: string; password: string; displayName?: string };
  /** 初始（break-glass）用户——仅在当前 site 用户库为 **0 个真实用户** 时可登录：
   *  不写入 users.json（不占真实用户名额，否则一创建即自失效）；登录不验证
   *  2FA；站点一旦出现任意真实用户即失效（登录拒绝，已签发初始会话一并作废）。
   *  name/password 任一缺省 → 自动生成随机，并写入配置目录「initial-user.txt」
   *  （0600）+ 打印 stdout。也可经 env SERVICE_TUNNELS_PORTAL_INITIAL_USER /
   *  SERVICE_TUNNELS_PORTAL_INITIAL_PASSWORD，或 CLI --provider-set
   *  initialUser.name=… initialUser.password=… 指定。 */
  initialUser?: { name?: string; password?: string };
  /** Per-site storage dir (P1); default = cacheDir/tmp/portal. */
  storageDir?: string;
  /** Site (auth realm) this instance belongs to. */
  site?: string;
  /** 缺省策略(registerHost 未指定时生效):one_factor | two_factor | deny。 */
  policy?: AuthPolicy["policy"];
  /** 会话 TTL（天，缺省 7）。 */
  sessionTtlDays?: number;
  /** 会话 HMAC 密钥持久化文件（可选，仅认证模式用）：加载或生成写入该文件，
   *  systemd 重启后会话不失效（默认 per-instance 随机——restart 全体登出）。
   *  0600。 */
  secretFile?: string;
  /** 监听地址（缺省 127.0.0.1）。仅认证模式跨机接入时显式传。 */
  host?: string;
  /** 信任回环代理的 X-Forwarded-For（缺省 false）。仅认证模式经外部 nginx
   *  转发时开——per-IP 封禁取 nginx 追加的真实客户端 IP（只信回环连接，
   *  防止伪造）。 */
  trustProxy?: boolean;
  /** 勾选“记住我”后的会话 TTL（天，缺省 365）——仅延长完整认证
   *  （twoFactor 完成）后的会话；1FA 会话不延长。 */
  rememberMeTtlDays?: number;
  /** 2FA 复验周期（天，缺省 rememberMeTtlDays/7，最小 1）：周期内探针
   *  直接放行；过期则免密码直跳 2FA 步骤页（会话仍有效时）。
   *  biometric-2fa-design.md §5。 */
  twoFactorGraceDays?: number;
  /** 启用生物识别 2FA（P1: face；voice P2）。true = 全部；或数组枚举。
   *  缺省关。启用 face 时首次 prepare 下载 ~8.4MB 浏览器资产到
   *  cacheDir/bin/face-models/<ver>/（SHA-256 校验，镜像优先，
   *  biometric-2fa-design.md §7.5）。 */
  biometrics?: boolean | Array<"face" | "voice">;
  /** 匹配阈值：face = 128-d 向量欧氏距离上限（缺省 0.6，越小越严）；
   *  voice = 78-d MFCC 向量余弦相似度下限（缺省 0.90，越大越严）。 */
  biometricThresholds?: { face?: number; voice?: number };
}

/** 人脸模板记录（templates.json，biometric-2fa-design.md §9.2）。 */
export interface FaceTemplate {
  status: "pending" | "active";
  vectors: number[][];
  threshold: number;
  enrolledAt: number;
}
/** 语音模板（P2，biometric-2fa-design.md §8）：78-d MFCC(mean+std) 向量。 */
export interface VoiceTemplate {
  status: "pending" | "active";
  vectors: number[][];
  threshold: number;
  enrolledAt: number;
}
export interface BiometricTemplates {
  face?: FaceTemplate;
  voice?: VoiceTemplate;
}

// —— face 浏览器资产（@vladmandic/face-api 1.7.15，biometric-2fa-design.md §7.5）——
// 下载源：自有 Gitee 镜像（国内主力）→ jsdelivr → unpkg；SHA-256 固定清单。
// 注：registry.npmmirror.com 的 unpkg 文件 CDN 对本包 403（白名单），不可用。
export const FACE_ASSETS_VERSION = "1.7.15";
/** vendored justget/browser 版本（scripts/build-justget-browser.mjs 产物，
 *  页面用它拼 immutable 缓存参数；升级换此值即换缓存键）。 */
export const JUSTGET_BROWSER_VERSION = "0.2.2";
interface FaceAsset {
  file: string;
  sha256: string;
  size: number;
  /** npm 包内路径（jsdelivr/unpkg 用；Gitee 镜像是平铺文件名）。 */
  npmPath: string;
}
export const FACE_ASSETS: FaceAsset[] = [
  { file: "face-api.js", sha256: "0160f7af3a8c78cece45c7ecc765383bad74becfd438bb787cdd627b2d6f2cf6", size: 1_333_943, npmPath: "dist/face-api.js" },
  { file: "tiny_face_detector_model-weights_manifest.json", sha256: "5d1af4849ac48d5b985f4a9b16010c512353ddd6fcc63d50fd0bc9e9e64296e5", size: 3_219, npmPath: "model/tiny_face_detector_model-weights_manifest.json" },
  { file: "tiny_face_detector_model.bin", sha256: "b7503ce7df31039b1c43316a9b865cab6a70dd748cc602d3fa28b551503c3871", size: 193_321, npmPath: "model/tiny_face_detector_model.bin" },
  { file: "face_landmark_68_model-weights_manifest.json", sha256: "ca4886639f86e99b39fed0c155f81b63317225773bd9616716e887b0153389c9", size: 8_485, npmPath: "model/face_landmark_68_model-weights_manifest.json" },
  { file: "face_landmark_68_model.bin", sha256: "4611ef65c87d836d03d684b30eec4d195d8b219fa1dd58fc58945831c6b9299b", size: 356_840, npmPath: "model/face_landmark_68_model.bin" },
  { file: "face_recognition_model-weights_manifest.json", sha256: "cbaffa501b0b9275a12b63357a6843e7e30c054e1c9151e1a5f879b26e32986b", size: 19_615, npmPath: "model/face_recognition_model-weights_manifest.json" },
  { file: "face_recognition_model.bin", sha256: "b413e420d6840b2775fba32008db6f3cddb07d485967fb42cfcf379c16a8c589", size: 6_444_032, npmPath: "model/face_recognition_model.bin" },
];
export function faceAssetsDir(cacheDir: string): string {
  return join(cacheDir, "bin", "face-models", FACE_ASSETS_VERSION);
}
function faceAssetUrls(a: FaceAsset): string[] {
  const tag = `face-api-${FACE_ASSETS_VERSION}`;
  const urls = [
    `https://gitee.com/justdb-mirrors/face-models/releases/download/${tag}/${a.file}`,
    `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACE_ASSETS_VERSION}/${a.npmPath}`,
    `https://unpkg.com/@vladmandic/face-api@${FACE_ASSETS_VERSION}/${a.npmPath}`,
  ];
  const mirror = process.env.SERVICE_TUNNELS_FACE_MIRROR; // {file} 占位镜像前缀，最高优先
  return mirror ? [mirror.replace("{file}", a.file), ...urls] : urls;
}
/** 128-d 描述子样本校验：1..5 组，每组恰 128 个有限数，幅值 ≤1（L2 归一化）。 */
export function validateFaceSamples(samples: unknown, what = "samples"): number[][] {
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 5) {
    throw new Error(`${what}: expected 1-5 vectors`);
  }
  return samples.map((v) => {
    if (
      !Array.isArray(v) ||
      v.length !== 128 ||
      !v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1.0001)
    ) {
      throw new Error(`${what}: each vector must be 128 finite numbers in [-1,1]`);
    }
    return v as number[];
  });
}
/** 匹配距离：注册向量 × 提交向量两两欧氏距离取最小（face-api 惯例）。 */
export function faceDistance(enroll: number[][], submit: number[][]): number {
  let best = Infinity;
  for (const e of enroll) {
    for (const v of submit) {
      let s = 0;
      for (let k = 0; k < 128; k++) {
        const t = e[k]! - v[k]!;
        s += t * t;
      }
      const d = Math.sqrt(s);
      if (d < best) best = d;
    }
  }
  return best;
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
/** RFC 6238 TOTP 码生成(SHA-1 / 6 位 / 30s 步长,与 portal 校验同一实现)。
 *  offset:0=当前窗口,1=下一窗口(倒计时余量)。无需手机 app——CLI/脚本直接算。 */
export function generateTotpCode(secretB32: string, offset = 0): string | null {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secretB32).toUpperCase().replace(/=+$/, "");
  if (!clean) return null;
  const key = Buffer.alloc((clean.length * 5) >> 3);
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      key[idx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (idx === 0) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const o = hmac[hmac.length - 1]! & 0x0f;
  const num = ((hmac[o]! & 0x7f) << 24) | (hmac[o + 1]! << 16) | (hmac[o + 2]! << 8) | hmac[o + 3]!;
  return String(num % 1_000_000).padStart(6, "0");
}

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

export class PortalAuthProvider implements AuthProvider, UserManager, BiometricManager {
  readonly type = "portal";
  /** Site (auth realm) this instance belongs to ("default" when absent). */
  readonly site: string;
  readonly capabilities = {
    localGateway: true,
    edgeAuth: false,
    randomDomain: true,
    multiHost: true,
    needsSessionStore: false,
    nestedBasePath: true, // Node 服务支持任意嵌套路径
  };

  #ctx: ProviderContext;
  #opts: PortalAuthProviderOptions;
  #hosts = new Map<string, AuthPolicy["policy"]>();
  #dir = "";
  #usersFile = "";
  #serverFile = "";
  #port = 0;
  #policyFile = "";
  #basePath = ""; // 内置默认交给 defaultBasePath();非空会让 expose.ts hasPath 恒真,deployBasePath 合并失效
  #deployBasePath = "";
  #host = "127.0.0.1";
  #secret = "";
  #proc: ReturnType<typeof spawn> | null = null;
  /** 初始（break-glass）用户凭据（仅站点 0 真实用户时有效，不入库）。 */
  #initialUser: { name: string; password: string } | null = null;
  /** 初始凭据已武装标记——防 prepare→start 双重 prepare 时重复输出。 */
  #armed = false;
  // 记住我（可信设备）三参数（biometric-2fa-design.md §5）：会话 TTL 7d /
  // remember 365d / 2FA 复验周期 = remember/7（最小 1 天）。子进程经 env 注入。
  #ttlMs = 7 * 24 * 3600 * 1000;
  #rememberTtlMs = 365 * 24 * 3600 * 1000;
  #graceMs = 52 * 24 * 3600 * 1000;
  // 生物识别（P1: face）——biometric-2fa-design.md §7/§9
  #bioFace = false;
  #faceThreshold = 0.6;
  #bioVoice = false;
  #voiceThreshold = 0.9;
  #templatesFile = "";

  constructor(ctx: ProviderContext, opts: PortalAuthProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    // bootstrap admin 自动创建已移除：全新安装唯一初始访问途径为 break-glass
    // 初始用户（见 #armInitialUser）。调用方可经 addUser() 显式创建真实用户。
    // 初始（break-glass）用户：env / CLI(--provider-set) / opts.initialUser 任一
    // 来源；未指定 name/password → 自动生成随机（每次进程启动轮换）。仅在站点
    // 用户库为空时武装并输出（prepare 里落盘 + stdout）。
    const iuName = (opts.initialUser?.name ?? process.env.SERVICE_TUNNELS_PORTAL_INITIAL_USER ?? "").trim();
    const iuPass = opts.initialUser?.password ?? process.env.SERVICE_TUNNELS_PORTAL_INITIAL_PASSWORD ?? "";
    this.#initialUser = {
      name: iuName || `bootstrap-${randomName()}`,
      password: iuPass || randomBytes(12).toString("base64url"),
    };
    this.#dir = opts.storageDir ?? join(ctx.cacheDir, "tmp", "portal");
    this.#usersFile = join(this.#dir, "users.json");
    this.#serverFile = join(this.#dir, "server.mjs");
    this.#port = opts.port ?? 0;
    this.#basePath = opts.basePath ?? "";
    this.#deployBasePath = (opts.deployBasePath ?? "").replace(/\/+$/, "");
    this.site = opts.site ?? "default";
    const days = (v: unknown, dflt: number): number =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
    this.#ttlMs = days(opts.sessionTtlDays, 7) * 24 * 3600 * 1000;
    this.#rememberTtlMs = days(opts.rememberMeTtlDays, 365) * 24 * 3600 * 1000;
    this.#graceMs =
      Math.max(
        days(opts.twoFactorGraceDays, Math.round(this.#rememberTtlMs / (7 * 24 * 3600 * 1000))),
        1,
      ) * 24 * 3600 * 1000;
    this.#bioFace = opts.biometrics === true || (Array.isArray(opts.biometrics) && opts.biometrics.includes("face"));
    const th = opts.biometricThresholds?.face;
    this.#faceThreshold = typeof th === "number" && Number.isFinite(th) && th > 0 && th <= 2 ? th : 0.6;
    this.#bioVoice = opts.biometrics === true || (Array.isArray(opts.biometrics) && opts.biometrics.includes("voice"));
    const tv = opts.biometricThresholds?.voice;
    this.#voiceThreshold = typeof tv === "number" && Number.isFinite(tv) && tv > 0 && tv <= 1 ? tv : 0.9;
    this.#templatesFile = join(this.#dir, "templates.json");
    // 默认 per-instance random secret — NOT persisted: exposes are
    // lifecycle-only, so a restart kills the tunnels and the public hosts
    // change. A persisted cookie secret would keep sessions valid only for
    // the OLD (dead) hosts.仅认证模式传 secretFile → 密钥落盘（0600），
    // systemd 重启会话保持。
    if (opts.secretFile) {
      let s = "";
      try {
        s = readFileSync(opts.secretFile, "utf8").trim();
      } catch {
        s = "";
      }
      if (!s) {
        s = randomBytes(32).toString("hex");
        try {
          mkdirSync(dirname(opts.secretFile), { recursive: true });
          writeFileSync(opts.secretFile, s + "\n", "utf8");
          try { execFileSync("chmod", ["600", opts.secretFile], { stdio: "ignore" }); } catch { /* best-effort */ }
        } catch { /* best-effort */ }
      }
      this.#secret = s;
    } else {
      this.#secret = randomBytes(32).toString("hex");
    }
    this.#host = opts.host ?? "127.0.0.1";
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
    const dayOpts: Array<[string, unknown]> = [
      ["sessionTtlDays", this.#opts.sessionTtlDays],
      ["rememberMeTtlDays", this.#opts.rememberMeTtlDays],
      ["twoFactorGraceDays", this.#opts.twoFactorGraceDays],
    ];
    for (const [k, v] of dayOpts) {
      if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
        problems.push(`portal ${k} must be a positive number of days`);
      }
    }
    const bio = this.#opts.biometrics;
    if (bio !== undefined && bio !== true && !(Array.isArray(bio) && bio.every((m) => m === "face" || m === "voice"))) {
      problems.push('portal biometrics must be true or an array of "face"/"voice"');
    }
    const bth = this.#opts.biometricThresholds;
    if (bth?.face != null && (typeof bth.face !== "number" || !Number.isFinite(bth.face) || bth.face <= 0 || bth.face > 2)) {
      problems.push("portal biometricThresholds.face must be in (0, 2]");
    }
    if (bth?.voice != null && (typeof bth.voice !== "number" || !Number.isFinite(bth.voice) || bth.voice <= 0 || bth.voice > 1)) {
      problems.push("portal biometricThresholds.voice must be in (0, 1]");
    }
    return problems;
  }

  async prepare(): Promise<AuthProviderStatus> {
    mkdirSync(this.#dir, { recursive: true });
    this.#policyFile = join(this.#dir, "hosts-policy.json");
    writeServerScript(
      this.#serverFile,
      this.#basePath,
      this.#deployBasePath,
      this.site,
      JUSTGET_BROWSER_VERSION,
      JSON.stringify({
        ver: FACE_ASSETS_VERSION,
        assets: FACE_ASSETS.map((a) => ({ file: a.file, npmPath: a.npmPath, sha256: a.sha256 })),
      }),
    );
    // justget-browser 单文件 IIFE（构建期 esbuild 产物，随包分发）→ 随 server
    // 一起写盘，/assets/justget-browser.js 同源提供（不依赖公网 CDN）。路径以
    // import.meta 为锚计算绝对值，避免 .ts 模块下 CJS require.resolve 相对解析
    // 的不可靠（vendor 在 src/vendor/，在 providers/ 之上）。
    const providerDir = dirname(fileURLToPath(import.meta.url));
    const vendorDir = dirname(providerDir); // src/
    const jgSrc = join(vendorDir, "vendor", "justget", "justget-browser.js");
    copyFileSync(jgSrc, join(this.#dir, "justget-browser.js"));
    // 注：真实用户不再由 `prepare()` 自动创建——调用方需要显式调用 `addUser()`。
    // 全新安装唯一初始访问途径为 break-glass（见 `#armInitialUser`）。
    if (!this.#armed) {
      await this.#armInitialUser();
      this.#armed = true;
    }
    return this.status();
  }

  /** 站点用户库为空时武装 break-glass 初始用户：凭据写配置目录
   *  「initial-user.txt」（0600）+ 打印 stdout，供运维登录后立即建号。 */
  async #armInitialUser(): Promise<void> {
    if (!this.#initialUser) return;
    const users = await this.#readDb();
    if (users.size > 0) return; // 站点已有任意真实用户 → 初始用户无效（不输出）
    mkdirSync(this.#ctx.configDir, { recursive: true });
    const file = join(this.#ctx.configDir, "initial-user.txt");
    const lines = [
      "service-tunnels portal 初始（break-glass）用户凭据",
      "──────────────────────────────────────────────",
      `site       : ${this.site}`,
      `username   : ${this.#initialUser.name}`,
      `password   : ${this.#initialUser.password}`,
      "",
      "· 仅在当前 site 没有任何真实用户时可登录（登录不验证 2FA）。",
      "· 登录后请立即创建真实用户（管理界面 / auth user add）。",
      "· 站点一旦出现任意真实用户，本凭据立即失效（含已登录会话）。",
      `· 生成时间：${new Date().toISOString()}`,
    ];
    try {
      writeFileSync(file, lines.join("\n") + "\n", "utf8");
      try {
        execFileSync("chmod", ["600", file], { stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    } catch (err) {
      this.#ctx.log(`portal: 初始用户凭据写文件失败 ${file}: ${(err as Error | undefined)?.message ?? err}`);
    }
    console.log(`[service-tunnels] portal 初始用户（break-glass）已武装（site=${this.site}）：username=${this.#initialUser.name} password=${this.#initialUser.password}（仅站点无用户时有效，已存 ${file}）`);
    this.#ctx.log(`portal: break-glass initial user armed (site ${this.site}, user ${this.#initialUser.name}) → ${file}`);
  }

  /** 下载/修复 face 浏览器资产（biometric-2fa-design.md §7.5）：存在且 SHA-256
   *  匹配则跳过；否则按镜像 → jsdelivr → unpkg 顺序下载，逐文件校验。 */
  async ensureFaceAssets(): Promise<void> {
    const dir = faceAssetsDir(this.#ctx.cacheDir);
    mkdirSync(dir, { recursive: true });
    for (const a of FACE_ASSETS) {
      const dest = join(dir, a.file);
      let ok = false;
      try {
        const buf = readFileSync(dest);
        ok = buf.length === a.size && createHash("sha256").update(buf).digest("hex") === a.sha256;
      } catch {
        ok = false;
      }
      if (ok) continue;
      let done = false;
      let lastErr: unknown;
      for (const url of faceAssetUrls(a)) {
        try {
          await justgetDownload({
            url,
            output: dest,
            options: { timeout: 120_000, connectTimeout: 10_000, retries: 1, retryDelay: 500 },
          });
          const buf = readFileSync(dest);
          if (buf.length !== a.size || createHash("sha256").update(buf).digest("hex") !== a.sha256) {
            throw new Error(`sha256 mismatch for ${a.file}`);
          }
          done = true;
          break;
        } catch (err) {
          lastErr = err;
          try {
            rmSync(dest);
          } catch {
            /* best-effort */
          }
        }
      }
      if (!done) {
        throw new Error(
          `portal face assets: failed to download ${a.file}: ${(lastErr as Error | undefined)?.message ?? lastErr} ` +
            `(set SERVICE_TUNNELS_FACE_MIRROR="https://…/{file}" to override the mirror)`,
        );
      }
      this.#ctx.log(`portal: face asset ${a.file} downloaded`);
    }
  }

  async start(): Promise<AuthProviderStatus> {
    if (this.status().running) return this.status();
    await this.prepare();
    // face 资产在真正开始服务前就绪（prepare 保持离线——库调用方可先准备
    // 配置/脚本，不触发网络；下载只发生在 start）
    if (this.#bioFace) await this.ensureFaceAssets();
    for (let attempt = 0; ; attempt++) {
      if (!this.#port) this.#port = await this.#ctx.pickPort();
      const p = spawnNode(this.#ctx.nodePath, [this.#serverFile], {
        env: {
          ...process.env,
          PORT: String(this.#port),
          HOST: this.#host,
          SECRET: this.#secret,
          USERS_FILE: this.#usersFile,
          BASE_PATH: this.#basePath,
          DEPLOY_BASE_PATH: this.#deployBasePath,
          POLICY_FILE: this.#policyFile,
          POLICY_DEFAULT: this.#opts.policy ?? "one_factor",
          TTL_MS: String(this.#ttlMs),
          REMEMBER_TTL_MS: String(this.#rememberTtlMs),
          GRACE_MS: String(this.#graceMs),
          TEMPLATES_FILE: this.#templatesFile,
          FACE_ENABLED: this.#bioFace ? "1" : "",
          FACE_THRESHOLD: String(this.#faceThreshold),
          VOICE_ENABLED: this.#bioVoice ? "1" : "",
          VOICE_THRESHOLD: String(this.#voiceThreshold),
          ASSETS_DIR: faceAssetsDir(this.#ctx.cacheDir),
          STATIC_DIR: this.#dir,
          SECURE: process.env.PORTAL_SECURE === "1" ? "1" : "",
          TRUST_PROXY: this.#opts.trustProxy ? "1" : "",
          INITIAL_USER: this.#initialUser?.name ?? "",
          INITIAL_PASSWORD: this.#initialUser?.password ?? "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.#proc = p;
      this.#ctx.registerPid("portal", p.pid ?? 0);
      p.stdout?.on("data", (d) => this.#ctx.log(`[portal] ${String(d).trim()}`));
      p.stderr?.on("data", (d) => this.#ctx.log(`[portal] ${String(d).trim()}`));
      // 进程退出（含被 kill）→ 清实例引用，避免僵尸状态（#proc.exitCode 对
      // SIGKILL 保持 null → status().running 误判 true → start() 永不重建）。
      p.once("exit", (code, signal) => {
        if (this.#proc === p) {
          this.#proc = null;
          this.#port = 0;
        }
        this.#ctx.log(`portal: exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      });
      try {
        await waitTcp(this.#port, 10_000, this.#host);
        // confirm it is OUR portal (401 on the auth probe) — a squatter on
        // the port (e.g. nginx that raced us) would answer differently
        await probePortal(this.#port, this.#basePath, this.#host);
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
    return `${scheme}://$http_host${basePath}/login?next=$request_uri`;
  }

  async registerHost(host: string, policy?: AuthPolicy): Promise<void> {
    // per-host 策略:deny → 403;two_factor → 需完成 2FA 的会话;缺省 one_factor
    this.#hosts.set(host, policy?.policy ?? this.#opts.policy ?? "one_factor");
    // 服务端脚本按请求读 POLICY_FILE(JSON),无需重启
    try {
      mkdirSync(this.#dir, { recursive: true });
      writeFileSync(this.#policyFile, JSON.stringify(Object.fromEntries(this.#hosts)));
    } catch { /* best-effort */ }
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
    const tpl = await this.#readTemplates();
    return [...rows.entries()].map(([name, rec]) => {
      const u: AuthUser = { name, displayName: rec.displayName };
      if (tpl[name]) u.biometrics = { face: tpl[name]?.face?.status === "active", voice: tpl[name]?.voice?.status === "active" };
      return u;
    });
  }

  async addUser(name: string, password: string, displayName?: string): Promise<void> {
    // users.json is JSON (escaping-safe), but the name is also used as a
    // cookie subject + otpauth label — keep the same charset gate everywhere.
    validateUserName(name);
    // 0→1 过渡检测：users.json 尚不存在（站点零真实用户）→ 本次是首个真实用户
    // 创建，break-glass 凭据文件同步作废（不再残留明文密码）。注意：bootstrap
    // admin 已彻底移除，addUser 是真实用户的唯一入口。
    const wasEmpty = !existsSync(this.#usersFile);
    const rows = await this.#readDb();
    const isNew = !rows.has(name);
    const salt = randomBytes(16).toString("hex");
    rows.set(name, {
      displayName: displayName ?? name,
      salt,
      hash: hashPassword(password, salt),
    });
    await this.#writeDb(rows);
    if (wasEmpty && rows.size > 0) {
      const credFile = join(this.#ctx.configDir, "initial-user.txt");
      try {
        if (existsSync(credFile)) {
          rmSync(credFile);
          this.#ctx.log(`portal: break-glass credentials cleaned (${credFile}) — first real user created`);
        }
      } catch {
        // best-effort — 清理失败不影响建号
      }
    }
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

  async setDisplayName(name: string, displayName: string): Promise<void> {
    validateUserName(name);
    const dn = displayName.trim();
    if (!dn || dn.length > 64) throw new Error("displayName required (max 64 chars)");
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    rec.displayName = dn;
    await this.#writeDb(rows);
    this.#ctx.log(`portal: displayName updated for ${name}`);
  }

  async removeUser(name: string): Promise<void> {
    validateUserName(name);
    const rows = await this.#readDb();
    if (!rows.delete(name)) throw new Error(`user ${name} not registered`);
    await this.#writeDb(rows);
    // 生物模板随用户删除（templates.json 同步清理，避免孤儿向量）
    const tpl = await this.#readTemplates();
    if (tpl[name]) {
      delete tpl[name];
      await this.#writeTemplates(tpl);
    }
    this.#ctx.log(`portal: user ${name} removed`);
  }

  // —— 生物识别 2FA 管理（BiometricManager，biometric-2fa-design.md §9）——

  async #readTemplates(): Promise<Record<string, BiometricTemplates>> {
    try {
      return JSON.parse(readFileSync(this.#templatesFile, "utf8")) as Record<string, BiometricTemplates>;
    } catch {
      return {};
    }
  }

  async #writeTemplates(rows: Record<string, BiometricTemplates>): Promise<void> {
    mkdirSync(this.#dir, { recursive: true });
    const file = `${this.#templatesFile}.${process.pid}.tmp`;
    writeFileSync(file, JSON.stringify(rows, null, 2), "utf8");
    try {
      execFileSync("chmod", ["600", file], { stdio: "ignore" });
    } catch {
      // best-effort
    }
    execFileSync("mv", [file, this.#templatesFile], { stdio: "ignore" });
  }

  async biometricStatus(name: string): Promise<{ face: boolean; facePending: boolean; voice: boolean; voicePending: boolean }> {
    const tpl = await this.#readTemplates();
    const t = tpl[name];
    return {
      face: t?.face?.status === "active",
      facePending: t?.face?.status === "pending",
      voice: t?.voice?.status === "active",
      voicePending: t?.voice?.status === "pending",
    };
  }

  /** 注册人脸模板：写入 pending（首验门——未验证前登录不可用，对齐
   *  totpPending 语义）。samples 来自管理界面浏览器采集（128-d 描述子）。 */
  async biometricEnrollFace(name: string, samples: number[][]): Promise<{ pending: boolean }> {
    // 管理端直写模板（数据层）——不检查 #bioFace：能力开关属于门户运行配置，
    // 管理侧预设置不应依赖「先以 biometrics 开一次公开」。模板 pending，
    // 门户以 biometrics 启动后即可用于登录验证。
    validateUserName(name);
    const rows = await this.#readDb();
    if (!rows.has(name)) throw new Error(`user ${name} not registered`);
    const vecs = validateFaceSamples(samples);
    const tpl = await this.#readTemplates();
    tpl[name] = { ...tpl[name], face: { status: "pending", vectors: vecs, threshold: this.#faceThreshold, enrolledAt: Date.now() } };
    await this.#writeTemplates(tpl);
    this.#ctx.log(`portal: face template enrolled for ${name} (pending first-verify)`);
    return { pending: true };
  }

  /** 验证人脸向量；pending 模板首验成功即转 active（首验门）。 */
  async biometricVerifyFace(name: string, vectors: number[][]): Promise<{ matched: boolean; distance: number }> {
    validateUserName(name);
    const sub = validateFaceSamples(vectors, "vectors");
    const tpl = await this.#readTemplates();
    const face = tpl[name]?.face;
    if (!face) throw new Error(`user ${name} has no face template`);
    const d = faceDistance(face.vectors, sub);
    const matched = d <= (face.threshold ?? this.#faceThreshold);
    if (matched && face.status === "pending") {
      face.status = "active";
      await this.#writeTemplates(tpl);
      this.#ctx.log(`portal: face template activated for ${name} (d=${d.toFixed(3)})`);
    }
    return { matched, distance: d };
  }

  async biometricDisable(name: string, method: "face" | "voice"): Promise<void> {
    validateUserName(name);
    const tpl = await this.#readTemplates();
    if (!tpl[name]?.[method]) throw new Error(`user ${name} has no ${method} template`);
    delete tpl[name]![method];
    await this.#writeTemplates(tpl);
    this.#ctx.log(`portal: ${method} template removed for ${name}`);
  }

  /** 注册语音模板（P2）：3 次朗读（数字串挑战，每次不同）→ 78-d 向量 →
   *  质量门（两两余弦 ≥ VOICE_ENROLL_MIN_PAIR_SIM）→ pending 首验门。 */
  async biometricEnrollVoice(name: string, utterances: number[][]): Promise<{ pending: boolean }> {
    // 管理端直写模板（数据层）——不检查 #bioVoice，同 biometricEnrollFace。
    validateUserName(name);
    const rows = await this.#readDb();
    if (!rows.has(name)) throw new Error(`user ${name} not registered`);
    const vecs = validateVoiceSamples(utterances);
    if (vecs.length < 3) throw new Error("voice enrollment needs 3 utterances (digit challenges)");
    const q = voiceEnrollQuality(vecs);
    if (q < VOICE_ENROLL_MIN_PAIR_SIM) {
      throw new Error(`voice samples inconsistent (pair similarity ${q.toFixed(3)} < ${VOICE_ENROLL_MIN_PAIR_SIM}) — recapture in a quieter environment`);
    }
    const tpl = await this.#readTemplates();
    tpl[name] = { ...tpl[name], voice: { status: "pending", vectors: vecs, threshold: this.#voiceThreshold, enrolledAt: Date.now() } };
    await this.#writeTemplates(tpl);
    this.#ctx.log(`portal: voice template enrolled for ${name} (pending first-verify, q=${q.toFixed(3)})`);
    return { pending: true };
  }

  /** 验证语音向量；pending 模板首验成功即转 active。similarity = 两两余弦最大。 */
  async biometricVerifyVoice(name: string, vectors: number[][]): Promise<{ matched: boolean; similarity: number }> {
    validateUserName(name);
    const sub = validateVoiceSamples(vectors, "vectors");
    const tpl = await this.#readTemplates();
    const voice = tpl[name]?.voice;
    if (!voice) throw new Error(`user ${name} has no voice template`);
    const s = voiceSimilarity(voice.vectors, sub);
    const matched = s >= (voice.threshold ?? this.#voiceThreshold);
    if (matched && voice.status === "pending") {
      voice.status = "active";
      await this.#writeTemplates(tpl);
      this.#ctx.log(`portal: voice template activated for ${name} (s=${s.toFixed(3)})`);
    }
    return { matched, similarity: s };
  }

  /** portal /enroll 采集页的一次性注册票（预先设置路径，biometric-2fa-design
   *  §9.1）：HMAC(SECRET) 无状态签名——子进程用同一 SECRET 验证；10 分钟
   *  有效。管理 UI 拿到 url 后直接开页面，采集/加密/资产全在 portal 一侧。 */
  async biometricEnrollTicket(name: string, method: "face" | "voice"): Promise<{ token: string; method: string; expiresInMs: number }> {
    if (method !== "face" && method !== "voice") throw new Error(`biometric method ${method} not supported`);
    // 签票只依赖 secret + 用户库（数据层）——不检查 #bioFace/#bioVoice：
    // 能力开关属于门户运行配置，管理侧预设置不应依赖「先以 biometrics 开一次公开」。
    // 若门户未启用该方法，采集页打开时会给出明确提示（子进程侧校验）。
    validateUserName(name);
    const rows = await this.#readDb();
    if (!rows.has(name)) throw new Error(`user ${name} not registered`);
    const ttl = 10 * 60_000;
    const payload = Buffer.from(JSON.stringify({ n: name, m: method, e: Date.now() + ttl })).toString("base64url");
    const sig = createHmac("sha256", this.#secret).update(payload).digest("base64url");
    return { token: `${payload}.${sig}`, method, expiresInMs: ttl };
  }

  // —— TOTP 2FA management ——

  /** 默认 TOTP 标识（authenticator 里显示的 account@issuer）：
   *  `<name>-<auth>-<site>@<host>` —— 站点各自独立用户库，同用户名在不同
   *  站点/auth 下必须能区分；user/auth/site 用 `-` 连接成一段 account，
   *  host 前保留 `@`（也是 otpauth issuer 部分）。host = 该 portal 站点注册
   *  的第一个 host（用户实际认证的虚拟主机，如 5173-app.example.com）；
   *  尚无 host 时省略 @host 部分。调用方可在登记时覆盖（label）。 */
  defaultTotpLabel(name: string): string {
    const host = this.#hosts.keys().next().value;
    const base = `${name}-${this.type}-${this.site}`;
    return host ? `${base}@${host}` : base;
  }

  /** Enroll TOTP for a user. Returns the base32 secret + otpauth URL.
   *  `label` 为 authenticator 显示的标识（account@issuer），缺省用
   *  defaultTotpLabel()；纯展示用途（校验只认 secret），可任意自定义。 */
  async totpEnroll(name: string, label?: string): Promise<{ secret: string; otpauthUrl: string; label: string }> {
    const rows = await this.#readDb();
    const rec = rows.get(name);
    if (!rec) throw new Error(`user ${name} not registered`);
    const secret = base32Encode(randomBytes(20));
    // Pending until the user proves they hold the secret (first TOTP code) —
    // the existing totpSecret (if any) stays enforced meanwhile, so a caller
    // of the management API cannot silently take over a user's 2FA.
    rec.totpPending = secret;
    await this.#writeDb(rows);
    const finalLabel = (label ?? "").trim() || this.defaultTotpLabel(name);
    // issuer = host 部分（最后一个 @ 之后），authenticator 按 issuer 分组/展示
    const issuer = finalLabel.includes("@") ? finalLabel.slice(finalLabel.lastIndexOf("@") + 1) : finalLabel;
    this.#ctx.log(`portal: TOTP enrolled for ${name} (label ${finalLabel})`);
    return {
      secret,
      label: finalLabel,
      otpauthUrl: `otpauth://totp/${encodeURIComponent(finalLabel)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
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

async function probePortal(port: number, basePath: string, host = "127.0.0.1"): Promise<void> {
  const { request } = await import("http");
  await new Promise<void>((resolve, reject) => {
    const req = request(
      { host, port, path: `${basePath}/api/authz/auth-request`, method: "GET" },
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

function waitTcp(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = connect(port, host);
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

/** voice 特征维度：13 MFCC × (Δ+ΔΔ 每帧 39 维) × (mean+std) = 78。 */
export const VOICE_DIM = 78;
/** voice 样本校验：1..5 组，每组恰 VOICE_DIM 个有限数（MFCC 量级宽松）。 */
export function validateVoiceSamples(samples: unknown, what = "samples"): number[][] {
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 5) {
    throw new Error(`${what}: expected 1-5 vectors`);
  }
  return samples.map((v) => {
    if (
      !Array.isArray(v) ||
      v.length !== VOICE_DIM ||
      !v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1e6)
    ) {
      throw new Error(`${what}: each vector must be ${VOICE_DIM} finite numbers`);
    }
    return v as number[];
  });
}
/** 余弦相似度。 */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
/** voice 匹配：注册向量 × 提交向量余弦取最大（≥ threshold 视为同一人）。 */
export function voiceSimilarity(enroll: number[][], submit: number[][]): number {
  let best = -1;
  for (const e of enroll) {
    for (const v of submit) {
      const s = cosineSim(e, v);
      if (s > best) best = s;
    }
  }
  return best;
}
/** voice 注册质量门：样本两两余弦最小值（现场一致性——噪声环境/他人代录
 *  会拉低；低于 floor 的模板直接拒绝，防止写入永远验证不过的模板）。 */
export const VOICE_ENROLL_MIN_PAIR_SIM = 0.85;
export function voiceEnrollQuality(vectors: number[][]): number {
  let min = 1;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const s = cosineSim(vectors[i]!, vectors[j]!);
      if (s < min) min = s;
    }
  }
  return min;
}

// 页面公共 JS（纯文本常量，生成时 JSON.stringify 注入）：字节转换 + 混合加密
// （AES-256-GCM 载荷 + RSA-OAEP 包裹密钥，§7.2）+ MFCC 78-d 提取（零依赖）。
export const PAGE_CRYPTO_JS = `
function b2u(b){var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}
function u2b(u){var s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s);}
async function hybridEncrypt(pubB64,keyId,payloadStr){
  var aes=crypto.getRandomValues(new Uint8Array(32));
  var iv=crypto.getRandomValues(new Uint8Array(12));
  var ak=await crypto.subtle.importKey("raw",aes,{name:"AES-GCM"},false,["encrypt"]);
  var ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:iv},ak,new TextEncoder().encode(payloadStr)));
  var rk=await crypto.subtle.importKey("spki",b2u(atob(pubB64)),{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);
  var wk=new Uint8Array(await crypto.subtle.encrypt({name:"RSA-OAEP"},rk,aes));
  return {keyId:keyId,wrapped:u2b(wk),iv:u2b(iv),data:u2b(ct)};
}
function fftMag(frame){
  var n=frame.length,re=new Float64Array(n),im=new Float64Array(n);
  for(var i=0;i<n;i++){var w=0.54-0.46*Math.cos(2*Math.PI*i/(n-1));re[i]=frame[i]*w;}
  for(var i=1,j=0;i<n;i++){var bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;
    if(i<j){var tr=re[i];re[i]=re[j];re[j]=tr;}}
  for(var len=2;len<=n;len<<=1){var ang=-2*Math.PI/len,half=len>>1;
    for(var i=0;i<n;i+=len)for(var k=0;k<half;k++){
      var c=Math.cos(ang*k),s=Math.sin(ang*k);
      var ur=re[i+k],ui=im[i+k];
      var vr=re[i+k+half]*c-im[i+k+half]*s,vi=re[i+k+half]*s+im[i+k+half]*c;
      re[i+k]=ur+vr;im[i+k]=ui+vi;re[i+k+half]=ur-vr;im[i+k+half]=ui-vi;}}
  var out=new Float64Array(n/2);for(var i=0;i<n/2;i++)out[i]=Math.sqrt(re[i]*re[i]+im[i]*im[i]);return out;
}
var MEL_F=null;
function melFilters(nfilt,nfft,sr){
  if(MEL_F)return MEL_F;
  var f=function(hz){return 2595*Math.log(1+hz/700)/Math.LN10;};
  var inv=function(m){return 700*(Math.pow(10,m/2595)-1);};
  var lo=f(0),hi=f(Math.min(8000,sr/2));
  var pts=[];for(var i=0;i<nfilt+2;i++)pts.push(inv(lo+(hi-lo)*i/(nfilt+1)));
  var bins=pts.map(function(hz){return Math.round(hz/(sr/2)*(nfft/2));});
  var F=[];
  for(var m=0;m<nfilt;m++){
    var row=new Float64Array(nfft/2);
    for(var k=bins[m];k<bins[m+1];k++)row[k]=(k-bins[m])/(bins[m+1]-bins[m]);
    for(var k=bins[m+1];k<bins[m+2];k++)row[k]=(bins[m+2]-k)/(bins[m+2]-bins[m+1]);
    F.push(row);
  }
  MEL_F=F;return F;
}
function mfcc78(pcm,sr){
  var FR=400,HP=Math.round(sr*0.01),NF=512,NMEL=26,NMFCC=13;
  var frames=[];
  for(var off=0;off+FR<=pcm.length;off+=HP){
    var fr=pcm.subarray(off,off+FR);
    var e=0;for(var i=0;i<FR;i++)e+=fr[i]*fr[i];
    frames.push({f:fr,e:e});
  }
  if(frames.length<8)return null;
  var maxE=0;for(var i=0;i<frames.length;i++)if(frames[i].e>maxE)maxE=frames[i].e;
  frames=frames.filter(function(x){return x.e>maxE*0.01;});
  if(frames.length<8)return null;
  var F=melFilters(NMEL,NF,sr),cos1=Math.PI/NMEL;
  var mf=[];
  for(var t=0;t<frames.length;t++){
    var padded=new Float64Array(NF);padded.set(frames[t].f);
    var mag=fftMag(padded);
    var c=new Float64Array(NMFCC);
    for(var m=0;m<NMEL;m++){var s=0;for(var k=0;k<NF/2;k++)s+=F[m][k]*mag[k];s=Math.log(s+1e-10);
      for(var i=0;i<NMFCC;i++)c[i]+=(s*Math.cos(cos1*i*(m+0.5)));
    }
    for(var i=0;i<NMFCC;i++)c[i]/=NMEL;
    mf.push(c);
  }
  var T=mf.length,feat=[];
  for(var t=0;t<T;t++){
    var d1=new Float64Array(NMFCC),d2=new Float64Array(NMFCC);
    if(t>0&&t<T-1)for(var i=0;i<NMFCC;i++)d1[i]=(mf[t+1][i]-mf[t-1][i])/2;
    if(t>1&&t<T-2)for(var i=0;i<NMFCC;i++)d2[i]=(mf[t+2][i]-mf[t-2][i])/2;else if(t>0&&t<T-1)for(var i=0;i<NMFCC;i++)d2[i]=(mf[t+1][i]-mf[t-1][i])/2;
    var row=new Float64Array(NMFCC*3);
    for(var i=0;i<NMFCC;i++){row[i]=mf[t][i];row[NMFCC+i]=d1[i];row[NMFCC*2+i]=d2[i];}
    feat.push(row);
  }
  var D=feat[0].length,out=new Array(D*2);
  for(var i=0;i<D;i++){var s=0;for(var t=0;t<T;t++)s+=feat[t][i];var mu=s/T;var v=0;
    for(var t=0;t<T;t++){var x=feat[t][i]-mu;v+=x*x;}out[i]=mu;out[D+i]=Math.sqrt(v/T);}
  return out;
}
async function extractVoiceVector(blob){
  var buf=await blob.arrayBuffer();
  var ac=new (window.AudioContext||window.webkitAudioContext)();
  var decoded=await ac.decodeAudioData(buf);
  var off=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);
  var src=off.createBufferSource();src.buffer=decoded;src.connect(off.destination);src.start();
  var rendered=await off.startRendering();
  var v=mfcc78(rendered.getChannelData(0),16000);
  ac.close();
  return v;
}
`;

/** The generated portal server (ESM, written to cacheDir/tmp/portal/server.mjs). */
function writeServerScript(
  file: string,
  basePath: string,
  deployBasePath = "",
  site = "default",
  justgetVer = "0",
  faceAssetsJson = "{}",
): void {
  const script = `import { createServer } from "http";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "fs";
import { createHmac, scryptSync, randomBytes, timingSafeEqual, generateKeyPairSync, privateDecrypt, constants, createDecipheriv } from "crypto";

const PORT = Number(process.env.PORT);
const SECRET = process.env.SECRET;
const USERS_FILE = process.env.USERS_FILE;
const BASE = process.env.BASE_PATH || "/portal";
const DEPLOY = process.env.DEPLOY_BASE_PATH || "";
const POLICY_FILE = process.env.POLICY_FILE || "";
const POLICY_DEFAULT = process.env.POLICY_DEFAULT || "one_factor";
const SECURE = process.env.SECURE === "1";
// 信任上游代理转发（authonly 经外部 nginx 转发时开）：仅当连接来自回环
// （本机 nginx）才采信 X-Forwarded-For 的最后一个 IP（nginx 追加的真实
// 客户端地址；客户端伪造的前缀项被越过），使 per-IP 封禁作用于真实来源。
// 缺省关闭：直连模式（无代理头）用 socket 地址，行为不变。
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
// 恒时登录校验（防用户名/密码枚举的响应时间侧信道）：无论目标用户是否存在，
// 都执行一次成本相同的 scrypt。虚拟用户盐 + 哈希同为 64 字节派生，仅作比对
// 垫片永不匹配。scrypt 成本参数由 hashPassword 侧固定（N=16384,r=8,p=1，
// 64 字节输出）——这里用同一参数派生，成本一致。
const DUMMY_SALT = "st-dummy-salt-0000000000000000";
const DUMMY_HASH = scryptSync("st-dummy-password", DUMMY_SALT, 64).toString("hex");
// break-glass 初始用户（仅站点 0 个真实用户时可登录；不验证 2FA；站点一旦出现
// 任意用户即失效——登录拒绝 + 已签发初始会话一并作废）。密码以 scrypt 哈希比对，
// salt 每次进程启动随机（同一密码跨重启不可重放）。
const INITIAL_USER = process.env.INITIAL_USER || "";
const INITIAL_PASSWORD = process.env.INITIAL_PASSWORD || "";
const INITIAL_SALT = randomBytes(16).toString("hex");
const INITIAL_HASH = INITIAL_PASSWORD ? scryptSync(INITIAL_PASSWORD, INITIAL_SALT, 64).toString("hex") : "";
function siteHasUsers() {
  return Object.keys(loadUsers()).length > 0;
}
const COOKIE = "st_portal${site === "default" ? "" : "_" + site}_session";
const COOKIE2 = "st_portal${site === "default" ? "" : "_" + site}_2fa";
const SITE = ${JSON.stringify(site)};
// justget/browser 版本（页面拼缓存参数用；随库升级变更）
const JGVER = ${JSON.stringify(justgetVer)};
// face 资产配置（浏览器竞速下载用：CDN URL 模板 + sha256 校验清单）
const FACE_CFG = JSON.parse(${JSON.stringify(faceAssetsJson)});
// 会话/记住我 TTL 与 2FA 复验周期（biometric-2fa-design.md §5）——父进程按
// opts 计算后经 env 注入；缺省 7d / 365d / 52d（= 365/7，最小 1 天）。
const TTL_MS = Number(process.env.TTL_MS) || 7 * 24 * 3600 * 1000;
const REMEMBER_TTL_MS = Number(process.env.REMEMBER_TTL_MS) || 365 * 24 * 3600 * 1000;
const GRACE_MS = Number(process.env.GRACE_MS) || 52 * 24 * 3600 * 1000;
// 生物识别（P1: face）——模板/资产/阈值经 env 注入（biometric-2fa-design.md §7）
const TEMPLATES_FILE = process.env.TEMPLATES_FILE || "";
const FACE_ENABLED = process.env.FACE_ENABLED === "1";
const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD) || 0.6;
const VOICE_ENABLED = process.env.VOICE_ENABLED === "1";
const VOICE_THRESHOLD = Number(process.env.VOICE_THRESHOLD) || 0.9;
const ENROLL_SECRET = process.env.SECRET || "";
const ASSETS_DIR = process.env.ASSETS_DIR || "";
const STATIC_DIR = process.env.STATIC_DIR || "";
const MODEL_FILES = [
  "tiny_face_detector_model-weights_manifest.json", "tiny_face_detector_model.bin",
  "face_landmark_68_model-weights_manifest.json", "face_landmark_68_model.bin",
  "face_recognition_model-weights_manifest.json", "face_recognition_model.bin",
];

function loadUsers() {
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

// 生物识别模板（templates.json，父进程管理 API 原子写；此处只读、逐请求）
function loadTemplates() {
  try {
    return JSON.parse(readFileSync(TEMPLATES_FILE, "utf8"));
  } catch {
    return {};
  }
}
// /enroll 采集页写入（登录时自助注册/票注册）——与父进程同一原子写模式
// （tmp + chmod 600 + rename；父进程管理 API 可能并发写同一文件）
function writeTemplates(rows) {
  const tmp = TEMPLATES_FILE + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  renameSync(tmp, TEMPLATES_FILE);
}

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function issueSession(name, cookieName = COOKIE, ttl = TTL_MS, twoFactorAt = 0, initial = false) {
  // cookieName is mixed into the payload so a 2FA ticket can never be
  // replayed as a full session cookie (or vice versa). twoFactorAt = 最近一次
  // 2FA 完成时刻（".2fa:<epochMs>"后缀）——探针按 GRACE_MS 复验（remember me）。
  // initial = break-glass 初始会话（".init:1" 后缀）——站点一旦有用户即失效。
  const payload = String(Date.now() + ttl) + "." + cookieName + "." + name
    + (initial ? ".init:1" : "")
    + (twoFactorAt ? ".2fa:" + twoFactorAt : "");
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
  let name = parts.slice(2).join(".");
  let twoFactorAt = 0;
  let initial = false;
  const m2fa = /\\.2fa:(\\d+)$/.exec(name);
  if (m2fa) { twoFactorAt = Number(m2fa[1]); name = name.slice(0, name.length - m2fa[0].length); }
  const minit = /\\.init:1$/.exec(name);
  if (minit) { initial = true; name = name.slice(0, name.length - minit[0].length); }
  return { name, twoFactorAt, initial, expiry };
}

function hostPolicy(host) {
  try {
    const map = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
    return map[String(host).toLowerCase()] ?? POLICY_DEFAULT;
  } catch {
    return POLICY_DEFAULT;
  }
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

// —— 2FA 方法抽象（biometric-2fa-design.md §6）————————————————
// P0：totp 唯一内置方法；face/voice 在 P1/P2 加入（availableMethods 挂勾 +
// 专属页/路由）。方法页共享同一 COOKIE2 票据，全部 POST /login/2fa，body
// 带 method 字段区分（缺省 totp，向后兼容旧表单）。
const METHOD_LABELS = { totp: "Authenticator app (TOTP)", face: "Face recognition", voice: "Voice recognition" };
function availableMethods(name, rec) {
  const out = [];
  if (rec && rec.totpSecret) out.push("totp");
  if (FACE_ENABLED) {
    const t = loadTemplates()[name];
    if (t && t.face && t.face.status === "active") out.push("face");
  }
  if (VOICE_ENABLED) {
    const t = loadTemplates()[name];
    if (t && t.voice && t.voice.status === "active") out.push("voice");
  }
  return out;
}

// voice 挑战（随机 6 位数字 + nonce 单次消费；digits 展示给用户朗读）
const voiceChallenges = new Map();
const VOICE_CHALLENGE_TTL = 5 * 60_000;
function issueVoiceChallenge(name) {
  cleanupVoiceChallenges();
  let digits = "";
  for (let i = 0; i < 6; i++) digits += Math.floor(Math.random() * 10);
  const nonce = randomBytes(16).toString("hex");
  voiceChallenges.set(nonce, { name, digits, expires: Date.now() + VOICE_CHALLENGE_TTL });
  return { nonce, digits };
}
function cleanupVoiceChallenges() {
  const now = Date.now();
  for (const [n, c] of voiceChallenges) if (c.expires < now) voiceChallenges.delete(n);
}
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function voiceSimilarity(enroll, submit) {
  let best = -1;
  for (const e of enroll) for (const v of submit) { const s = cosineSim(e, v); if (s > best) best = s; }
  return best;
}
function voiceEnrollQuality(vectors) {
  let min = 1;
  for (let i = 0; i < vectors.length; i++)
    for (let j = i + 1; j < vectors.length; j++) { const s = cosineSim(vectors[i], vectors[j]); if (s < min) min = s; }
  return min;
}
// voice 向量校验：恰 78 个有限数（MFCC 量级宽松）
function validVoiceVec(v) {
  return Array.isArray(v) && v.length === 78 && v.every(function (x) { return typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1e6; });
}
// 注册票验证（父进程 biometricEnrollTicket 的 HMAC 签名；单次消费用内存
// Map token→expiry，超 256 条时清扫过期项——防无界增长）
const usedTickets = new Map();
function sweepUsedTickets() {
  if (usedTickets.size <= 256) return;
  const now = Date.now();
  for (const [t, e] of usedTickets) if (e < now) usedTickets.delete(t);
}
function verifyEnrollTicket(token) {
  const i = String(token || "").indexOf(".");
  if (i < 1) return null;
  const payload = String(token).slice(0, i);
  const sig = String(token).slice(i + 1);
  const expect = createHmac("sha256", ENROLL_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  sweepUsedTickets();
  if (usedTickets.has(String(token))) return null; // 单次使用
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!d || !d.n || !d.m || !d.e || d.e < Date.now()) return null;
    return d;
  } catch {
    return null;
  }
}

// face 挑战 nonce（页面渲染时签发，5 分钟单次使用——payload 必须携带，
// 重放旧 payload 时 nonce 已消费/过期 → 拒绝）
const faceChallenges = new Map();
const FACE_CHALLENGE_TTL = 5 * 60_000;
function issueFaceChallenge(name) {
  cleanupFaceChallenges();
  const nonce = randomBytes(16).toString("hex");
  faceChallenges.set(nonce, { name, expires: Date.now() + FACE_CHALLENGE_TTL });
  return nonce;
}
function cleanupFaceChallenges() {
  const now = Date.now();
  for (const [n, c] of faceChallenges) if (c.expires < now) faceChallenges.delete(n);
}
// face 匹配距离（与父进程 faceDistance 同式）：注册向量 × 提交向量两两欧氏取最小
function faceDistance(enroll, submit) {
  let best = Infinity;
  for (const e of enroll) {
    for (const v of submit) {
      let s = 0;
      for (let k = 0; k < 128; k++) { const t = e[k] - v[k]; s += t * t; }
      const d = Math.sqrt(s);
      if (d < best) best = d;
    }
  }
  return best;
}

function escapeAttr(s) {
  // raw next in the hidden field (NOT URL-encoded): the browser form-encodes
  // on submit + URLSearchParams decodes server-side, so pre-encoding would
  // stack encodings every redirect and break the post-login redirect to /
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function totpPage(next, error, host, remember = false, altMethods = []) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  const alt = altMethods && altMethods.length > 1
    ? '<a class="alt" href="' + BASE + "/login/2fa?next=" + encodeURIComponent(next) + (remember ? "&r=1" : "") + '">Use another method</a>'
    : "";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Two-factor</title>'
    + '<style>*{box-sizing:border-box}body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7;padding:1rem}'
    + 'form{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:22rem}'
    + 'h1{font-size:1.15rem;margin:0 0 .3rem}p.hint{font-size:.85rem;color:#666;margin:0 0 .6rem}'
    + '@media(max-width:480px){form,#busy .card{padding:1.5rem 1.25rem}}'
    + 'p.meta{font-size:.72rem;color:#888;margin:0 0 1rem;line-height:1.6}p.meta b{color:#555}'
    + 'input{width:100%;box-sizing:border-box;padding:.55rem;border:1px solid #d0d3da;border-radius:6px;letter-spacing:.35em;text-align:center}a.alt{display:inline-block;margin-top:.8rem;font-size:.85rem;color:#2d6cdf;text-align:center}'
    + 'button{margin-top:1.2rem;width:100%;padding:.6rem;background:#2d6cdf;color:#fff;border:0;border-radius:6px;cursor:pointer}'
    + '#busy{position:fixed;inset:0;background:#f4f5f7;display:none;flex-direction:column;align-items:center;justify-content:center;z-index:50;padding:1rem}'
    + '#busy .card{background:#fff;padding:2.5rem 2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:22rem;text-align:center}'
    + '#busy .spin{width:2.2rem;height:2.2rem;margin:0 auto 1rem;border:3px solid #d0d3da;border-top-color:#2d6cdf;border-radius:50%;animation:st .8s linear infinite}'
    + '@keyframes st{to{transform:rotate(360deg)}}'
    + '#busy p{margin:.25rem 0;color:#555;font-size:.9rem}#busy p.t{font-weight:600;color:#222;font-size:1.05rem}</style>'
    + '</head><body><form method="post" action="' + BASE + '/login/2fa">'
    + '<h1>Two-factor authentication</h1>'
    + '<p class="hint">Enter the 6-digit code from your authenticator app.</p>'
    + (SITE || host ? '<p class="meta">Site: <b>' + SITE + '</b><br>Domain: <b>' + escapeAttr(host || "") + '</b></p>' : "")
    + '<input type="hidden" name="next" value="' + escapeAttr(next) + '">'
    + '<input type="hidden" name="method" value="totp">'
    + (remember ? '<input type="hidden" name="remember" value="1">' : "") + err
    + '<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required autofocus>'
    + '<button type="submit">Verify</button>'
    + alt
    + '</form>'
    + '<div id="busy"><div class="card"><div class="spin"></div><p class="t">Verifying…</p><p>Please wait</p></div></div>'
    // 只收数字、满 6 位自动提交（submit 事件仍触发 spinner 过渡层；
    // 按钮保留作为无 JS 兜底）。TOTP 固定 6 位纯数字（RFC 6238 默认）。
    + '<script>var f=document.querySelector("form");if(f)f.addEventListener("submit",function(){var o=document.getElementById("busy");if(o)o.style.display="flex";var b=f.querySelector("button");if(b){b.disabled=true;b.textContent="Verifying…";}});var i=document.querySelector("input[name=code]");if(i)i.addEventListener("input",function(){this.value=[...this.value].filter(function(c){return c>="0"&&c<="9"}).join("").slice(0,6);if(this.value.length===6&&f)f.submit();});</script>'
    + '</body></html>';
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
function recordFailure(account, ip, maxRetries = MAX_RETRIES) {
  const now = Date.now();
  const b = loadBrute();
  const acct = b.accounts[account] || (b.accounts[account] = { fails: [], strikes: 0, bannedUntil: 0 });
  const addr = b.ips[ip] || (b.ips[ip] = { fails: [], strikes: 0, bannedUntil: 0 });
  for (const t of [acct, addr]) {
    t.fails = sweepFailures(t.fails, now);
    t.fails.push(now);
    if (t.fails.length >= maxRetries) {
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

// 真实客户端 IP（封禁用）：socket 回环 + TRUST_PROXY → 取 X-Forwarded-For
// 最后一项（nginx $proxy_add_x_forwarded_for 追加的真实远端）；否则 socket 地址。
function clientIp(req) {
  const sock = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!TRUST_PROXY || (sock !== "127.0.0.1" && sock !== "::1")) return sock;
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const last = xff[xff.length - 1];
  return last || sock;
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
function decryptRaw(keyId, encryptedB64) {
  const pair = rsaKeys.get(keyId);
  rsaKeys.delete(keyId); // one-time use — replay of a captured ciphertext fails
  if (!pair || pair.expires < Date.now()) throw new Error("stale or unknown key id");
  try {
    return privateDecrypt(
      { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(encryptedB64, "base64"),
    );
  } catch {
    throw new Error("decryption failed");
  }
}
function decryptPassword(keyId, encryptedB64) {
  return decryptRaw(keyId, encryptedB64).toString("utf8");
}
// 混合解密（face 向量 payload 远超 RSA-OAEP 190B 上限）：RSA 包裹一次性
// AES-256-GCM 密钥，载荷走 AES（WebCrypto 的 AES-GCM 输出尾部含 16B tag）
function decryptHybrid(keyId, wrappedB64, ivB64, dataB64) {
  const aesRaw = decryptRaw(keyId, wrappedB64);
  const buf = Buffer.from(dataB64, "base64");
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(0, buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", aesRaw, Buffer.from(ivB64, "base64"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
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
      + 'function showBusy(){var o=document.getElementById("busy");if(o)o.style.display="flex";var b=document.querySelector("button[type=submit]");if(b){b.disabled=true;b.textContent="Signing in…";}}'
      + 'function hideBusy(){var o=document.getElementById("busy");if(o)o.style.display="none";var b=document.querySelector("button[type=submit]");if(b){b.disabled=false;b.textContent="Sign in";}}'
      + 'document.addEventListener("DOMContentLoaded",async()=>{'
      + 'const f=document.getElementById("login");'
      + 'f.addEventListener("submit",async(e)=>{'
      + 'if(!window.crypto||!crypto.subtle)return;' // no WebCrypto → plaintext fallback (js-warn banner already shown)
      + 'e.preventDefault();'
      + 'showBusy();'
      + 'try{'
      + 'const pw=document.getElementById("pw").value;'
      + 'const key=await crypto.subtle.importKey("spki",b64ToBuf(PUB),{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);'
      + 'const enc=new Uint8Array(await crypto.subtle.encrypt({name:"RSA-OAEP"},key,new TextEncoder().encode(pw)));'
      + 'let b="";for(const x of enc)b+=String.fromCharCode(x);'
      + 'document.getElementById("encrypted").value=btoa(b);'
      + 'document.getElementById("keyId").value=KEY_ID;'
      + 'document.getElementById("pw").value="";'
      + 'f.submit();'
      + '}catch(err){hideBusy();alert("Encryption failed — please try again.");}'
      + '});});</script>'
    : "";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<style>*{box-sizing:border-box}body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7;padding:1rem}'
    + 'form{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:22rem}'
    + 'h1{font-size:1.15rem;margin:0 0 1.2rem}label{display:block;font-size:.8rem;color:#666;margin:.8rem 0 .25rem}'
    + '@media(max-width:480px){form,#busy .card{padding:1.5rem 1.25rem}}'
    + 'input{width:100%;box-sizing:border-box;padding:.55rem;border:1px solid #d0d3da;border-radius:6px}'
    + 'label.rm{display:flex;gap:.45rem;align-items:center;font-size:.82rem;color:#555;margin:.9rem 0 0;cursor:pointer}'
    + 'label.rm input{width:auto;margin:0}'
    + 'button{margin-top:1.4rem;width:100%;padding:.6rem;background:#2d6cdf;color:#fff;border:0;border-radius:6px;cursor:pointer}'
    + 'p.warn{background:#fdf3e0;border:1px solid #f0c36d;color:#8a6d1a;font-size:.8rem;padding:.5rem .7rem;border-radius:6px;margin:1rem 0 .2rem;line-height:1.4}'
    + 'p.meta{font-size:.72rem;color:#888;margin:0 0 1rem;line-height:1.6}p.meta b{color:#555}'
    + '#busy{position:fixed;inset:0;background:#f4f5f7;display:none;flex-direction:column;align-items:center;justify-content:center;z-index:50;padding:1rem}'
    + '#busy .card{background:#fff;padding:2.5rem 2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:22rem;text-align:center}'
    + '#busy .spin{width:2.2rem;height:2.2rem;margin:0 auto 1rem;border:3px solid #d0d3da;border-top-color:#2d6cdf;border-radius:50%;animation:st .8s linear infinite}'
    + '@keyframes st{to{transform:rotate(360deg)}}'
    + '#busy p{margin:.25rem 0;color:#555;font-size:.9rem}#busy p.t{font-weight:600;color:#222;font-size:1.05rem}</style>'
    + '</head><body>' + enc
    + '<form id="login" method="post" action="' + BASE + '/login">'
    + '<h1>Sign in to access this service</h1>'
    + (SITE || host ? '<p class="meta">Site: <b>' + SITE + '</b><br>Domain: <b>' + escapeAttr(host || "") + '</b></p>' : "")
    + '<input type="hidden" name="next" value="' + escapeAttr(next) + '">' + err + noJs
    + '<input type="hidden" name="encrypted" id="encrypted">'
    + '<input type="hidden" name="keyId" id="keyId">'
    + '<label>Username</label><input name="username" autocomplete="username" required autofocus>'
    + '<label>Password</label><input name="password" id="pw" type="password" autocomplete="current-password" required>'
    + '<label class="rm"><input type="checkbox" name="remember" value="1"> Remember me on this device</label>'
    + '<button type="submit">Sign in</button></form>'
    + '<div id="busy"><div class="card"><div class="spin"></div><p class="t">Signing in…</p><p>Please wait</p></div></div>'
    + '</body></html>';
}

// 2FA 方法选择页（多方法时）+ 零方法错误页。按钮为链接（GET /login/2fa?m=…），
// 票据仍走 COOKIE2 cookie——无需表单。
function chooserPage(next, methods, remember, host, error, enrollMethods) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  const btns = (methods || []).map(function (m) {
    return '<a class="m" href="' + BASE + "/login/2fa?m=" + m + "&next=" + encodeURIComponent(next) + (remember ? "&r=1" : "") + '">'
      + METHOD_LABELS[m] + "</a>";
  }).join("");
  // 零方法时可注册方法的「立即设置」入口（登录时自助注册，§9.1：
  // 仅零方法账户开放——已有方法者必须先过既有因子，防密码窃贼自助加因子）
  const enrolls = (!methods || !methods.length) && enrollMethods && enrollMethods.length
    ? '<p class="hint" style="margin-top:1.2rem">No 2FA yet — set one up now:</p>'
      + enrollMethods.map(function (m) {
        return '<a class="m" href="' + BASE + "/enroll?m=" + m + "&next=" + encodeURIComponent(next) + (remember ? "&r=1" : "") + '">Set up ' + METHOD_LABELS[m] + "</a>";
      }).join("")
    : "";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Two-factor</title>'
    + '<style>*{box-sizing:border-box}body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7;padding:1rem}'
    + 'main{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:22rem}'
    + 'h1{font-size:1.15rem;margin:0 0 .3rem}p.hint{font-size:.85rem;color:#666;margin:0 0 .6rem}'
    + 'p.meta{font-size:.72rem;color:#888;margin:0 0 1rem;line-height:1.6}p.meta b{color:#555}'
    + 'a.m{display:block;padding:.7rem;margin:.5rem 0;border:1px solid #d0d3da;border-radius:8px;color:#2d6cdf;text-decoration:none;font-size:.95rem;text-align:center}'
    + 'a.m:hover{border-color:#2d6cdf;background:#f0f5ff}'
    + '@media(max-width:480px){main{padding:1.5rem 1.25rem}}</style>'
    + '</head><body><main>'
    + '<h1>Two-factor authentication</h1>'
    + '<p class="hint">Choose a second factor to continue.</p>'
    + (SITE || host ? '<p class="meta">Site: <b>' + SITE + '</b><br>Domain: <b>' + escapeAttr(host || "") + '</b></p>' : "")
    + err + btns + enrolls
    + '</main></body></html>';
}

// face 验证页（biometric-2fa-design.md §7.2）：浏览器本地提取 128-d 向量
// （face-api.js + 3 模型从本站 assets 加载，原始画面不出设备），眨眼活体
// 断言（EAR），JSON{nonce,vectors,blinked} 一次性 RSA-OAEP 加密上传。
function facePage(next, error, host, remember, nonce, keyId, publicKey, altMethods, action, extra) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  const formAction = action || BASE + "/login/2fa";
  const alt = altMethods && altMethods.length > 1
    ? '<a class="alt" href="' + BASE + "/login/2fa?next=" + encodeURIComponent(next) + (remember ? "&r=1" : "") + '">Use another method</a>'
    : "";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Face verification</title>'
    + '<script src="' + BASE + '/assets/justget-browser.js?v=' + JGVER + '"></script>'
    + '<style>*{box-sizing:border-box}body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7;padding:1rem}'
    + 'main{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:22rem;text-align:center}'
    + 'h1{font-size:1.15rem;margin:0 0 .3rem}p.hint{font-size:.85rem;color:#666;margin:0 0 .8rem}'
    + 'p.meta{font-size:.72rem;color:#888;margin:0 0 1rem;line-height:1.6}p.meta b{color:#555}'
    + '#cam{position:relative;width:14rem;height:14rem;margin:0 auto;border-radius:50%;overflow:hidden;background:#e8eaee;border:3px solid #d0d3da}'
    + '#cam video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}'
    + 'p.st{font-size:.85rem;color:#444;margin:.9rem 0 .2rem;min-height:1.2em}'
    + '#dots{display:flex;gap:.4rem;justify-content:center;margin:.4rem 0 .2rem}'
    + '#dots i{width:.7rem;height:.7rem;border-radius:50%;background:#d0d3da;display:inline-block}'
    + '#dots i.on{background:#2d6cdf}'
    + 'a.alt{display:inline-block;margin-top:1rem;font-size:.85rem;color:#2d6cdf}'
    + '#busy{position:fixed;inset:0;background:#f4f5f7;display:none;flex-direction:column;align-items:center;justify-content:center;z-index:50}'
    + '#busy .spin{width:2.2rem;height:2.2rem;border:3px solid #d0d3da;border-top-color:#2d6cdf;border-radius:50%;animation:st .8s linear infinite}'
    + '@keyframes st{to{transform:rotate(360deg)}}#busy p{margin-top:1rem;color:#555;font-size:.95rem}'
    + '@media(max-width:480px){main{padding:1.5rem 1.25rem}}</style>'
    + '</head><body><main>'
    + '<h1>Face verification</h1>'
    + '<p class="hint">Look at the camera and open your mouth three times to verify.</p>'
    + (SITE || host ? '<p class="meta">Site: <b>' + SITE + '</b><br>Domain: <b>' + escapeAttr(host || "") + '</b></p>' : "")
    + '<div id="cam"><video id="v" autoplay muted playsinline></video></div>'
    + '<p id="st" class="st">Loading…</p>'
    + '<div id="dots"><i></i><i></i><i></i></div>' + err + alt
    + '<form id="f" method="post" action="' + formAction + '">'
    + '<input type="hidden" name="method" value="face">'
    + '<input type="hidden" name="next" value="' + escapeAttr(next) + '">'
    + (remember ? '<input type="hidden" name="remember" value="1">' : "")
    + (extra || "")
    + '<input type="hidden" name="keyId" id="keyId"><input type="hidden" name="wrapped" id="wrapped"><input type="hidden" name="iv" id="iv"><input type="hidden" name="data" id="data">'
    + '</form><div id="busy"><div class="spin"></div><p>Verifying…</p></div></main>'
    + '<script>'
    + 'var A=' + JSON.stringify(BASE) + ',NONCE=' + JSON.stringify(nonce) + ',PUB=' + JSON.stringify(publicKey) + ',KEY_ID=' + JSON.stringify(keyId) + ';'
    + 'var FACE_CFG=' + JSON.stringify(FACE_CFG) + ';'
    + 'var vectors=[],prevClosed=false,mouthCount=0,base=[],done=false;'
    + 'function st(t){document.getElementById("st").textContent=t;}'
    + 'function loadScript(src){return new Promise(function(res,rej){var s=document.createElement("script");s.src=src;s.onload=res;s.onerror=function(){rej(new Error("script load failed"))};document.head.appendChild(s);});}'
    + 'function jgUrls(f){var u=["https://cdn.jsdelivr.net/npm/@vladmandic/face-api@"+FACE_CFG.ver+"/"+f.npmPath,"https://unpkg.com/@vladmandic/face-api@"+FACE_CFG.ver+"/"+f.npmPath,"https://gitee.com/justdb-mirrors/face-models/releases/download/face-api-"+FACE_CFG.ver+"/"+f.file];return u;}'
    + 'async function loadFaceAssets(){'
    + 'var JG=window.justgetBrowser;'
    + 'if(!JG)throw new Error("racer unavailable");'
    + 'st("Downloading engine…");'
    + 'var a0=FACE_CFG.assets[0];'
    + 'var u0=jgUrls(a0);u0.push(A+"/assets/face-api.js");'
    + 'var r0=await JG.download({url:u0[0],mirrors:u0.slice(1),options:{checksum:a0.sha256,checksumAlgorithm:"sha256",responseType:"uint8array",sizeThreshold:1048576,primaryWarmupTime:3000,onProgress:function(p){st("Engine "+Math.round(p.percentage)+"%");}}});'
    + 'await loadScript(URL.createObjectURL(new Blob([r0.data],{type:"application/javascript"})));'
    + 'st("Downloading models…");'
    + 'var bytes={};'
    + 'var dl=FACE_CFG.assets.slice(1).map(function(a){'
    + 'var mu=jgUrls(a);mu.push(A+"/assets/models/"+a.file);'
    + 'return JG.download({url:mu[0],mirrors:mu.slice(1),options:{checksum:a.sha256,checksumAlgorithm:"sha256",responseType:"uint8array",sizeThreshold:1048576,primaryWarmupTime:3000}}).then(function(r){bytes[a.file]=r.data;});'
    + '});'
    + 'await Promise.all(dl);'
    + 'var of=window.fetch;'
    + 'window.fetch=function(input,init){'
    + 'var q=typeof input==="string"?input:(input&&input.url||"");'
    + 'var n=q.slice(q.lastIndexOf("/")+1);'
    + 'var hit=bytes[n]&&(q.indexOf("/model/")>0||q.indexOf("/assets/models/")>0);'
    + 'if(hit)return Promise.resolve(new Response(bytes[n],{headers:{"Content-Type":n.lastIndexOf(".json")>0?"application/json":"application/octet-stream"}}));'
    + 'return of(input,init);'
    + '};'
    + 'try{'
    + 'var MB="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@"+FACE_CFG.ver+"/model/";'
    + 'await faceapi.tf.ready();'
    + 'await faceapi.nets.tinyFaceDetector.loadFromUri(MB);'
    + 'await faceapi.nets.faceLandmark68Net.loadFromUri(MB);'
    + 'await faceapi.nets.faceRecognitionNet.loadFromUri(MB);'
    + '}finally{window.fetch=of;}'
    + '}'
    + 'async function loadFaceAssetsFallback(){'
    + 'await loadScript(A+"/assets/face-api.js");'
    + 'await faceapi.tf.ready();'
    + 'await faceapi.nets.tinyFaceDetector.loadFromUri(A+"/assets/models/");'
    + 'await faceapi.nets.faceLandmark68Net.loadFromUri(A+"/assets/models/");'
    + 'await faceapi.nets.faceRecognitionNet.loadFromUri(A+"/assets/models/");'
    + '}'
    + 'function dot(){var d=document.querySelectorAll("#dots i");for(var i=0;i<d.length;i++)d[i].className=i<vectors.length?"on":"";}'
    + 'function b2u(b){var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}'
    + 'function u2b(u){var s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s);}'
    + 'function mar(p){function d(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}return (d(p[3],p[11])+d(p[5],p[9]))/(2*d(p[1],p[7]));}'
    + 'async function submitFace(){done=true;document.getElementById("busy").style.display="flex";'
    + 'var payload=JSON.stringify({nonce:NONCE,vectors:vectors,blinked:true});'
    + 'try{'
    + 'var aes=crypto.getRandomValues(new Uint8Array(32));'
    + 'var iv=crypto.getRandomValues(new Uint8Array(12));'
    + 'var ak=await crypto.subtle.importKey("raw",aes,{name:"AES-GCM"},false,["encrypt"]);'
    + 'var ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:iv},ak,new TextEncoder().encode(payload)));'
    + 'var rk=await crypto.subtle.importKey("spki",b2u(atob(PUB)),{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);'
    + 'var wk=new Uint8Array(await crypto.subtle.encrypt({name:"RSA-OAEP"},rk,aes));'
    + 'document.getElementById("wrapped").value=u2b(wk);'
    + 'document.getElementById("iv").value=u2b(iv);'
    + 'document.getElementById("data").value=u2b(ct);'
    + 'document.getElementById("keyId").value=KEY_ID;'
    + 'document.getElementById("f").submit();'
    + '}catch(e){document.getElementById("busy").style.display="none";done=false;st("Encryption failed — retry");}'
    + '}'
    + 'async function loop(){'
    + 'if(done)return;'
    + 'var v=document.getElementById("v");'
    + 'if(v.readyState<2||!v.videoWidth){setTimeout(loop,120);return;}'
    + 'try{'
    + 'var det=await faceapi.detectSingleFace(v,new faceapi.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:0.5})).withFaceLandmarks().withFaceDescriptor();'
    + 'if(det){'
    + 'var m=mar(det.landmarks.getMouth());'
    + 'base.push(m);if(base.length>30)base.shift();'
    + 'var b=base.slice().sort(function(x,y){return x-y;});var q=b[Math.floor(b.length*0.3)]||0.4;var th=Math.max(0.4,q+0.15);'
    + 'var open=m>=th;'
    + 'if(open&&!prevClosed){mouthCount++;vectors.push(Array.from(det.descriptor));dot();}'
    + 'prevClosed=open;'
    + 'st(mouthCount?(mouthCount>=3?"Submitting…":"Captured "+mouthCount+" of 3"):"Open your mouth three times");'
    + 'if(mouthCount>=3){submitFace();return;}'
    + '}else st("No face detected — center your face");'
    + '}catch(err){}'
    + 'setTimeout(loop,60);'
    + '}'
    + '(async function(){'
    + 'try{'
    + 'try{await loadFaceAssets();}catch(e1){await loadFaceAssetsFallback();}'
    + 'st("Starting camera…");'
    + 'var s=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:640}});'
    + 'var v=document.getElementById("v");v.srcObject=s;await v.play();'
    + 'loop();'
    + '}catch(err){st("Camera or models unavailable: "+(err&&err.message?err.message:String(err)));var a=document.querySelector("a.alt");if(a)a.style.display="inline-block";}'
    + '})();'
    + '</script></body></html>';
}

const PAGE_CRYPTO_JS = ${JSON.stringify(PAGE_CRYPTO_JS)};

// voice 验证页（§8.3）：展示随机数字挑战 → 录音 → 浏览器 MFCC 提取 78-d
// → 混合加密上传。录音手动开始/停止（最大 8s），MediaRecorder 采集。
function voicePage(next, error, host, remember, nonce, digits, keyId, publicKey, altMethods) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  const alt = altMethods && altMethods.length > 1
    ? '<a class="alt" href="' + BASE + "/login/2fa?next=" + encodeURIComponent(next) + (remember ? "&r=1" : "") + '">Use another method</a>'
    : "";
  const disp = String(digits).split("").join(" ");
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Voice verification</title>'
    + '<style>*{box-sizing:border-box}body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7;padding:1rem}'
    + 'main{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:24rem;text-align:center}'
    + 'h1{font-size:1.15rem;margin:0 0 .3rem}p.hint{font-size:.85rem;color:#666;margin:0 0 .8rem}'
    + 'p.meta{font-size:.72rem;color:#888;margin:0 0 1rem;line-height:1.6}p.meta b{color:#555}'
    + '#digits{font-size:2.2rem;letter-spacing:.35em;font-weight:600;color:#222;margin:.6rem 0 1rem}'
    + 'button{padding:.6rem 1.2rem;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer;font-size:.95rem;margin:0 .3rem}'
    + 'button.sec{background:#eef2fb;color:#2d6cdf}'
    + 'button:disabled{opacity:.5;cursor:default}'
    + 'p.st{font-size:.85rem;color:#444;margin:.9rem 0 .2rem;min-height:1.2em}'
    + 'a.alt{display:inline-block;margin-top:1rem;font-size:.85rem;color:#2d6cdf}'
    + '#busy{position:fixed;inset:0;background:#f4f5f7;display:none;flex-direction:column;align-items:center;justify-content:center;z-index:50}'
    + '#busy .spin{width:2.2rem;height:2.2rem;border:3px solid #d0d3da;border-top-color:#2d6cdf;border-radius:50%;animation:st .8s linear infinite}'
    + '@keyframes st{to{transform:rotate(360deg)}}#busy p{margin-top:1rem;color:#555;font-size:.95rem}'
    + '@media(max-width:480px){main{padding:1.5rem 1.25rem}}</style>'
    + '</head><body><main>'
    + '<h1>Voice verification</h1>'
    + '<p class="hint">Read the digits aloud, then stop recording.</p>'
    + (SITE || host ? '<p class="meta">Site: <b>' + SITE + '</b><br>Domain: <b>' + escapeAttr(host || "") + '</b></p>' : "")
    + '<div id="digits">' + escapeAttr(disp) + '</div>'
    + '<button id="rec">Record</button><button id="stop" class="sec" disabled>Stop</button>'
    + '<p id="st" class="st"></p>' + err + alt
    + '<form id="f" method="post" action="' + BASE + '/login/2fa">'
    + '<input type="hidden" name="method" value="voice">'
    + '<input type="hidden" name="next" value="' + escapeAttr(next) + '">'
    + (remember ? '<input type="hidden" name="remember" value="1">' : "")
    + '<input type="hidden" name="keyId" id="keyId"><input type="hidden" name="wrapped" id="wrapped"><input type="hidden" name="iv" id="iv"><input type="hidden" name="data" id="data">'
    + '</form><div id="busy"><div class="spin"></div><p>Verifying…</p></div></main>'
    + '<script>' + PAGE_CRYPTO_JS
    + 'var A=' + JSON.stringify(BASE) + ',NONCE=' + JSON.stringify(nonce) + ',PUB=' + JSON.stringify(publicKey) + ',KEY_ID=' + JSON.stringify(keyId) + ';'
    + 'function st(t){document.getElementById("st").textContent=t;}'
    + 'var rec=null,chunks=[],busy=false,vec=null;'
    + 'document.getElementById("rec").onclick=async function(){'
    + 'if(busy)return;try{'
    + 'var s=await navigator.mediaDevices.getUserMedia({audio:true});'
    + 'rec=new MediaRecorder(s);chunks=[];'
    + 'rec.ondataavailable=function(e){if(e.data.size)chunks.push(e.data);};'
    + 'rec.onstop=async function(){'
    + 's.getTracks().forEach(function(t){t.stop();});'
    + 'st("Extracting voice features…");'
    + 'try{vec=await extractVoiceVector(new Blob(chunks,{type:rec.mimeType}));}catch(e){vec=null;}'
    + 'if(!vec){st("Recording too short — try again");enable(true);return;}'
    + 'document.getElementById("busy").style.display="flex";'
    + 'try{'
    + 'var f=await hybridEncrypt(PUB,KEY_ID,JSON.stringify({nonce:NONCE,vector:vec}));'
    + 'for(var k in f)document.getElementById(k).value=f[k];'
    + 'document.getElementById("f").submit();'
    + '}catch(e){document.getElementById("busy").style.display="none";st("Encryption failed — retry");enable(true);}'
    + '};'
    + 'rec.start();busy=true;enable(false);st("Recording… read the digits");'
    + 'setTimeout(function(){if(rec&&rec.state==="recording")rec.stop();},8000);'
    + '}catch(err){st("Microphone unavailable: "+(err&&err.message?err.message:String(err)));}'
    + '};'
    + 'document.getElementById("stop").onclick=function(){if(rec&&rec.state==="recording")rec.stop();};'
    + 'function enable(on){document.getElementById("rec").disabled=!on;document.getElementById("stop").disabled=on;busy=!on;}'
    + '</script></body></html>';
}

// voice 注册页（3 轮数字挑战）：每轮录音→提取 78-d；3 轮统一提交 /enroll
// （rounds:[{nonce,vector}×3]）。登录时路径靠 cookie，票路径带 t。
function enrollVoicePage(next, error, host, remember, keyId, publicKey, ch1, ticket, action, altMethods) {
  const err = error ? '<p style="color:#c0392b">' + error + "</p>" : "";
  const T = ticket ? JSON.stringify(ticket) : "";
  const alt = altMethods && altMethods.length > 1
    ? '<a class="alt" href="' + BASE + "/login/2fa?next=" + encodeURIComponent(next) + (remember ? "&r=1" : "") + '">Use another method</a>'
    : "";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Voice setup</title>'
    + '<style>*{box-sizing:border-box}body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7;padding:1rem}'
    + 'main{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:24rem;text-align:center}'
    + 'h1{font-size:1.15rem;margin:0 0 .3rem}p.hint{font-size:.85rem;color:#666;margin:0 0 .8rem}'
    + '#digits{font-size:2rem;letter-spacing:.3em;font-weight:600;color:#222;margin:.6rem 0 1rem}'
    + 'button{padding:.6rem 1.2rem;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer;font-size:.95rem;margin:0 .3rem}'
    + 'button.sec{background:#eef2fb;color:#2d6cdf}button:disabled{opacity:.5;cursor:default}'
    + 'p.st{font-size:.85rem;color:#444;margin:.9rem 0 .2rem;min-height:1.2em}'
    + 'a.alt{display:inline-block;margin-top:1rem;font-size:.85rem;color:#2d6cdf}'
    + '#dots{display:flex;gap:.4rem;justify-content:center;margin:.4rem 0 .2rem}'
    + '#dots i{width:.7rem;height:.7rem;border-radius:50%;background:#d0d3da;display:inline-block}'
    + '#dots i.on{background:#2d6cdf}'
    + '#busy{position:fixed;inset:0;background:#f4f5f7;display:none;flex-direction:column;align-items:center;justify-content:center;z-index:50}'
    + '#busy .spin{width:2.2rem;height:2.2rem;border:3px solid #d0d3da;border-top-color:#2d6cdf;border-radius:50%;animation:st .8s linear infinite}'
    + '@keyframes st{to{transform:rotate(360deg)}}#busy p{margin-top:1rem;color:#555;font-size:.95rem}'
    + '@media(max-width:480px){main{padding:1.5rem 1.25rem}}</style>'
    + '</head><body><main>'
    + '<h1>Voice 2FA setup</h1>'
    + '<p class="hint">Record 3 readings of random digits.</p>'
    + '<div id="digits"></div>'
    + '<button id="rec">Record</button><button id="stop" class="sec" disabled>Stop</button>'
    + '<p id="st" class="st"></p>'
    + '<div id="dots"><i></i><i></i><i></i></div>' + err + alt
    + '<form id="f" method="post" action="' + action + '">'
    + '<input type="hidden" name="method" value="voice">'
    + '<input type="hidden" name="next" value="' + escapeAttr(next) + '">'
    + (T ? '<input type="hidden" name="t" value="' + escapeAttr(T) + '">' : "")
    + (remember ? '<input type="hidden" name="remember" value="1">' : "")
    + '<input type="hidden" name="keyId" id="keyId"><input type="hidden" name="wrapped" id="wrapped"><input type="hidden" name="iv" id="iv"><input type="hidden" name="data" id="data">'
    + '</form><div id="busy"><div class="spin"></div><p>Saving…</p></div></main>'
    + '<script>' + PAGE_CRYPTO_JS
    + 'var A=' + JSON.stringify(BASE) + ',PUB=' + JSON.stringify(publicKey) + ',KEY_ID=' + JSON.stringify(keyId) + ',T=' + T + ';'
    + 'var rounds=[],cur=' + JSON.stringify(ch1) + ',busy=false;'
    + 'function st(t){document.getElementById("st").textContent=t;}'
    + 'function showCh(){document.getElementById("digits").textContent=String(cur.digits).split("").join(" ");'
    + 'var d=document.querySelectorAll("#dots i");for(var i=0;i<d.length;i++)d[i].className=i<rounds.length?"on":"";}'
    + 'showCh();'
    + 'var curRec=null;'
    + 'document.getElementById("rec").onclick=async function(){'
    + 'if(busy)return;try{'
    + 'var s=await navigator.mediaDevices.getUserMedia({audio:true});'
    + 'curRec=new MediaRecorder(s);var chunks=[];'
    + 'curRec.ondataavailable=function(e){if(e.data.size)chunks.push(e.data);};'
    + 'var rec=curRec;'
    + 'rec.onstop=async function(){'
    + 's.getTracks().forEach(function(t){t.stop();});'
    + 'st("Extracting…");'
    + 'var v=null;try{v=await extractVoiceVector(new Blob(chunks,{type:rec.mimeType}));}catch(e){}'
    + 'if(!v){st("Too short — try again");enable(true);return;}'
    + 'rounds.push({nonce:cur.nonce,vector:v});'
    + 'if(rounds.length>=3){await submitRounds();return;}'
    + 'try{var r=await fetch(A+"/enroll/challenge?m=voice"+(T?"&t="+encodeURIComponent(T):""),{credentials:"include"});'
    + 'var j=await r.json();if(!j.nonce){st("Challenge failed — reload");return;}cur=j;showCh();'
    + 'st("Reading "+(rounds.length+1)+" of 3");enable(true);'
    + '}catch(e){st("Network error — reload");}'
    + '};'
    + 'rec.start();busy=true;enable(false);st("Recording… read the digits");'
    + 'setTimeout(function(){if(rec.state==="recording")rec.stop();},8000);'
    + '}catch(err){st("Microphone unavailable: "+(err&&err.message?err.message:String(err)));}'
    + '};'
    + 'document.getElementById("stop").onclick=function(){if(curRec&&curRec.state==="recording")curRec.stop();};'
    + 'function enable(on){document.getElementById("rec").disabled=!on;document.getElementById("stop").disabled=on;busy=!on;}'
    + 'async function submitRounds(){document.getElementById("busy").style.display="flex";'
    + 'try{'
    + 'var f=await hybridEncrypt(PUB,KEY_ID,JSON.stringify({rounds:rounds}));'
    + 'for(var k in f)document.getElementById(k).value=f[k];'
    + 'document.getElementById("f").submit();'
    + '}catch(e){document.getElementById("busy").style.display="none";st("Encryption failed — retry");enable(true);}'
    + '}'
    + '</script></body></html>';
}

// 注册完成页（票路径）：采集页独立窗口直接关闭即可
function enrollDonePage(method) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Done</title>'
    + '<style>body{font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center;background:#f4f5f7}main{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}p{color:#555}</style>'
    + '</head><body><main><h1>\u2705 ' + (method === "face" ? "Face" : "Voice") + ' 2FA activated</h1>'
    + '<p>You can close this tab and sign in with your ' + (method === "face" ? "face" : "voice") + '.</p></main></body></html>';
}

/** 登录后跳转目标白名单：仅本站相对路径（以 / 开头且非 // 协议相对）。
 *  next 来自 URL 参数——不校验则 https://portal/login?next=https://evil.com
 *  登录成功即开放跳转（钓鱼）。 */
function safeNext(next) {
  // charCode 判断避免模板转义（server.mjs 生成走模板字符串，字面反斜杠会被
  // 转义破坏）：拒绝协议相对（//）与 Windows 变体（/\\）开头的跳转。
  if (typeof next !== "string" || next.charCodeAt(0) !== 47 || next.charCodeAt(1) === 47 || next.charCodeAt(1) === 92) return DEPLOY || "/";
  return next;
}

function setSession(res, name, next, cookieName = COOKIE, ttl = TTL_MS, twoFactorAt = 0, initial = false) {
  const token = issueSession(name, cookieName, ttl, twoFactorAt, initial);
  res.writeHead(302, {
    Location: safeNext(next),
    "Set-Cookie": cookieName + "=" + token + "; Path=/; HttpOnly; SameSite=Strict"
      + (SECURE ? "; Secure" : ""),
  });
  res.end();
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ip = clientIp(req);

  if (url.pathname === BASE + "/api/authz/auth-request" && req.method === "GET") {
    const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim())
      .find((c) => c.startsWith(COOKIE + "="));
    const sess = cookie ? verifySession(cookie.slice(COOKIE.length + 1)) : null;
    // 先查会话:未登录一律 401(启动探测依赖此);deny 策略在会话校验之后才 403
    if (!sess) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    // break-glass 初始会话：站点一旦出现任意真实用户即作废（严格保证期间没有
    // 真实用户）；未作废时豁免 2FA（初始用户不验证 2FA）。
    if (sess.initial && siteHasUsers()) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("initial session expired — site now has users");
      return;
    }
    const policy = hostPolicy((req.headers.host || "").split(":")[0]);
    if (policy === "deny") {
      // 已登录也拒绝(策略级拒绝)——gateway 403 直达,不再 302 登录页
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("denied by policy");
      return;
    }
    if (policy === "two_factor" && !sess.initial && (!sess.twoFactorAt || Date.now() - sess.twoFactorAt > GRACE_MS)) {
      // 2FA 复验周期（remember me 可信设备）：周期外一律 401——nginx 302 回
      // 登录页后，GET /login 识别“会话有效但 2FA 过期”直接放行到 2FA 步骤页
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("2fa required");
      return;
    }
    // ?who=1：登录信息按钮数据源（JSON 回显本会话用户名/displayName/provider
    // /登出 URL——用户名不进注入 HTML（防 XSS），由按钮 JS 运行时取此端点）。
    if (url.searchParams.get("who") === "1") {
      const users = loadUsers();
      const rec = users[sess.name];
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        user: sess.name,
        displayName: (rec && rec.displayName) || sess.name,
        provider: "portal",
        logoutUrl: BASE + "/logout?next=" + encodeURIComponent(url.searchParams.get("next") || DEPLOY || "/"),
      }));
      return;
    }
    res.writeHead(200, { "X-St-Auth-User": sess.name });
    res.end("ok");
    return;
  }

  // 登出（登录信息按钮「退出登录」目标）：清主会话 + 2FA 中间票，回登录页。
  // GET 可接受（登出只作用于请求者自己的会话，业界通行如 authelia）。
  if (url.pathname === BASE + "/logout" && req.method === "GET") {
    const next = url.searchParams.get("next") || DEPLOY || "/";
    res.writeHead(302, {
      Location: BASE + "/login?next=" + encodeURIComponent(next),
      "Set-Cookie": [
        COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + (SECURE ? "; Secure" : ""),
        COOKIE2 + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + (SECURE ? "; Secure" : ""),
      ].join(", "),
    });
    res.end();
    return;
  }

  if (url.pathname === BASE + "/login" && req.method === "GET") {
    const next = url.searchParams.get("next") || DEPLOY || "/";
    // remember me（可信设备）复验路径：会话有效但 2FA 复验周期已过 → 跳过
    // 密码、直接发 COOKIE2 票据进 2FA 步骤页；会话完全满足策略 → 直达 next。
    // remember 属性延续：旧会话剩余寿命 > TTL_MS → 原本是 remember 会话。
    const sc = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE + "="));
    const sess = sc ? verifySession(sc.slice(COOKIE.length + 1)) : null;
    if (sess && !(sess.initial && siteHasUsers())) {
      const policy = hostPolicy((req.headers.host || "").split(":")[0]);
      if (policy === "two_factor") {
        // break-glass 初始会话：不验证 2FA（站点无用户时直接 next）
        if (sess.initial) {
          res.writeHead(302, { Location: safeNext(next) });
          res.end();
          return;
        }
        if (!sess.twoFactorAt || Date.now() - sess.twoFactorAt > GRACE_MS) {
          const tmp = issueSession(sess.name, COOKIE2, 5 * 60_000);
          const remember = sess.expiry - Date.now() > TTL_MS;
          res.writeHead(302, {
            Location: BASE + "/login/2fa?next=" + encodeURIComponent(next) + (remember ? "&r=1" : ""),
            "Set-Cookie": COOKIE2 + "=" + tmp + "; Path=/; HttpOnly; SameSite=Strict" + (SECURE ? "; Secure" : ""),
          });
          res.end();
          return;
        }
        res.writeHead(302, { Location: safeNext(next) });
        res.end();
        return;
      }
    }
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
      // 恒时比对：用户不存在时也执行一次 scrypt（DUMMY_SALT/HASH 同为 64 字节
      // scrypt 派生，成本一致）——neither 报错路径可被时间差区分用户是否存在。
      const salt = rec ? rec.salt : DUMMY_SALT;
      const expect = Buffer.from(rec ? rec.hash : DUMMY_HASH, "hex");
      const got = scryptSync(password, salt, 64);
      const bad = expect.length !== got.length || !timingSafeEqual(expect, got);
      // break-glass 初始用户：仅当站点 0 个真实用户 + 用户名/密码匹配才放行
      // （不入库、不验证 2FA）。站点一旦出现任意真实用户即无效。
      if (bad && INITIAL_USER && name === INITIAL_USER && !siteHasUsers()) {
        const e = Buffer.from(INITIAL_HASH, "hex");
        const g = scryptSync(password, INITIAL_SALT, e.length);
        if (e.length === g.length && timingSafeEqual(e, g)) {
          clearFailures(name, ip);
          // initial 标记会话：authz 侧站点出现用户即 401 作废
          setSession(res, name, next, COOKIE, TTL_MS, 0, true);
          return;
        }
      }
      if (bad) {
        recordFailure(name, ip);
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(html(next, "Invalid username or password.", undefined, undefined, req.headers.host || ""));
        return;
      }
      clearFailures(name, ip);
      // 2FA 方法选择（biometric-2fa-design.md §6）：0 个方法 & 非 two_factor
      // → 1FA 会话（remember 不延长弱会话）；0 个 & two_factor → 错误页；
      // 1 个 → 直达方法页；多个 → chooser。票据固定 5 分钟，remember 随
      // 隐藏字段透传到最终 setSession。
      const policy = hostPolicy((req.headers.host || "").split(":")[0]);
      const methods = availableMethods(name, rec);
      const remember = params.get("remember") === "1";
      if (!methods.length && policy !== "two_factor") {
        setSession(res, name, next); // 1FA：默认 TTL（remember 不适用）
        return;
      }
      const tmp = issueSession(name, COOKIE2, 5 * 60_000);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": COOKIE2 + "=" + tmp + "; Path=/; HttpOnly; SameSite=Strict" + (SECURE ? "; Secure" : ""),
      });
      if (!methods.length) {
        const em = FACE_ENABLED && VOICE_ENABLED ? ["face", "voice"] : FACE_ENABLED ? ["face"] : VOICE_ENABLED ? ["voice"] : [];
        res.end(chooserPage(next, [], remember, req.headers.host || "", em.length ? "" : "2FA is required for this host, but this account has no 2FA method enrolled.", em));
      } else if (methods.length === 1 && methods[0] === "totp") {
        res.end(totpPage(next, "", req.headers.host || "", remember, methods));
      } else if (methods.length === 1 && methods[0] === "face") {
        const { keyId, publicKey } = issueRsaKey();
        res.end(facePage(next, "", req.headers.host || "", remember, issueFaceChallenge(name), keyId, publicKey, methods));
      } else if (methods.length === 1 && methods[0] === "voice") {
        const { keyId, publicKey } = issueRsaKey();
        const ch = issueVoiceChallenge(name);
        res.end(voicePage(next, "", req.headers.host || "", remember, ch.nonce, ch.digits, keyId, publicKey, methods));
      } else {
        res.end(chooserPage(next, methods, remember, req.headers.host || ""));
      }
      return;
    });
    return;
  }

  // 2FA step page: GET renders（chooser / 单方法直达，免密码复验路径也走这）
  if (url.pathname === BASE + "/login/2fa" && req.method === "GET") {
    const next = url.searchParams.get("next") || DEPLOY || "/";
    const m = url.searchParams.get("m") || "";
    const remember = url.searchParams.get("r") === "1";
    const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim())
      .find((c) => c.startsWith(COOKIE2 + "="));
    const sess2 = cookie ? verifySession(cookie.slice(COOKIE2.length + 1), COOKIE2) : null;
    if (!sess2) {
      // 票据缺失/过期 → 回密码页（正常登录流程从 POST /login 直出方法页，
      // 不经此分支）
      res.writeHead(302, { Location: BASE + "/login?next=" + encodeURIComponent(next) });
      res.end();
      return;
    }
    const users = loadUsers();
    const methods = availableMethods(sess2.name, users[sess2.name]);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (!methods.length) {
      res.end(chooserPage(next, [], remember, req.headers.host || "", "2FA is required, but this account has no 2FA method enrolled."));
      return;
    }
    const method = methods.includes(m) ? m : (methods.length === 1 ? methods[0] : "");
    if (method === "totp") {
      res.end(totpPage(next, "", req.headers.host || "", remember, methods));
    } else if (method === "face") {
      const { keyId, publicKey } = issueRsaKey();
      res.end(facePage(next, "", req.headers.host || "", remember, issueFaceChallenge(sess2.name), keyId, publicKey, methods));
    } else if (method === "voice") {
      const { keyId, publicKey } = issueRsaKey();
      const ch = issueVoiceChallenge(sess2.name);
      res.end(voicePage(next, "", req.headers.host || "", remember, ch.nonce, ch.digits, keyId, publicKey, methods));
    } else {
      // 多方法未选 → chooser（附带零方法时的「立即设置」入口）
      const em = (!methods.length && FACE_ENABLED) || (!methods.length && VOICE_ENABLED)
        ? (FACE_ENABLED && VOICE_ENABLED ? ["face", "voice"] : FACE_ENABLED ? ["face"] : ["voice"]) : [];
      res.end(chooserPage(next, methods, remember, req.headers.host || "", "", em));
    }
    return;
  }

  // 2FA verify: POST /login/2fa，body 带 method 区分（缺省 totp，向后兼容）
  if (url.pathname === BASE + "/login/2fa" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const next = params.get("next") || DEPLOY || "/";
      const method = params.get("method") || "totp";
      const remember = params.get("remember") === "1";
      const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim())
        .find((c) => c.startsWith(COOKIE2 + "="));
      const sess2 = cookie ? verifySession(cookie.slice(COOKIE2.length + 1), COOKIE2) : null;
      const name = sess2 ? sess2.name : null;
      if (!name) {
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(totpPage(next, "Session expired — please sign in again.", req.headers.host || "", false, []));
        return;
      }
      if (method === "face") {
        // 人脸第二因子（biometric-2fa-design.md §7.3/§7.4）：一次性 RSA 解密
        // payload → nonce 单次消费 → 向量形状校验 → 阈值匹配（L2 距离）。
        // 眨眼断言是客户端证据（v1 已知残余风险，锁定更严：3 次/15min）。
        if (!FACE_ENABLED) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(chooserPage(next, availableMethods(name, loadUsers()[name]), remember, req.headers.host || "", "Face verification is not enabled on this portal."));
          return;
        }
        const bannedUntil = banState("bio-face:" + name, ip);
        if (bannedUntil > Date.now()) {
          res.writeHead(429, {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": String(Math.ceil((bannedUntil - Date.now()) / 1000)),
          });
          const { keyId: k429, publicKey: p429 } = issueRsaKey();
          res.end(facePage(next, "Too many failed attempts — face verification is temporarily locked.", req.headers.host || "", remember, issueFaceChallenge(name), k429, p429, ["face"]));
          return;
        }
        const keyId = params.get("keyId") || "";
        const wrapped = params.get("wrapped") || "";
        const iv = params.get("iv") || "";
        const dataB64 = params.get("data") || "";
        let data = null;
        if (wrapped && iv && dataB64 && keyId) {
          try {
            data = JSON.parse(decryptHybrid(keyId, wrapped, iv, dataB64));
          } catch {
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            const { keyId: k1, publicKey: p1 } = issueRsaKey();
            res.end(facePage(next, "Session expired — please reload and try again.", req.headers.host || "", remember, issueFaceChallenge(name), k1, p1, ["face"]));
            return;
          }
        }
        cleanupFaceChallenges();
        const ch = data && typeof data.nonce === "string" ? faceChallenges.get(data.nonce) : undefined;
        if (data && typeof data.nonce === "string") faceChallenges.delete(data.nonce);
        const vectors = data && Array.isArray(data.vectors) ? data.vectors : [];
        const vecOk =
          ch && ch.name === name && ch.expires > Date.now() && data && data.blinked === true &&
          vectors.length >= 1 && vectors.length <= 5 &&
          vectors.every((v) => Array.isArray(v) && v.length === 128 && v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1.0001));
        const tplRec = loadTemplates()[name];
        const face = tplRec && tplRec.face && tplRec.face.status === "active" ? tplRec.face : null;
        const th = (face && face.threshold) || FACE_THRESHOLD;
        const d = vecOk && face ? faceDistance(face.vectors, vectors) : Infinity;
        if (!vecOk || !face || d > th) {
          recordFailure("bio-face:" + name, ip, 3); // 比密码更严：3 次封禁 15min
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          const { keyId: k2, publicKey: p2 } = issueRsaKey();
          res.end(facePage(
            next,
            !vecOk ? "Verification failed — open your mouth at the camera and retry." : !face ? "No active face template for this account." : "Face not recognized (distance " + d.toFixed(2) + " > " + th + ").",
            req.headers.host || "", remember, issueFaceChallenge(name), k2, p2, availableMethods(name, loadUsers()[name]),
          ));
          return;
        }
        clearFailures("bio-face:" + name, ip);
        setSession(res, name, next, COOKIE, remember ? REMEMBER_TTL_MS : TTL_MS, Date.now());
        return;
      }
      if (method === "voice") {
        // 语音第二因子（§8.3）：nonce 单次消费 + 数字挑战 + 78-d 向量余弦匹配。
        // 注：不校验读出内容（v1 限制，§8.4）——锁定 3 次/15min 与 face 同严。
        if (!VOICE_ENABLED) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(chooserPage(next, availableMethods(name, loadUsers()[name]), remember, req.headers.host || "", "Voice verification is not enabled on this portal."));
          return;
        }
        const bannedUntil = banState("bio-voice:" + name, ip);
        if (bannedUntil > Date.now()) {
          res.writeHead(429, {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": String(Math.ceil((bannedUntil - Date.now()) / 1000)),
          });
          const { keyId: k429, publicKey: p429 } = issueRsaKey();
          const ch429 = issueVoiceChallenge(name);
          res.end(voicePage(next, "Too many failed attempts — voice verification is temporarily locked.", req.headers.host || "", remember, ch429.nonce, ch429.digits, k429, p429, ["voice"]));
          return;
        }
        const keyId = params.get("keyId") || "";
        const wrapped = params.get("wrapped") || "";
        const iv = params.get("iv") || "";
        const dataB64 = params.get("data") || "";
        let data = null;
        if (wrapped && iv && dataB64 && keyId) {
          try {
            data = JSON.parse(decryptHybrid(keyId, wrapped, iv, dataB64));
          } catch {
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            const { keyId: k1, publicKey: p1 } = issueRsaKey();
            const ch1 = issueVoiceChallenge(name);
            res.end(voicePage(next, "Session expired — please reload and try again.", req.headers.host || "", remember, ch1.nonce, ch1.digits, k1, p1, ["voice"]));
            return;
          }
        }
        cleanupVoiceChallenges();
        const ch = data && typeof data.nonce === "string" ? voiceChallenges.get(data.nonce) : undefined;
        if (data && typeof data.nonce === "string") voiceChallenges.delete(data.nonce);
        const vecOk = ch && ch.name === name && ch.expires > Date.now() && validVoiceVec(data ? data.vector : null);
        const tplRec = loadTemplates()[name];
        const voice = tplRec && tplRec.voice && tplRec.voice.status === "active" ? tplRec.voice : null;
        const th = (voice && voice.threshold) || VOICE_THRESHOLD;
        const sim = vecOk && voice ? voiceSimilarity(voice.vectors, [data.vector]) : -1;
        if (!vecOk || !voice || sim < th) {
          recordFailure("bio-voice:" + name, ip, 3);
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          const { keyId: k2, publicKey: p2 } = issueRsaKey();
          const ch2 = issueVoiceChallenge(name);
          res.end(voicePage(
            next,
            !vecOk ? "Verification failed — record the digits and retry." : !voice ? "No active voice template for this account." : "Voice not recognized (similarity " + sim.toFixed(2) + " < " + th + ").",
            req.headers.host || "", remember, ch2.nonce, ch2.digits, k2, p2, availableMethods(name, loadUsers()[name]),
          ));
          return;
        }
        clearFailures("bio-voice:" + name, ip);
        setSession(res, name, next, COOKIE, remember ? REMEMBER_TTL_MS : TTL_MS, Date.now());
        return;
      }
      if (method !== "totp") {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(chooserPage(next, availableMethods(name, loadUsers()[name]), remember, req.headers.host || "", "Unknown 2FA method."));
        return;
      }
      const users = loadUsers();
      const rec = users[name];
      if (!rec || !rec.totpSecret || !verifyTotp(rec.totpSecret, params.get("code") || "")) {
        recordFailure(name, ip);
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(totpPage(next, "Invalid code.", req.headers.host || "", remember, availableMethods(name, rec)));
        return;
      }
      clearFailures(name, ip);
      // 2FA 完成会话：remember → 365d（可配）否则默认 TTL；twoFactorAt=now
      // 供探针按 GRACE_MS 复验（免密码直跳 2FA 页的周期也由此重新起算）
      setSession(res, name, next, COOKIE, remember ? REMEMBER_TTL_MS : TTL_MS, Date.now());
    });
    return;
  }

  // —— 生物识别注册采集页（§9.1 两条路径）————————————
  // GET /enroll?m=face|voice[&t=<票>][&next=][&r=1]
  //   票路径：父进程 biometricEnrollTicket 的 HMAC 票（预设置，管理 UI 开链接）
  //   cookie 路径：登录中 2FA 票据 + **零方法账户**（登录时自助注册；已有方法
  //   者必须先过既有因子——防密码窃贼自助加因子），并续签 5 分钟给采集留时间
  function enrollAuth(url2) {
    const t = url2.searchParams.get("t") || "";
    if (t) {
      const d = verifyEnrollTicket(t);
      if (!d) return null;
      return { via: "ticket", name: d.n, method: d.m, token: t };
    }
    const c = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(COOKIE2 + "="));
    const s2 = c ? verifySession(c.slice(COOKIE2.length + 1), COOKIE2) : null;
    if (!s2) return null;
    return { via: "cookie", name: s2.name, method: "", token: "" };
  }

  if (url.pathname === BASE + "/enroll" && req.method === "GET") {
    const next = url.searchParams.get("next") || DEPLOY || "/";
    const remember = url.searchParams.get("r") === "1";
    const m = url.searchParams.get("m") || "";
    const auth = enrollAuth(url);
    if (!auth) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(chooserPage(next, [], remember, req.headers.host || "", "Enrollment link expired — start again from sign-in."));
      return;
    }
    const method = auth.via === "ticket" ? auth.method : m;
    const enabled = method === "face" ? FACE_ENABLED : method === "voice" ? VOICE_ENABLED : false;
    if (!enabled) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(chooserPage(next, [], remember, req.headers.host || "", method + " enrollment is not enabled on this portal."));
      return;
    }
    // cookie 路径只允许零方法账户（否则拒绝，引导走既有因子）
    if (auth.via === "cookie") {
      const methods = availableMethods(auth.name, loadUsers()[auth.name]);
      if (methods.length) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(chooserPage(next, methods, remember, req.headers.host || "", "This account already has 2FA — verify with an existing method first."));
        return;
      }
      // 续签票据（采集耗时长于 5 分钟初始票据）
      const tmp = issueSession(auth.name, COOKIE2, 5 * 60_000);
      res.setHeader("Set-Cookie", COOKIE2 + "=" + tmp + "; Path=/; HttpOnly; SameSite=Strict" + (SECURE ? "; Secure" : ""));
    }
    const { keyId, publicKey } = issueRsaKey();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    // 切换方法链接：把全部启用方法传给页面（无摄像头/麦克风时回 chooser 换一种）
    const alt = (FACE_ENABLED && VOICE_ENABLED ? ["face", "voice"] : FACE_ENABLED ? ["face"] : VOICE_ENABLED ? ["voice"] : []);
    if (method === "face") {
      const extra = auth.token ? '<input type="hidden" name="t" value="' + escapeAttr(auth.token) + '">' : "";
      res.end(facePage(next, "", req.headers.host || "", remember, issueFaceChallenge(auth.name), keyId, publicKey, alt, BASE + "/enroll", extra));
    } else {
      const ch1 = issueVoiceChallenge(auth.name);
      res.end(enrollVoicePage(next, "", req.headers.host || "", remember, keyId, publicKey, ch1, auth.via === "ticket" ? auth.token : "", BASE + "/enroll", alt));
    }
    return;
  }

  // 注册页后续轮次的挑战（voice 第 2/3 轮；cookie 或票任一鉴权）
  if (url.pathname === BASE + "/enroll/challenge" && req.method === "GET") {
    const auth = enrollAuth(url);
    if (!auth) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "expired" }));
      return;
    }
    const ch = issueVoiceChallenge(auth.name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nonce: ch.nonce, digits: ch.digits }));
    return;
  }

  // POST /enroll：混合加密载荷写入 active 模板（现场采集 = 天然首验：样本即
  // 模板本身，质量门代替 first-verify）。cookie 路径成功即登录（.2fa 会话）。
  if (url.pathname === BASE + "/enroll" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const next = params.get("next") || DEPLOY || "/";
      const remember = params.get("remember") === "1";
      const method = params.get("method") || "";
      const t = params.get("t") || "";
      let auth = null;
      if (t) {
        const d = verifyEnrollTicket(t);
        if (d) auth = { via: "ticket", name: d.n, method: d.m, token: t };
      } else {
        const c = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(COOKIE2 + "="));
        const s2 = c ? verifySession(c.slice(COOKIE2.length + 1), COOKIE2) : null;
        if (s2) auth = { via: "cookie", name: s2.name, method: "", token: "" };
      }
      if (!auth || (auth.via === "ticket" && auth.method !== method)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(chooserPage(next, [], remember, req.headers.host || "", "Enrollment link expired — start again."));
        return;
      }
      if (auth.via === "cookie" && availableMethods(auth.name, loadUsers()[auth.name]).length) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(chooserPage(next, [], remember, req.headers.host || "", "This account already has 2FA — verify with an existing method first."));
        return;
      }
      const { keyId, publicKey } = issueRsaKey();
      const fail = (msg, m) => {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        const alt = (FACE_ENABLED && VOICE_ENABLED ? ["face", "voice"] : FACE_ENABLED ? ["face"] : VOICE_ENABLED ? ["voice"] : []);
        if (m === "face") {
          res.end(facePage(next, msg, req.headers.host || "", remember, issueFaceChallenge(auth.name), keyId, publicKey, alt, BASE + "/enroll", auth.token ? '<input type="hidden" name="t" value="' + escapeAttr(auth.token) + '">' : ""));
        } else {
          const ch1 = issueVoiceChallenge(auth.name);
          res.end(enrollVoicePage(next, msg, req.headers.host || "", remember, keyId, publicKey, ch1, auth.via === "ticket" ? auth.token : "", BASE + "/enroll", alt));
        }
      };
      // 解密载荷（混合加密，§7.2）
      const dk = params.get("keyId") || "";
      const dw = params.get("wrapped") || "";
      const di = params.get("iv") || "";
      const dd = params.get("data") || "";
      let data = null;
      try {
        if (dk && dw && di && dd) data = JSON.parse(decryptHybrid(dk, dw, di, dd));
      } catch {
        data = null;
      }
      if (!data) {
        fail("Session expired — please reload and try again.", method);
        return;
      }
      const name = auth.name;
      const tpl = loadTemplates();
      if (method === "face") {
        cleanupFaceChallenges();
        const ch = typeof data.nonce === "string" ? faceChallenges.get(data.nonce) : undefined;
        if (typeof data.nonce === "string") faceChallenges.delete(data.nonce);
        const vectors = Array.isArray(data.vectors) ? data.vectors : [];
        const ok = ch && ch.name === name && ch.expires > Date.now() && data.blinked === true &&
          vectors.length >= 3 && vectors.length <= 5 &&
          vectors.every(function (v) { return Array.isArray(v) && v.length === 128 && v.every(function (x) { return typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1.0001; }); });
        if (!ok) {
          fail("Capture failed — open your mouth at the camera and retry.", "face");
          return;
        }
        // 质量门：样本两两距离 ≤ 阈值（同一次采集应高度一致）
        let fq = 0;
        for (let i = 0; i < vectors.length; i++)
          for (let j = i + 1; j < vectors.length; j++) {
            const d = faceDistance([vectors[i]], [vectors[j]]);
            if (d > fq) fq = d;
          }
        if (fq > FACE_THRESHOLD) {
          fail("Samples inconsistent — recapture in better light.", "face");
          return;
        }
        tpl[name] = tpl[name] || {};
        tpl[name].face = { status: "active", vectors, threshold: FACE_THRESHOLD, enrolledAt: Date.now() };
        writeTemplates(tpl);
      } else if (method === "voice") {
        cleanupVoiceChallenges();
        const rounds = Array.isArray(data.rounds) ? data.rounds : [];
        if (rounds.length !== 3 || !rounds.every(function (r) { return r && typeof r.nonce === "string" && validVoiceVec(r.vector); })) {
          fail("Capture failed — record all 3 readings.", "voice");
          return;
        }
        for (const r of rounds) {
          const ch = voiceChallenges.get(r.nonce);
          voiceChallenges.delete(r.nonce);
          if (!ch || ch.name !== name || ch.expires < Date.now()) {
            fail("Challenge expired — start over.", "voice");
            return;
          }
        }
        const vecs = rounds.map(function (r) { return r.vector; });
        const q = voiceEnrollQuality(vecs);
        if (q < 0.85) {
          fail("Readings inconsistent (" + q.toFixed(2) + ") — recapture in a quieter place.", "voice");
          return;
        }
        tpl[name] = tpl[name] || {};
        tpl[name].voice = { status: "active", vectors: vecs, threshold: VOICE_THRESHOLD, enrolledAt: Date.now() };
        writeTemplates(tpl);
      } else {
        fail("Unknown method.", method);
        return;
      }
      if (auth.via === "ticket") usedTickets.set(auth.token, Date.now() + 600_000);
      if (auth.via === "cookie") {
        // 登录中自助注册：直接完成 2FA 会话
        setSession(res, name, next, COOKIE, remember ? REMEMBER_TTL_MS : TTL_MS, Date.now());
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(enrollDonePage(method));
      }
    });
    return;
  }

  // face 浏览器资产（白名单严格匹配，防穿越；版本化目录，可中等缓存）
  if (url.pathname === BASE + "/assets/justget-browser.js" && req.method === "GET") {
    // justget-browser 单文件 IIFE（竞速下载器）——随 server 写盘，同源提供。
    // 内容随库版本固定 → immutable；版本号查询参数由页面拼接（升级换参）。
    try {
      const buf = readFileSync(STATIC_DIR + "/justget-browser.js");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(buf.length),
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
    return;
  }
  if (url.pathname === BASE + "/assets/face-api.js" && req.method === "GET") {
    try {
      const buf = readFileSync(ASSETS_DIR + "/face-api.js");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "Content-Length": String(buf.length) });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
    return;
  }
  if (url.pathname.startsWith(BASE + "/assets/models/") && req.method === "GET") {
    const f = url.pathname.slice((BASE + "/assets/models/").length);
    if (!MODEL_FILES.includes(f)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      const buf = readFileSync(ASSETS_DIR + "/" + f);
      res.writeHead(200, {
        "Content-Type": f.endsWith(".json") ? "application/json" : "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
        "Content-Length": String(buf.length),
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}).listen(PORT, process.env.HOST || "127.0.0.1");
`;
  mkdirSync(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".", { recursive: true });
  writeFileSync(file, script, "utf8");
}
