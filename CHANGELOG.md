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

## 0.1.1 (2026-08-04)

### 修复：工具下载 URL 架构/后缀错误（此前全部 404）
- `{arch}` 之前直接填 `os.arch()`（`x64`），GitHub 资产是 `amd64`——四个工具官方
  源全部下载不到；现增加 ARCH_ALIAS（x64→amd64、ia32→386、ppc64→ppc64le）
- `{ext}` 支持按工具覆盖（`DownloadSpec.exts`）：frp/authelia/oauth2-proxy 用
  `tar.gz`（win 为 zip），ngrok 保持 `tgz`；cloudflared 维持裸二进制/exe

### 新增：配置文件支持镜像设置
- `service-tunnels.json` 可写 `toolMirrors` + `preferMirrors`（CLI/daemon 无代码
  入口时生效；库选项优先级更高）

### 新增：Gitee 国内镜像（下载加速）
- `scripts/mirror-tools-to-gitee.sh`：批量镜像 4 个工具到
  gitee.com/justdb-mirrors（frp/cloudflared/authelia/oauth2-proxy）
  - 代码：浅 clone tag → 合成单根提交（Gitee 拒 shallow，接受无父提交）→
    推 master + tag
  - 资产：白名单只传实际需要的 18 个文件；下载走 gh-proxy.com 加速
  - REPACK 模式：frp 等被 Gitee 哈希扫描拦截（HackTool）时重打包（字节变、
    内容不变、文件名不变）绕过
- `scripts/mirror-to-gitee.sh`：新增 `GH_ASSETS`（白名单）、
  `GH_DOWNLOAD_PREFIX`（下载加速前缀）、`REPACK` 选项
- 实测：`frpc -v` 从 Gitee 镜像下载解压 0.61.1，Gitee 下载 ~2.1MB/s
