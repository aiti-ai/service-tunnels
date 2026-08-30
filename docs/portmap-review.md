# portmap 完成度审核报告（2026-08-30 第三轮）

> 第三轮：聚焦续租语义、边界泄漏、测试盲区。

## 本轮发现与修复

| 编号 | 严重度 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| F9 | 严重 | **续租可能端口漂移**：renew 闭包用 `{...opts}`——首次 NAT-PMP 是 gateway 分配端口（opts.externalPort 为 undefined），续租时 suggested=0/随机端口 → gateway 可能换端口（UPnP 718 重试甚至漂到新端口），映射 URL 静默失效 | renewOpts 锚定 `externalPort: mapping.externalPort`（renew = 刷新租约，不是重新分配） | 真机 NAT-PMP 35s 续租：无错误 + 路由器规则保持；代码审查确认 |
| F10 | 中 | **startTransport:false 的 binding 泄漏**：portmapExpose 检测 transportPort=0 提前 return，但 proxyExpose 已注册 binding（与 F2 同类泄漏路径） | 该分支回滚 `proxyForPortmap.removeBinding` | typecheck + 逻辑核对 |
| G4 | 低 | ssh-router getExternalIp 多级 fallback / sweep 无测试；firewall iptables 分支无测试 | 补 3 个单测（fallback 到第 3 个命令、私网 IP 拒绝、sweep 命令形态、iptables 序列） | 19/19 通过 |
| G5 | 低 | daemon 恢复 catch 里动态 `import("node:fs")`（每次失败才加载） | 静态 import 合并 | typecheck |

## 测试基线（第三轮）

- portmap.test.mjs **19/19**（新增：ssh-router getExternalIp fallback + sweep、firewall iptables 序列）
- 全量 238 用例 235 过 2 跳（guardian 1 例为并行会话既有问题）

## 续租真机验证（NAT-PMP）

`ensurePortmap(method=pcp, lease=60s)` → 35s（覆盖一个续租周期 30s）→
`lastRenewError: none` + 路由器 iptables 规则保持 → 续租锚定生效。

---

# portmap 完成度审核报告（2026-08-30 第五轮）

> 第五轮：防火墙规则生命周期闭环 + CLI 嵌套参数。

## 本轮发现与修复

| 编号 | 严重度 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| F12 | 中 | **CLI 无法配置 ssh-router 后端**：`--portmap-set sshRouter.host=x` 产生扁平键，daemon 校验要求 sshRouter 是对象 → 拒绝 | CLI 点号键嵌套（sshRouter.host → {sshRouter:{host}}，与 providerParams dot keys 语义一致） | F12 单测（嵌套转换结果）+ 48/48 |
| G7 | 中 | **防火墙放行规则 stop 后不清理**（上轮标注待办 #4）：expose 自动开的 ufw/iptables 规则残留（端口无监听风险可控，但属"该关没关"） | `removeFirewall()`（ufw delete / firewalld --remove-port+reload / iptables -D）+ `EnsureMappingOptions.onStopCleanup`——portmapExpose 只在**本次打开**规则时挂清理（already allowed 的既有配置不动） | 真机：新 transport 端口 4191 → expose 后 ufw 规则出现 ✓ → stop 后规则删除 ✓；既有 4180 规则不受影响 ✓ |
| G8 | 低 | removeFirewall 的 sudo 分支用解析出的绝对路径——sudo 重置 PATH（secure_path），测试注入的 fake 失效、非标准路径找不到 | sudo 分支改用命令名 | removeFirewall 单测通过 |

## 测试基线（第五轮）

- portmap.test.mjs **23/23**（新增 removeFirewall 序列、F12 嵌套转换）
- 相关套件 48/48 + 外部实测 1 过；全量 242 用例 239 过 2 跳

## 真机验证（防火墙生命周期闭环）

