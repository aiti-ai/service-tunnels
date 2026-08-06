import { spawn, type ChildProcess } from "child_process";
import { promises as dns } from "node:dns";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { roleEnv } from "./marker.ts";
import { withSchemaI18nKeys } from "./i18n.ts";
import { validateTunnelConfig } from "./validation.ts";
import {
  customTunnelTemplates,
  customTunnelParamSchemas,
  customTunnelParamSchema,
  isCustomTunnelType,
  resolveCustomCommand,
} from "./tunnels-custom.ts";

/**
 * Tunnel management — type-aware, state-persisted, tool-resolved.
 *
 * Every tunnel is a separate process (one per domain, started/stopped on
 * demand). Lifecycle: resolve tool (PATH > cache > download) → build command →
 * spawn with the tunnel role marker → buffer output → parse public URL →
 * report state. State (pid/url) mirrors to state.json so CLI restarts keep
 * showing URLs.
 *
 * Auth is NOT the tunnel's business: tunnels are pure transports to the local
 * nginx gateway port (design.md §5). `--auth` is applied at the gateway.
 */

export type TunnelType =
  | "ngrok"
  | "frpc"
  | "ssh"
  | "serveo"
  | "cloudflared"
  | "localtunnel"
  | "bore"
  | "natapp"
  | "command";

/** Which tunnel types can carry raw TCP (non-HTTP) traffic.
 *  - ngrok: `ngrok tcp <port>` ✓
 *  - ssh / serveo: `-R` raw forward ✓ (serveo is HTTP-oriented but the ssh
 *    transport is raw TCP)
 *  - frpc: `type = tcp` ✓
 *  - cloudflared free / localtunnel / bore: HTTP-only ✗
 *  - command: depends on the user's command (assume tcp-capable). */
export function tunnelSupportsTcp(type: string): boolean {
  // ngrok tcp, ssh -R, frpc tcp are raw-TCP capable. serveo is HTTP-only
  // (fixed `-R 80:` + https subdomain), localtunnel/cloudflared-free/bore are
  // HTTP. `command` depends on the user's command (assume capable), and so do
  // user-registered custom command tunnels (env SERVICE_TUNNELS_TUNNEL_COMMAND_*).
  return type === "ngrok" || type === "ssh" || type === "frpc" || type === "command" || isCustomTunnelType(type);
}

/**
 * cloudflared discovers its edge via SRV lookups
 * (_v2-origintunneld._tcp.argotunnel.com). CN networks and some router DNS
 * fail those lookups, which makes cloudflared exit before any tunnel is
 * established (the A records of the edge host still resolve there). When SRV
 * fails we pin the edge by domain — cloudflared resolves it itself, so no IP
 * list to maintain. Cache the probe (per process); override with
 * SERVICE_TUNNELS_CLOUDFLARED_EDGE=1 (always pin) / =0 (never pin).
 * Node 24 dropped the sync dns resolvers, so this is async (2s cap so a
 * hanging resolver can't stall tunnel startup).
 */
let cloudflaredEdgeCache: boolean | null = null;
export async function cloudflaredNeedsEdge(): Promise<boolean> {
  const force = process.env.SERVICE_TUNNELS_CLOUDFLARED_EDGE;
  if (force === "1") return true;
  if (force === "0") return false;
  if (cloudflaredEdgeCache === null) {
    cloudflaredEdgeCache = await Promise.race([
      dns.resolveSrv("_v2-origintunneld._tcp.argotunnel.com").then(() => false, () => true),
      new Promise<boolean>((r) => setTimeout(() => r(true), 2_000)),
    ]);
  }
  return cloudflaredEdgeCache;
}

/** `--edge` args for the cloudflared command when SRV discovery is broken. */
export async function cloudflaredEdgeArgs(): Promise<string[]> {
  return (await cloudflaredNeedsEdge())
    ? ["--edge", "region1.v2.argotunnel.com:7844", "--edge-ip-version", "4"]
    : [];
}

/** Reset the SRV probe cache (tests). */
export function _resetCloudflaredEdgeCache(): void {
  cloudflaredEdgeCache = null;
}

