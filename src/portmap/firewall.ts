/**
 * 本机防火墙放行（portmap 部署前提）。
 *
 * 真实教训（外部连通性测试）：路由器 UPnP DNAT 建立后，本机防火墙（ufw/
 * iptables）若不放行 `LAN IP:transportPort` 的入站，外部源（互联网）的包
 * 到不了 transport——映射"看似成功、实际不可达"。portmap expose 必须把
 * 本机防火墙纳入闭环：检查 → 尝试放行 → 失败则报错回滚。
 *
 * npm 调研结论（2026-08）：无可靠的防火墙开端口包——iptables@0.0.4（2012
 * 年停更）、iptables2@0.2.0（同样陈旧）、nftables-napi（native binding，
 * 违背零依赖约定）。自实现（~150 行）符合项目约定。
 */
import { execFile } from "node:child_process";

export type FirewallBackend = "ufw" | "firewalld" | "iptables" | "pfctl" | "none" | "unsupported";

export interface FirewallCheck {
  backend: FirewallBackend;
  /** 端口是否已放行（本机防火墙视角）。 */
  allowed: boolean;
  /** 检测到的防火墙后端详情（提示用）。 */
  detail?: string;
}

export interface FirewallOpenResult {
  backend: FirewallBackend;
  /** 放行是否已确保（true = 原本已放行或本次放行成功）。 */
  ensured: boolean;
  detail?: string;
}

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** sudo -n（非交互）：绝不提示密码、绝不挂起；未配 passwordless sudo 时立即失败。 */
const SUDO_TIMEOUT = 10_000;
async function sudoRun(args: string[], timeoutMs = SUDO_TIMEOUT): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return run("sudo", ["-n", ...args], timeoutMs);
}

const SYS_BINS = new Map([
  ["ufw", ["/usr/sbin/ufw", "/sbin/ufw"]],
  ["firewall-cmd", ["/usr/sbin/firewall-cmd", "/bin/firewall-cmd"]],
  ["iptables", ["/usr/sbin/iptables", "/sbin/iptables"]],
  ["pfctl", ["/sbin/pfctl"]],
]);

/** 解析命令完整路径：PATH → 常见系统目录（ufw/iptables 常不在普通用户 PATH）。 */
async function resolveCmd(name: string): Promise<string | null> {
  const w = await run("which", [name]);
  if (w.ok) return name;
  for (const p of SYS_BINS.get(name) ?? []) {
    const t = await run("test", ["-x", p]);
    if (t.ok) return p;
  }
  return null;
}

/** 探测本机防火墙后端（顺序：ufw → iptables → pfctl）。 */
export async function detectFirewall(): Promise<FirewallBackend> {
  // ufw/firewall-cmd/iptables 常在 /usr/sbin、/sbin（普通用户 PATH 不含）——
  // which 找不到时兜底探测常见路径。
  const found = async (names: string[]): Promise<boolean> => {
    for (const n of names) {
      const r = await run("which", [n]);
      if (r.ok) return true;
      for (const p of ["/usr/sbin", "/sbin", "/usr/local/sbin"]) {
        const t = await run("test", ["-x", `${p}/${n}`]);
        if (t.ok) return true;
      }
    }
    return false;
  };
  if (await found(["ufw"])) return "ufw";
  if (await found(["firewall-cmd"])) return "firewalld";
  if (await found(["iptables"])) return "iptables";
  if (await found(["pfctl"])) return "pfctl";
  return "none";
}

