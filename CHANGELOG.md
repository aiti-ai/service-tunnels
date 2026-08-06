# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 发布记录以 npm registry 实测时间为准；git 历史中的版本号
> （如 0.2.38–0.2.41）若未出现在 registry 发布列表中，其功能统一计入下一个
> 实际发布版本。

## [Unreleased]

### Added
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

### Changed
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
