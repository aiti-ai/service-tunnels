import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

/**
 * Directory resolution — precedence: constructor args > env vars
 * (SERVICE_TUNNELS_CONFIG / SERVICE_TUNNELS_CACHE) > OS defaults.
 *
 *   configDir: fixed configuration (0600) — tunnels.json, auth secrets
 *   cacheDir : downloads + generated artifacts + runtime state (rebuildable)
 */
export interface ServiceTunnelsDirs {
  configDir: string;
  cacheDir: string;
}

export interface DirOptions {
  configDir?: string;
  cacheDir?: string;
}

export interface ServiceTunnelsConfigFile {
  /** Global default base path override (expose --base-path wins over this). */
  basePath?: string;
  /** Per-provider base path override, e.g. { portal: "/login" }. */
  basePathByProvider?: Record<string, string>;
}

/** Read configDir/service-tunnels.json (loose: missing/malformed → {}). */
export function readConfigFile(configDir: string): ServiceTunnelsConfigFile {
  try {
    const raw = readFileSync(join(configDir, "service-tunnels.json"), "utf8");
    const v = JSON.parse(raw) as ServiceTunnelsConfigFile;
    if (v && typeof v === "object") return v;
  } catch {
    // missing or malformed → defaults
  }
  return {};
}

const ENV_CONFIG = "SERVICE_TUNNELS_CONFIG";
const ENV_CACHE = "SERVICE_TUNNELS_CACHE";

export function defaultConfigDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "service-tunnels");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "service-tunnels");
}

export function defaultCacheDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "service-tunnels");
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "service-tunnels");
}

/** Resolve config/cache directories per the documented precedence. */
export function resolveDirs(opts: DirOptions = {}): ServiceTunnelsDirs {
  return {
    configDir: opts.configDir?.trim() || process.env[ENV_CONFIG]?.trim() || defaultConfigDir(),
    cacheDir: opts.cacheDir?.trim() || process.env[ENV_CACHE]?.trim() || defaultCacheDir(),
  };
}

/** Sub-directories inside cacheDir. */
export function cachePaths(cacheDir: string) {
  return {
    bin: join(cacheDir, "bin"),
    tmp: join(cacheDir, "tmp"),
    data: join(cacheDir, "data"),
    stateFile: join(cacheDir, "state.json"),
    daemonSock: join(cacheDir, "daemon.sock"),
  };
}
