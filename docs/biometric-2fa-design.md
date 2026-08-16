# service-tunnels — 生物识别 2FA（人脸 / 语音）+ 记住我 设计方案

> 状态：待评审。目标版本：P0 → 0.3.41，P1 → 0.3.42，P2 → 0.3.43。
> 适用范围：**portal provider**（自包含 Node 登录门户）。authelia 自带
> WebAuthn 2FA，不在此方案内；basic/token/oauth2-proxy 不受影响。

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 动机 | TOTP 依赖随身设备；设备不在身边时 2FA 直接不可用。人脸/语音只需浏览器有摄像头/麦克风，任意机器可登录。 |
| 记住我 | 可信设备模型：勾选后会话 TTL 7d → **365d**（可配置）；**2FA 复验周期 = TTL/7（最小 1 天）**——首次登录仍需完整 2FA（记住我 ≠ 免二次验证），周期内免复验，过期直跳 2FA 步骤页（免密码）。**零新依赖**，P0 即可交付。 |
| 人脸识别 | 浏览器 `getUserMedia` 采集 → **客户端提取 128-d 人脸向量**（@vladmandic/face-api 1.7.15 IIFE，自包含 tfjs 4.22.0）→ **混合加密**上传（一次性 AES-256-GCM 载荷 + RSA-OAEP 包裹密钥，§7.2 实测修正）→ 服务端 L2 距离匹配（阈值默认 **0.6** = dlib/face-api 官方推荐；距离越小越严）。模型资产 ~8.4MB 下载到 cache，**零 npm 运行时依赖**。 |
| 资产镜像 | **已就绪并验证**：**Gitee 自有镜像** `justdb-mirrors/face-models`（7 资产已传 release，逐个下载回验 SHA-256 一致）+ jsdelivr/unpkg 官方源（§7.5）。 |
| 语音识别 | 浏览器录音 → **WebAudio 纯 JS 提取 MFCC**（radix-2 FFT + mel 滤波器组，页面内实现，零依赖）→ 78-d 向量（13 MFCC×Δ+ΔΔ×mean+std）→ 混合加密上传 → 服务端余弦相似度匹配（阈值默认 0.90）。随机 6 位数字挑战；注册质量门（样本两两余弦 ≥ 0.85）。 |
| 注册（enrollment） | 走既有管理 API（与 totpEnroll 同信任域）；**首验门**：注册后必须先成功验证一次才激活（对齐 totpPending 语义）。 |
| 安全定位 | 生物识别是**便利性备胎**，不是主因子：锁定更严（3 次/15min）、审计、阈值可调；TOTP 仍是强选项。活体 v1 仅客户端眨眼断言，服务端活体（服务端识别模式）列为 P3 加固。 |
| 依赖 | **零新 npm 依赖**：face-api 的 UMD 与模型文件按"工具下载"模式进 cache；MFCC 纯 JS 手写。 |

## 1. 背景与动机

portal 现支持 TOTP 2FA（RFC 6238）：用户注册后，登录 = 密码 → 6 位码 → 会话。
痛点：

1. **设备依赖**：TOTP 需要 Authenticator 设备在手边。手机忘带/丢失/没电时，
   即使知道密码也进不去；而服务是开发者工具隧道，用户可能正身处另一台机器
   （新环境、演示机、临时浏览器）——"人在，设备不在"是最常见场景。
2. **无替代 2FA 路径**：policy 为 two_factor 的 host 只认 TOTP，没注册 TOTP 的
   账号直接提示无法登录（`2FA is required for this host, but this account has
   no TOTP enrolled yet.`）。
3. **会话不跨浏览器**：每次都要重新登录，7 天 TTL 在频繁使用的宿主环境里偏短。

目标：提供**不依赖随身设备**的第二因子（人脸 / 语音），并为高频登录提供
**记住我**。

## 2. 目标与非目标

### 目标

- portal 用户可注册人脸 / 语音模板（任一或两者，均可与 TOTP 并存）。
- two_factor host 的 2FA 步骤可由 TOTP / 人脸 / 语音任一完成（用户有多个方法
  时出选择页）。
- 登录页提供"记住我"（可信设备）：勾选后会话有效期 365 天（默认，可配置）；
  **首次登录仍必须完成完整 2FA**（记住我 ≠ 免二次验证），之后 2FA 复验
  周期 = TTL/7（最小 1 天）——周期内免 2FA 复验，过期只需补 2FA 步骤
  （免密码）。
- 模板与采集数据的最小暴露：原始帧/录音**不落盘**，只存特征向量；上传走现有
  一次性 RSA 密钥体系上的混合加密（§7.2：向量载荷远超 RSA-OAEP 上限，
  直接 RSA 加密不可行）。
- 保持项目哲学：**零 npm 运行时依赖**、无外部二进制要求、模型资产走现有
  下载/镜像机制。

### 非目标（v1 明确不做）

