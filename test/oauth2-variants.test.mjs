import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigFile } from "../src/config.ts";

function tempDirs() {
  const base = mkdtempSync(join(tmpdir(), "st-oauth2v-"));
  const cacheDir = join(base, "cache");
  const configDir = join(base, "config");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return { base, cacheDir, configDir };
}

function ctx(cacheDir, configDir) {
  return {
    configDir, cacheDir,
    resolveTool: async () => "",
    registerInternal: () => {},
    unregisterInternal: () => {},
    registerPid: () => {},
    pickPort: async () => {
      const { createServer } = await import("node:net");
      return new Promise((resolve) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
          const p = srv.address().port;
          srv.close(() => resolve(p));
        });
      });
    },
    log: () => {},
  };
}

test("oauth2 变体表：id 唯一、provider 合法、form/creds 一致", async () => {
  const { OAUTH2_VARIANTS } = await import("../src/providers/oauth2-variants.ts");
  const ids = new Set();
  for (const v of OAUTH2_VARIANTS) {
    assert.ok(!ids.has(v.id), `duplicate variant id ${v.id}`);
    ids.add(v.id);
    assert.match(v.id, /^oauth2-[a-z0-9-]+$/, `${v.id} naming`);
    assert.ok(v.provider && v.label, `${v.id} provider/label`);
    assert.ok(Array.isArray(v.form) && v.form.length > 0, `${v.id} has form fields`);
    for (const spec of v.form) {
      assert.ok(spec.key && spec.label, `${v.id}.${spec.key} key/label`);
      // 必填凭据字段必须能由配置档携带（页面上才能消失）
      if (spec.required && spec.key !== "issuerUrl") {
        assert.ok(v.creds[spec.key], `${v.id}.${spec.key} must be carried via creds`);
      }
      // flag 字段不应与特殊处理冲突
      assert.notEqual(spec.flag, "oidc_issuer_url");
    }
  }
  assert.ok(ids.has("oauth2-github") && ids.has("oauth2-keycloak") && ids.has("oauth2-generic"));
});

