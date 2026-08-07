# 第 17 章：用 GPU 跑 AI —— 從矩陣乘法到神經網路推論

> 這是「wgpu → GPU Compute → AI」進階路線的終點。第 15 章你學會跟 GPU 對話，第 16 章你寫出了矩陣乘法。
> 這一章要揭開一個祕密：**神經網路的推論，本質就是把第 16 章的矩陣乘法、element-wise（激活函數）、歸約（softmax）串成一條鏈**。搞懂這件事，AI 就從「魔法」變成「你已經會的 GPU 運算」。
> 我們會先用第 16 章的 kernel **從零手刻**一個小型神經網路的前向傳播，親眼看到「AI = 一連串矩陣運算」；再認識 Rust 的 AI 生態（**candle / burn / tract / ort**），用成熟框架跑真正的模型；並看到 **wgpu 如何成為 Burn 的跨平台 GPU 後端**（首尾呼應）；最後把 AI 推論**包成第 11 章的 Axum API**，讓它變成能上線的服務。
> 讀完這章，你就打通了「Rust 後端 + GPU + AI」的完整鏈路。

---

## 17.1 學習目標

完成本章後，你應該可以：

- 說清楚「**神經網路推論 = 矩陣乘法 + 加偏置 + 非線性激活**」，破除 AI 的神祕感。
- 解釋為什麼 **AI 這麼吃 GPU**（以及為什麼 matmul 是效能核心）。
- 用第 16 章的 GPU kernel **手刻一個 MLP 前向傳播**（Linear → ReLU → Linear → Softmax）。
- 說出手刻的極限，理解**為什麼實務要用框架**。
- 認識 Rust AI 生態四大主角：**candle、burn、tract、ort（ONNX Runtime）**，並知道各自的定位與選型。
- 用 **candle** 跑張量運算與模型推論（含選 CPU / CUDA / Metal 裝置）。
- 用 **burn + wgpu backend** 跑推論，理解它跟你前兩章所學的關係。
- 把 AI 推論**包進 Axum API**（回扣第 09、11 章），並掌握生產考量：批次化、暖機、模型格式、記憶體。

---

## 17.2 AI 推論的本質：一切都是矩陣運算

先破除神祕感。一個最基本的神經網路——**多層感知機（MLP，Multi-Layer Perceptron）**——的推論（inference，也就是「拿訓練好的模型做預測」）長這樣。這裡用「一個隱藏層」的 MLP 當最小例子：

```text
輸入向量 x
   │
   ▼
[第 1 層]  h1 = ReLU(x · W1 + b1)      ← 矩陣乘法 + 加偏置 + 非線性
   │
   ▼
[輸出層]  y = Softmax(h1 · W2 + b2)    ← 矩陣乘法 + Softmax（歸一成機率）
   │
   ▼
輸出（例如 10 個類別的機率）
```

每一層都是同樣的三個動作：

1. **`x · W`（矩陣乘法）**：輸入乘上這一層的「權重矩陣」。這是**第 16 章的 matmul**。也是整個推論最花時間的部分。
2. **`+ b`（加偏置）**：加上一個偏置向量。這是**第 16 章的 element-wise 向量加法**。
3. **非線性激活**（ReLU / Softmax 等）：對每個元素做一個非線性函式。ReLU 就是 `max(x, 0)`——**第 16 章的 element-wise**；Softmax 要用到**第 16 章的歸約**（求和/求最大）。

> **核心洞見**：所謂「訓練好的 AI 模型」，拆開來就是**一堆矩陣（權重 W）和向量（偏置 b）的數字**。推論就是拿你的輸入，依序跟這些矩陣做乘法、加法、套非線性函式。**沒有魔法——全是你第 16 章已經會寫的 GPU 運算。** 差別只在：真實模型的矩陣很大（動輒上萬×上萬）、層數很多（幾十到上百層），所以需要 GPU 的暴力平行才跑得動。

> **推論 vs 訓練**：**訓練**是「用大量資料反覆調整那些 W 和 b 的數字」（需要反向傳播、梯度計算，運算量巨大，通常在多張高階 GPU 上跑數天）。**推論**是「W、b 都固定了，只做上面那條前向鏈算出答案」。**本課只談推論**——這是後端工程師最常碰到的（載入別人訓練好的模型，對外提供預測服務）。訓練是另一個大主題，超出本課範圍。

---

## 17.3 為什麼 AI 離不開 GPU

現在你能理解為什麼 AI 熱潮 = GPU 熱潮了：

