# 第 03 章：只加密檔頭——用安全度換計算量

> **學習目標**：實作「只加密檔頭」方案，知道加密範圍要蓋到哪裡才算數，以及它省下了什麼、犧牲了什麼。
> **預計時數**：90 分鐘
> **先備知識**：[第 01 章](./01-image-format-and-magic-number.md)、[第 02 章](./02-xor-encryption.md)

> **本章對應專案**
>
> | 檔案 | 用途 |
> |------|------|
> | [`backend/lib/image-format.js`](./backend/lib/image-format.js) | `detectImageType / imageDataOffset`：判斷格式、找出影像資料開始的位置 |
> | [`backend/lib/crypto-util.js`](./backend/lib/crypto-util.js) | `computeHeaderLen / encryptHeader / decryptHeader`（AES-CTR） |
> | [`backend/examples/ch03-header-server.js`](./backend/examples/ch03-header-server.js) | 本章 demo server |
> | [`frontend/examples/ch03-header.html`](./frontend/examples/ch03-header.html) | 前端 WebCrypto 解密頁 |
>
> 啟動：`cd backend && npm run ch03`，打開 `http://localhost:3000/examples/ch03-header.html`。

---

## 1 為什麼不全加密就好？

全檔加密要花多少時間，取決於瀏覽器端用什麼解密。Apple M2 + Edge 157 上解一個 5MB 的檔案：

| 解密方式 | 5MB 全檔 | 說明 |
|---------|---------|------|
| 純 JS XOR（[第 02 章](./02-xor-encryption.md) 的寫法） | ~9 ms | 在主執行緒上跑 |
| WebCrypto AES-CTR / AES-GCM | ~2.6 ms | 瀏覽器內建、有硬體加速，非同步執行，不卡主執行緒 |
| WASM AES-CTR（[第 06 章](./06-wasm-decryption-in-browser.md)） | ~54 ms | 純軟體實作，沒有硬體加速 |

用 WebCrypto 的話，全檔加密其實不貴，[第 04 章](./04-aes-with-webcrypto.md) 就是這麼做。但下面幾種情況，全檔的成本會被放大：

| 場景 | 問題 |
|------|------|
| 解密必須用 JS / WASM 軟體實作（例如想把解密流程藏進 WASM） | 5MB 就要幾十 ms，一頁 20 張就超過 1 秒 |
| 手機 CPU | 比桌機慢好幾倍 |
| 商品列表瀑布流 | 同時解 30+ 張 |

所以有些網站改成**只加密檔頭**：只動解碼器一定需要的那一小段，其餘 byte 原樣傳送。

---

## 2 核心觀念：「壞檔頭，整檔失效」

回顧 [第 01 章](./01-image-format-and-magic-number.md)：

- JPEG 要解碼，必須拿到量化表（DQT）、霍夫曼表（DHT）、尺寸（SOF）和 SOS
- PNG 要解碼，必須拿到 IHDR，壓縮資料也得從頭開始解
- 這些都在檔案開頭；它們被加密，後面 99% 的 byte 就算是明文也沒用

> **前提是加密範圍真的蓋住了這些表格。** 只蓋到一部分，對手就能把壞掉的部分丟掉、自己補回來。

### 反例：固定只加密前 1024 byte

手機照片開頭是好幾 KB 的 Exif（常含一張縮圖）。拿一張 Exif 有 6KB 的 JPEG 做實驗：

1. 只用 AES-CTR 加密前 1024 byte——加密到的全是 Exif。
2. 對手不需要 key：從第 1024 byte 往後找第一個能一路接到 SOS 的 marker（這張圖在第 6233 byte 找到 DQT），前面補上 `FF D8`。
3. 解出來的像素和原圖**完全相同**。

所以本章不用固定的 N，而是**每張圖各自找出影像資料開始的位置，再往後多加密 1KB**。

### 效能對比

