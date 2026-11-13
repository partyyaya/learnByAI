# 第 07 章：Canvas 渲染、反爬、Key 動態下發

> **學習目標**：把解密後的圖渲染到 Canvas 而非 `<img>`、設計有身分驗證的 key 派發、加上反爬與浮水印，並清楚每一層擋得住誰。
> **預計時數**：120 分鐘
> **先備知識**：[第 04 章](./04-aes-with-webcrypto.md)、[第 06 章](./06-wasm-decryption-in-browser.md)

> **本章對應專案**
>
> | 檔案 | 用途 |
> |------|------|
> | [`frontend/secure-image.js`](./frontend/secure-image.js) | `<secure-image>` Web Component：sign URL → WASM 解密 → Canvas + 浮水印 |
> | [`backend/server.js`](./backend/server.js) | 已實作 JWT、簽名 URL、依帳號限流、權限檢查 |
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
| 右鍵另存 | 可（存下解密後的圖） | Chrome / Edge 的 canvas 右鍵選單也有「另存圖片」，要自己擋 `contextmenu` |
| 拖曳到桌面 | 可 | 不行 |
| DevTools Elements 拿到 blob URL | 可 | 沒有 URL 可拿 |
| console 呼叫 `toDataURL()` | — | 可（第 4 節） |
| 截圖 | 可 | 可（防不了） |

Canvas 的優勢：**沒有 `src` 屬性可被使用者操作**。原始 byte 只在記憶體，不會以 URL 形式存在 DOM。

> 警告：Canvas 也防不了截圖。如同 [第 00 章](./00-course-map-and-threat-model.md) 鐵則 4，沒有絕對安全。

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
bitmap.close();   // 主動釋放點陣圖佔用的記憶體
```

**沒有 URL，推薦做法。** 但要知道：對手只要先 hook `createImageBitmap` 或 `Blob` 建構式，一樣拿得到解密後的 bytes。

### 2.3 方式 C：自己解碼像素資料

最極端：自己用 JPEG/PNG decoder 解出 RGBA，直接寫進 `ImageData`。
這已經接近重寫瀏覽器圖片解碼器，成本極高、效益很低，不推薦。

---

## 3 完整範例：WASM 解密 + ImageBitmap + Canvas

接第 03 章的 API（`npm run ch03`）：

```html
<!DOCTYPE html>
<body>
  <canvas id="cv" width="800" height="600"></canvas>
  <script type="module">
    import init, { aes_ctr_decrypt } from '/pkg/img_crypto.js';
    await init();

    const canvas = document.getElementById('cv');
    const ctx = canvas.getContext('2d');

    async function showImage(id) {
      const [meta, encBuf] = await Promise.all([
        fetch(`/api/image/${id}/key`).then(r => r.json()),
        fetch(`/api/image/${id}.enc`).then(r => r.arrayBuffer())
      ]);

      const buf = new Uint8Array(encBuf);
      aes_ctr_decrypt(
        buf.subarray(0, meta.headerLen),   // 只傳檔頭那一段進 wasm
        hexToBytes(meta.keyHex),
        hexToBytes(meta.ivHex)
      );

      const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    }

    showImage('abc123');

    // Chrome / Edge 的 canvas 右鍵選單有「另存圖片」，擋掉
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
ctx.fillStyle = 'rgba(255,255,255,0.05)';   // 白色 5% 在淺色背景上幾乎看不到，依需求調整
ctx.font = '14px sans-serif';
for (let y = 0; y < canvas.height; y += 60) {
  for (let x = 0; x < canvas.width; x += 200) {
    ctx.fillText(`uid:${userId} ${new Date().toISOString()}`, x, y);
  }
}
```

### 解法 2：故意讓 Canvas 被「染色」

只要 canvas 畫過一張**跨來源、沒開 CORS** 的圖，瀏覽器就把它標成 tainted，之後 `toDataURL()`、`toBlob()`、`getImageData()` 全部丟 `SecurityError`。
自家的圖都同源，所以要「故意」染：從另一個網域載入一張 1×1 的透明 PNG（那個網域不回 `Access-Control-Allow-Origin`），畫到 canvas 角落。

```js
const pixel = new Image();
pixel.src = 'https://static.other-domain.example/1x1.png';   // 不同 origin、沒有 CORS header
await pixel.decode();
ctx.drawImage(pixel, 0, 0);       // 從這一刻起 canvas 就不能被讀出
```

代價：你自己也不能再 `getImageData()`，第 7.2 節的 LSB 浮水印要在染色之前做完。而且對手照樣能在畫上 canvas 之前攔到資料（第 2.2 節）。

### 解法 3：覆寫讀取方法

```js
// 啟動時改寫，toBlob、getImageData 也要一起處理
HTMLCanvasElement.prototype.toDataURL = function () {
  console.warn('toDataURL blocked');
  return 'data:,';   // 空白內容的 data URL
};
HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); };
```

但對手能在自己的 console 把它改回來（或從另一個 iframe 拿乾淨的原型）。**不要把這當主防禦**，只當勸退普通使用者。

### 解法 4：分塊渲染

伺服器把圖切成 8×8 格、打亂順序後才加密；前端解密後，照 meta 裡的順序把每一格畫回正確位置。

它防的是「直接拿到檔案」：就算對手解出 `.enc`，拿到的也是打亂的圖。
但 canvas 上畫的是**拼好的圖**，`toDataURL()` 拿到的也是拼好的圖。想讓 readback 也拿不到完整圖，得把圖拆到多個 canvas（每個只放一塊），對手就得一塊一塊讀再拼回去。
這在某些漫畫站見過——副作用是渲染變慢、程式變複雜。

---

## 5 Key 動態下發完整設計

回顧 [第 04 章](./04-aes-with-webcrypto.md) 提的策略 C，現在加上登入驗證。

### 5.1 流程圖

```text
[使用者登入]
    ↓
