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
import { existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { Server as HttpServer } from "http";
import { InternalRegistry } from "./internal.ts";
import { getServicePorts } from "./discovery.ts";
import { readState, writeState } from "./state.ts";
import type { ExposeRuntimeState } from "./state.ts";
import { readSites, writeSites, validateSiteName, defaultSiteConfig, type SiteConfig } from "./sites.ts";
import { readConfigFile, writeConfigFile, resolveBaseDomains, resolveAllowAuthNone } from "./config.ts";
import { TunnelManager, tunnelParamSchemas, tunnelMetas, TUNNEL_SCHEMAS_VERSION, type TunnelConfig } from "./tunnels.ts";
import { validateTunnelConfig, validateTunnelName, validatePort, validateServer, validateUserName } from "./validation.ts";
import { readTunnelConfigs, writeTunnelConfigs } from "./tunnels-config.ts";
import { registerPid } from "./pid-registry.ts";
import { ensureTool, TOOLS } from "./tools.ts";
import { killRoleProcesses, killRoleProcessesSync } from "./cleanup.ts";
import { spawnGuardian } from "./guardian-spawn.ts";
import { ensureMarker } from "./marker.ts";
import { expose as exposeFlow } from "./expose.ts";
import type { ExposeOptions } from "./expose.ts";
import { AuthRegistry, authProviderSchemas, authProviderMetas } from "./auth-registry.ts";
import { localizeSchemas, resolveLang } from "./i18n.ts";
import { listPresets, getPreset, savePreset, removePreset, loadPresetsKey, type PresetKind } from "./presets.ts";
import { DEFAULT_SUFFIXES } from "./proxy.ts";
import { ProxyManager } from "./proxy-manager.ts";
import { GatewayController } from "./gateway.ts";
import { RedisController } from "./redis.ts";
import { SshManager } from "./ssh/manager.ts";
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

const ssh = new SshManager({ cacheDir });

// 最近一次 RPC handler 错误（诊断用：UI 把 daemon 拒绝转成泛化提示时，
// 可查询真实原因，如 auth-none banned / ngrok 8013）。
let lastError: string | null = null;

const methods = new Map<string, Handler>([
  ["ping", () => ({ pong: true, pid: process.pid })],
  ["daemon.last-error", () => ({ error: lastError })],
    // SSH 网关端口是内部服务（认证层），不作为暴露目标
    const gwPorts = new Set(ssh.list().map((d) => d.port));
    return ports.filter((p) => !gwPorts.has(p.port));
  }],
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
      // Dangerous-type gate: `command` runs a raw shell command — the client
      // must explicitly opt in (CLI sets it for --type command; the UI sets
      // it after an explicit confirm). Rejects accidental/scripted command
      // tunnels at the IPC boundary.
      if (cfg?.type === "command" && cfg?.dangerous !== true) {
        throw new Error(
          `tunnel '${cfg?.name ?? "?"}': type "command" runs a raw shell command — explicit opt-in required (dangerous: true)`,
        );
      }
      // Fail-closed input validation BEFORE anything is persisted: ssh option
      // injection / frpc INI injection / name path traversal / bad ports.
      validateTunnelConfig(cfg, cfg?.name);
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
      validateTunnelName(name); // fail-closed name gate (state keys + file names)
      tunnels.remove(name);
      writeTunnelConfigs(configDir, readTunnelConfigs(configDir).filter((c) => c.name !== name));
      return { ok: true };
    },
  ],
  ["tunnel.start", (params) => {
    const name = String(params);
    validateTunnelName(name);
    return tunnels.start(name).then((i) => ({ ...i }));
  }],
  ["tunnel.stop", (params) => {
    const name = String(params);
    validateTunnelName(name);
    // M0b: tunnel-mode exposes are stopped here too — drop the registry record
    // so expose.list stops showing them.
    exposeRegistry.delete(name);
    return tunnels.stop(name).then(() => {
      persistExposeRegistry();
      return { ok: true };
    });
  }],
  ["tunnel.stopAll", () => tunnels.stopAll().then(() => {
    exposeRegistry.clear();
    persistExposeRegistry();
    return { ok: true };
  })],
  // ── Expose registry (M0b): list + stop with the proxy-mode dual path ──
  ["expose.list", () =>
    [...exposeRegistry.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((rec) => {
        const cfg = rec.tunnelName ? tunnels.configs.find((c) => c.name === rec.tunnelName) : null;
        const logs = findExposeLogs(rec.host);
        return {
          ...rec,
          running: exposeRunning(rec),
          params: cfg ? maskedTunnelParams(cfg) : null,
          accessLog: logs.access,
          errorLog: logs.error,
        };
      }),
  ],
  ["expose.stop", async (params) => {
    const name = String(params);
    const rec = exposeRegistry.get(name);
    if (!rec) throw new Error(`expose ${name} not found`);
    if (rec.tunnelName) {
      await tunnels.stop(rec.tunnelName);
    } else {
      // proxy-mode: drop the binding (record is removed below)
      try {
        proxy.removeBinding(rec.port, rec.label ?? "");
      } catch {
        // already gone
      }
    }
    exposeRegistry.delete(name);
    persistExposeRegistry();
    // TODO-1 (fail-clean): ssh provider 暴露停止 → 清理 backing ssh 域
    // （该 site 无其他运行中 ssh 暴露时才删）。
    if (rec.provider === "ssh" && rec.site) {
      const others = [...exposeRegistry.values()].filter(
        (r) => r.name !== name && r.provider === "ssh" && r.site === rec.site,
      );
      if (!others.length) {
        try { if (ssh.get(rec.site)) await ssh.remove(rec.site); } catch { /* best effort */ }
      }
    }
    return { ok: true, name };
  }],
  ["expose.stopAll", async () => {
    await tunnels.stopAll();
    for (const b of proxy.bindings()) {
      try {
        proxy.removeBinding(b.port, b.label);
      } catch {
        // already gone
      }
    }
    exposeRegistry.clear();
    persistExposeRegistry();
    return { ok: true };
  }],
  // ── Presets (TODO-2): 参数变体 —— 隧道/认证参数的命名常用 ────────────────
  ["preset.list", (params) => {
    const p = (params ?? {}) as { kind?: string; type?: string };
    const kind: PresetKind = p.kind === "auth" ? "auth" : "tunnel";
    return listPresets(readConfigFile(configDir), kind, p.type, loadPresetsKey(cacheDir));
  }],
  ["preset.get", (params) => {
    const p = (params ?? {}) as { kind?: string; type?: string; name?: string };
    const kind: PresetKind = p.kind === "auth" ? "auth" : "tunnel";
    return getPreset(readConfigFile(configDir), kind, String(p.type ?? ""), String(p.name ?? ""), loadPresetsKey(cacheDir)) ?? null;
  }],
  ["preset.save", (params) => {
    const p = (params ?? {}) as { kind?: string; type?: string; name?: string; params?: Record<string, unknown> };
    const kind: PresetKind = p.kind === "auth" ? "auth" : "tunnel";
    if (!p.type || !p.name) throw new Error("type and name required");
    const f = readConfigFile(configDir);
    savePreset(f, kind, String(p.type), String(p.name), (p.params ?? {}) as Record<string, string>, loadPresetsKey(cacheDir));
    writeConfigFile(configDir, f);
    return { ok: true, name: p.name };
  }],
  ["preset.remove", (params) => {
    const p = (params ?? {}) as { kind?: string; type?: string; name?: string };
    const kind: PresetKind = p.kind === "auth" ? "auth" : "tunnel";
    const f = readConfigFile(configDir);
    const removed = removePreset(f, kind, String(p.type ?? ""), String(p.name ?? ""));
    if (removed) writeConfigFile(configDir, f);
    return { removed };
  }],
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
  ["proxy.start", (params) => proxy.start((params as { port?: number })?.port).then((port) => ({ port }))],
  ["proxy.stop", () => proxy.stop().then(() => ({ ok: true }))],
  ["proxy.status", () => proxy.status()],
  ["proxy.bindings", () => proxy.bindings()],
  ["site.list", () => {
    const sites = readSites(configDir);
    return ["default", ...Object.keys(sites)].map((name) => ({ ...(sites[name] ?? defaultSiteConfig()), name }));
  }],
  ["site.add", (params) => {
    const { name, ...cfg } = params as { name: string } & Record<string, unknown>;
    validateSiteName(name);
    const sites = readSites(configDir);
    sites[name] = { ...(cfg as unknown as SiteConfig), name };
    writeSites(configDir, sites);
    return { ok: true };
  }],
  ["site.remove", (params) => {
    const name = String(params);
    validateSiteName(name);
    const sites = readSites(configDir);
    if (!sites[name]) throw new Error(`site ${name} not registered`);
    delete sites[name];
    writeSites(configDir, sites);
    return { ok: true };
  }],
  ["schemas", async (params) => {
    const lang = resolveLang((params as { lang?: string } | undefined)?.lang);
    return {
      tunnels: localizeSchemas(tunnelParamSchemas(), lang),
      metas: tunnelMetas(),
      authProviders: localizeSchemas(await authProviderSchemas(configDir), lang),
      authMetas: authProviderMetas(configDir),
      // auth none ban status — clients hide the "none" option when false
      authNoneAllowed: resolveAllowAuthNone(configDir),
    };
  }],
  ["auth.user.managers", () => authRegistry.userManagers()],
  ["auth.totp.providers", () => authRegistry.totpProviders()],
  ["auth.none.allowed", () => resolveAllowAuthNone(configDir)],

  ["auth.totp.enroll", (params) => {
    const p = params as { name?: string; provider?: string; site?: string; label?: string };
    // username gate at the IPC boundary (also enforces the totp export
    // filename charset in the authelia provider)
    validateUserName(p?.name);
    const mgr = authRegistry.userManager(p.provider ?? "portal", p.site) as unknown as {
      totpEnroll(name: string, label?: string): Promise<{ secret: string; otpauthUrl: string; label: string }>;
      defaultTotpLabel?(name: string): string;
    };
    return mgr.totpEnroll(p.name ?? "", p.label);
  }],
  ["auth.totp.default-label", (params) => {
    const p = params as { name?: string; provider?: string; site?: string };
    validateUserName(p?.name);
    const mgr = authRegistry.userManager(p.provider ?? "portal", p.site) as unknown as {
      defaultTotpLabel?(name: string): string;
    };
    if (!mgr.defaultTotpLabel) throw new Error(`provider ${p.provider ?? "portal"} has no default TOTP label`);
    return { label: mgr.defaultTotpLabel(p.name ?? "") };
  }],
  ["auth.totp.disable", (params) => {
    const p = params as { name?: string; provider?: string; site?: string };
    validateUserName(p?.name);
    const mgr = authRegistry.userManager(p.provider ?? "portal", p.site) as unknown as {
      totpDisable(name: string): Promise<void>;
    };
    return mgr.totpDisable(p.name ?? "").then(() => ({ ok: true }));
  }],
  ["auth.totp.status", (params) => {
    const p = params as { name?: string; provider?: string; site?: string };
    validateUserName(p?.name);
    const mgr = authRegistry.userManager(p.provider ?? "portal", p.site) as unknown as {
      totpStatus(name: string): Promise<{ enrolled: boolean }>;
    };
    return mgr.totpStatus(p.name ?? "");
  }],
  ["auth.user.list", (params) => {
    const p = (params as { provider?: string; site?: string } | undefined) ?? {};
    const targets = resolveDaemonUserTargets(authRegistry, p.provider);
    return Promise.all(targets.map(async (t) => ({ provider: t, users: await authRegistry.userManager(t, p.site).listUsers() })));
  }],
  [
    "auth.user.add",
    (params) => {
      const { name, password, displayName, email, provider, site } = params as {
        name: string;
        password: string;
        displayName?: string;
        email?: string;
        provider?: string | string[];
        site?: string;
      };
      const targets = resolveDaemonUserTargets(authRegistry, provider);
      validateUserName(name); // same charset gate as the providers (YAML/htpasswd safety)
      return Promise.all(targets.map((t) => authRegistry.userManager(t, site).addUser(name, password, displayName, email)))
        .then(() => ({ ok: true, providers: targets }));
    },
  ],
  [
    "auth.user.set-password",
    (params) => {
      const { name, password, provider, site } = params as {
        name: string;
        password: string;
        provider?: string | string[];
        site?: string;
      };
      validateUserName(name);
      const targets = resolveDaemonUserTargets(authRegistry, provider);
      return Promise.all(targets.map((t) => authRegistry.userManager(t, site).setUserPassword(name, password)))
        .then(() => ({ ok: true, providers: targets }));
    },
  ],
  [
    "auth.user.remove",
    (params) => {
      const p = params as { name?: string; provider?: string | string[]; site?: string };
      validateUserName(p?.name);
      const targets = resolveDaemonUserTargets(authRegistry, p.provider);
      return Promise.all(targets.map((t) => authRegistry.userManager(t, p.site).removeUser(p.name ?? "")))
        .then(() => ({ ok: true, providers: targets }));
    },
  ],
  ["auth.token.managers", () => authRegistry.tokenManagers()],
  ["auth.token.list", (params) => {
    const p = (params as { provider?: string; site?: string } | undefined) ?? {};
    const targets = resolveDaemonTokenTargets(authRegistry, p.provider);
    return Promise.all(targets.map(async (t) => ({ provider: t, tokens: await authRegistry.tokenManager(t, p.site).listTokens() })));
  }],
  ["auth.token.create", (params) => {
    const p = params as { description?: string; expiresAt?: number; provider?: string; site?: string };
    const targets = resolveDaemonTokenTargets(authRegistry, p.provider);
    return Promise.all(targets.map((t) => authRegistry.tokenManager(t, p.site).createToken({ description: p.description, expiresAt: p.expiresAt })))
      .then((tokens) => ({ ok: true, providers: targets, tokens }));
  }],
  ["auth.token.revoke", (params) => {
    const p = params as { id?: string; provider?: string; site?: string };
    if (!p?.id) throw new Error("auth token revoke: id is required");
    const targets = resolveDaemonTokenTargets(authRegistry, p.provider);
    return Promise.all(targets.map((t) => authRegistry.tokenManager(t, p.site).revokeToken(p.id!)))
      .then(() => ({ ok: true, providers: targets }));
  }],
  [
    "expose",
    async (params) => {
      let o = params as ExposeOptions & { toolPaths?: Record<string, string> };
      // M0b-ssh: provider "ssh" = site-scoped public-key auth (ANY protocol —
      // port-forward is protocol-agnostic). Auto-provision the site's backing
      // ssh domain (port auto-allocated, invisible to the caller) and route a
      // raw tcp tunnel at its ssh port. The UI/caller only passes site + port.
      const sshRequested = o?.provider === "ssh" || o?.auth === "ssh";
      if (sshRequested) {
        const domain = String(o?.site ?? "default");
        if (!ssh.get(domain)) {
          try {
            await ssh.create({ domain, site: domain, forwardPort: o.port, sshPort: 0 });
          } catch (err) {
            throw new Error(`ssh auth: cannot provision site "${domain}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        o = { ...o, provider: undefined, auth: false, protocol: "tcp", sshGateway: domain };
      }
      // Fail-closed boundary checks before the expose flow touches anything:
      // the port must be real, and schema-driven tunnel params must be an
      // object (the final tunnel config itself is validated at start()).
      validatePort(o?.port, "port");
      if (o?.tunnelParams !== undefined && (typeof o.tunnelParams !== "object" || o.tunnelParams === null || Array.isArray(o.tunnelParams))) {
        throw new Error(`expose: tunnelParams must be an object`);
      }
      if (o?.providerParams !== undefined && (typeof o.providerParams !== "object" || o.providerParams === null || Array.isArray(o.providerParams))) {
        throw new Error(`expose: providerParams must be an object`);
      }
      if (o?.allowAuthNone !== undefined && typeof o.allowAuthNone !== "boolean") {
        throw new Error(`expose: allowAuthNone must be a boolean`);
      }
      // inject 进 nginx 配置（sub_filter 替换串 / add_before_body 文件）——
      // 形状与大小做边界校验（内容本身经 nginxQuote 转义/落盘，不会注入配置；
      // 上限防超长字符串撑爆配置与内存）。
      if (o?.inject !== undefined && o?.inject !== "") {
        const inj = o.inject as string | { html: string; position?: string };
        const html = typeof inj === "string" ? inj : inj?.html;
        if (typeof html !== "string" || html.length === 0 || html.length > 64 * 1024) {
          throw new Error("expose: inject must be a non-empty string or { html, position } (html ≤ 64KB)");
        }
        if (typeof inj === "object") {
          const pos = inj?.position;
          if (pos !== undefined && pos !== "head" && pos !== "prepend") {
            throw new Error(`expose: inject.position must be "head" or "prepend", got ${JSON.stringify(pos)}`);
          }
        }
      }
      // auth-none ban at the IPC boundary (defense in depth; exposeFlow
      // re-checks): the effective auth is none and the daemon's resolution
      // (env SERVICE_TUNNELS_ALLOW_AUTH_NONE / config file, sticky — a per-call
      // true cannot re-enable) says banned → reject before anything starts.
      const authNone = o?.auth === false || o?.auth === undefined || o?.auth === "none";
      if (authNone && !resolveAllowAuthNone(configDir, o?.allowAuthNone as boolean | undefined)) {
        throw new Error('expose: auth "none" is banned on this host (allow-auth-none=false) — pass --auth auto/<provider>');
      }
      // auxiliary ports (0 = auto/random) and the base domain (host[:port],
      // interpolated into generated vhost URLs) get the same boundary checks.
      for (const f of ["proxyPort", "nginxPort", "autheliaPort", "redisPort"] as const) {
        const p = (o as unknown as Record<string, unknown>)[f];
        if (p !== undefined && p !== 0 && p !== null && p !== "") validatePort(p, f);
      }
      if (o?.baseDomain !== undefined && o.baseDomain !== "") validateServer(o.baseDomain);
      // Same dangerous gate as tunnel.add: `--tunnel command` runs a raw shell
      // command — requires the explicit opt-in (CLI carries it for command).
      if (o?.tunnelType === "command" && o?.dangerous !== true) {
        throw new Error("expose: tunnel type \"command\" runs a raw shell command — explicit opt-in required (dangerous: true)");
      }
      // autheliaReloadCmd is a SHELL command executed on host registration
      // (operator-managed authelia) — it is library/config-only, never meant
      // to travel over IPC. Block it here so a daemon RPC client can't turn
      // `expose --auth authelia` into local command execution.
      if (o?.autheliaReloadCmd !== undefined && o?.autheliaReloadCmd !== "") {
        throw new Error("expose: autheliaReloadCmd is operator-only (library/config) — not accepted over IPC");
      }
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
        proxy,
        // TODO-1: shared singletons — one nginx gateway + one redis for ALL
        // exposes (eliminates per-expose nginx accumulation); not cleaned
        // per-expose.
        gateway,
        redis,
        log: (line) => console.error(`[service-tunnels] ${line}`),
        sshGatewayPort: (domain: string) => ssh.get(domain)?.port,
        sshEnsureDomain: async (site, forwardPort) => {
          const domain = String(site ?? "default");
          const existing = ssh.get(domain);
          try {
            const info = existing ?? (await ssh.ensure({ domain, site, forwardPort, sshPort: 0 }));
            return { port: info.port, created: !existing };
          } catch (err) {
            throw new Error(`ssh auth: cannot provision site "${domain}": ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        sshRemoveDomain: async (site) => {
          const domain = String(site ?? "default");
          try {
            if (ssh.get(domain)) await ssh.remove(domain);
          } catch { /* best effort */ }
        },
      }).then((r) => {
        // Record expose metadata in the registry (M0b) for expose.list/stop.
        if (r && r.tunnel) {
          exposeRegistry.set(r.tunnel, {
            name: r.tunnel,
            port: o.port,
            mode: r.mode,
            provider: sshRequested ? "ssh" : r.provider,
            protocol: r.protocol,
            site: r.site ?? o.site,
            label: r.label,
            localUrl: r.localUrl,
            baseUrl: r.baseUrl,
            domainUrl: r.domainUrl,
            url: r.url,
            loginUrl: r.loginUrl,
            tunnelType: o.tunnelType,
            tunnelName: r.tunnel,
            host: r.url ? new URL(r.url).host : undefined,
            startedAt: Date.now(),
          });
        } else if (r && (r.localUrl || r.mode)) {
          const key = `proxy:${o.port}:${r.label ?? ""}`;
          exposeRegistry.set(key, {
            name: key,
            port: o.port,
            mode: r.mode ?? "proxy",
            provider: r.provider,
            protocol: r.protocol,
            site: r.site ?? o.site,
            label: r.label,
            localUrl: r.localUrl,
            baseUrl: r.baseUrl,
            domainUrl: r.domainUrl,
            url: r.url,
            loginUrl: r.loginUrl,
            tunnelType: o.tunnelType,
            startedAt: Date.now(),
          });
        }
        persistExposeRegistry();
        return r;
      });
    },
  ],
  [
    "ssh.domain.list",
    () => ssh.list(),
  ],
  [
    "ssh.domain.create",
    (params) => {
      const cfg = (params ?? {}) as Record<string, unknown>;
      validateUserName(cfg.domain);
      if (cfg.site !== undefined) validateSiteName(String(cfg.site));
      return ssh.create({
        domain: String(cfg.domain),
        site: cfg.site === undefined ? undefined : String(cfg.site),
        sshPort: cfg.sshPort === undefined ? undefined : Number(cfg.sshPort),
        forwardPort: Number(cfg.forwardPort),
        reversePort: cfg.reversePort === undefined ? undefined : Number(cfg.reversePort),
        forwardHost: cfg.forwardHost === undefined ? undefined : String(cfg.forwardHost),
        listenAddr: cfg.listenAddr === undefined ? undefined : String(cfg.listenAddr),
        authTimeoutMs: cfg.authTimeoutMs === undefined ? undefined : Number(cfg.authTimeoutMs),
        maxConnections: cfg.maxConnections === undefined ? undefined : Number(cfg.maxConnections),
      });
    },
  ],
  [
    "ssh.domain.remove",
    (params) => {
      const domain = String((params as Record<string, unknown> | null)?.domain ?? "");
      return ssh.remove(domain);
    },
  ],
  [
    "ssh.domain.stop",
    (params) => {
      const domain = String((params as Record<string, unknown> | null)?.domain ?? "");
      validateUserName(domain);
      return ssh.stop(domain);
    },
  ],
  [
    "ssh.domain.start",
    (params) => {
      const domain = String((params as Record<string, unknown> | null)?.domain ?? "");
      validateUserName(domain);
      return ssh.start(domain);
    },
  ],
  [
    "ssh.key.add",
    (params) => {
      const p = (params ?? {}) as { domain: string; publicKey: string };
      validateUserName(p.domain);
      if (typeof p.publicKey !== "string" || !p.publicKey.trim())
        throw new Error("publicKey is required");
      return ssh.addKey(p.domain, p.publicKey);
    },
  ],
  [
    "ssh.key.generate",
    (params) => {
      const p = (params ?? {}) as { domain: string; type?: string; bits?: number; comment?: string; count?: number };
      validateUserName(p.domain);
      return ssh.generateKey(p.domain, {
        type: (p.type as "ed25519" | "rsa" | "ecdsa") ?? "ed25519",
        bits: p.bits,
        comment: p.comment,
        count: p.count,
      });
    },
  ],
  [
    "ssh.key.list",
    (params) => {
      const domain = String((params as Record<string, unknown> | null)?.domain ?? "");
      validateUserName(domain);
      return ssh.listKeys(domain);
    },
  ],
  [
    "ssh.key.remove",
    (params) => {
      const p = (params ?? {}) as { domain: string; fingerprint: string };
      validateUserName(p.domain);
      if (typeof p.fingerprint !== "string" || !p.fingerprint)
        throw new Error("fingerprint is required");
      return ssh.removeKey(p.domain, p.fingerprint);
    },
  ],
  [
    "ssh.host.fingerprints",
    (params) => {
      const domain = String((params as Record<string, unknown> | null)?.domain ?? "");
      validateUserName(domain);
      return ssh.hostFingerprints(domain);
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

async function listen(): Promise<{ path: string; secret?: string }> {
  if (process.platform === "win32") {
    // Windows IPC: TCP on 127.0.0.1 with a per-instance random secret (stored
    // in state.json, 0600). POSIX uses a 0600 unix socket (filesystem peer
    // gate); TCP has no such gate, so every request must prove the secret.
    const { createServer: createHttp } = await import("http");
    const ipcSecret = randomBytes(32).toString("hex");
    const httpServer: HttpServer = createHttp((req, res) => {
      if (req.headers["x-service-tunnels-auth"] !== ipcSecret) {
        // audit: unauthorized IPC access attempt (wrong/missing secret)
        console.error(`[daemon] IPC auth failed from ${req.socket?.remoteAddress ?? "?"} (${req.method} ${req.url ?? ""})`);
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
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
            lastError = err instanceof Error ? err.message : String(err);
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
    return { path: `tcp://127.0.0.1:${addr.port}`, secret: ipcSecret };
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
  return { path: `unix://${sockPath}` };
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

// Shared proxy transport + enrollment registry (D4). Enrollment is the ONLY
// gate (resolveSite): expose already verified port ownership at enrollment
// time; the daemon cannot see the caller's process tree anyway.
const proxy = new ProxyManager({
  suffixes: DEFAULT_SUFFIXES,
  baseDomain: resolveBaseDomains(configDir).primary,
  baseDomains: resolveBaseDomains(configDir).list,
  registry: authRegistry,
  getSites: () => readSites(configDir),
  // persist enrollments; the arrow captures `proxy` (assigned after this
  // constructor; only invoked on later addBinding/removeBinding)
  onChange: () => writeState(stateFile, { ...readState(stateFile), bindings: proxy.persisted() }),
  isPortAllowed: () => true,
  registerInternal: (role, port) =>
    internal.register(role, { port, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
  log: (line) => console.error(`[service-tunnels] ${line}`),
});
// restore persisted enrollments (P4): a restarted daemon re-serves the same
// (port → site) bindings; providers come back lazily on first request.
proxy.restore(readState(stateFile).bindings);

// TODO-1 (fail-clean): SHARED nginx gateway + redis singletons. Previously
// every expose created its own GatewayController (`ctx.gateway ?? new …`)
// → nginx processes accumulated per expose. The daemon now owns ONE gateway
// (nginx) + ONE redis for all exposes; they are NOT cleaned per-expose
// (shared singletons stay for the daemon lifetime — restart cost > keep).
const gateway = new GatewayController({
  configDir,
  cacheDir,
  port: 0,
  registerInternal: (role, p) => internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: ["127.0.0.1"] }),
  unregisterInternal: (role) => internal.unregister(role),
  registerPid: (role, pid) => {
    try { registerPid(cacheDir, process.pid, role, pid); } catch {}
  },
  log: (line) => console.error(`[service-tunnels] ${line}`),
});
const redis = new RedisController({ cacheDir, port: 0, log: () => {}, registerPid: (role, pid) => {
  try { registerPid(cacheDir, process.pid, role, pid); } catch {}
} });

// ── Expose registry (M0b) ──────────────────────────────────────────────────
// Records expose metadata (incl. proxy mode, which has no tunnel process) so
// the UI can list/stop them. Persisted to state.json — display only: tunnel
// processes restore via `tunnels.hydrate`, bindings via `proxy.restore`.
// Params are masked at expose.list time (never store secrets).
const exposeRegistry = new Map<string, ExposeRuntimeState>();
for (const rec of readState(stateFile).exposes ?? []) {
  if (rec && typeof rec.name === "string" && typeof rec.port === "number") exposeRegistry.set(rec.name, rec);
}
const persistExposeRegistry = () => {
  writeState(stateFile, { ...readState(stateFile), exposes: [...exposeRegistry.values()] });
};

/** Masked tunnel params for the expose detail modal (token fields → last 4). */
function maskedTunnelParams(cfg: TunnelConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const mask = (v: string) => `••••${v.slice(-4)}`;
  if (cfg.domain) out.domain = cfg.domain;
  if (cfg.server) out.server = cfg.server;
  if (cfg.host) out.host = cfg.host;
  if (cfg.user) out.user = cfg.user;
  if (cfg.port) out.port = String(cfg.port);
  if (cfg.remotePort) out.remotePort = String(cfg.remotePort);
  if (cfg.token) out.token = mask(cfg.token);
  if (cfg.args?.length) out.args = cfg.args.join(" ");
  if (cfg.cmd) out.cmd = cfg.cmd;
  if (cfg.env) {
    for (const [k, v] of Object.entries(cfg.env)) {
      out[k] = /token|secret|password|key/i.test(k) ? mask(v) : v;
    }
  }
  return out;
}

/** Resolve an expose's live running state: tunnel running, or (proxy mode)
 *  binding enrolled — mirrors st.exposes() (M0a-T3) on the daemon side. */
function exposeRunning(rec: ExposeRuntimeState): boolean {
  if (rec.tunnelName) return tunnels.get(rec.tunnelName)?.running ?? false;
  return proxy.bindings().some((b) => b.port === rec.port && (b.label ?? "") === (rec.label ?? ""));
}

/** Locate an expose's nginx access/error logs by host. Each expose creates its
 *  own GatewayController (per-expose nginx root under cacheDir/tmp/nginx-\*),
 *  so scan every nginx-* dir for <host>.access/error.log (M2). */
function findExposeLogs(host: string | undefined): { access: string | null; error: string | null } {
  if (!host) return { access: null, error: null };
  const tmpRoot = join(cacheDir, "tmp");
  let dir: string | null = null;
  try {
    if (!existsSync(tmpRoot)) return { access: null, error: null };
    for (const name of readdirSync(tmpRoot)) {
      if (!name.startsWith("nginx-")) continue;
      const logsDir = join(tmpRoot, name, "logs");
      if (!existsSync(join(logsDir, `${host}.access.log`))) continue;
      dir = logsDir;
      break;
    }
  } catch {
    return { access: null, error: null };
  }
  if (!dir) return { access: null, error: null };
  return {
    access: join(dir, `${host}.access.log`),
    error: join(dir, `${host}.error.log`),
  };
}

function resolveDaemonUserTargets(registry: AuthRegistry, provider?: string | string[]): string[] {
  const all = registry.userManagers();
  if (!provider || provider === "all") return all;
  const targets = Array.isArray(provider) ? provider : [provider];
  for (const t of targets) {
    if (!all.includes(t)) throw new Error(`provider ${t} does not support user management`);
  }
  return targets;
}

/** 与 user 目标解析同理——token 管理目标（缺省全部支持 token 的 provider）。 */
function resolveDaemonTokenTargets(registry: AuthRegistry, provider?: string | string[]): string[] {
  const all = registry.tokenManagers();
  if (!provider || provider === "all") return all;
  const targets = Array.isArray(provider) ? provider : [provider];
  for (const t of targets) {
    if (!all.includes(t)) throw new Error(`provider ${t} does not support token management`);
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
writeState(stateFile, {
  ...readState(stateFile),
  daemon: {
    pid: process.pid,
    ipc: ipc.path,
    // Windows TCP IPC has no filesystem peer gate — the per-instance secret
    // (state.json is 0600) authenticates every request.
    ...(ipc.secret ? { ipcSecret: ipc.secret } : {}),
  },
});
console.log(`daemon ready ${ipc.path}`);

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
