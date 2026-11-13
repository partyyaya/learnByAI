# 第 08 章：畢業專題——完整圖片加密系統

> **學習目標**：把前 7 章所有觀念整合成一個能跑起來的小系統：「登入 → 上傳加密圖 → 權限分級 → WASM 解密 + Canvas 渲染」，並清楚它離真正上線還差什麼。
> **預計時數**：240 分鐘（含實作）
> **先備知識**：學完 [第 00 章](./00-course-map-and-threat-model.md) 到 [第 07 章](./07-canvas-rendering-and-hardening.md) 的全部章節

> **本章對應專案**：本章就是整個 `image-encryption-course/` 課程目錄本身。所有檔案都已建好，本章帶你**讀懂並跑起來**，最後給你延伸方向。
>
> | 路徑 | 角色 |
> |------|------|
> | [`backend/`](./backend/) | Express + SQLite 整合伺服器 |
> | [`backend/server.js`](./backend/server.js) | capstone 主伺服器 |
> | [`backend/db.js`](./backend/db.js) | SQLite schema |
> | [`backend/lib/`](./backend/lib/) | `image-format.js`、`crypto-util.js`、`auth.js`、`aes-gcm.js`、`xor.js` |
> | [`frontend/`](./frontend/) | 純 HTML + ES Module 前端 |
> | [`frontend/login.html`](./frontend/login.html) / [`gallery.html`](./frontend/gallery.html) | 登入頁 / 圖庫頁 |
> | [`frontend/secure-image.js`](./frontend/secure-image.js) | `<secure-image>` Web Component |
> | [`frontend/wasm-crypto/`](./frontend/wasm-crypto/) | Rust + wasm-pack 來源 |
>
> 啟動：
> ```bash
> # 1) WASM
> cd frontend/wasm-crypto
> wasm-pack build --target web --release --out-dir ../pkg
>
> # 2) Backend
> cd ../../backend
> npm install
> MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
> JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
>   npm run start
> ```
> 打開 `http://localhost:3000/login.html` 開始用。

---

## 1 專題目標

我們要做一個「私人圖片庫」，需求如下：

| 需求 | 對應章節 |
|------|---------|
| 使用者註冊 / 登入（JWT） | [第 07 章](./07-canvas-rendering-and-hardening.md) |
| 上傳時用 magic number 驗證格式 | [第 01 章](./01-image-format-and-magic-number.md) |
| 上傳圖片自動做檔頭加密（範圍依每張圖計算） | [第 03 章](./03-header-scramble.md) |
| 三種權限：public / friends / private，可加好友 | 本章 |
| Key 以信封加密存放（master key 只在伺服器） | [第 04 章](./04-aes-with-webcrypto.md) 策略 B |
| 簽名 URL + 60 秒過期 | [第 04 章](./04-aes-with-webcrypto.md) 策略 C、[第 07 章](./07-canvas-rendering-and-hardening.md) |
| WASM 解密 | [第 06 章](./06-wasm-decryption-in-browser.md) |
| Canvas 渲染 + 動態浮水印 | [第 07 章](./07-canvas-rendering-and-hardening.md) |
| 依帳號限流 | [第 07 章](./07-canvas-rendering-and-hardening.md) |

完成後你會有一個能放履歷的作品。

---

## 2 系統架構圖

