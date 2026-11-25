# 第 10 章：資料庫串接 —— SQLx、連線池、Migration、交易與 Repository

> 第 09 章我們備好了 `OrderRepository` 這個「插座（port）」，這一章就來接上第一個真正的「電器（adapter）」——PostgreSQL。
> 你會學到後端最核心的技能：怎麼安全、高效地把資料存進資料庫、讀出來。
> 我們主打 **SQLx**（非同步、可在**編譯期**檢查 SQL、貼近原生 SQL），並用第 08 章的 async、第 04 章的錯誤處理、第 09 章的架構，寫出一個能實作 `OrderRepository` 的 `PgOrderRepo`。
> 這一章跑完，你的服務就真的「有記憶」了。

---

## 10.1 學習目標

完成本章後，你應該可以：

- 用 Docker 快速起一個 PostgreSQL，不污染本機。
- 說出「為什麼要連線池」，並用 `PgPool` 管理連線。
- 用 `sqlx migrate` 管理資料庫結構的版本（migration）。
- 用 SQLx 做 CRUD：`query!`、`query_as!` 與編譯期 SQL 檢查。
- 把查詢結果映射成 Rust struct（`FromRow`）。
- 用**交易（transaction）**確保「一組操作要嘛全成、要嘛全敗」。
- 用第 09 章的架構，寫一個 `PgOrderRepo` 實作 `OrderRepository` trait。
- 知道 SQLx / SeaORM / Diesel 的差異，能為專案選型。

---

## 10.2 先把 PostgreSQL 跑起來（Docker）

正式練習前，我們需要一個資料庫。用 Docker 最乾淨——不用在本機裝一堆東西，用完刪掉即可。

在第 09 章的 `myshop/` 根目錄建 `docker-compose.yml`：

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: myshop
    ports:
      - "5432:5432"          # 把容器的 5432 對到本機 5432
    volumes:
      - pgdata:/var/lib/postgresql/data   # 資料持久化，容器重啟不丟

volumes:
  pgdata:
```

```bash
docker compose up -d          # 背景啟動
docker compose ps             # 確認在跑
# 連線字串會是：
# postgres://dev:dev@localhost:5432/myshop
```

把連線字串放進 `myshop/` 根目錄的 `.env`（回扣第 09 章，記得 `.gitignore`）。這一章有三個地方會讀它：`sqlx` 命令列工具、`query!` 巨集（編譯期）、程式本身的 `Config`（執行期）：

```bash
DATABASE_URL=postgres://dev:dev@localhost:5432/myshop
```

---

## 10.3 選型：SQLx vs SeaORM vs Diesel

Rust 沒有「唯一正解」的資料庫函式庫，三大主流各有取捨：

| | **SQLx** | **SeaORM** | **Diesel** |
|---|---|---|---|
| 定位 | async SQL toolkit（不是 ORM） | async ORM | 老牌 ORM / query builder |
| 你寫什麼 | **原生 SQL 字串** | Rust API 組查詢（少寫 SQL） | Rust DSL 組查詢 |
| 編譯期檢查 | ✅ 可對真 DB 檢查 SQL（招牌） | 部分（型別層） | ✅（強型別 DSL） |
| async | 原生 async | 原生 async（底層是 SQLx） | 主要同步（另有 async 版） |
| 學習曲線 | 低（你會 SQL 就會） | 中（要學它的 API） | 高（DSL 較重） |
| 適合 | 想掌控 SQL、喜歡透明 | 想少寫 SQL、要關聯管理 | 重視強型別、成熟穩定 |

> **本課選 SQLx 的原因**：它最「透明」——你寫的就是 SQL，沒有 ORM 的魔法黑箱，出問題好查；而它的**編譯期 SQL 檢查**是殺手級功能：連 SQL 打錯字、欄位型別對不上都在 `cargo build` 時就報錯，而不是上線後炸掉。這跟 Rust「把錯誤提早到編譯期」的哲學完全一致。

> **什麼時候選 SeaORM？** 當你的資料模型關聯複雜（大量 join、關聯載入）、想要「用 Rust 物件操作、少碰 SQL」時。10.11 節會給一個對照。ORM 的代價是多一層抽象與魔法，SQLx 則是「你完全知道發生什麼事」。

加依賴。資料庫程式碼放在 infrastructure，所以加到這個 crate（第 09 章在 `crates/infrastructure/Cargo.toml` 預留了 `sqlx` 那行，把註解拿掉就等於下面第一行指令）：

```bash
# 在 myshop/ 根目錄執行
cargo add -p infrastructure sqlx@0.9 --features runtime-tokio,postgres,macros,migrate,chrono
cargo add -p infrastructure chrono@0.4 --features serde     # 處理時間欄位
```

- `runtime-tokio`：用 Tokio 當 async runtime（第 08 章）。
- `postgres`：Postgres 驅動。
- `macros`：啟用 `query!` / `query_as!` 這些編譯期檢查巨集，以及 `#[derive(FromRow)]`。
- `migrate`：支援 migration。
- `chrono`：讓 Postgres 的 `TIMESTAMPTZ` 能對應到 `chrono::DateTime<Utc>`。
- 本機的 Docker Postgres 不需要 TLS。要連強制加密的雲端資料庫時，再加上 `tls-rustls` feature。

