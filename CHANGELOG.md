# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 发布记录以 npm registry 实测时间为准；git 历史中的版本号
> （如 0.2.38–0.2.41）若未出现在 registry 发布列表中，其功能统一计入下一个
> 实际发布版本。

## [Unreleased]

## [0.3.24] - 2026-08-07

### Changed
- **ssh 的 host 不再有误导性 localhost 占位符**：`ssh -R` 转发到本机没有意义，
  host 为必填且无默认值(移除 `placeholder: "localhost"`)，描述改为
  「必填,转发到该服务器公网端口」。

## [0.3.23] - 2026-08-07

### Changed
- **bore 默认 server 改为 bore.pub**：schema `default` 与代码兜底
  `cfg.server ?? SERVICE_TUNNELS_BORE_SERVER ?? "bore.pub"`——公共社区服务器
  免注册即用；自建/离线场景显式填 `localhost:7835` 或用环境变量覆盖。

## [0.3.22] - 2026-08-07

### Fixed
- **natapp 不再标星**：`TUNNEL_META` 移除 `natapp: { favorite: true }`——favorite
  语义是「零账号/少参数/即开即用」(serveo/cloudflared/localtunnel/bore)，natapp
  需 natapp.cn 付费 authtoken，不应出现在推荐首位/带徽标。

## [0.3.21] - 2026-08-07

### Fixed
- **guardian 跨 owner 误杀**：`ensureMarker()` 不再复用环境继承的
  `SERVICE_TUNNELS_MARKER`——泄漏到环境的旧实例 marker 会让所有实例共享同一
  marker，一个实例退出时的 guardian `killRoleProcesses`（按 role+marker 全
  /proc 扫描）会 SIGTERM 掉无关实例刚启动的 helper（oauth2-proxy 侧车等）。
  现在每个进程生成独立 marker，自家子进程仍经 `roleEnv()` 显式继承。

### Tests
- oauth2-proxy / oauth2-gateway e2e 接入 `npm test`（`test/oauth2-proxy.test.mjs`
  + `test/oauth2-gateway.test.mjs`）：mock IdP（`scripts/mock-idp.mjs`，RS256
  OIDC + 回调白名单 + 域名验证模拟）驱动，覆盖侧车直连 / 库集成 mode=proxy /
  nginx 网关完整登录链。外部依赖 oauth2-proxy + nginx 二进制缺失时 t.skip，
  端口全随机（pickFreePort / proxyPort: 0），不触发网络下载。

### Security
- **oauth2 变体秘密字段真掩码**：`clientSecret` 等 password 型字段由配置档携带时
  **不回显明文**（value 不写、schema JSON 不含明文，页面只显示「已由配置档提供」+
  secretSet 标记）——浏览器圆点 + 源码/JS 均不可见；留空提交 = 回落配置档值，
  填写 = 覆盖。自定义变体 token 名含 secret/password（如 `{{clientSecret}}`）
  自动按秘密字段处理。

## [0.3.20] - 2026-08-07

### Added
- **`st auth totp code`** — 不借助手机 app 生成 TOTP 验证码(CLI 内嵌 RFC 6238):
  - `auth totp code <name> [--site <s>] [--provider portal]` — 从用户记录读
    secret(pending 用 totpPending,激活后 totpSecret),打印当前码 + 下一窗口码 + 剩余秒数
  - `auth totp code --secret <b32>` — 任意 base32 secret(otpauth URI 里的也行)
  - 端到端验证:CLI 生成的码被 portal totp-activate 接受;与 pyotp 官方库逐窗口一致。
- **`generateTotpCode()`** 导出(`src/providers/portal.ts`)——同一实现供 CLI/脚本复用。

## [0.3.19] - 2026-08-07

### Added
- **portal 认证策略(one_factor / two_factor / deny)端到端强制**(`src/providers/portal.ts`)：
  per-host 策略经 `registerHost` 写入 hosts-policy.json,脚本按请求读取——
  deny → 403;two_factor → 会话须含 2FA 标记(密码登录后必经 /login/2fa 步)。
