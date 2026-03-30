# 第三課：WGSL Shader 基礎（1 週）

## 3.1 本課目標

這一課你要真正看懂 shader 在做什麼，而不是只會複製範例。  
你會掌握 Browser AI 與 WebGPU 圖形/計算共通的重要基礎：資料如何在 GPU stage 之間流動。

本課重點：

- `vertex` / `fragment` 的責任切分
- `@location`、`@builtin` 的資料傳遞
- 座標系（Clip Space / NDC / UV）轉換觀念
- 作業：**做出可調顏色與形狀的 shader demo**

---

## 3.2 為什麼 Browser AI 也要學 Shader？

看起來 AI 跟 shader 無關，但其實底層思維高度相通：

- 都是「大量平行運算」
- 都需要精準的 memory layout 與資料對齊
- 都要理解 GPU 端流程（建立資源 → 綁定 → 執行 → 回傳）

學會 shader，可以讓你後面學 compute shader、模型前處理/後處理加速時更快上手。

---

## 3.3 WGSL 是什麼？

WGSL（WebGPU Shading Language）是 WebGPU 的官方 shader 語言。  
你可以把它當成 GLSL 的現代化版本，語法更嚴格、型別更明確。

### 常見屬性標記

- `@vertex`：頂點著色器入口
- `@fragment`：片段著色器入口
- `@builtin(position)`：內建輸出/輸入（例如裁切座標）
- `@builtin(vertex_index)`：目前是第幾個頂點
- `@location(n)`：stage 之間的自訂資料通道

---

## 3.4 Vertex 與 Fragment 在做什麼？

### Vertex Shader

- 決定頂點最終位置（`vec4f`）
- 可把資料傳給 Fragment（例如 UV、法線、顏色）

### Fragment Shader

- 決定每個像素顏色
- 常做貼圖取樣、顏色混合、光照、後處理

你可以理解成：

- Vertex：決定「畫在哪」
- Fragment：決定「長怎樣」

---

## 3.5 座標系一定要懂（最常卡這裡）

### 1) Clip Space / NDC（-1 到 1）

- `x`: -1（左）到 +1（右）
- `y`: -1（下）到 +1（上）
- 螢幕中央是 `(0, 0)`

### 2) UV（0 到 1）

- 常在 fragment 用於貼圖/程序紋理
- 左下約 `(0,0)`，右上約 `(1,1)`（具體方向依你的定義）

### 3) 常見轉換

```wgsl
let uv = in.uv;                // 0..1
let p = uv * 2.0 - vec2f(1.0); // -1..1
```

---

## 3.6 Stage 間資料傳遞範例

```wgsl
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
}

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VSOut {
  // 省略...
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv;
  return vec4f(uv, 0.0, 1.0);
}
```

重點：`@location(0)` 在 vertex 與 fragment 必須對得上。

---

## 3.7 Uniform 與資料對齊（你後面一定會用到）

雖然本課重點是 shader 觀念，但請先記住：

- `vec4f` 對齊自然且穩定
- uniform buffer 常用「4 個 float 一組」設計
- 不對齊常導致值讀錯、畫面怪異

本課範例會用：

- `color: vec4f`
- `params0: vec4f`（shape、size、edge、time）
- `params1: vec4f`（angle、aspect、bgEnabled、padding）

---

## 3.8 本週作業規格

### 必做

- 支援至少 3 種形狀（circle / box / triangle）
- 可調整顏色
- 可調整大小或邊緣平滑
- 有基本動畫（旋轉或時間變化）

### 驗收

- 控制面板改值後，畫面可即時反映
- shader 不報錯，畫面穩定更新
- 你可以解釋每個 uniform 的用途

---

## 3.9 常見錯誤與排查

### 問題一：畫面全黑

- 檢查 vertex 是否輸出正確 `@builtin(position)`
- 檢查 fragment 是否回傳合法色彩（0~1）
- 檢查 pipeline format 是否與 canvas format 一致

### 問題二：shape 變形

- 忘記處理畫布長寬比（aspect）
- 在 `x` 軸乘上 `aspect` 做修正

### 問題三：UI 有改但畫面不變

