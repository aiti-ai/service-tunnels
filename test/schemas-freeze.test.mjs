import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tunnelParamSchemas,
  TUNNEL_SCHEMAS_VERSION,
  authProviderSchemas,
  localizeSchemas,
  createServiceTunnels,
} from "../src/index.ts";
import { TUNNEL_PARAM_SCHEMAS } from "../src/tunnels.ts";
import { AUTH_PARAM_SCHEMAS, AUTH_SCHEMAS_VERSION } from "../src/auth-registry.ts";

/**
 * Schema 冻结契约（docs/adaptation-kit.md §5）：
 *  - ParamSpec 字段只增不减——新增字段必须显式加入下方基线表；
 *  - 破坏性变更（删字段/改语义）才 bump 版本号；
 *  - 对外客户端按此契约渲染表单，无需随库升级。
 */

/** 冻结基线：ParamSpec 允许字段全集（含本地化注入的 labelKey 等）。 */
const PARAM_SPEC_FIELDS = new Set([
  "key", "label", "type", "description", "link", "linkTitle",
  "default", "placeholder", "required", "options",
  "labelKey", "descriptionKey", "placeholderKey", "linkTitleKey",
  "fixed", "value",
]);

const TYPES = new Set(["string", "number", "boolean", "password"]);
const TUNNEL_TYPES = new Set(["ngrok", "cloudflared", "localtunnel", "bore", "natapp", "ssh", "serveo", "frpc", "command"]);
const AUTH_TYPES = new Set(["authelia", "basic", "oauth2-proxy", "portal", "token"]);

function walkSpecs(schemas) {
  return Object.entries(schemas).flatMap(([type, specs]) =>
    (specs ?? []).map((spec) => ({ type, spec })),
  );
}

test("schema freeze: ParamSpec fields are a subset of the frozen baseline (only-add)", () => {
  const offenders = new Map(); // field -> first @type
  for (const schemas of [TUNNEL_PARAM_SCHEMAS, AUTH_PARAM_SCHEMAS]) {
    for (const { type, spec } of walkSpecs(schemas)) {
      for (const k of Object.keys(spec)) {
        if (!PARAM_SPEC_FIELDS.has(k) && !offenders.has(k)) offenders.set(k, type);
      }
    }
  }
  assert.deepEqual(
    [...offenders.entries()],
    [],
    `unknown ParamSpec fields (add to the freeze baseline consciously): ${[...offenders.entries()].map(([k, t]) => `${k}@${t}`).join(", ")}`,
  );
});

test("schema freeze: every spec has a non-empty key and a valid type", () => {
  for (const schemas of [TUNNEL_PARAM_SCHEMAS, AUTH_PARAM_SCHEMAS]) {
    for (const { type, spec } of walkSpecs(schemas)) {
      assert.equal(typeof spec.key, "string", `${type}: spec.key type`);
      assert.ok((spec.key).length > 0, `${type}: empty spec.key`);
      if (spec.type !== undefined) {
        assert.ok(TYPES.has(spec.type), `${type}.${spec.key}: invalid type ${spec.type}`);
      }
    }
  }
});

test("schema freeze: options entries always carry value", () => {
  for (const schemas of [TUNNEL_PARAM_SCHEMAS, AUTH_PARAM_SCHEMAS]) {
    for (const { type, spec } of walkSpecs(schemas)) {
      for (const opt of (spec.options ?? [])) {
        assert.ok("value" in opt && opt.value !== undefined, `${type}.${spec.key}: option missing value`);
      }
    }
  }
});

test("schema freeze: fixed specs always carry value", () => {
  for (const schemas of [TUNNEL_PARAM_SCHEMAS, AUTH_PARAM_SCHEMAS]) {
    for (const { type, spec } of walkSpecs(schemas)) {
      if (spec.fixed) assert.ok("value" in spec, `${type}.${spec.key}: fixed without value`);
    }
  }
});

test("schema freeze: tunnel type baseline present", () => {
  const have = new Set(Object.keys(tunnelParamSchemas()));
  for (const t of TUNNEL_TYPES) {
    assert.ok(have.has(t), `tunnel type "${t}" missing from schemas`);
  }
});

test("schema freeze: auth provider baseline present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-frz-"));
  try {
    const schemas = await authProviderSchemas(dir);
    for (const t of AUTH_TYPES) {
      assert.ok(t in schemas, `auth provider "${t}" missing from schemas`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema freeze: versions are stable and exposed via the instance", async () => {
  assert.equal(TUNNEL_SCHEMAS_VERSION, 1);
  assert.equal(AUTH_SCHEMAS_VERSION, 1);
  const dir = mkdtempSync(join(tmpdir(), "st-frz-"));
  try {
    const st = createServiceTunnels({ configDir: join(dir, "cfg"), cacheDir: join(dir, "cache"), guardian: false });
    assert.deepEqual(st.schemas.versions(), { tunnel: 1, auth: 1 });
    await st.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema freeze: localized schemas stay within the frozen allowlist", () => {
  const zh = localizeSchemas(tunnelParamSchemas(), "zh");
  for (const { type, spec } of walkSpecs(zh)) {
    for (const k of Object.keys(spec)) {
      assert.ok(PARAM_SPEC_FIELDS.has(k), `localized ${type}.${spec.key}: unknown field ${k}`);
    }
  }
});
