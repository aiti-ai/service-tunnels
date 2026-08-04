# service-tunnels — 设计方案

> 独立的 npm 包 + CLI：本地服务端口的**发现**、**泛域名代理**、以及配合
> nginx / Authelia / Redis 的**公网隧道（ngrok / frpc / ssh / cloudflared）启停**。
> 从 pi-web 的 `lib/service-ports.ts`、`proxy.ts`、`lib/tunnels.ts` 抽取泛化而来，
> 不依赖 Next.js，可被任何 Node 应用（包括 pi-web）作为库调用，也提供独立 CLI。
>
> 认证部分的设计依据见 pi-web `docs/tunnel-auth-automation.md`（本会话调研产出）。

---

## 1. 定位与目标

| 能力 | 说明 |
|---|---|
| **发现** | 列出"当前进程"（或指定 pid）及其**子进程树**中监听的所有 TCP 端口（跨平台：Linux /proc、macOS ps+lsof、Windows PowerShell+netstat），发现缓存即代理白名单 |
| **泛域名代理** | 零依赖 Node 反代：`<port>.pi.localhost`（及可配置后缀）→ `http://127.0.0.1:<port>`，路径原样透传（绝对路径资源/SPA/表单天然可用），basePath 可选剥离 |
| **公网隧道** | ngrok / frpc / ssh -R / cloudflared 的启停、URL 解析、状态管理；**配合本地 nginx 网关 + 可插拔认证 provider** 提供统一访问控制（见 §5；内置 Authelia，预留插件） |
| **绿色启动** | 自动检测/下载 Authelia、nginx 单二进制到缓存目录；Redis 检测或包管理器安装；全部进程可一键启停、退出清理 |
| **双形态** | npm 库（调用方指定 config/cache 目录）+ CLI（接受端口或 pid） |

## 2. 目录规范（XDG 兼容）

```
~/.config/service-tunnels/      # 固定配置（用户可编辑，0600）
  config.json                   # 主配置：后缀、默认隧道、认证开关、目录覆盖
  tunnels.json                  # 隧道清单（名称→命令/类型/参数），等价 pi-web 的 PI_WEB_TUNNELS
  users.yml                     # Authelia 用户库（authentication_backend file），可手编
~/.cache/service-tunnels/       # 下载与临时产物（可删除重建）
  bin/                          # 下载的单二进制（authelia、nginx；redis 走系统/包管理器）
  tmp/                          # 生成的 nginx 配置、Authelia 动态配置、ngrok policy、隧道日志
  data/                         # sqlite、redis AOF、通知文件（运行时数据）
  state.json                    # 运行时状态（隧道 pid/url、内部端口、cookie domain 登记、daemon 端口）
  daemon.sock                   # CLI 模式的 daemon IPC socket（unix socket；Windows 用 TCP）
```

- **库调用时** `createServiceTunnels({ configDir, cacheDir })` 可完全覆盖这两个位置
  （如 pi-web 用 `~/.pi/agent/` 或项目内目录）。
- 环境变量 `SERVICE_TUNNELS_CONFIG` / `SERVICE_TUNNELS_CACHE` 可覆盖 CLI 默认值。

## 3. 架构总览

