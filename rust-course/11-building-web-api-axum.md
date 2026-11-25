# 第 11 章：建立 Web API —— 用 Axum 打造 RESTful 服務

> 前兩章我們把「業務邏輯」和「資料庫」都準備好了。這一章要幫服務「對外開門」——讓外界能透過 HTTP 呼叫它。
> 我們用 **Axum**：Tokio 官方生態的 web 框架，跑在第 08 章的 async runtime 上，設計乾淨、型別安全、跟 Rust 生態接得天衣無縫。
> 你會看到一個很重要的觀念：**handler 應該很「薄」**——它只負責「把 HTTP 請求翻成用例呼叫、把結果組成 HTTP 回應」，真正的邏輯都在第 09、10 章那幾層。
> 這章跑完，你就有一個能被 `curl`、被前端、被任何 client 呼叫的真正 API 了。

---

## 11.1 學習目標

完成本章後，你應該可以：

- 說出 Axum 的定位，以及它跟 Tokio、Tower、Hyper 的關係。
- 用 `Router` 定義路由，寫出第一個 handler，跑起一個 HTTP server。
- 用**擷取器（extractor）**取出路徑參數、查詢字串、JSON body。
- 用 `State` 把第 09 章的 `AppState`（含 repo、設定）注入 handler。
- 用 `IntoResponse` 回傳 JSON，並把第 09 章的分層錯誤**映射成 HTTP 狀態碼**。
- 用 Tower middleware 加上 logging、CORS、逾時等橫切關注。
- 做請求驗證（validation），並優雅回報錯誤。
- 把前面所有層接起來，做出一組完整的 RESTful CRUD 端點，並加上優雅關機。

---

## 11.2 Axum 是什麼？它站在誰的肩膀上

Axum 不是從零造輪子，它站在 Tokio 生態的三層之上：

```text
        Axum        ← 你寫的東西：Router、handler、extractor（人體工學層）
          │
        Tower       ← middleware 抽象：logging、逾時、重試、限流（可組合的 Service）
          │
        Hyper       ← HTTP 協定實作：解析請求、產生回應
          │
        Tokio       ← async runtime（第 08 章）：驅動一切
```

- **Hyper**：底層 HTTP 引擎，處理 HTTP/1、HTTP/2 的位元組。
- **Tower**：定義了「`Service`」這個抽象——「輸入請求、輸出回應」的可組合單元。middleware 就是 Tower layer。
- **Axum**：把上面兩者包成好用的 API，讓你用「函式當 handler、型別當 extractor」的方式寫 web。

> **為什麼選 Axum？** 它是 Tokio 團隊維護、生態相容性最好、設計最貼近 Rust 型別系統的框架。你的 handler 就是普通 `async fn`，參數用「型別」表達你要什麼（要 JSON body 就寫 `Json<T>`、要路徑參數就寫 `Path<T>`），回傳實作 `IntoResponse` 的東西即可。沒有魔法巨集路由、沒有隱藏的全域狀態。

加依賴。HTTP 是最外層，所以都加到 `api` 這個 crate（`tokio`、`serde` 第 09 章已經加過）：

```bash
# 在 myshop/ 根目錄執行
cargo add -p api axum@0.8
cargo add -p api serde_json thiserror                               # thiserror 沿用 workspace 版本
cargo add -p api tower-http@0.7 --features trace,cors,timeout       # middleware
cargo add -p api tracing@0.1                                         # 結構化日誌
cargo add -p api tracing-subscriber@0.3 --features env-filter        # env-filter：用 RUST_LOG 控制 log 等級
```

> 想先在獨立的小專案練 11.3～11.10：在 `myshop/` 以外的目錄 `cargo new axum-lab`，上面的指令拿掉 `-p api`，再加 `cargo add tokio --features full` 與 `cargo add serde --features derive`。

---

## 11.3 最小可跑的 server

```rust
use axum::{routing::get, Router};

// handler 就是一個 async fn，回傳能變成回應的東西
async fn hello() -> &'static str {
    "Hello, Axum!"
}

#[tokio::main]                                    // 第 08 章：啟動 Tokio runtime
async fn main() {
    let app = Router::new()                       // 建路由表
        .route("/", get(hello));                  // GET / → hello

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .unwrap();
    println!("listening on http://0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();    // 開跑
}
```

```bash
cargo run
curl http://localhost:8080/        # → Hello, Axum!
```

三個組成：**`Router`**（路由表）、**handler**（`async fn`）、**`axum::serve`**（把路由掛到監聽的埠上）。就這麼簡單。

---

## 11.4 路由：`Router` 與 HTTP 方法

