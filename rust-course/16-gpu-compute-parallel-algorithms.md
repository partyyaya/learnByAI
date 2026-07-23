# 第 16 章：GPU Compute 平行運算 —— 從 doubler 到真正有用的 kernel

> 第 15 章你已經跑通「跟 GPU 對話」的骨架——把陣列丟上去、每個執行緒 ×2、讀回來。但「×2」太簡單，體會不到 GPU 的威力。
> 這一章我們把中間那段運算換成**真正有用的平行演算法**：向量加法、SAXPY、**平行歸約（求和/求最大）**，以及 GPU 運算的當家花旦——**矩陣乘法**（AI 的核心，第 17 章的地基）。
> 更重要的是，我們會把 GPU 的**執行模型**（workgroup、invocation）與**記憶體階層**講清楚，並談談效能：為什麼有些寫法快 10 倍、傳輸成本怎麼攤、workgroup shared memory 怎麼用。
> 目標是讓你從「會跑一個範例」進化到「能自己設計一個正確又不太慢的 GPU kernel」。

---

## 16.1 學習目標

完成本章後，你應該可以：

- 精確說明 GPU 的執行模型：**dispatch → workgroup → invocation（執行緒）** 的三層結構。
- 正確計算 **global_invocation_id、workgroup_size、dispatch 數量** 之間的關係（含 2D 情況）。
- 寫出**向量加法 / SAXPY** 這類 element-wise kernel（雙輸入、單輸出的標準模式）。
- 說明 GPU 的**記憶體階層**：global / workgroup(shared) / private，以及為何 shared memory 快。
- 用 **workgroup shared memory + 樹狀歸約**寫出平行的「陣列求和」。
- 寫出**矩陣乘法**（先 naive，再理解 tiled 分塊優化的動機）。
- 掌握 GPU 效能三心法：**攤平傳輸成本、提高佔用率（occupancy）、記憶體合併存取**，並知道 uniform buffer 怎麼傳純量參數。
- 把重複的 wgpu 樣板封裝成一個**可重用的 `GpuContext`**。

---

## 16.2 執行模型：dispatch → workgroup → invocation

第 15 章我們用了 `@workgroup_size(64)` 和 `dispatch_workgroups(16, 1, 1)`，但沒細講它們的關係。這是 GPU 程式最核心的觀念，務必弄懂。

GPU 的執行緒是**三層階層**組織的：

```text
dispatch_workgroups(gx, gy, gz)          ← 主機端發射一個「grid」，含 gx×gy×gz 個 workgroup
        │
        ├── workgroup (工作群組)          ← 一群會「一起被排程、能共享記憶體」的執行緒
        │       │
        │       └── invocation (執行緒)   ← 最小單位，每個跑一份 shader，有自己的索引
        │           數量 = @workgroup_size(sx, sy, sz) 的 sx×sy×sz
        ...
```

- **invocation（呼叫 / 執行緒）**：最小執行單位。每個 invocation 都跑一遍你的 shader 函式，只是拿到的內建索引不同。
- **workgroup（工作群組）**：一組 invocation 的集合，數量由 shader 的 `@workgroup_size(x, y, z)` 決定。**同一個 workgroup 內的執行緒可以共享一塊高速記憶體、可以互相同步**（16.6 的歸約會用到）。
- **dispatch（發射）**：主機端 `dispatch_workgroups(gx, gy, gz)` 決定發射幾個 workgroup。

三個關鍵內建變數（WGSL 的 `@builtin`）：

| 內建變數 | 意義 | 範圍 |
|---|---|---|
| `local_invocation_id` | 我在**自己 workgroup 內**的座標 | 0 .. workgroup_size |
| `workgroup_id` | 我的 workgroup 在 grid 裡的座標 | 0 .. dispatch 數 |
| `global_invocation_id` | 我在**整個 grid** 的全域座標（最常用） | 0 .. 總執行緒數 |

它們的關係：

```text
global_invocation_id.xyz = workgroup_id.xyz × workgroup_size.xyz + local_invocation_id.xyz
總執行緒數 = (dispatch 的 gx×gy×gz) × (workgroup_size 的 sx×sy×sz)
```

> **心智模型**：想像一棟大樓分成很多**樓層（workgroup）**，每層有固定數量的**房間（invocation）**。`local_invocation_id` 是「我在這層的第幾號房」，`workgroup_id` 是「我在第幾層」，`global_invocation_id` 是「我在整棟樓的絕對房號」。處理一維陣列時，你通常只關心「絕對房號」＝`global_invocation_id.x`，拿它當陣列索引；處理矩陣/影像時則會同時用 `.x` 與 `.y`。

> **為什麼要分 workgroup，不乾脆一大堆平行執行緒就好？** 因為硬體現實：GPU 是「一批批」執行執行緒的，同一 workgroup 的執行緒被分配到同一個運算單元、能共享超快的區域記憶體、能彼此同步。這個分組讓你能寫出「組內合作」的演算法（如歸約、矩陣分塊）。`@workgroup_size` 選多少有講究——常見是 64 / 128 / 256，通常取硬體 warp/wavefront（32 或 64）的倍數，太小浪費、太大超過硬體上限。**不確定就先用 64 或 256。**

