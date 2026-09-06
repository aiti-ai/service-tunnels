import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-authonly-"));
  return { base, cacheDir: join(base, "cache"), configDir: join(base, "config") };
}

function get(path, port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function postForm(path, port, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ── auth-setup 渲染（纯函数：脚本/nginx/systemd/config）──────────────
test("auth-setup: random basePath/site + config round-trip", async () => {
  const mod = await import("../src/auth-setup.ts");
  const bp = mod.randomBasePath();
  assert.match(bp, /^\/[a-z]+$/);
  assert.match(mod.randomSite(), /^[a-z]+$/);

  const { configDir, cacheDir } = tempDirs();
  const cfg = {
    base: "nhgf", basePath: "/nhgf", site: "rfgu",
    adminPort: 4199, authPort: 4200, listen: "127.0.0.1",
    policy: "one_factor", configDir, cacheDir,
  };
  mod.writeAuthConfig(configDir, cfg);
  const read = mod.readAuthConfig(configDir, "nhgf");
  assert.equal(read?.basePath, "/nhgf");
  assert.equal(read?.site, "rfgu");
  assert.equal(read?.authPort, 4200);
  // 多配置隔离：不同 base 独立文件
  mod.writeAuthConfig(configDir, { ...cfg, base: "zz", basePath: "/zz", site: "zzz" });
  assert.ok(existsSync(join(configDir, "auth", "nhgf.json")));
  assert.ok(existsSync(join(configDir, "auth", "zz.json")));
});

test("auth-setup: scripts/nginx/systemd renderers embed the right values", async () => {
  const mod = await import("../src/auth-setup.ts");
  const cfg = {
    base: "nhgf", basePath: "/nhgf", site: "rfgu",
    adminPort: 4199, authPort: 4200, listen: "127.0.0.1",
    policy: "one_factor", configDir: "/x/config", cacheDir: "/x/cache",
  };
  const admin = mod.renderAdminBash(cfg, "sts");
  assert.match(admin, /^#!\/usr\/bin\/env bash/);
  assert.match(admin, /sts ui --port 4199/);
  assert.match(admin, /auth-server-nhgf/);

  const server = mod.renderServerBash(cfg, "sts");
  assert.match(server, /sts authonly start --port 4200 --base-path \/nhgf --site rfgu/);
  assert.match(server, /--listen 127\.0\.0\.1 --policy one_factor/);

  const nginx = mod.renderNginxFragment(cfg);
  assert.match(nginx, /location = \/nhgf\/api\/authz\/auth-request/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:4200\/nhgf\/api\/authz\/auth-request/);
  assert.match(nginx, /auth_request \/nhgf\/api\/authz\/auth-request/);
  assert.match(nginx, /return 302 https:\/\/\$host\/nhgf\/login\?next=\$request_uri/);
  // 不写死内部域名/路径泄漏
  assert.doesNotMatch(nginx, /alot\.pw|pi\.alot\.pw|30141/);

  const unit = mod.renderSystemdUnit(cfg, "/x/bin/auth-server-nhgf.sh");
  assert.match(unit, /ExecStart=\/x\/bin\/auth-server-nhgf\.sh/);
  assert.match(unit, /Type=simple/);

  // Windows 服务安装/卸载脚本（authsetup 默认生成）
  const win = mod.renderWindowsServiceInstall(cfg, "C:\\st\\cli.js");
  assert.match(win, /@echo off/);
  assert.match(win, /set SVC=st-authonly-nhgf/);
  assert.match(win, /nssm install %SVC% "%NODE%" "%CLI%"/);
  assert.match(win, /sc create %SVC%/);
  assert.match(win, /authonly start --port 4200 --base-path \/nhgf --site rfgu/);
  const un = mod.renderWindowsServiceUninstall(cfg);
  assert.match(un, /set SVC=st-authonly-nhgf/);
  assert.match(un, /nssm remove %SVC% confirm/);

  // fail2ban filter + jail（nginx 层封禁，真实 IP 可见处）
  const ff = mod.renderFail2banFilter(cfg);
  assert.match(ff, /\^<HOST> -.*"\(\?:POST\|GET\) \/nhgf\/login.*" \(\?:401\|429\)/);
  const fj = mod.renderFail2banJail(cfg);
  assert.match(fj, /\[st-auth-nhgf\]/);
  assert.match(fj, /filter = st-auth-nhgf/);
  assert.match(fj, /maxretry = 5/);

  // CLI 调用解析：sts 优先；未入 PATH 时回退 node cli
  const inv = mod.resolveCliInvocation("/some/node_modules/service-tunnels/dist/cli.js");
  assert.ok(inv === "sts" || inv === "service-tunnels" || inv.startsWith("node "));
});

// ── 暴力破解防护整改：trustProxy 真实 IP 封禁 + 恒时校验 ───────────
const helperGet = (path, port, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    req.end();
  });
const helperPost = (path, port, fields, headers = {}) => {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
};

test("portal security: trustProxy → per-IP ban keys on real XFF client, not 127.0.0.1", { timeout: 40_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { configDir, cacheDir } = tempDirs();
  mkdirSync(configDir, { recursive: true });
  const st = createServiceTunnels({ configDir, cacheDir, guardian: false });
  const res = await st.auth.server.start({ site: "rfgu", port: 0, basePath: "/nhgf", policy: "one_factor", trustProxy: true });
  await st.auth.addUser("alice", "pw", { site: "rfgu", provider: "portal" });

  // 同一"真实客户端"203.0.113.50 连发 6 次错误登录（模拟经 nginx 转发）
  const xff = { host: "app.example.com", "x-forwarded-for": "203.0.113.50" };
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await helperPost("/nhgf/login", res.port, { username: "alice", password: "bad", next: "/" }, xff);
  }
  assert.equal(last.status, 429); // 第 6 次应被 IP 封禁

  // brute.json 应记录真实客户端 IP（而非 socket 127.0.0.1）
  const brute = JSON.parse(readFileSync(join(cacheDir, "tmp", "sites", "rfgu", "portal", "brute.json"), "utf8"));
  assert.ok(brute.ips["203.0.113.50"], "per-IP ban must key on the XFF client IP");
  assert.ok(!brute.ips["127.0.0.1"], "must NOT ban the loopback socket address");
  assert.ok(brute.accounts.alice, "per-account ban still applies");

  // 不同真实 IP 爆破不同用户 → 不受连带封禁（隔离正确）
  const other = await helperPost("/nhgf/login", res.port, { username: "bob", password: "bad", next: "/" }, { host: "app.example.com", "x-forwarded-for": "203.0.113.99" });
  assert.equal(other.status, 401);

  await st.auth.server.stop("rfgu");
  await st.shutdown();
});

test("portal security: 恒时校验——存在/不存在用户名返回一致、不可时序区分", { timeout: 40_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { configDir, cacheDir } = tempDirs();
  mkdirSync(configDir, { recursive: true });
  const st = createServiceTunnels({ configDir, cacheDir, guardian: false });
  const res = await st.auth.server.start({ site: "rfgu", port: 0, basePath: "/nhgf", policy: "one_factor" });
  await st.auth.addUser("alice", "pw", { site: "rfgu", provider: "portal" });

  // 错误消息统一（不泄露用户名是否存在）
  const a = await helperPost("/nhgf/login", res.port, { username: "alice", password: "bad", next: "/" }, { host: "app.example.com" });
  const b = await helperPost("/nhgf/login", res.port, { username: "nosuchuser", password: "bad", next: "/" }, { host: "app.example.com" });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.match(a.body, /Invalid username or password/);
  assert.match(b.body, /Invalid username or password/);
  // 响应时间差（连发 10 次取中位）应在同一量级——恒时 scrypt 已消除跳 过哈希的侧信道
  const med = async (u) => {
    const ts = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await helperPost("/nhgf/login", res.port, { username: u, password: "bad", next: "/" }, { host: "app.example.com" });
      ts.push(Date.now() - t0);
    }
    ts.sort((x, y) => x - y);
    return ts[5];
  };
  const tA = await med("alice");
  const tB = await med("nosuchuser");
  assert.ok(Math.abs(tA - tB) < Math.max(5, tA * 0.5), `存在/不存在时间差过大 (${tA} vs ${tB} ms)`);

  await st.auth.server.stop("rfgu");
  await st.shutdown();
});
test("auth.server: start → 401 → login → cookie → 200 → stop", { timeout: 40_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { configDir, cacheDir } = tempDirs();
  mkdirSync(configDir, { recursive: true });
  const st = createServiceTunnels({ configDir, cacheDir, guardian: false });

  const res = await st.auth.server.start({ site: "rfgu", port: 0, basePath: "/nhgf", policy: "one_factor" });
  assert.equal(res.running, true);
  assert.ok(res.port > 0);
  assert.equal(res.basePath, "/nhgf");

  // 用户由管理侧创建（同一 site 存储）→ 认证服务直接识别
  await st.auth.addUser("alice", "s3cret!pass", { site: "rfgu", provider: "portal" });

  // 1) 未认证 auth_request → 401
  const unauth = await get("/nhgf/api/authz/auth-request", res.port, { host: "app.example.com" });
  assert.equal(unauth.status, 401);

  // 2) 登录页渲染
  const page = await get("/nhgf/login?next=%2Fprotected", res.port, { host: "app.example.com" });
  assert.equal(page.status, 200);

  // 3) 登录 → 302 + Set-Cookie
  const login = await postForm("/nhgf/login", res.port, { username: "alice", password: "s3cret!pass", next: "/protected" }, { host: "app.example.com" });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, "/protected");
  const setCookie = Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : String(login.headers["set-cookie"]);
  const cookie = setCookie.split(";")[0];
  assert.match(cookie, /^st_portal_rfgu_session=/);

  // 4) 带 cookie 的 auth_request → 200
  const authed = await get("/nhgf/api/authz/auth-request", res.port, { host: "app.example.com", cookie });
  assert.equal(authed.status, 200);
  assert.equal(authed.headers["x-st-auth-user"], "alice");

  // 5) status 反映 running
  assert.equal(st.auth.server.status("rfgu").running, true);

  // 6) stop → 端口关闭
  await st.auth.server.stop("rfgu");
  assert.equal(st.auth.server.status("rfgu").running, false);
  await assert.rejects(get("/nhgf/api/authz/auth-request", res.port));

  await st.shutdown();
});

