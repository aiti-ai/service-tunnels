/**
 * oauth2-proxy × nginx 网关（tunnel 模式路径）实测：
 *  - 域名验证文件 / 预登录设置页由 nginx location 免认证直接渲染
 *  - 完整登录链：/ → /oauth2-setup → 继续登录 → IdP(回调白名单+域名验证) → callback → app
 * 运行：node --experimental-strip-types scripts/test-oauth2-gateway.mjs
 */
import { startMockIdp } from "./mock-idp.mjs";
import { GatewayController } from "../src/gateway.ts";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOG = (tag, s) => console.log(`[${tag}] ${s}`);
const TMP = join(tmpdir(), `st-o2g-${process.pid}`);
mkdirSync(TMP, { recursive: true });

const idp = await startMockIdp();
LOG("C", `mock IdP: ${idp.issuer} 验证文件 ${idp.verificationPath} → ${idp.verificationContent}`);

// 侧车（与 provider 生成的 conf 一致）
const sidecarPort = 19095;
writeFileSync(join(TMP, "oauth2-proxy.conf"), [
  `http_address = "127.0.0.1:${sidecarPort}"`,
  `upstreams = ["static://200"]`,
  `provider = "oidc"`,
  `oidc_issuer_url = "${idp.issuer}"`,
  `client_id = "test-client"`,
  `client_secret = "test-secret"`,
  `cookie_secret = "0123456789abcdef0123456789abcdef"`,
  `email_domains = ["*"]`,
  `set_xauthrequest = true`,
  `cookie_secure = false`,
].join("\n"), "utf8");
const sidecar = spawn("oauth2-proxy", ["--config", join(TMP, "oauth2-proxy.conf")], { stdio: ["ignore", "pipe", "pipe"] });
sidecar.stderr.on("data", () => {});
// 等侧车就绪（TCP 探针）
const { connect } = await import("node:net");
for (let i = 0; i < 40; i++) {
  const ok = await new Promise((r) => {
    const s = connect(sidecarPort, "127.0.0.1");
    s.once("connect", () => { s.destroy(); r(true); });
    s.once("error", () => { s.destroy(); r(false); });
    s.setTimeout(300, () => { s.destroy(); r(false); });
  });
  if (ok) break;
  await new Promise((r) => setTimeout(r, 200));
}

// app
const app = createServer((q, s) => s.end("app-ok"));
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const appPort = app.address().port;

// 本地 host：127.0.0.1 直连 nginx（模拟隧道入口；loginRedirect 用 http 便于本地）
const HOST = "127.0.0.1";

const gw = new GatewayController({
  configDir: join(TMP, "config"),
  cacheDir: join(TMP, "cache"),
  port: 0,
  registerInternal: () => {},
  unregisterInternal: () => {},
  log: () => {},
});
await gw.start("oauth2-proxy");
const nginxPort = gw.port;
const setup = {
  verification: [{ path: idp.verificationPath, content: idp.verificationContent }],
  infoPath: "/oauth2-setup",
  // 本地直测：重定向/模板用显式端口（真实隧道 $host 无端口，由 scheme 隐含）
  infoHtmlTemplate:
    `<h2>OAuth2 登录前设置（nginx）</h2><p>回调：http://127.0.0.1:${nginxPort}/oauth2/callback</p>` +
    `<p>验证文件：http://127.0.0.1:${nginxPort}${idp.verificationPath} → ${idp.verificationContent}</p>` +
    `<a href="/oauth2/start?rd=$arg_rd">继续登录</a>`,
};
await gw.registerHost(HOST, appPort, {
  authMode: "oauth2-proxy",
  authPort: sidecarPort,
  loginRedirect: `http://127.0.0.1:${nginxPort}/oauth2-setup?rd=$request_uri`,
  scheme: "http",
  setup,
  bypassPaths: ["/health", "/metrics"],
});
LOG("C", `nginx :${nginxPort} host=${HOST} → app :${appPort} sidecar :${sidecarPort}`);

// HTTP 客户端（localhost → 127.0.0.1 直连 + cookie jar）
const jar = new Map();
function req(url) {
  return new Promise((res2, rej) => {
    const u = new URL(url);
    const h = { host: u.host };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = httpRequest({ host: "127.0.0.1", port: +u.port, path: u.pathname + u.search, headers: h }, (s) => {
      (s.headers["set-cookie"] ?? []).forEach((line) => {
        const eq = line.indexOf("="), semi = line.indexOf(";");
        jar.set(line.slice(0, eq), line.slice(eq + 1, semi === -1 ? undefined : semi));
      });
      let b = ""; s.on("data", (c) => (b += c)); s.on("end", () => res2({ status: s.statusCode, loc: s.headers.location ?? null, b: b.slice(0, 300) }));
    });
    r.on("error", rej); r.end();
  });
}
const base = `http://127.0.0.1:${nginxPort}`;

// 1) 域名验证文件（IdP 风格抓取，免认证）
const vf = await req(`${base}${idp.verificationPath}`);
LOG("C", `验证文件 → ${vf.status} ${JSON.stringify(vf.b)}`);
const vfOk = vf.status === 200 && vf.b === idp.verificationContent;
if (!vfOk) { LOG("C", "❌ FAIL: nginx 验证文件"); process.exitCode = 1; }

// 1.5) 白名单放行：/health 免认证直达 app（无 cookie、无重定向）
const health = await req(`${base}/health`);
LOG("C", `白名单 /health → ${health.status} ${JSON.stringify(health.b)}`);
if (health.status !== 200 || !health.b.includes("app-ok")) {
  LOG("C", "❌ FAIL: nginx 白名单路径未放行");
  process.exitCode = 1;
}

// 2) 预登录设置页（免认证，$host 渲染）
const setupPage = await req(`${base}/oauth2-setup?rd=/`);
LOG("C", `设置页 → ${setupPage.status} 含回调=${setupPage.b.includes("/oauth2/callback")} 含继续登录=${setupPage.b.includes("/oauth2/start?rd=")}`);
const setupOk = setupPage.status === 200 && setupPage.b.includes("/oauth2/callback");
if (!setupOk) { LOG("C", "❌ FAIL: nginx 设置页"); process.exitCode = 1; }

// 3) 完整登录链（注册回调后）
const cbUrl = `${base}/oauth2/callback`;
idp.registerCallback(cbUrl);
const flow = await (async () => {
  let cur = `${base}/`;
  const hops = [];
  for (let i = 0; i < 12; i++) {
    const r = await req(cur);
    hops.push(`${r.status}→${r.loc ?? ""}`);
    // 设置页：模拟点击「继续登录」链接
    if (r.status === 200 && cur.includes("/oauth2-setup") && r.b.includes("/oauth2/start?rd=")) {
      const m = r.b.match(/href="([^"]*\/oauth2\/start[^"]*)"/);
      if (m) { cur = new URL(m[1], cur).href; continue; }
    }
    if (!r.loc) return { status: r.status, b: r.b, hops };
    cur = new URL(r.loc, cur).href;
  }
  return { status: 0, b: "", hops };
})();
LOG("C", `登录链: ${flow.hops.join("  |  ")}`);
LOG("C", `最终: ${flow.status} ${JSON.stringify(flow.b)}`);
if (flow.status === 200 && flow.b.includes("app-ok")) {
  LOG("C", "✅ PASS: nginx 网关完整链（验证文件/设置页免认证 + 登录 + 放行 app）");
} else {
  LOG("C", "❌ FAIL: nginx 登录链未到 app");
  process.exitCode = 1;
}

await gw.stop().catch(() => {});
app.close();
sidecar.kill("SIGKILL");
idp.close();
