'use strict';
/*
 * Minimal BER/DER encoder+decoder — hand-rolled replacement for the
 * `asn1` npm dependency used by ssh2.
 *
 * Implements only the subset ssh2 uses:
 *   Writer: startSequence/endSequence/writeInt/writeBuffer/writeOID/
 *           writeNull/writeByte/buffer
 *   Reader: readSequence/readInt/readString(tag, retBuf)/readOID/readByte
 *
 * Reader.readString(tag, retBuf) follows the `asn1` lib semantics:
 * consumes a TLV (verifying tag when given) and returns the VALUE bytes;
 * retBuf=true forces a Buffer return (otherwise strings would be decoded).
 *
 * Vendored from ssh2@1.17.0 usage sites; MIT (Brian White) applies to the
 * surrounding vendored code, this file is original work.
 */

const INT = 0x02;
const BITSTRING = 0x03;
const OCTETSTRING = 0x04;
const NULL = 0x05;
const OID = 0x06;
const SEQUENCE = 0x30;

function lenBytes(len) {
  if (len < 0x80) return [len];
  const out = [];
  let n = len;
  while (n > 0) { out.unshift(n & 0xff); n >>>= 8; }
  return [0x80 | out.length, ...out];
}

class Writer {
  /** Public raw buffer + offset, matching the `asn1` lib internals that
   *  ssh2's keyParser/kex poke directly (asnWriter._ensure/_buf/_offset). */
  _buf = Buffer.allocUnsafe(512);
  _offset = 0;
  _stack = [];

  constructor() {
    this._buf = Buffer.allocUnsafe(512);
  }
  _ensure(n) {
    if (this._offset + n > this._buf.length) {
      let newLen = this._buf.length * 2;
      while (this._offset + n > newLen) newLen *= 2;
      const next = Buffer.allocUnsafe(newLen);
      this._buf.copy(next, 0, 0, this._offset);
      this._buf = next;
    }
  }
  startSequence(tag) {
    const t = tag ?? 0x30;
    this._ensure(1);
    this._buf[this._offset++] = t;
    this._stack.push({ tag: t, at: this._offset });
  }
  endSequence() {
    const top = this._stack.pop();
    if (!top) throw new Error('endSequence without startSequence');
    const body = this._buf.subarray(top.at, this._offset);
    const len = body.length;
    const lenHdr = Buffer.from(lenBytes(len));
    const total = 1 + lenHdr.length + len;
    this._ensure(total);
    // Rewrite tag + length at the recorded start, moving body along.
    this._buf.copy(this._buf, top.at - 1 + 1 + lenHdr.length, top.at, this._offset);
    this._buf[top.at - 1] = top.tag;
    lenHdr.copy(this._buf, top.at);
    this._offset = top.at - 1 + total;
  }
  writeInt(v, tag) {
    const bytes = [];
    let n = v;
    do { bytes.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
    this._writeTLV(tag ?? 0x02, Buffer.from(bytes));
  }
  writeBuffer(buf, tag) { this._writeTLV(tag ?? 0x02, buf); }
  writeByte(b) {
    this._ensure(1);
    this._buf[this._offset++] = b;
  }
  writeNull() {
    this._ensure(2);
    this._buf[this._offset++] = 0x05;
    this._buf[this._offset++] = 0x00;
  }
  writeOID(oid) {
    const parts = oid.split('.').map(Number);
    const bytes = [(parts[0] * 40) + parts[1]];
    for (let i = 2; i < parts.length; ++i) {
      let v = parts[i];
      const stack = [];
      stack.unshift(v & 0x7f);
      v >>>= 7;
      while (v > 0) { stack.unshift(0x80 | (v & 0x7f)); v >>>= 7; }
      bytes.push(...stack);
    }
    this._writeTLV(0x06, Buffer.from(bytes));
  }
  _writeTLV(tag, buf) {
    this._ensure(2 + buf.length);
    this._buf[this._offset++] = tag;
    const lenHdr = Buffer.from(lenBytes(buf.length));
    lenHdr.copy(this._buf, this._offset);
    this._offset += lenHdr.length;
    buf.copy(this._buf, this._offset);
    this._offset += buf.length;
  }
  get buffer() {
    return this._buf.subarray(0, this._offset);
  }
}

class Reader {
  constructor(buf) { this._buf = buf; this._pos = 0; }
  _readLen() {
    const first = this._buf[this._pos++];
    if (first < 0x80) return first;
    const n = first & 0x7f;
    let len = 0;
    for (let i = 0; i < n; ++i) len = (len << 8) | this._buf[this._pos++];
    return len;
  }
  readByte() { return this._buf[this._pos++]; }
  readSequence() {
    const t = this._buf[this._pos++];
    if (t !== SEQUENCE)
      throw new Error(`Expected BER SEQUENCE, got 0x${t.toString(16)}`);
    this._readLen();
    return true;
  }
  readString(tag, retBuf) {
    if (typeof tag === 'boolean') { retBuf = tag; tag = undefined; }
    if (tag !== undefined) {
      const t = this._buf[this._pos++];
      if (t !== tag)
        throw new Error(`Expected BER tag 0x${tag.toString(16)}, got 0x${t.toString(16)}`);
    } else {
      this._buf[this._pos++];
    }
    const len = this._readLen();
    const val = this._buf.subarray(this._pos, this._pos + len);
    this._pos += len;
    return retBuf ? val : val.toString('utf8');
  }
  readOID() {
    const v = this.readString(OID, true);
    if (v.length === 0) return '';
    const out = [];
    let value = 0;
    let first = true;
    for (const b of v) {
      if (first) { out.push(Math.floor(b / 40), b % 40); first = false; continue; }
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x7f)) { /* continuation */ }
      if (!(b & 0x80)) { out.push(value); value = 0; }
    }
    return out.join('.');
  }
  readInt() {
    const v = this.readString(INT, true);
    let n = 0;
    for (const b of v) n = (n * 256) + b;
    return n;
  }
}

module.exports = {
  Ber: {
    Writer,
    Reader,
    Integer: INT,
    BitString: BITSTRING,
    OctetString: OCTETSTRING,
    Null: NULL,
    Sequence: SEQUENCE,
  },
};