- 不做深度伪造级防攻击（活体 v1 只做眨眼断言；服务端活体 = P3）。
- 不做语音内容识别（ASR 校验读出数字 = P3 可选，引入 vosk-browser WASM）。
- 不做服务端图片/音频识别模式（P3 可选，用于服务端可验证活体）。
- 不做 authelia / oauth2-proxy 的生物识别（它们各有自己的 2FA 生态）。
- 不把生物识别做成**唯一**因子（始终需要密码；生物识别只完成第二因子）。

## 3. 现状：portal 认证流与装配点

portal 认证流（src/providers/portal.ts，生成脚本 `server.mjs`）：

```
GET  {basePath}/login           密码页（issueRsaKey 一次性 RSA 公钥）
POST {basePath}/login           校验密码 →
                                - 有 totpSecret 或 host policy==two_factor：
                                  签发 COOKIE2 5 分钟 2FA 票据（200 + Set-Cookie）
                                  → 渲染 totpPage
                                - 否则直接 setSession(1FA) → 302 next
POST {basePath}/login/2fa       校验 TOTP → setSession(twoFactor=true) → 302 next
GET  {basePath}/api/authz/auth-request  探针：401 无会话 / 403 deny /
                                401 two_factor 但会话未完成 2FA / 200 放行
```

关键机制：

- 会话 cookie = `base64url(expiry.cookieName.name[.2fa]) + HMAC-SHA256 签名`，
  HttpOnly + SameSite=Strict；`TTL_MS = 7 天`（COOKIE2 票据 5 分钟）。
- 密码经一次性 RSA-OAEP（2048 位、5 分钟 TTL、单次使用）前端加密。生物
  识别上传**沿用同一一次性密钥体系但换载荷通道**：RSA 只包 32B AES 密钥，
  向量 JSON 走 AES-256-GCM（§7.2 实测修正——RSA-OAEP 单块上限 190B，
  向量载荷 KB 级，直接加密不可行）。
- 暴力防护：`brute.json`（accounts + ips 双维度滑动窗口，5 次/5min 封禁
  15min，连封翻倍 2x/4x）。
- 用户库 `users.json`：`{ displayName, salt, hash, totpSecret?, totpPending? }`，
  原子写（tmp + chmod 600 + mv），改库自动重启 portal 进程。
- host 策略：`POLICY_FILE`（host → one_factor|two_factor|deny），按请求实时读。

**装配点**：2FA 的"完成态"是会话 payload 里的 `.2fa` 标记（`issueSession` 第
四个参数）——任何 2FA 方法只要走通同一 `setSession(..., twoFactor=true)` 就与
TOTP 完全等价，authz 探针无需改动。这是本方案的核心红利。

## 4. 总览：三块改动

```
P0  2FA 方法抽象 + 选择页 + 记住我        （零依赖，可独立发布）
P1  人脸识别 2FA                          （assets 下载/服务 + 采集 + 匹配 + 注册）
P2  语音识别 2FA                          （MFCC 提取 + 挑战 + 注册/验证）
P3  加固：会话撤销列表 / 模板加密 / 服务端活体模式 / per-host 方法白名单
```

## 5. P0 — 记住我（remember me）

### 5.1 语义：会话 TTL + 2FA 复验周期两层

会话携带两个独立的时间属性：

- **会话 TTL**：不勾记住我 7 天（默认，可配）；勾选 → **365 天**（可配）。
- **2FA 复验周期（grace）**：`grace = max(TTL / 7, 1 天)`——365d 会话
  ≈ 52 天，7d 会话 = 1 天（下限）。可被 `twoFactorGraceDays` 显式覆盖。

行为规则：

1. **首次登录必须完整 2FA**（密码 + 因子）才能建立记住我状态——
   记住我 ≠ 免二次验证，只是免"每次"复验。
2. 周期内：two_factor host 的探针直接放行（会话有效且 2FA 新鲜）。
3. 周期过期（会话仍有效）：跳过密码、直跳 **2FA 步骤页**（会话已证明
   身份，只需补做 2FA）；完成后 2FA 时间戳刷新、周期重新起算。
4. 会话过期：完整重来（密码 + 2FA）。

登录页交互：

- 密码页新增勾选框 `remember`（默认不勾）；POST /login 携带。
- 2FA 阶段以隐藏字段随 next 一起透传（chooser / totp / face / voice 各页）。
- 勾选只延长**完整认证**后的会话（twoFactor 完成路径）；1FA 会话不延长
  （1FA 已是弱会话，不放大风险）。COOKIE2 票据固定 5 分钟不变。

### 5.2 实现

cookie payload 第 4 段从布尔 `.2fa` 升级为时间戳 `.2fa:<epochMs>`（最近
一次 2FA 完成时刻）；`verifySession` 返回 `{ name, twoFactorAt }`：