```rust
use axum::{routing::{get, post, put, delete}, Router};

let app = Router::new()
    .route("/health", get(health))
    .route("/orders", get(list_orders).post(create_order))    // 同路徑不同方法可鏈式
    .route("/orders/{id}", get(get_order).put(update_order).delete(delete_order));
```

- `get(handler)`、`post(...)`、`put(...)`、`delete(...)` 對應 HTTP 方法。
- **同一路徑、不同方法**用鏈式：`get(list).post(create)`。
- **路徑參數**用大括號：`/orders/{id}`。這是 Axum 0.8 的語法；0.7 以前寫成 `/orders/:id`，網路上的舊文章常看到。在 0.8 寫 `:id` 不會編譯錯誤，而是**程式一啟動建路由時就 panic**（`Path segments must not start with ':'`）。

### 巢狀路由與前綴

大型 API 會把路由分組，用 `nest` 加前綴：

```rust
let api = Router::new()
    .route("/orders", get(list_orders).post(create_order))
    .route("/orders/{id}", get(get_order));

let app = Router::new()
    .nest("/api/v1", api);          // 全部端點自動加上 /api/v1 前綴
```

> **心智模型**：`Router` 是一張「路徑 + 方法 → handler」的對照表。請求進來，Axum 依「方法 + 路徑」查表，找到對應 handler 呼叫它。`nest` 就是把一整組表掛到某個前綴底下。

---

## 11.5 擷取器（Extractor）：用型別說「我要什麼」

Axum 最優雅的設計是**擷取器**：handler 的參數型別，就是在宣告「我要從請求裡拿什麼」。Axum 會自動幫你解析、驗證、注入。

```rust
use axum::extract::{Path, Query, State, Json};
use serde::Deserialize;

// 1. Path：路徑參數 /orders/{id}
async fn get_order(Path(id): Path<u64>) -> String {
    format!("查訂單 {id}")
}

// 2. Query：查詢字串 ?page=2&size=10
#[derive(Deserialize)]
struct Pagination { page: u32, size: u32 }
async fn list_orders(Query(p): Query<Pagination>) -> String {
    format!("第 {} 頁，每頁 {}", p.page, p.size)
}

// 3. Json：請求 body 的 JSON，自動反序列化成 struct（靠 serde）
#[derive(Deserialize)]
struct CreateOrderBody { customer: String, amount_cents: i64 }
async fn create_order(Json(body): Json<CreateOrderBody>) -> String {
    format!("建立 {} 的訂單，金額 {}", body.customer, body.amount_cents)
}
```

`serde` 是 Rust 生態最常用的序列化/反序列化 crate。後端 API 幾乎都會用它把 JSON 轉成 Rust struct、再把 Rust struct 轉回 JSON。幾個常見屬性先認得：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateOrderBody {
    customer: String,
    amount_cents: i64,
}
```

- `rename_all = "camelCase"`：外部 JSON 用 `amountCents`，Rust 欄位仍維持慣用的 `amount_cents`。
- `deny_unknown_fields`：client 傳了 API 沒定義的欄位就拒絕，避免拼錯欄位卻悄悄被忽略。
- 對外的 request/response struct（DTO）建議跟 domain entity 分開；HTTP 契約變動不應直接拉動核心業務型別。

常用擷取器一覽：

| 擷取器 | 取什麼 | 對應 |
|--------|--------|------|
| `Path<T>` | 路徑參數 | `/orders/{id}` 的 `id` |
| `Query<T>` | 查詢字串 | `?page=2&size=10` |
| `Json<T>` | 請求 body（JSON） | POST/PUT 的 body |
| `State<S>` | 共享狀態 | 你的 `AppState`（下一節） |
| `HeaderMap` | 請求標頭 | `Authorization` 等 |

> **順序與規則**：extractor 在參數列可以有多個，但「消耗 body 的 extractor」（如 `Json`）**只能有一個、且要放最後**（因為 body 只能讀一次）。違反時是**編譯錯誤**，但訊息很難讀：``the trait bound `fn(...) {create_order}: Handler<_, _>` is not satisfied``。遇到這種錯誤，在 handler 上方加 `#[axum::debug_handler]`（要開 axum 的 `macros` feature：`cargo add -p api axum@0.8 --features macros`），編譯器就會直接指出是哪個參數有問題。handler 不是 `async fn`、回傳型別沒實作 `IntoResponse`、某個參數不是 extractor，也都是同一個錯誤訊息，用同一招查。