```text
┌──────────────────────────────────────────────────────────────┐
│                        瀏覽器                                  │
│                                                                │
│  ┌─────────────────────┐                                       │
│  │  login.html         │ ── POST /api/login ───┐               │
│  └─────────────────────┘                       │               │
│                                                ▼               │
│  ┌─────────────────────┐                ┌─────────────┐        │
│  │  gallery.html       │ ── GET /api ──→│ JWT (localSt)│        │
│  │  <secure-image>     │                └─────────────┘        │
│  │       │             │                       │               │
│  │       ▼             │                       │               │
│  │  WASM decrypt       │ ←────── /api/image/:id/sign ─────────┐│
│  │       │             │ ←────── /api/image/:id/key ──────────┤│
│  │       ▼             │ ←────── /api/image/:id.enc ──────────┘│
│  │  Canvas + watermark │                                       │
│  └─────────────────────┘                                       │
└──────────────────────────────────────────────────────────────┬─┘
                                                               │ HTTPS
┌──────────────────────────────────────────────────────────────▼─┐
│                       Express 後端                              │
│                                                                 │
│  Auth (JWT)  ──→  Permission Check  ──→  Sign URL (HMAC)        │
│                                                                 │
│  Upload  ──→  Multer  ──→  encryptHeader(AES-CTR)  ──→  fs      │
│                              │                                  │
│                              └──→  imgKey 用 master key 衍生的   │
│                                    包裝 key 加密後存 DB          │
│                                                                 │
│  Storage:  data/encrypted/*.enc  +  SQLite (data/meta.db)       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3 專案結構

```text
image-encryption-course/
├── backend/
│   ├── package.json
│   ├── server.js              ← capstone 整合伺服器
│   ├── db.js                  ← SQLite schema
│   ├── lib/
│   │   ├── image-format.js    ← magic number、找出影像資料開始的位置
│   │   ├── auth.js            ← scrypt + JWT
│   │   ├── crypto-util.js     ← AES-CTR 檔頭加密 + HKDF + key wrap + HMAC
│   │   ├── aes-gcm.js         ← 全檔 AES-GCM（第 04 章）
│   │   └── xor.js             ← 第 02 章 XOR
│   ├── examples/              ← 第 02/03/04 章的單章 demo server
│   └── data/                  ← 啟動後自動建立，不進版控
│       ├── meta.db
│       └── encrypted/
│
├── frontend/
│   ├── index.html             ← 入口頁
│   ├── login.html             ← 登入 / 註冊
│   ├── gallery.html           ← 圖庫主頁
│   ├── secure-image.js        ← Web Component
│   ├── examples/              ← 第 02–06 章 demo 頁
│   ├── pkg/                   ← wasm-pack 產物（不進版控）
│   └── wasm-crypto/
│       ├── Cargo.toml
│       └── src/lib.rs
│
└── (各章節 .md)
```

`wasm-crypto/` 放在 `frontend/` 底下，編譯產物直接輸出到 `frontend/pkg/`。後端用 `express.static` 直接服務 `frontend/`，所以前端不需要再起伺服器。

---

## 4 後端完整程式碼

以下就是專案裡的檔案全文。

### 4.1 [`backend/package.json`](./backend/package.json)

```json
{
  "name": "image-encryption-course-backend",
  "version": "1.0.0",
  "private": true,
  "description": "Backend for the Image Encryption Course (Chapters 02-08)",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "ch02": "node examples/ch02-xor-server.js",
    "ch03": "node examples/ch03-header-server.js",
    "ch04": "node examples/ch04-aes-server.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "jsonwebtoken": "^9.0.2",
    "multer": "^1.4.5-lts.1",
    "uuid": "^9.0.1"
  },
  "engines": {
    "node": ">=18"
  }
}
```

### 4.2 [`backend/db.js`](./backend/db.js)

```js
// 對應章節：Chapter 08 - 畢業專題的 SQLite schema
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'encrypted'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'meta.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    mime TEXT NOT NULL,
    headerLen INTEGER NOT NULL,
    ivHex TEXT NOT NULL,
    wrappedKey TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public','friends','private')),
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (ownerId) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_images_owner ON images(ownerId);

  CREATE TABLE IF NOT EXISTS friends (
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    PRIMARY KEY (a, b)
  );
`);

module.exports = db;
```

### 4.3 [`backend/lib/image-format.js`](./backend/lib/image-format.js)

```js
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
```

### 4.4 [`backend/lib/crypto-util.js`](./backend/lib/crypto-util.js)

```js
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
```

### 4.5 [`backend/lib/auth.js`](./backend/lib/auth.js)

```js
// 對應章節：Chapter 07（JWT + 簽名 URL）、Chapter 08（完整登入流程）
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// 沒設 JWT_SECRET 就不要啟動：預設值寫在程式碼裡，等於任何人都能簽出合法 token
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required（啟動方式見 backend/README.md）');
}

function hashPassword(pwd, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${h}`;
}

