// lib/plugins/cli-packages.js - wrappers around npm service-manager CLIs.
// Calibrated on 48 (batch B, 2026-11-18):
//   unitup 0.4.1  - install <script> --name <n> [--arg <v>]... [--env k=v]... [--cwd <p>];
//                   start/stop/restart/status/logs(-n)/enable/uninstall(--force);
//                   unit file is `unitup-<name>.service`; overwrite-install refuses a
//                   running service -> updateEnv = stop -> reinstall -> start
//   serv   0.3.0  - install --exe <abs> [--args <v>]... --name <n> --workdir <p> --start-type auto;
//                   SYSTEM-level systemd units (`serv-<name>.service`), no env flags at all
//   serviceman    - upstream dead (rootprojects.org unreachable, GitHub repo 404) -> N/A per plan §3.7
//   pm2    7.1.2  - start <script> --name <n> [--cwd <p>] -- <args>; jlist; restart --update-env
// win32: node-based CLIs run via `node <js entry>` (never spawn .cmd shims - EINVAL).
"use strict";

const fs = require("fs");
const path = require("path");
const { runCapture, IS_WIN } = require("../util");
const { resolveBin } = require("../binfetch");

function findJsEntry(assistantRoot, pkgCandidates, binName) {
  for (const pkg of pkgCandidates) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(assistantRoot, "node_modules", pkg, "package.json"), "utf8"));
      const binField = pj.bin && (typeof pj.bin === "string" ? pj.bin : pj.bin[binName]);
      if (binField) return path.join(assistantRoot, "node_modules", pkg, binField);
    } catch (_) { /* package not installed */ }
  }
  return null;
}

