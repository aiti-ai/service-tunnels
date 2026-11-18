#!/usr/bin/env node
// lib/svc-host.js - Windows service host wrapper (modeled on unitup's windows-host idea).
// sc.exe cannot express `binPath= node.exe script.js --flag ...` without quoting hell
// (sc absorbs args itself), cannot set a working directory, cannot hold env and cannot
// capture stdout. This host solves all four: the service binary is
//   binPath= <node.exe> <svc-host.js> <name>
// and everything variable lives in ~/.svc-assistant/win-services/<name>.json:
//   { cwd, cmd, args, env, logFile }
// The host spawns the real service (env applied), tees stdout/stderr into logFile, and
// exits 0 when the child dies (a clean exit - sc failure recovery only fires on crashes).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const NAME = process.argv[2];
if (!NAME || /[/\\:]/.test(NAME)) {
  console.error("usage: node svc-host.js <name>  (name must be a bare token)");
  process.exit(2);
}

const SPEC_FILE = path.join(os.homedir(), ".svc-assistant", "win-services", `${NAME}.json`);
let spec;
try {
  spec = JSON.parse(fs.readFileSync(SPEC_FILE, "utf8"));
} catch (e) {
  console.error(`[svc-host] cannot read spec ${SPEC_FILE}: ${e.message}`);
  process.exit(2);
}

const logStream = fs.createWriteStream(spec.logFile, { flags: "a" });
const stamp = () => new Date().toISOString().slice(11, 19);
const line = (s) => { try { logStream.write(`[${stamp()}] ${s}\n`); } catch (_) { /* ignore */ } };

line(`[svc-host] ${NAME} starting: ${spec.cmd} ${(spec.args || []).join(" ")} (cwd=${spec.cwd})`);

// EPIPE guard: the log stream is ours, but stdio may vanish when SCM kills us
for (const s of [process.stdout, process.stderr]) s.on("error", () => {});

const child = spawn(spec.cmd, spec.args || [], {
  cwd: spec.cwd || process.cwd(),
  env: { ...process.env, ...(spec.env || {}) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
line(`[svc-host] child pid=${child.pid}`);

child.stdout.on("data", (d) => logStream.write(d));
child.stderr.on("data", (d) => logStream.write(d));
child.on("error", (e) => line(`[svc-host] child spawn error: ${e.message}`));
child.on("close", (code, signal) => {
  line(`[svc-host] child exited code=${code} signal=${signal || ""} - host exits`);
  try { logStream.end(); } catch (_) { /* ignore */ }
  // clean exit: sc failure recovery must NOT fire for a managed stop
  process.exit(0);
});
