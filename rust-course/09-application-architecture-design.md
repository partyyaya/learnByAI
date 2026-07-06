# 第 09 章：應用架構設計 —— 分層、workspace、依賴反轉與設定管理

> 前八章教你把 Rust「寫對」，從這一章起我們教你把系統「蓋對」。
> 一支後端服務跑久了，難的從來不是語法，而是「當需求一直加、資料庫換了、要多接一個外部 API 時，程式碼會不會爛掉」。
> 這章用第 03 章的 trait、第 04 章的錯誤分層、第 06 章的 workspace，教你把系統拆成清楚的分層架構，讓「業務邏輯」不被「資料庫」「HTTP 框架」綁死。
> 這是進入第 10～13 章實戰的總設計圖——請務必弄懂「依賴方向」這件事。

---

## 9.1 學習目標

完成本章後，你應該可以：

- 說出「為什麼要分層」，以及不分層會付出什麼代價。
- 畫出一個後端服務的分層架構：domain（領域）、application（用例）、infrastructure（基礎設施）、interface（介面）。
- 理解並實踐「**依賴反轉**」：讓業務邏輯依賴「抽象（trait）」，而不是依賴「具體的資料庫/框架」。
- 用 Cargo workspace 把每一層拆成獨立 crate，用**編譯器**強制守住依賴方向。
- 用 trait 定義 `Repository` 這種「port（介面）」，為第 10 章的資料庫實作鋪路。
- 設計跨層的錯誤型別（回扣第 04 章 thiserror）。
- 用環境變數 + 設定檔管理組態，並用 `AppState` 做「手動依賴注入」。

---

## 9.2 為什麼要分層？先看不分層的下場

新手常把所有東西塞進一個 handler：接 HTTP 請求、連資料庫、算業務邏輯、呼叫外部 API，全擠在一個函式裡。

```rust
// 反面教材：一個什麼都做的 handler
async fn create_order(/* http 請求 */) {
    // 1. 解析 HTTP body
    // 2. 直接開 SQL 連線、寫 INSERT
    // 3. 中間夾雜「折扣怎麼算、庫存夠不夠」的業務規則
    // 4. 呼叫金流的外部 API
    // 5. 組 HTTP 回應
}
```

短期看起來很快，但你會遇到：

- **想換資料庫**（Postgres → MySQL）？業務邏輯裡到處是 SQL，得全部翻。
- **想測「折扣規則」**？沒辦法，因為它跟「真的連資料庫」綁在一起，測一次就要起一個 DB。
- **想把同一套邏輯給 CLI 和 Web 兩種入口用**？做不到，邏輯被 HTTP 框架綁死。
- 一改就牽一髮動全身，因為所有東西都「知道」彼此。

> **核心痛點**：把「**會變的東西**」（資料庫選型、HTTP 框架、外部 API）跟「**你的核心價值**」（業務規則）**焊死在一起**。分層架構就是要把它們拆開，讓核心邏輯**不知道**自己被存到哪、透過什麼協定被呼叫。

---

## 9.3 分層架構：四層心智模型

我們把系統由內而外分成四層。**最重要的觀念只有一句：依賴永遠由外往內指，內層絕不知道外層的存在。**

```text
        ┌─────────────────────────────────────────┐
        │  interface（介面層）                       │  ← 最外層
        │  Axum handler、CLI、把外界請求翻成用例呼叫    │
        ├─────────────────────────────────────────┤
        │  infrastructure（基礎設施層）              │
        │  Postgres repo、reqwest client、實作 trait  │
        ├─────────────────────────────────────────┤
        │  application（用例層 / use case）          │
        │  「建立訂單」「查詢使用者」等流程編排           │
        ├─────────────────────────────────────────┤
        │  domain（領域層）                          │  ← 最內層、最純
        │  實體、值物件、業務規則、trait（port）         │
        └─────────────────────────────────────────┘
              依賴方向：外 ───────────────▶ 內
```

