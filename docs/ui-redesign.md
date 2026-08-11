# UI 重设计 — 参照 pi-web 服务端口管理认知

> 目标：重设计 `src/ui.ts`（127.0.0.1 管理面板）的功能结构，吸收
> pi-web `ServicesDialog` 对「服务端口对端口管理」的心智（发现≠授权、
> 三条访问路径、schema 驱动、按 site 隔离的用户管理、实时状态+日志、
> 安全门控），把零依赖 SSR 多页面板升级为零依赖 SPA 单页控制台，
> 功能与交互对齐 pi-web 弹窗，同时保持库的零外部依赖约束。

## 1. 认知来源（pi-web 的心智，逐条映射）

pi-web 用本库做服务端口管理（`docs/service-port-proxy.md` 的 D 系列决策）。
以下是可直接借鉴到独立 UI 的认知：

| # | pi-web 认知 | 本库现状（UI 侧） | 差距 |
|---|---|---|---|
| D2 | **发现 ≠ 授权**：`discovery.getPorts()` 只列候选，enrollment（暴露）才是门；未 enrolled 一律 deny | `/api/ports` 只喂一个 `<datalist>`，UI 没有候选列表，也没有「候选 → 暴露」的完整链路 | 缺端口候选列表 + 展开面板 |
| D6 | **三条访问路径**：直连（绕过）/ 虚拟主机代理（proxy，本地）/ 公网隧道（tunnel）；一次暴露可同时给 proxy+both 的 URL | expose 表单只有 `auth: none/ssh`，没有 mode（tunnel/proxy/both）、provider、site、policy、protocol；已开暴露只有 `url` 一列 | 缺模式/认证/站点/策略表单；缺 URL 组展示 |
| D4 | **认证统一在决策 API**：proxy 的 `resolve()` 放行/401/重定向一份实现；tcp 暴露不带认证 | 库内已实现（`st.proxy.resolve`），UI 未展示 binding 状态、未按协议提示认证差异 | 缺 proxy 状态展示、tcp 无认证警告 |
| — | **Schema 驱动**：`tunnelSchemas` / `authProviderSchemas` / `authMetas` / `providerOrder` / `defaultProvider` 全部来自库，UI 零硬编码 | `/tunnels/add` 已 schema 驱动；但 expose 表单仍写死 `auth none/ssh` | 暴露表单未用 auth schema |
| D6 | **用户管理按 site 隔离**：provider 用户库 / TOTP 2FA 登记-激活-停用 | 已有（`/sites/<name>/users`），但用 `prompt()`/`confirm()`，无 TOTP 秘密展示模态 | 交互落伍，缺 site×provider 矩阵 |
| — | **实时状态 + 日志**：10s 轮询、expose 状态、nginx access/error 日志、日志文件列表 | 无轮询，动作全靠 `location.reload()`；无日志查看 | 缺轮询与日志面板 |
| D6/安全 | **安全开关**：allowToolDownload 开关、auth-none 泄露确认、`dangerous` 隧道类型 UI 隐藏（fail-closed） | allow-tool-download 只能 env/配置；expose 表单有 ssh 选项但无泄露确认 | 缺开关 + 确认流程 |
| 新 | **token 认证**：Bearer token 供机器客户端（CI/脚本/API），无登录页/无 Cookie，按 site 管理 + 有效期（description/expiresAt）；库只存 SHA-256 哈希，创建时一次性返回原文；校验双通道（决策 API 进程内 + nginx auth_request 探针） | `/tokens` 页已有 token 增删；expose 表单无 provider=token 入口 | 暴露表单补 token provider + Tokens 页签详化（§4.4） |
| 新 | **ssh 认证 provider（site 级公钥，任意协议）**：与 portal/basic/authelia/token 同构的认证方式——**没有「网关」概念**。ssh provider 可服务**任何端口**（http/https/tcp 通用，port-forward 协议无关）：暴露时只选 provider=ssh + site，库启动 ssh 转发服务暴露用户端口，安全=site 公钥 | 现状是「ssh 网关」domain 模型（`ssh.domain.create` + sshPort/forwardPort），且只接 tcp 路径 | UI 移除网关概念：ssh 是 provider（任意协议可用），密钥管理参照用户管理（§4.3），使用只选 site（§4.1） |
| 新 | **site 隔离默认值**：服务端口与自身端口默认走不同 site（pi-web：services vs pi-web），但**配置方法完全一致**——同一暴露表单，site 默认值随上下文，其余零差异 | 库的 site 是纯配置（provider/策略/域名），无硬编码预设 | 统一表单 + site 默认值策略（§4.9） |

