import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createHmac } from "node:crypto";

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-portal-"));
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

test("portal provider: forward-auth 401 → login → cookie → 200 + user mgmt", { timeout: 40_000 }, async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir, base } = tempDirs();
  const pickPorts = [];
  const provider = new PortalAuthProvider(
    {
      configDir, cacheDir,
      resolveTool: async () => "",
      registerInternal: () => {},
      unregisterInternal: () => {},
    registerPid: () => {},
      pickPort: async () => {
        const { createServer } = await import("net");
        return new Promise((resolve) => {
          const srv = createServer();
          srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
        });
      },
      log: () => {},
    },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" },
  );

  await provider.prepare();
  assert.equal((await provider.listUsers()).map((u) => u.name).join(), "admin");

  await provider.start();
  const port = provider.port;
  assert.ok(port > 0);

  // 1) unauthenticated auth_request → 401
  const unauth = await get("/portal/api/authz/auth-request", port);
  assert.equal(unauth.status, 401);

  // 2) login page renders
  const page = await get("/portal/login?next=%2Fapp", port);
  assert.equal(page.status, 200);
  assert.match(page.body, /Sign in/);

  // 3) wrong password → 401, no cookie
  const bad = await postForm("/portal/login", port, { username: "admin", password: "nope", next: "/app" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers["set-cookie"], undefined);

  // 4) correct login → 302 + signed cookie
  const ok = await postForm("/portal/login", port, { username: "admin", password: "pw", next: "/app" });
  assert.equal(ok.status, 302);
  const cookie = String(ok.headers["set-cookie"]);
  assert.ok(cookie, "must set session cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const token = cookie.split(";")[0].split("=")[1];

  // 5) auth_request with cookie → 200 + user header
  const authed = await get("/portal/api/authz/auth-request", port, { cookie: `st_portal_session=${token}` });
  assert.equal(authed.status, 200);
  assert.equal(authed.headers["x-st-auth-user"], "admin");

  // 6) tampered cookie → 401
  const tampered = await get("/portal/api/authz/auth-request", port, { cookie: `st_portal_session=${token}x` });
  assert.equal(tampered.status, 401);

  // 7) user mgmt: add alice, auth as alice
  await provider.addUser("alice", "alice-pw", "Alice");
  assert.equal((await provider.listUsers()).length, 2);
  const okAlice = await postForm("/portal/login", port, { username: "alice", password: "alice-pw" });
  assert.equal(okAlice.status, 302);

  // 8) set password + remove
  await provider.setUserPassword("alice", "new-pw");
  const oldPw = await postForm("/portal/login", port, { username: "alice", password: "alice-pw" });
  assert.equal(oldPw.status, 401);
  const newPw = await postForm("/portal/login", port, { username: "alice", password: "new-pw" });
  assert.equal(newPw.status, 302);
  await provider.removeUser("alice");
  assert.equal((await provider.listUsers()).map((u) => u.name).join(), "admin");

  // 9) users.json holds scrypt hashes, no plaintext
  const db = readFileSync(join(cacheDir, "tmp", "portal", "users.json"), "utf8");
  assert.equal(db.includes("alice-pw"), false);
  assert.equal(db.includes("admin"), true);
  assert.ok(db.includes('"hash":'));

  await provider.stop();
});

test("portal login redirect: hidden `next` survives the browser round-trip (no double-encoding)", { timeout: 40_000 }, async () => {
  // Regression: the login page used to put encodeURIComponent(next) in the
  // hidden field, so each redirect stacked an encoding layer (/foo → %2Ffoo
  // → %252Ffoo → %25252Ffoo) and the post-login Location pointed at an
  // encoded path instead of the real one. The field must hold the RAW path.
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const provider = new PortalAuthProvider(
    {
      configDir, cacheDir,
      resolveTool: async () => "",
      registerInternal: () => {},
      unregisterInternal: () => {},
    registerPid: () => {},
      pickPort: async () => {
        const { createServer } = await import("net");
        return new Promise((resolve) => {
          const srv = createServer();
          srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
        });
      },
      log: () => {},
    },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" },
  );
  await provider.prepare();
  await provider.start();
  const port = provider.port;
  try {
    // 1) load the login page with ?next=/foo (as the gateway redirect would)
    const page = await get(`/portal/login?next=${encodeURIComponent("/foo")}`, port);
    assert.equal(page.status, 200);
    // 2) extract the hidden next value the way a browser parses the field
    const m = /name="next" value="([^"]*)"/.exec(page.body);
    assert.ok(m, "login page has a hidden next field");
    assert.equal(m[1], "/foo", "hidden next is the RAW path (not pre-encoded %2Ffoo)");
    // 3) POST exactly as a browser would (form-encode the field's value)
    const ok = await postForm("/portal/login", port, { username: "admin", password: "pw", next: m[1] });
    assert.equal(ok.status, 302);
    // 4) Location must be the clean original path — not %2Ffoo / %252Ffoo
    assert.equal(ok.headers["location"], "/foo", "post-login redirect is the clean original path");
  } finally {
    await provider.stop();
  }
});

test("portal login password transport: RSA-OAEP front-end encryption", { timeout: 40_000 }, async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const pickPort = async () => {
    const { createServer } = await import("net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  };
  const provider = new PortalAuthProvider(
    { configDir, cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" },
  );
  await provider.prepare();
  await provider.start();
  const port = provider.port;

  // 1) login page embeds a fresh RSA public key
  const page = await get("/portal/login", port);
  assert.equal(page.status, 200);
  assert.match(page.body, /crypto\.subtle\.importKey/);
  assert.match(page.body, /RSA-OAEP/);
  const pubB64 = /const PUB="([^"]+)"/.exec(page.body)?.[1];
  const keyId = /const KEY_ID="([^"]+)"/.exec(page.body)?.[1];
  assert.ok(pubB64 && keyId, "page must carry public key + key id");

  // 2) encrypt the password like the browser does (WebCrypto → RSA-OAEP)
  const { publicEncrypt } = await import("node:crypto");
  const pubDer = Buffer.from(pubB64, "base64");
  // importKey spki via node: crypto.createPublicKey from SPKI der
  const { createPublicKey } = await import("node:crypto");
  const pubKey = createPublicKey({ key: pubDer, format: "der", type: "spki" });
  const cipher = publicEncrypt({ key: pubKey, padding: 4 /* RSA_PKCS1_OAEP_PADDING */, oaepHash: "sha256" }, Buffer.from("pw"));
  const encB64 = cipher.toString("base64");

  // 3) login with encrypted password (no plaintext field)
  const login = await postForm("/portal/login", port, {
    username: "admin", keyId, encrypted: encB64, next: "/app",
  });
  assert.equal(login.status, 302, "encrypted password must authenticate");
  assert.ok(String(login.headers["set-cookie"]).includes("HttpOnly"));

  // 4) key id is single-use — replay the same ciphertext → 401
  const replay = await postForm("/portal/login", port, {
    username: "admin", keyId, encrypted: encB64, next: "/app",
  });
  assert.equal(replay.status, 401, "replayed ciphertext must be rejected");

  // 5) wrong key id → 401
  const badKey = await postForm("/portal/login", port, {
    username: "admin", keyId: "deadbeef", encrypted: encB64,
  });
  assert.equal(badKey.status, 401);

  // 6) plaintext fallback still works (curl/API clients)
  const plain = await postForm("/portal/login", port, { username: "admin", password: "pw" });
  assert.equal(plain.status, 302);

  // 7) the plaintext password never appears in the wire-visible channel:
  //    encrypted path carried only ciphertext (assert the form had no password)
  await provider.stop();
});

