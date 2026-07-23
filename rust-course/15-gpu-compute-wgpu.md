# 第 15 章：wgpu 入門 —— 用 Rust 掌控 GPU

> 前 14 章我們把 Rust 的所有權、型別、async 與後端工程練到能上線。這一篇換一個維度：**讓程式跑在 GPU 上**。
> CPU 擅長「複雜的少量任務」，GPU 擅長「簡單但海量的平行任務」——影像處理、科學運算、以及當紅的 AI，本質都是「對一大堆資料做同一件事」。
> 本章用 **wgpu**（Rust 生態最主流的跨平台 GPU 函式庫）帶你從零跑出第一支 GPU 程式：把一個陣列丟上 GPU，讓上千個執行緒同時把每個元素乘 2，再把結果讀回來。
> 這是「wgpu → GPU Compute → AI」這條路線的起點——先把「怎麼跟 GPU 對話」弄懂，第 16 章寫真正有用的平行演算法，第 17 章用它跑神經網路推論。

---

## 15.1 學習目標

完成本章後，你應該可以：

- 說清楚 **CPU 與 GPU 的分工**，並判斷什麼工作適合丟給 GPU。
- 解釋 **WebGPU / wgpu / WGSL** 三者的關係，以及 wgpu 為何能「一份程式碼跑遍 Vulkan / Metal / DX12 / WebGPU」。
- 理解 GPU 程式的「**主機端（host）與裝置端（device）分離**」心智模型。
- 用 `wgpu` 取得 GPU 的四大件：**Instance → Adapter → Device + Queue**。
- 寫出第一支 **WGSL compute shader**，並理解 `@compute`、`@workgroup_size`、`@builtin(global_invocation_id)`。
- 用 **buffer / bind group / pipeline** 把資料送上 GPU、`dispatch` 執行、再把結果**讀回 CPU**。
- 跑出一個能 `cargo run` 的完整「GPU 把陣列 ×2」範例。

---

## 15.2 為什麼要學 GPU：CPU 與 GPU 的分工

先建立最重要的直覺——**CPU 和 GPU 是兩種完全不同的處理器**：

| | CPU | GPU |
|---|---|---|
| 核心數 | 少（4~64 個），每個都很強 | 極多（數千個），每個都較弱 |
| 擅長 | 複雜邏輯、分支、低延遲的單一任務 | 對海量資料做**同一種**簡單運算 |
| 比喻 | 幾位博士，什麼難題都能解 | 幾千位小學生，同時算一堆簡單加減法 |
| 記憶體 | 大、有多層快取，延遲低 | 頻寬極高，但延遲也高 |

> **心智模型**：要把一疊 10000 張考卷「每張分數 ×2」。CPU 是找 8 位博士，一人分 1250 張輪流算——博士很快，但要跑 1250 輪。GPU 是找 10000 位小學生，一人一張、**同一瞬間全部算完**。每個小學生慢一點沒關係，因為「人海」把總時間壓垮了。這種「對大量資料做同一件事」就是 GPU 的主場，術語叫 **資料平行（data parallelism）**。

什麼工作適合 GPU？

- ✅ **同構、可平行**：影像每個像素做同樣濾鏡、向量/矩陣運算、粒子模擬、AI 的張量運算。
- ❌ **強相依、多分支**：需要「上一步結果才能算下一步」、大量 `if/else` 走不同路徑的邏輯，GPU 反而慢。

> **注意**：GPU 不是「什麼都比 CPU 快」。把資料搬上 GPU、算完再搬回來，**搬運本身有成本**。資料量小、或運算太簡單時，光搬運就比 CPU 直接算還久。GPU 的甜蜜點是「**資料夠大、運算夠密集、又高度平行**」——這正是 AI 的形狀（第 17 章）。

---

## 15.3 wgpu 是什麼：WebGPU、wgpu 與 WGSL

要對 GPU 下指令，歷史上你得針對不同平台學不同 API：Windows 的 **DirectX 12**、Apple 的 **Metal**、跨平台的 **Vulkan**、瀏覽器的 **WebGL**……同一個演算法要寫好幾套，苦不堪言。

**WebGPU** 是新一代的統一標準（由瀏覽器廠商主導，但不只用於瀏覽器），目標是「一套現代 GPU API，抽象掉底層差異」。而 **wgpu** 就是它在 Rust 世界的實作：

