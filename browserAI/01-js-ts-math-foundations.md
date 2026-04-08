# 第一課：先修 JS/TS 與數學基礎（1 週）

## 1.1 本課目標

這一課是整條 Browser AI 路線的地基。  
如果這裡沒打穩，後面學 WebGPU、ONNX、LLM 很容易只會「呼叫 API」，但不知道效能瓶頸在哪裡。

本課你要掌握：

- JavaScript 記憶體視角：`ArrayBuffer` / `TypedArray`
- 矩陣乘法核心觀念（行列運算、時間複雜度）
- 向量化與快取友善迴圈順序的直覺
- 完成作業：**CPU 版 Matrix Multiply + Benchmark**

---

## 1.2 為什麼 Browser AI 要先學這些？

在瀏覽器中跑 AI，本質上是兩件事：**資料搬運** + **張量計算**。  
實務上，很多效能問題不是「公式不會」，而是資料在記憶體中的放法與讀法不夠友善。

### 推論流程與本課能力對照

| 推論步驟 | 典型操作 | 常見效能瓶頸 | 你現在要先會的能力 |
|---|---|---|---|
| 前處理 | resize、normalize、型別轉換（`Uint8 -> Float32`） | 重複 copy、建立太多臨時陣列 | `ArrayBuffer` / `TypedArray`、連續記憶體觀念 |
| 張量轉換 | NHWC/NCHW 轉換、flatten、batch 組裝 | stride 不連續造成 cache miss | row-major 索引、資料布局直覺 |
| 線性層（GEMM） | `Y = XW + b` | 同樣 `O(n^3)` 但迴圈順序差異可慢數倍 | 迴圈重排、區塊化（blocking） |
| 卷積（Conv） | 滑動視窗 + 乘加累積 | 記憶體頻寬吃緊、資料重用不足 | 訪問局部性、快取友善思維 |

### 為什麼「同樣複雜度」速度會差很多？

以矩陣乘法來看，`i-j-k` 與 `i-k-j` 理論上都接近 `O(n^3)`，但 `i-k-j` 常更快，因為：

- 讀取模式通常更連續，cache 命中率較高
- 中間結果較容易留在快取中重複利用
- 減少不必要的記憶體來回搬運

所以第一課不只是「數學補課」，而是你後續做 WebGPU / ONNX / LLM 效能優化時的核心工具。

> 延伸深讀：[`01a-inference-pipeline-memory-compute-deep-dive.md`](./01a-inference-pipeline-memory-compute-deep-dive.md)

---

## 1.3 `ArrayBuffer` 與 `TypedArray`（重點）

### `ArrayBuffer`

- 代表一塊「原始連續記憶體」
- 本身沒有型別，只是 bytes 容器

### `TypedArray`

- 是 `ArrayBuffer` 的「型別化視圖」
- 常見型別：`Float32Array`、`Int32Array`、`Uint8Array`

```js
const buffer = new ArrayBuffer(4 * 4); // 16 bytes
const f32 = new Float32Array(buffer);  // 4 個 float32
f32[0] = 1.5;
```

在 AI / WebGPU 情境，`Float32Array` 幾乎是最常見的輸入格式。

---

## 1.4 矩陣乘法最小必要知識

給定：

- `A` 為 `m x k`
- `B` 為 `k x n`

結果：

- `C = A x B` 為 `m x n`
- `C[i, j] = Σ(A[i, t] * B[t, j])`

### 時間複雜度

一般實作約為 `O(n^3)`（方陣情況下）。

### 記憶體表示（row-major）

把 `n x n` 矩陣平鋪在一維陣列：

- 元素 `(row, col)` 的 index = `row * n + col`

```js
function idx(row, col, n) {
  return row * n + col;
}
```

---

## 1.5 向量化概念（先建立直覺）

這裡的「向量化」先不等於 SIMD 指令，而是更高層直覺：

1. **資料連續存放**（TypedArray）
2. **避免重複讀取同一塊慢記憶體**
3. **用更 cache-friendly 的迴圈順序**

例如矩陣乘法，`i-k-j` 常比 `i-j-k` 快，因為它在記憶體訪問上通常更連續。

---

## 1.6 本週作業規格（你要交什麼）

