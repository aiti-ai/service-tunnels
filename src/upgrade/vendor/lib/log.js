// lib/log.js - events JSONL persistence + in-memory rings + SSE hub.
"use strict";

const fs = require("fs");
const path = require("path");
const { ts } = require("./util");

const LOG_RING = 200;     // assistant events kept in memory for SSE replay
const CONSOLE_RING = 500; // parent console lines (per plan §3.3)
const VERIFY_RING = 50;   // verify probe attempts

function createLog(runDir) {
  const eventsFile = path.join(runDir, "events.jsonl");
  fs.mkdirSync(runDir, { recursive: true });
  const stream = fs.createWriteStream(eventsFile, { flags: "a" });

  const logs = [];     // {ts, level, msg, extra}
  const console_ = []; // {ts, src, text}  (raw text incl. ANSI escapes)
  const verifies = []; // {n, ts, code, ms, extracted, ok}
  const phases = [];   // {phase, status, ts, ms, detail} timeline
  const state = {};    // phase -> "run"|"done"|"fail"|"skip"

  const subscribers = new Set();
  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }
  function broadcast(type, data) {
    for (const fn of subscribers) {
      try { fn({ type, data }); } catch (_) { /* subscriber error must not break the loop */ }
    }
  }

  function appendEvent(obj) {
    obj.ts = obj.ts || ts();
    try { stream.write(JSON.stringify(obj) + "\n"); } catch (_) { /* persistence best-effort */ }
    return obj;
  }

  function log(level, msg, extra) {
    const e = appendEvent({ type: "log", level, msg, extra });
    logs.push(e);
    if (logs.length > LOG_RING) logs.shift();
    broadcast("log", e);
    // mirror to boot console (captured in boot.log when isolated)
    process.stderr.write(`[${ts().slice(11, 19)}] [${level}] ${msg}\n`);
    return e;
  }

  function consoleLine(src, text) {
    const e = { ts: ts(), src, text: String(text) };
    console_.push(e);
    if (console_.length > CONSOLE_RING) console_.shift();
    appendEvent({ type: "console", src, text: e.text });
    broadcast("console", e);
  }

  function verify(entry) {
    const e = { ...entry, ts: ts() };
    verifies.push(e);
    if (verifies.length > VERIFY_RING) verifies.shift();
    appendEvent({ type: "verify", ...e });
    broadcast("verify", e);
    return e;
  }

  function phaseSet(phase, status, detail, startedAt) {
    state[phase] = status;
    const e = {
      phase, status, ts: ts(),
      ms: startedAt ? Date.now() - startedAt : undefined,
      detail,
    };
    phases.push(e);
    appendEvent({ type: "phase", ...e });
    broadcast("phase", e);
    return e;
  }

  function snapshot() {
    return {
      state: { ...state },
      phases: phases.slice(-64),
      logs: logs.slice(-LOG_RING),
      console: console_.slice(-CONSOLE_RING),
      verifies: verifies.slice(-VERIFY_RING),
    };
  }

  function close() {
    try { stream.end(); } catch (_) { /* ignore */ }
  }

  return {
    eventsFile, log, consoleLine, verify, phaseSet, snapshot,
    subscribe, broadcast, close,
    rings: { logs, console: console_, verifies, phases, state },
  };
}

module.exports = { createLog, CONSOLE_RING };
