import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

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
      pickPort: async () => {
        const { createServer } = await import("net");
        return new Promise((resolve) => {
          const srv = createServer();
          srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
        });
      },
      log: () => {},
    },
    { user: { name: "admin", password: "pw" } },
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
