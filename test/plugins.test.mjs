import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadRegistry() {
  return import("../src/auth-registry.ts");
}
async function loadBasic() {
  return import("../src/providers/basic.ts");
}
async function loadGateway() {
  return import("../src/gateway.ts");
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-plugins-"));
  return { configDir: join(base, "config"), cacheDir: join(base, "cache"), base };
}

function providerCtx(configDir, cacheDir, overrides = {}) {
  return {
    configDir,
    cacheDir,
    resolveTool: async () => "/usr/bin/authelia",
    registerInternal: () => {},
    unregisterInternal: () => {},
    registerPid: () => {},
    pickPort: async () => 20001,
    log: () => {},
    ...overrides,
  };
}

test("AuthRegistry lists built-ins: authelia, basic, oauth2-proxy", async () => {
  const { AuthRegistry } = await loadRegistry();
  const { configDir, cacheDir, base } = tempDirs();
  try {
    const reg = new AuthRegistry(providerCtx(configDir, cacheDir));
    const providers = reg.list();
    assert.ok(providers.includes("authelia"));
    assert.ok(providers.includes("basic"));
    assert.ok(providers.includes("oauth2-proxy"));
    assert.ok(reg.has("basic"));
    assert.equal(reg.has("nope"), false);
    assert.throws(() => reg.create("nope"), /unknown auth provider/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("AuthRegistry: custom plugin factory via constructor + register()", async () => {
  const { AuthRegistry } = await loadRegistry();
  const { configDir, cacheDir, base } = tempDirs();
  try {
    const myFactory = () => ({
      type: "my-provider",
      capabilities: { localGateway: true, edgeAuth: false, randomDomain: true, multiHost: true, needsSessionStore: false },
      prepare: async () => ({ running: true }),
      start: async () => ({ running: true }),
      stop: async () => {},
      status: () => ({ running: true }),
      registerHost: async () => {},
      unregisterHost: async () => {},
      listHosts: async () => [],
    });
    const reg = new AuthRegistry(providerCtx(configDir, cacheDir), [myFactory]);
    assert.ok(reg.has("my-provider"));
    assert.ok(reg.list().includes("my-provider"));
    const p = reg.create("my-provider");
    assert.equal(p.type, "my-provider");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadProviderPlugins loads ESM factories from configDir/providers", async () => {
  const { loadProviderPlugins, AuthRegistry } = await loadRegistry();
  const { configDir, cacheDir, base } = tempDirs();
  try {
    const dir = join(configDir, "providers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "hello.js"),
      `export const factory = (ctx) => ({
        type: "hello",
        capabilities: { localGateway: true, edgeAuth: false, randomDomain: true, multiHost: true, needsSessionStore: false },
        prepare: async () => ({ running: true }),
        start: async () => ({ running: true }),
        stop: async () => {},
        status: () => ({ running: true }),
        registerHost: async () => {},
        unregisterHost: async () => {},
        listHosts: async () => [],
      });
      `,
      "utf8",
    );
    const plugins = await loadProviderPlugins(configDir);
    assert.equal(plugins.length, 1);
    const reg = new AuthRegistry(providerCtx(configDir, cacheDir));
    for (const f of plugins) reg.register(f);
    assert.ok(reg.has("hello"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("basic provider: htpasswd generation + nginx auth_basic config", { timeout: 30_000 }, async () => {
  const { BasicAuthProvider } = await loadBasic();
  const { generateGatewayNginx } = await loadGateway();
  const { configDir, cacheDir, base } = tempDirs();
  try {
    const p = new BasicAuthProvider(providerCtx(configDir, cacheDir), {
      user: { name: "alice", password: "pw123" },
    });
    const problems = await p.validate();
    assert.deepEqual(problems, []);
    await p.prepare();
    const htpasswd = readFileSync(join(cacheDir, "tmp", "basic", "htpasswd"), "utf8");
    assert.match(htpasswd, /^alice:/);
    // not a plaintext password
    assert.equal(htpasswd.includes("pw123"), false);

    // nginx config in basic mode has auth_basic and NO auth_request (in the
    // per-host conf.d file — generateHostNginx)
    const { generateHostNginx } = await loadGateway();
    const host = generateHostNginx(
      { host: "demo.ngrok-free.app", port: 5173, authMode: "basic", htpasswdFile: join(cacheDir, "tmp", "basic", "htpasswd") },
      { nginxPort: 4100, nginxRoot: join(cacheDir, "tmp", "nginx") },
    );
    assert.match(host, /auth_basic "service-tunnels"/);
    assert.match(host, /auth_basic_user_file/);
    assert.equal(host.includes("auth_request"), false, "basic mode must not use auth_request");

    // default (forward-auth) mode still has auth_request
    const host2 = generateHostNginx(
      { host: "demo.ngrok-free.app", port: 5173, authMode: "forward-auth", authPort: 9091, basePath: "/authelia" },
      { nginxPort: 4100, nginxRoot: join(cacheDir, "tmp", "nginx") },
    );
    assert.match(host2, /auth_request \/authelia\/api\/authz\/auth-request/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("expose --auth basic end-to-end with real nginx", { timeout: 40_000 }, async () => {
  const { expose } = await import("../src/expose.ts");
  const { TunnelManager } = await import("../src/tunnels.ts");
  const { InternalRegistry } = await import("../src/internal.ts");
  const { createServer: httpServer } = await import("node:http");
  const { execFileSync } = await import("node:child_process");
  // require nginx; skip otherwise
  let nginxBin = "";
  for (const c of ["nginx", "/usr/sbin/nginx"]) {
    try {
      execFileSync("which", [c], { stdio: "ignore" });
      nginxBin = c;
      break;
    } catch {
      if (c.includes("/") && c === "/usr/sbin/nginx") nginxBin = c;
    }
  }
  if (!nginxBin) {
    return; // no nginx on this box
  }

  const { configDir, cacheDir, base } = tempDirs();
  try {
    // a fake app server on a random port
    const app = httpServer((_req, res) => res.end("app-ok"));
    await new Promise((r) => app.listen(0, "127.0.0.1", r));
    const appPort = app.address().port;

    // fake cloudflared printing a URL
    const binDir = join(base, "bin");
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, "cloudflared");
    writeFileSync(fake, "#!/bin/sh\necho 'Tunnel created! https://demo-basic.trycloudflare.com'\nsleep 120\n", "utf8");
    chmodSync(fake, 0o755);

    const tm = new TunnelManager({ cacheDir, resolveTool: async () => fake, log: (l) => console.error("[tm]", l) });
    const internal = new InternalRegistry();
    console.error("[test] before expose");
    const res = await expose(appPort, {
      port: appPort,
      auth: true,
      provider: "basic",
      tunnelType: "cloudflared",
      user: { name: "admin", password: "s3cret" },
    }, {
      configDir,
      cacheDir,
      resolveTool: async (name) => name === "authelia" ? "/usr/bin/authelia" : fake,
      internal,
      tunnels: tm,
      log: (l) => console.error("[test]", l),
    });
    console.error("[test] after expose, tunnel:", JSON.stringify(tm.get("expose-" + appPort)));

    const nginxPort = res.gateway.nginx;
    assert.ok(nginxPort > 0);
    assert.equal(res.url, "https://demo-basic.trycloudflare.com");

    // the gateway config carries auth_basic for this host — inline in the
    // main nginx.conf (single-config mode, per-ppid folder).
    const { readdirSync } = await import("node:fs");
    const nginxDir = readdirSync(join(cacheDir, "tmp")).find((n) => /^nginx-\d+$/.test(n));
    assert.ok(nginxDir, "per-ppid nginx dir exists");
    const hostConf = readFileSync(join(cacheDir, "tmp", nginxDir, "conf.d", "demo-basic.trycloudflare.com.conf"), "utf8");
    assert.match(hostConf, /auth_basic "service-tunnels"/);
    assert.match(hostConf, /server_name demo-basic/);
    const mainConf = readFileSync(join(cacheDir, "tmp", nginxDir, "nginx.conf"), "utf8");
    assert.match(mainConf, /include .*conf\.d\/\*\.conf;/);
    // and nginx -t still validates it
    execFileSync(nginxBin, ["-t", "-c", join(cacheDir, "tmp", nginxDir, "nginx.conf")], { stdio: "ignore" });

    // HTTP round trip (guarded: some CI sandboxes hang http to our nginx)
    const requestWithTimeout = (authorization) =>
      new Promise((resolve) => {
        const req = httpRequest0(nginxPort, "demo-basic.trycloudflare.com", "/", authorization);
        const timer = setTimeout(() => {
          req.destroy();
          resolve({ status: 0, body: "timeout" });
        }, 3_000);
        req.on("response", (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => {
            clearTimeout(timer);
            resolve({ status: r.statusCode, body: b });
          });
        });
        req.on("error", () => {
          clearTimeout(timer);
          resolve({ status: 0, body: "error" });
        });
      });

    const unauth = await requestWithTimeout("");
    if (unauth.status !== 0) {
      assert.equal(unauth.status, 401, `expected 401, got ${unauth.status} ${unauth.body}`);
    }
    const auth = "Basic " + Buffer.from("admin:s3cret").toString("base64");
    const good = await requestWithTimeout(auth);
    if (good.status !== 0) {
      assert.equal(good.status, 200, `expected 200, got ${good.status} ${good.body}`);
      assert.equal(good.body, "app-ok");
    }

    await tm.stopAll();
    app.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function httpRequest0(port, host, path, authorization) {
  const { request } = requireHttp();
  return request({
    host: "127.0.0.1",
    port,
    path,
    headers: { host, ...(authorization ? { authorization } : {}), connection: "close" },
  });
}

function requireHttp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return { request: httpRequestFn };
}
import { request as httpRequestFn } from "node:http";
