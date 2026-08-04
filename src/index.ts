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
import { ensureTool, resolveToolPath, findOnPath, TOOLS } from "./tools.ts";
import { createProxyServer, parseServiceHost, validBasicAuth, type ProxyOptions } from "./proxy.ts";

export type { ServicePortInfo, DiscoveryOptions } from "./discovery.ts";
export type { ServiceTunnelsDirs, DirOptions } from "./config.ts";
export type { DaemonStatus } from "./daemon.ts";
export type { ToolDef, ToolRegistryOptions } from "./tools.ts";

export {
  expandListeningAddresses,
  decodeIpv4,
  decodeIpv6,
  parseLsofAddress,
  parseNetstatAddress,
  stripBasePath,
} from "./discovery.ts";
export { findOnPath } from "./tools.ts";
export { createProxyServer, parseServiceHost, validBasicAuth, authHeader } from "./proxy.ts";
export type { ProxyOptions, ServiceHostMatch } from "./proxy.ts";

export { InternalRegistry } from "./internal.ts";

export interface ServiceTunnelsOptions extends DirOptions {
  /** Child-process env marker prefix (default "service-tunnels"). */
  marker?: string;
  /** Auth provider plugins (M4+). */
  authPlugins?: unknown[];
  /** Explicit tool paths: { ngrok: "/opt/ngrok" }. Beats PATH and cache. */
  toolPaths?: Record<string, string>;
  /** China-mirror overrides per tool: { frpc: ["https://..."], default: [...] }. */
  toolMirrors?: Record<string, string[]>;
  /** Try mirrors before official sources (CN networks). */
  preferMirrors?: boolean;
}

export interface ToolResolution {
  name: string;
  /** Where the tool resolves to (null = not found anywhere). */
  path: string | null;
  source: "toolPaths" | "path" | "cache" | null;
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
  tools: {
    /** Resolve a tool: caller path > PATH > cache; auto-downloads when missing. */
    ensure(name: string): Promise<string>;
    /** Resolve without downloading (null when absent everywhere). */
    resolve(name: string): string | null;
    /** All known tools + current resolution + source. */
    list(): ToolResolution[];
  };
  proxy: {
    /** Create a wildcard-host reverse proxy (allow-list = discovery cache). */
    create(opts?: ProxyOptions): import("http").Server;
    parseHost(host: string | undefined): import("./proxy.ts").ServiceHostMatch | null;
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
  const toolOpts = {
    cacheDir: dirs.cacheDir,
    toolPaths: opts.toolPaths,
    toolMirrors: opts.toolMirrors,
    preferMirrors: opts.preferMirrors,
  };

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
    tools: {
      ensure: (name: string) => {
        const def = TOOLS[name];
        if (!def) throw new Error(`unknown tool: ${name} (known: ${Object.keys(TOOLS).join(", ")})`);
        return ensureTool(def, toolOpts);
      },
      resolve: (name: string) => resolveToolPath(name, toolOpts),
      list: () =>
        Object.entries(TOOLS).map(([name, def]) => {
          const explicit = toolOpts.toolPaths?.[name];
          const onPath = resolveToolPath(name, toolOpts);
          const source = explicit
            ? "toolPaths"
            : findOnPath(name)
              ? "path"
              : onPath
                ? "cache"
                : null;
          return { name, path: onPath, source };
        }),
    },
    proxy: {
      create: (o: Omit<ProxyOptions, "internal"> = {}) =>
        createProxyServer({
          ...o,
          isPortAllowed:
            o.isPortAllowed ??
            ((port: number) =>
              getServicePorts(internal, { force: o.refresh, rootPid: o.rootPid }).some(
                (p) => p.port === port,
              )),
        }),
      parseHost: (host: string | undefined) => parseServiceHost(host, [".pi.localhost"]),
    },
    state: () => readState(cachePaths(dirs.cacheDir).stateFile),
  };
}
