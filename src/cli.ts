#!/usr/bin/env node
/**
 * service-tunnels CLI — M1: config/discover/internal/daemon/status.
 */
import { createServiceTunnels } from "./index.ts";
import { InternalRegistry } from "./internal.ts";
import { cachePaths, resolveDirs, readConfigFile, writeConfigFile, type ServiceTunnelsConfigFile } from "./config.ts";
import { readState } from "./state.ts";
import { readEnvToolPaths } from "./tools.ts";
import { TUNNEL_PARAM_SCHEMAS, tunnelParamSchema, applyParamSets, coerceParam, type TunnelType, type ParamSpec } from "./tunnels.ts";

function usage(): void {
  console.log(`service-tunnels <command>

  daemon start [--foreground] | stop | status | logs
  discover [--pid <pid>] [--json] [--refresh]
  internal list [--json]
  tools list | resolve <name> | download <name> | path <name>
  proxy start [--port <p>] [--suffix <s>] [--base-path <bp>] [--password] [--foreground]
  tunnel list | add <name> --type <t> [--target <p>] [--domain <d>] [--cmd <c>] |
                 [--host <h>] [--user <u>] [--port <p>] [--remote-port <rp>] |
                 [--server <s>] [--token <t>] [--arg <a>...] [--set k=v ...] [-i] |
         start|stop|remove <name>
  schemas [--type <tunnel-type|auth>]   # 数据驱动参数 schema(客户端据此渲染表单)
  expose <port> [--tunnel <t>] [--tunnel-set k=v ...] [--auth [auto|none|<provider>]] [--provider-set k=v ...] [--name <n>] [--nginx-port <p>] [--allow-tool-download <true|false>] [--force]
  auth providers list | auth user list|add|set-password|remove | auth totp enroll|disable|status [--provider ...]
  ui [--port <p>] [--no-browser]
  stop-all
  status [--json]
  config path | show
  config get <key> | set <key> <value>   # key: allow-tool-download | prefer-mirrors
                                        #      | base-path | base-path-by-provider <prov:path>
                                        #      | tool-mirrors <tool:url>

全局：--config-dir <dir> / --cache-dir <dir>（或 SERVICE_TUNNELS_CONFIG/CACHE）`);
}

interface CliArgs {
  configDir?: string;
  cacheDir?: string;
  json: boolean;
  refresh: boolean;
  foreground: boolean;
  pid?: number;
  port?: number;
  suffix?: string;
  basePath?: string;
  password?: string;
  type?: string;
  target?: number;
  domain?: string;
  host?: string;
  server?: string;
  token?: string;
  user?: string;
  remotePort?: number;
  cmd?: string;
  /** --set key=value (tunnel params, validated against the type schema). */
  sets?: Record<string, string>;
  /** --tunnel-set key=value (expose tunnel params). */
  tunnelSets?: Record<string, string>;
  /** --provider-set key=value (expose auth-provider params). */
  providerSets?: Record<string, string>;
  /** -i / --interactive: prompt each schema param (readline). */
  interactive?: boolean;
  tunnelArgs?: string[];
  tunnel?: string;
  name?: string;
  nginxPort?: number;
  auth?: boolean | string;
  displayName?: string;
  provider?: string;
  /** --force: skip port ownership check. */
  force?: boolean;
  /** --allow-tool-download <true|false>: per-expose tool-download override. */
  allowToolDownload?: boolean;
  [k: string]: unknown;
}

