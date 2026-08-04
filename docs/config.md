# service-tunnels 配置与目录规范

## 目录（XDG 兼容，可用参数/环境变量覆盖）

| 目录 | 内容 | 性质 |
|---|---|---|
| `~/.config/service-tunnels/` | `config.json`、`tunnels.json`、`users.yml`、密钥 | **固定配置**，用户可编辑，权限 0600 |
| `~/.cache/service-tunnels/` | `bin/`（下载的 authelia/nginx）、`tmp/`（生成配置、日志）、`data/`（sqlite、redis AOF、通知文件）、`state.json` | **下载 + 临时产物**，可删除重建（删 `data/` 会丢会话/用户数据，删 `bin/` 需重新下载） |

覆盖优先级：构造参数 `{ configDir, cacheDir }` > 环境变量
`SERVICE_TUNNELS_CONFIG` / `SERVICE_TUNNELS_CACHE` > XDG 默认。

## config.json（固定配置）

```jsonc
{
  "suffixes": [".pi.localhost"],          // 泛域名代理后缀；可加 ".pi.lan"
  "allowedHosts": [],                      // 公网部署域名（proxy 反代同样接受 <port>.<域名>）
  "basePath": "",                          // 部署在子路径时剥离（如 /dev）
  "password": "",                          // proxy 模式的 Basic 密码（空=关闭）
  "proxyPort": 4180,                       // proxy 默认监听端口
  "defaultTunnel": "ngrok",                // expose 默认隧道类型
  // —— 工具解析与下载 ——
  "toolPaths": { "ngrok": "/opt/ngrok" },  // 显式指定（最高优先级，跳过 PATH/下载）
  "toolMirrors": {                          // 中国镜像覆盖（按工具；default 全量）
    "default": ["https://mirror.ghproxy.com/{official}"],
    "ngrok": ["https://cdn.my-mirror.com/ngrok/{official}"]
  },
  "preferMirrors": false,                  // true=先镜像后官方（CN 网络）
  "auth": {
    "enabled": false,                      // 是否启用认证
    "provider": "authelia",                // 默认 provider：authelia|oauth2-proxy|ngrok-edge-oidc|basic|插件名
    "nginxPort": 4180,                     // nginx 网关端口（本地型 provider）
    // —— authelia provider 专用 ——
    "autheliaPort": 9091,                  // Authelia 监听端口（随机端口时留 0）
    "sessionSecret": "",                   // 会话加密密钥（自动生成后写入）
    "reloadCmd": "",                       // 外部 Authelia 重启命令（可选，空=自管进程）
    "cookieDomains": [],                   // 已登记的固定 cookie domain（动态文件同步）
    "policy": "two_factor",                // 默认授权策略
    "user": { "name": "admin", "password": "" }  // 初始用户（首次启动生成）
    // —— oauth2-proxy provider 专用 ——
    // "oidc": { "issuerUrl": "...", "clientId": "...", "clientSecret": "...", "cookieSecret": "" }
  },
  "redis": {
    "autoInstall": false,                  // 允许包管理器安装 redis-server（sudo/brew）
    "port": 0                              // 0=随机
  }
}
```

## tunnels.json（隧道清单）

```jsonc
[
  { "name": "web",  "type": "ngrok", "target": 5173,
    "auth": { "type": "edge-oidc", "issuerUrl": "https://auth.example.com",
              "clientId": "...", "clientSecret": "..." } },
  { "name": "api",  "type": "frpc", "target": 8080,
    "args": { "serverAddr": "frp.example.com:7000", "token": "...",
              "customDomains": "api.example.com" } },
  { "name": "ssh1", "type": "ssh", "target": 3000,
    "args": { "host": "serveo.net" } },
  { "name": "cf1",  "type": "cloudflared", "target": 4180,
    "args": { "namedTunnel": "my-tunnel", "ingresses": ["app1.example.com", "app2.example.com"] } }
]
```

## 生成物（cache/tmp，运行时由本包管理）

- `tmp/nginx-<name>.conf` —— 每暴露组一份 nginx 配置（多域名 server 块 +
  auth_request + `/authelia/` 反代）；`nginx -t` 通过后 `-s reload`。
- `tmp/authelia/configuration.yml` —— 主配置（server.address 随机端口 +
  `/authelia` base path、SQLite、filesystem notifier、file 用户库、NTP 禁用）。
- `tmp/authelia/config-tunnels.yml` —— **动态文件**：`session.cookies`（枚举
  已登记域名）+ `access_control`（`domain_regex` 一条覆盖一类域名）。
  主配置不写这两个 section（跨文件不 merge，后加载整体覆盖）。
- `tmp/ngrok/policy-<name>.yml` —— edge-oidc 的 Traffic Policy。
- `tmp/frpc/frpc-<name>.ini`、`tmp/ssh-<name>.cmd` —— 隧道进程参数文件。
- `tmp/*.log` —— 隧道/网关进程输出（滚动截断）。

## 运行时状态（cache/state.json）

```jsonc
{
  "daemon": { "pid": 1111, "ipc": "unix://~/.cache/service-tunnels/daemon.sock" },
  "internal": [ { "role": "nginx", "pid": 2345, "port": 4180 },
                { "role": "authelia", "pid": 3456, "port": 9091 },
                { "role": "redis", "pid": 4567, "port": 63799 } ],
  "tunnels": { "web": { "pid": 1234, "url": "https://x.ngrok-free.app" } },
  "auth": { "registered": ["alice.ngrok-free.app"] }
}
```

- `daemon`：CLI 模式常驻进程的 pid 与 IPC 地址（其他命令据此连接）；
- `internal`：框架辅助端口注册表——`discover` 按它过滤，`internal list` 输出它；
- 进程退出时清理；`stop-all` 等价；
- **脱敏**：不存任何 secret（密钥只在 config.json，0600）。

## 工具解析优先级（所有命令统一）

```
1. toolPaths.<name>           （调用方/配置显式指定）
2. 系统 PATH 已有              （直接用，不下载）
3. cacheDir/bin/<name>        （已下载缓存）
4. 自动下载到 cacheDir/bin    （官方源 → 中国镜像逐个回退）
```

- **下载源**：官方优先；GitHub-release 工具（frpc/cloudflared/authelia）带
  ghproxy 镜像（`mirror.ghproxy.com` / `gh-proxy.com` / `github.moeyy.xyz`）；
  npm 工具（localtunnel）用 npmmirror；ngrok 的下载在 equinox.io（无 GitHub
  镜像），可经 `toolMirrors.ngrok` 配自建镜像。
- 下载后 `--version` 校验 + 原子落盘；`tools list` 查看各工具解析状态与来源。

## 目录覆盖示例（库调用）

```ts
// pi-web 想放到自己的目录下（与 pi-web 实例隔离）
const st = createServiceTunnels({
  configDir: path.join(process.env.HOME, ".pi", "service-tunnels"),
  cacheDir: path.join(process.env.HOME, ".pi", "service-tunnels-cache"),
});
```
