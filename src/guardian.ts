import { execFileSync } from "child_process";
import { readFileSync } from "fs";
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
 *     (e.g. pi-web) so a crashed host never leaves helpers behind.
 *
 * Detection is a cross-platform poll (no native deps):
 *   - Linux: process.kill(pid, 0) + /proc/<pid>/stat starttime comparison to
 *     reject pid-reuse false positives
 *   - macOS: process.kill(pid, 0) (ESRCH = parent gone; zombies reaped by init)
 *   - Windows: tasklist /FI "PID eq <pid>" (process.kill(pid,0) semantics for
 *     nonexistent pids are unreliable there)
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

async function main(): Promise<void> {
  const parentPid = Number(process.argv[2] ?? 0);
  const parentStarttime = process.argv[3] ? String(process.argv[3]) : "";
  const intervalMs = Number(process.argv[4] ?? 1_000);
  if (!parentPid) return;
  // loop forever; on parent death, reap role-marked helpers then exit
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (parentAlive(parentPid, parentStarttime)) continue;
    // parent gone — clean up OUR helpers only (marker-scoped: concurrent
    // instances and other tests are never touched), then exit
    const marker = process.env.SERVICE_TUNNELS_MARKER ?? "";
    try {
      await killRoleProcesses("SIGTERM", 300, marker);
    } catch {
      // fall through to sync variant
    }
    killRoleProcessesSync(marker);
    process.exit(0);
  }
}

// run only when invoked directly (node guardian.ts ...), never on import
if (import.meta.main) {
  void main();
}