// ── 多配置隔离：两个 site 各自独立用户库/端口 ────────────────────────
test("auth.server: two sites are isolated (users + ports)", { timeout: 40_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { configDir, cacheDir } = tempDirs();
  mkdirSync(configDir, { recursive: true });
  const st = createServiceTunnels({ configDir, cacheDir, guardian: false });

  const a = await st.auth.server.start({ site: "aaa", port: 0, basePath: "/nhgf" });
  const b = await st.auth.server.start({ site: "bbb", port: 0, basePath: "/zzz" });
  assert.notEqual(a.port, b.port);

  await st.auth.addUser("u1", "pw1", { site: "aaa", provider: "portal" });
  await st.auth.addUser("u2", "pw2", { site: "bbb", provider: "portal" });

  // aaa 的 alice 不能在 bbb 登录
  const loginB = await postForm("/zzz/login", b.port, { username: "u1", password: "pw1", next: "/" }, { host: "app.example.com" });
  assert.equal(loginB.status, 401);
  const loginA = await postForm("/nhgf/login", a.port, { username: "u1", password: "pw1", next: "/" }, { host: "app.example.com" });
  assert.equal(loginA.status, 302);

  await st.auth.server.stop("aaa");
  await st.auth.server.stop("bbb");
  await st.shutdown();
});