| 層 | 負責什麼 | 可以依賴誰 | 可以認識框架/DB 嗎 |
|----|---------|-----------|------------------|
| **domain** | 業務實體與規則、定義抽象介面（trait） | 誰都不依賴（最純） | ❌ 絕對不行 |
| **application** | 用例編排：組合 domain 完成一件事 | domain | ❌ 不行 |
| **infrastructure** | 實作 domain 定義的 trait（真的連 DB、打 API） | domain、application | ✅ 這裡才碰 |
| **interface** | 把外界請求（HTTP、CLI）翻成用例呼叫 | application、domain | ✅ 這裡才碰 |

> **心智模型**：domain 是「公司的核心 know-how」，寫在一本筆記本上，跟「用什麼電腦、走哪家快遞」無關。infrastructure 是「電腦與快遞」——可以隨時換。分層的目的，就是讓核心 know-how 不會因為換了一台電腦就得重寫。

### 洋蔥式的關鍵：內層定義「需要什麼」，外層負責「怎麼做到」

這是最反直覺、也最關鍵的一點。domain 說：「我**需要**一個能存訂單的東西」，但它**不管**這個東西是 Postgres 還是記憶體。它只定義一個 trait（介面）。真正「怎麼存」由 infrastructure 實作。這就是下一節的**依賴反轉**。

---

## 9.4 依賴反轉：讓業務邏輯不依賴資料庫

「依賴反轉原則（DIP）」聽起來很學術，一句話就懂：**不要讓高層邏輯依賴低層細節，兩者都依賴抽象。**

### 沒有反轉（錯）

```text
application  ───依賴──▶  PostgresRepo（具體）
```

application 直接 `use` 了 `PostgresRepo`。結果：換 DB 就得改 application，也沒法在測試時換成假的。

### 有反轉（對）

```text
application  ───依賴──▶  OrderRepository（trait，定義在 domain）
                              ▲
                              │ 實作
                        PostgresRepo（infrastructure）
```

application 只認識 `OrderRepository` 這個 trait。`PostgresRepo` **實作**它。箭頭「反」過來了——具體的 `PostgresRepo` 反過來依賴（實作）抽象。這樣：

- 換 DB？寫一個新的 `impl OrderRepository`，application 一行都不用改。
- 測試？寫一個 `InMemoryRepo` 實作同一個 trait，秒測業務邏輯，不碰真 DB。

### 用 trait 定義「port（介面）」

回扣第 03 章的 trait。我們在 **domain** 層定義一個 trait，描述「業務邏輯需要什麼能力」：

```rust
// domain 層：只定義「需要什麼」，不管「怎麼做」
use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct Order {
    pub id: u64,
    pub customer: String,
    pub amount: i64,        // 用最小貨幣單位（分），避免浮點誤差
}

// 這是一個「port」：業務邏輯對「儲存」的需求
#[async_trait]
pub trait OrderRepository: Send + Sync {
    async fn save(&self, order: &Order) -> Result<(), RepoError>;
    async fn find(&self, id: u64) -> Result<Option<Order>, RepoError>;
}

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("儲存後端故障：{0}")]
    Backend(String),
}
```

幾個要點：

- **`#[async_trait]`**：目前穩定版 Rust 的 trait 裡要放 `async fn`，最省事的做法是加 `async-trait` 這個 crate（`cargo add async-trait`）。它幫你把 async trait 方法包成回傳 `Box<dyn Future>`。（註：較新版 Rust 已逐步支援原生 async trait，但生態仍普遍用 `async_trait`，本課沿用它以求相容。）
- **`Send + Sync`**（回扣第 08 章）：因為這個 repo 之後會被多個 async task 共享（跨執行緒），所以 trait 要求實作者是執行緒安全的。
- 這個 trait **完全不提 SQL、不提 Postgres**。它只說「能存、能找」。這就是「port」——一個對外界能力的抽象需求。

### 六邊形架構（Hexagonal / Ports & Adapters）一句話版

你可能聽過「六邊形架構」「Ports and Adapters」。它就是上面這件事的正式名字：

- **Port（埠）**＝內層定義的 trait（`OrderRepository`）。
- **Adapter（轉接器）**＝外層對這個 trait 的具體實作（`PostgresOrderRepo`、`InMemoryOrderRepo`）。

