/** DDNS adapter — thin wrapper over the `ddns` package (multi-provider
 *  DDNS + DNS record management, 107 providers). Keeps service-tunnels'
 *  public API stable (config format, function names) while delegating to
 *  the full provider engine.
 *
 *  Two dimensions:
 *   1. IP-following DDNS (devices with a public IP) — ddns.updateEntry etc.
 *   2. Tunnel discovery beacons — a FIXED DNS name (CNAME/TXT) that always
 *      points at the CURRENT tunnel URL host, so `nslookup <beacon>` finds
 *      the latest tunnel even when nothing else is reachable.
 */

import { readConfig, writeConfig, configPath as ddnsConfigPath } from "ddns";
import { updateEntry, runOnce, startLoop } from "ddns";
import { resolvePublicIp } from "ddns";
import { setBeacon as ddnsSetBeacon, beaconValue } from "ddns";
import type { DdnsEntry, DdnsResult, DdnsLoopHandle } from "ddns";

export type { DdnsEntry, DdnsResult, DdnsLoopHandle } from "ddns";
/** Legacy alias. */
export type DdnsUpdateResult = DdnsResult;
export type { ProviderName } from "ddns";

// -- legacy aliases (pre-integration names; kept for callers) --------------

export type DdnsProviderKind = string;
/** All provider names known to the ddns engine. */
export const DDNS_PROVIDERS: readonly string[] = [
  "cloudflare", "dnspod", "aliyun", "duckdns", "custom", "freedns",
  "dreamhost", "dondominio", "netcup", "namesilo", "spaceship", "route53", "gcp",
  "namecheap", "dnsmadeeasy", "ultradns", "constellix", "dnsservices",
  "aurora", "cloudxns", "yandex", "gratisdns", "transip", "qcloud",
  "hostingde", "httpnet", "wedos", "nfsn", "yandexcloud", "valuedomain",
  "rackspace", "memset", "gehirn", "rcodezero", "devnomads", "misaka",
  "dinahosting", "joker", "powerdns", "linode4", "zeit",
];

/** Legacy config type = ddns package DdnsEntry. */
export type DdnsRecordConfig = DdnsEntry;

/** service-tunnels' ddns.json lives in <configDir> (the ddns package reads
 *  <configDir>/ddns.json too — same location, same shape). */
export { ddnsConfigPath };

export function readDdnsConfigs(configDir: string): DdnsRecordConfig[] {
  return readConfig(configDir);
}
export function writeDdnsConfigs(configDir: string, cfgs: DdnsRecordConfig[]): void {
  writeConfig(configDir, cfgs);
}

/** One update cycle for one entry (never throws — errors on the result). */
export async function updateDdnsRecord(cfg: DdnsRecordConfig, opts?: { fetchImpl?: unknown; detectIp?: typeof resolvePublicIp }): Promise<DdnsResult> {
  return updateEntry(cfg, opts as never);
}

/** Update every enabled entry once. */
export async function runDdnsOnce(cfgs: DdnsRecordConfig[], opts?: { fetchImpl?: unknown; detectIp?: typeof resolvePublicIp }): Promise<DdnsResult[]> {
  return runOnce(cfgs, opts as never);
}

/** Long-running loop (returns immediately, interval unref'd). */
export function startDdnsLoop(cfgs: DdnsRecordConfig[], opts?: { log?: (line: string) => void; fetchImpl?: unknown }): DdnsLoopHandle {
  return startLoop(cfgs, opts as never);
}

export { resolvePublicIp };

// -- dimension 2: tunnel discovery beacons ---------------------------------

export interface BeaconTarget {
  /** Zone-style provider config (needs CRUD for CNAME/TXT). */
  provider: string;
  token?: string;
  secret?: string;
  accessKeyId?: string;
  zoneId?: string;
  username?: string;
  password?: string;
  /** Root zone of the beacon name. */
  zone: string;
  /** Fixed beacon name, e.g. discover.example.com. */
  name: string;
  /** CNAME (bare host) or TXT (full URL). Default CNAME. */
  type?: "CNAME" | "TXT";
  /** service-tunnels base URL override (tests). */
  baseUrl?: string;
}

/** Register a tunnel URL under a fixed beacon name. `url` may be a full URL
 *  (CNAME extracts the host, TXT keeps it as-is). Never throws. */
export async function updateBeacon(target: BeaconTarget, url: string): Promise<{ ok: boolean; name: string; value: string; created?: boolean; error?: string }> {
  try {
    const result = await ddnsSetBeacon({
      provider: {
        provider: target.provider,
        token: target.token,
        secret: target.secret,
        accessKeyId: target.accessKeyId,
        zoneId: target.zoneId,
        username: target.username,
        password: target.password,
        baseUrl: target.baseUrl,
      },
      zone: target.zone,
      name: target.name,
      type: target.type ?? "CNAME",
      value: url,
    });
    return { ok: true, name: result.name, value: result.value, created: result.created };
  } catch (err) {
    return { ok: false, name: target.name, value: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Normalize a value for the beacon type (CNAME strips scheme/path). */
export { beaconValue };
