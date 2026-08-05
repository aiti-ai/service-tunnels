import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Site = an independent auth realm (sites-design.md §2): a provider instance
 * + its own user db + basePath + policy + optional domain / vhost label —
 * all isolated from every other site.
 *
 * Persisted in configDir/sites.json (0600). The implicit `default` site
 * always exists (keeps the legacy storage paths) and guarantees backward
 * compatibility: any call without `--site`/`{ site }` lands on default.
 */

export interface SiteConfig {
  name: string;
  /** Auth provider type; default = platform default (win32=portal, else authelia). */
  provider?: string;
  /** Whether the site's vhosts require auth by default (default true). */
  auth?: boolean;
  /** Provider base path (empty = auto-generated per instance). */
  basePath?: string;
  policy?: "one_factor" | "two_factor" | "deny";
  /** Pre-registered public domain (the site's "home" domain, also a suffix). */
  domain?: string;
  /** Vhost dash label (default = site name); default site uses "auth". */
  suffix?: string;
  /** Bootstrap user (created when the user db is empty; password printed once). */
  user?: { name: string };
  /** Extra provider options (schema-driven form params, dotted keys nested). */
  providerParams?: Record<string, unknown>;
}

export interface SiteInfo extends SiteConfig {
  /** Whether any provider instance of this site is currently running. */
  running: boolean;
  /** Provider instance port (when running). */
  port?: number;
  /** Hosts registered under this site (tunnel/domain hosts, dynamic). */
  hosts: string[];
}

export function sitesFilePath(configDir: string): string {
  return join(configDir, "sites.json");
}

/** Read configDir/sites.json (loose: missing/malformed → {}). */
export function readSites(configDir: string): Record<string, SiteConfig> {
  try {
    const raw = readFileSync(sitesFilePath(configDir), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, SiteConfig> = {};
      for (const [name, cfg] of Object.entries(parsed)) {
        if (cfg && typeof cfg === "object" && name) out[name] = { ...(cfg as SiteConfig), name };
      }
      return out;
    }
  } catch {
    // missing or malformed → empty
  }
  return {};
}

/** Persist configDir/sites.json (atomic tmp+rename, 0600). */
export function writeSites(configDir: string, sites: Record<string, SiteConfig>): void {
  const file = sitesFilePath(configDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(sites, null, 2) + "\n", "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  renameSync(tmp, file);
}

/** Site-name validation: [a-z0-9-], not reserved, not the implicit default. */
export function validateSiteName(name: string): void {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(`invalid site name "${name}" (lowercase letters/digits/dashes, ≤63 chars)`);
  }
  if (name === "auth") throw new Error('site name "auth" is reserved (default-site vhost label)');
  if (name === "default") throw new Error('site "default" is implicit — add/remove is not allowed');
}

/** The implicit default site (always exists; keeps legacy storage paths). */
export function defaultSiteConfig(): SiteConfig {
  return { name: "default", auth: true };
}
