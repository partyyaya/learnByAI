# 第 04 章：AES + WebCrypto API 深入

> **學習目標**：搞懂 AES 各種 mode 的差異、IV/Nonce/Counter 的角色，用 WebCrypto 做出正確的加解密，並理解 Key 管理的最佳實踐。
> **預計時數**：150 分鐘
> **先備知識**：[第 03 章](./03-header-scramble.md)、密碼學基本概念（block cipher、symmetric key）

> **本章對應專案**
>
> | 檔案 | 用途 |
> |------|------|
> | [`backend/lib/aes-gcm.js`](./backend/lib/aes-gcm.js) | 全檔 AES-256-GCM 加解密 |
> | [`backend/lib/crypto-util.js`](./backend/lib/crypto-util.js) | `deriveKey / wrapKey / unwrapKey / hmacSign / hmacVerify` |
> | [`backend/examples/ch04-aes-server.js`](./backend/examples/ch04-aes-server.js) | 本章 demo server（簽名 URL + key wrap） |
> | [`frontend/examples/ch04-aes.html`](./frontend/examples/ch04-aes.html) | 前端 AES-GCM 解密頁 |
>
> 啟動：
> ```bash
> cd backend
> MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
>   npm run ch04
> ```
> 打開 `http://localhost:3000/examples/ch04-aes.html`。

---

## 1 為什麼一定要會 AES？

XOR 這類做法對 Level 2 對手無效，正規的對稱加密選擇就是 AES。它的特點：

- **128 / 192 / 256 bit key**，三種長度目前都沒有實用的破解方法；選 256 主要是多留安全餘裕。
- **每個瀏覽器原生支援**（WebCrypto），不需要載額外 lib。
- **硬體加速**：現代 CPU 有 AES 專用指令（x86 的 AES-NI、ARM 的 AES 擴充），吞吐達 GB/s。

不用 AES 等於把保險箱換成抽屜。

---

## 2 AES Mode 全景

AES 是 **block cipher**：一次處理 16 byte。但圖片有幾 MB，必須把多個 block 串起來——這就是 mode 的角色。

```text
┌──────────┐  ┌──────────┐  ┌──────────┐
│ block 1  │  │ block 2  │  │ block 3  │  ...
│ (16B)    │  │ (16B)    │  │ (16B)    │
└──────────┘  └──────────┘  └──────────┘
     │             │             │
     ▼             ▼             ▼
   [Mode 決定 block 之間怎麼串連]
```

### 常見 mode 表

| Mode | 全名 | 是否需要 IV | 是否並行 | 是否驗證完整性 | 用途 |
|------|------|------------|---------|--------------|------|
| ECB | Electronic Codebook | ❌ | ✅ | ❌ | **絕對不要用** |
| CBC | Cipher Block Chaining | ✅ | 加密 ❌（序列依賴）／解密 ✅ | ❌ | 一般檔案加密 |
| CTR | Counter | ✅（叫 nonce） | ✅ | ❌ | 串流、部分解密 |
| GCM | Galois/Counter | ✅ | ✅ | ✅ | 預設首選 |

### 為什麼 ECB 不能用？

```text
未壓縮的點陣圖（相同色塊 → 相同明文 block）
┌──■■■■──┐         ┌──XXXX──┐
│  ■■■■  │  ECB   │  XXXX  │  ← 仍能看出輪廓！
│  ■■■■  │ ────→  │  XXXX  │
└────────┘         └────────┘
```

ECB 對相同明文輸出相同密文。未壓縮的像素資料有大量重複，加密後輪廓依然清楚，Wikipedia 上的「ECB 企鵝」是經典反例。

我們加密的 JPEG / PNG 是壓縮過的，重複的 16 byte 很少，看不出輪廓；但 ECB 一樣不能用：它沒有 IV，同一把 key 加密兩張一樣的圖，密文也一模一樣，而且沒有完整性驗證。

### 本章主推：GCM 與 CTR

- **AES-GCM**：有驗證標籤（AEAD），改 1 byte 就會解密失敗 → 防竄改。**預設選它**。
- **AES-CTR**：無驗證、但支援部分解密 → 適合「只解檔頭」場景。

---

## 3 WebCrypto API 速覽

WebCrypto 是瀏覽器原生 lib，所有操作都是 async：

```js
crypto.subtle.generateKey(...)    // 產生 key
crypto.subtle.importKey(...)      // 從 raw / JWK 載入 key
crypto.subtle.exportKey(...)      // 匯出 key
crypto.subtle.encrypt(...)        // 加密
crypto.subtle.decrypt(...)        // 解密
crypto.subtle.digest(...)         // hash
crypto.subtle.sign / verify       // 簽章
crypto.getRandomValues(...)       // 取得密碼學等級隨機數（一次最多 65,536 byte）
```

