# Face 2FA 浏览器资产 CDN 化 + justget-browser 竞速下载方案

> 状态：方案定稿；P1 组件 justget/browser 已实现，评审见 §8（2026-08-23，
> 发现 2 个阻断 bug 待修复后方可集成）。日期：2026-08-23。
> 关联：[biometric-2fa-design.md](biometric-2fa-design.md) §7.5（资产镜像）、
> st-face-assets 仓库（Gitee 镜像 + manifest.json 权威 SHA-256 清单）。
> 本方案分两档：**P0 无新依赖可先行**（CDN 优先 + SRI + 本站回退），
> **P1 依赖 justget-browser**（竞速下载）——本文档同时作为 justget-browser
> 的需求规格与测试语料清单。

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 问题 | face 2FA 每次验证页要下 ~8.36MB（face-api.js 1.33MB + 3 模型 7MB）；隧道 origin（host:port）不固定 + 本站缓存头仅 `max-age=3600` → 频繁全量重下，最痛是 6.44MB 识别模型。 |
| 关键事实（修正） | 现代浏览器 **HTTP 缓存双键分区**（top-frame site + 资源 origin；Chrome 86+ / Firefox 85+ / Safari），**换隧道 origin 后连 CDN 资源也缓存未命中**。CDN 化 ≠ 一次下载永久受益；真实收益 = ① 稳定 origin 时 immutable 缓存生效、② 资产走公网 CDN 不占隧道带宽（SSH/WAN 隧道常是最慢一环）、③ 公网直连通常更快。**频繁换 origin 场景的解药是"下得快"——justget-browser 竞速/分片/续传，因此它是方案核心组件而非锦上添花。** |
| 候选源 | **jsdelivr**（Range✓ CORS✓ immutable✓，实测最快）→ **unpkg**（Range✓ CORS✓）→ **Gitee 镜像**（CORS✓、Range✗、国内主力）→ 本站 `/assets/`（同源保底）。npmmirror 文件 CDN 全 403（白名单），排除。 |
| 完整性 | SHA-256 全量校验：jsdelivr/unpkg 7/7 文件与 Gitee 镜像 manifest 完全一致；face-api.js 用 SRI（`integrity` + `crossorigin`）浏览器级校验；模型经 justget-browser 下载后 digest 校验再喂模型。 |
| 页面改造 | facePage：CDN SRI script 优先 + `onerror` 回退本站；模型 `loadFromUri(CDN base)` 失败回退本站；**预取提前到 login/chooser 页**（用户还没选 face 就开始拉）；本站 assets 路径版本化 + `max-age=31536000, immutable`。 |

## 1. 资产清单（权威，与 st-face-assets/manifest.json 一致）

包：`@vladmandic/face-api@1.7.15`（IIFE，含 tfjs 4.22.0；MIT）。

| # | 文件 | 大小(bytes) | SHA-256 | 用途 |
|---|---|---|---|---|
| 1 | `dist/face-api.js` | 1,333,943 | `0160f7af3a8c78cece45c7ecc765383bad74becfd438bb787cdd627b2d6f2cf6` | face-api IIFE bundle |
| 2 | `model/tiny_face_detector_model-weights_manifest.json` | 3,219 | `5d1af4849ac48d5b985f4a9b16010c512353ddd6fcc63d50fd0bc9e9e64296e5` | 检测模型清单 |
| 3 | `model/tiny_face_detector_model.bin` | 193,321 | `b7503ce7df31039b1c43316a9b865cab6a70dd748cc602d3fa28b551503c3871` | 检测权重 |
| 4 | `model/face_landmark_68_model-weights_manifest.json` | 8,485 | `ca4886639f86e99b39fed0c155f81b63317225773bd9616716e887b0153389c9` | 对齐模型清单 |
| 5 | `model/face_landmark_68_model.bin` | 356,840 | `4611ef65c87d836d03d684b30eec4d195d8b219fa1dd58fc58945831c6b9299b` | 对齐权重 |
| 6 | `model/face_recognition_model-weights_manifest.json` | 19,615 | `cbaffa501b0b9275a12b63357a6843e7e30c054e1c9151e1a5f879b26e32986b` | 识别模型清单 |
| 7 | `model/face_recognition_model.bin` | 6,444,032 | `b413e420d6840b2775fba32008db6f3cddb07d485967fb42cfcf379c16a8c589` | 识别权重（大头） |

