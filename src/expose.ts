import { GatewayController, type GatewayAuthMode, type GatewayInject, detectProtocol } from "./gateway.ts";
import { ProxyManager } from "./proxy-manager.ts";
import { readSites, type SiteConfig } from "./sites.ts";
import { readConfigFile, resolveBaseDomains, resolveAllowAuthNone } from "./config.ts";
import { RedisController } from "./redis.ts";
import { validateBypassPaths, isUserManager, type UserManager } from "./auth-provider.ts";
import type { AuthProvider, ProviderContext } from "./auth-provider.ts";
import { AuthRegistry } from "./auth-registry.ts";
import { tunnelSupportsTcp } from "./tunnels.ts";
import type { TunnelManager } from "./tunnels.ts";
import { InternalRegistry } from "./internal.ts";
/** Default auth provider. Portal is Node-based (no external binaries) and
 *  feature-complete (2FA incl. biometrics) — default on every platform.
 *  Authelia remains available via explicit `--auth auto`/`--provider`. */
function getDefaultAuthProvider(): string {
  return "portal";
}

/** "oidc.issuerUrl" → { oidc: { issuerUrl } } — schema-driven form params
 *  arrive flat; provider options are nested. */
/** "true"/"false" → boolean；纯数字字符串 → number（schema 表单参数以字符串到达，
 *  而 provider opts 需要真实类型：portal biometrics === true / TTL number 等）。 */
export function coerceParamValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

export function unflattenParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(params)) {
    const parts = key.split(".");
    let cur = out;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      // prototype-pollution guard: never traverse __proto__/constructor/prototype
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        ok = false;
        break;
      }
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = Object.create(null);
      cur = cur[k] as Record<string, unknown>;
    }
    if (ok && parts[parts.length - 1] !== "__proto__" && parts[parts.length - 1] !== "constructor") {
      cur[parts[parts.length - 1]!] = coerceParamValue(value);
    }
  }
  return out;
}

/**
 * expose — the one-shot flow: tunnel + (optional) gateway auth.
 *
 *   expose <port> [--auth [<provider>]]
 *
 * Without --auth: start a tunnel pointing straight at the local port.
 * With --auth: start the shared infrastructure (nginx gateway + provider +
 * Redis if needed), start a tunnel pointing at the nginx gateway port, wait
 * for the public URL, then dynamically register the public host with the
 * provider (auth applies immediately).
 *
 * Auth is applied at the gateway — the tunnel is a pure transport (design.md
 * §5). Random hosts work (dynamic registration).
 */

import { ensurePortmap, PortmapUnavailableError, type MapHandle } from "./portmap/index.ts";
import { openFirewall, removeFirewall } from "./portmap/firewall.ts";

export interface ExposeOptions {
  port: number;
  /** Exposure mode (sites-design.md §4): "tunnel" (default, existing),
   *  "proxy" (local virtual host only, NO tunnel process), "both" (local
   *  vhost + public tunnel sharing one site), "portmap" (router port mapping:
   *  external IP:port → the local proxy transport; auth still applies —
   *  docs/portmap-analysis.md). */
  mode?: "tunnel" | "proxy" | "both" | "portmap";
  /** @internal set by the dispatcher: whether the caller explicitly passed
   *  --site (distinguishes `--site default` from no --site — the former keeps
   *  the reserved "auth" label, the latter carries the provider name). */
  siteExplicit?: boolean;
  /** Auth realm (site) for mode proxy/both. Default "default" (vhost label
   *  "auth"); an explicit provider without --site stays on the DEFAULT realm
   *  with a provider-name vhost label (D3: `5173-basic` = basic on default). */
  site?: string;
  /** Explicit vhost dash label — overrides the site/provider-derived label
   *  (embedder wants a stable "<port>-<label>.<domain>" entry even for
   *  auth=none opens; keeps basePath apps on the labeled pipe path). */
  label?: string;
  /** Proxy transport port for mode proxy/both (default 4180, busy → random). */
  proxyPort?: number;
  /** Skip starting the proxy transport (an embedder middleware serves vhosts
   *  in-process via resolve()); localUrl is then empty. Default: start. */
  startTransport?: boolean;
  /** 该 vhost 真实服务的 base path(转发映射,默认继承构造 serviceBasePath)。 */
  serviceBasePath?: string;
  /** 认证放行白名单（URL 路径前缀）：这些路径跳过认证直接转发应用
   *  （/health、/metrics 等公开端点）。proxy/nginx 双路径生效。 */
  bypassPaths?: string[];
  /**
   * 静态响应注入（tunnel nginx 路径——浏览器 → 隧道边缘 → nginx 网关 → 应用，
   * 不经过 node proxy，proxy 的 transformResponse 够不着；nginx 配置是静态的，
   * 所以传固定 HTML 片段而非回调）。string → head 模式；{ html, position } 指定
   * 模式。只作用于 text/html 且仅主页面导航（Sec-Fetch-Mode: navigate / 老客户端
   * 无该头；XHR/fetch/子资源不注入）——避免把用户后加载的模板片段/文件注坏。
   * 注：edge-auth 隧道（ngrok edge-oidc 等跳过本地网关）与 tcp/ssh 裸隧道不适用。
   */
  inject?: string | GatewayInject;
  /** 注入「登录信息按钮」（悬浮 FAB：登录用户名 + 退出登录，可拖动四边停靠）。
   *  默认 false（显式开启）；仅 portal/authelia/basic 认证通道生效（token/
   *  none 无会话语义——忽略并 log）。 */
  loginInfoButton?: boolean;
  /**
   * User's wildcard-DNS base domain (e.g. "example.com") — overrides
   * config service-tunnels.json `baseDomain`. expose also returns a PORTLESS
   * base URL `<port>[-<label>].<baseDomain>` (user reverse-proxies it).
   */
  baseDomain?: string;
  /** true = gateway auth (default provider), false = no auth, "auto" = pick
   *  the best available provider (authelia > portal > basic). */
  auth?: boolean | "auto" | string;
  /** 禁止无认证暴露的安全开关：false = 本次 expose 的 auth 必须为真（auth
   *  none/tcp/开放绑定被拒）。缺省按 createServiceTunnels opts > env
   *  SERVICE_TUNNELS_ALLOW_AUTH_NONE > 配置档 allow-auth-none 解析（任一
   *  层为 false 即禁止——安全开关不可被单次调用 true 覆盖）。 */
  allowAuthNone?: boolean;
  provider?: string;
  tunnelName?: string;
  tunnelType?: string;
  /** Forwarding protocol: "http"/"https" via the nginx gateway (auth/logs);
   *  "tcp" raw direct tunnel (no gateway). Default: auto-detect the app port. */
  protocol?: "http" | "https" | "tcp";
  policy?: "one_factor" | "two_factor" | "deny";
  nginxPort?: number;
  autheliaPort?: number;
  redisPort?: number;
  basePath?: string;
  user?: { name: string; password: string };
  sessionSecret?: string;
  /** External authelia reload command (operator-managed authelia). */
  autheliaReloadCmd?: string;
  /** ngrok authtoken — injected as NGROK_AUTHTOKEN env into the ngrok process
   *  so it authenticates (otherwise ngrok exits with ERR_NGROK_4018). */
  ngrokAuthtoken?: string;
  /** SSH gateway domain (auth layer for raw TCP exposes). When set, the tcp
   *  tunnel target becomes the gateway's SSH port instead of the app port:
   *  only holders of an authorized private key can reach the service. */
  sshGateway?: string;
  /** Allow on-demand tool downloads for THIS expose (param > env > config
   *  fallback > default true). When false, missing tools error instead of
   *  downloading. */
  allowToolDownload?: boolean;
  /** Extra tunnel config fields (schema-driven form): keys are TunnelConfig
   *  fields (domain/server/token/host/user/port/remotePort/cmd/...). Applied
   *  BEFORE name/type/target/env so those can't be overridden. */
  tunnelParams?: Record<string, unknown>;
  /** Dangerous-type opt-in for `tunnelType: "command"` (runs a raw shell
   *  command). Required at the daemon RPC boundary — the CLI carries it for
   *  `--tunnel command`; library callers that surfaced the semantics set it
   *  explicitly. */
  dangerous?: boolean;
  /** Extra auth-provider options (schema-driven form). Dot keys nest
   *  ("oidc.issuerUrl" → { oidc: { issuerUrl } }). */
  providerParams?: Record<string, unknown>;
  /** When true, skip the port ownership check (allow tunneling other users' ports). */
  force?: boolean;
  /** mode "portmap" options (docs/portmap-analysis.md §4.2). */
  portmap?: {
    method?: "auto" | "upnp" | "pcp" | "ssh-router";
    gateway?: string;
    /** Manual UPnP SOAP control URL (skips SSDP discovery — test/dev). */
    controlUrl?: string;
    serviceType?: string;
    externalPort?: number;
    leaseSeconds?: number;
    /** SSDP 探测等待预算（默认 3s；测试/排障可调小）。 */
    ssdpTimeoutMs?: number;
    /** ssh-router backend (method "ssh-router"): host/preset/key/... */
    sshRouter?: {
      host: string;
      user?: string;
      port?: number;
      key?: string;
      preset: "openwrt" | "routeros" | "generic-iptables";
      connectTimeout?: number;
    };
  };
}

