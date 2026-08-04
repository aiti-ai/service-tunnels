# service-tunnels

服务端口发现 + 泛域名反向代理 + 隧道管理（ngrok/frpc/ssh/cloudflared/localtunnel）+ 可插拔认证编排（nginx + Authelia + Redis）。**npm 包 + CLI**，零运行时依赖。

> 架构原则：**认证统一在本地端口侧（nginx 网关）**，所有隧道都是纯透传通道——与隧道工具无关、随机/固定域名统一走动态登记。Authelia 是内置默认 provider，接口可插拔（oauth2-proxy / ngrok edge-oidc / 自研）。

## 快速开始

```bash
npm install -g service-tunnels

service-tunnels daemon start          # 常驻守护（持有隧道/网关进程）
service-tunnels discover              # 发现调用方进程树中的服务端口
service-tunnels tunnel add web --type ngrok --target 4180
service-tunnels tunnel start web      # 启动隧道 → URL 自动解析
service-tunnels expose 5173           # 一键暴露（默认 ngrok，无认证）
service-tunnels expose 5173 --auth    # 一键暴露 + nginx/Authelia/Redis 认证
service-tunnels stop-all              # 停止守护 + 清理全部子进程
```

## 库使用

```ts
import { createServiceTunnels } from "service-tunnels";

const st = createServiceTunnels({
  configDir: "~/.config/service-tunnels", // 固定配置（0600）
  cacheDir: "~/.cache/service-tunnels",   // 下载 + 临时产物 + 状态
  marker: "service-tunnels",              // 子进程环境标记
  // toolPaths: { ngrok: "/opt/ngrok" },   // 显式指定工具路径
  // preferMirrors: true,                  // 中国网络：镜像优先
});

const ports = st.discovery.getPorts();          // 发现服务端口（排除框架内部端口）
await st.tunnels.start("web");                   // 隧道（工具自动解析/下载）
await st.auth.expose(5173, { auth: true });      // 一键暴露 + 认证
```

## 工具解析（所有命令统一）

```
1. toolPaths.<name>（调用方显式指定）
2. 系统 PATH 已有（直接用，不下载）
3. cacheDir/bin（已下载缓存）
4. 自动下载：官方源 → 中国镜像（ghproxy / npmmirror）回退
```

## 命令

```
daemon start [--foreground] | stop | status | logs
discover [--pid <pid>] [--json] [--refresh]
internal list [--json]                  # 框架辅助端口（nginx/authelia/redis）
tools list | resolve <n> | download <n> | path <n>
proxy start [--port] [--suffix] [--base-path] [--password]
tunnel list | add | start | stop | remove
expose <port> [--tunnel <t>] [--auth [<provider>]] [--name <n>]
auth provider list | register <host> | unregister <host>
gateway start|stop|status
status [--json]
stop-all
config path | show
```

## 设计文档

- [`docs/design.md`](docs/design.md) — 架构 / 模块 / 认证 provider 模型 / 平台矩阵 / 里程碑
- [`docs/api.md`](docs/api.md) — 库 API
- [`docs/cli.md`](docs/cli.md) — CLI 参考
- [`docs/config.md`](docs/config.md) — 配置与目录规范

## 安全模型

- 代理/隧道目标只允许 127.0.0.1；代理端口必须命中发现缓存（进程树白名单）
- 后缀即主机白名单（防 DNS rebinding）；可选 Basic 密码门
- 密钥只存 `~/.config/service-tunnels`（0600），state.json 不含 secret
- 框架辅助进程带 `SERVICE_TUNNELS_ROLE` 标记：发现时排除、daemon 退出时清理
- 隧道工具（尤其 frpc）可能被安全软件标记为 HackTool/RiskWare——属工具自身问题，见 design.md §8.1

## License

MIT
