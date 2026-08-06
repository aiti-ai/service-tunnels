# Sites（认证域）设计 — 隧道与认证自由组合 + 多认证域隔离 + 纯代理模式

> 目标场景：**任意服务端口 × 任意认证域（site）自由组合**——同一台机器上的
> 每个端口、乃至同一端口的每个虚拟主机，都可以独立指定认证域：**不同 domain、
> 不同 provider、不同用户库、不同 2FA 策略**。典型示例：宿主应用自身与其子进程
> 各自独立认证域；更一般地，任何端口都可选择挂到任意 site、或完全开放。
> 同时隧道不是必选：`tunnel` / `proxy` / `both` 与 `none` / `auto` /
> `<provider>` 自由组合，通过虚拟主机语法（`port.host` / `port-auth.host` /
> `port.site.host` …）或预指定 domain/site 区分。覆盖 **CLI / 库 API / 内置 proxy /
> nginx gateway / daemon IPC** 全部层面。

---

## 1. 设计目标

| 目标 | 方案 |
|---|---|
| tunnel 与 auth **自由组合** | 两个正交维度：`mode ∈ {tunnel, proxy, both}` × `auth ∈ {none, auto, <provider>}` × `protocol ∈ {http, https, tcp}`；任意隧道类型可配任意 provider（含无隧道） |
| **所有** auth provider 支持 domain/site 概念 | Site = provider 实例的作用域：registry 缓存键 `type#site`，每 site 独立 storageDir（用户库/sqlite/htpasswd/session secret/basePath/policy），**所有** provider（portal/authelia/basic/oauth2-proxy/插件）一视同仁 |
| 不 tunnel、只代理：`port.host` / `port-auth.host` | 内置 proxy 虚拟主机语法扩展：`5173.<host>`（开放）与 `5173-auth.<host>`（认证），host = 任意已注册后缀/站点域名；无隧道进程；**显式 enroll 后才转发** |
| 不同 domain 用户**独立管理** | 每 site 独立用户库；用户管理命令/API 一律 `--site`/`{ site }` 作用域化（缺省 default） |
| 任意端口 × 任意认证域 | site 化落地：每个端口/vhost 经 `--site` 挂到任意 site，site 之间
  不同域名、不同用户库、不同 provider、不同 2FA 策略；**同一端口可同时以多个
  vhost（label）暴露**——如 `5173-host.st.localhost`（site host）与
  `5173-services.st.localhost`（site services）并存，各自走自己的认证，
  `5173.st.localhost`（开放）互不干扰 |

---

## 2. 设计决策

| # | 决策 | 结果 |
|---|---|---|
| D1 | 暴露模式 | **proxy 与 tunnel 地位对等**，同属 expose 的 mode；`tunnel` 保持默认（向后兼容） |
| D2 | basic 本地认证 | **退回 nginx**（auth_basic per-host htpasswd），Node 不实现 APR1 |
| D3 | hostsubfix 语法 | **短横线形式**：`5173-auth.st.localhost`（`-auth` 保留字 = default site）、`5173-portal.st.localhost`（label = site 名或 provider 类型）；**不用**点分隔 `<port>.<site>.<suffix>` 形式 |
| D4 | 转发安全默认 | proxy 模式**默认零转发**：任何端口（含开放与认证虚拟主机）必须显式 enrollment（**唯一入口 `expose --mode proxy/both`**）后才可达；未 enroll → 403（not enrolled） |

---

## 3. 核心概念：Site（认证域）

**site = 一个独立认证域**：provider 实例 + 用户库 + basePath + policy + session
secret + 可选域名（`domain`）/虚拟主机标签（`suffix`），全部相互隔离。

