# STUN 打洞（stun portmap 后端）分析与设计

> 状态：**设计稿（源码考古完成，实现前定稿）**。
> 关联：`portmap-analysis.md`（UPnP/PCP/ssh-router 三后端已成，本文新增第 4 后端）、
> `netcheck-design.md`（NAT 类型探测复用为本设计的探测原语）、
> `ddns-integration.md`（地址漂移联动的信标机制已有）。
> 参照项目：**ZluxYao/LinkStar**（GPL-3.0，github.com/ZluxYao/LinkStar）——**只考古其实现思路，
> 不拷贝任何代码**（见 §1 license 边界）；STUN/RFC 5780 是公开标准协议，协议行为不受版权保护。

---

## 0. 一句话结论

把 LinkStar 的核心能力「**STUN 端口复用打洞**」作为 `expose --mode portmap` 的**第 4 个后端**
（`stun`，与 upnp/pcp/ssh-router 并列）：无需路由器 UPnP/NAT-PMP 权限、无需真实公网 IP，
在锥型 NAT（NAT1/NAT2/NAT3）后面也能打出 `公网IP:端口` 直连洞；打出来的洞按 portmap
现有语义**指向本机 proxy transport**——认证门禁照常生效，比 LinkStar 的裸转发更安全。
配套：`probe` 增加 RFC 5780 NAT 类型检测（UDP/TCP 分开），CGNAT 不再一票否决，
auto 策略升级为 `upnp → pcp → stun → ssh-router`；保活挂 daemon（25s 心跳 + 端口漂移
fail-fast 重打 + DDNS/信标联动闭环）；出口物理网卡识别（绕 Clash/sing-box TUN）作为
公共探测原语供 portmap / ddns / doctor 共用。

---

## 1. 为什么值得做 + license 边界

### 1.1 service-tunnels portmap 的盲区

现有三后端全部依赖「**路由器可控**」：UPnP/NAT-PMP 要网关开放协议，ssh-router 要设备
SSH 凭据。真实家宽的常见困境全都覆盖不到：

| 场景 | 现状 |
|---|---|
| 光猫路由模式，路由器密码不可得 | UPnP/PCP 探测失败 → 不可用 |
| 运营商大内网（CGNAT，RFC 6598） | `portmap/index.ts` 直接拒绝："external IP is CGNAT … use a tunnel provider" |
| 家宽真实公网 IP（不在 100.64/10 段）但 NAT 行为是锥型 | 只要路由器不配合就不可用——**其实 STUN 打洞完全能通** |

LinkStar 的答案：STUN Binding 探测 NAT 出口映射 + 本地端口复用保持映射 → 外部直接访问
探测到的 `publicIP:publicPort`。**不需要路由器任何配合**，覆盖上面全部三类场景
（对称 NAT4 除外，这是协议层限制）。

### 1.2 license 边界（重要）

LinkStar 是 **GPL-3.0**，本包是 **MIT**：

- ❌ 不拷贝/翻译其源码（任何形式的代码移植都会触发 GPL 传染）；
- ❌ 不子进程集成其 Go 二进制（GPL 边界争议 + 平台负担）；
- ✅ **只做协议实现**：STUN（RFC 5389/8489 Binding + XOR-MAPPED-ADDRESS + CHANGE-REQUEST）、
  RFC 5780 探测流程、SO_REUSEPORT 端口复用语义，全部是公开标准与操作系统行为；
  保活周期、退避步长、状态机形态等「工程参数」用我们自己的值（不必与其一致）。
- 实现语言不同（Go → TS 零依赖手写），天然规避实质相似（substantial similarity）问题；
  本文档的「考古」部分只描述行为观察，不携带其代码文本。

### 1.3 与 LinkStar 的架构差异（我们的落点更安全）

LinkStar 打出的洞直接转发到 `targetIP:internalPort`（洞口可选 TLS 终结），被穿透服务
自身认证自己兜底。service-tunnels 的架构原则是「**认证统一在本地端口侧**」：portmap
后端拿到映射后把外部端口指向**本机 proxy transport**（同 upnp/pcp 后端），enrollment
与 auth 门禁不变。因此 stun 后端**只做打洞与保活，不做 TLS 终结/转发**——那一层
proxy 已经有了。LinkStar 的洞口 TLS 终结 + 明文 302 引导这些细节仅作参考，
不引入（proxy 的 TLS 语义归 gateway/nginx 设计）。

---

## 2. 协议盘点