| 方案 | 加密 byte 數 | 5MB 圖耗時（M2 + Edge 157） |
|------|------------|-----------|
| 全檔 XOR（純 JS） | 5,242,880 | ~9 ms |
| 全檔 AES-CTR（WebCrypto） | 5,242,880 | ~2.6 ms |
| 全檔 AES-CTR（WASM） | 5,242,880 | ~54 ms |
| 檔頭 AES-CTR（WebCrypto，含 importKey） | ~1,700 | < 0.01 ms |
| 檔頭 AES-CTR（WASM） | ~1,700 | ~0.02 ms |

計算量少了三個數量級；代價是安全度，第 8 節會說明。

---

## 3 加密策略設計

「只加密檔頭」聽起來簡單，但魔鬼在細節。

### 3.1 加密範圍要多大？

規則：**從檔案開頭一路加密到「影像資料開始」，再往後多 1KB**。

| 格式 | 影像資料從哪裡開始 | 加密範圍涵蓋 |
|------|------------------|-------------|
| JPEG | SOS 標頭結束處 | APPn（Exif、ICC）、DQT、DHT、SOF、SOS，再加壓縮資料的前 1KB |
| PNG | 第一個 IDAT 的資料開頭 | signature、IHDR、PLTE 等前置 chunk，再加壓縮資料的前 1KB |
| WebP | VP8 / VP8L 位元流開頭 | RIFF 標頭、VP8X 等 chunk，再加位元流的前 1KB |
| 其他、認不出結構 | — | 整檔加密 |

實測：沒有大 Exif 的 JPEG（例如用 macOS「預覽程式」另存的）約 1.7KB；上面那張 6KB Exif 的照片是 7.9KB；測試用的 PNG 約 1.6KB。
每張圖的長度記在 meta 的 `headerLen`，前端照著解。

為什麼要多吃掉 1KB 壓縮資料：只加密到 SOS 剛好結束時，壓縮資料完整無缺，不少編碼器用的是標準量化表、標準霍夫曼表，對手猜中表格就能解碼。多加密一段壓縮資料，就算表格猜中了，開頭也缺一塊。這仍然不是密碼學等級的保護，第 8 節會說明它擋得住誰。

### 3.2 用什麼演算法加密這段？

- **XOR**：可，但前面說過弱。
- **AES-CTR**：強，而且只加密幾 KB，開銷很低。
- **XOR + Shuffle**：先 XOR 再把 byte 順序打亂，增加分析難度。

本章用 **AES-CTR 加密檔頭**：演算法本身是強的，弱點只在「其餘 byte 是明文」。
（XOR 版本作業留給你；AES 在 [第 04 章](./04-aes-with-webcrypto.md) 細講原理）

### 3.3 加密區段該不該變動？

進階做法：每張圖隨機決定加密的長度或段落，而不是固定規則。
但這要求這些參數必須能還原（從 meta 傳）。本章先固定，第 7 節與作業會擴充。

---

## 4 後端實作

### 4.1 找出影像資料開始的位置 [`backend/lib/image-format.js`](./backend/lib/image-format.js)

以 JPEG 為例：從 SOI 之後一個一個 marker 往下走，直到 SOS 的標頭結束。PNG 走 chunk、WebP 走 RIFF chunk，做法相同，見完整檔案。

```js
// 摘自 backend/lib/image-format.js 的 JPEG 分支
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
```

### 4.2 加密函式 [`backend/lib/crypto-util.js`](./backend/lib/crypto-util.js)

```js
// 摘自 backend/lib/crypto-util.js
const crypto = require('crypto');
const { imageDataOffset } = require('./image-format');

// 影像資料開始之後，再多加密的 byte 數
const HEADER_EXTRA = 1024;

// 加密範圍 = 檔頭（含 Exif、量化表、霍夫曼表、尺寸）+ 影像資料的前 HEADER_EXTRA byte。
// 認不出格式時整檔加密，寧可慢一點也不要漏掉。
function computeHeaderLen(buf) {
  const offset = imageDataOffset(buf);
  if (offset < 0) return buf.length;
  return Math.min(buf.length, offset + HEADER_EXTRA);
}

// CTR 不改變長度，加密後的檔頭可以直接接回原本的尾段。
function encryptHeader(buf, key, iv, headerLen) {
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const head = buf.subarray(0, headerLen);
  const tail = buf.subarray(headerLen);
  const encHead = Buffer.concat([cipher.update(head), cipher.final()]);
  return Buffer.concat([encHead, tail]);
}
```