- **模型的核心運算是 matmul**，而 matmul 是**高度資料平行**的（第 16 章：C 的每一格獨立、派一執行緒算一格）——這正是 GPU 的主場。
- **矩陣巨大**：一個中型語言模型，單層權重矩陣可能是 4096×4096＝1600 萬個數，一次前向要做上百次這種乘法。CPU 的少數核心算到天荒地老，GPU 的上千核心才扛得住。
- **運算密集、傳輸相對少**：模型權重上傳一次後，反覆用於大量輸入——計算/傳輸比高，完美契合第 16 章「攤平傳輸成本」的甜蜜點。

```text
   一次矩陣乘法 4096×4096
   ┌─────────────────────────────────┐
CPU │ 8 核心輪流算 1600 萬格… 慢         │
   └─────────────────────────────────┘
   ┌─────────────────────────────────┐
GPU │ 數千核心同時開算… 快數十~數百倍     │
   └─────────────────────────────────┘
```

> **一句話**：AI 之所以在這十年爆發，硬體上的關鍵就是「**把 matmul 丟給 GPU 平行做**」。你在第 16 章手寫的那個 matmul kernel，放大幾千倍、串上百層，就是 ChatGPT 底層每一次推論在做的事的縮影。

> **除了 GPU**：也有專為 AI 設計的晶片（Google TPU、Apple Neural Engine、各種 NPU），原理類似——大量平行的乘加單元。GPU 是目前最通用、生態最成熟的選擇，而 wgpu 讓你能用同一套程式碼觸及各家 GPU。

---

## 17.4 從零手刻：用 GPU kernel 組一個 MLP 前向傳播

理論講完，動手把 17.2 的鏈用第 16 章的 kernel 拼出來。我們做一個超小的 MLP：輸入 4 維 → 隱藏層 8 維（ReLU）→ 輸出 3 類（Softmax）。雖然小，但**麻雀雖小五臟俱全**，真實模型只是「更大、更多層」。

### 需要的 WGSL kernel

**(1) Linear 層 = matmul + bias**（把偏置加法融進 matmul kernel，省一次來回）：

```wgsl
// y = x · W + b
// x: [batch, in]，W: [in, out]，b: [out]，y: [batch, out]
struct Dims { batch: u32, in_dim: u32, out_dim: u32, _pad: u32 }

@group(0) @binding(0) var<uniform>             d: Dims;
@group(0) @binding(1) var<storage, read>       x: array<f32>;
@group(0) @binding(2) var<storage, read>       w: array<f32>;
@group(0) @binding(3) var<storage, read>       bias: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;

@compute @workgroup_size(16, 16)
fn linear(@builtin(global_invocation_id) gid: vec3<u32>) {
    let row = gid.y;   // 第幾筆輸入（batch 內）
    let col = gid.x;   // 第幾個輸出神經元
    if (row >= d.batch || col >= d.out_dim) { return; }

    var sum = bias[col];                       // 直接從偏置開始累加
    for (var k = 0u; k < d.in_dim; k = k + 1u) {
        sum = sum + x[row * d.in_dim + k] * w[k * d.out_dim + col];
    }
    y[row * d.out_dim + col] = sum;            // 尚未套激活
}
```

**(2) ReLU 激活 = element-wise `max(x, 0)`**：

```wgsl
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(64)
fn relu(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&data)) { return; }
    data[i] = max(data[i], 0.0);               // 就這麼簡單
}
```

**(3) Softmax = 歸約（求 max 與求 sum）+ element-wise**。Softmax 把一排數字轉成「和為 1 的機率」：`softmax(z)_i = exp(z_i - max) / Σ exp(z_j - max)`（減 max 是為了數值穩定，避免 `exp` 爆掉）。這裡每一列獨立做，示範一列一個執行緒的簡化版：

```wgsl
struct SmDims { rows: u32, cols: u32, _pad0: u32, _pad1: u32 }
@group(0) @binding(0) var<uniform>             d: SmDims;
@group(0) @binding(1) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(64)
fn softmax(@builtin(global_invocation_id) gid: vec3<u32>) {
    let row = gid.x;
    if (row >= d.rows) { return; }
    let base = row * d.cols;

    // 1. 求這一列的 max（歸約，數值穩定用）
    var m = data[base];
    for (var j = 1u; j < d.cols; j = j + 1u) { m = max(m, data[base + j]); }

    // 2. 算 exp 並求和（歸約）
    var sum = 0.0;
    for (var j = 0u; j < d.cols; j = j + 1u) {
        let e = exp(data[base + j] - m);
        data[base + j] = e;
        sum = sum + e;
    }

    // 3. 除以總和 → 機率（element-wise）
    for (var j = 0u; j < d.cols; j = j + 1u) { data[base + j] = data[base + j] / sum; }
}
```

> 這個 softmax 是「一列一執行緒」的簡化版（類別數少時夠用）。類別數很多時，會像第 16 章那樣用 workgroup 內的平行歸約來加速——**你已經有工具了**。