```text
        你的 Rust 程式
             │  呼叫 wgpu API（一套）
             ▼
          wgpu（Rust crate）
             │  自動翻譯成各平台原生 API
   ┌─────────┼─────────┬──────────┐
   ▼         ▼         ▼          ▼
 Vulkan    Metal     DX12      WebGPU
(Linux/   (macOS/   (Windows) (瀏覽器/WASM)
 Android)   iOS)
```

- **wgpu**：Rust 的 GPU 函式庫，實作 WebGPU 標準。你寫一份程式，它幫你在 Windows 用 DX12、macOS 用 Metal、Linux 用 Vulkan、瀏覽器用 WebGPU 跑起來。它同時能做**圖形繪製（render）**與**通用運算（compute）**；本課只聚焦 **compute**（拿 GPU 當計算機用）。
- **WGSL（WebGPU Shading Language）**：跑在 GPU 上的那段程式要用的語言。它**不是 Rust**——是一種類似 Rust 語法的著色器語言。你會寫兩種程式：用 **Rust** 寫「主機端」的協調邏輯，用 **WGSL** 寫「裝置端」真正在 GPU 上跑的運算核心（kernel）。

> **為什麼 Rust 生態選 wgpu**：它是純 Rust、跨平台、又能編譯到 WebAssembly 跑在瀏覽器裡。連知名的 AI 框架 **Burn** 都用 wgpu 當它的跨平台 GPU 後端（第 17 章會看到）——所以學會 wgpu，等於同時打通「自己寫 GPU 運算」與「理解 AI 框架底層」兩條路。

> **版本提醒（很重要）**：wgpu 的 API 在版本之間變動頗大（欄位增減、函式簽章調整）。本章程式碼以近期穩定版的形態示範，**概念是穩定的、但確切的欄位名/簽章請以你 `Cargo.toml` 鎖定版本的官方文件（docs.rs/wgpu）為準**。學習時建議明確鎖版本，例如 `wgpu = "=某版本"`，避免升級後 API 對不上而卡住。

---

## 15.4 GPU 程式的整體流程：主機端 vs 裝置端

寫 GPU 程式最關鍵的心智轉換是：**你的程式碼分成兩邊，跑在兩個不同的處理器上**。

```text
主機端（Host，跑在 CPU，用 Rust 寫）          裝置端（Device，跑在 GPU，用 WGSL 寫）
──────────────────────────────────           ──────────────────────────────
1. 取得 GPU（Instance/Adapter/Device）
2. 準備資料，建立 buffer（記憶體）
3. 把資料從 CPU 複製到 GPU buffer
4. 載入並編譯 shader（WGSL）    ───────▶     @compute fn main(...) {
5. 建立 pipeline、bind group                     // 上千個執行緒同時跑這段
6. 錄製指令：dispatch（發射執行緒）                 data[i] = data[i] * 2.0;
7. submit 提交給 GPU 執行         ───────▶     }
8. 把結果從 GPU 複製回 CPU
9. 讀取結果
```

主機端（Rust）像**工頭**：準備材料、發號施令、收成果。裝置端（WGSL）像**工人大軍**：接到命令後，成千上萬個一起動手做那段運算。

> **關鍵差異**：CPU 與 GPU 有**各自的記憶體**（獨立顯卡尤其明顯）。CPU 不能直接讀 GPU 的記憶體，反之亦然。所以流程裡有兩次「搬運」：**上傳**（CPU→GPU，步驟 3）和**下載**（GPU→CPU，步驟 8）。這兩次搬運是 GPU 運算的主要開銷之一，第 16 章談效能時會反覆提到。

整個流程有點繁瑣（這是 GPU 程式的宿命——你要手動管理記憶體與執行緒配置），但骨架永遠是這 9 步。看懂骨架後，後面每一節就是在填其中一塊。

---

## 15.5 環境設定

建一個新專案，加入三個 crate：

```bash
cargo new gpu_hello
cd gpu_hello
cargo add wgpu
cargo add pollster
cargo add bytemuck --features derive
```

