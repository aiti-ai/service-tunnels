import {
  resolveDirs,
  cachePaths,
  readConfigFile,
  writeConfigFile,
  hardenDir,
  resolveBaseDomains,
  resolveAllowAuthNone,
  type DirOptions,
  type ServiceTunnelsDirs,
} from "./config.ts";
import { InternalRegistry } from "./internal.ts";
import { SshManager, type SshDomainConfig, type SshDomainInfo, type SshKeyInfo, type GeneratedKeyPair } from "./ssh/manager.ts";
import { listPresets, getPreset, savePreset, removePreset, loadPresetsKey, presetSummary, type Preset, type PresetKind } from "./presets.ts";
import { parseExposeEnv, exposeSelf as exposeSelfFlow, maybeExposeSelf as maybeExposeSelfFlow, createSelfGate, type SelfExposeOptions } from "./expose-self.ts";
import {
  discoverServicePorts,
  getServicePorts,
  isServicePortAllowed,
  expandListeningAddresses,
  decodeIpv4,
  decodeIpv6,
  parseLsofAddress,
  parseNetstatAddress,
  stripBasePath,
  type ServicePortInfo,
  type DiscoveryOptions,
} from "./discovery.ts";
import { ensureMarker } from "./marker.ts";
import { registerPid as registerPidToFile, registrationFilePath } from "./pid-registry.ts";
import {
  daemonStatus,
  startDaemon,
  stopDaemon,
  requestDaemon,
  type DaemonStatus,
} from "./daemon.ts";
import { readState } from "./state.ts";
import { platform } from "os";
import { ensureTool, resolveToolPath, findOnPath, TOOLS, mergeToolPaths, type ToolRegistryOptions } from "./tools.ts";
import { spawnGuardian } from "./guardian-spawn.ts";
import { createProxyServer, parseServiceHost, validBasicAuth, proxyTarget, DEFAULT_SUFFIXES, type ProxyOptions } from "./proxy.ts";
import { TunnelManager, extractTunnelUrl, tunnelSupportsTcp, tunnelParamSchema, tunnelParamSchemas, tunnelMeta, tunnelMetas, type TunnelConfig, type TunnelInfo, type TunnelType, type ParamSpec, type TunnelMeta , TUNNEL_SCHEMAS_VERSION } from "./tunnels.ts";
import { customTunnelTemplates } from "./tunnels-custom.ts";
import { readTunnelConfigs, writeTunnelConfigs } from "./tunnels-config.ts";
import { expose as exposeFlow, type ExposeOptions, type ExposeResult } from "./expose.ts";
import { probePortmap as portmapProbe, listPortmaps, stopPortmap, type PortmapProbe } from "./portmap/index.ts";
import { GatewayController, type GatewayInject } from "./gateway.ts";
import { RedisController } from "./redis.ts";
import { AutheliaProvider } from "./authelia.ts";
import { AuthRegistry, loadProviderPlugins, authProviderSchemas, authProviderMetas, AUTH_SCHEMAS_VERSION } from "./auth-registry.ts";
import { localizeSchemas, localizeSpecs, resolveLang } from "./i18n.ts";
import { ProxyManager, type ProxyBinding } from "./proxy-manager.ts";
import { readSites, writeSites, defaultSiteConfig, validateSiteName, type SiteConfig, type SiteInfo } from "./sites.ts";
import type { AuthProvider, AuthProviderFactory, ProviderContext } from "./auth-provider.ts";
import type { AuthUser, AuthToken } from "./auth-provider.ts";

export type { ServicePortInfo, DiscoveryOptions } from "./discovery.ts";
export type { ServiceTunnelsDirs, DirOptions } from "./config.ts";
export { listPresets, getPreset, savePreset, removePreset, loadPresetsKey, presetSummary, isSensitiveKey, maskSecret, type Preset, type PresetKind, type PresetFileRow } from "./presets.ts";
export type { DaemonStatus } from "./daemon.ts";
export type { ToolDef, ToolRegistryOptions } from "./tools.ts";
export type { TunnelConfig, TunnelInfo, TunnelType, ParamSpec, TunnelMeta } from "./tunnels.ts";
export { extractTunnelUrl, tunnelSupportsTcp, tunnelParamSchema, tunnelParamSchemas, tunnelMeta, tunnelMetas, TUNNEL_META, coerceParam, applyParamSets, TUNNEL_SCHEMAS_VERSION } from "./tunnels.ts";
export { CUSTOM_TUNNEL_ENV_PREFIX, customTunnelTemplates, customTunnelTemplate, isCustomTunnelType } from "./tunnels-custom.ts";
export { authProviderSchemas, authProviderMetas, AUTH_PARAM_SCHEMAS, AUTH_SCHEMAS_VERSION } from "./auth-registry.ts";
// 多语:零依赖自实现,i18next 风格接口(t/changeLanguage/getFixedT/…)
//   t(key, params) — 默认实例,语言由 setLang/changeLanguage 管理
//   translate(lang, key, params) — 显式语言版本
//   createI18n(initial?) — 独立实例
//   resolveLang / localizeSpecs / localizeSchemas / withSchemaI18nKeys / CATALOG
export {
  t,
  translate,
  resolveLang,
  createI18n,
  i18n,
  setLang,
  getLang,
  I18n,
  localizeSpecs,
  localizeSchemas,
  withSchemaI18nKeys,
  CATALOG,
} from "./i18n.ts";
export type { Lang, Resources } from "./i18n.ts";
export type { AuthProvider, ProviderContext, AuthPolicy, AuthProviderCapabilities, AuthUser, AuthToken, UserManager, TokenManager } from "./auth-provider.ts";
export { AutheliaProvider } from "./authelia.ts";
export { GatewayController, generateGatewayNginx, detectProtocol, normalizeInject, nginxQuote, type GatewayInject } from "./gateway.ts";
export { ProxyManager } from "./proxy-manager.ts";
export type { ProxyBinding, ProxyManagerStatus, ProxyManagerOptions } from "./proxy-manager.ts";
export { RedisController } from "./redis.ts";
export { startUi } from "./ui.ts";

export {
  expandListeningAddresses,
  decodeIpv4,
  decodeIpv6,
  parseLsofAddress,
  parseNetstatAddress,
  stripBasePath,
} from "./discovery.ts";
export { findOnPath } from "./tools.ts";
export { createProxyServer, parseServiceHost, validBasicAuth, authHeader, proxyTarget, DEFAULT_SUFFIXES } from "./proxy.ts";
export type { ProxyOptions, ServiceHostMatch } from "./proxy.ts";

export { InternalRegistry } from "./internal.ts";