```
                         ┌────────────────────────────────────────────┐
 调用方 / CLI ──────────▶│  service-tunnels (npm 包)                 │
   │                     │                                            │
   │  库模式：进程内      │  discovery.ts  进程树 BFS + 角色标记排除    │
   │  CLI 模式：daemon   │  proxy.ts      Node http 泛域名反代         │
   │  ── IPC socket ───▶ │  tunnels/*     ngrok frpc ssh cloudflared  │
   │                     │  gateway.ts    nginx 配置生成 + 启停/热重载 │
   │                     │  authelia.ts   绿色启动 + 动态登记 + 重启    │
   │                     │  redis.ts      绿色 redis 启停              │
   │                     │  internal.ts   辅助进程端口注册表（排除发现）│
   │                     │  tools.ts      工具解析+下载（PATH>缓存>官方>镜像）│
   │                     │  daemon.ts     CLI 常驻 + HTTP/socket IPC   │
   │                     │  lifecycle.ts  编排 + 退出清理              │
   └────────────────────▶└──────────────┬─────────────────────────────┘
   （CLI 经 daemon.sock 转发）          │ spawn（全部带角色标记）
              ┌───────────────┬─────────┴──────────┬─────────────────┐
              ▼               ▼                    ▼                 ▼
         nginx (辅助)      Authelia (辅助)      redis-server (辅助)  隧道进程 ×N
        127.0.0.1:4180   127.0.0.1:9091       127.0.0.1:随机      ngrok/frpc/ssh
        多域名 Host 路由   /authelia base path  AOF 落盘           → 公网域名
              └──────────────┴────────────────────┴──────────────────┘
               全部登记到 internal 注册表，**不进入端口发现结果**
```

**两种暴露模式**：

| 模式 | 组成 | 适用 |
|---|---|---|
| **proxy（局域网/本机）** | 内置 Node 泛域名反代，零依赖 | 同机/局域网访问测试服务（`5173.pi.localhost`），无认证 |
| **expose（公网 + 认证）** | 隧道进程 + nginx 网关 + Authelia + Redis | 公网暴露并统一登录（见 §5），隧道按需启停 |

## 4. 模块设计

### 4.1 discovery.ts —— 进程与端口发现

- 根进程 = 当前进程（CLI 模式）；库/CLI 可用 `--pid` 指定任意根（扫描该进程的
  后代）；`--self` 回退当前进程。
- 复用 pi-web 实现并泛化：
  - **Linux**：`/proc/<pid>/task/*/children` BFS + `PI_WEB_CHILD_MARKER` 类环境标记
    （`SERVICE_TUNNELS_CHILD_MARKER`）跨 re-parent 兜底；`/proc/<pid>/fd` socket
    inode → `/proc/net/tcp{,6}` LISTEN 表；通配绑定展开为本机地址。
  - **macOS**：`ps -axo pid=,ppid=,command=` + `lsof -nP -iTCP -sTCP:LISTEN`。
  - **Windows**：PowerShell `Get-CimInstance Win32_Process` + `netstat -ano`。
- 输出 `ServicePort { port, pid, process, cmdline, addresses[] }`；5s TTL 缓存，
  **缓存即白名单**（未发现端口永不代理）。
- 排除自身进程链（cmdline 特征 `service-tunnels` 自身 / 调用方传入的
  `excludeCmdline` 正则）。
- **排除框架辅助进程端口**（nginx/authelia/redis 等自己拉起的服务）：
  - 辅助进程 spawn 时注入环境标记 `SERVICE_TUNNELS_ROLE=<role>`（子进程继承），
    发现时凡携带该标记的进程直接跳过；
  - 双保险：辅助进程监听端口同时登记进**内部端口注册表**
    `internalPorts: Map<role, ServicePortInfo>`，发现结果聚合时按注册表过滤；
  - 因此 `discoverPorts()` 只返回**用户测试服务**端口；框架内部端口通过
    `st.internal.list()` 单独暴露（`[{ role: "nginx", port: 4180 }, ...]`），
    两者**互不混同**。

### 4.2 proxy.ts —— 泛域名反代（零依赖）

- 原生 `node:http` 服务器，`Host: <port><suffix>` 正则匹配（端口 2-5 位 + 后缀
  列表：`.pi.localhost` 内置 + 配置后缀 + 配置域名，优先级排列）。
- 匹配到 → `http.request` 转发到 `127.0.0.1:<port>`，路径/查询原样透传
  （可选 `stripBasePath`，配置 `basePath`）；流式透传（SSE ✅），WebSocket
  upgrade 转发（Node `http` + `'upgrade'` 事件，可选开关）。
- 安全门：端口必须命中发现缓存（403）；可选 Basic 密码（配置 `password`，
  复用 pi-web 的 web-auth 逻辑）；只代理 `127.0.0.1`（代码写死）。
- 无认证/无隧道时这是唯一的暴露路径，适合局域网开发。

