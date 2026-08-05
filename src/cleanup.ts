import { readdirSync, readFileSync } from "fs";

/**
 * Cleanup by role marker — every framework helper (nginx/authelia/redis/
 * tunnels) carries SERVICE_TUNNELS_ROLE in its environment (spawned by us,
 * survives re-parenting). This is the safety net that makes sure nothing
 * becomes an orphan when the daemon (or a library owner) exits: SIGTERM,
 * grace, SIGKILL.
 *
 * Pure function so both the daemon's shutdown handler and CLI clients
 * (stop-all) can call it.
 */
/** True when a process belongs to our instance. Ownership is decided by TWO
 *  independent signals:
 *   1. the role env marker (SERVICE_TUNNELS_ROLE + matching MARKER), and/or
 *   2. the process's command line referencing a PER-PPID path we created
 *      (nginx-<parentPid>/ config, registered-pids-<parentPid>.json).
 *  The path check is what catches nginx: it strips its inherited env (the
 *  marker is invisible in /proc/<pid>/environ even with `env` directives),
 *  but its argv still carries `-c .../nginx-<ppid>/nginx.conf`. An empty
 *  marker + no path = unknown owner — we NEVER clean those (avoids killing
 *  a concurrent instance's helpers). */
function owns(env: string, cmdline: string, marker: string | undefined, perPpidPath?: string): boolean {
  if (perPpidPath && cmdline.includes(perPpidPath)) return true;
  if (!env.includes("SERVICE_TUNNELS_ROLE=")) return false;
  if (!marker) return false;
  return env.includes(`SERVICE_TUNNELS_MARKER=${marker}`);
}

/** True when a process is a DIRECT child of `parentPid`. nginx strips its
 *  inherited env (marker invisible in /proc/<pid>/environ even with `env`
 *  directives — verified), so the guardian ALSO matches by PPID to reap
 *  framework children that reparent-independent marker detection can't see. */
function isDirectChild(pid: number, parentPid?: number): boolean {
  if (!parentPid) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // fields: pid (comm) state ppid ... — comm can contain spaces/parens, so
    // take everything after the LAST ')' then the third field is ppid.
    const after = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return Number(after[1]) === parentPid;
  } catch {
    return false;
  }
}

export async function killRoleProcesses(
  sig: NodeJS.Signals = "SIGTERM",
  graceMs = 300,
  marker?: string,
  parentPid?: number,
  perPpidPath?: string,
): Promise<number> {
  if (process.platform !== "linux") return 0;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return 0;
  }
  const kill = (list: string[], signal: NodeJS.Signals) => {
    let n = 0;
    for (const pid of list) {
      try {
        const numPid = Number(pid);
        const env = readFileSync(`/proc/${pid}/environ`, "utf8");
        let cmdline = "";
        try {
          cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        } catch {}
        if (!owns(env, cmdline, marker, perPpidPath) && !isDirectChild(numPid, parentPid)) continue;
        process.kill(numPid, signal);
        n++;
      } catch {
        // vanished or not ours
      }
    }
    return n;
  };
  const killed = kill(pids, sig);
  if (killed && graceMs > 0) {
    await new Promise((r) => setTimeout(r, graceMs));
    kill(pids, "SIGKILL");
  }
  return killed;
}

/** Synchronous variant for signal handlers (no await available). */
export function killRoleProcessesSync(marker?: string, parentPid?: number, perPpidPath?: string): void {
  if (process.platform !== "linux") return;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      const numPid = Number(pid);
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      } catch {}
      if (!owns(env, cmdline, marker, perPpidPath) && !isDirectChild(numPid, parentPid)) continue;
      process.kill(numPid, "SIGKILL");
    } catch {
      // vanished or not ours
    }
  }
}
