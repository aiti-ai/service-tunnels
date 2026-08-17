import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("TODO-2 presets: save/list/get/remove + 敏感字段加密落盘", { timeout: 30_000 }, async () => {
  const { createServiceTunnels } = await import("../src/index.ts");
  const base = mkdtempSync(join(tmpdir(), "st-preset-"));
  const st = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
  try {
    // 保存：ngrok 隧道参数（domain 非敏感 + authtoken 敏感）
    const saved = st.presets.save("tunnel", "ngrok", "我的ngrok", { domain: "alice.ngrok-free.app", authtoken: "tok_12345678" });
    assert.equal(saved.name, "我的ngrok");
    assert.ok(saved.updatedAt > 0);

    // list：掩码敏感字段
    const list = st.presets.list("tunnel");
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "ngrok");
    assert.equal(list[0].params.domain, "alice.ngrok-free.app", "非敏感字段明文");
    assert.ok(list[0].params.authtoken.includes("••••"), "敏感字段掩码");
    assert.ok(!list[0].params.authtoken.includes("tok_12345678"), "list 不回显明文");

    // get：明文（供暴露合并）
    const got = st.presets.get("tunnel", "ngrok", "我的ngrok");
    assert.ok(got, "get 命中");
    assert.equal(got.params.authtoken, "tok_12345678", "get 返回明文");

    // 配置档落盘：authtoken 是密文（enc:v1:…），不含明文
    const raw = readFileSync(join(base, "cfg", "service-tunnels.json"), "utf8");
    assert.ok(!raw.includes("tok_12345678"), "配置档不含明文敏感值");
    assert.match(raw, /enc:v1:/, "敏感字段以 enc:v1: 密文存储");
    assert.match(raw, /"domain": "alice\.ngrok-free\.app"/, "非敏感字段明文落盘");

    // 密钥文件 0600（POSIX 权限位；Windows 无该语义，跳过）
    if (process.platform !== "win32") {
      const keyStat = statSync(join(base, "cache", "presets.key"));
      assert.equal(keyStat.mode & 0o777, 0o600, "presets.key 0600");
    } else {
      assert.ok(readFileSync(join(base, "cache", "presets.key"), "utf8").length > 0, "presets.key 存在且可读");
    }

    // 覆盖更新（同 type+name）
    st.presets.save("tunnel", "ngrok", "我的ngrok", { domain: "bob.ngrok-free.app", authtoken: "tok_new" });
    const got2 = st.presets.get("tunnel", "ngrok", "我的ngrok");
    assert.equal(got2.params.domain, "bob.ngrok-free.app", "覆盖生效");
    assert.equal(got2.params.authtoken, "tok_new");

    // 空值不存
    st.presets.save("tunnel", "ngrok", "空值", { domain: "", authtoken: undefined });
    const got3 = st.presets.get("tunnel", "ngrok", "空值");
    assert.deepEqual(got3.params, {}, "空值/undefined 不入 params");

    // auth preset
    st.presets.save("auth", "portal", "门户", { basePath: "/login" });
    const authList = st.presets.list("auth");
    assert.equal(authList.length, 1);
    assert.equal(authList[0].type, "portal");

    // remove
    assert.equal(st.presets.remove("tunnel", "ngrok", "我的ngrok"), true);
    assert.equal(st.presets.remove("tunnel", "ngrok", "不存在"), false);
    assert.equal(st.presets.list("tunnel").length, 1, "只剩「空值」");

    // 密钥持久化：新实例（同 cache）能解密
    const st2 = createServiceTunnels({ configDir: join(base, "cfg"), cacheDir: join(base, "cache"), guardian: false });
    const got4 = st2.presets.get("auth", "portal", "门户");
    assert.ok(got4, "新实例可读回 preset");
    assert.equal(got4.params.basePath, "/login");
  } finally {
    await st.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});
