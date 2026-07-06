# 第 13 章：Capstone —— 整合一切的完整後端成品

> 恭喜你走到最後一章。前十二章像是各自打磨的零件，這一章要把它們**組裝成一台能跑的機器**。
> 我們要做一個真正的後端服務：**書櫃 API（Bookshelf）**——使用者可以把書加進書櫃（只給 ISBN），
> 服務會去**外部 API 查書名與作者**（第 12 章 reqwest），把完整書籍資料**存進 PostgreSQL**（第 10 章 SQLx），
> 對外提供 **RESTful API**（第 11 章 Axum），整體用**分層架構**組織（第 09 章），並附上**測試、Docker 化與部署**。
> 這一章沒有太多新語法——它是把你學過的全部縫起來，讓你親眼看到「一個能上線的 Rust 後端」長什麼樣。

---

## 13.1 學習目標

完成本章後，你應該可以：

- 設計並實作一個完整的分層後端服務，把第 09～12 章全部整合。
- 用 Cargo workspace 組織 domain / application / infrastructure / api 四個 crate。
- 讓一個用例同時協調「外部 API」與「資料庫」兩個依賴。
- 寫單元測試（記憶體版依賴）與整合測試（真 DB + mock 外部服務）。
- 把服務容器化（Dockerfile + docker-compose），並理解部署要點。
- 有能力把這套骨架，套用到你自己的任何後端專案。

---

## 13.2 需求與設計：先想清楚再動手

**產品需求（Bookshelf 書櫃服務）：**

1. `POST /books`：使用者提供一個 ISBN，服務去外部書目 API 查出書名、作者、出版年，存進資料庫，回傳完整書籍。
2. `GET /books`：列出書櫃裡所有書（可用 `?author=` 過濾）。
3. `GET /books/{id}`：查單一本書。
4. `DELETE /books/{id}`：從書櫃移除一本書。
5. `GET /health`：健康檢查。

**這個需求為什麼是好的 Capstone？** 因為它逼你把兩種外部依賴（**資料庫** + **外部 API**）在**同一個用例**裡協調，這正是真實後端最常見、也最能檢驗架構的場景。

**分層設計（回扣第 09 章）：**

```text
┌──────────────────────────────────────────────────────────────┐
│ interface / api（Axum）                                         │
│   handler：翻譯 HTTP ↔ 用例，錯誤映射成狀態碼                     │
├──────────────────────────────────────────────────────────────┤
│ application（用例）                                             │
│   AddBook：查外部 → 建 domain 實體 → 存 repo（協調兩個 port）     │
│   ListBooks / GetBook / RemoveBook                             │
├──────────────────────────────────────────────────────────────┤
│ domain（純業務）                                                │
│   Book 實體、Isbn 值物件、BookRepository + BookMetadataProvider │
│   （兩個 port）、DomainError                                     │
├──────────────────────────────────────────────────────────────┤
│ infrastructure（實作 port）                                     │
│   PgBookRepository（SQLx）、OpenLibraryProvider（reqwest）       │
└──────────────────────────────────────────────────────────────┘
```

**關鍵洞察**：`AddBook` 用例依賴**兩個 trait（port）**——`BookMetadataProvider`（查書目）與 `BookRepository`（存取）。它完全不知道前者是 HTTP、後者是 Postgres。這讓它**可以只用假的依賴就完整測試**。

---

## 13.3 專案結構

```text
bookshelf/
├── Cargo.toml                       ← workspace 根
├── .env                             ← 本機組態（gitignore）
├── docker-compose.yml               ← Postgres + app
├── Dockerfile                       ← 多階段建置
├── migrations/
│   └── 0001_create_books.sql
└── crates/
    ├── domain/
    │   ├── Cargo.toml
    │   └── src/lib.rs               ← Book、Isbn、兩個 port、錯誤
    ├── application/
    │   ├── Cargo.toml
    │   └── src/lib.rs               ← AddBook 等用例
    ├── infrastructure/
    │   ├── Cargo.toml
    │   └── src/
    │       ├── lib.rs
    │       ├── pg_repo.rs           ← SQLx 實作 BookRepository
    │       └── open_library.rs      ← reqwest 實作 BookMetadataProvider
    └── api/
        ├── Cargo.toml
        └── src/
            ├── main.rs              ← 組合根：載組態、接依賴、跑 server
            ├── config.rs
            ├── state.rs             ← AppState
            ├── error.rs            ← ApiError + IntoResponse
            └── handlers.rs          ← handler + router
```

根 `Cargo.toml`：

