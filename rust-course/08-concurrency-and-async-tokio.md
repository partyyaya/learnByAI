# 第 08 章：併發與非同步 —— thread、async/await 與 Tokio

> 這是進階能力篇的重頭戲，也是通往「高效能後端服務」的最後一塊語言基石。
> 我們先講 OS 執行緒與 Rust 招牌的「無懼併發（fearless concurrency）」——編譯器如何用第 02、07 章的規則，
> 在編譯期就擋掉資料競爭；再進到 `async`/`await` 與 **Tokio**：現代後端處理「同時上萬個連線」靠的就是它。
> 第 11 章的 web server 就跑在 Tokio 上，所以這章請務必弄懂 async 的心智模型。

---

## 8.1 學習目標

完成本章後，你應該可以：

- 用 `thread::spawn` 開執行緒，並用 `join` 等它結束。
- 理解 `move` 閉包在多執行緒為何幾乎必用（回扣第 05 章）。
- 說明 Rust 如何用 `Send`/`Sync` 與借用規則達成「無懼併發」。
- 用 channel（`mpsc`）在執行緒間傳訊息。
- 分清「並行（parallelism）」與「並發（concurrency）」，以及「執行緒」與「async」各適合什麼。
- 理解 `async`/`await`、Future、以及「為什麼需要 runtime」。
- 用 Tokio 寫非同步程式：`#[tokio::main]`、`tokio::spawn`、`.await`、並行執行多個任務。

---

## 8.2 先分清兩個常被混用的詞

- **並行（Parallelism）**：真的「同時」做多件事——靠多核心 CPU，多個任務在不同核心上同一瞬間執行。適合 **CPU 密集**工作（大量運算）。
- **並發（Concurrency）**：「交錯」處理多件事——不一定同時，而是快速切換，讓多個任務都有進展。適合 **I/O 密集**工作（大量等待網路、磁碟、資料庫回應）。

後端服務的特性是：**大部分時間在「等」**（等資料庫回、等外部 API 回、等網路傳輸）。所以後端的關鍵不是「算得多快」，而是「等的時候能不能去做別的事」——這正是 **async 並發**的主場。

> **心智模型**：一個廚師（單核心）煮三道菜。**並行**是請三個廚師各煮一道（多核心）。**並發**是一個廚師在麵煮著、湯燉著的「等待空檔」去切菜、擺盤——沒有真的同時做，但透過「等待時去做別的」讓三道菜都在推進。後端就像那個聰明的廚師。

---

## 8.3 OS 執行緒：`thread::spawn`

最直接的併發是開作業系統執行緒：

```rust
use std::thread;
use std::time::Duration;

fn main() {
    let handle = thread::spawn(|| {          // 開一個新執行緒
        for i in 1..=5 {
            println!("子執行緒：{i}");
            thread::sleep(Duration::from_millis(10));
        }
    });

    for i in 1..=3 {
        println!("主執行緒：{i}");
        thread::sleep(Duration::from_millis(10));
    }

    handle.join().unwrap();     // 等子執行緒跑完再結束（不然 main 結束會直接砍掉它）
}
```

- `thread::spawn(閉包)` 開一條新執行緒跑那個閉包，回傳一個 `JoinHandle`。
- `handle.join()` 會**阻塞**，直到那條執行緒結束。不 join 的話，main 一結束整個程式就退出，子執行緒可能還沒跑完。

### `move`：把資料交給執行緒（回扣第 05 章）

執行緒的閉包幾乎都要加 `move`：

```rust
use std::thread;

fn main() {
    let data = vec![1, 2, 3];

    let handle = thread::spawn(move || {     // move 把 data 的所有權搬進執行緒
        println!("{:?}", data);
    });
    // println!("{:?}", data);               // ❌ data 已被 move 進執行緒

    handle.join().unwrap();
}
```

**為什麼一定要 `move`？** 因為新執行緒可能活得比 `main` 的 `data` 久。如果閉包只是「借用」`data`，萬一 `main` 先結束、`data` 被 drop，執行緒就會存取到已釋放的記憶體——懸空參考。Rust 編譯器**直接不讓你這樣寫**，逼你用 `move` 把資料的所有權整個搬進去，從根本杜絕問題。這就是所有權規則在併發場景的威力。

---

