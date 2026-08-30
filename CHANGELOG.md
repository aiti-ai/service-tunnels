## 0.3.67 (2026-08-30)

- **fix(ddns-audit): 深度审核修复**
  - UI DDNS tab 添加按钮崩溃（`c.getElementById` 不存在 → `document.getElementById`）；
  - CNAME 信标值去端口（tcp://host:port 的 CNAME 非法，urlHost 剥离端口）；
  - DDNS_PROVIDERS 动态枚举（ddns 包 86 家，替代硬编码 42 家）；
  - registerPortmap/Tunnel 未解析 profile 时结果带明确 error（不再静默）；
  - portmap/tunnel 注册 promise 补 .catch（防 unhandled rejection）；
  - registry 与 legacy beacon 双轨去重（同 tunnel 不重复注册）。

## 0.3.66 (2026-08-30)

- **feat(ddns): 预配置体系 + 自动注册闭环（CLI + UI）**——ddns.json 支持
  `providerProfiles`（provider 级凭据）/ `profiles`（provider+域名目标）/
  `entries`（注册条目），事件驱动自动注册：
  - `kind:"portmap"`：路由器映射建立 → A 记录（externalIp）+ TXT（ip:port）
    ——记录名分别由 `record` / `txtName` 指定（txtName 缺省回退 record）；
  - `kind:"tunnel"` + `followTunnel`：tunnel 拿到新 URL → CNAME（url host）
    + TXT（完整 url），重连/重启自动重注册；
  - 预配置组合：`profile`（引用 profiles）或 `providerProfile` + 内联
    zone/record，条目可再覆盖。
  - CLI：`st ddns provider-profile-add | profile-add | entry-add | registry-list`；
  - UI：DDNS tab（provider profiles / profiles / entries 三块，增删即存）；
    `/api/ddns-registry` GET/POST + `/api/ddns-providers`。
  - 库：`readRegistryConfig/writeRegistryConfig/resolveEntry/registerPortmap/
    registerTunnel`（src/ddns-registry.ts），expose() 与 tunnel url 事件自动触发。

## 0.3.65 (2026-08-30)

- **feat(ddns): 集成 ddns 包（120 家 provider）**——内置薄版适配器替换为
  `ddns` 包（file:../ddns，多供应商 DDNS + DNS 记录管理引擎）。
  - 维度 1（设备直连）：`st ddns add/list/remove/update/ip` 保持原命令，
    底层走 ddns 包的 updateEntry/runOnce/startLoop（cloudflare/dnspod/aliyun/
    duckdns/custom/freedns/…120 家），配置仍为 `<configDir>/ddns.json`（0600）。
  - 维度 2（tunnel 信标）：ddns.json 条目加 `followTunnel: "<tunnel名>"`——
    tunnel 拿到新 URL 时自动把固定信标名（CNAME 剥 host / TXT 存完整 URL）更新
    为当前 tunnel 域名，`nslookup <信标>` 即可定位最新 tunnel（无人值守、
    远端无访问方式时也可用）。库 API `st.updateBeacon()` / `beaconValue()`。
  - 测试：test/ddns.test.mjs 重写为适配层测试（转发 + 信标 + 配置 0600）。

## 0.3.64 (2026-08-30)

- **feat(portmap): 动态端口穿透第三种暴露模式（mode="portmap"）**——外网访问不再
  依赖隧道/反向代理，直接在路由器上开动态端口映射（docs/portmap-analysis.md）。
  - 三后端：UPnP IGD（SSDP 组播+单播双通道探测、AddPortMapping、718 冲突重试）、
    NAT-PMP/PCP（RFC 6886 二进制编解码，同端口 5351）、ssh-router（openwrt/
    routeros/generic-iptables 命令预设，comment tag 幂等增删 + sweep 清孤儿）。
  - 半衰期续租循环（有限租约强制，崩溃自愈）+ 退出清理；`MapHandle.stop()` 幂等。
  - 探测：`st portmap probe` / `st.portmap.probe()`——CGNAT/私网判定（RFC 6598），
    ssh-router 路径拿真实公网 IP 后二次复核（F3），命中则回滚映射并报错。
  - CLI `sts expose --mode portmap --portmap-set k=v ...` + `sts portmap probe|list|stop`；
    daemon RPC `portmap.probe/list/stop` + expose portmap 参数 IPC 边界形状校验。
- **feat(proxy): IP:port 直连（F1/F4/F5）**——`allowIpDirect` + `resolveIpDirectPort`：
  Host 为纯 IPv4 时按 `socket.localPort`（DNAT 后真实到达端口）映射回 app port，
  Host 端口兜底；只命中已 enroll 的 binding（D4 与 auth 照常），无 DNS rebinding 面。
  `resolveIpDirectSite` 支持命中 labeled binding（portmap + auth 场景，IP 无 label
  语义；open 形式的 vhost 请求仍严格 open）。决策结果携带 `vhost` 字段（IP 直连
  关联到命中的 vhost）。exposes 记录带 mode + portmap 详情（UI 可区分）。
- **fix(portmap): Windows 防火墙后端与跨平台测试（远程真机 F13-F15）**——
  F13：Windows 无 ufw/iptables/pfctl，portmap expose 全挂——新增 **netsh
  advfirewall 后端**（add/show/delete rule，规则名 `service-tunnels:<port>`）；
  resolveCmd 支持 `where` + .cmd 解析；run() 对 .cmd 走 shell。F14：e2e 测试
  泄漏 transport（Windows EADDRINUSE）——finally 清理 + 随机端口。F15：netsh
  输出本地化（中文系统"已启用: 是"）+ 无匹配规则也 exit 0——改为规则名存在
  + 非"否/No"判定，不依赖英文正则。POSIX 防火墙测试平台门控（win32 skip），
  Windows netsh 由真机验证覆盖。真机验证：Windows 公网端口转发 + portal 登录
  全链路（公网主机 curl 200 + test:test123 登录通过）。
- **fix(portmap): CLI 嵌套参数与防火墙清理（第五轮审核 F12/G7）**——F12：
  `--portmap-set sshRouter.host=x sshRouter.preset=openwrt` 点号键嵌套为对象
  （此前扁平键被 daemon 拒绝，CLI 无法配置 ssh-router 后端）；G7：防火墙放行
  规则生命周期闭环——`removeFirewall` + `onStopCleanup`：expose 本次打开的
  ufw/firewalld/iptables 规则在 stop 时自动删除（既有配置不受影响，真机验证）。
- **fix(portmap): 恢复完整性与探测性能（第四轮审核 F11/G6）**——F11：
  ExposeResult.portmap 补 method + sshRouter 持久化（ssh-router 映射重启后按原
  后端恢复，不再退化为 auto 探测/缺参失败）；G6：probe 结果按 gateway 缓存 60s
  （每次 expose 的 SSDP+NAT-PMP 探测从 ~3s 降到 14ms，真机验证）。