- **`wgpu`**：GPU 函式庫本體。
- **`pollster`**：wgpu 的 API 大量是 `async`（取得裝置、讀回資料都要 `.await`），但我們這支小程式不想引入整個 Tokio。`pollster::block_on(future)` 能在同步的 `main` 裡「就地把一個 Future 跑到完成」——最輕量的 async 執行器（回扣第 08 章：`async fn` 需要有東西去推動它）。
- **`bytemuck`**：GPU buffer 眼中只有「一堆位元組（bytes）」。`bytemuck` 幫你把 `&[f32]` 這種 Rust 切片**安全地轉成 `&[u8]`**（以及反過來），不用寫 `unsafe` 的指標轉型。

> **執行環境**：需要一張支援的 GPU（現代整合顯卡也可以）。若你在無 GPU 的環境（某些 CI、容器），wgpu 可退回軟體實作或直接找不到 adapter——本章範例在一般筆電/桌機都能跑。

---

## 15.6 取得 GPU 的四大件：Instance → Adapter → Device + Queue

任何 wgpu 程式的第一步，都是循著這條鏈拿到能對 GPU 下令的握把：

```text
Instance ──▶ Adapter ──▶ Device ──▶ Queue
 wgpu       一張實體      跟裝置的   指令的
 進入點      GPU 的代表    邏輯連線    提交口
```

```rust
use pollster::FutureExt; // 提供 .block_on()

fn main() {
    run().block_on();
}

async fn run() {
    // 1. Instance：wgpu 的進入點，負責列舉系統上的 GPU。
    let instance = wgpu::Instance::default();

    // 2. Adapter：代表一張實體 GPU（或軟體後備）。
    //    RequestAdapterOptions 可指定「偏好高效能還是省電」等。
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("找不到可用的 GPU adapter");

    // 印出實際選到的裝置，方便確認（例如 "Apple M2" / "NVIDIA RTX 4070"）
    println!("使用 GPU：{:?}", adapter.get_info());

    // 3. Device + Queue：從 adapter 開一條邏輯連線。
    //    - Device：用來「建立資源」（buffer、shader、pipeline）。
    //    - Queue：用來「提交指令與上傳資料」給 GPU。
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("主要裝置"),
            required_features: wgpu::Features::empty(), // 需要特殊功能才開
            required_limits: wgpu::Limits::default(),   // 資源上限（buffer 大小等）
            ..Default::default()
        })
        .await
        .expect("無法建立裝置");

    // 之後所有操作都圍繞 device 與 queue 展開……
    let _ = (device, queue);
}
```

四個角色記牢：

- **`Instance`**：整個 wgpu 的起點，用來找 GPU。
- **`Adapter`**：一張具體的 GPU 的「代表」。`get_info()` 能看到廠牌型號與所用後端（Vulkan/Metal/…）。
- **`Device`**：跟這張 GPU 的**邏輯連線**，所有資源（buffer、shader、pipeline）都由它 `create_*` 出來。
- **`Queue`**：指令的**提交口**——上傳資料、`submit` 錄好的指令，都透過它。

> **為什麼要 async？** 取得 adapter/device 可能要跟作業系統、驅動溝通，是會「等待」的操作，所以設計成 `async`（回扣第 08 章）。我們用 `pollster` 的 `block_on` 把它在同步 `main` 裡跑完，不必動用 Tokio。

> **版本差異提醒**：`DeviceDescriptor` 的欄位（如 `required_features` / `required_limits` / `memory_hints` / `trace`）與 `request_device` 的簽章在不同 wgpu 版本略有出入。若編譯報「欄位不存在」或「參數數量不符」，對照你版本的 docs.rs 調整即可——**四大件的概念不變**。

---

## 15.7 第一支 WGSL compute shader

現在寫真正在 GPU 上跑的那段程式。把它存成 `src/double.wgsl`：

```wgsl
// 綁定到 group 0 的 binding 0，是一段「可讀可寫的 storage buffer」，
// 內容是一個 f32 陣列。主機端會把資料放進這裡。
@group(0) @binding(0)
var<storage, read_write> data: array<f32>;

// @compute 標記這是一個「運算入口」。
// @workgroup_size(64) 表示「一個工作群組（workgroup）有 64 個執行緒」。
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;                    // 這個執行緒負責處理的全域索引

    // 邊界檢查：執行緒總數常常「多開一點點」（見 15.10 的 dispatch 計算），
    // 超出陣列長度的執行緒要直接跳過，否則會越界。
    if (i >= arrayLength(&data)) {
        return;
    }

    data[i] = data[i] * 2.0;          // 本執行緒的工作：把第 i 個元素乘 2
}
```