### 主機端把三個 kernel 串成前向傳播

關鍵是實踐第 16.11 節的「**資料上傳一次，所有層在 GPU 上連續 dispatch，最後才讀回**」：

```rust
// 用第 16 章的 GpuContext（含 run / storage_from_slice / empty_storage / read_buffer）
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Dims { batch: u32, in_dim: u32, out_dim: u32, _pad: u32 }

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct SmDims { rows: u32, cols: u32, _pad0: u32, _pad1: u32 }

struct ModelWeights {
    w1: Vec<f32>, b1: Vec<f32>, // [4, 8], [8]
    w2: Vec<f32>, b2: Vec<f32>, // [8, 3], [3]
}

fn make_dims_uniform(gpu: &GpuContext, batch: u32, in_dim: u32, out_dim: u32) -> wgpu::Buffer {
    gpu.uniform_from_pod(&Dims { batch, in_dim, out_dim, _pad: 0 })
}

fn make_softmax_dims(gpu: &GpuContext, rows: u32, cols: u32) -> wgpu::Buffer {
    gpu.uniform_from_pod(&SmDims { rows, cols, _pad0: 0, _pad1: 0 })
}

// 把上面的三段 WGSL 分別存成 src/linear.wgsl、src/relu.wgsl、src/softmax.wgsl。
const LINEAR_WGSL: &str = include_str!("linear.wgsl");
const RELU_WGSL: &str = include_str!("relu.wgsl");
const SOFTMAX_WGSL: &str = include_str!("softmax.wgsl");

fn mlp_forward(gpu: &GpuContext, input: &[f32], weights: &ModelWeights) -> Vec<f32> {
    let batch = 1u32;

    // 權重與輸入上傳 GPU（推論期間權重固定，實務上只上傳一次、重複用）
    let x   = gpu.storage_from_slice(input);          // [1, 4]
    let w1  = gpu.storage_from_slice(&weights.w1);    // [4, 8]
    let b1  = gpu.storage_from_slice(&weights.b1);    // [8]
    let w2  = gpu.storage_from_slice(&weights.w2);    // [8, 3]
    let b2  = gpu.storage_from_slice(&weights.b2);    // [3]

    let h1 = gpu.empty_storage(8 * 4);                // [1, 8]
    let out = gpu.empty_storage(3 * 4);               // [1, 3]

    // 第 1 層：h1 = x · W1 + b1
    let d1 = make_dims_uniform(gpu, batch, 4, 8);
    gpu.run(LINEAR_WGSL, "linear", &[&d1, &x, &w1, &b1, &h1],
            (8u32.div_ceil(16), batch.div_ceil(16), 1));
    // ReLU(h1)
    gpu.run(RELU_WGSL, "relu", &[&h1], ((batch * 8).div_ceil(64), 1, 1));

    // 輸出層：out = h1 · W2 + b2
    let d2 = make_dims_uniform(gpu, batch, 8, 3);
    gpu.run(LINEAR_WGSL, "linear", &[&d2, &h1, &w2, &b2, &out],
            (3u32.div_ceil(16), batch.div_ceil(16), 1));
    // Softmax(out)
    let sd = make_softmax_dims(gpu, batch, 3);
    gpu.run(SOFTMAX_WGSL, "softmax", &[&sd, &out], (batch.div_ceil(64), 1, 1));

    // 最後才讀回結果（3 個類別的機率）
    gpu.read_buffer::<f32>(&out, 3)
}
```

跑起來，你會拿到 3 個加總為 1 的機率——**這就是一次完整的神經網路推論，而它完全由你第 16 章寫的 matmul / element-wise / 歸約組成。**

```text
輸入 [0.5, -1.2, 0.3, 0.8]
  → Linear(4→8) → ReLU → Linear(8→3) → Softmax
  → 輸出 [0.71, 0.22, 0.07]（三類的機率，和為 1；最大者 = 預測類別 0）
```

> **這一節的價值**：你親眼看到 AI 推論「就是一串 GPU 運算」，再也不會覺得它是黑魔法。同時你也體會到——**手刻很累**：每加一種層（卷積、attention、normalization…）就要寫一個 kernel、管一堆 buffer 與維度。真實模型有幾十種運算、上百層，手刻不現實。這自然帶出下一節：**用框架**。

---

## 17.5 手刻的極限：為什麼要用框架

自己用 wgpu 刻推論，你會很快撞到這些牆：

