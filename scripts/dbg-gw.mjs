// Diagnose gateway on Windows: capture ssh stderr to FILE (not pipe)
import { mkdtempSync, rmSync, writeFileSync, openSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { createServer as netServer } from "net";
import { spawn, execFileSync } from "child_process";
import { generateKeyPairSync, parseKey } from "../src/ssh/vendor.ts";
import { SshGateway } from "../src/ssh/gateway.ts";

const log = (...a) => console.error("[DBG]", ...a);
const base = mkdtempSync(join(tmpdir(), "st-gwdbg3-"));
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

const keyFile = join(base, "k");
writeFileSync(keyFile, userKey.private);
execFileSync("icacls", [keyFile, "/inheritance:r", "/grant:r", `${userInfo().username}:R`], { stdio: "ignore" });
const nullFile = join(base, "null");
writeFileSync(nullFile, "");
const localPort = 43150 + Math.floor(Math.random() * 50);
const errFile = join(base, "ssh-err.txt");
const errFd = openSync(errFile, "w");

const p = spawn("ssh", [
  "-vvv", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=" + nullFile,
  "-o", "ExitOnForwardFailure=yes", "-i", keyFile,
  "-L", `127.0.0.1:${localPort}:127.0.0.1:${forwardPort}`,
  "-p", String(gwPort), "t@127.0.0.1",
], { stdio: ["ignore", "ignore", errFd] });
p.on("exit", (c, sig) => log("ssh exit:", c, "sig:", sig));
await new Promise((r) => setTimeout(r, 5000));
log("exited:", p.exitCode !== null);
const err = require("fs").readFileSync(errFile, "utf8");
log("--- stderr file (last 40) ---");
log(err.split("\n").filter(Boolean).slice(-40).join("\n"));
try { p.kill(); } catch {}
try { execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
await gw.close();
echo.close();
rmSync(base, { recursive: true, force: true });
process.exit(0);