```jsonc
// configDir/sites.json（0600；缺省 = 只有隐式 default site）
{
  "default": {                        // 隐式站点，永远存在
    "provider": "portal",             // 按平台默认（win32=portal，其余=authelia）
    "auth": true,
    "basePath": "",                   // 空 = 自动生成（每 site 独立随机）
    "policy": "one_factor",
    "domain": "",                     // 空 = 无预指定公网域名（随机隧道域名动态登记）
    "user": { "name": "admin" }       // 首次初始化创建，密码随机生成打印一次
  },
  "host": {                         // 宿主自身
    "provider": "portal",
    "auth": true,
    "basePath": "/portal-host",
    "policy": "two_factor",
    "domain": "web.example.com",   // 预指定域名：tunnel 固定域名 / DNS 泛解析直达
    "suffix": "host"                // 虚拟主机标签：5173-host.st.localhost
  },
  "services": {                       // 宿主子进程（独立用户库、独立 provider）
    "provider": "basic",
    "auth": true,
    "domain": "dev.example.com"
  }
}
```

**不变式**：
1. 每 site 一个 provider **实例**（registry 缓存键 `type` → `"type#site"`）；
2. 每 site 独立存储目录 `cacheDir/tmp/sites/<site>/<provider>/`（用户库、sqlite、
   htpasswd、session secret、basePath 均落此处）；**default site 保持既有路径**
   （`tmp/portal|authelia|basic/…`）；
3. 用户管理命令默认作用到 **default site**，`--site <name>` 切换；
4. `default` site 保证向后兼容：不带 `--site` 的任何调用都作用于 default；
5. site 名只允许 `[a-z0-9-]`（小写），`auth` 为保留字（= default site 认证标记），
   禁止注册名为 `auth` 的 site。

### 3.1 SiteConfig / SiteInfo

```ts
interface SiteConfig {
  name: string;              // 唯一；"default" 为隐式
  provider?: string;         // 缺省 = 平台默认（win32=portal，其余=authelia）
  auth?: boolean;            // 该 site 默认是否认证（缺省 true）
  basePath?: string;         // 空 = 自动生成（每 site 独立，格式 {provider}-{adj}-{animal}）
  policy?: "one_factor" | "two_factor" | "deny";
  domain?: string;           // 预指定公网域名（site 的"家域名"，注册为后缀）
  suffix?: string;           // 虚拟主机标签（缺省 = site 名）；default 无标签（见 §4）
  user?: { name: string };   // 首次初始化 bootstrap 用户（密码随机打印一次）
  providerParams?: Record<string, unknown>;  // oauth2-proxy 等需要额外参数（OIDC…）
}

interface SiteInfo extends SiteConfig {
  running: boolean;
  port?: number;             // provider 实例端口（portal/authelia/oauth2-proxy 已启动时）
  hosts: string[];           // 已登记的 host（含 domain + 隧道随机域名）
}
```

### 3.2 provider API 扩展（最小侵入）

所有 provider 增加可选 `storageDir` 选项与只读 `site` 标识：

```ts
interface AuthProvider {
  readonly type: string;
  readonly site: string;                       // 所属 site（缺省 "default"）
  // …其余接口不变…
}

// create opts 增加（registry 首建该 site 时注入，provider 自行落盘到 storageDir）
type ProviderOpts = { site?: string; storageDir?: string; domain?: string; …现有字段 };
```

- **portal**：`users.json`、`brute.json`、`server.mjs` 落 `storageDir`（server.mjs
  为生成脚本，按 site 复制一份即可，脚本内路径由 env 传入）；
- **basic**：`htpasswd` 落 `storageDir`（per-site 文件；nginx 每 host 支持指向
  自己的 htpasswdFile，Node proxy 侧见 §6.2）；
- **authelia**：`configuration.yml` / `config-tunnels.yml` / `users_database.yml` /
  sqlite dataDir 全部落 `storageDir`（每 site 独立实例 = 独立进程，session secret
  与 encryption_key 各自持久化在自己的 configuration.yml）；
