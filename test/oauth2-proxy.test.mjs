/**
 * oauth2-proxy provider 实测（node:test 版，接入 `npm test`）：
 *  A) 侧车直连（mock IdP + oauth2-proxy 独立进程）—— 验证配置/二进制本身可用
 *  B) 库集成（st.auth.expose mode=proxy, auth=oauth2-proxy）—— 验证接线是否真的通
 *
 * 外部依赖：oauth2-proxy 二进制。缺失时 t.skip（resolveToolPath 只查
 * PATH / SERVICE_TUNNELS_TOOLPATHS / 工具缓存，绝不触发网络下载）。
 * mock IdP 为内置（scripts/mock-idp.mjs，node:crypto 自产 RSA，零外部依赖）。
 * 端口全部随机（pickFreePort / proxyPort: 0），与并行测试互不冲突。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockIdp } from "../scripts/mock-idp.mjs";

const LOG = (tag, s) => console.log(`[${tag}] ${s}`);

function tempDirs(tag) {
  const base = mkdtempSync(join(tmpdir(), `st-${tag}-`));
  return { base, cacheDir: join(base, "cache"), configDir: join(base, "config") };
}

/** 随机空闲端口（AGENTS.md：e2e 勿用固定端口）。 */
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

/** 等 TCP 端口就绪（oauth2-proxy 启动探测）。 */
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

