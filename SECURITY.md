# 安全策略（Security Policy）

`service-tunnels` 是安全敏感型工具：它**发现**并**暴露**本机端口到公网，
编排**认证门户**与**隧道进程**，处理用户凭据。本文件定义威胁模型、安全设计
（每项均对应代码实现）、已知风险、漏洞报告流程与审计计划。

> 状态说明：本项目尚未发布到公共 npm（当前发布在私有 registry），尚未经过
> 独立安全审计。公开推广前将按本文档 §5 完成审计计划。

---

## 1. 威胁模型（Threat Model）

本工具在三个边界上暴露攻击面，安全设计分别针对：

### 边界 A：本地代理（局域网可达）
- 攻击者：同一局域网/本机上的任意进程或用户
- 攻击面：内置反向代理（proxy，默认 4180 端口）、nginx 网关
- 关键防御：**发现缓存即白名单**（未发现的端口永不代理）、
  **D4 零转发**（未显式 enrollment 的虚拟主机一律 403）、后缀白名单

### 边界 B：隧道暴露（公网可达）
- 攻击者：公网任意用户（随机隧道域名可被扫描/猜解）
- 攻击面：隧道进程（ngrok/cloudflared/localtunnel/…）→ 本地网关
- 关键防御：**认证统一在本地端口侧**，隧道是纯透传通道；默认要求
  `--auth`；fail-closed 认证判定；目标仅限 127.0.0.1

### 边界 C：认证门户（凭据处理）
- 攻击者：公网用户尝试登录、凭据猜测、会话劫持
- 攻击面：portal 登录门户（forward-auth）、Authelia、会话 cookie
- 关键防御：scrypt 口令哈希、HMAC 签名会话、限流防爆破、2FA、
  凭据只落 0600 目录

---

## 2. 安全设计（Security Posture）

以下每一项都是**代码实现**，不是文档声明。括号内为源码位置索引
（见 §6 附录）。

### 2.1 默认安全（Secure by Default）

| # | 设计 | 实现 |
|---|---|---|
| 1 | **D4 零转发**：proxy 默认不转发任何端口——虚拟主机必须显式 enrollment（`expose --mode proxy/both` 注册 binding），未 enroll 一律 403 | `src/proxy.ts` `resolveServiceHost` |
| 2 | **代理/隧道目标只允许 127.0.0.1**，代码写死，无 host 转发 | `src/proxy.ts` `proxyTarget` |
| 3 | **发现缓存即白名单**：代理端口必须命中调用方进程树的发现缓存（5s TTL），远程攻击者无法拿它当跳板访问同机 Redis/MySQL 等未暴露服务 | `src/discovery.ts` |
| 4 | **公网暴露默认要求认证**：`expose --auth auto` 默认开启（provider 按平台选 authelia/portal） | `src/expose.ts` |
| 5 | **fail-closed 认证判定**：forward-auth probe 超时（3s）/连接失败/异常状态码一律 deny，绝不放行 | `src/proxy.ts` `checkForwardAuthReq` |

### 2.2 输入与注入防护

| # | 设计 | 实现 |
|---|---|---|
| 6 | **SSRF 防护**：代理目标 URL 构造显式锁定 `http://127.0.0.1:<port>` 权威部分，路径原样拼接——`//evil.com`、`//127.0.0.1:9999` 等 authority 覆盖攻击无效 | `src/proxy.ts` `proxyTarget` |
| 7 | **DNS rebinding 防护**：虚拟主机后缀正则即主机白名单——`.st.localhost` 仅回环；远程后缀必须显式配置 | `src/proxy.ts` `serviceHostRegex` |
| 8 | **Prototype pollution 防护**：schema 驱动参数展开时拒绝 `__proto__`/`constructor`/`prototype` 键 | `src/expose.ts` `unflattenParams` |
| 9 | **端口合法性**：虚拟主机端口 2-5 位、10–65535 有效范围校验 | `src/proxy.ts` `parseServiceHost` |

### 2.3 凭据与会话（认证门户）

| # | 设计 | 实现 |
|---|---|---|
| 10 | **口令哈希**：scrypt（`node:crypto`，随机 16B salt，64B key） | `src/providers/portal.ts` |
| 11 | **会话 cookie**：base64url(expiry.name) + HMAC-SHA256 签名，`timingSafeEqual` 验证，HttpOnly + SameSite=Strict | `src/providers/portal.ts` |
| 12 | **登录防爆破**：按 IP 滑动窗口限流（5 次/分钟）+ 指数封禁 + 持久化 | `src/providers/portal.ts` |
| 13 | **传输加密**：登录密码 RSA-OAEP 前端加密，明文不出浏览器 | `src/providers/portal.ts` |
| 14 | **2FA**：TOTP（RFC 6238）可选启用，pending 激活机制防止 API 静默替换用户 2FA | `src/providers/portal.ts` |
| 15 | **服务绑定**：portal/authelia/redis/nginx 全部只绑定 127.0.0.1 | `src/providers/portal.ts` 等 |
| 16 | **凭据目录加固**：config/cache 目录 0600（递归 harden），密钥只在 configDir，**state.json 永不写入 secret** | `src/config.ts` `hardenDir`；`src/state.ts` |

### 2.4 进程与配置完整性

