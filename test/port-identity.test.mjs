import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { createServer } from "node:http";
import {
  identifyPort,
  enrichWithIdentity,
  clearIdentityCache,
  extractTitle,
  extractIconHref,
} from "../src/port-identity.ts";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// 1x1 PNG（最小合法头）
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ff9b4c920000000049454e44ae426082",
  "hex",
);

test("extractTitle: 实体解码 + 压空白 + 截断", () => {
  assert.equal(extractTitle("<html><head><title> My &amp; App </title></head></html>"), "My & App");
  assert.equal(extractTitle("<title>line1\n\tline2</title>"), "line1 line2");
  assert.equal(extractTitle("<TITLE>Mixed Case</TITLE>"), "Mixed Case");
  assert.equal(extractTitle("<div>no title</div>"), undefined);
  assert.equal(extractTitle("<title>unclosed"), undefined);
  assert.equal(extractTitle(`<title>${"x".repeat(300)}</title>`).length, 120);
});

test("extractIconHref: 普通 icon 优先于 apple-touch-icon，支持 data: URL", () => {
  assert.equal(
    extractIconHref('<link rel="apple-touch-icon" href="/a.png"><link rel="icon" href="/fav.ico">'),
    "/fav.ico",
  );
  assert.equal(extractIconHref('<link rel="shortcut icon" href="/x.ico">'), "/x.ico");
  assert.equal(
    extractIconHref('<link rel="stylesheet" href="/s.css"><link rel="icon" href="data:image/svg+xml,%3Csvg/%3E">'),
    "data:image/svg+xml,%3Csvg/%3E",
  );
  assert.equal(extractIconHref('<link rel="stylesheet" href="/s.css">'), undefined);
});

test("identifyPort: HTML title + 内联 data: SVG favicon → data URL base64 化", async () => {
  clearIdentityCache();
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><html><head><title>Vite · Dev Server</title>' +
        '<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E">' +
        "</head><body>ok</body></html>",
    );
  });
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.equal(id.protocol, "http");
    assert.equal(id.status, 200);
    assert.equal(id.title, "Vite · Dev Server");
    assert.match(id.favicon, /^data:image\/svg\+xml;base64,/);
    assert.equal(id.contentType, "text/html");
  } finally {
    server.close();
    assert.ok(hits >= 1);
  }
});

test("identifyPort: 无 link → 默认探测 /favicon.ico（PNG → data URL）", async () => {
  clearIdentityCache();
  const server = createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end(PNG_BYTES);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Plain App</title></head><body></body></html>");
  });
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.equal(id.title, "Plain App");
    assert.match(id.favicon, /^data:image\/png;base64,/);
    assert.ok(id.faviconUrl.endsWith("/favicon.ico"));
  } finally {
    server.close();
  }
});

test("identifyPort: 回环重定向跟随并取最终 title", async () => {
  clearIdentityCache();
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Sign in</title></head></html>");
  });
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.equal(id.status, 200);
    assert.equal(id.title, "Sign in");
  } finally {
    server.close();
  }
});

test("identifyPort: 纯 TCP 服务 → protocol tcp（无 title）", async () => {
  clearIdentityCache();
  const server = net.createServer(() => {});
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.equal(id.protocol, "tcp");
    assert.equal(id.title, undefined);
  } finally {
    server.close();
  }
});

test("identifyPort: JSON API → http 但无 title/favicon", async () => {
  clearIdentityCache();
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.equal(id.protocol, "http");
    assert.equal(id.contentType, "application/json");
    assert.equal(id.title, undefined);
    assert.equal(id.favicon, undefined);
  } finally {
    server.close();
  }
});

test("identifyPort: 缓存命中——第二次调用不发请求", async () => {
  clearIdentityCache();
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Cached</title></head></html>");
  });
  const port = await listen(server);
  try {
    const first = await identifyPort(port);
    const hitsAfterFirst = hits;
    assert.ok(hitsAfterFirst >= 1);
    const second = await identifyPort(port);
    assert.equal(hits, hitsAfterFirst);
    assert.deepEqual(second, first);
  } finally {
    server.close();
  }
});

test("identifyPort: 外网重定向不跟随——停在 30x（协议仍 http）", async () => {
  clearIdentityCache();
  const server = createServer((req, res) => {
    res.writeHead(302, { Location: "https://example.com/landing" });
    res.end();
  });
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.equal(id.protocol, "http");
    assert.equal(id.status, 302);
    assert.equal(id.title, undefined);
  } finally {
    server.close();
  }
});

test("enrichWithIdentity: 附加 identity 且不改入参", async () => {
  clearIdentityCache();
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Enriched</title></head></html>");
  });
  const port = await listen(server);
  try {
    const ports = [{ port, pid: 1, process: "node", cmdline: "node server.js" }];
    const snapshot = JSON.parse(JSON.stringify(ports));
    const enriched = await enrichWithIdentity(ports);
    assert.deepEqual(ports, snapshot); // 入参不被修改
    assert.equal(enriched[0].identity.title, "Enriched");
    assert.equal(enriched[0].pid, 1);
    assert.equal(enriched[0].cmdline, "node server.js");
  } finally {
    server.close();
  }
});

test("identifyPort: 畸形 Location 不崩进程——停在 30x", async () => {
  clearIdentityCache();
  const server = createServer((req, res) => {
    res.writeHead(302, { Location: "http://[bad ipv6" }); // new URL 会 throw
    res.end();
  });
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.equal(id.protocol, "http");
    assert.equal(id.status, 302);
    assert.equal(id.title, undefined);
  } finally {
    server.close();
  }
});

test("identifyPort: Content-Type 注入引号不进 data: URL（防 UI 属性 breakout）", async () => {
  clearIdentityCache();
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ff9b4c920000000049454e44ae426082",
    "hex",
  );
  const server = createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": 'image/png" onerror="alert(1)' });
      res.end(PNG);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>t</title></head></html>");
  });
  const port = await listen(server);
  try {
    const id = await identifyPort(port);
    assert.ok(id.favicon?.startsWith("data:image/png;base64,"), "声明非法时回落魔数嗅探");
    assert.ok(!id.favicon.includes('"'), "data: URL 内不允许出现引号");
  } finally {
    server.close();
  }
});