```
expose(proxyPort=4191, 新端口) → ufw 自动 allow 4191 → stop → ufw 规则自动删除
既有 4180 规则（手动配置）→ 不受影响（already allowed 短路，不挂清理）
```

---

# portmap 完成度审核报告（2026-08-30 第四轮）

> 第四轮：聚焦状态持久化完整性与探测性能。

## 本轮发现与修复

| 编号 | 严重度 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| F11 | 严重 | **ssh-router 映射恢复不完整**：`ExposeResult.portmap` 无 method/sshRouter 字段——daemon 持久化后 `rec.portmap.method` 恒 undefined → 恢复退化为 auto 探测（可能选 upnp 而非原 ssh-router），ssh-router 场景因缺 preset/host 直接失败 | ExposeResult.portmap 补 `method`（默认 backend）+ `sshRouter` 详情；state.ts/恢复循环透传 | F11 单测（method=upnp 持久化 + exposes 记录携带）+ 19/19 |
| G6 | 中 | **每次 expose 全量探测 ~6s**（SSDP 3s + NAT-PMP 3s）——设计文档声称"结果缓存 + TTL"但未实现 | `cachedProbe`：按 gateway 缓存 60s（controlUrl 显式路径不受影响） | G6 单测（第二次显著快）+ **真机：3027ms → 14ms** |

## 测试基线（第四轮）

- portmap.test.mjs **21/21**（新增 F11 持久化 + G6 缓存）
- 相关套件 46/46 + 外部实测 1 过

## 剩余待办（累积）

1. UI 表单（等 UI 会话）
2. OPNsense API 后端（观望）
3. guardian 测试失败（并行会话既有问题）
4. daemon logFile 死代码（并行会话既有问题，恢复失败已改走诊断文件）
5. **防火墙放行规则 stop 后不清理**（残留 allow 规则，端口无监听风险可控——需记录"本次添加"状态才能安全删除，标注待做）

---

# portmap 完成度审核报告（2026-08-30 第二轮）

> 深入审核（代码 vs 文档/声明逐项核对）后修复了 3 个真实缺陷（F6-F8）+ 1 个
> 一致性补全（ssdpTimeoutMs 透传）。第一轮审核见上文（F1-F5）。

## 本轮发现与修复

| 编号 | 严重度 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| F6 | 严重 | **daemon 模式 IP 直连失效**：daemon-server 的 ProxyManager 没开 `allowIpDirect`——CLI 默认走 daemon（`sts expose --mode portmap` → daemon RPC），daemon 模式下外部访问 IP:port 必 403（库模式却正常，行为分裂） | daemon proxy 构造加 `allowIpDirect: true` | daemon 生命周期 e2e：expose → IP 直连 200 ✓ |
| F7 | 严重 | **daemon 重启后 portmap 续租丢失**：`proxy.restore` 恢复 binding 但 portmap 的续租 handle 在进程内——重启后映射到期不续租、静默失效。**深层问题（真机验证抓到）**：重启后 transport 端口变了，恢复的映射内部目标还是旧端口；且旧映射在路由器上未过期（lease 600s）时同 externalPort 重加返回 718——恢复失败。修复：持久化 portmap 详情 + 启动恢复循环（start transport → 更新 binding.ipDirectPort 为新端口 → ensurePortmap 重建）；`forceReplace` 语义——718 时先 Delete 旧映射再重加**同一 externalPort**（端口稳定，修复过程中还抓到重试漂移到随机端口的 bug） | 真机 daemon 重启验证：外部端口保持 ✓、内部端口更新为新 transport ✓、IP 直连恢复后 200 ✓、stop 清理 ✓；单测 forceReplace 端口保持 |
| F8 | 中 | **daemon `expose.stop`/`stopAll` 不停 portmap 映射**：只 removeBinding，续租定时器继续跑、路由器规则残留最长 30min（lease 到期才自愈） | stop/stopAll 对 mode=portmap 调 `stopPortmap(key)` | daemon e2e：expose.stop 后 `portmap.list` 为空 ✓ |
| G1 | 低 | **ssdpTimeoutMs 文档可调但 CLI 路径不可调**（portmapExpose 不透传） | 透传 + ExposeOptions/daemon 校验/CLI 数字化补全 | typecheck + 20 测试全过 |
| G2 | 低 | **ssh-router 静态规则无检测**：路由器重启后规则丢失无感知（无租约语义） | 文档标注（静态规则 + sweep 兜底） | — |
| G3 | 低 | **controlUrl SSRF 面**：daemon RPC 的 portmap.controlUrl 可指向任意 URL（HTTP GET + XML 解析） | 现状可接受（与 gateway 域名验证同面；无数据回传），标注 | — |