| # | 设计 | 实现 |
|---|---|---|
| 17 | **配置写前预校验**：nginx 配置 `nginx -t` 校验失败抛错回滚 | `src/gateway.ts` |
| 18 | **动态配置校验**：Authelia `config validate` 通过才重启 | `src/authelia.ts` |
| 19 | **辅助进程隔离**：框架进程带 `SERVICE_TUNNELS_ROLE` 标记 + 内部端口注册表，双保险——发现结果与用户服务互不混同 | `src/discovery.ts` `src/internal.ts` |
| 20 | **孤儿进程清理**：guardian 守护进程在宿主崩溃/SIGKILL 时清理全部辅助进程与隧道 | `src/guardian.ts` `src/cleanup.ts` |
| 21 | **原子下载**：工具二进制下载后原子 rename，防止半成品文件被当作可用工具执行 | `src/tools.ts` `downloadTo` |

### 2.5 端口归属（Port Ownership）

| # | 设计 | 实现 |
|---|---|---|
| 22 | **隧道目标端口归属校验**：`verifyPortOwner` 确认端口监听进程属于当前用户（UID/用户名比对），他人端口需 `--force` 显式放行 | `src/discovery.ts` `verifyPortOwner` |

---

## 3. 已知风险声明（Known Risks）

以下风险**必须**如实告知用户，不可回避：

### 3.1 第三方二进制误报
- **frpc**：长期被 Kaspersky/360 等安全软件标记为 `HackTool/RiskWare`
  （VirusTotal 检出率高）——这是 **frp 项目自身被恶意软件滥用的结果**，
  与本包无关。`expose` 使用 frpc 前会打印风险提示。用户需自行加白名单或
  换用 ngrok/cloudflared。
- **ngrok**：正规签名，低-中风险；**cloudflared / authelia / nginx**：低风险。
- **未签名 exe**（如 frpc）在 Windows 触发 SmartScreen"未识别的应用"提示。

### 3.2 行为检测（Behavioral Detection）
任何"公网暴露 + 反向隧道"行为都可能被 Windows Defender 网络保护 / 企业
EDR / 网关反隧道策略拦截——这与程序名无关，是用户显式行为的预期成本。
本文档不提供绕过企业策略的方法。

### 3.3 二进制供应链（Supply Chain）
- 工具二进制从**官方源**下载（GitHub Releases / equinox / npm registry），
  失败自动回退中国镜像（Gitee/ghproxy/npmmirror）；
- 下载后运行 `--version` 做基本完整性校验；
- **⚠️ 已知缺口**：design.md §8.1 声称的 `checksums.sha256` 校验**尚未实现**。
  目前无发布者签名与哈希固定验证。这是公开发布前的高优先级待办项
  （见 §5）。

### 3.4 自托管基础设施
- bore / ssh / frpc 隧道依赖**用户自建服务器**，其安全性（鉴权、端口暴露、
  服务加固）由用户负责——本包不托管任何公共端点；
- `ssh -R` 使用 `BatchMode=yes` + `StrictHostKeyChecking=accept-new`：
  首次连接自动接受主机密钥（面向自建/测试服务器），生产环境请自行评估。

### 3.5 管理凭据
- 初始管理员密码随机生成并**只打印一次**（portal 引导），未持久化到磁盘；
  丢失需重置。

### 3.6 审计状态
- **本项目尚未经过独立安全审计**。在审计完成前，请勿在不可信多租户环境
  中部署。

---

## 4. 漏洞报告流程（Reporting）

我们认真对待安全问题。请**不要**通过公开 issue 报告安全漏洞。

### 报告渠道
1. **GitHub Private Security Advisory**（公开仓库启用后首选）：
   `https://github.com/<org>/service-tunnels/security/advisories`
2. 备用：项目维护者邮箱（公开发布时在此补充）

### 报告内容
请包含：受影响的版本范围、漏洞描述、复现步骤（含最小配置）、影响评估、
可能的缓解措施。公开密钥基础设施（PGP）将在审计完成后提供。

### 响应承诺
| 阶段 | 时限 |
|---|---|
| 确认收到 | 72 小时内 |
| 漏洞评估（影响/严重性） | 7 天内 |
| 修复版本发布（严重漏洞） | 14 天内 |
| 公开披露（修复发布后） | 合理披露期（默认 90 天协调披露） |

严重性分级遵循 [CVSS v3.1](https://www.first.org/cvss/)。

---

## 5. 审计与合规计划（Roadmap）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 发布前自查：凭据路径、日志脱敏、`--force` 审计 | 进行中 |
| 2 | **二进制 checksums.sha256 校验实现**（补齐 §3.3 缺口） | **待办（高优先）** |
| 3 | 公开发布后 1-2 个月内独立安全审计（社区/商业） | 计划 |
| 4 | 审计报告公开 + SECURITY.md 状态更新 | 计划 |
| 5 | PGP 公钥 + 联系邮箱公开 | 审计后 |

---

## 6. 附录：安全实现位置索引

| 安全点 | 源码位置 |
|---|---|
| D4 零转发 / fail-closed 认证 / SSRF / 后缀白名单 | `src/proxy.ts` |
| 发现白名单 / 端口归属校验 / 角色排除 | `src/discovery.ts` |
| 凭据目录 0600 | `src/config.ts`（`hardenDir`） |
| state.json 无 secret | `src/state.ts` |
| nginx -t 预校验 | `src/gateway.ts` |
| authelia config validate | `src/authelia.ts` |
| portal 口令/会话/限流/2FA/RSA-OAEP | `src/providers/portal.ts` |
| prototype pollution 防护 | `src/expose.ts` |
| 孤儿进程清理 | `src/guardian.ts` `src/cleanup.ts` |
| 工具下载原子性 | `src/tools.ts` |
