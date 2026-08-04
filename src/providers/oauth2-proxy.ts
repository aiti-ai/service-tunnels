import { spawn, execFileSync, type ChildProcess } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { roleEnv } from "../marker.ts";
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus } from "../auth-provider.ts";

/**
 * oauth2-proxy provider — local gateway + OIDC (design.md §5.3).
 *
 * nginx auth_request → oauth2-proxy sidecar (/oauth2/auth); the proxy handles
 * the OIDC dance (redirects to the IdP, sets its own cookie). Requires a
 * fixed public host (OIDC redirect_uri must be pre-registered) — random hosts
 * are NOT supported. No Redis needed (session cookie is self-contained).
 *
 * Config: OIDC issuer/clientId/clientSecret (from provider options or
 * config.json auth.oidc). Binary auto-downloaded (tools.ts "oauth2-proxy").
 */

export interface OAuth2ProxyProviderOptions {
  port?: number;
  oidc?: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    cookieSecret?: string;
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end >= 0 && stat[end + 2] === "Z") return false;
    }
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class OAuth2ProxyProvider implements AuthProvider {
  readonly type = "oauth2-proxy";
  readonly capabilities = {
    localGateway: true,
    edgeAuth: false,
    randomDomain: false, // OIDC redirect_uri must be pre-registered
    multiHost: true,
    needsSessionStore: false,
  };

  #ctx: ProviderContext;
  #opts: OAuth2ProxyProviderOptions;
  #child: ChildProcess | null = null;
  #port: number;
  #bin: string | null = null;

  constructor(ctx: ProviderContext, opts: OAuth2ProxyProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#port = opts.port ?? 0;
  }

  get port(): number {
    return this.#port;
  }

  status(): AuthProviderStatus {
    return { running: Boolean(this.#child && alive(this.#child.pid ?? 0)), port: this.#port };
  }

  async validate(): Promise<string[]> {
    const problems: string[] = [];
    const oidc = this.#opts.oidc;
    if (!oidc?.issuerUrl || !oidc?.clientId || !oidc?.clientSecret) {
      problems.push("oauth2-proxy requires auth.oidc { issuerUrl, clientId, clientSecret } in config.json");
    }
    try {
      await this.#ctx.resolveTool("oauth2-proxy");
    } catch (err) {
      problems.push(`oauth2-proxy binary unavailable: ${(err as Error).message}`);
    }
    return problems;
  }

  renderNginxAuth(): string {
    // gateway wires auth_request to ${basePath}/oauth2/auth via its own config;
    // the portal path is /oauth2/ (oauth2-proxy serves its own callback there).
    return "";
  }

  async prepare(): Promise<AuthProviderStatus> {
    this.#bin = await this.#ctx.resolveTool("oauth2-proxy");
    if (!this.#port) this.#port = await this.#ctx.pickPort();
    const dir = join(this.#ctx.cacheDir, "tmp", "oauth2-proxy");
    mkdirSync(dir, { recursive: true });
    const oidc = this.#opts.oidc!;
    const cookieSecret = oidc.cookieSecret ?? randomSecret(32);
    writeFileSync(
      join(dir, "oauth2-proxy.conf"),
      [
        `http_address = "127.0.0.1:${this.#port}"`,
        `upstreams = ["static://200"]`,
        `provider = "oidc"`,
        `oidc_issuer_url = "${oidc.issuerUrl}"`,
        `client_id = "${oidc.clientId}"`,
        `client_secret = "${oidc.clientSecret}"`,
        `cookie_secret = "${cookieSecret}"`,
        `email_domains = ["*"]`,
        `set_xauthrequest = true`,
      ].join("\n") + "\n",
      "utf8",
    );
    return this.status();
  }

  async start(): Promise<AuthProviderStatus> {
    if (this.#child && alive(this.#child.pid ?? 0)) return this.status();
    await this.prepare();
    const bin = this.#bin!;
    const child = spawn(
      bin,
      ["--config", join(this.#ctx.cacheDir, "tmp", "oauth2-proxy", "oauth2-proxy.conf")],
      { env: { ...process.env, ...roleEnv("oauth2-proxy") }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr?.on("data", (c) => this.#ctx.log(`oauth2-proxy: ${c.toString().trim()}`));
    this.#child = child;
    this.#ctx.registerInternal("oauth2-proxy", this.#port);
    // wait for readiness (TCP probe)
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && alive(child.pid ?? 0)) {
      if (await tcpOpen(this.#port)) return this.status();
      await new Promise((r) => setTimeout(r, 150));
      if (child.exitCode !== null) throw new Error(`oauth2-proxy exited during startup (${child.exitCode})`);
    }
    throw new Error("oauth2-proxy did not become ready in time");
  }

  async stop(): Promise<void> {
    if (this.#child) {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        // gone
      }
      this.#child = null;
    }
    this.#ctx.unregisterInternal("oauth2-proxy");
  }

  async registerHost(_host: string, _policy?: AuthPolicy): Promise<void> {
    // oauth2-proxy accepts all hosts reaching it; nothing per-host to register
  }

  async unregisterHost(_host: string): Promise<void> {
    // nothing to unregister
  }

  async listHosts(): Promise<string[]> {
    return [];
  }
}

async function tcpOpen(port: number): Promise<boolean> {
  const { connect } = await import("net");
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      s.destroy();
      resolve(false);
    });
    s.setTimeout(500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

function randomSecret(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
