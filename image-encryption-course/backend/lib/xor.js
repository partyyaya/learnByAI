// 對應章節：Chapter 02 - XOR 全檔加密
'use strict';

const crypto = require('crypto');

function xorBuffer(buf, key) {
  const out = Buffer.alloc(buf.length);
  const kl = key.length;
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key[i % kl];
  }
  return out;
}

function randomKey(byteLen = 32) {
  return crypto.randomBytes(byteLen);
}

module.exports = { xorBuffer, randomKey };
