import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type { AuthProvider, AuthProviderFactory, ProviderContext, UserManager, TokenManager } from "./auth-provider.ts";
import { isUserManager, isTokenManager, isBiometricManager } from "./auth-provider.ts";
import { AutheliaProvider, type AutheliaProviderOptions } from "./authelia.ts";
import { BasicAuthProvider, type BasicAuthProviderOptions } from "./providers/basic.ts";
import { TokenAuthProvider, type TokenAuthProviderOptions } from "./providers/token.ts";
import { OAuth2ProxyProvider, type OAuth2ProxyProviderOptions } from "./providers/oauth2-proxy.ts";
import { PortalAuthProvider, type PortalAuthProviderOptions } from "./providers/portal.ts";
import {
  allOAuth2Variants,
  oauth2VariantParamSchemas,
} from "./providers/oauth2-variants.ts";
import type { ParamSpec } from "./tunnels.ts";
import { withSchemaI18nKeys } from "./i18n.ts";

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
  | TokenAuthProviderOptions
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
    this.#factories.set("token", (c, o) => new TokenAuthProvider(c, (o ?? {}) as TokenAuthProviderOptions));
    this.#factories.set("oauth2-proxy", (c, o) => new OAuth2ProxyProvider(c, (o ?? {}) as OAuth2ProxyProviderOptions));
    this.#factories.set("portal", (c, o) => new PortalAuthProvider(c, (o ?? {}) as PortalAuthProviderOptions));
    // oauth2 变体（声明式注册，docs/oauth2-variants.md）：内置表 + 环境变量
    // 注册（SERVICE_TUNNELS_OAUTH2_VARIANT_*，类似 command 隧道）。每个变体
    // 一个独立 type#site 实例 = 独立侧车端口/配置（oauth2-github#site ≠
    // oauth2-google#site）。
    for (const v of allOAuth2Variants()) {
      this.#factories.set(v.id, (c, o) =>
        new OAuth2ProxyProvider(c, { ...(o ?? {}), variant: v.id } as OAuth2ProxyProviderOptions),
      );
    }
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

  /** Provider types supporting biometric 2FA management (biometricEnrollFace…)
   *  — e.g. portal (P1: face; voice P2). Clients show biometric UI only for
   *  these. */
  biometricProviders(): string[] {
    return [...this.#factories.keys()].filter((t) => {
      try {
        return isBiometricManager(this.#probeFactory(t));
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

  /** Provider types that support local token management (TokenManager).
   *  Probes WITHOUT caching (same rationale as userManagers). */
  tokenManagers(): string[] {
    return [...this.#factories.keys()].filter((t) => {
      try {
        return isTokenManager(this.#probeFactory(t));
      } catch {
        return false;
      }
    });
  }

  /** Resolve a token-manager instance by type + site (errors for non-token
   *  providers). Same cached/probe semantics as userManager(). */
  tokenManager(type: string, site = "default"): TokenManager {
    const cached = this.#instances.get(this.#key(type, site));
    const p = cached ?? this.#probeFactory(type, site);
    if (!isTokenManager(p)) throw new Error(`provider ${type} does not support token management`);
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
/** Schema contract version — bump only on BREAKING shape changes; additive
 *  fields keep the version (clients tolerate unknown fields). */
export const AUTH_SCHEMAS_VERSION = 1;

export const AUTH_PARAM_SCHEMAS: Record<string, ParamSpec[]> = {
  authelia: [
    {
      key: "basePath",
      label: "Base path",
      description: "Authelia path (alphanumeric only, no hyphens); random by default",
      placeholder: "/authelia...",
    },
    {
      key: "policy",
      label: "Policy",
      default: "one_factor",
      options: [
        { value: "one_factor", label: "One factor (password only)" },
        { value: "two_factor", label: "Two factors (password + TOTP)" },
        { value: "deny", label: "Deny all" },
      ],
    },
  ],
  basic: [],
  token: [],
  portal: [
    {
      key: "basePath",
      label: "Base path",
      description: "Login page path; random by default (e.g. /portal-sneaky-capybara)",
      placeholder: "/portal-...",
    },
    {
      key: "sessionTtlDays",
      label: "Session TTL (days)",
      type: "number",
      default: 7,
      description: "Session lifetime without \"remember me\"",
    },
    {
      key: "rememberMeTtlDays",
      label: "Remember-me TTL (days)",
      type: "number",
      default: 365,
      description: "Session lifetime when \"remember me\" is checked (full 2FA still required first)",
    },
    {
      key: "twoFactorGraceDays",
      label: "2FA re-verify grace (days)",
      type: "number",
      default: 52,
      description: "Within the grace period the 2FA step is skipped; after it expires, re-verify skips only the password (min 1 day, default rememberTtl/7)",
    },
    {
      key: "biometrics",
      label: "Face/Voice 2FA",
      type: "boolean",
      default: false,
      description: "Enable face/voice 2FA (face downloads ~8.4MB browser assets on first start; enrollment via portal /enroll page)",
    },
    {
      key: "biometricThresholds.face",
      label: "Face match threshold",
      type: "number",
      default: 0.6,
      description: "Max L2 distance (lower = stricter; 0.6 = dlib/face-api recommended)",
    },
    {
      key: "biometricThresholds.voice",
      label: "Voice match threshold",
      type: "number",
      default: 0.9,
      description: "Min cosine similarity (higher = stricter; MFCC 78-d vector)",
    },
  ],
  "oauth2-proxy": [
    {
      key: "provider",
      label: "Provider",
      default: "oidc",
      placeholder: "oidc",
      description: "oauth2-proxy provider 名：oidc（通用 OIDC，默认）/ github / google / gitlab / azure / keycloak-oidc / facebook 等；常用 IdP 可直接选上方预设变体（自动带 scope/端点预设）",
    },
    {
      key: "oidc.issuerUrl",
      label: "OIDC Issuer URL",
      required: true,
      placeholder: "https://accounts.example.com",
      link: "https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/",
      linkTitle: "oauth2-proxy config docs",
    },
    { key: "oidc.clientId", label: "Client ID", required: true },
    { key: "oidc.clientSecret", label: "Client Secret", type: "password", required: true },
    { key: "oidc.cookieSecret", label: "Cookie Secret", type: "password", description: "Leave empty to auto-generate" },
  ],
};

/** Plugin module may export a param schema alongside its factory:
 *  `export const paramSchemas = { type: "myprov", specs: [...] }`. */
export interface AuthProviderParamSchemaExport {
  type: string;
  specs: ParamSpec[];
}

/** Built-in + plugin auth-provider param schemas (configDir plugins add;
 *  oauth2 变体 schema 依赖配置档凭据携带状态——已携带的字段默认填入). */
export async function authProviderSchemas(configDir: string): Promise<Record<string, ParamSpec[]>> {
  const out: Record<string, ParamSpec[]> = { ...AUTH_PARAM_SCHEMAS };
  // 变体 schema（数据驱动；配置档携带的必填凭据不在表单出现）
  for (const [type, specs] of Object.entries(oauth2VariantParamSchemas(configDir))) {
    out[type] = specs;
  }
  const dir = join(configDir, "providers");
  if (existsSync(dir)) {
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
  }
  // 注入稳定翻译 id（多语:调用方按 id 翻译,未命中回退内置中文）
  return Object.fromEntries(
    Object.entries(out).map(([type, specs]) => [type, withSchemaI18nKeys("auth", type, specs)]),
  );
}

/** Provider 页面元数据（label / 已配置状态 / 待填项）——客户端 picker 与
 *  「✓已配置」徽标据此渲染（oauth2 变体 + 内置类型）。插件 provider 缺省
 *  label = type（客户端兜底）。 */
export { authProviderMetas } from "./providers/oauth2-variants.ts";
