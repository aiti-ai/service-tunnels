/**
 * Portmap manager — mode "portmap" orchestration.
 *
 * Picks a backend (upnp → pcp), establishes the router mapping toward the
 * local proxy transport (auth still applies — see docs/portmap-analysis.md
 * §3), and keeps it alive with a half-life renewal loop. Finite leases are
 * mandatory: a crashed process leaves a rule that self-expires instead of a
 * permanent hole.
 */
import { classifyExternalIp, localIpFor, probePortmap, type PortmapProbe } from "./probe.ts";
import { NatPmpBackend } from "./natpmp.ts";
import { PortmapError, UpnpBackend, type PortmapAddRequest, type PortmapMapping } from "./upnp.ts";
import { SshRouterBackend, type RouterPreset, type SshRouterOptions } from "./ssh-router.ts";

export type PortmapMethod = "auto" | "upnp" | "pcp" | "ssh-router";

export interface EnsureMappingOptions extends Omit<PortmapAddRequest, "internalPort"> {
  method?: PortmapMethod;
  gateway?: string;
  /** Manual UPnP control-URL override (skips SSDP discovery; test/dev). */
  controlUrl?: string;
  serviceType?: string;
  probe?: PortmapProbe;
  /** SSDP wait budget for the capability probe (tests: keep small). */
  ssdpTimeoutMs?: number;
  /** ssh-router backend options (method "ssh-router"). */
  sshRouter?: SshRouterOptions;
  /** stop() 时额外执行的清理（如删除本次打开的防火墙规则）。 */
  onStopCleanup?: () => Promise<void>;
}

export interface MapHandle {
  mapping: PortmapMapping;
  externalIp: string;
  probe: PortmapProbe;
  /** 最近一次续租失败（无失败时为 null）——M5: 续租错误可观测，不再静默。 */
  lastRenewError?: string;
  /** 续租失败回调（可空）——宿主可挂日志/告警。 */
  onRenewError?: (err: string) => void;
  /** Stop renewal + best-effort remove the mapping. */
  stop(): Promise<void>;
}

export class PortmapUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortmapUnavailableError";
  }
}

/** probe 结果缓存（G6）：每次 expose 全量探测要 ~6s（SSDP 3s + NAT-PMP 3s）——
 *  网关能力短期不变，按 gateway 缓存 60s。controlUrl 显式时无需探测。 */
const probeCache = new Map<string, { at: number; probe: PortmapProbe }>();
const PROBE_TTL = 60_000;

async function cachedProbe(gateway: string, ssdpTimeoutMs?: number): Promise<PortmapProbe> {
  const hit = probeCache.get(gateway);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.probe;
  const probe = await probePortmap({ gateway, ssdpTimeoutMs });
  probeCache.set(gateway, { at: Date.now(), probe });
  return probe;
}