取得 JWT (含 userId, exp)
    ↓
[要看圖 X]
    ↓
GET /api/image/X/sign  (Authorization: Bearer JWT)
    ↓
伺服器：
  - 驗 JWT
  - 依帳號限流
  - 確認 userId 有權限看 image X
  - 產生 signed URL: /api/image/X/key?u=...&exp=...&sig=...
    ↓
GET 該 signed URL
    ↓
伺服器：
  - 驗 sig（HMAC）
  - 檢查 exp 是否過期
  - 解開包裝過的 key，回傳 keyHex（Cache-Control: no-store）
    ↓
WASM 解密 + Canvas 渲染
```

### 5.2 伺服器

以下摘自 [`backend/server.js`](./backend/server.js) 與 [`backend/lib/auth.js`](./backend/lib/auth.js)，註冊、登入（scrypt 雜湊密碼）見完整檔案：

```js
// JWT_SECRET 沒設就不啟動（auth.js）；簽 URL 的 key 從 MASTER_KEY 衍生，不跟 JWT 共用
const KEY_WRAP_KEY = deriveKey(MASTER_KEY, 'image-key-wrap');
const URL_SIGN_KEY = deriveKey(MASTER_KEY, 'key-url-sign');

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

  const exp = Date.now() + 60 * 1000;   // 60 秒有效
  const payload = `${img.id}|${req.user.userId}|${exp}`;
  const sig = hmacSign(URL_SIGN_KEY, payload);

  res.json({
    keyUrl: `/api/image/${img.id}/key?u=${req.user.userId}&exp=${exp}&sig=${sig}`,
    encUrl: `/api/image/${img.id}.enc`,
  });
});

