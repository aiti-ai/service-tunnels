/**
 * port-identity — 监听端口的 HTTP 服务识别（document title + favicon）。
 *
 * 端口列表（dashboard / port.list）只有"端口号 + 进程 cmdline"，用户很难一眼
 * 看出每个端口跑的是什么。本模块对每个端口做一次轻量 HTTP(S) 探测：
 *   - GET http://127.0.0.1:<port>/（v4 全失败再试 ::1——应用可能只绑 v6）
 *   - 从 HTML 提取 <title> 与 <link rel*=icon> 的 favicon
 *   - favicon 取回后转 data: URL（UI 可直接 <img>，无需再发请求）
 *   - 记录 status / Content-Type / Server 头，供 tooltip 展示
 *
 * 安全边界：
 *   - 只探测调用方枚举到的**本机回环端口**（127.0.0.1 / ::1），不外呼；
 *   - 重定向只跟随目标仍为回环的（服务 302 到公网则停在 30x——探测不产生
 *     外网流量，协议仍如实标 http/https）；
 *   - 响应体有大小上限（doc 64KB / favicon 96KB）+ 严格超时，socket 显式
 *     销毁（与 detectProtocol 同样的 L4 纪律，防 keep-alive 挂起）；
 *   - GET / 与用户在浏览器打开该端口等价，无副作用写入。
 *
 * 成本控制：结果按端口缓存（成功 5min / 失败 30s），UI 10s 轮询几乎零成本；
 * 批量识别有并发上限。`SERVICE_TUNNELS_NO_PORT_IDENTITY=1` 可整体关闭探测。
 *
 * 未来方向（服务页签 / 用户自定义识别）：identity 只是"探测到的默认识别"，
 * 上层可叠加用户自起的 label（优先级 label > title > 进程名 > 端口号），
 * 见 docs/port-identity-design.md。
 */

import http from "node:http";
import https from "node:https";

export interface PortIdentity {
  /** 探测到的协议；"tcp" = 非 HTTP(S) 或探测失败（含端口已无人监听）。 */
  protocol: "http" | "https" | "tcp";
  /** 用户自定义服务名（port.label.set 写入，state.json 持久化；由
   *  port.list 合并，探测层不填）。显示优先级：label > title > cmdline。 */
  label?: string;
  /** HTTP 状态码（仅 http/https）。 */
  status?: number;
  /** 文档 <title>（实体解码、压空白，截断 120 字符）。 */
  title?: string;
  /** favicon 的 data: URL（已取回；UI 可直接作为 <img src>）。 */
  favicon?: string;
  /** favicon 来源地址（data: URL 内联的 link 截断展示）。 */
  faviconUrl?: string;
  /** Content-Type 响应头（去掉参数）。 */
  contentType?: string;
  /** Server 响应头（nginx / Express / …），截断 80 字符。 */
  server?: string;
}

/** 单次探测参数（内部用，测试可收紧超时）。 */
export interface IdentifyOptions {
  timeoutMs?: number;
  maxDocBytes?: number;
  maxFaviconBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_MAX_DOC_BYTES = 64 * 1024;
// favicon 转成 data: URL 会随 /api/live 轮询反复下发，控制体积（过大只留
// faviconUrl 供 tooltip/详情用）
const DEFAULT_MAX_FAVICON_BYTES = 32 * 1024;
const MAX_REDIRECTS = 3;
const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

/** 全局缓存（globalThis：与 discovery 缓存同风格，热重载不丢）。 */
declare global {
  var __stPortIdentityCache:
    | Map<string, { at: number; ttl: number; identity: PortIdentity }>
    | undefined;
}

function cacheMap(): Map<string, { at: number; ttl: number; identity: PortIdentity }> {
  return (globalThis.__stPortIdentityCache ??= new Map());
}

/** 测试辅助：清空识别缓存。 */
export function clearIdentityCache(): void {
  globalThis.__stPortIdentityCache = undefined;
}

function identityDisabled(): boolean {
  return process.env.SERVICE_TUNNELS_NO_PORT_IDENTITY === "1";
}

// ── 原始抓取（仅回环；重定向只跟随回环目标）────────────────────────────────

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

interface FetchOpts {
  timeoutMs: number;
  maxBytes: number;
  redirects?: number;
}

/** GET 一个（回环）URL。重定向目标为外网/预算耗尽时，按当前 30x 响应返回
 *  （body 为空——诚实标注，不产生外呼流量）。传输层失败 reject。 */
function fetchLoopback(url: string, opts: FetchOpts): Promise<RawResponse> {
  const redirects = opts.redirects ?? 0;
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`bad url: ${url}`));
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new Error(`unsupported protocol: ${u.protocol}`));
      return;
    }
    if (!isLoopbackHostname(u.hostname)) {
      reject(new Error(`non-loopback target refused: ${u.hostname}`));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        rejectUnauthorized: false, // 本机自签服务照常识别
        timeout: opts.timeoutMs,
        headers: { "User-Agent": "service-tunnels-port-identity", Connection: "close" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc) {
          res.resume();
          req.destroy();
          let next: URL;
          try {
            next = new URL(loc, u);
          } catch {
            // 畸形 Location（对端可任意构造）不能在这里抛——响应回调里的
            // 未捕获异常会击穿整个进程（daemon 常驻），按停在 30x 处理
            resolve({ status, headers: res.headers, body: Buffer.alloc(0), finalUrl: u.href });
            return;
          }
          if (redirects >= MAX_REDIRECTS || !isLoopbackHostname(next.hostname)) {
            resolve({ status, headers: res.headers, body: Buffer.alloc(0), finalUrl: u.href });
            return;
          }
          fetchLoopback(next.href, { ...opts, redirects: redirects + 1 }).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= opts.maxBytes) chunks.push(c);
          else req.destroy(); // 超限即断（title/favicon 都在文档头部）
        });
        res.on("end", () => {
          req.destroy(); // L4: 防 keep-alive 挂起
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: u.href });
        });
        res.on("error", () => {
          req.destroy();
          // 截断的 body 也够用（title/favicon 都在头部）
          if (chunks.length) resolve({ status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: u.href });
          else reject(new Error("response error"));
        });
      },
    );
    req.on("error", (e) => reject(e));
    // 双保险：socket 空闲超时之外，再设整体硬截止（防慢速响应拖住空闲超时）
    const killer = setTimeout(() => req.destroy(new Error("timeout")), opts.timeoutMs + 250);
    req.on("close", () => clearTimeout(killer));
    req.end();
  });
}

