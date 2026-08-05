# Sites（认证域）重构计划 — 隧道与认证自由组合 + 多认证域隔离 + 纯代理模式

> 本文件是**实施计划**（设计 + 分阶段任务 + 验收标准）。目标场景：pi-web 自身与
> pi-web 子进程各自有独立认证域——**不同 domain、不同配置、不同用户库**；同时隧道
> 不再是必选：`tunnel` / `proxy` / `both` 与 `none` / `auto` / `<provider>` 自由组合，
> 通过虚拟主机语法（`port.host` / `port-auth.host` / `port.site.host` …）或预指定
> domain/site 区分。覆盖 **CLI / 库 API / 内置 proxy / nginx gateway / daemon IPC** 全部层面。

---

## 0.5 决策记录（已确认）

| # | 决策 | 结果 |
|---|---|---|
| D1 | 里程碑顺序 | **先做 P2（proxy 语法）快速见效**；P1（sites/registry/storageDir 真隔离）紧随，两者无硬依赖（P2 先行期各 label 复用 registry 的 default 实例） |
| D2 | basic 本地认证 | **退回 nginx**（auth_basic per-host htpasswd），Node 不实现 APR1 |
| D3 | hostsubfix 语法 | **短横线形式**：`5173-auth.st.localhost`（`-auth` 保留字 = default site）、`5173-portal.st.localhost`（label = site 名或 provider 类型）；**不用**点分隔 `<port>.<site>.<suffix>` 形式 |
| D4 | 转发安全默认 | proxy 模式**默认零转发**：任何端口（含开放与认证虚拟主机）必须显式 enrollment（**唯一入口 `expose --mode proxy/both`**）后才可达；**旧"发现缓存全放行"行为直接移除，无 `--open` 兼容开关**（破坏性变更，安全缺口）；未 enroll → 403（not enrolled）。proxy 与 tunnel 地位对等，同属 expose 的 mode |

---

## 0. 需求映射

| # | 需求 | 本方案落地 |
|---|---|---|
| R1 | tunnel 与 auth **自由组合** | 两个正交维度：`mode ∈ {tunnel, proxy, both}` × `auth ∈ {none, auto, <provider>}` × `protocol ∈ {http, https, tcp}`；任意隧道类型可配任意 provider（含无隧道） |
| R2 | **所有** auth provider 支持 domain/site 概念 | Site = provider 实例的作用域：registry 缓存键 `type#site`，每 site 独立 storageDir（用户库/sqlite/htpasswd/session secret/basePath/policy），**所有** provider（portal/authelia/basic/oauth2-proxy/插件）一视同仁 |
| R3 | 不 tunnel、只代理的新式：`port.host` / `port-auth.host` | 内置 proxy 虚拟主机语法扩展：`5173.<host>`（开放）与 `5173-auth.<host>`（认证），host = 任意已注册后缀/站点域名；无隧道进程；**D4：显式 enroll 后才转发** |
| R4 | 不同 domain 用户**独立管理** | 每 site 独立用户库；用户管理命令/API 一律 `--site`/`{ site }` 作用域化（缺省 default，向后兼容） |
| R5 | pi-web 自身与子进程不共享用户；pi-web 有自己的 tunnel domain | pi-web 落地：site `pi-web`（自身，独立域名 `web.pi.example.com`）+ site `services`（子进程），不同域名、不同用户库、不同 provider |

---

## 1. 现状与缺口

| 层面 | 现状 | 问题 |
|---|---|---|
| **认证域** | `AuthRegistry` 按 **type** 缓存单例（一个 portal / authelia / basic 实例），所有 expose 的 host 注册到同一实例；basePath 由首个 expose 固定 | 所有站点共享一套用户库、basePath、session secret —— **无 site 隔离**（R2/R4 缺口） |
| **expose** | `expose <port> [--auth]` **隧道必选**：等公网 URL → 注册 host | 没有"仅本机/局域网、不要隧道"的路径；`proxy start` 与 expose 是两套互不相干的入口（R3 缺口） |
| **内置 proxy** | 仅匹配 `<port>.<suffix>`；认证只有全局单一 Basic 密码；forward-auth 接口（`ProxyAuth`）已实现但 CLI 未接线 | 无 per-host / per-site 认证；portal/authelia 无法挂在本地虚拟主机上（R1/R3 缺口） |
| **provider 存储** | 路径硬编码：`cacheDir/tmp/portal/users.json`、`tmp/authelia/…`、`tmp/basic/htpasswd` | 多个认证域会写同一文件，用户互相污染（R4 缺口） |

**工作树现状**：`src/proxy.ts` 已含 `ProxyAuth` forward-auth 探针 + `proxyTarget` +
WS 转发（未提交的 P0 基础）；`docs/sites-design.md` 为本计划前身草稿。

---

## 2. 核心概念：Site（认证域）

**site = 一个独立认证域**：provider 实例 + 用户库 + basePath + policy + session
secret + 可选域名（`domain`）/虚拟主机标签（`suffix`），全部相互隔离。

