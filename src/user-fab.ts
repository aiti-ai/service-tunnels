// 登录信息按钮（login-info FAB）——生成注入到受保护应用页面的内联脚本。
// 设计见 docs/user-fab-inject-design.md：
//   - 静态 JS（无用户数据）：用户名运行时 fetch /__st_auth__（JSON，防 XSS）
//   - Shadow DOM 隔离 + all:initial（防宿主 CSS 污染）
//   - 拖动机制移植自 aiti-devtools launcher（阈值判定/late 捕获/
//     pointercancel 必达/四边停靠+clamp/localStorage 记忆）
//   - iframe 内跳过渲染（window.top !== window.self）
//
// 实现方式：FAB_JS 是纯 JS 源文本（模板字符串）——不经过 TS 编译器（保留
// 浏览器全局语义 & 源码原样进注入 HTML；cfg 以 JSON 参数注入 IIFE）。

export interface LoginFabConfig {
  /** authelia/basic 的登出 URL（静态常量注入；portal 留空——回显 JSON 提供）。 */
  logoutUrl?: string;
  /** basic 模式（无服务端会话，登出走无效凭据覆盖/提示）。 */
  basic?: boolean;
}

/** fab JS 的 URL 路径（nginx internal location serve 静态文件）。 */
export const FAB_JS_PATH = "/__st_fab__.js";

/** 注入 HTML：外链 script（src 指向 nginx internal 静态文件；cfg 经查询串
 *  传递或内联常量——v1 内联到 JS 文件尾部，见 loginFabFile）。
 *  外链而非内联的原图：nginx map 参数长度有限（~8KB 限制，内联 10KB JS 会
 *  too long parameter 报错），且外链绕过宿主页面的严格 CSP script-src
 *  限制（同源脚本通常被 nonce/hash 白名单放行）。 */
export function loginFabScript(_cfg: LoginFabConfig = {}): string {
  return '<script id="__st_fab__" src="' + FAB_JS_PATH + '"></script>';
}

/** fab JS 文件内容（cfg 静态常量内联尾部——服务端常量，无用户输入）。 */
export function loginFabFile(cfg: LoginFabConfig = {}): string {
  return "(" + FAB_JS + ")(" + JSON.stringify(cfg) + ");\n";
}

