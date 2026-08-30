# 动态端口穿透（router portmap）分析与设计

> 状态：**P1/P2/P3 核心全部实现并真机验证**（src/portmap/：probe 双通道 + upnp/pcp/ssh-router
> 三后端 + 半衰期续租；expose mode="portmap" 闭环 + st.portmap API + CLI probe/list/stop
> + --portmap-set；daemon RPC portmap.probe/list/stop + IPC 边界校验；**本机防火墙自动
> 放行 ufw/firewalld/iptables**——见 §3.10）；**Review 修复完成**（F1 IP 直连、F2 失败
> 回滚、F3 CGNAT 二次检查、F4 localPort 映射、M1-M5 健壮性——详见
> [portmap-review.md](portmap-review.md)）；**外部连通性实测通过**（ST_TESTSERVER 门控
> 测试，真实路由器 + 公网主机全链路）；测试 14/14 + external 1 过，全量套件 230/233
> （guardian 1 例为并行会话既有问题）。
> 回答三个问题：**有没有协议支持？怎么探测？怎么接进现有 expose 模型？**

---

## 0. 一句话结论

有协议支持，而且是成熟的标准协议族：**UPnP IGD**（最普及）、
**NAT-PMP / PCP**（苹果系/新标准，同一端口 5351）。OpenWrt 装 `miniupnpd`
即同时支持三者；不支持 UPnP 的路由器可用 **SSH 到路由器改防火墙规则**
（OpenWrt iptables / MikroTik RouterOS）作为第二梯队后端。已作为 expose 的
第三种 mode：`portmap`，**三个后端全部实现并真机验证**（自动探测优先 UPnP，
回退 NAT-PMP/PCP，显式可选 ssh-router）。

---

## 1. 协议盘点

### 1.1 UPnP IGD (Internet Gateway Device)

业界事实标准，家庭路由器支持率最高。

| 项 | 说明 |
|---|---|
| 发现 | SSDP：向 `239.255.255.250:1900` 组播 M-SEARCH，搜 `urn:schemas-upnp-org:device:InternetGatewayDevice:1`(v2 用 `:2`)；网关回应 device description XML 的 URL |
| 定位服务 | 解析 XML → 找 `WANIPConnection` 或 `WANPPPConnection` 服务 → 得到 controlURL |
| 加映射 | SOAP POST `AddPortMapping(NewExternalPort, NewProtocol(tcp/udp), NewInternalPort, NewInternalClient, NewEnabled=1, NewPortMappingDescription, NewLeaseDuration)` |
| 查询 | `GetExternalIPAddress` / `GetSpecificPortMappingEntry` / `GetGenericPortMappingEntry`(枚举) |
| 删除 | `DeletePortMapping` |
| 租约 | IGD v2 支持 `LeaseDuration`（秒）；v1 只认 0=永久。**务必申请有限租约 + 周期续租**，避免进程死后留死规则 |
| 坑 | 部分路由器 UPnP 默认关闭；有的只允许映射到请求方 IP（会拒绝转发到别的内网机）；SOAP 响应格式参差，错误码要宽容解析 |

### 1.2 NAT-PMP (RFC 6886) 与 PCP (RFC 6887)

- 同一 UDP 端口 **5351**；PCP 是 NAT-PMP 的超集（NAT-PMP 探测成功即可用 PCP 客户端）。
- 报文是简单二进制（非 SOAP），实现极小。
- `MAP` 操作：请求外部端口映射，lifetime 上限通常 7200s → 必须做续租循环（约 lifetime/2 续一次）。
- 支持 `thirdPartyPort`（PCP）但绝大多数家用 NAT 会拒绝，按"只能映射自己 IP"设计。
- 苹果 Airport、很多 ISP 光猫桥接后的软路由、systemd-networkd? （不）、OpenWrt miniupnpd 同时开 NAT-PMP+PCP。

### 1.3 无标准协议的路由器：SSH 后端

对不跑 UPnP/NAT-PMP 的设备，直接登路由器加 DNAT 规则。**已实现**为通用
`ssh-router` 后端 + 命令预设集（不逐家写后端）：

