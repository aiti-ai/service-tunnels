#!/usr/bin/env node
// Sync alias/package.json version from the root package.json.
//
// The alias (@aiti-ai/service-tunnels) rides the same version line as the
// main package (service-tunnels): one release, two packages, same number.
// Run by publish-npm.yml before packing/publishing the alias, and safe to run
// manually after bumping the root version.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(repoRoot, 'package.json');
const aliasPath = path.join(repoRoot, 'alias', 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const alias = JSON.parse(readFileSync(aliasPath, 'utf8'));

if (alias.name !== '@aiti-ai/service-tunnels') {
  console.error(`alias package name is ${alias.name}, expected @aiti-ai/service-tunnels — aborting`);
  process.exit(1);
}

if (alias.version !== pkg.version) {
  alias.version = pkg.version;
  writeFileSync(aliasPath, JSON.stringify(alias, null, 2) + '\n');
  console.log(`alias version synced -> ${pkg.version}`);
} else {
  console.log(`alias version already in sync (${pkg.version})`);
}

if (alias.dependencies['service-tunnels'] !== '*') {
  console.error(
    `alias dependency on service-tunnels must stay "*" (always-latest contract), got: ${alias.dependencies['service-tunnels']}`
  );
  process.exit(1);
}