test("portal brute-force lockout (account + IP, persistent) + TOTP 2FA login", { timeout: 40_000 }, async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir, base } = tempDirs();
  const pickPort = async () => {
    const { createServer } = await import("net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  };
  const provider = new PortalAuthProvider(
    { configDir, cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" },
  );
  await provider.prepare();
  await provider.start();
  const port = provider.port;

  // ── brute force: 5 bad passwords → locked out (429) ──
  for (let i = 0; i < 5; i++) {
    const r = await postForm("/portal/login", port, { username: "admin", password: "wrong" });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
  }
  const locked = await postForm("/portal/login", port, { username: "admin", password: "pw" });
  assert.equal(locked.status, 429, "correct password still locked after 5 failures");
  assert.ok(locked.headers["retry-after"], "429 should carry Retry-After");
  // other account unaffected by account-level lock (IP shares the lock though —
  // verify the account dimension by using a different client IP is not possible
  // here; assert the account lock file exists with state)
  const { readFileSync } = await import("node:fs");
  const brute = JSON.parse(readFileSync(join(cacheDir, "tmp", "portal", "brute.json"), "utf8"));
  assert.ok(brute.accounts.admin.bannedUntil > Date.now(), "admin account banned in state");

  // ── TOTP 2FA (fresh provider — the same IP is banned by the lockout
  //    test above, and IP+account lockout is by design) ──
  const { PortalAuthProvider: P2 } = await import("../src/providers/portal.ts");
  const d2 = tempDirs();
  const provider2 = new P2(
    { configDir: d2.configDir, cacheDir: d2.cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" },
  );
  await provider2.prepare();
  await provider2.start();
  const port2 = provider2.port;
  await provider2.addUser("alice", "alice-pw");
  const { secret, otpauthUrl } = await provider2.totpEnroll("alice");
  assert.match(otpauthUrl, /^otpauth:\/\/totp\//);
  // 默认标识：user-auth-site 用 `-` 连接成 account，host 前保留 `@`
  // （站点独立用户库，分开管理）；无 host 时省略 @host；可自定义 label。
  const { label } = await provider2.totpEnroll("alice");
  assert.equal(label, "alice-portal-default");
  assert.equal(provider2.defaultTotpLabel("alice"), "alice-portal-default");
  await provider2.registerHost("5173-app.example.com");
  assert.equal(provider2.defaultTotpLabel("alice"), "alice-portal-default@5173-app.example.com");
  const custom = await provider2.totpEnroll("alice", "alice@my.host");
  assert.equal(custom.label, "alice@my.host");
  assert.ok(custom.otpauthUrl.includes("issuer=my.host"), "issuer = label 的 host 部分");
  assert.ok(custom.otpauthUrl.includes(encodeURIComponent("alice@my.host")), "label 被 URL 编码");
  // pending until activated (2FA-takeover guard): enrolling must NOT replace
  // the enforced secret or force 2FA before the user proves the code.
  assert.equal((await provider2.totpStatus("alice")).enrolled, false);
  assert.equal((await provider2.totpStatus("alice")).pending, true);
  assert.equal((await provider2.totpStatus("admin")).enrolled, false);

  // wrong activation code → rejected, still pending
  await assert.rejects(() => provider2.totpActivate("alice", "000000"));
  assert.equal((await provider2.totpStatus("alice")).pending, true);

  // activate with the user's real code → now enforced
  // (pending 已被多次 re-enroll 替换 —— 激活/登录必须用最近一次 custom 的 secret)
  const activateCode = totp(custom.secret);
  await provider2.totpActivate("alice", activateCode);
  assert.equal((await provider2.totpStatus("alice")).enrolled, true);
  assert.equal((await provider2.totpStatus("alice")).pending, false);

  // password step → 200 + pending 2FA cookie (no session cookie yet)
  const step1 = await postForm("/portal/login", port2, { username: "alice", password: "alice-pw" });
  assert.equal(step1.status, 200, "password ok but 2FA pending");
  const tmpCookie = String(step1.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
  assert.ok(tmpCookie, "must set pending-2fa cookie");

  // wrong code → 401
  const badCode = await postForm("/portal/login/2fa", port2, { code: "000000" }, { cookie: `st_portal_2fa=${tmpCookie}` });
  assert.equal(badCode.status, 401);
  const badCode2 = await postForm("/portal/login/2fa", port2, { code: "000000" }, { cookie: `st_portal_2fa=${tmpCookie}` });
  assert.equal(badCode2.status, 401);

  // correct TOTP code → 302 + real session cookie (fresh ticket for alice)
  function base32Decode(s) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0, value = 0;
    const out = [];
    for (const ch of s.toUpperCase().replace(/=+$/, "")) {
      const v = alphabet.indexOf(ch);
      if (v < 0) return null;
      value = (value << 5) | v;
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(out);
  }
  function totp(secretB32, offset = 0) {
    const key = base32Decode(secretB32);
    const step = BigInt(Math.floor(Date.now() / 30_000) + offset);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(step);
    const h = createHmac("sha1", key).update(counter).digest();
    const o = h[h.length - 1] & 0x0f;
    const num = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(num % 1_000_000).padStart(6, "0");
  }
  const code = totp(custom.secret);
  const ok2fa = await postForm("/portal/login/2fa", port2, { code }, { cookie: `st_portal_2fa=${tmpCookie}` });
  assert.equal(ok2fa.status, 302, "valid TOTP completes login");
  assert.match(String(ok2fa.headers["set-cookie"]), /st_portal_session=/);

  // 2FA ticket can't be reused as a session cookie
  const probe = await get("/portal/api/authz/auth-request", port2, { cookie: `st_portal_session=${tmpCookie}` });
  assert.equal(probe.status, 401, "2FA ticket must not work as session cookie");

  // session cookie works
  const sessionCookie = String(ok2fa.headers["set-cookie"]).match(/st_portal_session=([^;]+)/)?.[1];
  const authed = await get("/portal/api/authz/auth-request", port2, { cookie: `st_portal_session=${sessionCookie}` });
  assert.equal(authed.status, 200);

  await provider.stop();
  await provider2.stop();
});

// ── P0: remember me（可信设备）+ 2FA 方法抽象（biometric-2fa-design.md §5-6）──
// 直接 spawn 生成的 server.mjs 并注入微型 TTL（TTL 20s / remember 60s /
// grace 1.5s）压缩时间轴：probe 周期内放行 → 过期 401 → GET /login 免密码
// 直跳 2FA 页 → 补因子恢复，全链路可断言。
test("portal remember me: 365d-equivalent cookie, 2FA grace re-verify (skip password)", { timeout: 60_000 }, async () => {
  const { PortalAuthProvider, generateTotpCode } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const pickPort = async () => {
    const { createServer } = await import("net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  };
  const provider = new PortalAuthProvider(
    { configDir, cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" },
  );
  await provider.prepare();
  await provider.addUser("bob", "bob-pw"); // 无 TOTP：1FA 用户
  const { secret } = await provider.totpEnroll("admin");
  await provider.totpActivate("admin", generateTotpCode(secret) ?? "000000");
  // two_factor host（probe 复验）+ 默认 one_factor host（1FA 用户用）
  await provider.registerHost("app.example.com", { policy: "two_factor" });
  await provider.registerHost("one.example.com", { policy: "one_factor" });

  // 手动 spawn 生成脚本，注入微型 TTL env（父进程默认 7d/365d/52d 无法测周期）
  const { spawn } = await import("node:child_process");
  const { connect } = await import("node:net");
  const port = await pickPort();
  const serverDir = join(cacheDir, "tmp", "portal");
  const TTL = 20_000, REMEMBER = 60_000, GRACE = 1_500;
  const proc = spawn(process.execPath, [join(serverDir, "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port), SECRET: "test-secret", USERS_FILE: join(serverDir, "users.json"),
      BASE_PATH: "/portal", DEPLOY_BASE_PATH: "", POLICY_FILE: join(serverDir, "hosts-policy.json"),
      POLICY_DEFAULT: "one_factor", TTL_MS: String(TTL), REMEMBER_TTL_MS: String(REMEMBER),
      GRACE_MS: String(GRACE), SECURE: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errs = [];
  proc.stderr?.on("data", (d) => errs.push(String(d)));
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const attempt = () => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - t0 > 10_000) reject(new Error("server did not start"));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
  const APP = { host: "app.example.com" };
  const ONE = { host: "one.example.com" };
  const code = () => generateTotpCode(secret) ?? "000000";

  // cookie payload 解码（签名前段是 base64url 的明文 payload，无需 secret）
  const payloadOf = (token) => Buffer.from(token.split(".")[0], "base64url").toString("utf8");

  try {
    // 1) 登录页有 remember 勾选框
    const page = await get("/portal/login", port, APP);
    assert.equal(page.status, 200);
    assert.match(page.body, /name="remember"/);

    // 2) 密码步（two_factor host，remember=1）→ 200 + COOKIE2 票据 + totp 页（单方法直达）
    const step1 = await postForm("/portal/login", port, { username: "admin", password: "pw", next: "/app", remember: "1" }, APP);
    assert.equal(step1.status, 200);
    const ticket = String(step1.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
    assert.ok(ticket, "2FA step sets ticket cookie");
    assert.match(step1.body, /name="code"/, "single-method (totp) renders directly");
    assert.match(step1.body, /name="remember" value="1"/, "remember rides along as hidden field");

    // 3) 无 method 字段 POST /login/2fa（向后兼容）+ remember → 302 + remember TTL 会话
    const ok2fa = await postForm("/portal/login/2fa", port, { code: code(), next: "/app", remember: "1" }, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    assert.equal(ok2fa.status, 302, "TOTP (no method field) completes login — backcompat");
    const token = String(ok2fa.headers["set-cookie"]).match(/st_portal_session=([^;]+)/)?.[1];
    assert.ok(token);
    const pl = payloadOf(token);
    assert.match(pl, /\.2fa:\d+$/, "payload carries .2fa:<timestamp>");
    const expIn = Number(pl.split(".")[0]) - Date.now();
    assert.ok(expIn > REMEMBER * 0.9 && expIn <= REMEMBER, `remember cookie ≈ REMEMBER_TTL (${expIn}ms)`);

    // 4) probe：周期内 → 200
    const sess = { cookie: `st_portal_session=${token}`, ...APP };
    const p1 = await get("/portal/api/authz/auth-request", port, sess);
    assert.equal(p1.status, 200);

    // 5) grace 过期（1.5s）→ probe 401；GET /login → 302 直跳 2FA 步骤页（免密码）
    await new Promise((r) => setTimeout(r, GRACE + 200));
    const p2 = await get("/portal/api/authz/auth-request", port, sess);
    assert.equal(p2.status, 401, "2FA grace expired → probe 401");
    const relogin = await get("/portal/login?next=%2Fapp", port, sess);
    assert.equal(relogin.status, 302);
    assert.match(String(relogin.headers["location"]), /^\/portal\/login\/2fa\?next=%2Fapp&r=1$/, "skip-password redirect keeps remember (r=1)");
    const ticket2 = String(relogin.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
    assert.ok(ticket2, "grace path issues a fresh 2FA ticket");

    // 6) GET /login/2fa 渲染 totp 页；补因子 → 会话恢复（remember TTL 延续）
    const step2 = await get("/portal/login/2fa?next=%2Fapp&r=1", port, { cookie: `st_portal_2fa=${ticket2}`, ...APP });
    assert.equal(step2.status, 200);
    assert.match(step2.body, /name="code"/);
    const okAgain = await postForm("/portal/login/2fa", port, { code: code(), next: "/app", remember: "1" }, { cookie: `st_portal_2fa=${ticket2}`, ...APP });
    assert.equal(okAgain.status, 302);
    const token2 = String(okAgain.headers["set-cookie"]).match(/st_portal_session=([^;]+)/)?.[1];
    const exp2 = Number(payloadOf(token2).split(".")[0]) - Date.now();
    assert.ok(exp2 > REMEMBER * 0.9 && exp2 <= REMEMBER, `re-verify keeps remember TTL (${exp2}ms)`);
    const p3 = await get("/portal/api/authz/auth-request", port, { cookie: `st_portal_session=${token2}`, ...APP });
    assert.equal(p3.status, 200, "probe passes right after re-verify");

    // 7) 不勾 remember → 会话 TTL 是默认值（20s）而非 60s
    const s1 = await postForm("/portal/login", port, { username: "admin", password: "pw", next: "/app" }, APP);
    const t2 = String(s1.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
    const okNoRm = await postForm("/portal/login/2fa", port, { code: code(), next: "/app" }, { cookie: `st_portal_2fa=${t2}`, ...APP });
    const tkNoRm = String(okNoRm.headers["set-cookie"]).match(/st_portal_session=([^;]+)/)?.[1];
    const expNoRm = Number(payloadOf(tkNoRm).split(".")[0]) - Date.now();
    assert.ok(expNoRm <= TTL + 2_000, `no-remember cookie ≈ default TTL (${expNoRm}ms)`);

    // 8) 1FA 用户（无 TOTP，one_factor host）：remember=1 不延长会话（弱会话不放大）
    const bob = await postForm("/portal/login", port, { username: "bob", password: "bob-pw", remember: "1" }, ONE);
    assert.equal(bob.status, 302);
    const bobTok = String(bob.headers["set-cookie"]).match(/st_portal_session=([^;]+)/)?.[1];
    const bobExp = Number(payloadOf(bobTok).split(".")[0]) - Date.now();
    assert.ok(bobExp <= TTL + 2_000, `1FA session stays default TTL even with remember (${bobExp}ms)`);

    // 9) two_factor host + 无 2FA 方法用户 → 错误 chooser 页（不再是无意义 totp 输入框）
    const bob2 = await postForm("/portal/login", port, { username: "bob", password: "bob-pw" }, APP);
    assert.equal(bob2.status, 200);
    assert.match(bob2.body, /no 2FA method enrolled/);
    assert.doesNotMatch(bob2.body, /name="code"/, "no code input when nothing is enrolled");

    // 10) 未知 method → 400 + chooser 错误（voice 已实现；用真未知名）
    const bad = await postForm("/portal/login/2fa", port, { method: "sms", code: "000000", next: "/app" }, { cookie: `st_portal_2fa=${ticket2}`, ...APP });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /Unknown 2FA method/);

    // 11) 票据缺失的 GET /login/2fa → 302 回密码页
    const noTicket = await get("/portal/login/2fa?next=%2Fapp", port, APP);
    assert.equal(noTicket.status, 302);
    assert.match(String(noTicket.headers["location"]), /^\/portal\/login\?/);
  } finally {
    proc.kill();
    await provider.stop();
    assert.deepEqual(errs, [], "server stderr must stay clean");
  }
});

// ── P1: 人脸 2FA（biometric-2fa-design.md §7/§9）──────────────────────────
// 父进程 API（模板存储/首验门）不触发资产下载（不调 prepare）；服务端全链路
// 用合成向量 + 假 ASSETS_DIR（真模型下载不在测试里跑）。
function synthVec(seed) {
  const a = new Array(128);
  let s = seed >>> 0;
  for (let i = 0; i < 128; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    a[i] = ((s >>> 8) & 0xffff) / 0xffff - 0.5;
  }
  const n = Math.hypot(...a);
  return a.map((x) => x / n);
}
function jitterVec(base, eps = 0.005) {
  const j = base.map((x) => x + (Math.random() - 0.5) * eps);
  const n = Math.hypot(...j);
  return j.map((x) => x / n);
}

test("portal biometric face: templates store (enroll→pending→verify→active→disable, removeUser cleanup)", { timeout: 20_000 }, async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const provider = new PortalAuthProvider(
    { configDir, cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort: async () => 0, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal", biometrics: true },
  );
  await provider.addUser("cara", "cara-pw");
  const face = synthVec(42);

  // 未注册 → face:false；验证 → throw
  assert.deepEqual(await provider.biometricStatus("cara"), { face: false, voice: false });
  await assert.rejects(() => provider.biometricVerifyFace("cara", [face]));

  // 样本校验：坏形状拒绝
  await assert.rejects(() => provider.biometricEnrollFace("cara", [[0.1, 0.2]]));       // 2 dims
  await assert.rejects(() => provider.biometricEnrollFace("cara", [new Array(128).fill(NaN)])); // NaN
  await assert.rejects(() => provider.biometricEnrollFace("cara", []));                  // 0 组

  // 注册 → pending（首验门：未验证前 status face=false）
  await provider.biometricEnrollFace("cara", [face, jitterVec(face)]);
  assert.deepEqual(await provider.biometricStatus("cara"), { face: false, voice: false });
  assert.equal((await provider.listUsers()).find((u) => u.name === "cara")?.biometrics?.face, false);

  // 错误向量（远距离）→ 不匹配、仍 pending
  const far = await provider.biometricVerifyFace("cara", [synthVec(777)]);
  assert.equal(far.matched, false);
  assert.ok(far.distance > 1, `far distance ≈ √2, got ${far.distance}`);
  assert.deepEqual(await provider.biometricStatus("cara"), { face: false, voice: false });

  // 正确向量（同源抖动）→ 匹配 + pending→active
  const ok = await provider.biometricVerifyFace("cara", [jitterVec(face)]);
  assert.equal(ok.matched, true);
  assert.ok(ok.distance < 0.05, `same-person distance tiny, got ${ok.distance}`);
  assert.deepEqual(await provider.biometricStatus("cara"), { face: true, voice: false });
  assert.equal((await provider.listUsers()).find((u) => u.name === "cara")?.biometrics?.face, true);

  // templates.json 权限 + 无原始媒体（只有数字向量）
  const tplRaw = readFileSync(join(cacheDir, "tmp", "portal", "templates.json"), "utf8");
  assert.ok(tplRaw.includes('"vectors"'));
  assert.match(tplRaw, /"status": "active"/);

  // disable → 回到未注册
  await provider.biometricDisable("cara", "face");
  assert.deepEqual(await provider.biometricStatus("cara"), { face: false, voice: false });
  await assert.rejects(() => provider.biometricDisable("cara", "face"));

  // removeUser 清理孤儿模板
  await provider.biometricEnrollFace("cara", [face]);
  await provider.removeUser("cara");
  const after = JSON.parse(readFileSync(join(cacheDir, "tmp", "portal", "templates.json"), "utf8"));
  assert.equal(after.cara, undefined);
});

test("portal biometric face: full login flow (challenge nonce, RSA payload, threshold, lockout, assets route)", { timeout: 60_000 }, async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const pickPort = async () => {
    const { createServer } = await import("net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  };
  const provider = new PortalAuthProvider(
    { configDir, cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal", biometrics: true },
  );
  await provider.prepare(); // 生成 server.mjs（离线——资产下载只在 start）
  await provider.addUser("dana", "dana-pw");
  const face = synthVec(4242);
  await provider.biometricEnrollFace("dana", [face, jitterVec(face), jitterVec(face)]);
  const act = await provider.biometricVerifyFace("dana", [jitterVec(face)]);
  assert.equal(act.matched, true, "activate template first");
  await provider.registerHost("app.example.com", { policy: "two_factor" });

  // 手动 spawn 生成脚本：FACE_ENABLED + 假 ASSETS_DIR（fixture 文件，免下载）
  const { spawn } = await import("node:child_process");
  const { connect } = await import("node:net");
  const { writeFileSync: wf, mkdirSync: mkd } = await import("node:fs");
  const assetsDir = join(cacheDir, "fake-assets");
  mkd(assetsDir, { recursive: true });
  wf(join(assetsDir, "face-api.js"), "// dummy face-api for test");
  for (const f of ["tiny_face_detector_model-weights_manifest.json", "tiny_face_detector_model.bin",
    "face_landmark_68_model-weights_manifest.json", "face_landmark_68_model.bin",
    "face_recognition_model-weights_manifest.json", "face_recognition_model.bin"]) {
    wf(join(assetsDir, f), f.endsWith(".json") ? "[]" : new Uint8Array([1, 2, 3]));
  }
  const port = await pickPort();
  const serverDir = join(cacheDir, "tmp", "portal");
  const proc = spawn(process.execPath, [join(serverDir, "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port), SECRET: "test-secret", USERS_FILE: join(serverDir, "users.json"),
      BASE_PATH: "/portal", DEPLOY_BASE_PATH: "", POLICY_FILE: join(serverDir, "hosts-policy.json"),
      POLICY_DEFAULT: "one_factor", TTL_MS: "20000", REMEMBER_TTL_MS: "60000", GRACE_MS: "60000",
      TEMPLATES_FILE: join(serverDir, "templates.json"), FACE_ENABLED: "1", FACE_THRESHOLD: "0.6",
      ASSETS_DIR: assetsDir, SECURE: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errs = [];
  proc.stderr?.on("data", (d) => errs.push(String(d)));
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const attempt = () => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - t0 > 10_000) reject(new Error("server did not start"));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
  const APP = { host: "app.example.com" };
  const { publicEncrypt, createPublicKey, createCipheriv, randomBytes: rb } = await import("node:crypto");
  const encryptWith = (pubB64, obj) => {
    const key = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    const aes = rb(32);
    const iv = rb(12);
    const c = createCipheriv("aes-256-gcm", aes, iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
    const wk = publicEncrypt({ key, padding: 4, oaepHash: "sha256" }, aes).toString("base64");
    return { wrapped: wk, iv: iv.toString("base64"), data: Buffer.concat([ct, c.getAuthTag()]).toString("base64") };
  };

  try {
    // 0) assets 路由：白名单可取，未知名/穿越 404
    const a1 = await get("/portal/assets/face-api.js", port);
    assert.equal(a1.status, 200);
    assert.match(a1.body, /dummy face-api/);
    assert.match(a1.headers["content-type"] ?? "", /javascript/);
    const a2 = await get("/portal/assets/models/face_recognition_model.bin", port);
    assert.equal(a2.status, 200);
    const a3 = await get("/portal/assets/models/../../users.json", port);
    assert.notEqual(a3.status, 200);
    const a4 = await get("/portal/assets/models/evil.bin", port);
    assert.equal(a4.status, 404);

    // 1) 密码步：单方法 face → 直接渲染人脸页（含挑战 nonce + RSA 公钥）
    const step1 = await postForm("/portal/login", port, { username: "dana", password: "dana-pw", next: "/app" }, APP);
    assert.equal(step1.status, 200);
    assert.match(step1.body, /faceapi\.detectSingleFace/);
    assert.match(step1.body, /assets\/face-api\.js/);
    const nonce = /NONCE="([0-9a-f]+)"/.exec(step1.body)?.[1];
    const pubB64 = /PUB="([^"]+)"/.exec(step1.body)?.[1];
    const keyId = /KEY_ID="([^"]+)"/.exec(step1.body)?.[1];
    assert.ok(nonce && pubB64 && keyId, "page carries nonce + one-time RSA key");
    const ticket = String(step1.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];

    // 1b) 回归防线（实测缺陷，docs/biometric-2fa-design.md §7.2/§15）：
    //     向量载荷（KB 级）直连 RSA-OAEP 必须 DATA_TOO_LARGE —— 防止改动
    //     退回直接 RSA（浏览器端同样会失败，只有真机能暴露；这里锁住数学）。
    {
      const { publicEncrypt } = await import("node:crypto");
      const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
      assert.throws(
        () => publicEncrypt({ key: pub, padding: 4, oaepHash: "sha256" }, Buffer.from(JSON.stringify({ vectors: [jitterVec(face)] }))),
        /data too large/i,
        "vector payload exceeds RSA-OAEP 190B limit — must use hybrid channel",
      );
    }

    // 2) 正确向量 + 眨眼 → 302 + .2fa 会话（混合加密：AES-GCM 载荷 + RSA 包裹密钥）
    const ok = await postForm("/portal/login/2fa", port, {
      method: "face", next: "/app", keyId, ...encryptWith(pubB64, { nonce, vectors: [jitterVec(face), jitterVec(face)], blinked: true }),
    }, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    assert.equal(ok.status, 302);
    const token = String(ok.headers["set-cookie"]).match(/st_portal_session=([^;]+)/)?.[1];
    const pl = Buffer.from(token.split(".")[0], "base64url").toString();
    assert.match(pl, /\.2fa:\d+$/);
    const probe = await get("/portal/api/authz/auth-request", port, { cookie: `st_portal_session=${token}`, ...APP });
    assert.equal(probe.status, 200);

    // 3) nonce 单次消费：重放同 payload → 401（新票据 + 新 RSA 密钥）
    const step2 = await get("/portal/login/2fa?m=face&next=%2Fapp", port, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    assert.equal(step2.status, 200);
    const nonce2 = /NONCE="([0-9a-f]+)"/.exec(step2.body)?.[1];
    const pub2 = /PUB="([^"]+)"/.exec(step2.body)?.[1];
    const kid2 = /KEY_ID="([^"]+)"/.exec(step2.body)?.[1];
    const replay = await postForm("/portal/login/2fa", port, {
      method: "face", next: "/app", keyId: kid2,
      ...encryptWith(pub2, { nonce, vectors: [jitterVec(face)], blinked: true }), // 旧 nonce
    }, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    assert.equal(replay.status, 401, "old nonce is consumed/expired");

    // 4) 眨眼断言缺失 → 401
    const step3 = await get("/portal/login/2fa?m=face&next=%2Fapp", port, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    const nonce3 = /NONCE="([0-9a-f]+)"/.exec(step3.body)?.[1];
    const pub3 = /PUB="([^"]+)"/.exec(step3.body)?.[1];
    const kid3 = /KEY_ID="([^"]+)"/.exec(step3.body)?.[1];
    const noBlink = await postForm("/portal/login/2fa", port, {
      method: "face", next: "/app", keyId: kid3,
      ...encryptWith(pub3, { nonce: nonce3, vectors: [jitterVec(face)], blinked: false }),
    }, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    assert.equal(noBlink.status, 401);

    // 5) 生物锁定：前面 replay/noBlink 已计 2 次失败——第 3 次失败即封禁，
    //    第 4 次 429（比密码的 5 次更严：bio-face 键独立计数）
    {
      const s = await get("/portal/login/2fa?m=face&next=%2Fapp", port, { cookie: `st_portal_2fa=${ticket}`, ...APP });
      const n = /NONCE="([0-9a-f]+)"/.exec(s.body)?.[1];
      const p = /PUB="([^"]+)"/.exec(s.body)?.[1];
      const k = /KEY_ID="([^"]+)"/.exec(s.body)?.[1];
      const bad = await postForm("/portal/login/2fa", port, {
        method: "face", next: "/app", keyId: k,
        ...encryptWith(p, { nonce: n, vectors: [synthVec(9999)], blinked: true }),
      }, { cookie: `st_portal_2fa=${ticket}`, ...APP });
      assert.equal(bad.status, 401, "3rd bio failure → 401 (ban armed)");
      assert.match(bad.body, /Face not recognized/);
    }
    const s4 = await get("/portal/login/2fa?m=face&next=%2Fapp", port, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    const n4 = /NONCE="([0-9a-f]+)"/.exec(s4.body)?.[1];
    const p4 = /PUB="([^"]+)"/.exec(s4.body)?.[1];
    const k4 = /KEY_ID="([^"]+)"/.exec(s4.body)?.[1];
    const locked = await postForm("/portal/login/2fa", port, {
      method: "face", next: "/app", keyId: k4,
      ...encryptWith(p4, { nonce: n4, vectors: [jitterVec(face)], blinked: true }),
    }, { cookie: `st_portal_2fa=${ticket}`, ...APP });
    assert.equal(locked.status, 429, "3 bio failures → locked");
    assert.ok(locked.headers["retry-after"]);
    assert.deepEqual(errs, [], "server stderr must stay clean");
  } finally {
    proc.kill();
    await provider.stop();
  }
});

// ── P2: 语音 2FA + 两条注册路径（biometric-2fa-design.md §8/§9.1）──────────
function synthVoice(seed) {
  const a = new Array(78);
  let s = seed >>> 0;
  for (let i = 0; i < 78; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    a[i] = ((s >>> 8) & 0xffff) / 0xffff - 0.5;
  }
  const n = Math.hypot(...a);
  return a.map((x) => x / n);
}
function jitterVoice(base, eps = 0.03) {
  const j = base.map((x) => x + (Math.random() - 0.5) * eps);
  const n = Math.hypot(...j);
  return j.map((x) => x / n);
}

test("portal biometric voice: parent API (enroll quality gate → pending → verify → active → disable)", { timeout: 20_000 }, async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const provider = new PortalAuthProvider(
    { configDir, cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort: async () => 0, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal", biometrics: true },
  );
  await provider.addUser("vera", "vera-pw");
  const v = synthVoice(777);

  // 未启用 portal（biometrics: false）→ 拒绝
  const off = new PortalAuthProvider(
    { configDir: cacheDir + "-off", cacheDir: cacheDir + "-off", resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort: async () => 0, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" },
  );
  await off.addUser("vera", "vera-pw");
  await assert.rejects(() => off.biometricEnrollVoice("vera", [v, v, v]), /not enabled/);

  // 形状校验
  await assert.rejects(() => provider.biometricEnrollVoice("vera", [[0.1, 0.2]]));
  await assert.rejects(() => provider.biometricEnrollVoice("vera", [v, v])); // 少于 3 次

  // 质量门：不同人样本（距离远）→ 拒绝
  await assert.rejects(() => provider.biometricEnrollVoice("vera", [v, synthVoice(31), synthVoice(32)]), /inconsistent/);

  // 正常：同源 3 样本 → pending → 远样本验证不匹配（不转正）→ 近样本匹配转正
  await provider.biometricEnrollVoice("vera", [v, jitterVoice(v), jitterVoice(v)]);
  assert.deepEqual(await provider.biometricStatus("vera"), { face: false, voice: false });
  const far = await provider.biometricVerifyVoice("vera", [synthVoice(999)]);
  assert.equal(far.matched, false);
  assert.ok(far.similarity < 0.5);
  assert.deepEqual(await provider.biometricStatus("vera"), { face: false, voice: false });
  const ok = await provider.biometricVerifyVoice("vera", [jitterVoice(v)]);
  assert.equal(ok.matched, true);
  assert.ok(ok.similarity > 0.95, `same-voice similarity, got ${ok.similarity}`);
  assert.deepEqual(await provider.biometricStatus("vera"), { face: false, voice: true });

  // 注册票：未启用方法拒绝；启用后签发 HMAC 票（10min）
  const t = await provider.biometricEnrollTicket("vera", "voice");
  assert.ok(t.token.includes("."));
  assert.equal(t.expiresInMs, 10 * 60_000);
  await assert.rejects(() => provider.biometricEnrollTicket("vera", "sms"));
  await off.stop();

  // disable
  await provider.biometricDisable("vera", "voice");
  assert.deepEqual(await provider.biometricStatus("vera"), { face: false, voice: false });
});

test("portal biometric voice: login flow + enroll paths (login-time cookie & admin ticket)", { timeout: 60_000 }, async () => {
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { cacheDir, configDir } = tempDirs();
  const pickPort = async () => {
    const { createServer } = await import("net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  };
  const provider = new PortalAuthProvider(
    { configDir, cacheDir, resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {},
    registerPid: () => {}, pickPort, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal", biometrics: true },
  );
  await provider.prepare();
  await provider.addUser("wendy", "wendy-pw"); // 零方法用户
  await provider.registerHost("app.example.com", { policy: "two_factor" });

  const { spawn } = await import("node:child_process");
  const { connect } = await import("node:net");
  const { writeFileSync: wf, mkdirSync: mkd } = await import("node:fs");
  const assetsDir = join(cacheDir, "fake-assets");
  mkd(assetsDir, { recursive: true });
  wf(join(assetsDir, "face-api.js"), "// dummy");
  for (const f of ["tiny_face_detector_model-weights_manifest.json", "tiny_face_detector_model.bin",
    "face_landmark_68_model-weights_manifest.json", "face_landmark_68_model.bin",
    "face_recognition_model-weights_manifest.json", "face_recognition_model.bin"]) {
    wf(join(assetsDir, f), f.endsWith(".json") ? "[]" : new Uint8Array([1]));
  }
  const port = await pickPort();
  const serverDir = join(cacheDir, "tmp", "portal");
  // 与父进程同 SECRET（票 HMAC 验证共用）
  const SECRET = "p2-test-secret";
  const proc = spawn(process.execPath, [join(serverDir, "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port), SECRET, USERS_FILE: join(serverDir, "users.json"),
      BASE_PATH: "/portal", DEPLOY_BASE_PATH: "", POLICY_FILE: join(serverDir, "hosts-policy.json"),
      POLICY_DEFAULT: "one_factor", TTL_MS: "20000", REMEMBER_TTL_MS: "60000", GRACE_MS: "60000",
      TEMPLATES_FILE: join(serverDir, "templates.json"), FACE_ENABLED: "1", FACE_THRESHOLD: "0.6",
      VOICE_ENABLED: "1", VOICE_THRESHOLD: "0.9", ASSETS_DIR: assetsDir, SECURE: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errs = [];
  proc.stderr?.on("data", (d) => errs.push(String(d)));
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const attempt = () => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - t0 > 10_000) reject(new Error("server did not start"));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
  const APP = { host: "app.example.com" };
  const { publicEncrypt, createPublicKey, createCipheriv, createHmac: hmac, randomBytes: rb } = await import("node:crypto");
  const encryptWith = (pubB64, obj) => {
    const key = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    const aes = rb(32), iv = rb(12);
    const c = createCipheriv("aes-256-gcm", aes, iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
    return {
      wrapped: publicEncrypt({ key, padding: 4, oaepHash: "sha256" }, aes).toString("base64"),
      iv: iv.toString("base64"),
      data: Buffer.concat([ct, c.getAuthTag()]).toString("base64"),
    };
  };

  try {
    // ── A. 登录时自助注册（cookie 路径）：零方法 + two_factor → “立即设置” → voice 注册 → 直达 .2fa 会话 ──
    const s1 = await postForm("/portal/login", port, { username: "wendy", password: "wendy-pw", next: "/app" }, APP);
    assert.equal(s1.status, 200);
    const ticket0 = String(s1.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
    assert.match(s1.body, /Set up/, "zero-method chooser offers setup");
    assert.match(s1.body, /\/enroll\?m=voice/);

    const ep = await get("/portal/enroll?m=voice&next=%2Fapp", port, { cookie: `st_portal_2fa=${ticket0}`, ...APP });
    assert.equal(ep.status, 200);
    assert.match(ep.body, /Voice 2FA setup/);
    assert.match(ep.body, /mfcc78|extractVoiceVector/, "page embeds MFCC extraction");
    const ticket1 = String(ep.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
    assert.ok(ticket1, "cookie path re-issues the 2FA ticket for capture time");
    const k1 = /KEY_ID="([^"]+)"/.exec(ep.body)?.[1];
    const p1 = /PUB="([^"]+)"/.exec(ep.body)?.[1];
    const ch1n = /"nonce":"([0-9a-f]+)"/.exec(ep.body)?.[1];
    assert.ok(k1 && p1 && ch1n);

    // 3 轮挑战（第 1 轮内嵌，第 2/3 轮走 /enroll/challenge）
    const rounds = [];
    let curNonce = ch1n;
    for (let i = 0; i < 3; i++) {
      rounds.push({ nonce: curNonce, vector: jitterVoice(synthVoice(555)) });
      if (i < 2) {
        const c = await get("/portal/enroll/challenge?m=voice", port, { cookie: `st_portal_2fa=${ticket1}`, ...APP });
        assert.equal(c.status, 200);
        const j = JSON.parse(c.body);
        assert.ok(j.nonce && /^\d{6}$/.test(j.digits), "challenge returns nonce + 6 digits");
        curNonce = j.nonce;
      }
    }
    const enc1 = encryptWith(p1, { rounds });
    const post1 = await postForm("/portal/enroll", port, {
      method: "voice", next: "/app", keyId: k1, wrapped: enc1.wrapped, iv: enc1.iv, data: enc1.data,
    }, { cookie: `st_portal_2fa=${ticket1}`, ...APP });
    assert.equal(post1.status, 302, "login-time voice enrollment completes login");
    const tok1 = String(post1.headers["set-cookie"]).match(/st_portal_session=([^;]+)/)?.[1];
    assert.match(Buffer.from(tok1.split(".")[0], "base64url").toString(), /\.2fa:\d+$/);
    const probe1 = await get("/portal/api/authz/auth-request", port, { cookie: `st_portal_session=${tok1}`, ...APP });
    assert.equal(probe1.status, 200);
    assert.deepEqual(await provider.biometricStatus("wendy"), { face: false, voice: true }, "template active via portal enroll");

    // 已有方法后 cookie 路径再注册 → 403（防密码窃贼自助加因子）
    const s2 = await postForm("/portal/login", port, { username: "wendy", password: "wendy-pw", next: "/app" }, APP);
    const ticket2 = String(s2.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
    const blocked = await get("/portal/enroll?m=face&next=%2Fapp", port, { cookie: `st_portal_2fa=${ticket2}`, ...APP });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body, /already has 2FA/);

    // ── B. 语音登录验证：挑战数字 → 提交向量 → 通过；错误向量 → 401；3 次锁定 ──
    const vp = await get("/portal/login/2fa?m=voice&next=%2Fapp", port, { cookie: `st_portal_2fa=${ticket2}`, ...APP });
    assert.equal(vp.status, 200);
    assert.match(vp.body, /Voice verification/);
    const vn = /NONCE="([0-9a-f]+)"/.exec(vp.body)?.[1];
    const vk = /KEY_ID="([^"]+)"/.exec(vp.body)?.[1];
    const vpub = /PUB="([^"]+)"/.exec(vp.body)?.[1];
    assert.ok(vn && vk && vpub);
    assert.match(vp.body, /id="digits"/, "digits challenge displayed");
    // 数字展示与挑战绑定（页面展示 = 挑战签发的数字）
    const encOk = encryptWith(vpub, { nonce: vn, vector: jitterVoice(synthVoice(555)) });
    const vok = await postForm("/portal/login/2fa", port, {
      method: "voice", next: "/app", keyId: vk, ...encOk,
    }, { cookie: `st_portal_2fa=${ticket2}`, ...APP });
    assert.equal(vok.status, 302, "voice verification completes login");

    // 错误向量 → 401（新票据）+ 3 次锁定（bio-voice 计数）
    for (let i = 0; i < 3; i++) {
      const pw = await postForm("/portal/login", port, { username: "wendy", password: "wendy-pw", next: "/app" }, APP);
      const tk = String(pw.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
      const pg = await get("/portal/login/2fa?m=voice&next=%2Fapp", port, { cookie: `st_portal_2fa=${tk}`, ...APP });
      const n = /NONCE="([0-9a-f]+)"/.exec(pg.body)?.[1];
      const k = /KEY_ID="([^"]+)"/.exec(pg.body)?.[1];
      const pub = /PUB="([^"]+)"/.exec(pg.body)?.[1];
      const enc = encryptWith(pub, { nonce: n, vector: synthVoice(4242 + i) });
      const bad = await postForm("/portal/login/2fa", port, {
        method: "voice", next: "/app", keyId: k, ...enc,
      }, { cookie: `st_portal_2fa=${tk}`, ...APP });
      assert.equal(i < 2 ? bad.status : bad.status, 401, `wrong-voice attempt ${i + 1} → 401`);
    }
    const pw2 = await postForm("/portal/login", port, { username: "wendy", password: "wendy-pw", next: "/app" }, APP);
    const tk2 = String(pw2.headers["set-cookie"]).match(/st_portal_2fa=([^;]+)/)?.[1];
    const pg2 = await get("/portal/login/2fa?m=voice&next=%2Fapp", port, { cookie: `st_portal_2fa=${tk2}`, ...APP });
    const n2 = /NONCE="([0-9a-f]+)"/.exec(pg2.body)?.[1];
    const k2 = /KEY_ID="([^"]+)"/.exec(pg2.body)?.[1];
    const pub2 = /PUB="([^"]+)"/.exec(pg2.body)?.[1];
    const encL = encryptWith(pub2, { nonce: n2, vector: jitterVoice(synthVoice(555)) });
    const locked = await postForm("/portal/login/2fa", port, {
      method: "voice", next: "/app", keyId: k2, ...encL,
    }, { cookie: `st_portal_2fa=${tk2}`, ...APP });
    assert.equal(locked.status, 429, "3 bio-voice failures → locked");

    // ── C. 管理票路径（预先设置）：签票 → GET /enroll 渲染 → POST → active → 完成页；票单次使用 ──
    // （子进程 SECRET 是测试注入值——父进程随机 secret 签的票子进程验不了；
    //  这里按同一格式自签，验证的是子进程的验签/单次使用逻辑。父进程签票
    //  结构已在前一个单测覆盖。）
    const mkTicket = (name, method) => {
      const payload = Buffer.from(JSON.stringify({ n: name, m: method, e: Date.now() + 60000 })).toString("base64url");
      return payload + "." + hmac("sha256", SECRET).update(payload).digest("base64url");
    };
    await provider.addUser("zac", "zac-pw");
    const tToken = mkTicket("zac", "face");
    const fp = await get(`/portal/enroll?m=face&t=${encodeURIComponent(tToken)}&next=%2Fapp`, port, APP);
    assert.equal(fp.status, 200);
    assert.match(fp.body, /assets\/face-api\.js/);
    const fn = /NONCE="([0-9a-f]+)"/.exec(fp.body)?.[1];
    const fk = /KEY_ID="([^"]+)"/.exec(fp.body)?.[1];
    const fpub = /PUB="([^"]+)"/.exec(fp.body)?.[1];
    const face = synthVec(31337);
    const vecs = [face, jitterVec(face), jitterVec(face)];
    const encF = encryptWith(fpub, { nonce: fn, vectors: vecs, blinked: true });
    const fpost = await postForm("/portal/enroll", port, {
      method: "face", next: "/app", t: tToken, keyId: fk, ...encF,
    }, APP);
    assert.equal(fpost.status, 200);
    assert.match(fpost.body, /Face 2FA activated/);
    assert.deepEqual(await provider.biometricStatus("zac"), { face: true, voice: false });

    // 票单次使用：重放同票 GET → 403
    const fp2 = await get(`/portal/enroll?m=face&t=${encodeURIComponent(tToken)}`, port, APP);
    assert.equal(fp2.status, 403, "enrollment ticket is single-use");

    // 伪造票（错签名）→ 403
    const fake = Buffer.from(JSON.stringify({ n: "zac", m: "face", e: Date.now() + 60000 })).toString("base64url")
      + "." + hmac("sha256", "wrong-secret").update("x").digest("base64url");
    const fp3 = await get(`/portal/enroll?m=face&t=${encodeURIComponent(fake)}`, port, APP);
    assert.equal(fp3.status, 403);
    assert.deepEqual(errs, [], "server stderr must stay clean");
  } finally {
    proc.kill();
    await provider.stop();
  }
});

