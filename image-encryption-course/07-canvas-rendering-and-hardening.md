# 第 07 章：Canvas 渲染、反爬、Key 動態下發

> **學習目標**：把解密後的圖渲染到 Canvas 而非 `<img>`、設計多層 key 派發、加上反爬與反 DevTools 防禦。
> **預計時數**：120 分鐘
> **先備知識**：[[04-aes-with-webcrypto]]、[[06-wasm-decryption-in-browser]]

> **本章對應專案**
>
> | 檔案 | 用途 |
> |------|------|
> | [`frontend/secure-image.js`](./frontend/secure-image.js) | `<secure-image>` Web Component：sign URL → WASM 解密 → Canvas + 浮水印 |
> | [`backend/server.js`](./backend/server.js) | 已實作簽名 URL、Rate Limit、permission check |
>
> 本章邏輯整合到 Chapter 08 capstone 一起跑：
> ```bash
> cd backend
> MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
> JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
>   npm run start
> ```
> 打開 `http://localhost:3000/login.html`，註冊後上傳圖片即可看到 `<secure-image>` 渲染效果。

---

## 1 為什麼要用 Canvas 而不是 `<img>`?

到目前為止我們都用 `<img src="blob:...">`，這已經比 `<img src="/img.jpg">` 安全很多。但仍有幾個弱點：

| 攻擊 | `<img>` + Blob | Canvas |
|------|---------------|--------|
| 右鍵另存 | 可（會存到 blob 內容） | ❌（沒有右鍵選單支援） |
| 拖曳到桌面 | 可 | ❌ |
| DevTools 看 Elements 拿到 blob URL | 可 | 拿不到原始 byte |
| 截圖 | 可 | 可（防不了） |

Canvas 的優勢：**沒有 `src` 屬性可被使用者操作**。原始 byte 只在記憶體，不會以 URL 形式存在 DOM。

> 警告：Canvas 也防不了截圖。如同 [[00-course-map-and-threat-model]] 鐵則 4，沒有絕對安全。

---

## 2 三種 Canvas 渲染方式

### 2.1 方式 A：`drawImage(Image)` —— 仍會建立 Blob URL

```js
const blob = new Blob([plainBytes], { type: 'image/jpeg' });
const url = URL.createObjectURL(blob);
const img = new Image();
img.onload = () => {
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
};
img.src = url;
```

問題：URL 還是會短暫存在，能被攔截。

### 2.2 方式 B：`createImageBitmap(Blob)` —— 不暴露 URL

```js
const blob = new Blob([plainBytes], { type: 'image/jpeg' });
const bitmap = await createImageBitmap(blob);
ctx.drawImage(bitmap, 0, 0);
bitmap.close();   // 主動釋放 GPU 記憶體
```

**沒有 URL，更安全。** 推薦做法。

### 2.3 方式 C：自己解碼像素資料

最極端：自己用 JPEG/PNG decoder 解出 RGBA，直接寫進 `ImageData`。
這已經接近重寫瀏覽器圖片解碼器，性價比極低，不推薦。

---

## 3 完整範例：WASM 解密 + ImageBitmap + Canvas

```html
<!DOCTYPE html>
<body>
  <canvas id="cv" width="800" height="600"></canvas>
  <script type="module">
    import init, { aes_ctr_decrypt_header } from './pkg/img_crypto.js';
    await init();

    const canvas = document.getElementById('cv');
    const ctx = canvas.getContext('2d');

    async function showImage(id) {
      const [meta, encBuf] = await Promise.all([
        fetch(`/api/image/${id}/key`).then(r => r.json()),
        fetch(`/api/image/${id}.enc`).then(r => r.arrayBuffer())
      ]);

      const buf = new Uint8Array(encBuf);
      aes_ctr_decrypt_header(
        buf,
        hexToBytes(meta.keyHex),
        hexToBytes(meta.ivHex),
        meta.headerLen
      );

      const blob = new Blob([buf], { type: meta.mime });
      const bitmap = await createImageBitmap(blob);

      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    }

    showImage('abc123');

    // 禁止右鍵
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  </script>
</body>
```

