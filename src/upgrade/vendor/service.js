// service.js - `st service <verb>` core (plan §4.2/§10.3): service-form verbs driven by
// an upgrade.json-style config's "service" block. The manager is resolved through the
// same plugin registry the upgrade orchestrator uses (matrix-calibrated selection).
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");

const { loadConfig } = require("./lib/config");
const { createPlugins, probeAll, resolveManager } = require("./lib/plugins");

const ASSISTANT_ROOT = path.join(__dirname, "..");


// ============================================================================
// service restart recover pipeline (plan §11: standalone service restart walks a
// mini-pipeline like an upgrade — stop -> verify stopped -> start -> verify port
// health -> auto re-restart when necessary; progress persisted + onEvent)
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVICE_RUNS_DIR = () => path.join(os.homedir(), ".svc-assistant", "service-runs");

function checkPort(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = net.connect({ port: Number(port), host: "127.0.0.1" });
    const done = (ok) => { try { sock.destroy(); } catch (_) { /* ignore */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function waitPort(port, want, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await checkPort(port)) === want) return true;
    await sleep(300);
  }
  return false;
}

/** Recover-style standalone service restart with progress + auto re-restart. */
async function restartPipeline(configPath, opts = {}) {
  const cfg = loadConfig(path.resolve(configPath)).cfg;
  if (!cfg.service) throw new Error(`config has no "service" block (${path.basename(configPath)})`);
  const log = { log: (level, msg) => (opts.onLine ? opts.onLine(`[${level}] ${msg}`) : console.error(`[${level}] ${msg}`)) };
  const plugins = createPlugins({ log, assistantRoot: path.join(__dirname, ".."), sudoOpts: { askPass: cfg.service.sudoAskPass }, onConsole: () => {}, ptyModule: null });
  const availability = await probeAll(plugins, log);
  const manager = await resolveManager(plugins, availability, cfg.service.manager || undefined, process.platform, log);
  const spec = {
    name: cfg.service.name,
    cmd: cfg.service.install ? cfg.service.install.cmd : (cfg.parent.start && cfg.parent.start.cmd),
    args: cfg.service.install ? cfg.service.install.args : (cfg.parent.start && cfg.parent.start.args),
    cwd: cfg.service.install ? cfg.service.install.cwd : (cfg.parent.start && cfg.parent.start.cwd),
    env: { ...(cfg.service.install ? cfg.service.install.env : {}), ...(cfg.parent.start && cfg.parent.start.env) },
    port: cfg.parent.port,
  };
  const name = cfg.service.name;
  const port = cfg.parent.port;

  const runId = opts.runId || new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+$/, "");
  const runDir = path.join(SERVICE_RUNS_DIR(), runId);
  fs.mkdirSync(runDir, { recursive: true });
  const ev = (step, status, detail) => {
    const entry = { ts: new Date().toISOString(), step, status, detail: detail || "" };
    try { fs.appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify(entry) + "\n"); } catch (_) { /* ignore */ }
    if (opts.onEvent) { try { opts.onEvent(entry); } catch (_) { /* ignore */ } }
    return entry;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const maxAttempts = 2; // initial start + one auto re-restart ("necessary restart")

  ev("PIPELINE", "run", `service restart pipeline: ${name} (manager ${manager.id})`);
  ev("STOP", "run");
  try { await manager.stop(name, spec); ev("STOP", "done"); } catch (e) { ev("STOP", "warn", String(e.message || e).slice(0, 200)); }
  const stoppedFree = await waitPort(port, false, 10000);
  ev("VERIFY-STOPPED", stoppedFree ? "done" : "fail", stoppedFree ? "port free" : "port still held");

  let healthy = false;
  let attempts = 0;
  for (attempts = 1; attempts <= maxAttempts; attempts++) {
    ev("START", "run", `attempt ${attempts}/${maxAttempts}`);
    try {
      await manager.start(name, spec);
      ev("START", "done");
    } catch (e) {
      ev("START", "fail", String(e.message || e).slice(0, 200));
    }
    healthy = await waitPort(port, true, 15000);
    ev("VERIFY-HEALTH", healthy ? "done" : "fail", healthy ? `port ${port} answering` : `port ${port} silent`);
    if (healthy) break;
    if (attempts < maxAttempts) ev("RESTART", "run", "auto re-restart (necessary restart)");
  }

  const final = healthy ? "DONE" : "FAILED";
  ev("PIPELINE", final, `${attempts} attempt(s)`);
  const report = { runId, final, attempts, manager: manager.id, service: name, port, runDir };
  try { fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2)); } catch (_) { /* ignore */ }
  return { ...report, final };
}