> **心智模型**：port 像牆上的插座規格（220V 兩孔）；adapter 是你插上去的各種電器。core（你的業務邏輯）只認識插座規格，換什麼電器都行。

---

## 9.5 用 Cargo workspace 讓編譯器守住架構

分層最容易失守的地方是——**人會偷懶**。你嘴上說「domain 不能依賴 infrastructure」，但寫著寫著就在 domain 裡 `use` 了 `sqlx`。怎麼防？**讓編譯器幫你守。**

用第 06 章的 workspace，把每一層做成獨立 crate。**crate A 沒把 crate B 寫進 `Cargo.toml`，就根本 `use` 不到它**——依賴方向被編譯器強制執行。

### workspace 結構

```text
myshop/
├── Cargo.toml                  ← workspace 根
└── crates/
    ├── domain/                 ← 領域：實體 + trait（port），零框架依賴
    │   ├── Cargo.toml
    │   └── src/lib.rs
    ├── application/            ← 用例：依賴 domain
    │   ├── Cargo.toml
    │   └── src/lib.rs
    ├── infrastructure/         ← 實作：依賴 domain（+ application）
    │   ├── Cargo.toml
    │   └── src/lib.rs
    └── api/                    ← 進入點（bin）：組裝一切、跑 Axum
        ├── Cargo.toml
        └── src/main.rs
```

根 `Cargo.toml`：

```toml
[workspace]
resolver = "2"
members = ["crates/domain", "crates/application", "crates/infrastructure", "crates/api"]

# 用 workspace 統一管理版本，各 crate 直接繼承（避免版本打架）
[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
async-trait = "0.1"
thiserror = "1"
anyhow = "1"
serde = { version = "1", features = ["derive"] }
```

各 crate 的依賴宣告——**注意箭頭方向**：

```toml
# crates/domain/Cargo.toml —— 最純，不依賴任何一層，也不依賴框架
[dependencies]
async-trait = { workspace = true }
thiserror = { workspace = true }
serde = { workspace = true }
# ❌ 這裡「不會」出現 sqlx、axum、reqwest
```

```toml
# crates/application/Cargo.toml —— 只依賴 domain
[dependencies]
domain = { path = "../domain" }
async-trait = { workspace = true }
thiserror = { workspace = true }
```

```toml
# crates/infrastructure/Cargo.toml —— 依賴 domain，並在這裡「才」引入 DB/HTTP client
[dependencies]
domain = { path = "../domain" }
async-trait = { workspace = true }
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres"] }  # 第 10 章
reqwest = { version = "0.12", features = ["json"] }                    # 第 12 章
```

```toml
# crates/api/Cargo.toml —— 進入點：把所有層組裝起來
[dependencies]
domain = { path = "../domain" }
application = { path = "../application" }
infrastructure = { path = "../infrastructure" }
axum = "0.7"                                        # 第 11 章
tokio = { workspace = true }
anyhow = { workspace = true }
```

> **這就是重點**：如果哪天你手滑想在 `domain/src/lib.rs` 裡 `use sqlx::...`，因為 domain 的 `Cargo.toml` 根本沒有 sqlx，**編譯直接失敗**。架構不再是「口頭紀律」，而是「編譯器強制的規則」。這是 Rust 做分層架構的一大爽點。

> **對比其他語言**：Java/TS 也能分層，但層與層的邊界通常只靠「約定」或 lint 規則，人一偷懶就破功。Rust 的 crate 邊界是**物理隔離**——沒宣告依賴就是編譯不過，紀律變成強制。

---

## 9.6 各層長什麼樣：一個完整的縱切面

我們用「建立訂單」這個用例，把四層都寫一遍，讓你看到資料如何由外往內、實作如何由內往外。

### domain：實體 + 規則 + port（`crates/domain/src/lib.rs`）

