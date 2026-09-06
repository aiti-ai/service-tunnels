# IPv6 直连暴露（mode "ipv6"，免隧道）设计方案

> 状态：**已实现**（0.3.72；决策点 A=独立 transport、B=独立 `st ipv6` +
> status/ddns 附带信息、C=AAAA+TXT，CNAME 不适用）。
> 前置：0.3.71 已补全库内 IPv6 支持（validation/proxy/gateway/tunnels 全链路
> 接受 IPv6 字面量与 `::1` 上游拨号、Host 头 `[v6]:port` 解析、AAAA DDNS）。
> 本文回答：**怎么让普通用户不依赖隧道服务，直接用公网 IPv6 暴露本机服务？**

---

## 0. 一句话结论

IPv6 无 NAT：主机网卡上有**全球单播 IPv6** 时，这个地址本身就是公网可达的
入口。service-tunnels 的 proxy transport 默认监听 `::`（双栈），
`allowIpDirect` + `ipDirectPort` 机制正好把 `http://[<v6>]:<port>` 直连映射到
目标 app 端口。所以新模式本质 = **portmap 流程去掉 router DNAT**，加「公网 v6
检测」+「本机防火墙放行」，零隧道、零第三方依赖。

用户侧体验：

```
st ipv6                                    # 诊断：本机有没有公网 IPv6（分类展示）
st expose 3000 --mode ipv6 --auth auto
# → http://[2001:db8::1]:4180             # 公网可直接访问，认证照常生效
```

---

## 1. 目标与非目标

### 1.1 目标

1. 新增 expose 模式 `"ipv6"`：把本机服务暴露到公网 IPv6 地址，无需隧道进程、
   无需路由器端口映射、无需任何账户/第三方服务。
2. 让普通用户能自查「我有没有公网 IPv6」：`st ipv6` 诊断（全局单播 / ULA /
   链路本地 / 回环分类展示）。
3. 安全闭环不缩水：认证照常（默认 portal）、`allow-auth-none` 总开关照样
   约束公网裸暴露、本机防火墙自动放行（沿用 portmap 的模块）。
4. 与既有 DDNS 能力联动：`ddns.aaaa` 把检测到的 v6 写成 AAAA 记录。

### 1.2 非目标（本迭代不做）

- 不做 IPv6 可达性远端验证（工具无法确认 ISP/上游过滤，如实提示用户自验）。
- 不做 IPv4↔IPv6 转换（4→6 桥接仍属隧道服务范畴，与「免隧道」目标相反）。
- 不做 IPv6 防火墙探测的多后端深化（沿用 portmap 已验证的
  ufw/firewalld/ip6tables/ipf/… 模型，仅补 ip6tables 分支）。

---

## 2. 为什么「不需要隧道」

| 维度 | IPv4（现状 portmap） | IPv6（新模式） |
|---|---|---|
| NAT | 一定有 | **无 NAT**，global 地址即公网入口 |
| 入口地址 | 路由器外网 IP（主机拿不到） | 主机网卡自己的 global 地址 |
| 端口映射 | 需要 UPnP/NAT-PMP/PCP 或 ssh-router 改路由器 | **不需要**，transport 监听 `::` 即双栈可达 |
| 本机防火墙 | 需放行 LAN IP:transportPort | 需放行 `[v6]:transportPort`（同模块） |
| 隧道进程 | ngrok/frpc/cloudflared… | **零依赖** |

技术前提（已具备，0.3.71 验证）：
- `createProxyServer` 的 `server.listen(port)` 默认绑 `::`（Linux 双栈）——
  IPv6 连接可直接到达 transport；
- `resolveServiceHost` 的 `allowIpDirect` 分支已接受 IPv6 字面量 Host 头
  （`[2001:db8::1]:4180` → `hostnameOnly` → 正确映射）；`ipDirectPort` 把
  transportPort → appPort 的映射已用于 portmap，可复用。

---

## 3. 用户流程与 CLI 形态

### 3.1 诊断：`st ipv6`

```
st ipv6                       # 分类列出全部 v6 地址 + 是否有 global
┌ ipv6 addresses
├ global    2001:db8:1::2     (eth0)     ← 可用于直连暴露
├ ula       fd00::1234        (eth0)
├ link-local fe80::1%eth0     (eth0)
└ (没有 global 时给出提示：ISP 未提供原生 v6 / 需要 HE 隧道或 VPS)
```

