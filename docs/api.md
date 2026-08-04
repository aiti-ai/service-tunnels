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