> **對比其他框架**：很多框架用「從一個 `Request` 物件裡自己撈」（`req.params['id']`、`req.body`），型別全靠你自己記、撈錯了執行期才爆。Axum 反過來——**你用型別宣告需求，框架保證給你對的東西**，撈不到它自動回錯誤，不用你寫：路徑參數解析失敗（`/orders/abc` 對 `Path<u64>`）回 `400`；JSON 語法錯回 `400`；JSON 合法但缺欄位、型別不對回 `422`；沒帶 `Content-Type: application/json` 回 `415`。這些內建錯誤的 body 是純文字，不是 11.8 節那種 JSON 格式；想統一成 JSON，可以替這些 rejection 型別（如 `axum::extract::rejection::JsonRejection`）實作轉換、包成自己的 extractor，等 API 穩定後再做即可。

---

## 11.6 回應：`IntoResponse` 與回傳 JSON

handler 回傳任何實作 `IntoResponse` 的東西都行。`&str`、`String`、`(StatusCode, ...)`、`Json<T>` 都實作了它。

```rust
use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;

#[derive(Serialize)]
struct OrderView { id: u64, customer: String, amount_cents: i64 }

// 回傳 JSON + 狀態碼
async fn get_order(Path(id): Path<u64>) -> impl IntoResponse {
    let view = OrderView { id, customer: "Alice".into(), amount_cents: 12000 };
    (StatusCode::OK, Json(view))          // (狀態碼, body) 這個 tuple 也實作 IntoResponse
}

// 建立成功回 201 Created
async fn create_order(Json(body): Json<CreateOrderBody>) -> impl IntoResponse {
    // ... 存起來
    (StatusCode::CREATED, Json(OrderView { id: 1, customer: body.customer, amount_cents: body.amount_cents }))
}
```

- `Json(某個 Serialize 的東西)` 會自動序列化成 JSON、設好 `Content-Type: application/json`。
- 想控制狀態碼，回傳 `(StatusCode::XXX, Json(...))` 的 tuple。
- 回傳型別寫 `impl IntoResponse` 最省事。但要注意：`impl Trait` 代表「某一個固定的型別」，所以每個分支回傳的型別必須相同；分支要回不同東西時，在每個分支後面加 `.into_response()`，統一轉成 `Response`（下一節的 `match` 就是這樣寫）。

---

## 11.7 State：把第 09 章的 `AppState` 注入 handler

真正的 handler 需要用到 repo、設定、外部 client——這些共享依賴用 **`State`** 注入。回扣第 09 章的 `AppState` + 第 10 章的 `PgPool`。

```rust
use axum::extract::State;
use std::sync::Arc;

// 共享狀態：包住所有依賴（第 09 章）
#[derive(Clone)]                                       // State 必須能 Clone
struct AppState {
    // 用例保持泛型，這裡把 R 指定成 Arc<dyn OrderRepository>（第 09 章 9.9 節「兩種風格並用」）
    create_order: Arc<application::CreateOrder<Arc<dyn domain::OrderRepository>>>,
    orders: Arc<dyn domain::OrderRepository>,          // 第 09 章的 port，第 10 章的 Postgres 實作
    // config: Arc<Config>, external: Arc<WeatherClient>, ...（第 12 章會加）
}

async fn get_order(
    State(state): State<AppState>,                     // 注入共享狀態
    Path(id): Path<u64>,
) -> impl IntoResponse {
    // OrderView::from 的實作在 11.11 節
    match state.orders.find(domain::OrderId(id)).await {
        Ok(Some(order)) => (StatusCode::OK, Json(OrderView::from(order))).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "訂單不存在").into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "伺服器錯誤").into_response(),
    }
}
```

在組合根組好 state、掛到 router：

```rust
// 組合根：建「一份」repo，同時交給用例和查詢 handler（第 10 章的 PgOrderRepo）
let repo: Arc<dyn domain::OrderRepository> = Arc::new(PgOrderRepo::new(pool));
let state = AppState {
    create_order: Arc::new(application::CreateOrder::new(repo.clone())),   // clone 的是 Arc，不是 repo
    orders: repo,
};

let app = Router::new()
    .route("/orders/{id}", get(get_order))
    .with_state(state);                          // 綁定狀態，所有 handler 都能 State 取用
```

- **`#[derive(Clone)]`**：Axum 每個請求會 clone 一份 state 給 handler。因為裡面是 `Arc`（第 07 章），clone 只是加參考計數，不會複製底層資料——共享同一個 repo、同一個連線池。
- `Arc<dyn domain::OrderRepository>`：這是第 09 章「trait object 注入」的實戰——handler 只認識抽象 trait，執行期是 Postgres 版還是記憶體版由組合根決定。`AppState` 裡完全沒有寫死 `PgOrderRepo`，所以 11.13 節測試時可以整個換成記憶體版。
- 用例和 `orders` 拿到的是**同一個** repo：用例存進去的訂單，`orders.find` 一定查得到。如果各自 `new` 一個記憶體版 repo，兩邊會是兩份互不相通的資料。

