/**
 * 最简示例 2/2 —— 启动一个子服务端口，再 expose
 *
 * 场景：应用拉起子进程服务（dev server / 工具），把它的端口暴露到公网。
 * （子服务端口也可用 st.discovery.getPorts() 自动发现，这里为直观直接读 stdout。）
 *
 * 运行（仓库内，Node ≥20.19）
 *   node --experimental-strip-types examples/expose-child.ts
 */
import { createServiceTunnels } from "../src/index.ts";
import { spawn } from "node:child_process";

// 1. 启动子服务（监听随机端口，把端口写到 stdout）
const child = spawn(process.execPath, ["-e", `
  const http = require("http");
  http.createServer((q, s) => s.end("hello from child")).listen(0, "127.0.0.1", function () {
    process.stdout.write("PORT=" + this.address().port);
  });
`], { stdio: ["ignore", "pipe", "inherit"] });

// 2. 读到子服务端口
const port = await new Promise<number>((resolve, reject) => {
  child.stdout.once("data", (d) => {
    const m = d.toString().match(/PORT=(\d+)/);
    if (m) resolve(Number(m[1]));
    else reject(new Error("子进程未输出端口"));
  });
  child.on("error", reject);
});
console.log("子服务端口:", port);

// 3. expose（portal 认证的公网隧道）
const st = createServiceTunnels();
const res = await st.auth.expose(port, { auth: "portal" });
console.log("公网 URL:", res.url ?? "（无 URL）");
// 保持运行，Ctrl+C 退出（子进程同进程组一并退出）