> 想先在獨立的小專案練 10.4～10.8 也可以：在 `myshop/` 以外的目錄 `cargo new sqlx-lab`，執行上面的指令時拿掉 `-p infrastructure`，另外 `cargo add tokio --features full`，並把 `docker-compose.yml`、`.env` 也放到那個專案的根目錄。

---

## 10.4 連線池：為什麼不是「一個連線」

新手直覺是「開一條連線，重複用」。但後端要同時處理很多請求（第 08 章的並發），若共用一條連線，大家得排隊，超慢；若每個請求都「開新連線、用完關」，開關連線本身很貴（TCP、認證、TLS 握手），也拖垮 DB。

**連線池（connection pool）** 解決這個問題：**預先開好一批連線，放在池子裡；請求來了借一條、用完還回去。** 借還很快，數量可控，DB 不會被塞爆。

```rust
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

async fn make_pool(database_url: &str) -> Result<sqlx::PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(10)                       // 池子最多 10 條連線
        .acquire_timeout(Duration::from_secs(5))   // 借不到就等 5 秒，再不行就報錯
        .connect(database_url)
        .await
}
```

- **`PgPool`** 就是那個池子。它是 `Clone` 的（內部 `Arc`，回扣第 07 章），複製只是加參考、不會真的多開連線——所以你可以放心把它放進第 09 章的 `AppState` 到處共享。
- `max_connections` 要跟 DB 的上限、機器數量一起考量（不是越多越好）。

> **心智模型**：連線池像共享單車站。站裡停 10 台（連線），要用就騎一台走（`acquire`），用完騎回來（`Drop` 自動歸還）。大家共享這 10 台，而不是「每人買一台」或「全公司搶一台」。

---

## 10.5 Migration：資料庫結構的版本控制

「migration」是「一步一步改資料庫結構」的腳本，像 git commit 一樣可追溯、可重放。**別手動在 DB 裡點來點去改表**——那沒有紀錄、換台機器就重現不出來。

安裝 SQLx 命令列工具：

```bash
# 版本跟程式裡的 sqlx 對齊（0.9.x）；只裝 Postgres 支援，編譯比較快
cargo install sqlx-cli --version "^0.9" --no-default-features --features postgres
```

裝好後會多出 `sqlx` 指令，也能用 `cargo sqlx ...` 的形式呼叫（10.10 會用到）。本機 Docker 的 Postgres 不用 TLS，所以上面沒裝 TLS 支援；要連強制加密的雲端資料庫，把 `--features` 改成 `postgres,rustls`。

建立一個 migration。以下 `sqlx` 指令都在 `myshop/` 根目錄執行——它會讀目前目錄的 `.env` 拿 `DATABASE_URL`，並在目前目錄下建 `migrations/`：

```bash
sqlx migrate add create_orders          # 產生 migrations/<時間戳>_create_orders.sql
```

編輯產生的 SQL 檔 `migrations/<時間戳>_create_orders.sql`：

```sql
CREATE TABLE orders (
    id          BIGINT PRIMARY KEY,
    customer    TEXT        NOT NULL,
    amount      BIGINT      NOT NULL,          -- 以「分」為單位（回扣第 09 章 Money）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10.8 的交易範例會示範「建立訂單 + 扣庫存」必須一起成功，
-- 所以這裡也放一張最小庫存表，避免交易範例引用不存在的表。
CREATE TABLE inventory (
    product     TEXT   PRIMARY KEY,
    stock       BIGINT NOT NULL CHECK (stock >= 0)
);

INSERT INTO inventory (product, stock) VALUES ('default', 100);
```

套用 migration：

```bash
sqlx migrate run          # 把還沒跑過的 migration 依序套用
sqlx migrate info         # 看哪些已套用、哪些還沒
```