```ts
// portal.ts 构造/配置
const REMEMBER_TTL_MS = (opts.rememberMeTtlDays ?? 365) * 24 * 3600 * 1000;
const TTL_MS = (opts.sessionTtlDays ?? 7) * 24 * 3600 * 1000;
const GRACE_MS = Math.max(
  (opts.twoFactorGraceDays ?? Math.round((opts.rememberMeTtlDays ?? 365) / 7)) * 24 * 3600 * 1000,
  24 * 3600 * 1000, // 2FA 复验周期最小 1 天
);
```

- 探针（authz）：`two_factor && (now - twoFactorAt) > GRACE_MS` → 401
  （nginx 侧不变，仍 302 登录页）。
- 登录页 GET：检测到**有效会话但 2FA 过期** → 直接签发 COOKIE2 票据 +
  302 到 2FA 选择页（免密码路径，§6.1 复用）。
- 2FA 完成路径：`setSession(twoFactorAt = now, ttl = remember ? 365d : 7d)`
  ——时间戳只在 2FA 完成时刷新（浏览行为不滚动周期，周期语义稳定）。
- 兼容：单实例内所有 cookie 由同一版本代码签发，无新旧混读问题；重启换
  secret 全部失效（既有模型不变）。

### 5.3 安全考量

- 记住我是**每次登录的选择**，默认不勾（共享机器上长会话风险自担）。
- 365d 会话被盗 → 更长利用窗口。缓解：HttpOnly + SameSite=Strict +
  https 隧道下 Secure；审计日志记 `remember=1`；**会话撤销列表（§11
  第 1 项）因长会话而提为高优先**——365d 会话必须可吊销，必要时随 P0
  一起做。
- grace 下限 1 天：two_factor host 无论如何每天至少复验一次可被管理员
  强制（`twoFactorGraceDays: 1` 即最严）。
- 生命周期语义不变：portal 的 cookie secret 是**实例级随机、不持久化**，
  重启即失效（hosts 都变了，旧会话本来就没意义）——记住我不改变这一模型。

## 6. P0 — 2FA 方法抽象与选择页

### 6.1 方法抽象（生成脚本内）

现有 `/login/2fa` 是 TOTP 专用。改造为方法分发表 + 选择页：

```js
// server.mjs 内
const METHODS = {
  totp:  { label: "Authenticator (TOTP)",        enrolled: (u) => !!u.totpSecret },
  face:  { label: "Face recognition",            enrolled: (u) => tplFaceActive(u.name) },
  voice: { label: "Voice recognition",           enrolled: (u) => tplVoiceActive(u.name) },
};
// POST /login 密码通过后：
const available = Object.keys(METHODS).filter((m) => METHODS[m].enrolled(rec));
if (available.length === 0 && policy !== "two_factor") → setSession(1FA)
if (available.length === 0 && policy === "two_factor") → 错误页（提示先注册任一 2FA）
if (available.length === 1) → 直接渲染该方法页
else → chooser 页（三个按钮 → 各自方法页 URL）
```

方法页共享同一 COOKIE2 票据（5 分钟），全部走
`POST {basePath}/login/2fa`，body 带 `method=face|voice|totp` 区分。

### 6.2 父进程接口（auth-provider.ts）

```ts
export interface BiometricManager {
  biometricStatus(name: string): Promise<{ face: boolean; voice: boolean }>;
  biometricEnrollFace(name: string, samples: number[][]): Promise<{ pending: boolean }>;
  biometricVerifyFace(name: string, vectors: number[][]): Promise<{ matched: boolean; distance: number }>;
  biometricEnrollVoice(name: string, utterances: number[][]): Promise<{ pending: boolean }>;
  biometricVerifyVoice(name: string, vector: number[]): Promise<{ matched: boolean; similarity: number }>;
  /** portal /enroll 采集页一次性注册票（预设置路径，HMAC 签名 10min 单次使用）。 */
  biometricEnrollTicket(name: string, method: "face" | "voice"): Promise<{ token: string; method: string; expiresInMs: number }>;
  biometricDisable(name: string, method: "face" | "voice"): Promise<void>;
}
```

- `AuthUser` 增 `biometrics?: { face: boolean; voice: boolean }`（UI 装配时填充）。
- `AuthRegistry` 增 `biometricProviders()`（镜像 `totpProviders()` 的探测逻辑）。
- `totpProviders()` 保留（向后兼容），客户端侧新增 `biometricProviders` 即可。

## 7. P1 — 人脸识别 2FA

### 7.1 方案选型：客户端提取（推荐 v1）

| 维度 | 客户端提取（v1） | 服务端识别（P3 可选） |
|---|---|---|
| 原始画面 | **不出设备**（只发 128-d 向量） | 帧经隧道上传（AES-GCM 信封加密） |
| 服务端开销 | 匹配是纯数学（余弦/L2），几乎为 0 | 每请求跑检测+对齐+识别（纯 JS tfjs CPU 慢） |
| 活体验证 | 只能客户端断言（眨眼），服务端不可复核 | **服务端可复核**（多帧 landmark 序列） |
| 重放防护 | 弱（有向量即可冒充，需锁定+审计兜底） | 强（需与挑战同步的活体视频） |
| 浏览器要求 | 需支持 WebGL/WASM（现代浏览器均可） | 只需摄像头（更兼容老设备） |
| 依赖 | face-api UMD 进浏览器，服务端零依赖 | 服务端要 tfjs 运行时（重） |

