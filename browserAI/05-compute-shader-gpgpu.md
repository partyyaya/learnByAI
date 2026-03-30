# 第五課：Compute Shader 與 GPGPU（1 週）

## 5.1 本課目標

這一課正式進入 GPGPU（General-Purpose GPU）思維：  
不只是「畫圖」，而是把通用數值運算交給 GPU。

本課你會掌握：

- `@compute` shader 的執行模型
- `workgroup` 與 `dispatchWorkgroups`
- 如何把矩陣乘法平行化
- 作業：**GPU 版 matrix multiply，並與 CPU 比速度**

---

## 5.2 為什麼這課是 Browser AI 分水嶺？

從這課開始，你會真正接近 AI 推論核心：

- 線性層、注意力、卷積，本質都可拆成大量乘加
- CPU 主要是流程控制，GPU 負責平行數值計算
- 你將學會從「演算法」映射到「GPU 執行網格」

---

## 5.3 Compute Shader 核心觀念

### 1) 單一 invocation

可視為「一個平行工作單位」。

### 2) workgroup

- 多個 invocation 組成一個小群組
- `@workgroup_size(x, y, z)` 定義每組大小

### 3) dispatch

- 你用 `dispatchWorkgroups(gx, gy, gz)` 啟動多個 workgroup
- 總 invocation 數 = `gx * x`（等）

---

## 5.4 把矩陣乘法映射到 GPU

以 `C = A x B`（`N x N`）為例：

- 每個輸出元素 `C[row, col]` 可獨立計算
- 很適合平行化

GPU 映射策略：

- `global_invocation_id.x -> col`
- `global_invocation_id.y -> row`
- 每個 invocation 計算一個 `C[row, col]`

---

## 5.5 Shader 思路（最小可行版）

```wgsl
let row = gid.y;
let col = gid.x;
if (row >= n || col >= n) return;

var sum = 0.0;
for (k = 0..n-1) {
  sum += A[row*n + k] * B[k*n + col];
}
C[row*n + col] = sum;
```

這是「naive GPU matmul」。  
後續你可以再加 shared memory/tiled 優化（第六課會處理效能優化）。

---

## 5.6 本週作業規格

### 必做

- 完成 CPU 與 GPU 版 matrix multiply
- 支援多個矩陣尺寸（例如 64/128/256）
- 顯示平均耗時、最佳耗時、加速倍率
- 顯示數值誤差（max abs diff）

### 建議加分

- 做 warmup，減少第一次編譯開銷干擾
- 顯示 GFLOPS
- 分析不同 `workgroup_size` 的差異

---

## 5.7 常見錯誤與排查

### 問題一：GPU 結果全 0 或 NaN

- 檢查 index 計算是否正確
- 檢查 buffer usage 與 binding 順序
- 檢查 uniform 的 `n` 是否正確寫入

### 問題二：GPU 比 CPU 慢很多

- 小矩陣時 dispatch 與搬運成本相對更高
- 首次執行包含 shader/pipeline 建立成本
- 可做 warmup 並比較多次平均

### 問題三：`mapAsync` 卡住或失敗

- read buffer 必須有 `MAP_READ`
- 需先 `copyBufferToBuffer` 再 `mapAsync`

---

## 5.8 本章小結

- 你已具備把通用數值運算搬到 GPU 的能力
- 你能用 workgroup/dispatch 思維設計平行任務
- 你已完成 Browser AI 路線最核心的計算入門作業

---

## 5.9 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-05-gpgpu-matmul/
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
    <title>Lesson 05 - GPGPU Matrix Multiply</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 05：GPGPU Matrix Multiply Benchmark</h1>
      <p class="subtitle">比較 CPU 與 WebGPU Compute Shader 在矩陣乘法的差異。</p>

      <section class="panel controls">
        <label>
          Matrix Size (N x N)
          <select id="sizeSelect">
            <option value="64">64</option>
            <option value="128" selected>128</option>
            <option value="192">192</option>
            <option value="256">256</option>
            <option value="320">320</option>
          </select>
        </label>

        <label>
          Repeat
          <input id="repeatInput" type="number" min="1" max="6" value="3" />
        </label>

        <button id="runBtn">Run CPU vs GPU</button>
      </section>

      <section class="panel">
        <h2>Status</h2>
        <pre id="status">等待執行...</pre>
      </section>

      <section class="panel">
        <h2>Result</h2>
        <div id="result">尚未執行。</div>
      </section>

      <section class="panel">
        <h2>Output Preview (Top-left 4x4)</h2>
        <pre id="preview">尚未執行。</pre>
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
  background: #0a0f1d;
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
  background: #161f36;
  border: 1px solid #30426e;
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
  background: #0f1731;
  color: #edf3ff;
  padding: 8px 10px;
}

