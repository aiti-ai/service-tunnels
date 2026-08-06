/**
 * 多语机制测试:默认英文(spec 数据)、zh 覆盖、语言探测、翻译 id 注入。
 * 零依赖(自实现 catalog lookup)。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { t, resolveLang, localizeSpecs, withSchemaI18nKeys } from "../src/i18n.ts";
import { tunnelParamSchema } from "../src/tunnels.ts";

test("默认英文:spec 数据是英文(国际化 npm 包)", async () => {
  const ngrok = tunnelParamSchema("ngrok");
  assert.equal(ngrok.find((p) => p.key === "domain")?.label, "Fixed domain");
  assert.equal(ngrok.find((p) => p.key === "token")?.description.includes("Unauthenticated ngrok"), true);
  const ssh = tunnelParamSchema("ssh");
  assert.equal(ssh.find((p) => p.key === "host")?.label, "SSH server");
});

test("zh 语言包覆盖 schema 字段", async () => {
  const zh = localizeSpecs(tunnelParamSchema("ngrok"), "zh");
  assert.equal(zh.find((p) => p.key === "domain")?.label, "固定域名");
  assert.equal(zh.find((p) => p.key === "token")?.description.includes("未认证的 ngrok"), true);
  // en 原样返回(数据默认)
  const en = localizeSpecs(tunnelParamSchema("ngrok"), "en");
  assert.equal(en.find((p) => p.key === "domain")?.label, "Fixed domain");
});

test("翻译 id 注入:labelKey/descriptionKey 与文案解耦", () => {
  const specs = withSchemaI18nKeys("tunnel", "ngrok", tunnelParamSchema("ngrok"));
  const domain = specs.find((p) => p.key === "domain");
  assert.ok(domain);
  assert.equal(domain.labelKey, "tunnel.ngrok.domain.label");
  assert.equal(domain.descriptionKey, "tunnel.ngrok.domain.description");
  assert.equal(specs.find((p) => p.key === "token")?.linkTitleKey, "tunnel.ngrok.token.linkTitle");
});

test("语言探测:默认 en,LANG/LC_ALL 中文 → zh,显式参数优先", () => {
  assert.equal(resolveLang(), "en");
  assert.equal(resolveLang(undefined, { LANG: "en_US.UTF-8" }), "en");
  assert.equal(resolveLang(undefined, { LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(resolveLang(undefined, { LC_ALL: "zh_TW.UTF-8" }), "zh");
  assert.equal(resolveLang("zh"), "zh");
  assert.equal(resolveLang("en", { LANG: "zh_CN.UTF-8" }), "en"); // 显式优先
});

test("t() 插值 + 缺失回退", () => {
  assert.equal(t("en", "cli.unknownArg", { arg: "x" }), "Unknown argument: x");
  assert.equal(t("zh", "cli.unknownArg", { arg: "x" }), "未知参数: x");
  assert.equal(t("en", "no.such.key"), "no.such.key"); // 缺失回退 key
});
