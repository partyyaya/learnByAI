# 第 12 章：串接外部 API —— reqwest、serde、逾時、重試與韌性

> 上一章讓服務「被呼叫」，這一章讓服務去「呼叫別人」。真實後端幾乎不會孤立存在——要打金流、寄信、查天氣、驗證第三方帳號、串 AI API⋯⋯
> 我們用 **reqwest**（Rust 最主流的 async HTTP client，跟第 08 章的 Tokio、第 11 章的 Axum 同生態）發請求，用第 04 章的 serde 解析回應。
> 但重點不只是「發出去」——外部 API 會慢、會逾時、會偶爾失敗、會回你沒預期的格式。這章會教你把這些「不可靠」處理好：**逾時、重試、錯誤映射、並發、以及測試**。這是「能上線」跟「玩具」的分水嶺。

---

## 12.1 學習目標

完成本章後，你應該可以：

- 用 reqwest 發 GET / POST，帶查詢參數、JSON body、標頭與認證。
- 用 serde 把回應反序列化成 Rust struct（處理欄位對應、選填、改名）。
- **重用 `Client`**，理解為什麼不能每次請求都 new 一個。
- 設定逾時，並用退避（backoff）重試暫時性失敗。
- 把 reqwest 錯誤映射成你的 domain 錯誤（回扣第 09 章邊界翻譯）。
- 用第 08 章的並發手法同時打多個下游，大幅縮短總延遲。
- 把外部呼叫包成第 09 章的「adapter」，並用 mock server 測試它。

---

## 12.2 為什麼外部呼叫「特別難」

呼叫自己的資料庫，你大致能掌控；呼叫**別人的** API，你什麼都掌控不了：

- 它可能**很慢**（跨網路、對方負載高）——你不能無限等。
- 它可能**逾時或斷線**——暫時性故障。
- 它可能**回錯**（429 限流、500 當機、格式突然改）。
- 它的失敗會**傳染**給你——你的服務會跟著慢、跟著掛。

> **核心心態**：對外部依賴要「防禦性設計」。假設它**會**慢、**會**失敗，把逾時、重試、降級都準備好。一個沒設逾時的外部呼叫，就是一顆等著在半夜引爆的地雷——對方一卡住，你的連線池就被耗盡，整個服務跟著癱。

加依賴：

```bash
cargo add reqwest --features json --no-default-features --features "json,rustls-tls"
cargo add serde --features derive
cargo add tokio --features full
```

> `rustls-tls` 用純 Rust 的 TLS 實作，跨平台、不依賴系統 OpenSSL，容器化部署最省心。

---

## 12.3 第一個請求：GET + 解析 JSON

```rust
use serde::Deserialize;

// 用 serde 描述「我預期對方回什麼」（回扣第 04 章）
#[derive(Debug, Deserialize)]
struct Todo {
    id: u32,
    title: String,
    completed: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::new();

    let todo: Todo = client
        .get("https://jsonplaceholder.typicode.com/todos/1")
        .send()                        // 送出請求，回傳 Response
        .await?
        .error_for_status()?           // 4xx/5xx 直接轉成 Err（很重要！見下）
        .json()                        // 把 body 反序列化成 Todo
        .await?;

    println!("{todo:?}");
    Ok(())
}
```

逐步看：

- `client.get(url)` 建一個 GET 請求；`.send().await` 送出、拿回 `Response`。
- **`.error_for_status()?`**：這步很關鍵。reqwest **預設不會**因為 4xx/5xx 就報錯——`send()` 成功只代表「有收到回應」，就算是 404 也算「成功收到」。加上 `error_for_status()` 才會把 4xx/5xx 轉成 `Err`。**新手最常漏這步**，結果把錯誤頁面當成功資料去解析。
- `.json::<Todo>().await?`：把 JSON body 反序列化成你的 struct。型別對不上、缺欄位都會在這裡報錯。

---

## 12.4 重用 `Client`：不要每次都 new

`reqwest::Client` 內部維護一個**連線池**（跟第 10 章的 DB 連線池同理）與 TLS 設定。**建立 `Client` 是昂貴的**——每次請求都 `Client::new()` 會丟掉連線重用、每次重做 TLS 握手，慢又浪費。

