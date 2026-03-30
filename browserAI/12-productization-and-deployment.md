# 第十二課：產品化與部署（1 週）

## 12.1 本課目標

這一課是整套課程的收尾：  
把你前面做過的 Browser AI 能力，整理成可部署、可維運、可回復的產品形態。

本課重點：

- PWA（安裝、離線可用）
- Service Worker 快取策略
- 失敗回退（模型載入失敗、離線、更新中斷）
- 作業：**完成可部署的 Browser AI 小產品**

---

## 12.2 產品化關注點（不是只有模型）

上線後最常遇到的不是模型精度問題，而是：

- 首次載入太慢
- 離線時整個頁面壞掉
- 更新版本後資源 mismatch

所以你要同時處理：

- **App Shell 快取**
- **模型/資源 runtime 快取**
- **錯誤與回退策略**

---

## 12.3 建議快取策略

### 1) App Shell：Cache First

- `index.html`、`style.css`、`app.js`、`manifest`、icons
- 目標：離線仍可開啟應用框架

### 2) 模型資源：Stale-While-Revalidate

- 先用快取，背景更新
- 目標：兼顧啟動速度與更新可得性

### 3) 導航失敗回退：Offline Page

- 當 navigation 請求失敗時回傳 `offline.html`

---

## 12.4 本週作業規格

### 必做

- PWA 安裝能力（manifest + install prompt）
- Service Worker 快取 App Shell
- 至少一個 Browser AI 功能可運行
- 離線或模型失敗時有可讀回退訊息

### 建議加分

- 顯示線上/離線狀態
- 顯示最近一次成功推論結果（本地儲存）
- 版本更新提示（有新 SW 可啟用）

---

## 12.5 常見錯誤與排查

### 問題一：PWA 不可安裝

- 缺 `manifest.webmanifest`
- 非 HTTPS（localhost 例外）
- 沒有可用 icon 或 service worker

### 問題二：更新後畫面怪異

- 新舊快取混用
- 需在 SW activate 階段清舊 cache

### 問題三：離線後功能失效

- 模型檔未被快取成功
- 需在 UI 提示「離線時使用最近一次結果」等 fallback

---

## 12.6 本章小結

- 你已能把 Browser AI 做成可部署的產品雛形
- 你掌握了 PWA + SW + fallback 的核心實務
- 你已完成從學習到落地的完整閉環

---

## 12.7 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-12-browser-ai-pwa/
├── index.html
├── offline.html
├── style.css
├── app.js
├── sw.js
├── manifest.webmanifest
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

> `icons` 可先放佔位圖，正式上線再替換品牌圖示。

### `index.html`

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0f172a" />
    <title>Lesson 12 - Browser AI PWA</title>
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 12：Browser AI PWA Product</h1>
      <p class="subtitle">可安裝、可快取、可回退的 Browser AI 小產品範例</p>

      <section class="panel controls">
        <button id="installBtn" hidden>Install App</button>
        <button id="initBtn">1) 初始化模型</button>
        <input id="fileInput" type="file" accept="image/*" />
        <button id="classifyBtn" disabled>2) 分類圖片</button>
      </section>

      <section class="panel">
        <h2>Runtime Status</h2>
        <p>Network: <span id="networkState">unknown</span></p>
        <pre id="status">等待初始化...</pre>
      </section>

      <section class="panel preview-panel">
        <img id="previewImage" alt="請先上傳圖片" />
      </section>

      <section class="panel">
        <h2>Prediction</h2>
        <div id="prediction">尚未推論。</div>
      </section>

      <section class="panel">
        <h2>Last Successful Result (localStorage)</h2>
        <div id="lastResult">尚無資料。</div>
      </section>
    </main>

    <script type="module" src="./app.js"></script>
  </body>
</html>
```

### `offline.html`

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Offline - Browser AI PWA</title>
    <style>
      body {
        margin: 0;
        display: grid;
        place-items: center;
        min-height: 100vh;
        background: #0b1020;
        color: #ecf2ff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      }
      .card {
        max-width: 560px;
        padding: 20px;
        border: 1px solid #344878;
        border-radius: 10px;
        background: #151f38;
      }
      a { color: #8ec1ff; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>目前離線</h1>
      <p>App Shell 已可開啟，但你需要先在線時載入模型，才能離線推論。</p>
      <p>回到 <a href="./index.html">首頁</a> 重新嘗試。</p>
    </section>
  </body>
</html>
```

