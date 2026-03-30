# 第二課：WebGPU 入門與渲染管線（1 週）

## 2.1 本課目標

這一課你要把 WebGPU「真的跑起來」，而不只是看概念。

你會完成：

- 建立 WebGPU 初始化流程（adapter / device）
- 建立 render pipeline（shader + primitive）
- 用 command encoder 提交繪圖命令
- 完成作業：**Hello Triangle + 基本互動（顏色 + 旋轉速度）**

---

## 2.2 渲染管線是什麼？

圖形渲染可以想成一條工廠流水線：

```text
頂點資料 / vertex_index
   ↓
Vertex Shader（決定每個頂點的位置）
   ↓
Rasterization（把三角形離散成像素）
   ↓
Fragment Shader（決定每個像素顏色）
   ↓
Render Target（Canvas）
```

在本課，頂點資料直接寫在 shader 內（用 `vertex_index` 選三個點），先把流程跑通。

---

## 2.3 四個一定要懂的 WebGPU 物件

### 1) `GPUAdapter`

- 代表瀏覽器找到的可用 GPU 能力
- 透過 `navigator.gpu.requestAdapter()` 取得

### 2) `GPUDevice`

- 真正用來建 buffer / shader / pipeline 的裝置
- `adapter.requestDevice()` 取得

### 3) `GPURenderPipeline`

- 定義 Vertex/Fragment Shader、輸出格式、primitive 拓樸
- 是「如何畫圖」的規格

### 4) `GPUCommandEncoder`

- 把你要 GPU 執行的工作「錄製成命令」
- 最後 `device.queue.submit()` 一次送出

---

## 2.4 課前準備

- 瀏覽器：Chrome / Edge 最新版
- 使用 `localhost` 或 HTTPS（避免安全限制）

```bash
python3 -m http.server 5173
# 打開 http://localhost:5173
```

---

## 2.5 Hello Triangle 的最小流程

1. 取得 `canvas.getContext("webgpu")`
2. 取 `adapter`、`device`
3. `context.configure({ device, format })`
4. 建立 shader module（WGSL）
5. 建立 render pipeline
6. 開始 render pass，`draw(3)` 畫三角形
7. 提交命令

---

## 2.6 基本互動怎麼做？

本課互動需求：

- 用 `<input type="color">` 改三角形顏色
- 用 `<input type="range">` 改旋轉速度

技術作法：

- 在 GPU 端用 `uniform buffer` 存顏色與角度
- 每一幀把最新 UI 值寫進 uniform
- Vertex Shader 用角度做 2D 旋轉

---

## 2.7 常見錯誤與排查

### 問題一：`navigator.gpu` 是 `undefined`

- 瀏覽器版本或環境不支援
- 非安全上下文（不是 `localhost/https`）

### 問題二：畫面全黑

- 忘記 `context.configure`
- pipeline 的 `format` 和 canvas format 不一致
- shader 位置超出裁切空間（NDC）

### 問題三：互動有反應但畫面不更新

- 沒有持續呼叫 `requestAnimationFrame`
- 或有更新 uniform 但沒有提交新的 render command

---

## 2.8 本章小結

- 你已掌握 WebGPU 渲染最核心流程
- 你已能把 UI 控制串進 shader 參數
- 你完成了 Browser AI 路線中很關鍵的 GPU 基礎能力

---

## 2.9 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-02-webgpu-triangle/
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
    <title>Lesson 02 - WebGPU Hello Triangle</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 02：WebGPU Hello Triangle + 互動</h1>
      <p class="subtitle">控制顏色與旋轉速度，理解 render pipeline 與 command encoder。</p>

      <section class="panel controls">
        <label>
          Triangle Color
          <input id="colorInput" type="color" value="#2d7eff" />
        </label>

        <label>
          Rotation Speed (rad/s)
          <input id="speedInput" type="range" min="-4" max="4" step="0.1" value="1.2" />
        </label>

        <button id="toggleBtn">Pause</button>
      </section>

      <section class="panel canvas-panel">
        <canvas id="gpuCanvas" width="900" height="520"></canvas>
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
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  background: #0b1020;
  color: #e9eefc;
}

