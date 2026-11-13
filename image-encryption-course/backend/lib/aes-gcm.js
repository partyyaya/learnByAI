// 對應章節：Chapter 04 - AES-GCM 全檔加密
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

// 輸出格式：[iv(12) | ciphertext | tag(16)]
// tag 放最後，是因為 WebCrypto 的 AES-GCM 解密要的就是「密文 + tag」連在一起，
// 前端直接傳 subarray(12) 就好，不用再複製一份。
function encrypt(plainBuf) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([iv, enc, tag]),
    key,
  };
}

function decrypt(combined, key) {
  const iv = combined.subarray(0, 12);
  const ct = combined.subarray(12, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const dec = crypto.createDecipheriv(ALGO, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

module.exports = { encrypt, decrypt };