### `style.css`

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #0b1020;
  color: #ecf2ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.container {
  max-width: 980px;
  margin: 24px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #bcc8ea;
}

.panel {
  margin-top: 14px;
  background: #151e36;
  border: 1px solid #334778;
  border-radius: 10px;
  padding: 14px;
}

.controls {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}

input,
button {
  border: 1px solid #4b64a6;
  border-radius: 8px;
  background: #0f1831;
  color: #ecf2ff;
  padding: 10px;
}

button {
  cursor: pointer;
  background: #2f73ff;
  border-color: #2f73ff;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.preview-panel {
  min-height: 320px;
  display: grid;
  place-items: center;
}

#previewImage {
  max-width: 100%;
  max-height: 420px;
  display: none;
}

.pred-list {
  margin: 0;
  padding-left: 20px;
}

.pred-list li {
  margin: 8px 0;
  display: flex;
  justify-content: space-between;
}

.ok {
  color: #86f0aa;
}

.warn {
  color: #ffd68a;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
import * as tf from "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/+esm";
import "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.20.0/+esm";
import "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.20.0/+esm";
import * as mobilenet from "https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/+esm";

const installBtn = document.querySelector("#installBtn");
const initBtn = document.querySelector("#initBtn");
const fileInput = document.querySelector("#fileInput");
const classifyBtn = document.querySelector("#classifyBtn");
const previewImage = document.querySelector("#previewImage");
const networkStateEl = document.querySelector("#networkState");
const statusEl = document.querySelector("#status");
const predictionEl = document.querySelector("#prediction");
const lastResultEl = document.querySelector("#lastResult");

const state = {
  model: null,
  imageReady: false,
  deferredPrompt: null
};

function setStatus(text) {
  statusEl.textContent = text;
}

function syncClassifyButton() {
  classifyBtn.disabled = !(state.model && state.imageReady);
}

function renderLastResult() {
  const raw = localStorage.getItem("browser-ai-last-result");
  if (!raw) {
    lastResultEl.textContent = "尚無資料。";
    return;
  }
  try {
    const data = JSON.parse(raw);
    const rows = data.items
      .map((item) => `<li><span>${item.className}</span><strong>${item.score}%</strong></li>`)
      .join("");
    lastResultEl.innerHTML = `
      <p>Saved at: ${new Date(data.savedAt).toLocaleString()}</p>
      <ol class="pred-list">${rows}</ol>
    `;
  } catch {
    lastResultEl.textContent = "最近結果資料格式錯誤。";
  }
}

function updateNetworkState() {
  networkStateEl.textContent = navigator.onLine ? "online" : "offline";
  networkStateEl.className = navigator.onLine ? "ok" : "warn";
}

async function selectTfBackend() {
  const candidates = "gpu" in navigator ? ["webgpu", "webgl", "cpu"] : ["webgl", "cpu"];
  for (const name of candidates) {
    try {
      await tf.setBackend(name);
      await tf.ready();
      return name;
    } catch {
      // continue
    }
  }
  throw new Error("沒有可用 backend。");
}

async function initModel() {
  initBtn.disabled = true;
  setStatus("初始化模型中...");

  try {
    const backend = await selectTfBackend();
    const start = performance.now();
    state.model = await mobilenet.load({ version: 2, alpha: 1.0 });
    const elapsed = performance.now() - start;

    // warmup
    const warmup = tf.zeros([1, 224, 224, 3]);
    const out = state.model.infer(warmup, true);
    if (Array.isArray(out)) out.forEach((t) => t.dispose());
    else if (out?.dispose) out.dispose();
    warmup.dispose();

    setStatus(`模型就緒：backend=${backend}，load=${elapsed.toFixed(2)} ms`);
  } catch (error) {
    console.error(error);
    setStatus(`模型初始化失敗：${error.message}`);
    predictionEl.innerHTML = `
      <p class="warn">目前無法載入模型。若離線請先於在線狀態完成一次模型初始化。</p>
    `;
  } finally {
    initBtn.disabled = false;
    syncClassifyButton();
  }
}

async function classifyImage() {
  if (!state.model || !state.imageReady) return;

  classifyBtn.disabled = true;
  predictionEl.textContent = "推論中...";
  setStatus("執行推論...");

  try {
    const t0 = performance.now();
    const preds = await state.model.classify(previewImage, 5);
    const inferMs = performance.now() - t0;

    const rows = preds
      .map(
        (p) =>
          `<li><span>${p.className}</span><strong>${(p.probability * 100).toFixed(2)}%</strong></li>`
      )
      .join("");
    predictionEl.innerHTML = `
      <p class="ok">Inference: ${inferMs.toFixed(2)} ms</p>
      <ol class="pred-list">${rows}</ol>
    `;

    localStorage.setItem(
      "browser-ai-last-result",
      JSON.stringify({
        savedAt: Date.now(),
        items: preds.map((p) => ({
          className: p.className,
          score: (p.probability * 100).toFixed(2)
        }))
      })
    );
    renderLastResult();
    setStatus("推論完成並已儲存最近結果。");
  } catch (error) {
    console.error(error);
    setStatus(`推論失敗：${error.message}`);
    predictionEl.innerHTML = `
      <p class="warn">推論失敗。若目前離線，請使用「Last Successful Result」查看最近結果。</p>
    `;
  } finally {
    syncClassifyButton();
  }
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    installBtn.hidden = true;
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js");
    setStatus(`Service Worker 已註冊：scope=${reg.scope}`);
  } catch (error) {
    console.error(error);
    setStatus(`SW 註冊失敗：${error.message}`);
  }
}

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);

  state.imageReady = false;
  syncClassifyButton();

  previewImage.onload = () => {
    URL.revokeObjectURL(url);
    previewImage.style.display = "block";
    state.imageReady = true;
    setStatus(`圖片已載入：${file.name}`);
    syncClassifyButton();
  };
  previewImage.onerror = () => {
    URL.revokeObjectURL(url);
    state.imageReady = false;
    setStatus("圖片載入失敗。");
    syncClassifyButton();
  };
  previewImage.src = url;
});

