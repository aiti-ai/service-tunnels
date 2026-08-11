/**
 * ui-api — src/ui.ts 拆出的 JSON API 路由（TODO-6 模块化重构）。
 * createApiHandler 处理全部 /api/* 端点；返回 true=已处理。
 */
import type { IncomingMessage, ServerResponse } from "http";
import { resolveLang, type Lang } from "./i18n.ts";
import { parseTokenExpiry } from "./providers/token.ts";
import { json, readJson, daemonOrLocal, maskParams, findExpose, sshDomainFor, type UiContext } from "./ui-helpers.ts";

export async function createApiHandler(
  ctx: UiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  lang: Lang,
): Promise<boolean> {
if (path === "/api/status" && req.method === "GET") {
  const st = ctx.st;
  const dstat = st.daemon.status();
  json(res, 200, {
    providers: st.auth.providers(),
    providerOrder: st.auth.providerOrder(),
    defaultProvider: st.auth.defaultProvider(),
    tunnelSchemas: st.schemas.tunnels(lang),
    tunnelMetas: st.schemas.metas(),
    authProviderSchemas: await st.schemas.authProviders(lang),
    authMetas: st.schemas.authMetas(),
    tunnelTcpSupport: st.tunnels.tcpSupport ? st.tunnels.tcpSupport() : [],
    userManagers: st.auth.userManagers(),
    totpProviders: st.auth.totpProviders(),
    sites: st.sites.list(),
    tools: { list: st.tools.list(), allowDownload: st.tools.allowDownload() },
    allowAuthNone: st.auth.noneAllowed(),
    daemon: dstat,
    mode: dstat.running ? "daemon" : "embedded",
  });
  return true;
}

// ── /api/live — dynamic state (10s poll) ───────────────────────────
if (path === "/api/live" && req.method === "GET") {
  const st = ctx.st;
  const dstat = st.daemon.status();
  // ports: daemon first (excludes internal + ssh ports), fallback
  // in-process current-user listening ports (NOT process-tree discovery —
  // the UI process tree has no children; scope=current-user finds same-
  // user services, mirrors daemon port.list).
  const ports = (await daemonOrLocal<any[]>(ctx, "port.list", { scope: "current-user" }, async () => {
    const { listListeningPorts } = await import("./ports.ts");
    const internalPorts = new Set((st.internal.list() ?? []).map((p) => p.port));
    return listListeningPorts("current-user")
      .filter((p) => !internalPorts.has(p.port) && p.port !== ctx.port)
      .map((p) => ({ ...p, addresses: ["127.0.0.1"] }));
  })) ?? [];
  const internal = (await daemonOrLocal<any[]>(ctx, "internal.list", undefined, () => st.internal.list())) ?? [];
  const tunnels = (await daemonOrLocal<any[]>(ctx, "tunnel.list", undefined, () => st.tunnels.list())) ?? [];
  // exposes: daemon registry first (dual path), fallback in-process
  const exposes = (await daemonOrLocal<any[]>(ctx, "expose.list", undefined, () => st.exposes(), 10_000)) ?? [];
  const proxy = (await daemonOrLocal<any>(ctx, "proxy.status", undefined, () => st.proxy.status())) ?? null;
  json(res, 200, {
    ports, internal, tunnels,
    exposes: exposes.map((e) => ({ ...e, params: maskParams(e.params) })),
    proxy, daemon: dstat,
    mode: dstat.running ? "daemon" : "embedded",
  });
  return true;
}

// ── expose / stop ──────────────────────────────────────────────────
if (path === "/api/expose" && req.method === "POST") {
  const body = await readJson<{
    port?: number; mode?: string; auth?: boolean; provider?: string; tunnel?: string;
    site?: string; policy?: string; protocol?: string; tunnelParams?: Record<string, unknown>;
    providerParams?: Record<string, unknown>; user?: { name: string; password: string };
    ngrokAuthtoken?: string; allowAuthNone?: boolean; allowToolDownload?: boolean;
  }>(req);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    json(res, 400, { error: "port required (1-65535)" });
    return true;
  }
  if (body.tunnel === "command") {
    json(res, 400, { error: "tunnel type 'command' is not allowed through the UI" });
    return true;
  }
  const result = await daemonOrLocal<any>(ctx, "expose", {
    port,
    mode: body.mode,
    auth: body.auth,
    provider: body.provider,
    tunnelType: body.tunnel,
    site: body.site,
    policy: body.policy,
    protocol: body.protocol,
    tunnelParams: body.tunnelParams,
    providerParams: body.providerParams,
    user: body.user,
    ngrokAuthtoken: body.ngrokAuthtoken,
    allowAuthNone: body.allowAuthNone,
    allowToolDownload: body.allowToolDownload,
  }, () => ctx.st.auth.expose(port, {
    mode: body.mode as never,
    auth: body.auth,
    provider: body.provider,
    tunnelType: body.tunnel,
    site: body.site,
    policy: body.policy as never,
    protocol: body.protocol as never,
    tunnelParams: body.tunnelParams,
    providerParams: body.providerParams,
    user: body.user,
    ngrokAuthtoken: body.ngrokAuthtoken,
    allowAuthNone: body.allowAuthNone,
    allowToolDownload: body.allowToolDownload,
  }), 90_000);
  if (result === null) {
    json(res, 400, { error: "expose rejected (daemon unavailable or invalid config)" });
    return true;
  }
  json(res, 200, result);
  return true;
}