```jsonc
// configDir/sites.json（0600；缺省 = 只有隐式 default site，行为与现状完全一致）
{
  "default": {                        // 隐式站点，永远存在；兼容现状
    "provider": "portal",             // 按平台默认（win32=portal，其余=authelia）
    "auth": true,
    "basePath": "",                   // 空 = 自动生成（每 site 独立随机）
    "policy": "one_factor",
    "domain": "",                     // 空 = 无预指定公网域名（随机隧道域名动态登记）
    "user": { "name": "admin" }       // 首次初始化创建，密码随机生成打印一次
  },
  "pi-web": {                         // pi-web 自身
    "provider": "portal",
    "auth": true,
    "basePath": "/portal-piweb",
    "policy": "two_factor",
    "domain": "web.pi.example.com",   // 预指定域名：tunnel 固定域名 / DNS 泛解析直达
    "suffix": "pi-web"                // 虚拟主机标签：5173-pi-web.st.localhost
  },
  "services": {                       // pi-web 子进程（独立用户库、独立 provider）
    "provider": "basic",
    "auth": true,
    "domain": "dev.pi.example.com"
  }
}
```

**不变式**：
1. 每 site 一个 provider **实例**（registry 缓存键 `type` → `"type#site"`）；
2. 每 site 独立存储目录 `cacheDir/tmp/sites/<site>/<provider>/`（用户库、sqlite、
   htpasswd、session secret、basePath 均落此处）；**default site 保持现有路径**
   （`tmp/portal|authelia|basic/…`）——老 state.json / cache 残留零迁移；
3. 用户管理命令默认作用到 **default site**，`--site <name>` 切换；
4. `default` site 保证向后兼容：不带 `--site` 的任何调用都落回现状行为；
5. site 名只允许 `[a-z0-9-]`（小写），`auth` 为保留字（= default site 认证标记），
   禁止注册名为 `auth` 的 site。

### 2.1 SiteConfig / SiteInfo

```ts
interface SiteConfig {
  name: string;              // 唯一；"default" 为隐式
  provider?: string;         // 缺省 = 平台默认（win32=portal，其余=authelia）
  auth?: boolean;            // 该 site 默认是否认证（缺省 true）
  basePath?: string;         // 空 = 自动生成（每 site 独立，格式 {provider}-{adj}-{animal}）
  policy?: "one_factor" | "two_factor" | "deny";
  domain?: string;           // 预指定公网域名（site 的"家域名"，注册为后缀）
  suffix?: string;           // 虚拟主机标签（缺省 = site 名）；default 无标签（见 §3）
  user?: { name: string };   // 首次初始化 bootstrap 用户（密码随机打印一次）
  providerParams?: Record<string, unknown>;  // oauth2-proxy 等需要额外参数（OIDC…）
}

interface SiteInfo extends SiteConfig {
  running: boolean;
  port?: number;             // provider 实例端口（portal/authelia/oauth2-proxy 已启动时）
  hosts: string[];           // 已登记的 host（含 domain + 隧道随机域名）
}
```

### 2.2 provider API 扩展（最小侵入）

所有 provider 增加可选 `storageDir` 选项与只读 `site` 标识：

```ts
interface AuthProvider {
  readonly type: string;
  readonly site: string;                       // 新增：所属 site（缺省 "default"）
  // …其余接口不变…
}

// create opts 增加（registry 首建该 site 时注入，provider 自行落盘到 storageDir）
type ProviderOpts = { site?: string; storageDir?: string; domain?: string; …现有字段 };
```

- **portal**：`users.json`、`brute.json`、`server.mjs` 落 `storageDir`（server.mjs
  为生成脚本，按 site 复制一份即可，脚本内路径由 env 传入，已满足）；
- **basic**：`htpasswd` 落 `storageDir`（per-site 文件；nginx 每 host 已支持指向
  自己的 htpasswdFile，Node proxy 侧见 §5.2）；
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

## 3. 寻址语法（虚拟主机 / hostsubfix / domain）

**统一模型**：已知后缀集合 = 内置 `.st.localhost` + 配置后缀 + **每个 site 的
`domain`（整域作后缀）**。host 从右向左做最长后缀匹配，剩余标签解析
`port [site] [auth]`。

### 3.1 本地虚拟主机（零隧道，`mode=proxy`）—— **短横线语法（D3）**

```
<port>.<suffix>                  → 开放直连（现状语义，永不认证）    5173.st.localhost
<port>-auth.<suffix>             → default site 认证（保留字）      5173-auth.st.localhost
<port>-<label>.<suffix>          → 指定站点                       5173-portal.st.localhost
                                                                 5173-pi-web.st.localhost
```

- **语法**：首个 `-` 前的数字是 port，其后整个字符串是 label（label 含 `-` 无妨，
  `5173-pi-web` → label `pi-web`）；port 段 `^\d{2,5}(?:-([a-z0-9-]+))?$`。
- **label 解析优先级**：`auth`（保留字，= default site 认证）→ 已注册 site 名 →
  内置 provider 类型（**隐式站点**：auth=true、独立用户库、懒启动，见 §5.2）→
  其余 **403（未知站点）**，不静默当开放端口。
