// @aiti-ai/service-tunnels — official scoped alias for `service-tunnels`.
//
// This package is a thin shell: its only dependency is `"service-tunnels": "*"`
// (resolves to the newest stable release at install time), and it re-exports
// the entire main-package API so that
//
//   import { ... } from '@aiti-ai/service-tunnels'
//
// is a drop-in equivalent of `import { ... } from 'service-tunnels'`.
// CLI bins (service-tunnels / sts) are shimmed in ./bin.js.
export * from 'service-tunnels';