合计 8,359,455 bytes ≈ 8.36MB。其余页面（login/chooser/totp/voice/enroll）
CSS/JS 全内联、零外部资源，无需处理。

## 2. 候选源实测矩阵（2026-08-23，本机实测）

| 源 | URL 模板 | 全量 SHA-256 校验 | CORS | Range | 缓存头 | 速度样本（服务端） |
|---|---|---|---|---|---|---|
| jsdelivr | `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/{path}` | ✅ 7/7 一致 | ✅ `*` | ✅（3 片重组验证一致）| `max-age=31536000, immutable` | 全量 20.9s；6.4MB 4.4s |
| unpkg | `https://unpkg.com/@vladmandic/face-api@1.7.15/{path}` | ✅ 7/7 一致 | ✅ `*` | ✅（2 片重组验证一致）| `max-age=31536000` | 全量 27.0s；波动较大 |
| Gitee 镜像 | `https://gitee.com/justdb-mirrors/face-models/releases/download/face-api-1.7.15/{平铺文件名}` | ✅（node 端已用，即镜像本体）| ✅ 最终 200 带 `ACAO: *`（302→302→200）| ❌ 忽略 Range（返回整文件）| 未标长缓存 | 未逐项测（国内主力） |
| npmmirror | `https://registry.npmmirror.com/@vladmandic/face-api/1.7.15/files/{path}` | ❌ 全 403（unpkg 白名单拦截）| — | — | — | 排除，仅留作负样本 |
| 本站 `/assets/`（portal） | `{隧道origin}{BASE}/assets/face-api.js`、`{BASE}/assets/models/{文件}` | ✅（服务端下载时已校验）| 同源 | ❌（当前实现整文件吐出）| `max-age=3600`（待修）| 取决于隧道带宽 |

浏览器内实测（Firefox，测试页 `/tmp/cdn-candidate-test/index.html`）：
13/14 格完成，jsdelivr/unpkg 全部 ✓（SHA-256 匹配 + 典型速度
face-api.js ~2s、6.4MB jsdelivr 4.4s ~1.4MB/s）；**④ 端到端
（SRI script + loadFromUri 三模型）未跑完即暂停，待补**。

注意事项：
- jsdelivr Range 响应的 `content-range` 总长显示压缩表示长度
  （如 3,930,930 ≠ 6,444,032），**字节偏移实际正确**（已用 3 片重组
  SHA-256 验证）。justget-browser 解析 content-range 总长时需容忍该假象，
  以我们提供的期望 size 为准。
- Gitee 下载经 302 跳转至 `attach_files` 签名 URL，最终响应带 CORS 头，
  浏览器 `fetch` 跟随重定向后可用；但签名 URL 不可缓存/预签，竞速时
  每次从 release 入口发起。
- 缓存分区（Chrome 86+ / Firefox 85+ / Safari）：HTTP 缓存键 =
  (top-frame site, 资源 origin)。隧道页内拉 CDN 资源，缓存落在
  「隧道 site × CDN origin」分区，**换隧道 origin = 缓存未命中**。
  any 浏览器侧存储（Cache Storage / IndexedDB / SW）都是 per-origin，
  无法跨隧道共享——这是平台限制，justget-browser 不必尝试解决，
  但应把「命中即省」做到稳定-origin 场景的最优。

## 3. 方案设计

### 3.1 P0：CDN 优先 + SRI + 本站回退（无新依赖，可先行）

`facePage` 改造（portal.ts）：