- **语义**：`port.<suffix>` 开放直连（白名单兜底）；带 label 即表示"这是站点"
  （是否认证跟随 site.auth / provider 隐式默认 true）。满足 R3 的
  "`port.host`（开放）或 `port-auth.host`（认证）"两种形态。
- **启用（D4）**：语法命中 ≠ 可达。任何虚拟主机（含开放形态）必须显式 enrollment
  （§5.2）后才转发；未 enroll → **403（not enrolled）**。旧"发现缓存全放行"行为已
  移除，**无任何全局放行开关**。
- 大小写统一 lowercase；**不用**点分隔 `<port>.<site>.<suffix>` 形式（D3 否决）。
- 后缀集合 = 默认 `.st.localhost` + 配置后缀 + **baseDomain**（§3.4）+ site 的
  `domain`（§3.2）——同一虚拟主机语法在本地默认地址与用户域名下等价。

### 3.2 公网 / 局域网 domain（site 的 `domain` 字段，DNS 泛解析）

```
<port>.<site-domain>             → 该 site（域名后缀已隐含 site，认证随 site.auth）  5173.web.pi.example.com
<随机>.ngrok-free.app            → 隧道随机域名 → 动态登记到所属 site（现状流程，按 site 实例）
web.pi.example.com               → site 的预指定域名本身（tunnel 固定域名 / DNS 直达）
```

- site 的 domain 作为后缀登记：`5173.web.pi.example.com` 命中后缀
  `web.pi.example.com` → 剩余 `5173` → site = pi-web（由后缀推导，无需标签）；
- 多个 site 共享父域（`web.pi.example.com` / `dev.pi.example.com`）时靠**最长后缀
  匹配**消歧；
- site 与 host 是 **N:1 双向**：site 的 domain 是"家域名"，隧道/随机域名只是该
  site 的额外入口（同一认证域、同一批用户，cookie 按 host 天然隔离）。

### 3.3 解析算法（parseServiceHost 扩展）

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
   §3.1 优先级解析出 site（`auth` 保留字 / 已注册 site / 隐式 provider 站点）；
4. site 推导：后缀本身是某 site 的 domain → 该 site，此时**不允许 label**（冲突
   → 403）；否则用 label 指定的 site；
5. 端口合法性 + `auth = (label 为 auth 保留字) || site.auth`。

### 3.4 baseDomain —— 用户自有泛解析域名的无端口地址

默认地址带端口（`http://5173-portal.st.localhost:4180`）。用户配了**自己的泛解析
域名**（DNS `*.<domain>` → 本机 + nginx 反代到 proxy 端口）后，expose 额外返回
**无端口地址**：

```
config set base-domain pi.example.com     # configDir/service-tunnels.json
config set proxy-port 4180                # 固定端口（默认已是 4180，busy→随机）

expose 5173 --mode proxy --auth portal
  → localUrl: http://5173-portal.st.localhost:4180   # 默认兜底（带端口）
  → baseUrl:  http://5173-portal.pi.example.com      # 用户域名（无端口）
```

- baseDomain 同时加入 proxy 后缀集合（`5173-portal.pi.example.com` 命中同一
  enrollment / 同一 site 认证域，懒接线按**实际 Host** 注册 provider——authelia
  cookie domain 是 per-host）；
- 端口可指定：`--proxy-port <p>`（CLI/库）> config `proxyPort` > 默认 4180；
- 用户 nginx 反代 `*.<baseDomain> → 127.0.0.1:<proxy-port>` 即可把本地端口完全
  隐藏；TLS 由用户 nginx 终结（baseUrl 生成 http，`loginRedirect` 跟随请求 scheme）；
- 返回结构：`{ localUrl, baseUrl }`（`st.exposes()` 同步）；`baseUrl` 缺省时不存在
  （未配 baseDomain 则不生成，仅 localUrl）。

---
---

## 4. 暴露模式组合矩阵（R1）

**统一入口：所有 mode 都经 `expose` 发起。** proxy 与 tunnel 地位对等——都需要显式
发起（proxy 不再是被动存在的独立转发器），传输层由调用方/daemon 持有，bindings 持久化
在 state.json。

三个正交维度：

| 维度 | 取值 | 含义 |
|---|---|---|
| `mode` | `tunnel`（默认，现状） | 公网隧道 → URL（ngrok/frpc/ssh/…） |
| | `proxy`（新） | 本机/局域网虚拟主机（`port[.site][-auth].host`），**无隧道进程**；需显式 enrollment（同 tunnel） |
| | `both`（新） | 两条入口同一 site、同一批用户（本地直连 + 公网隧道） |
| `auth` | `none` | 无认证（开放虚拟主机 / 纯透传隧道，现状 `--auth none`） |
| | `auto`（默认） | 按平台/可用性选 provider（win32=portal，其余=authelia） |
| | `<provider>` | 显式指定（portal / authelia / basic / oauth2-proxy / 插件） |
| `protocol` | `http` / `https` | 走 gateway/proxy（可认证） |
| | `tcp` | 仅 `mode=tunnel` 且 `auth=none`（原始 TCP 无法做 HTTP 认证） |
| `site` | 缺省 `default` | 显式 `<site>` 指定认证域 |