| 预设 | 方式 | 实际命令形态 |
|---|---|---|
| openwrt | SSH + iptables（MINIUPNPD 链，与 miniupnpd 共用挂载点） | `iptables -t nat -A MINIUPNPD -p tcp -m tcp --dport <ext> -j DNAT --to-destination <lan>:<int> -m comment --comment "service-tunnels:<name>"`；幂等用 `-C`（完整规则含 -m comment）；删除用 `-D`（同完整规则）；`sweep()` 清链 |
| routeros | SSH + RouterOS 脚本 | `/ip firewall nat add chain=dstnat protocol=tcp dst-port=<ext> action=dst-nat to-addresses=<lan> to-ports=<int> comment="service-tunnels:<name>"`；删除 `[find comment=...]`；sweep 用 `comment~"service-tunnels"` 前缀匹配 |
| generic-iptables | SSH + PREROUTING 链 | 同 openwrt 形态，链换 PREROUTING |
| OPNsense REST API | 观望（P3 后） | 需 API key，独立后端 |

**规则身份 = comment tag**：add 幂等（`-C` 完整规则检查）、remove 按 tag、
sweep 清孤儿。**注入防护**：端口/内网 IP/name 全部白名单校验后才拼命令
（fail-closed），ssh 参数经 execFile 数组传参（非 shell）。

### 1.4 不推荐的方向

- **Web 管理页抓包/模拟登录**（TP-Link、小米等各家私有 HTTP API）：脆弱、密码明文交给库、版本间随时变 —— 不做。
- **TR-064/TR-069**（运营商光猫）：仅少数设备开放且默认关闭，观望。

---

## 2. 能力探测（probe）

**已实现** `st portmap probe [--gateway <ip>]` / `st.portmap.probe()`，产出结构化能力报告：

```
{
  gateway: "<默认网关>",
  externalIp: "<公网IP>",
  ipClass: "public" | "cgnat" | "private" | "unknown",   // CGNAT → 判死
  upnp:   { ok: true, controlUrl: "http://<gw>:5000/ctl/IPConn", serviceType: "...WANIPConnection:1" },
  pcp:    { ok: true, externalIp: "..." },                 // NAT-PMP/PCP udp/5351
  recommended: "upnp" | "pcp" | null,
}
```

探测步骤（实际实现）：

1. 取默认网关（Linux `/proc/net/route`；macOS `route -n get default`）。
2. **SSDP 双通道**：组播 `239.255.255.250:1900` + 单播直发 gateway:1900（实测组播被
   桥接吞掉、单播正常——双通道必须）。拉 device XML → `WAN(IP|PPP)Connection`
   controlURL。另带常见路径 fallback（`http://<gw>:5000/rootDesc.xml` 等）。
3. 向 `gateway:5351` 发 NAT-PMP public-address 请求（1.5s×2 重试）→ ok 即
   pcp/nat-pmp 可用（PCP 是超集，NAT-PMP 应答即证明可达）。
4. `GetExternalIPAddress`（或 PMP 应答地址）分类：
   - `100.64.0.0/10`（RFC 6598）→ **CGNAT，判死**；
   - RFC1918 → 多级 NAT，映射大概率无效；
   - 公网 IP → routable。
5. **映射后二次检查**（F3）：`ensurePortmap` 拿到最终 externalIp 再分类一次——
   ssh-router 路径的 probe 是 `unknown`，必须用真实 IP 复核 CGNAT/私网，命中则
   **回滚已建映射**再报错（不留孤儿规则）。
6. 结果缓存 + TTL（daemon 持有，P3）。

`controlUrl` 可显式传入（跳过 SSDP，测试/排障用）；`ssdpTimeoutMs` 可调（测试加速）。

## 3. 安全模型（本项目的核心关切）

直连端口映射 = **绕过隧道边缘的全部认证**，这与 D4 安全模型冲突，必须显式处理：

1. **默认把外部端口指向 proxy transport 监听口（127.0.0.1:4180 类），而不是裸应用端口**
   ——这样 basic/token/portal 认证照常生效，portmap 只是"入口换了"，认证层不变。
   `auth: none` 时才允许直接映射应用端口（且仍过 allow-auth-none 开关）。
