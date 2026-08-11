import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { parseExposeEnv } from "../src/expose-self.ts";

/** TODO-5: self-expose 迁移（parseExposeEnv / allowlocal 门控 / exposeSelf）。 */

test("TODO-5: parseExposeEnv — k=v, dotted 嵌套, allowHost 重复, 非法 mode fail-closed", () => {
  // 基本
  const e1 = parseExposeEnv("mode=both,auth=portal,tunnel=cloudflared,policy=two_factor,allowlocal=false");
  assert.equal(e1.mode, "both");
  assert.equal(e1.auth, "portal");
  assert.equal(e1.tunnel, "cloudflared");
  assert.equal(e1.policy, "two_factor");
  assert.equal(e1.allowlocal, false);
  // dotted 嵌套
  const e2 = parseExposeEnv("tunnel.domain=alice.ngrok-free.app,user.name=admin,user.password=pw,provider.oidc.issuerUrl=https://x");
  assert.equal(e2.tunnelParams.domain, "alice.ngrok-free.app");
  assert.equal(e2.user.name, "admin");
  assert.equal(e2.providerParams.oidc.issuerUrl, "https://x");
  // allowHost 重复/空格
  const e3 = parseExposeEnv("allowHost=a.com,allowHost=b.com");
  assert.deepEqual(e3.allowHost, ["a.com", "b.com"]);
  // mode 缺省 none（只应用配置不暴露）
  const e4 = parseExposeEnv("allowlocal=false,allowHost=backup.example.com");
  assert.equal(e4.mode, "none");
  assert.equal(e4.allowlocal, false);
  // 非法 mode → null
  assert.equal(parseExposeEnv("mode=bogus"), null);
  // 空 → null
  assert.equal(parseExposeEnv(""), null);
  assert.equal(parseExposeEnv(undefined), null);
});

test("TODO-5: allowlocal 门控 — 临时 TTL / 永久确认 / allowHost 白名单 / isDirectAccessAllowed", { timeout: 15_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "st-selfgate-"));
  const st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
  try {
    // 缺省 allowlocal=true → 直连放行
    assert.equal(st.self.allowLocal(), true);
    assert.equal(st.self.isDirectAccessAllowed("192.168.1.5"), true);

    // 临时关闭 + TTL 自动恢复
    st.self.setAllowLocalTemporary(false, 300);
    assert.equal(st.self.allowLocal(), false);
    assert.equal(st.self.isDirectAccessAllowed("127.0.0.1"), false, "allowlocal=false → 回环也拦");
    assert.ok(st.self.getAllowLocalPending().pending, "pending 状态");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(st.self.allowLocal(), true, "TTL 后自动恢复");
    assert.ok(!st.self.getAllowLocalPending().pending);

    // 永久关闭 + allowHost 白名单
    st.self.confirmAllowLocal(false);
    assert.equal(st.self.allowLocal(), false);
    assert.equal(st.self.isDirectAccessAllowed("localhost"), false, "回环拦截");
    assert.equal(st.self.isDirectAccessAllowed("10.0.0.2"), false, "局域网拦截");
    st.self.setAllowHosts(["backup.example.com", "vpn.example.com:8443"]);
    assert.deepEqual(st.self.allowHosts(), ["backup.example.com", "vpn.example.com"]);
    assert.equal(st.self.isDirectAccessAllowed("backup.example.com"), true, "allowHost 放行");
    assert.equal(st.self.isDirectAccessAllowed("vpn.example.com:8443"), true, "allowHost 带端口放行");
    assert.equal(st.self.isDirectAccessAllowed("evil.example.com"), false, "非白名单拒绝");
  } finally {
    await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});

test("TODO-5: exposeSelf — self site 隔离 + label + maybeExposeSelf", { timeout: 40_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "st-selfexp-"));
  let st = null;
  let app = null;
  try {
    st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
    app = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("self"); });
    await new Promise((res) => app.listen(0, "127.0.0.1", res));
    const port = app.address().port;

    // proxy 模式 + auth=none（无 nginx）：self site 暴露
    const r = await st.self.exposeSelf({ port, mode: "proxy", auth: "none", serviceBasePath: "/dev" });
    assert.ok(r.localUrl, "self 暴露有本地虚拟主机 URL");
    const rec = st.exposes().find((e) => e.port === port);
    assert.ok(rec, "expose 记录存在");
    assert.equal(rec.site, "self", "self site 隔离");
    assert.equal(rec.label, "self", "self label");
    assert.match(rec.name, /^proxy:\d+:self$/, "proxy 模式记录键 proxy:port:self（label=self）");

    // maybeExposeSelf：mode=none → 只应用配置不暴露
    const cfg2 = mkdtempSync(join(tmpdir(), "st-selfnone-"));
    const st2 = createServiceTunnels({ configDir: join(cfg2, "cfg"), cacheDir: join(cfg2, "cache"), guardian: false });
    const none = await st2.self.maybeExposeSelf("allowlocal=false,allowHost=backup.example.com");
    assert.equal(none.exposed, false, "mode=none 不暴露");
    assert.equal(st2.self.allowLocal(), false, "但 allowlocal 配置已应用");
    assert.deepEqual(st2.self.allowHosts(), ["backup.example.com"]);
    await st2.shutdown();
    rmSync(cfg2, { recursive: true, force: true });
  } finally {
    if (app) await new Promise((res) => app.close(res));
    if (st) await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});