SQLx 會建一張 `_sqlx_migrations` 表記錄「跑過哪些」，所以重複 `run` 不會重跑已套用的。

> **上線時怎麼跑 migration？** 可以在程式啟動時自動跑（把 migration 內嵌進執行檔）：
>
> ```rust
> // 寫在 crates/api/src/main.rs：路徑是相對於 crates/api/Cargo.toml 所在的目錄
> sqlx::migrate!("../../migrations").run(&pool).await?;   // 開機自動套用未執行的 migration
> ```
>
> `migrate!` 巨集會在**編譯期**把 `migrations/` 目錄的 SQL 打包進執行檔，部署時不用另外帶 SQL 檔。小型服務很方便；大型團隊有時偏好「部署流程獨立跑 migration」以更好地控管。
>
> 兩個細節：
> - 巨集的路徑是相對於「呼叫它的那個 crate 的 `Cargo.toml`」，不是相對於原始碼檔案，也不是 workspace 根目錄。我們的 `migrations/` 在 `myshop/` 根目錄，從 `crates/api` 看過去就是 `../../migrations`。
> - 只新增 migration 檔、沒改任何 Rust 程式碼時，`cargo build` 可能不會重新打包。在 `crates/api/` 放一個 `build.rs`，寫 `fn main() { println!("cargo:rerun-if-changed=../../migrations"); }`，Cargo 就會在這個目錄有變動時重新編譯。

---

## 10.6 SQLx 的招牌：編譯期檢查的 SQL

一般函式庫的 SQL 是字串，打錯字、欄位型別錯，要跑到那行才爆。SQLx 的 `query!` / `query_as!` 巨集會在 `cargo build` 時**連上你的開發資料庫，實際驗證 SQL**——語法對不對、欄位存不存在、型別對不對，全在編譯期抓出來。

> **前提**：因為要連 DB 驗證，`cargo build` 時要拿得到 `DATABASE_URL`（指向一個已套用 migration 的開發 DB）。巨集會讀環境變數，也會從「使用巨集的 crate 目錄」一路往上找到 workspace 根目錄的 `.env`，所以 10.2 放在 `myshop/.env` 的設定就夠了。CI / 沒有 DB 的環境可用「離線模式」（見 10.10）。
>
> 這也代表：從現在起，只要 workspace 裡有 crate 用了 `query!`，**整個 workspace 編譯時都需要 DB 開著（或有離線快取）**，第 11 章跑測試也一樣。

### 插入（INSERT）

```rust
use sqlx::PgPool;

async fn insert_order(pool: &PgPool, id: i64, customer: &str, amount: i64) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO orders (id, customer, amount) VALUES ($1, $2, $3)",
        id, customer, amount           // 參數化查詢：$1/$2/$3 依序對應，杜絕 SQL injection
    )
    .execute(pool)                     // execute：不需要回傳資料列時用
    .await?;
    Ok(())
}
```

- **`$1`, `$2`...** 是參數佔位符（Postgres 語法）。**永遠用參數化查詢**，不要用字串拼接把使用者輸入塞進 SQL——那是 SQL injection 的來源。SQLx 逼你走參數化，天然安全。
- 若你把參數順序或型別寫錯（例如把字串塞進 `amount`），編譯就會失敗。

### 查詢單筆 / 多筆，直接映射成 struct

`query_as!` 把每一列直接反序列化成你的 struct：

```rust
use chrono::{DateTime, Utc};

#[derive(Debug)]
struct OrderRow {
    id: i64,
    customer: String,
    amount: i64,
    created_at: DateTime<Utc>,
}

// 查一筆（可能沒有）
async fn find_order(pool: &PgPool, id: i64) -> Result<Option<OrderRow>, sqlx::Error> {
    let row = sqlx::query_as!(
        OrderRow,
        "SELECT id, customer, amount, created_at FROM orders WHERE id = $1",
        id
    )
    .fetch_optional(pool)             // fetch_optional：0 或 1 筆 → Option
    .await?;
    Ok(row)
}

// 查多筆
async fn list_orders(pool: &PgPool) -> Result<Vec<OrderRow>, sqlx::Error> {
    let rows = sqlx::query_as!(
        OrderRow,
        "SELECT id, customer, amount, created_at FROM orders ORDER BY created_at DESC"
    )
    .fetch_all(pool)                  // fetch_all：全部收成 Vec
    .await?;
    Ok(rows)
}
```

四種取結果的方法，記住用途：