2. 复用 **`allow-auth-none` 全局开关**语义：全局禁止 auth-none 时，portmap 也必须挂认证，
   否则拒绝 expose。
3. **有限租约强制化**：UPnP LeaseDuration / PCP lifetime 都申请有限值（默认 30min）+
   半衰期续租循环；进程退出时 DeletePortMapping 清理。即使崩溃残留，租约到期自动消失。
   ssh-router 是静态规则（无租约）→ 退出时按 comment tag 删除 + `sweep()` 清孤儿。
4. 映射描述串固定带 `service-tunnels:<name>` 标记，便于用户在路由器上识别、也便于 ssh-router
   后端做幂等清理。
5. 外部端口默认随机（49152–65535 动态段，UPnP 规范推荐段），冲突时换端口重试 N 次。
6. **IP 直连的安全收敛（F1）**：IP:port 直连只命中**已 enroll 的 open binding**
   （labeled/site 绑定需要域名语义，不适用）；enrollment（D4）与 auth 门禁照常生效，
   仅 Host 匹配方式不同；IP 无 DNS rebinding 面，安全模型不受影响。`allowIpDirect`
   在共享 ProxyManager 全局开启（低层 createProxyServer 默认 false）。
7. **CGNAT/私网二次检查（F3）**：最终 externalIp 统一 `classifyExternalIp` 复核——
   ssh-router 路径 probe 是 `unknown`，拿到真实公网 IP 后仍要查；命中 CGNAT/私网
   先回滚映射再报错，不留静默无效映射。
8. **ssh-router 注入防护**：端口/内网 IP/name 白名单校验（fail-closed）后才拼命令，
   ssh 参数 execFile 数组传参（非 shell）；host/port 参数同样校验。
9. **续租失败可观测（M5）**：`MapHandle.lastRenewError` + `onRenewError` 回调——
   有限租约兜底自愈，但宿主需要感知映射可能已过期。
10. **本机防火墙闭环（真实教训）**：路由器 DNAT 建立后，本机防火墙（ufw/
    firewalld/iptables）若不放行 `LAN IP:transportPort` 入站，外部源（互联网）的包
    到不了 transport——映射"看似成功、实际不可达"（外部连通性实测抓到的教训）。
    `portmapExpose` 建立映射后自动 `openFirewall()`：检查 → 放行 → 失败回滚映射并
    报错。sudo 一律 `-n` 非交互（未配 passwordless sudo 立即失败给手动命令），
    10s 超时；ufw status 需 root 时自动 sudo -n。npm 无可用现成包，自实现
    `src/portmap/firewall.ts`（~180 行）。

## 4. 架构落点（已实现）

### 4.1 新 mode：`portmap`

```
ExposeOptions.mode += "portmap"
mode ∈ { tunnel, proxy, both, portmap }
```

- `expose(port, { mode: "portmap", portmap: { method: "auto"|"upnp"|"pcp"|"ssh-router",
  gateway?, controlUrl?, serviceType?, externalPort?, leaseSeconds?, sshRouter? } })`
- 流程：`portmapExpose` = `proxyExpose`（transport + enrollment + auth 全复用）→
  `ensurePortmap(transportPort)`（探测选后端 → 映射 externalPort → 本机 LAN IP:transportPort）→
  失败时 `removeBinding` 回滚（F2）。
- 结果 URL：`http://<externalIp>:<extPort>`（经 IP 直连命中 open binding，F1）。
- `ExposeResult.portmap = { backend, gateway, externalIp, externalPort, internalPort, leaseSeconds }`。
- 与 site/auth 正交组合：portmap + auth = "外网直达 IP:端口，但过认证"；
  portmap + tcp = 裸 TCP（SSH/VNC/RDP），无认证层，必须过 allow-auth-none 检查。

### 4.2 模块结构（src/portmap/，~750 行，零新增依赖）

