#!/usr/bin/env node
/**
 * service-tunnels CLI — M1: config/discover/internal/daemon/status.
 */
import { createServiceTunnels } from "./index.ts";
import { InternalRegistry } from "./internal.ts";
import { cachePaths, resolveDirs } from "./config.ts";
import { readState } from "./state.ts";
import { readEnvToolPaths } from "./tools.ts";

function usage(): void {
  console.log(`service-tunnels <command>

  daemon start [--foreground] | stop | status | logs
  discover [--pid <pid>] [--json] [--refresh]
  internal list [--json]
  tools list | resolve <name> | download <name> | path <name>
  proxy start [--port <p>] [--suffix <s>] [--base-path <bp>] [--password] [--foreground]
  tunnel list | add <name> --type <t> [--target <p>] [--domain <d>] [--cmd <c>] |
         start|stop|remove <name>
  expose <port> [--tunnel <t>] [--auth [<provider>]] [--name <n>] [--nginx-port <p>]
  stop-all
  status [--json]
  config path | show

全局：--config-dir <dir> / --cache-dir <dir>（或 SERVICE_TUNNELS_CONFIG/CACHE）`);
}

interface CliArgs {
  configDir?: string;
  cacheDir?: string;
  json: boolean;
  refresh: boolean;
  foreground: boolean;
  pid?: number;
  port?: number;
  suffix?: string;
  basePath?: string;
  password?: string;
  type?: string;
  target?: number;
  domain?: string;
  host?: string;
  server?: string;
  token?: string;
  cmd?: string;
  tunnelArgs?: string[];
  tunnel?: string;
  name?: string;
  nginxPort?: number;
  auth?: boolean | string;
  displayName?: string;
  provider?: string;
  [k: string]: unknown;
}

function parseArgs(argv: string[]): { cmd: string[]; args: CliArgs } {
  const args: CliArgs = { json: false, refresh: false, foreground: false };
  const cmd: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        args.json = true;
        break;
      case "--refresh":
        args.refresh = true;
        break;
      case "--foreground":
        args.foreground = true;
        break;
      case "--config-dir":
        args.configDir = argv[++i];
        break;
      case "--cache-dir":
        args.cacheDir = argv[++i];
        break;
      case "--pid":
        args.pid = Number(argv[++i]!);
        break;
      case "--port":
        args.port = Number(argv[++i]!);
        break;
      case "--suffix":
        args.suffix = argv[++i];
        break;
      case "--base-path":
        args.basePath = argv[++i];
        break;
      case "--password":
        args.password = argv[++i];
        break;
      case "--type":
        args.type = argv[++i];
        break;
      case "--target":
        args.target = Number(argv[++i]!);
        break;
      case "--domain":
        args.domain = argv[++i];
        break;
      case "--host":
        args.host = argv[++i];
        break;
      case "--server":
        args.server = argv[++i];
        break;
      case "--token":
        args.token = argv[++i];
        break;
      case "--cmd":
        args.cmd = argv[++i];
        break;
      case "--arg":
        (args.tunnelArgs ??= []).push(argv[++i]!);
        break;
      case "--auth": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          args.auth = argv[++i];
        } else {
          args.auth = true;
        }
        break;
      }
      case "--tunnel":
        args.tunnel = argv[++i];
        break;
      case "--name":
        args.name = argv[++i];
        break;
      case "--nginx-port":
        args.nginxPort = Number(argv[++i]!);
        break;
      case "--display-name":
        args.displayName = argv[++i]!;
        break;
      case "--provider":
        args.provider = argv[++i]!;
        break;
      default:
        if (a!.startsWith("-")) {
          console.error(`未知参数: ${a}`);
          process.exit(2);
        }
        cmd.push(a!);
    }
  }
  return { cmd, args };
}

