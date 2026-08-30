/**
 * Portmap capability probe — router/gateway detection for mode "portmap".
 *
 * Two discovery channels are REQUIRED (measured on a real OpenWrt/miniupnpd
 * gateway): multicast SSDP is swallowed by some bridges — a unicast
 * M-SEARCH straight to the gateway must be tried as well.
 */
import { createSocket, type RemoteInfo } from "node:dgram";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { splitGateway } from "./natpmp.ts";

export type ExternalIpClass = "public" | "cgnat" | "private" | "unknown";

export interface UpnpProbe {
  ok: boolean;
  /** SOAP control URL of the WAN(IP|PPP)Connection service. */
  controlUrl?: string;
  serviceType?: string;
  error?: string;
}

export interface PortmapProbe {
  gateway: string;
  externalIp?: string;
  ipClass: ExternalIpClass;
  upnp?: UpnpProbe;
  /** NAT-PMP/PCP (udp/5351) — ok implies nat-pmp compat (PCP superset). */
  pcp?: { ok: boolean; externalIp?: string; error?: string };
  recommended?: "upnp" | "pcp" | null;
}

/** Default IPv4 gateway from the routing table (linux /proc + macOS route). */
export function defaultGateway(): string | null {
  try {
    const lines = readFileSync("/proc/net/route", "utf8").trim().split("\n");
    for (const line of lines.slice(1)) {
      const f = line.split(/\s+/);
      if (f[1] === "00000000" && f[7] === "00000000") {
        const hex = f[2]!;
        return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
      }
    }
  } catch {
    // not linux — fall through to `route`
  }
  try {
    const out = execFileSync("route", ["-n", "get", "default"], { timeout: 2000 }).toString();
    return /gateway:\s*(\S+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The source address this host would use to reach `gateway` (UDP connect trick). */
export function localIpFor(gateway: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.once("error", reject);
    sock.connect(5351, gateway, () => {
      const addr = sock.address();
      sock.close(() => resolve(addr?.address ?? "127.0.0.1"));
    });
  });
}

const IGD_SEARCH_TYPES = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
];

/** SSDP M-SEARCH — multicast AND unicast (some gateways only answer one). */
export function ssdpDiscover(opts: { gateway?: string; timeoutMs?: number } = {}): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    const hits = new Set<string>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve([...hits]);
    };
    const msearch = (st: string, host: string) =>
      Buffer.from(
        ["M-SEARCH * HTTP/1.1", `HOST: ${host}`, `ST: ${st}`, 'MAN: "ssdp:discover"', "MX: 2", "", ""].join("\r\n"),
      );
    sock.on("message", (msg: Buffer, rinfo: RemoteInfo) => {
      const text = msg.toString();
      if (!/200/i.test(text.split("\r\n")[0] ?? "")) return;
      const loc = /LOCATION:\s*(\S+)/i.exec(text)?.[1];
      if (loc) hits.add(loc);
      void rinfo;
    });
    sock.on("error", finish);
    sock.bind(() => {
      for (const st of IGD_SEARCH_TYPES) {
        sock.send(msearch(st, "239.255.255.250:1900"), 1900, "239.255.255.250"); // multicast
        if (opts.gateway) sock.send(msearch(st, `${opts.gateway}:1900`), 1900, opts.gateway); // unicast
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

function httpGet(url: string, timeoutMs = 3000, redirect = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode! >= 300 && res.statusCode! < 400 && res.headers.location && redirect < 3) {
        res.resume();
        httpGet(new URL(res.headers.location, url).href, timeoutMs, redirect + 1).then(resolve, reject);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        req.destroy(); // 释放连接（L4: 防 keep-alive 挂起）
        resolve(body);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
  });
}

export interface WanService {
  serviceType: string;
  controlUrl: string;
}

/** Extract the WANIPConnection/WANPPPConnection service control URL from device XML. */
export function findWanConnection(xml: string, baseUrl: string): WanService | null {
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]!);
  for (const svc of services) {
    const serviceType = /<serviceType>\s*([^<]+)/i.exec(svc)?.[1]?.trim() ?? "";
    if (!/WAN(IP|PPP)Connection/i.test(serviceType)) continue;
    const controlUrl = /<controlURL>\s*([^<]+)/i.exec(svc)?.[1]?.trim();
    if (controlUrl) return { serviceType, controlUrl: new URL(controlUrl, baseUrl).href };
  }
  return null;
}