| 文件 | 职责 |
|---|---|
| `probe.ts` | 默认网关、SSDP 双通道、device XML 解析、SOAP 请求、NAT-PMP 探测、IP 分类 |
| `upnp.ts` | UPnP IGD 后端：AddPortMapping（718 重试）、GetExternalIP、Delete；`PortmapError` |
| `natpmp.ts` | NAT-PMP 后端：RFC 6886 二进制编解码、MAP/unmap；`host:port` 网关写法 |
| `ssh-router.ts` | ssh-router 后端：openwrt/routeros/generic-iptables 预设 + 注入校验 + sweep |
| `index.ts` | `ensurePortmap`/`listPortmaps`/`stopPortmap` + 活动映射注册表 + 续租循环 |

```ts
// 核心入口（index.ts）
ensurePortmap(name, internalPort, opts): Promise<MapHandle>
//  MapHandle: { mapping, externalIp, probe, lastRenewError, onRenewError?, stop() }
listPortmaps(): Array<MapHandle & { key }>
stopPortmap(key): Promise<boolean>
```

生命周期：`ensurePortmap` 建立映射 → 半衰期续租（UPnP re-Add / NAT-PMP re-MAP，
ssh-router 静态规则不续）→ `stop()`（幂等：停定时器 + remove 映射 + 注册表清理）。
同 name 重复注册先停旧 handle（防定时器泄漏，M1）。

### 4.3 库 API 与 CLI

```
st.portmap.probe({ gateway? }) : Promise<PortmapProbe>
st.portmap.list()             // 活动映射（key/backend/gateway/externalIp/端口）
st.portmap.stop(key)          // 停映射（幂等）

sts portmap probe [--gateway <ip>] | list | stop <key>
sts expose <port> --mode portmap --portmap-set method=upnp gateway=<gw> externalPort=<p> leaseSeconds=<s> sshRouter.host=<h> ...
```

daemon RPC：`portmap.probe` / `portmap.list` / `portmap.stop`；expose 的 `portmap`
参数在 IPC 边界做形状校验（method 枚举、端口 1-65535 整数、sshRouter.host/preset 必填）。

### 4.4 IP 直连（F1，proxy 层改动）

外部浏览器访问 `http://<公网IP>:<extPort>` 时 Host 是 IP:extPort——proxy 的 vhost
匹配（`<port>.<suffix>`）不适用。三层改动：

1. `resolveServiceHost` 加 `allowIpDirect`（Host 为纯 IPv4 时按端口查 open binding）+
   `resolveIpDirectPort`（transportPort→appPort 回调）。
2. `ProxyBinding` 加 `ipDirectPort?: number`——portmap 注册 binding 时 = transportPort。
3. `ProxyManager` 提供 `#resolveIpDirectPort`（binding 反向查找）；start/resolve/upgrade
   全链路传递；共享实例全局开 `allowIpDirect: true`（低层 createProxyServer 默认 false）。

映射链：`IP:extPort`（公网）→ router DNAT → `IP:transportPort`（TCP 到达，
`socket.localPort`）→ `resolveIpDirectPort(localPort)` → appPort → 既有 open vhost
流程（enrollment + auth）。**注意（F4）**：DNAT 只改 TCP 层目标端口，HTTP Host 头
仍是原始外部端口——必须用 localPort（真实到达端口）而非 Host 端口做映射键。

解析结果关联 vhost（`pipe.vhost` 字段）：IP 直连命中的 binding 给出其 vhost 形式
（`<port>[-<label>].<suffix>`），日志/嵌入方可观察"这个 IP:port 对应哪个 vhost"；
反向 vhost 访问本来就通（同一 binding）。

### 4.5 依赖策略（已验证可行）

- 零运行时依赖（仅 justget）。自实现 ~750 行：SSDP ~80 行 + SOAP + NAT-PMP/PCP
  单包编解码 + ssh 命令预设，全部在 `src/portmap/`。
- 参考实现（学习用）：webtorrent `nat-api`（UPnP+NAT-PMP 双栈，MIT）、
  `jackpal/go-nat-pmp`。

## 5. 分期进度

