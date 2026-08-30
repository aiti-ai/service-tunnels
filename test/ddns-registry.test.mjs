/** DDNS registration engine tests — preconfigured profiles
 *  (providerProfile / profile) + event-driven portmap/tunnel registration
 *  with separate CNAME record and TXT record names. */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readRegistryConfig, resolveEntry, registerPortmap, registerTunnel, urlHost, writeRegistryConfig } = await import("../src/ddns-registry.ts");
const { startCloudflareMock } = await import("ddns/src/mocks/cloudflare.ts");

let CFG = null;
function makeCfg(mock) {
  const zoneId = mock ? [...mock.state.zones.values()][0].id : undefined;
  return {
    providerProfiles: {
      cf: { provider: "cloudflare", token: "tk", zoneId, baseUrl: mock?.url },
    },
    profiles: {
      home: { providerProfile: "cf", zone: "example.com", record: "discover.example.com", txtName: "discover-txt.example.com" },
    },
    entries: [
      { name: "p1", profile: "home", kind: "portmap", ip: true, txt: true },
      { name: "t1", profile: "home", kind: "tunnel", followTunnel: "web", cname: true, txtUrl: true },
      { name: "t2", providerProfile: "cf", zone: "example.com", record: "t2.example.com", txtName: "t2-txt.example.com", kind: "tunnel", followTunnel: "web2", cname: true, txtUrl: true },
    ],
  };
}
const CFG_LEGACY = {
  providerProfiles: {
    cf: { provider: "cloudflare", token: "tk" },
  },
  profiles: {
    home: { providerProfile: "cf", zone: "example.com", record: "discover.example.com", txtName: "discover-txt.example.com" },
  },
  entries: [
    { name: "p1", profile: "home", kind: "portmap", ip: true, txt: true },
    { name: "t1", profile: "home", kind: "tunnel", followTunnel: "web", cname: true, txtUrl: true },
    { name: "t2", providerProfile: "cf", zone: "example.com", record: "t2.example.com", txtName: "t2-txt.example.com", kind: "tunnel", followTunnel: "web2", cname: true, txtUrl: true },
  ],
};

test("readRegistryConfig: parses providerProfiles + profiles + entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-dnsreg-"));
  try {
    const mock0 = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
    writeRegistryConfig(dir, makeCfg(mock0));
    await mock0.stop();
    const cfg = readRegistryConfig(dir);
    assert.ok(cfg.providerProfiles.cf);
    assert.equal(cfg.providerProfiles.cf.token, "tk");
    assert.ok(cfg.profiles.home);
    assert.equal(cfg.entries.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEntry: profile reference merges providerProfile + profile + entry overrides", () => {
  const cfg = makeCfg(null);
  const r = resolveEntry(cfg, cfg.entries[0]);
  assert.equal(r.provider.provider, "cloudflare");
  assert.equal(r.provider.token, "tk");
  assert.equal(r.zone, "example.com");
  assert.equal(r.record, "discover.example.com");
  assert.equal(r.txtName, "discover-txt.example.com");
});

test("resolveEntry: providerProfile + inline zone/record (no profile)", () => {
  const cfg = makeCfg(null);
  const r = resolveEntry(cfg, cfg.entries[2]);
  assert.equal(r.provider.token, "tk");
  assert.equal(r.zone, "example.com");
  assert.equal(r.record, "t2.example.com");
  assert.equal(r.txtName, "t2-txt.example.com");
});

test("registerPortmap: A = externalIp under record, TXT = ip:port under txtName", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  try {
    const results = await registerPortmap(makeCfg(mock), { externalIp: "203.0.113.7", externalPort: 49152, label: "app" });
    assert.equal(results.length, 1); // only p1 (kind:portmap)
    assert.equal(results[0].actions.length, 2);
    const a = results[0].actions[0];
    assert.equal(a.type, "A");
    assert.equal(a.name, "discover.example.com");
    assert.equal(a.value, "203.0.113.7");
    assert.equal(a.ok, true);
    const t = results[0].actions[1];
    assert.equal(t.type, "TXT");
    assert.equal(t.name, "discover-txt.example.com"); // txtName, NOT record
    assert.equal(t.value, "203.0.113.7:49152");
    // both records exist in the mock
    const records = mock.state.zones.get("example.com").records;
    assert.ok(records.some((r) => r.type === "A" && r.content === "203.0.113.7"));
    assert.ok(records.some((r) => r.type === "TXT" && r.content === "203.0.113.7:49152"));
  } finally {
    await mock.stop();
  }
});