export interface ServiceTunnelsOptions extends DirOptions {
  /** Child-process env marker prefix (default "service-tunnels"). */
  marker?: string;
  /** Response transform hook（透传 proxy）：text/html 响应 </head> 前注入 HTML 片段（通用注入） */
  transformResponse?: (info: { port: number; url: string; method: string }) => string | { html: string; position?: "head" | "prepend" } | null;
  /**
   * 静态响应注入（tunnel nginx 路径）：浏览器 → 隧道边缘 → nginx 网关 → 应用
   * 的流量不经过 node proxy，transformResponse 够不着——此选项在 nginx 网关
   * 配置里注入（sub_filter / add_before_body）。string → head 模式；
   * { html, position } 指定模式。只作用于 text/html 且仅主页面导航
   * （Sec-Fetch-Mode: navigate / 老客户端无该头；XHR/fetch/子资源不注入）——
   * 避免把用户后加载的模板片段/文件注坏。单次 st.expose 的 inject 参数覆盖此全局值。
   */
  inject?: string | GatewayInject;
  /** Auth provider plugins (M4+). */
  authPlugins?: unknown[];
  /** Explicit tool paths: { ngrok: "/opt/ngrok" }. Beats PATH and cache. */
  toolPaths?: Record<string, string>;
  /** China-mirror overrides per tool: { frpc: ["https://..."], default: [...] }. */
  toolMirrors?: Record<string, string[]>;
  /** Try mirrors before official sources (CN networks). */
  preferMirrors?: boolean;
  /** Allow on-demand tool downloads when a tool is missing (default true).
   *  False → only PATH/cache tools are usable. Persisted to config so the UI
   *  toggle survives restarts; library opts win over the config file. */
  allowToolDownload?: boolean;
  /** Spawn a parent-death guardian (default true): if this process exits
   *  without cleanup, a detached guardian kills our framework helpers. */
  guardian?: boolean;
  /**
   * Explicit node runtime path for spawning node scripts (daemon / guardian /
   * portal / token). Default: process.execPath. In Electron hosts (VS Code
   * extension host) process.execPath is the app binary, not node — spawns
   * automatically run with ELECTRON_RUN_AS_NODE=1 so the script runs on the
   * embedded Node runtime. Override when a dedicated node binary is desired.
   */
  nodePath?: string;
  /**
   * User's wildcard-DNS base domain (e.g. "example.com"): expose --mode
   * proxy also returns a PORTLESS base URL (`<port>[-<label>].<baseDomain>`)
   * and the proxy serves `<port>[-<label>].<baseDomain>`. Callers embedding
   * service-tunnels (host) pass their deployment domain here — beats env
   * SERVICE_TUNNELS_BASE_DOMAIN and the config file base-domain.
   */
  baseDomain?: string;
  /** Additional base domains served as proxy suffixes (primary first, beats
   *  env SERVICE_TUNNELS_BASE_DOMAIN). */
  baseDomains?: string[];
  /**
   * Embedder's deployment base path (e.g. "/dev").
   * App paths are stripped before forwarding, and auth-provider login paths
   * (portal "/portal/login", authelia ...) are merged under it:
   * "/dev/portal/login" — plain "/portal/login" when unset.
   */
  deployBasePath?: string;
  /** 真实服务的默认 base path(转发映射)。 */
  serviceBasePath?: string;
  /**
   * 禁止无认证暴露（auth none）——安全开关：false = 本实例所有 expose
   * （tunnel/proxy/both/tcp）必须带认证；"none" 不再出现在 auth providers()
   * 列表，auth none 请求直接失败。任何一层为 false 即生效（显式参数 < env
   * SERVICE_TUNNELS_ALLOW_AUTH_NONE < 配置档 allow-auth-none），单次调用的
   * true 不能覆盖环境变量/配置档的禁止。
   */
  allowAuthNone?: boolean;
}

export interface ToolResolution {
  name: string;
  /** Where the tool resolves to (null = not found anywhere). */
  path: string | null;
  source: "toolPaths" | "path" | "cache" | null;
}

