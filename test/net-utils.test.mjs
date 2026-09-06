import assert from "node:assert/strict";
import test from "node:test";
import { connect, createServer } from "node:net";

async function loadNet() {
  return import("../src/net-utils.ts");
}

test("isBareIpv6 / isIpv6Host: bare, bracketed, zone-scoped, negatives", async () => {
  const { isBareIpv6, isIpv6Host, isIpv4Host, isIpHost } = await loadNet();
  for (const v6 of ["::1", "2001:db8::1", "fe80::1%eth0", "2001:db8:85a3::8a2e:370:7334", "::"]) {
    assert.equal(isBareIpv6(v6), true, `isBareIpv6 ${v6}`);
    assert.equal(isIpv6Host(v6), true, `isIpv6Host ${v6}`);
    assert.equal(isIpHost(v6), true, `isIpHost ${v6}`);
  }
  for (const bracketed of ["[::1]", "[2001:db8::1]"]) {
    assert.equal(isBareIpv6(bracketed), false, `isBareIpv6 ${bracketed} (has brackets)`);
    assert.equal(isIpv6Host(bracketed), true, `isIpv6Host ${bracketed}`);
    assert.equal(isIpHost(bracketed), true, `isIpHost ${bracketed}`);
  }
  for (const not6 of ["127.0.0.1", "example.com", "localhost", "", "1.2.3.4:8080", "-dead::1"]) {
    assert.equal(isBareIpv6(not6), false, `isBareIpv6 ${not6}`);
    assert.equal(isIpv6Host(not6), false, `isIpv6Host ${not6}`);
  }
  assert.equal(isIpv4Host("127.0.0.1"), true);
  assert.equal(isIpv4Host("1.2.3.4"), true);
  assert.equal(isIpv4Host("2001:db8::1"), false);
  assert.equal(isIpHost("127.0.0.1"), true);
  assert.equal(isIpHost("example.com"), false);
});

test("bracketHost / unbracketHost: IPv6 gets brackets, others unchanged", async () => {
  const { bracketHost, unbracketHost } = await loadNet();
  assert.equal(bracketHost("2001:db8::1"), "[2001:db8::1]");
  assert.equal(bracketHost("::1"), "[::1]");
  assert.equal(bracketHost("[::1]"), "[::1]", "already bracketed stays");
  assert.equal(bracketHost("127.0.0.1"), "127.0.0.1", "IPv4 stays");
  assert.equal(bracketHost("example.com"), "example.com");
  assert.equal(bracketHost("fe80::1%eth0"), "[fe80::1%eth0]");
  assert.equal(unbracketHost("[2001:db8::1]"), "2001:db8::1");
  assert.equal(unbracketHost("::1"), "::1");
  assert.equal(unbracketHost("example.com"), "example.com");
});

test("parseHostPort: host[:port] / [ipv6][:port] / bare ipv6", async () => {
  const { parseHostPort } = await loadNet();
  assert.deepEqual(parseHostPort("[2001:db8::1]:7000"), { host: "2001:db8::1", port: "7000" });
  assert.deepEqual(parseHostPort("[::1]:7000"), { host: "::1", port: "7000" });
  assert.deepEqual(parseHostPort("[::1]"), { host: "::1", port: "" });
  assert.deepEqual(parseHostPort("2001:db8::1"), { host: "2001:db8::1", port: "" }, "bare v6 (no port)");
  assert.deepEqual(parseHostPort("example.com:7000"), { host: "example.com", port: "7000" });
  assert.deepEqual(parseHostPort("1.2.3.4:7000"), { host: "1.2.3.4", port: "7000" });
  assert.deepEqual(parseHostPort("localhost"), { host: "localhost", port: "" });
  assert.deepEqual(parseHostPort(""), { host: "", port: "" });
});

test("hostnameOnly: Host-header → hostname (brackets stripped, port removed)", async () => {
  const { hostnameOnly } = await loadNet();
  assert.equal(hostnameOnly("[2001:db8::1]:8080"), "2001:db8::1");
  assert.equal(hostnameOnly("[::1]:8080"), "::1");
  assert.equal(hostnameOnly("[::1]"), "::1");
  assert.equal(hostnameOnly("example.com:8080"), "example.com");
  assert.equal(hostnameOnly("example.com"), "example.com");
  assert.equal(hostnameOnly("5173.st.localhost:4180"), "5173.st.localhost");
  assert.equal(hostnameOnly(undefined), "");
  assert.equal(hostnameOnly(""), "");
});

test("formatHostPort: brackets IPv6, keeps port", async () => {
  const { formatHostPort } = await loadNet();
  assert.equal(formatHostPort("2001:db8::1", 8080), "[2001:db8::1]:8080");
  assert.equal(formatHostPort("2001:db8::1", "8080"), "[2001:db8::1]:8080");
  assert.equal(formatHostPort("127.0.0.1", 8080), "127.0.0.1:8080");
  assert.equal(formatHostPort("example.com", 8080), "example.com:8080");
  assert.equal(formatHostPort("2001:db8::1", undefined), "[2001:db8::1]");
  assert.equal(formatHostPort("::1", undefined), "[::1]");
});

test("resolveTargetHost: picks 127.0.0.1 for IPv4-bound, ::1 for IPv6-bound", { timeout: 15_000 }, async () => {
  const { resolveTargetHost, _resetTargetHostCache } = await loadNet();
  _resetTargetHostCache();
  const freePort = () =>
    new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  // 1) port bound on 127.0.0.1 → target 127.0.0.1
  const p4 = await freePort();
  const s4 = createServer();
  await new Promise((r) => s4.listen(p4, "127.0.0.1", r));
  try {
    assert.equal(await resolveTargetHost(p4), "127.0.0.1");
  } finally {
    await new Promise((r) => s4.close(r));
  }
  // 2) port bound ONLY on ::1 → target ::1 (skip when no IPv6 loopback)
  const s6 = createServer();
  await new Promise((resolve) => {
    s6.once("error", () => resolve());
    s6.listen(0, "::1", () => resolve());
  });
  if (s6.address() !== null) {
    const p6 = s6.address().port;
    try {
      const got = await resolveTargetHost(p6);
      assert.equal(got, "::1", `IPv6-only port resolves to ::1 (got ${got})`);
    } finally {
      await new Promise((r) => s6.close(r));
    }
    // 3) same port now free → fallback 127.0.0.1
    _resetTargetHostCache();
    assert.equal(await resolveTargetHost(p6), "127.0.0.1");
  }
  _resetTargetHostCache();
});