> **這裡把三章縫起來了**：第 09 章的 `OrderRepository` trait + 第 10 章的 `PgOrderRepo` 實作 + 本章的 `State` 注入。handler 呼叫 `state.orders.find(...)`，完全不知道底層是 Postgres——這就是分層的威力。

---

## 11.8 錯誤映射：把分層錯誤變成 HTTP 狀態碼

上面 handler 裡那串 `match` 很囉嗦，而且每個 handler 都要重寫。更好的做法是：**為你的錯誤型別實作 `IntoResponse`**，讓 handler 用 `?` 就自動把錯誤變成對的 HTTP 回應。這是第 04、09 章「錯誤跨層翻譯」的最後一站。

```rust
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

// interface 層自己的錯誤（回扣第 09 章：最外層才決定怎麼呈現）
#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("找不到資源")]
    NotFound,
    #[error(transparent)]
    Domain(#[from] domain::DomainError),         // 業務規則錯 → 通常是 400
    #[error(transparent)]
    Application(#[from] application::CreateOrderError),
    #[error(transparent)]
    Repo(#[from] domain::RepoError),             // 查詢時的儲存錯誤 → 500
}

// 關鍵：定義「哪種錯誤 → 哪個 HTTP 狀態碼」
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            ApiError::Domain(_) => (StatusCode::BAD_REQUEST, self.to_string()),        // 業務規則違反 → 400
            ApiError::Application(application::CreateOrderError::Domain(e)) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Application(application::CreateOrderError::Repo(_)) | ApiError::Repo(_) => {
                tracing::error!(error = %self, "內部錯誤");    // 完整原因只記在伺服器 log（11.10 節設定 tracing）
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        // 統一的 JSON 錯誤格式，讓前端好處理
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
```

`match` 必須涵蓋每一種錯誤。之後替 `ApiError` 加新變體卻忘了決定它的狀態碼，編譯器會直接報錯提醒你——錯誤對應表不會悄悄漏一角。

有了它，handler 就能用 `?` 寫得超乾淨——回傳型別改成 `Result<成功回應, ApiError>`：

```rust
// CreateOrderBody 的完整定義（含 id 欄位）見 11.11 節
async fn create_order(
    State(state): State<AppState>,
    Json(body): Json<CreateOrderBody>,
) -> Result<impl IntoResponse, ApiError> {          // Result 的 Err 分支會自動 into_response
    let order = state
        .create_order
        .execute(application::CreateOrderInput {
            id: body.id,
            customer: body.customer,
            amount_cents: body.amount_cents,
        })
        .await?;                                     // 用例錯誤 → 經 #[from] → ApiError → HTTP

    Ok((StatusCode::CREATED, Json(OrderView::from(order))))
}
```

發生了什麼：

1. 用例回傳 `CreateOrderError`，`?` 透過 `#[from]` 自動轉成 `ApiError`。
2. handler 回傳 `Result<_, ApiError>`，Axum 看到 `Err(ApiError)` 就呼叫我們寫的 `into_response()`。
3. `into_response()` 依錯誤種類決定狀態碼與 JSON body。

> **錯誤翻譯的全鏈**（回扣第 04、09、10 章）：
> `sqlx::Error` → `RepoError` → `CreateOrderError` → `ApiError` → HTTP 狀態碼 + JSON。
> 查詢類的 handler 直接呼叫 repo，則是 `RepoError` → `ApiError::Repo` → 500。
> 每一層只認識「下一層的錯誤」，最外層才決定「對外長怎樣」。內部細節（例如 SQL 錯誤訊息）**不會洩漏給 client**——這既安全又乾淨。

> **安全提醒**：500 類錯誤對外只回「internal error」，**別把資料庫錯誤原文回給 client**（可能洩漏結構、路徑）。但要在伺服器端用 `tracing` 把完整錯誤記下來（上面 `tracing::error!` 那行；log 的設定在 11.10 節），方便你除錯。這也是為什麼 `Repo` 變體要帶著原本的錯誤：如果寫成 `.map_err(|_| ApiError::...)` 把錯誤丟掉，log 裡就只剩一句「出錯了」。

---

## 11.9 請求驗證（Validation）

`Json<T>` 只保證「JSON 格式對、欄位型別對」，但**業務層級的驗證**（email 格式、金額範圍、字串長度）要另外做。兩種層次：

