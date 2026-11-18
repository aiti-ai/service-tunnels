// lib/plugins/win-service.js - Windows Services plugin.
// Real binaries are registered through the svc-host.js wrapper (see lib/svc-host.js):
//   binPath= <node.exe> <svc-host.js> <name>
// which gives us working-directory, env (T-env!), stdout logs and crash recovery via
// `sc failure` - none of which raw sc.exe can express for a node script.
// Requires an elevated token for sc create (verified: ssh session on 24 runs High
// Mandatory Level). Batch A wrote this blind; batch C calibrated on 24 (2026-11-18).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runCapture, IS_WIN } = require("../util");
const { resolveBin } = require("../binfetch");

const SERVICES_DIR = () => path.join(os.homedir(), ".svc-assistant", "win-services");

function specFile(name) { return path.join(SERVICES_DIR(), `${name}.json`); }
function logFile(name) { return path.join(SERVICES_DIR(), `${name}.log`); }

function createWinServicePlugin(ctx) {
  let nssmPath = null;

  async function detect() {
    if (!IS_WIN) return false;
    nssmPath = await resolveBin(ctx.assistantRoot, "nssm", ctx.log);
    return true; // sc.exe always exists on Windows
  }

  // kill the listening service child by port (the host exits cleanly on child death)
  async function killByPort(port, rounds = 3) {
    const { findPidByPort, killPid } = require("../util");
    for (let i = 0; i < rounds; i++) {
      const pid = await findPidByPort(port);
      if (!pid) return;
      await killPid(pid, { graceMs: 2000, tree: true });
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function writeSpec(name, spec) {
    fs.mkdirSync(SERVICES_DIR(), { recursive: true });
    fs.writeFileSync(specFile(name), JSON.stringify({
      cwd: spec.cwd || process.cwd(),
      cmd: spec.cmd,
      args: spec.args || [],
      env: spec.env || {},
      logFile: logFile(name),
    }, null, 2));
  }

  // SCM stop/start are ASYNCHRONOUS: wait for the query state to settle before moving on
  async function waitScState(name, want, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await runCapture("sc", ["query", name], { timeoutMs: 8000 });
      const out = (r.stdout || "") + (r.stderr || "");
      if (new RegExp(want).test(out)) return true;
      if (/1060/.test(out)) return want === "STOPPED";
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  return {
    id: "win-service",
    platforms: ["win32"],
    detect,

    async install(spec) {
      if (nssmPath) {
        const r = await runCapture(nssmPath, ["install", spec.name, spec.cmd, ...(spec.args || [])], { timeoutMs: 15000 });
        if (r.code !== 0) throw new Error(`nssm install failed: ${(r.stderr || r.stdout || "").trim()}`);
        if (spec.cwd) await runCapture(nssmPath, ["set", spec.name, "AppDirectory", spec.cwd], { timeoutMs: 8000 });
        const lf = logFile(spec.name);
        fs.mkdirSync(SERVICES_DIR(), { recursive: true });
        await runCapture(nssmPath, ["set", spec.name, "AppStdout", lf], { timeoutMs: 8000 });
        await runCapture(nssmPath, ["set", spec.name, "AppStderr", lf], { timeoutMs: 8000 });
        for (const [k, v] of Object.entries(spec.env || {})) {
          await runCapture(nssmPath, ["set", spec.name, "AppEnvironmentExtra", `${k}=${v}`], { timeoutMs: 8000 });
        }
        return { manager: "nssm", name: spec.name };
      }
      await writeSpec(spec.name, spec);
      const hostJs = path.join(ctx.assistantRoot, "lib", "svc-host.js");
      // sc.exe wants binPath= as ONE token that carries its own inner quotes
      // (batch-C bisect: multiple flat tokens after binPath= -> usage error 1639;
      //  one token without inner quotes -> SCM treats the whole string as the exe).
      // Node's execFile escaping preserves the embedded quotes for sc to parse.
      const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
      // the service binary is the svc-host wrapper: everything variable (cwd/env/args/
      // logFile) lives in the spec json it reads at start (see lib/svc-host.js)
      const binVal = `"${spec.cmd}" "${hostJs}" ${spec.name}`;
      const tokens = ["create", spec.name, "binPath=", binVal,
        "start=", "auto", "DisplayName=", spec.description || spec.name];
      // a previous delete may still be pending (1072) while its process drains: wait it out
      let r = await runCapture("sc", tokens, { timeoutMs: 15000 });
      for (let i = 0; i < 10 && r.code !== 0 && /1072/.test((r.stderr || "") + (r.stdout || "")); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        r = await runCapture("sc", tokens, { timeoutMs: 15000 });
      }
      if (r.code !== 0) {
        const err = (r.stderr || r.stdout || "").trim();
        throw new Error(`sc create failed (needs admin?): ${err}`);
      }
      // crash auto-restart via Service Failure Recovery: restart 5s after a crash,
      // counter reset daily. A managed `sc stop`/clean exit never triggers it.
      await runCapture("sc", ["failure", spec.name, "reset=", "86400", "actions=", "restart/5000"], { timeoutMs: 10000 });
      return { manager: "sc+svc-host", name: spec.name };
    },

    async uninstall(name, spec) {
      if (nssmPath) {
        await runCapture(nssmPath, ["stop", name], { timeoutMs: 15000 });
        const r = await runCapture(nssmPath, ["remove", name, "confirm"], { timeoutMs: 15000 });
        try { fs.unlinkSync(specFile(name)); } catch (_) { /* ignore */ }
        if (r.code !== 0) return { warn: `nssm remove exit ${r.code}` };
        return { removed: name };
      }
      // kill the service child first (taskkill tree) - the host exits cleanly afterwards
      if (spec && spec.port) await killByPort(spec.port);
      await runCapture("sc", ["stop", name], { timeoutMs: 15000 });
      const r = await runCapture("sc", ["delete", name], { timeoutMs: 15000 });
      try { fs.unlinkSync(specFile(name)); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(logFile(name)); } catch (_) { /* ignore */ }
      if (r.code !== 0) return { warn: `sc delete exit ${r.code}` };
      return { removed: name };
    },

    async start(name) {
      const r = nssmPath
        ? await runCapture(nssmPath, ["start", name], { timeoutMs: 15000 })
        : await runCapture("sc", ["start", name], { timeoutMs: 15000 });
      if (r.code !== 0 && !/1056/.test((r.stderr || "") + (r.stdout || ""))) {
        // 1056 / nssm "already started" (UTF-16LE message): tolerate when the service
        // really is running - updateEnv-with-restart precedes the orchestrator's start
        const running = await waitScState(name, "RUNNING", 4000);
        if (!running) throw new Error(`start failed: ${(r.stderr || r.stdout || "").trim()}`);
      }
      await waitScState(name, "RUNNING", 12000);
      return true;
    },

    async stop(name, spec) {
      // SCM stop is graceful (kills the nssm-managed app tree) but ASYNC - wait it out,
      // then fall back to a port tree-kill if anything is still listening
      const r = nssmPath
        ? await runCapture(nssmPath, ["stop", name], { timeoutMs: 15000 })
        : await runCapture("sc", ["stop", name], { timeoutMs: 15000 });
      if (r.code !== 0 && !/1062|not started/i.test((r.stdout || "") + (r.stderr || ""))) {
        throw new Error(`stop failed: ${(r.stderr || r.stdout || "").trim()}`);
      }
      await waitScState(name, "STOPPED", 10000);
      if (spec && spec.port) await killByPort(spec.port);
      return true;
    },

    async restart(name, spec) {
      if (spec && spec.port) {
        await this.stop(name, spec);
        return this.start(name);
      }
      if (nssmPath) {
        const r = await runCapture(nssmPath, ["restart", name], { timeoutMs: 15000 });
        if (r.code !== 0) throw new Error(`restart failed: ${(r.stderr || r.stdout || "").trim()}`);
        return true;
      }
      await runCapture("sc", ["stop", name], { timeoutMs: 15000 });
      return this.start(name);
    },

    // S3: env lives in nssm AppEnvironmentExtra / the svc-host spec json - written here
    // and applied by a restart (the orchestrator's later start tolerates already-running)
    async updateEnv(name, env, spec) {
      if (nssmPath) {
        for (const [k, v] of Object.entries(env)) {
          await runCapture(nssmPath, ["set", name, "AppEnvironmentExtra", `${k}=${v}`], { timeoutMs: 8000 });
        }
        await this.restart(name, spec);
        return { manager: "nssm" };
      }
      if (!spec) throw new Error("win-service updateEnv needs the install spec (rewrite spec json)");
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(specFile(name), "utf8")); } catch (_) { /* fresh */ }
      await writeSpec(name, { ...spec, env: { ...(cur.env || {}), ...env } });
      await this.restart(name, spec);
      return { via: "spec-json-rewrite" };
    },

    async status(name, spec) {
      const r = await runCapture("sc", ["query", name], { timeoutMs: 10000 });
      const out = (r.stdout || "") + (r.stderr || "");
      if (/RUNNING/.test(out)) return "running";
      if (/STOPPED/.test(out) || /1060/.test(out)) return "stopped";
      // SCM state can lag the actual child: port health decides when a port is known
      if (spec && spec.port) {
        try {
          const res = await fetch(`http://127.0.0.1:${spec.port}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) return "running";
        } catch (_) { /* down */ }
      }
      return "unknown";
    },

    async logs(name, tail, spec) {
      const n = Number(tail || 50);
      try {
        const lines = fs.readFileSync(logFile(name), "utf8").split(/\r?\n/);
        return lines.slice(-n).join("\n");
      } catch (_) { return ""; }
    },
  };
}

module.exports = { createWinServicePlugin };
