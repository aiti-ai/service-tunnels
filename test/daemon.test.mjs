import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
