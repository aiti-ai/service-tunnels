/**
 * ui-shared — 双端共享展示语义纯函数 + core.js 回落实现等价性（防双源漂移）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  modeOf, fmtAddr, fmtBytes, identityView, ddnsBadge, netcheckEventView, adviceView,
} from "../src/ui-shared.ts";
import { CATALOG } from "../src/i18n.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── modeOf ───────────────────────────────────────────────────────────────────
test("modeOf: 记录自带 mode 优先，老记录按 name 前缀推断", () => {
  assert.equal(modeOf({ mode: "portmap", name: "x" }), "portmap");
  assert.equal(modeOf({ name: "ipv6:3000:web" }), "ipv6");
  assert.equal(modeOf({ name: "proxy:5173:vite" }), "proxy");
  assert.equal(modeOf({ name: "expose-3000-portal", tunnelType: "serveo" }), "serveo");
  assert.equal(modeOf({ name: "expose-3000-portal" }), "");
  assert.equal(modeOf(null), "");
  assert.equal(modeOf({}), "");
});

// ── fmtAddr / fmtBytes ───────────────────────────────────────────────────────
test("fmtAddr: IPv6 加方括号，IPv4/域名原样", () => {
  assert.equal(fmtAddr("::1"), "[::1]");
  assert.equal(fmtAddr("fe80::1"), "[fe80::1]");
  assert.equal(fmtAddr("127.0.0.1"), "127.0.0.1");
  assert.equal(fmtAddr("example.com"), "example.com");
});

test("fmtBytes: B/KB/MB/GB 一位小数；非法输入 —", () => {
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2.0 KB");
  assert.equal(fmtBytes(5 * 1048576), "5.0 MB");
  assert.equal(fmtBytes(1.5 * 1073741824), "1.5 GB");
  assert.equal(fmtBytes(-1), "—");
  assert.equal(fmtBytes(NaN), "—");
});

// ── identityView ─────────────────────────────────────────────────────────────
test("identityView: label>title 主行；label≠title 时 detected 带回探测名", () => {
  const v = identityView({ label: "我的博客", title: "Nginx HTTP Server", protocol: "http", status: 200, server: "nginx" });
  assert.equal(v.title, "我的博客");
  assert.equal(v.hasLabel, true);
  assert.equal(v.detected, "Nginx HTTP Server");
  assert.equal(v.tooltip, "Nginx HTTP Server · http 200 · nginx");
  // title 与 label 相同 → 无 detected
  const same = identityView({ label: "Nginx", title: "Nginx" });
  assert.equal(same.title, "Nginx");
  assert.equal(same.detected, undefined);
  // 无 label → 主行是探测 title，hasLabel 缺省
  const t = identityView({ title: "Vite", favicon: "/favicon.ico" });
  assert.equal(t.title, "Vite");
  assert.equal(t.hasLabel, undefined);
  assert.equal(t.icon, "/favicon.ico");
});

test("identityView: tcp/无协议 → 无 meta tooltip；undefined → 空视图", () => {
  assert.equal(identityView({ protocol: "tcp", title: "ssh" }).tooltip, undefined);
  assert.equal(identityView({ protocol: "tcp", title: "ssh", server: "OpenSSH" }).tooltip, undefined);
  assert.deepEqual(identityView(undefined), {});
  assert.deepEqual(identityView({}), {});
});

// ── ddnsBadge ────────────────────────────────────────────────────────────────
test("ddnsBadge: actions 映射 + profile 透传；无数据 null", () => {
  const b = ddnsBadge({ profile: "cf", actions: [{ type: "A", ok: true }, { type: "TXT", ok: false }] });
  assert.deepEqual(b, { profile: "cf", items: [{ type: "A", ok: true }, { type: "TXT", ok: false }] });
  assert.equal(ddnsBadge({ actions: [] }), null);
  assert.equal(ddnsBadge(undefined), null);
  assert.equal(ddnsBadge({ profile: "x" }), null);
});

// ── netcheckEventView（契约冻结：键名 ui.doctor.ev.<type> + tone 枚举）────────
test("netcheckEventView: 全事件型 → 键名/语气/插值", () => {
  const cases = [
    [{ type: "phase-start", phase: "A", label: "本机画像", total: 11 }, "ui.doctor.ev.phase-start", "dim"],
    [{ type: "probe-done", probeId: "a2", item: "出口IPv4", verdict: "ok", ok: true, ms: 120 }, "ui.doctor.ev.probe-done", "ok"],
    [{ type: "probe-done", probeId: "a7", item: "受限评级", verdict: "restricted", ok: false, ms: 300 }, "ui.doctor.ev.probe-done", "bad"],
    [{ type: "tunnel-est", provider: "serveo", url: "https://x", ms: 3200 }, "ui.doctor.ev.tunnel-est", "ok"],
    [{ type: "tunnel-fail", provider: "bore", error: "timeout", ms: 30000 }, "ui.doctor.ev.tunnel-fail", "bad"],
    [{ type: "channel-result", provider: "serveo", channel: "check-host", level: "E1", ok: true, ms: 90 }, "ui.doctor.ev.channel-result", "ok"],
    [{ type: "verdict-confirmed", provider: "serveo", verdict: "E1+", confirmed: true, sourcesOk: 2 }, "ui.doctor.ev.verdict-confirmed", "ok"],
    [{ type: "verdict-confirmed", provider: "bore", verdict: "E1", confirmed: false, sourcesOk: 1 }, "ui.doctor.ev.verdict-confirmed", "warn"],
    [{ type: "advice-update", advice: [], basis: "live", note: "第2次更新" }, "ui.doctor.ev.advice-update", "warn"],
    [{ type: "phase-end", phase: "A", summary: "11 项" }, "ui.doctor.ev.phase-end", "dim"],
    [{ type: "summary", report: {}, text: "", markdown: "" }, "ui.doctor.ev.summary", "ok"],
    [{ type: "done", report: {} }, "ui.doctor.ev.done", "ok"],
    [{ type: "error", message: "boom" }, "ui.doctor.ev.error", "bad"],
    [{ type: "cancelled", report: {} }, "ui.doctor.ev.cancelled", "warn"],
    [{ type: "future-thing" }, "ui.doctor.ev.unknown", "dim"],
  ];
  for (const [ev, key, tone] of cases) {
    const v = netcheckEventView(ev);
    assert.equal(v.textKey, key, `key for ${ev.type}`);
    assert.equal(v.tone, tone, `tone for ${ev.type}`);
    assert.ok(v.icon, `icon for ${ev.type}`);
    if (ev.item) assert.equal(v.params.item, ev.item);
  }
});

// ── adviceView ───────────────────────────────────────────────────────────────
test("adviceView: confirmed/unconfirmed/untested 角标与语气", () => {
  assert.deepEqual(adviceView({ id: "ipv6", score: 90, confidence: "E1+", confirmed: true }), { rank: 90, badgeKey: "ui.doctor.advice.confirmed", tone: "ok", key: "ipv6" });
  assert.deepEqual(adviceView({ id: "bore", score: 50, confidence: "E1", confirmed: false }).badgeKey, "ui.doctor.advice.unconfirmed");
  assert.equal(adviceView({ id: "x", score: 55, confidence: "none" }).badgeKey, "ui.doctor.advice.untested");
  assert.equal(adviceView({ id: "x", score: 55, confidence: "none" }).tone, "dim");
  assert.equal(adviceView({}).rank, 0);
});

// ── 共享层 ⇄ core.js 回落实现 等价性（防双源漂移）────────────────────────────
/** 从 core.js 提取 __stLocal 对象字面量并在隔离作用域求值（经典脚本，无模块系统）。 */
function extractCoreFallback() {
  const src = readFileSync(join(root, "src/ui/client/core.js"), "utf8");
  const start = src.indexOf("const __stLocal={");
  const endMarker = "\n};";
  const end = src.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, "core.js __stLocal block not found");
  const objSrc = src.slice("const __stLocal={".length + start - 1, end + 2); // "{...}"
  return new Function(`return ${objSrc};`)();
}

