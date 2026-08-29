import { type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { readStarttime } from "./guardian.ts";
import { spawnNode } from "./spawn-node.ts";

/**
 * Spawn the parent-death guardian (detached, unref'd). The guardian holds an
 * IPC channel back to us — our death (crash / SIGKILL / graceful exit) closes
 * the channel and fires 'disconnect' in the guardian, which then kills every
 * SERVICE_TUNNELS_ROLE helper (see guardian.ts). Event-driven: no polling on
 * either side; on Windows this removes the former 1 Hz `tasklist` probes.
 * Returns the child (or null when unsupported).
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
    // intervalMs is only used by the legacy poll fallback (no-IPC mode); with
    // the channel present detection is purely event-driven.
    [entry, String(parentPid), starttime, String(opts.intervalMs ?? 1_000), opts.registrationFile ?? "", opts.cacheDir ?? ""],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  child.unref();
  // Unref the channel so the IPC fd doesn't pin OUR event loop — the fd stays
  // open (the guardian keeps watching it) but a graceful exit of this process
  // is not blocked. On death the kernel closes it and the guardian reaps.
  (child as { channel?: { unref?: () => void } | undefined }).channel?.unref?.();
  return child;
}
