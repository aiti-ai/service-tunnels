import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createLinuxProcessProbe, createProcessProbe, createMacProcessProbe } from "../src/internal-process-probe.ts";
import { ensureMarker, getMarker } from "../src/marker.ts";

const isLinux = process.platform === "linux";

test("probe: 非 Linux 降级（无 /proc/net/tcp）→ 恒 false", { skip: isLinux }, () => {
  // 在非 Linux 上 existsSync("/proc/net/tcp") 为 false → 探针恒 false
  const probe = createLinuxProcessProbe();
  assert.equal(probe("127.0.0.1:54321"), false);
  assert.equal(probe(undefined), false);
});

test("probe: 非回环 remoteAddress → false（不旁路公网/LAN）", { skip: !isLinux }, () => {
  ensureMarker();
  const probe = createLinuxProcessProbe();
  assert.equal(probe("192.168.1.5:54321"), false);
  assert.equal(probe("10.0.0.1:54321"), false);
  assert.equal(probe(undefined), false);
  assert.equal(probe("not-an-address"), false);
});

test("probe: 无 marker → 恒 false", { skip: !isLinux }, () => {
  // marker="" 的探针：不匹配任何进程
  const probe = createLinuxProcessProbe({ marker: "" });
  assert.equal(probe("127.0.0.1:54321"), false);
});

test("probe: Linux 真实回环连接，子进程继承 marker → 命中放行", { skip: !isLinux }, async () => {
  ensureMarker();
  const marker = getMarker();
  assert.ok(marker, "marker should be set by ensureMarker()");

  const server = createServer((req, res) => {
    const remote = req.socket.remoteAddress
      ? `${req.socket.remoteAddress}:${req.socket.remotePort}`
      : undefined;
    const probe = createLinuxProcessProbe({ marker, cacheTtlMs: 0 });
    const verdict = probe(remote);
    res.end(JSON.stringify({ remote, verdict }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // 子进程继承 process.env（含 SERVICE_TUNNELS_MARKER）→ 其 environ 带 marker
  const child = spawn(process.execPath, ["-e", `
    const http = require("http");
    http.get("http://127.0.0.1:${port}/", (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => process.stdout.write(d));
    });
  `], { env: { ...process.env } });
  const out = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c) => (buf += c));
    child.on("error", reject);
    child.on("close", () => resolve(buf));
    setTimeout(() => { child.kill("SIGKILL"); resolve(buf); }, 5_000).unref();
  });
  server.close();
  const result = JSON.parse(out);
  assert.equal(result.verdict, true, `child (inherits marker env) should be bypassed; remote=${result.remote}`);
});

test("probe: 子进程未继承 marker env → 不命中", { skip: !isLinux }, async () => {
  ensureMarker();
  const marker = getMarker();
  const server = createServer((req, res) => {
    const remote = req.socket.remoteAddress
      ? `${req.socket.remoteAddress}:${req.socket.remotePort}`
      : undefined;
    const probe = createLinuxProcessProbe({ marker, cacheTtlMs: 0 });
    res.end(JSON.stringify({ verdict: probe(remote) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // 子进程 env 故意裁掉 SERVICE_TUNNELS_MARKER → environ 无 marker → 不应命中
  const cleanEnv = { ...process.env };
  delete cleanEnv.SERVICE_TUNNELS_MARKER;
  delete cleanEnv.SERVICE_TUNNELS_ROLE;
  const child = spawn(process.execPath, ["-e", `
    const http = require("http");
    http.get("http://127.0.0.1:${port}/", (res) => {
      let d = ""; res.on("data", (c) => d += c); res.on("end", () => process.stdout.write(d));
    });
  `], { env: cleanEnv });
  const out = await new Promise((resolve) => {
    let buf = "";
    child.stdout.on("data", (c) => (buf += c));
    child.on("close", () => resolve(buf));
    setTimeout(() => { child.kill("SIGKILL"); resolve(buf); }, 5_000).unref();
  });
  server.close();
  const result = JSON.parse(out);
  assert.equal(result.verdict, false, "child without marker env must not be bypassed");
});

test("probe: 放宽回环段——127.0.0.2 等同 127.0.0.1（Linux 认整个 127.0.0.0/8）", { skip: !isLinux }, async () => {
  ensureMarker();
  const marker = getMarker();
  const server = createServer((req, res) => {
    const remote = req.socket.remoteAddress
      ? `${req.socket.remoteAddress}:${req.socket.remotePort}`
      : undefined;
    const probe = createProcessProbe({ marker, cacheTtlMs: 0 });
    res.end(JSON.stringify({ remote, verdict: probe(remote) }));
  });
  // 监听 127.0.0.2（Linux 回环段任意地址都可达本机）
  await new Promise((resolve) => server.listen(0, "127.0.0.2", resolve));
  const port = server.address().port;

  const child = spawn(process.execPath, ["-e", `
    const http = require("http");
    http.get("http://127.0.0.2:${port}/", (res) => {
      let d = ""; res.on("data", (c) => d += c); res.on("end", () => process.stdout.write(d));
    });
  `], { env: { ...process.env } });
  const out = await new Promise((resolve) => {
    let buf = "";
    child.stdout.on("data", (c) => (buf += c));
    child.on("close", () => resolve(buf));
    setTimeout(() => { child.kill("SIGKILL"); resolve(buf); }, 5_000).unref();
  });
  server.close();
  const result = JSON.parse(out);
  assert.equal(result.verdict, true, `child via 127.0.0.2 should still be bypassed; remote=${result.remote}`);
});

test("probe: createProcessProbe 平台分发——Linux 上等价 createLinuxProcessProbe", () => {
  const a = createProcessProbe({ marker: "x", cacheTtlMs: 0 });
  // 非 Linux 两皆 false；Linux 上 createProcessProbe 走 /proc 实现
  // （无 marker 不启用 → false，与 createLinuxProcessProbe 一致）
  const b = createLinuxProcessProbe({ marker: "x", cacheTtlMs: 0 });
  assert.equal(a("127.0.0.1:54321"), b("127.0.0.1:54321"));
});

test("probe: createMacProcessProbe 在非 macOS 恒 false", { skip: process.platform === "darwin" }, () => {
  const probe = createMacProcessProbe({ marker: "any" });
  assert.equal(probe("127.0.0.1:54321"), false);
});

test("probe: Windows 不支持——createProcessProbe 在 win32 恒 false", { skip: process.platform !== "win32" }, () => {
  const probe = createProcessProbe({ marker: "any" });
  assert.equal(probe("127.0.0.1:54321"), false);
});