- **oauth2-proxy**：sidecar 配置落 `storageDir`（OIDC 回调按 site 的 domain 预注册，
  每 site 独立 client 配置——固定域名要求本就满足 site 语义）；
- **插件**：`create(type, opts, site)` 时把 `site`/`storageDir` 注入 opts，无需插件
  改接口（约定字段）。

**domain 预登记**：site 配了 `domain` 时，provider `prepare()/start()` 后由编排层把
`domain` 作为该 site 的 host 注册（gateway server 块 + provider.registerHost），
隧道随机域名与固定域名都归属该 site。

---

## 4. 寻址语法（虚拟主机 / hostsubfix / domain）

**统一模型**：已知后缀集合 = 内置 `.st.localhost` + 配置后缀 + **每个 site 的
`domain`（整域作后缀）**。host 从右向左做最长后缀匹配，剩余标签解析
`port [site] [auth]`。

### 4.1 本地虚拟主机（零隧道，`mode=proxy`）—— **短横线语法（D3）**

```
<port>.<suffix>                  → 开放直连（永不认证）            5173.st.localhost
<port>-auth.<suffix>             → default site 认证（保留字）      5173-auth.st.localhost
<port>-<label>.<suffix>          → 指定站点                       5173-portal.st.localhost
                                                                 5173-host.st.localhost
```

- **语法**：首个 `-` 前的数字是 port，其后整个字符串是 label（label 含 `-` 无妨，
  `5173-host` → label `host`）；port 段 `^\d{2,5}(?:-([a-z0-9-]+))?$`。
- **label 解析优先级**：`auth`（保留字，= default site 认证）→ 已注册 site 名 →
  内置 provider 类型（**default 站上的认证方式**：`5173-basic` = default 站的
  basic，与 `auth user add --provider basic` 默认同一用户库，见 §6.2）→
  其余 **403（未知站点）**，不静默当开放端口。
- **label 语义**：provider 类型 label 不隐含新站点——`expose --auth basic`
  （无 `--site`）的认证域就是 default 站（label 带 provider 名，用户库与 CLI/UI
  用户管理默认一致）；独立站点必须显式 `--site <name>`（label = site 名）。
- **语义**：`port.<suffix>` 开放直连（白名单兜底）；带 label 即表示"这是站点"
  （是否认证跟随 site.auth / provider 隐式默认 true），满足「开放直连」与
  「认证」两种形态。
- **启用（D4）**：语法命中 ≠ 可达。任何虚拟主机（含开放形态）必须显式 enrollment
  （§6.2）后才转发；未 enroll → **403（not enrolled）**，无任何全局放行开关。
- 大小写统一 lowercase；**不用**点分隔 `<port>.<site>.<suffix>` 形式（D3 否决）。
- 后缀集合 = 默认 `.st.localhost` + 配置后缀 + **baseDomain**（§4.4）+ site 的
  `domain`（§4.2）——同一虚拟主机语法在本地默认地址与用户域名下等价。

### 4.2 公网 / 局域网 domain（site 的 `domain` 字段，DNS 泛解析）

```
<port>.<site-domain>             → 该 site（域名后缀已隐含 site，认证随 site.auth）  5173.web.example.com
<随机>.ngrok-free.app            → 隧道随机域名 → 动态登记到所属 site（按 site 实例）
web.example.com               → site 的预指定域名本身（tunnel 固定域名 / DNS 直达）
```

- site 的 domain 作为后缀登记：`5173.web.example.com` 命中后缀
  `web.example.com` → 剩余 `5173` → site = host（由后缀推导，无需标签）；
- 多个 site 共享父域（`web.example.com` / `dev.example.com`）时靠**最长后缀
  匹配**消歧；
- site 与 host 是 **N:1 双向**：site 的 domain 是"家域名"，隧道/随机域名只是该
  site 的额外入口（同一认证域、同一批用户，cookie 按 host 天然隔离）。

### 4.3 解析算法（parseServiceHost）

