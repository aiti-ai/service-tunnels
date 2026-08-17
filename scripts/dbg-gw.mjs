// Diagnose gateway on Windows: raw banner + ssh -L
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { createServer as netServer, connect as netConnect } from "net";
import { spawn, execFileSync } from "child_process";
import { generateKeyPairSync, parseKey } from "../src/ssh/vendor.ts";
import { SshGateway } from "../src/ssh/gateway.ts";

const log = (...a) => console.error("[DBG]", ...a);
const base = mkdtempSync(join(tmpdir(), "st-gwdbg2-"));
const forwardPort = 43100 + Math.floor(Math.random() * 100);
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
log("gw port:", gwPort);

// 1. raw banner probe
try {
  const s = netConnect(gwPort, "127.0.0.1");
  let buf = "";
  s.on("data", (d) => (buf += d));
  await new Promise((res, rej) => { s.once("connect", res); s.once("error", rej); });
  await new Promise((r) => setTimeout(r, 1500));
  log("banner:", JSON.stringify(buf.slice(0, 80)));
  s.destroy();
} catch (e) {
  log("banner fail:", e.message);
}

const keyFile = join(base, "k");
writeFileSync(keyFile, userKey.private);
execFileSync("icacls", [keyFile, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], { stdio: "ignore" });
const nullFile = join(base, "null");
writeFileSync(nullFile, "");
const localPort = 43150 + Math.floor(Math.random() * 50);

const p = spawn("ssh", [
  "-vvv", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullFile,
  "-o", "ExitOnForwardFailure=yes", "-i", keyFile,
  "-L", `127.0.0.1:${localPort}:127.0.0.1:${forwardPort}`,
  "-p", String(gwPort), "t@127.0.0.1",
], { stdio: ["ignore", "ignore", "pipe"] });
let err = "";
p.stderr.on("data", (d) => (err += d));
await new Promise((r) => setTimeout(r, 6000));
log("ssh exited:", p.exitCode !== null);
log("--- stderr (full, last 40) ---");
log(err.split("\n").filter(Boolean).slice(-40).join("\n"));
try { p.kill(); } catch {}
try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
await gw.close();
echo.close();
rmSync(base, { recursive: true, force: true });
process.exit(0);
