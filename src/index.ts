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
import { spawnGuardian } from "./guardian-spawn.ts";
import { createProxyServer, parseServiceHost, validBasicAuth, type ProxyOptions } from "./proxy.ts";
import { TunnelManager, extractTunnelUrl, type TunnelConfig, type TunnelInfo } from "./tunnels.ts";
import { readTunnelConfigs, writeTunnelConfigs } from "./tunnels-config.ts";
import { expose as exposeFlow, type ExposeOptions, type ExposeResult } from "./expose.ts";
import { AutheliaProvider } from "./authelia.ts";
import { AuthRegistry, loadProviderPlugins } from "./auth-registry.ts";
import type { AuthProvider, AuthProviderFactory, ProviderContext } from "./auth-provider.ts";
import type { AuthUser } from "./auth-provider.ts";

export type { ServicePortInfo, DiscoveryOptions } from "./discovery.ts";
export type { ServiceTunnelsDirs, DirOptions } from "./config.ts";
export type { DaemonStatus } from "./daemon.ts";
export type { ToolDef, ToolRegistryOptions } from "./tools.ts";
export type { TunnelConfig, TunnelInfo, TunnelType } from "./tunnels.ts";
export { extractTunnelUrl } from "./tunnels.ts";
export type { AuthProvider, ProviderContext, AuthPolicy, AuthProviderCapabilities } from "./auth-provider.ts";
export { AutheliaProvider } from "./authelia.ts";
export { GatewayController, generateGatewayNginx } from "./gateway.ts";
export { RedisController } from "./redis.ts";

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
  /** Spawn a parent-death guardian (default true): if this process exits
   *  without cleanup, a detached guardian kills our framework helpers. */
  guardian?: boolean;
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
  tunnels: {
    /** Declarative configs from configDir/tunnels.json. */
    configs(): TunnelConfig[];
    /** Persist the config list to configDir/tunnels.json. */
    saveConfigs(cfgs: TunnelConfig[]): void;
    add(cfg: TunnelConfig): void;
    remove(name: string): void;
    list(): TunnelInfo[];
    get(name: string): TunnelInfo | undefined;
    start(name: string): Promise<TunnelInfo>;
    stop(name: string): Promise<void>;
    stopAll(): Promise<void>;
    /** Restore URLs from state.json after a restart. */
    hydrate(): void;
  };
  auth: {
    /** Built-in + plugin providers. */
    providers(): string[];
    /** Register an extra provider factory (plugins). */
    registerProvider(factory: AuthProviderFactory): void;
    /** Expose with optional gateway auth (default provider: authelia). */
    expose(port: number, opts?: Omit<ExposeOptions, "port">): Promise<ExposeResult>;
    /**
     * Provider-local users (no secrets). `provider` = "all" (default) →
     * [{provider, users}] for every provider supporting user management.
     */
    users(provider?: string): Promise<{ provider: string; users: AuthUser[] }[]>;
    /**
     * Add/update a user across `provider` (default "all" → every supporting
     * provider; also accepts a single type or an array). Returns the
     * providers the user was written to.
     */
    addUser(
      name: string,
      password: string,
      opts?: { provider?: string | string[]; displayName?: string },
    ): Promise<string[]>;
    /** Change a user's password across `provider` (default "all"). */
    setUserPassword(
      name: string,
      password: string,
      provider?: string | string[],
    ): Promise<string[]>;
    /** Remove a user across `provider` (default "all"). */
    removeUser(name: string, provider?: string | string[]): Promise<string[]>;
    /** Provider types with local user databases (e.g. ["authelia","basic"]). */
    userManagers(): string[];
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
function resolveUserTargets(
  registry: AuthRegistry,
  provider?: string | string[],
): string[] {
  const all = registry.userManagers();
  if (!provider || provider === "all") return all;
  const targets = Array.isArray(provider) ? provider : [provider];
  for (const t of targets) {
    if (!all.includes(t)) throw new Error(`provider ${t} does not support user management (available: ${all.join(", ")})`);
  }
  return targets;
}

export function createServiceTunnels(opts: ServiceTunnelsOptions = {}): ServiceTunnels {
  const dirs = resolveDirs(opts);
  ensureMarker(opts.marker);
  if (opts.guardian !== false) {
    spawnGuardian(process.pid);
  }
  const internal = new InternalRegistry();
  const toolOpts = {
    cacheDir: dirs.cacheDir,
    toolPaths: opts.toolPaths,
    toolMirrors: opts.toolMirrors,
    preferMirrors: opts.preferMirrors,
  };
  const tm = new TunnelManager({
    cacheDir: dirs.cacheDir,
    resolveTool: async (name: string) => st_tools_ensure(name, toolOpts),
    log: () => {},
  });
  for (const cfg of readTunnelConfigs(dirs.configDir)) tm.add(cfg);
  tm.hydrate(readState(cachePaths(dirs.cacheDir).stateFile).tunnels);

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
      start: (o) => startDaemon(dirs.cacheDir, { ...o, configDir: dirs.configDir }),
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
    tunnels: (() => {
      const persistState = () => {
        const { updateState } = require_state();
        updateState(cachePaths(dirs.cacheDir).stateFile, (s) => {
          s.tunnels = tm.persisted();
        });
      };
      return {
        configs: () => readTunnelConfigs(dirs.configDir),
        saveConfigs: (cfgs: TunnelConfig[]) => writeTunnelConfigs(dirs.configDir, cfgs),
        add: (cfg: TunnelConfig) => {
          tm.add(cfg);
          const all = readTunnelConfigs(dirs.configDir);
          const idx = all.findIndex((c) => c.name === cfg.name);
          if (idx >= 0) all[idx] = cfg;
          else all.push(cfg);
          writeTunnelConfigs(dirs.configDir, all);
        },
        remove: (name: string) => {
          tm.remove(name);
          writeTunnelConfigs(dirs.configDir, readTunnelConfigs(dirs.configDir).filter((c) => c.name !== name));
        },
        list: () => tm.list(),
        get: (name: string) => tm.get(name),
        start: async (name: string) => {
          const info = await tm.start(name);
          persistState();
          return info;
        },
        stop: async (name: string) => {
          await tm.stop(name);
          persistState();
        },
        stopAll: async () => {
          await tm.stopAll();
          persistState();
        },
        hydrate: () => tm.hydrate(readState(cachePaths(dirs.cacheDir).stateFile).tunnels),
      };
    })(),
    auth: (() => {
      const registry = new AuthRegistry(
        {
          configDir: dirs.configDir,
          cacheDir: dirs.cacheDir,
          resolveTool: async (name: string) => st_tools_ensure(name, toolOpts),
          registerInternal: (role, port) =>
            internal.register(role, { port, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
          unregisterInternal: (role) => internal.unregister(role),
          pickPort,
          log: () => {},
        },
        [...(opts.authPlugins as AuthProviderFactory[]) ?? []],
      );
      void loadProviderPlugins(dirs.configDir).then((plugins) => {
        for (const f of plugins) registry.register(f);
      });
      return {
        providers: () => registry.list(),
        registerProvider: (f: AuthProviderFactory) => registry.register(f),
        expose: (port: number, o: Omit<ExposeOptions, "port"> = {}) =>
          exposeFlow(port, { ...o, port }, {
            configDir: dirs.configDir,
            cacheDir: dirs.cacheDir,
            resolveTool: async (name: string) => st_tools_ensure(name, toolOpts),
            internal,
            tunnels: tm,
            auth: registry,
            log: () => {},
          }),
        userManagers: () => registry.userManagers(),
        users: async (provider = "all") => {
          const targets = resolveUserTargets(registry, provider);
          const out: { provider: string; users: AuthUser[] }[] = [];
          for (const t of targets) out.push({ provider: t, users: await registry.userManager(t).listUsers() });
          return out;
        },
        addUser: async (name: string, password: string, opts: { provider?: string | string[]; displayName?: string } = {}) => {
          const targets = resolveUserTargets(registry, opts.provider);
          for (const t of targets) await registry.userManager(t).addUser(name, password, opts.displayName);
          return targets;
        },
        setUserPassword: async (name: string, password: string, provider?: string | string[]) => {
          const targets = resolveUserTargets(registry, provider);
          for (const t of targets) await registry.userManager(t).setUserPassword(name, password);
          return targets;
        },
        removeUser: async (name: string, provider?: string | string[]) => {
          const targets = resolveUserTargets(registry, provider);
          for (const t of targets) await registry.userManager(t).removeUser(name);
          return targets;
        },
      };
    })(),
    state: () => readState(cachePaths(dirs.cacheDir).stateFile),
  };
}

/** Pre-assign a free local port. */
async function pickPort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

// helper: resolve tool via tools.ts (keeps the IIFE below minimal)
async function st_tools_ensure(name: string, toolOpts: { cacheDir: string; toolPaths?: Record<string, string> }): Promise<string> {
  const def = TOOLS[name];
  if (!def) throw new Error(`unknown tool: ${name}`);
  return ensureTool(def, toolOpts);
}

// lazy helper to avoid a circular import at module top
import { updateState as _updateState } from "./state.ts";
function require_state() {
  return { updateState: _updateState };
}
