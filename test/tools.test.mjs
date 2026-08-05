import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function loadSubject() {
  return import("../src/tools.ts");
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-tools-"));
  return { cacheDir: join(base, "cache"), configDir: join(base, "config"), base };
}

/** Build a tiny fake tool tarball (bin/<name> script). */
function makeToolTarball(name, script) {
  const work = mkdtempSync(join(tmpdir(), "st-mk-"));
  const pkg = join(work, "pkg-1.0.0");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  const bin = join(pkg, "bin", name);
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
  execFileSync("tar", ["-czf", join(work, `${name}.tar.gz`), "-C", work, "pkg-1.0.0"]);
  return join(work, `${name}.tar.gz`);
}

test("findOnPath resolves tools already on the system PATH", async () => {
  const { findOnPath } = await loadSubject();
  assert.ok(findOnPath("sh"), "sh should exist on PATH");
  assert.equal(findOnPath("definitely-not-a-real-tool-xyz123"), null);
});

test("resolution precedence: toolPaths > PATH > cache", async () => {
  const { resolveToolPath } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    // fake PATH binary
    const fakeDir = join(base, "fakebin");
    mkdirSync(fakeDir);
    const fake = join(fakeDir, "fake-tool");
    writeFileSync(fake, "#!/bin/sh\necho hi\n", "utf8");
    chmodSync(fake, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${oldPath}`;

    assert.equal(resolveToolPath("fake-tool", { cacheDir }), fake, "PATH hit");

    // explicit toolPaths wins over PATH
    const explicit = join(base, "explicit-tool");
    writeFileSync(explicit, "#!/bin/sh\n", "utf8");
    chmodSync(explicit, 0o755);
    assert.equal(
      resolveToolPath("fake-tool", { cacheDir, toolPaths: { "fake-tool": explicit } }),
      explicit,
      "toolPaths beats PATH",
    );

    // cache wins over nothing (no PATH, no explicit)
    const cached = join(cacheDir, "bin", "cached-tool");
    mkdirSync(join(cacheDir, "bin"), { recursive: true });
    writeFileSync(cached, "#!/bin/sh\n", "utf8");
    assert.equal(resolveToolPath("cached-tool", { cacheDir }), cached, "cache hit");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("auto-download: official source, cached on second call", { timeout: 30_000 }, async () => {
  const { ensureTool } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const tarball = makeToolTarball("mini-tool", "#!/bin/sh\necho ok\n");
  const file = require("node:fs").readFileSync(tarball);

  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(file);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    const def = {
      name: "mini-tool",
      platforms: [process.platform],
      download: { official: `http://127.0.0.1:${port}/mini.tar.gz`, kind: "tar.gz", binPath: "mini-tool" },
    };
    const first = await ensureTool(def, { cacheDir });
    assert.ok(existsSync(first), "tool should be installed");
    assert.equal(execFileSync(first, [], { encoding: "utf8" }).trim(), "ok");

    // cached: second call must not hit the server again
    let hits = 0;
    server.on("request", () => hits++);
    const second = await ensureTool(def, { cacheDir });
    assert.equal(second, first);
    assert.equal(hits, 0, "no re-download when cached");
  } finally {
    server.close();
    server.closeAllConnections?.();
    rmSync(base, { recursive: true, force: true });
  }
});

test("mirror fallback: official 404 → mirror succeeds", { timeout: 30_000 }, async () => {
  const { ensureTool } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const tarball = makeToolTarball("mirror-tool", "#!/bin/sh\necho mirror\n");
  const file = require("node:fs").readFileSync(tarball);

  // server A: official (404); server B: mirror (200)
  const mirrorServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(file);
  });
  const deadServer = createServer((req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise((r) => deadServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => mirrorServer.listen(0, "127.0.0.1", r));
  const deadPort = deadServer.address().port;
  const mirrorPort = mirrorServer.address().port;

  try {
    const def = {
      name: "mirror-tool",
      platforms: [process.platform],
      download: {
        official: `http://127.0.0.1:${deadPort}/mirror.tar.gz`, // always 404
        kind: "tar.gz",
        binPath: "mirror-tool",
      },
    };
    // mirror configured as a full URL template (no {official} placeholder)
    const installed = await ensureTool(def, {
      cacheDir,
      toolMirrors: { default: [`http://127.0.0.1:${mirrorPort}/mirror.tar.gz`] },
    });
    assert.ok(existsSync(installed));
    assert.equal(execFileSync(installed, [], { encoding: "utf8" }).trim(), "mirror");
  } finally {
    deadServer.close();
    mirrorServer.close();
    deadServer.closeAllConnections?.();
    mirrorServer.closeAllConnections?.();
    rmSync(base, { recursive: true, force: true });
  }
});

