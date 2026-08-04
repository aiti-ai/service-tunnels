import { resolveDirs, cachePaths, type DirOptions, type ServiceTunnelsDirs } from "./config.ts";
import { InternalRegistry } from "./internal.ts";
import {
  discoverServicePorts,
  getServicePorts,
  isServicePortAllowed,
  expandListeningAddresses,
  decodeIpv4,
  decodeIpv6,
  parseLsofAddress,
  parseNetstatAddress,
  stripBasePath,
  type ServicePortInfo,
  type DiscoveryOptions,
} from "./discovery.ts";
import { ensureMarker } from "./marker.ts";
import {
  daemonStatus,
  startDaemon,
  stopDaemon,
  requestDaemon,
  type DaemonStatus,
} from "./daemon.ts";
import { readState } from "./state.ts";

export type { ServicePortInfo, DiscoveryOptions } from "./discovery.ts";
export type { ServiceTunnelsDirs, DirOptions } from "./config.ts";
export type { DaemonStatus } from "./daemon.ts";

export {
  expandListeningAddresses,
  decodeIpv4,
  decodeIpv6,
  parseLsofAddress,
  parseNetstatAddress,
  stripBasePath,
} from "./discovery.ts";

export { InternalRegistry } from "./internal.ts";

export interface ServiceTunnelsOptions extends DirOptions {
  /** Child-process env marker prefix (default "service-tunnels"). */
  marker?: string;
  /** Auth provider plugins (M4+). */
  authPlugins?: unknown[];
}

export interface ServiceTunnels {
  /** Resolved config/cache directories. */
  dirs: ServiceTunnelsDirs;
  /** Framework helper ports (nginx/authelia/redis) — separate from discovery. */
  internal: InternalRegistry;
  discovery: {
    discoverPorts(opts?: DiscoveryOptions): ServicePortInfo[];
    getPorts(opts?: DiscoveryOptions): ServicePortInfo[];
    isPortAllowed(port: number): boolean;
  };
  daemon: {
    status(): DaemonStatus;
    start(opts?: { foreground?: boolean; logFile?: string }): DaemonStatus;
    stop(): Promise<boolean>;
    request<T>(method: string, params?: unknown): Promise<T | null>;
  };
  /** Current runtime state (tunnels/auth) from state.json. */
  state(): ReturnType<typeof readState>;
}

/**
 * Create a service-tunnels instance. Library mode: the manager runs inside
 * the caller's process (pi-web does this — helpers become its descendants,
 * discovery scopes to its process tree). CLI mode: use `st.daemon.start()`
 * and the daemon owns long-lived processes.
 */
export function createServiceTunnels(opts: ServiceTunnelsOptions = {}): ServiceTunnels {
  const dirs = resolveDirs(opts);
  ensureMarker(opts.marker);
  const internal = new InternalRegistry();

  return {
    dirs,
    internal,
    discovery: {
      discoverPorts(o: DiscoveryOptions = {}) {
        return [...discoverServicePorts(internal, o).values()];
      },
      getPorts(o: DiscoveryOptions = {}) {
        return getServicePorts(internal, o);
      },
      isPortAllowed(port: number) {
        return isServicePortAllowed(internal, port);
      },
    },
    daemon: {
      status: () => daemonStatus(dirs.cacheDir),
      start: (o) => startDaemon(dirs.cacheDir, o),
      stop: () => stopDaemon(dirs.cacheDir),
      request: <T>(method: string, params?: unknown) => requestDaemon<T>(dirs.cacheDir, method, params),
    },
    state: () => readState(cachePaths(dirs.cacheDir).stateFile),
  };
}
