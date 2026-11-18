// service.js - `st service <verb>` core (plan §4.2/§10.3): service-form verbs driven by
// an upgrade.json-style config's "service" block. The manager is resolved through the
// same plugin registry the upgrade orchestrator uses (matrix-calibrated selection).
"use strict";

const path = require("path");

const { loadConfig } = require("./lib/config");
const { createPlugins, probeAll, resolveManager } = require("./lib/plugins");

const ASSISTANT_ROOT = path.join(__dirname, "..");

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
      await manager.restart(cfg.service.name, spec);
      return { verb, manager: manager.id, status: await manager.status(cfg.service.name, spec) };
    case "status":
      return { verb, manager: manager.id, status: await manager.status(cfg.service.name, spec) };
    case "logs":
      return { verb, manager: manager.id, logs: await manager.logs(cfg.service.name, opts.tail || 50, spec) };
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

module.exports = { serviceAction, ASSISTANT_ROOT };
