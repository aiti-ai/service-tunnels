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
/** True when a process belongs to our instance (marker match). An empty
 * marker means "unknown owner" — we NEVER clean those (avoids killing a
 * concurrent instance's helpers). */
function owns(env: string, marker: string | undefined): boolean {
  if (!env.includes("SERVICE_TUNNELS_ROLE=")) return false;
  if (!marker) return false;
  return env.includes(`SERVICE_TUNNELS_MARKER=${marker}`);
}

export async function killRoleProcesses(
  sig: NodeJS.Signals = "SIGTERM",
  graceMs = 300,
  marker?: string,
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
        const env = readFileSync(`/proc/${pid}/environ`, "utf8");
        if (!owns(env, marker)) continue;
        process.kill(Number(pid), signal);
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
export function killRoleProcessesSync(marker?: string): void {
  if (process.platform !== "linux") return;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (!owns(env, marker)) continue;
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // vanished or not ours
    }
  }
}