## 覆盖度核对（功能清单 vs 实现）

| 设计文档声明 | 状态 |
|---|---|
| P1: probe 双通道 / upnp/pcp 后端 / mode 闭环 / 续租清理 | ✅ |
| P2: ssh-router 三预设 | ✅ |
| P3: daemon RPC probe/list/stop / CLI --portmap-set / --gateway | ✅（F6 修复后 daemon 模式完整） |
| 本机防火墙 ufw/firewalld/iptables/pfctl | ✅ |
| F1-F5 修复 | ✅ |
| 外部连通性实测（ST_TESTSERVER） | ✅ |
| daemon 重启恢复（F7） | ✅ 实现（真机重启验证待做） |
| UI 表单 / OPNsense / PORTMAP_PARAM_SCHEMAS | ⏳ 后续（非阻塞） |

## 测试基线（本轮）

- portmap.test.mjs **17/17**（新增 daemon 模式生命周期 e2e：F6 IP 直连 + F8 stop 清理）
- portmap + daemon + expose-proxy + proxy 共 41 用例全过；外部实测 1 过
- 全量 234 用例 231 过 2 跳（guardian 1 例为并行会话既有问题）

## 剩余待办

1. UI 表单（等 UI 会话）
2. OPNsense API 后端（观望）
3. guardian 测试失败（并行会话既有问题，与 portmap 无关）
4. daemon logFile 参数是死代码（stdio ignore，logPath 算了没用）——恢复失败已改走
   `state.json.portmap-restore.log` 诊断文件，但 daemon 常规 stderr 仍不可观测（并行
   会话的既有问题，标注待修）

---

# portmap 代码 Review 报告（2026-08-26）

范围：`src/portmap/*.ts`（probe/upnp/natpmp/ssh-router/index）+ `src/expose.ts` portmapExpose
+ `test/portmap.test.mjs`。规模约 1280 行（含测试），类型严格模式下干净。

---

## 修复状态（2026-08-26 晚，全部完成并验证）

