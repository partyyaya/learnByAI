# Image Encryption Course · Backend

Express 後端，覆蓋全課程的伺服器端程式碼。

## 章節對應

| 檔案 | 對應章節 | 說明 |
|------|----------|------|
| `server.js` | **Chapter 08（畢業專題）** | 整合所有功能的最終版：JWT、AES-CTR 檔頭加密、wrap key、簽名 URL、權限分級、好友 |
| `db.js` | Chapter 08 | SQLite schema（users / images / friends） |
| `lib/image-format.js` | Chapter 01、03、08 | 用 magic number 判斷格式、找出影像資料開始的位置 |
| `lib/crypto-util.js` | Chapter 03、04、08 | 計算檔頭加密範圍、AES-CTR 檔頭加密、HKDF 衍生 key、AES-GCM key wrap、HMAC 簽名 |
| `lib/auth.js` | Chapter 07、08 | 密碼 hash（scrypt）、JWT 簽發、middleware |
| `lib/xor.js` | Chapter 02 | 純 XOR 加密工具 |
| `lib/aes-gcm.js` | Chapter 04 | 全檔 AES-GCM 加解密 |
| `examples/ch02-xor-server.js` | Chapter 02 | 最小可跑：XOR 全檔加密 demo |
| `examples/ch03-header-server.js` | Chapter 03、06 | 只加密檔頭的 AES-CTR demo（第 06 章的 WASM 頁也用這支） |
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
npm run ch02

# Chapter 03（Chapter 06 也用這支）
npm run ch03

# Chapter 04
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run ch04
```

各 demo 都會啟動在 `http://localhost:3000`，且直接服務同目錄 `../frontend/` 下對應的 example 頁面。

## 環境變數

| 變數 | 誰需要 | 用途 |
|------|--------|------|
| `MASTER_KEY` | `server.js`、`ch04` | 64 hex 字元。用 HKDF 衍生出兩把 key：一把包裝每張圖的 key，一把簽 key URL |
| `JWT_SECRET` | `server.js` | JWT 簽章用 |
| `PORT` | 全部（選填） | HTTP port，預設 `3000` |

> 這兩個值沒有預設值，沒設就不會啟動——寫死在程式碼裡的預設 key 等於沒有 key。正式上線時放進 secret manager（AWS KMS / GCP KMS / Vault）。

## 資料夾

- `data/encrypted/*.enc` — capstone 加密後的圖片檔
- `data/encrypted/chXX/` — 單章 demo 的加密檔與 `_meta.json`（demo 版 meta 存的是明文 key）
- `data/meta.db` — SQLite 資料庫（啟動時自動建立）
- `sample/` — 給單章 demo 用的測試圖（你可以自己丟一張 `sample.jpg` 進去）

`data/` 底下的東西全部不進版控（見 `.gitignore`）。