**约束**：
- `protocol=tcp` ⇒ `mode=tunnel` + `auth=none`（强制，`tunnelSupportsTcp` 校验不变）；
- **edge-auth provider**（ngrok edge-oidc 类，`edgeAuth && !localGateway`）⇒
  `mode=tunnel`（认证在隧道边缘，与 site 无关的本地实例不需要）；site 语义仍保留
  （每 site 可配不同边缘认证参数），列为 P3.5 可选；
- `mode=proxy` + `auth=none` ⇒ 开放虚拟主机（现状 `proxy start` 等价物，纳入
  expose 统一入口；**expose 本身就是 enrollment**，D4）；
- 转发一律显式 enrollment（D4）：`proxy start` 缺省零转发，旧全放行行为移除、
  无兼容开关；
- `mode=both` 先建本地虚拟主机、再建隧道（同一 site 的 provider 实例，用户共用）。

**组合示例**：

```
expose 5173 --mode proxy --auth auto --site pi-web
  → 本地 http://5173-pi-web.st.localhost（portal 登录，site pi-web 用户库）
  → 隧道不启动

expose 5173 --mode proxy --auth auto --site pi-web --domain web.pi.example.com
  → 本地 http://5173-pi-web.st.localhost + 公网 http://5173.web.pi.example.com
  → 同一 provider 实例（domain 注册为后缀，见 §3.2）

expose 5173 --mode tunnel --auth none
  → 纯公网透传隧道（现状 --auth none）

expose 5173 --mode both --auth auto --site pi-web --tunnel ngrok
  → 本地 5173-pi-web.st.localhost + 公网 <随机>.ngrok-free.app
  → 两个入口共用 site pi-web 的 provider 实例与用户
```

CLI 命名：`--mode tunnel|proxy|both`（proxy = 用户所说的"只代理的新式"；不用草稿中
的 `auto` 以免与 `--auth auto` 混淆）；缺省 `tunnel` 保持向后兼容。

---

## 5. 各层改造

### 5.1 auth 层（registry + providers）—— 隔离基础（P1，紧随 P2）

**AuthRegistry**：
- 实例缓存键 `#instances: Map<"type#site", AuthProvider>`；
- `create(type, opts, site = "default")`：首建时把
  `{ site, storageDir: cacheDir/tmp/sites/<site>/<provider>, domain }` 注入 opts；
- `userManager(type, site)`、`totp*` 等加 site 作用域；`list()` 不变（类型维度）；
- `loadProviderPlugins` 不变（插件 factory 收到的 ctx 不变，site 经 opts 传递）。

**providers（storageDir 化）**：见 §2.2。要点：
- 构造器 `opts.storageDir` 缺省 = 现状路径（`tmp/<provider>`），**零迁移**；
- portal/basic/authelia 的 `prepare()` 在 storageDir 下 mkdir + 写初始用户；
- 多实例 = 多进程：**authelia ~74MB/site、portal ~30MB/site、basic 0 进程**
  （见 §8 取舍：多 site 推荐 portal/basic；Redis 全局共享一个实例，session secret
  各 site 独立）。

**用户管理**：`auth user list|add|set-password|remove`、`auth totp *` 全部接受
`--site`；缺省 = default。库 API 同步：`st.auth.users(provider?, { site })`、
`st.auth.addUser(name, pw, { site, provider, displayName })` …（provider 参数保留，
"all" 仍跨 provider，但作用域限于该 site）。

### 5.2 内置 proxy（proxy.ts）—— per-host 认证 + 显式 enrollment（D4）

- **enrollment 模型（D4，安全默认）**：proxy **默认不转发任何端口**，只服务已登记
  的绑定 `binding = (port, site?, auth?, open?)`。**唯一入口是 `expose`**（proxy
  现在就是 tunnel 的一种 mode，与隧道地位对等）：
  1. `expose <port> --mode proxy|both`（返回 URL，写 state.json + 内存）；
  2. site 配置本身**不产生转发**（只定义认证域），转发仍需 binding。
  未命中任何 binding 的虚拟主机 → **403（not enrolled）**，即使端口已发现、语法
  已命中。旧"发现缓存全放行"行为（现状 `proxy start` 默认）**直接移除、无 `--open`
  兼容开关**——判定为安全缺口（缺省暴露全部发现端口），用户必须显式开启。全局密码
  门（`--password`）保留为 open binding 的可选附加门；认证站点走 per-host provider，
  不经密码门。
- `parseServiceHost(host, suffixes, sites?)` 扩展：`{ port, suffix, site?, auth }`
  （§3.3）；`serviceHostRegex` 后缀集合由调用方传入（含 site domain）；