- uniform 寫入後沒重新 render
- 或動畫 loop 中沒有持續 `writeBuffer`

---

## 3.10 本章小結

- 你已掌握 WGSL 的最基本語法與資料流
- 你能從 `vertex -> fragment` 追蹤資料
- 你已完成可互動 shader demo，為下一課資源管理打底

---

## 3.11 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-03-wgsl-shader-playground/
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
    <title>Lesson 03 - WGSL Shader Playground</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 03：WGSL Shader Playground</h1>
      <p class="subtitle">可調顏色、形狀、邊緣與旋轉速度的 shader demo</p>

      <section class="panel controls">
        <label>
          Shape
          <select id="shapeSelect">
            <option value="0">Circle</option>
            <option value="1">Box</option>
            <option value="2">Triangle</option>
          </select>
        </label>

        <label>
          Color
          <input id="colorInput" type="color" value="#4f8bff" />
        </label>

        <label>
          Size
          <input id="sizeInput" type="range" min="0.12" max="0.72" step="0.01" value="0.36" />
        </label>

        <label>
          Edge Smooth
          <input id="edgeInput" type="range" min="0.001" max="0.08" step="0.001" value="0.02" />
        </label>

        <label>
          Rotate Speed (rad/s)
          <input id="speedInput" type="range" min="-4" max="4" step="0.1" value="1.0" />
        </label>

        <label class="inline">
          <input id="bgToggle" type="checkbox" checked />
          Gradient BG
        </label>

        <button id="pauseBtn">Pause</button>
      </section>

      <section class="panel canvas-panel">
        <canvas id="gpuCanvas" width="920" height="520"></canvas>
      </section>

      <section class="panel">
        <h2>Status</h2>
        <pre id="status">初始化中...</pre>
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
  background: #0b0f1d;
  color: #edf2ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.container {
  max-width: 1000px;
  margin: 26px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #b7c3e9;
}

.panel {
  margin-top: 14px;
  background: #151a31;
  border: 1px solid #2d3963;
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

.inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

select,
input,
button {
  border: 1px solid #435792;
  border-radius: 8px;
  background: #0f1730;
  color: #edf2ff;
  padding: 8px 10px;
}

button {
  cursor: pointer;
  background: #2d6eff;
  border-color: #2d6eff;
}

.canvas-panel {
  padding: 8px;
}

#gpuCanvas {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 8px;
  border: 1px solid #34457a;
  background: #090d18;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
const canvas = document.querySelector("#gpuCanvas");
const shapeSelect = document.querySelector("#shapeSelect");
const colorInput = document.querySelector("#colorInput");
const sizeInput = document.querySelector("#sizeInput");
const edgeInput = document.querySelector("#edgeInput");
const speedInput = document.querySelector("#speedInput");
const bgToggle = document.querySelector("#bgToggle");
const pauseBtn = document.querySelector("#pauseBtn");
const statusEl = document.querySelector("#status");

let paused = false;
let rotateSpeed = Number(speedInput.value);
let angle = 0;
let lastTs = performance.now();

function setStatus(text) {
  statusEl.textContent = text;
}

function hexToRgb01(hex) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return [r / 255, g / 255, b / 255];
}

function resizeCanvasToDisplaySize(target) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.floor(target.clientWidth * dpr);
  const height = Math.floor(target.clientWidth * 0.56 * dpr);
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
}