```ts
interface ServiceHostMatch {
  port: number;
  suffix: string;              // 命中的后缀（去掉前导点）
  site?: string;               // 由后缀推导或 label 指定；缺省 default
  auth: boolean;               // 该虚拟主机是否启用认证
}
```

1. hostname 小写、去端口；
2. 后缀集合按长度降序，取**最长匹配**；匹配失败 → 不代理；
3. 剩余首段：`^\d{2,5}$`（开放）或 `^\d{2,5}-([a-z0-9-]+)$`（label）——label 按
   §4.1 优先级解析出 site（`auth` 保留字 / 已注册 site / provider 类型 → default 站）；
4. site 推导：后缀本身是某 site 的 domain → 该 site，此时**不允许 label**（冲突
   → 403）；否则用 label 指定的 site；
5. 端口合法性 + `auth = (label 为 auth 保留字) || site.auth`。

### 4.4 baseDomain —— 用户自有泛解析域名的无端口地址

默认地址带端口（`http://5173-portal.st.localhost:4180`）。用户配了**自己的泛解析
域名**（DNS `*.<domain>` → 本机 + nginx 反代到 proxy 端口）后，expose 额外返回
**无端口地址**：

```
config set base-domain example.com     # configDir/service-tunnels.json
config set proxy-port 4180                # 固定端口（默认已是 4180，busy→随机）

expose 5173 --mode proxy --auth portal
  → localUrl: http://5173-portal.st.localhost:4180   # 默认兜底（带端口）
  → baseUrl:  http://5173-portal.example.com      # 用户域名（无端口）
```

- baseDomain 同时加入 proxy 后缀集合（`5173-portal.example.com` 命中同一
  enrollment / 同一 site 认证域，懒接线按**实际 Host** 注册 provider——authelia
  cookie domain 是 per-host）；
- 端口可指定：`--proxy-port <p>`（CLI/库）> config `proxyPort` > 默认 4180；
- 用户 nginx 反代 `*.<baseDomain> → 127.0.0.1:<proxy-port>` 即可把本地端口完全
  隐藏；TLS 由用户 nginx 终结（baseUrl 生成 http，`loginRedirect` 跟随请求 scheme）；
- 返回结构：`{ localUrl, baseUrl }`（`st.exposes()` 同步）；`baseUrl` 缺省时不存在
  （未配 baseDomain 则不生成，仅 localUrl）。

---
---

## 5. 暴露模式组合矩阵

**统一入口：所有 mode 都经 `expose` 发起。** proxy 与 tunnel 地位对等——都需要显式
发起，传输层由调用方/daemon 持有，bindings 持久化在 state.json。

三个正交维度：

| 维度 | 取值 | 含义 |
|---|---|---|
| `mode` | `tunnel`（默认） | 公网隧道 → URL（ngrok/frpc/ssh/…） |
| | `proxy` | 本机/局域网虚拟主机（`port[.site][-auth].host`），**无隧道进程**；需显式 enrollment（同 tunnel） |
| | `both` | 两条入口同一 site、同一批用户（本地直连 + 公网隧道） |
| `auth` | `none` | 无认证（开放虚拟主机 / 纯透传隧道） |
| | `auto`（默认） | 按平台/可用性选 provider（win32=portal，其余=authelia） |
| | `<provider>` | 显式指定（portal / authelia / basic / oauth2-proxy / 插件） |
| `protocol` | `http` / `https` | 走 gateway/proxy（可认证） |
| | `tcp` | 仅 `mode=tunnel` 且 `auth=none`（原始 TCP 无法做 HTTP 认证） |
| `site` | 缺省 `default` | 显式 `<site>` 指定认证域 |

**约束**：
- `protocol=tcp` ⇒ `mode=tunnel` + `auth=none`（强制，`tunnelSupportsTcp` 校验不变）；
- **edge-auth provider**（ngrok edge-oidc 类，`edgeAuth && !localGateway`）⇒
  `mode=tunnel`（认证在隧道边缘，与 site 无关的本地实例不需要）；site 语义仍保留
  （每 site 可配不同边缘认证参数），列为可选；