v1 选**客户端提取**：隐私好、服务端零运行时依赖、契合项目哲学；重放弱点用
「更严锁定 + 审计 + 便利因子定位」兜底（§10）。P3 把服务端识别作为可选模式
补上服务端活体。

### 7.2 采集管线（登录页 JS）

1. 页面加载 `{basePath}/assets/face-api.js`（**@vladmandic/face-api
   1.7.15 IIFE 单文件**，已捆绑 tfjs 4.22.0，1.3MB，全局 `faceapi`，
   无需构建步骤）。
2. 模型从 `{basePath}/assets/models/` 加载：`tiny_face_detector_model`
   （~190KB）+ `face_landmark_68_model`（~350KB）+ `face_recognition_model`
   （~6.2MB）。
3. `getUserMedia({ video })` → 视频预览 + 引导框（脸入椭圆自动采）。
4. 每帧：检测 → 68 点对齐 → 128-d embedding（L2 归一化）。
5. 采集 3–5 帧（取检测置信度最高的）；**眨眼断言**：采集窗口内检测到一次
   闭眼→睁眼（眼睛纵横比 EAR 阈值），随 payload 上报 `blinked: true`。
6. `{ nonce, vectors, blinked }` JSON → **混合加密上传** →
   `POST {basePath}/login/2fa`（method=face），表单四字段：
   `keyId`（一次性 RSA 密钥 id）、`wrapped`（RSA-OAEP 加密的 32B AES-256
   密钥）、`iv`（12B GCM nonce）、`data`（AES-256-GCM 密文+16B tag）。

   > **实测修正（测试抓出的设计缺陷，2026-08-16）**：原方案“复用密码的
   > 直接 RSA-OAEP 加密”不可行——2048-bit OAEP-SHA256 单块上限
   > `256 − 2×32 − 2 = 190 B`，而向量 JSON 是 KB 级（1 个 128-d 向量 ≈
   > 1.9KB，3 个 ≈ 5.7KB），超限直接抛
   > `ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE`，**浏览器端同样会失败**
   > （只有真正的浏览器冒烟才会暴露，合成测试先一步抓到）。标准解法即
   > 混合加密：RSA 包裹一次性对称密钥，载荷走 AES-GCM。密码通道（小载荷
   > <190B）保持直接 RSA-OAEP 不变。

### 7.3 服务端匹配

- 模板 `templates.json`（§9）存该用户注册时的 3–5 个向量。
- 校验：`d = min_i min_j ||v_j - e_i||₂`（face-api 惯例用欧氏距离）。
   **方向澄清：距离越小越严**——0.55 比 0.6 更严而不是更松。默认取
   **0.6**：dlib 作者 Davis King 给出的经典阈值，face-api 官方示例同值；
   实测同人距离通常 < 0.5、异人通常 > 0.7，0.6 是 FAR/FRR 平衡点。
   高安全 host 可收紧至 0.5–0.55（误纳降、误拒升）。
- 命中 → `setSession(twoFactorAt = now)` → 302；未命中 → `recordFailure` +
  401 重试页。
- 阈值配置：`biometricThresholds.face`（缺省 0.6），可全局覆盖；注册时可按
  自距离校准（§10.1）。

### 7.4 防重放与活体（v1 边界，诚实声明）

- **一次性 nonce**：每次挑战签发随机 nonce（5 分钟 TTL，随 RSA 密钥同生
  死），payload 必须携带——防旧 payload 重放。
- **眨眼断言**只是客户端证据：服务端信任「页面声称检测到眨眼」。攻击者持有
  受害者向量即可在自建客户端里伪造 `blinked:true`。**这是 v1 的已知残余风险**
  （与任何"照片解锁"同级）；缓解靠 §10 的锁定/审计 + 便利因子定位，P3 的
  服务端识别模式才是真正可复核的活体。
- 摄像头缺失设备：v1 不做相册上传兜底（降低信任的通道留到 P3 评估）。

### 7.5 模型与资产管理（对齐"工具下载"模式）

- 首次使用（首个 host 启用 biometrics）时下载到 `cacheDir/bin/face-models/
  1.7.15/`（版本化目录）。下载源优先级：**自有 Gitee 镜像（国内主力）**
  → jsdelivr → unpkg；`toolMirrors.face-models` / `preferMirrors` 现有
  机制直接套用。