---

## 16.3 封裝可重用的 GpuContext（先把樣板收起來）

第 15 章的取得裝置、建 buffer、跑 pipeline 這些程式碼，每個範例都要重來一次很囉嗦。先把它封裝成一個小工具，本章後面所有範例都用它——這也回扣第 09 章「把重複的東西抽成抽象」的工程習慣。

```rust
use wgpu::util::DeviceExt;

/// 持有 GPU 連線，並提供「跑一個 compute shader」的便利方法。
pub struct GpuContext {
    device: wgpu::Device,
    queue: wgpu::Queue,
}

impl GpuContext {
    pub async fn new() -> Self {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("找不到 GPU");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: None,
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                ..Default::default()
            })
            .await
            .unwrap();
        Self { device, queue }
    }

    /// 建立一個「有初始資料、可 STORAGE 讀寫、可當複製來源」的 buffer。
    pub fn storage_from_slice<T: bytemuck::Pod>(&self, data: &[T]) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(data),
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
        })
    }

    /// 建立一個空的 storage buffer（給輸出用），指定位元組大小。
    pub fn empty_storage(&self, size: u64) -> wgpu::Buffer {
        self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    /// 建立一個 uniform buffer，適合放維度、純量超參數等所有執行緒共讀的小資料。
    pub fn uniform_from_pod<T: bytemuck::Pod>(&self, data: &T) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::bytes_of(data),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        })
    }

    /// 把一個 GPU buffer 的內容讀回 CPU（Vec<T>）。內部自動處理 staging + map + poll。
    pub fn read_buffer<T: bytemuck::Pod>(&self, buffer: &wgpu::Buffer, len: usize) -> Vec<T> {
        let size = (len * std::mem::size_of::<T>()) as u64;
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("staging"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        enc.copy_buffer_to_buffer(buffer, 0, &staging, 0, size);
        self.queue.submit(Some(enc.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();
        let data = slice.get_mapped_range();
        let out = bytemuck::cast_slice(&data).to_vec();
        drop(data);
        staging.unmap();
        out
    }
}
```

有了它，跑一個 kernel 的樣板剩下「建 pipeline → 建 bind group → dispatch」。我們再加一個小輔助：

```rust
impl GpuContext {
    /// 用一段 WGSL 原始碼跑一個 compute shader。
    /// bindings 依序對應 @binding(0), @binding(1), ...；workgroups 是 dispatch 的 (x,y,z)。
    pub fn run(&self, wgsl: &str, entry: &str, bindings: &[&wgpu::Buffer], workgroups: (u32, u32, u32)) {
        let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(wgsl.into()),
        });
        let pipeline = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: None,
            module: &module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            cache: None,
        });
        let entries: Vec<wgpu::BindGroupEntry> = bindings
            .iter()
            .enumerate()
            .map(|(i, b)| wgpu::BindGroupEntry {
                binding: i as u32,
                resource: b.as_entire_binding(),
            })
            .collect();
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(workgroups.0, workgroups.1, workgroups.2);
        }
        self.queue.submit(Some(enc.finish()));
    }
}
```

> **工程提醒**：這個 `GpuContext` 是**教學用的簡化版**——每次 `run` 都重新編譯 shader、建 pipeline，正式使用會很慢（pipeline 應該建立一次、重複用）。它的目的是讓後面範例聚焦在「WGSL 演算法本身」，不被樣板淹沒。16.11 會談怎麼把它變得實用一點。

---

## 16.4 範例一：向量加法（element-wise 的標準模式）

最基礎但最常用的模式：兩個輸入陣列、一個輸出陣列，`c[i] = a[i] + b[i]`。這是「雙輸入單輸出」element-wise kernel 的範本——影像混合、張量逐元素運算全是這個形狀。

WGSL（`add.wgsl`）：

```wgsl
@group(0) @binding(0) var<storage, read>       a: array<f32>;   // 輸入唯讀
@group(0) @binding(1) var<storage, read>       b: array<f32>;   // 輸入唯讀
@group(0) @binding(2) var<storage, read_write> c: array<f32>;   // 輸出可寫

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&c)) { return; }   // 邊界檢查
    c[i] = a[i] + b[i];
}
```

注意這裡輸入用 `var<storage, read>`（唯讀）、輸出用 `read_write`。**明確標記讀寫權限**能幫 GPU 最佳化，也讓意圖更清楚。

主機端：

