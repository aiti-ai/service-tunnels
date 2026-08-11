// Copy vendored CJS files (src/vendor → dist/vendor) that tsc does not emit.
// The TS facade (src/ssh/vendor.ts) loads them via createRequire with a
// relative path, so both trees must stay in sync after build.
import { cpSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "vendor");
const dist = join(root, "dist", "vendor");

if (!existsSync(src)) {
  console.log("copy-vendor: no src/vendor, nothing to do");
  process.exit(0);
}
mkdirSync(dist, { recursive: true });
// Keep package.json: {"type":"commonjs"} marks the vendored dir as CJS
// inside this ESM package — without it dist/*.js would load as ESM.
cpSync(src, dist, { recursive: true });
console.log("copy-vendor: src/vendor -> dist/vendor");