- `mode=proxy` + `auth=none` ⇒ 开放虚拟主机（`proxy start` 的等价形态，纳入
  expose 统一入口；**expose 本身就是 enrollment**，D4）；
- 转发一律显式 enrollment（D4）：`proxy start` 缺省零转发；
- `mode=both` 先建本地虚拟主机、再建隧道（同一 site 的 provider 实例，用户共用）。

**组合示例**：

```
expose 5173 --mode proxy --auth auto --site host
  → 本地 http://5173-host.st.localhost（portal 登录，site host 用户库）
  → 隧道不启动

expose 5173 --mode proxy --auth auto --site host --domain web.example.com
  → 本地 http://5173-host.st.localhost + 公网 http://5173.web.example.com
  → 同一 provider 实例（domain 注册为后缀，见 §4.2）

expose 5173 --mode tunnel --auth none
  → 纯公网透传隧道

expose 5173 --mode both --auth auto --site host --tunnel ngrok
  → 本地 5173-host.st.localhost + 公网 <随机>.ngrok-free.app
  → 两个入口共用 site host 的 provider 实例与用户
```

CLI 命名：`--mode tunnel|proxy|both`（避免与 `--auth auto` 混淆）；缺省 `tunnel`
保持向后兼容。

---

## 6. 各层设计

### 6.1 auth 层（registry + providers）—— 隔离基础

**AuthRegistry**：
- 实例缓存键 `#instances: Map<"type#site", AuthProvider>`；
- `create(type, opts, site = "default")`：首建时把
  `{ site, storageDir: cacheDir/tmp/sites/<site>/<provider>, domain }` 注入 opts；
- `userManager(type, site)`、`totp*` 等加 site 作用域；`list()` 不变（类型维度）；
- `loadProviderPlugins` 不变（插件 factory 收到的 ctx 不变，site 经 opts 传递）。

**providers（storageDir 化）**：见 §3.2。要点：
- 构造器 `opts.storageDir` 缺省 = 既有路径（`tmp/<provider>`）；
- portal/basic/authelia 的 `prepare()` 在 storageDir 下 mkdir + 写初始用户；
- 多实例 = 多进程：**authelia ~74MB/site、portal ~30MB/site、basic 0 进程**
  （见 §7 取舍：多 site 推荐 portal/basic；Redis 全局共享一个实例，session secret
  各 site 独立）。

**用户管理**：`auth user list|add|set-password|remove`、`auth totp *` 全部接受
`--site`；缺省 = default。库 API 同步：`st.auth.users(provider?, { site })`、
`st.auth.addUser(name, pw, { site, provider, displayName })` …（provider 参数保留，
"all" 仍跨 provider，但作用域限于该 site）。

### 6.2 内置 proxy（proxy.ts）—— per-host 认证 + 显式 enrollment（D4）

- **enrollment 模型（D4，安全默认）**：proxy **默认不转发任何端口**，只服务已登记
  的绑定 `binding = (port, site?, auth?, open?)`。**唯一入口是 `expose`**（proxy
  现在就是 tunnel 的一种 mode，与隧道地位对等）：
  1. `expose <port> --mode proxy|both`（返回 URL，写 state.json + 内存）；
  2. site 配置本身**不产生转发**（只定义认证域），转发仍需 binding。
  未命中任何 binding 的虚拟主机 → **403（not enrolled）**，即使端口已发现、语法
  已命中。全局密码门（`--password`）保留为 open binding 的可选附加门；认证站点走
  per-host provider，不经密码门。
- `parseServiceHost(host, suffixes, sites?)`：`{ port, suffix, site?, auth }`
  （§4.3）；`serviceHostRegex` 后缀集合由调用方传入（含 site domain）；