- **tools/verify-policy.mjs**:策略验证工具(单因素/双因素/拒绝全部 12 项端到端断言),
  用法 `node tools/verify-policy.mjs`,失败退出码 1。

### Fixed
- **proxy 模式 authz 探测把 403 当 redirect**(`src/proxy.ts`)：deny 策略的 403 被转成
  302 登录页 → 无限跳转。403 → fail closed(直接 403)。
- **verifySession 改对象后 2FA 步骤用对象当 key**(`src/providers/portal.ts`)：`users[name]`
  恒 undefined → 正确 TOTP 也 401。
- **proxy 模式不注册 host 策略**(`src/expose.ts`)：仅 exposeTunnel 调 registerHost,
  proxy/both 的策略文件恒空 → deny/two_factor 不生效。proxy 模式同样注册。
- **deny 策略 portal 启动探测 403**(`src/providers/portal.ts`)：auth-request 先查会话
  (未登录 401)再查 deny(已登录 403)——探测与 deny 语义都正确。
- **auth_request 子请求不转发 Cookie**(`src/gateway.ts`)：gateway 的 authz location
  显式 `proxy_set_header Cookie $http_cookie`,保证 portal 能拿到会话。

## [0.3.18] - 2026-08-06

### Fixed
- **proxy/both 模式缺端口归属校验**(`src/expose.ts`)：verifyPortOwner 只在
  tunnel 模式,proxyExpose 可对任意端口注册 vhost——已补齐。
- **authelia 被 deployBasePath 合并弄坏**(`src/expose.ts` /
  `src/auth-provider.ts` / `src/providers/portal.ts`)：0.3.11 修 portal 合并时
  authelia 的 server.address 变成多段(/dev/autheliaxxx) → config validate
  失败。新增 `nestedBasePath` 能力标记,仅 portal(Node 服务)合并部署前缀,
  authelia 等单段约束 provider 不合并。

## [0.3.17] - 2026-08-06

### Fixed
- **both 模式 exposes 记录缺 vhost URL**(`src/expose.ts`)：both 合并只带 localUrl,
  baseUrl/domainUrl 丢失——暴露详情/活动列表看不到 both 的虚拟主机地址。

## [0.3.16] - 2026-08-06

### Fixed
- **mapServicePath 尾斜杠死循环**(`src/proxy.ts`)：请求路径恰为 deployBasePath 时
  剥前缀得 `/`、拼 serviceBasePath 产生尾斜杠(`/dev/`)→ Next 308 尾斜杠规范化
  与再次映射互相重定向。`p === "/"` 时直接返回 svc,不再加尾斜杠。

## [0.3.15] - 2026-08-06

### Fixed
- **oauth2 变体审核加固**：
  - UI 暴露页预填值（含 clientSecret）JSON 转义 `<` 防 `</script>` 逃逸 +
    属性值 HTML 转义（防引号逃逸注入事件属性）——纵深防御（值来自配置档/环境变量）；
  - 变体内部角色改按变体 id（oauth2-github/...）登记——同 site 多个变体端口
    互不覆盖/互不注销（原统一 "oauth2-proxy" 角色会互相注销）；
  - 自定义声明忽略托管键（http_address/upstreams 恒由 provider 生成）防 TOML
    重复键；`cookie_secure` 允许自定义覆盖默认 false；
  - 内置变体配置键统一 snake_case（oauth2-proxy TOML 约定：`github_org` /
    `gitlab_url` / `azure_tenant`，原 kebab 不生效）；`github_org` 等列表键
    写 TOML 数组。

## [0.3.13] - 2026-08-06

### Added
- **serviceBasePath 转发映射**(`createServiceTunnels` / `ExposeOptions` / `mapServicePath`)：
  外部只传 deployBasePath(URL 前缀,/dev)与 serviceBasePath(真实服务路径),转发时
  库自动剥 deploy 前缀、接服务自身路径——provider 登录路径合并、显示 URL 带部署
  前缀、路径映射全部库内处理,调用方不再自行拼接。

## [0.3.12] - 2026-08-06