1. **face-api.js**：
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js"
           integrity="sha256-{base64}" crossorigin="anonymous"
           onerror="this.remove();var s=document.createElement('script');s.src='{BASE}/assets/face-api.js';s.onload=window.__fa;document.head.appendChild(s);">
   ```
   SRI 哈希由 FACE_ASSETS 清单在服务端渲染时内联（sha256 hex → base64）。
2. **模型**：`loadFromUri(CDN_MODEL_BASE)`（jsdelivr `…@1.7.15/model/`），
   catch 后回退 `loadFromUri({BASE}/assets/models/)`。CORS 头已验证。
3. **回退保底不变**：内网/离线/CDN 被墙时本站 assets 自举（服务端已把
   资产下载到 `cacheDir/bin/face-models/<ver>/`）。
4. **预取提前**：login 页与 2FA chooser 页加
   `<link rel="preload" as="script" href="{cdn}/dist/face-api.js" crossorigin>`
   + 对模型 URL 的 idle prefetch（`requestIdleCallback` + 低优先级 fetch），
   用户点到 face 验证页时大概率已在缓存/进行中。
5. **本站缓存头修正**：路径版本化
   `/assets/face-1.7.15/{file}` + `max-age=31536000, immutable`
   （现状 1h，stable-origin 场景也在白白重下）。
6. **首源可配**：`SERVICE_TUNNELS_FACE_CDN` 环境变量覆盖 CDN 前缀
   （默认 jsdelivr；内网全局走本站时可设为空禁用 CDN）。

### 3.2 P1：justget-browser 竞速下载（就绪后替换 P0 的静态 CDN 逻辑）

- face-api.js 与 7 资产统一走 `justgetBrowser.download({urls:[…按能力排序的镜像], sha256, size})`：
  竞速择快、分片并行（仅 Range 源）、校验失败自动降级、断点续传。
- 拿到校验过的 ArrayBuffer 后：
  - face-api.js → `new Blob([buf]).URL` 注入 `<script src=blobURL>`（绕开
    SRI 需求，因已 digest 校验）。
  - 模型 → 首选仍 `loadFromUri(CDN base)`（最简单、CORS 已通）；
    **直接喂 buffer 待验证**：face-api `load()` 公开签名只接受 URI 或
    `Float32Array`（量化 bin 不是裸 float32），需走 bundle 内部的
    `weightUrlConverter` 钩子或 manifest+blob-URL 方案，实施时验证；
    不可行则维持 loadFromUri（竞速收益主要体现在下载阶段，不冲突）。
- 进度条：期望 size 已知（清单），6.4MB 大文件体验改善明显。

### 3.3 与隧道的关系

- 隧道链路（浏览器→隧道边缘→nginx→node）不再承载 8.36MB（除非回退），
  缓解窄隧道带宽；nginx inject / transformResponse 注入路径不受影响
  （face 页资产请求是子资源 fetch/script，非导航注入对象）。

## 4. justget-browser 需求规格（portal 视角）

**输入**（每次一个文件）：

```ts
justgetBrowser.download({
  urls: [
    { url: "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/face_recognition_model.bin", range: true },
    { url: "https://unpkg.com/@vladmandic/face-api@1.7.15/model/face_recognition_model.bin", range: true },
    { url: "https://gitee.com/justdb-mirrors/face-models/releases/download/face-api-1.7.15/face_recognition_model.bin", range: false },
    { url: location.origin + BASE + "/assets/models/face_recognition_model.bin", range: false, sameOrigin: true },
  ],
  size: 6444032,          // 期望字节数（我们清单已知）
  sha256: "b413e420…",    // 期望哈希
  signal: abortSignal,    // 取消
  onProgress({ loaded, total, sourceUrl }),
}) => Promise<{ buffer: ArrayBuffer, sourceUrl: string, fromCache: boolean, elapsedMs: number }>
```

**行为要求**：
1. **竞速**：并发发起（或首字节竞速后提交最快者），单源超时
   （如 3s 无首字节）自动淘汰；失败/慢速不断降级到下一源，最后保底
   sameOrigin。
2. **分片并行**（可选增强）：对 `range: true` 源用 Range 分片并行拉取
   拼装（aria2 风格），大文件提速关键。**注意**：不能信任 content-range
   里的总长（jsdelivr 压缩表示假象），以入参 `size` 为准；分片拼装后
   必须 SHA-256 终验。
3. **校验与降级**：size 或 sha256 不符 → 丢弃该源结果，自动换下一源。
4. **缓存**：命中即省（Cache Storage，key=规范 URL + 版本，SHA 复验后
   直接返回）。注意浏览器分区限制：缓存随隧道 origin 走，不追求跨
   origin 共享。
5. **不安全上下文降级**：`crypto.subtle` 仅 secure context 可用——
   需要 SHA-256 校验时内置纯 JS 实现 fallback（或调用方声明跳过校验）。
   （注：face 2FA 本身依赖 getUserMedia，同样要求 secure context，
   http 隧道下 face 方法本就不可用，约束对齐。）
6. **语义**：不抛网络错误直到所有源穷尽；返回实际命中的 `sourceUrl`
   便于打点。

**非目标**：跨浏览器 profile 共享、绕过缓存分区、本地文件系统持久化。

## 5. 测试语料：完整 URL 清单（justget-browser 测试用）

三个 URL 模板（`{path}` 取下表）：

- J = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/{path}`
- U = `https://unpkg.com/@vladmandic/face-api@1.7.15/{path}`
- G = `https://gitee.com/justdb-mirrors/face-models/releases/download/face-api-1.7.15/{平铺文件名}`（Gitee 用 basename）

