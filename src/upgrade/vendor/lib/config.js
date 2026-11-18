// lib/config.js - load / validate / path-resolve upgrade.json (plan §3.2).
// All relative paths are resolved against the ORIGINAL config dir at load time and the
// resolved config is re-emitted, so the self-host-isolated copy keeps working paths.
// Load failure -> fail-fast with the FULL list of problems (never enter orchestration).
"use strict";

const fs = require("fs");
const path = require("path");

const { parseDuration } = require("./util");

const VERIFY_TYPES = ["jsonPath", "status", "textContains"];
const SWAP_MODES = ["symlink", "junction", "copy", "auto"];

// strip // and /* */ comments so examples can carry inline docs (launch.json style)
function stripJsonComments(text) {
  let out = "";
  let i = 0, inStr = false, inLine = false, inBlock = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } i++; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i += 2; } else i++; continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n || ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function loadConfig(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    throw new ConfigError([`config file not readable: ${abs} (${e.message})`]);
  }
  let cfg;
  try {
    cfg = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    throw new ConfigError([`config JSON parse failed: ${e.message}`]);
  }
  const problems = [];
  const resolved = resolveConfig(cfg, path.dirname(abs), problems);
  if (problems.length) throw new ConfigError(problems);
  return { cfg: resolved, originalPath: abs, originalDir: path.dirname(abs) };
}

class ConfigError extends Error {
  constructor(problems) { super("config validation failed:\n  - " + problems.join("\n  - ")); this.problems = problems; }
}

function resolvePath(base, p) {
  if (p === undefined || p === null || p === "") return p;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
}