**1. 讓 domain 把關（最可靠）**：把驗證放進 domain 的建構函式（第 09 章的 `Money::new` 就會擋負數）。錯誤沿著 `?` 一路變成 `400`。這是首選——規則集中在一處、無法繞過。

**2. 用 `validator` crate 在邊界做基本檢查**：對「純格式」的東西（email、長度）很方便。

```bash
cargo add -p api validator@0.21 --features derive
```

先讓 `ApiError` 認得驗證錯誤：加一個變體，並在 `into_response` 的 `match` 補上它的狀態碼（不補的話編譯器會提醒你 `match` 沒涵蓋所有情況）：

```rust
enum ApiError {
    // ...（11.8 節的其他變體）
    #[error("請求資料不合法：{0}")]
    Validation(#[from] validator::ValidationErrors),
}

// into_response 的 match 裡加一行：
// ApiError::Validation(_) => (StatusCode::BAD_REQUEST, self.to_string()),
```

然後在 DTO 上標註規則、在 handler 裡呼叫 `validate()`：

```rust
use validator::Validate;
use serde::Deserialize;

#[derive(Deserialize, Validate)]
struct CreateUserBody {
    #[validate(email)]                              // 必須是 email 格式
    email: String,
    #[validate(length(min = 1, max = 100))]        // 長度限制
    name: String,
}

async fn create_user(Json(body): Json<CreateUserBody>) -> Result<impl IntoResponse, ApiError> {
    body.validate()?;              // 驗證失敗 → ValidationErrors →（#[from]）ApiError::Validation → 400
    // ... 通過才繼續
    Ok(StatusCode::CREATED)
}
```

> **原則**：邊界（validator）擋「格式錯」，domain 擋「業務規則錯」。**核心業務規則一定要放 domain**——因為別的入口（CLI、排程、測試）也會用到，放邊界會漏。validator 是輔助、不是主力。

---

## 11.10 Middleware：橫切關注（logging、CORS、逾時）

有些事情「每個請求都要做」：記 log、加 CORS 標頭、設逾時、驗證 token。這些叫**橫切關注**，用 middleware 統一處理，別散在每個 handler 裡。Axum 的 middleware 就是 Tower layer。

```rust
use axum::http::StatusCode;
use tower_http::{trace::TraceLayer, cors::CorsLayer, timeout::TimeoutLayer};
use std::time::Duration;

let app = Router::new()
    .route("/orders", get(list_orders).post(create_order))
    // 每個請求最多 10 秒，逾時回 408（狀態碼要明確指定；舊的 TimeoutLayer::new 已標為 deprecated）
    .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(10)))
    .layer(CorsLayer::permissive())                       // CORS（正式環境要收緊白名單）
    .layer(TraceLayer::new_for_http())                   // 自動記錄每個請求/回應（配合 tracing）
    .with_state(state);
```

先設定 `tracing` 才看得到 log（在 `main` 的第一行呼叫 `init_tracing()`）：

```rust
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

fn init_tracing() {
    // 有設環境變數 RUST_LOG 就照它；沒設就用預設的 "info,tower_http=debug"
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=debug"));
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .init();
}
```

`EnvFilter` 需要 `tracing-subscriber` 的 `env-filter` feature（11.2 節已加）。過濾字串的意思是「預設只顯示 info 以上，`tower_http` 這個模組放寬到 debug」——`TraceLayer` 的每請求紀錄是 debug 等級，不放寬就看不到。臨時想看更細：`RUST_LOG=debug cargo run -p api`。

- **`.layer(...)`**：把 middleware 包在整個 router 外。多個 layer 由**下往上**包（最後加的最外層先執行）。
- **`TraceLayer`**：自動幫每個請求記 method、path、狀態碼、耗時——生產環境必備。
- **`CorsLayer`**：處理跨域。`permissive()` 是開發用，正式要用 `CorsLayer::new().allow_origin(...)` 限定來源。
- **`TimeoutLayer`**：避免某個慢請求把連線卡死。

> **自訂 middleware**：需要自己寫（例如驗 JWT）時，用 `axum::middleware::from_fn`。下面是只檢查「有沒有帶 Bearer token」的骨架，真正的驗簽邏輯放在註解那一段：
>
> ```rust
> use axum::{extract::Request, http::{header, StatusCode}, middleware::Next, response::Response};
>
> async fn auth(req: Request, next: Next) -> Result<Response, StatusCode> {
>     let has_token = req
>         .headers()
>         .get(header::AUTHORIZATION)
>         .and_then(|v| v.to_str().ok())
>         .is_some_and(|v| v.starts_with("Bearer "));
>     // 實務上這裡要驗證 token 的簽章與期限
>     if has_token { Ok(next.run(req).await) } else { Err(StatusCode::UNAUTHORIZED) }
> }
> // 掛上去：.layer(axum::middleware::from_fn(auth))
> ```

