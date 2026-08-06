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
import { validateTunnelConfig } from "./validation.ts";
import { translate, resolveLang, type Lang } from "./i18n.ts";
import { readFileSync } from "fs";
import { join } from "path";

function usage(lang: Lang = "en"): void {
  console.log(`service-tunnels <command>

  daemon start [--foreground] | stop | status | logs
  discover [--pid <pid>] [--json] [--refresh]
  internal list [--json]
  tools list | resolve <name> | download <name> | path <name>
  proxy start [--port <p>] [--suffix <s>] [--base-path <bp>] [--password] [--foreground]
  proxy stop | status              # transport-layer management (enrollment always goes through expose --mode proxy)
  tunnel list | add <name> --type <t> [--target <p>] [--domain <d>] [--cmd <c>] |
                 [--host <h>] [--user <u>] [--port <p>] [--remote-port <rp>] |
                 [--server <s>] [--token <t>] [--arg <a>...] [--set k=v ...] [-i] |
         start|stop|remove <name>
  schemas [--type <tunnel-type|auth>]   ${translate(lang, "cli.schemasHint")}
  site list | show <name> | add <name> [--provider <p>] [--auth true|false] [--base-path <p>]
       [--policy <p>] [--domain <d>] [--suffix <s>] [--provider-set k=v ...] | remove <name>
  expose <port> [--tunnel <t>] [--tunnel-set k=v ...] [--auth [auto|none|<provider>]] [--provider-set k=v ...] [--name <n>] [--nginx-port <p>] [--mode tunnel|proxy|both] [--site <s>] [--proxy-port <p>] [--base-domain <d>] [--bypass-path <path> ...] [--allow-tool-download <true|false>] [--force]
  auth providers list | auth user list|add|set-password|remove [--site <s>] | auth totp enroll|disable|status <user> [--site <s>] [--provider ...]
  ui [--port <p>] [--no-browser]
  stop-all
  status [--json]
  config path | show
  config get <key> | set <key> <value>   # key: allow-tool-download | prefer-mirrors
                                        #      | base-path | base-path-by-provider <prov:path>
                                        #      | base-domain <domain> | proxy-port <port>
                                        #      | tool-mirrors <tool:url>

${translate(lang, "cli.usage.global")}
${translate(lang, "cli.usage.lang")}`);
}