### 4.3 gateway.ts —— nginx 网关（认证模式的本地反代）

- 每"暴露组"生成一份 nginx 配置：**多域名 Host 路由**（每个公网域名一个
  `server_name` 块：`location /` 反代到对应测试端口 + `auth_request` 保护，
  `location /authelia/` 反代到本地 Authelia base path）。
- 新域名 = 追加 server 块 + `nginx -t` 预校验 → `nginx -s reload`（毫秒级热重载，
  不丢连接）；配置写坏自动回滚上一份。
- nginx 二进制：PATH 检测 → 无则下载官方 linux 包到 `cache/bin`（Windows 用
  官方 zip；macOS 提示 brew）。
- 守护进程模型：nginx master 由本包 spawn，退出时清理。

### 4.4 authelia.ts —— 绿色启动 + 动态登记

- **绿色启动**（依赖调研 3.8）：
  - PATH 检测 `authelia`；无则下载官方 release tar.gz（linux amd64/arm/arm64，
    macOS 提示 `brew install authelia`）到 `cache/bin`；
  - 生成预配置：`server.address: tcp://127.0.0.1:<随机端口>/authelia`、SQLite、
    filesystem notifier、file 用户库（初始用户 + 随机密码 hash 打印/存储）、
    NTP 禁用；`session.cookies` 与 `access_control` 放**动态文件**
    `config-tunnels.yml`（§4.7）。
- **动态登记**：隧道 URL 解析出主机名后，原子重写 `config-tunnels.yml`
  （`session.cookies` 枚举 + `access_control` 用 `domain_regex` 一条覆盖一类域名，
  见调研 3.7）→ `authelia config validate` 预校验 → 重启 Authelia（Redis 兜底
  会话不丢）。
- 启动参数 `--config configuration.yml --config config-tunnels.yml`。

### 4.5 redis.ts —— 会话持久化

- 检测 `redis-server`；无则按平台提示/执行安装（Debian `apt-get install -y
  redis-server`、RHEL `dnf install -y redis`、macOS `brew install redis`；
  `sudo -n true` 探测免密 sudo，无权限则弹窗给命令）。
- 启动：`redis-server --bind 127.0.0.1 --port <随机端口> --appendonly yes
  --dir <cache/data>` —— 进程级运行，不用系统服务。
- **永远一个实例**，多 Authelia/多域名共享（同一 `session.secret`）。

### 4.6 tunnels/ —— 隧道进程管理

- `TunnelConfig { name, type: "ngrok"|"frpc"|"ssh"|"cloudflared"|"localtunnel"|"command",
  target, args?, auth? }`，存 `~/.config/service-tunnels/tunnels.json`。
  支持矩阵：

  | type | 实现 | 公网域名 | 认证 |
  |---|---|---|---|
  | `ngrok` | 官方 agent，多 endpoint / `--domain` 固定 | ngrok-free.app / 自有 | **统一走网关** |
  | `frpc` | `frpc.ini` 生成（`type=http local_port=<端口> custom_domains=<域名>`），URL 取自定义域名 | frps 自定义域名 | **统一走网关** |
  | `ssh` | `ssh -R 80:127.0.0.1:<端口> <host>`——**serveo.net** 等 SSH 反向隧道服务即此类型 | serveo.net 随机/固定前缀 | **统一走网关** |
  | `cloudflared` | quick tunnel（随机 trycloudflare，**无 SSE**）或 named tunnel 多 ingress | trycloudflare.com / 自有域名 | **统一走网关** |
  | `localtunnel` | `lt --port <端口>`（或 `npx localtunnel`），URL 从输出解析 | loca.lt 随机 | **统一走网关** |
  | `command` | 任意命令兜底（同 pi-web 的 PI_WEB_TUNNELS cmd 形态） | 解析输出 | **统一走网关** |

  **认证与隧道类型解耦**：所有隧道进程都只是"公网 URL → 本地 nginx 端口"的透传
  通道，认证统一在**本地端口侧**（nginx auth_request → 认证 provider）完成——
  与隧道工具无关，随机/固定域名都走同一套动态登记（§4.7/§5）。