| 方法 | 回傳 | 用在 |
|------|------|------|
| `.execute()` | 影響列數 | INSERT/UPDATE/DELETE，不要資料 |
| `.fetch_one()` | `T`（沒有就 Err） | 確定剛好一筆 |
| `.fetch_optional()` | `Option<T>` | 可能 0 或 1 筆（依 id 查最常用） |
| `.fetch_all()` | `Vec<T>` | 多筆列表 |

> **`query_as!` 的魔法**：它會在編譯期比對「SELECT 出來的欄位型別」跟「你的 struct 欄位型別」是否吻合。如果 SQL 選了 `amount`（DB 是 `BIGINT`）但你的 struct 寫成 `String`，**編譯就失敗**。這是別的語言給不了的安全感。

### 型別怎麼對應？NULL 變 `Option`

常用的 Postgres → Rust 對應：`BIGINT`（含 `BIGSERIAL`）→ `i64`、`INTEGER` → `i32`、`TEXT` / `VARCHAR` → `String`、`BOOLEAN` → `bool`、`TIMESTAMPTZ` → `chrono::DateTime<Utc>`（要開 `chrono` feature）。Postgres 沒有無號整數，所以 Rust 這邊的 `u64` 要自己轉成 `i64` 再存（10.9 會看到）。

可能是 NULL 的欄位，巨集會給你 `Option<T>`：

- 欄位直接來自資料表、而且有 `NOT NULL` → `T`。上面 `orders` 的欄位都宣告了 `NOT NULL`，所以 `OrderRow` 可以全用非 `Option` 的型別。
- 沒宣告 `NOT NULL` 的欄位，或是運算出來的欄位（`COUNT(*)`、`COALESCE(...)`、函式結果）→ 巨集推不出來，一律當成可能 NULL，給 `Option<T>`。struct 寫成 `T` 就會得到 `expected i64, found Option<i64>` 這種編譯錯誤。

確定不會是 NULL 時，可以在欄位別名後面加 `!` 告訴巨集「當成 NOT NULL」：

```rust
// query!（不是 query_as!）會產生一個匿名 struct，欄位名就是 SELECT 出來的欄位名
let row = sqlx::query!(r#"SELECT COUNT(*) AS "count!" FROM orders"#)
    .fetch_one(pool)
    .await?;
let total: i64 = row.count;      // 沒加 ! 的話，這裡會是 Option<i64>
```

別名要用雙引號包起來，所以整段 SQL 改用 `r#"..."#` 原始字串，裡面的 `"` 就不用跳脫。

### 更新與刪除

```rust
async fn update_customer(pool: &PgPool, id: i64, name: &str) -> Result<u64, sqlx::Error> {
    let result = sqlx::query!("UPDATE orders SET customer = $1 WHERE id = $2", name, id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())        // 回傳被更新的列數（0 代表沒這筆）
}

async fn delete_order(pool: &PgPool, id: i64) -> Result<u64, sqlx::Error> {
    let result = sqlx::query!("DELETE FROM orders WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}
```

---

## 10.7 動態查詢：`query_as`（不帶 `!`）與 `FromRow`

`query_as!`（帶驚嘆號）很安全，但因為要編譯期檢查，SQL 必須是**靜態字串**——不能在執行期拼接條件。當你需要動態組 SQL（例如「有給關鍵字才加 WHERE」），改用不帶 `!` 的 `query_as`，配合 `FromRow` 衍生：

```rust
use sqlx::FromRow;

#[derive(Debug, FromRow)]            // 讓 SQLx 知道怎麼把一列變成這個 struct
struct OrderRow {
    id: i64,
    customer: String,
    amount: i64,
}

async fn search(pool: &PgPool, keyword: Option<&str>) -> Result<Vec<OrderRow>, sqlx::Error> {
    let mut sql = String::from("SELECT id, customer, amount FROM orders");
    if keyword.is_some() {
        sql.push_str(" WHERE customer ILIKE $1");
    }
    // sql 是執行期組出來的 String，要用 AssertSqlSafe 包起來（說明見下）
    let mut q = sqlx::query_as::<_, OrderRow>(sqlx::AssertSqlSafe(sql));
    if let Some(k) = keyword {
        q = q.bind(format!("%{k}%"));    // 用 bind 綁參數（仍然是參數化，安全）
    }
    q.fetch_all(pool).await
}
```

**`AssertSqlSafe` 是什麼？** SQLx 0.9 起，`query` / `query_as` 只直接接受寫死在程式碼裡的字串常值（`&'static str`）。執行期組出來的 `String` 可能混進使用者輸入，直接傳進去會編譯失敗（`dynamic SQL strings should be audited for possible injections`）。用 `sqlx::AssertSqlSafe(...)` 包起來，等於你簽名保證「這段 SQL 只由固定片段組成，使用者輸入都走 `.bind()`」。這是刻意設計的減速丘：code review 時看到 `AssertSqlSafe` 就知道要多看一眼。

