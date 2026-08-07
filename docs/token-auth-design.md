# Token 认证设计 — Bearer token 方案（tunnel API 请求）

> 目标场景：**机器客户端**（CI、脚本、curl、其他服务）通过隧道/代理调用 API，
> 无法也不应走交互式登录（portal 登录页、authelia 2FA 流程）。需要一个
> **无状态、无登录页、header 即凭证**的认证方案：请求带
> `Authorization: Bearer <token>` 即放行，token 可生成、带说明、带有效期，
> 按 site 管理（与 user 同一套隔离模型）。

---

## 1. 背景与动机

现有认证方案一览：

| 方案 | 交互形态 | 适合 |
|---|---|---|
| portal | 登录页 + Cookie 会话 | 浏览器用户 |
| authelia | 登录页 + 2FA + Redis 会话 | 浏览器用户（高安全） |
| basic | `Authorization: Basic`（每请求凭证） | 浏览器/简单脚本 |

**缺口**：三者都没有"可生成、可撤销、带有效期、按 site 隔离的机器凭证"。
basic 的凭证 = 站点用户名+密码（可共享、难撤销单个、无有效期概念）；
portal/authelia 的会话 = 浏览器专用。隧道 API 请求需要：

1. 请求侧极简：**只传 `Authorization: Bearer <token>` 一个 header**；
2. 管理侧完整：**生成 / 说明 / 有效期 / 撤销**，像 user 一样按 site 管理；
3. 无登录页、无 302 跳转——认证失败直接 **401**（`WWW-Authenticate: Bearer`）。

## 2. 设计目标

| 目标 | 方案 |
|---|---|
| header 即凭证 | `Authorization: Bearer <token>`；无 Cookie、无登录页、无重定向 |
| 可生成 + 带说明 + 带有效期 | `TokenManager.createToken({ description, expiresAt })`；过期自动失效 |
| 按 site 管理 | token 存于 provider 实例（= site）存储目录，站点间互不可见（与 user 一致） |
| 可撤销 | `revokeToken(id)`；撤销立即生效（探针/决策每请求读文件） |
| 秘密保护 | 库内只存 SHA-256 哈希；原始 token 创建时唯一一次返回 |
| 兼容两条入口 | 决策 API 进程内校验（嵌入方）+ nginx `auth_request` 探针（隧道） |
| 无 basePath / 无登录页 | `gatewayMode: "token"`，`defaultBasePath() = ""`，无 `loginRedirect` |

## 3. 设计决策

| # | 决策 | 结果 |
|---|---|---|
| D1 | 新 provider type | **`token`**（`src/providers/token.ts`），自描述 `gatewayMode: "token"`；接线层不再按 type 分支 |
| D2 | nginx 侧认证形态 | 不用 `auth_basic`（nginx 无原生 Bearer 指令）→ **`auth_request → /token-authz/auth` 探针服务**（小 Node 子进程，每请求读 tokens.json） |
| D3 | 决策 API 侧 | **进程内校验**（`verifyBearerToken`，与 basic `verifyHtpasswd` 同理由：嵌入方 rewrite 保留不了 vhost Host，nginx server_name 匹配不到会落到默认 server 绕过认证） |
| D4 | token 存储 | `tokens.json`（0600）只存 **sha256(token)** + id/description/createdAt/expiresAt；绝不落原文 |
| D5 | token 形态 | `st_` + 24 字节 base64url（≈192-bit 熵）；前缀便于日志识别 |
| D6 | 管理接口 | **TokenManager** 接口（`listTokens`/`createToken`/`revokeToken`），与 UserManager 同构；`isTokenManager` 探测注册进 registry |
| D7 | 过期语义 | `expiresAt` epoch ms；null = 永不过期；过期 = fail-closed 拒绝（绝不 200）+ 读取时惰性清除；**拒绝创建已过期 token** |
| D8 | 401 语义 | 无 `@auth_redirect` 登录块；401 直返 + `WWW-Authenticate: Bearer realm="service-tunnels"`；nginx auth_request 子请求**显式转发 Authorization**（默认被剥离） |
| D9 | 无 basePath | 探针路径固定 `/token-authz/auth`（同 oauth2-proxy 的 `/oauth2/auth` 固定路径先例）；无 `providerPaths`、无 `loginUrl` |

## 4. 认证流（两条入口）

```
                 ┌─ 嵌入方（Next middleware 等）──→ 决策 API（进程内）───┐
 请求 (Bearer) ──┤                                       校验 sha256       ├─→ 应用端口
                 └─ 隧道（ngrok/cloudflared…）→ nginx 网关 ──────────────┘
                                        │ auth_request
                                        ▼
                             /token-authz/auth 探针服务（127.0.0.1）
                             （每请求读 tokens.json）
```

- **决策 API**（proxy 模式 / 嵌入方）：`gateBackend` 命中 `backend.tokenFile` →
  `verifyBearerToken(authorization, tokensFile)` → 通过直接 pipe 到服务；否则
  `deny-auth 401`。
- **nginx 网关**（隧道模式）：`auth_request /token-authz/auth` → 探针服务返回
  200/401；401 直返（无 302），带 `WWW-Authenticate: Bearer`。

两条路径共用同一个 `tokens.json`，无状态、无会话、可水平校验。

## 5. 数据模型

