/**
 * Spawn node scripts with the correct runtime.
 *
 * In plain Node this is just `spawn(process.execPath, ...)` — the historic
 * behavior. In Electron hosts (VS Code extension host, other editor hosts)
 * `process.execPath` is the Electron/VS Code binary, NOT node: spawning it
 * with a script would launch the app instead of running the script. Setting
 * `ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave as a plain Node
 * runtime — VS Code itself uses this mechanism when forking the extension
 * host, and it is the established pattern for extensions that need to spawn
 * their own node scripts (e.g. qwen-code, Dendron).
 *
 * Detection covers BOTH the host directly (`process.versions.electron` set)
 * and daemon/guardian children we spawned under Electron (the
 * `ELECTRON_RUN_AS_NODE` env var is inherited automatically) — so a daemon
 * spawned under Electron keeps spawning its portal/token servers correctly
 * with no extra wiring.
 */
import { spawn, type SpawnOptions, type ChildProcess } from "child_process";

/** True when we run inside an Electron runtime (VS Code extension host, or a
 *  child we spawned under ELECTRON_RUN_AS_NODE). */
export function isElectronRuntime(): boolean {
  return (
    !!(process.versions as { electron?: string }).electron ||
    process.env.ELECTRON_RUN_AS_NODE === "1"
  );
}

/**
 * Spawn a node script (ESM/CJS) on the node runtime. `opts.env` is preserved
 * (PORT/SECRET/etc.) and `ELECTRON_RUN_AS_NODE` is forced on in Electron mode.
 *
 * @param nodePath Explicit runtime binary override (library `nodePath`
 *   option). Default: `process.execPath`. In an Electron host the override is
 *   still expected to be the Electron binary unless a dedicated node is used.
 * @param args Script + arguments.
 * @param opts Spawn options (env/stdio/detached/...).
 */
export function spawnNode(
  nodePath: string | undefined,
  args: string[],
  opts: SpawnOptions = {},
): ChildProcess {
  const env = isElectronRuntime()
    ? { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: "1" }
    : (opts.env ?? process.env);
  return spawn(nodePath ?? process.execPath, args, { ...opts, env });
}
