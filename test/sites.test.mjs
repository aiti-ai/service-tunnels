import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";

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
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, setCookie: String(res.headers["set-cookie"] ?? ""), body: b }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const get = (port, host, path, cookie) => raw("GET", port, host, path, undefined, cookie);
const post = (port, host, path, body) => raw("POST", port, host, path, body);

async function newSt(tag) {
  const base = mkdtempSync(join(tmpdir(), `st-sites-${tag}-`));
  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({ configDir: join(base, "config"), cacheDir: join(base, "cache"), guardian: false });
  return { base, st, configDir: join(base, "config"), cacheDir: join(base, "cache") };
}

test("P1 user dbs: same name on two sites, independent passwords/removal, isolated files", { timeout: 30_000 }, async () => {
  const { base, st, cacheDir } = await newSt("users");
  try {
    await st.auth.addUser("alice", "pw-default", { provider: "portal", site: "default" });
    await st.auth.addUser("alice", "pw-site", { provider: "portal", site: "pi-web" });

    // isolated storage: default keeps the legacy path; custom site is scoped
    const defFile = join(cacheDir, "tmp", "portal", "users.json");
    const siteFile = join(cacheDir, "tmp", "sites", "pi-web", "portal", "users.json");
    assert.ok(existsSync(defFile), "default db at legacy tmp/portal/users.json");
    assert.ok(existsSync(siteFile), "custom site db at tmp/sites/pi-web/portal/users.json");

    const defDb = JSON.parse(readFileSync(defFile, "utf8"));
    const siteDb = JSON.parse(readFileSync(siteFile, "utf8"));
    assert.ok(defDb.alice && siteDb.alice);
    assert.notEqual(defDb.alice.hash, siteDb.alice.hash, "different passwords → different scrypt hashes");

    // listing is scoped per site
    assert.deepEqual((await st.auth.users("portal", "default"))[0].users.map((u) => u.name), ["alice"]);
    assert.deepEqual((await st.auth.users("portal", "pi-web"))[0].users.map((u) => u.name), ["alice"]);

    // removal is scoped: delete from pi-web leaves default intact
    await st.auth.removeUser("alice", "portal", "pi-web");
    assert.deepEqual((await st.auth.users("portal", "pi-web"))[0].users, []);
    assert.deepEqual((await st.auth.users("portal", "default"))[0].users.map((u) => u.name), ["alice"]);
  } finally {
    await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});

test("P1 st.sites list/add/get/remove + name validation", { timeout: 20_000 }, async () => {
  const { base, st } = await newSt("api");
  try {
    assert.deepEqual(st.sites.list().map((s) => s.name), ["default"], "implicit default listed first");

    st.sites.add("pi-web", { provider: "portal", auth: true, basePath: "/portal-pw", policy: "two_factor", domain: "web.pi.example.com", suffix: "pi-web" });
    const s = st.sites.get("pi-web");
    assert.equal(s?.provider, "portal");
    assert.equal(s?.policy, "two_factor");
    assert.equal(s?.basePath, "/portal-pw");
    assert.equal(s?.domain, "web.pi.example.com");
    assert.ok(st.sites.list().some((x) => x.name === "pi-web"));
    assert.equal(st.sites.get("default")?.name, "default", "implicit default readable");

    // validation
    assert.throws(() => st.sites.add("auth", {}), /reserved/);
    assert.throws(() => st.sites.add("default", {}), /implicit/);
    assert.throws(() => st.sites.add("Bad_Name", {}), /invalid site name/);
    assert.throws(() => st.sites.add("pi_web", {}), /invalid site name/);

    st.sites.remove("pi-web");
    assert.equal(st.sites.get("pi-web"), undefined);
    assert.deepEqual(st.sites.list().map((s) => s.name), ["default"]);
  } finally {
    await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});

test("P1 end-to-end: proxy vhosts of two sites authenticate against their OWN user dbs", { timeout: 40_000 }, async () => {
  const { base, st } = await newSt("e2e");
  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("echo:" + _q.url);
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const port = app.address().port;
  try {
    st.sites.add("pi-web", { provider: "portal" });
    await st.auth.addUser("alice", "pw-default", { provider: "portal", site: "default" });
    await st.auth.addUser("alice", "pw-site", { provider: "portal", site: "pi-web" });

    // two bindings on the SAME port, different sites
    const rDefault = await st.auth.expose(port, { mode: "proxy", auth: true, provider: "portal", site: "default", proxyPort: 0, user: { name: "admin", password: "x" } });
    const rWeb = await st.auth.expose(port, { mode: "proxy", auth: true, provider: "portal", site: "pi-web", proxyPort: 0, user: { name: "admin", password: "y" } });
    assert.equal(rDefault.label, "auth");
    assert.equal(rWeb.label, "pi-web");
    const tp = Number(new URL(rDefault.localUrl).port);
    const vDefault = `${port}-auth.st.localhost`;
    const vWeb = `${port}-pi-web.st.localhost`;

    // portal session cookies are named per auth realm (site), so nested
    // proxies on the same host never collide: default → st_portal_session,
    // site pi-web → st_portal_pi-web_session.
    const cookieName = (site) => site === "default" ? "st_portal_session" : `st_portal_${site}_session`;
    const login = async (vhost, user, pass, site = "default") => {
      const unauth = await get(tp, vhost, "/");
      assert.equal(unauth.status, 302, `${vhost} requires login`);
      const basePath = new URL(unauth.location).pathname.replace(/\/login$/, "");
      const res = await post(tp, vhost, `${basePath}/login`, `username=${user}&password=${pass}`);
      return res.setCookie.match(new RegExp(cookieName(site) + "=([^;]+)"))?.[0];
    };

    // default site: only pw-default works
    assert.ok(await login(vDefault, "alice", "pw-default", "default"), "default site: alice/pw-default ok");
    assert.equal(await login(vDefault, "alice", "pw-site", "default"), undefined, "default site rejects pw-site");
    // pi-web site: only pw-site works (opposite)
    assert.ok(await login(vWeb, "alice", "pw-site", "pi-web"), "pi-web site: alice/pw-site ok");
    assert.equal(await login(vWeb, "alice", "pw-default", "pi-web"), undefined, "pi-web site rejects pw-default");

    // and with the right cookie each vhost passes through to the app
    const cookieDefault = await login(vDefault, "alice", "pw-default", "default");
    const authed = await get(tp, vDefault, "/secret", cookieDefault);
    assert.equal(authed.status, 200);
    assert.equal(authed.body, "echo:/secret");
  } finally {
    await st.shutdown();
    app.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("P3 site domain: domainUrl + <port>.<site-domain> vhost serves the site auth", { timeout: 40_000 }, async () => {
  const { base, st } = await newSt("domain");
  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("echo:" + _q.url);
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const port = app.address().port;
  try {
    st.sites.add("pi-web", { provider: "portal", domain: "web.pi.example.com" });
    await st.auth.addUser("alice", "pw", { provider: "portal", site: "pi-web" });

    const r = await st.auth.expose(port, { mode: "proxy", auth: true, provider: "portal", site: "pi-web", proxyPort: 0, user: { name: "admin", password: "x" } });
    assert.equal(r.domainUrl, `http://${port}.web.pi.example.com`, `domainUrl, got ${r.domainUrl}`);
    const tp = Number(new URL(r.localUrl).port);

    // the site-domain vhost (NO dash label — suffix implies the site) is
    // accepted and requires THIS site's login
    const viaDomain = await get(tp, `${port}.web.pi.example.com`, "/");
    assert.equal(viaDomain.status, 302, "site-domain vhost requires login");
    assert.ok(viaDomain.location.includes("/login?next="), `redirect to portal login, got ${viaDomain.location}`);

    // login through the site-domain vhost works (same site instance)
    const basePath = new URL(viaDomain.location).pathname.replace(/\/login$/, "");
    const loginRes = await post(tp, `${port}.web.pi.example.com`, `${basePath}/login`, "username=alice&password=pw");
    assert.ok(loginRes.setCookie.includes("st_portal_pi-web_session="), "login via site-domain vhost (per-site cookie)");

    // the labeled vhost still works too
    assert.equal((await get(tp, `${port}-pi-web.st.localhost`, "/")).status, 302);
  } finally {
    await st.shutdown();
    app.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("P4 bindings persisted to state.json and restored into a fresh manager", { timeout: 30_000 }, async () => {
  const { base, st, cacheDir } = await newSt("persist");
  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("ok");
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const port = app.address().port;
  try {
    const r = await st.auth.expose(port, { mode: "proxy", auth: true, provider: "portal", site: "pi-web", proxyPort: 0, user: { name: "admin", password: "x" } });
    assert.ok(r.localUrl);

    // state.json carries the enrollment
    const state = JSON.parse(readFileSync(join(cacheDir, "state.json"), "utf8"));
    const persisted = state.bindings.filter((b) => b.port === port);
    assert.ok(persisted.some((b) => b.label === "pi-web" && b.site === "pi-web" && b.provider === "portal"), `bindings persisted, got ${JSON.stringify(persisted)}`);

    // a fresh manager restores the same bindings (daemon-restart semantics)
    const { ProxyManager } = await import("../src/proxy-manager.ts");
    const pm = new ProxyManager({});
    pm.restore(state.bindings);
    assert.equal(pm.binding(port, "pi-web")?.site, "pi-web");
    assert.equal(pm.binding(port, "pi-web")?.provider, "portal");
  } finally {
    await st.shutdown();
    app.close();
    rmSync(base, { recursive: true, force: true });
  }
});
