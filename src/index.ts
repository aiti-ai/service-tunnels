import {
  resolveDirs,
  cachePaths,
  readConfigFile,
  writeConfigFile,
  hardenDir,
  type DirOptions,
  type ServiceTunnelsDirs,
} from "./config.ts";
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
import { registerPid as registerPidToFile, registrationFilePath } from "./pid-registry.ts";
import {
  daemonStatus,
  startDaemon,
  stopDaemon,
  requestDaemon,
  type DaemonStatus,
} from "./daemon.ts";
import { readState } from "./state.ts";
import { ensureTool, resolveToolPath, findOnPath, TOOLS, mergeToolPaths, type ToolRegistryOptions } from "./tools.ts";
import { spawnGuardian } from "./guardian-spawn.ts";
import { createProxyServer, parseServiceHost, validBasicAuth, type ProxyOptions } from "./proxy.ts";
import { TunnelManager, extractTunnelUrl, tunnelSupportsTcp, tunnelParamSchema, tunnelParamSchemas, tunnelMeta, tunnelMetas, type TunnelConfig, type TunnelInfo, type TunnelType, type ParamSpec, type TunnelMeta } from "./tunnels.ts";
import { readTunnelConfigs, writeTunnelConfigs } from "./tunnels-config.ts";
import { expose as exposeFlow, type ExposeOptions, type ExposeResult } from "./expose.ts";
import { GatewayController } from "./gateway.ts";
import { RedisController } from "./redis.ts";
import { AutheliaProvider } from "./authelia.ts";
import { AuthRegistry, loadProviderPlugins, authProviderSchemas } from "./auth-registry.ts";
import type { AuthProvider, AuthProviderFactory, ProviderContext } from "./auth-provider.ts";
import type { AuthUser } from "./auth-provider.ts";

