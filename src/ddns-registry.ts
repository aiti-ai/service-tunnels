/** DDNS registration engine — preconfigured profiles + event-driven
 *  registration for portmap and tunnel outcomes.
 *
 *  Config (ddns.json, in addition to plain DdnsEntry[]):
 *
 *    {
 *      "providerProfiles": {           // provider-level: credentials
 *        "cf":  { "provider": "cloudflare", "token": "***" }
 *      },
 *      "profiles": {                   // provider+domain-level: target
 *        "home": { "providerProfile": "cf", "zone": "example.com",
 *                  "record": "home.example.com", "type": "CNAME" }
 *      },
 *      "entries": [
 *        { "name": "p1", "profile": "home", "kind": "portmap",
 *          "ip": true, "txt": true },                          // A=externalIp, TXT=ip:port
 *        { "name": "t1", "profile": "home", "kind": "tunnel",
 *          "followTunnel": "web", "cname": true, "txt": true } // CNAME=url host, TXT=url
 *      ]
 *    }
 *
 *  "profile" = providerProfile + domain target; "providerProfile" alone may
 *  be combined with an explicit zone/record on the entry. Entries may also
 *  carry provider/zone/record inline (no profiles) for ad-hoc use.
 */

import { setBeacon, upsertRecord } from "ddns";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DdnsEntry } from "./ddns.ts";
import { ddnsConfigPath } from "./ddns.ts";

export interface ProviderProfile {
  provider: string;
  token?: string;
  secret?: string;
  accessKeyId?: string;
  zoneId?: string;
  username?: string;
  password?: string;
  baseUrl?: string;
}

export interface RecordProfile {
  /** Reference into providerProfiles. */
  providerProfile?: string;
  /** Or inline provider config. */
  provider?: string;
  token?: string;
  secret?: string;
  accessKeyId?: string;
  zoneId?: string;
  username?: string;
  password?: string;
  baseUrl?: string;
  zone: string;
  /** Record name (CNAME/A 的记录名); entries may override with `record`. */
  record?: string;
  /** TXT 记录名（可与 CNAME 记录名不同，如 discover-txt.example.com）；
   *  缺省回退到 record。 */
  txtName?: string;
  /** Default record type for tunnel CNAME / portmap A. */
  type?: "A" | "CNAME" | "TXT" | "AAAA";
}

export interface RegistrationEntry {
  name: string;
  /** Reference into profiles, or providerProfile + inline zone/record. */
  profile?: string;
  providerProfile?: string;
  provider?: string;
  token?: string;
  secret?: string;
  accessKeyId?: string;
  zoneId?: string;
  username?: string;
  password?: string;
  baseUrl?: string;
  zone?: string;
  record?: string;
  /** TXT 记录名（独立于 CNAME 记录名）；缺省回退到 record。 */
  txtName?: string;
  /** What triggers this entry: "portmap" or "tunnel". */
  kind: "portmap" | "tunnel";
  /** Name of the tunnel to follow (kind: tunnel). */
  followTunnel?: string;
  /** Kind: portmap — register the external IP as an A record. */
  ip?: boolean;
  /** Kind: portmap — register "ip:port" as a TXT record. */
  txt?: boolean;
  /** Kind: tunnel — register the URL host as a CNAME. */
  cname?: boolean;
  /** Kind: tunnel — register the full URL as a TXT. */
  txtUrl?: boolean;
}

export interface DdnsRegistryConfig {
  providerProfiles?: Record<string, ProviderProfile>;
  profiles?: Record<string, RecordProfile>;
  entries?: RegistrationEntry[];
}

export interface RegistrationResult {
  name: string;
  kind: "portmap" | "tunnel";
  actions: Array<{ type: "A" | "CNAME" | "TXT"; name: string; value: string; ok: boolean; error?: string }>;
}

/** Read the registry config (accepts plain DdnsEntry[] too). */
export function readRegistryConfig(configDir: string): DdnsRegistryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ddnsConfigPath(configDir), "utf8"));
  } catch {
    return { providerProfiles: {}, profiles: {}, entries: [] };
  }
  // plain array (legacy) — no profiles
  if (Array.isArray(raw)) return { providerProfiles: {}, profiles: {}, entries: [] };
  const cfg = raw as DdnsRegistryConfig;
  return {
    providerProfiles: cfg.providerProfiles ?? {},
    profiles: cfg.profiles ?? {},
    entries: cfg.entries ?? [],
  };
}

