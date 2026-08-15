import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";
import { gunzipSync } from "node:zlib";

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-inject-"));
  return { base, cacheDir: join(base, "cache"), configDir: join(base, "config") };
}

function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = request(opts, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 一个测试后端：主页面（含 </head>）、模板片段（无 </head>）、JSON/JS。 */
function startBackend() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.url === "/target.html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><head><title>t1</title></head><body>target</body></html>"); return; }
      if (req.url === "/a/b/c") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><head><title>abc</title></head><body>deep</body></html>"); return; }
      if (req.url === "/tpl") { res.writeHead(200, { "content-type": "text/html" }); res.end("<div class=user-tpl>partial template</div>"); return; }
      if (req.url === "/data.json") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
      if (req.url === "/app.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end("console.log(1);"); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>t</title></head><body>hello</body></html>");
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

/** 带 Accept-Encoding: gzip 的导航请求：验证注入后重压链序（gzip 解压后
 *  注入字节仍在正确位置；prepend = 最前，head = </head> 前）。 */
function gzipNavGet(port, host, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { Host: host, "Accept-Encoding": "gzip", "Sec-Fetch-Mode": "navigate", connection: "close" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let decoded = null;
        try { decoded = gunzipSync(Buffer.concat(chunks)).toString("utf8"); } catch { /* 非 gzip 时留 null */ }
        resolve({ status: res.statusCode, enc: res.headers["content-encoding"] ?? null, decoded });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const NGNIX_BIN = ["/usr/sbin/nginx", "/usr/local/sbin/nginx", "/opt/homebrew/sbin/nginx"].find(existsSync) ?? "nginx";

test("gateway inject: config generation (head via sub_filter, prepend via add_before_body)", async () => {
  const { generateHostNginx } = await import("../src/gateway.ts");
  // head 模式：map（Sec-Fetch-Mode 导航才注入）+ sub_filter（替换串是变量）
  const head = generateHostNginx(
    { host: "demo.ngrok-free.app", port: 5173, authMode: "basic", htpasswdFile: "/tmp/h", inject: { html: `<script src="x.js"></script>`, position: "head" } },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.match(head, /map \$http_sec_fetch_mode\$http_x_requested_with \$st_injh_[0-9a-f]{16} \{/);
  assert.match(head, /cors '<\/head>';/); // XHR/fetch → 恒等（不注入）
  assert.match(head, /'~XMLHttpRequest' '<\/head>';/); // 老式 XHR → 不注入
  assert.match(head, /sub_filter '<\/head>' '\$st_injh_[0-9a-f]{16}';/);
  assert.match(head, /sub_filter_once on;/);
  assert.match(head, /sub_filter_types text\/html;/);
  assert.match(head, /proxy_set_header Accept-Encoding "";/);
  assert.match(head, /gzip on;/); // 注入后重压回 gzip（隧道链路恢复压缩）
  assert.match(head, /gzip_proxied any;/);
  assert.match(head, /gzip_types text\/css application\/javascript application\/json image\/svg\+xml text\/plain;/);
  assert.equal(head.includes("add_before_body"), false, "head mode must not use addition module");
  // 注入只落在 location /（应用主代理）——provider 登录页/白名单 location 不注入
  assert.ok(head.indexOf("sub_filter") > head.indexOf("location /"), "sub_filter lives inside location /");

  // prepend 模式：add_before_body + 内部 location（map 切空响应）
  const prep = generateHostNginx(
    { host: "demo.ngrok-free.app", port: 5173, authMode: "none", inject: { html: "<script>prepend()</script>", position: "prepend" } },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.match(prep, /add_before_body \/__st_inj_demo\.ngrok-free\.app\.html;/);
  assert.match(prep, /location = \/__st_inj_demo\.ngrok-free\.app\.html \{/);
  assert.match(prep, /if \(\$st_injp_[0-9a-f]{16} = "1"\) \{ rewrite \^ \/__st_empty_demo\.ngrok-free\.app\.html last; \}/);
  assert.equal(prep.includes("$http_x_requested_with) { rewrite"), false, "x-requested-with folded into the map key");
  assert.match(prep, /return 200 '';/); // 空响应（不注入）由内部 location 提供
  assert.equal(prep.includes("sub_filter"), false, "prepend mode must not use sub_filter");
  assert.match(prep, /gzip on;/); // prepend 模式同样重压（addition → … → gzip 链序）
  // string 简写 → head 模式
  const str = generateHostNginx(
    { host: "a.example.com", port: 5173, inject: "<b>hi</b>" },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.match(str, /sub_filter '<\/head>' '\$st_injh_[0-9a-f]{16}';/);

  // bypass 白名单 location 同样带注入（所有直接请求的页面都注入）
  const bypass = generateHostNginx(
    { host: "b.example.com", port: 5173, authMode: "none", bypassPaths: ["/health", "/app"], inject: "<b>hi</b>" },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  const subCount = (bypass.match(/sub_filter '<\/head>'/g) ?? []).length;
  assert.equal(subCount, 3, "location / + 2 bypass locations each carry sub_filter (all direct pages inject)");
  const gzipCount = (bypass.match(/gzip on;/g) ?? []).length;
  assert.equal(gzipCount, 3, "gzip recompression follows every injected location");

  // recompress: false → 关闭重压（追求流式 flush）；无 inject → 完全不碰压缩
  const noRecomp = generateHostNginx(
    { host: "c.example.com", port: 5173, authMode: "none", inject: { html: "<b>x</b>", recompress: false } },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.equal(noRecomp.includes("gzip on;"), false, "recompress:false disables re-gzip");
  assert.match(noRecomp, /proxy_set_header Accept-Encoding "";/, "strip still required (sub_filter needs identity)");
  const noInject = generateHostNginx(
    { host: "d.example.com", port: 5173, authMode: "none" },
    { nginxPort: 4180, nginxRoot: "/tmp/x/nginx" },
  );
  assert.equal(noInject.includes("gzip"), false, "non-inject host: compression passes through untouched");
});

test("gateway inject: real nginx e2e — 只注入主页面导航的 text/html", { timeout: 60_000 }, async (t) => {
  if (!existsSync(NGNIX_BIN)) {
    t.skip("nginx not installed");
    return;
  }
  const { GatewayController } = await import("../src/gateway.ts");
  const { cacheDir, configDir, base } = tempDirs();
  const backend = await startBackend();
  const gateway = new GatewayController({
    configDir, cacheDir, nginxBin: NGNIX_BIN, port: 0,
    registerInternal: () => {}, unregisterInternal: () => {}, registerPid: () => {}, log: () => {},
  });
  const inject = { html: `<script>window.__INJECTED__ = true</script>`, position: "head" };
  try {
    const gwPort = await gateway.start("none");
    await gateway.registerHost("demo.inject.test", backend.port, { authMode: "none", inject, bypassPaths: ["/public"] });
    const host = { host: "127.0.0.1", port: gwPort, headers: { Host: "demo.inject.test" } };

    // 1) 主页面导航（Sec-Fetch-Mode: navigate）→ 注入
    const nav = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: "/" });
    assert.equal(nav.status, 200);
    assert.match(nav.body, /window\.__INJECTED__/);
    // 注入在 </head> 前
    assert.ok(nav.body.indexOf("__INJECTED__") < nav.body.indexOf("</head>"), "injected before </head>");

    // 1b) 不只 / —— 所有直接导航请求的页面都注入（nginx location / 前缀匹配；
    //     bypass 白名单 location 同样带注入）：
    //     /target.html、深层路径 /a/b/c、子目录页、白名单 /public/page.html
    for (const p of ["/target.html", "/a/b/c", "/sub/deep.html", "/public/page.html"]) {
      const page = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: p });
      assert.equal(page.status, 200);
      assert.match(page.body, /window\.__INJECTED__/, `page ${p} must inject (direct navigation)`);
      assert.ok(page.body.indexOf("__INJECTED__") < page.body.indexOf("</head>"), `injected before </head> on ${p}`);
    }

    // 2) XHR/fetch（cors）→ 不注入（主页面也不注入）
    const xhr = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "cors" }, path: "/" });
    assert.equal(xhr.body.includes("__INJECTED__"), false, "XHR main-page request must not inject");

    // 3) X-Requested-With（老式 XHR）→ 不注入
    const xrw = await httpReq({ ...host, headers: { ...host.headers, "X-Requested-With": "XMLHttpRequest" }, path: "/" });
    assert.equal(xrw.body.includes("__INJECTED__"), false);

    // 4) 无 Sec-Fetch 头（curl/老浏览器直连）→ 注入（缺省兼容）
    const plain = await httpReq({ ...host, path: "/" });
    assert.match(plain.body, /window\.__INJECTED__/);

    // 4b) 带 Accept-Encoding: gzip → 注入后重压回 gzip：解压后注入仍在 </head> 前
    //     （sub_filter → … → gzip 链序：压的是注入完成的合并输出）
    const gz = await gzipNavGet(gwPort, "demo.inject.test", "/");
    assert.equal(gz.status, 200);
    assert.equal(gz.enc, "gzip", "injected navigation served with content-encoding: gzip");
    assert.ok(gz.decoded !== null, "response body must be gzip (decodable)");
    assert.ok(gz.decoded.indexOf("__INJECTED__") < gz.decoded.indexOf("</head>"), "head inject survives recompression");

    // 5) 非 text/html（JSON/JS）即使 navigate 也不注入——不破坏用户文件
    const json = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: "/data.json" });
    assert.equal(json.body, '{"ok":true}');
    const js = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: "/app.js" });
    assert.equal(js.body, "console.log(1);");

    // 6) 后加载模板片段经 XHR（cors）→ 不注入（head 模式无 </head> 本来也不匹配）
    const tpl = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "cors" }, path: "/tpl" });
    assert.equal(tpl.body, "<div class=user-tpl>partial template</div>");
  } finally {
    await gateway.stop().catch(() => {});
    backend.close();
  }
  rmSyncSafe(base);
});

