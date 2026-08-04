import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import type { Duplex } from "stream";
import { stripBasePath } from "./discovery.ts";

/**
 * Wildcard-host reverse proxy (zero dependencies).
 *
 * A request whose Host is `<port><suffix>` (e.g. `5173.pi.localhost`) is
 * forwarded to `http://127.0.0.1:<port>` with the path left untouched, so the
 * proxied app's absolute URLs (/assets/..., /api/..., form actions, fetches)
 * keep resolving within the same virtual host.
 *
 * Security:
 *   - the allow-list is the discovery cache (see discovery.ts): ports not
 *     found on the caller's process tree return 403 — a remote attacker can
 *     never pivot to unrelated local services (Redis/MySQL/...),
 *   - the suffix regex doubles as the host allow-list: `.pi.localhost` is
 *     loopback; remote suffixes must be explicitly configured (allowedHosts /
 *     suffixes) — DNS rebinding cannot reach anything else,
 *   - optional Basic password gate.
 *
 * Streaming is natural (pipes, no buffering) so SSE/streams work;
 * WebSocket upgrades are forwarded via the `upgrade` event.
 */

export interface ServiceHostMatch {
  port: number;
  /** The configured suffix that matched (without dot), e.g. "pi.localhost". */
  suffix: string;
}

/** Build the virtual-host regex for the given suffixes + allowed hosts. */
export function serviceHostRegex(suffixes: string[]): RegExp {
  const alts = suffixes.map((s) =>
    s.trim().replace(/^\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^(\\d{2,5})\\.(${alts.join("|")})$`, "i");
}

/**
 * Parse a Host header into { port, suffix } when it is a service virtual
 * host (`<port>.<suffix>`). Port range 10–65535 (2–5 digits, valid port).
 */
export function parseServiceHost(host: string | undefined, suffixes: string[]): ServiceHostMatch | null {
  if (!host) return null;
  const hostname = host.split(":")[0]!.toLowerCase();
  const re = serviceHostRegex(suffixes);
  const m = re.exec(hostname);
  if (!m) return null;
  const port = Number(m[1]!);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { port, suffix: m[2]! };
}

export interface ProxyOptions {
  /** Listen port (default 4180; 0 = random). */
  port?: number;
  /** Accepted virtual-host suffixes (default [".pi.localhost"]). */
  suffixes?: string[];
  /** Extra full hostnames accepted as suffixes (deployment at pi.example.com). */
  allowedHosts?: string[];
  /** Strip this base path before forwarding (e.g. "/dev" → service sees "/"). */
  basePath?: string;
  /** Optional Basic password (empty = disabled). */
  password?: string;
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

export function createProxyServer(opts: ProxyOptions): Server {
  const {
    port = 4180,
    basePath = "",
    password = "",
    log = () => {},
  } = opts;
  const suffixes = [...(opts.suffixes ?? [".pi.localhost"])];
  for (const h of opts.allowedHosts ?? []) {
    const s = `.${h.trim().replace(/^\./, "")}`;
    if (!suffixes.includes(s)) suffixes.push(s);
  }
  const isAllowed = opts.isPortAllowed ?? (() => true);
  const strip = (pathname: string) => stripBasePath(pathname, basePath);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = parseServiceHost(req.headers.host, suffixes);

    if (!match) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("service-tunnels: unknown virtual host");
      return;
    }
    if (!isAllowed(match.port)) {
      log(`deny ${req.headers.host} → ${match.port} (not in allow-list)`);
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("service-tunnels: service port not allowed");
      return;
    }
    if (password && !validBasicAuth(req.headers.authorization, password)) {
      log(`auth 401 ${req.headers.host}`);
      res.writeHead(401, {
        "cache-control": "no-store",
        "www-authenticate": 'Basic realm="service-tunnels", charset="UTF-8"',
      });
      res.end("Authentication required");
      return;
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
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
  }

  // WebSocket / upgrade forwarding.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = parseServiceHost(req.headers.host, suffixes);
    if (!match || !isAllowed(match.port) || (password && !validBasicAuth(req.headers.authorization, password))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const path = strip(req.url?.split("?")[0] ?? "/") + (req.url?.includes("?") ? `?${req.url.split("?")[1]}` : "");
    const proxyReq = httpRequest({
      host: "127.0.0.1",
      port: match.port,
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
  });

  server.listen(port);
  return server;
}

/** Convenience: build the basic-auth header value for the password gate. */
export { authHeader };
