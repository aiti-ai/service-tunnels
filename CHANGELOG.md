# Changelog

## 0.1.0 (2026-08-04)

首个完整实现——M1 到 M6 全部落地。

### M1 骨架
- `config.ts` 目录解析（构造参数 > `SERVICE_TUNNELS_CONFIG/CACHE` > XDG 默认）
- `marker.ts` 子进程标记（`SERVICE_TUNNELS_MARKER` / `SERVICE_TUNNELS_ROLE`）
- `discovery.ts` 端口发现（/proc BFS + marker + lsof/netstat + 通配展开），
  角色标记排除框架辅助进程、internal 注册表过滤
- `daemon.ts` + `daemon-server.ts`（detached 常驻 + unix socket JSON-RPC +
  state.json 定位；pidAlive zombie 感知）
- `state.ts` 原子读写 state.json

### M2 泛域名反代
- `proxy.ts`：`<port>.<suffix>` Host 路由、发现缓存白名单（403 防跳板）、
  SSE/WebSocket upgrade 转发、stripBasePath、Basic 密码门

### M3 隧道管理
- `tunnels.ts`：ngrok/frpc/ssh/cloudflared/localtunnel/command 六类隧道，
  工具解析 → spawn（角色标记+进程组）→ 输出缓冲 → URL 解析 → state 镜像；
  stop 等待 + SIGKILL 兜底；daemon 持有（跨 CLI 调用可见）
- `tunnels-config.ts`：configDir/tunnels.json 声明式配置（0600）

### M4 认证编排
- `auth-provider.ts` AuthProvider 接口（可插拔；authelia 为内置默认）
- `gateway.ts` nginx 网关（随机端口、默认 444、auth_request、热重载、TCP 探测）
- `authelia.ts` 绿色启动 + 动态登记（config-tunnels.yml 全 section 重写 +
  validate + 重启；encryption_key 持久化；authelia_url 必填；https 强制）
- `redis.ts` 绿色 redis（随机端口 + AOF）
- `expose.ts` 一键流程（隧道→网关→登记）
- 端到端验证：未认证 401、门户 200、host 动态登记

### M5 生命周期与安全
- `cleanup.ts` 角色标记清理（daemon shutdown + 信号 handler + 客户端兜底）
- config/socket 0600、stop-all、README、pi-web 集成示例

### M6 插件化 provider
- `auth-registry.ts`（内置 authelia/basic/oauth2-proxy + plugins 加载）
- `providers/basic.ts`（nginx auth_basic + APR1；免进程免 Redis）
- `providers/oauth2-proxy.ts`（OIDC 侧车；二进制自动下载）
- 边缘型扩展点（`renderTunnelAuth`，ngrok edge-oidc 预留）