- **運算種類爆炸**：現代模型用到卷積、注意力（attention）、各種 normalization、多種激活……每個都要手寫 kernel 並調優。
- **模型載入**：模型檔（`.safetensors`、`.onnx`、`.gguf`）有各自的格式，要自己解析權重、對應到你的 buffer。
- **效能地獄**：naive kernel 比不上高度優化的（tiled matmul、kernel 融合、量化）；追平專家調優的 kernel 是全職工作。
- **正確性**：數值穩定（如 softmax 減 max）、資料佈局、邊界，處處是坑。

所以**除非你在做研究或極致優化，實務上一律用框架**。框架已經把上面全部處理好：優化過的 kernel、模型載入、多後端支援。你只要「載入模型 → 丟輸入 → 拿輸出」。

> **類比後端**：這就像第 11 章你不會自己刻 HTTP 解析、而是用 Axum；第 10 章不會自己寫 TCP 連 PostgreSQL、而是用 SQLx。AI 也一樣——**站在框架的肩膀上**，把心力放在「把模型變成好用的服務」（你的後端強項）而非「重造推論引擎」。

---

## 17.6 Rust AI 生態全景

Rust 的 AI 推論生態這幾年成熟很多，四個主角要認識：

| 框架 | 定位 | 後端 / 加速 | 適合場景 |
|---|---|---|---|
| **candle**（Hugging Face） | 極簡、輕量的張量與推論框架 | CPU / CUDA / Metal | 想用純 Rust 跑 LLM、影像模型；追求小體積、快啟動 |
| **burn** | 功能完整的深度學習框架（能訓練也能推論） | **wgpu** / CUDA / Metal / ndarray / LibTorch | 想要跨平台 GPU（靠 wgpu！）、型別安全、彈性後端 |
| **tract**（Sonos） | 純 Rust 的 ONNX / TF 推論引擎 | CPU（主打） | 嵌入式、邊緣裝置、只要 CPU 推論、無外部相依 |
| **ort** | ONNX Runtime 的 Rust 綁定 | CPU / CUDA / TensorRT / CoreML… | 已有 ONNX 模型、要用微軟成熟的高效能執行環境 |

選型直覺：

- **有 ONNX 模型、要 CPU 且純 Rust 無相依** → `tract`。
- **有 ONNX 模型、要榨乾各種硬體加速** → `ort`（綁 ONNX Runtime，功能最全但需相依原生庫）。
- **想用 Hugging Face 上的模型、純 Rust、輕量** → `candle`。
- **想要跨平台 GPU（Windows/Mac/Linux 甚至瀏覽器）且不想被 CUDA 綁死** → `burn` 配 **wgpu 後端**——這正好接上你前兩章學的 wgpu。

> **模型從哪來？** 後端工程師通常**不自己訓練**，而是拿現成模型：Hugging Face Hub 上海量的開源模型、或資料團隊訓練後匯出的檔案。常見格式：**`.safetensors`**（安全、快，Hugging Face 主推）、**`.onnx`**（跨框架交換標準）、**`.gguf`**（llama.cpp 系的量化 LLM 格式）。你的工作是「載入它、包成服務」。

---

## 17.7 用 candle 跑推論

`candle` 是體驗「Rust 做 AI」最快的方式，API 很像 PyTorch。加依賴：

```bash
cargo add candle-core
# 選配加速後端：
# cargo add candle-core --features cuda     # NVIDIA GPU
# cargo add candle-core --features metal    # Apple GPU
cargo add candle-nn                          # 神經網路層（Linear、activation…）
```

### 張量與裝置：選 CPU / CUDA / Metal

```rust
use candle_core::{Device, Tensor, DType};

fn main() -> candle_core::Result<()> {
    // 自動選最佳裝置：有 CUDA 用 CUDA，否則退回 CPU（Mac 可用 Device::new_metal(0)）
    let device = Device::cuda_if_available(0)?;
    println!("使用裝置：{:?}", device);

    // 建立張量（tensor 就是多維陣列，AI 的基本資料型別）
    let a = Tensor::randn(0f32, 1.0, (2, 3), &device)?;   // 2×3 隨機矩陣
    let b = Tensor::randn(0f32, 1.0, (3, 4), &device)?;   // 3×4

    // 矩陣乘法（就是你第 16 章手刻的那個，只是 candle 用優化過的 kernel）
    let c = a.matmul(&b)?;                                // 2×4
    println!("結果形狀：{:?}", c.shape());

    // element-wise 與激活（就是第 16 章的 element-wise）
    let relu = c.relu()?;
    let _ = relu;
    Ok(())
}
```

> **對照你手刻的**：`a.matmul(&b)` 就是第 16 章的 matmul kernel、`.relu()` 就是 17.4 的 ReLU kernel——candle 幫你用高度優化的實作做掉了，還自動選對裝置。**你手刻過，所以你知道它底下在幹嘛。**

