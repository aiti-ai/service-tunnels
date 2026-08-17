import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netServer } from "node:net";
import { spawn } from "node:child_process";
import { generateKeyPairSync, parseKey } from "../src/ssh/vendor.ts";
import { SshGateway } from "../src/ssh/gateway.ts";
import { SshDomain } from "../src/ssh/domain.ts";

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function sshLogin(gwPort, keyFile, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-i", keyFile, "-p", String(gwPort), "x@127.0.0.1",
      // request a session (shell) — gateway must REJECT it; the ssh command
      // exits with non-zero. Success here means "session was refused".
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let out = "";
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    setTimeout(() => { child.kill(); resolve({ code: null, out }); }, timeoutMs);
  });
}

test("gateway: repeated auth failures from one source lock the source out", { timeout: 60_000 }, async () => {
  const echoPort = await freePort();
  const echo = netServer((s) => s.on("data", (d) => s.write(d)));
  await new Promise((r) => echo.listen(echoPort, "127.0.0.1", r));

  const gw = new SshGateway({
    forwardHost: "127.0.0.1",
    forwardPort: echoPort,
    hostKeys: [generateKeyPairSync("ed25519", { comment: "h" }).private],
    authorizedKeys: [], // nobody is authorized — every attempt fails
    authFailLockout: { failures: 3, lockoutMs: 60_000 },
  });
  const gwPort = await gw.start(0, "127.0.0.1");

  const base = mkdtempSync(join(tmpdir(), "st-sshlck-"));
  const key = generateKeyPairSync("ed25519", { comment: "x" });
  const keyFile = join(base, "k");
  writeFileSync(keyFile, key.private);
  chmodSync(keyFile, 0o600);
  try {
    // First failures: ssh exits with "Permission denied" (auth failed).
    const first = await sshLogin(gwPort, keyFile);
    assert.notEqual(first.code, 0, "unauthenticated key must be rejected");
    assert.match(first.out, /Permission denied|No supported authentication|denied/i);

    const second = await sshLogin(gwPort, keyFile);
    assert.notEqual(second.code, 0);

    const third = await sshLogin(gwPort, keyFile);
    assert.notEqual(third.code, 0);

    // After 3 failures the source IP is locked: connection refused BEFORE
    // auth — the ssh client fails fast without even a banner exchange.
    const locked = await sshLogin(gwPort, keyFile, 10_000);
    assert.notEqual(locked.code, 0, "locked source must not authenticate");
    // The lockout refuses the TCP handshake / banner early — connection-level
    // failure (timeout or refused) rather than a permission-denied exchange.
    assert.notEqual(locked.out.includes("Authenticated"), true, "never authenticates");
  } finally {
    await gw.close();
    echo.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("gateway: unauthenticated connections are dropped after authTimeoutMs", { timeout: 30_000 }, async () => {
  const echoPort = await freePort();
  const echo = netServer();
  await new Promise((r) => echo.listen(echoPort, "127.0.0.1", r));
  const gw = new SshGateway({
    forwardHost: "127.0.0.1",
    forwardPort: echoPort,
    hostKeys: [generateKeyPairSync("ed25519", { comment: "h" }).private],
    authorizedKeys: [parseKey(generateKeyPairSync("ed25519", { comment: "u" }).public)],
    authTimeoutMs: 2000,
  });
  const gwPort = await gw.start(0, "127.0.0.1");
  try {
    // Open a raw TCP connection and send NOTHING (no SSH handshake). The
    // gateway must end the connection after ~2s.
    const { Socket } = await import("node:net");
    const result = await new Promise((resolve) => {
      const s = new Socket();
      s.on("connect", () => {
        // ensure the read side flows so the server's FIN/EOF is consumed and
        // 'close' fires (a raw socket with no data listeners may not).
        s.resume();
      });
      s.on("close", () => resolve("closed"));
      s.on("error", () => resolve("error"));
      s.connect(gwPort, "127.0.0.1");
      setTimeout(() => { s.destroy(); resolve("still-open"); }, 10_000);
    });
    assert.equal(result, "closed", "idle unauthenticated connection must be dropped");
  } finally {
    await gw.close();
    echo.close();
  }
});

test("manager: forwardHost restricted to loopback/private addresses", { timeout: 30_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const base = mkdtempSync(join(tmpdir(), "st-sshfh-"));
  const cacheDir = join(base, "cache");
  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid > 0);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await requestDaemon(cacheDir, "ping")) break;
    }
    // public forwardHost must be rejected
    const bad = await requestDaemon(cacheDir, "ssh.domain.create", {
      domain: "badhost",
      forwardPort: 5000,
      forwardHost: "8.8.8.8",
    });
    assert.equal(bad, null, "public forwardHost must be rejected");
    assert.equal((await requestDaemon(cacheDir, "ssh.domain.list")).length, 0, "no domain created");

    // private forwardHost accepted
    const ok = await requestDaemon(cacheDir, "ssh.domain.create", {
      domain: "privhost",
      forwardPort: 5000,
      forwardHost: "127.0.0.1",
    });
    assert.ok(ok?.port > 0, "loopback forwardHost accepted");
    await requestDaemon(cacheDir, "ssh.domain.remove", { domain: "privhost" });
  } finally {
    await stopDaemon(cacheDir);
    rmSync(base, { recursive: true, force: true });
  }
});

test("domain: key files are 0600 and the store dir is 0700", () => {
  const base = mkdtempSync(join(tmpdir(), "st-sshperm-"));
  try {
    const dir = join(base, "d");
    const d = SshDomain.create("d", dir);
    // POSIX permission bits; Windows has no such semantics — existence/readability only
    const permCheck = process.platform !== "win32";
    if (permCheck) assert.equal(statSync(dir).mode & 0o777, 0o700, "store dir must be 0700");
    for (const f of ["host_ed25519_key", "host_rsa_key", "host_ecdsa_key", "authorized_keys"]) {
      const p = join(dir, f);
      if (existsSync(p) && permCheck) assert.equal(statSync(p).mode & 0o777, 0o600, `${f} must be 0600`);
    }
    // adding a key keeps 0600
    d.addKey(generateKeyPairSync("ed25519", { comment: "u" }).public);
    if (permCheck) assert.equal(statSync(d.authorizedKeysPath).mode & 0o777, 0o600, "authorized_keys stays 0600 after add");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
