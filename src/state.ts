import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Runtime state persisted in cacheDir/state.json (atomic tmp+rename).
 * Never stores secrets — keys live in configDir only (0600).
 */
export interface DaemonState {
  pid: number;
  ipc: string; // "unix://<path>" | "tcp://127.0.0.1:<port>"
  /** Per-instance random secret for Windows TCP IPC (no filesystem peer gate
   *  on TCP). POSIX unix sockets (0600) don't need it. state.json is 0600. */
  ipcSecret?: string;
  /** Cleanup marker of the daemon instance. Persisted so a later stopDaemon
   *  can reap the daemon's role helpers by marker even when the IPC socket
   *  file is gone (temp dir partially cleaned) and the caller doesn't run in
   *  the daemon's environment. state.json is 0600 — no secret leak. */
  marker?: string;
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

/** A persisted proxy enrollment (D4): port → site/label → auth backend. */
export interface BindingRuntimeState {
  port: number;
  label: string;
  site: string;
  provider: string;
  policy?: { policy?: "one_factor" | "two_factor" | "deny"; subject?: string[]; methods?: string[] };
  providerParams?: Record<string, unknown>;
  /** 认证放行白名单（URL 路径前缀）。 */
  bypassPaths?: string[];
}

/** Persisted expose metadata (M0b) — the daemon's expose registry, so the UI
 *  can display exposes (incl. proxy mode, which has no tunnel process) after
 *  a daemon restart. Never stores secrets: params are masked at list time. */
export interface ExposeRuntimeState {
  name: string;
  port: number;
  mode?: string;
  provider?: string;
  protocol?: string;
  site?: string;
  label?: string;
  localUrl?: string;
  baseUrl?: string;
  domainUrl?: string;
  url?: string | null;
  loginUrl?: string;
  tunnelType?: string;
  tunnelName?: string;
  host?: string;
  /** mode=portmap 的映射详情（重启恢复续租用）。 */
  portmap?: {
    backend: string;
    gateway: string;
    externalIp: string;
    externalPort: number;
    internalPort: number;
    leaseSeconds: number;
    method?: string;
    sshRouter?: { host: string; user?: string; port?: number; key?: string; preset: string; connectTimeout?: number };
  };
  /** mode=ipv6 的直连详情（重启后 transport 端口会变，按地址重建）。 */
  ipv6?: {
    address: string;
    addresses?: string[];
  };
  startedAt: number;
}

export interface RuntimeState {
  daemon?: DaemonState;
  internal: InternalPortState[];
  tunnels: Record<string, TunnelRuntimeState>;
  auth: { registered: string[] };
  /** Persisted proxy enrollments (mode proxy/both) — restored on daemon restart. */
  bindings: BindingRuntimeState[];
  /** Persisted expose metadata (M0b) — display only; tunnel processes are
   *  restored by `tunnels` hydrate, bindings by `proxy.restore`. */
  exposes?: ExposeRuntimeState[];
  /** 用户自定义服务识别：端口(十进制字符串) → label。服务页签显示优先于
   *  探测 title（port-identity），这是人工事实，永不覆盖。 */
  serviceLabels?: Record<string, string>;
}

export function emptyState(): RuntimeState {
  return { internal: [], tunnels: {}, auth: { registered: [] }, bindings: [], exposes: [], serviceLabels: {} };
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
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
      exposes: Array.isArray(parsed.exposes) ? parsed.exposes : [],
      serviceLabels: parsed.serviceLabels ?? {},
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
