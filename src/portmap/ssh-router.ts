/**
 * ssh-router backend — router port mapping via SSH into the router itself.
 *
 * For routers without UPnP/NAT-PMP (or where the user prefers explicit
 * rules), we SSH in and add/remove a DNAT rule. Command presets cover the
 * common firmware families; the rule is tagged `service-tunnels:<name>` so
 * removal is idempotent and orphan rules can be swept.
 *
 * Security: the SSH command string is built from validated tokens only
 * (numeric ports, dotted-quad IP, preset allowlisted templates) — no user
 * shell metacharacters ever reach the router. `ssh` itself runs with
 * BatchMode + StrictHostKeyChecking=accept-new (first-connect TOFU).
 */
import { execFile } from "node:child_process";
import { localIpFor } from "./probe.ts";
import { PortmapError, type PortmapAddRequest, type PortmapMapping } from "./upnp.ts";

export type RouterPreset = "openwrt" | "routeros" | "generic-iptables";

export interface SshRouterOptions {
  host: string;
  /** ssh user (default root for openwrt, admin for routeros). */
  user?: string;
  /** Port for router sshd (default 22). */
  port?: number;
  /** Optional identity file. */
  key?: string;
  preset: RouterPreset;
  /** SSH connect timeout (seconds, default 8). */
  connectTimeout?: number;
  /** @internal test seam — command runner (default: system ssh). */
  runner?: (remoteCmd: string) => Promise<string>;
}

const PRESETS: Record<RouterPreset, { user: string; add: (v: Vars) => string; remove: (v: Vars) => string }> = {
  openwrt: {
    user: "root",
    // fw3 (iptables): the comment matcher is part of the rule — -C/-D must
    // specify the FULL rule (incl. -m comment) or they fail to match.
    add: (v) =>
      `iptables -t nat -C MINIUPNPD -p ${v.protocol} -m ${v.protocol} --dport ${v.ext} -j DNAT --to-destination ${v.lan}:${v.int} -m comment --comment "service-tunnels:${v.name}" 2>/dev/null || ` +
      `iptables -t nat -A MINIUPNPD -p ${v.protocol} -m ${v.protocol} --dport ${v.ext} -j DNAT --to-destination ${v.lan}:${v.int} -m comment --comment "service-tunnels:${v.name}"`,
    remove: (v) =>
      `iptables -t nat -D MINIUPNPD -p ${v.protocol} -m ${v.protocol} --dport ${v.ext} -j DNAT --to-destination ${v.lan}:${v.int} -m comment --comment "service-tunnels:${v.name}" 2>/dev/null; true`,
  },
  routeros: {
    user: "admin",
    add: (v) =>
      `/ip firewall nat add chain=dstnat protocol=${v.protocol} dst-port=${v.ext} action=dst-nat to-addresses=${v.lan} to-ports=${v.int} comment="service-tunnels:${v.name}"`,
    remove: (v) =>
      `/ip firewall nat remove [find comment="service-tunnels:${v.name}"]`,
  },
  "generic-iptables": {
    user: "root",
    add: (v) =>
      `iptables -t nat -C PREROUTING -p ${v.protocol} -m ${v.protocol} --dport ${v.ext} -j DNAT --to-destination ${v.lan}:${v.int} -m comment --comment "service-tunnels:${v.name}" 2>/dev/null || ` +
      `iptables -t nat -A PREROUTING -p ${v.protocol} -m ${v.protocol} --dport ${v.ext} -j DNAT --to-destination ${v.lan}:${v.int} -m comment --comment "service-tunnels:${v.name}"`,
    remove: (v) =>
      `iptables -t nat -D PREROUTING -p ${v.protocol} -m ${v.protocol} --dport ${v.ext} -j DNAT --to-destination ${v.lan}:${v.int} -m comment --comment "service-tunnels:${v.name}" 2>/dev/null; true`,
  },
};

interface Vars {
  protocol: string;
  ext: number;
  int: number;
  lan: string;
  name: string;
}