export type { ServicePortInfo, DiscoveryOptions } from "./discovery.ts";
export type { ServiceTunnelsDirs, DirOptions } from "./config.ts";
export type { DaemonStatus } from "./daemon.ts";
export type { ToolDef, ToolRegistryOptions } from "./tools.ts";
export type { TunnelConfig, TunnelInfo, TunnelType, ParamSpec, TunnelMeta } from "./tunnels.ts";
export { extractTunnelUrl, tunnelSupportsTcp, tunnelParamSchema, tunnelParamSchemas, tunnelMeta, tunnelMetas, TUNNEL_META, coerceParam, applyParamSets } from "./tunnels.ts";
export { authProviderSchemas, AUTH_PARAM_SCHEMAS } from "./auth-registry.ts";
export type { AuthProvider, ProviderContext, AuthPolicy, AuthProviderCapabilities } from "./auth-provider.ts";
export { AutheliaProvider } from "./authelia.ts";
export { GatewayController, generateGatewayNginx, detectProtocol } from "./gateway.ts";
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
  /** Allow on-demand tool downloads when a tool is missing (default true).
   *  False → only PATH/cache tools are usable. Persisted to config so the UI
   *  toggle survives restarts; library opts win over the config file. */
  allowToolDownload?: boolean;
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
    request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T | null>;
  };
  tools: {
    /** Resolve a tool: caller path > PATH > cache; auto-downloads when missing. */
    ensure(name: string): Promise<string>;
    /** Resolve without downloading (null when absent everywhere). */
    resolve(name: string): string | null;
    /** All known tools + current resolution + source. */
    list(): ToolResolution[];
    /** Whether on-demand downloads are currently allowed. */
    allowDownload(): boolean;
    /** Toggle on-demand downloads (persisted to service-tunnels.json). */
    setAllowDownload(allowed: boolean): void;
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
    /** Tunnel types that support raw TCP (for the UI: only these selectable
     *  when exposing a tcp port). */
    tcpSupport(): string[];
  };
  /** Provider/tunnel parameter schemas — data-driven forms for clients
   *  (pi-web renders inputs from these; adding a type/provider needs no
   *  client changes). */
  schemas: {
    tunnels(): Record<TunnelType, ParamSpec[]>;
    tunnel(type: string): ParamSpec[];
    authProviders(): Promise<Record<string, ParamSpec[]>>;
    metas(): Record<TunnelType, TunnelMeta>;
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
    /** Provider types that expose TOTP 2FA management (portal). */
    totpProviders(): string[];
    /** Enroll TOTP 2FA for a user (portal) — returns secret + otpauth URL. */
    totpEnroll(name: string, provider?: string): Promise<{ secret: string; otpauthUrl: string }>;
    /** Disable TOTP 2FA for a user (portal). */
    totpDisable(name: string, provider?: string): Promise<void>;
    /** TOTP enrollment status for a user (portal). */
    totpStatus(name: string, provider?: string): Promise<{ enrolled: boolean }>;
  };
  /** Current runtime state (tunnels/auth) from state.json. */
  state(): ReturnType<typeof readState>;
  /** Stop everything: all tunnels + the shared nginx gateway + redis.
   *  Call on normal shutdown so framework helpers don't outlive the host
   *  (the guardian only covers crash/SIGKILL). */
  shutdown(): Promise<void>;
  /** Exposes made in this process lifecycle with their metadata (port, tunnel
   *  type, auth provider, url, running, pid). For display; not persisted. */
  exposes(): Array<{ name: string; port: number; tunnelType?: string; provider?: string; loginUrl?: string; protocol?: string; url: string | null; running: boolean; pid: number | null; accessLog: string | null; errorLog: string | null }>;
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
  // Hardening: the cache holds password hashes, session secrets and tunnel
  // tokens — make the whole tree unreadable to other users (umask may be 022).
  hardenDir(dirs.cacheDir, true);
  const file = readConfigFile(dirs.configDir);
  ensureMarker(opts.marker);
  // PID registration: framework processes register here; the guardian reads
  // this file on its low-frequency scan and reaps them on parent death.
  // Scoped per parent pid so multiple owners never share a file.
  const registerPid = (role: string, pid: number) => registerPidToFile(dirs.cacheDir, process.pid, role, pid);
  if (opts.guardian !== false) {
    spawnGuardian(process.pid, { registrationFile: registrationFilePath(dirs.cacheDir, process.pid), cacheDir: dirs.cacheDir });
  }
  const internal = new InternalRegistry();
  // Priority: explicit option > env SERVICE_TUNNELS_ALLOW_DOWNLOAD > config-file
  // fallback > default true. Never persisted — config file is a read-only
  // fallback, not a dependency.
  const envAllow = process.env.SERVICE_TUNNELS_ALLOW_DOWNLOAD;
  let allowToolDownload =
    opts.allowToolDownload ??
    (envAllow !== undefined
      ? !(envAllow === "0" || envAllow.toLowerCase() === "false" || envAllow.toLowerCase() === "off")
      : file.allowToolDownload ?? true);
  const toolOpts = {
    cacheDir: dirs.cacheDir,
    toolPaths: mergeToolPaths(opts.toolPaths),
    toolMirrors: opts.toolMirrors ?? file.toolMirrors,
    preferMirrors: opts.preferMirrors ?? file.preferMirrors,
    allowToolDownload,
  };
  const tm = new TunnelManager({
    cacheDir: dirs.cacheDir,
    resolveTool: async (name: string) => st_tools_ensure(name, toolOpts),
    registerPid,
    log: () => {},
  });
  for (const cfg of readTunnelConfigs(dirs.configDir)) tm.add(cfg);
  tm.hydrate(readState(cachePaths(dirs.cacheDir).stateFile).tunnels);

  // Shared singletons — ONE nginx gateway + ONE redis for ALL exposes, so
  // repeated expose() calls reuse them instead of spawning a fresh nginx/
  // redis each time (which leaked processes and confused discovery). Both
  // register their port in `internal` so discovery excludes them.
  const gateway = new GatewayController({
    configDir: dirs.configDir,
    cacheDir: dirs.cacheDir,
    port: 0,
    registerInternal: (role, p) => internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
    unregisterInternal: (role) => internal.unregister(role),
    registerPid,
    log: () => {},
  });
  const redis = new RedisController({ cacheDir: dirs.cacheDir, port: 0, log: () => {}, registerPid });
  // In-memory record of exposes made in THIS process lifecycle (port + tunnel
  // type + auth provider + url), so callers (pi-web) can display active exposes
  // with their metadata. Not persisted across restarts.
  const exposes = new Map<string, { port: number; tunnelType?: string; provider?: string; loginUrl?: string; protocol?: string; host?: string }>();

  /** Unregister the gateway host an expose registered (so stopping one expose
   *  doesn't leave a stale nginx server block — localhost:PORT hosts would
   *  otherwise collide with the next expose since nginx server_name ignores
   *  the port part). */
  const unregisterExposeHost = async (name: string): Promise<void> => {
    const ex = exposes.get(name);
    if (ex?.host) {
      try { await gateway.unregisterHost(ex.host); } catch { /* best effort */ }
    }
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
      start: (o) => startDaemon(dirs.cacheDir, { ...o, configDir: dirs.configDir }),
      stop: () => stopDaemon(dirs.cacheDir),
      request: <T>(method: string, params?: unknown, timeoutMs = 5_000) =>
        requestDaemon<T>(dirs.cacheDir, method, params, timeoutMs),
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
      allowDownload: () => allowToolDownload,
      setAllowDownload: (allowed: boolean) => {
        // git-config style: persist to service-tunnels.json. Reads keep the
        // priority params > env > file > default, so per-expose params still
        // win; the file is the durable default, not a hard dependency.
        allowToolDownload = !!allowed;
        toolOpts.allowToolDownload = allowToolDownload;
        try {
          const f = readConfigFile(dirs.configDir);
          f.allowToolDownload = allowToolDownload;
          writeConfigFile(dirs.configDir, f);
        } catch {
          // config write failures must not break the toggle
        }
      },
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
          await unregisterExposeHost(name);
        },
        stopAll: async () => {
          for (const name of [...exposes.keys()]) await unregisterExposeHost(name);
          await tm.stopAll();
          persistState();
        },
        hydrate: () => tm.hydrate(readState(cachePaths(dirs.cacheDir).stateFile).tunnels),
        tcpSupport: () => {
          const fixed: TunnelType[] = ["ssh"]; // resolved via PATH, not TOOLS
          const fromTools = (Object.keys(TOOLS) as TunnelType[]).filter((t) => tunnelSupportsTcp(t));
          return [...new Set([...fixed, ...fromTools])];
        },
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
          registerPid,
          pickPort,
          log: () => {},
        },
        [...(opts.authPlugins as AuthProviderFactory[]) ?? []],
      );
      void loadProviderPlugins(dirs.configDir).then((plugins) => {
        for (const f of plugins) registry.register(f);
      });
      return {
        providers: () => ["none", ...registry.list()],
        registerProvider: (f: AuthProviderFactory) => registry.register(f),
        expose: async (port: number, o: Omit<ExposeOptions, "port"> = {}) => {
          const r = await exposeFlow(port, { ...o, port }, {
            configDir: dirs.configDir,
            cacheDir: dirs.cacheDir,
            resolveTool: async (name: string) =>
              // per-expose param beats the shared toolOpts (env > config fallback)
              o.allowToolDownload !== undefined
                ? st_tools_ensure(name, { ...toolOpts, allowToolDownload: o.allowToolDownload })
                : st_tools_ensure(name, toolOpts),
            internal,
            tunnels: tm,
            auth: registry,
            gateway,
            redis,
            registerPid,
            onTunnelStop: unregisterExposeHost,
            log: () => {},
          });
          // record this expose's metadata for the lifecycle display
          exposes.set(r.tunnel, { port, tunnelType: o.tunnelType, provider: r.provider, loginUrl: r.loginUrl, protocol: r.protocol, host: r.url ? new URL(r.url).host : undefined });
          return r;
        },
        userManagers: () => registry.userManagers(),
        totpProviders: () => registry.totpProviders(),
        totpEnroll: async (name: string, provider?: string) => {
          const mgr = registry.userManager(provider ?? "portal") as unknown as {
            totpEnroll(n: string): Promise<{ secret: string; otpauthUrl: string }>;
          };
          return mgr.totpEnroll(name);
        },
        totpDisable: async (name: string, provider?: string) => {
          const mgr = registry.userManager(provider ?? "portal") as unknown as {
            totpDisable(n: string): Promise<void>;
          };
          await mgr.totpDisable(name);
        },
        totpStatus: async (name: string, provider?: string) => {
          const mgr = registry.userManager(provider ?? "portal") as unknown as {
            totpStatus(n: string): Promise<{ enrolled: boolean }>;
          };
          return mgr.totpStatus(name);
        },
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
    /** Provider/tunnel parameter schemas — data-driven forms for clients
     *  (pi-web renders inputs from these; no client changes per provider). */
    schemas: {
      tunnels: () => tunnelParamSchemas(),
      tunnel: (type: string) => tunnelParamSchema(type as TunnelType),
      metas: () => tunnelMetas(),
      authProviders: () => authProviderSchemas(dirs.configDir),
    },
    state: () => readState(cachePaths(dirs.cacheDir).stateFile),
    shutdown: async () => {
      await tm.stopAll();
      try { await gateway.stop(); } catch {}
      try { await redis.stop(); } catch {}
    },
    /** Exposes made in this process lifecycle (port + tunnel type + auth
     *  provider + url + running), for display. Not persisted. */
    exposes: () =>
      [...exposes.entries()].map(([name, m]) => {
        const tun = tm.get(name);
        const host = tun?.url ? new URL(tun.url).host : null;
        const logs = host ? gateway.logPaths(host) : null;
        return {
          name,
          port: m.port,
          tunnelType: m.tunnelType,
          provider: m.provider,
          loginUrl: m.loginUrl,
          protocol: m.protocol,
          url: tun?.url ?? null,
          running: tun?.running ?? false,
          pid: tun?.pid ?? null,
          accessLog: logs?.access ?? null,
          errorLog: logs?.error ?? null,
        };
      }),
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
async function st_tools_ensure(name: string, toolOpts: ToolRegistryOptions): Promise<string> {
  const def = TOOLS[name];
  if (!def) throw new Error(`unknown tool: ${name}`);
  return ensureTool(def, toolOpts);
}

// lazy helper to avoid a circular import at module top
import { updateState as _updateState } from "./state.ts";
function require_state() {
  return { updateState: _updateState };
}
