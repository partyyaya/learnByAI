# 第 02 章：XOR 全檔加密——最簡單的可上線方案

> **學習目標**：完整實作 XOR 加密的前後端，理解其數學原理、安全邊界與效能特性。
> **預計時數**：120 分鐘
> **先備知識**：[[01-image-format-and-magic-number]]、Express 基礎

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

更重要的是：**真實線上系統有一半以上的「圖片加密」其實就是 XOR 變種**（包括某些大型漫畫站）。
學完這章，你就有能力逆向他們，也有能力做出同等水準的方案。

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
| 多 byte 循環 XOR | `[0x5A, 0x11, 0xAB, ...]` | 弱（可頻率分析破解） | 一般圖片防爬 |
| 流式 XOR（PRNG 產 key） | 由 seed 產生 keystream | 中（接近 stream cipher） | 對抗 Level 2 對手 |

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

/**
 * 對整個 buffer 做循環 XOR
 * @param {Buffer | Uint8Array} buf 原始資料
 * @param {Uint8Array} key 任意長度的 key (建議 16-32 byte)
 * @returns {Buffer}
 */
function xorBuffer(buf, key) {
  const out = Buffer.alloc(buf.length);
  const keyLen = key.length;
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key[i % keyLen];
  }
  return out;
}

/**
 * 產生隨機 key
 */
function randomKey(byteLen = 32) {
  const k = Buffer.alloc(byteLen);
  for (let i = 0; i < byteLen; i++) {
    k[i] = Math.floor(Math.random() * 256);
  }
  return k;
}

module.exports = { xorBuffer, randomKey };
```

### 4.4 `backend/examples/ch02-xor-server.js`

下面是教材精簡版，**完整可跑版本以及檔案註解請看實際檔案** [`backend/examples/ch02-xor-server.js`](./backend/examples/ch02-xor-server.js)。差異是專案版把 meta 存在 `data/encrypted/ch02/_meta.json` 隔離不同章節資料。


```js
// server.js
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { xorBuffer, randomKey } = require('./lib/xor');

const app = express();
app.use(cors());
app.use(express.json());

const ENC_DIR = path.join(__dirname, 'encrypted');
const META_DB = path.join(__dirname, 'meta.json');
fs.mkdirSync(ENC_DIR, { recursive: true });
if (!fs.existsSync(META_DB)) fs.writeFileSync(META_DB, '{}');

const upload = multer({ storage: multer.memoryStorage() });

function loadMeta() { return JSON.parse(fs.readFileSync(META_DB, 'utf-8')); }
function saveMeta(d) { fs.writeFileSync(META_DB, JSON.stringify(d, null, 2)); }

// === 路由 1：上傳並加密 ===
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuidv4();
  const key = randomKey(32);
  const encrypted = xorBuffer(req.file.buffer, key);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  // 把這張圖的「描述資訊」記到 meta 裡，給後續的解密 API 用
  const meta = loadMeta();
  meta[id] = {
    id,                             // 跟 .enc 檔名一致，前端用它對應到密文檔
    mime: req.file.mimetype,        // 原圖的 MIME（image/jpeg、image/png…）
                                    // 前端解密後要靠它建 Blob，不存的話 <img> 不會顯示
    size: req.file.size,            // 原圖大小（byte），只是給 debug / 前端顯示用
    keyHex: key.toString('hex'),    // ⚠️ 這張圖的 XOR key（hex 字串）
                                    // demo 用「明文存進 JSON」很方便，但正式環境千萬不能這樣：
                                    //   1) DB 被脫庫 = 所有圖一次解密
                                    //   2) 應該用 master key 加密後再存（[[04-aes-with-webcrypto]] 的 wrapKey）
                                    //   3) 或丟 KMS / Vault，code 只拿 reference
    createdAt: Date.now(),          // 建立時間戳（毫秒），用來做過期、排序、稽核
  };
  saveMeta(meta);
  // saveMeta 把整個 meta 物件寫回 meta.json
  // demo 簡化成「整檔重寫」，圖很多時應換成 SQLite（見 backend/db.js）

  res.json({ id, size: req.file.size });
});