### 2.1 STUN Binding（RFC 5389/8489）

- 客户端发 Binding Request（36 字节：20 字节 header + 事务 ID），服务器回
  Binding Response 带 **XOR-MAPPED-ADDRESS**（NAT 出口 `IP:port`）。
- NAT 设备对「同一本地 socket」发出的流量保持同一出口映射——**这是端口复用打洞的协议基础**：
  STUN 会话与业务流量共用一个本地 socket，映射就只有一个。
- 保活 = 周期性 Binding Request（顺带读回最新映射，兼做漂移检测）。

### 2.2 RFC 5780 NAT 行为探测（需要双 IP 双端口 STUN 服务器）

**Mapping 行为**（§4.3，UDP 与 TCP 同思路）：

| Test | 目标 | 结论 |
|---|---|---|
| I | 主地址（IP₁:P₁） | 基准映射 m1 |
| II | 备 IP + 主端口（IP₂:P₁） | m2 == m1 → **EIM**（endpoint-independent，锥型） |
| III | 备 IP + 备端口（IP₂:P₂） | m3 == m2 → **ADM**；否则 **APDM**（对称） |

**Filtering 行为**（§4.4，仅 UDP——CHANGE-REQUEST 依赖服务器从不同源地址回包，
TCP 面向连接做不到）：在已向主地址发过请求的同一 socket 上，发 CHANGE-REQUEST
要求「换 IP+换端口」→ 有回包 = **EIF**（NAT1）；超时后再试「只换端口」→ 有回包 =
**ADF**（NAT2）；仍超时 = **APDF**（NAT3）。Filtering 测试用**独立 socket**，
避免 Mapping 测试访问过备用地址后污染过滤状态。

**分类表**（结合 localIP == publicIP 判公网直连）：

| Mapping | Filtering (UDP) | 类型 | STUN 打洞可行性 |
|---|---|---|---|
| EIM | EIF | NAT1 完全圆锥 | ✅ 最佳 |
| EIM | ADF | NAT2 受限圆锥 | ✅（外部先连后，回包可达） |
| EIM | APDF | NAT3 端口受限 | ✅ 可用（入站新连接可能被限，需实测；保活方向恒通） |
| ADM / APDM | — | NAT4 对称 | ❌ 放弃（每次目标不同映射都变，探测端口无意义） |
| 探测全失败 | — | Blocked | ❌（UDP/TCP 被运营商拦） |

TCP：EIM 时无法区分圆锥子类，按最保守 NAT3 处理；公网直连（localIP==publicIP）
直接 OpenInternet。

### 2.3 UDP 与 TCP 打洞的不对称性（Node 实现的关键约束）

| | UDP | TCP |
|---|---|---|
| socket 身份 | **同一 socket 可先 connect（STUN）后 disconnect（收任意远端包）**——单 socket 双职，无需 REUSEPORT | client socket 与 listen socket 必然是两个 fd |
| 端口复用手段 | `dgram.bind(port)` + `connect()`/`disconnect()` 切换 | `net.Server.listen({ port, reusePort: true })`（SO_REUSEPORT，Node ≥20.9，本机 v24 ✓） |
| 入站分发语义 | Linux 对 connect 过的 socket 精确匹配优先，STUN 响应必达；disconnect 后同 socket 收任意入站 | 新连接按四元组哈希进 reusePort listener 组；已建立的 STUN 连接不受影响 |
| NAT 侧可行性 | 映射天然双向可用 | 需要 NAT 对「由本地端口发起的 TCP」允许入站 SYN（锥型 NAT 下成立；部分 NAT 会把入站 SYN 当新映射 → TCP 打洞成功率低于 UDP） |

> UDP「单 socket connect/disconnect」是我们相对 LinkStar 的实现简化：LinkStar 用
> go-reuseport 开两个 socket（client + ListenPacket）共享端口，依赖 Linux UDP lookup
> 的 connected-socket 优先语义；单 socket 方案语义完全确定、零平台依赖。

### 2.4 STUN 服务器需求

- 普通打洞/保活：任意公共 STUN 服务器（Google `stun.l.google.com:19302`、Cloudflare
  `stun.cloudflare.com:3478` 等，UDP 为主；TCP STUN 支持面窄，需按服务器探测）。
- RFC 5780 探测：需要**双 IPv4 + 每 IP 两端口**的 5780 兼容服务器（公网可用清单见
  BEHAVE 资料与 stunserver.org 等；服务器不可用 ⇒ NAT 类型 Unknown ⇒ stun 后端
  拒绝启动并在 doctor 里如实报告，绝不猜）。
