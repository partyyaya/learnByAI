# 第 02 章：XOR 全檔加密——最簡單的可上線方案

> **學習目標**：完整實作 XOR 加密的前後端，理解其數學原理、安全邊界與效能特性。
> **預計時數**：120 分鐘
> **先備知識**：[第 01 章](./01-image-format-and-magic-number.md)、Express 基礎

> **本章對應專案**
>
> | 檔案 | 用途 |
> |------|------|
> | [`backend/lib/xor.js`](./backend/lib/xor.js) | XOR 工具函式 |
> | [`backend/examples/ch02-xor-server.js`](./backend/examples/ch02-xor-server.js) | 本章 demo server |
> | [`frontend/examples/ch02-xor.html`](./frontend/examples/ch02-xor.html) | 前端上傳 + 解密頁 |
>
> 啟動：`cd backend && npm install && npm run ch02`，打開 `http://localhost:3000/examples/ch02-xor.html`。

---

## 1 為什麼從 XOR 開始？

XOR（互斥或）是密碼學裡最簡單的對稱運算。雖然強度遠不如 AES，但它有 3 個無法取代的優點：

1. **演算法 5 行寫完** — 適合學習
2. **效能極好** — 一個 CPU 指令就能完成
3. **可以分塊並行** — 容易搬到 WASM、Worker、GPU

更重要的是：不少網站的「圖片加密」其實就是 XOR 或它的變形。
學完這章，你看到這類方案就知道怎麼拆，也清楚它的極限在哪。

---

## 2 XOR 數學速覽

```text
A XOR B XOR B = A
```

對任何 byte `a` 和 key `k`：

```text
encrypted = a ^ k
plaintext = encrypted ^ k    // 同一個 k 還原
```

**這就是為什麼加密與解密邏輯完全一樣**。

### 真值表

| A | B | A XOR B |
|---|---|---------|
| 0 | 0 | 0 |
| 0 | 1 | 1 |
| 1 | 0 | 1 |
| 1 | 1 | 0 |

---

## 3 三種 XOR 變體

| 變體 | Key 形式 | 安全度 | 場景 |
|------|---------|--------|------|
| 單 byte XOR | `0x5A` | 極弱（256 次窮舉） | demo / 學習 |
| 多 byte 循環 XOR | `[0x5A, 0x11, 0xAB, ...]` | 弱（知道一段明文或做頻率分析就能破） | 一般圖片防爬 |
| 流式 XOR（PRNG 產 key） | 由 seed 產生 keystream | 弱（簡單 PRNG 可預測，見第 8 節） | 比循環 key 多一道手續 |

本章用第二種（多 byte 循環）作主力。

---

## 4 後端：完整 Express 服務

我們要做的後端有 3 個功能：

1. 上傳原圖 → 加密存檔
2. 提供加密後的 `.enc` 檔下載
3. 驗證 token 後返回 key

### 4.1 專案結構（已在 [`backend/`](./backend/) 建好）

```text
backend/
├── package.json
├── lib/
│   └── xor.js                       ← 加密工具
├── examples/
│   └── ch02-xor-server.js           ← 本章 server（npm run ch02 跑這個）
└── data/encrypted/ch02/             ← 啟動後自動建立
```

### 4.2 安裝

```bash
cd backend
npm install
```

### 4.3 `backend/lib/xor.js`

```js
// lib/xor.js
'use strict';

const crypto = require('crypto');

/**
 * 對整個 buffer 做循環 XOR
 * @param {Buffer | Uint8Array} buf 原始資料
 * @param {Uint8Array} key 任意長度的 key（建議 16–32 byte）
 * @returns {Buffer}
 */
function xorBuffer(buf, key) {
  const out = Buffer.alloc(buf.length);
  const kl = key.length;
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key[i % kl];
  }
  return out;
}

/**
 * 產生隨機 key：一定要用密碼學等級的亂數
 */
function randomKey(byteLen = 32) {
  return crypto.randomBytes(byteLen);
}

module.exports = { xorBuffer, randomKey };
```

> 不要用 `Math.random()` 產生 key：它的內部狀態只有 128 bit，連續觀察幾個輸出就能推回狀態、算出之後所有的值。Node 用 `crypto.randomBytes()`，瀏覽器用 `crypto.getRandomValues()`。

### 4.4 `backend/examples/ch02-xor-server.js`

下面就是 [`backend/examples/ch02-xor-server.js`](./backend/examples/ch02-xor-server.js) 的全文。meta 存在 `data/encrypted/ch02/_meta.json`，每章的資料各自分開。

