import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";

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
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, setCookie: String(res.headers["set-cookie"] ?? ""), body: b }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function get(port, host, path, cookie) {
  return raw("GET", port, host, path, undefined, cookie);
}

function post(port, host, path, body) {
  return raw("POST", port, host, path, body);
}

function fakeBin(dir, name, url) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho '${url}'\nsleep 60\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

test("expose --mode proxy: enrollment (D4) + portal auth on a local vhost", { timeout: 40_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "st-proxy-mode-"));
  const configDir = join(base, "config");
  const cacheDir = join(base, "cache");
  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({ configDir, cacheDir, guardian: false });

  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("echo:" + _q.url);
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const port = app.address().port;

  try {
    // 1. nothing enrolled → open vhost 403 (D4 default zero forwarding)
    const tp = await st.proxy.start({ port: 0 });
    const deny = await get(tp, `${port}.st.localhost`, "/");
    assert.equal(deny.status, 403);
    assert.match(deny.body, /not enrolled/);

    // 2. enroll via expose --mode proxy (auth portal on the DEFAULT site —
    // explicit provider without --site keeps the default realm; the vhost
    // label carries the provider name)
    const r = await st.auth.expose(port, {
      mode: "proxy",
      auth: true,
      provider: "portal",
      user: { name: "admin", password: "pw" },
      proxyPort: 0,
    });
    assert.equal(r.mode, "proxy");
    assert.equal(r.site, "default");   // auth realm stays default
    assert.equal(r.label, "portal"); // vhost label = provider name
    assert.ok(r.localUrl, `localUrl present, got ${JSON.stringify(r)}`);
    const url = new URL(r.localUrl);
    const tp2 = Number(url.port);
    assert.equal(tp2, tp, "same shared transport port");
    const vhost = url.host.split(":")[0];
    assert.equal(vhost, `${port}-portal.st.localhost`);

    // 3. unauthenticated app path → 302 to the portal login (through the vhost)
    const unauth = await get(tp, vhost, "/app");
    assert.equal(unauth.status, 302);
    assert.ok(unauth.location.includes("/login?next="), `redirect to portal login, got ${unauth.location}`);
    // derive the provider basePath from the redirect (random per instance)
    const basePath = new URL(unauth.location).pathname.replace(/\/login$/, "");
    assert.ok(basePath.startsWith("/portal"), `portal basePath, got ${basePath}`);

    // 4. login page served THROUGH the vhost (basePath → provider port)
    const loginPage = await get(tp, vhost, `${basePath}/login`);
    assert.equal(loginPage.status, 200);

    // 5. real portal login via the vhost → session cookie → authenticated pass
    const loginRes = await post(tp, vhost, `${basePath}/login`, "username=admin&password=pw");
    const cookie = loginRes.setCookie.match(/st_portal_session=([^;]+)/)?.[0];
    assert.ok(cookie, "portal login via vhost yields session cookie");
    const authed = await get(tp, vhost, "/secret", cookie);
    assert.equal(authed.status, 200);
    assert.equal(authed.body, "echo:/secret");

    // 6. open form still NOT enrolled (only the labeled binding exists)
    const openDeny = await get(tp, `${port}.st.localhost`, "/");
    assert.equal(openDeny.status, 403);
    assert.match(openDeny.body, /not enrolled/);

    // 7. st.exposes() surfaces site / localUrl
    const list = st.exposes();
    assert.ok(
      list.some((e) => e.port === port && e.site === "default" && e.label === "portal" && e.localUrl === r.localUrl),
      `exposes() has the proxy record, got ${JSON.stringify(list)}`,
    );

    // 8. stop the transport → no listener at all (D4: nothing served without it)
    await st.proxy.stop();
    await assert.rejects(() => get(tp, vhost, "/app"), /ECONNREFUSED/);
  } finally {
    await st.shutdown();
    app.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("expose --mode proxy --auth none: open binding; --mode both: local + tunnel share the site", { timeout: 40_000 }, async () => {
  if (process.platform === "win32") return; // 需要 nginx
  const base = mkdtempSync(join(tmpdir(), "st-proxy-both-"));
  const configDir = join(base, "config");
  const cacheDir = join(base, "cache");
  const binDir = join(base, "bin");
  fakeBin(binDir, "ngrok", "https://both.ngrok-free.app");
  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({
    configDir,
    cacheDir,
    guardian: false,
    toolPaths: { ngrok: join(binDir, "ngrok") },
  });

  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("echo:" + _q.url);
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const port = app.address().port;

  try {
    // open binding: <port>.st.localhost serves directly, no auth
    const o = await st.auth.expose(port, { mode: "proxy", auth: "none", proxyPort: 0 });
    assert.equal(o.label, "");
    const tp = new URL(o.localUrl).port;
    const open = await get(Number(tp), `${port}.st.localhost`, "/x");
    assert.equal(open.status, 200);
    assert.equal(open.body, "echo:/x");

    // both: local vhost + public tunnel, one site (portal)
    const b = await st.auth.expose(port, {
      mode: "both",
      auth: true,
      provider: "portal",
      user: { name: "admin", password: "pw" },
      tunnelType: "ngrok",
      tunnelName: "both-t",
      proxyPort: 0,
    });
    assert.equal(b.mode, "both");
    assert.equal(b.url, "https://both.ngrok-free.app");
    assert.ok(b.localUrl?.includes(`${port}-portal.st.localhost`), `localUrl, got ${b.localUrl}`);
    const bl = new URL(b.localUrl);
    const bvhost = bl.host.split(":")[0];
    const bport = Number(bl.port);

    // the local portal login works through the vhost (same portal instance
    // that the tunnel host was registered with)
    const unauth = await get(bport, bvhost, "/");
    assert.equal(unauth.status, 302);
    assert.ok(unauth.location.includes("/login?next="), `redirect, got ${unauth.location}`);
    const basePath = new URL(unauth.location).pathname.replace(/\/login$/, "");
    const loginRes = await post(bport, bvhost, `${basePath}/login`, "username=admin&password=pw");
    assert.ok(loginRes.setCookie.includes("st_portal_session="), "portal cookie via vhost");
  } finally {
    await st.shutdown();
    app.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("expose --mode proxy with baseDomain: portless base URL + base-domain suffix served", { timeout: 40_000 }, async () => {
  if (process.platform === "win32") return; // 需要 nginx
  const base = mkdtempSync(join(tmpdir(), "st-proxy-base-"));
  const configDir = join(base, "config");
  const cacheDir = join(base, "cache");
  const { writeConfigFile } = await import("../src/config.ts");
  writeConfigFile(configDir, { baseDomain: "example.com", proxyPort: 0 });
  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({ configDir, cacheDir, guardian: false });
  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("echo:" + _q.url);
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const port = app.address().port;
  try {
    const r = await st.auth.expose(port, { mode: "proxy", auth: true, provider: "portal", user: { name: "admin", password: "pw" } });
    // TWO addresses: default portful local URL + portless base URL
    assert.ok(r.localUrl, "localUrl present");
    assert.equal(r.baseUrl, `http://${port}-portal.example.com`, `portless base URL, got ${r.baseUrl}`);
    const tp = Number(new URL(r.localUrl).port);

    // the base-domain host is accepted by the transport (suffix list)…
    const baseHost = `${port}-portal.example.com`;
    const viaBase = await get(tp, baseHost, "/");
    assert.equal(viaBase.status, 302, "base-domain vhost requires login");
    assert.ok(viaBase.location.startsWith("http://"), "local scheme http");

    // …and the default localhost host still works
    const viaLocal = await get(tp, `${port}-portal.st.localhost`, "/");
    assert.equal(viaLocal.status, 302);

    // login via the base-domain vhost (no port in the URL)
    const basePath = new URL(viaBase.location).pathname.replace(/\/login$/, "");
    const loginRes = await post(tp, baseHost, `${basePath}/login`, "username=admin&password=pw");
    assert.ok(loginRes.setCookie.includes("st_portal_session="), "login via base-domain vhost");
  } finally {
    await st.shutdown();
    app.close();
    rmSync(base, { recursive: true, force: true });
  }
});
