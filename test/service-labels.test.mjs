import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** daemon e2e：port.label.set → port.list 合并 → 重启后仍在 → 清除。 */
test("service labels: set → merge into port.list → persist across restart → clear", { timeout: 60_000 }, async () => {
  const { startDaemon, requestDaemon, stopDaemon } = await import("../src/daemon.ts");
  const cacheDir = join(mkdtempSync(join(tmpdir(), "st-labels-")), "cache");
  const stateFile = join(cacheDir, "state.json");

  // 模拟用户 HTTP 服务
  const app = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Probed Title</title></head><body></body></html>");
  });
  const port = await new Promise((resolve) => app.listen(0, "127.0.0.1", () => resolve(app.address().port)));

  const waitDaemon = async () => {
    // 注意：requestDaemon 失败时 resolve null（不 reject）——必须检查返回值
    for (let i = 0; i < 50; i++) {
      if (await requestDaemon(cacheDir, "ping")) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("daemon did not come up");
  };

  try {
    // ── 第一次启动：set → 合并下发 ──────────────────────────────────
    startDaemon(cacheDir);
    await waitDaemon();

    const set1 = await requestDaemon(cacheDir, "port.label.set", { port, label: "  我的记账本  " });
    assert.equal(set1.label, "我的记账本"); // trim

    // 非法端口被拒：requestDaemon 出错时 resolve null（不 reject）
    assert.equal(await requestDaemon(cacheDir, "port.label.set", { port: 0, label: "x" }), null);
    assert.equal(await requestDaemon(cacheDir, "port.label.set", { port: 99999, label: "x" }), null);

    // port.list 合并：label 覆盖在探测 identity 上（探测 title 仍在）
    const ports = await requestDaemon(cacheDir, "port.list", { scope: "current-user" });
    const hit = (ports ?? []).find((p) => p.port === port);
    assert.ok(hit, "service port should be listed");
    assert.equal(hit.identity.label, "我的记账本");
    assert.equal(hit.identity.title, "Probed Title");

    // 持久化到 state.json
    assert.ok(existsSync(stateFile));
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(persisted.serviceLabels?.[String(port)], "我的记账本");

    await stopDaemon(cacheDir);

    // ── 重启：label 仍合并下发（state.json rehydrate）────────────────
    startDaemon(cacheDir);
    await waitDaemon();
    const ports2 = await requestDaemon(cacheDir, "port.list", { scope: "current-user" });
    const hit2 = (ports2 ?? []).find((p) => p.port === port);
    assert.equal(hit2?.identity?.label, "我的记账本");

    // ── 清除：空 label 删除条目 ─────────────────────────────────────
    await requestDaemon(cacheDir, "port.label.set", { port, label: "" });
    const ports3 = await requestDaemon(cacheDir, "port.list", { scope: "current-user" });
    const hit3 = (ports3 ?? []).find((p) => p.port === port);
    assert.equal(hit3?.identity?.label, undefined);
    assert.equal(hit3?.identity?.title, "Probed Title"); // 探测识别仍在
    const persisted2 = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(persisted2.serviceLabels?.[String(port)], undefined);
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    app.close();
  }
});