| 期 | 内容 | 状态 |
|---|---|---|
| P1 | probe（双通道 + CGNAT 判定）+ upnp/pcp 后端 + mode=portmap 闭环 + 有限租约续租/清理 | ✅ 完成（真机 UPnP/NAT-PMP 验证） |
| P2 | ssh-router 后端（openwrt/routeros/generic-iptables 预设） | ✅ 完成（真机 openwrt 全链路验证） |
| P3 | daemon RPC（portmap.probe/list/stop + expose portmap 参数边界校验）；CLI --portmap-set 透传 + portmap probe --gateway；真机 IP 直连闭环 | ✅ 完成（daemon RPC 测试 + CLI 真机 probe + 真机 expose→IP 直连 200） |
| P3 余 | 外部连通性真实验证服务（需外部 vantage point）；OPNsense API 后端（观望）；UI 表单 | ⏳ 后续 |
| — | review 修复（F1-F3 + M1-M5） | ✅ 完成（见 portmap-review.md） |

## 6. 实测记录（2026-08-26，本机环境）

### 6.1 UPnP / NAT-PMP 通道（P1）

环境：家用 OpenWrt 网关（fw3/iptables + dropbear，已安装 miniupnpd）；
本机内网 IP；外网出口为**真公网 IP**（非 CGNAT）→ portmap 路线可行。

| # | 实测点 | 结果 |
|---|---|---|
| 1 | miniupnpd 已安装但服务未启动/未自启 | SSDP/5351 全无响应——probe 必须区分「未运行」vs「不支持」 |
| 2 | `/etc/init.d/miniupnpd start` 后重探 | NAT-PMP public-address 立即可用，回真实公网 IP ✓ |
| 3 | 组播 M-SEARCH (239.255.255.250:1900) | **无响应**（组播被桥接吞掉） |
| 4 | 单播 M-SEARCH 直发 gateway:1900 | 正常应答 ✓ → probe 必须**组播+单播双通道** |
| 5 | UPnP AddPortMapping → 内部端口 22 | errorCode=718 ConflictInMappingEntry（误导！）根因是 OpenWrt 默认权限规则 `int_ports=1024-65535` 拒绝特权内部端口 |
| 6 | AddPortMapping 高位内部端口 (18080)，lease=120s | 成功 ✓ 回读 internalPort/lease/desc 一致 ✓ DeletePortMapping 清理 ✓ |
| 7 | NAT-PMP TCP MAP（高位端口） | 成功 ✓ lifetime=120s；lifetime=0 删除 ✓ |
| 8 | hairpin（内网经公网 IP 回环访问映射口） | ECONNREFUSED——NAT 回环未开。**外网实际可达性需外部视角验证或文档说明** |
| 9 | 测试后路由器状态 | 租约文件空、MINIUPNPD iptables 链干净、无残留 ✓ |

设计修正（由实测驱动，已落实）：

- SSDP 探测**组播+单播双通道**（已实现，probe.ts）。
- UPnP 718 可能是冲突**或**权限拒绝：失败后换随机高位端口重试 N 次（已实现，
  upnp.ts add() 最多 8 次）；**特权内部端口（<1024）默认不可映射**要提示用户。
- miniupnpd 未运行 → 提示可操作命令（OpenWrt 启服务）或改 ssh-router 后端。
- hairpin 不通属正常，对外 URL 附「用外部网络验证」提示（P3 UI 接入时落实）。

实测脚本（一次性，不入库）：`/tmp/portmap-probe.mjs`、`/tmp/upnp-hi.mjs` 等。

### 6.2 ssh-router 后端（P2，真实 OpenWrt）

在 §6.1 同一网关（root@gateway SSH 免密）上验证 openwrt 预设：

| # | 实测点 | 结果 |
|---|---|---|
| 1 | `ping()` | ✓ |
| 2 | `getExternalIp()` | 首版用 `uci get network.wan.ipaddr` 失败——PPPoE 拨号（proto=pppoe）无该字段；改多级 fallback（uci → ifstatus wan → ip addr wan-pppoe → curl）后 ✓ |
| 3 | add 规则 | ✓ 含 `-m comment --comment "service-tunnels:<name>"` tag |
| 4 | 幂等重加 | 首版 `-C` 不带 `-m comment` 匹配不到完整规则 → 重复添加；改为**完整规则（含 -m comment）做 -C/-D** 后 ✓ |
| 5 | remove | 首版 remove 构造 `--to-destination 0.0.0.0:1`（占位）与真实规则不匹配 → 删不掉；改为**携带真实 target {internalIp, internalPort}** 后 ✓ |
| 6 | 残留检查 | remove 后 iptables 链干净 ✓ |

