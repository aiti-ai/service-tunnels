import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type { AuthProvider, AuthProviderFactory, ProviderContext } from "./auth-provider.ts";
import { AutheliaProvider, type AutheliaProviderOptions } from "./authelia.ts";
import { BasicAuthProvider, type BasicAuthProviderOptions } from "./providers/basic.ts";
import { OAuth2ProxyProvider, type OAuth2ProxyProviderOptions } from "./providers/oauth2-proxy.ts";

/**
 * Auth provider registry + plugin loading (design.md §5.3).
 *
 * Built-ins: authelia (default), basic. Plugins load from:
 *   1. authPlugins passed to createServiceTunnels,
 *   2. providers/*.js in configDir (ESM modules exporting a factory).
 * Each factory receives a ProviderContext; the registry exposes list() /
 * create() so expose() can pick providers by name.
 */

export type AnyProviderOptions =
  | AutheliaProviderOptions
  | BasicAuthProviderOptions
  | OAuth2ProxyProviderOptions
  | Record<string, unknown>;

export class AuthRegistry {
  #factories = new Map<string, AuthProviderFactory>();
  #ctx: ProviderContext;

  constructor(ctx: ProviderContext, plugins: AuthProviderFactory[] = []) {
    this.#ctx = ctx;
    // built-ins
    this.#factories.set("authelia", () => new AutheliaProvider(ctx));
    this.#factories.set("basic", () => new BasicAuthProvider(ctx));
    this.#factories.set("oauth2-proxy", () => new OAuth2ProxyProvider(ctx));
    for (const f of plugins) {
      const probe = f(ctx);
      this.#factories.set(probe.type, f);
    }
  }

  /** Register an extra provider factory (idempotent by type). */
  register(factory: AuthProviderFactory): void {
    const probe = factory(this.#ctx);
    this.#factories.set(probe.type, factory);
  }

  unregister(type: string): void {
    this.#factories.delete(type);
  }

  list(): string[] {
    return [...this.#factories.keys()];
  }

  has(type: string): boolean {
    return this.#factories.has(type);
  }

  /** Create a provider instance with its options (unknown keys tolerated). */
  create(type: string, opts: AnyProviderOptions = {}): AuthProvider {
    const factory = this.#factories.get(type);
    if (!factory) throw new Error(`unknown auth provider: ${type} (available: ${this.list().join(", ")})`);
    return factory(this.#ctx);
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
