import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "../src/ssh/vendor.ts";

test("UI: SPA shell + site-scoped ssh-keys API (add/generate/revoke/list)", { timeout: 60_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { startUi } = await import("../src/ui.ts");
  const { startDaemon, stopDaemon, requestDaemon } = await import("../src/daemon.ts");

  const base = mkdtempSync(join(tmpdir(), "st-sshui-"));
  const cacheDir = join(base, "cache");
  let ui = null;
  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid > 0);
    // wait until ping works (non-null)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await requestDaemon(cacheDir, "ping")) break;
    }
    assert.ok(await requestDaemon(cacheDir, "ping"), "daemon must respond");

    const st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir, guardian: false });
    ui = await startUi(st, { port: 0, openBrowser: false });
    const port = ui.port;
    const origin = `http://127.0.0.1:${port}`;

    // SPA shell serves every page path (hash routing client-side)
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /UI_MSG/, "i18n dictionary embedded");
    assert.match(html, /\/ui\/main\.js/, "client module reference present");
    const m = /<meta name="csrf-token" content="([0-9a-f]{64})">/.exec(html);
    assert.ok(m, "csrf token present");
    const token = m[1];
    const headers = { "X-CSRF-Token": token, Origin: origin, "Content-Type": "application/json" };

    // POST without token → 403 (gate applies to the new routes too)
    const noToken = await fetch(`${origin}/api/ssh-keys`, { method: "POST" });
    assert.equal(noToken.status, 403, "ssh POST requires CSRF");

    // create the site's backing ssh domain via daemon RPC (site → domain
    // auto-provision is M0b-ssh, deferred — the UI only ever sees site + keys)
    const created = await requestDaemon(cacheDir, "ssh.domain.create", { domain: "siteA", forwardPort: 33221 });
    assert.ok(created, "backing ssh domain created");

    // upload an existing public key via the site-scoped endpoint
    const kp = generateKeyPairSync("ed25519", { comment: "ui-user" });
    const addKey = await fetch(`${origin}/api/ssh-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "add", site: "siteA", publicKey: kp.public }),
    });
    const addRes = await addKey.json();
    assert.equal(addKey.status, 200, addRes.error ?? "add key ok");
    assert.match(addRes.fingerprint, /^SHA256:/);

    // duplicate key rejected with 400
    const dup = await fetch(`${origin}/api/ssh-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "add", site: "siteA", publicKey: kp.public }),
    });
    assert.equal(dup.status, 400, "duplicate key rejected");

    // generate a keypair → private key returned once
    const gen = await fetch(`${origin}/api/ssh-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "generate", site: "siteA", type: "ed25519", comment: "gen", count: 2 }),
    });
    assert.equal(gen.status, 200);
    const genRes = await gen.json();
    assert.equal(genRes.length, 2, "batch count honored");
    assert.match(genRes[0].privateKey, /BEGIN OPENSSH PRIVATE KEY/);

    // list keys for the site (Users matrix ssh column)
    const list = await fetch(`${origin}/api/ssh-keys?site=siteA`);
    assert.equal(list.status, 200);
    const listRes = await list.json();
    assert.equal(listRes.keys.length, 3, "uploaded + 2 generated keys listed");

    // revoke the uploaded key by fingerprint
    const revoke = await fetch(`${origin}/api/ssh-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "revoke", site: "siteA", fingerprint: addRes.fingerprint }),
    });
    assert.equal(revoke.status, 200);
    const after = await fetch(`${origin}/api/ssh-keys?site=siteA`).then((r) => r.json());
    assert.equal(after.keys.length, 2, "key revoked");

    // cleanup: remove the site's backing domain so the ssh gateway stops
    assert.ok(await requestDaemon(cacheDir, "ssh.domain.remove", { domain: "siteA" }), "domain removed");

    // /api/live + /api/status respond (dual-mode: daemon is up → exposes from
    // the daemon registry; the ssh gateway port is excluded from candidate ports)
    const live = await fetch(`${origin}/api/live`).then((r) => r.json());
    assert.ok(Array.isArray(live.exposes), "exposes array (daemon registry)");
    assert.ok(Array.isArray(live.ports), "ports array");
    const status = await fetch(`${origin}/api/status`).then((r) => r.json());
    assert.equal(status.mode, "daemon", "daemon mode detected");
    assert.ok(Array.isArray(status.sites), "sites listed");
  } finally {
    ui?.close();
    await stopDaemon(cacheDir);
    rmSync(base, { recursive: true, force: true });
  }
});
