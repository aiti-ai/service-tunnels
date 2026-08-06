import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";

/**
 * DEFAULT scenario e2e — NO stubs. This is exactly how host calls it:
 *   st.auth.expose(port, { auth: true, provider: "authelia", tunnel: "cloudflared" })
 * with REAL cloudflared + REAL authelia + REAL redis + REAL nginx.
 *
 * Verifies the real default stack comes up end-to-end: a real trycloudflare
 * URL, the shared nginx gateway, authelia, redis, a login URL, and that an
 * unauthenticated request is blocked by authelia forward-auth.
 */

const BINS = {
  cloudflared: "/usr/local/bin/cloudflared",
  authelia: "/usr/bin/authelia",
  redis: "/usr/bin/redis-server",
  nginx: "/usr/sbin/nginx",
};

function httpGet(port, host, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: b }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("DEFAULT e2e: real cloudflared + authelia + redis + nginx (no stubs)", { timeout: 120_000 }, async (t) => {
  // Real-cloudflared e2e needs network + real binaries and can be rate-
  // limited when run back-to-back with other cloudflared tests, so it is
  // gated out of the default `npm test` run. Run explicitly with ST_E2E=1.
  if (!process.env.ST_E2E) {
    t.skip("set ST_E2E=1 to run the real-cloudflared default-scenario e2e");
    return;
  }
  for (const [name, path] of Object.entries(BINS)) {
    if (!existsSync(path)) {
      console.log(`skip: ${name} not at ${path}`);
      writeFileSync("/tmp/st-default-result.json", JSON.stringify({ skipped: name }));
      return;
    }
  }

  const { createServiceTunnels } = await import("../src/index.ts");
  // default ServiceTunnels; only explicit thing is where cloudflared lives
  // (~/bin is not on the test process PATH). guardian stays on (default) so
  // nginx/authelia/redis are reaped when the test process exits.
  const st = createServiceTunnels({ toolPaths: { cloudflared: BINS.cloudflared } });

  const app = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("hello default scenario");
  });
  const app2 = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("hello second app");
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  await new Promise((res) => app2.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;
  const app2Port = app2.address().port;

  const summary = { appPort };
  try {
    const exposed = await st.auth.expose(appPort, {
      auth: true,
      provider: "authelia",
      tunnelType: "cloudflared",
      tunnelName: "default-e2e",
    });

    summary.url = exposed.url;
    summary.gateway = exposed.gateway;
    summary.loginUrl = exposed.loginUrl;
    summary.error = exposed.error;

    // 1) a REAL trycloudflare URL (not a stub)
    assert.match(exposed.url ?? "", /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, "real cloudflared trycloudflare URL");

    // 2) the full default stack came up
    assert.ok(exposed.gateway?.nginx > 0, "nginx gateway started");
    assert.ok(exposed.gateway?.authelia > 0, "authelia started");
    assert.ok(exposed.gateway?.redis > 0, "redis started (authelia session store)");
    assert.ok(exposed.loginUrl, "login URL provided");

    // 3) unauthenticated request through the gateway is BLOCKED by authelia
    const host = new URL(exposed.url).host;
    const probe = await httpGet(exposed.gateway.nginx, host, "/");
    summary.unauthStatus = probe.status;
    assert.ok(
      [401, 403, 302].includes(probe.status),
      `unauthed request blocked by authelia (got ${probe.status})`,
    );

    // 4) SECOND expose (same ServiceTunnels) reuses the SAME nginx — the
    //    singleton fix. Real cloudflared again, a different host, but ONE nginx.
    const exposed2 = await st.auth.expose(app2Port, {
      auth: true,
      provider: "authelia",
      tunnelType: "cloudflared",
      tunnelName: "default-e2e-2",
    });
    summary.url2 = exposed2.url;
    summary.gateway2 = exposed2.gateway;
    assert.match(exposed2.url ?? "", /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, "second real cloudflared URL");
    assert.equal(
      exposed2.gateway?.nginx,
      exposed.gateway.nginx,
      "second expose reuses the SAME shared nginx (singleton)",
    );

    summary.result = "PASS";
  } catch (err) {
    summary.result = "FAIL";
    summary.error = String(err?.message ?? err);
    throw err;
  } finally {
    await st.shutdown();
    app.close();
    app2.close();
    writeFileSync("/tmp/st-default-result.json", JSON.stringify(summary, null, 2));
  }
});
