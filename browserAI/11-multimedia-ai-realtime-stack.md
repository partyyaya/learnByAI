# 第十一課：多媒體 AI：WebRTC / WebAudio / WebCodecs 整合（1 週）

## 11.1 本課目標

這一課你要把 Browser AI 從「單次推論」提升到「即時串流系統」。  
你會整合相機與麥克風資料流，做連續推論與監測。

本課重點：

- WebRTC：即時媒體來源（camera/mic）
- WebAudio：音訊特徵與簡易 VAD（語音活動偵測）
- WebCodecs（或 TrackProcessor）：影片幀處理統計
- 作業：**即時語音/影像分析 prototype**

---

## 11.2 即時 AI 的核心挑戰

即時系統常見瓶頸：

- 推論太頻繁造成主執行緒卡頓
- 視訊與音訊管線彼此搶資源
- FPS、延遲、功耗三者取捨

所以本課會強調「節流 + 指標可視化 + 降級策略」。

---

## 11.3 架構總覽

```text
getUserMedia(video+audio)
   ├─> <video> 預覽
   ├─> WebAudio Analyser -> RMS -> VAD
   ├─> TF.js MobileNet -> 場景/物件語意分類
   └─> MediaStreamTrackProcessor(可用時) -> VideoFrame FPS 統計
```

---

## 11.4 本週作業規格

### 必做

- 可啟動/停止 camera + mic
- 每隔固定時間做影像分類並顯示 Top-K
- 顯示音量與語音活動狀態（VAD）

### 建議加分

- 顯示推論 FPS 與幀處理 FPS
- 推論節流策略（例如每 500ms 一次）
- 依裝置能力調整解析度（720p / 480p）

---

## 11.5 常見錯誤與排查

### 問題一：相機畫面正常但推論速度很慢

- 降低視訊解析度
- 降低推論頻率（例如 300ms -> 800ms）
- 初始化時先 warmup 模型

### 問題二：麥克風有聲音但 VAD 一直 false

- 檢查 threshold 設定是否過高
- 不同裝置音量尺度不同，需可調整

### 問題三：WebCodecs API 不可用

- 某些瀏覽器/版本不支援主執行緒 `MediaStreamTrackProcessor`
- 需做能力檢查與 graceful fallback

---

## 11.6 本章小結

- 你已把即時媒體流與 AI 推論整合成一套管線
- 你能同時處理影像與音訊訊號
- 你具備產品化即時 AI prototype 的核心能力

---

## 11.7 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-11-realtime-multimedia-ai/
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
    <title>Lesson 11 - Realtime Multimedia AI</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 11：Realtime Multimedia AI Prototype</h1>
      <p class="subtitle">WebRTC + WebAudio + WebCodecs + Browser AI</p>

      <section class="panel controls">
        <label>
          Resolution
          <select id="resolutionSelect">
            <option value="1280x720" selected>1280x720</option>
            <option value="960x540">960x540</option>
            <option value="640x480">640x480</option>
          </select>
        </label>

        <label>
          Inference Interval (ms)
          <input id="intervalInput" type="number" min="200" max="2000" step="100" value="700" />
        </label>

        <label>
          VAD Threshold
          <input id="vadInput" type="range" min="0.005" max="0.2" step="0.001" value="0.03" />
        </label>

        <button id="startBtn">Start Stream + AI</button>
        <button id="stopBtn" disabled>Stop</button>
      </section>

      <section class="panel video-panel">
        <video id="videoEl" autoplay playsinline muted></video>
      </section>

      <section class="panel metrics">
        <div>
          <h3>Status</h3>
          <pre id="status">等待啟動...</pre>
        </div>
        <div>
          <h3>Audio</h3>
          <p>RMS: <span id="rmsValue">0.0000</span></p>
          <p>Speech Active: <span id="vadState">false</span></p>
        </div>
        <div>
          <h3>Video Stats</h3>
          <p>AI Inference FPS: <span id="aiFps">0.00</span></p>
          <p>Frame Processor FPS: <span id="frameFps">N/A</span></p>
        </div>
      </section>

      <section class="panel">
        <h2>Top-3 Scene Predictions</h2>
        <div id="predictions">尚未執行。</div>
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
  background: #0b1020;
  color: #ecf2ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.container {
  max-width: 1024px;
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
  flex-wrap: wrap;
  gap: 12px;
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
  background: #0f1831;
  color: #ecf2ff;
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

.video-panel {
  padding: 8px;
}

#videoEl {
  width: 100%;
  max-height: 560px;
  border-radius: 8px;
  border: 1px solid #394e86;
  background: #080d19;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 900px) {
  .metrics {
    grid-template-columns: 1fr;
  }
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
import * as tf from "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/+esm";
import "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.20.0/+esm";
import "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.20.0/+esm";
import * as mobilenet from "https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/+esm";

const resolutionSelect = document.querySelector("#resolutionSelect");
const intervalInput = document.querySelector("#intervalInput");
const vadInput = document.querySelector("#vadInput");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const videoEl = document.querySelector("#videoEl");
const statusEl = document.querySelector("#status");
const rmsValueEl = document.querySelector("#rmsValue");
const vadStateEl = document.querySelector("#vadState");
const aiFpsEl = document.querySelector("#aiFps");
const frameFpsEl = document.querySelector("#frameFps");
const predictionsEl = document.querySelector("#predictions");