export interface ServiceTunnels {
  /** Resolved config/cache directories. */
  dirs: ServiceTunnelsDirs;
  /** Framework helper ports (nginx/authelia/redis) — separate from discovery. */
  internal: InternalRegistry;
  discovery: {
    discoverPorts(opts?: DiscoveryOptions): ServicePortInfo[];
    getPorts(opts?: DiscoveryOptions): ServicePortInfo[];
    isPortAllowed(port: number): boolean;
  };
  daemon: {
    status(): DaemonStatus;
    start(opts?: { foreground?: boolean; logFile?: string }): DaemonStatus;
    stop(): Promise<boolean>;
    request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T | null>;
  };
  tools: {
    /** Resolve a tool: caller path > PATH > cache; auto-downloads when missing. */
    ensure(name: string): Promise<string>;
    /** Resolve without downloading (null when absent everywhere). */
    resolve(name: string): string | null;
    /** All known tools + current resolution + source. */
    list(): ToolResolution[];
    /** Whether on-demand downloads are currently allowed. */
    allowDownload(): boolean;
    /** Toggle on-demand downloads (persisted to service-tunnels.json). */
    setAllowDownload(allowed: boolean): void;
  };
  proxy: {
    /** Create a wildcard-host reverse proxy (allow-list = discovery cache).
     *  Low-level transport; the shared D4-wired transport is st.proxy.start(). */
    create(opts?: ProxyOptions): import("http").Server;
    parseHost(host: string | undefined): import("./proxy.ts").ServiceHostMatch | null;
    /** In-process vhost decision for embedded callers (same suffixes/enrollment/
     *  auth as the listening transport; no port needed). */
    resolve(input: import("./proxy.ts").ServiceHostResolveInput): Promise<import("./proxy.ts").ServiceHostDecision>;
    /** Shared proxy transport + enrollment registry (D4, mode proxy/both).
     *  Idempotent start on the default port 4180 (busy → random); 0 = random. */
    start(opts?: { port?: number; refresh?: boolean; rootPid?: number }): Promise<number>;
    stop(): Promise<void>;
    status(): import("./proxy-manager.ts").ProxyManagerStatus;
    bindings(): import("./proxy-manager.ts").ProxyBinding[];
    addBinding(b: import("./proxy-manager.ts").ProxyBinding): void;
    removeBinding(port: number, label: string): void;
    /** Restore persisted bindings (daemon restart). */
    restore(bindings: import("./proxy-manager.ts").ProxyBinding[]): void;
    /** Persisted snapshot for state.json. */
    persisted(): import("./proxy-manager.ts").ProxyBinding[];
    /**
     * Open-binding enrollment（高层便捷 API：port 级「登记/取消」，数据源唯一为
     * binding 本身——无需调用方自存任何登记文件）。
     *
     * enroll(port, {serviceBasePath}) — 登记/更新 open vhost（label=""、site="default"、
     *   无认证）：vhost <port>.<suffix> 可达；serviceBasePath 为该端口真实服务的
     *   base path（转发剥部署前缀后接回，如 vite base=/dev/）——传 undefined 保留
     *   现值，传 "" 清除，传值则覆盖。幂等（同 port 覆盖写）。
     * unenroll(port) — 取消该端口的 open 登记（同 port 其他 labeled binding 不受影响）。
     * enrolled() — 全部 open 登记：[{port, serviceBasePath}]（serviceBasePath 缺省为
     *   undefined——继承全局的 binding 不返回该字段）。
     */
    enroll(port: number, opts?: { serviceBasePath?: string }): void;
    unenroll(port: number): void;
    enrolled(): Array<{ port: number; serviceBasePath?: string }>;
  };
  tunnels: {
    /** Declarative configs from configDir/tunnels.json. */
    configs(): TunnelConfig[];
    /** Persist the config list to configDir/tunnels.json. */
    saveConfigs(cfgs: TunnelConfig[]): void;
    add(cfg: TunnelConfig): void;
    remove(name: string): void;
    list(): TunnelInfo[];
    get(name: string): TunnelInfo | undefined;
    start(name: string): Promise<TunnelInfo>;
    stop(name: string): Promise<void>;
    stopAll(): Promise<void>;
    /** Restore URLs from state.json after a restart. */
    hydrate(): void;
    /** Tunnel types that support raw TCP (for the UI: only these selectable
     *  when exposing a tcp port). */
    tcpSupport(): string[];
  };
  /** Router port-mapping (mode "portmap"): capability probe + live mapping control. */
  portmap: {
    probe(opts?: { gateway?: string; ssdpTimeoutMs?: number }): Promise<PortmapProbe>;
    list(): Array<{ key: string; backend: "upnp" | "pcp" | "ssh-router"; gateway: string; externalIp: string; externalPort: number; internalPort: number }>;
    stop(key: string): Promise<boolean>;
  };
  /** Provider/tunnel parameter schemas — data-driven forms for clients
   *  (host renders inputs from these; adding a type/provider needs no
   *  client changes). */
  schemas: {
    /** 全部隧道类型 schema;lang: "zh" 返回中文,缺省/"en" 返回英文数据默认。 */
    tunnels(lang?: string): Record<string, ParamSpec[]>;
    /** 单类型 schema;lang 同上。 */
    tunnel(type: string, lang?: string): ParamSpec[];
    authProviders(lang?: string): Promise<Record<string, ParamSpec[]>>;
    /** Provider 页面元数据（label/已配置/待填）——picker 与「✓已配置」徽标。 */
    authMetas(): Record<string, import("./providers/oauth2-variants.ts").AuthProviderMeta>;
    metas(): Record<string, TunnelMeta>;
    /** Schema 契约版本（冻结承诺，adaptation-kit §5）：只增不减，破坏性变更才 bump。 */
    versions(): { tunnel: number; auth: number };
  };
  auth: {
    /** Built-in + plugin providers ("none" included when auth-none exposes
     *  are allowed; omitted when allowAuthNone is false). */
    providers(): string[];
    /** Whether unauthenticated (auth none) exposes are currently allowed
     *  (createServiceTunnels opts / SERVICE_TUNNELS_ALLOW_AUTH_NONE / config). */
    noneAllowed(): boolean;
    /** Register an extra provider factory (plugins). */
    registerProvider(factory: AuthProviderFactory): void;
    /** Expose with optional gateway auth (default provider: authelia). */
    expose(port: number, opts?: Omit<ExposeOptions, "port">): Promise<ExposeResult>;
    /**
     * Provider-local users (no secrets). `provider` = "all" (default) →
     * [{provider, users}] for every provider supporting user management.
     * `site` scopes to an auth realm (default "default").
     */
    users(provider?: string, site?: string): Promise<{ provider: string; users: AuthUser[] }[]>;
    /**
     * Add/update a user across `provider` (default "all" → every supporting
     * provider; also accepts a single type or an array). Returns the
     * providers the user was written to. `site` scopes to an auth realm.
     */
    addUser(
      name: string,
      password: string,
      opts?: { provider?: string | string[]; site?: string; displayName?: string },
    ): Promise<string[]>;
    /** Change a user's password across `provider` (default "all"). */
    setUserPassword(
      name: string,
      password: string,
      provider?: string | string[],
      site?: string,
    ): Promise<string[]>;
    /** 更新用户显示名（nickname）——不动密码/TOTP/生物模板。 */
    setDisplayName(
      name: string,
      displayName: string,
      provider?: string | string[],
      site?: string,
    ): Promise<string[]>;
    /** Remove a user across `provider` (default "all"). */
    removeUser(name: string, provider?: string | string[], site?: string): Promise<string[]>;
    /** Provider types with local user databases (e.g. ["authelia","basic"]). */
    userManagers(): string[];
    /** Provider types that expose TOTP 2FA management (portal). */
    totpProviders(): string[];
    /**
     * Providers in UI-recommendation order: authelia > portal > basic >
     * oauth2-proxy, plugins appended. Clients render this list as-is — no
     * provider-specific knowledge in the caller.
     */
    providerOrder(): string[];
    /**
     * The provider a new expose should default to: the highest-priority
     * provider that is actually usable right now (authelia needs a binary +
     * non-Windows; portal/basic/oauth2-proxy always are). Clients use this
     * instead of hardcoding provider names.
     */
    defaultProvider(): string;
    /** Enroll TOTP 2FA for a user (portal) — returns secret + otpauth URL.
     *  `label` 为 authenticator 标识（缺省 `<name>@<host>`），响应含生效 label。 */
    totpEnroll(
      name: string,
      provider?: string,
      site?: string,
      label?: string,
    ): Promise<{ secret: string; otpauthUrl: string; label: string }>;
    /** 默认 TOTP 标识（UI 登记前预填用）：`<name>@<host>`。 */
    totpDefaultLabel(name: string, provider?: string, site?: string): Promise<{ label: string }>;
    /** Disable TOTP 2FA for a user (portal). */
    totpDisable(name: string, provider?: string, site?: string): Promise<void>;
    /** TOTP enrollment status for a user (portal). */
    totpStatus(name: string, provider?: string, site?: string): Promise<{ enrolled: boolean; pending: boolean }>;
    /** Activate a pending TOTP enrollment with the user's first code. */
    totpActivate(name: string, code: string, provider?: string, site?: string): Promise<{ activated: boolean }>;
    /** Provider types exposing biometric 2FA management (portal，P1: face). */
    biometricProviders(): string[];
    /** 该用户各生物方法注册态（active=可用；*Pending=模板待首验转正，UI 显示“待验证”）。 */
    biometricStatus(name: string, provider?: string, site?: string): Promise<{ face: boolean; facePending: boolean; voice: boolean; voicePending: boolean }>;
    /** 注册人脸模板（管理 UI 浏览器采集 128-d 描述子）→ pending，首验转正。 */
    biometricEnrollFace(name: string, samples: number[][], provider?: string, site?: string): Promise<{ pending: boolean }>;
    /** 验证人脸向量（pending 首验门）；distance = 两两 L2 距离最小值。 */
    biometricVerifyFace(name: string, vectors: number[][], provider?: string, site?: string): Promise<{ matched: boolean; distance: number }>;
    /** 注册语音模板（3 次数字串朗读 → 78-d MFCC 向量；质量门后 pending）。 */
    biometricEnrollVoice(name: string, utterances: number[][], provider?: string, site?: string): Promise<{ pending: boolean }>;
    /** 验证语音向量（pending 首验门）；similarity = 两两余弦最大值。 */
    biometricVerifyVoice(name: string, vectors: number[][], provider?: string, site?: string): Promise<{ matched: boolean; similarity: number }>;
    /** portal /enroll 采集页一次性注册票（预设置路径；管理 UI 拼采集页 URL）。 */
    biometricEnrollTicket(name: string, method: "face" | "voice", provider?: string, site?: string): Promise<{ token: string; method: string; expiresInMs: number }>;
    /** 签票 + 本地采集页完整 URL（管理 UI 直接开窗；预设置路径）。 */
    biometricEnrollUrl(name: string, method: "face" | "voice", provider?: string, site?: string): Promise<{ token: string; method: string; expiresInMs: number; url: string | null }>;
    /** 移除生物模板（P1: face）。 */
    biometricDisable(name: string, method: "face" | "voice", provider?: string, site?: string): Promise<void>;
    /** Provider types with local token stores (e.g. ["token"]). */
    tokenManagers(): string[];
    /**
     * Provider-local tokens (no secrets). `provider` = "all" (default) →
     * [{provider, tokens}] for every provider supporting token management.
     * `site` scopes to an auth realm (default "default") — token 与 user
     * 一样按 site 隔离。
     */
    tokens(provider?: string, site?: string): Promise<{ provider: string; tokens: AuthToken[] }[]>;
    /**
     * Create a token (description + optional expiry). The raw secret is
     * returned ONCE (token.token) — list/revoke never show it again.
     */
    createToken(opts?: {
      description?: string;
      /** epoch ms；null = 永不过期。 */
      expiresAt?: number | null;
      provider?: string;
      site?: string;
    }): Promise<{ provider: string; token: AuthToken }[]>;
    /** Revoke a token by id across `provider` (default "all"). */
    revokeToken(id: string, provider?: string | string[], site?: string): Promise<string[]>;
  };
  /** Auth realms (sites): independent provider instances + user dbs. */
  sites: {
    /** All sites (config + running status), including the implicit default. */
    list(): import("./sites.ts").SiteInfo[];
    get(name: string): import("./sites.ts").SiteInfo | undefined;
    /** Add/replace a site (configDir/sites.json, 0600). */
    add(name: string, cfg: Omit<import("./sites.ts").SiteConfig, "name">): void;
    /** Remove a site (default and reserved names rejected). */
    remove(name: string): void;
  };
  /** Site-scoped ssh public-key auth (M0b-ssh): domain = site, port auto-
   *  allocated. The caller only ever deals with site + keys. */
  ssh: {
    list(): SshDomainInfo[];
    get(domain: string): SshDomainInfo | undefined;
    ensure(cfg: SshDomainConfig): Promise<SshDomainInfo>;
    create(cfg: SshDomainConfig): Promise<SshDomainInfo>;
    remove(domain: string): Promise<{ ok: true }>;
    start(domain: string): Promise<SshDomainInfo>;
    stop(domain: string): Promise<{ ok: true }>;
    keys: {
      list(domain: string): SshKeyInfo[];
      add(domain: string, publicKey: string): Promise<{ fingerprint: string }>;
      generate(domain: string, opts?: { type?: "ed25519" | "rsa" | "ecdsa"; bits?: number; comment?: string; count?: number }): Promise<GeneratedKeyPair[]>;
      remove(domain: string, fingerprint: string): Promise<{ removed: boolean }>;
    };
  };
  /** 参数变体（Presets, TODO-2）：隧道/认证参数的命名常用。list 返回掩码
   *  敏感字段（UI 展示）；get 返回明文（暴露合并用）；save 加密敏感字段落盘。 */
  presets: {
    list(kind: PresetKind, type?: string): Preset[];
    get(kind: PresetKind, type: string, name: string): Preset | undefined;
    save(kind: PresetKind, type: string, name: string, params: Record<string, string | number | boolean | undefined>): Preset;
    remove(kind: PresetKind, type: string, name: string): boolean;
    summary(params: Record<string, string>): string;
  };
  /** self-expose（TODO-5）：宿主暴露自身端口 + allowlocal/allowHost 直连门控。 */
  self: {
    exposeSelf(opts: SelfExposeOptions): Promise<{ url: string | null; localUrl?: string; baseUrl?: string; domainUrl?: string; error?: string; name?: string }>;
    maybeExposeSelf(env?: string): Promise<{ exposed: boolean; error?: string }>;
    allowLocal(): boolean;
    setAllowLocalTemporary(v: boolean, ttlMs: number): void;
    confirmAllowLocal(v: boolean): void;
    getAllowLocalPending(): { pending: boolean; expiresAt: number };
    allowHosts(): string[];
    setAllowHosts(hosts: string[]): void;
    isDirectAccessAllowed(host: string | undefined): boolean;
  };
  /** Current runtime state (tunnels/auth) from state.json. */
  state(): ReturnType<typeof readState>;
  /** Stop everything: all tunnels + the shared nginx gateway + redis.
   *  Call on normal shutdown so framework helpers don't outlive the host
   *  (the guardian only covers crash/SIGKILL). */
  shutdown(): Promise<void>;
  /** Exposes made in this process lifecycle with their metadata (port, tunnel
   *  type, auth provider, url, running, pid, startedAt). For display; not
   *  persisted (the daemon persists its own registry for the UI). */
  exposes(): Array<{ name: string; port: number; tunnelType?: string; provider?: string; loginUrl?: string; protocol?: string; url: string | null; running: boolean; pid: number | null; accessLog: string | null; errorLog: string | null; site?: string; label?: string; localUrl?: string; baseUrl?: string; domainUrl?: string; startedAt?: number | null }>;
}

