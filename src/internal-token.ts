import { randomBytes, createHash, timingSafeEqual } from "crypto";

/**
 * In-memory rotating token ring — 内部可信客户端放行机制。
 *
 * **不落盘**（纯进程内存，重启即全部失效）、TTL、定期轮换 + 天然 overlap
 * 窗口（老 token 在自身 TTL 内仍有效，rotate 只是生成新 token，正在飞的
 * 请求不会因 rotate 突然 401）。
 *
 * 用途：嵌入方（如 pi-work 的 service-tunnels 扩展）接管登录、拦截所有请求
 * 后，AI 内部用 curl / fetch 等工具发起的请求也会被认证阻断。本机制提供一
 * 个"临时内部 token"：宿主启动子进程（AI 的 bash）时通过环境变量注入
 * `ST_INTERNAL_TOKEN`（见 `envForChild()`），子进程请求带上
 * `Authorization: Bearer <token>` 即放行——作为 `gateBackend` 的通用内部旁路
 * （在 basic / token / forward-auth 之前），覆盖所有 vhost，不论 site/provider。
 *
 * 与落盘 `providers/token.ts` 的区别：
 *   - 落盘 token：长期有效、可管理/撤销、按 site 隔离、sha256 落盘——适合
 *     CI/脚本这类"机器客户端长期凭证"；
 *   - 内存 ring：进程级临时凭证、自动轮换、不落盘、单实例全局——适合
 *     "AI 子进程会话级放行"，重启即失效，泄露窗口 = TTL。
 *
 * 安全模型：
 *   - token = `sti_` 前缀 + 24 字节 base64url（≈192-bit 熵）；前缀便于日志识别
 *   - ring 只存 sha256 hash；**唯一例外**是当前（最新）条目保留原文，用于
 *     `envForChild()` 重复注入子进程（rotate 后老条目原文立即清空，只留 hash）
 *   - 校验 constant-time（timingSafeEqual），fail-closed
 *   - TTL + 定期 rotate：老 token 在自身 TTL 到期后自动 prune
 *   - 进程退出即全部失效（不落盘 = 不残留）
 *
 * 进程凭证追踪（想法②）的预留：本模块只负责 token 校验。基于 marker +
 * `/proc` 反查"请求来自内部子进程"的 probe，见 `createLinuxProcessProbe`
 * （独立导出，默认不 wire 进 proxy——由嵌入方按需接入，避免核心路径引入
 * /proc 依赖）。
 */

export interface InternalTokenRingOptions {
  /** 单个 token 的有效期（ms）。缺省 15 分钟。 */
  ttlMs?: number;
  /** 轮换间隔（ms）：每过一个间隔生成新 token。缺省 ttlMs / 3。
   *  overlap = ttlMs - rotateIntervalMs（老 token 在自身 TTL 内仍有效，
   *  rotate 时刻正在飞的请求不会 401）。需 ttlMs > rotateIntervalMs 才有
   *  正向 overlap；相等则 rotate 即过期、无 overlap。 */
  rotateIntervalMs?: number;
  /** ring 容量上限（保留几个历史 token 用于 overlap 校验）。缺省 3。
   *  越大越能容忍长时间未 rotate 的老 token，但内存与校验成本略增。 */
  ringSize?: number;
  /** 前缀（便于日志识别）。缺省 "sti_"。 */
  prefix?: string;
  /** 自动轮换定时器是否启动（缺省 true）。测试可传 false 手动 rotate。 */
  autoRotate?: boolean;
}

interface RingEntry {
  /** 原始 token——仅当前（最新）条目保留，用于 envForChild 重复注入。
   *  老条目降级后置空（只留 hash 用于 overlap 校验）。 */
  token: string | null;
  hash: string;
  issuedAt: number;
  expiresAt: number;
}

