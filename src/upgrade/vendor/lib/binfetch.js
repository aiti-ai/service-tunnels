// lib/binfetch.js - external bin acquisition chain (plan §3.7):
//   PATH probe -> state cache (~/.svc-assistant/bin/) -> manifest sources:
//     1. tarball  : npm-mirror tarball (npm.alot.pw - reachable on all machines)
//                   with an in-archive member extracted to the cache
//     2. justget  : multi-source racing downloader (China mirror + intelligent
//                   source switching + --checksum) for direct URLs
//   Every cached artifact is sha256-verified against the manifest before use.
// Manifest: <assistant root>/bin-manifest.json:
//   { "<bin>": { "version", "sha256", "cached"?: "bin/<file>",
//                "sources": [
//                  { "type": "tarball", "url", "member": "package/examples/nssm.exe" },
//                  { "type": "justget", "url", "mirrors"?: [..], "member"?: "win64/nssm.exe" } ] } }
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runCapture } = require("./util");

// machine-persistent state cache: the packaged dist tree may be read-only
function binCacheDir() {
  return path.join(os.homedir(), ".svc-assistant", "bin");
}

function loadManifest(assistantRoot) {
  const file = path.join(assistantRoot, "bin-manifest.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; }
}

async function which(bin) {
  // Windows has no `which` (and Git-bash's copy is unreliable across machines): use where.exe
  if (/^win/i.test(process.platform)) {
    const r = await runCapture("where.exe", [bin], { timeoutMs: 4000 });
    const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  }
  const r = await runCapture("which", [bin], { timeoutMs: 4000 });
  const p = r.stdout.trim().split("\n")[0];
  return p || null;
}

function cachedBin(bin, assistantRoot) {
  // manifest-declared cache name (e.g. bin/nssm.exe) ships inside assistantRoot
  const manifest = loadManifest(assistantRoot)[bin] || {};
  if (manifest.cached) {
    const p = path.join(assistantRoot, manifest.cached);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* not shipped */ }
  }
  const candidates = [path.join(binCacheDir(), bin)];
  if (/^win/i.test(process.platform)) candidates.push(path.join(binCacheDir(), `${bin}.exe`));
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
  }
  return null;
}

async function sha256(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", () => resolve(null));
  });
}

async function downloadFile(url, dst, timeoutMs = 180000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dst, buf);
  return buf.length;
}

/** Extract one member from a .tar.gz archive via the system tar (48 tar / win bsdtar / mac tar). */
async function extractTarMember(tgz, member, dst) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "binfetch-"));
  try {
    const r = await runCapture("tar", ["-xzf", tgz, "-C", tmpDir, member], { timeoutMs: 60000 });
    if (r.code !== 0) throw new Error(`tar extract failed: ${(r.stderr || "").trim().slice(0, 200)}`);
    fs.copyFileSync(path.join(tmpDir, member), dst);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/** Extract one member from a .zip via system unzip (posix) / Expand-Archive (win). */
async function extractZipMember(zip, member, dst) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "binfetch-"));
  try {
    if (/^win/i.test(process.platform)) {
      const r = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmpDir}' -Force`], { timeoutMs: 60000 });
      if (r.code !== 0) throw new Error(`Expand-Archive failed: ${(r.stderr || "").trim().slice(0, 200)}`);
    } else {
      const r = await runCapture("unzip", ["-o", zip, member, "-d", tmpDir], { timeoutMs: 60000 });
      if (r.code !== 0) throw new Error(`unzip failed: ${(r.stderr || "").trim().slice(0, 200)}`);
    }
    fs.copyFileSync(path.join(tmpDir, member), dst);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/** justget multi-source racing download (China mirror + intelligent switching). */
async function justgetDownload(url, mirrors, dst, checksum, log) {
  // resolve the justget binary: PATH first, then npx fallback
  const probe = await runCapture("which", ["justget"], { timeoutMs: 4000 });
  const hasLocal = probe.code === 0 && (probe.stdout || "").trim();
  const cmd = hasLocal ? "justget" : "npx";
  const args = hasLocal ? [] : ["-y", "justget"];
  args.push(url, ...(mirrors || []).flatMap((m) => ["-m", m]));
  if (checksum) args.push("--checksum", checksum);
  args.push("-o", dst);
  const r = await runCapture(cmd, args, { timeoutMs: 300000 });
  if (r.code !== 0 || !fs.existsSync(dst)) {
    throw new Error(`justget failed: ${((r.stderr || "") + (r.stdout || "")).trim().slice(0, 200)}`);
  }
  if (log) log("ok", `justget downloaded to ${dst}`);
  return dst;
}

async function acquireFromSources(assistantRoot, bin, manifest, dst, log) {
  const sources = manifest.sources ||
    [{ type: "url", url: manifest.url, member: manifest.member, mirrors: manifest.mirrors }];
  const errors = [];
  for (const s of sources) {
    try {
      const tmpArtifact = dst + ".download";
      if (s.type === "tarball") {
        const size = await downloadFile(s.url, tmpArtifact);
        if (log) log("info", `tarball source: ${s.url} (${size} bytes)`);
        await extractTarMember(tmpArtifact, s.member, dst);
        try { fs.unlinkSync(tmpArtifact); } catch (_) { /* ignore */ }
      } else if (s.type === "justget") {
        if (log) log("info", `justget source: ${s.url}${(s.mirrors || []).length ? ` (+${s.mirrors.length} mirrors)` : ""}`);
        await justgetDownload(s.url, s.mirrors, tmpArtifact, manifest.sha256, log);
        if (s.member) await extractZipMember(tmpArtifact, s.member, dst);
        try { fs.unlinkSync(tmpArtifact); } catch (_) { /* ignore */ }
      } else {
        throw new Error(`unknown source type: ${s.type}`);
      }
      if (manifest.sha256) {
        const got = await sha256(dst);
        if (got !== manifest.sha256) throw new Error(`checksum mismatch (${got} != ${manifest.sha256})`);
      }
      try { fs.chmodSync(dst, 0o755); } catch (_) { /* windows: no-op */ }
      if (log) log("ok", `bin "${bin}" cached at ${dst}`);
      return dst;
    } catch (e) {
      errors.push(`${s.type}: ${String(e.message || e).slice(0, 160)}`);
      if (log) log("warn", `source failed: ${String(e.message || e).slice(0, 160)}`);
      try { fs.rmSync(dst + ".download", { force: true }); } catch (_) { /* ignore */ }
    }
  }
  throw new Error(`all sources failed for "${bin}": ${errors.join(" | ")}`);
}

async function resolveBin(assistantRoot, bin, log) {
  const say = (level, msg) => { if (!log) return; if (typeof log === "function") log(level, msg); else log.log(level, msg); };
  const onPath = await which(bin);
  if (onPath) return onPath;
  const cached = cachedBin(bin, assistantRoot);
  if (cached) return cached;

  const manifest = loadManifest(assistantRoot)[bin];
  if (!manifest) {
    say("warn", `bin "${bin}" not on PATH, not cached, and not in bin-manifest.json`);
    return null;
  }
  const cacheDir = binCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const dst = path.join(cacheDir, bin) + (/^win/i.test(process.platform) ? ".exe" : "");
  try {
    return await acquireFromSources(assistantRoot, bin, manifest, dst, say);
  } catch (e) {
    say("err", String(e.message || e).slice(0, 300));
    return null;
  }
}

module.exports = { resolveBin, loadManifest, binCacheDir };