### 手刻 MLP 的 candle 版（對照 17.4）

同樣的 MLP，用 candle 幾行就完成，且自動在 GPU 上跑：

```rust
use candle_core::{Device, Tensor};
use candle_nn::{Linear, Module, VarBuilder, VarMap};

fn mlp_forward(x: &Tensor, l1: &Linear, l2: &Linear) -> candle_core::Result<Tensor> {
    let h = l1.forward(x)?.relu()?;          // Linear + ReLU（= 17.4 的第 1 層）
    let logits = l2.forward(&h)?;            // Linear（= 17.4 的輸出層）
    candle_nn::ops::softmax(&logits, 1)      // Softmax（= 17.4 的 softmax kernel）
}
```

對照 17.4 那一大段手刻 WGSL + buffer 管理——**同一件事，框架讓你聚焦在「網路結構」而非「GPU 細節」**。

### 載入真實模型（safetensors）

實務是載入訓練好的權重，而非隨機初始化：

```rust
use candle_core::{Device, DType};
use candle_nn::VarBuilder;

let device = Device::cuda_if_available(0)?;
// 從 safetensors 檔載入權重（mmap，省記憶體）
let vb = unsafe {
    VarBuilder::from_mmaped_safetensors(&["model.safetensors"], DType::F32, &device)?
};
// 之後用 vb 建構模型各層（層名要對應 safetensors 裡的張量名）
// let l1 = candle_nn::linear(4, 8, vb.pp("layer1"))?;
```

這裡的 `unsafe` 來自 memory-mapped file：candle 會把檔案映射到記憶體並假設檔案在使用期間不被外部修改或截斷。正式服務通常在啟動時載入不可變的模型檔，滿足這個前提；若不想碰 `unsafe`，可改用讀入記憶體的載入 API（代價是多一份記憶體）。

> candle 的 `candle-transformers` 還內建了很多知名模型（LLaMA、Whisper、Stable Diffusion 等）的實作，可以直接載入權重跑——非常適合「拿開源模型做服務」。

---

## 17.8 用 burn + wgpu 後端（首尾呼應）

還記得第 15 章說「連 AI 框架都用 wgpu 當跨平台 GPU 後端」嗎？**Burn** 就是最好的例子。它的殺手級特性是**後端可抽換**——同一份模型程式碼，換個型別參數就能跑在不同硬體上，其中 **wgpu 後端**讓你的 AI 在 Windows(DX12)、Mac(Metal)、Linux(Vulkan) 甚至瀏覽器上都能用 GPU 跑，**不被 CUDA 綁死**。

```bash
cargo add burn --features wgpu
```

```rust
use burn::backend::wgpu::{Wgpu, WgpuDevice};
use burn::tensor::Tensor;

// 關鍵：後端選 Wgpu —— 概念上走的是第 15、16 章那套 GPU compute 管線。
type Backend = Wgpu;

fn main() {
    let device = WgpuDevice::default();

    // 建立張量，運算會被派發到 wgpu → 你的 GPU
    let a = Tensor::<Backend, 2>::random([2, 3], burn::tensor::Distribution::Default, &device);
    let b = Tensor::<Backend, 2>::random([3, 4], burn::tensor::Distribution::Default, &device);

    let c = a.matmul(b);      // 這個 matmul 最終由 wgpu 送到 GPU 執行
    println!("{:?}", c.shape());
}
```

> **首尾呼應的時刻**：你在第 15、16 章手寫的 buffer、dispatch、資料留在 GPU 上連續運算，正是 Burn wgpu 後端背後的共同 GPU compute 心智模型。不過 Burn 不是直接使用你手寫的 WGSL pipeline；現代 Burn 透過 **CubeCL** 產生與最佳化 kernel（例如 operator fusion），再派發到 wgpu/CUDA 等後端。你不是「學了 wgpu 然後用不到」，而是「因為學過 wgpu，所以你理解框架為何要這樣組織張量、kernel 與資料搬運」。這就是這條學習路線的設計用意：**先懂底層，再站上框架**。

> **burn vs candle 一句話**：candle 更輕、更像 PyTorch、CUDA/Metal 直連；burn 更完整（含訓練）、後端更多元、**wgpu 讓它跨平台 GPU 無敵**。要跨平台 GPU 或想在瀏覽器/邊緣裝置跑，burn+wgpu 是獨門優勢。版本 API 會演進，實作時對照官方文件。

---

## 17.9 把 AI 推論包成 Axum API（回扣第 09、11 章）

會跑推論還不夠——後端工程師的價值是**把它變成能上線的服務**。現在把整個課程縫起來：用第 11 章的 Axum，把模型推論包成一個 REST API。