打開 DevTools Elements，會看到 `<canvas>` 但找不到 src 或 blob URL。

---

## 4 阻止 `canvas.toDataURL()` 偷圖

對手仍可在 console 裡：

```js
document.querySelector('canvas').toDataURL();
```

直接拿到 base64 圖片。

### 解法 1：在 Canvas 加浮水印

最簡單：把使用者 ID / 時間戳 半透明蓋上去。即使被偷，可以追蹤到外流者。

```js
ctx.drawImage(bitmap, 0, 0);
ctx.fillStyle = 'rgba(255,255,255,0.05)';
ctx.font = '14px sans-serif';
for (let y = 0; y < canvas.height; y += 60) {
  for (let x = 0; x < canvas.width; x += 200) {
    ctx.fillText(`uid:${userId} ${new Date().toISOString()}`, x, y);
  }
}
```

### 解法 2：CORS 染色

如果 canvas 載入過跨域圖（沒 `crossorigin` 屬性），會被瀏覽器標記成 tainted，`toDataURL()` 直接拋錯。
但這對自家圖片無效，因為都同源。

### 解法 3：covering Hook

```js
// 啟動時改寫
const orig = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(...args) {
  console.warn('toDataURL blocked');
  return 'data:,';   // 回傳空字串
};
```

但對手能在自己的 console 把它改回來。**不要把這當主防禦**，只當勸退普通使用者。

### 解法 4：分塊渲染

把圖切成 8×8 的小塊，每塊用不同 transform 隨機位移，渲染時拼回去。對手 `toDataURL` 拿到的是「打亂版」。
這在某些漫畫站見過——副作用是渲染慢、效果有限。

---

## 5 Key 動態下發完整設計

回顧 [[04-aes-with-webcrypto]] 提的策略 C，現在實作完整版。

### 5.1 流程圖

```text
[使用者登入]
    ↓
取得 JWT (含 userId, role, exp)
    ↓
[要看圖 X]
    ↓
GET /api/image/X/sign  (Authorization: Bearer JWT)
    ↓
伺服器：
  - 驗 JWT
  - 確認 userId 有權限看 image X
  - 產生 signed URL: /api/image/X/key?u=...&exp=...&sig=...
    ↓
GET 該 signed URL
    ↓
伺服器：
  - 驗 sig（HMAC）
  - 檢查 exp 是否過期
  - 回傳 keyHex
    ↓
WASM 解密 + Canvas 渲染
```

### 5.2 伺服器（接 [[04-aes-with-webcrypto]] 的雛形擴充）

```js
// server.js
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'demo-secret';

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).end();
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).end();
  }
}

// 模擬登入
app.post('/api/login', (req, res) => {
  // 真實系統：req.body.username/password 驗 DB
  const token = jwt.sign({ userId: 'u1', role: 'paid' }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ token });
});

// 簽 short-lived key URL
app.get('/api/image/:id/sign', requireAuth, (req, res) => {
  const meta = load()[req.params.id];
  if (!meta) return res.status(404).end();

  // 權限檢查（真實場景連 DB）
  if (meta.requiredRole === 'paid' && req.user.role !== 'paid') {
    return res.status(403).end();
  }

  const exp = Date.now() + 60 * 1000;   // 60 秒有效
  const payload = `${req.params.id}|${req.user.userId}|${exp}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');

  res.json({
    keyUrl: `/api/image/${req.params.id}/key?u=${req.user.userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${req.params.id}.enc`
  });
});