function makeCliPlugin({ id, bin, pkg, platforms, hooks }) {
  function create(ctx) {
    let binPath = null;
    let jsEntry = null;
    async function detect() {
      binPath = await resolveBin(ctx.assistantRoot, bin, ctx.log);
      if (binPath && pkg) jsEntry = findJsEntry(ctx.assistantRoot, pkg, bin);
      return !!binPath;
    }
    const run = (args, timeoutMs = 25000, extraEnv) => {
      const spawnOpts = extraEnv ? { env: { ...process.env, ...extraEnv } } : undefined;
      if (IS_WIN && jsEntry) return runCapture(process.execPath, [jsEntry, ...args], { timeoutMs, spawn: spawnOpts });
      return runCapture(binPath, args, { timeoutMs, spawn: spawnOpts });
    };

    return {
      id,
      platforms,
      detect,
      run, // exposed for plugin-level extras (updateEnv flows)
      async install(spec) {
        const args = hooks.installArgs(spec);
        const r = await run(args);
        if (r.code !== 0) throw new Error(`${id} install failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
        return { bin: binPath };
      },
      async uninstall(name) {
        const r = await run(hooks.del ? hooks.del(name) : ["uninstall", name]);
        return { code: r.code, out: (r.stdout || r.stderr || "").trim().slice(0, 300) };
      },
      async start(name, spec) {
        const r = await run(hooks.start ? hooks.start(name, spec) : ["start", name]);
        if (r.code !== 0) throw new Error(`${id} start failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
        return true;
      },
      async stop(name, spec) {
        const r = await run(hooks.stop ? hooks.stop(name, spec) : ["stop", name]);
        if (r.code !== 0) throw new Error(`${id} stop failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
        return true;
      },
      async restart(name, spec) {
        const r = await run(hooks.restart ? hooks.restart(name, spec) : ["restart", name]);
        if (r.code !== 0) throw new Error(`${id} restart failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
        return true;
      },
      async updateEnv(name, env) {
        if (!hooks.envArgs) throw new Error(`${id}: no env support (calibrated 2026-11-18)`);
        const r = await run(hooks.envArgs(name, env));
        if (r.code !== 0) throw new Error(`${id} updateEnv failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
        return { code: r.code };
      },
      async status(name) {
        const r = await run(hooks.statusArgs ? hooks.statusArgs(name) : ["status", name]);
        return hooks.parseStatus ? hooks.parseStatus(r, name) : (r.code === 0 ? "running" : "stopped");
      },
      async logs(name, tail) {
        const r = await run(hooks.logsArgs ? hooks.logsArgs(name, tail) : ["logs", name, "--lines", String(tail || 50)], 15000);
        return r.stdout || r.stderr || "";
      },
    };
  }
  return { create, bin, hooks };
}

// ---------------- unitup (systemd user units on linux; no resident daemon) ----------------
const unitup = makeCliPlugin({
  id: "unitup",
  bin: "unitup",
  pkg: ["unitup"],
  platforms: ["linux", "darwin", "win32"],
  hooks: {
    // spec: {name, cmd(node), args:[script, ...scriptArgs], cwd, env}
    installArgs: (spec) => {
      const [script, ...scriptArgs] = spec.args || [];
      const args = ["install", script, "--name", spec.name];
      for (const a of scriptArgs) args.push("--arg", String(a));
      for (const [k, v] of Object.entries(spec.env || {})) args.push("--env", `${k}=${v}`);
      if (spec.cwd) args.push("--cwd", spec.cwd);
      return args;
    },
    start: (name) => ["start", name],
    stop: (name) => ["stop", name],
    restart: (name) => ["restart", name],
    statusArgs: (name) => ["status", name],
    parseStatus: (r) => {
      // plain status prints "Status: running|stopped|..." (raw mode is systemctl output)
      const m = /^Status:\s*(\S+)/m.exec(r.stdout || "");
      if (!m) return "stopped";
      if (m[1] === "running") return "running";
      if (m[1] === "stopped") return "stopped";
      return "unknown";
    },
    logsArgs: (name, tail) => ["logs", name, "--lines", String(tail || 50)],
    del: (name) => ["uninstall", name, "--force"],
  },
});
// unitup facts: unit file is `unitup-<name>.service` in ~/.config/systemd/user;
// overwrite-install refuses while the service runs -> updateEnv = stop -> reinstall -> start
function createUnitup(ctx) {
  const p = unitup.create(ctx);
  p.unitFile = (name) => (process.platform === "darwin" ? `dev.unitup.${name}` : `unitup-${name}.service`);
  p.updateEnv = async function (name, env, spec) {
    if (!spec) throw new Error("unitup updateEnv needs the install spec (reinstall overwrites the unit)");
    const merged = { ...spec, env: { ...(spec.env || {}), ...env } };
    await p.run(["stop", name], 15000).catch(() => {});
    const r = await p.run(unitup.hooks.installArgs(merged));
    if (r.code !== 0) throw new Error(`unitup env reinstall failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    const up = await p.run(["start", name], 15000);
    if (up.code !== 0) throw new Error(`unitup start after reinstall failed: ${(up.stderr || up.stdout || "").trim().slice(0, 200)}`);
    return { via: "stop-reinstall-start" };
  };
  return p;
}

// ---------------- serv (Go/Cobra; SYSTEM-level systemd units on linux; no env flags) ----------------
const serv = makeCliPlugin({
  id: "serv",
  bin: "serv",
  pkg: ["@tillmanbuildstech/serv"],
  platforms: ["linux", "darwin", "win32"],
  hooks: {
    installArgs: (spec) => {
      const args = ["install", "--exe", spec.cmd, "--name", spec.name, "--start-type", "auto"];
      for (const a of spec.args || []) args.push("--args", String(a));
      if (spec.cwd) args.push("--workdir", spec.cwd);
      if (spec.description) args.push("--description", spec.description);
      return args;
    },
    start: (name) => ["start", name],
    stop: (name) => ["stop", name],
    restart: (name) => ["restart", name],
    statusArgs: (name) => ["status", name],
    parseStatus: (r) => {
      const out = (r.stdout || "").toLowerCase();
      if (out.includes("running")) return "running";
      if (out.includes("stopped") || out.includes("inactive")) return "stopped";
      return "unknown";
    },
    logsArgs: (name, tail) => ["status", name], // serv has no logs command; status carries last lines
    del: (name) => ["remove", name],
  },
});
function createServ(ctx) {
  const p = serv.create(ctx);
  p.unitFile = (name) => `serv-${name}.service`;
  return p;
}

// ---------------- pm2 (resident daemon; autorestart; env via --update-env) ----------------
function createPm2(ctx) {
  let binPath = null;
  let jsEntry = null;
  async function detect() {
    binPath = await resolveBin(ctx.assistantRoot, "pm2", ctx.log);
    if (binPath) jsEntry = findJsEntry(ctx.assistantRoot, ["pm2"], "pm2");
    return !!binPath;
  }
  const run = (args, timeoutMs = 30000, extraEnv) => {
    const spawnOpts = extraEnv ? { env: { ...process.env, ...extraEnv } } : undefined;
    if (IS_WIN && jsEntry) return runCapture(process.execPath, [jsEntry, ...args], { timeoutMs, spawn: spawnOpts });
    return runCapture(binPath, args, { timeoutMs, spawn: spawnOpts });
  };

  return {
    id: "pm2",
    platforms: ["linux", "darwin", "win32"],
    detect,
    run,
    // spec: {name, args:[script, ...scriptArgs], cwd, env}  (cmd must be node)
    async install(spec) {
      const [script, ...scriptArgs] = spec.args || [];
      const args = ["start", script, "--name", spec.name];
      if (spec.cwd) args.push("--cwd", spec.cwd);
      if (scriptArgs.length) args.push("--", ...scriptArgs);
      const r = await run(args, 30000, spec.env);
      if (r.code !== 0) throw new Error(`pm2 start failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
      return { bin: binPath };
    },
    async uninstall(name) {
      const r = await run(["delete", name]);
      return { code: r.code, out: (r.stdout || r.stderr || "").trim().slice(0, 200) };
    },
    async start(name) {
      const r = await run(["start", name]);
      if (r.code !== 0) throw new Error(`pm2 start failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
      return true;
    },
    async stop(name) {
      const r = await run(["stop", name]);
      if (r.code !== 0) throw new Error(`pm2 stop failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
      return true;
    },
    async restart(name) {
      const r = await run(["restart", name]);
      if (r.code !== 0) throw new Error(`pm2 restart failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
      return true;
    },
    // env lives with the pm2 daemon: restart with --update-env while injecting the new
    // values into THIS CLI invocation's environment (pm2 merges the caller env)
    async updateEnv(name, env) {
      const r = await run(["restart", name, "--update-env"], 30000, env);
      if (r.code !== 0) throw new Error(`pm2 updateEnv failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
      return { via: "--update-env" };
    },
    async status(name) {
      const r = await run(["jlist"], 20000);
      try {
        const list = JSON.parse(r.stdout || "[]");
        const it = list.find((x) => x.name === name);
        if (!it) return "stopped";
        return it.pm2_env && it.pm2_env.status === "online" ? "running" : "stopped";
      } catch (_) { return "unknown"; }
    },
    async logs(name, tail) {
      const r = await run(["logs", name, "--lines", String(tail || 50), "--nostream"], 15000);
      return r.stdout || "";
    },
  };
}

module.exports = { createPm2, createUnitup, createServ, findJsEntry };