```toml
[workspace]
resolver = "2"
members = ["crates/domain", "crates/application", "crates/infrastructure", "crates/api"]

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
async-trait = "0.1"
thiserror = "1"
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

---

## 13.4 domain：最純的核心（`crates/domain/src/lib.rs`）

```rust
use async_trait::async_trait;

// ── 值物件：ISBN，在建構時就驗證格式（業務規則活在 domain）──
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Isbn(String);

impl Isbn {
    pub fn parse(raw: &str) -> Result<Self, DomainError> {
        let cleaned: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
        if cleaned.len() == 10 || cleaned.len() == 13 {     // ISBN-10 或 ISBN-13
            Ok(Isbn(cleaned))
        } else {
            Err(DomainError::InvalidIsbn(raw.to_string()))
        }
    }
    pub fn as_str(&self) -> &str { &self.0 }
}

// ── 實體：書 ──
#[derive(Debug, Clone)]
pub struct Book {
    pub id: i64,
    pub isbn: Isbn,
    pub title: String,
    pub author: String,
    pub published_year: Option<i32>,
}

// ── 外部查詢回來的中繼資料（還沒有 id、還沒進 DB）──
#[derive(Debug, Clone)]
pub struct BookMetadata {
    pub title: String,
    pub author: String,
    pub published_year: Option<i32>,
}

// ── 錯誤（第 04 章）──
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("無效的 ISBN：{0}")]
    InvalidIsbn(String),
}

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("資料庫錯誤：{0}")]
    Backend(String),
}

#[derive(Debug, thiserror::Error)]
pub enum MetadataError {
    #[error("找不到這本書的資料")]
    NotFound,
    #[error("書目服務逾時")]
    Timeout,
    #[error("書目服務錯誤：{0}")]
    Upstream(String),
}

// ── port 1：怎麼存取書（第 09 章）──
#[async_trait]
pub trait BookRepository: Send + Sync {
    async fn insert(&self, isbn: &Isbn, meta: &BookMetadata) -> Result<Book, RepoError>;
    async fn find_by_id(&self, id: i64) -> Result<Option<Book>, RepoError>;
    async fn list(&self, author_filter: Option<&str>) -> Result<Vec<Book>, RepoError>;
    async fn delete(&self, id: i64) -> Result<bool, RepoError>;   // 回傳「有沒有刪到」
}

// ── port 2：怎麼查書目（第 09 + 12 章）──
#[async_trait]
pub trait BookMetadataProvider: Send + Sync {
    async fn lookup(&self, isbn: &Isbn) -> Result<BookMetadata, MetadataError>;
}
```

注意：domain 的 `Cargo.toml` **只有** `async-trait / thiserror / serde`——沒有 sqlx、沒有 reqwest、沒有 axum。核心是純的。

---

## 13.5 application：協調兩個依賴的用例（`crates/application/src/lib.rs`）

這是整個成品的「大腦」——`AddBook` 把「查外部」與「存資料庫」串起來，但對兩者的實作一無所知。

```rust
use domain::{
    Book, BookMetadataProvider, BookRepository, DomainError, Isbn, MetadataError, RepoError,
};