- 资产清单（@vladmandic/face-api 1.7.15，MIT；模型沿用
  justadudewhohacks/face-api.js weights，同 MIT）与 SHA-256：

  | 文件 | 大小（B） | sha256（前 16） |
  |---|---|---|
  | face-api.js | 1,333,943 | 0160f7af3a8c78ce… |
  | tiny_face_detector_model-weights_manifest.json | 3,219 | 5d1af4849ac48d5b… |
  | tiny_face_detector_model.bin | 193,321 | b7503ce7df31039b… |
  | face_landmark_68_model-weights_manifest.json | 8,485 | ca4886639f86e99b… |
  | face_landmark_68_model.bin | 356,840 | 4611ef65c87d836d… |
  | face_recognition_model-weights_manifest.json | 19,615 | cbaffa501b0b9275… |
  | face_recognition_model.bin | 6,444,032 | b413e420d6840b27… |

  完整哈希见镜像仓库 `manifest.json`；下载后强制校验，不匹配自动重下。
- 下载源 URL 模板（`{file}` 为上表文件名）：
  - **Gitee 自有镜像（已上传并验证，国内主力）**：
    `https://gitee.com/justdb-mirrors/face-models/releases/download/face-api-1.7.15/{file}`
  - jsdelivr：`https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/{dist|model}/{file}`
  - unpkg：`https://unpkg.com/@vladmandic/face-api@1.7.15/{dist|model}/{file}`
  - 注：registry.npmmirror.com 的 unpkg 文件 CDN 对本包 403（不在
    cnpm/unpkg-white-list 白名单），不可用。
  上传/更新脚本：`scripts/mirror-face-models-to-gitee.sh`（幂等：README +
  manifest 进 master，7 个资产挂 release）。
- portal 生成脚本增静态资源路由：`{basePath}/assets/*` → 白名单文件名映射
  （`face-api.js` + 三个模型各 2 个固定文件名），**路径严格白名单校验**
  （防穿越；只允许清单内文件）。
- 体积预算：~8.4MB。登录页按需加载（只有启用 biometrics 的站点注入脚本
  标签），不影响无 biometrics 站点的首屏。

## 8. P2 — 语音识别 2FA

### 8.1 方案选型：文本相关 + 纯 JS MFCC

语音识别在纯 JS 生态里没有"人脸识别"级别的现成库。务实方案：

- **特征**：MFCC（Mel 频率倒谱系数）——WebAudio `AnalyserNode` 或
  `OfflineAudioContext` 做 FFT，纯 JS 实现 13 维 MFCC（25ms 帧 / 10ms 步长），
  加 Δ 与 ΔΔ → 每帧 39 维；整段话语聚合成 `mean + std` → **固定长度
  78 维向量**。
- **匹配**：余弦相似度（模板向量 vs 请求向量），阈值默认 0.90（可配）。
- **文本相关挑战**：服务端签发 6 位随机数字，页面大字展示，用户朗读录制。

零依赖、无模型下载——这是 P2 能压进 0.3.43 的关键。精度是消费级"声纹解锁"
水平（FRR 偏高），定位为**便利备胎**，文档明示。

### 8.2 注册（两条路径，2026-08-16 评审新增）

**A. 预先设置（管理员）**：管理 UI/daemon 调 `biometricEnrollTicket(name, method)`
签 HMAC 票（10 分钟、单次使用）→ 打开 portal 采集页
`http://127.0.0.1:<port>{basePath}/enroll?m=voice&t=…`（facade 提供
`biometricEnrollUrl` 直接拼好）→ 采集/加密/资产全在 portal 一侧，管理 UI
只需开窗。

**B. 登录时自助（零方法账户）**：two_factor host + 用户无任何 2FA →
2FA 选择页出“立即设置”入口（/enroll）→ 采集即注册 → 完成即登录
（直接签 .2fa 会话）。**仅零方法账户开放**——已有方法者必须先过既有因子
（防密码窃贼自助加因子）；采集耗时则续签 COOKIE2 票据。

注册内容（两路径同一页面）：3 轮随机数字挑战逐次录音（与验证同文本域——
数字 vs 数字，避免短语/数字域间相似度衰减）；每轮 78-d 向量；**质量门**
= 样本两两余弦最小值 ≥ 0.85（噪声环境/他人代录直接拒）→ 写 active
（现场采集即天然首验：样本即模板，质量门代替 first-verify；管理 API
路径仍走 pending → 首验门，防 API 静默写入）。

API 直连注册（嵌入方无浏览器）：`biometricEnrollVoice(name, utterances)`
（3×78-d）+ 质量门 + pending → `biometricVerifyVoice` 首验转正。

### 8.3 验证流程（已实现）

### 8.3 验证流程

```
GET  {basePath}/login/2fa（m=voice）          页面内嵌首挑战（nonce+digits）
/enroll/challenge?m=voice                     注册页第 2/3 轮挑战（cookie/票鉴权）
页面录音（手动开始/停止，最长 8s）→ 浏览器 MFCC 提取
POST {basePath}/login/2fa（method=voice）    { nonce, vector }（同 face 混合加密）
服务端：nonce 单次消费 → 余弦(模板, vector) ≥ 阈值 → setSession
```

### 8.4 诚实声明（v1 限制）

