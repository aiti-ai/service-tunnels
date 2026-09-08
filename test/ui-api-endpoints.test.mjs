/**
 * ui-api 新端点（P0b）：/api/status version+netcheck、/api/portmap-probe、
 * /api/ipv6-addresses。探测实现经 ctx._probePortmap/_listIpv6/_detectPublicIpv6
 * 注入（e2e 不做真实 SSDP/外呼）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "../src/ui-api.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 最小 mock st（只覆盖 status 端点触到的面）。 */
function mockSt() {
  return {
    daemon: { status: () => ({ running: false }) },
    auth: {
      providers: () => ["portal"], providerOrder: () => ["portal"], defaultProvider: () => "portal",
      userManagers: () => ["portal"], totpProviders: () => ["portal"], biometricProviders: () => [],
      noneAllowed: () => false,
    },
    schemas: {
      tunnels: () => ({}), metas: () => ({}), authProviders: async () => ({}), authMetas: () => ({}),
    },
    tunnels: { tcpSupport: () => [] },
    sites: { list: () => [{ name: "default" }] },
    tools: { list: () => [], allowDownload: () => false },
    internal: { list: () => [] },
    exposes: () => [],
    proxy: { status: () => ({}) },
    dirs: { configDir: "/tmp/cfg", cacheDir: "/tmp/cache" },
    state: () => ({}),
  };
}

/** 捕获 json() 输出的假 ServerResponse。 */
function mockRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(body) { this.body = body; },
  };
}

async function call(ctx, method, pathAndQuery) {
  const res = mockRes();
  // 服务端传入的 path = url.pathname（不含 query），照实模拟
  const u = new URL(pathAndQuery, "http://127.0.0.1");
  await createApiHandler(ctx, { method }, res, u.pathname, u, "en");
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

test("GET /api/status 附 version + netcheck 能力开关", async () => {
  const { status, data } = await call({ st: mockSt(), port: 0, csrfToken: "x" }, "GET", "/api/status");
  assert.equal(status, 200);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(data.version, pkg.version);
  // 库 netcheck 未实现（绿地）→ 恒 false；实现落库后 st.netcheck.run 存在自动点亮
  assert.equal(data.netcheck, false);
});

test("GET /api/status netcheck 随 st.netcheck.run 能力点亮", async () => {
  const st = mockSt();
  st.netcheck = { run: async () => ({}) };
  const { data } = await call({ st, port: 0, csrfToken: "x" }, "GET", "/api/status");
  assert.equal(data.netcheck, true);
});

test("GET /api/portmap-probe — 注入探测实现透传 report；gateway 参数透传", async () => {
  const seen = [];
  const ctx = {
    st: mockSt(), port: 0, csrfToken: "x",
    _probePortmap: async (opts) => {
      seen.push(opts);
      return { gateway: opts.gateway ?? "192.168.1.1", ipClass: "private", upnp: { ok: true }, recommended: "upnp" };
    },
  };
  const { status, data } = await call(ctx, "GET", "/api/portmap-probe?gateway=10.0.0.1&ssdpTimeoutMs=800");
  assert.equal(status, 200);
  assert.equal(data.upnp.ok, true);
  assert.equal(data.recommended, "upnp");
  assert.deepEqual(seen[0], { gateway: "10.0.0.1", ssdpTimeoutMs: 800 });
});

test("GET /api/portmap-probe — ssdpTimeoutMs 钳制 500–10000", async () => {
  const seen = [];
  const ctx = {
    st: mockSt(), port: 0, csrfToken: "x",
    _probePortmap: async (opts) => { seen.push(opts); return {}; },
  };
  await call(ctx, "GET", "/api/portmap-probe?ssdpTimeoutMs=1");
  assert.equal(seen[0].ssdpTimeoutMs, 500);
  await call(ctx, "GET", "/api/portmap-probe?ssdpTimeoutMs=999999");
  assert.equal(seen[1].ssdpTimeoutMs, 10000);
});

test("GET /api/portmap-probe — 探测抛错 → 500 + error", async () => {
  const ctx = {
    st: mockSt(), port: 0, csrfToken: "x",
    _probePortmap: async () => { throw new Error("ssdp boom"); },
  };
  const { status, data } = await call(ctx, "GET", "/api/portmap-probe");
  assert.equal(status, 500);
  assert.match(data.error, /ssdp boom/);
});

test("GET /api/ipv6-addresses — 候选列表 + 公网出口（探测失败兜底空数组）", async () => {
  const ctx = {
    st: mockSt(), port: 0, csrfToken: "x",
    _listIpv6: () => [
      { address: "fe80::1", scope: "link-local", iface: "eth0", internal: false },
      { address: "2001:db8::10", scope: "global", iface: "eth0", internal: false },
    ],
    _detectPublicIpv6: async () => ["2001:db8::10"],
  };
  const { status, data } = await call(ctx, "GET", "/api/ipv6-addresses");
  assert.equal(status, 200);
  assert.equal(data.addresses.length, 2);
  assert.equal(data.addresses[1].scope, "global");
  assert.deepEqual(data.public, ["2001:db8::10"]);
});

test("GET /api/ipv6-addresses — 外呼超时/拒绝 → public 空数组不拖死请求", async () => {
  const ctx = {
    st: mockSt(), port: 0, csrfToken: "x",
    _listIpv6: () => [],
    _detectPublicIpv6: () => new Promise((_ok, bad) => setTimeout(() => bad(new Error("slow net")), 50)),
  };
  const t0 = Date.now();
  const { status, data } = await call(ctx, "GET", "/api/ipv6-addresses");
  assert.equal(status, 200);
  assert.deepEqual(data.public, []);
  // 失败路径立即兜底（不等 4s 超时）
  assert.ok(Date.now() - t0 < 3000, "detect rejection should resolve immediately");
});

test("未知路径仍 404（新端点不破坏兜底）", async () => {
  const { status } = await call({ st: mockSt(), port: 0, csrfToken: "x" }, "GET", "/api/none");
  assert.equal(status, 404);
});