test("gateway inject: prepend e2e — add_before_body 只注入主页面导航", { timeout: 60_000 }, async (t) => {
  if (!existsSync(NGNIX_BIN)) {
    t.skip("nginx not installed");
    return;
  }
  const { GatewayController } = await import("../src/gateway.ts");
  const { cacheDir, configDir, base } = tempDirs();
  const backend = await startBackend();
  const gateway = new GatewayController({
    configDir, cacheDir, nginxBin: NGNIX_BIN, port: 0,
    registerInternal: () => {}, unregisterInternal: () => {}, registerPid: () => {}, log: () => {},
  });
  const inject = { html: `<script>window.__PREPEND__=1</script>`, position: "prepend" };
  try {
    const gwPort = await gateway.start("none");
    await gateway.registerHost("demo.inject.test", backend.port, { authMode: "none", inject });
    const host = { host: "127.0.0.1", port: gwPort, headers: { Host: "demo.inject.test" } };

    // 1) 主页面导航 → 响应开头注入（doctype 之前）
    const nav = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: "/" });
    assert.equal(nav.status, 200);
    assert.ok(nav.body.startsWith("<script>window.__PREPEND__=1</script>"), "prepend injected at response start: " + nav.body.slice(0, 60));

    // 1b) 不只 / —— 所有直接导航请求的页面（/target.html、/a/b/c、子目录）都注入
    for (const p of ["/target.html", "/a/b/c", "/sub/deep.html"]) {
      const page = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: p });
      assert.equal(page.status, 200);
      assert.ok(page.body.startsWith("<script>window.__PREPEND__=1</script>"), `prepend injected on ${p}: ` + page.body.slice(0, 60));
    }

    // 2) XHR（cors）/ X-Requested-With → 不注入
    const xhr = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "cors" }, path: "/" });
    assert.equal(xhr.body.includes("__PREPEND__"), false);
    const xrw = await httpReq({ ...host, headers: { ...host.headers, "X-Requested-With": "XMLHttpRequest" }, path: "/" });
    assert.equal(xrw.body.includes("__PREPEND__"), false);

    // 3) 无头直连（curl）→ 注入
    const plain = await httpReq({ ...host, path: "/" });
    assert.ok(plain.body.startsWith("<script>window.__PREPEND__=1</script>"));

    // 4b) 带 Accept-Encoding: gzip → 注入后重压回 gzip：解压后注入字节仍在最前
    //     （addition → … → gzip 链序：压的是注入完成的合并输出）
    const gz = await gzipNavGet(gwPort, "demo.inject.test", "/");
    assert.equal(gz.status, 200);
    assert.equal(gz.enc, "gzip", "injected navigation served with content-encoding: gzip");
    assert.ok(gz.decoded !== null, "response body must be gzip (decodable)");
    assert.ok(gz.decoded.startsWith("<script>window.__PREPEND__=1</script>"), "prepend bytes survive recompression: " + gz.decoded.slice(0, 40));

    // 4) 非 text/html 不注入；模板片段经 XHR 不注入（不注坏用户文件）
    const json = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: "/data.json" });
    assert.equal(json.body, '{"ok":true}');
    const js = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "navigate" }, path: "/app.js" });
    assert.equal(js.body, "console.log(1);");
    const tpl = await httpReq({ ...host, headers: { ...host.headers, "Sec-Fetch-Mode": "cors" }, path: "/tpl" });
    assert.equal(tpl.body, "<div class=user-tpl>partial template</div>");
  } finally {
    await gateway.stop().catch(() => {});
    backend.close();
  }
  rmSyncSafe(base);
});

function rmSyncSafe(p) {
  try { require("node:fs").rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}
