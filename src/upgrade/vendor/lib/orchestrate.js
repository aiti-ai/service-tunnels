// lib/orchestrate.js - nine-step orchestration state machine (plan §3.5).
//
//   PREPARE -> SWAP_ASS -> SHOW_ACCESS -> STOP_PARENT -> UPGRADE -> RESTART_PARENT
//   -> VERIFY -> DONE -> STOP_ASS      (failure -> ROLLBACK -> verify again -> FAILED?)
//
// The assistant is on stage BEFORE the parent stops (SWAP_ASS/SHOW_ACCESS touch nothing
// of the parent); upgrade commands run inside the downtime window.
"use strict";

const { runCommand, stopByPort, writeParentInput } = require("./proc");
const { switchPointer, currentTarget } = require("./swap");
const { parseDuration, sleep, isAlive, findPidByPort, ts } = require("./util");
const { writeLock, clearLock, writeHistory } = require("./state-files");

const PHASES = ["PREPARE", "SWAP_ASS", "SHOW_ACCESS", "STOP_PARENT", "UPGRADE", "RESTART_PARENT", "VERIFY", "DONE", "STOP_ASS"];

class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
class AbortError extends Error {
  constructor() { super("abort requested"); this.aborted = true; }
}

function createOrchestrator(deps) {
  // deps: { cfg, log, manager, plugins, availability, runDir, ptyModule, urls, exposeCleanup, assistantMeta }
  const { cfg, log } = deps;
  const manualForm = !!cfg.parent.start;
  const svcName = cfg.service && cfg.service.name;
  const dirMode = !!(cfg.upgrade.releases && cfg.upgrade.current);

  const orch = {
    running: false,
    phase: "ARMED",           // ARMED | <phase> | ROLLBACK | DONE | ROLLBACK-OK | FAILED | STOPPING
    abortRequested: false,
    selfStopAt: null,
    parentInfo: { name: null, version: null, pid: null, port: cfg.parent.port, mode: null, healthy: false, monitor: "off" },
    oldRelease: null,
    startedAt: ts(),
    finalState: null,
    error: null,
    lastVerify: null,
    apiErrorClass: ApiError,
    resumeIdx: -1, // --resume: replay phases with main-step index below this
  };

  const onConsole = (src, line) => deps.onConsole ? deps.onConsole(src, line) : log.consoleLine(src, line);

  function serviceSpec() {
    // spec passed to plugin methods (manual plugin consumes it; others ignore)
    if (manualForm) {
      const s = cfg.parent.start;
      return { name: s.name || "parent", cmd: s.cmd, args: s.args, cwd: s.cwd, env: s.env, port: cfg.parent.port, pty: s.pty };
    }
    const sv = cfg.service || {};
    return {
      name: svcName, port: cfg.parent.port,
      cmd: sv.start && sv.start.cmd, args: sv.start && sv.start.args, cwd: sv.start && sv.start.cwd, env: sv.start && sv.start.env,
    };
  }

  async function waitPortFree(port, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 10000);
    while (Date.now() < deadline) {
      const pid = await findPidByPort(port);
      if (!pid) return true;
      await sleep(200);
    }
    return false;
  }

  async function fetchParentVersion(timeoutMs = 2500) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(`http://127.0.0.1:${cfg.parent.port}/`, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const j = await res.json();
      return j && j.version ? String(j.version) : null;
    } catch (_) {
      return null;
    }
  }

  async function startParent() {
    const spec = serviceSpec();
    if (manualForm) {
      // manual form: parent is reborn as the assistant's own child (plan §3.2)
      const { spawnParent } = require("./proc");
      const s = cfg.parent.start;
      const p = spawnParent({ cmd: s.cmd, args: s.args, cwd: s.cwd, env: s.env, pty: s.pty }, onConsole, deps.ptyModule);
      orch.parentInfo.pid = p.pid;
      orch.parentInfo.mode = `manual·child (${p.mode}${deps.ptyModule && s.pty ? "" : ", no-pty"})`;
      log.log("info", `parent spawned: pid=${p.pid} mode=${p.mode}`);
      return { pid: p.pid };
    }
    if (cfg.service.manager === undefined && cfg.service.start) {
      // direct-command service form: start via detached spawn (commands are one-shot verbs)
      const { spawnParent } = require("./proc");
      const p = spawnParent(cfg.service.start, onConsole, deps.ptyModule);
      orch.parentInfo.pid = p.pid;
      orch.parentInfo.mode = "direct-cmd";
      return { pid: p.pid };
    }
    const r = await deps.manager.start(svcName, spec);
    orch.parentInfo.pid = (r && r.pid) || null;
    orch.parentInfo.mode = `service:${deps.manager.id}`;
    log.log("info", `parent restarted: pid=${orch.parentInfo.pid} via ${deps.manager.id}`);
    return r;
  }

  async function stopParentNow() {
    const manager = deps.manager;
    const spec = serviceSpec();
    const stop = cfg.parent.stop || { type: "byPort", graceMs: 5000 };
    if (!manualForm && cfg.service.manager === undefined && cfg.service.stop) {
      const r = await runCommand({ cmd: cfg.service.stop.cmd, args: cfg.service.stop.args, cwd: cfg.service.stop.cwd, pty: false, ptyModule: deps.ptyModule }, onConsole);
      if (r.code !== 0) throw new Error(`service stop command failed: exit=${r.code}`);
    } else if (!manualForm) {
      await manager.stop(svcName, spec);
    } else if (stop.type === "cmd") {
      const r = await runCommand({ cmd: stop.cmd, args: stop.args, cwd: stop.cwd, pty: false, ptyModule: deps.ptyModule }, onConsole);
      if (r.code !== 0) throw new Error(`parent stop command failed: exit=${r.code}`);
    } else {
      const r = await stopByPort(cfg.parent.port, stop.graceMs, onConsole);
      // first run / already stopped: "no listener" is a fine pre-upgrade state, not an error
      if (!r.stopped && r.reason !== "no listener") throw new Error(`stopByPort failed: ${r.reason}`);
      if (!r.stopped) log.log("info", "parent not running before upgrade (nothing to stop)");
    }
    const free = await waitPortFree(cfg.parent.port, 10000);
    if (!free) log.log("warn", `port ${cfg.parent.port} still listening after stop (continuing)`);
    orch.parentInfo.pid = null;
    orch.parentInfo.healthy = false;
  }

  // verify loop; expectOverride only used for post-rollback health re-check
  async function verifyLoop(label, healthOnly) {
    const v = cfg.upgrade.verify;
    const deadline = Date.now() + v.timeoutMs;
    let n = 0;
    for (;;) {
      n++;
      const t0 = Date.now();
      let code = null, extracted = null, ok = false, body = null;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5000);
        const res = await fetch(v.url, { signal: ctl.signal });
        clearTimeout(t);
        code = res.status;
        body = await res.text();
        if (healthOnly) {
          ok = res.status >= 200 && res.status < 300;
        } else if (v.type === "status") {
          ok = res.status >= 200 && res.status < 300;
        } else if (v.type === "jsonPath") {
          const { resolveJsonPath } = require("./util");
          const j = JSON.parse(body);
          extracted = resolveJsonPath(j, v.jsonPath);
          // 2xx required: slow-start endpoints answer 503 with a body that may
          // already carry the expected field - that is NOT a healthy service
          ok = res.status >= 200 && res.status < 300 && String(extracted) === String(v.expect);
        } else if (v.type === "textContains") {
          extracted = body.includes(v.expect) ? v.expect : null;
          ok = res.status >= 200 && res.status < 300 && body.includes(v.expect);
        }
      } catch (e) {
        code = code || 0;
      }
      const ms = Date.now() - t0;
      const entry = log.verify({ n, label: label || "verify", code, ms, extracted, ok, expect: healthOnly ? "2xx" : v.expect });
      orch.lastVerify = entry;
      if (ok) return entry;
      if (Date.now() >= deadline) {
        const err = new Error(`verify failed after ${n} attempts in ${v.timeoutMs}ms (last: code=${code} extracted=${JSON.stringify(extracted)} expect=${healthOnly ? "2xx" : v.expect})`);
        err.verifyAttempts = n;
        throw err;
      }
      await sleep(v.intervalMs);
    }
  }

  async function runRollbackCommands() {
    const cmds = cfg.upgrade.rollbackCommands || [];
    if (!cmds.length) throw new Error("no rollbackCommands configured for in-place mode");
    for (const c of cmds) {
      onConsole("assistant", `$ ${c.cmd} ${(c.args || []).join(" ")}  (rollback)`);
      const r = await runCommand({ cmd: c.cmd, args: c.args, cwd: c.cwd, env: c.env, pty: c.pty, ptyModule: deps.ptyModule }, onConsole);
      if (r.code !== 0 || r.timedOut) throw new Error(`rollbackCommand failed (${c.cmd}): exit=${r.code}${r.timedOut ? " (timeout)" : ""}`);
    }
  }

  function setPhase(phase, overall) {
    if (overall) orch.phase = overall;
  }

  const MAIN_STEP_IDX = { STOP_PARENT: 0, UPGRADE: 1, RESTART_PARENT: 2, VERIFY: 3 };

  async function step(phase, fn) {
    // resume: phases recorded as already-run in the leftover lock are replayed as done
    const mainIdx = MAIN_STEP_IDX[phase];
    if (mainIdx !== undefined && orch.resumeIdx >= 0 && mainIdx < orch.resumeIdx) {
      log.phaseSet(phase, "done", "replayed by resume", Date.now());
      return;
    }
    if (orch.abortRequested) throw new AbortError();
    const t0 = Date.now();
    log.phaseSet(phase, "run", null, t0);
    setPhase(phase, phase);
    writeLock({ phase, state: "run" });
    try {
      const detail = await fn();
      log.phaseSet(phase, "done", detail, t0);
      return detail;
    } catch (e) {
      log.phaseSet(phase, "fail", e.message, t0);
      throw e;
    }
  }

  async function doRollback(reason) {
    log.log("err", `ROLLBACK triggered: ${reason}`);
    orch.phase = "ROLLBACK";
    const t0 = Date.now();
    log.phaseSet("ROLLBACK", "run", reason, t0);
    writeLock({ phase: "ROLLBACK", state: "run" });
    try {
      if (dirMode) {
        const target = orch.oldRelease;
        if (target) {
          const r = switchPointer(cfg.upgrade.current, target, cfg.upgrade.swap);
          log.log("ok", `rollback SWAP: ${cfg.upgrade.current} -> ${target} (mode=${r.mode})`);
        } else {
          log.log("warn", "no old release recorded; skipping pointer swap");
        }
      } else {
        await runRollbackCommands();
      }
      // stop whatever is running before restarting (a v2 parent would hold the port
      // and the rolled-back child would die on bind - found in rehearsal 2b)
      await stopParentNow();
      await startParent();
      await verifyLoop("rollback", true); // health-only: old version won't match the new-version expect
      log.phaseSet("ROLLBACK", "done", "rolled back and parent healthy", t0);
      return true;
    } catch (e) {
      log.phaseSet("ROLLBACK", "fail", e.message, t0);
      log.log("err", `rollback itself failed: ${e.message}`);
      return false;
    }
  }

  // ---- crash monitor (manual form; plan §3.2: parent becomes assistant's ward) ----
  let monitorTimer = null;
  let restartTimes = [];
  function startMonitor() {
    if (!manualForm || monitorTimer) return;
    orch.parentInfo.monitor = "on";
    monitorTimer = setInterval(async () => {
      // crash heal: pid gone or port silent -> respawn (T4)
      const alive = orch.parentInfo.pid ? isAlive(orch.parentInfo.pid) : false;
      const listening = await findPidByPort(cfg.parent.port);
      if (!alive || !listening) {
        const now = Date.now();
        restartTimes = restartTimes.filter((t) => now - t < 60000);
        if (restartTimes.length >= 3) {
          log.log("err", `parent keeps crashing (${restartTimes.length} restarts in 60s) - giving up auto-heal`);
          return;
        }
        restartTimes.push(now);
        log.log("warn", `parent died (pidAlive=${alive} listening=${!!listening}) - auto-restarting`);
        onConsole("assistant", "[monitor] parent died - respawning");
        try {
          await startParent();
        } catch (e) {
          log.log("err", `auto-restart failed: ${e.message}`);
        }
        return;
      }
      orch.parentInfo.healthy = true;
      const v = await fetchParentVersion();
      if (v) orch.parentInfo.version = v;
    }, 3000);
  }
  function stopMonitor() {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    orch.parentInfo.monitor = "off";
  }

  // ---- main flow ----
  async function runUpgrade() {
    if (orch.running) throw new ApiError(409, "upgrade already running");
    orch.running = true;
    orch.abortRequested = false;
    orch.finalState = null;
    orch.error = null;
    log.log("info", `upgrade triggered (target ${cfg.upgrade.target}, mode=${dirMode ? "dir-swap" : "in-place"}${orch.resumeIdx >= 0 ? ", resuming" : ""})`);
    try {
      await step("STOP_PARENT", async () => {
        onConsole("assistant", `── stopping parent (form=${manualForm ? "manual" : `service:${deps.manager.id}`}) ──`);
        await stopParentNow();
        return `port ${cfg.parent.port} free`;
      });

      await step("UPGRADE", async () => {
        onConsole("assistant", `── downtime window: upgrade commands ──`);
        for (const c of cfg.upgrade.preCommands || []) {
          if (orch.abortRequested) throw new AbortError();
          onConsole("assistant", `$ ${c.cmd} ${(c.args || []).join(" ")}`);
          const r = await runCommand({ cmd: c.cmd, args: c.args, cwd: c.cwd, env: c.env, pty: c.pty, ptyModule: deps.ptyModule }, onConsole);
          if (r.timedOut) throw new Error(`preCommand timed out: ${c.cmd}`);
          if (r.code !== 0) {
            throw new Error(`preCommand failed: ${c.cmd} (exit=${r.code}${r.spawnError ? `, ${r.spawnError}` : ""}${c.cwd ? `, cwd=${c.cwd}` : ""})`);
          }
        }
        if (dirMode) {
          orch.oldRelease = currentTarget(cfg.upgrade.current);
          const r = switchPointer(cfg.upgrade.current, cfg.upgrade.releases[cfg.upgrade.target], cfg.upgrade.swap);
          log.log("ok", `SWAP: ${cfg.upgrade.current} -> ${r.to} (mode=${r.mode}, was ${r.from || "none"})`);
        }
        // S3: env changes (e.g. SERVICE_TUNNELS_EXPOSE) written straight into the service
        if (!manualForm && cfg.service.env && deps.manager.id !== "manual") {
          const spec = cfg.service.install || serviceSpec();
          const r = await deps.manager.updateEnv(svcName, cfg.service.env, spec);
          log.log("ok", `service env updated via ${deps.manager.id}: ${Object.keys(cfg.service.env).join(", ")} (${JSON.stringify(r)})`);
        }
        return `target=${cfg.upgrade.target}`;
      });

      await step("RESTART_PARENT", async () => {
        await startParent();
        restartTimes = [];
        startMonitor();
        return `pid=${orch.parentInfo.pid}`;
      });

      await step("VERIFY", async () => {
        const entry = await verifyLoop("verify");
        return `#${entry.n} code=${entry.code} extracted=${JSON.stringify(entry.extracted)}`;
      });

      await step("DONE", async () => {
        orch.phase = "DONE";
        orch.finalState = "DONE";
        orch.selfStopAt = Date.now() + cfg.assistant.selfStopDelayMs;
        log.log("ok", `UPGRADE DONE: ${cfg.upgrade.target} is live. self-stop at ${new Date(orch.selfStopAt).toISOString()}`);
        // countdown: give the user a window to watch the closing page (plan §3.5)
        const end = orch.selfStopAt;
        while (Date.now() < end && !orch.abortRequested) {
          if (orch.abortRequested) break;
          await sleep(Math.min(1000, Math.max(0, end - Date.now())));
        }
        return "observation window elapsed";
      });

      await stopSelf({ finalState: "DONE" });
    } catch (e) {
      stopMonitor();
      if (e instanceof AbortError) {
        const ok = await doRollback("aborted by user");
        orch.finalState = ok ? "ROLLBACK" : "FAILED";
        if (!ok) orch.phase = "FAILED";
        await stopSelf({ finalState: orch.finalState });
        return;
      }
      orch.error = e.message;
      log.log("err", `upgrade failed at phase ${orch.phase}: ${e.message}`);
      const ok = await doRollback(e.message);
      orch.finalState = ok ? "ROLLBACK" : "FAILED";
      if (ok) {
        log.log("warn", "rolled back successfully - assistant will self-stop");
        await stopSelf({ finalState: "ROLLBACK" });
      } else {
        orch.phase = "FAILED";
        log.log("err", "FINAL STATE FAILED: parent left in rolled-back state, assistant stays up for manual intervention (max-runtime still bounds it)");
        orch.running = false;
      }
    }
  }

  async function restartParentOnly() {
    if (orch.running) throw new ApiError(409, "orchestration in progress");
    await stopParentNow();
    await startParent();
    startMonitor();
    log.log("ok", "parent restarted (manual trigger)");
  }

  async function rollbackOnly() {
    if (orch.running) throw new ApiError(409, "orchestration in progress");
    if (!dirMode && !(cfg.upgrade.rollbackCommands || []).length) {
      throw new ApiError(400, "nothing to roll back: no releases map and no rollbackCommands");
    }
    const ok = await doRollback("manual rollback trigger");
    return ok;
  }

  // POST /shutdown: only the ABORT path may run while an upgrade is in flight.
  async function shutdown() {
    if (orch.running && !orch.finalState) {
      orch.abortRequested = true;
      log.log("warn", "shutdown requested mid-upgrade: abort -> rollback -> stop");
      return { mode: "abort-scheduled" };
    }
    await stopSelf({ finalState: orch.finalState || "ABORTED", manual: true });
    return { mode: "stopped" };
  }

  async function stopSelf({ finalState, manual } = {}) {
    orch.phase = "STOP_ASS";
    log.phaseSet("STOP_ASS", "run", null, Date.now());
    log.log("info", `assistant self-stop (final=${finalState || "?"}${manual ? ", manual" : ""})`);
    stopMonitor();
    orch.finalState = finalState || orch.finalState || "STOPPED";
    // tunnels cleanup is best-effort (plan §3.9: binding/enrollment cleared on exit)
    if (deps.exposeCleanup) { try { await deps.exposeCleanup(); } catch (_) { /* ignore */ } }
    clearLock();
    const report = {
      startedAt: orch.startedAt,
      finishedAt: ts(),
      finalState: orch.finalState,
      error: orch.error,
      mode: manualForm ? "manual" : `service:${deps.manager.id}`,
      dirMode,
      target: cfg.upgrade.target,
      urls: deps.urls,
      parent: orch.parentInfo,
      verify: log.rings.verifies.slice(-20),
      phases: log.rings.phases,
      runDir: deps.runDir,
      configPath: cfg._meta ? cfg._meta.resolvedFrom : undefined,
      keepParent: cfg.onAssistantExit,
    };
    try {
      const histFile = writeHistory(report);
      log.log("ok", `report persisted: ${histFile}`);
      report.historyFile = histFile;
    } catch (e) {
      log.log("warn", `history write failed: ${e.message}`);
    }
    if (cfg.onAssistantExit === "stopParent" && manualForm) {
      try { await stopParentNow(); log.log("info", "stopParent: parent stopped before assistant exit"); } catch (e) {
        log.log("warn", `stopParent failed: ${e.message}`);
      }
    } else if (manualForm) {
      log.log("info", `keepParent: parent (pid=${orch.parentInfo.pid}) keeps running as orphan`);
    }
    log.phaseSet("STOP_ASS", "done", finalState, Date.now());
    const { pruneRunDirs } = require("./selfcopy");
    try { pruneRunDirs(require("./state-files").BASE_DIR(), 3); } catch (_) { /* ignore */ }
    await sleep(300); // flush events stream
    log.close();
    setTimeout(() => process.exit(0), 150).unref();
  }

  // max-runtime backstop (plan §3.4): self-kill no matter what
  function armMaxRuntime() {
    const ms = cfg.assistant.maxRuntimeMs;
    setTimeout(async () => {
      log.log("warn", `max-runtime ${ms}ms reached - force stop`);
      if (orch.running && !orch.finalState) {
        orch.abortRequested = true;
        await sleep(15000); // give the abort-rollback a grace window
      }
      try { await stopSelf({ finalState: "MAX_RUNTIME", manual: true }); } catch (_) { /* ignore */ }
      process.exit(1);
    }, ms).unref();
  }

  function writeStdin(data) {
    // stdin lives in the manager's child registry (manual plugin); pty only there
    if (deps.manager && typeof deps.manager.input === "function") {
      return deps.manager.input(svcName || "parent", data);
    }
    return writeParentInput({ handle: null, ptyHandle: null }, data);
  }

  return {
    orch, PHASES, ApiError,
    runUpgrade, rollbackOnly, restartParentOnly, shutdown, stopSelf,
    startMonitor, stopMonitor, armMaxRuntime, writeStdin,
    serviceSpec,
    resumeFrom: (mainIdx) => { orch.resumeIdx = mainIdx; },
  };
}

module.exports = { createOrchestrator, PHASES, ApiError };
