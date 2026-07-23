# 圖學補充課 G2：3D 變換與相機（1 週）

> 「圖學補充課（Graphics Track）」第二課。延續主線第 02 課只畫 2D 三角形的基礎，這一課讓你真正踏進 **3D**：用 Model / View / Projection 矩陣把一個立方體擺進世界、透過相機觀察，並用**深度測試**正確處理前後遮擋。

## G2.1 本課目標

第 02 課的 Hello Triangle 直接把頂點寫在裁切空間（NDC），沒有相機、沒有 3D。
真正的 3D 圖學核心，是三個矩陣：**Model、View、Projection**。

本課你要掌握：

- `mat4` + 齊次座標 `vec4`（延續 G1）
- **Model 矩陣**：把物體擺到世界的哪裡、多大、轉多少
- **View 矩陣**：相機在哪、看哪裡（`lookAt`）
- **Projection 矩陣**：透視投影（fov / aspect / near / far）
- **MVP = Projection · View · Model**
- WebGPU 的 **深度測試 / z-buffer**（含 depth texture 設定）
- 作業：**會旋轉的 3D 立方體 + 可調相機/視角**

---

## G2.2 三個空間，三個矩陣

一個頂點從「模型自己的座標」變成「螢幕上的像素」，會經過幾個空間：

```text
Local/Model space   （立方體以自己中心為原點）
   │  × Model 矩陣（擺放：縮放/旋轉/平移）
World space         （所有物體共處的世界）
   │  × View 矩陣（把世界搬到「相機座標系」）
View/Camera space   （相機在原點，看向 -z）
   │  × Projection 矩陣（透視：遠的東西變小）
Clip space          （裁切座標，GPU 會做透視除法）
   │  ÷ w（GPU 自動）
NDC                 （x,y ∈ [-1,1]，z ∈ [0,1]）
```

在頂點著色器裡，我們把三個矩陣先乘好成 **MVP**，一次搞定：

```wgsl
out.position = mvp * vec4f(localPos, 1.0);
```

---

## G2.3 Model 矩陣：擺放物體

就是 G1 學的 `T · R · S`，只是升級成 4x4：

```text
Model = Translate · Rotate · Scale
```

本課 Model 只做旋轉（讓立方體轉起來），所以 `Model = RotateY(t) · RotateX(t)`。

---

## G2.4 View 矩陣：相機在哪、看哪裡

我們不「移動相機」，而是**反向移動整個世界**——這就是 View 矩陣做的事。
最常用的建構方式是 `lookAt(eye, target, up)`：

- `eye`：相機位置
- `target`：看向的點（通常是物體中心 `(0,0,0)`）
- `up`：世界的上方向（通常 `(0,1,0)`）

`lookAt` 內部用**外積**（G1 學過）把 `forward / right / up` 三個互相垂直的軸湊出來，再組成矩陣。

---

## G2.5 Projection 矩陣：透視投影

透視投影讓「遠的東西看起來比較小」，靠的是把 z 寫進 `w`，之後 GPU 做**透視除法**（`xyz / w`）。

四個參數：

- `fov`（field of view）：垂直視角，越大越「廣角」
- `aspect`：畫布寬高比 `width / height`（不設對會變形）
- `near` / `far`：可見範圍的近平面與遠平面

> ⚠️ **WebGPU 專屬重點**：WebGPU 的 NDC 深度範圍是 **[0, 1]**（OpenGL 是 [-1, 1]）。
> 所以投影矩陣要用 **zero-to-one（ZO）** 版本，本課的 `perspectiveZO` 已經處理好。用錯版本會導致深度測試整個壞掉。

---

## G2.6 深度測試 / z-buffer（3D 一定要）

2D 只有先畫後畫的差別；3D 有前後遮擋，必須靠**深度緩衝**。

WebGPU 需要三件事同時到位：

1. 建一張 **depth texture**（例如 `depth24plus`），大小跟 canvas 一致
2. render pass 掛上 `depthStencilAttachment`（`depthClearValue: 1.0`，clear/store）
3. pipeline 設 `depthStencil: { depthWriteEnabled: true, depthCompare: "less", format }`

還有一個常見設定是 **背面剔除（back-face culling）**：`primitive.cullMode = "back"`。
只要頂點繞序（winding）正確（預設正面為 `ccw`），背對相機的面就不會被畫，省效能。

---

## G2.7 本週作業規格

### 必做

- 用 WebGPU 畫一個 **3D 立方體**（6 面，各面不同顏色）
- 立方體會自動旋轉
- 正確使用 **深度測試**（旋轉時前後面不會穿透亂畫）
- 可調：旋轉速度、相機距離、fov

### 驗收

- 立方體轉起來每個角度都正確遮擋（無穿模）
- 調 fov 有明顯透視變化；調相機距離物體變大/變小
- 改變視窗大小，立方體不變形（aspect 有正確處理）
- 你能講出 MVP 三個矩陣各自負責什麼