export interface ExposeResult {
  url: string | null;
  tunnel: string;
  /** Forwarding protocol used (http/https/tcp) — detected or explicit. */
  protocol?: "http" | "https" | "tcp";
  provider?: string;
  /** Login portal page (provider basePath under the tunnel URL). */
  loginUrl?: string;
  gateway?: { nginx: number; authelia: number; redis: number };
  /** Failure reason when `url` is null (e.g. ngrok "not authenticated").
   *  Surfaced so callers/UI aren't left with a silent null URL. */
  error?: string;
  /** Mode used ("tunnel" | "proxy" | "both" | "portmap"). */
  mode?: "tunnel" | "proxy" | "both" | "portmap";
  /** Router mapping details when mode === "portmap". */
  portmap?: {
    backend: "upnp" | "pcp" | "ssh-router";
    gateway: string;
    externalIp: string;
    externalPort: number;
    internalPort: number;
    leaseSeconds: number;
    /** 实际使用的 method（恢复用——ssh-router 映射重启后必须按原后端恢复）。 */
    method?: "auto" | "upnp" | "pcp" | "ssh-router";
    /** ssh-router 参数（method=ssh-router 时恢复必需：preset/host 等）。 */
    sshRouter?: { host: string; user?: string; port?: number; key?: string; preset: "openwrt" | "routeros" | "generic-iptables"; connectTimeout?: number };
  };
  /** Site (auth realm) the expose belongs to; "" for open bindings. */
  site?: string;
  /** Vhost dash label ("auth" for the default site, site name otherwise,
   *  "" for open). */
  label?: string;
  /** Local virtual-host URL (mode proxy/both), e.g.
   *  http://5173-portal.st.localhost:4180. */
  localUrl?: string;
  /** Portless URL under the user's base domain (mode proxy/both, when
   *  baseDomain is configured), e.g. http://5173-portal.example.com. */
  baseUrl?: string;
  /** Portless URL under the site's OWN domain (`<port>.<site-domain>`, when
   *  the site has a domain), e.g. http://5173.web.example.com. */
  domainUrl?: string;
}

export interface ExposeContext {
  configDir: string;
  cacheDir: string;
  resolveTool: (name: string) => Promise<string>;
  internal: InternalRegistry;
  tunnels: TunnelManager;
  /** Register a spawned helper PID (guardian cleanup). */
  registerPid?: (role: string, pid: number) => void;
  /** Auth provider registry (built-ins + plugins). */
  auth?: AuthRegistry;
  /** Called after every internal tunnel stop — lets the owner unregister the
   *  gateway host an old expose registered (nginx server_name ignores the
   *  port, so stale localhost:PORT hosts collide with the next expose). */
  onTunnelStop?: (name: string) => void | Promise<void>;
  /** Shared nginx gateway singleton (one instance for all exposes). When
   *  omitted, expose() falls back to a local GatewayController. */
  gateway?: GatewayController;
  /** Shared proxy transport + enrollment registry (mode proxy/both). When
   *  omitted, expose() falls back to a local ProxyManager. */
  proxy?: ProxyManager;
  /** Shared redis singleton (one session store for all authelia exposes). */
  redis?: RedisController;
  log?: (line: string) => void;
  /** Resolve an SSH gateway domain to its bound port (daemon-owned manager).
   *  Required only when ExposeOptions.sshGateway is used. */
  sshGatewayPort?: (domain: string) => Promise<number | undefined> | number | undefined;
  /** M0b-ssh: auto-provision the site's backing ssh domain (port auto-
   *  allocated) — the caller only passes site + port. Returns the ssh port
   *  and whether THIS call created the domain (TODO-1: rollback on failure
   *  only removes domains this expose created). */
  sshEnsureDomain?: (site: string, forwardPort: number) => Promise<{ port: number; created: boolean } | undefined>;
  /** TODO-1: remove the site's backing ssh domain (rollback / stop cleanup). */
  sshRemoveDomain?: (site: string) => Promise<unknown>;
}

async function pickPort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("no port"));
      }
    });
  });
}