差別一句話：**`query_as!`（有 `!`）＝編譯期檢查、SQL 要靜態**；**`query_as`（無 `!`）＝執行期、可動態組、但沒編譯期檢查**。能用有 `!` 的就用，需要動態才降級。

> **更進階**：條件一多，手動對 `$1`、`$2` 的編號很容易出錯。`sqlx::QueryBuilder` 會幫你產生佔位符、同時收集參數，也不需要 `AssertSqlSafe`：
>
> ```rust
> let mut qb = sqlx::QueryBuilder::new("SELECT id, customer, amount FROM orders");
> if let Some(k) = keyword {
>     qb.push(" WHERE customer ILIKE ").push_bind(format!("%{k}%"));   // push_bind 自動產生 $1
> }
> let rows = qb.build_query_as::<OrderRow>().fetch_all(pool).await?;
> ```

---

## 10.8 交易（Transaction）：全成或全敗

有些操作必須「綁在一起」：例如「扣庫存」+「建立訂單」，若扣了庫存卻沒建成訂單，資料就壞了。**交易**保證這一組操作**要嘛全部成功、要嘛全部回滾（rollback）**，不會停在中間的壞狀態（這就是 ACID 的 A：原子性）。

```rust
async fn place_order(pool: &PgPool, id: i64, customer: &str, amount: i64) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;             // 開始交易

    sqlx::query!("INSERT INTO orders (id, customer, amount) VALUES ($1, $2, $3)", id, customer, amount)
        .execute(&mut *tx)                        // 注意：交易內用 &mut *tx，不是 pool
        .await?;

    sqlx::query!("UPDATE inventory SET stock = stock - 1 WHERE product = 'default'")
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;                           // 全部成功 → 提交，變更才真正生效
    Ok(())
}
```

關鍵：

- `pool.begin()` 開交易，拿到一個 `tx`。交易內的查詢對象是 `&mut *tx`，不是 `pool`。
- **`tx.commit()`**：全部成功才提交，變更生效。
- **中途出錯**：任何一個 `?` 提早 return，`tx` 沒 commit 就被 drop——SQLx 會**自動 rollback**（Rust 的 `Drop`，回扣第 02 章）。你不用手動寫 rollback，離開作用域自動回滾。這是 Rust 所有權模型帶來的好處。
- 以這個例子來說：庫存扣到 0 以下時，`CHECK (stock >= 0)` 會讓 UPDATE 失敗 → `?` 提早 return → 前面已經 INSERT 的那筆訂單也跟著回滾，不會出現「有訂單、沒扣庫存」的狀態。

> **心智模型**：交易像「購物車結帳」。一路加東西（多個查詢），最後按「確認付款」（commit）才真的成交。中途關掉頁面（出錯 drop），什麼都不會發生。

---

## 10.9 把它接進第 09 章的架構：`PgOrderRepo`

現在來兌現第 09 章的承諾——寫一個 Postgres 版的 adapter，實作 domain 定義的 `OrderRepository` trait。放在 `crates/infrastructure`。

```rust
// crates/infrastructure/src/pg_order_repo.rs
use async_trait::async_trait;
use domain::{Money, Order, OrderId, OrderRepository, RepoError};
use sqlx::PgPool;

pub struct PgOrderRepo {
    pool: PgPool,          // 連線池（Clone 便宜，可從 AppState 傳進來）
}

impl PgOrderRepo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

// 把 sqlx 的錯誤翻譯成 domain 的 RepoError（回扣第 04、09 章：錯誤跨層翻譯）
fn to_repo_err(e: sqlx::Error) -> RepoError {
    RepoError::Backend(e.to_string())
}

#[async_trait]
impl OrderRepository for PgOrderRepo {
    async fn save(&self, order: &Order) -> Result<(), RepoError> {
        sqlx::query!(
            "INSERT INTO orders (id, customer, amount) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET customer = EXCLUDED.customer, amount = EXCLUDED.amount",
            order.id.0 as i64,               // Postgres 沒有無號整數：u64 轉成 i64 再存
            order.customer,
            order.amount.0,
        )
        .execute(&self.pool)
        .await
        .map_err(to_repo_err)?;              // sqlx::Error → RepoError
        Ok(())
    }

    async fn find(&self, id: OrderId) -> Result<Option<Order>, RepoError> {
        let row = sqlx::query!(
            "SELECT id, customer, amount FROM orders WHERE id = $1",
            id.0 as i64
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(to_repo_err)?;

        // DB 的原始型別 → domain 實體（在 adapter 邊界做轉換）
        Ok(row.map(|r| Order {
            id: OrderId(r.id as u64),
            customer: r.customer,
            amount: Money(r.amount),
        }))
    }

    async fn list(&self) -> Result<Vec<Order>, RepoError> {
        let rows = sqlx::query!(
            "SELECT id, customer, amount FROM orders ORDER BY id"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(to_repo_err)?;

        Ok(rows.into_iter().map(|r| Order {
            id: OrderId(r.id as u64),
            customer: r.customer,
            amount: Money(r.amount),
        }).collect())
    }
}
```

