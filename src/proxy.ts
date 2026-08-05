import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import type { Duplex } from "stream";
import { stripBasePath } from "./discovery.ts";

/**
 * Default virtual-host suffixes: `.st.localhost` (primary) plus the
 * `.service-tunnel.localhost` alias. `pi.localhost` (the pi-web brand default)
 * is deliberately NOT part of the generic tool's defaults.
 */
export const DEFAULT_SUFFIXES = [".st.localhost", ".service-tunnel.localhost"];

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
   * Dash-form label (e.g. "portal", "pi-web", "auth"); undefined = open form
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
  /** Extra full hostnames accepted as suffixes (deployment at pi.example.com). */
  allowedHosts?: string[];
  /** Strip this base path before forwarding (e.g. "/dev" → service sees "/"). */
  basePath?: string;
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
   * Dash-form label → site name (e.g. "portal" → "portal", "pi-web" →
   * "pi-web"). The reserved label "auth" maps to the default site internally.
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
function checkForwardAuth(
  req: IncomingMessage,
  auth: ProxyAuth,
): Promise<"ok" | "redirect" | "deny"> {
  const authzPath = `${auth.basePath.replace(/\/+$/, "")}/api/authz/auth-request`;
  const host = req.headers.host ?? "";
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  return new Promise((resolve) => {
    const probe = httpRequest(
      {
        host: "127.0.0.1",
        port: auth.port,
        path: authzPath,
        method: "GET",
        headers: {
          host,
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
          "x-original-url": `${proto}://${host}${req.url ?? "/"}`,
          "x-original-method": req.method ?? "GET",
          "x-forwarded-proto": proto,
          "x-forwarded-host": host,
          "x-forwarded-for": req.socket.remoteAddress ?? "",
        },
        timeout: 3_000,
      },
      (r) => {
        r.resume();
        if (r.statusCode === 200) resolve("ok");
        else if (r.statusCode === 401 || r.statusCode === 302 || r.statusCode === 403) resolve("redirect");
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

/** nginx-style $host / $request_uri template substitution in a redirect URL. */
function renderLoginRedirect(template: string, req: IncomingMessage): string {
  return template
    .replaceAll("$host", req.headers.host ?? "")
    .replaceAll("$request_uri", req.url ?? "/");
}

/** True when `pathname` is under the provider's base path (login page etc.). */
function isBasePathPath(pathname: string, basePath: string): boolean {
  if (!basePath) return false;
  return pathname === basePath || pathname.startsWith(basePath.replace(/\/+$/, "") + "/");
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
function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  match: ServiceHostMatch,
  strip: (pathname: string) => string,
): void {
  const path = strip(req.url?.split("?")[0] ?? "/") + (req.url?.includes("?") ? `?${req.url.split("?")[1]}` : "");
  pipeUpgrade(match.port, path, req, socket, head);
}

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

  /** Probe forward-auth; on failure 302 to the login page. */
  async function gateForwardAuth(
    req: IncomingMessage,
    res: ServerResponse,
    fw: ProxyAuth,
  ): Promise<boolean> {
    const verdict = await checkForwardAuth(req, fw);
    if (verdict === "ok") return true;
    log(`auth 302 ${req.headers.host} (${verdict})`);
    res.writeHead(302, {
      "cache-control": "no-store",
      location: renderLoginRedirect(fw.loginRedirect, req),
    });
    res.end();
    return false;
  }

  /** Basic password gate (open vhosts). */
  function gatePassword(req: IncomingMessage, res: ServerResponse): boolean {
    if (!password) return true;
    if (validBasicAuth(req.headers.authorization, password)) return true;
    log(`auth 401 ${req.headers.host}`);
    res.writeHead(401, {
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="service-tunnels", charset="UTF-8"',
    });
    res.end("Authentication required");
    return false;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = parseServiceHost(req.headers.host, suffixes);

    if (!match) {
      deny(res, "unknown virtual host");
      return;
    }
    if (!isAllowed(match.port)) {
      log(`deny ${req.headers.host} → ${match.port} (not in allow-list)`);
      deny(res, "service port not allowed");
      return;
    }

    // ── site vhost: label (`<port>-<label>.`) OR a site-domain suffix
    //    (`<port>.<site-domain>`) → resolve site → auth backend ──────────────
    const hostname = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
    const suffixSite = !match.label ? (opts.resolveSuffixSite?.(match.suffix) ?? null) : null;
    if (match.label || suffixSite) {
      const site = match.label ? resolveLabel(match.label) : suffixSite;
      if (!site) {
        log(`deny ${req.headers.host} → unknown site label "${match.label ?? match.suffix}"`);
        deny(res, `unknown site label "${match.label ?? match.suffix}"`);
        return;
      }
      const backend = resolveSite ? await resolveSite(match.port, site, match.label, hostname) : null;
      if (!backend) {
        log(`deny ${req.headers.host} → port ${match.port} not enrolled for site "${site}"`);
        deny(res, `port ${match.port} not enrolled for site "${site}"`);
        return;
      }
      if (backend.basicGatewayPort) {
        // basic (D2): nginx auth_basic owns challenge + backend routing
        log(`pipe ${req.headers.host} → nginx gateway :${backend.basicGatewayPort}`);
        pipeTo(backend.basicGatewayPort, req, res);
        return;
      }
      if (backend.forwardAuth) {
        const pathname = req.url?.split("?")[0] ?? "/";
        if (isBasePathPath(pathname, backend.forwardAuth.basePath)) {
          // login page / callbacks served through the virtual host
          log(`pipe ${req.headers.host}${req.url} → provider :${backend.forwardAuth.port}`);
          pipeTo(backend.forwardAuth.port, req, res);
          return;
        }
        if (!(await gateForwardAuth(req, res, backend.forwardAuth))) return;
      }
      // fall through: authenticated request → app port
    } else {
      // ── open vhost: `<port>.<suffix>` → enrollment + optional global gates ──
      if (resolveSite) {
        const backend = await resolveSite(match.port, undefined, undefined, hostname);
        if (!backend) {
          log(`deny ${req.headers.host} → port ${match.port} not enrolled`);
          deny(res, `port ${match.port} not enrolled`);
          return;
        }
        if (backend.basicGatewayPort) {
          pipeTo(backend.basicGatewayPort, req, res);
          return;
        }
        if (backend.forwardAuth) {
          const pathname = req.url?.split("?")[0] ?? "/";
          if (isBasePathPath(pathname, backend.forwardAuth.basePath)) {
            pipeTo(backend.forwardAuth.port, req, res);
            return;
          }
          if (!(await gateForwardAuth(req, res, backend.forwardAuth))) return;
        }
      }
      if (auth) {
        if (!(await gateForwardAuth(req, res, auth))) return;
      } else if (!gatePassword(req, res)) {
        return;
      }
    }

    const path = strip(req.url?.split("?")[0] ?? "/") + (req.url?.includes("?") ? `?${req.url.split("?")[1]}` : "");
    log(`proxy ${req.headers.host} → 127.0.0.1:${match.port} ${req.method} ${path}`);

    const proxyReq = httpRequest({
      host: "127.0.0.1",
      port: match.port,
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
  }

  // WebSocket / upgrade forwarding.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const match = parseServiceHost(req.headers.host, suffixes);
      if (!match || !isAllowed(match.port)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const hostname = (req.headers.host ?? "").split(":")[0]!.toLowerCase();

      // site vhost: label OR site-domain suffix → per-site backend
      const suffixSite = !match.label ? (opts.resolveSuffixSite?.(match.suffix) ?? null) : null;
      if (match.label || suffixSite) {
        const site = match.label ? resolveLabel(match.label) : suffixSite;
        const backend = site && resolveSite ? await resolveSite(match.port, site, match.label, hostname) : null;
        if (!site || !backend) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        if (backend.basicGatewayPort) {
          pipeUpgrade(backend.basicGatewayPort, req.url ?? "/", req, socket, head);
          return;
        }
        if (backend.forwardAuth) {
          const pathname = req.url?.split("?")[0] ?? "/";
          if (isBasePathPath(pathname, backend.forwardAuth.basePath)) {
            pipeUpgrade(backend.forwardAuth.port, req.url ?? "/", req, socket, head);
            return;
          }
          const verdict = await checkForwardAuth(req, backend.forwardAuth);
          if (verdict !== "ok") {
            socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
            socket.destroy();
            return;
          }
        }
        forwardUpgrade(req, socket, head, match, strip);
        return;
      }

      // open vhost: enrollment + optional global gates
      let globalAuth: ProxyAuth | null = auth ?? null;
      if (resolveSite) {
        const backend = await resolveSite(match.port, undefined, undefined, hostname);
        if (!backend) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        if (backend.basicGatewayPort) {
          pipeUpgrade(backend.basicGatewayPort, req.url ?? "/", req, socket, head);
          return;
        }
        if (backend.forwardAuth) {
          const pathname = req.url?.split("?")[0] ?? "/";
          if (isBasePathPath(pathname, backend.forwardAuth.basePath)) {
            pipeUpgrade(backend.forwardAuth.port, req.url ?? "/", req, socket, head);
            return;
          }
          globalAuth = backend.forwardAuth ?? null;
        }
      }
      if (!globalAuth && password && !validBasicAuth(req.headers.authorization, password)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"service-tunnels\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (globalAuth) {
        const verdict = await checkForwardAuth(req, globalAuth);
        if (verdict !== "ok") {
          socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      forwardUpgrade(req, socket, head, match, strip);
    })();
  });

  server.listen(port);
  return server;
}

/** Convenience: build the basic-auth header value for the password gate. */
export { authHeader };
