import type { Server } from "http";
import { createServer as netServer } from "net";
import { createProxyServer, DEFAULT_SUFFIXES, type ProxyAuth, type ProxySiteBackend } from "./proxy.ts";
import type { AuthRegistry } from "./auth-registry.ts";
import type { GatewayController } from "./gateway.ts";
import type { AuthPolicy, AuthProvider } from "./auth-provider.ts";

/**
 * ProxyManager — the shared proxy transport + enrollment registry (D4).
 *
 * One instance per owner (library process / daemon). Lazily starts the Node
 * wildcard-host proxy on a fixed port (default 4180, 0 = random) and serves
 * ONLY enrolled bindings:
 *
 *   binding = (port, label, site, provider?, policy?)
 *     label ""      → open vhost  `<port>.<suffix>`      (auth mode "none")
 *     label "auth"  → default site `<port>-auth.<suffix>`
 *     label <site>  → named site  `<port>-<site>.<suffix>`
 *
 * Request-time resolution (sites-design.md §5.2):
 *   - open vhost  → binding exists ? direct : 403 (not enrolled)
 *   - labeled vhost → binding exists ? auth backend : 403; the backend is
 *     resolved LAZILY (first request starts the provider / registers the
 *     virtual host with it; basic → nginx gateway with auth_basic).
 *
 * P2 note: providers are the registry's per-type singleton (default site) —
 * per-site isolation (storageDir / type#site) lands in P1.
 */

export interface ProxyBinding {
  /** App port behind the vhost. */
  port: number;
  /** "" = open form; else the dash label (e.g. "portal", "pi-web", "auth"). */
  label: string;
  /** Site name the binding belongs to ("default" for the reserved auth label). */
  site: string;
  /** Provider type (portal/authelia/basic/oauth2-proxy/...); "" for open. */
  provider: string;
  policy?: AuthPolicy;
  /** Extra provider options (schema-driven form params, dotted keys nested). */
  providerParams?: Record<string, unknown>;
}

export interface ProxyManagerOptions {
  /** Accepted virtual-host suffixes (default DEFAULT_SUFFIXES). */
  suffixes?: string[];
  /**
   * User's wildcard-DNS base domain (e.g. "pi.example.com"): an ADDITIONAL
   * portless address `<port>[-<label>].<baseDomain>` is served (and returned
   * as baseUrl). The user reverse-proxies *.<baseDomain> to the proxy port.
   * Multi-domain form: first entry is the primary (returned as baseUrl); the
   * rest are served as extra suffixes (env SERVICE_TUNNELS_BASE_DOMAIN).
   */
  baseDomain?: string;
  /** Extra base domains (env SERVICE_TUNNELS_BASE_DOMAIN, comma-separated). */
  baseDomains?: string[];
  /** Strip this base path before forwarding. */
  basePath?: string;
  /** Optional Basic password gate for OPEN vhosts. */
  password?: string;
  /** Allow-list source (discovery). Default: allow all (caller must gate). */
  isPortAllowed?: (port: number) => boolean;
  /** Auth provider registry (lazy provider starts). */
  registry?: AuthRegistry;
  /** Shared nginx gateway (basic backends); created lazily when omitted. */
  gateway?: GatewayController;
  /** Register the proxy transport port as a framework helper (discovery exclusion). */
  registerInternal?: (role: string, port: number) => void;
  /** Registered site names (label → site). P1: live getter over sites.json. */
  getSites?: () => Record<string, unknown>;
  /** Persistence hook: called after every binding add/remove (state.json). */
  onChange?: () => void;
  log?: (line: string) => void;
}

export interface ProxyManagerStatus {
  running: boolean;
  port: number;
  bindings: ProxyBinding[];
}

/** Local login-redirect template for the given provider (local http scheme). */
export function localLoginRedirect(provider: string, basePath: string): string {
  const p = basePath.replace(/\/+$/, "") || "";
  if (provider === "authelia") return `http://$host${p}/?rd=http://$host$request_uri`;
  if (provider === "oauth2-proxy") return `http://$host/oauth2/start?rd=$request_uri`;
  return `http://$host${p}/login?next=$request_uri`; // portal & forward-auth defaults
}