- **不校验读出内容**（无 ASR）：随机数字挑战无法阻止"持有受害者任意语音录音
  的攻击者"——文本相关只防「拿现成固定短语录音」的顺手重放，不防定向攻击。
  缓解：3 次/15min 锁定 + 审计 + 便利因子定位。P3 可选引入 vosk-browser
  WASM（~8MB）做数字内容校验，把声纹从"是谁"升级为"是谁且在念挑战"。
- 噪声环境 FRR 上升：提示安静环境重录；阈值可配；per-user 校准（§11.1）。
- 麦克风权限被拒 / 无声设备：方法不可用，自动回退 TOTP（选择页在
  `navigator.mediaDevices` 探测失败时隐藏对应按钮）。

## 9. 注册（enrollment）流程与模板存储

### 9.1 信任域与首验门

- 注册走**既有管理 API**（与 `totpEnroll` 同一信任域：本机管理界面 /
  daemon IPC / CLI），不在公开登录页开放。
- **首验门**（对齐 totpPending 语义）：`biometricEnrollFace/Voice` 写入
  `status: "pending"`；必须 `biometricVerifyFace/Voice` 成功一次才转
  `active`——防止管理调用方静默写入劣质/伪造模板。pending 期间探针不承认该
  方法（`enrolled()=false`），不影响现有登录。
- 注册界面本身用浏览器采集（摄像头/麦克风），与管理界面同机（本地管理通常
  就在本机，天然短链路）。

### 9.2 存储：templates.json（独立于 users.json）

```jsonc
// cacheDir/tmp/portal/templates.json （0600，原子写同 users.json）
{
  "alice": {
    "face":  { "status": "active", "vectors": [[0.12, ...], ...],
               "threshold": 0.6, "enrolledAt": 1720000000000 },
    "voice": { "status": "active", "vector": [0.1, ...],
               "threshold": 0.90, "enrolledAt": 1720000000000 }
  }
}
```

- 分开存：users.json 保持可读（用户/密码/TOTP），templates.json 只有特征
  向量；两者同目录同权限。
- **不存原始媒体**（帧/音频只在浏览器内存里存在过，上传即加密向量）。
- 向量规模：人脸 128×4B×5 ≈ 2.5KB/人，语音 78×4B ≈ 0.3KB/人——可忽略。
- P3：向量 AES-GCM 静态加密（密钥 = config 目录内生成的安装级密钥，
  `templates.json` 改存密文），防 cache 目录被拷走直接读模板。

### 9.3 禁用 / 重新注册

- `biometricDisable(name, method)`：删除对应模板；TOTP 不受影响。
- 重新注册 = 先 disable 再 enroll（保持 pending→首验门不变）。
- 撤销与用户删除联动：`removeUser` 同步删 templates.json 条目。

## 10. 阈值、FAR/FRR 与锁定

### 10.1 阈值

| 方法 | 指标 | 默认 | 含义 |
|---|---|---|---|
| face | L2 距离 | ≤ 0.60 | **越小越严**；0.6 = dlib/face-api 官方推荐（同人 < 0.5，异人 > 0.7）；高安全收紧至 0.5–0.55 |
| voice | 余弦相似度 | ≥ 0.90 | 越大越严（同人同短语通常 > 0.93） |

- 全局：`biometricThresholds.{face,voice}`（portal opts / CLI）。
- **per-user 校准**（注册时可选）：以注册样本的自距离/自相似度设定
  `threshold = max(selfScore) × margin`（margin 默认 0.9），使阈值贴合
  该用户的环境噪声——高噪声环境自动放宽，低噪声环境收紧。

### 10.2 锁定与滥用防护

- 生物识别失败**不计入密码失败**，独立计数：`brute.json` 新增
  `bio-face:<name>` / `bio-voice:<name>` 键，**3 次 / 15 分钟封禁**（比密码
  的 5 次更严——概率匹配器 + 重放暴露需要更紧的闸）。
- 挑战签发限流：每 IP 每分钟 ≤ 10 次 challenge（防扫描/CPU 滥用；
  匹配本身是纯数学，开销小，但 challenge 有 RSA 密钥签发成本）。
- 命中/未命中全部审计：`portal: face verify ok for alice (d=0.31)` /
  `portal: face verify fail for alice (d=0.65) threshold=0.6`。

## 11. P3 加固清单（后续版本）

1. **会话撤销列表**：`setSession` 时签发随机 session id 记入
   `users.json.sessions[]`；authz 探针检查撤销态；管理界面「设备列表 → 吊销」。
   记住我的长会话因此可定向作废。
2. **服务端识别模式**（可选）：浏览器上传加密帧流（AES-GCM 信封 + RSA 包
   裹），服务端跑检测/对齐/识别 + **服务端眨眼/动作复核**——真正可复核活体。
3. **语音内容校验**：vosk-browser WASM 校验随机数字读音（把声纹升级为
   声纹+内容双因子）。
4. **per-host 方法白名单**：`registerHost(host, { policy, methods })` 允许
   host 级限定可用 2FA 方法（如管理 host 只许 TOTP）。