async function serviceAction(verb, configPath, opts = {}) {
  const cfg = loadConfig(path.resolve(configPath)).cfg;
  if (!cfg.service) throw new Error(`config has no "service" block (${path.basename(configPath)})`);
  const log = { log: (level, msg) => (opts.onLine ? opts.onLine(`[${level}] ${msg}`) : console.error(`[${level}] ${msg}`)) };
  const plugins = createPlugins({ log, assistantRoot: ASSISTANT_ROOT, sudoOpts: { askPass: cfg.service.sudoAskPass }, onConsole: () => {}, ptyModule: null });
  const availability = await probeAll(plugins, log);
  const explicit = opts.manager || cfg.service.manager;
  const manager = await resolveManager(plugins, availability, explicit || undefined, process.platform, log);

  const spec = {
    name: cfg.service.name,
    description: cfg.service.install ? cfg.service.install.description : `service ${cfg.service.name}`,
    cmd: cfg.service.install ? cfg.service.install.cmd : (cfg.parent.start && cfg.parent.start.cmd),
    args: cfg.service.install ? cfg.service.install.args : (cfg.parent.start && cfg.parent.start.args),
    cwd: cfg.service.install ? cfg.service.install.cwd : (cfg.parent.start && cfg.parent.start.cwd),
    env: { ...(cfg.service.install ? cfg.service.install.env : {}), ...(cfg.parent.start && cfg.parent.start.env) },
    port: cfg.parent.port,
  };

  switch (verb) {
    case "install": {
      const r = await manager.install(spec);
      await manager.start(cfg.service.name, spec);
      return { verb, manager: manager.id, ...r, status: await manager.status(cfg.service.name, spec) };
    }
    case "uninstall":
      return { verb, manager: manager.id, ...(await manager.uninstall(cfg.service.name, spec)) };
    case "start":
      await manager.start(cfg.service.name, spec);
      return { verb, manager: manager.id, status: await manager.status(cfg.service.name, spec) };
    case "stop":
      await manager.stop(cfg.service.name, spec);
      return { verb, manager: manager.id, status: await manager.status(cfg.service.name, spec) };
    case "restart":
      // --restart-pipeline: recover-style mini-pipeline (stop->verify->start->verify,
      // auto re-restart when necessary) with progress events; plain restart = one shot
      if (opts.restartPipeline) {
        const r = await restartPipeline(path.resolve(configPath), { ...opts, onLine: opts.onLine });
        return { verb, manager: manager.id, ...r };
      }
      await manager.restart(cfg.service.name, spec);
      return { verb, manager: manager.id, status: await manager.status(cfg.service.name, spec) };
    case "status":
      return { verb, manager: manager.id, status: await manager.status(cfg.service.name, spec) };
    case "logs":
      return { verb, manager: manager.id, logs: await manager.logs(cfg.service.name, opts.tail || 50, spec) };
    case "updateenv":
      // S3 env change: manager-native rewrite (systemd Environment= / nssm
      // AppEnvironmentExtra / plist) — takes effect on the next restart; the
      // caller decides whether to restart immediately (forced-ask in the panel)
      if (!opts.env || typeof opts.env !== "object") throw new Error("updateenv needs --env JSON");
      {
        const r = await manager.updateEnv(cfg.service.name, opts.env, spec);
        return { verb, manager: manager.id, ...r, restartRequired: true };
      }
    case "enable": {
      if (typeof manager.enable !== "function") {
        // systemd-family: enable via the unit; CLI packages: their own enable verb
        const { runCapture } = require("./lib/util");
        const unitName = manager.unitFile ? manager.unitFile(cfg.service.name) : `${cfg.service.name}.service`;
        const scope = process.platform === "darwin" ? [] : ["--user"];
        const r = await runCapture("systemctl", [...scope, "enable", unitName], { timeoutMs: 15000 });
        if (r.code !== 0) throw new Error(`enable failed: ${(r.stderr || r.stdout || "").trim()}`);
        return { verb, manager: manager.id, enabled: (r.stdout || "").trim() };
      }
      return { verb, manager: manager.id, enabled: await manager.enable(cfg.service.name, spec) };
    }
    case "disable": {
      if (typeof manager.disable !== "function") {
        const { runCapture } = require("./lib/util");
        const unitName = manager.unitFile ? manager.unitFile(cfg.service.name) : `${cfg.service.name}.service`;
        const scope = process.platform === "darwin" ? [] : ["--user"];
        const r = await runCapture("systemctl", [...scope, "disable", unitName], { timeoutMs: 15000 });
        if (r.code !== 0) throw new Error(`disable failed: ${(r.stderr || r.stdout || "").trim()}`);
        return { verb, manager: manager.id, disabled: (r.stdout || "").trim() };
      }
      return { verb, manager: manager.id, disabled: await manager.disable(cfg.service.name, spec) };
    }
    default:
      throw new Error(`unknown service verb: ${verb}`);
  }
}

/** Read a pipeline run's events (latest when runId omitted) for progress polling. */
function pipelineStatus(runId) {
  const runsDir = SERVICE_RUNS_DIR();
  let dir = null;
  try {
    if (runId) {
      dir = path.join(runsDir, runId);
      fs.accessSync(dir);
    } else {
      const entries = fs.readdirSync(runsDir).sort().reverse();
      dir = entries[0] ? path.join(runsDir, entries[0]) : null;
    }
  } catch (_) {
    return null;
  }
  if (!dir) return null;
  let events = [];
  try {
    events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { /* no events yet */ }
  let report = null;
  try { report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")); } catch (_) { /* running */ }
  return { runId: path.basename(dir), runDir: dir, events, report, running: !report };
}

module.exports = { serviceAction, restartPipeline, pipelineStatus, ASSISTANT_ROOT };