test("schema/元数据：配置档携带凭据 → 字段默认填入（可编辑），零输入直点暴露", async () => {
  const { authProviderSchemas, authProviderMetas } = await import("../src/auth-registry.ts");
  const { base, cacheDir, configDir } = tempDirs();
  try {
    // 空配置档：github 需要 clientId/clientSecret（无默认）
    let schemas = await authProviderSchemas(configDir);
    let metas = await authProviderMetas(configDir);
    assert.ok(schemas["oauth2-github"], "variant schema present");
    const keys = schemas["oauth2-github"].map((s) => s.key);
    assert.ok(keys.includes("clientId") && keys.includes("clientSecret"), "unconfigured → form asks creds");
    assert.equal(schemas["oauth2-github"].find((p) => p.key === "clientId")?.default, undefined, "no default when not carried");
    assert.equal(metas["oauth2-github"].configured, false);
    assert.deepEqual(metas["oauth2-github"].needsInput, ["clientId", "clientSecret"]);
    assert.equal(metas["oauth2-github"].kind, "oauth2-variant");
    // keycloak 需要 issuerUrl + 凭据
    assert.deepEqual(metas["oauth2-keycloak"].needsInput, ["issuerUrl", "clientId", "clientSecret"]);
    // SaaS 变体固定端点：issuerUrl 不在表单
    assert.ok(!keys.includes("issuerUrl"), "github issuer is fixed");

    // 配置档携带 github 凭据 → 字段仍在表单但默认填入（default = 携带值）
    writeConfigFile(configDir, {
      auth: {
        oauth2: {
          clientId: "shared-id",
          clientSecret: "shared-secret",
          variants: {
            "oauth2-keycloak": { issuerUrl: "https://kc.example.com/realms/r" },
          },
        },
      },
    });
    schemas = await authProviderSchemas(configDir);
    metas = await authProviderMetas(configDir);
    const gh = schemas["oauth2-github"];
    assert.equal(gh.find((p) => p.key === "clientId")?.default, "shared-id", "clientId prefilled (non-secret)");
    // 秘密字段：不回显明文（无 default），只标记 secretSet（页面显示「已设置」）
    const ghSecret = gh.find((p) => p.key === "clientSecret");
    assert.equal(ghSecret?.type, "password");
    assert.equal(ghSecret?.default, undefined, "clientSecret plaintext NOT in schema");
    assert.equal(ghSecret?.secretSet, true, "clientSecret marked as set");
    assert.equal(gh.find((p) => p.key === "clientId")?.required, true, "required stays (default just prefills)");
    assert.equal(metas["oauth2-github"].configured, true, "required fields satisfied by prefill");
    assert.equal(metas["oauth2-github"].needsInput.length, 0);
    // keycloak：issuerUrl 由按变体配置携带，凭据由共享层携带 → 全部预填
    const kcFully = schemas["oauth2-keycloak"];
    assert.equal(kcFully.find((p) => p.key === "issuerUrl")?.default, "https://kc.example.com/realms/r");
    assert.equal(kcFully.find((p) => p.key === "clientId")?.default, "shared-id");
    assert.equal(metas["oauth2-keycloak"].configured, true);

    // 部分携带：只带 issuerUrl（无共享凭据）→ issuerUrl 预填，clientId/clientSecret 无默认
    writeConfigFile(configDir, {
      auth: { oauth2: { variants: { "oauth2-keycloak": { issuerUrl: "https://kc.example.com/realms/r" } } } },
    });
    schemas = await authProviderSchemas(configDir);
    metas = await authProviderMetas(configDir);
    const kc = schemas["oauth2-keycloak"];
    assert.equal(kc.find((p) => p.key === "issuerUrl")?.default, "https://kc.example.com/realms/r", "issuer prefilled");
    assert.equal(kc.find((p) => p.key === "clientId")?.default, undefined, "clientId needs input");
    assert.equal(kc.find((p) => p.key === "clientSecret")?.default, undefined, "clientSecret needs input");
    assert.equal(metas["oauth2-keycloak"].configured, false, "creds still needed");
    assert.deepEqual(metas["oauth2-keycloak"].needsInput, ["clientId", "clientSecret"]);
    // 旧字段 auth.oidc 仍可作为共享 fallback
    const { base: b2, cacheDir: c2, configDir: d2 } = tempDirs();
    try {
      writeConfigFile(d2, { auth: { oidc: { clientId: "legacy", clientSecret: "legacy-secret" } } });
      const s2 = await authProviderSchemas(d2);
      assert.equal(s2["oauth2-github"].find((p) => p.key === "clientId")?.default, "legacy", "legacy auth.oidc prefills");
      const m2 = await authProviderMetas(d2);
      assert.equal(m2["oauth2-github"].configured, true);
    } finally {
      rmSync(b2, { recursive: true, force: true });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveOAuth2VariantParams：优先级 表单 > 按变体 > 共享 > 旧 oidc > 内置固定", async () => {
  const { resolveOAuth2VariantParams, oauth2Variant } = await import("../src/providers/oauth2-variants.ts");
  const { base, configDir } = tempDirs();
  try {
    const def = oauth2Variant("oauth2-github");
    writeConfigFile(configDir, {
      auth: {
        oidc: { clientId: "legacy-id", clientSecret: "legacy-secret" },
        oauth2: {
          clientId: "shared-id", clientSecret: "shared-secret",
          variants: { "oauth2-github": { clientId: "per-variant-id", clientSecret: "per-variant-secret" } },
        },
      },
    });
    let r = resolveOAuth2VariantParams(def, configDir, {});
    assert.equal(r.values.clientId, "per-variant-id", "per-variant beats shared");
    assert.equal(r.sources.clientId, "config auth.oauth2.variants.oauth2-github.clientId");
    assert.equal(r.values.clientSecret, "per-variant-secret");
    // 显式 opts（表单/CLI）最高
    r = resolveOAuth2VariantParams(def, configDir, { clientId: "form-id" });
    assert.equal(r.values.clientId, "form-id", "explicit wins");
    assert.equal(r.sources.clientId, "explicit");
    assert.equal(r.values.clientSecret, "per-variant-secret", "other keys keep config value");
    // 共享层（无按变体覆盖）
    writeConfigFile(configDir, { auth: { oauth2: { clientId: "shared-id", clientSecret: "shared-secret" } } });
    r = resolveOAuth2VariantParams(def, configDir, {});
    assert.equal(r.values.clientId, "shared-id");
    // 旧 oidc 层
    writeConfigFile(configDir, { auth: { oidc: { clientId: "legacy-id", clientSecret: "legacy-secret" } } });
    r = resolveOAuth2VariantParams(def, configDir, {});
    assert.equal(r.values.clientId, "legacy-id");
    // 内置固定：github 无 issuer；keycloak 无固定 issuer → issuerUrl 缺失
    const kc = oauth2Variant("oauth2-keycloak");
    r = resolveOAuth2VariantParams(kc, configDir, {});
    assert.equal(r.values.issuerUrl, undefined);
    r = resolveOAuth2VariantParams(kc, configDir, { issuerUrl: "https://x/realms/r" });
    assert.equal(r.values.issuerUrl, "https://x/realms/r");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("registry：变体注册为独立 type，userManagers 不变，providerOrder 已配置优先", async () => {
  const { AuthRegistry, authProviderMetas } = await import("../src/auth-registry.ts");
  const { base, cacheDir, configDir } = tempDirs();
  try {
    writeConfigFile(configDir, { auth: { oauth2: { clientId: "x", clientSecret: "y" } } });
    const reg = new AuthRegistry(ctx(cacheDir, configDir));
    const list = reg.list();
    for (const id of ["oauth2-github", "oauth2-google", "oauth2-keycloak", "oauth2-generic"]) {
      assert.ok(list.includes(id), `${id} registered`);
    }
    // 变体实例：type = 变体 id；未携带变体 opts 时 type 仍正确
    const gh = reg.create("oauth2-github", {}, "default");
    assert.equal(gh.type, "oauth2-github");
    assert.equal(gh.variant.id, "oauth2-github");
    // gatewayMode / authzPath / providerPaths 继承 oauth2-proxy 自描述协议
    assert.equal(gh.gatewayMode, "oauth2-proxy");
    assert.equal(gh.authzPath, "/oauth2/auth");
    // 每个变体独立实例（type#site 缓存键不同）
    const goog = reg.create("oauth2-google", {}, "default");
    assert.notEqual(gh, goog);
    // 用户管理探测不含变体（变体不是 UserManager）
    const managers = reg.userManagers().sort();
    assert.deepEqual(managers, ["authelia", "basic", "portal"]);
    // 元数据/排序
    const metas = authProviderMetas(configDir);
    assert.equal(metas["oauth2-github"].configured, true);
    assert.equal(metas["oauth2-google"].configured, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("provider validate/prepare：变体配置生成 + 缺参报错 + TOML 注入防护", async () => {
  const { OAuth2ProxyProvider } = await import("../src/providers/oauth2-proxy.ts");
  const { base, cacheDir, configDir } = tempDirs();
  try {
    const storageDir = join(cacheDir, "tmp", "oauth2-proxy");

    // 1) 缺凭据 → validate 报错并给出补法
    let p = new OAuth2ProxyProvider(ctx(cacheDir, configDir), { variant: "oauth2-github", storageDir });
    let problems = await p.validate();
    assert.ok(problems.some((m) => m.includes("oauth2-github") && m.includes("clientId")), `missing creds surfaced: ${problems}`);
    assert.ok(problems.some((m) => m.includes("clientSecret")));

    // 2) 配置档携带 → validate 干净（binary resolve 为 ""）
    writeConfigFile(configDir, {
      auth: { oauth2: { variants: { "oauth2-github": { clientId: "gh-id", clientSecret: "gh-secret" } } } },
    });
    p = new OAuth2ProxyProvider(ctx(cacheDir, configDir), { variant: "oauth2-github", storageDir });
    problems = await p.validate();
    assert.deepEqual(problems, [], `configured variant validates: ${problems}`);

    // 3) prepare 写配置：provider=github、无 issuer、scope 固定、凭据来自配置档
    await p.prepare();
    const conf = readFileSync(join(storageDir, "oauth2-proxy.conf"), "utf8");
    assert.match(conf, /provider = "github"/);
    assert.match(conf, /client_id = "gh-id"/);
    assert.match(conf, /client_secret = "gh-secret"/);
    assert.match(conf, /scope = "user:email"/);
    assert.ok(!conf.includes("oidc_issuer_url"), "github has no issuer");
    assert.match(conf, /cookie_secret = "/);

    // 4) keycloak 变体：issuer 来自配置档 → oidc_issuer_url 写入
    writeConfigFile(configDir, {
      auth: { oauth2: { variants: { "oauth2-keycloak": { issuerUrl: "https://kc.example.com/realms/r", clientId: "kc-id", clientSecret: "kc-secret" } } } },
    });
    const kc = new OAuth2ProxyProvider(ctx(cacheDir, configDir), { variant: "oauth2-keycloak", storageDir: join(cacheDir, "tmp", "kc") });
    await kc.prepare();
    const kcConf = readFileSync(join(cacheDir, "tmp", "kc", "oauth2-proxy.conf"), "utf8");
    assert.match(kcConf, /provider = "keycloak-oidc"/);
    assert.match(kcConf, /oidc_issuer_url = "https:\/\/kc\.example\.com\/realms\/r"/);
    assert.match(kcConf, /client_id = "kc-id"/);

    // 5) 表单 flag 字段（org → github-org）+ 显式覆盖
    const gh2 = new OAuth2ProxyProvider(ctx(cacheDir, configDir), {
      variant: "oauth2-github",
      storageDir: join(cacheDir, "tmp", "gh2"),
      clientId: "form-id",
      clientSecret: "form-secret",
      org: "my-org",
    });
    await gh2.prepare();
    const gh2Conf = readFileSync(join(cacheDir, "tmp", "gh2", "oauth2-proxy.conf"), "utf8");
    assert.match(gh2Conf, /client_id = "form-id"/, "explicit opts override config");
    assert.match(gh2Conf, /github_org = \["my-org"\]/, "list-typed org written as TOML array (snake key)");

    // 6) TOML 注入防护：clientSecret 带换行 → prepare 抛错（fail-closed）
    const evil = new OAuth2ProxyProvider(ctx(cacheDir, configDir), {
      variant: "oauth2-github",
      storageDir: join(cacheDir, "tmp", "evil"),
      clientId: "id",
      clientSecret: "secret\nprovider = \"google\"",
    });
    await assert.rejects(evil.prepare(), /clientSecret/, "control chars rejected before conf write");

    // 7) 原始路径向后兼容：无 variant → type=oauth2-proxy，缺 oidc → validate 报错
    const raw = new OAuth2ProxyProvider(ctx(cacheDir, configDir), { storageDir: join(cacheDir, "tmp", "raw") });
    assert.equal(raw.type, "oauth2-proxy");
    assert.equal(raw.variant, null);
    problems = await raw.validate();
    assert.ok(problems.some((m) => m.includes("auth.oidc")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("环境变量注册自定义变体（类似 command 隧道）：注册/表单/配置生成/注入防护/遮蔽", async () => {
  const { OAuth2ProxyProvider } = await import("../src/providers/oauth2-proxy.ts");
  const { customOAuth2Variants, parseOAuth2VariantDeclaration, oauth2Variant } =
    await import("../src/providers/oauth2-variants.ts");
  const { AuthRegistry, authProviderSchemas, authProviderMetas } = await import("../src/auth-registry.ts");
  const { base, cacheDir, configDir } = tempDirs();
  const ENV_KEY = "SERVICE_TUNNELS_OAUTH2_VARIANT_MYIDP";
  const ENV_GITHUB = "SERVICE_TUNNELS_OAUTH2_VARIANT_GITHUB"; // 遮蔽内置 → 跳过
  const ENV_BAD = "SERVICE_TUNNELS_OAUTH2_VARIANT_1BAD NAME"; // 非法名（含空格，无效）
  const saved = [ENV_KEY, ENV_GITHUB, ENV_BAD].map((k) => [k, process.env[k]]);
  try {
    process.env[ENV_KEY] =
      "provider=oidc;issuerUrl=https://auth.example.com/realms/r;clientId={{clientId}};" +
      "clientSecret={{clientSecret}};gitlab-url={{gitlabUrl:https://gitlab.com}};github-org={{org}};";
    process.env[ENV_GITHUB] = "provider=github;clientId=should-be-skipped";
    process.env[ENV_BAD] = "provider=oidc;clientId=x";

    // 1) 声明解析：键归一化（issuerUrl → oidc_issuer_url；kebab → snake）、
    //    {{token}} 必填 / {{token:default}} 可选带默认、provider 不进 lines
    const def = oauth2Variant("oauth2-myidp");
    assert.ok(def, "env variant registered via oauth2Variant()");
    assert.equal(def.provider, "oidc");
    assert.equal(def.lines.length, 5);
    assert.deepEqual(def.lines.map((l) => l.key), ["oidc_issuer_url", "client_id", "client_secret", "gitlab_url", "github_org"]);
    const formKeys = def.form.map((s) => s.key);
    assert.deepEqual(formKeys, ["clientId", "clientSecret", "gitlabUrl", "org"]);
    assert.ok(def.form.find((s) => s.key === "clientId")?.required);
    assert.equal(def.form.find((s) => s.key === "gitlabUrl")?.default, "https://gitlab.com");
    assert.equal(def.form.find((s) => s.key === "gitlabUrl")?.required, false);
    assert.deepEqual(def.creds, { clientId: "clientId", clientSecret: "clientSecret", gitlabUrl: "gitlabUrl", org: "org" });

    // 2) registry 注册为独立 type；遮蔽内置的 env 被跳过；非法名被跳过
    const reg = new AuthRegistry(ctx(cacheDir, configDir));
    assert.ok(reg.list().includes("oauth2-myidp"), "env variant registered in registry");
    assert.ok(!reg.list().includes("oauth2-1badname"), "invalid env name skipped");
    const gh = reg.create("oauth2-github", {}, "default");
    assert.equal(gh.type, "oauth2-github", "builtin not shadowed by env");

    // 3) schema/元数据：{{token}} 无携带 → 表单必填；{{token:default}} 带默认
    let schemas = await authProviderSchemas(configDir);
    let metas = await authProviderMetas(configDir);
    assert.ok(schemas["oauth2-myidp"].find((s) => s.key === "clientId")?.required);
    assert.equal(schemas["oauth2-myidp"].find((s) => s.key === "gitlabUrl")?.default, "https://gitlab.com");
    assert.equal(metas["oauth2-myidp"].configured, false);
    assert.deepEqual(metas["oauth2-myidp"].needsInput, ["clientId", "clientSecret", "org"]);

    // 4) 配置档携带 token → 非秘密字段预填；秘密字段（{{clientSecret}}）不回显明文
    writeConfigFile(configDir, {
      auth: { oauth2: { variants: { "oauth2-myidp": { clientId: "cfg-id", clientSecret: "cfg-secret", org: "my-org" } } } },
    });
    schemas = await authProviderSchemas(configDir);
    metas = await authProviderMetas(configDir);
    assert.equal(schemas["oauth2-myidp"].find((s) => s.key === "clientId")?.default, "cfg-id");
    const mySecret = schemas["oauth2-myidp"].find((s) => s.key === "clientSecret");
    assert.equal(mySecret?.type, "password", "secret token → password type");
    assert.equal(mySecret?.default, undefined, "secret plaintext NOT in schema");
    assert.equal(mySecret?.secretSet, true, "secret marked set");
    assert.equal(metas["oauth2-myidp"].configured, true, "carried tokens → zero-input expose");

    // 5) provider prepare：逐行替换占位符 + 键归一化 + 列表键数组 + 自动 cookie_secret
    const p = new OAuth2ProxyProvider(ctx(cacheDir, configDir), {
      variant: "oauth2-myidp",
      storageDir: join(cacheDir, "tmp", "myidp"),
    });
    assert.equal(await p.validate().then((x) => x.length), 0, "carried → validate clean");
    await p.prepare();
    const conf = readFileSync(join(cacheDir, "tmp", "myidp", "oauth2-proxy.conf"), "utf8");
    assert.match(conf, /provider = "oidc"/);
    assert.match(conf, /oidc_issuer_url = "https:\/\/auth\.example\.com\/realms\/r"/);
    assert.match(conf, /client_id = "cfg-id"/);
    assert.match(conf, /gitlab_url = "https:\/\/gitlab\.com"/, "template default substituted");
    assert.match(conf, /cookie_secret = "/, "auto cookie_secret");
    assert.ok(!conf.includes("{{clientId}}"), "placeholders fully substituted");

    // 6) 缺必填 token → prepare 抛错（fail-fast）
    writeConfigFile(configDir, {});
    const p2 = new OAuth2ProxyProvider(ctx(cacheDir, configDir), {
      variant: "oauth2-myidp",
      storageDir: join(cacheDir, "tmp", "myidp2"),
    });
    await assert.rejects(p2.prepare(), /missing required parameter\(s\): clientId, clientSecret/);

    // 7) TOML 注入防护：声明值里的控制字符拒绝（fail-closed）
    process.env[ENV_KEY] = "provider=oidc;clientId=x;clientSecret=a\nb;";
    const bad = new OAuth2ProxyProvider(ctx(cacheDir, configDir), {
      variant: "oauth2-myidp",
      storageDir: join(cacheDir, "tmp", "myidp3"),
    });
    await assert.rejects(bad.prepare(), /client_secret/, "control chars rejected");

    // 8) 直接解析器：非法声明返回 null；托管键（http_address/upstreams）忽略
    assert.equal(parseOAuth2VariantDeclaration("oauth2-x", "clientId=x"), null, "no provider → null");
    assert.equal(parseOAuth2VariantDeclaration("oauth2-x", "provider={{p}};clientId=x"), null, "templated provider → null");
    const withManaged = parseOAuth2VariantDeclaration(
      "oauth2-x",
      "provider=oidc;http_address=1.2.3.4:9;upstreams=http://evil;clientId=x;clientSecret=y",
    );
    assert.ok(withManaged, "valid declaration parsed");
    assert.ok(!withManaged.lines.some((l) => l.key === "http_address" || l.key === "upstreams"), "managed keys skipped");
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI/daemon 表面：--auth oauth2-github 零 provider-set 通过 schema 校验", async () => {
  const { applyParamSets } = await import("../src/tunnels.ts");
  const { authProviderSchemas } = await import("../src/auth-registry.ts");
  const { base, configDir } = tempDirs();
  try {
    writeConfigFile(configDir, { auth: { oauth2: { clientId: "x", clientSecret: "y" } } });
    const schemas = await authProviderSchemas(configDir);
    // 空 sets（页面上不改不填）→ 通过
    assert.deepEqual(applyParamSets(schemas["oauth2-github"] ?? [], {}, "auth provider"), {});
    // 已配置：携带字段在 schema 内（带 default）→ --provider-set 可覆盖
    assert.deepEqual(applyParamSets(schemas["oauth2-github"] ?? [], { clientId: "new-id" }, "auth provider"), {
      clientId: "new-id",
    });
    // 未知 key 仍拒绝（schema 白名单生效）
    assert.throws(
      () => applyParamSets(schemas["oauth2-github"] ?? [], { badKey: "y" }, "auth provider"),
      /unknown param "badKey"/,
    );
    // 未配置时必填字段无默认 → CLI 校验按 required 语义
    writeConfigFile(configDir, {});
    const s2 = await authProviderSchemas(configDir);
    assert.ok(s2["oauth2-github"].find((p) => p.key === "clientId")?.required);
    assert.equal(s2["oauth2-github"].find((p) => p.key === "clientId")?.default, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