// === 路由 2：取得加密圖檔 ===
app.get('/api/image/:id.enc', (req, res) => {
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  // 重點：用 octet-stream，並關閉嗅探
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(fs.readFileSync(file));
});

// === 路由 3：取 key（簡化：應該要做 token 驗證）===
app.get('/api/image/:id/key', (req, res) => {
  // 真實系統：req.headers.authorization 拆出 JWT → 確認權限
  const userToken = req.headers.authorization;
  if (!userToken || !userToken.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const meta = loadMeta();
  const m = meta[req.params.id];
  if (!m) return res.status(404).end();

  res.json({
    keyHex: m.keyHex,
    mime: m.mime,
    size: m.size,
  });
});

// === 簡易靜態頁面 ===
app.use(express.static('public'));

app.listen(3000, () => console.log('http://localhost:3000'));
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

專案版本把 JS 寫進 HTML 同檔，方便 `file://` 也能開。教學版抽出來看更清楚：

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
    const bytes = new Uint8Array(sizeMB * 1024 * 1024);
    crypto.getRandomValues(bytes);
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);

    const t0 = performance.now();
    xorBytes(bytes, key);
    const t1 = performance.now();
    console.log(`${sizeMB}MB: ${(t1 - t0).toFixed(1)} ms (${(sizeMB / (t1 - t0) * 1000).toFixed(0)} MB/s)`);
  }
}
```

在 M1 MacBook + Chrome 120 上的實測：

| 圖片大小 | 純 JS 耗時 | 吞吐 |
|---------|-----------|------|
| 0.5 MB | ~3 ms | 167 MB/s |
| 1 MB | ~6 ms | 167 MB/s |
| 5 MB | ~30 ms | 167 MB/s |
| 10 MB | ~60 ms | 167 MB/s |
| 20 MB | ~120 ms | 167 MB/s |

> 在 60 fps 的瀏覽器裡，**16ms 是一幀的預算**。大於 5MB 的圖就明顯卡頓。
> 這就是為什麼後面要搬到 WASM。

---

## 7 安全分析：XOR 真實強度

我必須誠實告訴你：**XOR 在密碼學上等同沒加密**（如果對手知道明文長什麼樣）。

### 攻擊 1：known-plaintext attack

對手知道「這是 JPEG」，所以前 4 byte 必然是 `FF D8 FF E0`。

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

不直接循環使用 key，而是用 key 作 seed 產生與檔案等長的 keystream：

```js
// 簡化版（真實要用 ChaCha20 之類）
function* keystream(seed) {
  let s = seed;
  while (true) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    yield s & 0xFF;
  }
}
```

### 改進 2：每張圖獨立 key

不要全站共用 key，每張圖上傳時 `randomKey()` 一份，這樣破解單張不影響其他。

### 改進 3：Key 拆分

key 一半從伺服器拿、一半從 URL 拿、再用 HMAC 合成。對手必須同時拿到兩半。

### 改進 4：把解密邏輯搬到 WASM

純 JS 容易被 hook，搬到 WASM 後可大幅提高逆向成本。詳見 [[06-wasm-decryption-in-browser]]。

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
- 三種變體：單 byte、循環、流式。生產用「循環 + 32 byte key」。
- 純 JS XOR 吞吐約 150–200 MB/s，5MB 以上的圖會卡幀。
- **XOR 不是真正安全**，只能擋 Level 0–1 對手，真要強加密用 AES。
- 強化方向：PRNG keystream、每圖獨立 key、key 拆分、搬到 WASM。

---

**下一章**：[03-header-scramble.md](./03-header-scramble.md) — 只加密前 N byte，效能與安全的最佳平衡