async function start() {
  if (!("gpu" in navigator)) {
    setStatus("瀏覽器不支援 WebGPU，請使用最新版 Chrome/Edge。");
    return;
  }

  const context = canvas.getContext("webgpu");
  if (!context) {
    setStatus("無法取得 webgpu context。");
    return;
  }

  setStatus("初始化 adapter/device...");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    setStatus("找不到可用 GPU adapter。");
    return;
  }
  const device = await adapter.requestDevice();

  const format = navigator.gpu.getPreferredCanvasFormat();
  resizeCanvasToDisplaySize(canvas);
  context.configure({
    device,
    format,
    alphaMode: "opaque"
  });

  const shader = device.createShaderModule({
    code: `
struct Uniforms {
  color: vec4f,
  params0: vec4f,  // x:shape, y:size, z:edge, w:time
  params1: vec4f   // x:angle, y:aspect, z:bgEnabled, w:padding
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
}

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VSOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0)
  );

  let p = positions[vid];
  var out: VSOut;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = p * 0.5 + vec2f(0.5, 0.5);
  return out;
}

fn sdfCircle(p: vec2f, r: f32) -> f32 {
  return length(p) - r;
}

fn sdfBox(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sdfTriangle(pIn: vec2f, r: f32) -> f32 {
  let k = sqrt(3.0);
  var p = pIn;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) {
    p = vec2f(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  }
  p.x = p.x - clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  var p = in.uv * 2.0 - vec2f(1.0, 1.0);
  p.x = p.x * uniforms.params1.y;

  let c = cos(uniforms.params1.x);
  let s = sin(uniforms.params1.x);
  p = vec2f(p.x * c - p.y * s, p.x * s + p.y * c);

  let shapeType = uniforms.params0.x;
  let size = uniforms.params0.y;
  let edge = uniforms.params0.z;
  let time = uniforms.params0.w;

  var dist = 0.0;
  if (shapeType < 0.5) {
    dist = sdfCircle(p, size);
  } else if (shapeType < 1.5) {
    dist = sdfBox(p, vec2f(size, size));
  } else {
    dist = sdfTriangle(p, size * 1.1);
  }

  let mask = 1.0 - smoothstep(-edge, edge, dist);
  let pulse = 0.65 + 0.35 * sin(12.0 * (p.x + p.y) + time * 2.0);
  let shapeColor = uniforms.color.rgb * pulse;

  let bg = mix(
    vec3f(0.06, 0.08, 0.14),
    vec3f(0.15, 0.09, 0.30),
    in.uv.y
  );
  let bgEnabled = uniforms.params1.z;
  let baseBg = mix(vec3f(0.05, 0.06, 0.09), bg, step(0.5, bgEnabled));

  let color = mix(baseBg, shapeColor, mask);
  return vec4f(color, 1.0);
}
`
  });

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shader,
      entryPoint: "vsMain"
    },
    fragment: {
      module: shader,
      entryPoint: "fsMain",
      targets: [{ format }]
    },
    primitive: { topology: "triangle-list" }
  });

  // color(vec4) + params0(vec4) + params1(vec4) = 12 floats = 48 bytes
  const uniformData = new Float32Array(12);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  function writeUniforms(nowMs) {
    const [r, g, b] = hexToRgb01(colorInput.value);

    uniformData[0] = r;
    uniformData[1] = g;
    uniformData[2] = b;
    uniformData[3] = 1;

    uniformData[4] = Number(shapeSelect.value);
    uniformData[5] = Number(sizeInput.value);
    uniformData[6] = Number(edgeInput.value);
    uniformData[7] = nowMs / 1000;

    uniformData[8] = angle;
    uniformData[9] = canvas.width / canvas.height;
    uniformData[10] = bgToggle.checked ? 1 : 0;
    uniformData[11] = 0;

    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  }

  function render(nowMs) {
    const dt = (nowMs - lastTs) / 1000;
    lastTs = nowMs;
    if (!paused) {
      angle += rotateSpeed * dt;
    }

    writeUniforms(nowMs);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, 1, 0, 0);
    pass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(render);
  }

  speedInput.addEventListener("input", () => {
    rotateSpeed = Number(speedInput.value);
    setStatus(`旋轉速度：${rotateSpeed.toFixed(2)} rad/s`);
  });

  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    setStatus(paused ? "動畫已暫停。" : "動畫已恢復。");
  });

  window.addEventListener("resize", () => {
    resizeCanvasToDisplaySize(canvas);
    context.configure({ device, format, alphaMode: "opaque" });
  });

  setStatus("已就緒：可切換 shape、顏色、大小、邊緣與旋轉速度。");
  requestAnimationFrame(render);
}

start().catch((error) => {
  console.error(error);
  setStatus(`初始化失敗：${error.message}`);
});
```

---

> 下一課：`04-buffer-texture-memory.md`（Buffer / Texture / Memory 管理，含圖片濾鏡）
