import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type { AuthProvider, AuthProviderFactory, ProviderContext, UserManager } from "./auth-provider.ts";
import { isUserManager } from "./auth-provider.ts";
import { AutheliaProvider, type AutheliaProviderOptions } from "./authelia.ts";
import { BasicAuthProvider, type BasicAuthProviderOptions } from "./providers/basic.ts";
import { OAuth2ProxyProvider, type OAuth2ProxyProviderOptions } from "./providers/oauth2-proxy.ts";
import { PortalAuthProvider, type PortalAuthProviderOptions } from "./providers/portal.ts";
import type { ParamSpec } from "./tunnels.ts";

/**
 * Auth provider registry + plugin loading (design.md §5.3).
 *
 * Built-ins: authelia (default), basic. Plugins load from:
 *   1. authPlugins passed to createServiceTunnels,
 *   2. providers/*.js in configDir (ESM modules exporting a factory).
 * Each factory receives a ProviderContext; the registry exposes list() /
 * create() so expose() can pick providers by name.
 *
 * Site isolation (P1, sites-design.md §5.1): instances are cached per
 * `type#site`. The first create() for a site injects the site's storageDir
 * (cacheDir/tmp/sites/<site>/<type>) so every provider keeps its own user
 * db / htpasswd / sqlite — sites never share config or users. The default
 * site keeps the legacy paths (zero migration).
 */

export type AnyProviderOptions =
  | AutheliaProviderOptions
  | BasicAuthProviderOptions
  | OAuth2ProxyProviderOptions
  | PortalAuthProviderOptions
  | Record<string, unknown>;

export class AuthRegistry {
  #factories = new Map<string, AuthProviderFactory>();
  #ctx: ProviderContext;
  /** Cached singleton per `type#site` — one portal/authelia/basic process per
   *  SITE serves that site's hosts (registerHost adds hosts to the shared
   *  instance). Per-site storageDir keeps user dbs isolated. */
  #instances = new Map<string, AuthProvider>();

  constructor(ctx: ProviderContext, plugins: AuthProviderFactory[] = []) {
    this.#ctx = ctx;
    // built-ins
    this.#factories.set("authelia", (c, o) => new AutheliaProvider(c, (o ?? {}) as AutheliaProviderOptions));
    this.#factories.set("basic", (c, o) => new BasicAuthProvider(c, (o ?? {}) as BasicAuthProviderOptions));
    this.#factories.set("oauth2-proxy", (c, o) => new OAuth2ProxyProvider(c, (o ?? {}) as OAuth2ProxyProviderOptions));
    this.#factories.set("portal", (c, o) => new PortalAuthProvider(c, (o ?? {}) as PortalAuthProviderOptions));
    for (const f of plugins) {
      const probe = f(ctx, {});
      this.#factories.set(probe.type, f);
    }
  }

