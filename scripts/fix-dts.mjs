// tsc's rewriteRelativeImportExtensions rewrites .js output but leaves .ts in
// emitted .d.ts files; bundlers (turbopack) following the type path would
// then resolve node_modules/**/*.ts, which Node/turbopack cannot compile.
// Rewrite relative .ts imports in dist/*.d.ts to .js.
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "dist");
for (const f of readdirSync(root)) {
  if (!f.endsWith(".d.ts")) continue;
  const p = join(root, f);
  const s = readFileSync(p, "utf8");
  const n = s
    .replace(/(from\s+["']\.[^"']*?)\.ts(["'])/g, "$1.js$2")
    .replace(/(import\(["']\.[^"']*?)\.ts(["']\))/g, "$1.js$2");
  if (n !== s) writeFileSync(p, n);
}
console.log("dts imports rewritten to .js");