- **fix(portmap): 续租锚定与边界清理（第三轮审核 F9/F10）**——F9：续租闭包
  未锚定已分配的外部端口（NAT-PMP suggested=0 / UPnP 随机端口）→ gateway 可能
  换端口、URL 静默失效——renew 固定 `externalPort: mapping.externalPort`；
  F10：startTransport:false 时 proxyExpose 已注册 binding 但 portmap 提前返回
  ——该分支回滚 removeBinding。
- **fix(portmap): daemon 模式完整性（完成度审核 F6-F8）**——F6：daemon 的 proxy
  未开 allowIpDirect，CLI 默认走 daemon 时 IP 直连必 403（库/daemon 行为分裂），
  已修；F7：daemon 重启后 portmap 续租 handle 丢失（映射静默过期）——持久化
  portmap 详情 + 启动恢复循环（transport 重启后端口变了：更新 binding.ipDirectPort
  为新端口 + forceReplace 语义：718 冲突先 Delete 旧映射再重加**同一外部端口**，
  真机验证端口保持 + 恢复后 IP 直连 200）；F8：expose.stop/stopAll 不停 portmap
  映射（残留至 lease 到期）——已补 stopPortmap。恢复失败可观测：
  `state.json.portmap-restore.log` 诊断文件。
- **feat(portmap): 本机防火墙闭环（真实教训）**——路由器映射建立后自动检查+放行
  本机防火墙 `LAN IP:transportPort` 入站：ufw / firewalld（firewall-cmd permanent
  + reload）/ iptables（comment tag）/ pfctl（提示手动）。sudo 一律 `-n` 非交互
  （未配 passwordless sudo 立即失败并给手动命令），10s 超时；失败回滚映射。
  npm 调研结论：无可用的防火墙开端口包（iptables@0.0.4 等均陈旧）——自实现。
- **test(portmap)**: 15 项通过——NAT-PMP 编解码/假 responder、UPnP 718 重试与回读、
  CGNAT 拒绝+回滚、stop 幂等、IP 直连 localPort 优先（F4）+ vhost 关联、portmap+
  auth（F5：IP 直连 302 到 portal 登录 + exposes 记录区分）、ssh-router 三预设命令
  断言 + 注入拒绝、daemon RPC、防火墙 firewalld/ufw 序列（fake 命令 PATH 注入）；
  e2e（transport 注册 + IP 直连 200 + stop 清理）。
- **test(portmap-external)**: 外部连通性真实验证（`ST_TESTSERVER` env 门控，未设
  置自动 skip）——真实路由器映射 + 公网 SSH 主机 curl 反向验证，全链路（app →
  transport → 路由器 DNAT → 互联网 → 公网主机）实测通过。

## 0.3.63 (2026-08-23)

- **refactor(portal): bootstrap admin 自动创建彻底移除**——`prepare()` 不再根据 `opts.user`
  自动创建隐藏 admin（旧行为密码从不输出等于锁死）；全新安装唯一初始访问途径为
  break-glass 初始用户（env `SERVICE_TUNNELS_PORTAL_INITIAL_USER/PASSWORD` / CLI
  `--provider-set initialUser.name=…` / `opts.initialUser`；缺省自动生成随机凭据，
  写入配置目录 `initial-user.txt` + stdout）。真实用户请经 `addUser()` 显式创建。
- **feat(portal): break-glass 凭据自动清理**——`addUser()` 检测到站点从 0→1 个真实用户
  时同步删除 `initial-user.txt`，不再残留明文 break-glass 密码。
- **fix(portal): `#armInitialUser` 双重调用修复**——`start()` 内调 `prepare()` 时经
  `#armed` 标记跳过重复武装，避免凭据文件 + stdout 重复输出。
- **test(portal)**: 全部 12 项通过；break-glass 双测试覆盖（自动生成 + env 覆盖 + 凭据
  失效 + 会话作废 + 清理）。

## 0.3.62 (2026-08-17)

