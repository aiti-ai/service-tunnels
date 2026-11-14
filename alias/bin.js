#!/usr/bin/env node
// Bin shim for the @aiti-ai/service-tunnels alias.
//
// Global installs (`npm i -g @aiti-ai/service-tunnels`) only link the
// top-level package's own bins, so we must not rely on the dependency's bins
// being exposed. This shim executes the real CLI from the installed
// `service-tunnels` package.
//
// The main package's `exports` map intentionally does not expose ./dist/cli.js
// as a subpath, so we locate the package root via its exported ./package.json
// and build the dist/cli.js file URL from there.
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgUrl = pathToFileURL(require.resolve('service-tunnels/package.json'));
const cliUrl = new URL('./dist/cli.js', pkgUrl).href;

await import(cliUrl);
