import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  statSync,
  rmSync,
  renameSync,
  symlinkSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { platform, arch, tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { download as justgetDownload } from "justget";

/**
 * Tool resolution + auto-download.
 *
 * Resolution precedence for every tool (ngrok/frpc/cloudflared/authelia/
 * nginx/redis/lt):
 *   1. caller-specified path (`toolPaths` config / `--tool-path` CLI),
 *   2. system PATH (the OS already has it — use it as-is),
 *   3. already downloaded in cacheDir/bin,
 *   4. on demand: auto-download (official source first, China mirrors as
 *      fallback) into cacheDir/bin.
 *
 * Mirrors: GitHub-release tools (frpc/cloudflared/authelia) get ghproxy-style
 * prefixes (mirror.ghproxy.com / gh-proxy.com / github.moeyy.xyz). npm tools
 * (localtunnel) prefer the npmmirror registry. ngrok's downloads live on
 * equinox.io (no GitHub mirror) — mirror list is configurable per tool.
 */

export type ToolKind = "binary" | "tar.gz" | "zip" | "npm";

/** Node os.arch() → GitHub release asset arch naming. */
const ARCH_ALIAS: Record<string, string> = {
  x64: "amd64",
  ia32: "386",
  arm: "arm",
  arm64: "arm64",
  riscv64: "riscv64",
  ppc64: "ppc64le",
  s390x: "s390x",
};

/** Node platform() → CDN dir naming (natapp uses "windows", not "win32"). */
const DL_PLATFORM: Record<string, string> = {
  win32: "windows",
  linux: "linux",
  darwin: "darwin",
};

/** Node (platform, arch) → Rust target triple, for Rust-built tools whose
 *  release assets are named with full triples (e.g. bore ships
 *  `bore-v0.5.1-x86_64-unknown-linux-musl.tar.gz`). Keyed `"<platform>_<arch>"`. */
const RUST_TARGET: Record<string, string> = {
  linux_x64: "x86_64-unknown-linux-musl",
  linux_ia32: "i686-unknown-linux-musl",
  linux_arm64: "aarch64-unknown-linux-musl",
  linux_arm: "armv7-unknown-linux-gnueabihf",
  darwin_x64: "x86_64-apple-darwin",
  darwin_arm64: "aarch64-apple-darwin",
  win32_x64: "x86_64-pc-windows-msvc",
  win32_ia32: "i686-pc-windows-msvc",
};

export interface DownloadSpec {
  /** Official URL template: {version} {platform} {arch} {ext} {exe} are
   *  substituted ({arch} = amd64/arm64/386… per platform,
   *  {ext} = exts.posix|win default tgz|zip, {exe} = .exe on win32). */
  official: string;
  /** China-mirror templates. "{official}" expands to the official URL
   *  (ghproxy-style prefixing) — or a plain template as well. */
  mirrors?: string[];
  kind: ToolKind;
  /** Per-platform extension for {ext} (default: tgz on POSIX, zip on win32). */
  exts?: { posix: string; win: string };
  /** Path of the executable inside an archive (default: archive basename). */
  binPath?: string;
  /** Strip leading dirs when extracting (tarballs). */
  strip?: number;
}

export interface ToolDef {
  name: string;
  version?: string;
  platforms: NodeJS.Platform[];
  download: DownloadSpec;
  /** npm package (kind "npm"). */
  npmPackage?: string;
  /** Registry override (default npmmirror for CN). */
  npmRegistry?: string;
  /** Sanity check after download (e.g. ["--version"]). */
  verifyArgs?: string[];
  /** PATH lookup aliases (npm bin names differ from the tool name, e.g.
   *  localtunnel's binary is `lt`). First hit wins; defaults to [name]. */
  commands?: string[];
}

/** Parse SERVICE_TUNNELS_TOOLPATHS (JSON {tool: path}) — env-level defaults. */
export function readEnvToolPaths(): Record<string, string> {
  const raw = process.env.SERVICE_TUNNELS_TOOLPATHS;
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, string>;
  } catch {
    // ignore malformed env
  }
  return {};
}