逐行拆解 WGSL 的關鍵語法：

- **`@group(0) @binding(0)`**：宣告這個變數對應到主機端設定的「第 0 組、第 0 號綁定」的資源。主機端會用 bind group（15.9）把真正的 buffer 接上來。
- **`var<storage, read_write>`**：這是一個 **storage buffer**（大容量、可讀寫的 GPU 記憶體），適合放輸入/輸出的大陣列。
- **`array<f32>`**：一個長度在執行期才知道的浮點數陣列。
- **`@compute`**：宣告這是 compute shader 的入口函式（相對於繪圖用的 vertex/fragment shader）。
- **`@workgroup_size(64)`**：**每個工作群組包含 64 個執行緒**。這是 GPU 執行模型的核心，第 16 章會深入；現在先記「執行緒是成群發射的」。
- **`@builtin(global_invocation_id) gid`**：GPU 幫每個執行緒自動填入的**全域編號**。它是 3 維的（`vec3<u32>`，含 x/y/z），處理一維陣列時我們只用 `gid.x`。

> **心智模型**：這段 `main` **不是被呼叫一次**，而是被 GPU「複製成上千份、同時執行」。差別只在於每一份拿到的 `gid.x` 不同——第 0 個執行緒的 `i=0`、第 1 個 `i=1`……於是「同一段程式」就把整個陣列**一次算完**。這就是 15.2 說的「一人一張考卷」。你要做的事，是把演算法寫成「**站在單一執行緒的角度，我該處理哪一格**」。

---

## 15.8 Buffer：把資料搬上 GPU

GPU 看不到你 Rust `Vec` 裡的資料——你得建立 **buffer**（GPU 上的記憶體區塊）並把資料複製過去。本例需要兩種 buffer：

1. **Storage buffer**：GPU 運算實際讀寫的地方（對應 shader 裡的 `data`）。
2. **Staging buffer（讀回用）**：一塊 CPU 能「映射（map）讀取」的 buffer。**GPU 用來運算的 storage buffer 通常不能直接被 CPU 讀**，所以算完要先把結果**複製**到這塊 staging buffer，CPU 才能讀。

```rust
use wgpu::util::DeviceExt; // 提供 create_buffer_init

let numbers: Vec<f32> = (0..1024).map(|x| x as f32).collect();
let size = (numbers.len() * std::mem::size_of::<f32>()) as u64; // 位元組數

// (1) storage buffer：用初始資料建立，並標記用途
let storage_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
    label: Some("儲存 buffer"),
    contents: bytemuck::cast_slice(&numbers), // &[f32] → &[u8]
    usage: wgpu::BufferUsages::STORAGE          // 可被 shader 當 storage 讀寫
        | wgpu::BufferUsages::COPY_SRC,         // 可作為「複製來源」（算完複製到 staging）
});

// (2) staging buffer：沒有初始資料，用來把結果讀回 CPU
let staging_buffer = device.create_buffer(&wgpu::BufferDescriptor {
    label: Some("讀回 buffer"),
    size,
    usage: wgpu::BufferUsages::MAP_READ         // 可被 CPU 映射讀取
        | wgpu::BufferUsages::COPY_DST,         // 可作為「複製目的地」
    mapped_at_creation: false,
});
```

- **`usage`（用途旗標）是關鍵**：wgpu 要求你**預先宣告**每個 buffer 的用途，這樣它能做最佳化與驗證。用錯會直接報錯：
  - storage buffer：`STORAGE`（給 shader 用）+ `COPY_SRC`（算完要當複製來源）。
  - staging buffer：`MAP_READ`（CPU 要讀）+ `COPY_DST`（要當複製目的地）。
- **`bytemuck::cast_slice(&numbers)`**：把 `&[f32]` 轉成 GPU 要的 `&[u8]`。這就是 `bytemuck` 的用途——安全地在型別化切片與位元組切片之間轉換。
- **`create_buffer_init`** 來自 `wgpu::util::DeviceExt`（記得 `use`），它一步到位「建立 buffer + 填入初始資料」。