新檔案要在 `crates/infrastructure/src/lib.rs` 掛上去並匯出，外面才用得到：

```rust
// crates/infrastructure/src/lib.rs（加在檔案開頭）
mod pg_order_repo;
pub use pg_order_repo::PgOrderRepo;
```

看清楚這裡發生的事：

- `PgOrderRepo` **實作**了 domain 的 trait。它是一個「adapter」。
- **錯誤在邊界翻譯**：`sqlx::Error`（infrastructure 的細節）被轉成 `RepoError`（domain 的語言）。上層永遠不會看到 `sqlx::Error`——這樣就算哪天換掉 SQLx，上層也無感。
- **型別在邊界轉換**：DB 存的是 `i64`，轉回 domain 的 `OrderId` / `Money` newtype。
- 這裡用的是 `query!`（不是 `query_as!`）：結果是巨集產生的匿名 struct，欄位名就是 SELECT 的欄位名（`r.id`、`r.customer`），再由我們手動轉成 domain 的 `Order`。

組合根要自己建連線池、跑 migration，所以 `api` 這個 crate 也要依賴 sqlx：

```bash
cargo add -p api sqlx@0.9 --features runtime-tokio,postgres,macros,migrate
```

在組合根（`crates/api/src/main.rs`）換上它。`make_pool` 就是 10.4 那個函式，放在同一個檔案即可；`Config` 是第 09 章 9.8 節的設定 struct。業務邏輯這邊**只改建立 repo 的那一行**，第 09 章的 application 層一個字不用動：

```rust
mod config;

use config::Config;
use infrastructure::PgOrderRepo;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

async fn make_pool(database_url: &str) -> Result<sqlx::PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(database_url)
        .await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    let pool = make_pool(&config.database_url).await?;
    sqlx::migrate!("../../migrations").run(&pool).await?;  // 開機自動套 migration（路徑說明見 10.5）

    // 第 09 章是 InMemoryOrderRepo，現在換成 Postgres 版——就這一行差別
    let repo = PgOrderRepo::new(pool);
    let create_order = application::CreateOrder::new(repo);
    // ... 之後第 11 章會把它接進 Axum
    Ok(())
}
```

> **回報時刻**：這就是第 09 章分層的價值兌現。因為 application 只認識 `OrderRepository` trait，把記憶體版換成 Postgres 版，**上層零改動**。測試時用 `InMemoryOrderRepo`（秒回、不連 DB），正式跑用 `PgOrderRepo`。同一套業務邏輯，兩種後端。

---

## 10.10 CI 與離線模式：沒有 DB 也能編譯

`query!` / `query_as!` 要連 DB 檢查，但 CI 環境可能沒有 DB。解法是「離線模式」——先把查詢的中繼資料快取到專案裡：

```bash
# 在有 DB 的開發環境、myshop/ 根目錄執行
# --workspace：把所有 crate 的查詢快取集中到 workspace 根目錄的 .sqlx/
cargo sqlx prepare --workspace

# 把 .sqlx/ 目錄 commit 進 git
```

`prepare` 會在背後跑一次 `cargo check`，把每個 `query!` 的欄位型別、NULL 與否存成 `.sqlx/query-<雜湊>.json`。之後巨集的判斷規則是：

- **有 `DATABASE_URL`**（環境變數或 `.env`）→ 連 DB 檢查。
- **沒有 `DATABASE_URL`** → 讀 `.sqlx/` 快取；快取裡找不到這條查詢就編譯失敗。
- **設了 `SQLX_OFFLINE=true`** → 不管有沒有 `DATABASE_URL`，一律只讀快取。CI 與 Docker 建置建議明確設定它，避免不小心連到某個 DB。

