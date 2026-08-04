import { GatewayController, type GatewayAuthMode } from "./gateway.ts";
import { readConfigFile } from "./config.ts";
import { RedisController } from "./redis.ts";
import type { AuthProvider, ProviderContext } from "./auth-provider.ts";
import { AuthRegistry } from "./auth-registry.ts";
import type { TunnelManager } from "./tunnels.ts";
import { InternalRegistry } from "./internal.ts";

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
  auth?: boolean;
  provider?: string;
  tunnelName?: string;
  tunnelType?: string;
  policy?: "one_factor" | "two_factor" | "deny";
  nginxPort?: number;
  autheliaPort?: number;
  redisPort?: number;
  basePath?: string;
  user?: { name: string; password: string };
  sessionSecret?: string;
  /** External authelia reload command (operator-managed authelia). */
  autheliaReloadCmd?: string;
}

export interface ExposeResult {
  url: string | null;
  tunnel: string;
  provider?: string;
  /** Login portal page (provider basePath under the tunnel URL). */
  loginUrl?: string;
  gateway?: { nginx: number; authelia: number; redis: number };
}

export interface ExposeContext {
  configDir: string;
  cacheDir: string;
  resolveTool: (name: string) => Promise<string>;
  internal: InternalRegistry;
  tunnels: TunnelManager;
  /** Auth provider registry (built-ins + plugins). */
  auth?: AuthRegistry;
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

export async function expose(port: number, opts: ExposeOptions, ctx: ExposeContext): Promise<ExposeResult> {
  const log = ctx.log ?? (() => {});
  const providerType = opts.provider ?? "authelia";
  const useAuth = opts.auth ?? false;

  if (!useAuth) {
    // plain tunnel straight to the app
    const name = opts.tunnelName ?? `expose-${port}`;
    ctx.tunnels.add({
      name,
      type: (opts.tunnelType as never) ?? "ngrok",
      target: port,
    });
    await ctx.tunnels.start(name);
    const url = await waitForUrl(ctx.tunnels, name, 30_000);
    return { url, tunnel: name };
  }

  // ── auth flow: shared infrastructure ──────────────────────────────────────
  const pctx = providerCtx(ctx);
  const registry = ctx.auth ?? new AuthRegistry(pctx);
  // basePath resolution: explicit opts (library/CLI) > configDir/
  // service-tunnels.json (basePath / basePathByProvider) > per-expose random
  // name so nginx (auth_request) and the provider agree AND generic paths
  // (/{provider}) never collide with app routes (portal → /portal-sneaky-capybara).
  const cfgFile = readConfigFile(ctx.configDir);
  const basePath = opts.basePath
    ?? (providerType === "basic" ? "" : (cfgFile.basePathByProvider?.[providerType] ?? cfgFile.basePath))
    ?? defaultBasePath(providerType);
  const provider: AuthProvider = registry.create(providerType, {
    port: opts.autheliaPort,
    basePath,
    sessionSecret: opts.sessionSecret,
    policy: opts.policy,
    user: opts.user,
    externalReloadCmd: opts.autheliaReloadCmd,
  });
  // the registry caches ONE instance per type — a user-management call may
  // have created it without a basePath; fix it up so nginx auth_request and
  // the provider agree
  if (basePath && provider.setBasePath) await provider.setBasePath(basePath);

  const problems = (await provider.validate?.()) ?? [];
  if (problems.length) {
    throw new Error(`auth provider ${providerType} not ready:\n  - ${problems.join("\n  - ")}`);
  }

  // edge-auth providers (ngrok edge-oidc) skip the local gateway entirely
  if (provider.capabilities.edgeAuth && !provider.capabilities.localGateway) {
    const name = opts.tunnelName ?? `expose-${port}`;
    const tunnelAuth = provider.renderTunnelAuth?.() ?? {};
    ctx.tunnels.add({
      name,
      type: (opts.tunnelType as never) ?? "ngrok",
      target: port,
      args: (tunnelAuth.args as string[]) ?? [],
    });
    await ctx.tunnels.start(name);
    const url = await waitForUrl(ctx.tunnels, name, 30_000);
    return { url, tunnel: name, provider: providerType };
  }

  const nginxPort = opts.nginxPort ?? 0; // 0 = random
  const authMode: GatewayAuthMode = provider.type === "basic" ? "basic" : "forward-auth";
  const htpasswdFile = (provider as { htpasswdFile?: string }).htpasswdFile;
  const gateway = new GatewayController({
    configDir: ctx.configDir,
    cacheDir: ctx.cacheDir,
    port: nginxPort,
    basePath,
    htpasswdFile,
    registerInternal: (role, p) => ctx.internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
    unregisterInternal: (role) => ctx.internal.unregister(role),
    log,
  });

  // Redis first (provider may need it for sessions), then provider, then nginx.
  let redis: RedisController | null = null;
  if (provider.capabilities.needsSessionStore) {
    redis = new RedisController({
      cacheDir: ctx.cacheDir,
      port: opts.redisPort,
      log,
    });
    const redisPort = await redis.start();
    ctx.internal.register("redis", { port: redisPort, pid: 0, process: "redis", cmdline: "redis", addresses: ["127.0.0.1"] });
  }

  await provider.start();
  const authPort = (provider as unknown as { port?: number }).port ?? 9091;
  const gatewayPort = await gateway.start(authPort, authMode);

  // tunnel pointing at the gateway
  const name = opts.tunnelName ?? `expose-${port}`;
  ctx.tunnels.add({
    name,
    type: (opts.tunnelType as never) ?? "ngrok",
    target: gatewayPort,
  });
  await ctx.tunnels.start(name);

  // wait for the public URL, then register it with the provider AND the
  // gateway (nginx needs a server block for the host before it listens)
  const url = await waitForUrl(ctx.tunnels, name, 30_000);
  const publicHost = url ? new URL(url).host : null;
  if (publicHost) {
    await gateway.registerHost(publicHost, port, authPort);
    await provider.registerHost(publicHost, { policy: opts.policy });
    log(`expose ${port}: ${url} (auth via ${providerType}, host ${publicHost} registered)`);
  }

  return {
    url,
    tunnel: name,
    provider: providerType,
    loginUrl: url && basePath ? `${url}${basePath}/login` : undefined,
    gateway: { nginx: gatewayPort, authelia: authPort, redis: redis?.port ?? 0 },
  };
}

/** Random memorable base path: {provider}-{adjective}-{animal} (e.g.
 *  /portal-sneaky-capybara). Random per expose → unpredictable and collision
 *  -free against app routes; basic auth needs no base path. */
export function defaultBasePath(providerType: string): string {
  if (providerType === "basic") return "";
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
    pickPort,
    log: ctx.log ?? (() => {}),
  };
}