- 服务器列表做成配置项（`portmap.stun.servers`），内置默认 + 用户可加自建
  coturn（自建最稳，地址写进配置即可，符合「探针可自建」的 doctor 设计支柱）。

---

## 3. LinkStar 行为考古（只记观察，不抄实现）

> 目的：确认「哪些坑别人已经踩过、哪些参数量级合理」，实现时用自己的结构重写。

1. **打洞流程**：选服务器（主→备回退）→ 从**出口网卡本地 IP** 发起端口复用连接 →
   Binding 拿出口映射 → **同端口开入站监听** → TCP 可选叠加 UPnP（同端口映射，
   UDP 不叠加）→ 保活与转发并行。洞口转发支持 TLS 终结（证书热替换不断连接），
   明文 HTTP 误打 TLS 洞时回 302 引导而非静默断开。
2. **保活 = fail-fast**：约 25s 周期；TCP 用「从公网侧直连自己的公网 IP:端口」梯度检查
   （3s 超时 × 1/3/5s 三轮），UDP 用 Binding 查端口；**公网端口一旦变化立即放弃该洞**
   （不做换端口自救），交上层重打。STUN 连接本身断了则换服务器、**同本地端口**重连，
   重连后端口必须一致否则同样放弃。
3. **UPnP 叠加保活**：双 ticker——短周期查映射存在性（丢了重建）+ 长周期无条件续约
   （量级：分钟级 + 小时级）。与 portmap 现有半衰期续租思想一致，可复用其实现。
4. **状态机与重试**：Probing → Running ↔ Restarting → Stopped/Failed 两段式——
   **从未成功过**的探针有次数上限（个位数、短退避），到顶进终态 Failed（避免对注定
   不通的网络无限尝试）；**曾经成功过**的无限退避重启（1s→3s→5s→10s→1min 封顶）。
   每次重打成功才推地址联动（webhook / 固定入口 / 游戏记录），端口漂移时先把旧地址
   标记过期再推新状态，防止消费方拿到脏地址。
5. **NAT 探测**：UDP 严格双维度（Mapping + Filtering），TCP 只测 Mapping；
   对称 → 判死；公网直连单独识别。探测 socket 全部钉在物理出口网卡上——
   开着代理 TUN 时若不钉，测到的是代理侧 NAT，结论全错。
6. **绕代理 TUN 的出口网卡识别**（Linux）：候选 = **主路由表**默认路由接口 −
   隧道型网卡名（tun/tap/wg/…），跃点数小者优先。原理：sing-box / Clash 的
   auto_route 是「另开一张路由表 + ip rule 引流」，主表默认路由仍是物理网卡，
   只读主表天然绕开；SO_BINDTODEVICE 钉网卡在无 CAP_NET_RAW 时静默降级。
   另有 TTL 递增 + IP_RECVERR 读 ICMP 的免费 traceroute（不依赖系统命令、免 root），
   用于展示 NAT 链层级。
7. **多设备模型**：一个打洞实例可把洞转发给**任意内网设备**的服务（服务配置带
   targetIP）。我们暂不引入——portmap 现有语义只映射本机 proxy transport，
   「穿透其他内网机」等有真实需求再立项（proxy 站点目标本来就是任意 host:port，
   已间接覆盖）。

---

## 4. 接入设计

### 4.1 新后端：`StunBackend`（src/portmap/stun.ts）

与 `UpnpBackend` / `NatPmpBackend` / `SshRouterBackend` 同接口（`PortmapAddRequest` →
`PortmapMapping`），注册进 `pickBackend`：

```
auto 策略升级：probe.upnp.ok → upnp
             probe.pcp.ok → pcp
             probe.nat?.punchable（EIM 且非公网直连）→ stun   ← 新增
             显式 method="ssh-router" → ssh-router
```

- **probe 扩展**：`PortmapProbe` 增加 `nat` 通道（RFC 5780，UDP+TCP 各一份
  `{ mapping, filtering, natType, punchable, error }`）。探测耗时可控
  （每 Test 3s 超时、全序列 ≈8–12s），按 probe 缓存惯例（G6）缓存。
