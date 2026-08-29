import { execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { killRoleProcesses, killRoleProcessesSync } from "./cleanup.ts";

/**
 * Parent-death guardian — a tiny detached process that watches a parent pid
 * and, when the parent exits (crash / SIGKILL / normal exit), kills every
 * framework helper still carrying SERVICE_TUNNELS_ROLE and then exits.
 *
 * This closes the orphan gap in both modes:
 *   - CLI: the daemon spawns a guardian watching the daemon itself — if the
 *     daemon is SIGKILLed (no chance to run its own cleanup), the guardian
 *     still reaps nginx/authelia/redis/tunnels.
 *   - Library: createServiceTunnels can spawn a guardian watching the caller
 *     (e.g. host) so a crashed host never leaves helpers behind.
 *
 * Detection, in order of preference:
 *   1. IPC channel (spawned with stdio 'ipc', guardian-spawn.ts): the parent
 *      holds the other end; its death — crash, SIGKILL or graceful exit —
 *      closes the pipe and fires 'disconnect'. Event-driven: zero polling,
 *      zero child_process spawns (this replaces the former 1 Hz tasklist
 *      flash on Windows). 5 s maintenance tick is pure file IO.
 *   2. Fallback poll (spawned without IPC / run directly), cross-platform:
 *      - Linux: process.kill(pid, 0) + /proc/<pid>/stat starttime comparison
 *        to reject pid-reuse false positives
 *      - macOS: process.kill(pid, 0) (ESRCH = parent gone; zombies reaped by init)
 *      - Windows: tasklist /FI "PID eq <pid>" (process.kill(pid,0) semantics
 *        for nonexistent pids are unreliable there)
 *
 * Spawn:  node guardian.ts <parentPid> <parentStarttime?> <intervalMs?>
 */

/** True while the watched parent is (still) the same process. */
export function parentAlive(pid: number, starttime: string): boolean {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return out.includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && starttime) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // field 22 (1-based) is starttime; everything before the comm is pid+comm
      const after = stat.slice(stat.lastIndexOf(")") + 2).trim();
      const fields = after.split(/\s+/);
      // after ')' the first field is state (field 3), so starttime is idx 19
      return fields[19] === starttime;
    }
    return true;
  } catch {
    return false; // ESRCH (or EPERM treated as dead? EPERM means exists — handle below)
  }
}

/** Read the parent's Linux starttime (field 22) for pid-reuse protection. */
export function readStarttime(pid: number): string {
  if (process.platform !== "linux") return "";
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).trim();
    return after.split(/\s+/)[19] ?? "";
  } catch {
    return "";
  }
}

/** Recursively collect ALL descendants of `rootPid` (direct children +

/** Recursively collect ALL descendants of `rootPid` (direct children +
 *  grandchildren + deeper) by walking /proc ppid chains. Done WHILE the
 *  parent is alive so pids are captured before any reparenting; the kill is
 *  by pid, so it stays valid after the parent dies. */
