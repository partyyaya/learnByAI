# 第七課：Browser AI 入門（TensorFlow.js / ONNX 概念）（1 週）

## 7.1 本課目標

從這一課開始，我們進入「真正的 Browser AI 推論流程」。  
你不只要會跑模型，還要知道模型格式、前後處理、runtime 與硬體加速之間的關係。

本課重點：

- 模型格式概念：TF.js GraphModel vs ONNX
- 前處理 / 推論 / 後處理的完整管線
- backend 選擇（`webgpu` / `webgl` / `cpu`）
- 作業：**在瀏覽器跑一個簡單分類模型**

---

## 7.2 Browser AI 標準流程（你要背起來）

```text
輸入（image/text/audio）
  ↓
前處理（resize / normalize / tokenize）
  ↓
模型推論（runtime + backend）
  ↓
後處理（top-k / softmax / decode）
  ↓
UI 呈現（可解釋結果 + 互動）
```

你後面用 ONNX Runtime Web、Transformers.js、WebLLM，本質都在跑這條管線。

---

## 7.3 TF.js 與 ONNX 概念差異

### TensorFlow.js（TF.js）

- 前端整合快，生態成熟
- 模型常見為 GraphModel / LayersModel
- backend 可選 `webgpu/webgl/cpu`

### ONNX（概念）

- 偏跨框架交換格式（interoperability）
- 許多訓練框架都可匯出 ONNX
- 由 ONNX Runtime 等 runtime 執行

你可以先用 TF.js 快速做原型，再依部署需求轉 ONNX。

---

## 7.4 前處理與後處理重點

### 前處理

- 尺寸對齊（例如 224x224）
- 資料型別（通常 `float32`）
- 正規化（例如 0~1 或 mean/std）

### 後處理

- 取 Top-K
- 顯示機率
- 加上執行時間與 backend，幫助判讀效能

---

## 7.5 本週作業規格

### 必做

- 建立圖像分類頁
- 可上傳圖片並顯示 Top-K 結果
- 顯示 backend 與推論耗時

### 建議加分

- backend 支援 `auto/webgpu/webgl/cpu`
- 顯示前處理張量 shape 與前幾個值
- 做模型 warmup，降低首次延遲

---

## 7.6 常見錯誤與排查

### 問題一：`webgpu` backend 初始化失敗

- 某些設備/瀏覽器可能不支援
- 請保留 fallback 到 `webgl` / `cpu`

### 問題二：第一次推論很慢

- 模型下載 + 圖編譯 + backend 初始化
- 先 warmup 一次，實務體驗會好很多

### 問題三：結果看起來怪

- 先檢查輸入圖片方向、尺寸與前處理流程
- 不同模型的 normalize 規則可能不同

---

## 7.7 本章小結

- 你已建立 Browser AI 的完整推論心智模型
- 你能解釋 runtime / backend / 前後處理的角色
- 你完成可運行的分類模型頁，能無痛銜接 ONNX Runtime Web

---