export class ProxyManager {
  #opts: ProxyManagerOptions;
  #server: Server | null = null;
  #port = 0;
  #baseDomain = "";
  /** All base domains (primary first): config/CLI + env. */
  #baseDomains: string[] = [];
  #bindings = new Map<string, ProxyBinding>(); // key `${port}:${label}`
  /** Vhosts already registered with their provider/gateway (avoid re-register).
   *  Key `${port}:${label}:${vhost}` — one binding may serve multiple hosts
   *  (default localhost + base domain), each needs its own provider/gateway
   *  registration (authelia cookie domains are per host). */
  #registered = new Set<string>();
  #gateway: GatewayController | null;

  constructor(opts: ProxyManagerOptions = {}) {
    this.#opts = opts;
    this.#gateway = opts.gateway ?? null;
    this.#baseDomain = (opts.baseDomain ?? "").replace(/^\./, "");
    this.#baseDomains = [
      ...(this.#baseDomain ? [this.#baseDomain] : []),
      ...(opts.baseDomains ?? []).map((d) => d.replace(/^\./, "")).filter((d) => d && d !== this.#baseDomain),
    ];
  }

  get port(): number {
    return this.#port;
  }

  status(): ProxyManagerStatus {
    return { running: this.#server !== null, port: this.#port, bindings: this.bindings() };
  }

  bindings(): ProxyBinding[] {
    return [...this.#bindings.values()];
  }

  binding(port: number, label: string): ProxyBinding | undefined {
    return this.#bindings.get(`${port}:${label}`);
  }

  addBinding(b: ProxyBinding): void {
    this.#bindings.set(`${b.port}:${b.label}`, b);
    this.#opts.log?.(`proxy: enrolled ${b.port}${b.label ? `-${b.label}` : ""} → site ${b.site} (${b.provider || "open"})`);
    this.#opts.onChange?.();
  }

  removeBinding(port: number, label: string): void {
    this.#bindings.delete(`${port}:${label}`);
    for (const key of [...this.#registered]) {
      if (key.startsWith(`${port}:${label}:`)) this.#registered.delete(key);
    }
    this.#opts.onChange?.();
  }

  /** Restore persisted bindings (daemon restart). */
  restore(bindings: ProxyBinding[]): void {
    for (const b of bindings) {
      if (b && typeof b.port === "number" && typeof b.site === "string") {
        const label = typeof b.label === "string" ? b.label : "";
        this.#bindings.set(`${b.port}:${label}`, { ...b, label });
      }
    }
  }

  /** Persisted snapshot (state.json bindings). */
  persisted(): ProxyBinding[] {
    return this.bindings();
  }

  /** Any binding for the port (open or labeled)? Used as the allow-list when
   *  the transport can't see the caller's process tree (daemon mode). */
  hasBindingForPort(port: number): boolean {
    for (const key of this.#bindings.keys()) {
      if (key.startsWith(`${port}:`)) return true;
    }
    return false;
  }

  /** Default virtual-host suffix (without leading dot). */
  get #suffix(): string {
    return (this.#opts.suffixes?.[0] ?? DEFAULT_SUFFIXES[0] ?? ".st.localhost").replace(/^\./, "");
  }

  get baseDomain(): string {
    return this.#baseDomain;
  }

  /** All base domains, primary first (empty when unset). */
  get baseDomains(): string[] {
    return [...this.#baseDomains];
  }

  /** All accepted suffixes (default + base domains + registered site domains). */
  get #allSuffixes(): string[] {
    const out = [...(this.#opts.suffixes ?? DEFAULT_SUFFIXES)];
    for (const d of this.#baseDomains) {
      if (d && !out.includes(`.${d}`)) out.push(`.${d}`);
    }
    const sites = this.#opts.getSites?.() ?? {};
    for (const cfg of Object.values(sites)) {
      const domain = (cfg as { domain?: string } | undefined)?.domain;
      if (domain && !out.includes(`.${domain}`)) out.push(`.${domain}`);
    }
    return out;
  }

  /** Update the base domains; restarts the transport when the suffix list
   *  changes while running (new host pattern must be accepted). */
  async setBaseDomain(domain: string | string[] | undefined): Promise<void> {
    const list = Array.isArray(domain)
      ? domain.map((d) => d.replace(/^\./, "")).filter(Boolean)
      : (domain ?? "").replace(/^\./, "") ? [(domain ?? "").replace(/^\./, "")] : [];
    const prev = [...this.#baseDomains];
    this.#baseDomain = list[0] ?? "";
    this.#baseDomains = list;
    const changed = JSON.stringify(prev) !== JSON.stringify(list);
    const wasRunning = this.#server !== null;
    if (changed && wasRunning) {
      await this.stop();
      await this.start();
    }
  }

  /** The virtual host a binding is served on (default localhost suffix). */
  vhost(port: number, label: string): string {
    return label ? `${port}-${label}.${this.#suffix}` : `${port}.${this.#suffix}`;
  }

  /** Portless virtual host under the user's base domain ("" when unset). */
  baseVhost(port: number, label: string): string {
    if (!this.#baseDomain) return "";
    return label ? `${port}-${label}.${this.#baseDomain}` : `${port}.${this.#baseDomain}`;
  }

  /** Idempotent start. Default port 4180 (busy → random); explicit 0 = random;
   *  any other explicit port errors on conflict. */
  async start(port?: number): Promise<number> {
    if (this.#server) return this.#port;
    const wanted = port ?? 4180;
    const listenPort =
      wanted === 0
        ? await pickFreePort()
        : wanted === 4180 && (await tcpOpen(4180))
          ? await pickFreePort()
          : wanted;
    const server = createProxyServer({
      port: listenPort,
      suffixes: this.#allSuffixes,
      basePath: this.#opts.basePath,
      password: this.#opts.password,
      isPortAllowed: this.#opts.isPortAllowed,
      resolveLabel: (label) => this.#resolveLabel(label),
      resolveSuffixSite: (suffix) => this.#resolveSuffixSite(suffix),
      resolveSite: (p, site, label, vhost) => this.#resolveSite(p, site, label, vhost),
      log: this.#opts.log ?? (() => {}),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    this.#server = server;
    const addr = server.address();
    this.#port = typeof addr === "object" && addr ? addr.port : listenPort;
    this.#opts.registerInternal?.("proxy", this.#port);
    this.#opts.log?.(`proxy transport on 127.0.0.1:${this.#port}`);
    return this.#port;
  }

  async stop(): Promise<void> {
    if (!this.#server) return;
    const s = this.#server;
    this.#server = null;
    await new Promise<void>((resolve) => {
      s.closeAllConnections?.();
      s.close(() => resolve());
    });
  }

  // ── label → site ──────────────────────────────────────────────────────────
  /** "auth" = default site (reserved); registered site names; provider types
   *  (explicit provider without --site → vhost label = provider name, but the
   *  auth realm is the DEFAULT site, matching `auth user *` defaults);
   *  anything else → unknown label (403). */
  #resolveLabel(label: string): string | null {
    if (label === "auth") return "default";
    const sites = this.#opts.getSites?.() ?? {};
    if (Object.prototype.hasOwnProperty.call(sites, label)) return label;
    const types = this.#opts.registry?.list() ?? [];
    if (types.includes(label)) return "default";
    return null;
  }

  /** Suffix → site: a virtual host under a site's `domain` implies that site
   *  (`<port>.<site-domain>` → site, auth follows site.auth). */
  #resolveSuffixSite(suffix: string): string | null {
    const sites = this.#opts.getSites?.() ?? {};
    for (const [name, cfg] of Object.entries(sites)) {
      const domain = (cfg as { domain?: string } | undefined)?.domain;
      if (domain && domain.replace(/^\./, "").toLowerCase() === suffix) return name;
    }
    return null;
  }

  // ── enrollment + backend resolution (D4) ──────────────────────────────────
  async #resolveSite(
    port: number,
    site: string | undefined,
    label: string | undefined,
    vhost: string,
  ): Promise<ProxySiteBackend | null> {
    const log = this.#opts.log ?? (() => {});
    if (site === undefined) {
      // open form: needs an open binding
      return this.#bindings.has(`${port}:`) ? {} : null;
    }
    const binding = label !== undefined
      ? this.#bindings.get(`${port}:${label}`)
      : this.#findBySite(port, site);
    if (!binding || binding.site !== site) return null;
    // registration is PER HOST: one binding serves both the default localhost
    // vhost and the base-domain vhost, and authelia cookie domains / nginx
    // server blocks are per host.
    const key = `${port}:${label}:${vhost}`;
    try {
      if (binding.provider === "basic") {
        const gw = await this.#ensureGateway();
        if (!this.#registered.has(key)) {
          const basicProvider = this.#opts.registry?.create("basic", { ...(binding.providerParams ?? {}) }, binding.site) as
            unknown as { htpasswdFile?: string } | undefined;
          const htpasswd = basicProvider?.htpasswdFile;
          await gw.registerHost(vhost, binding.port, { authMode: "basic", htpasswdFile: htpasswd, scheme: "http" });
          this.#registered.add(key);
        }
        return { basicGatewayPort: gw.port };
      }
      const provider = await this.#ensureProvider(binding);
      if (!this.#registered.has(key)) {
        await provider.registerHost(vhost, binding.policy);
        this.#registered.add(key);
      }
      const authPort = (provider as unknown as { port?: number }).port ?? 0;
      const basePath = (provider as unknown as { basePath?: string }).basePath ?? "";
      const fw: ProxyAuth = {
        port: authPort,
        basePath,
        loginRedirect: localLoginRedirect(binding.provider, basePath),
      };
      return { forwardAuth: fw };
    } catch (err) {
      log(`proxy: backend for ${vhost} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Find the binding for (port, site) when no label is present (site-domain
   *  vhost form: `<port>.<site-domain>`). */
  #findBySite(port: number, site: string): ProxyBinding | undefined {
    for (const b of this.#bindings.values()) {
      if (b.port === port && b.site === site) return b;
    }
    return undefined;
  }

  /** Provider instance for the binding's site (per-site isolation, P1). */
  async #ensureProvider(binding: ProxyBinding): Promise<AuthProvider> {
    const registry = this.#opts.registry;
    if (!registry) throw new Error("proxy: no auth registry wired");
    const provider = registry.create(binding.provider, { ...(binding.providerParams ?? {}) }, binding.site);
    if (!provider.status().running) {
      const problems = (await provider.validate?.()) ?? [];
      if (problems.length) throw new Error(problems.join("; "));
      await provider.start();
    }
    return provider;
  }

  /** Shared nginx gateway for basic backends (created lazily when absent). */
  async #ensureGateway(): Promise<GatewayController> {
    if (this.#gateway) {
      if (!(await gatewayReady(this.#gateway))) await this.#gateway.start("basic");
      return this.#gateway;
    }
    const { GatewayController } = await import("./gateway.ts");
    const gw = new GatewayController({
      configDir: "", // unused by gateway internals beyond logs/nginxRoot
      cacheDir: (this.#opts as { cacheDir?: string }).cacheDir ?? "/tmp",
      registerInternal: this.#opts.registerInternal ?? (() => {}),
      unregisterInternal: () => {},
      log: this.#opts.log ?? (() => {}),
    });
    this.#gateway = gw;
    await gw.start("basic");
    return gw;
  }
}

async function gatewayReady(gw: GatewayController): Promise<boolean> {
  try {
    return await gw.ready();
  } catch {
    return false;
  }
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netServer();
    s.once("error", () => resolve(true)); // in use
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(false));
    });
  });
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}
