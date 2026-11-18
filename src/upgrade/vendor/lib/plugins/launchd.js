// lib/plugins/launchd.js - native macOS launchd plugin (user LaunchAgents, no privileges).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runCapture, writeAtomic, sleep: sleepImpl, IS_WIN } = require("../util");

const AGENTS_DIR = () => path.join(os.homedir(), "Library", "LaunchAgents");

function plistPath(name) { return path.join(AGENTS_DIR(), `${name}.plist`); }

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function plistContent(spec, logOut, logErr) {
  const args = (spec.args || []).map((a) => `      <string>${esc(a)}</string>`).join("\n");
  const env = Object.entries(spec.env || {})
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(spec.name)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(spec.cmd)}</string>
${args}
  </array>
${spec.cwd ? `  <key>WorkingDirectory</key><string>${esc(spec.cwd)}</string>\n` : ""}${env ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>\n` : ""}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(logOut)}</string>
  <key>StandardErrorPath</key><string>${esc(logErr)}</string>
</dict>
</plist>
`;
}

function createLaunchdPlugin(ctx) {
  async function detect() {
    if (process.platform !== "darwin") return false;
    const r = await runCapture("launchctl", ["version"], { timeoutMs: 5000 });
    return r.code === 0;
  }

  return {
    id: "launchd",
    platforms: ["darwin"],
    detect,

    async install(spec) {
      const dir = AGENTS_DIR();
      fs.mkdirSync(dir, { recursive: true });
      const logOut = path.join(dir, `${spec.name}.out.log`);
      const logErr = path.join(dir, `${spec.name}.err.log`);
      writeAtomic(plistPath(spec.name), plistContent(spec, logOut, logErr));
      // `bootstrap gui/$UID` is the modern API; `load` still works on macOS 11 (23-machine).
      const uid = (await runCapture("id", ["-u"], { timeoutMs: 4000 })).stdout.trim();
      let r = await runCapture("launchctl", ["bootstrap", `gui/${uid}`, plistPath(spec.name)], { timeoutMs: 10000 });
      if (r.code !== 0) {
        r = await runCapture("launchctl", ["load", "-w", plistPath(spec.name)], { timeoutMs: 10000 });
      }
      if (r.code !== 0) throw new Error(`launchctl load failed: ${(r.stderr || "").trim()}`);
      return { plist: plistPath(spec.name) };
    },

    async uninstall(name) {
      const uid = (await runCapture("id", ["-u"], { timeoutMs: 4000 })).stdout.trim();
      await runCapture("launchctl", ["bootout", `gui/${uid}/${name}`], { timeoutMs: 10000 });
      await runCapture("launchctl", ["unload", "-w", plistPath(name)], { timeoutMs: 10000 });
      try { fs.unlinkSync(plistPath(name)); } catch (_) { /* ignore */ }
      return { removed: plistPath(name) };
    },

    async start(name) {
      const r = await runCapture("launchctl", ["start", name], { timeoutMs: 10000 });
      if (r.code !== 0) throw new Error(`launchctl start failed: ${(r.stderr || "").trim()}`);
      return true;
    },

    async stop(name) {
      const r = await runCapture("launchctl", ["stop", name], { timeoutMs: 10000 });
      if (r.code !== 0) throw new Error(`launchctl stop failed: ${(r.stderr || "").trim()}`);
      return true;
    },

    async restart(name) {
      await this.stop(name);
      return this.start(name);
    },

    // S3: env changes are written into the plist EnvironmentVariables dict. launchctl
    // keeps the OLD definition loaded: bootout -> wait until the label is released ->
    // bootstrap again (the lib's own comment: bootstrapping sooner fails with I/O error)
    async updateEnv(name, env) {
      const file = plistPath(name);
      let content = fs.readFileSync(file, "utf8");
      for (const [k, v] of Object.entries(env)) {
        const keyRe = new RegExp(`(<key>${k}</key>\\s*<string>)[^<]*(</string>)`);
        if (keyRe.test(content)) content = content.replace(keyRe, `$1${esc(v)}$2`);
        else content = content.replace(/(  <key>EnvironmentVariables<\/key>\n  <dict>\n)/, `$1      <key>${k}</key>\n      <string>${esc(v)}</string>\n`);
      }
      writeAtomic(file, content);
      const uid = (await runCapture("id", ["-u"], { timeoutMs: 4000 })).stdout.trim();
      await runCapture("launchctl", ["bootout", `gui/${uid}/${name}`], { timeoutMs: 10000 });
      for (let i = 0; i < 12; i++) {
        const r = await runCapture("launchctl", ["print", `gui/${uid}/${name}`], { timeoutMs: 8000 });
        if (r.code !== 0) break; // label released
        await sleepImpl(300);
      }
      let b = await runCapture("launchctl", ["bootstrap", `gui/${uid}`, file], { timeoutMs: 10000 });
      if (b.code !== 0) b = await runCapture("launchctl", ["load", "-w", file], { timeoutMs: 10000 });
      if (b.code !== 0) throw new Error(`launchctl reload failed: ${(b.stderr || "").trim()}`);
      return { plist: file };
    },

    async status(name) {
      const r = await runCapture("launchctl", ["list", name], { timeoutMs: 8000 });
      if (r.code !== 0) return "stopped";
      const m = /"PID" = (\d+)/.exec(r.stdout || "");
      return m ? "running" : "stopped";
    },

    async logs(name, tail) {
      const n = Number(tail || 50);
      const out = path.join(AGENTS_DIR(), `${name}.out.log`);
      try {
        const lines = fs.readFileSync(out, "utf8").split("\n");
        return lines.slice(-n).join("\n");
      } catch (_) { return ""; }
    },
  };
}

module.exports = { createLaunchdPlugin };
