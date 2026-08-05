import { GatewayController, type GatewayAuthMode, detectProtocol } from "./gateway.ts";
import { ProxyManager } from "./proxy-manager.ts";
import { readSites, type SiteConfig } from "./sites.ts";
import { readConfigFile, resolveBaseDomains } from "./config.ts";
import { RedisController } from "./redis.ts";
import type { AuthProvider, ProviderContext } from "./auth-provider.ts";
import { AuthRegistry } from "./auth-registry.ts";
import { tunnelSupportsTcp } from "./tunnels.ts";
import type { TunnelManager } from "./tunnels.ts";
import { InternalRegistry } from "./internal.ts";
import { platform } from "os";

/** Default auth provider by platform. */
function getDefaultAuthProvider(): string {
  // Windows: portal (Node-based, no external binaries)
  // Linux/macOS: authelia (full-featured with 2FA)
  if (platform() === "win32") return "portal";
  return "authelia";
}

/** "oidc.issuerUrl" → { oidc: { issuerUrl } } — schema-driven form params
 *  arrive flat; provider options are nested. */
function unflattenParams(params: Record<string, unknown>): Record<string, unknown> {
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
      cur[parts[parts.length - 1]!] = value;
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

export interface ExposeOptions {
  port: number;
  /** Exposure mode (sites-design.md §4): "tunnel" (default, existing),
   *  "proxy" (local virtual host only, NO tunnel process), "both" (local
   *  vhost + public tunnel sharing one site). */
  mode?: "tunnel" | "proxy" | "both";
  /** @internal set by the dispatcher: whether the caller explicitly passed
   *  --site (distinguishes `--site default` from no --site — the former keeps
   *  the reserved "auth" label, the latter carries the provider name). */
  siteExplicit?: boolean;
  /** Auth realm (site) for mode proxy/both. Default "default" (vhost label
   *  "auth"); an explicit provider without --site stays on the DEFAULT realm
   *  with a provider-name vhost label (D3: `5173-basic` = basic on default). */
  site?: string;
  /** Proxy transport port for mode proxy/both (default 4180, busy → random). */
  proxyPort?: number;
  /**
   * User's wildcard-DNS base domain (e.g. "pi.example.com") — overrides
   * config service-tunnels.json `baseDomain`. expose also returns a PORTLESS
   * base URL `<port>[-<label>].<baseDomain>` (user reverse-proxies it).
   */
  baseDomain?: string;
  /** true = gateway auth (default provider), false = no auth, "auto" = pick
   *  the best available provider (authelia > portal > basic). */
  auth?: boolean | "auto" | string;
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
  /** Allow on-demand tool downloads for THIS expose (param > env > config
   *  fallback > default true). When false, missing tools error instead of
   *  downloading. */
  allowToolDownload?: boolean;
  /** Extra tunnel config fields (schema-driven form): keys are TunnelConfig
   *  fields (domain/server/token/host/user/port/remotePort/cmd/...). Applied
   *  BEFORE name/type/target/env so those can't be overridden. */
  tunnelParams?: Record<string, unknown>;
  /** Extra auth-provider options (schema-driven form). Dot keys nest
   *  ("oidc.issuerUrl" → { oidc: { issuerUrl } }). */
  providerParams?: Record<string, unknown>;
  /** When true, skip the port ownership check (allow tunneling other users' ports). */
  force?: boolean;
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
  /** Mode used ("tunnel" | "proxy" | "both"). */
  mode?: "tunnel" | "proxy" | "both";
  /** Site (auth realm) the expose belongs to; "" for open bindings. */
  site?: string;
  /** Vhost dash label ("auth" for the default site, site name otherwise,
   *  "" for open). */
  label?: string;
  /** Local virtual-host URL (mode proxy/both), e.g.
   *  http://5173-portal.st.localhost:4180. */
  localUrl?: string;
  /** Portless URL under the user's base domain (mode proxy/both, when
   *  baseDomain is configured), e.g. http://5173-portal.pi.example.com. */
  baseUrl?: string;
  /** Portless URL under the site's OWN domain (`<port>.<site-domain>`, when
   *  the site has a domain), e.g. http://5173.web.pi.example.com. */
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
export async function expose(port: number, opts: ExposeOptions, ctx: ExposeContext): Promise<ExposeResult> {
  const mode = opts.mode ?? "tunnel";
  if (opts.protocol === "tcp" && mode !== "tunnel") {
    return { url: null, tunnel: "", protocol: "tcp", error: "protocol tcp requires --mode tunnel" };
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
  const proxyResult = mode === "both" ? await proxyExpose(port, opts2, ctx, siteCfg) : null;
  const result = await exposeTunnel(port, opts2, ctx, siteCfg);
  return proxyResult
    ? { ...result, mode: "both", site: proxyResult.site, label: proxyResult.label, localUrl: proxyResult.localUrl }
    : result;
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
  const cfgFile = readConfigFile(ctx.configDir);
  const proxy = ctx.proxy ?? new ProxyManager({
    registerInternal: (role, p) => ctx.internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
    log,
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
  const providerType = opts.provider
    ?? siteCfg?.provider
    ?? (opts.auth === "auto"
      ? getDefaultAuthProvider()
      : typeof opts.auth === "string" && opts.auth !== "none" ? opts.auth : "portal");
  const site = authRequested ? (opts.site ?? "default") : "";
  // D3: default-site vhosts carry the explicit provider name as the label
  // (`5173-basic` = basic auth on the DEFAULT site — same user db as
  // `auth user add --provider basic`); bare `--auth`/`--auth auto` keeps the
  // reserved "auth" label; named sites label with the site name; an explicit
  // `--site default` also keeps "auth".
  const explicitProvider = Boolean(opts.provider) ||
    (typeof opts.auth === "string" && opts.auth !== "none" && opts.auth !== "auto");
  const label = site === ""
    ? ""
    : opts.siteExplicit
      ? (site === "default" ? "auth" : site)
      : (explicitProvider ? providerType : "auth");

  if (authRequested) {
    const pctx = providerCtx(ctx);
    const registry = ctx.auth ?? new AuthRegistry(pctx);
    const basePath = opts.basePath
      ?? siteCfg?.basePath
      ?? (providerType === "basic" ? "" : (cfgFile.basePathByProvider?.[providerType] ?? cfgFile.basePath))
      ?? defaultBasePath(providerType);
    // Merge the embedder's deployment base path (pi-web /dev) under the
    // provider's own base path: /dev + /portal → /dev/portal — login pages,
    // authz probes and redirects all live under the combined path.
    const mergedBasePath = providerType === "basic"
      ? ""
      : sanitizeBasePath(`${(proxy.basePath ?? "").replace(/\/+$/, "")}${basePath}`);
    const provider = registry.create(
      providerType,
      {
        ...unflattenParams(opts.providerParams ?? {}),
        ...(siteCfg?.providerParams ?? {}),
        basePath: providerType === "basic" ? "" : mergedBasePath,
        policy: opts.policy ?? siteCfg?.policy,
        user: opts.user ?? (siteCfg?.user ? { name: siteCfg.user.name, password: randomSecret() } : undefined),
        sessionSecret: opts.sessionSecret,
        externalReloadCmd: opts.autheliaReloadCmd,
      },
      site,
    );
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
    log(`expose ${port} (proxy): provider ${providerType} up (site ${site})`);
  }

  const transportPort = await proxy.start(opts.proxyPort);
  proxy.addBinding({
    port,
    label,
    site: site || "default",
    provider: authRequested ? providerType : "",
    policy: opts.policy ? { policy: opts.policy } : undefined,
    providerParams: { ...(siteCfg?.providerParams ?? {}), ...(opts.providerParams ?? {}) },
  });
  const localUrl = `http://${proxy.vhost(port, label)}:${transportPort}`;
  const baseVhost = proxy.baseVhost(port, label);
  const baseUrl = baseVhost ? `http://${baseVhost}` : undefined;
  const domainUrl = siteCfg?.domain ? `http://${port}.${siteCfg.domain.replace(/^\./, "")}` : undefined;
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
  
  const providerType = opts.provider ?? siteCfg?.provider ?? (opts.auth === "auto" ? getDefaultAuthProvider() : "authelia");
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

  if (opts.protocol === "tcp") {
    // raw TCP — NO nginx gateway (nginx is HTTP-only), NO auth: tunnel
    // straight to the app port. Only TCP-capable tunnel types allowed.
    const tunnelType = (opts.tunnelType as never) ?? "ngrok";
    if (!tunnelSupportsTcp(tunnelType)) {
      return { url: null, tunnel: "", error: `tunnel type "${tunnelType}" does not support tcp forwarding (use ngrok/ssh/frpc)` };
    }
    const name = opts.tunnelName ?? `expose-${port}-tcp`;
    await ctx.tunnels.stop(name);
    await ctx.onTunnelStop?.(name);
    ctx.tunnels.add({
      ...(opts.tunnelParams ?? {}),
      name,
      type: (opts.tunnelType as never) ?? "ngrok",
      target: port,
      protocol: "tcp",
      env: tunnelEnv,
    });
    await ctx.tunnels.start(name);
    const url = await waitForUrl(ctx.tunnels, name, 30_000);
    return { url, tunnel: name, protocol, ...(url ? {} : tunnelFailure(ctx.tunnels, name)) };
  }

  if (!useAuth) {
    // "none" auth — route through the shared nginx gateway TOO (like basic but
    // with no auth), so access/error logs are recorded for every expose. The
    // only difference from basic is the absence of auth directives.
    const name = opts.tunnelName ?? `expose-${port}`;
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
        await gateway.registerHost(host, port, { authMode: "none", scheme });
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
  // service-tunnels.json (basePath / basePathByProvider) > per-expose random
  // name so nginx (auth_request) and the provider agree AND generic paths
  // (/{provider}) never collide with app routes (portal → /portal-sneaky-capybara).
  const cfgFile = readConfigFile(ctx.configDir);
  const initialBasePath = opts.basePath
    ?? siteCfg?.basePath
    ?? (providerType === "basic" ? "" : (cfgFile.basePathByProvider?.[providerType] ?? cfgFile.basePath))
    ?? defaultBasePath(providerType);
  // basePath is interpolated into nginx locations + 302 redirects + authelia's
  // server.address — allow a plain URL path only (no ; {} whitespace quotes
  // which would inject nginx directives or break the config).
  const basePath = providerType === "basic" ? "" : sanitizeBasePath(initialBasePath);
  const provider: AuthProvider = registry.create(
    providerType,
    {
      ...unflattenParams(opts.providerParams ?? {}),
      ...(siteCfg?.providerParams ?? {}),
      port: opts.autheliaPort,
      basePath,
      sessionSecret: opts.sessionSecret,
      policy: opts.policy ?? siteCfg?.policy,
      user: opts.user ?? (siteCfg?.user ? { name: siteCfg.user.name, password: randomSecret() } : undefined),
      externalReloadCmd: opts.autheliaReloadCmd,
    },
    site,
  );
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
    const name = opts.tunnelName ?? `expose-${port}`;
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
    return { url, tunnel: name, provider: providerType, protocol, ...(url ? {} : tunnelFailure(ctx.tunnels, name)) };
  }

  const nginxPort = opts.nginxPort ?? 0; // 0 = random
  const authMode: GatewayAuthMode = provider.type === "basic" ? "basic" : "forward-auth";
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
  const authPort = (provider as unknown as { port?: number }).port ?? 9091;
  // start the shared gateway once (auth backend is per-host now)
  const gatewayPort = await gateway.start(authMode);

  // tunnel pointing at the gateway
  const name = opts.tunnelName ?? `expose-${port}`;
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
    // provider-specific login redirect target (nginx vars $host/$request_uri):
    //  - portal:  /<basePath>/login?next=<path>   (portal's `next` param)
    //  - authelia: /<basePath>/?rd=https://$host$request_uri  (authelia's `rd`
    //             param + portal root — NOT /login, which isn't authelia's entry)
    const loginRedirect = providerType === "authelia"
      ? `https://$host${providerBasePath}/?rd=https://$host$request_uri`
      : `https://$host${providerBasePath}/login?next=$request_uri`;
    const scheme = protocol === "https" ? "https" : "http";
    try {
      await gateway.registerHost(publicHost, port, { authPort, basePath: providerBasePath, authMode, htpasswdFile, loginRedirect, scheme });
    } catch (err) {
      // unsafe host — tear down the tunnel so nothing is left half-registered
      await ctx.tunnels.stop(name).catch(() => {});
      await ctx.onTunnelStop?.(name);
      return { url: null, tunnel: name, provider: providerType, protocol, error: `tunnel URL host rejected: ${err instanceof Error ? err.message : String(err)}` };
    }
    await provider.registerHost(publicHost, { policy: opts.policy });
    log(`expose ${port}: ${url} (auth via ${providerType}, host ${publicHost} registered, scheme ${scheme})`);
  }

  return {
    url,
    tunnel: name,
    provider: providerType,
    protocol,
    loginUrl: url && basePath ? `${url}${basePath}/login` : undefined,
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

export function defaultBasePath(providerType: string): string {  if (providerType === "basic") return "";
  if (providerType === "portal") {
    // memorable random name avoids clashing with app routes
    return `/${providerType}-${randomName()}`;
  }
  if (providerType === "authelia") {
    // authelia's server.address path allows ONLY [a-z0-9] — no dashes
    return `/${providerType}${randomAlnum(8)}`;
  }
  // oauth2-proxy has its own fixed /oauth2 endpoints wired by the gateway
  return `/${providerType}`;
}

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomAlnum(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return out;
}

/** Random secret for bootstrap users without an explicit password. */
function randomSecret(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const BASE_ADJECTIVES = [
  "fuzzy", "wobbly", "sneaky", "cosmic", "jolly", "mellow", "zippy", "quirky",
  "lucky", "crimson", "brisk", "witty", "dizzy", "spicy", "frosty", "peachy",
  "snazzy", "twisty", "velvet", "bouncy",
];
const BASE_ANIMALS = [
  "narwhal", "wombat", "capybara", "platypus", "axolotl", "llama", "gecko",
  "badger", "otter", "moose", "panda", "raccoon", "sloth", "tapir", "lemur",
  "ferret", "ibex", "kitten", "puffin", "dragon",
];

export function randomName(): string {
  const a = BASE_ADJECTIVES[Math.floor(Math.random() * BASE_ADJECTIVES.length)]!;
  const n = BASE_ANIMALS[Math.floor(Math.random() * BASE_ANIMALS.length)]!;
  return `${a}-${n}`;
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
