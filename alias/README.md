# @aiti-ai/service-tunnels

Official **scoped alias** for [`service-tunnels`](https://www.npmjs.com/package/service-tunnels) — the canonical, unscoped package name.

```bash
npm i -g @aiti-ai/service-tunnels   # ≡ npm i -g service-tunnels (latest)
```

## What this package is

A placeholder shell. Its single dependency is:

```jsonc
{ "service-tunnels": "*" }   // resolves to the newest stable release at install time
```

Installing it gives you, at install time, the **latest** `service-tunnels`:

- the full library API, re-exported one-to-one — `import { ... } from '@aiti-ai/service-tunnels'` is a drop-in equivalent of importing from `service-tunnels`;
- the same CLI bins (`service-tunnels`, `sts`), shimmed through to the real package.

## Semantics of "always latest"

`*` resolves when **npm installs**, not retroactively: projects already installed (or with a lockfile) keep their pinned copy until `npm update` / reinstall. That is standard npm behavior — this alias never pins anything itself, so every fresh install tracks the newest stable release (prereleases excluded).

## Why an alias?

`service-tunnels` (unscoped) is and stays the canonical name. The `@aiti-ai` scoped name exists so users who prefer or require scoped imports (and org-scoped tooling) can install the same tool. The alias version number always matches the main package version it was released with.

## Links

- Canonical package: https://www.npmjs.com/package/service-tunnels
- Source & issues: https://github.com/aiti-ai/service-tunnels
- License: MIT