5. **模板加密**（§9.2）与导出/备份工具（`portal export-templates` 脱敏版）。

## 12. 接口与代码变更清单

### 12.1 src/auth-provider.ts

- `AuthUser` 增 `biometrics?: { face: boolean; voice: boolean }`。
- 新增 `BiometricManager` 接口 + `isBiometricManager()` 判别。
- 注释：totpProviders 语义扩展为「任何本地 2FA 方法管理」的探测基础。

### 12.2 src/providers/portal.ts（父进程）

- opts 增：`biometrics?: boolean | ("face"|"voice")[]`、
  `biometricThresholds?: { face?: number; voice?: number }`、
  `sessionTtlDays?: number`、`rememberMeTtlDays?: number`、
  `twoFactorGraceDays?: number`（缺省 TTL/7，最小 1）。
- 实现 `BiometricManager`（读/写 templates.json、匹配、校准、首验门转正）。
- `defaultTotpLabel` 不动；`totpProviders()` 探测兼容。
- `writeServerScript` 生成脚本增：chooser/face/voice 页面、challenge 签发、
  静态 assets 路由、方法分发表、bio 锁定键。

### 12.3 生成脚本 server.mjs（模板字符串内）

- 新路由：
  - `GET  {basePath}/login/2fa`（chooser 或单方法直跳）
  - `POST {basePath}/login/2fa`（method=totp|face|voice 分发表；TOTP 分支
    保持原逻辑）
  - `GET  {basePath}/login/2fa/face-challenge` / `voice-challenge`
  - `GET  {basePath}/assets/*`（白名单静态文件）
- 新函数：`htmlChooser`、`htmlFace`、`htmlVoice`（busy 过渡层 + escapeAttr
  沿用；加密走 §7.2 混合通道——AES-256-GCM 载荷 + RSA 包裹密钥，密码页
  保持直接 RSA-OAEP）、`decryptHybrid`、face 挑战 nonce 表。
- `setSession` 增 `ttl` / `twoFactorAt` 传参（remember me + 复验周期）。
- authz 探针：`two_factor` 判定从布尔改为复验周期比较（§5.2）；nginx 侧
  **零改动**（仍只认 200/401/403）。

### 12.4 src/ui-api.ts / daemon-server.ts / cli.ts

- `/api/user-list`、`/api/user-summary` 增 biometrics 列。
- 新端点：`biometric-enroll-face`、`biometric-verify-face`、
  `biometric-enroll-voice`、`biometric-verify-voice`、`biometric-disable`。
- daemon-server 镜像方法；cli 增 `sts user biometric-status|enroll-face|...`。
- i18n.ts 增 `ui.biometric*` 键（en/zh），AUTH_PARAM_SCHEMAS.portal 增
  `biometrics` / `rememberMeTtlDays` 表单项（客户端无需改代码即出表单）。

### 12.5 配置与 CLI

```jsonc
// portal provider opts（config.json auth.provider=="portal" 时）
{ "portal": {
    "biometrics": true,                    // true=全部 | ["face"] | ["voice"]
    "biometricThresholds": { "face": 0.6, "voice": 0.90 },
    "sessionTtlDays": 7,                   // 不勾记住我的会话 TTL
    "rememberMeTtlDays": 365,              // 勾选记住我 → 会话 TTL
    "twoFactorGraceDays": 52               // 2FA 复验周期（缺省 TTL/7，最小 1）
} }
// CLI
--portal-biometrics face,voice  --remember-me-ttl-days 365
```

## 13. 安全模型更新（SECURITY.md 增量）

- **2.3 凭据与会话**：补生物识别向量存储（不存原始媒体、0600、P3 加密）、
  一次性密钥体系上的混合加密传输（§7.2）、记住我 cookie 语义（可信设备：
  365d 会话 + TTL/7 复验周期，首次仍需完整 2FA）。
- **3. 已知风险**新增：
  - 生物识别**不是秘密**：模板泄露的补救是重新注册，不是改密码。
  - 重放/活体边界：v1 客户端眨眼断言可被持有受害者向量的攻击者伪造；
    语音 v1 不校验内容。缓解 = 更严锁定 + 审计 + 便利因子定位。
  - 误纳（FAR）：阈值可调；face 默认取官方推荐 0.6（高安全可收紧
    0.5–0.55）且失败即锁定，误纳暴露窗口受锁定制约。
  - 记住我长会话被盗：审计标记 + 会话撤销列表（P3 第 1 项；长会话必须
    可吊销，必要时提前到 P0）。
- **隐私说明**：摄像头/麦克风仅在登录/注册页请求权限；原始画面/录音不离开
  浏览器（v1）；上传的仅特征向量，加密传输；服务端只存向量。

## 14. 分期实施与版本目标