## 8.4 無懼併發：編譯器幫你擋資料競爭

多執行緒最惡名昭彰的 bug 是**資料競爭**——多個執行緒同時讀寫同一份資料，結果不可預測、極難重現。第 02 章的借用規則（多讀 or 一寫，不並存）其實就是為此而生。

要在執行緒間共享可變狀態，就用第 07 章的 `Arc<Mutex<T>>`：

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for _ in 0..10 {
        let counter = Arc::clone(&counter);
        let handle = thread::spawn(move || {
            let mut num = counter.lock().unwrap();   // 上鎖才能改
            *num += 1;
        });
        handles.push(handle);
    }
    for h in handles { h.join().unwrap(); }

    println!("{}", *counter.lock().unwrap());        // 10，保證正確
}
```

**關鍵**：如果你試圖不加 `Mutex`、直接在多執行緒改一個共享變數，**Rust 會編譯錯誤**。它不像其他語言「能編譯、跑起來偶爾出錯、很難查」——Rust 在你按下編譯的當下就擋住你。這就是「無懼併發」：**只要編譯過了，就沒有資料競爭。**

### 背後的機制：`Send` 與 `Sync`

Rust 用兩個特殊 trait 標記型別的執行緒安全性：

- **`Send`**：這個型別的所有權「可以安全地搬到另一個執行緒」。
- **`Sync`**：這個型別「可以安全地被多個執行緒同時參考（`&T` 能跨執行緒）」。

大部分型別自動是 `Send + Sync`。少數不是——例如第 07 章的 `Rc<T>` 不是 `Send`（它的計數器非原子），所以你不能把 `Rc` 搬進執行緒，編譯器會擋。而 `Arc` 是 `Send + Sync`，所以可以。

> **你不用手動實作它們**，只要知道：當編譯器說某東西「cannot be sent between threads safely」，它其實是在說「這個型別不是 `Send`/`Sync`，換一個執行緒安全的（例如 `Rc` → `Arc`）」。這是 Rust 併發安全的型別層根基。

---

## 8.5 Channel：用「傳訊息」取代「共享記憶體」

除了共享 `Arc<Mutex<T>>`，另一種併發溝通方式是 **channel（通道）**——執行緒之間「傳訊息」，而不是共享同一塊記憶體。這呼應一句名言：「不要用共享記憶體來溝通，要用溝通來共享記憶體。」

```rust
use std::sync::mpsc;      // multiple producer, single consumer
use std::thread;

fn main() {
    let (tx, rx) = mpsc::channel();     // tx = 傳送端，rx = 接收端

    thread::spawn(move || {
        for i in 1..=5 {
            tx.send(i).unwrap();        // 送訊息（所有權轉移給接收端）
        }
    });

    for received in rx {                // 接收端可以像迭代器一樣收，直到 tx 關閉
        println!("收到：{received}");
    }
}
```

- `tx.send(值)`：把值送進通道（值的所有權會轉移，避免共享的問題）。
- `rx`：接收端，可以逐一 `recv()` 或直接 `for` 遍歷。
- **mpsc** = 多個生產者、單一消費者：可以 `tx.clone()` 讓多個執行緒都往同一個通道送。

> **兩種併發風格**：`Arc<Mutex<T>>` 是「共享狀態」，`channel` 是「傳訊息」。簡單的計數/共享用前者；當任務之間有「資料流動、分工」關係（例如工作佇列、生產者-消費者）時，channel 通常更清晰、更不易出錯。

---

## 8.6 從執行緒到 async：為什麼需要它

OS 執行緒很好用，但有個瓶頸：**每條執行緒都佔用不少記憶體（通常 MB 級的 stack），且切換有成本**。如果你的後端要同時處理「一萬個連線」，開一萬條執行緒會吃掉大量資源。

而後端連線大多在「等」（等 client 傳資料、等 DB 回應）。與其「每個連線一條執行緒、大部分時間在那邊卡著等」，不如「少少幾條執行緒，在等待的空檔去處理別的連線」。這就是 **async（非同步）** 要解決的：**用少量執行緒，並發處理海量的 I/O 等待任務。**

> **心智模型**：執行緒像「一個連線配一個專屬員工，員工在等回覆時就乾等著發呆」。async 像「幾個員工，誰的連線在等回覆，就先去服務另一個有事要辦的連線」——員工不發呆，資源利用率高很多。這就是為什麼高並發後端幾乎都用 async。

---

## 8.7 async/await：語法與心智模型

Rust 用 `async` 和 `.await` 兩個關鍵字支援非同步。

```rust
async fn fetch_data() -> String {         // async fn 回傳的是一個「Future」
    // 假裝這裡有網路請求
    String::from("data")
}

