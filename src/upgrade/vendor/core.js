#!/usr/bin/env node
// core.js - upgrade assistant core (cross-platform prototype validated on
// CLI contract; batch A-F validated on 48/24/23). Exposes main(argv) for the st CLI
// facade and runs standalone via `node core.js --config <upgrade.json>`.
//
// PREPARE self-host isolation (plan §3.6): the boot process copies its own code into
// ~/.svc-assistant/run-<ts>/, spawns the copy (detached on POSIX; a one-shot schtasks
// task on win32 - sshd Job Objects reap session children), and exits; the copy continues
// the orchestration no matter what the upgrade does to the original directory.
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { loadConfig, writeResolvedConfig, ConfigError } = require("./lib/config");
const { createLog } = require("./lib/log");
const { createPlugins, probeAll, resolveManager } = require("./lib/plugins");
const { createOrchestrator } = require("./lib/orchestrate");
const { createHttpd } = require("./lib/httpd");
const { tryLoadPty } = require("./lib/proc");
const { copyAssistant, pruneRunDirs } = require("./lib/selfcopy");
const { BASE_DIR, readLock, writeLock, clearLock, lockIsStale } = require("./lib/state-files");
const { runCapture, sleep, ts, writeAtomic } = require("./lib/util");

const VERSION = "0.1.0-st";
const ASSISTANT_ROOT = __dirname;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "--manager" || a === "--port" || a === "--max-runtime" || a === "--st-entry" || a === "--expose-mode") {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = argv[++i];
    } else if (a === "--no-expose") flags.noExpose = true;
    else if (a === "--yes") flags.yes = true;
    else if (a === "--resume") flags.resume = true;
    else if (a === "--abort") flags.abort = true;
    else if (a === "--cleanup-config") flags.cleanupConfig = true;
    else if (a === "--isolated") flags.isolated = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return flags;
}

// best-effort service-tunnels expose (plan §3.9 M1 proxy); M2/M3 matrix validated in
// batch E (tunnel=ngrok credential-gated, portmap UPnP-dependent) - refined in Part 3 M3
async function runExpose(port, cfg, log, stEntry, mode) {
  const exposeCfg = (cfg.assistant && cfg.assistant.expose) || {};
  if (exposeCfg === false) return { urls: [], cleanup: null };
  const urls = [];
  let child = null;
  const modeArg = mode || exposeCfg.mode || "proxy";

  let cmd = exposeCfg.cmd;
  let baseArgs = exposeCfg.args;
  if (!cmd) {
    if (stEntry && fs.existsSync(stEntry)) {
      // M3 (plan §10.4): self-call the very st CLI that launched us - no PATH or
      // local-checkout guessing; the expose goes through the st daemon like any
      // operator invocation.
      cmd = process.execPath;
      baseArgs = [stEntry, "expose"];
    } else {
      let probe = await runCapture("which", ["st"], { timeoutMs: 4000 });
      if (probe.code === 0 && probe.stdout.trim()) {
        cmd = "st";
      } else {
        const localCli = path.join(process.env.HOME || "", "workspace", "service-tunnels", "dist", "cli.js");
        if (fs.existsSync(localCli)) { cmd = process.execPath; baseArgs = [localCli, "expose"]; }
      }
    }
    if (!cmd) {
      log.log("warn", "service-tunnels CLI not found (st not on PATH, local checkout missing) - skipping expose, local URL only");
      return { urls, cleanup: null };
    }
  }
  const args = baseArgs || ["expose"];
  try {
    const { spawn } = require("child_process");
    child = spawn(cmd, [...args, String(port), "--mode", modeArg], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      ...(cmd.endsWith(".cmd") || cmd.endsWith(".bat") ? { shell: true } : {}),
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      for (const m of buf.matchAll(/https?:\/\/[^\s"']+/g)) {
        const u = m[0].replace(/[),.]+$/, "");
        if (!urls.some((x) => x.url === u)) { urls.push({ kind: "proxy", url: u }); log.log("ok", `expose URL: ${u}`); }
      }
      if (buf.length > 65536) buf = buf.slice(-8192);
    });
    child.stderr.on("data", (d) => log.log("warn", `expose: ${String(d).trim().slice(0, 200)}`));
    child.on("error", (e) => log.log("warn", `expose spawn failed: ${e.message} (continuing local-only)`));
  } catch (e) {
    log.log("warn", `expose failed: ${e.message} (continuing local-only)`);
  }
  return {
    urls,
    cleanup: child ? async () => { try { child.kill("SIGTERM"); } catch (_) { /* ignore */ } } : null,
  };
}