/** Mode dispatch (sites-design.md §4): "proxy" is a first-class expose mode
 *  — explicit enrollment, no tunnel process, same site/auth realm as tunnel
 *  mode. "both" = local vhost + public tunnel sharing one site. */
/**
 * 多通道默认命名（M0a-T4）：同端口多次暴露（不同 site/provider）不撞名。
 * 仅当 site ≠ default / provider 为真实 provider 时追加后缀；
 * 默认 `expose-<port>`（auth-none、tcp）保持既有兼容（调用/测试不变）。
 */
function defaultTunnelName(
  port: number,
  o: { site?: string; provider?: string; protocol?: string },
): string {
  const parts = [`expose-${port}`];
  if (o.site && o.site !== "default") parts.push(o.site);
  if (o.provider && o.provider !== "auto" && o.provider !== "none") parts.push(o.provider);
  if (o.protocol === "tcp") parts.push("tcp");
  return parts.join("-");
}

export async function expose(port: number, opts: ExposeOptions, ctx: ExposeContext): Promise<ExposeResult> {
  const mode = opts.mode ?? "tunnel";
  if (opts.protocol === "tcp" && mode !== "tunnel") {
    return { url: null, tunnel: "", protocol: "tcp", error: "protocol tcp requires --mode tunnel" };
  }
  // auth-none ban (security control): when the operator disallows
  // unauthenticated exposure, reject ANY expose whose effective auth is
  // "none" — bare expose / --auth none / open proxy bindings / raw tcp (tcp
  // never carries auth). Checked BEFORE any infra/tunnel starts.
  const allowAuthNone = resolveAllowAuthNone(ctx.configDir, opts.allowAuthNone);
  const authNone = opts.auth === false || opts.auth === undefined || opts.auth === "none";
  if (authNone && !allowAuthNone) {
    return {
      url: null,
      tunnel: "",
      mode,
      error: 'auth "none" is banned on this host (allow-auth-none=false): every expose must use an auth provider — pass --auth auto/<provider> (or re-enable via SERVICE_TUNNELS_ALLOW_AUTH_NONE / config allow-auth-none)',
    };
  }
  // Unified site resolution (P1): explicit --site > default. Resolved ONCE so
  // the proxy and tunnel branches share the SAME site instance (one provider
  // process / one user db per realm). An explicit provider (--auth <p> or
  // --provider <p>) WITHOUT --site stays on the DEFAULT site — the vhost
  // label carries the provider name (D3: `5173-basic` = basic on default),
  // but the user db is the default realm's, matching `auth user *` defaults.
  const sites = readSites(ctx.configDir);
  const site = opts.site ?? "default";
  const siteCfg = sites[site];
  const opts2 = { ...opts, site, siteExplicit: opts.site !== undefined };
  if (mode === "proxy") return await proxyExpose(port, opts2, ctx, siteCfg);
  if (mode === "portmap") return await portmapExpose(port, opts2, ctx, siteCfg);
  const proxyResult = mode === "both" ? await proxyExpose(port, opts2, ctx, siteCfg) : null;
  const result = await exposeTunnel(port, opts2, ctx, siteCfg);
  return proxyResult
    ? {
        ...result,
        mode: "both",
        site: proxyResult.site,
        label: proxyResult.label,
        localUrl: proxyResult.localUrl,
        // both 模式的 vhost URL 一并返回(仅带隧道 URL 会让 exposes 记录缺 baseUrl)
        baseUrl: proxyResult.baseUrl,
        domainUrl: proxyResult.domainUrl,
      }
    : result;
}

/**
 * portmap mode — router port mapping (docs/portmap-analysis.md).
 *
 * The external gateway port ALWAYS targets the local proxy transport (never
 * the raw app port), so the site's auth provider still guards the pipe;
 * auth "none" open bindings are gated by the allow-auth-none switch above.
 *
 *   --mode portmap --auth basic   →  http://<公网IP>:<随机高位端口>（过 basic）
 */
