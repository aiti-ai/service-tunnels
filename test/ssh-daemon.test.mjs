import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
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
async function loadSubject() {
  return import("../src/daemon.ts");
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-sshd-"));
  return { cacheDir: join(base, "cache"), configDir: join(base, "config"), base };
}

async function bindHttpServer() {
  // Bind then close to obtain an ephemeral free port (reused below).
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve({ port, close: () => Promise.resolve() }));
    });
  });
}

async function waitDaemon(cacheDir, requestDaemon, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      // requestDaemon resolves null both when the daemon is not up yet AND
      // when the RPC errored — only a non-null pong counts as ready.
      const pong = await requestDaemon(cacheDir, "ping");
      if (pong) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("daemon ssh.* IPC: domain create/keys/forwarding via real ssh client", { timeout: 60_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const fwd = await bindHttpServer();
  const echo = netServer((s) => s.on("data", (d) => s.write(d)));
  await new Promise((r) => echo.listen(fwd.port, "127.0.0.1", r));

  let sshProc = null;
  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid > 0);
    const up = await waitDaemon(cacheDir, requestDaemon);
    assert.ok(up, "daemon should come up");

    // create domain
    const created = await requestDaemon(cacheDir, "ssh.domain.create", {
      domain: "m4test",
      forwardPort: fwd.port,
    });
    assert.ok(created?.port > 0, "gateway must bind a port");
    assert.equal(created.domain, "m4test");

    // list shows it
    const list = await requestDaemon(cacheDir, "ssh.domain.list");
    assert.equal(list.length, 1);
    assert.ok(list[0].hostKeyFingerprints.ed25519, "host key fingerprints present");

    // generate a client key (private returned once)
    const keys = await requestDaemon(cacheDir, "ssh.key.generate", { domain: "m4test", type: "ed25519", comment: "m4" });
    assert.equal(keys.length, 1);
    assert.match(keys[0].privateKey, /BEGIN OPENSSH PRIVATE KEY/);

    // key list + host fingerprints over IPC
    const keyList = await requestDaemon(cacheDir, "ssh.key.list", { domain: "m4test" });
    assert.equal(keyList.length, 1);
    assert.equal(keyList[0].fingerprint, keys[0].fingerprint);
    const fps = await requestDaemon(cacheDir, "ssh.host.fingerprints", { domain: "m4test" });
    assert.ok(fps.ed25519);

    // real ssh -L through the daemon-hosted gateway
    const keyFile = join(base, "m4.key");
    writeFileSync(keyFile, keys[0].privateKey);
    chmodSync(keyFile, 0o600);
    lockKey(keyFile);
    const localPort = (await bindHttpServer()).port;
    sshProc = spawn("ssh", [
      "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullDevice(),
      ...(process.platform === "win32" ? ["-o", "LogLevel=QUIET"] : []), // Windows ssh 无控制台 stderr 时 banner 路径挂起, QUIET 抑制
      "-o", "ExitOnForwardFailure=yes",
      "-i", keyFile,
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${fwd.port}`,
      "-p", String(created.port), "t@127.0.0.1",
    ], { stdio: process.platform === "win32" ? ["ignore", "ignore", "inherit"] : ["ignore", "ignore", "pipe"] });

    // wait for the local forward, then roundtrip
    const { Socket } = await import("node:net");
    let fwdUp = false;
    const fwdAttempts = process.platform === "win32" ? 120 : 60; // Windows OpenSSH cold-start is slow
    for (let i = 0; i < fwdAttempts; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const s = new Socket();
        await new Promise((res, rej) => { s.once("connect", res); s.once("error", rej); s.connect(localPort, "127.0.0.1"); });
        s.destroy();
        fwdUp = true;
        break;
      } catch { /* retry */ }
    }
    assert.ok(fwdUp, "ssh -L forward must come up through the daemon gateway");

    const reply = await new Promise((resolve, reject) => {
      const s = new Socket();
      let buf = "";
      s.on("data", (d) => { buf += d.toString(); if (buf.length >= 5) { s.destroy(); resolve(buf); } });
      s.on("error", reject);
      s.connect(localPort, "127.0.0.1", () => s.write("m4-ok"));
      setTimeout(() => { s.destroy(); reject(new Error("echo timeout")); }, 6000);
    });
    assert.equal(reply, "m4-ok");

    // remove a key + domain over IPC
    const removed = await requestDaemon(cacheDir, "ssh.key.remove", { domain: "m4test", fingerprint: keys[0].fingerprint });
    assert.equal(removed.removed, true);
    const rmRes = await requestDaemon(cacheDir, "ssh.domain.remove", { domain: "m4test" });
    assert.deepEqual(rmRes, { ok: true });
    assert.equal((await requestDaemon(cacheDir, "ssh.domain.list")).length, 0);
    // domain dir wiped
    assert.equal(existsSync(join(cacheDir, "tmp", "ssh", "m4test")), false);
  } finally {
    sshProc?.kill();
    echo.close();
    fwd.close();
    await stopDaemon(cacheDir);
    rmSync(base, { recursive: true, force: true });
  }
});
