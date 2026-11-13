# 第 01 章：圖片格式與檔頭辨識（Magic Number）

> **學習目標**：搞懂 PNG/JPEG/WebP 的二進位結構，理解為什麼「只改幾個 bytes」就能讓圖片變壞，並為後面的「檔頭打亂加密」打基礎。
> **預計時數**：90 分鐘
> **先備知識**：[第 00 章](./00-course-map-and-threat-model.md)、十六進位概念

---

## 1 圖片在電腦裡到底是什麼？

打開任何一張 `.jpg`，本質上是一串 byte：

```text
FF D8 FF E0 00 10 4A 46 49 46 00 01 ... (數百萬個 byte) ... FF D9
```

瀏覽器收到這串 byte 後做兩件事：

1. **格式辨識（sniffing）**：看開頭幾個 byte，判斷「這是 JPEG 還是 PNG」。
2. **解碼**：依照對應規範解析後續 byte，輸出像素。

**只要第 1 步失敗，第 2 步就根本不會啟動，畫面顯示「破圖」。**

這就是「檔頭加密」能成立的根本原因。

---

## 2 常見格式檔頭速查表

| 格式 | Magic Number (hex) | 開頭幾 byte | 長度 |
|------|-------------------|-------------|------|
| JPEG | `FF D8 FF` | 通常是 `FF D8 FF E0` (JFIF) 或 `FF D8 FF E1` (Exif) | 3–4 bytes |
| PNG  | `89 50 4E 47 0D 0A 1A 0A` | 第 2-4 byte 是 ASCII `PNG` | 8 bytes |
| WebP | `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` | `RIFF....WEBP` | 12 bytes |
| GIF  | `47 49 46 38 (37/39) 61` | `GIF87a` 或 `GIF89a` | 6 bytes |
| AVIF | 第 5-12 byte 含 `ftypavif` | — | 12 bytes |

> 這張表記住前三個就好，95% 場景夠用。

### 用 `xxd` 驗證

```bash
$ xxd sample.jpg | head -1
00000000: ffd8 ffe0 0010 4a46 4946 0001 0101 0048  ......JFIF.....H

$ xxd sample.png | head -1
00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  .PNG........IHDR
```

清楚可見。`8950 4e47` 就是 `\x89PNG`。

---

## 3 JPEG 結構深入

JPEG 不像 PNG 那樣由「chunk」組成，而是由一連串 **marker** 構成。

每個 marker 都以 `0xFF` 開頭：

```text
FF D8           SOI (Start of Image)
FF E0 [length]  APP0 - JFIF 標頭
FF DB [length]  DQT - 量化表
FF C0 [length]  SOF0 - 影像基本資訊（寬高、色彩）
FF C4 [length]  DHT - 霍夫曼表
FF DA [length]  SOS - Start of Scan，之後是壓縮資料
...壓縮資料...
FF D9           EOI (End of Image)
```

```text
┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐ ┌────────┐
│  SOI   │ │  APP0  │ │  DQT   │ │   SOS+data   │ │  EOI   │
│ FF D8  │ │ FF E0  │ │ FF DB  │ │ FF DA ...    │ │ FF D9  │
└────────┘ └────────┘ └────────┘ └──────────────┘ └────────┘
```

實際看一張 JPEG 的 marker 位置（macOS 內建桌布 `DefaultAerial.jpg`）：

```text
SOI@0  APP0@2  APP14@20  DQT@36(長 132)  SOF0@170  DHT@189(長 418)  SOS@609
```

解碼真正需要的是 **DQT（量化表）、DHT（霍夫曼表）、SOF（寬高）、SOS**，這張圖要到第 623 byte 才全部結束。
手機拍的照片更誇張：SOI 後面緊接著 APP1（Exif，常含一張縮圖）和 APP2（ICC 色彩描述檔），動輒幾 KB 到幾十 KB，DQT 往往在好幾 KB 之後才出現。

### 對加密的啟發

**只要破壞 SOI（前 2 byte），瀏覽器就認不出這是 JPEG。**
但這也是雙面刃——對手只要「在前面補回 `FF D8`」，或乾脆把前面壞掉的部分丟掉、從下一個完整的 marker 開始接，就能還原。
所以加密範圍要以「解碼器需要的表格」為準：**至少要蓋到 SOS 結束**。只加密固定的前 32–64 byte，對一般 JPEG 只蓋到 APP0 和半個 DQT；對手機照片則只蓋到 Exif。第 03 章會依每張圖實際的 SOS 位置計算加密範圍。