export interface TunnelConfig {
  name: string;
  type: TunnelType;
  /** Local port the tunnel exposes (nginx gateway port in auth mode). */
  target?: number;
  /** Fixed public host (--domain / --subdomain / custom_domains). */
  domain?: string;
  /** Extra CLI args (passed through). */
  args?: string[];
  /** Forwarding protocol: "http"/"https" go through the nginx gateway
   *  (auth/logs); "tcp" is a raw direct tunnel (no gateway — only TCP-
   *  capable tunnel types: ngrok tcp, ssh, frpc tcp). */
  protocol?: "http" | "https" | "tcp";
  /** Tunnel server address. frpc: `host:port` (default 127.0.0.1:7000).
   *  bore: `--to` target (default bore.pub; control port 7835). */
  server?: string;
  /** frpc token / bore shared secret (`-s`, env SERVICE_TUNNELS_BORE_SECRET). */
  token?: string;
  /** command type: raw shell command. */
  cmd?: string;
  /** SSH server for type "ssh" (required) or "serveo" (default serveo.net). */
  host?: string;
  /** SSH username; prepended as `user@host` when set (ssh + serveo). */
  user?: string;
  /** SSH server port (`-p`, default 22 when unset → flag omitted). */
  port?: number;
  /** Remote port forwarded on the SSH server (`-R <remotePort>:127.0.0.1:<target>`);
   *  ssh only — serveo always uses 80. Defaults to `target`.
   *  bore: requested public port (`-p`, default 0 = server-assigned). */
  remotePort?: number;
  /** Extra env vars for the tunnel process, merged over process.env at spawn
   *  (e.g. `{ NGROK_AUTHTOKEN: "..." }` so ngrok authenticates). */
  env?: Record<string, string>;
  /** Explicit opt-in required by the daemon RPC boundary for dangerous types
   *  (`command` runs a raw shell command). Set by callers that surfaced the
   *  shell-command semantics to the user; enforced in daemon-server.ts. */
  dangerous?: boolean;
}

export interface TunnelInfo {
  name: string;
  type: TunnelType;
  running: boolean;
  pid: number | null;
  /** Public URL parsed from the tunnel's output. */
  url: string | null;
  lastOutput: string;
  error?: string;
}

export interface TunnelPersistedState {
  pid: number;
  url: string | null;
}

export interface TunnelManagerOptions {
  cacheDir: string;
  /** Resolve a tool binary (PATH > cache > download). */
  resolveTool: (name: string) => Promise<string>;
  /** Extra env for tunnel processes (e.g. NGROK_AUTHTOKEN). */
  env?: Record<string, string>;
  log?: (line: string) => void;
  /** Emitted events: { type: "start"|"url"|"stop"|"error", name, url? }. */
  onEvent?: (evt: { type: "start" | "url" | "stop" | "error"; name: string; url?: string | null; error?: string }) => void;
  /** Called after a tunnel process spawns (pid registration for cleanup). */
  registerPid?: (role: string, pid: number) => void;
  /** ssh -R URL 合成延迟(ms)。默认 11s=ConnectTimeout 10s+余量(不可达主机在
   * 该窗口内退出则永不报 URL,避免假成功)。可达主机无需等满——测试/局域网
   * 可注入小值让 URL 秒级出现。 */
  sshUrlSynthDelayMs?: number;
}

/** True while a pid is a live (non-zombie) process. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end >= 0 && stat[end + 2] === "Z") return false;
    }
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const OUTPUT_LIMIT = 8192;

/** Public URL inside tunnel output.
 *
 * Known tunnel domains always win. For built-in tools (cloudflared, ngrok,
 * localtunnel, frpc, ssh) output may contain doc/ToS links that are NOT the
 * tunnel (cloudflared prints "Terms of Use (https://www.cloudflare.com/...)"
 * and "by following: https://developers.cloudflare.com/..."), so the generic
 * any-URL fallback applies ONLY to user-supplied command tunnels where the
 * URL domain cannot be predicted.
 */
