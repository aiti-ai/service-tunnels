# 认证 provider 跨平台 / 精简调研与计划

> 状态：调研完成（2026-08，release assets 实测），待评审。
> 问题：authelia 无 Windows 官方构建；portal 为自研未审计实现。
> 目标：找到「与 authelia 类似但更跨平台或更精简」的认证方案，产出实施计划。

## 1. 结论摘要

- **不存在**「功能对等 authelia + 官方 Windows 包 + 更轻量」的单一替代品，需要按场景组合。
- **最实际的路线**：把自研 **portal（Node）定为全平台默认**（Windows 上已是默认，
  见 `expose.ts` 平台分支），通过一次安全审计 + 攻击面测试把它从「未验证」变成
  「可信默认」；同时**把 nginx + redis 移出默认依赖路径**（隧道直连内置 proxy），
  让 portal 路径全平台零外部二进制。
- **固定域名 / 无密码场景**：Pocket ID（Go，官方 win/darwin/linux 二进制，SQLite，
  无 redis）是唯一「authelia 类 + 全平台官方包」的成熟选项，但 **passkey 与随机
  隧道域名根本冲突**（WebAuthn origin 绑定），只能用于 `baseDomain` / site 域名。
- **已有 SSO 上游**：oauth2-proxy 其实有 Windows 包（项目 TOOLS 表漏写 win32），
  顺手修复即可，作为「连企业 IdP」的选项。
- **明确排除**：Authentik / Keycloak / Casdoor（更重）、Pomerium（无 Windows 包、
  且是全网关替代 nginx 而非 forward-auth sidecar）、vouch-proxy（无独立二进制分发）、
  Cloudflare Access / ngrok edge-oidc（edge 认证，仅特定隧道/账号可用，作插件候选）。

## 2. 现状与实测基线

| 组件 | 现状 | 平台 | 实测/文档内存 | 说明 |
|---|---|---|---|---|
| authelia（默认 provider，Linux/macOS） | `src/authelia.ts` | linux ✅（官方 tar.gz/deb）<br>macOS ⚠️（brew，无官方 darwin 包）<br>Windows ❌（WSL2/Docker） | ~74MB（design.md §5.5） | v4.39.20 实测资产：仅 linux/freebsd + .deb |
| redis（仅 authelia 用） | `src/redis.ts` | Windows ❌（WSL2/Memurai/tporadowski） | ~16MB | `needsSessionStore` 才拉起 |
| nginx 网关 | `src/gateway.ts` | Windows ✅ 官方 zip（功能受限：无 cache、单 worker） | ~20MB | tunnel 模式必需（任意公网 Host 路由） |
| **portal（Windows 默认）** | `src/providers/portal.ts` | **全平台（Node 已存在）** | **~57MB（Node 子进程实测）** | 自研，4 个集成测试通过，无独立审计 |

现状默认路径内存 ≈ **110MB**（authelia 74 + redis 16 + nginx 20）；
portal 路径 ≈ **77MB**（portal 57 + nginx 20，若仍走 nginx）或 **57MB**（直连内置 proxy）。

portal 已具备的安全机制（`docs/config.md` / `portal.ts`）：
scrypt 哈希（随机 16B salt）、HMAC-SHA256 签名 cookie（`timingSafeEqual`）、
RSA-OAEP 前端密码加密（一次性密钥对，5min TTL，防隧道边缘看明文密码）、
账号+IP 滑动窗口限流（5 次/5min，指数退避封禁）、TOTP 2FA（RFC 6238，±1 window）、
按 site 隔离 cookie 名、`HttpOnly + SameSite=Strict`。测试：`test/portal.test.mjs`
（4 用例：forward-auth 全流程、`next` 重定向编码、RSA-OAEP、暴力破解+TOTP）、
`test/gateway-portal.test.mjs`（真 nginx 端到端）。

## 3. 调研矩阵（GitHub release assets 实测，2026-08）

