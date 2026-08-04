import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";

async function loadAuthelia() {
  return import("../src/authelia.ts");
}
async function loadGateway() {
  return import("../src/gateway.ts");
}

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-auth-"));
  return { configDir: join(base, "config"), cacheDir: join(base, "cache"), base };
}

function fakeBin(base, name, script) {
  const dir = join(base, "bin");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, script, "utf8");
  chmodSync(p, 0o755);
  return p;
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** A minimal TCP listener used as a fake authelia "server". */
function startFakeAutheliaServer(port) {
  const srv = netServer(() => {});
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve(srv)));
}

test("authelia: config generation + argon2 hash + registerHost rewrites config-tunnels.yml", { timeout: 30_000 }, async () => {
  const { AutheliaProvider } = await loadAuthelia();
  const { cacheDir, configDir, base } = tempDirs();

  // fake authelia: --version, config validate, hash generate, and a TCP listener
  const fakeAuthelia = fakeBin(base, "authelia", `#!/bin/sh
echo 'authelia v4.38.10'
# config validate: just exit 0 (also acts as the "server" when spawned)
case "$1" in
  config)
    if [ "$2" = "validate" ]; then exit 0; fi
    ;;
  crypto)
    # print an argon2 hash
    echo 'Password Hash: $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$abcdef'
    exit 0
    ;;
esac
# act as a minimal server: listen on the port from configuration.yml
python3 -c "
import socket, re, sys, time
conf = open('${join(cacheDir, "tmp", "authelia", "configuration.yml")}').read()
m = re.search(r'tcp://127\\\\.0\\\\.0\\\\.1:(\\\\d+)', conf)
port = int(m.group(1)) if m else 9091
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', port))
s.listen(1)
s.accept()
time.sleep(30)
" &
wait
`);

  const ctx = {
    configDir,
    cacheDir,
    resolveTool: async () => fakeAuthelia,
    registerInternal: () => {},
    unregisterInternal: () => {},
    pickPort,
    log: () => {},
  };
  const port = await pickPort();
  const provider = new AutheliaProvider(ctx, { port, sessionSecret: "test-secret", user: { name: "admin", password: "pw" } });

  await provider.prepare();
  // configs exist
  assert.ok(existsSync(join(cacheDir, "tmp", "authelia", "configuration.yml")));
  assert.ok(existsSync(join(cacheDir, "tmp", "authelia", "config-tunnels.yml")));
  // argon2 hash written into users db
  const users = readFileSync(join(cacheDir, "tmp", "authelia", "users_database.yml"), "utf8");
  assert.match(users, /\$argon2id\$v=19/);

  // start → the fake server binds the port
  const fakeServer = await startFakeAutheliaServer(port); // pre-bind so authelia "start" is moot
  const status = await provider.start();
  assert.equal(status.running, true);

  // dynamic registration
  await provider.registerHost("demo.ngrok-free.app");
  const hosts = await provider.listHosts();
  assert.deepEqual(hosts, ["demo.ngrok-free.app"]);
  const tunnelCfg = readFileSync(join(cacheDir, "tmp", "authelia", "config-tunnels.yml"), "utf8");
  assert.match(tunnelCfg, /demo\.ngrok-free\.app/);
  assert.match(tunnelCfg, /secret: 'test-secret'/);

  // registration is idempotent
  await provider.registerHost("demo.ngrok-free.app");
  assert.equal((await provider.listHosts()).length, 1);

  await provider.unregisterHost("demo.ngrok-free.app");
  assert.deepEqual(await provider.listHosts(), []);

  await provider.stop();
  fakeServer.close();
  rmSync(base, { recursive: true, force: true });
});