---

## 4 PNG 結構深入

PNG 比 JPEG 規範漂亮很多，由 **chunk** 組成：

```text
89 50 4E 47 0D 0A 1A 0A        ← 8 byte signature
[IHDR chunk]                    ← 必須是第一個 chunk，存寬高/位元深度
[IDAT chunk] (可多個)           ← 壓縮後的像素資料
[IEND chunk]                    ← 結尾
```

每個 chunk 結構：

```text
┌───────────┬───────────┬─────────────┬───────────┐
│ Length    │ Type      │ Data        │ CRC32     │
│ (4 byte)  │ (4 byte)  │ (Length)    │ (4 byte)  │
└───────────┴───────────┴─────────────┴───────────┘
```

### 對加密的啟發

CRC 對加密方是好事：chunk 內容一被改，CRC 就對不上，瀏覽器的 PNG 解碼器會直接拒絕。
但 PNG 的開頭**高度可預測**，這才是麻煩：

- 前 8 byte 的 signature 是固定的
- IHDR 的 length 固定是 13、type 固定是 `IHDR`
- 寬、高可以從網頁上顯示的尺寸猜，位元深度、色彩類型通常就那幾種
- 猜完還能用 IHDR 的 CRC 驗證猜得對不對

所以只加密前 33 byte（signature + IHDR）時，對手可以把檔頭整個重建回來。
**加密範圍要蓋過 IHDR、PLTE 等前置 chunk，一路到第一個 IDAT 的壓縮資料開頭之後**，或直接整檔加密。

---

## 5 WebP 結構（順帶一提）

WebP 基於 RIFF 容器：

```text
RIFF [size:4] WEBP [chunks...]
```

`size` 是「除掉前 8 byte 的剩餘大小」。改它會讓 decoder 直接失敗。

---

## 6 動手實驗：手動破壞 + 修復

讓我們親手感受「檔頭破壞」的威力。

### 6.1 用 Node.js 破壞前 8 byte

```js
// break.js
const fs = require('fs');
const buf = fs.readFileSync('sample.jpg');

// 把前 8 byte XOR 一個固定的 key
const KEY = 0x42;
for (let i = 0; i < 8; i++) {
  buf[i] = buf[i] ^ KEY;
}

fs.writeFileSync('broken.jpg', buf);
console.log('已破壞，請用瀏覽器/檢視器開啟 broken.jpg 看效果');
```

跑完：

```bash
$ node break.js
$ xxd broken.jpg | head -1
00000000: bd9a bda2 4252 0804 4946 0001 ...
```

對比原本的 `ffd8 ffe0 0010 4a46`——前 8 byte 完全變了。

雙擊 `broken.jpg`：
- macOS Preview：紅色驚嘆號
- Chrome：破圖
- Photoshop：「無法解析檔案」

### 6.2 還原

把同樣的程式跑一次就還原了（XOR 對稱性）：

```js
// restore.js
const fs = require('fs');
const buf = fs.readFileSync('broken.jpg');
const KEY = 0x42;
for (let i = 0; i < 8; i++) {
  buf[i] = buf[i] ^ KEY;
}
fs.writeFileSync('restored.jpg', buf);
```

開 `restored.jpg`，恢復正常。

> 這個小實驗就是後面所有加密方案的**最小骨架**：破壞 N byte → 傳輸 → 還原。

---

## 7 一個常見的陷阱：瀏覽器的「內容嗅探」

你可能會問：「我都改 `Content-Type: application/octet-stream` 了，瀏覽器還能猜到是圖片嗎？」

**會的。** 這就是 Chrome / Safari 的 MIME sniffing：

```text
Content-Type: application/octet-stream   ← 伺服器宣告
但前 8 byte 是 89 50 4E 47 ...
→ 瀏覽器判斷「這還是 PNG」，照常渲染
```

所以光改 `Content-Type` 沒用，**必須真的把 byte 改掉**。

### 兩種做法的差別

1. **加上 `X-Content-Type-Options: nosniff`** — 這個 header 主要約束 `<script>`、`<link rel=stylesheet>` 這類請求（MIME 不符就拒絕）；對 `<img>`，瀏覽器仍然會依內容判斷是不是圖片。而且它只影響瀏覽器，用 `curl` 下載的人根本不看 header。
2. **改 byte（本課程主推）** — 釜底抽薪，不管誰拿到檔案，看到的都不是合法圖片。

---