---

## G2.8 常見錯誤與排查

### 問題一：畫面全黑 / 立方體不見

- MVP 相乘順序錯（應為 `proj · view · model`）
- 相機 `eye` 太近或在物體內部；或 `near/far` 把物體切掉
- 用了 OpenGL 版投影（z 範圍 [-1,1]），在 WebGPU 深度全被裁掉

### 問題二：立方體「內外翻面」或閃爍穿模

- 沒開深度測試，或忘了掛 depth attachment
- depth texture 尺寸和 canvas 不一致（resize 後沒重建）

### 問題三：立方體被拉扁/變形

- 投影 `aspect` 沒用 `canvas.width / canvas.height`
- resize 後沒更新 aspect

### 問題四：column-major 弄錯

- 自己寫的矩陣和 shader 的 `mat4x4` 儲存順序不一致（本課全用 column-major）

---

## G2.9 本章小結

- 你已能用 Model / View / Projection 把物體放進 3D 世界並用相機觀察
- 你懂了 MVP 的相乘順序與 WebGPU 的深度 [0,1] 慣例
- 你會設定 depth texture 與深度測試，正確處理遮擋
- 這個 `mat4` 工具與立方體，G3 會直接拿來加上光照

---

## G2.10 本課實作成品代碼（完整）

### 檔案結構

```text
graphics-02-3d-camera/
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
    <title>Graphics 02 - 3D Cube & Camera</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Graphics 02：3D 立方體 + 相機（MVP / 深度測試）</h1>
      <p class="subtitle">Model · View · Projection 三矩陣，加上 z-buffer 正確遮擋。</p>

      <section class="panel controls">
        <label>
          Rotate Speed (rad/s)
          <input id="speedInput" type="range" min="-3" max="3" step="0.05" value="0.8" />
        </label>
        <label>
          Camera Distance
          <input id="distInput" type="range" min="2.5" max="10" step="0.1" value="5" />
        </label>
        <label>
          FOV (deg)
          <input id="fovInput" type="range" min="25" max="100" step="1" value="55" />
        </label>
        <button id="pauseBtn">Pause</button>
      </section>

      <section class="panel canvas-panel">
        <canvas id="gpuCanvas" width="920" height="540"></canvas>
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
  gap: 14px;
  align-items: end;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}

input[type="range"] {
  width: 180px;
}

button {
  cursor: pointer;
  border: 1px solid #2d6eff;
  background: #2d6eff;
  color: #fff;
  border-radius: 8px;
  padding: 9px 14px;
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
  background: #070b16;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
// =========================================================
// mat4：column-major，長度 16，對齊 WGSL mat4x4 與 glMatrix 慣例
// =========================================================
const mat4 = {
  identity() {
    const o = new Float32Array(16);
    o[0] = o[5] = o[10] = o[15] = 1;
    return o;
  },

  multiply(a, b) {
    // out = a · b
    const o = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let c = 0; c < 4; c += 1) {
      const b0 = b[c * 4 + 0];
      const b1 = b[c * 4 + 1];
      const b2 = b[c * 4 + 2];
      const b3 = b[c * 4 + 3];
      o[c * 4 + 0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      o[c * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      o[c * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      o[c * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return o;
  },

  fromXRotation(rad) {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const o = mat4.identity();
    o[5] = c; o[6] = s; o[9] = -s; o[10] = c;
    return o;
  },

  fromYRotation(rad) {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const o = mat4.identity();
    o[0] = c; o[2] = -s; o[8] = s; o[10] = c;
    return o;
  },

  // WebGPU 專用：NDC 深度範圍 [0, 1]
  perspectiveZO(fovY, aspect, near, far) {
    const f = 1.0 / Math.tan(fovY / 2);
    const o = new Float32Array(16);
    o[0] = f / aspect;
    o[5] = f;
    o[11] = -1;
    const nf = 1 / (near - far);
    o[10] = far * nf;
    o[14] = far * near * nf;
    return o;
  },

  lookAt(eye, center, up) {
    const [ex, ey, ez] = eye;
    let zx = ex - center[0];
    let zy = ey - center[1];
    let zz = ez - center[2];
    let rl = 1 / Math.hypot(zx, zy, zz);
    zx *= rl; zy *= rl; zz *= rl;

    // x = normalize(cross(up, z))
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    rl = Math.hypot(xx, xy, xz);
    rl = rl ? 1 / rl : 0;
    xx *= rl; xy *= rl; xz *= rl;

    // y = cross(z, x)
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    const o = new Float32Array(16);
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * ex + xy * ey + xz * ez);
    o[13] = -(yx * ex + yy * ey + yz * ez);
    o[14] = -(zx * ex + zy * ey + zz * ez);
    o[15] = 1;
    return o;
  },
};

// =========================================================
// 立方體資料：8 個角，6 面各配一個顏色（CCW 正面）
// 每頂點 = position(3) + color(3)
// =========================================================
function buildCube() {
  const c = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const faces = [
    { idx: [4, 5, 6, 7], color: [0.92, 0.28, 0.36] }, // +z
    { idx: [1, 0, 3, 2], color: [0.30, 0.72, 0.95] }, // -z
    { idx: [0, 4, 7, 3], color: [0.98, 0.75, 0.24] }, // -x
    { idx: [5, 1, 2, 6], color: [0.40, 0.85, 0.55] }, // +x
    { idx: [7, 6, 2, 3], color: [0.72, 0.52, 0.98] }, // +y
    { idx: [0, 1, 5, 4], color: [0.95, 0.55, 0.75] }, // -y
  ];

  const data = [];
  for (const f of faces) {
    const [i0, i1, i2, i3] = f.idx;
    const quad = [i0, i1, i2, i0, i2, i3];
    for (const vi of quad) {
      data.push(c[vi][0], c[vi][1], c[vi][2], f.color[0], f.color[1], f.color[2]);
    }
  }
  return new Float32Array(data); // 36 verts × 6 floats
}

// =========================================================
// 主程式
// =========================================================
const canvas = document.querySelector("#gpuCanvas");
const speedInput = document.querySelector("#speedInput");
const distInput = document.querySelector("#distInput");
const fovInput = document.querySelector("#fovInput");
const pauseBtn = document.querySelector("#pauseBtn");
const statusEl = document.querySelector("#status");

let paused = false;
let rotSpeed = Number(speedInput.value);
let angle = 0;
let lastTs = performance.now();

const setStatus = (t) => (statusEl.textContent = t);

function resizeCanvasToDisplaySize(target) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.floor(target.clientWidth * dpr);
  const height = Math.floor(target.clientWidth * 0.58 * dpr);
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
    return true;
  }
  return false;
}

async function start() {
  if (!("gpu" in navigator)) {
    setStatus("瀏覽器不支援 WebGPU，請使用最新版 Chrome/Edge。");
    return;
  }

  const context = canvas.getContext("webgpu");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    setStatus("找不到可用 GPU adapter。");
    return;
  }
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();

  resizeCanvasToDisplaySize(canvas);
  context.configure({ device, format, alphaMode: "opaque" });

  const cubeData = buildCube();
  const vertexBuffer = device.createBuffer({
    size: cubeData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, cubeData);

  const shader = device.createShaderModule({
    code: `