initBtn.addEventListener("click", initModel);
classifyBtn.addEventListener("click", classifyImage);
window.addEventListener("online", updateNetworkState);
window.addEventListener("offline", updateNetworkState);

updateNetworkState();
renderLastResult();
setupInstallPrompt();
registerServiceWorker();
```

### `sw.js`

```javascript
const APP_CACHE = "browser-ai-app-v1";
const RUNTIME_CACHE = "browser-ai-runtime-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isModelOrLibRequest(requestUrl) {
  return (
    requestUrl.includes("cdn.jsdelivr.net") ||
    requestUrl.includes("tfjs-models") ||
    requestUrl.includes("storage.googleapis.com")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  // navigation fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(APP_CACHE);
        return cache.match("./offline.html");
      })
    );
    return;
  }

  // app shell: cache first
  if (APP_SHELL.some((path) => url.pathname.endsWith(path.replace("./", "/")))) {
    event.respondWith(
      caches.match(request).then((cached) => {
        return cached || fetch(request);
      })
    );
    return;
  }

  // model/library runtime: stale-while-revalidate
  if (isModelOrLibRequest(url.href)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((resp) => {
            if (resp && resp.ok) {
              cache.put(request, resp.clone());
            }
            return resp;
          })
          .catch(() => cached);

        return cached || networkPromise;
      })
    );
  }
});
```

### `manifest.webmanifest`

```json
{
  "name": "Browser AI PWA Product Demo",
  "short_name": "BrowserAI-PWA",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#0b1020",
  "theme_color": "#0f172a",
  "description": "A deployable Browser AI mini-product with PWA and fallback strategies.",
  "icons": [
    {
      "src": "./icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "./icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

---

> 你已完成 12 週 Browser AI 路線，下一步可開始做「第 1 個真實使用者可用版本」與 A/B 測試。
