import { spawnSync } from "child_process";
import { connect } from "net";
import { existsSync, mkdirSync, readFileSync, openSync, closeSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { ServicePortInfo } from "./discovery.ts";
import { readState } from "./state.ts";
import { cachePaths } from "./config.ts";
import { killRoleProcesses } from "./cleanup.ts";
import { ensureMarker } from "./marker.ts";
import { spawnNode } from "./spawn-node.ts";

/**
 * Daemon controller — CLI-mode process model.
 *
 * Library mode needs no daemon (the manager lives in the caller's process).
 * CLI mode spawns a detached `daemon-server.ts` that owns framework helpers
 * and tunnels; every other command locates it via state.json and speaks
 * JSON-RPC over its socket.
 */

const DAEMON_SERVER = (() => {
  const dir = dirname(fileURLToPath(import.meta.url));
  // dev (type-stripped .ts) vs published (compiled .js) layout
  const ts = resolve(dir, "daemon-server.ts");
  return existsSync(ts) ? ts : resolve(dir, "daemon-server.js");
})();

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  ipc: string | null;
}

/**
 * True when the given pid is a live process. Linux: rejects zombies — a
 * daemon we spawned detached and unref'd becomes a zombie after exit (nobody
 * reaps it) and process.kill(pid, 0) succeeds on zombies; /proc/<pid>/stat
 * state 'Z' disambiguates.
 */