```js
// 對應章節：Chapter 02 - XOR 全檔加密 demo
//
// 跑起來後，前端打開 http://localhost:3000/examples/ch02-xor.html
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { xorBuffer, randomKey } = require('../lib/xor');

// 每章的資料各自放一個資料夾，互不干擾
const ENC_DIR = path.join(__dirname, '..', 'data', 'encrypted', 'ch02');
fs.mkdirSync(ENC_DIR, { recursive: true });

const META_FILE = path.join(ENC_DIR, '_meta.json');
const load = () => (fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {});
const save = (d) => fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));

// id 只接受 UUID：Express 會把 %2F 解碼成 /，不檢查的話 ..%2F 能讀到資料夾外的檔案
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(cors());

// 前端頁面由這裡一起服務，不用另外起伺服器
const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));

const upload = multer({ storage: multer.memoryStorage() });

// === 路由 1：上傳並加密 ===
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const key = randomKey(32);
  const enc = xorBuffer(req.file.buffer, key);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), enc);

  // 把這張圖的「描述資訊」記到 meta 裡，給後續的 key API 用
  const meta = load();
  meta[id] = {
    id,                           // 跟 .enc 檔名一致，前端用它對應到密文檔
    mime: req.file.mimetype,      // 原圖的 MIME，前端解密後要靠它建 Blob
    size: req.file.size,          // 原圖大小（byte），給 debug / 前端顯示用
    keyHex: key.toString('hex'),  // ⚠️ 這張圖的 XOR key
                                  // demo 直接存明文很方便，正式環境不能這樣：
                                  //   1) 資料庫外洩 = 所有圖一次解密
                                  //   2) 應該用 master key 包裝後再存（第 04 章的 wrapKey）
                                  //   3) 或交給 KMS / Vault，程式只拿 reference
    createdAt: Date.now(),        // 建立時間（毫秒），用來做過期、排序、稽核
  };
  save(meta);
  // demo 簡化成「整檔重寫 JSON」，圖很多時應換成資料庫（見 backend/db.js）

  res.json({ id, size: req.file.size });
});

// === 路由 2：取得加密圖檔 ===
app.get('/api/image/:id.enc', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  // 用 octet-stream 並關閉嗅探：這是「告訴瀏覽器別當圖片處理」，真正的保護來自 byte 已經被 XOR
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

// === 路由 3：取 key（簡化：只檢查有沒有 Bearer token）===
app.get('/api/image/:id/key', (req, res) => {
  // 真實系統：從 Authorization 拆出 JWT、驗證簽章、確認這個人有權看這張圖（第 07 章）
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const m = load()[req.params.id];
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.json({ keyHex: m.keyHex, mime: m.mime, size: m.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Ch02 XOR] http://localhost:${PORT}/examples/ch02-xor.html`);
});
```

### 4.5 測試後端

```bash
# 啟動（從 backend/ 目錄）
npm run ch02

# 上傳
curl -F "image=@sample/sample.jpg" http://localhost:3000/api/upload
# → { "id": "xxx-xxx-xxx", "size": 234567 }

# 直接拉加密檔（會是壞圖）
curl http://localhost:3000/api/image/xxx-xxx-xxx.enc -o test.enc

# 取 key
curl -H "Authorization: Bearer dummy-token" \
  http://localhost:3000/api/image/xxx-xxx-xxx/key
# → { "keyHex": "...", "mime": "image/jpeg", "size": 234567 }
```

---

## 5 前端：純 HTML + 原生 JS

對應檔案：[`frontend/examples/ch02-xor.html`](./frontend/examples/ch02-xor.html)。
**前端不需要另外起伺服器**——後端的 `express.static` 已經把 `frontend/` 整個 serve 出去。直接打開 `http://localhost:3000/examples/ch02-xor.html`。

