# 圖學補充課 G3：光照模型（Blinn-Phong）（1 週）

> 「圖學補充課（Graphics Track）」第三課，也是收尾。延續 G2 的 3D 立方體與 `mat4` 工具，這一課讓表面「有光」：理解法線、實作 **Ambient + Diffuse（Lambert）+ Specular（Blinn-Phong）** 三分量光照。

## G3.1 本課目標

G2 的立方體每個面是固定純色，看起來是平的、假的。
真實感來自**光**：面朝向光就亮、背對就暗、光滑處有高光。這需要每個像素知道「表面朝哪」——也就是**法線（normal）**。

本課你要掌握：

- 為什麼需要法線，法線在變換時的特殊規則（**normal matrix**）
- 光照三分量：**Ambient（環境光）+ Diffuse（漫反射）+ Specular（高光）**
- **Lambert 餘弦定律**：`diffuse = max(N · L, 0)`（點積回來了，G1 的伏筆）
- **Blinn-Phong** 高光：半程向量 `H` 與 `pow(N · H, shininess)`
- 作業：**可互動的光照立方體**（光源位置、材質參數即時可調）

---

## G3.2 光照的直覺：三個分量疊加

現實中一個像素最終的亮度，可拆成三塊相加：

```text
finalColor = Ambient + Diffuse + Specular
```

| 分量 | 直覺 | 決定因素 |
|---|---|---|
| **Ambient** 環境光 | 就算沒直接照到也不是全黑（環境反彈） | 一個小常數 |
| **Diffuse** 漫反射 | 面越正對光源越亮，粗糙表面的主體亮度 | `N · L`（法線 vs 光線方向） |
| **Specular** 高光 | 光滑表面的亮點，會隨視角移動 | `N · H`（法線 vs 半程向量） |

四個關鍵向量（都在**世界座標**、都要 `normalize`）：

- `N`：表面法線
- `L`：從表面指向光源的方向
- `V`：從表面指向相機（視線）的方向
- `H`：`normalize(L + V)`，L 與 V 的「半程向量」（Blinn-Phong 用）

---

## G3.3 Diffuse：Lambert 餘弦定律

漫反射假設光打到粗糙表面後往各方向均勻散射，亮度只取決於**入射角**：

```text
diffuse = max(dot(N, L), 0.0)
```

- `N`、`L` 正對（夾角 0°）→ `dot = 1`，最亮
- 夾角 90° → `dot = 0`，剛好不被照到
- 背對（`dot < 0`）→ 用 `max(_, 0)` 夾成 0，不會出現負亮度

> 這就是 G1 講的點積：`N · L = cos(θ)`。當初說「點積是光照核心」，指的就是這裡。

---

## G3.4 Specular：Phong vs Blinn-Phong

高光是光滑表面把光「鏡面反射」進你眼睛時看到的亮點。

**Phong** 版本用反射向量 `R`：

```text
R = reflect(-L, N)
specular = pow(max(dot(R, V), 0.0), shininess)
```

**Blinn-Phong**（本課採用，較穩定、業界常用）改用**半程向量 `H`**：

```text
H = normalize(L + V)
specular = pow(max(dot(N, H), 0.0), shininess)
```

- `shininess`（光澤度）越大，高光越小越集中（越像金屬/塑膠）
- Blinn-Phong 在掠射角比 Phong 表現更好，且省一次 `reflect`

---

## G3.5 法線的變換：normal matrix（最容易錯）

頂點位置用 Model 矩陣變換沒問題，但**法線不能直接乘 Model 矩陣**。
一旦 Model 含有**非等比縮放（non-uniform scale）**，直接乘會讓法線不再垂直於表面，光照就歪了。

正確做法是用 **normal matrix**：

```text
normalMatrix = transpose(inverse(model))
```

取它的左上 3x3 去乘法線，再 `normalize`。

- 若 Model 只有旋轉/等比縮放，normal matrix 其實等於 Model 的 3x3（但養成正確習慣，之後加縮放才不會壞）。
- 法線是「方向」，所以在 shader 裡用 `vec4(normal, 0.0)` 的概念（不受平移影響）。

---

## G3.6 在哪個空間打光？

本課在**世界座標（world space）**打光，流程：

1. 頂點：`worldPos = model * localPos`，`worldNormal = normalMatrix * normal`
2. 傳給 fragment（GPU 會做插值）
3. fragment：用 `worldPos`、`worldNormal`、光源世界座標、相機世界座標算 Blinn-Phong

> 每像素（fragment）各自算光照，叫 **Phong shading**（逐像素），比逐頂點插值亮度平滑很多。

---

## G3.7 本週作業規格

### 必做

- 在 G2 的立方體上實作 **Ambient + Diffuse + Blinn-Phong Specular**
- 每個面有正確法線
- 使用 **normal matrix** 變換法線
- 可調：光源位置（繞行）、ambient/diffuse/specular 強度、shininess、物體顏色

### 建議加分

- 讓光源用一個小標記/動畫繞著立方體轉，直觀看到亮面移動
- 加一個開關切換「只有 diffuse」vs「完整 Blinn-Phong」比較差異