/** oauth2-proxy 本机可用（PATH/TOOLPATHS/缓存）→ 路径；否则 null。 */
async function oauth2ProxyBin(cacheDir) {
  const { resolveToolPath, readEnvToolPaths } = await import("../src/tools.ts");
  return resolveToolPath("oauth2-proxy", { cacheDir, toolPaths: readEnvToolPaths() });
}

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
test("oauth2-proxy 侧车直连 mock IdP（A 部分）", { timeout: 60_000 }, async (t) => {
  const dirs = tempDirs("o2p-sidecar");
  const bin = await oauth2ProxyBin(dirs.cacheDir);
  if (!bin) {
    rmSync(dirs.base, { recursive: true, force: true });
    t.skip("oauth2-proxy binary not installed");
    return;
  }

  const idp = await startMockIdp();
  LOG("A", `mock IdP 就绪: ${idp.issuer}`);
  const sidecarPort = await pickFreePort();
  writeFileSync(
    join(dirs.base, "oauth2-proxy.conf"),
    [
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
    ].join("\n") + "\n",
    "utf8",
  );
  const sidecar = spawn(bin, ["--config", join(dirs.base, "oauth2-proxy.conf")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  sidecar.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
  t.after(async () => {
    sidecar.kill("SIGKILL");
    idp.close();
    rmSync(dirs.base, { recursive: true, force: true });
  });
  assert.ok(await waitTcp(sidecarPort), "oauth2-proxy sidecar 未在时限内就绪");

  const base = `http://127.0.0.1:${sidecarPort}`;
  const c = client();

  // 未登录直接打 authz 端点（gateway/node 探针会打的路径）
  const probe = await c.req("GET", `${base}/api/authz/auth-request`, { host: `127.0.0.1:${sidecarPort}` });
  LOG("A", `未登录探针 /api/authz/auth-request → ${probe.status}`);
  assert.ok(probe.status === 401 || probe.status === 403, `未登录探针应拒绝，实际 ${probe.status}`);

  // 完整浏览器流程（从 /oauth2/start 发起，与网关重定向目标一致）
  const full = await c.follow("GET", `${base}/oauth2/start?rd=/`, 8);
  LOG("A", `侧车完整登录流程: ${full.hops.map((h) => `${h.status}→${h.to}`).join("  |  ")}`);
  assert.equal(full.status, 200, `侧车登录未完成（最终 ${full.status}）`);
  LOG("A", "✅ PASS: 侧车 + mock IdP 登录舞步完整（static 上游返回 200）");

  const authed = await c.req("GET", `${base}/oauth2/auth`, { host: `127.0.0.1:${sidecarPort}` });
  LOG("A", `登录后 /oauth2/auth → ${authed.status}（204=放行，401=仍拒绝）`);
});

// ── B) 库集成（mode=proxy） ──────────────────────────────────────────────────
test("库集成: st.auth.expose mode=proxy auth=oauth2-proxy（B 部分）", { timeout: 90_000 }, async (t) => {
  const dirs = tempDirs("o2p-lib");
  const bin = await oauth2ProxyBin(dirs.cacheDir);
  if (!bin) {
    rmSync(dirs.base, { recursive: true, force: true });
    t.skip("oauth2-proxy binary not installed");
    return;
  }

  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({
    cacheDir: dirs.cacheDir,
    configDir: dirs.configDir,
    log: (m) => process.stderr.write(`[st-log] ${m}\n`),
  });
  const app = httpServer((req, res) => res.end("app-ok"));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const appPort = app.address().port;
  const idp = await startMockIdp();
  const cookieSecret = "0123456789abcdef0123456789abcdef";
  t.after(async () => {
    await st.shutdown().catch(() => {});
    app.close();
    idp.close();
    rmSync(dirs.base, { recursive: true, force: true });
  });
  LOG("B", `app 端口: ${appPort}`);

  const res = await st.auth.expose(appPort, {
    mode: "proxy",
    proxyPort: 0, // 随机端口，避免与并行测试争 4180
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
  assert.equal(health.status, 200, "白名单路径未放行");
  assert.ok(health.body.includes("app-ok"), "白名单未直达应用");

  // 0) 域名验证文件：proxy 免认证直接返回随机串
  const vf = await c2.req("GET", new URL(idp.verificationPath, res.localUrl).href);
  LOG("B", `验证文件 ${idp.verificationPath} → ${vf.status} ${JSON.stringify(vf.body)}`);
  assert.equal(vf.status, 200, "域名验证文件未按预期返回");
  assert.equal(vf.body, idp.verificationContent, "验证文件内容不符");

  // 1) 未登录访问 / → 应先跳到预登录设置页 /oauth2-setup?rd=/（而不是直接 oauth2-proxy）
  const hop1 = await c2.req("GET", res.localUrl);
  LOG("B", `GET / → ${hop1.status} ${hop1.location ?? ""}`);
  assert.equal(hop1.status, 302, "未先跳预登录设置页");
  assert.ok((hop1.location ?? "").includes("/oauth2-setup?rd="), "未跳 /oauth2-setup?rd=");

  // 2) 设置页：显示回调地址 + 验证文件清单 + 继续登录链接
  const setup = await c2.req("GET", new URL(hop1.location, res.localUrl).href);
  LOG("B", `设置页 → ${setup.status}（含回调=${setup.body.includes("/oauth2/callback")} 含验证文件=${setup.body.includes(idp.verificationPath)}）`);
  assert.equal(setup.status, 200, "设置页不可达");
  assert.ok(setup.body.includes("/oauth2/callback"), "设置页缺回调地址");
  assert.ok(setup.body.includes("/oauth2/start?rd="), "设置页缺继续登录链接");

  // 3) 模拟用户：把动态回调填入 IdP（白名单）→ 点“继续登录” → IdP 授权（验证域名）→ 回调 → app
  const cbUrl = `${new URL(res.localUrl).origin}/oauth2/callback`;
  idp.registerCallback(cbUrl);
  LOG("B", `已注册回调: ${cbUrl}`);
  const startUrl = new URL("/oauth2/start?rd=/", res.localUrl).href;
  const flow = await c2.follow("GET", startUrl, 10);
  LOG("B", `登录流程: ${flow.hops.map((h) => `${h.status}→${h.to}`).join("  |  ")}`);
  LOG("B", `最终: ${flow.status} body=${JSON.stringify(flow.body)}`);
  assert.equal(flow.status, 200, `未到达应用 200（最终 ${flow.status}）`);
  assert.ok(flow.body.includes("app-ok"), "未放行到应用");
  LOG("B", "✅ PASS: 设置页 → 回调白名单 → 域名验证 → IdP 登录 → 带 cookie 放行 → 应用 200");
});