/** Resolve an entry to a concrete provider config + record target. */
export function resolveEntry(
  cfg: DdnsRegistryConfig,
  entry: RegistrationEntry,
): { provider: ProviderProfile; zone: string; record: string; txtName: string } | null {
  const pps = cfg.providerProfiles ?? {};
  const profs = cfg.profiles ?? {};
  // 1) profile reference
  if (entry.profile) {
    const p = profs[entry.profile];
    if (!p) return null;
    const pp = p.providerProfile ? pps[p.providerProfile] : null;
    const provider: ProviderProfile = {
      provider: pp?.provider ?? p.provider ?? "",
      token: entry.token ?? p.token ?? pp?.token,
      secret: entry.secret ?? p.secret ?? pp?.secret,
      accessKeyId: entry.accessKeyId ?? p.accessKeyId ?? pp?.accessKeyId,
      zoneId: entry.zoneId ?? p.zoneId ?? pp?.zoneId,
      username: entry.username ?? p.username ?? pp?.username,
      password: entry.password ?? p.password ?? pp?.password,
      baseUrl: entry.baseUrl ?? p.baseUrl ?? pp?.baseUrl,
    };
    return { provider, zone: entry.zone ?? p.zone, record: entry.record ?? p.record ?? "", txtName: entry.txtName ?? p.txtName ?? "" };
  }
  // 2) providerProfile + inline zone/record
  if (entry.providerProfile) {
    const pp = pps[entry.providerProfile];
    if (!pp || !entry.zone) return null;
    return {
      provider: { ...pp, token: entry.token ?? pp.token, secret: entry.secret ?? pp.secret, zoneId: entry.zoneId ?? pp.zoneId },
      zone: entry.zone,
      record: entry.record ?? "",
      txtName: entry.txtName ?? "",
    };
  }
  // 3) inline
  if (!entry.provider || !entry.zone) return null;
  return {
    provider: { provider: entry.provider, token: entry.token, secret: entry.secret, accessKeyId: entry.accessKeyId, zoneId: entry.zoneId, username: entry.username, password: entry.password, baseUrl: entry.baseUrl },
    zone: entry.zone,
    record: entry.record ?? "",
    txtName: entry.txtName ?? "",
  };
}

/** Register a portmap outcome (externalIp + externalPort) for matching entries. */
export async function registerPortmap(
  cfg: DdnsRegistryConfig,
  info: { externalIp: string; externalPort: number; label?: string },
): Promise<RegistrationResult[]> {
  const results: RegistrationResult[] = [];
  for (const entry of cfg.entries ?? []) {
    if (entry.kind !== "portmap") continue;
    const resolved = resolveEntry(cfg, entry);
    if (!resolved) {
      results.push({ name: entry.name, kind: "portmap", actions: [{ type: "A", name: entry.record ?? `${entry.name}.${entry.zone ?? "?"}`, value: "", ok: false, error: "unresolved profile/provider (check profile/providerProfile/zone)" }] });
      continue;
    }
    const actions: RegistrationResult["actions"] = [];
    if (entry.ip) {
      const name = resolved.record || `${entry.name}.${resolved.zone}`;
      const r = await setBeaconSafe(resolved, { name, type: "A", value: info.externalIp });
      actions.push({ type: "A", name, value: info.externalIp, ok: r.ok, error: r.error });
    }
    if (entry.txt) {
      const name = resolved.txtName || resolved.record || `${entry.name}.${resolved.zone}`;
      const value = `${info.externalIp}:${info.externalPort}`;
      const r = await setBeaconSafe(resolved, { name, type: "TXT", value });
      actions.push({ type: "TXT", name, value, ok: r.ok, error: r.error });
    }
    results.push({ name: entry.name, kind: "portmap", actions });
  }
  return results;
}

/** Register a tunnel outcome (url) for matching entries. */
export async function registerTunnel(
  cfg: DdnsRegistryConfig,
  info: { tunnelName: string; url: string },
): Promise<RegistrationResult[]> {
  const results: RegistrationResult[] = [];
  for (const entry of cfg.entries ?? []) {
    if (entry.kind !== "tunnel" || entry.followTunnel !== info.tunnelName) continue;
    const resolved = resolveEntry(cfg, entry);
    if (!resolved) {
      results.push({ name: entry.name, kind: "tunnel", actions: [{ type: "CNAME", name: entry.record ?? `${entry.name}.${entry.zone ?? "?"}`, value: "", ok: false, error: "unresolved profile/provider (check profile/providerProfile/zone)" }] });
      continue;
    }
    const base = resolved.record || `${entry.name}.${resolved.zone}`;
    const actions: RegistrationResult["actions"] = [];
    if (entry.cname) {
      const host = urlHost(info.url);
      const r = await setBeaconSafe(resolved, { name: base, type: "CNAME", value: host });
      actions.push({ type: "CNAME", name: base, value: host, ok: r.ok, error: r.error });
    }
    if (entry.txtUrl) {
      const txtName = resolved.txtName || base;
      const r = await setBeaconSafe(resolved, { name: txtName, type: "TXT", value: info.url });
      actions.push({ type: "TXT", name: txtName, value: info.url, ok: r.ok, error: r.error });
    }
    results.push({ name: entry.name, kind: "tunnel", actions });
  }
  return results;
}

/** Extract the host from a URL ("https://abc.trycloudflare.com/x" → host).
 *  CNAME values must be bare hostnames — a port (tcp://host:port, ssh -R)
 *  is stripped because DNS CNAME cannot carry one. */
export function urlHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host || url;
  } catch {
    return (url.replace(/^https?:\/\//, "").split("/")[0] ?? url).split(":")[0] || url;
  }
}

async function setBeaconSafe(
  resolved: { provider: ProviderProfile; zone: string },
  target: { name: string; type: "A" | "CNAME" | "TXT"; value: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (target.type === "A") {
      // portmap IP registration — A records go through the generic upsert
      await upsertRecord(resolved.provider as never, resolved.zone, {
        type: "A",
        name: target.name,
        value: target.value,
      });
    } else {
      await setBeacon({
        provider: resolved.provider as never,
        zone: resolved.zone,
        name: target.name,
        type: target.type,
        value: target.value,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist a registry config (0600 atomic). */
export function writeRegistryConfig(configDir: string, cfg: DdnsRegistryConfig): void {
  const file = ddnsConfigPath(configDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
