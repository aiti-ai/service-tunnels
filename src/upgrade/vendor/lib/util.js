// lib/util.js - small shared helpers (zero dependency).
"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const IS_WIN = process.platform === "win32";

// "5000" -> 5000ms; "60s" -> 60000; "10m" -> 600000; "2h" -> 7200000
function parseDuration(v, defMs) {
  if (v === undefined || v === null || v === "") return defMs;
  if (typeof v === "number") return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(v));
  if (!m) throw new Error(`invalid duration: ${JSON.stringify(v)}`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  return Math.round(n * (unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// Atomic-ish write: write to temp file then rename over target (§0.5 of windows-compat:
// never "rename the old one away first"; if rename fails the original stays intact).
function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function ts() { return new Date().toISOString(); }
function tsCompact(d) {
  const t = d || new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
}

// Tiny jsonpath: "$.version", "$.data.items[0].name"
function resolveJsonPath(obj, expr) {
  const clean = String(expr || "").replace(/^\$\.?/, "");
  if (!clean) return obj;
  let cur = obj;
  for (const seg of clean.split(".")) {
    const m = /^([^\[\]]+)((?:\[\d+\])*)$/.exec(seg);
    if (!m) throw new Error(`unsupported jsonpath segment: ${seg}`);
    const [, key, idxs] = m;
    cur = cur == null ? cur : cur[key];
    if (idxs) {
      for (const ix of idxs.match(/\[\d+\]/g)) {
        cur = cur == null ? cur : cur[parseInt(ix.slice(1, -1), 10)];
      }
    }
  }
  return cur;
}

function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: opts.timeoutMs || 8000,
      encoding: "buffer",
      windowsHide: true,
      ...opts.spawn,
    }, (err, stdout, stderr) => {
      const dec = (b) => { try { return b ? b.toString("utf8") : ""; } catch (_) { return ""; } };
      resolve({ code: err && err.code !== undefined ? err.code : (err ? 1 : 0), stdout: dec(stdout), stderr: dec(stderr), err });
    });
  });
}

// --- find the pid listening on a TCP port (three-platform dispatch; see windows-compat §1) ---
async function findPidByPort(port) {
  const p = parseInt(port, 10);
  if (!p) return null;
  if (IS_WIN) {
    // netstat -ano: status column stays ASCII "LISTENING" even on localized Windows.
    const r = await runCapture("netstat", ["-ano"], { timeoutMs: 6000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1];
      const m = /:(\d+)$/.exec(local);
      if (m && parseInt(m[1], 10) === p) return parseInt(cols[4], 10) || null;
    }
    return null;
  }
  // linux: ss -ltnp (may lack pid= without privileges) -> fallback lsof
  const ss = await runCapture("ss", ["-ltnp"], { timeoutMs: 6000 });
  for (const line of ss.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${p} `) && !line.endsWith(`:${p}`)) continue;
    const m = /pid=(\d+)/.exec(line);
    if (m) return parseInt(m[1], 10);
  }
  const lsof = await runCapture("lsof", ["-t", "-iTCP:" + p, "-sTCP:LISTEN"], { timeoutMs: 6000 });
  const first = lsof.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first ? parseInt(first, 10) : null;
}

// Kill a process; on win32 always tree-kill via taskkill (process.kill(SIGTERM) is a hard
// kill there and spares children). On posix SIGTERM first, escalate to SIGKILL after graceMs.
async function killPid(pid, { graceMs = 3000, tree = false } = {}) {
  if (!pid) return;
  if (IS_WIN) {
    await runCapture("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 8000 });
    return;
  }
  const kill = (sig) => { try { process.kill(tree ? -pid : pid, sig); } catch (_) { /* gone */ } };
  kill("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await sleep(100);
  }
  kill("SIGKILL");
  await sleep(150);
}

module.exports = {
  IS_WIN,
  parseDuration,
  sleep,
  isAlive,
  writeAtomic,
  readJsonSafe,
  ts,
  tsCompact,
  resolveJsonPath,
  runCapture,
  findPidByPort,
  killPid,
  homedir: () => os.homedir(),
};
