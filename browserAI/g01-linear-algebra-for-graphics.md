# 圖學補充課 G1：圖學向線性代數（1 週）

> 這是「圖學補充課（Graphics Track）」的第一課，補齊主線第 01 課（AI 向數學）沒有深入的**電腦圖學數學**：向量、點積、外積、矩陣與變換矩陣。
> 打完這個底，才能在 G2 做 3D 相機、在 G3 做光照。

## G1.1 本課目標

主線第 01 課的線性代數是「AI 推論向」的——重點在矩陣乘法（GEMM）與記憶體布局。
但圖學需要的是另一套直覺：**怎麼用向量與矩陣去描述空間中的位置、方向與變換**。

本課你要掌握：

- 向量的幾何意義：加減、縮放、長度、正規化（normalize）
- **點積（dot product）**：夾角、投影，光照的核心
- **外積（cross product）**：求法線、判斷正反面
- 矩陣與矩陣乘法（column-major 觀念）
- **變換矩陣**：縮放 / 旋轉 / 平移，以及為什麼要「齊次座標」
- 作業：**做一個向量 + 2D 變換的互動 playground**

---

## G1.2 為什麼圖學要另外學一套？

AI 的矩陣運算，你在意的是「大量數字怎麼快速算完」。
圖學的矩陣運算，你在意的是「這個矩陣把點搬到哪裡、把方向轉到哪裡」。

| 面向 | AI 向（第 01 課） | 圖學向（本課） |
|---|---|---|
| 主角 | 大矩陣 GEMM | 小矩陣（3x3 / 4x4）× 向量 |
| 在意 | 吞吐量、cache 命中 | 幾何意義、變換組合順序 |
| 典型問題 | 「怎麼算更快」 | 「點跑去哪、方向對不對」 |
| 後續用途 | 神經網路線性層 | 相機、模型擺放、光照 |

同樣是矩陣乘法，換一個視角看，就是整個 3D 世界的基礎。

---

## G1.3 向量：位置與方向

在圖學裡，一個 `vec3 = (x, y, z)` 可以表示兩種東西：

- **位置（point）**：空間中某個點
- **方向（direction）**：一個箭頭，只在乎指向與長度

### 基本運算

```text
加法： a + b          （位移疊加）
減法： b - a          （從 a 指向 b 的方向）
縮放： s * a          （拉長/縮短）
長度： |a| = sqrt(x² + y² + z²)
正規化：â = a / |a|   （長度變成 1，只保留方向）
```

> 關鍵直覺：**「終點 − 起點 = 方向」**。這在算光線、視線、相機朝向時每天都會用。

---

## G1.4 點積（Dot Product）—— 光照的核心

```text
a · b = ax*bx + ay*by + az*bz
      = |a| * |b| * cos(θ)
```

幾何意義：

- 若 `a`、`b` 都已正規化，則 `a · b = cos(θ)`（兩者夾角的餘弦）
- `a · b > 0`：夾角小於 90°（同向）
- `a · b = 0`：垂直
- `a · b < 0`：夾角大於 90°（反向）

### 為什麼重要？

- **光照**：表面法線 `N` 與光源方向 `L` 的點積 `max(N · L, 0)`，就是這個面「被照到多亮」（Lambert 定律，G3 會用）。
- **投影**：把一個向量投影到另一個方向上的長度。
- **背面判斷**：視線與法線的點積符號，可判斷面朝向鏡頭與否。

---

## G1.5 外積（Cross Product）—— 求法線

```text
a × b = ( ay*bz - az*by,
          az*bx - ax*bz,
          ax*by - ay*bx )
```

幾何意義：

- 結果是一個**同時垂直於 `a` 與 `b`** 的向量
- 方向依「右手定則」決定
- 長度 = `|a| * |b| * sin(θ)`（等於兩向量張成的平行四邊形面積）

### 為什麼重要？

- **求三角形法線**：`N = normalize(cross(p1 - p0, p2 - p0))`，這是把幾何轉成可打光資料的第一步。
- **建構相機座標系**：`lookAt` 就是用外積把「朝向、上方向」湊出彼此垂直的三軸（G2 會用）。

> 注意：外積**不可交換**，`a × b = -(b × a)`。順序搞反，法線就會朝反面，畫出來會黑掉。

---

## G1.6 矩陣與矩陣乘法

在圖學，我們用矩陣「一次描述一組變換」。常見尺寸：

