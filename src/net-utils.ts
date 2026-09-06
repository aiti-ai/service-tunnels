/**
 * net-utils — shared host/port/IP-family helpers (IPv6 awareness).
 *
 * Every place that parses a `host[:port]` string, splits a Host header, or
 * picks a local upstream address should go through these helpers so IPv6
 * literals (`[2001:db8::1]:8080`, `::1`, `fe80::1%eth0`) behave like any
 * other hostname instead of being mangled by `split(":")`.
 *
 * Scope notes:
 *   - Host HEADERS are always bracketed for IPv6 (RFC 7230 §5.4:
 *     `Host: [2001:db8::1]:8080`). Bare IPv6 in a Host header is invalid.
 *   - Server ADDRESS configs (frpc `server`, boom `--to`, ssh `host`) accept
 *     both bare IPv6 (`2001:db8::1`) and bracketed with port
 *     (`[2001:db8::1]:7000`).
 *   - Link-local scope ids (`fe80::1%eth0`) are preserved by `isIP()` (Node
 *     returns 6 for them); they must be `%25`-escaped inside URLs, which we
 *     do not attempt — those addresses are dropped by the upstream probe
 *     (a scoped address is only reachable on its own interface).
 */
import { isIP } from "node:net";

/** True when `host` is a bare (unbracketed) IPv6 literal, with optional
 *  `%zone` scope id (Node `isIP("fe80::1%eth0") === 6`). */
export function isBareIpv6(host: string): boolean {
  return typeof host === "string" && host.includes(":") && isIP(host) === 6;
}

/** True when `host` is an IPv6 literal, bracketed (`[2001:db8::1]`) or not. */
export function isIpv6Host(host: string): boolean {
  const h = (host ?? "").trim();
  if (h.startsWith("[") && h.endsWith("]")) return isIP(h.slice(1, -1)) === 6;
  return isIP(h) === 6;
}

/** True when `host` is a dotted-quad IPv4 literal. */
export function isIpv4Host(host: string): boolean {
  return typeof host === "string" && isIP(host) === 4;
}

/** True when `host` is an IP literal of either family. */
export function isIpHost(host: string): boolean {
  return isIpv4Host(host) || isBareIpv6(host) || isIpv6Host(host);
}

/** Wrap a bare IPv6 literal in `[...]` for URLs / ssh `user@[v6]` / nginx
 *  `proxy_pass http://[v6]:port`. Hostnames and IPv4 pass through unchanged;
 *  already-bracketed input passes through unchanged. */
export function bracketHost(host: string): string {
  const h = (host ?? "").trim();
  if (!h || (h.startsWith("[") && h.endsWith("]"))) return h;
  return isBareIpv6(h) ? `[${h}]` : h;
}

/** Bare (unbracketed) form of a host for config files (frpc `local_ip`,
 *  nginx `server_name` is domain-only): `[2001:db8::1]` → `2001:db8::1`. */
export function unbracketHost(host: string): string {
  return (host ?? "").trim().replace(/^\[|\]$/g, "");
}

/** Hostname-only part of a Host-header / URL authority string:
 *  `[2001:db8::1]:8080` → `2001:db8::1`, `example.com:8080` → `example.com`,
 *  `example.com` → `example.com`. Lowercased (Host headers are case-insens.). */
export function hostnameOnly(host: string | undefined): string {
  const h = (host ?? "").trim();
  if (!h) return "";
  // Bracketed IPv6: take everything inside the brackets (port after `]`).
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end > 0) return h.slice(1, end).toLowerCase();
    return h.replace(/[\[\]]/g, "").toLowerCase();
  }
  return h.split(":")[0]!.toLowerCase();
}

/** Split a server address (`host`, `host:port`, `[ipv6]`, `[ipv6]:port`)
 *  into host + optional port. Unlike `split(":")` this keeps IPv6 literals
 *  intact. Port is a string (falsy when absent) — callers coerce. */
export function parseHostPort(server: string): { host: string; port: string } {
  const s = (server ?? "").trim();
  if (!s) return { host: "", port: "" };
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    const host = end > 0 ? s.slice(1, end) : s.slice(1);
    const rest = end > 0 ? s.slice(end + 1) : "";
    if (rest.startsWith(":")) return { host, port: rest.slice(1) };
    return { host, port: "" };
  }
  // Bare IPv6 without brackets (e.g. `2001:db8::1`) — the whole string is the
  // host; a trailing `:1` would otherwise parse as host:port and mangle it.
  if (isBareIpv6(s)) return { host: s, port: "" };
  const m = /^(.*?):(\d{1,5})$/.exec(s);
  if (m) return { host: m[1]!, port: m[2]! };
  return { host: s, port: "" };
}

/** Format `host:port` for URLs / ssh dests — IPv6 gets brackets:
 *  ("2001:db8::1", 8080) → "[2001:db8::1]:8080". `port` falsy → bare host. */
export function formatHostPort(host: string, port: string | number | undefined): string {
  const h = bracketHost(host);
  return typeof port !== "undefined" && port !== "" && Number(port) > 0 ? `${h}:${port}` : h;
}

// ── Local upstream target host (the app the gateway/proxy/tunnel dials) ──────

const targetHostCache = new Map<number, { host: string; at: number }>();
const TARGET_HOST_TTL = 5_000;

function probeTcp(port: number, host: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    void import("node:net").then(({ connect }) => {
      const sock = connect({ port, host });
      sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve(false); });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
    }).catch(() => resolve(false));
  });
}

/**
 * Resolve the local address the app listens on for `port`: probe the IPv4
 * loopback first (the historical default), then the IPv6 loopback. This is
 * how an app bound ONLY to `::1` becomes reachable by the proxy / nginx
 * gateway / local tunnel without any config change. When neither loopback is
 * open (rare: the caller knows better), fall back to "127.0.0.1" — the
 * historical default that keeps existing behavior identical.
 *
 * Probe results are cached per port for a few seconds so repeated expose/
 * register calls in one flow don't re-probe.
 */
export async function resolveTargetHost(port: number): Promise<string> {
  const cached = targetHostCache.get(port);
  if (cached && Date.now() - cached.at < TARGET_HOST_TTL) return cached.host;
  const v4 = await probeTcp(port, "127.0.0.1");
  let host = "127.0.0.1";
  if (!v4) {
    const v6 = await probeTcp(port, "::1");
    if (v6) host = "::1";
  }
  targetHostCache.set(port, { host, at: Date.now() });
  return host;
}

/** Reset the target-host probe cache (tests). */
export function _resetTargetHostCache(): void {
  targetHostCache.clear();
}