function verifyPassword(pwd, stored) {
  const [salt, h] = stored.split(':');
  const candidate = crypto.scryptSync(pwd, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signJwt(payload, opts = { expiresIn: '2h' }) {
  return jwt.sign(payload, JWT_SECRET, opts);
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signJwt,
  authMiddleware,
};
```

### 4.6 [`backend/server.js`](./backend/server.js)

```js
// 對應章節：Chapter 08 - 畢業專題（整合 Chapter 03/04/06/07 所有概念）
'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');

const db = require('./db');
const { detectImageType } = require('./lib/image-format');
const {
  computeHeaderLen, encryptHeader, deriveKey, wrapKey, unwrapKey, hmacSign, hmacVerify,
} = require('./lib/crypto-util');
const {
  hashPassword, verifyPassword, signJwt, authMiddleware,
} = require('./lib/auth');

// === Master Key：沒設就不啟動 ===
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || '', 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('MASTER_KEY is required: 64 hex chars (32 bytes)（啟動方式見 backend/README.md）');
}
// 同一把 master key 衍生出兩把用途不同的 key
const KEY_WRAP_KEY = deriveKey(MASTER_KEY, 'image-key-wrap');   // 包裝每張圖的 key
const URL_SIGN_KEY = deriveKey(MASTER_KEY, 'key-url-sign');     // 簽 key URL

const ENC_DIR = path.join(__dirname, 'data', 'encrypted');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(cors());
app.use(express.json());

// 服務前端靜態檔（同 repo 的 ../frontend）
const FRONTEND = path.resolve(__dirname, '..', 'frontend');
if (fs.existsSync(FRONTEND)) {
  app.use(express.static(FRONTEND));
  console.log('[INFO] serving frontend from', FRONTEND);
}

// === Auth ===

// 登入、註冊依 IP 限流，擋暴力猜密碼
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true });

function readCredentials(req) {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return null;
  }
  return { username, password };
}

app.post('/api/register', authLimiter, (req, res) => {
  const cred = readCredentials(req);
  if (!cred) return res.status(400).json({ error: 'missing fields' });
  const id = uuid();
  try {
    db.prepare(
      'INSERT INTO users (id, username, passwordHash, createdAt) VALUES (?,?,?,?)'
    ).run(id, cred.username, hashPassword(cred.password), Date.now());
  } catch {
    return res.status(409).json({ error: 'username taken' });
  }
  res.json({ token: signJwt({ userId: id, username: cred.username }) });
});

app.post('/api/login', authLimiter, (req, res) => {
  const cred = readCredentials(req);
  if (!cred) return res.status(400).json({ error: 'missing fields' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(cred.username);
  if (!u || !verifyPassword(cred.password, u.passwordHash)) {
    return res.status(401).json({ error: 'bad credentials' });
  }
  res.json({ token: signJwt({ userId: u.id, username: u.username }) });
});

// === Friends：把對方加為好友後，對方可以看你 visibility = friends 的圖 ===

app.post('/api/friends', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !username) return res.status(400).json({ error: 'missing username' });
  const friend = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!friend) return res.status(404).json({ error: 'no such user' });
  if (friend.id === req.user.userId) return res.status(400).json({ error: 'cannot add yourself' });
  db.prepare('INSERT OR IGNORE INTO friends (a, b) VALUES (?, ?)').run(req.user.userId, friend.id);
  res.json({ ok: true });
});