/** Probe a LOCAL port to decide http vs https (for ssh -R synth URLs). */
async function detectLocalScheme(port: number, timeoutMs = 1500): Promise<"http" | "https"> {
  if (!port || port <= 0) return "http";
  const probe = (mod: "http" | "https") =>
    new Promise<boolean>((resolve) => {
      void import(mod).then(({ request }) => {
        const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", rejectUnauthorized: false, timeout: timeoutMs }, (r: { destroy(): void }) => {
          r.destroy();
          resolve(true);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
    });
  if (await probe("http")) return "http";
  if (await probe("https")) return "https";
  return "http";
}

export function extractTunnelUrl(output: string, type?: string): string | null {
  if (!output) return null;
  // Explicit URL declaration for shell-based tunnels (env-registered custom
  // types + the built-in "command" type): the template echoes
  // `ST_TUNNEL_URL:<url>` (also `=`/space separator; quotes + Windows CRLF
  // tolerated; case-insensitive) and the OPERATOR declares the URL instead of
  // relying on regex sniffing — this wins over everything below. Windows
  // friendly: `echo ST_TUNNEL_URL:http://127.0.0.1:8080` (cmd) or
  // `Write-Output "ST_TUNNEL_URL:http://x"` (PowerShell). A scheme-less
  // host[:port] gets http:// prepended.
  if (type === "command" || isCustomTunnelType(type ?? "")) {
    const m = /ST_TUNNEL_URL[\s:=]+["']?([^\s"'<>]+)["']?/i.exec(output);
    if (m && m[1]) {
      const raw = m[1].replace(/[.,;]+$/, ""); // echo 尾随标点/CRLF 残留
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
      if (/^[^\s/]+(:\d+)?(\/.*)?$/.test(raw)) return `http://${raw}`;
      return raw;
    }
  }
  const known =
    /(https?:\/\/[a-z0-9][a-z0-9.-]*\.(?:ngrok(?:\.app|\.io|\-free\.app|\-free\.dev)|trycloudflare\.com|loca\.lt|serveo\.net|serveousercontent\.com|wormhole\.app|localhost\.run|hop\.to|natappfree\.cc|natapp\.cc|natapp\.shop|natapp\.top)[^\s"'<>)\]]*)/i.exec(
      output,
    );
  if (known && known[1]) return known[1];
  // bore prints no URL scheme — synthesize http:// from "listening at host:port".
  if (type === "bore") {
    const m = /listening at\s+(\S+:\d+)/i.exec(output);
    if (m && m[1]) return `http://${m[1]}`;
    return null;
  }
  if (type !== "command" && type !== "ssh" && !isCustomTunnelType(type ?? "")) return null;
  // command/ssh: any http(s) URL not preceded by "(" and not localhost
  const any = /(?<![(\w])(https?:\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?[^\s"'<>)\]]*)/i.exec(output);
  if (any && any[1] && !/localhost|127\.0\.0\.1|0\.0\.0\.0|::1?|cloudflare\.com/.test(any[1])) return any[1];
  return null;
}

interface TunnelState {
  cfg: TunnelConfig;
  child: ChildProcess | null;
  output: string;
  url: string | null;
  error?: string;
}

interface SpawnSpec {
  bin: string;
  args: string[];
  /** shell form (command type): bin is the raw command line. */
  shell?: boolean;
  /** Extra env for this specific tunnel (merged over the manager env, under
   *  cfg.env). E.g. NGROK_AUTHTOKEN wired from cfg.token for ngrok. */
  env?: Record<string, string>;
}

/** Build an `ssh` forward spec. SSH tunnels need more than host+target:
 *  a username (`user@host`), an optional server port (`-p`), and a remote
 *  forward port (`-R <remote>:127.0.0.1:<local>`). serveo hard-codes remote
 *  port 80 (that's its URL-assignment protocol); the generic `ssh` type lets
 *  the caller pick the remote port. */
function sshSpec(opts: {
  /** Full `-R` value, e.g. "80:127.0.0.1:3000" or "8080:127.0.0.1:3000". */
  forward: string;
  /** Destination: "host" or "user@host". */
  dest: string;
  /** SSH server port (added as `-p <port>` only when set). */
  port?: number;
  /** Extra CLI args, appended verbatim. */
  extra?: string[];
  /** When true (default) add `-N` (no remote command — pure forwarding).
   *  serveo.net must OMIT it: the public URL is printed by serveo's forced
   *  session command, which `-N` suppresses (no session → no URL). */
  forwardOnly?: boolean;
  /** BatchMode=yes (default). serveo.net anonymous auth uses
   *  keyboard-interactive — BatchMode disables it → Permission denied; pass
   *  batch:false for serveo (its sshd accepts anonymous, URL via forced
   *  session; non-tty stdin is fine, serveo answers immediately). */
  batch?: boolean;
}): SpawnSpec {
  const args = [];
  if (opts.forwardOnly !== false) args.push("-N");
  args.push("-R", opts.forward);
  if (opts.batch !== false) args.push(
    // 无交互隧道: 密钥认证失败立即退出(而非挂起等密码), 防止无 tty 挂死
    "-o", "BatchMode=yes",
    // 主机密钥: 首次自动接受(隧道目标多为自建/测试服务器)
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    // keepalive: 30s 探测 + 3 次未应答判定断线(~90s), 长隧道不因空闲被掐断
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    // 转发端口绑定失败立即退出(而非静默继续)
    "-o", "ExitOnForwardFailure=yes",
  );
  if (opts.port) args.push("-p", String(opts.port));
  args.push(opts.dest, ...(opts.extra ?? []));
  return { bin: "ssh", args };
}

export class TunnelManager {
  #states = new Map<string, TunnelState>();
  #opts: TunnelManagerOptions;

  constructor(opts: TunnelManagerOptions) {
    this.#opts = opts;
  }

  get configs(): TunnelConfig[] {
    return [...this.#states.values()].map((s) => s.cfg);
  }

  /** Register (or update) a tunnel config. Not started until start(). */
  add(cfg: TunnelConfig): void {
    const existing = this.#states.get(cfg.name);
    if (existing) {
      existing.cfg = cfg;
    } else {
      this.#states.set(cfg.name, { cfg, child: null, output: "", url: null });
    }
  }

  remove(name: string): void {
    void this.stop(name);
    this.#states.delete(name);
  }

  list(): TunnelInfo[] {
    return [...this.#states.values()].map((s) => this.#info(s));
  }

  get(name: string): TunnelInfo | undefined {
    const s = this.#states.get(name);
    return s ? this.#info(s) : undefined;
  }

  #info(s: TunnelState): TunnelInfo {
    const child = s.child;
    return {
      name: s.cfg.name,
      type: s.cfg.type,
      running: Boolean(child && child.exitCode === null && !child.killed),
      pid: child?.pid ?? null,
      url: s.url,
      lastOutput: s.output,
      error: s.error,
    };
  }

  /** Persisted state (mirrors state.json: pid + url per tunnel). */
  persisted(): Record<string, TunnelPersistedState> {
    const out: Record<string, TunnelPersistedState> = {};
    for (const [name, s] of this.#states) {
      if (s.child) out[name] = { pid: s.child.pid ?? 0, url: s.url };
    }
    return out;
  }

  /** Rehydrate URLs after a restart (processes are gone — show last URL). */
  hydrate(persisted: Record<string, TunnelPersistedState>): void {
    for (const [name, p] of Object.entries(persisted)) {
      const s = this.#states.get(name);
      if (s) s.url = p.url;
    }
  }

  /** Start a tunnel. Idempotent; resolves to the running info. */
  async start(name: string): Promise<TunnelInfo> {
    const s = this.#states.get(name);
    if (!s) throw new Error(`unknown tunnel: ${name}`);
    if (s.child && s.child.exitCode === null && !s.child.killed) {
      return this.#info(s);
    }

    const cfg = s.cfg;
    // Fail-closed input validation before ANY spawn: rejects ssh option
    // injection (host/user starting with "-"), frpc INI injection (control
    // chars), path traversal (name), and garbage ports/types (see
    // docs/input-validation-security.md).
    validateTunnelConfig(cfg, name);
    const spec = await this.#build(cfg);
    s.output = "";
    s.error = undefined;
    s.url = null;

    const child = spec.shell
      ? spawn(spec.bin, { shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(spec.bin, spec.args, {
          env: { ...process.env, ...roleEnv("tunnel"), ...this.#opts.env, ...spec.env, ...cfg.env },
          detached: true, // own process group → group kill
          stdio: ["ignore", "pipe", "pipe"],
        });
    s.child = child;
    this.#opts.onEvent?.({ type: "start", name });
    this.#opts.registerPid?.("tunnel", child.pid ?? 0);

    // Generic ssh -R to the operator's own server prints no URL (unlike
    // serveo, which echoes one). The endpoint is deterministic from config,
    // so synthesize it — but ONLY once the ssh process survives startup:
    // an unreachable host makes ssh exit fast, and reporting a URL then is a
    // false "success".
    let sshUrlTimer: ReturnType<typeof setTimeout> | null = null;
    if (cfg.type === "ssh" && cfg.host) {
      const rp = cfg.remotePort ?? cfg.target;
      if (rp) {
        // scheme depends on the LOCAL target's protocol (ssh -R forwards the
        // remote port to 127.0.0.1:<target>) — probe it, default http. TCP
        // forwards get a `tcp://` URL (raw transport, no scheme).
        const synthUrl = () =>
          cfg.protocol === "tcp"
            ? Promise.resolve(`tcp://${cfg.host}:${rp}`)
            : detectLocalScheme(cfg.target ?? 0).then((scheme) => `${scheme}://${cfg.host}:${rp}`);
        // Window must exceed ssh's ConnectTimeout (10s): an unreachable host
        // keeps ssh alive for the connect attempt then exits. Only synthesize
        // the URL after ssh has survived that window (real forward established).
        sshUrlTimer = setTimeout(async () => {
          if (child.exitCode === null && s.child === child) {
            s.url = await synthUrl();
            this.#opts.onEvent?.({ type: "url", name, url: s.url });
          }
        }, this.#opts.sshUrlSynthDelayMs ?? 11_000);
      }
    }

    const append = (chunk: Buffer) => {
      s.output = (s.output + chunk.toString()).slice(-OUTPUT_LIMIT);
      const url = extractTunnelUrl(s.output, cfg.type);
      if (url && url !== s.url) {
        s.url = url;
        this.#opts.onEvent?.({ type: "url", name, url });
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (err) => {
      s.error = String(err);
      this.#opts.onEvent?.({ type: "error", name, error: s.error });
    });
    child.once("exit", (code, signal) => {
      if (sshUrlTimer) clearTimeout(sshUrlTimer);
      if (s.child === child) s.child = null;
      // ssh synth URL is PROVISIONAL: if ssh exits with an error (e.g. an
      // unreachable host hit its ConnectTimeout AFTER the 1.5s synth window),
      // revoke the URL so we don't report a false success. Custom command
      // tunnels behave the same: a declared ST_TUNNEL_URL is only valid while
      // the process is alive — non-zero exit revokes it.
      if (code !== 0 && (cfg.type === "ssh" || isCustomTunnelType(cfg.type))) {
        s.url = null;
        s.error = `exited (${signal ?? code})`;
      } else if (code !== 0 && !s.url) {
        s.error = `exited (${signal ?? code})`;
      }
      this.#opts.onEvent?.({ type: "stop", name, url: s.url });
    });
    return this.#info(s);
  }

  /** Stop a tunnel (kills its process group, waits, SIGKILL fallback). */
  async stop(name: string): Promise<void> {
    const s = this.#states.get(name);
    if (!s) return;
    const child = s.child;
    if (!child) return;
    const pid = child.pid;
    const groupKill = (sig: NodeJS.Signals) => {
      try {
        if (pid) process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    groupKill("SIGTERM");
    s.child = null;
    this.#opts.onEvent?.({ type: "stop", name, url: s.url });

    // wait for the process group to die (grace window), then SIGKILL
    if (pid) {
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline && processAlive(pid)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (processAlive(pid)) groupKill("SIGKILL");
    }
  }

  /** Stop all running tunnels. */
  async stopAll(): Promise<void> {
    for (const name of [...this.#states.keys()]) {
      await this.stop(name);
    }
  }

  async #build(cfg: TunnelConfig): Promise<SpawnSpec> {
    const tool = async (name: string) => {
      const p = await this.#opts.resolveTool(name);
      if (!p) throw new Error(`tunnel '${cfg.name}': tool ${name} not found`);
      return p;
    };
    const target = cfg.target ?? 0;
    const domain = cfg.domain;

    switch (cfg.type) {
      case "ngrok": {
        const bin = await tool("ngrok");
        const args = [cfg.protocol === "tcp" ? "tcp" : "http", String(target), "--log", "stdout"];
        if (cfg.protocol !== "tcp" && domain) args.push("--domain", domain);
        args.push(...(cfg.args ?? []));
        // Authtoken from the config/schema (tunnel add --token / expose) →
        // NGROK_AUTHTOKEN env so ngrok authenticates instead of exiting
        // ERR_NGROK_4018. env goes in as a single environment entry — no argv,
        // no shell — so the token can never break out into a command.
        const env: Record<string, string> = {};
        if (cfg.token && !cfg.env?.NGROK_AUTHTOKEN) env.NGROK_AUTHTOKEN = cfg.token;
        return { bin, args, env };
      }
      case "frpc": {
        const bin = await tool("frpc");
        const ini = await this.#writeFrpcIni(cfg, target, domain);
        return { bin, args: ["-c", ini] };
      }
      case "ssh": {
        // Generic SSH transport to the user's OWN server. host (and optional
        // user/port/remotePort) configure it; remote forward defaults to the
        // local target port. (For the serveo.net hosted service use "serveo".)
        if (!cfg.host) throw new Error(`tunnel '${cfg.name}': type "ssh" requires host`);
        const dest = cfg.user ? `${cfg.user}@${cfg.host}` : cfg.host;
        const remotePort = cfg.remotePort ?? target;
        return sshSpec({ forward: `${remotePort}:127.0.0.1:${target}`, dest, port: cfg.port, extra: cfg.args });
      }
      case "serveo": {
        // The serveo.net hosted service: forward remote port 80 and serveo
        // hands back a public URL. user/port are honored for serveo mirrors
        // or authenticated variants; host defaults to the public serveo.net.
        // forwardOnly:false — serveo prints the URL via its forced session
        // command, which `-N` would suppress.
        const host = cfg.host ?? "serveo.net";
        // serveo 匿名服务:ssh 默认用本机用户名(wind@serveo.net)会被拒——
        // serveo 官方接受固定用户名 "user"(任意值即可);显式配置 user 时优先
        const dest = cfg.user ? `${cfg.user}@${host}` : `user@${host}`;
        return sshSpec({ forward: `80:127.0.0.1:${target}`, dest, port: cfg.port, extra: cfg.args, forwardOnly: false, batch: false });
      }
      case "cloudflared": {
        const bin = await tool("cloudflared");
        const args = ["tunnel", "--url", `http://127.0.0.1:${target}`];
        if (domain) args.push("--hostname", domain);
        // SRV edge discovery may be broken (CN/router DNS); pin the edge by
        // domain in that case so the tunnel still establishes.
        args.push(...(await cloudflaredEdgeArgs()));
        args.push(...(cfg.args ?? []));
        return { bin, args };
      }
      case "localtunnel": {
        const bin = await tool("localtunnel");
        const args = ["--port", String(target)];
        if (domain) args.push("--subdomain", domain);
        args.push(...(cfg.args ?? []));
        return { bin, args };
      }
      case "natapp": {
        // natapp 中国国内内网穿透: -authtoken 认证, -weburl 本地端口。
        // 免费版输出随机 natappfree.cc 域名;VIP 可加 -server 绑定自定义域名。
        // 客户端无公开直链(官网 get.sh 安装脚本分发),缺失时给出安装命令。
        let bin: string;
        try {
          bin = await tool("natapp");
        } catch {
          throw new Error(
            `tunnel '${cfg.name}': natapp 客户端未安装。安装: 注册 https://natapp.cn 后执行 ` +
              `curl -fsSL 'https://natapp.cn/get.sh?authtoken=<你的token>' | bash (Linux/macOS) ` +
              `或官网下载页 get.ps1 (Windows);或 toolPaths.natapp 指定路径`,
          );
        }
        const token = cfg.token ?? process.env.SERVICE_TUNNELS_NATAPP_TOKEN;
        if (!token) {
          throw new Error(`tunnel '${cfg.name}': natapp requires token (authtoken, 注册 https://natapp.cn 获取)`);
        }
        const args = [`-authtoken=${token}`, `-weburl=${target}`];
        if (cfg.server) args.push(`-server=${cfg.server}`);
        args.push(...(cfg.args ?? []));
        return { bin, args };
      }
      case "bore": {
        // bore: minimal TCP tunnel (Rust, single static binary). `bore local`
        // connects to a `bore server`. Default server = bore.pub (community
        // public server, no account); self-hosted / offline use passes the
        // server explicitly or via SERVICE_TUNNELS_BORE_SERVER=localhost.
        const bin = await tool("bore");
        const server = cfg.server ?? process.env.SERVICE_TUNNELS_BORE_SERVER ?? "bore.pub";
        const args = ["local", String(target), "--to", server];
        if (cfg.remotePort) args.push("-p", String(cfg.remotePort));
        const secret = cfg.token ?? process.env.SERVICE_TUNNELS_BORE_SECRET;
        if (secret) args.push("-s", secret);
        args.push(...(cfg.args ?? []));
        return { bin, args };
      }
      case "command": {
        const cmd = cfg.cmd ?? "";
        if (!cmd) throw new Error(`tunnel '${cfg.name}': command type requires cmd`);
        return { bin: cmd, args: [], shell: true };
      }
      default: {
        // User-registered custom command tunnel (SERVICE_TUNNELS_TUNNEL_COMMAND_*):
        // assemble the shell command from its template + config values.
        if (isCustomTunnelType(cfg.type)) {
          return { bin: resolveCustomCommand(cfg.type, cfg), args: [], shell: true };
        }
        throw new Error(`tunnel '${cfg.name}': unsupported type ${cfg.type}`);
      }
    }
  }

  async #writeFrpcIni(cfg: TunnelConfig, target: number, domain: string | undefined): Promise<string> {
    const [host, port = "7000"] = (cfg.server ?? process.env.SERVICE_TUNNELS_FRPC_SERVER ?? "127.0.0.1:7000").split(":");
    const token = cfg.token ?? process.env.SERVICE_TUNNELS_FRPC_TOKEN ?? "";
    const iniPath = join(this.#opts.cacheDir, "tmp", `frpc-${cfg.name}.ini`);
    mkdirSync(join(this.#opts.cacheDir, "tmp"), { recursive: true });
    const lines = [
      "[common]",
      `server_addr = ${host}`,
      `server_port = ${port}`,
    ];
    if (token) lines.push(`token = ${token}`);
    if (cfg.protocol === "tcp") {
      lines.push("", "[web]", "type = tcp", "local_ip = 127.0.0.1", `local_port = ${target}`, `remote_port = ${cfg.remotePort ?? target}`);
    } else {
      lines.push("", "[web]", "type = http", "local_ip = 127.0.0.1", `local_port = ${target}`);
      lines.push(`custom_domains = ${domain ?? "localhost"}`);
    }
    writeFileSync(iniPath, lines.join("\n") + "\n", "utf8");
    return iniPath;
  }
}

/**
 * Declarative parameter schema — drives client (host) form rendering so a
 * new tunnel type or auth provider needs NO client code changes: the client
 * renders inputs from these specs (label / description / link / default /
 * type) and spreads the collected values back as TunnelConfig fields (or
 * provider options). Keys are TunnelConfig field names (domain/server/token/
 * host/user/port/remotePort/cmd/...).
 */
export interface ParamSpec {
  /** Key into TunnelConfig (or provider options). Nested with "." (e.g.
   *  "oidc.issuerUrl" → { oidc: { issuerUrl } }). */
  key: string;
  /** Display label (default: key). */
  label?: string;
  type?: "string" | "number" | "boolean" | "password";
  description?: string;
  /** Docs / setup link (e.g. ngrok dashboard token page). */
  link?: string;
  linkTitle?: string;
  default?: string | number | boolean;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label?: string; labelKey?: string }>;
  // 多语(0.3.27+):稳定翻译 id,由 withSchemaI18nKeys() 自动注入——
  // 调用方按 id 翻译,未命中回退内置中文。形态
  //   tunnel.<type>.<key>.label / auth.<type>.<key>.description / ...
  labelKey?: string;
  descriptionKey?: string;
  placeholderKey?: string;
  linkTitleKey?: string;
}

/** Tunnel-type parameter schemas (data-driven forms; the only place a tunnel
 *  type's user-facing parameters are declared). */
export const TUNNEL_PARAM_SCHEMAS: Record<TunnelType, ParamSpec[]> = {
  ngrok: [
    {
      key: "domain",
      label: "Fixed domain",
      description: "Bind a fixed domain (requires an ngrok account); leave empty for a random domain",
      placeholder: "myapp.ngrok-free.app",
    },
    {
      key: "token",
      type: "password",
      label: "Authtoken",
      description: "Unauthenticated ngrok exits immediately (ERR_NGROK_4018); the token is injected via NGROK_AUTHTOKEN",
      link: "https://dashboard.ngrok.com/get-started/your-authtoken",
      linkTitle: "Get token",
    },
  ],
  frpc: [
    {
      key: "server",
      label: "frps address",
      default: "127.0.0.1:7000",
      description: "frps server host:port",
      placeholder: "frp.example.com:7000",
    },
    { key: "token", type: "password", label: "Token", description: "frps shared token (optional)" },
    { key: "domain", label: "Custom domain", description: "custom_domains; leave empty for localhost", placeholder: "app.example.com" },
  ],
  ssh: [
    { key: "host", label: "SSH server", required: true, placeholder: "target server", description: "ssh -R target server (required; forwards to the server's public port; self-hosted or cloud)" },
    { key: "user", label: "Username", placeholder: "wind", description: "user@host; leave empty for the current user" },
    { key: "port", type: "number", label: "SSH port", default: 22, description: "ssh -p" },
    { key: "remotePort", type: "number", label: "Remote port", description: "-R <remotePort>:127.0.0.1:<target>; empty = target" },
  ],
  serveo: [
    { key: "host", label: "serveo mirror", default: "serveo.net" },
    { key: "user", label: "Username" },
    { key: "port", type: "number", label: "SSH port", default: 22 },
  ],
  cloudflared: [
    { key: "domain", label: "Hostname", description: "Named-tunnel hostname; leave empty for a random trycloudflare", placeholder: "app.example.com" },
  ],
  natapp: [
    {
      key: "token",
      type: "password",
      label: "Authtoken",
      description: "natapp auth token (copy from your tunnel list after registering); the client must be installed via the official script",
      link: "https://natapp.cn/download",
      linkTitle: "Download client + get token",
    },
    {
      key: "domain",
      label: "Custom domain",
      description: "Bind a fixed domain (requires VIP); leave empty for a random domain",
      placeholder: "xxx.natappfree.cc",
    },
    {
      key: "server",
      label: "Server",
      description: "Assigned server for VIP custom domains (optional)",
      placeholder: "server.natapp.cc",
    },
  ],
  localtunnel: [
    { key: "domain", label: "Subdomain", description: "Fixed subdomain; leave empty for a random one" },
  ],
  bore: [
    {
      key: "server",
      label: "bore server",
      default: "bore.pub",
      description: "bore server address (host or host:port); default bore.pub:7835 (public, no account); self-hosted: use your server IP:port",
    },
    { key: "remotePort", type: "number", label: "Remote port", description: "-p requests a fixed port; empty = server-assigned" },
    { key: "token", type: "password", label: "Secret", description: "-s shared secret; leave empty if the server has none" },
  ],
  command: [
    { key: "cmd", label: "Command", required: true, description: "Any shell command; the public URL is parsed from output", placeholder: "ssh -R 80:127.0.0.1:<port> serveo.net" },
  ],
};

/** Tunnel types that support random/assigned domains (not fixed-only). */
export function tunnelSupportsRandomDomain(type: TunnelType): boolean {
  return ["natapp", "localtunnel", "serveo", "cloudflared"].includes(type);
}

/** Param schema for one tunnel type ([] when unknown). Custom command tunnel
 *  types (env-registered) generate their schema from the template. */
export function tunnelParamSchema(type: string): ParamSpec[] {
  const specs = type in TUNNEL_PARAM_SCHEMAS
    ? TUNNEL_PARAM_SCHEMAS[type as TunnelType]
    : customTunnelParamSchema(customTunnelTemplates()[type] ?? "");
  return withSchemaI18nKeys("tunnel", type, specs);
}

/** All tunnel-type param schemas (keyed by type): built-ins + user-registered
 *  custom command tunnels (SERVICE_TUNNELS_TUNNEL_COMMAND_*). */
export function tunnelParamSchemas(): Record<string, ParamSpec[]> {
  const all = { ...TUNNEL_PARAM_SCHEMAS, ...customTunnelParamSchemas() };
  return Object.fromEntries(
    Object.entries(all).map(([type, specs]) => [type, withSchemaI18nKeys("tunnel", type, specs)]),
  );
}

/** Per-type UI metadata. `favorite` marks zero-account / few-params /
 *  immediately-usable types (localtunnel/serveo/cloudflared/bore) — clients
 *  sort them first and surface a badge. `dangerous` marks types that execute
 *  arbitrary user-supplied shell commands (e.g. `command`) — clients should
 *  hide or gate them behind explicit confirmation. */
export interface TunnelMeta {
  favorite?: boolean;
  /** Type executes arbitrary shell / external tooling — clients must not
   *  offer it as a one-click option without explicit opt-in. */
  dangerous?: boolean;
}

export const TUNNEL_META: Record<TunnelType, TunnelMeta> = {
  ngrok: {},
  frpc: {},
  ssh: {},
  serveo: { favorite: true },
  cloudflared: { favorite: true },
  localtunnel: { favorite: true },
  bore: { favorite: true },
  // natapp 需 natapp.cn 付费 authtoken(非零账号/即开即用)——不标星
  natapp: {},
  // `command` runs a raw shell command as the tunnel — dangerous by design;
  // consumers that expose a one-click tunnel picker must hide it (meta flag).
  command: { dangerous: true },
};

export function tunnelMeta(type: string): TunnelMeta {
  return TUNNEL_META[type as TunnelType] ?? {};
}

/** Built-in metadata + user-registered custom command tunnels (explicit env
 *  opt-in → never marked dangerous). */
export function tunnelMetas(): Record<string, TunnelMeta> {
  const custom: Record<string, TunnelMeta> = {};
  for (const type of Object.keys(customTunnelTemplates())) custom[type] = {};
  return { ...TUNNEL_META, ...custom };
}

/** Coerce a form/CLI string against a param spec (number/boolean/string). */
export function coerceParam(raw: string, spec: ParamSpec): string | number | boolean {
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`param "${spec.key}" expects a number, got "${raw}"`);
    return n;
  }
  if (spec.type === "boolean") return raw === "true" || raw === "1" || raw === "yes";
  return raw;
}

/** Validate + coerce --set/form values against a ParamSpec list. Throws on
 *  unknown keys (listing the valid ones) so typos surface immediately — the
 *  same schema drives host forms and the CLI. */
export function applyParamSets(
  specs: ParamSpec[],
  sets: Record<string, string>,
  label: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(sets)) {
    const spec = specs.find((s) => s.key === key);
    if (!spec) {
      throw new Error(`${label}: unknown param "${key}" (valid: ${specs.map((s) => s.key).join(", ") || "(none)"})`);
    }
    out[key] = coerceParam(raw, spec);
  }
  return out;
}