## 2. 现状差距清单（src/ui.ts vs 目标）

1. 多页跳转 + `location.reload()`，无实时刷新、无模态（TOTP 秘密只能塞进 `prompt()`）。
2. expose 表单能力远弱于库：无 mode/provider/site/policy/protocol/tunnelParams/
   providerParams/user/ngrokAuthtoken；只走 daemon RPC，参数透传不全。
3. 无端口候选列表（发现结果没有入口），无 proxy/both 的虚拟主机 URL 组。
4. 无活动暴露总览（running/停止/日志），tunnels 与 exposes 分离。
5. 无 allowToolDownload / allow-auth-none 状态展示与开关。
6. `/config` 只读 JSON 展示，与「管理面板」定位不符（v1 保持只读）。
7. i18n key 分散（415 个），前端 `tr()` 已有，但无结构化的 `ui.ports.*` 等命名空间。

## 3. 目标形态（决策）

### D1. 零依赖 SPA 单页控制台（不是 SSR 多页）

- 一个 HTML 壳 + 纯 vanilla JS（与现状一致：node 内置 http + 内存模板，无构建步骤）。
- **hash 路由**：`#/ports`、`#/exposes`、`#/users`、`#/tokens`、`#/sites`、
  `#/tools`、`#/config`；`/`、`/ports` 等旧路径 302 → `/#/ports`（旧链接兼容）。
- 所有数据经 JSON API（见 §5），前端只渲染；schema 驱动表单零硬编码 provider/tunnel。
- **轮询拆分**：静态 `/api/status`（schemas/providers/sites/tools/allowAuthNone/
daemon status）在加载与每次变更后取；动态 `/api/live`（ports/exposes/tunnels/
proxy bindings）**10s 轮询**（对齐 pi-web 弹窗）+ 手动刷新按钮；动作后局部
更新，不整页 reload。
- 模态代替 `prompt()/confirm()`：确认窗（泄露风险/删除）、TOTP 登记窗、expose 详情窗。
- 深色/浅色跟随 `prefers-color-scheme`（pi-web 用 CSS 变量；本 UI 用同一套变量的内联等价）。

### D2. 保留并复用现有安全骨架

- CSRF（meta token + `X-CSRF-Token` + Origin 校验）**原样保留**。
- **新增 Host 校验**：请求 Host 必须为 `127.0.0.1[:port]` / `localhost[:port]` /
  `[::1][:port]` —— DNS-rebinding 纵深（对齐 pi-web `request-security` 心智）。
- 所有新 JSON API 走同一 CSRF 检查路径（现状 POST 检查是全局的，天然覆盖）。

### D3. 数据源：daemon 默认 / `--no-daemon` 内嵌（双模式，P0-F1/F12）

- **默认 daemon 模式**：暴露/隧道/代理绑定/ssh 认证的**事实源在 daemon 进程**
  （审计确认：UI 进程 `st.exposes()` 为空、proxy bindings 为空——暴露经
  `daemon.request("expose")` 落在 daemon）。UI 的所有动态数据经 daemon RPC
  获取；**daemon 侧新增 expose 注册表 + `expose.list`/`expose.stop` RPC**
  （元数据含 startedAt，持久化 state.json，重启可恢复）。
- **`--no-daemon` 内嵌模式**（session-model-design 逃生门）：操作在 UI 进程内
  执行，`st.exposes()`/`st.proxy.bindings()` 本地可用；`/api/*` 数据源自动
  切换（daemon 在时走 RPC，不在时进程内）。
- 两条路径在 `/api/*` 之后对前端透明：同一端点、同一响应结构。

### D4. 功能分区 = pi-web 弹窗页签的库级对应

