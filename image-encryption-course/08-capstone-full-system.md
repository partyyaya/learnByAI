# 第 08 章：畢業專題——完整圖片加密系統

> **學習目標**：把前 7 章所有觀念整合成一個可上線的小系統：「登入 → 上傳加密圖 → 權限分級 → WASM 解密 + Canvas 渲染」。
> **預計時數**：240 分鐘（含實作）
> **先備知識**：學完 [[00-course-map-and-threat-model]] 到 [[07-canvas-rendering-and-hardening]] 的全部章節

> **本章對應專案**：本章就是整個 `image-encryption-course/` 課程目錄本身。所有檔案都已建好，本章帶你**讀懂並跑起來**，最後給你延伸方向。
>
> | 路徑 | 角色 |
> |------|------|
> | [`backend/`](./backend/) | Express + SQLite 整合伺服器 |
> | [`backend/server.js`](./backend/server.js) | capstone 主伺服器 |
> | [`backend/db.js`](./backend/db.js) | SQLite schema |
> | [`backend/lib/`](./backend/lib/) | `crypto-util.js`、`auth.js`、`aes-gcm.js`、`xor.js` |
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
| 使用者註冊 / 登入（JWT） | [[04-aes-with-webcrypto]] |
| 上傳圖片自動加密 | [[03-header-scramble]] + [[04-aes-with-webcrypto]] |
| 支援三種權限：public / friends / private | [[04-aes-with-webcrypto]] 策略 B |
| Key 以 wrapping 方式存（不明文） | [[04-aes-with-webcrypto]] |
| 簽名 URL + 60 秒過期 | [[07-canvas-rendering-and-hardening]] |
| WASM 解密 | [[06-wasm-decryption-in-browser]] |
| Canvas 渲染 + 動態浮水印 | [[07-canvas-rendering-and-hardening]] |
| Rate Limit + Headless 偵測 | [[07-canvas-rendering-and-hardening]] |

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
│                              └──→  imgKey 用 masterKey wrap     │
│                                                                 │
│  Storage:  /encrypted/*.enc  +  SQLite (meta.db)                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3 專案結構

對應到本課程目錄的實際結構：

```text
image-encryption-course/
├── backend/
│   ├── package.json
│   ├── server.js              ← capstone 整合伺服器
│   ├── db.js                  ← SQLite schema
│   ├── lib/
│   │   ├── auth.js            ← scrypt + JWT
│   │   ├── crypto-util.js     ← AES-CTR header + key wrap + HMAC
│   │   ├── aes-gcm.js         ← 全檔 AES-GCM
│   │   └── xor.js             ← Ch02 XOR
│   ├── examples/              ← Ch02/03/04 單章 demo server
│   └── data/                  ← 啟動後自動建立
│       ├── meta.db
│       └── encrypted/
│
├── frontend/
│   ├── index.html             ← 入口頁
│   ├── login.html             ← 登入 / 註冊
│   ├── gallery.html           ← 圖庫主頁
│   ├── secure-image.js        ← Web Component
│   ├── examples/              ← Ch02–06 章節 demo 頁
│   ├── pkg/                   ← wasm-pack 產物（gitignored）
│   └── wasm-crypto/
│       ├── Cargo.toml
│       └── src/lib.rs
│
└── (各章節 .md)
```

> 跟教材原本「server/ + wasm-crypto/ + client/」三層的設計不同，實際專案合併成 `backend/` 和 `frontend/`，並把 `wasm-crypto/` 放在 `frontend/` 底下方便編譯產物進 `frontend/pkg/`。後端用 `express.static` 直接服務 `frontend/`，所以前端不需要再起伺服器。

---

## 4 後端完整代碼

> 教學版本與專案版本基本一致。以下重點段落用來閱讀理解，完整可跑檔案請對應到 `backend/` 內對應路徑。

### 4.1 [`backend/package.json`](./backend/package.json)

```json
{
  "name": "image-encryption-course-backend",
  "version": "1.0.0",
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
  }
}
```

### 4.2 [`backend/db.js`](./backend/db.js)

```js
'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'encrypted'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'meta.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    passwordHash TEXT,
    createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    mime TEXT,
    headerLen INTEGER,
    ivHex TEXT,
    wrappedKey TEXT,
    visibility TEXT CHECK(visibility IN ('public','friends','private')),
    createdAt INTEGER,
    FOREIGN KEY (ownerId) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS friends (
    a TEXT, b TEXT,
    PRIMARY KEY (a, b)
  );
`);

module.exports = db;
```

### 4.3 [`backend/lib/crypto-util.js`](./backend/lib/crypto-util.js)

```js
'use strict';
const crypto = require('crypto');

const HEADER_LEN = 1024;

function encryptHeader(buf, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const headerLen = Math.min(HEADER_LEN, buf.length);
  const out = Buffer.from(buf);
  const enc = Buffer.concat([
    cipher.update(buf.subarray(0, headerLen)),
    cipher.final(),
  ]);
  enc.copy(out, 0);
  return out;
}

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

function hmacSign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function hmacVerify(secret, payload, sig) {
  const expected = hmacSign(secret, payload);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}

module.exports = {
  HEADER_LEN,
  encryptHeader,
  wrapKey,
  unwrapKey,
  hmacSign,
  hmacVerify,
};
```

### 4.4 [`backend/lib/auth.js`](./backend/lib/auth.js)

```js
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'demo-jwt-secret';

function hashPassword(pwd, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${h}`;
}

function verifyPassword(pwd, stored) {
  const [salt, h] = stored.split(':');
  const candidate = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(candidate, 'hex'));
}

function signJwt(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { hashPassword, verifyPassword, signJwt, authMiddleware, JWT_SECRET };
```

### 4.5 [`backend/server.js`](./backend/server.js)

```js
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
const {
  HEADER_LEN, encryptHeader, wrapKey, unwrapKey, hmacSign, hmacVerify
} = require('./lib/crypto-util');
const {
  hashPassword, verifyPassword, signJwt, authMiddleware, JWT_SECRET
} = require('./lib/auth');

const MASTER_KEY_HEX = process.env.MASTER_KEY ||
  '0000000000000000000000000000000000000000000000000000000000000000';
const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');
if (MASTER_KEY.length !== 32) {
  throw new Error('MASTER_KEY must be 64 hex chars');
}

const ENC_DIR = path.join(__dirname, 'data', 'encrypted');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

// === 1. 註冊 / 登入 ===
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const id = uuid();
  try {
    db.prepare(
      'INSERT INTO users (id, username, passwordHash, createdAt) VALUES (?,?,?,?)'
    ).run(id, username, hashPassword(password), Date.now());
  } catch (e) {
    return res.status(409).json({ error: 'username taken' });
  }
  res.json({ token: signJwt({ userId: id, username }) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !verifyPassword(password, u.passwordHash)) {
    return res.status(401).json({ error: 'bad credentials' });
  }
  res.json({ token: signJwt({ userId: u.id, username: u.username }) });
});

// === 2. 上傳並加密 ===
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const visibility = ['public', 'friends', 'private'].includes(req.body.visibility)
    ? req.body.visibility : 'private';

  const id = uuid();
  const imgKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);

  const encrypted = encryptHeader(req.file.buffer, imgKey, iv);
  fs.writeFileSync(path.join(ENC_DIR, `${id}.enc`), encrypted);

  db.prepare(`
    INSERT INTO images (id, ownerId, mime, headerLen, ivHex, wrappedKey, visibility, createdAt)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    id, req.user.userId, req.file.mimetype, HEADER_LEN,
    iv.toString('hex'), wrapKey(imgKey.toString('hex'), MASTER_KEY),
    visibility, Date.now()
  );

  res.json({ id });
});

// === 3. 列表 ===
app.get('/api/images', authMiddleware, (req, res) => {
  const own = db.prepare(`
    SELECT id, mime, visibility, createdAt FROM images
    WHERE ownerId = ? ORDER BY createdAt DESC
  `).all(req.user.userId);
  res.json(own);
});

// === 4. 簽名 URL ===
app.get('/api/image/:id/sign', authMiddleware, (req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();

  // 權限檢查
  if (img.visibility === 'private' && img.ownerId !== req.user.userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (img.visibility === 'friends' && img.ownerId !== req.user.userId) {
    const isFriend = db.prepare('SELECT 1 FROM friends WHERE a=? AND b=?')
      .get(img.ownerId, req.user.userId);
    if (!isFriend) return res.status(403).json({ error: 'not a friend' });
  }

  const exp = Date.now() + 60 * 1000;   // 60 秒
  const payload = `${img.id}|${req.user.userId}|${exp}`;
  const sig = hmacSign(JWT_SECRET, payload);

  res.json({
    keyUrl: `/api/image/${img.id}/key?u=${req.user.userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${img.id}.enc`,
  });
});

// === 5. Key API ===
const keyLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

app.get('/api/image/:id/key', keyLimiter, (req, res) => {
  const { u, exp, sig } = req.query;
  if (!u || !exp || !sig) return res.status(400).end();
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(JWT_SECRET, payload, String(sig))) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).end();

  const imgKeyHex = unwrapKey(img.wrappedKey, MASTER_KEY);
  res.json({
    keyHex: imgKeyHex,
    ivHex: img.ivHex,
    headerLen: img.headerLen,
    mime: img.mime,
  });
});

// === 6. 加密圖檔 ===
const encLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

app.get('/api/image/:id.enc', encLimiter, (req, res) => {
  const file = path.join(ENC_DIR, `${req.params.id}.enc`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(fs.readFileSync(file));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Image Vault running on :${PORT}`));
```

### 4.6 啟動

```bash
cd backend
npm install
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run start
```

---

## 5 Rust WASM 模組

### 5.1 [`frontend/wasm-crypto/Cargo.toml`](./frontend/wasm-crypto/Cargo.toml)

```toml
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
strip = true
panic = "abort"
```

### 5.2 [`frontend/wasm-crypto/src/lib.rs`](./frontend/wasm-crypto/src/lib.rs)

完整檔還包含 Ch05 / Ch06 的 `add`、`greet`、`xor_inplace`、`xor_decrypt`、`aes_ctr_decrypt`。下面只列 capstone 用到的關鍵函式：

```rust
use wasm_bindgen::prelude::*;
use aes::Aes256;
use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr64BE;

type Aes256Ctr = Ctr64BE<Aes256>;

#[wasm_bindgen]
pub fn aes_ctr_decrypt_header(
    data: &mut [u8],
    key: &[u8],
    iv: &[u8],
    header_len: usize,
) -> Result<(), JsError> {
    if key.len() != 32 { return Err(JsError::new("key must be 32 bytes")); }
    if iv.len() != 16  { return Err(JsError::new("iv must be 16 bytes")); }

    let end = header_len.min(data.len());
    let mut cipher = Aes256Ctr::new(key.into(), iv.into());
    cipher.apply_keystream(&mut data[..end]);
    Ok(())
}
```

### 5.3 編譯

```bash
cd frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg
```

`--out-dir ../pkg` 會把產物直接寫到 [`frontend/pkg/`](./frontend/pkg/)，前端用 `import init from '/pkg/img_crypto.js'` 載入，不用 symlink。

---

## 6 前端完整代碼

### 6.1 [`frontend/login.html`](./frontend/login.html)

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Image Vault · 登入</title></head>
<body style="font-family:sans-serif;max-width:400px;margin:2em auto">
  <h1>登入 / 註冊</h1>
  <input id="u" placeholder="username">
  <input id="p" type="password" placeholder="password">
  <button id="login">登入</button>
  <button id="reg">註冊</button>
  <p id="msg"></p>
  <script>
    async function call(path) {
      const r = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: u.value, password: p.value,
        })
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
'use strict';
import init, { aes_ctr_decrypt_header } from './pkg/img_crypto.js';

const wasmReady = init();

class SecureImage extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'closed' }); }

  static get observedAttributes() { return ['image-id']; }

  async attributeChangedCallback() {
    await wasmReady;
    const id = this.getAttribute('image-id');
    if (!id) return;

    const jwt = localStorage.getItem('jwt');
    if (!jwt) { this.shadowRoot.textContent = 'not logged in'; return; }

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'max-width:100%;display:block;border:1px solid #ddd;border-radius:4px';
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.shadowRoot.replaceChildren(canvas);

    try {
      const sign = await fetch(`/api/image/${id}/sign`, {
        headers: { Authorization: `Bearer ${jwt}` }
      });
      if (!sign.ok) {
        this.shadowRoot.textContent = `Error ${sign.status}`;
        return;
      }
      const { keyUrl, encUrl } = await sign.json();

      const [meta, encBuf] = await Promise.all([
        fetch(keyUrl).then(r => r.json()),
        fetch(encUrl).then(r => r.arrayBuffer())
      ]);

      const buf = new Uint8Array(encBuf);
      aes_ctr_decrypt_header(
        buf,
        hexToBytes(meta.keyHex),
        hexToBytes(meta.ivHex),
        meta.headerLen
      );

      const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);

      // 浮水印（diagonal repeating）
      const userId = JSON.parse(atob(jwt.split('.')[1])).userId.slice(0, 8);
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.font = '14px sans-serif';
      ctx.rotate(-Math.PI / 12);
      for (let y = -canvas.height; y < canvas.height * 2; y += 60) {
        for (let x = -canvas.width; x < canvas.width * 2; x += 240) {
          ctx.fillText(`${userId} · ${new Date().toLocaleString()}`, x, y);
        }
      }
      ctx.restore();

      bitmap.close();
      buf.fill(0);
    } catch (e) {
      console.error(e);
      this.shadowRoot.textContent = 'decrypt failed';
    }
  }
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
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Image Vault</title>
  <style>
    body { font-family:sans-serif; max-width:960px; margin:1em auto; padding:0 1em; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:1em; }
    .upload { background:#f5f5f5; padding:1em; border-radius:6px; margin-bottom:1em; }
  </style>
</head>
<body>
  <h1>Image Vault</h1>
  <button id="logout">登出</button>

  <div class="upload">
    <input type="file" id="file" accept="image/*">
    <select id="vis">
      <option value="private">private</option>
      <option value="friends">friends</option>
      <option value="public">public</option>
    </select>
    <button id="up">上傳</button>
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
        body: fd
      });
      if (r.ok) { loadList(); file.value = ''; }
      else alert((await r.json()).error);
    };

    async function loadList() {
      const list = await fetch('/api/images', {
        headers: { Authorization: `Bearer ${jwt}` }
      }).then(r => r.json());
      grid.innerHTML = '';
      for (const img of list) {
        const card = document.createElement('div');
        card.innerHTML = `
          <secure-image image-id="${img.id}"></secure-image>
          <div>${img.visibility} · ${new Date(img.createdAt).toLocaleString()}</div>
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

# 2. 啟動後端（會同時 serve frontend/）
cd ../../backend
npm install
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run start

# 3. 打開瀏覽器
open http://localhost:3000/login.html
```

測試流程：
1. 註冊 alice / 註冊 bob（分別用兩個瀏覽器分頁）
2. alice 上傳一張圖，visibility = private
3. bob 試打 `/api/image/{alice 的 id}/sign` → 應該 403
4. alice 上傳第二張，visibility = public，bob 能看
5. 觀察 Network：
   - `/api/image/X/sign` 回傳一次性 URL
   - `/api/image/X/key` 60 秒後再呼叫會 403 expired
   - `/api/image/X.enc` 是亂碼，瀏覽器直接開破圖

---

## 8 驗收清單

對照需求逐條驗證：

- [ ] 註冊與登入正常，JWT 存進 localStorage
- [ ] 上傳的圖被加密成 `.enc`，且 `xxd` 看不到 magic number `FF D8`（PNG 看不到 `89 50`）
- [ ] DB 裡的 `wrappedKey` 是加密過的（不是明文 hex）
- [ ] private 圖被別人請求 → 403
- [ ] friends 圖被非好友請求 → 403
- [ ] public 圖任何登入使用者都能看
- [ ] `/api/image/X/key` URL 超過 60 秒 → 403 expired
- [ ] DevTools Sources 找不到 key（key 不在 JS 代碼中）
- [ ] Canvas 上有浮水印
- [ ] 用 `curl` 拉 `.enc` 拿到的是亂碼

---

## 9 還能繼續做什麼？

完成這個專題只是起點，要更進一步：

### 9.1 加上 Service Worker

把所有 `/api/image/*.enc` 請求在 SW 攔截，解密後回 `image/jpeg`。
這樣主執行緒可以直接 `<img src="/api/image/X.enc">`，攻擊面更小。

### 9.2 把 wasm 模組拆分

目前所有解密邏輯在同一個 wasm。改成 3 個獨立 wasm：
- `wasm-aes.wasm`：純 AES
- `wasm-key-derive.wasm`：key 推導
- `wasm-watermark.wasm`：浮水印

對手要全部反編譯才能還原邏輯。

### 9.3 動態 wasm 版本

每天伺服器產生不同魔改參數的 wasm（換 S-box 順序或加額外步驟）。對手昨天破解的腳本今天就失效。

### 9.4 加上 OPFS / IndexedDB 離線

讓使用者離線時也能瀏覽，但 key 仍要驗網路才能拿。

### 9.5 圖片預覽（縮圖）也加密

上傳時產生 200×200 縮圖也加密，列表顯示縮圖時走同一套流程。

### 9.6 加 WebRTC datachannel 傳 key

讓 key 走 P2P，伺服器看不到。配合 WebPush。

---

## 10 課程總結

回顧你學到的：

| 領域 | 關鍵知識 |
|------|---------|
| **圖片格式** | PNG/JPEG/WebP magic number、檔頭結構、為何破壞檔頭就足夠 |
| **對稱加密** | XOR 原理與弱點、AES-CTR/GCM、IV/Nonce 規則 |
| **WebCrypto** | 瀏覽器原生加解密、效能、坑點 |
| **WASM** | Rust toolchain、`wasm-pack`、JS↔WASM 資料傳遞、逆向難度 |
| **Key 管理** | Per-image key、wrap with master key、簽名 URL、過期機制 |
| **渲染層** | Blob URL 弱點、Canvas + ImageBitmap、浮水印（明 + 隱） |
| **系統設計** | 威脅模型、多層防禦、Rate Limit、Headless 偵測 |

---

## 11 真實世界的下一步

如果你打算把這套系統真的上線：

1. **找密碼學專家 review 加密設計**——本課程的方案夠擋 Level 2，但要對抗國家級需要專業審計。
2. **加上 WAF**：Cloudflare 之類擋掉 99% 的暴力爬蟲。
3. **法務佈局**：DMCA、版權聲明、外流追訴流程。
4. **監控**：誰在大量呼叫 `/api/image/*/key`？誰在 60 秒內呼叫 100 次？
5. **A/B test 防禦強度**：加上加密後是否影響使用者體驗（載入時間、CPU 用量）？

---

## 12 給你的話

恭喜完成這門課。

請記得：**沒有絕對的安全**。我們做這套系統的目的不是「擋下所有人」，而是**讓對手付出的成本，遠超過盜用內容帶來的收益**。

當你做完這個 capstone，你有能力：

- 看穿任何網站的圖片防爬手法（漫畫站、影音站、電商）
- 設計適合自己場景的加密方案
- 平衡「安全」與「使用者體驗」的取捨
- 用 WASM 解決一切「不想讓對手輕鬆讀懂」的場景

這套思路不只用於圖片，影片、音檔、PDF、甚至模型權重檔，都是同樣的攻防邏輯。

祝你寫出對手討厭、使用者喜歡的系統。

---

**回到首頁**：[README.md](./README.md)
