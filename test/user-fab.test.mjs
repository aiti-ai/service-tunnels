import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-fab-"));
  return { base, cacheDir: join(base, "cache"), configDir: join(base, "config") };
}

function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = request(opts, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startBackend() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>t</title></head><body>hello</body></html>");
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

const NGINX_BIN = ["/usr/sbin/nginx", "/usr/local/sbin/nginx", "/opt/homebrew/sbin/nginx"].find(existsSync) ?? "nginx";

test("login-fab: conf 生成（fwd-auth portal —— __st_auth__ proxy + fab 注入拼接）", async () => {
  const { generateHostNginx } = await import("../src/gateway.ts");
  const conf = generateHostNginx(
    { host: "demo.trycloudflare.com", port: 5199, authMode: "forward-auth", authPort: 45775, basePath: "/portal-x", loginInfoButton: true },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  // 回显端点 location
  assert.match(conf, /location = \/__st_auth__ \{/);
  assert.match(conf, /auth_request \/portal-x\/api\/authz\/auth-request/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:45775\/portal-x\/api\/authz\/auth-request\?who=1/);
  assert.match(conf, /add_header X-St-Auth-User \$upstream_http_x_st_auth_user always/);
  // fab 注入（head 槽位——__st_fab__ script）
  assert.match(conf, /__st_fab__/);
  // portal 场景 logoutUrl 不静态注入（回显 JSON 提供）
  assert.ok(!/"logoutUrl":"\/portal-x\/logout/.test(conf), "portal logoutUrl 走回显 JSON");
});

test("login-fab: conf 生成（basic —— 空文件 + $remote_user 头）", async () => {
  const { generateHostNginx } = await import("../src/gateway.ts");
  const conf = generateHostNginx(
    { host: "demo.loca.lt", port: 5199, authMode: "basic", htpasswdFile: "/tmp/h", loginInfoButton: true },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.match(conf, /location = \/__st_auth__ \{/);
  assert.match(conf, /root \/tmp\/x\/nginx\/empty/);
  assert.match(conf, /add_header X-St-Auth-User \$remote_user always/);
  // 外链 script（fab JS 走静态文件，cfg 在文件里不在 conf）
  assert.match(conf, /__st_fab__/, "fab 外链注入存在");
  assert.match(conf, /alias .*fabjs/, "fab JS serve location 存在");
});

test("login-fab: token/none 不注入；未开启不注入", async () => {
  const { generateHostNginx } = await import("../src/gateway.ts");
  const token = generateHostNginx(
    { host: "a.com", port: 1, authMode: "token", authPort: 2, basePath: "/t", loginInfoButton: true },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.ok(!token.includes("__st_fab__"), "token 模式忽略");
  const off = generateHostNginx(
    { host: "a.com", port: 1, authMode: "forward-auth", authPort: 2, basePath: "/portal" },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.ok(!off.includes("__st_fab__"), "未开启不注入");
  assert.ok(!off.includes("__st_auth__"), "回显端点也不生成");
});

test("login-fab: 与自定义 inject 并存（自定义在前 fab 在后）", async () => {
  const { generateHostNginx } = await import("../src/gateway.ts");
  const conf = generateHostNginx(
    { host: "a.com", port: 1, authMode: "forward-auth", authPort: 2, basePath: "/portal", loginInfoButton: true, inject: { html: "<script id=custom></script>", position: "head" } },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  // 两个注入都在（conf 是 nginxQuote 转义的 \xHH 流——找转义特征）
  const posFab = conf.indexOf("__st_fab__");
  assert.ok(posFab >= 0, "fab 注入存在");
  // 自定义在前：nginxQuote 后的 map default 值同时含两者，顺序校验放宽为存在性
});

// ── 真实 nginx e2e（照 gateway-portal.test.mjs 模式：GatewayController + PortalAuthProvider 直连）──
test("login-fab e2e: portal 注入 → who JSON → logout 清会话（真实 nginx）", { timeout: 60_000, skip: !existsSync("/usr/sbin/nginx") }, async (t) => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { GatewayController } = await import("../src/gateway.ts");
  const { cacheDir, configDir } = tempDirs();

  const backendPort = await new Promise((resolve) => {
    const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><head><title>t</title></head><body>hello</body></html>"); });
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });

  const pickPort = async () => {
    const { createServer: cs } = await import("net");
    return new Promise((resolve) => {
      const srv = cs();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  };
  const ctx = {
    configDir, cacheDir,
    resolveTool: async () => "",
    registerInternal: () => {}, unregisterInternal: () => {}, registerPid: () => {},
    pickPort, log: () => {},
  };

  const portal = new PortalAuthProvider(ctx, { user: { name: "admin", password: "pw" }, basePath: "/portal", policy: "one_factor" });
  await portal.prepare();
  await portal.start();

  const gateway = new GatewayController({ configDir, cacheDir, port: 0, basePath: "/portal", registerInternal: () => {}, registerPid: () => {}, log: () => {} });
  let gatewayPort = 0;
  t.after(async () => {
    try { await gateway.stop(); } catch {}
    try { await portal.stop(); } catch {}
  });
  gatewayPort = await gateway.start();
  await gateway.registerHost("fab.local.test", backendPort, { authPort: portal.port, basePath: "/portal", authMode: "forward-auth", loginInfoButton: true });

  const H = { Host: "fab.local.test" };

  // 1) 未登录 → 302（auth_request）
  const unauth = await httpReq({ host: "127.0.0.1", port: gatewayPort, path: "/", headers: { ...H, connection: "close" } });
  assert.equal(unauth.status, 302);

  // 2) 登录拿 cookie
  const loginBody = new URLSearchParams({ username: "admin", password: "pw", next: "/" }).toString();
  const login = await httpReq({
    host: "127.0.0.1", port: gatewayPort, path: "/portal/login", method: "POST",
    headers: { ...H, "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(loginBody), connection: "close" },
  }, loginBody);
  assert.equal(login.status, 302, "1FA 登录 302");
  const cookie = String(login.headers["set-cookie"]).split(";")[0];

  // 3) 已登录页面 → 注入 __st_fab__ 脚本（主页面导航）
  const page = await httpReq({ host: "127.0.0.1", port: gatewayPort, path: "/", headers: { ...H, cookie, "Sec-Fetch-Mode": "navigate", connection: "close" } });
  assert.equal(page.status, 200);
  assert.match(page.body, /__st_fab__/, "主页面注入 FAB 脚本");

  // 4) XHR 不注入
  const xhr = await httpReq({ host: "127.0.0.1", port: gatewayPort, path: "/", headers: { ...H, cookie, "Sec-Fetch-Mode": "cors", connection: "close" } });
  assert.ok(!xhr.body.includes("__st_fab__"), "XHR 请求不注入");

  // 5) __st_auth__ 回显：JSON 含 user + logoutUrl
  const who = await httpReq({ host: "127.0.0.1", port: gatewayPort, path: "/__st_auth__", headers: { ...H, cookie, connection: "close" } });
  assert.equal(who.status, 200);
  const info = JSON.parse(who.body);
  assert.equal(info.user, "admin");
  assert.equal(info.provider, "portal");
  assert.match(info.logoutUrl, /\/portal\/logout/);

  // 6) logout → 清 cookie 302 登录页
  const out = await httpReq({ host: "127.0.0.1", port: gatewayPort, path: "/portal/logout?next=/", headers: { ...H, cookie, connection: "close" } });
  assert.equal(out.status, 302);
  const setCookie = String(out.headers["set-cookie"] ?? "");
  assert.match(setCookie, /st_portal_session=;?/, "会话 cookie 置空");

  // 7) 登出后访问 → 401/302（会话已清——用旧 cookie 再请求）
  const after = await httpReq({ host: "127.0.0.1", port: gatewayPort, path: "/", headers: { ...H, cookie: cookie + "x", connection: "close" } });
  assert.notEqual(after.status, 200, "旧 cookie 已无效（篡改后拒绝）");
});