```
┌──────────────────────────────────────────────────────────────┐
│  header: service-tunnels · daemon 状态 · 刷新 · 语言 · (配置只读) │
│  tabbar: Ports | Exposes | Users | Tokens | Sites | Tools          │
├──────────────────────────────────────────────────────────────┤
│ Ports  —— 发现候选列表（每行展开：直连 / 虚拟主机 / 暴露表单 / 已开暴露）│
│ Exposes —— 活动暴露总览（状态/URL 组/日志/停止/详情）                │
│ Users  —— site × (provider + ssh) 矩阵（计数 + 入口）→ 管理在 Sites     │
│ Tokens —— bearer token 管理（创建/撤销/有效期，按 site）            │
│ Sites  —— site 详情分块：Users / TOTP / Keys / Tokens + 关联 URL     │
│ Tools  —— 工具下载开关 + 工具状态（PATH/cache/missing）             │
└──────────────────────────────────────────────────────────────┘
```

## 4. 功能规划

### 4.1 Ports 页签（对齐 pi-web D2/D6 —— 本次重设计核心）

**数据**：静态 `GET /api/status`（schemas/providers/sites/tools）+ 动态
`GET /api/live`（ports/exposes/proxy bindings，10s 轮询，daemon 优先）。

**每端口一行**（折叠态：端口号、cmdline、监听地址、pid）→ 点击展开：

1. **直连（绕过本面板）**：每个监听地址一行 `http://<addr>:<port>/`
   （IPv6 加方括号）—— 对齐 pi-web「直连不带 basePath」。
2. **虚拟主机地址（已 proxy/both 暴露时）**：`localUrl`（本地 vhost）/
   `baseUrl`（通配域名）/ `domainUrl`（site 自有域名）URL 组，逐条 打开/复制；
   `proxy` 模式显示 binding 状态（`st.proxy.bindings()` 对齐，pi-web 有同样的
   proxy-mode running 修正逻辑）。
3. **暴露表单（schema 驱动）**：
   - **模式** `tunnel` / `proxy` / `both`（`auth.expose.mode`）；
   - **隧道类型**：`tunnelSchemas` + `tunnelMetas`（`dangerous` 隐藏——
     command 类型 fail-closed 不渲染，对齐 pi-web）；tcp 协议时只列
     `tunnels.tcpSupport()` 里的类型；**provider=ssh 时隧道类型隐含为
     ssh 转发**（库自动启动，§4.6），类型选择器隐藏/只读；
   - **provider**：`authProviderSchemas` + `authMetas` + `providerOrder`/
     `defaultProvider`；`auth:none` 仅在 `allowAuthNone` 为真时出现，
     选中后弹「泄露风险确认」。**token** 是 provider 之一（providerOrder
     已含）：无登录页/无 Cookie，只认 `Authorization: Bearer <token>` ——
     表单给「机器客户端专用」提示；提交前护栏对 token **跳过**
     userManagers 检查（token 走 `tokenManagers`，不在 `userManagers` 内），
     改提示「去 Tokens 页签创建 token」（§4.4）；**ssh** 也是 provider
     （§4.6）：**任意协议可用**，只选 site，公钥随 site；
   - **站点**：`sites.list()`（default + 命名站点，默认值策略见 §4.9）；
     **策略** `one_factor` / `two_factor`；**协议** `http` / `https` / `tcp`
     —— **ssh provider 不受协议限制**：port-forward 协议无关，任何
     http/https/tcp 端口都能用 ssh 公钥认证暴露（只选 site，无端口/域名）；
     `none`（裸透传）才需泄露确认；HTTP provider（portal/basic/authelia/
     token）在 tcp 下不渲染；
   - **参数**：`tunnelParams` / `providerParams`（SchemaForm：label/description/
     link/password/number/select/options），token 类回显掩码（对齐 pi-web
     `exposeParams` 掩码心智）；
   - **附加**：`user.name` / `user.password` 预置用户、`ngrokAuthtoken`；
     ssh 认证无附加参数——密钥在 site 管理里维护（§4.3），暴露时只选 site。
   - 提交前护栏（对齐 pi-web AuthExposeSection）：userManagers 就绪检查 →
     provider+site 无用户 → 引导去 Users 页签；有用户 → 列出用户名二次确认。
4. **已开暴露（该端口）**：状态（running/stopped）、`mode`/`provider`/`protocol`
   徽标、主 URL（打开/复制/详情）、**日志**（`?logs=<name>` 尾部 50 行 +
   `?logs-list=<name>` 文件列表，点开详情）、**停止**（单通道，经 daemon
   `expose.stop`——tunnel 进程 + proxy binding+record 双路径，P0-F2）。
