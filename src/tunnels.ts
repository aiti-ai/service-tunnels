import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { roleEnv } from "./marker.ts";

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

export type TunnelType = "ngrok" | "frpc" | "ssh" | "cloudflared" | "localtunnel" | "command";

export interface TunnelConfig {
  name: string;
  type: TunnelType;
  /** Local port the tunnel exposes (nginx gateway port in auth mode). */
  target?: number;
  /** Fixed public host (--domain / --subdomain / custom_domains). */
  domain?: string;
  /** Extra CLI args (passed through). */
  args?: string[];
  /** frpc server (host:port) / token — defaults from env/config. */
  server?: string;
  token?: string;
  /** command type: raw shell command. */
  cmd?: string;
  /** SSH host for type "ssh" (default serveo.net). */
  host?: string;
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

/** Public URL inside tunnel output: known tunnel domains first, then any
 *  non-localhost http(s) URL. */
export function extractTunnelUrl(output: string): string | null {
  if (!output) return null;
  const known =
    /(https?:\/\/[a-z0-9][a-z0-9.-]*\.(?:ngrok(?:\.app|\.io|\-free\.app)|trycloudflare\.com|loca\.lt|serveo\.net|serveousercontent\.com|wormhole\.app|localhost\.run|hop\.to)[^\s"'<>)\]]*)/i.exec(
      output,
    );
  if (known && known[1]) return known[1];
  const any = /(https?:\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?[^\s"'<>)\]]*)/i.exec(output);
  if (any && any[1] && !/localhost|127\.0\.0\.1|0\.0\.0\.0|::1?/.test(any[1])) return any[1];
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
    const spec = await this.#build(cfg);
    s.output = "";
    s.error = undefined;
    s.url = null;

    const child = spec.shell
      ? spawn(spec.bin, { shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(spec.bin, spec.args, {
          env: { ...process.env, ...roleEnv("tunnel"), ...this.#opts.env },
          detached: true, // own process group → group kill
          stdio: ["ignore", "pipe", "pipe"],
        });
    s.child = child;
    this.#opts.onEvent?.({ type: "start", name });

    const append = (chunk: Buffer) => {
      s.output = (s.output + chunk.toString()).slice(-OUTPUT_LIMIT);
      const url = extractTunnelUrl(s.output);
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
      if (s.child === child) s.child = null;
      if (code !== 0 && !s.url) {
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
        const args = ["http", String(target), "--log", "stdout"];
        if (domain) args.push("--domain", domain);
        args.push(...(cfg.args ?? []));
        return { bin, args };
      }
      case "frpc": {
        const bin = await tool("frpc");
        const ini = await this.#writeFrpcIni(cfg, target, domain);
        return { bin, args: ["-c", ini] };
      }
      case "ssh": {
        const host = cfg.host ?? "serveo.net";
        const args = [
          "-N",
          "-R", `80:127.0.0.1:${target}`,
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", "ConnectTimeout=10",
          "-o", "ServerAliveInterval=30",
          "-o", "ExitOnForwardFailure=yes",
          host,
        ];
        args.push(...(cfg.args ?? []));
        return { bin: "ssh", args };
      }
      case "cloudflared": {
        const bin = await tool("cloudflared");
        const args = ["tunnel", "--url", `http://127.0.0.1:${target}`];
        if (domain) args.push("--hostname", domain);
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
      case "command": {
        const cmd = cfg.cmd ?? "";
        if (!cmd) throw new Error(`tunnel '${cfg.name}': command type requires cmd`);
        return { bin: cmd, args: [], shell: true };
      }
      default:
        throw new Error(`tunnel '${cfg.name}': unsupported type ${cfg.type}`);
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
    lines.push("", "[web]", "type = http", "local_ip = 127.0.0.1", `local_port = ${target}`);
    lines.push(`custom_domains = ${domain ?? "localhost"}`);
    writeFileSync(iniPath, lines.join("\n") + "\n", "utf8");
    return iniPath;
  }
}