async function portmapExpose(
  port: number,
  opts: ExposeOptions,
  ctx: ExposeContext,
  siteCfg: SiteConfig | undefined,
): Promise<ExposeResult> {
  const log = ctx.log ?? (() => {});
  if (!opts.force) {
    const { verifyPortOwner } = await import("./discovery.ts");
    const check = verifyPortOwner(port, ctx.internal);
    if (!check.allowed) {
      return { url: null, tunnel: "", error: check.reason ?? "Port ownership verification failed" };
    }
  }
  // Local transport + enrollment identical to proxy mode — the router maps
  // to THIS listener, never straight to the app. 先解析/创建共享 proxy 实例并
  // 注入 ctx，使失败回滚（F2）能对同一实例 removeBinding。
  const proxyForPortmap =
    ctx.proxy ??
    new ProxyManager({
      registerInternal: (role, p) => ctx.internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
      log,
      allowIpDirect: true, // portmap 外部入口是 IP:port（无 vhost 域名）
    });
  const proxyResult = await proxyExpose(port, opts, { ...ctx, proxy: proxyForPortmap }, siteCfg);
  const transportPort = Number(/:(\d+)$/.exec(proxyResult.localUrl ?? "")?.[1] ?? 0);
  if (!transportPort) {
    // startTransport:false 时 proxyExpose 已注册 binding（无 transport 可映射）——
    // 回滚 enrollment，不留孤儿 binding（与 F2 同类的泄漏路径）。
    try {
      if (proxyResult.label !== undefined) proxyForPortmap.removeBinding(port, proxyResult.label ?? "");
    } catch { /* best effort */ }
    return { ...proxyResult, mode: "portmap", error: "portmap requires a started proxy transport (startTransport !== false)" };
  }
  try {
    // 防火墙清理闭包：openFirewall 在本轮打开规则时才赋值——stop() 时删除
    // 本次添加的规则（已存在的不动）。ensurePortmap 先建（handle.stop 挂回调），
    // fw 结果后到——用 let 变量桥接。
    let fwCleanup: (() => Promise<void>) | undefined;
    const handle: MapHandle = await ensurePortmap(`${ctx.configDir}:portmap:${port}:${proxyResult.label ?? ""}`, transportPort, {
      method: opts.portmap?.method,
      gateway: opts.portmap?.gateway,
      controlUrl: opts.portmap?.controlUrl,
      serviceType: opts.portmap?.serviceType,
      externalPort: opts.portmap?.externalPort,
      leaseSeconds: opts.portmap?.leaseSeconds,
      ssdpTimeoutMs: opts.portmap?.ssdpTimeoutMs,
      sshRouter: opts.portmap?.sshRouter,
      onStopCleanup: () => (fwCleanup ? fwCleanup() : Promise.resolve()),
      description: `service-tunnels:${port}${proxyResult.label ? `-${proxyResult.label}` : ""}`,
    });
    const m = handle.mapping;
    const url = `http://${handle.externalIp}:${m.externalPort}`;
    log(`expose ${port} (portmap): ${url} → ${m.internalIp}:${transportPort} via ${m.backend} (lease ${m.leaseSeconds}s)`);
    // 本机防火墙闭环（真实教训）：路由器 DNAT 建立后，本机防火墙（ufw/iptables）
    // 不放行 `LAN IP:transportPort` 入站则外部源不可达——检查并尝试放行，
    // 失败则回滚映射（不留"看似成功实际不可达"的映射）。
    const fw = await openFirewall(m.internalIp, transportPort);
    if (!fw.ensured) {
      await handle.stop().catch(() => {});
      throw new PortmapUnavailableError(
        `router mapping established but host firewall blocks external access (${fw.detail}) — ` +
        `open ${m.internalIp}:${transportPort} in the host firewall (e.g. sudo ufw allow in to ${m.internalIp} port ${transportPort} proto tcp) and retry`,
      );
    }
    // 本次打开的规则 → stop 时删除（already allowed 的不动——那是既有配置）
    if (fw.detail && !fw.detail.startsWith("already")) {
      log(`expose ${port} (portmap): host firewall opened — ${fw.detail}`);
      fwCleanup = () => removeFirewall(m.internalIp, transportPort);
    }
    return {
      url,
      tunnel: "",
      provider: proxyResult.provider,
      mode: "portmap",
      site: proxyResult.site,
      label: proxyResult.label,
      localUrl: proxyResult.localUrl,
      baseUrl: proxyResult.baseUrl,
      domainUrl: proxyResult.domainUrl,
      protocol: "http",
      portmap: {
        backend: m.backend,
        gateway: m.gateway,
        externalIp: handle.externalIp,
        externalPort: m.externalPort,
        internalPort: m.internalPort,
        leaseSeconds: m.leaseSeconds,
        // F11: 恢复完整性——method/sshRouter 持久化，daemon 重启后按原后端恢复
        method: opts.portmap?.method ?? (m.backend === "ssh-router" ? "ssh-router" : m.backend),
        ...(m.backend === "ssh-router" && opts.portmap?.sshRouter ? { sshRouter: opts.portmap.sshRouter } : {}),
      },
    };
  } catch (e) {
    const hint = e instanceof PortmapUnavailableError
      ? e.message
      : `router mapping failed: ${(e as Error).message}`;
    log(`expose ${port} (portmap): FAILED — ${hint}`);
    // F2: 回滚 proxy 侧 enrollment（binding 由 proxyExpose 建好，映射失败时
    // 不能留着——端口被占、UI 记录不一致）。transport 是共享的，只注销 binding。
    try {
      if (proxyResult.label !== undefined) {
        proxyForPortmap.removeBinding(port, proxyResult.label ?? "");
      }
    } catch { /* best effort */ }
    return { url: null, tunnel: "", mode: "portmap", site: proxyResult.site, label: proxyResult.label, localUrl: proxyResult.localUrl, error: hint };
  }
}

/**
 * proxy mode — local virtual host, NO tunnel (sites-design.md §5.4).
 *
 * Enrollment is the ONLY way to expose a port through the wildcard proxy
 * (D4): the binding is registered with the shared ProxyManager; the first
 * request lazily starts the site's provider and registers the vhost.
 *
 *   --auth none           → open binding      <port>.<suffix>
 *   --auth auto           → default site      <port>-auth.<suffix>
 *   --auth <provider>     → implicit provider site (site = provider name)
 *   --auth ... --site <s> → named site        <port>-<s>.<suffix>
 */