**正確做法：整個程式共用一個 `Client`。** 它是 `Clone` 的（內部 `Arc`），clone 便宜，放進第 09 章的 `AppState` 到處共享：

```rust
use std::time::Duration;

fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))            // 整個請求（含讀 body）的總逾時
        .connect_timeout(Duration::from_secs(3))     // 只算「建立連線」的逾時
        .pool_max_idle_per_host(10)                  // 每個 host 保留的閒置連線數
        .user_agent("myshop/1.0")                    // 禮貌：表明身分
        .build()
        .expect("建立 HTTP client 失敗")
}
```

> **對比 DB 連線池（第 10 章）**：兩者哲學一樣——「預先開好、重複利用」。DB 是 `PgPool`，HTTP 是 `reqwest::Client`。都要「全程式共用一個、放進共享狀態」，都**別**在每次操作時重建。

---

## 12.5 各種請求：查詢參數、body、標頭、認證

```rust
use serde::Serialize;

#[derive(Serialize)]
struct CreatePost { title: String, body: String, user_id: u32 }

async fn examples(client: &reqwest::Client) -> anyhow::Result<()> {
    // 查詢參數 ?page=2&size=10（用 tuple 陣列，reqwest 自動編碼）
    let _ = client
        .get("https://api.example.com/items")
        .query(&[("page", "2"), ("size", "10")])
        .send().await?;

    // POST JSON body（自動序列化 + 設 Content-Type: application/json）
    let created = client
        .post("https://jsonplaceholder.typicode.com/posts")
        .json(&CreatePost { title: "hi".into(), body: "world".into(), user_id: 1 })
        .send().await?
        .error_for_status()?;
    println!("狀態：{}", created.status());

    // 自訂標頭 + Bearer token 認證
    let _ = client
        .get("https://api.example.com/me")
        .header("X-Request-Id", "abc-123")
        .bearer_auth("my-secret-token")              // → Authorization: Bearer my-secret-token
        .send().await?;

    // 基本認證
    let _ = client
        .get("https://api.example.com/private")
        .basic_auth("user", Some("pass"))
        .send().await?;

    Ok(())
}
```

| 方法 | 作用 |
|------|------|
| `.query(&[(k, v), ...])` | 加查詢字串，自動 URL 編碼 |
| `.json(&t)` | body 設為 JSON（`t` 要 `Serialize`） |
| `.header(k, v)` | 自訂標頭 |
| `.bearer_auth(token)` | `Authorization: Bearer ...` |
| `.basic_auth(u, p)` | HTTP Basic 認證 |
| `.form(&t)` | body 設為 `application/x-www-form-urlencoded` |

---

## 12.6 serde 反序列化的實戰技巧

真實 API 的 JSON 常常「不合你意」——欄位命名是 camelCase、有些欄位可能不存在、有些名字是 Rust 保留字。serde 都有解：

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]        // JSON 用 camelCase，Rust 用 snake_case，自動對應
struct WeatherResponse {
    temperature: f64,
    feels_like: f64,                      // 對應 JSON 的 "feelsLike"
    #[serde(rename = "type")]            // "type" 是 Rust 關鍵字，改名對應
    weather_type: String,
    #[serde(default)]                    // 對方沒給這欄就用預設值（Option 給 None、數字給 0）
    humidity: Option<u8>,
    #[serde(default)]
    tags: Vec<String>,                   // 沒給就是空 vec，不會報錯
}
```

| 標註 | 作用 |
|------|------|
| `#[serde(rename_all = "camelCase")]` | 整個 struct 的欄位命名風格轉換 |
| `#[serde(rename = "xxx")]` | 單一欄位對應到不同的 JSON 名 |
| `#[serde(default)]` | 欄位缺失時用預設值（搭配 `Option` 處理「可能沒有」） |
| `#[serde(flatten)]` | 把巢狀物件攤平進來 |

> **防禦性反序列化**：外部 API 的格式**不受你控制**，隨時可能加欄位、改欄位。原則是「**只宣告你要用的欄位**」——serde 預設會忽略你沒宣告的多餘欄位，所以對方加欄位不會弄壞你。而「可能不存在」的欄位一律用 `Option` + `#[serde(default)]`，別假設它一定在。