| 候选 | 官方平台包 | 形态 | 内存量级 | 与项目集成模型 | 关键限制 |
|---|---|---|---|---|---|
| **Authelia**（现状） | linux ✅ / freebsd ✅<br>macOS ❌（brew）<br>**Windows ❌** | Go forward-auth | ~74MB + redis | 完全一致（auth_request + basePath + session.cookies 动态登记） | 无 win/darwin 官方包；配置热更需重启 |
| **portal**（现状） | **全平台**（Node） | Node forward-auth | ~57MB | 一致（authz endpoint + basePath + login） | 自研未审计；无 WebAuthn/LDAP/OIDC 上游 |
| **Pocket ID** v2.12.0 | **win ✅（exe）** darwin ✅ linux ✅ freebsd/openbsd ✅ | Go forward-auth + OIDC（SQLite） | ~30–40MB | 一致（nginx auth_request forward-auth） | **仅 passkey（无密码）**；WebAuthn origin 绑定 → **随机隧道域名不适用**，需固定域名 |
| **authcrunch**（greenpau/caddy-security）v1.1.64 | **win ✅** darwin ✅ linux ✅ | Go forward-auth server（caddy 插件可独立跑） | 中 | 需确认 forward-auth 端点协议 | 单维护者、文档散乱；集成工作量不确定 |
| **oauth2-proxy** v7.15.3 | **win ✅** darwin ✅ linux ✅ freebsd ✅ | Go forward-auth | ~20MB | 一致（项目已有 provider） | **需外部 OIDC IdP**，非独立门户；TOOLS 表漏 win32（陈旧） |
| **Pomerium** v0.33.0 | darwin ✅ / linux ✅<br>**Windows ❌** | Go 全网关 | 中重 | 替代 nginx 而非 sidecar | 无 win 包；架构不符 |
| Authentik / Keycloak / Casdoor | Docker / Java / SQL | IdP 套件 | 重（GB 级） | 形态不符 | 更重 |
| vouch-proxy | 无 release assets（Docker 分发） | Go forward-auth | 轻 | 一致 | 需 OAuth2 上游；无独立二进制 |
| Cloudflare Access（edge） | SaaS（cloudflared 有 win） | edge-auth | 零本地 | edge 插件（cloudflared 专用） | 需 CF 账号 + Zero Trust；仅 cloudflared |
| ngrok edge-oidc（edge） | SaaS | edge-auth | 零本地 | edge 插件 | 需 ngrok 账号 + OIDC IdP |
| **basic（htpasswd）** | nginx 自带 | auth_basic | 零增量 | 已有 provider | 无登录页 / 2FA；proxy 模式需 nginx |

## 4. 关键约束分析

1. **随机隧道域名（D4 动态登记）是主线场景**：ngrok/cloudflared/bore 随机 URL 的
   cookie domain 必须跟随请求 Host。适配模型只有两种：stateless forward-auth
   （portal 模型，cookie 跟 Host 走）或动态 config 重写 + 重启（authelia 模型）。
   **WebAuthn/passkey（Pocket ID 的核心卖点）是 origin 绑定的**，随机域名每次都是
   新 origin，passkey 无法认证 → **Pocket ID 在随机隧道上不可用**。
2. **Windows 上 nginx 官方 zip 功能受限但可用**：无 cache、单 worker，但
   `auth_request` / 反代 / WebSocket Upgrade 均正常 → portal + nginx 在 Windows
   tunnel 模式可跑（`gateway-portal.test.mjs` 验证的是同一条 nginx 路径）。
3. **redis 只为 authelia 服务**（`needsSessionStore`）→ 默认 provider 换成 portal
   即同时去掉 redis（-16MB）和 Windows 上的 WSL2 依赖。
4. **portal 的「未验证」是可解决的**：功能层面已有测试覆盖；缺口在安全审计
   （会话固定、登录 CSRF、时序、日志脱敏、RSA 密钥面）与生产级验证，不是重写。
5. **nginx 的「任意公网 Host 路由」能力**是 tunnel 模式唯一离不开 nginx 的点：
   内置 proxy 目前只解析 `<port>[-<label>].<后缀>` 本地虚拟主机。若给内置 proxy
   增加「任意 Host → 端口绑定」（等价 gateway `registerHost`），则 nginx 可整体
   移出默认路径（basic 模式也可由 proxy 直接做 auth_basic，见 `validBasicAuth`）。

## 5. 方案选项

### A. portal 定为全平台默认 + 安全审计（推荐主线，改动最小）
- 不变：`expose.ts` 平台分支（win32 → portal）。
- 改：Linux/macOS 默认也切 portal？→ **不切**，Linux/macOS 保留 authelia 默认
  （功能更全），portal 作为所有平台「轻量档」与 Windows 默认。
- 成本：一次安全审计 + 攻击面测试；无新依赖。
- 收益：全平台开箱即用，零外部二进制，内存 -33MB（相对现状）或 -53MB（去 nginx 后）。

### B. 内置 proxy 支持任意公网 Host 绑定，tunnel 模式免 nginx（推荐主线二期）
- proxy 增加 `registerPublicHost(host, port, auth)` 等价物（复用 `resolveServiceHost`
  决策），tunnel 的 `target` 从 nginx 端口改为 proxy 端口。
- 收益：nginx 20MB + Windows「功能受限」风险消失；nginx 只在 basic 模式（或兼容
  保留）才需要；架构上 `tunnel/proxy/both` 三模式收敛为一条 path。
