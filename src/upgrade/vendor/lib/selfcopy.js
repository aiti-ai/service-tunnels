// lib/selfcopy.js - self-host isolation (plan §3.6): copy the assistant's own code +
// optional deps into an independent run dir BEFORE touching the upgrade target, so
// git pull / npm ci / build / artifact swap can never hurt the running assistant.
"use strict";

const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["releases", "gitmock", "proto", ".git"]);
// NOTE: bin/ (nssm etc.) IS copied - the isolated copy must resolve the same service
// backend as the boot context (nssm vs sc+svc-host mismatch breaks T-env, batch C).

// assistantRoot = directory containing assistant.js
function copyAssistant(assistantRoot, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(assistantRoot, { withFileTypes: true });
  let files = 0, dirs = 0;
  const copyRec = (src, dst) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        fs.mkdirSync(d, { recursive: true });
        dirs++;
        copyRec(s, d);
      } else if (e.isFile()) {
        fs.copyFileSync(s, d);
        files++;
      }
    }
  };
  copyRec(assistantRoot, targetDir);
  return { targetDir, files, dirs };
}

// Keep only the most recent N run dirs (plan §3.6: keep last 3 for troubleshooting).
function pruneRunDirs(baseDir, keep = 3, excludeDir) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(baseDir); } catch (_) { return 0; }
  const runs = names
    .filter((n) => /^run-\d{8}-\d{6}/.test(n))
    .map((n) => ({ n, full: path.join(baseDir, n), mt: fs.statSync(path.join(baseDir, n)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt)
    .filter((r) => r.full !== excludeDir);
  for (const r of runs.slice(keep)) {
    try { fs.rmSync(r.full, { recursive: true, force: true }); removed++; } catch (_) { /* busy -> keep */ }
  }
  return removed;
}

module.exports = { copyAssistant, pruneRunDirs };