- **语义修正（F3 的延续）**：CGNAT 不再一票否决。`classifyExternalIp` 结果只是
  分类信息；stun 后端以 **NAT 类型**为唯一启动判据——CGNAT 前置了锥型 NAT 时照样
  尝试打洞，实测不通再如实失败。upnp/pcp 后端保留 CGNAT 拒绝（映射确实无法被
  公网路由），错误文案改为提示「可尝试 --portmap-method stun」。
- **映射语义不变**：`ensureMapping` 返回的 `PortmapMapping.externalPort` →
  本机 proxy transport， firewall 放行、半衰期续租语义由 portmap 上层统一处理；
  stun 后端自己的保活只负责「NAT 映射存活」，与 UPnP 租约续租同一层级。

### 4.2 保活与漂移联动（daemon 内，src/portmap/stun-keepalive.ts）

- **25s 心跳**（可配）：UDP = Binding 查端口；TCP = 本地直连 `publicIP:publicPort`
  梯度探测（3s 超时，1/3/5s 三轮）。⚠ 这不是轮询逻辑——NAT 映射是**必须周期性
  发包才会存续**的协议状态（keepalive 即业务语义），与「为刷新 UI 而拉取」有本质区别。
- **端口漂移 = fail-fast**：心跳发现端口变化 → 判洞失效 → 走**重打流程**
  （重新 ensureMapping，拿新外部端口）→ 成功后触发既有联动链：
  `ddns` 信标 entries（followTunnel / txt）自动刷新 + `st.portmap` 状态事件推送 UI。
  重打沿用 LinkStar 验证过的两段式：从未成功 ≤5 次（1s×4）→ Failed 终态；
  曾经成功无限退避 1s→3s→5s→10s→1min 封顶（步长是我们自己的值，量级参考）。
- 复用约束：**重打必须复用同一本地端口**（stun socket 钉死 localPort）——
  NAT 对同一本地端口的映射最稳定，换端口=放弃已有映射从零赌。
- 与 daemon 生命周期绑定：daemon stop / `stop-all` 时关闭 socket（NAT 映射自然
  老化回收，无死规则——比 UPnP 租约更干净）。

### 4.3 出口网卡识别（src/net-egress.ts，公共原语）

从本设计中抽出为独立模块（portmap / ddns `ip` 探测 / doctor 三方共用）：

- `pickEgressIface()`：读主路由表（Linux `/proc/net/route`，mac `route -n monitor`
  一次性快照，win `route print` 解析）默认路由接口 − 隧道名模式
  （`tun|tap|wg|utun|ppp|ipsec|…`）→ 按跃点数排序；
- `dialWithEgress()`：socket 绑出口网卡本地 IP（bind address 级别，跨平台安全；
  SO_BINDTODEVICE 级别的强钉不引入——需要特权且 bind-IP 已足够 TUN 场景）；
- `ddns ip` / probe 的公网 IP 查询改走 `dialWithEgress`（开着 Clash TUN 不再拿到
  代理出口 IP；跟随系统行为保留 `--egress system` 逃生门，默认 auto）。

### 4.4 doctor 集成

- 新探测项：`natType`（UDP/TCP 各一行，NAT1~NAT4/Blocked/Unknown + punchable 判定
  + 人话理由）、`egress`（出口网卡是否被 TUN 劫持）。
- 建议联动：`punchable && !probe.upnp.ok` → Top 建议直接给
  `sts expose <port> --mode portmap --portmap-method stun`（带一键命令）；
  `Symmetric` → 明确告知走 tunnel provider（协议层无解，不误导用户尝试）。

### 4.5 安全语义（不变式）

- 洞永远指向 proxy transport，enrollment 门禁、auth provider、`allow-auth-none`
  语义全部不变——**stun 后端没有直通内网端口的模式**（与 LinkStar 的差异点，
  也是我们不引入其 TLS 终结/转发层的原因）。
- D4 零转发：未 enroll 的虚拟主机依旧 403；打洞成功 ≠ 服务可匿名访问。
- 打出的地址写进 `st.portmap list` 输出与 UI，含协议/NAT 类型/保活状态，
  让「公网暴露面」始终可见、可 stop。

---

## 5. 实现要点与平台坑

1. **UDP 单 socket 双职**（§2.3）：`dgram.createSocket` → `bind(localPort)` →
   `connect(stunServer)` 发 Binding 收响应 → `disconnect()` 转任意远端收包；
   每次保活再临时 connect/disconnect。Node `dgram` 的 connect 在 v12+ 可用。
   ⚠ 保活期间与业务入站包有短暂窗口竞争（connect 状态下非 STUN 源的包被内核丢弃）：
   UDP 业务是 30s 会话级容错，可接受；若实测有损，降级为「双 socket + SO_REUSEADDR
   连接语义」或仅对 TCP 业务提供 keepalive 期间暂停窗口。