**真机踩坑结论（写进后端实现）**：
- iptables 的 `-C`/`-D` 必须给出**含 -m comment 的完整规则**，否则匹配失败；
- comment 是规则身份，add/remove 都以完整规则 + tag 为准（幂等 + 可清理）；
- PPPoE 路由器的 WAN IP 不在 uci 里，需 ifstatus/ip 多级探测；
- busybox grep -c 无匹配时无输出且 exit≠0，真机脚本计数要兼容。

### 6.3 IP 直连闭环（F1 修复后 e2e）

fake IGD + 本地 app 的 e2e：`expose mode=portmap` → URL `http://<假公网IP>:<extPort>`
→ 路由器映射目标 = transport 端口 → 请求 `Host: 127.0.0.1:<transportPort>`（模拟外部
IP:port 访问形态）→ **200 命中 open binding**；对照 `Host: <port>.st.localhost` 仍 200。
修复前同请求 403（`unknown virtual host`）——F1 前后对比明确。

### 6.4 测试基线

- `test/portmap.test.mjs` **14/14**：NAT-PMP 编解码/假 responder add-renew-remove、
  UPnP 718 重试/回读/删除、CGNAT 拒绝+回滚（F3）、stop 幂等（M2）、显式端口冲突不重试、
  IP 直连 localPort 优先（F4）+ vhost 关联、ssh-router 三预设命令断言 + 注入拒绝、
  daemon RPC（probe/list/stop + IPC 边界拒绝）、防火墙 firewalld/ufw 命令序列（fake
  命令 PATH 注入）、e2e（transport 注册 + IP 直连 + stop 清理）。
- 相关套件（proxy/expose-proxy/expose-default/auth-none）全过；全量 233 用例 230 过
  2 跳（guardian 1 例失败为并行会话既有问题，与本实现无关）。

### 6.5 外部连通性实测（真实互联网链路）

`test/portmap-external.test.mjs`：**`ST_TESTSERVER` env 门控**（公网 SSH 主机，未设置
自动 skip；主机信息只存在于 env，不落文档/代码）。流程：完整 expose 链路（app →
transport）→ 真实路由器 UPnP 映射 → SSH 到公网主机 curl 反向验证 → 清理。

实测抓到的真实问题（已全部修复）：
1. **本机防火墙**：ufw INPUT DROP 挡外部源——portmap 部署前提是宿主放行
   `LAN IP:transportPort` 入站 → 已自动化（§3.10）。
2. **filter 规则误判**：miniupnpd 的 ACCEPT 匹配内部端口而非外部端口，按外部端口
   grep 会误导排查。
3. **F4**：外部 curl 返回 `not enrolled`——DNAT 后 Host 端口 ≠ 到达端口，必须用
   `socket.localPort` 映射（§4.4）。

最终验证：`http://<公网IP>:<外部端口>/` 从公网主机返回应用内容 ✓（全链路真实互联网）。

## 7. 参考资料

- UPnP IGD:2 spec — https://openconnectivity.org/developer/specifications/upnp-resources/upnp/
- RFC 6886 NAT-PMP — https://datatracker.ietf.org/doc/html/rfc6886
- RFC 6887 PCP — https://datatracker.ietf.org/doc/html/rfc6887
- RFC 6598 CGNAT 地址段（100.64.0.0/10）— https://datatracker.ietf.org/doc/html/rfc6598
- miniupnpd（OpenWrt 的 UPnP IGD/PCP 服务端）— https://github.com/miniupnp/miniupnp
- OpenWrt UPnP wiki — https://openwrt.org/docs/guide-user/firewall/upnp/universal_plug_and_play
- OpenWrt fw4 redirect (port forwards) — https://openwrt.org/docs/guide-user/firewall/firewall_configuration
- MikroTik NAT 文档 — https://help.mikrotik.com/docs/display/ROS/NAT
- webtorrent nat-api（Node 双栈参考实现）— https://github.com/webtorrent/nat-api