// 用例層錯誤：把各下層錯誤收攏（第 04、09 章 #[from]）
#[derive(Debug, thiserror::Error)]
pub enum AddBookError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error(transparent)]
    Metadata(#[from] MetadataError),
    #[error(transparent)]
    Repo(#[from] RepoError),
}

// 用例：泛型注入兩個 port（第 09 章依賴反轉）
pub struct AddBook<P: BookMetadataProvider, R: BookRepository> {
    provider: P,
    repo: R,
}

impl<P: BookMetadataProvider, R: BookRepository> AddBook<P, R> {
    pub fn new(provider: P, repo: R) -> Self {
        Self { provider, repo }
    }

    // 核心流程：驗 ISBN → 查外部書目 → 存進 DB → 回傳完整 Book
    pub async fn execute(&self, raw_isbn: &str) -> Result<Book, AddBookError> {
        let isbn = Isbn::parse(raw_isbn)?;                 // 1. domain 驗證（? 轉 DomainError）
        let meta = self.provider.lookup(&isbn).await?;     // 2. 查外部（? 轉 MetadataError）
        let book = self.repo.insert(&isbn, &meta).await?;  // 3. 存 DB（? 轉 RepoError）
        Ok(book)
    }
}

// 其他用例：查詢類的可以直接用泛型或簡單包一層
pub struct ListBooks<R: BookRepository> { repo: R }
impl<R: BookRepository> ListBooks<R> {
    pub fn new(repo: R) -> Self { Self { repo } }
    pub async fn execute(&self, author: Option<&str>) -> Result<Vec<Book>, RepoError> {
        self.repo.list(author).await
    }
}
```

> **看清楚 `execute` 做了什麼**：三步驟，每步用 `?` 串起來，任何一步失敗都優雅往上報（第 04 章）。它協調了「外部 API」和「資料庫」，卻**完全不含 HTTP 或 SQL**。這就是分層的價值——業務流程讀起來像白話文。

---

## 13.6 infrastructure：兩個 adapter

### SQLx 實作 repository（`crates/infrastructure/src/pg_repo.rs`）

migration `migrations/0001_create_books.sql`：

```sql
CREATE TABLE books (
    id             BIGSERIAL PRIMARY KEY,
    isbn           TEXT        NOT NULL UNIQUE,
    title          TEXT        NOT NULL,
    author         TEXT        NOT NULL,
    published_year INT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_books_author ON books (author);
```

```rust
use async_trait::async_trait;
use domain::{Book, BookMetadata, BookRepository, Isbn, RepoError};
use sqlx::PgPool;

pub struct PgBookRepository { pool: PgPool }

impl PgBookRepository {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

fn map_err(e: sqlx::Error) -> RepoError { RepoError::Backend(e.to_string()) }

#[async_trait]
impl BookRepository for PgBookRepository {
    async fn insert(&self, isbn: &Isbn, meta: &BookMetadata) -> Result<Book, RepoError> {
        // RETURNING 讓 INSERT 直接回傳自動產生的 id 與欄位（省一次查詢）
        let row = sqlx::query!(
            "INSERT INTO books (isbn, title, author, published_year)
             VALUES ($1, $2, $3, $4)
             RETURNING id, isbn, title, author, published_year",
            isbn.as_str(), meta.title, meta.author, meta.published_year,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(map_err)?;

        Ok(Book {
            id: row.id,
            isbn: Isbn::parse(&row.isbn).expect("DB 裡的 ISBN 必為合法"),
            title: row.title,
            author: row.author,
            published_year: row.published_year,
        })
    }

    async fn find_by_id(&self, id: i64) -> Result<Option<Book>, RepoError> {
        let row = sqlx::query!(
            "SELECT id, isbn, title, author, published_year FROM books WHERE id = $1", id
        )
        .fetch_optional(&self.pool).await.map_err(map_err)?;

        Ok(row.map(|r| Book {
            id: r.id, isbn: Isbn::parse(&r.isbn).unwrap(),
            title: r.title, author: r.author, published_year: r.published_year,
        }))
    }

    async fn list(&self, author_filter: Option<&str>) -> Result<Vec<Book>, RepoError> {
        // 動態條件：有 author 就過濾，沒有就全查（用一句 SQL + COALESCE 技巧）
        let rows = sqlx::query!(
            "SELECT id, isbn, title, author, published_year FROM books
             WHERE ($1::text IS NULL OR author ILIKE $1)
             ORDER BY created_at DESC",
            author_filter.map(|a| format!("%{a}%")),
        )
        .fetch_all(&self.pool).await.map_err(map_err)?;

        Ok(rows.into_iter().map(|r| Book {
            id: r.id, isbn: Isbn::parse(&r.isbn).unwrap(),
            title: r.title, author: r.author, published_year: r.published_year,
        }).collect())
    }

    async fn delete(&self, id: i64) -> Result<bool, RepoError> {
        let result = sqlx::query!("DELETE FROM books WHERE id = $1", id)
            .execute(&self.pool).await.map_err(map_err)?;
        Ok(result.rows_affected() > 0)      // true = 有刪到，false = 本來就沒這筆
    }
}
```

### reqwest 實作外部書目查詢（`crates/infrastructure/src/open_library.rs`）

我們用 [Open Library](https://openlibrary.org) 的公開 API（免金鑰、適合教學）。回應格式較嵌套，正好練習 serde（第 12 章）：

```rust
use async_trait::async_trait;
use domain::{BookMetadata, BookMetadataProvider, Isbn, MetadataError};
use serde::Deserialize;

pub struct OpenLibraryProvider {
    client: reqwest::Client,        // 共用 client（第 12 章）
    base_url: String,               // 正式用 https://openlibrary.org；測試指向 mock
}

impl OpenLibraryProvider {
    pub fn new(client: reqwest::Client, base_url: String) -> Self {
        Self { client, base_url }
    }
}

// 只宣告我們要用的欄位（防禦性反序列化，第 12 章）
#[derive(Deserialize)]
struct OlBook {
    title: String,
    #[serde(default)]
    authors: Vec<OlAuthorRef>,
    #[serde(default)]
    publish_date: Option<String>,
}
#[derive(Deserialize)]
struct OlAuthorRef { key: String }

fn map_err(e: reqwest::Error) -> MetadataError {
    if e.is_timeout() { MetadataError::Timeout }
    else { MetadataError::Upstream(e.to_string()) }
}

#[async_trait]
impl BookMetadataProvider for OpenLibraryProvider {
    async fn lookup(&self, isbn: &Isbn) -> Result<BookMetadata, MetadataError> {
        // Open Library：GET /isbn/{isbn}.json
        let url = format!("{}/isbn/{}.json", self.base_url, isbn.as_str());
        let resp = self.client.get(&url).send().await.map_err(map_err)?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(MetadataError::NotFound);           // 404 → 明確的「查無此書」
        }
        let resp = resp.error_for_status().map_err(map_err)?;   // 其他 4xx/5xx → 錯誤
        let body: OlBook = resp.json().await.map_err(map_err)?;

        // 從 publish_date 抓出年份（簡化：找出四位數字）
        let year = body.publish_date.and_then(|d| {
            d.split_whitespace().find_map(|w| w.parse::<i32>().ok())
                .filter(|y| (1000..=2100).contains(y))
        });

        Ok(BookMetadata {
            title: body.title,
            author: body.authors.first().map(|a| a.key.clone()).unwrap_or_else(|| "未知".into()),
            published_year: year,
        })
    }
}
```

> 真實 Open Library 的作者名要再打一次 `/authors/{key}.json` 才拿得到（作者是另一個資源）。這裡簡化成用 key 當作者，重點是示範「reqwest + serde + 錯誤映射」的完整形狀，不是把 Open Library 串到完美。你自己的專案換成任何 API 都是同一套路。

`crates/infrastructure/src/lib.rs`：

```rust
mod pg_repo;
mod open_library;
pub use pg_repo::PgBookRepository;
pub use open_library::OpenLibraryProvider;
```

---

## 13.7 api：組裝、handler、錯誤映射

### 組態與狀態（`config.rs` / `state.rs`）

```rust
// config.rs（第 09 章）
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub database_url: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_ol")]
    pub open_library_base: String,
}
fn default_port() -> u16 { 8080 }
fn default_ol() -> String { "https://openlibrary.org".into() }

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();
        Ok(envy::from_env::<Config>()?)
    }
}
```

```rust
// state.rs（第 09、11 章）
use std::sync::Arc;
use application::AddBook;
use infrastructure::{OpenLibraryProvider, PgBookRepository};

