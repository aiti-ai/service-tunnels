# AuthProvider 接口 — 编写认证 Provider 指南

`AuthProvider` 是 service-tunnels 认证编排的可插拔点（`src/auth-provider.ts`）。
接线层（expose / proxy-manager / gateway）**不再按 provider type 分支**——所有
协议差异都由 provider **自描述**（gatewayMode / loginRedirect / defaultBasePath /
authzPath / providerPaths / setupConfig 等字段）。加一个新 provider =
**1 个类文件 + 1 行注册**，接线层一行不用改。

## 1. 架构模型：本地网关认证

```
公网隧道（纯透传）→ 本地 nginx 网关 / Node proxy → 认证判定（100% 本地）→ 应用端口
```

- 所有隧道工具（ngrok/cloudflared/bore/…）只是"公网 URL → 本地网关"的透传，
  与认证无关；
- 认证在本地端口侧完成：nginx `auth_request` 探针 provider（forward-auth 模型），
  或 Node proxy 的门禁决策（proxy 模式）；
- provider 只回答一个问题：**"这个请求是否已认证、是否放行"**。

三种**网关模式**（`gatewayMode`）决定认证协议形态：

| gatewayMode | 认证协议 | 内置实现 | 说明 |
|---|---|---|---|
| `"forward-auth"`（缺省） | 探针式：nginx `auth_request → {basePath}/api/authz/auth-request`（authelia/portal 协议），2xx 放行、401/302 重定向登录 | portal、authelia | 最简单；Node proxy 侧同协议探针 |
| `"oauth2-proxy"` | `/oauth2/` 协议：探 `/oauth2/auth`（202 放行）、登录/回调直达侧车 | oauth2-proxy | 自带 OIDC 舞步、回调白名单、域名验证文件 |
| `"basic"` | nginx `auth_basic`（htpasswd） | basic | 无 basePath、无登录页、无探针 |

## 2. 接口总览

### 2.1 必选

```ts
interface AuthProvider {
  readonly type: string;                       // 唯一标识（"portal"/"authelia"/插件自定）
  readonly site?: string;                      // 所属认证域（缺省 "default"）
  readonly capabilities: AuthProviderCapabilities;

  prepare(): Promise<AuthProviderStatus>;      // 生成配置（幂等）
  start(): Promise<AuthProviderStatus>;        // 启动进程/服务（幂等）
  stop(): Promise<void>;
  status(): AuthProviderStatus;                // { running, port? }

  registerHost(host: string, policy?: AuthPolicy): Promise<void>;
  unregisterHost(host: string): Promise<void>;
  listHosts(): Promise<string[]>;
}
```

### 2.2 capabilities

```ts
interface AuthProviderCapabilities {
  localGateway: boolean;   // 本地 nginx auth_request 后端（主线）
  edgeAuth: boolean;       // 隧道边缘认证（ngrok edge-oidc 类，无本地进程）
  randomDomain: boolean;   // 支持随机变化的公网主机（动态注册）
  multiHost: boolean;      // 一个实例服务多个 host
  needsSessionStore: boolean; // 需要会话存储（authelia 要 Redis；oauth2-proxy/basic 不用）
}
```

### 2.3 可选生命周期

| 方法 | 何时用 |
|---|---|
| `validate?()` | 预检（缺二进制 / 缺 OIDC 注册 → 返回问题列表，expose 前拒绝） |
| `renderNginxAuth?()` | 自定义 nginx 片段（主线 provider 一般返回空串，gateway 自己接线） |
| `setBasePath?(path)` | 共享实例补 basePath（registry 缓存实例可能先于 basePath 创建） |
| `renderTunnelAuth?()` | 边缘认证的隧道参数（ngrok traffic policy） |

### 2.4 自描述协议字段（接线层消费，**加 provider 的关键**）

```ts
/** 未认证跳转目标（$host/$request_uri 模板；scheme=本地 http / 隧道 https）。
 *  缺省 = portal 风格 `${basePath}/login?next=$request_uri`。 */
loginRedirect?(basePath: string, scheme: "http" | "https"): string;

/** 网关/门禁模式：forward-auth（缺省）| oauth2-proxy | basic。 */
readonly gatewayMode?: "forward-auth" | "oauth2-proxy" | "basic";
/** 认证探针路径（缺省 {basePath}/api/authz/auth-request；oauth2-proxy → /oauth2/auth）。 */
readonly authzPath?: string;
/** 直达 provider 的路径前缀（oauth2-proxy: ["/oauth2"]——登录/回调不经探针）。 */
readonly providerPaths?: string[];
/** 默认 basePath 命名策略（缺省 "/{type}"；basic → ""）。 */
defaultBasePath?(): string;
/** 登录后展示地址 loginUrl（缺省 `${url}${basePath}/login`；basic 无 → undefined）。 */
loginUrl?(url: string, basePath: string): string | undefined;
/** 免认证直达：域名验证文件 + 预登录设置页（oauth2-proxy 等 IdP 联动）。 */
setupConfig?(): ProviderSetup | undefined;
```

