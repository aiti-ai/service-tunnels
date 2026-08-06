import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, statSync, renameSync } from "fs";

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
  /**
   * User's wildcard-DNS base domain (e.g. "example.com"): expose --mode
   * proxy also returns a PORTLESS base URL (`<port>[-<label>].<baseDomain>`)
   * in addition to the default portful local URL. The user points
   * `*.<baseDomain>` at this machine and reverse-proxies to the proxy port
   * (nginx/DNS) — hiding the local port entirely.
   */
  baseDomain?: string;
  /** Default proxy transport port (mode proxy/both); CLI --proxy-port wins. */
  proxyPort?: number;
  /** China-mirror download templates per tool (see src/tools.ts candidateUrls). */
  toolMirrors?: Record<string, string[]>;
  /** Try mirrors before official sources (CN networks). CLI-level default; library opts win. */
  preferMirrors?: boolean;
  /** Fallback for `allowToolDownload` when no explicit option is passed.
   *  Read-only fallback — the library/CLI never writes this file. */
  allowToolDownload?: boolean;
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

/**
 * Resolve the proxy base-domain list. Precedence:
 *   1. explicit primary (CLI --base-domain or createServiceTunnels baseDomain)
 *   2. explicit extras (createServiceTunnels baseDomains)
 *   3. env SERVICE_TUNNELS_BASE_DOMAIN (comma-separated)
 *   4. config file base-domain
 * The primary (first entry) drives the returned baseUrl; all entries are
 * served as proxy suffixes. Empty → no base domain.
 */
export function resolveBaseDomains(
  configDir: string,
  explicit?: { baseDomain?: string; baseDomains?: string[] },
): { primary: string; list: string[] } {
  const clean = (d: string) => d.trim().toLowerCase().replace(/^\./, "");
  const primary = clean(explicit?.baseDomain ?? "");
  const env = (process.env.SERVICE_TUNNELS_BASE_DOMAIN ?? "")
    .split(",").map(clean).filter(Boolean);
  const cfg = clean(readConfigFile(configDir).baseDomain ?? "");
  const extras = [...(explicit?.baseDomains ?? []).map(clean), ...env, ...(cfg ? [cfg] : [])]
    .filter((d) => d && d !== primary);
  // No explicit primary: the first extra (env > config) becomes the primary.
  const head = primary || extras[0] || "";
  const list = [head, ...extras.filter((d) => d !== head)];
  return { primary: head, list };
}

/** Persist configDir/service-tunnels.json (atomic tmp+rename, keeps other
 *  keys) — git-config style: `config set` writes here, everything reads it
 *  as the LOWEST-priority fallback (params > env > file > default). */
export function writeConfigFile(configDir: string, file: ServiceTunnelsConfigFile): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const p = join(configDir, "service-tunnels.json");
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
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

/** Restrict a directory (and optionally its children) to the owner.
 *  Cache contents are private: password hashes, session secrets, tunnel
 *  tokens, generated nginx configs. Default umask 022 leaves these 644,
 *  readable by any local user — fold the tree to 0700. */
export function hardenDir(dir: string, recursive = false): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (recursive) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) hardenDir(full, true);
      }
    }
  } catch {
    // best-effort: exotic filesystems / read-only mounts must not break the lib
  }
}

/** Sub-directories inside cacheDir. */
export function cachePaths(cacheDir: string) {
  return {
    bin: join(cacheDir, "bin"),
    tmp: join(cacheDir, "tmp"),
    data: join(cacheDir, "data"),    stateFile: join(cacheDir, "state.json"),
    daemonSock: join(cacheDir, "daemon.sock"),
  };
}