- 风险：proxy 需承担所有隧道流量（吞吐、WS、SSE 已支持，见 `proxy.test.mjs`）。

### C. Pocket ID 作为「固定域名」provider 插件（推荐二期，可选）
- 场景：`baseDomain` / site 域名（固定域名），需要无密码登录 + 管理界面。
- 落地：TOOLS 表加 pocket-id（win exe / linux / darwin，SQLite 数据目录）；
  provider 实现 forward-auth 端点对接 + 首次初始化走其管理 API。
- 不做：随机隧道域名（WebAuthn 硬约束，见 §4.1）。

### D. oauth2-proxy 补 Windows（顺手修复，低投入）
- TOOLS 表 `platforms` 补 `win32`；资产是 `windows-amd64.tar.gz`（tar.gz 非 zip，
  需 `exts` 覆盖，Windows 10+ bsdtar 可解）。
- 意义：已有 SSO（Google/GitHub/企业 OIDC）用户可在 Windows 用 forward-auth 免密。

### E. authcrunch（试点评估，先不承诺）
- 唯一「本地用户 + TOTP + 官方 Windows 包」的 authelia 形态替代；但单维护者、
  文档迁移中，先做 PoC（确认 forward-auth 端点 / authz 协议）再决定是否入内置。

## 6. 推荐路线图

### Phase 1 — portal 可信化（P0，消除「未验证」+ 修平台缺口）
1. **安全审计清单**逐项过 `portal.ts` / 生成的 `server.mjs`：
   - 会话固定：登录前后 cookie 轮换、2FA ticket 一次性
   - 登录 POST CSRF（SameSite 已设，补 CSRF token 或依赖验证）
   - `timingSafeEqual` 覆盖（scrypt 比较、HMAC、TOTP）
   - 日志脱敏（不落密码/会话）、RSA 私钥仅进程内存、keyId 单次使用验证
   - 密码策略（最小长度、弱密码拒绝）与 `PORTAL_SECURE` 文档化
2. **攻击面测试**：新增 `test/portal-security.test.mjs`（会话固定、CSRF、重放、
   时序采样、限流持久化、TOTP 窗口边界、畸形输入 fuzz 一小轮）
3. **TOOLS 表修复**：oauth2-proxy 补 win32 + ext 覆盖（§5 D）
4. **docs 更新**：design.md §9 平台矩阵、config.md 安全模型补 portal 为「全平台
   默认轻量档」；README 认证段落同步

### Phase 2 — 去 nginx/redis 默认依赖（P0，精简落地）
5. proxy 增加任意公网 Host 绑定（§5 B）：`registerPublicHost` + tunnel target 切换
6. tunnel 模式默认走内置 proxy + portal；nginx 仅 basic 模式或 opt-in
7. 内存基线验证：Windows/Linux 上 `expose --mode tunnel --auth` 全程无 WSL2/系统依赖

### Phase 3 — 可选 provider（P1，按需）
8. Pocket ID provider（固定域名 site，§5 C）
9. oauth2-proxy win32 实机验证（§5 D）
10. authcrunch PoC 评估（§5 E，只出不入需结论：入内置 / 留插件示例）

### Phase 4 — authelia 定位（P2）
11. authelia 明确为 Linux/macOS 全功能选项；Windows 文档写清两条路：portal（默认）/
    WSL2 跑 authelia（需全套功能时）

## 7. 验收标准

- [ ] Windows 上 `expose 5173 --mode tunnel --auth` 零 WSL2/Docker/系统安装依赖
- [ ] portal 路径实测内存 ≤ 60MB 单进程（Phase 2 后无 nginx/redis）
- [ ] portal 安全审计清单全过 + 新增攻击面测试全绿（现有 4 用例不回归）
- [ ] `oauth2-proxy` 在 Windows 可下载、`--version` 通过（TOOLS 表修复生效）
- [ ] 现有测试套件（`node --test test/`）全绿
- [ ] docs（design.md / config.md / README）平台矩阵与认证段落同步

## 8. 风险与未决问题

- **portal 生产级验证**：审计后建议至少一个真实隧道场景（cloudflared + 随机域名）
  冒烟 + 文档「首次使用即改密」引导。
- **内置 proxy 承担隧道流量**：需压测 WS/SSE 长连接在多个并发隧道下的表现；
  nginx 现有 per-host access/error log 能力要等价搬进 proxy（`logPaths`）。
- **Pocket ID 初始化**：首次启动需管理界面建用户（无 CLI 用户管理？），provider
  落地时需确认自动化路径（REST API / 环境变量引导）。
- **authcrunch**：若 forward-auth 端点与项目 authz 协议（`{basePath}/api/authz/
  auth-request` + 401/200）不一致，则集成成本上升——PoC 先行。