async function main(argv, opts = {}) {
  const flags = parseArgs(argv || []);
  if (opts.stEntry) flags.stEntry = opts.stEntry;

  // ---------- load config (fail-fast with the full problem list, plan §3.2) ----------
  if (!flags.config) { console.error("core: --config <upgrade.json> is required"); process.exit(2); }
  const configPath = path.resolve(flags.config);
  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e.message);
    process.exit(2);
  }
  let cfg = loaded.cfg;
  if (flags.maxRuntime) {
    const { parseDuration } = require("./lib/util");
    cfg.assistant.maxRuntimeMs = parseDuration(flags.maxRuntime, "10m");
  }

  // ---------- leftover lock handling (plan §3.5) ----------
  if (!flags.isolated) {
    const stale = lockIsStale();
    if (stale && stale.ownerAlive) {
      console.error(`another assistant run is active (pid ${stale.lock.pid}, phase ${stale.lock.phase}) - refusing to start`);
      process.exit(3);
    }
    if (stale && !stale.ownerAlive) {
      console.error(`leftover upgrade lock found (phase=${stale.lock.phase}, runDir=${stale.lock.runDir})`);
      console.error(`  choose recovery: --resume (continue from phase) or --abort (roll back + restore parent)`);
      if (!flags.resume && !flags.abort) process.exit(3);
    }
  }

  // ---------- self-host isolation handoff (skipped when already the isolated copy) ----------
  if (!flags.isolated) {
    const runDir = path.join(BASE_DIR(), `run-${ts().replace(/[-:]/g, "").replace(/\..+$/, "")}`);
    const copy = copyAssistant(ASSISTANT_ROOT, runDir);
    const cfgCopy = writeResolvedConfig(cfg, path.join(runDir, "upgrade.json"), loaded.originalPath);
    const carry = ["--isolated", "--config", cfgCopy];
    for (const k of ["manager", "port", "maxRuntime", "exposeMode"]) if (flags[k]) carry.push(`--${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`, flags[k]);
    for (const k of ["noExpose", "yes", "resume", "abort", "cleanupConfig"]) if (flags[k]) carry.push(`--${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`);
    // M3: the child re-calls this very st CLI for expose - carry the entry when the
    // boot process IS the st CLI (dist/cli.js), not a standalone core.js run.
    const entry = argv && argv.stEntry;
    if (entry) carry.push("--st-entry", entry);

    const { spawn } = require("child_process");
    const bootLog = path.join(runDir, "boot.log");
    let childPid = null;
    if (process.platform === "win32") {
      // sshd wraps session children in a Job Object that kills the whole tree when the
      // command exits (batch C): neither detached spawn nor Start-Process survives.
      // A one-shot scheduled task runs under the Task Scheduler service - outside the
      // job - exactly the native pi-web idiom on such machines. /TR quoting = SCM
      // ImagePath rules (quoted exe + args), same pattern that fixed sc create.
      const esc = (s) => (/\s/.test(s) ? `"${s}"` : s);
      const childJs = path.join(runDir, "core.js");
      const tr = `${esc(process.execPath)} ${esc(childJs)} ${carry.map(esc).join(" ")}`;
      const taskName = `svc-assistant-run-${Date.now()}`;
      const run = (args) => runCapture("schtasks.exe", args, { timeoutMs: 15000 });
      const mk = await run(["/Create", "/TN", taskName, "/TR", tr, "/SC", "ONCE", "/ST", "23:59", "/RL", "HIGHEST", "/F"]);
      if (mk.code !== 0) {
        console.error(`[assistant] handoff task create failed: ${(mk.stderr || mk.stdout || "").trim().slice(0, 200)}`);
        process.exit(1);
      }
      const rn = await run(["/Run", "/TN", taskName]);
      if (rn.code !== 0) {
        console.error(`[assistant] handoff task run failed: ${(rn.stderr || rn.stdout || "").trim().slice(0, 200)}`);
        await run(["/Delete", "/TN", taskName, "/F"]);
        process.exit(1);
      }
      // definition removal does not kill the running instance
      await run(["/Delete", "/TN", taskName, "/F"]);
      console.log(`[assistant] handoff via scheduled task ${taskName} (pid unknown by design)`);
    } else {
      const child = spawn(process.execPath, [path.join(runDir, "core.js"), ...carry], {
        detached: true, stdio: "ignore", cwd: runDir,
      });
      child.unref();
      childPid = child.pid;
    }
    console.log(`[assistant] isolated run dir: ${runDir} (${copy.files} files copied)`);
    if (childPid) console.log(`[assistant] handed off to pid ${childPid}; boot log: ${bootLog}`);
    else console.log(`[assistant] handed off via scheduled task; boot log: ${bootLog}`);
    if (flags.cleanupConfig) { try { fs.unlinkSync(configPath); } catch (_) { /* ignore */ } }
    process.exit(0);
  }

  // ================= isolated copy continues here =================
  const runDir = __dirname;
  // route all boot output into boot.log ourselves (the handoff spawn used stdio ignore)
  const bootFd = fs.openSync(path.join(runDir, "boot.log"), "a");
  const writeBoot = (s) => { try { fs.writeSync(bootFd, String(s)); } catch (_) { /* ignore */ } };
  process.stderr.write = writeBoot;
  console.log = writeBoot;
  console.error = writeBoot;
  const log = createLog(runDir);
  log.log("info", `upgrade-assistant ${VERSION} (isolated copy) runDir=${runDir}`);
  // capture the leftover lock BEFORE our own boot writeLock overwrites its phase snapshot
  const leftoverLock = (flags.resume || flags.abort) ? readLock() : null;
  if (flags.resume || flags.abort) {
    log.log("warn", `${flags.resume ? "resume" : "abort"} recovery requested (leftover phase: ${leftoverLock && leftoverLock.phase})`);
  }

  // token + random port (plan §3.4)
  const token = crypto.randomBytes(24).toString("hex");
  writeAtomic(path.join(runDir, ".assistant-token"), token);
  fs.chmodSync(path.join(runDir, ".assistant-token"), 0o600);

  const ptyModule = tryLoadPty(ASSISTANT_ROOT);
  if (!ptyModule && (cfg.parent.start && cfg.parent.start.pty)) {
    log.log("warn", "node-pty not available - degrading parent spawn to plain pipes (config asked for pty)");
  }

  // ---------- plugin selection ----------
  const plugins = createPlugins({ log, assistantRoot: ASSISTANT_ROOT, sudoOpts: { askPass: cfg.service && cfg.service.sudoAskPass }, onConsole: (s, l) => log.consoleLine(s, l), ptyModule });
  const availability = await probeAll(plugins, log);
  log.log("info", `plugin availability: ${JSON.stringify(availability)}`);
  let manager;
  try {
    // manual form owns its own start/stop (byPort + spawn): no service manager needed
    const explicit = flags.manager || (cfg.service && cfg.service.manager);
    manager = await resolveManager(plugins, availability, explicit || (cfg.parent.start ? "manual" : undefined), process.platform, log);
  } catch (e) {
    log.log("err", e.message);
    process.exit(2);
  }
  log.log("info", `service manager: ${manager.id}`);

  // shared access-URL list (filled during SWAP_ASS/SHOW_ACCESS, read by /status)
  const urls = [];
  let exposeCleanup = null;

  // ---------- management HTTP server (random port) ----------
  const httpd = await createHttpd({
    port: flags.port ? parseInt(flags.port, 10) : 0,
    token, log,
    cfg,
    assistantRoot: ASSISTANT_ROOT,
    statusPageFile: path.join(ASSISTANT_ROOT, "lib", "status-page.html"),
    urls,
    selfMeta: { version: VERSION, runDir, pid: process.pid, manager: manager.id, startedAt: ts() },
    orch: null, orchestrator: null, // wired below
  });
  writeAtomic(path.join(runDir, ".assistant-port"), String(httpd.port));
  log.log("ok", `management API on http://127.0.0.1:${httpd.port} (token in .assistant-token)`);

  // ---------- orchestrator ----------
  const orchestrator = createOrchestrator({
    cfg, log, manager, plugins, availability,
    runDir, ptyModule,
    urls, // filled by SHOW_ACCESS below (same array reference)
    exposeCleanup: () => { if (exposeCleanup) return exposeCleanup(); },
    onConsole: (src, line) => log.consoleLine(src, line),
  });
  const orch = orchestrator.orch;

  // wire status snapshots for the API (deps.orchestrator/deps.orch were null placeholders)
  httpd.wire({ orch, orchestrator });

  // ---------- SWAP_ASS + SHOW_ACCESS ----------
  log.phaseSet("PREPARE", "done", "config validated + isolated copy running", Date.now() - 800);
  const tSwap = Date.now();
  log.phaseSet("SWAP_ASS", "run", null, tSwap);
  if (!flags.noExpose) {
    const ex = await runExpose(httpd.port, cfg, log, flags.stEntry, flags.exposeMode);
    urls.push({ kind: "local", url: `http://127.0.0.1:${httpd.port}/?tk=${token}` });
    for (const u of ex.urls) urls.push(u);
    exposeCleanup = ex.cleanup;
  } else {
    urls.push({ kind: "local", url: `http://127.0.0.1:${httpd.port}/?tk=${token}` });
  }
  writeLock({ runDir, configPath: loaded.originalPath, phase: "SWAP_ASS", state: "done", port: httpd.port });
  log.phaseSet("SWAP_ASS", "done", `${urls.length} url(s)`, tSwap);
  log.phaseSet("SHOW_ACCESS", "done", urls.map((u) => u.url).join(" | "), Date.now());
  for (const u of urls) writeBoot(`[assistant] access: ${u.url}\n`);

  // ---------- lock recovery paths ----------
  if (flags.abort) {
    log.log("warn", "--abort: rolling back leftover run and restoring parent");
    const ok = await orchestrator.rollbackOnly();
    log.log(ok ? "ok" : "err", ok ? "abort rollback completed" : "abort rollback failed (see events)");
    clearLock();
    await orchestrator.stopSelf({ finalState: ok ? "ABORTED" : "FAILED", manual: true });
    return;
  }
  if (flags.resume) {
    const phase = leftoverLock && leftoverLock.phase;
    log.log("warn", `--resume: continuing from phase ${phase}`);
    const MAIN = ["STOP_PARENT", "UPGRADE", "RESTART_PARENT", "VERIFY"];
    if (phase && MAIN.includes(phase)) {
      // restart the flow from the recorded phase: earlier main steps are replayed as done
      orchestrator.resumeFrom(MAIN.indexOf(phase));
      orchestrator.runUpgrade().catch((e) => log.log("err", `runUpgrade crashed: ${e.message}`));
    } else {
      log.log("info", "nothing to resume (phase was terminal) - use the UI to trigger an upgrade");
    }
  }

  // ---------- signals + max-runtime ----------
  orchestrator.armMaxRuntime();
  let shuttingDown = false;
  const onSignal = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.log("warn", `${sig} received - stopping assistant (keepParent=${cfg.onAssistantExit})`);
    await orchestrator.stopSelf({ finalState: "ABORTED", manual: true });
    process.exit(0);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // ---------- arm: wait for POST /upgrade (or auto-start) ----------
  log.log("info", `assistant armed - open the status page and press "Trigger upgrade" (target ${cfg.upgrade.target})`);
  if (cfg.assistant.autoStart) {
    await sleep(1500);
    log.log("info", "autoStart=true - starting upgrade");
    orchestrator.runUpgrade().catch((e) => log.log("err", `runUpgrade crashed: ${e.message}`));
  }
}

module.exports = { main, VERSION };

if (require.main === module) {
  const selfArgv = process.argv.slice(2);
  const entry = process.argv[1] && path.basename(process.argv[1]) === "cli.js" ? process.argv[1] : undefined;
  main(selfArgv, { stEntry: entry }).catch((e) => {
    console.error(`[assistant] fatal: ${e.message}`);
    process.exit(1);
  });
}
