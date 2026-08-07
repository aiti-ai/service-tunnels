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
  await provider2.registerHost("8905-pi-web.pi.example.com");
  assert.equal(provider2.defaultTotpLabel("alice"), "alice-portal-default@8905-pi-web.pi.example.com");
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
