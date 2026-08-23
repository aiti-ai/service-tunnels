/**
 * Bundle justget/browser into a single-file IIFE for the browser:
 * src/vendor/justget/justget-browser.js → served by portal at
 * /assets/justget-browser.js (global: window.justgetBrowser).
 *
 * Why IIFE global: the portal 2FA pages are plain HTML without a bundler;
 * they load scripts via <script src>. Serving the bundle from the portal
 * origin keeps the face 2FA flow self-bootstrapping (no public CDN dep —
 * justget 0.2.x lives on the internal registry only).
 *
 * Regenerate after bumping the justget version:
 *   node scripts/build-justget-browser.mjs
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "node_modules/justget/dist/browser/index.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  globalName: "justgetBrowser",
  outfile: resolve(root, "src/vendor/justget/justget-browser.js"),
  // tree-shake 到 portal 页面实际用到的 download（及其依赖链）
  treeShaking: true,
  logLevel: "info",
});
console.log("[justget] → src/vendor/justget/justget-browser.js");
