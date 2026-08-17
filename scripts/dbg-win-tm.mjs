// Reproduce lifecycle test on Windows directly
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const base = mkdtempSync(join(tmpdir(), "st-dbg-tm-"));
const dir = join(base, "bin");
mkdirSync(dir, { recursive: true });
const output = "Forwarding https://demo.ngrok.io -> http://127.0.0.1:4180";
const helper = join(dir, "ngrok-helper.cjs");
writeFileSync(
  helper,
  'const fs = require("fs");\n' +
    "const args = process.argv.slice(2);\n" +
    `fs.writeFileSync(${JSON.stringify(join(dir, "args-ngrok"))}, args.join("\\n") + "\\n");\n` +
    `console.log(${JSON.stringify(output)});\n` +
    "setInterval(() => {}, 1000);\n",
);
const cmdBin = join(dir, "ngrok.cmd");
writeFileSync(cmdBin, "@echo off\r\nnode \"" + helper + "\" %*\r\n");
console.log("fake bin:", cmdBin);

const { TunnelManager } = await import("./src/tunnels.ts");
const tm = new TunnelManager({
  cacheDir: join(base, "cache"),
  resolveTool: async (name) => join(dir, name),
  onEvent: (e) => console.log("EVENT:", e.type, e.url ?? ""),
});
tm.add({ name: "web", type: "ngrok", target: 4180 });
try {
  const info = await tm.start("web");
  console.log("started: running=", info.running, "pid=", info.pid);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const s = tm.get("web");
    if (s?.url) {
      console.log("URL FOUND:", s.url);
      break;
    }
    if (i === 15) console.log("mid: running=", s?.running, "output=", JSON.stringify(s?.lastOutput ?? s?.output));
  }
  const s = tm.get("web");
  console.log("final: url=", s?.url, "running=", s?.running, "error=", s?.error, "output=", JSON.stringify(s?.output ?? ""));
  await tm.stop("web");
  console.log("stopped, url now:", tm.get("web")?.url);
} catch (e) {
  console.log("EXC:", e.message);
}
rmSync(base, { recursive: true, force: true });
console.log("DONE");
process.exit(0);
