# 第 14 章：高併發與韌性 —— 讓服務在流量尖峰下不倒

> 第 08 章教你 async 為什麼能「同時扛上萬連線」，第 12 章教你呼叫**別人**時怎麼防禦（逾時、重試、斷路器點名版）。
> 這一章換個方向：當**別人**（或攻擊、或行銷活動）突然把海量流量打到**你**身上，你的服務怎麼「活下來」而不是「一起陪葬」。
> 重點不是「跑得更快」，而是「**過載時優雅地拒絕，而不是全體崩潰**」。我們會把第 12.13 節只點名的斷路器、限流、背壓，全部寫成能跑的實作，
> 並為第 13 章的 Bookshelf 成品加上一整套韌性防護。這是「能上線」跟「能扛住雙 11」的分水嶺。

---

## 14.1 學習目標

完成本章後，你應該可以：

- 說出「服務在高併發下是怎麼一步步倒的」，並理解 Little's Law 的直覺。
- 用 **bounded channel** 建立背壓（backpressure），避免記憶體無限膨脹。
- 用 **`tokio::sync::Semaphore`** 限制並發數，保護自己與下游。
- 用 **Tower layer**（`ConcurrencyLimitLayer` + `LoadShedLayer` + rate limit）在伺服器端限流與負載卸除。
- 手寫一個**斷路器（circuit breaker）**，理解 Closed / Open / Half-Open 三態。
- 診斷並化解**鎖競爭**：`RwLock`、縮小臨界區、不跨 `.await` 持鎖、`DashMap`。
- 用**快取**（`moka` / Redis）擋掉重複的昂貴工作，並處理 cache stampede。
- 做**容量規劃**（連線池大小）與**無狀態的水平擴展**，並知道要量測哪些指標。

---

## 14.2 心智模型：服務是怎麼「倒」的

先看敵人長怎樣。假設你的服務平常每秒處理 1000 個請求、每個花 50ms，一切安好。某天流量暴增到每秒 5000，或某個下游變慢（每個請求變 500ms）。接著會發生**連鎖崩潰**：

```text
流量暴增 / 下游變慢
   │
   ▼
處理不完 → 請求開始「堆積」（in-flight 暴增）
   │
   ▼
每個堆積的請求都佔著：一條 task、一份記憶體、一條 DB 連線
   │
   ▼
連線池被榨乾 → 新請求連 DB 都借不到連線 → 更慢
記憶體暴漲 → 可能 OOM 被系統砍掉
   │
   ▼
全部請求都超過逾時 → 客戶端重試 → 流量「雪上加霜」（重試風暴）
   │
   ▼
整個服務癱瘓（明明只是「有點慢」，卻演變成「全掛」）
```

> **關鍵領悟**：壓垮服務的往往不是「慢」，而是「**沒有上限地接受工作**」。一個沒有任何限制的服務，過載時會試圖服務**所有人**，結果**誰都服務不好**，最後同歸於盡。韌性設計的核心心態是：**寧可明確地拒絕一部分請求（回 503），也不要讓全體一起慢死。** 這叫「負載卸除（load shedding）」——救生艇滿了就得拒絕再上人，否則全船翻覆。

### Little's Law：一條你該記住的直覺

排隊理論有個簡單公式，貫穿本章：

```text
系統中的在途請求數 (L)  =  到達速率 (λ)  ×  每個請求的處理時間 (W)
```

- 到達 1000 req/s、每個處理 50ms（0.05s）→ 同時在途 = 1000 × 0.05 = **50 個**。系統要能同時撐住 50 個。
- 如果下游變慢，W 從 50ms 變 500ms → 在途瞬間變 **500 個**。同樣的流量，資源需求暴增 10 倍——這就是「下游變慢會拖垮你」的數學原因。

> **兩種應對哲學**：**擴容（scale up/out）** 是「加資源去消化」；**自保（shed/limit）** 是「限制接受量、保護核心」。兩者要並用——但**自保是底線**，因為擴容需要時間，而尖峰是瞬間的。本章重點在「自保」，14.11 才談擴容。

---

## 14.3 背壓（Backpressure）：滿了就要能「推回去」

回扣第 08 章——我們用 `mpsc` channel 做生產者-消費者。但那時用的是 **unbounded**（無上限）channel，這在高併發下是顆炸彈：**生產者比消費者快時，訊息會無限堆積在 channel 裡，記憶體爆掉。**

**背壓**的意思是：「下游忙不過來時，要能讓上游**慢下來或擋住**」，而不是默默把工作堆到記憶體。做法就是用 **bounded channel**：

```rust
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    // 有上限的 channel：最多存 100 個未處理訊息
    let (tx, mut rx) = mpsc::channel::<Job>(100);

    // 消費者：慢慢處理
    tokio::spawn(async move {
        while let Some(job) = rx.recv().await {
            process(job).await;           // 假設處理很慢
        }
    });

    // 生產者：當 channel 滿了，send().await 會「卡住等」——這就是背壓
    for i in 0..10_000 {
        // 若 channel 滿（100 個沒消化），這行會 await 直到有空位
        // → 生產者自動被「拖慢」到跟消費者同步，記憶體不會爆
        tx.send(Job(i)).await.unwrap();
    }
}
```

