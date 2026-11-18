// lib/plugins/index.js - plugin registry + selection chain (plan §3.1).
"use strict";

const { createSystemdPlugin } = require("./systemd");
const { createManualPlugin } = require("./manual");
const { createLaunchdPlugin } = require("./launchd");
const { createWinTaskPlugin } = require("./win-task");
const { createWinServicePlugin } = require("./win-service");
const { createPm2, createUnitup, createServ } = require("./cli-packages");
const { createAdecorePlugin } = require("./adecore-driver");
// serviceman: upstream dead (rootprojects.org unreachable, GitHub repo 404, batch B 2026-11-18)
// -> no plugin, N/A per plan §3.7; re-add if a live source ever appears in bin-manifest.json.

function createPlugins(ctx) {
  const instances = [
    createSystemdPlugin(ctx),
    createLaunchdPlugin(ctx),
    createWinTaskPlugin(ctx),
    createWinServicePlugin(ctx),
    createPm2(ctx),
    createUnitup(ctx),
    createServ(ctx),
    createAdecorePlugin(ctx),
    createManualPlugin(ctx),
  ];
  const byId = Object.fromEntries(instances.map((p) => [p.id, p]));
  return { instances, byId };
}

// Probe availability of every plugin (used for matrix + selection).
async function probeAll(plugins, log) {
  const result = {};
  for (const p of plugins.instances) {
    try {
      result[p.id] = await p.detect();
    } catch (e) {
      result[p.id] = false;
      if (log) log("warn", `plugin ${p.id} detect failed: ${e.message}`);
    }
  }
  return result;
}

// Selection: explicit --manager > platform probe chain (privilege-free first, manual last).
const CHAINS = {
  linux: ["systemd", "unitup", "manual"],
  darwin: ["launchd", "unitup", "manual"],
  win32: ["win-task", "win-service", "unitup", "manual"],
};

async function resolveManager(plugins, availability, explicit, platform, log) {
  if (explicit) {
    const p = plugins.byId[explicit];
    if (!p) throw new Error(`unknown manager id: ${explicit}`);
    const ok = availability[explicit] !== undefined ? availability[explicit] : await p.detect();
    if (!ok && explicit !== "manual") {
      throw new Error(`manager "${explicit}" unavailable on this machine`);
    }
    return p;
  }
  for (const id of CHAINS[platform] || ["manual"]) {
    if (availability[id]) return plugins.byId[id];
  }
  throw new Error(`no service manager available on ${platform}`);
}

module.exports = { createPlugins, probeAll, resolveManager, CHAINS };
