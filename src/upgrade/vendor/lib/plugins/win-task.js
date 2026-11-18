// lib/plugins/win-task.js - schtasks plugin (no elevation required; the 24-machine's
// incumbent form). Windows-only, untestable on 48 in batch A - validated in batch C.
// Notes (windows-compat-lessons §1/§3): schtasks output is UTF-16LE - status checks go
// through PowerShell Get-ScheduledTask; killing uses taskkill tree.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runCapture, writeAtomic, sleep, IS_WIN } = require("../util");

const TASKS_DIR = () => path.join(os.homedir(), ".svc-assistant", "win-tasks");

function batPath(name) { return path.join(TASKS_DIR(), `${name}.bat`); }
function logPath(name) { return path.join(TASKS_DIR(), `${name}.log`); }

function batContent(spec) {
  const sets = Object.entries(spec.env || {}).map(([k, v]) => `set "${k}=${v}"`).join("\r\n");
  const cmd = [spec.cmd, ...(spec.args || [])].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return [
    "@echo off",
    sets,
    spec.cwd ? `cd /d "${spec.cwd}"` : null,
    `${cmd} >> "${logPath(spec.name)}" 2>&1`,
  ].filter(Boolean).join("\r\n") + "\r\n";
}

function createWinTaskPlugin(ctx) {
  async function detect() {
    if (!IS_WIN) return false;
    const r = await runCapture("schtasks", ["/Query", "/TN", "__svc_eval_probe__"], { timeoutMs: 8000 });
    // ENOENT -> unavailable; any structured "task not found" answer means schtasks works
    if (r.err && r.err.code === "ENOENT") return false;
    return true;
  }

  return {
    id: "win-task",
    platforms: ["win32"],
    detect,

    async install(spec) {
      fs.mkdirSync(TASKS_DIR(), { recursive: true });
      writeAtomic(batPath(spec.name), batContent(spec));
      // ONLOGON autostart; no auto-restart on crash (T4 expected-fail, documented per plan §2.1)
      const r = await runCapture("schtasks",
        ["/Create", "/TN", spec.name, "/TR", `"${batPath(spec.name)}"`, "/SC", "ONLOGON", "/F"],
        { timeoutMs: 15000 });
      if (r.code !== 0) throw new Error(`schtasks create failed: ${(r.stderr || r.stdout || "").trim()}`);
      return { bat: batPath(spec.name) };
    },

    async uninstall(name, spec) {
      // kill the process tree first: /End leaves the task's cmd.exe children running
      // (windows-compat-lessons §1) and the node service would keep holding its port
      if (spec && spec.port) await this.stop(name, spec);
      const r = await runCapture("schtasks", ["/End", "/TN", name], { timeoutMs: 10000 });
      const d = await runCapture("schtasks", ["/Delete", "/TN", name, "/F"], { timeoutMs: 10000 });
      try { fs.unlinkSync(batPath(name)); } catch (_) { /* ignore */ }
      if (d.code !== 0) return { warn: `schtasks delete exit ${d.code}` };
      return { removed: name };
    },

    async start(name) {
      const r = await runCapture("schtasks", ["/Run", "/TN", name], { timeoutMs: 10000 });
      if (r.code !== 0) throw new Error(`schtasks run failed: ${(r.stderr || r.stdout || "").trim()}`);
      return true;
    },

    // find the service node processes by COMMAND LINE (CIM) - netstat is timing-sensitive
    // right after /End (the orphan's LISTENING row can lag), the process table is not
    async findServicePids(port) {
      const marker = `--port ${port}`;
      const r = await runCapture("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ` +
        `Select-Object -ExpandProperty ProcessId`], { timeoutMs: 15000 });
      return (r.stdout || "").split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
    },

    async stop(name, spec) {
      const r = await runCapture("schtasks", ["/End", "/TN", name], { timeoutMs: 10000 });
      // /End orphans the node child (it kills only the task's tracked process tree head):
      // kill by command line (CIM) with a netstat-by-port fallback, then verify via health.
      if (spec && spec.port) {
        const { findPidByPort, killPid } = require("../util");
        for (let round = 0; round < 3; round++) {
          let pids = await this.findServicePids(spec.port);
          if (process.env.SVC_EVAL_DEBUG) console.error(`  [stop-debug] round ${round}: cim=${JSON.stringify(pids)}`);
          if (!pids.length) {
            const netstatPid = await findPidByPort(spec.port);
            if (process.env.SVC_EVAL_DEBUG) console.error(`  [stop-debug] round ${round}: netstat=${netstatPid}`);
            pids = netstatPid ? [netstatPid] : [];
          }
          if (!pids.length) break;
          for (const pid of pids) {
            await killPid(pid, { graceMs: spec.graceMs || 2000, tree: true });
          }
          await sleep(500);
        }
        // final verification: poll until the port actually stops answering (max ~5s)
        for (let i = 0; i < 12; i++) {
          const alive = await fetch(`http://127.0.0.1:${spec.port}/health`, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
          if (!alive) break;
          await sleep(400);
        }
      }
      if (r.code !== 0 && !(spec && spec.port)) {
        throw new Error(`schtasks end failed: ${(r.stderr || r.stdout || "").trim()}`);
      }
      return true;
    },

    async restart(name, spec) {
      await this.stop(name, spec);
      return this.start(name);
    },

    // S3: env changes rewrite the bat's set lines (schtasks itself cannot hold env).
    async updateEnv(name, env) {
      const bat = batPath(name);
      let content = fs.readFileSync(bat, "utf8");
      for (const [k, v] of Object.entries(env)) {
        const re = new RegExp(`set "${k}=.*"\\r?\\n?`);
        const line = `set "${k}=${v}"`;
        if (re.test(content)) content = content.replace(re, line + "\r\n");
        else content = "@echo off\r\n" + line + "\r\n" + content.slice("@echo off\r\n".length);
      }
      writeAtomic(bat, content);
      await this.restart(name);
      return { bat };
    },

    async status(name, spec) {
      // Task Scheduler state lags reality: verify with the port health probe when known
      const r = await runCapture("powershell", ["-NoProfile", "-Command",
        `(Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue).State`],
      { timeoutMs: 12000 });
      const s = (r.stdout || "").trim();
      if (s === "Running") return "running";
      if (spec && spec.port) {
        try {
          const res = await fetch(`http://127.0.0.1:${spec.port}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) return "running";
        } catch (_) { /* down */ }
      }
      if (s === "Ready") return "stopped";
      return s ? "unknown" : "stopped";
    },

    async logs(name, tail) {
      const n = Number(tail || 50);
      try {
        const lines = fs.readFileSync(logPath(name), "utf8").split(/\r?\n/);
        return lines.slice(-n).join("\n");
      } catch (_) { return ""; }
    },
  };
}

module.exports = { createWinTaskPlugin };