### 驗收

- 旋轉時，正對光源的面明顯較亮，背光面靠 ambient 撐住不全黑
- 調高 shininess，高光點變小變集中
- 移動光源，亮面與高光跟著移動且方向正確
- 你能講出 N/L/V/H 各是什麼、normal matrix 為何需要

---

## G3.8 常見錯誤與排查

### 問題一：整個立方體一樣亮 / 沒有明暗

- 法線算錯或全部相同；確認每個面法線不同
- 忘了 `normalize(N)` 或在 fragment 沒重新 normalize 插值後的法線

### 問題二：高光位置怪、會抖

- `L`、`V`、`H`、`N` 沒有全部 `normalize`
- 沒在世界座標算，或相機位置（viewPos）給錯

### 問題三：加了縮放後光照就歪

- 用 Model 矩陣直接變換法線；應改用 `transpose(inverse(model))`

### 問題四：背光面出現詭異高光

- Specular 沒有在 `dot(N, L) <= 0` 時關掉；本課用 `select(...)` 擋掉

### 問題五：畫面全黑（延續 G2）

- MVP 順序、深度測試、depth texture 尺寸——回頭檢查 G2 的排查清單

---

## G3.9 本章小結

- 你已能為 3D 物體實作完整 Blinn-Phong 光照
- 你懂了 Ambient/Diffuse/Specular 各自的來源與公式
- 你懂了法線為何要用 normal matrix，以及逐像素打光
- 至此，圖學補充課（G1 數學 → G2 相機 → G3 光照）走完一輪，你已具備自己做小型 3D 場景的基礎

---

## G3.10 本課實作成品代碼（完整）

### 檔案結構

```text
graphics-03-lighting/
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
    <title>Graphics 03 - Blinn-Phong Lighting</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Graphics 03：光照立方體（Blinn-Phong）</h1>
      <p class="subtitle">Ambient + Diffuse（Lambert）+ Specular（Blinn-Phong），逐像素打光。</p>

      <section class="panel controls">
        <label>Ambient <input id="ambient" type="range" min="0" max="1" step="0.01" value="0.12" /></label>
        <label>Diffuse <input id="diffuse" type="range" min="0" max="2" step="0.01" value="1" /></label>
        <label>Specular <input id="specular" type="range" min="0" max="2" step="0.01" value="0.8" /></label>
        <label>Shininess <input id="shininess" type="range" min="2" max="256" step="1" value="48" /></label>
        <label>Object Color <input id="color" type="color" value="#d0d5dd" /></label>
        <label>Rotate <input id="speed" type="range" min="-2" max="2" step="0.05" value="0.5" /></label>
        <label>Light Orbit <input id="lightSpeed" type="range" min="0" max="3" step="0.05" value="1" /></label>
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
  font-size: 13px;
}

input[type="range"] {
  width: 150px;
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
  background: #05080f;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}
```

### `app.js`