CI 裡還可以加一步 `cargo sqlx prepare --check --workspace`（需要能連 DB），它會在 `.sqlx/` 跟目前的 SQL 或資料表結構對不上時失敗，提醒你忘了重新 `prepare`。改了 SQL 或 migration 之後，記得重跑 `cargo sqlx prepare --workspace` 再 commit。這讓「編譯期 SQL 檢查」與「CI 無 DB」兩者兼得。

---

## 10.11 對照：如果用 SeaORM 會怎樣

給你一個對照，感受 ORM 的風格差異（不強求你用）。SeaORM 你先定義「entity」，再用它的 API 操作，少寫 SQL。以下是 SeaORM 2.x 的寫法（想實際跑跑看：`cargo add sea-orm@2 --features sqlx-postgres,runtime-tokio`）：

```rust
// 先定義 entity：一個資料表一個 module（實務上多用 sea-orm-cli 從資料庫結構產生）
mod order {
    use sea_orm::entity::prelude::*;

    #[sea_orm::model]
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "orders")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub customer: String,
        pub amount: i64,
    }

    // 新增/更新前後的掛勾（hook），不需要就留空，但這行不能省
    impl ActiveModelBehavior for ActiveModel {}
}

use sea_orm::{ActiveModelTrait, DatabaseConnection, DbErr, EntityTrait, Set};

// 操作：用 Rust API，而非手寫 SQL
async fn example(db: &DatabaseConnection) -> Result<(), DbErr> {
    // 查詢：SELECT ... FROM orders WHERE id = 1
    let found: Option<order::Model> = order::Entity::find_by_id(1).one(db).await?;
    println!("{found:?}");
    // 新增：ActiveModel 的每個欄位用 Set(...) 標記「要寫入的值」
    let new = order::ActiveModel { id: Set(2), customer: Set("Bob".into()), amount: Set(500) };
    new.insert(db).await?;
    Ok(())
}
```

`DeriveEntityModel` 會從 `Model` 幫你產生 `Entity`（拿來查詢）、`ActiveModel`（拿來新增/修改）、`Column` 等型別，所以程式裡才會出現 `order::Entity`、`order::ActiveModel`。

| 面向 | SQLx | SeaORM |
|------|------|--------|
| 你寫 SQL 嗎 | 是（原生 SQL） | 幾乎不用 |
| 關聯載入（join/relations） | 自己寫 SQL | 內建關聯 API |
| 透明度 | 高（所見即所得） | 低（多一層抽象） |
| 適合場景 | 掌控 SQL、效能敏感 | 資料模型複雜、想快速開發 CRUD |

> **選型建議**：學習與掌控優先 → SQLx；關聯繁雜、想少寫 SQL、團隊偏好 ORM → SeaORM（它底層其實也用 SQLx）。兩者都很成熟。**本課後續（第 11、13 章）都以 SQLx 為主。**

---

## 10.12 常見錯誤

- **`cargo build` 報 ``set `DATABASE_URL` to use query macros online, or run `cargo sqlx prepare` to update the query cache``**→ `query!` 巨集找不到 DB 也找不到快取。設好 `DATABASE_URL`（`myshop/.env`）並確保 DB 開著、已套 migration，或用離線模式（10.10）。
- **巨集報「relation "orders" does not exist」**→ DB 連得上，但還沒套 migration。先 `sqlx migrate run`。
- **`expected i64, found Option<i64>`**→ 欄位可能是 NULL（沒宣告 `NOT NULL`，或是 `COUNT(*)` 這類運算結果）。struct 改用 `Option<T>`，或確定不會 NULL 時用 `AS "欄位名!"`（10.6）。
- **把 `String` 直接傳給 `sqlx::query` / `query_as`**→ SQLx 0.9 會擋下（`dynamic SQL strings should be audited...`）。確認使用者輸入都走 `.bind()` 後用 `sqlx::AssertSqlSafe(...)` 包起來，或改用 `QueryBuilder`（10.7）。
- **交易裡忘了 `commit`**→ 離開作用域自動 rollback，變更「沒生效」還以為成功了。記得 `tx.commit().await?`。
- **交易內對 `pool` 而非 `&mut *tx` 下查詢**→ 那條查詢跑在池子另一條連線上，不在交易內，破壞原子性。交易內一律用 `&mut *tx`。
- **用字串拼接把使用者輸入塞進 SQL**→ SQL injection。永遠用 `$1` 參數化或 `.bind()`。
- **struct 欄位型別跟 DB 對不上**（如 DB `BIGINT` 用 `String` 接）→ `query_as!` 編譯期就報錯，照著改型別。
- **每個請求都 `PgPool::connect` 開新池**→ 應該全程式共用一個池（放 `AppState`），`clone` 池只是加參考。
- **`max_connections` 設太大**→ 超過 DB 上限反而報錯或拖垮 DB。依 DB 設定與實例數量調。
- **手動去 DB 改表、不寫 migration**→ 環境間結構不一致、無法重現。一律走 migration。