// === Upload (Chapter 03 加密 + Chapter 04 wrap key) ===

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  // 用 magic number 判斷格式，不信任瀏覽器送來的 mimetype
  const mime = detectImageType(req.file.buffer);
  if (!mime) return res.status(415).json({ error: 'not a supported image' });

  const visibility = ['public', 'friends', 'private'].includes(req.body.visibility)
    ? req.body.visibility
    : 'private';

  const id = uuid();
  const imgKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const headerLen = computeHeaderLen(req.file.buffer);
  const encrypted = encryptHeader(req.file.buffer, imgKey, iv, headerLen);

  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  db.prepare(`
    INSERT INTO images
      (id, ownerId, mime, headerLen, ivHex, wrappedKey, visibility, createdAt)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    id, req.user.userId, mime, headerLen,
    iv.toString('hex'),
    wrapKey(imgKey, KEY_WRAP_KEY, id),
    visibility, Date.now()
  );

  res.json({ id });
});

// === List ===

app.get('/api/images', authMiddleware, (req, res) => {
  const list = db.prepare(`
    SELECT id, mime, visibility, createdAt FROM images
    WHERE ownerId = ?
       OR visibility = 'public'
       OR (visibility = 'friends'
           AND ownerId IN (SELECT a FROM friends WHERE b = ?))
    ORDER BY createdAt DESC
  `).all(req.user.userId, req.user.userId);
  res.json(list);
});

// === Sign URL (Chapter 07) ===

function permitted(img, userId) {
  if (img.visibility === 'public') return true;
  if (img.ownerId === userId) return true;
  if (img.visibility === 'friends') {
    return !!db.prepare('SELECT 1 FROM friends WHERE a=? AND b=?').get(img.ownerId, userId);
  }
  return false;
}

// 依「帳號」限流：已登入的爬蟲換 IP 也沒用
const signLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  keyGenerator: (req) => req.user.userId,
});

app.get('/api/image/:id/sign', authMiddleware, signLimiter, (req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();
  if (!permitted(img, req.user.userId)) return res.status(403).json({ error: 'forbidden' });

  const exp = Date.now() + 60 * 1000;
  const payload = `${img.id}|${req.user.userId}|${exp}`;
  const sig = hmacSign(URL_SIGN_KEY, payload);

  res.json({
    keyUrl: `/api/image/${img.id}/key?u=${req.user.userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${img.id}.enc`,
  });
});

// === Key API ===

const keyLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true });

app.get('/api/image/:id/key', keyLimiter, (req, res) => {
  const { u, exp, sig } = req.query;
  if (!u || !exp || !sig) return res.status(400).end();
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(URL_SIGN_KEY, payload, sig)) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();

  const imgKey = unwrapKey(img.wrappedKey, KEY_WRAP_KEY, img.id);
  res.set('Cache-Control', 'no-store');   // key 不要留在任何快取裡
  res.json({
    keyHex: imgKey.toString('hex'),
    ivHex: img.ivHex,
    headerLen: img.headerLen,
    mime: img.mime,
  });
});

// === Encrypted asset ===

const encLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true });

app.get('/api/image/:id.enc', encLimiter, (req, res) => {
  // 只接受 UUID，避免 ..%2F 之類的路徑穿越
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  fs.createReadStream(file).pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Image Vault] http://localhost:${PORT}/login.html`);
});
```

幾個設計重點：

- **上傳時不信任 `mimetype`**：那是瀏覽器送來的，用 `detectImageType()` 看 magic number 決定格式，認不出就回 415。
- **好友關係是單向的**：`friends (a, b)` 表示「a 允許 b 看 a 的 friends 圖」。`POST /api/friends` 由 a 呼叫、帶上 b 的 username。
- **限流分三層**：登入、註冊依 IP（擋猜密碼）；`/sign` 依帳號（擋已登入的大量抓取）；`/key`、`.enc` 依 IP、上限較寬。

### 4.7 啟動

```bash
cd backend
npm install
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run start
```

兩個環境變數都沒有預設值，少一個伺服器就不會啟動。每次啟動都產生新的 `MASTER_KEY`，之前上傳的圖就解不開了；要保留資料的話，把值存在 `.env` 或 secret manager 裡重複使用。

---

## 5 Rust WASM 模組

### 5.1 [`frontend/wasm-crypto/Cargo.toml`](./frontend/wasm-crypto/Cargo.toml)

```toml
# 對應章節：Chapter 05（toolchain）、Chapter 06（AES-CTR 解密）、Chapter 08（capstone）
[package]
name = "img-crypto"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
aes = "0.8"
ctr = "0.9"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
# 不要加 strip = true：它會連 target_features 區段一起刪掉，
# wasm-pack 內建的 wasm-opt 就不知道 bulk memory 已啟用，build 會失敗。
# release build 經過 wasm-bindgen + wasm-opt 後本來就不含 Rust 函式名。
```

### 5.2 [`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs)

