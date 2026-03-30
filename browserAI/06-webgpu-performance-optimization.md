# 第六課：WebGPU 效能分析與最佳化（1 週）

## 6.1 本課目標

前面你已經能把運算丟到 GPU，但「能跑」不等於「跑得快」。  
這一課要建立你做效能診斷的能力，避免只看單次結果就下結論。

本課重點：

- GPU timing 的基本量測方式
- batching（減少提交與同步次數）
- 記憶體拷貝成本（尤其 readback）
- 作業：**做一份優化前後 benchmark 報告**

---

## 6.2 為什麼很多 WebGPU 專案「看起來 GPU 很慢」？

常見原因不是 GPU 計算本身，而是：

- 每次都重建 pipeline / buffer
- 每輪都做 readback（`mapAsync`）強制同步
- dispatch 太碎、submit 次數過多

所以這課會把「計算成本」和「流程成本」拆開看。

---

## 6.3 三種最常見的成本

### 1) Setup Cost

- 建立 shader module、pipeline、bind group layout
- 若每輪重建，成本會被放大

### 2) Dispatch / Submit Cost

- GPU 指令提交本身有固定開銷
- 小任務被切太碎時，開銷比例會很高

### 3) Readback Cost

- `copyBufferToBuffer` + `mapAsync` 會讓 CPU 等 GPU
- 若每次都讀回，吞吐量會大幅下降

---

## 6.4 本課實驗設計（同一工作量，三種策略）

我們用同一個 compute workload（向量乘加）比較：

1. **Naive**：每輪重建 pipeline + buffer + 每輪 readback
2. **Reuse**：pipeline/buffer 重用，但每輪 readback
3. **Batched**：重用資源，合併多輪 dispatch，最後只 readback 一次

你會看到這三者的差異通常非常明顯。

---

## 6.5 指標怎麼看？

- `Total Time`：整段任務時間
- `Per Round Avg`：平均每輪成本
- `Throughput`：每秒處理元素數
- `Speedup`：相對於 Naive 的加速比

> 注意：單次跑結果噪音大，至少跑 3 次以上再看平均。

---

## 6.6 本週作業規格

### 必做

- 跑出三種策略的 benchmark
- 產出一張對比表（total / avg / speedup）
- 簡述你觀察到的瓶頸

### 建議加分

- 比較不同 `rounds` 與 `innerLoops`
- 加入「是否每輪 readback」的切換
- 分析「資料量變大」時哪個策略受益最大

---

## 6.7 常見誤區

### 誤區一：只看一次測試就下結論

- 請至少做 warmup + 多輪平均

### 誤區二：把 readback 當成「計算時間」

- readback 是同步與搬運成本，不等於純計算

### 誤區三：每次交互都重建全部資源

- 只改參數時，應優先 `writeBuffer`，不重建 pipeline

---

## 6.8 本章小結

- 你已掌握 WebGPU 效能分析的核心觀念
- 你能區分 setup/dispatch/readback 三種成本
- 你具備做第七課模型推論效能優化的基礎能力

---

## 6.9 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-06-webgpu-perf-lab/
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
    <title>Lesson 06 - WebGPU Performance Lab</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 06：WebGPU Performance Optimization Lab</h1>
      <p class="subtitle">比較 Naive / Reuse / Batched 三種執行策略</p>

      <section class="panel controls">
        <label>
          Vector Length
          <select id="lengthSelect">
            <option value="65536">65,536</option>
            <option value="131072" selected>131,072</option>
            <option value="262144">262,144</option>
            <option value="524288">524,288</option>
          </select>
        </label>

        <label>
          Inner Loops (per invocation)
          <select id="innerSelect">
            <option value="64">64</option>
            <option value="128" selected>128</option>
            <option value="256">256</option>
            <option value="512">512</option>
          </select>
        </label>

        <label>
          Rounds
          <input id="roundInput" type="number" min="1" max="20" value="8" />
        </label>

        <button id="runBtn">Run Benchmark</button>
      </section>

      <section class="panel">
        <h2>Status</h2>
        <pre id="status">等待執行...</pre>
      </section>

      <section class="panel">
        <h2>Result</h2>
        <div id="result">尚未執行。</div>
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
  background: #0a1020;
  color: #ecf2ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.container {
  max-width: 980px;
  margin: 26px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #bdc9ec;
}

.panel {
  margin-top: 14px;
  background: #161f38;
  border: 1px solid #334673;
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
  border: 1px solid #4a63a4;
  border-radius: 8px;
  background: #0f1730;
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

.result-table {
  width: 100%;
  border-collapse: collapse;
}

.result-table th,
.result-table td {
  border: 1px solid #3a4f84;
  padding: 10px;
  text-align: left;
}

.good {
  color: #88f1ab;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
const runBtn = document.querySelector("#runBtn");
const lengthSelect = document.querySelector("#lengthSelect");
const innerSelect = document.querySelector("#innerSelect");
const roundInput = document.querySelector("#roundInput");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");

function setStatus(text) {
  statusEl.textContent = text;
}

const state = {
  device: null,
  sharedPipeline: null
};

function randomVector(length) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.random() * 2 - 1;
  }
  return out;
}