---

## 12.7 逾時：絕不做「沒有期限」的等待

上面在 `Client::builder()` 設了全域逾時。也可以針對單一請求覆寫：

```rust
use std::time::Duration;

let resp = client
    .get("https://slow.example.com/data")
    .timeout(Duration::from_secs(5))      // 這個請求最多等 5 秒
    .send()
    .await;

match resp {
    Ok(r) => { /* ... */ }
    Err(e) if e.is_timeout() => eprintln!("逾時了，走降級邏輯"),
    Err(e) => eprintln!("其他錯誤：{e}"),
}
```

- `e.is_timeout()`、`e.is_connect()`、`e.is_status()` 讓你分辨錯誤種類，決定「該不該重試」（逾時、連線失敗值得重試；4xx 通常不該重試）。

> **鐵則**：**每一個外部呼叫都要有逾時。** 沒有逾時的請求，在對方卡住時會一直佔著你的執行緒 / 連線；請求一多，你的連線池被榨乾，整個服務被一個慢的下游拖垮（連鎖故障）。逾時是韌性的第一道防線。

---

## 12.8 重試與退避（Backoff）

暫時性失敗（逾時、503、連線重置）常常「再試一次就好」。但重試要有分寸：**不要立刻猛試**（會加重對方負載），而要用**指數退避 + 抖動（jitter）**——每次失敗等更久，並加點隨機避免大家同時重試（thundering herd）。

手寫一個簡單版，讓你看清原理：

```rust
use std::time::Duration;
use tokio::time::sleep;

async fn get_with_retry(client: &reqwest::Client, url: &str) -> anyhow::Result<reqwest::Response> {
    let mut attempt = 0;
    let max_attempts = 4;

    loop {
        attempt += 1;
        match client.get(url).send().await {
            // 成功且非 5xx → 直接回
            Ok(resp) if resp.status().is_success() => return Ok(resp),

            // 5xx 或逾時/連線錯 → 值得重試（若還有次數）
            Ok(resp) if resp.status().is_server_error() && attempt < max_attempts => {
                let backoff = 100 * 2u64.pow(attempt - 1);   // 100ms, 200ms, 400ms...（指數退避）
                eprintln!("第 {attempt} 次收到 {}，{backoff}ms 後重試", resp.status());
                sleep(Duration::from_millis(backoff)).await;
            }
            Err(e) if (e.is_timeout() || e.is_connect()) && attempt < max_attempts => {
                let backoff = 100 * 2u64.pow(attempt - 1);
                eprintln!("第 {attempt} 次錯誤 {e}，{backoff}ms 後重試");
                sleep(Duration::from_millis(backoff)).await;
            }

            // 4xx（你送錯了，重試也沒用）或次數用盡 → 放棄
            Ok(resp) => return Ok(resp.error_for_status()?),
            Err(e) => return Err(e.into()),
        }
    }
}
```

哪些該重試、哪些不該：

| 情況 | 重試？ | 原因 |
|------|--------|------|
| 逾時、連線重置 | ✅ | 暫時性，可能下次就好 |
| 500 / 502 / 503 | ✅ | 對方暫時故障 |
| 429（限流） | ✅（尊重 `Retry-After`） | 等一下再來 |
| 400 / 401 / 404 | ❌ | 是你的請求本身有問題，重試無用 |
| 非冪等的 POST | ⚠️ 小心 | 重試可能造成重複下單/扣款（見下） |

> **冪等性（idempotency）警告**：重試 GET 很安全（讀取無副作用）。但重試「建立資源」的 POST（下單、扣款）可能造成**重複執行**。做法：對方 API 支援「idempotency key」時帶上它（同一 key 對方只處理一次），或只對明確冪等的操作重試。

> **生產建議**：實務別自己手寫，用成熟 crate——`reqwest-retry` + `reqwest-middleware`（把重試做成 middleware）、或 `backoff` crate。原理就是上面這套，但邊界情況處理得更完整。手寫版是給你「理解它在做什麼」。

---

