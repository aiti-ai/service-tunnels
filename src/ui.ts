/**
 * UI server — zero-dependency SPA control console for service-tunnels.
 *
 * 模块化结构（TODO-6 拆分）：
 *   src/ui/client/*.js — 前端模块（core/ports/exposes/users/tokens/sites/tools/config/main），
 *                         浏览器原生 <script> 多文件（零 bundler），服务端按 /ui/*.js 提供。
 *   src/ui-helpers.ts   — 后端公共函数（daemonOrLocal/findExpose/maskParams/…）。
 *   src/ui-api.ts       — JSON API 路由（createApiHandler）。
 *   src/ui.ts           — startUi + createHandler（静态 client + API 分发 + SPA shell）。
 *
 * Security: binds 127.0.0.1, per-session CSRF on every POST (meta token +
 * X-CSRF-Token), Origin check, and a Host whitelist (127.0.0.1 / localhost /
 * [::1]) as DNS-rebinding defense.
 */

import { createServer, type RequestListener } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { platform } from "os";
import { exec } from "child_process";
import { join, basename, dirname } from "path";
import { readFileSync } from "fs";
import type { ServiceTunnels } from "./index.ts";
import { translate, CATALOG, resolveLang, type Lang } from "./i18n.ts";
import { isLoopbackHost, json, type UiContext } from "./ui-helpers.ts";
import { createApiHandler } from "./ui-api.ts";

export interface UiServerOptions {
  /** Port to listen on (default 4181). */
  port?: number;
  /** Open browser automatically (default true). */
  openBrowser?: boolean;
}

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

/** 客户端静态文件目录：包根/src/ui/client（src 与 dist 部署均指向同一份）。 */
function clientDir(): string {
  return join(dirname(import.meta.dirname), "src", "ui", "client");
}

const CLIENT_FILES = ["core.js", "ports.js", "exposes.js", "users.js", "tokens.js", "sites.js", "tools.js", "config.js", "ddns.js", "main.js"];