- **`mpsc::channel(100)`**（bounded）：容量滿時，`send().await` 會**等待**直到有空位——這股「等待」就沿著呼叫鏈往上傳，形成背壓。
- **`mpsc::unbounded_channel()`**（unbounded）：`send` 永不阻塞，但**沒有背壓**，堆積無上限。高併發服務**避免使用**。
- 若不想等、想「滿了就拒絕」，用 **`tx.try_send(job)`**：滿了立刻回 `Err`，你就可以回應「系統忙碌，稍後再試」（這就是 load shedding 的雛形）。

| | bounded `channel(n)` | unbounded `unbounded_channel()` |
|---|---|---|
| 滿的時候 | `send().await` 等（背壓）/ `try_send` 拒絕 | 繼續塞，記憶體無限漲 |
| 高併發適用 | ✅ | ❌ 危險 |
| 何時用 unbounded | 你**確定**生產速率有天然上限時 | — |

> **心智模型**：bounded channel 像餐廳的候位牌只有 100 張。發完了，門口的服務生（生產者）就得讓客人在外面等（`await`）或請他們改天再來（`try_send` 失敗）。unbounded 則是「來多少都收進來擠在店裡」——遲早擠爆。**背壓就是把「忙不過來」這個訊號誠實地往上游傳。**

---

## 14.4 用 Semaphore 限制並發數

有時你要限制的不是「排隊長度」，而是「**同時進行的數量**」——例如「呼叫某個脆弱的下游，最多同時 10 個」「一段吃記憶體的處理，最多同時 5 個」。這用 **`tokio::sync::Semaphore`（號誌）**。

號誌就是「一疊許可證（permit）」。要做事先領一張，領不到就等；做完歸還。持有的許可數就是當下的並發數上限。

```rust
use std::sync::Arc;
use tokio::sync::Semaphore;

#[tokio::main]
async fn main() {
    // 最多同時 10 個並發
    let sem = Arc::new(Semaphore::new(10));

    let mut handles = vec![];
    for i in 0..1000 {
        let sem = Arc::clone(&sem);
        handles.push(tokio::spawn(async move {
            // 領許可：若 10 張都被借走，這裡會 await 等別人歸還
            let _permit = sem.acquire().await.unwrap();
            expensive_call(i).await;
            // _permit 離開作用域自動 drop → 歸還許可（回扣第 02 章 Drop）
        }));
    }
    for h in handles { h.await.unwrap(); }
}
```

- **`Semaphore::new(10)`**：發行 10 張許可。
- **`.acquire().await`**：領一張；沒得領就等。回傳的 `permit` 一 drop 就自動歸還——你不用手動釋放，靠所有權（第 02 章）。
- 這保證「無論丟進來幾千個任務，同時真正執行的最多 10 個」。

> **和第 12 章 `buffer_unordered(N)` 的關係**：`buffer_unordered` 是「處理一個 stream 時限並發」的**便利糖**，底層概念就是號誌。`Semaphore` 是更通用的原語——你可以用它包住**任何**一段程式（handler 內某段、背景任務、跨多個不同操作共用同一個限額）。兩者都在做同一件事：**替並發設一個天花板。**

> **為什麼限並發能救命**：不限的話，過載時你會同時開 10000 個 task 去打下游 → 打垮下游、也吃光自己的記憶體與連線。限 10 個 → 多的乖乖排隊或被拒，下游只承受它能承受的量。**限並發同時保護了下游和你自己。**

---

## 14.5 伺服器端限流與負載卸除（Tower layer）

上面是「零件」，現在把它裝到第 11 章的 Axum server 上。Axum 的 middleware 是 Tower layer（第 11 章），Tower 內建了整套過載保護 layer。

### 經典組合：並發上限 + 負載卸除

```rust
use axum::{error_handling::HandleErrorLayer, http::StatusCode, BoxError, Router};
use tower::{ServiceBuilder, load_shed::LoadShedLayer, limit::ConcurrencyLimitLayer};
use std::time::Duration;

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/books", get(list_books).post(add_book))
        // ...
        .layer(
            ServiceBuilder::new()
                // 3. 把過載錯誤轉成 HTTP 回應（放最外層先攔）
                .layer(HandleErrorLayer::new(|err: BoxError| async move {
                    if err.is::<tower::load_shed::error::Overloaded>() {
                        (StatusCode::SERVICE_UNAVAILABLE, "系統忙碌，請稍後再試")   // 503
                    } else {
                        (StatusCode::INTERNAL_SERVER_ERROR, "internal error")
                    }
                }))
                // 2. 過載時「快速失敗」，不排隊
                .layer(LoadShedLayer::new())
                // 1. 同時最多處理 100 個請求（超過的讓內層變 not-ready）
                .layer(ConcurrencyLimitLayer::new(100))
        )
        .with_state(state)
}
```

發生了什麼（layer 由內往外）：