app.get('/api/image/:id/key', keyLimiter, (req, res) => {
  const { u, exp, sig } = req.query;
  if (!u || !exp || !sig) return res.status(400).end();
  if (Date.now() > Number(exp)) return res.status(403).json({ error: 'expired' });

  const payload = `${req.params.id}|${u}|${exp}`;
  if (!hmacVerify(URL_SIGN_KEY, payload, sig)) {   // 先比長度再 timingSafeEqual（第 04 章）
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

  // 3. WASM 解密（只傳檔頭那一段）
  const buf = new Uint8Array(encBuf);
  aes_ctr_decrypt(buf.subarray(0, meta.headerLen), hexToBytes(meta.keyHex), hexToBytes(meta.ivHex));

  // 4. Canvas 渲染
  const bitmap = await createImageBitmap(new Blob([buf], { type: meta.mime }));
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
}
```

> 解密完不需要 `buf.fill(0)` 把明文清掉：`new Blob()` 和 `createImageBitmap()` 各自已經複製了一份，清掉 `buf` 不會讓明文從記憶體消失，只會給人錯誤的安全感。

### 5.4 簽名 URL 防得住什麼、防不住什麼

- **時間限制**：60 秒後這個 URL 失效，被轉貼、被記錄在 log 裡的 URL 沒有用。但**過期的是 URL，不是 key**——每張圖的 key 是固定的，已經拿到 key 的人可以拿它永久解開 `.enc`。
- **userId 寫進簽章**：伺服器能從 URL 知道這是替誰簽的，方便記錄與追查。但 `/key` 不會檢查呼叫的人是不是 `u`，60 秒內誰拿到這個 URL 都能用。
- **HMAC 簽名**：對手沒有簽章用的 key，偽造不出合法的 URL。
- **不可枚舉**：對手不能用迴圈打 `/api/image/N/key` 拿到全部 key，每個 URL 都得先通過 `/sign` 的權限檢查。

**擋不住的是已登入的帳號**：他可以正常地呼叫 `/sign` → `/key`，一張一張拿。這不是簽名 URL 的缺陷——有權看這張圖的人，本來就看得到它。簽名 URL 的目標是讓**沒權限的人**拿不到 key；對付有權限但大量抓取的帳號，要靠依帳號限流、監控（第 6.2 節）和浮水印追蹤（第 7 節）。

---

## 6 反爬蟲與反 DevTools

### 6.1 Referer / Origin 檢查

```js
const ALLOWED_ORIGIN = 'https://your-site.com';

app.use('/api/image/', (req, res, next) => {
  const src = req.headers.origin || req.headers.referer;
  let origin = null;
  try { origin = src && new URL(src).origin; } catch { /* 格式不對就當沒有 */ }
  // 一定要比對完整的 origin：startsWith('https://your-site.com') 會放過 https://your-site.com.evil.com
  if (origin !== ALLOWED_ORIGIN) return res.status(403).end();
  next();
});
```

> 同源的 GET 請求，瀏覽器通常不帶 `Origin`，所以要退回看 `Referer`；如果你的網站設了 `Referrer-Policy: no-referrer`，這招就不能用。
> 缺點：對手用 headless browser 跑頁面，Referer 就是合法的；用 `curl` 也能自己加 header。所以這層只擋無腦爬蟲。

### 6.2 Rate Limit

看一張圖要打 `/sign`、`/key`、`.enc` 三個請求。三個共用一個「每分鐘 30 次」的限制，等於每分鐘只能看 10 張，圖庫一頁就爆了。要分開設，而且 `/sign` 有登入，應該**依帳號**限：

```js
// 摘自 backend/server.js
const rateLimit = require('express-rate-limit');

// /sign：登入後才能呼叫，依帳號限流
const signLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  keyGenerator: (req) => req.user.userId,   // 要放在 authMiddleware 後面
});

// /key、.enc：依 IP，上限放寬
const keyLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true });
const encLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true });
```

只依 IP 限流，擋不住會換 IP 的爬蟲；依帳號限流，才擋得住「同一個帳號大量抓」。
上限要依正常使用者的瀏覽速度訂：太低會誤傷，太高擋不住。搭配監控（例如每天都貼著上限跑的帳號），比單純調數字有效。

### 6.3 偵測 DevTools 打開

```js
let devtoolsOpen = false;

