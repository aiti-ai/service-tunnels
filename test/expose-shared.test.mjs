import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

/** Proof that the shared gateway/redis singletons work: two exposes with
 *  the SAME ServiceTunnels instance reuse ONE nginx (same port, one master
 *  process) instead of spawning a fresh gateway per expose. */
function fakeBin(dir, name, url) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho '${url}'\nsleep 60\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

test("tunnel type change on the same port REPLACES the old tunnel", { timeout: 30_000 }, async () => {
  // Re-exposing the same port with a different tunnel type must tear down the
  // old tunnel and start the new one — start() otherwise reuses the running
  // child and the new type is silently ignored (the bug behind localtunnel
  // exposing via a stale serveo child).
  const base = mkdtempSync(join(tmpdir(), "st-replace-"));
  const configDir = join(base, "config");
  const cacheDir = join(base, "cache");
  const binDir = join(base, "bin");
  fakeBin(binDir, "ngrok", "https://first.ngrok.io");
  fakeBin(binDir, "cloudflared", "https://second.trycloudflare.com");
  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({
    configDir, cacheDir, guardian: false,
    toolPaths: { ngrok: join(binDir, "ngrok"), cloudflared: join(binDir, "cloudflared") },
  });
  const app = createServer((_q, r) => { r.writeHead(200); r.end("ok"); });
  await new Promise((res) => app.listen(0, "127.0.0.1", res));
  const port = app.address().port;
  try {
    const r1 = await st.auth.expose(port, { tunnelType: "ngrok", tunnelName: "t" });
    assert.equal(r1.url, "https://first.ngrok.io");
    // same name, DIFFERENT type → must replace, not reuse the ngrok child
    const r2 = await st.auth.expose(port, { tunnelType: "cloudflared", tunnelName: "t" });
    assert.equal(r2.url, "https://second.trycloudflare.com", "type change replaced the tunnel");
    assert.notEqual(r1.url, r2.url);
  } finally {
    await st.shutdown();
    app.close();
    rmSync(base, { recursive: true, force: true });
  }
});

function countNginxMasters(cacheDir) {
  try {
    const out = execFileSync("pgrep", ["-af", "nginx: master"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes(join(cacheDir, "tmp", "nginx"))).length;
  } catch {
    return 0;
  }
}

test("shared gateway: two exposes reuse ONE nginx (singleton)", { timeout: 60_000 }, async () => {
  // find nginx robustly (it lives in /usr/sbin, often not on PATH)
  const nginxBin = ["/usr/sbin/nginx", "/usr/local/sbin/nginx", "/opt/homebrew/sbin/nginx", "nginx"].find((c) => {
    try {
      if (c.includes("/")) return existsSync(c);
      execFileSync("which", [c], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!nginxBin) {
    return; // no nginx
  }
  const base = mkdtempSync(join(tmpdir(), "st-shared-"));
  const configDir = join(base, "config");
  const cacheDir = join(base, "cache");
  const binDir = join(base, "bin");
  fakeBin(binDir, "ngrok", "https://shared-a.ngrok.io");
  fakeBin(binDir, "cloudflared", "https://shared-b.trycloudflare.com");

  const { createServiceTunnels } = await import("../src/index.ts");
  const st = createServiceTunnels({
    configDir,
    cacheDir,
    guardian: false,
    toolPaths: { ngrok: join(binDir, "ngrok"), cloudflared: join(binDir, "cloudflared") },
  });

  const app1 = createServer((_q, r) => { r.writeHead(200); r.end("app1"); });
  const app2 = createServer((_q, r) => { r.writeHead(200); r.end("app2"); });
  await new Promise((r) => app1.listen(0, "127.0.0.1", r));
  await new Promise((r) => app2.listen(0, "127.0.0.1", r));
  const p1 = app1.address().port;
  const p2 = app2.address().port;

  try {
    const r1 = await st.auth.expose(p1, { auth: true, provider: "portal", tunnelType: "ngrok", tunnelName: "t1", user: { name: "admin", password: "pw" } });
    const r2 = await st.auth.expose(p2, { auth: true, provider: "portal", tunnelType: "cloudflared", tunnelName: "t2", user: { name: "admin", password: "pw" } });

    // both exposes produced a URL
    assert.equal(r1.url, "https://shared-a.ngrok.io");
    assert.equal(r2.url, "https://shared-b.trycloudflare.com");

    // SAME nginx port → the shared singleton was reused (not a new nginx)
    assert.ok(r1.gateway?.nginx, "r1 has a gateway port");
    assert.equal(r1.gateway.nginx, r2.gateway.nginx, "two exposes share ONE nginx port");

    // exactly ONE nginx master for this cache dir (no per-expose duplication)
    const masters = countNginxMasters(cacheDir);
    assert.equal(masters, 1, `expected 1 shared nginx master, found ${masters}`);
  } finally {
    await st.shutdown();
    app1.close();
    app2.close();
    rmSync(base, { recursive: true, force: true });
  }
});