**架構決策（回扣第 09 章）**：模型只該**載入一次**，放進第 11 章的 `AppState` 共享給所有請求。載入模型很慢（讀檔、搬上 GPU），若每個請求都重載會慢到不可用。

```rust
use std::sync::Arc;
use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};

// 你的模型封裝（candle 或 burn 皆可），持有已載入的權重與裝置
struct Model { /* layers, device... */ }
impl Model {
    fn load() -> anyhow::Result<Self> { /* 載入 safetensors、搬上 GPU */ Ok(Model {}) }
    fn predict(&self, features: &[f32]) -> Vec<f32> { /* 前向傳播（17.7/17.8） */ vec![] }
}

// 第 11 章的 AppState：模型放這裡，載入一次、全程共享
#[derive(Clone)]
struct AppState {
    model: Arc<Model>,   // Arc 讓多個請求共享同一份模型（回扣第 07、08 章）
}

#[derive(Deserialize)]
struct PredictRequest { features: Vec<f32> }

#[derive(Serialize)]
struct PredictResponse { probabilities: Vec<f32>, predicted_class: usize }

// 第 11 章的 handler：薄薄一層，翻譯請求 → 呼叫推論 → 組回應
async fn predict(
    State(state): State<AppState>,
    Json(req): Json<PredictRequest>,
) -> Json<PredictResponse> {
    let model = state.model.clone();
    let features = req.features;

    // 關鍵：推論是「CPU/GPU 密集」的同步工作，不要卡住 async runtime！
    // 用 spawn_blocking 丟到專用執行緒池（回扣第 08 章的鐵則）
    let probs = tokio::task::spawn_blocking(move || model.predict(&features))
        .await
        .unwrap();

    let predicted_class = probs
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .map(|(i, _)| i)
        .unwrap_or(0);

    Json(PredictResponse { probabilities: probs, predicted_class })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let state = AppState { model: Arc::new(Model::load()?) };   // 啟動時載入一次

    let app = Router::new()
        .route("/predict", post(predict))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    axum::serve(listener, app).await?;
    Ok(())
}
```

三個把前面章節串起來的重點：

- **模型放 `AppState`、用 `Arc` 共享（第 07、08、11 章）**：載入一次，所有請求共用，絕不每次重載。
- **`spawn_blocking`（第 08、14 章的鐵則）**：推論是**運算密集/會阻塞**的工作，直接在 async handler 裡跑會卡死 Tokio runtime、拖垮並發。丟給 `spawn_blocking` 的專用執行緒池。這正是第 08 章「別在 async 裡做重運算」的實戰。
- **薄 handler（第 11 章）**：handler 只負責「解析請求 → 呼叫推論 → 組回應」，推論邏輯在 `Model` 裡——分層清楚。

> **這就是全課的匯流點**：一個「用 Rust 提供 AI 推論的後端服務」用到了——第 02/07 章的所有權與 `Arc`、第 08 章的 async 與 spawn_blocking、第 09 章的分層與共享狀態、第 11 章的 Axum、以及第 15~17 章的 GPU/AI。你學的每一塊都在這裡各司其職。

---

## 17.10 生產考量：讓 AI 服務真的能上線

把推論包成 API 只是起點，要能扛真實流量還要注意（很多回扣第 14 章）：

- **批次化（batching）**：GPU 最怕「一次只算一筆」——那樣它的上千核心大部分閒著。把短時間內到達的多個請求**湊成一批**（batch）一起餵給 GPU（矩陣的 batch 維度變大），吞吐量可翻數倍。代價是單筆延遲略增，用「最大批次大小 + 最長等待時間」平衡（回扣第 14 章的取捨思維）。
- **暖機（warmup）**：第一次推論常特別慢（pipeline 編譯、記憶體配置、快取未熱）。啟動時先跑幾筆假資料**暖機**，別讓第一個真實使用者當白老鼠。
- **模型格式與量化**：**量化（quantization）** 把權重從 f32 壓成 f16/int8，模型變小、算更快、記憶體省，精度損失通常可接受。LLM 服務幾乎都用量化模型（如 gguf 的 int4）。
- **記憶體管理**：GPU 記憶體有限且珍貴。大模型可能塞不下——要注意模型大小、批次大小對顯存的佔用，OOM 會直接讓服務掛掉。
- **並發與限流（第 14 章）**：GPU 是**單一稀缺資源**，不能讓無限請求同時擠上去。用第 14 章的 **`Semaphore`** 限制同時推論數、用 **bounded channel** 做批次佇列與背壓、過載時 **load shed** 回 503。
- **可觀測性（第 14 章）**：盯推論延遲 p99、GPU 使用率、佇列深度、批次大小、OOM 次數。
- **健康檢查與部署（第 11、13 章）**：`/health` 要確認模型已載入且能推論；容器映像與節點驅動要配合後端選型：candle-CUDA 需要 NVIDIA/CUDA，burn-wgpu 在 Linux 通常走 Vulkan，macOS 走 Metal，`ort` 則取決於你選的 execution provider。

