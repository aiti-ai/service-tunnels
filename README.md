# service-tunnels

服务端口发现 + 泛域名反向代理 + 隧道管理（ngrok/frpc/ssh/serveo/cloudflared/localtunnel/bore/natapp/command）+ 可插拔认证编排（nginx + Authelia + Redis + portal）。**npm 包 + CLI**，零运行时依赖。

> 架构原则：**认证统一在本地端口侧**（nginx 网关 / 内置 proxy），所有隧道都是纯透传通道——与隧道工具无关。**Site（认证域）**：每个站点一套独立的 provider 实例 + 用户库（`st.sites` / `site` 子命令），互不共享配置和用户。暴露方式自由组合：`--mode tunnel|proxy|both` × `--auth none|auto|<provider>`（详见 [sites-design.md](docs/sites-design.md)）。

## 快速开始

```bash
npm install -g service-tunnels

service-tunnels daemon start          # 常驻守护（持有隧道/网关进程）
service-tunnels discover              # 发现调用方进程树中的服务端口
service-tunnels tunnel add web --type ngrok --target 4180
service-tunnels tunnel add loc --type bore --target 4180     # 自建 bore server（本机/局域网），零账号
service-tunnels tunnel add nat --type natapp --target 4180 --token <authtoken>  # 中国国内内网穿透（natapp.cn，CN 网络友好）
service-tunnels tunnel add ssh1 --type ssh --target 4180 --host localhost --user wind --remote-port 8080  # ssh -R 到本机
service-tunnels tunnel start web      # 启动隧道 → URL 自动解析

# 暴露 = 三种模式 × 认证可选（D4：proxy 默认零转发，必须显式 enrollment）
service-tunnels expose 5173 --mode tunnel --auth auto     # 公网隧道 + 认证（默认）
service-tunnels expose 5173 --mode proxy --auth portal   # 本地虚拟主机（无隧道）→ http://5173-portal.st.localhost:4180
service-tunnels expose 5173 --mode both --auth auto      # 本地 + 公网，同一 site 同一批用户
service-tunnels expose 5173 --mode proxy --auth none     # 本地开放（显式 enrollment，可选 --password）
service-tunnels expose 5173 --auth authelia --bypass-path /health --bypass-path /metrics  # 白名单免认证（健康检查/指标）

# 站点（认证域）：宿主自身 vs 子进程各自独立用户库
service-tunnels site add host --provider portal --domain web.example.com
service-tunnels site add services --provider basic
service-tunnels expose 5173 --mode proxy --auth auto --site services   # 子进程 → http://5173-services.st.localhost:4180

service-tunnels auth user list | add | set-password | remove [--site <s>]   # 用户管理（按站点）
service-tunnels auth totp enroll|disable|status <user> [--site <s>]         # 2FA 管理
service-tunnels auth token list | create [--description <d>] [--expires <ISO|+2h|never>] | revoke <id> [--site <s>]  # Bearer token（tunnel API 请求）
curl -H "Authorization: Bearer st_xxx..." https://<tunnel-url>/api/...   # 机器客户端只传 header 即可
service-tunnels ui                    # 网页管理界面（127.0.0.1，自动弹浏览器；含站点管理页）
service-tunnels stop-all              # 停止守护 + 清理全部子进程
```

> **短别名 `sts`**：`npm install -g service-tunnels` 会同时安装 `sts` 命令，与
> `service-tunnels` 完全等价，后续示例两种写法皆可（如 `sts expose 5173 --mode tunnel`）：
> `sts daemon start` / `sts tunnel list` / `sts status`。
> （`st` 别名不发布：npm 上 `st` 是月下载百万级的静态服务器包，避免全局安装冲突。）

**虚拟主机语法**（本地/域名直达，`st.localhost` 默认后缀 + baseDomain + site.domain）：

```
5173.st.localhost              → 开放直连（需 open binding）
5173-auth.st.localhost         → 默认站点认证
5173-portal.st.localhost       → portal provider 站点
5173-host.st.localhost        → 站点 host（宿主自身）
5173.web.example.com          → 站点 host 的域名（隐含 site）
```

**baseDomain**（用户自有泛解析域名，隐藏本地端口）：

