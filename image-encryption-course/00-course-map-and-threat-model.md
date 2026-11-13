# 第 00 章：課程地圖、威脅模型與加密能與不能

> **學習目標**：建立「圖片加密能防什麼、不能防什麼」的正確心態，並跑通一個最小可運行範例。
> **預計時數**：60 分鐘
> **先備知識**：Node.js 基礎、瀏覽器 fetch API

---

## 1 為什麼前端要加密圖片？

來看幾個真實場景：

| 場景 | 痛點 |
|------|------|
| 漫畫付費平台 | 整本被爬蟲抓走 → 流到盜版站 |
| 線上教育 | 課程截圖被搬運到 YouTube |
| 電商商品圖 | 被競品爬走、加 logo 後重新上架 |
| 線上考試 | 試題圖片被即時 OCR、傳到答題群 |
| 內部後台 | 客戶資料截圖外流 |

這些場景共通點：**圖片必須被瀏覽器顯示，但又不希望「容易被存下來」**。

> 注意「容易」兩個字。前端加密不是要做到絕對防禦，而是讓「右鍵另存」「F12 找 src」「`curl` 拉圖」這些 30 秒就能完成的事，變成「要登入、要讀懂解密流程、要寫腳本」才做得到。能拉高多少成本，取決於 key 怎麼交到瀏覽器手上——這是整門課反覆會回來看的重點。

---

## 2 威脅模型：你的對手分幾級？

設計加密系統前，永遠先問：「我在防誰？」

### Level 0 — 路人 / 不懂技術的使用者

- 行為：右鍵另存、拖曳到桌面
- 對策：`oncontextmenu="return false"`、CSS `user-select: none`、`<img>` 改 `background-image`
- 成本：5 分鐘

> 截圖不在任何一級的防禦範圍內：畫面看得到，就截得到。對付截圖只能靠浮水印追蹤（第 07 章）。

### Level 1 — 一般爬蟲開發者

- 行為：F12 看 Network、寫 `requests.get(url)` 拉圖
- 對策：URL 簽名、Referer 檢查、防盜鏈、`<img>` 改成 `fetch` + Blob
- 成本：半天

### Level 2 — 有耐心的逆向工程師 / 已登入的爬蟲

- 行為：讀 JS、看 Network 面板找 key、找解密函式、本地 patch 直接拿明文；或用正常帳號登入後，以 headless 瀏覽器大量瀏覽
- 對策：key 不以明文經過 JS（第 06 章）、依帳號限流與監控（第 07 章）、伺服器端浮水印追蹤
- 成本：數小時到數天，看 key 的派發方式而定

### Level 3 — 國家級對手 / 內賊

- 行為：改瀏覽器、dump 記憶體、改 GPU driver
- 對策：基本上**沒辦法防**。改走法務、浮水印、追蹤外流源頭
- 成本：天文數字

**本課程主要對抗 Level 1 和 Level 2**。Level 0 太簡單不值得學，Level 3 不是技術問題。

---

## 3 一張圖認識整個加密管線

```text
┌──────────────────────────────────────────────────────┐
│                       後端                            │
│                                                       │
│  原圖.jpg ──→ [加密器] ──→ 密文.bin + meta.json       │
│              (XOR/AES)                                │
│                                                       │
│  meta.json 含：algorithm, iv, key_id, format ...      │
└──────────────┬───────────────────────────────────────┘
               │  HTTPS（含簽名 URL / Token）
               ▼
┌──────────────────────────────────────────────────────┐
│                       前端                            │
│                                                       │
│  fetch(密文.bin) ──→ ArrayBuffer                      │
│         │                                             │
│         ▼                                             │
│  [WASM 解密器]  ←── Key（由介面動態取得）             │
│         │                                             │
│         ▼                                             │
│  解密後的 ArrayBuffer (還是 JPEG/PNG bytes)           │
│         │                                             │
│         ▼                                             │
│  Blob ──→ URL.createObjectURL ──→ <img>/Canvas        │
│                                                       │
└──────────────────────────────────────────────────────┘
```

四個關鍵元件：

1. **後端加密器**：負責把原圖變成密文。
2. **Key 派發機制**：使用者通過驗證後才拿得到 key。
3. **前端解密器**：在記憶體中還原圖片，**永遠不要把明文存到磁碟**。
4. **渲染層**：用 `<img>` + Blob URL，或進階用 Canvas。

---

## 4 四條鐵則（會在每章重複出現）

### 鐵則 1：Key 不能寫死在 JS

```js
// ❌ 等於沒加密
const KEY = 'mysecretkey123';

// ✅ 透過 API 動態下發，且綁定使用者
const KEY = await fetch('/api/image-key?token=' + userToken).then(r => r.text());
```

### 鐵則 2：解密在記憶體中完成，產出 Blob URL

```js
// ❌ 把解密後的檔案存下來
fs.writeFileSync('decrypted.jpg', plainBytes);

// ✅ 只放在記憶體
const blob = new Blob([plainBytes], { type: 'image/jpeg' });
const url = URL.createObjectURL(blob);
img.src = url;
// 用完釋放
img.onload = () => URL.revokeObjectURL(url);
```

### 鐵則 3：WASM 藏的是「怎麼解」，藏不住「交給它的 key」

純 JS 寫的解密邏輯：對手用 Chrome DevTools 設 breakpoint，幾分鐘就看懂演算法。
WASM 寫的解密邏輯：對手要讀 wasm 指令才看得懂演算法，成本高很多。