interface CliArgs {
  configDir?: string;
  cacheDir?: string;
  json: boolean;
  refresh: boolean;
  foreground: boolean;
  lang?: string;
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
  /** --mode tunnel|proxy|both (expose): local vhost without/with tunnel. */
  mode?: string;
  /** --site <name> (expose): auth realm for the local vhost. */
  site?: string;
  /** --secret <b32> (auth totp code): 直接用给定 base32 secret 生成验证码。 */
  secret?: string;
  /** --policy <one_factor|two_factor|deny> (site add). */
  policy?: string;
  /** --proxy-port <p>: proxy transport port (mode proxy/both). */
  proxyPort?: number;
  /** --base-domain <d>: user's wildcard-DNS domain for portless base URLs. */
  baseDomain?: string;
  /** --bypass-path /health --bypass-path /metrics：认证放行白名单（可重复）。 */
  bypassPaths?: string[];
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
      case "--policy":
        args.policy = argv[++i];
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
      case "--mode":
        args.mode = argv[++i]!;
        break;
      case "--site":
        args.site = argv[++i]!;
        break;
      case "--secret":
        args.secret = argv[++i]!;
        break;
      case "--proxy-port":
        args.proxyPort = Number(argv[++i]!);
        break;
      case "--base-domain":
        args.baseDomain = argv[++i]!;
        break;
      case "--bypass-path":
        (args.bypassPaths ??= []).push(argv[++i]!);
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
      case "--lang":
        args.lang = argv[++i];
        break;
      default:
        if (a!.startsWith("-")) {
          console.error(translate(resolveLang(undefined, process.env), "cli.unknownArg", { arg: a ?? "" }));
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
 *  host renders as a form. On a real TTY every param is prompted (label /
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
  "base-domain": "baseDomain",
  "proxy-port": "proxyPort",
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
    case "baseDomain": {
      // bare domain (no scheme/path/port) — validated before it becomes a
      // virtual-host suffix / base URL
      const d = value.trim().replace(/^\./, "").toLowerCase();
      if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) || d.includes("..")) return undefined;
      return d;
    }
    case "proxyPort": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined;
      return n;
    }
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
  const lang = resolveLang(args.lang);
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
        jsonOut(await st.schemas.authProviders(lang));
      } else if (t) {
        jsonOut(st.schemas.tunnel(t, lang));
      } else {
        jsonOut({ tunnels: st.schemas.tunnels(lang), metas: st.schemas.metas(), authProviders: await st.schemas.authProviders(lang) });
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
          usage(lang);
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
        usage(lang);
        process.exit(2);
      }
      break;
    }

    case "proxy": {
      const op = cmd[1] ?? "";
      if (op === "start") {
        if (!args.foreground) {
          // daemon-owned transport (long-lived, D4: serves only enrolled ports)
          let dstat = st.daemon.status();
          if (!dstat.running) {
            st.daemon.start();
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && !st.daemon.status().running) {
              await new Promise((r) => setTimeout(r, 100));
            }
          }
          const res = await st.daemon.request("proxy.start", { port: args.port ? Number(args.port) : undefined });
          jsonOut(res ?? { error: "proxy start failed" });
          break;
        }
        // foreground: in-process transport (tests/dev)
        const port = Number(args.port ?? 4180);
        const suffix = args.suffix ?? ".st.localhost";
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
        await new Promise(() => {});
      } else if (op === "stop") {
        const res = await st.daemon.request("proxy.stop");
        jsonOut(res ?? { stopped: false });
      } else if (op === "status" || op === "") {
        const d = st.daemon.status();
        if (!d.running) {
          jsonOut({ running: false, port: 0, bindings: [] });
          break;
        }
        jsonOut((await st.daemon.request("proxy.status")) ?? { running: false, port: 0, bindings: [] });
      } else {
        usage(lang);
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
          // `command` runs a raw shell command — this CLI invocation is the
          // explicit opt-in the daemon requires (dangerous gate).
          ...(args.type === "command" ? { dangerous: true } : {}),
        };
        // Validate client-side so the operator sees the exact reason instead
        // of a silent daemon rejection (ssh option injection / INI control
        // chars / name path traversal / bad ports).
        try {
          validateTunnelConfig(cfg as Parameters<typeof validateTunnelConfig>[0], name);
        } catch (err) {
          console.error(String(err instanceof Error ? err.message : err));
          process.exit(2);
        }
        const res = await d.request<{ ok: boolean }>("tunnel.add", cfg);
        if (!res?.ok) {
          console.error("tunnel.add rejected by daemon (invalid config or daemon unavailable)");
          process.exit(1);
        }
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
        usage(lang);
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
        mode: args.mode as "tunnel" | "proxy" | "both" | undefined,
        site: args.site,
        proxyPort: args.proxyPort != null ? Number(args.proxyPort) : undefined,
        baseDomain: args.baseDomain,
        bypassPaths: args.bypassPaths,
        tunnelType: args.tunnel,
        tunnelName: args.name,
        // `--tunnel command` runs a raw shell command — this CLI invocation is
        // the explicit opt-in (same gate as tunnel add).
        dangerous: args.tunnel === "command",
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
      const site = args.site ?? "default";
      if ((op === "provider" || op === "providers") && cmd[2] === "list") {
        jsonOut(st.auth.providers());
      } else if (op === "user" && cmd[2] === "list") {
        jsonOut(await st.auth.users(args.provider, site));
      } else if (op === "user" && cmd[2] === "add") {
        const name = cmd[3];
        if (!name) {
          console.error("auth user add <name> [--password <pw>] [--display-name <n>] [--provider basic|authelia|all] [--site <s>]");
          process.exit(2);
        }
        const password = args.password ?? randomCliPassword();
        const providers = await st.auth.addUser(name, password, {
          provider: args.provider,
          site,
          displayName: args.displayName,
        });
        jsonOut({ added: name, site, providers, password: args.password ? undefined : password });
      } else if (op === "user" && cmd[2] === "set-password") {
        const name = cmd[3];
        if (!name) {
          console.error("auth user set-password <name> [--password <pw>] [--provider ...] [--site <s>]");
          process.exit(2);
        }
        const password = args.password ?? randomCliPassword();
        const providers = await st.auth.setUserPassword(name, password, args.provider, site);
        jsonOut({ updated: name, site, providers, password: args.password ? undefined : password });
      } else if (op === "user" && cmd[2] === "remove") {
        const name = cmd[3] ?? "";
        const providers = await st.auth.removeUser(name, args.provider, site);
        jsonOut({ removed: name, site, providers });
      } else if (op === "totp" && cmd[2] === "enroll") {
        const name = cmd[3];
        if (!name) {
          console.error("auth totp enroll <name> [--provider portal] [--site <s>]");
          process.exit(2);
        }
        jsonOut({ site, ...(await st.auth.totpEnroll(name, args.provider, site)) });
      } else if (op === "totp" && cmd[2] === "disable") {
        await st.auth.totpDisable(cmd[3] ?? "", args.provider, site);
        jsonOut({ disabled: cmd[3], site });
      } else if (op === "totp" && cmd[2] === "status") {
        jsonOut({ site, ...(await st.auth.totpStatus(cmd[3] ?? "", args.provider, site)) });
      } else if (op === "totp" && cmd[2] === "code") {
        // 不借助手机 app 生成当前 TOTP 验证码:从用户记录读 secret 或 --secret 直给
        const name = cmd[3] ?? "";
        const provider = args.provider ?? "portal";
        let secret = args.secret as string | undefined;
        if (!secret) {
          const dir = site === "default"
            ? join(st.dirs.cacheDir, "tmp", "portal")
            : join(st.dirs.cacheDir, "tmp", "sites", site, provider);
          try {
            const users = JSON.parse(readFileSync(join(dir, "users.json"), "utf8"));
            // pending(激活前)存 totpPending,激活后移到 totpSecret——两者都可生成码
            secret = users[name]?.totpSecret ?? users[name]?.totpPending;
          } catch { /* fallthrough */ }
          if (!secret) {
            console.error(`auth totp code: no enrolled TOTP for ${provider}/${site}/${name} (enroll first, or pass --secret)`);
            process.exit(2);
          }
        }
        const { generateTotpCode } = await import("./providers/portal.ts");
        const code = generateTotpCode(secret, 0);
        const next = generateTotpCode(secret, 1);
        if (!code || !next) {
          console.error("auth totp code: invalid secret (base32?)");
          process.exit(2);
        }
        jsonOut({ name: name || "<raw>", site, provider, secret: args.secret ? undefined : secret, code, next, expiresIn: Math.ceil((30_000 - (Date.now() % 30_000)) / 1000) });
      } else {
        console.error("auth providers list | auth user list|add|set-password|remove | auth totp enroll|disable|status|code [--site <s>] [--provider ...] [--secret <b32>]");
        process.exit(2);
      }
      break;
    }

    case "site": {
      const op = cmd[1] ?? "list";
      const name = cmd[2];
      if (op === "list") {
        jsonOut(st.sites.list());
      } else if (op === "show") {
        if (!name) {
          console.error("site show <name>");
          process.exit(2);
        }
        jsonOut(st.sites.get(name) ?? { error: `site ${name} not found` });
      } else if (op === "add") {
        if (!name) {
          console.error("site add <name> [--provider portal|authelia|basic|oauth2-proxy] [--auth true|false] [--base-path <p>] [--policy <p>] [--domain <d>] [--suffix <s>] [--provider-set k=v ...]");
          process.exit(2);
        }
        let providerParams: Record<string, unknown> | undefined;
        try {
          const schemas = await st.schemas.authProviders();
          providerParams = Object.keys(args.providerSets ?? {}).length
            ? await applyParamSets(schemas[args.provider ?? "portal"] ?? [], args.providerSets ?? {}, `auth provider "${args.provider ?? "portal"}"`)
            : undefined;
        } catch (err) {
          console.error(String(err instanceof Error ? err.message : err));
          process.exit(2);
        }
        st.sites.add(name, {
          provider: args.provider,
          auth: args.auth === undefined ? undefined : !(args.auth === false || args.auth === "false"),
          basePath: args.basePath,
          policy: (args.policy as "one_factor" | "two_factor" | "deny") ?? undefined,
          domain: args.domain,
          suffix: args.suffix,
          providerParams,
        });
        jsonOut({ added: name });
      } else if (op === "remove") {
        if (!name) {
          console.error("site remove <name>");
          process.exit(2);
        }
        st.sites.remove(name);
        jsonOut({ removed: name });
      } else {
        console.error("site list | show <name> | add <name> | remove <name>");
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
      usage(lang);
      process.exit(cmd.length ? 2 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