完整檔案還包含第 05、06 章用到的 `add`、`greet`、XOR 系列與指標介面。capstone 只用到 `aes_ctr_decrypt`：

```rust
use wasm_bindgen::prelude::*;
use aes::Aes256;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr128BE;

// 跟 Node 的 aes-256-ctr 一樣，整個 16 byte IV 當 128 bit 計數器
type Aes256Ctr = Ctr128BE<Aes256>;

#[wasm_bindgen]
pub fn aes_ctr_decrypt(data: &mut [u8], key: &[u8], iv: &[u8]) -> Result<(), JsError> {
    check_key_iv(key, iv)?;
    let mut cipher = Aes256Ctr::new(key.into(), iv.into());
    cipher.apply_keystream(data);
    Ok(())
}

fn check_key_iv(key: &[u8], iv: &[u8]) -> Result<(), JsError> {
    if key.len() != 32 {
        return Err(JsError::new("key must be 32 bytes"));
    }
    if iv.len() != 16 {
        return Err(JsError::new("iv must be 16 bytes"));
    }
    Ok(())
}
```

### 5.3 編譯

```bash
cd frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg
```

`--out-dir ../pkg` 會把產物直接寫到 [`frontend/pkg/`](./frontend/pkg/)，前端用 `import init from './pkg/img_crypto.js'` 載入，不用 symlink。

---

## 6 前端完整程式碼

### 6.1 [`frontend/login.html`](./frontend/login.html)

```html
<!-- 對應章節：Chapter 08 - 畢業專題登入頁 -->
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>Image Vault · 登入</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 360px; margin: 4em auto; padding: 0 1em; }
    h1 { margin-bottom: .5em; }
    input { display: block; width: 100%; padding: .6em; margin: .5em 0; box-sizing: border-box; }
    button { padding: .55em 1em; margin-right: .5em; cursor: pointer; }
    #msg { color: #c00; margin-top: 1em; min-height: 1em; }
  </style>
</head>
<body>
  <h1>Image Vault</h1>
  <p>輸入帳號密碼，登入或註冊。</p>
  <input id="u" placeholder="username" autocomplete="username">
  <input id="p" type="password" placeholder="password" autocomplete="current-password">
  <button id="login">登入</button>
  <button id="reg">註冊</button>
  <p id="msg"></p>

  <script>
    async function call(path) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.value, password: p.value }),
      });
      return r.json();
    }
    login.onclick = async () => {
      const { token, error } = await call('/api/login');
      if (error) return msg.textContent = error;
      localStorage.setItem('jwt', token);
      location.href = '/gallery.html';
    };
    reg.onclick = async () => {
      const { token, error } = await call('/api/register');
      if (error) return msg.textContent = error;
      localStorage.setItem('jwt', token);
      location.href = '/gallery.html';
    };
  </script>
</body>
</html>
```

### 6.2 [`frontend/secure-image.js`](./frontend/secure-image.js)

