// 對應章節：Chapter 01（magic number）、Chapter 03（決定檔頭加密範圍）、Chapter 08（上傳驗證）
'use strict';

// 用 magic number 判斷格式。上傳時的 mimetype 是瀏覽器送來的，不能信，以這裡的結果為準。
function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504E47 && buf.readUInt32BE(4) === 0x0D0A1A0A) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

// 回傳「影像資料開始」的 offset，也就是解碼器需要的表格、尺寸資訊全部結束的位置。
// 認不出結構時回傳 -1。
//
// 為什麼不能只看「前 N byte」：手機照片開頭常是幾 KB 到幾十 KB 的 Exif / ICC，
// 只加密前 1024 byte 等於只加密 metadata，攻擊者把 metadata 丟掉、補回 FF D8 就能解碼。
function imageDataOffset(buf) {
  const type = detectImageType(buf);

  if (type === 'image/jpeg') {
    // 走 marker 串列，直到 SOS（FF DA）的標頭結束
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xFF) return -1;
      const m = buf[i + 1];
      if (m === 0xFF) { i += 1; continue; }                          // marker 前的填充 FF
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; } // 沒有長度欄位的 marker
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return -1;
      if (m === 0xDA) return i + 2 + len;                            // SOS 標頭之後就是壓縮資料
      i += 2 + len;
    }
    return -1;
  }

  if (type === 'image/png') {
    // 走 chunk 串列，直到第一個 IDAT 的資料開頭
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      if (buf.toString('ascii', i + 4, i + 8) === 'IDAT') return i + 8;
      i += 12 + len;                                                 // length + type + data + CRC
    }
    return -1;
  }

  if (type === 'image/webp') {
    // RIFF chunk，直到 VP8 / VP8L 位元流開頭（動畫 WebP 不在這裡處理，回傳 -1）
    let i = 12;
    while (i + 8 <= buf.length) {
      const fourcc = buf.toString('ascii', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (fourcc === 'VP8 ' || fourcc === 'VP8L') return i + 8;
      i += 8 + size + (size & 1);                                    // chunk 會補齊到偶數長度
    }
    return -1;
  }

  return -1;
}

module.exports = { detectImageType, imageDataOffset };