> **為什麼要兩塊 buffer？** GPU 拿來高速運算的記憶體，和 CPU 能直接讀的記憶體，特性不同（尤其獨立顯卡，兩者物理上是分開的）。慣例是：運算用 storage buffer（GPU 專用、快），要看結果時再 `copy_buffer_to_buffer` 到一塊 `MAP_READ` 的 staging buffer 給 CPU 讀。這是 GPU 程式的標準模式，第 16、17 章都照這個套路。

---

## 15.9 Shader 模組、Pipeline 與 Bind Group

有了資料，還需要三樣東西把「shader」跟「buffer」接起來、並告訴 GPU 怎麼跑：

**(1) Shader module**：把 WGSL 原始碼交給 GPU 編譯。

```rust
let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
    label: Some("double shader"),
    // include_str! 在編譯期把 .wgsl 檔內容內嵌成字串
    source: wgpu::ShaderSource::Wgsl(include_str!("double.wgsl").into()),
});
```

**(2) Compute pipeline**：一個「設定好的運算流程」，指定用哪個 shader、哪個入口函式。

```rust
let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
    label: Some("double pipeline"),
    layout: None,                 // None = 讓 wgpu 從 shader 自動推導綁定佈局
    module: &shader,
    entry_point: Some("main"),    // 對應 WGSL 裡的 fn main
    compilation_options: Default::default(),
    cache: None,
});
```

**(3) Bind group**：把「實際的 buffer」接到「shader 裡的 `@group(0) @binding(0)`」。pipeline 定義了「需要哪些綁定」，bind group 提供「這些綁定實際是哪塊 buffer」。

```rust
// 從 pipeline 取出它推導出來的第 0 組綁定佈局
let bind_group_layout = pipeline.get_bind_group_layout(0);

let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
    label: Some("bind group"),
    layout: &bind_group_layout,
    entries: &[wgpu::BindGroupEntry {
        binding: 0,                                   // 對應 WGSL 的 @binding(0)
        resource: storage_buffer.as_entire_binding(), // 用整個 storage buffer
    }],
});
```

三者的關係一句話總結：

```text
shader（WGSL 程式）
   │  被包進
   ▼
pipeline（設定好的運算流程：用哪個 shader、哪個入口）
   │  執行時搭配
   ▼
bind group（把 @group/@binding 對應到實際 buffer）
```

> **`layout: None` 的方便與代價**：傳 `None` 讓 wgpu 從 shader 自動推導綁定佈局，教學/雛形很方便。正式專案常會手動建立 `PipelineLayout` 以獲得更精確的控制與跨 pipeline 重用。初學先用 `None` 即可。

---

## 15.10 錄製指令並發射：Command Encoder 與 Dispatch

資源都備齊了，最後是「**錄製一串指令，交給 GPU 執行**」。GPU 不是你呼叫一行它做一行——你要先用 **command encoder** 把「要做的事」錄成一個指令緩衝（command buffer），再一次 `submit` 給 GPU。

```rust
// encoder：錄製指令用
let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
    label: Some("指令編碼器"),
});

// (a) compute pass：真正發射運算執行緒
{
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("double pass"),
        timestamp_writes: None,
    });
    pass.set_pipeline(&pipeline);
    pass.set_bind_group(0, &bind_group, &[]);

    // 關鍵：發射多少個 workgroup？
    // 每個 workgroup 有 64 個執行緒（WGSL 的 @workgroup_size(64)），
    // 我們有 1024 個元素，所以需要 ceil(1024 / 64) = 16 個 workgroup。
    let workgroup_count = (numbers.len() as u32).div_ceil(64);
    pass.dispatch_workgroups(workgroup_count, 1, 1);
} // pass 在這裡結束（drop）

// (b) 把 GPU 算完的結果從 storage buffer 複製到 staging buffer
encoder.copy_buffer_to_buffer(&storage_buffer, 0, &staging_buffer, 0, size);

// (c) 完成錄製，提交給 GPU 執行
queue.submit(Some(encoder.finish()));
```

`dispatch_workgroups(x, y, z)` 是整個 GPU 程式的引爆點——它告訴 GPU「發射 x×y×z 個 workgroup」。總執行緒數 = workgroup 數 × 每個 workgroup 的執行緒數：