| {path}（J/U） | {平铺文件名}（G） | size | sha256 |
|---|---|---|---|
| `dist/face-api.js` | `face-api.js` | 1333943 | `0160f7af3a8c78cece45c7ecc765383bad74becfd438bb787cdd627b2d6f2cf6` |
| `model/tiny_face_detector_model-weights_manifest.json` | 同名平铺 | 3219 | `5d1af4849ac48d5b985f4a9b16010c512353ddd6fcc63d50fd0bc9e9e64296e5` |
| `model/tiny_face_detector_model.bin` | 同名平铺 | 193321 | `b7503ce7df31039b1c43316a9b865cab6a70dd748cc602d3fa28b551503c3871` |
| `model/face_landmark_68_model-weights_manifest.json` | 同名平铺 | 8485 | `ca4886639f86e99b39fed0c155f81b63317225773bd9616716e887b0153389c9` |
| `model/face_landmark_68_model.bin` | 同名平铺 | 356840 | `4611ef65c87d836d03d684b30eec4d195d8b219fa1dd58fc58945831c6b9299b` |
| `model/face_recognition_model-weights_manifest.json` | 同名平铺 | 19615 | `cbaffa501b0b9275a12b63357a6843e7e30c054e1c9151e1a5f879b26e32986b` |
| `model/face_recognition_model.bin` | 同名平铺 | 6444032 | `b413e420d6840b2775fba32008db6f3cddb07d485967fb42cfcf379c16a8c589` |

**能力矩阵**（测试时按此配置 range 标志）：
J=Range✓/CORS✓/immutable✓；U=Range✓/CORS✓；G=Range✗/CORS✓（302 链）；
npmmirror（`https://registry.npmmirror.com/@vladmandic/face-api/1.7.15/files/{path}`）
= **403 负样本**（验证 403 降级路径）。

**建议测试场景**：
1. 三源竞速全成功，返回最快者，SHA-256 一致；
2. npmmirror 403 → 降级下一源；
3. 哈希篡改样本（size 对/哈希错）→ 丢弃并降级；
4. jsdelivr 分片拼装 6.4MB → SHA-256 终验一致（对照 content-range 假象）；
5. 全源失败 → 抛错（portal 捕获后走本站静态回退）；
6. 二次调用同 URL → Cache Storage 命中（`fromCache: true`，<50ms）；
7. http 非安全上下文（或模拟无 crypto.subtle）→ 纯 JS SHA-256 fallback。

浏览器端对照测试页已就绪：`/tmp/cdn-candidate-test/index.html`
（下载耗时/大小/SHA 校验 × 3 源矩阵 + SRI 加载 + 真实 loadFromUri 路径；
④ 场景跑完即归档结论）。

## 6. 实施步骤（portal.ts）

1. `FACE_ASSETS` 增加浏览器端 CDN URL 生成（jsdelivr/unpkg 模板）与
   SRI base64 哈希；`SERVICE_TUNNELS_FACE_CDN` 覆盖开关。
2. `facePage`：script 标签 SRI + onerror 回退；模型 base = CDN，catch 回退
   本站（现有 `/assets/` 路由保持）。
3. `loginPage`/`chooserPage`：idle 预取（preload + 模型低优 fetch）。
4. `/assets/` 路由：版本化路径 + immutable 缓存头（兼容旧路径 301）。
5. 测试：`npm test` 增加 assets 路由与回退顺序 case。
6. P1 就绪后：接 justget-browser，页面端用配置注入（不打包进 bundle，
   参考 launcher 注入模式）。

## 7. 风险与开放问题

- **缓存分区**：换 origin 必重下（平台限制），方案以「稳定 origin 缓存
  + 换 origin 快下」组合应对；预期管理已写入 §0。
- **模型哈希校验 vs loadFromUri 直连**：loadFromUri 无法逐文件校验；
  P0 接受「HTTPS + CDN 厂商完整性」级别（与 SRI 的差距仅模型文件），
  P1 由 justget-browser 下载校验后统一解决。
- **直接喂 buffer**：`load()` 仅收 URI/Float32Array，`weightUrlConverter`
  路径待实施验证；不可行则 P1 模型仍 loadFromUri（竞速收益保留在
  face-api.js 与预取阶段）。
