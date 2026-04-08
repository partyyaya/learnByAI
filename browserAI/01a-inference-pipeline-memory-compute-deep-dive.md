# 01A 補充：模型推論流程與記憶體/計算深度解析

> 搭配主課：[`01-js-ts-math-foundations.md`](./01-js-ts-math-foundations.md)

這份補充文件要回答一個核心問題：  
**為什麼同樣是「做推論」，有些實作快很多，有些實作慢很多？**

短答案是：推論不是只有算術，還有大量資料搬運。  
如果資料布局、訪問順序、暫存策略不對，速度會在 CPU/GPU 還沒滿載前就掉下來。

---

## 1. 先有整體圖：一次推論在做什麼？

可以先把端到端時間拆成：

```text
總延遲 = 前處理 + 張量轉換 + 核心算子(Linear/Conv/Attention...) + 後處理 + 資料搬運同步成本
```

在瀏覽器場景，常見情況是：

- 小模型：前處理與資料搬運可能占很大比例
- 大模型：核心算子時間占比升高，但搬運仍是關鍵瓶頸
- 實務優化：通常要「算子優化 + 減少 copy + 避免不必要同步」一起做

---

## 2. 前處理（Preprocess）：常被低估的成本

典型工作：

- 讀取影像（常見為 RGBA，`Uint8ClampedArray`）
- resize / crop
- normalize（例如除以 `255`，或做 mean/std 標準化）
- 轉成模型輸入 dtype（常見 `float32`）

### 常見陷阱

- 每一步都建立新陣列，造成大量暫存與 GC 壓力
- 先轉型再轉布局，做了兩次完整 memory pass
- 在 loop 內頻繁建立小物件（隱性分配）

### 範例：單次 pass 轉成 NCHW `Float32Array`

```js
function preprocessRGBAtoNCHW(rgba, width, height) {
  const hw = width * height;
  const out = new Float32Array(3 * hw);

  const rBase = 0;
  const gBase = hw;
  const bBase = 2 * hw;

  for (let i = 0, p = 0; i < hw; i++, p += 4) {
    out[rBase + i] = rgba[p] / 255;     // R
    out[gBase + i] = rgba[p + 1] / 255; // G
    out[bBase + i] = rgba[p + 2] / 255; // B
  }

  return out;
}
```

重點不是語法，而是「一次走訪完成多件事」，減少重複掃描與暫存陣列。

---

## 3. 張量轉換（Layout Transform）：索引公式決定速度

常見布局：

- NHWC：`[batch, height, width, channel]`
- NCHW：`[batch, channel, height, width]`

當模型或後端要求不同布局時，就必須重排資料。  
重排本身通常是 `O(N)`，但它會完整走訪整個張量，資料量大時成本顯著。

### 索引直覺（以 batch = 1 為例）

- NHWC 線性 index：`((h * W + w) * C + c)`
- NCHW 線性 index：`((c * H + h) * W + w)`

### 範例：NHWC -> NCHW

```js
function nhwcToNchw(src, H, W, C) {
  const dst = new Float32Array(H * W * C);
  for (let h = 0; h < H; h++) {
    for (let w = 0; w < W; w++) {
      for (let c = 0; c < C; c++) {
        const srcIdx = ((h * W + w) * C + c);
        const dstIdx = ((c * H + h) * W + w);
        dst[dstIdx] = src[srcIdx];
      }
    }
  }
  return dst;
}
```

---

## 4. 線性層（Linear / GEMM）：同樣 `O(n^3)` 也可能差很多

線性層核心：

```text
Y = XW + b
```

把它展開後就是矩陣乘法（GEMM）。  
你在主課做的 `i-j-k`、`i-k-j`、blocked 實作，正是這個核心的 CPU 視角。

### 為什麼 loop 順序很重要？

- 演算法複雜度不變，但記憶體訪問模式改變
- cache 命中率與資料重用率不同
- 同一套公式，實測可差數倍

這也是「只看 Big-O 不夠」的典型案例。

---

## 5. 卷積（Convolution）：乘加很多，搬運也很多

2D 卷積可視為「滑動視窗 + dot product」，輸出尺寸（不含 dilation）：

```text
H_out = floor((H + 2P - K_h) / S) + 1
W_out = floor((W + 2P - K_w) / S) + 1
```

卷積的效能常受兩件事支配：

- 運算量（乘加次數）
- 記憶體頻寬（特別是特徵圖很大時）

實務中常見策略：

- 透過更好的布局提升連續讀取比例
- 利用 block/tile 提高資料重用
- 在某些實作使用 `im2col + GEMM`，把問題轉成優化成熟的矩陣乘法

---

## 6. Browser 場景特有成本

除了算子本身，還要注意 Web runtime 的額外開銷：

- JS <-> GPU / WASM 邊界搬運
- `ArrayBuffer` / tensor 大量建立與釋放造成 GC 抖動
- 不必要的同步點（例如過早 readback）
- dynamic shape 太多，導致快取與 kernel 重用效果差

簡單說：**資料流設計** 在瀏覽器裡特別重要。

---

## 7. 一份可直接用的優化檢查清單

- 是否使用 `TypedArray` 而非一般 `Array` 儲存主資料？
- 是否把多個前處理步驟合併成較少次 memory pass？
- 是否避免重複 layout 轉換（來回 NHWC/NCHW）？
- 是否固定常見輸入尺寸，降低重建成本？
- 是否避免在熱路徑建立大量暫時物件？
- benchmark 是否把資料生成成本與核心算子成本分開量測？
- 是否有針對主要算子做 warm-up 再正式測量？
- 是否避免不必要 CPU/GPU readback？

---

## 8. 和主課如何對照

- 主課 `1.3`：你會學到 `ArrayBuffer` / `TypedArray`（資料容器）
- 主課 `1.4`：你會學到矩陣乘法與索引（計算骨幹）
- 主課 `1.5`：你會建立 cache-friendly 直覺（效能差異來源）

這三件事加起來，就是你之後看 WebGPU、ONNX Runtime Web、Transformers.js 時最重要的底層語言。

---

## 延伸閱讀

- [`04-buffer-texture-memory.md`](./04-buffer-texture-memory.md)
- [`05-compute-shader-gpgpu.md`](./05-compute-shader-gpgpu.md)
- [`06-webgpu-performance-optimization.md`](./06-webgpu-performance-optimization.md)