```rust
use pollster::FutureExt;

fn main() {
    let gpu = GpuContext::new().block_on();

    let n = 1_000_000usize;
    let a: Vec<f32> = (0..n).map(|x| x as f32).collect();
    let b: Vec<f32> = (0..n).map(|x| (2 * x) as f32).collect();

    let a_buf = gpu.storage_from_slice(&a);
    let b_buf = gpu.storage_from_slice(&b);
    let c_buf = gpu.empty_storage((n * std::mem::size_of::<f32>()) as u64);

    // dispatch 數量 = ceil(n / workgroup_size)
    let groups = (n as u32).div_ceil(64);
    gpu.run(include_str!("add.wgsl"), "main", &[&a_buf, &b_buf, &c_buf], (groups, 1, 1));

    let c = gpu.read_buffer::<f32>(&c_buf, n);
    println!("c[123] = {} （應為 123 + 246 = 369）", c[123]);
    assert_eq!(c[123], 369.0);
}
```

- **三個 buffer 對應三個 binding**：`&[&a_buf, &b_buf, &c_buf]` 的順序就是 `@binding(0/1/2)`。
- **輸出 buffer 用 `empty_storage`**：不需要初始資料，GPU 會填。
- 100 萬個加法，GPU 上上千個執行緒分批同時做完。

> **這個模式有多通用**：幾乎所有「逐元素」運算都是把 `c[i] = a[i] + b[i]` 換成別的式子——相減、相乘、`max(a[i], b[i])`、`a[i] * scalar`（下面 SAXPY）、ReLU（第 17 章 `max(x, 0)`）……骨架完全一樣。**先把這個模式刻進肌肉記憶。**

### 小變化：SAXPY（`y = a*x + y`）

科學運算經典操作 SAXPY——一個純量 `a` 乘上向量 `x` 再加向量 `y`。它引出一個問題：**純量 `a` 怎麼傳給 shader？** 用 **uniform buffer**（16.10 詳談），這裡先看形狀：

```wgsl
struct SaxpyParams {
    scale: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

@group(0) @binding(0) var<uniform>             params: SaxpyParams; // 純量 a（uniform）
@group(0) @binding(1) var<storage, read>       x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= arrayLength(&y)) { return; }
    y[i] = params.scale * x[i] + y[i];
}
```

> **uniform vs storage 的直覺**：**大陣列**用 storage buffer；**少量、所有執行緒共讀的參數**（純量、矩陣維度、超參數）用 uniform buffer——它更小、更快、且被硬體最佳化成「廣播給所有執行緒」。16.10 會給完整的 uniform 傳遞範例。

---

## 16.5 GPU 的記憶體階層

要寫出「快」的 kernel，必須理解 GPU 有**多層記憶體**，速度與範圍差很多：

```text
┌─────────────────────────────────────────────────────────┐
│ global memory（全域記憶體）                                │
│  - storage/uniform buffer 就在這                          │
│  - 容量大（GB 級），但延遲高（相對而言慢）                    │
│  - 所有執行緒都能存取                                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │ workgroup shared memory（var<workgroup>）           │  │
│  │  - 一個 workgroup 內的執行緒共享                       │  │
│  │  - 容量小（KB 級），但延遲極低（快很多）                 │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ private memory（var<function>、區域變數）       │  │  │
│  │  │  - 每個執行緒私有，最快                          │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

| 空間 | WGSL 宣告 | 範圍 | 速度 | 容量 |
|---|---|---|---|---|
| global | `var<storage>` / `var<uniform>` | 全部執行緒 | 慢 | 大（GB） |
| workgroup（shared） | `var<workgroup>` | 同一 workgroup | 快 | 小（KB） |
| private | 區域變數 / `var<private>` | 單一執行緒 | 最快 | 極小 |

> **心智模型**：global memory 像「公司的中央倉庫」——大、但走一趟很花時間。workgroup shared memory 像「你這組的工作檯」——小，但東西就在手邊、拿取超快，而且同組的人可以共用。private 像「你口袋裡的東西」——最快但只有你自己有。**效能優化的核心思路：把要反覆存取的資料，從遠倉庫搬到近工作檯（shared memory），大家一起用。** 這正是接下來歸約與矩陣分塊的關鍵手法。

> **一個同步原語**：`workgroupBarrier()`——「同 workgroup 的所有執行緒都到這裡了，才一起往下走」。當多個執行緒往 shared memory 寫、之後又要讀彼此寫的結果時，中間**必須** barrier，否則會讀到還沒寫好的髒資料（資料競爭的 GPU 版）。下一節就會用到。

---

## 16.6 範例二：平行歸約（把一整個陣列加總）

前面的 element-wise 有個特性：**每個輸出只依賴對應的輸入**，執行緒之間互不相干。但很多運算不是這樣——例如「把整個陣列加總成一個數」，這需要**執行緒之間合作**，稱為**歸約（reduction）**。

單執行緒 CPU 版是 `sum = a[0]+a[1]+...+a[n-1]`，一個迴圈。但 GPU 上不能讓一個執行緒跑迴圈（浪費了平行性），也不能讓上千個執行緒同時 `sum += a[i]`（資料競爭）。解法是**樹狀歸約**：

```text
初始:  [3, 1, 7, 0, 4, 1, 6, 3]     8 個數
步驟1:  [3+4, 1+1, 7+6, 0+3, ...] → [7, 2, 13, 3]   相鄰間距 4 相加，4 個執行緒同時做
步驟2:  [7+13, 2+3]              → [20, 5]           2 個執行緒
步驟3:  [20+5]                   → [25]              1 個執行緒
       log2(8) = 3 步就得到總和，而非 8 步