### 必做

- 用 JS 實作 CPU 版 matrix multiply
- 輸入 `N`，可測至少 `N=64/128/256`
- 顯示執行時間（ms）
- 輸出結果矩陣的一小部分（例如左上 4x4）

### 建議加分

- 比較不同演算法（`i-j-k` vs `i-k-j` vs blocked）
- 顯示 GFLOPS
- 加入正確性驗證（小尺寸和 baseline 比對）

---

## 1.7 實作步驟建議

1. 先寫 `createRandomMatrix(n)`
2. 先完成 baseline：`matMulIJK()`
3. 再做 cache-friendly：`matMulIKJ()`
4. 加入 blocked 版本：`matMulBlocked()`
5. 補 benchmark UI（矩陣大小 / 重複次數 / 演算法選擇）

---

## 1.8 常見錯誤

### 錯誤一：index 算錯導致結果亂掉

- 先固定 `n=2` 或 `n=3` 手算驗證
- 用 `idx(row, col, n)` 統一索引公式

### 錯誤二：用一般 `Array` 導致效能波動很大

- 盡量用 `Float32Array`

### 錯誤三：每次 benchmark 都重新生成太多非必要資料

- 測試前先生成 `A`、`B`
- benchmark 只比較乘法時間

---

## 1.9 驗收標準

- 能成功計算出矩陣乘法結果
- 介面可調整矩陣大小
- 可以輸出耗時並重複測試
- 結果數值合理，無 `NaN` 或整片 0

---

## 1.10 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-01-cpu-matmul/
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
    <title>Lesson 01 - CPU Matrix Multiply</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 01：CPU Matrix Multiply Benchmark</h1>
      <p class="subtitle">先修：JS/TS 記憶體模型、矩陣乘法與向量化思維</p>

      <section class="panel controls">
        <label>
          Matrix Size (N x N)
          <select id="sizeSelect">
            <option value="64">64</option>
            <option value="128" selected>128</option>
            <option value="256">256</option>
            <option value="384">384</option>
          </select>
        </label>

        <label>
          Algorithm
          <select id="algoSelect">
            <option value="ijk">naive i-j-k</option>
            <option value="ikj" selected>cache-friendly i-k-j</option>
            <option value="blocked">blocked (tile=32)</option>
          </select>
        </label>

        <label>
          Repeat
          <input id="repeatInput" type="number" min="1" max="10" value="3" />
        </label>

        <button id="runBtn">Run Benchmark</button>
      </section>

      <section class="panel">
        <h2>Status</h2>
        <pre id="status">等待執行...</pre>
      </section>

      <section class="panel">
        <h2>Metrics</h2>
        <div id="metrics">尚未執行。</div>
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
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  background: #0f1220;
  color: #ecf0ff;
}

.container {
  max-width: 980px;
  margin: 28px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #b8c3e0;
}

.panel {
  margin-top: 14px;
  background: #1a2137;
  border: 1px solid #2c395f;
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
  border: 1px solid #41558a;
  border-radius: 8px;
  background: #0f162a;
  color: #ecf0ff;
  padding: 9px 11px;
}

button {
  cursor: pointer;
  background: #3d7bff;
  border-color: #3d7bff;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}

.ok {
  color: #7ff3a6;
}
```

### `app.js`

```javascript
const runBtn = document.querySelector("#runBtn");
const sizeSelect = document.querySelector("#sizeSelect");
const algoSelect = document.querySelector("#algoSelect");
const repeatInput = document.querySelector("#repeatInput");
const statusEl = document.querySelector("#status");
const metricsEl = document.querySelector("#metrics");
const previewEl = document.querySelector("#preview");

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

function matMulIJK(a, b, n) {
  const c = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const iOffset = i * n;
    for (let j = 0; j < n; j += 1) {
      let sum = 0;
      for (let k = 0; k < n; k += 1) {
        sum += a[iOffset + k] * b[k * n + j];
      }
      c[iOffset + j] = sum;
    }
  }
  return c;
}