#[derive(Clone)]
pub struct AppState {
    // 用泛型具體型別包起來，用 Arc 共享（也可用 Arc<dyn Trait>）
    pub add_book: Arc<AddBook<OpenLibraryProvider, PgBookRepository>>,
    pub repo: Arc<dyn domain::BookRepository>,
}
```

### 錯誤映射（`error.rs`，第 11 章）

```rust
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("找不到資源")]
    NotFound,
    #[error(transparent)]
    AddBook(#[from] application::AddBookError),
    #[error("內部錯誤")]
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        use application::AddBookError::*;
        use domain::MetadataError;

        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            // 依「底層是哪種錯誤」決定對外狀態碼
            ApiError::AddBook(Domain(_)) => (StatusCode::BAD_REQUEST, self.to_string()),
            ApiError::AddBook(Metadata(MetadataError::NotFound)) =>
                (StatusCode::NOT_FOUND, "查無此 ISBN 的書".into()),
            ApiError::AddBook(Metadata(MetadataError::Timeout)) =>
                (StatusCode::GATEWAY_TIMEOUT, "書目服務逾時".into()),
            ApiError::AddBook(Metadata(_)) =>
                (StatusCode::BAD_GATEWAY, "書目服務暫時無法使用".into()),
            ApiError::AddBook(Repo(_)) | ApiError::Internal =>
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into()),
        };
        // 內部錯誤要在伺服器端記 log（第 11 章），對外只回泛用訊息
        if status.is_server_error() {
            tracing::error!(error = %self, "handler 發生伺服器錯誤");
        }
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
```

> **這張 match 表就是整個服務的「錯誤對外契約」**——把內部各層錯誤，一次映射成正確的 HTTP 語意：使用者輸入錯 → 400、查無 → 404、下游逾時 → 504、下游掛 → 502、自己壞 → 500。前端看到的是乾淨的狀態碼，內部細節安全地留在 log。

### handler 與 router（`handlers.rs`，第 11 章）

```rust
use axum::{extract::{Path, Query, State}, http::StatusCode, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use crate::{error::ApiError, state::AppState};

#[derive(Deserialize)]
struct AddBookBody { isbn: String }

#[derive(Deserialize)]
struct ListQuery { author: Option<String> }

#[derive(Serialize)]
struct BookView { id: i64, isbn: String, title: String, author: String, published_year: Option<i32> }

impl From<domain::Book> for BookView {
    fn from(b: domain::Book) -> Self {
        BookView { id: b.id, isbn: b.isbn.as_str().into(), title: b.title,
                   author: b.author, published_year: b.published_year }
    }
}

async fn add_book(
    State(st): State<AppState>,
    Json(body): Json<AddBookBody>,
) -> Result<impl IntoResponse, ApiError> {
    let book = st.add_book.execute(&body.isbn).await?;      // 一行呼叫用例，錯誤自動映射
    Ok((StatusCode::CREATED, Json(BookView::from(book))))
}

async fn list_books(
    State(st): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let books = st.repo.list(q.author.as_deref()).await.map_err(|_| ApiError::Internal)?;
    Ok(Json(books.into_iter().map(BookView::from).collect::<Vec<_>>()))
}

async fn get_book(
    State(st): State<AppState>, Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let book = st.repo.find_by_id(id).await.map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(BookView::from(book)))
}

