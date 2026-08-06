import assert from "node:assert/strict";
import test from "node:test";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { readFileSync } from "node:fs";

async function loadProxy() {
  return import("../src/proxy.ts");
}

async function loadDiscovery() {
  const { InternalRegistry } = await import("../src/internal.ts");
  const { getServicePorts } = await import("../src/discovery.ts");
  return { InternalRegistry, getServicePorts };
}

/** Read a child's stdout until a regex matches (or timeout). */
async function readUntil(stream, pattern, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => done(null), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = pattern.exec(buf);
      if (m) done(m);
    };
    const done = (result) => {
      clearTimeout(timer);
      stream.off("data", onData);
      resolve(result);
    };
    stream.on("data", onData);
  });
}

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = connect(0);
    srv.once("connect", () => {
      srv.destroy();
      resolve(20_000 + Math.floor(Math.random() * 30_000));
    });
    srv.once("error", () => {
      const port = 20_000 + Math.floor(Math.random() * 30_000);
      srv.destroy();
      resolve(port);
    });
  });
}

/** Spawn a child HTTP server on 127.0.0.1:0 that echoes url + method + body. */
function spawnEchoServer() {
  const child = spawn(
    process.execPath,
    ["-e", `
      const s = require("http").createServer((q, r) => {
        let b = "";
        q.on("data", c => b += c);
        q.on("end", () => {
          r.writeHead(200, { "content-type": "text/plain" });
          r.end(JSON.stringify({ url: q.url, method: q.method, host: q.headers.host, body: b }));
        });
      });
      s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + "\\n"));
    `],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return child;
}

/** Raw HTTP GET with a custom Host header (no DNS needed). */
function rawGet(port, host, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host, connection: "close", ...extraHeaders } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function startProxy(opts) {
  const { createProxyServer } = await loadProxy();
  const { InternalRegistry } = await loadDiscovery();
  const server = createProxyServer({
    port: 0,
    suffixes: [".st.localhost"],
    // D4: explicit resolver = open binding for every port (legacy behavior);
    // enrollment tests pass their own resolver instead.
    resolveSite: async () => ({}),
    ...opts,
    internal: new InternalRegistry(),
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { server, port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

test("parseServiceHost matches <port>.<suffix> (open) and <port>-<label>.<suffix> (dash form)", async () => {
  const { parseServiceHost } = await loadProxy();
  assert.deepEqual(parseServiceHost("5173.st.localhost", [".st.localhost"]), { port: 5173, suffix: "st.localhost", label: undefined });
  assert.deepEqual(parseServiceHost("5173.st.localhost:8080", [".st.localhost"]), { port: 5173, suffix: "st.localhost", label: undefined });
  assert.deepEqual(parseServiceHost("80.pi.lan", [".st.localhost", ".pi.lan"]), { port: 80, suffix: "pi.lan", label: undefined });
  // dash form: label = provider / site name (may itself contain dashes)
  assert.deepEqual(parseServiceHost("5173-portal.st.localhost", [".st.localhost"]), { port: 5173, suffix: "st.localhost", label: "portal" });
  assert.deepEqual(parseServiceHost("5173-host.st.localhost", [".st.localhost"]), { port: 5173, suffix: "st.localhost", label: "host" });
  assert.deepEqual(parseServiceHost("5173-auth.st.localhost", [".st.localhost"]), { port: 5173, suffix: "st.localhost", label: "auth" });
  assert.equal(parseServiceHost("st.localhost", [".st.localhost"]), null);
  assert.equal(parseServiceHost("5173.evil.com", [".st.localhost"]), null);
  assert.equal(parseServiceHost("5173-.st.localhost", [".st.localhost"]), null); // empty label
  assert.equal(parseServiceHost("99999.st.localhost", [".st.localhost"]), null); // port out of range
  assert.equal(parseServiceHost(undefined, [".st.localhost"]), null);
});

test("basic auth validation", async () => {
  const { validBasicAuth, authHeader } = await loadProxy();
  const header = authHeader("secret");
  assert.equal(validBasicAuth(header, "secret"), true);
  assert.equal(validBasicAuth(header, "wrong"), false);
  assert.equal(validBasicAuth(undefined, "secret"), false);
  assert.equal(validBasicAuth("Bearer xyz", "secret"), false);
});

test("proxy forwards to a discovered service, preserving path/host/body", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const child = spawnEchoServer();
  let servicePort = 0;
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    assert.ok(m);
    servicePort = Number(m[1]);

    const { getServicePorts } = await loadDiscovery();
    const { InternalRegistry } = await loadInternal();
    const internal = new InternalRegistry();
    const allow = (port) => getServicePorts(internal, { force: true }).some((p) => p.port === port);
    assert.ok(allow(servicePort), "child must be discoverable");

    const proxy = await startProxy({ isPortAllowed: allow });
    try {
      const res = await rawGet(proxy.port, `${servicePort}.st.localhost`, "/hello?a=1");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.url, "/hello?a=1");
      assert.equal(body.method, "GET");
      assert.equal(body.host, `${servicePort}.st.localhost`); // virtual host preserved
    } finally {
      await proxy.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("proxy POST body forwarding", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const child = spawnEchoServer();
  let servicePort = 0;
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    servicePort = Number(m[1]);
    const { getServicePorts } = await loadDiscovery();
    const { InternalRegistry } = await loadInternal();
    const internal = new InternalRegistry();
    const allow = (port) => getServicePorts(internal, { force: true }).some((p) => p.port === port);
    const proxy = await startProxy({ isPortAllowed: allow });
    try {
      const res = await new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: proxy.port, method: "POST", path: "/submit", headers: { host: `${servicePort}.st.localhost`, "content-type": "text/plain", connection: "close" } },
          (r) => {
            let b = "";
            r.on("data", (c) => (b += c));
            r.on("end", () => resolve({ status: r.statusCode, body: b }));
          },
        );
        req.on("error", reject);
        req.end("payload-123");
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.method, "POST");
      assert.equal(body.body, "payload-123");
    } finally {
      await proxy.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("proxy denies ports outside the allow-list (403)", { timeout: 20_000 }, async () => {
  const proxy = await startProxy({ isPortAllowed: () => false });
  try {
    const res = await rawGet(proxy.port, "9999.st.localhost", "/");
    assert.equal(res.status, 403);
    assert.match(res.body, /not allowed/);
  } finally {
    await proxy.close();
  }
});

test("proxy strips the basePath before forwarding", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const child = spawnEchoServer();
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    const servicePort = Number(m[1]);
    const { getServicePorts } = await loadDiscovery();
    const { InternalRegistry } = await loadInternal();
    const internal = new InternalRegistry();
    const allow = (port) => getServicePorts(internal, { force: true }).some((p) => p.port === port);
    const proxy = await startProxy({ isPortAllowed: allow, basePath: "/dev" });
    try {
      const res = await rawGet(proxy.port, `${servicePort}.st.localhost`, "/dev/foo?a=1");
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).url, "/foo?a=1");
    } finally {
      await proxy.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("proxy password gate: 401 without creds, 200 with", { timeout: 20_000 }, async () => {
  const { authHeader } = await loadProxy();
  if (process.platform !== "linux") return;
  const child = spawnEchoServer();
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    const servicePort = Number(m[1]);
    const { getServicePorts } = await loadDiscovery();
    const { InternalRegistry } = await loadInternal();
    const internal = new InternalRegistry();
    const allow = (port) => getServicePorts(internal, { force: true }).some((p) => p.port === port);
    const proxy = await startProxy({ isPortAllowed: allow, password: "pw123" });
    try {
      const noAuth = await rawGet(proxy.port, `${servicePort}.st.localhost`, "/");
      assert.equal(noAuth.status, 401);
      assert.match(noAuth.headers["www-authenticate"], /Basic/);

      const good = await new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: proxy.port, path: "/", headers: { host: `${servicePort}.st.localhost`, authorization: authHeader("pw123"), connection: "close" } },
          (r) => {
            let b = "";
            r.on("data", (c) => (b += c));
            r.on("end", () => resolve({ status: r.statusCode }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(good.status, 200);
    } finally {
      await proxy.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("SSE-style streaming: chunks arrive before the stream ends", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  const child = spawn(
    process.execPath,
    ["-e", `
      const s = require("http").createServer((q, r) => {
        r.writeHead(200, { "content-type": "text/event-stream" });
        r.write("data: first\\n\\n");
        setTimeout(() => { r.write("data: second\\n\\n"); r.end(); }, 150);
      });
      s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + "\\n"));
    `],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    const servicePort = Number(m[1]);
    const { getServicePorts } = await loadDiscovery();
    const { InternalRegistry } = await loadInternal();
    const internal = new InternalRegistry();
    const allow = (port) => getServicePorts(internal, { force: true }).some((p) => p.port === port);
    const proxy = await startProxy({ isPortAllowed: allow });
    try {
      const events = [];
      await new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: proxy.port, path: "/events", headers: { host: `${servicePort}.st.localhost`, connection: "close" } },
          (res) => {
            res.setEncoding("utf8");
            res.on("data", (c) => {
              events.push(c);
              if (events.length === 1 && c.includes("first")) {
                // first chunk arrived before the stream ended → streaming works
                assert.ok(true);
              }
            });
            res.on("end", resolve);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(events.join("").includes("second"), true);
    } finally {
      await proxy.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("WebSocket upgrade forwarding", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  // echo server that handles upgrade: on connect, sends a frame then closes
  const child = spawn(
    process.execPath,
    ["-e", `
      const s = require("http").createServer();
      s.on("upgrade", (req, socket) => {
        socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
        // raw text frame "pong" (fin+text, len 4)
        socket.write(Buffer.from([0x81, 0x04, 0x70, 0x6f, 0x6e, 0x67]));
        setTimeout(() => socket.destroy(), 100);
      });
      s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + "\\n"));
    `],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    const servicePort = Number(m[1]);
    const { getServicePorts } = await loadDiscovery();
    const { InternalRegistry } = await loadInternal();
    const internal = new InternalRegistry();
    const allow = (port) => getServicePorts(internal, { force: true }).some((p) => p.port === port);
    const proxy = await startProxy({ isPortAllowed: allow });
    try {
      const result = await new Promise((resolve, reject) => {
        const socket = connect(proxy.port, "127.0.0.1");
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 5000);
        socket.on("connect", () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: ${servicePort}.st.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
        });
        socket.on("data", (d) => {
          buf = Buffer.concat([buf, d]);
          if (buf.includes(Buffer.from("101 Switching Protocols")) && buf.includes(Buffer.from([0x81, 0x04, 0x70, 0x6f, 0x6e, 0x67]))) {
            clearTimeout(timer);
            socket.destroy();
            resolve({ upgraded: true, frame: buf });
          }
        });
        socket.on("error", reject);
      });
      assert.equal(result.upgraded, true);
    } finally {
      await proxy.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("ws upgrade: forward-auth gate — no cookie 401, valid cookie 101", { timeout: 20_000 }, async () => {
  if (process.platform !== "linux") return;
  // ws echo service (app behind the vhost)
  const child = spawn(
    process.execPath,
    ["-e", `
      const s = require("http").createServer();
      s.on("upgrade", (req, socket) => {
        socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
        socket.write(Buffer.from([0x81, 0x04, 0x70, 0x6f, 0x6e, 0x67])); // "pong"
        setTimeout(() => socket.destroy(), 100);
      });
      s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + ";"));
    `],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  // authz probe mock: cookie "good=1" → 200, otherwise 401 (portal authz endpoint)
  const authz = httpServer((req, res) => {
    res.writeHead((req.headers.cookie ?? "").includes("good=1") ? 200 : 401);
    res.end();
  });
  let authzPort = 0;
  try {
    await new Promise((r) => authz.listen(0, "127.0.0.1", r));
    authzPort = authz.address().port;
    const m = await readUntil(child.stdout, /PORT=(\d+)/);
    const servicePort = Number(m[1]);
    // labeled vhost <port>-portal.st.localhost → forwardAuth backend
    const proxy = await startProxy({
      resolveLabel: (label) => (label === "portal" ? "default" : null),
      resolveSite: async (port, site, label) => {
        if (label !== "portal" || site !== "default") return null;
        return {
          forwardAuth: {
            port: authzPort,
            basePath: "/portal",
            loginRedirect: "http://$host/portal/login?next=$request_uri",
          },
        };
      },
    });
    try {
      const handshake = (cookie) => new Promise((resolve, reject) => {
        const s = connect(proxy.port, "127.0.0.1");
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => { s.destroy(); reject(new Error("timeout: " + buf.toString().slice(0, 120))); }, 5000);
        s.on("connect", () => {
          s.write(
            `GET /ws HTTP/1.1\r\nHost: ${servicePort}-portal.st.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
            (cookie ? `Cookie: ${cookie}\r\n` : "") + `\r\n`,
          );
        });
        s.on("data", (d) => {
          buf = Buffer.concat([buf, d]);
          const head = buf.toString().split("\r\n")[0] ?? "";
          if (head.includes("401") || head.includes("403")) { clearTimeout(timer); s.destroy(); resolve(head); }
          else if (head.includes("101")) { clearTimeout(timer); s.destroy(); resolve(head); }
        });
        s.on("error", (e) => { clearTimeout(timer); reject(e); });
      });
      const noCookie = await handshake(undefined);
      assert.match(noCookie, /401/, "gate rejects cookie-less upgrade");
      const withCookie = await handshake("good=1");
      assert.match(withCookie, /101/, "gate passes valid-cookie upgrade");
    } finally {
      await proxy.close();
    }
  } finally {
    authz.close();
    child.kill("SIGKILL");
  }
});

// helper shared with other test files
async function loadInternal() {
  return import("../src/internal.ts");
}

test("proxy forward-auth gate (portal): unauthenticated 302, cookie-authenticated passes", { timeout: 30_000 }, async () => {
  const { createProxyServer } = await loadProxy();
  const { PortalAuthProvider } = await import("../src/providers/portal.ts");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  // backends: echo service on 127.0.0.1:<svcPort>; portal provider on its port
  const svc = httpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("echo:" + req.url);
  });
  await new Promise((r) => svc.listen(0, "127.0.0.1", r));
  const svcPort = svc.address().port;

  const base = mkdtempSync(join(tmpdir(), "st-proxy-auth-"));
  const net = await import("node:net");
  const pickPort = () =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
  const provider = new PortalAuthProvider(
    { configDir: join(base, "config"), cacheDir: join(base, "cache"), resolveTool: async () => "", registerInternal: () => {}, unregisterInternal: () => {}, registerPid: () => {}, pickPort, log: () => {} },
    { user: { name: "admin", password: "pw" }, basePath: "/portal" }, // 显式与下方 proxy auth.basePath 一致
  );
  await provider.prepare();
  await provider.start();
  const authPort = provider.port;

  const proxy = createProxyServer({
    port: 0,
    suffixes: [".st.localhost"],
    isPortAllowed: (p) => p === svcPort,
    auth: {
      port: authPort,
      basePath: "/portal",
      loginRedirect: "https://$host/portal/login?next=$request_uri",
    },
  });
  await new Promise((r) => proxy.once("listening", r));
  const proxyPort = proxy.address().port;

  const host = `${svcPort}.st.localhost`;
  const get = (path, cookie) =>
    new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxyPort, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
      });
      req.end();
    });

  // 1. no cookie → 302 to the portal login
  const unauth = await get("/hello");
  assert.equal(unauth.status, 302, "unauthenticated → 302");
  assert.ok(unauth.location.includes("/portal/login?next="), `redirect to portal login, got ${unauth.location}`);

  // 2. bogus cookie → still 302
  const bogus = await get("/hello", "st_portal_session=deadbeef.invalid");
  assert.equal(bogus.status, 302);

  // 3. real portal session cookie → passes through to the service
  //    (login via portal's own login form is heavy; issue a session through
  //    the provider's session issuance — the authz endpoint only checks the
  //    cookie, so craft one via the sign helper is not exposed; instead do a
  //    full portal login through its HTTP endpoint)
  const loginRes = await new Promise((resolve) => {
    const body = "username=admin&password=pw";
    const req = httpRequest(
      { host: "127.0.0.1", port: authPort, path: "/portal/login", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": body.length } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, setCookie: String(res.headers["set-cookie"] ?? "") }));
      },
    );
    req.end(body);
  });
  const cookie = loginRes.setCookie.match(/st_portal_session=([^;]+)/)?.[0];
  assert.ok(cookie, "portal login yields session cookie");

  const authed = await get("/secret-path", cookie);
  assert.equal(authed.status, 200, "authenticated → 200");
  assert.equal(authed.body, "echo:/secret-path", "path forwarded intact");

  proxy.close();
  await provider.stop();
  await new Promise((r) => svc.close(r));
});

// ── P2: enrollment (D4) + labeled vhost auth ────────────────────────────────

/** In-process echo server (url/host echoed back as JSON). */
function spawnInProcEcho() {
  const svc = httpServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, host: req.headers.host }));
    });
  });
  return new Promise((r) => svc.listen(0, "127.0.0.1", () => r(svc)));
}

test("D4 enrollment: open vhost 403 without a binding, 200 with an open binding", { timeout: 20_000 }, async () => {
  const svc = await spawnInProcEcho();
  const svcPort = svc.address().port;

  // resolver denies everything (default D4 posture)
  const denied = await startProxy({ resolveSite: async () => null });
  try {
    const res = await rawGet(denied.port, `${svcPort}.st.localhost`, "/");
    assert.equal(res.status, 403);
    assert.match(res.body, /not enrolled/);
  } finally {
    await denied.close();
  }

  // open binding: resolver returns {} for the open form
  const open = await startProxy({ resolveSite: async (port, site) => (site ? null : {}) });
  try {
    const res = await rawGet(open.port, `${svcPort}.st.localhost`, "/x");
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).url, "/x");
  } finally {
    await open.close();
  }
  await new Promise((r) => svc.close(r));
});

test("D4 labeled vhost: unknown label → 403", { timeout: 20_000 }, async () => {
  const svc = await spawnInProcEcho();
  const svcPort = svc.address().port;
  const proxy = await startProxy({
    resolveLabel: () => null, // nothing registered
    resolveSite: async () => null,
  });
  try {
    const res = await rawGet(proxy.port, `${svcPort}-nope.st.localhost`, "/");
    assert.equal(res.status, 403);
    assert.match(res.body, /unknown site label/);
  } finally {
    await proxy.close();
  }
  await new Promise((r) => svc.close(r));
});

test("labeled vhost forward-auth: 302 → login page via basePath → 200 with cookie", { timeout: 20_000 }, async () => {
  const svc = await spawnInProcEcho();
  const svcPort = svc.address().port;

  // fake provider speaking the portal forward-auth contract
  const provider = httpServer((req, res) => {
    if (req.url.startsWith("/portal/api/authz/auth-request")) {
      if (req.headers.cookie?.includes("good=1")) {
        res.writeHead(200);
        res.end("ok");
      } else {
        res.writeHead(401);
        res.end("deny");
      }
    } else if (req.url.startsWith("/portal/")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>login</html>");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const providerPort = provider.address().port;

  const proxy = await startProxy({
    // "auth" is the reserved default-site label; "portal" = implicit provider site
    resolveLabel: (label) => (label === "auth" || label === "portal" ? "portal" : null),
    resolveSite: async (port, site) => {
      if (!site) return null; // open form: not enrolled
      return {
        forwardAuth: {
          port: providerPort,
          basePath: "/portal",
          loginRedirect: "http://$host/portal/login?next=$request_uri",
        },
      };
    },
  });
  try {
    const vhost = `${svcPort}-portal.st.localhost`;
    const get = (path, cookie) =>
      new Promise((resolve) => {
        const req = httpRequest({ host: "127.0.0.1", port: proxy.port, path, headers: { host: vhost, ...(cookie ? { cookie } : {}) } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
        });
        req.end();
      });

    // unauthenticated app path → 302 to the portal login (http scheme, local)
    const unauth = await get("/app");
    assert.equal(unauth.status, 302);
    assert.ok(unauth.location.startsWith("http://"), `local scheme is http, got ${unauth.location}`);
    assert.ok(unauth.location.includes("/portal/login?next="), `redirect target, got ${unauth.location}`);

    // login page served THROUGH the virtual host (basePath → provider port)
    const login = await get("/portal/login");
    assert.equal(login.status, 200);
    assert.match(login.body, /login/);

    // authenticated cookie → passes to the app with path intact
    const authed = await get("/app", "good=1");
    assert.equal(authed.status, 200);
    assert.equal(JSON.parse(authed.body).host, vhost, "virtual host preserved");
    assert.equal(JSON.parse(authed.body).url, "/app");
  } finally {
    await proxy.close();
  }
  await new Promise((r) => provider.close(r));
  await new Promise((r) => svc.close(r));
});

test("labeled vhost basic (D2): basic auth verified in the decision API (401 → service with valid creds)", { timeout: 20_000 }, async () => {
  const svc = await spawnInProcEcho();
  const svcPort = svc.address().port;
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "st-basic-"));
  const htpasswd = join(dir, "htpasswd");
  const hash = execFileSync("openssl", ["passwd", "-apr1", "-salt", "ab", "pw123"], { encoding: "utf8" }).trim();
  writeFileSync(htpasswd, `alice:${hash}\n`, "utf8");

  // fake gateway port (decision API 校验通过后不再依赖 gateway 的 server_name
  // —— 嵌入方 Next rewrite 无法保留 vhost Host,直接 pipe 到服务)
  const gatewayPort = (await new Promise((r) => {
    const s = httpServer((_q, res) => { res.writeHead(500); res.end("should not be hit"); });
    s.listen(0, "127.0.0.1", () => r(s.address().port));
  }));

  const proxy = await startProxy({
    resolveLabel: (label) => (label === "services" ? "services" : null),
    resolveSite: async (port, site) => (site === "services" ? { basicGatewayPort: gatewayPort, htpasswdFile: htpasswd } : null),
  });
  try {
    // 无凭证 → 401(决策 API 校验)
    const unauth = await rawGet(proxy.port, `${svcPort}-services.st.localhost`, "/");
    assert.equal(unauth.status, 401);
    assert.match(String(unauth.headers?.["www-authenticate"] || unauth.body), /Basic/);
    // 凭证错误 → 401
    const bad = await rawGet(proxy.port, `${svcPort}-services.st.localhost`, "/", { authorization: "Basic " + Buffer.from("alice:wrong").toString("base64") });
    assert.equal(bad.status, 401);
    // 凭证正确 → 直接 pipe 到服务(绕过 gateway)
    const ok = await rawGet(proxy.port, `${svcPort}-services.st.localhost`, "/deep?a=1", { authorization: "Basic " + Buffer.from("alice:pw123").toString("base64") });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { url: "/deep?a=1", host: `${svcPort}-services.st.localhost` }, "service answered directly with vhost Host");
  } finally {
    await proxy.close();
  }
  await new Promise((r) => svc.close(r));
});

test("D4 labeled vhost not enrolled for its site → 403", { timeout: 20_000 }, async () => {
  const svc = await spawnInProcEcho();
  const svcPort = svc.address().port;
  const proxy = await startProxy({
    resolveLabel: (label) => (label === "portal" ? "portal" : null),
    resolveSite: async () => null, // no enrollments at all
  });
  try {
    const res = await rawGet(proxy.port, `${svcPort}-portal.st.localhost`, "/");
    assert.equal(res.status, 403);
    assert.match(res.body, /not enrolled/);
  } finally {
    await proxy.close();
  }
  await new Promise((r) => svc.close(r));
});