### Added
- **OAuth2 变体 provider**（`src/providers/oauth2-variants.ts`，docs/oauth2-variants.md）：
  基于 oauth2-proxy 的声明式 auth provider 变体（`--auth oauth2-github` /
  `oauth2-google` / `oauth2-gitlab` / `oauth2-microsoft` / `oauth2-keycloak` /
  `oauth2-okta` / `oauth2-generic`）——端点/scope/flags 由变体定义携带，凭据由
  配置档 `auth.oauth2`（或旧 `auth.oidc`）携带 → 页面表单字段**默认填入**
  （复用 ParamSpec `default`；不删除、可编辑覆盖，清空某项回落配置档值），
  零输入直点暴露。**环境变量注册自定义变体**（类似 command 隧道）：
  `SERVICE_TUNNELS_OAUTH2_VARIANT_<NAME>="provider=oidc;clientId={{clientId}};..."`
  → 新类型 `oauth2-<name>`；键自动归一化 snake_case TOML（issuerUrl →
  oidc_issuer_url），`{{token}}`/`{{token:default}}` 成为表单参数，列表型键
  （github_org 等）写 TOML 数组。优先级：表单/CLI `--provider-set`
  > 配置档按变体 > 共享 > 旧 oidc > 内置固定/模板默认。变体实例复用 oauth2-proxy 侧车
  （独立 type#site 实例/端口/配置），所有写进 TOML 的值继续过控制字符校验 +
  TOML 转义（防注入）。UI 暴露页 auth 下拉数据驱动（label/已配置徽标/按需参数
  输入）；daemon `/schemas` 新增 `authMetas`；`providerOrder()` 变体按已配置优先。

## [0.3.12] - 2026-08-06

### Fixed
- **basic 认证绕过**( /  / )：
  嵌入方(pi-web Next middleware)的 rewrite 无法保留 vhost Host(fetch 规范
  forbidden header),nginx gateway 的 server_name 匹配不到 → 落到默认 server
  → auth_basic 被绕过。basic 改由决策 API 进程内校验(新增 APR1/md5-crypt
  校验),凭证有效直接 pipe 到服务,无效 401。

## [0.3.11] - 2026-08-06

### Changed
- **portal 登录体验优化**（`src/providers/portal.ts`）：loading 过渡完全放在客户端——
  点击 Sign in / Verify 的瞬间立即弹出全屏过渡页（spinner + “Signing in… / Please
  wait”，卡片样式与登录表单一致），提交期间与 302 跳转期间保持显示，直到目标页面
  渲染；登录失败（401 返回登录页）时过渡页随之消失并展示错误。服务端协议不变
  （成功仍是经典 302 到 `next`，curl/API 客户端不受影响）

### Fixed
- **deployBasePath 合并失效**（`src/providers/portal.ts` / `src/authelia.ts` /
  `src/expose.ts`）：portal/authelia 的内置 `#basePath` 默认值非空（`/portal`、
  `/authelia`），导致 `expose.ts` 的 `hasPath` 恒真，嵌入方部署路径（如 `/dev`）
  永远合并不进去——带 basePath 部署时登录重定向丢前缀（`/portal/login` 而非
  `/dev/portal-xxx/login`）。现改为内置默认空串（自描述默认仍在 `defaultBasePath()`），
  basePath 解析链 `??` 改 `||`（空串继续 fall through 到配置/默认），合并后经
  `setBasePath` 生效。**注意**：无显式 basePath 的 portal/authelia 默认登录路径
  从固定 `/portal`、`/authelia` 变为 `defaultBasePath()` 的随机路径
  （`/portal-xxx`、`/authelia<alnum>`），升级后旧登录书签/会话失效

## [0.3.1] - 2026-08-06

### Changed
- 发布包 `files` 补入 `SECURITY.md`（安全敏感工具随包发布安全策略/漏洞报告渠道）

## [0.3.0] - 2026-08-06

