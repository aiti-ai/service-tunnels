import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { loginFabScript, loginFabFile, FAB_JS_PATH } from "./user-fab.ts";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { roleEnv } from "./marker.ts";
import { validateSetupEntry } from "./auth-provider.ts";
import { bracketHost, hostnameOnly, unbracketHost } from "./net-utils.ts";

/**
 * nginx gateway — the local host that owns auth (design.md §5).
 *
 * Shared infrastructure (one instance per owner pid): listens on
 * 127.0.0.1:<random-port>, routes by Host. Each registered public host is a
 * SEPARATE conf.d/<host>.conf file (per-host auth backend), so one nginx can
 * serve hosts protected by different providers without config conflicts.
 *
 * Config lives under cacheDir/tmp/nginx-<process.pid>/ — scoped per owner so
 * multiple service-tunnels instances never share config/logs/pidfile; the
 * folder is wiped on construction so a fresh run starts clean.
 */

export interface GatewayHost {
  /** Public host (e.g. demo.ngrok-free.app). */
  host: string;
  /** Local app port behind auth. */
  port: number;
  /** Local app upstream address (127.0.0.1 default; "::1" for IPv6-loopback-
   *  only apps). nginx `proxy_pass` dials this address. */
  targetHost?: string;
  /** Backend port for forward-auth (authelia/oauth2-proxy). Per-host so one
   *  shared nginx can route different hosts to different providers. */
  authPort?: number;
  /** Provider base path (e.g. /authelia) for forward-auth mode. */
  basePath?: string;
  /** "forward-auth" (auth_request → provider), "basic" (auth_basic),
   *  "token" (auth_request → Bearer probe), or "none" (plain proxy, no
   *  auth but still logged). */
  authMode?: GatewayAuthMode;
  /** htpasswd file for basic mode (per-host). */
  htpasswdFile?: string;
  /** Auth realm (site) shown in the basic-auth browser prompt. */
  site?: string;
  /** Backend scheme: "http" or "https" (detected by probing the app port).
   *  nginx proxy_pass uses this (https upstreams need proxy_ssl_verify off). */
  scheme?: "http" | "https";
  /** nginx `return 302 <loginRedirect>` target for forward-auth 401. Provider-
   *  specific: portal uses `${basePath}/login?next=`, authelia uses
   *  `${basePath}/?rd=https://$host$request_uri`. Uses nginx vars. */
  loginRedirect?: string;
  /** oauth2-proxy 联动：域名验证文件 + 预登录设置页（免认证 location）。 */
  setup?: {
    verification: Array<{ path: string; content: string }>;
    infoPath?: string;
    /** 设置页 HTML 模板（nginx $host/$arg_rd 变量，return 200 直接输出）。 */
    infoHtmlTemplate?: string;
  };
  /** 认证放行白名单（URL 路径前缀）：这些 location 不带 auth_request，直接
   *  转发应用（/health、/metrics 等公开端点）。 */
  bypassPaths?: string[];
  /**
   * 静态响应注入（tunnel nginx 路径，类似 proxy 的 transformResponse——但
   * nginx 配置是静态的，无法按请求回调，所以这里传固定 HTML 片段）。
   * 两种模式都**只作用于 text/html 且仅主页面导航**（Sec-Fetch-Mode:
   * navigate/nested-navigate 或老客户端无该头；XHR/fetch/子资源请求不注入）
   * ——避免把用户后加载的模板片段/文件注坏。
   * - `position: "head"`（默认）：sub_filter 在 `</head>` 前插入；
   * - `position: "prepend"`：add_before_body 在响应开头直接写（需 nginx
   *   addition 模块，缺失时 registerHost 报错）。
   */
  inject?: string | GatewayInject;
  /** 注入「登录信息按钮」（悬浮 FAB：显示登录用户名 + 退出登录，可拖动四边
   *  停靠）。默认 false（显式开启）；仅 auth != "none"/"token" 时生效
   *  （无会话语义不注入）。与用户自定义 inject 并存（拼接：自定义在前）。 */
  loginInfoButton?: boolean;
}

/** 静态响应注入（nginx sub_filter / add_before_body 实现）。 */
export interface GatewayInject {
  html: string;
  /** "head" = `</head>` 前插入（默认）；"prepend" = 响应开头直接写。 */
  position?: "head" | "prepend";
  /** 注入后重新压缩回 gzip（默认 true）。上游被强制 identity（否则压缩流
   *  会注坏），注入完成的明文响应由 nginx gzip 模块重新压缩——隧道链路
   *  （边缘 → 浏览器）恢复压缩；代价是流式 HTML 分块会被 zlib 合并（
   *  追求最早 flush 可设 false 换回流式明文）。客户端未带 Accept-Encoding
   *  时 nginx 自动跳过压缩，无额外开销。 */
  recompress?: boolean;
}

/** 归一化注入参数：string → head 模式；{html, position} 按 position。 */
export function normalizeInject(raw: string | GatewayInject | null | undefined): GatewayInject | null {
  if (!raw) return null;
  if (typeof raw === "string") return { html: raw, position: "head" };
  return { html: raw.html, position: raw.position === "prepend" ? "prepend" : "head", recompress: raw.recompress };
}

/** nginx 双引号字符串字面量：非打印/非 ASCII 字节 \xHH 转义、\" 与 \\ 转义——
 *  注入 HTML 含任意引号/JS 也能安全进入 sub_filter 替换串（nginx 单引号串
 *  无法转义单引号，故统一用双引号 + 字节转义）。 */
