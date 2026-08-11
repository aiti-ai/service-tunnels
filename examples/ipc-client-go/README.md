# ipc-client-go — daemon IPC 最小客户端（L3 参考实现）

用任意语言直接对接 service-tunnels daemon 的 JSON-RPC（无需 Node/JS）：
unix socket 上一行一个 JSON 请求/响应。协议全量规范见
`docs/adaptation-kit.md §3`（寻址 / 帧格式 / 方法目录 / 安全边界）。

## 构建与运行

```bash
go build .
./ipc-client-go ping                       # 连通性（需先 `sts daemon start`）
./ipc-client-go -port 5173 -tunnel cloudflared -auth auto expose   # 暴露
./ipc-client-go tunnels                     # 列出隧道（含 url）
```

## 接入点

- 地址：`<cacheDir>/state.json → daemon.ipc`（默认 `~/.cache/service-tunnels/state.json`）
- 请求：`{"id":1,"method":"expose","params":{...}}\n`
- 响应：`{"id":1,"result":{...}}\n` 或 `{"id":1,"error":"..."}\n`
- Windows：`tcp://127.0.0.1:<port>` + HTTP POST + `x-service-tunnels-auth` 头
  （本示例只演示 POSIX unix socket 路径）

## 安全边界（客户端须知）

- `type:"command"` 隧道必须显式 `dangerous:true`；
- auth none 在主机禁止时被拒（sticky 开关）；
- `autheliaReloadCmd` 等 operator-only 参数不可过 IPC。