1. **`ConcurrencyLimitLayer::new(100)`**：同時最多 100 個請求在處理。第 101 個到來時，內層服務「還沒 ready」。
2. **`LoadShedLayer`**：看到內層 not-ready，**立刻**回一個 `Overloaded` 錯誤（而不是排隊等）——這就是負載卸除：**寧可快速拒絕，不要拖著大家慢死。**
3. **`HandleErrorLayer`**：把 `Overloaded` 錯誤轉成 `503 Service Unavailable`，客戶端就知道「該退避重試」，而不是傻等到逾時。

> **為什麼是 503 而不是排隊？** 排隊會讓每個請求的延遲越來越長（Little's Law），最後全部超時——使用者體驗是「什麼都打不開」。快速回 503 則是「保住能處理的那 100 個、明確拒絕多的」——**部分成功遠勝全體失敗**。這就是 fail-fast 哲學。

### 速率限流（Rate Limiting）

限「同時數量」是並發限流；限「每秒幾個」是速率限流。Tower 有 `RateLimitLayer`（全域固定速率），但實務更常要**「每個 IP / 每個 API key」分別限流**，用 `tower_governor`：

```bash
cargo add tower_governor
```

```rust
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};

let governor_conf = GovernorConfigBuilder::default()
    .per_second(2)           // 每 2 秒補 1 個 token
    .burst_size(5)           // 允許短暫爆量到 5
    .finish()
    .unwrap();

let app = Router::new()
    .route(/* ... */)
    .layer(GovernorLayer::new(governor_conf));           // 超過限額回 429 Too Many Requests
```

- 底層是**令牌桶（token bucket）**：桶裡的令牌以固定速率補充，每個請求耗一個令牌，沒令牌就回 `429`。`burst_size` 允許短暫爆發。
- `tower_governor` 的 `per_second(n)` 不是「每秒 n 個」，而是「每 n 秒補 1 個 token」。若要近似每秒 10 個，應使用更短的補充週期或改用其他支援每秒速率語意的 limiter。照官方範例時，務必讀清楚這個語意，否則限流量級會差很多。
- 限流保護你不被單一惡意/失控的客戶端打爆，也讓資源公平分配。

| 手法 | 限制什麼 | Rust 工具 | 過載時回 |
|------|---------|-----------|---------|
| 並發限制 | 同時處理數 | `ConcurrencyLimitLayer` / `Semaphore` | 排隊 or 503 |
| 負載卸除 | 過載即拒 | `LoadShedLayer` | 503 |
| 速率限流 | 每秒/每來源數 | `tower_governor` | 429 |
| 背壓 | 佇列長度 | bounded channel | 等 or 拒 |

---

## 14.6 逾時預算：別讓重試 × 多層放大延遲

第 11、12 章都講了逾時。高併發下要多想一層：**逾時要有「整體預算」，不能各層各設一個大數字。**

想像一條呼叫鏈：API handler(逾時 10s) → 用例 → 打下游 A(逾時 10s，重試 3 次) → 打下游 B(逾時 10s)。最壞情況：光下游 A 就可能 30s，早就超過 handler 的 10s，那些重試全是白做工、還佔著資源。

原則：

- **從外往內分配預算**：整體 10s，扣掉自己處理，剩下的分給下游；下游的逾時要**小於**剩餘預算。
- **重試要算進預算**：`逾時 × (重試次數+1)` 不能超過上層預算。
- **越靠近使用者，逾時越短**：使用者不會等 30s。前端逾時 3s，那你的內部逾時全都要更短。

```rust
// 概念示意：把「剩餘預算」往下傳，下游取 min(自己上限, 剩餘)
async fn call_with_budget(client: &reqwest::Client, url: &str, budget: Duration) -> Result<Resp, Err> {
    let timeout = budget.min(Duration::from_secs(2));   // 不超過整體預算，也不超過自己的 2s
    client.get(url).timeout(timeout).send().await // ...
}
```

> **回扣第 12 章的連鎖故障**：沒有逾時預算，一個慢下游 + 積極重試，會讓在途請求暴增（Little's Law），連線池榨乾——這就是 14.2 的崩潰劇本。逾時預算是「把慢的影響限制在可控範圍」的關鍵。

---

## 14.7 斷路器（Circuit Breaker）：完整實作

第 12.13 節只點了名，這裡把它寫出來。斷路器解決的問題：**某下游已經掛了，你卻還在一直打它——白等逾時、浪費資源、也不給對方喘息。** 斷路器像電箱的跳閘：連續故障到一定程度就「跳閘」，之後**直接快速失敗、不再打**，過一陣子再試探性地恢復。

三個狀態：

```text
        連續失敗達門檻
  Closed ──────────────▶ Open
   ▲  正常放行            │ 直接快速失敗（不打下游）
   │                     │ 冷卻時間到
   │  試探成功            ▼
   └──────────── Half-Open
      試探失敗 → 回 Open   放行「少量」試探請求
```

- **Closed（閉合）**：正常，請求照常通過，同時計數失敗。
- **Open（斷開）**：跳閘了。所有請求**直接快速失敗**（回 fallback 或錯誤），完全不碰下游。維持一段冷卻時間。
- **Half-Open（半開）**：冷卻時間到，放**少量**請求去試探。成功就回 Closed（恢復），失敗就回 Open（繼續斷開）。

