/**
 * oauth2-proxy provider 实测：
 *  A) 侧车直连（mock IdP + oauth2-proxy 独立进程）—— 验证配置/二进制本身可用
 *  B) 库集成（st.auth.expose mode=proxy, auth=oauth2-proxy）—— 验证接线是否真的通
 */
import { startMockIdp } from "./mock-idp.mjs";
import { createServiceTunnels } from "../src/index.ts";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), `st-oauth2-test-${process.pid}`);

const LOG = (tag, s) => console.log(`[${tag}] ${s}`);

/** 最小 cookie-jar HTTP 客户端：自动记录 set-cookie，跟随重定向（带主机头）。 */
function client() {
  const jar = new Map();
  function req(method, url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      // *.localhost 在本测试机不解析 → 连接到回环，但 Host 头保留 vhost
      const connHost = /(^|\.)localhost$/.test(u.hostname) ? "127.0.0.1" : u.hostname;
      const headers = { ...extraHeaders, host: extraHeaders.host ?? u.host };
      if (jar.size) {
        headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      }
      const r = httpRequest(
        { host: connHost, port: Number(u.port || 80), path: u.pathname + u.search, method, headers },
        (res) => {
      const sc = (res.headers["set-cookie"] ?? []).map((line) => {
        // 只切第一个 = 与第一个 ;（cookie 值可能含 base64 填充 = 和 | 分隔符）
        const eq = line.indexOf("=");
        const semi = line.indexOf(";");
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1, semi === -1 ? undefined : semi);
        return [k, v];
      });
      for (const [k, v] of sc) jar.set(k, v);
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location ?? null, body }));
        },
      );
      r.on("error", reject);
      r.end();
    });
  }
  return {
    jar,
    req,
    /** 跟随重定向直到稳定（返回最后一条响应 + 跳数）。 */
    async follow(method, url, max = 8) {
      let cur = url, hops = [];
      for (let i = 0; i < max; i++) {
        const r = await req(method, cur);
        hops.push({ status: r.status, to: r.location ?? "" });
        if (!r.location) return { ...r, hops };
        cur = new URL(r.location, cur).href;
      }
      return { status: 0, location: null, body: "LOOP", hops };
    },
  };
}

// ── A) 侧车直连 ──────────────────────────────────────────────────────────────
const idp = await startMockIdp();
LOG("A", `mock IdP 就绪: ${idp.issuer}`);

const dir = join(TMP, "sidecar");
mkdirSync(dir, { recursive: true });
const cookieSecret = "0123456789abcdef0123456789abcdef";
const sidecarPort = 19090;
writeFileSync(
  join(dir, "oauth2-proxy.conf"),
  [
    `http_address = "127.0.0.1:${sidecarPort}"`,
    `upstreams = ["static://200"]`,
    `provider = "oidc"`,
    `oidc_issuer_url = "${idp.issuer}"`,
    `client_id = "test-client"`,
    `client_secret = "test-secret"`,
    `cookie_secret = "${cookieSecret}"`,
    `email_domains = ["*"]`,
    `set_xauthrequest = true`,
    `cookie_secure = false`,
  ].join("\n") + "\n",
  "utf8",
);

const sidecar = spawn("oauth2-proxy", ["--config", join(dir, "oauth2-proxy.conf")], {
  stdio: ["ignore", "pipe", "pipe"],
});
sidecar.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
await new Promise((r) => setTimeout(r, 1500)); // 等启动（含 discovery 拉取）

const base = `http://127.0.0.1:${sidecarPort}`;
const c = client();

// 未登录直接打 authz 端点（gateway/node 探针会打的路径）
const probe = await c.req("GET", `${base}/api/authz/auth-request`, { host: "127.0.0.1:19090" });
LOG("A", `直连探针 /api/authz/auth-request（authelia 协议路径）→ ${probe.status} ${probe.location ?? ""}`);

const authzReal = await c.req("GET", `${base}/oauth2/auth`, { host: "127.0.0.1:19090" });
LOG("A", `oauth2-proxy 真实端点 /oauth2/auth → ${authzReal.status} ${authzReal.location ?? ""}`);

// 完整浏览器流程（从 /oauth2/start 发起，与网关重定向目标一致）
const full = await c.follow("GET", `${base}/oauth2/start?rd=/`, 8);
LOG("A", `侧车完整登录流程: ${full.hops.map((h) => `${h.status}→${h.to}`).join("  |  ")}`);
if (full.status === 200) LOG("A", "✅ PASS: 侧车 + mock IdP 登录舞步完整（static 上游返回 200）");
else {
  LOG("A", `❌ FAIL: 侧车登录未完成（最终 ${full.status}）`);
  process.exitCode = 1;
}
const authed = await c.req("GET", `${base}/oauth2/auth`, { host: "127.0.0.1:19090" });
LOG("A", `登录后 /oauth2/auth → ${authed.status}（204=放行，401=仍拒绝）`);