/** 检查 `ip:port`（入站，任意源）是否已被本机防火墙放行。 */
export async function checkFirewall(ip: string, port: number, backend?: FirewallBackend): Promise<FirewallCheck> {
  const b = backend ?? (await detectFirewall());
  if (b === "ufw") {
    // ufw status 需 root（普通用户报 "You need to be root"）——先直跑，失败走 sudo -n。
    const cmd = await resolveCmd("ufw");
    if (!cmd) return { backend: "ufw", allowed: false, detail: "ufw detected but not executable" };
    let r = await run(cmd, ["status"]);
    if (!r.ok) {
      r = await sudoRun([cmd, "status"]);
      if (!r.ok) {
        return { backend: "ufw", allowed: false, detail: `cannot read ufw status (needs root): ${r.stderr.trim() || "passwordless sudo unavailable"}` };
      }
    }
    // 行级匹配（ufw 列对齐/带 on 接口/尾部空格不可靠）：含 `<port>/tcp` 且含 ALLOW 即放行。
    const allowed = r.stdout.split("\n").some((l) => l.includes(`${port}/tcp`) && l.includes("ALLOW"));
    return { backend: "ufw", allowed, detail: allowed ? "ufw allows" : "ufw blocks (or no rule)" };
  }
  if (b === "firewalld") {
    // zone 模型：端口维度（不绑 IP）——`--query-port=<port>/tcp` exit 0 = 已放行。
    const cmd = await resolveCmd("firewall-cmd");
    if (!cmd) return { backend: "firewalld", allowed: false, detail: "firewall-cmd detected but not executable" };
    const r = await run(cmd, [`--query-port=${port}/tcp`]);
    if (r.ok) return { backend: "firewalld", allowed: true, detail: "firewalld allows" };
    return { backend: "firewalld", allowed: false, detail: "firewalld blocks (or zone not active)" };
  }
  if (b === "iptables") {
    // iptables -C 检查 INPUT 是否有 ACCEPT dport=port（任意源）。策略 DROP 时
    // 还需规则在 ufw 链里；这里以"存在 ACCEPT 目标端口的规则"为准。
    const cmd = await resolveCmd("iptables");
    if (!cmd) return { backend: "iptables", allowed: false, detail: "iptables detected but not executable" };
    const r = await run(cmd, ["-C", "INPUT", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"]);
    if (r.ok) return { backend: "iptables", allowed: true, detail: "iptables ACCEPT rule exists" };
    // 也查 ufw 管理的链（ufw 在时 iptables 规则藏在 ufw-user-input 等链）
    const ufwChain = await run(cmd, ["-C", "ufw-user-input", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"]);
    return { backend: "iptables", allowed: ufwChain.ok, detail: ufwChain.ok ? "ufw-user-input allows" : "no ACCEPT rule" };
  }
  if (b === "pfctl") {
    // macOS: pf 规则不易精确匹配，pfctl -sr 输出解析太脆；返回"未确认"由调用方决定。
    const cmd = await resolveCmd("pfctl");
    if (!cmd) return { backend: "pfctl", allowed: false, detail: "pfctl detected but not executable" };
    const r = await run(cmd, ["-sr"]);
    const allowed = r.ok && new RegExp(`dport\\\\s*=\\\\s*${port}`).test(r.stdout);
    return { backend: "pfctl", allowed, detail: allowed ? "pf anchor rule allows" : "pf ruleset: no explicit allow (or unreadable)" };
  }
  return { backend: "none", allowed: false, detail: "no firewall backend detected" };
}

/** 放行 `ip:port` 入站。返回 ensured=false + detail 说明失败原因（权限等）。 */
export async function openFirewall(ip: string, port: number, backend?: FirewallBackend): Promise<FirewallOpenResult> {
  const b = backend ?? (await detectFirewall());
  // 幂等：先查，已放行直接返回。
  const check = await checkFirewall(ip, port, b);
  if (check.allowed) return { backend: b, ensured: true, detail: "already allowed" };

  // 命令解析一次（ufw/iptables 可能在 /usr/sbin，普通用户 PATH 不含）
  const bin = await resolveCmd(b === "ufw" ? "ufw" : b === "firewalld" ? "firewall-cmd" : b === "iptables" ? "iptables" : "pfctl");
  const tryRun = async (args: string[], sudo = false): Promise<{ ok: boolean; stderr: string }> => {
    // sudo 一律 -n 非交互：未配 passwordless sudo 时立即失败，绝不挂起等密码。
    const r = sudo ? await sudoRun(args) : await run(args[0]!, args.slice(1));
    return { ok: r.ok, stderr: r.stderr };
  };
  const full = (args: string[]) => (bin ? [bin, ...args] : args);
  // 一次探测 passwordless sudo（-n true）；false 时直接给手动命令，不再反复试。
  const sudoAvailable = (await sudoRun(["true"])).ok;

  if (b === "ufw") {
    const direct = await tryRun(full(["allow", "in", "to", ip, "port", String(port), "proto", "tcp"]));
    if (direct.ok) return { backend: "ufw", ensured: true, detail: `ufw allow in to ${ip} port ${port}` };
    // 权限不足 → passwordless sudo 可用则自动放行；否则报错给手动命令
    if (sudoAvailable) {
      const sudoRun = await tryRun(full(["allow", "in", "to", ip, "port", String(port), "proto", "tcp"]), true);
      if (sudoRun.ok) return { backend: "ufw", ensured: true, detail: `sudo ufw allow in to ${ip} port ${port}` };
    }
    return { backend: "ufw", ensured: false, detail: `ufw blocked and no passwordless sudo (run manually: sudo ufw allow in to ${ip} port ${port} proto tcp): ${direct.stderr.trim()}` };
  }
  if (b === "firewalld") {
    // zone 维度放行端口（firewalld 不绑 IP——比 ufw 宽，但 transport 只监听本机，
    // 外部源到 本机IP:port 即可达）。永久规则 + reload 才真正落盘。
    const perm = await tryRun(full(["--permanent", `--add-port=${port}/tcp`]));
    if (perm.ok) {
      const reload = await tryRun(full(["--reload"]));
      if (reload.ok) return { backend: "firewalld", ensured: true, detail: `firewall-cmd --permanent --add-port=${port}/tcp` };
      return { backend: "firewalld", ensured: false, detail: `firewalld add ok but reload failed: ${reload.stderr.trim() || "run firewall-cmd --reload"}` };
    }
    if (sudoAvailable) {
      const sudoPerm = await tryRun(full(["--permanent", `--add-port=${port}/tcp`]), true);
      if (sudoPerm.ok) {
        const sudoReload = await tryRun(full(["--reload"]), true);
        if (sudoReload.ok) return { backend: "firewalld", ensured: true, detail: `sudo firewall-cmd --permanent --add-port=${port}/tcp` };
      }
    }
    return { backend: "firewalld", ensured: false, detail: `firewalld blocked and no passwordless sudo (run manually: sudo firewall-cmd --permanent --add-port=${port}/tcp && sudo firewall-cmd --reload): ${perm.stderr.trim()}` };
  }
  if (b === "iptables") {
    const args = full(["-I", "INPUT", "1", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT", "-m", "comment", "--comment", `service-tunnels:${port}`]);
    const direct = await tryRun(args);
    if (direct.ok) return { backend: "iptables", ensured: true, detail: `iptables ACCEPT ${port}` };
    if (sudoAvailable) {
      const sudoRun = await tryRun(args, true);
      if (sudoRun.ok) return { backend: "iptables", ensured: true, detail: `sudo iptables ACCEPT ${port}` };
    }
    return { backend: "iptables", ensured: false, detail: `iptables blocked and no passwordless sudo (run manually: sudo iptables -I INPUT 1 -p tcp --dport ${port} -j ACCEPT): ${direct.stderr.trim()}` };
  }
  if (b === "pfctl") {
    return { backend: "pfctl", ensured: false, detail: "macOS pf: manual rule required (pf.conf anchor)" };
  }
  return { backend: "none", ensured: false, detail: "no firewall backend detected — cannot verify/open" };
}

/** 删除放行规则（stop 映射时清理本次添加的规则；只删不报错——best effort）。 */
export async function removeFirewall(ip: string, port: number, backend?: FirewallBackend): Promise<void> {
  const b = backend ?? (await detectFirewall());
  const bin = await resolveCmd(b === "ufw" ? "ufw" : b === "firewalld" ? "firewall-cmd" : b === "iptables" ? "iptables" : "pfctl");
  if (!bin) return;
  // 注意：sudo 重置 PATH（secure_path）——sudo 分支必须用命令名而非解析出的
  // 绝对路径，否则测试的 PATH 注入 fake 无效、真机上也找不到非标准路径。
  const name = b === "ufw" ? "ufw" : b === "firewalld" ? "firewall-cmd" : "iptables";
  const sudoOk = (await sudoRun(["true"])).ok;
  const tryRun = async (args: string[], sudo = false): Promise<void> => {
    try {
      if (sudo) await sudoRun([name, ...args]);
      else await run(bin, args);
    } catch { /* best effort */ }
  };
  if (b === "ufw") {
    const args = ["delete", "allow", "in", "to", ip, "port", String(port), "proto", "tcp"];
    if (sudoOk) await tryRun(args, true);
    else await tryRun(args);
  } else if (b === "firewalld") {
    if (sudoOk) {
      await tryRun(["--permanent", `--remove-port=${port}/tcp`], true);
      await tryRun(["--reload"], true);
    }
  } else if (b === "iptables") {
    const args = ["-D", "INPUT", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT", "-m", "comment", "--comment", `service-tunnels:${port}`];
    if (sudoOk) await tryRun(args, true);
    else await tryRun(args);
  }
}