if (path === "/api/expose-stop" && req.method === "POST") {
  const body = await readJson<{ name?: string }>(req);
  const name = String(body.name ?? "");
  if (!name) { json(res, 400, { error: "name required" }); return true; }
  const r = await daemonOrLocal<any>(ctx, "expose.stop", name, () => ctx.st.tunnels.stop(name));
  if (r === null) { json(res, 400, { error: "stop failed (daemon unavailable)" }); return true; }
  json(res, 200, { stopped: name });
  return true;
}

if (path === "/api/expose-stop-all" && req.method === "POST") {
  await daemonOrLocal<any>(ctx, "expose.stopAll", undefined, async () => {
    await ctx.st.tunnels.stopAll();
    for (const b of ctx.st.proxy.bindings()) {
      try { ctx.st.proxy.removeBinding(b.port, b.label); } catch { /* gone */ }
    }
  });
  json(res, 200, { ok: true });
  return true;
}

// ── logs (dual-mode: daemon expose.list or in-process st.exposes) ────
if (path === "/api/logs" && req.method === "GET") {
  const { readFileSync, existsSync } = await import("node:fs");
  const tail = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").slice(-50).join("\n") : "(no log yet)");
  // direct file read (from /api/logs-list) — only paths under the nginx
  // logs tree are accepted (path traversal defense)
  const logPath = url.searchParams.get("path");
  if (logPath) {
    const { dirname, resolve, join } = await import("node:path");
    const abs = resolve(logPath);
    const logsRoot = resolve(join(ctx.st.dirs.cacheDir, "tmp"));
    if (!abs.startsWith(logsRoot + "/") || !abs.endsWith(".log")) {
      json(res, 403, { error: "path outside the logs tree" });
      return true;
    }
    json(res, 200, { access: tail(abs) });
    return true;
  }
  const name = url.searchParams.get("name") ?? "";
  const ex = await findExpose(ctx, name);
  if (!ex?.accessLog) { json(res, 404, { error: "expose not found or no logs yet" }); return true; }
  json(res, 200, { access: tail(ex.accessLog), error: tail(ex.errorLog ?? "") });
  return true;
}

