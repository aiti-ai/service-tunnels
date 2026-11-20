// lib/swap.js - release pointer switching (symlink | junction | copy | auto).
// Plan §3.2: dir-swap mode flips a "releases/current" pointer; rollback flips it back.
"use strict";

const fs = require("fs");
const path = require("path");

const { IS_WIN } = require("./util");

function resolveMode(mode) {
  if (!mode || mode === "auto") return IS_WIN ? "junction" : "symlink";
  return mode;
}

// Read what "current" points at now (null when absent).
// Relative link targets resolve against the LINK's directory (symlink semantics) -
// the raw readlink text resolves against the process cwd (the assistant run dir),
// which made rollbacks look for <runDir>/v1.0.0 and fail.
function currentTarget(currentDir) {
  try {
    const st = fs.lstatSync(currentDir);
    if (st.isSymbolicLink()) {
      const raw = fs.readlinkSync(currentDir);
      return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(path.dirname(currentDir), raw);
    }
    if (st.isDirectory()) return currentDir; // plain copy mode: current is a real dir
    return null;
  } catch (_) {
    return null;
  }
}

// switchPointer(releases/current, releases/v2.0.0, "auto") -> {from, to, mode}
function switchPointer(currentDir, targetDir, mode) {
  const eff = resolveMode(mode);
  const from = currentTarget(currentDir);
  const absTarget = path.resolve(targetDir);
  if (!fs.existsSync(absTarget)) throw new Error(`release dir missing: ${absTarget}`);

  if (eff === "copy") {
    fs.rmSync(currentDir, { recursive: true, force: true });
    fs.cpSync(absTarget, currentDir, { recursive: true });
    return { from, to: absTarget, mode: eff };
  }

  // symlink / junction: build a temp link then swap it in (posix rename is atomic).
  const parent = path.dirname(currentDir);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(currentDir)}.${process.pid}.tmp`);
  try { fs.rmSync(tmp, { force: true, recursive: true }); } catch (_) { /* ignore */ }
  fs.symlinkSync(absTarget, tmp, eff === "junction" ? "junction" : "dir");
  if (IS_WIN) {
    // Windows cannot rename over an existing reparse point reliably: unlink first (tiny window).
    try { fs.rmSync(currentDir, { force: true, recursive: true }); } catch (_) { /* ignore */ }
  }
  fs.renameSync(tmp, currentDir);
  return { from, to: absTarget, mode: eff };
}

module.exports = { switchPointer, currentTarget, resolveMode };