setInterval(() => {
  const before = performance.now();
  debugger;   // 開了 DevTools 時這行會停住
  const elapsed = performance.now() - before;
  if (elapsed > 100) {
    devtoolsOpen = true;
    showWarning();
    // 可以選擇：拒絕解密、跳警告、記錄給後端
  }
}, 1000);
```

> 缺點：
> - 對手在 DevTools 按「停用中斷點」（Cmd/Ctrl + F8），`debugger` 就失效了；headless 爬蟲根本不開 DevTools。
> - 主執行緒忙（例如正在解碼大圖）時也可能超過 100ms，造成誤判。
> - 自己團隊除錯時也會一直被打斷。
>
> 建議只當作「警告」，不要當決定性條件。

### 6.4 偵測自動化工具

```js
// Puppeteer、Playwright、Selenium 等自動化工具會把 navigator.webdriver 設成 true
if (navigator.webdriver) {
  // 很可能是自動化工具
}

// headless Chrome / Edge 預設的 User-Agent 含 "HeadlessChrome"
if (/HeadlessChrome/.test(navigator.userAgent)) {
  // 確定是 headless
}
```

不要用這兩種常見的判斷：

- `window.chrome.runtime`：Firefox、Safari 根本沒有 `window.chrome`，會把這些使用者全部判成可疑；它在 Chrome 裡存不存在，也跟頁面和擴充功能有關，不是 headless 的可靠特徵。
- `navigator.plugins.length === 0`：桌機版 Chrome / Edge（包括 headless）會回報固定的 5 個 PDF 外掛，擋不到 headless；手機瀏覽器反而常常是 0。

這些訊號都能被偽造（Puppeteer 一行就能改掉 User-Agent 和 `webdriver`），只能當參考。
把可疑的請求標記，不直接拒絕（避免誤殺），而是回傳「降級畫質」或「浮水印更明顯」的版本。

---

## 7 額外加固：浮水印追蹤

如果圖片真的被截走，我們至少要能追到「是誰外流的」。

### 7.1 視覺浮水印（明顯）

如第 4 節，畫上 userId + 時間。對手肯定會去修圖修掉，但能擋住絕大多數人。

### 7.2 不可見浮水印（隱寫術）

在像素資料的 LSB（Least Significant Bit）裡寫 userId：

```js
const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
const data = imgData.data;
const wm = encodeUserIdToBits('u1');   // 例如 [1,0,1,1,0,...]

// 重複寫滿整張圖，裁掉一部分也還讀得到
const pixels = data.length / 4;
for (let p = 0; p < pixels; p++) {
  // 改每個 pixel R channel 的最低位元
  data[p * 4] = (data[p * 4] & 0xFE) | wm[p % wm.length];
}