async fn process() {
    let data = fetch_data().await;         // .await 等它完成，期間可讓出去做別的
    println!("{data}");
}
```

兩個核心概念：

### Future：一個「還沒完成的計算」

**`async fn` 不會立刻執行**，它回傳一個 **`Future`**——代表「一個未來會產生某個值的計算，但現在還沒跑」。這跟第 05 章的迭代器「惰性」很像：**光呼叫 `async fn` 什麼都不會發生**，直到有人去「推動」它。

```rust
let future = fetch_data();     // 這行「什麼都沒做」！只是拿到一個 Future
// fetch_data 的內容還沒執行
let data = future.await;       // .await 才真正推動它執行、並等待結果
```

### `.await`：等待，但不阻塞執行緒

`.await` 的意思是「等這個 Future 完成，把值取出來」。但關鍵在於：**它不是傻等（阻塞執行緒）**，而是「如果這個 Future 還沒好（例如在等網路），就**讓出**這條執行緒，讓 runtime 去跑其他準備好的任務」。等這個 Future 好了，再回來繼續。

> **心智模型**：`.await` 是一個「禮讓點」——「我要等這件事，等的期間你（runtime）別讓執行緒閒著，去忙別的，好了再叫我」。正是這個「讓出」，讓少數執行緒能並發推進大量任務。

---

## 8.8 為什麼需要 runtime？Tokio 登場

這裡有個 Rust 跟其他語言不同的重點：**Rust 標準庫只定義了 `async`/`await` 和 `Future` 的「語法與介面」，但不內建「執行它們的引擎」。** 那個負責「調度所有 Future、決定誰該跑、處理 I/O 事件」的引擎，叫 **async runtime**，要自己選一個 crate。

最主流的是 **Tokio**。（其他還有 async-std、smol，但 Tokio 是後端生態的事實標準。）

> **對比 JS**：JavaScript 的 async 是語言內建 runtime（event loop 就在那裡）。Rust 刻意把 runtime 抽離出來當可選 crate——好處是靈活（不同場景可選不同 runtime、嵌入式甚至可不用），代價是你得自己引入一個。**寫後端就用 Tokio，別猶豫。**

加依賴：

```bash
cargo add tokio --features full
```

### 最小的 Tokio 程式

```rust
#[tokio::main]                         // 這個巨集幫你建立並啟動 Tokio runtime
async fn main() {
    println!("開始");
    let result = say_hello().await;
    println!("{result}");
}

async fn say_hello() -> String {
    String::from("hello async")
}
```

`#[tokio::main]` 這個巨集把你的 `async fn main` 包起來，背後幫你建立 runtime、把 main 這個 Future 丟進去執行。沒有它，`async fn main` 是不能直接跑的（因為沒有引擎推動）。

---

## 8.9 Tokio 實戰：並發執行多個任務

async 的真正價值在「並發」。看這個例子——同時發起多個「耗時任務」，總時間接近「最久的那個」，而不是「全部相加」：

```rust
use tokio::time::{sleep, Duration};

async fn fetch(name: &str, ms: u64) -> String {
    sleep(Duration::from_millis(ms)).await;    // 模擬 I/O 等待（非阻塞）
    format!("{name} 完成")
}

#[tokio::main]
async fn main() {
    // 循序：一個接一個，總時間 = 100 + 200 + 150 = 450ms
    let a = fetch("A", 100).await;
    let b = fetch("B", 200).await;
    let c = fetch("C", 150).await;
    println!("{a}, {b}, {c}");

    // 並發：同時進行，總時間 ≈ 最久的 200ms
    let (a, b, c) = tokio::join!(
        fetch("A", 100),
        fetch("B", 200),
        fetch("C", 150),
    );
    println!("{a}, {b}, {c}");
}
```

