/**
 * NAT-PMP backend (RFC 6886 MAP opcodes over udp/5351).
 *
 * PCP (RFC 6887) is a superset sharing port 5351 — a gateway answering
 * NAT-PMP accepts these binary MAP requests; we speak the simpler dialect.
 * Lifetimes are capped by the gateway (typically ≤7200s): callers MUST
 * renew (the PortmapManager does at half-life).
 */
import { createSocket } from "node:dgram";
import { localIpFor } from "./probe.ts";
import { PortmapError, type PortmapAddRequest, type PortmapMapping } from "./upnp.ts";

const DEFAULT_LEASE = 1800;

export function encodeAddressRequest(): Buffer {
  return Buffer.from([0, 0]);
}

export interface NatPmpResponse {
  result: number;
  epoch: number;
  /** public-address responses */
  externalIp?: string;
  /** MAP responses */
  privatePort?: number;
  publicPort?: number;
  lifetimeSeconds?: number;
}

export function decodeResponse(msg: Buffer): NatPmpResponse {
  const result = msg.readUInt16BE(2);
  const epoch = msg.readUInt32LE(4);
  const op = msg[1]! & 0x7f;
  if (op === 0) return { result, epoch, externalIp: [...msg.subarray(8, 12)].join(".") };
  return {
    result,
    epoch,
    privatePort: msg.readUInt16BE(8),
    publicPort: msg.readUInt16BE(10),
    lifetimeSeconds: msg.readUInt32LE(12),
  };
}

export function encodeMapRequest(
  internalPort: number,
  externalPort: number,
  lifetimeSeconds: number,
  protocol: "tcp" | "udp",
): Buffer {
  const buf = Buffer.alloc(12);
  buf[0] = 0;
  buf[1] = protocol === "tcp" ? 2 : 1;
  buf.writeUInt16BE(internalPort, 4);
  buf.writeUInt16BE(externalPort, 6);
  buf.writeUInt32LE(lifetimeSeconds, 8);
  return buf;
}

/** Gateway may be "host" or "host:port" (default port 5351) — the latter is
 *  mainly for tests/dev against non-standard endpoints. */
export function splitGateway(gateway: string): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(gateway);
  return { host: m?.[1] ?? gateway, port: Number(m?.[2]) || 5351 };
}

function request(gateway: string, payload: Buffer, timeoutMs = 2000): Promise<NatPmpResponse> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new PortmapError("nat-pmp timeout", "TIMEOUT"));
    }, timeoutMs);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      try {
        resolve(decodeResponse(msg));
      } catch (e) {
        reject(new PortmapError(`bad nat-pmp response: ${(e as Error).message}`, "BAD_RESPONSE"));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      reject(new PortmapError(e.message, "NETWORK"));
    });
    const { host, port } = splitGateway(gateway);
    sock.send(payload, port, host);
  });
}

export class NatPmpBackend {
  readonly kind = "pcp" as const;
  readonly gateway: string;
  constructor(gateway: string) {
    this.gateway = gateway;
  }

  async getExternalIp(): Promise<string> {
    const r = await request(this.gateway, encodeAddressRequest());
    if (r.result !== 0 || !r.externalIp) throw new PortmapError(`address request failed (${r.result})`, `RESULT_${r.result}`);
    return r.externalIp;
  }

  async add(req: PortmapAddRequest & { internalIp?: string }): Promise<PortmapMapping> {
    const protocol = req.protocol ?? "tcp";
    const wantLease = req.leaseSeconds ?? DEFAULT_LEASE;
    // suggested external port: explicit, else 0 = gateway-assigned
    const suggested = req.externalPort ?? 0;
    const r = await request(this.gateway, encodeMapRequest(req.internalPort, suggested, wantLease, protocol));
    if (r.result !== 0 || !r.publicPort || !r.privatePort)
      throw new PortmapError(
        `MAP failed (result ${r.result}: ${natpmpResultText(r.result)})`,
        `RESULT_${r.result}`,
      );
    return {
      backend: "pcp",
      gateway: this.gateway,
      internalIp: req.internalIp ?? (await localIpFor(this.gateway)),
      internalPort: r.privatePort,
      externalPort: r.publicPort,
      protocol,
      leaseSeconds: Math.min(r.lifetimeSeconds ?? wantLease, wantLease),
      description: req.description || "service-tunnels",
    };
  }

  check(): Promise<boolean> {
    return Promise.reject(new PortmapError("NAT-PMP has no mapping query opcode", "UNSUPPORTED"));
  }

  async remove(internalPort: number, externalPort: number, protocol: "tcp" | "udp" = "tcp"): Promise<void> {
    const r = await request(this.gateway, encodeMapRequest(internalPort, externalPort, 0, protocol));
    if (r.result !== 0) throw new PortmapError(`unmap failed (result ${r.result})`, `RESULT_${r.result}`);
  }
}

export function natpmpResultText(result: number): string {
  switch (result) {
    case 1: return "unsupported version";
    case 2: return "not authorized / refused (permission rules?)";
    case 3: return "network failure";
    case 4: return "out of resources";
    case 5: return "unsupported opcode";
    default: return "unknown error";
  }
}