一個教學用的簡化實作：

```rust
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq)]
enum State { Closed, Open, HalfOpen }

pub struct CircuitBreaker {
    inner: Mutex<Inner>,
    failure_threshold: u32,        // 連續失敗幾次就跳閘
    cooldown: Duration,            // Open 狀態維持多久
}

struct Inner {
    state: State,
    consecutive_failures: u32,
    opened_at: Option<Instant>,
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, cooldown: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner { state: State::Closed, consecutive_failures: 0, opened_at: None }),
            failure_threshold,
            cooldown,
        }
    }

    // 呼叫前先問：現在能放行嗎？
    pub fn allow_request(&self) -> bool {
        let mut g = self.inner.lock().unwrap();
        match g.state {
            State::Closed => true,
            State::HalfOpen => true,     // 半開：放行試探
            State::Open => {
                // 冷卻時間到了？到了就轉半開、放行一個試探
                if g.opened_at.map_or(false, |t| t.elapsed() >= self.cooldown) {
                    g.state = State::HalfOpen;
                    true
                } else {
                    false                // 還在冷卻 → 快速失敗
                }
            }
        }
    }

    pub fn on_success(&self) {
        let mut g = self.inner.lock().unwrap();
        g.consecutive_failures = 0;
        g.state = State::Closed;         // 成功 → 恢復正常
    }

    pub fn on_failure(&self) {
        let mut g = self.inner.lock().unwrap();
        g.consecutive_failures += 1;
        if g.state == State::HalfOpen || g.consecutive_failures >= self.failure_threshold {
            g.state = State::Open;       // 達門檻或半開試探失敗 → 跳閘
            g.opened_at = Some(Instant::now());
        }
    }
}

// 用法：包住第 12 章的外部呼叫
async fn lookup_with_breaker(cb: &CircuitBreaker, /* client... */) -> Result<Book, MetadataError> {
    if !cb.allow_request() {
        return Err(MetadataError::Upstream("circuit open（快速失敗）".into()));  // 不打下游，秒回
    }
    match do_actual_lookup(/* ... */).await {
        Ok(book) => { cb.on_success(); Ok(book) }
        Err(e)   => { cb.on_failure(); Err(e) }
    }
}
```

> **注意**：`Instant::now()` 在一般程式可用（本課的 workflow 限制不影響你的專案）。這個手寫版是為了讓你**看懂三態怎麼運作**；生產環境建議用成熟 crate（如 `failsafe`），它處理了滑動視窗統計、半開的並發試探數控制等細節。

> **斷路器 vs 重試**：兩者互補。**重試**應付「偶發、單次」的暫時失敗；**斷路器**應付「持續性」的故障——當重試都救不回來時，斷路器出手「別再試了，先放棄一陣子」。沒有斷路器的重試，在下游全掛時反而會用重試風暴補刀。

---

## 14.8 鎖競爭：高併發的隱形殺手

第 07、08 章教你用 `Arc<Mutex<T>>` 共享可變狀態。在低併發下沒事，但**高併發下，`Mutex` 會變成瓶頸**：所有 task 都要搶同一把鎖，搶不到就排隊——你以為在並發，其實大家在鎖前面排成一條線，並發度被鎖「序列化」了。

### 症狀與四招解法

**第 1 招：縮小臨界區（最重要）**。鎖只在「真的要改共享資料」的那一瞬間持有，別把耗時操作包在鎖裡。

```rust
// ❌ 壞：整個昂貴計算都握著鎖，別人全卡住
{
    let mut data = shared.lock().unwrap();
    let result = expensive_compute(&data);   // 這段其他 task 全在等鎖！
    data.value = result;
}

// ✅ 好：先在鎖外算完，只在最後寫入時瞬間持鎖
let result = expensive_compute_from_snapshot();
{
    let mut data = shared.lock().unwrap();
    data.value = result;                     // 臨界區極短
}
```

**第 2 招：多讀少寫用 `RwLock`**。讀多寫少時，`RwLock` 允許**多個讀取者同時進行**（只有寫入才獨佔），並發度大增。

```rust
use tokio::sync::RwLock;                      // async 版
let config = Arc::new(RwLock::new(AppConfig::default()));

let r = config.read().await;                  // 多個讀取可並行
// let mut w = config.write().await;          // 寫入時才獨佔
```

**第 3 招：絕不跨 `.await` 持有 `std::Mutex`**（回扣第 08 章）。`std::sync::MutexGuard` 不是 `Send`，握著它 `.await` 會讓 future 變 `!Send` → 無法 `tokio::spawn`（編譯錯），更糟的情況會**死結**。要嘛在 `.await` 前釋放鎖，要嘛用 `tokio::sync::Mutex`（它的 guard 可跨 await，但代價是稍慢——能不跨就別跨）。

```rust
// ❌ 危險：握著 std Mutex 跨 await
let guard = data.lock().unwrap();
some_async_call().await;                       // guard 還握著 → !Send / 可能死結
// ✅ 好：先取出需要的、放掉鎖，再 await
let value = { data.lock().unwrap().clone() };  // 鎖在這個 block 結束就放掉
some_async_call_with(value).await;
```