### Added
- **隧道配置输入安全验证**（`src/validation.ts`，docs/input-validation-security.md）：
  - ssh/serveo **选项注入封堵**：`host`/`user` 以 `-` 开头（如
    `-oProxyCommand=...`）会在本机执行任意命令——现在一律拒绝
  - **frpc INI 注入封堵**：token/server/domain 含换行/控制字符可注入配置行——
    现在一律拒绝；隧道名路径穿越（`../`）拒绝
  - 端口范围（1–65535）、类型/协议白名单、args/env 空字节校验；
    `TunnelManager.start()` 与 daemon RPC `tunnel.add` 双入口 fail-closed
  - `command` 类型经 daemon RPC 需显式 `dangerous: true` opt-in（CLI 自动携带、
    UI 确认后携带）；`expose --tunnel command` 同样受该门保护
  - **ngrok token 接线修复**：`tunnel add --type ngrok --token x` 的 token
    现注入 `NGROK_AUTHTOKEN` env（此前 schema 声明注入但实际丢弃 → ERR_NGROK_4018）
- **UI 服务器 CSRF 防护**（`src/ui.ts`）：所有 POST 要求同源 Origin +
  页面注入的 32B CSRF token（`X-CSRF-Token`，`timingSafeEqual` 比对）；移除
  `Access-Control-Allow-Origin: *`——恶意网页无法再通过简单请求向
  `127.0.0.1:4181` 注入 `command` 隧道 / 改密码
- **Windows daemon IPC 鉴权**（`src/daemon-server.ts`/`src/daemon.ts`）：TCP IPC
  改为随机 32B secret（存 state.json，0600）请求头校验；`requestDaemon` 补
  TCP 分支（此前 Windows CLI 连不上 daemon）；鉴权失败记审计日志。新增
  跨平台模拟测试验证 secret 头往返
- daemon `expose` RPC 边界补齐：辅助端口（proxyPort/nginxPort/autheliaPort/
  redisPort，0=自动放行）与 `baseDomain` 校验
- **自定义命令隧道协同**（`SERVICE_TUNNELS_TUNNEL_COMMAND_*`）：`validateTunnelConfig`
  接受自定义类型，且对其**模板参数做全字段控制字符扫描**（参数会被插值进 shell
  命令，换行等控制字符可改写命令结构）
- **auth provider 参数验证**（`src/validation.ts` 新增 `validateUserName`/`validateOidcOptions`/`tomlEscape`/`yamlEscape`）：
  - 用户名统一字符集门（YAML 键 / htpasswd 行 / totp 导出文件名的根修复）——
    authelia/basic/portal 的 UserManager + daemon IPC 双入口 fail-closed
  - oauth2-proxy OIDC 参数校验（issuerUrl 必须 http(s) URL、secret 拒控制字符）+ 写入 TOML 前转义（TOML 注入同 frpc INI 类）
  - authelia users_database.yml displayName/email YAML 转义
  - `autheliaReloadCmd`（`registerHost` 时 `shell:true` 执行的命令）禁止经 IPC 传入（仅库/配置）
- `startUi` 返回实际监听端口（`port: 0` → 随机端口时可测）；`UiServer`
  暴露 `port`
- **UI 添加隧道表单改 schema 驱动**：按 `TUNNEL_PARAM_SCHEMAS` 渲染各类型参数
  （token/domain/host/server…，密码框/数字框/选项），修复校验引入后 UI 无法添加
  ssh 等需要额外参数的隧道；`/api/tunnels/add` 前置校验并透出拒绝原因（此前
  daemon 拒绝会被静默吞掉，UI 假报"添加成功"）
- **隧道类型 `dangerous` 标记**（`TunnelMeta.dangerous`）：`command`（唯一经 shell
  执行的类型）标为 `dangerous: true`——schema 驱动的客户端据此把危险选项移出一键
  表单；用户显式 env 注册的自定义类型不标记（注册即 opt-in）
- **自定义命令隧道完整机制**（`src/tunnels-custom.ts`，`SERVICE_TUNNELS_TUNNEL_COMMAND_<NAME>`）：
  - env 注册 → 隧道类型自动出现在所有 schema 驱动客户端（表单/下拉框）；内置名
    冲突/非法名/空模板跳过并告警
  - 模板 `{{token}}` 占位符即表单参数：`{{port}}` 必填、`{{port:8080}}` 固定默认、
    `{{localport}}` 自动填被暴露本地端口（`{{localport:PORT}}` 固定覆盖）；大小写不敏感
  - 自定义类型假定 tcp 支持（`tunnelTcpSupport` 含之）；URL 输出解析与 `command` 同款