```

每一步用一半的執行緒把資料兩兩相加，`log2(n)` 步就收斂。做法是把資料載進 **workgroup shared memory**，在裡面做樹狀相加：

```wgsl
@group(0) @binding(0) var<storage, read>       input: array<f32>;
@group(0) @binding(1) var<storage, read_write> partial: array<f32>;  // 每個 workgroup 輸出一個部分和

const WG: u32 = 256u;
var<workgroup> shared: array<f32, 256>;   // workgroup 內共享的暫存（快！）

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id)  lid: vec3<u32>,
    @builtin(workgroup_id)         wid: vec3<u32>,
) {
    let tid = lid.x;                        // 我在這組的編號 0..255
    let i = gid.x;                          // 全域索引

    // (1) 每個執行緒把自己負責的一個元素載進 shared memory（越界填 0）
    shared[tid] = 0.0;
    if (i < arrayLength(&input)) {
        shared[tid] = input[i];
    }
    workgroupBarrier();                     // 等全組都載完，才能開始互相加

    // (2) 樹狀歸約：stride 從 128、64、32... 一路減半
    var stride = WG / 2u;
    loop {
        if (stride == 0u) { break; }
        if (tid < stride) {
            shared[tid] = shared[tid] + shared[tid + stride];
        }
        workgroupBarrier();                 // 每一步之間都要同步！
        stride = stride / 2u;
    }

    // (3) 每組的 0 號執行緒把這組的總和寫出去
    if (tid == 0u) {
        partial[wid.x] = shared[0];
    }
}
```

關鍵拆解：

- **`var<workgroup> shared`**：宣告一塊 256 個 f32 的 workgroup 共享記憶體。整組執行緒把資料先搬進來，之後的相加都在這塊快記憶體裡進行，不再碰慢的 global memory。
- **`workgroupBarrier()` 是靈魂**：載入後要 barrier（確保全組載完）；每一步相加後也要 barrier（確保這一輪的加法都寫完，下一輪才讀）。**漏掉任何一個 barrier，就會讀到髒資料、結果隨機錯誤**——而且這種 bug 極難重現（時序相關），是 GPU 程式最惡名昭彰的坑。
- **越界處理要用 `if` 包住讀取**：不要寫 `select(0.0, input[i], i < len)` 來避免越界，因為兩邊運算式仍可能先被求值；先填 `0.0`，只有 `i < len` 才讀 `input[i]`，最後一個不滿 256 的 workgroup 才安全。
- **每個 workgroup 只算出「自己這 256 個數的部分和」**，寫進 `partial[wid.x]`。

**兩階段歸約**：一次 dispatch 只把「每組 256 個」縮成「每組 1 個」。如果原本有 100 萬個數、每組 256，第一趟後剩下約 3907 個部分和。所以要**再跑一次同樣的 kernel**（對 partial 陣列歸約），或當剩下夠少時把最後幾千個搬回 CPU 加完。主機端：

```rust
fn gpu_sum(gpu: &GpuContext, data: &[f32]) -> f32 {
    const WG: usize = 256;
    let mut buf = gpu.storage_from_slice(data);
    let mut len = data.len();

    // 反覆歸約，直到只剩少量再由 CPU 收尾
    while len > 1024 {
        let groups = len.div_ceil(WG);
        let partial = gpu.empty_storage((groups * 4) as u64);
        gpu.run(include_str!("reduce.wgsl"), "main", &[&buf, &partial], (groups as u32, 1, 1));
        buf = partial;
        len = groups;                       // 下一輪要歸約的長度
    }

    // 剩下的（<=1024 個部分和）搬回 CPU 加完
    let tail = gpu.read_buffer::<f32>(&buf, len);
    tail.iter().sum()
}
```

> **為什麼歸約值得單獨學**：它是「執行緒合作」類演算法的原型。求和、求最大/最小（把 `+` 換成 `max`）、求內積（先逐元素相乘再歸約）、softmax 的分母（第 17 章）……全都是歸約的變形。而它也逼你直面 GPU 最難的部分：**shared memory + barrier + 多階段**。搞懂這個範例，你對 GPU 的理解就上了一個台階。

> **心智模型**：歸約像「開會表決統計」。全體 1000 人（執行緒）不能同時往一張紙上寫票數（資料競爭）。改成分組（workgroup），每組先在組內用「兩兩合併」快速統計出小計（shared memory + 樹狀相加，中間喊「大家都寫好了嗎」＝barrier），最後只剩各組的小計，再彙總。分治 + 局部合作，正是平行運算的精髓。

---

## 16.7 範例三：矩陣乘法（AI 的心臟）

終於到了 GPU 運算最重要的操作——**矩陣乘法（matmul）**。第 17 章你會看到：神經網路的每一層，本質就是一次矩陣乘法。GPU 之所以成為 AI 的引擎，正因為它把 matmul 做到極快。

回憶定義：`C = A × B`，其中 A 是 `M×K`、B 是 `K×N`、C 是 `M×N`。C 的每一格：

```text
C[row][col] = Σ (k=0..K)  A[row][k] × B[k][col]
              （A 的第 row 列 與 B 的第 col 行 的內積）