// ── B) 库集成（mode=proxy） ──────────────────────────────────────────────────
const st = createServiceTunnels({
  cacheDir: join(TMP, "cache"),
  configDir: join(TMP, "config"),
  log: (m) => process.stderr.write(`[st-log] ${m}\n`),
});
const app = await (async () => {
  const { createServer } = await import("node:http");
  const s = createServer((req, res) => res.end("app-ok"));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s;
})();
const appPort = app.address().port;
LOG("B", `app 端口: ${appPort}`);

try {
  const res = await st.auth.expose(appPort, {
    mode: "proxy",
    auth: "oauth2-proxy",
    providerParams: {
      "oidc.issuerUrl": idp.issuer,
      "oidc.clientId": "test-client",
      "oidc.clientSecret": "test-secret",
      "oidc.cookieSecret": cookieSecret,
      // 预登录设置页 + 域名验证文件（用 mock IdP 生成的随机串）
      "oidc.setup.infoPage": true,
      "oidc.setup.verification.0.path": idp.verificationPath,
      "oidc.setup.verification.0.content": idp.verificationContent,
    },
    // 认证放行白名单：/health 与 /metrics 免认证直达应用
    bypassPaths: ["/health", "/metrics"],
  });
  LOG("B", `expose → localUrl=${res.localUrl} provider=${res.provider}`);
  const c2 = client();

  // 0.5) 白名单放行：/health 直接 200 app-ok（无 cookie、无重定向）
  const health = await c2.req("GET", new URL("/health", res.localUrl).href);
  LOG("B", `白名单 /health → ${health.status} ${JSON.stringify(health.body)}（无 cookie）`);
  if (health.status !== 200 || !health.body.includes("app-ok")) {
    LOG("B", `❌ FAIL: 白名单路径未放行`);
    process.exitCode = 1;
  }

  // 0) 域名验证文件：proxy 免认证直接返回随机串
  const vf = await c2.req("GET", new URL(idp.verificationPath, res.localUrl).href);
  LOG("B", `验证文件 ${idp.verificationPath} → ${vf.status} ${JSON.stringify(vf.body)}`);
  if (vf.status !== 200 || vf.body !== idp.verificationContent) {
    LOG("B", `❌ FAIL: 域名验证文件未按预期返回`);
    process.exitCode = 1;
  }

  // 1) 未登录访问 / → 应先跳到预登录设置页 /oauth2-setup?rd=/（而不是直接 oauth2-proxy）
  const hop1 = await c2.req("GET", res.localUrl);
  LOG("B", `GET / → ${hop1.status} ${hop1.location ?? ""}`);
  if (hop1.status !== 302 || !(hop1.location ?? "").includes("/oauth2-setup?rd=")) {
    LOG("B", `❌ FAIL: 未先跳预登录设置页`);
    process.exitCode = 1;
  }

  // 2) 设置页：显示回调地址 + 验证文件清单 + 继续登录链接
  const setup = await c2.req("GET", new URL(hop1.location, res.localUrl).href);
  LOG("B", `设置页 → ${setup.status}（含回调=${setup.body.includes("/oauth2/callback")} 含验证文件=${setup.body.includes(idp.verificationPath)}）`);
  if (setup.status !== 200 || !setup.body.includes("/oauth2/callback") || !setup.body.includes("/oauth2/start?rd=")) {
    LOG("B", `❌ FAIL: 设置页内容不完整`);
    process.exitCode = 1;
  }

  // 3) 模拟用户：把动态回调填入 IdP（白名单）→ 点“继续登录” → IdP 授权（验证域名）→ 回调 → app
  const cbUrl = `${new URL(res.localUrl).origin}/oauth2/callback`;
  idp.registerCallback(cbUrl);
  LOG("B", `已注册回调: ${cbUrl}`);
  const startUrl = new URL("/oauth2/start?rd=/", res.localUrl).href;
  const flow = await c2.follow("GET", startUrl, 10);
  LOG("B", `登录流程: ${flow.hops.map((h) => `${h.status}→${h.to}`).join("  |  ")}`);
  LOG("B", `最终: ${flow.status} body=${JSON.stringify(flow.body)}`);
  if (flow.status === 200 && flow.body.includes("app-ok")) {
    LOG("B", "✅ PASS: 设置页 → 回调白名单 → 域名验证 → IdP 登录 → 带 cookie 放行 → 应用 200");
  } else {
    LOG("B", `❌ FAIL: 未到达应用 200（最终 ${flow.status}）`);
    process.exitCode = 1;
  }
} catch (err) {
  LOG("B", `expose 失败: ${err.message}`);
} finally {
  await st.shutdown().catch(() => {});
  app.close();
  sidecar.kill("SIGKILL");
  idp.close();
}