test("preferMirrors downloads from mirror first", { timeout: 30_000 }, async () => {
  const { ensureTool } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const tarball = makeToolTarball("pref-tool", "#!/bin/sh\necho pref\n");
  const file = require("node:fs").readFileSync(tarball);

  let mirrorHits = 0;
  let officialHits = 0;
  const mirrorServer = createServer((req, res) => {
    mirrorHits++;
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(file);
  });
  const officialServer = createServer((req, res) => {
    officialHits++;
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(file);
  });
  await new Promise((r) => mirrorServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => officialServer.listen(0, "127.0.0.1", r));
  const mirrorPort = mirrorServer.address().port;
  const officialPort = officialServer.address().port;

  try {
    const def = {
      name: "pref-tool",
      platforms: [process.platform],
      download: { official: `http://127.0.0.1:${officialPort}/p.tar.gz`, kind: "tar.gz", binPath: "pref-tool" },
    };
    await ensureTool(def, {
      cacheDir,
      preferMirrors: true,
      toolMirrors: { default: [`http://127.0.0.1:${mirrorPort}/p.tar.gz`] },
    });
    // justget 竞速：主源=镜像（probe HEAD + GET），官方作为镜像列表不启动
    // justget racing: primary=mirror (HEAD probe + GET); official not started
    assert.ok(mirrorHits >= 1, "mirror should be used first");
    assert.equal(officialHits, 0, "official should be skipped when mirror works");
  } finally {
    mirrorServer.close();
    officialServer.close();
    mirrorServer.closeAllConnections?.();
    officialServer.closeAllConnections?.();
    rmSync(base, { recursive: true, force: true });
  }
});

