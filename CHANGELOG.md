## 0.2.4 (unreleased)

### P5：UI 站点管理 + pi-web 集成示例（sites-design.md §5.8）
- **UI 站点管理页**：`service-tunnels ui` 新增导航「站点管理」——/sites 列表
  （站点/provider/认证/域名/运行态/地址），添加/删除站点，`/sites/<name>/users`
  每 site 独立用户增删改密；快速暴露表单加 `mode`（tunnel/proxy/both）+ `site` 选择
- **pi-web 集成示例**（examples/pi-web-integration.ts）：`ensureSites()` 预置
  site pi-web（自身，portal + web.pi.example.com）+ site services（子进程，basic +
  dev.pi.example.com）；`exposeSelf`/`exposeService` 各自独立认证域

### P3/P4 收尾：site.domain 后缀 + bindings 持久化（sites-design.md §3.2/§5.7）
- **site.domain → domainUrl**：site 配了 `domain` 后 expose 返回无端口
  `http://<port>.<site-domain>`；`<port>.<site-domain>` 虚拟主机隐含该 site
  （proxy `resolveSuffixSite` + `#findBySite`），与 label 形式同一认证域
- **bindings 持久化（state.json）**：proxy enrollment 落盘；daemon 重启后
  `proxy.restore` 恢复，provider 懒接线重新拉起——`stop-all` → `daemon start`
  → `proxy status` 绑定仍在；库模式同步持久化
- `st.proxy.restore/persisted`；daemon RPC `site.*`；`st.exposes()` 增加 domainUrl

### 默认虚拟主机后缀改为中性 `.st.localhost`（去品牌化）
- 默认后缀从 `.pi.localhost`（pi-web 品牌名）改为 **`.st.localhost`**，并保留
  `.service-tunnel.localhost` 别名——`5173.st.localhost` / `5173-auth.st.localhost` /
  `5173-portal.st.localhost`；`--suffix` / `suffixes` 配置仍可完全自定义

### baseDomain —— 用户自有泛解析域名的无端口地址（sites-design.md §3.4）
- `config set base-domain pi.example.com`：proxy 模式 expose 额外返回**无端口地址**
  `baseUrl`（如 `http://5173-portal.pi.example.com`），默认带端口 `localUrl`
  （`http://5173-portal.st.localhost:4180`）仍为兜底——两个域名并存
- baseDomain 自动加入 proxy 后缀集合；懒接线按**实际 Host** 注册 provider
  （authelia cookie domain per-host）；`loginRedirect` 跟随请求 scheme
- 端口可指定：`--proxy-port <p>` / `config set proxy-port <n>`（默认 4180，busy→随机）
- CLI/库：`expose --base-domain <d>` 覆盖 config；`st.exposes()` 增加 baseUrl

### Site（认证域）隔离 + st.sites（sites-design.md P1）
- **site = 独立认证域**：registry 实例缓存键从 `type` → `type#site`，每 site 独立
  存储 `cacheDir/tmp/sites/<site>/<provider>/`（portal users.json / basic htpasswd /
  authelia 全套配置+sqlite / oauth2-proxy conf）——**不同 site 不共享配置和用户**
- **`st.sites` / CLI `site list|show|add|remove`**：sites.json（0600）+ 隐式 default
  （兼容现状路径，零迁移）；校验收紧（`[a-z0-9-]`、禁 `auth`/`default` 名）
- **expose 统一 site 解析**：dispatcher 一次解析 site（显式 `--site` > 隐式 provider
  site > default），proxy 与 tunnel 分支共享同一实例；site 配置（provider/basePath/
  policy/providerParams/user）自动接入 expose
- **用户管理 site 作用域**：`auth user/totp * --site <s>`（缺省 default）——同名用户
  在不同 site 密码/删除互不影响；daemon RPC `auth.user.*/auth.totp.*` 同
- **proxy-manager**：懒接线按 `binding.site` 建实例；`getSites` 活取数（运行时新增
  site 即时可解析虚拟主机 label）
- 测试：test/sites.test.mjs（同名用户双 site 独立 + 路径隔离 + 端到端双向登录拒绝）

### expose --mode proxy:本地虚拟主机 + enrollment(D4)+ per-host 认证(sites-design.md P2)
- **`expose <port> --mode proxy|both`**：不建隧道、在本地虚拟主机上暴露（`--mode both`
  同时建公网隧道，同一 site 同一批用户）。`--mode proxy` 返回 `localUrl`（默认端口
  4180，`--proxy-port` 可配，0=随机）
- **hostsubfix 短横线语法（D3）**：`5173.st.localhost`（开放）、`5173-auth.st.localhost`
  （默认 site 认证）、`5173-portal.st.localhost` / `5173-pi-web.st.localhost`（provider/
  site 标签）；未知 label → 403
- **D4 安全默认（破坏性变更）**：proxy **默认零转发**——任何虚拟主机必须显式
  enrollment（`expose --mode proxy/both`）后才可达，未 enroll → 403（not enrolled）；
  旧"发现缓存全放行"行为移除，无 `--open` 兼容开关
- **per-host 认证后端**：forward-auth（portal/authelia/oauth2-proxy，`{basePath}/*`
  登录页经虚拟主机可达、scheme 跟随本地 http）；basic **退回 nginx auth_basic**
  （D2，Node 不实现 APR1）；首请求懒接线（validate → start → registerHost）
- **CLI**：`expose --mode/--site/--proxy-port`；`proxy start|stop|status` 降级为传输层
  管理（daemon 持有，enrollment 一律经 expose）；daemon RPC `proxy.*`
- **库 API**：`st.proxy.start/stop/status/bindings/addBinding/removeBinding`；
  `st.auth.expose(port, { mode, site })`；`st.exposes()` 增加 site/label/localUrl
- **修复**：proxy 转发响应不再透传上游 `Connection` 头（keep-alive 复用 400）
- 测试：test/expose-proxy.test.mjs（enrollment + portal 登录 + both 双入口）；
  proxy.test.mjs 扩展（语法/未知 label/basic→gateway 管道）

### 默认认证 auto + natapp 内置 + 网页管理界面
- `expose --auth auto`(默认):按平台选认证 provider——Windows=portal(Node 内置),
  Linux/macOS=authelia;`--auth none` 显式关闭认证(纯透传隧道)
- 新增内置 tunnel 类型 `natapp`(国内内网穿透):`--type natapp --token <authtoken>`,
  免费版随机 natappfree.cc 域名,VIP 加 `--server` 绑定自定义域名;URL 解析支持
  natappfree.cc/natapp.cc 等域名。**无公开直链**——客户端经官网安装脚本分发
  (get.sh/get.ps1,需 authtoken),缺失时给安装命令;tools 解析走 PATH/缓存/toolPaths
- 新增 `service-tunnels ui [--port <p>] [--no-browser]`:零依赖网页管理界面
  (node:http),监听 127.0.0.1 并自动弹浏览器;概览/隧道管理(启停删增)/用户管理
  (增删改密/2FA 启用禁用)/配置查看/快速暴露表单
- daemon IPC 新增 `tunnel.get`(UI 切换开关用)
- ssh 隧道 URL 合成延迟可配置(`sshUrlSynthDelayMs`,默认 11s;本机/局域网可注入
  小值让 URL 秒级出现);测试改用真实本机 ssh(user@localhost)验证转发/合成/撤销

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