export function nginxQuote(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\x${b.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(b);
  }
  return out + '"';
}

/** 每 host 全局唯一 nginx 变量名（host 含点/连字符，不能直接作变量名；
 *  sha256 前缀防多 host 碰撞——nginx 变量全局唯一，重名会报错）。 */
export function injectVarName(host: string, suffix: string): string {
  return `st_inj${suffix}_${createHash("sha256").update(host).digest("hex").slice(0, 16)}`;
}

export type GatewayAuthMode = "forward-auth" | "oauth2-proxy" | "basic" | "token" | "none";

export interface GatewayConfig {
  nginxPort: number;
  hosts: GatewayHost[];
  /** Directory for pid/conf/logs (cacheDir/tmp/nginx-<pid>). */
  nginxRoot: string;
}

/** Probe a LOCAL app port to classify its protocol: "http", "https", or
 *  "tcp" (raw — accepts a TCP connection but isn't HTTP/TLS). Used to decide
 *  the forwarding mode (nginx gateway for http/https; direct raw tunnel for
 *  tcp). `host` defaults to 127.0.0.1; for an app bound only to ::1, pass
 *  "::1" (or "auto" to probe both families). */
export async function detectProtocol(port: number, timeoutMs = 1500, host = "127.0.0.1"): Promise<"http" | "https" | "tcp"> {
  const hosts = host === "auto" ? ["127.0.0.1", "::1"] : [host];
  // Raw net/tls probes (no http agent → no keep-alive socket lingering).
  // Every socket is explicitly destroyed so the event loop drains.
  const probeTcp = (h: string) =>
    new Promise<boolean>((resolve) => {
      void import("net").then(({ connect }) => {
        const s = connect(port, h);
        s.once("connect", () => { s.destroy(); resolve(true); });
        s.once("error", () => { s.destroy(); resolve(false); });
        s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
      });
    });
  const probeHttp = (h: string) =>
    new Promise<boolean>((resolve) => {
      void import("net").then(({ connect }) => {
        const s = connect(port, h);
        let got = false;
        s.once("connect", () => {
          s.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        });
        s.on("data", () => { got = true; s.destroy(); resolve(true); });
        s.once("error", () => { s.destroy(); resolve(false); });
        s.setTimeout(timeoutMs, () => { s.destroy(); resolve(got); });
      });
    });
  const probeHttps = (h: string) =>
    new Promise<boolean>((resolve) => {
      void import("tls").then(({ connect }) => {
        const s = connect({ host: h, port, rejectUnauthorized: false });
        s.once("secureConnect", () => { s.destroy(); resolve(true); });
        s.once("error", () => { s.destroy(); resolve(false); });
        s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
      });
    });
  for (const h of hosts) {
    if (await probeHttp(h)) return "http";
    if (await probeHttps(h)) return "https";
  }
  for (const h of hosts) {
    if (await probeTcp(h)) return "tcp";
  }
  return "tcp";
}

/** @deprecated use detectProtocol — kept as an http/https alias. */
export async function detectScheme(port: number, timeoutMs = 1500): Promise<"http" | "https"> {
  return (await detectProtocol(port, timeoutMs)) === "https" ? "https" : "http";
}

/** Generate ONE host's server block — written to conf.d/<host>.conf so each
 *  tunnel host is its own file (register/unregister only touches that file).
 *  Auth is per-host: "none" (plain proxy), "basic" (auth_basic), or
 *  "forward-auth" (auth_request → provider). */
