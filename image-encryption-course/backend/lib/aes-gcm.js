// 對應章節：Chapter 04 - AES-GCM 全檔加密
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

// 輸出格式：[iv(12) | tag(16) | ciphertext]
function encrypt(plainBuf) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([iv, tag, enc]),
    keyHex: key.toString('hex'),
  };
}

function decrypt(combined, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(12, 28);
  const ct = combined.subarray(28);
  const dec = crypto.createDecipheriv(ALGO, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

module.exports = { encrypt, decrypt };