但如果 key 是從 API 以明文 JSON 拿到、再交給 WASM，對手在 Network 面板就看得到 key，根本不用讀 WASM。
WASM 只有在「key 不以明文出現在 JS」時才真正拉高成本，第 06 章會實際比較。

### 鐵則 4：加密強度 ≠ 系統安全

最強的 AES 配上「JS 裡寫死 key」就是免費贈送。
系統安全是 **加密 + Key 管理 + 反爬 + Referer + 簽名 URL** 的綜合工程。

---

## 5 環境準備

跑通本課程需要這些工具：

```bash
# Node.js（建議 20+）
node -v        # v20.x

# Rust（章節 05 開始才需要）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustc --version

# wasm-pack（章節 05 開始）
cargo install wasm-pack
wasm-pack --version

# 本章 Hello World 只需要 express
mkdir image-enc-course && cd image-enc-course
npm init -y
npm install express
```

> 第 02 章之後改用課程附的 [`backend/`](./backend/)，在那裡 `npm install` 就會裝好所有後端套件。
> Rust 從第 05 章才需要；不想裝的話，可以先讀第 05、06 章理解概念，第 02–04 章的 demo 都不依賴 Rust。

---

## 6 Hello World：跑通最小 demo

我們先做最簡單的 XOR 加密（後面會講原理），驗證環境沒問題。

### 6.1 後端：產出一張加密圖

新建檔案 `server.js`：

```js
// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const KEY = 0x5A;  // 任意一個 byte

// 啟動時把 sample.jpg 加密成 sample.enc
const raw = fs.readFileSync(path.join(__dirname, 'sample.jpg'));
const enc = Buffer.alloc(raw.length);
for (let i = 0; i < raw.length; i++) {
  enc[i] = raw[i] ^ KEY;
}
fs.writeFileSync(path.join(__dirname, 'sample.enc'), enc);

app.use(express.static('.'));
app.get('/api/key', (_req, res) => res.json({ key: KEY }));

app.listen(3000, () => console.log('http://localhost:3000'));
```

放一張 `sample.jpg` 到同目錄，啟動：

```bash
node server.js
```

### 6.2 前端：抓密文 → 解密 → 顯示

新建 `index.html`：

```html
<!DOCTYPE html>
<html>
<body>
  <h2>解密前（瀏覽器看到的是亂碼）</h2>
  <img id="bad" src="/sample.enc" width="300" />

  <h2>解密後</h2>
  <img id="good" width="300" />

  <script>
  (async () => {
    const [keyRes, encRes] = await Promise.all([
      fetch('/api/key').then(r => r.json()),
      fetch('/sample.enc').then(r => r.arrayBuffer())
    ]);

    const KEY = keyRes.key;
    const enc = new Uint8Array(encRes);
    const dec = new Uint8Array(enc.length);

    for (let i = 0; i < enc.length; i++) {
      dec[i] = enc[i] ^ KEY;
    }

    const blob = new Blob([dec], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const good = document.getElementById('good');
    good.onload = () => URL.revokeObjectURL(url);   // 鐵則 2：用完就釋放
    good.src = url;
  })();
  </script>
</body>
</html>
```

打開 `http://localhost:3000`，你應該看到：

- **上方**：破圖（瀏覽器拿到的是 `.enc` 二進位，無法辨識成 JPEG）
- **下方**：正常顯示

打開 DevTools，會發現：
- Network 面板裡的 `sample.enc` 是一串無法辨識的二進位
- Elements 面板裡下方 `<img>` 的 src 是 `blob:http://localhost:3000/uuid...`
- Network 面板裡 `/api/key` 的回應直接寫著 key——這是下一節第一個要修的弱點

**這就是前端圖片加密的完整最小骨架。**

---

## 7 看穿這個 Hello World 的弱點

我故意做得很爛，這樣你能看出問題：

| 弱點 | 對應的攻擊 | 在哪章修復 |
|------|------------|------------|
| Key 是 GET `/api/key` 公開取得 | 任何爬蟲拿到 URL 就能解密 | [第 07 章](./07-canvas-rendering-and-hardening.md) |
| Key 只有 1 byte | 暴力破解 256 次就還原；JPEG 開頭固定是 `FF`，其實 1 次就猜到 | [第 02 章](./02-xor-encryption.md) |
| 整檔逐 byte 在主執行緒解密 | 大圖、多圖時占用主執行緒 | [第 03 章](./03-header-scramble.md)、[第 04 章](./04-aes-with-webcrypto.md) |
| XOR 本身就不安全 | 知道一小段明文就能推出 key | [第 04 章](./04-aes-with-webcrypto.md) |
| 解密邏輯在純 JS | 對手設 breakpoint 就看懂流程 | [第 06 章](./06-wasm-decryption-in-browser.md) |

接下來的章節會逐一修復。

---

## 8 本章重點回顧

- 前端圖片加密的本質是「提高逆向成本」，不是「絕對安全」。
- 永遠先定義威脅模型，再選方案——對抗 Level 1 和 Level 2 最划算。
- 完整管線：**後端加密 → Key 派發 → 前端解密 → Blob 渲染**。
- 四條鐵則：Key 不能寫死、明文只在記憶體、WASM 藏得住演算法但藏不住明文 key、加密強度 ≠ 系統安全。

---

**下一章**：[01-image-format-and-magic-number.md](./01-image-format-and-magic-number.md) — PNG/JPEG/WebP 結構，「只加密檔頭」要加密到哪裡才算數
