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
import { upgradeRun, upgradeStatus, serviceAction, upgradeVersion } from "./upgrade/facade.ts";
import { readFileSync } from "fs";
import { basename, join } from "path";

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
  ddns list | add <name> --provider <cloudflare|dnspod|aliyun|duckdns>
       --record <fqdn> --zone <z> [--token <t>] [--secret <s>] [--access-key-id <k>]
       [--ttl <n>] [--interval <sec>] | remove <name>
  ddns update [--name <n>] [--loop] | ip    # keep a stable name on a dynamic IP
  ddns provider-profile-add <name> --provider <p> [--token <t>] [--secret <s>] [--zone-id <zid>]
  ddns profile-add <name> --provider-profile <pp> --zone <z> [--record <r>] [--txt-name <tn>]
  ddns entry-add <name> --profile <p>|(--provider-profile <pp> --zone <z>) --kind portmap|tunnel
       [--follow-tunnel <t>] [--ip] [--txt] [--cname] [--txt-url] | registry-list
  schemas [--type <tunnel-type|auth>]   ${translate(lang, "cli.schemasHint")}
  site list | show <name> | add <name> [--provider <p>] [--auth true|false] [--base-path <p>]
       [--policy <p>] [--domain <d>] [--suffix <s>] [--provider-set k=v ...] | remove <name>
  expose <port> [--tunnel <t>] [--tunnel-set k=v ...] [--auth [auto|none|<provider>]] [--provider-set k=v ...] [--portmap-set k=v ...] [--name <n>] [--nginx-port <p>] [--mode tunnel|proxy|both|portmap|ipv6] [--ipv6-address <addr>] [--site <s>] [--proxy-port <p>] [--base-domain <d>] [--bypass-path <path> ...] [--inject-html <fragment>] [--inject-position head|prepend] [--allow-tool-download <true|false>] [--allow-auth-none <true|false>] [--force]
  portmap probe [--gateway <ip>] | list | stop <key>   # router UPnP/NAT-PMP mapping (mode portmap)
  ipv6 diagnose | list | stop <key>                    # public IPv6 diagnosis + direct-expose transports (mode ipv6, no tunnel)
  ssh domain list | create <name> --forward-port <p> [--ssh-port <p>] [--reverse-port <p>] [--host <h>] |
               remove <name> | key list|add|generate|remove | host fingerprints [--domain <d>] [--public-key <k>] [--fingerprint <fp>] [--type ed25519|rsa|ecdsa] [--bits <n>] [--count <n>] [--comment <c>]
  auth providers list | auth user list|add|set-password|remove [--site <s>] | auth token list|create|revoke [--site <s>] [--description <d>] [--expires <ISO|+2h|never>] | auth totp enroll|disable|status <user> [--site <s>] [--provider ...] | auth biometric status|disable|enroll-url <user> [--site <s>] [--method face|voice] [--provider portal]
  authsetup [--admin-port <p>] [--auth-port <p>] [--base-path <p>] [--site <s>]
            [--listen <ip>] [--policy <p>] [--out <dir>] [--bin-dir <dir>]
            [--with-systemd] [--force]
  authonly start [--port <p>] [--base-path <p>] [--site <s>] [--listen <ip>] [--policy <p>]
           | stop | status [--site <s>]
  upgrade run --config <upgrade.json> [--yes] [--manager <id>] [--no-expose] [--expose <mode>] [--port <p>]
       [--max-runtime <t>] [--resume|--abort] [--cleanup-config]   # upgrade assistant (self-isolating; --yes is the production gate)
  upgrade status [--json]                       # live run / lock / last report
  service install|uninstall|start|stop|restart|status|logs|enable|disable --config <upgrade.json>
       [--manager <id>] [--tail <n>]            # service-form verbs via the manager plugin chain
  upgrade version                              # vendored assistant core version
  ui [--port <p>] [--no-browser]
  stop-all
  status [--json]
  config path | show
  config get <key> | set <key> <value>   # key: allow-tool-download | prefer-mirrors | allow-auth-none
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
  /** st upgrade run: temp upgrade.json (launch.json style). */
  upgradeConfig?: string;
  /** st upgrade run: production confirmation gate (hard requirement, plan §10.3). */
  yes?: boolean;
  manager?: string;
  noExpose?: boolean;
  exposeMode?: string;
  maxRuntime?: string;
  resumeFlag?: boolean;
  abortFlag?: boolean;
  cleanupConfig?: boolean;
  tail?: number;
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
  record?: string;
  zone?: string;
  accessKeyId?: string;
  zoneId?: string;
  profile?: string;
  ttl?: number;
  interval?: number;
  proxied?: boolean;
  loop?: boolean;
  providerProfile?: string;
  txtName?: string;
  kind?: string;
  followTunnel?: string;
  ip?: boolean;
  txt?: boolean;
  cname?: boolean;
  txtUrl?: boolean;
  /** ddns entry-add / expose ddns: register public IPv6 as AAAA. */
  aaaa?: boolean;
  ddnsProfile?: string;
  cmd?: string;
  /** --set key=value (tunnel params, validated against the type schema). */
  sets?: Record<string, string>;
  /** --tunnel-set key=value (expose tunnel params). */
  tunnelSets?: Record<string, string>;
  /** --provider-set key=value (expose auth-provider params). */
  providerSets?: Record<string, string>;
  /** --portmap-set key=value (expose mode=portmap params). */
  portmapSets?: Record<string, string>;
  /** expose --ipv6-address <addr>: mode ipv6 的显式入口地址。 */
  ipv6Address?: string;
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
  /** --description <d> (auth token create): token 用途说明。 */
  description?: string;
  /** --expires <ISO|+2h|never|epoch> (auth token create): 有效期。 */
  expires?: string;
  /** ssh key add --public-key / key remove --fingerprint. */
  publicKey?: string;
  fingerprint?: string;
  /** ssh key generate --bits / --count. */
  bits?: number;
  count?: number;
  /** ssh domain create --forward-port / key generate --comment. */
  forwardPort?: number;
  comment?: string;
  /** expose --ssh-gateway <domain>: tcp tunnel target = SSH gateway port. */
  sshGateway?: string;
  /** portmap probe --gateway <ip>: explicit router gateway for capability probe. */
  gateway?: string;
  /** ssh domain create --listen-addr: gateway bind IP (127.0.0.1 / 172.17.0.1 / 0.0.0.0). */
  listenAddr?: string;
  /** --policy <one_factor|two_factor|deny> (site add). */
  policy?: string;
  /** ui --ui-host <h>: additionally allowed Host for remote access (POST gate). */
  uiHost?: string;
  /** ui --daemonize: detached re-spawn (survives shell session). */
  daemonize?: boolean;
  /** --proxy-port <p>: proxy transport port (mode proxy/both). */
  proxyPort?: number;
  /** --base-domain <d>: user's wildcard-DNS domain for portless base URLs. */
  baseDomain?: string;
  /** --bypass-path /health --bypass-path /metrics：认证放行白名单（可重复）。 */
  bypassPaths?: string[];
  /** --inject-html <fragment>：静态响应注入（tunnel nginx 路径，主页面导航
   *  的 text/html；XHR/fetch/子资源不注入）。与 --inject-position 组合。 */
  injectHtml?: string;
  /** --inject-position head|prepend：注入模式（默认 head = </head> 前插入；
   *  prepend = 响应开头直接写，需 nginx addition 模块）。 */
  injectPosition?: string;
  /** --allow-tool-download <true|false>: per-expose tool-download override. */
  allowToolDownload?: boolean;
  /** --allow-auth-none <true|false>: per-expose auth-none ban override
   *  (false = this expose must use an auth provider; an operator ban via
   *  env/config can't be re-enabled here). */
  allowAuthNone?: boolean;
  /** authsetup: Web 管理界面端口（`st ui`）。 */
  adminPort?: number;
  /** authsetup: 仅认证服务端口。 */
  authPort?: number;
  /** authsetup/authonly: 认证服务监听地址（缺省 127.0.0.1）。 */
  listen?: string;
  /** authsetup: 非可执行产物目录（nginx/systemd；缺省 configDir/auth）。 */
  out?: string;
  /** authsetup: 可执行脚本目录（缺省 ~/.local/bin）。 */
  binDir?: string;
  /** authsetup: 同时生成 systemd unit。 */
  withSystemd?: boolean;
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
      case "--provider":
        args.provider = argv[++i];
        break;
      case "--record":
        args.record = argv[++i];
        break;
      case "--zone":
        args.zone = argv[++i];
        break;
      case "--secret":
        args.secret = argv[++i];
        break;
      case "--access-key-id":
        args.accessKeyId = argv[++i];
        break;
      case "--zone-id":
        args.zoneId = argv[++i];
        break;
      case "--profile":
        args.profile = argv[++i];
        break;
      case "--ttl":
        args.ttl = Number(argv[++i]!);
        break;
      case "--interval":
        args.interval = Number(argv[++i]!);
        break;
      case "--proxied":
        args.proxied = true;
        break;
      case "--loop":
        args.loop = true;
        break;
      case "--provider-profile":
        args.providerProfile = argv[++i];
        break;
      case "--txt-name":
        args.txtName = argv[++i];
        break;
      case "--kind":
        args.kind = argv[++i];
        break;
      case "--follow-tunnel":
        args.followTunnel = argv[++i];
        break;
      case "--ip":
        args.ip = true;
        break;
      case "--txt":
        args.txt = true;
        break;
      case "--cname":
        args.cname = true;
        break;
      case "--txt-url":
        args.txtUrl = true;
        break;
      case "--aaaa":
        args.aaaa = true;
        break;
      case "--ddns-profile":
        args.ddnsProfile = argv[++i];
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
      case "--portmap-set":
        addSet(args, "portmapSets", argv[++i]);
        break;
      case "--ipv6-address":
        args.ipv6Address = argv[++i];
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
      case "--description":
        args.description = argv[++i]!;
        break;
      case "--expires":
        args.expires = argv[++i]!;
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
      case "--inject-html":
        args.injectHtml = argv[++i]!;
        break;
      case "--inject-position":
        args.injectPosition = argv[++i]!;
        break;
      case "--admin-port":
        args.adminPort = Number(argv[++i]!);
        break;
      case "--auth-port":
        args.authPort = Number(argv[++i]!);
        break;
      case "--listen":
        args.listen = argv[++i]!;
        break;
      case "--out":
        args.out = argv[++i]!;
        break;
      case "--bin-dir":
        args.binDir = argv[++i]!;
        break;
      case "--with-systemd":
        args.withSystemd = true;
        break;
      case "--allow-tool-download": {
        const raw = (argv[++i] ?? "true").toLowerCase();
        args.allowToolDownload = !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
        break;
      }
      case "--allow-auth-none": {
        const raw = (argv[++i] ?? "true").toLowerCase();
        args.allowAuthNone = !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
        break;
      }
      case "--display-name":
        args.displayName = argv[++i]!;
        break;
      case "--public-key":
        args.publicKey = argv[++i]!;
        break;
      case "--fingerprint":
        args.fingerprint = argv[++i]!;
        break;
      case "--bits":
        args.bits = Number(argv[++i]!);
        break;
      case "--count":
        args.count = Number(argv[++i]!);
        break;
      case "--forward-port":
        args.forwardPort = Number(argv[++i]!);
        break;
      case "--ssh-gateway":
        args.sshGateway = argv[++i]!;
        break;
      case "--gateway":
        args.gateway = argv[++i]!;
        break;
      case "--listen-addr":
        args.listenAddr = argv[++i]!;
        break;
      case "--site":
        args.site = argv[++i]!;
        break;
      case "--comment":
        args.comment = argv[++i]!;
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
      case "--ui-host":
        args.uiHost = argv[++i];
        break;
      case "--daemonize":
        args.daemonize = true;
        break;
      case "--lang":
        args.lang = argv[++i];
        break;
      case "--config":
        args.upgradeConfig = argv[++i]!;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--manager":
        args.manager = argv[++i]!;
        break;
      case "--no-expose":
        args.noExpose = true;
        break;
      case "--expose":
        args.exposeMode = argv[++i]!;
        break;
      case "--max-runtime":
        args.maxRuntime = argv[++i]!;
        break;
      case "--resume":
        args.resumeFlag = true;
        break;
      case "--abort":
        args.abortFlag = true;
        break;
      case "--cleanup-config":
        args.cleanupConfig = true;
        break;
      case "--tail":
        args.tail = Number(argv[++i]!);
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
function addSet(args: CliArgs, key: "sets" | "tunnelSets" | "providerSets" | "portmapSets", raw: string | undefined): void {
  if (!raw) return;
  const eq = raw.indexOf("=");
  if (eq < 0) {
    console.error(`--${key === "sets" ? "set" : key === "tunnelSets" ? "tunnel-set" : key === "providerSets" ? "provider-set" : "portmap-set"} expects key=value, got "${raw}"`);
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
  "allow-auth-none": "allowAuthNone",
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
    case "allowAuthNone":
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
        case "upgrade": {
      const op = cmd[1] ?? "run";
      if (op === "version") {
        jsonOut({ version: upgradeVersion() });
        return;
      }
      if (op === "run") {
        if (!args.upgradeConfig) {
          console.error("upgrade run --config <upgrade.json> [--yes] [--manager <id>] [--no-expose] [--port <p>] [--max-runtime <t>] [--resume|--abort] [--cleanup-config]");
          process.exit(2);
        }
        // Production gate (plan §10.3): an upgrade touches services and the target
        // tree - the explicit --yes is the hard requirement (batch F lesson).
        if (!args.yes) {
          console.error("upgrade run touches services and the target tree - confirm with --yes");
          process.exit(2);
        }
        const argv = ["--config", args.upgradeConfig];
        if (args.manager) argv.push("--manager", args.manager);
        if (args.noExpose) argv.push("--no-expose");
        if (args.exposeMode) argv.push("--expose-mode", args.exposeMode);
        if (args.maxRuntime) argv.push("--max-runtime", args.maxRuntime);
        if (args.port) argv.push("--port", String(args.port));
        if (args.resumeFlag) argv.push("--resume");
        if (args.abortFlag) argv.push("--abort");
        if (args.cleanupConfig) argv.push("--cleanup-config");
        // M3: hand the boot process's own CLI entry to the child so its expose step
        // self-calls st (daemon-mediated) instead of guessing from PATH.
        const stEntry = process.argv[1] && basename(process.argv[1]) === "cli.js" ? process.argv[1] : undefined;
        await upgradeRun(argv, { stEntry });
        // the boot process handed off to the isolated copy: it runs detached and
        // reports via its status page / `st upgrade status` / history reports
        return;
      }
      if (op === "status") {
        jsonOut(await upgradeStatus());
        return;
      }
      console.error(`upgrade ${op} not supported (run|status)`);
      process.exit(2);
    }

    case "service": {
      const op = cmd[1] ?? "";
      const verbs = ["install", "uninstall", "start", "stop", "restart", "status", "logs", "enable", "disable"];
      if (!verbs.includes(op)) {
        console.error(`service install|uninstall|start|stop|restart|status|logs|enable|disable --config <upgrade.json> [--manager <id>] [--tail <n>]`);
        process.exit(2);
      }
      if (!args.upgradeConfig) {
        console.error(`service ${op} --config <upgrade.json> (the config's "service" block selects the manager)`);
        process.exit(2);
      }
      const r = await serviceAction(op, args.upgradeConfig, {
        manager: args.manager,
        tail: args.tail,
        onLine: (s) => process.stdout.write(`${s}\n`),
      });
      jsonOut(r);
      return;
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

    case "portmap": {
      // st portmap probe [--gateway <ip>] | list | stop <key>
      const op = cmd[1] ?? "probe";
      if (op === "probe") {
        try {
          const report = await st.portmap.probe({ gateway: args.gateway as string | undefined });
          jsonOut(report);
        } catch (e) {
          console.error(String(e instanceof Error ? e.message : e));
          process.exit(1);
        }
      } else if (op === "list") {
        jsonOut(st.portmap.list());
      } else if (op === "stop") {
        const key = cmd[2];
        if (!key) {
          console.error("portmap stop <key>");
          process.exit(2);
        }
        jsonOut({ stopped: await st.portmap.stop(key) });
      } else {
        usage(lang);
        process.exit(2);
      }
      break;
    }
    case "ipv6": {
      // st ipv6 [diagnose] | list | stop <key>
      const op = cmd[1] ?? "diagnose";
      if (op === "diagnose" || op === "status" || op === "") {
        jsonOut(st.ipv6.diagnose());
      } else if (op === "list") {
        jsonOut(st.ipv6.list());
      } else if (op === "stop") {
        const key = cmd[2];
        if (!key) {
          console.error("ipv6 stop <key>");
          process.exit(2);
        }
        jsonOut({ stopped: await st.ipv6.stop(key) });
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
      let portmapParams: Record<string, unknown> | undefined;
      try {
        tunnelParams = await applyExposeSets(st, "tunnel", args.tunnel ?? "ngrok", args.tunnelSets ?? {});
        providerParams = await applyExposeSets(st, "provider", typeof args.auth === "string" ? args.auth : "", args.providerSets ?? {});
        // portmap-set: 数字字段数字化；点号键嵌套（sshRouter.host → {sshRouter:{host}}）
        const pm = args.portmapSets ?? {};
        if (Object.keys(pm).length) {
          portmapParams = {};
          for (const [k, v] of Object.entries(pm)) {
            const val = /^(externalPort|leaseSeconds|port|ssdpTimeoutMs)$/.test(k) ? Number(v) : v;
            if (k.includes(".")) {
              // sshRouter.host → { sshRouter: { host } }（合并多层）
              const parts = k.split(".");
              let cur = portmapParams;
              for (let i = 0; i < parts.length - 1; i++) {
                const seg = parts[i]!;
                if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
                cur = cur[seg] as Record<string, unknown>;
              }
              cur[parts[parts.length - 1]!] = val;
            } else {
              portmapParams[k] = val;
            }
          }
        }
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(2);
      }
      const res = await st.daemon.request("expose", {
        port,
        // "auto" → expose 内部解析默认 provider（portal，全平台）
        // "none" → 显式无认证（纯透传隧道，走 none 网关路径）
        auth: args.auth === "auto" || args.auth === true
          ? "auto"
          : args.auth === "none" ? false : Boolean(args.auth),
        provider: typeof args.auth === "string" && args.auth !== "auto" ? args.auth : undefined,
        mode: args.mode as "tunnel" | "proxy" | "both" | "portmap" | "ipv6" | undefined,
        site: args.site,
        proxyPort: args.proxyPort != null ? Number(args.proxyPort) : undefined,
        baseDomain: args.baseDomain,
        bypassPaths: args.bypassPaths,
        ...(args.ipv6Address ? { ipv6: { address: args.ipv6Address } } : {}),
        ...(args.injectHtml
          ? { inject: { html: args.injectHtml, position: args.injectPosition === "prepend" ? "prepend" as const : "head" as const } }
          : {}),
        tunnelType: args.tunnel,
        tunnelName: args.name,
        protocol: args.sshGateway ? "tcp" as const : undefined,
        // `--tunnel command` runs a raw shell command — this CLI invocation is
        // the explicit opt-in (same gate as tunnel add).
        dangerous: args.tunnel === "command",
        nginxPort: args.nginxPort ? Number(args.nginxPort) : undefined,
        basePath: args.basePath,
        tunnelParams,
        providerParams,
        ...(portmapParams ? { portmap: portmapParams } : {}),
        ...(args.ddnsProfile || args.ip || args.txt || args.cname || args.txtUrl || args.aaaa
          ? { ddns: { profile: args.ddnsProfile, ip: args.ip, txt: args.txt, cname: args.cname, txtUrl: args.txtUrl, aaaa: args.aaaa } }
          : {}),
        sshGateway: args.sshGateway,
        force: args.force,
        allowToolDownload: args.allowToolDownload,
        allowAuthNone: args.allowAuthNone,
      }, 90_000);
      if (res === null) {
        // daemon threw at its boundary — 展示 daemon 日志尾部（防火墙失败/认证禁用/
        // 参数非法等具体原因都在那里；此前 stderr 全丢，用户只能看到笼统提示）。
        console.error("expose rejected by daemon — 具体原因见 daemon 日志尾部：");
        const { stateFile } = cachePaths(st.dirs.cacheDir);
        try {
          const lines = readFileSync(`${stateFile}.daemon.log`, "utf8").trim().split("\n");
          // 优先展示错误消息行（[daemon] xxx failed: Error: ...），栈行省略
          const errLines = lines.filter((l) => /\[daemon\].*(failed|error)|Error:/i.test(l));
          const shown = (errLines.length ? errLines : lines).slice(-4).join("\n");
          console.error(shown || "(daemon 日志为空)");
        } catch {
          console.error("(无法读取 daemon 日志)");
        }
        process.exit(1);
      }
      jsonOut(res);
      break;
    }

    case "ssh": {
      const op = cmd[1] ?? "domain";
      const d = st.daemon;
      const requireDomain = () => {
        const domain = args.domain ?? cmd[3] ?? "";
        if (!domain) {
          console.error("ssh: --domain <name> required");
          process.exit(2);
        }
        return domain;
      };
      if (op === "domain" && cmd[2] === "list") {
        jsonOut(await d.request("ssh.domain.list"));
      } else if (op === "domain" && cmd[2] === "create") {
        const domain = requireDomain();
        const res = await d.request("ssh.domain.create", {
          domain,
          site: args.site,
          sshPort: args.port === undefined ? undefined : Number(args.port),
          forwardPort: Number(args.forwardPort ?? args.target),
          reversePort: args.remotePort === undefined ? undefined : Number(args.remotePort),
          forwardHost: args.host,
          listenAddr: args.listenAddr,
        });
        jsonOut(res);
      } else if (op === "domain" && cmd[2] === "remove") {
        jsonOut(await d.request("ssh.domain.remove", { domain: requireDomain() }));
      } else if (op === "key" && cmd[2] === "list") {
        jsonOut(await d.request("ssh.key.list", { domain: requireDomain() }));
      } else if (op === "key" && cmd[2] === "add") {
        const domain = requireDomain();
        const publicKey = args.publicKey ?? cmd[4] ?? "";
        if (!publicKey) {
          console.error("ssh key add <domain> '<ssh-ed25519 AAAA...>'  (or --public-key)");
          process.exit(2);
        }
        jsonOut(await d.request("ssh.key.add", { domain, publicKey }));
      } else if (op === "key" && cmd[2] === "generate") {
        const domain = requireDomain();
        const res = await d.request("ssh.key.generate", {
          domain,
          type: args.type ?? "ed25519",
          bits: args.bits === undefined ? undefined : Number(args.bits),
          comment: args.comment,
          count: args.count === undefined ? undefined : Number(args.count),
        });
        jsonOut(res);
      } else if (op === "key" && cmd[2] === "remove") {
        const domain = requireDomain();
        const fingerprint = args.fingerprint ?? cmd[4] ?? "";
        if (!fingerprint) {
          console.error("ssh key remove <domain> <fingerprint>  (or --fingerprint)");
          process.exit(2);
        }
        jsonOut(await d.request("ssh.key.remove", { domain, fingerprint }));
      } else if (op === "host" && cmd[2] === "fingerprints") {
        jsonOut(await d.request("ssh.host.fingerprints", { domain: requireDomain() }));
      } else {
        console.error("ssh domain list|create|remove | ssh key list|add|generate|remove | ssh host fingerprints --domain <d>");
        process.exit(2);
      }
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
          console.error("auth totp enroll <name> [--provider portal] [--site <s>] [--label <标识>]");
          process.exit(2);
        }
        const label = (args.label as string | undefined) ?? undefined;
        jsonOut({ site, ...(await st.auth.totpEnroll(name, args.provider, site, label)) });
      } else if (op === "totp" && cmd[2] === "default-label") {
        const name = cmd[3];
        if (!name) {
          console.error("auth totp default-label <name> [--provider portal] [--site <s>]");
          process.exit(2);
        }
        jsonOut({ site, ...(await st.auth.totpDefaultLabel(name, args.provider, site)) });
      } else if (op === "totp" && cmd[2] === "disable") {
        await st.auth.totpDisable(cmd[3] ?? "", args.provider, site);
        jsonOut({ disabled: cmd[3], site });
      } else if (op === "totp" && cmd[2] === "status") {
        jsonOut({ site, ...(await st.auth.totpStatus(cmd[3] ?? "", args.provider, site)) });
      } else if (op === "biometric" && cmd[2] === "status") {
        jsonOut({ site, ...(await st.auth.biometricStatus(cmd[3] ?? "", args.provider, site)) });
      } else if (op === "biometric" && cmd[2] === "disable") {
        await st.auth.biometricDisable(cmd[3] ?? "", (args.method as "face" | "voice" | undefined) ?? "face", args.provider, site);
        jsonOut({ disabled: cmd[3], method: args.method ?? "face", site });
      } else if (op === "biometric" && cmd[2] === "enroll-url") {
        // 预设置：签票 + 打印本地采集页 URL（浏览器打开即可采集；
        // enroll 本身需要摄像头/麦克风，CLI 只给入口）
        const name = cmd[3];
        const method = (args.method as "face" | "voice" | undefined) ?? "face";
        if (!name) {
          console.error("auth biometric enroll-url <name> [--method face|voice] [--provider portal] [--site <s>]");
          process.exit(2);
        }
        jsonOut({ site, ...(await st.auth.biometricEnrollUrl(name, method, args.provider, site)) });
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
      } else if (op === "token" && cmd[2] === "list") {
        jsonOut(await st.auth.tokens(args.provider, site));
      } else if (op === "token" && cmd[2] === "create") {
        const { parseTokenExpiry } = await import("./providers/token.ts");
        const expiresAt = parseTokenExpiry(args.expires as string | undefined);
        const out = await st.auth.createToken({
          description: args.description as string | undefined,
          expiresAt,
          provider: args.provider,
          site,
        });
        jsonOut({ site, tokens: out });
      } else if (op === "token" && cmd[2] === "revoke") {
        const id = cmd[3] ?? "";
        if (!id) {
          console.error("auth token revoke <id> [--provider token] [--site <s>]");
          process.exit(2);
        }
        const providers = await st.auth.revokeToken(id, args.provider, site);
        jsonOut({ revoked: id, site, providers });
      } else {
        console.error("auth providers list | auth user list|add|set-password|remove | auth token list|create|revoke | auth totp enroll|disable|status|code [--site <s>] [--provider ...] [--secret <b32>]");
        process.exit(2);
      }
      break;
    }

    case "authsetup": {
      // 仅认证模式：一次性设置 admin 端口 / auth 端口 / basePath / site（存储），
      // 生成管理脚本（~/.local/bin/auth-admin-<base>.*）+ 认证服务脚本
      // （~/.local/bin/auth-server-<base>.*）+ nginx 接入碎片 +（可选）systemd unit。
      const {
        randomBasePath, randomSite, pickFreePort, readAuthConfig, writeAuthConfig,
        defaultBinDir, defaultOutDir, resolveCliInvocation,
        renderAdminBash, renderServerBash, renderAdminBat, renderServerBat,
        renderNginxFragment, renderSystemdUnit, renderWindowsServiceInstall,
        renderWindowsServiceUninstall, renderFail2banFilter, renderFail2banJail,
      } = await import("./auth-setup.ts");
      const { validateSiteName } = await import("./sites.ts");
      // basePath：显式 > 随机（/xxx 小写字母）
      let basePath = (args.basePath ?? "").trim();
      if (basePath && !/^\/[a-z0-9][a-z0-9-]*$/.test(basePath)) {
        console.error(`authsetup: invalid --base-path "${basePath}" (expected /[a-z0-9-]+)`);
        process.exit(2);
      }
      basePath = basePath || randomBasePath();
      const base = basePath.replace(/^\//, "").toLowerCase();
      // site（存储位置）：显式 > 随机；default 保留（默认站点存储，与现有
      // 隧道/暴露共享用户库）
      const site = (args.site ?? "").trim() || randomSite();
      if (site !== "default") {
        try {
          validateSiteName(site);
        } catch (err) {
          console.error(`authsetup: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(2);
        }
      }
      // 端口：显式 > 空闲探测
      const tcpFree = async (p: number): Promise<boolean> => {
        const { createServer } = await import("net");
        return new Promise((resolve) => {
          const s = createServer();
          s.once("error", () => resolve(false));
          s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
        });
      };
      let adminPort = args.adminPort ? Number(args.adminPort) : 4181;
      if (!args.adminPort && !(await tcpFree(adminPort))) adminPort = await pickFreePort();
      if (args.adminPort && !(await tcpFree(adminPort))) {
        console.error(`authsetup: admin port ${adminPort} is in use`);
        process.exit(2);
      }
      const authPort = args.authPort ? Number(args.authPort) : await pickFreePort();
      if (args.authPort && !(await tcpFree(authPort))) {
        console.error(`authsetup: auth port ${authPort} is in use`);
        process.exit(2);
      }
      const listen = (args.listen ?? "127.0.0.1").trim() || "127.0.0.1";
      const policy = (args.policy as "one_factor" | "two_factor" | "deny") ?? "one_factor";
      // 已存在同 base 配置：--force 才覆盖
      const existing = readAuthConfig(st.dirs.configDir, base);
      if (existing && !args.force) {
        console.error(`authsetup: base "${base}" already configured (${existing.basePath}, site ${existing.site}, auth :${existing.authPort}). Pass --force to regenerate.`);
        process.exit(2);
      }
      const cfg = {
        base, basePath, site, adminPort, authPort, listen, policy,
        configDir: st.dirs.configDir, cacheDir: st.dirs.cacheDir,
      };
      writeAuthConfig(st.dirs.configDir, cfg);
      // 注册 site（管理界面列出该 realm）；default 跳过（隐式站点）
      if (site !== "default") {
        try {
          st.sites.add(site, { provider: "portal", basePath, policy });
        } catch (err) {
          console.error(`authsetup: site register warning: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 生成脚本 / 产物
      const { mkdirSync, writeFileSync, chmodSync } = await import("fs");
      const cli = resolveCliInvocation();
      const binDir = (args.binDir ?? "").trim() || defaultBinDir();
      const outDir = (args.out ?? "").trim() || defaultOutDir(st.dirs.configDir);
      mkdirSync(binDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      const files: string[] = [];
      const write = (path: string, content: string, mode?: number) => {
        writeFileSync(path, content, "utf8");
        if (mode) {
          try {
            chmodSync(path, mode);
          } catch { /* best-effort */ }
        }
        files.push(path);
      };
      write(join(binDir, `auth-admin-${base}.sh`), renderAdminBash(cfg, cli), 0o755);
      write(join(binDir, `auth-server-${base}.sh`), renderServerBash(cfg, cli), 0o755);
      write(join(binDir, `auth-admin-${base}.bat`), renderAdminBat(cfg, cli));
      write(join(binDir, `auth-server-${base}.bat`), renderServerBat(cfg, cli));
      write(join(outDir, `nginx-auth-${base}.conf`), renderNginxFragment(cfg));
      // systemd unit（默认生成；linux 上即可用）
      {
        const scriptPath = join(binDir, `auth-server-${base}.sh`);
        write(join(outDir, `auth-server-${base}.service`), renderSystemdUnit(cfg, scriptPath));
      }
      // Windows 服务安装/卸载脚本（默认生成；win 上管理员运行）
      {
        const cliJs = process.argv[1] ?? "";
        write(join(binDir, `install-service-${base}.bat`), renderWindowsServiceInstall(cfg, cliJs));
        write(join(binDir, `uninstall-service-${base}.bat`), renderWindowsServiceUninstall(cfg));
      }
      // fail2ban filter + jail（默认生成；linux + system nginx 场景，真实 IP 在
      // nginx 层可见——与 portal 自带 per-IP 封禁互补，更早拦截）
      write(join(outDir, `fail2ban-auth-${base}.conf`), renderFail2banFilter(cfg));
      write(join(outDir, `fail2ban-jail-${base}.conf`), renderFail2banJail(cfg));
      jsonOut({
        base, basePath, site, adminPort, authPort, listen, policy,
        configFile: join(defaultOutDir(st.dirs.configDir), `${base}.json`),
        adminScript: join(binDir, `auth-admin-${base}.sh`),
        serverScript: join(binDir, `auth-server-${base}.sh`),
        nginxFragment: join(outDir, `nginx-auth-${base}.conf`),
        generated: files,
        // 工作流提示
        next: [
          `启动管理界面调整用户: ${join(binDir, `auth-admin-${base}.sh`)}`,
          `启动仅认证服务: ${join(binDir, `auth-server-${base}.sh`)}`,
          `nginx 接入: 把 ${join(outDir, `nginx-auth-${base}.conf`)} 的 location 放入受保护应用 server{}`,
        ],
      });
      break;
    }

    case "authonly": {
      // 仅认证服务（生产进程）：外部系统 nginx auth_request 接入。
      // start = 前台常驻（systemd Type=simple 直接 ExecStart）；无管理界面。
      const op = cmd[1] ?? "start";
      const site = (args.site ?? "").trim() || "default";
      const { readAuthConfig, listAuthConfigs, authDir } = await import("./auth-setup.ts");
      if (op === "start") {
        // 解析 basePath：显式 > 该 site 已有配置 > 报错
        let basePath = (args.basePath ?? "").trim();
        if (!basePath) {
          const cfg = listAuthConfigs(st.dirs.configDir).find((c) => c.site === site);
          basePath = cfg?.basePath ?? "";
        }
        if (!basePath) {
          console.error(`authonly start: need --base-path (or run authsetup first)`);
          process.exit(2);
        }
        const port = args.port ? Number(args.port) : 0;
        const listen = (args.listen ?? "").trim() || "127.0.0.1";
        const policy = (args.policy as "one_factor" | "two_factor" | "deny") ?? undefined;
        const res = await st.auth.server.start({ site, port, basePath, policy, host: listen, trustProxy: true });
        // pid 文件（stop/status 用；避免与管理界面/隧道共享存储冲突）
        const pidFile = join(st.dirs.cacheDir, "tmp", `authonly-${site}.pid`);
        try {
          const { mkdirSync, writeFileSync } = await import("fs");
          mkdirSync(join(st.dirs.cacheDir, "tmp"), { recursive: true });
          writeFileSync(pidFile, `${process.pid}\n`, "utf8");
        } catch { /* best-effort */ }
        // 信号清理：SIGTERM（systemd stop）/ SIGINT → 停 provider + 删 pid
        const shutdown = async () => {
          try { await st.auth.server.stop(site); } catch { /* best-effort */ }
          try { const { rmSync } = await import("fs"); rmSync(pidFile, { force: true }); } catch { /* best-effort */ }
          process.exit(0);
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
        // 注册 guardian：父进程崩溃/被 SIGKILL 时收割 portal 子进程
        const { spawnGuardian } = await import("./guardian-spawn.ts");
        const { registrationFilePath } = await import("./pid-registry.ts");
        spawnGuardian(process.pid, {
          registrationFile: registrationFilePath(st.dirs.cacheDir, process.pid),
          cacheDir: st.dirs.cacheDir,
          nodePath: undefined,
        });
        jsonOut({ ...res, pid: process.pid, pidFile });
        console.error(`[authonly] auth 服务已启动: basePath=${res.basePath} port=${res.port} site=${site}（nginx auth_request 接入见 authsetup 生成的 nginx-auth-${res.basePath.replace(/^\//, "")}.conf）`);
        await new Promise(() => {}); // 前台常驻
        break;
      }
      const pidFile = join(st.dirs.cacheDir, "tmp", `authonly-${site}.pid`);
      const { readFileSync, existsSync, rmSync } = await import("fs");
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      if (op === "stop") {
        let pid: number | null = null;
        if (existsSync(pidFile)) {
          try { pid = Number((readFileSync(pidFile, "utf8").trim() || "0")); } catch { pid = null; }
        }
        if (!pid || !alive(pid)) {
          rmSync(pidFile, { force: true });
          jsonOut({ stopped: false, reason: "not running" });
          break;
        }
        try {
          process.kill(pid, "SIGTERM");
        } catch { /* already gone */ }
        // 等待进程退出（信号处理器会清 provider + pid）
        const dl = Date.now() + 5_000;
        while (Date.now() < dl && alive(pid)) await new Promise((r) => setTimeout(r, 100));
        rmSync(pidFile, { force: true });
        jsonOut({ stopped: true, pid });
        break;
      }
      if (op === "status") {
        let pid: number | null = null;
        if (existsSync(pidFile)) {
          try { pid = Number((readFileSync(pidFile, "utf8").trim() || "0")); } catch { pid = null; }
        }
        // 跨进程：注册表在本进程内是空的，实际运行态只能靠端口探针判定。
        // 未认证探针返回 401 = 服务在跑（若绑定错误/进程死则连接失败）。
        const cfg = listAuthConfigs(st.dirs.configDir).find((c) => c.site === site) ?? null;
        const port = cfg?.authPort ?? null;
        let running = !!pid && alive(pid);
        if (running && port) {
          try {
            const { get } = await import("http");
            const probeOk = await new Promise<boolean>((resolve) => {
              const req = get({ host: "127.0.0.1", port, path: `${cfg?.basePath ?? "/"}/api/authz/auth-request`, method: "GET", timeout: 1500 }, (res) => {
                res.resume();
                resolve(res.statusCode !== undefined);
              });
              req.on("error", () => resolve(false));
              req.on("timeout", () => { req.destroy(); resolve(false); });
            });
            running = probeOk;
          } catch {
            running = false;
          }
        }
        jsonOut({ running, pid: running ? pid : null, port: running ? port : null, site });
        break;
      }
      console.error("authonly start | stop | status [--site <s>] [--port <p>] [--base-path <p>]");
      process.exit(2);
      break;
    }

    case "ddns": {
      const { readDdnsConfigs, writeDdnsConfigs, runDdnsOnce, resolvePublicIp, startDdnsLoop, DDNS_PROVIDERS } = await import("./ddns.ts");
      const op = cmd[1] ?? "list";
      const name = cmd[2];
      if (op === "list") {
        jsonOut({ configPath: join(st.dirs.configDir, "ddns.json"), records: readDdnsConfigs(st.dirs.configDir).map((r) => ({ ...r, token: r.token ? "***" : undefined, secret: r.secret ? "***" : undefined })) });
      } else if (op === "add") {
        if (!name || !args.record) {
          console.error("ddns add <name> --provider <cloudflare|dnspod|aliyun|duckdns> --record <fqdn> --zone <z> [--token <t>] [--secret <s>] [--access-key-id <k>] [--ttl <n>] [--interval <sec>] [--proxied]");
          process.exit(2);
        }
        const provider = args.provider as typeof DDNS_PROVIDERS[number];
        if (!DDNS_PROVIDERS.includes(provider)) {
          console.error(`unknown provider: ${args.provider} (known: ${DDNS_PROVIDERS.join(", ")})`);
          process.exit(2);
        }
        if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(args.record)) {
          console.error(`invalid record fqdn: ${args.record}`);
          process.exit(2);
        }
        const cfgs = readDdnsConfigs(st.dirs.configDir);
        const rec = {
          name,
          provider,
          record: args.record.toLowerCase(),
          zone: args.zone?.toLowerCase(),
          token: args.token,
          secret: args.secret,
          accessKeyId: args.accessKeyId,
          ttl: args.ttl,
          intervalSec: args.interval,
          proxied: args.proxied,
        };
        // duckdns uses bare labels; the others need a root zone
        if (provider !== "duckdns" && !rec.zone) {
          console.error(`ddns add ${name}: provider '${provider}' requires --zone <root domain>`);
          process.exit(2);
        }
        writeDdnsConfigs(st.dirs.configDir, [...cfgs.filter((c) => c.name !== name), rec]);
        jsonOut({ added: name, provider, record: rec.record, zone: rec.zone ?? null });
      } else if (op === "remove") {
        if (!name) {
          console.error("ddns remove <name>");
          process.exit(2);
        }
        const cfgs = readDdnsConfigs(st.dirs.configDir);
        if (!cfgs.some((c) => c.name === name)) {
          console.error(`ddns record not found: ${name}`);
          process.exit(2);
        }
        writeDdnsConfigs(st.dirs.configDir, cfgs.filter((c) => c.name !== name));
        jsonOut({ removed: name });
      } else if (op === "ip") {
        // 除外部探测（resolvePublicIp 4/6）外，附加本机 global IPv6 诊断（直连暴露可用）。
        jsonOut({
          ipv4: await resolvePublicIp(4),
          ipv6: await resolvePublicIp(6),
          localIpv6: st.ipv6.diagnose().global,
        });
      } else if (op === "update") {
        let cfgs = readDdnsConfigs(st.dirs.configDir).filter((c) => c.enabled !== false);
        if (name) cfgs = cfgs.filter((c) => c.name === name);
        if (name && !cfgs.length) {
          console.error(`ddns record not found: ${name}`);
          process.exit(2);
        }
        if (!cfgs.length) {
          console.error("no ddns records configured — use 'st ddns add' first");
          process.exit(2);
        }
        if (args.loop === true) {
          const handle = startDdnsLoop(cfgs, { log: (l) => process.stdout.write(l + "\n") });
          const stop = () => { handle.stop(); process.exit(0); };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          await new Promise(() => {}); // loop keeps running; interval is unref'd so keep alive here
        }
        const results = await runDdnsOnce(cfgs);
        jsonOut(args.json ? results : results.map(({ name: n, record, type, ip, changed, skipped, error }) => ({ name: n, record, type, ip, changed, skipped, error })));
      } else if (op === "provider-profile-add") {
        // st ddns provider-profile-add <name> --provider <p> [--token t] [--secret s] [--access-key-id k] [--zone-id zid]
        const { readRegistryConfig, writeRegistryConfig } = await import("./ddns-registry.ts");
        if (!name || !args.provider) {
          console.error("ddns provider-profile-add <name> --provider <cloudflare|...> [--token <t>] [--secret <s>] [--access-key-id <k>] [--zone-id <zid>]");
          process.exit(2);
        }
        const cfg = readRegistryConfig(st.dirs.configDir);
        cfg.providerProfiles ??= {};
        cfg.providerProfiles[name] = {
          provider: args.provider as string,
          token: args.token,
          secret: args.secret,
          accessKeyId: args.accessKeyId,
          zoneId: args.zoneId,
        };
        writeRegistryConfig(st.dirs.configDir, cfg);
        jsonOut({ added: name, provider: args.provider });
      } else if (op === "profile-add") {
        // st ddns profile-add <name> --provider-profile <pp> --zone <z> [--record <r>] [--txt-name <tn>]
        const { readRegistryConfig, writeRegistryConfig } = await import("./ddns-registry.ts");
        if (!name || !args.providerProfile || !args.zone) {
          console.error("ddns profile-add <name> --provider-profile <pp> --zone <z> [--record <r>] [--txt-name <tn>]");
          process.exit(2);
        }
        const cfg = readRegistryConfig(st.dirs.configDir);
        cfg.profiles ??= {};
        cfg.profiles[name] = {
          providerProfile: args.providerProfile,
          zone: args.zone,
          record: args.record,
          txtName: args.txtName,
        };
        writeRegistryConfig(st.dirs.configDir, cfg);
        jsonOut({ added: name, zone: args.zone, record: args.record ?? null });
      } else if (op === "entry-add") {
        // st ddns entry-add <name> --profile <p> --kind portmap|tunnel [--follow-tunnel <t>] [--ip] [--txt] [--cname] [--txt-url] [--record <r>] [--txt-name <tn>] [--zone <z>]
        const { readRegistryConfig, writeRegistryConfig } = await import("./ddns-registry.ts");
        if (!name || !args.kind || (!args.profile && !args.zone)) {
          console.error("ddns entry-add <name> --profile <p>|(--provider-profile <pp> --zone <z>) --kind portmap|tunnel [--follow-tunnel <t>] [--ip] [--txt] [--cname] [--txt-url] [--aaaa]");
          process.exit(2);
        }
        const cfg = readRegistryConfig(st.dirs.configDir);
        cfg.entries ??= [];
        cfg.entries.push({
          name,
          profile: args.profile,
          providerProfile: args.providerProfile,
          provider: args.provider as string | undefined,
          token: args.token,
          secret: args.secret,
          zone: args.zone,
          record: args.record,
          txtName: args.txtName,
          kind: args.kind as "portmap" | "tunnel" | "ipv6",
          followTunnel: args.followTunnel,
          ip: args.ip === true,
          txt: args.txt === true,
          cname: args.cname === true,
          txtUrl: args.txtUrl === true,
          aaaa: args.aaaa === true,
        });
        writeRegistryConfig(st.dirs.configDir, cfg);
        jsonOut({ added: name, kind: args.kind, profile: args.profile ?? null });
      } else if (op === "registry-list") {
        const { readRegistryConfig } = await import("./ddns-registry.ts");
        jsonOut(readRegistryConfig(st.dirs.configDir));
      } else {
        usage(lang);
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
      if (args.daemonize) {
        // Detached re-spawn: survives the shell session (like `daemon start`).
        const { spawn } = await import("child_process");
        const passThrough: string[] = [];
        if (args.cacheDir) passThrough.push("--cache-dir", args.cacheDir);
        if (args.configDir) passThrough.push("--config-dir", args.configDir);
        if (args.port) passThrough.push("--port", String(args.port));
        if (args.uiHost) passThrough.push("--ui-host", args.uiHost);
        const child: import("child_process").ChildProcess = spawn(
          process.execPath,
          [process.argv[1]!, "ui", "--no-browser", ...passThrough],
          { detached: true, stdio: "ignore" },
        );
        child.unref();
        console.log(JSON.stringify({ ui: "daemonized", pid: child.pid ?? null }));
        break;
      }
      const { startUi } = await import("./ui.ts");
      const ui = startUi(st, {
        port: args.port ? Number(args.port) : undefined,
        openBrowser: !args.noBrowser,
        allowedHosts: args.uiHost ? [args.uiHost] : undefined,
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

    case "upgrade": {
      const op = cmd[1] ?? "run";
      if (op === "version") {
        jsonOut({ version: upgradeVersion() });
        return;
      }
      if (op === "run") {
        if (!args.upgradeConfig) {
          console.error("upgrade run --config <upgrade.json> [--yes] [--manager <id>] [--no-expose] [--port <p>] [--max-runtime <t>] [--resume|--abort] [--cleanup-config]");
          process.exit(2);
        }
        // Production gate (plan §10.3): an upgrade touches services and the target
        // tree - the explicit --yes is the hard requirement (batch F lesson).
        if (!args.yes) {
          console.error("upgrade run touches services and the target tree - confirm with --yes");
          process.exit(2);
        }
        const argv = ["--config", args.upgradeConfig];
        if (args.manager) argv.push("--manager", args.manager);
        if (args.noExpose) argv.push("--no-expose");
        if (args.exposeMode) argv.push("--expose-mode", args.exposeMode);
        if (args.maxRuntime) argv.push("--max-runtime", args.maxRuntime);
        if (args.port) argv.push("--port", String(args.port));
        if (args.resumeFlag) argv.push("--resume");
        if (args.abortFlag) argv.push("--abort");
        if (args.cleanupConfig) argv.push("--cleanup-config");
        // M3: hand the boot process's own CLI entry to the child so its expose step
        // self-calls st (daemon-mediated) instead of guessing from PATH.
        const stEntry = process.argv[1] && basename(process.argv[1]) === "cli.js" ? process.argv[1] : undefined;
        await upgradeRun(argv, { stEntry });
        // the boot process handed off to the isolated copy: it runs detached and
        // reports via its status page / `st upgrade status` / history reports
        return;
      }
      if (op === "status") {
        jsonOut(await upgradeStatus());
        return;
      }
      console.error(`upgrade ${op} not supported (run|status)`);
      process.exit(2);
    }

    case "service": {
      const op = cmd[1] ?? "";
      const verbs = ["install", "uninstall", "start", "stop", "restart", "status", "logs", "enable", "disable"];
      if (!verbs.includes(op)) {
        console.error(`service install|uninstall|start|stop|restart|status|logs|enable|disable --config <upgrade.json> [--manager <id>] [--tail <n>]`);
        process.exit(2);
      }
      if (!args.upgradeConfig) {
        console.error(`service ${op} --config <upgrade.json> (the config's "service" block selects the manager)`);
        process.exit(2);
      }
      const r = await serviceAction(op, args.upgradeConfig, {
        manager: args.manager,
        tail: args.tail,
        onLine: (s) => process.stdout.write(`${s}\n`),
      });
      jsonOut(r);
      return;
    }

    case "status": {
      const d = st.daemon.status();
      jsonOut({
        daemon: d,
        internal: st.state().internal,
        tunnels: st.state().tunnels,
        ipv6: st.ipv6.diagnose(),
      });
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
