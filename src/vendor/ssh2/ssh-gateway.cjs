'use strict';
/*
 * Vendored SSH2 gateway entry — CommonJS, loaded from TS via createRequire.
 * Exposes only what the ssh-gateway feature needs: the Server, public-key
 * parsing, and key generation. Client/agent/SFTP paths are cut.
 *
 * Source: mscdex/ssh2@1.17.0 (MIT) — lib/server.js, lib/Channel.js,
 * lib/utils.js, lib/keygen.js, lib/protocol/* (minus SFTP), with
 * asn1 / bcrypt-pbkdf / cpu-features / native-binding dependencies removed
 * (see ssh-asn1.js and the doc comments in the vendored files).
 */
const Server = require('./server.js');
const { parseKey } = require('./protocol/keyParser.js');
const keygen = require('./keygen.js');

module.exports = {
  Server,
  utils: {
    parseKey,
    generateKeyPair: keygen.generateKeyPair,
    generateKeyPairSync: keygen.generateKeyPairSync,
  },
};