function matMulIKJ(a, b, n) {
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

function matMulBlocked(a, b, n, blockSize = 32) {
  const c = new Float32Array(n * n);
  for (let ii = 0; ii < n; ii += blockSize) {
    for (let kk = 0; kk < n; kk += blockSize) {
      for (let jj = 0; jj < n; jj += blockSize) {
        const iMax = Math.min(ii + blockSize, n);
        const kMax = Math.min(kk + blockSize, n);
        const jMax = Math.min(jj + blockSize, n);

        for (let i = ii; i < iMax; i += 1) {
          const iOffset = i * n;
          for (let k = kk; k < kMax; k += 1) {
            const aik = a[iOffset + k];
            const kOffset = k * n;
            for (let j = jj; j < jMax; j += 1) {
              c[iOffset + j] += aik * b[kOffset + j];
            }
          }
        }
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

function benchmark(fn, repeat) {
  // warmup
  fn();
  const times = [];
  let output = null;
  for (let i = 0; i < repeat; i += 1) {
    const t0 = performance.now();
    output = fn();
    times.push(performance.now() - t0);
  }
  const avgMs = times.reduce((acc, v) => acc + v, 0) / times.length;
  const minMs = Math.min(...times);
  return { output, avgMs, minMs, times };
}

function formatPreview(matrix, n, previewSize = 4) {
  const lines = [];
  const rMax = Math.min(previewSize, n);
  const cMax = Math.min(previewSize, n);
  for (let r = 0; r < rMax; r += 1) {
    const row = [];
    for (let c = 0; c < cMax; c += 1) {
      row.push(matrix[r * n + c].toFixed(3));
    }
    lines.push(row.join("  "));
  }
  return lines.join("\n");
}

function toGflops(n, ms) {
  const flops = 2 * n * n * n;
  return flops / (ms / 1000) / 1e9;
}

async function run() {
  runBtn.disabled = true;
  metricsEl.textContent = "計算中...";

  try {
    const n = Number(sizeSelect.value);
    const repeat = Number(repeatInput.value);
    const algo = algoSelect.value;

    if (!Number.isInteger(repeat) || repeat < 1) {
      throw new Error("Repeat 必須是 >= 1 的整數。");
    }

    setStatus(`生成隨機矩陣 A/B（${n}x${n}）...`);
    const a = randomMatrix(n);
    const b = randomMatrix(n);

    let multiply = null;
    if (algo === "ijk") multiply = () => matMulIJK(a, b, n);
    else if (algo === "ikj") multiply = () => matMulIKJ(a, b, n);
    else multiply = () => matMulBlocked(a, b, n, 32);

    setStatus(`執行 ${algo} benchmark，repeat=${repeat} ...`);
    const result = benchmark(multiply, repeat);

    // 小尺寸時做 baseline 正確性比對
    let verifyText = "N > 128，略過 baseline 驗證（避免驗證成本過高）。";
    if (n <= 128 && algo !== "ijk") {
      setStatus("執行 baseline 驗證（naive i-j-k）...");
      const base = matMulIJK(a, b, n);
      const diff = maxAbsDiff(base, result.output);
      verifyText = `maxAbsDiff vs naive = ${diff.toExponential(3)}`;
    }

    const avgGflops = toGflops(n, result.avgMs);
    const minGflops = toGflops(n, result.minMs);

    metricsEl.innerHTML = `
      <p><strong>Algorithm:</strong> ${algo}</p>
      <p><strong>Average:</strong> ${result.avgMs.toFixed(3)} ms (${avgGflops.toFixed(3)} GFLOPS)</p>
      <p><strong>Best:</strong> ${result.minMs.toFixed(3)} ms (${minGflops.toFixed(3)} GFLOPS)</p>
      <p class="ok"><strong>Verify:</strong> ${verifyText}</p>
      <p><strong>Each run:</strong> ${result.times.map((v) => v.toFixed(2)).join(", ")} ms</p>
    `;

    previewEl.textContent = formatPreview(result.output, n, 4);
    setStatus("完成。你已完成 CPU 版 matrix multiply 作業。");
  } catch (error) {
    console.error(error);
    setStatus(`失敗：${error.message}`);
    metricsEl.textContent = "請修正錯誤後重試。";
    previewEl.textContent = "無結果。";
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", run);
```

---

> 下一課：[第二課：WebGPU 入門與渲染管線](./02-webgpu-rendering-pipeline.md)