/** 内存轮换 token ring（不落盘）。 */
export class InternalTokenRing {
  readonly #ttlMs: number;
  readonly #rotateIntervalMs: number;
  readonly #ringSize: number;
  readonly #prefix: string;
  #ring: RingEntry[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: InternalTokenRingOptions = {}) {
    const ttl = opts.ttlMs ?? 15 * 60_000;
    const rotate = opts.rotateIntervalMs ?? Math.max(1, Math.floor(ttl / 3));
    if (rotate > ttl) {
      // rotate 比 ttl 长没有意义（老 token 早过期了才 rotate）——夹到 ttl
      // 并警告式记录（不抛错：构造期抛错会打断宿主启动）。
      // eslint-disable-next-line no-console
      console.warn(`[service-tunnels] internal-token: rotateIntervalMs (${rotate}) > ttlMs (${ttl}), clamping to ttl`);
    }
    this.#ttlMs = ttl;
    this.#rotateIntervalMs = Math.min(rotate, ttl);
    this.#ringSize = Math.max(2, opts.ringSize ?? 3);
    this.#prefix = opts.prefix ?? "sti_";
    this.#spawn();
    if (opts.autoRotate !== false) this.#scheduleRotate();
  }

  #spawn(): void {
    const token = this.#generate();
    const now = Date.now();
    // 老条目降级：丢弃原文只留 hash（overlap 期内仍可校验）
    for (const e of this.#ring) e.token = null;
    this.#ring.push({ token, hash: this.#hash(token), issuedAt: now, expiresAt: now + this.#ttlMs });
    this.#prune();
  }

  #generate(): string {
    return `${this.#prefix}${randomBytes(24).toString("base64url")}`;
  }

  #hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  #scheduleRotate(): void {
    this.#timer = setInterval(() => this.rotate(), this.#rotateIntervalMs);
    this.#timer.unref?.();
  }

  #prune(): void {
    const now = Date.now();
    this.#ring = this.#ring
      .filter((e) => e.expiresAt > now) // 丢过期
      .slice(-this.#ringSize); // 保留最近 ringSize 个
  }

  /** 手动轮换：生成新 token，老条目降级（原文清空只留 hash），裁剪 ring。
   *  测试 / 怀疑泄露时手动调用。定时器也会按 rotateIntervalMs 自动调用。 */
  rotate(): void {
    this.#spawn();
  }

  /** 当前 token 原文（供 envForChild 注入子进程）。ring 为空/过期时先 spawn。 */
  currentToken(): string {
    this.#prune();
    let cur = this.#ring[this.#ring.length - 1];
    if (!cur || cur.expiresAt <= Date.now()) {
      this.#spawn();
      cur = this.#ring[this.#ring.length - 1]!;
    }
    if (cur.token === null) {
      // 当前条目原文被清空（不应发生——最新条目总有原文）→ 重新生成
      const token = this.#generate();
      cur.token = token;
      cur.hash = this.#hash(token);
      cur.issuedAt = Date.now();
      cur.expiresAt = Date.now() + this.#ttlMs;
    }
    return cur.token;
  }

  /**
   * 环境变量片段，供宿主 spawn 子进程时注入：
   *
   * ```ts
   * spawn(cmd, args, { env: { ...process.env, ...st.internal.envForChild() } })
   * ```
   *
   * 子进程的 curl 带上 `Authorization: Bearer $ST_INTERNAL_TOKEN` 即放行。
   * `ST_INTERNAL_TOKEN_EXPIRES` 是当前 token 的过期 epoch ms——子进程可在
   * 过期前重新读取（宿主重新 spawn 或 IPC 刷新）。
   */
  envForChild(): { ST_INTERNAL_TOKEN: string; ST_INTERNAL_TOKEN_EXPIRES: string } {
    const token = this.currentToken();
    const cur = this.#ring[this.#ring.length - 1]!;
    return {
      ST_INTERNAL_TOKEN: token,
      ST_INTERNAL_TOKEN_EXPIRES: String(cur.expiresAt),
    };
  }

  /**
   * 进程内校验：`Authorization: Bearer <token>` 命中 ring 任一未过期 token。
   * 严格只认 `Bearer <token>`（RFC 6750，scheme 大小写不敏感）。
   * constant-time 比对、fail-closed。
   */
  verify(authorization: string | undefined): boolean {
    if (!authorization) return false;
    const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (!m) return false;
    const want = this.#hash(m[1]!);
    this.#prune();
    const now = Date.now();
    for (const e of this.#ring) {
      if (e.expiresAt <= now) continue;
      const a = Buffer.from(e.hash);
      const b = Buffer.from(want);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    return false;
  }

  /** 当前 ring 状态（调试 / UI）。不含任何秘密。 */
  status(): {
    size: number;
    ttlMs: number;
    rotateIntervalMs: number;
    current: { issuedAt: number; expiresAt: number; rotatesAt: number } | null;
  } {
    this.#prune();
    const cur = this.#ring[this.#ring.length - 1];
    return {
      size: this.#ring.length,
      ttlMs: this.#ttlMs,
      rotateIntervalMs: this.#rotateIntervalMs,
      current: cur
        ? { issuedAt: cur.issuedAt, expiresAt: cur.expiresAt, rotatesAt: cur.issuedAt + this.#rotateIntervalMs }
        : null,
    };
  }

  /** 停止定时器并清空 ring（shutdown）。 */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#ring = [];
  }
}
