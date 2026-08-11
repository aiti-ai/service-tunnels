import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

test("daemon expose registry: expose.list + expose.stop (proxy-mode dual path)", { timeout: 60_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const base = mkdtempSync(join(tmpdir(), "st-exreg-"));
  const cacheDir = join(base, "cache");
  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid > 0);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await requestDaemon(cacheDir, "ping")) break;
    }
    assert.ok(await requestDaemon(cacheDir, "ping"), "daemon must respond");

    // a real listening service port (test process owns it; force skips the
    // daemon-side ownership check — the daemon can't see our process tree)
    const app = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/plain" }); r.end("hi"); });
    await new Promise((res) => app.listen(0, "127.0.0.1", res));
    const port = app.address().port;

    // proxy-mode expose (auth none → no nginx needed) through the daemon
    const ex = await requestDaemon(cacheDir, "expose", { port, auth: false, mode: "proxy", force: true }, 30_000);
    assert.ok(ex, "expose accepted");
    const name = `proxy:${port}:`;
    assert.equal(ex.mode, "proxy", "mode recorded");

    // expose.list reflects the registry entry (running = binding enrolled)
    const list1 = (await requestDaemon(cacheDir, "expose.list")) ?? [];
    const rec = list1.find((e) => e.name === name);
    assert.ok(rec, "registry entry present: " + JSON.stringify(list1));
    assert.equal(rec.port, port);
    assert.equal(rec.running, true, "proxy-mode running = binding enrolled");
    assert.ok(typeof rec.startedAt === "number", "startedAt recorded");

    // proxy bindings contain the enrollment
    const bindings = (await requestDaemon(cacheDir, "proxy.bindings")) ?? [];
    assert.ok(bindings.some((b) => b.port === port), "proxy binding registered");

    // expose.stop — dual path: removes the binding + registry record
    const stopped = await requestDaemon(cacheDir, "expose.stop", name, 10_000);
    assert.ok(stopped, "expose.stop ok");
    const list2 = (await requestDaemon(cacheDir, "expose.list")) ?? [];
    assert.ok(!list2.find((e) => e.name === name), "registry record removed");
    const bindings2 = (await requestDaemon(cacheDir, "proxy.bindings")) ?? [];
    assert.ok(!bindings2.some((b) => b.port === port), "proxy binding removed");

    // stop of an unknown expose → RPC error (non-null error path)
    const unknown = await requestDaemon(cacheDir, "expose.stop", "proxy:99999:");
    assert.equal(unknown, null, "unknown expose rejected");

    app.close();
  } finally {
    await stopDaemon(cacheDir);
    rmSync(base, { recursive: true, force: true });
  }
});
