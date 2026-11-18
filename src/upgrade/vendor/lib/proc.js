// lib/proc.js - process helpers: command runner (optional pty), byPort stop,
// detached parent spawn with console streaming and stdin write.
"use strict";

const { spawn } = require("child_process");
const { createRequire } = require("module");
const path = require("path");

const { IS_WIN, sleep, findPidByPort, killPid } = require("./util");

const WIN_SHIM_CMDS = new Set(["npm", "npx", "pnpm", "yarn", "st", "sts", "service-tunnels"]);

// node-pty is an OPTIONAL dependency: resolve it relative to the assistant root only.
function tryLoadPty(assistantRoot) {
  try {
    const req = createRequire(path.join(assistantRoot, "package.json"));
    const ptyPath = req.resolve("node-pty");
    return require(ptyPath);
  } catch (_) {
    return null;
  }
}

// On win32, spawn .cmd/.bat shims (npm/npx/...) requires shell:true (Node >=18.20, EINVAL otherwise).
function spawnOpts(cmd) {
  const base = (IS_WIN ? path.win32.basename(cmd) : path.basename(cmd)).toLowerCase().replace(/\.exe$/, "");
  if (IS_WIN && (cmd.endsWith(".cmd") || cmd.endsWith(".bat") || WIN_SHIM_CMDS.has(base))) {
    return { shell: true };
  }
  return {};
}

function splitLines(chunk, rest) {
  const out = [];
  let buf = rest + chunk.toString("utf8");
  // tolerate GBK-ish mojibake losslessly: we keep utf8; replacement chars are display-only
  for (;;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    let line = buf.slice(0, i);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    out.push(line);
    buf = buf.slice(i + 1);
  }
  return { lines: out, rest: buf };
}

