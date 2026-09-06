import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { createServer } from "net";
import { homedir, platform } from "os";
import { dirname, join } from "path";
import { validateSiteName } from "./sites.ts";

/**
 * auth-only（仅认证模式）设置与产物生成。
 *
 * `authsetup` 一次性把 admin 端口 / auth 端口 / basePath / site（存储位置）
 * 定好，写入配置 `configDir/auth/<base>.json`，并生成：
 *   - `~/.local/bin/auth-admin-<base>.sh/.bat`   Web 管理界面（调 user/site）
 *   - `~/.local/bin/auth-server-<base>.sh/.bat`  仅认证服务（可配 systemd）
 *   - `configDir/auth/nginx-auth-<base>.conf`    nginx auth_request 接入碎片
 *   - `configDir/auth/auth-server-<base>.service` systemd unit（--with-systemd）
 *
 * `<base>` = basePath 去首斜杠（如 /nhgf → "nhgf"）——脚本/配置名都带 basePath，
 * 多配置天然隔离（每个 basePath 一套独立端口 + site 存储）。
 */

export interface AuthSetupConfig {
  /** basePath 去首斜杠（如 "nhgf"）——文件/脚本名前缀。 */
  base: string;
  /** 认证服务 basePath（如 "/nhgf"），nginx 登录页/探针路径前缀。 */
  basePath: string;
  /** 认证 realm / 存储位置（如 "rfgu"）——portal 用户库隔离目录。 */
  site: string;
  /** Web 管理界面端口（`st ui`）。 */
  adminPort: number;
  /** 仅认证服务端口（nginx auth_request 上游）。 */
  authPort: number;
  /** 认证服务监听地址（缺省 127.0.0.1）。 */
  listen: string;
  policy: "one_factor" | "two_factor" | "deny";
  configDir: string;
  cacheDir: string;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** 随机小写字母串（basePath/site 用；避开数字避免与端口混淆）。 */
export function randomLabel(len = 4): string {
  let out = "";
  for (let i = 0; i < len; i++) out += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return out;
}

/** 随机 basePath："/" + 4-5 位小写字母（如 /nhgf）。 */
export function randomBasePath(): string {
  return "/" + randomLabel(4 + Math.floor(Math.random() * 2));
}

/** 随机 site 名（存储位置，如 rfgu）。 */
export function randomSite(): string {
  return randomLabel(4 + Math.floor(Math.random() * 2));
}

/** 探测一个空闲本地端口（bind 0 → 关闭 → 返回实际端口）。 */
export async function pickFreePort(avoid = 0): Promise<number> {
  for (;;) {
    const p = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
    if (p !== avoid) return p;
  }
}

export function authDir(configDir: string): string {
  return join(configDir, "auth");
}

export function authConfigPath(configDir: string, base: string): string {
  return join(authDir(configDir), `${base}.json`);
}

/** 读取 `configDir/auth/<base>.json`（松散，缺/坏 → null）。 */
export function readAuthConfig(configDir: string, base: string): AuthSetupConfig | null {
  try {
    const raw = JSON.parse(readFileSync(authConfigPath(configDir, base), "utf8")) as Partial<AuthSetupConfig>;
    if (!raw || typeof raw !== "object" || !raw.basePath || !raw.site || !raw.authPort) return null;
    return {
      base: raw.base ?? raw.basePath.replace(/^\//, ""),
      basePath: raw.basePath,
      site: raw.site,
      adminPort: Number(raw.adminPort) || 0,
      authPort: Number(raw.authPort) || 0,
      listen: raw.listen ?? "127.0.0.1",
      policy: (raw.policy as AuthSetupConfig["policy"]) ?? "one_factor",
      configDir: raw.configDir ?? configDir,
      cacheDir: raw.cacheDir ?? "",
    };
  } catch {
    return null;
  }
}

/** 列出 configDir/auth/ 下所有配置（按 base）。 */
export function listAuthConfigs(configDir: string): AuthSetupConfig[] {
  const dir = authDir(configDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => readAuthConfig(configDir, f.replace(/\.json$/, "")))
    .filter((c): c is AuthSetupConfig => c !== null);
}

/** 原子写配置（tmp + rename，0600）。 */
export function writeAuthConfig(configDir: string, cfg: AuthSetupConfig): void {
  const file = authConfigPath(configDir, cfg.base);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  renameSync(tmp, file);
}

/** 移除 `configDir/auth/<base>.json`。 */
export function removeAuthConfig(configDir: string, base: string): void {
  rmSync(authConfigPath(configDir, base), { force: true });
}

/** 默认可执行脚本目录：Linux `~/.local/bin`（已在 PATH）；Windows 用户目录。 */
export function defaultBinDir(): string {
  return platform() === "win32" ? homedir() : join(homedir(), ".local", "bin");
}

// ── 脚本 / nginx / systemd 渲染 ─────────────────────────────────────

/** 解析脚本调用的 CLI 命令：优先 PATH 里的 sts/service-tunnels（bin 注册名）；
 *  否则用当前进程的 node + cli 入口（源码 / 安装部署均可靠）。返回 shell 可直接
 *  exec 的字符串（含引号）。 */
export function resolveCliInvocation(cliPath = process.argv[1] ?? ""): string {
  const names = ["sts", "service-tunnels"];
  for (const n of names) {
    try {
      execFileSync("which", [n], { stdio: "ignore" });
      return n;
    } catch {
      // next
    }
  }
  if (cliPath && /[\/\\]cli\.(js|mjs|ts)$/.test(cliPath)) {
    return `node "${cliPath}"`;
  }
  return "sts";
}


/** bash 管理界面脚本（`st ui`）。 */
export function renderAdminBash(cfg: AuthSetupConfig, cli = "st"): string {
  return `#!/usr/bin/env bash
# service-tunnels 仅认证模式 · Web 管理界面（base=${cfg.base}，site=${cfg.site}）
# 调整用户 / site。调整完成后启动 auth-server-${cfg.base}（认证服务）。
# 认证服务运行期间本界面不常驻 —— 用完可 Ctrl-C 关闭。
set -euo pipefail
exec ${cli} ui --port ${cfg.adminPort} --config-dir "${cfg.configDir}" --cache-dir "${cfg.cacheDir}"
`;
}

/** bash 认证服务脚本（`st authonly start`，前台 = systemd Type=simple 可直接用）。 */
export function renderServerBash(cfg: AuthSetupConfig, cli = "st"): string {
  return `#!/usr/bin/env bash
# service-tunnels 仅认证模式 · 认证服务（base=${cfg.base}，site=${cfg.site}）
# 前台常驻：nginx auth_request 上游 + 登录页。无管理界面（更安全）。
# systemd: ExecStart=$(basename "$0")   （Type=simple）
set -euo pipefail
exec ${cli} authonly start --port ${cfg.authPort} --base-path ${cfg.basePath} --site ${cfg.site} \\
  --listen ${cfg.listen} --policy ${cfg.policy} \\
  --config-dir "${cfg.configDir}" --cache-dir "${cfg.cacheDir}"
`;
}

/** Windows bat 管理界面脚本。 */
export function renderAdminBat(cfg: AuthSetupConfig, cli = "st"): string {
  return `@echo off
REM service-tunnels 仅认证模式 - Web 管理界面 (base=${cfg.base}, site=${cfg.site})
REM 调整用户 / site。调整完成后运行 auth-server-${cfg.base}.bat（认证服务）。
${cli} ui --port ${cfg.adminPort} --config-dir "${cfg.configDir}" --cache-dir "${cfg.cacheDir}"
`;
}

/** Windows bat 认证服务脚本。 */
export function renderServerBat(cfg: AuthSetupConfig, cli = "st"): string {
  return `@echo off
REM service-tunnels 仅认证模式 - 认证服务 (base=${cfg.base}, site=${cfg.site})
REM 前台常驻：nginx auth_request 上游 + 登录页。无管理界面。
${cli} authonly start --port ${cfg.authPort} --base-path ${cfg.basePath} --site ${cfg.site} --listen ${cfg.listen} --policy ${cfg.policy} --config-dir "${cfg.configDir}" --cache-dir "${cfg.cacheDir}"
`;
}

/** nginx auth_request 接入碎片（替换 authelia 的 auth_request 配置）。
 *  用户放入受保护应用的 server{} 块。 */
export function renderNginxFragment(cfg: AuthSetupConfig): string {
  const probe = `${cfg.basePath}/api/authz/auth-request`.replace(/^\//, "");
  return `# ── service-tunnels 仅认证模式：替换 authelia 的接入碎片 ──
# base=${cfg.base}  site=${cfg.site}  auth 上游: ${cfg.listen}:${cfg.authPort}
# 放入受保护应用的 server{} 块。

# 1) auth_request 探针（internal 子请求）
location = /${probe} {
    internal;
    proxy_pass http://${cfg.listen}:${cfg.authPort}/${probe};
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;               # 会话判定必须带 Cookie
    proxy_set_header X-Original-URL https://$host$request_uri;
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}

# 2) 登录页 / 2FA / 登出（直达，不走探针）
location ${cfg.basePath} {
    proxy_pass http://${cfg.listen}:${cfg.authPort}${cfg.basePath};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

# 3) 受保护应用：未认证 401 → 302 登录页
location / {
    auth_request /${probe};
    error_page 401 = @st_auth_login;
    # …… 你的应用 proxy_pass 等原有配置 …… 
}

location @st_auth_login {
    internal;
    return 302 https://$host${cfg.basePath}/login?next=$request_uri;
}
`;
}

/** systemd unit 模板（--with-systemd 时生成到 out 目录）。 */
export function renderSystemdUnit(cfg: AuthSetupConfig, scriptPath: string): string {
  return `# install: sudo cp "$(basename $0)" /etc/systemd/system/  → 改 ExecStart 为实际脚本路径
[Unit]
Description=service-tunnels auth-only (base=${cfg.base}, site=${cfg.site})
After=network.target

[Service]
Type=simple
ExecStart=${scriptPath}
Restart=on-failure
RestartSec=2
# 仅认证服务无管理界面 —— 如需调整用户/site，停掉后跑 auth-admin-${cfg.base}。

[Install]
WantedBy=multi-user.target
`;
}

/** fail2ban filter（读 nginx access.log 的 401/429，按真实客户端 IP 计数）：
 *  与 portal 自带 per-IP 封禁互补——portal 层封的是应用内会话，fail2ban 在
 *  nginx 层直接 drop 攻击 IP（更早拦截、无需让请求打到认证服务）。
 *  安装：
 *    sudo cp fail2ban-auth-<base>.conf  /etc/fail2ban/filter.d/st-auth-<base>.conf
 *    sudo cp jail.d 行 → /etc/fail2ban/jail.d/st-auth-<base>.conf
 *    sudo systemctl restart fail2ban
 *  注意：访问日志需在真实 IP 可见的层（nginx 边缘或已配 real_ip）。 */
export function renderFail2banFilter(cfg: AuthSetupConfig): string {
  return `# fail2ban filter: service-tunnels auth-only (base=${cfg.base}, site=${cfg.site})
# 匹配 nginx access.log 里登录失败（401）与已被 portal 限速（429）的行。
# 日志格式依赖 nginx 默认 combined（$remote_addr - ... "POST ..." 401）。
[Definition]
failregex = ^<HOST> -.*"(?:POST|GET) ${cfg.basePath}/login.*" (?:401|429)
            ^<HOST> -.*"(?:POST|GET) ${cfg.basePath}/login/2fa.*" (?:401|429)
datepattern = %%d/%%b/%%Y:%%H:%%M:%%S %%z
ignoreregex =
`;
}

/** fail2ban jail（5 次/10 分钟 → 封 1 小时；与 portal MAX_RETRIES=5 对齐）。 */
export function renderFail2banJail(cfg: AuthSetupConfig): string {
  return `# fail2ban jail: service-tunnels auth-only (base=${cfg.base}, site=${cfg.site})
# 安装: cp 本文件 /etc/fail2ban/jail.d/st-auth-${cfg.base}.conf  +  systemctl restart fail2ban
# 日志路径改为你系统 nginx 的实际 access_log（本文件默认 /var/log/nginx/access.log）。
[st-auth-${cfg.base}]
enabled = true
port = http,https
filter = st-auth-${cfg.base}
logpath = /var/log/nginx/access.log
maxretry = 5
findtime = 600
bantime = 3600
# 封禁动作（默认 iptables-multiport；云主机可选 firewallcmd-ipset）
action = %(action_mwl)s
`;
}

/** Windows 服务安装脚本（install-service-<base>.bat）：优先 nssm（自动重启/日志），
 *  缺 nssm 时回退 `sc.exe create`（node 直跑 cli.js）。admin 权限运行。
 *  卸载对应 uninstall-service-<base>.bat。cliPath = 绝对 cli.js 路径（node 直跑）。 */
export function renderWindowsServiceInstall(cfg: AuthSetupConfig, cliPath = ""): string {
  const svc = `st-authonly-${cfg.base}`;
  const args = `authonly start --port ${cfg.authPort} --base-path ${cfg.basePath} --site ${cfg.site} --listen ${cfg.listen} --policy ${cfg.policy} --config-dir \"${cfg.configDir}\" --cache-dir \"${cfg.cacheDir}\"`;
  return `@echo off
REM service-tunnels 仅认证模式 - Windows 服务安装 (base=${cfg.base}, site=${cfg.site})
REM 以管理员身份运行本脚本。卸载: uninstall-service-${cfg.base}.bat
setlocal
set SVC=${svc}
set NODE=node
where node >nul 2>nul || (echo [ERR] node 不在 PATH && exit /b 1)
set CLI=${cliPath.replace(/\\/g, "\\\\")}

REM 优先 nssm（自动重启 + 日志重定向）
where nssm >nul 2>nul
if %errorlevel%==0 (
  echo [nssm] 安装服务 %SVC% ...
  nssm install %SVC% "%NODE%" "%CLI%" ${args}
  nssm set %SVC% AppStdout "%ProgramData%\\service-tunnels\\authonly-${cfg.base}.out.log"
  nssm set %SVC% AppStderr "%ProgramData%\\service-tunnels\\authonly-${cfg.base}.err.log"
  nssm set %SVC% Start SERVICE_AUTO_START
  nssm start %SVC%
  goto :done
)

REM 回退 sc.exe（node 直跑，无自动重启/日志重定向）
set SVCBIN="%NODE%" "%CLI%"
sc create %SVC% binPath= "%SVCBIN%" start= auto DisplayName= "service-tunnels auth-only ${cfg.base}"
sc description %SVC% "service-tunnels auth-only (base=${cfg.base}, site=${cfg.site})"
sc start %SVC%

:done
sc query %SVC% | findstr STATE
echo 服务 %SVC% 安装完成。nginx auth_request 接入见 out/nginx-auth-${cfg.base}.conf
exit /b 0
`;
}

/** Windows 服务卸载脚本（uninstall-service-<base>.bat）。 */
export function renderWindowsServiceUninstall(cfg: AuthSetupConfig): string {
  const svc = `st-authonly-${cfg.base}`;
  return `@echo off
REM service-tunnels 仅认证模式 - Windows 服务卸载 (base=${cfg.base})
REM 以管理员身份运行本脚本。
setlocal
set SVC=${svc}
sc stop %SVC% >nul 2>nul
where nssm >nul 2>nul && (nssm remove %SVC% confirm) || (sc delete %SVC%)
sc query %SVC% >nul 2>nul
if %errorlevel%==0 (echo [ERR] 服务仍存在，请手动检查) else (echo 服务 %SVC% 已卸载)
exit /b 0
`;
}

/** 默认产物目录：非可执行产物（nginx/systemd/配置）默认 configDir/auth。 */
export function defaultOutDir(configDir: string): string {
  return authDir(configDir);
}
