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
    assert.equal(mirrorHits, 1, "mirror should be used first");
    assert.equal(officialHits, 0, "official should be skipped when mirror works");
  } finally {
    mirrorServer.close();
    officialServer.close();
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