---

## 11.11 綜合範例：一組完整的 RESTful CRUD

把本章串起來——一組真正的訂單 API，接上第 09、10 章。這是第 13 章成品的雛形。整份放在 `crates/api/src/main.rs`（取代第 10 章那個暫時的 `main`；`config.rs` 沿用第 09 章）：

```rust
mod config;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use config::Config;
use infrastructure::PgOrderRepo;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
struct AppState {
    create_order: Arc<application::CreateOrder<Arc<dyn domain::OrderRepository>>>,
    orders: Arc<dyn domain::OrderRepository>,
}

// ── 對外的資料形狀（DTO，跟 domain 實體分開，第 09 章）──
#[derive(Deserialize)]
struct CreateOrderBody { id: u64, customer: String, amount_cents: i64 }

#[derive(Serialize)]
struct OrderView { id: u64, customer: String, amount_cents: i64 }

impl From<domain::Order> for OrderView {
    fn from(o: domain::Order) -> Self {
        OrderView { id: o.id.0, customer: o.customer, amount_cents: o.amount.0 }
    }
}

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("找不到資源")]
    NotFound,
    #[error(transparent)]
    Domain(#[from] domain::DomainError),
    #[error(transparent)]
    Application(#[from] application::CreateOrderError),
    #[error(transparent)]
    Repo(#[from] domain::RepoError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            ApiError::Domain(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ApiError::Application(application::CreateOrderError::Domain(e)) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Application(application::CreateOrderError::Repo(_)) | ApiError::Repo(_) => {
                tracing::error!(error = %self, "內部錯誤");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

// ── handlers（很薄！只翻譯 + 呼叫用例 + 組回應）──
async fn create_order(
    State(state): State<AppState>,
    Json(body): Json<CreateOrderBody>,
) -> Result<impl IntoResponse, ApiError> {
    let order = state.create_order.execute(application::CreateOrderInput {
        id: body.id, customer: body.customer, amount_cents: body.amount_cents,
    }).await?;
    Ok((StatusCode::CREATED, Json(OrderView::from(order))))
}

async fn get_order(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> Result<impl IntoResponse, ApiError> {
    let order = state.orders.find(domain::OrderId(id)).await?   // RepoError → ApiError::Repo
        .ok_or(ApiError::NotFound)?;                             // None → 404
    Ok(Json(OrderView::from(order)))
}

async fn list_orders(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let orders = state.orders.list().await?;
    Ok(Json(orders.into_iter().map(OrderView::from).collect::<Vec<_>>()))
}

async fn health() -> &'static str { "ok" }

// ── 組裝路由 ──
fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/orders", get(list_orders).post(create_order))
        .route("/orders/{id}", get(get_order))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

// init_tracing() 就是 11.10 節那個函式，貼在這裡

// ── 組合根 ──
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    let config = Config::from_env()?;

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("../../migrations").run(&pool).await?;

    // 同一個 repo（同一個 Arc）同時交給用例和查詢 handler
    let repo: Arc<dyn domain::OrderRepository> = Arc::new(PgOrderRepo::new(pool));
    let state = AppState {
        create_order: Arc::new(application::CreateOrder::new(repo.clone())),
        orders: repo,
    };

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", config.port)).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);
    axum::serve(listener, build_router(state)).await?;
    Ok(())
}
```

觀察 handler 有多薄：**取請求 → 呼叫用例 → 把結果轉 DTO → 回應**。沒有業務邏輯、沒有 SQL。這正是分層的目標——HTTP 只是「一種入口」，換成 gRPC、CLI，下面幾層原封不動。

跑起來（Postgres 要開著，`.env` 有 `DATABASE_URL` 與 `EXTERNAL_API_KEY`），再開另一個終端機測試 API：

```bash
docker compose up -d
cargo run -p api
```

```bash
curl -i -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{"id":1,"customer":"Alice","amount_cents":12000}'
# → 201 {"id":1,"customer":"Alice","amount_cents":12000}

curl -i http://localhost:8080/orders/1        # → 200 {"id":1,"customer":"Alice","amount_cents":12000}
curl -i http://localhost:8080/orders/999      # → 404 {"error":"找不到資源"}
curl -i -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{"id":2,"customer":"Bob","amount_cents":-5}'
# → 400 {"error":"金額不可為負：-5"}（domain 的 Money::new 擋下來的）
```