async fn delete_book(
    State(st): State<AppState>, Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let removed = st.repo.delete(id).await.map_err(|_| ApiError::Internal)?;
    if removed { Ok(StatusCode::NO_CONTENT) } else { Err(ApiError::NotFound) }
}

async fn health() -> &'static str { "ok" }

pub fn router(state: AppState) -> Router {
    use tower_http::trace::TraceLayer;
    Router::new()
        .route("/health", get(health))
        .route("/books", get(list_books).post(add_book))
        .route("/books/{id}", get(get_book).delete(delete_book))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
```

### 組合根（`main.rs`）——一切在此接起來

```rust
mod config; mod state; mod error; mod handlers;
use std::sync::Arc;
use std::time::Duration;
use config::Config;
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. 日誌（第 11 章）
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("info,tower_http=debug"))
        .init();

    // 2. 組態（第 09 章）
    let config = Config::from_env()?;

    // 3. 資料庫連線池 + migration（第 10 章）
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("../../migrations").run(&pool).await?;

    // 4. HTTP client（第 12 章）
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("bookshelf/1.0")
        .build()?;

    // 5. 組裝依賴（第 09 章組合根：在這裡、也只在這裡，決定用哪些具體實作）
    let provider = infrastructure::OpenLibraryProvider::new(http, config.open_library_base.clone());
    let repo_for_uc = infrastructure::PgBookRepository::new(pool.clone());
    let repo_shared: Arc<dyn domain::BookRepository> =
        Arc::new(infrastructure::PgBookRepository::new(pool.clone()));

    let state = AppState {
        add_book: Arc::new(application::AddBook::new(provider, repo_for_uc)),
        repo: repo_shared,
    };

    // 6. 起 server + 優雅關機（第 11 章）
    let app = handlers::router(state);
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Bookshelf 啟動於 http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async { tokio::signal::ctrl_c().await.ok(); })
        .await?;
    Ok(())
}
```

> **停下來欣賞這 6 步**：組態 → 連線池 → migration → HTTP client → 組裝依賴 → 起 server。這就是幾乎所有 Rust 後端 `main` 的樣板。每一步都是前面某一章的成果。整個服務**只有這個檔案知道「用的是 Postgres 和 Open Library」**——想換 DB、換書目來源，改這裡即可，其他層一律不動。

---

## 13.8 跑起來與手動驗收

```bash
# 1. 起 Postgres
docker compose up -d db

# 2. 設定 .env
#    DATABASE_URL=postgres://dev:dev@localhost:5432/bookshelf
#    OPEN_LIBRARY_BASE=https://openlibrary.org

# 3. 準備編譯期 SQL 檢查用的 DB（第 10 章）
export DATABASE_URL=postgres://dev:dev@localhost:5432/bookshelf
sqlx migrate run

# 4. 跑
cargo run -p api
```

```bash
# 加一本書（會去 Open Library 查、存進 DB）
curl -X POST http://localhost:8080/books \
  -H 'Content-Type: application/json' \
  -d '{"isbn":"9780134685991"}'
# → 201 {"id":1,"isbn":"9780134685991","title":"Effective Java",...}

