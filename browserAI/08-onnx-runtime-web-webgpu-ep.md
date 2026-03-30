# 第八課：ONNX Runtime Web + WebGPU EP（1 週）

## 8.1 本課目標

你前一課已用 TF.js 跑通 Browser AI。  
這一課會換成 ONNX Runtime Web，理解 Execution Provider（EP）如何把 ONNX 模型接上 WebGPU。

本課重點：

- ONNX 模型載入與 `InferenceSession`
- `executionProviders`（`webgpu` / `wasm`）策略
- 影像前處理（NCHW、normalize）
- 作業：**影像分類頁（上傳圖→預測結果）**

---

## 8.2 ONNX Runtime Web 角色定位

你可以把 ONNX Runtime Web 想成：

- **模型執行引擎**（吃 ONNX，吐推論結果）
- **硬體抽象層**（透過 EP 選 webgpu/wasm）
- **部署中介層**（訓練框架與前端執行之間的橋樑）

---

## 8.3 Execution Provider（EP）是什麼？

EP 決定模型在什麼後端跑：

- `webgpu`：優先，通常更快
- `wasm`：相容性保底

建議策略：

1. 先嘗試 `webgpu`
2. 失敗就 fallback 到 `wasm`
3. UI 顯示實際使用的 EP，便於診斷

---

## 8.4 推論流程（ONNX 版）

```text
載入 model.onnx -> 建立 session
  ↓
讀取圖片 -> resize 到 224x224
  ↓
轉成 Float32Array（NCHW）
  ↓
session.run(feeds)
  ↓
softmax + top-k
  ↓
輸出結果
```

---

## 8.5 本週作業規格

### 必做

- 圖片上傳 + ONNX 推論
- 顯示 Top-K（class + probability）
- 顯示實際使用 EP 與推論耗時

### 建議加分

- 模型載入時間分離顯示
- 允許切換 `webgpu-first` / `wasm-only`
- 顯示前處理 tensor 片段，便於除錯

---

## 8.6 檔案準備說明（模型與標籤）

本課示範程式會先嘗試以下來源：

- 模型：`./models/squeezenet1.0-12.onnx`（建議你先放本機）
- 標籤：`./models/imagenet-simple-labels.json`

若本機找不到，程式會再嘗試公開 URL（有 CORS 風險，成功率依來源站點而異）。

---

## 8.7 常見錯誤與排查

### 問題一：模型載入失敗（404 或 CORS）

- 優先把模型放本機 `models/` 目錄
- 避免依賴未設 CORS 的第三方 URL

### 問題二：推論結果全都不合理

- 檢查前處理（RGB/NCHW/normalize）是否符合模型預期
- 檢查輸入 tensor shape 是否正確（通常 `[1,3,224,224]`）

### 問題三：宣告 webgpu 但實際很慢

- 可能已 fallback 到 wasm
- 一定要在 UI 顯示「實際 EP」而不是「期望 EP」

---

## 8.8 本章小結

- 你已掌握 ONNX Runtime Web 的基本執行模型
- 你能把 ONNX 模型接上 WebGPU EP 並完成分類任務
- 你已具備從 TF.js 過渡到 ONNX 生態的關鍵能力

---

## 8.9 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-08-onnx-webgpu-classifier/
├── index.html
├── style.css
├── app.js
└── models/
    ├── squeezenet1.0-12.onnx
    └── imagenet-simple-labels.json