- `2x2 / 3x3`：2D 變換（含旋轉、縮放）
- `4x4`：3D 變換（含平移、透視），是圖學最常見的主角

### 矩陣 × 向量 = 變換後的向量

```text
       | m00 m01 |   | x |   | m00*x + m01*y |
M·v =  | m10 m11 | · | y | = | m10*x + m11*y |
```

### column-major（WebGPU / WGSL 慣例，務必記住）

WGSL 的 `mat4x4<f32>` 以及多數 GPU 數學庫（如 glMatrix）都用 **column-major（行優先儲存為欄）**：

- 一個 `mat4` 存成長度 16 的陣列
- **前 4 個數字是第 1 欄，不是第 1 列**
- shader 裡 `M * v` 把 `v` 當「欄向量」右乘

這一點如果搞錯，畫面通常會整個歪掉或全黑。本課與 G2/G3 的程式都採 column-major。

---

## G1.7 變換矩陣：Scale / Rotate / Translate

### 縮放（Scale）

```text
| sx  0 |
|  0 sy |
```

### 旋轉（Rotation，逆時針 θ）

```text
| cosθ  -sinθ |
| sinθ   cosθ |
```

### 平移（Translation）—— 為什麼需要「齊次座標」？

問題來了：**平移沒辦法只用 2x2 矩陣乘法表示**（矩陣乘法只能做線性變換，過原點）。

解法是「升一個維度」：把 2D 點寫成 `(x, y, 1)`，用 3x3 矩陣：

```text
| 1 0 tx |   | x |   | x + tx |
| 0 1 ty | · | y | = | y + ty |
| 0 0  1 |   | 1 |   |   1    |
```

這個多出來的分量叫 **w**（齊次座標）。同理，3D 就用 4x4 矩陣搭配 `(x, y, z, 1)`。

- `w = 1`：這是**位置**（會被平移影響）
- `w = 0`：這是**方向**（平移對它無效，只受旋轉/縮放影響）

> 這也是為什麼 shader 裡位置寫 `vec4f(pos, 1.0)`、方向/法線寫 `vec4f(dir, 0.0)`。

---

## G1.8 變換的組合順序（很容易踩雷）

多個變換用矩陣相乘串起來，但**順序會影響結果**（矩陣乘法不可交換）：

```text
M = T · R · S      （先縮放，再旋轉，最後平移）
p' = M · p = T · (R · (S · p))
```

閱讀技巧：**離向量最近的先作用**。上式對 `p` 而言是「先 S、再 R、再 T」。
順序反過來（例如先平移再旋轉），物體會繞著錯誤的中心亂轉——這是新手最常見的 bug。

---

## G1.9 本週作業規格

用一個純 JS + Canvas2D 的互動頁面，把上面觀念「看得見」。

### 必做

- 兩個可調向量 `a`、`b`（用 slider 調 x/y）
- 即時顯示：`a · b`、外積 z 分量 `a × b`、夾角（度）
- 一個方塊套用 **Scale → Rotate → Translate** 的 2D 變換（3x3 齊次矩陣），參數可調

### 驗收

- 調整向量時，點積/外積/夾角即時更新且數值正確
- 調整變換參數時，方塊即時變形/旋轉/位移
- 你能講出：為什麼點積能判斷夾角、外積 z 的正負代表什麼、平移為何要 3x3

---

## G1.10 常見錯誤

- **角度單位搞混**：`Math.cos/sin` 吃的是弧度（radian），slider 給度數時要 `deg * Math.PI / 180`。
- **忘記正規化就做點積判夾角**：`a · b = cos(θ)` 只有在兩者都是單位向量時成立。
- **變換順序寫反**：矩陣相乘順序 = 作用順序的相反，先想清楚「誰先作用」。
- **column-major / row-major 混用**：自己的公式與 GPU 庫一定要一致。

---

## G1.11 本章小結

- 你已建立圖學向的向量直覺：位置 vs 方向、長度與正規化
- 你懂了點積（夾角/光照）、外積（法線/座標系）
- 你懂了 4x4 + 齊次座標為何是 3D 圖學的主角
- 你能正確組合 Scale/Rotate/Translate ——這正是 G2 的 Model 矩陣

---

## G1.12 本課實作成品代碼（完整）

### 檔案結構

