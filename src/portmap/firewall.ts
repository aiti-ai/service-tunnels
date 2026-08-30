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
import { execFile, spawn } from "node:child_process";

export type FirewallBackend = "ufw" | "firewalld" | "iptables" | "pfctl" | "windows" | "none" | "unsupported";

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
    // Windows 的 .cmd/.bat 不能直接 spawn——经 shell 执行
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
    execFile(cmd, args, { timeout: timeoutMs, ...(shell ? { shell: true } : {}) }, (err, stdout, stderr) => {
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
  if (process.platform === "win32") {
    // Windows：where 替代 which；PATH 里的 .cmd/.exe 都要找
    const w = await run("where", [name]);
    if (w.ok && w.stdout.trim()) return w.stdout.trim().split(/\r?\n/)[0]!;
    const w2 = await run("where", [`${name}.cmd`]);
    if (w2.ok && w2.stdout.trim()) return w2.stdout.trim().split(/\r?\n/)[0]!;
    return null;
  }
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
  // Windows: netsh advfirewall（F13——无 ufw/iptables/pfctl 时必须有 Windows 后端，
  // 否则 portmap expose 在 Windows 上全部失败）
  if (process.platform === "win32") {
    const ns = await run("netsh", ["advfirewall", "firewall", "show", "rule", "name=all"], 5000);
    if (ns.ok) return "windows";
    const w = await run("where", ["netsh"]);
    if (w.ok) return "windows";
  }
  return "none";
}

/**
 * 是否有交互式桌面（Windows：explorer.exe 在跑 = 有登录用户桌面；服务/无头会话无）。
 * 用于日志/降级决策：有桌面 → 用户可手动处理；无桌面（服务运行）→ 静默降级，
 * 不尝试任何会弹 UAC 的路径（execFile 直接调 netsh 本来就不弹——仅 ShellExecute
 * runas 会弹，本实现不走该路径）。
 */
export async function hasDesktop(): Promise<boolean> {
  if (process.platform === "win32") {
    // 关键：进程自身能否与桌面交互（能被 UAC 弹窗）——不是"系统有没有 explorer"。
    // [Environment]::UserInteractive 是 .NET 标准：检查进程的 window station
    // 是否为 WinSta0。服务（session 0）/SSH/计划任务启动的进程 → False，即使
    // 同一台机器有别人 RDP 登录的桌面（explorer.exe 在跑）——那是别人的会话。
    const r = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::UserInteractive"],
      5000,
    );
    return r.ok && /True/i.test(r.stdout);
  }
  if (process.platform === "darwin") {
    // macOS：launchctl managername —— "Aqua" = GUI 登录会话（可交互），
    // "System" = launchd daemon（无桌面交互，即使有用户登录着）。macOS 无 DISPLAY。
    const r = await run("launchctl", ["managername"], 5000);
    return r.ok && /Aqua/i.test(r.stdout);
  }
  // Linux：服务（systemd）无 DISPLAY；有 X/Wayland 会话才视为可交互
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * 异步发起防火墙命令（fire-and-forget）：spawn + unref，立即返回不阻塞。
 * 用户语义："开了就行"——规则最终生效由 checkFirewall 兜底（下次操作验证）。
 * sudo 场景：命令带 sudo -n（非交互，绝不挂起等密码）。
 */
function fireAsync(cmd: string, args: string[], sudo = false): void {
  const realCmd = sudo ? "sudo" : cmd;
  const realArgs = sudo ? ["-n", ...(cmd ? [cmd, ...args] : args)] : args;
  try {
    const child = spawn(realCmd, realArgs, { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
    child.unref();
  } catch { /* best effort — checkFirewall 兜底 */ }
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
    // macOS：pf **默认未启用**（Disabled）——无防火墙拦截，入站端口天然可达，
    // 视为已放行。仅 pf Enabled 时才需要解析规则（且规则匹配太脆，尽力而为）。
    const cmd = await resolveCmd("pfctl");
    if (!cmd) return { backend: "pfctl", allowed: false, detail: "pfctl detected but not executable" };
    const info = await run(cmd, ["-s", "info"]);
    const enabled = /Status:\s+Enabled/i.test(info.stdout);
    if (!enabled) return { backend: "pfctl", allowed: true, detail: "pf disabled — no firewall filtering (macOS default)" };
    const r = await run(cmd, ["-sr"]);
    const allowed = r.ok && new RegExp(`dport\\s*=\\s*${port}`).test(r.stdout);
    return { backend: "pfctl", allowed, detail: allowed ? "pf anchor rule allows" : "pf enabled but no explicit allow for this port" };
  }
  if (b === "windows") {
    // netsh advfirewall：规则名 service-tunnels:<port> 存在 → 已放行（我们自己建的，
    // 名字即身份）。注意（F15）：① netsh show 对无匹配规则也 exit 0——必须解析
    // 输出而非看退出码；② 输出随系统语言变化（中文："已启用: 是"）——不能只
    // 匹配英文 Enabled/Yes。规则存在且启用字段非"否/No"即视为放行。
    const r = await run("netsh", ["advfirewall", "firewall", "show", "rule", `name=service-tunnels:${port}`], 8000);
    const hasRule = r.ok && r.stdout.includes(`service-tunnels:${port}`);
    const disabled =
      /(?:已启用|Enabled)\s*[:：]\s*(?:否|No)/i.test(r.stdout);
    const allowed = hasRule && !disabled;
    return {
      backend: "windows",
      allowed,
      detail: allowed ? "netsh rule allows" : "netsh: no service-tunnels rule (or disabled)",
    };
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
  // 一次探测 passwordless sudo（-n true）；false 时直接给手动命令。
  const sudoAvailable = (await sudoRun(["true"])).ok;

  // 所有后端统一异步 fire-and-forget：spawn 发起即返回（不阻塞 expose 流程），
  // 规则最终生效由 checkFirewall 兜底。非 admin/sudo 不可用时命令会失败——
  // 不弹 UAC（spawn 不走 ShellExecute runas），服务场景（无桌面）也安全。
  const desktop = await hasDesktop();
  const desktopNote = desktop ? "desktop: yes" : "desktop: no — service mode, no interactive prompt";

  if (b === "windows") {
    const addArgs = ["advfirewall", "firewall", "add", "rule", `name=service-tunnels:${port}`, "dir=in", "action=allow", "protocol=TCP", `localport=${port}`];
    fireAsync("netsh", addArgs);
    return {
      backend: "windows",
      ensured: true,
      detail: `netsh add rule dispatched async (${desktopNote}) — verify with checkFirewall; manual: netsh advfirewall firewall add rule name="service-tunnels:${port}" dir=in action=allow protocol=TCP localport=${port}`,
    };
  }
  // root（uid 0）不需要 sudo；非 root 且 passwordless sudo 可用才加 -n
  const needSudo = process.platform !== "win32" && process.getuid?.() !== 0 && sudoAvailable;
  if (b === "ufw") {
    const args = ["allow", "in", "to", ip, "port", String(port), "proto", "tcp"];
    fireAsync(bin ?? "ufw", args, needSudo);
    return { backend: "ufw", ensured: true, detail: `ufw allow dispatched async (${desktopNote}); manual: sudo ufw allow in to ${ip} port ${port} proto tcp` };
  }
  if (b === "firewalld") {
    const args = ["--permanent", `--add-port=${port}/tcp`];
    fireAsync(bin ?? "firewall-cmd", args, needSudo);
    fireAsync(bin ?? "firewall-cmd", ["--reload"], needSudo);
    return { backend: "firewalld", ensured: true, detail: `firewall-cmd --permanent --add-port=${port}/tcp + reload dispatched async (${desktopNote})` };
  }
  if (b === "iptables") {
    const args = ["-I", "INPUT", "1", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT", "-m", "comment", "--comment", `service-tunnels:${port}`];
    fireAsync(bin ?? "iptables", args, needSudo);
    return { backend: "iptables", ensured: true, detail: `iptables ACCEPT ${port} dispatched async (${desktopNote}); manual: sudo iptables -I INPUT 1 -p tcp --dport ${port} -j ACCEPT` };
  }
  if (b === "pfctl") {
    // pf Disabled（macOS 默认）→ 无拦截，无需放行。Enabled → 需手动 anchor 规则
    // （修改 pf.conf 需 root 且语法复杂，不给自动执行——给手动指引）。
    const info = await run("pfctl", ["-s", "info"], 5000);
    if (!/Status:\s+Enabled/i.test(info.stdout)) {
      return { backend: "pfctl", ensured: true, detail: "pf disabled — no firewall filtering (macOS default)" };
    }
    return {
      backend: "pfctl",
      ensured: false,
      detail: `macOS pf enabled — manual anchor rule required (sudo pfctl -a service-tunnels -f <(echo "pass in proto tcp from any to any port ${port}") && sudo pfctl -e)`,
    };
  }
  return { backend: "none", ensured: false, detail: "no firewall backend detected — cannot verify/open" };
}

/** 删除放行规则（stop 映射时清理本次添加的规则；只删不报错——best effort）。 */
export async function removeFirewall(ip: string, port: number, backend?: FirewallBackend): Promise<void> {
  const b = backend ?? (await detectFirewall());
  const bin = await resolveCmd(b === "ufw" ? "ufw" : b === "firewalld" ? "firewall-cmd" : b === "iptables" ? "iptables" : b === "windows" ? "netsh" : "pfctl");
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
  } else if (b === "windows") {
    // 删除重试 2 次：异步 add（fire-and-forget）可能晚于 delete 完成——删了又被
    // 加回。重试 + 间隔消除该竞态（stop 路径不要求即时，可稍等）。
    for (let i = 0; i < 2; i++) {
      try {
        await run("netsh", ["advfirewall", "firewall", "delete", "rule", `name=service-tunnels:${port}`], 10_000);
      } catch { /* best effort */ }
      if (i === 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
}