struct Uniforms {
  mvp: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) pos: vec3f,
  @location(1) color: vec3f,
}
struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vs(in: VSIn) -> VSOut {
  var out: VSOut;
  out.clip = u.mvp * vec4f(in.pos, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`,
  });

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shader,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 6 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
          ],
        },
      ],
    },
    fragment: {
      module: shader,
      entryPoint: "fs",
      targets: [{ format }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "back",
      frontFace: "ccw",
    },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: "less",
      format: "depth24plus",
    },
  });

  const uniformData = new Float32Array(16); // 1 個 mat4
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // depth texture（隨 canvas 尺寸重建）
  let depthTexture = null;
  function ensureDepth() {
    if (
      !depthTexture ||
      depthTexture.width !== canvas.width ||
      depthTexture.height !== canvas.height
    ) {
      if (depthTexture) depthTexture.destroy();
      depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
  }

  speedInput.addEventListener("input", () => {
    rotSpeed = Number(speedInput.value);
  });
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
  });
  window.addEventListener("resize", () => {
    if (resizeCanvasToDisplaySize(canvas)) {
      context.configure({ device, format, alphaMode: "opaque" });
    }
  });

  setStatus("初始化完成，開始渲染 3D 立方體。");

  function frame(now) {
    const dt = (now - lastTs) / 1000;
    lastTs = now;
    if (!paused) angle += rotSpeed * dt;

    ensureDepth();

    // Model = RotateY · RotateX
    const model = mat4.multiply(
      mat4.fromYRotation(angle),
      mat4.fromXRotation(angle * 0.6)
    );

    // View：相機在 +z，看向原點
    const dist = Number(distInput.value);
    const view = mat4.lookAt([0, 0, dist], [0, 0, 0], [0, 1, 0]);

    // Projection：透視（WebGPU ZO）
    const fov = (Number(fovInput.value) * Math.PI) / 180;
    const aspect = canvas.width / canvas.height;
    const proj = mat4.perspectiveZO(fov, aspect, 0.1, 100);

    // MVP = P · V · M
    const mvp = mat4.multiply(proj, mat4.multiply(view, model));
    uniformData.set(mvp);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.03, g: 0.04, b: 0.08, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(36, 1, 0, 0);
    pass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

start().catch((error) => {
  console.error(error);
  setStatus(`初始化失敗：${error.message}`);
});
```

---

> 下一課：[G3：光照模型（法線 / Lambert 漫反射 / Blinn-Phong 高光）](./g03-lighting-blinn-phong.md)
