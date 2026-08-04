import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Runtime state persisted in cacheDir/state.json (atomic tmp+rename).
 * Never stores secrets — keys live in configDir only (0600).
 */
export interface DaemonState {
  pid: number;
  ipc: string; // "unix://<path>" | "tcp://127.0.0.1:<port>"
}

export interface InternalPortState {
  role: string;
  pid: number;
  port: number;
  addresses: string[];
}

export interface TunnelRuntimeState {
  pid: number;
  url: string | null;
}

export interface RuntimeState {
  daemon?: DaemonState;
  internal: InternalPortState[];
  tunnels: Record<string, TunnelRuntimeState>;
  auth: { registered: string[] };
}

export function emptyState(): RuntimeState {
  return { internal: [], tunnels: {}, auth: { registered: [] } };
}

export function readState(stateFile: string): RuntimeState {
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeState>;
    return {
      ...emptyState(),
      ...parsed,
      internal: Array.isArray(parsed.internal) ? parsed.internal : [],
      tunnels: parsed.tunnels ?? {},
      auth: { ...emptyState().auth, ...parsed.auth },
    };
  } catch {
    return emptyState();
  }
}

export function writeState(stateFile: string, state: RuntimeState): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, stateFile);
}

/** Update state.json under a lock-free read-modify-write (single writer assumed:
 *  the daemon, or the library owner process in library mode). */
export function updateState(
  stateFile: string,
  mutate: (s: RuntimeState) => void,
): RuntimeState {
  const state = readState(stateFile);
  mutate(state);
  writeState(stateFile, state);
  return state;
}