curl http://localhost:8080/books                 # → 200 [ ... ]
curl "http://localhost:8080/books?author=..."    # → 200 過濾結果
curl http://localhost:8080/books/1               # → 200 單筆
curl -X DELETE http://localhost:8080/books/1     # → 204
curl -X POST http://localhost:8080/books -d '{"isbn":"abc"}' -H 'Content-Type: application/json'
# → 400 {"error":"無效的 ISBN：abc"}   ← domain 驗證生效、錯誤映射正確
```

---

## 13.9 測試策略：金字塔（回扣第 06 章）

好的測試分層，跟程式碼分層對應：

```text
        ╱╲        整合測試（少）：真 DB + mock 外部 API，測整條路
       ╱──╲       用例測試（中）：假的 provider + 假的 repo，測業務流程
      ╱────╲      單元測試（多）：domain 純函式（Isbn::parse 等）
```

### 單元測試：domain 純邏輯（毫秒級、零依賴）

```rust
// crates/domain/src/lib.rs 底部
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_isbn13() { assert!(Isbn::parse("978-0-13-468599-1").is_ok()); }
    #[test]
    fn rejects_bad_isbn() { assert!(matches!(Isbn::parse("abc"), Err(DomainError::InvalidIsbn(_)))); }
}
```

### 用例測試：假依賴，不碰 DB / 網路（第 09 章的回報）

```rust
// crates/application/src/lib.rs 底部
#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use domain::*;
    use std::sync::Mutex;

    // 手寫的假 provider：回固定值
    struct StubProvider;
    #[async_trait]
    impl BookMetadataProvider for StubProvider {
        async fn lookup(&self, _isbn: &Isbn) -> Result<BookMetadata, MetadataError> {
            Ok(BookMetadata { title: "Test".into(), author: "A".into(), published_year: Some(2020) })
        }
    }
    // 手寫的假 repo：存進記憶體
    #[derive(Default)]
    struct StubRepo { saved: Mutex<Vec<Book>> }
    #[async_trait]
    impl BookRepository for StubRepo {
        async fn insert(&self, isbn: &Isbn, meta: &BookMetadata) -> Result<Book, RepoError> {
            let book = Book { id: 1, isbn: isbn.clone(), title: meta.title.clone(),
                              author: meta.author.clone(), published_year: meta.published_year };
            self.saved.lock().unwrap().push(book.clone());
            Ok(book)
        }
        async fn find_by_id(&self, _: i64) -> Result<Option<Book>, RepoError> { Ok(None) }
        async fn list(&self, _: Option<&str>) -> Result<Vec<Book>, RepoError> { Ok(vec![]) }
        async fn delete(&self, _: i64) -> Result<bool, RepoError> { Ok(true) }
    }

    #[tokio::test]
    async fn add_book_flow_works() {
        let uc = AddBook::new(StubProvider, StubRepo::default());
        let book = uc.execute("9780134685991").await.unwrap();
        assert_eq!(book.title, "Test");          // 整條「查 → 存」流程正確，完全不碰真 DB/網路
    }

    #[tokio::test]
    async fn add_book_rejects_bad_isbn() {
        let uc = AddBook::new(StubProvider, StubRepo::default());
        assert!(matches!(uc.execute("xxx").await, Err(AddBookError::Domain(_))));
    }
}
```

### 整合測試：真 DB + mock 外部（`crates/api/tests/`）

用 Docker 的測試 DB + `wiremock`（第 12 章）假的 Open Library，用 `oneshot`（第 11 章）打真 router。這類慢、依賴環境，數量要少，只驗「關鍵路徑真的能串起來」。

> **測試哲學**：多寫又快又穩的單元/用例測試（不依賴外部），少寫慢又脆的整合測試（依賴環境）。因為架構分層做得好，**大部分邏輯都能用假依賴測到**——這是第 09 章分層最實際的回報。

---

## 13.10 容器化與部署

### 多階段 Dockerfile

```dockerfile
# ── 建置階段 ──
FROM rust:1.82 AS builder
WORKDIR /app
COPY . .
ENV SQLX_OFFLINE=true                 # 用 .sqlx 快取，建置時不連 DB（第 10 章）
RUN cargo build --release -p api