test("core.js 回落实现与 ui-shared.ts 等价（漂移即红）", () => {
  const local = extractCoreFallback();
  const exposeFixtures = [
    { mode: "portmap", name: "x" },
    { name: "ipv6:3000:web" },
    { name: "proxy:5173:vite" },
    { name: "expose-3000-portal", tunnelType: "serveo" },
    { name: "expose-3000-portal" },
    null,
    {},
  ];
  for (const f of exposeFixtures) assert.equal(local.modeOf(f), modeOf(f), `modeOf ${JSON.stringify(f)}`);
  for (const a of ["::1", "fe80::1", "127.0.0.1", "example.com"]) assert.equal(local.fmtAddr(a), fmtAddr(a));
  for (const n of [0, 512, 2048, 5 * 1048576, 1.5 * 1073741824, -1, NaN]) assert.equal(local.fmtBytes(n), fmtBytes(n));

  const idFixtures = [
    undefined,
    {},
    { label: "我的博客", title: "Nginx HTTP Server", protocol: "http", status: 200, server: "nginx" },
    { label: "Nginx", title: "Nginx" },
    { title: "Vite", favicon: "/favicon.ico" },
    { protocol: "tcp", title: "ssh", server: "OpenSSH" },
  ];
  for (const f of idFixtures) assert.deepEqual(local.identityView(f), identityView(f));

  const ddnsFixtures = [undefined, { profile: "x" }, { actions: [] }, { profile: "cf", actions: [{ type: "A", ok: true }, { type: "TXT", ok: false }] }];
  for (const f of ddnsFixtures) assert.deepEqual(local.ddnsBadge(f), ddnsBadge(f));

  const events = [
    { type: "phase-start", phase: "A", label: "L", total: 3 },
    { type: "probe-done", probeId: "a2", item: "i", verdict: "ok", ok: true, ms: 1 },
    { type: "probe-done", probeId: "a7", item: "i", verdict: "bad", ok: false, ms: 2 },
    { type: "tunnel-est", provider: "p", url: "u", ms: 3 },
    { type: "tunnel-fail", provider: "p", error: "e", ms: 4 },
    { type: "channel-result", provider: "p", channel: "c", level: "E1", ok: true, ms: 5 },
    { type: "verdict-confirmed", provider: "p", verdict: "E1+", confirmed: true, sourcesOk: 2 },
    { type: "verdict-confirmed", provider: "p", verdict: "E1", confirmed: false, sourcesOk: 1 },
    { type: "advice-update", advice: [], basis: "live", note: "n" },
    { type: "phase-end", phase: "A", summary: "s" },
    { type: "summary", report: {}, text: "", markdown: "" },
    { type: "done", report: {} },
    { type: "error", message: "m" },
    { type: "cancelled", report: {} },
    { type: "future" },
  ];
  for (const ev of events) assert.deepEqual(local.netcheckEventView(ev), netcheckEventView(ev), `netcheckEventView ${ev.type}`);

  const adviceFixtures = [
    { id: "ipv6", score: 90, confidence: "E1+", confirmed: true },
    { id: "bore", score: 50, confidence: "E1", confirmed: false },
    { id: "x", score: 55, confidence: "none" },
    {},
  ];
  for (const f of adviceFixtures) assert.deepEqual(local.adviceView(f), adviceView(f));
});