async function proxyExpose(
  port: number,
  opts: ExposeOptions,
  ctx: ExposeContext,
  siteCfg: SiteConfig | undefined,
): Promise<ExposeResult> {
  const log = ctx.log ?? (() => {});
  // 与 exposeTunnel 一致:proxy/both 模式同样做端口归属校验(多用户安全),
  // 否则可对任意端口注册 vhost 绕过校验。
  if (!opts.force) {
    const { verifyPortOwner } = await import("./discovery.ts");
    const check = verifyPortOwner(port, ctx.internal);
    if (!check.allowed) {
      return { url: null, tunnel: "", error: check.reason ?? "Port ownership verification failed" };
    }
  }
  const cfgFile = readConfigFile(ctx.configDir);
  const proxy = ctx.proxy ?? new ProxyManager({
    registerInternal: (role, p) => ctx.internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
    log,
    // portmap 模式的外部入口是 IP:port（无 vhost 域名），需要 IP 直连。
    allowIpDirect: opts.mode === "portmap",
  });
  // Base domain (portless public URL). The proxy already carries the
  // constructor-resolved domains (createServiceTunnels opts / env
  // SERVICE_TUNNELS_BASE_DOMAIN / config base-domain). An explicit CLI
  // --base-domain swaps the primary, keeping the other configured domains;
  // a fresh local proxy with none configured picks them up from env/config.
  if (opts.baseDomain) {
    const rest = proxy.baseDomains.filter((d) => d !== opts.baseDomain);
    await proxy.setBaseDomain([opts.baseDomain, ...rest]);
  } else if (proxy.baseDomains.length === 0) {
    const { list } = resolveBaseDomains(ctx.configDir);
    if (list.length) await proxy.setBaseDomain(list);
  }
  const authRequested =
    opts.auth === true || opts.auth === "auto" || (typeof opts.auth === "string" && opts.auth !== "none");
  // 显式 label(embedder 固定 "<port>-<label>.<domain>")时即使 auth=none 也保留
  // opts.site——labeled 解析需要 binding.site 匹配,否则 "not enrolled"
  const site = authRequested
    ? (opts.site ?? "default")
    : (opts.label ? (opts.site ?? "") : "");
  const providerType = opts.provider
    ?? siteCfg?.provider
    ?? (opts.auth === "auto"
      ? getDefaultAuthProvider()
      : typeof opts.auth === "string" && opts.auth !== "none" ? opts.auth : "portal");
  // D3: default-site vhosts carry the explicit provider name as the label
  // (`5173-basic` = basic auth on the DEFAULT site — same user db as
  // `auth user add --provider basic`); bare `--auth`/`--auth auto` keeps the
  // reserved "auth" label; named sites label with the site name; an explicit
  // `--site default` also keeps "auth".
  const explicitProvider = Boolean(opts.provider) ||
    (typeof opts.auth === "string" && opts.auth !== "none" && opts.auth !== "auto");
  const label = opts.label
    ?? (site === ""
      ? ""
      : opts.siteExplicit
        ? (site === "default" ? "auth" : site)
        : (explicitProvider ? providerType : "auth"));

  let authProvider: AuthProvider | null = null;
  if (authRequested) {
    const pctx = providerCtx(ctx);
    const registry = ctx.auth ?? new AuthRegistry(pctx);
    // 初始用户：portal 不再吃 opts.user（break-glass 重构）——start 后经
    // UserManager.addUser() 显式建号；其余 provider（authelia 等）仍走构造参数。
    const extractedUser: { name: string; password: string } | undefined =
      opts.user ?? (typeof siteCfg?.user === "string" ? { name: siteCfg.user, password: randomSecret() }
        : siteCfg?.user ? { name: siteCfg.user.name, password: siteCfg.user.password ?? randomSecret() } : undefined);
    // 先建 provider（缓存实例直接取），再按自描述能力算 basePath
    const provider = registry.create(
      providerType,
      {
        ...unflattenParams(opts.providerParams ?? {}),
        ...(siteCfg?.providerParams ?? {}),
        deployBasePath: proxy.basePath || undefined,
        policy: opts.policy ?? siteCfg?.policy,
        ...(providerType !== "portal" && extractedUser)
        ? { user: extractedUser }
        : {},
        sessionSecret: opts.sessionSecret,
        externalReloadCmd: opts.autheliaReloadCmd,
      },
      site,
    );
    const gwMode = provider.gatewayMode ?? "forward-auth";
    const hasPath = (provider as { basePath?: string }).basePath;
    // 已存在的共享实例用自己的 basePath；否则 用户配置 > provider 默认
    // 用 || 而非 ??:provider 内置默认现在为空串(自描述默认在 defaultBasePath()),
    // 空串必须继续 fall through 到 用户配置 > provider 默认,再合并部署 basePath。
    const basePath = hasPath
      || opts.basePath
      || siteCfg?.basePath
      || (gwMode === "basic" ? "" : (cfgFile.basePathByProvider?.[providerType] ?? cfgFile.basePath))
      || provider.defaultBasePath?.()
      || `/${providerType}`;
    // Merge the embedder's deployment base path (host /dev) under the
    // provider's own base path: /dev + /portal → /dev/portal — login pages,
    // authz probes and redirects all live under the combined path.
    // 仅支持嵌套路径的 provider(portal)合并部署前缀;authelia 等单段约束
    // 的 provider 不合并,否则 server.address=/dev/autheliaxxx 校验失败。
    const supportsNested = provider.capabilities.nestedBasePath === true;
    const mergedBasePath = gwMode === "basic" || !supportsNested
      ? basePath
      : sanitizeBasePath(`${(proxy.basePath ?? "").replace(/\/+$/, "")}${basePath}`);
    if (!hasPath && gwMode !== "basic") await provider.setBasePath?.(mergedBasePath);
    const problems = (await provider.validate?.()) ?? [];
    if (problems.length) {
      throw new Error(`auth provider ${providerType} not ready:\n  - ${problems.join("\n  - ")}`);
    }
    if (provider.capabilities.needsSessionStore) {
      let redis = ctx.redis ?? null;
      if (!redis) redis = new RedisController({ cacheDir: ctx.cacheDir, port: opts.redisPort, log });
      const redisPort = await redis.start();
      ctx.internal.register("redis", { port: redisPort, pid: 0, process: "redis", cmdline: "redis", addresses: ["127.0.0.1"] });
    }
    await provider.start();
    if (providerType === "portal" && isUserManager(provider) && extractedUser) {
      await (provider as UserManager).addUser(extractedUser.name, extractedUser.password);
    }
    authProvider = provider;
    log(`expose ${port} (proxy): provider ${providerType} up (site ${site})`);
  }

  const transportPort = opts.startTransport !== false ? await proxy.start(opts.proxyPort) : 0;
  proxy.addBinding({
    port,
    label,
    site: site || "default",
    provider: authRequested ? providerType : "",
    policy: opts.policy ? { policy: opts.policy } : undefined,
    providerParams: { ...(siteCfg?.providerParams ?? {}), ...(opts.providerParams ?? {}) },
    ...(opts.bypassPaths ? { bypassPaths: validateBypassPaths(opts.bypassPaths) } : {}),
    ...(opts.serviceBasePath ? { serviceBasePath: opts.serviceBasePath } : {}),
    // portmap 模式：IP:transportPort 直连映射到本 binding（router DNAT 后的入口）。
    ...(opts.mode === "portmap" && transportPort ? { ipDirectPort: transportPort } : {}),
  });
  // proxy 模式同样注册 host 策略(与 tunnel 模式一致):auth-request 按 host
  // 查 policy,否则策略文件为空 → 默认 one_factor,deny/two_factor 不生效。
  if (authProvider) {
    await authProvider.registerHost(proxy.vhost(port, label), { policy: opts.policy });
  }
  // 部署前缀(deployBasePath,/dev)拼进对外 URL:路径路由部署下浏览器需带前缀到达
  // 正确实例;转发时 mapServicePath 剥前缀并接服务自身 serviceBasePath。
  const deploy = (proxy.basePath ?? "").replace(/\/+$/, "");
  const withDeploy = (u: string | undefined) => (u && deploy ? `${u}${deploy}` : u);
  const localUrl = transportPort ? `http://${proxy.vhost(port, label)}:${transportPort}` : "";
  const baseVhost = proxy.baseVhost(port, label);
  const baseUrl = withDeploy(baseVhost ? `http://${baseVhost}` : undefined);
  const domainUrl = withDeploy(siteCfg?.domain ? `http://${port}.${siteCfg.domain.replace(/^\./, "")}` : undefined);
  log(`expose ${port} (proxy): ${localUrl}${baseUrl ? ` / ${baseUrl}` : ""}${domainUrl ? ` / ${domainUrl}` : ""}${authRequested ? ` (auth via ${providerType}, site ${site || "default"})` : " (open)"}`);
  return {
    url: null,
    tunnel: "",
    provider: authRequested ? providerType : undefined,
    mode: "proxy",
    site,
    label,
    localUrl,
    baseUrl,
    domainUrl,
    protocol: "http",
  };
}