2. **TCP reusePort**：`net.Server.listen({ port, host, reusePort: true })` 要求
   Node ≥20.9；`package.json` engines 已要求新版本即可。listener 与 stun client
   连接共存时，内核对**已建立连接**的入站段精确匹配，新连接进 listener——语义成立。
   ⚠ Windows 无 SO_REUSEPORT：TCP stun 后端在 win 上降级为「STUN-over-TCP 探测 +
   独立 listener（端口复用仅 UDP 保证）」，或直接仅支持 UDP（P1 范围内 TCP 仅限
   Linux/macOS，文档与 `--portmap-method stun` 错误信息写明）。
3. **STUN 编解码自写**（零运行时依赖红线）：Binding Request/Response、
   XOR-MAPPED-ADDRESS、CHANGE-REQUEST、ERROR-CODE、FINGERPRINT（可选校验），
   预估 ~200 行（`src/portmap/stun-wire.ts`），不引 npm stun 包。
4. **hairpin（回流）**：部分 NAT 不支持内部主机访问自己的公网映射（心跳从本机直连
   `publicIP:port` 会失败）。TCP 心跳失败不立即判死——先与 UDP 保活/外部探针
   （doctor 的回连通道）交叉确认，避免 hairpin 误杀。LinkStar 用「直连自己」做心跳
   未处理 hairpin，是我们明确的改进点。
5. **STUN-over-TCP 服务器稀缺**：TCP Binding 支持面远小于 UDP；`stun` 后端的 TCP
   模式需要配置里显式给出支持 TCP 的服务器，探测阶段即验证（服务器不支持 →
   该协议族报 `StunUnsupported`，不影响 UDP 侧）。
6. **IPv6 不适用**：本设计仅 IPv4。IPv6 场景走既有 `ipv6` mode（全球单播直连，
   无 NAT）。

---

## 6. 落地计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** 探测层 | `stun-wire.ts` 编解码 + `probe.nat` RFC 5780（UDP 全维度 / TCP Mapping）+ `net-egress.ts` 出口网卡识别 + CGNAT 语义修正 | doctor 能出 NAT 类型与人话结论；开着 Clash TUN 时 `sts ddns ip` 拿到真实出口 IP |
| **P2** 打洞后端 | `StunBackend`（UDP 优先，TCP Linux/macOS）+ daemon keepalive + 漂移重打 + ddns 信标联动 + `--portmap-method stun` | 真机（家宽锥型 NAT）外部连通性实测通过（沿用 ST_TESTSERVER 门控测试模式）；`stop-all` 无残留 |
| **P3** 打磨 | hairpin 交叉确认、doctor 建议联动、UPnP+STUN 叠加策略（UPnP 可用时同端口映射提高入站成功率）、多 NAT 链（光猫+路由器双层）容错 | 双层 NAT 环境实测；Symmetric 场景给 tunnel 建议而非空转 |

测试策略：wire 编解码单测（golden bytes）；NAT 分类纯函数单测（构造
mapping/filtering 组合）；打洞真机测试用 `ST_TESTSERVER` 门控（同 portmap 先例），
环境缺失自动 skip——CI 上不依赖真实 NAT。

---

## 7. 风险与限制

- **对称 NAT（NAT4）无解**：协议层限制，doctor 与错误文案如实告知，引导 tunnel provider。
- **运营商 QoS/封堵**：部分家宽对高位端口入站 SYN/UDP 静默丢包——打洞成功 ≠ 可达，
  P2 验收必须含外部连通性实测（复用 doctor 回连通道做交叉验证）。
- **端口漂移是常态**：家宽重启光猫、NAT 老化都会换端口；固定入口靠 ddns 信标 +
  portmap 状态事件闭环（P2），对人类分享场景建议 tunnel provider。
- **UDP 心跳窗口**（§5.1）：保活瞬间非 STUN 入站包会被内核丢弃，UDP 业务需容忍
  秒级抖动；实测有损再优化。
- **双 NAT 链**（光猫→路由器）：两层都是锥型才可打洞；RFC 5780 探测看到的是全链
  复合行为，恰好正确处理（复合对称 = 判死，复合锥型 = 可打）。