async function pickBackend(opts: EnsureMappingOptions): Promise<{ backend: UpnpBackend | NatPmpBackend | SshRouterBackend; probe: PortmapProbe }> {
  const gateway = opts.gateway ?? (() => {
    throw new PortmapUnavailableError("portmap: no gateway given and none could be detected");
  })();
  const method: PortmapMethod = opts.method ?? "auto";

  // ssh-router: explicit SSH backend, no LAN protocol probing needed.
  if (method === "ssh-router") {
    if (!opts.sshRouter) throw new PortmapUnavailableError("method ssh-router requires opts.sshRouter {host,preset,...}");
    return { backend: new SshRouterBackend(opts.sshRouter), probe: { gateway: opts.sshRouter.host, ipClass: "unknown" } };
  }
  if (method === "upnp" && opts.controlUrl) {
    const backend = new UpnpBackend(gateway, {
      controlUrl: opts.controlUrl,
      serviceType: opts.serviceType ?? "urn:schemas-upnp-org:service:WANIPConnection:1",
    });
    return { backend, probe: { gateway, ipClass: "unknown" } };
  }

  const probe = await cachedProbe(gateway, opts.ssdpTimeoutMs);

  const tryUpnp = async (): Promise<UpnpBackend> => {
    if (opts.controlUrl) {
      return new UpnpBackend(gateway, { controlUrl: opts.controlUrl, serviceType: opts.serviceType ?? "urn:schemas-upnp-org:service:WANIPConnection:1" });
    }
    // M4: 显式检查而非双重非空断言——probe.ok 为真但缺 controlUrl 时给出清晰错误
    if (!probe.upnp?.ok || !probe.upnp.controlUrl || !probe.upnp.serviceType)
      throw new PortmapUnavailableError("gateway has no UPnP IGD (or probe result incomplete)");
    return new UpnpBackend(gateway, { controlUrl: probe.upnp.controlUrl, serviceType: probe.upnp.serviceType });
  };
  const tryPcp = async (): Promise<NatPmpBackend> => {
    if (!probe.pcp?.ok) throw new PortmapUnavailableError("gateway has no NAT-PMP/PCP on udp/5351");
    return new NatPmpBackend(gateway);
  };

  let backend: UpnpBackend | NatPmpBackend | SshRouterBackend;
  if (method === "upnp") backend = await tryUpnp();
  else if (method === "pcp") backend = await tryPcp();
  else {
    // auto: prefer UPnP (queryable + explicit delete), fall back to NAT-PMP/PCP
    backend = await tryUpnp().catch(() => tryPcp());
  }
  return { backend, probe };
}

/** Registry of live mappings keyed by expose key (`<configDir>:<name>`). */
const active = new Map<string, MapHandle>();

export function listPortmaps(): Array<MapHandle & { key: string }> {
  return [...active].map(([key, h]) => ({ ...h, key }));
}

export async function stopPortmap(key: string): Promise<boolean> {
  const h = active.get(key);
  if (!h) return false;
  active.delete(key);
  await h.stop();
  return true;
}

/**
 * Establish (and keep alive) an external-port → internalPort mapping on the
 * default/explicit gateway. Returns a handle whose `stop()` removes it.
 */