5. **安全开关行**：`allowToolDownload` 开关（`tools.setAllowDownload` 持久化到
   配置档）+ 缺失工具提示（`tools.list()` source===null 列出名字）。

### 4.2 Exposes 页签（活动暴露总览）

- 数据源 = **daemon expose 注册表**（`expose.list` RPC，新增）：全端口 exposes
  表格：port、name、mode、provider、protocol、site、URL 组、状态、**开启时间**
  （startedAt 由 daemon 记录，持久化 state.json，重启可恢复）、操作（详情/停止）。
- **详情模态**（对齐 pi-web ExposeDetailModal）：mode / provider（auth=none 标红）/
  隧道工具 / site / protocol / startedAt / **掩码参数** / URL 组（打开+复制）/
  日志文件列表（名称+大小，点开在文件查看器——本 UI 内嵌只读日志预览）。
- **停止**：单通道 `expose.stop`（tunnel 进程 + proxy binding+record 双路径）；
  **停止全部** = daemon `tunnel.stopAll` + 全部 proxy bindings 清理。
- 轮询 `/api/live` 时 expose 记录若已停（daemon 进程退出），从列表移除。

### 4.3 Users 页签（对齐 pi-web Users 页签）

- **site × (provider + ssh) 矩阵**（`POST /api/user-summary`，一次拿全，避免
  N×M 请求）：行 = site（default + 命名站点），列 = user 型 provider
  （`userManagers`）+ **ssh 列**；每格 = 数量（用户数 / TOTP 数 / **公钥数**）。
  点击格子 → 跳到 Sites 页签该 site 详情的对应块（用户块 / Keys 块）。
- 用户管理（增删、改密、displayName；TOTP 登记-激活两段式模态、停用）
  在 **Sites 页签的 site 详情 Users/TOTP 块**（§4.5），矩阵格是入口。
- 全部模态化，去掉 `prompt()`。
- **token 例外**：矩阵只列 `userManagers` 的 provider；`token` 归 Tokens
  页签（`tokenManagers`），矩阵旁给「token → Tokens 页签」入口。

### 4.4 Tokens 页签（token 认证 —— 最近的 provider 更新）

- **定位**：token 是「机器客户端认证」（CI/脚本/API 调用）——无登录页、无
  Cookie，请求带 `Authorization: Bearer <token>` 即放行；校验双通道（决策
  API 进程内 + nginx auth_request 探针，子请求显式转发 Authorization，401
  直返带 `WWW-Authenticate: Bearer`，无 302 跳转）。token 库只存 SHA-256
  哈希（db 泄漏 ≠ 可用 token）。
- **列表**：按 site 隔离（`tokenManagers` 与 user 同构，`--site` 语义一致），
  显示 id 前缀/description/创建时间/过期时间/剩余；已过期自动失效并惰性
  清除（列表不显示）。
- **创建模态**：description + 有效期（`parseTokenExpiry`：never / 相对
  `+2h`/`+30d` / ISO / epoch ms）；**原始 token 只展示一次**（`st_` 前缀 +
  192-bit），复制按钮 + 「关闭后无法再见」警告。
- **撤销**：确认窗后撤销（id 校验 `^[a-f0-9]{16}$`）。
- **expose 联动**：暴露表单选 provider=token → 提示「机器客户端专用，去本
  页创建 token」；该 site 已有 token 数量显示在表单附近（§4.1）。

### 4.5 Sites 页签（site 详情：Users / TOTP / Keys / Tokens 分块）

- 站点表：名称 / provider / 认证状态 / 域名 / 运行状态 / 暴露 URL 组 / 操作
  （用户、token、删除）。
- **site 详情分块**（点击进入，Users 矩阵的格子也跳到这里）：
  - **Users / TOTP 块**：增删改密、displayName、TOTP 登记模态（otpauth URL
    + secret 复制 + 6 位码激活）、停用——对齐 pi-web 用户管理；
  - **Keys 块（ssh 公钥，与用户/token 平级）**：上传公钥（authorized_keys
    格式）/ 生成密钥对（私钥一次性模态 + 复制/下载）/ 撤销；密钥归 site，
    随 provider=ssh 暴露使用（§4.6）；
  - **Tokens 块**：该 site 的 bearer token 列表 + 创建/撤销（§4.4）。