- **自定义隧道注入防护**（`resolveCustomCommand` + `validateTunnelConfig` 双入口）：
  占位符值（表单/`--set`/默认值）一律**单引号转义**注入 shell（`'`→`'\''`，值只作
  字面量——空格/`$`/反引号/`;`/`|`/`&` 全部惰性化）；控制字符（含换行/NUL）fail-closed 拒绝
- **`ST_TUNNEL_URL` URL 声明标记**：自定义/`command` 隧道输出 `ST_TUNNEL_URL:<url>`
  （`=`/空格分隔、引号/CRLF 容忍、大小写不敏感）即显式声明隧道 URL（优先于输出解析；
  无 scheme 的 `host:port` 补 `http://`；`tcp://` 原样）；Windows cmd/PowerShell 可用
  （`echo ST_TUNNEL_URL:http://...`）；进程非零退出撤销该 URL（不报假成功）

### Changed
- **进程内虚拟主机决策 API**：`st.proxy.resolve()` / `resolveServiceHost()`，
  返回 `ServiceHostDecision`（`forward` / `pipe` / `redirect` / `deny` /
  `deny-auth`）——嵌入方（如宿主应用）可在自己的 HTTP 中间件里直接做 vhost
  路由/认证决策，无需请求到达 proxy 端口（`examples/host-integration.ts`
  已更新：**中间件即网关**）
- `expose --startTransport false`：跳过 proxy 传输层启动（由嵌入方中间件
  接管 vhost 服务），`localUrl` 相应为空
- `sts` 短别名：`npm install -g service-tunnels` 同时安装 `sts` 命令，与
  `service-tunnels` 完全等价（`st` 别名因与 npm 月下载 130 万的 `st`
  静态服务器包冲突而弃用）
- **D4 决策重构**：vhost 路由 / enrollment / 认证判定收敛为单一实现
  （`resolveServiceHost`），HTTP 传输层（`createProxyServer` 含 WebSocket
  upgrade 路径）与嵌入方中间件共用同一套决策逻辑，行为严格一致
- `ProxyManager` 暴露 `resolve()` / `parseHost()`（嵌入方经
  `st.proxy.resolve` / `st.proxy.parseHost` 使用）
- `engines` 降为 `>=20.19.0`（原 `>=22.19.0`）：生产包 dist 实测支持
  Node 18/20（导入/CLI/fetch 全通），开发模式直跑 `src/*.ts` 仍需
  Node 22.18+（默认类型剥离）或 `tsx`
- 清理注释中的内部部署引用（内部私有域名、真实部署端口 → 通用示例）
- 测试扩充：决策 API 全路径（forward/pipe/redirect/deny）+ WebSocket
  upgrade 场景下 forward-auth 门禁（无 cookie 401、有效 cookie 101）

### Dependencies
- `justget` ^0.1.1 → ^0.1.6：镜像竞速下载对 4xx/5xx/超时立即切换镜像源

## [0.2.42] - 2026-08-05

> 自 0.2.37 以来的全部功能随本版本首次发布（git 历史中的 0.2.38–0.2.41
> 版本号未出现在 registry，合并计入本版本）。

### Added
- **Sites（认证域隔离）体系**：每个 site 一套独立 provider 实例 + 用户库 +
  basePath + session secret + policy（`st.sites` / `site` 子命令），互不
  共享配置和用户；`default` site 保证向后兼容（`--site` 缺省作用域）
- **proxy 暴露模式**：`expose --mode tunnel|proxy|both` 与
  `--auth none|auto|<provider>` 正交组合；proxy 模式无隧道进程、本地虚拟
  主机直达（`5173-portal.st.localhost`），both 模式本地 + 公网共享同一 site
- **D4 零转发**：proxy 默认不转发任何端口——虚拟主机必须显式 enrollment
  （`expose --mode proxy/both` 注册 binding），未 enroll 一律 403