```jsonc
// cacheDir/tmp/token/tokens.json（default site；非 default site 在
// cacheDir/tmp/sites/<site>/token/tokens.json，registry #siteOpts 注入）
{
  "16979aaa625a8688": {                 // id = 管理用（撤销/展示）
    "id": "16979aaa625a8688",
    "description": "ci api",            // 说明（≤256 字符）
    "createdAt": 1786070676746,         // epoch ms
    "expiresAt": 1786675476742,         // epoch ms；null = 永不过期
    "hash": "e3b0c44298fc1c...",        // sha256(token) —— 唯一落盘的秘密形态
  }
}
```

TokenManager 返回给调用方的 `AuthToken`：

```ts
interface AuthToken {
  id: string;                // 管理用 id
  description: string;       // 用途说明
  createdAt: number;         // epoch ms
  expiresAt: number | null;  // epoch ms；null = 永不过期
  token?: string;            // 仅 createToken 返回一次（原始秘密）
}
```

## 6. 管理面（与 user 对齐）

| 层 | 入口 | 形态 |
|---|---|---|
| CLI | `auth token list \| create [--description <d>] [--expires <ISO\|+2h\|never>] \| revoke <id> [--site <s>]` | `--expires` 支持 ISO / 相对时长（+2h/+30d/+1y）/ epoch ms / never |
| 库 | `st.auth.tokenManagers()` / `tokens()` / `createToken()` / `revokeToken()` | 与 `users()`/`addUser()` 同构；provider 缺省 "all" |
| daemon RPC | `auth.token.managers \| list \| create \| revoke` | 带 site 作用域 |
| registry | `AuthRegistry.tokenManagers()` / `tokenManager(type, site)` | 探测式（不污染缓存实例），`type#site` 缓存键与 user 一致 |

`--site` 隔离语义与 user 完全一致：`tokenManager("token", "my-site")` 的
storageDir 在 `tmp/sites/my-site/token/`，default site 保持旧路径（零迁移）。

## 7. 安全模型

- **秘密不落盘**：tokens.json 只存 sha256；db 泄露 ≠ 可用的 token；
- **常量时间比较**：`timingSafeEqual`（决策 API 与探针服务同实现）；
- **fail-closed**：缺失 / 未知 / 过期 / 畸形（无 `Bearer ` 前缀）→ 一律 401；
  拒绝创建已过期 token；
- **高熵**：192-bit 随机，暴力不可行 → 无需速率限制（与 portal 密码不同）；
- **每请求读文件**：撤销 / 过期立即生效，无需重启探针（portal 需重启是因为
  启动时加载用户库——token 探针刻意设计为无状态按需读）；
- **回滚语义**：隧道/代理都经过同一 tokens.json；nginx 探针固定路径无 basePath
  拼接面（无注入风险）；token id 白名单 `^[a-f0-9]{16}$` 防撤销注入。

## 8. 备选方案（否决记录）

| 备选 | 否决原因 |
|---|---|
| 复用 basic + 把 token 当用户名/密码 | 无法撤销单个 token（htpasswd 行粒度）、无过期字段、语义混淆 |
| nginx 直接校验 Bearer（`map`/`if` 指令） | nginx 无原生 Bearer 支持；配置文件里写 token 哈希表 = 配置注入面 + 无法动态增删 |
| 全走探针服务（决策 API 也转发给探针） | 嵌入方（Next middleware）场景多一跳、探针不可用即整个决策失败；进程内校验是 basic 已确立的既有模式 |
| token 存明文 JSON | db 泄露即全部凭证泄露；sha256 成本为零 |
| 探针启动时加载 + 文件变更重启（portal 模式） | 撤销延迟 + 重启抖动；每请求读文件成本可忽略（本地小 JSON） |

## 9. 测试

`test/token.test.mjs`（5 项，全过）：

1. create/list/revoke + sha256 存储（不落明文）+ 过期清除 + 拒绝已过期创建；
2. 探针服务 HTTP 校验（200/401、WWW-Authenticate、撤销即时生效、scheme 大小写）；
3. nginx 配置生成（`auth_request /token-authz/auth`、无 `@auth_redirect`、
   显式转发 Authorization、无 auth_basic）；
4. 决策 API `resolveServiceHost` Bearer 进程内校验（pipe / 401）；
5. registry `tokenManagers()` + site 隔离（default vs 命名 site 独立库）。

## 10. 已落地范围（实现状态）

- [x] `src/providers/token.ts`（provider + 探针服务 + `verifyBearerToken`）
- [x] `src/auth-provider.ts`（`gatewayMode "token"` + `TokenManager`/`AuthToken`/`isTokenManager`）
- [x] `src/auth-registry.ts`（注册 "token"、`tokenManagers()`、`tokenManager()`）
- [x] `src/gateway.ts`（`GatewayAuthMode "token"` + nginx 配置生成）
- [x] `src/proxy.ts` / `src/proxy-manager.ts`（决策 API 进程内校验 + 后端解析）
- [x] `src/expose.ts`（token/basic 无 loginRedirect）
- [x] `src/index.ts` / `src/daemon-server.ts` / `src/cli.ts`（库 API + RPC + CLI）
- [x] `test/token.test.mjs` + 文档（README / docs/auth-provider.md / docs/cli.md / CHANGELOG）
