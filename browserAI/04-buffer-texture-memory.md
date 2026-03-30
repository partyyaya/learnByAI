# 第四課：Buffer / Texture / Memory 管理（1 週）

## 4.1 本課目標

前一課你已經能寫 shader；這一課要處理更貼近實務的資源管理問題。  
在 Browser AI 或影像應用中，真正耗時的常常不是「算」，而是「資料搬運」與「記憶體壽命」。

本課重點：

- `uniform buffer` 與 `storage buffer` 分工
- `texture upload`（把圖片從 CPU 搬到 GPU）
- 資源生命週期（建立、重用、釋放）
- 作業：**圖片濾鏡（灰階 / 模糊）**

---

## 4.2 為什麼這課很重要？

在 Browser AI 的實際流程中：

1. 你先拿到影像（camera、upload、video frame）
2. 把資料上傳到 GPU
3. 做前處理（resize、normalize、filter）
4. 才進到模型推論

如果第 2~3 步處理不好，整個應用即使模型很快，體感仍然慢。

---

## 4.3 三種常見 GPU 資源

### `GPUBuffer`

- 放線性資料（參數、向量、矩陣、索引）
- 適合 uniforms、weights、kernel 係數

### `GPUTexture`

- 放 2D/3D 圖像資料
- 適合影像處理、渲染輸入/輸出

### `GPUSampler`

- 定義 texture 取樣方式（線性/最近點、repeat/clamp）
- 常和 texture 搭配使用

---

## 4.4 `uniform` vs `storage` 怎麼選？

### Uniform Buffer

- 小而常改的參數（mode、強度、時間、尺寸）
- 在 shader 中通常唯讀
- 對齊需求高，但讀取快、使用普遍

### Storage Buffer

- 中大型資料（可變長或大量係數）
- 可讀/可寫（視宣告）
- 本課用它存 3x3 卷積 kernel，示範 texture 濾鏡

---

## 4.5 Texture Upload 核心流程

1. 使用者選擇圖片（`<input type="file">`）
2. `createImageBitmap(file)` 轉成可上傳格式
3. 建立 `GPUTexture`
4. 用 `queue.copyExternalImageToTexture()` 上傳
5. 在 fragment shader 取樣並輸出到 canvas

---

## 4.6 本週作業規格

### 必做

- 可上傳圖片
- 可切換三種模式：原圖 / 灰階 / 模糊
- 顯示目前模式與執行狀態

### 建議加分

- 模糊強度可調
- 可切換不同 kernel（box / gaussian）
- 正確釋放舊 texture，避免記憶體持續上升

---

## 4.7 記憶體管理要點

- 當新圖片上傳時，舊的 `GPUTexture` 要 `destroy()`
- 不要每一幀都重新建 pipeline/buffer（盡量重用）
- 圖片上傳後若不再使用 bitmap，可呼叫 `bitmap.close()`（若可用）

---

## 4.8 常見錯誤與排查

### 問題一：圖片有上傳但畫面空白

- 檢查 `copyExternalImageToTexture` 的尺寸是否正確
- 檢查 bindGroup 是否用到最新 texture view

### 問題二：模糊效果怪異

- 檢查 `texelSize = 1/width, 1/height`
- 檢查 kernel 權重是否有正規化（總和接近 1）

### 問題三：切換圖片後越來越慢

- 檢查是否釋放舊 texture
- 檢查是否不必要地重建太多 GPU 資源

---

## 4.9 本章小結

- 你已掌握 WebGPU 影像流程中的資源管理關鍵
- 你能把圖片從 CPU 上傳到 GPU 並套用 shader 濾鏡
- 你完成一個可用的影像前處理工具，能直接接到下一課 Compute

---

## 4.10 本課實作成品代碼（完整）

### 檔案結構

