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
