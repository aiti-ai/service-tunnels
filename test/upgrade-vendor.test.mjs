// test/upgrade-vendor.test.mjs - vendored upgrade-assistant core sanity (config
// validation, jsonpath, release pointer swap, lock lifecycle) against src sources.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "upgrade", "vendor");

const { loadConfig, stripJsonComments } = require(path.join(vendor, "lib", "config.js"));
const { resolveJsonPath, parseDuration } = require(path.join(vendor, "lib", "util.js"));
const { switchPointer } = require(path.join(vendor, "lib", "swap.js"));
const { writeLock, readLock, clearLock } = require(path.join(vendor, "lib", "state-files.js"));

test("stripJsonComments keeps strings intact", () => {
  assert.equal(stripJsonComments('{ "a": "// not a comment" } // real'), '{ "a": "// not a comment" } ');
});

test("parseDuration units", () => {
  assert.equal(parseDuration("60s", 0), 60000);
  assert.equal(parseDuration("10m", 0), 600000);
  assert.equal(parseDuration(500, 0), 500);
});

test("resolveJsonPath walks nested arrays", () => {
  const obj = { data: { items: [{ name: "x" }] } };
  assert.equal(resolveJsonPath(obj, "$.data.items[0].name"), "x");
  assert.equal(resolveJsonPath({ v: "2.0.0" }, "$.v"), "2.0.0");
});

