// 對應章節：Chapter 03（檔頭 AES-CTR）、Chapter 04（key wrap、HMAC 簽名）、Chapter 08（capstone 整合）
'use strict';

const crypto = require('crypto');
const { imageDataOffset } = require('./image-format');

// 影像資料開始之後，再多加密的 byte 數
const HEADER_EXTRA = 1024;

// === 檔頭加密（AES-256-CTR）===

// 加密範圍 = 檔頭（含 Exif、量化表、霍夫曼表、尺寸）+ 影像資料的前 HEADER_EXTRA byte。
// 認不出格式時整檔加密，寧可慢一點也不要漏掉。
function computeHeaderLen(buf) {
  const offset = imageDataOffset(buf);
  if (offset < 0) return buf.length;
  return Math.min(buf.length, offset + HEADER_EXTRA);
}

// CTR 不改變長度，加密後的檔頭可以直接接回原本的尾段。
// Node 的 aes-256-ctr 把 16 byte IV 當成 128 bit 計數器遞增，
// 前端要用 WebCrypto length: 128（或 Rust 的 Ctr128BE）才會完全一致。
function encryptHeader(buf, key, iv, headerLen) {
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const head = buf.subarray(0, headerLen);
  const tail = buf.subarray(headerLen);
  const encHead = Buffer.concat([cipher.update(head), cipher.final()]);
  return Buffer.concat([encHead, tail]);
}

function decryptHeader(buf, key, iv, headerLen) {
  // AES-CTR 對稱，加解密用同一個函式即可
  return encryptHeader(buf, key, iv, headerLen);
}

// === 用途不同的 key 各自衍生（HKDF）===
// 同一把 key 不要同時拿來做「包裝圖片 key」和「簽 URL」，用 label 分開衍生。

function deriveKey(rootKey, label) {
  return Buffer.from(crypto.hkdfSync('sha256', rootKey, Buffer.alloc(0), label, 32));
}

// === Key Wrap（AES-256-GCM）===
// 用 master key 把每張圖的 32 byte key 加密後存進 DB。
// aad 帶 image id：包好的 key 跟那張圖綁在一起，搬到別的資料列會解不開。

function wrapKey(imgKey, masterKey, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf-8'));
  const ct = Buffer.concat([cipher.update(imgKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('hex');
}

function unwrapKey(wrappedHex, masterKey, aad) {
  const buf = Buffer.from(wrappedHex, 'hex');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const dec = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  dec.setAAD(Buffer.from(aad, 'utf-8'));
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

// === HMAC 簽名 URL ===

function hmacSign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function hmacVerify(secret, payload, sig) {
  const expected = Buffer.from(hmacSign(secret, payload), 'hex');
  const given = Buffer.from(String(sig), 'hex');
  // timingSafeEqual 遇到長度不同會直接丟例外，先比長度
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = {
  HEADER_EXTRA,
  computeHeaderLen,
  encryptHeader,
  decryptHeader,
  deriveKey,
  wrapKey,
  unwrapKey,
  hmacSign,
  hmacVerify,
};
