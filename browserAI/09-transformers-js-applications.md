# 第九課：Transformers.js 應用（1 週）

## 9.1 本課目標

這一課要把你從「影像推論」帶到「文字 AI 應用」。  
你會在瀏覽器中直接使用 Transformers.js，做出可互動的 NLP 工具。

本課重點：

- 文本 embedding（語意向量）
- 文本分類（情緒分析）
- 文字生成（auto-regressive generation）
- 作業：**做一個情緒分析或摘要/生成工具**

---

## 9.2 為什麼學 Transformers.js？

Transformers.js 讓你不用後端就能在瀏覽器端跑 Transformer 模型。  
這在以下情境非常有價值：

- 隱私需求高（資料不離端）
- 低延遲互動（不用每次請求伺服器）
- 離線/弱網路場景（模型可本地快取）

---

## 9.3 三種常見文字任務

### 1) Classification（分類）

- 輸入一句話
- 輸出類別（正向/負向、主題分類…）

### 2) Embedding（向量化）

- 將文字轉成向量
- 可做相似度搜尋、語意比對、RAG 檢索

### 3) Generation（生成）

- 根據提示詞接續生成文字
- 可做寫作輔助、草稿、改寫

---

## 9.4 本課實作架構

你會做一個「NLP Playground」：

- 情緒分析（text-classification）
- embedding 相似度（feature-extraction）
- 文字生成（text-generation）

採 lazy loading：第一次使用某功能才下載對應模型，避免一進頁就載很多資源。

---

## 9.5 本週作業規格

### 必做

- 至少完成 1 個分類任務（情緒分析）
- 顯示推論耗時
- 顯示 Top label 與分數

### 建議加分

- 加入 embedding 相似度
- 加入文字生成與參數控制（temperature / max tokens）
- 顯示模型載入耗時與狀態

---

## 9.6 常見錯誤與排查

### 問題一：模型第一次載入很慢

- 這是正常的（模型下載 + 初始化）
- 可在 UI 上明確提示「第一次較慢，後續會快很多」

### 問題二：生成結果重複或品質差

- 調整 `temperature`、`top_p`、`repetition_penalty`
- 提示詞需更具體

### 問題三：embedding 相似度怪異

- 先確認有做 normalize
- 比較同語言文本，跨語言模型需對應 multilingual 模型

---

## 9.7 本章小結

- 你已掌握 Transformers.js 三種核心任務
- 你能在瀏覽器做分類、檢索、生成應用
- 你已具備下一課 Browser LLM 的實作基礎

---

## 9.8 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-09-transformers-playground/
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
    <title>Lesson 09 - Transformers.js Playground</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 09：Transformers.js NLP Playground</h1>
      <p class="subtitle">情緒分析、語意相似度、文字生成三合一練習</p>

      <section class="panel">
        <h2>Global Status</h2>
        <pre id="status">等待操作...</pre>
      </section>

      <section class="panel">
        <h2>A) Sentiment Analysis</h2>
        <textarea id="sentimentInput" rows="4" placeholder="輸入一句話，例如：This product is amazing!"></textarea>
        <div class="row">
          <button id="sentimentBtn">Analyze Sentiment</button>
        </div>
        <div id="sentimentResult">尚未執行。</div>
      </section>

      <section class="panel">
        <h2>B) Embedding Similarity</h2>
        <label>
          Query
          <input id="embedQuery" type="text" placeholder="例如：webgpu for ai acceleration" />
        </label>
        <label>
          Candidates（每行一筆）
          <textarea id="embedCandidates" rows="5">webgpu speeds up matrix operations