```text
元素數 = 1024，每個 workgroup 64 個執行緒
需要的 workgroup 數 = ceil(1024 / 64) = 16
總執行緒數 = 16 × 64 = 1024（剛好，每個執行緒處理一個元素）
```

> **為什麼要 `div_ceil`（向上取整）？** 如果元素數不是 64 的倍數（例如 1000 個），`ceil(1000/64)=16` 個 workgroup 會發射 `16×64=1024` 個執行緒——**比資料多 24 個**。這就是為什麼 shader 裡要有 `if (i >= arrayLength(&data)) { return; }`：多出來的執行緒直接跳過，不越界。這個「多開一點 + 邊界檢查」是 GPU 程式的標準慣用法。

> **批次思維（回扣第 08 章）**：注意我們是「**錄一整批指令再一次 submit**」，而不是一個指令來回跟 GPU 溝通一次。跟 GPU 溝通有固定開銷，所以永遠是「攢一批、一次送」。這跟後端「批次寫 DB」的思路一致。

---

## 15.11 把結果讀回 CPU：map_async 與 poll

`submit` 之後 GPU 開始算，但結果還在 GPU 那塊 staging buffer 裡。要讀它，得先「**映射（map）**」——請 GPU 把那塊記憶體開放給 CPU 存取。這是個非同步操作：

```rust
// 取得 staging buffer 的可讀切片
let buffer_slice = staging_buffer.slice(..);

// map_async 是非同步的：用一個 channel 在映射完成時收到通知
let (sender, receiver) = std::sync::mpsc::channel();
buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
    sender.send(result).unwrap();
});

// 關鍵：device.poll 推動 GPU 把工作做完（包含上面的 map 請求）。
// Wait 表示「阻塞直到所有已提交工作完成」。
device.poll(wgpu::Maintain::Wait);

// 等映射完成的通知
receiver.recv().unwrap().unwrap();

// 現在可以讀了：拿到位元組，再用 bytemuck 轉回 f32
let data = buffer_slice.get_mapped_range();
let result: Vec<f32> = bytemuck::cast_slice(&data).to_vec();

// 讀完務必解除映射（drop 掉借用後才能 unmap）
drop(data);
staging_buffer.unmap();

println!("前 8 個結果：{:?}", &result[..8]);
// 預期：[0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0]（每個元素都 ×2）
```

三個容易忽略的重點：

- **`map_async` 是非同步的**：你不能馬上讀，要等它完成的回呼。這裡用最簡單的 `std::sync::mpsc`（回扣第 08 章的 channel）在完成時收通知。
- **`device.poll(Maintain::Wait)` 不可少**：wgpu 需要你「推動」它去實際執行已排入的工作（包括完成 map）。少了這行，回呼永遠不會被觸發，程式卡死。
- **讀完要 `unmap`**：映射佔用資源，讀完（且 drop 掉 `get_mapped_range` 回傳的借用）後要 `unmap` 釋放。

> **版本差異提醒**：讀回結果的細節（`Maintain::Wait` vs 新版的 `PollType`/`poll` 回傳值）在不同 wgpu 版本略有調整。若這段編譯不過，對照你版本文件微調——但「map → poll 推動 → 讀 → unmap」四步的**順序與概念是固定的**。

---

## 15.12 完整範例：GPU 把陣列每個元素 ×2

把 15.5～15.11 串成一支可 `cargo run` 的完整程式。`src/double.wgsl` 用 15.7 的內容，`src/main.rs` 如下：

