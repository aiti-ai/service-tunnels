import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netServer } from "node:net";
import { request as httpRequest } from "node:http";

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-token-"));
  return { configDir: join(base, "config"), cacheDir: join(base, "cache"), base };
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function ctxOf(dirs) {
  return {
    configDir: dirs.configDir,
    cacheDir: dirs.cacheDir,
    resolveTool: async () => process.execPath,
    registerInternal: () => {},
    unregisterInternal: () => {},
    registerPid: () => {},
    pickPort,
    log: () => {},
  };
}

function get(url, authorization) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      authorization ? { headers: { Authorization: authorization } } : undefined,
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("token provider: create/list/revoke + sha256 store (no plaintext) + expiry sweep", async () => {
  const { TokenAuthProvider, hashToken, verifyBearerToken } = await import("../src/providers/token.ts");
  const dirs = tempDirs();
  try {
    const provider = new TokenAuthProvider(ctxOf(dirs), { site: "default" });
    assert.equal(provider.gatewayMode, "token");
    assert.equal(provider.authzPath, "/token-authz/auth");
    assert.equal(provider.defaultBasePath(), "");

    // create: full token returned ONCE
    const created = await provider.createToken({ description: "ci pipeline", expiresAt: Date.now() + 3600_000 });
    assert.ok(created.token, "raw token must be returned on create");
    assert.match(created.token, /^st_[A-Za-z0-9_-]{32}$/);
    assert.equal(created.description, "ci pipeline");

    // list: no secret, has id/expiry
    const list = await provider.listTokens();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].token, undefined, "list must never expose the secret");
    assert.equal(list[0].expiresAt !== null, true);

    // store: only the sha256 hash, never the raw token
    const db = JSON.parse(readFileSync(provider.tokensFile, "utf8"));
    assert.equal(db[created.id].hash, hashToken(created.token));
    assert.equal(JSON.stringify(db).includes(created.token), false, "raw token must not be persisted");

    // in-process verification
    assert.equal(verifyBearerToken(`Bearer ${created.token}`, provider.tokensFile), true);
    assert.equal(verifyBearerToken(`bearer ${created.token}`, provider.tokensFile), true, "scheme case-insensitive");
    assert.equal(verifyBearerToken(created.token, provider.tokensFile), false, "raw token without Bearer scheme rejected");
    assert.equal(verifyBearerToken("Bearer wrong-token", provider.tokensFile), false);
    assert.equal(verifyBearerToken(undefined, provider.tokensFile), false);

    // expired token → rejected + swept from list (simulate clock passage by
    // rewriting the record's expiresAt to the past — createToken refuses
    // already-expired values by design)
    const short = await provider.createToken({ description: "short-lived", expiresAt: Date.now() + 3600_000 });
    const dbRaw = JSON.parse(readFileSync(provider.tokensFile, "utf8"));
    dbRaw[short.id].expiresAt = Date.now() - 1000;
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(provider.tokensFile, ".."), { recursive: true });
    writeFileSync(provider.tokensFile, JSON.stringify(dbRaw), "utf8");
    assert.equal(verifyBearerToken(`Bearer ${short.token}`, provider.tokensFile), false, "expired token rejected");
    const after = await provider.listTokens();
    assert.equal(after.length, 1, "expired token swept from list");
    assert.equal(after[0].id, created.id);

    // revoke
    await provider.revokeToken(created.id);
    assert.equal(verifyBearerToken(`Bearer ${created.token}`, provider.tokensFile), false, "revoked token rejected");
    assert.equal((await provider.listTokens()).length, 0);
    await assert.rejects(() => provider.revokeToken(created.id), /not registered/);
    await assert.rejects(() => provider.createToken({ expiresAt: Date.now() - 1 }), /future/);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("token provider: spawned probe server validates Bearer over HTTP (nginx auth_request path)", { timeout: 30_000 }, async () => {
  const { TokenAuthProvider } = await import("../src/providers/token.ts");
  const dirs = tempDirs();
  let provider;
  try {
    provider = new TokenAuthProvider(ctxOf(dirs));
    await provider.start();
    const port = provider.port;
    assert.ok(port > 0);

    const tok = await provider.createToken({ description: "server-probe" });

    // probe without auth → 401 + WWW-Authenticate Bearer
    const noAuth = await get(`http://127.0.0.1:${port}/token-authz/auth`);
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers["www-authenticate"] ?? "", /Bearer/);

    // probe with valid Bearer → 200
    const ok = await get(`http://127.0.0.1:${port}/token-authz/auth`, `Bearer ${tok.token}`);
    assert.equal(ok.status, 200);

    // wrong token → 401
    const bad = await get(`http://127.0.0.1:${port}/token-authz/auth`, "Bearer nope");
    assert.equal(bad.status, 401);

    // revoke → probe 401 (server reads tokens.json per request, no restart)
    await provider.revokeToken(tok.id);
    const revoked = await get(`http://127.0.0.1:${port}/token-authz/auth`, `Bearer ${tok.token}`);
    assert.equal(revoked.status, 401);
  } finally {
    if (provider) await provider.stop();
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("token gateway mode: nginx config has auth_request → /token-authz/auth, no @auth_redirect, WWW-Authenticate", async () => {
  const { generateHostNginx } = await import("../src/gateway.ts");
  const host = generateHostNginx(
    { host: "api.ngrok-free.app", port: 5173, authMode: "token", authPort: 4181, site: "default" },
    { nginxPort: 8080, nginxRoot: "/tmp/st-gw" },
  );
  assert.match(host, /auth_request \/token-authz\/auth;/);
  assert.match(host, /location = \/token-authz\/auth/);
  assert.match(host, /proxy_pass http:\/\/127\.0\.0\.1:4181\/token-authz\/auth/);
  assert.match(host, /WWW-Authenticate 'Bearer realm="service-tunnels"'/);
  assert.equal(host.includes("@auth_redirect"), false, "token mode must not redirect to a login page");
  assert.equal(host.includes("auth_basic"), false);
  // Authorization must be forwarded to the probe (auth_request strips it by default)
  assert.match(host, /proxy_set_header Authorization \$http_authorization/);
  // upstream proxy still present
  assert.match(host, /proxy_pass http:\/\/127\.0\.0\.1:5173/);
});

test("decision API: Bearer token verified in-process for labeled vhosts (gateBackend)", async () => {
  const { TokenAuthProvider, hashToken } = await import("../src/providers/token.ts");
  const { resolveServiceHost } = await import("../src/proxy.ts");
  const dirs = tempDirs();
  try {
    const provider = new TokenAuthProvider(ctxOf(dirs));
    const tok = await provider.createToken({ description: "api" });

    const ctx = {
      suffixes: ["localhost"],
      isAllowed: () => true,
      resolveLabel: () => "default",
      resolveSite: async () => ({ tokenFile: provider.tokensFile }),
      basePath: "",
      serviceBasePath: "",
    };

    // valid Bearer → pipe straight to the service
    const ok = await resolveServiceHost(
      { host: "5173-token.localhost", url: "/api/x", authorization: `Bearer ${tok.token}` },
      ctx,
    );
    assert.equal(ok.kind, "pipe");
    assert.equal(ok.port, 5173);

    // missing/wrong token → 401 with Bearer challenge (no login redirect)
    const denied = await resolveServiceHost({ host: "5173-token.localhost", url: "/api/x" }, ctx);
    assert.equal(denied.kind, "deny-auth");
    assert.equal(denied.status, 401);
    assert.match(denied.wwwAuthenticate, /Bearer/);

    // store is hashed — the raw token never lands in the db
    const db = JSON.parse(readFileSync(provider.tokensFile, "utf8"));
    assert.equal(db[tok.id].hash, hashToken(tok.token));
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("registry: token provider registered + tokenManagers() lists it", async () => {
  const { AuthRegistry } = await import("../src/auth-registry.ts");
  const dirs = tempDirs();
  try {
    const reg = new AuthRegistry(ctxOf(dirs));
    assert.ok(reg.has("token"));
    assert.deepEqual(reg.tokenManagers(), ["token"]);
    // site isolation: default vs named site have separate stores
    const defaultMgr = reg.tokenManager("token", "default");
    const siteMgr = reg.tokenManager("token", "my-site");
    const t = await defaultMgr.createToken({ description: "default-site" });
    const s = await siteMgr.createToken({ description: "named-site" });
    assert.equal((await defaultMgr.listTokens()).length, 1);
    assert.equal((await siteMgr.listTokens()).length, 1);
    assert.equal(defaultMgr === siteMgr, false);
    await defaultMgr.revokeToken(t.id);
    await siteMgr.revokeToken(s.id);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});