```

**平行化策略**：C 有 `M×N` 格，每一格互相獨立——**派一個執行緒算一格**。這天生就適合 GPU。用 **2D dispatch**：`global_invocation_id.x` 當 col、`.y` 當 row。

WGSL（naive 版，`matmul.wgsl`）：

```wgsl
// 矩陣以一維陣列存放（row-major）：A[row][k] = a[row * K + k]
struct Dims { m: u32, k: u32, n: u32 }

@group(0) @binding(0) var<uniform>             dims: Dims;
@group(0) @binding(1) var<storage, read>       a: array<f32>;
@group(0) @binding(2) var<storage, read>       b: array<f32>;
@group(0) @binding(3) var<storage, read_write> c: array<f32>;

@compute @workgroup_size(16, 16)   // 2D workgroup：16×16 = 256 個執行緒
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let row = gid.y;
    let col = gid.x;
    if (row >= dims.m || col >= dims.n) { return; }   // 2D 邊界檢查

    var sum = 0.0;
    for (var k = 0u; k < dims.k; k = k + 1u) {
        sum = sum + a[row * dims.k + k] * b[k * dims.n + col];
    }
    c[row * dims.n + col] = sum;
}
```

重點：

- **2D workgroup 與 2D dispatch**：`@workgroup_size(16, 16)` 一組 256 個執行緒排成 16×16 網格，剛好對應輸出矩陣的一個 16×16 區塊。dispatch 時 x 方向要 `ceil(N/16)`、y 方向 `ceil(M/16)`。
- **矩陣攤平成一維**：GPU buffer 是一維的，所以 `A[row][k]` 存成 `a[row*K + k]`（row-major）。這個索引換算要非常小心，是 matmul 最容易寫錯的地方。
- **維度用 uniform 傳**：`M/K/N` 是所有執行緒共讀的少量參數，放 uniform buffer（見 16.10）。

主機端（含 uniform 傳遞，串起 16.10）：

```rust
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Dims { m: u32, k: u32, n: u32, _pad: u32 }   // _pad 對齊到 16 bytes

fn matmul(gpu: &GpuContext, a: &[f32], b: &[f32], m: u32, k: u32, n: u32) -> Vec<f32> {
    let dims = Dims { m, k, n, _pad: 0 };
    let dims_buf = gpu.uniform_from_pod(&dims);
    let a_buf = gpu.storage_from_slice(a);
    let b_buf = gpu.storage_from_slice(b);
    let c_buf = gpu.empty_storage((m * n) as u64 * 4);

    // 2D dispatch：x=col 方向 ceil(N/16)，y=row 方向 ceil(M/16)
    let gx = n.div_ceil(16);
    let gy = m.div_ceil(16);
    gpu.run(include_str!("matmul.wgsl"), "main",
            &[&dims_buf, &a_buf, &b_buf, &c_buf], (gx, gy, 1));

    gpu.read_buffer::<f32>(&c_buf, (m * n) as usize)
}
```

### naive 版的問題與 tiled 優化

上面的 naive 版**正確但不夠快**。問題在記憶體存取：算 C 的每一格都要從 global memory 讀 A 的一整列、B 的一整行。相鄰執行緒（算同一列的不同格）會**重複讀 A 的同一列**——同樣的資料從慢的 global memory 讀了無數次。

**Tiled（分塊）matmul** 的優化思路（回扣 16.5 的記憶體階層）：

```text
把 C 切成一塊塊 16×16 的 tile，每個 workgroup 負責一塊。
對每一塊：
  1. 全組合作，把 A、B 對應的 16×16 子塊「一次」搬進 workgroup shared memory
  2. workgroupBarrier() 等搬完
  3. 在快的 shared memory 裡做這一塊的乘加（資料重複利用，不再碰 global）
  4. 沿 K 方向滑動，重複載入下一組子塊、累加