function collectDescendants(rootPid: number): Set<number> {
  const out = new Set<number>();
  let frontier = [rootPid];
  // build pid → ppid once, then BFS
  const ppidOf = new Map<number, number>();
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const p of pids) {
    const n = Number(p);
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      ppidOf.set(n, Number(after[1]) || 0);
    } catch {}
  }
  while (frontier.length) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const [pid, ppid] of ppidOf) {
        if (ppid === parent && !out.has(pid)) {
          out.add(pid);
          next.push(pid);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** Read the registration file (pids our framework spawned and registered). */
function readRegistered(file: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!file) return out;
  try {
    const raw = readFileSync(file, "utf8");
    const arr = JSON.parse(raw) as { pid: number; role: string; t: number }[];
    for (const r of arr) {
      if (r?.pid && Number.isInteger(r.pid) && r.pid > 0) out.add(r.pid);
    }
  } catch {
    // missing / malformed → empty
  }
  return out;
}

/** Clean per-parent artifacts older than `maxAgeMs` whose owner process is
 *  gone (pid no longer exists). Covers tmp/nginx-<pid>/ folders and
 *  registered-pids-<pid>.json. The guardian runs this periodically so stale
 *  folders from long-dead instances don't accumulate. */
function cleanupStaleDirs(cacheDir: string, maxAgeMs = 7 * 24 * 3600 * 1000): void {
  if (!cacheDir) return;
  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const consider = (path: string, pidStr: string) => {
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (pidAlive(pid)) return; // owner still alive → keep
    try {
      const st = statSync(path);
      if (Date.now() - st.mtimeMs > maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // vanished already
    }
  };
  try {
    for (const e of readdirSync(join(cacheDir, "tmp"), { withFileTypes: true })) {
      const m = /^nginx-(\d+)$/.exec(e.name);
      if (m && m[1]) consider(join(cacheDir, "tmp", e.name), m[1]);
    }
  } catch {}
  try {
    for (const f of readdirSync(cacheDir)) {
      const m = /^registered-pids-(\d+)\.json$/.exec(f);
      if (m && m[1]) consider(join(cacheDir, f), m[1]);
    }
  } catch {}
}

async function main(): Promise<void> {
  const parentPid = Number(process.argv[2] ?? 0);
  const parentStarttime = process.argv[3] ? String(process.argv[3]) : "";
  const intervalMs = Number(process.argv[4] ?? 1_000);
  const registrationFile = process.argv[5] || "";
  const cacheDir = process.argv[6] || "";
  if (!parentPid) return;
  // Low-frequency (5s) full-descendant scan + registration read, recorded
  // while the parent is alive; on parent death kill the recorded set + marker.
  const scanIntervalMs = 5_000;
  const cleanupIntervalMs = 6 * 3600 * 1000; // stale-folder sweep every 6h
  let descendants = new Set<number>();
  let registered = new Set<number>();
  let lastCleanup = 0;

  // parent gone — kill everything we recorded (by pid; valid even after
  // reparenting), then marker-scoped stragglers (detached tunnels).
  const reapAndExit = async (): Promise<never> => {
    const marker = process.env.SERVICE_TUNNELS_MARKER ?? "";
    const targets = new Set([...descendants, ...registered]);
    const killSig = (sig: NodeJS.Signals) => {
      let n = 0;
      for (const pid of targets) {
        try {
          process.kill(pid, sig);
          n++;
        } catch {}
      }
      return n;
    };
    const n = killSig("SIGTERM");
    if (n > 0) await new Promise((r) => setTimeout(r, 300));
    killSig("SIGKILL");
    // per-PPID path marker: catches processes that strip their env (nginx's
    // argv still carries `-c .../nginx-<ppid>/nginx.conf`) — a second,
    // path-based ownership signal in addition to the env marker.
    const perPpidPath = `nginx-${parentPid}`;
    try {
      await killRoleProcesses("SIGTERM", 300, marker, parentPid, perPpidPath);
    } catch {
      // fall through to sync variant
    }
    killRoleProcessesSync(marker, parentPid, perPpidPath);
    process.exit(0);
  };

  // Maintenance while the parent is alive: refresh registered pids + snapshot
  // descendants (pure file IO on Linux; no-op-ish on Windows — no /proc — where
  // reaping relies on the registration file + role markers).
  const refresh = () => {
    registered = readRegistered(registrationFile);
    descendants = collectDescendants(parentPid);
    if (Date.now() - lastCleanup >= cleanupIntervalMs) {
      cleanupStaleDirs(cacheDir);
      lastCleanup = Date.now();
    }
  };

  // ── Mode 1: IPC channel (preferred) ──────────────────────────────
  // The channel IS the liveness link: the parent holds the far end, so its
  // death closes the pipe and fires 'disconnect' — no polling, no spawns of
  // any kind. The IPC handle itself keeps this process' loop alive; the
  // maintenance timer is unref'd so it never does.
  if (process.connected) {
    refresh();
    const maint = setInterval(refresh, scanIntervalMs);
    maint.unref?.();
    process.on("disconnect", () => {
      void reapAndExit();
    });
    return;
  }

  // ── Mode 2: legacy poll (no IPC — old spawner or direct run) ────────
  let lastScan = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (parentAlive(parentPid, parentStarttime)) {
      if (Date.now() - lastScan >= scanIntervalMs) {
        descendants = collectDescendants(parentPid);
        registered = readRegistered(registrationFile);
        lastScan = Date.now();
      }
      // periodic sweep of stale per-parent artifacts (older than 7d + owner dead)
      if (Date.now() - lastCleanup >= cleanupIntervalMs) {
        cleanupStaleDirs(cacheDir);
        lastCleanup = Date.now();
      }
      continue;
    }
    await reapAndExit();
  }
}

// run only when invoked directly (node guardian.ts ...), never on import.
// Portable main-detection: import.meta.main is Node >=22.18 / 24.2 only — on
// Node 20 it is silently undefined, which would make the guardian exit
// without polling (helpers orphaned until the next start-time cleanup).
const isMain =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main();
}