/** Merge env defaults with explicit overrides (explicit wins). */
export function mergeToolPaths(explicit?: Record<string, string>): Record<string, string> {
  return { ...readEnvToolPaths(), ...(explicit ?? {}) };
}

export interface ToolRegistryOptions {
  cacheDir: string;
  /** Caller-specified explicit paths: { toolName: "/abs/path" }. */
  toolPaths?: Record<string, string>;
  /** Per-tool mirror override: { toolName: ["https://..."], default: [...] }. */
  toolMirrors?: Record<string, string[]>;
  /** Force mirrors first (CN networks). */
  preferMirrors?: boolean;
  /** Allow on-demand downloads when a tool is missing (default true). When
   *  false, missing tools throw instead of auto-installing. */
  allowToolDownload?: boolean;
  /** Download timeout per attempt (ms). */
  downloadTimeoutMs?: number;
}

export class ToolError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ToolError";
  }
}

/** Official + mirror URLs for the current platform, in attempt order. */
export function candidateUrls(
  def: ToolDef,
  opts: ToolRegistryOptions,
): Array<{ url: string; kind: ToolKind; label: string }> {
  const spec = def.download;
  const isWin = platform() === "win32";
  const fill = (t: string) =>
    t
      .replaceAll("{version}", def.version ?? "")
      .replaceAll("{platform}", platform())
      .replaceAll("{dl_platform}", DL_PLATFORM[platform()] ?? platform())
      .replaceAll("{arch}", ARCH_ALIAS[arch()] ?? arch())
      .replaceAll("{rust_target}", RUST_TARGET[`${platform()}_${arch()}`] ?? "{rust_target}")
      .replaceAll(
        "{ext}",
        isWin ? (spec.exts?.win ?? "zip") : (spec.exts?.posix ?? "tgz"),
      )
      .replaceAll("{exe}", isWin ? ".exe" : "");

  const configured = opts.toolMirrors?.[def.name] ?? opts.toolMirrors?.default;
  const mirrors = configured ?? spec.mirrors ?? [];

  const official = { url: fill(spec.official), kind: spec.kind, label: "official" };
  const mirrorUrls = mirrors.map((m, i) => {
    // three mirror forms:
    //   1. "{official}" placeholder → ghproxy-style prefix wrapping
    //   2. full URL template with placeholders (Gitee etc.) → fill directly
    //   3. bare prefix → official URL appended
    const isTemplate =
      m.includes("{official}") ||
      m.includes("{version}") ||
      m.includes("{platform}") ||
      m.includes("{arch}") ||
      m.includes("{ext}") ||
      m.includes("{exe}");
    const url = isTemplate
      ? m.replaceAll("{official}", spec.official)
      : m.endsWith("/")
        ? `${m}${spec.official}`
        : `${m}/${spec.official}`;
    return { url: fill(url), kind: spec.kind, label: `mirror#${i + 1}` };
  });

  return opts.preferMirrors ? [...mirrorUrls, official] : [official, ...mirrorUrls];
}

function platformSupported(def: ToolDef): boolean {
  return def.platforms.includes(platform());
}