app.get('/api/image/:id/key', (req, res) => {
  const { u, exp, sig } = req.query;
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(sig), 'hex'))) {
    return res.status(403).json({ error: 'bad sig' });
  }

  const meta = load()[req.params.id];
  // ... 解 wrappedKey，回傳 keyHex (見 04 章)
  res.json({ keyHex: meta.keyHex, ivHex: meta.ivHex, ... });
});
```

### 5.3 前端

```js
async function loadImage(id, jwt) {
  // 1. 拿簽名 URL
  const { keyUrl, encUrl } = await fetch(`/api/image/${id}/sign`, {
    headers: { Authorization: `Bearer ${jwt}` }
  }).then(r => r.json());

  // 2. 並行取 key + 密文
  const [meta, encBuf] = await Promise.all([
    fetch(keyUrl).then(r => r.json()),
    fetch(encUrl).then(r => r.arrayBuffer())
  ]);

  // 3. WASM 解密
  const buf = new Uint8Array(encBuf);
  aes_ctr_decrypt_header(buf, ...);

  // 4. Canvas 渲染
  const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // 5. 用完立刻清明文
  buf.fill(0);
}
```

### 5.4 為什麼簽名 URL 這麼安全？

- **時間限制**：60 秒後 key 換新，舊的爬蟲腳本作廢
- **userId 綁定**：對手拿到別人的 key URL 也只能解屬於該 user 的圖
- **HMAC 簽名**：對手無法自己偽造 URL
- **不可枚舉**：對手無法用 `/api/image/N/key` 跑迴圈拿全部 key

---

## 6 反爬蟲與反 DevTools

### 6.1 Referer / Origin 檢查

```js
app.use((req, res, next) => {
  if (req.path.startsWith('/api/image/')) {
    const origin = req.headers.origin || req.headers.referer;
    if (!origin || !origin.startsWith('https://your-site.com')) {
      return res.status(403).end();
    }
  }
  next();
});
```

> 缺點：對手用 headless browser 跑頁面，Referer 就是合法的。所以這層只擋無腦爬蟲。

### 6.2 Rate Limit

```js
const rateLimit = require('express-rate-limit');
app.use('/api/image/', rateLimit({
  windowMs: 60 * 1000,
  max: 30,         // 每分鐘 30 張
  standardHeaders: true,
}));
```

爬蟲想拉 1000 張，要 33 分鐘——通常就放棄了。

### 6.3 偵測 DevTools 打開

```js
let devtoolsOpen = false;

setInterval(() => {
  const before = performance.now();
  debugger;   // 開了 DevTools 時這行會卡很久
  const elapsed = performance.now() - before;
  if (elapsed > 100) {
    devtoolsOpen = true;
    showWarning();
    // 可以選擇：拒絕解密、跳警告、loggin 給後端
  }
}, 1000);
```

> 缺點：誤判率高（瀏覽器分頁切換也會卡）。建議只當作「警告」，不要當決定性條件。

### 6.4 偵測爬蟲特徵

```js
// Headless Chrome 沒有 chrome.runtime
if (!window.chrome || !window.chrome.runtime) {
  // 可疑
}

// 沒裝 plugin
if (navigator.plugins.length === 0) {
  // 可疑
}

// User-Agent 含 "HeadlessChrome"
if (/HeadlessChrome/.test(navigator.userAgent)) {
  // 確定是爬蟲
}
```

把可疑的請求標記，不直接拒絕（避免誤殺），而是回傳「降級畫質」或「打浮水印更猛」的版本。

---

## 7 額外加固：浮水印追蹤

如果圖片真的被截走，我們至少要能追到「是誰外流的」。

### 7.1 視覺浮水印（明顯）

如第 4 節，畫上 userId + 時間。對手肯定會去 PS 掉，但能擋住絕大多數人。

### 7.2 不可見浮水印（隱寫術）

在像素資料的 LSB（Least Significant Bit）裡寫 userId：

```js
const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
const data = imgData.data;
const wm = encodeUserIdToBits('u1');   // 例如 [1,0,1,1,0,...]

for (let i = 0; i < wm.length; i++) {
  // 改每個 pixel R channel 的最低位元
  data[i * 4] = (data[i * 4] & 0xFE) | wm[i];
}

ctx.putImageData(imgData, 0, 0);
```

肉眼看不出來（差 1/256 亮度），但用工具可解出 userId。

> 注意：截圖後若被 JPEG 重新壓縮，LSB 會被破壞。要用更穩健的 DCT 域浮水印（演算法較複雜，本課程不展開）。

---

## 8 整合：完整加密渲染元件

實際代碼在 [`frontend/secure-image.js`](./frontend/secure-image.js)，下面是教學精簡版：

```js
// 對應 frontend/secure-image.js
import init, { aes_ctr_decrypt_header } from '/pkg/img_crypto.js';
const wasmReady = init();