> 注意：`crypto.subtle` 只在 **HTTPS 或 localhost** 可用。本機開發用 `http://localhost` 沒問題，但 `http://192.168.x.x` 會是 `undefined`。

---

## 4 從零做一個 AES-GCM 加解密

### 4.1 後端加密（Node.js）

對應 [`backend/lib/aes-gcm.js`](./backend/lib/aes-gcm.js)：

```js
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
```

### 4.2 對應的前端解密

對應 [`frontend/examples/ch04-aes.html`](./frontend/examples/ch04-aes.html) 內的 `decryptGcm`：

```js
// 檔案格式：[iv(12) | ciphertext | tag(16)]
async function decryptGcm(combinedBuf, keyHex) {
  const u8 = new Uint8Array(combinedBuf);
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: u8.subarray(0, 12), tagLength: 128 },
    key,
    u8.subarray(12)          // 「密文 + tag」正好連在一起，直接傳 view，不用複製
  );

  return new Uint8Array(plain);
}
```

> 容易踩的坑：Node.js 的 `getAuthTag()` 把 tag 分開回傳，WebCrypto 則要求 tag 接在密文尾端。
> 所以後端存檔時就把 tag 放在最後；如果放在 iv 和密文中間，前端就得另外配置一塊記憶體、把 5MB 的密文複製過去重新拼接。

### 4.3 完整流程驗證

把 [第 03 章](./03-header-scramble.md) 的 server 換成這個 AES-GCM 全檔版，前端拿到檔案後切出 iv 就能解密，得到原圖。

---

## 5 IV / Nonce 的正確使用

**IV 重用是最常見的災難。** 如果用同一個 key + 同一個 IV 加密兩個不同明文，整個系統會崩。

### 規則

1. **同一把 key 底下，IV 絕不能重複**。
2. IV 怎麼產生都可以，重點是不重複：
   - **隨機 12 byte**（`crypto.randomBytes(12)` / `crypto.getRandomValues()`）：最簡單。同一把 key 加密不超過約 2^32 次就安全；本課程每張圖一把 key，遠低於這個數字。
   - **計數器**：NIST SP 800-38D 推薦的做法就是「固定欄位 + 遞增計數器」。前提是計數器不會遺失或倒退（例如服務重啟後從 0 開始就完蛋了）。
3. **IV 不是秘密**，跟密文放在一起傳即可。

### 為什麼 GCM 重用 IV 等於沒加密？

GCM 內部用 `IV || counter` 產生 keystream。同 key 同 IV → 同 keystream → 對手把兩段密文 XOR，keystream 就消掉了，拿到「明文 1 XOR 明文 2」，再配合已知的檔頭就能還原內容。
更糟的是，GCM 用來驗證的那把內部 key（GHASH key）也能被算出來，對手可以偽造能通過驗證的密文。這在密碼學界叫 **nonce misuse**。

---

## 6 Key 的派發策略（重點章節！）

加密演算法只是「鎖」，**key 怎麼保管、怎麼交到使用者瀏覽器才是重點**。

### 策略 A：每張圖獨立 key

每張圖加密時隨機產生 key，存進資料庫，使用者要解時打 API 拿。

```text
DB:
  imageId → keyHex（明文）
```

- 優點：破解一張不影響其他張
- 缺點：資料庫外洩 = 所有 key 一起外洩；API 要管好權限

### 策略 B：信封加密（envelope encryption）

```text
imgKey = random()                              ← 每張圖獨立（Data Encryption Key，DEK）
encryptedImg = AES(plain, imgKey)
wrappedKey = AES-GCM(imgKey, masterKey)        ← masterKey（Key Encryption Key，KEK）只存在伺服器 / KMS

DB:
  imageId → wrappedKey
```

使用者要看一張圖：

1. 伺服器確認這個人有權限
2. **在伺服器端**用 masterKey 解開 wrappedKey，得到這張圖的 imgKey
3. 只把這一把 imgKey 交給瀏覽器，瀏覽器用它解圖

> masterKey **絕對不能**交給瀏覽器：拿到它就能解開資料庫裡所有圖片的 key。

這是 KMS（Key Management Service）的標準做法：資料庫被偷走，對方只拿到一堆包裝過的 key。用雲端 KMS 時，masterKey 放在硬體裡，連伺服器程式都碰不到原始值，只能請 KMS 代為解包。

本課程的 `wrapKey` 還把 image id 當成 GCM 的 AAD（附加驗證資料）：包好的 key 跟那張圖綁在一起，被搬到別張圖的資料列就解不開。

### 策略 C：Token 簽名 + 短效 URL

key 不寫在前端程式碼裡，每次要看圖都先跟伺服器要一個短效 URL：

```text
GET /api/image/abc123/key?u=user-1&exp=1717023600&sig=HMAC(imageId|userId|exp)
```

簽名 URL 防得住、防不住的要分清楚：