- `createProxyServer` 增加 `sites?: Record<string, SiteAuthBackend>`，每虚拟主机按
  匹配结果选后端：
  - **open**（`auth=false`）：直连 `127.0.0.1:<port>`（仅当该端口有 open binding）；
  - **forward-auth**（portal / authelia / oauth2-proxy）：复用现有 `checkForwardAuth`
    → provider `{ port, basePath, loginRedirect }`；**新增** `{basePath}/*` 路径转发
    到 provider 端口（nginx `portalBlock` 的等价物，登录页/回调能在本地虚拟主机上
    访问）；`loginRedirect` 用 `https://$host…` 模板（现状已有 renderLoginRedirect）；
  - **basic（D2：退回 nginx）**：该 host 走 nginx gateway 的 `auth_basic`
    （per-host htpasswdFile），Node **不实现** APR1——proxy 命中 basic site 时把
    请求原样转发到 gateway 端口（保留 Host + X-Forwarded-*），nginx 完成挑战与
    后端路由；gateway 懒启动（首次命中 basic site 时 `gateway.start("basic")` +
    `registerHost(vhost, appPort, { authMode: "basic", htpasswdFile })`）。
- **懒接线（P2 先行关键）**：proxy 首次命中**已 expose（enroll）** 且未运行 provider
  的虚拟主机时，validate → start → `registerHost(该虚拟主机, { policy })` 后再继续
  处理（首请求 302 到登录页）——`expose 5173 --mode proxy --auth portal` 一条命令
  即可演示。
- **scheme 跟随模式**：本地 http 访问时 forward-auth 探针传
  `x-original-url: http://…`、`x-forwarded-proto: http`（现 hardcode https 只在
  tunnel 模式成立）；loginRedirect 模板按请求 scheme 动态（本地 `http://$host…`、
  隧道 `https://$host…`）；portal 天然支持 http；authelia 若拒绝 http 目标，本地
  模式建议 portal/basic（见 §8 风险 8）。
- WebSocket upgrade：open host 现状；auth host 先探 forward-auth 再转发（现有
  泛化到 per-host）；
- **bindings**：`expose --mode proxy/both` 写入 `(port, site?, auth?, open?)` 到
  state.json + 内存；proxy 查询绑定决定端口属于哪个 site、是否开放。停 expose /
  停隧道时清理绑定（§8 风险 6）。binding 是转发的唯一来源（无全局开关）。

### 5.3 nginx gateway（gateway.ts）—— 基本不动

- `GatewayHost` 已支持 per-host `authPort / basePath / htpasswdFile / authMode /
  loginRedirect / scheme`——一个 nginx 路由不同 host 到不同 site 的 provider 实例；
- 只需在 `registerHost` 时由调用方传入 **site 对应 provider 的端口/basePath**；
- `GatewayHost` 增加可选 `site` 字段（日志、状态、UI 展示用）；
- 隧道模式（`mode=tunnel/both`）的 host 注册流程不变。

### 5.4 expose 编排（expose.ts）

- 输入扩展：`ExposeOptions` 增加 `site?`、`mode?: "tunnel"|"proxy"|"both"`（缺省
  `tunnel`）、`domain?`（proxy 模式可选的 site 预指定域覆盖）；
- 流程按 mode 分支：
  - **proxy**：**懒启动共享 proxy 传输层**（Node 反代单例，默认端口 4180，
    `--proxy-port` 可配，0=随机；与 nginx gateway 同款生命周期，daemon 重启恢复）
    → 解析 site → registry 建/取 site 实例 → provider validate + start（需要时
    Redis，全局共享）→ 本地绑定 `(port, site)` 落 state.json → 返回
    `localUrl: http://<port>-<site>.<suffix>`（default 为
    `http://<port>-auth.<suffix>`）；site 配了 `domain` 时同时登记该域 →
    `domainUrl: http://<port>.<site-domain>`（认证随 site.auth）；
  - **tunnel**：现状流程，注册目标改为 **site 实例**（basePath/authPort/htpasswd
    来自 site provider）；
  - **both**：先 proxy 再 tunnel（同一 site 实例，用户共用）；
- 结果增加 `site`、`localUrl`、`domainUrl`；`loginUrl` 指向 site 的 basePath；
- `providerType` 解析优先级：`opts.provider` > site.provider > 平台默认（现状逻辑
  移到 site 默认值里）。

### 5.5 CLI（cli.ts）

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

- 全局参数不变；`site`/`--site`/`--mode` 进 daemon IPC 请求体（§5.7）；
- 无 site 文件时 `site list` 显示 `default`（隐式）。

### 5.6 库 API（index.ts）

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

### 5.7 daemon IPC / state（daemon-server.ts / state.ts）

- 新增 RPC：`site.list / site.add / site.remove / site.show`；
- `expose`、`auth.user.*`、`auth.totp.*` 请求体增加 `site` / `mode` / `domain`；
- state.json 持久化 `sites`（运行时状态：实例端口/运行中/hosts）+ `bindings`
  （port → site 映射 + localUrl），daemon 重启后恢复（`st.sites` 从 state 读运行态）；
- 既有 RPC 不变（无 `site` 字段 = default）。

### 5.8 UI（ui.ts，P5 可选）

`ui` 增加站点管理：site 列表/增删、per-site 用户管理、per-site 暴露入口、绑定列表。

---

## 6. 兼容与迁移

