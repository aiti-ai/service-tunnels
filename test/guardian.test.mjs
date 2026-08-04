import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadGuardian() {
  return import("../src/guardian.ts");
}
async function loadSpawn() {
  return import("../src/guardian-spawn.ts");
}

function entry() {
  return join(import.meta.dirname, "..", "src", "guardian.ts");
}

/** Count processes carrying SERVICE_TUNNELS_ROLE in /proc. */
function roleProcessCount() {
  try {
    return readFileSync("/dev/null"); // keep import
  } catch {
    return 0;
  }
}
import { readdirSync } from "node:fs";
/** Count role-marked processes belonging to OUR marker (other instances in
 *  parallel test files have different markers and are excluded). */
function countRoleProcs(marker) {
  let n = 0;
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (env.includes("SERVICE_TUNNELS_ROLE=") && env.includes(`SERVICE_TUNNELS_MARKER=${marker}`)) n++;
    } catch {
      // ignore
    }
  }
  return n;
}

test("parentAlive: own pid is alive; nonexistent pid is dead", async () => {
  const { parentAlive, readStarttime } = await loadGuardian();
  assert.equal(parentAlive(process.pid, readStarttime(process.pid)), true);
  assert.equal(parentAlive(999999, ""), false);
});

test("guardian reaps role-marked helpers when the watched parent dies", { timeout: 30_000 }, async () => {
  if (process.platform !== "linux") return;
  const { spawnGuardian } = await loadSpawn();

  // instance marker: guardian only reaps helpers with OUR marker (parallel
  // test files / other instances are never touched)
  const marker = `test-${process.pid}-${Date.now().toString(36)}`;
  process.env.SERVICE_TUNNELS_MARKER = marker;
  const env = { ...process.env, SERVICE_TUNNELS_MARKER: marker };

  // a fake parent process that will be killed
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env });

  // spawn a role-marked helper (simulates nginx/authelia/tunnel)
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    env: { ...env, SERVICE_TUNNELS_ROLE: "nginx" },
  });

  // guardian watching the fake parent (inherits the marker via process.env)
  spawnGuardian(parent.pid ?? 0, { intervalMs: 300 });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(countRoleProcs(marker) >= 1, true, "helper should exist before cleanup");

  try {
    // kill the parent → guardian should reap the helper within a few seconds
    parent.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    let helperAlive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(helper.pid ?? 0, 0);
        helperAlive = true;
      } catch {
        helperAlive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(helperAlive, false, "helper should be reaped after parent death");
    // the role-marked helper count for OUR marker should drop back
    const remaining = countRoleProcs(marker);
    assert.equal(remaining, 0, `role procs left: ${remaining}`);
  } finally {
    parent.kill("SIGKILL");
    helper.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 600));
  }
});

test("guardian does NOT reap when the parent is alive", { timeout: 15_000 }, async () => {
  if (process.platform !== "linux") return;
  const { spawnGuardian } = await loadSpawn();
  const marker = `test2-${process.pid}-${Date.now().toString(36)}`;
  const env = { ...process.env, SERVICE_TUNNELS_MARKER: marker };
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env });
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    env: { ...env, SERVICE_TUNNELS_ROLE: "redis" },
  });
  const prevMarker = process.env.SERVICE_TUNNELS_MARKER;
  process.env.SERVICE_TUNNELS_MARKER = marker;
  spawnGuardian(parent.pid ?? 0, { intervalMs: 300 });
  await new Promise((r) => setTimeout(r, 1_200));
  if (prevMarker) process.env.SERVICE_TUNNELS_MARKER = prevMarker;
  try {
    process.kill(helper.pid ?? 0, 0);
    assert.equal(true, true, "helper still alive while parent alive");
  } catch {
    assert.fail("helper was killed while parent alive");
  } finally {
    parent.kill("SIGKILL");
    helper.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 800));
  }
});
