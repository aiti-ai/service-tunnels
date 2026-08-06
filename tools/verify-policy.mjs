#!/usr/bin/env node
/**
 * verify-policy.mjs — portal 认证策略端到端验证工具
 *
 * 验证三种暴露策略在真实 gateway(vhost)上的行为:
 *   one_factor  : 仅密码登录即可访问
 *   two_factor  : 密码后还需 TOTP(2FA) 才能访问;未完成 2FA 一律 401
 *   deny        : 即使登录成功也 403(策略级拒绝)
 *
 * 用法: node tools/verify-policy.mjs
 * 退出码: 0 = 全部通过;1 = 有失败
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { createHmac } from "node:crypto";

/** Raw HTTP request with a custom Host header (no DNS needed). */
function raw(method, port, host, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host,
          ...(cookie ? { cookie } : {}),
          ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}),
          connection: "close",
        },
      },
      (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, location: res.headers.location, setCookie: String(res.headers["set-cookie"] ?? ""), body: b }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const get = (port, host, path, cookie) => raw("GET", port, host, path, undefined, cookie);
const post = (port, host, path, body, cookie) => raw("POST", port, host, path, body, cookie);

/** 从 Set-Cookie 提取 portal 会话/2fa 票(站点名后缀:cookie 名 st_portal_[site]_session)。 */
function portalCookie(setCookie, kind) {
  const m = setCookie.match(new RegExp(`(st_portal_[a-z0-9]*_${kind})=([^;]+)`));
  return m ? `${m[1]}=${m[2]}` : null;
}

/** 从未认证 302 的 Location 提取登录页 path(如 /portal-xxx/login)。 */
function loginPath(res) {
  try { return new URL(res.location).pathname; } catch { return res.location?.split("?")[0] ?? null; }
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s, ±1 window) — same as the portal. */
function totpCodes(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret).toUpperCase().replace(/=+$/, "");
  const key = Buffer.alloc((clean.length * 5) >> 3);
  let bits = 0, value = 0, idx = 0;
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { key[idx++] = (value >>> (bits - 8)) & 0xff; bits -= 8; }
  }
  const out = [];
  for (let off = -1; off <= 1; off++) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + off));
    const h = createHmac("sha1", key).update(counter).digest();
    const o = h[h.length - 1] & 0x0f;
    const num = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    out.push(String(num % 1_000_000).padStart(6, "0"));
  }
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
}
function section(s) { console.log(`\n── ${s} ──`); }