```rust
use async_trait::async_trait;

// ── 實體與值物件 ──
#[derive(Debug, Clone)]
pub struct Order {
    pub id: OrderId,
    pub customer: String,
    pub amount: Money,
}

// newtype 模式：用型別區分「不同意義的數字」，避免傳錯（第 03 章）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrderId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Money(pub i64);       // 以「分」為單位

impl Money {
    // 業務規則活在 domain：金額不能是負的
    pub fn new(cents: i64) -> Result<Self, DomainError> {
        if cents < 0 {
            return Err(DomainError::InvalidAmount(cents));
        }
        Ok(Money(cents))
    }
}

// ── 錯誤（回扣第 04 章 thiserror）──
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("金額不可為負：{0}")]
    InvalidAmount(i64),
}

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("儲存後端故障：{0}")]
    Backend(String),
}

// ── port：業務對「儲存能力」的需求 ──
#[async_trait]
pub trait OrderRepository: Send + Sync {
    async fn save(&self, order: &Order) -> Result<(), RepoError>;
    async fn find(&self, id: OrderId) -> Result<Option<Order>, RepoError>;
}
```

### application：用例編排（`crates/application/src/lib.rs`）

用例層負責「把 domain 的東西組起來，完成一件事」。它拿到一個 `impl OrderRepository`，但**不知道**那是 Postgres 還是記憶體。

```rust
use domain::{DomainError, Money, Order, OrderId, OrderRepository, RepoError};

// 用例層自己的錯誤：把下層錯誤「往上翻譯」（回扣第 04 章 #[from]）
#[derive(Debug, thiserror::Error)]
pub enum CreateOrderError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error(transparent)]
    Repo(#[from] RepoError),
}

// 進來的資料（DTO）：跟外界溝通用的形狀，跟 domain 實體分開
pub struct CreateOrderInput {
    pub id: u64,
    pub customer: String,
    pub amount_cents: i64,
}

// 用例：接收一個 repo（抽象），完成「建立訂單」
pub struct CreateOrder<R: OrderRepository> {
    repo: R,
}

impl<R: OrderRepository> CreateOrder<R> {
    pub fn new(repo: R) -> Self {
        Self { repo }
    }

    pub async fn execute(&self, input: CreateOrderInput) -> Result<Order, CreateOrderError> {
        // 1. 用 domain 規則驗證/建構（金額不能負）
        let amount = Money::new(input.amount_cents)?;    // ? 自動把 DomainError 轉上去
        let order = Order {
            id: OrderId(input.id),
            customer: input.customer,
            amount,
        };
        // 2. 交給抽象的 repo 存起來（不知道底層是什麼）
        self.repo.save(&order).await?;                   // ? 自動把 RepoError 轉上去
        Ok(order)
    }
}
```

觀察：`CreateOrder<R: OrderRepository>` 用**泛型 + trait bound**（第 03 章）注入依賴。它對「怎麼存」一無所知，這正是我們要的。

### infrastructure：實作 port（`crates/infrastructure/src/lib.rs`）

這裡才出現「具體」。先做一個記憶體版（測試/開發用），第 10 章再做 Postgres 版：

```rust
use async_trait::async_trait;
use domain::{Order, OrderId, OrderRepository, RepoError};
use std::collections::HashMap;
use std::sync::Mutex;      // 回扣第 07/08 章

// 記憶體實作：拿來測試與本地開發超好用
#[derive(Default)]
pub struct InMemoryOrderRepo {
    store: Mutex<HashMap<u64, Order>>,
}

#[async_trait]
impl OrderRepository for InMemoryOrderRepo {
    async fn save(&self, order: &Order) -> Result<(), RepoError> {
        let mut map = self.store.lock().map_err(|e| RepoError::Backend(e.to_string()))?;
        map.insert(order.id.0, order.clone());
        Ok(())
    }

    async fn find(&self, id: OrderId) -> Result<Option<Order>, RepoError> {
        let map = self.store.lock().map_err(|e| RepoError::Backend(e.to_string()))?;
        Ok(map.get(&id.0).cloned())
    }
}
```

### interface / api：組裝一切（`crates/api/src/main.rs`）

進入點（第 06 章說的「薄薄的 bin」）負責「**組合根（composition root）**」——在這裡、也只在這裡，決定「用哪個具體實作」，把它們接起來。

