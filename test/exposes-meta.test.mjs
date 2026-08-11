import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

test("M0a: exposes() metadata — startedAt + proxy-mode running by binding", { timeout: 40_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "st-exmeta-"));
  let st = null;
  let app = null;
  try {
    st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });

    app = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/plain" }); r.end("hi"); });
    await new Promise((res) => app.listen(0, "127.0.0.1", res));
    const port = app.address().port;

    const before = Date.now();
    const r = await st.auth.expose(port, { auth: false, mode: "proxy", startTransport: false });
    assert.ok(r.mode === "proxy", "proxy expose accepted");

    const exs = st.exposes();
    const rec = exs.find((e) => e.port === port);
    assert.ok(rec, "expose record present");
    assert.ok(typeof rec.startedAt === "number" && rec.startedAt >= before, "startedAt recorded at expose time");
    // startTransport:false → localUrl empty; running must be binding-driven (M0a-T3)
    assert.equal(rec.localUrl, "", "no local transport");
    assert.equal(rec.running, true, "proxy-mode running = binding enrolled");

    // removing the binding flips running to false (pi-web patch problem fixed in-lib)
    st.proxy.removeBinding(port, "");
    const after = st.exposes().find((e) => e.port === port);
    assert.equal(after?.running, false, "running false once binding removed");
  } finally {
    if (app) await new Promise((res) => app.close(res));
    if (st) await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});