# ── 執行階段：用小映像，只帶執行檔 ──
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/api /usr/local/bin/api
COPY --from=builder /app/migrations /migrations
EXPOSE 8080
CMD ["api"]
```

- **多階段建置**：第一階段用完整 Rust 工具鏈編譯，第二階段只複製最終執行檔到精簡映像。成品映像可以很小（Rust 編出來是單一靜態執行檔，這是它的一大優勢——不用帶 runtime、直譯器）。
- `SQLX_OFFLINE=true` + commit 進去的 `.sqlx/`：建置時不需要真 DB（第 10.10 節）。
- `ca-certificates`：reqwest 打 HTTPS 需要根憑證。

### docker-compose 一鍵起全套

```yaml
services:
  db:
    image: postgres:16
    environment: { POSTGRES_USER: dev, POSTGRES_PASSWORD: dev, POSTGRES_DB: bookshelf }
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:                                 # 等 DB 真的 ready 再啟動 app
      test: ["CMD-SHELL", "pg_isready -U dev"]
      interval: 5s
      retries: 5

  app:
    build: .
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://dev:dev@db:5432/bookshelf   # 注意 host 是服務名 db
      OPEN_LIBRARY_BASE: https://openlibrary.org
      PORT: "8080"
    ports: ["8080:8080"]

