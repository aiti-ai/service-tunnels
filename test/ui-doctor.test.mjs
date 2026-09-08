/**
 * ui-doctor — 骨架测试：mock 事件流帧、job 单例 409、Last-Event-ID 续传、
 * SSE 连接上限、能力门控（netcheck 未实现且未开 mock → 404）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDoctorHub, doctorAvailable, doctorMockEnabled } from "../src/ui-doctor.ts";
import { createApiHandler } from "../src/ui-api.ts";

function mockSt(extra = {}) {
  return {
    daemon: { status: () => ({ running: false }) },
    auth: { providers: () => [], providerOrder: () => [], defaultProvider: () => "portal", userManagers: () => [], totpProviders: () => [], biometricProviders: () => [], noneAllowed: () => false },
    schemas: { tunnels: () => ({}), metas: () => ({}), authProviders: async () => ({}), authMetas: () => ({}), tunnels: () => ({}) },
    tunnels: { tcpSupport: () => [] },
    sites: { list: () => [] },
    tools: { list: () => [], allowDownload: () => false },
    internal: { list: () => [] },
    exposes: () => [],
    proxy: { status: () => ({}) },
    dirs: { configDir: "/tmp/cfg", cacheDir: "/tmp/cache" },
    state: () => ({}),
    netcheck: undefined,
    ...extra,
  };
}

/** 假 ServerResponse：捕获 writeHead + 全部写入帧 + end body。 */
function sseRes() {
  return {
    statusCode: 0, frames: [], body: null, closed: false,
    writeHead(status) { this.statusCode = status; return this; },
    write(frame) { this.frames.push(frame); return true; },
    end(body) { this.closed = true; this.body = body; },
    on() { /* close listener 注册 no-op */ },
  };
}

const collect = (res) => res.frames.filter((f) => f.startsWith("id: ")).map((f) => {
  const id = Number(/^id: (\d+)$/m.exec(f)[1]);
  const data = JSON.parse(/^data: (.+)$/m.exec(f)[1]);
  return { id, ev: data };
});

test("mock 流：start → 完整事件序列（advice/summary/done 收口）→ 可再次 start", async () => {
  const hub = createDoctorHub(mockSt());
  assert.equal(hub.running(), false);
  const r = await hub.start({});
  assert.deepEqual(r, { started: true, mock: true });
  assert.equal(hub.running(), true);
  // 等待 mock 序列播完（16 事件 × 200ms + 余量）
  for (let i = 0; i < 60 && hub.running(); i++) await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(hub.running(), false);
  // 再次 start 不 409
  const r2 = await hub.start({});
  assert.equal(r2.started, true);
  hub.stop();
  await new Promise((r3) => setTimeout(r3, 50));
});

test("409 单例：运行中再次 start 抛 conflict", async () => {
  const hub = createDoctorHub(mockSt());
  await hub.start({});
  await assert.rejects(() => hub.start({}), /already running/);
  hub.stop();
  await new Promise((r) => setTimeout(r, 50));
});

test("SSE：订阅者收到帧（id 单调 + 合法 JSON）；Last-Event-ID 续传不重不漏", async () => {
  const hub = createDoctorHub(mockSt());
  const resA = sseRes();
  assert.equal(hub.subscribe(resA), true);
  await hub.start({});
  // 收到至少 4 帧后断开（模拟）
  for (let i = 0; i < 30 && resA.frames.filter((f) => f.startsWith("id: ")).length < 4; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  hub.stop();
  for (let i = 0; i < 30 && hub.running(); i++) await new Promise((r) => setTimeout(r, 100));
  const seenA = collect(resA);
  assert.ok(seenA.length >= 4, "got frames");
  assert.ok(seenA.every((x, i) => x.id === seenA[0].id + i), "ids monotonic");
  // 断线重连：lastEventId = seenA 第 3 帧 → 重放第 4 帧起
  const resB = sseRes();
  assert.equal(hub.subscribe(resB, String(seenA[2].id)), true);
  const seenB = collect(resB);
  assert.ok(seenB.length >= 2);
  assert.equal(seenB[0].id, seenA[2].id + 1, "replay starts right after last-event-id");
});

test("SSE 连接上限 8：第 9 个订阅返回 false（503 语义）", () => {
  const hub = createDoctorHub(mockSt());
  const ress = [];
  for (let i = 0; i < 8; i++) {
    const r = sseRes();
    assert.equal(hub.subscribe(r), true);
    ress.push(r);
  }
  assert.equal(hub.subscribe(sseRes()), false);
  assert.equal(hub.subscriberCount(), 8);
});

test("能力门控：netcheck 未实现 + mock 关 → start/events 404；ST_UI_DOCTOR_MOCK=1 → 可用", async () => {
  const st = mockSt();
  delete process.env.ST_UI_DOCTOR_MOCK;
  assert.equal(doctorAvailable(st), false);
  const ctx = { st, port: 0, csrfToken: "x" };
  const call = async (method, p, body) => {
    const res = sseRes();
    const u = new URL(p, "http://x");
    const req = { method, headers: {}, on(ev, cb) { if (ev === "end") cb(); }, };
    if (body) req.on("data", () => {});
    await createApiHandler(ctx, req, res, u.pathname, u, "en");
    return res;
  };
  let res = await call("POST", "/api/doctor-start");
  assert.equal(res.statusCode, 404, "start gated");
  res = await call("GET", "/api/doctor-events");
  assert.equal(res.statusCode, 404, "events gated");
  // 开 mock → 可用（hub 单例挂 ctx）
  process.env.ST_UI_DOCTOR_MOCK = "1";
  try {
    assert.equal(doctorMockEnabled(), true);
    assert.equal(doctorAvailable(st), true);
    res = await call("POST", "/api/doctor-start", "{}");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { started: true, mock: true });
  } finally {
    delete process.env.ST_UI_DOCTOR_MOCK;
  }
});

test("stop：运行中 stop → cancelled 事件收口", async () => {
  const hub = createDoctorHub(mockSt());
  const res = sseRes();
  hub.subscribe(res);
  await hub.start({});
  hub.stop();
  for (let i = 0; i < 40 && hub.running(); i++) await new Promise((r) => setTimeout(r, 50));
  const seen = collect(res).map((x) => x.ev.type);
  assert.ok(seen.includes("cancelled"), "cancelled event emitted, got: " + seen.join(","));
});