- `createProxyServer` 支持每虚拟主机按匹配结果选后端：
  - **open**（`auth=false`）：直连 `127.0.0.1:<port>`（仅当该端口有 open binding）；
  - **forward-auth**（portal / authelia / oauth2-proxy）：复用 `checkForwardAuth`
    → provider `{ port, basePath, loginRedirect }`；**新增** `{basePath}/*` 路径转发
    到 provider 端口（nginx `portalBlock` 的等价物，登录页/回调能在本地虚拟主机上
    访问）；`loginRedirect` 用 `https://$host…` 模板；
  - **basic（D2：退回 nginx）**：该 host 走 nginx gateway 的 `auth_basic`
    （per-host htpasswdFile），Node **不实现** APR1——proxy 命中 basic site 时把
    请求原样转发到 gateway 端口（保留 Host + X-Forwarded-*），nginx 完成挑战与
    后端路由；gateway 懒启动（首次命中 basic site 时 `gateway.start("basic")` +
    `registerHost(vhost, appPort, { authMode: "basic", htpasswdFile })`）。
- **懒接线**：proxy 首次命中**已 expose（enroll）** 且未运行 provider
  的虚拟主机时，validate → start → `registerHost(该虚拟主机, { policy })` 后再继续
  处理（首请求 302 到登录页）——`expose 5173 --mode proxy --auth portal` 一条命令
  即可用。
- **scheme 跟随模式**：本地 http 访问时 forward-auth 探针传
  `x-original-url: http://…`、`x-forwarded-proto: http`；loginRedirect 模板按请求
  scheme 动态（本地 `http://$host…`、隧道 `https://$host…`）；portal 天然支持
  http；authelia 若拒绝 http 目标，本地模式建议 portal/basic（见 §7 风险 8）。
- WebSocket upgrade：open host 直连；auth host 先探 forward-auth 再转发
  （per-host）；
- **bindings**：`expose --mode proxy/both` 写入 `(port, site?, auth?, open?)` 到
  state.json + 内存；proxy 查询绑定决定端口属于哪个 site、是否开放。停 expose /
  停隧道时清理绑定（§7 风险 6）。binding 是转发的唯一来源（无全局开关）。

### 6.3 nginx gateway（gateway.ts）

- `GatewayHost` 支持 per-host `authPort / basePath / htpasswdFile / authMode /
  loginRedirect / scheme`——一个 nginx 路由不同 host 到不同 site 的 provider 实例；
- 在 `registerHost` 时由调用方传入 **site 对应 provider 的端口/basePath**；
- `GatewayHost` 增加可选 `site` 字段（日志、状态、UI 展示用）；
- 隧道模式（`mode=tunnel/both`）的 host 注册流程不变。

### 6.4 expose 编排（expose.ts）

- 输入：`ExposeOptions` 增加 `site?`、`mode?: "tunnel"|"proxy"|"both"`（缺省
  `tunnel`）、`domain?`（proxy 模式可选的 site 预指定域覆盖）；
- 流程按 mode 分支：
  - **proxy**：**懒启动共享 proxy 传输层**（Node 反代单例，默认端口 4180，
    `--proxy-port` 可配，0=随机；与 nginx gateway 同款生命周期，daemon 重启恢复）
    → 解析 site → registry 建/取 site 实例 → provider validate + start（需要时
    Redis，全局共享）→ 本地绑定 `(port, site)` 落 state.json → 返回
    `localUrl: http://<port>-<site>.<suffix>`（default 为
    `http://<port>-auth.<suffix>`）；site 配了 `domain` 时同时登记该域 →
    `domainUrl: http://<port>.<site-domain>`（认证随 site.auth）；
  - **tunnel**：注册目标为 **site 实例**（basePath/authPort/htpasswd
    来自 site provider）；
  - **both**：先 proxy 再 tunnel（同一 site 实例，用户共用）；