| 调用 | 迁移后行为 |
|---|---|
| `expose <port> --auth …` | 等价 `--site default --mode tunnel`，**行为不变** |
| `auth user add …` | 等价 `--site default`，**行为不变** |
| `proxy start` | **破坏性变更（D4）**：降级为**传输层管理**（start/stop/status，foreground 调试）；缺省零转发（未 enroll → 403）；旧全放行行为移除、无 `--open`；enrollment 唯一入口 `expose --mode proxy|both`（open 可选 `--password`） |
| 老版本 state.json / cache 残留 | default site 存储路径不变（`tmp/portal\|authelia\|basic`），新 site 走 `tmp/sites/<name>/…` |
| 插件 provider | opts 新增约定字段（site/storageDir），老插件不读则行为不变 |

---

## 7. 分阶段实施计划（任务 + 文件 + 验收）

### P0（工作树已有，先合入）✅ 已合入
- [x] `src/proxy.ts`：`ProxyAuth` forward-auth 探针、`proxyTarget`、WS 转发
- [x] 测试 `test/proxy.test.mjs` 全绿；`ProxyAuth` 单测（探针 ok/redirect/deny）。

### P2（先行，D1）— 内置 proxy 虚拟主机语法 + per-host 认证 + enrollment（R3/D4，快速见效）✅ 已交付
- [x] `src/proxy.ts`：`parseServiceHost` 扩展（§3.3：最长后缀、短横线 label、保留字
      `auth`、domain-as-suffix、未知 label → 403）；`ProxyOptions.sites`；per-host
      后端（open / forward-auth + `{basePath}/*` 转发 / basic→nginx gateway）；
      WS upgrade per-host；scheme 跟随模式（本地 http / 隧道 https）；
- [x] `src/proxy.ts`：**enrollment（D4）**——binding 查询（未命中 → 403 not
      enrolled；旧全放行行为删除）；**懒接线**——首次命中已 enroll 且未运行
      provider 的虚拟主机 → validate + start + `registerHost(vhost, policy)` →
      302 到登录页；basic 懒启动 gateway + `registerHost(auth_basic + htpasswd)`；
- [x] `src/expose.ts`：**proxy 分支先行**——懒启动共享 proxy 传输层 + binding 注册 +
      provider 接线（site 隔离前的 default 实例）+ 返回 localUrl；
- [x] `src/cli.ts`：`expose --mode proxy` 参数透传（daemon IPC）；`proxy start|stop|status`
      仅管理传输层；
- [x] `src/index.ts`：`st.proxy.create` 接线 bindings/sites（隐式 provider label →
      现有 default 实例）；`st.auth.ensure(label)` 供懒接线调用。
- **验收（test/proxy.test.mjs 扩展 + test/expose-proxy.test.mjs）**：
  - [x] 无任何 expose 时：`5173.st.localhost`、`5173-auth.st.localhost`、
    `5173-portal.st.localhost` **全部 403（not enrolled）**——默认零转发，已发现
    端口同样不放行（旧行为已移除）；
  - [x] `expose 5173 --mode proxy --auth portal` 后：`5173-portal.st.localhost`
    401 → 登录 → 200（`{basePath}/login` 转发正常）；`5173-auth.st.localhost`
    （未 expose）仍 403；
  - [x] `expose 5173 --mode proxy --auth none`（open binding，可选 `--password`）：
    `5173.st.localhost` 直连（现状等价物，但显式）；
  - [x] `5173-pi-web.st.localhost` 走 site pi-web 后端（有 sites.json 且已 expose 时）；
    未知 label → 403；
  - [x] basic：`expose 5173 --mode proxy --auth basic --site services` 经 nginx
    auth_basic 401 挑战 → 200；WS upgrade 经 forward-auth 探针；
  - [x] **注**：本阶段各 label 复用 registry 的 default 实例（真隔离由 P1 提供）。

**P2 交付物**：`src/proxy-manager.ts`（ProxyManager：共享传输层 + bindings + D4
resolver + 懒接线）；`expose --mode proxy|both` + `--site`/`--proxy-port`；
CLI `proxy start|stop|status`（daemon 持有）+ `expose --mode`；daemon RPC `proxy.*`；
`st.proxy.start/stop/status/bindings/addBinding/removeBinding`；
test/expose-proxy.test.mjs（enrollment + portal 登录 + both 双入口）。

### P1（紧随，D1）— Site 配置 + registry 实例化 + storageDir（R2/R4 真隔离）✅ 已交付
- [x] 新增 `src/sites.ts`：`readSites/writeSites`（configDir/sites.json 0600）、
      `SiteConfig/SiteInfo`、隐式 default、site 名校验（`[a-z0-9-]`、禁 `auth`）；
- [x] `src/auth-registry.ts`：实例缓存键 `type#site`；`create/create(userManager/totp)`
      加 site 参数；首建注入 `{ site, storageDir, dataDir }`（非 default site）；
      `siteStatus(site)`；
- [x] `src/providers/portal.ts`：`storageDir` 选项；users.json/brute.json/server.mjs
      落 storageDir（缺省 = 现状路径）；`readonly site`；
