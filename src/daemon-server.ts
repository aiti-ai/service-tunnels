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
import { readConfigFile, writeConfigFile } from "./config.ts";
import { TunnelManager, tunnelParamSchemas, tunnelMetas } from "./tunnels.ts";
import { readTunnelConfigs, writeTunnelConfigs } from "./tunnels-config.ts";
import { registerPid } from "./pid-registry.ts";
import { ensureTool, TOOLS } from "./tools.ts";
import { killRoleProcesses, killRoleProcessesSync } from "./cleanup.ts";
import { spawnGuardian } from "./guardian-spawn.ts";
import { ensureMarker } from "./marker.ts";
import { expose as exposeFlow } from "./expose.ts";
import type { ExposeOptions } from "./expose.ts";
import { AuthRegistry, authProviderSchemas } from "./auth-registry.ts";
import type { AutheliaProvider } from "./authelia.ts";

// argv: <stateFile> <sockPath> <configDir> <cacheDir>
const [, , stateFile = "", sockPath = "", configDir = "", cacheDir = ""] = process.argv;
if (!stateFile || !sockPath || !configDir || !cacheDir) {
  console.error("daemon-server: usage: daemon-server <stateFile> <sockPath> <configDir> <cacheDir>");
  process.exit(1);
}

ensureMarker(); // this daemon carries its own instance marker (cleanup scoping)

const internal = new InternalRegistry();

