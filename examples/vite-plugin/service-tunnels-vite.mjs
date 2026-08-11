/**
 * @service-tunnels/vite — Vite 插件参考实现（L2 库内嵌）
 *
 * 场景：`npm run dev` 起 Vite 后，把 dev server 端口一键暴露到公网。
 *
 * 用法（vite.config.ts）：
 *   import { serviceTunnels } from "./service-tunnels-vite.mjs";
 *   export default defineConfig({ plugins: [serviceTunnels({ auth: "auto" })] });
 *
 * 或在命令行开启（零代码改动）：SERVICE_TUNNELS_EXPOSE=1 npm run dev
 *
 * 行为：
 *  - configureServer 拿到 httpServer 真实端口后暴露；
 *  - 默认 `auth: "auto"`（Windows→portal 零二进制，Linux/macOS→authelia），
 *    公网 URL 不裸奔；
 *  - 默认隧道 cloudflared（零账号）；可配 tunnelType（ngrok/natapp/bore…）；
 *  - 输出通道打印 URL / loginUrl；dev server 关闭时自动 shutdown 清理。
 *
 * 安全：
 *  - 端口归属由库校验（同 OS 用户）；auth none 需显式 opts.auth === "none"
 *    且主机 allow-auth-none 允许；
 *  - 无遥测；config/cache 落在用户目录（0600）。
 */
import { createServiceTunnels } from "service-tunnels";

export function serviceTunnels(opts = {}) {
  const {
    enabled = true,
    tunnelType = "cloudflared",
    auth = "auto",
    tunnelName = "vite",
    configDir = "~/.config/service-tunnels",
    cacheDir = "~/.cache/service-tunnels",
    log = (line) => console.log(`[service-tunnels] ${line}`),
  } = opts;

  let st = null;
  let port = 0;

  return {
    name: "service-tunnels",
    async configureServer(server) {
      const want = typeof enabled === "function" ? enabled() : enabled;
      if (!want && process.env.SERVICE_TUNNELS_EXPOSE !== "1") return;
      const httpServer = server.httpServer;
      if (!httpServer) {
        log("no http server (middleware mode) — skipping expose");
        return;
      }
      st = createServiceTunnels({ configDir, cacheDir });
      await new Promise((resolve) => {
        httpServer.once("listening", async () => {
          const addr = httpServer.address();
          if (addr && typeof addr === "object") {
            port = addr.port;
            await expose();
          } else {
            log("http server not on a TCP port — skipping expose");
          }
          resolve();
        });
      });
      // 清理：dev server 停止 / 进程退出 / 热重载
      server.httpServer?.on("close", () => void shutdown());
      process.once("exit", () => void shutdown());
    },
  };

  async function expose() {
    try {
      const res = await st.auth.expose(port, { auth, tunnelType, tunnelName });
      if (res.url) {
        log(`公网 URL: ${res.url}`);
        if (res.loginUrl) log(`登录页:   ${res.loginUrl}`);
      } else {
        log(`暴露失败: ${res.error ?? "unknown"}`);
      }
    } catch (err) {
      log(`expose failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function shutdown() {
    try { await st.shutdown(); } catch { /* ignore */ }
    st = null;
  }
}