export function pidAlive(pid: number): boolean {
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

/** Read the daemon's location from state.json and check liveness. */
export function daemonStatus(cacheDir: string): DaemonStatus {
  const { stateFile } = cachePaths(cacheDir);
  const state = readState(stateFile);
  const d = state.daemon;
  if (!d) return { running: false, pid: null, ipc: null };
  const path = ipcPath(d.ipc);
  const alive =
    pidAlive(d.pid) && (path === null || existsSync(path)); // tcp: no file to check
  return { running: alive, pid: d.pid, ipc: d.ipc };
}

function ipcPath(ipc: string): string | null {
  if (ipc.startsWith("unix://")) return ipc.slice("unix://".length);
  return null;
}

/**
 * Start the daemon (detached). Idempotent — returns the existing one if it is
 * already running. With `foreground` the daemon runs attached to this process
 * (debug/containers); otherwise setsid-detached with output to a log file.
 */
export function startDaemon(
  cacheDir: string,
  opts: { foreground?: boolean; logFile?: string; configDir?: string; env?: Record<string, string>; nodePath?: string } = {},
): DaemonStatus {
  const existing = daemonStatus(cacheDir);
  if (existing.running) return existing;

  // A daemon that is alive but unreachable (its IPC socket file was deleted,
  // e.g. a temp dir cleaned while it still ran) reports as not-running here;
  // reap it by pid BEFORE spawning a replacement so broken instances never
  // accumulate (their helper tree dies with them).
  const stale = readState(cachePaths(cacheDir).stateFile).daemon;
  if (stale?.pid != null && pidAlive(stale.pid)) {
    try {
      process.kill(stale.pid, "SIGTERM");
    } catch {}
    const dl = Date.now() + 2_000;
    while (Date.now() < dl && pidAlive(stale.pid)) {
      spawnSync("sleep", ["0.05"], { stdio: "ignore" });
    }
    try {
      if (pidAlive(stale.pid)) process.kill(stale.pid, "SIGKILL");
    } catch {}
  }

  ensureMarker(); // scope cleanup to this instance (daemon inherits it)
  const { stateFile, daemonSock } = cachePaths(cacheDir);
  const configDir = opts.configDir ?? join(dirname(cacheDir), "config");
  mkdirSync(dirname(stateFile), { recursive: true });

  if (opts.foreground) {
    const child = spawnNode(opts.nodePath, [DAEMON_SERVER, stateFile, daemonSock, configDir, cacheDir], {
      stdio: "inherit",
    });
    return { running: true, pid: child.pid ?? null, ipc: null };
  }

  const logPath = opts.logFile ?? `${stateFile}.daemon.log`;
  // 修复死代码：daemon 后台模式 stderr 落盘（此前 stdio 全 ignore——console.error
  // 全丢，CLI 报错时 "check daemon logs" 却无日志可看）。
  const logFd = openSync(logPath, "a");
  const child = spawnNode(opts.nodePath, [DAEMON_SERVER, stateFile, daemonSock, configDir, cacheDir], {
    detached: true,
    stdio: ["ignore", "ignore", logFd],
    env: { ...process.env, ...opts.env },
  });
  child.on("exit", () => {
    try {
      closeSync(logFd);
    } catch { /* already closed */ }
  });
  child.unref();
  return { running: true, pid: child.pid ?? null, ipc: null };
}

/** Send a JSON-RPC request to the running daemon (or null when unavailable). */
export async function requestDaemon<T>(
  cacheDir: string,
  method: string,
  params?: unknown,
  timeoutMs = 5_000,
): Promise<T | null> {
  const status = daemonStatus(cacheDir);
  if (!status.running || !status.ipc) return null;
  const path = ipcPath(status.ipc);
  if (path) {
    // POSIX: newline-delimited JSON over the 0600 unix socket
    return new Promise<T | null>((resolvePromise) => {
      const socket = connect(path);
      const timer = setTimeout(() => {
        socket.destroy();
        resolvePromise(null);
      }, timeoutMs);
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        clearTimeout(timer);
        socket.destroy();
        try {
          const resp = JSON.parse(line) as { result?: T; error?: string };
          resolvePromise(resp.error ? null : (resp.result ?? null));
        } catch {
          resolvePromise(null);
        }
      });
      socket.on("error", () => {
        clearTimeout(timer);
        resolvePromise(null);
      });
    });
  }

  // Windows: HTTP on 127.0.0.1 with the per-instance secret header (the TCP
  // listener rejects requests without it — daemon-server.ts).
  const m = /^tcp:\/\/([^/:]+):(\d+)$/.exec(status.ipc);
  if (!m) return null;
  const { stateFile } = cachePaths(cacheDir);
  const secret = readState(stateFile).daemon?.ipcSecret ?? "";
  try {
    const res = await fetch(`http://127.0.0.1:${m[2]}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-service-tunnels-auth": secret,
      },
      body: JSON.stringify({ id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const resp = (await res.json()) as { result?: T; error?: string };
    return resp.error ? null : (resp.result ?? null);
  } catch {
    return null;
  }
}

/** Stop the daemon: graceful shutdown via IPC, pid fallback when the IPC
 *  socket/state is gone, role-helper reaping by persisted marker. */
export async function stopDaemon(cacheDir: string): Promise<boolean> {
  const { stateFile } = cachePaths(cacheDir);
  const state = readState(stateFile);
  const d = state.daemon;
  const pid = d?.pid ?? null;
  const hadLive = pid != null && pidAlive(pid);
  if (hadLive) {
    // Graceful IPC shutdown first (works while the state + socket aren't
    // deleted). If it fails (socket file already cleaned), fall back to a
    // direct SIGTERM — pidAlive is authoritative, not the socket file.
    const viaIpc = await requestDaemon(cacheDir, "shutdown", undefined, 3_000);
    if (!viaIpc) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && pidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  // Safety net: if the daemon was SIGKILLed before its own cleanup finished,
  // kill any remaining framework helpers by role marker. Prefer the marker we
  // persisted at daemon start (state.json is often the ONLY record left after
  // a temp dir was partially cleaned); fall back to our own env.
  const marker = process.env.SERVICE_TUNNELS_MARKER ?? d?.marker ?? "";
  await killRoleProcesses("SIGTERM", 300, marker);
  // true only when a live daemon existed and is gone now; false when there
  // was nothing to stop (nothing had a daemon since… same as before).
  return hadLive && !pidAlive(pid);
}

/** Convenience: discover ports through the daemon (CLI mode). */
export async function daemonDiscover(cacheDir: string, force: boolean): Promise<ServicePortInfo[] | null> {
  return requestDaemon<ServicePortInfo[]>(cacheDir, "discover", { force });
}
