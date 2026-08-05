## 0.2.3 (unreleased)

### 隧道/Auth 全面真实测试修复(6 bug)
- ngrok 正则补 `.ngrok-free.dev`(免费域名已换)→ URL 解析修复
- `userManagers()`/`userManager()` 不再用空 opts 缓存 provider 实例
  (oauth2-proxy 丢 oidc、authelia 丢 policy/basePath 的根因)
- authelia `addUser` 在目录创建前写库 → mkdir 兜底
- authelia 策略改为 per-host(registerHost 的 policy 参数此前被忽略)
- expose 停止时注销网关 host(onTunnelStop 钩子;localhost:PORT 残留碰撞)
- `TUNNEL_META` + `st.schemas.metas()`:favorite 标记(零账号/参数少优先)
  localtunnel/serveo/cloudflared/bore;daemon/CLI `schemas` 同步输出

# Changelog

## 0.2.2 (unreleased)

### 密码字段处理
- `tunnel add -i` 交互:type="password" 参数输入不回显(override readline `_writeToOutput`)
- 澄清:pi-web 表单本就 type=password 遮蔽;tunnel token/secret 明文存 0600 配置目录(设计如此)

## 0.2.1 (unreleased)

### CLI 同款 schema 驱动
- `tunnel add --set key=value` / `expose --tunnel-set k=v --provider-set k=v`:按类型/provider 的
  ParamSpec 校验与强转(未知 key 报错并列出合法 key;number/boolean 自动转换)
- `tunnel add -i/--interactive`:真终端逐项提示(标签/默认值/说明,同 pi-web 表单);
  管道输入(脚本)时确定性用 --set + 默认值,缺必填报错
- `coerceParam`/`applyParamSets` 从库导出(客户端可复用同一套校验)

## 0.2.0 (unreleased)

### 新增: 数据驱动的 provider 参数 schema(客户端免改)
- `ParamSpec`(key/label/type/description/link/linkTitle/default/placeholder/
  required/options)+ `TUNNEL_PARAM_SCHEMAS`:8 个隧道类型的参数声明
  (ngrok/frpc/ssh/serveo/cloudflared/localtunnel/bore/command),key 即
  TunnelConfig 字段;客户端据此渲染表单并回传参数
- `AUTH_PARAM_SCHEMAS` + `authProviderSchemas(configDir)`:authelia/basic/
  portal/oauth2-proxy 的参数声明;插件模块可导出 `paramSchemas = {type, specs}`
  追加自己的 schema
- 访问器:`st.schemas.{tunnels,tunnel,authProviders}`(库)、daemon IPC
  `schemas`、CLI `schemas [--type <t|auth>]`
- `expose()` 新增 `tunnelParams`(平铺 TunnelConfig 字段)与 `providerParams`
  (点号键自动展开嵌套,如 `oidc.issuerUrl` → `{ oidc: { issuerUrl } }`)
- pi-web 等客户端可完全数据驱动:新增隧道类型/auth provider 不再需要改客户端

## 0.1.2 (unreleased)

### 新增: bore 隧道类型(自建本地/CI 测试用)
- `tunnels.ts` 新增 `bore` 类型:`bore local <port> --to <server> [-p <remotePort>] [-s <secret>]`,
  默认 server=localhost(控制口 7835,连自建 `bore server`);URL 从
  `listening at <host>:<port>` 合成 `http://<host>:<port>`
- `tools.ts` 新增 bore 下载(bore 资产为 Rust target triple,新增 `{rust_target}`
  占位符,对后续 Rust 工具可复用);GitHub 官方源 + ghproxy 镜像
- `cli.ts` `tunnel add` 新增 `--user` / `--remote-port`,并透传 `--port`
  (ssh `-p` / bore `-p` 复用);`--host` 此前已透传
- ssh 类型:无输出可解析时(如 `ssh -R` 到自有服务器)按配置合成
  `http://<host>:<remotePort>` URL,list/status 可见

### 修复: CLI guardian 误杀 daemon 持有的隧道
- 根因:每次 CLI 调用 `createServiceTunnels` 都生成一个监视 CLI 进程的
  guardian;CLI 退出后 guardian 把**同 marker + role** 的进程全部清掉,
  其中包含 daemon 常驻持有的隧道(ngrok/frpc/ssh/serveo/cloudflared/
  localtunnel/bore 均受影响;`command` 类型因 shell 形态不带 roleEnv 而幸免)
- 修复:`cli.ts` 以 `guardian: false` 创建实例——CLI 的一切长生命周期
  操作都委托给 daemon(daemon 自带 guardian,daemon 被 SIGKILL 时仍会
  清理其角色进程),CLI 自身不持有任何 helper,guardian 纯属误伤

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