```text
lesson-04-image-filter-lab/
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
    <title>Lesson 04 - Buffer Texture Memory Lab</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Lesson 04：Image Filter Lab（WebGPU）</h1>
      <p class="subtitle">示範 texture upload、uniform/storage buffer、記憶體管理。</p>

      <section class="panel controls">
        <label>
          Upload Image
          <input id="fileInput" type="file" accept="image/*" />
        </label>

        <label>
          Filter
          <select id="modeSelect">
            <option value="0">Original</option>
            <option value="1">Grayscale</option>
            <option value="2">Blur (3x3)</option>
          </select>
        </label>

        <label>
          Blur Mix
          <input id="blurMixInput" type="range" min="0" max="1" step="0.01" value="1" />
        </label>
      </section>

      <section class="panel canvas-panel">
        <canvas id="gpuCanvas" width="960" height="540"></canvas>
      </section>

      <section class="panel">
        <h2>Status</h2>
        <pre id="status">等待初始化...</pre>
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
  background: #0c1020;
  color: #eef3ff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.container {
  max-width: 1024px;
  margin: 26px auto;
  padding: 0 16px 24px;
}

.subtitle {
  color: #bcc8ea;
}

.panel {
  margin-top: 14px;
  background: #151d35;
  border: 1px solid #30406b;
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
input {
  border: 1px solid #4961a2;
  border-radius: 8px;
  background: #0f1833;
  color: #eef3ff;
  padding: 8px 10px;
}

.canvas-panel {
  padding: 8px;
}

#gpuCanvas {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 8px;
  border: 1px solid #394e87;
  background: #090e1a;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
const canvas = document.querySelector("#gpuCanvas");
const fileInput = document.querySelector("#fileInput");
const modeSelect = document.querySelector("#modeSelect");
const blurMixInput = document.querySelector("#blurMixInput");
const statusEl = document.querySelector("#status");

function setStatus(text) {
  statusEl.textContent = text;
}

const state = {
  device: null,
  context: null,
  format: null,
  pipeline: null,
  sampler: null,
  paramsBuffer: null,
  kernelBuffer: null,
  bindGroup: null,
  sourceTexture: null,
  imageWidth: 1,
  imageHeight: 1
};

function resizeCanvas(width, height) {
  canvas.width = width;
  canvas.height = height;
}

function writeParams() {
  const params = new Float32Array(4);
  params[0] = Number(modeSelect.value);     // mode
  params[1] = Number(blurMixInput.value);   // blur mix
  params[2] = 1 / state.imageWidth;         // texel x
  params[3] = 1 / state.imageHeight;        // texel y
  state.device.queue.writeBuffer(state.paramsBuffer, 0, params);
}

function createBindGroup() {
  if (!state.sourceTexture) return;
  state.bindGroup = state.device.createBindGroup({
    layout: state.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: state.sampler },
      { binding: 1, resource: state.sourceTexture.createView() },
      { binding: 2, resource: { buffer: state.paramsBuffer } },
      { binding: 3, resource: { buffer: state.kernelBuffer } }
    ]
  });
}

function render() {
  const device = state.device;
  const context = state.context;
  if (!device || !context) return;

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.05, g: 0.06, b: 0.09, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }
    ]
  });

  if (state.bindGroup) {
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, state.bindGroup);
    pass.draw(6, 1, 0, 0);
  }

  pass.end();
  device.queue.submit([encoder.finish()]);
}

async function uploadImage(file) {
  const bitmap = await createImageBitmap(file);
  state.imageWidth = bitmap.width;
  state.imageHeight = bitmap.height;

  resizeCanvas(bitmap.width, bitmap.height);
  state.context.configure({
    device: state.device,
    format: state.format,
    alphaMode: "premultiplied"
  });

  if (state.sourceTexture) {
    state.sourceTexture.destroy();
    state.sourceTexture = null;
  }

  state.sourceTexture = state.device.createTexture({
    size: [bitmap.width, bitmap.height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });

  state.device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture: state.sourceTexture },
    [bitmap.width, bitmap.height]
  );

  if (typeof bitmap.close === "function") {
    bitmap.close();
  }

  writeParams();
  createBindGroup();
  render();
  setStatus(`已上傳 ${file.name}（${bitmap.width} x ${bitmap.height}）`);
}

async function init() {
  if (!("gpu" in navigator)) {
    setStatus("瀏覽器不支援 WebGPU。");
    return;
  }

  const context = canvas.getContext("webgpu");
  if (!context) {
    setStatus("無法取得 webgpu context。");
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    setStatus("找不到可用 GPU adapter。");
    return;
  }
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();

  state.device = device;
  state.context = context;
  state.format = format;

  context.configure({
    device,
    format,
    alphaMode: "premultiplied"
  });

  const shader = device.createShaderModule({
    code: `
struct Params {
  mode: f32,
  blurMix: f32,
  texelX: f32,
  texelY: f32
}

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read> kernel: array<f32>;

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

fn grayscale(color: vec3f) -> vec3f {
  let y = dot(color, vec3f(0.299, 0.587, 0.114));
  return vec3f(y, y, y);
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  let original = textureSample(inputTexture, inputSampler, in.uv).rgb;

  if (params.mode < 0.5) {
    return vec4f(original, 1.0);
  }

  if (params.mode < 1.5) {
    return vec4f(grayscale(original), 1.0);
  }

  let stepUV = vec2f(params.texelX, params.texelY);
  var sum = vec3f(0.0);
  var idx = 0u;

  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let offset = vec2f(f32(x), f32(y)) * stepUV;
      let color = textureSample(inputTexture, inputSampler, in.uv + offset).rgb;
      sum = sum + color * kernel[idx];
      idx = idx + 1u;
    }
  }

  let blurred = sum;
  let mixed = mix(original, blurred, params.blurMix);
  return vec4f(mixed, 1.0);
}
`
  });

  state.pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vsMain" },
    fragment: {
      module: shader,
      entryPoint: "fsMain",
      targets: [{ format }]
    },
    primitive: { topology: "triangle-list" }
  });

  state.sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge"
  });

  state.paramsBuffer = device.createBuffer({
    size: 16, // 4 floats
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // storage buffer：放 3x3 blur kernel（其餘空間保留）
  state.kernelBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });

  const kernelData = new Float32Array(16);
  // Gaussian-like 3x3 kernel
  const k = [1, 2, 1, 2, 4, 2, 1, 2, 1].map((v) => v / 16);
  for (let i = 0; i < k.length; i += 1) kernelData[i] = k[i];
  device.queue.writeBuffer(state.kernelBuffer, 0, kernelData);

  writeParams();
  render();
  setStatus("初始化完成，請上傳圖片。");
}

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    setStatus(`上傳中：${file.name} ...`);
    await uploadImage(file);
  } catch (error) {
    console.error(error);
    setStatus(`上傳失敗：${error.message}`);
  }
});

modeSelect.addEventListener("change", () => {
  writeParams();
  render();
  const labels = ["Original", "Grayscale", "Blur"];
  setStatus(`已切換濾鏡：${labels[Number(modeSelect.value)]}`);
});

blurMixInput.addEventListener("input", () => {
  writeParams();
  render();
  if (Number(modeSelect.value) === 2) {
    setStatus(`模糊混合強度：${Number(blurMixInput.value).toFixed(2)}`);
  }
});

init().catch((error) => {
  console.error(error);
  setStatus(`初始化失敗：${error.message}`);
});
```

---

> 下一課：`05-compute-shader-gpgpu.md`（Compute Shader 與 GPU 版矩陣乘法 benchmark）