- 通用生命周期：spawn（shell/二进制）→ 输出缓冲 → URL 解析
  （已知域名：ngrok.io/ngrok-free.app/trycloudflare.com/loca.lt/serveo.net/
  wormhole.app/localhost.run/hop.to + 首个非 localhost URL 兜底）→ 状态上报 →
  停止 kill 进程组。
- **ngrok**：与其它隧道相同——透传到 nginx 端口、走统一认证。可选优化：
  若不想在本地跑认证进程，ngrok 可用边缘 `edge-oidc`（Traffic Policy
  `openid-connect` action，回调固定 idp.ngrok.com，调研路径 A），作为 provider
  插件的一种（§5.2 `edge-auth` 能力）。
- **frpc**：从配置读取 `server_addr`/token；`frpc.ini` 生成；URL =
  `http://<域名>`（frps 分配的域名由配置/回调告知，支持 `--url` 覆盖）。
- **ssh（serveo 等）**：`ssh -R 80:127.0.0.1:<端口> <host>`，URL 从输出解析；
  需要免密/密钥自动应答（`-o StrictHostKeyChecking=accept-new`）。
- **localtunnel**：`lt --port <端口>`，URL 从输出解析；随机域名同样可用——
  每次启动拿到新主机名走**动态登记**（写 config-tunnels.yml + validate + 重启
  Authelia）即认领（见 §4.7/§5.4）；`--subdomain <固定前缀>` 只是"首次登记后不再
  重启 Authelia"的优化选项，非必需。
- **cloudflared**：quick tunnel（随机 trycloudflare，无 SSE）或 named tunnel
  多 ingress（多域名 → nginx 网关）。
- 多进程：**每域名一个隧道进程**，用户按需启停（调研最终架构）。

### 4.7 auth 编排（expose 模式，provider 化）

`service-tunnels expose <port> [--tunnel ngrok] [--auth [<provider>]]` 一键流程：

```
1. discovery 确认 <port> 在发现缓存（否则拒绝）
2. 分配本地随机端口；生成/追加 nginx server 块（server_name 占位）→ nginx -s reload
3. spawn 隧道进程 → 解析公网主机名
4. 用主机名回填 nginx server_name → reload
5. Authelia 动态登记：重写 config-tunnels.yml（cookie domain + domain_regex 规则）
   → config validate → 重启 Authelia（**随机域名同样适用**：每次拿到新主机名走
   同一流程认领；固定前缀/固定域名则首次登记后隧道重启无需再重启 Authelia）
6. 状态写入 state.json；输出公网 URL（弹窗/CLI 打印）
7. stop <port|name>：杀隧道进程 → 移除 nginx server 块 reload → 移除 cookie 登记
   （若域名固定可保留）
```

### 4.8 tools.ts —— 工具解析与自动下载

- **解析优先级（所有外部命令统一）**：`toolPaths.<name>`（调用方/配置显式指定）
  > 系统 PATH（直接用，不下载）> `cacheDir/bin`（已下载）> 自动下载；
- **下载源**：官方 URL 模板优先（`{version}/{platform}/{arch}` 替换），失败自动
  切换中国镜像（ghproxy 前缀替换 `{official}`、npm 工具 npmmirror），`preferMirrors`
  可强制镜像优先（CN 网络）；镜像可按工具在 `toolMirrors` 覆盖；
- 下载物：单二进制直接落 `cache/bin`；tar.gz 解压 strip 后取 binPath；`--version`
  校验；原子 rename 防半成品；平台无构建（如 authelia 无 Windows）→ 明确报错并
  提示 WSL2/Docker/apt；
- 内置工具表：ngrok（equinox）、frpc/cloudflared/authelia（GitHub + ghproxy）、
  localtunnel（npm/npmmirror）；nginx/redis 走系统（无下载，apt 提示）；
- CLI `tools list/resolve/download`；库 `st.tools.ensure/resolve/list`。