### 4.3 路由 [`backend/examples/ch03-header-server.js`](./backend/examples/ch03-header-server.js)

完整程式碼請看實際檔案，這裡只列關鍵差異——上傳時先算出這張圖的加密範圍：

```js
// 摘自 backend/examples/ch03-header-server.js
const { computeHeaderLen, encryptHeader } = require('../lib/crypto-util');

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const headerLen = computeHeaderLen(req.file.buffer);   // 每張圖各自算加密範圍
  const encrypted = encryptHeader(req.file.buffer, key, iv, headerLen);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  const meta = load();
  meta[id] = {
    id,
    mime: req.file.mimetype,
    headerLen,
    keyHex: key.toString('hex'),
    ivHex: iv.toString('hex'),
    algorithm: 'aes-256-ctr-header',
    createdAt: Date.now(),
  };
  save(meta);

  res.json({ id, headerLen, size: req.file.size });
});

// key 介面也跟著回傳 ivHex / headerLen（demo 簡化：沒做身分驗證，第 07 章補上）
app.get('/api/image/:id/key', (req, res) => {
  const m = load()[req.params.id];
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.json({
    keyHex: m.keyHex,
    ivHex: m.ivHex,
    headerLen: m.headerLen,
    mime: m.mime,
  });
});
```

### 4.4 為什麼選 CTR mode？

| Mode | 加密後長度 | 只處理其中一段 | 適合本場景嗎 |
|------|-----------|---------------|--------------|
| CBC | 會變長（padding） | 解密可以從任一 block 開始（拿前一個密文 block 當 IV），但加密必須從頭依序做；長度一變，「加密檔頭 + 原樣尾段」就拼不起來 | ❌ |
| GCM | 不變，但多一個 16 byte tag 要另外存 | 可以把檔頭當成一段完整訊息加密，tag 存在 meta；但解密時要整段一起驗證 | △ |
| **CTR** | 不變 | ✅ 任意 offset 都能直接解 | ✅ |

CTR 把 block cipher 變成 stream cipher：
- 不改變長度 → 「加密的檔頭 + 原樣的尾段」可以無痛拼接
- 解密時也只解檔頭，後面不動

---

## 5 前端實作：用 WebCrypto 解密檔頭

對應檔案：[`frontend/examples/ch03-header.html`](./frontend/examples/ch03-header.html)。
打開 `http://localhost:3000/examples/ch03-header.html` 直接測試。

```js
// 等同於 ch03-header.html 的 <script> 區塊

document.getElementById('upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // 1. 上傳
  const fd = new FormData();
  fd.append('image', file);
  const { id } = await fetch('/api/upload', { method: 'POST', body: fd })
    .then(r => r.json());

  document.getElementById('rawImg').src = `/api/image/${id}.enc`;

  // 2. 並行抓 key + 加密內容
  const [meta, encBuf] = await Promise.all([
    fetch(`/api/image/${id}/key`).then(r => r.json()),
    fetch(`/api/image/${id}.enc`).then(r => r.arrayBuffer())
  ]);

  // 3. 解密（只解前 headerLen byte）
  const decBuf = await decryptHeader(encBuf, meta);

  // 4. 顯示
  const blob = new Blob([decBuf], { type: meta.mime });
  const url = URL.createObjectURL(blob);
  const img = document.getElementById('decImg');
  img.onload = () => URL.revokeObjectURL(url);
  img.src = url;
});

async function decryptHeader(encBuf, meta) {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(meta.keyHex),
    { name: 'AES-CTR', length: 256 },
    false,
    ['decrypt']
  );

  const buf = new Uint8Array(encBuf);
  const headerEnc = buf.subarray(0, meta.headerLen);

  const headerPlain = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-CTR',
      counter: hexToBytes(meta.ivHex),
      length: 128,   // 整個 16 byte 都當計數器遞增，跟 Node 的 aes-256-ctr 一致
    },
    key,
    headerEnc
  ));

  // 解出來的檔頭直接寫回原本的 buffer，尾段原樣不動，不用再複製整個檔案
  buf.set(headerPlain, 0);
  return buf;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
```