| 项 | 修复 | 验证 |
|---|---|---|
| F1 | proxy 三层（resolveServiceHost / createProxyServer handle+upgrade / ProxyManager）加 `allowIpDirect` + `resolveIpDirectPort`；binding 加 `ipDirectPort`（portmap 注册时 = transportPort）；IP:port 直连按 transportPort→appPort 映射后走 open vhost 流程（enrollment + auth 照常） | e2e：IP:port 直连 200 + vhost 照常 200 |
| F4 | **外部实测抓到的真实缺陷**：DNAT 只改 TCP 层目标端口，HTTP Host 头仍是外部端口——IP 直连映射必须用 `socket.localPort`（真实到达端口）而非 Host 端口；`ServiceHostResolveInput` 加 `localPort`，IP 直连优先用它，Host 端口兜底。**解析结果关联 vhost**（`pipe.vhost` 字段 + `resolveIpDirectVhost` 回调） | e2e + 外部连通性实测（公网主机 curl 200）+ F4 单测（localPort 优先 + vhost 关联） |
| F5 | **portmap + auth 缺陷**：F1 说"IP 直连只匹配 open binding"，但 portmap + auth 的 binding 是 labeled（label="auth"）——IP 直连查不到 → 403 not enrolled，认证场景完全不可用。修复：`resolveIpDirectSite` 专用解析（open 优先，查不到时按 port 找 labeled binding 走 site auth），仅 IP 直连启用——open 形式的 vhost 请求仍严格 open（expose-proxy 测试回归抓到的安全边界） | auth e2e：IP 直连 302 到 portal 登录 + exposes 记录带 mode/portmap 详情；expose-proxy 原有 403 断言恢复 |
| F2 | portmapExpose 先解析/注入共享 proxy 实例，失败路径 `removeBinding(port, label)` 回滚 | e2e 断言（stop 后 binding 清理） |
| F3 | `ensurePortmap` 对最终 externalIp 统一 `classifyExternalIp`，CGNAT/私网 → 回滚映射 + 报错 | 新测试：CGNAT 拒绝且 DeletePortMapping 回滚 ✓ |
| M1 | active.set 前停旧 handle | — |
| M2 | stop() 幂等守卫 | 新测试：重复 stop 只删一次 ✓ |
| M3 | remove 无 target 显式报错（不再静默失败） | 新测试：routeros remove 无 target 拒绝 ✓ |
| M4 | tryUpnp 显式检查而非双重断言 | — |
| M5 | MapHandle.lastRenewError / onRenewError 可观测 | — |
| L1-L7 | 未用 import、死代码（discover/natpmpProbe）、死分支、httpGet 连接释放、runSsh 参数校验 | typecheck 干净 |

测试：portmap.test.mjs 10/10 通过；proxy/expose-proxy/expose-default/auth-none 全过；
全量 228 用例 226 过 1 跳（guardian 失败为并行会话既有问题，stash 验证与本改动无关）。

---

## 修复前原始报告（保留存档）

### 严重（功能缺陷，必须修）

### F1 — portmap URL 从外部访问必然 403（核心可用性缺陷）
`portmapExpose` 返回 `http://<公网IP>:<extPort>`，但 proxy transport 的
`parseServiceHost()`（src/proxy.ts:334）只认 `<port>[-<label>].<suffix>` 格式的
Host 头。外部浏览器访问 `http://61.149.239.106:52369` 时 Host 为 `61.149.239.106:52369`
→ 不匹配 → `403 unknown virtual host`。**映射建立成功但 URL 不可用。**

真机验证时只确认了"iptables 规则存在"，没从外部视角访问——漏掉了这一步。

**候选方案：**
- A. proxy 增加 IP:port 直连支持：Host 为 IP 时按端口匹配 binding（改 `resolveServiceHost`，
  新增 `isIpHost` 分支）。改动小、对既有模式零影响，但注意 DNS-rebinding 安全模型
  （IP 直连天然免疫 rebinding，可接受）。
- B. portmap 不经过 proxy transport，改为裸 TCP 转发到应用端口（绕过认证，违背安全模型）。
- C. 文档说明需配 hosts/自定义 Host——体验差。
- D. 外部 URL 用域名 + 用户自配 DNS——失去"动态端口"意义。

**推荐 A**：proxy 加 IP:port 直连（仅当该 IP 是本机 LAN IP 时？或直接按 port 查 binding），
portmap 模式专属启用。

### F2 — ensurePortmap 失败时 proxy transport/binding 泄漏
`portmapExpose` 先 `proxyExpose()`（启动 transport + 注册 binding），再 `ensurePortmap()`。
后者失败（CGNAT/超时/权限拒绝）→ 返回 error，但 **transport 还在监听、binding 还注册着**，
端口被占用、UI 显示可能不一致。ProxyManager 有 `removeBinding(port, label)` 但 portmapExpose
拿不到调用所需的 label 语义（label 存在 proxyResult 里，可以拿）。失败路径需
`ctx.proxy.removeBinding(port, label)` 回滚。

