#!/usr/bin/env node
/**
 * Daemon server — the long-lived process that owns framework helpers
 * (nginx/authelia/redis) and tunnel processes in CLI mode.
 *
 * Detached by `daemon start` (setsid/detached:true); exposes newline-delimited
 * JSON-RPC over a unix socket (TCP on Windows) whose address is written to
 * cacheDir/state.json so every CLI invocation can find it.
 *
 * This file is spawned directly by Node (node daemon-server.ts ...) — it is
 * NOT a library entry point.
 */
import { createServer, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";
import type { Server as HttpServer } from "http";
import { InternalRegistry } from "./internal.ts";
import { getServicePorts } from "./discovery.ts";
import { readState, writeState } from "./state.ts";
import { TunnelManager } from "./tunnels.ts";
import { readTunnelConfigs, writeTunnelConfigs } from "./tunnels-config.ts";
import { ensureTool, TOOLS } from "./tools.ts";

// argv: <stateFile> <sockPath> <configDir> <cacheDir>
const [, , stateFile = "", sockPath = "", configDir = "", cacheDir = ""] = process.argv;
if (!stateFile || !sockPath || !configDir || !cacheDir) {
  console.error("daemon-server: usage: daemon-server <stateFile> <sockPath> <configDir> <cacheDir>");
  process.exit(1);
}

const internal = new InternalRegistry();

// Tunnel manager owned by the daemon: CLI commands reach it over IPC, so a
// started tunnel stays visible/controllable across CLI invocations.
const persistTunnels = () => {
  writeState(stateFile, {
    ...readState(stateFile),
    tunnels: tunnels.persisted(),
  });
};
const tunnels = new TunnelManager({
  cacheDir,
  resolveTool: async (name: string) => {
    const def = TOOLS[name];
    if (!def) throw new Error(`unknown tool: ${name}`);
    return ensureTool(def, { cacheDir });
  },
  onEvent: () => persistTunnels(),
});
for (const cfg of readTunnelConfigs(configDir)) tunnels.add(cfg);
tunnels.hydrate(readState(stateFile).tunnels);

// Rehydrate the internal registry from state.json (survives daemon restart).
for (const entry of readState(stateFile).internal) {
  internal.register(entry.role, {
    port: entry.port,
    pid: entry.pid,
    process: entry.role,
    cmdline: entry.role,
    addresses: entry.addresses,
  });
}

type Handler = (params: unknown) => unknown | Promise<unknown>;

const methods = new Map<string, Handler>([
  ["ping", () => ({ pong: true, pid: process.pid })],
  [
    "discover",
    (params) => {
      const opts = (params ?? {}) as { force?: boolean };
      return getServicePorts(internal, { force: opts.force });
    },
  ],
  ["internal.list", () => internal.list()],
  ["tunnel.list", () => tunnels.list()],
  ["tunnel.configs", () => tunnels.configs],
  [
    "tunnel.add",
    (params) => {
      const cfg = params as Parameters<TunnelManager["add"]>[0];
      tunnels.add(cfg);
      const all = readTunnelConfigs(configDir);
      const idx = all.findIndex((c) => c.name === cfg.name);
      if (idx >= 0) all[idx] = cfg;
      else all.push(cfg);
      writeTunnelConfigs(configDir, all);
      return { ok: true };
    },
  ],
  [
    "tunnel.remove",
    (params) => {
      const name = String(params);
      tunnels.remove(name);
      writeTunnelConfigs(configDir, readTunnelConfigs(configDir).filter((c) => c.name !== name));
      return { ok: true };
    },
  ],
  ["tunnel.start", (params) => tunnels.start(String(params)).then((i) => ({ ...i }))],
  ["tunnel.stop", (params) => tunnels.stop(String(params)).then(() => ({ ok: true }))],
  ["tunnel.stopAll", () => tunnels.stopAll().then(() => ({ ok: true }))],
  [
    "shutdown",
    () => {
      setTimeout(() => process.exit(0), 50);
      return { ok: true };
    },
  ],
]);

/** Newline-delimited JSON-RPC over a unix socket. */
function serveSocket(socket: Socket): void {
  socket.setEncoding("utf8");
  let buf = "";
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) void handleLine(socket, line);
      nl = buf.indexOf("\n");
    }
  });
  socket.on("error", () => socket.destroy());
}

async function handleLine(socket: Socket, line: string) {
  let req: { id: number; method: string; params?: unknown };
  try {
    req = JSON.parse(line) as { id: number; method: string; params?: unknown };
  } catch {
    socket.write(`${JSON.stringify({ id: null, error: "invalid request" })}\n`);
    return;
  }
  const handler = methods.get(req.method);
  if (!handler) {
    socket.write(`${JSON.stringify({ id: req.id, error: `unknown method: ${req.method}` })}\n`);
    return;
  }
  try {
    const result = await handler(req.params);
    socket.write(`${JSON.stringify({ id: req.id, result })}\n`);
  } catch (err) {
    socket.write(`${JSON.stringify({ id: req.id, error: String(err) })}\n`);
  }
}

async function listen(): Promise<string> {
  if (process.platform === "win32") {
    const { createServer: createHttp } = await import("http");
    const httpServer: HttpServer = createHttp((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          try {
            const reqObj = JSON.parse(body || "{}") as { id: number; method: string; params?: unknown };
            const handler = methods.get(reqObj.method);
            if (!handler) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: `unknown method: ${reqObj.method}` }));
              return;
            }
            const result = await handler(reqObj.params);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: reqObj.id, result }));
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no tcp addr");
    return `tcp://127.0.0.1:${addr.port}`;
  }

  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath); // stale socket from a crashed daemon
    } catch {
      // ignore
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve());
  });
  return `unix://${sockPath}`;
}

const server = createServer(serveSocket);
const ipc = await listen();
writeState(stateFile, { ...readState(stateFile), daemon: { pid: process.pid, ipc } });
console.log(`daemon ready ${ipc}`);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (err) => {
  console.error("daemon-server uncaught:", err);
  process.exit(1);
});