ctx.putImageData(imgData, 0, 0);
```

肉眼看不出來（差 1/256 亮度），但用工具可解出 userId。

> 注意它很脆弱：
> - 被 JPEG 重新壓縮，LSB 就沒了。
> - canvas 被 CSS 縮放（例如 `max-width: 100%`）或螢幕是高 DPI 時，截圖的像素已經被重新取樣過，LSB 一樣被破壞。
>
> 所以它主要對付「從 canvas 讀出原尺寸像素」（`toDataURL` / `getImageData`）再外流的情況。要撐過截圖和重新壓縮，得用 DCT 域等更穩健的浮水印（演算法較複雜，本課程不展開）。
> 如果有用第 4 節解法 2 讓 canvas 染色，這一步要在染色之前做。

### 7.3 前端浮水印的根本限制

前端畫的浮水印都能被繞過：對手在 `createImageBitmap` 之前就攔下解密後的 bytes，拿到的圖根本沒有浮水印。
真正可靠的追蹤要在**伺服器端**做：每個使用者拿到的圖，在伺服器就已經嵌好他的 ID。代價是不能再「上傳時加密一次、所有人共用同一份」，得依使用者產生，快取效果也會變差。

---

## 8 整合：完整加密渲染元件

以下是 [`frontend/secure-image.js`](./frontend/secure-image.js) 全文：

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

幾個容易踩的細節：

- **closed shadow root**：`attachShadow({ mode: 'closed' })` 之後，`this.shadowRoot` 永遠是 `null`（連元素自己都拿不到），一定要把 `attachShadow()` 的回傳值存起來。
- **JWT 是 base64url**：用 `-`、`_` 取代 `+`、`/`，而且沒有 `=` 補位，不能直接丟給 `atob`；payload 是 UTF-8，帳號名稱有中文時要用 `TextDecoder` 解。
- **只把檔頭交給 wasm**：傳整個檔案，wasm-bindgen 會複製好幾 MB 進出（[第 06 章](./06-wasm-decryption-in-browser.md) 第 4 節）。

使用（jwt 從 `localStorage` 取得，不必傳屬性）：

```html
<secure-image image-id="abc-123"></secure-image>
```

一行 HTML 完成「登入驗證 → 簽名 URL → 加密下載 → WASM 解密 → Canvas 渲染 → 浮水印」全流程。實際在 [`frontend/gallery.html`](./frontend/gallery.html) 用迴圈塞滿整個圖庫。

---

## 9 還有什麼能做？

再往上的做法，各自有適用的地方：

- **Service Worker 解密**：在 SW 攔下 `.enc` 的請求，解密後回傳 `image/jpeg`，頁面就能直接用 `<img src>`。要知道這是**方便，不是更安全**：解密後的圖又變成一個普通的 URL，可以右鍵另存，DevTools 的 Network 面板也看得到明文回應。
- **WebGL texture**：解密後上傳成 GPU texture 再畫。一樣要先解碼成點陣圖（`createImageBitmap`），而且 `readPixels` 讀得回來，效果跟 canvas 差不多。
- **Trusted Types**：限制 `innerHTML`、`<script src>` 等容易造成 XSS 的寫入點。它不管 `img.src`，跟防盜圖無關，但能降低 XSS 把 localStorage 裡的 JWT 偷走的風險。
- **完整性檢查**：用 `fetch(url, { integrity: 'sha384-...' })` 下載 wasm，雜湊不符就拒絕，防止 CDN 上的檔案被換掉。

先回到 [第 00 章](./00-course-map-and-threat-model.md)：先定義對手，再加防禦。

---

## 10 動手作業

1. 把 [第 04 章](./04-aes-with-webcrypto.md) 的 demo 頁改成用 `createImageBitmap` + Canvas 渲染，並加上第 4 節的浮水印。
2. 在 Canvas 上實作 LSB 浮水印，並寫個解碼器驗證能讀回 userId；再把 canvas 用 CSS 縮小一半後截圖，看看還讀不讀得回來。
3. 在 `/sign` 加上異常偵測：同一個帳號 1 分鐘內要了超過 N 張圖就記錄下來，連續超過時暫時鎖定這個帳號。

---

## 11 本章重點回顧

- 用 `createImageBitmap + Canvas` 取代 `<img src="blob:...">`，從 DOM 消除原始 URL；canvas 的右鍵另存要自己擋。
- 防 `toDataURL`：浮水印、故意染色、覆寫方法、分塊到多個 canvas，都只是提高門檻。
- Key 動態下發三要素：JWT 驗證、HMAC 簽名、短效時間。過期的是 URL，不是 key；簽名 URL 擋的是沒權限的人。
- 對付已登入的大量抓取：依帳號限流 + 監控；Referer、DevTools、headless 偵測都只能當參考。
- 前端浮水印能被繞過，可靠的外流追蹤要在伺服器端嵌入。
- 任何防禦都不是絕對，但**疊起來的成本就是有效的**。

---

**下一章**：[08-capstone-full-system.md](./08-capstone-full-system.md) — 畢業專題：完整系統整合