### 4.9 internal.ts —— 辅助进程端口注册表

- 框架 spawn 的每个辅助进程（nginx/authelia/redis）成功后，把 `{ role, pid,
  port, addresses }` 写入 `internalPorts`（内存 + state.json）；
- `st.internal.list()` → 调用方可用（如 pi-web 的 ServicesDialog 展示"框架服务"
  或做健康检查）；**不影响** `discoverPorts()` 的结果；
- 辅助进程退出 → 从注册表移除。

### 4.9 进程模型 —— 库模式 vs CLI daemon（常驻进程方案）

CLI 每次执行是独立短命进程，而 nginx/authelia/redis/隧道需要**常驻**。两种模式：

**库模式（进程内）**：调用方（如 pi-web）直接 `createServiceTunnels()`，manager
在调用方进程内常驻；辅助进程与隧道进程都是调用方的后代（带角色标记），无需 IPC。

**CLI 模式（daemon）**：

```text
service-tunnels daemon start [--foreground]   # 默认后台 detached 常驻（--foreground 前台调试）
service-tunnels daemon stop | status | logs
```

- `daemon start` spawn 一个 detached 的后台进程（setsid/`detached: true`，脱离
  终端），它持有全部辅助进程 + 隧道进程；PID 与监听地址原子写入
  `~/.cache/service-tunnels/state.json`；
- daemon 暴露 IPC：unix socket `~/.cache/service-tunnels/daemon.sock`
  （Windows：`127.0.0.1:<随机端口>`，端口记在 state.json），JSON-RPC over
  socket；进程退出（SIGTERM/exit）时统一清理全部子进程；
- **其他命令如何连接常驻服务**：`discover`/`proxy`/`tunnel`/`expose`/`auth`/
  `gateway` 启动时先读 `state.json`：
  1. daemon 在运行（pid 存活）→ 经 daemon.sock 转发操作；
  2. daemon 未运行 → 提示 `service-tunnels daemon start`（或 `--auto-daemon`
     自动拉起，适合脚本）；
  3. 纯查询命令（`discover` 基于进程树，`status` 读 state.json）无需 daemon 也可
     直接执行；
- **发现与 daemon 的关系**：用户测试服务是**调用方/用户 shell** 的后代，不是
  daemon 的后代——`discover` 始终以 CLI/调用方进程树为根向上回溯再 BFS（pi-web
  同款逻辑），daemon 只负责持有辅助进程与隧道进程；
- 端口发现时辅助进程（daemon 的子女）因角色标记被排除，隧道进程不监听本地端口，
  所以 daemon 的存在**不污染**用户服务发现。

### 4.8 lifecycle.ts —— 编排与清理

- 进程登记表（`state.json` + 内存），退出（exit/SIGINT/SIGTERM）时统一 kill
  全部子进程（隧道/nginx/authelia/redis，按依赖倒序）；`stop-all` 命令等效。
- 幂等：start 已运行返回状态；stop 未运行返回状态。

## 5. 认证架构 —— 统一本地网关认证（可插拔 provider）

> **原则：认证统一在本地端口侧（nginx auth_request），与隧道方式无关。**
> 所有隧道（ngrok / frpc / ssh / cloudflared / localtunnel / command）都只是
> "公网 URL → 本地 nginx 端口"的透传通道，隧道进程不参与认证、不需要感知认证
> 细节。`--auth` = 在 nginx 侧挂一个认证 provider。

### 5.1 统一模型

```
公网浏览器
   │  https://<隧道域名>            ← 隧道工具随便（ngrok/frpc/ssh/...）
   ▼
隧道进程 ×N（每域名一个，按需启停）   ← 纯透传，不知道认证的存在
   │  http://127.0.0.1:<nginx 端口>
   ▼
nginx 网关（常驻，一个端口，多域名 Host 路由）
   ├─ location /         → 测试服务（auth_request 保护）
   ├─ location /authelia/ → 认证门户（provider 挂载点）
   └─ auth_request ─────▶ 认证 provider 判定端点（本地）
```