export function generateHostNginx(
  h: GatewayHost,
  defaults: { nginxPort: number; nginxRoot: string; authPort?: number; basePath?: string; authMode?: GatewayAuthMode; htpasswdFile?: string },
): string {
  const authModeRaw = h.authMode ?? defaults.authMode ?? "forward-auth";
  const authPort = h.authPort ?? defaults.authPort ?? 0;
  // A forward-auth/oauth2/token host with no auth backend (authPort 0 /
  // absent) would emit `proxy_pass http://127.0.0.1:0/...` — an invalid
  // upstream that `nginx -t` rejects. Runtime flows always resolve a real
  // provider port first; a missing backend downgrades to plain proxy so the
  // config stays valid (gateway lifecycle without an auth server). "basic"
  // uses an htpasswd file, not authPort, so it is unaffected.
  const authMode =
    (authModeRaw === "forward-auth" || authModeRaw === "oauth2-proxy" || authModeRaw === "token") && !authPort
      ? "none"
      : authModeRaw;
  const basePath = h.basePath ?? defaults.basePath ?? "/authelia";
  const htpasswdFile = h.htpasswdFile ?? defaults.htpasswdFile ?? "";
  const nginxPort = defaults.nginxPort;
  const nginxRoot = defaults.nginxRoot;
  // host 已由 #sanitizeHost 校验(仅 DNS 字符)——server_name 用原样字面点:
  // nginx 对转义点(\.)的 server_name 匹配有怪癖(1.26.3 实测多 host 共存时
  // 请求落到默认 server 而非精确匹配),字面点匹配正常
  const escaped = h.host;
  const portal = `${basePath}/`;
  const portalPath = portal.replace(/^\//, "");
  // oauth2-proxy serves its own fixed /oauth2/auth probe (authelia/portal use
  // {basePath}/api/authz/auth-request).
  const authzPath = authMode === "oauth2-proxy"
    ? "oauth2/auth"
    : authMode === "token"
      ? "token-authz/auth"
      : `${basePath}/api/authz/auth-request`.replace(/^\//, "");
  const isFwd = authMode === "forward-auth";
  const isOauth2 = authMode === "oauth2-proxy";
  const isToken = authMode === "token";
  const authLine =
    authMode === "basic"
      ? `      auth_basic "service-tunnels${h.site ? " " + h.site : ""}";\n      auth_basic_user_file ${htpasswdFile};`
      : isToken
        ? `      auth_request /${authzPath};\n      # Bearer token 无登录页:401 直返客户端(不 error_page 跳转)\n      add_header WWW-Authenticate 'Bearer realm="service-tunnels"' always;`
        : isFwd || isOauth2
          ? `      auth_request /${authzPath};\n      error_page 401 @auth_redirect;`
          : ""; // "none" — plain proxy, no auth (but still logged)
  const authzBlock =
    !isFwd && !isOauth2 && !isToken
      ? ""
      : `    location = /${authzPath} {
      internal;
      proxy_pass http://127.0.0.1:${authPort}/${authzPath};
      # $http_host 保留原始端口（本地 http 测试）；真实隧道无端口时与 $host 等价
      proxy_set_header Host ${isOauth2 ? "$http_host" : "$host"};
      # auth_request 子请求默认不转发 Cookie → 会话永远到不了 portal(auth-request
      # 恒 401 → 302 登录);显式转发后 deny/two_factor 策略才能按会话判断。
      proxy_set_header Cookie $http_cookie;
      # nginx auth_request 子请求默认也剥离 Authorization —— token 探针必须
      # 显式转发才拿得到 Bearer 头。
      ${isToken ? "      proxy_set_header Authorization $http_authorization;\n" : ""}      ${isOauth2 ? "" : `# the tunnel edge terminates TLS; authelia refuses http target URLs
      proxy_set_header X-Original-URL https://$host$request_uri;`}
      proxy_set_header X-Original-Method $request_method;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
    }

`;
  const portalBlock =
    isOauth2
      ? `    location /oauth2/ {
      proxy_pass http://127.0.0.1:${authPort};
      # $http_host 保留原始端口（本地 http 测试）；真实隧道无端口时与 $host 等价
      proxy_set_header Host $http_host;
      # oauth2-proxy needs the original URI to redirect back after login
      proxy_set_header X-Auth-Request-Redirect $request_uri;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
    }

`
      : !isFwd
        ? ""
        : `    location /${portalPath} {
      proxy_pass http://127.0.0.1:${authPort}/${portalPath};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
      # WebSocket for the auth provider's SPA (authelia/portal live features),
      # HTTP/1.1 keep-alive + Upgrade. Keep proxy_buffering on (SPA bundles).
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      # buffer the provider's responses fully (SPA bundles) before forwarding:
      # with proxy_buffering off, large responses streamed to an HTTP/2 edge
      # (serveo/cloudflare) can hit ERR_HTTP2_PROTOCOL_ERROR framing issues.
      proxy_buffering on;
    }

`;
  const authFailBlock =
    (!isFwd && !isOauth2) || isToken
      ? ""
      : `    location @auth_redirect {
      internal;
      # absolute https + PUBLIC host (no internal nginx port): nginx would
      # otherwise synthesize http://<host>:<listen-port>/... from the relative
      # path, which is unreachable behind the tunnel.
      return 302 ${h.loginRedirect ?? (isOauth2 ? `https://$http_host/oauth2/start?rd=$request_uri` : `https://$http_host${basePath}/login?next=$request_uri`)};
    }

`;
  // oauth2-proxy 联动：域名验证文件 + 预登录设置页（免认证直达；return 200
  // 支持 $host/$arg_rd 变量——回调地址按当前隧道域名实时渲染）。
  const setupBlock =
    !isOauth2 || !h.setup
      ? ""
      : h.setup.verification
          .map((v) => {
            // 渲染前白名单校验（防 nginx 配置注入）——非法直接抛错
            validateSetupEntry(v);
            return `    location = ${v.path} {
      default_type text/plain;
      return 200 '${v.content}';
    }

`;
          })
          .join("") +
        (h.setup.infoPath && h.setup.infoHtmlTemplate
          ? (() => {
              // infoPath 同样只允许 URL 路径字符；模板不得含单引号/反斜杠
              validateSetupEntry({ path: h.setup.infoPath, content: "x" });
              if (/['\\]/.test(h.setup.infoHtmlTemplate)) {
                throw new Error("invalid oauth2 setup page template: no quotes/backslashes allowed");
              }
              return `    location = ${h.setup.infoPath} {
      default_type text/html;
      return 200 '${h.setup.infoHtmlTemplate}';
    }

`;
            })()
          : "");
  // ── 登录信息按钮（loginInfoButton）：拼接 fab 注入 + 回显 location ──
  // 仅 fwd-auth（portal/authelia）与 basic 生效——token/none 无会话语义。
  // token 显式开启时忽略（CLI 层应已提示，这里 fail-quiet 不炸配置）。
  const fabOn = h.loginInfoButton === true && (isFwd || authMode === "basic");
  // cfg（basic/logoutUrl）在 writeHostFile 写 JS 文件时处理——注入的只是外链引用
  // fab 注入与自定义 inject 拼接（自定义在前）；无自定义 inject 时 fab 单独成注入
  let injectRaw: string | GatewayInject | null = h.inject ?? null;
  if (fabOn && injectRaw == null) injectRaw = { html: loginFabScript(), position: "head" };
  else if (fabOn) {
    const inj = normalizeInject(injectRaw);
    if (inj) {
      const fabHtml = loginFabScript();
      injectRaw = inj.position === "head"
        ? { ...inj, html: inj.html + fabHtml }
        : { ...inj, html: fabHtml + inj.html }; // prepend：fab 放最前（浏览器允许 <script> 先于内容）
    }
  }
  // 回显端点：__st_auth__ —— fwd-auth proxy 到 authz?who=1；basic 空文件+头
  let whoServer = "";
  if (fabOn) {
    // fab JS 静态文件 serve（浏览器可拉：无敏感数据，纯组件代码 + 静态常量）
    whoServer = `    location = ${FAB_JS_PATH} {
      alias ${nginxRoot}/fabjs/__st_fab__.js;
      default_type application/javascript;
      add_header Cache-Control "no-store" always;
    }

`;
    if (isFwd) {
      whoServer += `    # 登录信息按钮数据源：已认证请求回显用户名（JSON，portal；authelia 透传头）
    location = /__st_auth__ {
      auth_request /${authzPath};
      proxy_pass http://127.0.0.1:${authPort}/${authzPath}?who=1;
      proxy_pass_request_body off;
      proxy_set_header Content-Length "";
      proxy_set_header Host $host;
      proxy_set_header Cookie $http_cookie;
      add_header X-St-Auth-User $upstream_http_x_st_auth_user always;
      add_header Cache-Control "no-store" always;
    }

`;
    } else {
      // basic：空体 200 + 用户名头
      whoServer += `    # 登录信息按钮数据源（basic）：空体 200 + 用户名头
    location = /__st_auth__ {
      auth_basic "service-tunnels${h.site ? " " + h.site : ""}";
      auth_basic_user_file ${htpasswdFile};
      root ${nginxRoot}/empty;
      add_header Content-Type "application/json" always;
      add_header X-St-Auth-User $remote_user always;
      add_header Cache-Control "no-store" always;
    }

`;
    }
  }

  // ── 静态响应注入（tunnel nginx 路径，类似 proxy 的 transformResponse）──
  // 只作用于 text/html 且仅主页面导航（Sec-Fetch-Mode: navigate /
  // nested-navigate 或老客户端无该头；XHR/fetch/子资源请求不注入）——避免
  // 把用户后加载的模板片段/文件注坏。head 用 sub_filter（替换串是 map 变量：
  // 非导航请求 → 恒等 </head> 不注入）；prepend 用 add_before_body + 内部
  // location 按请求切到空响应（return 200 ''）。
  // 注入指令放在 location / 与 bypass 白名单 location（nginx location /
  // 是前缀匹配——/target.html、/a/b/c 等所有直接导航页面都会命中并注入；
  // provider 登录页/authz/setup 不注入）。
  const inject = normalizeInject(injectRaw);
  let injectMap = ""; // http 级（conf.d 文件是 http include，map 可放）
  let injectServer = ""; // server 级（prepend 的内部 location）
  let injectLoc = ""; // location / 级（sub_filter / add_before_body）
  if (inject?.position === "prepend") {
    const v = injectVarName(h.host, "p");
    const uri = `/__st_inj_${h.host}.html`;
    const emptyUri = `/__st_empty_${h.host}.html`;
    // 拼接键：Sec-Fetch-Mode + X-Requested-With 一次判完（精确键优先，
    // 正则键兜底老式 XHR；无头请求 → default 0 = 注入，兼容 curl/老浏览器）
    injectMap = `map $http_sec_fetch_mode$http_x_requested_with $${v} {
  default 0;
  cors 1;
  no-cors 1;
  same-origin 1;
  '~XMLHttpRequest' 1;
}

`;
    injectServer = `    # 响应注入（prepend：仅主页面导航的 text/html；XHR/fetch/子资源不注入）
    location = ${uri} {
      internal;
      default_type text/html;
      root ${nginxRoot}/inject;
      if ($${v} = "1") { rewrite ^ ${emptyUri} last; }
    }
    location = ${emptyUri} {
      internal;
      default_type text/html;
      return 200 '';
    }

`;
    injectLoc = `      # 上游压缩会破坏注入的流式语义，统一要未压缩响应
      add_before_body ${uri};
      proxy_set_header Accept-Encoding "";
`;
  } else if (inject) {
    const v = injectVarName(h.host, "h");
    // default（含 navigate/无头 curl/老浏览器）→ 注入；cors/no-cors/same-origin
    // 与老式 XHR（正则键）→ 恒等 </head>（不注入）。
    injectMap = `map $http_sec_fetch_mode$http_x_requested_with $${v} {
  default ${nginxQuote(inject.html + "</head>")};
  cors '</head>';
  no-cors '</head>';
  same-origin '</head>';
  '~XMLHttpRequest' '</head>';
}

`;
    injectLoc = `      # 响应注入（head：仅主页面导航的 text/html 在 </head> 前插入；
      # XHR/fetch/子资源不注入——map 恒等 </head>）
      sub_filter '</head>' '$${v}';
      sub_filter_once on;
      sub_filter_types text/html;
      # sub_filter 无法匹配 gzip 内容——统一要未压缩响应
      proxy_set_header Accept-Encoding "";
`;
  }
  // 注入后重压回 gzip：nginx 过滤器链数据流向为 addition → sub_filter →
  // … → gzip → copy → chunked → write——gzip 压的是注入完成的合并输出，
  // 不会注坏也不会双重压缩（上游已 identity；客户端未带 Accept-Encoding
  // 时 nginx 自动跳过）。gzip_types 默认含 text/html，这里补齐被剥离压缩的
  // 常见文本子资源。
  if (inject && inject.recompress !== false) {
    injectLoc += `      gzip on;
      gzip_proxied any;
      gzip_vary on;
      gzip_types text/css application/javascript application/json image/svg+xml text/plain;
`;
  }
  // 认证放行白名单：不带 auth_request 的 location，直接转发应用（前缀匹配，
  // nginx 最长前缀优先 → 覆盖 location / 的 auth_request）。同样带注入（
  // 白名单路径的 HTML 页面也是直接请求的页面）。
  // app 上游地址按 targetHost 走（app 只绑 ::1 时 proxy_pass 指到 [::1]）。
  const appUpstream = `${h.scheme === "https" ? "https" : "http"}://${bracketHost(h.targetHost ?? "127.0.0.1")}:${h.port}`;
  const bypassBlock = (h.bypassPaths ?? [])
    .map((p) => {
      return `    location ${p} {
      proxy_pass ${appUpstream};
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
${injectLoc}    }

`;
    })
    .join("");
  return `${injectMap}  server {
    listen 127.0.0.1:${nginxPort};
    server_name ${escaped};
    access_log ${nginxRoot}/logs/${h.host}.access.log;
    error_log ${nginxRoot}/logs/${h.host}.error.log warn;

${injectServer}${whoServer}${bypassBlock}${authzBlock}${portalBlock}${setupBlock}${authFailBlock}    location / {
${authLine}
${injectLoc}      proxy_pass ${appUpstream};${h.scheme === "https" ? `
      proxy_ssl_verify off;
      proxy_ssl_server_name off;` : ""}
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      # WebSocket + SSE through the tunnel: HTTP/1.1 keep-alive + Upgrade
      # (WS would break on the default HTTP/1.0) + no buffering for SSE.
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header X-Accel-Buffering no;
    }
  }`;
}

/** Generate the MAIN gateway nginx.conf with ALL host server blocks inline
 *  (single config — reliable; per-host conf.d + reload had an nginx quirk in
 *  the gateway context where reload didn't serve newly-added hosts). */
export function generateGatewayNginx(cfg: GatewayConfig): string {
  const { nginxPort, hosts, nginxRoot } = cfg;
  const defaultServer = hosts.length
    ? ""
    : `  server {
    listen 127.0.0.1:${nginxPort};
    server_name _;
    return 444;
  }
`;

  return `worker_processes 1;
pid ${nginxRoot}/nginx.pid;
error_log ${nginxRoot}/error.log warn;
daemon off;
# nginx strips inherited env vars (keeps only TZ) unless listed here. The
# guardian finds framework helpers via SERVICE_TUNNELS_ROLE/MARKER in
# /proc/<pid>/environ — without these directives nginx loses them and the
# guardian can't reap nginx on parent death.
env SERVICE_TUNNELS_ROLE;
env SERVICE_TUNNELS_MARKER;

events {
  worker_connections 1024;
}

http {
  access_log ${nginxRoot}/access.log;
  client_max_body_size 0;
  proxy_buffering off;
  # nginx 四类临时文件（响应缓冲/请求体缓冲/fastcgi/uwsgi/scgi）编译默认都指向
  # /var/lib/nginx/*（只有系统 root nginx 可写）——我们以普通用户跑，不指自己
  # 的目录会在 [crit] Permission denied 处直接断流/500：
  #   proxy_temp:      上游响应超内存 buffer 时落盘（大文件 + 慢客户端如隧道
  #                    edge 流控必现：6.4MB 模型稳定截断在 ~2.5-3MB）
  #   client_body_temp: 请求体超 client_body_buffer(默认 8k/16k) 时落盘（大
  #                    POST 必现 500：face 验证 ~12KB 加密向量表单）
  #   fastcgi/uwsgi/scgi_temp: 本网关不用，但编译默认路径同病，一并指过来。
  proxy_temp_path ${nginxRoot}/proxy_temp;
  client_body_temp_path ${nginxRoot}/client_body_temp;
  fastcgi_temp_path ${nginxRoot}/fastcgi_temp;
  uwsgi_temp_path ${nginxRoot}/uwsgi_temp;
  scgi_temp_path ${nginxRoot}/scgi_temp;
  # public tunnel hostnames can be long (trycloudflare / ngrok-free-app);
  # the default 64-byte bucket overflows with several of them.
  server_names_hash_bucket_size 128;
  ${defaultServer}
  # each tunnel host is its own file (conf.d/<host>.conf), per-host logs
  include ${nginxRoot}/conf.d/*.conf;
}
`;
}

/** A process-alive check that rejects zombies. */
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

/** Pre-assign a free local port. */
async function pickFreePort(avoid?: number): Promise<number> {
  const { createServer } = await import("net");
  for (;;) {
    const p = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
    if (p !== avoid) return p;
  }
}

/** True when something accepts TCP on 127.0.0.1:port. */
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
    s.setTimeout(300, () => {
      s.destroy();
      resolve(false);
    });
  });
}