- **④ 端到端测试**（SRI + loadFromUri 三模型）未跑完，实施前补。
- 内网无公网：本站回退已覆盖；CDN 失败路径需有超时上限，避免
  face 页长时间空转（预取可掩盖大部分延迟）。

## 8. justget-browser 实现评审（2026-08-23）

实现位置：`~/workspace/justget/src/browser/`（入口 `index.ts`，核心
`core/downloader.ts` 331 行 + `core/http.ts` 117 行，工具
`utils/{cache,hash,buffer}.ts`），文档 `README.browser.md`，
测试页 `tests/browser-test.html`（已直接使用本文档 §5 的 7 资产语料
+ 三源 + sha256 + npmmirror 负样本，可直接复用）。

### 8.1 与 §4 需求规格的对照

| 需求（§4） | 实现状况 |
|---|---|
| 多源竞速、逐步释放、先完成胜出 | ✅ 主源预热 5s → 速度<512KB/s 逐个放镜像；>2MB/s 不放；慢源替换（1/3 阈值 + 连续检测） |
| 失败降级 | ✅ 网络层：isImmediateFailure（HTTP 4xx/5xx）→ 立即放出全部镜像；**❌ checksum 不匹配不降级**（见 8.2-③） |
| SHA-256 校验 | ✅ Web Crypto digest；md5 不支持（Web Crypto 限制，文档已注明，我们用 sha256 无影响） |
| uint8array 直喂 | ✅ `responseType: 'uint8array'` |
| 进度/耗时/胜出源 | ✅ onProgress（percentage/speed/eta/逐源）+ result.sources[] |
| 缓存命中即省 | ✅ 设计取巧：**整文件 GET（不用 Range）→ 浏览器 HTTP 缓存自然命中**，优于自建 Cache Storage（不双份存储、jsdelivr immutable 直接生效）；另附 localStorage 学习型缓存（7d TTL，记住胜出镜像下次提主站） |
| 分片并行 | ❌ 有意不做（见 8.3 讨论，同意此取舍） |
| 非安全上下文 fallback | ❌ 无纯 JS sha256 fallback（但我们场景 face 2FA 本身要求 secure context，约束对齐，不阻塞） |
| `expectedSize` 参数 | ❌ 无（见 8.2-④，建议补） |

### 8.2 发现的问题（按严重度）

**① 阻断：exports 路径错误，`justget/browser` 无法 import。**
package.json `exports["./browser"]` 指向 `./dist/browser/browser/index.js`，
但 tsconfig.browser.json 用 `rootDir: ./src`，实际产物是
`./dist/browser/index.js`（已验证 `dist/browser/browser/` 不存在；
node 实测 `import('justget/browser')` → `Package subpath './browser'
is not defined`）。修法：exports 改为 `./dist/browser/index.js`
（或调整 outDir 迎合现有 exports，但前者更顺）。

**② 阻断（对测试页）：CDN 加载路径 404。**
tests/browser-test.html 里
`import('https://cdn.jsdelivr.net/npm/justget@0.2.0/dist/browser/index.js')`
不可用：公共 npm 上 justget 最新为 0.1.7（0.2.x 当时尚未发官方源），
jsdelivr/unpkg 只镜像公共 npm，且即使发布后路径也需对（见①）。
结论：**portal 集成必须同源自托管**——参照 service-tunnels 既有
`scripts/build-justget.mjs`（esbuild bundle→`src/vendor/justget/justget.mjs`
的 node 侧先例），新增 browser 变体：
`esbuild node_modules/justget/dist/browser/index.js --bundle
--format=esm --platform=browser` → 单文件 IIFE/ESM，由 portal
`/assets/justget-browser.js` 提供（版本化路径 + immutable，同 face 资产
待遇）。测试页改用相对路径/同源加载。

**③ 行为缺陷：checksum 不匹配 = 硬失败，不降级。**
现流程：胜者完成后 abort 其余源 → digest 校验 → 不匹配直接 throw。
若某个镜像被污染/损坏且恰好竞速胜出，整个下载失败（而此时其它源
本可接管）。建议：不匹配时把胜者 URL 记入负缓存（localStorage
学习缓存的对称操作），从候选中剔除后重跑竞速，直至穷尽或某源校验
通过。portal 侧的临时包装：catch 后回退同源 `/assets/`（保底不受此
缺陷影响，但公网竞速的抗污染能力应做进库里）。

**④ 建议：`options.expectedSize`。**清单已知精确字节数；传入可
(a) 跳过每个文件前置 HEAD 探测（现状每文件多一个 RTT，Gitee 走
302 链更贵；7 文件 = 7 次额外往返），(b) 早期 sanity 校验。
顺带：HEAD 探测当前必发，即使调用方给齐 size/sha；非必需时应可关。

