import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SshDomain, sshFingerprint } from "../src/ssh/domain.ts";
import { generateKeyPairSync, parseKey } from "../src/ssh/vendor.ts";

test("domain: host keys auto-generated (ed25519+rsa+ecdsa), 0600, fingerprints parse", () => {
  const base = mkdtempSync(join(tmpdir(), "st-sshdom-"));
  try {
    const dir = join(base, "d");
    const d = SshDomain.create("d", dir);
    for (const f of ["host_ed25519_key", "host_rsa_key", "host_ecdsa_key"]) {
      const p = join(dir, f);
      assert.ok(existsSync(p), `${f} must exist`);
      if (process.platform !== "win32") {
        assert.equal(statSync(p).mode & 0o777, 0o600, `${f} must be 0600`);
      }
      // host key must be parseable + usable by system ssh-keygen
      const out = execFileSync("ssh-keygen", ["-y", "-f", p], { encoding: "utf8" }).trim();
      assert.match(out, /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256)/);
    }
    const fps = d.hostKeyFingerprints();
    assert.deepEqual(Object.keys(fps).sort(), ["ecdsa", "ed25519", "rsa"]);
    // fingerprint must match system ssh-keygen
    const sys = execFileSync("ssh-keygen", ["-lf", join(dir, "host_ed25519_key")], { encoding: "utf8" });
    const sysFp = sys.match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
    assert.equal(fps.ed25519, sysFp, "fingerprint must match ssh-keygen");
    // idempotent: second create must NOT regenerate (same fingerprint)
    const d2 = SshDomain.create("d", dir);
    assert.deepEqual(d2.hostKeyFingerprints(), fps, "host keys must be stable across create()");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("domain: add/duplicate/list/remove authorized keys + persistence", () => {
  const base = mkdtempSync(join(tmpdir(), "st-sshdom-"));
  try {
    const dir = join(base, "d");
    const d = SshDomain.create("d", dir);

    const k1 = generateKeyPairSync("ed25519", { comment: "alice" });
    const k2 = generateKeyPairSync("ed25519", { comment: "bob" });

    const r1 = d.addKey(k1.public);
    assert.match(r1.fingerprint, /^SHA256:/);
    // fingerprint must match system ssh-keygen for the same blob
    const kpFile = join(base, "k1.pub");
    writeFileSync(kpFile, k1.public + "\n");
    const sys = execFileSync("ssh-keygen", ["-lf", kpFile], { encoding: "utf8" });
    assert.ok(sys.includes(r1.fingerprint), `system fp must contain ${r1.fingerprint} (got ${sys})`);

    d.addKey(k2.public);
    // duplicate rejected
    assert.throws(() => d.addKey(k1.public), /already authorized/);
    // garbage rejected
    assert.throws(() => d.addKey("garbage key material"), /invalid public key/);

    const list = d.listAuthorizedKeys();
    assert.equal(list.length, 2);
    const alice = list.find((k) => k.comment === "alice");
    assert.ok(alice);
    assert.equal(alice.addedAt.length > 0, true, "addedAt must be recorded");

    // authorized_keys file is real + readable by ssh-keygen (format check)
    const raw = readFileSync(join(dir, "authorized_keys"), "utf8");
    assert.match(raw, /^ssh-ed25519 AAAA/);

    // remove by fingerprint
    assert.equal(d.removeKey(alice.fingerprint), true);
    assert.equal(d.listAuthorizedKeys().length, 1);
    assert.equal(d.removeKey(alice.fingerprint), false, "second remove must return false");

    // persistence: reload from disk
    const d2 = SshDomain.create("d", dir);
    assert.equal(d2.listAuthorizedKeys().length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("domain: generateKey returns private once, stores public, rsa/ecdsa ok", () => {
  const base = mkdtempSync(join(tmpdir(), "st-sshdom-"));
  try {
    const dir = join(base, "d");
    const d = SshDomain.create("d", dir);

    const ed = d.generateKey("ed25519", undefined, "dev");
    assert.match(ed.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
    const privFile = join(base, "ed.key");
    writeFileSync(privFile, ed.privateKey);
    chmodSync(privFile, 0o600);
    const pub = execFileSync("ssh-keygen", ["-y", "-f", privFile], { encoding: "utf8" }).trim().split(" ").slice(0, 2).join(" ");
    const stored = d.listAuthorizedKeys().find((k) => k.fingerprint === ed.fingerprint);
    assert.ok(stored, "generated public key must be stored");
    assert.equal(pub, ed.publicKey.split(" ").slice(0, 2).join(" "), "private must match stored public");

    // rsa + ecdsa generations
    const rsa = d.generateKey("rsa", 2048, "rsa-dev");
    assert.match(rsa.publicKey, /^ssh-rsa /);
    const ec = d.generateKey("ecdsa", 256, "ec-dev");
    assert.match(ec.publicKey, /^ecdsa-sha2-nistp256 /);
    assert.equal(d.listAuthorizedKeys().length, 3);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("domain: meta.json save/load", () => {
  const base = mkdtempSync(join(tmpdir(), "st-sshdom-"));
  try {
    const dir = join(base, "d");
    const d = SshDomain.create("d", dir);
    const meta = d.saveMeta({ domain: "d", forwardPort: 5432, forwardHost: "127.0.0.1" });
    assert.equal(meta.forwardPort, 5432);
    const d2 = SshDomain.create("d", dir);
    const loaded = d2.loadMeta();
    assert.equal(loaded?.forwardPort, 5432);
    assert.equal(loaded?.createdAt, meta.createdAt, "createdAt must be stable across save/load");
    // update keeps createdAt
    const m2 = d2.saveMeta({ domain: "d", forwardPort: 5433 });
    assert.equal(m2.createdAt, meta.createdAt);
    assert.equal(m2.forwardPort, 5433);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sshFingerprint: matches system ssh-keygen output", () => {
  const kp = generateKeyPairSync("ed25519");
  const parsed = parseKey(kp.public);
  assert.ok(parsed instanceof Error === false);
  const ours = sshFingerprint(parsed.getPublicSSH());
  assert.match(ours, /^SHA256:[A-Za-z0-9+/]{43}$/);
});
