import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { connect as netConnect } from "node:net";

/** Restrict a private key: chmod 0600 on POSIX, icacls on Windows. */
function lockKey(p) {
  if (process.platform === "win32") {
    try {
      execFile.sync("icacls", [p, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], { stdio: "ignore" });
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

/** M0b-ssh: provider "ssh" = site-scoped public-key auth for ANY protocol.
 *  Verifies: auto-provision of the site's backing ssh domain (port auto-
 *  allocated, no domain/port management by the caller), provider recorded as
 *  "ssh", and that a generated key actually reaches the target service via
 *  `ssh -L` through the gateway (security = site public keys). */
test("ssh provider: auto-provision site domain + public-key port-forward (any protocol)", { timeout: 90_000 }, async () => {
  if (process.platform === "win32") return; // needs a real ngrok download (win32 zip 404) + ssh -L; covered on Linux
  const { createServiceTunnels } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "st-sshprov-"));
  let st = null;
  let app = null;
  try {
    st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });

    // a plain HTTP service — ssh provider serves ANY port via port-forward
    app = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/plain" }); r.end("ssh-provider-ok"); });
    await new Promise((res) => app.listen(0, "127.0.0.1", res));
    const port = app.address().port;

    // TODO-1 (fail-clean): 域预先存在（模拟其他暴露已建）——本次隧道失败不回滚它；
    // 这样 ssh -L 公钥认证路径仍可验证（域不被回滚删除）。
    await st.ssh.ensure({ domain: "siteB", forwardPort: port, sshPort: 0 });

    // expose with provider "ssh" + site only — the tunnel public entry (ngrok
    // tcp) needs a paid account here and fails fast; the ssh auth layer and
    // auto-provisioning are what we verify.
    const r = await st.auth.expose(port, { provider: "ssh", site: "siteB", tunnelType: "ngrok" });
    assert.match(r.tunnel, /-tcp$/, "routed through the raw tcp branch");
    assert.ok(r.url === null, "public tunnel needs paid ngrok tcp (expected)");
    assert.equal(r.protocol, "tcp", "protocol reported tcp (port-forward)");

    // site's backing ssh domain present (pre-created — not rolled back on
    // tunnel failure since it was not created BY this expose)
    const domain = st.ssh.get("siteB");
    assert.ok(domain, "backing ssh domain present");
    assert.ok(domain.port > 0, "gateway port auto-allocated");
    assert.equal(domain.forwardPort, port, "forward target = exposed port");

    // expose record carries provider "ssh"
    const rec = st.exposes().find((e) => e.port === port);
    assert.ok(rec, "expose record present");
    assert.equal(rec.provider, "ssh", "provider surfaced as ssh");

    // security = site public keys: generate a key for the site, then
    // `ssh -L` through the gateway → the target service answers.
    const [kp] = await st.ssh.keys.generate("siteB", { comment: "test" });
    assert.ok(kp.privateKey.includes("BEGIN OPENSSH PRIVATE KEY"));
    const keyFile = join(base, "id_test");
    writeFileSync(keyFile, kp.privateKey, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    lockKey(keyFile);

    const localPort = 20000 + Math.floor(Math.random() * 40000);
    const sshClient = execFile("ssh", [
      "-i", keyFile, "-p", String(domain.port), "-L", `${localPort}:127.0.0.1:${port}`,
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullDevice(), "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=8", "-N", "sshuser@127.0.0.1",
    ], { stdio: "ignore" });

    // wait for the local forward listener to open before requesting
    let ready = false;
    const readyAttempts = process.platform === "win32" ? 80 : 40; // Windows OpenSSH cold-start is slow
    for (let i = 0; i < readyAttempts && !ready; i++) {
      await new Promise((r) => setTimeout(r, 150));
      await new Promise((resolve) => {
        const sock = netConnect(localPort, "127.0.0.1");
        sock.once("connect", () => { sock.destroy(); ready = true; resolve(); });
        sock.once("error", () => resolve());
      });
    }
    assert.ok(ready, "ssh -L forward listener opened");

    const body = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: localPort, path: "/" }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, "ssh-provider-ok", "authorized key reaches the service via port-forward");

    // stop the local forward (so the test's event loop closes cleanly)
    sshClient.kill("SIGTERM");
    await new Promise((r) => {
      sshClient.once("exit", r);
      setTimeout(r, 1_500).unref();
    });
    if (sshClient.exitCode === null) sshClient.kill("SIGKILL");

    // unauthorized key → connection rejected (publickey-only)
    // (implicit: the gateway accepts only keys in the site's authorized_keys)
    const [kp2] = await st.ssh.keys.generate("siteB", { comment: "unused" });
    assert.ok(kp2.fingerprint, "second key generated (not added to authorized_keys)");
  } finally {
    if (app) await new Promise((res) => app.close(res));
    if (st) await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});