function checksum(arr, limit = 256) {
  const n = Math.min(limit, arr.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += arr[i];
  return sum;
}

async function ensureDevice() {
  if (state.device) return state.device;

  if (!("gpu" in navigator)) {
    throw new Error("瀏覽器不支援 WebGPU。");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("找不到可用 GPU adapter。");
  const device = await adapter.requestDevice();
  state.device = device;
  return device;
}

function createPipeline(device) {
  const module = device.createShaderModule({
    code: `
struct Params {
  length: u32,
  innerLoops: u32,
  _pad0: u32,
  _pad1: u32
}

@group(0) @binding(0) var<storage, read> inputA: array<f32>;
@group(0) @binding(1) var<storage, read> inputB: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.length) {
    return;
  }

  let a = inputA[i];
  let b = inputB[i];
  var acc = 0.0;

  for (var k: u32 = 0u; k < params.innerLoops; k = k + 1u) {
    acc = acc + a * b + f32(k) * 0.000001;
  }

  output[i] = acc;
}
`
  });

  return device.createComputePipeline({
    layout: "auto",
    compute: {
      module,
      entryPoint: "main"
    }
  });
}

function createBuffers(device, length) {
  const bytes = length * 4;
  return {
    aBuffer: device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    }),
    bBuffer: device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    }),
    outBuffer: device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    }),
    readBuffer: device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    }),
    paramsBuffer: device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
  };
}

function destroyBuffers(buffers) {
  buffers.aBuffer.destroy();
  buffers.bBuffer.destroy();
  buffers.outBuffer.destroy();
  buffers.readBuffer.destroy();
  buffers.paramsBuffer.destroy();
}

function makeBindGroup(device, pipeline, buffers) {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: buffers.aBuffer } },
      { binding: 1, resource: { buffer: buffers.bBuffer } },
      { binding: 2, resource: { buffer: buffers.outBuffer } },
      { binding: 3, resource: { buffer: buffers.paramsBuffer } }
    ]
  });
}

async function readOutput(buffers, length) {
  await buffers.readBuffer.mapAsync(GPUMapMode.READ);
  const mapped = buffers.readBuffer.getMappedRange();
  const data = new Float32Array(mapped.slice(0, length * 4));
  buffers.readBuffer.unmap();
  return data;
}

async function runNaive(device, length, innerLoops, rounds, a, b) {
  const times = [];
  let finalChecksum = 0;

  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();

    const pipeline = createPipeline(device);
    const buffers = createBuffers(device, length);
    const bindGroup = makeBindGroup(device, pipeline, buffers);

    device.queue.writeBuffer(buffers.aBuffer, 0, a);
    device.queue.writeBuffer(buffers.bBuffer, 0, b);
    device.queue.writeBuffer(buffers.paramsBuffer, 0, new Uint32Array([length, innerLoops, 0, 0]));

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(length / 256));
    pass.end();
    encoder.copyBufferToBuffer(buffers.outBuffer, 0, buffers.readBuffer, 0, length * 4);

    device.queue.submit([encoder.finish()]);
    const out = await readOutput(buffers, length);
    finalChecksum = checksum(out);
    destroyBuffers(buffers);

    times.push(performance.now() - t0);
  }

  return { times, finalChecksum };
}

async function runReuse(device, pipeline, length, innerLoops, rounds, a, b) {
  const times = [];
  let finalChecksum = 0;

  const buffers = createBuffers(device, length);
  const bindGroup = makeBindGroup(device, pipeline, buffers);
  device.queue.writeBuffer(buffers.aBuffer, 0, a);
  device.queue.writeBuffer(buffers.bBuffer, 0, b);
  device.queue.writeBuffer(buffers.paramsBuffer, 0, new Uint32Array([length, innerLoops, 0, 0]));

  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(length / 256));
    pass.end();
    encoder.copyBufferToBuffer(buffers.outBuffer, 0, buffers.readBuffer, 0, length * 4);

    device.queue.submit([encoder.finish()]);
    const out = await readOutput(buffers, length);
    finalChecksum = checksum(out);
    times.push(performance.now() - t0);
  }

  destroyBuffers(buffers);
  return { times, finalChecksum };
}