class SecureImage extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'closed' }); }
  static observedAttributes = ['image-id', 'jwt'];

  async attributeChangedCallback() {
    await wasmReady;
    const id = this.getAttribute('image-id');
    const jwt = this.getAttribute('jwt');
    if (!id || !jwt) return;

    const canvas = document.createElement('canvas');
    canvas.style.maxWidth = '100%';
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.shadowRoot.innerHTML = '';
    this.shadowRoot.appendChild(canvas);

    try {
      const { keyUrl, encUrl } = await fetch(`/api/image/${id}/sign`, {
        headers: { Authorization: `Bearer ${jwt}` }
      }).then(r => r.json());

      const [meta, encBuf] = await Promise.all([
        fetch(keyUrl).then(r => r.json()),
        fetch(encUrl).then(r => r.arrayBuffer())
      ]);

      const buf = new Uint8Array(encBuf);
      aes_ctr_decrypt_header(
        buf, hexToBytes(meta.keyHex), hexToBytes(meta.ivHex), meta.headerLen
      );

      const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);

      this.addWatermark(canvas, jwt);

      bitmap.close();
      buf.fill(0);
    } catch (e) {
      console.error(e);
    }
  }

  addWatermark(canvas, jwt) {
    const userId = JSON.parse(atob(jwt.split('.')[1])).userId;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.font = '13px sans-serif';
    for (let y = 30; y < canvas.height; y += 80) {
      for (let x = 0; x < canvas.width; x += 240) {
        ctx.fillText(`${userId} · ${Date.now()}`, x, y);
      }
    }
  }
}
customElements.define('secure-image', SecureImage);
```

使用（jwt 從 `localStorage` 取得，不必傳屬性）：

```html
<secure-image image-id="abc-123"></secure-image>
```

一行 HTML 完成「登入驗證 → 簽名 URL → 加密下載 → WASM 解密 → Canvas 渲染 → 浮水印」全流程。實際在 [`frontend/gallery.html`](./frontend/gallery.html) 用迴圈塞滿整個圖庫。

---

## 9 還有什麼能做？

到這裡，你的系統已經能擋 Level 1–2 對手。再往上的加固：

- **Service Worker 攔截**：在 SW 裡做解密，主執行緒完全拿不到明文 byte。
- **WebGL Texture upload**：解密後直接上傳 GPU texture，不經過 ImageBitmap。
- **Trusted Types**：限制 `src` 與 `innerHTML` 的可賦值來源。
- **Subresource Integrity (SRI)**：對 wasm 加 `integrity` hash，防被中間人換掉。

但這些屬於「過度設計」範疇，回到 [[00-course-map-and-threat-model]]：先定義對手，再加防禦。

---

## 10 動手作業

1. 把第 8 節 `<secure-image>` 整合到 [[02-xor-encryption]] 的 demo 頁面，把 `<img>` 全換掉。
2. 在 Canvas 上實作 LSB 浮水印，並寫個解碼器驗證能讀回 userId。
3. 用 Service Worker 攔截 `/api/image/*.enc`，在 SW 內解密後回傳明文給 `<img>`。這樣主執行緒看到的就是「正常 jpg」，攻擊面又小一層。

---

## 11 本章重點回顧

- 用 `createImageBitmap + Canvas` 取代 `<img src="blob:...">`，從 DOM 消除原始 URL。
- 防 `toDataURL`：浮水印 > Hook > 分塊渲染。
- Key 動態下發三要素：JWT 驗證、HMAC 簽名、短效時間。
- 反爬五道牆：Referer、Rate Limit、DevTools 偵測、Headless 偵測、Anti-Tamper。
- 浮水印是「外流追蹤」的最後一道防線——可見 + 隱寫雙保險。
- 任何防禦都不是絕對，但**疊起來的成本就是有效的**。

---

**下一章**：[08-capstone-full-system.md](./08-capstone-full-system.md) — 畢業專題：完整系統整合