frontend animation with css transforms
browser ai inference with on-device models
traditional sql optimization tips</textarea>
        </label>
        <div class="row">
          <button id="embedBtn">Compute Similarity</button>
        </div>
        <div id="embedResult">尚未執行。</div>
      </section>

      <section class="panel">
        <h2>C) Text Generation</h2>
        <label>
          Prompt
          <textarea id="genPrompt" rows="4" placeholder="例如：Write a short study plan for learning WebGPU and Browser AI."></textarea>
        </label>
        <div class="row">
          <label>
            Max New Tokens
            <input id="maxTokensInput" type="number" min="16" max="256" value="64" />
          </label>
          <label>
            Temperature
            <input id="temperatureInput" type="number" min="0.1" max="1.5" step="0.1" value="0.8" />
          </label>
          <button id="genBtn">Generate Text</button>
        </div>
        <div id="genResult">尚未執行。</div>
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
  color: #bfcaeb;
}

.panel {
  margin-top: 14px;
  background: #161e36;
  border: 1px solid #344879;
  border-radius: 10px;
  padding: 14px;
}

textarea,
input,
button {
  width: 100%;
  border: 1px solid #4e68aa;
  border-radius: 8px;
  background: #0f1831;
  color: #eef3ff;
  padding: 10px;
  margin-top: 8px;
}

button {
  cursor: pointer;
  background: #2f73ff;
  border-color: #2f73ff;
}

.row {
  display: flex;
  gap: 10px;
  align-items: end;
  margin-top: 8px;
}

.row > * {
  flex: 1;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}

.ok {
  color: #86f0aa;
}

.warn {
  color: #ffd68a;
}

.result-list {
  margin: 8px 0 0;
  padding-left: 20px;
}

.result-list li {
  margin: 6px 0;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
```

### `app.js`

```javascript
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/+esm";

const statusEl = document.querySelector("#status");

const sentimentInput = document.querySelector("#sentimentInput");
const sentimentBtn = document.querySelector("#sentimentBtn");
const sentimentResult = document.querySelector("#sentimentResult");

const embedQuery = document.querySelector("#embedQuery");
const embedCandidates = document.querySelector("#embedCandidates");
const embedBtn = document.querySelector("#embedBtn");
const embedResult = document.querySelector("#embedResult");

const genPrompt = document.querySelector("#genPrompt");
const maxTokensInput = document.querySelector("#maxTokensInput");
const temperatureInput = document.querySelector("#temperatureInput");
const genBtn = document.querySelector("#genBtn");
const genResult = document.querySelector("#genResult");

env.allowLocalModels = false;
env.allowRemoteModels = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
}

const cache = {
  sentiment: null,
  embedding: null,
  generation: null
};

const MODEL_CONFIG = {
  sentiment: {
    task: "text-classification",
    model: "Xenova/distilbert-base-uncased-finetuned-sst-2-english"
  },
  embedding: {
    task: "feature-extraction",
    model: "Xenova/all-MiniLM-L6-v2"
  },
  generation: {
    task: "text-generation",
    model: "Xenova/distilgpt2"
  }
};

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getPipeline(kind) {
  if (cache[kind]) return cache[kind];

  const conf = MODEL_CONFIG[kind];
  setStatus(`載入 ${kind} 模型中：${conf.model}（首次會較慢）...`);

  const start = performance.now();
  const instance = await pipeline(conf.task, conf.model);
  const elapsed = performance.now() - start;
  cache[kind] = instance;

  setStatus(`${kind} 模型載入完成（${elapsed.toFixed(2)} ms）。`);
  return instance;
}

function toVector(output) {
  if (!output) return [];
  if (output.data) return Array.from(output.data);
  if (Array.isArray(output)) return output.flat(Infinity);
  if (typeof output.tolist === "function") return output.tolist().flat(Infinity);
  return [];
}

