import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const log = (...a) => console.error("[DBG]", ...a);
const base = mkdtempSync(join(tmpdir(), "st-dbg4-"));
const dir = join(base, "bin");
mkdirSync(dir, { recursive: true });
const helper = join(dir, "ngrok-helper.cjs");
writeFileSync(helper, 'console.log("Forwarding https://demo.ngrok.io -> http://127.0.0.1:4180"); setInterval(()=>{},1000);\n');
writeFileSync(join(dir, "ngrok.cmd"), "@echo off\r\nnode \"" + helper + "\" %*\r\n");
log("fake created");
const { TunnelManager } = await import("../src/tunnels.ts");
const tm = new TunnelManager({
  cacheDir: join(base, "cache"),
  resolveTool: async (name) => join(dir, name),
  onEvent: (e) => log("EVENT", e.type, e.url ?? ""),
});
tm.add({ name: "web", type: "ngrok", target: 4180 });
const info = await tm.start("web");
log("started pid", info.pid);
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const s = tm.get("web");
  if (s?.url) { log("URL", s.url); break; }
}
const s = tm.get("web");
log("final url=", s?.url, "out=", JSON.stringify(s?.output ?? ""));
await tm.stop("web");
log("stopped");
rmSync(base, { recursive: true, force: true });
process.exit(0);