`curl -i` 會連狀態列一起印出來，方便確認狀態碼。

---

## 11.12 優雅關機（Graceful Shutdown）

正式服務被要求關閉時（部署、擴縮容），不該直接砍斷正在處理的請求，而要「不收新請求、等手上的做完、再關」。Axum 內建支援：

```rust
// 等到「Ctrl-C」或「SIGTERM」其中一個先來
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("安裝 Ctrl-C handler 失敗");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("安裝 SIGTERM handler 失敗")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();   // Windows 沒有 SIGTERM：永遠不會完成

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("收到關機訊號，優雅關閉中…");
}

// 把 11.11 main 裡的 axum::serve 那行換成：
axum::serve(listener, build_router(state))
    .with_graceful_shutdown(shutdown_signal())     // 收到訊號後不再收新連線，等現有請求做完才關
    .await?;
```

- **為什麼要接 SIGTERM**：你在終端機按 Ctrl-C 送的是 SIGINT；但 `docker stop`、Kubernetes 要停掉容器時送的是 **SIGTERM**。只等 `ctrl_c()` 的話，部署時根本收不到訊號，等寬限期一過就被 SIGKILL 硬砍，優雅關機形同虛設。
- `tokio::select!` 同時等好幾個 future，**誰先完成就執行誰的分支**，其餘的直接丟掉不等。這裡用它表達「兩種訊號任一個來就開始關機」。
- `#[cfg(unix)]` 是條件編譯：這段只在 Linux/macOS 編譯，Windows 用一個永遠不會完成的 future 代替。

這讓部署時「舊實例平順下線、不掉請求」，是生產級服務的基本禮儀。

---

## 11.13 測試 handler

Axum 的 app 本質是一個 Tower `Service`，可以不真的起網路就測。搭配 `tower::ServiceExt::oneshot` 直接餵請求：

```bash
cargo add -p api --dev tower@0.5 --features util     # 提供 ServiceExt::oneshot
cargo add -p api --dev http-body-util@0.1             # 提供 BodyExt::collect，把回應 body 讀出來
```

測試寫在 `crates/api/src/main.rs` 最下面：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::{Request, StatusCode}};
    use http_body_util::BodyExt;                    // 提供 collect()
    use infrastructure::InMemoryOrderRepo;
    use tower::ServiceExt;                          // 提供 oneshot

    // 用記憶體版 repo 組 app（第 09 章：測試不碰真 DB）
    fn test_app() -> Router {
        let repo: Arc<dyn domain::OrderRepository> = Arc::new(InMemoryOrderRepo::default());
        build_router(AppState {
            create_order: Arc::new(application::CreateOrder::new(repo.clone())),
            orders: repo,
        })
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let resp = test_app()
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn unknown_order_returns_404_json() {
        let resp = test_app()
            .oneshot(Request::builder().uri("/orders/999").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        // body 是一個串流：collect() 收完整段，再轉成 bytes 解析 JSON
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "找不到資源");
    }
}
```

- `oneshot` 會**吃掉**整個 router（取得所有權）。同一個測試要連發好幾個請求時，每次用 `app.clone().oneshot(...)`；`Router` 的 clone 很便宜，而且 clone 出來的共用同一份 state。
- 用 `cargo test -p api` 執行。注意：infrastructure 裡有 `query!`，所以**編譯**時仍然要有 DB 或 `.sqlx/` 快取（第 10.10 節）；測試**執行**時則完全不連 DB。

> **回報時刻**：因為分層乾淨，測試可以「用記憶體版 repo 組 app」，`oneshot` 一發請求就驗回應，**又快又不依賴 DB**。真的連 DB 的整合測試（第 06 章）另外歸類、用 Docker 起的測試 DB 跑。

---

## 11.14 常見錯誤

- **`State` 的型別忘了 `#[derive(Clone)]`**→ 編譯錯。State 每請求要 clone（裡面放 `Arc` 讓 clone 便宜）。
- **多個消耗 body 的 extractor**（兩個 `Json`）或 `Json` 沒放最後 → 編譯錯誤 ``Handler<_, _> is not satisfied``。加 `#[axum::debug_handler]` 看是哪個參數的問題（11.5）。
- **handler 裡塞業務邏輯或 SQL**→ 違反分層，難測難換。handler 要薄，邏輯往下推。
- **把 `sqlx::Error` / 內部錯誤原文回給 client**→ 洩漏內部細節。對外回泛用訊息，內部用 tracing 記全文。
- **照舊文章寫 `/orders/:id`**→ Axum 0.8 一啟動就 panic（`Path segments must not start with ':'`）。改成 `/orders/{id}`。
- **只等 `ctrl_c()` 做優雅關機**→ 容器平台送的是 SIGTERM，收不到就被硬砍。兩種訊號都要接（11.12）。
- **`AppState` 裡寫死 `CreateOrder<PgOrderRepo>`**→ 測試時換不成記憶體版。用 `Arc<dyn OrderRepository>`，具體實作留給組合根決定（11.7）。
- **忘了 `.with_state(state)`**→ handler 用 `State` 會編譯錯（缺 state）。
- **CORS 用 `permissive()` 上線**→ 安全風險。正式環境限定 origin 白名單。
- **沒設 `tracing`**→ 出事沒 log 可查。生產務必接上結構化日誌 + `TraceLayer`。