const base = mkdtempSync(join(tmpdir(), "st-policy-"));
let st;
// 崩溃/中断时清理:未处理异常或 Ctrl-C 会留下孤儿 portal/nginx 进程占用端口,
// 累积到系统端口压力后,后续运行的 portal 端口竞争会让探测 403(不是本库 bug)。
const cleanup = () => { try { st?.shutdown?.(); } catch { /* best-effort */ } rmSync(base, { recursive: true, force: true }); };
process.on("unhandledRejection", (e) => { console.error("\n⚠ crash:", String((e && e.message) || e).slice(0, 120)); cleanup(); process.exit(1); });
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("exit", cleanup);
try {
  const { createServiceTunnels } = await import("../src/index.ts");
  st = createServiceTunnels({
    configDir: join(base, "config"),
    cacheDir: join(base, "cache"),
    guardian: false,
  });

  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("echo:" + _q.url);
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;

  const tp = await st.proxy.start({ port: 0 });

  // 三个站点三种策略(各自独立 portal 实例/用户库)
  // 站点需先在 sites.json 注册(proxy resolve 按 label 查站点)
  const configDir = join(base, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "sites.json"), JSON.stringify({
    a: { name: "a", auth: true },
    b: { name: "b", auth: true },
    c: { name: "c", auth: true },
  }));
  const users = {
    a: { name: "alice", password: "pw-a" },
    b: { name: "bob", password: "pw-b" },
    c: { name: "carol", password: "pw-c" },
  };
  const vhosts = {};
  for (const [site, policy] of [["a", "one_factor"], ["b", "two_factor"], ["c", "deny"]]) {
    const r = await st.auth.expose(appPort, {
      mode: "proxy",
      auth: true,
      provider: "portal",
      site,
      policy,
      user: { name: users[site].name, password: users[site].password },
      proxyPort: 0,
    });
    if (!r.localUrl) throw new Error(`expose site ${site} failed: ${JSON.stringify(r)}`);
    vhosts[site] = { host: new URL(r.localUrl).host.split(":")[0], policy };
    console.log(`expose ${site} (${policy}) → ${vhosts[site].host}`);
  }

  section("one_factor (仅密码)");
  const va = vhosts.a.host;
  const unauthA = await get(tp, va, "/app");
  check("未登录访问 → 302 登录", unauthA.status === 302 && unauthA.location.includes("/login?next="), `status=${unauthA.status} loc=${unauthA.location}`);
  const loginA = await post(tp, va, loginPath(unauthA), `username=${users.a.name}&password=${users.a.password}`);
  const cookieA = portalCookie(loginA.setCookie, "session");
  check("密码登录直接发会话 cookie(无 2FA 步骤)", Boolean(cookieA), `cookie=${cookieA ? "yes" : "no"} status=${loginA.status}`);
  const authedA = await get(tp, va, "/secret", cookieA);
  check("带 cookie 访问 → 200 且到达服务", authedA.status === 200 && authedA.body === "echo:/secret", `status=${authedA.status} body=${authedA.body.slice(0, 20)}`);

  section("two_factor (密码 + TOTP)");
  const vb = vhosts.b.host;
  const unauthB = await get(tp, vb, "/app");
  check("未登录访问 → 302 登录", unauthB.status === 302 && unauthB.location.includes("/login?next="), `status=${unauthB.status}`);
  const loginB = await post(tp, vb, loginPath(unauthB), `username=${users.b.name}&password=${users.b.password}`);
  const cookie2B = portalCookie(loginB.setCookie, "2fa");
  check("密码登录后 → 进入 2FA 步骤(发 2fa 票,无会话 cookie)", Boolean(cookie2B) && !portalCookie(loginB.setCookie, "session"), `2faCookie=${cookie2B ? "yes" : "no"}`);
  // 未完成 2FA:带 2fa 票直接访问 → 认证不过 → 302 登录(不能 200)
  const pre2fa = await get(tp, vb, "/secret", cookie2B);
  check("未完成 2FA 访问 → 302 登录", pre2fa.status === 302 && pre2fa.location.includes("/login"), `status=${pre2fa.status}`);

  // 注册 bob 的 TOTP 并激活(走库的 totpEnroll/totpActivate)
  const enr = await st.auth.totpEnroll(users.b.name, "portal", "b");
  const code = totpCodes(enr.secret)[0];
  const act = await st.auth.totpActivate(users.b.name, code, "portal", "b");
  check("TOTP 注册+激活成功", act.activated === true, `secret=${enr.secret.slice(0, 8)}…`);
  const loginB2 = await post(tp, vb, loginPath(await get(tp, vb, "/app")), `username=${users.b.name}&password=${users.b.password}`);
  const cookie2B2 = portalCookie(loginB2.setCookie, "2fa");
  const totpPath = loginB2.body.match(/action="([^"]*\/login\/2fa)"/)?.[1];
  check("再次密码登录 → 2FA 页(表单指向 /login/2fa)", Boolean(totpPath), `action=${totpPath ?? "(none)"}`);
  const codeNow = totpCodes(enr.secret)[0];
  const twofaRes = await post(tp, vb, totpPath || "/2fa", `code=${codeNow}`, cookie2B2);
  const cookieB = portalCookie(twofaRes.setCookie, "session");
  check("2FA 提交正确 TOTP → 发会话 cookie", Boolean(cookieB), `cookie=${cookieB ? "yes" : "no"} status=${twofaRes.status}`);
  const authedB = await get(tp, vb, "/secret", cookieB);
  check("带 2FA 会话访问 → 200 且到达服务", authedB.status === 200 && authedB.body === "echo:/secret", `status=${authedB.status} body=${authedB.body.slice(0, 20)}`);

  section("deny (拒绝全部)");
  const vc = vhosts.c.host;
  const unauthC = await get(tp, vc, "/app");
  check("未登录访问 → 302 登录", unauthC.status === 302, `status=${unauthC.status}`);
  const loginC = await post(tp, vc, loginPath(unauthC), `username=${users.c.name}&password=${users.c.password}`);
  const cookieC = portalCookie(loginC.setCookie, "session");
  const deniedC = await get(tp, vc, "/secret", cookieC);
  check("即使登录成功带 cookie → 403(策略拒绝)", deniedC.status === 403, `status=${deniedC.status} body=${deniedC.body.slice(0, 30)}`);

  await st.shutdown();
  app.close();
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== 结果:${results.length} 项,${failed.length} 失败 ====`);
if (failed.length) {
  for (const f of failed) console.log("  FAIL:", f.name);
  process.exit(1);
}
// 子进程(portal/nginx)关闭异步,显式退出避免 CLI 挂住
process.exit(0);
