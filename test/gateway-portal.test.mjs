import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-gw-portal-"));
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

test("nginx gateway + portal provider: 302→login→cookie→200 (real nginx)", { timeout: 60_000 }, async (t) => {
  const { existsSync } = await import("node:fs");
  const nginxBin = ["/usr/sbin/nginx", "/usr/local/sbin/nginx", "/opt/homebrew/sbin/nginx"].find(existsSync);
  if (!nginxBin) {
    t.skip("nginx not installed");
    return;
  }

  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { GatewayController } = await import("../src/gateway.ts");
  const { cacheDir, configDir, base } = tempDirs();

  // fake backend app on a random port
  const backendPort = await new Promise((resolve) => {
    const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("hello app"); });
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });

  const pickPort = async () => {
    const { createServer } = await import("net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  };
  const ctx = {
    configDir, cacheDir,
    resolveTool: async () => "",
    registerInternal: () => {},
    unregisterInternal: () => {},
    registerPid: () => {},
    pickPort,
    log: () => {},
  };

  const portal = new PortalAuthProvider(ctx, { basePath: "/portal" });
  await portal.prepare();
  await portal.addUser("admin", "pw");
  await portal.start();

  const gateway = new GatewayController({
    configDir, cacheDir,
    port: 0,
    basePath: "/portal",
    registerInternal: () => {},
    unregisterInternal: () => {},
    registerPid: () => {},
    log: () => {},
  });
  let gatewayPort = 0;
  try {
    gatewayPort = await gateway.start();
    await gateway.registerHost("demo.local.test", backendPort, { authPort: portal.port, basePath: "/portal", authMode: "forward-auth" });

  // 1) unauthenticated → 401 via auth_request
  const unauth = await httpReq({
    host: "127.0.0.1", port: gatewayPort,
    path: "/", headers: { Host: "demo.local.test" },
  });
  assert.equal(unauth.status, 302);
  assert.match(String(unauth.headers["location"] || ""), /\/portal\/login/, "302 redirects to the login page");

  // 1b) bore/ssh 等带随机端口的隧道:Host 带端口 → 302 必须保留端口
  // (旧实现 $host 去端口 + 硬编码 https,浏览器跳到 https://host 直接报错)
  const tunnelHost = await httpReq({
    host: "127.0.0.1", port: gatewayPort,
    path: "/dev", headers: { Host: "demo.local.test:34567" },
  });
  assert.equal(tunnelHost.status, 302);
  const loc = String(tunnelHost.headers["location"] || "");
  assert.match(loc, /\/portal\/login/, "302 redirects to the login page");
  assert.ok(loc.includes("demo.local.test:34567"), "redirect preserves the tunnel port: " + loc);

  // 2) login through the nginx portal location → cookie
  const loginBody = new URLSearchParams({ username: "admin", password: "pw", next: "/" }).toString();
  const login = await httpReq({
    host: "127.0.0.1", port: gatewayPort,
    path: "/portal/login", method: "POST",
    headers: { Host: "demo.local.test", "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(loginBody) },
  }, loginBody);
  assert.equal(login.status, 302);
  const cookie = String(login.headers["set-cookie"]).split(";")[0];

  // 3) with cookie → backend app reachable (200 hello app)
  const authed = await httpReq({
    host: "127.0.0.1", port: gatewayPort,
    path: "/", headers: { Host: "demo.local.test", cookie },
  });
  assert.equal(authed.status, 200);
  assert.equal(authed.body, "hello app");

  // 4) portal page serves through the gateway too
  const page = await httpReq({
    host: "127.0.0.1", port: gatewayPort,
    path: "/portal/login", headers: { Host: "demo.local.test" },
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /Sign in/);

  } finally {
    await gateway.stop();
    await portal.stop();
  }
});

test("portal loginRedirect 跟随 scheme + $http_host 保留端口", async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const ctx = { configDir, cacheDir, resolveTool: async () => "", log: () => {} };
  const portal = new PortalAuthProvider(ctx, { basePath: "/portal" });
  // bore 裸 TCP 隧道 = http 协议:必须 http 重定向,否则浏览器跳 https 报错
  assert.equal(
    portal.loginRedirect("/portal", "http"),
    "http://$http_host/portal/login?next=$request_uri",
  );
  // https 隧道(ngrok/cloudflared 等)保持 https
  assert.equal(
    portal.loginRedirect("/portal", "https"),
    "https://$http_host/portal/login?next=$request_uri",
  );
});
