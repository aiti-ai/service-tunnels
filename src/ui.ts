/**
 * UI server — simple web management interface for service-tunnels.
 *
 * Runs on 127.0.0.1:<port> (default 4181) and provides:
 *   - Tunnel management (list/add/start/stop/remove)
 *   - User management (add/remove/set-password/totp)
 *   - Auth provider management
 *   - Configuration editing
 *
 * No external dependencies — uses Node's built-in http module and in-memory
 * templates. Opens a browser automatically on startup.
 */

import { createServer, IncomingMessage, ServerResponse, type RequestListener } from "http";
import { platform } from "os";
import { exec } from "child_process";
import type { ServiceTunnels } from "./index.ts";
import type { AuthUser } from "./auth-provider.ts";

export interface UiServerOptions {
  /** Port to listen on (default 4181). */
  port?: number;
  /** Open browser automatically (default true). */
  openBrowser?: boolean;
}

interface UiContext {
  st: ServiceTunnels;
  port: number;
}

/** Simple HTML templates (no template engine dependency). */
const TEMPLATES = {
  layout: (title: string, content: string) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - service-tunnels</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .header h1 { font-size: 24px; margin-bottom: 10px; }
    .nav { display: flex; gap: 10px; margin-top: 15px; }
    .nav a { color: white; text-decoration: none; padding: 8px 16px; border-radius: 4px; background: rgba(255,255,255,0.2); transition: background 0.2s; }
    .nav a:hover, .nav a.active { background: rgba(255,255,255,0.3); }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card h2 { font-size: 18px; margin-bottom: 15px; color: #667eea; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    .table th { font-weight: 600; color: #555; }
    .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status.running { background: #e6ffed; color: #22863a; }
    .status.stopped { background: #ffeef0; color: #cb2431; }
    .btn { display: inline-block; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
    .btn-primary { background: #667eea; color: white; }
    .btn-primary:hover { background: #5568d3; }
    .btn-danger { background: #f56565; color: white; }
    .btn-danger:hover { background: #e53e3e; }
    .btn-sm { padding: 4px 8px; font-size: 12px; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; font-weight: 500; }
    .form-control { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    .form-control:focus { outline: none; border-color: #667eea; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; background: #e2e8f0; }
    .badge.favorite { background: #faf5ff; color: #805ad5; }
    pre { background: #f7f7f7; padding: 15px; border-radius: 4px; overflow-x: auto; font-size: 13px; }
    .alert { padding: 12px; border-radius: 4px; margin-bottom: 15px; }
    .alert-success { background: #e6ffed; color: #22863a; }
    .alert-error { background: #ffeef0; color: #cb2431; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 service-tunnels 管理面板</h1>
      <div class="nav">
        <a href="/" class="${content.includes("dashboard") ? "active" : ""}">概览</a>
        <a href="/tunnels" class="${content.includes("tunnels") ? "active" : ""}">隧道管理</a>
        <a href="/users" class="${content.includes("users") ? "active" : ""}">用户管理</a>
        <a href="/config" class="${content.includes("config") ? "active" : ""}">配置</a>
        <a href="/expose" class="${content.includes("expose") ? "active" : ""}">快速暴露</a>
      </div>
    </div>
    ${content}
  </div>
  <script>
    function httpPost(url, data) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }
    function toggleTunnel(name) {
      httpPost('/tunnels/' + encodeURIComponent(name) + '/toggle').then(() => location.reload());
    }
    function removeTunnel(name) {
      if (confirm('确定删除隧道 ' + name + '?')) {
        httpPost('/tunnels/' + encodeURIComponent(name) + '/remove').then(() => location.reload());
      }
    }
    function addUser() {
      const name = prompt('用户名:');
      if (!name) return;
      const password = prompt('密码:');
      if (!password) return;
      httpPost('/users/add', { name, password }).then(() => location.reload());
    }
    function removeUser(name) {
      if (confirm('确定删除用户 ' + name + '?')) {
        httpPost('/users/' + encodeURIComponent(name) + '/remove').then(() => location.reload());
      }
    }
    function setPassword(name) {
      const password = prompt('新密码:');
      if (!password) return;
      httpPost('/users/' + encodeURIComponent(name) + '/password', { password }).then(() => location.reload());
    }
    function enrollTotp(name) {
      httpPost('/users/' + encodeURIComponent(name) + '/totp-enroll').then(r => r.json()).then(data => {
        const otpauth = data.otpauthUrl || '';
        const secret = data.secret || '';
        const show = '为 ' + name + ' 启用 2FA:\n\n' +
          '在 Authenticator 应用中添加:\n' + otpauth + '\n\n' +
          (secret ? '或手动输入密钥: ' + secret + '\n\n' : '') +
          '输入 6 位验证码以激活:'; 
        const code = prompt(show);
        if (code) {
          httpPost('/users/' + encodeURIComponent(name) + '/totp-activate', { code }).then(r => r.json()).then(d => {
            alert(d.activated ? '✅ 2FA 已激活' : '❌ 验证码错误,请重试');
            location.reload();
          });
        }
      });
    }
    function disableTotp(name) {
      if (confirm('确定禁用 2FA?')) {
        httpPost('/users/' + encodeURIComponent(name) + '/totp-disable').then(() => location.reload());
      }
    }
  </script>
</body>
</html>`,

  dashboard: (daemonRunning: boolean, tunnelCount: number, userCount: number) => `
    <div class="card">
      <h2>系统状态</h2>
      <p>守护进程: <span class="status ${daemonRunning ? "running" : "stopped"}">${daemonRunning ? "运行中" : "已停止"}</span></p>
      <p>活跃隧道: ${tunnelCount} 个</p>
      <p>注册用户: ${userCount} 个</p>
    </div>
    <div class="card">
      <h2>快速操作</h2>
      <button class="btn btn-primary" onclick="location.href='/expose'">暴露端口</button>
      <button class="btn btn-primary" onclick="location.href='/tunnels'">管理隧道</button>
      <button class="btn btn-primary" onclick="location.href='/users'">管理用户</button>
    </div>
  `,

  tunnels: (tunnels: any[]) => `
    <div class="card">
      <h2>隧道列表</h2>
      <table class="table">
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>状态</th>
            <th>URL</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${tunnels.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:#999;">暂无隧道</td></tr>' : ""}
          ${tunnels.map((t: any) => `
            <tr>
              <td>${t.name}</td>
              <td>${t.type}${t.favorite ? ' <span class="badge favorite">推荐</span>' : ''}</td>
              <td><span class="status ${t.running ? 'running' : 'stopped'}">${t.running ? '运行中' : '已停止'}</span></td>
              <td>${t.url || '-'}</td>
              <td>
                <button class="btn btn-sm btn-primary" onclick="toggleTunnel('${t.name}')">${t.running ? '停止' : '启动'}</button>
                <button class="btn btn-sm btn-danger" onclick="removeTunnel('${t.name}')">删除</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top: 15px;">
        <a href="/tunnels/add" class="btn btn-primary">添加隧道</a>
      </div>
    </div>
  `,

  users: (users: AuthUser[], totpStatus: Record<string, boolean>) => `
    <div class="card">
      <h2>用户列表</h2>
      <table class="table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>显示名</th>
            <th>2FA</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${users.length === 0 ? '<tr><td colspan="4" style="text-align:center;color:#999;">暂无用户</td></tr>' : ""}
          ${users.map((u: AuthUser) => `
            <tr>
              <td>${u.name}</td>
              <td>${u.displayName || u.name}</td>
              <td>${totpStatus[u.name] ? '<span class="status running">已启用</span>' : '<span class="status stopped">未启用</span>'}</td>
              <td>
                <button class="btn btn-sm btn-primary" onclick="setPassword('${u.name}')">改密</button>
                ${totpStatus[u.name]
                  ? `<button class="btn btn-sm btn-danger" onclick="disableTotp('${u.name}')">禁用2FA</button>`
                  : `<button class="btn btn-sm btn-primary" onclick="enrollTotp('${u.name}')">启用2FA</button>`
                }
                <button class="btn btn-sm btn-danger" onclick="removeUser('${u.name}')">删除</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top: 15px;">
        <button class="btn btn-primary" onclick="addUser()">添加用户</button>
      </div>
    </div>
  `,

  config: (config: any) => `
    <div class="card">
      <h2>当前配置</h2>
      <pre>${JSON.stringify(config, null, 2)}</pre>
    </div>
  `,

  expose: () => `
    <div class="card">
      <h2>快速暴露端口</h2>
      <form id="exposeForm" style="max-width: 400px;">
        <div class="form-group">
          <label>本地端口</label>
          <input type="number" name="port" class="form-control" required placeholder="例如: 3000">
        </div>
        <div class="form-group">
          <label>认证方式</label>
          <select name="auth" class="form-control">
            <option value="auto">auto（自动选择）</option>
            <option value="none">none（无认证）</option>
            <option value="authelia">authelia（Linux推荐）</option>
            <option value="portal">portal（Windows推荐）</option>
            <option value="basic">basic（简单认证）</option>
          </select>
        </div>
        <div class="form-group">
          <label>隧道类型</label>
          <select name="tunnel" class="form-control">
            <option value="ngrok">ngrok</option>
            <option value="cloudflared">cloudflared（推荐）</option>
            <option value="serveo">serveo</option>
            <option value="localtunnel">localtunnel</option>
            <option value="bore">bore</option>
            <option value="natapp">natapp</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary">暴露</button>
      </form>
      <div id="result" style="margin-top: 15px;"></div>
    </div>
    <script>
      document.getElementById('exposeForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const port = fd.get('port');
        const auth = fd.get('auth');
        const tunnel = fd.get('tunnel');
        const result = document.getElementById('result');
        result.innerHTML = '<p>正在暴露...</p>';
        try {
          const r = await fetch('/api/expose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: Number(port), auth: auth === 'none' ? false : auth, tunnel })
          });
          const data = await r.json();
          if (data.url) {
            result.innerHTML = '<div class="alert alert-success">✅ 暴露成功！<br><strong>URL:</strong> <a href="' + data.url + '" target="_blank">' + data.url + '</a></div>';
          } else {
            result.innerHTML = '<div class="alert alert-error">❌ 暴露失败: ' + (data.error || '未知错误') + '</div>';
          }
        } catch (err) {
          result.innerHTML = '<div class="alert alert-error">❌ 请求失败: ' + err + '</div>';
        }
      };
    </script>
  `,

  tunnelsAdd: (tunnelTypes: string[]) => `
    <div class="card">
      <h2>添加隧道</h2>
      <form id="tunnelForm">
        <div class="form-group">
          <label>名称</label>
          <input type="text" name="name" class="form-control" required placeholder="例如: web">
        </div>
        <div class="form-group">
          <label>类型</label>
          <select name="type" class="form-control" required>
            ${tunnelTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>目标端口</label>
          <input type="number" name="target" class="form-control" placeholder="例如: 4180">
        </div>
        <button type="submit" class="btn btn-primary">添加</button>
      </form>
      <div id="result" style="margin-top: 15px;"></div>
    </div>
    <script>
      document.getElementById('tunnelForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = Object.fromEntries(fd.entries());
        data.target = Number(data.target) || undefined;
        const result = document.getElementById('result');
        result.innerHTML = '<p>正在添加...</p>';
        try {
          const r = await fetch('/api/tunnels/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          const d = await r.json();
          if (d.added) {
            result.innerHTML = '<div class="alert alert-success">✅ 添加成功！</div>';
            setTimeout(() => location.href = '/tunnels', 1000);
          } else {
            result.innerHTML = '<div class="alert alert-error">❌ 添加失败</div>';
          }
        } catch (err) {
          result.innerHTML = '<div class="alert alert-error">❌ 请求失败: ' + err + '</div>';
        }
      };
    </script>
  `,
};

/** Open the default browser. */
function openBrowser(url: string): void {
  const cmd = platform() === "win32"
    ? `start "" "${url}"`
    : platform() === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error("Failed to open browser:", err);
  });
}

/** Parse URL-encoded body. */
function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      const out: Record<string, string> = {};
      for (const pair of body.split("&")) {
        const [k, v] = pair.split("=").map(decodeURIComponent);
        if (k) out[k] = v ?? "";
      }
      resolve(out);
    });
  });
}

/** Create the request handler. */
function createHandler(ctx: UiContext): RequestListener {
  return async (req, res) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS for API calls
    if (path.startsWith("/api/")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    try {
      // Dashboard
      if (path === "/" || path === "/dashboard") {
        const dstat = ctx.st.daemon.status();
        const tunnels = (await ctx.st.daemon.request<any[]>("tunnel.list")) ?? [];
        const users: { provider: string; users: AuthUser[] }[] = await ctx.st.auth.users();
        const userCount = users.reduce((n, x) => n + x.users.length, 0);
        const html = TEMPLATES.layout("概览", TEMPLATES.dashboard(dstat.running, tunnels.length, userCount));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Tunnels
      if (path === "/tunnels") {
        const tunnels = (await ctx.st.daemon.request<any[]>("tunnel.list")) ?? [];
        const html = TEMPLATES.layout("隧道管理", TEMPLATES.tunnels(tunnels));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (path === "/tunnels/add") {
        const html = TEMPLATES.layout("添加隧道", TEMPLATES.tunnelsAdd(["ngrok", "frpc", "ssh", "serveo", "cloudflared", "localtunnel", "bore", "natapp", "command"]));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Users
      if (path === "/users") {
        const groups: { provider: string; users: AuthUser[] }[] = await ctx.st.auth.users();
        const users: AuthUser[] = groups.flatMap((g) => g.users);
        const totpStatus: Record<string, boolean> = {};
        for (const u of users) {
          try {
            const s = await ctx.st.auth.totpStatus(u.name);
            totpStatus[u.name] = s?.enrolled ?? false;
          } catch {
            totpStatus[u.name] = false; // 未注册/不可查 → 视为未启用
          }
        }
        const html = TEMPLATES.layout("用户管理", TEMPLATES.users(users, totpStatus));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Config
      if (path === "/config") {
        const html = TEMPLATES.layout("配置", TEMPLATES.config(ctx.st.dirs));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Expose
      if (path === "/expose") {
        const html = TEMPLATES.layout("快速暴露", TEMPLATES.expose());
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // API: Expose
      if (path === "/api/expose" && req.method === "POST") {
        const body = await new Promise<any>((resolve) => {
          let b = "";
          req.on("data", (chunk) => b += chunk);
          req.on("end", () => resolve(JSON.parse(b)));
        });
        const result = await ctx.st.daemon.request("expose", {
          port: body.port,
          auth: body.auth,
          tunnelType: body.tunnel,
          allowToolDownload: true,
        }, 90_000);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // API: Tunnels
      if (path.startsWith("/tunnels/") && req.method === "POST") {
        const parts = path.split("/");
        const name = parts[2];
        const action = parts[3];
        if (action === "toggle") {
          const info = (await ctx.st.daemon.request("tunnel.get", name)) as { running?: boolean } | null;
          if (info?.running) {
            await ctx.st.daemon.request("tunnel.stop", name);
          } else {
            await ctx.st.daemon.request("tunnel.start", name);
          }
        } else if (action === "remove") {
          await ctx.st.daemon.request("tunnel.remove", name);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (path === "/api/tunnels/add" && req.method === "POST") {
        const body = await new Promise<any>((resolve) => {
          let b = "";
          req.on("data", (chunk) => b += chunk);
          req.on("end", () => resolve(JSON.parse(b)));
        });
        await ctx.st.daemon.request("tunnel.add", body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ added: body.name }));
        return;
      }

      // API: Users
      if (path === "/users/add" && req.method === "POST") {
        const body = await new Promise<any>((resolve) => {
          let b = "";
          req.on("data", (chunk) => b += chunk);
          req.on("end", () => resolve(JSON.parse(b)));
        });
        await ctx.st.auth.addUser(body.name, body.password);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ added: body.name }));
        return;
      }

      if (path.startsWith("/users/") && req.method === "POST") {
        const parts = path.split("/");
        const name = parts[2] ?? "";
        const action = parts[3];
        if (action === "remove") {
          await ctx.st.auth.removeUser(name);
        } else if (action === "password") {
          const body = await new Promise<any>((resolve) => {
            let b = "";
            req.on("data", (chunk) => b += chunk);
            req.on("end", () => resolve(JSON.parse(b)));
          });
          await ctx.st.auth.setUserPassword(name, body.password);
        } else if (action === "totp-enroll") {
          const result = await ctx.st.auth.totpEnroll(name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        } else if (action === "totp-activate") {
          const body = await new Promise<any>((resolve) => {
            let b = "";
            req.on("data", (chunk) => b += chunk);
            req.on("end", () => resolve(JSON.parse(b)));
          });
          const result = await ctx.st.auth.totpActivate(name, body.code);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        } else if (action === "totp-disable") {
          await ctx.st.auth.totpDisable(name);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      console.error("UI error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err));
    }
  };
}

export interface UiServer {
  close(): void;
}

/** Start the UI server. */
export function startUi(st: ServiceTunnels, opts: UiServerOptions = {}): UiServer {
  const port = opts.port ?? 4181;
  const server = createServer(createHandler({ st, port }));

  return new Promise<UiServer>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`UI server listening on http://127.0.0.1:${port}`);
      if (opts.openBrowser !== false) {
        openBrowser(`http://127.0.0.1:${port}`);
      }
      resolve({
        close: () => {
          server.close();
          console.log("UI server stopped");
        },
      });
    });
    server.on("error", reject);
  }) as any as UiServer;
}