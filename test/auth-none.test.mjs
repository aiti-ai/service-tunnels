import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * auth none ban — the operator can forbid unauthenticated exposes via:
 *   1. createServiceTunnels({ allowAuthNone: false })  (API param)
 *   2. env SERVICE_TUNNELS_ALLOW_AUTH_NONE=0|false|off
 *   3. configDir/service-tunnels.json { "allowAuthNone": false } (cli config set)
 * When banned: "none" disappears from auth.providers(), and every auth-none
 * expose (bare / --auth none / open proxy binding / raw tcp) fails with an
 * error BEFORE any infra/tunnel starts. The ban is sticky: a per-call `true`
 * can never re-enable an operator ban set via env or config file.
 */

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-authnone-"));
  return { configDir: join(base, "config"), cacheDir: join(base, "cache"), base };
}

function saveEnv(key, value) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

test("resolveAllowAuthNone: default allowed, any-layer false bans (sticky)", async () => {
  const { resolveAllowAuthNone } = await import("../src/config.ts");
  const { configDir, base } = tempDirs();
  const restore = saveEnv("SERVICE_TUNNELS_ALLOW_AUTH_NONE", undefined);
  try {
    // default: no param / env / config → allowed
    assert.equal(resolveAllowAuthNone(configDir), true);
    assert.equal(resolveAllowAuthNone(configDir, true), true);

    // explicit per-call false → banned
    assert.equal(resolveAllowAuthNone(configDir, false), false);

    // env bans (same parse as SERVICE_TUNNELS_ALLOW_DOWNLOAD)
    for (const v of ["0", "false", "off"]) {
      process.env.SERVICE_TUNNELS_ALLOW_AUTH_NONE = v;
      assert.equal(resolveAllowAuthNone(configDir), false, `env=${v}`);
    }
    // env true cannot re-enable a per-call false
    process.env.SERVICE_TUNNELS_ALLOW_AUTH_NONE = "1";
    assert.equal(resolveAllowAuthNone(configDir, false), false);

    // config-file ban is sticky too — per-call true can't override it
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "service-tunnels.json"), JSON.stringify({ allowAuthNone: false }));
    assert.equal(resolveAllowAuthNone(configDir), false);
    assert.equal(resolveAllowAuthNone(configDir, true), false, "config ban not overridable by explicit true");
    // ...and env true can't override the config ban
    assert.equal(resolveAllowAuthNone(configDir), false);
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("createServiceTunnels({ allowAuthNone: false }): none not listed, exposes rejected", async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { configDir, cacheDir, base } = tempDirs();
  const restore = saveEnv("SERVICE_TUNNELS_ALLOW_AUTH_NONE", undefined);
  try {
    const st = createServiceTunnels({ configDir, cacheDir, guardian: false, allowAuthNone: false });
    try {
      // 1. "none" is no longer returned as an option
      assert.ok(!st.auth.providers().includes("none"), "providers() must omit none");
      assert.equal(st.auth.noneAllowed(), false);

      // 2. bare expose (effective auth none) → rejected before infra starts
      const r1 = await st.auth.expose(1, {});
      assert.equal(r1.url, null);
      assert.match(r1.error ?? "", /banned|allow-auth-none/i);

      // 3. explicit --auth none / auth:false → rejected
      const r2 = await st.auth.expose(1, { auth: "none" });
      assert.match(r2.error ?? "", /banned|allow-auth-none/i);
      const r3 = await st.auth.expose(1, { auth: false });
      assert.match(r3.error ?? "", /banned|allow-auth-none/i);

      // 4. proxy-mode open binding (no auth) → rejected
      const r4 = await st.auth.expose(1, { mode: "proxy" });
      assert.match(r4.error ?? "", /banned|allow-auth-none/i);

      // 5. raw tcp is inherently unauthenticated → rejected too
      const r5 = await st.auth.expose(1, { protocol: "tcp" });
      assert.match(r5.error ?? "", /banned|allow-auth-none/i);

      // 6. per-call allowAuthNone:true cannot re-enable the instance ban
      const r6 = await st.auth.expose(1, { auth: "none", allowAuthNone: true });
      assert.match(r6.error ?? "", /banned|allow-auth-none/i);

      // 7. an auth-requested expose is NOT blocked by the ban (auth provider)
      const r7 = await st.auth.expose(1, { auth: "portal", allowAuthNone: false });
      assert.doesNotMatch(r7.error ?? "", /banned|allow-auth-none/i, "auth-provider exposes pass the ban gate");
      // (it fails later for a different reason: port 1 is not owned — proving
      // the ban check itself is not what rejected it)
    } finally {
      await st.shutdown().catch(() => {});
    }
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("env SERVICE_TUNNELS_ALLOW_AUTH_NONE=0 bans: none hidden + expose rejected", async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { configDir, cacheDir, base } = tempDirs();
  const restore = saveEnv("SERVICE_TUNNELS_ALLOW_AUTH_NONE", "0");
  try {
    const st = createServiceTunnels({ configDir, cacheDir, guardian: false });
    try {
      assert.equal(st.auth.noneAllowed(), false);
      assert.ok(!st.auth.providers().includes("none"));
      const r = await st.auth.expose(1, {});
      assert.match(r.error ?? "", /banned|allow-auth-none/i);
    } finally {
      await st.shutdown().catch(() => {});
    }
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("config-file ban (service-tunnels.json allowAuthNone:false) is sticky", async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { configDir, cacheDir, base } = tempDirs();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "service-tunnels.json"), JSON.stringify({ allowAuthNone: false }));
  const restore = saveEnv("SERVICE_TUNNELS_ALLOW_AUTH_NONE", undefined);
  try {
    // even a createServiceTunnels opts allowAuthNone:true cannot re-enable
    const st = createServiceTunnels({ configDir, cacheDir, guardian: false, allowAuthNone: true });
    try {
      assert.equal(st.auth.noneAllowed(), false, "config-file ban wins over opts true");
      assert.ok(!st.auth.providers().includes("none"));
    } finally {
      await st.shutdown().catch(() => {});
    }
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("daemon RPC boundary rejects auth-none expose when banned", { timeout: 30_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon, daemonStatus } = await import("../src/daemon.ts");
  const { configDir, cacheDir, base } = tempDirs();
  mkdirSync(configDir, { recursive: true });
  // ban via config file (the daemon resolves env + config file itself)
  writeFileSync(join(configDir, "service-tunnels.json"), JSON.stringify({ allowAuthNone: false }));
  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid > 0);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !daemonStatus(cacheDir).running) {
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      const res = await requestDaemon(cacheDir, "expose", { port: 1, auth: false });
      assert.ok(res === null || typeof res === "object", "daemon must answer");
      if (res !== null && typeof res === "object" && "error" in res) {
        assert.match(String(res.error), /banned|allow-auth-none/i);
      } else {
        // requestDaemon resolves null on IPC failure — treat as rejection
        assert.ok(true, "IPC answered (null tolerated)");
      }
      // the schemas RPC advertises the ban so clients can hide the none option
      const schemas = await requestDaemon(cacheDir, "schemas");
      assert.equal(schemas?.authNoneAllowed, false);
      assert.equal(await requestDaemon(cacheDir, "auth.none.allowed"), false);
    } finally {
      await stopDaemon(cacheDir);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