```rust
use application::{CreateOrder, CreateOrderInput};
use infrastructure::InMemoryOrderRepo;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 組合根：在這裡選定「具體實作」，注入到用例裡
    let repo = InMemoryOrderRepo::default();
    let create_order = CreateOrder::new(repo);

    // 模擬一次呼叫（第 11 章會換成從 HTTP 進來）
    let order = create_order
        .execute(CreateOrderInput {
            id: 1,
            customer: "Alice".into(),
            amount_cents: 12_000,
        })
        .await?;

    println!("建立訂單成功：{order:?}");
    Ok(())
}
```

> **關鍵洞察**：整個系統只有 `main.rs`（組合根）知道「用的是 `InMemoryOrderRepo`」。第 10 章我們寫好 `PostgresOrderRepo` 後，**只要改這一行**——`let repo = PostgresOrderRepo::new(pool);`——其他所有層一個字都不用動。這就是分層 + 依賴反轉的回報。

---

## 9.7 錯誤要怎麼跨層？

回扣第 04 章：**每一層定義自己的錯誤型別，用 `#[from]` / `#[error(transparent)]` 把下層錯誤「往上翻譯」。**

```text
DomainError ──┐
              ├──▶ CreateOrderError（application 層）──▶ ApiError（interface 層，第 11 章映射成 HTTP 狀態碼）
RepoError  ───┘
```

- **底層**（domain / infrastructure）用 `thiserror` 定義**具體**錯誤，讓上層能 `match` 分辨。
- **用例層**用一個 enum 把各種下層錯誤 `#[from]` 收攏。
- **最外層**（第 11 章）再把它映射成 HTTP 狀態碼（例如 `DomainError::InvalidAmount` → `400`，`RepoError` → `500`）。

這樣「錯誤資訊的細節在內層保留，到外層才決定怎麼呈現」，既精確又不洩漏內部細節。

---

## 9.8 設定管理：別把組態寫死

一個能上線的服務，組態（資料庫連線字串、外部 API 金鑰、埠號、log 等級）**不能寫死在程式裡**，因為不同環境（本機 / 測試 / 正式）值不一樣，而且金鑰寫進原始碼會外洩。

業界標準做法（12-Factor App）：**組態從環境變數來**，本機開發用 `.env` 檔輔助。

### 定義設定結構

```rust
// crates/api/src/config.rs
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub database_url: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_log")]
    pub log_level: String,
    pub external_api_key: String,
}

fn default_port() -> u16 { 8080 }
fn default_log() -> String { "info".into() }

impl Config {
    // 從環境變數載入（本機會先讀 .env）
    pub fn from_env() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();                 // 本機有 .env 就載入；沒有也不報錯
        let cfg = envy::from_env::<Config>()?;  // 把環境變數映射成 struct
        Ok(cfg)
    }
}
```

搭配的 crate：

```bash
cargo add dotenvy       # 讀 .env 檔（僅本地開發用）
cargo add envy          # 把環境變數反序列化成 struct
cargo add serde --features derive
```

`.env`（本機開發用，**務必加進 `.gitignore`，絕不 commit**）：

```bash
DATABASE_URL=postgres://dev:dev@localhost:5432/myshop
PORT=8080
LOG_LEVEL=debug
EXTERNAL_API_KEY=sk-local-xxxx
```

在組合根載入：

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;      // 一開機就把組態讀進來、驗證好
    println!("將在埠 {} 啟動", config.port);
    // ... 用 config.database_url 建連線池（第 10 章）
    Ok(())
}
```

> **原則**：組態在「程式最外層、開機的第一步」就載入並驗證好，做成一個 `Config` struct，往內傳。**內層不該自己去 `std::env::var(...)` 東撈西撈**——那會讓依賴變得隱形又難測。設定也是一種「由外往內注入」的依賴。

> **進階選項**：更複雜的需求（多來源合併：預設值 + 設定檔 + 環境變數 + 命令列覆蓋）可用 [`config`](https://crates.io/crates/config) 或 [`figment`](https://crates.io/crates/figment) crate。原理都一樣：多層來源疊加，外層覆蓋內層。

---

## 9.9 依賴注入：Rust 沒有 DI 框架，也不需要

Java/Spring 有龐大的 DI 容器，Rust 生態則偏好**手動注入**——就是我們一直在做的：**在組合根 `new(...)` 時把依賴當參數傳進去**（constructor injection）。

Rust 常見兩種注入風格：

```rust
// 風格 A：泛型（編譯期決定，零成本、單型別）
pub struct CreateOrder<R: OrderRepository> { repo: R }

