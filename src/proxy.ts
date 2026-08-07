import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import type { Duplex } from "stream";
import { stripBasePath } from "./discovery.ts";

/**
 * Default virtual-host suffixes: `.st.localhost` (primary) plus the
 * `.service-tunnel.localhost` alias. `pi.localhost` (a host-app brand default)
 * is deliberately NOT part of the generic tool's defaults.
 */
export const DEFAULT_SUFFIXES = [".st.localhost", ".service-tunnel.localhost", ".localhost"];

/**
 * Wildcard-host reverse proxy (zero dependencies).
 *
 * Virtual-host grammar (sites-design.md §3, dash form):
 *
 *   <port>.<suffix>              open (no auth)             5173.st.localhost
 *   <port>-auth.<suffix>         default-site auth          5173-auth.st.localhost
 *   <port>-<label>.<suffix>      named site / provider      5173-portal.st.localhost
 *
 * Each virtual host is forwarded to `http://127.0.0.1:<port>` with the path
 * left untouched, so absolute URLs (/assets/..., /api/..., form actions)
 * keep resolving within the same virtual host.
 *
 * Auth / enrollment (D4, sites-design.md §5.2):
 *   - the proxy serves ONLY enrolled virtual hosts: `resolveSite` is asked
 *     per request; a null answer → 403 (not enrolled). Open vhosts must have
 *     an open binding; labeled vhosts must be bound to their site.
 *   - labeled vhosts route to their site's auth backend: forward-auth
 *     (portal/authelia/oauth2-proxy — probe authz + `{basePath}/*` proxy) or
 *     basic (pipe to the nginx gateway, which runs auth_basic per-host).
 *   - when `resolveSite` is omitted (low-level), open vhosts forward directly
 *     with the optional global `auth`/`password` gates (legacy behavior); the
 *     documented `st.proxy.create` always passes a D4 resolver.
 *
 * Security:
 *   - the allow-list is the discovery cache (see discovery.ts): ports not
 *     found on the caller's process tree return 403 — a remote attacker can
 *     never pivot to unrelated local services (Redis/MySQL/...),
 *   - the suffix regex doubles as the host allow-list: `.st.localhost` is
 *     loopback; remote suffixes must be explicitly configured (allowedHosts /
 *     suffixes) — DNS rebinding cannot reach anything else,
 *   - unknown labels → 403; un-enrolled vhosts → 403.
 *
 * Streaming is natural (pipes, no buffering) so SSE/streams work;
 * WebSocket upgrades are forwarded via the `upgrade` event.
 */

export interface ServiceHostMatch {
  port: number;
  /** The configured suffix that matched (without dot), e.g. "st.localhost". */
  suffix: string;
  /**
   * Dash-form label (e.g. "portal", "host", "auth"); undefined = open form
   * `<port>.<suffix>`.
   */
  label?: string;
}