function runSsh(o: SshRouterOptions, remoteCmd: string, timeoutMs = 15000): Promise<string> {
  if (o.runner) return o.runner(remoteCmd);
  const sshPort = o.port ?? 22;
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)
    return Promise.reject(new PortmapError("bad ssh port", "BAD_ARGS"));
  if (!o.host || /[\s;|&`$()\x22'\\]/.test(o.host))
    return Promise.reject(new PortmapError("bad router host", "BAD_ARGS"));
  return new Promise((resolve, reject) => {
    const args = [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `ConnectTimeout=${o.connectTimeout ?? 8}`,
      "-p", String(sshPort),
      ...(o.key ? ["-i", o.key] : []),
      `${o.user ?? PRESETS[o.preset].user}@${o.host}`,
      remoteCmd,
    ];
    execFile("ssh", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new PortmapError(`ssh-router ${o.host}: ${stderr.trim() || err.message}`, "SSH"));
      else resolve(stdout);
    });
  });
}

function buildVars(o: SshRouterOptions, req: PortmapAddRequest & { internalIp: string; name: string }): Vars {
  // validate: numbers only for ports, dotted-quad for ip, safe name — all
  // BEFORE any string reaches the router (fail-closed injection guard).
  if (!/^[A-Za-z0-9._-]+$/.test(req.name)) throw new PortmapError("bad mapping name", "BAD_ARGS");
  const int = Math.trunc(req.internalPort);
  const ext = Math.trunc(req.externalPort ?? 0);
  if (!Number.isInteger(int) || int < 1 || int > 65535) throw new PortmapError("bad internal port", "BAD_ARGS");
  if (!Number.isInteger(ext) || ext < 1 || ext > 65535) throw new PortmapError("bad external port", "BAD_ARGS");
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(req.internalIp)) throw new PortmapError("bad internal ip", "BAD_ARGS");
  return { protocol: req.protocol ?? "tcp", int, ext, lan: req.internalIp, name: req.name };
}

export class SshRouterBackend {
  readonly kind = "ssh-router" as const;
  readonly opts: SshRouterOptions;
  #preset: RouterPreset;

  constructor(opts: SshRouterOptions) {
    this.opts = opts;
    this.#preset = opts.preset;
  }

  /** Verify we can reach the router and it answers (used by probe). */
  async ping(): Promise<boolean> {
    try {
      await runSsh(this.opts, PRESETS[this.#preset].user === "root" ? "echo ok" : "/system identity print", 8000);
      return true;
    } catch {
      return false;
    }
  }

  /** Public/WAN IP as seen by the router itself (per preset). */
  async getExternalIp(): Promise<string> {
    const cmds =
      this.#preset === "openwrt"
        ? [
            "uci get network.wan.ipaddr 2>/dev/null",
            // PPPoE: ifstatus wan → ipv4-address[].address
            "ifstatus wan | grep -o '\"address\": \"[0-9.]*\"' | head -1 | grep -o '[0-9.]*'",
            "ip -4 addr show wan-pppoe 2>/dev/null | grep -o 'inet [0-9.]*' | head -1 | cut -d' ' -f2",
            "curl -s -m 4 https://api.ipify.org",
          ]
        : this.#preset === "routeros"
          ? [":put [/ip address get [find interface=wan] address]"]
          : [];
    if (!cmds.length) throw new PortmapError("ssh-router: preset has no external-ip query; pass externalIp explicitly", "NO_EXT_IP");
    let lastErr: unknown = null;
    for (const cmd of cmds) {
      try {
        const out = await runSsh(this.opts, cmd, 8000);
        const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(out);
        const ip = m?.[1];
        if (ip && !ip.startsWith("192.168.") && !ip.startsWith("10.") && !ip.startsWith("172.")) return ip;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new PortmapError(
      `ssh-router: no public ip from router (${String(lastErr instanceof Error ? lastErr.message : lastErr)})`,
      "NO_EXT_IP",
    );
  }

  async add(req: PortmapAddRequest & { internalIp?: string; name: string }): Promise<PortmapMapping> {
    const internalIp = req.internalIp ?? (await localIpFor(this.opts.host));
    // random dynamic external port unless requested
    const ext = req.externalPort ?? (49152 + Math.floor(Math.random() * 16384));
    const v = buildVars(this.opts, { ...req, internalIp, externalPort: ext });
    await runSsh(this.opts, PRESETS[this.#preset].add(v));
    return {
      backend: "ssh-router",
      gateway: this.opts.host,
      internalIp,
      internalPort: v.int,
      externalPort: v.ext,
      protocol: (v.protocol as "tcp") ?? "tcp",
      leaseSeconds: req.leaseSeconds ?? 0, // ssh-router rules are static (no lease)
      description: `service-tunnels:${v.name}`,
    };
  }

  async remove(externalPort: number, protocol: "tcp" | "udp" = "tcp", name = "", target?: { internalIp: string; internalPort: number }): Promise<void> {
    if (!name) {
      // no name → sweep ALL service-tunnels rules (crash leftovers)
      await this.sweep();
      return;
    }
    // M3: 有 name 无 target 时直接报错——占位目标 (0.0.0.0:1) 匹配不到真实规则
    // 会静默失败（-D 的 2>/dev/null 吞掉），绝不能让调用方误以为删成功了。
    if (!target) throw new PortmapError("remove needs the mapping target (internalIp:internalPort) to match the full rule", "BAD_ARGS");
    const v = buildVars(this.opts, {
      protocol,
      externalPort,
      internalPort: target.internalPort,
      internalIp: target.internalIp,
      name,
    });
    await runSsh(this.opts, PRESETS[this.#preset].remove(v));
  }

  /** Sweep orphan rules tagged service-tunnels (crash leftovers).
   *  Note: on iptables presets this flushes the whole MINIUPNPD chain
   *  (UPnP re-adds live mappings on the next request) — explicit operator
   *  call only, never automatic. */
  async sweep(name = ""): Promise<void> {
    if (this.#preset === "routeros") {
      // comment~ is substring/regex match — catches both tagged and plain
      await runSsh(this.opts, `/ip firewall nat remove [find comment~"service-tunnels"]`);
    } else {
      await runSsh(this.opts, `iptables -t nat -F MINIUPNPD 2>/dev/null; true`);
    }
  }
}