function parseArgs(argv: string[]): { cmd: string[]; args: CliArgs } {
  const args: CliArgs = { json: false, refresh: false, foreground: false };
  const cmd: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        args.json = true;
        break;
      case "--refresh":
        args.refresh = true;
        break;
      case "--foreground":
        args.foreground = true;
        break;
      case "--config-dir":
        args.configDir = argv[++i];
        break;
      case "--cache-dir":
        args.cacheDir = argv[++i];
        break;
      case "--pid":
        args.pid = Number(argv[++i]!);
        break;
      case "--port":
        args.port = Number(argv[++i]!);
        break;
      case "--suffix":
        args.suffix = argv[++i];
        break;
      case "--base-path":
        args.basePath = argv[++i];
        break;
      case "--password":
        args.password = argv[++i];
        break;
      case "--type":
        args.type = argv[++i];
        break;
      case "--target":
        args.target = Number(argv[++i]!);
        break;
      case "--domain":
        args.domain = argv[++i];
        break;
      case "--host":
        args.host = argv[++i];
        break;
      case "--server":
        args.server = argv[++i];
        break;
      case "--token":
        args.token = argv[++i];
        break;
      case "--user":
        args.user = argv[++i];
        break;
      case "--remote-port":
        args.remotePort = Number(argv[++i]!);
        break;
      case "--set":
        addSet(args, "sets", argv[++i]);
        break;
      case "--tunnel-set":
        addSet(args, "tunnelSets", argv[++i]);
        break;
      case "--provider-set":
        addSet(args, "providerSets", argv[++i]);
        break;
      case "-i":
      case "--interactive":
        args.interactive = true;
        break;
      case "--cmd":
        args.cmd = argv[++i];
        break;
      case "--arg":
        (args.tunnelArgs ??= []).push(argv[++i]!);
        break;
      case "--auth": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          args.auth = argv[++i];
        } else {
          args.auth = true;
        }
        break;
      }
      case "--tunnel":
        args.tunnel = argv[++i];
        break;
      case "--name":
        args.name = argv[++i];
        break;
      case "--nginx-port":
        args.nginxPort = Number(argv[++i]!);
        break;
      case "--allow-tool-download": {
        const raw = (argv[++i] ?? "true").toLowerCase();
        args.allowToolDownload = !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
        break;
      }
      case "--display-name":
        args.displayName = argv[++i]!;
        break;
      case "--provider":
        args.provider = argv[++i]!;
        break;
      case "--force":
        args.force = true;
        break;
      case "--port":
        args.port = Number(argv[++i]!);
        break;
      case "--no-browser":
        args.noBrowser = true;
        break;
      default:
        if (a!.startsWith("-")) {
          console.error(`未知参数: ${a}`);
          process.exit(2);
        }
        cmd.push(a!);
    }
  }
  return { cmd, args };
}

/** Parse `--set key=value` into a per-namespace map. */
function addSet(args: CliArgs, key: "sets" | "tunnelSets" | "providerSets", raw: string | undefined): void {
  if (!raw) return;
  const eq = raw.indexOf("=");
  if (eq < 0) {
    console.error(`--${key === "sets" ? "set" : key === "tunnelSets" ? "tunnel-set" : "provider-set"} expects key=value, got "${raw}"`);
    process.exit(2);
  }
  (args[key] ??= {})[raw.slice(0, eq).trim()] = raw.slice(eq + 1).trim();
}

/** Interactive schema-driven prompts (readline) — the same ParamSpec that
 *  pi-web renders as a form. On a real TTY every param is prompted (label /
 *  default / description); on piped input (scripts) readline never resolves
 *  at EOF, so we skip prompting and apply --set + defaults deterministically. */
async function promptParams(specs: ParamSpec[], initial: Record<string, string>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const apply = (s: ParamSpec, raw: string) => {
    const ans = raw.trim();
    if (ans === "" && s.default !== undefined) out[s.key] = s.default;
    else if (ans === "" && s.required) throw new Error(`required param "${s.key}" is empty (pass --set ${s.key}=...)`);
    else if (ans !== "") out[s.key] = coerceParam(ans, s);
  };
  if (!process.stdin.isTTY) {
    for (const s of specs) apply(s, initial[s.key] ?? "");
    return out;
  }
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Mask password echoes: readline's _writeToOutput (on the classic Interface
  // prototype; not in the public types) writes both the prompt AND the echoed
  // typed chars — swallow the echo while a password is being typed.
  const rl2 = rl as typeof rl & { _writeToOutput: (str: string) => void };
  let muted = false;
  const origWrite = rl2._writeToOutput.bind(rl2);
  rl2._writeToOutput = (s) => {
    if (muted) return;
    origWrite(s);
  };
  const question = (q: string, hide: boolean) =>
    new Promise<string>((resolve) => {
      rl2.question(q, (ans) => {
        muted = false;
        resolve(ans);
      });
      // prompt is written synchronously by question(); mute the typing echo now
      if (hide) setImmediate(() => {
        muted = true;
      });
    });
  try {
    for (const s of specs) {
      const def = s.default !== undefined ? ` [${String(s.default)}]` : "";
      const pre = initial[s.key];
      if (pre !== undefined) {
        apply(s, pre);
        continue;
      }
      const prompt = `${s.label ?? s.key}${s.required ? " *" : ""}${def}: ${s.description ?? ""}\n> `;
      const ans = await question(prompt, s.type === "password");
      apply(s, ans);
    }
  } finally {
    rl.close();
  }
  return out;
}

