/**
 * 最简示例 1/2 —— expose 自己（默认参数）· JS 版
 *
 * 运行（仓库内，先 npm run build）：
 *   node examples/expose-self.js
 * 发布安装后改用：
 *   import { createServiceTunnels } from "service-tunnels";
 */
import { createServiceTunnels } from "../dist/index.js";
import { createServer } from "node:http";

// 当前进程先启动一个 HTTP 服务（示例中的"自己"）
const server = createServer((req, res) => res.end(`hello from pid ${process.pid}`));
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;

  const st = createServiceTunnels();                   // 全部默认目录
  const res = await st.auth.expose(port, { auth: "portal" });  // portal 认证（防路人）
  console.log("公网 URL:", res.url ?? "（无 URL）");
  // 保持进程存活，Ctrl+C 退出
});
