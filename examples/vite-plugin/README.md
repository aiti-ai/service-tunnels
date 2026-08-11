# @service-tunnels/vite — Vite 插件参考实现（L2）

把 Vite dev server 一键暴露到公网（认证默认开启）。

## 用法

```ts
// vite.config.ts
import { serviceTunnels } from "./service-tunnels-vite.mjs";

export default defineConfig({
  plugins: [
    serviceTunnels({ auth: "auto" }),   // Windows→portal 零二进制；Linux/macOS→authelia
  ],
});
```

命令行零代码开关：`SERVICE_TUNNELS_EXPOSE=1 npm run dev`（无需改配置）。

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 布尔或函数；配合 env `SERVICE_TUNNELS_EXPOSE=1` |
| `tunnelType` | `cloudflared` | ngrok / natapp / bore / serveo / ssh / frpc… |
| `auth` | `"auto"` | `"auto"` / `"none"`（需主机允许）/ provider 名 |
| `tunnelName` | `"vite"` | 隧道名（daemon 模式可见可管） |
| `configDir` / `cacheDir` | `~/.config` / `~/.cache` | 可指定（0600） |

## 输出

```
[service-tunnels] 公网 URL: https://xxxx.trycloudflare.com
[service-tunnels] 登录页:   https://xxxx.trycloudflare.com/portal-xxx
```

dev server 停止 / 进程退出自动 `shutdown()` 清理全部子进程。

## 安全

- 端口归属由库校验（同 OS 用户）；`auth: "none"` 只在主机 allow-auth-none
  允许时生效；默认认证开启，公网 URL 不裸奔；无遥测。
- 发布形态：依赖 `service-tunnels`（公共 npm）；本示例可直接 `npm i -D
  service-tunnels` 后原样使用。
