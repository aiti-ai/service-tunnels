import { spawn, execFileSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { roleEnv } from "./marker.ts";

/**
 * nginx gateway — the local host that owns auth (design.md §5).
 *
 * Shared infrastructure (one instance): listens on 127.0.0.1:<random-port>,
 * routes by Host. Each registered public host gets a server block:
 *   - `/`        → the app (protected by auth_request → provider)
 *   - `/authelia/` → the auth portal (provider mount, base-path deploy)
 *   - `/authelia/api/authz/auth-request` → internal auth_request endpoint
 *
 * The gateway config is generated + validated (`nginx -t`) + hot-reloaded
 * (`nginx -s reload`) when hosts are registered/removed. Port defaults to a
 * random free port (0) — every component (nginx/authelia/redis) is
 * auto-assigned so nothing clashes.
 *
 * nginx binary resolution: system PATH → /usr/sbin (non-root PATH lacks it)
 * → /usr/local/sbin; no download (apt/package-manager install; Windows uses
 * the official zip via tools.ts if configured).
 */

export interface GatewayHost {
  /** Public host (e.g. demo.ngrok-free.app). */
  host: string;
  /** Local app port behind auth. */
  port: number;
}

export interface GatewayConfig {
  nginxPort: number;
  autheliaPort: number;
  /** Provider base path (e.g. /authelia). */
  basePath: string;
  hosts: GatewayHost[];
  /** Directory for pid/conf/logs (cacheDir/tmp/nginx). */
  nginxRoot: string;
}

/** Generate the full gateway nginx.conf. */
export function generateGatewayNginx(cfg: GatewayConfig): string {
  const { nginxPort, autheliaPort, basePath, hosts, nginxRoot } = cfg;
  const portal = `${basePath}/`;
  const authz = `${basePath}/api/authz/auth-request`;

  const defaultServer = hosts.length
    ? ""
    : `  server {
    listen 127.0.0.1:${nginxPort};
    server_name _;
    return 444;
  }
`;
  const blocks = defaultServer + hosts
    .map((h) => {
      const escaped = h.host.replace(/\./g, "\\.");
      const authzPath = authz.replace(/^\//, "");
      const portalPath = portal.replace(/^\//, "");
      return `  server {
    listen 127.0.0.1:${nginxPort};
    server_name ${escaped};

    location = /${authzPath} {
      internal;
      proxy_pass http://127.0.0.1:${autheliaPort}/${authzPath};
      proxy_set_header Host $host;
      # the tunnel edge terminates TLS; authelia refuses http target URLs
      proxy_set_header X-Original-URL https://$host$request_uri;
      proxy_set_header X-Original-Method $request_method;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-Host $host;
    }

    location /${portalPath} {
      proxy_pass http://127.0.0.1:${autheliaPort}/${portalPath};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
    }

    location / {
      auth_request /${authzPath};
      proxy_pass http://127.0.0.1:${h.port};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }
  }`;
    })
    .join("\n");

  return `worker_processes 1;
pid ${nginxRoot}/nginx.pid;
error_log ${nginxRoot}/error.log warn;
daemon off;

events {
  worker_connections 1024;
}

http {
  access_log ${nginxRoot}/access.log;
  client_max_body_size 0;
  proxy_buffering off;

  ${blocks}
}`;
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
async function pickFreePort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
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
  basePath?: string;
  registerInternal: (role: string, port: number) => void;
  unregisterInternal: (role: string) => void;
  log?: (line: string) => void;
}

export class GatewayController {
  #opts: GatewayControllerOptions;
  #hosts = new Map<string, number>();
  #child: ChildProcess | null = null;
  #pidFile = "";
  #nginxRoot = "";
  #port = 0;

  constructor(opts: GatewayControllerOptions) {
    this.#opts = opts;
    this.#port = opts.port ?? 0;
    this.#nginxRoot = join(opts.cacheDir, "tmp", "nginx");
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
    // system installs live in sbin dirs not on a non-root user's PATH
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
    return [...this.#hosts.entries()].map(([host, port]) => ({ host, port }));
  }

  /** Write config + `nginx -t` validate (throws on invalid). */
  async writeConfig(autheliaPort: number): Promise<void> {
    mkdirSync(this.#nginxRoot, { recursive: true });
    const cfg = generateGatewayNginx({
      nginxPort: this.#port,
      autheliaPort,
      basePath: this.#opts.basePath ?? "/authelia",
      hosts: this.hosts(),
      nginxRoot: this.#nginxRoot,
    });
    const confPath = join(this.#nginxRoot, "nginx.conf");
    writeFileSync(confPath, cfg, "utf8");
    const bin = await this.resolveNginx();
    execFileSync(bin, ["-t", "-c", confPath], { stdio: "ignore" });
  }

  /** Register a host → regenerate → validate → hot reload. */
  async registerHost(host: string, port: number, autheliaPort: number): Promise<void> {
    this.#hosts.set(host, port);
    await this.#apply(autheliaPort);
  }

  async unregisterHost(host: string, autheliaPort: number): Promise<void> {
    this.#hosts.delete(host);
    await this.#apply(autheliaPort);
  }

  async #apply(autheliaPort: number): Promise<void> {
    await this.writeConfig(autheliaPort);
    if (this.#child && alive(this.#child.pid ?? 0)) {
      const bin = await this.resolveNginx();
      execFileSync(bin, ["-s", "reload", "-c", join(this.#nginxRoot, "nginx.conf")], { stdio: "ignore" });
      this.#opts.log?.(`nginx reload (${this.#hosts.size} hosts)`);
    }
  }

  /** Green start: pick port, write config, spawn nginx, register internal. */
  async start(autheliaPort: number): Promise<number> {
    if (this.#child && alive(this.#child.pid ?? 0) && (await tcpOpen(this.#port))) {
      return this.#port;
    }
    if (!this.#port) this.#port = await pickFreePort();
    // stale pid file from a crashed/previous nginx would confuse the new one
    rmSync(this.#pidFile, { force: true });
    await this.writeConfig(autheliaPort);
    const bin = await this.resolveNginx();
    const confPath = join(this.#nginxRoot, "nginx.conf");
    const child = spawn(bin, ["-c", confPath], {
      env: { ...process.env, ...roleEnv("nginx") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (c) => this.#opts.log?.(`nginx: ${c.toString().trim()}`));
    this.#child = child;
    this.#opts.registerInternal("nginx", this.#port);
    this.#opts.log?.(`nginx gateway on 127.0.0.1:${this.#port}`);
    // give a failed bind a moment to surface, then verify the child is alive
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null) {
      this.#child = null;
      throw new Error(`nginx gateway exited during startup (${child.exitCode}) — port ${this.#port} likely in use`);
    }
    // wait for the listener (real TCP probe, not the pid file)
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
