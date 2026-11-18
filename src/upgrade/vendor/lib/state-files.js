// lib/state-files.js - upgrade lock (~/.svc-assistant/lock.json) and history reports
// (plan §3.5: lock written from SWAP_ASS with phase snapshot; history persisted to
// ~/.svc-assistant/history/<ts>.json, unaffected by run-dir self-pruning).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { writeAtomic, readJsonSafe, tsCompact } = require("./util");

const BASE_DIR = () => path.join(os.homedir(), ".svc-assistant");
const LOCK_FILE = () => path.join(BASE_DIR(), "lock.json");
const HISTORY_DIR = () => path.join(BASE_DIR(), "history");

function readLock() { return readJsonSafe(LOCK_FILE()); }

function writeLock(patch) {
  const cur = readLock() || {};
  const next = { ...cur, ...patch, ts: new Date().toISOString(), pid: process.pid };
  writeAtomic(LOCK_FILE(), JSON.stringify(next, null, 2));
  return next;
}

function clearLock() {
  try { fs.unlinkSync(LOCK_FILE()); } catch (_) { /* already gone */ }
}

function lockIsStale() {
  const lock = readLock();
  if (!lock) return null;
  const alive = lock.pid && lock.pid !== process.pid
    ? (() => { try { process.kill(lock.pid, 0); return true; } catch (_) { return false; } })()
    : false;
  return { lock, ownerAlive: alive };
}

function writeHistory(report) {
  const dir = HISTORY_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tsCompact()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

module.exports = { BASE_DIR, LOCK_FILE, HISTORY_DIR, readLock, writeLock, clearLock, lockIsStale, writeHistory };