- 认证决策 100% 在本地：`auth_request` → provider（默认 Authelia forward-auth），
  判定通过才放行到测试服务；
- 会话 cookie 种在隧道域名上（门户与应用同主机，base path 部署）→ 随机域名、
  固定域名、任何隧道工具**完全一致**；
- 换隧道工具 / 换 provider 都不影响其它层——隧道层不知道认证，认证层不关心隧道。

### 5.2 AuthProvider 接口（本地网关型为主线）

```ts
interface AuthProvider {
  readonly type: string;                 // "authelia" | "oauth2-proxy" | "basic" | 插件名
  readonly capabilities: {
    localGateway: boolean;               // 主线：挂 nginx auth_request（true）
    edgeAuth: boolean;                   // 可选：隧道/边缘侧认证（ngrok edge-oidc 插件用）
    randomDomain: boolean;               // 是否支持随机域名（动态登记 ✅）
    needsSessionStore: boolean;          // 需要 Redis 会话存储（authelia ✅ / oauth2-proxy ❌）
  };

  prepare(ctx: ProviderContext): Promise<void>;   // 绿色启动 / 配置准备（幂等）
  start(): Promise<ProviderStatus>;
  stop(): Promise<void>;
  status(): ProviderStatus;

  registerHost(host: string, policy?: AuthPolicy): Promise<void>;   // 域名接入（动态登记）
  unregisterHost(host: string): Promise<void>;

  renderNginxAuth?(ctx: NginxContext): string;      // 本地型：生成 nginx auth 段
  renderTunnelAuth?(ctx: TunnelContext): Record<string, unknown>;   // 边缘型插件用

  validate?(): Promise<string[]>;        // 启动前检查：缺二进制/缺注册 → 拒绝并提示
}
```

### 5.3 provider 注册与加载

- **内置**（统一本地网关型）：
  | type | 判定端点 | 随机域名 | Redis | 说明 |
  |---|---|---|---|---|
  | `authelia`（默认） | nginx auth_request → Authelia forward-auth | ✅ 动态登记 | ✅ | 绿色启动 + base path + 动态登记（调研 3.5/3.6/3.8） |
  | `oauth2-proxy` | nginx auth_request → oauth2-proxy sidecar | ❌ 需固定域名（OIDC 回调预注册） | ❌ | 调研 3.1 |
  | `basic` | nginx `auth_basic`（或内置 proxy 密码门） | ✅ | ❌ | 最简，无 SSO |
- **插件**（后续，接口不变）：
  - `~/.config/service-tunnels/providers/*.js`（ESM 导出 `factory(ctx)`）或
    npm 包 `service-tunnels-auth-<name>` 或 `createServiceTunnels({ authPlugins })`；
  - 候选：Authentik / Keycloak（本地 forward-auth，同 authelia 形态）、
    **ngrok edge-oidc**（`edgeAuth` 插件，不启动本地认证进程）、Cloudflare Access；
  - 注册表 `st.auth.providers.list()/register(factory)/unregister()`；CLI
    `auth provider list|install <pkg>`。

### 5.4 选择与默认

- `expose --auth`（不带 provider）：**一律 `authelia`（本地统一认证）**，与隧道
  类型无关；
- `--auth <type>` 显式指定（`basic` / `oauth2-proxy` / 插件名）；
- `config.json auth.provider` 设全局默认；
- `validate()` 失败 → 拒绝暴露并给出修复提示；
- **Redis 只由 `needsSessionStore` 的 provider 拉起**（authelia 需要；basic /
  oauth2-proxy / edge-oidc 插件不需要，固定成本仅 nginx 20MB）。

### 5.5 基础设施与域名登记（authelia 默认路径，来自调研）

```
共享基础设施（各 1 个，常驻）：
  nginx   127.0.0.1:4180    多域名 Host 路由；location /authelia/ → Authelia
  Authelia 127.0.0.1:9091   base path /authelia；session.cookies 动态登记
  Redis   127.0.0.1:<随机>  AOF 落盘，会话跨重启不丢

每域名（隧道多进程，按需启停）：
  ngrok / frpc / ssh / cloudflared / lt 进程 ×1 → nginx 4180（纯透传）
```