```

核心收益：**把 global memory 的重複讀取，換成「載一次到 shared memory、大家重複用」**。實務上 tiled matmul 比 naive 快數倍。它的完整 WGSL 較長（約 40 行、要處理 shared memory 索引與兩層 barrier），這裡點出思路即可——**理解「為什麼要 tile」比背程式碼重要**：

> **核心洞見**：naive 版每個執行緒獨立地從遠倉庫（global memory）反覆搬同樣的貨。tiled 版讓一組人先合作把這批貨搬到共用工作檯（shared memory）一次，然後大家在工作檯上反覆取用。**同樣的計算量，記憶體流量大減**——而 GPU 運算的瓶頸，十之八九是記憶體頻寬而非算力。這也是所有高效能 matmul（包括 cuBLAS、第 17 章 AI 框架底層）的共同思想。

> **給學習者的定心丸**：你**不需要手刻出最快的 matmul**——那是專門領域，成熟框架（第 17 章的 candle/burn）已經幫你調到極致。本節的目的，是讓你**理解 GPU 為何快、瓶頸在哪、優化的方向是什麼**，這樣你用框架時才知道它在做什麼、效能出問題時知道往哪查。naive 版能跑對，就達到本章目標了。

---

## 16.8 效能三心法

寫 GPU kernel，正確之後才談快。三個最重要的原則：

### 心法一：攤平傳輸成本

回扣第 15 章——資料要在 CPU↔GPU 之間搬運，這開銷固定且不小。所以：

- **別為小工作用 GPU**。搬運 + 啟動的固定成本，可能遠大於省下的計算時間。
- **一次搬大批、盡量留在 GPU 上連續運算**。第 17 章的神經網路有很多層，正確做法是「資料上傳一次，所有層都在 GPU 上算完，最後才下載結果」，而不是每層都搬回 CPU。
- **重疊傳輸與計算**（進階）：趁 GPU 算這批時，非同步上傳下一批。

> **量化直覺**：如果一個 kernel 只算 1ms，但上傳下載花 5ms，你的 GPU 有 83% 時間在搬貨、只有 17% 在算。**讓計算/傳輸比越高越好**——這也是為什麼 GPU 特別適合「運算密集」的 AI，而非「搬完就算完」的簡單操作。

### 心法二：提高佔用率（occupancy）

GPU 靠「大量執行緒輪流上工」來掩蓋記憶體延遲——某些執行緒在等資料時，硬體切去跑別的執行緒，讓運算單元不閒置。要餵飽它：

- **workgroup_size 別太小**（如 8），會浪費硬體排程單位；也別超過硬體上限。**64 / 128 / 256 是安全區**。
- **總執行緒數要夠多**，讓 GPU 有東西可切換。資料太少時 GPU 跑不滿。
- **shared memory / 暫存器別用過頭**——用太多會限制能同時上工的 workgroup 數，反而降低佔用率。

### 心法三：記憶體合併存取（coalesced access）與避免分支發散

- **合併存取**：相鄰的執行緒最好存取相鄰的記憶體位址，GPU 能把它們合併成一次寬頻讀取。跳著存取（strided）會浪費頻寬。（這也是 matmul 索引順序要講究的原因。）
- **避免分支發散（divergence）**：同一 workgroup 的執行緒最好走同一條路徑。如果 `if/else` 讓組內執行緒走不同分支，硬體得「兩條都跑、各自遮罩」，等於兩倍工。邊界檢查那種「只有最後一組少數執行緒 return」的發散無傷大雅；但**資料相關的大量分支**要盡量避免。

> **鐵律（回扣第 14 章）**：**先量測，再優化**。GPU 效能問題常反直覺，用工具（wgpu 的 timestamp query、或廠商的 profiler 如 Nsight）量出真正的瓶頸——通常是記憶體頻寬或傳輸，而非算力。憑感覺調 workgroup_size 常常白忙。

---

## 16.9 更多 WGSL 實用知識

寫 kernel 常用到的幾個點，集中列出：

- **內建數學函式**：`abs`、`min`、`max`、`clamp`、`sqrt`、`exp`、`log`、`pow`、`sin`/`cos`、`dot`（向量內積）、`fma`（乘加）——AI 的激活函數（第 17 章）就靠 `exp`、`max`。
- **向量型別**：`vec2/vec3/vec4<f32>`、`vec4<u32>` 等。用 vec4 一次處理 4 個 f32 可提升頻寬利用（向量化）。
- **型別嚴格**：WGSL 比 Rust 還嚴格，`u32` 和 `i32`、`f32` 不會自動轉換，字面量要寫對（`1u`、`1i`、`1.0`）。`1u` 是 u32、`1.0` 是 f32。
- **`select(f, t, cond)`**：無分支的條件選擇，比 `if` 對 GPU 友善。
- **`arrayLength(&buf)`**：取得 runtime-sized array 的長度（用於邊界檢查）。
- **控制流**：`for`、`loop`/`break`/`continue`、`if`、`switch` 都有，但記得「分支發散」的效能考量。

---

## 16.10 傳純量參數：Uniform Buffer 與對齊陷阱

前面 SAXPY 和 matmul 都要傳「純量參數」（純量 `a`、維度 `M/K/N`）給 shader。大陣列用 storage buffer，這些**少量、唯讀、所有執行緒共讀**的參數用 **uniform buffer**。

WGSL 端用 `var<uniform>` 宣告一個 struct：

```wgsl
struct Params {
    scale: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}
@group(0) @binding(0) var<uniform> params: Params;
```

Rust 端要用 `#[repr(C)]` 的對應 struct（並實作 `bytemuck::Pod`）：

```rust
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    scale: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}

let params = Params { scale: 2.5, count: 1024, _pad0: 0, _pad1: 0 };
let params_buf = gpu.uniform_from_pod(&params);
```