const FAB_JS = String.raw`
function (cfg) {
  "use strict";
  // iframe 内跳过（避免嵌套页多个重叠 FAB）
  try { if (window.top !== window.self) return; } catch (e) { return; }

  fetch("/__st_auth__", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) return null;
      var ct = r.headers.get("content-type") || "";
      if (ct.indexOf("application/json") >= 0) return r.json();
      // authelia/basic：头拼装
      var user = r.headers.get("x-st-auth-user") || r.headers.get("remote-user") || "";
      if (!user) return null;
      return { user: user, displayName: user, provider: "gateway", logoutUrl: cfg.logoutUrl || "", basic: !!cfg.basic };
    })
    .then(function (info) { if (info && info.user) boot(info); })
    .catch(function () { /* 网络错误/超时 → 不渲染 */ });

  function boot(info) {
    var STORAGE = "st_fab_pos";
    var EDGE_MARGIN = 16;
    var FAB_SIZE = 40;
    var DRAG_THRESHOLD = 6; // 超过此位移才算拖动（纯点击留给展开）

    var host = document.createElement("div");
    host.id = "__st_fab_host__";
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var style = document.createElement("style");
    style.textContent = [
      ":host{all:initial}",
      "*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
      "#fab{position:fixed;width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.18);",
      "  background:rgba(30,32,38,.92);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);",
      "  color:#fff;font-size:15px;font-weight:600;display:flex;align-items:center;justify-content:center;",
      "  cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;z-index:2147483646;",
      "  box-shadow:0 2px 10px rgba(0,0,0,.35);transition:box-shadow .15s}",
      "#fab:hover{box-shadow:0 4px 16px rgba(0,0,0,.5)}",
      "#fab.dragging{transition:none;box-shadow:0 8px 24px rgba(0,0,0,.55);cursor:grabbing}",
      "#panel{position:fixed;width:210px;border-radius:12px;border:1px solid rgba(255,255,255,.14);",
      "  background:rgba(30,32,38,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);",
      "  color:#e8eaee;padding:14px;z-index:2147483647;box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:13px}",
      "#panel .u{font-weight:600;font-size:14px;color:#fff;word-break:break-all}",
      "#panel .d{color:#9aa0ab;font-size:11px;margin-top:2px}",
      "#panel .p{display:inline-block;margin-top:8px;padding:1px 8px;border-radius:99px;font-size:10px;",
      "  background:rgba(59,130,246,.2);color:#7ab0ff;border:1px solid rgba(59,130,246,.35)}",
      "#panel .out{margin-top:12px;width:100%;padding:7px 0;border-radius:8px;border:1px solid rgba(239,68,68,.4);",
      "  background:rgba(239,68,68,.14);color:#ff8a8a;font-size:12px;font-weight:600;cursor:pointer}",
      "#panel .out:hover{background:rgba(239,68,68,.28);color:#ffb0b0}",
      "#panel .hint{margin-top:8px;color:#9aa0ab;font-size:10px;line-height:1.5}",
      "@media(max-width:480px){#fab{width:36px;height:36px;font-size:13px}}",
    ].join("");
    root.appendChild(style);

    var fab = document.createElement("div");
    fab.id = "fab";
    fab.title = info.user;
    var label = (info.displayName || info.user).trim();
    fab.textContent = Array.from(label)[0] || "?";

    var panel = null;
    var open = false;

    fab.addEventListener("click", function () {
      if (dragMoved) return; // 拖动后的松手不算点击
      toggle();
    });

    function toggle() {
      if (open) { closePanel(); return; }
      panel = document.createElement("div");
      panel.id = "panel";
      var u = document.createElement("div");
      u.className = "u";
      u.textContent = info.user; // textContent——从不 innerHTML（防 XSS）
      var d = document.createElement("div");
      d.className = "d";
      d.textContent = info.displayName && info.displayName !== info.user ? info.displayName : "";
      var p = document.createElement("span");
      p.className = "p";
      p.textContent = info.provider === "portal" ? "portal 登录" : "网关登录";
      panel.appendChild(u);
      if (d.textContent) panel.appendChild(d);
      panel.appendChild(p);

      if (info.basic) {
        var hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "HTTP Basic 无服务端会话：点击退出用无效凭据覆盖浏览器缓存（部分浏览器不支持，需关闭窗口彻底登出）";
        panel.appendChild(hint);
        panel.appendChild(mkBtn(function () {
          fetch("/__st_auth__", {
            headers: { Authorization: "Basic " + btoa("logout:logout") },
            credentials: "same-origin",
          }).catch(function () {}).then(function () { location.reload(); });
        }));
      } else if (info.logoutUrl) {
        panel.appendChild(mkBtn(function () { location.href = info.logoutUrl; }));
      }
      root.appendChild(panel);
      positionPanel();
      open = true;
      setTimeout(function () {
        document.addEventListener("click", outsideClose, true);
      }, 0);
    }

    function mkBtn(fn) {
      var b = document.createElement("button");
      b.className = "out";
      b.type = "button";
      b.textContent = "退出登录";
      b.addEventListener("click", fn);
      return b;
    }

    function closePanel() {
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      open = false;
      document.removeEventListener("click", outsideClose, true);
    }

    function outsideClose(e) {
      if (open && !host.contains(e.target) && e.target !== host) closePanel();
    }

    function positionPanel() {
      var r = fab.getBoundingClientRect();
      var pw = 210, ph = panel.getBoundingClientRect().height || 140;
      var x = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), innerWidth - pw - 8);
      var y = r.top - ph - 10;
      if (y < 8) y = r.bottom + 10;
      panel.style.left = x + "px";
      panel.style.top = y + "px";
    }

    // ── 拖动（移植 aiti-devtools makePointerDrag 核心）──
    var pos = loadPos();
    var dragMoved = false;
    var drag = null;

    fab.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      drag = { pid: e.pointerId, sx: e.clientX, sy: e.clientY };
      dragMoved = false;
    });

    window.addEventListener("pointermove", function (ev) {
      if (!drag || (drag.pid != null && ev.pointerId !== drag.pid)) return;
      var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!dragMoved) {
        if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
        dragMoved = true;
        fab.classList.add("dragging");
        try { fab.setPointerCapture(ev.pointerId); } catch (err) {}
        closePanel();
      }
      try { ev.preventDefault(); } catch (err) {}
      var r = fab.getBoundingClientRect();
      fab.style.left = clamp(r.left + dx, 0, innerWidth - r.width) + "px";
      fab.style.top = clamp(r.top + dy, 0, innerHeight - r.height) + "px";
      fab.style.right = "auto";
      fab.style.bottom = "auto";
      drag.sx = ev.clientX;
      drag.sy = ev.clientY;
    });

    function endDrag() {
      if (!drag) return;
      var moved = dragMoved;
      drag = null;
      fab.classList.remove("dragging");
      if (!moved) return;
      // 四边停靠：吸附最近边 + 沿边 clamp
      var r = fab.getBoundingClientRect();
      var dists = [
        { edge: "left", d: r.left },
        { edge: "right", d: innerWidth - r.right },
        { edge: "top", d: r.top },
        { edge: "bottom", d: innerHeight - r.bottom },
      ].sort(function (a, b) { return a.d - b.d; });
      var edge = dists[0].edge;
      var out = { edge: edge, x: 0, y: 0 };
      if (edge === "left") { out.x = EDGE_MARGIN; out.y = clamp(r.top, EDGE_MARGIN, innerHeight - r.height - EDGE_MARGIN); }
      else if (edge === "right") { out.x = innerWidth - r.width - EDGE_MARGIN; out.y = clamp(r.top, EDGE_MARGIN, innerHeight - r.height - EDGE_MARGIN); }
      else if (edge === "top") { out.x = clamp(r.left, EDGE_MARGIN, innerWidth - r.width - EDGE_MARGIN); out.y = EDGE_MARGIN; }
      else { out.x = clamp(r.left, EDGE_MARGIN, innerWidth - r.width - EDGE_MARGIN); out.y = innerHeight - r.height - EDGE_MARGIN; }
      pos = out;
      savePos();
      applyPos();
    }

    // pointercancel/lostpointercapture 必达结束（触屏系统手势取消时手势残留会卡死）
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    fab.addEventListener("lostpointercapture", endDrag);

    function applyPos() {
      fab.style.left = pos.x + "px";
      fab.style.top = pos.y + "px";
      fab.style.right = "auto";
      fab.style.bottom = "auto";
    }

    function savePos() {
      try { localStorage.setItem(STORAGE, JSON.stringify(pos)); } catch (e) {}
    }

    function loadPos() {
      try {
        var s = localStorage.getItem(STORAGE);
        if (s) {
          var d = JSON.parse(s);
          if (d && d.edge && typeof d.x === "number" && typeof d.y === "number") {
            return { edge: d.edge, x: clamp(d.x, EDGE_MARGIN, Math.max(EDGE_MARGIN, innerWidth - FAB_SIZE - EDGE_MARGIN)), y: clamp(d.y, EDGE_MARGIN, Math.max(EDGE_MARGIN, innerHeight - FAB_SIZE - EDGE_MARGIN)) };
          }
        }
      } catch (e) {}
      return { edge: "bottom", x: innerWidth - FAB_SIZE - EDGE_MARGIN, y: innerHeight - FAB_SIZE - EDGE_MARGIN };
    }

    function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), Math.max(lo, hi)); }

    window.addEventListener("resize", function () {
      var r = fab.getBoundingClientRect();
      pos.x = clamp(r.left, 0, Math.max(0, innerWidth - FAB_SIZE));
      pos.y = clamp(r.top, 0, Math.max(0, innerHeight - FAB_SIZE));
      applyPos();
    });

    root.appendChild(fab);
    applyPos();
    document.documentElement.appendChild(host);
  }
}
`;