> 我們直接用瀏覽器原生的 `crypto.subtle`，效能極好，且實作正確（避免自己寫 AES 的常見錯誤）。

### `length` 為什麼是 128？

WebCrypto 的 AES-CTR 把 16 byte 的 `counter` 分成兩半：前面固定、後 `length` bit 每個 block 加 1。
Node 的 `aes-256-ctr`（OpenSSL）則把**整個 16 byte** 當成一個 128 bit 的數字遞增。

- `length: 128`：兩邊算法完全一樣。
- `length: 64`：平常結果一樣，但 IV 的後 64 bit 剛好接近全 `FF` 時，WebCrypto 會繞回 0、Node 會進位到前 64 bit，從那個 block 開始解出亂碼。隨機 IV 碰上的機率極低，但沒有理由留著這個坑。

---

## 6 效能實測對比

```js
// encBuf / meta 來自上面的 API。量「整檔都用 AES-CTR 解」與「只解檔頭」的差距
async function bench(encBuf, meta) {
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(meta.keyHex), 'AES-CTR', false, ['decrypt']
  );
  const counter = hexToBytes(meta.ivHex);

  let t0 = performance.now();
  await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 128 }, key, encBuf);
  let t1 = performance.now();
  console.log('全檔 AES-CTR:', (t1 - t0).toFixed(2), 'ms');

  const head = new Uint8Array(encBuf, 0, meta.headerLen);
  const N = 500;   // 檔頭只要幾微秒，單次量不準，跑很多次取平均
  t0 = performance.now();
  for (let i = 0; i < N; i++) {
    await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 128 }, key, head);
  }
  t1 = performance.now();
  console.log('檔頭 AES-CTR:', ((t1 - t0) / N).toFixed(4), 'ms');
}
```

> 瀏覽器的 `performance.now()` 預設只精確到 0.1 ms 左右（防範計時攻擊），量微秒級的東西要跑很多次再平均。

M2 + Edge 157 實測（5MB 檔案）：

| 方案 | 耗時 |
|------|------|
| 全檔 AES-CTR（WebCrypto） | ~2.6 ms |
| 檔頭 AES-CTR（WebCrypto，約 1.7KB） | < 0.01 ms |

**用 WebCrypto 時，全檔也只要 2–3 ms**：一頁 20 張 5MB 的圖，全檔解密約 50 ms，而且不在主執行緒上跑。
檔頭加密的效能優勢，在解密必須用 JS / WASM 軟體實作時才明顯（WASM 全檔 ~54 ms，檔頭 ~0.02 ms）。

---

## 7 加固技巧：讓加密範圍帶點隨機

固定規則的加密範圍有個弱點：對手知道「加密到哪裡為止」，可以針對那個位置寫一支通用的還原腳本。
讓範圍帶一點隨機（長度多加一段亂數，或分成好幾段），能讓通用腳本失效、逼對手逐張分析。

要先說清楚：這是**增加工作量，不是密碼學上的提升**。加密過的 byte 看起來像亂數，對手多看幾張就能分辨哪裡被加密了。

### 7.1 後端

```js
const { computeHeaderLen } = require('../lib/crypto-util');

function encryptRandomSegment(buf) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);

  // 起點固定是 0：檔頭一定要蓋到。長度在必要範圍之外，再隨機多 0–2KB
  const offset = 0;
  const length = Math.min(buf.length, computeHeaderLen(buf) + crypto.randomInt(0, 2048));

  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const seg = buf.subarray(offset, offset + length);
  const encSeg = Buffer.concat([cipher.update(seg), cipher.final()]);

  const out = Buffer.from(buf);
  encSeg.copy(out, offset);

  return {
    encrypted: out,
    meta: { keyHex: key.toString('hex'), ivHex: iv.toString('hex'), offset, length }
  };
}
```

### 7.2 前端對應修改：把 offset / length 從 meta 拿

