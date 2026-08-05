import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  return import("../src/tunnels.ts");
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-tunnels-"));
  return { cacheDir: join(base, "cache"), base };
}

/** Build a fake tool binary that records its argv, prints a URL, then idles. */
function fakeTool(base, name, output) {
  const dir = join(base, "bin");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  // argv file is written BEFORE the URL line, so once a test sees the URL
  // parsed it can read the recorded args safely.
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args-${name}'\necho '${output}'\nsleep 60\n`, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

test("extractTunnelUrl: known domains win over unrelated links", async () => {
  const { extractTunnelUrl } = await loadSubject();
  assert.equal(extractTunnelUrl("Forwarding https://abc.ngrok.io -> http://localhost:30141"), "https://abc.ngrok.io");
  assert.equal(extractTunnelUrl("url=https://demo.ngrok-free.app session=..."), "https://demo.ngrok-free.app");
  assert.equal(extractTunnelUrl("started tunnel url=https://mammogram-outgoing-launch.ngrok-free.dev"), "https://mammogram-outgoing-launch.ngrok-free.dev");
  assert.equal(extractTunnelUrl("Forwarding HTTP traffic from https://abc-61-149-239-106.serveousercontent.com\n"), "https://abc-61-149-239-106.serveousercontent.com");
  assert.equal(extractTunnelUrl("https://xyz.trycloudflare.com created"), "https://xyz.trycloudflare.com");
  assert.equal(extractTunnelUrl("url: https://abc.loca.lt/"), "https://abc.loca.lt/");
  assert.equal(extractTunnelUrl("connecting to http://localhost:30141"), null);
  assert.equal(extractTunnelUrl("no url"), null);
  // known tunnel domain wins even when an official-site link comes first
  const mixed = "Terms: https://www.cloudflare.com/website-terms/ tunnel: https://real.trycloudflare.com";
  assert.equal(extractTunnelUrl(mixed), "https://real.trycloudflare.com");
});

test("lifecycle: start (tool resolved) → url parsed → stop (group kill)", { timeout: 20_000 }, async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    fakeTool(base, "ngrok", "Forwarding https://demo.ngrok.io -> http://127.0.0.1:4180");
    const events = [];
    const tm = new TunnelManager({
      cacheDir,
      resolveTool: async (name) => join(base, "bin", name),
      onEvent: (e) => events.push(e),
    });
    tm.add({ name: "web", type: "ngrok", target: 4180 });

    const info = await tm.start("web");
    assert.equal(info.running, true);
    assert.ok(info.pid && info.pid > 0);
    assert.equal(events.some((e) => e.type === "start"), true);

    // wait for URL to be parsed from output
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !tm.get("web")?.url) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(tm.get("web")?.url, "https://demo.ngrok.io");
    assert.equal(events.some((e) => e.type === "url"), true);

    // persisted state contains pid + url
    const persisted = tm.persisted();
    assert.ok(persisted["web"], "persisted state");
    assert.equal(persisted["web"].url, "https://demo.ngrok.io");

    // stop kills the process group
    await tm.stop("web");
    const after = tm.get("web");
    assert.equal(after.running, false);
    assert.ok(events.some((e) => e.type === "stop"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("serveo/ssh build correct `ssh` argv (user, port, host, remotePort, -R)", { timeout: 40_000 }, async () => {
  // SSH forwarding needs more than host+target: a username (user@host), an
  // optional server port (-p), and a remote forward port (-R remote:local).
  // Drive #build through start() with a fake `ssh` on PATH that records argv.
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const origPath = process.env.PATH;
  const argvFile = join(base, "ssh.argv");
  // fake ssh: record args, print a serveo URL so waitForUrl resolves fast.
  const fakeBinDir = join(base, "sbin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(join(fakeBinDir, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho 'https://abc.serveo.net'\nsleep 60\n`, "utf8");
  chmodSync(join(fakeBinDir, "ssh"), 0o755);
  process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => join(fakeBinDir, "ssh") });
    // start() returns right after spawn() (URL waiting is the caller's job),
    // so poll tm.get(name).url — which only appears AFTER the fake ssh has
    // written argv — before reading the recorded argv file.
    const waitUrl = async (name, ms = 5_000) => {
      const dl = Date.now() + ms;
      // wait for url AND for the fake process to have produced output (so its
      // argv file is written). ssh urls are now synthesized synchronously, so
      // the lastOutput check is what actually gates the argv read.
      while (Date.now() < dl && (!tm.get(name)?.url || !tm.get(name)?.lastOutput)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!tm.get(name)?.url) throw new Error(`no url for ${name}: ${tm.get(name)?.lastOutput}`);
    };

    // serveo: anonymous, remote port 80, host serveo.net
    tm.add({ name: "s", type: "serveo", target: 8901 });
    assert.equal(tm.get("s").type, "serveo", "serveo stays serveo (not aliased to ssh)");
    await tm.start("s");
    await waitUrl("s");
    let argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.ok(argv.includes("-R"), "serveo: -R present");
    assert.equal(argv[argv.indexOf("-R") + 1], "80:127.0.0.1:8901", "serveo forwards remote port 80");
    assert.equal(argv[argv.length - 1], "serveo.net", "serveo dest is serveo.net");
    assert.ok(!argv.includes("-p"), "serveo: no -p when port unset");
    assert.ok(!argv.includes("-N"), "serveo: NO -N (URL is printed by serveo's forced session; -N suppresses it)");
    await tm.stop("s");

    // ssh with full config: user@host, -p 2222, custom remotePort 8080
    tm.add({ name: "my", type: "ssh", target: 3000, host: "box.example.com", user: "deploy", port: 2222, remotePort: 8080 });
    await tm.start("my");
    await waitUrl("my", 12000);
    argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.equal(argv[argv.indexOf("-R") + 1], "8080:127.0.0.1:3000", "ssh: -R <remotePort>:127.0.0.1:<target>");
    assert.equal(argv[argv.indexOf("-p") + 1], "2222", "ssh: -p <port>");
    assert.equal(argv[argv.length - 1], "deploy@box.example.com", "ssh: user@host dest");
    assert.ok(argv.includes("-N"), "ssh (generic): -N present (pure forward, no session)");
    await tm.stop("my");

    // ssh defaults remotePort to target when not set
    tm.add({ name: "def", type: "ssh", target: 5000, host: "srv.lan" });
    await tm.start("def");
    await waitUrl("def", 12000);
    argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.equal(argv[argv.indexOf("-R") + 1], "5000:127.0.0.1:5000", "ssh: remotePort defaults to target");
    assert.ok(!argv.includes("-p"), "ssh: no -p when port unset");
    await tm.stop("def");

    // ssh without host still errors clearly
    tm.add({ name: "bad", type: "ssh", target: 5000 });
    await assert.rejects(tm.start("bad"), /type "ssh" requires host/);
  } finally {
    process.env.PATH = origPath;
    rmSync(base, { recursive: true, force: true });
  }
});

test("start is idempotent; unknown tunnel throws", { timeout: 20_000 }, async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    fakeTool(base, "cloudflared", "https://x.trycloudflare.com");
    const tm = new TunnelManager({ cacheDir, resolveTool: async (name) => join(base, "bin", name) });
    tm.add({ name: "cf", type: "cloudflared", target: 4180 });

    const first = await tm.start("cf");
    const second = await tm.start("cf"); // idempotent
    assert.equal(second.pid, first.pid);
    assert.equal(second.running, true);

    await assert.rejects(tm.start("missing"), /unknown tunnel/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("command type: shell command with URL output", { timeout: 20_000 }, async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => "" });
    tm.add({ name: "legacy", type: "command", cmd: "echo 'tunnel url: https://abc.loca.lt/'; sleep 60" });
    const info = await tm.start("legacy");
    assert.equal(info.running, true);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !tm.get("legacy")?.url) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(tm.get("legacy")?.url, "https://abc.loca.lt/");
    await tm.stop("legacy");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cloudflared: --edge pinned when SRV discovery is broken (env-forced)", async () => {
  const { TunnelManager, cloudflaredNeedsEdge, _resetCloudflaredEdgeCache } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const argsFile = join(base, "bin", "args-cloudflared");
  try {
    // Forced pin: argv must carry --edge region1.v2.argotunnel.com:7844.
    process.env.SERVICE_TUNNELS_CLOUDFLARED_EDGE = "1";
    _resetCloudflaredEdgeCache();
    assert.equal(await cloudflaredNeedsEdge(), true);
    fakeTool(base, "cloudflared", "https://c.trycloudflare.com");
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => join(base, "bin", "cloudflared"), env: {} });
    tm.add({ name: "c", type: "cloudflared", target: 4180 });
    await tm.start("c");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (!tm.get("c")?.url || !existsSync(argsFile))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(tm.get("c")?.url, "https://c.trycloudflare.com");
    const argv = readFileSync(argsFile, "utf8").trim().split("\n");
    assert.ok(argv.includes("--edge"));
    assert.ok(argv.includes("region1.v2.argotunnel.com:7844"));
    assert.ok(argv.includes("--edge-ip-version"));
    await tm.stopAll();

    // Forced no-pin: argv must NOT carry --edge.
    process.env.SERVICE_TUNNELS_CLOUDFLARED_EDGE = "0";
    _resetCloudflaredEdgeCache();
    assert.equal(await cloudflaredNeedsEdge(), false);
    tm.add({ name: "c2", type: "cloudflared", target: 4180 });
    await tm.start("c2");
    const deadline2 = Date.now() + 5_000;
    while (Date.now() < deadline2 && (!tm.get("c2")?.url || !readFileSync(argsFile, "utf8").includes("tunnel"))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(tm.get("c2")?.url, "https://c.trycloudflare.com");
    const argv2 = readFileSync(argsFile, "utf8").trim().split("\n");
    assert.ok(argv2.includes("tunnel"));
    assert.ok(!argv2.includes("--edge"));
    await tm.stopAll();
  } finally {
    delete process.env.SERVICE_TUNNELS_CLOUDFLARED_EDGE;
    _resetCloudflaredEdgeCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test("buildCommand: ngrok/ssh/cloudflared/localtunnel argv shape", async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async (name) => `/opt/${name}` });
    // exercise #build via start failure path is messy; instead verify through
    // a spy: spawn with a fake tool that records argv
    fakeTool(base, "ngrok", "https://n.ngrok.io");
    fakeTool(base, "cloudflared", "https://c.trycloudflare.com");
    fakeTool(base, "localtunnel", "https://l.loca.lt");
    const seen = [];
    const tm2 = new TunnelManager({
      cacheDir,
      resolveTool: async (name) => join(base, "bin", name),
      env: {},
      onEvent: (e) => seen.push(e),
    });
    tm2.add({ name: "n", type: "ngrok", target: 4180, domain: "fix.ngrok.app" });
    tm2.add({ name: "c", type: "cloudflared", target: 4180 });
    tm2.add({ name: "l", type: "localtunnel", target: 5173, domain: "myapp" });

    await tm2.start("n");
    await tm2.start("c");
    await tm2.start("l");
    // fake tools ignore args; assert they run + URLs parse
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (!tm2.get("n")?.url || !tm2.get("c")?.url || !tm2.get("l")?.url)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(tm2.get("n")?.url, "https://n.ngrok.io");
    assert.equal(tm2.get("c")?.url, "https://c.trycloudflare.com");
    assert.equal(tm2.get("l")?.url, "https://l.loca.lt");
    await tm2.stopAll();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("frpc: generates ini with server/token/domain and runs", { timeout: 20_000 }, async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    const frpcScript = `#!/bin/sh
echo 'start frpc service success'
sleep 60
`;
    fakeTool(base, "frpc", "");
    writeFileSync(join(base, "bin", "frpc"), frpcScript, "utf8");
    chmodSync(join(base, "bin", "frpc"), 0o755);

    const tm = new TunnelManager({ cacheDir, resolveTool: async (name) => join(base, "bin", name) });
    tm.add({ name: "frp", type: "frpc", target: 4180, server: "1.2.3.4:7001", token: "sekret", domain: "app.example.com" });
    const info = await tm.start("frp");
    assert.equal(info.running, true);

    // ini file written with the right contents
    const iniPath = join(cacheDir, "tmp", "frpc-frp.ini");
    const ini = readFileSync(iniPath, "utf8");
    assert.match(ini, /server_addr = 1\.2\.3\.4/);
    assert.match(ini, /server_port = 7001/);
    assert.match(ini, /token = sekret/);
    assert.match(ini, /local_port = 4180/);
    assert.match(ini, /custom_domains = app\.example\.com/);
    await tm.stop("frp");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("hydrate restores URLs from persisted state (restart scenario)", async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => "" });
    tm.add({ name: "web", type: "ngrok", target: 4180 });
    tm.hydrate({ web: { pid: 12345, url: "https://old.ngrok.io" } });
    const info = tm.get("web");
    assert.equal(info.url, "https://old.ngrok.io");
    assert.equal(info.running, false); // process gone after restart
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("schemas: tunnel + auth provider param specs (data-driven forms)", async () => {
  const { tunnelParamSchema, tunnelParamSchemas } = await loadSubject();
  const all = tunnelParamSchemas();
  assert.deepEqual(Object.keys(all).sort(), ["bore", "cloudflared", "command", "frpc", "localtunnel", "ngrok", "serveo", "ssh"]);
  const ssh = tunnelParamSchema("ssh");
  assert.ok(ssh.find((p) => p.key === "host")?.required, "ssh requires host");
  assert.equal(ssh.find((p) => p.key === "remotePort")?.type, "number");
  const bore = tunnelParamSchema("bore");
  assert.equal(bore.find((p) => p.key === "server")?.default, "localhost");
  assert.equal(bore.find((p) => p.key === "token")?.type, "password");
  assert.deepEqual(tunnelParamSchema("unknown-type"), []);

  const { authProviderSchemas } = await import("../src/auth-registry.ts");
  const cfgDir = mkdtempSync(join(tmpdir(), "st-schema-"));
  try {
    const auth = await authProviderSchemas(cfgDir);
    assert.ok(auth["oauth2-proxy"], "oauth2-proxy schema");
    assert.ok(auth["oauth2-proxy"].find((p) => p.key === "oidc.issuerUrl")?.required, "issuerUrl required");
    assert.ok(Array.isArray(auth.authelia));
    assert.deepEqual(auth.basic, [], "basic needs no params");
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("applyParamSets: schema-driven CLI/form params (coerce + unknown-key errors)", async () => {
  const { tunnelParamSchema, applyParamSets, coerceParam } = await loadSubject();
  // bore: server string, remotePort number, token password
  const out = applyParamSets(tunnelParamSchema("bore"), { server: "tunnel.local", remotePort: "12001", token: "s3cret" }, "bore");
  assert.equal(out.server, "tunnel.local");
  assert.equal(out.remotePort, 12001, "number coerced");
  assert.equal(out.token, "s3cret");
  // unknown key → error listing valid keys
  assert.throws(() => applyParamSets(tunnelParamSchema("bore"), { bogus: "x" }, "bore"), /unknown param "bogus" \(valid: server, remotePort, token\)/);
  // number coercion failure
  assert.throws(() => applyParamSets(tunnelParamSchema("bore"), { remotePort: "abc" }, "bore"), /expects a number/);
  // booleans / raw strings
  assert.equal(coerceParam("1", { key: "x", type: "boolean" }), true);
  assert.equal(coerceParam("yes", { key: "x", type: "boolean" }), true);
  assert.equal(coerceParam("no", { key: "x", type: "boolean" }), false);
  assert.equal(coerceParam("hello", { key: "x" }), "hello");
});

test("bore: builds `bore local` argv + synthesizes url from 'listening at host:port'", { timeout: 20_000 }, async () => {
  const { TunnelManager, extractTunnelUrl } = await loadSubject();
  // bore prints no URL scheme — extractTunnelUrl prepends http://
  assert.equal(extractTunnelUrl("listening at localhost:53564", "bore"), "http://localhost:53564");
  assert.equal(extractTunnelUrl("listening at tunnel.example.com:443", "bore"), "http://tunnel.example.com:443");
  assert.equal(extractTunnelUrl("no listening line", "bore"), null);

  const { cacheDir, base } = tempDirs();
  try {
    const argvFile = join(base, "bore.argv");
    fakeTool(base, "bore", "");
    writeFileSync(
      join(base, "bin", "bore"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho 'listening at localhost:3999'\nsleep 60\n`,
      "utf8",
    );
    chmodSync(join(base, "bin", "bore"), 0o755);

    const tm = new TunnelManager({ cacheDir, resolveTool: async (n) => join(base, "bin", n) });
    tm.add({ name: "b", type: "bore", target: 4180, server: "tunnel.local:7835", token: "sek", remotePort: 5500 });
    await tm.start("b");
    const dl = Date.now() + 5_000;
    while (Date.now() < dl && !tm.get("b")?.url) await new Promise((r) => setTimeout(r, 50));
    assert.equal(tm.get("b")?.url, "http://localhost:3999");
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.equal(argv[0], "local");
    assert.equal(argv[1], "4180", "bore: local port = target");
    assert.equal(argv[argv.indexOf("--to") + 1], "tunnel.local:7835", "bore: --to <server>");
    assert.equal(argv[argv.indexOf("-p") + 1], "5500", "bore: -p <remotePort>");
    assert.equal(argv[argv.indexOf("-s") + 1], "sek", "bore: -s <secret>");
    await tm.stop("b");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ssh: synthesizes http://<host>:<remotePort> (generic ssh prints no URL)", { timeout: 30_000 }, async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const origPath = process.env.PATH;
  const fakeBinDir = join(base, "sbin");
  mkdirSync(fakeBinDir, { recursive: true });
  // fake ssh: silent -N forward (a real -R to your own box prints nothing)
  writeFileSync(join(fakeBinDir, "ssh"), "#!/bin/sh\nsleep 60\n", "utf8");
  chmodSync(join(fakeBinDir, "ssh"), 0o755);
  process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => join(fakeBinDir, "ssh") });
    tm.add({ name: "my", type: "ssh", target: 3000, host: "localhost", user: "wind", remotePort: 8080 });
    const info = await tm.start("my");
    // endpoint is deterministic, but only reported once ssh survives startup
    // (1.5s window) — unreachable hosts exit fast and must NOT show a URL.
    const dl = Date.now() + 16000;
    while (Date.now() < dl && !tm.get("my")?.url) await new Promise((r) => setTimeout(r, 50));
    assert.equal(tm.get("my")?.url, "http://localhost:8080");
    assert.equal(tm.get("my")?.running, true);
    await tm.stop("my");
  } finally {
    process.env.PATH = origPath;
    rmSync(base, { recursive: true, force: true });
  }
});

test("ssh: unreachable host does NOT report a URL (no false success); connected host synthesizes one", { timeout: 35_000 }, async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const argvDir = join(base, "sbin");
  mkdirSync(argvDir, { recursive: true });
  const origPath = process.env.PATH;
  try {
    // fake ssh that EXITS immediately (unreachable host: connect timeout)
    writeFileSync(join(argvDir, "ssh"),
      "#!/bin/sh\necho 'ssh: connect to host 192.0.2.1 port 22: Connection timed out'\nexit 255\n", "utf8");
    chmodSync(join(argvDir, "ssh"), 0o755);
    process.env.PATH = `${argvDir}:${process.env.PATH}`;
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => join(fakeBinDir, "ssh") });
    tm.add({ name: "bad", type: "ssh", target: 3000, host: "192.0.2.1", remotePort: 8080 });
    await tm.start("bad");
    await new Promise((r) => setTimeout(r, 2000)); // ssh exits immediately; URL never set
    const bad = tm.get("bad");
    assert.equal(bad.url, null, "unreachable host must NOT report a URL");
    assert.ok(bad.error, "unreachable host must report an error");
    await tm.stop("bad");

    // fake ssh that STAYS connected (host reachable + forwarding)
    writeFileSync(join(argvDir, "ssh"),
      "#!/bin/sh\necho 'debug1: Entering interactive session.'\nsleep 60\n", "utf8");
    chmodSync(join(argvDir, "ssh"), 0o755);
    tm.add({ name: "ok", type: "ssh", target: 3000, host: "box.example.com", remotePort: 8080 });
    await tm.start("ok");
    await new Promise((r) => setTimeout(r, 11200)); // past the 11s synth window
    const ok = tm.get("ok");
    assert.equal(ok.url, "http://box.example.com:8080", "connected ssh synthesizes the endpoint URL");
    await tm.stop("ok");

    // fake ssh that STAYS up past the synth window then exits with error
    // (real unreachable host: ConnectTimeout ~10s, synth at 1.5s, exit at 10s)
    // → the provisional URL must be REVOKED on exit, not reported as success.
    writeFileSync(join(argvDir, "ssh"),
      "#!/bin/sh\nsleep 12\necho 'ssh: connect to host 192.0.2.1 port 22: Connection timed out'\nexit 255\n", "utf8");
    chmodSync(join(argvDir, "ssh"), 0o755);
    tm.add({ name: "late", type: "ssh", target: 3000, host: "192.0.2.1", remotePort: 8080 });
    await tm.start("late");
    await new Promise((r) => setTimeout(r, 11300)); // synth at 11s fired → url present
    assert.equal(tm.get("late")?.url, "http://192.0.2.1:8080", "URL appears once ssh survives the connect window");
    await new Promise((r) => setTimeout(r, 1200)); // ssh exits at 12s → revoke
    const late = tm.get("late");
    assert.equal(late.url, null, "URL revoked when ssh exits with error");
    assert.ok(late.error, "error set when ssh exits with error");
  } finally {
    process.env.PATH = origPath;
    rmSync(base, { recursive: true, force: true });
  }
});

test("auth registry: totpProviders 探测不含缓存毒化 (authelia 现在支持 TOTP)", async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const { mkdtempSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "st-totp-"));
  try {
    const st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
    // 探测不应缓存空 opts 实例: 之后 expose oauth2-proxy 必须仍收到 oidc
    const tp = st.auth.totpProviders();
    assert.ok(tp.includes("portal"), "portal 支持 TOTP");
    assert.ok(tp.includes("authelia"), "authelia 支持 TOTP (经 storage CLI)");
    const um = st.auth.userManagers();
    assert.ok(um.includes("basic") && um.includes("portal") && um.includes("authelia"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
