// lib/binfetch.js - external bin acquisition chain (plan §3.7):
//   PATH probe -> local state cache (~/.svc-assistant/bin/) -> justget multi-source
//   download (checksum). Manifest: <assistant root>/bin-manifest.json:
//   { "<bin>": { "version", "url", "mirrors": [...], "sha256": "...", "cached": "bin/..." } }
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { runCapture } = require("./util");

// machine-persistent state cache: the packaged dist tree may be read-only
function binCacheDir() {
  return path.join(require("os").homedir(), ".svc-assistant", "bin");
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
  const shipped = (() => {
    const rel = (loadManifest(assistantRoot)[bin] || {}).cached;
    if (!rel) return null;
    const p = path.join(assistantRoot, rel);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { return null; }
  })();
  if (shipped) return shipped;
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

// Resolve a bin: PATH -> cache -> justget download. Returns absolute path or null.
// justget itself is invoked via npx (best-effort; the core stays zero-dependency).
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
  const urls = [manifest.url, ...(manifest.mirrors || [])].filter(Boolean);
  const cacheDir = binCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const dst = path.join(cacheDir, bin);
  for (const url of urls) {
    say("info", `justget downloading ${bin} from ${url}`);
    const r = await runCapture("npx", ["-y", "justget", url, "-o", dst], { timeoutMs: 120000 });
    if (r.code === 0 && fs.existsSync(dst)) {
      if (manifest.sha256) {
        const got = await sha256(dst);
        if (got !== manifest.sha256) {
          say("warn", `checksum mismatch for ${bin} (${got} != ${manifest.sha256}), trying next source`);
          try { fs.unlinkSync(dst); } catch (_) { /* ignore */ }
          continue;
        }
      }
      fs.chmodSync(dst, 0o755);
      say("ok", `bin "${bin}" cached at ${dst}`);
      return dst;
    }
  }
  say("err", `all sources failed for bin "${bin}"`);
  return null;
}

module.exports = { resolveBin, loadManifest, binCacheDir };