接线层消费关系：

| 字段 | 谁读 | 用于 |
|---|---|---|
| `gatewayMode` | expose（nginx authMode）、proxy-manager（basic 分支） | 选网关模板 / 门禁类型 |
| `loginRedirect` | expose（tunnel）、proxy-manager（proxy） | 未认证 302 目标（**单一真源**，两份拷贝已消除） |
| `authzPath` / `providerPaths` | proxy-manager（fw 构造） | 探针路径 / 直达路径 |
| `defaultBasePath` | expose（basePath 解析） | 默认命名（portal 随机趣味名 / authelia alnum / basic 空） |
| `loginUrl` | expose（结果展示） | 登录页地址 |
| `setupConfig` | expose + proxy-manager + gateway | 域名验证文件 + 设置页 |

### 2.5 ProviderSetup（域名验证 + 设置页）

```ts
interface ProviderSetup {
  /** 域名所有权验证文件：IdP 抓取 http://<host>/<path> 校验内容。免认证直达。 */
  verification: Array<{ path: string; content: string }>;
  /** 预登录设置页路径（如 "/oauth2-setup"）。 */
  infoPath?: string;
  /** 设置页 HTML 模板（nginx $host/$arg_rd 变量形式，双端通用）。 */
  infoHtmlTemplate?: string;
  /** 设置页 HTML 渲染（node proxy 手动替换变量）。 */
  infoHtml?: (host: string, next: string) => string;
}
```

**安全要求**（`validateSetupEntry` 强制）：`path` 仅 `[a-zA-Z0-9._~/-]`、禁 `;{}'"` 空白
换行与 `..`；`content` 单行、无单引号/反斜杠、≤512 字符——这些值会插进 nginx
`location = <path> { return 200 '<content>'; }`，白名单校验防配置注入（实测注入
`'}; }` 会被 nginx 当指令解析）。

### 2.6 可选 UserManager（本地用户库）

```ts
interface UserManager {
  listUsers(): Promise<AuthUser[]>;                       // 无密钥
  addUser(name, password, displayName?, email?): Promise<void>;
  setUserPassword(name, password): Promise<void>;
  removeUser(name): Promise<void>;
}
// 检测：typeof provider.listUsers === "function" → 出现在用户管理列表
```

## 3. 最小实现示例

### 例 A：forward-auth 探针式（最简单，照抄 portal）

```ts
import type { AuthProvider, AuthPolicy, ProviderContext, AuthProviderStatus } from "../auth-provider.ts";

export class MyOidcProvider implements AuthProvider {
  readonly type = "my-oidc";
  readonly capabilities = {
    localGateway: true, edgeAuth: false, randomDomain: true, multiHost: true, needsSessionStore: false,
  };
  #ctx: ProviderContext;
  #port = 0;

  constructor(ctx: ProviderContext) { this.#ctx = ctx; }
  get port() { return this.#port; }

  async prepare() { if (!this.#port) this.#port = await this.#ctx.pickPort(); return this.status(); }
  async start() { /* 启动你的认证服务，监听 127.0.0.1:<port> */ return this.status(); }
  async stop() {}
  status(): AuthProviderStatus { return { running: true, port: this.#port }; }
  async registerHost(_h: string) {} async unregisterHost(_h: string) {} async listHosts() { return []; }

  /** 自描述：探针式 → 什么都不用声明，全走缺省 */
  // loginRedirect / gatewayMode / authzPath / defaultBasePath 全部缺省即可
}
```

缺省行为自动生效：`auth_request → {basePath}/api/authz/auth-request` 探针、portal 风格
登录跳转、`/{type}` 默认 basePath。**注册 1 行**：

```ts
// src/auth-registry.ts
this.#factories.set("my-oidc", (c, o) => new MyOidcProvider(c, (o ?? {}) as MyOidcProviderOptions));
```

### 例 B：oauth2-proxy 风格（需要自描述协议）