- [x] `src/providers/basic.ts`：`storageDir` 选项；htpasswd 落 storageDir；`site`；
- [x] `src/authelia.ts`：`storageDir`/`dataDir` 选项；tmp/data 落 storageDir；`site`；
- [x] `src/providers/oauth2-proxy.ts`：`storageDir` 选项；`site`；
- [x] `src/index.ts`：`st.sites.*`（list/add/remove/get，含运行态）；`st.auth.users/
      addUser/…` `{ site }` 参数；`st.auth.expose` 统一 site 解析（dispatcher 一次，
      proxy/tunnel 分支共享同一实例）；
- [x] `src/cli.ts` + `src/daemon-server.ts`：`site` 子命令 + `site.*` RPC + user/totp
      请求体 `site`；
- [x] `src/expose.ts`：site 配置（provider/basePath/policy/providerParams/user）接入
      expose；`registry.create(..., site)`；
- [x] `src/proxy-manager.ts`：`ensureProvider`/basic htpasswd 按 `binding.site` 建实例；
      `getSites` 活取数（运行时新增 site 即时可解析 label）。
- **验收（test/sites.test.mjs 新增）**：
  - [x] 两个 site（default + custom）分别用 portal：addUser 到 site A 不影响 site B；
  - [x] 同名用户两个 site 各自独立（密码独立、删除独立）；
  - [x] 默认 site 路径仍为 `tmp/portal`；custom 为 `tmp/sites/<name>/portal`；
  - [x] `site list/add/remove` CLI + IPC 往返；
  - [x] 端到端：同一端口两个 site 的 vhost 各自用**自己的用户库**登录（双向拒绝）。

### P3 — expose modes + site 贯通（R1/R3 组合）✅ 已交付
- [x] `src/expose.ts`：`mode`/`site`/`domain`；proxy/both 分支（§5.4）；结果加
      site/localUrl/baseUrl/domainUrl；`protocol=tcp` 约束校验（dispatcher）；
      **site 配置接入**（provider/basePath/policy/providerParams/user）；
      **统一 site 解析**（一次解析，proxy/tunnel 分支共享同一实例）；
- [x] `src/index.ts`：bindings（port→site）写入 state.json + 内存；
      `st.exposes()` 加 site/localUrl/baseUrl/domainUrl；
- [x] `src/cli.ts`：`expose --site --mode --base-domain`；daemon IPC 请求体；
- [x] `src/daemon-server.ts`：expose RPC 透传 mode/site/proxyPort/baseDomain；
- [x] **site.domain 后缀**（§3.2 补全）：`<port>.<site-domain>` 隐含 site（proxy
      `resolveSuffixSite` + `#findBySite`），expose 返回 `domainUrl`；
- **验收（test/expose-proxy.test.mjs + test/sites.test.mjs）**：
  - [x] `mode=proxy --auth auto`：无隧道进程、本地 URL 出现、portal 登录 401→200；
  - [x] `mode=both`：本地 + 公网双入口、同一 portal 登录（同 site 实例）；
  - [x] `mode=tunnel` 与现状行为一致（回归）；`protocol=tcp --auth` 被拒；
  - [x] baseDomain：`baseUrl` 无端口 + 后缀可达 + 登录；
  - [x] site.domain：`domainUrl` + `5173.web.pi.example.com` 登录（双向）。

### P3.5（可选）— edge-auth provider 按 site 隔离
- [ ] `expose.ts` edge-auth 分支：site 维度的 `renderTunnelAuth` 参数（每 site 独立
      ngrok policy 等）；`auth-registry` 对 edge-auth 也按 `type#site` 缓存。
- **验收**：两个 site 用 ngrok edge-oidc 各自生成独立 policy 参数。

### P4 — CLI/daemon/state 收尾 ✅ 已交付
- [x] `src/state.ts`：`bindings` 持久化（RuntimeState.bindings）与恢复；
- [x] `src/proxy-manager.ts`：`onChange` 持久化钩子 + `restore()/persisted()`；
      daemon 启动时 `proxy.restore(state.bindings)`（provider 懒接线恢复）；
- [x] `src/index.ts`：库模式同样持久化 bindings；`st.proxy.restore/persisted`；
      `shutdown` 停全部 provider（防进程泄漏占端口）；
- [x] `docs/cli.md` / `docs/config.md` / `docs/api.md` / `CHANGELOG.md` 更新；
      `docs/sites-design.md` P0–P4 勾选。
- **验收（test/sites.test.mjs + CLI 冒烟）**：
  - [x] state.json bindings 落盘 + 新 ProxyManager restore 后绑定一致；
  - [x] CLI：stop-all → daemon 重启 → `proxy status` 绑定仍在（懒接线恢复）；
  - [x] `stop-all` 清理全部绑定与实例。

### P5 — pi-web 集成示例 + UI 站点管理（R5）✅ 已交付
- [x] examples/pi-web-integration.ts：`ensureSites()` 预置 site `pi-web`（自身，
      portal + domain `web.pi.example.com`）+ site `services`（子进程，basic +
      domain `dev.pi.example.com`）；`exposeSelf`（site pi-web）/ `exposeService`
      （site services）分别走 `--mode proxy|both`；