// ─────────────────────────────────────────────────────────────────────────────
// SPA shell — HTML + CSS only; 前端 JS 全部外置到 /ui/*.js（模块化）
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
<style>
:root{--bg:#f5f5f5;--panel:#fff;--border:#ddd;--text:#333;--dim:#777;--accent:#667eea;--danger:#f87171;--ok:#16a34a}
@media (prefers-color-scheme: dark){:root{--bg:#17181c;--panel:#202127;--border:#33353d;--text:#e6e6e6;--dim:#9a9aa3;--accent:#8b9cf7}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:13px}
.wrap{max-width:1180px;margin:0 auto;padding:16px}
header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 18px;border:1px solid var(--border);border-radius:10px;background:var(--panel);margin-bottom:14px}
header h1{font-size:16px;font-weight:700;color:var(--accent)}
.dstat{font-size:11px;color:var(--dim)}
.dstat .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
.dot.on{background:var(--ok)} .dot.off{background:var(--danger)}
.spacer{flex:1}
button{font:inherit;cursor:pointer}
.btn{padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text)}
.btn:disabled{opacity:.5;cursor:default}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.btn-danger{color:var(--danger)}
.btn-sm{padding:2px 8px;font-size:11px}
.icon-btn{background:none;border:none;color:var(--dim);padding:4px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:12px;flex-wrap:wrap}
.tab{padding:7px 16px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dim);font-size:13px}
.tab.active{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.card{border:1px solid var(--border);border-radius:8px;background:var(--panel);margin-bottom:10px;overflow:hidden}
.row{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer}
.row:hover{background:rgba(128,128,128,.06)}
.port{font-family:ui-monospace,monospace;font-size:14px;font-weight:700;color:var(--accent);min-width:56px}
.mono{font-family:ui-monospace,monospace}
.dim{color:var(--dim)} .ok{color:var(--ok)} .bad{color:var(--danger)}
.badge{display:inline-block;padding:1px 7px;border-radius:4px;background:rgba(128,128,128,.14);color:var(--dim);font-size:10px;white-space:nowrap}
.badge.authnone{background:rgba(248,113,113,.15);border:1px solid rgba(248,113,113,.45);color:var(--danger);font-weight:700}
.badge.ssh{background:rgba(124,58,237,.15);color:#7c3aed}
.badge.token{background:rgba(8,145,178,.15);color:#0891b2}
.expand{border-top:1px solid var(--border);padding:12px;background:var(--panel)}
.section-label{font-size:11px;font-weight:700;color:var(--dim);margin:8px 0 6px;text-transform:uppercase}
.url-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:var(--bg)}
.url-row a{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--accent);text-decoration:none;font-family:ui-monospace,monospace;font-size:12px}
.url-row .lbl{font-size:10px;color:var(--dim);min-width:70px}
table{width:100%;border-collapse:collapse}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--border);font-size:12px}
th{color:var(--dim);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.matrix-cell{border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center;cursor:pointer;background:var(--panel)}
.matrix-cell:hover{border-color:var(--accent)}
.matrix-cell b{font-size:18px;display:block}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
label{display:block;font-size:11px;color:var(--dim);margin-bottom:3px}
input,select{width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px;font-family:inherit}
textarea{width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px;font-family:ui-monospace,monospace}
.hint{font-size:10px;color:var(--dim);margin-top:2px}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:8px;background:var(--panel);border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.2);font-size:12px;z-index:1200;max-width:80vw;word-break:break-all}
.toast.err{border-color:var(--danger);color:var(--danger)}
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:1100}
.modal{width:min(520px,92vw);max-height:84vh;overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
.modal h3{font-size:14px;margin-bottom:10px}
.modal .kv{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px}
.modal .kv .k{flex-shrink:0;width:70px;color:var(--dim)}
.modal .kv .v{flex:1;min-width:0;word-break:break-all}
pre.log{max-height:140px;overflow:auto;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:10px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,monospace}
.muted{color:var(--dim);font-size:12px}
.spin{animation:spin 1s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{padding:28px;text-align:center;color:var(--dim)}
.actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
</style>
`;

const SHELL = (lang: Lang, csrf: string) => {
  const L = (k: string, p?: Record<string, string>) => translate(lang, k, p);
  return `<!DOCTYPE html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="csrf-token" content="${csrf}">
<title>service-tunnels</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🚀 ${L("ui.title")}</h1>
    <span class="dstat"><span class="dot off" id="daemonDot"></span><span id="daemonTxt">…</span></span>
    <span class="dstat" id="modeTxt"></span>
    <div class="spacer"></div>
    <span class="dstat" id="pollTxt"></span>
    <button class="btn btn-sm" id="refreshBtn">⟳</button>
    <button class="btn btn-sm" id="langBtn">${lang === "zh" ? "EN" : "中文"}</button>
  </header>
  <div class="tabs" id="tabs"></div>
  <main id="content"></main>
</div>
<div id="modalRoot"></div>
<div id="toastRoot"></div>
<script>
window.UI_MSG = ${JSON.stringify(CATALOG[lang])};
window.UI_CSRF = '${csrf}';
</script>
<script src="/ui/core.js"></script>
<script src="/ui/ports.js"></script>
<script src="/ui/exposes.js"></script>
<script src="/ui/users.js"></script>
<script src="/ui/tokens.js"></script>
<script src="/ui/sites.js"></script>
<script src="/ui/tools.js"></script>
<script src="/ui/ddns.js"></script>
<script src="/ui/config.js"></script>
<script src="/ui/main.js"></script>
</body>
</html>`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Request handler — CSRF/Host gate + static client + JSON API + SPA shell.
// ─────────────────────────────────────────────────────────────────────────────

function createHandler(ctx: UiContext): RequestListener {
  return async (req, res) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const acceptLang = String(req.headers["accept-language"] ?? "");
    const lang: Lang = resolveLang(url.searchParams.get("lang") ?? undefined, { LANG: acceptLang.split(",")[0] ?? "" });
    const path = url.pathname;

    // ── CSRF / same-origin / loopback-host gate ─────────────────────────
    if (req.method === "POST") {
      if (!isLoopbackHost(req.headers.host)) {
        json(res, 403, { error: "non-loopback host rejected" });
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${ctx.port}` && origin !== `http://localhost:${ctx.port}`) {
        json(res, 403, { error: "cross-origin request rejected" });
        return;
      }
      const sent = Buffer.from(String(req.headers["x-csrf-token"] ?? ""));
      const expected = Buffer.from(ctx.csrfToken);
      if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
        json(res, 403, { error: "missing or invalid CSRF token" });
        return;
      }
    }

    try {
      // 前端模块静态文件（/ui/*.js）
      if (path.startsWith("/ui/")) {
        const name = basename(path.slice(4));
        if (!CLIENT_FILES.includes(name)) {
          json(res, 404, { error: "unknown client file" });
          return;
        }
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        res.end(readFileSync(join(clientDir(), name), "utf8"));
        return;
      }

      // JSON API
      if (path.startsWith("/api/")) {
        if (await createApiHandler(ctx, req, res, path, url, lang)) return;
        return; // createApiHandler 已回 404
      }

      // SPA shell（任何其他 GET）
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SHELL(lang, ctx.csrfToken));
    } catch (err) {
      console.error("UI error:", err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export interface UiServer {
  close(): void;
  /** Actual listening port (resolves 0 → random at bind time). */
  port: number;
}

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