```bash
service-tunnels expose 5173 --mode proxy --auth portal --base-domain example.com   # 一条命令：DNS *.<域> → 本机 + nginx 反代到 proxy 端口
  # → localUrl: http://5173-portal.st.localhost:4180   （默认兜底，带端口）
  # → baseUrl:  http://5173-portal.example.com      （无端口）
```

## 暴露模式：tunnel / proxy / both

`expose` 按"要不要公网隧道"区分三种模式，认证开关（`--auth none|auto|<provider>`）与之正交：

| 模式 | 可达性 | 典型用途 |
|---|---|---|
| `tunnel` | 公网 URL（ngrok/cloudflared/bore/natapp…） | 公网演示、临时分享、无公网 IP 的机器 |
| `proxy` | 仅本地/局域网虚拟主机（`*.st.localhost:4180`、baseDomain、site 域名） | 多服务固定域名、自建站点、开发联调 |
| `both` | 上述两者同时，同一 site 同一批用户 | 本地固定入口 + 公网访问并存 |

**proxy 模式是什么**：内置反向代理监听 proxy 端口（默认 4180），按 `Host` 头把
`<port>[-<label>][.<site域名>].<后缀>` 路由到对应本地服务端口，认证统一由本地网关
（nginx）或内置 proxy 完成。隧道（ngrok/cloudflared 等）永远是"公网 URL → 本地网关"
的**纯透传通道**——与认证、路由无关，这是"认证统一在本地端口侧"的架构原则。

proxy 默认**零转发**（D4）：虚拟主机必须显式 enrollment（`expose --mode proxy/both`
会注册 binding），未 enroll 一律 403（not enrolled）。

## 隧道类型速查

| 类型 | 公网可达 | TCP 支持 | 账号/依赖 | 说明 |
|---|---|---|---|---|
| `ngrok` | ✓ | ✓（tcp） | ngrok 账号 authtoken | 官方隧道，稳定成熟 |
| `cloudflared` | ✓ | ✗ | 无 | 一条命令拿 `trycloudflare.com` 随机 URL，零账号 |
| `localtunnel` | ✓ | ✗ | 无 | 免费随机子域（localtunnel.me） |
| `bore` | 取决于自建 server | ✗ | 无 | 自建单二进制 `bore server`，本机/局域网零账号穿透 |
| `natapp` | ✓ | ✗ | natapp.cn 注册（authtoken） | **中国国内内网穿透**，CN 网络延迟低、免备案，VIP 可绑自定义域名 |
| `ssh` | 取决于远端 | ✓（`-R`） | 远端 ssh 账号 | `ssh -R` 反向隧道到任意主机/自建跳板 |
| `serveo` | ✓ | ✗ | 无 | serveo.net 免费 ssh 托管（HTTP 子域） |
| `frpc` | ✓ | ✓（tcp） | 自建 frps server | 自建 frp 服务端，完全自控 |
| `command` | 取决于命令 | 取决于命令 | — | 任意命令兜底，解析输出中的 URL |

> **自定义命令隧道（env 注册）**：设置 `SERVICE_TUNNELS_TUNNEL_COMMAND_<NAME>` 即可注册你自己的隧道方法，
> NAME 自动出现在所有 schema 驱动的客户端（表单/下拉框）。值是一段 shell 命令模板，`{{token}}`
> 占位符即表单参数：`{{port}}` 必填输入；`{{port:8080}}` 固定默认值；`{{localport}}` 自动填入被暴露的本地端口。
> 例如 `SERVICE_TUNNELS_TUNNEL_COMMAND_sshbox="ssh -R {{port}}:127.0.0.1:{{localport}} myuser@host"`
> → 隧道列表出现 `sshbox`，要求输入 `port`，启动时自动组装为 `ssh -R <port>:127.0.0.1:<本地端口> myuser@host`。
> **URL 返回**：命令输出 `ST_TUNNEL_URL:<url>` 标记即声明隧道 URL（冒号/等号/空格分隔均可，引号与 CRLF 容忍，大小写不敏感；
> 无 scheme 的 `host:port` 自动补 `http://`）。适合先声明再跑真实命令：
> `SERVICE_TUNNELS_TUNNEL_COMMAND_box="echo ST_TUNNEL_URL:https://myapp.example.com && ssh -R 80:127.0.0.1:{{localport}} u@h"`。
> Windows（cmd）：`set "SERVICE_TUNNELS_TUNNEL_COMMAND_win=echo ST_TUNNEL_URL:http://127.0.0.1:8080 && ssh -R {{port}}:127.0.0.1:{{localport}} u@h"`
> （URL 避免 `& | < > ^ ( )` 等 cmd 特殊字符；PowerShell 用 `$env:SERVICE_TUNNELS_TUNNEL_COMMAND_win='...'` 同样由 cmd 执行）。
> **安全**：所有占位符值（表单输入/默认值/localport）按字面量单引号转义注入（`'`→`'\''`，POSIX），
> 空格/`$`/反引号/`;`/`|`/`&` 等全部惰性化——值只是数据，绝不成为 shell 语法；控制字符 fail-closed 拒绝。

