import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  statSync,
  rmSync,
} from "fs";
import { execFileSync } from "child_process";
import { platform, arch, tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";

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

export interface DownloadSpec {
  /** Official URL template: {version} {platform} {arch} are substituted. */
  official: string;
  /** China-mirror templates. "{official}" expands to the official URL
   *  (ghproxy-style prefixing) — or a plain template as well. */
  mirrors?: string[];
  kind: ToolKind;
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
}

export interface ToolRegistryOptions {
  cacheDir: string;
  /** Caller-specified explicit paths: { toolName: "/abs/path" }. */
  toolPaths?: Record<string, string>;
  /** Per-tool mirror override: { toolName: ["https://..."], default: [...] }. */
  toolMirrors?: Record<string, string[]>;
  /** Force mirrors first (CN networks). */
  preferMirrors?: boolean;
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
function candidateUrls(
  def: ToolDef,
  opts: ToolRegistryOptions,
): Array<{ url: string; kind: ToolKind; label: string }> {
  const spec = def.download;
  const fill = (t: string) =>
    t
      .replaceAll("{version}", def.version ?? "")
      .replaceAll("{platform}", platform())
      .replaceAll("{arch}", arch());

  const configured = opts.toolMirrors?.[def.name] ?? opts.toolMirrors?.default;
  const mirrors = configured ?? spec.mirrors ?? [];

  const official = { url: fill(spec.official), kind: spec.kind, label: "official" };
  const mirrorUrls = mirrors.map((m, i) => ({
    url: fill(m.includes("{official}") ? m : m.endsWith("/") ? `${m}${spec.official}` : `${m}/${spec.official}`),
    kind: spec.kind,
    label: `mirror#${i + 1}`,
  }));

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

function downloadedPath(cacheDir: string, name: string): string {
  return join(cacheDir, "bin", name);
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
      void pump();
    });
    // atomic rename on success
    await import("fs").then((fs) => fs.promises.rename(tmp, dest));
  } finally {
    clearTimeout(timer);
  }
}

async function extractArchive(
  archive: string,
  def: ToolDef,
  destDir: string,
): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const strip = def.download.strip ?? 1;
  const work = mkdtempSync(join(tmpdir(), "st-tool-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", work, `--strip-components=${strip}`], { stdio: "ignore" });
    const binName = def.download.binPath ?? def.name;
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
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (entry === binName || entry.startsWith(`${binName}.`)) candidates.push(full);
        if (st.isDirectory()) walk(full);
      }
    };
    walk(work);
    const hit = candidates.sort((a, b) => a.length - b.length)[0];
    if (!hit) throw new ToolError(`cannot locate ${binName} inside ${archive}`);
    const dest = join(destDir, def.name);
    execFileSync("cp", [hit, dest], { stdio: "ignore" });
    chmodSync(dest, 0o755);
    return dest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Ensure a tool is available locally: PATH > cached > download. Returns path. */
export async function ensureTool(
  def: ToolDef,
  opts: ToolRegistryOptions,
): Promise<string> {
  // 1. caller-specified path
  const explicit = opts.toolPaths?.[def.name];
  if (explicit) {
    if (!existsSync(explicit)) throw new ToolError(`toolPaths.${def.name}=${explicit} does not exist`);
    return explicit;
  }
  // 2. system PATH
  const onPath = findOnPath(def.name);
  if (onPath) return onPath;
  // 3. cached download
  const cached = downloadedPath(opts.cacheDir, def.name);
  if (existsSync(cached)) return cached;
  // 4. auto-download
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

async function ensureDownloadedTool(def: ToolDef, opts: ToolRegistryOptions): Promise<string> {
  const dest = downloadedPath(opts.cacheDir, def.name);
  const urls = candidateUrls(def, opts);
  const timeoutMs = opts.downloadTimeoutMs ?? 60_000;
  let lastErr: Error | null = null;
  for (const cand of urls) {
  const archive = `${dest}.dl-${cand.label}`;
  console.error("[dbg] trying", cand.label, cand.url);
  try {
    await downloadTo(cand.url, archive, timeoutMs);
  } catch (err) {
    lastErr = err instanceof Error ? err : new Error(String(err));
    continue;
  }
  try {
    const final = await extractArchive(archive, def, join(opts.cacheDir, "bin"));
    console.error("[dbg] extracted to", final);
    rmSync(archive, { force: true });
    if (def.verifyArgs) {
      try {
        execFileSync(final, def.verifyArgs, { stdio: "ignore" });
      } catch {
        throw new ToolError(`${def.name} downloaded from ${cand.label} failed verification`);
      }
    }
    return final;
  } catch (err) {
    rmSync(archive, { force: true });
    rmSync(dest, { force: true });
    lastErr = err instanceof Error ? err : new Error(String(err));
  }
  }
  throw new ToolError(
    `${def.name}: all download sources failed — ${lastErr?.message}. ` +
      `Try installing it manually (apt install ${def.name}) or set toolPaths.${def.name}.`,
  );
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
  const bin = join(opts.cacheDir, "npm", "node_modules", ".bin", def.name);
  if (!existsSync(bin)) throw new ToolError(`${def.name}: npm install produced no bin`);
  // symlink into cacheDir/bin so resolution is uniform
  execFileSync("ln", ["-sf", bin, dest], { stdio: "ignore" });
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
      official: "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-{platform}-{arch}.tgz",
      // equinox.io has no GitHub mirror; operators can configure toolMirrors.ngrok
      kind: "tar.gz",
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
        "https://github.com/fatedier/frp/releases/download/v{version}/frp_{version}_{platform}_{arch}.tar.gz",
      mirrors: GH_MIRRORS,
      kind: "tar.gz",
      binPath: "frpc",
    },
    verifyArgs: ["-v"],
  },
  cloudflared: {
    name: "cloudflared",
    version: "latest",
    platforms: ["linux", "darwin", "win32"],
    download: {
      official: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-{platform}-{arch}",
      mirrors: GH_MIRRORS,
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
      mirrors: GH_MIRRORS,
      kind: "tar.gz",
      binPath: "authelia",
    },
    verifyArgs: ["--version"],
  },
  localtunnel: {
    name: "localtunnel",
    platforms: ["linux", "darwin", "win32"],
    download: { official: "", kind: "npm" },
    npmPackage: "localtunnel",
    npmRegistry: "https://registry.npmmirror.com",
  },
};

/** Resolve a tool without downloading (PATH/caller/cache only). Null when absent. */
export function resolveToolPath(
  name: string,
  opts: ToolRegistryOptions,
): string | null {
  const explicit = opts.toolPaths?.[name];
  if (explicit && existsSync(explicit)) return explicit;
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  const cached = downloadedPath(opts.cacheDir, name);
  if (existsSync(cached)) return cached;
  return null;
}