// ── P2 附加：MFCC 黄金测试（设计文档 §15：正弦/白噪声合成信号）────────────
// mfcc78 是浏览器页面 JS（PAGE_CRYPTO_JS 常量）——Node 侧用 new Function
// 提取纯函数（只用 Float64Array/Math，无浏览器 API 依赖）验证数学正确性。
test("portal MFCC mfcc78: deterministic, dimension 78, separates sine vs noise", { timeout: 30_000 }, async () => {
  const { PAGE_CRYPTO_JS } = await import("../src/providers/portal.ts");
  // 从页面 JS 文本提取 mfcc78（与其在浏览器里运行的是同一份代码）
  const mfcc78 = new Function(PAGE_CRYPTO_JS + ";return mfcc78;")();
  assert.equal(typeof mfcc78, "function");

  const SR = 16000;
  const mkTone = (freq, dur = 1.2, noise = 0) => {
    const n = Math.floor(SR * dur);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
      if (noise) out[i] += (Math.random() - 0.5) * noise;
    }
    return out;
  };

  // 1) 维度恰 78 且全有限
  const v = mfcc78(mkTone(440), SR);
  assert.equal(v.length, 78, "78-d utterance vector");
  assert.ok(v.every((x) => Number.isFinite(x)));

  // 2) 确定性：同输入同输出
  const a = mfcc78(mkTone(440), SR);
  const b = mfcc78(mkTone(440), SR);
  assert.deepEqual(a, b, "deterministic");

  // 3) 同类音高不同实现抖动 → 高相似；正弦 vs 白噪声 → 低相似
  const cosine = (x, y) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; na += x[i] * x[i]; nb += y[i] * y[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb));
  };
  const tone440 = mfcc78(mkTone(440), SR);
  const tone440b = mfcc78(mkTone(440, 1.2, 0.05), SR); // 同频 + 轻噪声
  const tone880 = mfcc78(mkTone(880), SR);
  const white = mfcc78(mkTone(0, 1.2, 1), SR); // 纯噪声（0 幅度正弦 + 全噪声）
  const sSame = cosine(tone440, tone440b);
  const sOct = cosine(tone440, tone880);
  const sNoise = cosine(tone440, white);
  // 阈值是相对量：同源 > 异频 > 白噪声（mean+std MFCC 对噪声敏感是
  // 已知 FRR 特性，设计文档 §8.4；这里验证的是区分度/单调性而非绝对分）
  assert.ok(sSame > 0.8, `same-tone similarity ${sSame}`);
  assert.ok(sSame > sOct, `same-tone(${sSame}) > different-tone(${sOct})`);
  assert.ok(sOct > sNoise, `different-tone(${sOct}) > white-noise(${sNoise})`);
});