- [x] `ui.ts`：站点管理页 `/sites`（列表/增删/运行态/地址/每 site 用户入口）；
      `/sites/<name>/users`（每 site 独立用户增删改密）；快速暴露表单加
      `mode`/`site` 选择（tunnel/proxy/both × 站点）。
- **验收（UI 冒烟）**：
  - [x] /sites 列表 + 添加/删除站点、每 site 用户增删改密（独立用户库）；
  - [x] expose 表单 mode/site 生效；
  - [x] pi-web 场景：`5173-services.st.localhost`（子进程）与
    `5173-pi-web.st.localhost`（自身）走各自 portal / basic。

---

## 8. 风险与取舍

1. **authelia 多实例内存**：每 site 一个 authelia 进程 ≈74MB + Redis（Redis 全局
   共享一个实例，session secret 各自独立）。**建议**：多 site 优先 portal/basic；
   authelia 只用于少量（1-2）高安全站点；文档明示资源预算。
2. **portal 会话**：portal cookie secret 按实例随机、不持久化（现状语义）——site
   重启后旧会话失效，可接受（default site 亦如此）。
3. **basic 本地认证（D2 已定）**：退回 nginx `auth_basic`（per-host htpasswdFile），
   Node 不实现 APR1；代价是 basic site 首次命中时多一个 nginx 进程（~20MB，懒启动，
   全局共享一个 gateway）。
4. **双转发层（Node proxy vs nginx）**：本地走 Node、公网走 nginx 存在逻辑重复；
   终态可收敛为**单转发层**（Node proxy 全接管，nginx 仅保留给 basic/兼容路径），
   列为后续可选项，不阻塞本期。
5. **hostsubfix 语法安全**：未知 site 标签一律 403；`auth` 保留字冲突显式报错；
   端口/site/后缀校验沿用 `#sanitizeHost` 风格白名单（域名 ≤253、无注入字符）。
6. **enrollment 生命周期与安全默认（D4）**：binding 随 daemon/进程存活；停隧道/停
   expose 时清理，防止端口易主后被错误保护或误认证。旧行为（发现缓存全放行）判定
   为安全缺口（缺省暴露调用方进程树内全部端口），**直接移除、无 `--open` 逃生口**
   ——破坏性变更，调用方必须逐端口显式 enroll（pi-web 等集成需同步）；未 enroll
   一律 403。
7. **oauth2-proxy 固定域名**：OIDC 回调按 site 的 domain 预注册；随机隧道域名对其
   不可用（`randomDomain: false`，现状约束）——proxy 模式天然固定 host，反而更适配。
8. **本地 http 认证的 scheme**：forward-auth 探针与 loginRedirect 按请求 scheme 动态
   （本地 http、隧道 https）；portal 天然支持 http；authelia 若校验 X-Original-URL
   拒绝 http 目标，本地模式建议 portal/basic（authelia 留给 tunnel 模式）。

---

## 9. 测试计划（汇总）

| 层 | 用例 |
|---|---|
| 单元 | site 配置解析/校验；hostsubfix 短横线语法（`-auth` 保留字、label 解析、最长后缀、未知 label 403）；enrollment 判定（未 enroll 403）；storageDir 隔离；user/totp site 作用域 |
| 集成 | 默认零转发（无 expose 全 403，含已发现端口）；expose `--mode proxy` × portal per-host（401→登录→200，`{basePath}/*` 可达）；× basic→nginx（auth_basic 401 挑战→200）；open binding（`--mode proxy --auth none`）直连；expose `mode=proxy/both/tunnel` 三态；tcp 约束 |
| 端到端 | CLI：`site add` → `expose --site X --mode both` → 双入口登录；daemon 重启恢复；`stop-all` 清理 |
| 回归 | 现有 `test/*.test.mjs` 全绿（default site 行为不变） |

---

## 10. 附：pi-web 落地示例（R5 验收场景）

```
site add pi-web --provider portal --domain web.pi.example.com --policy two_factor
site add services --provider basic --domain dev.pi.example.com

# pi-web 自身（管理界面）→ site pi-web
expose 3000 --site pi-web --mode both --auth auto --tunnel cloudflared
  → https://web.pi.example.com            （或随机 trycloudflare 域名）
  → http://3000-pi-web.st.localhost       （本地直连，同一套 portal 用户）

# pi-web 子进程测试服务 → site services（独立用户库）
expose 5173 --site services --mode proxy --auth auto
  → http://5173-services.st.localhost     （basic 登录，services 独立 htpasswd）
expose 5173 --site services --mode both --auth auto --tunnel ngrok
  → http://5173-services.st.localhost     （本地，认证）
  → <随机>.ngrok-free.app                 （公网，同一批 services 用户）
```

pi-web 自身（site pi-web）与子进程（site services）**不同域名、不同用户库、不同
provider**，互不共享任何配置；`5173.st.localhost`（无 label）仍为开放直连，与现状
完全一致。