button {
  cursor: pointer;
  background: #2f72ff;
  border-color: #2f72ff;
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
  border: 1px solid #3a4f86;
  padding: 10px;
  text-align: left;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}

.ok {
  color: #89f1aa;
}
```

### `app.js`

```javascript
const runBtn = document.querySelector("#runBtn");
const sizeSelect = document.querySelector("#sizeSelect");
const repeatInput = document.querySelector("#repeatInput");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const previewEl = document.querySelector("#preview");

const state = {
  device: null,
  pipeline: null
};

function setStatus(text) {
  statusEl.textContent = text;
}

function randomMatrix(n) {
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.random() * 2 - 1;
  }
  return out;
}

function matMulCpuIKJ(a, b, n) {
  const c = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const iOffset = i * n;
    for (let k = 0; k < n; k += 1) {
      const aik = a[iOffset + k];
      const kOffset = k * n;
      for (let j = 0; j < n; j += 1) {
        c[iOffset + j] += aik * b[kOffset + j];
      }
    }
  }
  return c;
}

function maxAbsDiff(x, y) {
  let max = 0;
  for (let i = 0; i < x.length; i += 1) {
    const d = Math.abs(x[i] - y[i]);
    if (d > max) max = d;
  }
  return max;
}

function toGflops(n, ms) {
  const flops = 2 * n * n * n;
  return flops / (ms / 1000) / 1e9;
}

function summarize(times) {
  const avg = times.reduce((acc, v) => acc + v, 0) / times.length;
  const best = Math.min(...times);
  return { avg, best };
}

async function ensureGpuReady() {
  if (state.device && state.pipeline) {
    return { device: state.device, pipeline: state.pipeline };
  }

  if (!("gpu" in navigator)) {
    throw new Error("瀏覽器不支援 WebGPU。");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("找不到可用的 GPU adapter。");
  }
  const device = await adapter.requestDevice();

  const shader = device.createShaderModule({
    code: `
struct Params {
  n: u32
}

@group(0) @binding(0) var<storage, read> inputA: array<f32>;
@group(0) @binding(1) var<storage, read> inputB: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputC: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let col = gid.x;
  let row = gid.y;
  let n = params.n;

  if (row >= n || col >= n) {
    return;
  }

  var sum = 0.0;
  for (var k: u32 = 0u; k < n; k = k + 1u) {
    sum = sum + inputA[row * n + k] * inputB[k * n + col];
  }
  outputC[row * n + col] = sum;
}
`
  });

  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: shader,
      entryPoint: "main"
    }
  });

  state.device = device;
  state.pipeline = pipeline;
  return { device, pipeline };
}

async function matMulGpu(device, pipeline, a, b, n) {
  const bytes = n * n * 4;

  const aBuffer = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const bBuffer = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const cBuffer = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const readBuffer = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const paramsBuffer = device.createBuffer({
    size: 16, // uniform alignment
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  device.queue.writeBuffer(aBuffer, 0, a);
  device.queue.writeBuffer(bBuffer, 0, b);
  device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([n, 0, 0, 0]));

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: aBuffer } },
      { binding: 1, resource: { buffer: bBuffer } },
      { binding: 2, resource: { buffer: cBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } }
    ]
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(n / 16), Math.ceil(n / 16), 1);
  pass.end();

  encoder.copyBufferToBuffer(cBuffer, 0, readBuffer, 0, bytes);

  const t0 = performance.now();
  device.queue.submit([encoder.finish()]);
  await readBuffer.mapAsync(GPUMapMode.READ);
  const elapsedMs = performance.now() - t0;

  const mapped = readBuffer.getMappedRange();
  const out = new Float32Array(mapped.slice(0));
  readBuffer.unmap();

  aBuffer.destroy();
  bBuffer.destroy();
  cBuffer.destroy();
  readBuffer.destroy();
  paramsBuffer.destroy();

  return { output: out, elapsedMs };
}