| 版本 | 内容 | 验证 |
|---|---|---|
| 0.3.41 (P0) ✅ 已实现（portal.ts + portal.test.mjs） | 2FA 方法抽象 + chooser 页 + remember me | 现有 TOTP 全回归（方法分发表后 TOTP 行为不变）✓；新测试：remember TTL（微型 TTL 压缩时间轴）、grace 过期→免密码直跳 2FA→补因子恢复、1FA 不延长、零方法错误页、无 method 字段向后兼容、未知 method 400 |
| 0.3.42 (P1) ✅ 已实现 | 人脸：assets 下载/服务、登录页采集、服务端匹配、注册 API、阈值/锁定 | ✓（合成向量集成测试：混合加密链路、nonce 单次消费、眨眼断言、阈值拒绝、3 次锁定、assets 白名单/穿越拒绝；真实下载链路已验证 8.0MB + SHA-256） |
| 0.3.43 (P2) ✅ 已实现 | 语音：MFCC 提取、挑战、注册/验证、阈值/锁定；**两条注册路径**（登录时自助 + 管理票） | ✓（合成向量集成测试：3 轮挑战注册、登录验证、错误向量 3 次锁定、cookie 路径零方法限制、票单次使用/伪造拒签、质量门拒绝劣质样本） |
| 0.4.x (P3) | §11 加固清单 | 逐项 |

## 15. 测试计划

- **单元**（node --test，无浏览器）：
  - L2 距离 / 余弦相似度边界（阈值±ε）。
  - MFCC 提取对黄金输入（正弦/白噪声合成信号）的输出向量。
  - templates.json 原子写、pending→active 首验门、disable、removeUser 联动。
  - bio 锁定计数（3 次封禁）与 challenge 限流。
  - remember me：cookie payload 内 expiry = 365d vs 7d；`.2fa:<ts>` 复验
    周期边界（周期内放行 / 过期→直跳 2FA 页 / floor 1d）。
- **集成**（真实 spawn portal server，沿用 probe 模式）：
  - 密码 → 2FA 票据 → 各方法页 200 + Set-Cookie COOKIE2。
  - 合成向量走**混合加密通道** POST → 阈值内放行（`.2fa` 会话 → authz
    200）、阈值外 401 + 锁定。回归用例（实测缺陷防线）：大载荷直连
    RSA-OAEP 必须报 `DATA_TOO_LARGE`，混合通道同载荷成功——防止后续
    改动退回直接 RSA。
  - policy=two_factor 且用户只有 face → face 完成即放行；无任何方法 →
    错误页。
  - 多方法用户 → chooser 渲染。
- **e2e（手工冒烟）**：真摄像头/麦克风完整注册+登录；拒绝权限 → 按钮隐藏
  回退 TOTP；浏览器无 WebGL/WASM → face 不可用回退。

## 16. 备选方案：WebAuthn / 平台认证器（长期评估）

行业标准答案其实是 **WebAuthn 平台认证器**（Windows Hello / Face ID / Touch
ID）：由操作系统在可信硬件里做人脸/指纹验证，**生物数据不出设备**、内置
nonce 挑战与活体、免模板存储。优势显著，但：

- 平台认证器绑定 OS/设备——**恰恰解决不了"设备不在身边"**（除非走 iCloud/
  Google 同步通行密钥，又回到"需要随身设备"）。
- 服务端需 FIDO2 校验（CBOR 解析 + 签名验证），纯 Node 可写但引入不小
  复杂度；且无摄像头/指纹硬件的台式机无法注册平台通行密钥。
- 结论：**方案内模板匹配是"任意机器可登录"的唯一路径**；WebAuthn 可作为
  P3 后的补充 2FA 方法（管理界面注册、登录页透传），两者共存。

## 17. 待决策问题

1. 人脸 v1 客户端提取 vs 服务端识别：推荐客户端提取（隐私+零服务端依赖），
   接受重放残余风险；若更看重服务端可复核活体，P1 直接改服务端识别
   （+tfjs 运行时依赖，体积与兼容性代价见 §7.1）。
2. 语音 v1 是否接受"不校验读出内容"？推荐接受（P3 再引 vosk-browser）。
3. biometrics 默认关闭（opt-in）是否可接受？建议默认关——阈值需现场调。
4. 会话撤销列表是否提前到 P0（365d 长会话的配套吊销能力）？

已决策（2026-08-16 评审）：

- **记住我 = 可信设备模型**：勾选后会话 TTL 365d（可配）；2FA 复验周期 =
  TTL/7、最小 1 天；首次登录仍需完整 2FA（记住我 ≠ 免二次验证），周期内
  免复验、过期直跳 2FA 步骤页（免密码）。
- **人脸阈值默认 0.6**（dlib/face-api 官方推荐；L2 距离越小越严，
  0.55 是收紧档不是放松档）。
- **资产镜像**：Gitee 自有仓库 `justdb-mirrors/face-models`（§7.5，
  上传脚本 `scripts/mirror-face-models-to-gitee.sh`），jsdelivr/unpkg 作
  官方源，npmmirror 文件 CDN 不可用（白名单）。