function resolveConfig(cfg, base, problems) {
  const out = JSON.parse(JSON.stringify(cfg || {}));

  // ---- parent vs service form (mutually exclusive, plan §3.2) ----
  const hasStart = !!(out.parent && out.parent.start);
  const hasService = !!out.service;
  if (hasStart && hasService) {
    problems.push(`"parent.start" and "service" are mutually exclusive (one form only)`);
  }
  if (!hasStart && !hasService) {
    problems.push(`missing one of: "parent.start" (manual form) or "service" (service form)`);
  }

  const port = out.parent && out.parent.port;
  if (!port || !Number.isInteger(Number(port)) || Number(port) <= 0) {
    problems.push(`"parent.port" is required (positive integer, used by byPort stop + health checks)`);
  }

  if (hasStart) {
    const s = out.parent.start;
    if (!s.cmd) problems.push(`"parent.start.cmd" is required in manual form`);
    if (s.cwd) s.cwd = resolvePath(base, s.cwd);
    s.pty = !!s.pty;
    if (s.env && typeof s.env !== "object") problems.push(`"parent.start.env" must be an object`);
  }
  if (out.parent && out.parent.stop) {
    const st = out.parent.stop;
    if (st.type !== "byPort" && st.type !== "cmd") {
      problems.push(`"parent.stop.type" must be "byPort" or "cmd"`);
    }
    if (st.type === "cmd") {
      if (!st.cmd) problems.push(`"parent.stop.cmd" is required when type=cmd`);
      if (st.cwd) st.cwd = resolvePath(base, st.cwd);
    }
    st.graceMs = parseDuration(st.graceMs, 5000);
  } else if (out.parent) {
    out.parent.stop = { type: "byPort", graceMs: 5000 };
  }

  if (hasService) {
    const sv = out.service;
    if (sv.manager && sv.stop) {
      problems.push(`"service": use either "manager" (plugin id) or direct stop/start/restart commands, not both`);
    }
    if (!sv.manager && !sv.stop) {
      problems.push(`"service" needs either "manager": "<plugin id>" or direct "stop"/"start"/"restart" command objects`);
    }
    for (const k of ["stop", "start", "restart"]) {
      if (sv[k]) {
        if (!sv[k].cmd) problems.push(`"service.${k}.cmd" is required`);
        if (sv[k].cwd) sv[k].cwd = resolvePath(base, sv[k].cwd);
      }
    }
    // optional: original install spec - required by reinstall-style updateEnv plugins
    // (unitup overwrite-install, adecore definition regenerate)
    if (sv.install) {
      if (!sv.install.cmd) problems.push(`"service.install.cmd" is required`);
      if (!sv.install.name) sv.install.name = sv.name;
      if (sv.install.cwd) sv.install.cwd = resolvePath(base, sv.install.cwd);
    }
    if (sv.env && typeof sv.env !== "object") problems.push(`"service.env" must be an object`);
  }

  // ---- upgrade ----
  if (!out.upgrade) problems.push(`missing "upgrade" section`);
  if (out.upgrade) {
    const up = out.upgrade;
    if (!up.target) problems.push(`"upgrade.target" is required`);
    if (up.releases) {
      if (!up.current) problems.push(`"upgrade.current" (pointer dir) is required in dir-swap mode`);
      for (const [v, dir] of Object.entries(up.releases)) {
        if (typeof dir !== "string") { problems.push(`"upgrade.releases.${v}" must be a path string`); continue; }
        up.releases[v] = resolvePath(base, dir);
        if (!fs.existsSync(up.releases[v])) problems.push(`release dir for ${v} does not exist: ${up.releases[v]}`);
      }
      if (up.current) {
        up.current = resolvePath(base, up.current);
        if (up.target && up.releases && !up.releases[up.target]) {
          problems.push(`"upgrade.target" "${up.target}" not found in "upgrade.releases" map`);
        }
        if (up.swap && !SWAP_MODES.includes(up.swap)) {
          problems.push(`"upgrade.swap" must be one of ${SWAP_MODES.join("|")}`);
        }
      }
    }
    for (const k of ["preCommands", "rollbackCommands"]) {
      if (up[k]) {
        up[k].forEach((c, i) => {
          if (!c.cmd) problems.push(`"upgrade.${k}[${i}].cmd" is required`);
          if (c.cwd) {
            c.cwd = resolvePath(base, c.cwd);
            if (!fs.existsSync(c.cwd)) problems.push(`"upgrade.${k}[${i}].cwd" does not exist: ${c.cwd}`);
          }
          c.pty = !!c.pty;
        });
      }
    }
    if (!up.verify) problems.push(`"upgrade.verify" is required (health probe after restart)`);
    if (up.verify) {
      const v = up.verify;
      if (!v.url) problems.push(`"upgrade.verify.url" is required`);
      if (!VERIFY_TYPES.includes(v.type)) problems.push(`"upgrade.verify.type" must be one of ${VERIFY_TYPES.join("|")}`);
      if ((v.type === "jsonPath" || v.type === "textContains") && v.expect === undefined) {
        problems.push(`"upgrade.verify.expect" is required for type=${v.type}`);
      }
      if (v.type === "jsonPath" && !v.jsonPath) problems.push(`"upgrade.verify.jsonPath" is required for type=jsonPath`);
      v.timeoutMs = parseDuration(v.timeout, 60000);
      v.intervalMs = parseDuration(v.interval, 1000);
    }
  }

  // ---- assistant block ----
  const a = (out.assistant = out.assistant || {});
  // numeric overrides (e.g. --max-runtime carried through the isolated copy) win; the
  // string fields are only parsed when the number is not already resolved
  try {
    if (typeof a.selfStopDelayMs !== "number") a.selfStopDelayMs = parseDuration(a.selfStopDelay, 60000);
  } catch (e) { problems.push(`"assistant.selfStopDelay": ${e.message}`); }
  try {
    if (typeof a.maxRuntimeMs !== "number") a.maxRuntimeMs = parseDuration(a.maxRuntime, 600000);
  } catch (e) { problems.push(`"assistant.maxRuntime": ${e.message}`); }
  a.autoStart = !!a.autoStart;
  if (a.expose === undefined) a.expose = {};
  if (a.expose && typeof a.expose === "object") {
    if (a.expose.cwd) a.expose.cwd = resolvePath(base, a.expose.cwd);
  }
  if (out.onAssistantExit && !["keepParent", "stopParent"].includes(out.onAssistantExit)) {
    problems.push(`"onAssistantExit" must be "keepParent" or "stopParent"`);
  }
  out.onAssistantExit = out.onAssistantExit || "keepParent";

  return out;
}

// Persist the resolved config (used for the isolated copy + lock audit trail).
function writeResolvedConfig(resolvedCfg, targetFile, originalPath) {
  const doc = { ...resolvedCfg, _meta: { resolvedFrom: originalPath, resolvedAt: new Date().toISOString() } };
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(doc, null, 2));
  return targetFile;
}

module.exports = { loadConfig, writeResolvedConfig, ConfigError, stripJsonComments };