- 新增：**站点 URL 合并**（对齐现状 `/sites` 页已做的 exposes→site URL 关联）。

### 4.6 SSH 认证 provider（site 级公钥 —— 无「网关」概念、无独立页签）

- **定位**：ssh 与 portal/basic/authelia/token 一样是**认证 provider**（公钥
  认证，无登录页），**可服务任何端口**——http/https/tcp 通用，因为
  port-forward 协议无关：库启动一个 ssh 转发服务暴露用户的端口，持授权
  私钥者 `ssh -N -L <local>:127.0.0.1:<port> ...` 连通。**没有「ssh 网关」
  这个概念**：用户完全不管理端口/域名/监听地址，库作为内部工具维护
  （类比 nginx auth_request 之于 HTTP），UI 永不展示。
- **使用（与其它 provider 完全一致）**：暴露表单选 provider=ssh + site（密钥
  随 site，§4.3），无需任何端口/域名/协议参数——协议字段对 ssh 无意义
  （port-forward 不限 http/tcp），详情里展示可复制的 `ssh -L` 命令。
- **site 与密钥**：密钥归 site（与用户/token 同构）；site 需要启用 ssh 认证
  时，库自动准备内部 ssh 转发服务（端口自动分配），`tcp-tunnel-ssh-auth.md`
  的传输细节全部内化，UI 只见「site + 公钥」两层。

### 4.7 Tools / 设置

- 工具状态表：name / path / source（toolPaths / path / cache / missing）。
- `allowToolDownload` 开关（§4.1 亦有一处快捷开关，两处同步）。
- `allow-auth-none` 状态徽标（只读展示；false 时表单不渲染 none 选项并在
  表单区提示「本机禁止无认证暴露」）。

### 4.8 Config

- v1 保持只读 JSON（现状行为），作为诊断入口；**不承诺编辑**（配置档是操作者
  管理，编辑语义见非目标）。

### 4.9 site 默认值：服务端口 vs 自身端口走不同 site（配置方法一致）

- **原则**（对齐 pi-web 的 services / pi-web 双域分离）：暴露对象不同，默认
  认证域不同，但**暴露表单完全一致**——同一个表单，site 下拉的默认值由上下文
  决定，其余（provider/策略/隧道/参数/用户/token）零差异。
- **服务端口暴露**（发现列表里的端口）→ 默认 site `default`；可配置覆盖
  （配置档 `ui.site-default.service`，宿主可指到自己的 services 域）。
- **自身/宿主端口暴露**（宿主把自己暴露出去，如 pi-web 的 `exposeSelf`）→
  默认独立认证域（pi-web 是 `pi-web`：portal + two_factor）；库 UI 不内置
  self 概念（§10），但经配置注入时遵循同一默认值逻辑
  （`ui.site-default.self`）。
- **对比 pi-web 的优化**：pi-web 用 `ensureSites()` **硬编码**两个预设
  （portal/two_factor + basic）；本设计不做硬编码——site 首次被暴露引用时按
  配置默认创建（provider/策略来自配置档，未配置时用库 `defaultProvider()`），
  之后就是普通 site 可自由改。**「默认不同 site」是配置而非代码**。
- **ssh 认证同样按 site**：site 是 ssh 公钥的归属（§4.6）——暴露表单选
  site 即选定 ssh 认证，无需任何端口/域名参数。

## 5. API 设计（JSON）

**双模式数据源**（§3 D3）：默认 daemon 模式——动态数据经 daemon RPC（含新增
expose 注册表 RPC），静态 schema/provider 元数据进程内 `st.*` 直接取；
`--no-daemon` 内嵌模式——全部进程内。两条路径在 `/api/*` 后统一，前端无感。
对齐 pi-web route.ts 的聚合心智：