// Allow on-demand tool downloads? Explicit daemon arg (env SERVICE_TUNNELS_ALLOW_DOWNLOAD)
// > config-file fallback > default true. Toggled via daemon RPC in-memory; the
// config file is a read-only fallback, never written.
const envAllowDownload = process.env.SERVICE_TUNNELS_ALLOW_DOWNLOAD;
let toolAllowDownload =
  envAllowDownload !== undefined
    ? !(envAllowDownload === "0" || envAllowDownload.toLowerCase() === "false" || envAllowDownload.toLowerCase() === "off")
    : readConfigFile(configDir).allowToolDownload ?? true;

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
    return ensureTool(def, { cacheDir, allowToolDownload: toolAllowDownload });
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
  ["tunnel.get", (params) => tunnels.get(String(params))],
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
  ["config.allow-download", () => ({ allowToolDownload: toolAllowDownload })],
  [
    "config.set-allow-download",
    (params) => {
      // git-config style: persist (params > env > file > default), update the
      // daemon's live value; per-expose `allowToolDownload` still overrides.
      toolAllowDownload = !!(params as { allowToolDownload?: boolean }).allowToolDownload;
      try {
        const f = readConfigFile(configDir);
        f.allowToolDownload = toolAllowDownload;
        writeConfigFile(configDir, f);
      } catch {}
      return { allowToolDownload: toolAllowDownload };
    },
  ],
  ["schemas", async () => ({
    tunnels: tunnelParamSchemas(),
    metas: tunnelMetas(),
    authProviders: await authProviderSchemas(configDir),
  })],
  ["auth.user.managers", () => authRegistry.userManagers()],
  ["auth.totp.providers", () => authRegistry.totpProviders()],
  ["auth.totp.enroll", (params) => {
    const p = params as { name?: string; provider?: string };
    const mgr = authRegistry.userManager(p.provider ?? "portal") as unknown as {
      totpEnroll(name: string): Promise<{ secret: string; otpauthUrl: string }>;
    };
    return mgr.totpEnroll(p.name ?? "");
  }],
  ["auth.totp.disable", (params) => {
    const p = params as { name?: string; provider?: string };
    const mgr = authRegistry.userManager(p.provider ?? "portal") as unknown as {
      totpDisable(name: string): Promise<void>;
    };
    return mgr.totpDisable(p.name ?? "").then(() => ({ ok: true }));
  }],
  ["auth.totp.status", (params) => {
    const p = params as { name?: string; provider?: string };
    const mgr = authRegistry.userManager(p.provider ?? "portal") as unknown as {
      totpStatus(name: string): Promise<{ enrolled: boolean }>;
    };
    return mgr.totpStatus(p.name ?? "");
  }],
  ["auth.user.list", (params) => {
    const provider = (params as { provider?: string } | undefined)?.provider;
    const targets = resolveDaemonUserTargets(authRegistry, provider);
    return Promise.all(targets.map(async (t) => ({ provider: t, users: await authRegistry.userManager(t).listUsers() })));
  }],
  [
    "auth.user.add",
    (params) => {
      const { name, password, displayName, email, provider } = params as {
        name: string;
        password: string;
        displayName?: string;
        email?: string;
        provider?: string | string[];
      };
      const targets = resolveDaemonUserTargets(authRegistry, provider);
      return Promise.all(targets.map((t) => authRegistry.userManager(t).addUser(name, password, displayName, email)))
        .then(() => ({ ok: true, providers: targets }));
    },
  ],
  [
    "auth.user.set-password",
    (params) => {
      const { name, password, provider } = params as {
        name: string;
        password: string;
        provider?: string | string[];
      };
      const targets = resolveDaemonUserTargets(authRegistry, provider);
      return Promise.all(targets.map((t) => authRegistry.userManager(t).setUserPassword(name, password)))
        .then(() => ({ ok: true, providers: targets }));
    },
  ],
  [
    "auth.user.remove",
    (params) => {
      const p = params as { name?: string; provider?: string | string[] };
      const targets = resolveDaemonUserTargets(authRegistry, p.provider);
      return Promise.all(targets.map((t) => authRegistry.userManager(t).removeUser(p.name ?? "")))
        .then(() => ({ ok: true, providers: targets }));
    },
  ],
  [
    "expose",
    (params) => {
      const o = params as ExposeOptions & { toolPaths?: Record<string, string> };
      return exposeFlow(o.port, o, {
        configDir,
        cacheDir,
        resolveTool: async (name: string) => {
          const def = TOOLS[name];
          if (!def) throw new Error(`unknown tool: ${name}`);
          // per-expose param > daemon default (env > config-file fallback)
          return ensureTool(def, { cacheDir, toolPaths: o.toolPaths, allowToolDownload: o.allowToolDownload ?? toolAllowDownload });
        },
        internal,
        tunnels,
        auth: authRegistry,
        log: (line) => console.error(`[service-tunnels] ${line}`),
      });
    },
  ],
  [
    "shutdown",
    async () => {
      // kill every framework helper we spawned (nginx/authelia/redis/tunnels
      // carry SERVICE_TUNNELS_ROLE) so nothing becomes an orphan
      await tunnels.stopAll();
      await killRoleProcesses("SIGTERM", 300, process.env.SERVICE_TUNNELS_MARKER ?? "");
      setTimeout(() => process.exit(0), 100);
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
    console.error(`[daemon] ${req.method} failed:`, err);
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
  try {
    const { chmodSync } = await import("fs");
    chmodSync(sockPath, 0o600); // IPC is privileged
  } catch {
    // socket chmod is best-effort
  }
  return `unix://${sockPath}`;
}

const authRegistry = new AuthRegistry({
  configDir,
  cacheDir,
  resolveTool: async (name: string) => {
    const def = TOOLS[name];
    if (!def) throw new Error(`unknown tool: ${name}`);
    return ensureTool(def, { cacheDir, allowToolDownload: toolAllowDownload });
  },
  registerInternal: (role, port) =>
    internal.register(role, { port, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
  unregisterInternal: (role) => internal.unregister(role),
  pickPort: async () => {
    const { createServer } = await import("net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
  },
  log: (line) => console.error(`[service-tunnels] ${line}`),
  registerPid: (role, pid) => {
    try {
      registerPid(cacheDir, process.pid, role, pid);
    } catch {}
  },
});

function resolveDaemonUserTargets(registry: AuthRegistry, provider?: string | string[]): string[] {
  const all = registry.userManagers();
  if (!provider || provider === "all") return all;
  const targets = Array.isArray(provider) ? provider : [provider];
  for (const t of targets) {
    if (!all.includes(t)) throw new Error(`provider ${t} does not support user management`);
  }
  return targets;
}

/** The authelia provider instance (singleton via the registry) — user mgmt. */
function authelia(): AutheliaProvider {
  return authRegistry.create("authelia") as AutheliaProvider;
}

const server = createServer(serveSocket);
const ipc = await listen();
// watch ourselves: if this daemon is ever SIGKILLed, the guardian reaps the
// role-marked helpers (nginx/authelia/redis/tunnels) we spawned
spawnGuardian(process.pid);
writeState(stateFile, { ...readState(stateFile), daemon: { pid: process.pid, ipc } });
console.log(`daemon ready ${ipc}`);

process.once("exit", () => {
  try {
    unlinkSync(sockPath); // remove the IPC socket so a fresh daemon can bind
  } catch {
    // already gone
  }
});
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    killRoleProcessesSync(process.env.SERVICE_TUNNELS_MARKER ?? ""); // safety net even on hard kills
    process.exit(0);
  });
}
process.on("uncaughtException", (err) => {
  console.error("daemon-server uncaught:", err);
  process.exit(1);
});