- **`tokio::join!`**：同時推動多個 Future，等它們**全部**完成。因為它們大多時間在「等」，可以重疊等待，總時間大幅縮短。
- 這就是後端「同時打好幾個下游服務、等它們一起回來」的典型手法（第 12 章串接外部 API 會用到）。

### `tokio::spawn`：把任務丟到背景跑

跟 `thread::spawn` 類似，但開的是「非同步任務（task）」而非 OS 執行緒。task 非常輕量，開幾萬個都沒問題：

```rust
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() {
    let mut handles = vec![];

    for i in 1..=5 {
        let handle = tokio::spawn(async move {      // 注意 async move
            sleep(Duration::from_millis(100)).await;
            println!("任務 {i} 完成");
            i * 10
        });
        handles.push(handle);
    }

    for h in handles {
        let result = h.await.unwrap();              // await task 的結果
        println!("拿到結果：{result}");
    }
}
```

- `tokio::spawn(async move { ... })`：把一個 async 區塊丟給 runtime 當背景 task 跑。
- 回傳的 handle 可以 `.await` 拿它的結果（類似 `thread` 的 `join`，但是非同步的）。

> **task vs thread**：`thread::spawn` 開的是重量級 OS 執行緒（幾千條就吃不消）；`tokio::spawn` 開的是輕量 task，runtime 用少數執行緒調度成千上萬個 task。後端處理海量連線靠的就是後者。

---

## 8.10 async 世界的一些「要注意」

async 很強，但有幾個初學常踩的點：

1. **async 會「傳染」**：一個 `async fn` 裡要 `.await` 別的 async 函式，所以呼叫鏈上常常整條都變 async。這是正常的。
2. **別在 async 裡做「阻塞」操作**：例如 `std::thread::sleep`（阻塞整條執行緒）、大量 CPU 運算、或阻塞式的檔案/DB API。這會卡住 runtime 的執行緒、拖垮並發。要用 async 版本（`tokio::time::sleep`、`tokio::fs`），CPU 重活用 `tokio::task::spawn_blocking`。
3. **共享狀態要用 Tokio 的同步工具**：跨 task 共享可變狀態，通常用 `Arc<tokio::sync::Mutex<T>>`（Tokio 版的 Mutex，鎖住時會 `.await` 讓出而非阻塞）。若只是短暫、非跨 await 的鎖，用標準 `Mutex` 也可以。
4. **選對 feature**：Tokio 功能切成很多 feature，學習時用 `features = ["full"]` 最省事；正式專案再依需要精簡。

> **給初學者的定心丸**：你現在不需要精通 async 的底層（Future 怎麼被 poll、`Pin` 是什麼）。**先掌握「`async fn` 回傳 Future、`.await` 是禮讓式等待、要有 Tokio runtime 推動、用 `join!`/`spawn` 做並發」這個心智模型就夠用**。第 11 章寫 web server 時，框架會把大部分底層藏起來，你主要就是寫 `async fn` 處理器 + `.await` 資料庫/外部 API。

---

## 8.11 綜合範例：並發抓取 + 匯總

把本章串起來——模擬「同時查詢多個資料來源，匯總結果」（第 12 章的雛形）：

```rust
use tokio::time::{sleep, Duration};

#[derive(Debug)]
struct UserInfo {
    profile: String,
    orders: u32,
    points: u32,
}

async fn get_profile(id: u64) -> String {
    sleep(Duration::from_millis(120)).await;
    format!("使用者 {id}")
}

async fn get_order_count(id: u64) -> u32 {
    sleep(Duration::from_millis(90)).await;
    42
}

async fn get_points(id: u64) -> u32 {
    sleep(Duration::from_millis(150)).await;
    1000
}

async fn aggregate(id: u64) -> UserInfo {
    // 三個查詢彼此獨立，並發進行，總時間約等於最久的 150ms（而非 360ms）
    let (profile, orders, points) = tokio::join!(
        get_profile(id),
        get_order_count(id),
        get_points(id),
    );
    UserInfo { profile, orders, points }
}

#[tokio::main]
async fn main() {
    let info = aggregate(1001).await;
    println!("{:#?}", info);
}
```

這個「並發打多個下游、`join!` 匯總」的模式，是後端 API 聚合資料的日常。你在第 11、12 章會反覆用到它。

---

## 8.12 常見錯誤

