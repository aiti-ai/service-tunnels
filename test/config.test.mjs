import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  return import("../src/config.ts");
}

test("resolves default config/cache dirs", async () => {
  const { resolveDirs, defaultConfigDir, defaultCacheDir } = await loadSubject();
  const dirs = resolveDirs({});
  assert.equal(dirs.configDir, defaultConfigDir());
  assert.equal(dirs.cacheDir, defaultCacheDir());
  assert.equal(dirs.configDir, join(homedir(), ".config", "service-tunnels"));
  assert.equal(dirs.cacheDir, join(homedir(), ".cache", "service-tunnels"));
});

test("env vars override defaults", async () => {
  const { resolveDirs } = await loadSubject();
  process.env.SERVICE_TUNNELS_CONFIG = "/tmp/env-config";
  process.env.SERVICE_TUNNELS_CACHE = "/tmp/env-cache";
  try {
    const dirs = resolveDirs({});
    assert.equal(dirs.configDir, "/tmp/env-config");
    assert.equal(dirs.cacheDir, "/tmp/env-cache");
  } finally {
    delete process.env.SERVICE_TUNNELS_CONFIG;
    delete process.env.SERVICE_TUNNELS_CACHE;
  }
});

test("constructor args beat env vars", async () => {
  const { resolveDirs } = await loadSubject();
  process.env.SERVICE_TUNNELS_CONFIG = "/tmp/env-config";
  try {
    const dirs = resolveDirs({ configDir: "/tmp/opt-config" });
    assert.equal(dirs.configDir, "/tmp/opt-config");
    assert.equal(dirs.cacheDir, join(homedir(), ".cache", "service-tunnels"));
  } finally {
    delete process.env.SERVICE_TUNNELS_CONFIG;
  }
});

test("empty constructor values fall back to env/defaults", async () => {
  const { resolveDirs } = await loadSubject();
  const dirs = resolveDirs({ configDir: "  " });
  assert.equal(dirs.configDir, join(homedir(), ".config", "service-tunnels"));
});

test("cachePaths exposes sub-directories + state/daemon files", async () => {
  const { cachePaths } = await loadSubject();
  const p = cachePaths("/tmp/st-cache");
  assert.deepEqual(Object.keys(p).sort(), ["bin", "daemonSock", "data", "stateFile", "tmp"].sort());
  assert.equal(p.stateFile, join("/tmp/st-cache", "state.json"));
  assert.equal(p.daemonSock, join("/tmp/st-cache", "daemon.sock"));
});