async function runBatched(device, pipeline, length, innerLoops, rounds, a, b) {
  const buffers = createBuffers(device, length);
  const bindGroup = makeBindGroup(device, pipeline, buffers);

  device.queue.writeBuffer(buffers.aBuffer, 0, a);
  device.queue.writeBuffer(buffers.bBuffer, 0, b);
  device.queue.writeBuffer(buffers.paramsBuffer, 0, new Uint32Array([length, innerLoops, 0, 0]));

  const t0 = performance.now();
  const encoder = device.createCommandEncoder();

  for (let r = 0; r < rounds; r += 1) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(length / 256));
    pass.end();
  }

  encoder.copyBufferToBuffer(buffers.outBuffer, 0, buffers.readBuffer, 0, length * 4);
  device.queue.submit([encoder.finish()]);

  const out = await readOutput(buffers, length);
  const totalMs = performance.now() - t0;
  const finalChecksum = checksum(out);

  destroyBuffers(buffers);
  return { totalMs, finalChecksum };
}

function summarize(times) {
  const total = times.reduce((acc, v) => acc + v, 0);
  return {
    total,
    avg: total / times.length,
    best: Math.min(...times)
  };
}

function throughput(length, rounds, totalMs) {
  return (length * rounds) / (totalMs / 1000);
}

function renderResult(length, rounds, naiveTimes, reuseTimes, batchedTotal, checksums) {
  const naive = summarize(naiveTimes);
  const reuse = summarize(reuseTimes);
  const batchedAvg = batchedTotal / rounds;

  const speedupReuse = naive.total / reuse.total;
  const speedupBatched = naive.total / batchedTotal;

  resultEl.innerHTML = `
    <table class="result-table">
      <thead>
        <tr>
          <th>Strategy</th>
          <th>Total (ms)</th>
          <th>Avg/Round (ms)</th>
          <th>Best (ms)</th>
          <th>Throughput (elem/s)</th>
          <th>Speedup vs Naive</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Naive（重建 + 每輪 readback）</td>
          <td>${naive.total.toFixed(3)}</td>
          <td>${naive.avg.toFixed(3)}</td>
          <td>${naive.best.toFixed(3)}</td>
          <td>${throughput(length, rounds, naive.total).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
          <td>1.00x</td>
        </tr>
        <tr>
          <td>Reuse（重用資源 + 每輪 readback）</td>
          <td>${reuse.total.toFixed(3)}</td>
          <td>${reuse.avg.toFixed(3)}</td>
          <td>${reuse.best.toFixed(3)}</td>
          <td>${throughput(length, rounds, reuse.total).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
          <td class="good">${speedupReuse.toFixed(2)}x</td>
        </tr>
        <tr>
          <td>Batched（重用資源 + 單次 readback）</td>
          <td>${batchedTotal.toFixed(3)}</td>
          <td>${batchedAvg.toFixed(3)}</td>
          <td>${batchedAvg.toFixed(3)}</td>
          <td>${throughput(length, rounds, batchedTotal).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
          <td class="good">${speedupBatched.toFixed(2)}x</td>
        </tr>
      </tbody>
    </table>
    <p>Naive checksum: ${checksums.naive.toFixed(6)}</p>
    <p>Reuse checksum: ${checksums.reuse.toFixed(6)}</p>
    <p>Batched checksum: ${checksums.batched.toFixed(6)}</p>
  `;
}

async function run() {
  runBtn.disabled = true;
  resultEl.textContent = "執行中...";

  try {
    const length = Number(lengthSelect.value);
    const innerLoops = Number(innerSelect.value);
    const rounds = Number(roundInput.value);
    if (!Number.isInteger(rounds) || rounds < 1) {
      throw new Error("Rounds 必須是 >= 1 的整數。");
    }

    setStatus("初始化 WebGPU...");
    const device = await ensureDevice();
    if (!state.sharedPipeline) {
      state.sharedPipeline = createPipeline(device);
    }

    setStatus(`準備資料（length=${length.toLocaleString()}）...`);
    const a = randomVector(length);
    const b = randomVector(length);

    setStatus("執行 Naive strategy...");
    const naive = await runNaive(device, length, innerLoops, rounds, a, b);

    setStatus("執行 Reuse strategy...");
    const reuse = await runReuse(device, state.sharedPipeline, length, innerLoops, rounds, a, b);

    setStatus("執行 Batched strategy...");
    const batched = await runBatched(device, state.sharedPipeline, length, innerLoops, rounds, a, b);

    renderResult(length, rounds, naive.times, reuse.times, batched.totalMs, {
      naive: naive.finalChecksum,
      reuse: reuse.finalChecksum,
      batched: batched.finalChecksum
    });

    setStatus("完成：可根據結果撰寫優化前後 benchmark 報告。");
  } catch (error) {
    console.error(error);
    setStatus(`失敗：${error.message}`);
    resultEl.textContent = "執行失敗，請檢查錯誤訊息。";
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", run);
```

---

> 下一課：`07-browser-ai-foundations-tfjs-onnx.md`（模型格式、前後處理與推論流程）
