import { spawn, execFileSync, type ChildProcess } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { roleEnv } from "../marker.ts";
import { validateSetupEntry } from "../auth-provider.ts";
import { validateOidcOptions, tomlEscape } from "../validation.ts";
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
    /** 预登录设置页 + 域名验证文件（IdP 联动：回调白名单 / 域名所有权校验）。 */
    setup?: {
      /** 登录前显示设置提示页（缺省 true）。 */
      infoPage?: boolean;
      /** 域名所有权验证文件列表：IdP 抓取 http://<host>/<path> 校验内容。 */
      verification?: Array<{ path: string; content: string }>;
    };
  };
  /** Per-site storage dir (P1); default = cacheDir/tmp/oauth2-proxy. */
  storageDir?: string;
  /** Site (auth realm) this instance belongs to. */
  site?: string;
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
  /** Site (auth realm) this instance belongs to ("default" when absent). */
  readonly site: string;
  /** /oauth2/ 协议：探针 /oauth2/auth、登录/回调直达侧车。 */
  readonly gatewayMode = "oauth2-proxy" as const;
  readonly authzPath = "/oauth2/auth";
  readonly providerPaths = ["/oauth2"];
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
  #dir: string;

  constructor(ctx: ProviderContext, opts: OAuth2ProxyProviderOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
    this.#port = opts.port ?? 0;
    this.#dir = opts.storageDir ?? join(ctx.cacheDir, "tmp", "oauth2-proxy");
    this.site = opts.site ?? "default";
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

  /** 默认 basePath：固定 /oauth2-proxy（oauth2-proxy 自身用固定 /oauth2/）。 */
  defaultBasePath(): string {
    return "/oauth2-proxy";
  }

  /** 登录页展示地址：oauth2-proxy 自己的 /oauth2/start。 */
  loginUrl(url: string): string {
    return `${url}/oauth2/start`;
  }

  /** 未认证跳转：预登录设置页（infoPage 开启时）否则 oauth2-proxy 的 /oauth2/start。 */
  loginRedirect(_basePath: string, scheme: "http" | "https"): string {
    const infoPath = this.setupConfig()?.infoPath;
    return infoPath
      ? `${scheme}://$host${infoPath}?rd=$request_uri`
      : `${scheme}://$host/oauth2/start?rd=$request_uri`;
  }

  async prepare(): Promise<AuthProviderStatus> {
    this.#bin = await this.#ctx.resolveTool("oauth2-proxy");
    if (!this.#port) this.#port = await this.#ctx.pickPort();
    const dir = this.#dir;
    mkdirSync(dir, { recursive: true });
    const oidc = this.#opts.oidc!;
    // Fail-closed validation BEFORE the config is written: issuerUrl must be
    // a real http(s) URL and every value must be free of control characters
    // (a newline in clientSecret would inject TOML directives — same class as
    // the frpc INI injection). Values are additionally TOML-escaped below.
    validateOidcOptions(oidc);
    const cookieSecret = oidc.cookieSecret ?? randomSecret(32);
    const t = (s: string) => tomlEscape(s);
    writeFileSync(
      join(dir, "oauth2-proxy.conf"),
      [
        `http_address = "127.0.0.1:${this.#port}"`,
        `upstreams = ["static://200"]`,
        `provider = "oidc"`,
        `oidc_issuer_url = "${t(oidc.issuerUrl)}"`,
        `client_id = "${t(oidc.clientId)}"`,
        `client_secret = "${t(oidc.clientSecret)}"`,
        `cookie_secret = "${t(cookieSecret)}"`,
        `email_domains = ["*"]`,
        `set_xauthrequest = true`,
        // Local-side gateway (nginx/node proxy talk to us over 127.0.0.1 http).
        // cookie_secure=true (default) would force https redirect URIs and the
        // Secure cookie attribute — breaking plain-http local testing.
        `cookie_secure = false`,
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
      ["--config", join(this.#dir, "oauth2-proxy.conf")],
      { env: { ...process.env, ...roleEnv("oauth2-proxy") }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr?.on("data", (c) => this.#ctx.log(`oauth2-proxy: ${c.toString().trim()}`));
    this.#child = child;
    this.#ctx.registerInternal("oauth2-proxy", this.#port);
    this.#ctx.registerPid("oauth2-proxy", child.pid ?? 0);
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

  /** 免认证直达内容（由 proxy/gateway 接线）：域名验证文件 + 预登录设置页。 */
  setupConfig(): import("../auth-provider.ts").ProviderSetup | undefined {
    const setup = this.#opts.oidc?.setup;
    if (!setup) return undefined;
    const verification = normalizeVerification(setup.verification);
    const out: import("../proxy.ts").ProxySetup = { verification };
    if (setup.infoPage !== false) {
      out.infoPath = "/oauth2-setup";
      out.infoHtmlTemplate = renderSetupHtml({
        verification,
        clientId: this.#opts.oidc?.clientId ?? "",
        issuer: this.#opts.oidc?.issuerUrl ?? "",
      });
      out.infoHtml = (host, next) =>
        (out.infoHtmlTemplate ?? "").replaceAll("$host", host).replaceAll("$arg_rd", next);
    }
    return out;
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

/** HTML 转义（配置内容注入页面时防 XSS）。 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 验证文件列表归一化：库 API 传数组 / CLI 点号键传 {0:{},1:{}} 皆可。 */
function normalizeVerification(v: unknown): Array<{ path: string; content: string }> {
  if (Array.isArray(v)) {
    return v.filter((x): x is { path: string; content: string } => Boolean(x && typeof x === "object" && (x as { path?: string }).path && (x as { content?: string }).content));
  }
  if (v && typeof v === "object") {
    return Object.values(v).filter((x): x is { path: string; content: string } => Boolean(x && typeof x === "object" && (x as { path?: string }).path && (x as { content?: string }).content));
  }
  return [];
}

/** 预登录设置提示页模板（nginx $host/$arg_rd 变量；node proxy 自行替换）。 */
export function renderSetupHtml(o: {
  verification: Array<{ path: string; content: string }>;
  clientId: string;
  issuer: string;
}): string {
  const vfItems = o.verification.length
    ? o.verification.map((v) => `  <li>域名所有权验证：请让服务商访问 <code>http://$host${esc(v.path)}</code> 并校验返回内容 <code>${esc(v.content)}</code></li>`).join("\n")
    : "  <li>（未配置域名验证文件，如服务商要求请添加）</li>";
  return `<!doctype html>
<html lang="zh"><meta charset="utf-8"><title>OAuth2 登录前设置</title>
<body style="font-family:system-ui,sans-serif;max-width:660px;margin:48px auto;padding:0 16px;line-height:1.7">
<h2>登录前请先确认 OAuth2 应用配置</h2>
<p>当前服务地址：<code>$host</code></p>
<p>回调地址（Callback / 重定向 URI）：<code>http://$host/oauth2/callback</code></p>
<p>OAuth2 服务商：<code>${esc(o.issuer)}</code>，Client ID：<code>${esc(o.clientId)}</code></p>
<ol>
  <li>到 OAuth2 服务商的应用设置里，把上面的<strong>回调地址</strong>加入重定向白名单
    （隧道域名是动态的，域名变化后需要更新）</li>
${vfItems}
</ol>
<p><a href="/oauth2/start?rd=$arg_rd">已配置完成，继续登录 →</a></p>
</body></html>`;
}
