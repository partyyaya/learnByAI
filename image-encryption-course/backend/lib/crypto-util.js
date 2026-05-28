// 對應章節：Chapter 03（檔頭 AES-CTR）、Chapter 04（key wrap、HMAC 簽名）、Chapter 08（capstone 整合）
'use strict';

const crypto = require('crypto');

const HEADER_LEN = 1024;

// === 檔頭加密（AES-256-CTR）===

function encryptHeader(buf, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const headerLen = Math.min(HEADER_LEN, buf.length);
  const head = buf.subarray(0, headerLen);
  const tail = buf.subarray(headerLen);
  const encHead = Buffer.concat([cipher.update(head), cipher.final()]);
  return Buffer.concat([encHead, tail]);
}

function decryptHeader(buf, key, iv) {
  // AES-CTR 對稱，加解密用同函式即可
  return encryptHeader(buf, key, iv);
}

// === Key Wrap（AES-256-GCM）===
// 用 master key 把每張圖的 key 加密後存進 DB。

function wrapKey(imgKeyHex, masterKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(imgKeyHex, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('hex');
}

function unwrapKey(wrappedHex, masterKey) {
  const buf = Buffer.from(wrappedHex, 'hex');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const dec = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf-8');
}

// === HMAC 簽名 URL ===

function hmacSign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function hmacVerify(secret, payload, sig) {
  const expected = hmacSign(secret, payload);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(sig), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  HEADER_LEN,
  encryptHeader,
  decryptHeader,
  wrapKey,
  unwrapKey,
  hmacSign,
  hmacVerify,
};
