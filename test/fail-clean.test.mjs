import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

/** TODO-1 (fail-clean): 暴露原子化 —— 失败即彻底清理 per-expose 组件；
 *  共享单例（nginx/redis）不清。 */

test("TODO-1: ssh provider 隧道失败 → 本次新建的 backing 域回滚", { timeout: 60_000 }, async () => {
  if (process.platform === "win32") return; // needs a real ngrok download (win32 zip source 404); covered on Linux
  const { createServiceTunnels } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "st-fc1-"));
  let st = null;
  let app = null;
  try {
    st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
    app = createServer((_q, r) => r.end("hi"));
    await new Promise((res) => app.listen(0, "127.0.0.1", res));
    const port = app.address().port;
    // ngrok tcp 需要付费账号 → 隧道必然失败；ssh 域本次自动供给，失败后应回滚
    const r = await st.auth.expose(port, { provider: "ssh", site: "siteFc", tunnelType: "ngrok" });
    assert.ok(r.url === null, "ngrok tcp 失败(预期)");
    assert.equal(st.ssh.get("siteFc"), undefined, "隧道失败 → 本次新建的 ssh 域被回滚");
  } finally {
    if (app) await new Promise((res) => app.close(res));
    if (st) await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});

test("TODO-1: ssh provider 暴露停止 → backing 域清理（非本次创建的域不回滚但停止时清理）", { timeout: 60_000 }, async () => {
  if (process.platform === "win32") return; // needs a real ngrok download; covered on Linux
  const { createServiceTunnels } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "st-fc2-"));
  let st = null;
  let app = null;
  try {
    st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
    app = createServer((_q, r) => r.end("hi"));
    await new Promise((res) => app.listen(0, "127.0.0.1", res));
    const port = app.address().port;
    // 域预先存在（模拟其他暴露已建）→ 隧道失败不应回滚它
    await st.ssh.ensure({ domain: "siteFc2", forwardPort: port, sshPort: 0 });
    const r = await st.auth.expose(port, { provider: "ssh", site: "siteFc2", tunnelType: "ngrok" });
    assert.ok(r.url === null, "ngrok tcp 失败(预期)");
    assert.ok(st.ssh.get("siteFc2"), "预先存在的域不被本次失败回滚");
    // 停止该暴露 → 无其他 ssh 暴露用同 site → 域清理
    const rec = st.exposes().find((e) => e.port === port);
    assert.ok(rec, "expose 记录存在");
    await st.tunnels.stop(rec.name);
    assert.equal(st.ssh.get("siteFc2"), undefined, "停止后 backing 域被清理");
  } finally {
    if (app) await new Promise((res) => app.close(res));
    if (st) await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});

test("TODO-1: daemon 共享 nginx 单例 — 连续 expose 不累积 nginx", { timeout: 90_000 }, async () => {
  if (process.platform === "win32") return; // needs a real nginx; covered on Linux
  const { startDaemon, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const base = mkdtempSync(join(tmpdir(), "st-fc3-"));
  const cacheDir = join(base, "cache");
  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid > 0);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await requestDaemon(cacheDir, "ping")) break;
    }
    assert.ok(await requestDaemon(cacheDir, "ping"), "daemon must respond");

    const apps = [];
    for (let i = 0; i < 2; i++) {
      const srv = createServer((_q, r) => r.end("x"));
      await new Promise((res) => srv.listen(0, "127.0.0.1", res));
      apps.push(srv);
      const port = srv.address().port;
      // http auth-none → 经共享 nginx 网关；隧道(cloudflared)成功与否不影响断言
      await requestDaemon(cacheDir, "expose", { port, auth: false, protocol: "http", tunnelType: "cloudflared", force: true }, 60_000);
    }
    // 共享单例 → 只有一个 nginx-* 根目录（此前 per-expose 会累积）
    const tmp = join(cacheDir, "tmp");
    const nginxDirs = existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith("nginx-")) : [];
    assert.ok(nginxDirs.length <= 1, `daemon 共享 nginx 单例（got ${nginxDirs.length} nginx-* dirs）`);

    // 停止全部 → 共享单例保留（不清），但隧道清空
    await requestDaemon(cacheDir, "expose.stopAll", undefined, 10_000);
    const still = existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith("nginx-")) : [];
    assert.ok(still.length <= 1, "nginx 单例在 stopAll 后保持（不清）");
    for (const srv of apps) await new Promise((res) => srv.close(res));
  } finally {
    await stopDaemon(cacheDir);
    rmSync(base, { recursive: true, force: true });
  }
});