```

### `index.html`

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lesson 08 - ONNX Runtime Web + WebGPU EP</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 08：ONNX Runtime Web Image Classifier</h1>
      <p class="subtitle">上傳圖片 → ONNX 推論 → Top-K 預測</p>

      <section class="panel controls">
        <label>
          EP Strategy
          <select id="epSelect">
            <option value="webgpu-first" selected>webgpu-first (fallback wasm)</option>
            <option value="wasm-only">wasm-only</option>
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

        <button id="loadBtn">1) 載入 ONNX 模型</button>
        <input id="fileInput" type="file" accept="image/*" />
        <button id="predictBtn" disabled>2) 開始推論</button>
      </section>

      <section class="panel preview-panel">
        <img id="previewImage" alt="請先上傳圖片" />
      </section>

      <section class="panel">
        <h2>Status</h2>
        <p><strong>EP:</strong> <span id="activeEp">尚未初始化</span></p>
        <pre id="status">等待模型載入...</pre>
      </section>

      <section class="panel">
        <h2>Tensor Snapshot</h2>
        <div id="tensorInfo">尚未執行。</div>
      </section>

      <section class="panel">
        <h2>Prediction</h2>
        <div id="prediction">尚未執行推論。</div>
      </section>
    </main>

    <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.all.min.js"></script>
    <script src="./app.js"></script>
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
  background: #0b101d;
  color: #edf3ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.container {
  max-width: 980px;
  margin: 26px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #bcc9ea;
}

.panel {
  margin-top: 14px;
  background: #151d34;
  border: 1px solid #334676;
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
  border: 1px solid #4a63a5;
  border-radius: 8px;
  background: #0f1730;
  color: #edf3ff;
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

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
const epSelect = document.querySelector("#epSelect");
const topkSelect = document.querySelector("#topkSelect");
const loadBtn = document.querySelector("#loadBtn");
const fileInput = document.querySelector("#fileInput");
const predictBtn = document.querySelector("#predictBtn");
const previewImage = document.querySelector("#previewImage");
const activeEpEl = document.querySelector("#activeEp");
const statusEl = document.querySelector("#status");
const tensorInfoEl = document.querySelector("#tensorInfo");
const predictionEl = document.querySelector("#prediction");

const MODEL_CANDIDATES = [
  "./models/squeezenet1.0-12.onnx",
  "https://huggingface.co/onnxruntime/squeezenet1.0-12/resolve/main/squeezenet1.0-12.onnx",
  "https://cdn.jsdelivr.net/gh/onnx/models/validated/vision/classification/squeezenet/model/squeezenet1.0-12.onnx"
];

const LABEL_CANDIDATES = [
  "./models/imagenet-simple-labels.json",
  "https://raw.githubusercontent.com/anishathalye/imagenet-simple-labels/master/imagenet-simple-labels.json"
];

const state = {
  session: null,
  labels: null,
  imageReady: false,
  activeEp: "uninitialized"
};

function setStatus(text) {
  statusEl.textContent = text;
}

function syncPredictButton() {
  predictBtn.disabled = !(state.session && state.imageReady);
}

function softmax(logits) {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i += 1) {
    if (logits[i] > max) max = logits[i];
  }
  let sum = 0;
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i += 1) {
    out[i] = Math.exp(logits[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= sum;
  return out;
}

function topK(probabilities, k) {
  const pairs = Array.from(probabilities, (p, i) => ({ index: i, prob: p }));
  pairs.sort((a, b) => b.prob - a.prob);
  return pairs.slice(0, k);
}

async function fetchArrayBufferFromCandidates(urls) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
      return { url, buffer: await resp.arrayBuffer() };
    } catch (error) {
      console.warn(`fetch model failed: ${url}`, error);
      lastErr = error;
    }
  }
  throw lastErr || new Error("無法取得模型檔案。");
}

async function fetchJsonFromCandidates(urls) {
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      return await resp.json();
    } catch {
      // ignore and fallback
    }
  }
  return null;
}

function buildFallbackLabels(size = 1000) {
  return Array.from({ length: size }, (_, i) => `class_${i}`);
}

function preprocessImageToNCHW(imgEl) {
  const target = 224;
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgEl, 0, 0, target, target);

  const { data } = ctx.getImageData(0, 0, target, target);
  const floatData = new Float32Array(1 * 3 * target * target);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];

  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      const pixelIndex = (y * target + x) * 4;
      const r = data[pixelIndex] / 255;
      const g = data[pixelIndex + 1] / 255;
      const b = data[pixelIndex + 2] / 255;

      const idx = y * target + x;
      floatData[idx] = (r - mean[0]) / std[0]; // channel R
      floatData[target * target + idx] = (g - mean[1]) / std[1]; // channel G
      floatData[2 * target * target + idx] = (b - mean[2]) / std[2]; // channel B
    }
  }

  return {
    tensor: new ort.Tensor("float32", floatData, [1, 3, target, target]),
    preview: Array.from(floatData.slice(0, 12)).map((v) => v.toFixed(4)).join(", ")
  };
}

async function createSessionWithStrategy(modelBuffer, strategy) {
  if (strategy === "wasm-only") {
    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"]
    });
    return { session, ep: "wasm" };
  }

  try {
    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["webgpu", "wasm"]
    });
    // ORT 目前沒有直接回傳實際 EP 的統一欄位，這裡以策略標記
    return { session, ep: "webgpu-first" };
  } catch (error) {
    console.warn("webgpu-first failed, fallback wasm", error);
    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"]
    });
    return { session, ep: "wasm-fallback" };
  }
}

async function loadModel() {
  loadBtn.disabled = true;
  setStatus("載入模型檔案中...");

  try {
    const modelStart = performance.now();
    const { url: modelUrl, buffer } = await fetchArrayBufferFromCandidates(MODEL_CANDIDATES);
    const strategy = epSelect.value;

    setStatus(`模型下載完成，建立 session（strategy=${strategy}）...`);
    const { session, ep } = await createSessionWithStrategy(buffer, strategy);
    state.session = session;
    state.activeEp = ep;
    activeEpEl.textContent = ep;

    if (!state.labels) {
      const loadedLabels = await fetchJsonFromCandidates(LABEL_CANDIDATES);
      state.labels = Array.isArray(loadedLabels) ? loadedLabels : buildFallbackLabels(1000);
    }

    const elapsed = performance.now() - modelStart;
    setStatus(`模型就緒：${modelUrl}\n載入時間：${elapsed.toFixed(2)} ms`);
  } catch (error) {
    console.error(error);
    setStatus(`模型載入失敗：${error.message}`);
  } finally {
    loadBtn.disabled = false;
    syncPredictButton();
  }
}

function renderPredictions(topItems, inferMs) {
  const list = topItems
    .map((item) => {
      const label = state.labels?.[item.index] ?? `class_${item.index}`;
      return `<li><span>${label}</span><strong>${(item.prob * 100).toFixed(2)}%</strong></li>`;
    })
    .join("");

  predictionEl.innerHTML = `
    <p class="ok">Inference: ${inferMs.toFixed(2)} ms (EP=${state.activeEp})</p>
    <ol class="pred-list">${list}</ol>
  `;
}

async function predict() {
  if (!state.session || !state.imageReady) return;

  predictBtn.disabled = true;
  setStatus("推論中...");
  predictionEl.textContent = "推論中...";

  try {
    const { tensor, preview } = preprocessImageToNCHW(previewImage);
    tensorInfoEl.innerHTML = `
      <p><strong>Tensor Shape:</strong> [1, 3, 224, 224]</p>
      <p><strong>First 12 values:</strong> ${preview}</p>
    `;

    const inputName = state.session.inputNames[0];
    const outputName = state.session.outputNames[0];
    const feeds = { [inputName]: tensor };

    const t0 = performance.now();
    const outputMap = await state.session.run(feeds);
    const inferMs = performance.now() - t0;

    const logits = outputMap[outputName].data;
    const probs = softmax(logits);
    const top = topK(probs, Number(topkSelect.value));
    renderPredictions(top, inferMs);

    setStatus("推論完成。");
  } catch (error) {
    console.error(error);
    setStatus(`推論失敗：${error.message}`);
    predictionEl.textContent = "推論失敗，請查看狀態訊息。";
  } finally {
    syncPredictButton();
  }
}

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  state.imageReady = false;
  syncPredictButton();
  setStatus(`讀取圖片：${file.name}`);

  const url = URL.createObjectURL(file);
  previewImage.onload = () => {
    URL.revokeObjectURL(url);
    previewImage.style.display = "block";
    state.imageReady = true;
    setStatus("圖片已載入，可開始推論。");
    syncPredictButton();
  };
  previewImage.onerror = () => {
    URL.revokeObjectURL(url);
    state.imageReady = false;
    setStatus("圖片載入失敗，請重試。");
    syncPredictButton();
  };
  previewImage.src = url;
});

loadBtn.addEventListener("click", loadModel);
predictBtn.addEventListener("click", predict);
```

---

> 下一課：`09-transformers-js-applications.md`（文本 embedding、分類與生成任務）