> **架構圖：一個生產級 Rust AI 推論服務**
>
> ```text
> 請求 ──▶ Axum（第 11 章）
>          │ 限流 / 負載卸除（第 14 章：Governor / LoadShed）
>          ▼
>        批次佇列（bounded channel，第 14 章背壓）
>          │ 湊成一批
>          ▼
>        Semaphore 限並發（第 14 章）→ spawn_blocking（第 08 章）
>          ▼
>        模型推論（candle / burn+wgpu，第 15~17 章）在 GPU 上跑
>          ▼
>        回應（機率 / 類別）
> ```
>
> 看懂這張圖，你就把**整門課**串成了一個真實系統——從語言基礎、後端框架、高併發韌性，一路到 GPU 與 AI。

> **務實提醒**：不是每個 AI 服務都需要 GPU。小模型（分類器、embedding）在 CPU 上用 `tract`/`ort`/`candle`-CPU 就夠快又便宜；GPU 是給大模型（LLM、影像生成）用的。**先量測需求，再決定要不要上 GPU**（回扣第 14 章「先量測再優化」）。

---

## 17.11 常見錯誤

- **每個請求都重新載入模型** → 慢到不可用。模型載入一次，放 `AppState` 用 `Arc` 共享（第 11 章）。
- **在 async handler 裡直接做推論** → 阻塞 Tokio runtime、並發崩潰。用 `tokio::task::spawn_blocking`（第 08 章鐵則）。
- **一次只推論一筆、抱怨 GPU 沒比較快** → GPU 要批次化才划算。湊批（batching）餵給它。
- **忘了暖機** → 第一個使用者遇到超慢的冷啟動。啟動時先跑幾筆假資料。
- **softmax 沒減 max** → `exp` 對大數溢位成 `inf`/`NaN`。永遠 `exp(x - max)`（17.4 已示範）。
- **無限請求擠上單一 GPU** → 顯存 OOM 或延遲爆炸。用 `Semaphore` 限並發、bounded channel 排隊（第 14 章）。
- **手刻推論以為能贏框架** → 框架的 kernel 高度優化過。除非研究/特殊需求，用 candle/burn/ort/tract。
- **以為所有 AI 都要 GPU** → 小模型 CPU 就夠。先量測，別為小模型硬上 GPU 增加成本與複雜度。
- **模型維度/佈局跟權重檔對不上** → 輸出全錯。層名、形狀要跟 safetensors/onnx 裡的一致。
- **部署環境沒 GPU 驅動** → 服務起不來或退回 CPU 變超慢。容器映像要含對應驅動，部署機器要有 GPU。

---

## 17.12 本章小結

- **AI 推論的本質 = 一連串矩陣運算**：每層 = `matmul + bias + 非線性激活`。matmul（第 16 章）、bias/ReLU（element-wise）、softmax（歸約）——全是你已經會的 GPU 運算。
- **AI 吃 GPU** 是因為核心運算 matmul 高度資料平行、矩陣巨大、運算密集傳輸少，完美契合 GPU。
- 我們用第 16 章的 kernel **手刻了 MLP 前向傳播**（Linear→ReLU→Linear→Softmax），親證「AI 沒有魔法」；也體會到手刻不可規模化。
- **實務用框架**：candle（輕量、像 PyTorch、CUDA/Metal）、burn（完整、多後端、**wgpu 跨平台 GPU**）、tract（純 Rust CPU、邊緣）、ort（ONNX Runtime、功能最全）。
- **burn 的 wgpu 後端**正是第 15、16 章那套 wgpu——首尾呼應：因為懂底層，才真懂框架。
- **包成 Axum API**（第 11 章）：模型用 `Arc` 放 `AppState` 載入一次、推論用 `spawn_blocking`（第 08 章）不卡 runtime、handler 保持薄（第 09 章）。
- **生產考量**：批次化提升 GPU 吞吐、暖機避免冷啟動、量化省資源、用第 14 章的 Semaphore/背壓/限流保護稀缺的 GPU、盯 p99 與顯存、部署要有 GPU 驅動。
- **先量測再決定要不要上 GPU**——小模型 CPU 就夠。

---

## 17.13 動手作業