```text
graphics-01-linear-algebra/
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
    <title>Graphics 01 - Linear Algebra Playground</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="container">
      <h1>Graphics 01：向量 · 點積 · 外積 · 2D 變換</h1>
      <p class="subtitle">用看得見的方式理解圖學線性代數。</p>

      <section class="grid">
        <div class="panel">
          <h2>Vectors</h2>
          <div class="ctrl">
            <label>a.x <input id="ax" type="range" min="-2" max="2" step="0.05" value="1.2" /></label>
            <label>a.y <input id="ay" type="range" min="-2" max="2" step="0.05" value="0.4" /></label>
            <label>b.x <input id="bx" type="range" min="-2" max="2" step="0.05" value="0.3" /></label>
            <label>b.y <input id="by" type="range" min="-2" max="2" step="0.05" value="1.3" /></label>
          </div>
          <div id="vecInfo" class="info">—</div>
        </div>

        <div class="panel">
          <h2>2D Transform（S → R → T）</h2>
          <div class="ctrl">
            <label>scaleX <input id="sx" type="range" min="0.2" max="2" step="0.05" value="1" /></label>
            <label>scaleY <input id="sy" type="range" min="0.2" max="2" step="0.05" value="1" /></label>
            <label>rotate° <input id="rot" type="range" min="-180" max="180" step="1" value="25" /></label>
            <label>transX <input id="tx" type="range" min="-2" max="2" step="0.05" value="0.4" /></label>
            <label>transY <input id="ty" type="range" min="-2" max="2" step="0.05" value="0.2" /></label>
          </div>
          <div id="matInfo" class="info">—</div>
        </div>
      </section>

      <section class="panel canvas-panel">
        <canvas id="c" width="900" height="480"></canvas>
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

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 14px;
}

@media (max-width: 720px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.panel {
  background: #151a31;
  border: 1px solid #2d3963;
  border-radius: 10px;
  padding: 14px;
}

.canvas-panel {
  margin-top: 14px;
  padding: 8px;
}

h2 {
  margin: 0 0 10px;
  font-size: 16px;
}

.ctrl {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

label {
  display: grid;
  grid-template-columns: 70px 1fr;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

input[type="range"] {
  width: 100%;
}

.info {
  margin-top: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.7;
  color: #c9d6ff;
  white-space: pre-wrap;
}

#c {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 8px;
  border: 1px solid #34457a;
  background: #090d18;
}
```

### `app.js`

