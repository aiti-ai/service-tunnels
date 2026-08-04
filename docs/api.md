# service-tunnels 库 API — 参考

入口工厂：`createServiceTunnels(options)`，**调用方必须/可以指定 config 与
cache 目录**，默认回退 XDG 位置。包同时导出纯函数（`discoverPorts`、
`stripBasePath`、`extractTunnelUrl` 等），方便在不需要完整状态机时直接调用。

## 工厂

```ts
import { createServiceTunnels, type Options } from "service-tunnels";

const st = createServiceTunnels({
  configDir: "~/.config/service-tunnels",  // 固定配置（可指定，如 pi-web 传自己的目录）
  cacheDir: "~/.cache/service-tunnels",    // 下载 + 临时产物
  marker: "service-tunnels",               // 子进程环境标记前缀（默认）
  logLevel: "info",                        // debug 可见隧道原始输出
  authPlugins: [myAuthentikProvider],      // 可选：注入自定义认证 provider
  // 库模式默认进程内常驻（无需 daemon）。若调用方想接管 daemon 控制：
  // connectDaemon: "~/.cache/service-tunnels"  // 连接到既有 daemon（替代进程内）
});

await st.init();      // 建目录、读配置、恢复 state.json 中的存活进程
await st.shutdown();  // 清理全部子进程（进程退出时也会自动清理）
```

## 命名空间

### st.proxy（泛域名反代）

```ts
create(opts?: {
  port?: number;              // 监听端口（默认 4180，0=随机）
  suffixes?: string[];        // 虚拟主机后缀（默认 [".pi.localhost"]）
  allowedHosts?: string[];    // 公网部署域名（<port>.<域名> 同样接受）
  basePath?: string;          // 转发前剥离（/dev/foo → /foo）
  password?: string;          // Basic 密码门（空=关）
  rootPid?: number;           // 发现根 pid（CLI 场景指定用户 shell/pi 进程）
  refresh?: boolean;          // 每次白名单检查强制重扫（绕过 TTL）
}): http.Server
parseHost(host): ServiceHostMatch | null   // "<port>.<suffix>" → { port, suffix }
```
白名单 = 发现缓存：未发现的端口 403；SSE/流式天然支持（管道无缓冲）；
WebSocket upgrade 转发（101 + 数据帧）；Host 保留（应用生成绝对 URL 用虚拟主机名）。

### st.tunnels（隧道管理，daemon 持有）

```ts
configs(): TunnelConfig[]                       // configDir/tunnels.json 声明式配置
saveConfigs(cfgs): void
add(cfg: { name, type, target?, domain?, args?, cmd?, host?, server?, token? }): void
remove(name): void
list(): TunnelInfo[]                            // { name, type, running, pid, url, lastOutput }
get(name): TunnelInfo | undefined
start(name): Promise<TunnelInfo>                // 工具解析 → spawn(角色标记) → 输出缓冲 → URL
stop(name): Promise<void>                       // 进程组 SIGTERM → 等待 → SIGKILL 兜底
stopAll(): Promise<void>
hydrate(): void                                 // 重启后从 state.json 恢复 URL
```
- 隧道是纯透传（认证在 nginx 网关，与隧道解耦，design.md §5）；
- CLI 模式隧道进程由 daemon 持有（跨 CLI 调用可见/可控），state.json 镜像
  pid/url；`extractTunnelUrl` 已知域名（ngrok/trycloudflare/loca.lt/serveo.net/
  wormhole.app/localhost.run/hop.to）+ 非 localhost 兜底。

### st.auth（认证编排 + 插件 + 用户管理）

用户管理是 **provider 能力**（`UserManager` 接口）：任何维护本地用户库的
provider 都支持（authelia `users_database.yml`、basic `htpasswd`、portal
`users.json`、插件可实现同一接口）。`provider` 参数支持 `"all"`（默认，所有支持用户管理的 provider）、
单个类型或数组。

```ts
userManagers(): string[]                     // 支持用户管理的 provider 类型
users(provider?: string): Promise<{provider, users: AuthUser[]}[]>
  // provider="all"（默认）→ 每个支持用户管理的 provider 各一条
addUser(name, password, { provider?, displayName? }): Promise<string[]>
  // 返回写入的 providers；provider 缺省 = all
setUserPassword(name, password, provider?): Promise<string[]>
removeUser(name, provider?): Promise<string[]>
```
- 持久化：authelia → `cacheDir/tmp/authelia/users_database.yml`（argon2）；
  basic → `cacheDir/tmp/basic/htpasswd`（APR1，nginx auth_basic 兼容）；
  portal → `cacheDir/tmp/portal/users.json`（scrypt）；
- 仅当 provider 运行中才 validate+重启，未运行时文件写入下次启动生效；
- CLI：`auth user list|add|set-password|remove <name> [--provider basic|authelia|all] [--password] [--display-name]`
  （未给 --password 时自动生成并在返回中输出一次；返回含 providers 列表）；
- 初始用户：expose --auth 首次初始化时创建（`auth.user` 配置或 admin+随机密码）；
- 密码永不落明文/日志（hash + API 剥离 secret）。

### st.auth（认证编排 + 插件）

