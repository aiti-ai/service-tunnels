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
import { randomBytes, timingSafeEqual } from "crypto";
import { platform } from "os";
import { exec } from "child_process";
import type { ServiceTunnels } from "./index.ts";
import type { AuthUser } from "./auth-provider.ts";
import { validateTunnelConfig } from "./validation.ts";

export interface UiServerOptions {
  /** Port to listen on (default 4181). */
  port?: number;
  /** Open browser automatically (default true). */
  openBrowser?: boolean;
}

interface UiContext {
  st: ServiceTunnels;
  port: number;
  /** Per-server random CSRF token (injected into every page; required on
   *  every POST — same-origin scripts can read it, cross-origin pages can't). */
  csrfToken: string;
}

/** Simple HTML templates (no template engine dependency). */
const TEMPLATES = {
  layout: (title: string, content: string, csrf: string) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="csrf-token" content="${csrf}">
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
        <a href="/sites" class="${content.includes("sites") ? "active" : ""}">站点管理</a>
        <a href="/config" class="${content.includes("config") ? "active" : ""}">配置</a>
        <a href="/expose" class="${content.includes("expose") ? "active" : ""}">快速暴露</a>
      </div>
    </div>
    ${content}
  </div>
  <script>
    function csrfToken() { return document.querySelector('meta[name="csrf-token"]')?.content || ''; }
    function httpPost(url, data) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() }, body: JSON.stringify(data) });
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
    function addSite() {
      const name = prompt('站点名（小写字母/数字/短横线，如 host）:');
      if (!name) return;
      const provider = prompt('认证 provider（portal/authelia/basic/oauth2-proxy，回车=auto）:') || '';
      const domain = prompt('站点域名（可选，如 web.example.com）:') || '';
      const body = { name, provider, domain };
      httpPost('/api/sites/add', body).then(r => r.json()).then(d => {
        if (d.error) { alert('❌ ' + d.error); } else { location.reload(); }
      });
    }
    function removeSite(name) {
      if (confirm('确定删除站点 ' + name + '?')) {
        httpPost('/sites/' + encodeURIComponent(name) + '/remove').then(() => location.reload());
      }
    }
    function siteAddUser(site) {
      const name = prompt('用户名:');
      if (!name) return;
      const password = prompt('密码:');
      if (!password) return;
      httpPost('/sites/' + encodeURIComponent(site) + '/users/add', { name, password }).then(() => location.reload());
    }
    function siteRemoveUser(site, name) {
      if (confirm('确定删除 ' + site + ' 的用户 ' + name + '?')) {
        httpPost('/sites/' + encodeURIComponent(site) + '/users/' + encodeURIComponent(name) + '/remove').then(() => location.reload());
      }
    }
    function siteSetPassword(site, name) {
      const password = prompt('新密码:');
      if (!password) return;
      httpPost('/sites/' + encodeURIComponent(site) + '/users/' + encodeURIComponent(name) + '/password', { password }).then(() => location.reload());
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

  sites: (sites: any[], exposes: any[]) => `
    <div class="card">
      <h2>站点列表（认证域）</h2>
      <p style="color:#666;font-size:13px;margin-bottom:12px;">每个站点 = 独立的 provider 实例 + 用户库，互不共享。虚拟主机：<code>&lt;port&gt;-&lt;label&gt;.st.localhost</code></p>
      <table class="table">
        <thead>
          <tr><th>站点</th><th>provider</th><th>认证</th><th>域名</th><th>状态</th><th>地址</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${sites.map((s: any) => {
            const urls = [
              s.localUrl && `<code>${s.localUrl}</code>`,
              s.baseUrl && `<code>${s.baseUrl}</code>`,
              s.domainUrl && `<code>${s.domainUrl}</code>`,
            ].filter(Boolean);
            return `<tr>
              <td><strong>${s.name}</strong>${s.name === "default" ? ' <span class="badge">默认</span>' : ""}</td>
              <td>${s.provider || "auto"}</td>
              <td>${s.auth === false ? "开放" : s.policy ? `认证(${s.policy})` : "认证"}</td>
              <td>${s.domain || "-"}</td>
              <td><span class="status ${s.running ? "running" : "stopped"}">${s.running ? "运行中" : "未启动"}</span></td>
              <td>${urls.length ? urls.join("<br>") : "-"}</td>
              <td>
                <a class="btn btn-sm btn-primary" href="/sites/${s.name}/users">用户</a>
                ${s.name !== "default" ? `<button class="btn btn-sm btn-danger" onclick="removeSite('${s.name}')">删除</button>` : ""}
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      <div style="margin-top:15px;">
        <button class="btn btn-primary" onclick="addSite()">添加站点</button>
        <span style="color:#999;font-size:12px;margin-left:8px;">如：<code>site add host --provider portal --domain web.example.com</code></span>
      </div>
    </div>
    <div class="card">
      <h2>本地暴露（proxy 模式）</h2>
      <table class="table">
        <thead><tr><th>端口</th><th>站点</th><th>provider</th><th>本地地址</th><th>base 域名</th></tr></thead>
        <tbody>
          ${exposes.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:#999;">暂无 proxy 暴露</td></tr>' : ""}
          ${exposes.map((e: any) => `<tr>
            <td>${e.port}</td>
            <td>${e.site || "-"}</td>
            <td>${e.provider || "开放"}</td>
            <td><code>${e.localUrl || "-"}</code></td>
            <td><code>${e.baseUrl || e.domainUrl || "-"}</code></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `,

  siteUsers: (site: any, users: AuthUser[]) => `
    <div class="card">
      <h2>站点 ${site.name} · 用户管理</h2>
      <p style="color:#666;font-size:13px;margin-bottom:12px;">该站点（provider: ${site.provider || "auto"}）的独立用户库——与其它站点互不影响。</p>
      <table class="table">
        <thead><tr><th>用户名</th><th>显示名</th><th>操作</th></tr></thead>
        <tbody>
          ${users.length === 0 ? '<tr><td colspan="3" style="text-align:center;color:#999;">暂无用户</td></tr>' : ""}
          ${users.map((u: AuthUser) => `<tr>
            <td>${u.name}</td>
            <td>${u.displayName || u.name}</td>
            <td>
              <button class="btn btn-sm btn-primary" onclick="siteSetPassword('${site.name}','${u.name}')">改密</button>
              <button class="btn btn-sm btn-danger" onclick="siteRemoveUser('${site.name}','${u.name}')">删除</button>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div style="margin-top:15px;">
        <button class="btn btn-primary" onclick="siteAddUser('${site.name}')">添加用户</button>
        <a href="/sites" class="btn" style="background:#eee;color:#333;">返回站点列表</a>
      </div>
    </div>
  `,

  expose: (sites: string[], authSchemas: Record<string, any[]>, authMetas: Record<string, any>, authOrder: string[]) => `
    <div class="card">
      <h2>快速暴露端口</h2>
      <form id="exposeForm" style="max-width: 400px;">
        <div class="form-group">
          <label>本地端口</label>
          <input type="number" name="port" class="form-control" required placeholder="例如: 3000">
        </div>
        <div class="form-group">
          <label>模式</label>
          <select name="mode" class="form-control">
            <option value="tunnel">tunnel（公网隧道）</option>
            <option value="proxy">proxy（本地虚拟主机，无隧道）</option>
            <option value="both">both（两者）</option>
          </select>
        </div>
        <div class="form-group">
          <label>认证方式</label>
          <select name="auth" id="authType" class="form-control">
            <option value="auto">auto（自动选择）</option>
            <option value="none">none（无认证）</option>
            ${authOrder.map((t) => {
              const meta = authMetas[t] || {};
              const badge = meta.kind === "oauth2-variant"
                ? (meta.configured ? " ✓已配置" : (meta.needsInput?.length ? " (缺: " + meta.needsInput.join("/") + ")" : ""))
                : "";
              return `<option value="${t}">${meta.label || t}${badge}</option>`;
            }).join("")}
          </select>
        </div>
        <div id="authParamFields"></div>
        <div class="form-group">
          <label>站点（认证域）</label>
          <select name="site" class="form-control">
            <option value="">default（默认）</option>
            ${sites.map((s: string) => `<option value="${s}">${s}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label>隧道类型（tunnel/both 模式）</label>
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
      // 预填值（含 clientSecret）会进页面 —— JSON 转义 < 防 </script> 逃逸；
      // 属性值 HTML 转义防引号逃逸（配置档/环境变量是操作者输入，仍纵深防御）
      const AUTH_SCHEMAS = ${JSON.stringify(authSchemas).replace(/</g, '\\u003c')};
      const AUTH_METAS = ${JSON.stringify(authMetas).replace(/</g, '\\u003c')};
      function escAttr(v) {
        return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }
      function authInputHtml(s) {
        const label = (s.label || s.key) + (s.required ? ' *' : '');
        const hint = s.description ? '<div style="color:#999;font-size:12px;margin-top:4px;">' + s.description +
          (s.link ? ' <a href="' + s.link + '" target="_blank" rel="noopener">' + (s.linkTitle || '获取') + '</a>' : '') + '</div>' : '';
        const ph = s.placeholder ? ' placeholder="' + escAttr(s.placeholder) + '"' : '';
        const def = s.default !== undefined ? ' value="' + escAttr(s.default) + '"' : '';
        let input;
        if (s.options && s.options.length) {
          input = '<select name="' + escAttr(s.key) + '" class="form-control">' +
            s.options.map((o) => '<option value="' + escAttr(o.value) + '">' + escAttr(o.label || o.value) + '</option>').join('') + '</select>';
        } else if (s.type === 'number') {
          input = '<input type="number" name="' + escAttr(s.key) + '" class="form-control"' + ph + def + '>';
        } else if (s.type === 'password') {
          input = '<input type="password" name="' + escAttr(s.key) + '" class="form-control"' + ph + def + '>';
        } else {
          input = '<input type="text" name="' + escAttr(s.key) + '" class="form-control"' + ph + def + '>';
        }
        return '<div class="form-group"><label>' + escAttr(label) + '</label>' + input + hint + '</div>';
      }
      function renderAuthParams(type) {
        const wrap = document.getElementById('authParamFields');
        const specs = AUTH_SCHEMAS[type] || [];
        const meta = AUTH_METAS[type] || {};
        const hint = meta.kind === 'oauth2-variant'
          ? (meta.configured
              ? '<p style="color:#2da44e;font-size:12px;margin-bottom:4px;">✓ 已从配置档预填（可修改覆盖；清空则回落配置档值）</p>'
              : '<p style="color:#999;font-size:12px;margin-bottom:4px;">以下字段可现场填写，或写入 config.json auth.oauth2 后自动预填</p>')
          : '';
        wrap.innerHTML = hint + (specs.map(authInputHtml).join('') || '');
      }
      const authSel = document.getElementById('authType');
      authSel.addEventListener('change', (e) => renderAuthParams(e.target.value));
      renderAuthParams(authSel.value);
      document.getElementById('exposeForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const port = fd.get('port');
        const auth = fd.get('auth');
        const tunnel = fd.get('tunnel');
        const mode = fd.get('mode');
        const site = fd.get('site');
        // 认证参数：变体/原始 oauth2-proxy 的待填字段（凭证未携带时才有）
        const providerParams = {};
        for (const s of AUTH_SCHEMAS[auth] || []) {
          const raw = fd.get(s.key);
          if (raw === undefined || raw === null || raw === '') continue;
          providerParams[s.key] = raw;
        }
        const result = document.getElementById('result');
        result.innerHTML = '<p>正在暴露...</p>';
        try {
          const r = await fetch('/api/expose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
            body: JSON.stringify({
              port: Number(port),
              auth: auth === 'none' ? false : auth,
              tunnel, mode,
              site: site || undefined,
              providerParams: Object.keys(providerParams).length ? providerParams : undefined
            })
          });
          const data = await r.json();
          if (data.url || data.localUrl) {
            const urls = [data.url, data.localUrl, data.baseUrl, data.domainUrl].filter(Boolean);
            result.innerHTML = '<div class="alert alert-success">✅ 暴露成功！<br>' + urls.map(u => '<strong>URL:</strong> <a href="' + u + '" target="_blank">' + u + '</a><br>').join('') + '</div>';
          } else {
            result.innerHTML = '<div class="alert alert-error">❌ 暴露失败: ' + (data.error || '未知错误') + '</div>';
          }
        } catch (err) {
          result.innerHTML = '<div class="alert alert-error">❌ 请求失败: ' + err + '</div>';
        }
      };
    </script>
  `,

  tunnelsAdd: (schemas: Record<string, any[]>, metas: Record<string, any>) => `
    <div class="card">
      <h2>添加隧道</h2>
      <form id="tunnelForm">
        <div class="form-group">
          <label>名称</label>
          <input type="text" name="name" class="form-control" required placeholder="例如: web">
        </div>
        <div class="form-group">
          <label>类型</label>
          <select name="type" id="tunnelType" class="form-control" required>
            ${Object.keys(schemas).map((t) => {
              const dangerous = metas[t]?.dangerous;
              return `<option value="${t}">${t}${dangerous ? " ⚠️ 危险" : ""}</option>`;
            }).join("")}
          </select>
        </div>
        <div class="form-group">
          <label>目标端口</label>
          <input type="number" name="target" class="form-control" placeholder="例如: 4180">
        </div>
        <div id="paramFields"></div>
        <button type="submit" class="btn btn-primary">添加</button>
      </form>
      <div id="result" style="margin-top: 15px;"></div>
    </div>
    <script>
      const SCHEMAS = ${JSON.stringify(schemas)};
      const METAS = ${JSON.stringify(metas)};
      function renderParams(type) {
        const wrap = document.getElementById('paramFields');
        const specs = SCHEMAS[type] || [];
        wrap.innerHTML = specs.map((s) => {
          const label = (s.label || s.key) + (s.required ? ' *' : '');
          const hint = s.description ? '<div style="color:#999;font-size:12px;margin-top:4px;">' + s.description +
            (s.link ? ' <a href="' + s.link + '" target="_blank" rel="noopener">' + (s.linkTitle || '获取') + '</a>' : '') + '</div>' : '';
          const ph = s.placeholder ? ' placeholder="' + s.placeholder + '"' : '';
          const def = s.default !== undefined ? ' value="' + s.default + '"' : '';
          let input;
          if (s.options && s.options.length) {
            input = '<select name="' + s.key + '" class="form-control">' +
              s.options.map((o) => '<option value="' + o.value + '">' + (o.label || o.value) + '</option>').join('') + '</select>';
          } else if (s.type === 'number') {
            input = '<input type="number" name="' + s.key + '" class="form-control"' + ph + def + '>';
          } else if (s.type === 'password') {
            input = '<input type="password" name="' + s.key + '" class="form-control"' + ph + def + '>';
          } else {
            input = '<input type="text" name="' + s.key + '" class="form-control"' + ph + def + '>';
          }
          return '<div class="form-group"><label>' + label + '</label>' + input + hint + '</div>';
        }).join('');
      }
      const typeSel = document.getElementById('tunnelType');
      typeSel.addEventListener('change', (e) => renderParams(e.target.value));
      renderParams(typeSel.value);
      document.getElementById('tunnelForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = Object.fromEntries(fd.entries());
        data.target = Number(data.target) || undefined;
        for (const s of SCHEMAS[data.type] || []) {
          const raw = data[s.key];
          if (raw === undefined || raw === '') { delete data[s.key]; continue; }
          if (s.type === 'number') data[s.key] = Number(raw);
        }
        if (data.type === 'command') {
          // command 类型直接执行 shell 命令 —— 显式确认后才提交（daemon 侧同样要求 dangerous: true）
          if (!confirm('type "command" 会直接执行你输入的命令（危险）。确定继续？')) return;
          data.dangerous = true;
        }
        const result = document.getElementById('result');
        result.innerHTML = '<p>正在添加...</p>';
        try {
          const r = await fetch('/api/tunnels/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
            body: JSON.stringify(data)
          });
          const d = await r.json();
          if (d.added) {
            result.innerHTML = '<div class="alert alert-success">✅ 添加成功！</div>';
            setTimeout(() => location.href = '/tunnels', 1000);
          } else {
            result.innerHTML = '<div class="alert alert-error">❌ 添加失败: ' + (d.error || '未知错误') + '</div>';
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

    // ── CSRF / same-origin enforcement ─────────────────────────────────────
    // The UI binds 127.0.0.1 only, but ANY local web page can POST to it
    // (browsers send simple requests without preflight). Every mutating
    // request must (1) come from the page's own origin and (2) carry the
    // per-session CSRF token — readable only by same-origin scripts (no
    // Access-Control-Allow-Origin is ever set).
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${ctx.port}` && origin !== `http://localhost:${ctx.port}`) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("cross-origin request rejected");
        return;
      }
      const sent = Buffer.from(String(req.headers["x-csrf-token"] ?? ""));
      const expected = Buffer.from(ctx.csrfToken);
      if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("missing or invalid CSRF token");
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
        const html = TEMPLATES.layout("概览", TEMPLATES.dashboard(dstat.running, tunnels.length, userCount), ctx.csrfToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Tunnels
      if (path === "/tunnels") {
        const tunnels = (await ctx.st.daemon.request<any[]>("tunnel.list")) ?? [];
        const html = TEMPLATES.layout("隧道管理", TEMPLATES.tunnels(tunnels), ctx.csrfToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (path === "/tunnels/add") {
        const schemas = ctx.st.schemas.tunnels();
        const metas = ctx.st.schemas.metas();
        const html = TEMPLATES.layout("添加隧道", TEMPLATES.tunnelsAdd(schemas, metas), ctx.csrfToken);
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
        const html = TEMPLATES.layout("用户管理", TEMPLATES.users(users, totpStatus), ctx.csrfToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Sites (认证域)
      if (path === "/sites") {
        const sites = ctx.st.sites.list();
        // merge running exposes' URLs onto each site (proxy mode)
        const exposes = ctx.st.exposes().filter((e) => e.localUrl);
        const withUrls = sites.map((s) => {
          const ex = exposes.filter((e) => (e.site || "default") === s.name);
          return {
            ...s,
            localUrl: ex.map((e) => e.localUrl).find(Boolean),
            baseUrl: ex.map((e) => e.baseUrl).find(Boolean),
            domainUrl: ex.map((e) => e.domainUrl).find(Boolean),
          };
        });
        const html = TEMPLATES.layout("站点管理", TEMPLATES.sites(withUrls, exposes), ctx.csrfToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (path === "/api/sites/add" && req.method === "POST") {
        const body = await new Promise<any>((resolve) => {
          let b = "";
          req.on("data", (chunk) => b += chunk);
          req.on("end", () => resolve(JSON.parse(b)));
        });
        try {
          ctx.st.sites.add(body.name, {
            provider: body.provider || undefined,
            domain: body.domain || undefined,
            basePath: body.basePath || undefined,
            policy: body.policy || undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ added: body.name }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (path.startsWith("/sites/") && req.method === "POST" && path.endsWith("/remove")) {
        const name = path.split("/")[2] ?? "";
        try {
          ctx.st.sites.remove(name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ removed: name }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      // per-site users: page + add + per-user actions
      const siteUsersPage = /^\/sites\/([^/]+)\/users$/.exec(path);
      if (siteUsersPage && req.method === "GET") {
        const name = decodeURIComponent(siteUsersPage[1]!);
        const site = ctx.st.sites.get(name);
        if (!site) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("site not found");
          return;
        }
        const groups: { provider: string; users: AuthUser[] }[] = await ctx.st.auth.users(undefined, name);
        const users: AuthUser[] = groups.flatMap((g) => g.users);
        const html = TEMPLATES.layout("站点用户", TEMPLATES.siteUsers(site, users), ctx.csrfToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      const siteUsersAdd = /^\/sites\/([^/]+)\/users\/add$/.exec(path);
      if (siteUsersAdd && req.method === "POST") {
        const site = decodeURIComponent(siteUsersAdd[1]!);
        const body = await new Promise<any>((resolve) => {
          let b = "";
          req.on("data", (chunk) => b += chunk);
          req.on("end", () => resolve(JSON.parse(b)));
        });
        await ctx.st.auth.addUser(body.name, body.password, { site });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ added: body.name }));
        return;
      }
      const siteUserAction = /^\/sites\/([^/]+)\/users\/([^/]+)\/([^/]+)$/.exec(path);
      if (siteUserAction && req.method === "POST") {
        const site = decodeURIComponent(siteUserAction[1]!);
        const user = decodeURIComponent(siteUserAction[2]!);
        const action = siteUserAction[3]!;
        if (action === "remove") {
          await ctx.st.auth.removeUser(user, undefined, site);
        } else if (action === "password") {
          const body = await new Promise<any>((resolve) => {
            let b = "";
            req.on("data", (chunk) => b += chunk);
            req.on("end", () => resolve(JSON.parse(b)));
          });
          await ctx.st.auth.setUserPassword(user, body.password, undefined, site);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Config
      if (path === "/config") {
        const html = TEMPLATES.layout("配置", TEMPLATES.config(ctx.st.dirs), ctx.csrfToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Expose
      if (path === "/expose") {
        const sites = ctx.st.sites.list().filter((s) => s.name !== "default").map((s) => s.name);
        const authSchemas = await ctx.st.schemas.authProviders();
        const authMetas = ctx.st.schemas.authMetas();
        const authOrder = ctx.st.auth.providerOrder();
        const html = TEMPLATES.layout("快速暴露", TEMPLATES.expose(sites, authSchemas, authMetas, authOrder), ctx.csrfToken);
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
          mode: body.mode,
          site: body.site,
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
        // Validate here so the operator sees the exact reason (the daemon
        // validates again at its boundary — defense in depth).
        try {
          validateTunnelConfig(body, body?.name);
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          return;
        }
        const result = await ctx.st.daemon.request<{ ok: boolean }>("tunnel.add", body);
        if (!result?.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "tunnel.add rejected by daemon (invalid config or daemon unavailable)" }));
          return;
        }
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
  /** Actual listening port (resolves 0 → random at bind time). */
  port: number;
}

/** Start the UI server. */
/** Start the UI server. Resolves once the listener is up (with the actual
 *  port, which is random when port: 0). The CSRF origin gate needs the REAL
 *  bound port, so the listener binds first and the handler is attached after. */
export async function startUi(st: ServiceTunnels, opts: UiServerOptions = {}): Promise<UiServer> {
  const port = opts.port ?? 4181;
  const csrfToken = randomBytes(32).toString("hex");
  const server = createServer();
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
  server.on("request", createHandler({ st, port: actualPort, csrfToken }));
  console.log(`UI server listening on http://127.0.0.1:${actualPort}`);
  if (opts.openBrowser !== false) {
    openBrowser(`http://127.0.0.1:${actualPort}`);
  }
  return {
    port: actualPort,
    close: () => {
      server.close();
      console.log("UI server stopped");
    },
  };
}