```js
// 對應章節：Chapter 07（Canvas + 浮水印）、Chapter 08（capstone 整合）
//
// 使用：<secure-image image-id="xxx"></secure-image>（JWT 從 localStorage 取）
// 內部流程：取簽名 URL → 取 key + 密文 → WASM AES-CTR 解密檔頭 → Canvas 渲染 + 浮水印

import init, { aes_ctr_decrypt } from './pkg/img_crypto.js';

const wasmReady = init();

class SecureImage extends HTMLElement {
  // closed 模式下 this.shadowRoot 永遠是 null，要自己把 attachShadow 的回傳值存起來
  #root;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'closed' });
  }

  static get observedAttributes() { return ['image-id']; }

  attributeChangedCallback() { this.render(); }

  async render() {
    const id = this.getAttribute('image-id');
    if (!id) return;
    this.#root.textContent = 'Loading…';

    const jwt = localStorage.getItem('jwt');
    if (!jwt) { this.#root.textContent = 'not logged in'; return; }

    try {
      await wasmReady;

      const signRes = await fetch(`/api/image/${id}/sign`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!signRes.ok) {
        this.#root.textContent = `Error ${signRes.status}`;
        return;
      }
      const { keyUrl, encUrl } = await signRes.json();

      const [meta, encBuf] = await Promise.all([
        fetch(keyUrl).then((r) => r.json()),
        fetch(encUrl).then((r) => r.arrayBuffer()),
      ]);

      // 只把加密的那一段交給 wasm：wasm-bindgen 會把傳進去的陣列複製進 wasm 記憶體、
      // 解完再寫回來，傳整個檔案就得多複製好幾 MB
      const buf = new Uint8Array(encBuf);
      aes_ctr_decrypt(
        buf.subarray(0, meta.headerLen),
        hexToBytes(meta.keyHex),
        hexToBytes(meta.ivHex),
      );

      const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'max-width:100%;display:block';
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      // Chrome / Edge 的 canvas 右鍵選單有「另存圖片」，要自己擋掉
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      drawWatermark(ctx, canvas, jwt);

      bitmap.close();
      this.#root.replaceChildren(canvas);
    } catch (e) {
      console.error('[secure-image] failed', e);
      this.#root.textContent = 'decrypt failed';
    }
  }
}

// JWT 用的是 base64url（- 和 _，沒有 =），不能直接丟給 atob；
// payload 是 UTF-8，中文帳號名稱要用 TextDecoder 解
function decodeJwtPayload(jwt) {
  const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

function drawWatermark(ctx, canvas, jwt) {
  let uid = '';
  try {
    uid = decodeJwtPayload(jwt).userId?.slice(0, 8) ?? '';
  } catch { /* 解不開就只印時間 */ }
  const stamp = `${uid} · ${new Date().toLocaleString()}`;

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.font = '14px sans-serif';
  ctx.rotate(-Math.PI / 12);
  for (let y = -canvas.height; y < canvas.height * 2; y += 60) {
    for (let x = -canvas.width; x < canvas.width * 2; x += 240) {
      ctx.fillText(stamp, x, y);
    }
  }
  ctx.restore();
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

customElements.define('secure-image', SecureImage);
```

### 6.3 [`frontend/gallery.html`](./frontend/gallery.html)

```html
<!-- 對應章節：Chapter 08 - 畢業專題圖庫主頁 -->
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>Image Vault</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 960px; margin: 1em auto; padding: 0 1em; }
    header { display: flex; justify-content: space-between; align-items: center; }
    .upload { background: #f5f5f7; padding: 1em; border-radius: 8px; margin: 1em 0; }
    .upload > * { margin-right: .5em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1em; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; }
    .card-meta { font-size: 0.85em; color: #666; padding: .5em .75em; border-top: 1px solid #f0f0f0; }
    .vis { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.78em; }
    .vis-public { background: #e0f5e9; color: #0a803a; }
    .vis-friends { background: #fff5d9; color: #8a6500; }
    .vis-private { background: #fde2e2; color: #a02020; }
  </style>
</head>
<body>
  <header>
    <h1>Image Vault</h1>
    <button id="logout">登出</button>
  </header>

  <div class="upload">
    <input type="file" id="file" accept="image/*">
    <select id="vis">
      <option value="private">private</option>
      <option value="friends">friends</option>
      <option value="public">public</option>
    </select>
    <button id="up">上傳</button>
  </div>

  <div class="upload">
    <input id="friendName" placeholder="對方的 username">
    <button id="addFriend">加為好友</button>
    <small>加了之後，對方能看你標成 friends 的圖</small>
  </div>

  <div id="grid" class="grid"></div>

  <script type="module" src="./secure-image.js"></script>
  <script>
    const jwt = localStorage.getItem('jwt');
    if (!jwt) location.href = '/login.html';

    logout.onclick = () => { localStorage.clear(); location.href = '/login.html'; };

    up.onclick = async () => {
      const f = file.files[0]; if (!f) return;
      const fd = new FormData();
      fd.append('image', f);
      fd.append('visibility', vis.value);
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: fd,
      });
      if (r.ok) { file.value = ''; loadList(); }
      else alert((await r.json()).error || 'upload failed');
    };

    addFriend.onclick = async () => {
      const r = await fetch('/api/friends', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: friendName.value }),
      });
      alert(r.ok ? '已加入' : (await r.json()).error);
    };

    async function loadList() {
      const r = await fetch('/api/images', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // JWT 過期（2 小時）就回登入頁
      if (r.status === 401) { localStorage.removeItem('jwt'); location.href = '/login.html'; return; }
      const list = await r.json();
      grid.innerHTML = '';
      for (const img of list) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <secure-image image-id="${img.id}"></secure-image>
          <div class="card-meta">
            <span class="vis vis-${img.visibility}">${img.visibility}</span>
            ${new Date(img.createdAt).toLocaleString()}
          </div>
        `;
        grid.appendChild(card);
      }
    }
    loadList();
  </script>
