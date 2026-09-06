import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter as pathDelimiter } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";

async function loadIpv6() {
  return import("../src/ipv6.ts");
}

// ── Unit: classify / enumerate / detect ─────────────────────────────────────

test("classifyIpv6: global / ula / link-local / loopback / multicast / doc", async () => {
  const { classifyIpv6 } = await loadIpv6();
  assert.equal(classifyIpv6("2606:4700::1111"), "global");
  assert.equal(classifyIpv6("2400:3200::1"), "global");
  assert.equal(classifyIpv6("fd00::1234"), "ula");
  assert.equal(classifyIpv6("fc00::1"), "ula");
  assert.equal(classifyIpv6("fe80::1%eth0"), "link-local"); // zone 保留
  assert.equal(classifyIpv6("fe80::1"), "link-local");
  assert.equal(classifyIpv6("::1"), "loopback");
  assert.equal(classifyIpv6("ff02::1"), "multicast");
  assert.equal(classifyIpv6("2001:db8::1"), "documentation"); // RFC 3849 覆盖整个 2001:db8::/32
  assert.equal(classifyIpv6("2001:db8:1::2"), "documentation"); // 也在文档段内
  assert.equal(classifyIpv6("::"), "other");
  assert.equal(classifyIpv6(""), "other");
});

test("isGlobalIpv6", async () => {
  const { isGlobalIpv6 } = await loadIpv6();
  assert.equal(isGlobalIpv6("2606:4700::1111"), true);
  assert.equal(isGlobalIpv6("2400:3200::1"), true);
  assert.equal(isGlobalIpv6("fd00::1"), false);
  assert.equal(isGlobalIpv6("fe80::1"), false);
  assert.equal(isGlobalIpv6("::1"), false);
  assert.equal(isGlobalIpv6("2001:db8::1"), false, "documentation range is not routable");
});

test("globalIpv6Addresses returns only global, non-loopback, non-internal", async () => {
  const { globalIpv6Addresses, listIpv6Addresses } = await loadIpv6();
  // 本机没有 global 时（CI）为 []，但 list 至少能看到链路本地——证明枚举工作
  const all = listIpv6Addresses();
  const globals = globalIpv6Addresses();
  assert.ok(Array.isArray(globals), "returns array");
  for (const g of globals) {
    assert.match(g, /:/, "looks like an IPv6 address");
    assert.notEqual(g, "::1");
    // link-local/ULA 绝不能被当 global 枚举出来
    assert.ok(!g.startsWith("fe8"), "no link-local in globals");
    assert.ok(!g.startsWith("fd") && !g.startsWith("fc"), "no ULA in globals");
  }
  // list 里不含 loopback（我们主动过滤了 ::1）
  assert.ok(!all.some((a) => a.address === "::1"), "loopback excluded from list");
});

test("detectPublicIpv6: explicit wins; empty → external fallback; none → []", async () => {
  const { detectPublicIpv6 } = await loadIpv6();
  // 显式地址 → 返回它
  assert.deepEqual(await detectPublicIpv6("2001:db8:1::2", { resolveExternal: async () => "2606:4700::1" }), ["2001:db8:1::2"]);
  // 显式空 → 若本机无 global，external 回退生效
  const fallback = await detectPublicIpv6(undefined, { resolveExternal: async () => "2606:4700::1" });
  assert.ok(fallback.includes("2606:4700::1"), "external fallback used when no local global");
  // 两者都无 → []
  const none = await detectPublicIpv6(undefined, { resolveExternal: async () => null });
  assert.ok(Array.isArray(none), "returns array even when empty");
});

test("ipv6Diagnose shape", async () => {
  const { ipv6Diagnose } = await loadIpv6();
  const d = ipv6Diagnose();
  assert.ok(Array.isArray(d.addresses));
  assert.ok(Array.isArray(d.global));
  assert.equal(typeof d.hasIpv6Stack, "boolean");
  assert.equal(typeof d.hasGlobal, "boolean");
});

// ── Firewall: v6 → ip6tables selection (fake PATH) ─────────────────────────

function fakeFirewallBins(base) {
  const dir = join(base, "bin");
  mkdirSync(dir, { recursive: true });
  const mk = (name, exit0) => {
    const p = join(dir, name);
    // 记录最后调用参数；默认按 exit0 返回
    writeFileSync(p, `#!/bin/sh\necho "$@" > '${dir}/${name}.args'\n${exit0 ? "exit 0" : "exit 1"}\n`, "utf8");
    chmodSync(p, 0o755);
  };
  mk("iptables", true);
  mk("ip6tables", true);
  // 让 sudoRun(["true"]) 探测失败 → openFirewall/removeFirewall 走非 sudo 分支，
  // 直接用 fake bin（否则 sudo 重置 PATH 会跑真机的 iptables，测试不可确定）。
  mk("sudo", false);
  return dir;
}