- **fix(cleanup): 测试残留进程泄漏根治——daemon/guardian/nginx/portal 清理链条补齐**。
  此前 e2e 测试多次运行后会在宿主 cgroup 下堆积上百个孤儿进程（16 套
  daemon+guardian、30+ nginx、portal server，拉高 pi-web 服务内存/任务数）。
  - fix(daemon-server): state.json 持久化 daemon marker；shutdown/信号处理器对
    killRoleProcesses 传 parentPid + `nginx-<pid>` 路径（nginx 剥离继承 env，原只靠
    guardian 兜底）；spawnGuardian 补齐 registrationFile/cacheDir（与库模式对齐）。
  - fix(daemon.ts): stopDaemon 不再依赖 IPC socket 文件存在——state.json 有 pid 即
    SIGTERM/SIGKILL，marker 从 state.json 兜底；startDaemon 遇到"socket 已删但进程
    存活"的失联 daemon 先回收再重建，防止实例叠加。
  - fix(auth-registry): stopAll 去重键从 type 改为实例 key(type#site)——原实现
    `portal#host` 等 site 专属认证服务器永不停止。
  - fix(gateway): 无 auth 后端(authPort=0)时前向认证/oauth2/token 配置降级为无认证
    直通，避免生成 `proxy_pass http://127.0.0.1:0/...` 非法上游导致 nginx -t 失败。
  - test: CLI 测试补 stopDaemon teardown；plugins expose e2e 按 nginx.pid 停网关；
    tunnels idempotent 测试补 stopAll——全量测试跑完 0 残留进程。

## 0.3.41 (2026-08-16)

- **feat: open-binding 高层 API（enroll/unenroll/enrolled）**——端口级登记/取消/查询，
  数据源唯一为 binding 持久化（state.json），消除宿主侧第二登记文件的必要性。
  - enroll(port, {serviceBasePath})：幂等登记 open vhost；serviceBasePath 传 undefined 保留现值、"" 清除、值覆盖
  - unenroll(port)、enrolled() → [{port, serviceBasePath?}]

## 0.3.40 (2026-08-16)

- **fix(devDep)**: justget 移入 devDependencies（0.3.39 打包进 dist 后仅构建期需要；
  缺失会导致全新 clone 后 `npm run build` 失败——build:justget 依赖 node_modules/justget）。
  运行时仍零依赖。
## 0.3.39 (2026-08-16)

- **标准零运行时依赖**：justget 打包进单文件（`dist/vendor/justget/justget.mjs`，
  `scripts/build-justget.mjs` 用 esbuild 生成）——消除 `justget` 裸导入及
  node-fetch 等传递依赖链。宿主应用 vendored 本包（扩展目录、jiti 加载）时
  不再依赖宿主 node_modules 解析裸说明符；正常 npm 安装也无需 justget。
- **feat: 移除 `justget` 运行时依赖**（已打包），`package.json` 零 dependencies。

## 0.3.38 (2026-08-15)

- **fix: transformResponse 注入路径剥离 accept-encoding**——pipe/forward 之前
  `...req.headers` 原样转发，上游（如 Next）按 `accept-encoding: gzip` 返回压缩流
  → prepend/head 注入的明文字节拼进 gzip 二进制 → 浏览器
  `ERR_CONTENT_DECODING_FAILED`。现在注入判定提前到发上游请求前，命中注入的
  请求改发 `accept-encoding: identity`（与 nginx 网关的
  `proxy_set_header Accept-Encoding ""` 对齐）；未注入请求保持透传。
- **feat: 隧道注入后重压回 gzip（inject recompress，默认开）**——上游被强制
   identity 后隧道链路（边缘 → 浏览器）变明文；现在注入 location 输出侧
  `gzip on`（nginx 过滤器链序 addition → sub_filter → … → gzip → write，
  gzip 压的是注入完成的合并输出），gzip_proxied any + 补齐 css/js/json/svg
  gzip_types，被剥离压缩的文本子资源一并恢复。`recompress: false` 可关
  （追求流式 flush；zlib 会合并流式 HTML 分块）。客户端未带 Accept-Encoding
  时 nginx 自动跳过，无额外开销。未 inject 的 host 不碰压缩。
- **fix: 注入路径健壮性**——`transformResponse` 回调调用包 try-catch（宿主
  回调抛异常降级为无注入，不拖垮转发链）；head 缓冲注入剥 `content-encoding`
  （身份请求下上游违规回 gzip 时防止明文配压缩头）。
- **test: 真实 nginx e2e 补 gzip 重压链序断言**——带 `Accept-Encoding: gzip`
  的导航请求：prepend 解压后注入字节仍为第一个字节、head 仍在 `</head>` 前
  （addition/sub_filter → … → gzip 链序）；proxy 层注入测试覆盖 identity
  上游头、回调异常降级、非 HTML 透传。

## 0.3.37 (2026-08-14)

- **fix: IPv6 通配监听（`::`）展开为双栈可达地址**——`expandListeningAddresses`（端口
  发现）：监听 `::` 的 socket 默认双栈（net.ipv6.bindv6only=0，Linux/macOS），同样
  接受 IPv4 连接（IPv4-mapped）——之前只展开 IPv6 地址、漏掉 IPv4，导致 `::` 绑定的
  服务发现不到 IPv4 可达地址；现在同时展开 `127.0.0.1` + LAN IPv4 与 `::1` + LAN
  IPv6。`0.0.0.0`/`*` 保持 IPv4-only（纯 IPv4 socket 不接受 IPv6，反向关系不成立）。
  测试：`discovery.test.mjs` 新增双栈用例。

## 0.3.35 (2026-08-11)

- **feat: transformResponse 支持 prepend 模式**——`{ html, position: "prepend" }`：
  响应开头直接写注入（不缓冲、流式保持、页面加载最早期执行）；string/head 模式保持（`</head>` 前）。
  注：prepend 注入应为合法 head 内容（`<script>` 等），包裹 `<html>` 会被解析器忽略（只认首个）。

## 0.3.34 (2026-08-11)

- **feat: transformResponse 通用响应注入**——`createServiceTunnels({ transformResponse })`：
  text/html 响应在 `</head>` 前注入 HTML 片段（pipe/forward 双路径）。
  用途：aiti-devtools launcher 注入、监控脚本、横幅等（代理层通用能力，类似 nginx sub_filter）。

# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 发布记录以 npm registry 实测时间为准；git 历史中的版本号
> （如 0.2.38–0.2.41）若未出现在 registry 发布列表中，其功能统一计入下一个
> 实际发布版本。

## [Unreleased]

### Added
- **portal 记住我（可信设备）+ 2FA 方法抽象（P0，biometric-2fa-design.md）**：
  - 登录页勾选“记住我”→ 完整 2FA 后会话 TTL 7d → 365d（可配
    `rememberMeTtlDays`；1FA 弱会话不延长）；
  - **2FA 复验周期** `GRACE = max(rememberTtl/7, 1天)`（`twoFactorGraceDays`
    可覆盖）：周期内探针直接放行；过期则免密码直跳 2FA 步骤页（会话仍
    有效时）——cookie payload 的 `.2fa` 布尔升级为 `.2fa:<epochMs>` 时间戳，
    探针按周期复验，nginx 侧零改动；
  - **2FA 方法分发表**：`/login/2fa` 按 `method` 字段分发（缺省 totp，向后
    兼容），多方法时出 chooser 选择页，零方法 + two_factor host 出引导
    错误页（不再是无意义的 TOTP 输入框）；GET `/login/2fa` 渲染方法页
    （免密码复验路径入口）；人脸/语音方法在 P1/P2 接入。
  - portal 表单 schema 增 `sessionTtlDays` / `rememberMeTtlDays` /
    `twoFactorGraceDays`。
- **portal 人脸识别 2FA（P1，biometric-2fa-design.md §7）**：
  - `biometrics: true | ["face"]` 启用（缺省关）；首次 `start()` 下载 ~8.4MB
    浏览器资产到 `cacheDir/bin/face-models/1.7.15/`（SHA-256 校验；源序：
    Gitee 自有镜像 justdb-mirrors/face-models → jsdelivr → unpkg；
    `SERVICE_TUNNELS_FACE_MIRROR` 可覆盖），prepare 保持离线；
  - 登录页客户端提取 128-d 向量（face-api.js + 3 模型由本站 assets 白名单
    路由提供），眨眼活体断言（EAR），**混合加密**上传（一次性 AES-256-GCM
    载荷 + RSA-OAEP 包裹密钥——向量远超 RSA-OAEP 190B 上限）；
  - 服务端：挑战 nonce 单次消费（5min TTL）、向量形状校验、L2 距离阈值
    匹配（缺省 0.6，`biometricThresholds.face` / per-user 可调）；
  - 管理 API：`BiometricManager`（biometricStatus / biometricEnrollFace /
    biometricVerifyFace / biometricDisable）——**首验门**（pending → 验证
    成功才 active，对齐 totpPending）；removeUser 联动清理模板；
  - 锁定更严：`bio-face:<name>` 独立计数，3 次/15min 指数封禁；
  - 接线：`st.auth.biometric*` 门面 + daemon IPC `auth.biometric.*` +
    `/api/biometric-enroll-face|verify-face|disable` + user-list 增
    biometrics 列 + i18n（en/zh）+ portal 表单 schema 增 `biometrics` /
    `biometricThresholds.face`。
- **portal 语音识别 2FA + 两条注册路径（P2，biometric-2fa-design.md §8/§9.1）**：
  - 浏览器 MFCC 提取（radix-2 FFT + mel 滤波器组，页面内纯 JS 零依赖）
    → 78-d 向量（13 MFCC × Δ+ΔΔ × mean+std）→ 混合加密上传；随机 6 位
    数字挑战 + nonce 单次消费；余弦相似度阈值（缺省 0.90）；
  - **注册路径 A（预先设置）**：`biometricEnrollTicket`（HMAC 票，10min、
    单次使用）→ portal `/enroll` 采集页（facade `biometricEnrollUrl` 直接
    拼好 URL，管理 UI 开窗即用）；
  - **注册路径 B（登录时自助）**：two_factor + 零方法账户 → 2FA 选择页
    "立即设置"入口 → 采集即注册 → 完成即登录；仅零方法账户开放（已有
    方法者须先过既有因子）；采集耗时长则续签 2FA 票据；
  - 注册质量门：样本两两余弦 ≥ 0.85（噪声/他人代录拒绝）；face 同理
    （样本两两 L2 ≤ 阈值）；
  - 管理 API：`biometricEnrollVoice` / `biometricVerifyVoice`（API 直连
    仍走 pending 首验门）；voice 锁定与 face 同严（3 次/15min）；
  - 接线：facade/daemon IPC/ui-api 增 voice + enroll-ticket 端点；内置
    UI 用户表增 bio 列（face/voice ●○）与 face/voice on/off 按钮
    （on = 开 portal 采集页）。
  - 人脸注册同样接入两条路径（facePage 参数化 action，/enroll 复用）。
- **fix（生物识别完成度审核，2026-08-16）**：
  - 内置 UI 用户表 `bioDisable` 调用不存在的 `loadUsers` → 改为
    `loadSiteBlock(site,'users')`（点击后即时刷新）；
  - 子进程写 templates.json 补 chmod 600（与父进程一致，原子 tmp+rename）；
  - 注册票消费表改 Map+过期清扫（防无界增长）；
  - `enrollVoicePage` 补"切换方法"链接（无麦克风时不困死在采集页），
    face/voice 采集页把全部启用方法传给 altMethods；
  - portal validate() 校验 biometrics 数组/阈值取值；facade
    `biometricEnrollUrl` 未启动时显式报错（不再产出死 URL）；
  - CLI 增 `auth biometric status|disable|enroll-url`（采集需浏览器，
    CLI 只给入口）；
  - 新增 MFCC 黄金测试（§15：正弦/白噪声合成信号，验证 78-d 维度、
    确定性、同源>异频>白噪声的区分度——mean+std MFCC 对噪声敏感是
    已知 FRR 特性，阈值取相对单调性断言）。
- **tunnel 静态响应注入（nginx 网关路径）**：`createServiceTunnels({ inject })` /
  `st.expose(port, { inject })` / CLI `--inject-html <fragment>` [--inject-position
  head|prepend]。浏览器 → 隧道边缘 → nginx 网关 → 应用的流量不经过 node proxy，
  transformResponse 够不着——此选项在网关配置里注入：head 模式 `sub_filter` 在
  `</head>` 前插入；prepend 模式 `add_before_body` 在响应开头直接写（需 nginx
  addition 模块，缺失时 registerHost 报错）。**只作用于 text/html 且仅主页面导航**
  （Sec-Fetch-Mode: navigate / 老客户端无该头；XHR/fetch/子资源不注入，
  X-Requested-With 老式 XHR 同样跳过）——避免把用户后加载的模板片段/文件注坏。
  注入内容经 nginx 双引号串字节转义（任意引号/JS 安全）与静态落盘，不会注入配置。

## [0.3.33] - 2026-08-10

### Fixed
- **portal 登录页/2FA 页适配小屏响应式**：head 补 viewport meta（手机浏览器
  不再按 ~980px 渲染后整体缩小）；表单与忙碌过渡卡片从固定 `width:22rem` 改
  为 `width:100%;max-width:22rem` 流体宽度；全局 `box-sizing:border-box` 防
  padding 撑破；body/overlay 加 1rem 边距，`@media(max-width:480px)` 下压缩
  卡片内边距（2.5rem→1.5rem）。

## [Unreleased]

### Added
- **Bearer token 认证（tunnel API 请求）**：新 provider `token`（gatewayMode
  `"token"`）——请求只需带 `Authorization: Bearer <token>` 即放行，无登录页/无
  Cookie，适合机器客户端（CI、脚本、API 调用）。token 按 site 管理（与 user
  一致）：随机生成（`st_` + 192-bit），库内仅存 SHA-256 哈希，创建时唯一一次
  返回原文；带说明（description）与可选有效期（expiresAt，null = 永不过期），
  过期自动失效并惰性清除。
  - CLI：`auth token list | create [--description <d>] [--expires <ISO|+2h|never>] | revoke <id> [--site <s>]`
  - 库 API：`st.auth.tokenManagers()` / `tokens()` / `createToken()` / `revokeToken()`
  - daemon RPC：`auth.token.managers|list|create|revoke`
  - 校验双通道：决策 API 进程内（嵌入方 rewrite 保留不了 vhost Host，与 basic
    同理）+ nginx `auth_request → /token-authz/auth` 探针（子请求显式转发
    Authorization，401 直返带 `WWW-Authenticate: Bearer`，无 302 登录跳转）。

### Added
- **TOTP 登记支持自定义标识（label）**：`auth totp enroll <name> [--label <l>]`
  与 `st.auth.totpEnroll(name, provider, site, label)` 接受可选 label；缺省为
  `<name>-<auth>-<site>@<host>`（user/auth/site 用 `-` 连接成 account，host
  前保留 `@`；站点/认证各自独立管理用户库，authenticator 中需能区分）。新增
  `auth totp default-label <name>` / `totpDefaultLabel()` 供 UI 登记前预填。
  otpauth URL 的 issuer = label 中最后一个 `@` 之后的部分。

### Added
- **禁止无认证暴露（auth none 开关）**：通过任一入口设为 false 即禁止
  `--auth none` / 开放 proxy 绑定 / tcp 暴露，且任何一层 false 生效
  （安全开关，单次调用 true 不可覆盖）：
  - API 参数：`createServiceTunnels({ allowAuthNone: false })` 或单次
    `st.auth.expose(port, { allowAuthNone: false })`
  - 环境变量：`SERVICE_TUNNELS_ALLOW_AUTH_NONE=0|false|off`
  - 配置/CLI：`config set allow-auth-none false`；`expose` 新增
    `--allow-auth-none <true|false>`
  - 禁止后 `st.auth.providers()` / `auth providers list` 不再返回 `"none"`，
    UI 隐藏 none 选项并提示必须认证，daemon `schemas` RPC 增加
    `authNoneAllowed` 字段；daemon expose 边界 fail-closed 拒绝无认证请求。

## [0.3.28] - 2026-08-07

### Changed
- **i18n 接口改为 i18next 风格**(仍零依赖自实现):
  - `t(key, params?)` — 顶层默认实例(语言由 `setLang(lang)` 管理)
  - `createI18n(initial?)` / `i18n` 默认实例 — `t` / `changeLanguage` /
    `language` / `exists` / `addResources(lang, dict)` / `getFixedT(lang)`
  - `translate(lang, key, params?)` — 显式语言版本(内部/固定语言场景)
  - 原 `t(lang, key, params)` 签名废弃为 `translate`;CLI/daemon UI 内部
    迁移完毕。

## [0.3.27] - 2026-08-07

### Added
- **多语支持(国际化 npm 包,零依赖)**:新增 `src/i18n.ts`(自实现 catalog
  lookup,不引 i18n 库):
  - **数据默认英文**:schema 字段(label/description/placeholder/linkTitle)
    与 CLI/UI 文案默认英文;中文(及未来语言)由语言包覆盖。
  - 语言探测:CLI `--lang <zh|en>` / `LANG`/`LC_ALL`(zh* → 中文);API
    `?lang=` 或 Accept-Language;默认英文。
  - `ParamSpec` 增加 `labelKey`/`descriptionKey`/`placeholderKey`/
    `linkTitleKey`(withSchemaI18nKeys 自动注入,与文案解耦),调用方可按
    id 用自己的 i18n 翻译。
  - CLI usage/提示、daemon 管理面板(ui.ts)全部按语言渲染。
  - 导出:`t` / `resolveLang` / `localizeSpecs` / `localizeSchemas` /
    `withSchemaI18nKeys` / `CATALOG` / `Lang`。

### Changed
- `st.schemas.tunnels()/tunnel()/authProviders()` 与 daemon `schemas` RPC
  接受 `lang` 参数(默认 en)。

## [0.3.26] - 2026-08-07

### Changed
- **ssh host 占位符改为「目标服务器」**：不再是误导性的 localhost，而是提示
  输入目标服务器(必填,无默认值)。

## [0.3.25] - 2026-08-07

### Fixed
- **bore server 字段描述纠正**：自建场景应填「你的服务器 IP:端口」
  （bore 客户端要连的 server 地址），而非误导性的 localhost:7835。

## [0.3.24] - 2026-08-07

### Changed
- **ssh 的 host 不再有误导性 localhost 占位符**：`ssh -R` 转发到本机没有意义，
  host 为必填且无默认值(移除 `placeholder: "localhost"`)，描述改为
  「必填,转发到该服务器公网端口」。

## [0.3.23] - 2026-08-07

### Changed
- **bore 默认 server 改为 bore.pub**：schema `default` 与代码兜底
  `cfg.server ?? SERVICE_TUNNELS_BORE_SERVER ?? "bore.pub"`——公共社区服务器
  免注册即用；自建/离线场景显式填 `localhost:7835` 或用环境变量覆盖。

## [0.3.22] - 2026-08-07

### Fixed
- **natapp 不再标星**：`TUNNEL_META` 移除 `natapp: { favorite: true }`——favorite
  语义是「零账号/少参数/即开即用」(serveo/cloudflared/localtunnel/bore)，natapp
  需 natapp.cn 付费 authtoken，不应出现在推荐首位/带徽标。

## [0.3.21] - 2026-08-07

### Fixed
- **guardian 跨 owner 误杀**：`ensureMarker()` 不再复用环境继承的
  `SERVICE_TUNNELS_MARKER`——泄漏到环境的旧实例 marker 会让所有实例共享同一
  marker，一个实例退出时的 guardian `killRoleProcesses`（按 role+marker 全
  /proc 扫描）会 SIGTERM 掉无关实例刚启动的 helper（oauth2-proxy 侧车等）。
  现在每个进程生成独立 marker，自家子进程仍经 `roleEnv()` 显式继承。

### Tests
- oauth2-proxy / oauth2-gateway e2e 接入 `npm test`（`test/oauth2-proxy.test.mjs`
  + `test/oauth2-gateway.test.mjs`）：mock IdP（`scripts/mock-idp.mjs`，RS256
  OIDC + 回调白名单 + 域名验证模拟）驱动，覆盖侧车直连 / 库集成 mode=proxy /
  nginx 网关完整登录链。外部依赖 oauth2-proxy + nginx 二进制缺失时 t.skip，
  端口全随机（pickFreePort / proxyPort: 0），不触发网络下载。

### Security
- **oauth2 变体秘密字段真掩码**：`clientSecret` 等 password 型字段由配置档携带时
  **不回显明文**（value 不写、schema JSON 不含明文，页面只显示「已由配置档提供」+
  secretSet 标记）——浏览器圆点 + 源码/JS 均不可见；留空提交 = 回落配置档值，
  填写 = 覆盖。自定义变体 token 名含 secret/password（如 `{{clientSecret}}`）
  自动按秘密字段处理。

## [0.3.20] - 2026-08-07

### Added
- **`st auth totp code`** — 不借助手机 app 生成 TOTP 验证码(CLI 内嵌 RFC 6238):
  - `auth totp code <name> [--site <s>] [--provider portal]` — 从用户记录读
    secret(pending 用 totpPending,激活后 totpSecret),打印当前码 + 下一窗口码 + 剩余秒数
  - `auth totp code --secret <b32>` — 任意 base32 secret(otpauth URI 里的也行)
  - 端到端验证:CLI 生成的码被 portal totp-activate 接受;与 pyotp 官方库逐窗口一致。
- **`generateTotpCode()`** 导出(`src/providers/portal.ts`)——同一实现供 CLI/脚本复用。

## [0.3.19] - 2026-08-07

### Added
- **portal 认证策略(one_factor / two_factor / deny)端到端强制**(`src/providers/portal.ts`)：
  per-host 策略经 `registerHost` 写入 hosts-policy.json,脚本按请求读取——
  deny → 403;two_factor → 会话须含 2FA 标记(密码登录后必经 /login/2fa 步)。
- **tools/verify-policy.mjs**:策略验证工具(单因素/双因素/拒绝全部 12 项端到端断言),
  用法 `node tools/verify-policy.mjs`,失败退出码 1。

### Fixed
- **proxy 模式 authz 探测把 403 当 redirect**(`src/proxy.ts`)：deny 策略的 403 被转成
  302 登录页 → 无限跳转。403 → fail closed(直接 403)。
- **verifySession 改对象后 2FA 步骤用对象当 key**(`src/providers/portal.ts`)：`users[name]`
  恒 undefined → 正确 TOTP 也 401。
- **proxy 模式不注册 host 策略**(`src/expose.ts`)：仅 exposeTunnel 调 registerHost,
  proxy/both 的策略文件恒空 → deny/two_factor 不生效。proxy 模式同样注册。
- **deny 策略 portal 启动探测 403**(`src/providers/portal.ts`)：auth-request 先查会话
  (未登录 401)再查 deny(已登录 403)——探测与 deny 语义都正确。
- **auth_request 子请求不转发 Cookie**(`src/gateway.ts`)：gateway 的 authz location
  显式 `proxy_set_header Cookie $http_cookie`,保证 portal 能拿到会话。

## [0.3.18] - 2026-08-06

### Fixed
- **proxy/both 模式缺端口归属校验**(`src/expose.ts`)：verifyPortOwner 只在
  tunnel 模式,proxyExpose 可对任意端口注册 vhost——已补齐。
- **authelia 被 deployBasePath 合并弄坏**(`src/expose.ts` /
  `src/auth-provider.ts` / `src/providers/portal.ts`)：0.3.11 修 portal 合并时
  authelia 的 server.address 变成多段(/dev/autheliaxxx) → config validate
  失败。新增 `nestedBasePath` 能力标记,仅 portal(Node 服务)合并部署前缀,
  authelia 等单段约束 provider 不合并。

## [0.3.17] - 2026-08-06

### Fixed
- **both 模式 exposes 记录缺 vhost URL**(`src/expose.ts`)：both 合并只带 localUrl,
  baseUrl/domainUrl 丢失——暴露详情/活动列表看不到 both 的虚拟主机地址。

## [0.3.16] - 2026-08-06

### Fixed
- **mapServicePath 尾斜杠死循环**(`src/proxy.ts`)：请求路径恰为 deployBasePath 时
  剥前缀得 `/`、拼 serviceBasePath 产生尾斜杠(`/dev/`)→ Next 308 尾斜杠规范化
  与再次映射互相重定向。`p === "/"` 时直接返回 svc,不再加尾斜杠。

## [0.3.15] - 2026-08-06

### Fixed
- **oauth2 变体审核加固**：
  - UI 暴露页预填值（含 clientSecret）JSON 转义 `<` 防 `</script>` 逃逸 +
    属性值 HTML 转义（防引号逃逸注入事件属性）——纵深防御（值来自配置档/环境变量）；
  - 变体内部角色改按变体 id（oauth2-github/...）登记——同 site 多个变体端口
    互不覆盖/互不注销（原统一 "oauth2-proxy" 角色会互相注销）；
  - 自定义声明忽略托管键（http_address/upstreams 恒由 provider 生成）防 TOML
    重复键；`cookie_secure` 允许自定义覆盖默认 false；
  - 内置变体配置键统一 snake_case（oauth2-proxy TOML 约定：`github_org` /
    `gitlab_url` / `azure_tenant`，原 kebab 不生效）；`github_org` 等列表键
    写 TOML 数组。

## [0.3.13] - 2026-08-06

### Added
- **serviceBasePath 转发映射**(`createServiceTunnels` / `ExposeOptions` / `mapServicePath`)：
  外部只传 deployBasePath(URL 前缀,/dev)与 serviceBasePath(真实服务路径),转发时
  库自动剥 deploy 前缀、接服务自身路径——provider 登录路径合并、显示 URL 带部署
  前缀、路径映射全部库内处理,调用方不再自行拼接。

## [0.3.12] - 2026-08-06

### Added
- **OAuth2 变体 provider**（`src/providers/oauth2-variants.ts`，docs/oauth2-variants.md）：
  基于 oauth2-proxy 的声明式 auth provider 变体（`--auth oauth2-github` /
  `oauth2-google` / `oauth2-gitlab` / `oauth2-microsoft` / `oauth2-keycloak` /
  `oauth2-okta` / `oauth2-generic`）——端点/scope/flags 由变体定义携带，凭据由
  配置档 `auth.oauth2`（或旧 `auth.oidc`）携带 → 页面表单字段**默认填入**
  （复用 ParamSpec `default`；不删除、可编辑覆盖，清空某项回落配置档值），
  零输入直点暴露。**环境变量注册自定义变体**（类似 command 隧道）：
  `SERVICE_TUNNELS_OAUTH2_VARIANT_<NAME>="provider=oidc;clientId={{clientId}};..."`
  → 新类型 `oauth2-<name>`；键自动归一化 snake_case TOML（issuerUrl →
  oidc_issuer_url），`{{token}}`/`{{token:default}}` 成为表单参数，列表型键
  （github_org 等）写 TOML 数组。优先级：表单/CLI `--provider-set`
  > 配置档按变体 > 共享 > 旧 oidc > 内置固定/模板默认。变体实例复用 oauth2-proxy 侧车
  （独立 type#site 实例/端口/配置），所有写进 TOML 的值继续过控制字符校验 +
  TOML 转义（防注入）。UI 暴露页 auth 下拉数据驱动（label/已配置徽标/按需参数
  输入）；daemon `/schemas` 新增 `authMetas`；`providerOrder()` 变体按已配置优先。

## [0.3.12] - 2026-08-06

### Fixed
- **basic 认证绕过**( /  / )：
  嵌入方(宿主应用 Next middleware)的 rewrite 无法保留 vhost Host(fetch 规范
  forbidden header),nginx gateway 的 server_name 匹配不到 → 落到默认 server
  → auth_basic 被绕过。basic 改由决策 API 进程内校验(新增 APR1/md5-crypt
  校验),凭证有效直接 pipe 到服务,无效 401。

## [0.3.11] - 2026-08-06

### Changed
- **portal 登录体验优化**（`src/providers/portal.ts`）：loading 过渡完全放在客户端——
  点击 Sign in / Verify 的瞬间立即弹出全屏过渡页（spinner + “Signing in… / Please
  wait”，卡片样式与登录表单一致），提交期间与 302 跳转期间保持显示，直到目标页面
  渲染；登录失败（401 返回登录页）时过渡页随之消失并展示错误。服务端协议不变
  （成功仍是经典 302 到 `next`，curl/API 客户端不受影响）

### Fixed
- **deployBasePath 合并失效**（`src/providers/portal.ts` / `src/authelia.ts` /
  `src/expose.ts`）：portal/authelia 的内置 `#basePath` 默认值非空（`/portal`、
  `/authelia`），导致 `expose.ts` 的 `hasPath` 恒真，嵌入方部署路径（如 `/dev`）
  永远合并不进去——带 basePath 部署时登录重定向丢前缀（`/portal/login` 而非
  `/dev/portal-xxx/login`）。现改为内置默认空串（自描述默认仍在 `defaultBasePath()`），
  basePath 解析链 `??` 改 `||`（空串继续 fall through 到配置/默认），合并后经
  `setBasePath` 生效。**注意**：无显式 basePath 的 portal/authelia 默认登录路径
  从固定 `/portal`、`/authelia` 变为 `defaultBasePath()` 的随机路径
  （`/portal-xxx`、`/authelia<alnum>`），升级后旧登录书签/会话失效

## [0.3.1] - 2026-08-06

### Changed
- 发布包 `files` 补入 `SECURITY.md`（安全敏感工具随包发布安全策略/漏洞报告渠道）

## [0.3.0] - 2026-08-06

### Added
- **隧道配置输入安全验证**（`src/validation.ts`，docs/input-validation-security.md）：
  - ssh/serveo **选项注入封堵**：`host`/`user` 以 `-` 开头（如
    `-oProxyCommand=...`）会在本机执行任意命令——现在一律拒绝
  - **frpc INI 注入封堵**：token/server/domain 含换行/控制字符可注入配置行——
    现在一律拒绝；隧道名路径穿越（`../`）拒绝
  - 端口范围（1–65535）、类型/协议白名单、args/env 空字节校验；
    `TunnelManager.start()` 与 daemon RPC `tunnel.add` 双入口 fail-closed
  - `command` 类型经 daemon RPC 需显式 `dangerous: true` opt-in（CLI 自动携带、
    UI 确认后携带）；`expose --tunnel command` 同样受该门保护
  - **ngrok token 接线修复**：`tunnel add --type ngrok --token x` 的 token
    现注入 `NGROK_AUTHTOKEN` env（此前 schema 声明注入但实际丢弃 → ERR_NGROK_4018）
- **UI 服务器 CSRF 防护**（`src/ui.ts`）：所有 POST 要求同源 Origin +
  页面注入的 32B CSRF token（`X-CSRF-Token`，`timingSafeEqual` 比对）；移除
  `Access-Control-Allow-Origin: *`——恶意网页无法再通过简单请求向
  `127.0.0.1:4181` 注入 `command` 隧道 / 改密码
- **Windows daemon IPC 鉴权**（`src/daemon-server.ts`/`src/daemon.ts`）：TCP IPC
  改为随机 32B secret（存 state.json，0600）请求头校验；`requestDaemon` 补
  TCP 分支（此前 Windows CLI 连不上 daemon）；鉴权失败记审计日志。新增
  跨平台模拟测试验证 secret 头往返
- daemon `expose` RPC 边界补齐：辅助端口（proxyPort/nginxPort/autheliaPort/
  redisPort，0=自动放行）与 `baseDomain` 校验
- **自定义命令隧道协同**（`SERVICE_TUNNELS_TUNNEL_COMMAND_*`）：`validateTunnelConfig`
  接受自定义类型，且对其**模板参数做全字段控制字符扫描**（参数会被插值进 shell
  命令，换行等控制字符可改写命令结构）
- **auth provider 参数验证**（`src/validation.ts` 新增 `validateUserName`/`validateOidcOptions`/`tomlEscape`/`yamlEscape`）：
  - 用户名统一字符集门（YAML 键 / htpasswd 行 / totp 导出文件名的根修复）——
    authelia/basic/portal 的 UserManager + daemon IPC 双入口 fail-closed
  - oauth2-proxy OIDC 参数校验（issuerUrl 必须 http(s) URL、secret 拒控制字符）+ 写入 TOML 前转义（TOML 注入同 frpc INI 类）
  - authelia users_database.yml displayName/email YAML 转义
  - `autheliaReloadCmd`（`registerHost` 时 `shell:true` 执行的命令）禁止经 IPC 传入（仅库/配置）
- `startUi` 返回实际监听端口（`port: 0` → 随机端口时可测）；`UiServer`
  暴露 `port`
- **UI 添加隧道表单改 schema 驱动**：按 `TUNNEL_PARAM_SCHEMAS` 渲染各类型参数
  （token/domain/host/server…，密码框/数字框/选项），修复校验引入后 UI 无法添加
  ssh 等需要额外参数的隧道；`/api/tunnels/add` 前置校验并透出拒绝原因（此前
  daemon 拒绝会被静默吞掉，UI 假报"添加成功"）
- **隧道类型 `dangerous` 标记**（`TunnelMeta.dangerous`）：`command`（唯一经 shell
  执行的类型）标为 `dangerous: true`——schema 驱动的客户端据此把危险选项移出一键
  表单；用户显式 env 注册的自定义类型不标记（注册即 opt-in）
- **自定义命令隧道完整机制**（`src/tunnels-custom.ts`，`SERVICE_TUNNELS_TUNNEL_COMMAND_<NAME>`）：
  - env 注册 → 隧道类型自动出现在所有 schema 驱动客户端（表单/下拉框）；内置名
    冲突/非法名/空模板跳过并告警
  - 模板 `{{token}}` 占位符即表单参数：`{{port}}` 必填、`{{port:8080}}` 固定默认、
    `{{localport}}` 自动填被暴露本地端口（`{{localport:PORT}}` 固定覆盖）；大小写不敏感
  - 自定义类型假定 tcp 支持（`tunnelTcpSupport` 含之）；URL 输出解析与 `command` 同款
- **自定义隧道注入防护**（`resolveCustomCommand` + `validateTunnelConfig` 双入口）：
  占位符值（表单/`--set`/默认值）一律**单引号转义**注入 shell（`'`→`'\''`，值只作
  字面量——空格/`$`/反引号/`;`/`|`/`&` 全部惰性化）；控制字符（含换行/NUL）fail-closed 拒绝
- **`ST_TUNNEL_URL` URL 声明标记**：自定义/`command` 隧道输出 `ST_TUNNEL_URL:<url>`
  （`=`/空格分隔、引号/CRLF 容忍、大小写不敏感）即显式声明隧道 URL（优先于输出解析；
  无 scheme 的 `host:port` 补 `http://`；`tcp://` 原样）；Windows cmd/PowerShell 可用
  （`echo ST_TUNNEL_URL:http://...`）；进程非零退出撤销该 URL（不报假成功）

### Changed
- **进程内虚拟主机决策 API**：`st.proxy.resolve()` / `resolveServiceHost()`，
  返回 `ServiceHostDecision`（`forward` / `pipe` / `redirect` / `deny` /
  `deny-auth`）——嵌入方（如宿主应用）可在自己的 HTTP 中间件里直接做 vhost
  路由/认证决策，无需请求到达 proxy 端口（`examples/host-integration.ts`
  已更新：**中间件即网关**）
- `expose --startTransport false`：跳过 proxy 传输层启动（由嵌入方中间件
  接管 vhost 服务），`localUrl` 相应为空
- `sts` 短别名：`npm install -g service-tunnels` 同时安装 `sts` 命令，与
  `service-tunnels` 完全等价（`st` 别名因与 npm 月下载 130 万的 `st`
  静态服务器包冲突而弃用）
- **D4 决策重构**：vhost 路由 / enrollment / 认证判定收敛为单一实现
  （`resolveServiceHost`），HTTP 传输层（`createProxyServer` 含 WebSocket
  upgrade 路径）与嵌入方中间件共用同一套决策逻辑，行为严格一致
- `ProxyManager` 暴露 `resolve()` / `parseHost()`（嵌入方经
  `st.proxy.resolve` / `st.proxy.parseHost` 使用）
- `engines` 降为 `>=20.19.0`（原 `>=22.19.0`）：生产包 dist 实测支持
  Node 18/20（导入/CLI/fetch 全通），开发模式直跑 `src/*.ts` 仍需
  Node 22.18+（默认类型剥离）或 `tsx`
- 清理注释中的内部部署引用（内部私有域名、真实部署端口 → 通用示例）
- 测试扩充：决策 API 全路径（forward/pipe/redirect/deny）+ WebSocket
  upgrade 场景下 forward-auth 门禁（无 cookie 401、有效 cookie 101）

### Dependencies
- `justget` ^0.1.1 → ^0.1.6：镜像竞速下载对 4xx/5xx/超时立即切换镜像源

## [0.2.42] - 2026-08-05

> 自 0.2.37 以来的全部功能随本版本首次发布（git 历史中的 0.2.38–0.2.41
> 版本号未出现在 registry，合并计入本版本）。

### Added
- **Sites（认证域隔离）体系**：每个 site 一套独立 provider 实例 + 用户库 +
  basePath + session secret + policy（`st.sites` / `site` 子命令），互不
  共享配置和用户；`default` site 保证向后兼容（`--site` 缺省作用域）
- **proxy 暴露模式**：`expose --mode tunnel|proxy|both` 与
  `--auth none|auto|<provider>` 正交组合；proxy 模式无隧道进程、本地虚拟
  主机直达（`5173-portal.st.localhost`），both 模式本地 + 公网共享同一 site
- **D4 零转发**：proxy 默认不转发任何端口——虚拟主机必须显式 enrollment
  （`expose --mode proxy/both` 注册 binding），未 enroll 一律 403
- **baseDomain**：`SERVICE_TUNNELS_BASE_DOMAIN` 环境变量 + API 统一解析
  （opts > env > config）；多 baseDomains；`host:port` 形式（虚拟主机解析
  用 host，生成 URL 保留端口）
- **deployBasePath 合并**：嵌入方部署前缀与 provider basePath 合并
  （如 `/dev/portal/login`）；portal 登录默认重定向跟随部署前缀
- 会话 cookie 名按 site 隔离（嵌套 proxy 不冲突）
- `.localhost` 后缀族：`st.localhost` / `service-tunnel.localhost` /
  `localhost`

### Changed
- provider 不再隐含新建站点：`--auth <provider>`（不带 `--site`）作用于
  default 站用户库，登录打通（修复多 provider 用户库分裂）
- proxy 暴露记录 `running=true`（binding 在即运行）；`tunnel stop` 可移除
  proxy binding

## [0.2.37] - 2026-08-05

### Changed
- **justget 竞速下载器**：官方源 + 镜像并行拉取，失败立即切换（immediate-failure
  mirror takeover）
- **内置 Gitee 镜像**：全部二进制工具（ngrok/frpc/cloudflared/authelia/bore/
  oauth2-proxy）官方优先、镜像回退，无需额外配置

### Fixed
- ssh 隧道测试（fake ssh 路径）

## [0.2.0] - 2026-08-04

> 0.2.0 – 0.2.36 版本线（0.1.x 迭代完成后的功能完整期）。

### Added
- **M1–M6 基础能力线**（0.1.x 期间完成，随 0.2 线正式化）：
  - M1 包骨架 + XDG 目录解析 + daemon（常驻 / socket IPC / state.json）
    + discover（进程树发现 / 角色标记排除 / internal 注册表过滤）
  - M2 泛域名反向代理（白名单 / SSE / WebSocket / stripBasePath /
    Basic 密码）
  - M3 隧道管理（类型感知 / 工具解析 / 输出缓冲 / URL 解析）
  - M4 认证编排（AuthProvider 接口 + nginx 网关 + authelia 绿色启动 /
    动态登记 + redis + `expose --auth`）
  - M5 生命周期清理 + 安全加固 + 宿主应用集成示例
  - M6 插件化 provider（basic + oauth2-proxy + 边缘扩展点）
- **portal provider**：Windows 无 Authelia 二进制的绿色替代——纯 Node
  forward-auth 登录门户，与 authelia 同协议（`{basePath}/api/authz/
  auth-request`）
- **portal 安全基线**：scrypt 口令哈希 + HMAC 签名会话 cookie
  （timingSafeEqual）、登录防爆破（账号 + IP + 指数封禁 + 持久化）、
  TOTP 2FA 管理、RSA-OAEP 前端加密（密码明文不出浏览器）、无 JS /
  无 WebCrypto 降级提示
- **用户管理抽象**（UserManager）：basic htpasswd / authelia 用户库统一
  API（list/add/set-password/remove），`provider`/`all` 维度；authelia
  用户管理暴露 CLI/API/库接口
- **工具下载跨平台**：Windows zip 包 / `{ext}` / `{exe}` 模板 / 魔数探测
  解压 / `.exe` 匹配；arch 别名（x64→amd64）；toolMirrors 配置
- basePath 可配置（配置文件 + CLI `--base-path`）+ 随机趣味名
  （`{provider}-{adj}-{animal}`）+ authelia 动态验证
- **guardian 守护进程**：父进程异常退出时清理框架辅助进程（跨平台轮询 +
  实例标记精确清理）
- **国内镜像方案**：Gitee 完整模板 + 同步脚本 + 文档（`scripts/mirror-to-gitee.sh`）
- 宿主应用集成：包内含 src（宿主构建链可直接转译）+ 同步脚本；`st.auth.expose`
  接口签名修正（Omit port）

## [0.1.0] - 2026-08-04

- 初始版本线（0.1.0 – 0.1.22）：包骨架、目录解析、工具自动下载
  （PATH > 缓存 > 官方 > 镜像）、daemon、discover 的早期迭代