**第 4 招：分片鎖 `DashMap`**。如果共享的是一個 map（例如快取、連線註冊表），`Mutex<HashMap>` 會讓整張表共用一把鎖。`dashmap::DashMap` 內部把資料**分成很多片、每片一把鎖**，不同 key 的操作幾乎不互相阻塞。

```rust
use dashmap::DashMap;                          // cargo add dashmap
let map: Arc<DashMap<String, u64>> = Arc::new(DashMap::new());
map.insert("a".into(), 1);                     // 不同 key 的並發寫入互不阻塞
```

**第 5 招（釜底抽薪）：用訊息取代共享**。回扣第 08 章那句話——「用溝通來共享記憶體」。與其多個 task 搶一把鎖改狀態，不如把狀態交給**單一 owner task**，其他人透過 channel 送指令給它（actor 模式）。沒有鎖，就沒有鎖競爭。

> **診斷心法**：服務在高併發下「CPU 沒滿、卻很慢」，很可能就是鎖競爭——大家都在等鎖，CPU 閒著。用 profiling / tracing 找出熱點鎖，先套第 1 招（縮小臨界區），再考慮換工具。

---

## 14.9 快取：擋掉重複的昂貴工作

高併發下最有效的優化往往是「**根本別做那件事**」。如果 1000 個請求都在查同一本書的資料，何必查 1000 次 DB / 打 1000 次外部 API？查一次、快取起來，其餘 999 個直接命中。

### 記憶體快取：`moka`

`moka` 是 Rust 的高效能並發快取，支援 TTL（過期）、容量上限（LRU 淘汰）、且**並發安全**：

```bash
cargo add moka --features future
```

```rust
use moka::future::Cache;
use std::time::Duration;

// 最多存 10000 筆、每筆存活 5 分鐘
let cache: Cache<String, BookMetadata> = Cache::builder()
    .max_capacity(10_000)
    .time_to_live(Duration::from_secs(300))
    .build();

// get_with：快取有就回，沒有就跑閉包載入並存起來
async fn lookup_cached(cache: &Cache<String, BookMetadata>, isbn: String) -> BookMetadata {
    cache
        .get_with(isbn.clone(), async move {
            fetch_from_external_api(&isbn).await   // 只有 miss 時才真的打外部
        })
        .await
}
```

**`get_with` 的殺手級特性：single-flight（請求合併）**。如果同一個 key 有 1000 個並發請求同時 miss，`get_with` 保證**只執行一次**載入閉包，其餘 999 個等這一次的結果——這正好解決下面的問題。

### Cache Stampede（快取擊穿 / 驚群效應）

想像一個熱門 key 的快取**剛好過期**的那一瞬間，1000 個請求同時發現 miss，於是**1000 個同時**去打 DB/外部——瞬間把後端打爆。這叫 cache stampede。

- `moka` 的 `get_with` 用 single-flight 天然化解它（同 key 並發 miss 只載一次）。
- 若用 Redis 等分散式快取，要自己實作「單飛鎖」或「提前更新（early refresh）」。

### 分散式快取：Redis

記憶體快取的問題：**多個服務實例各有各的快取**，不共享、也會隨重啟消失。要跨實例共享，用 **Redis**：

```bash
cargo add redis --features tokio-comp
```

```rust
// 概念示意：先查 Redis，miss 才查 DB 並回填
async fn get_book(redis: &redis::Client, db: &PgPool, id: i64) -> Book {
    // 1. 查快取
    if let Some(cached) = redis_get(redis, id).await { return cached; }
    // 2. miss → 查 DB
    let book = query_db(db, id).await;
    // 3. 回填快取（設 TTL）
    redis_set_ex(redis, id, &book, 300).await;
    book
}
```

| | `moka`（記憶體） | Redis（分散式） |
|---|---|---|
| 速度 | 最快（本機記憶體） | 快（跨網路一跳） |
| 多實例共享 | ❌ 各自獨立 | ✅ 共享 |
| 重啟保留 | ❌ | ✅ |
| 適合 | 單實例、超熱資料 | 多實例、需一致 |

> **實務常見兩層快取**：L1 用 `moka`（本機、超快、擋大部分）、L2 用 Redis（跨實例、兜底）。但別過早引入——先量測「哪裡真的是瓶頸」再加快取，否則多了一致性（快取失效）的複雜度卻沒解決真問題。

> **快取要小心的坑**：**失效（invalidation）** 是快取兩大難題之一（「電腦科學只有兩件難事：快取失效與命名」）。資料改了，對應快取要清掉或更新，否則使用者看到舊資料。寫入時同步失效、或用短 TTL 容忍短暫不一致，依業務取捨。

---

## 14.10 容量規劃：連線池到底要開多大

第 10 章開了 `max_connections(10)`，第 12 章開了 HTTP 連線池。高併發下，這些數字**不能亂設**——太小會排隊、太大會壓垮下游。用 Little's Law 算：