test("unsupported platform gives a helpful error", async () => {
  const { ensureTool } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    const def = {
      name: "win-only-tool",
      platforms: ["win32"],
      download: { official: "https://example.com/x.tar.gz", kind: "tar.gz" },
    };
    if (process.platform === "win32") return; // skip on the one platform it supports
    await assert.rejects(
      ensureTool(def, { cacheDir }),
      /no .* build|WSL2|Docker/,
      "should explain missing platform build",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── Windows 支持（zip 包、{ext}/{exe} URL 模板、.exe 匹配）────────────────────

test("candidateUrls expands {ext} to zip on win32 and tgz elsewhere", async () => {
  const { candidateUrls } = await loadSubject();
  const def = {
    name: "frpc",
    version: "0.61.1",
    platforms: ["linux", "darwin", "win32"],
    download: {
      official: "https://github.com/fatedier/frp/releases/download/v{version}/frp_{version}_{platform}_{arch}.{ext}",
      mirrors: [],
      kind: "tar.gz",
    },
  };
  const urls = candidateUrls(def, { cacheDir: "/tmp/x" });
  const official = urls.find((u) => u.label === "official");
  const expectedExt = process.platform === "win32" ? "zip" : "tgz";
  assert.ok(
    official.url.endsWith(`.${expectedExt}`),
    `expected .${expectedExt}, got ${official.url}`,
  );
  assert.ok(official.url.includes("0.61.1"), "version substituted");
});

test("extractArchive handles a zip archive (Windows-style packaging)", async () => {
  const { extractArchive } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const work = mkdtempSync(join(tmpdir(), "st-zip-"));
  try {
    // build a zip with pkg-1.0.0/bin/ztool
    const pkg = join(work, "pkg-1.0.0", "bin");
    mkdirSync(pkg, { recursive: true });
    const script = join(pkg, process.platform === "win32" ? "ztool.exe" : "ztool");
    writeFileSync(script, "#!/bin/sh\necho z\n", "utf8");
    chmodSync(script, 0o755);
    const zipPath = join(work, "ztool.zip");
    // zip via python (portable); bsdtar can also create but python is reliable
    execFileSync("python3", ["-c", `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)
z.write(sys.argv[2], arcname="pkg-1.0.0/bin/" + sys.argv[3])
z.close()`, zipPath, script, process.platform === "win32" ? "ztool.exe" : "ztool"], { stdio: "ignore" });

    const def = {
      name: "ztool",
      platforms: ["linux", "darwin", "win32"],
      download: { official: "x.{ext}", kind: "tar.gz", binPath: "ztool", strip: 1 },
    };
    const dest = await extractArchive(zipPath, def, join(cacheDir, "bin"));
    assert.ok(existsSync(dest), "extracted binary exists");
    assert.equal(execFileSync(dest, [], { encoding: "utf8" }).trim(), "z");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("full flow: official .zip via {ext} template downloads and verifies", { timeout: 30_000 }, async () => {
  const { ensureTool } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const work = mkdtempSync(join(tmpdir(), "st-zip2-"));
  try {
    const pkg = join(work, "pkg-1.0.0", "bin");
    mkdirSync(pkg, { recursive: true });
    const script = join(pkg, "ztool2");
    writeFileSync(script, "#!/bin/sh\necho z2\n", "utf8");
    chmodSync(script, 0o755);
    const zipPath = join(work, "ztool2.zip");
    execFileSync("python3", ["-c", `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)
z.write(sys.argv[2], arcname="pkg-1.0.0/bin/ztool2")
z.close()`, zipPath, script], { stdio: "ignore" });
    const file = require("node:fs").readFileSync(zipPath);

    let gotPath = "";
    const server = createServer((req, res) => {
      gotPath = req.url;
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(file);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const def = {
      name: "ztool2",
      version: "1.0",
      platforms: ["linux", "darwin", "win32"],
      download: { official: `http://127.0.0.1:${port}/z-{version}.{ext}`, kind: "tar.gz", binPath: "ztool2" },
    };
    const installed = await ensureTool(def, { cacheDir });
    // POSIX 上 {ext}=tgz 但服务器返回 zip —— ensureTool 按 kind 处理；
    // 这里验证 URL 模板展开与可执行文件可跑。
    assert.equal(gotPath, "/z-1.0.tgz");
    assert.equal(execFileSync(installed, [], { encoding: "utf8" }).trim(), "z2");
  } finally {
    try {
      server.close();
      server.closeAllConnections?.();
    } catch {
      // already closed
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("Gitee-style full URL template mirrors expand placeholders", async () => {
  const { candidateUrls } = await loadSubject();
  const def = {
    name: "frpc",
    version: "0.61.1",
    platforms: ["linux", "darwin", "win32"],
    download: {
      official: "https://github.com/fatedier/frp/releases/download/v{version}/frp_{version}_{platform}_{arch}.{ext}",
      kind: "tar.gz",
    },
  };
  const urls = candidateUrls(def, {
    cacheDir: "/tmp/x",
    toolMirrors: {
      frpc: ["https://gitee.com/justdb-mirrors/frp/releases/download/v{version}/frp_{version}_{platform}_{arch}.{ext}"],
    },
  });
  const mirror = urls.find((u) => u.label === "mirror#1");
  const expectedExt = process.platform === "win32" ? "zip" : "tgz";
  assert.ok(
    mirror.url.startsWith("https://gitee.com/justdb-mirrors/frp/releases/download/v0.61.1/"),
    `gitee template: ${mirror.url}`,
  );
  assert.ok(mirror.url.endsWith(`.${expectedExt}`), `ext: ${mirror.url}`);
  assert.ok(!mirror.url.includes("{"), "all placeholders filled");
  // ghproxy prefix form still works
  const urls2 = candidateUrls(def, { cacheDir: "/tmp/x", toolMirrors: { frpc: ["https://mirror.ghproxy.com/{official}"] } });
  const gh = urls2.find((u) => u.label === "mirror#1");
  assert.ok(gh.url.startsWith("https://mirror.ghproxy.com/https://github.com/"), gh.url);
  // bare prefix form appends
  const urls3 = candidateUrls(def, { cacheDir: "/tmp/x", toolMirrors: { frpc: ["https://cdn.example.com/"] } });
  const bare = urls3.find((u) => u.label === "mirror#1");
  assert.ok(bare.url.startsWith("https://cdn.example.com/https://github.com/"), bare.url);
});

test("env SERVICE_TUNNELS_TOOLPATHS + mergeToolPaths", async () => {
  const { readEnvToolPaths, mergeToolPaths, resolveToolPath, TOOLS, ensureTool } = await import("../src/tools.ts");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "st-tools-env-"));
  const fake = join(dir, "fake-tool");
  writeFileSync(fake, "#!/bin/sh\necho ok\n", "utf8");
  chmodSync(fake, 0o755);

  // env-only
  process.env.SERVICE_TUNNELS_TOOLPATHS = JSON.stringify({ fakeTool: fake });
  const merged = mergeToolPaths(undefined);
  assert.equal(merged.fakeTool, fake);
  // explicit overrides env
  const merged2 = mergeToolPaths({ fakeTool: "/other" });
  assert.equal(merged2.fakeTool, "/other");
  // malformed env ignored
  process.env.SERVICE_TUNNELS_TOOLPATHS = "not-json";
  assert.deepEqual(readEnvToolPaths(), {});

  // resolveToolPath honors env (fakeTool in TOOLS? add minimal check with a real tool name)
  const { ToolDef } = await import("../src/tools.ts");
  const def = { name: "cloudflared", candidateUrls: [fake], fileName: "cloudflared", version: "0", archive: "plain" };
  process.env.SERVICE_TUNNELS_TOOLPATHS = JSON.stringify({ cloudflared: fake });
  const resolved = resolveToolPath("cloudflared", { cacheDir: dir });
  assert.equal(resolved, fake);
  const ensured = await ensureTool(def, { cacheDir: dir });
  assert.equal(ensured, fake);
  delete process.env.SERVICE_TUNNELS_TOOLPATHS;
});

test("ensureNpmTool finds bin via commands[] alias (localtunnel → lt)", { timeout: 120_000 }, async () => {
  // Regression for "npm install produced no bin": the localtunnel npm package
  // ships a `lt` bin, not `localtunnel`. ensureNpmTool must consult
  // def.commands, not just def.name, when locating the installed binary.
  const { ensureTool, TOOLS } = await import("../src/tools.ts");
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cacheDir = mkdtempSync(join(tmpdir(), "st-npm-lt-"));
  // Scrub PATH so `lt`/`localtunnel` are not found via PATH — forces the
  // ensureNpmTool download branch (otherwise step 2 short-circuits on a PATH
  // `lt` and the buggy bin lookup is never exercised).
  const origPath = process.env.PATH;
  process.env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  try {
    const def = TOOLS.localtunnel;
    const installed = await ensureTool(def, { cacheDir });
    assert.ok(installed, "ensureTool must return a path");
    assert.ok(existsSync(installed), "installed bin must exist on disk");
    // The linked dest is named after def.name, but it must point at the real
    // `lt` bin that npm created (not a missing `localtunnel` one).
    const ltBin = join(cacheDir, "npm", "node_modules", ".bin", "lt");
    assert.ok(existsSync(ltBin), "npm must have produced a `lt` bin");
    const localtunnelBin = join(cacheDir, "npm", "node_modules", ".bin", "localtunnel");
    assert.ok(!existsSync(localtunnelBin), "sanity: localtunnel pkg ships no `localtunnel` bin");
  } finally {
    process.env.PATH = origPath;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("localtunnel resolves via `lt` command alias on PATH", async () => {
  const { resolveToolPath, TOOLS } = await import("../src/tools.ts");
  // PATH has `lt` (npm bin) but not `localtunnel` — alias must hit
  const origPath = process.env.PATH;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "st-lt-"));
  const { writeFileSync, chmodSync } = await import("node:fs");
  const fake = join(dir, "lt");
  writeFileSync(fake, "#!/bin/sh\necho lt\n", "utf8");
  chmodSync(fake, 0o755);
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  try {
    const p = resolveToolPath("localtunnel", { cacheDir: dir });
    assert.equal(p, fake, "must resolve via the lt alias without downloading");
  } finally {
    process.env.PATH = origPath;
  }
});