if (path === "/api/logs-list" && req.method === "GET") {
  const name = url.searchParams.get("name") ?? "";
  const ex = await findExpose(ctx, name);
  if (!ex?.accessLog) { json(res, 200, { files: [] }); return true; }
  const { readdirSync, statSync, existsSync } = await import("node:fs");
  const { dirname, basename } = await import("node:path");
  const dir = dirname(ex.accessLog);
  let files: Array<{ name: string; path: string; size: number; mtime: number }> = [];
  if (existsSync(dir)) {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const p = `${dir}/${f}`;
        const s = statSync(p);
        return { name: basename(f), path: p, size: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  json(res, 200, { files });
  return true;
}

// ── users / totp ───────────────────────────────────────────────────
if (path === "/api/user-summary" && req.method === "POST") {
  const st = ctx.st;
  const siteNames = ["default", ...st.sites.list().map((s) => s.name).filter((n) => n !== "default")];
  const managers = st.auth.userManagers();
  const totpProviders = st.auth.totpProviders();
  const rows: { site: string; provider: string; count: number; totp: number }[] = [];
  for (const site of siteNames) {
    for (const provider of managers) {
      try {
        const res2 = await st.auth.users(provider, site);
        const users = res2.find((x) => x.provider === provider)?.users ?? [];
        let totp = 0;
        if (totpProviders.includes(provider)) {
          for (const u of users) {
            try { if ((await st.auth.totpStatus(u.name, provider, site)).enrolled) totp++; } catch { /* skip */ }
          }
        }
        rows.push({ site, provider, count: users.length, totp });
      } catch { /* provider/site combo unavailable */ }
    }
    // ssh keys column (site + ssh, M0b): count via daemon ssh key list
    // (in-process st.ssh fallback for embedded/--no-daemon mode)
    try {
      const keys = (await daemonOrLocal<any[]>(ctx, "ssh.key.list", { domain: sshDomainFor(site) }, () => ctx.st.ssh.keys.list(sshDomainFor(site)) as any[], 5_000)) ?? [];
      rows.push({ site, provider: "ssh", count: keys.length, totp: 0 });
    } catch { rows.push({ site, provider: "ssh", count: 0, totp: 0 }); }
  }
  json(res, 200, { rows });
  return true;
}

if (path === "/api/user-list" && req.method === "GET") {
  const site = url.searchParams.get("site") ?? "default";
  const provider = url.searchParams.get("provider") ?? "all";
  const groups = await ctx.st.auth.users(provider, site);
  const users = [];
  for (const g of groups) {
    for (const u of g.users) {
      let totp = false;
      try { totp = !!(await ctx.st.auth.totpStatus(u.name, g.provider, site)).enrolled; } catch { /* no totp */ }
      users.push({ ...u, provider: g.provider, totp });
    }
  }
  json(res, 200, { users });
  return true;
}

const userAction = /^\/api\/(user-add|user-set-password|user-remove|totp-enroll|totp-activate|totp-disable)$/.exec(path);
if (userAction && req.method === "POST") {
  const op = userAction[1]!;
  const body = await readJson<{ name?: string; password?: string; code?: string; site?: string; provider?: string; label?: string }>(req);
  const site = body.site ?? "default";
  const provider = body.provider ?? undefined;
  const st = ctx.st;
  try {
    if (op === "user-add") {
      if (!body.name || !body.password) { json(res, 400, { error: "name and password required" }); return true; }
      const providers = await st.auth.addUser(body.name, body.password, { provider, site });
      json(res, 200, { added: body.name, providers });
    } else if (op === "user-set-password") {
      if (!body.name || !body.password) { json(res, 400, { error: "name and password required" }); return true; }
      const providers = await st.auth.setUserPassword(body.name, body.password, provider, site);
      json(res, 200, { updated: body.name, providers });
    } else if (op === "user-remove") {
      const providers = await st.auth.removeUser(body.name ?? "", provider, site);
      json(res, 200, { removed: body.name, providers });
    } else if (op === "totp-enroll") {
      if (!body.name) { json(res, 400, { error: "name required" }); return true; }
      json(res, 200, await st.auth.totpEnroll(body.name, provider, site, body.label));
    } else if (op === "totp-activate") {
      if (!body.name || !body.code) { json(res, 400, { error: "name and code required" }); return true; }
      json(res, 200, await st.auth.totpActivate(body.name, body.code, provider, site));
    } else if (op === "totp-disable") {
      await st.auth.totpDisable(body.name ?? "", provider, site);
      json(res, 200, { disabled: body.name });
    }
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

// ── tokens ─────────────────────────────────────────────────────────
if (path === "/api/token-list" && req.method === "GET") {
  const site = url.searchParams.get("site") ?? "default";
  const groups = await ctx.st.auth.tokens(undefined, site);
  json(res, 200, { tokens: groups.flatMap((g) => g.tokens) });
  return true;
}
if (path === "/api/token-create" && req.method === "POST") {
  const body = await readJson<{ description?: string; expiresAt?: string; site?: string }>(req);
  try {
    const expiresAt = parseTokenExpiry(body.expiresAt);
    const tokens = await ctx.st.auth.createToken({ description: body.description, expiresAt, site: body.site ?? "default" });
    json(res, 200, { tokens });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
if (path === "/api/token-revoke" && req.method === "POST") {
  const body = await readJson<{ id?: string; site?: string }>(req);
  await ctx.st.auth.revokeToken(body.id ?? "", undefined, body.site ?? "default");
  json(res, 200, { revoked: body.id });
  return true;
}

// ── sites ──────────────────────────────────────────────────────────
if (path === "/api/sites-list" && req.method === "GET") {
  const st = ctx.st;
  const sites = st.sites.list();
  const exposes = st.exposes().filter((e) => e.localUrl);
  json(res, 200, {
    sites: sites.map((s) => {
      const ex = exposes.filter((e) => (e.site || "default") === s.name);
      return {
        ...s,
        localUrl: ex.map((e) => e.localUrl).find(Boolean),
        baseUrl: ex.map((e) => e.baseUrl).find(Boolean),
        domainUrl: ex.map((e) => e.domainUrl).find(Boolean),
      };
    }),
  });
  return true;
}
if (path === "/api/site-add" && req.method === "POST") {
  const body = await readJson<{ name?: string }>(req);
  try { ctx.st.sites.add(body.name ?? "", {}); json(res, 200, { added: body.name }); }
  catch (err) { json(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
  return true;
}
if (path === "/api/site-remove" && req.method === "POST") {
  const body = await readJson<{ name?: string }>(req);
  try { ctx.st.sites.remove(body.name ?? ""); json(res, 200, { removed: body.name }); }
  catch (err) { json(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
  return true;
}

// ── ssh keys (site-scoped; M0b-ssh: daemon ssh.key.* first, in-process
//  st.ssh fallback — domain = site's backing ssh domain) ──
if (path === "/api/ssh-keys" && req.method === "GET") {
  const site = url.searchParams.get("site") ?? "default";
  const keys = (await daemonOrLocal<any[]>(ctx, "ssh.key.list", { domain: sshDomainFor(site) }, () => ctx.st.ssh.keys.list(sshDomainFor(site)) as any[], 5_000)) ?? [];
  json(res, 200, { keys });
  return true;
}
if (path === "/api/ssh-keys" && req.method === "POST") {
  const body = await readJson<{ action?: string; site?: string; publicKey?: string; type?: string; comment?: string; fingerprint?: string; count?: number }>(req);
  const site = body.site ?? "default";
  const domain = sshDomainFor(site);
  try {
    let result: unknown;
    if (body.action === "add") {
      if (!body.publicKey) { json(res, 400, { error: "publicKey required" }); return true; }
      result = (await daemonOrLocal<any>(ctx, "ssh.key.add", { domain, publicKey: body.publicKey }, () => ctx.st.ssh.keys.add(domain, body.publicKey ?? ""))) ?? { error: "ssh add rejected" };
    } else if (body.action === "generate") {
      result = (await daemonOrLocal<any>(ctx, "ssh.key.generate", { domain, type: body.type ?? "ed25519", comment: body.comment, count: body.count }, () => ctx.st.ssh.keys.generate(domain, { type: body.type as never, comment: body.comment, count: body.count }))) ?? { error: "ssh generate rejected" };
    } else if (body.action === "revoke") {
      if (!body.fingerprint) { json(res, 400, { error: "fingerprint required" }); return true; }
      result = (await daemonOrLocal<any>(ctx, "ssh.key.remove", { domain, fingerprint: body.fingerprint }, () => ctx.st.ssh.keys.remove(domain, body.fingerprint ?? ""))) ?? { error: "ssh revoke rejected" };
    } else {
      json(res, 400, { error: "unknown action (add|generate|revoke)" });
      return true;
    }
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

// ── settings ───────────────────────────────────────────────────────
if (path === "/api/settings" && req.method === "POST") {
  const body = await readJson<{ allowToolDownload?: boolean }>(req);
  if (typeof body.allowToolDownload === "boolean") {
    ctx.st.tools.setAllowDownload(body.allowToolDownload);
    json(res, 200, { allowToolDownload: ctx.st.tools.allowDownload() });
    return true;
  }
  json(res, 400, { error: "allowToolDownload required (boolean)" });
  return true;
}

// ── protocol auto-detect (expose form default) ──────────────────────
if (path === "/api/port-detect" && req.method === "GET") {
  const port = Number(url.searchParams.get("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    json(res, 400, { error: "port required (1-65535)" });
    return true;
  }
  const { detectProtocol } = await import("./gateway.ts");
  const { tunnelSupportsTcp } = await import("./tunnels.ts");
  let protocol: "http" | "https" | "tcp" = "tcp";
  try { protocol = await detectProtocol(port, 1200); } catch { protocol = "tcp"; }
  const types = ["ngrok", "ssh", "frpc", "cloudflared", "localtunnel", "bore", "serveo", "command"];
  json(res, 200, {
    port,
    protocol,
    tunnelTypes: types.filter((t) => t === "command" || (protocol === "tcp" ? tunnelSupportsTcp(t) : true)),
  });
  return true;
}

// ── presets (TODO-2): 参数变体 ──────────────────────────────────────
if (path === "/api/presets" && req.method === "GET") {
  const kind = url.searchParams.get("kind") === "auth" ? "auth" : "tunnel";
  const type = url.searchParams.get("type") ?? undefined;
  const name = url.searchParams.get("name") ?? undefined;
  // ?name= → get（明文，供暴露合并）；否则 list（掩码，供展示）
  if (name) {
    const r = await daemonOrLocal<any>(ctx, "preset.get", { kind, type, name }, () => ctx.st.presets.get(kind, type ?? "", name) ?? null, 5_000);
    json(res, 200, r ?? { error: "preset not found" });
  } else {
    const r = (await daemonOrLocal<any[]>(ctx, "preset.list", { kind, type }, () => ctx.st.presets.list(kind, type), 5_000)) ?? [];
    json(res, 200, { presets: r });
  }
  return true;
}
if (path === "/api/presets" && req.method === "POST") {
  const body = await readJson<{ action?: string; kind?: string; type?: string; name?: string; params?: Record<string, string> }>(req);
  const kind = body.kind === "auth" ? "auth" : "tunnel";
  try {
    if (body.action === "save") {
      if (!body.type || !body.name) { json(res, 400, { error: "type and name required" }); return true; }
      await daemonOrLocal<any>(ctx, "preset.save", { kind, type: body.type, name: body.name, params: body.params }, () => {
        ctx.st.presets.save(kind, body.type!, body.name!, body.params ?? {});
        return { ok: true };
      }, 5_000);
      json(res, 200, { saved: body.name });
    } else if (body.action === "remove") {
      if (!body.type || !body.name) { json(res, 400, { error: "type and name required" }); return true; }
      const r = await daemonOrLocal<any>(ctx, "preset.remove", { kind, type: body.type, name: body.name }, () => ctx.st.presets.remove(kind, body.type!, body.name!), 5_000);
      json(res, 200, r ?? { removed: false });
    } else {
      json(res, 400, { error: "unknown action (save|remove)" });
    }
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

// ── config (read-only diagnostic) ───────────────────────────────────
if (path === "/api/config" && req.method === "GET") {
  const { readConfigFile } = await import("./config.ts");
  json(res, 200, {
    dirs: { configDir: ctx.st.dirs.configDir, cacheDir: ctx.st.dirs.cacheDir },
    config: readConfigFile(ctx.st.dirs.configDir),
  });
  return true;
}

  json(res, 404, { error: "Not Found" });
  return false;
}