| 端点 | 方法 | 内容 |
|---|---|---|
| `/api/status` | GET | **静态**：providers/providerOrder/defaultProvider、tunnelSchemas/tunnelMetas、authProviderSchemas/authMetas、tunnelTcpSupport、userManagers/totpProviders、sites、tools（list + allowDownload）、allowAuthNone、daemon status、运行模式 |
| `/api/live` | GET | **动态（10s 轮询）**：ports（daemon `port.list`/`discover` 优先——已排除 internal + ssh 端口；daemon 不可用才进程内降级并叠加 internal 过滤）、internal、tunnels、**exposes（daemon 注册表，+startedAt+params 掩码）**、proxy status/bindings（daemon RPC） |
| `/api/ports` | GET | 候选端口列表（保留，供第一屏 + datalist 兼容） |
| `/api/port-detect` | POST | 协议探测（保留） |
| `/api/expose` | POST | **扩展**：`{ port, mode, auth, provider, tunnel, site, policy, protocol, tunnelParams, providerParams, user, ngrokAuthtoken, allowToolDownload, allowAuthNone }` —— ssh provider 只需 `provider: "ssh"` + `site`（**任意协议**，库内自动启动 ssh 转发，无 domain/端口参数）；daemon RPC 已支持除 user/ngrokAuthtoken 外的全部透传 |
| `/api/expose-stop` | POST | `{ name }` → daemon **`expose.stop`**（新增）：tunnel 进程 + proxy binding+record 双路径（P0-F2）；no-daemon 模式 `st.tunnels.stop(name)` |
| `/api/expose-stop-all` | POST | daemon `tunnel.stopAll` + 全部 proxy bindings 清理 |
| `/api/tunnel` | POST | `{ action: start\|stop\|stop-all\|add\|remove, ... }`（保留现有 `/tunnels/*` 兼容） |
| `/api/logs` | GET | `?name=` 尾部 50 行 access/error（对齐 pi-web） |
| `/api/logs-list` | GET | `?name=` 日志文件列表（对齐 pi-web `logs-list`） |
| `/api/user-summary` | POST | site × (provider + ssh) 矩阵（对齐 pi-web `user-summary` + ssh 列） |
| `/api/user-add` / `user-set-password` / `user-remove` / `totp-*` | POST | 已有，补 `site`/`provider` 参数（对齐 pi-web） |
| `/api/token-create` / `token-revoke` | POST | 保留现有 |
| `/api/settings` | POST | `{ allowToolDownload? }` / `{ allowAuthNone? }`（后者仅展示确认；禁止方不可被 UI 打开） |
| `/api/ssh-keys` | POST | **site 级公钥管理**：`{ action: add\|generate\|revoke, site, publicKey?/type?/comment?/fingerprint? }` —— 参照 user 管理形态按 site 组织（现状 ssh.key.* 内化到 site 语义，无 domain 参数） |

**新增 daemon RPC**（库侧增量，P0-F1/F2）：

| RPC | 内容 |
|---|---|
| `expose.list` | daemon expose 注册表全量：name/port/mode/provider/protocol/site/urls/startedAt/掩码 params/running（proxy 模式按 binding 判定） |
| `expose.stop` | 双路径停止：tunnel 进程（TunnelManager.stop）+ proxy 模式（binding 移除 + 记录删除 + host 注销） |
| `ssh.key.add/generate/revoke/list`（site 化入口） | 现 domain 参数收敛为 site 语义（site → 内部自动域），UI 只传 site |
| expose 注册表持久化 | 元数据写 state.json（重启恢复 exposes 展示，隧道进程由既有 hydrate 恢复） |

**错误面**：所有 API 返回 `{ error }` + 4xx/5xx；UI 全局 toast 显示。

## 6. 安全设计（对齐 pi-web D4 心智）

1. **enrollment 门控不变**：proxy 只服务已 enrolled 端口（库内保证），UI 只是入口。
2. **无认证暴露（none）才需泄露确认**：`none`（裸透传，任意协议）→ 红字 +
   二次确认；**ssh provider 任何协议下都是公钥认证**（site 级，§4.6），
   不在 none 之列。HTTP provider（portal/basic/authelia/token）在 tcp 下不
   渲染。
3. **auth=none**：仅 `allowAuthNone` 为真时可选；选中即确认窗。
4. **dangerous 隧道类型**（command）：UI 不渲染（`metas.dangerous`），API 侧
   daemon 已有 `dangerous:true` 边界拒绝（fail-closed）。
