import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer as netServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, parseKey } from "../src/ssh/vendor.ts";
import { SshGateway } from "../src/ssh/gateway.ts";

/** Restrict a private-key file: chmod 0600 on POSIX, icacls on Windows
 *  (chmod is a no-op there and OpenSSH rejects over-permissive keys). */
function lockKey(p) {
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", [p, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], { stdio: "ignore" });
    } catch {
      // best effort — some CI sandboxes forbid icacls
    }
  } else {
    chmodSync(p, 0o600);
  }
}

/** A path usable as UserKnownHostsFile (Windows has no /dev/null). */
function nullDevice() {
  return process.platform === "win32" ? join(tmpdir(), `st-null-${process.pid}-${Math.random().toString(36).slice(2)}`) : "/dev/null";
}

/** Bind a TCP listener on an ephemeral port and return { port, close }. */
function bindHttpServer() {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

function pickFreePort() {
  return bindHttpServer().then(({ port, close }) => close().then(() => port));
}

test("vendored keygen: OpenSSH keys are accepted by system ssh-keygen", async () => {
  const kp = generateKeyPairSync("ed25519", { comment: "t" });
  const base = mkdtempSync(join(tmpdir(), "st-sshkey-"));
  const priv = join(base, "id");
  writeFileSync(priv, kp.private);
  chmodSync(priv, 0o600);
  try {
    const pub = execFileSync("ssh-keygen", ["-y", "-f", priv], { encoding: "utf8" }).trim();
    // ssh-keygen -y outputs "<algo> <b64> <comment>" — the key material must match
    const ours = kp.public.split(" ").slice(0, 2).join(" ");
    assert.ok(pub.startsWith(ours), `pub key mismatch: ${pub} vs ${ours}`);
    const fp = execFileSync("ssh-keygen", ["-lf", priv], { encoding: "utf8" });
    assert.match(fp, /ED25519/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("vendored parseKey: rejects garbage, accepts valid public key", () => {
  // ssh2 parseKey returns an Error object (does not throw) on garbage
  const bad = parseKey("not a key at all");
  assert.ok(bad instanceof Error, "garbage must yield an Error");
  const kp = generateKeyPairSync("ed25519");
  const parsed = parseKey(kp.public);
  assert.equal(parsed.type, "ssh-ed25519");
});

test("gateway -L: correct key roundtrips, wrong key rejected, target pinned", async () => {
  const forwardPort = await pickFreePort();
  const localPort1 = await pickFreePort();
  const localPort2 = await pickFreePort();

  const echo = netServer((s) => s.on("data", (d) => s.write(d)));
  await new Promise((r) => echo.listen(forwardPort, "127.0.0.1", r));

  const hostKey = generateKeyPairSync("ed25519", { comment: "host" }).private;
  const userKey = generateKeyPairSync("ed25519", { comment: "user" });
  const wrongKey = generateKeyPairSync("ed25519", { comment: "wrong" });

  const gw = new SshGateway({
    forwardHost: "127.0.0.1",
    forwardPort,
    hostKeys: [hostKey],
    authorizedKeys: [parseKey(userKey.public)],
  });
  const gwPort = await gw.start(0, "127.0.0.1");
  assert.ok(gwPort > 0);

  const base = mkdtempSync(join(tmpdir(), "st-sshe2e-"));
  const keyFile = join(base, "k");
  const wrongFile = join(base, "w");
  writeFileSync(keyFile, userKey.private);
  writeFileSync(wrongFile, wrongKey.private);
  chmodSync(keyFile, 0o600);
  chmodSync(wrongFile, 0o600);
  lockKey(keyFile);
  lockKey(wrongFile);

  const sshArgs = (localPort, key) => [
    "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullDevice(),
    "-o", "ExitOnForwardFailure=yes",
    "-i", key,
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${forwardPort}`,
    "-p", String(gwPort),
    "t@127.0.0.1",
  ];

  async function waitLocal(localPort, ms = 5000) {
    const t0 = Date.now();
    const { Socket } = await import("node:net");
    while (Date.now() - t0 < ms) {
      try {
        const s = new Socket();
        await new Promise((res, rej) => { s.once("connect", res); s.once("error", rej); s.connect(localPort, "127.0.0.1"); });
        s.destroy();
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    return false;
  }

  async function echoThrough(localPort, payload) {
    const { Socket } = await import("node:net");
    return new Promise((resolve, reject) => {
      const s = new Socket();
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.length >= payload.length) { s.destroy(); resolve(buf); }
      });
      s.on("error", reject);
      s.connect(localPort, "127.0.0.1", () => s.write(payload));
      setTimeout(() => { s.destroy(); reject(new Error("echo timeout")); }, 5000);
    });
  }

  let sshProc = null;
  try {
    // 1. correct key → roundtrip through -L (target port in the request is the
    //    fixed port; a different target port must ALSO land on the fixed one).
    sshProc = spawn("ssh", sshArgs(localPort1, keyFile), { stdio: process.platform === "win32" ? ["ignore", "ignore", "inherit"] : ["ignore", "ignore", "pipe"] });
    assert.ok(await waitLocal(localPort1), "correct key: local forward must come up");
    assert.equal(await echoThrough(localPort1, "hello-via-ssh"), "hello-via-ssh");
    sshProc.kill();
    sshProc = null;

    // 2. wrong key → no working forward
    sshProc = spawn("ssh", sshArgs(localPort2, wrongFile), { stdio: process.platform === "win32" ? ["ignore", "ignore", "inherit"] : ["ignore", "ignore", "pipe"] });
    await new Promise((r) => setTimeout(r, 1200));
    const up2 = await waitLocal(localPort2, 1000);
    assert.equal(up2, false, "wrong key must not bring up a forward");
    sshProc.kill();
    sshProc = null;

    // 3. pinned target: request a DIFFERENT target port, still reach the fixed
    //    service (the -L dest is ignored by the gateway).
    const localPort3 = await pickFreePort();
    const ssh3 = spawn("ssh", [
      "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullDevice(),
      "-o", "ExitOnForwardFailure=yes",
      "-i", keyFile,
      "-L", `127.0.0.1:${localPort3}:127.0.0.1:${forwardPort + 500}`, // bogus target
      "-p", String(gwPort), "t@127.0.0.1",
    ], { stdio: process.platform === "win32" ? ["ignore", "ignore", "inherit"] : ["ignore", "ignore", "pipe"] });
    assert.ok(await waitLocal(localPort3), "pinned: local forward must come up");
    assert.equal(await echoThrough(localPort3, "pinned"), "pinned", "bogus target port must still hit fixed service");
    ssh3.kill();
  } finally {
    sshProc?.kill();
    await gw.close();
    echo.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("gateway -R: reverse forwarding reaches client's local service, bogus bindPort ignored", async () => {
  const forwardPort = await pickFreePort();
  const reversePort = await pickFreePort();
  const localSrvPort = await pickFreePort();

  // Target service for -L side (unused here but must exist since forwardPort
  // is always the -L target).
  const echo = netServer((s) => s.on("data", (d) => s.write(d)));
  await new Promise((r) => echo.listen(forwardPort, "127.0.0.1", r));
  // Client-side service: what the -R tunnel delivers to.
  const clientSrv = netServer((s) => s.on("data", (d) => s.write(d)));
  await new Promise((r) => clientSrv.listen(localSrvPort, "127.0.0.1", r));

  const hostKey = generateKeyPairSync("ed25519", { comment: "host" }).private;
  const userKey = generateKeyPairSync("ed25519", { comment: "user" });

  const gw = new SshGateway({
    forwardHost: "127.0.0.1",
    forwardPort,
    reversePort,
    hostKeys: [hostKey],
    authorizedKeys: [parseKey(userKey.public)],
  });
  const gwPort = await gw.start(0, "127.0.0.1");

  const base = mkdtempSync(join(tmpdir(), "st-sshrev-"));
  const keyFile = join(base, "k");
  writeFileSync(keyFile, userKey.private);
  chmodSync(keyFile, 0o600);
  lockKey(keyFile);

  // Request remote forwarding with a BOGUS bind port (9999) — gateway must
  // ignore it and bind reversePort instead.
  const ssh = spawn("ssh", [
    "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullDevice(),
    "-o", "ExitOnForwardFailure=yes",
    "-i", keyFile,
    "-R", `9999:127.0.0.1:${localSrvPort}`, // bogus bind port on the server side
    "-p", String(gwPort), "t@127.0.0.1",
  ], { stdio: process.platform === "win32" ? ["ignore", "ignore", "inherit"] : ["ignore", "ignore", "pipe"] });

  try {
    // Wait until the gateway's reversePort listener is up (it's a net server
    // inside the gateway process; probe it).
    const { Socket: ProbeSocket } = await import("node:net");
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function probe() {
        const s = new ProbeSocket();
        s.once("connect", () => { s.destroy(); resolve(); });
        s.once("error", () => { s.destroy(); if (Date.now() - t0 > 5000) reject(new Error("reversePort never up")); else setTimeout(probe, 100); });
        s.connect(reversePort, "127.0.0.1");
      })();
    });

    const { Socket } = await import("node:net");
    const reply = await new Promise((resolve, reject) => {
      const s = new Socket();
      let buf = "";
      s.on("data", (d) => { buf += d.toString(); if (buf.length >= 6) { s.destroy(); resolve(buf); } });
      s.on("error", reject);
      s.connect(reversePort, "127.0.0.1", () => s.write("rev-ok"));
      setTimeout(() => { s.destroy(); reject(new Error("reverse echo timeout")); }, 6000);
    });
    assert.equal(reply, "rev-ok", "-R must deliver to the client-side service on reversePort");
  } finally {
    ssh.kill();
    await gw.close();
    echo.close();
    clientSrv.close();
    rmSync(base, { recursive: true, force: true });
  }
});