export async function fetchDeviceDescription(location: string): Promise<WanService | null> {
  const xml = await httpGet(location);
  return findWanConnection(xml, location);
}

/** SOAP POST against a UPnP WAN connection service. */
export function soapRequest(
  service: WanService,
  action: string,
  argsXml = "",
  timeoutMs = 4000,
): Promise<{ status?: number; data: string; error?: string }> {
  const body =
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"` +
    ` s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="${service.serviceType}">${argsXml}</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve) => {
    const u = new URL(service.controlUrl);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          SOAPACTION: `"${service.serviceType}#${action}"`,
          "Content-Type": 'text/xml; charset="utf-8"',
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, data }));
      },
    );
    req.on("error", (e) => resolve({ data: "", error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ data: "", error: "timeout" });
    });
    req.end(body);
  });
}

/** RFC1918 / CGNAT (RFC 6598 100.64.0.0/10) classification of an external IP. */
export function classifyExternalIp(ip: string | undefined): ExternalIpClass {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return "unknown";
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^127\.|^169\.254\./.test(ip)) return "private";
  const o = ip.split(".").map(Number);
  if (o[0]! === 100 && o[1]! >= 64 && o[1]! <= 127) return "cgnat";
  return "public";
}

/** NAT-PMP public-address probe (RFC 6886 op=0) — also proves PCP reachability. */
export function natpmpAddressProbe(gateway: string, timeoutMs = 1500, retries = 2): Promise<{ ok: boolean; externalIp?: string; error?: string }> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (r: { ok: boolean; externalIp?: string; error?: string }) => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(r);
    };
    const { host, port } = splitGateway(gateway);
    const send = () => {
      attempts++;
      sock.send(Buffer.from([0, 0]), port, host);
      timer = setTimeout(() => {
        if (attempts < retries) send();
        else finish({ ok: false, error: "timeout" });
      }, timeoutMs);
    };
    sock.on("message", (msg) => {
      // response: ver(0) op(0x80) result(u16BE) epoch(u32LE) ip(4B)
      if (msg.length >= 12 && msg[1] === 0x80 && msg.readUInt16BE(2) === 0)
        finish({ ok: true, externalIp: [...msg.subarray(8, 12)].join(".") });
      else finish({ ok: false, error: `result=${msg.readUInt16BE(2)}` });
    });
    sock.on("error", (e) => finish({ ok: false, error: e.message }));
    sock.bind(send);
  });
}

/** Full probe: gateway → SSDP (multi+uni cast) → device XML → NAT-PMP/PCP → routability. */
export async function probePortmap(opts: { gateway?: string; ssdpTimeoutMs?: number } = {}): Promise<PortmapProbe> {
  const gateway = opts.gateway ?? defaultGateway();
  if (!gateway) throw new Error("portmap: no default gateway found");
  const [locations, pmp] = await Promise.all([
    ssdpDiscover({ gateway, timeoutMs: opts.ssdpTimeoutMs ?? 3000 }),
    natpmpAddressProbe(gateway),
  ]);
  const externalIp = pmp.externalIp;
  const ipClass = classifyExternalIp(externalIp);
  const probe: PortmapProbe = { gateway, externalIp, ipClass, pcp: { ...pmp } };
  // UPnP: try SSDP hits, fall back to well-known miniupnpd description path.
  const descUrls = [...locations, `http://${gateway}:5000/rootDesc.xml`, `http://${gateway}:49152/rootDesc.xml`];
  for (const loc of descUrls) {
    try {
      const svc = await fetchDeviceDescription(loc);
      if (svc) {
        const ext = await soapRequest(svc, "GetExternalIPAddress");
        const upnpExternalIp = /<NewExternalIPAddress>\s*([0-9.]+)/i.exec(ext.data)?.[1];
        probe.upnp = { ok: true, controlUrl: svc.controlUrl, serviceType: svc.serviceType };
        if (!probe.externalIp) {
          probe.externalIp = upnpExternalIp;
          probe.ipClass = classifyExternalIp(upnpExternalIp);
        }
        break;
      }
    } catch (e) {
      probe.upnp = { ok: false, error: (e as Error).message };
    }
  }
  if (!probe.upnp) probe.upnp = locations.length ? { ok: false, error: "no WANConnection service found" } : { ok: false, error: "no SSDP response" };
  probe.recommended = probe.upnp.ok ? "upnp" : probe.pcp!.ok ? "pcp" : null;
  return probe;
}