/** Which <name> → true when the tool resolves on PATH. */
export function findOnPath(name: string): string | null {
  try {
    const found = execFileSync("which", [name], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

/** Try every PATH alias of a tool (name + commands) — first hit wins. */
export function findOnPathAll(def: ToolDef): string | null {
  for (const cmd of def.commands ?? [def.name]) {
    const hit = findOnPath(cmd);
    if (hit) return hit;
  }
  return null;
}

/** Cache location for a downloaded tool. Windows binaries carry .exe. */
function downloadedPath(cacheDir: string, name: string): string {
  const base = join(cacheDir, "bin");
  const plain = join(base, name);
  const exe = join(base, `${name}.exe`);
  if (process.platform === "win32") return existsSync(plain) ? plain : exe;
  return plain;
}

export async function downloadTo(
  url: string,
  dest: string,
  timeoutMs: number,
): Promise<void> {
  mkdirSync(join(dest, ".."), { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new ToolError(`HTTP ${res.status} for ${url}`);
    const body = res.body;
    if (!body) throw new ToolError(`empty body for ${url}`);
    const tmp = `${dest}.dl-${process.pid}`;
    await new Promise<void>((ok, bad) => {
      const writer = createWriteStream(tmp);
      writer.on("finish", ok);
      writer.on("error", bad);
      const reader = body.getReader();
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          writer.end();
          return;
        }
        writer.write(Buffer.from(value));
        await pump();
      };
      // Route pump failures (incl. AbortError when the download timeout
      // aborts the fetch body) to `bad`, so the outer Promise rejects and the
      // caller can fall back to the next mirror. Without this, a timeout
      // surfaces the AbortError from reader.read() as an *unhandled* rejection
      // that crashes the whole process.
      pump().catch((err) => {
        reader.cancel?.().catch(() => {});
        writer.destroy();
        bad(err);
      });
    });
    // atomic rename on success
    await import("fs").then((fs) => fs.promises.rename(tmp, dest));
  } finally {
    clearTimeout(timer);
  }
}

/** Extract .tar.gz (tar -xzf) or .zip (unzip/tar/PowerShell) into work. */
export function extractInto(archive: string, work: string, kind: ToolKind): void {
  if (kind === "tar.gz") {
    execFileSync("tar", ["-xzf", archive, "-C", work], { stdio: "ignore" });
    return;
  }
  if (kind === "zip") {
    if (process.platform === "win32") {
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Force -Path '${archive}' -DestinationPath '${work}'`],
        { stdio: "ignore" },
      );
      return;
    }
    if (process.platform === "darwin") {
      execFileSync("ditto", ["-x", "-k", archive, work], { stdio: "ignore" });
      return;
    }
    // Linux: unzip → python3 -m zipfile → bsdtar, whichever exists
    for (const [cmd, args] of [
      ["unzip", ["-q", archive, "-d", work]],
      ["python3", ["-m", "zipfile", "-e", archive, work]],
      ["tar", ["-xf", archive, "-C", work]],
    ] as const) {
      try {
        execFileSync(cmd, args, { stdio: "ignore" });
        return;
      } catch {
        // try next
      }
    }
    throw new ToolError("zip extraction requires unzip, python3, or bsdtar");
  }
  throw new ToolError(`unsupported archive kind: ${kind}`);
}

/** Sniff the archive type from its magic bytes (PK = zip, 1f8b = gzip). */
export function detectArchiveKind(archive: string, fallback: ToolKind): ToolKind {
  try {
    const fd = openSync(archive, "r");
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip"; // "PK"
    if (buf[0] === 0x1f && buf[1] === 0x8b) return "tar.gz"; // gzip magic
  } catch {
    // unreadable → fallback
  }
  return fallback;
}

/** Copy the tool out of the archive and locate its executable. */
export async function extractArchive(
  archive: string,
  def: ToolDef,
  destDir: string,
): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const isWin = platform() === "win32";
  const kind = detectArchiveKind(archive, def.download.kind);
  const strip = def.download.strip ?? 1;
  const work = mkdtempSync(join(tmpdir(), "st-tool-"));
  try {
    extractInto(archive, work, kind);
    // strip leading components by moving the (single) top-level dir's contents up
    if (strip > 0) {
      const top = readdirSync(work)[0];
      if (top) {
        const topPath = join(work, top);
        const st = statSyncSafe(topPath);
        if (st?.isDirectory()) {
          for (const entry of readdirSync(topPath)) {
            const from = join(topPath, entry);
            const to = join(work, entry);
            try {
              renameSync(from, to);
            } catch {
              copySync(from, to);
            }
          }
        }
      }
    }
    const binName = def.download.binPath ?? def.name;
    const exeName = isWin ? `${binName}.exe` : binName;
    // find the executable under work (first matching basename)
    const candidates: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        const st = statSyncSafe(full);
        if (st?.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry === binName || entry === exeName || entry.startsWith(`${binName}.`)) {
          candidates.push(full);
        }
      }
    };
    walk(work);
    const hit = candidates.sort((a, b) => a.length - b.length)[0];
    if (!hit) throw new ToolError(`cannot locate ${binName} inside ${archive}`);
    const dest = join(destDir, isWin ? `${def.name}.exe` : def.name);
    copySync(hit, dest);
    try {
      chmodSync(dest, 0o755);
    } catch {
      // Windows chmod is a no-op / may throw on some filesystems
    }
    return dest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function statSyncSafe(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** fs.promises.copyFile wrapped synchronously (tiny files, fine). */
function copySync(from: string, to: string): void {
  const { copyFileSync } = requireFs();
  copyFileSync(from, to);
}

let _fsCache: typeof import("fs") | null = null;
function requireFs(): typeof import("fs") {
  if (!_fsCache) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _fsCache = createRequire(import.meta.url)("fs") as typeof import("fs");
  }
  return _fsCache;
}

/** Ensure a tool is available locally: PATH > cached > download. Returns path. */
export async function ensureTool(
  def: ToolDef,
  opts: ToolRegistryOptions,
): Promise<string> {
  // 1. caller-specified path (CLI/env merged — env SERVICE_TUNNELS_TOOLPATHS)
  const toolPaths = mergeToolPaths(opts.toolPaths);
  const explicit = toolPaths[def.name];
  if (explicit) {
    if (!existsSync(explicit)) throw new ToolError(`toolPaths.${def.name}=${explicit} does not exist`);
    return explicit;
  }
  // 2. system PATH (name + command aliases)
  const onPath = findOnPathAll(def);
  if (onPath) return onPath;
  // 3. cached download
  const cached = downloadedPath(opts.cacheDir, def.name);
  if (existsSync(cached)) return cached;
  // 4. auto-download (skipped when downloads are disabled)
  if (opts.allowToolDownload === false) {
    throw new ToolError(
      `${def.name} is not installed and online tool downloads are disabled — install it manually or re-enable downloads`,
    );
  }
  if (!platformSupported(def)) {
    throw new ToolError(
      `${def.name} has no ${platform()} ${arch()} build; use a system install (e.g. apt) or WSL2/Docker`,
    );
  }
  if (def.download.kind === "npm") {
    return ensureNpmTool(def, opts);
  }
  return ensureDownloadedTool(def, opts);
}

/** Resolve a tool WITHOUT downloading: toolPaths > PATH > cache, else null.
 *  Used by the availability UI + by callers that must never auto-install. */
export function probeTool(
  def: ToolDef,
  opts: ToolRegistryOptions,
): { path: string; source: "toolPaths" | "path" | "cache" } | null {
  const toolPaths = mergeToolPaths(opts.toolPaths);
  const explicit = toolPaths[def.name];
  if (explicit) {
    if (existsSync(explicit)) return { path: explicit, source: "toolPaths" };
    return null;
  }
  const onPath = findOnPathAll(def);
  if (onPath) return { path: onPath, source: "path" };
  const cached = downloadedPath(opts.cacheDir, def.name);
  if (existsSync(cached)) return { path: cached, source: "cache" };
  return null;
}

async function ensureDownloadedTool(def: ToolDef, opts: ToolRegistryOptions): Promise<string> {  const dest = downloadedPath(opts.cacheDir, def.name);
  const urls = candidateUrls(def, opts);
  const timeoutMs = opts.downloadTimeoutMs ?? 60_000;
  const archive = `${dest}.dl-${process.pid}`;
  const [official, ...mirrorUrls] = urls;
  if (!official) {
    throw new ToolError(`${def.name}: no download source URLs`);
  }

  // justget 多源竞速：官方 + 镜像并行，官方 4xx/超时立即失败并交给镜像接管，
  // 内部自带重试与容错——不需要顺序回退。
  // justget racing download: official + mirrors in parallel, immediate-failure
  // handover to mirrors, retries built in — no sequential fallback needed.
  try {
    await justgetDownload({
      url: official.url,
      output: archive,
      mirrors: mirrorUrls.map((m) => m.url),
      options: {
        timeout: timeoutMs,
        connectTimeout: Math.min(timeoutMs, 10_000),
        retries: 0,
        retryDelay: 0,
      },
    });
  } catch (err) {
    throw new ToolError(
      `${def.name}: all download sources failed via justget — ${err instanceof Error ? err.message : String(err)}. ` +
        `Try installing it manually (apt install ${def.name}) or set toolPaths.${def.name}.`,
    );
  }
  try {
    const final = await extractArchive(archive, def, join(opts.cacheDir, "bin"));
    rmSync(archive, { force: true });
    if (def.verifyArgs) {
      try {
        execFileSync(final, def.verifyArgs, { stdio: "ignore" });
      } catch {
        throw new ToolError(`${def.name} downloaded via justget failed verification`);
      }
    }
    return final;
  } catch (err) {
    rmSync(archive, { force: true });
    rmSync(dest, { force: true });
    throw new ToolError(
      `${def.name}: downloaded archive failed to extract/verify — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function ensureNpmTool(def: ToolDef, opts: ToolRegistryOptions): Promise<string> {
  const dest = downloadedPath(opts.cacheDir, def.name);
  if (existsSync(dest)) return dest;
  const pkg = def.npmPackage ?? def.name;
  const registry = def.npmRegistry ?? "https://registry.npmmirror.com";
  try {
    execFileSync("npm", ["install", "--prefix", join(opts.cacheDir, "npm"), pkg, "--registry", registry], {
      stdio: "ignore",
      timeout: 120_000,
    });
  } catch {
    // fall back to official registry
    execFileSync("npm", ["install", "--prefix", join(opts.cacheDir, "npm"), pkg], { stdio: "ignore", timeout: 120_000 });
  }
  // npm bins often differ from the tool name (localtunnel ships `lt`).
  // Walk def.commands (alias order) then fall back to def.name; first hit wins.
  const binNames = [...(def.commands ?? []), def.name];
  let bin = "";
  for (const n of binNames) {
    const cand = join(opts.cacheDir, "npm", "node_modules", ".bin", n);
    if (existsSync(cand)) {
      bin = cand;
      break;
    }
  }
  if (!bin) throw new ToolError(`${def.name}: npm install produced no bin (looked for ${binNames.join(", ")})`);
  // link into cacheDir/bin so resolution is uniform (symlink on POSIX, copy on
  // Windows where symlinks need privileges). The bin/ dir is created here
  // (ensureNpmTool is the only path that writes to it without going through
  // extractArchive, which mkdirs itself).
  mkdirSync(join(dest, ".."), { recursive: true });
  if (process.platform === "win32") {
    copySync(bin, dest);
  } else {
    try {
      symlinkSync(bin, dest);
    } catch {
      copySync(bin, dest);
    }
  }
  return dest;
}

// ── Built-in tool table ──────────────────────────────────────────────────────

const GH_MIRRORS = [
  "https://mirror.ghproxy.com/{official}",
  "https://gh-proxy.com/{official}",
  "https://github.moeyy.xyz/{official}",
];

/** Tools the framework knows how to resolve/download. */
export const TOOLS: Record<string, ToolDef> = {
  ngrok: {
    name: "ngrok",
    version: "3.19.1",
    platforms: ["linux", "darwin", "win32"],
    download: {
      // equinox.io ships .tgz on POSIX, .zip on Windows ({ext} handles it)
      official: "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-{platform}-{arch}.{ext}",
      mirrors: [
        "https://gitee.com/justdb-mirrors/downloads/releases/download/ngrok-3.19.1/ngrok-v3-stable-{platform}-{arch}.{ext}",
        ...GH_MIRRORS,
      ],
      kind: "tar.gz", // kind is re-selected by ext at extraction time
      binPath: "ngrok",
    },
    verifyArgs: ["version"],
  },
  frpc: {
    name: "frpc",
    version: "0.61.1",
    platforms: ["linux", "darwin", "win32"],
    download: {
      official:
        "https://github.com/fatedier/frp/releases/download/v{version}/frp_{version}_{platform}_{arch}.{ext}",
      mirrors: [
        "https://gitee.com/justdb-mirrors/frp/releases/download/v{version}/frp_{version}_{platform}_{arch}.{ext}",
        ...GH_MIRRORS,
      ],
      kind: "tar.gz",
      exts: { posix: "tar.gz", win: "zip" },
      binPath: "frpc",
    },
    verifyArgs: ["-v"],
  },
  cloudflared: {
    name: "cloudflared",
    version: "2026.7.3",
    platforms: ["linux", "darwin", "win32"],
    download: {
      official:
        "https://github.com/cloudflare/cloudflared/releases/download/v{version}/cloudflared-{platform}-{arch}{exe}",
      mirrors: [
        "https://gitee.com/justdb-mirrors/downloads/releases/download/cloudflared-2026.7.3/cloudflared-{platform}-{arch}{exe}",
        ...GH_MIRRORS,
      ],
      kind: "binary",
    },
    verifyArgs: ["--version"],
  },
  authelia: {
    name: "authelia",
    version: "4.38.10",
    platforms: ["linux", "darwin"], // no official Windows binary → WSL2/Docker
    download: {
      official:
        "https://github.com/authelia/authelia/releases/download/v{version}/authelia-v{version}-{platform}-{arch}.tar.gz",
      mirrors: [
        "https://gitee.com/justdb-mirrors/authelia/releases/download/v{version}/authelia-v{version}-{platform}-{arch}.tar.gz",
        ...GH_MIRRORS,
      ],
      kind: "tar.gz",
      exts: { posix: "tar.gz", win: "zip" },
      binPath: "authelia",
    },
    verifyArgs: ["--version"],
  },
  localtunnel: {
    name: "localtunnel",
    commands: ["lt", "localtunnel"],
    platforms: ["linux", "darwin", "win32"],
    download: { official: "", kind: "npm" },
    npmPackage: "localtunnel",
    npmRegistry: "https://registry.npmmirror.com",
  },
  bore: {
    // bore: a minimal TCP tunnel (Rust, single static binary). The lightest
    // self-hostable option — run `bore server` locally and point clients at
    // it for offline/CI end-to-end testing without any account or public
    // server. Assets are full Rust target triples (see RUST_TARGET).
    name: "bore",
    version: "0.6.0",
    platforms: ["linux", "darwin", "win32"],
    download: {
      official:
        "https://github.com/ekzhang/bore/releases/download/v{version}/bore-v{version}-{rust_target}.{ext}",
      mirrors: [
        "https://gitee.com/justdb-mirrors/downloads/releases/download/bore-0.6.0/bore-v{version}-{rust_target}.{ext}",
        ...GH_MIRRORS,
      ],
      kind: "tar.gz",
      exts: { posix: "tar.gz", win: "zip" },
      binPath: "bore",
    },
    verifyArgs: ["-V"],
  },
  natapp: {
    // natapp: 国内内网穿透（natapp.cn）。免费版随机域名 (natappfree.cc),
    // VIP 绑定自定义域名。**无公开直链**——客户端经官网安装脚本分发
    // (https://natapp.cn/get.sh?authtoken=<token>, 需注册后取 token),所以
    // 不配自动下载;解析走 PATH / toolPaths.natapp / 缓存,缺失时 tunnels.ts
    // 给出官网安装命令。
    name: "natapp",
    platforms: ["linux", "darwin", "win32"],
    download: { official: "", kind: "binary" },
  },
  "oauth2-proxy": {
    name: "oauth2-proxy",
    version: "7.6.0",
    platforms: ["linux", "darwin"],
    download: {
      official:
        "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v{version}/oauth2-proxy-v{version}.{platform}-{arch}.tar.gz",
      mirrors: [
        "https://gitee.com/justdb-mirrors/oauth2-proxy/releases/download/v{version}/oauth2-proxy-v{version}.{platform}-{arch}.tar.gz",
        ...GH_MIRRORS,
      ],
      kind: "tar.gz",
      exts: { posix: "tar.gz", win: "zip" },
      binPath: "oauth2-proxy",
    },
    verifyArgs: ["--version"],
  },
};

/** Resolve a tool without downloading (PATH/caller/cache only). Null when absent. */
export function resolveToolPath(
  name: string,
  opts: ToolRegistryOptions,
): string | null {
  const explicit = mergeToolPaths(opts.toolPaths)[name];
  if (explicit && existsSync(explicit)) return explicit;
  const def = TOOLS[name];
  const onPath = def ? findOnPathAll(def) : findOnPath(name);
  if (onPath) return onPath;
  const cached = downloadedPath(opts.cacheDir, name);
  if (existsSync(cached)) return cached;
  return null;
}