/** Build the virtual-host regex for the given suffixes: <port>[-<label>].<suffix>. */
export function serviceHostRegex(suffixes: string[]): RegExp {
  const alts = suffixes.map((s) =>
    s.trim().replace(/^\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^(\\d{2,5})(?:-([a-z0-9][a-z0-9-]*))?\\.(${alts.join("|")})$`, "i");
}

/**
 * Parse a Host header into { port, suffix, label? } when it is a service
 * virtual host (`<port>[-<label>].<suffix>`). Port range 10–65535 (2–5
 * digits, valid port). The hostname is lowercased before matching.
 */
export function parseServiceHost(host: string | undefined, suffixes: string[]): ServiceHostMatch | null {
  if (!host) return null;
  const hostname = host.split(":")[0]!.toLowerCase();
  const re = serviceHostRegex(suffixes);
  const m = re.exec(hostname);
  if (!m) return null;
  const port = Number(m[1]!);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { port, suffix: m[3]!, label: m[2] };
}

/**
 * Build a proxy target URL for a service virtual host WITHOUT the URL
 * parser's authority-override injection surface.
 *
 * `new URL(path, base)` parses `path` as base-relative — a leading `//` or
 * backslash path segment overrides the authority (`//evil.com`, `//127.0.0.1:9999`)
 * turning the proxy into an open SSRF. Appending the path AFTER an explicit
 * `http://127.0.0.1:<port>` authority keeps it opaque: the host/port can never
 * change, whatever the path contains.
 */
export function proxyTarget(port: number, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://127.0.0.1:${port}${p}`;
}

export interface ProxySetup {
  /** 域名所有权验证文件：IdP 会直接抓取 http://<host>/<path> 校验内容。免认证直达。 */
  verification: Array<{ path: string; content: string }>;
  /** 预登录设置提示页路径（缺省关闭；oauth2-proxy 用 /oauth2-setup）。 */
  infoPath?: string;
  /** 设置页 HTML 模板（nginx $host/$arg_rd 变量形式；node proxy 自行替换）。 */
  infoHtmlTemplate?: string;
  /** 设置页 HTML 渲染（host + 原请求路径 → html）。 */
  infoHtml?: (host: string, next: string) => string;
}

export interface ProxyAuth {
  /** Provider authz port (portal/authelia server or oauth2-proxy sidecar). */
  port: number;
  /** Provider base path (e.g. "/portal" or "/authelia"). */
  basePath: string;
  /**
   * 302 target when unauthenticated. Supports $host / $request_uri template
   * variables (nginx-style, e.g. "http://$host/portal/login?next=$request_uri"
   * for local http, "https://$host/portal/login?next=$request_uri" behind a
   * TLS-terminating tunnel).
   */
  loginRedirect: string;
  /** Authz probe path override. Default: `${basePath}/api/authz/auth-request`
   *  (authelia protocol). oauth2-proxy serves its own fixed `/oauth2/auth`. */
  authzPath?: string;
  /** Provider-owned path prefixes piped DIRECTLY to the provider port (no
   *  authz probe). oauth2-proxy's login/start/callback live under `/oauth2`. */
  providerPaths?: string[];
  /** 认证放行白名单（URL 路径前缀）：命中则跳过认证直接转发应用（/health、
   *  /metrics 等公开端点）。Node proxy 门禁在此放行。 */
  bypassPaths?: string[];
  /** 免认证直达：域名验证文件 + 预登录设置页（oauth2-proxy 等 IdP 联动场景）。 */
  setup?: ProxySetup;
}

/** Per-site auth backend resolved for an enrolled virtual host. */
export interface ProxySiteBackend {
  /**
   * forward-auth gate (portal/authelia/oauth2-proxy): probe the provider's
   * authz endpoint and redirect to login on failure; `{basePath}/*` request
   * paths are proxied to the provider port (login page / callbacks served
   * through the virtual host).
   */
  forwardAuth?: ProxyAuth;
  /**
   * basic (D2): pipe the request to the nginx gateway port with the Host
   * header preserved — nginx runs auth_basic against the per-site htpasswd
   * file and routes to the app. The gateway must already have the vhost
   * registered (authMode "basic").
   */
  basicGatewayPort?: number;
  /** per-site htpasswd file for the basic gate (decision-API verification). */
  htpasswdFile?: string;
  /** per-site tokens file for the token gate (decision-API verification). */
  tokenFile?: string;
  /** 该 vhost 真实服务的 base path(per-binding 覆盖全局 serviceBasePath)。 */
  serviceBasePath?: string;
}

/**
 * Enrollment + backend resolution (D4). Called per request (callers should
 * cache the backend keyed by port/site). Return null → 403 (not enrolled).
 *
 *   - open form (`site`/`label` undefined): null unless the port has an open
 *     binding; `{}` means direct forwarding is allowed.
 *   - labeled form: ensure the site's provider (or basic gateway) is up and
 *     the virtual host registered; return the auth backend.
 */
export type SiteResolver = (
  port: number,
  site: string | undefined,
  label: string | undefined,
  vhost: string,
) => Promise<ProxySiteBackend | null>;

export interface ProxyOptions {
  /** Listen port (default 4180; 0 = random). */
  port?: number;
  /** Accepted virtual-host suffixes (default DEFAULT_SUFFIXES). */
  suffixes?: string[];
  /** Extra full hostnames accepted as suffixes (deployment hostnames). */
  allowedHosts?: string[];
  /** Strip this base path before forwarding (e.g. "/dev" → service sees "/"). */
  basePath?: string;
  /** 真实服务的默认 base path(转发映射,见 mapServicePath)。 */
  serviceBasePath?: string;
  /** Optional Basic password (empty = disabled). Open vhosts only. */
  password?: string;
  /**
   * Forward-auth gate (portal/authelia/oauth2-proxy): verify every OPEN vhost
   * request against the provider's authz endpoint before proxying. Takes
   * precedence over `password` (Basic). Both empty = open proxy (port
   * allow-list only). Labeled vhosts use their site's backend instead.
   */
  auth?: ProxyAuth;
  /**
   * Dash-form label → site name (e.g. "portal" → "portal", "host" →
   * "host"). The reserved label "auth" maps to the default site internally.
   * Return null → 403 (unknown label).
   */
  resolveLabel?: (label: string) => string | null;
  /**
   * Suffix → site: when a virtual host has NO label but its suffix IS a
   * registered site's domain (`<port>.<site-domain>`), resolve that site
   * (auth follows site.auth). Return null → plain open vhost.
   */
  resolveSuffixSite?: (suffix: string) => string | null;
  /**
   * Enrollment + auth backend resolution (D4). When omitted, open vhosts
   * forward directly (legacy low-level behavior, global auth/password gates
   * apply) — the documented `st.proxy.create` always passes a D4 resolver.
   */
  resolveSite?: SiteResolver;
  /** Allow-list source. Default: discovery cache (internal registry aware). */
  isPortAllowed?: (port: number) => boolean;
  /** Discovery root pid (CLI mode: e.g. the user's shell or pi process). */
  rootPid?: number;
  /** Force a fresh discovery scan per allow-list check (bypass TTL). */
  refresh?: boolean;
  /** Log lines (default: no logging). */
  log?: (line: string) => void;
}

/** Basic-auth header check (constant-time-ish compare). */
export function validBasicAuth(authorization: string | undefined, password: string): boolean {
  if (!authorization) return false;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(authorization.trim());
  if (!m) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return false;
  }
  return decoded === `pi:${password}`;
}

function authHeader(password: string): string {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

/**
 * Forward-auth probe (nginx `auth_request` equivalent): ask the provider's
 * authz endpoint whether this request's session is authenticated. Returns
 * "ok" (200), "redirect" (401/302 — caller sends the login redirect), or
 * "deny" (provider error — fail closed). The scheme follows the connection
 * (http for the local proxy, https behind a TLS-terminating tunnel edge).
 */
/** True when `pathname` is under the provider's base path (login page etc.). */
function isBasePathPath(pathname: string, basePath: string): boolean {
  if (!basePath) return false;
  return pathname === basePath || pathname.startsWith(basePath.replace(/\/+$/, "") + "/");
}

// ── In-process decision API ───────────────────────────────────────────────────
// One implementation of vhost routing / enrollment / auth decisions, shared by
// the HTTP transport (createProxyServer) and embedded callers (e.g. host's
// middleware) via st.proxy.resolve(). No IncomingMessage/ServerResponse deps.

export type ServiceHostDecision =
  | { kind: "deny"; status: 403; body: string }
  | { kind: "deny-auth"; status: 401; wwwAuthenticate: string }
  | { kind: "pipe"; port: number; url: string }
  | { kind: "redirect"; location: string }
  | { kind: "forward"; target: string }
  | { kind: "static"; status: 200; contentType: string; body: string };

export interface ServiceHostResolveInput {
  host: string | undefined;
  url: string;
  method?: string;
  authorization?: string;
  cookie?: string;
  remoteAddress?: string;
  forwardedProto?: "http" | "https";
}

export interface ServiceHostResolveContext {
  suffixes: string[];
  isAllowed: (port: number) => boolean;
  resolveSite?: SiteResolver;
  resolveSuffixSite?: (suffix: string) => string | null;
  resolveLabel?: (label: string) => string | null;
  auth?: ProxyAuth;
  password?: string;
  basePath: string;
  /** 真实服务的 base path(转发映射:URL 带 deployBasePath,服务端服务在 serviceBasePath)。 */
  serviceBasePath?: string;
}

/**
 * 转发路径映射:公共 URL 带 deployBasePath(/dev),真实服务服务于 serviceBasePath。
 * 剥 deployBasePath 前缀 → 接 serviceBasePath;provider 路径(登录页等)不经过此
 * 映射——它们直接 pipe 到 provider 端口,provider 已按 deployBasePath 合并监听。
 * 例:deploy=/dev, svc="" → /dev/hello → /hello;svc=/app → /app/hello;svc=/dev → 不变。
 */
export function mapServicePath(url: string, deployBasePath: string, serviceBasePath: string): string {
  const qIdx = url.indexOf("?");
  const pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const query = qIdx >= 0 ? url.slice(qIdx) : "";
  const deploy = (deployBasePath ?? "").replace(/\/+$/, "");
  const svc = (serviceBasePath ?? "").replace(/\/+$/, "");
  let p = pathPart || "/";
  if (deploy) {
    if (p === deploy) p = "/";
    else if (p.startsWith(`${deploy}/`)) p = p.slice(deploy.length);
  }
  // p 为 "/" 时直接返回 svc(不带尾斜杠)——否则 /dev + / → "/dev/" 触发
  // Next 的 308 尾斜杠规范化 → 与剥前缀后再次映射形成死循环。
  const out = svc ? (p === "/" ? svc : `${svc}${p.startsWith("/") ? p : `/${p}`}`) : (p || "/");
  return out + query;
}

export async function resolveServiceHost(
  input: ServiceHostResolveInput,
  ctx: ServiceHostResolveContext,
): Promise<ServiceHostDecision> {
  const match = parseServiceHost(input.host, ctx.suffixes);
  if (!match) return { kind: "deny", status: 403, body: "unknown virtual host" };
  if (!ctx.isAllowed(match.port)) {
    return { kind: "deny", status: 403, body: `service port ${match.port} not allowed` };
  }

  const hostname = (input.host ?? "").split(":")[0]!.toLowerCase();
  const suffixSite = !match.label ? (ctx.resolveSuffixSite?.(match.suffix) ?? null) : null;

  if (match.label || suffixSite) {
    // labeled / site-domain vhost → site auth backend
    const site = match.label ? (ctx.resolveLabel?.(match.label) ?? null) : suffixSite;
    if (!site) {
      return { kind: "deny", status: 403, body: `unknown site label "${match.label ?? match.suffix}"` };
    }
    const backend = ctx.resolveSite ? await ctx.resolveSite(match.port, site, match.label, hostname) : null;
    if (!backend) return { kind: "deny", status: 403, body: `port ${match.port} not enrolled for site "${site}"` };
    const via = await gateBackend(backend, input);
    if (via) return via;
    // labeled / site-domain vhost 是应用的完整入口(如嵌入方应用部署在 /dev):即使
    // open(无 auth)也原样转发,不 strip basePath——strip 仅用于裸 <port>.<suffix>
    // open vhost(部署前缀下的无 label 服务)
    // 转发到真实服务:剥 deployBasePath、接服务自身 base path(per-binding 优先)
    const sb = backend.serviceBasePath ?? ctx.serviceBasePath ?? "";
    return { kind: "pipe", port: match.port, url: mapServicePath(input.url ?? "/", ctx.basePath, sb) };
  } else {
    // open vhost → enrollment + optional global gates
    if (ctx.resolveSite) {
      const backend = await ctx.resolveSite(match.port, undefined, undefined, hostname);
      if (!backend) return { kind: "deny", status: 403, body: `port ${match.port} not enrolled` };
      const via = await gateBackend(backend, input);
      if (via) return via;
    }
    if (ctx.auth) {
      const via = await gateForwardAuthDecision(ctx.auth, input);
      if (via) return via;
    } else if (ctx.password) {
      if (!validBasicAuth(input.authorization, ctx.password)) {
        return {
          kind: "deny-auth",
          status: 401,
          wwwAuthenticate: 'Basic realm="service-tunnels", charset="UTF-8"',
        };
      }
    }
  }

  const path = mapServicePath(input.url ?? "/", ctx.basePath, ctx.serviceBasePath ?? "");
  return { kind: "forward", target: proxyTarget(match.port, path) };
}

async function gateBackend(
  backend: ProxySiteBackend,
  input: ServiceHostResolveInput,
): Promise<ServiceHostDecision | null> {
  if (backend.basicGatewayPort) {
    // basic 认证在决策 API 进程内校验:嵌入方(Next middleware 类宿主)的 rewrite
    // 无法保留 vhost Host(forbidden header),nginx gateway 的 server_name 匹配
    // 不到会落到默认 server → auth_basic 被绕过。有效凭证 → 直接 pipe 到服务;
    // 无效/缺失 → 401。网关仍生成 auth_basic 配置(独立 createProxyServer 保留
    // Host 的直连路径也走同一决策,双保险)。
    const { verifyHtpasswd } = await import("./providers/basic.ts");
    if (!backend.htpasswdFile || !verifyHtpasswd(input.authorization, backend.htpasswdFile)) {
      return { kind: "deny-auth", status: 401, wwwAuthenticate: 'Basic realm="service-tunnels", charset="UTF-8"' };
    }
    return null;
  }
  if (backend.tokenFile) {
    // token 认证同样在决策 API 进程内校验(与 basic 同一理由:嵌入方 rewrite
    // 无法保留 vhost Host,nginx auth_request 会被默认 server 绕过)。
    // Bearer token 通过 → 直接 pipe 到服务;缺失/无效/过期 → 401(WWW-Authenticate:
    // Bearer,无登录页可跳)。
    const { verifyBearerToken } = await import("./providers/token.ts");
    if (!verifyBearerToken(input.authorization, backend.tokenFile)) {
      return { kind: "deny-auth", status: 401, wwwAuthenticate: 'Bearer realm="service-tunnels"' };
    }
    return null;
  }
  if (backend.forwardAuth) {
    const pathname = input.url.split("?")[0] ?? "/";
    const fw = backend.forwardAuth;
    // 认证放行白名单：命中前缀 → 跳过认证直接转发应用（/health、/metrics 等）
    if ((fw.bypassPaths ?? []).some((p) => pathname === p || pathname.startsWith(p.replace(/\/+$/, "") + "/"))) {
      return null;
    }
    // 免认证直达（IdP 域名验证抓取 / 预登录设置页）
    const setup = fw.setup;
    if (setup) {
      const vf = setup.verification.find((v) => v.path === pathname);
      if (vf) {
        return { kind: "static", status: 200, contentType: "text/plain; charset=utf-8", body: vf.content };
      }
      if (setup.infoPath && pathname === setup.infoPath) {
        const next = new URLSearchParams(input.url.split("?")[1] ?? "").get("rd") ?? "/";
        return {
          kind: "static",
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: setup.infoHtml ? setup.infoHtml(input.host ?? "", next) : `<a href="/oauth2/start?rd=${encodeURIComponent(next)}">继续登录</a>`,
        };
      }
    }
    const onProviderPath =
      isBasePathPath(pathname, fw.basePath) ||
      (fw.providerPaths ?? []).some((p) => isBasePathPath(pathname, p));
    if (onProviderPath) {
      return { kind: "pipe", port: fw.port, url: input.url ?? "/" };
    }
    return gateForwardAuthDecision(fw, input);
  }
  return null;
}

async function gateForwardAuthDecision(
  fw: ProxyAuth,
  input: ServiceHostResolveInput,
): Promise<ServiceHostDecision | null> {
  const verdict = await checkForwardAuthReq(fw, input);
  if (verdict === "ok") return null;
  if (verdict === "deny") {
    // fail closed:策略 403(deny policy)或 provider 异常 → 直接 403,不跳登录
    return { kind: "deny", status: 403, body: "authentication forbidden" };
  }
  return { kind: "redirect", location: renderLoginRedirectReq(fw.loginRedirect, input) };
}

async function checkForwardAuthReq(
  auth: ProxyAuth,
  input: ServiceHostResolveInput,
): Promise<"ok" | "redirect" | "deny"> {
  const authzPath =
    auth.authzPath ?? `${auth.basePath.replace(/\/+$/, "")}/api/authz/auth-request`;
  const host = input.host ?? "";
  const proto = input.forwardedProto ?? "http";
  return new Promise((resolve) => {
    const probe = httpRequest(
      {
        host: "127.0.0.1",
        port: auth.port,
        path: authzPath,
        method: "GET",
        headers: {
          host,
          ...(input.cookie ? { cookie: input.cookie } : {}),
          "x-original-url": `${proto}://${host}${input.url ?? "/"}`,
          "x-original-method": input.method ?? "GET",
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-forwarded-for": input.remoteAddress ?? "",
        },
        timeout: 3_000,
      },
      (r) => {
        r.resume();
        // nginx auth_request 语义：任意 2xx = 放行。authelia/portal 回 200，
        // oauth2-proxy 7.6 的 /oauth2/auth（AuthOnly）回 202 Accepted。
        if (r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 300) resolve("ok");
        else if (r.statusCode === 401 || r.statusCode === 302) resolve("redirect");
        // 403 = 策略级拒绝(deny policy / authelia forbidden)——fail closed,
        // 不能当 redirect 否则 deny 策略变成无限登录跳转。
        else if (r.statusCode === 403) resolve("deny");
        else resolve("deny");
      },
    );
    probe.on("error", () => resolve("deny"));
    probe.on("timeout", () => {
      probe.destroy();
      resolve("deny");
    });
    probe.end();
  });
}

function renderLoginRedirectReq(template: string, input: ServiceHostResolveInput): string {
  return template
    .replaceAll("$http_host", input.host ?? "")
    .replaceAll("$host", input.host ?? "")
    .replaceAll("$request_uri", input.url ?? "/");
}

/** Pipe an HTTP request to 127.0.0.1:port (provider portal or nginx gateway).
 *  Used for `{basePath}/*` → provider and basic → gateway forwarding. */
function pipeTo(
  port: number,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const proxyReq = httpRequest({
    host: "127.0.0.1",
    port,
    method: req.method,
    path: req.url ?? "/",
    headers: {
      ...req.headers,
      connection: "keep-alive",
      "x-forwarded-for": `${req.socket.remoteAddress ?? ""}, ${req.headers["x-forwarded-for"] ?? ""}`.trim().replace(/,\s*$/, ""),
    },
  });
  proxyReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("service-tunnels: upstream connection failed");
  });
  proxyReq.on("response", (proxyRes: IncomingMessage) => {
    // connection semantics belong to the DOWNSTREAM client (the upstream's
    // keep-alive must not leak through — relaying `Connection: keep-alive` to
    // a client that asked for close poisons keep-alive socket reuse → 400).
    const headers = { ...proxyRes.headers };
    delete headers.connection;
    delete headers["keep-alive"];
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxyReq);
}

/** Forward a validated WebSocket upgrade to the service. */
/** Raw upgrade pipe to 127.0.0.1:port (app, provider portal, or nginx gateway). */
function pipeUpgrade(
  port: number,
  path: string,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const proxyReq = httpRequest({
    host: "127.0.0.1",
    port,
    method: "GET",
    path,
    headers: { ...req.headers },
  });
  proxyReq.on("upgrade", (proxyRes: IncomingMessage, proxySocket: Socket, proxyHead: Buffer) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`)
          .join("") +
        `\r\n`,
    );
    if (proxyHead.length) socket.write(proxyHead);
    socket.pipe(proxySocket).pipe(socket);
  });
  proxyReq.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
  });
  proxyReq.end(head.length ? head : undefined);
}

export function createProxyServer(opts: ProxyOptions): Server {
  const {
    port = 4180,
    basePath = "",
    serviceBasePath,
    password = "",
    auth,
    log = () => {},
  } = opts;
  const suffixes = [...(opts.suffixes ?? DEFAULT_SUFFIXES)];
  for (const h of opts.allowedHosts ?? []) {
    const s = `.${h.trim().replace(/^\./, "")}`;
    if (!suffixes.includes(s)) suffixes.push(s);
  }
  const isAllowed = opts.isPortAllowed ?? (() => true);
  const strip = (pathname: string) => stripBasePath(pathname, basePath);
  const resolveLabel = opts.resolveLabel ?? (() => null);
  const resolveSite = opts.resolveSite;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  /** 403 with a reason (all error responses are plain text + no-store). */
  function deny(res: ServerResponse, message: string): void {
    res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(`service-tunnels: ${message}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const decision = await resolveServiceHost(
      {
        host: req.headers.host,
        url: req.url ?? "/",
        method: req.method,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        remoteAddress: req.socket.remoteAddress,
        forwardedProto: (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http",
      },
      {
        suffixes,
        isAllowed,
        resolveSite,
        resolveSuffixSite: opts.resolveSuffixSite,
        resolveLabel,
        auth,
        password,
        basePath,
        serviceBasePath,
      },
    );

    switch (decision.kind) {
      case "deny":
        log(`deny ${req.headers.host} (${decision.body})`);
        deny(res, decision.body);
        return;
      case "deny-auth":
        log(`auth 401 ${req.headers.host}`);
        res.writeHead(401, {
          "cache-control": "no-store",
          "www-authenticate": decision.wwwAuthenticate,
        });
        res.end("Authentication required");
        return;
      case "pipe":
        log(`pipe ${req.headers.host}${req.url ?? ""} → :${decision.port}`);
        pipeTo(decision.port, req, res);
        return;
      case "redirect":
        log(`auth 302 ${req.headers.host} → ${decision.location}`);
        res.writeHead(302, { "cache-control": "no-store", location: decision.location });
        res.end();
        return;
      case "static":
        log(`static ${req.headers.host}${req.url ?? ""} (${decision.contentType})`);
        res.writeHead(decision.status, { "content-type": decision.contentType, "cache-control": "no-store" });
        res.end(decision.body);
        return;
      case "forward": {
        const t = new URL(decision.target);
        log(`proxy ${req.headers.host} → 127.0.0.1:${t.port} ${req.method} ${t.pathname + t.search}`);
        const path = t.pathname + t.search;

    const proxyReq = httpRequest({
      host: t.hostname,
      port: Number(t.port) || 80,
      method: req.method,
      path,
      headers: {
        ...req.headers,
        connection: "keep-alive",
      },
    });
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("service-tunnels: upstream connection failed");
    });
    proxyReq.on("response", (proxyRes: IncomingMessage) => {
      // connection semantics belong to the DOWNSTREAM client — the upstream's
      // `Connection: keep-alive` must not leak through (relaying it to a
      // client that asked for close poisons keep-alive socket reuse → 400).
      const headers = { ...proxyRes.headers };
      delete headers.connection;
      delete headers["keep-alive"];
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
    return;
      }
    }
  }

  // WebSocket / upgrade forwarding — same decision API as the HTTP path
  // (resolveServiceHost); the only transport difference is that a failed
  // forward-auth gate cannot 302 a WebSocket client, so it is answered with
  // 401 (client reconnects after re-authenticating).
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const decision = await resolveServiceHost(
        {
          host: req.headers.host,
          url: req.url ?? "/",
          method: req.method,
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          remoteAddress: req.socket.remoteAddress,
          forwardedProto: (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http",
        },
        {
          suffixes,
          isAllowed,
          resolveSite,
          resolveSuffixSite: opts.resolveSuffixSite,
          resolveLabel,
          auth,
          password,
          basePath,
          serviceBasePath,
        },
      );
      switch (decision.kind) {
        case "deny":
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        case "deny-auth":
          socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${decision.wwwAuthenticate}\r\n\r\n`);
          socket.destroy();
          return;
        case "pipe":
          pipeUpgrade(decision.port, decision.url, req, socket, head);
          return;
        case "redirect":
          socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
          socket.destroy();
          return;
        case "forward": {
          const t = new URL(decision.target);
          pipeUpgrade(Number(t.port) || 80, t.pathname + t.search, req, socket, head);
          return;
        }
      }
    })();
  });

  server.listen(port);
  return server;
}

/** Convenience: build the basic-auth header value for the password gate. */
export { authHeader };