- 结果增加 `site`、`localUrl`、`domainUrl`；`loginUrl` 指向 site 的 basePath；
- `providerType` 解析优先级：`opts.provider` > site.provider > 平台默认。

### 6.5 CLI（cli.ts）

```
site list | show <name> | add <name> [--provider portal|authelia|basic|oauth2-proxy]
           [--auth true|false] [--base-path <p>] [--policy <p>] [--domain <d>]
           [--suffix <s>] [--provider-set k=v ...] | remove <name>
expose <port> [--site <s>] [--mode tunnel|proxy|both] [--auth auto|none|<provider>]
              [--tunnel <t>] [--domain <d>] …
auth user list|add|set-password|remove <name> [--site <s>] [--provider ...]
auth totp enroll|disable|status <name> [--site <s>]
proxy start|stop|status [--port <p>] [--suffix <s>] [--base-path <bp>] [--password]
                       # 仅管理 proxy 传输层（foreground 调试/测试）；enrollment 一律经 expose
```

- 全局参数不变；`site`/`--site`/`--mode` 进 daemon IPC 请求体（§6.7）；
- 无 site 文件时 `site list` 显示 `default`（隐式）。

### 6.6 库 API（index.ts）

```ts
st.sites.list(): SiteInfo[];                    // 含隐式 default
st.sites.add(name: string, cfg: SiteConfig): void;
st.sites.remove(name: string): void;
st.sites.get(name: string): SiteInfo | undefined;

st.auth.expose(port, { site?, mode?, domain?, auth?, provider?, … });  // mode 缺省 tunnel
st.auth.users(provider?, site?);                // site 缺省 "default"
st.auth.addUser(name, pw, { site?, provider?, displayName? });
st.auth.setUserPassword / removeUser / totp*（同加 site）

st.proxy.create({ port, suffixes, sites?, … }); // 仅创建传输层（expose --mode proxy 自动懒启动；直接调用限库模式/测试）
st.exposes() → 增加 site / localUrl / domainUrl 字段
```

### 6.7 daemon IPC / state（daemon-server.ts / state.ts）

- RPC：`site.list / site.add / site.remove / site.show`；
- `expose`、`auth.user.*`、`auth.totp.*` 请求体增加 `site` / `mode` / `domain`；
- state.json 持久化 `sites`（运行时状态：实例端口/运行中/hosts）+ `bindings`
  （port → site 映射 + localUrl），daemon 重启后恢复（`st.sites` 从 state 读运行态）；
- 既有 RPC 不变（无 `site` 字段 = default）。

### 6.8 UI（ui.ts，可选）

`ui` 提供站点管理：site 列表/增删、per-site 用户管理、per-site 暴露入口、绑定列表。

---

## 7. 风险与取舍

1. **authelia 多实例内存**：每 site 一个 authelia 进程 ≈74MB + Redis（Redis 全局
   共享一个实例，session secret 各自独立）。**建议**：多 site 优先 portal/basic；
   authelia 只用于少量（1-2）高安全站点；文档明示资源预算。
2. **portal 会话**：portal cookie secret 按实例随机、不持久化——site
   重启后旧会话失效，可接受（default site 亦如此）。
3. **basic 本地认证（D2）**：退回 nginx `auth_basic`（per-host htpasswdFile），
   Node 不实现 APR1；代价是 basic site 首次命中时多一个 nginx 进程（~20MB，懒启动，
   全局共享一个 gateway）。
4. **双转发层（Node proxy vs nginx）**：本地走 Node、公网走 nginx 存在逻辑重复；
   可收敛为**单转发层**（Node proxy 全接管，nginx 仅保留给 basic/兼容路径），
   列为后续可选项。
5. **hostsubfix 语法安全**：未知 site 标签一律 403；`auth` 保留字冲突显式报错；
   端口/site/后缀校验沿用 `#sanitizeHost` 风格白名单（域名 ≤253、无注入字符）。