```javascript
// ---- 迷你向量工具（圖學向） ----
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  scale: (a, s) => [a[0] * s, a[1] * s],
  len: (a) => Math.hypot(a[0], a[1]),
  normalize(a) {
    const l = V.len(a);
    return l > 1e-8 ? [a[0] / l, a[1] / l] : [0, 0];
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1],
  // 2D 外積回傳 z 分量（純量）
  cross: (a, b) => a[0] * b[1] - a[1] * b[0],
};

// ---- 3x3 齊次矩陣（column-major，對齊 GPU 慣例） ----
// 存成 [m00,m10,m20, m01,m11,m21, m02,m12,m22]
const M3 = {
  identity: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  multiply(a, b) {
    const o = new Array(9).fill(0);
    for (let c = 0; c < 3; c += 1) {
      for (let r = 0; r < 3; r += 1) {
        let s = 0;
        for (let k = 0; k < 3; k += 1) {
          s += a[k * 3 + r] * b[c * 3 + k];
        }
        o[c * 3 + r] = s;
      }
    }
    return o;
  },
  scaling: (sx, sy) => [sx, 0, 0, 0, sy, 0, 0, 0, 1],
  rotation(rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return [c, s, 0, -s, c, 0, 0, 0, 1];
  },
  translation: (tx, ty) => [1, 0, 0, 0, 1, 0, tx, ty, 1],
  // 對 (x, y, 1) 做變換
  apply(m, p) {
    const x = m[0] * p[0] + m[3] * p[1] + m[6];
    const y = m[1] * p[0] + m[4] * p[1] + m[7];
    return [x, y];
  },
};

const $ = (id) => document.querySelector(id);
const canvas = $("#c");
const ctx = canvas.getContext("2d");
const vecInfo = $("#vecInfo");
const matInfo = $("#matInfo");

const inputs = ["ax", "ay", "bx", "by", "sx", "sy", "rot", "tx", "ty"].map($);
inputs.forEach((el) => el.addEventListener("input", draw));

function toScreen(p, cx, cy, unit) {
  // 世界 y 向上 → 螢幕 y 向下
  return [cx + p[0] * unit, cy - p[1] * unit];
}

function drawArrow(from, to, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();

  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const head = 12;
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - head * Math.cos(ang - 0.4), to[1] - head * Math.sin(ang - 0.4));
  ctx.lineTo(to[0] - head * Math.cos(ang + 0.4), to[1] - head * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
}

function drawGrid(cx, cy, unit) {
  ctx.strokeStyle = "#1d2745";
  ctx.lineWidth = 1;
  for (let gx = -8; gx <= 8; gx += 1) {
    ctx.beginPath();
    ctx.moveTo(cx + gx * unit, 0);
    ctx.lineTo(cx + gx * unit, canvas.height);
    ctx.stroke();
  }
  for (let gy = -8; gy <= 8; gy += 1) {
    ctx.beginPath();
    ctx.moveTo(0, cy + gy * unit);
    ctx.lineTo(canvas.width, cy + gy * unit);
    ctx.stroke();
  }
  ctx.strokeStyle = "#3a4a80";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(canvas.width, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, canvas.height);
  ctx.stroke();
}

function draw() {
  const a = [Number($("#ax").value), Number($("#ay").value)];
  const b = [Number($("#bx").value), Number($("#by").value)];

  const sx = Number($("#sx").value);
  const sy = Number($("#sy").value);
  const rot = (Number($("#rot").value) * Math.PI) / 180;
  const tx = Number($("#tx").value);
  const ty = Number($("#ty").value);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.5;
  const unit = 90;

  drawGrid(cx, cy, unit);

  // 向量
  const origin = toScreen([0, 0], cx, cy, unit);
  drawArrow(origin, toScreen(a, cx, cy, unit), "#4f8bff");
  drawArrow(origin, toScreen(b, cx, cy, unit), "#ff8f4f");

  // 點積 / 外積 / 夾角
  const dot = V.dot(a, b);
  const crossZ = V.cross(a, b);
  const na = V.normalize(a);
  const nb = V.normalize(b);
  const cosT = Math.max(-1, Math.min(1, V.dot(na, nb)));
  const deg = (Math.acos(cosT) * 180) / Math.PI;

  vecInfo.textContent =
    `a = (${a[0].toFixed(2)}, ${a[1].toFixed(2)})   |a| = ${V.len(a).toFixed(3)}\n` +
    `b = (${b[0].toFixed(2)}, ${b[1].toFixed(2)})   |b| = ${V.len(b).toFixed(3)}\n` +
    `a · b = ${dot.toFixed(3)}   (>0 同向, 0 垂直, <0 反向)\n` +
    `a × b (z) = ${crossZ.toFixed(3)}   (>0 逆時針, <0 順時針)\n` +
    `夾角 θ = ${deg.toFixed(1)}°`;

  // 2D 變換：M = T · R · S（離向量最近的 S 先作用）
  const S = M3.scaling(sx, sy);
  const R = M3.rotation(rot);
  const T = M3.translation(tx, ty);
  const M = M3.multiply(T, M3.multiply(R, S));

  const unitSquare = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];

  // 原始方塊（灰）
  ctx.strokeStyle = "#556089";
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  unitSquare.forEach((p, i) => {
    const sp = toScreen(p, cx, cy, unit);
    if (i === 0) ctx.moveTo(sp[0], sp[1]);
    else ctx.lineTo(sp[0], sp[1]);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // 變換後方塊（綠）
  ctx.strokeStyle = "#57e39a";
  ctx.fillStyle = "rgba(87, 227, 154, 0.12)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  unitSquare.forEach((p, i) => {
    const tp = M3.apply(M, p);
    const sp = toScreen(tp, cx, cy, unit);
    if (i === 0) ctx.moveTo(sp[0], sp[1]);
    else ctx.lineTo(sp[0], sp[1]);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  matInfo.textContent =
    `M = T · R · S（column-major）\n` +
    `[ ${M[0].toFixed(2)}  ${M[3].toFixed(2)}  ${M[6].toFixed(2)} ]\n` +
    `[ ${M[1].toFixed(2)}  ${M[4].toFixed(2)}  ${M[7].toFixed(2)} ]\n` +
    `[ ${M[2].toFixed(2)}  ${M[5].toFixed(2)}  ${M[8].toFixed(2)} ]`;
}

draw();
```

---

> 下一課：[G2：3D 變換與相機（MVP / 透視投影 / 深度測試）](./g02-3d-transforms-and-camera.md)
