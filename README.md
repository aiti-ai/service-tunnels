# service-tunnels

服务端口发现 + 泛域名反向代理 + 隧道管理（ngrok/frpc/ssh/serveo/cloudflared/localtunnel/bore）+ 可插拔认证编排（nginx + Authelia + Redis + portal）。**npm 包 + CLI**，零运行时依赖。

> 架构原则：**认证统一在本地端口侧**（nginx 网关 / 内置 proxy），所有隧道都是纯透传通道——与隧道工具无关。**Site（认证域）**：每个站点一套独立的 provider 实例 + 用户库（`st.sites` / `site` 子命令），互不共享配置和用户。暴露方式自由组合：`--mode tunnel|proxy|both` × `--auth none|auto|<provider>`（详见 [sites-design.md](docs/sites-design.md)）。

## 快速开始

```bash
npm install -g service-tunnels

service-tunnels daemon start          # 常驻守护（持有隧道/网关进程）
service-tunnels discover              # 发现调用方进程树中的服务端口
service-tunnels tunnel add web --type ngrok --target 4180
service-tunnels tunnel add loc --type bore --target 4180     # 自建 bore server（本机/局域网），零账号
service-tunnels tunnel add ssh1 --type ssh --target 4180 --host localhost --user wind --remote-port 8080  # ssh -R 到本机
service-tunnels tunnel start web      # 启动隧道 → URL 自动解析

# 暴露 = 三种模式 × 认证可选（D4：proxy 默认零转发，必须显式 enrollment）
service-tunnels expose 5173 --mode tunnel --auth auto     # 公网隧道 + 认证（默认）
service-tunnels expose 5173 --mode proxy --auth portal   # 本地虚拟主机（无隧道）→ http://5173-portal.st.localhost:4180
service-tunnels expose 5173 --mode both --auth auto      # 本地 + 公网，同一 site 同一批用户
service-tunnels expose 5173 --mode proxy --auth none     # 本地开放（显式 enrollment，可选 --password）

# 站点（认证域）：pi-web 自身 vs 子进程各自独立用户库
service-tunnels site add pi-web --provider portal --domain web.pi.example.com
service-tunnels site add services --provider basic
service-tunnels expose 5173 --mode proxy --auth auto --site services   # 子进程 → http://5173-services.st.localhost:4180

service-tunnels auth user list | add | set-password | remove [--site <s>]   # 用户管理（按站点）
service-tunnels auth totp enroll|disable|status <user> [--site <s>]         # 2FA 管理
service-tunnels ui                    # 网页管理界面（127.0.0.1，自动弹浏览器；含站点管理页）
service-tunnels stop-all              # 停止守护 + 清理全部子进程
```

**虚拟主机语法**（本地/域名直达，`st.localhost` 默认后缀 + baseDomain + site.domain）：

```
5173.st.localhost              → 开放直连（需 open binding）
5173-auth.st.localhost         → 默认站点认证
5173-portal.st.localhost       → portal provider 站点
5173-pi-web.st.localhost       → 站点 pi-web
5173.web.pi.example.com        → 站点 pi-web 的域名（隐含 site）
```

**baseDomain**（用户自有泛解析域名，隐藏本地端口）：

```bash
service-tunnels config set base-domain pi.example.com   # DNS *.<域> → 本机 + nginx 反代到 proxy 端口
service-tunnels config set proxy-port 4180
service-tunnels expose 5173 --mode proxy --auth portal
  # → localUrl: http://5173-portal.st.localhost:4180   （默认兜底，带端口）
  # → baseUrl:  http://5173-portal.pi.example.com      （无端口）
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
await st.auth.expose(5173, { auth: true });      // 一键暴露 + 认证（tunnel）

// 站点隔离（认证域）
st.sites.add("pi-web", { provider: "portal", domain: "web.pi.example.com" });
st.sites.add("services", { provider: "basic" });
await st.auth.addUser("alice", "pw", { site: "services" });       // 子进程用户
await st.auth.expose(5173, { mode: "proxy", site: "services" });  // → http://5173-services.st.localhost:4180
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
internal list [--json]                  # 框架辅助端口（nginx/authelia/redis/proxy）
tools list | resolve <n> | download <n> | path <n>
proxy start|stop|status [--port] [--suffix] [--base-path] [--password] [--foreground]  # 仅传输层管理
tunnel list | add | start | stop | remove
site list | show <name> | add <name> [--provider <p>] [--auth true|false] [--base-path <p>] [--policy <p>] [--domain <d>] | remove <name>
expose <port> [--mode tunnel|proxy|both] [--site <s>] [--tunnel <t>] [--proxy-port <p>] [--base-domain <d>] [--auth [auto|none|<provider>]] [--name <n>]
auth provider list | register <host> | unregister <host>
auth user list | add | set-password | remove [--site <s>] [--provider ...]   # 用户管理（按站点）
auth totp enroll | disable | status <user> [--site <s>] [--provider ...]     # 2FA 管理
ui [--port <p>] [--no-browser]          # 网页管理界面（127.0.0.1，自动弹浏览器）
gateway start|stop|status
status [--json]
stop-all
config path | show | get <key> | set <key> <value>   # base-domain / proxy-port / base-path / ...
```

## 设计文档

- [`docs/sites-design.md`](docs/sites-design.md) — **站点（认证域）隔离 + proxy 暴露模式**（本版本核心：site / enrollment / hostsubfix / baseDomain / P0–P5）
- [`docs/design.md`](docs/design.md) — 架构 / 模块 / 认证 provider 模型 / 平台矩阵 / 里程碑
- [`docs/api.md`](docs/api.md) — 库 API
- [`docs/cli.md`](docs/cli.md) — CLI 参考
- [`docs/config.md`](docs/config.md) — 配置与目录规范

## 安全模型

- **D4 零转发**：proxy 默认不转发任何端口——虚拟主机必须显式 enrollment（`expose --mode proxy/both`）后才可达，未 enroll 一律 403（not enrolled）；旧"发现缓存全放行"行为已移除
- 代理/隧道目标只允许 127.0.0.1；未知站点 label → 403；后缀即主机白名单（防 DNS rebinding）
- 每 site 独立用户库/密钥（`cacheDir/tmp/sites/<site>/...`）；state.json 不含 secret
- 框架辅助进程带 `SERVICE_TUNNELS_ROLE` 标记：发现时排除、daemon 退出时清理
- 隧道工具（尤其 frpc）可能被安全软件标记为 HackTool/RiskWare——属工具自身问题，见 design.md §8.1

## License

MIT
