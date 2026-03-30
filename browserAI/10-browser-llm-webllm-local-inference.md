# 第十課：Browser LLM：WebLLM / 本地推論（1 週）

## 10.1 本課目標

這一課要把你帶進 Browser LLM 實戰：  
在瀏覽器端載入量化模型，做本地聊天、token 流式輸出與資源管理。

本課重點：

- WebLLM 基本架構與模型載入
- 量化（q4f16）與記憶體限制概念
- 流式輸出（streaming tokens）
- 作業：**本地聊天 demo（可離線）**

---

## 10.2 為什麼 Browser LLM 值得學？

與雲端 API 相比，Browser LLM 有三個關鍵價值：

- **資料隱私**：對話內容不必送出裝置
- **低延遲互動**：省掉網路往返
- **可離線**：模型快取後可在離線環境運作

代價是：

- 模型大小與設備記憶體壓力
- 首次下載較慢

---

## 10.3 量化與模型選型

常見命名中的 `q4f16` 可粗略理解為：

- 權重採用 4-bit 量化，減少模型大小
- 部分運算/儲存使用 fp16

實務建議：

1. 先用小模型（1B~3B）確認流程
2. 再評估是否升級模型品質
3. 在 UI 提供模型切換與硬體建議

---

## 10.4 WebLLM 推論流程

```text
選模型 -> CreateMLCEngine
  ↓
等待載入（顯示進度）
  ↓
建立 messages（system/user/assistant）
  ↓
chat.completions.create(stream: true)
  ↓
for await chunk 逐字更新 UI
```

---

## 10.5 本週作業規格

### 必做

- 建立本地聊天頁（WebLLM）
- 支援 token 串流輸出
- 顯示模型載入進度

### 建議加分

- 模型切換（不同量化等級）
- token usage 顯示
- 離線狀態提示與失敗回退訊息

---

## 10.6 記憶體與相容性建議

- 先檢查 `navigator.gpu` 是否可用
- 低記憶體裝置優先小模型
- 若初始化失敗，提示使用者改用更小模型或關閉其他高占用應用

---

## 10.7 常見錯誤與排查

### 問題一：模型載入失敗

- 可能是記憶體不足、WebGPU 不可用或模型 ID 不匹配
- 先切到更小模型並重試

### 問題二：輸出中斷或很慢

- 首次載入仍在快取階段
- 請確認是否在串流循環中持續更新 UI

### 問題三：聊天上下文失控

- 長對話會推高 token 使用量
- 需要做 message 截斷或摘要（後續可擴充）

---

## 10.8 本章小結

- 你已掌握 Browser LLM 的最小可行產品做法
- 你能做本地模型載入與流式聊天
- 你完成可離線運作的核心架構雛形

---

## 10.9 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-10-webllm-local-chat/
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
    <title>Lesson 10 - WebLLM Local Chat</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 10：WebLLM Local Chat</h1>
      <p class="subtitle">本地模型 + token 串流輸出 + 記憶體提示</p>

      <section class="panel controls">
        <label>
          Model
          <select id="modelSelect">
            <option value="mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC" selected>
              Llama-3.2-1B-Instruct-q4f16_1
            </option>
            <option value="mlc-ai/Llama-3.2-1B-Instruct-q4f16_0-MLC">
              Llama-3.2-1B-Instruct-q4f16_0
            </option>
          </select>
        </label>

        <label>
          Temperature
          <input id="temperatureInput" type="number" min="0.1" max="1.5" step="0.1" value="0.7" />
        </label>

        <label>
          Max Tokens
          <input id="maxTokensInput" type="number" min="32" max="1024" step="16" value="256" />
        </label>

        <button id="initBtn">1) 初始化模型</button>
        <button id="clearBtn">Clear Chat</button>
      </section>

      <section class="panel">
        <h2>Status</h2>
        <p><strong>Device Memory:</strong> <span id="memoryInfo">unknown</span></p>
        <pre id="status">等待初始化...</pre>
      </section>

      <section class="panel chat-panel">
        <div id="chatLog" class="chat-log"></div>
        <textarea id="userInput" rows="4" placeholder="輸入問題，例如：幫我規劃四週的 WebGPU 學習計畫"></textarea>
        <div class="row">
          <button id="sendBtn" disabled>2) Send</button>
        </div>
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
  color: #becaec;
}