- ✅ URL 被轉貼、被記錄在 log 裡，過期後就沒用
- ✅ 對手沒有簽章用的 key，拼不出別張圖的合法 URL
- ❌ **不會讓 image key 失效**：URL 過期了，已經拿到手的 key 照樣永久有效（每張圖的 key 是固定的）
- ❌ 擋不住已登入的帳號：他隨時能再要一個新的 URL

所以簽名 URL 通常還要搭配依帳號限流、異常監控（[第 07 章](./07-canvas-rendering-and-hardening.md)）。

### 策略對比

| 策略 | 實作複雜度 | 防的是什麼 | 推薦場景 |
|------|----------|-----------|---------|
| A | 低 | 一張圖的 key 外洩，不會連帶其他張 | 所有場景的基礎 |
| B | 中 | 資料庫外洩時，key 不跟著外洩 | 正式環境一律要做 |
| C | 中 | key URL 被轉貼、被重放 | 公開站點 |

三者不是互斥的：正式系統通常 A + B + C 一起用。
但要記得：**對瀏覽器端的對手來說，三者沒有差別**——只要他有權看這張圖，最後都會拿到這張圖的 key。

本課程 [第 08 章](./08-capstone-full-system.md) 會把 A + B + C 一起實作。

---

## 7 完整伺服器：AES-GCM + Key API

整合前面的東西，以下是 [`backend/examples/ch04-aes-server.js`](./backend/examples/ch04-aes-server.js) 全文：

```js
// 對應章節：Chapter 04 - 全檔 AES-GCM + key wrap + 簽名 URL demo
//
// 跑起來後，前端打開 http://localhost:3000/examples/ch04-aes.html
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { encrypt } = require('../lib/aes-gcm');
const { deriveKey, wrapKey, unwrapKey, hmacSign, hmacVerify } = require('../lib/crypto-util');

// master key 只存在伺服器，沒設就不啟動
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || '', 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('MASTER_KEY is required: 64 hex chars（啟動方式見第 04 章）');
}
// 用途不同的 key 各自衍生，不共用同一把
const KEY_WRAP_KEY = deriveKey(MASTER_KEY, 'image-key-wrap');
const URL_SIGN_KEY = deriveKey(MASTER_KEY, 'key-url-sign');

const ENC_DIR = path.join(__dirname, '..', 'data', 'encrypted', 'ch04');
fs.mkdirSync(ENC_DIR, { recursive: true });

const META_FILE = path.join(ENC_DIR, '_meta.json');
const load = () => (fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {});
const save = (d) => fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2));

// id 只接受 UUID：Express 會把 %2F 解碼成 /，不檢查的話 ..%2F 能讀到資料夾外的檔案
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(cors());
app.use(express.json());

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND));

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = uuid();
  const { encrypted, key } = encrypt(req.file.buffer);
  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  // 策略 B：資料庫只存「包裝過的 key」，master key 永遠不離開伺服器
  const meta = load();
  meta[id] = {
    id,
    mime: req.file.mimetype,
    wrappedKey: wrapKey(key, KEY_WRAP_KEY, id),
    createdAt: Date.now(),
  };
  save(meta);

  res.json({ id });
});

// 簽名 URL：60 秒有效。demo 簡化：沒做登入，userId 固定為 'demo-user'（第 07 章補上 JWT）
app.get('/api/image/:id/sign', (req, res) => {
  const meta = load()[req.params.id];
  if (!meta) return res.status(404).end();

  const userId = 'demo-user';
  const exp = Date.now() + 60 * 1000;
  const payload = `${req.params.id}|${userId}|${exp}`;
  const sig = hmacSign(URL_SIGN_KEY, payload);

  res.json({
    keyUrl: `/api/image/${req.params.id}/key?u=${userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${req.params.id}.enc`,
  });
});

app.get('/api/image/:id/key', (req, res) => {
  const { u, exp, sig } = req.query;
  if (!u || !exp || !sig) return res.status(400).end();
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(URL_SIGN_KEY, payload, sig)) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const meta = load()[req.params.id];
  if (!meta) return res.status(404).end();

  // 在伺服器端解開包裝，只把這張圖的 key 交出去
  const key = unwrapKey(meta.wrappedKey, KEY_WRAP_KEY, req.params.id);
  res.set('Cache-Control', 'no-store');
  res.json({ keyHex: key.toString('hex'), mime: meta.mime });
});

app.get('/api/image/:id.enc', (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Ch04 AES-GCM] http://localhost:${PORT}/examples/ch04-aes.html`);
});
```

幾個重點：

- **master key 沒設就不啟動**。寫死在程式碼裡的預設 key，等於任何讀得到原始碼的人都有 key。
- **一把 master key、兩個用途，用 HKDF 分開衍生**：`deriveKey(MASTER_KEY, 'image-key-wrap')` 包裝圖片 key，`deriveKey(MASTER_KEY, 'key-url-sign')` 簽 URL。同一把 key 拿去做兩件不同的事，任何一邊出問題都會牽連另一邊。
- **`hmacVerify` 先比長度**：`crypto.timingSafeEqual` 遇到兩個 Buffer 長度不同會直接丟例外，不先檢查的話，對手送一個長度不對的 `sig` 就能讓伺服器回 500。

啟動時帶上 MASTER_KEY：

```bash
cd backend
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run ch04
```

### 對應前端流程

```js
// 1. 拿短效 URL（demo 的 /sign 沒驗身分；第 07 章改成要帶 JWT）
const { keyUrl, encUrl } = await fetch(`/api/image/${id}/sign`).then(r => r.json());