function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function runSentiment() {
  const text = sentimentInput.value.trim();
  if (!text) {
    sentimentResult.textContent = "請先輸入文字。";
    return;
  }

  sentimentBtn.disabled = true;
  sentimentResult.textContent = "分析中...";

  try {
    const clf = await getPipeline("sentiment");
    const t0 = performance.now();
    const output = await clf(text, { topk: 2 });
    const inferMs = performance.now() - t0;

    const rows = (Array.isArray(output) ? output : [output])
      .map((item) => {
        const label = escapeHtml(item.label || "UNKNOWN");
        const score = ((item.score || 0) * 100).toFixed(2);
        return `<li><span>${label}</span><strong>${score}%</strong></li>`;
      })
      .join("");

    sentimentResult.innerHTML = `
      <p class="ok">Inference: ${inferMs.toFixed(2)} ms</p>
      <ol class="result-list">${rows}</ol>
    `;
    setStatus("情緒分析完成。");
  } catch (error) {
    console.error(error);
    sentimentResult.textContent = `分析失敗：${error.message}`;
    setStatus("情緒分析失敗。");
  } finally {
    sentimentBtn.disabled = false;
  }
}

async function runEmbeddingSimilarity() {
  const query = embedQuery.value.trim();
  const candidates = embedCandidates.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!query || candidates.length === 0) {
    embedResult.textContent = "請輸入 query 與至少一筆 candidate。";
    return;
  }

  embedBtn.disabled = true;
  embedResult.textContent = "計算中...";

  try {
    const extractor = await getPipeline("embedding");
    const t0 = performance.now();

    const qOut = await extractor(query, { pooling: "mean", normalize: true });
    const qVec = toVector(qOut);

    const scored = [];
    for (const text of candidates) {
      const cOut = await extractor(text, { pooling: "mean", normalize: true });
      const cVec = toVector(cOut);
      scored.push({ text, score: cosineSimilarity(qVec, cVec) });
    }
    scored.sort((a, b) => b.score - a.score);

    const elapsed = performance.now() - t0;
    const rows = scored
      .map(
        (item) =>
          `<li><span>${escapeHtml(item.text)}</span><strong>${item.score.toFixed(4)}</strong></li>`
      )
      .join("");

    embedResult.innerHTML = `
      <p class="ok">Embedding similarity done in ${elapsed.toFixed(2)} ms</p>
      <ol class="result-list">${rows}</ol>
    `;
    setStatus("語意相似度計算完成。");
  } catch (error) {
    console.error(error);
    embedResult.textContent = `計算失敗：${error.message}`;
    setStatus("語意相似度失敗。");
  } finally {
    embedBtn.disabled = false;
  }
}

function parseGeneratedText(output) {
  if (Array.isArray(output) && output.length > 0) {
    return output[0].generated_text || output[0].text || JSON.stringify(output[0]);
  }
  if (typeof output === "string") return output;
  return JSON.stringify(output);
}

async function runGeneration() {
  const prompt = genPrompt.value.trim();
  if (!prompt) {
    genResult.textContent = "請先輸入 prompt。";
    return;
  }

  const maxNewTokens = Number(maxTokensInput.value);
  const temperature = Number(temperatureInput.value);

  genBtn.disabled = true;
  genResult.textContent = "生成中...";

  try {
    const generator = await getPipeline("generation");
    const t0 = performance.now();

    const output = await generator(prompt, {
      max_new_tokens: maxNewTokens,
      temperature,
      top_p: 0.92,
      repetition_penalty: 1.1
    });

    const elapsed = performance.now() - t0;
    const text = parseGeneratedText(output);

    genResult.innerHTML = `
      <p class="ok">Generation done in ${elapsed.toFixed(2)} ms</p>
      <pre>${escapeHtml(text)}</pre>
    `;
    setStatus("文字生成完成。");
  } catch (error) {
    console.error(error);
    genResult.textContent = `生成失敗：${error.message}`;
    setStatus("文字生成失敗。");
  } finally {
    genBtn.disabled = false;
  }
}

sentimentBtn.addEventListener("click", runSentiment);
embedBtn.addEventListener("click", runEmbeddingSimilarity);
genBtn.addEventListener("click", runGeneration);
```

---

> 下一課：`10-browser-llm-webllm-local-inference.md`（WebLLM、本地推論與 token 流式輸出）