### 3.2 暴露

```
st expose 3000 --mode ipv6 --auth auto          # 自动挑第一个 global 地址
st expose 3000 --mode ipv6 --auth auto --ipv6-address 2001:db8:1::2   # 显式指定
```

输出（`ExposeResult`）：
- `url: "http://[2001:db8:1::2]:4180"`（transportPort 默认 4180，忙随机）；
- `ipv6: { address, transportPort, addresses: [...] }`（address=实际入口，
  addresses=全部候选，供用户挑）；
- 防火墙放行结果 info 与手动命令（失败时 fail-closed 报错，绝不静默成功）。

### 3.3 停止

`st expose stop <name>` → 移除 binding + 撤销本机防火墙规则（与 portmap 相同
清理语义）。

---

## 4. 设计要点

### 4.1 模式分发

`expose()` 里加一个分支（对照 portmap）：

```
mode === "ipv6" → ipv6Expose(port, opts2, ctx, siteCfg)
```

`ipv6Expose()` 内部结构（模型仿 `portmapExpose`，但去掉 `ensurePortmap`）：

```
1. 端口归属校验（verifyPortOwner，同 proxy/portmap）
2. 解析入口地址：
   - opts.ipv6.address（显式）> detectPublicIpv6()（global 地址列表，去重）
   - 无 global → 返回清晰错误 + st ipv6 诊断提示（fail-closed）
3. 准备 transport：见 §4.2 决策点 A
4. proxyExpose(...)（现有 enrollment + provider/auth 全流程，mode 传 "ipv6"）
   → 拿到 binding + transportPort + label + provider
5. 本机防火墙放行 transportPort（openFirewall(ipv6, transportPort)；
   成功后注册 fwCleanup 供 stop 撤销；失败 → 回滚 binding + 报错，同 F2）
6. 拼 URL + 返回；exposes 记录含 ipv6 详情（daemon registry 持久化）
```

### 4.2 关键机制（已就绪，可复用）

| 机制 | 位置 | 说明 |
|---|---|---|
| v6 地址分类 | `src/ipv6.ts`（新建，纯函数） | `classifyIpv6` / `listIpv6Addresses` / `globalIpv6Addresses` / `detectPublicIpv6` / `ipv6Diagnose` |
| IP 直连决策 | `proxy.ts resolveServiceHost` | `allowIpDirect && isIpv6Host(hostname)` 已实现（0.3.71） |
| transportPort→appPort | `proxy-manager #resolveIpDirectPort` + binding `ipDirectPort` | portmap 已验证；ipv6 模式同样设置 `ipDirectPort: transportPort` |
| 防火墙放行 | `portmap/firewall.ts` | 需补 **ip6tables** 分支（v6 地址 → `ip6tables` 而非 `iptables`）；ufw/firewalld/pfctl/netsh 族无关 |
| 认证 | expose 现有 provider 流程 | 默认 portal；`allow-auth-none` 总开关照样约束（公网裸暴露必须显式允许） |
| DDNS AAAA | `index.ts registerExposeDdns` / `ddns-registry.ts` | `ddns.aaaa` 已实现（0.3.71），ipv6 模式直接写检测到的 v6 |

### 4.3 安全

1. **认证默认开**：`--mode ipv6` 未指定 auth 时走 provider（portal 默认）；
   auth=none 需要 `resolveAllowAuthNone` 允许（与现有一致，公网暴露无认证被
   安全开关拦截）。
2. **防火墙 fail-closed**：`openFirewall` 失败 → 回滚并返回错误 + 手动命令，
   绝不报「成功」。
3. **不可达如实提示**：返回地址附注「请从公网另一端验证可达性」（ISP/上游
   过滤无法本地判断），避免假成功误导。
4. **不泄露内网信息**：只返回 global 地址作为入口；ULA/link-local 仅诊断展示，
   不作为暴露入口。

---