test("firewall ip6tables: v6 address → ip6tables binary, v4 → iptables", { timeout: 20_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "st-fw6-"));
  const oldPath = process.env.PATH;
  const fs = await import("node:fs");
  let dir = "";
  const waitArgs = async (file, needle, timeoutMs = 5_000) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      try {
        if (fs.readFileSync(join(dir, file), "utf8").includes(needle)) return true;
      } catch { /* not yet written */ }
      await new Promise((r) => setTimeout(r, 30));
    }
    try { return fs.readFileSync(join(dir, file), "utf8").includes(needle); } catch { return false; }
  };
  try {
    dir = fakeFirewallBins(base);
    process.env.PATH = `${dir}${pathDelimiter}${oldPath}`;
    const { checkFirewall, openFirewall, removeFirewall } = await import("../src/portmap/firewall.ts");

    // v6 地址 → check 走 ip6tables
    const c6 = await checkFirewall("2001:db8:1::2", 4180, "iptables");
    assert.equal(c6.allowed, true, "ip6tables ACCEPT rule exists (fake)");
    // openFirewall → ip6tables args 写入 ip6tables.args（fire-and-forget，轮询）
    const o6 = await openFirewall("2001:db8:1::2", 4181, "iptables");
    assert.equal(o6.ensured, true);
    assert.ok(await waitArgs("ip6tables.args", "4181"), "ip6tables got the v6 port");
    assert.ok(!(await waitArgs("iptables.args", "4181", 300)), "iptables did NOT get the v6 open");

    // v4 地址 → 走 iptables（回归 guard）
    await openFirewall("192.168.1.50", 4182, "iptables");
    assert.ok(await waitArgs("iptables.args", "4182"), "iptables got the v4 port");

    // removeFirewall v6 → ip6tables -D
    await removeFirewall("2001:db8:1::2", 4181, "iptables");
    assert.ok(await waitArgs("ip6tables.args", "-D"), "removeFirewall v6 uses ip6tables -D");
  } finally {
    process.env.PATH = oldPath;
    rmSync(base, { recursive: true, force: true });
  }
});

// ── End-to-end: expose mode ipv6 via ::1 (no real global v6 needed) ────────

async function hasV6Loopback() {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(false));
    s.listen(0, "::1", () => { const p = s.address().port; s.close(() => resolve(true)); void p; });
  });
}

function httpGetV6(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "::1", port, path, headers: { host } }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: b }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("expose mode ipv6: dedicated transport on ::1, direct [::1]:port serves the app", { timeout: 30_000 }, async () => {
  if (!(await hasV6Loopback())) {
    test.skip("no ::1 loopback — cannot run ipv6 expose e2e");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "st-ipv6-expose-"));
  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({
    configDir: join(base, "config"),
    cacheDir: join(base, "cache"),
    guardian: false,
  });
  const app = createHttpServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end("hello ipv6 direct");
  });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const appPort = app.address().port;

  try {
    // 显式入口 ::1（本机回环模拟公网入口；无 real global v6 的 CI 环境）
    const r = await st.auth.expose(appPort, {
      mode: "ipv6",
      ipv6: { address: "::1" },
      auth: false,
      allowAuthNone: true,
      force: true,
    });
    assert.equal(r.mode, "ipv6");
    assert.ok(r.ipv6, "ipv6 detail present");
    assert.equal(r.ipv6.address, "::1");
    assert.ok(r.ipv6.transportPort > 0);
    assert.equal(r.url, `http://[::1]:${r.ipv6.transportPort}`);
    // 直连 [::1]:transportPort → 决策 pipe → app
    const res = await httpGetV6(r.ipv6.transportPort, "/hello", `[::1]:${r.ipv6.transportPort}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "hello ipv6 direct");
    // 暴露记录带 ipv6
    const ex = st.exposes().find((e) => e.mode === "ipv6");
    assert.ok(ex, "exposes() records ipv6 expose");
  } finally {
    try { await st.ipv6.stop(`noop`); } catch { /* best effort */ }
    try { await st.shutdown(); } catch { /* best effort */ }
    await new Promise((res) => app.close(res));
    rmSync(base, { recursive: true, force: true });
  }
});