6. **enrollment 生命周期与安全默认（D4）**：binding 随 daemon/进程存活；停隧道/停
   expose 时清理，防止端口易主后被错误保护或误认证。调用方必须逐端口显式 enroll；
   未 enroll 一律 403。
7. **oauth2-proxy 固定域名**：OIDC 回调按 site 的 domain 预注册；随机隧道域名对其
   不可用（`randomDomain: false` 约束）——proxy 模式天然固定 host，反而更适配。
8. **本地 http 认证的 scheme**：forward-auth 探针与 loginRedirect 按请求 scheme 动态
   （本地 http、隧道 https）；portal 天然支持 http；authelia 若校验 X-Original-URL
   拒绝 http 目标，本地模式建议 portal/basic（authelia 留给 tunnel 模式）。

---

## 8. 测试覆盖

| 层 | 用例 |
|---|---|
| 单元 | site 配置解析/校验；hostsubfix 短横线语法（`-auth` 保留字、label 解析、最长后缀、未知 label 403）；enrollment 判定（未 enroll 403）；storageDir 隔离；user/totp site 作用域 |
| 集成 | 默认零转发（无 expose 全 403，含已发现端口）；expose `--mode proxy` × portal per-host（401→登录→200，`{basePath}/*` 可达）；× basic→nginx（auth_basic 401 挑战→200）；open binding（`--mode proxy --auth none`）直连；expose `mode=proxy/both/tunnel` 三态；tcp 约束 |
| 端到端 | CLI：`site add` → `expose --site X --mode both` → 双入口登录；daemon 重启恢复；`stop-all` 清理 |
| 回归 | 现有 `test/*.test.mjs` 全绿（default site 行为不变） |

---

## 9. 附：落地示例

### 9.1 宿主应用（host/services 两域）

```
site add host --provider portal --domain web.example.com --policy two_factor
site add services --provider basic --domain dev.example.com

# 宿主自身（管理界面）→ site host
 expose 3000 --site host --mode both --auth auto --tunnel cloudflared
  → https://web.example.com            （或随机 trycloudflare 域名）
  → http://3000-host.st.localhost       （本地直连，同一套 portal 用户）

# 宿主子进程测试服务 → site services（独立用户库）
 expose 5173 --site services --mode proxy --auth auto
  → http://5173-services.st.localhost     （basic 登录，services 独立 htpasswd）
 expose 5173 --site services --mode both --auth auto --tunnel ngrok
  → http://5173-services.st.localhost     （本地，认证）
  → <随机>.ngrok-free.app                 （公网，同一批 services 用户）
```

宿主自身（site host）与子进程（site services）**不同域名、不同用户库、不同
provider**，互不共享任何配置；`5173.st.localhost`（无 label）仍为开放直连。

### 9.2 多端口 × 多认证（通用场景）

site 不限于“宿主/子进程”二分——**每个端口（乃至同一端口的每个 vhost）都可以
独立选择认证域或完全开放**：

```
# 同一台机器，任意端口各自挂不同 site / 开放
 expose 3000 --mode proxy --auth auto --site host        # portal + 2FA
 expose 4000 --mode proxy --auth auto --site services    # basic（另一批用户）
 expose 8080 --mode proxy --auth none                    # 开放直连（enroll 后）
 expose 5000 --mode tunnel --auth auto --site host       # 公网隧道 + host 域用户

# 同一端口以多个 vhost 暴露，各自走不同认证（binding key = port:label）
 expose 5173 --mode proxy --auth auto --site host        # 5173-host.st.localhost
 expose 5173 --mode proxy --auth auto --site services    # 5173-services.st.localhost
 expose 5173 --mode proxy --auth none                    # 5173.st.localhost 开放
```

同一端口的三条 expose 互不干扰：vhost label（site 名）区分路由，cookie 名按
site 隔离（`st_portal_host_session` / `st_portal_services_session`），用户库
互不共享。
