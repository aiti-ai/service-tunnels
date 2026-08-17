import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer as netServer } from "node:net";
import { spawn } from "node:child_process";

/** Restrict a private key: chmod 0600 on POSIX, icacls on Windows. */
function lockKey(p) {
  if (process.platform === "win32") {
    try {
      spawn.sync("icacls", [p, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], { stdio: "ignore" });
    } catch {
      // best effort
    }
  } else {
    chmodSync(p, 0o600);
  }
}

/** A path usable as UserKnownHostsFile (Windows has no /dev/null). */
function nullDevice() {
  // Windows has no /dev/null: point at an EXISTING empty file — OpenSSH on
  // Windows stalls trying to create a missing known_hosts path (accept-new
  // writes it even with -o StrictHostKeyChecking=no on the command line).
  if (process.platform === "win32") {
    const p = join(tmpdir(), `st-null-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(p, "", "utf8");
    return p;
  }
  return "/dev/null";
}
// A tiny "public entry" relay: listens on ENTRY, pipes to TARGET (mimics what
// ngrok/frpc/ssh -R do for a raw TCP tunnel). Prints ST_TUNNEL_URL:<entry> so
// the tunnel manager can synthesize a URL.
const RELAY_SRC = `
const net = require("net");
const [,, entry, target] = process.argv;
const srv = net.createServer((c) => {
  const t = net.connect(Number(target), "127.0.0.1");
  c.pipe(t); t.pipe(c);
  c.on("error", () => t.destroy());
  t.on("error", () => c.destroy());
});
srv.listen(Number(entry), "127.0.0.1", () => console.log("ST_TUNNEL_URL:127.0.0.1:" + entry));
`;

test("expose --ssh-gateway: tcp tunnel target becomes the SSH gateway port", { timeout: 90_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const { Socket } = await import("node:net");

  const base = mkdtempSync(join(tmpdir(), "st-sshexp-"));
  const cacheDir = join(base, "cache");
  const relayFile = join(base, "relay.cjs");
  writeFileSync(relayFile, RELAY_SRC);

  // target echo service
  const echoPort = await new Promise((resolve) => {
    const srv = netServer((s) => s.on("data", (d) => s.write(d)));
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });

  let sshProc = null;
  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid > 0);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await requestDaemon(cacheDir, "ping")) break;
    }
    assert.ok(await requestDaemon(cacheDir, "ping"), "daemon up");

    // ssh gateway domain pointing at the echo service
    const dom = await requestDaemon(cacheDir, "ssh.domain.create", { domain: "m6dom", forwardPort: echoPort });
    assert.ok(dom?.port > 0, "gateway port");
    const gwPort = dom.port;

    // a user key to authenticate with later
    const keys = await requestDaemon(cacheDir, "ssh.key.generate", { domain: "m6dom", type: "ed25519" });
    const keyFile = join(base, "m6.key");
    writeFileSync(keyFile, keys[0].privateKey);
    chmodSync(keyFile, 0o600);
    lockKey(keyFile);

    // expose with --ssh-gateway: relay (entry) → SSH gateway port
    const entryPort = 41000 + Math.floor(Math.random() * 2000);
    const res = await requestDaemon(cacheDir, "expose", {
      port: echoPort,
      protocol: "tcp",
      tunnelType: "command",
      dangerous: true,
      sshGateway: "m6dom",
      tunnelParams: { cmd: `node ${relayFile} ${entryPort} ${gwPort}` },
      tunnelName: "m6-tcp",
    }, 60_000);
    assert.ok(res, `expose must succeed: ${JSON.stringify(res)}`);
    assert.match(res.url ?? "", /127\.0\.0\.1/, "relay URL synthesized");

    // tunnel target must be the SSH gateway port, NOT the app port
    const configs = (await requestDaemon(cacheDir, "tunnel.configs")) ?? [];
    const t = configs.find((x) => x.name === "m6-tcp");
    assert.ok(t, "tunnel config present");
    assert.equal(t.target, gwPort, `target must be the ssh gateway port (${gwPort}) not ${echoPort}`);

    // 1) raw connection to the entry → SSH banner (gateway rejects unauthenticated)
    const raw = await new Promise((resolve, reject) => {
      const s = new Socket();
      let buf = "";
      s.on("data", (d) => { buf += d.toString(); if (buf.includes("SSH-")) { s.destroy(); resolve(buf.slice(0, 40)); } });
      s.on("error", reject);
      s.connect(entryPort, "127.0.0.1", () => {});
      setTimeout(() => { s.destroy(); reject(new Error("no SSH banner")); }, 8000);
    });
    assert.match(raw, /^SSH-2\.0-/, "entry must land on the SSH gateway (banner)");

    // 2) authorized client via -L to the gateway port → echo roundtrip
    const localPort = await new Promise((resolve) => {
      const srv = netServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
    sshProc = spawn("ssh", [
      "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullDevice(),
      "-o", "ExitOnForwardFailure=yes",
      "-i", keyFile,
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${echoPort}`,
      "-p", String(gwPort), "u@127.0.0.1",
    ], { stdio: process.platform === "win32" ? ["ignore", "ignore", "inherit"] : ["ignore", "ignore", "pipe"] });
    let up = false;
    const upAttempts = process.platform === "win32" ? 120 : 60; // Windows OpenSSH cold-start is slow
    for (let i = 0; i < upAttempts; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const s = new Socket();
        await new Promise((res2, rej) => { s.once("connect", res2); s.once("error", rej); s.connect(localPort, "127.0.0.1"); });
        s.destroy();
        up = true;
        break;
      } catch { /* retry */ }
    }
    assert.ok(up, "-L forward up");
    const reply = await new Promise((resolve, reject) => {
      const s = new Socket();
      let buf = "";
      s.on("data", (d) => { buf += d.toString(); if (buf.length >= 5) { s.destroy(); resolve(buf); } });
      s.on("error", reject);
      s.connect(localPort, "127.0.0.1", () => s.write("m6-ok"));
      setTimeout(() => { s.destroy(); reject(new Error("echo timeout")); }, 8000);
    });
    assert.equal(reply, "m6-ok", "authorized key reaches the echo service");

    // cleanup via IPC: remove the tunnel first (kills the relay child), then
    // the domain, so daemon shutdown does not wait on a long-running child.
    await requestDaemon(cacheDir, "tunnel.remove", "m6-tcp");
    await new Promise((r) => setTimeout(r, 300));
    await requestDaemon(cacheDir, "ssh.domain.remove", { domain: "m6dom" });
  } finally {
    sshProc?.kill();
    await stopDaemon(cacheDir);
    rmSync(base, { recursive: true, force: true });
  }
});