---

## 11.15 本章小結

- **Axum** 站在 Tokio / Hyper / Tower 之上，handler 是普通 `async fn`，用**型別（extractor）**宣告需求、回傳實作 `IntoResponse` 的東西。
- **`Router`** 定義「路徑 + 方法 → handler」，`nest` 加前綴分組。
- **擷取器**：`Path`（路徑）、`Query`（查詢字串）、`Json`（body）、`State`（共享依賴）、`HeaderMap`（標頭）。
- **`State`** 注入第 09 章的 `AppState`（含 `Arc<dyn OrderRepository>`，連線池包在 repo 裡），把 09、10、11 章縫起來；具體實作由組合根決定，測試時換成記憶體版。
- **錯誤映射**：為 `ApiError` 實作 `IntoResponse`，把分層錯誤變成 HTTP 狀態碼 + JSON；handler 用 `?` 自動處理；內部細節不外洩。
- **驗證**：核心業務規則放 domain，格式驗證用 `validator` 在邊界輔助。
- **middleware（Tower layer）**：`TraceLayer`（日誌）、`CorsLayer`、`TimeoutLayer`，自訂用 `from_fn`。
- handler 要**薄**——只翻譯請求、呼叫用例、組回應。搭配優雅關機（Ctrl-C 與 SIGTERM 都要接）與 `oneshot` 測試。

---

## 11.16 動手作業

1. 起一個 Axum server，做 `GET /health` 回 `"ok"`，用 `curl` 驗證。
2. 加 `GET /echo/{msg}`（用 `Path`）與 `GET /search?q=xxx`（用 `Query`），把參數回顯。
3. 加 `POST /orders`（用 `Json` 收 body），回 `201` 與 JSON。
4. 定義 `ApiError` 並實作 `IntoResponse`，讓 `GET /orders/{id}` 查不到時回 `404`（JSON 格式錯誤）。
5. 接上第 09、10 章：用 `State` 注入 `AppState`，讓 `create_order` 真的透過用例 + repo 存進（記憶體或 Postgres）。
6. 加 `TraceLayer` 與 `TimeoutLayer`，跑起來看 log，並測試逾時行為。
7. 用 `oneshot` 寫一個 `#[tokio::test]` 測 `/health` 與「建立後查得到」的流程（用記憶體版 repo，不連 DB）。

---

## 11.17 驗收清單

- [ ] 我能說出 Axum 與 Tokio/Hyper/Tower 的關係。
- [ ] 我會用 `Router` 定義路由、用擷取器取路徑/查詢/JSON。
- [ ] 我會用 `State` 注入 `AppState`，把 repo（第 09/10 章）接進 handler。
- [ ] 我會為錯誤型別實作 `IntoResponse`，把分層錯誤映射成 HTTP 狀態碼，且不外洩內部細節。
- [ ] 我知道業務規則驗證放 domain、格式驗證可用 validator 輔助。
- [ ] 我會用 Tower middleware 加 logging、CORS、逾時，並設定 tracing。
- [ ] 我能寫出「很薄」的 handler，並用 `oneshot` 不連 DB 測試它。

---

**Web API 篇（11）完成。** 你的服務現在能對外提供 RESTful API 了，而且 handler 很薄、錯誤映射乾淨、依賴清楚。

下一章 [12-calling-external-apis-reqwest.md](./12-calling-external-apis-reqwest.md) 換個方向——讓你的服務去「呼叫別人」。用 **reqwest** 串接第三方外部 API：發請求、用 serde 解析回應、處理逾時與重試、以及並發呼叫多個下游（回扣第 08 章的 `join!`）。做完這章，你的服務就能「既被呼叫、也去呼叫」，離第 13 章的完整成品只差臨門一腳。回到 [課程首頁](./README.md)。
