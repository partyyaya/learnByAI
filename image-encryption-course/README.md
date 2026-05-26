# 前端圖片加密課程（含 Node.js 後端 + Rust WASM）

> 本課程面向「能寫 HTML/CSS/JS、會用 Node.js、但沒做過二進位處理」的前端工程師。
> 學完後你能：
> - 從 0 設計一套「伺服器加密 → 瀏覽器解密 → Canvas 渲染」的圖片保護流程
> - 寫出 4 種加密方案（XOR、檔頭打亂、AES-CTR、多層混合）並知道各自的取捨
> - 用 Rust 編譯出 `.wasm` 給瀏覽器調用，大幅提高逆向成本
> - 看穿任何站點的「圖片防爬」手法（從漫畫站、視頻封面到電商素材）

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-and-threat-model.md](./00-course-map-and-threat-model.md) | 課程地圖、威脅模型、加密能與不能 |
| 01 | [01-image-format-and-magic-number.md](./01-image-format-and-magic-number.md) | PNG/JPEG/WebP 結構與檔頭辨識 |
| 02 | [02-xor-encryption.md](./02-xor-encryption.md) | XOR 全檔加密：最簡單可上線方案 |
| 03 | [03-header-scramble.md](./03-header-scramble.md) | 只加密檔頭：效能與安全的平衡點 |
| 04 | [04-aes-with-webcrypto.md](./04-aes-with-webcrypto.md) | AES-CTR + WebCrypto API |
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

- **趕時間想立刻上線**：00 → 01 → 02 → 07，半天能搞定一套堪用的方案。
- **完整學完**：依序看完，會建立「圖片格式 → 加密演算法 → WASM → 反爬」的完整心智模型。
- **只想學 WASM**：可從 05 開始，前面當補充材料。

---

## 預設工具

| 用途 | 主推 | 備選 |
|------|------|------|
| 後端 | Node.js 20+ / Express | Fastify、Koa |
| 圖片處理 | `sharp` | `jimp` |
| 前端框架 | 純 HTML + Vite | React / Vue 都可 |
| WASM 語言 | Rust + `wasm-pack` | AssemblyScript |
| WASM 載入 | 原生 `WebAssembly.instantiate` | `wasm-bindgen` |

---

## 你將會得到

- 一套**真正可上線**的圖片保護方案（前後端 + WASM）。
- 從位元組到瀏覽器渲染的完整心智模型。
- 對 Bilibili、漫畫站、電商等站點圖片防爬手法的判讀能力。
- 一份能放進履歷的 capstone 專題：可上傳、可加密、可分權限解密的圖片庫。

---

## 重要前置觀念

> ⚠️ **前端加密的本質是「提高逆向成本」，不是「絕對安全」**

只要圖片能在瀏覽器上顯示，理論上一定能被擷取（截圖、Canvas readback、記憶體 dump）。
我們的目標是讓對手付出**不划算**的成本，而不是讓他做不到。請在學前先建立這個心態。

---

建議從 [00-course-map-and-threat-model.md](./00-course-map-and-threat-model.md) 開始。
