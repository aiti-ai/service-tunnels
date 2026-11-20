import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  return import("../src/daemon.ts");
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-daemon-"));
  return {
    cacheDir: join(base, "cache"),
    configDir: join(base, "config"),
    base,
  };
}

test("start → IPC ping → stop lifecycle", { timeout: 30_000 }, async () => {
  const { startDaemon, daemonStatus, stopDaemon, requestDaemon, pidAlive } = await loadSubject();
  const { cacheDir, base } = tempDirs();

  try {
    const started = startDaemon(cacheDir);
    assert.ok(started.pid && started.pid > 0, "daemon should spawn");

    // state.json appears with the daemon's IPC address
    const deadline = Date.now() + 5_000;
    let state = null;
    while (Date.now() < deadline) {
      const f = join(cacheDir, "state.json");
      if (existsSync(f)) {
        state = JSON.parse(readFileSync(f, "utf8"));
        if (state.daemon?.ipc) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(state?.daemon?.ipc, "state.json should record daemon ipc");
    // unix socket on POSIX, TCP on Windows (no unix sockets there)
    if (process.platform === "win32") {
      assert.match(state.daemon.ipc, /^tcp:\/\/127\.0\.0\.1:/, `ipc=${state.daemon.ipc}`);
    } else {
      assert.ok(state.daemon.ipc.startsWith("unix://"), `ipc=${state.daemon.ipc}`);
    }

    // status reflects the running daemon
    const status = daemonStatus(cacheDir);
    assert.equal(status.running, true);
    assert.equal(status.pid, started.pid);
    assert.ok(pidAlive(started.pid));

    // JSON-RPC round trip
    const pong = await requestDaemon(cacheDir, "ping");
    assert.deepEqual(pong, { pong: true, pid: started.pid });

    // discover through the daemon returns an array
    const ports = await requestDaemon(cacheDir, "discover");
    assert.ok(Array.isArray(ports));

    // graceful stop
    const stopped = await stopDaemon(cacheDir);
    assert.equal(stopped, true);
    assert.equal(daemonStatus(cacheDir).running, false);
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("start is idempotent when already running", { timeout: 30_000 }, async () => {
  const { startDaemon, daemonStatus, stopDaemon } = await loadSubject();
  const { cacheDir, base } = tempDirs();

  try {
    const first = startDaemon(cacheDir);
    // wait until really up
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !daemonStatus(cacheDir).running) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const second = startDaemon(cacheDir);
    assert.equal(second.pid, first.pid, "second start should reuse the running daemon");
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("stop returns false when no daemon is running", async () => {
  const { stopDaemon, daemonStatus } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    assert.equal(daemonStatus(cacheDir).running, false);
    assert.equal(await stopDaemon(cacheDir), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("upgrade assistant RPC: upgrade.status / upgrade.run gate / service.action gate", { timeout: 30_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon } = await loadSubject();
  const { cacheDir, base } = tempDirs();

  try {
    await startDaemon(cacheDir);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(join(cacheDir, "state.json"))) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // status: always a well-formed snapshot, even with no assistant runs
    const st = await requestDaemon(cacheDir, "upgrade.status");
    assert.equal(typeof st.running, "boolean");
    assert.ok("lock" in st && "lastReport" in st);

    // run: confirmation/argument gate fires before anything spawns
    const noArgs = await requestDaemon(cacheDir, "upgrade.run", {});
    assert.match(String(noArgs.error), /config required/);

    // service.action: verb/config gate
    const noVerb = await requestDaemon(cacheDir, "service.action", {});
    assert.match(String(noVerb.error), /verb and config required/);

    // stop gate: no lock -> explicit refusal
    const noStop = await requestDaemon(cacheDir, "upgrade.stop");
    assert.equal(noStop.stopped, false);
    assert.match(String(noStop.error), /no active assistant run/);
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("upgrade.stop posts /shutdown to the live assistant (token gated)", { timeout: 30_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon } = await loadSubject();
  const { cacheDir, base } = tempDirs();

  // sandbox HOME so the daemon's upgrade.stop reads a controlled lock.json
  // (HOME+USERPROFILE both - the red line for sandboxed homes)
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  const home = join(base, "home");
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // fake assistant: the management API surface the status page drives
  const TOKEN = "tok-rpc-stop-test";
  let seenToken = null;
  const fakeAssist = createServer((req, res) => {
    seenToken = req.headers["x-assistant-token"] ?? null;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ mode: "stopped" }));
  });
  await new Promise((r) => fakeAssist.listen(0, "127.0.0.1", r));
  const port = fakeAssist.address().port;

  const runDir = join(home, ".svc-assistant", "run-test");
  mkdirSync(join(runDir), { recursive: true });
  writeFileSync(join(home, ".svc-assistant", "lock.json"), JSON.stringify({ pid: process.pid, port, runDir }));
  writeFileSync(join(runDir, ".assistant-token"), TOKEN);

  try {
    await startDaemon(cacheDir);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(join(cacheDir, "state.json"))) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const r = await requestDaemon(cacheDir, "upgrade.stop");
    assert.equal(r.stopped, true, JSON.stringify(r));
    assert.equal(r.mode, "stopped");
    assert.equal(seenToken, TOKEN, "token must ride the x-assistant-token header");
  } finally {
    fakeAssist.close();
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("service.action: real status verb through the daemon (manual byPort)", { timeout: 30_000 }, async () => {
  const { startDaemon, stopDaemon, requestDaemon } = await loadSubject();
  const { cacheDir, base } = tempDirs();

  // mock listener the manual plugin's byPort status probe can find
  const mock = createServer(() => {});
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;

  const cfgPath = join(base, "svc-rpc-status.json");
  writeFileSync(cfgPath, JSON.stringify({
    parent: { port },
    service: { manager: "manual", name: "t-rpc-status" },
    // serviceAction validates the full config shape - the upgrade block is
    // unused for the status verb but must validate (target + verify probe)
    upgrade: { target: "1.0.0", verify: { url: `http://127.0.0.1:${port}/`, type: "status" } },
  }));

  try {
    await startDaemon(cacheDir);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(join(cacheDir, "state.json"))) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const up = await requestDaemon(cacheDir, "service.action", { verb: "status", config: cfgPath });
    assert.equal(up.verb, "status");
    assert.equal(up.manager, "manual");
    assert.equal(up.status, "running", JSON.stringify(up));

    await new Promise((r) => mock.close(r));
    const down = await requestDaemon(cacheDir, "service.action", { verb: "status", config: cfgPath });
    assert.equal(down.status, "stopped", JSON.stringify(down));
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI daemon call bridges RPC methods for embedders", { timeout: 30_000 }, async () => {
  const { startDaemon, stopDaemon } = await loadSubject();
  const { cacheDir, configDir, base } = tempDirs();
  const bin = join(import.meta.dirname, "..", "src", "cli.ts");
  const run = (args) =>
    new Promise((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile(process.execPath, [bin, ...args, "--config-dir", configDir, "--cache-dir", cacheDir], (err, stdout) => {
          resolve({ err, stdout: String(stdout) });
        });
      });
    });

  try {
    await startDaemon(cacheDir);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(join(cacheDir, "state.json"))) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const out = await run(["daemon", "call", "upgrade.status"]);
    assert.equal(out.err, null, out.stdout);
    const j = JSON.parse(out.stdout);
    assert.equal(typeof j.running, "boolean", out.stdout);

    // params ride through as JSON
    const gated = await run(["daemon", "call", "upgrade.run", "--params", "{}"]);
    assert.equal(gated.err, null);
    assert.match(String(JSON.parse(gated.stdout).error), /config required/);

    // unknown daemon -> null (caller falls back to its own paths)
    const dead = await run(["daemon", "call", "ping"]);
    assert.equal(dead.err, null);
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI status/discover round-trip via bin", { timeout: 30_000 }, async () => {
  const { startDaemon, stopDaemon } = await loadSubject();
  const { cacheDir, configDir, base } = tempDirs();
  const bin = join(import.meta.dirname, "..", "src", "cli.ts");
  const run = (args) =>
    new Promise((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile(process.execPath, [bin, ...args, "--config-dir", configDir, "--cache-dir", cacheDir], (err, stdout) => {
          resolve({ err, stdout: String(stdout) });
        });
      });
    });

  try {
    await startDaemon(cacheDir);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(join(cacheDir, "state.json"))) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const statusOut = await run(["status"]);
    assert.equal(statusOut.err, null);
    const status = JSON.parse(statusOut.stdout);
    assert.equal(status.daemon.running, true, statusOut.stdout);

    const discoverOut = await run(["discover"]);
    assert.equal(discoverOut.err, null);
    assert.ok(Array.isArray(JSON.parse(discoverOut.stdout)));

    const configOut = await run(["config", "path"]);
    assert.ok(configOut.stdout.includes(cacheDir));
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});