- **`async fn` 呼叫了卻不 `.await`** → 什麼都沒發生（Future 沒被推動）。編譯器通常會警告「unused Future」。
- **沒有 runtime 就想跑 async** → `async fn main` 沒加 `#[tokio::main]` 會編譯/執行錯誤。加上它。
- **在 async 裡用 `std::thread::sleep` 或做重運算** → 阻塞 runtime 執行緒，並發崩潰。用 `tokio::time::sleep` / `spawn_blocking`。
- **多執行緒用 `Rc`** → 不是 `Send`，編譯錯誤。換 `Arc`（回扣第 07 章）。
- **忘了 `join` / `.await` handle** → main 先結束，背景任務被砍掉還沒跑完。
- **循序 `.await` 明明可以並發的任務** → 白白拉長總時間。獨立任務用 `join!` 或 `spawn` 並發。
- **`thread::spawn` 閉包忘了 `move`** → 借用活不夠久的錯誤。加 `move` 把資料所有權搬進去。

---

## 8.13 本章小結

- **並行**（多核心真同時，CPU 密集）vs **並發**（交錯處理，I/O 密集）；後端多在「等」，是 async 並發的主場。
- **OS 執行緒**：`thread::spawn` + `join`；閉包幾乎都要 `move`，因為執行緒可能活得比外部變數久。
- **無懼併發**：Rust 用借用規則 + `Send`/`Sync`，在**編譯期**擋掉資料競爭；共享可變狀態用 `Arc<Mutex<T>>`。
- **channel（`mpsc`）**：用「傳訊息」取代「共享記憶體」，適合分工/生產者-消費者。
- **async/await**：`async fn` 回傳惰性的 **Future**，`.await` 是「禮讓式等待」（等的時候讓出執行緒）；用少量執行緒並發海量 I/O。
- **Tokio** 是後端事實標準的 async runtime：`#[tokio::main]` 啟動、`tokio::spawn` 開輕量 task、`tokio::join!` 並發等待。
- 注意別在 async 裡做阻塞操作，共享狀態用 Tokio 的同步原語。

---

## 8.14 動手作業

1. 用 `thread::spawn` 開 3 條執行緒各印出自己的編號，main 用 `join` 等它們全部結束。
2. 用 `Arc<Mutex<Vec<i32>>>` 讓 5 條執行緒各 push 一個數字，最後印出（長度應為 5）。
3. 用 `mpsc` channel：一條執行緒送 1~10，主執行緒接收並印出總和。
4. `cargo add tokio --features full`，寫一個 `#[tokio::main]`，用 `tokio::time::sleep` 模擬兩個耗時任務，先用循序 `.await` 再用 `tokio::join!`，比較兩者總耗時。
5. 用 `tokio::spawn` 開 10 個 task，各自 sleep 不同時間後回傳一個數字，收集所有結果加總。
6. 把 8.11 的 `aggregate` 改成「循序 await」版本，實測（或推算）總時間差異，體會並發的價值。

---

## 8.15 驗收清單

- [ ] 我分得清並行與並發，也知道後端為何偏重 async 並發。
- [ ] 我會用 `thread::spawn`/`join`，並理解 `move` 閉包的必要性。
- [ ] 我能解釋「無懼併發」：Rust 如何用借用規則 + `Send`/`Sync` 在編譯期擋資料競爭。
- [ ] 我會用 `Arc<Mutex<T>>` 與 channel 兩種併發溝通方式。
- [ ] 我理解 `async fn` 回傳 Future、`.await` 是禮讓式等待、以及為何需要 runtime。
- [ ] 我會用 Tokio 的 `#[tokio::main]`、`spawn`、`join!` 寫並發程式。

---

**進階能力篇（07~08）到此完成！** 你現在已經具備 Rust 的完整語言基礎：從語法、所有權、型別系統、錯誤處理、資料處理，到智慧指標與非同步併發。

接下來就要把這些能力用在**真實後端**上。第 09 章（架構設計）會用第 03 章的 trait、第 06 章的 workspace 把系統分層；第 10 章用 async（本章）串接資料庫；第 11、12 章用 Tokio + 框架建立與呼叫 API；第 13 章把全部縫成一個成品。你已經打好地基，接下來是蓋房子的時候了。

回到 [課程首頁](./README.md) 可複習任何章節，或繼續前往第 09 章。