// 風格 B：trait object（執行期多型，用 dyn，第 07 章）
pub struct CreateOrder {
    repo: std::sync::Arc<dyn OrderRepository>,   // Arc 讓它能被多個 task 共享
}
```

| | 泛型 `<R: Trait>` | trait object `Arc<dyn Trait>` |
|---|---|---|
| 決定時機 | 編譯期（靜態分派） | 執行期（動態分派） |
| 效能 | 零成本，可 inline | 有一次指標跳轉（極小） |
| 彈性 | 一個型別固定一種實作 | 可在執行期換實作、放進集合 |
| 適合 | 用例本身 | 共享的 `AppState`、需要抹平型別時 |

實務上，Web 服務常把共享依賴（repo、外部 client、設定）包進一個 **`AppState`**，用 `Arc` 包起來讓所有 handler 共享（第 11 章會大量使用）：

```rust
use std::sync::Arc;

#[derive(Clone)]                             // Axum 的 State 需要能 Clone
pub struct AppState {
    pub orders: Arc<dyn domain::OrderRepository>,
    pub config: Arc<Config>,
}
```

`Arc`（回扣第 07 章）讓多個 async task 安全共享同一份 repo，`clone` 只是加參考計數、不複製底層資料——這正是共享狀態的標準做法。

---

## 9.10 綜合範例：把架構跑起來（含測試）

把本章串起來——一個能編譯、能測試的最小分層專案。重點在 **application 層的測試根本不需要真資料庫**，因為我們注入了記憶體版 repo：

```rust
// crates/application/src/lib.rs 底部
#[cfg(test)]
mod tests {
    use super::*;
    use infrastructure::InMemoryOrderRepo;   // 測試才用得到（放 dev-dependencies）

    #[tokio::test]                            // async 測試（回扣第 08 章）
    async fn create_order_succeeds() {
        let uc = CreateOrder::new(InMemoryOrderRepo::default());
        let order = uc
            .execute(CreateOrderInput { id: 1, customer: "Bob".into(), amount_cents: 500 })
            .await
            .unwrap();
        assert_eq!(order.amount.0, 500);
    }

    #[tokio::test]
    async fn negative_amount_is_rejected() {
        let uc = CreateOrder::new(InMemoryOrderRepo::default());
        let err = uc
            .execute(CreateOrderInput { id: 2, customer: "Bob".into(), amount_cents: -1 })
            .await
            .unwrap_err();
        // 業務規則錯誤，且完全沒碰資料庫
        assert!(matches!(err, CreateOrderError::Domain(_)));
    }
}
```

`crates/application/Cargo.toml` 補上：

```toml
[dev-dependencies]
infrastructure = { path = "../infrastructure" }
tokio = { workspace = true }
```

> **這就是分層的最大回報**：業務規則的測試**又快又不依賴外部環境**。你不用起 Docker、不用連 DB，`cargo test` 毫秒級跑完。等第 10 章有了 Postgres 版 repo，那些「真的連 DB」的測試歸為整合測試，跟這些單元測試分開跑。

---

## 9.11 常見錯誤

- **domain 裡 `use` 了框架/DB**（sqlx、axum）→ 汙染核心層。靠 workspace 把 domain 的依賴清乾淨，讓編譯器擋住。
- **把 DTO（對外的資料形狀）當成 domain 實體**→ 外部 API 一改，你的核心模型就被牽動。兩者要分開，用例層負責轉換。
- **在內層直接讀 `std::env::var`**→ 依賴變隱形、難測。組態在組合根載入後往內注入。
- **金鑰、連線字串寫死或 commit 進 git**→ 外洩風險。用環境變數 + `.env`（且 `.env` 進 `.gitignore`）。
- **想用 async fn 卻放進普通 trait**→ 加 `#[async_trait]`，或改用支援原生 async trait 的新版寫法。
- **一開始就過度設計**（小服務也硬拆四層 + 一堆 trait）→ 分層是為了「應付變化」，變化不大的小工具別過度抽象。先讓它會動，複雜到痛了再拆。
- **忘了 trait 加 `Send + Sync`**→ 之後要在多 task 間共享會編譯錯（回扣第 08 章）。

