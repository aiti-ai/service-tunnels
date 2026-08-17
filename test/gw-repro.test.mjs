// Copy of gateway -L logic wrapped in node:test — isolate framework influence
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer as netServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync, parseKey } from "../src/ssh/vendor.ts";
import { SshGateway } from "../src/ssh/gateway.ts";

test("gw-repro", { timeout: 60_000 }, async () => {
  console.error("[REPRO] start");
  const base = mkdtempSync(join(tmpdir(), "st-gwrepro-"));
  const forwardPort = 43100 + Math.floor(Math.random() * 100);
  const localPort1 = 43150 + Math.floor(Math.random() * 50);
  const echo = netServer((s) => s.on("data", (d) => s.write(d)));
  await new Promise((r) => echo.listen(forwardPort, "127.0.0.1", r));

  const hostKey = generateKeyPairSync("ed25519", { comment: "host" }).private;
  const userKey = generateKeyPairSync("ed25519", { comment: "user" });
  const gw = new SshGateway({
    forwardHost: "127.0.0.1",
    forwardPort,
    hostKeys: [hostKey],
    authorizedKeys: [parseKey(userKey.public)],
  });
  const gwPort = await gw.start(0, "127.0.0.1");
  console.error("[REPRO] gw port", gwPort);

  const keyFile = join(base, "k");
  writeFileSync(keyFile, userKey.private);
  execFileSync("icacls", [keyFile, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], { stdio: "ignore" });
  const nullFile = join(base, "null");
  writeFileSync(nullFile, "");

  const p = spawn("ssh", [
    "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullFile,
    "-o", "ExitOnForwardFailure=yes",
    "-i", keyFile,
    "-L", `127.0.0.1:${localPort1}:127.0.0.1:${forwardPort}`,
    "-p", String(gwPort), "t@127.0.0.1",
  ], { stdio: ["ignore", "ignore", "inherit"] });
  p.on("exit", (c) => console.error("[REPRO] ssh exit", c));

  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    try {
      const s = new (await import("node:net")).Socket();
      await new Promise((res, rej) => { s.once("connect", res); s.once("error", rej); s.connect(localPort1, "127.0.0.1"); });
      s.destroy();
      up = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.error("[REPRO] up:", up, "elapsed:", Date.now() - t0);
  try { p.kill(); } catch {}
  try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  await gw.close();
  echo.close();
  rmSync(base, { recursive: true, force: true });
  assert.ok(up, "forward must come up");
});