.container {
  max-width: 980px;
  margin: 26px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #b9c5e7;
}

.panel {
  margin-top: 14px;
  background: #151d33;
  border: 1px solid #2c3a61;
  border-radius: 10px;
  padding: 14px;
}

.controls {
  display: flex;
  gap: 14px;
  align-items: end;
  flex-wrap: wrap;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}

button,
input[type="range"],
input[type="color"] {
  border: 1px solid #3f558e;
  border-radius: 8px;
  background: #0e162b;
  color: #e9eefc;
  padding: 8px 10px;
}

button {
  cursor: pointer;
  background: #2d6dff;
  border-color: #2d6dff;
}

.canvas-panel {
  padding: 8px;
}

#gpuCanvas {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 8px;
  border: 1px solid #33446f;
  background: #0a0f1e;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
const canvas = document.querySelector("#gpuCanvas");
const colorInput = document.querySelector("#colorInput");
const speedInput = document.querySelector("#speedInput");
const toggleBtn = document.querySelector("#toggleBtn");
const statusEl = document.querySelector("#status");

let paused = false;
let rotationSpeed = Number(speedInput.value);
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
  const height = Math.floor((target.clientWidth * 0.58) * dpr);
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
}

async function main() {
  if (!("gpu" in navigator)) {
    setStatus("瀏覽器不支援 WebGPU，請使用最新版 Chrome/Edge。");
    return;
  }

  const context = canvas.getContext("webgpu");
  if (!context) {
    setStatus("無法取得 webgpu canvas context。");
    return;
  }

  setStatus("請求 adapter/device...");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    setStatus("找不到可用的 GPU adapter。");
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
  angle: f32,
  _pad0: vec3f
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VSOut {
  @builtin(position) position: vec4f
}

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VSOut {
  var positions = array<vec2f, 3>(
    vec2f(0.0, 0.62),
    vec2f(-0.62, -0.62),
    vec2f(0.62, -0.62)
  );

  let p = positions[vid];
  let c = cos(uniforms.angle);
  let s = sin(uniforms.angle);

  let rotated = vec2f(
    p.x * c - p.y * s,
    p.x * s + p.y * c
  );

  var out: VSOut;
  out.position = vec4f(rotated, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain() -> @location(0) vec4f {
  return uniforms.color;
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
    primitive: {
      topology: "triangle-list"
    }
  });

  // color(vec4) + angle(f32) + padding(3*f32) => 8 floats = 32 bytes
  const uniformData = new Float32Array(8);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  colorInput.addEventListener("input", () => {
    setStatus(`顏色更新：${colorInput.value}`);
  });

  speedInput.addEventListener("input", () => {
    rotationSpeed = Number(speedInput.value);
    setStatus(`旋轉速度更新：${rotationSpeed.toFixed(2)} rad/s`);
  });

  toggleBtn.addEventListener("click", () => {
    paused = !paused;
    toggleBtn.textContent = paused ? "Resume" : "Pause";
    setStatus(paused ? "已暫停動畫。" : "已恢復動畫。");
  });

  window.addEventListener("resize", () => {
    resizeCanvasToDisplaySize(canvas);
    context.configure({ device, format, alphaMode: "opaque" });
  });

  setStatus("初始化完成，開始渲染。");

  function frame(now) {
    const dt = (now - lastTs) / 1000;
    lastTs = now;

    if (!paused) {
      angle += rotationSpeed * dt;
    }

    const [r, g, b] = hexToRgb01(colorInput.value);
    uniformData[0] = r;
    uniformData[1] = g;
    uniformData[2] = b;
    uniformData[3] = 1;
    uniformData[4] = angle;
    uniformData[5] = 0;
    uniformData[6] = 0;
    uniformData[7] = 0;

    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.06, g: 0.08, b: 0.14, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
  setStatus(`初始化失敗：${error.message}`);
});
```

---

> 下一課：`03-wgsl-shader-basics.md`（預計涵蓋 vertex/fragment 資料傳遞與可調 shape shader demo）
