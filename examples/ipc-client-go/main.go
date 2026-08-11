// ipc-client-go — service-tunnels daemon IPC 最小客户端（L3 参考实现）
//
// 任意语言均可直接对接 daemon 的 newline-JSON-RPC（docs/adaptation-kit.md §3）：
//   - POSIX: unix socket（0600，无需额外鉴权）
//   - Windows: HTTP POST 127.0.0.1 + x-service-tunnels-auth 头
//
// 用法：
//   go build .
//   ./ipc-client-go ping
//   ./ipc-client-go expose -port 5173 -tunnel cloudflared -auth auto
//   ./ipc-client-go tunnels
//
// 地址来源：daemon 运行后写入 <cacheDir>/state.json 的 daemon.ipc 字段
// （默认 ~/.cache/service-tunnels/state.json，可用 -state 覆盖）。
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// rpc 发送一行 JSON 请求并解析一行 JSON 响应（通用泛型）。
func rpc[T any](sock, method string, params any) (*T, error) {
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	req, _ := json.Marshal(map[string]any{"id": 1, "method": method, "params": params})
	if _, err := fmt.Fprintf(conn, "%s\n", req); err != nil {
		return nil, err
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return nil, err
	}
	var resp struct {
		Result T      `json:"result"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		return nil, fmt.Errorf("bad response: %s", strings.TrimSpace(line))
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("%s", resp.Error)
	}
	return &resp.Result, nil
}

// daemonSock 从 state.json 解析 unix socket 路径。
func daemonSock(statePath string) (string, error) {
	raw, err := os.ReadFile(statePath)
	if err != nil {
		return "", fmt.Errorf("read %s (run `sts daemon start` first): %w", statePath, err)
	}
	var s struct {
		Daemon struct {
			Ipc string `json:"ipc"`
		} `json:"daemon"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", err
	}
	if !strings.HasPrefix(s.Daemon.Ipc, "unix://") {
		return "", fmt.Errorf("unsupported ipc transport: %s (Windows clients use HTTP+secret)", s.Daemon.Ipc)
	}
	return strings.TrimPrefix(s.Daemon.Ipc, "unix://"), nil
}

func main() {
	state := flag.String("state", filepath.Join(os.Getenv("HOME"), ".cache/service-tunnels/state.json"), "daemon state.json path")
	port := flag.Int("port", 5173, "port to expose")
	tunnel := flag.String("tunnel", "cloudflared", "tunnel type")
	auth := flag.String("auth", "auto", "auth: auto|none|<provider>")
	flag.Parse()

	sock, err := daemonSock(*state)
	if err != nil {
		fatal(err)
	}
	if _, err := rpc[map[string]any](sock, "ping", nil); err != nil {
		fatal(fmt.Errorf("daemon unreachable: %w", err))
	}

	switch flag.Arg(0) {
	case "ping":
		fmt.Println("daemon OK")

	case "expose":
		res, err := rpc[map[string]any](sock, "expose", map[string]any{
			"port": *port, "tunnelType": *tunnel, "auth": *auth,
		})
		if err != nil {
			fatal(err)
		}
		out, _ := json.MarshalIndent(res, "", "  ")
		fmt.Println(string(out))

	case "tunnels":
		list, err := rpc[[]map[string]any](sock, "tunnel.list", nil)
		if err != nil {
			fatal(err)
		}
		for _, t := range *list {
			fmt.Printf("%-16s %-10s url=%v\n", t["name"], t["type"], t["url"])
		}

	default:
		fmt.Fprintln(os.Stderr, "usage: ipc-client-go [-state file] [-port N] [-tunnel T] [-auth A] [ping|expose|tunnels]")
		os.Exit(2)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "ipc-client-go:", err)
	os.Exit(1)
}
