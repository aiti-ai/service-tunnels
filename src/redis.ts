import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { roleEnv } from "./marker.ts";

/**
 * Green redis — session store for providers that need one (authelia).
 * One instance ever (AOF-persisted so sessions survive restarts); started
 * only when the selected provider has needsSessionStore.
 *
 * Binary resolution: system redis-server (no download — apt/package-manager;
 * Windows: WSL2/Memurai/tporadowski per design.md).
 */

export interface RedisControllerOptions {
  cacheDir: string;
  /** 0 = pick a free port. */
  port?: number;
  redisBin?: string;
  log?: (line: string) => void;
  /** Called after redis spawns (pid registration for cleanup). */
  registerPid?: (role: string, pid: number) => void;
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
    s.setTimeout(500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

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

export class RedisController {
  #opts: RedisControllerOptions;
  #child: ChildProcess | null = null;
  #port: number;
  #dataDir: string;

  constructor(opts: RedisControllerOptions) {
    this.#opts = opts;
    this.#port = opts.port ?? 0;
    this.#dataDir = join(opts.cacheDir, "data", "redis");
  }

  get port(): number {
    return this.#port;
  }

  async resolveRedis(): Promise<string> {
    if (this.#opts.redisBin) {
      if (!this.#opts.redisBin.startsWith("/") || !this.#opts.redisBin) return this.#opts.redisBin;
    }
    try {
      const { execFileSync } = await import("child_process");
      execFileSync("which", ["redis-server"], { stdio: "ignore" });
      return "redis-server";
    } catch {
      throw new Error(
        "redis-server not found on PATH. Install it (apt install redis-server) or set toolPaths.redis. Windows: use WSL2/Memurai/tporadowski.",
      );
    }
  }

  /** Green start (AOF persisted). Port is pre-assigned (free port) so the
   *  caller never has to parse redis output. */
  async start(): Promise<number> {
    if (this.#child && alive(this.#child.pid ?? 0)) return this.#port;
    const bin = await this.resolveRedis();
    mkdirSync(this.#dataDir, { recursive: true });
    if (!this.#port) this.#port = await pickFreePort();
    const child = spawn(
      bin,
      [
        "--port", String(this.#port),
        "--bind", "127.0.0.1",
        "--appendonly", "yes",
        "--dir", this.#dataDir,
        "--daemonize", "no",
        "--save", '""',
        "--protected-mode", "yes",
      ],
      { env: { ...process.env, ...roleEnv("redis") }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr?.on("data", (c) => this.#opts.log?.(`redis: ${c.toString().trim()}`));
    this.#child = child;
    this.#opts.registerPid?.("redis", child.pid ?? 0);
    // wait for the listener
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (alive(child.pid ?? 0) && (await tcpOpen(this.#port))) return this.#port;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("redis-server failed to start (check redis-server on PATH)");
  }

  async stop(): Promise<void> {
    if (this.#child) {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        // gone
      }
      this.#child = null;
    }
  }
}