**對齊陷阱（GPU 程式的經典坑）**：WGSL 的記憶體佈局規則跟 Rust `#[repr(C)]` **不完全一樣**，尤其 uniform buffer 有嚴格的對齊要求：

- `vec3<f32>` 在 WGSL 佔 **16 bytes 對齊**（不是 12！），常需補一個 padding 欄位。
- 雖然現代 WGSL 正逐步放寬 uniform layout，但跨平台教學與舊硬體最穩妥的做法仍是把小型 uniform struct 湊成 16 bytes 的倍數（所以 16.7 的 `Dims` 加了 `_pad: u32`）。
- 欄位順序與型別要**兩邊完全對上**，否則 shader 讀到的值會錯位、產生莫名其妙的結果。

```rust
// ❌ 危險：WGSL 端若是 vec3，這樣佈局會對不上
struct Bad { v: [f32; 3], scale: f32 }   // WGSL vec3 佔 16 bytes，這裡卻緊接 scale

// ✅ 安全：明確補齊，讓 Rust 佈局符合 WGSL 規則
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Good { v: [f32; 3], _pad: f32, scale: f32, _pad2: [f32; 3] }
```

> **除錯心法**：GPU 結果「數字全錯、或某些欄位是垃圾值」，第一個要懷疑的就是 **uniform struct 的對齊/佈局對不上**。對照 WGSL 的對齊規則（WebGPU 規格的 memory layout 章節）逐欄檢查，必要時多加 `_pad` 欄位。用 `bytemuck` 能擋掉「型別不是 Pod」的錯，但擋不掉「佈局不符 WGSL 規則」——這要靠你手動對齊。

> **簡化技巧**：能用 `u32`/`f32`/`vec4` 就別用 `vec3`，把參數湊成 16 bytes 的倍數，對齊問題會少很多。維度這種整數參數，全用 `u32` 並補 `_pad` 到 16 bytes 邊界最省心。

---

## 16.11 把 GpuContext 變得實用

16.3 的 `GpuContext` 每次 `run` 都重編 shader、重建 pipeline，教學可以、正式不行。要變實用，關鍵是**把「編譯一次的東西」跟「每次執行的東西」分開**：

```text
只做一次（初始化）              每次呼叫（熱路徑）
─────────────────             ─────────────────
- create_shader_module        - 更新 buffer 內容（write_buffer）
- create_compute_pipeline     - 建立/重用 bind group
- create_bind_group_layout    - encoder → dispatch → submit
                              - （必要時）讀回結果
```

實務做法（概念）：

- 把每個 kernel 封裝成一個持有 `pipeline` 的 struct，建構時編譯一次，之後 `dispatch(...)` 只做錄製與提交。
- buffer 盡量**重用**（尺寸不變就別重建），用 `queue.write_buffer(&buf, 0, bytemuck::cast_slice(&data))` 更新內容。
- 多個 kernel 串起來時，**共用同一個 encoder**、一次 submit（回扣第 15 章「攢一批」）；中間結果留在 GPU buffer，不搬回 CPU。
- 讀回（`map_async` + `poll`）是同步阻塞點，**只在最後真的需要結果時做一次**。

> **這正是第 17 章的關鍵**：神經網路有很多層 kernel，正確架構是「pipeline 全部建立一次、資料上傳一次、所有層在 GPU 上連續 dispatch、最後才讀回結果」。理解這個「初始化 vs 熱路徑」的切分，你就懂了 AI 推論引擎的骨架。也是為什麼直接用成熟框架（它們把這些都調好了）通常比自己刻更實際。

---

## 16.12 常見錯誤

- **漏掉 `workgroupBarrier()`** → shared memory 讀到還沒寫完的髒資料，結果隨機錯、極難重現。凡是「寫 shared memory 後又要讀別人寫的」，中間必須 barrier。
- **在發散的分支裡呼叫 barrier** → 部分執行緒 return 了卻還有人在等 barrier，導致死結或未定義行為。barrier 必須讓 workgroup **全員都會執行到**（別放在 `if (i < n) { ...barrier... }` 裡）。
- **矩陣一維索引算錯** → `a[row*K + k]` 寫成 `a[row*N + k]` 之類，結果全錯。row-major 索引要反覆核對。
- **2D dispatch 的 x/y 對應弄反** → 記住慣例：`gid.x` 對 col（N 方向）、`gid.y` 對 row（M 方向），dispatch 的 gx 對 N、gy 對 M。
- **uniform struct 對齊不符 WGSL 規則** → 讀到錯位的垃圾值。補 `_pad`、湊 16 bytes 倍數，`vec3` 特別小心。
- **workgroup_size 與 shared memory 陣列大小對不上** → `array<f32, 256>` 卻用 `@workgroup_size(128)`，浪費或越界。兩者要一致。
- **歸約只做一趟就當成最終結果** → 一趟只得到「每組的部分和」，要多階段歸約或 CPU 收尾。
- **小資料還硬用 GPU 並困惑為何比 CPU 慢** → 傳輸/啟動成本蓋過收益。GPU 要大資料 + 密集運算才划算。
- **每次運算都重建 pipeline** → 熱路徑奇慢。pipeline 建立一次、重複用（16.11）。