> 二进制工具自动下载：官方源 → Gitee/ghproxy/npmmirror 镜像回退；`config set allow-tool-download false` 可关闭。

## 使用场景

- **本地多服务固定域名**（proxy）：多个本地服务各占端口，`5173.st.localhost`、
  `8080-portal.st.localhost` 直达，认证按 site 隔离——开发/内网联调不碰公网。
- **公网演示 / 临时分享**（tunnel）：`expose 5173 --mode tunnel --auth auto` 一条命令
  拿到随机公网 URL 且带认证（Authelia/portal + 2FA），防路人。
- **中国网络直连**（natapp + 镜像）：natapp 国内节点延迟低；工具下载自动走 Gitee/ghproxy
  镜像，`preferMirrors` 可强制镜像优先。
- **零账号局域网穿透**（bore）：内网/局域网机器间零配置穿透（自建 bore server）。
- **固定公网域名、隐藏端口**（baseDomain）：自有泛解析域名 `*.example.com → 本机`，
  proxy + `config set base-domain` 后访问 `http://<port>-portal.example.com`（无端口号）。
- **嵌入自有应用**（库模式）：应用把 service-tunnels 当库，用 `st.proxy.resolve()` /
  `st.proxy.parseHost()` 在进程内做 vhost 决策，`expose(..., { startTransport: false })`
  不占独立端口——中间件即网关。

**库模式示例（宿主应用策略）**：宿主应用把 service-tunnels 作为库在进程内单例运行——
自身管理界面与子进程 dev server 分属**两个独立 site（认证域）**，用户库互不共享；
每个服务 `expose` 注册 binding，宿主应用自己的 HTTP 中间件用 `st.proxy.resolve()`
做 vhost 决策（forward / pipe / redirect / deny），`startTransport: false`
不占独立端口——**中间件即网关**：

```ts
const st = createServiceTunnels();
st.sites.add("host",     { provider: "portal", domain: "web.example.com" });  // 自身界面：portal + 2FA
st.sites.add("services", { provider: "basic",  domain: "dev.example.com" });  // 子进程：轻量 basic
await st.auth.expose(3000, { mode: "proxy", site: "host", auth: true, startTransport: false }); // 不占端口
await st.auth.expose(5173, { mode: "both",  site: "services", auth: true, tunnelType: "cloudflared" });

app.use(async (req, res) => {                    // 中间件即网关
  const d = await st.proxy.resolve({ host: req.headers.host, url: req.url ?? "/" });
  if (d.kind === "forward")  return proxyTo(d.target);          // 已认证 → 服务端口
  if (d.kind === "pipe")     return pipeTo(d.port, req, res);   // 登录页 / 认证提供方
  if (d.kind === "redirect") return res.redirect(d.location);   // 未认证 → 302 登录
  res.statusCode = d.status; res.end(d.body);                   // deny / deny-auth
});
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
  // allowAuthNone: false,                 // 禁止无认证暴露（auth none）
});

const ports = st.discovery.getPorts();          // 发现服务端口（排除框架内部端口）
await st.tunnels.start("web");                   // 隧道（工具自动解析/下载）
await st.auth.expose(5173, { auth: true });      // 一键暴露 + 认证（tunnel）

// 站点隔离（认证域）
st.sites.add("host", { provider: "portal", domain: "web.example.com" });
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
expose <port> [--mode tunnel|proxy|both] [--site <s>] [--tunnel <t>] [--proxy-port <p>] [--base-domain <d>] [--auth [auto|none|<provider>]] [--name <n>] [--allow-auth-none <true|false>]
auth provider list | register <host> | unregister <host>
auth user list | add | set-password | remove [--site <s>] [--provider ...]   # 用户管理（按站点）
auth totp enroll | disable | status <user> [--site <s>] [--provider ...]     # 2FA 管理
ui [--port <p>] [--no-browser]          # 网页管理界面（127.0.0.1，自动弹浏览器）
gateway start|stop|status
status [--json]
stop-all
config path | show | get <key> | set <key> <value>   # base-domain / proxy-port / base-path / allow-auth-none / ...
```