```ts
providers(): string[]                          // ["authelia","basic","oauth2-proxy", ...插件]
registerProvider(factory: AuthProviderFactory) // 注入自定义 provider（type 去重）
```
- 内置：authelia（默认）、basic（nginx auth_basic，APR1）、oauth2-proxy（OIDC 侧车）；
- 插件：configDir/providers/*.js（ESM 导出 factory）+ authPlugins 构造参数；
- 边缘型扩展点：`renderTunnelAuth()`（ngrok edge-oidc 预留）——edgeAuth 且非
  localGateway 时跳过本地网关，隧道带认证参数直连应用。

```ts
providers(): string[]                                   // 内置/插件 provider 列表
expose(port: number, opts?: {
  auth?: boolean;              // 走网关认证（默认 false 直连）
  provider?: string;           // 默认 "authelia"
  tunnelType?: string;         // 默认 ngrok
  tunnelName?: string;
  policy?: "one_factor"|"two_factor"|"deny";
  nginxPort?: number;          // 0=随机（默认随机）
  autheliaPort?: number;       // 0=随机
  redisPort?: number;          // 0=随机
  user?: { name, password };
}): Promise<{ url, tunnel, provider, gateway: { nginx, authelia, redis } }>
```
一键流程（design.md §4.7）：provider validate → Redis（needsSessionStore 时）→
authelia 绿色启动（配置生成/argon2/validate/spawn）→ nginx 网关（随机端口 +
默认 444 server + 热重载）→ 隧道指向网关端口 → 等公网 URL → **gateway.registerHost
+ authelia.registerHost（动态登记 + 重启）**。所有组件端口随机且内部互知。

### st.discovery

```ts
discoverPorts(opts?: { rootPid?: number; force?: boolean }): Promise<ServicePort[]>
isPortOwned(port: number): Promise<boolean>          // 端口在发现缓存中？
```
`ServicePort = { port, pid, process, cmdline, addresses: string[] }`。
**结果已排除框架辅助进程端口**（角色标记 + internal 注册表过滤）。

### st.internal（框架辅助端口）

```ts
list(): Promise<InternalPort[]>     // [{ role: "nginx"|"authelia"|"redis"|..., pid, port, addresses }]
onRole(role, cb): () => void        // 辅助进程端口变化事件
```
框架自启的 nginx/authelia/redis 端口只出现在这里，**不进入 discoverPorts()**；
调用方可据此展示/健康检查，但不能把它们当用户服务代理。

### st.proxy（内置泛域名反代）

```ts
start(opts: { port?: number; suffixes?: string[]; basePath?: string;
              password?: string; enableWebSocket?: boolean }): Promise<void>
stop(): Promise<void>
status(): { running: boolean; port?: number }
```

### st.tunnels

```ts
list(): Promise<TunnelInfo[]>            // { name, type, running, pid, url, auth }
add(cfg: TunnelConfig): Promise<void>    // { name, type, target, args?, auth? }
remove(name: string): Promise<void>
start(name: string): Promise<TunnelInfo> // 幂等；返回含解析出的 url
stop(name: string): Promise<void>
```
`TunnelConfig.auth`：认证与隧道解耦——隧道配置只声明 `target`（nginx 网关端口），
认证由 `expose --auth` / `st.auth` 统一在网关侧完成（`"none"` 表示该隧道无认证）。

### st.gateway（nginx + Authelia + Redis 组合）

```ts
start(opts?: { nginxPort?: number; autheliaPort?: number }): Promise<void>
stop(): Promise<void>
reload(): Promise<void>          // nginx -s reload（新 server 块后）
status(): Promise<GatewayStatus>
```

### st.auth（provider 化）

```ts
// provider 注册表
providers: {
  list(): AuthProviderInfo[];                       // { type, capabilities, running }
  register(factory: AuthProviderFactory): void;     // 注入插件（npm 包/自研）
  unregister(type: string): void;
}
setDefault(type: string): Promise<void>;            // 全局默认 provider

// 当前 provider 的域名登记（动态登记）
register(host: string, policy?: AuthPolicy): Promise<void>
unregister(host: string): Promise<void>
list(): Promise<{ host: string; policy: string }[]>
```

### st.expose（一键公网暴露）

```ts
expose(opts: { port: number; tunnel?: TunnelType; auth?: boolean;
               name?: string; domain?: string }): Promise<{ url: string; host: string }>
stopExpose(port: number | string): Promise<void>
listExposes(): Promise<ExposeInfo[]>
```

### 事件

```ts
st.on("tunnel:start" | "tunnel:url" | "tunnel:stop" | "nginx:reload" |
     "authelia:restart" | "auth:register", (e) => {});
```

## 纯函数导出

```ts
import { discoverPorts, isPortAllowed, stripBasePath,
         extractTunnelUrl, expandListeningAddresses,
         decodeIpv4, decodeIpv6, parseLsofAddress, parseNetstatAddress } from "service-tunnels";
```

- `discoverPorts(rootPid?)` — 无需实例，直接扫描（不写缓存）。
- `stripBasePath(pathname, basePath)` — `/dev/foo → /foo`。
- `extractTunnelUrl(output)` — 已知隧道域名优先，否则首个非 localhost URL。
- 解码函数供测试/调试（pi-web 已有对应单测可移植）。

## 错误与语义

- 端口不在发现缓存：`Error("port not in discovery allow-list")`。
- 隧道已运行：`start` 幂等返回现状。
- 认证未配置而 `--auth`：自动绿色拉起；失败抛错并回滚（不残留进程）。
- 所有 spawn 子进程登记在 state.json + 内存，`shutdown()`/进程退出全部清理。