/** Validate --tunnel-set/--provider-set against the tunnel/provider schema.
 *  Returns undefined when no sets given (caller keeps library defaults). */
async function applyExposeSets(
  st: ReturnType<typeof createServiceTunnels>,
  kind: "tunnel" | "provider",
  name: string,
  sets: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  if (!Object.keys(sets).length) return undefined;
  if (kind === "tunnel") {
    return applyParamSets(TUNNEL_PARAM_SCHEMAS[name as TunnelType] ?? [], sets, `tunnel "${name}"`);
  }
  if (!name || name === "none") throw new Error("provider params need --auth <provider>");
  const schemas = await st.schemas.authProviders();
  return applyParamSets(schemas[name] ?? [], sets, `auth provider "${name}"`);
}

function randomCliPassword(len = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function jsonOut(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

/** Read the config file (loose). */
function readCliConfig(configDir: string): ServiceTunnelsConfigFile {
  return readConfigFile(configDir);
}

/** Write the config file (atomic, 0600). */
function writeCliConfig(configDir: string, f: ServiceTunnelsConfigFile): void {
  writeConfigFile(configDir, f);
}

/** kebab-case CLI key → config-file field name (allow-tool-download → allowToolDownload). */
const CONFIG_KEYS: Record<string, keyof ServiceTunnelsConfigFile> = {
  "allow-tool-download": "allowToolDownload",
  "prefer-mirrors": "preferMirrors",
  "base-path": "basePath",
  "base-path-by-provider": "basePathByProvider",
  "tool-mirrors": "toolMirrors",
};

/** Parse a `config set <key> <value>` value per key type. Returns undefined
 *  when the key is unknown or the value is invalid. */
function parseCliConfigValue(key: keyof ServiceTunnelsConfigFile, value: string): unknown {
  const boolVal = (): boolean | undefined => {
    const v = value.toLowerCase();
    if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "off" || v === "no") return false;
    return undefined;
  };
  switch (key) {
    case "allowToolDownload":
    case "preferMirrors":
      return boolVal();
    case "basePath":
      return value.startsWith("/") ? value.replace(/\/+$/, "") : undefined;
    case "basePathByProvider": {
      const idx = value.indexOf(":");
      if (idx <= 0 || !value.slice(idx + 1).startsWith("/")) return undefined;
      return { [value.slice(0, idx)]: value.slice(idx + 1).replace(/\/+$/, "") };
    }
    case "toolMirrors": {
      const idx = value.indexOf(":");
      if (idx <= 0 || !value.slice(idx + 1).startsWith("http")) return undefined;
      return { [value.slice(0, idx)]: [value.slice(idx + 1)] };
    }
    default:
      return undefined;
  }
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const st = createServiceTunnels({ configDir: args.configDir, cacheDir: args.cacheDir, guardian: false });
  const sub = cmd[0] ?? "";

  switch (sub) {
    case "config": {
      if (cmd[1] === "path") {
        process.stdout.write(`${st.dirs.configDir}\n${st.dirs.cacheDir}\n`);
      } else if (cmd[1] === "get" && cmd[2]) {
        const field = CONFIG_KEYS[cmd[2]];
        if (!field) {
          console.error(`unknown config key: ${cmd[2]} (known: ${Object.keys(CONFIG_KEYS).join(", ")})`);
          process.exit(2);
        }
        jsonOut({ [cmd[2]]: readCliConfig(st.dirs.configDir)[field] ?? null });
      } else if (cmd[1] === "set" && cmd[2]) {
        const value = cmd[3];
        const key = CONFIG_KEYS[cmd[2]];
        if (value === undefined || !key) {
          console.error(`config set ${cmd[2]} <value>  (known keys: ${Object.keys(CONFIG_KEYS).join(", ")})`);
          process.exit(2);
        }
        // git-config style: persist to service-tunnels.json (atomic + chmod
        // 600); per-call params / env still win at read time.
        const f = readCliConfig(st.dirs.configDir);
        const parsed = parseCliConfigValue(key, value);
        if (parsed === undefined) {
          console.error(`unsupported or invalid value for ${cmd[2]}: ${value}`);
          process.exit(2);
        }
        (f as Record<string, unknown>)[key] = parsed;
        writeCliConfig(st.dirs.configDir, f);
        if (key === "allowToolDownload") st.tools.setAllowDownload(!!parsed);
        jsonOut({ [key]: parsed });
      } else {
        jsonOut({ configDir: st.dirs.configDir, cacheDir: st.dirs.cacheDir });
      }
      break;
    }

    case "schemas": {
      // data-driven provider/tunnel param schemas (clients render forms from
      // these — adding a type/provider needs no client changes)
      const t = args.type;
      if (t === "auth") {
        jsonOut(await st.schemas.authProviders());
      } else if (t) {
        jsonOut(st.schemas.tunnel(t));
      } else {
        jsonOut({ tunnels: st.schemas.tunnels(), metas: st.schemas.metas(), authProviders: await st.schemas.authProviders() });
      }
      break;
    }

    case "discover": {
      // CLI 模式：本地执行（以 CLI/用户 shell 进程树为根）——用户测试服务是
      // 调用方 shell 的后代，不是 daemon 的后代（design.md §4.9）。
      // 从 state.json 加载框架内部端口进 registry，discovery 会排除它们。
      const local = new InternalRegistry();
      for (const entry of st.state().internal) {
        local.register(entry.role, {
          port: entry.port,
          pid: entry.pid,
          process: entry.role,
          cmdline: entry.role,
          addresses: entry.addresses,
        });
      }
      const ports = st.discovery.getPorts({
        rootPid: args.pid,
        force: args.refresh,
      });
      jsonOut(ports);
      break;
    }

    case "internal": {
      const listed = await st.daemon.request("internal.list");
      jsonOut(listed ?? st.internal.list());
      break;
    }

    case "daemon": {
      const op = cmd[1] ?? "";
      switch (op) {
        case "start": {
          const status = st.daemon.start({ foreground: args.foreground });
          if (args.foreground) {
            // daemon runs attached — this process becomes it
            await new Promise(() => {});
          }
          jsonOut(status);
          break;
        }
        case "stop": {
          jsonOut({ stopped: await st.daemon.stop() });
          break;
        }
        case "status": {
          jsonOut(st.daemon.status());
          break;
        }
        case "logs": {
          const { stateFile } = cachePaths(st.dirs.cacheDir);
          process.stdout.write(`${stateFile}.daemon.log\n`);
          break;
        }
        default:
          usage();
          process.exit(2);
      }
      break;
    }

    case "tools": {
      const op = cmd[1] ?? "list";
      if (op === "list") {
        jsonOut(st.tools.list());
      } else if (op === "resolve" || op === "path") {
        const name = cmd[2];
        if (!name) {
          console.error("tools " + op + " <name>");
          process.exit(2);
        }
        jsonOut({ name, path: st.tools.resolve(name) });
      } else if (op === "download") {
        const name = cmd[2];
        if (!name) {
          console.error("tools download <name>");
          process.exit(2);
        }
        const path = await st.tools.ensure(name);
        jsonOut({ name, path });
      } else {
        usage();
        process.exit(2);
      }
      break;
    }

    case "proxy": {
      const op = cmd[1] ?? "";
      if (op === "start") {
        const port = Number(args.port ?? 4180);
        const suffix = args.suffix ?? ".pi.localhost";
        const basePath = args.basePath ?? "";
        const password = args.password ?? "";
        const server = st.proxy.create({
          port,
          suffixes: suffix.split(",").map((s2: string) => (s2.startsWith(".") ? s2 : `.${s2}`)),
          basePath,
          password,
          rootPid: args.pid,
          refresh: args.refresh,
        });
        server.once("listening", () => {
          const addr = server.address();
          const p = typeof addr === "object" && addr ? addr.port : port;
          process.stdout.write(`proxy listening on 127.0.0.1:${p} (suffix: ${suffix})\n`);
        });
        if (!args.foreground) {
          // non-foreground: spawn as child of the daemon in a later milestone;
          // M2 keeps the server in this process.
        }
        await new Promise(() => {});
      } else {
        usage();
        process.exit(2);
      }
      break;
    }

    case "tunnel": {
      const op = cmd[1] ?? "list";
      const name = cmd[2];
      // CLI 模式：隧道进程由 daemon 持有（跨 CLI 调用可见/可控）。
      // daemon 未运行 → 自动拉起（--auto-daemon 语义：常驻进程归 daemon）。
      const dstat = st.daemon.status();
      if (!dstat.running) {
        st.daemon.start();
        // wait for IPC socket
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !st.daemon.status().running) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const d = st.daemon;
      if (op === "list") {
        const infos = await d.request("tunnel.list");
        jsonOut(infos ?? []);
      } else if (op === "add") {
        if (!name || !args.type) {
          console.error("tunnel add <name> --type <ngrok|frpc|ssh|serveo|cloudflared|localtunnel|bore|command> [--set k=v ...] [-i]");
          process.exit(2);
        }
        const specs = TUNNEL_PARAM_SCHEMAS[args.type as TunnelType];
        if (!specs) {
          console.error(`unknown tunnel type "${args.type}" (valid: ${Object.keys(TUNNEL_PARAM_SCHEMAS).join(", ")})`);
          process.exit(2);
        }
        let setCfg: Record<string, unknown> = {};
        try {
          if (args.interactive) {
            setCfg = await promptParams(specs, args.sets ?? {});
          } else {
            setCfg = applyParamSets(specs, args.sets ?? {}, `tunnel type "${args.type}"`);
          }
        } catch (err) {
          console.error(String(err instanceof Error ? err.message : err));
          process.exit(2);
        }
        const cfg = {
          name,
          type: args.type,
          target: args.target ? Number(args.target) : undefined,
          ...setCfg,
          // explicit named flags override --set
          ...(args.domain ? { domain: args.domain } : {}),
          ...(args.cmd ? { cmd: args.cmd } : {}),
          ...(args.host ? { host: args.host } : {}),
          ...(args.user ? { user: args.user } : {}),
          ...(args.port !== undefined ? { port: args.port } : {}),
          ...(args.remotePort !== undefined ? { remotePort: args.remotePort } : {}),
          ...(args.server ? { server: args.server } : {}),
          ...(args.token ? { token: args.token } : {}),
          ...(args.tunnelArgs?.length ? { args: args.tunnelArgs } : {}),
        };
        await d.request("tunnel.add", cfg);
        jsonOut({ added: name });
      } else if (op === "start" || op === "stop" || op === "remove") {
        if (!name) {
          console.error(`tunnel ${op} <name>`);
          process.exit(2);
        }
        if (op === "start") {
          const info = await d.request("tunnel.start", name);
          jsonOut(info ?? { error: "start failed" });
        } else if (op === "stop") {
          await d.request("tunnel.stop", name);
          jsonOut({ stopped: name });
        } else {
          await d.request("tunnel.remove", name);
          jsonOut({ removed: name });
        }
      } else {
        usage();
        process.exit(2);
      }
      break;
    }

    case "expose": {
      const port = Number(cmd[1]);
      if (!Number.isFinite(port) || port <= 0) {
        console.error("expose <port>");
        process.exit(2);
      }
      // daemon mode: tunnel processes live in the daemon → expose must too
      let dstat = st.daemon.status();
      if (!dstat.running) {
        st.daemon.start();
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !st.daemon.status().running) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      let tunnelParams: Record<string, unknown> | undefined;
      let providerParams: Record<string, unknown> | undefined;
      try {
        tunnelParams = await applyExposeSets(st, "tunnel", args.tunnel ?? "ngrok", args.tunnelSets ?? {});
        providerParams = await applyExposeSets(st, "provider", typeof args.auth === "string" ? args.auth : "", args.providerSets ?? {});
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(2);
      }
      const res = await st.daemon.request("expose", {
        port,
        // "auto" → expose 内部按平台解析默认 provider（win32=portal，其余=authelia）
        // "none" → 显式无认证（纯透传隧道，走 none 网关路径）
        auth: args.auth === "auto" || args.auth === true
          ? "auto"
          : args.auth === "none" ? false : Boolean(args.auth),
        provider: typeof args.auth === "string" && args.auth !== "auto" ? args.auth : undefined,
        tunnelType: args.tunnel,
        tunnelName: args.name,
        nginxPort: args.nginxPort ? Number(args.nginxPort) : undefined,
        basePath: args.basePath,
        tunnelParams,
        providerParams,
        force: args.force,
        allowToolDownload: args.allowToolDownload,
      }, 90_000);
      jsonOut(res);
      break;
    }

    case "auth": {
      const op = cmd[1] ?? "list";
      if ((op === "provider" || op === "providers") && cmd[2] === "list") {
        jsonOut(st.auth.providers());
      } else if (op === "user" && cmd[2] === "list") {
        jsonOut(await st.auth.users(args.provider));
      } else if (op === "user" && cmd[2] === "add") {
        const name = cmd[3];
        if (!name) {
          console.error("auth user add <name> [--password <pw>] [--display-name <n>] [--provider basic|authelia|all]");
          process.exit(2);
        }
        const password = args.password ?? randomCliPassword();
        const providers = await st.auth.addUser(name, password, {
          provider: args.provider,
          displayName: args.displayName,
        });
        jsonOut({ added: name, providers, password: args.password ? undefined : password });
      } else if (op === "user" && cmd[2] === "set-password") {
        const name = cmd[3];
        if (!name) {
          console.error("auth user set-password <name> [--password <pw>] [--provider ...]");
          process.exit(2);
        }
        const password = args.password ?? randomCliPassword();
        const providers = await st.auth.setUserPassword(name, password, args.provider);
        jsonOut({ updated: name, providers, password: args.password ? undefined : password });
      } else if (op === "user" && cmd[2] === "remove") {
        const name = cmd[3] ?? "";
        const providers = await st.auth.removeUser(name, args.provider);
        jsonOut({ removed: name, providers });
      } else if (op === "totp" && cmd[2] === "enroll") {
        const name = cmd[3];
        if (!name) {
          console.error("auth totp enroll <name> [--provider portal]");
          process.exit(2);
        }
        jsonOut(await st.auth.totpEnroll(name, args.provider));
      } else if (op === "totp" && cmd[2] === "disable") {
        await st.auth.totpDisable(cmd[3] ?? "", args.provider);
        jsonOut({ disabled: cmd[3] });
      } else if (op === "totp" && cmd[2] === "status") {
        jsonOut(await st.auth.totpStatus(cmd[3] ?? "", args.provider));
      } else {
        console.error("auth providers list | auth user list|add|set-password|remove | auth totp enroll|disable|status [--provider ...]");
        process.exit(2);
      }
      break;
    }

    case "ui": {
      const { startUi } = await import("./ui.ts");
      const ui = startUi(st, {
        port: args.port ? Number(args.port) : undefined,
        openBrowser: !args.noBrowser,
      });
      // Keep the process alive
      await new Promise(() => {});
      break;
    }

    case "stop-all": {
      // stop the daemon (which kills nginx/authelia/redis/tunnels via role
      // markers), then remove the state file
      const stopped = await st.daemon.stop();
      const { rmSync } = await import("node:fs");
      const { cachePaths } = await import("../src/config.ts");
      rmSync(cachePaths(st.dirs.cacheDir).stateFile, { force: true });
      jsonOut({ stopped, cleaned: true });
      break;
    }

    case "status": {
      const d = st.daemon.status();
      jsonOut({ daemon: d, internal: st.state().internal, tunnels: st.state().tunnels });
      break;
    }

    default:
      usage();
      process.exit(cmd.length ? 2 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