/**
 * Create a service-tunnels instance. Library mode: the manager runs inside
 * the caller's process (host does this — helpers become its descendants,
 * discovery scopes to its process tree). CLI mode: use `st.daemon.start()`
 * and the daemon owns long-lived processes.
 */
function resolveUserTargets(
  registry: AuthRegistry,
  provider?: string | string[],
  /** 能力探测器：缺省 = 用户管理；传 tokenManagers 即按 token 能力解析。 */
  capable: (r: AuthRegistry) => string[] = (r) => r.userManagers(),
  what = "user management",
): string[] {
  const all = capable(registry);
  if (!provider || provider === "all") return all;
  const targets = Array.isArray(provider) ? provider : [provider];
  for (const t of targets) {
    if (!all.includes(t)) throw new Error(`provider ${t} does not support ${what} (available: ${all.join(", ")})`);
  }
  return targets;
}

export function createServiceTunnels(opts: ServiceTunnelsOptions = {}): ServiceTunnels {
  const dirs = resolveDirs(opts);
  // Hardening: the cache holds password hashes, session secrets and tunnel
  // tokens — make the whole tree unreadable to other users (umask may be 022).
  hardenDir(dirs.cacheDir, true);
  const file = readConfigFile(dirs.configDir);
  ensureMarker(opts.marker);
  // PID registration: framework processes register here; the guardian reads
  // this file on its low-frequency scan and reaps them on parent death.
  // Scoped per parent pid so multiple owners never share a file.
  const registerPid = (role: string, pid: number) => registerPidToFile(dirs.cacheDir, process.pid, role, pid);
  if (opts.guardian !== false) {
    spawnGuardian(process.pid, { registrationFile: registrationFilePath(dirs.cacheDir, process.pid), cacheDir: dirs.cacheDir, nodePath: opts.nodePath });
  }
  const internal = new InternalRegistry();
  // auth-none ban (sticky): explicit createServiceTunnels opt > env
  // SERVICE_TUNNELS_ALLOW_AUTH_NONE > config file; any false wins, a per-call
  // true cannot re-enable an operator ban (resolveAllowAuthNone enforces).
  const allowAuthNone = resolveAllowAuthNone(dirs.configDir, opts.allowAuthNone);
  // Priority: explicit option > env SERVICE_TUNNELS_ALLOW_DOWNLOAD > config-file
  // fallback > default true. Never persisted — config file is a read-only
  // fallback, not a dependency.
  const envAllow = process.env.SERVICE_TUNNELS_ALLOW_DOWNLOAD;
  let allowToolDownload =
    opts.allowToolDownload ??
    (envAllow !== undefined
      ? !(envAllow === "0" || envAllow.toLowerCase() === "false" || envAllow.toLowerCase() === "off")
      : file.allowToolDownload ?? true);
  const toolOpts = {
    cacheDir: dirs.cacheDir,
    toolPaths: mergeToolPaths(opts.toolPaths),
    toolMirrors: opts.toolMirrors ?? file.toolMirrors,
    preferMirrors: opts.preferMirrors ?? file.preferMirrors,
    allowToolDownload,
  };
  const tm = new TunnelManager({
    cacheDir: dirs.cacheDir,
    resolveTool: async (name: string) => st_tools_ensure(name, toolOpts),
    registerPid,
    log: () => {},
  });
  for (const cfg of readTunnelConfigs(dirs.configDir)) tm.add(cfg);
  tm.hydrate(readState(cachePaths(dirs.cacheDir).stateFile).tunnels);

  // Shared singletons — ONE nginx gateway + ONE redis for ALL exposes, so
  // repeated expose() calls reuse them instead of spawning a fresh nginx/
  // redis each time (which leaked processes and confused discovery). Both
  // register their port in `internal` so discovery excludes them.
  const gateway = new GatewayController({
    configDir: dirs.configDir,
    cacheDir: dirs.cacheDir,
    port: 0,
    registerInternal: (role, p) => internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
    unregisterInternal: (role) => internal.unregister(role),
    registerPid,
    log: () => {},
  });
  const redis = new RedisController({ cacheDir: dirs.cacheDir, port: 0, log: () => {}, registerPid });
  // Auth provider registry — hoisted so the proxy transport's lazy provider
  // wiring (mode proxy/both) shares the SAME instances as expose() (tunnel).
  const authRegistry = new AuthRegistry(
    {
      configDir: dirs.configDir,
      cacheDir: dirs.cacheDir,
      resolveTool: async (name: string) => st_tools_ensure(name, toolOpts),
      registerInternal: (role, port) =>
        internal.register(role, { port, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
      unregisterInternal: (role) => internal.unregister(role),
      registerPid,
      pickPort,
      nodePath: opts.nodePath,
      log: () => {},
    },
    [...(opts.authPlugins as AuthProviderFactory[]) ?? []],
  );
  // M0b-ssh: in-process ssh manager — site-scoped public-key auth for exposes
  // (provider "ssh", any protocol). The ssh gateway port is registered as
  // internal so discovery excludes it from candidate services.
  const ssh = new SshManager({ cacheDir: dirs.cacheDir });
  void loadProviderPlugins(dirs.configDir).then((plugins) => {
    for (const f of plugins) authRegistry.register(f);
  });
  // Shared proxy transport + enrollment registry (D4) — the ONLY way ports are
  // served through the wildcard proxy (mode proxy/both): a binding must exist.
  // isPortAllowed is deliberately permissive: enrollment (resolveSite) is the
  // gate, and expose already verified port ownership at enrollment time; the
  // discovery allow-list still guards the low-level st.proxy.create().
  const { primary: primaryBase, list: baseDomains } = resolveBaseDomains(dirs.configDir, opts);
  const proxy = new ProxyManager({
    suffixes: DEFAULT_SUFFIXES,
    baseDomain: primaryBase,
    baseDomains,
    basePath: (opts.deployBasePath ?? "").replace(/\/+$/, ""),
    serviceBasePath: opts.serviceBasePath,
    registry: authRegistry,
    gateway,
    getSites: () => readSites(dirs.configDir),
    // IP:port 直连（mode portmap 外部入口）——仅命中已 enroll 的 open binding，
    // enrollment(D4)与 auth 照常生效，无安全面扩大。
    allowIpDirect: true,
    // persist enrollments (mode proxy/both) to state.json — the daemon restores
    // them on restart (P4). The arrow captures `proxy` (assigned after this
    // constructor returns; only ever invoked on later addBinding/removeBinding).
    onChange: () => _updateState(cachePaths(dirs.cacheDir).stateFile, (s) => {
      s.bindings = proxy.persisted();
    }),
    isPortAllowed: () => true,
    transformResponse: opts.transformResponse,
    registerInternal: (role, p) => internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
    log: () => {},
  });
  // In-memory record of exposes made in THIS process lifecycle
const authExposeFn = async (port: number, o: Omit<ExposeOptions, "port"> = {}) => {
// per-call false tightens; per-call true can't loosen the instance/
// env/config ban (sticky) — exposeFlow re-resolves with env+config
const effAllowNone = o.allowAuthNone === false ? false : allowAuthNone;
// 全局静态注入（tunnel nginx 路径）——单次 expose 的 inject 参数优先
const effInject = o.inject ?? opts.inject;
const r = await exposeFlow(port, { ...o, inject: effInject, allowAuthNone: effAllowNone, port }, {
  configDir: dirs.configDir,
  cacheDir: dirs.cacheDir,
  resolveTool: async (name: string) =>
    // per-expose param beats the shared toolOpts (env > config fallback)
    o.allowToolDownload !== undefined
      ? st_tools_ensure(name, { ...toolOpts, allowToolDownload: o.allowToolDownload })
      : st_tools_ensure(name, toolOpts),
  internal,
  tunnels: tm,
  auth: authRegistry,
  gateway,
  proxy,
  redis,
  registerPid,
  onTunnelStop: unregisterExposeHost,
  log: () => {},
  // M0b-ssh: site-scoped public-key auth — auto-provision the site's
  // backing ssh domain (port auto-allocated) and resolve its port.
  sshEnsureDomain: async (site, forwardPort) => {
    const domain = site === "default" ? "default" : site;
    const existing = ssh.get(domain);
    try {
      const info = existing ?? (await ssh.ensure({ domain, site, forwardPort, sshPort: 0 }));
      return { port: info.port, created: !existing };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ssh auth: cannot provision site "${site}": ${msg}`);
    }
  },
  sshRemoveDomain: async (site) => {
    const domain = site === "default" ? "default" : site;
    try {
      if (ssh.get(domain)) await ssh.remove(domain);
    } catch { /* best effort */ }
  },
  sshGatewayPort: (domain) => ssh.get(domain)?.port,
});
// record this expose's metadata for the lifecycle display (proxy-mode
// records have no tunnel → synthetic key `proxy:port:label`; portmap-mode
// records carry mode + portmap detail so the UI can tell them apart)
exposes.set(r.tunnel || `proxy:${port}:${r.label ?? ""}`, {
  port,
  mode: r.mode,
  tunnelName: r.tunnel || undefined,
  tunnelType: o.tunnelType,
  // ssh provider: the raw tcp tunnel records no provider on the
  // result — surface "ssh" so the UI/registry display it correctly.
  provider: o.provider === "ssh" || o.auth === "ssh" ? "ssh" : r.provider,
  loginUrl: r.loginUrl,
  protocol: r.protocol,
  host: r.url ? new URL(r.url).host : undefined,
  site: r.site ?? o.site,
  label: r.label,
  localUrl: r.localUrl,
  baseUrl: r.baseUrl,
  domainUrl: r.domainUrl,
  portmap: r.portmap,
  startedAt: Date.now(),
  });
  return r;
};

  // Exposes made in this process lifecycle (port + tunnel type + auth
  // provider + url), for display. Not persisted across restarts.
  const exposes = new Map<string, { port: number; mode?: string; tunnelName?: string; tunnelType?: string; provider?: string; loginUrl?: string; protocol?: string; host?: string; site?: string; label?: string; localUrl?: string; baseUrl?: string; domainUrl?: string; portmap?: { backend: string; gateway: string; externalIp: string; externalPort: number; internalPort: number; leaseSeconds: number }; startedAt?: number }>();

  /** Unregister the gateway host an expose registered (so stopping one expose
   *  doesn't leave a stale nginx server block — localhost:PORT hosts would
   *  otherwise collide with the next expose since nginx server_name ignores
   *  the port part). */
  const unregisterExposeHost = async (name: string): Promise<void> => {
    const ex = exposes.get(name);
    if (ex?.host) {
      try { await gateway.unregisterHost(ex.host); } catch { /* best effort */ }
    }
  };

  return {
    dirs,
    internal,
    discovery: {
      discoverPorts(o: DiscoveryOptions = {}) {
        return [...discoverServicePorts(internal, o).values()];
      },
      getPorts(o: DiscoveryOptions = {}) {
        return getServicePorts(internal, o);
      },
      isPortAllowed(port: number) {
        return isServicePortAllowed(internal, port);
      },
    },
    daemon: {
      status: () => daemonStatus(dirs.cacheDir),
      start: (o) => startDaemon(dirs.cacheDir, { ...o, configDir: dirs.configDir, nodePath: opts.nodePath }),
      stop: () => stopDaemon(dirs.cacheDir),
      request: <T>(method: string, params?: unknown, timeoutMs = 5_000) =>
        requestDaemon<T>(dirs.cacheDir, method, params, timeoutMs),
    },
    portmap: {
      probe: (o?: { gateway?: string; ssdpTimeoutMs?: number }) => portmapProbe(o),
      list: () =>
        listPortmaps().map(({ key, mapping, externalIp }) => ({
          key,
          backend: mapping.backend,
          gateway: mapping.gateway,
          externalIp,
          externalPort: mapping.externalPort,
          internalPort: mapping.internalPort,
        })),
      stop: (key: string) => stopPortmap(key),
    },
    tools: {
      ensure: (name: string) => {
        const def = TOOLS[name];
        if (!def) throw new Error(`unknown tool: ${name} (known: ${Object.keys(TOOLS).join(", ")})`);
        return ensureTool(def, toolOpts);
      },
      resolve: (name: string) => resolveToolPath(name, toolOpts),
      list: () =>
        Object.entries(TOOLS).map(([name, def]) => {
          const explicit = toolOpts.toolPaths?.[name];
          const onPath = resolveToolPath(name, toolOpts);
          const source = explicit
            ? "toolPaths"
            : findOnPath(name)
              ? "path"
              : onPath
                ? "cache"
                : null;
          return { name, path: onPath, source };
        }),
      allowDownload: () => allowToolDownload,
      setAllowDownload: (allowed: boolean) => {
        // git-config style: persist to service-tunnels.json. Reads keep the
        // priority params > env > file > default, so per-expose params still
        // win; the file is the durable default, not a hard dependency.
        allowToolDownload = !!allowed;
        toolOpts.allowToolDownload = allowToolDownload;
        try {
          const f = readConfigFile(dirs.configDir);
          f.allowToolDownload = allowToolDownload;
          writeConfigFile(dirs.configDir, f);
        } catch {
          // config write failures must not break the toggle
        }
      },
    },
    proxy: {
      create: (o: Omit<ProxyOptions, "internal"> = {}) =>
        createProxyServer({
          ...o,
          isPortAllowed:
            o.isPortAllowed ??
            ((port: number) =>
              getServicePorts(internal, { force: o.refresh, rootPid: o.rootPid }).some(
                (p) => p.port === port,
              )),
        }),
      parseHost: (host: string | undefined) => proxy.parseHost(host),
      resolve: (input) => proxy.resolve(input),
      // P2: shared transport + enrollment registry (D4) — mode proxy/both
      start: (o: { port?: number; refresh?: boolean; rootPid?: number } = {}) =>
        proxy.start(o.port),
      stop: () => proxy.stop(),
      status: () => proxy.status(),
      bindings: () => proxy.bindings(),
      addBinding: (b: ProxyBinding) => proxy.addBinding(b),
      removeBinding: (port: number, label: string) => proxy.removeBinding(port, label),
      restore: (bindings: ProxyBinding[]) => proxy.restore(bindings),
      persisted: () => proxy.persisted(),
      // Open-binding 高层 API（数据源唯一为 binding 持久化）
      enroll: (port: number, opts = {}) => {
        const existing = proxy.bindings().find((b) => b.port === port && b.label === "");
        const serviceBasePath = opts.serviceBasePath !== undefined
          ? (opts.serviceBasePath === "" ? undefined : opts.serviceBasePath)
          : existing?.serviceBasePath;
        proxy.addBinding({
          port,
          label: "",
          site: "default",
          provider: "",
          ...(serviceBasePath !== undefined ? { serviceBasePath } : {}),
        });
      },
      unenroll: (port: number) => {
        proxy.removeBinding(port, "");
      },
      enrolled: () => proxy.bindings()
        .filter((b) => b.label === "" && b.site === "default" && b.provider === "")
        .map((b) => ({ port: b.port, ...(b.serviceBasePath !== undefined ? { serviceBasePath: b.serviceBasePath } : {}) })),
    },
    tunnels: (() => {
      const persistState = () => {
        const { updateState } = require_state();
        updateState(cachePaths(dirs.cacheDir).stateFile, (s) => {
          s.tunnels = tm.persisted();
        });
      };
      return {
        configs: () => readTunnelConfigs(dirs.configDir),
        saveConfigs: (cfgs: TunnelConfig[]) => writeTunnelConfigs(dirs.configDir, cfgs),
        add: (cfg: TunnelConfig) => {
          tm.add(cfg);
          const all = readTunnelConfigs(dirs.configDir);
          const idx = all.findIndex((c) => c.name === cfg.name);
          if (idx >= 0) all[idx] = cfg;
          else all.push(cfg);
          writeTunnelConfigs(dirs.configDir, all);
        },
        remove: (name: string) => {
          tm.remove(name);
          writeTunnelConfigs(dirs.configDir, readTunnelConfigs(dirs.configDir).filter((c) => c.name !== name));
        },
        list: () => tm.list(),
        get: (name: string) => tm.get(name),
        start: async (name: string) => {
          const info = await tm.start(name);
          persistState();
          return info;
        },
        stop: async (name: string) => {
          const ex = exposes.get(name);
          if (ex && !ex.tunnelName) {
            // proxy-mode expose (no tunnel): drop the binding + record
            proxy.removeBinding(ex.port, ex.label ?? "");
            exposes.delete(name);
            await unregisterExposeHost(name);
            persistState();
            return;
          }
          await tm.stop(name);
          persistState();
          await unregisterExposeHost(name);
          // TODO-1 (fail-clean): ssh provider 暴露停止 → 清理 backing ssh 域
          // （该 site 无其他运行中 ssh 暴露时才删，避免误伤共用域）。
          if (ex?.provider === "ssh" && ex.site) {
            const others = [...exposes.values()].filter(
              (e) => e !== ex && e.provider === "ssh" && e.site === ex.site,
            );
            if (!others.length) {
              try { if (ssh.get(ex.site)) await ssh.remove(ex.site); } catch { /* best effort */ }
            }
          }
        },
        stopAll: async () => {
          for (const name of [...exposes.keys()]) await unregisterExposeHost(name);
          await tm.stopAll();
          persistState();
        },
        hydrate: () => tm.hydrate(readState(cachePaths(dirs.cacheDir).stateFile).tunnels),
        tcpSupport: () => {
          const fixed: TunnelType[] = ["ssh"]; // resolved via PATH, not TOOLS
          const fromTools = (Object.keys(TOOLS) as TunnelType[]).filter((t) => tunnelSupportsTcp(t));
          // custom command tunnels (env-registered) are assumed tcp-capable
          const custom = Object.keys(customTunnelTemplates());
          return [...new Set([...fixed, ...fromTools, ...custom])];
        },
      };
    })(),
    auth: (() => {
      // registry is hoisted (shared with the proxy transport's lazy wiring)
      const registry = authRegistry;
      return {
        providers: () => (allowAuthNone ? ["none", ...registry.list()] : [...registry.list()]),
        noneAllowed: () => allowAuthNone,
        registerProvider: (f: AuthProviderFactory) => registry.register(f),
        expose: authExposeFn,
        userManagers: () => registry.userManagers(),
        tokenManagers: () => registry.tokenManagers(),
        totpProviders: () => registry.totpProviders(),
        totpEnroll: async (name: string, provider?: string, site?: string, label?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as {
            totpEnroll(n: string, label?: string): Promise<{ secret: string; otpauthUrl: string; label: string }>;
          };
          return mgr.totpEnroll(name, label);
        },
        totpDefaultLabel: async (name: string, provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as {
            defaultTotpLabel?(n: string): string;
          };
          if (!mgr.defaultTotpLabel) throw new Error(`provider ${provider ?? "portal"} has no default TOTP label`);
          return { label: mgr.defaultTotpLabel(name) };
        },
        totpDisable: async (name: string, provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as {
            totpDisable(n: string): Promise<void>;
          };
          await mgr.totpDisable(name);
        },
        totpStatus: async (name: string, provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as {
            totpStatus(n: string): Promise<{ enrolled: boolean; pending: boolean }>;
          };
          return mgr.totpStatus(name);
        },
        totpActivate: async (name: string, code: string, provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as {
            totpActivate(n: string, code: string): Promise<{ activated: boolean }>;
          };
          return mgr.totpActivate(name, code);
        },
        biometricProviders: () => registry.biometricProviders(),
        /** 管理端支撑：确保 face 浏览器资产（face-api.js + 模型，~8.4MB）已下载；
         *  返回资产目录 + 文件清单（管理 UI 的采集页加载用，serve 走宿主）。 */
        biometricAssetsEnsure: async (): Promise<{ dir: string; files: string[] }> => {
          const { faceAssetsDir, FACE_ASSETS } = await import("./providers/portal.ts");
          const dir = faceAssetsDir(dirs.cacheDir);
          const { mkdirSync } = await import("node:fs");
          mkdirSync(dir, { recursive: true });
          const inst = registry.create("portal", { biometrics: true } as never, "default") as unknown as { ensureFaceAssets?: () => Promise<void> };
          await inst.ensureFaceAssets?.();
          return { dir, files: FACE_ASSETS.map((a: { file: string }) => a.file) };
        },
        biometricStatus: async (name: string, provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as import("./auth-provider.ts").BiometricManager;
          return mgr.biometricStatus(name);
        },
        biometricEnrollFace: async (name: string, samples: number[][], provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as import("./auth-provider.ts").BiometricManager;
          return mgr.biometricEnrollFace(name, samples);
        },
        biometricVerifyFace: async (name: string, vectors: number[][], provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as import("./auth-provider.ts").BiometricManager;
          return mgr.biometricVerifyFace(name, vectors);
        },
        biometricEnrollVoice: async (name: string, utterances: number[][], provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as import("./auth-provider.ts").BiometricManager;
          return mgr.biometricEnrollVoice(name, utterances);
        },
        biometricVerifyVoice: async (name: string, vectors: number[][], provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as import("./auth-provider.ts").BiometricManager;
          return mgr.biometricVerifyVoice(name, vectors);
        },
        biometricEnrollTicket: async (name: string, method: "face" | "voice", provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as import("./auth-provider.ts").BiometricManager;
          return mgr.biometricEnrollTicket(name, method);
        },
        biometricEnrollUrl: async (name: string, method: "face" | "voice", provider?: string, site?: string) => {
          // 管理侧「开启人脸/语音」= 一步直达：门户没跑（或没开 biometrics）
          // 时按需拉起——销毁缓存实例 → 以 biometrics:true 重建 → start()
          // （首次下载 face 资产 ~8.4MB）→ 签票 + 采集页 URL。
          // 签票本身只依赖 secret + 用户库；拉起门户只为浏览器采集页服务。
          let mgr = registry.userManager(provider ?? "portal", site) as unknown as
            import("./auth-provider.ts").BiometricManager & { port?: number; basePath?: string };
          const port0 = mgr.port ?? 0;
          if (!port0 || port0 <= 0) {
            // 按需拉起：沿用该站点的全部 provider 配置（sites.json providerParams
            // + deployBasePath——与 expose.ts 同一合并规则），叠加 biometrics:true
            // 重建实例并启动（首次下载 face 资产 ~8.4MB）。
            const pType = provider ?? "portal";
            const sitesCfg: Record<string, { name: string; providerParams?: Record<string, unknown>; policy?: string }> = readSites(dirs.configDir) as never;
            const siteCfg = sitesCfg?.[site ?? "default"];
            const { unflattenParams: unflat } = await import("./expose.ts");
            await registry.evict(pType, site);
            const recreated = registry.create(
              pType,
              {
                ...unflat(siteCfg?.providerParams ?? {}),
                biometrics: true,
                deployBasePath: proxy.basePath || undefined,
                policy: siteCfg?.policy,
              } as never,
              site,
            );
            mgr = recreated as unknown as typeof mgr;
            // basePath 决策链与 expose.ts 一致：portal 的 forward-auth 网关必须有
            // 非空 basePath（server 按 BASE+path 路由，空串会落到 SPA fallback →
            // authz 探针 404）。默认取 provider 自述随机名。
            const pAny = recreated as unknown as {
              basePath?: string; defaultBasePath?: () => string;
              capabilities?: { nestedBasePath?: boolean };
              setBasePath?: (p: string) => Promise<void> | void;
            };
            if (!pAny.basePath) {
              const bp = pAny.defaultBasePath?.() ?? `/${pType}`;
              const nested = pAny.capabilities?.nestedBasePath === true;
              const deploy = proxy.basePath || "";
              const merged = nested && deploy ? deploy.replace(/\/+$/, "") + bp : bp;
              await pAny.setBasePath?.(merged);
            }
            await (recreated as unknown as { start: () => Promise<unknown> }).start();
          }
          const t = await mgr.biometricEnrollTicket(name, method);
          const port = (mgr as { port?: number }).port ?? 0;
          return { ...t, url: `http://127.0.0.1:${port}${(mgr as { basePath?: string }).basePath ?? ""}/enroll?m=${method}&t=${encodeURIComponent(t.token)}` };
        },
        biometricDisable: async (name: string, method: "face" | "voice", provider?: string, site?: string) => {
          const mgr = registry.userManager(provider ?? "portal", site) as unknown as import("./auth-provider.ts").BiometricManager;
          await mgr.biometricDisable(name, method);
        },
        providerOrder: () => {
          const KNOWN = ["authelia", "portal", "basic", "token", "oauth2-proxy"];
          const list = registry.list();
          const metas = authProviderMetas(dirs.configDir);
          // oauth2 变体：已配置（凭据已由配置档携带）优先，未配置按注册顺序
          const variants = list
            .filter((p) => metas[p]?.kind === "oauth2-variant")
            .sort((a, b) => Number(metas[b]?.configured) - Number(metas[a]?.configured));
          const rest = list.filter((p) => !KNOWN.includes(p) && metas[p]?.kind !== "oauth2-variant");
          return [...KNOWN.filter((p) => list.includes(p)), ...variants, ...rest];
        },
        defaultProvider: () => {
          const order = ["authelia", "portal", "basic", "token", "oauth2-proxy"].filter((p) => registry.list().includes(p));
          for (const p of order) {
            // authelia ships no Windows binary and needs the tool present
            if (p === "authelia" && (platform() === "win32" || !resolveToolPath("authelia", toolOpts))) continue;
            return p;
          }
          return "portal";
        },
        users: async (provider = "all", site = "default") => {
          const targets = resolveUserTargets(registry, provider);
          const out: { provider: string; users: AuthUser[] }[] = [];
          for (const t of targets) out.push({ provider: t, users: await registry.userManager(t, site).listUsers() });
          return out;
        },
        addUser: async (name: string, password: string, opts: { provider?: string | string[]; site?: string; displayName?: string } = {}) => {
          const targets = resolveUserTargets(registry, opts.provider);
          for (const t of targets) await registry.userManager(t, opts.site).addUser(name, password, opts.displayName);
          return targets;
        },
        setUserPassword: async (name: string, password: string, provider?: string | string[], site?: string) => {
          const targets = resolveUserTargets(registry, provider);
          const done: string[] = [];
          for (const t of targets) {
            try {
              await registry.userManager(t, site).setUserPassword(name, password);
              done.push(t);
            } catch (err) {
              // 该 provider 没有此用户 → 跳过（用户只存在于其中一个 provider）
              if (!(err instanceof Error) || !/not (found|registered)|no such user/i.test(err.message)) throw err;
            }
          }
          if (!done.length) throw new Error(`user ${name} not registered`);
          return done;
        },
        setDisplayName: async (name: string, displayName: string, provider?: string | string[], site?: string) => {
          const targets = resolveUserTargets(registry, provider);
          const done: string[] = [];
          for (const t of targets) {
            try {
              await registry.userManager(t, site).setDisplayName(name, displayName);
              done.push(t);
            } catch (err) {
              // basic 等不支持 displayName 的 provider → 跳过（"not support"）；
              // 用户不存在 → 跳过（可能只在另一 provider）
              if (!(err instanceof Error) || !/not (found|registered)|no such user|not support/i.test(err.message)) throw err;
            }
          }
          if (!done.length) throw new Error(`no provider supports display names for user ${name}`);
          return done;
        },
        removeUser: async (name: string, provider?: string | string[], site?: string) => {
          const targets = resolveUserTargets(registry, provider);
          const done: string[] = [];
          for (const t of targets) {
            try {
              await registry.userManager(t, site).removeUser(name);
              done.push(t);
            } catch (err) {
              if (!(err instanceof Error) || !/not (found|registered)|no such user/i.test(err.message)) throw err;
            }
          }
          if (!done.length) throw new Error(`user ${name} not registered`);
          return done;
        },
        // —— token 管理（与 user 同构：按 site 隔离，见 TokenManager）——
        tokens: async (provider = "all", site = "default") => {
          const targets = resolveUserTargets(registry, provider, (r) => r.tokenManagers(), "token management");
          const out: { provider: string; tokens: AuthToken[] }[] = [];
          for (const t of targets) out.push({ provider: t, tokens: await registry.tokenManager(t, site).listTokens() });
          return out;
        },
        createToken: async (opts: { description?: string; expiresAt?: number | null; provider?: string; site?: string } = {}) => {
          const targets = resolveUserTargets(registry, opts.provider, (r) => r.tokenManagers(), "token management");
          const out: { provider: string; token: AuthToken }[] = [];
          for (const t of targets) out.push({ provider: t, token: await registry.tokenManager(t, opts.site ?? "default").createToken({ description: opts.description, expiresAt: opts.expiresAt }) });
          return out;
        },
        revokeToken: async (id: string, provider?: string | string[], site?: string) => {
          const targets = resolveUserTargets(registry, provider, (r) => r.tokenManagers(), "token management");
          for (const t of targets) await registry.tokenManager(t, site).revokeToken(id);
          return targets;
        },
      };
    })(),
    /** Auth realms (sites) — independent provider instances + user dbs. */
    sites: (() => {
      const all = (): Record<string, SiteConfig> => readSites(dirs.configDir);
      return {
        list: (): SiteInfo[] => {
          const sites = all();
          const names = new Set(["default", ...Object.keys(sites)]);
          const out: SiteInfo[] = [];
          for (const name of names) {
            const cfg = sites[name] ?? defaultSiteConfig();
            const status = authRegistry.siteStatus(name);
            out.push({ ...cfg, running: status.running, port: status.port, hosts: [] });
          }
          return out;
        },
        get: (name: string): SiteInfo | undefined => {
          const cfg = name === "default" ? defaultSiteConfig() : all()[name];
          if (!cfg) return undefined;
          const status = authRegistry.siteStatus(name);
          return { ...cfg, running: status.running, port: status.port, hosts: [] };
        },
        add: (name: string, cfg: Omit<SiteConfig, "name">): void => {
          validateSiteName(name);
          const sites = all();
          sites[name] = { ...cfg, name };
          writeSites(dirs.configDir, sites);
        },
        remove: (name: string): void => {
          validateSiteName(name);
          const sites = all();
          if (!sites[name]) throw new Error(`site ${name} not registered`);
          delete sites[name];
          writeSites(dirs.configDir, sites);
        },
      };
    })(),
    /** Site-scoped ssh public-key auth (M0b-ssh) — domain = site, port
     *  auto-allocated; keys managed per domain (per site). */
    ssh: {
      list: () => ssh.list(),
      get: (domain: string) => ssh.get(domain),
      ensure: (cfg: SshDomainConfig) => ssh.ensure(cfg),
      create: (cfg: SshDomainConfig) => ssh.create(cfg),
      remove: (domain: string) => ssh.remove(domain),
      start: (domain: string) => ssh.start(domain),
      stop: (domain: string) => ssh.stop(domain),
      keys: {
        list: (domain: string) => ssh.listKeys(domain),
        add: (domain: string, publicKey: string) => ssh.addKey(domain, publicKey),
        generate: (domain: string, opts?: { type?: "ed25519" | "rsa" | "ecdsa"; bits?: number; comment?: string; count?: number }) => ssh.generateKey(domain, opts),
        remove: (domain: string, fingerprint: string) => ssh.removeKey(domain, fingerprint),
      },
    },
    /** 参数变体（Presets, TODO-2）——配置档读写 + AES-256-GCM 加密。 */
    presets: {
      list: (kind: PresetKind, type?: string) => listPresets(readConfigFile(dirs.configDir), kind, type, loadPresetsKey(dirs.cacheDir)),
      get: (kind: PresetKind, type: string, name: string) => getPreset(readConfigFile(dirs.configDir), kind, type, name, loadPresetsKey(dirs.cacheDir)),
      save: (kind: PresetKind, type: string, name: string, params: Record<string, string | number | boolean | undefined>) => {
        const f = readConfigFile(dirs.configDir);
        savePreset(f, kind, type, name, params, loadPresetsKey(dirs.cacheDir));
        writeConfigFile(dirs.configDir, f);
        return getPreset(f, kind, type, name, loadPresetsKey(dirs.cacheDir))!;
      },
      remove: (kind: PresetKind, type: string, name: string) => {
        const f = readConfigFile(dirs.configDir);
        const removed = removePreset(f, kind, type, name);
        if (removed) writeConfigFile(dirs.configDir, f);
        return removed;
      },
      summary: presetSummary,
    },
    /** self-expose（TODO-5）：宿主暴露自身端口 + allowlocal/allowHost 门控。
     *  allowlocal 基线来自 env SERVICE_TUNNELS_EXPOSE（缺省 true）。 */
    self: (() => {
      const baseline = parseExposeEnv(process.env.SERVICE_TUNNELS_EXPOSE);
      const gate = createSelfGate(baseline?.allowlocal ?? true, baseline?.allowHost ?? []);
      const selfApi = {
        exposeSelf: (opts: SelfExposeOptions) => exposeSelfFlow(authExposeFn, opts),
        maybeExposeSelf: (env?: string) => maybeExposeSelfFlow({ self: selfApi, authExpose: authExposeFn }, env),
        allowLocal: () => gate.allowLocal(),
        setAllowLocalTemporary: (v: boolean, ttlMs: number) => gate.setAllowLocalTemporary(v, ttlMs),
        confirmAllowLocal: (v: boolean) => gate.confirmAllowLocal(v),
        getAllowLocalPending: () => gate.getAllowLocalPending(),
        allowHosts: () => gate.allowHosts(),
        setAllowHosts: (hosts: string[]) => gate.setAllowHosts(hosts),
        isDirectAccessAllowed: (host: string | undefined) => gate.isDirectAccessAllowed(host),
      };
      return selfApi;
    })(),
    /** Provider/tunnel parameter schemas — data-driven forms for clients
     *  (host renders inputs from these; no client changes per provider).
     *  lang: "zh" returns localized (Chinese) strings; default/en returns
     *  the English data defaults. */
    schemas: {
      tunnels: (lang?: string) => localizeSchemas(tunnelParamSchemas(), resolveLang(lang)),
      tunnel: (type: string, lang?: string) => localizeSpecs(tunnelParamSchema(type), resolveLang(lang)),
      metas: () => tunnelMetas(),
      authProviders: async (lang?: string) => localizeSchemas(await authProviderSchemas(dirs.configDir), resolveLang(lang)),
      authMetas: () => authProviderMetas(dirs.configDir),
      /** Schema contract versions — clients assert compatibility (adaptation-kit §5). */
      versions: () => ({ tunnel: TUNNEL_SCHEMAS_VERSION, auth: AUTH_SCHEMAS_VERSION }),
    },
    state: () => readState(cachePaths(dirs.cacheDir).stateFile),
    shutdown: async () => {
      await tm.stopAll();
      try { await authRegistry.stopAll(); } catch {}
      try { await gateway.stop(); } catch {}
      try { await redis.stop(); } catch {}
      try { await proxy.stop(); } catch {}
      // M0b-ssh: stop the in-process site ssh gateways so the listener closes
      for (const d of ssh.list()) {
        try { await ssh.stop(d.domain); } catch { /* best effort */ }
      }
    },
    /** Exposes made in this process lifecycle (port + tunnel type + auth
     *  provider + url + running + startedAt), for display. Not persisted
     *  (daemon persists its own registry for the UI — M0b). */
    exposes: () =>
      [...exposes.entries()].map(([name, m]) => {
        const tun = m.tunnelName ? tm.get(m.tunnelName) : null;
        const host = tun?.url ? new URL(tun.url).host : null;
        const logs = host ? gateway.logPaths(host) : null;
        return {
          name,
          port: m.port,
          tunnelType: m.tunnelType,
          provider: m.provider,
          loginUrl: m.loginUrl,
          protocol: m.protocol,
          url: tun?.url ?? null,
          // proxy-mode records have no tunnel process — "running" means the
          // binding is enrolled (lazily starts its provider on first request).
          // For startTransport:false hosts (localUrl empty) this must be
          // binding-driven, not localUrl-driven (M0a-T3, 修 pi-web 宿主补丁).
          running: m.tunnelName
            ? (tun?.running ?? false)
            : proxy.bindings().some((b) => b.port === m.port && (b.label ?? "") === (m.label ?? "")),
          pid: tun?.pid ?? null,
          accessLog: logs?.access ?? null,
          errorLog: logs?.error ?? null,
          site: m.site,
          label: m.label,
          localUrl: m.localUrl,
          baseUrl: m.baseUrl,
          domainUrl: m.domainUrl,
          mode: m.mode ?? null,
          portmap: m.portmap ?? null,
          startedAt: m.startedAt ?? null,
        };
      }),
  };
}

/** Pre-assign a free local port. */
async function pickPort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

// helper: resolve tool via tools.ts (keeps the IIFE below minimal)
async function st_tools_ensure(name: string, toolOpts: ToolRegistryOptions): Promise<string> {
  const def = TOOLS[name];
  if (!def) throw new Error(`unknown tool: ${name}`);
  return ensureTool(def, toolOpts);
}

// lazy helper to avoid a circular import at module top
import { updateState as _updateState } from "./state.ts";
function require_state() {
  return { updateState: _updateState };
}