volumes: { pgdata: {} }
```

```bash
docker compose up --build       # 一鍵起 DB + app
```

### 部署要點清單

- **組態走環境變數**（第 09 章）：不同環境注入不同值，金鑰用 secret 管理，別進映像。
- **migration 策略**：小服務可開機自動跑（`migrate!`）；大團隊常在部署流程獨立跑，避免多實例同時跑衝突。
- **健康檢查**：`/health` 給 load balancer / k8s 探測；DB 用 `pg_isready`。
- **優雅關機**（第 11 章）：滾動更新時不掉請求。
- **觀測性**：`tracing` 輸出結構化 log（正式可接 OpenTelemetry），加上指標與追蹤。
- **資源上限**：連線池大小 × 實例數 別超過 DB 連線上限；外呼逾時務必設好（第 12 章）。

---

## 13.11 這套骨架怎麼套到你自己的專案

你剛做的不只是「一個書櫃」，而是一套**可重用的後端骨架**。換個題目，步驟一樣：

1. **定 domain**：畫出實體、值物件、業務規則，定義需要哪些 port（trait）。
2. **寫用例**：每個「使用者能做的動作」一個用例，注入需要的 port。
3. **實作 adapter**：DB 用 SQLx、外部服務用 reqwest，各實作對應 trait。
4. **接 API**：Axum handler 保持很薄，錯誤映射成 HTTP。
5. **組合根**：`main.rs` 載組態、接依賴、起 server。
6. **測試**：domain/用例用假依賴大量測，關鍵路徑補整合測試。
7. **容器化部署**：多階段 Dockerfile + compose + 環境變數。

> **這就是本課要給你的核心能力**：不是背 API，而是拿到任何後端需求，都能**用 Rust 做出乾淨、可測、可換、能上線的分層系統**。書櫃只是載體，方法論才是你帶走的東西。

---

## 13.12 常見錯誤（整合階段特有）

- **`AppState` 型別對不上 handler 的 `State<...>`**→ 確認 `router` 用的 state 型別跟 handler 期待的一致。
- **compose 裡 app 連不上 db**→ 連線 host 要用服務名（`db`）不是 `localhost`；並用 healthcheck 確保 DB ready 才起 app。
- **Docker 建置在 `query!` 卡住**→ 忘了 `SQLX_OFFLINE=true` + commit `.sqlx/`（第 10.10 節）。
- **外呼在容器內 TLS 失敗**→ 精簡映像少了 `ca-certificates`，補上。
- **用例把 `reqwest`/`sqlx` 型別漏進 application 層**→ 破壞分層。錯誤與型別要在 infrastructure 邊界翻譯乾淨。
- **整合測試打真的 Open Library**→ 慢又不穩。用 wiremock 假的（第 12 章）。
- **migration 在多實例同時啟動時互相衝突**→ 大規模部署改用獨立 migration 步驟。

---

## 13.13 本章小結

- Capstone 把全課縫成一個**書櫃 API**：Axum 對外、SQLx 存 DB、reqwest 查外部書目、分層架構承載。
- **核心設計**：`AddBook` 用例協調兩個 port（`BookMetadataProvider` + `BookRepository`），對實作一無所知——所以能只用假依賴完整測試。
- **組合根**（`main.rs`）六步樣板：日誌 → 組態 → 連線池 + migration → HTTP client → 組裝依賴 → 起 server + 優雅關機。
- **錯誤映射表**把內部各層錯誤一次翻成正確 HTTP 語意（400/404/502/504/500），細節不外洩。
- **測試金字塔**：多寫快又穩的單元/用例測試（假依賴），少寫慢的整合測試（真 DB + mock 外部）。
- **部署**：多階段 Dockerfile（單一小執行檔）+ compose + 環境變數 + healthcheck + 優雅關機。
- 最重要的是：你得到了一套**可重用的後端骨架與方法論**，能套到任何新專案。

---

## 13.14 動手作業（把它變成你的作品）

1. 把整個 Bookshelf 跑起來（`docker compose up --build`），用 `curl` 完整走過五個端點。
2. 新增一個端點 `PATCH /books/{id}`：允許修改書名（加 domain 規則：書名不可為空）。
3. 讓 `OpenLibraryProvider` 加上第 12 章的**重試 + 逾時**，並用 wiremock 測「500 會重試、逾時會映射成 504」。
4. 加一個「加書時若 ISBN 已存在就回 409 Conflict」的行為（處理 DB 的 UNIQUE 衝突，映射成 `ApiError::Conflict`）。
5. 為 `AddBook` 用例補一個測試：外部回 `NotFound` 時，用例回 `MetadataError::NotFound`、API 回 404。
6. 換掉外部依賴：把 `OpenLibraryProvider` 換成另一個書目 API（或你熟悉的任何第三方 API），體會「只改 infrastructure + 組合根」的爽感。
7. （挑戰）加一個「使用者」概念：每本書屬於某使用者，加上驗證 middleware（第 11 章 `from_fn`）與對應的資料表與查詢。

---

## 13.15 驗收清單

- [ ] 我能用 workspace 把一個後端拆成 domain/application/infrastructure/api 四層並跑起來。
- [ ] 我能寫一個「協調外部 API + 資料庫」的用例，且它不依賴任何具體實作。
- [ ] 我能把 SQLx repo 與 reqwest client 各自實作成 domain trait 的 adapter。
- [ ] 我能寫錯誤映射，把內部分層錯誤翻成正確的 HTTP 狀態碼、不洩漏細節。
- [ ] 我能用假依賴大量測業務邏輯，並用 wiremock + 測試 DB 做整合測試。
- [ ] 我能用多階段 Dockerfile + compose 把服務容器化並在本機一鍵起全套。
- [ ] 我能把這套骨架套用到一個全新的後端需求上。

---

## 🎓 課程總結：你走完了什麼

回頭看看這條路：

- **語言核心（01～06）**：你能寫出正確、安全、組織良好的 Rust——變數與型別、所有權與生命週期、trait 與泛型、錯誤處理、集合與迭代器、模組與測試。
- **進階能力（07～08）**：智慧指標與內部可變性、以及無懼併發與 async/Tokio。
- **工程實戰（09～13）**：分層架構、SQLx 資料庫、Axum Web API、reqwest 外部串接，最後整合成一個能上線的成品。

你已經不再是「跟編譯器打架的初學者」，而是能**用 Rust 做工程決策、蓋出乾淨可測後端**的工程師。README 承諾的四項需求——**架構設計、資料庫串接、網路 API 串接、成品範例**——你全部做到了。

### 下一步可以往哪走

- **深化語言**：`Pin`/自訂 `Future`、進階生命週期、`unsafe` 與 FFI、巨集（`macro_rules!` / proc-macro）。
- **強化生產力**：可觀測性（OpenTelemetry、metrics）、認證授權（JWT、OAuth）、背景任務與排程、訊息佇列。
- **效能與規模**：壓測與 profiling、快取（Redis）、資料庫最佳化、水平擴展——這些「讓服務扛得住流量尖峰」的主題，[第 14 章](./14-high-concurrency-and-resilience.md)有完整實作（背壓、限流、負載卸除、斷路器、快取、容量規劃）。
- **更廣的生態**：gRPC（`tonic`）、GraphQL（`async-graphql`）、WebAssembly、嵌入式、CLI 工具（`clap`）。
- **讀好程式碼**：去讀 Axum、Tokio、SQLx 的原始碼——你現在有能力看懂它們了。

> 學程式沒有終點，但你已經跨過最陡的那段坡。接下來，去**做東西**——把你想做的服務用 Rust 蓋出來，遇到問題查、卡住了回來複習對應章節。這門課會一直在這裡當你的參考書。

感謝你走完全程。現在，去寫點厲害的東西吧。🦀

> **想更上一層樓？** 這個成品「能上線」，但要「扛得住雙 11 級的流量尖峰、擋得住下游故障」，還需要一整套韌性防護。[第 14 章：高併發與韌性](./14-high-concurrency-and-resilience.md)（進階加碼）會把背壓、限流、負載卸除、斷路器、鎖競爭化解、快取與容量規劃全部寫成能跑的實作，並直接套用到本章的 Bookshelf 上。準備好把「能用」變成「打不倒」了嗎？

回到 [課程首頁](./README.md)。