function randomCliPassword(len = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function jsonOut(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const st = createServiceTunnels({ configDir: args.configDir, cacheDir: args.cacheDir });
  const sub = cmd[0] ?? "";

  switch (sub) {
    case "config": {
      if (cmd[1] === "path") {
        process.stdout.write(`${st.dirs.configDir}\n${st.dirs.cacheDir}\n`);
      } else {
        jsonOut({ configDir: st.dirs.configDir, cacheDir: st.dirs.cacheDir });
      }
      break;
    }

    case "discover": {
      // CLI 模式：本地执行（以 CLI/用户 shell 进程树为根）——用户测试服务是
      // 调用方 shell 的后代，不是 daemon 的后代（design.md §4.9）。
      // 从 state.json 加载框架内部端口进 registry，discovery 会排除它们。
      const local = new InternalRegistry();
      for (const entry of st.state().internal) {
        local.register(entry.role, {
          port: entry.port,
          pid: entry.pid,
          process: entry.role,
          cmdline: entry.role,
          addresses: entry.addresses,
        });
      }
      const ports = st.discovery.getPorts({
        rootPid: args.pid,
        force: args.refresh,
      });
      jsonOut(ports);
      break;
    }

    case "internal": {
      const listed = await st.daemon.request("internal.list");
      jsonOut(listed ?? st.internal.list());
      break;
    }

    case "daemon": {
      const op = cmd[1] ?? "";
      switch (op) {
        case "start": {
          const status = st.daemon.start({ foreground: args.foreground });
          if (args.foreground) {
            // daemon runs attached — this process becomes it
            await new Promise(() => {});
          }
          jsonOut(status);
          break;
        }
        case "stop": {
          jsonOut({ stopped: await st.daemon.stop() });
          break;
        }
        case "status": {
          jsonOut(st.daemon.status());
          break;
        }
        case "logs": {
          const { stateFile } = cachePaths(st.dirs.cacheDir);
          process.stdout.write(`${stateFile}.daemon.log\n`);
          break;
        }
        default:
          usage();
          process.exit(2);
      }
      break;
    }

    case "tools": {
      const op = cmd[1] ?? "list";
      if (op === "list") {
        jsonOut(st.tools.list());
      } else if (op === "resolve" || op === "path") {
        const name = cmd[2];
        if (!name) {
          console.error("tools " + op + " <name>");
          process.exit(2);
        }
        jsonOut({ name, path: st.tools.resolve(name) });
      } else if (op === "download") {
        const name = cmd[2];
        if (!name) {
          console.error("tools download <name>");
          process.exit(2);
        }
        const path = await st.tools.ensure(name);
        jsonOut({ name, path });
      } else {
        usage();
        process.exit(2);
      }
      break;
    }

    case "proxy": {
      const op = cmd[1] ?? "";
      if (op === "start") {
        const port = Number(args.port ?? 4180);
        const suffix = args.suffix ?? ".pi.localhost";
        const basePath = args.basePath ?? "";
        const password = args.password ?? "";
        const server = st.proxy.create({
          port,
          suffixes: suffix.split(",").map((s2: string) => (s2.startsWith(".") ? s2 : `.${s2}`)),
          basePath,
          password,
          rootPid: args.pid,
          refresh: args.refresh,
        });
        server.once("listening", () => {
          const addr = server.address();
          const p = typeof addr === "object" && addr ? addr.port : port;
          process.stdout.write(`proxy listening on 127.0.0.1:${p} (suffix: ${suffix})\n`);
        });
        if (!args.foreground) {
          // non-foreground: spawn as child of the daemon in a later milestone;
          // M2 keeps the server in this process.
        }
        await new Promise(() => {});
      } else {
        usage();
        process.exit(2);
      }
      break;
    }

    case "tunnel": {
      const op = cmd[1] ?? "list";
      const name = cmd[2];
      // CLI 模式：隧道进程由 daemon 持有（跨 CLI 调用可见/可控）。
      // daemon 未运行 → 自动拉起（--auto-daemon 语义：常驻进程归 daemon）。
      const dstat = st.daemon.status();
      if (!dstat.running) {
        st.daemon.start();
        // wait for IPC socket
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !st.daemon.status().running) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const d = st.daemon;
      if (op === "list") {
        const infos = await d.request("tunnel.list");
        jsonOut(infos ?? []);
      } else if (op === "add") {
        if (!name || !args.type) {
          console.error("tunnel add <name> --type <ngrok|frpc|ssh|cloudflared|localtunnel|command>");
          process.exit(2);
        }
        const cfg = {
          name,
          type: args.type,
          target: args.target ? Number(args.target) : undefined,
          domain: args.domain,
          args: args.tunnelArgs,
          cmd: args.cmd,
          host: args.host,
          server: args.server,
          token: args.token,
        };
        await d.request("tunnel.add", cfg);
        jsonOut({ added: name });
      } else if (op === "start" || op === "stop" || op === "remove") {
        if (!name) {
          console.error(`tunnel ${op} <name>`);
          process.exit(2);
        }
        if (op === "start") {
          const info = await d.request("tunnel.start", name);
          jsonOut(info ?? { error: "start failed" });
        } else if (op === "stop") {
          await d.request("tunnel.stop", name);
          jsonOut({ stopped: name });
        } else {
          await d.request("tunnel.remove", name);
          jsonOut({ removed: name });
        }
      } else {
        usage();
        process.exit(2);
      }
      break;
    }

    case "expose": {
      const port = Number(cmd[1]);
      if (!Number.isFinite(port) || port <= 0) {
        console.error("expose <port>");
        process.exit(2);
      }
      // daemon mode: tunnel processes live in the daemon → expose must too
      let dstat = st.daemon.status();
      if (!dstat.running) {
        st.daemon.start();
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !st.daemon.status().running) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const res = await st.daemon.request("expose", {
        port,
        auth: Boolean(args.auth),
        provider: typeof args.auth === "string" ? args.auth : undefined,
        tunnelType: args.tunnel,
        tunnelName: args.name,
        nginxPort: args.nginxPort ? Number(args.nginxPort) : undefined,
        basePath: args.basePath,
      }, 90_000);
      jsonOut(res);
      break;
    }

    case "auth": {
      const op = cmd[1] ?? "list";
      if ((op === "provider" || op === "providers") && cmd[2] === "list") {
        jsonOut(st.auth.providers());
      } else if (op === "user" && cmd[2] === "list") {
        jsonOut(await st.auth.users(args.provider));
      } else if (op === "user" && cmd[2] === "add") {
        const name = cmd[3];
        if (!name) {
          console.error("auth user add <name> [--password <pw>] [--display-name <n>] [--provider basic|authelia|all]");
          process.exit(2);
        }
        const password = args.password ?? randomCliPassword();
        const providers = await st.auth.addUser(name, password, {
          provider: args.provider,
          displayName: args.displayName,
        });
        jsonOut({ added: name, providers, password: args.password ? undefined : password });
      } else if (op === "user" && cmd[2] === "set-password") {
        const name = cmd[3];
        if (!name) {
          console.error("auth user set-password <name> [--password <pw>] [--provider ...]");
          process.exit(2);
        }
        const password = args.password ?? randomCliPassword();
        const providers = await st.auth.setUserPassword(name, password, args.provider);
        jsonOut({ updated: name, providers, password: args.password ? undefined : password });
      } else if (op === "user" && cmd[2] === "remove") {
        const name = cmd[3] ?? "";
        const providers = await st.auth.removeUser(name, args.provider);
        jsonOut({ removed: name, providers });
      } else if (op === "totp" && cmd[2] === "enroll") {
        const name = cmd[3];
        if (!name) {
          console.error("auth totp enroll <name> [--provider portal]");
          process.exit(2);
        }
        jsonOut(await st.auth.totpEnroll(name, args.provider));
      } else if (op === "totp" && cmd[2] === "disable") {
        await st.auth.totpDisable(cmd[3] ?? "", args.provider);
        jsonOut({ disabled: cmd[3] });
      } else if (op === "totp" && cmd[2] === "status") {
        jsonOut(await st.auth.totpStatus(cmd[3] ?? "", args.provider));
      } else {
        console.error("auth providers list | auth user list|add|set-password|remove | auth totp enroll|disable|status [--provider ...]");
        process.exit(2);
      }
      break;
    }

    case "stop-all": {
      // stop the daemon (which kills nginx/authelia/redis/tunnels via role
      // markers), then remove the state file
      const stopped = await st.daemon.stop();
      const { rmSync } = await import("node:fs");
      const { cachePaths } = await import("../src/config.ts");
      rmSync(cachePaths(st.dirs.cacheDir).stateFile, { force: true });
      jsonOut({ stopped, cleaned: true });
      break;
    }

    case "status": {
      const d = st.daemon.status();
      jsonOut({ daemon: d, internal: st.state().internal, tunnels: st.state().tunnels });
      break;
    }

    default:
      usage();
      process.exit(cmd.length ? 2 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