</body>
</html>
```

---

## 7 跑起來測試

```bash
# 1. 編譯 wasm（一次就好）
cd frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg

# 2. 啟動後端（會同時服務 frontend/）
cd ../../backend
npm install
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run start

# 3. 打開瀏覽器
open http://localhost:3000/login.html
```

測試流程（alice 和 bob 要用**兩個不同的瀏覽器**，或一般視窗 + 無痕視窗；同一個瀏覽器的分頁共用 localStorage，後登入的人會蓋掉前一個人的 JWT）：

1. alice、bob 各自註冊。
2. alice 上傳一張圖，visibility = private。bob 的圖庫看不到它。
3. bob 直接打 API 也拿不到——在 bob 的瀏覽器 console 執行：

   ```js
   fetch('/api/image/<alice 的圖片 id>/sign', {
     headers: { Authorization: 'Bearer ' + localStorage.getItem('jwt') },
   }).then(r => r.status);   // 403
   ```

4. alice 上傳第二張，visibility = public → bob 重新整理就看得到。
5. alice 上傳第三張，visibility = friends → bob 看不到；alice 在圖庫頁把 `bob` 加為好友 → bob 重新整理就看得到。
6. 觀察 Network：
   - `/api/image/X/sign` 回傳 60 秒有效的 key URL
   - `/api/image/X/key` 的回應帶 `Cache-Control: no-store`；60 秒後再呼叫同一個 URL 會 403 expired
   - `/api/image/X.enc` 用 `curl` 下載下來是無法解碼的二進位（直接在瀏覽器開這個 URL 會變成下載檔案）

---

## 8 驗收清單

對照需求逐條驗證：

- [ ] 註冊與登入正常，JWT 存進 localStorage；JWT 過期後圖庫頁會回到登入頁
- [ ] 沒設 `MASTER_KEY` 或 `JWT_SECRET` 時，伺服器拒絕啟動
- [ ] 上傳非圖片檔 → 415
- [ ] 上傳的圖被加密成 `.enc`：`xxd` 開頭看不到 magic number（JPEG 的 `FF D8`、PNG 的 `89 50`），也找不到 `JFIF`、`Exif`、`IHDR` 這些檔頭字串
- [ ] 拿一張有大 Exif 的手機照片上傳：資料庫裡這張的 `headerLen` 明顯比一般圖片大
- [ ] DB 裡的 `wrappedKey` 是加密過的（不是明文 hex）
- [ ] private 圖被別人請求 → 403
- [ ] friends 圖：加好友前 403、加好友後可以看
- [ ] public 圖任何登入使用者都能看
- [ ] `/api/image/X/key` URL 超過 60 秒 → 403 expired；`sig` 亂填 → 403（不是 500）
- [ ] Canvas 上有浮水印，中文帳號也正確顯示使用者 ID 前 8 碼
- [ ] 用 `curl` 拉 `.enc` 拿到的是無法解碼的二進位

最後，用對手的角度看一次：打開 DevTools 的 Network 面板，`/key` 的回應裡就有 `keyHex`。照 [第 06 章](./06-wasm-decryption-in-browser.md) 第 7.2 節的 Python 腳本，你能在幾分鐘內解出原圖。這個專題擋得住**沒有權限的人**，擋不住**有權限、願意動手的人**——下一節的延伸方向就是在往這個方向補。

---

## 9 還能繼續做什麼？

完成這個專題只是起點，要更進一步：

### 9.1 key 不以明文經過 JS

照 [第 06 章](./06-wasm-decryption-in-browser.md) 第 8 節撇步 3：`/key` 改回傳包裝過的 key，解包和解密都在 wasm 裡完成。這是讓 WASM 真正拉高逆向成本的一步。

### 9.2 伺服器端浮水印

依使用者在伺服器上嵌入不可見浮水印，再加密送出。前端浮水印能被繞過，伺服器端的才追得到外流者（[第 07 章](./07-canvas-rendering-and-hardening.md) 第 7.3 節）。

### 9.3 定期更換 wasm 裡的秘密

做完 9.1 之後，每次發版都換掉嵌在 wasm 裡的秘密（伺服器同步換用新的 transport key）。對手為上一版寫的腳本就失效了。
不要用「每天換一套魔改的 AES」來達成這件事：圖片是上傳時用標準 AES 加密的，換演算法就得把所有圖片重新加密。

### 9.4 加上 OPFS / IndexedDB 離線

讓使用者離線時也能瀏覽：密文可以放心存在本機，key 仍要連網驗證後才能拿。

### 9.5 縮圖也加密

上傳時用 sharp 產生 200×200 縮圖，縮圖也走同一套加密流程，列表先顯示縮圖。順便用 sharp 去掉原圖的 Exif（裡面常有 GPS 位置）。

### 9.6 監控與告警

記錄每個帳號每天呼叫 `/sign` 的次數與時段，貼著限流上限跑、或在半夜大量抓圖的帳號要能被找出來。

---

## 10 課程總結

回顧你學到的：

| 領域 | 關鍵知識 |
|------|---------|
| **圖片格式** | PNG/JPEG/WebP magic number、檔頭結構、檔頭加密要蓋到哪裡才算數 |
| **對稱加密** | XOR 原理與弱點、AES-CTR/GCM、IV/Nonce 規則 |
| **WebCrypto** | 瀏覽器原生加解密、效能、坑點 |
| **WASM** | Rust toolchain、`wasm-pack`、JS↔WASM 資料傳遞的複製成本、它藏得住與藏不住的東西 |
| **Key 管理** | Per-image key、信封加密、HKDF 分離用途、簽名 URL（過期的是 URL 不是 key） |
| **渲染層** | Blob URL 弱點、Canvas + ImageBitmap、浮水印（明 + 隱）與它的限制 |
| **系統設計** | 威脅模型、多層防禦、依帳號限流、自動化工具偵測 |

---

## 11 真實世界的下一步

如果你打算把這套系統真的上線：

1. **把 9.1、9.2 做完**：目前 key 以明文經過 JS，有權限的使用者幾分鐘就能把原圖解出來。
2. **找資安專家 review 加密設計與 key 管理**，master key 改放 KMS。
3. **加上 WAF / bot 管理**：Cloudflare 之類的服務能擋掉大部分自動化流量。
4. **法務佈局**：DMCA、版權聲明、外流追訴流程。
5. **監控**：誰在大量呼叫 `/api/image/*/sign`？誰每天都貼著限流上限跑？
6. **量測使用者體驗**：加密後的載入時間、手機 CPU 用量有沒有變差？

---

## 12 給你的話

恭喜完成這門課。

請記得：**沒有絕對的安全**。我們做這套系統的目的不是「擋下所有人」，而是**讓對手付出的成本，遠超過盜用內容帶來的收益**。

當你做完這個 capstone，你有能力：

- 判讀常見網站的圖片防爬手法（漫畫站、影音站、電商），知道它用了哪一層、擋得住誰
- 設計適合自己場景的加密方案
- 平衡「安全」與「使用者體驗」的取捨
- 判斷什麼時候值得用 WASM，以及要搭配什麼樣的 key 派發，它才真的有用

這套思路不只用於圖片，影片、音檔、PDF、甚至模型權重檔，都是同樣的攻防邏輯。

祝你寫出對手討厭、使用者喜歡的系統。

---

**回到首頁**：[README.md](./README.md)