  /** Register an extra provider factory (idempotent by type). */
  register(factory: AuthProviderFactory): void {
    const probe = factory(this.#ctx, {});
    this.#factories.set(probe.type, factory);
  }

  unregister(type: string): void {
    this.#factories.delete(type);
  }

  list(): string[] {
    return [...this.#factories.keys()];
  }

  /** Provider types that support local user management (UserManager).
   *  Probes WITHOUT caching — create() caches singletons, so probing with
   *  empty opts would poison later expose() calls (oauth2-proxy would be
   *  cached without its oidc options, authelia without basePath, ...). */
  userManagers(): string[] {
    return [...this.#factories.keys()].filter((t) => {
      try {
        return isUserManager(this.#probeFactory(t));
      } catch {
        return false;
      }
    });
  }

  /** Provider types whose UserManager ALSO exposes TOTP 2FA management
   *  (totpEnroll/totpStatus/totpDisable) — e.g. portal. authelia has its own
   *  native TOTP but its enrollment needs authelia's elevation flow, so it is
   *  NOT advertised here. Clients show the 2FA UI only for these. */
  totpProviders(): string[] {
    return [...this.#factories.keys()].filter((t) => {
      try {
        const p = this.#probeFactory(t) as unknown as { totpEnroll?: unknown; totpStatus?: unknown };
        return typeof p.totpEnroll === "function" && typeof p.totpStatus === "function";
      } catch {
        return false;
      }
    });
  }

  /** Resolve a user-manager instance by type + site (errors for non-user
   *  providers). Reuses the cached singleton when one exists (so user changes
   *  restart the running provider); otherwise creates a THROWAWAY probe — never
   *  caching an empty-opts instance that would later starve expose() of its
   *  opts (policy/basePath/oidc...). */
  userManager(type: string, site = "default"): UserManager {
    const cached = this.#instances.get(this.#key(type, site));
    const p = cached ?? this.#probeFactory(type, site);
    if (!isUserManager(p)) throw new Error(`provider ${type} does not support user management`);
    return p;
  }

  /** Create an instance WITHOUT caching (probes / user ops before any expose). */
  #probeFactory(type: string, site = "default"): AuthProvider {
    const factory = this.#factories.get(type);
    if (!factory) throw new Error(`unknown auth provider: ${type} (available: ${this.list().join(", ")})`);
    return factory(this.#ctx, this.#siteOpts(type, site));
  }

  has(type: string): boolean {
    return this.#factories.has(type);
  }

  /** Create (or return the cached singleton) provider instance for a site. The
   *  FIRST call per `type#site` constructs it with `opts` (basePath/port/user);
   *  later calls reuse the same instance so all exposes of that site share one
   *  process and one user db. */
  create(type: string, opts: AnyProviderOptions = {}, site = "default"): AuthProvider {
    const key = this.#key(type, site);
    const cached = this.#instances.get(key);
    if (cached) return cached;
    const factory = this.#factories.get(type);
    if (!factory) throw new Error(`unknown auth provider: ${type} (available: ${this.list().join(", ")})`);
    const instance = factory(this.#ctx, { ...opts, ...this.#siteOpts(type, site) } as Record<string, unknown>);
    this.#instances.set(key, instance);
    return instance;
  }

  /** Whether any provider instance of this site is running (site status). */
  siteStatus(site: string): { running: boolean; port?: number } {
    for (const [key, p] of this.#instances) {
      if (key.endsWith(`#${site}`)) {
        try {
          const s = p.status();
          if (s.running) return { running: true, port: s.port };
        } catch {
          // instance may be a broken plugin — ignore
        }
      }
    }
    return { running: false };
  }

  /** Stop every cached provider instance (shutdown). Idempotent. */
  async stopAll(): Promise<void> {
    const seen = new Set<string>();
    for (const [, p] of this.#instances) {
      if (seen.has(p.type)) continue;
      seen.add(p.type);
      try {
        await p.stop();
      } catch {
        // best-effort per instance
      }
    }
    this.#instances.clear();
  }

  #key(type: string, site: string): string {
    return `${type}#${site || "default"}`;
  }

  /** Per-site opts: the site name, plus isolated storage dirs for NON-default
   *  sites (default keeps the legacy paths — zero migration). */
  #siteOpts(type: string, site: string): Record<string, unknown> {
    if (!site || site === "default") return { site: "default" };
    return {
      site,
      storageDir: join(this.#ctx.cacheDir, "tmp", "sites", site, type),
      dataDir: join(this.#ctx.cacheDir, "data", "sites", site, type),
    };
  }
}

/** Load plugin factories from configDir/providers/*.js (ESM). */
export async function loadProviderPlugins(configDir: string): Promise<AuthProviderFactory[]> {
  const dir = join(configDir, "providers");
  if (!existsSync(dir)) return [];
  const out: AuthProviderFactory[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;
    try {
      const mod = (await import(pathToFileURL(join(dir, entry)).href)) as {
        default?: AuthProviderFactory;
        factory?: AuthProviderFactory;
      };
      const factory = mod.default ?? mod.factory;
      if (typeof factory === "function") out.push(factory);
    } catch (err) {
      // a broken plugin must not break the whole registry
      console.error(`[service-tunnels] failed to load provider plugin ${entry}:`, (err as Error).message);
    }
  }
  return out;
}

/** Auth-provider parameter schemas (built-ins; plugins add their own via a
 *  `paramSchemas` module export). Drives the client expose form — adding a
 *  provider here needs no client code changes. */
export const AUTH_PARAM_SCHEMAS: Record<string, ParamSpec[]> = {
  authelia: [
    {
      key: "basePath",
      label: "Base 路径",
      description: "authelia 路径(仅字母数字,不能有连字符);默认随机",
      placeholder: "/authelia...",
    },
    {
      key: "policy",
      label: "策略",
      default: "one_factor",
      options: [
        { value: "one_factor", label: "单因素(仅密码)" },
        { value: "two_factor", label: "双因素(密码 + TOTP)" },
        { value: "deny", label: "拒绝全部" },
      ],
    },
  ],
  basic: [],
  portal: [
    {
      key: "basePath",
      label: "Base 路径",
      description: "登录页路径;默认随机(如 /portal-sneaky-capybara)",
      placeholder: "/portal-...",
    },
  ],
  "oauth2-proxy": [
    {
      key: "oidc.issuerUrl",
      label: "OIDC Issuer URL",
      required: true,
      placeholder: "https://accounts.example.com",
      link: "https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/",
      linkTitle: "oauth2-proxy 配置文档",
    },
    { key: "oidc.clientId", label: "Client ID", required: true },
    { key: "oidc.clientSecret", label: "Client Secret", type: "password", required: true },
    { key: "oidc.cookieSecret", label: "Cookie Secret", type: "password", description: "留空自动生成" },
  ],
};

/** Plugin module may export a param schema alongside its factory:
 *  `export const paramSchemas = { type: "myprov", specs: [...] }`. */
export interface AuthProviderParamSchemaExport {
  type: string;
  specs: ParamSpec[];
}

/** Built-in + plugin auth-provider param schemas (configDir plugins add). */
export async function authProviderSchemas(configDir: string): Promise<Record<string, ParamSpec[]>> {
  const out: Record<string, ParamSpec[]> = { ...AUTH_PARAM_SCHEMAS };
  const dir = join(configDir, "providers");
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;
    try {
      const mod = (await import(pathToFileURL(join(dir, entry)).href)) as {
        paramSchemas?: AuthProviderParamSchemaExport;
      };
      if (mod.paramSchemas && mod.paramSchemas.type && Array.isArray(mod.paramSchemas.specs)) {
        out[mod.paramSchemas.type] = mod.paramSchemas.specs;
      }
    } catch {
      // a broken plugin must not break schema enumeration
    }
  }
  return out;
}