- **域名机制**（调研核实，实现必须遵守）：
  - Authelia `session.cookies` 域后缀匹配目标主机，无匹配 400；`*.` 通配与 PSL
    域均被校验器拒绝 → 枚举固定域名或**动态登记**（写 `config-tunnels.yml` +
    `config validate` + 重启 Authelia）；
  - 随机域名 `xxx.ngrok-free.app` 可作 cookie domain（非 PSL）——**随机域名与
    固定域名走同一套动态登记**，隧道重启拿到新主机名就再登记一次；固定前缀/
    固定域名只是"首次登记后不再重启 Authelia"的优化；
  - 门户与应用同主机（base path）→ 会话 cookie 天然覆盖；`access_control`
    用 `domain_regex` 一条覆盖一类域名（two_factor 只配一次，调研 3.7）。
- **资源预算（实测，authelia 默认路径）**：固定 ~110MB（Authelia 74 + Redis 16 +
  nginx 20）+ 每域名隧道进程 30-40MB；`basic` 路径固定成本仅 nginx 20MB。

## 6. CLI 设计

```text
service-tunnels
  daemon start [--foreground] | stop | status | logs    常驻守护（持有辅助/隧道进程）
  discover [--pid <pid>] [--json] [--refresh]     查询端口（当前/指定进程树）
  internal list [--json]                          框架辅助端口（nginx/authelia/redis）
  proxy start [--port <p>] [--suffix <s>] [--base-path <bp>] [--password]
       stop | status
  expose <port> [--tunnel ngrok|frpc|ssh|cloudflared] [--auth] [--name <n>]
  tunnel list | add <name> --type <t> [--target <p>] | start|stop <name> | remove <name>
  gateway start|stop|status [--nginx-port <p>]     nginx+authelia+redis 组合
  auth register <host> | unregister <host>         手动动态登记/撤销
  status [--json]                                  总览（进程/URL/认证）
  stop-all                                         退出清理
  config path|show                                 显示解析出的 config/cache 目录
```

- 除 `discover`/`status`/`config`（可独立执行）外，操作类命令经 daemon IPC 转发
  （未运行则提示或 `--auto-daemon`）。

- 全局参数：`--config-dir <dir>` / `--cache-dir <dir>`（覆盖默认）。
- `discover --pid 1234`：以 1234 为根扫描其后代端口；`discover`（无参）=
  当前进程树；`--json` 机器可读。

## 7. 库 API（Node）

```ts
import { createServiceTunnels } from "service-tunnels";

const st = createServiceTunnels({
  configDir: "~/.config/service-tunnels",   // 可指定（pi-web 传自己的目录）
  cacheDir: "~/.cache/service-tunnels",
});

// 发现
const ports = await st.discoverPorts({ rootPid?: number, force?: boolean });
// 代理
await st.proxy.start({ port, suffixes, basePath, password });
await st.proxy.stop();
// 隧道
await st.tunnels.add({ name, type, target });
await st.tunnels.start("ngrok-web");
await st.tunnels.stop("ngrok-web");
const status = await st.tunnels.list();       // { name, running, pid, url }
// 网关（nginx+authelia+redis）
await st.gateway.start(); await st.gateway.reload();
// 认证登记
await st.auth.register(host); await st.auth.unregister(host);
// 一键暴露
const url = await st.expose({ port, tunnel: "ngrok", auth: true });
await st.expose.stop(port);

st.on("tunnel", (e) => console.log(e));       // 事件：tunnel/url/nginx/authelia 状态变化
await st.shutdown();                          // 清理全部子进程
```

## 8. 安全模型

1. 代理/隧道目标**只允许 127.0.0.1**（代码写死，无 host 转发）；
2. 代理端口必须命中发现缓存（进程树白名单）——远程攻击者不能拿它当跳板访问
   同机 Redis/MySQL；
