/** DDNS adapter tests — service-tunnels delegates to the `ddns` package
 *  (107 providers). These tests verify the adapter layer: config read/write
 *  in service-tunnels' configDir, updateDdnsRecord/runDdnsOnce/startDdnsLoop
 *  forwarding, and dimension-2 tunnel-discovery beacons. The provider
 *  engine itself is covered by the ddns package's own test suite. */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  return import("../src/ddns.ts");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("readDdnsConfigs/writeDdnsConfigs round-trip (0600, same file the ddns package reads)", async () => {
  const { readDdnsConfigs, writeDdnsConfigs, ddnsConfigPath } = await loadSubject();
  const dir = mkdtempSync(join(tmpdir(), "st-ddns-"));
  try {
    writeDdnsConfigs(dir, [
      { name: "home", provider: "cloudflare", record: "home.example.com", zone: "example.com", token: "tk" },
      { name: "bcn", provider: "cloudflare", record: "discover.example.com", zone: "example.com", token: "tk", followTunnel: "web" },
    ]);
    assert.ok(existsSync(ddnsConfigPath(dir)));
    if (process.platform !== "win32") assert.equal(statSync(ddnsConfigPath(dir)).mode & 0o777, 0o600);
    const cfgs = readDdnsConfigs(dir);
    assert.equal(cfgs.length, 2);
    assert.equal(cfgs[0].provider, "cloudflare");
    // followTunnel survives the round-trip (beacon entries)
    assert.equal(cfgs[1].followTunnel, "web");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateDdnsRecord: delegates to ddns engine — zone provider create/unchanged/update", async () => {
  const { updateDdnsRecord } = await loadSubject();
  const { startCloudflareMock } = await import("ddns/src/mocks/cloudflare.ts");
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  try {
    // create
    const r1 = await updateDdnsRecord({
      name: "home", provider: "cloudflare", record: "home.example.com", zone: "example.com",
      token: "tk", zoneId, baseUrl: mock.url, ip: "1.1.1.1",
    });
    assert.equal(r1.changed, true);
    assert.equal(mock.state.zones.get("example.com").records.length, 1);

    // unchanged
    const r2 = await updateDdnsRecord({
      name: "home", provider: "cloudflare", record: "home.example.com", zone: "example.com",
      token: "tk", zoneId, baseUrl: mock.url, ip: "1.1.1.1",
    });
    assert.equal(r2.skipped, "unchanged");

    // update
    const r3 = await updateDdnsRecord({
      name: "home", provider: "cloudflare", record: "home.example.com", zone: "example.com",
      token: "tk", zoneId, baseUrl: mock.url, ip: "2.2.2.2",
    });
    assert.equal(r3.changed, true);
    assert.equal(mock.state.zones.get("example.com").records[0].content, "2.2.2.2");
  } finally {
    await mock.stop();
  }
});

test("runDdnsOnce + startDdnsLoop forward to the ddns engine", async () => {
  const { runDdnsOnce, startDdnsLoop } = await loadSubject();
  const { startDuckdnsMock } = await import("ddns/src/mocks/duckdns.ts");
  const mock = await startDuckdnsMock({ token: "duck" });
  try {
    const results = await runDdnsOnce([
      { name: "d", provider: "duckdns", record: "mylab", token: "duck", ip: "1.2.3.4", baseUrl: mock.url },
    ]);
    assert.equal(results[0].changed, true);
    assert.equal(mock.state.ips.get("mylab").ipv4, "1.2.3.4");

    const logs = [];
    const loop = startDdnsLoop(
      [{ name: "d", provider: "duckdns", record: "mylab", token: "duck", ip: "1.2.3.4", baseUrl: mock.url, intervalSec: 30 }],
      { log: (l) => logs.push(l) },
    );
    await sleep(100);
    assert.ok(logs.length > 0);
    loop.stop();
  } finally {
    await mock.stop();
  }
});

test("updateBeacon: dimension-2 — CNAME beacon follows a tunnel URL", async () => {
  const { updateBeacon, beaconValue } = await loadSubject();
  const { startCloudflareMock } = await import("ddns/src/mocks/cloudflare.ts");
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  try {
    // CNAME: full URL → host extracted
    const r = await updateBeacon(
      { provider: "cloudflare", token: "tk", zoneId, baseUrl: mock.url, zone: "example.com", name: "discover.example.com", type: "CNAME" },
      "https://abc123.trycloudflare.com",
    );
    assert.equal(r.ok, true);
    assert.equal(r.value, "abc123.trycloudflare.com");
    assert.equal(mock.state.zones.get("example.com").records[0].type, "CNAME");
    assert.equal(mock.state.zones.get("example.com").records[0].content, "abc123.trycloudflare.com");

    // TXT keeps the full URL
    await updateBeacon(
      { provider: "cloudflare", token: "tk", zoneId, baseUrl: mock.url, zone: "example.com", name: "discover-txt.example.com", type: "TXT" },
      "https://abc123.trycloudflare.com",
    );
    const txt = mock.state.zones.get("example.com").records.find((r2) => r2.name === "discover-txt.example.com");
    assert.equal(txt.type, "TXT");
    assert.equal(txt.content, "https://abc123.trycloudflare.com");

    // beaconValue helper
    assert.equal(beaconValue("https://x.trycloudflare.com/foo", "CNAME"), "x.trycloudflare.com");
    assert.equal(beaconValue("https://x.trycloudflare.com", "TXT"), "https://x.trycloudflare.com");

    // bad provider → error surfaced, never throws
    const bad = await updateBeacon(
      { provider: "no-such-provider", zone: "example.com", name: "x.example.com" },
      "https://y.trycloudflare.com",
    );
    assert.equal(bad.ok, false);
    assert.ok(bad.error);
  } finally {
    await mock.stop();
  }
});