1. 用第 16 章的 `GpuContext` 把 17.4 的手刻 MLP 跑起來（權重可隨機初始化），確認輸出是「和為 1 的 3 個機率」。
2. 把手刻版的 ReLU 換成 `sigmoid`（`1/(1+exp(-x))`），觀察輸出變化——體會激活函數就是 element-wise kernel。
3. `cargo add candle-core candle-nn`，用 candle 建立兩個張量做 `matmul`，並套 `.relu()` 與 `softmax`，對照你手刻的結果。
4. 用 candle 把 17.4 的 MLP 重寫成 17.7 的 `mlp_forward` 版本，比較兩者的程式碼量與可讀性。
5. （若有 Mac/NVIDIA）分別用 `Device::Cpu` 與 GPU 裝置跑同一個較大的 matmul，量測耗時差異。
6. 用第 11 章的 Axum 建一個 `/predict` 端點，把（任一）推論包進去，模型放 `AppState`、推論用 `spawn_blocking`，用 `curl` 送 JSON 測試。
7. 為第 6 題的服務加上第 14 章的 `Semaphore`（限同時推論數 = 2）與 bounded channel，用 `oha` 壓測，觀察過載時的行為。
8. （挑戰）用 `burn --features wgpu` 跑一個 matmul，確認它真的走 GPU（可對照 CPU backend `ndarray` 的耗時），體會「wgpu 當 AI 後端」。
9. （挑戰研究）找一個 Hugging Face 上的小型開源模型（如簡單分類器），用 candle 載入其 `safetensors` 權重跑一次真實推論。

---

## 17.14 驗收清單

- [ ] 我能說明「神經網路推論 = matmul + bias + 非線性」，並對應到第 16 章的三種 kernel。
- [ ] 我理解為什麼 AI 如此依賴 GPU。
- [ ] 我能用 GPU kernel 手刻一個 MLP 前向傳播，並說出手刻的極限。
- [ ] 我知道 candle / burn / tract / ort 的定位與選型時機。
- [ ] 我會用 candle 做張量運算與推論，並選擇 CPU/GPU 裝置。
- [ ] 我理解 burn 的 wgpu 後端跟第 15、16 章的關係（首尾呼應）。
- [ ] 我會把推論包成 Axum API：模型 `Arc` 共享、`spawn_blocking`、薄 handler。
- [ ] 我知道生產化要處理批次化、暖機、量化、用第 14 章手法保護 GPU，並先量測再決定是否上 GPU。

---

## 17.15 路線總結：wgpu → GPU Compute → AI

你完成了這條進階路線：

```text
第 15 章 wgpu 入門
   跟 GPU 對話的骨架：Instance/Device、buffer、shader、dispatch、讀回
        │
        ▼
第 16 章 GPU Compute 平行運算
   執行模型、記憶體階層、element-wise / 歸約 / 矩陣乘法、效能心法
        │
        ▼
第 17 章 用 GPU 跑 AI
   推論 = matmul+激活+歸約；手刻 MLP → 框架（candle/burn/ort/tract）→ 包成 Axum API
```

**這條路線的設計哲學**：不從「呼叫 AI 框架」開始，而是從**最底層的 GPU 運算**開始——因為當你親手用 wgpu 寫過 matmul、理解過 workgroup 與記憶體階層，你再用 candle 或 burn 時，`tensor.matmul()` 背後發生什麼、為什麼要批次化、效能瓶頸在哪、burn 的 wgpu 後端在幹嘛，你**全都懂**。這才是工程師的深度：不只會用，還知其所以然。

而且它跟前 14 章完美銜接——AI 推論服務用到所有權、async、分層、Axum、高併發韌性。**你現在具備的，是「用 Rust 打造一個 GPU 加速的 AI 後端服務」的完整能力鏈。**

---

**GPU / AI 路線完成！🦀🎉** 從第 00 章的「為什麼選 Rust」，到所有權與型別系統的硬功夫，到 async 與後端工程，到高併發韌性，再到這條 GPU 與 AI 的路線——你已經走完從語言初學者到能打造生產級、GPU 加速 AI 後端的完整旅程。

接下來，去挑一個真實的開源模型、包成一個你自己的推論服務、用真實流量把它打到極限再優化。工程的樂趣，正在於把學到的東西縫成一個真正跑得起來、扛得住、又有價值的系統。

> **還想再多一條路線？** 第 18 章 [WebAssembly —— 用 wasm-pack 把 Rust 送進瀏覽器](./18-webassembly-wasm-pack.md) 是一條與本篇平行的加碼路線。前面所有章節的 Rust 都跑在**伺服器**上，第 18 章換成跑在**使用者的瀏覽器**裡：工具鏈、型別跨界成本、瀏覽器影像處理實戰、體積最佳化與 WASM 環境限制。

回到 [課程首頁](./README.md) 複習任何章節。祝你在 Rust + GPU + AI 的路上走得又快又穩。🦀⚡🧠

