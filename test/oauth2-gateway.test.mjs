/**
 * oauth2-proxy × nginx 网关（tunnel 模式路径）实测（node:test 版，接入 `npm test`）：
 *  - 域名验证文件 / 预登录设置页由 nginx location 免认证直接渲染
 *  - 完整登录链：/ → /oauth2-setup → 继续登录 → IdP(回调白名单+域名验证) → callback → app
 *
 * 外部依赖：nginx + oauth2-proxy 二进制，任一缺失即 t.skip（不触发下载）。
 * nginx 判定走库自身 resolveNginx()（PATH 之外还可能 /usr/sbin/nginx 等）。
 * 端口全部随机（GatewayController port: 0、pickFreePort），与并行测试互不冲突。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockIdp } from "../scripts/mock-idp.mjs";

const LOG = (tag, s) => console.log(`[${tag}] ${s}`);

function hasBin(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = httpServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitTcp(port, tries = 40, gap = 200) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((r) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); r(true); });
      s.once("error", () => { s.destroy(); r(false); });
      s.setTimeout(300, () => { s.destroy(); r(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, gap));
  }
  return false;
}

test("oauth2-proxy × nginx 网关：验证文件/设置页免认证 + 登录链放行 app", { timeout: 90_000 }, async (t) => {
  if (!hasBin("oauth2-proxy")) {
    t.skip("oauth2-proxy binary not installed");
    return;
  }

  const { GatewayController } = await import("../src/gateway.ts");
  const TMP = mkdtempSync(join(tmpdir(), `st-o2g-`));
  const gw = new GatewayController({
    configDir: join(TMP, "config"),
    cacheDir: join(TMP, "cache"),
    port: 0,
    registerInternal: () => {},
    unregisterInternal: () => {},
    log: () => {},
  });
  // nginx 可能在 PATH 之外（如 /usr/sbin/nginx）——用库自身的解析判定
  try {
    await gw.resolveNginx();
  } catch {
    t.skip("nginx not installed");
    return;
  }

  const idp = await startMockIdp();
  LOG("C", `mock IdP: ${idp.issuer} 验证文件 ${idp.verificationPath} → ${idp.verificationContent}`);

  // 侧车（与 provider 生成的 conf 一致）
  const sidecarPort = await pickFreePort();
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
  assert.ok(await waitTcp(sidecarPort), "oauth2-proxy 侧车未就绪");

  // app
  const app = httpServer((q, s) => s.end("app-ok"));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const appPort = app.address().port;

  await gw.start("oauth2-proxy");
  const nginxPort = gw.port;

  // 本地 host：127.0.0.1 直连 nginx（模拟隧道入口；loginRedirect 用 http 便于本地）
  const HOST = "127.0.0.1";
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
  t.after(async () => {
    await gw.stop().catch(() => {});
    app.close();
    sidecar.kill("SIGKILL");
    idp.close();
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
  assert.equal(vf.status, 200, "nginx 验证文件未返回 200");
  assert.equal(vf.b, idp.verificationContent, "nginx 验证文件内容不符");

  // 1.5) 白名单放行：/health 免认证直达 app（无 cookie、无重定向）
  const health = await req(`${base}/health`);
  LOG("C", `白名单 /health → ${health.status} ${JSON.stringify(health.b)}`);
  assert.equal(health.status, 200, "nginx 白名单路径未放行");
  assert.ok(health.b.includes("app-ok"), "nginx 白名单未直达应用");

  // 2) 预登录设置页（免认证，$host 渲染）
  const setupPage = await req(`${base}/oauth2-setup?rd=/`);
  LOG("C", `设置页 → ${setupPage.status} 含回调=${setupPage.b.includes("/oauth2/callback")} 含继续登录=${setupPage.b.includes("/oauth2/start?rd=")}`);
  assert.equal(setupPage.status, 200, "nginx 设置页不可达");
  assert.ok(setupPage.b.includes("/oauth2/callback"), "nginx 设置页缺回调地址");
  assert.ok(setupPage.b.includes("/oauth2/start?rd="), "nginx 设置页缺继续登录链接");

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
  assert.equal(flow.status, 200, `nginx 登录链未到 app（最终 ${flow.status}）`);
  assert.ok(flow.b.includes("app-ok"), "nginx 登录后未放行到应用");
  LOG("C", "✅ PASS: nginx 网关完整链（验证文件/设置页免认证 + 登录 + 放行 app）");
});
