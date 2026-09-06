/**
 * ipv6 — public-IPv6 detection for direct (no-tunnel) IPv6 exposure.
 *
 * mode "ipv6" needs a GLOBAL (globally routable) unicast IPv6 on this host:
 *   - IPv6 has no NAT, so a public address on an interface IS the reachable
 *     address — no router mapping, no tunnel needed;
 *   - the proxy transport listens on `::` (dual-stack) and `allowIpDirect`
 *     maps `http://[<v6>]:<transportPort>` to the enrolled app port.
 *
 * This module answers "does this host have a public IPv6, and which?" —
 * exposed to ordinary users via `st ipv6` (status/diagnose) and consumed
 * by expose mode "ipv6".
 */
import { networkInterfaces } from "node:os";

export type Ipv6Scope = "global" | "ula" | "link-local" | "loopback" | "multicast" | "documentation" | "other";

export interface Ipv6AddressInfo {
  address: string;
  scope: Ipv6Scope;
  /** interface name (or "?"). */
  iface: string;
  /** os.networkInterfaces().internal flag. */
  internal: boolean;
}

/** Classify an IPv6 literal by routability scope. Zone ids (`fe80::1%eth0`)
 *  are stripped for classification and kept only on the stored address. */
export function classifyIpv6(addr: string): Ipv6Scope {
  const a = (addr ?? "").split("%")[0]!.toLowerCase();
  if (!a || a === "::" || a === "::0") return "other";
  if (a === "::1") return "loopback";
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return "link-local"; // fe80::/10
  if (a.startsWith("fc") || a.startsWith("fd")) return "ula"; // fc00::/7
  if (a.startsWith("ff")) return "multicast";
  if (a.startsWith("2001:db8")) return "documentation"; // RFC 3849
  // global unicast — everything else with a v6 shape
  return "global";
}

export function isGlobalIpv6(addr: string): boolean {
  return classifyIpv6(addr) === "global";
}

/** Enumerate all non-loopback IPv6 addresses on this host (with scope). */
export function listIpv6Addresses(): Ipv6AddressInfo[] {
  const out: Ipv6AddressInfo[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv6") continue;
      if (classifyIpv6(a.address) === "loopback") continue;
      out.push({
        address: a.address,
        scope: classifyIpv6(a.address),
        iface: name,
        internal: a.internal ?? false,
      });
    }
  }
  return out;
}

/** Global unicast IPv6 addresses on this host (the candidates for direct
 *  exposure), most routable first. */
export function globalIpv6Addresses(): string[] {
  return listIpv6Addresses()
    .filter((a) => a.scope === "global" && !a.internal)
    .map((a) => a.address);
}

/**
 * Resolve the public IPv6 to advertise for direct exposure:
 *   1. explicit `prefer` (user/binding override, e.g. a routed /64 address);
 *   2. global-scope addresses on this host (networkInterfaces, deduped);
 *   3. fall back to external public-IPv6 detection (resolvePublicIp(6)) when
 *      the host has egress IPv6 but no global on-interface address (NAT64-free
 *      routed setups are rare on single hosts, but the check is cheap).
 * Returns [] when the host has no usable public IPv6.
 */
export async function detectPublicIpv6(
  prefer?: string,
  opts?: { resolveExternal?: () => Promise<string | null> },
): Promise<string[]> {
  const seen = new Set<string>();
  const add = (a: string | null | undefined) => {
    const clean = (a ?? "").trim();
    if (!clean) return;
    if (!/^\[.*\]$/.test(clean)) {
      // keep as-is (bare or bracketed)
    }
    seen.add(clean);
  };
  if (prefer) add(prefer);
  for (const a of globalIpv6Addresses()) add(a);
  if (seen.size === 0 && opts?.resolveExternal) {
    try {
      add(await opts.resolveExternal());
    } catch {
      // probe failed — no external v6 either
    }
  }
  return [...seen];
}

/** Reachable check: can this host actually accept a TCP connection on
 *  `[addr]:port`? Used by mode "ipv6" to fail fast when the address is not
 *  assigned to a local interface (e.g. a routed address without an IP on the
 *  box). Returns true when the bind succeeds. */
export function probeLocalBind(addr: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    void import("node:net").then(({ createServer }) => {
      const srv = createServer();
      const done = (ok: boolean) => {
        try { srv.close(); } catch { /* not listening */ }
        resolve(ok);
      };
      srv.once("error", () => done(false));
      srv.listen(port, addr, () => done(true));
    }).catch(() => resolve(false));
  });
}

/** Human-readable diagnosis of this host's IPv6 situation (for `st ipv6`). */
export function ipv6Diagnose(): {
  addresses: Ipv6AddressInfo[];
  global: string[];
  hasIpv6Stack: boolean;
  hasGlobal: boolean;
} {
  const addresses = listIpv6Addresses();
  const global = globalIpv6Addresses();
  return {
    addresses,
    global,
    hasIpv6Stack: addresses.length > 0,
    hasGlobal: global.length > 0,
  };
}