```rust
use pollster::FutureExt;
use wgpu::util::DeviceExt;

fn main() {
    run().block_on();
}

async fn run() {
    // ── 1. 取得 GPU 四大件 ──────────────────────────────
    let instance = wgpu::Instance::default();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("找不到 GPU adapter");
    println!("使用 GPU：{:?}", adapter.get_info().name);
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            ..Default::default()
        })
        .await
        .unwrap();

    // ── 2. 準備資料與 buffer ────────────────────────────
    let numbers: Vec<f32> = (0..1024).map(|x| x as f32).collect();
    let size = (numbers.len() * std::mem::size_of::<f32>()) as u64;

    let storage_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("storage"),
        contents: bytemuck::cast_slice(&numbers),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });
    let staging_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("staging"),
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    // ── 3. shader / pipeline / bind group ───────────────
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("double"),
        source: wgpu::ShaderSource::Wgsl(include_str!("double.wgsl").into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("pipeline"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("bind group"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: storage_buffer.as_entire_binding(),
        }],
    });

    // ── 4. 錄製指令並提交 ───────────────────────────────
    let mut encoder =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups((numbers.len() as u32).div_ceil(64), 1, 1);
    }
    encoder.copy_buffer_to_buffer(&storage_buffer, 0, &staging_buffer, 0, size);
    queue.submit(Some(encoder.finish()));

    // ── 5. 讀回結果 ─────────────────────────────────────
    let slice = staging_buffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
    device.poll(wgpu::Maintain::Wait);
    rx.recv().unwrap().unwrap();

    let data = slice.get_mapped_range();
    let result: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    staging_buffer.unmap();

    println!("輸入前 8 個：{:?}", &numbers[..8]);
    println!("輸出前 8 個：{:?}", &result[..8]); // 每個都 ×2
    assert_eq!(result[10], 20.0);
    println!("✅ GPU 運算成功！");
}
```

跑起來：

```bash
cargo run
# 使用 GPU："Apple M2"（或你的 GPU）
# 輸入前 8 個：[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
# 輸出前 8 個：[0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0]
# ✅ GPU 運算成功！
```

你剛剛讓 GPU 上的 1024 個執行緒**同時**把整個陣列乘了 2。雖然「×2」本身微不足道，但**這支程式的骨架，就是所有 GPU 運算的骨架**——第 16 章只是把中間那個 `data[i] * 2.0` 換成向量加法、歸約、矩陣乘法；第 17 章再把矩陣乘法組成神經網路。**外框永遠是這 9 步。**

> **回顧 15.4 的 9 步**：對照上面的程式——步驟 1（取得 GPU）、2-3（buffer + 上傳）、4（shader）、5（pipeline + bind group）、6-7（dispatch + submit）、8（copy 回 staging）、9（map 讀回）。你已經完整走過一遍了。

---

## 15.13 常見錯誤

- **buffer `usage` 旗標漏了** → 例如 storage buffer 忘了 `COPY_SRC` 就想 `copy_buffer_to_buffer`，或 staging 忘了 `MAP_READ` 就想 map，wgpu 會直接報驗證錯誤。**用途要事先宣告齊全。**
- **想直接 map storage buffer** → 一般 storage buffer 沒有 `MAP_READ`，不能被 CPU 讀。要先 `copy_buffer_to_buffer` 到 staging buffer 再 map。
- **忘了 `device.poll(...)`** → `map_async` 的回呼永遠不觸發，程式卡住。map 之後一定要 poll 推動。
- **讀完沒 `unmap` 或沒 drop 掉 `get_mapped_range` 的借用** → 下次操作該 buffer 會出錯。順序是「讀 → drop 借用 → unmap」。
- **dispatch 數量算錯（用整除而非向上取整）** → 元素數不是 workgroup_size 倍數時，最後幾個元素不會被處理。用 `div_ceil` 並在 shader 做邊界檢查。
- **shader 沒做邊界檢查** → 多開的執行緒越界存取，結果錯誤或崩潰。`if (i >= arrayLength(&data)) { return; }` 不能省。
- **`@workgroup_size` 與 `dispatch_workgroups` 沒對上** → 記住：總執行緒數 = dispatch 的 workgroup 數 × shader 宣告的 workgroup_size。兩邊要一致地思考。
- **用了 `bytemuck` 卻沒開 `derive` feature 或型別沒對齊** → 轉型失敗。基本型別（`f32`/`u32`）沒問題；自訂 struct 要 `#[repr(C)]` 且滿足對齊（第 16 章談 uniform 時會遇到）。
- **在小資料上用 GPU 反而更慢** → 別忘了搬運成本。1024 個數字乘 2，CPU 一個迴圈瞬間完成；GPU 版慢是因為初始化與傳輸開銷。GPU 的價值要在**大資料 + 密集運算**才顯現（第 16、17 章）。

---

## 15.14 本章小結

