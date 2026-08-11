import { type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { readStarttime } from "./guardian.ts";
import { spawnNode } from "./spawn-node.ts";

/**
 * Spawn the parent-death guardian (detached, unref'd). The guardian polls the
 * given parent pid; when it exits it kills every SERVICE_TUNNELS_ROLE helper
 * (see guardian.ts). Returns the child (or null when unsupported).
 */

function guardianEntry(): string | null {
  const dir = dirname(fileURLToPath(import.meta.url));
  const ts = resolve(dir, "guardian.ts");
  if (existsSync(ts)) return ts;
  const js = resolve(dir, "guardian.js");
  return existsSync(js) ? js : null;
}

export function spawnGuardian(
  parentPid: number,
  opts: { intervalMs?: number; registrationFile?: string; cacheDir?: string; nodePath?: string } = {},
): ChildProcess | null {
  const entry = guardianEntry();
  if (!entry || !parentPid) return null;
  const starttime = readStarttime(parentPid);
  const child = spawnNode(
    opts.nodePath,
    [entry, String(parentPid), starttime, String(opts.intervalMs ?? 1_000), opts.registrationFile ?? "", opts.cacheDir ?? ""],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  child.unref();
  return child;
}
