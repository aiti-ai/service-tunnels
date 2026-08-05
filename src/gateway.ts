import { spawn, execFileSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { roleEnv } from "./marker.ts";

/**
 * nginx gateway — the local host that owns auth (design.md §5).
 *
 * Shared infrastructure (one instance per owner pid): listens on
 * 127.0.0.1:<random-port>, routes by Host. Each registered public host is a
 * SEPARATE conf.d/<host>.conf file (per-host auth backend), so one nginx can
 * serve hosts protected by different providers without config conflicts.
 *
 * Config lives under cacheDir/tmp/nginx-<process.pid>/ — scoped per owner so
 * multiple service-tunnels instances never share config/logs/pidfile; the
 * folder is wiped on construction so a fresh run starts clean.
 */

export interface GatewayHost {
  /** Public host (e.g. demo.ngrok-free.app). */
  host: string;
  /** Local app port behind auth. */
  port: number;
  /** Backend port for forward-auth (authelia/oauth2-proxy). Per-host so one
   *  shared nginx can route different hosts to different providers. */
  authPort?: number;
  /** Provider base path (e.g. /authelia) for forward-auth mode. */
  basePath?: string;
  /** "forward-auth" (auth_request → provider), "basic" (auth_basic), or
   *  "none" (plain proxy, no auth but still logged). */
  authMode?: GatewayAuthMode;
  /** htpasswd file for basic mode (per-host). */
  htpasswdFile?: string;
  /** Backend scheme: "http" or "https" (detected by probing the app port).
   *  nginx proxy_pass uses this (https upstreams need proxy_ssl_verify off). */
  scheme?: "http" | "https";
  /** nginx `return 302 <loginRedirect>` target for forward-auth 401. Provider-
   *  specific: portal uses `${basePath}/login?next=`, authelia uses
   *  `${basePath}/?rd=https://$host$request_uri`. Uses nginx vars. */
  loginRedirect?: string;
}

export type GatewayAuthMode = "forward-auth" | "basic" | "none";

export interface GatewayConfig {
  nginxPort: number;
  hosts: GatewayHost[];
  /** Directory for pid/conf/logs (cacheDir/tmp/nginx-<pid>). */
  nginxRoot: string;
}

/** Probe a LOCAL app port to classify its protocol: "http", "https", or
 *  "tcp" (raw — accepts a TCP connection but isn't HTTP/TLS). Used to decide
 *  the forwarding mode (nginx gateway for http/https; direct raw tunnel for
 *  tcp). */
export async function detectProtocol(port: number, timeoutMs = 1500): Promise<"http" | "https" | "tcp"> {
  const probeHttp = () =>
    new Promise<boolean>((resolve) => {
      void import("http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs }, (r) => {
          r.destroy();
          resolve(true); // any HTTP response → plain http
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
    });
  const probeHttps = () =>
    new Promise<boolean>((resolve) => {
      void import("https").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", rejectUnauthorized: false, timeout: timeoutMs }, (r) => {
          r.destroy();
          resolve(true);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
    });
  const probeTcp = () =>
    new Promise<boolean>((resolve) => {
      void import("net").then(({ connect }) => {
        const s = connect(port, "127.0.0.1");
        s.once("connect", () => { s.destroy(); resolve(true); });
        s.once("error", () => { s.destroy(); resolve(false); });
        s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
      });
    });
  if (await probeHttp()) return "http";
  if (await probeHttps()) return "https";
  if (await probeTcp()) return "tcp";
  return "tcp";
}

/** @deprecated use detectProtocol — kept as an http/https alias. */
export async function detectScheme(port: number, timeoutMs = 1500): Promise<"http" | "https"> {
  return (await detectProtocol(port, timeoutMs)) === "https" ? "https" : "http";
}

/** Generate ONE host's server block — written to conf.d/<host>.conf so each
 *  tunnel host is its own file (register/unregister only touches that file).
 *  Auth is per-host: "none" (plain proxy), "basic" (auth_basic), or
 *  "forward-auth" (auth_request → provider). */
export function generateHostNginx(
  h: GatewayHost,
  defaults: { nginxPort: number; nginxRoot: string; authPort?: number; basePath?: string; authMode?: GatewayAuthMode; htpasswdFile?: string },
): string {
  const authMode = h.authMode ?? defaults.authMode ?? "forward-auth";
  const authPort = h.authPort ?? defaults.authPort ?? 0;
  const basePath = h.basePath ?? defaults.basePath ?? "/authelia";
  const htpasswdFile = h.htpasswdFile ?? defaults.htpasswdFile ?? "";
  const nginxPort = defaults.nginxPort;
  const nginxRoot = defaults.nginxRoot;
  const escaped = h.host.replace(/\./g, "\\.");
  const portal = `${basePath}/`;
  const authz = `${basePath}/api/authz/auth-request`;
  const authzPath = authz.replace(/^\//, "");
  const portalPath = portal.replace(/^\//, "");
  const authLine =
    authMode === "basic"
      ? `      auth_basic "service-tunnels";\n      auth_basic_user_file ${htpasswdFile};`
      : authMode === "forward-auth"
        ? `      auth_request /${authzPath};\n      error_page 401 @auth_redirect;`
        : ""; // "none" — plain proxy, no auth (but still logged)
  const authzBlock =
    authMode !== "forward-auth"
      ? ""
      : `    location = /${authzPath} {
      internal;
      proxy_pass http://127.0.0.1:${authPort}/${authzPath};
      proxy_set_header Host $host;
      # the tunnel edge terminates TLS; authelia refuses http target URLs
      proxy_set_header X-Original-URL https://$host$request_uri;
      proxy_set_header X-Original-Method $request_method;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
    }

`;
  const portalBlock =
    authMode !== "forward-auth"
      ? ""
      : `    location /${portalPath} {
      proxy_pass http://127.0.0.1:${authPort}/${portalPath};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
      # WebSocket for the auth provider's SPA (authelia/portal live features),
      # HTTP/1.1 keep-alive + Upgrade. Keep proxy_buffering on (SPA bundles).
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      # buffer the provider's responses fully (SPA bundles) before forwarding:
      # with proxy_buffering off, large responses streamed to an HTTP/2 edge
      # (serveo/cloudflare) can hit ERR_HTTP2_PROTOCOL_ERROR framing issues.
      proxy_buffering on;
    }

`;
  const authFailBlock =
    authMode !== "forward-auth"
      ? ""
      : `    location @auth_redirect {
      internal;
      # absolute https + PUBLIC host (no internal nginx port): nginx would
      # otherwise synthesize http://<host>:<listen-port>/... from the relative
      # path, which is unreachable behind the tunnel.
      return 302 ${h.loginRedirect ?? `https://$host${basePath}/login?next=$request_uri`};
    }

`;
  return `  server {
    listen 127.0.0.1:${nginxPort};
    server_name ${escaped};
    access_log ${nginxRoot}/logs/${h.host}.access.log;
    error_log ${nginxRoot}/logs/${h.host}.error.log warn;

${authzBlock}${portalBlock}${authFailBlock}    location / {
${authLine}
      proxy_pass ${h.scheme === "https" ? `https://127.0.0.1:${h.port}` : `http://127.0.0.1:${h.port}`};${h.scheme === "https" ? `
      proxy_ssl_verify off;
      proxy_ssl_server_name off;` : ""}
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      # WebSocket + SSE through the tunnel: HTTP/1.1 keep-alive + Upgrade
      # (WS would break on the default HTTP/1.0) + no buffering for SSE.
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header X-Accel-Buffering no;
    }
  }`;
}

/** Generate the MAIN gateway nginx.conf with ALL host server blocks inline
 *  (single config — reliable; per-host conf.d + reload had an nginx quirk in
 *  the gateway context where reload didn't serve newly-added hosts). */
export function generateGatewayNginx(cfg: GatewayConfig): string {
  const { nginxPort, hosts, nginxRoot } = cfg;
  const defaultServer = hosts.length
    ? ""
    : `  server {
    listen 127.0.0.1:${nginxPort};
    server_name _;
    return 444;
  }
`;

  return `worker_processes 1;
pid ${nginxRoot}/nginx.pid;
error_log ${nginxRoot}/error.log warn;
daemon off;
# nginx strips inherited env vars (keeps only TZ) unless listed here. The
# guardian finds framework helpers via SERVICE_TUNNELS_ROLE/MARKER in
# /proc/<pid>/environ — without these directives nginx loses them and the
# guardian can't reap nginx on parent death.
env SERVICE_TUNNELS_ROLE;
env SERVICE_TUNNELS_MARKER;

events {
  worker_connections 1024;
}

http {
  access_log ${nginxRoot}/access.log;
  client_max_body_size 0;
  proxy_buffering off;
  # public tunnel hostnames can be long (trycloudflare / ngrok-free-app);
  # the default 64-byte bucket overflows with several of them.
  server_names_hash_bucket_size 128;
  ${defaultServer}
  # each tunnel host is its own file (conf.d/<host>.conf), per-host logs
  include ${nginxRoot}/conf.d/*.conf;
}
`;
}

/** A process-alive check that rejects zombies. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end >= 0 && stat[end + 2] === "Z") return false;
    }
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Pre-assign a free local port. */
async function pickFreePort(avoid?: number): Promise<number> {
  const { createServer } = await import("net");
  for (;;) {
    const p = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
    if (p !== avoid) return p;
  }
}

/** True when something accepts TCP on 127.0.0.1:port. */
async function tcpOpen(port: number): Promise<boolean> {
  const { connect } = await import("net");
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      s.destroy();
      resolve(false);
    });
    s.setTimeout(300, () => {
      s.destroy();
      resolve(false);
    });
  });
}

export interface GatewayControllerOptions {
  configDir: string;
  cacheDir: string;
  /** nginx binary path (resolved by tools/ensure; PATH + sbin default). */
  nginxBin?: string;
  /** 0 = random free port (default). */
  port?: number;
  /** htpasswd file for basic auth mode. */
  htpasswdFile?: string;
  basePath?: string;
  registerInternal: (role: string, port: number) => void;
  unregisterInternal: (role: string) => void;
  /** Called after nginx spawns (pid registration for cleanup). */
  registerPid?: (role: string, pid: number) => void;
  log?: (line: string) => void;
}

export class GatewayController {
  #opts: GatewayControllerOptions;
  #hosts = new Map<string, GatewayHost>();
  #child: ChildProcess | null = null;
  #pidFile = "";
  #nginxRoot = "";
  #port = 0;
  /** Default auth mode/basePath/htpasswd (per-host values win). */
  #authMode: GatewayAuthMode = "forward-auth";
  #htpasswdFile = "";

  constructor(opts: GatewayControllerOptions) {
    this.#opts = opts;
    this.#port = opts.port ?? 0;
    this.#htpasswdFile = opts.htpasswdFile ?? "";
    // per-parent (process.pid) nginx folder — multiple service-tunnels owners
    // (pi-web instances) never share config/logs/pidfile; the folder is wiped
    // on construction so a fresh run starts clean.
    this.#nginxRoot = join(opts.cacheDir, "tmp", `nginx-${process.pid}`);
    rmSync(this.#nginxRoot, { recursive: true, force: true });
    this.#pidFile = join(this.#nginxRoot, "nginx.pid");
  }

  get port(): number {
    return this.#port;
  }

  get nginxBin(): string {
    return this.#opts.nginxBin ?? "nginx";
  }

  /** Resolve nginx binary with a helpful error when missing. */
  async resolveNginx(): Promise<string> {
    const bin = this.nginxBin;
    if (bin !== "nginx") {
      if (!existsSync(bin)) throw new Error(`nginx binary not found: ${bin}`);
      return bin;
    }
    const candidates = ["nginx", "/usr/sbin/nginx", "/usr/local/sbin/nginx", "/opt/homebrew/sbin/nginx"];
    for (const c of candidates) {
      try {
        if (c.includes("/")) {
          if (existsSync(c)) return c;
        } else {
          execFileSync("which", [c], { stdio: "ignore" });
          return c;
        }
      } catch {
        // try next
      }
    }
    throw new Error(
      "nginx not found (checked PATH and /usr/sbin). Install it (apt install nginx) or provide a path via toolPaths.nginx / gateway --nginx-bin.",
    );
  }

  hosts(): GatewayHost[] {
    return [...this.#hosts.values()];
  }

  /** Per-host nginx access/error log paths (for expose log viewing). */
  logPaths(host: string): { access: string; error: string } | null {
    if (!this.#hosts.has(host)) return null;
    return {
      access: join(this.#nginxRoot, "logs", `${host}.access.log`),
      error: join(this.#nginxRoot, "logs", `${host}.error.log`),
    };
  }

  /** True once the nginx worker is listening (shared-instance readiness). */
  async ready(): Promise<boolean> {
    return this.#port > 0 && (await tcpOpen(this.#port));
  }

  /** Write config + `nginx -t` validate (throws on invalid). Auth backend
   *  is per-host now, so no authPort argument. Single config with ALL hosts. */
  async writeConfig(): Promise<void> {
    mkdirSync(this.#nginxRoot, { recursive: true });
    mkdirSync(join(this.#nginxRoot, "logs"), { recursive: true });
    mkdirSync(join(this.#nginxRoot, "conf.d"), { recursive: true });
    const cfg = generateGatewayNginx({
      nginxPort: this.#port,
      nginxRoot: this.#nginxRoot,
      hosts: this.hosts(),
    });
    const confPath = join(this.#nginxRoot, "nginx.conf");
    writeFileSync(confPath, cfg, "utf8");
    // per-host files in conf.d/ (each tunnel host its own server block + logs)
    for (const h of this.hosts()) {
      this.#writeHostFile(h);
    }
    const bin = await this.resolveNginx();
    execFileSync(bin, ["-t", "-c", confPath], { stdio: "ignore" });
  }

  /** Write/refresh one host's conf.d/<host>.conf (its own server block + its
   *  own access/error logs under logs/<host>.*). */
  #writeHostFile(h: GatewayHost): void {
    mkdirSync(join(this.#nginxRoot, "logs"), { recursive: true }); // host logs live here
    const body = generateHostNginx(h, {
      nginxPort: this.#port,
      nginxRoot: this.#nginxRoot,
      authPort: h.authPort,
      basePath: h.basePath,
      authMode: h.authMode ?? this.#authMode,
      htpasswdFile: h.htpasswdFile,
    });
    writeFileSync(join(this.#nginxRoot, "conf.d", `${h.host}.conf`), body, "utf8");
  }

  /** Validate a public host BEFORE it reaches any file path or nginx config.
   *  Hosts come from tunnel-edge URLs (external services) or the caller —
   *  never trust them: `new URL(...).host` happily yields `evil;{}` etc., and
   *  the host is interpolated into server_name / access_log / conf.d filenames.
   *  Accept bare domains only (optionally with :port, port is stripped).
   *  @returns the safe hostname (port stripped) or throws on invalid input. */
  #sanitizeHost(host: string): string {
    if (typeof host !== "string" || host.length === 0 || host.length > 253) {
      throw new Error(`invalid host: ${JSON.stringify(host)}`);
    }
    // strip :port (bore-style URLs synthesize host:port)
    const hostname = host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
    // bare DNS label: letters/digits/dots/hyphens only, no leading/trailing
    // dot or hyphen, no other punctuation (;{}'"\\/ whitespace all rejected)
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(hostname) || hostname.includes("..")) {
      throw new Error(`invalid host: ${JSON.stringify(host)}`);
    }
    return hostname.toLowerCase();
  }

  /** Register a host (with its auth backend) → write its conf.d file → restart. */
  async registerHost(
    host: string,
    port: number,
    auth?: { authPort?: number; basePath?: string; authMode?: GatewayAuthMode; htpasswdFile?: string; loginRedirect?: string; scheme?: "http" | "https" },
  ): Promise<void> {
    const safe = this.#sanitizeHost(host);
    this.#hosts.set(safe, {
      host: safe,
      port,
      authPort: auth?.authPort,
      basePath: auth?.basePath,
      authMode: auth?.authMode ?? this.#authMode,
      htpasswdFile: auth?.htpasswdFile ?? (this.#htpasswdFile || undefined),
      loginRedirect: auth?.loginRedirect,
      scheme: auth?.scheme,
    });
    mkdirSync(join(this.#nginxRoot, "conf.d"), { recursive: true });
    this.#writeHostFile(this.#hosts.get(safe)!);
    await this.#restart();
  }

  async unregisterHost(host: string): Promise<void> {
    const safe = this.#sanitizeHost(host);
    this.#hosts.delete(safe);
    rmSync(join(this.#nginxRoot, "conf.d", `${safe}.conf`), { force: true });
    await this.#restart();
  }

  /** HARD restart nginx (kill + respawn) so the conf.d host files are read
   *  fresh — `nginx -s reload` does NOT reliably pick up newly-added conf.d
   *  files in this environment (host never served, fell to the 444 default).
   *  A fresh start reads conf.d correctly. */
  async #restart(): Promise<void> {
    await this.writeConfig(); // regenerate main + host files + nginx -t
    if (!this.#child || !alive(this.#child.pid ?? 0)) {
      return; // nginx not running yet — start() will pick the config up
    }
    const bin = await this.resolveNginx();
    const confPath = join(this.#nginxRoot, "nginx.conf");
    // stop old master (SIGTERM, wait, SIGKILL)
    const old = this.#child;
    try {
      old.kill("SIGTERM");
    } catch {}
    this.#child = null;
    if (old.pid) {
      const dl = Date.now() + 1500;
      while (Date.now() < dl && alive(old.pid)) await new Promise((r) => setTimeout(r, 50));
      try { if (alive(old.pid)) old.kill("SIGKILL"); } catch {}
    }
    // spawn fresh (same as start())
    const child = spawn(bin, ["-c", confPath], {
      env: { ...process.env, ...roleEnv("nginx") },
      stdio: ["ignore", "ignore", "ignore"],
    });
    this.#child = child;
    this.#opts.log?.(`nginx restart (${this.#hosts.size} hosts)`);
    await new Promise((r) => setTimeout(r, 300));
  }

  /** Green start: pick port, write config, spawn nginx, register internal. */
  async start(authMode?: GatewayAuthMode): Promise<number> {
    if (authMode) this.#authMode = authMode;
    if (this.#child && alive(this.#child.pid ?? 0) && (await tcpOpen(this.#port))) {
      return this.#port;
    }
    if (!this.#port) this.#port = await pickFreePort();
    rmSync(this.#pidFile, { force: true });
    await this.writeConfig();
    const bin = await this.resolveNginx();
    const confPath = join(this.#nginxRoot, "nginx.conf");
    // stdio MUST be "ignore" (not pipes): with `daemon off` + pipe stdio the
    // nginx worker doesn't serve requests (Empty reply). nginx stderr goes to
    // its own error.log in the config.
    const child = spawn(bin, ["-c", confPath], {
      env: { ...process.env, ...roleEnv("nginx") },
      stdio: ["ignore", "ignore", "ignore"],
    });
    this.#child = child;
    this.#opts.registerPid?.("nginx", child.pid ?? 0);
    this.#opts.registerInternal("nginx", this.#port);
    this.#opts.log?.(`nginx gateway on 127.0.0.1:${this.#port}`);
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null) {
      this.#child = null;
      throw new Error(`nginx gateway exited during startup (${child.exitCode}) — port ${this.#port} likely in use`);
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await tcpOpen(this.#port))) {
      if (child.exitCode !== null) {
        this.#child = null;
        throw new Error(`nginx gateway exited during startup (${child.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await tcpOpen(this.#port))) throw new Error("nginx gateway failed to start");
    return this.#port;
  }

  /** Stop nginx (config stays for next start). */
  async stop(): Promise<void> {
    if (this.#child) {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        // gone
      }
      this.#child = null;
    } else if (existsSync(this.#pidFile)) {
      try {
        const pid = Number(readFileSync(this.#pidFile, "utf8").trim());
        process.kill(pid, "SIGTERM");
      } catch {
        // gone
      }
    }
    this.#opts.unregisterInternal("nginx");
    rmSync(this.#pidFile, { force: true });
  }
}