5. **敏感字段掩码**：`tunnelParams`/`providerParams` 回显时 token/secret/password/
   key 类字段只留末 4 位（对齐 pi-web `exposeParams`）。
6. **CSRF + Origin** 保留；**新增 Host 白名单**（§3 D2）。
7. **autheliaReloadCmd**：IPC 边界已禁（daemon 拒绝），UI 不提供该字段。
8. **敏感输入**：表单新增 `user.password`/`ngrokAuthtoken`/`tunnelParams.token`
   等经 POST 到本机 daemon——回显一律掩码；**tunnelParams 中 token 类字段
   会明文落盘 tunnels.json**（现状既定行为，CLI 一致），UI 文档注明。
9. **并发写提示**：sites.json/users.json 无文件锁（现状亦然，daemon 只串行
   隧道）；UI 与 CLI 并发改 site 有竞态——v1 保持现状，文档注明。

## 6a. pi-web 没处理好 / 没跟上 → 本设计优化

| pi-web 做法 | 问题 | 本设计 |
|---|---|---|
| proxy-mode running 靠宿主补丁（`startTransport:false` 时库 `exposes()` running 恒 false → pi-web 自己查 `st.proxy.bindings()`） | 补丁逻辑散落在宿主，每个嵌入方都要重写 | **库内修**：`st.exposes()` 对 proxy 模式 `running` 直接按 `proxy.bindings()` 命中判定，宿主零补丁（§8/M0a） |
| expose 开启时间靠宿主 Map（`exposeStartedAt`），库 `exposes()` 无时间 | 嵌入方重复记录，重启即失 | **库内补**：`exposes()` 输出 `startedAt`（进程内记录），UI/宿主直接读 |
| 多通道命名靠宿主拼长串（`expose-<port>-<provider>-<site>-<tunnel>-<mode>`），库默认 `expose-<port>` 同端口多通道会撞名（`expose.ts` 默认 `expose-${port}` / `expose-${port}-tcp`） | 命名策略散落各宿主，理解成本高 | **库内统一**：默认命名带 provider/site 后缀（同端口多通道天然不撞），宿主零拼接 |
| `ensureSites()` 硬编码预设（portal/two_factor、basic） | site 是配置不是代码，硬编码违反库的配置化心智 | site 默认走配置（§4.9）：首次引用按配置创建，未配置用 `defaultProvider()` |
| `repairSchemaL10n`（漏翻修复 workaround） | 宿主侧补丁，依赖库端已修 | 库端 `localizeSchemas` 修复后宿主 no-op（文档标注版本依赖） |
| token 在 ServicesDialog 被 userManagers 检查跳过、无「去创建 token」引导 | 机器客户端入口缺失，用户不知道去哪建 token | Tokens 页签 + 暴露表单提示联动（§4.4） |
| 现状「ssh 网关」domain 模型（`ssh.domain.create` + sshPort/forwardPort/listenAddr + 独立 SSH 页签） | 概念负担重：用户被迫管理端口/域名，与「认证 provider」心智不符 | **UI 移除网关概念**：ssh 是 site 级认证 provider（§4.6），**任意协议**（http/https/tcp 都走 ssh 转发），密钥管理在 Users 矩阵入口 + Sites 详情（§4.3/§4.5），端口/域由库自动维护（库侧演进见 §8/M0b） |

## 7. i18n

- 复用 `translate`/`CATALOG` 与前端注入的 `UI_MSG`/`tr()`。
- 新增命名空间：`ui.ports.*`、`ui.exposes.*`、`ui.users.*`、`ui.tokens.*`、
  `ui.settings.*`；沿用现有 `ui.ssh.*`/`ui.sites.*`/`ui.tokens.*`。
- schema 本地化沿用 `schemas.tunnels(lang)` / `authProviders(lang)`（已有
  `?lang=` 机制），前端 `tr()` 兑底 key。
- 语言切换按钮（现状只有 ?lang= 探测；SPA 内加切换，局部重取数据）。

## 8. 文件变更清单