---

## 10.13 本章小結

- 用 **Docker** 起 PostgreSQL，連線字串放 `.env`（回扣第 09 章）。
- **選型**：SQLx（原生 SQL + 編譯期檢查，本課主力）、SeaORM（async ORM）、Diesel（強型別 DSL）。
- **連線池 `PgPool`**：預開一批連線供借還，`Clone` 便宜（內部 Arc），放 `AppState` 共享。
- **Migration**：用 `sqlx migrate add/run` 做結構的版本控制；可用 `migrate!` 開機自動套用。
- **CRUD**：`query!`（execute）、`query_as!`（映射 struct）＋ `execute/fetch_one/fetch_optional/fetch_all`；`$1` 參數化天然防注入；**編譯期驗證 SQL** 是招牌。
- 可能 NULL 的欄位對到 `Option<T>`；確定不會 NULL 的運算欄位用 `AS "x!"` 覆寫。
- 動態 SQL 用不帶 `!` 的 `query_as` + `FromRow` + `.bind()`（犧牲編譯期檢查換彈性），執行期組出的字串要用 `AssertSqlSafe` 包起來，或改用 `QueryBuilder`。
- **交易**：`pool.begin()` → `&mut *tx` → `commit()`；出錯 drop 自動 rollback。
- **接進架構**：`PgOrderRepo` 實作 domain 的 `OrderRepository`，在邊界翻譯錯誤與型別；組合根換一行即可切換實作。
- CI 無 DB 用 `cargo sqlx prepare --workspace` + commit `.sqlx/` + `SQLX_OFFLINE=true`。

---

## 10.14 動手作業

1. 用 `docker compose` 起 PostgreSQL，用 `psql` 或任何 GUI 連上去確認可用。
2. 建一個 `users` 表的 migration（`id BIGINT PRIMARY KEY`、`email TEXT NOT NULL UNIQUE`、`created_at TIMESTAMPTZ NOT NULL DEFAULT now()`），`sqlx migrate run` 套用。
3. 寫 `insert_user` / `find_user_by_email`，用 `query!` 與 `query_as!`，體會編譯期檢查（故意打錯欄位名看報錯）。
4. 寫一個 `list_users` 回傳 `Vec<User>`，並加上 `ORDER BY created_at DESC`。
5. 寫一個交易：同時 INSERT 兩筆 user，其中一筆故意違反 `UNIQUE`，觀察整批 rollback（兩筆都沒進去）。
6. 承第 09 章作業的 `UserRepository`，寫一個 `PgUserRepo` 實作它，並在組合根從 `InMemoryUserRepo` 換成它。
7. 執行 `cargo sqlx prepare --workspace`，觀察產生的 `.sqlx/` 目錄，理解離線模式怎麼運作。

---

## 10.15 驗收清單

- [ ] 我能用 Docker 起 PostgreSQL 並取得連線字串。
- [ ] 我能解釋連線池的必要性，並用 `PgPool` 管理連線。
- [ ] 我會用 `sqlx migrate` 建立與套用 migration。
- [ ] 我會用 `query!` / `query_as!` 做 CRUD，並理解編譯期 SQL 檢查與參數化防注入。
- [ ] 我會用交易確保一組操作的原子性，也知道出錯會自動 rollback。
- [ ] 我能寫一個 Postgres 版 repo 實作第 09 章的 trait，並在邊界翻譯錯誤與型別。
- [ ] 我能說出 SQLx 與 SeaORM 的差異與選型考量。

---

**資料庫串接篇（10）完成。** 你的服務現在有了持久化能力，而且因為分層做得好，資料庫只是一個「可抽換的 adapter」。

下一章 [11-building-web-api-axum.md](./11-building-web-api-axum.md) 要把服務「對外開門」——用 **Axum** 建立 RESTful API：路由、擷取器（extractor）、`AppState`、middleware，以及把第 09 章的分層錯誤映射成 HTTP 狀態碼。你會看到 HTTP handler 有多薄——它只負責「翻譯請求、呼叫用例、組回應」，真正的邏輯都在下面那幾層。回到 [課程首頁](./README.md)。
