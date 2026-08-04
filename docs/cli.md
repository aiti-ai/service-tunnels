# service-tunnels CLI — 参考

全局参数：`--config-dir <dir>` / `--cache-dir <dir>` 覆盖默认目录
（默认 `~/.config/service-tunnels` / `~/.cache/service-tunnels`，
环境变量 `SERVICE_TUNNELS_CONFIG` / `SERVICE_TUNNELS_CACHE` 亦可覆盖）。

## daemon — 常驻守护（CLI 模式的进程模型）

nginx/authelia/redis/隧道都是常驻进程，CLI 每次执行是短命进程——用 daemon 持有：

```bash
service-tunnels daemon start                 # 后台常驻（detached）
service-tunnels daemon start --foreground    # 前台（调试/容器）
service-tunnels daemon stop                  # 优雅退出并清理全部子进程
service-tunnels daemon status
service-tunnels daemon logs [--tail 100]
```

- daemon PID 与 IPC 地址写入 `~/.cache/service-tunnels/state.json`；
- 除 `discover`/`status`/`config` 外，操作类命令自动经 daemon IPC 转发；
  daemon 未运行：提示 `daemon start` 或加 `--auto-daemon` 自动拉起；
- 库模式（pi-web 等）不需要 daemon——manager 在调用方进程内常驻。

## discover — 查询端口（接受端口或进程 id）

```bash
service-tunnels discover                 # 当前进程树内的监听端口
service-tunnels discover --pid 1234      # 以 pid 1234 为根的后代端口
service-tunnels discover --port 5173     # 只查某个端口是否被“自己的进程树”持有
service-tunnels discover --json          # 机器可读
service-tunnels discover --refresh       # 绕过 5s 缓存
```

输出：`port, pid, process, cmdline, addresses[]`（通配绑定已展开为
127.0.0.1/::1/本机 IP）。**已排除框架辅助进程端口**（nginx/authelia/redis）——
它们通过 `service-tunnels internal list` 单独查看。

## proxy — 泛域名代理（本机/局域网，零依赖）

```bash
service-tunnels proxy start [--port <p>] [--suffix .pi.localhost] \
    [--base-path <bp>] [--password <pw>] [--no-ws]
service-tunnels proxy stop
service-tunnels proxy status
```

- 默认监听 `127.0.0.1:<p>`（p 默认 4180）；`<port><suffix>` 虚拟主机 → 对应
  测试端口；可加多个 `--suffix`。
- `--base-path` 部署时剥离（`/dev/foo → /foo`）。

## expose — 一键公网暴露（可带认证）

```bash
service-tunnels expose 5173                                # 默认隧道 ngrok，无认证
service-tunnels expose 5173 --tunnel frpc --auth           # frpc + 默认 provider（authelia）
service-tunnels expose 5173 --auth basic                   # 最简 Basic 认证
service-tunnels expose 5173 --auth oauth2-proxy            # 指定其他 provider
service-tunnels expose 5173 --tunnel ssh --auth --name web
service-tunnels expose stop 5173
service-tunnels expose status
```

`--auth [<provider>]`：**一律默认 `authelia`（统一本地网关认证），与隧道类型
无关**——所有隧道都只是透传到本地 nginx 端口的通道，认证统一在 nginx 侧完成。
未指定 provider 时自动选 `authelia`；可用 `--auth basic` / `--auth oauth2-proxy`
/ 插件名显式指定。provider 未就绪自动绿色拉起（缺二进制/缺 OIDC 注册等会在
validate 阶段给出修复提示）。流程见 `docs/design.md §4.7`。

## tunnel — 隧道清单管理

```bash
service-tunnels tunnel list [--json]
service-tunnels tunnel add web --type ngrok --target 4180 [--domain x.ngrok-free.app]   # target=nginx 端口，认证在网关
service-tunnels tunnel add api --type frpc --target 8080 [--auth authelia]
service-tunnels tunnel add ssh1 --type ssh --target 3000            # serveo：ssh -R 80:127.0.0.1:3000 serveo.net
service-tunnels tunnel add lt1  --type localtunnel --target 5173    # lt --port 5173；随机域名走动态登记即可，--subdomain 可选
service-tunnels tunnel add cf1 --type cloudflared --target 4180
service-tunnels tunnel start web
service-tunnels tunnel stop web
service-tunnels tunnel remove web
```

认证与隧道解耦：`--auth` 在 nginx 网关侧统一生效（provider：authelia 默认 /
oauth2-proxy / basic / 插件），隧道进程本身不参与认证；`none`（默认，无认证）。

## internal — 框架辅助端口

```bash
service-tunnels internal list [--json]   # [{role:"nginx",port:4180},{role:"authelia",port:9091},...]
```

- 框架自己拉起的 nginx/authelia/redis 监听端口，**不进入 `discover` 结果**；
- 供调用方展示"框架服务"或健康检查（如 pi-web 的 ServicesDialog）。

## gateway — 认证基础设施（nginx + Authelia + Redis）

```bash
service-tunnels gateway start [--nginx-port 4180] [--authelia-port 9091]
service-tunnels gateway stop
service-tunnels gateway status [--json]
service-tunnels gateway reload            # nginx -s reload（新 server 块后）
```

## auth — provider 管理与登记

```bash
service-tunnels auth provider list                     # 已加载的认证 provider
service-tunnels auth provider install <pkg|path>       # 安装插件（npm 包或本地 providers/*.js）
service-tunnels auth register alice.ngrok-free.app     # 写入 provider 的登记（authelia: session.cookies + 重启）
service-tunnels auth unregister alice.ngrok-free.app
service-tunnels auth list
```

## status / 配置

```bash
service-tunnels status [--json]      # 总览：进程、隧道、URL、认证
service-tunnels stop-all             # 退出清理（等价进程退出时的清理）
service-tunnels config path          # 打印解析后的 config/cache 目录
service-tunnels config show          # 显示生效配置（脱敏）
```
