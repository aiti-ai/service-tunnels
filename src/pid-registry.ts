import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * PID registration — every framework process we spawn (tunnels, nginx, redis,
 * auth providers) registers its pid here so the parent-death guardian can reap
 * it reliably (by pid, regardless of reparenting / env-stripping / detached
 * sessions). The guardian reads this file on its low-frequency scan.
 *
 * File: <cacheDir>/registered-pids-<parentPid>.json — scoped PER PARENT so
 * multiple service-tunnels owners (e.g. several pi-web instances) never share
 * a registration file and a guardian can't reap another owner's children.
 */

export function registrationFilePath(cacheDir: string, parentPid: number): string {
  return join(cacheDir, `registered-pids-${parentPid}.json`);
}

/** Register a spawned child pid. Cheap (in-memory array + occasional write). */
export function registerPid(cacheDir: string, parentPid: number, role: string, pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    const file = registrationFilePath(cacheDir, parentPid);
    mkdirSync(cacheDir, { recursive: true });
    let arr: { pid: number; role: string; t: number }[] = [];
    try {
      const raw = existsSync(file) ? readFileSync(file, "utf8") : "[]";
      arr = JSON.parse(raw) as { pid: number; role: string; t: number }[];
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
    // replace same pid, cap size, prune dead pids opportunistically
    arr = arr.filter((r) => r.pid !== pid && r.pid > 0);
    arr.push({ pid, role, t: Date.now() });
    if (arr.length > 500) arr = arr.slice(-500);
    writeFileSync(file, JSON.stringify(arr), "utf8");
  } catch {
    // best-effort — registration must never break spawning
  }
}