// Run one command, stream its output lines via onLine(src, line), return {code, signal, ms, timedOut}.
// spec: {cmd, args, cwd, env, pty, timeoutMs}
async function runCommand(spec, onLine) {
  const started = Date.now();
  const emit = (src, text) => { if (onLine) onLine(src, text); };

  // --- pty path (real TTY: colors / progress bars / interactive prompts work) ---
  if (spec.pty && spec.ptyModule && !IS_WIN) {
    const pty = spec.ptyModule;
    return await new Promise((resolve) => {
      let timedOut = false;
      let term = null;
      const timer = spec.timeoutMs ? setTimeout(() => { timedOut = true; try { term && term.kill(); } catch (_) {} }, spec.timeoutMs) : null;
      try {
        term = pty.spawn(spec.cmd, spec.args || [], {
          name: "xterm-256color",
          cols: 120, rows: 40,
          cwd: spec.cwd || process.cwd(),
          env: { ...process.env, ...(spec.env || {}), TERM: "xterm-256color" },
        });
      } catch (e) {
        if (timer) clearTimeout(timer);
        emit("assistant", `[runCommand] pty spawn failed: ${e.message}, falling back to pipe spawn`);
        spec.pty = false;
        resolve(runCommand(spec, onLine));
        return;
      }
      term.onData((d) => {
        const { lines, rest } = splitLines(d, (term.__rest = term.__rest || ""));
        term.__rest = rest;
        for (const l of lines) emit("parent", l);
        if (rest && rest.length > 4096) { emit("parent", rest); term.__rest = ""; }
      });
      term.onExit(({ exitCode, signal }) => {
        if (timer) clearTimeout(timer);
        if (term.__rest) emit("parent", term.__rest);
        resolve({ code: exitCode, signal, ms: Date.now() - started, timedOut });
      });
    });
  }

  // --- pipe path ---
  return await new Promise((resolve) => {
    let timedOut = false;
    let child;
    try {
      child = spawn(spec.cmd, spec.args || [], {
        cwd: spec.cwd || process.cwd(),
        env: { ...process.env, ...(spec.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group on posix -> tree kill via killPid(pid)
        windowsHide: true,
        ...spawnOpts(spec.cmd),
      });
    } catch (e) {
      emit("assistant", `[runCommand] spawn failed: ${e.message}`);
      resolve({ code: 127, signal: null, ms: Date.now() - started, timedOut: false, spawnError: e.message });
      return;
    }
    let restOut = "", restErr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      const { lines, rest } = splitLines(d, restOut); restOut = rest;
      for (const l of lines) emit(spec.cmd, l);
    });
    child.stderr.on("data", (d) => {
      const { lines, rest } = splitLines(d, restErr); restErr = rest;
      for (const l of lines) emit(spec.cmd + ":err", l);
    });
    const timer = spec.timeoutMs ? setTimeout(() => {
      timedOut = true;
      killPid(child.pid, { graceMs: 2000, tree: true });
    }, spec.timeoutMs) : null;

    const finish = (code, signal, spawnError) => {
      if (timer) clearTimeout(timer);
      if (restOut) emit(spec.cmd, restOut);
      if (restErr) emit(spec.cmd + ":err", restErr);
      resolve({ code, signal, ms: Date.now() - started, timedOut, spawnError });
    };
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// Start the parent (manual form): detached, own session, console streamed, stdin writable.
// pty optional (plan §3.3); pty handle exposes write() for the /parent/input endpoint.
function spawnParent(spec, onLine, ptyModule) {
  const emit = (src, text) => { if (onLine) onLine(src, text); };
  if (spec.pty && ptyModule && !IS_WIN) {
    const pty = ptyModule;
    const term = pty.spawn(spec.cmd, spec.args || [], {
      name: "xterm-256color", cols: 120, rows: 40,
      cwd: spec.cwd || process.cwd(),
      env: { ...process.env, ...(spec.env || {}), TERM: "xterm-256color" },
    });
    term.onData((d) => {
      const { lines, rest } = splitLines(d, (term.__rest = term.__rest || ""));
      term.__rest = rest;
      for (const l of lines) emit("parent", l);
    });
    return { pid: term.pid, ptyHandle: term, mode: "pty" };
  }
  const child = spawn(spec.cmd, spec.args || [], {
    cwd: spec.cwd || process.cwd(),
    env: { ...process.env, ...(spec.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
    ...spawnOpts(spec.cmd),
  });
  let restOut = "", restErr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    const { lines, rest } = splitLines(d, restOut); restOut = rest;
    for (const l of lines) emit("parent", l);
  });
  child.stderr.on("data", (d) => {
    const { lines, rest } = splitLines(d, restErr); restErr = rest;
    for (const l of lines) emit("parent:err", l);
  });
  child.on("error", (e) => emit("assistant", `[parent] spawn error: ${e.message}`));
  return { pid: child.pid, handle: child, mode: "pipe" };
}

function writeParentInput(parent, data) {
  if (!parent) return false;
  if (parent.ptyHandle) { parent.ptyHandle.write(String(data)); return true; }
  if (parent.handle && parent.handle.stdin && parent.handle.stdin.writable) {
    parent.handle.stdin.write(String(data));
    return true;
  }
  return false;
}

// Stop the parent by port: SIGTERM -> grace -> SIGKILL (win32: taskkill tree immediately).
async function stopByPort(port, graceMs, onLine) {
  const pid = await findPidByPort(port);
  if (!pid) return { stopped: false, reason: "no listener" };
  if (onLine) onLine("assistant", `stop byPort: pid=${pid} SIGTERM (grace ${graceMs}ms)`);
  await killPid(pid, { graceMs });
  // wait for the port to actually free up (max ~3s)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const still = await findPidByPort(port);
    if (!still) return { stopped: true, pid };
    await sleep(150);
  }
  return { stopped: false, reason: `port still held by pid ${await findPidByPort(port)}` };
}

module.exports = { tryLoadPty, runCommand, spawnParent, writeParentInput, stopByPort, spawnOpts };