---

## 9.12 本章小結

- **分層的目的**：把「會變的細節」（DB、框架、外部 API）跟「你的核心價值」（業務規則）拆開，讓核心不被綁死。
- **四層**：domain（純業務 + trait）、application（用例編排）、infrastructure（實作 trait、碰 DB/HTTP）、interface（翻譯外界請求）。
- **依賴方向**：永遠由外往內，內層不知道外層。
- **依賴反轉**：內層定義 trait（port），外層實作（adapter）；業務邏輯只認識抽象。
- **Cargo workspace** 把每層做成獨立 crate，用**編譯器**強制守住依賴方向——沒宣告依賴就 `use` 不到。
- **錯誤跨層**：每層自己的錯誤型別，用 `#[from]` 往上翻譯，最外層才映射成 HTTP。
- **設定**：從環境變數載入（`.env` 輔助本機），在組合根載好、往內注入；金鑰絕不寫死。
- **依賴注入**：Rust 用「建構子注入」+ 泛型或 `Arc<dyn Trait>`，共享狀態包進 `AppState`。不需要 DI 框架。

---

## 9.13 動手作業

1. 開一個 workspace，建 `domain`、`application`、`infrastructure`、`api` 四個 crate，`cargo build` 全過。
2. 在 `domain` 定義一個 `User` 實體與 `UserRepository` trait（`save` / `find_by_email`）。
3. 在 `infrastructure` 寫一個 `InMemoryUserRepo` 實作該 trait。
4. 在 `application` 寫一個 `RegisterUser` 用例，注入 `UserRepository`，加一條業務規則（例如 email 不可為空）。
5. 為第 4 題寫兩個 `#[tokio::test]`：一個成功、一個違反規則失敗，**過程完全不碰真資料庫**。
6. 故意在 `domain/src/lib.rs` 加一行 `use sqlx;`，觀察編譯報什麼錯，體會「架構被編譯器強制」的感覺，再刪掉。
7. 加一個 `Config`（用 `envy` + `dotenvy`），從 `.env` 讀 `PORT` 與 `DATABASE_URL`，在 `main` 印出來。

---

## 9.14 驗收清單

- [ ] 我能說出「為什麼要分層」以及不分層的代價。
- [ ] 我能畫出四層架構並說明「依賴永遠由外往內」。
- [ ] 我理解依賴反轉：內層定義 trait（port），外層實作（adapter）。
- [ ] 我會用 workspace 把每層拆成 crate，並知道這能讓編譯器強制守住依賴方向。
- [ ] 我會用 trait 定義 `Repository`，並用泛型或 `Arc<dyn Trait>` 注入。
- [ ] 我知道組態要從環境變數載入、在組合根注入，金鑰不寫死。
- [ ] 我能只靠記憶體版 repo，就測試業務邏輯（不碰真 DB）。

---

**架構篇（09）到此完成。** 你已經有了整個後端的「設計骨架」：一個乾淨、可測、可替換的分層系統，而且 `Repository` trait 這個 port 已經備好插座。

下一章 [10-database-integration-sqlx-orm.md](./10-database-integration-sqlx-orm.md) 就要來接上第一個真正的 adapter——用 **SQLx** 連 PostgreSQL，寫一個 `PostgresOrderRepo` 實作本章的 `OrderRepository` trait。你會發現，因為架構已經備好，接資料庫時「業務邏輯一行都不用動」。回到 [課程首頁](./README.md) 可複習任何章節。
