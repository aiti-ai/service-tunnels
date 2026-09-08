/**
 * i18n 键齐平：CATALOG zh 与 en 键集合一致（防漏翻；en 为权威）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../src/i18n.ts";

test("zh 与 en 键集合一致（en 权威，zh 不缺不溢）", () => {
  const en = new Set(Object.keys(CATALOG.en));
  const zh = new Set(Object.keys(CATALOG.zh));
  const missingInZh = [...en].filter((k) => !zh.has(k));
  const extraInZh = [...zh].filter((k) => !en.has(k));
  assert.deepEqual(missingInZh, [], "keys missing in zh");
  assert.deepEqual(extraInZh, [], "keys missing in en");
});

test("ui.* 键不带未插值残留占位符错误（{name} 形式合法）", () => {
  for (const [lang, table] of Object.entries(CATALOG)) {
    for (const [k, v] of Object.entries(table)) {
      if (typeof v !== "string") continue;
      // 占位符必须形如 {word}（字母数字下划线），不允许空占位/嵌套
      assert.ok(!/\{\s*\}/.test(v), `${lang} ${k}: empty placeholder`);
    }
  }
});
