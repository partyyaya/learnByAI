# 前端圖片加密課程（含 Node.js 後端 + Rust WASM）

> 本課程面向「能寫 HTML/CSS/JS、會用 Node.js、但沒做過二進位處理」的前端工程師。
> 學完後你能：
> - 從 0 設計一套「伺服器加密 → 瀏覽器解密 → Canvas 渲染」的圖片保護流程
> - 寫出 3 種加密方案（XOR 全檔、AES-CTR 只加密檔頭、AES-GCM 全檔）並知道各自的取捨
> - 用 Rust 編譯出 `.wasm` 給瀏覽器呼叫，並知道它能提高哪些逆向成本、擋不住哪些
> - 判讀常見的「圖片防爬」手法（漫畫站、影片封面、電商素材），知道它們擋得住誰、擋不住誰

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-and-threat-model.md](./00-course-map-and-threat-model.md) | 課程地圖、威脅模型、加密能與不能 |
| 01 | [01-image-format-and-magic-number.md](./01-image-format-and-magic-number.md) | PNG/JPEG/WebP 結構與檔頭辨識 |
| 02 | [02-xor-encryption.md](./02-xor-encryption.md) | XOR 全檔加密：最簡單可上線方案 |
| 03 | [03-header-scramble.md](./03-header-scramble.md) | 只加密檔頭：效能與安全的平衡點 |
| 04 | [04-aes-with-webcrypto.md](./04-aes-with-webcrypto.md) | AES-GCM / AES-CTR + WebCrypto API、key 管理 |
| 05 | [05-rust-wasm-toolchain.md](./05-rust-wasm-toolchain.md) | Rust + wasm-pack 環境與第一個 wasm |
| 06 | [06-wasm-decryption-in-browser.md](./06-wasm-decryption-in-browser.md) | 用 WASM 做圖片解密與效能對比 |
| 07 | [07-canvas-rendering-and-hardening.md](./07-canvas-rendering-and-hardening.md) | Canvas 渲染、反爬、Key 動態下發 |
| 08 | [08-capstone-full-system.md](./08-capstone-full-system.md) | 畢業專題：完整系統整合 |

---

## 學習路徑建議

```
基礎篇 (00-01) ──→ 入門加密 (02-03)
                          │
                          ├─→ 強加密 (04 AES)
                          │
                          └─→ 進階防禦 (05-07 WASM + Canvas + 反爬)
                                       │
                                       └─→ 整合 (08 畢業專題)
```

- **趕時間想立刻上線**：00 → 01 → 04 → 07。用 04 章的 WebCrypto 全檔 AES-GCM，加上 07 章的 key 下發與反爬，就是一套堪用的方案（07 章元件裡的 WASM 解密可以換成 04 章的 WebCrypto 版）。
- **完整學完**：依序看完，會建立「圖片格式 → 加密演算法 → WASM → 反爬」的完整心智模型。
- **只想學 WASM**：可從 05 開始，前面當補充材料。

---

## 實作專案

教材對應的可跑專案放在：

| 路徑 | 內容 | 對應章節 |
|------|------|---------|
| [`backend/`](./backend/) | Node.js + Express 後端 | Ch02–Ch04 各一個 example 腳本 + Ch08 capstone server |
| [`frontend/`](./frontend/) | 純 HTML + ES Module 前端 | Ch02–Ch06 各一個 demo 頁 + Ch07/08 的 `<secure-image>` 元件與圖庫 |
| [`frontend/wasm-crypto/`](./frontend/wasm-crypto/) | Rust 原始碼，編譯成 wasm | Ch05–Ch08 |

### 5 分鐘快速啟動

```bash
# 1. 後端
cd backend
npm install

# 2. 編 wasm（Ch05 後才需要；Ch02–04 可跳過）
cd ../frontend/wasm-crypto
wasm-pack build --target web --release --out-dir ../pkg

# 3. 啟動整合版（Chapter 08）
cd ../../backend
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run start

# 打開 http://localhost:3000/
```

### 跑單章 demo

```bash
cd backend
npm run ch02   # Chapter 02 - XOR
npm run ch03   # Chapter 03 - 檔頭 AES-CTR（Chapter 06 也用這支）
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm run ch04   # Chapter 04 - AES-GCM + 簽名 URL
```

每個 demo 啟動後到 `http://localhost:3000/` 入口頁，從那邊點對應章節即可。

---

## 預設工具

| 用途 | 主推 | 備選 |
|------|------|------|
| 後端 | Node.js 20+ / Express | Fastify、Koa |
| 上傳驗證 | 用 magic number 自己判斷格式（`backend/lib/image-format.js`） | `sharp`（需要重新編碼、去除 metadata、產生縮圖時） |
| 前端 | 純 HTML + ES Module（不需打包） | Vite、React / Vue 都可 |
| WASM 語言 | Rust + `wasm-pack` | AssemblyScript |
| WASM 載入 | `wasm-bindgen` 產生的 `init()`（wasm-pack 自動產生） | 原生 `WebAssembly.instantiate` |

---

## 你將會得到

- 一套能跑起來的圖片保護系統（前後端 + WASM），以及「真的上線前還要補什麼」的清單。
- 從位元組到瀏覽器渲染的完整心智模型。
- 判讀漫畫站、電商等站點圖片防爬手法的能力：它用了哪一層、擋得住誰。
- 一份能放進履歷的 capstone 專題：可上傳、可加密、可分權限解密的圖片庫。

---

## 重要前置觀念

> ⚠️ **前端加密的本質是「提高逆向成本」，不是「絕對安全」**

只要圖片能在瀏覽器上顯示，理論上一定能被擷取（截圖、Canvas readback、記憶體 dump）。
而且瀏覽器要解密，就一定拿得到 key——前端加密擋的是「不登入就能大量下載」，擋不住「已登入的帳號自己動手」。
我們的目標是讓對手付出**不划算**的成本，而不是讓他做不到。請在學前先建立這個心態。

---

建議從 [00-course-map-and-threat-model.md](./00-course-map-and-threat-model.md) 開始。