// ── HTML 解析 ────────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

/** 提取 <title>（body 被截断且标签未闭合时放弃）。 */
export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = decodeEntities(m[1]!).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 120) : undefined;
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return undefined;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim() || undefined;
}

/** 提取 favicon link href；普通 icon/shortcut icon 优先于 apple-touch-icon。 */
export function extractIconHref(html: string): string | undefined {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  let appleFallback: string | undefined;
  for (const tag of tags) {
    const rel = attr(tag, "rel")?.toLowerCase();
    const href = attr(tag, "href");
    if (!rel || !href) continue;
    if (!/(^|\s)icon(\s|$)|shortcut\s+icon|apple-touch-icon|mask-icon/.test(rel)) continue;
    if (/apple-touch-icon/.test(rel)) {
      appleFallback ??= href;
      continue;
    }
    return href;
  }
  return appleFallback;
}

// ── favicon → data URL ───────────────────────────────────────────────────────

function sniffMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 6 && buf.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "image/x-icon";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  const head = buf.subarray(0, 64).toString("utf8").trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return undefined;
}

function toDataUrl(buf: Buffer, contentType: string | undefined): string | undefined {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  const sniffed = sniffMime(buf);
  // image/x-icon 是“万能桶”标签（很多服务器对所有图标都这么标）：能从魔数
  // 嗅探出具体类型时优先嗅探；其余具体 image/* 声明优先于嗅探。
  // 声明值须过白名单——Content-Type 头对端可任意构造，带引号/空白的值原样
  // 进 data: URL 会在 UI 的 src="..." 属性里 breakout（XSS）
  const mime =
    declared && declared !== "image/x-icon" && /^image\/[a-z0-9.+-]+$/.test(declared)
      ? declared
      : sniffed;
  if (!mime) return undefined;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function resolveFavicon(
  base: URL,
  iconHref: string | undefined,
  opts: IdentifyOptions,
): Promise<{ favicon?: string; faviconUrl?: string }> {
  // link 里直接内联 data: URL（内联 SVG 常见）——统一转 base64（URL-encoded
  // 的 SVG 可能含引号，直接进 HTML 属性会破）
  if (iconHref?.startsWith("data:image/")) {
    const comma = iconHref.indexOf(",");
    if (comma > 0 && iconHref.length <= 160_000) {
      const head = iconHref.slice(0, comma);
      const payload = iconHref.slice(comma + 1);
      const mime = /^data:([^;,]+)/.exec(head)?.[1] ?? "image/png";
      let raw = payload;
      if (!/;base64$/i.test(head)) {
        try { raw = decodeURIComponent(payload); } catch { /* 保留原样 */ }
      }
      return { favicon: `data:${mime};base64,${Buffer.from(raw, "utf8").toString("base64")}`, faviconUrl: iconHref.slice(0, 100) + "…" };
    }
    return {};
  }
  let u: URL;
  try {
    u = new URL(iconHref ?? "/favicon.ico", base);
  } catch {
    return {};
  }
  if (!isLoopbackHostname(u.hostname)) return {};
  try {
    const res = await fetchLoopback(u.href, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: opts.maxFaviconBytes ?? DEFAULT_MAX_FAVICON_BYTES,
    });
    if (res.status !== 200 || res.body.length === 0) return { faviconUrl: u.href };
    const favicon = toDataUrl(res.body, res.headers["content-type"] as string | undefined);
    return favicon ? { favicon, faviconUrl: u.href } : { faviconUrl: u.href };
  } catch {
    return { faviconUrl: u.href };
  }
}

