// lib/plugins/systemd.js - native systemd plugin (user + system scope auto-detect).
// Permission model (plan §3.1): default user; system-level units get temporary sudo
// (cached session / NOPASSWD first; never interactive; sudoAskPass as fallback).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { runCapture, writeAtomic, sleep, IS_WIN } = require("../util");

const USER_DIR = () => path.join(os.homedir(), ".config", "systemd", "user"); // user-scope unit dir
const SYSTEM_DIR = "/etc/systemd/system";

function unitName(name) { return name.endsWith(".service") ? name : `${name}.service`; }

function quoteArg(a) {
  if (/[\s"']/ .test(a)) return `"${String(a).replace(/"/g, '\\"')}"`;
  return String(a);
}

async function unitContent(spec) {
  spec = { ...spec, cmd: await resolveAbs(spec.cmd) };
  const envLines = Object.entries(spec.env || {})
    .map(([k, v]) => `Environment=${k}=${quoteArg(v)}`)
    .join("\n");
  const exec = [spec.cmd, ...(spec.args || [])].map(quoteArg).join(" ");
  return [
    "[Unit]",
    `Description=${spec.description || spec.name}`,
    "After=network.target",
    "",
    "[Service]",
    `Type=simple`,
    `ExecStart=${exec}`,
    spec.cwd ? `WorkingDirectory=${spec.cwd}` : null,
    envLines || null,
    "Restart=on-failure",
    "RestartSec=2",
    "KillSignal=SIGTERM",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].filter((l) => l !== null).join("\n");
}

async function writeFilePrivileged(file, content, sudoOpts, log) {
  // system scope: write via `sudo tee` (sudo -n first; -A with SUDO_ASKPASS when configured)
  const args = sudoOpts && sudoOpts.askPass ? ["-A"] : ["-n"];
  return await new Promise((resolve) => {
    const child = spawn("sudo", [...args, "tee", file], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ ok: false, err: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, err: err || `exit ${code}` }));
    child.stdin.write(content);
    child.stdin.end();
  });
}

function sudoEnv(sudoOpts) {
  const env = { ...process.env };
  if (sudoOpts && sudoOpts.askPass) env.SUDO_ASKPASS = sudoOpts.askPass;
  return env;
}

async function resolveAbs(program) {
  if (program && !path.isAbsolute(program)) {
    // systemd ExecStart requires an absolute binary: resolve bare names via PATH
    const probe = IS_WIN ? "where.exe" : "which";
    const w = await runCapture(probe, [program], { timeoutMs: 4000 });
    const first = (w.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return program;
}

function createSystemdPlugin(ctx) {
  // ctx: { log(), assistantRoot, sudoOpts }
  async function detect() {
    const r = await runCapture("systemctl", ["--user", "is-system-running"], { timeoutMs: 5000 });
    // any structured answer (running/degraded/...) counts; ENOENT/127 -> unavailable
    if (r.err && r.err.code === "ENOENT") return false;
    if (r.code === 127) return false;
    return true;
  }

  async function findScope(name) {
    const u = name.endsWith(".service") ? name : `${name}.service`;
    const user = await runCapture("systemctl", ["--user", "cat", u], { timeoutMs: 5000 });
    if (user.code === 0) return { scope: "user", unit: u };
    const sys = await runCapture("systemctl", ["cat", u], { timeoutMs: 5000 });
    if (sys.code === 0) return { scope: "system", unit: u };
    return null;
  }

  async function ctl(scope, args) {
    if (scope === "user") {
      return runCapture("systemctl", ["--user", ...args], { timeoutMs: 20000 });
    }
    // system scope: try plain first (NOPASSWD sessions may allow direct), then sudo
    let r = await runCapture("systemctl", args, { timeoutMs: 20000 });
    if (r.code === 0) return r;
    const sudoArgs = ctx.sudoOpts && ctx.sudoOpts.askPass ? ["-A"] : ["-n"];
    r = await runCapture("sudo", [...sudoArgs, "systemctl", ...args], {
      timeoutMs: 20000, spawn: { env: sudoEnv(ctx.sudoOpts) },
    });
    if (r.code !== 0 && ctx.log) {
      ctx.log("warn", `system-scope systemctl needs privileges; manual command: sudo systemctl ${args.join(" ")}`);
    }
    return r;
  }

  async function unitFilePath(name, scope) {
    const u = unitName(name);
    if (scope === "system") return path.join(SYSTEM_DIR, u);
    // user unit dirs
    const dir = USER_DIR();
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, u);
  }

  return {
    id: "systemd",
    platforms: ["linux"],
    detect,

    async install(spec) {
      let scope = "user";
      try {
        // existing unit? keep its scope
        const found = await findScope(spec.name);
        if (found) scope = found.scope;
      } catch (_) { /* default user */ }
      const file = await unitFilePath(spec.name, scope);
      const content = await unitContent(spec);
      if (scope === "system") {
        const w = await writeFilePrivileged(file, content, ctx.sudoOpts, ctx.log);
        if (!w.ok) throw new Error(`cannot write system unit ${file}: ${w.err} (need sudo)`);
      } else {
        writeAtomic(file, content);
      }
      await ctl(scope, ["daemon-reload"]);
      await ctl(scope, ["enable", unitName(spec.name)]);
      return { scope, unit: file };
    },

    async uninstall(name) {
      const found = await findScope(name);
      if (!found) return { skipped: "unit not found" };
      await ctl(found.scope, ["disable", "--now", found.unit]);
      const file = await unitFilePath(name, found.scope);
      if (found.scope === "system") {
        await runCapture("sudo", ["-n", "rm", "-f", file], { timeoutMs: 8000 });
      } else {
        try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
      }
      await ctl(found.scope, ["daemon-reload"]);
      return { removed: file };
    },

    async start(name) {
      const found = await findScope(name);
      if (!found) throw new Error(`systemd unit not found: ${name}`);
      const r = await ctl(found.scope, ["start", found.unit]);
      if (r.code !== 0) throw new Error(`systemctl start failed: ${(r.stderr || r.stdout || "").trim()}`);
      return true;
    },

    async stop(name) {
      const found = await findScope(name);
      if (!found) return { skipped: "unit not found" };
      const r = await ctl(found.scope, ["stop", found.unit]);
      if (r.code !== 0) throw new Error(`systemctl stop failed: ${(r.stderr || r.stdout || "").trim()}`);
      return true;
    },

    async restart(name) {
      const found = await findScope(name);
      if (!found) throw new Error(`systemd unit not found: ${name}`);
      const r = await ctl(found.scope, ["restart", found.unit]);
      if (r.code !== 0) throw new Error(`systemctl restart failed: ${(r.stderr || r.stdout || "").trim()}`);
      return true;
    },

    // S3 (plan §1.2): env changes are written directly into the unit definition.
    async updateEnv(name, env) {
      const found = await findScope(name);
      if (!found) throw new Error(`systemd unit not found: ${name}`);
      const file = await unitFilePath(name, found.scope);
      let content;
      if (found.scope === "system") {
        const r = await runCapture("sudo", ["-n", "cat", file], { timeoutMs: 8000 });
        content = r.stdout;
        if (!content) throw new Error(`cannot read system unit ${file}: ${r.stderr || "empty"}`);
      } else {
        content = fs.readFileSync(file, "utf8");
      }
      for (const [k, v] of Object.entries(env)) {
        const re = new RegExp(`^Environment=${k}=.*$`, "m");
        const line = `Environment=${k}=${quoteArg(v)}`;
        if (re.test(content)) content = content.replace(re, line);
        else content = content.replace(/\[Service\]\n/, `[Service]\n${line}\n`);
      }
      if (found.scope === "system") {
        const w = await writeFilePrivileged(file, content, ctx.sudoOpts, ctx.log);
        if (!w.ok) throw new Error(`cannot rewrite system unit ${file}: ${w.err}`);
      } else {
        writeAtomic(file, content);
      }
      await ctl(found.scope, ["daemon-reload"]);
      return { unit: file, scope: found.scope };
    },

    async status(name) {
      const found = await findScope(name);
      if (!found) return "unknown";
      const r = await ctl(found.scope, ["is-active", found.unit]);
      const out = (r.stdout || "").trim();
      if (out === "active") return "running";
      if (out === "inactive" || out === "failed") return "stopped";
      return "unknown";
    },

    async logs(name, tail) {
      const found = await findScope(name);
      if (!found) return "";
      const n = String(tail || 50);
      const r = await ctl(found.scope, ["journalctl", "-u", found.unit, "-n", n, "--no-pager"]);
      return r.stdout || "";
    },
  };
}

module.exports = { createSystemdPlugin, unitContent, unitName };
