/**
 * UPnP IGD backend (AddPortMapping / DeletePortMapping over SOAP).
 *
 * Measured quirks this code accounts for:
 * - errorCode 718 (ConflictInMappingEntry) can mean a port conflict OR a
 *   permission-rule rejection (OpenWrt default rules only allow high
 *   internal ports) — retry with fresh random external ports.
 * - IGDv1 devices ignore LeaseDuration (0 = forever); we always send a
 *   finite lease and renew — a stale rule then self-expires.
 */
import { localIpFor, soapRequest, type WanService } from "./probe.ts";

export interface PortmapAddRequest {
  internalPort: number;
  /** tcp (default) | udp */
  protocol?: "tcp" | "udp";
  externalPort?: number;
  /** Finite lease in seconds (default 1800). Renewed at half-life. */
  leaseSeconds?: number;
  description?: string;
  /** 718 冲突时先 Delete 再重试一次（仅当 externalPort 是本方持久化的——
   *  daemon 重启恢复场景；普通冲突不启用，避免误删他人映射）。 */
  forceReplace?: boolean;
}

export interface PortmapMapping {
  backend: "upnp" | "pcp" | "ssh-router";
  gateway: string;
  internalIp: string;
  internalPort: number;
  externalPort: number;
  protocol: "tcp" | "udp";
  leaseSeconds: number;
  description: string;
}

export class PortmapError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "PortmapError";
    this.code = code;
  }
}

const DYNAMIC_PORT_MIN = 49152; // UPnP-recommended dynamic range
const DEFAULT_LEASE = 1800;

function randomDynamicPort(): number {
  return DYNAMIC_PORT_MIN + Math.floor(Math.random() * (65535 - DYNAMIC_PORT_MIN + 1));
}

export class UpnpBackend {
  readonly kind = "upnp" as const;
  readonly service: WanService;
  #gateway: string;

  constructor(gateway: string, service: WanService) {
    this.#gateway = gateway;
    this.service = service;
  }

  get gateway(): string {
    return this.#gateway;
  }

  async getExternalIp(): Promise<string> {
    const r = await soapRequest(this.service, "GetExternalIPAddress");
    const ip = /<NewExternalIPAddress>\s*([0-9.]+)/i.exec(r.data)?.[1];
    if (!ip) throw new PortmapError(`GetExternalIPAddress failed: ${r.error ?? r.status}`, "SOAP");
    return ip;
  }

  /**
   * Add a mapping. On 718/conflict retries fresh random dynamic ports unless
   * an explicit externalPort was requested. Returns the effective mapping.
   */
  async add(req: PortmapAddRequest & { internalIp?: string }): Promise<PortmapMapping> {
    const internalIp = req.internalIp ?? (await localIpFor(this.#gateway));
    const leaseSeconds = req.leaseSeconds ?? DEFAULT_LEASE;
    const protocol = req.protocol ?? "tcp";
    const description = req.description || "service-tunnels";
    const maxAttempts = req.externalPort ? (req.forceReplace ? 2 : 1) : 8;
    let lastError: PortmapError | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // forceReplace 重试（attempt>0）时仍用请求的 externalPort——删除旧映射
      // 后重加必须保持同一外部端口（daemon 恢复场景端口不能变）。
      const externalPort = req.externalPort ? req.externalPort : randomDynamicPort();
      const r = await soapRequest(
        this.service,
        "AddPortMapping",
        `<NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort>` +
          `<NewProtocol>${protocol.toUpperCase()}</NewProtocol><NewInternalPort>${req.internalPort}</NewInternalPort>` +
          `<NewInternalClient>${internalIp}</NewInternalClient><NewEnabled>1</NewEnabled>` +
          `<NewPortMappingDescription>${escapeXml(description)}</NewPortMappingDescription>` +
          `<NewLeaseDuration>${leaseSeconds}</NewLeaseDuration>`,
      );
      if (r.status === 200) {
        return {
          backend: "upnp",
          gateway: this.#gateway,
          internalIp,
          internalPort: req.internalPort,
          externalPort,
          protocol,
          leaseSeconds,
          description,
        };
      }
      const code = /<errorCode>\s*(\d+)/i.exec(r.data)?.[1] ?? String(r.error ?? r.status);
      lastError = new PortmapError(`AddPortMapping ${externalPort} failed (code ${code})`, code);
      // 718 conflict / 725 lease unsupported → try another port; anything else is fatal.
      // 显式 externalPort 时不重试（调用方指定了端口，冲突即失败）。
      if (code !== "718" || req.externalPort) {
        // forceReplace（daemon 重启恢复）：externalPort 是本方持久化的，718 = 旧映射
        // 内部目标已变（新 transport 端口）——先 Delete 旧映射再重试一次。
        if (code === "718" && req.externalPort && req.forceReplace) {
          await this.remove(externalPort, protocol);
          continue;
        }
        break;
      }
    }
    throw lastError ?? new PortmapError("AddPortMapping failed", "UNKNOWN");
  }

  /** Verify a mapping still exists (and matches). Throws when gone. */
  async check(externalPort: number, protocol: "tcp" | "udp", internalPort: number): Promise<boolean> {
    const r = await soapRequest(
      this.service,
      "GetSpecificPortMappingEntry",
      `<NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort>` +
        `<NewProtocol>${protocol.toUpperCase()}</NewProtocol>`,
    );
    if (r.status !== 200) return false;
    return Number(/<NewInternalPort>\s*(\d+)/i.exec(r.data)?.[1]) === internalPort;
  }

  async remove(externalPort: number, protocol: "tcp" | "udp" = "tcp"): Promise<void> {
    await soapRequest(
      this.service,
      "DeletePortMapping",
      `<NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort>` +
        `<NewProtocol>${protocol.toUpperCase()}</NewProtocol>`,
    );
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}
