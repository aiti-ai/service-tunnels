// Copy vendored CJS files (src/vendor → dist/vendor) that tsc does not emit.
// The TS facade (src/ssh/vendor.ts) loads them via createRequire with a
// relative path, so both trees must stay in sync after build.
import { chmodSync, cpSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Each vendored dir carries its own package.json {"type":"commonjs"} so the CJS
// contents load correctly inside this ESM package after tsc.
const vendored = [["src/vendor", "dist/vendor"], ["src/upgrade/vendor", "dist/upgrade/vendor"]];

for (const [src, dist] of vendored) {
  const srcAbs = join(root, src);
  const distAbs = join(root, dist);
  if (!existsSync(srcAbs)) {
    console.log(`copy-vendor: no ${src}, nothing to do`);
    continue;
  }
  mkdirSync(distAbs, { recursive: true });
  cpSync(srcAbs, distAbs, { recursive: true });
  console.log(`copy-vendor: ${src} -> ${dist}`);
}

// bin hygiene: the built CLI carries a shebang but tsc does not preserve the
// exec bit - embedders that execFile it directly (no node prefix) would hit
// EACCES on local checkouts. Published installs are unaffected (npm bin shims).
const cliJs = join(root, "dist", "cli.js");
if (process.platform !== "win32" && existsSync(cliJs)) {
  chmodSync(cliJs, 0o755);
  console.log("copy-vendor: chmod 755 dist/cli.js");
}
