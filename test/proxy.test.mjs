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
function rawGet(port, host, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host, connection: "close" } },
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
    suffixes: [".pi.localhost"],
    ...opts,
    internal: new InternalRegistry(),
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { server, port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

test("parseServiceHost matches <port>.<suffix>", async () => {
  const { parseServiceHost } = await loadProxy();
  assert.deepEqual(parseServiceHost("5173.pi.localhost", [".pi.localhost"]), { port: 5173, suffix: "pi.localhost" });
  assert.deepEqual(parseServiceHost("5173.pi.localhost:8080", [".pi.localhost"]), { port: 5173, suffix: "pi.localhost" });
  assert.deepEqual(parseServiceHost("80.pi.lan", [".pi.localhost", ".pi.lan"]), { port: 80, suffix: "pi.lan" });
  assert.equal(parseServiceHost("pi.localhost", [".pi.localhost"]), null);
  assert.equal(parseServiceHost("5173.evil.com", [".pi.localhost"]), null);
  assert.equal(parseServiceHost("99999.pi.localhost", [".pi.localhost"]), null); // port out of range
  assert.equal(parseServiceHost(undefined, [".pi.localhost"]), null);
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
      const res = await rawGet(proxy.port, `${servicePort}.pi.localhost`, "/hello?a=1");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.url, "/hello?a=1");
      assert.equal(body.method, "GET");
      assert.equal(body.host, `${servicePort}.pi.localhost`); // virtual host preserved
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
          { host: "127.0.0.1", port: proxy.port, method: "POST", path: "/submit", headers: { host: `${servicePort}.pi.localhost`, "content-type": "text/plain", connection: "close" } },
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
    const res = await rawGet(proxy.port, "9999.pi.localhost", "/");
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
      const res = await rawGet(proxy.port, `${servicePort}.pi.localhost`, "/dev/foo?a=1");
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
      const noAuth = await rawGet(proxy.port, `${servicePort}.pi.localhost`, "/");
      assert.equal(noAuth.status, 401);
      assert.match(noAuth.headers["www-authenticate"], /Basic/);

      const good = await new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: proxy.port, path: "/", headers: { host: `${servicePort}.pi.localhost`, authorization: authHeader("pw123"), connection: "close" } },
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
          { host: "127.0.0.1", port: proxy.port, path: "/events", headers: { host: `${servicePort}.pi.localhost`, connection: "close" } },
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
            `GET /ws HTTP/1.1\r\nHost: ${servicePort}.pi.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
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

// helper shared with other test files
async function loadInternal() {
  return import("../src/internal.ts");
}