export async function ensurePortmap(name: string, internalPort: number, opts: EnsureMappingOptions = {}): Promise<MapHandle> {
  const { backend, probe } = await pickBackend(opts);
  if (probe.ipClass === "cgnat")
    throw new PortmapUnavailableError(
      "external IP is CGNAT (RFC 6598 shared address) — port mapping cannot be reached from the internet; use a tunnel provider",
    );
  const internalIp = await localIpFor(probe.gateway);
  const mapping =
    "kind" in backend && backend.kind === "upnp"
      ? await (backend as UpnpBackend).add({ ...opts, internalPort, internalIp })
      : "kind" in backend && backend.kind === "ssh-router"
        ? await (backend as SshRouterBackend).add({ ...opts, internalPort, internalIp, name })
        : await (backend as NatPmpBackend).add({ ...opts, internalPort, internalIp });
  const externalIp =
    probe.externalIp ??
    ("getExternalIp" in backend
      ? await (backend as UpnpBackend | NatPmpBackend | SshRouterBackend).getExternalIp()
      : undefined);
  if (!externalIp) throw new PortmapUnavailableError("could not determine external IP");
  // F3: 对最终 externalIp 统一分类——ssh-router 路径 probe.ipClass 是 "unknown"，
  // CGNAT/私网必须在拿到真实公网 IP 后再查一次（否则运营商大内网下映射静默无效）。
  if (classifyExternalIp(externalIp) === "cgnat" || classifyExternalIp(externalIp) === "private") {
    // mapping 已建立——尽力回滚再报错，避免留孤儿规则
    try {
      if ("kind" in backend && backend.kind === "upnp") await (backend as UpnpBackend).remove(mapping.externalPort, mapping.protocol);
      else if ("kind" in backend && backend.kind === "ssh-router")
        await (backend as SshRouterBackend).remove(mapping.externalPort, mapping.protocol, name, { internalIp, internalPort });
      else await (backend as NatPmpBackend).remove(mapping.internalPort, mapping.externalPort, mapping.protocol);
    } catch { /* best effort */ }
    throw new PortmapUnavailableError(
      `external IP ${externalIp} is CGNAT/private (RFC 6598 or RFC 1918) — port mapping cannot be reached from the internet; use a tunnel provider`,
    );
  }

  // Renewal loop at half-life — UPnP renew == re-Add; NAT-PMP renew == re-MAP.
  // ssh-router rules are static: no renewal, and removal is by tag.
  const isSshRouter = "kind" in backend && backend.kind === "ssh-router";
  const intervalMs = isSshRouter ? 0 : Math.max(30_000, (mapping.leaseSeconds / 2) * 1000);
  let stopped = false;
  let renewing: Promise<void> | null = null;
  let lastRenewError: string | undefined;
  let onRenewError: ((err: string) => void) | undefined;
  const timer = intervalMs
    ? setInterval(
        () => {
          if (renewing || stopped) return;
          renewing = (async () => {
            try {
              // 续租必须锚定已分配的外部端口（renew = 刷新租约，不是重新分配）——
              // 否则 suggested=0 / 随机端口 → gateway 可能换端口（UPnP 718 重试
              // 甚至漂到新端口），映射 URL 就失效了。
              const renewOpts = { ...opts, internalPort, internalIp, externalPort: mapping.externalPort };
              if ("kind" in backend && backend.kind === "upnp")
                await (backend as UpnpBackend).add(renewOpts);
              else await (backend as NatPmpBackend).add(renewOpts);
              lastRenewError = undefined; // 续租成功清除
            } catch (e) {
              // M5: 续租失败不再完全静默——记录 + 回调（有限租约仍兜底自愈，
              // 但宿主需要知道映射可能已过期）。
              lastRenewError = (e as Error).message;
              onRenewError?.(lastRenewError);
            } finally {
              renewing = null;
            }
          })();
        },
        intervalMs,
      )
    : null;
  timer?.unref?.();

  const handle: MapHandle = {
    mapping,
    externalIp,
    probe,
    get lastRenewError() {
      return lastRenewError;
    },
    set onRenewError(cb: ((err: string) => void) | undefined) {
      onRenewError = cb;
    },
    get onRenewError() {
      return onRenewError;
    },
    stop: async () => {
      if (stopped) return; // M2: 幂等（stop 两次只删一次）
      stopped = true;
      active.delete(name); // registry cleanup — stop() must mirror stopPortmap()
      if (timer) clearInterval(timer);
      try {
        if ("kind" in backend && backend.kind === "upnp")
          await (backend as UpnpBackend).remove(mapping.externalPort, mapping.protocol);
        else if ("kind" in backend && backend.kind === "ssh-router")
          await (backend as SshRouterBackend).remove(
            mapping.externalPort,
            mapping.protocol,
            mapping.description.replace("service-tunnels:", ""),
            { internalIp: mapping.internalIp, internalPort: mapping.internalPort },
          );
        else await (backend as NatPmpBackend).remove(mapping.internalPort, mapping.externalPort, mapping.protocol);
      } catch {
        // best effort — the lease self-expires anyway (ssh-router: sweep())
      }
      // 本次映射附加的清理（如防火墙规则——只删本次打开的）
      if (opts.onStopCleanup) {
        try {
          await opts.onStopCleanup();
        } catch { /* best effort */ }
      }
    },
  };
  // M1: 同 name 重复注册时先停旧 handle（旧定时器随旧 handle 停止），避免泄漏。
  const prev = active.get(name);
  if (prev) await prev.stop().catch(() => {});
  active.set(name, handle);
  return handle;
}

export { PortmapError } from "./upnp.ts";
export { probePortmap, defaultGateway, classifyExternalIp, type PortmapProbe, type ExternalIpClass, type UpnpProbe } from "./probe.ts";
export type { PortmapAddRequest, PortmapMapping } from "./upnp.ts";
export { SshRouterBackend, type RouterPreset, type SshRouterOptions } from "./ssh-router.ts";