// ── i18n 键存在性：netcheckEventView 引用的每个键在 en/zh 都有译文 ─────────────
test("netcheckEventView/adviceView 引用的 i18n 键在 CATALOG en/zh 齐备", () => {
  const events = [
    { type: "phase-start", label: "L" }, { type: "probe-done", item: "i", verdict: "v", ok: true, ms: 1 },
    { type: "tunnel-est", provider: "p", url: "u", ms: 1 }, { type: "tunnel-fail", provider: "p", error: "e", ms: 1 },
    { type: "channel-result", provider: "p", channel: "c", level: "E1", ok: true, ms: 1 },
    { type: "verdict-confirmed", provider: "p", verdict: "v", confirmed: true, sourcesOk: 2 },
    { type: "advice-update", advice: [], basis: "probe", note: "n" }, { type: "phase-end", phase: "A", summary: "s" },
    { type: "summary", report: {}, text: "", markdown: "" }, { type: "done", report: {} },
    { type: "error", message: "m" }, { type: "cancelled" }, { type: "unknown-x" },
  ];
  const keys = new Set(["ui.doctor.advice.confirmed", "ui.doctor.advice.unconfirmed", "ui.doctor.advice.untested"]);
  for (const ev of events) keys.add(netcheckEventView(ev).textKey);
  for (const lang of ["en", "zh"]) {
    for (const k of keys) {
      assert.ok(CATALOG[lang][k], `missing ${lang} key: ${k}`);
      assert.ok(!String(CATALOG[lang][k]).includes("ui.doctor."), `${lang} key ${k} fell back to raw key`);
    }
  }
});

// ── Node 侧不挂 window.__stShared（浏览器挂载段仅在 window 存在时生效）────────
test("Node 导入不设置 globalThis.__stShared", () => {
  assert.equal(globalThis.__stShared, undefined);
});