test("config validation collects ALL problems (fail-fast list)", () => {
  const file = path.join(os.tmpdir(), `ua-cfg-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ parent: { port: 0 }, upgrade: { verify: { type: "bogus" } } }));
  try {
    assert.throws(() => loadConfig(file), (e) => {
      const msg = String(e.message);
      return msg.includes('"parent.port"') && msg.includes('"upgrade.verify.type"');
    });
  } finally {
    fs.unlinkSync(file);
  }
});

test("config with comments loads and resolves paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ua-cfg-ok-"));
  const file = path.join(dir, "upgrade.json");
  fs.mkdirSync(path.join(dir, "rel", "v1"), { recursive: true });
  fs.writeFileSync(file, [
    "{",
    '  // launch.json style comment',
    '  "parent": { "port": 39081, "start": { "cmd": "node", "cwd": "rel/dir" } },',
    '  "upgrade": { "target": "2.0.0", "releases": { "1.0.0": "rel/v1", "2.0.0": "rel/v1" }, "current": "rel/current",',
    '    "verify": { "url": "http://127.0.0.1:39081/health", "type": "jsonPath", "jsonPath": "$.version", "expect": "2.0.0" } }',
    "}",
  ].join("\n"));
  try {
    const { cfg } = loadConfig(file);
    assert.equal(cfg.parent.port, 39081);
    assert.ok(path.isAbsolute(cfg.parent.start.cwd), "cwd resolved to absolute");
    assert.ok(path.isAbsolute(cfg.upgrade.current), "current pointer resolved to absolute");
    assert.equal(cfg.assistant.selfStopDelayMs, 60000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("switchPointer flips and restores (symlink)", () => {
  if (process.platform === "win32") return; // junction path covered on Windows machines
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ua-swap-"));
  const v1 = path.join(dir, "v1");
  const v2 = path.join(dir, "v2");
  const current = path.join(dir, "current");
  fs.mkdirSync(v1);
  fs.mkdirSync(v2);
  fs.writeFileSync(path.join(v1, "version.txt"), "1.0.0");
  fs.writeFileSync(path.join(v2, "version.txt"), "2.0.0");
  fs.symlinkSync(v1, current, "dir");
  const up = switchPointer(current, v2, "auto");
  assert.equal(up.mode, "symlink");
  assert.equal(fs.readFileSync(path.join(fs.realpathSync(current), "version.txt"), "utf8"), "2.0.0");
  switchPointer(current, v1, "auto");
  assert.equal(fs.readFileSync(path.join(fs.realpathSync(current), "version.txt"), "utf8"), "1.0.0");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lock write/read/clear roundtrip", () => {
  writeLock({ phase: "UPGRADE", state: "run" });
  const lock = readLock();
  assert.equal(lock.phase, "UPGRADE");
  assert.equal(typeof lock.pid, "number");
  clearLock();
  assert.equal(readLock(), null);
});

test("verify rejects 503 slow-start bodies (jsonPath also requires 2xx)", { timeout: 30_000 }, async () => {
  // full manual-form mini drill: the mock answers 503 {version:"2.0.0"} for
  // 800ms (slow-start window) then 200 - the verifier must NOT accept the 503s
  // (regression: jsonPath used to pass on a 503 body that already carried expect)
  const MOCK_SRC = 'const http=require("http");const port=parseInt(process.env.MOCK_PORT,10);const born=Date.now();' +
    'http.createServer((req,res)=>{const slow=Date.now()-born<800;' +
    'res.writeHead(slow?503:200,{"content-type":"application/json"});' +
    'res.end(JSON.stringify({version:"2.0.0"}));}).listen(port,"127.0.0.1");';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ua-verify-"));
  const v1 = path.join(dir, "releases", "v1.0.0");
  const v2 = path.join(dir, "releases", "v2.0.0");
  const current = path.join(dir, "releases", "current");
  fs.mkdirSync(v1, { recursive: true });
  fs.mkdirSync(v2, { recursive: true });
  fs.writeFileSync(path.join(v1, "version.txt"), "1.0.0");
  fs.writeFileSync(path.join(v2, "version.txt"), "2.0.0");
  fs.symlinkSync(v1, current, "dir");

  const cfgFile = path.join(dir, "upgrade.json");
  fs.writeFileSync(cfgFile, JSON.stringify({
    parent: { port: 0, start: { cmd: process.execPath, args: ["-e", MOCK_SRC], cwd: "releases/current" } },
    upgrade: {
      target: "2.0.0",
      swap: "auto",
      releases: { "1.0.0": "releases/v1.0.0", "2.0.0": "releases/v2.0.0" },
      current: "releases/current",
      verify: { url: "http://127.0.0.1:0/health", type: "jsonPath", jsonPath: "$.version", expect: "2.0.0", timeout: "15s", interval: "300ms" },
    },
    // keep the DONE observation window short - the test asserts verify semantics,
    // not the countdown
    assistant: { selfStopDelay: "1s" },
  }));
  // port 0 in the written file is a placeholder - patch the real ports in after binding
  const { spawn } = require("node:child_process");

  const { createPlugins } = require(path.join(vendor, "lib", "plugins", "index.js"));
  const { createLog } = require(path.join(vendor, "lib", "log.js"));
  const { createOrchestrator } = require(path.join(vendor, "lib", "orchestrate.js"));

  // boot the "old parent" mock on a real port first (config carries the same port)
  const pickPort = await new Promise((resolve) => {
    const s = require("node:http").createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const cfgRaw = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfgRaw.parent.port = pickPort;
  cfgRaw.parent.start.env = { MOCK_PORT: String(pickPort) };
  cfgRaw.upgrade.verify.url = `http://127.0.0.1:${pickPort}/health`;
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw));

  const runDir = path.join(dir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const cfg = loadConfig(cfgFile).cfg;
  const log = createLog(runDir);
  const plugins = createPlugins({ log: { log() {} }, assistantRoot: vendor, onConsole: () => {}, ptyModule: null });
  const manager = plugins.byId.manual;

  // start the old parent the way the real flow expects (already listening)
  const oldParent = spawn(process.execPath, ["-e", MOCK_SRC], { stdio: "ignore", env: { ...process.env, MOCK_PORT: String(pickPort) } });
  await new Promise((r) => setTimeout(r, 400));

  try {
    const orch = createOrchestrator({
      cfg, log, manager, plugins, availability: {}, runDir, ptyModule: null,
      urls: [], exposeCleanup: null, assistantMeta: {},
    });
    orch.armMaxRuntime && orch.armMaxRuntime(120000);
    await orch.runUpgrade();
    assert.equal(orch.orch.finalState, "DONE", `finalState=${orch.orch.finalState} err=${orch.orch.error}`);
    // the slow-start window must have produced at least one REJECTED 503 attempt
    assert.ok(orch.orch.lastVerify.n >= 2, `verify attempts=${orch.orch.lastVerify.n} (503 was wrongly accepted)`);
    assert.equal(orch.orch.lastVerify.code, 200);
  } finally {
    try { oldParent.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