## 5. 改动点清单（预计）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/ipv6.ts` | **新建**：地址分类/枚举/检测/诊断（纯函数，零依赖引入） |
| 2 | `src/expose.ts` | `mode` 联合类型加 `"ipv6"`；`ExposeOptions.ipv6?: { address?: string }`；新增 `ipv6Expose()`；`proxyExpose` 对 `ipv6` 模式同样启用 `allowIpDirect` + `ipDirectPort`；`ExposeResult` 加 `ipv6` 详情 |
| 3 | `src/portmap/firewall.ts` | IPv6 感知：`detectFirewall` 探测 `ip6tables`；`openFirewall/checkFirewall/removeFirewall` 对 v6 地址走 `ip6tables` 分支（v4 路径零改动） |
| 4 | `src/cli.ts` | `st ipv6` 诊断子命令；expose 支持 `--mode ipv6` + `--ipv6-address`；usage 文案 |
| 5 | `src/daemon-server.ts` | expose RPC 透传 `ipv6` 参数（形状校验）；exposeRegistry 持久化 ipv6 详情；`expose.stop` 撤销防火墙规则 |
| 6 | `src/index.ts` | 公共 API：`st.ipv6.diagnose()`；exposes 记录加 `ipv6` 字段；DDNS AAAA 联动（直接写检测到的 v6 而非再探测一次） |
| 7 | `src/i18n.ts` | mode 标签 + ipv6 文案（中/英） |
| 8 | `docs/ipv6-direct.md` | 用户指南（前提/用法/安全/防火墙/DDNS/故障排查） |
| 9 | `test/ipv6.test.mjs` 等 | 单元（classify/detect/global 枚举）+ expose 端到端（显式地址走 `::1` 模拟）+ firewall v6 选择 + CLI |

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 防火墙权限（ip6tables/ufw 需 root） | 沿用 portmap：fire-and-forget + checkFirewall 兜底 + 手动命令提示；无后端 fail-closed |
| 上游过滤/ISP 未路由 v6 | 本地无法验证：返回地址 + 「请从公网另一端验证」提示，不做假成功 |
| 多 expose 端口冲突（ipDirectPort 同 transportPort） | 决策点 A：独立 transport per expose 可消除，见 §7 |
| 公网裸暴露风险 | auth 默认开 + allow-auth-none 总开关 + 文档警示 |
| ip6tables 不存在（精简系统） | detectFirewall 探测失败 → 提示 ufw/manual，不静默 |
| 状态持久化兼容 | `ExposeRuntimeState.ipv6?` 可选字段，旧记录无该字段不受影响 |

---

## 7. 需要确认的决策点

- **A. transport 模型**
  - 方案①（改动最小）：复用共享 transport，与 portmap 一致 —— 但多个 ipv6
    暴露会抢同一个 `ipDirectPort`，**同时只能一个 ipv6 暴露**。
  - 方案②（**推荐**）：每个 ipv6 暴露独立 transport 端口（独立 ProxyManager，
    模块级 registry 托管 stop），支持多个并存、与 portmap 互不干扰。
- **B. 诊断命令形态**：独立 `st ipv6`（推荐）／并进 `st ddns ip`／并入 `st status`。
- **C. DDNS 联动范围**：仅 `ddns.aaaa`（推荐，最小）／CNAME+TXT 全套。

---

## 8. 验证计划

1. `npm run typecheck` 通过。
2. 单元：`classifyIpv6`（global/ula/link-local/loopback/文档段）、
   `globalIpv6Addresses`、`detectPublicIpv6`（显式 > 枚举 > external 回退）。
3. 端到端（无公网 v6 的 CI 环境）：`--ipv6-address ::1` 强制走本机 IPv6 回环，
   验证 transport 启动 → binding（ipDirectPort）→ 决策 pipe → 转发到 app；
   以及防火墙 mock/真 ufw 路径。
4. 回归：全量 `npm test`（portmap/proxy 等共享模块 0 回归）。
5. 文档：`docs/ipv6-direct.md` 面向用户。

---

## 附：与既有文档的关系

- 继承 `docs/portmap-analysis.md` 的防火墙闭环与 F2 回滚语义；
- 与 `docs/ddns-integration.md` 的 AAAA 能力对接；
- 是 0.3.71「IPv6 全链路支持」的对外形态（此前修的是接受 v6 输入，本次是
  把 v6 作为**对外入口**输出）。