/**
 * Bundle justget (single-file ESM) into src/vendor/justget/justget.mjs.
 *
 * Why: justget is a runtime dep whose dist does bare imports of node-fetch
 * etc. When service-tunnels is VENDORED into a host extension (jiti loads
 * modules from the extension dir, bare specifiers resolve from the HOST's
 * node_modules), those bare imports break. Bundling justget into one file
 * removes the entire external chain — the vendored copy is fully
 * self-contained and normal npm installs need no justget dependency.
 *
 * Regenerate after bumping the justget version:
 *   node scripts/build-justget.mjs
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "node_modules/justget/dist/index.js")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  outfile: resolve(root, "src/vendor/justget/justget.mjs"),
  // tree-shake 到 tools.ts 实际用到的 download（及其依赖链）
  treeShaking: true,
  logLevel: "info",
});
console.log("[justget] → src/vendor/justget/justget.mjs");