## 8 進階：找出「最少要改幾個 byte」

為了極致效能，我們想知道：**改前幾個 byte，瀏覽器就無法辨識？**

實驗：產生一組「破壞前 n byte」的檔案，逐一用瀏覽器打開。

```js
// find-min-break.js
const fs = require('fs');
const original = fs.readFileSync('sample.jpg');

function corruptFirstN(n) {
  const copy = Buffer.from(original);
  for (let i = 0; i < n; i++) {
    copy[i] = copy[i] ^ 0xFF;
  }
  fs.writeFileSync(`break-${n}.jpg`, copy);
}

[1, 2, 3, 4, 8, 16, 32].forEach(corruptFirstN);
```

實驗結果（用 Chrome 開啟）：

| 破壞 byte 數 | Chrome 渲染結果 |
|--------------|-----------------|
| 1 byte | 破圖（因為破到了 `FF D8` 的 `FF`） |
| 2 byte | 破圖 |
| 3 byte | 破圖 |
| 4 byte | 破圖 |
| 8 byte | 破圖 |
| 16 byte | 破圖 |
| 32 byte | 破圖 |

> 對 JPEG 而言：**改 1 byte 就足以讓瀏覽器顯示破圖**。
> 但「顯示破圖」和「對手還原不了」是兩回事：只破壞前幾 byte，對手補回 `FF D8` 就好了。要讓對手還原不了，加密範圍要蓋到 SOS 結束（第 3 節）。

對 PNG 而言也一樣：改 1 byte signature 就破圖，但要讓對手重建不了，加密範圍要蓋過 IHDR 到 IDAT 的壓縮資料（第 4 節）。

---

## 9 把這些觀念變成「加密策略」

回顧前面整理的，我們有 3 種策略可以選：

| 策略 | 加密範圍 | 計算量 | 安全度 |
|------|----------|--------|--------|
| A. 全檔加密 | 100% | 整檔都要處理（用瀏覽器內建 AES，5MB 約 2–3 ms） | 高 |
| B. 檔頭加密 | 檔頭 + 影像資料開頭一小段 | 只處理幾 KB | 中：其餘 byte 是明文，對手可能猜出或重建檔頭 |
| C. 分段加密 | 檔頭 + 幾個分散的小段 | 只處理幾 KB | 中：比 B 多一點工，本質相同 |

| 場景 | 推薦 |
|------|------|
| 一頁幾十張圖、解密只能用 JS / WASM 軟體實作 | B（檔頭加密） |
| 漫畫單頁（200KB） | A 或 B 都行 |
| 機密合約照片 | A（全檔 AES-GCM），機密內容不要留明文 |

第 02 章用 XOR、第 04 章用 AES-GCM 實作 A，第 03 章實作 B，C 留在第 03 章的作業。

---

## 10 動手作業

完成本章前請做完這 3 個小作業：

1. 用 `xxd` 查看你電腦裡 5 張不同來源的圖片，能不能直接從 magic number 判斷格式？
2. 寫一段 Node.js 腳本，輸入任意檔案，自動印出格式（JPEG/PNG/WebP/Unknown）。
3. 把一張 PNG 的 IHDR 整個 chunk（byte 8 到 byte 32）全 XOR `0xAA`，存成 `broken.png`。用瀏覽器嘗試開啟，記錄看到什麼；再想想：如果你是對手，要怎麼把 IHDR 猜回來？

> 作業 2 的參考答案：

```js
function detect(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'JPEG';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'PNG';
  if (buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP') return 'WEBP';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'GIF';
  return 'Unknown';
}
```

---

## 11 本章重點回顧

- 圖片在電腦裡就是 byte 串，瀏覽器靠 magic number 判斷格式。
- JPEG 由 marker 組成（`FF D8` 開頭，`FF D9` 結尾）；PNG 由 chunk 組成（有 CRC 保護）。
- **破壞檔頭就足以讓瀏覽器無法解碼**——但「破圖」不等於「還原不了」。
- 要讓對手還原不了，加密範圍要蓋到解碼器需要的所有表格：JPEG 到 SOS 結束、PNG 到 IDAT 的壓縮資料。手機照片的 Exif 可能有幾十 KB，固定的「前 N byte」不可靠。
- 光改 `Content-Type` 或加 `nosniff` 擋不住下載，必須真的改 byte。

---

**下一章**：[02-xor-encryption.md](./02-xor-encryption.md) — 最簡單的對稱加密：XOR 全檔方案