function previewTopLeft4(matrix, n) {
  const lines = [];
  const limit = Math.min(4, n);
  for (let r = 0; r < limit; r += 1) {
    const row = [];
    for (let c = 0; c < limit; c += 1) {
      row.push(matrix[r * n + c].toFixed(3));
    }
    lines.push(row.join("  "));
  }
  return lines.join("\n");
}

function renderResult({ n, repeat, cpuTimes, gpuTimes, diff, outputPreview }) {
  const cpu = summarize(cpuTimes);
  const gpu = summarize(gpuTimes);
  const speedup = cpu.avg / gpu.avg;

  resultEl.innerHTML = `
    <table class="result-table">
      <thead>
        <tr>
          <th>項目</th>
          <th>CPU</th>
          <th>GPU</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Average (ms)</td>
          <td>${cpu.avg.toFixed(3)}</td>
          <td>${gpu.avg.toFixed(3)}</td>
        </tr>
        <tr>
          <td>Best (ms)</td>
          <td>${cpu.best.toFixed(3)}</td>
          <td>${gpu.best.toFixed(3)}</td>
        </tr>
        <tr>
          <td>GFLOPS (avg)</td>
          <td>${toGflops(n, cpu.avg).toFixed(3)}</td>
          <td>${toGflops(n, gpu.avg).toFixed(3)}</td>
        </tr>
        <tr>
          <td>Speedup (avg)</td>
          <td colspan="2">${speedup.toFixed(2)}x</td>
        </tr>
        <tr>
          <td>Repeat</td>
          <td colspan="2">${repeat}</td>
        </tr>
        <tr>
          <td>Max Abs Diff</td>
          <td colspan="2" class="ok">${diff.toExponential(3)}</td>
        </tr>
      </tbody>
    </table>
    <p>CPU times: ${cpuTimes.map((v) => v.toFixed(2)).join(", ")} ms</p>
    <p>GPU times: ${gpuTimes.map((v) => v.toFixed(2)).join(", ")} ms</p>
  `;

  previewEl.textContent = outputPreview;
}

async function runBenchmark() {
  runBtn.disabled = true;
  resultEl.textContent = "執行中...";
  previewEl.textContent = "執行中...";

  try {
    const n = Number(sizeSelect.value);
    const repeat = Number(repeatInput.value);
    if (!Number.isInteger(repeat) || repeat < 1) {
      throw new Error("Repeat 必須是 >= 1 的整數。");
    }

    setStatus(`初始化 WebGPU 與 pipeline...`);
    const { device, pipeline } = await ensureGpuReady();

    setStatus(`產生測試矩陣（${n} x ${n}）...`);
    const a = randomMatrix(n);
    const b = randomMatrix(n);

    const cpuTimes = [];
    let cpuOutput = null;
    setStatus("執行 CPU benchmark...");
    for (let i = 0; i < repeat; i += 1) {
      const t0 = performance.now();
      const out = matMulCpuIKJ(a, b, n);
      const ms = performance.now() - t0;
      cpuTimes.push(ms);
      if (i === 0) cpuOutput = out;
    }

    // warmup：降低首次 GPU pipeline/driver 開銷干擾
    setStatus("GPU warmup...");
    await matMulGpu(device, pipeline, randomMatrix(16), randomMatrix(16), 16);

    const gpuTimes = [];
    let gpuOutput = null;
    setStatus("執行 GPU benchmark...");
    for (let i = 0; i < repeat; i += 1) {
      const { output, elapsedMs } = await matMulGpu(device, pipeline, a, b, n);
      gpuTimes.push(elapsedMs);
      if (i === 0) gpuOutput = output;
    }

    const diff = maxAbsDiff(cpuOutput, gpuOutput);
    renderResult({
      n,
      repeat,
      cpuTimes,
      gpuTimes,
      diff,
      outputPreview: previewTopLeft4(gpuOutput, n)
    });

    setStatus("完成：已得到 CPU/GPU 速度比較與誤差驗證。");
  } catch (error) {
    console.error(error);
    setStatus(`失敗：${error.message}`);
    resultEl.textContent = "執行失敗，請檢查錯誤訊息。";
    previewEl.textContent = "無結果。";
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", runBenchmark);
```

---

> 下一課：`06-webgpu-performance-optimization.md`（GPU timing、batching、記憶體拷貝成本與最佳化報告）
