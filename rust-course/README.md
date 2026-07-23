# Rust 後端工程實戰完整課程

> 這不是一門「把 C++ 語法翻成 Rust」的課，而是帶你用 Rust 蓋出一個「能上線的後端服務」。
> 我們會先把 Rust 最難的所有權、借用、生命週期打穩，再進到架構設計、資料庫串接、網路 API 串接，
> 最後把所有觀念收斂成一個完整成品。重點是建立「用 Rust 做工程決策」的能力，而不是背 API。

---

## 課程目標

完成本課後，你應該可以：

- 讀懂並寫出符合所有權/借用規則的 Rust 程式，不再跟編譯器打架。
- 用 `trait`、泛型與模組把系統拆成清楚的分層架構（架構設計）。
- 以 `SQLx` 為主串接資料庫，並認識 `SeaORM` / Diesel 的選型取捨；處理連線池、Migration、CRUD 與交易（資料庫串接）。
- 用 `Axum` 建立 RESTful API，並用 `reqwest` 串接第三方外部 API（網路 API 串接）。
- 把架構、資料庫、API 整合成一個可測試、可部署的完整後端成品（成品範例）。

## 適合對象

- 會其他語言（JavaScript、Python、Java、Go），想認真學 Rust 做後端的工程師。
- 學過 Rust 語法，但一碰到專案架構、資料庫、API 就卡住的人。
- 想理解「Rust 為什麼快又安全」，並實際做出成品的自學者。

## 前置知識

- 會使用基本命令列與 Git。
- 有任一程式語言基礎（了解變數、函式、迴圈即可）。
- 知道 HTTP、REST API 與後端服務大致如何運作。

## 建議練習環境

- `rustup` + `cargo`：Rust 官方工具鏈與套件管理。
- VS Code + rust-analyzer：即時型別提示與錯誤檢查。
- Docker Desktop：快速啟動 PostgreSQL，不污染本機。
- PostgreSQL 16+：本課資料庫串接的主要範例。

---

## 課程目錄

### 第 0 篇：入門與心智模型

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-why-rust-and-setup.md](./00-course-map-why-rust-and-setup.md) | 課程地圖、為什麼選 Rust、rustup/cargo 安裝與第一支程式 |

### 第 1 篇：語言核心（打底）

| 章節 | 檔案 | 主題 |
|------|------|------|
| 01 | [01-basics-variables-types-control-flow.md](./01-basics-variables-types-control-flow.md) | 基礎語法：變數、可變性、基本型別、控制流與函式 |
| 02 | [02-ownership-borrowing-lifetimes.md](./02-ownership-borrowing-lifetimes.md) | Rust 的靈魂：所有權、借用、參考與生命週期 |
| 03 | [03-structs-enums-traits-generics.md](./03-structs-enums-traits-generics.md) | 型別系統：struct、enum、pattern matching、trait 與泛型 |
| 04 | [04-error-handling-result-option.md](./04-error-handling-result-option.md) | 錯誤處理：Option / Result、`?` 運算子、thiserror / anyhow |
| 05 | [05-collections-iterators-closures.md](./05-collections-iterators-closures.md) | 集合、迭代器、閉包與函式式風格 |
| 06 | [06-modules-cargo-crates-testing.md](./06-modules-cargo-crates-testing.md) | 模組系統、Cargo、crate 生態與單元/整合測試 |

### 第 2 篇：進階能力

| 章節 | 檔案 | 主題 |
|------|------|------|
| 07 | [07-smart-pointers-interior-mutability.md](./07-smart-pointers-interior-mutability.md) | 智慧指標與內部可變性：Box / Rc / Arc / RefCell / Mutex |
| 08 | [08-concurrency-and-async-tokio.md](./08-concurrency-and-async-tokio.md) | 併發與非同步：thread、async/await 與 Tokio runtime |

### 第 3 篇：架構設計（需求 1）

| 章節 | 檔案 | 主題 |
|------|------|------|
| 09 | [09-application-architecture-design.md](./09-application-architecture-design.md) | 分層架構、Cargo workspace、模組邊界、依賴反轉、trait 抽象與設定管理 |

### 第 4 篇：資料庫串接（需求 2）

| 章節 | 檔案 | 主題 |
|------|------|------|
| 10 | [10-database-integration-sqlx-orm.md](./10-database-integration-sqlx-orm.md) | 資料庫串接：SQLx / SeaORM 選型、連線池、Migration、CRUD、交易與 Repository 模式 |

### 第 5 篇：網路 API 串接（需求 3）