## 禁止无认证暴露（auth none 开关）

默认允许 `--auth none`（无认证暴露）。安全要求严格的环境可一键禁止：
任何一层设为 **false** 即生效（安全开关，单次调用的 true 无法覆盖）：

1. **API 参数**：`createServiceTunnels({ allowAuthNone: false })`，或单次
   `st.auth.expose(port, { allowAuthNone: false })`
2. **环境变量**：`SERVICE_TUNNELS_ALLOW_AUTH_NONE=0|false|off`
3. **配置文件**：`config set allow-auth-none false`

禁止后：

- `auth providers list` / `st.auth.providers()` 不再返回 `"none"`；UI 的认证
  下拉框隐藏「none（无认证）」选项并提示必须认证；daemon `schemas` RPC 带
  `authNoneAllowed` 字段供客户端判断。
- 一切无认证暴露直接失败：`expose <port>`（不带 `--auth`）、`--auth none`、
  `--mode proxy` 开放绑定、`protocol tcp`（tcp 本身无认证），错误信息提示
  改用 `--auth auto/<provider>`。

## 设计文档

- [`docs/sites-design.md`](docs/sites-design.md) — **站点（认证域）隔离 + proxy 暴露模式**（site / enrollment / hostsubfix / baseDomain）
- [`docs/token-auth-design.md`](docs/token-auth-design.md) — **Bearer token 认证方案**（tunnel API 请求；生成/说明/有效期/按 site 管理 + 双通道校验）
- [`docs/auth-provider.md`](docs/auth-provider.md) — **编写 AuthProvider 指南**（接口 / 自描述协议字段 / 最小示例 / 注册 / 检查清单）
- [`docs/design.md`](docs/design.md) — 架构 / 模块 / 认证 provider 模型 / 平台矩阵
- [`docs/input-validation-security.md`](docs/input-validation-security.md) — **隧道参数输入安全**（审计 + 加固方案与实现）
- [`docs/api.md`](docs/api.md) — 库 API
- [`docs/cli.md`](docs/cli.md) — CLI 参考
- [`docs/config.md`](docs/config.md) — 配置与目录规范

## 安全模型

- **D4 零转发**：proxy 默认不转发任何端口——虚拟主机必须显式 enrollment（`expose --mode proxy/both`）后才可达，未 enroll 一律 403（not enrolled）
- 代理/隧道目标只允许 127.0.0.1；未知站点 label → 403；后缀即主机白名单（防 DNS rebinding）
- 每 site 独立用户库/密钥（`cacheDir/tmp/sites/<site>/...`）；state.json 不含 secret
- 框架辅助进程带 `SERVICE_TUNNELS_ROLE` 标记：发现时排除、daemon 退出时清理
- **隧道参数输入校验**（`src/validation.ts`）：所有用户输入在 `start()` 与 daemon RPC 双入口 fail-closed——ssh `host/user` 以 `-` 开头（选项注入 → 本机 RCE）拒绝、token/server/domain 控制字符（frpc INI 注入）拒绝、隧道名路径穿越拒绝；内置隧道全部无 shell spawn，token 只经 env/单 argv 传递；`command` 类型（唯一 shell）经 daemon 必须显式 `dangerous: true`；`tunnel add --type ngrok --token x` 自动注入 `NGROK_AUTHTOKEN` env
- **管理面板 CSRF 防护**（`src/ui.ts`）：所有 POST 要求同源 Origin + 随机 CSRF token；**Windows IPC** 带每实例 secret 鉴权（state.json 0600）
- 隧道工具（尤其 frpc）可能被安全软件标记为 HackTool/RiskWare——属工具自身问题，见 design.md §8.1

## License

MIT