### 5.1 `frontend/examples/ch02-xor.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>XOR 圖片解密 demo</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 2em auto; }
    img { max-width: 100%; border: 1px solid #ccc; margin: .5em 0; }
    section { margin-bottom: 2em; }
    code { background: #f5f5f5; padding: 2px 4px; }
  </style>
</head>
<body>
  <h1>XOR 圖片加密 demo</h1>

  <section>
    <h2>1. 上傳一張圖</h2>
    <input type="file" id="upload" accept="image/*">
    <div id="uploadResult"></div>
  </section>

  <section>
    <h2>2. 直接顯示密文（瀏覽器當圖片載入）</h2>
    <p>會破圖，因為 byte 已亂。</p>
    <img id="rawImg" alt="raw">
  </section>

  <section>
    <h2>3. 解密後顯示</h2>
    <img id="decImg" alt="dec">
  </section>

  <script src="./decrypt.js"></script>
</body>
</html>
```

### 5.2 解密邏輯（在 HTML 內 `<script>` 區塊）

專案版本把 JS 直接寫在 HTML 裡，少一個檔案。這裡抽出來看比較清楚：

```js
// 等同於 ch02-xor.html 的 <script> 區塊
'use strict';

const TOKEN = 'dummy-token';  // 真實系統由登入流程取得

document.getElementById('upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // 1. 上傳
  const fd = new FormData();
  fd.append('image', file);
  const { id } = await fetch('/api/upload', { method: 'POST', body: fd })
    .then(r => r.json());

  document.getElementById('uploadResult').textContent = `已上傳，id=${id}`;
  document.getElementById('rawImg').src = `/api/image/${id}.enc`;

  // 2. 拿 key + 加密內容
  const [meta, encBuf] = await Promise.all([
    fetch(`/api/image/${id}/key`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    }).then(r => r.json()),
    fetch(`/api/image/${id}.enc`).then(r => r.arrayBuffer())
  ]);

  // 3. XOR 解密
  const key = hexToBytes(meta.keyHex);
  const enc = new Uint8Array(encBuf);
  const dec = xorBytes(enc, key);

  // 4. 包成 Blob 顯示
  const blob = new Blob([dec], { type: meta.mime });
  const url = URL.createObjectURL(blob);
  const img = document.getElementById('decImg');
  img.src = url;
  img.onload = () => URL.revokeObjectURL(url);
});

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function xorBytes(buf, key) {
  const out = new Uint8Array(buf.length);
  const kLen = key.length;
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key[i % kLen];
  }
  return out;
}
```

打開 `http://localhost:3000/examples/ch02-xor.html`，丟一張圖：
- 「直接顯示密文」會破圖
- 「解密後顯示」會看到原圖

---

## 6 效能實測：JS XOR 的極限

我們關心：**這個方案能撐多大的圖？**

放一個 benchmark 在前端：

```js
// benchmark.js
async function bench() {
  // 模擬不同大小
  for (const sizeMB of [0.5, 1, 5, 10, 20]) {
    const bytes = randomBytes(sizeMB * 1024 * 1024);
    const key = randomBytes(32);

    const t0 = performance.now();
    xorBytes(bytes, key);
    const t1 = performance.now();
    console.log(`${sizeMB}MB: ${(t1 - t0).toFixed(1)} ms (${(sizeMB / (t1 - t0) * 1000).toFixed(0)} MB/s)`);
  }
}

// crypto.getRandomValues() 一次最多只能填 65,536 byte，超過會丟 QuotaExceededError，要分段填
function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
  }
  return out;
}
```

在 Apple M2 + Edge 157（Chromium）上實測（取中位數）：

| 圖片大小 | 上面的 `xorBytes` | 吞吐 |
|---------|-----------------|------|
| 1 MB | ~1.7 ms | ~590 MB/s |
| 5 MB | ~9.3 ms | ~540 MB/s |
| 10 MB | ~17 ms | ~575 MB/s |
| 20 MB | ~36 ms | ~555 MB/s |

> 在 60 fps 的瀏覽器裡，**16ms 是一幀的預算**。10MB 以上的圖，或一次解很多張，就會占掉好幾幀，畫面卡頓。
> 手機 CPU 慢上好幾倍，門檻會更低。

兩個便宜的改法：

1. **一次處理 4 byte**：`i % kLen` 的除法是迴圈裡最貴的部分。key 長度是 4 的倍數時，用 `Uint32Array` 一次 XOR 4 byte、用 `& 7` 取代 `% 32`，同一台機器上 5MB 只要 ~1.5 ms。
2. **搬到 Web Worker**：解密不在主執行緒做，就不會卡畫面。解完用 `postMessage(buf, [buf.buffer])` 把結果「轉移」回主執行緒，不用複製。

```js
// 一次處理 4 byte（key 長度須為 4 的倍數，例如 32）
function xorBytes32(buf, key) {
  const out = new Uint8Array(buf.length);
  const n = buf.length >> 2;
  const b = new Uint32Array(buf.buffer, buf.byteOffset, n);   // buf.byteOffset 要是 4 的倍數
  const o = new Uint32Array(out.buffer, 0, n);
  const k = new Uint32Array(key.buffer, key.byteOffset, key.length >> 2);
  const mask = k.length - 1;                                   // key 32 byte → 8 個 uint32 → mask 7
  for (let i = 0; i < n; i++) o[i] = b[i] ^ k[i & mask];
  for (let i = n << 2; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];  // 尾巴不足 4 byte
  return out;
}
```

---

## 7 安全分析：XOR 真實強度

我必須誠實告訴你：**XOR 在密碼學上等同沒加密**（如果對手知道明文長什麼樣）。