test("registerTunnel: CNAME = url host under record, TXT = full url under txtName", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  try {
    const results = await registerTunnel(makeCfg(mock), { tunnelName: "web", url: "https://abc123.trycloudflare.com/" });
    assert.equal(results.length, 1); // t1 follows "web"
    assert.equal(results[0].actions.length, 2);
    const c = results[0].actions[0];
    assert.equal(c.type, "CNAME");
    assert.equal(c.name, "discover.example.com");
    assert.equal(c.value, "abc123.trycloudflare.com");
    const t = results[0].actions[1];
    assert.equal(t.type, "TXT");
    assert.equal(t.name, "discover-txt.example.com"); // txtName independent
    assert.equal(t.value, "https://abc123.trycloudflare.com/");
    const records = mock.state.zones.get("example.com").records;
    assert.ok(records.some((r) => r.type === "CNAME" && r.content === "abc123.trycloudflare.com"));
    assert.ok(records.some((r) => r.type === "TXT" && r.content === "https://abc123.trycloudflare.com/"));
  } finally {
    await mock.stop();
  }
});

test("registerTunnel: non-matching tunnel name ignored; providerProfile+inline works", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  try {
    const none = await registerTunnel(makeCfg(mock), { tunnelName: "other", url: "https://x.example.com" });
    assert.equal(none.length, 0);

    const r2 = await registerTunnel(makeCfg(mock), { tunnelName: "web2", url: "https://def456.trycloudflare.com" });
    assert.equal(r2.length, 1);
    assert.equal(r2[0].actions[0].name, "t2.example.com");
    assert.equal(r2[0].actions[1].name, "t2-txt.example.com");
  } finally {
    await mock.stop();
  }
});

test("urlHost: strips scheme/path/port (CNAME-safe)", () => {
  assert.equal(urlHost("https://abc.trycloudflare.com/foo"), "abc.trycloudflare.com");
  // CNAME values cannot carry a port — stripped
  assert.equal(urlHost("http://localhost:8080/x"), "localhost");
  assert.equal(urlHost("tcp://203.0.113.7:49152"), "203.0.113.7");
  assert.equal(urlHost("abc.trycloudflare.com"), "abc.trycloudflare.com");
});

test("registerTunnel: txt (doc syntax) triggers TXT like txtUrl", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startCloudflareMock } = await import("ddns/src/mocks/cloudflare.ts");
  const dir = mkdtempSync(join(tmpdir(), "st-reg-txt-"));
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  writeFileSync(join(dir, "ddns.json"), JSON.stringify({
    providerProfiles: { cf: { provider: "cloudflare", token: "tk", zoneId, baseUrl: mock.url } },
    profiles: { home: { providerProfile: "cf", zone: "example.com", record: "t.example.com", type: "CNAME" } },
    entries: [{ name: "t1", profile: "home", kind: "tunnel", followTunnel: "web", cname: true, txt: true, txtName: "t-txt.example.com" }],
  }, null, 2));
  try {
    const cfg = readRegistryConfig(dir);
    const rs = await registerTunnel(cfg, { tunnelName: "web", url: "https://abc123.trycloudflare.com" });
    const types = rs[0].actions.map((a) => a.type);
    assert.ok(types.includes("CNAME") && types.includes("TXT"), `doc-syntax txt triggers TXT (got ${types})`);
    const records = mock.state.zones.get("example.com").records;
    const txt = records.find((r) => r.type === "TXT");
    assert.equal(txt?.content, "https://abc123.trycloudflare.com");
  } finally {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy plain array config reads as empty registry (no entries)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-dnsreg-legacy-"));
  try {
    // legacy ddns.json is a plain DdnsEntry array
    writeFileSync(join(dir, "ddns.json"), JSON.stringify([
      { name: "home", provider: "cloudflare", record: "home.example.com", zone: "example.com", token: "tk" },
    ]));
    const cfg = readRegistryConfig(dir);
    assert.deepEqual(cfg.entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