| 文件 | 变更 |
|---|---|
| `src/ui.ts` | 重写：SPA shell（tabbar + hash 路由 + 轮询 + 模态）+ 各页签模板 + 新 API 路由；删除 `prompt()/confirm()` 交互 |
| `src/i18n.ts` | 新增 `ui.ports.*`/`ui.exposes.*`/`ui.users.*`/`ui.settings.*` key（中英） |
| `src/index.ts` | `exposes()` 输出补 `startedAt`；proxy 模式 `running` 改为按 `proxy.bindings()` 判定（修 §6a 宿主补丁问题）；多通道默认命名带 provider/site 后缀；**进程内 expose ctx 接 `sshGatewayPort`**（P1-F5：no-daemon 内嵌模式 ssh 才能用） |
| `src/daemon-server.ts` | **新增 expose 注册表 + `expose.list`/`expose.stop` RPC**（P0-F1/F2）：记录/列出 expose 元数据（startedAt、掩码 params），停止双路径（tunnel 进程 + proxy binding+record+host 注销）；expose 元数据持久化 state.json；`ssh.key.*` 收敛 site 入口 |
| `src/ssh/*`（库侧演进，随 M0a 评估） | ssh 认证 site 化 + **任意协议**：`provider: "ssh"` + site 自动接内部 ssh 转发（端口自动分配，domain 概念内化）；**http/https 端口也走 ssh 转发**（P1-F6：现只接 tcp 路径，需新接线） |
| `docs/ui-redesign.md` | 本文档 |
| `docs/adaptation-kit.md` | 若 UI API 面变化，更新对应小节 |
| `test/ui.*.test.mjs` | 新 API 的冒烟测试（路由/CSRF/Host 校验/expose 参数透传） |

## 9. 里程碑

| M | 内容 | 验收 |
|---|---|---|
| M0a | 库侧：`exposes()` 补 `startedAt` + proxy `running` 按 binding + 多通道默认命名（§6a）；进程内 expose ctx 接 `sshGatewayPort`（P1-F5） | `npm test` 绿；内嵌模式 expose ssh 冒烟 |
| M0b | daemon：expose 注册表 + `expose.list`/`expose.stop` RPC（双路径停止）+ 元数据持久化（P0-F1/F2）；ssh 认证 site 化 + 任意协议转发（P1-F6/F7） | curl 冒烟：expose → list → stop（tunnel/proxy 两种模式）| 
| M0c | UI API：`/api/status`（静态）+ `/api/live`（动态）+ `/api/expose` 参数扩展（token/ssh provider）+ `/api/logs(-list)` + `/api/user-summary`（+ssh 列）+ `/api/ssh-keys` + Host 白名单 + 双模式数据源适配 | `npm test` 绿；curl 冒烟全端点；token/ssh 参数透传验证 |
| M1 | SPA 壳 + Ports 页签（候选列表/展开/直连 URL/暴露表单/已开暴露/allowToolDownload 开关） | 手测：起 dev server → 列端口 → proxy 暴露 → 虚拟主机 URL 打开/复制 → 停止 |
| M2 | Exposes 详情 + 日志 + Users（矩阵 + TOTP 模态 + **ssh 公钥管理**：site 公钥数量/上传/生成/撤销）+ Tokens 模态化 | TOTP 登记-激活-停用全流程；ssh 密钥上传-生成-撤销；日志尾部/文件列表 |
| M3 | Sites（site 详情分块 Users/TOTP/Keys/Tokens）/ Tools / Config 搬入 + i18n 补齐 + README/文档更新 | 全页签手测 + `npm run build` 干净 |

## 10. 非目标（v1 明确不做）

- **self-expose 已纳入规划**（`docs/ui-redesign-plan.md` TODO-5）：pi-web 的
  `PI_WEB_EXPOSE` 机制（self-expose + allowlocal/allowHost 门控 + auth 保护）迁移进库为
  `SERVICE_TUNNELS_EXPOSE` + `st.exposeSelf()`——不再是非目标；§4.9 的 site 隔离默认值原则
  （服务端口 vs 自身端口不同 site）直接适用。
- **不编辑 config 档**（`/config` 保持只读；编辑语义 v2 再议）。
- **不引入前端框架/构建步骤**（维持「依赖仅 justget」+ node 内置 http）。
- **不做暴露粒度细化**（按路径/header 的 ACL —— 库侧未来工作，UI 跟随）。
- **不把 UI 暴露到非回环地址**（127.0.0.1 绑定不变；公网管理走隧道/反代的认证层）。