```ts
export class MySidecarProvider implements AuthProvider {
  readonly type = "my-sidecar";
  readonly gatewayMode = "oauth2-proxy" as const;      // /oauth2/ 协议
  readonly authzPath = "/oauth2/auth";                 // 探针路径
  readonly providerPaths = ["/oauth2"];                // 登录/回调直达
  readonly capabilities = { localGateway: true, edgeAuth: false, randomDomain: false, multiHost: true, needsSessionStore: false };
  // ...生命周期同例 A...

  loginRedirect(_bp: string, scheme: "http" | "https"): string {
    return `${scheme}://$host/oauth2/start?rd=$request_uri`;
  }
  defaultBasePath(): string { return "/my-sidecar"; }
  loginUrl(url: string): string { return `${url}/oauth2/start`; }
  setupConfig(): ProviderSetup | undefined {
    return {
      verification: [{ path: "/.well-known/verify.txt", content: "xxx" }],
      infoPath: "/oauth2-setup",
      infoHtmlTemplate: `<p>回调：http://$host/oauth2/callback</p><a href="/oauth2/start?rd=$arg_rd">继续登录</a>`,
    };
  }
}
```

Node proxy 与 nginx 网关自动获得：`/oauth2/auth` 探针、`/oauth2/*` 直达、验证文件
免认证、设置页、登录跳转——**接线层零改动**。

## 4. 注册方式

| 方式 | 位置 | 说明 |
|---|---|---|
| 内置 | `auth-registry.ts` `#factories.set(type, factory)` | 随包发布 |
| **oauth2 变体** | `oauth2-variants.ts` `OAUTH2_VARIANTS` 表加一条声明，或环境变量 `SERVICE_TUNNELS_OAUTH2_VARIANT_<NAME>` 注册 | 基于 oauth2-proxy 的变体 provider（`--auth oauth2-github` 等）；**零类代码**——工厂/表单/页面/元数据全自动注册，见 [oauth2-variants.md](oauth2-variants.md) |
| 插件目录 | `configDir/providers/*.js/.mjs`（ESM，`default` 或 `factory` 导出） | 用户侧零编译 |
| 构造注入 | `createServiceTunnels({ authPlugins: [factory] })` | 库模式 |
| 运行时 | `st.auth.registerProvider?.(factory)`（registry.register，幂等） | 动态注册 |

工厂签名：`(ctx: ProviderContext, opts?: Record<string, unknown>) => AuthProvider`。
`opts` 由 expose 注入：`site` / `storageDir` / `basePath` / `policy` / `user` /
`sessionSecret` + providerParams（点号键自动嵌套）。

## 5. 参数 Schema（表单/CLI 校验）

- **认证参数**：`auth-registry.ts` `PARAM_SCHEMAS[type]`（`{ key, type, label, required, description }`）；
- **隧道参数**：`tunnels.ts` `TUNNEL_PARAM_SCHEMAS[type]`；
- 不注册 schema 也能用（库 API 直接传对象），只影响 CLI `--provider-set` 与 UI 表单。

## 6. 需要二进制时

在 `src/tools.ts` 注册工具定义（官方源 + Gitee/ghproxy 镜像 + 校验命令），
provider 用 `ctx.resolveTool(name)` 解析（PATH > 缓存 > 自动下载）：
`name / version / platforms / download{official, mirrors, kind, binPath} / verifyArgs`。

## 7. 平台差异

| provider | Windows | 说明 |
|---|---|---|
| authelia | ✗（无官方二进制） | 自动回退 portal；WSL2/Docker 可用 |
| portal / basic / oauth2-proxy | ✓ | Node 实现或跨平台二进制 |

## 8. 测试建议

1. **单元**：`validate()` 缺配置报错、`defaultBasePath()` 命名、`loginRedirect()` 模板、
   `setupConfig()` 注入校验（`validateSetupEntry` 拦截非法 path/content）；
2. **集成**：复用 `scripts/mock-idp.mjs`（最小 OIDC IdP，RS256 + 回调白名单 + 域名
   验证抓取）+ `scripts/test-oauth2-proxy.mjs` / `scripts/test-oauth2-gateway.mjs`
   （Node proxy 链 + nginx 网关链，含设置页/验证文件/完整登录）；
3. **浏览器**：`scripts/browser-serve.mjs` + Chrome DevTools 实测真实 cookie/重定向。

## 9. 检查清单（加一个新 provider）

- [ ] 类实现 `AuthProvider`（生命周期 + capabilities）
- [ ] 按需声明自描述字段：`gatewayMode` / `authzPath` / `providerPaths` /
      `loginRedirect` / `defaultBasePath` / `loginUrl` / `setupConfig`
- [ ] `validate()` 预检缺配置/缺二进制
- [ ] 注册工厂（内置或插件）
- [ ] 需要用户库 → 实现 `UserManager`
- [ ] 需要表单 → 注册参数 schema
- [ ] 需要二进制 → `tools.ts` 定义 + 镜像
- [ ] setupConfig 的 verification 条目过 `validateSetupEntry`（防 nginx 注入）
- [ ] 复用 mock IdP + 回归脚本测试双路径（Node proxy + nginx 网关）

> 基于 oauth2-proxy 的变体（`--auth oauth2-<name>`）不走上面的类实现——在
> `oauth2-variants.ts` 变体表加一条声明即可（label/provider/固定端点/scope/
> 表单/凭据映射），工厂注册、表单生成、页面元数据全部数据驱动。