### F3 — ssh-router 路径跳过 CGNAT 检查
`pickBackend` 对 ssh-router 返回 `ipClass: "unknown"`，`ensurePortmap` 只在
`probe.ipClass === "cgnat"` 时拒绝。ssh-router 拿到公网 IP 后**不再二次分类**——
运营商大内网（CGNAT）下映射无效但静默成功。修复：`ensurePortmap` 拿到 `externalIp`
后统一 `classifyExternalIp()` 再判 CGNAT。

---

## 中等

### M1 — active Map 同 name 覆盖导致定时器泄漏（index.ts:127）
`active.set(name, handle)` 覆盖旧 handle 但不停旧定时器 → stop 只清新映射，旧定时器
永久跑（30s 间隔，进程常驻时泄漏）。修复：set 前 `await old.stop()`。

### M2 — MapHandle.stop() 不幂等（index.ts:150）
重复调用会重复 remove（第二次失败被吞）。加 `if (stopped) return` 守卫。

### M3 — SshRouterBackend.remove 无 target 时静默失败（ssh-router.ts:180）
`target` 可选，缺省 `internalIp: "0.0.0.0"` 通过正则但生成的 `-D ... --to-destination
0.0.0.0:1` 匹配不到真实规则 → 命令以 `2>/dev/null; true` 吞掉 → **静默删除失败**。
修复：target 改为必填，或 name 空时 sweep、有 name 无 target 时抛错。

### M4 — tryUpnp 双重非空断言（index.ts:76）
`probe.upnp!.controlUrl!`——理论上 ok:true 必有 controlUrl，但断言脆弱。改为显式
`if (!probe.upnp?.controlUrl) throw`。

### M5 — 续租失败完全静默（index.ts:139-150）
catch 空吞。长时间续租失败用户无感知（映射静默过期）。加 `onRenewError` 回调 /
handle 上暴露 `lastRenewError`。

---

## 轻微

- L1: probe.ts `import { networkInterfaces }` 未使用。
- L2: 死代码——`UpnpBackend.discover`（index.ts 用 probePortmap 而非它）、
  `NatPmpBackend.discover`、`UpnpBackend.check`（续租只 re-add 不 check）。
- L3: upnp.ts add() 里 `if (code === "718" && req.externalPort) break` 是死代码
  （maxAttempts=1 时循环已退）。
- L4: `httpGet` 响应后未 `req.destroy()`，keep-alive 连接可能短暂挂起（3s 超时兜底，无碍）。
- L5: `getExternalIp` 的 `ifstatus wan`/`wan-pppoe` 依赖固定接口名，注释说明即可。
- L6: `runSsh` 不校验 `o.port`/`o.host`（buildVars 只校验规则内容）——ssh 参数是
  execFile 数组传参（非 shell），注入面小，但 port 非整数会报错不优雅。
- L7: 测试缺 UPnP renew（同端口 re-add）用例；ssh-router sweep 分支无测试。

---

## 测试现状

8 用例：7 通过 1 跳过（e2e 被并行会话未落盘的 ddns.ts 阻塞）。覆盖：NAT-PMP 编解码/
add/renew/remove、UPnP 718 重试/回读/删除、ssh-router 三预设命令 + 注入拒绝。
**未覆盖**：续租定时器行为（30s 最小间隔测不起）、F1 的 IP:port 访问、F2 失败回滚、
F3 CGNAT 二次检查。

---

## 修复优先级建议

1. **F1**（可用性）——方案 A：proxy 支持 IP:port 直连 + portmapExpose 用它。
2. **F3**（安全，一行）——拿到 externalIp 后统一 classify。
3. **F2**（资源泄漏）——失败路径 removeBinding 回滚。
4. **M1-M5**（健壮性）——stop 幂等、active 覆盖清理、remove target 必填、显式断言、
   续租错误可观测。
5. L 级清理 + 补测试。