// ── 单端口探测 ───────────────────────────────────────────────────────────────

async function fromResponse(res: RawResponse, opts: IdentifyOptions): Promise<PortIdentity> {
  const identity: PortIdentity = {
    protocol: res.finalUrl.startsWith("https:") ? "https" : "http",
    status: res.status,
    server: (res.headers.server as string | undefined)?.slice(0, 80),
    contentType: ((res.headers["content-type"] as string | undefined)?.split(";")[0]?.trim() || undefined),
  };
  const text = res.body.toString("utf8");
  const title = extractTitle(text);
  if (title) identity.title = title;
  // HTML 语义（content-type / 显式标签 / 有 title）→ 才做 favicon 解析
  if (identity.contentType?.includes("html") || title || /<html[\s>]/i.test(text)) {
    const fav = await resolveFavicon(new URL(res.finalUrl), extractIconHref(text), opts);
    if (fav.favicon) identity.favicon = fav.favicon;
    if (fav.faviconUrl) identity.faviconUrl = fav.faviconUrl;
  }
  return identity;
}

async function probeHost(port: number, host: string, opts: IdentifyOptions): Promise<PortIdentity> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const literal = host.includes(":") ? `[${host}]` : host;
  // 明文 HTTP 先行（TLS 端口收到明文请求会断开/回 alert → 落到 catch）
  try {
    return await fromResponse(
      await fetchLoopback(`http://${literal}:${port}/`, { timeoutMs, maxBytes: opts.maxDocBytes ?? DEFAULT_MAX_DOC_BYTES }),
      opts,
    );
  } catch {
    /* 可能是 TLS 或非 HTTP */
  }
  try {
    return await fromResponse(
      await fetchLoopback(`https://${literal}:${port}/`, { timeoutMs, maxBytes: opts.maxDocBytes ?? DEFAULT_MAX_DOC_BYTES }),
      opts,
    );
  } catch {
    return { protocol: "tcp" };
  }
}

async function identifyPortUncached(port: number, opts: IdentifyOptions): Promise<PortIdentity> {
  const v4 = await probeHost(port, "127.0.0.1", opts);
  if (v4.protocol !== "tcp") return v4;
  // v4 判为 tcp：可能只绑了 ::1 → 再试 v6；仍 tcp 则如实返回
  const v6 = await probeHost(port, "::1", opts);
  return v6.protocol !== "tcp" ? v6 : v4;
}

/** 探测一个本机回环端口（带缓存）。无人监听/非 HTTP → { protocol: "tcp" }。 */
export async function identifyPort(port: number, opts: IdentifyOptions = {}): Promise<PortIdentity> {
  const key = `|${port}`;
  const cached = cacheMap().get(key);
  const now = Date.now();
  if (cached && cached.at + cached.ttl > now) return cached.identity;
  const identity = await identifyPortUncached(port, opts);
  cacheMap().set(key, { at: now, ttl: identity.protocol === "tcp" ? FAILURE_TTL_MS : SUCCESS_TTL_MS, identity });
  return identity;
}

// ── 批量：端口列表 → 附 identity ─────────────────────────────────────────────

export interface IdentityTarget {
  port: number;
  addresses?: string[];
}

/**
 * 为端口列表补 identity（不改入参，返回新数组）。仅探测回环；
 * `SERVICE_TUNNELS_NO_PORT_IDENTITY=1` 时原样返回（不附 identity）。
 */
export async function enrichWithIdentity<T extends IdentityTarget>(
  ports: T[],
): Promise<Array<T & { identity?: PortIdentity }>> {
  if (identityDisabled() || ports.length === 0) return [...ports];
  const results = await Promise.all(ports.map((p) => identifyPort(p.port)));
  return ports.map((p, i) => ({ ...p, identity: results[i] }));
}

/** 读取缓存中的 identity（不触发探测；未命中/过期返回 undefined）。 */
export function peekIdentity(port: number): PortIdentity | undefined {
  const cached = cacheMap().get(`|${port}`);
  if (cached && cached.at + cached.ttl > Date.now()) return cached.identity;
  return undefined;
}