```javascript
// =========================================================
// mat4（column-major）—— 沿用 G2，並補上 invert / transpose
// =========================================================
const mat4 = {
  identity() {
    const o = new Float32Array(16);
    o[0] = o[5] = o[10] = o[15] = 1;
    return o;
  },

  multiply(a, b) {
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

    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    rl = Math.hypot(xx, xy, xz);
    rl = rl ? 1 / rl : 0;
    xx *= rl; xy *= rl; xz *= rl;

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

  invert(a) {
    const o = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det =
      b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return mat4.identity();
    det = 1.0 / det;

    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },

  transpose(a) {
    const o = new Float32Array(16);
    o[0] = a[0]; o[1] = a[4]; o[2] = a[8]; o[3] = a[12];
    o[4] = a[1]; o[5] = a[5]; o[6] = a[9]; o[7] = a[13];
    o[8] = a[2]; o[9] = a[6]; o[10] = a[10]; o[11] = a[14];
    o[12] = a[3]; o[13] = a[7]; o[14] = a[11]; o[15] = a[15];
    return o;
  },

  // normalMatrix = transpose(inverse(model))
  normalMatrix(model) {
    return mat4.transpose(mat4.invert(model));
  },
};

// =========================================================
// 立方體：position(3) + normal(3)，每面法線相同（硬邊）
// =========================================================
function buildCube() {
  const c = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const faces = [
    { idx: [4, 5, 6, 7], n: [0, 0, 1] },  // +z
    { idx: [1, 0, 3, 2], n: [0, 0, -1] }, // -z
    { idx: [0, 4, 7, 3], n: [-1, 0, 0] }, // -x
    { idx: [5, 1, 2, 6], n: [1, 0, 0] },  // +x
    { idx: [7, 6, 2, 3], n: [0, 1, 0] },  // +y
    { idx: [0, 1, 5, 4], n: [0, -1, 0] }, // -y
  ];

  const data = [];
  for (const f of faces) {
    const [i0, i1, i2, i3] = f.idx;
    const quad = [i0, i1, i2, i0, i2, i3];
    for (const vi of quad) {
      data.push(c[vi][0], c[vi][1], c[vi][2], f.n[0], f.n[1], f.n[2]);
    }
  }
  return new Float32Array(data); // 36 × 6
}

// =========================================================
// 主程式
// =========================================================
const canvas = document.querySelector("#gpuCanvas");
const statusEl = document.querySelector("#status");
const ui = {
  ambient: document.querySelector("#ambient"),
  diffuse: document.querySelector("#diffuse"),
  specular: document.querySelector("#specular"),
  shininess: document.querySelector("#shininess"),
  color: document.querySelector("#color"),
  speed: document.querySelector("#speed"),
  lightSpeed: document.querySelector("#lightSpeed"),
  pauseBtn: document.querySelector("#pauseBtn"),
};

let paused = false;
let angle = 0;
let lightAngle = 0;
let lastTs = performance.now();

const setStatus = (t) => (statusEl.textContent = t);

function hexToRgb01(hex) {
  const v = Number.parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

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
  model: mat4x4<f32>,
  normalMat: mat4x4<f32>,
  lightPos: vec4f,
  viewPos: vec4f,
  baseColor: vec4f,
  lightColor: vec4f,
  coeffs: vec4f,   // x:ambient y:diffuse z:specular w:shininess
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
}
struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) worldNormal: vec3f,
}

@vertex
fn vs(in: VSIn) -> VSOut {
  var out: VSOut;
  let world = u.model * vec4f(in.pos, 1.0);
  out.worldPos = world.xyz;

  let nm = mat3x3<f32>(
    u.normalMat[0].xyz,
    u.normalMat[1].xyz,
    u.normalMat[2].xyz
  );
  out.worldNormal = nm * in.normal;

  out.clip = u.mvp * vec4f(in.pos, 1.0);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let N = normalize(in.worldNormal);
  let L = normalize(u.lightPos.xyz - in.worldPos);
  let V = normalize(u.viewPos.xyz - in.worldPos);
  let H = normalize(L + V);

  let ambient = u.coeffs.x;
  let ndl = max(dot(N, L), 0.0);
  let diffuse = ndl * u.coeffs.y;

  // 只有正面對光才有高光，避免背光面出現詭異亮點
  let specBase = pow(max(dot(N, H), 0.0), u.coeffs.w);
  let specular = select(0.0, specBase * u.coeffs.z, ndl > 0.0);

  let lit =
    u.baseColor.rgb * (ambient + diffuse) * u.lightColor.rgb +
    u.lightColor.rgb * specular;

  return vec4f(clamp(lit, vec3f(0.0), vec3f(1.0)), 1.0);
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

  // 68 floats：mvp(16)+model(16)+normalMat(16)+lightPos(4)+viewPos(4)
  //            +baseColor(4)+lightColor(4)+coeffs(4)
  const uniformData = new Float32Array(68);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

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

  ui.pauseBtn.addEventListener("click", () => {
    paused = !paused;
    ui.pauseBtn.textContent = paused ? "Resume" : "Pause";
  });
  window.addEventListener("resize", () => {
    if (resizeCanvasToDisplaySize(canvas)) {
      context.configure({ device, format, alphaMode: "opaque" });
    }
  });

  const eye = [0, 1.2, 5];
  setStatus("初始化完成，開始渲染光照立方體。");

  function frame(now) {
    const dt = (now - lastTs) / 1000;
    lastTs = now;
    if (!paused) {
      angle += Number(ui.speed.value) * dt;
      lightAngle += Number(ui.lightSpeed.value) * dt;
    }

    ensureDepth();

    // Model
    const model = mat4.multiply(
      mat4.fromYRotation(angle),
      mat4.fromXRotation(angle * 0.5)
    );
    const normalMat = mat4.normalMatrix(model);

    // View / Projection
    const view = mat4.lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const aspect = canvas.width / canvas.height;
    const proj = mat4.perspectiveZO((55 * Math.PI) / 180, aspect, 0.1, 100);
    const mvp = mat4.multiply(proj, mat4.multiply(view, model));

    // 光源繞著立方體轉
    const lr = 3.2;
    const lightPos = [
      Math.cos(lightAngle) * lr,
      1.8,
      Math.sin(lightAngle) * lr,
    ];

    const [cr, cg, cb] = hexToRgb01(ui.color.value);

    // 依 struct 順序填 uniform
    uniformData.set(mvp, 0);
    uniformData.set(model, 16);
    uniformData.set(normalMat, 32);
    uniformData.set([lightPos[0], lightPos[1], lightPos[2], 0], 48);
    uniformData.set([eye[0], eye[1], eye[2], 0], 52);
    uniformData.set([cr, cg, cb, 1], 56);
    uniformData.set([1, 1, 1, 1], 60); // 白光
    uniformData.set(
      [
        Number(ui.ambient.value),
        Number(ui.diffuse.value),
        Number(ui.specular.value),
        Number(ui.shininess.value),
      ],
      64
    );
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.03, b: 0.06, a: 1 },
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

> 圖學補充課到此結束。回到主線：[Browser AI 課程總目錄](./README.md)