---

## 16.13 本章小結

- **執行模型三層**：dispatch（發射 grid）→ workgroup（能共享記憶體、能同步的一組）→ invocation（單一執行緒）。`global_invocation_id = workgroup_id × workgroup_size + local_invocation_id`。
- **element-wise kernel**（向量加法/SAXPY）：每個執行緒管一格輸出，輸入唯讀、輸出可寫，是最通用的範本。
- **記憶體階層**：global（大而慢，storage/uniform）→ workgroup shared（小而快，`var<workgroup>`）→ private（最快）。優化核心是「把重複存取的資料搬到 shared memory 共用」。
- **平行歸約**：用 shared memory + 樹狀相加 + `workgroupBarrier()`，`log(n)` 步完成求和/求極值；需多階段或 CPU 收尾。barrier 漏了就出隨機錯。
- **矩陣乘法**：一執行緒算一格、2D dispatch；矩陣攤平成一維要小心索引。naive 可跑對，tiled 用 shared memory 減少重複讀取而更快——這是 AI 的核心運算（第 17 章）。
- **效能三心法**：攤平傳輸成本（大批、留在 GPU）、提高佔用率（workgroup_size 64~256、餵飽執行緒）、合併存取 + 避免分支發散。
- **uniform buffer** 傳純量/維度參數，注意 WGSL 的**對齊陷阱**（`vec3` 佔 16、struct 湊 16 倍數、補 `_pad`）。
- 正式使用要把 **pipeline 建立一次、資料留在 GPU 連續運算**（初始化 vs 熱路徑分離）——這是第 17 章推論引擎的骨架。

---

## 16.14 動手作業

1. 把 16.4 的向量加法跑起來，改成向量點對點相乘 `c[i] = a[i] * b[i]`，再改成 `c[i] = max(a[i], b[i])`。
2. 實作 SAXPY（`y = a*x + y`），用 uniform buffer 傳純量 `a`（練習 16.10 的對齊）。
3. 把 16.6 的歸約跑起來求 100 萬個數的總和，跟 CPU 的 `iter().sum()` 比對結果與耗時。再把 `+` 改成 `max` 做「求最大值」。
4. 故意拿掉歸約 kernel 中的一個 `workgroupBarrier()`，多跑幾次觀察結果是否偶爾出錯——親身體會 barrier 的必要性（這是最有價值的一個實驗）。
5. 實作 16.7 的 naive 矩陣乘法（例如 512×512），跟 CPU 三重迴圈版比對正確性與耗時，感受 GPU 在 matmul 上的加速。
6. 把 matmul 的 `@workgroup_size` 從 `(16,16)` 改成 `(8,8)` 和 `(32,32)`（注意別超過硬體上限），量測耗時差異，體會佔用率的影響。
7. （挑戰）查 WebGPU 規格的 memory layout，實作一個含 `vec3<f32>` 的 uniform struct，正確補齊 padding 讓 shader 讀到正確值。
8. （挑戰）把 16.11 的建議落實：改寫 `GpuContext`，讓 pipeline 只建立一次、可重複 `dispatch`，量測相對 16.3 版本的加速。

---

## 16.15 驗收清單

- [ ] 我能解釋 dispatch / workgroup / invocation 三層，並正確算出總執行緒數與各種 invocation id。
- [ ] 我會寫雙輸入單輸出的 element-wise kernel，並正確標記讀寫權限與邊界檢查。
- [ ] 我能說明 GPU 記憶體階層，以及「搬到 shared memory 共用」為何是主要優化手段。
- [ ] 我能用 shared memory + barrier + 樹狀歸約寫出平行求和，並解釋漏 barrier 的後果。
- [ ] 我能寫出 naive 矩陣乘法（含一維索引換算與 2D dispatch），並說明 tiled 優化的動機。
- [ ] 我理解效能三心法：傳輸成本、佔用率、合併存取/分支發散。
- [ ] 我會用 uniform buffer 傳參數，並知道 WGSL 的對齊陷阱與 `_pad` 技巧。
- [ ] 我理解「pipeline 建一次、資料留 GPU 連續運算」是高效 kernel 與 AI 推論的骨架。

---

**GPU 平行運算完成！** 你已經從「跑一個範例」進化到「理解 GPU 的執行模型、記憶體階層、與效能取捨」，並親手寫過 element-wise、歸約、矩陣乘法這三種最核心的平行演算法。

其中**矩陣乘法**是通往下一章的橋樑——第 17 章你會發現，一個神經網路的推論，其實就是把你這章學的 matmul、element-wise（激活函數）、歸約（softmax）**串成一條鏈**。我們會先用這些 kernel 手刻一個小型神經網路的前向傳播，再認識 Rust 的 AI 生態（candle / burn / ort），最後把 AI 推論包成第 11 章的 Axum API。

回到 [課程首頁](./README.md)，或前往第 17 章，讓 GPU 跑起 AI。🦀🧠




