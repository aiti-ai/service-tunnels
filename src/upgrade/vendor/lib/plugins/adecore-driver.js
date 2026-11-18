// lib/plugins/adecore-driver.js - @adecore/service (0.67.0) LIBRARY-form plugin driver.
// The package ships no CLI (plan §2.1: drive it via a driver that implements the same
// plugin interface by calling the manager API directly).
//   linux : systemdManager        (user units, ~/.config/systemd/user)
//   win32 : taskSchedulerManager  (logon scheduled task, 1-min repetition = crash comeback)
//   darwin: launchdManager        (batch D)
// Library style: fully injected - we provide run(), files{} and paths.
"use strict";

const os = require("os");
const path = require("path");

const { runCapture, writeAtomic, IS_WIN } = require("../util");

// @adecore/service is an OPTIONAL peer: the plugin stays registered but reports
// unavailable when the package is absent (like node-pty in proc.js)
let libCache = null;
function loadLib() {
  if (libCache === null) {
    try { libCache = require("@adecore/service"); } catch (_) { libCache = false; }
  }
  return libCache || null;
}

function createAdecorePlugin(ctx) {
  const lib = loadLib() || {};
  const { systemdManager, systemdUnit, diskFiles } = lib;

  const configHome = path.join(os.homedir(), ".config");
  // the lib treats nonzero exits as failures via expectSuccess -> throw through here;
  // the lib calls run() SYNCHRONOUSLY (expectSuccess checks .code inline), so the bridge
  // must be spawnSync-based like the lib's own runCommand (fast service commands only)
  const { spawnSync } = require("child_process");
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || (result.error && result.error.message) || "" };
  };
  const files = diskFiles || {
    read: (p) => { try { return require("fs").readFileSync(p, "utf8"); } catch (_) { return null; } },
    write: (p, c) => writeAtomic(p, c),
    remove: (p) => { try { require("fs").unlinkSync(p); } catch (_) { /* ignore */ } },
    makeDirectory: (d) => require("fs").mkdirSync(d, { recursive: true }),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function resolveProgram(program) {
    if (program && !path.isAbsolute(program)) {
      const probe = IS_WIN ? "where.exe" : "which";
      const w = await runCapture(probe, [program], { timeoutMs: 4000 });
      const first = (w.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) return first;
    }
    return program;
  }

  // ---------------- darwin: launchd user agent (KeepAlive = crash comeback) ----------------
  async function uidOf() {
    const r = await runCapture("id", ["-u"], { timeoutMs: 4000 });
    return parseInt((r.stdout || "").trim(), 10) || 501;
  }

  async function launchdMgrFor(spec) {
    const uid = await uidOf();
    const logFile = path.join(os.homedir(), ".svc-assistant", "adecore-launchd", `${spec.name}.log`);
    return {
      mgr: lib.launchdManager({
        home: os.homedir(),
        service: { label: spec.name, logFile },
        uid, run, files, sleep,
      }),
      logFile,
    };
  }

  async function darwinStatus(name) {
    // launchctl print gui/<uid>/<label> -> state; fall back to port health by caller
    const uid = await uidOf();
    const r = await runCapture("launchctl", ["print", `gui/${uid}/${name}`], { timeoutMs: 10000 });
    if (r.code !== 0) return "stopped";
    const m = /state = (\w+)/.exec(r.stdout || "");
    if (m && m[1] === "running") return "running";
    return m ? "stopped" : "unknown";
  }

  // ---------------- win32: scheduled task ----------------
  async function winManagerFor(spec) {
    const tasksDir = path.join(os.homedir(), ".svc-assistant", "adecore-tasks");
    const logFile = path.join(tasksDir, `${spec.name}.out.log`);
    const definition = lib.scheduledTask({
      label: spec.name,
      user: os.userInfo().username,
      scriptDirectory: tasksDir,
      description: spec.description || spec.name,
      program: await resolveProgram(spec.cmd),
      args: spec.args || [],
      environment: spec.env || {},
      workingDirectory: spec.cwd || process.cwd(),
      logFile,
    });
    return {
      mgr: lib.taskSchedulerManager({
        definitionFile: path.join(tasksDir, `${spec.name}.task.xml`),
        service: { label: spec.name, logFile },
        run, files, sleep,
      }),
      definition,
      logFile,
    };
  }

  async function winStatus(name, spec) {
    // Task Scheduler state LAGS reality (shows "Ready" while the spawned process is
    // alive): treat the port health probe as the source of truth when a port is known.
    const ps = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue).State`],
    { timeoutMs: 12000 });
    const state = (ps.stdout || "").trim();
    if (state === "Running") return "running";
    if (!state) return "stopped";
    if (spec && spec.port) {
      try {
        const res = await fetch(`http://127.0.0.1:${spec.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return "running";
      } catch (_) { /* down */ }
    }
    return state === "Ready" ? "stopped" : "unknown";
  }

  // ---------------- linux: systemd user units ----------------
  function managerFor(name) {
    return systemdManager({ unitName: `${name}.service`, configHome, run, files, user: os.userInfo().username });
  }

  async function unitDefinition(spec) {
    return systemdUnit({
      description: spec.description || spec.name,
      program: await resolveProgram(spec.cmd),
      args: spec.args || [],
      environment: spec.env || {},
      workingDirectory: spec.cwd || process.cwd(),
    });
  }

  async function launchdDefinition(spec) {
    return lib.launchAgentPlist({
      label: spec.name,
      program: await resolveProgram(spec.cmd),
      args: spec.args || [],
      environment: spec.env || {},
      workingDirectory: spec.cwd || process.cwd(),
      logFile: path.join(os.homedir(), ".svc-assistant", "adecore-launchd", `${spec.name}.log`),
    });
  }

  return {
    id: "adecore(driver)",
    platforms: ["linux", "darwin", "win32"],
    detect: async () => !!loadLib(),

    // spec: {name, cmd(abs node or "node"), args, cwd, env, description}
    async install(spec) {
      if (IS_WIN) {
        const { mgr, definition } = await winManagerFor(spec);
        mgr.install(definition);
        return { kind: "scheduled-task" };
      }
      if (process.platform === "darwin") {
        const { mgr } = await launchdMgrFor(spec);
        mgr.install(await launchdDefinition(spec));
        return { kind: "launchd-plist" };
      }
      const mgr = managerFor(spec.name);
      mgr.install(await unitDefinition(spec)); // throws on systemctl failure; returns changed?
      return { unit: mgr.path };
    },

    async uninstall(name, spec) {
      if (IS_WIN) {
        const { mgr } = await winManagerFor({ name, cwd: spec && spec.cwd, env: spec && spec.env, cmd: spec && spec.cmd, args: spec && spec.args });
        try { mgr.stop(); } catch (_) { /* already stopped */ }
        mgr.uninstall();
        return { kind: "scheduled-task" };
      }
      if (process.platform === "darwin") {
        const { mgr } = await launchdMgrFor({ name });
        try { mgr.stop(); } catch (_) { /* not loaded */ }
        mgr.uninstall();
        return { kind: "launchd-plist" };
      }
      const mgr = managerFor(name);
      // lib semantics: uninstalling does NOT stop a running job - stop first ourselves
      try { mgr.stop(); } catch (_) { /* already stopped */ }
      mgr.uninstall();
      return { removed: mgr.path };
    },

    async start(name, spec) {
      if (IS_WIN) { (await winManagerFor({ name })).mgr.start(); return true; }
      if (process.platform === "darwin") { (await launchdMgrFor({ name })).mgr.start(); return true; }
      managerFor(name).start(); return true;
    },
    async stop(name, spec) {
      if (IS_WIN) { (await winManagerFor({ name })).mgr.stop(); return true; }
      if (process.platform === "darwin") { (await launchdMgrFor({ name })).mgr.stop(); return true; }
      managerFor(name).stop(); return true;
    },
    async restart(name, spec) {
      if (IS_WIN) { await (await winManagerFor({ name })).mgr.restart(); return true; }
      if (process.platform === "darwin") { await (await launchdMgrFor({ name })).mgr.restart(); return true; }
      await managerFor(name).restart(); return true;
    },

    // regenerating the definition with the merged env overwrites the unit (lib install
    // reloads only when content changed), then restart applies it
    async updateEnv(name, env, spec) {
      if (!spec) throw new Error("adecore updateEnv needs the install spec (regenerate definition)");
      const merged = { ...spec, env: { ...(spec.env || {}), ...env } };
      await this.install(merged);
      await this.restart(name, spec);
      return { via: IS_WIN ? "task-xml-regenerate" : process.platform === "darwin" ? "plist-regenerate" : "definition-regenerate" };
    },

    async status(name, spec) {
      if (IS_WIN) return winStatus(name, spec);
      if (process.platform === "darwin") {
        const st = darwinStatus(name);
        if (st === "running") return "running";
        if (spec && spec.port) {
          try {
            const res = await fetch(`http://127.0.0.1:${spec.port}/health`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return "running";
          } catch (_) { /* down */ }
        }
        return st;
      }
      const r = await runCapture("systemctl", ["--user", "is-active", `${name}.service`], { timeoutMs: 8000 });
      const out = (r.stdout || "").trim();
      if (out === "active") return "running";
      if (out === "inactive" || out === "failed") return "stopped";
      return "unknown";
    },

    async logs(name, tail, spec) {
      if (IS_WIN) {
        const { logFile } = winManagerFor({ name });
        try {
          const lines = require("fs").readFileSync(logFile, "utf8").split(/\r?\n/);
          return lines.slice(-Number(tail || 50)).join("\n");
        } catch (_) { return ""; }
      }
      if (process.platform === "darwin") {
        const { logFile } = await launchdMgrFor({ name });
        try {
          const lines = require("fs").readFileSync(logFile, "utf8").split(/\r?\n/);
          return lines.slice(-Number(tail || 50)).join("\n");
        } catch (_) { return ""; }
      }
      const r = await runCapture("journalctl", ["--user", "-u", `${name}.service`, "-n", String(tail || 50), "--no-pager"], { timeoutMs: 10000 });
      return r.stdout || "";
    },

    // T5: registration check (no reboot)
    async enabled(name) {
      if (IS_WIN) {
        const r = await runCapture("schtasks.exe", ["/Query", "/TN", name], { timeoutMs: 10000 });
        if (r.code !== 0) return "not-registered";
        const st = await winStatus(name);
        return st === "unknown" ? "registered" : "registered-enabled";
      }
      if (process.platform === "darwin") {
        const uid = await uidOf();
        const r = await runCapture("launchctl", ["print", `gui/${uid}/${name}`], { timeoutMs: 10000 });
        return r.code === 0 ? "registered-enabled" : "not-registered";
      }
      const r = await runCapture("systemctl", ["--user", "is-enabled", `${name}.service`], { timeoutMs: 8000 });
      return (r.stdout || "").trim();
    },
  };
}

module.exports = { createAdecorePlugin };