3. 服务虚拟主机后缀由配置/域名列表约束（防 DNS rebinding）；密码门可选 Basic；
4. 密钥（Authelia secret、用户密码、frp token、tunnel auth）只存
   `~/.config/service-tunnels`（0600）或环境变量，不进日志/状态文件；
5. 公网暴露默认要求 `--auth`（Authelia），未认证拒绝启动；云厂商隧道
   （trycloudflare 等）无认证能力时强制走 nginx+Authelia；
6. 配置文件写前 `nginx -t` / `authelia config validate` 预校验，失败回滚。

### 8.1 安全软件误报（与 ngrok/frpc 同类的风险说明）

- **本包（npm/Node 代码）**：非原生可执行文件，被杀毒直接标记的概率极低；
- **引导的第三方二进制**（真正风险所在）：
  - `frpc`：长期被 Kaspersky/360 等报为 `HackTool/RiskWare`（VT 检出率高）——
    这是 **frp 项目自身被恶意软件滥用的结果**，与本包无关，只能自行加白名单或
    换用 ngrok/cloudflared；
  - `ngrok`：正规签名，低-中风险；`cloudflared`/`authelia`/`nginx`：低风险；
  - 未签名 exe（如 frpc）在 Windows 会触发 SmartScreen"未识别的应用"。
- **行为检测**：任何"公网暴露 + 反向隧道"行为都可能被 Defender 网络保护 / 企业
  EDR / 网关的反隧道策略拦截——与程序名无关，属用户显式行为的预期成本。
- **缓解措施（本包实现）**：
  1. 二进制只从官方源下载并校验 `checksums.sha256`；
  2. `expose` 显式确认（用户主动操作，非静默后台），默认不随安装自启；
  3. 文档提供解除拦截指引（Windows `Unblock-File`/SmartScreen"仍要运行"、
     macOS `xattr -dr com.apple.quarantine`）；
  4. `expose` 前打印所选隧道工具的误报风险提示（frpc 标注高风险）。

## 9. 平台矩阵

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| 进程发现 | /proc（含 env 标记） | ps+lsof | PowerShell+netstat |
| 泛域名代理 | ✅ 零依赖 Node | ✅ | ✅ |
| Authelia 二进制 | ✅ 官方 tar.gz | brew（无官方 darwin 包） | WSL2 / Docker（无官方 win 包） |
| nginx | ✅ 官方包/仓库 | brew | ✅ 官方 zip（功能受限） |
| redis-server | ✅ apt/dnf | ✅ brew | WSL2 / Memurai / tporadowski 移植 |
| daemon 标记兜底 | ✅ /proc/environ | ❌（依赖进程树） | ❌（依赖进程树） |

## 10. 里程碑

1. **M1 骨架**：包结构、目录解析、CLI 框架、daemon（后台常驻 + socket IPC +
   state.json 定位）、`discover`（Linux 优先，含辅助进程角色标记排除）+ 测试。
2. **M2 proxy**：泛域名反代 + 白名单 + SSE/WS + `discover` 跨平台。
3. **M3 tunnels**：隧道管理器 + ngrok/frpc/ssh/cloudflared + URL 解析 + 状态。
4. **M4 auth**：AuthProvider 接口 + nginx 网关 + **authelia provider**（绿色启动 +
   动态登记 + Redis）+ `expose` 一键流程（对接调研认证架构）；`basic` provider。
5. **M5 打磨**：生命周期/清理、安全加固、文档、pi-web 集成示例。
6. **M6 插件**：oauth2-proxy / basic provider 完善 + 插件加载机制（providers
   目录 / npm 包）+ 可选边缘型插件（ngrok edge-oidc、Cloudflare Access）。

## 11. 参考

- pi-web `docs/service-port-proxy.md`（发现/泛域名/basePath 原实现方案）
- pi-web `docs/tunnel-auth-automation.md`（隧道 × Authelia 认证调研：
  路径 A/B/B3、域名机制、动态登记、绿色启动、资源实测）
- pi-web 源码：`lib/service-ports.ts`、`proxy.ts`、`lib/tunnels.ts`