- **CPU vs GPU**：CPU 是少數強核（複雜邏輯），GPU 是海量弱核（對大量資料做同一件事＝資料平行）。適合 GPU 的工作要「同構、可平行、資料夠大」。
- **wgpu** 是 Rust 實作 WebGPU 標準的跨平台 GPU 函式庫，一份程式碼可跑 Vulkan/Metal/DX12/WebGPU；shader 用 **WGSL** 撰寫。
- GPU 程式是**主機端（Rust，工頭）+ 裝置端（WGSL，工人大軍）分離**，且兩者記憶體分開，需上傳/下載搬運。
- 取得 GPU 的鏈：**Instance → Adapter → Device + Queue**。
- WGSL compute shader 用 `@compute @workgroup_size(N)` 宣告，`@builtin(global_invocation_id)` 給每個執行緒不同索引；程式要用「單一執行緒視角」寫。
- 資料流：建 **storage buffer**（GPU 運算）+ **staging buffer**（`MAP_READ` 讀回）；用 `bytemuck` 在 `&[f32]` 與 `&[u8]` 間轉換。
- 執行：**shader → pipeline → bind group** 接好，用 **command encoder** 錄製 `dispatch_workgroups` + `copy_buffer_to_buffer`，`queue.submit` 提交。
- 讀回：`map_async` → `device.poll(Wait)` 推動 → 讀 → `unmap`。
- **dispatch 用 `div_ceil` 向上取整 + shader 邊界檢查**是標準慣用法。

---

## 15.15 動手作業

1. 照 15.12 把「陣列 ×2」跑起來，改成 `data[i] = data[i] * data[i]`（平方），驗證結果。
2. 把 `@workgroup_size(64)` 改成 `256`，同步調整 `dispatch_workgroups` 的計算（`div_ceil(256)`），確認結果不變——體會「workgroup_size 與 dispatch 要一起想」。
3. 把元素數改成 **1000**（不是 64 的倍數），確認邊界檢查讓結果依然正確；再故意把 shader 的 `if (i >= arrayLength(&data))` 拿掉，觀察會發生什麼（可能越界/錯誤）。
4. 用 `adapter.get_info()` 印出你的 GPU 型號與所用後端（backend 欄位，例如 Metal/Vulkan/Dx12）。
5. 加一個計時：分別量「純 GPU 運算 + 傳輸」與「CPU 用 `iter().map()` 做同樣的 ×2」在 1024、100 萬、1 億元素下的耗時，找出「GPU 開始比 CPU 快」的資料量門檻（體會搬運成本）。
6. （挑戰）把輸入輸出分成兩塊 buffer：新增一個 `output` storage buffer，shader 改成 `output[i] = input[i] * 2.0`（輸入唯讀、輸出唯寫）。你需要在 WGSL 宣告兩個綁定、在 bind group 提供兩個 entry。

---

## 15.16 驗收清單

- [ ] 我能說明 CPU 與 GPU 的分工，並判斷一個工作適不適合丟給 GPU。
- [ ] 我理解 WebGPU / wgpu / WGSL 的關係，以及 wgpu 為何跨平台。
- [ ] 我能畫出 GPU 程式「主機端 vs 裝置端」的整體流程與兩次搬運。
- [ ] 我會用 Instance → Adapter → Device + Queue 取得 GPU。
- [ ] 我看得懂 compute shader 的 `@compute`、`@workgroup_size`、`global_invocation_id`，並用「單一執行緒視角」思考。
- [ ] 我知道 storage buffer 與 staging buffer 的分工，以及 `usage` 旗標為何重要。
- [ ] 我會用 encoder 錄製 dispatch + copy、submit，並用 map_async + poll 把結果讀回。
- [ ] 我理解 dispatch 數量的 `div_ceil` 與 shader 邊界檢查為何是標配。

---

**GPU 入門完成！** 你已經跑通了「跟 GPU 對話」的完整骨架——這是後面兩章的地基。

第 16 章我們把中間那段運算換成**真正有用的平行演算法**：向量加法、平行歸約（求和）、以及 GPU 運算的明星——**矩陣乘法**，並深入 workgroup 執行模型與效能心法。第 17 章再把矩陣乘法組成神經網路，用 GPU 跑 **AI 推論**，並認識 Rust 的 AI 生態（candle / burn / ort）。

回到 [課程首頁](./README.md)，或前往第 16 章繼續。🦀⚡