// 2. 用該 URL 拿 key
const { keyHex, mime } = await fetch(keyUrl).then(r => r.json());

// 3. 拿密文 + 解密
const enc = await fetch(encUrl).then(r => r.arrayBuffer());
const plain = await decryptGcm(enc, keyHex);
```

---

## 8 效能對比表

```js
// bench：GCM 解密會驗證 tag，一定要拿真正加密過的資料來解，拿亂數去解只會得到 OperationError
for (const sizeMB of [1, 5, 10, 20]) {
  const data = randomBytes(sizeMB * 1024 * 1024);   // 第 02 章的分段版 randomBytes
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

  const t0 = performance.now();
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  console.log(sizeMB + 'MB:', (performance.now() - t0).toFixed(1), 'ms');
}
```

Apple M2 + Edge 157 實測（全檔解密，取中位數）：

| 大小 | 純 JS XOR（第 02 章寫法） | WebCrypto AES-GCM |
|------|----------|-------------------|
| 1MB | 1.7 ms | 0.5 ms |
| 5MB | 9.3 ms | 2.6 ms |
| 10MB | 17 ms | 4.3 ms |
| 20MB | 36 ms | 7.9 ms |

**WebCrypto 比純 JS XOR 還快**——因為硬體加速。而且 `crypto.subtle` 是非同步的，運算在背景執行緒進行，不會卡住畫面。
所以「全檔 AES-GCM」的效能完全可以接受，更別說「檔頭 AES」幾乎無感。

---

## 9 常見坑

### 坑 1：忘記 GCM tag

```js
// ❌ 只傳密文，沒帶 tag
crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
// 一定報 OperationError

// ✅ 密文後面接著 tag（本課程的檔案格式本來就是這樣排的）
crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertextWithTag)
```

### 坑 2：IV 長度錯

GCM 建議用 12 byte（96 bit）IV。其他長度規範上允許，但 IV 會先經過 GHASH 轉換，多一道運算、安全邊界也比較差，NIST 建議用 96 bit。

### 坑 3：把 key 寫死在前端

```js
// ❌
const KEY = '0123456789abcdef...';

// ✅ 從 API 取，並用簽名 URL 保護
```

### 坑 4：CTR mode 的 counter 寫法不對

WebCrypto 的 `counter` 參數是「整個 16 byte block」，後 `length` bit 當計數器遞增，前面是固定的 nonce。
後端用 Node 的 `aes-256-ctr` 時，Node 把整個 16 byte 當成 128 bit 計數器，所以前端要用 `length: 128` 才會完全一致（第 03 章第 5 節）。

---

## 10 動手作業

1. 把第 7 節伺服器改成支援「key 過期後 client 自動重抓」，前端 5 分鐘內快取 key，過期重抓。
2. 寫一個小工具：給一段密文，判斷它是不是用 ECB 加密的（提示：找重複的 16 byte block）。先用未壓縮的 BMP 測，再換成 JPEG 測一次，比較兩者找到的重複 block 數量差多少。
3. 本章的伺服器用 HKDF 從 `MASTER_KEY` 衍生出兩把 key。試著再衍生第三把給 JWT 簽章用（第 07 章會用到），並寫下：如果三個地方都直接用 `MASTER_KEY`，哪一邊外洩會牽連到哪一邊？

---

## 11 本章重點回顧

- **AES-GCM 是預設首選**：強加密 + 完整性驗證。
- **AES-CTR 用於需要部分解密** 的場景（檔頭加密）。
- **同一把 key 底下 IV 絕不能重複**，否則 GCM 的保密與驗證都會失效。
- Key 管理三策略：每圖獨立 key、信封加密（master key 只在伺服器）、簽名 URL + 短效；簽名 URL 過期的是 URL，不是 key。
- WebCrypto **比純 JS 還快**，因為走硬體 AES 指令，而且不卡主執行緒。

---

**下一章**：[05-rust-wasm-toolchain.md](./05-rust-wasm-toolchain.md) — Rust + wasm-pack 環境，編出你第一個 .wasm