- **baseDomain**：`SERVICE_TUNNELS_BASE_DOMAIN` 环境变量 + API 统一解析
  （opts > env > config）；多 baseDomains；`host:port` 形式（虚拟主机解析
  用 host，生成 URL 保留端口）
- **deployBasePath 合并**：嵌入方部署前缀与 provider basePath 合并
  （如 `/dev/portal/login`）；portal 登录默认重定向跟随部署前缀
- 会话 cookie 名按 site 隔离（嵌套 proxy 不冲突）
- `.localhost` 后缀族：`st.localhost` / `service-tunnel.localhost` /
  `localhost`

### Changed
- provider 不再隐含新建站点：`--auth <provider>`（不带 `--site`）作用于
  default 站用户库，登录打通（修复多 provider 用户库分裂）
- proxy 暴露记录 `running=true`（binding 在即运行）；`tunnel stop` 可移除
  proxy binding

## [0.2.37] - 2026-08-05

### Changed
- **justget 竞速下载器**：官方源 + 镜像并行拉取，失败立即切换（immediate-failure
  mirror takeover）
- **内置 Gitee 镜像**：全部二进制工具（ngrok/frpc/cloudflared/authelia/bore/
  oauth2-proxy）官方优先、镜像回退，无需额外配置

### Fixed
- ssh 隧道测试（fake ssh 路径）

## [0.2.0] - 2026-08-04

> 0.2.0 – 0.2.36 版本线（0.1.x 迭代完成后的功能完整期）。

### Added
- **M1–M6 基础能力线**（0.1.x 期间完成，随 0.2 线正式化）：
  - M1 包骨架 + XDG 目录解析 + daemon（常驻 / socket IPC / state.json）
    + discover（进程树发现 / 角色标记排除 / internal 注册表过滤）
  - M2 泛域名反向代理（白名单 / SSE / WebSocket / stripBasePath /
    Basic 密码）
  - M3 隧道管理（类型感知 / 工具解析 / 输出缓冲 / URL 解析）
  - M4 认证编排（AuthProvider 接口 + nginx 网关 + authelia 绿色启动 /
    动态登记 + redis + `expose --auth`）
  - M5 生命周期清理 + 安全加固 + 宿主应用集成示例
  - M6 插件化 provider（basic + oauth2-proxy + 边缘扩展点）
- **portal provider**：Windows 无 Authelia 二进制的绿色替代——纯 Node
  forward-auth 登录门户，与 authelia 同协议（`{basePath}/api/authz/
  auth-request`）
- **portal 安全基线**：scrypt 口令哈希 + HMAC 签名会话 cookie
  （timingSafeEqual）、登录防爆破（账号 + IP + 指数封禁 + 持久化）、
  TOTP 2FA 管理、RSA-OAEP 前端加密（密码明文不出浏览器）、无 JS /
  无 WebCrypto 降级提示
- **用户管理抽象**（UserManager）：basic htpasswd / authelia 用户库统一
  API（list/add/set-password/remove），`provider`/`all` 维度；authelia
  用户管理暴露 CLI/API/库接口
- **工具下载跨平台**：Windows zip 包 / `{ext}` / `{exe}` 模板 / 魔数探测
  解压 / `.exe` 匹配；arch 别名（x64→amd64）；toolMirrors 配置
- basePath 可配置（配置文件 + CLI `--base-path`）+ 随机趣味名
  （`{provider}-{adj}-{animal}`）+ authelia 动态验证
- **guardian 守护进程**：父进程异常退出时清理框架辅助进程（跨平台轮询 +
  实例标记精确清理）
- **国内镜像方案**：Gitee 完整模板 + 同步脚本 + 文档（`scripts/mirror-to-gitee.sh`）
- 宿主应用集成：包内含 src（宿主构建链可直接转译）+ 同步脚本；`st.auth.expose`
  接口签名修正（Omit port）

## [0.1.0] - 2026-08-04

- 初始版本线（0.1.0 – 0.1.22）：包骨架、目录解析、工具自动下载
  （PATH > 缓存 > 官方 > 镜像）、daemon、discover 的早期迭代