- 假設每個請求要用 DB 連線 20ms、目標 500 req/s → 同時需要 = 500 × 0.02 = **10 條連線**。設 `max_connections(10~15)` 合理。
- **多實例要相乘**：如果跑 8 個服務實例、每個池 10 條 → DB 同時面對 **80 條連線**。PostgreSQL 預設上限約 100，你已逼近。**池大小 × 實例數 ≤ DB 連線上限**（還要留額度給 migration、維運工具）。

```text
       ┌─ 太小 ─┐         ┌─ 剛好 ─┐         ┌─ 太大 ─┐
連線池  │ 請求排隊 │         │ 順暢    │         │ DB 被  │
大小    │ 借不到  │  ◀────  │ 吞吐最佳 │  ────▶  │ 連線壓垮│
       └────────┘         └────────┘         └────────┘
```

> **反直覺重點**：連線池**不是越大越好**。DB 能真正並行處理的連線有限（受 CPU 核心、磁碟影響），連線開太多，DB 光是排程這些連線就耗掉資源，整體反而變慢。很多效能問題的解法是把池「調小」到跟 DB 的甜蜜點匹配，讓排隊發生在**應用層**（可控、可觀測）而非**DB 層**（不可控）。這也呼應 14.3 的背壓——排隊要排在你能管理的地方。

---

## 14.11 水平擴展：無狀態設計

自保（前面各節）是底線，但流量真的長期成長，還是得**加機器**（水平擴展）。能不能加機器，取決於你的服務是不是**無狀態（stateless）**。

```text
        ┌──────────┐
請求 ──▶ │ 負載均衡  │ ──┬──▶ 實例 A ─┐
        └──────────┘   ├──▶ 實例 B ─┼──▶ 共享的 PostgreSQL / Redis
                       └──▶ 實例 C ─┘
        （任何請求打到任何實例，結果都一樣 = 無狀態）
```

無狀態的意思：**實例本身不存「只有它知道」的資料**。所有狀態放到外部共享儲存（DB、Redis）：

- ❌ 把使用者 session 存在實例的記憶體 → 下次請求打到別台就找不到。
- ✅ session 存 Redis / DB → 哪台都讀得到，可隨意增減實例。
- ❌ 把上傳的檔案存在本機磁碟 → 換台就沒了。
- ✅ 存物件儲存（S3 等）。

只要無狀態，擴展就變成「加幾台 + 負載均衡指過去」這麼簡單。這也回扣：

- **第 11 章的健康檢查 `/health`**：讓負載均衡知道哪台活著、把流量導向健康的實例。
- **第 12 章的冪等性**：多實例 + 重試環境下，重複請求不能造成重複副作用（用 idempotency key）。
- **第 13 章的組態走環境變數**：每台實例用同一份映像、不同環境變數，才能快速複製。

> **心智模型**：無狀態實例像便利商店的店員——每個都一樣、可互相替代、隨時能多請幾個。有狀態實例像「只有老王知道倉庫密碼」——老王請假就停擺，也沒法多請一個老王。**設計成人人可替代，才能規模化。**

---

## 14.12 觀測性：沒有量測，就無法談高併發

前面所有調校（池大小、並發上限、快取），**沒有數據就是瞎猜**。高併發下你必須能回答：「現在多少請求在途？連線池用了幾成？p99 延遲多少？」

該盯的關鍵指標：

| 指標 | 意義 | 過載徵兆 |
|------|------|---------|
| **in-flight requests**（在途請求數） | 同時處理中的量 | 持續攀升 = 消化不良（Little's Law） |
| **連線池使用率** | 借出/總數 | 接近 100% = 池太小或下游慢 |
| **佇列深度 / channel 長度** | 積壓量 | 持續變長 = 背壓失效 |
| **延遲分佈 p50/p95/p99** | 尾延遲 | p99 暴增 = 部分請求在受苦 |
| **錯誤率 / 503 / 429 率** | 拒絕比例 | 上升 = 正在卸載或過載 |
| **斷路器狀態** | Open/Closed | Open = 某下游掛了 |

工具：

- **`tracing`**（第 11 章已用）：結構化 log + span，可算每段耗時。
- **`metrics`** crate + Prometheus/Grafana：輸出上表指標，畫成儀表板、設告警。
- **壓測**：`oha`、`wrk`、`k6`——上線前**自己先把服務打到倒**，找出它的極限與瓶頸，才知道限流門檻要設多少。

```bash
# 用 oha 壓測：模擬 200 並發、持續 30 秒打你的 API
oha -c 200 -z 30s http://localhost:8080/books
# 看它回報的 p99 延遲、每秒請求數、錯誤率——這才是你設定 ConcurrencyLimit 的依據
```

> **鐵律**：**先量測，再優化。** 憑感覺加快取、調池子，常常是解錯問題。用壓測 + 指標找出「真正的瓶頸」（是 DB？是某個鎖？是外部 API？），對症下藥。過早優化不但浪費，還會增加你剛學的這些複雜度。

---

## 14.13 綜合範例：為 Bookshelf 加上完整韌性

把本章縫進第 13 章的成品。目標：讓 Bookshelf 在流量尖峰與下游故障時，**優雅降級而非崩潰**。