| 章節 | 檔案 | 主題 |
|------|------|------|
| 11 | [11-building-web-api-axum.md](./11-building-web-api-axum.md) | 建立 Web API：用 Axum 打造 RESTful 服務、路由、狀態、middleware、驗證與錯誤映射 |
| 12 | [12-calling-external-apis-reqwest.md](./12-calling-external-apis-reqwest.md) | 串接外部 API：reqwest client、serde 序列化、逾時 / 重試 / 錯誤處理 |

### 第 6 篇：成品專題（需求 4）

| 章節 | 檔案 | 主題 |
|------|------|------|
| 13 | [13-capstone-fullstack-backend-service.md](./13-capstone-fullstack-backend-service.md) | Capstone：整合架構 + 資料庫 + API 的完整後端成品，含測試與部署 |

### 第 7 篇：生產強化（進階加碼）

| 章節 | 檔案 | 主題 |
|------|------|------|
| 14 | [14-high-concurrency-and-resilience.md](./14-high-concurrency-and-resilience.md) | 高併發與韌性：背壓、Semaphore、Tower 限流/負載卸除、斷路器、鎖競爭、快取、容量規劃與觀測性 |

### 第 8 篇：GPU 運算與 AI（進階路線）

> 一條獨立的進階路線：`wgpu → GPU Compute → AI`。從最底層的 GPU 運算開始，一路串到能上線的 AI 推論後端服務。
> 前提是先讀完第 08 章（async）——AI 服務會用到 `spawn_blocking`；第 17 章的部署則回扣第 11、14 章。

| 章節 | 檔案 | 主題 |
|------|------|------|
| 15 | [15-gpu-compute-wgpu.md](./15-gpu-compute-wgpu.md) | wgpu 入門：CPU vs GPU、WebGPU/WGSL、Instance→Device、buffer、compute shader、dispatch 與讀回（第一支 GPU 程式） |
| 16 | [16-gpu-compute-parallel-algorithms.md](./16-gpu-compute-parallel-algorithms.md) | GPU Compute 平行運算：workgroup 執行模型、記憶體階層、向量加法、平行歸約、矩陣乘法與效能心法 |
| 17 | [17-gpu-ai-inference.md](./17-gpu-ai-inference.md) | 用 GPU 跑 AI：推論 = matmul+激活+歸約、手刻 MLP、Rust AI 生態（candle/burn/tract/ort）、包成 Axum 推論服務 |

---

## 本課教學方式

每章都會包含：

- **學習目標**：先知道這章要解決什麼問題。
- **觀念講解**：用工程場景解釋 Rust 的設計取捨。
- **實作範例**：前半語言章多為可直接 `cargo run` 的單檔範例；後半工程章多為可組裝到 workspace / demo 專案的縱切片段，附逐段解釋。
- **常見錯誤**：說明新手最容易踩到的編譯器與設計坑。
- **練習題**：讓你自己動手改與寫。
- **參考解答**：每題都附解法與理由。

## 建議學習路線

第一次學習請照順序：

```text
00 入門與環境
  -> 01 基礎語法
  -> 02 所有權/借用/生命週期（最重要）
  -> 03 型別系統 trait/泛型
  -> 04 錯誤處理
  -> 05 集合與迭代器
  -> 06 模組與測試
  -> 07 智慧指標
  -> 08 併發與非同步
  -> 09 架構設計
  -> 10 資料庫串接
  -> 11 建立 Web API
  -> 12 串接外部 API
  -> 13 期末成品
  -> 14 高併發與韌性（進階加碼）
  -> 15 wgpu 入門（GPU 路線，進階加碼）
  -> 16 GPU Compute 平行運算
  -> 17 用 GPU 跑 AI
```

如果你已經熟悉 Rust 語法，可以直接從第 09 章的架構設計開始，但建議先確認自己已掌握第 03～08 章的 trait、錯誤處理、workspace、`Arc` 與 async/Tokio。再往 10、11、12 走，做完第 13 章成品後，再用第 14 章把它強化成能扛流量尖峰、擋得住故障的生產級服務。

**GPU / AI 路線（第 15~17 章）** 是一條相對獨立的進階加碼路線，主軸是 `wgpu → GPU Compute → AI`：先用 wgpu 跑通第一支 GPU 程式（15），再寫向量加法、歸約、矩陣乘法等平行演算法並理解效能（16），最後看清「AI 推論就是一連串矩陣運算」，用框架跑推論並包成後端服務（17）。建議至少先讀完第 08 章（async），因為第 17 章把 AI 推論包成 API 時會回扣 `spawn_blocking`、`Arc` 共享狀態（第 07、08、11 章）與高併發保護（第 14 章）。想直接學 GPU/AI 的人，也可先讀 01~08 打底後跳到 15。

---

完成後請前往 [00-course-map-why-rust-and-setup.md](./00-course-map-why-rust-and-setup.md)。
