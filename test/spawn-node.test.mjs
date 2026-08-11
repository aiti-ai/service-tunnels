import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnNode, isElectronRuntime } from "../src/spawn-node.ts";

test("spawnNode: runs an ESM script and preserves opts.env (portal/token path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-spawn-"));
  const script = join(dir, "t.mjs");
  writeFileSync(script, `console.log("VAL:" + process.env.MY_VAR + ":" + process.env.PORT);`);
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawnNode(undefined, [script], { env: { ...process.env, MY_VAR: "hello", PORT: "4123" } });
      let s = "";
      child.stdout?.on("data", (d) => (s += String(d)));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(s) : reject(new Error(`exit ${code}`))));
    });
    assert.match(out, /VAL:hello:4123/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnNode: explicit nodePath override wins over process.execPath", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-spawn-"));
  const script = join(dir, "t.mjs");
  writeFileSync(script, `console.log("OK");`);
  try {
    const out = await new Promise((resolve, reject) => {
      // passing process.execPath explicitly must behave identically
      const child = spawnNode(process.execPath, [script], {});
      let s = "";
      child.stdout?.on("data", (d) => (s += String(d)));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(s) : reject(new Error(`exit ${code}`))));
    });
    assert.match(out, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isElectronRuntime: inherits ELECTRON_RUN_AS_NODE (daemon-child path)", () => {
  const prev = process.env.ELECTRON_RUN_AS_NODE;
  try {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    assert.equal(isElectronRuntime(), true);
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prev;
  }
});