```rust
// state.rs：韌性元件放進共享狀態（第 09、11 章）
use std::sync::Arc;
use moka::future::Cache;

#[derive(Clone)]
pub struct AppState {
    pub add_book: Arc<application::AddBook<CachedProvider, PgBookRepository>>,
    pub repo: Arc<dyn domain::BookRepository>,
    pub meta_cache: Cache<String, domain::BookMetadata>,   // 14.9 快取
}
```

```rust
// infrastructure：用「快取 + 斷路器 + 號誌」包住原本的 OpenLibraryProvider
pub struct CachedProvider {
    inner: OpenLibraryProvider,          // 第 13 章的實作
    cache: Cache<String, BookMetadata>,  // 14.9
    breaker: Arc<CircuitBreaker>,        // 14.7
    limiter: Arc<Semaphore>,             // 14.4：限制同時打外部的數量
}

#[async_trait]
impl BookMetadataProvider for CachedProvider {
    async fn lookup(&self, isbn: &Isbn) -> Result<BookMetadata, MetadataError> {
        let key = isbn.as_str().to_string();

        // try_get_with 具備 single-flight：同 ISBN 並發 miss 時，只會有一個閉包真的打外部。
        // 成功才寫入快取；失敗不快取，避免把暫時性錯誤保存起來。
        self.cache.try_get_with(key.clone(), async {
            // 1. 斷路器：外部若已掛，快速失敗、不浪費資源
            if !self.breaker.allow_request() {
                return Err(MetadataError::Upstream("書目服務暫時停用中".into()));
            }
            // 2. 號誌：同時最多 N 個打外部，保護對方也保護自己
            let _permit = self.limiter.acquire().await.unwrap();

            // 3. 真的呼叫（內部已有第 12 章的逾時 + 重試）
            match self.inner.lookup(isbn).await {
                Ok(meta) => { self.breaker.on_success(); Ok(meta) }
                Err(e)   => { self.breaker.on_failure(); Err(e) }
            }
        }).await.map_err(|e| MetadataError::Upstream(e.to_string()))
    }
}
```

> **注意 `try_get_with` 的錯誤型別**：moka 會把初始化錯誤包成 `Arc<E>` 回傳，因為同一個 miss 可能有多個並發呼叫在等待同一個錯誤。上面為了保持示例簡短，把它轉成 `Upstream(String)`；正式專案可讓錯誤型別實作 `Clone` 後保留原始 variant，或在 cache 層統一回傳 `Arc<MetadataError>`。

```rust
// handlers.rs / router：伺服器端限流 + 負載卸除（14.5）
Router::new()
    .route("/books", get(list_books).post(add_book))
    .route("/books/{id}", get(get_book).delete(delete_book))
    .layer(
        ServiceBuilder::new()
            .layer(HandleErrorLayer::new(handle_overload))    // 503
            .layer(LoadShedLayer::new())
            .layer(ConcurrencyLimitLayer::new(200))           // 依壓測結果設定
            .layer(TimeoutLayer::new(Duration::from_secs(5))) // 逾時預算（14.6）
    )
    .layer(GovernorLayer::new(governor_conf))                 // 每 IP 限流（14.5）
    .with_state(state)
```

這樣一來，Bookshelf 具備了層層防護：

```text
請求進來
  │ 每 IP 限流（429）───────── 擋住單一來源打爆
  │ 並發上限 + 負載卸除（503）─ 過載時保護能處理的、拒絕多的
  │ 逾時預算 ───────────────── 限制單一請求最長時間
  ▼
查快取（命中就秒回，擋掉大部分外部呼叫）
  │ miss
  ▼
斷路器（外部掛了就快速失敗，不陪葬）
  │ 通過
  ▼
號誌（限制同時打外部的數量）
  ▼
逾時 + 退避重試（第 12 章）打 Open Library
```

> **層層防護的哲學**：每一層都在回答「當事情變糟時，我這一關要怎麼保護整體？」。單獨看每個手法都不難，難的是**意識到要在正確的位置放正確的防護**。這張圖就是一個生產級 Rust 後端「面對高併發與故障」的完整縮影。

---

## 14.14 常見錯誤

- **用 unbounded channel 當工作佇列**→ 生產快於消費時記憶體爆掉。改 bounded channel 建立背壓。
- **過載時選擇「排隊」而非「拒絕」**→ 延遲無限增長、全體逾時。該用 load shed 快速回 503。
- **握著 `std::Mutex` 跨 `.await`**→ future `!Send` 無法 spawn、或死結。先放鎖再 await，或不跨 await 持鎖。
- **把耗時操作包在鎖的臨界區裡**→ 鎖競爭、並發被序列化。臨界區只放「寫入那一瞬間」。
- **連線池開超大以為更快**→ 壓垮 DB、反而更慢。依 Little's Law 算，池大小 × 實例數 ≤ DB 上限。
- **熱門 key 快取過期造成 stampede**→ 用 `moka` 的 `get_with`（single-flight）或提前更新。
- **有重試卻沒斷路器**→ 下游全掛時重試風暴補刀。加斷路器「別再試了」。
- **把 session/檔案存在實例本機**→ 無法水平擴展。狀態外置到 Redis/DB/物件儲存。
- **不量測就調參數**→ 瞎猜瓶頸、優化錯地方。先壓測 + 指標，再對症下藥。
- **逾時各層各設大數字**→ 重試 × 多層放大延遲。設整體逾時預算、越外層越短。

