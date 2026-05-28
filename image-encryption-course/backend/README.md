# Image Encryption Course · Backend

Express 後端，覆蓋全課程的伺服器端代碼。

## 章節對應

| 檔案 | 對應章節 | 說明 |
|------|----------|------|
| `server.js` | **Chapter 08（畢業專題）** | 整合所有功能的最終版：JWT、AES-CTR 檔頭加密、wrap key、簽名 URL、權限分級 |
| `db.js` | Chapter 08 | SQLite schema（users / images / friends） |
| `lib/crypto-util.js` | Chapter 03、04、08 | AES-CTR 檔頭加密、AES-GCM key wrap、HMAC 簽名 |
| `lib/auth.js` | Chapter 04、08 | 密碼 hash（scrypt）、JWT 簽發、middleware |
| `lib/xor.js` | Chapter 02 | 純 XOR 加密工具 |
| `lib/aes-gcm.js` | Chapter 04 | 全檔 AES-GCM 加解密 |
| `examples/ch02-xor-server.js` | Chapter 02 | 最小可跑：XOR 全檔加密 demo |
| `examples/ch03-header-server.js` | Chapter 03 | 只加密前 1024 byte 的 AES-CTR demo |
| `examples/ch04-aes-server.js` | Chapter 04 | 全檔 AES-GCM + 簽名 URL demo |

## 安裝

```bash
cd backend
npm install
```

## 啟動

### 跑最終整合版（Chapter 08）

```bash
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run start
```

打開 `http://localhost:3000/login.html`。

### 跑單章 demo

```bash
# Chapter 02
node examples/ch02-xor-server.js

# Chapter 03
node examples/ch03-header-server.js

# Chapter 04
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  node examples/ch04-aes-server.js
```

各 demo 都會啟動在 `http://localhost:3000`，且直接服務同目錄 `../frontend/` 下對應的 example 頁面。

## 環境變數

| 變數 | 預設值 | 用途 |
|------|--------|------|
| `MASTER_KEY` | 全 0（**僅 demo 用**） | 64 hex 字元，用來 wrap 每張圖的 key |
| `JWT_SECRET` | `demo-jwt-secret` | JWT 簽章用 |
| `PORT` | `3000` | HTTP port |

> 正式上線時 **必須** 設定 `MASTER_KEY` 與 `JWT_SECRET`，且存進 secret manager（AWS KMS / GCP KMS / Vault）。

## 資料夾

- `data/encrypted/*.enc` — 加密後的圖片檔
- `data/meta.db` — SQLite 資料庫（啟動時自動建立）
- `sample/` — 給單章 demo 用的測試圖（你可以自己丟一張 `sample.jpg` 進去）