## 12.9 錯誤映射：把 reqwest 錯誤翻成 domain 語言

回扣第 09 章——外部呼叫是一個「adapter」，它的錯誤（`reqwest::Error`）是 infrastructure 的細節，**不該洩漏到上層**。在邊界翻譯成你自己的錯誤型別：

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WeatherError {
    #[error("外部服務逾時")]
    Timeout,
    #[error("外部服務回應錯誤：{0}")]
    Upstream(u16),                    // 帶狀態碼
    #[error("回應格式無法解析")]
    BadFormat,
    #[error("網路錯誤：{0}")]
    Network(String),
}

fn map_reqwest_err(e: reqwest::Error) -> WeatherError {
    if e.is_timeout() {
        WeatherError::Timeout
    } else if e.is_decode() {
        WeatherError::BadFormat
    } else if let Some(status) = e.status() {
        WeatherError::Upstream(status.as_u16())
    } else {
        WeatherError::Network(e.to_string())
    }
}
```

這樣上層（用例層、interface 層）看到的是 `WeatherError`，可以決定「逾時就降級用快取、Upstream 500 就回 502 給 client」——而不用去認識 reqwest 的細節。第 11 章的 `ApiError` 再把 `WeatherError` 映射成 HTTP 狀態碼，全鏈打通。

---

## 12.10 並發呼叫多個下游（回扣第 08 章）

後端常要「同時打好幾個外部服務、等它們一起回來再匯總」。循序做會把延遲相加，並發做則接近「最慢那個」。用第 08 章的 `tokio::join!`：

```rust
use tokio::join;

// 同時打三個獨立的下游，總時間 ≈ 最慢的那個（而非三者相加）
async fn aggregate(client: &reqwest::Client, user_id: u64) -> anyhow::Result<Dashboard> {
    let (profile, orders, points) = join!(
        fetch_profile(client, user_id),
        fetch_orders(client, user_id),
        fetch_points(client, user_id),
    );
    Ok(Dashboard { profile: profile?, orders: orders?, points: points? })
}
```

若是「同一種請求打很多次」（例如查 100 個 id），別開 100 個一起炸對方——用 `futures::stream` 的 `buffer_unordered` 控制並發數：

```bash
cargo add futures
```

```rust
use futures::{stream, StreamExt};

async fn fetch_many(client: &reqwest::Client, ids: Vec<u64>) -> Vec<anyhow::Result<Item>> {
    stream::iter(ids)
        .map(|id| fetch_item(client, id))
        .buffer_unordered(8)         // 最多同時 8 個在飛（限制並發，保護對方也保護自己）
        .collect()
        .await
}
```

> **並發要有節制**：`join!` 適合「少數幾個不同的下游」；大量同種請求用 `buffer_unordered(N)` 限流。無腦全並發等於對下游發動 DDoS，對方限流你、你自己也可能耗盡連線。「並發有上限」是禮貌也是自保。

---

## 12.11 包成 adapter：接進第 09 章的架構

把外部天氣服務包成一個實作 domain trait 的 adapter，讓上層透過抽象使用它——跟第 10 章的 `PgOrderRepo` 完全同一套路。

```rust
// domain 層：定義 port（業務對「取得天氣」的需求，不管來源）
#[async_trait::async_trait]
pub trait WeatherProvider: Send + Sync {
    async fn current(&self, city: &str) -> Result<Weather, WeatherError>;
}

// infrastructure 層：用 reqwest 實作它
pub struct HttpWeatherProvider {
    client: reqwest::Client,      // 共用的 client（12.4）
    base_url: String,
    api_key: String,              // 從第 09 章的 Config 注入，不寫死
}