/** The existing one-shot tunnel flow (tunnel + optional gateway auth). */
async function exposeTunnel(
  port: number,
  opts: ExposeOptions,
  ctx: ExposeContext,
  siteCfg: SiteConfig | undefined,
): Promise<ExposeResult> {
  const log = ctx.log ?? (() => {});
  
  // Security check: verify port ownership (unless --force is specified)
  if (!opts.force) {
    const { verifyPortOwner } = await import("./discovery.ts");
    const check = verifyPortOwner(port, ctx.internal);
    if (!check.allowed) {
      log(`Security check failed: ${check.reason}`);
      return {
        url: null,
        tunnel: "",
        error: check.reason ?? "Port ownership verification failed",
      };
    }
    log(`Port ${port} ownership verified (current user)`);
  } else {
    log(`--force specified: skipping port ownership check for port ${port}`);
  }
  
  const providerType = opts.provider ?? siteCfg?.provider ?? (opts.auth === "auto" ? getDefaultAuthProvider() : "portal");
  const site = opts.site ?? "default";
  // "none" is a first-class provider = expose WITHOUT auth (like basic but
  // no auth): skip the whole gateway/auth flow and make a plain tunnel.
  const useAuth = (opts.auth === true || opts.auth === "auto") && providerType !== "none";
  // Forwarding protocol: explicit opts win; else detect the app port
  // (http/https/tcp). tcp → direct raw tunnel; http/https → nginx gateway.
  const protocol = opts.protocol ?? (await detectProtocol(port));
  // ngrok authtoken → NGROK_AUTHTOKEN env on the tunnel process (so ngrok
  // authenticates instead of exiting ERR_NGROK_4018). Harmless for other types.
  const tunnelEnv = opts.ngrokAuthtoken ? { NGROK_AUTHTOKEN: opts.ngrokAuthtoken } : undefined;

  // M0b-ssh: "ssh" is a first-class provider = site-scoped public-key auth for
  // ANY protocol. Port-forward is protocol-agnostic — http/https/tcp ports are
  // served the same: auto-provision the site's backing ssh domain (port auto-
  // allocated, invisible to the caller) and route a raw tcp tunnel at its ssh
  // port. No gateway/domain/port management by the caller (ui-redesign §4.6).
  // TODO-1 (暴露原子化): ssh provider 自动建域只在此次 expose 内回滚——
  // 隧道失败 → 删除本次新建的域（非本次创建的不动）。
  let createdSshDomain = false;

  if (opts.provider === "ssh" || opts.auth === "ssh") {
    if (!ctx.sshEnsureDomain || !ctx.sshGatewayPort) {
      return { url: null, tunnel: "", error: "ssh auth requires an ssh manager (sshEnsureDomain/sshGatewayPort resolver missing)" };
    }
    const r = await ctx.sshEnsureDomain(site, port);
    if (!r || !r.port) return { url: null, tunnel: "", error: `ssh auth: failed to provision site "${site}"` };
    createdSshDomain = !!r.created;
    opts = { ...opts, protocol: "tcp", sshGateway: site, auth: false };
  }

  if (opts.protocol === "tcp") {
    // raw TCP — NO nginx gateway (nginx is HTTP-only), NO auth: tunnel
    // straight to the app port. Only TCP-capable tunnel types allowed.
    const tunnelType = (opts.tunnelType as never) ?? "ngrok";
    if (!tunnelSupportsTcp(tunnelType)) {
      return { url: null, tunnel: "", error: `tunnel type "${tunnelType}" does not support tcp forwarding (use ngrok/ssh/frpc)` };
    }
    // Optional SSH auth layer: point the raw tunnel at the SSH gateway port
    // instead of the app port — only authorized private keys get through.
    let target = port;
    if (opts.sshGateway) {
      if (!ctx.sshGatewayPort) {
        return { url: null, tunnel: "", error: "ssh-gateway requires a daemon-owned ssh manager (sshGatewayPort resolver missing)" };
      }
      const gwPort = await ctx.sshGatewayPort(opts.sshGateway);
      if (!gwPort) {
        return { url: null, tunnel: "", error: `ssh gateway domain "${opts.sshGateway}" not found (create it first: service-tunnels ssh domain create ...)` };
      }
      target = gwPort;
    }
    const name = opts.tunnelName ?? defaultTunnelName(port, { site: opts.site, provider: opts.provider, protocol: "tcp" });
    await ctx.tunnels.stop(name);
    await ctx.onTunnelStop?.(name);
    ctx.tunnels.add({
      ...(opts.tunnelParams ?? {}),
      name,
      type: (opts.tunnelType as never) ?? "ngrok",
      target,
      protocol: "tcp",
      env: tunnelEnv,
      sshGateway: opts.sshGateway,
    });
    await ctx.tunnels.start(name);
    const url = await waitForUrl(ctx.tunnels, name, 30_000);
    // TODO-1 (fail-clean): 隧道启动失败 → 停隧道 + 删除本次新建的 ssh 域，
    // 不留半残留（下次暴露自动重建）。共享单例（nginx/redis）不动。
    if (!url && createdSshDomain) {
      await ctx.tunnels.stop(name).catch(() => {});
      await ctx.sshRemoveDomain?.(site).catch(() => {});
    }
    // raw tcp tunnel (incl. ssh-gateway auth) — protocol is always tcp even
    // when the target port was detected as http/https (M0b-ssh: port-forward)
    return { url, tunnel: name, protocol: "tcp", ...(url ? {} : tunnelFailure(ctx.tunnels, name)) };
  }

  if (!useAuth) {
    // "none" auth — route through the shared nginx gateway TOO (like basic but
    // with no auth), so access/error logs are recorded for every expose. The
    // only difference from basic is the absence of auth directives.
    const name = opts.tunnelName ?? defaultTunnelName(port, { site: opts.site });
    const nginxPort = opts.nginxPort ?? 0;
    const gateway = ctx.gateway ?? new GatewayController({
      configDir: ctx.configDir,
      cacheDir: ctx.cacheDir,
      port: nginxPort,
      registerInternal: (role, p) => ctx.internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
      unregisterInternal: (role) => ctx.internal.unregister(role),
      log,
    });
    const gatewayPort = await gateway.start("none");
    await ctx.tunnels.stop(name);
    await ctx.onTunnelStop?.(name);
    ctx.tunnels.add({
      ...(opts.tunnelParams ?? {}),
      name,
      type: (opts.tunnelType as never) ?? "ngrok",
      target: gatewayPort,
      env: tunnelEnv,
    });
    await ctx.tunnels.start(name);
    const url = await waitForUrl(ctx.tunnels, name, 30_000);
    if (url) {
      const host = new URL(url).host;
      const scheme = protocol === "https" ? "https" : "http";
      try {
        await gateway.registerHost(host, port, { authMode: "none", scheme, ...(opts.inject ? { inject: opts.inject } : {}) });
      } catch (err) {
        // unsafe host (injection attempt / non-domain) — roll the tunnel back
        await ctx.tunnels.stop(name).catch(() => {});
        await ctx.onTunnelStop?.(name);
        return { url: null, tunnel: name, protocol, error: `tunnel URL host rejected: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { url, tunnel: name, protocol, ...(url ? {} : tunnelFailure(ctx.tunnels, name)) };
  }

  // ── auth flow: shared infrastructure ──────────────────────────────────────
  const pctx = providerCtx(ctx);
  const registry = ctx.auth ?? new AuthRegistry(pctx);
  // basePath resolution: explicit opts (library/CLI) > configDir/
  // service-tunnels.json (basePath / basePathByProvider) > provider 自描述默认
  // （portal → /portal-sneaky-capybara，authelia → /authelia<alnum>，basic → ""）。
  const cfgFile = readConfigFile(ctx.configDir);
  // 初始用户：同 proxyExpose——portal 经 addUser()，其余走构造参数。
  const extractedUser: { name: string; password: string } | undefined =
    opts.user ?? (typeof siteCfg?.user === "string" ? { name: siteCfg.user, password: randomSecret() }
      : siteCfg?.user ? { name: siteCfg.user.name, password: siteCfg.user.password ?? randomSecret() } : undefined);
  // 先建 provider（缓存实例直接取），再按自描述能力算 basePath
  const provider: AuthProvider = registry.create(
    providerType,
    {
      ...unflattenParams(opts.providerParams ?? {}),
      ...(siteCfg?.providerParams ?? {}),
      port: opts.autheliaPort,
      sessionSecret: opts.sessionSecret,
      policy: opts.policy ?? siteCfg?.policy,
      ...(providerType !== "portal" && extractedUser)
        ? { user: extractedUser }
        : {},
      externalReloadCmd: opts.autheliaReloadCmd,
    },
    site,
  );
  const gwMode = provider.gatewayMode ?? "forward-auth";
  const hasPath = (provider as { basePath?: string }).basePath;
  const initialBasePath = hasPath
    || opts.basePath
    || siteCfg?.basePath
    || (gwMode === "basic" ? "" : (cfgFile.basePathByProvider?.[providerType] ?? cfgFile.basePath))
    || provider.defaultBasePath?.()
    || `/${providerType}`;
  // basePath is interpolated into nginx locations + 302 redirects + authelia's
  // server.address — allow a plain URL path only (no ; {} whitespace quotes
  // which would inject nginx directives or break the config).
  const basePath = gwMode === "basic" ? "" : sanitizeBasePath(initialBasePath);
  if (!hasPath && gwMode !== "basic") await provider.setBasePath?.(basePath);
  // The registry caches ONE provider per `type#site` (P1): every expose of
  // this site shares the SAME process + basePath + user db. Use the provider's
  // own basePath (the first expose set it) — do NOT regenerate or setBasePath,
  // that would rebind the shared provider + restart it and break every other
  // expose of this site (multiple authelia instances colliding → authz 400).
  const providerBasePath = (provider as { basePath?: string }).basePath ?? initialBasePath;

  const problems = (await provider.validate?.()) ?? [];
  if (problems.length) {
    throw new Error(`auth provider ${providerType} not ready:\n  - ${problems.join("\n  - ")}`);
  }

  // edge-auth providers (ngrok edge-oidc) skip the local gateway entirely
  if (provider.capabilities.edgeAuth && !provider.capabilities.localGateway) {
    const name = opts.tunnelName ?? defaultTunnelName(port, { site: opts.site, provider: providerType });
    const tunnelAuth = provider.renderTunnelAuth?.() ?? {};
    await ctx.tunnels.stop(name);
    await ctx.onTunnelStop?.(name);
    ctx.tunnels.add({
      ...(opts.tunnelParams ?? {}),
      name,
      type: (opts.tunnelType as never) ?? "ngrok",
      target: port,
      args: (tunnelAuth.args as string[]) ?? [],
      env: tunnelEnv,
    });
    await ctx.tunnels.start(name);
    const url = await waitForUrl(ctx.tunnels, name, 30_000);
    // TODO-1 (fail-clean): 隧道失败 → 停隧道 + 停本次起的 provider（共享 gateway 不清）
    if (!url) {
      await ctx.tunnels.stop(name).catch(() => {});
      try { await provider.stop(); } catch { /* best effort */ }
    }
    return { url, tunnel: name, provider: providerType, protocol, ...(url ? {} : tunnelFailure(ctx.tunnels, name)) };
  }

  const nginxPort = opts.nginxPort ?? 0; // 0 = random
  // 网关模式：provider 自描述（basic → auth_basic；oauth2-proxy → /oauth2/ 协议）
  const authMode: GatewayAuthMode = provider.gatewayMode ?? "forward-auth";
  const htpasswdFile = (provider as { htpasswdFile?: string }).htpasswdFile;
  // Shared gateway singleton (one nginx for all exposes); fall back to a
  // local instance when no shared one is provided (standalone/tests).
  const gateway = ctx.gateway ?? new GatewayController({
    configDir: ctx.configDir,
    cacheDir: ctx.cacheDir,
    port: nginxPort,
    basePath: providerBasePath,
    htpasswdFile,
    registerInternal: (role, p) => ctx.internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
    unregisterInternal: (role) => ctx.internal.unregister(role),
    log,
  });

  // Redis first (provider may need it for sessions), then provider, then nginx.
  // Shared singleton: started once on first need, reused across exposes.
  let redis = ctx.redis ?? null;
  if (provider.capabilities.needsSessionStore) {
    if (!redis) redis = new RedisController({ cacheDir: ctx.cacheDir, port: opts.redisPort, log });
    // start() is idempotent (reuses the running instance) → shared singleton
    const redisPort = await redis.start();
    ctx.internal.register("redis", { port: redisPort, pid: 0, process: "redis", cmdline: "redis", addresses: ["127.0.0.1"] });
  }

  await provider.start();
  if (providerType === "portal" && isUserManager(provider) && extractedUser) {
    await (provider as UserManager).addUser(extractedUser.name, extractedUser.password);
  }
  const authPort = (provider as unknown as { port?: number }).port ?? 9091;
  // start the shared gateway once (auth backend is per-host now)
  const gatewayPort = await gateway.start(authMode);

  // tunnel pointing at the gateway
  const name = opts.tunnelName ?? defaultTunnelName(port, { site: opts.site, provider: providerType });
  await ctx.tunnels.stop(name);
  await ctx.onTunnelStop?.(name);
  ctx.tunnels.add({
    ...(opts.tunnelParams ?? {}),
    name,
    type: (opts.tunnelType as never) ?? "ngrok",
    target: gatewayPort,
    env: tunnelEnv,
  });
  await ctx.tunnels.start(name);

  // wait for the public URL, then register it with the provider AND the
  // gateway (nginx needs a server block for the host before it listens)
  const url = await waitForUrl(ctx.tunnels, name, 30_000);
  const publicHost = url ? new URL(url).host : null;
  if (publicHost) {
    // provider-specific login redirect target —— provider 自描述（loginRedirect
    // 方法），缺省 portal 风格（插件等未实现时兜底）。
    const o2Setup = provider.setupConfig?.();
    // 本地后端协议（nginx proxy_pass 用，探测本地端口）：https 应用 → 上游 https。
    const scheme = protocol === "https" ? "https" : "http";
    // 登录重定向必须用公网协议：https 隧道（localtunnel/ngrok/cloudflared 等）
    // 边缘 TLS 终结，公网 URL 是 https；bore/ssh 等裸 TCP 隧道是 http。
    // 不能按本地端口协议判断——pi-web 本地 http + localtunnel 公网 https，
    // 用本地协议会把登录页跳成 http → 浏览器混合内容拦截。
    const publicScheme = /^https:\/\//i.test(url ?? "") ? "https" : "http";
    // $http_host 保留端口（bore/ssh 等带随机端口的隧道；无端口时与 $host 等价）
    // token/basic 无登录页：不生成 302 跳转（gateway 的 token 模式无
    // @auth_redirect，401 直返；basic 模式本就不引用 loginRedirect）
    const loginRedirect =
      authMode === "token" || authMode === "basic"
        ? ""
        : (provider.loginRedirect?.(providerBasePath, publicScheme)
          ?? `${publicScheme}://$http_host${providerBasePath}/login?next=$request_uri`);
    if (opts.loginInfoButton && (authMode === "token" as string)) {
      log(`expose ${port}: loginInfoButton ignored for ${authMode} auth (no session semantics)`);
    }
    try {
      await gateway.registerHost(publicHost, port, {
        authPort,
        basePath: providerBasePath,
        authMode,
        htpasswdFile,
        loginRedirect,
        scheme,
        site: site,
        // oauth2-proxy 联动：nginx 直接渲染域名验证文件 + 设置页（模板含 $host）
        ...(o2Setup
          ? { setup: { verification: o2Setup.verification, infoPath: o2Setup.infoPath, infoHtmlTemplate: o2Setup.infoHtmlTemplate } }
          : {}),
        // 认证放行白名单：这些 location 不带 auth_request
        ...(opts.bypassPaths ? { bypassPaths: validateBypassPaths(opts.bypassPaths) } : {}),
        // 静态响应注入（仅主页面导航的 text/html；XHR/fetch/子资源不注入）
        ...(opts.inject ? { inject: opts.inject } : {}),
        // 登录信息按钮（FAB：用户名 + 退出登录）——token/none 由 gateway 忽略
        ...(opts.loginInfoButton ? { loginInfoButton: true } : {}),
      });
    } catch (err) {
      // unsafe host — tear down the tunnel so nothing is left half-registered
      await ctx.tunnels.stop(name).catch(() => {});
      await ctx.onTunnelStop?.(name);
      return { url: null, tunnel: name, provider: providerType, protocol, error: `tunnel URL host rejected: ${err instanceof Error ? err.message : String(err)}` };
    }
    await provider.registerHost(publicHost, { policy: opts.policy });
    log(`expose ${port}: ${url} (auth via ${providerType}, host ${publicHost} registered, scheme ${scheme})`);
  }

  // TODO-1 (fail-clean): 隧道失败 → 停隧道 + 停本次起的 provider（共享 gateway/redis 不清）
  if (!url) {
    await ctx.tunnels.stop(name).catch(() => {});
    try { await provider.stop(); } catch { /* best effort */ }
  }
  return {
    url,
    tunnel: name,
    provider: providerType,
    protocol,
    loginUrl: url
      ? (provider.loginUrl?.(url, providerBasePath) ?? (providerBasePath ? `${url}${providerBasePath}/login` : undefined))
      : undefined,
    gateway: { nginx: gatewayPort, authelia: authPort, redis: redis?.port ?? 0 },
    ...(url ? {} : tunnelFailure(ctx.tunnels, name)),
  };
}

/** Random memorable base path: {provider}-{adjective}-{animal} (e.g.
 *  /portal-sneaky-capybara). Random per expose → unpredictable and collision
 *  -free against app routes; basic auth needs no base path. */
/** Validate a caller-supplied base path before it is interpolated into nginx
 *  locations / 302 redirects / authelia's server.address. URL path characters
 *  only; anything that could break a config line (; {} whitespace quotes \n)
 *  is rejected. Returns the path unchanged (leading slash kept, trailing
 *  slashes trimmed). */
export function sanitizeBasePath(p: string): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 128) {
    throw new Error(`invalid base path: ${JSON.stringify(p)}`);
  }
  if (!p.startsWith("/") || !/^[\/a-zA-Z0-9._-]+$/.test(p)) {
    throw new Error(`invalid base path: ${JSON.stringify(p)}`);
  }
  return p.replace(/\/+$/, "");
}

/** Random secret for bootstrap users without an explicit password. */
function randomSecret(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** A human-readable failure reason for a tunnel that didn't produce a URL.
 *  Tunnels capture their process output (ngrok/cloudflared log the actionable
 *  error there) and an exit code; surface a trimmed tail so the caller/UI
 *  gets a concrete reason instead of a silent null URL. */
function tunnelFailure(tunnels: TunnelManager, name: string): { error: string } {
  const info = tunnels.get(name);
  if (!info) return { error: `tunnel '${name}' not found` };
  const tail = (info.lastOutput ?? "").trim().slice(-500);
  if (info.error && tail) return { error: `${info.error} — ${tail}` };
  if (info.error) return { error: info.error };
  if (tail) return { error: tail };
  return { error: info.running ? `tunnel '${name}' running but produced no URL` : `tunnel '${name}' produced no URL` };
}

async function waitForUrl(tunnels: TunnelManager, name: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = tunnels.get(name)?.url ?? null;
    if (url) return url;
    const running = tunnels.get(name)?.running ?? false;
    if (!running) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  return tunnels.get(name)?.url ?? null;
}

/** Build the ProviderContext for the given ExposeContext. */
function providerCtx(ctx: ExposeContext): ProviderContext {
  return {
    configDir: ctx.configDir,
    cacheDir: ctx.cacheDir,
    resolveTool: ctx.resolveTool,
    registerInternal: (role, port) =>
      ctx.internal.register(role, {
        port,
        pid: 0,
        process: role,
        cmdline: role,
        addresses: ["127.0.0.1"],
      }),
    unregisterInternal: (role) => ctx.internal.unregister(role),
    registerPid: (role, pid) => ctx.registerPid?.(role, pid),
    pickPort,
    log: ctx.log ?? (() => {}),
  };
}