const state = {
  stream: null,
  model: null,
  running: false,
  audioContext: null,
  analyser: null,
  aiTimer: null,
  animationId: null,
  inferCount: 0,
  inferStartTs: 0,
  frameProcessorStop: null
};

function setStatus(text) {
  statusEl.textContent = text;
}

async function selectTfBackend() {
  const candidates = "gpu" in navigator ? ["webgpu", "webgl", "cpu"] : ["webgl", "cpu"];
  for (const name of candidates) {
    try {
      await tf.setBackend(name);
      await tf.ready();
      return name;
    } catch {
      // try next
    }
  }
  throw new Error("無法初始化任何 TF.js backend。");
}

function parseResolution(value) {
  const [w, h] = value.split("x").map(Number);
  return { width: w, height: h };
}

function renderPredictions(items) {
  if (!items?.length) {
    predictionsEl.textContent = "無預測結果。";
    return;
  }
  const html = items
    .map(
      (item) =>
        `<li><span>${item.className}</span><strong>${(item.probability * 100).toFixed(2)}%</strong></li>`
    )
    .join("");
  predictionsEl.innerHTML = `<ol class="pred-list">${html}</ol>`;
}

function updateAudioMeter() {
  if (!state.running || !state.analyser) return;

  const buffer = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(buffer);

  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const normalized = (buffer[i] - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / buffer.length);
  const threshold = Number(vadInput.value);
  const speaking = rms > threshold;

  rmsValueEl.textContent = rms.toFixed(4);
  vadStateEl.textContent = String(speaking);
  vadStateEl.className = speaking ? "ok" : "";

  state.animationId = requestAnimationFrame(updateAudioMeter);
}

async function startFrameProcessor(videoTrack) {
  frameFpsEl.textContent = "N/A";

  if (!("MediaStreamTrackProcessor" in window)) {
    setStatus("MediaStreamTrackProcessor 不可用，略過 WebCodecs 幀統計。");
    return;
  }

  try {
    const processor = new MediaStreamTrackProcessor({ track: videoTrack });
    const reader = processor.readable.getReader();

    let stop = false;
    state.frameProcessorStop = () => {
      stop = true;
      reader.cancel().catch(() => {});
    };

    let frames = 0;
    let windowStart = performance.now();

    while (!stop) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;

      frames += 1;
      frame.close();

      const now = performance.now();
      if (now - windowStart >= 1000) {
        const fps = (frames * 1000) / (now - windowStart);
        frameFpsEl.textContent = fps.toFixed(2);
        frames = 0;
        windowStart = now;
      }
    }
  } catch (error) {
    console.warn("Frame processor unavailable on this browser context.", error);
    frameFpsEl.textContent = "N/A";
  }
}

async function start() {
  if (state.running) return;

  startBtn.disabled = true;
  setStatus("初始化中...");

  try {
    const { width, height } = parseResolution(resolutionSelect.value);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width, height, facingMode: "user" },
      audio: true
    });

    state.stream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();

    const backend = await selectTfBackend();
    setStatus(`TF.js backend=${backend}，載入 MobileNet...`);
    state.model = await mobilenet.load({ version: 2, alpha: 1.0 });

    // warmup
    await state.model.classify(videoEl, 1);

    // audio pipeline
    state.audioContext = new AudioContext();
    const source = state.audioContext.createMediaStreamSource(stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    source.connect(state.analyser);

    state.running = true;
    state.inferCount = 0;
    state.inferStartTs = performance.now();
    updateAudioMeter();

    const intervalMs = Math.max(200, Number(intervalInput.value));
    state.aiTimer = setInterval(async () => {
      if (!state.running || !state.model) return;
      try {
        const preds = await state.model.classify(videoEl, 3);
        renderPredictions(preds);
        state.inferCount += 1;
        const elapsed = performance.now() - state.inferStartTs;
        if (elapsed > 0) {
          aiFpsEl.textContent = ((state.inferCount * 1000) / elapsed).toFixed(2);
        }
      } catch (error) {
        console.warn("inference error", error);
      }
    }, intervalMs);

    const [videoTrack] = stream.getVideoTracks();
    startFrameProcessor(videoTrack);

    setStatus("已啟動：即時影像分類 + 音訊活動偵測中。");
    stopBtn.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus(`啟動失敗：${error.message}`);
  } finally {
    startBtn.disabled = false;
  }
}

function stop() {
  if (!state.running) return;

  state.running = false;
  if (state.aiTimer) {
    clearInterval(state.aiTimer);
    state.aiTimer = null;
  }
  if (state.animationId) {
    cancelAnimationFrame(state.animationId);
    state.animationId = null;
  }
  if (state.frameProcessorStop) {
    state.frameProcessorStop();
    state.frameProcessorStop = null;
  }

  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }

  videoEl.srcObject = null;
  predictionsEl.textContent = "已停止。";
  aiFpsEl.textContent = "0.00";
  frameFpsEl.textContent = "N/A";
  rmsValueEl.textContent = "0.0000";
  vadStateEl.textContent = "false";
  vadStateEl.className = "";
  stopBtn.disabled = true;
  setStatus("已停止串流與推論。");
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
```

---

> 下一課：`12-productization-and-deployment.md`（PWA、快取、回退策略與部署）