#[async_trait::async_trait]
impl WeatherProvider for HttpWeatherProvider {
    async fn current(&self, city: &str) -> Result<Weather, WeatherError> {
        let resp = self.client
            .get(format!("{}/weather", self.base_url))
            .query(&[("q", city), ("appid", &self.api_key)])
            .send().await.map_err(map_reqwest_err)?
            .error_for_status().map_err(map_reqwest_err)?;

        let body: WeatherResponse = resp.json().await.map_err(map_reqwest_err)?;
        Ok(Weather { temperature: body.temperature, description: body.weather_type })
    }
}
```

- 這是第 09 章「port + adapter」的另一個實例：`WeatherProvider` 是 port，`HttpWeatherProvider` 是 adapter。
- 上層（用例）只認識 `WeatherProvider` trait，**不知道**天氣是從 HTTP 來的。測試時可換成 `StubWeatherProvider` 回固定值——不打真的外部 API。
- `api_key` 從第 09 章的 `Config` 注入，**絕不寫死**。

---

## 12.12 測試外部呼叫：用 mock server

測試時**不該真的打外部 API**（慢、不穩、可能收費、對方不希望被測試流量打）。用 `wiremock` 起一個假的 HTTP server，讓你的 client 打它，回你指定的假回應：

```bash
cargo add wiremock --dev
cargo add tokio --dev --features full
```

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{Mock, MockServer, ResponseTemplate};
    use wiremock::matchers::{method, path};

    #[tokio::test]
    async fn fetches_weather_ok() {
        // 1. 起一個假 server
        let mock = MockServer::start().await;

        // 2. 設定：當有人 GET /weather，就回這段 JSON
        Mock::given(method("GET"))
            .and(path("/weather"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "temperature": 25.5,
                "type": "Clear"
            })))
            .mount(&mock)
            .await;

        // 3. 讓 adapter 打向假 server（base_url 指向 mock）
        let provider = HttpWeatherProvider {
            client: reqwest::Client::new(),
            base_url: mock.uri(),
            api_key: "test".into(),
        };

        let weather = provider.current("Taipei").await.unwrap();
        assert_eq!(weather.temperature, 25.5);
    }

    #[tokio::test]
    async fn maps_500_to_upstream_error() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))       // 模擬對方掛掉
            .mount(&mock).await;

        let provider = HttpWeatherProvider {
            client: reqwest::Client::new(), base_url: mock.uri(), api_key: "test".into(),
        };
        let err = provider.current("Taipei").await.unwrap_err();
        assert!(matches!(err, WeatherError::Upstream(500)));   // 驗證錯誤映射正確
    }
}
```

> **測試的價值**：mock server 讓你能測「正常回應、500、逾時、格式錯」各種情境，**不依賴真外部服務**。這樣你才敢放心地寫重試、錯誤映射——因為你能重現各種失敗來驗證它們。這是把「不可靠的外部依賴」變「可測試」的關鍵。

---

## 12.13 一句話帶過的進階韌性

真實生產還有幾個進階概念，先知道名字，需要時再深入：

- **斷路器（Circuit Breaker）**：某下游連續失敗到一定次數，就「跳閘」一段時間——直接快速失敗、不再打它，給它喘息、也不拖垮自己。恢復後再半開試探。
- **限流（Rate Limiting）**：控制「你對下游的請求速率」，尊重對方的配額（避免被 429）。
- **降級（Fallback / Graceful Degradation）**：下游掛了就回快取、回預設值、或標記「暫時無法取得」，而不是整個請求失敗。
- **超時預算（Timeout Budget）**：整個請求的總時間有限，分配給各下游，避免「重試 + 多層呼叫」把總延遲拖到失控。

> 這些都是「把不可靠的外部世界，包成對你可控」的手法。核心心態不變：**假設外部會失敗，設計好失敗時怎麼辦。**

---

## 12.14 常見錯誤

- **漏掉 `error_for_status()`**→ 把 404/500 的錯誤頁當成功資料去解析。務必加上它。
- **每次請求都 `Client::new()`**→ 丟失連線重用、重做 TLS，很慢。全程式共用一個 `Client`。
- **沒設逾時**→ 對方一卡，你的連線池被榨乾、服務連鎖故障。每個外呼都要逾時。
- **無腦重試所有錯誤**→ 4xx 重試無用；非冪等 POST 重試會重複下單。分清該不該重試。
- **重試不退避、猛打**→ 加重對方負載（thundering herd）。用指數退避 + 抖動。
- **serde struct 假設欄位一定在**→ 對方少給就整個解析失敗。可能缺的用 `Option` + `#[serde(default)]`。
- **把 `reqwest::Error` 直接往上拋 / 回給 client**→ 洩漏細節、上層被綁死。在邊界映射成 domain 錯誤。
- **大量同種請求全並發**→ 等於 DDoS 對方。用 `buffer_unordered(N)` 限並發。
- **api_key 寫死在程式**→ 外洩。從第 09 章的 Config 注入。