**⑤ 小问题**：`probe()` 导出但下载器未用（准死代码）；
`waitForCompletion` 超时为 `timeout*3`（300s×3=15min）无文档说明；
README.browser.md 的 face-api 集成示例用了 `loadFromBuffer(...)` ——
**该方法在 @vladmandic/face-api 1.7.15 不存在**（bundle 内 0 处出现，
`load()` 仅接受 URI 字符串或 Float32Array），示例需改为 fetch 拦截或
blob-URL 方案（见 §8.4）。

### 8.3 设计取舍讨论：不做分片（同意）

我在 §4 把「Range 分片并行」列为可选增强；实现选择了整文件，理由
成立：分片拼装会绕开浏览器 HTTP 缓存（缓存里只落 Range 响应，拼装
产物不可复用），而整文件 GET 一次落缓存，同 origin 二次访问 ~0ms。
在缓存分区现实下，同 origin 场景整文件严格更优；换 origin 场景靠
竞速。实测补充：**jsdelivr 对 .bin 会 gzip（6.4MB→约 4.05MB 传输，
unpkg 不压）**，浏览器透明解压后字节正确（checksum 在解压后字节上
计算，不受影响；HEAD content-length 为原始长度，进度分母正确）——
jsdelivr 作为默认主源的理由又多一条。

### 8.4 portal 集成形状（P1 实施依据，更新 §3.2）

1. **justget-browser 加载**：portal `/assets/justget-browser-<ver>.js`
（esbuild 单文件 bundle，同源，不依赖任何公网 CDN——见 8.2-②）。
2. **face-api.js（1.33MB）**：走 justget（uint8array + sha256 校验 +
   竞速）→ `Blob` → `createObjectURL` → 动态 `<script>` 注入。
   不再用 SRI（digest 已等价校验）；失败回退现有同源 `/assets/` 直载。
3. **模型（7MB）**：justget 逐文件下载（uint8array + sha256）后，
   **拦截 `window.fetch`** 命中 6 个模型 URL → `new Response(uint8array)`
   喂给 `faceapi.nets.*.loadFromUri()`（face-api `load()` 仅收 URI/
   Float32Array，`loadFromBuffer` 不存在、`weightUrlConverter` 未被
   loadFromUri 暴露——fetch 拦截是最小改动路径，实施时验证）。
4. **源序**：主源 jsdelivr → unpkg → Gitee 镜像 →（portal 注入的）
   同源 `/assets/` 兜底；localStorage 学习缓存自动记忆胜者。
5. **进度**：face 页 Loading 文案接 onProgress percentage。

### 8.5 修复后待补的验证

- [x] exports 修复后 `import { download } from 'justget/browser'` 实测（0.2.2 已发内部源验证）
- [x] browser bundle（esbuild 单文件）经 portal `/assets/` 加载实测
- [x] 三源竞速 + npmmirror 403 负样本 + checksum 篡改样本（降级重跑验证，场景 1/2/5）
- [x] fetch 拦截 → loadFromUri 端到端（同下）
- [x] **face 2FA 真实登录闭环**（2026-08-24，v4l2loopback 虚拟摄像头 + ffmpeg 哈欠循环视频源）：enroll（3 次张嘴捕获、质量门通过、模板 active）→ 密码登录 → face 2FA 验证（再 3 次张嘴）→ 会话签发重定向 ✓
- [ ] 隧道环境（真 nginx 网关 + 外网暴露）下的回归

实测补充（闭环中发现）：
- **sizeThreshold 陷阱**：justget 默认 50MB 阈值下，6.4MB 识别模型永远不会释放镜像——jsdelivr 慢时（实测 243KB/s）页面卡住而 Gitee（1.9MB/s）闲置。页面已传 `sizeThreshold: 1MiB + primaryWarmupTime: 3s`。
- **进度条 >100%**：HEAD 返回的 content-length 是 gzip 压缩长度，而 chunk 计数是解压后字节 → percentage 可超 100%（无功能影响，待 justget 侧修）。
- **landmark 网络不可欺**：用深色椭圆/肤色块叠加伪造嘴部开合均无法显著改变 mar（网络按脸型几何回归嘴型）——活体检测对合成攻击意外地稳健，但测试需真实大幅张嘴素材（哈欠/唱歌类视频）。