---

## 14.15 本章小結

- 服務崩潰多是「**無上限地接受工作**」導致的連鎖故障；核心心態是「**寧可明確拒絕一部分，也不要全體慢死**」（load shedding）。
- **Little's Law**（在途 = 到達率 × 處理時間）解釋了「下游變慢為何拖垮你」，也是容量規劃的依據。
- **背壓**：用 bounded channel，滿了就 `await`（拖慢上游）或 `try_send` 拒絕，避免記憶體爆掉。
- **`Semaphore`**：替並發設天花板，同時保護下游與自己（`buffer_unordered` 是其便利糖）。
- **Tower 過載保護**：`ConcurrencyLimitLayer` + `LoadShedLayer`（→ 503）+ `tower_governor`（每來源限流 → 429）。
- **逾時預算**：從外往內分配、把重試算進去、越靠使用者越短。
- **斷路器**：Closed/Open/Half-Open 三態，持續故障時快速失敗、給下游喘息，補重試的不足。
- **鎖競爭**：縮小臨界區、`RwLock` 多讀、不跨 `.await` 持 `std::Mutex`、`DashMap` 分片、或用訊息取代共享。
- **快取**：`moka`（記憶體、`get_with` 防 stampede）、Redis（跨實例）；先量測再加，小心失效。
- **容量規劃**：連線池不是越大越好，池大小 × 實例數 ≤ DB 上限。
- **水平擴展**靠**無狀態設計**（狀態外置）；**觀測性**（in-flight、池使用率、p99、壓測）是一切調校的前提——**先量測，再優化**。

---

## 14.16 動手作業

1. 把第 08 章的 unbounded `mpsc` 改成 bounded（容量 10），生產者快速送 1000 筆、消費者慢速處理，觀察 `send().await` 被背壓拖慢。
2. 用 `tokio::sync::Semaphore` 限制「同時最多 5 個」任務執行昂貴操作，丟 100 個進去驗證同時只有 5 個在跑。
3. 為第 11/13 章的 Axum 服務加上 `ConcurrencyLimitLayer + LoadShedLayer + HandleErrorLayer`，用 `oha -c 500` 壓測，觀察過載時回 503 而非全部逾時。
4. 加 `tower_governor` 每 IP 每秒限 5 個，用 `curl` 連打驗證第 6 個開始回 429。
5. 實作 14.7 的 `CircuitBreaker`，用一個「連續失敗 3 次就 Open」的設定 + wiremock（第 12 章）模擬下游持續 500，驗證跳閘後請求秒回、冷卻後半開恢復。
6. 用 `moka` 為外部查詢加快取（TTL 60s），用 `get_with` 讓「同 ISBN 的 100 個並發請求只打一次外部」，並印出實際打了幾次。
7. 寫一段故意「握鎖跨 await」的程式，看編譯器報什麼錯（`!Send`），再改成「先放鎖再 await」修好。
8. （挑戰）把第 13 章的 Bookshelf 套上 14.13 的完整韌性層，壓測前後對比：無防護時打到多少並發會崩、有防護時能否穩定回 503/429 而不崩。

---

## 14.17 驗收清單

- [ ] 我能說明服務在高併發下的連鎖崩潰過程，並用 Little's Law 解釋。
- [ ] 我知道「負載卸除（快速回 503）」為何優於「無限排隊」。
- [ ] 我會用 bounded channel 建立背壓、用 `Semaphore` 限制並發數。
- [ ] 我會用 Tower 的 `ConcurrencyLimitLayer`/`LoadShedLayer` 與 `tower_governor` 做伺服器端過載保護與限流。
- [ ] 我能手寫並解釋斷路器的三個狀態，也知道它跟重試如何互補。
- [ ] 我能診斷鎖競爭，並用縮小臨界區、`RwLock`、`DashMap`、不跨 await 持鎖等手法化解。
- [ ] 我會用 `moka`/Redis 快取，並知道 cache stampede 與失效的坑。
- [ ] 我理解連線池容量規劃、無狀態水平擴展，以及「先量測再優化」的觀測性原則。

---

**進階強化篇（14）完成。** 你的服務現在不只「能上線」，還「扛得住尖峰、擋得住故障」——這正是資深後端工程師與初階的分野。

你已經走完了從 Rust 語法到生產級高併發後端的完整旅程。把第 13 章的成品套上這章的韌性防護，你就有了一個真正**可上線、可擴展、可觀測**的 Rust 服務。接下來可以拿真實流量去驗證、持續量測與調校；如果你想往 GPU/AI 方向延伸，則可接著走第 15～17 章的 `wgpu → GPU Compute → AI` 進階路線。

回到 [課程首頁](./README.md) 複習任何章節。去把你的服務打到倒，再讓它站起來。🦀