## 7.8 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-07-browser-ai-classifier/
├── index.html
├── style.css
└── app.js
```

### `index.html`

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lesson 07 - Browser AI Foundations</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 07：Browser AI Image Classifier</h1>
      <p class="subtitle">TF.js + MobileNet，示範完整前處理/推論/後處理流程</p>

      <section class="panel controls">
        <label>
          Backend
          <select id="backendSelect">
            <option value="auto" selected>auto (webgpu→webgl→cpu)</option>
            <option value="webgpu">webgpu</option>
            <option value="webgl">webgl</option>
            <option value="cpu">cpu</option>
          </select>
        </label>

        <label>
          Top-K
          <select id="topkSelect">
            <option value="3">3</option>
            <option value="5" selected>5</option>
            <option value="8">8</option>
          </select>
        </label>

        <button id="initBtn">1) 初始化模型</button>
        <input id="fileInput" type="file" accept="image/*" />
        <button id="classifyBtn" disabled>2) 開始辨識</button>
      </section>

      <section class="panel preview-panel">
        <img id="previewImage" alt="請先上傳圖片" />
      </section>

      <section class="panel">
        <h2>Status</h2>
        <p><strong>Active Backend:</strong> <span id="activeBackend">未初始化</span></p>
        <pre id="status">等待初始化...</pre>
      </section>

      <section class="panel">
        <h2>Preprocess Snapshot</h2>
        <div id="preprocessInfo">尚未執行。</div>
      </section>

      <section class="panel">
        <h2>Prediction</h2>
        <div id="prediction">尚未執行推論。</div>
      </section>
    </main>

    <script type="module" src="./app.js"></script>
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
  background: #0c1120;
  color: #eef3ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.container {
  max-width: 980px;
  margin: 26px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #bdc9ea;
}

.panel {
  margin-top: 14px;
  background: #151e36;
  border: 1px solid #334777;
  border-radius: 10px;
  padding: 14px;
}

.controls {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: end;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}

select,
input,
button {
  border: 1px solid #4b64a6;
  border-radius: 8px;
  background: #0f1832;
  color: #eef3ff;
  padding: 8px 10px;
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
  display: grid;
  place-items: center;
  min-height: 320px;
  padding: 10px;
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
  color: #87efab;
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

const backendSelect = document.querySelector("#backendSelect");
const topkSelect = document.querySelector("#topkSelect");
const initBtn = document.querySelector("#initBtn");
const classifyBtn = document.querySelector("#classifyBtn");
const fileInput = document.querySelector("#fileInput");
const previewImage = document.querySelector("#previewImage");
const activeBackendEl = document.querySelector("#activeBackend");
const statusEl = document.querySelector("#status");
const preprocessInfoEl = document.querySelector("#preprocessInfo");
const predictionEl = document.querySelector("#prediction");

const state = {
  model: null,
  imageReady: false,
  activeBackend: "uninitialized"
};

function setStatus(text) {
  statusEl.textContent = text;
}

function syncClassifyButton() {
  classifyBtn.disabled = !(state.model && state.imageReady);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function selectBackend() {
  const requested = backendSelect.value;
  const candidates =
    requested === "auto"
      ? ["webgpu", "webgl", "cpu"]
      : [requested, "webgl", "cpu"];

  for (const backend of candidates) {
    try {
      if (backend === "webgpu" && !("gpu" in navigator)) {
        continue;
      }
      await tf.setBackend(backend);
      await tf.ready();
      return backend;
    } catch (error) {
      console.warn(`[backend=${backend}] init failed`, error);
    }
  }

  throw new Error("沒有可用的 TF.js backend。");
}

function summarizeTensorForDisplay(imgEl) {
  return tf.tidy(() => {
    const tensor = tf.browser.fromPixels(imgEl).toFloat();
    const resized = tf.image.resizeBilinear(tensor, [224, 224], true);
    const normalized = resized.div(255);
    const data = normalized.dataSync();
    const preview = Array.from(data.slice(0, 12)).map((v) => v.toFixed(4));
    return {
      inputShape: `${tensor.shape.join(" x ")} (HWC)`,
      resizedShape: `${resized.shape.join(" x ")} (HWC)`,
      normalizedRange: `[${normalized.min().dataSync()[0].toFixed(4)}, ${normalized
        .max()
        .dataSync()[0]
        .toFixed(4)}]`,
      first12: preview.join(", ")
    };
  });
}

async function initializeModel() {
  initBtn.disabled = true;
  setStatus("初始化 backend...");

  try {
    const backendStart = performance.now();
    const backend = await selectBackend();
    const backendMs = performance.now() - backendStart;
    state.activeBackend = backend;
    activeBackendEl.textContent = backend;

    if (!state.model) {
      setStatus("載入 MobileNet 模型...");
      const modelStart = performance.now();
      state.model = await mobilenet.load({ version: 2, alpha: 1.0 });
      const modelMs = performance.now() - modelStart;

      // warmup：讓首次使用者體感更穩定
      const warmup = tf.zeros([1, 224, 224, 3]);
      const warmupOut = state.model.infer(warmup, true);
      if (Array.isArray(warmupOut)) warmupOut.forEach((t) => t.dispose());
      else if (warmupOut && typeof warmupOut.dispose === "function") warmupOut.dispose();
      warmup.dispose();
      await tf.nextFrame();

      setStatus(
        `模型已就緒。backend=${backend} (${backendMs.toFixed(2)} ms), model load=${modelMs.toFixed(2)} ms`
      );
    } else {
      setStatus(`模型已存在，切換 backend 完成：${backend} (${backendMs.toFixed(2)} ms)`);
    }
  } catch (error) {
    console.error(error);
    setStatus(`初始化失敗：${error.message}`);
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
    const topK = Number(topkSelect.value);
    const preprocessSummary = summarizeTensorForDisplay(previewImage);
    preprocessInfoEl.innerHTML = `
      <p><strong>Input Shape:</strong> ${preprocessSummary.inputShape}</p>
      <p><strong>Resized Shape:</strong> ${preprocessSummary.resizedShape}</p>
      <p><strong>Normalized Range:</strong> ${preprocessSummary.normalizedRange}</p>
      <p><strong>First 12 values:</strong> ${preprocessSummary.first12}</p>
    `;

    const t0 = performance.now();
    const preds = await state.model.classify(previewImage, topK);
    const inferMs = performance.now() - t0;

    const list = preds
      .map((p) => {
        const name = escapeHtml(p.className);
        const score = (p.probability * 100).toFixed(2);
        return `<li><span>${name}</span><strong>${score}%</strong></li>`;
      })
      .join("");

    predictionEl.innerHTML = `
      <p class="ok">Inference: ${inferMs.toFixed(2)} ms (backend=${state.activeBackend})</p>
      <ol class="pred-list">${list}</ol>
    `;
    setStatus("推論完成。");
  } catch (error) {
    console.error(error);
    setStatus(`推論失敗：${error.message}`);
    predictionEl.textContent = "推論失敗，請查看狀態訊息。";
  } finally {
    syncClassifyButton();
  }
}

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  state.imageReady = false;
  syncClassifyButton();
  setStatus(`讀取圖片：${file.name}`);

  const url = URL.createObjectURL(file);
  previewImage.onload = () => {
    URL.revokeObjectURL(url);
    previewImage.style.display = "block";
    state.imageReady = true;
    setStatus("圖片已載入，可開始推論。");
    syncClassifyButton();
  };
  previewImage.onerror = () => {
    URL.revokeObjectURL(url);
    state.imageReady = false;
    setStatus("圖片載入失敗，請重新選擇檔案。");
    syncClassifyButton();
  };
  previewImage.src = url;
});

initBtn.addEventListener("click", initializeModel);
classifyBtn.addEventListener("click", classifyImage);
```

---

> 下一課：`08-onnx-runtime-web-webgpu-ep.md`（ONNX Runtime Web + WebGPU EP 實作）