### 攻擊 1：known-plaintext attack

對手知道「這是 JPEG」，所以前 3 byte 一定是 `FF D8 FF`，第 4 byte 通常是 `E0`（JFIF）或 `E1`（Exif）。

```text
key[0..4] = enc[0..4] XOR (FF D8 FF E0)
```

key 的前 4 byte 直接洩漏。如果 key 是 32 byte，循環使用，攻擊者只要知道任意連續 32 byte 的明文就能還原 key。

### 攻擊 2：頻率分析

JPEG 內部有大量 padding 與 `0x00`，對手可用統計分析推測 key。

### 結論：XOR 適合對抗什麼？

- ✅ 阻擋「右鍵另存」「Network 直接抓圖」（Level 0、1 對手）
- ✅ 阻擋無腦爬蟲（不會解密的人 100% 過不了）
- ❌ 無法阻擋「會逆向 JS 的人」（不到 1 小時就破）

如果你的對手是 Level 2 以上，請進入下一章的 AES。

---

## 8 改進 XOR 的小撇步

雖然 XOR 本質弱，但可以做幾個小強化：

### 改進 1：用 PRNG 產生長 keystream

不直接循環使用 key，而是用 key 作 seed 產生與檔案等長的 keystream。概念是這樣，但**亂數產生器選錯，等於沒改進**。
最常見的反例是教科書上的線性同餘產生器（LCG）：

```js
// ❌ 反例：LCG 不能拿來產生 keystream
function* keystream(seed) {
  let s = seed;
  while (true) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF;   // 用 Math.imul 做 32 bit 整數乘法
    yield s & 0xFF;
  }
}
```

這段有兩個問題：

- **可預測**：seed 只有 31 bit，對手用 JPEG 固定的開頭（已知明文）就能暴力找回 seed，之後整條 keystream 都算得出來。
- **週期很短**：模數是 2 的次方時，低 8 bit 每 256 個輸出就重複一次——等於一把 256 byte 的循環 key。

順帶一提，如果把 `Math.imul(s, 1103515245)` 寫成 `s * 1103515245`，乘積最大約 2^61，超過 JS 數字（double）能精確表示的 2^53，算出來的就不是 LCG；之後搬到 Rust / WASM 時，兩邊的 keystream 會對不起來。

真的要「由 key 產生 keystream」，直接用 **AES-CTR**（第 03 章）或 ChaCha20：它們就是設計來做這件事的 stream cipher。

### 改進 2：每張圖獨立 key

不要全站共用 key，每張圖上傳時 `randomKey()` 一份，這樣破解單張不影響其他。

### 改進 3：Key 拆分

key 一半從伺服器拿、一半從 URL 拿、再用 HMAC 合成。對手必須同時拿到兩半。

> 兩半最後都會出現在瀏覽器裡，這只是讓對手多一道手續，不是真正的保護。

### 改進 4：把解密邏輯搬到 WASM

純 JS 一設斷點就看懂流程；搬到 WASM 後要讀 wasm 指令才看得懂。但如果 key 是以明文從 API 拿到的，對手根本不需要看懂流程——詳見 [第 06 章](./06-wasm-decryption-in-browser.md)。

---

## 9 動手作業

1. 把 4.4 的伺服器補上：上傳時自動產生 `keyId`，key 存到記憶體 Map 而不是檔案，重啟就失效。
2. 把前端 5.2 重構成支援「批量解密 10 張圖」，並用 `performance.now()` 印出每張耗時。
3. 嘗試對自己加密的檔案做 known-plaintext 攻擊：
   - 假設你知道是 JPEG，前 4 byte 是 `FF D8 FF E0`
   - 從 `.enc` 算出 key 前 4 byte
   - 看能不能解出更多內容

---

## 10 本章重點回顧

- XOR 是 `a ^ k ^ k = a`，加密解密用同一個函式。
- 三種變體：單 byte、循環、流式。本章示範「循環 + 32 byte key」；簡單 PRNG 的流式 XOR 並不比它安全。
- key 要用 `crypto.randomBytes()` / `crypto.getRandomValues()` 產生，不能用 `Math.random()`。
- 純 JS XOR 在 M2 上約 550 MB/s，10MB 以上或一次解多張會卡幀；改成一次處理 4 byte、或搬到 Worker 都能解決。
- **XOR 不是真正安全**，只能擋 Level 0–1 對手，真要強加密用 AES。
- 強化方向：每圖獨立 key、改用 AES-CTR 產生 keystream、搬到 WASM（前提是 key 不以明文經過 JS）。

---

**下一章**：[03-header-scramble.md](./03-header-scramble.md) — 只加密前 N byte，效能與安全的最佳平衡