export interface GatewayControllerOptions {
  configDir: string;
  cacheDir: string;
  /** nginx binary path (resolved by tools/ensure; PATH + sbin default). */
  nginxBin?: string;
  /** 0 = random free port (default). */
  port?: number;
  /** htpasswd file for basic auth mode. */
  htpasswdFile?: string;
  basePath?: string;
  registerInternal: (role: string, port: number) => void;
  unregisterInternal: (role: string) => void;
  /** Called after nginx spawns (pid registration for cleanup). */
  registerPid?: (role: string, pid: number) => void;
  log?: (line: string) => void;
}

export class GatewayController {
  #opts: GatewayControllerOptions;
  #hosts = new Map<string, GatewayHost>();
  #child: ChildProcess | null = null;
  #pidFile = "";
  #nginxRoot = "";
  #port = 0;
  /** Default auth mode/basePath/htpasswd (per-host values win). */
  #authMode: GatewayAuthMode = "forward-auth";
  #htpasswdFile = "";
  /** 注入能力探测缓存（sub_filter / add_before_body 是否可用）。 */
  #injectCaps: { sub: boolean; addition: boolean } | null = null;

  constructor(opts: GatewayControllerOptions) {
    this.#opts = opts;
    this.#port = opts.port ?? 0;
    this.#htpasswdFile = opts.htpasswdFile ?? "";
    // per-parent (process.pid) nginx folder — multiple service-tunnels owners
    // (host instances) never share config/logs/pidfile; the folder is wiped
    // on construction so a fresh run starts clean.
    this.#nginxRoot = join(opts.cacheDir, "tmp", `nginx-${process.pid}`);
    rmSync(this.#nginxRoot, { recursive: true, force: true });
    this.#pidFile = join(this.#nginxRoot, "nginx.pid");
  }

  get port(): number {
    return this.#port;
  }

  get nginxBin(): string {
    return this.#opts.nginxBin ?? "nginx";
  }

  /** Resolve nginx binary with a helpful error when missing. */
  async resolveNginx(): Promise<string> {
    const bin = this.nginxBin;
    if (bin !== "nginx") {
      if (!existsSync(bin)) throw new Error(`nginx binary not found: ${bin}`);
      return bin;
    }
    const candidates = ["nginx", "/usr/sbin/nginx", "/usr/local/sbin/nginx", "/opt/homebrew/sbin/nginx"];
    for (const c of candidates) {
      try {
        if (c.includes("/")) {
          if (existsSync(c)) return c;
        } else {
          execFileSync("which", [c], { stdio: "ignore" });
          return c;
        }
      } catch {
        // try next
      }
    }
    throw new Error(
      "nginx not found (checked PATH and /usr/sbin). Install it (apt install nginx) or provide a path via toolPaths.nginx / gateway --nginx-bin.",
    );
  }

  hosts(): GatewayHost[] {
    return [...this.#hosts.values()];
  }

  /** Per-host nginx access/error log paths (for expose log viewing). */
  logPaths(host: string): { access: string; error: string } | null {
    if (!this.#hosts.has(host)) return null;
    return {
      access: join(this.#nginxRoot, "logs", `${host}.access.log`),
      error: join(this.#nginxRoot, "logs", `${host}.error.log`),
    };
  }

  /** True once the nginx worker is listening (shared-instance readiness). */
  async ready(): Promise<boolean> {
    return this.#port > 0 && (await tcpOpen(this.#port));
  }

  /** Write config + `nginx -t` validate (throws on invalid). Auth backend
   *  is per-host now, so no authPort argument. Single config with ALL hosts. */
  async writeConfig(): Promise<void> {
    mkdirSync(this.#nginxRoot, { recursive: true });
    mkdirSync(join(this.#nginxRoot, "logs"), { recursive: true });
    for (const d of ["proxy_temp", "client_body_temp", "fastcgi_temp", "uwsgi_temp", "scgi_temp"]) {
      mkdirSync(join(this.#nginxRoot, d), { recursive: true });
    }
    // 登录信息按钮（basic 模式回显端点）：空文件作 200 响应体
    mkdirSync(join(this.#nginxRoot, "empty"), { recursive: true });
    writeFileSync(join(this.#nginxRoot, "empty", "__st_auth__"), "", "utf8");
    mkdirSync(join(this.#nginxRoot, "conf.d"), { recursive: true });
    const cfg = generateGatewayNginx({
      nginxPort: this.#port,
      nginxRoot: this.#nginxRoot,
      hosts: this.hosts(),
    });
    const confPath = join(this.#nginxRoot, "nginx.conf");
    writeFileSync(confPath, cfg, "utf8");
    // per-host files in conf.d/ (each tunnel host its own server block + logs)
    for (const h of this.hosts()) {
      this.#writeHostFile(h);
    }
    const bin = await this.resolveNginx();
    execFileSync(bin, ["-t", "-c", confPath], { stdio: "ignore" });
  }

  /** 探测 nginx 二进制的注入模块能力（一次性，缓存）：用含目标指令的临时
   *  配置跑 `nginx -t`。缺模块时报错在 registerHost 时立刻暴露（而非
   *  writeConfig 时炸掉整个网关）。sub_filter 是标准构建默认模块；
   *  add_before_body 需要 --with-http_addition_module（精简构建可能缺）。 */
  async #probeInjectCaps(): Promise<{ sub: boolean; addition: boolean }> {
    if (this.#injectCaps) return this.#injectCaps;
    const bin = await this.resolveNginx();
    const root = join(this.#nginxRoot, "inject-probe");
    mkdirSync(root, { recursive: true });
    // nginx -t 会真实 bind listen 端口：用空闲高位端口（特权端口 <1024
    // 非 root 直接 EACCES，占用的高位端口会误报 EADDRINUSE）。
    const listenPort = await pickFreePort();
    const probe = (body: string): boolean => {
      const conf = [
        "worker_processes 1;",
        `pid ${root}/nginx.pid;`,
        `error_log ${root}/error.log crit;`,
        "events {}",
        "http {",
        "  access_log off;", // 默认 /var/log/nginx/access.log 非 root 不可写 → -t 失败
        "  server {",
        `    listen 127.0.0.1:${listenPort};`,
        body,
        "    location / { return 200 ok; }",
        "  }",
        "}",
        "",
      ].join("\n");
      const p = join(root, "probe.conf");
      writeFileSync(p, conf, "utf8");
      try {
        execFileSync(bin, ["-t", "-c", p], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    const sub = probe("    sub_filter '</head>' '<i></head>';");
    const addition = probe(
      "    add_before_body /__p;\n    location = /__p { internal; default_type text/html; return 200 '<i>'; }",
    );
    this.#injectCaps = { sub, addition };
    return this.#injectCaps;
  }

  /** Write/refresh one host's conf.d/<host>.conf (its own server block + its
   *  own access/error logs under logs/<host>.*). */
  #writeHostFile(h: GatewayHost): void {
    mkdirSync(join(this.#nginxRoot, "logs"), { recursive: true }); // host logs live here
    const body = generateHostNginx(h, {
      nginxPort: this.#port,
      nginxRoot: this.#nginxRoot,
      authPort: h.authPort,
      basePath: h.basePath,
      authMode: h.authMode ?? this.#authMode,
      htpasswdFile: h.htpasswdFile,
    });
    writeFileSync(join(this.#nginxRoot, "conf.d", `${h.host}.conf`), body, "utf8");
    // prepend 模式：把注入 HTML 写入 nginx 静态文件（add_before_body 子请求
    // 读取；host 已 sanitize，文件名安全）。
    const inj = normalizeInject(h.inject);
    if (inj?.position === "prepend") {
      mkdirSync(join(this.#nginxRoot, "inject"), { recursive: true });
      writeFileSync(join(this.#nginxRoot, "inject", `__st_inj_${h.host}.html`), inj.html, "utf8");
    }
    // 登录信息按钮：fab JS 写静态文件（map 参数长度限制 → 外链；见 user-fab.ts）。
    // cfg：basic 标记 + authelia 风格 logoutUrl（basePath/logout；portal 的
    // 回显 JSON 自带 logoutUrl 会覆盖静态值）。
    if (h.loginInfoButton === true) {
      mkdirSync(join(this.#nginxRoot, "fabjs"), { recursive: true });
      const cfg: { logoutUrl?: string; basic?: boolean } = {};
      if ((h.authMode ?? this.#authMode) === "basic") cfg.basic = true;
      else if (h.basePath) cfg.logoutUrl = `${h.basePath}/logout`;
      writeFileSync(join(this.#nginxRoot, "fabjs", "__st_fab__.js"), loginFabFile(cfg), "utf8");
    }
  }

  /** Validate a public host BEFORE it reaches any file path or nginx config.
   *  Hosts come from tunnel-edge URLs (external services) or the caller —
   *  never trust them: `new URL(...).host` happily yields `evil;{}` etc., and
   *  the host is interpolated into server_name / access_log / conf.d filenames.
   *  Accept bare domains only (optionally with :port, port is stripped).
   *  @returns the safe hostname (port stripped) or throws on invalid input. */
  #sanitizeHost(host: string): string {
    if (typeof host !== "string" || host.length === 0 || host.length > 253) {
      throw new Error(`invalid host: ${JSON.stringify(host)}`);
    }
    // strip :port (bore-style URLs synthesize host:port); hostnameOnly also
    // handles [ipv6]:port without mangling it (then rejected by the DNS
    // regex below — server_name is domain-only by design).
    const hostname = hostnameOnly(host);
    // bare DNS label: letters/digits/dots/hyphens only, no leading/trailing
    // dot or hyphen, no other punctuation (;{}'"\\/ whitespace all rejected)
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(hostname) || hostname.includes("..")) {
      throw new Error(`invalid host: ${JSON.stringify(host)}`);
    }
    return hostname.toLowerCase();
  }

  /** Register a host (with its auth backend) → write its conf.d file → restart. */
  async registerHost(
    host: string,
    port: number,
    auth?: { authPort?: number; basePath?: string; authMode?: GatewayAuthMode; htpasswdFile?: string; loginRedirect?: string; scheme?: "http" | "https"; setup?: GatewayHost["setup"]; bypassPaths?: string[]; site?: string; inject?: string | GatewayInject; loginInfoButton?: boolean; targetHost?: string },
  ): Promise<void> {
    const safe = this.#sanitizeHost(host);
    const inject = normalizeInject(auth?.inject);
    if (inject) {
      // 能力探测（一次性，缓存）：缺模块时在 registerHost 立刻报错，而不是
      // 让 writeConfig/nginx -t 炸掉整个网关。head 需要 sub_filter（标准构建
      // 默认有）；prepend 需要 addition 模块（--with-http_addition_module，
      // 部分精简构建/nginx-core 缺失）。
      const caps = await this.#probeInjectCaps();
      if (inject.position === "prepend") {
        if (!caps.addition) {
          throw new Error(
            `inject prepend on host ${safe}: nginx 缺 addition 模块（add_before_body，需 --with-http_addition_module）——改用 head 模式（position: "head"）或安装完整 nginx`,
          );
        }
      } else if (!caps.sub) {
        throw new Error(`inject on host ${safe}: nginx 缺 sub_filter 模块（ngx_http_sub_filter_module）——无法注入，请安装完整 nginx`);
      }
    }
    this.#hosts.set(safe, {
      host: safe,
      port,
      targetHost: auth?.targetHost,
      authPort: auth?.authPort,
      basePath: auth?.basePath,
      authMode: auth?.authMode ?? this.#authMode,
      htpasswdFile: auth?.htpasswdFile ?? (this.#htpasswdFile || undefined),
      loginRedirect: auth?.loginRedirect,
      scheme: auth?.scheme,
      setup: auth?.setup,
      bypassPaths: auth?.bypassPaths,
      site: auth?.site,
      inject: inject ?? undefined,
      loginInfoButton: auth?.loginInfoButton,
    });
    mkdirSync(join(this.#nginxRoot, "conf.d"), { recursive: true });
    this.#writeHostFile(this.#hosts.get(safe)!);
    await this.#restart();
  }

  async unregisterHost(host: string): Promise<void> {
    const safe = this.#sanitizeHost(host);
    this.#hosts.delete(safe);
    rmSync(join(this.#nginxRoot, "conf.d", `${safe}.conf`), { force: true });
    // 清理该 host 的注入文件（prepend 模式落盘的静态文件）
    rmSync(join(this.#nginxRoot, "inject", `__st_inj_${safe}.html`), { force: true });
    await this.#restart();
  }

  /** HARD restart nginx (kill + respawn) so the conf.d host files are read
   *  fresh — `nginx -s reload` does NOT reliably pick up newly-added conf.d
   *  files in this environment (host never served, fell to the 444 default).
   *  A fresh start reads conf.d correctly. */
  async #restart(): Promise<void> {
    await this.writeConfig(); // regenerate main + host files + nginx -t
    if (!this.#child || !alive(this.#child.pid ?? 0)) {
      return; // nginx not running yet — start() will pick the config up
    }
    const bin = await this.resolveNginx();
    const confPath = join(this.#nginxRoot, "nginx.conf");
    // stop old master (SIGTERM, wait, SIGKILL)
    const old = this.#child;
    try {
      old.kill("SIGTERM");
    } catch {}
    this.#child = null;
    if (old.pid) {
      const dl = Date.now() + 1500;
      while (Date.now() < dl && alive(old.pid)) await new Promise((r) => setTimeout(r, 50));
      try { if (alive(old.pid)) old.kill("SIGKILL"); } catch {}
    }
    // spawn fresh (same as start())
    const child = spawn(bin, ["-c", confPath], {
      env: { ...process.env, ...roleEnv("nginx") },
      stdio: ["ignore", "ignore", "ignore"],
    });
    this.#child = child;
    this.#opts.log?.(`nginx restart (${this.#hosts.size} hosts)`);
    await new Promise((r) => setTimeout(r, 300));
  }

  /** Green start: pick port, write config, spawn nginx, register internal. */
  async start(authMode?: GatewayAuthMode): Promise<number> {
    if (authMode) this.#authMode = authMode;
    if (this.#child && alive(this.#child.pid ?? 0) && (await tcpOpen(this.#port))) {
      return this.#port;
    }
    if (!this.#port) this.#port = await pickFreePort();
    rmSync(this.#pidFile, { force: true });
    await this.writeConfig();
    const bin = await this.resolveNginx();
    const confPath = join(this.#nginxRoot, "nginx.conf");
    // stdio MUST be "ignore" (not pipes): with `daemon off` + pipe stdio the
    // nginx worker doesn't serve requests (Empty reply). nginx stderr goes to
    // its own error.log in the config.
    const child = spawn(bin, ["-c", confPath], {
      env: { ...process.env, ...roleEnv("nginx") },
      stdio: ["ignore", "ignore", "ignore"],
    });
    this.#child = child;
    this.#opts.registerPid?.("nginx", child.pid ?? 0);
    this.#opts.registerInternal("nginx", this.#port);
    this.#opts.log?.(`nginx gateway on 127.0.0.1:${this.#port}`);
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null) {
      this.#child = null;
      throw new Error(`nginx gateway exited during startup (${child.exitCode}) — port ${this.#port} likely in use`);
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await tcpOpen(this.#port))) {
      if (child.exitCode !== null) {
        this.#child = null;
        throw new Error(`nginx gateway exited during startup (${child.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await tcpOpen(this.#port))) throw new Error("nginx gateway failed to start");
    return this.#port;
  }

  /** Stop nginx (config stays for next start). */
  async stop(): Promise<void> {
    if (this.#child) {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        // gone
      }
      this.#child = null;
    } else if (existsSync(this.#pidFile)) {
      try {
        const pid = Number(readFileSync(this.#pidFile, "utf8").trim());
        process.kill(pid, "SIGTERM");
      } catch {
        // gone
      }
    }
    this.#opts.unregisterInternal("nginx");
    rmSync(this.#pidFile, { force: true });
  }
}