test("gateway: nginx config generation + host registration", async () => {
  const { generateGatewayNginx } = await loadGateway();
  const cfg = generateGatewayNginx({
    nginxPort: 4180,
    autheliaPort: 9091,
    basePath: "/authelia",
    hosts: [{ host: "demo.ngrok-free.app", port: 5173 }],
    nginxRoot: "/tmp/x/nginx",
  });
  assert.match(cfg, /server_name demo\\.ngrok-free\\.app/);
  assert.match(cfg, /auth_request \/authelia\/api\/authz\/auth-request/);
  assert.match(cfg, /proxy_pass http:\/\/127\.0\.0\.1:5173/);
  assert.match(cfg, /location \/authelia\//);
  // escaped dots in server_name
  assert.match(cfg, /demo\\\.ngrok-free\\\.app/);
});

test("gateway: start/stop lifecycle with a real nginx binary", { timeout: 30_000 }, async () => {
  const { GatewayController } = await loadGateway();
  const { cacheDir, configDir, base } = tempDirs();
  // use system nginx if available, else skip
  let nginxBin = "nginx";
  try {
    execFileSync("which", ["nginx"], { stdio: "ignore" });
  } catch {
    rmSync(base, { recursive: true, force: true });
    return;
  }
  const internal = [];
  const gw = new GatewayController({
    configDir,
    cacheDir,
    nginxBin,
    port: 4180,
    basePath: "/authelia",
    registerInternal: (role, port) => internal.push({ role, port }),
    unregisterInternal: (role) => {
      const i = internal.findIndex((x) => x.role === role);
      if (i >= 0) internal.splice(i, 1);
    },
    log: () => {},
  });
  try {
    await gw.registerHost("demo.ngrok-free.app", 5173, 9091); // validates + (no process yet)
    const port = await gw.start(9091);
    assert.equal(port, 4180);
    assert.equal(internal.some((x) => x.role === "nginx"), true);
    // host list survives
    assert.deepEqual(gw.hosts(), [{ host: "demo.ngrok-free.app", port: 5173 }]);
    // actual HTTP round trip through the gateway
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: 4180, path: "/", headers: { host: "demo.ngrok-free.app" } },
        (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => resolve({ status: r.statusCode, body: b }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    // no upstream on 5173 → nginx returns 502 (auth_request to 9091 also empty)
    assert.equal(res.status, 502);
  } finally {
    await gw.stop();
    rmSync(base, { recursive: true, force: true });
  }
});

test("redis: green start reports a port and stops", { timeout: 30_000 }, async () => {
  const { RedisController } = await import("../src/redis.ts");
  const { cacheDir, base } = tempDirs();
  try {
    execFileSync("which", ["redis-server"], { stdio: "ignore" });
  } catch {
    rmSync(base, { recursive: true, force: true });
    return; // no redis on this box
  }
  const redis = new RedisController({ cacheDir, port: 0, log: () => {} });
  const port = await redis.start();
  assert.ok(port > 0);
  // AOF dir created
  assert.ok(existsSync(join(cacheDir, "data", "redis")));
  await redis.stop();
  rmSync(base, { recursive: true, force: true });
});

test("authelia user management: add/list/set-password/remove", { timeout: 40_000 }, async () => {
  const { AutheliaProvider } = await loadAuthelia();
  const { cacheDir, configDir, base } = tempDirs();

  const fakeAuthelia = fakeBin(base, "authelia", `#!/bin/sh
echo 'authelia v4.39.20'
case "$1" in
  config) [ "$2" = "validate" ] && exit 0 ;;
  crypto)
    echo 'Password Hash: $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$abcdef'
    exit 0
    ;;
esac
sleep 30
`);
  const ctx = {
    configDir,
    cacheDir,
    resolveTool: async () => fakeAuthelia,
    registerInternal: () => {},
    unregisterInternal: () => {},
    pickPort: async () => 19140,
    log: () => {},
  };
  const provider = new AutheliaProvider(ctx, { port: 19140, sessionSecret: "s3cret", user: { name: "admin", password: "pw" } });
  await provider.prepare();

  // initial user registered
  let users = await provider.listUsers();
  assert.deepEqual(users.map((u) => u.name), ["admin"]);
  assert.equal(users[0].displayName, "Administrator");

  // add a user
  await provider.addUser("alice", "alice-pw", "Alice Wang");
  users = await provider.listUsers();
  assert.deepEqual(users.map((u) => u.name).sort(), ["admin", "alice"]);
  const alice = users.find((u) => u.name === "alice");
  assert.equal(alice.displayName, "Alice Wang");
  // secrets never leak through the API
  assert.equal("password" in alice, false);

  // users_database.yml contains a real argon2 hash for alice
  const yml = readFileSync(join(cacheDir, "tmp", "authelia", "users_database.yml"), "utf8");
  assert.match(yml, /\$argon2id\$/);
  assert.equal(yml.includes("alice-pw"), false, "plaintext password must not appear");

  // set password keeps the user
  await provider.setUserPassword("alice", "new-pw");
  users = await provider.listUsers();
  assert.equal(users.length, 2);
  assert.equal(users.some((u) => u.name === "alice"), true);

  // remove
  await provider.removeUser("alice");
  users = await provider.listUsers();
  assert.deepEqual(users.map((u) => u.name), ["admin"]);
  await assert.rejects(provider.setUserPassword("nobody", "x"), /not registered/);
});
