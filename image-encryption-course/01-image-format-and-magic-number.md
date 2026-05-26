# 第 01 章：圖片格式與檔頭辨識（Magic Number）

> **學習目標**：搞懂 PNG/JPEG/WebP 的二進位結構，理解為什麼「只改幾個 bytes」就能讓圖片變壞，並為後面的「檔頭打亂加密」打基礎。
> **預計時數**：90 分鐘
> **先備知識**：[[00-course-map-and-threat-model]]、十六進位概念

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

## 2 三大格式檔頭速查表

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

### 對加密的啟發

**只要破壞 SOI（前 2 byte），整個 JPEG 解碼器就罷工。**
但這也是雙面刃——對手只要試「在前面加 `FF D8`」就能還原大部分結構。
所以實務上會破壞 SOI + DQT + SOF0，至少 32–64 byte。

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

PNG 比 JPEG 難搞，因為：
- 改 chunk 內容會 CRC 對不上
- 嚴格的 PNG decoder 會拒絕 CRC 錯的 chunk

**所以對 PNG 加密時，建議把整個 IHDR + 第一個 IDAT 的 header 都破壞，並重算 CRC 或直接整檔加密。**

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

// 把前 8 byte XOR 一個隨機 key
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
00000000: bd9a bda2 4252 0824 4946 0001 ...
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

### 防止嗅探的兩種做法

1. **加上 `X-Content-Type-Options: nosniff`** — 強制不嗅探，但只對非 `<img>` 標籤的請求生效。
2. **改 byte（本課程主推）** — 釜底抽薪，連 sniff 都不會 match。

---

## 8 進階：找出「最少要改幾個 byte」

為了極致效能，我們想知道：**改第幾 byte 開始，瀏覽器就無法辨識？**

實驗：用二分搜尋逐 byte 嘗試。

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
| 8 byte | 破圖 |
| 32 byte | 破圖 |

> 對 JPEG 而言：**改前 2 byte（SOI）就夠了**。
> 但實務上會改 32–128 byte 以避開「對手猜 SOI」的攻擊（後面章節會講）。

對 PNG 而言：因為 chunk 有 CRC，建議至少破壞 IHDR 整個 chunk（前 33 byte）。

---

## 9 把這些觀念變成「加密策略」

回顧前面整理的，我們有 3 種策略可以選：

| 策略 | 加密範圍 | 效能 | 安全度 |
|------|----------|------|--------|
| A. 全檔加密 | 100% | 慢（要處理整檔） | 高 |
| B. 檔頭加密 | 前 N byte | 快（只處理 N byte） | 中 |
| C. 分段隨機加密 | 多個小段 | 中 | 高 |

| 場景 | 推薦 |
|------|------|
| 4K 商品圖（5MB+） | B（檔頭加密） |
| 漫畫單頁（200KB） | A 或 B 都行 |
| 機密合約照片 | C（多段） + AES |

下面三章會分別實作 A、B、C。

---

## 10 動手作業

完成本章前請做完這 3 個小作業：

1. 用 `xxd` 查看你電腦裡 5 張不同來源的圖片，能不能直接從 magic number 判斷格式？
2. 寫一段 Node.js 腳本，輸入任意檔案，自動印出格式（JPEG/PNG/WebP/Unknown）。
3. 把一張 PNG 的 IHDR 整個 chunk（byte 8 到 byte 32）全 XOR `0xAA`，存成 `.bin`。用瀏覽器嘗試開啟，記錄錯誤訊息。

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
- **破壞檔頭就足以讓瀏覽器無法解碼**——這是「檔頭加密」策略的基石。
- 防止 MIME sniffing 必須改真 byte，光改 `Content-Type` 沒用。
- 不同格式「最少破壞 byte 數」不同：JPEG 2 byte，PNG 建議 ≥32 byte。

---

**下一章**：[02-xor-encryption.md](./02-xor-encryption.md) — 最簡單的對稱加密：XOR 全檔方案