---

## 12.15 本章小結

- **reqwest** 是 Rust 主流 async HTTP client；`get/post` + `.query/.json/.header/.bearer_auth` 組請求，`.json::<T>()` 用 serde 解析回應。
- **務必 `error_for_status()?`**：reqwest 預設不把 4xx/5xx 當錯誤。
- **重用 `Client`**：內含連線池，全程式共用一個（放 `AppState`），別每次 new。
- **serde 防禦性反序列化**：只宣告要用的欄位、可能缺的用 `Option` + `#[serde(default)]`、用 `rename(_all)` 對應命名。
- **逾時是鐵則**：每個外呼都要逾時，否則會連鎖故障。
- **重試要有分寸**：指數退避 + 抖動；只重試暫時性失敗；小心非冪等操作（用 idempotency key）。生產用 `reqwest-retry`。
- **錯誤映射**：把 `reqwest::Error` 在邊界翻成 domain 錯誤（第 09 章），別洩漏細節。
- **並發**：少數不同下游用 `join!`（第 08 章），大量同種用 `buffer_unordered(N)` 限流。
- **包成 adapter**：實作 domain 的 `WeatherProvider` trait，上層只認抽象；用 `wiremock` 測各種情境。

---

## 12.16 動手作業

1. 用 reqwest GET `https://jsonplaceholder.typicode.com/todos/1`，用 serde 解析成 struct 印出來，記得加 `error_for_status()`。
2. 建一個帶逾時的共用 `Client`（`Client::builder().timeout(...)`），並在多個請求間重用它。
3. POST 一個 JSON body 到 `https://jsonplaceholder.typicode.com/posts`，印出回應狀態碼。
4. 寫一個回應 struct，其中一個欄位用 `#[serde(default)]` + `Option`，故意讓它在 JSON 裡缺失，驗證不會報錯。
5. 實作 12.8 的 `get_with_retry`（指數退避），用一個會回 500 的測試端點（或 wiremock）驗證它重試。
6. 用 `tokio::join!` 同時打三個 `todos/{1,2,3}`，比較跟「循序」的總耗時差異。
7. 把外部呼叫包成一個實作 domain trait 的 adapter，並用 `wiremock` 寫兩個測試：成功回應、以及 500 → 錯誤映射正確。

---

## 12.17 驗收清單

- [ ] 我會用 reqwest 發 GET/POST，帶查詢參數、JSON body、標頭與認證。
- [ ] 我知道要加 `error_for_status()`，也知道為什麼要重用 `Client`。
- [ ] 我會用 serde 防禦性地解析回應（`Option`、`default`、`rename`）。
- [ ] 我會為每個外呼設逾時，並說出「不設逾時」的連鎖故障風險。
- [ ] 我會用指數退避重試暫時性失敗，並知道哪些不該重試、冪等性的坑。
- [ ] 我會把 reqwest 錯誤在邊界映射成 domain 錯誤。
- [ ] 我會用 `join!` / `buffer_unordered` 並發呼叫，並用 wiremock 測試 adapter。

---

**網路 API 篇（12）完成。** 你的服務現在「既能被呼叫、也能去呼叫別人」，而且對外部的不可靠有了防禦。

你已經蒐集齊所有拼圖：**語言核心（01~08）＋ 架構（09）＋ 資料庫（10）＋ Web API（11）＋ 外部 API（12）**。下一章 [13-capstone-fullstack-backend-service.md](./13-capstone-fullstack-backend-service.md) 是**期末成品**——我們把全部縫成一個真正的後端服務：分層架構承載業務、PostgreSQL 持久化、Axum 對外提供 RESTful API、reqwest 串接外部服務來豐富資料，並加上測試、Docker 化與部署。準備好把學到的一切變成一個能上線的成品了嗎？回到 [課程首頁](./README.md)。