.panel {
  margin-top: 14px;
  background: #151d35;
  border: 1px solid #334878;
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
textarea,
button {
  border: 1px solid #4b64a6;
  border-radius: 8px;
  background: #0f1831;
  color: #edf3ff;
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

.chat-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-log {
  min-height: 320px;
  max-height: 520px;
  overflow: auto;
  border: 1px solid #3a4f85;
  border-radius: 8px;
  padding: 10px;
  background: #0c142a;
}

.message {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  white-space: pre-wrap;
}

.message.user {
  background: #1a335f;
}

.message.assistant {
  background: #1d2a48;
}

.message.system {
  background: #2c2d39;
  color: #ffe0a7;
}

.row {
  display: flex;
  gap: 10px;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.82";

const modelSelect = document.querySelector("#modelSelect");
const temperatureInput = document.querySelector("#temperatureInput");
const maxTokensInput = document.querySelector("#maxTokensInput");
const initBtn = document.querySelector("#initBtn");
const clearBtn = document.querySelector("#clearBtn");
const sendBtn = document.querySelector("#sendBtn");
const userInput = document.querySelector("#userInput");
const chatLog = document.querySelector("#chatLog");
const statusEl = document.querySelector("#status");
const memoryInfoEl = document.querySelector("#memoryInfo");

const state = {
  engine: null,
  loading: false,
  generating: false,
  messages: [
    {
      role: "system",
      content:
        "You are a concise Browser AI tutor. Answer in Traditional Chinese when user writes Chinese."
    }
  ]
};

function setStatus(text) {
  statusEl.textContent = text;
}

function appendMessage(role, content) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = content;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function syncSendButton() {
  sendBtn.disabled = !(state.engine && !state.loading && !state.generating);
}

function showMemoryHint() {
  const dm = navigator.deviceMemory;
  memoryInfoEl.textContent = dm ? `${dm} GB (approx)` : "unknown";
  if (dm && dm <= 4) {
    appendMessage(
      "system",
      "裝置記憶體較小，建議優先使用 1B 級別模型，並避免開啟過多分頁。"
    );
  }
}

async function initModel() {
  if (state.loading) return;
  if (!("gpu" in navigator)) {
    setStatus("此瀏覽器不支援 WebGPU，WebLLM 很可能無法運作。");
    return;
  }

  const model = modelSelect.value;
  state.loading = true;
  syncSendButton();
  initBtn.disabled = true;
  setStatus(`初始化模型：${model}`);

  try {
    const start = performance.now();
    state.engine = await webllm.CreateMLCEngine(model, {
      initProgressCallback: (report) => {
        const pct =
          typeof report.progress === "number" ? `${(report.progress * 100).toFixed(1)}%` : "N/A";
        const text = report.text || "loading";
        setStatus(`模型載入中：${pct} | ${text}`);
      }
    });

    const elapsed = performance.now() - start;
    setStatus(`模型已就緒（${elapsed.toFixed(2)} ms）`);
    appendMessage("system", `模型已載入：${model}`);
  } catch (error) {
    console.error(error);
    setStatus(`模型初始化失敗：${error.message}`);
    appendMessage("system", "初始化失敗，請嘗試較小模型或確認瀏覽器/硬體支援。");
  } finally {
    state.loading = false;
    initBtn.disabled = false;
    syncSendButton();
  }
}

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text || !state.engine || state.generating) return;

  state.generating = true;
  syncSendButton();
  userInput.value = "";

  const userMsg = { role: "user", content: text };
  state.messages.push(userMsg);
  appendMessage("user", text);
  const assistantEl = appendMessage("assistant", "...");

  setStatus("生成中（streaming）...");

  try {
    const temperature = Number(temperatureInput.value);
    const maxTokens = Number(maxTokensInput.value);
    const stream = await state.engine.chat.completions.create({
      messages: state.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature,
      max_tokens: maxTokens
    });

    let answer = "";
    let usageInfo = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      answer += delta;
      assistantEl.textContent = answer || "...";

      if (chunk.usage) {
        usageInfo = `prompt_tokens=${chunk.usage.prompt_tokens}, completion_tokens=${chunk.usage.completion_tokens}`;
      }
    }

    state.messages.push({ role: "assistant", content: answer });
    setStatus(`完成。${usageInfo || "usage unavailable"}`);
  } catch (error) {
    console.error(error);
    assistantEl.textContent = `生成失敗：${error.message}`;
    setStatus("生成失敗。");
  } finally {
    state.generating = false;
    syncSendButton();
  }
}

function clearChat() {
  chatLog.innerHTML = "";
  state.messages = [
    {
      role: "system",
      content:
        "You are a concise Browser AI tutor. Answer in Traditional Chinese when user writes Chinese."
    }
  ];
  appendMessage("system", "對話已清空。");
  setStatus("已重置聊天上下文。");
}

initBtn.addEventListener("click", initModel);
sendBtn.addEventListener("click", sendMessage);
clearBtn.addEventListener("click", clearChat);

showMemoryHint();
appendMessage("system", "請先初始化模型，再開始本地聊天。");
```

---

> 下一課：`11-multimedia-ai-realtime-stack.md`（即時語音/影像串流與 AI 推論整合）
