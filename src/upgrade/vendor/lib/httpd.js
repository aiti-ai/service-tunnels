// lib/httpd.js - management API on a random port (plan §3.5): status page, SSE events,
// token-gated POST endpoints. Binds 127.0.0.1 only; public reachability is handled by
// service-tunnels expose (auth there is the first gate, token here the second).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { ts } = require("./util");

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function createHttpd(deps) {
  // deps: { port, token, log, cfg, assistantRoot, statusPageFile, urls, selfMeta }
  // NOTE: orch/orchestrator are wired later via wire() (created after the server listens).
  const { log } = deps;
  let statusPage = null;
  try { statusPage = fs.readFileSync(deps.statusPageFile, "utf8"); } catch (_) { /* built-in fallback */ }

  const subscribers = new Map(); // conn -> unsubscribe

  function tokenOk(req, url) {
    if (req.headers["x-assistant-token"] === deps.token) return true;
    return url.searchParams.get("tk") === deps.token;
  }

  function json(res, code, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${deps.port}`);
    const route = url.pathname;
    const orch = deps.orch; // may be null during the tiny pre-wire window

    try {
      if (req.method === "GET" && (route === "/" || route === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(statusPage || "<h1>upgrade-assistant</h1><p>status page missing</p>");
        return;
      }
      if (req.method === "GET" && route === "/status") {
        if (!deps.orch) { json(res, 503, { error: "orchestrator not wired yet" }); return; }
        json(res, 200, buildStatus());
        return;
      }
      if (req.method === "GET" && route === "/health") {
        json(res, 200, { ok: true, phase: deps.orch ? deps.orch.phase : "BOOT", ts: ts() });
        return;
      }
      if (req.method === "GET" && route === "/events") {
        if (!tokenOk(req, url)) { json(res, 401, { error: "bad token" }); return; }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`retry: 3000\n\n`);
        // replay recent state so a refresh restores the full view
        const snap = log.snapshot();
        send(res, "replay", snap);
        const unsub = log.subscribe((e) => send(res, e.type, e.data));
        subscribers.set(res, unsub);
        req.on("close", () => { const u = subscribers.get(res); if (u) u(); subscribers.delete(res); });
        return;
      }

      // unknown GETs (favicon etc.) answer before the token gate - no info either way
      if (req.method === "GET" && route === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET") { json(res, 404, { error: "not found" }); return; }

      // ---- everything below requires the token (plan §3.4: second gate) ----
      if (!tokenOk(req, url)) { json(res, 401, { error: "bad token" }); return; }

      if (req.method === "POST" && route === "/upgrade") {
        if (orch.running && !orch.finalState) { json(res, 409, { error: "upgrade already running" }); return; }
        await orchestratorSafeRun();
        json(res, 202, { started: true, target: deps.cfg.upgrade.target });
        return;
      }
      if (req.method === "POST" && route === "/rollback") {
        const ok = await deps.orchestrator.rollbackOnly();
        json(res, ok ? 200 : 500, { rolledBack: ok });
        return;
      }
      if (req.method === "POST" && route === "/restart") {
        await deps.orchestrator.restartParentOnly();
        json(res, 200, { restarted: true });
        return;
      }
      if (req.method === "POST" && route === "/parent/input") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const ok = deps.orchestrator.writeStdin(String(body.data || ""));
        json(res, ok ? 200 : 400, { delivered: ok });
        return;
      }
      if (req.method === "POST" && route === "/shutdown") {
        const r = await deps.orchestrator.shutdown();
        json(res, 200, r);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      if (e && e.status) { json(res, e.status, { error: e.message }); return; }
      log.log("err", `api ${req.method} ${route} failed: ${e.message}`);
      try { json(res, 500, { error: e.message }); } catch (_) { /* socket gone */ }
    }
  });

  function send(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* ignore */ }
  }

  function orchestratorSafeRun() {
    // fire-and-forget: the flow reports progress over SSE; API returns immediately
    deps.orchestrator.runUpgrade().catch((e) => log.log("err", `runUpgrade crashed: ${e.message}`));
  }

  function buildStatus() {
    const o = deps.orch;
    if (!o) return { error: "orchestrator not wired yet" };
    return {
      assistant: deps.selfMeta,
      phase: o.phase,
      running: o.running && !o.finalState,
      finalState: o.finalState,
      error: o.error,
      selfStopAt: o.selfStopAt,
      startedAt: o.startedAt,
      urls: deps.urls,
      parent: o.parentInfo,
      target: deps.cfg.upgrade.target,
      dirMode: !!(deps.cfg.upgrade.releases && deps.cfg.upgrade.current),
      onAssistantExit: deps.cfg.onAssistantExit,
      lastVerify: o.lastVerify,
      lock: (() => { try { return require("./state-files").readLock(); } catch (_) { return null; } })(),
      historyDir: require("./state-files").HISTORY_DIR(),
      subscribers: subscribers.size,
    };
  }

  const heartbeat = setInterval(() => {
    for (const res of subscribers.keys()) send(res, "hb", { ts: ts() });
  }, 15000);

  return new Promise((resolve) => {
    server.listen(deps.port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        wire: ({ orch, orchestrator }) => { deps.orch = orch; deps.orchestrator = orchestrator; },
        close: () => { clearInterval(heartbeat); for (const u of subscribers.values()) u(); server.close(); },
      });
    });
  });
}

module.exports = { createHttpd };