```js
const headerEnc = fullEnc.subarray(meta.offset, meta.offset + meta.length);
// ... 解密後再 copy 回去
```

> 更激進的做法：分散成多個 segment。同一把 key 加密多段時，**每段一定要用不同的 IV**，否則兩段的 keystream 相同，XOR 起來就互相洩漏。詳見作業 3。

---

## 8 何時該選「全檔」vs「檔頭」?

| 條件 | 全檔加密 | 檔頭加密 |
|------|---------|---------|
| 解密用 WebCrypto | ✅ 只要幾 ms | ✅ |
| 解密必須用 JS / WASM 軟體實作、一頁多圖 | △ 每 5MB 幾十 ms | ✅ |
| 內容本身機密（合約、證件） | ✅ | ❌ 其餘 byte 是明文 |
| 想擋不會寫程式的人和一般爬蟲 | ✅ | ✅ |
| 對手會寫程式、願意逐張分析 | ✅（前提是拿不到 key） | △ 可能猜出或重建檔頭 |
| 對手拿得到 key | ❌（不管哪種都擋不住） | ❌ |

一般的防爬需求，檔頭加密夠用；內容本身機密，就整檔加密。

---

## 9 一個容易忽略的安全考量：cache

CDN / Service Worker / 瀏覽器都會快取 `.enc` 檔。這件事要分兩半看：

- **密文可以放心快取**：沒有 key 的 `.enc` 只是一堆 byte，放 CDN 反而省流量——這是「先加密再發送」的好處之一。
- **key 不能被快取**：key 的回應要加 `Cache-Control: no-store`，免得留在瀏覽器或中間代理的快取裡。

換 key 時要知道：**已經拿過 key 的人，手上那份舊 key + 舊密文永遠解得開**，伺服器收不回來。換 key 只能保護之後的內容：

1. **重新產生 key、重新加密**，並換一個 URL（例如 `?v=新版本`），讓舊快取不再被使用。
2. **舊 key 從資料庫刪掉**，之後就不會再發出去。
3. 真正機密、不希望留在任何快取裡的內容，連密文也加 `Cache-Control: no-store`（代價是不能用 CDN）。

---

## 10 動手作業

1. 改寫 `computeHeaderLen`：檔案小於 100KB 時整檔加密（小圖全加密也不貴），其他照原規則。
2. 把第 5 節的前端改成用 fetch 的 `ReadableStream`：收到前 `headerLen` byte 就先解密，其餘 chunk 原樣收集。想想看：最後交給瀏覽器解碼時，還需要整個檔案嗎？這樣做省下了什麼？
3. 把第 7 節擴充成「3 個 segment」：第一段一定從 0 開始、蓋過 `computeHeaderLen`，另外兩段各 256–512 byte，隨機分散在後面 8KB 內。修改前後端與 meta。

> 作業 3 的 meta 格式建議（同一把 key、每段不同 IV）：

```json
{
  "keyHex": "...",
  "segments": [
    { "offset": 0, "length": 1731, "ivHex": "..." },
    { "offset": 3500, "length": 380, "ivHex": "..." },
    { "offset": 8200, "length": 420, "ivHex": "..." }
  ]
}
```

---

## 11 本章重點回顧

- 「只加密檔頭」用安全度換計算量：只處理幾 KB，但其餘 byte 是明文。
- 加密範圍要以「解碼器需要的表格」為準：JPEG 到 SOS 結束、PNG 到 IDAT 開頭，再多加密 1KB。固定的「前 1024 byte」碰到 Exif 大的照片會被直接繞過。
- 推薦演算法：**AES-256-CTR**（不改長度、支援部分解密）；WebCrypto 端用 `length: 128` 才跟 Node 一致。
- 用 WebCrypto 時全檔也只要幾 ms；檔頭加密的效能優勢在 JS / WASM 軟體解密時才明顯。
- 密文可以快取，key 不行；已經發出去的 key 收不回來。

---

**下一章**：[04-aes-with-webcrypto.md](./04-aes-with-webcrypto.md) — 深入 WebCrypto API，把 AES 玩透
