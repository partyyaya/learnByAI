# 第 04 章：錯誤處理 —— Result、Option、`?` 與 thiserror / anyhow

> Rust 的「可靠」名聲，一半來自第 02 章的記憶體安全，另一半就來自這章的錯誤處理。
> Rust 沒有 try/catch 例外機制——它把「可能失敗」直接編進**回傳型別**（`Result<T, E>`），逼你正視每一個可能出錯的地方。
> 這聽起來很囉嗦，但有了 `?` 運算子和 `thiserror`/`anyhow`，實際寫起來非常順，而且你的程式會「誠實」——看簽章就知道它會不會失敗。這是寫後端服務每天都要用的核心技能。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 分辨「可恢復錯誤」（`Result`）與「不可恢復錯誤」（`panic!`），知道各用在哪。
- 熟練使用 `Result<T, E>`，並用 `match` 或便捷方法處理。
- 用 `?` 運算子把「一連串可能失敗的操作」寫得乾淨俐落。
- 理解為什麼要少用 `unwrap()`，以及它適合出現在哪。
- 用 `thiserror` 定義自訂錯誤型別（函式庫做法）。
- 用 `anyhow` 在應用層快速處理各種錯誤（應用程式做法）。

---

## 4.2 Rust 的兩類錯誤

Rust 把錯誤分成兩種，處理方式完全不同：

| 類型 | 用什麼 | 意思 | 例子 |
|------|--------|------|------|
| **可恢復（recoverable）** | `Result<T, E>` | 「這可能失敗，但失敗了我可以處理」 | 檔案找不到、網路逾時、輸入格式錯 |
| **不可恢復（unrecoverable）** | `panic!` | 「這是 bug 或不該發生的狀態，直接中止」 | 陣列越界、除以零、程式邏輯錯誤 |

**核心哲學**：Rust **沒有例外（exceptions）**。其他語言用 `throw`/`try`/`catch`，問題是「哪個函式會丟例外」不寫在簽章裡，你常常漏接。Rust 反過來——**會失敗的函式，回傳型別就是 `Result`**，你不處理就編譯不過（至少會警告）。錯誤變成型別系統的一部分。

### panic！：直接中止

```rust
fn main() {
    panic!("出大事了");            // 主動 panic
    // 或間接觸發：
    let v = vec![1, 2, 3];
    v[99];                         // 越界，panic
}
```

panic 會印出錯誤訊息與呼叫堆疊，然後中止程式。**它適合「不該發生、發生就代表有 bug」的情況**，不該拿來當一般錯誤流程。

---

## 4.3 Result<T, E>：可恢復錯誤的主角

`Result` 跟第 03 章的 `Option` 是兄弟，也是標準庫的 enum：

```rust
enum Result<T, E> {      // 標準庫定義，你不用自己寫
    Ok(T),               // 成功，帶成功的值 T
    Err(E),              // 失敗，帶錯誤資訊 E
}
```

看一個會回傳 `Result` 的函式——把字串轉成數字：

```rust
fn main() {
    let input = "42";
    let parsed: Result<i32, _> = input.parse();   // parse 回傳 Result

    match parsed {
        Ok(num) => println!("成功：{num}"),
        Err(e) => println!("失敗：{e}"),
    }
}
```

`parse()` 可能成功（`Ok(42)`）也可能失敗（`Err(...)`，例如輸入是 `"abc"`）。你**被迫**用 `match`（或後面的便捷方法）把兩種情況都處理掉。

### 對照 Option

- `Option<T>`：回答「有沒有值」（`Some` / `None`）——沒值時**不需要理由**。
- `Result<T, E>`：回答「成功還是失敗」（`Ok` / `Err`）——失敗時**帶著錯誤原因 `E`**。

> **選用準則**：如果「沒值」是正常且不需解釋的（找不到、還沒設定），用 `Option`；如果「失敗」需要說明原因（哪裡出錯、為什麼），用 `Result`。

---

## 4.4 處理 Result 的便捷方法

每次都寫 `match` 很累。標準庫提供一堆方法，先認得最常用的：

```rust
let ok: Result<i32, String> = Ok(5);
let err: Result<i32, String> = Err(String::from("boom"));

// unwrap：成功取值，失敗就 panic（危險，慎用）
println!("{}", ok.unwrap());              // 5
// err.unwrap();                          // panic！

// expect：跟 unwrap 一樣，但可帶自訂 panic 訊息
println!("{}", ok.expect("應該要有值"));   // 5

// unwrap_or：失敗時給預設值
println!("{}", err.unwrap_or(0));         // 0

// unwrap_or_else：失敗時用閉包算預設值（第 05 章講閉包）
println!("{}", err.clone().unwrap_or_else(|_| -1));  // -1

// is_ok / is_err：只想知道成功與否
println!("{}", ok.is_ok());               // true

// map：成功時轉換值，失敗原樣傳遞
let doubled = ok.map(|n| n * 2);          // Ok(10)
```

### 關於 `unwrap()` 的實話

`unwrap()` / `expect()` 會在失敗時 **panic**。它們很方便，但等於「賭這裡不會失敗，賭錯就當掉」。

**什麼時候可以用？**

- 寫「範例、原型、測試」時，快速驗證邏輯。
- 你**邏輯上能確定**這裡絕不會失敗（例如你剛剛才 push 進 vector，馬上取一定有）。
- `expect` 比 `unwrap` 好，因為 panic 訊息能寫清楚「為什麼你認為這不該失敗」。

**什麼時候別用？**

- 正式的後端服務、函式庫、任何要穩定運行的程式——一個 `unwrap` 在錯誤輸入下就能讓整個服務當掉。改用 `?` 把錯誤往上傳（下一節）。

> **給你的準則**：寫產品程式碼時，看到自己打 `unwrap()`，停一下問「這真的不可能失敗嗎？」。多數時候答案是「會失敗」，那就用 `?`。

---

## 4.5 `?` 運算子：錯誤處理的神器

實務中最常見的需求是：**「這一步如果失敗，就直接把錯誤往上丟給呼叫我的人，不然就繼續。」** 手寫 `match` 會變成一層層巢狀，很醜：

```rust
use std::fs::File;
use std::io::{self, Read};

// 沒有 ? 的寫法：又臭又長
fn read_username_verbose() -> Result<String, io::Error> {
    let file_result = File::open("username.txt");
    let mut file = match file_result {
        Ok(f) => f,
        Err(e) => return Err(e),        // 失敗就提早回傳錯誤
    };
    let mut username = String::new();
    match file.read_to_string(&mut username) {
        Ok(_) => Ok(username),
        Err(e) => Err(e),
    }
}
```

用 `?` 運算子，同樣的邏輯變成：

```rust
fn read_username() -> Result<String, io::Error> {
    let mut file = File::open("username.txt")?;      // 失敗就自動 return Err
    let mut username = String::new();
    file.read_to_string(&mut username)?;             // 同上
    Ok(username)
}
```

**`?` 的行為**：放在一個回傳 `Result` 的運算式後面——

- 如果是 `Ok(值)`：把「值」取出來，程式繼續往下。
- 如果是 `Err(錯誤)`：**立刻從當前函式 return `Err(錯誤)`**。

一個小小的 `?`，取代了整段 `match ... return Err`。這就是為什麼 Rust 的錯誤處理「看起來嚴格，寫起來卻很順」。

> **心智模型**：`?` 是「順著走，出事就往上報」。你把一串可能失敗的操作用 `?` 串起來，就像描述「快樂路徑」；任何一步出錯，`?` 自動幫你把錯誤丟回給呼叫者，不用你手動接。

### `?` 的兩個前提

1. **所在函式的回傳型別必須是 `Result`（或 `Option`，或實作了 `Try` 的型別）。** 你不能在回傳 `()` 的函式裡用 `?`。
2. **`?` 前面那個值的錯誤型別，要能轉換成函式回傳的錯誤型別。** 標準庫的錯誤大多能自動轉；跨不同錯誤型別時，`thiserror`/`anyhow`（後面）會幫你搞定。

### `main` 也能回傳 Result

```rust
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {    // main 回傳 Result，就能在裡面用 ?
    let username = read_username()?;
    println!("{username}");
    Ok(())
}
```

`Box<dyn Error>` 先照抄，意思是「任何一種錯誤都能裝」（第 07 章會講 `Box`、`dyn`）。這是「應用程式進入點」很常見的寫法。

---

## 4.6 自訂錯誤型別

小程式可以直接用標準庫的錯誤，但真實專案通常要**自己定義錯誤型別**，把「你的領域裡會發生哪些錯」講清楚。最基本的做法是用 enum（回扣第 03 章）：

```rust
#[derive(Debug)]
enum OrderError {
    NotFound(u64),           // 找不到訂單，帶訂單 id
    AlreadyPaid,             // 已付款
    InsufficientStock { need: u32, have: u32 },  // 庫存不足
}

fn pay_order(id: u64) -> Result<(), OrderError> {
    if id == 0 {
        return Err(OrderError::NotFound(id));
    }
    // ...
    Ok(())
}
```

這樣呼叫端可以 `match` 你的錯誤，針對不同錯誤做不同處理。但手寫這種錯誤型別，如果要讓它「能印成人看得懂的訊息」「能跟其他錯誤型別互轉」，要寫不少樣板程式碼。這就是下一節兩個 crate 登場的原因。

---

## 4.7 thiserror：優雅定義「函式庫」的錯誤

`thiserror` 幫你用少少的標註，生成完整的錯誤型別（實作 `Display`、`Error`、自動轉換等）。

先加依賴：

```bash
cargo add thiserror
```

```rust
use thiserror::Error;

#[derive(Error, Debug)]
enum OrderError {
    #[error("找不到訂單 {0}")]                    // {0} 對應變體的第 0 個欄位
    NotFound(u64),

    #[error("訂單已付款，不能重複付款")]
    AlreadyPaid,

    #[error("庫存不足：需要 {need}，只有 {have}")]  // 用欄位名對應
    InsufficientStock { need: u32, have: u32 },

    #[error("資料庫錯誤")]
    Database(#[from] std::io::Error),             // #[from] 自動從 io::Error 轉過來
}
```

`thiserror` 幫你做了什麼：

- **`#[error("...")]`**：自動實作 `Display`，讓錯誤能印成你寫的那句人話。
- **`#[derive(Error)]`**：實作標準的 `std::error::Error` trait，讓它能融入整個錯誤生態。
- **`#[from]`**：自動生成「從 `io::Error` 轉成 `OrderError::Database`」的轉換。有了它，`?` 就能自動把 `io::Error` 轉成你的 `OrderError`——跨型別的錯誤傳遞變得無痛。

> **用途定位**：`thiserror` 適合**函式庫（library）**或「你想讓呼叫端能精確分辨錯誤種類」的場景。因為它保留了「具體是哪一種錯誤」的型別資訊，呼叫端可以 `match` 處理。

---

## 4.8 anyhow：應用層快速處理「任何」錯誤

寫**應用程式（binary）**時，你常常不在乎「精確是哪種錯誤型別」，只想要「出錯就帶著清楚的上下文往上報，最後印出來或記 log」。這時 `anyhow` 更省事。

```bash
cargo add anyhow
```

```rust
use anyhow::{Context, Result};      // 注意：anyhow 有自己的 Result 別名

fn load_config() -> Result<String> {                  // Result<String> = Result<String, anyhow::Error>
    let content = std::fs::read_to_string("config.toml")
        .context("讀取 config.toml 失敗")?;            // context 加上下文說明
    Ok(content)
}

fn main() -> Result<()> {
    let config = load_config()?;
    println!("{config}");
    Ok(())
}
```

`anyhow` 的特點：

- **`anyhow::Error` 能裝下「任何」實作了 `Error` 的錯誤**——你不用定義自己的 enum，各種來源的錯誤都能用同一個 `?` 往上丟。
- **`.context("...")`**：在錯誤上疊加「發生時的上下文」，最後印出來會像一串「因為 A，因為 B，因為 C」，超好追問題。
- 回傳 `anyhow::Result<T>` 讓你在應用層寫得飛快。

### thiserror vs anyhow：怎麼選

| | `thiserror` | `anyhow` |
|---|---|---|
| 定位 | 定義**具體**錯誤型別 | 裝**任何**錯誤 |
| 適合 | 函式庫、需要讓呼叫端 `match` 分辨錯誤 | 應用程式、只要往上報 + 記 log |
| 呼叫端能否分辨錯誤種類 | 可以（保留型別） | 通常不行（型別被抹平） |
| 心智 | 「我要精確描述每種錯誤」 | 「我只想順利把錯誤帶著上下文丟出去」 |

> **實務常見組合**：一個專案裡，**底層的函式庫/模組用 `thiserror` 定義精確錯誤**，**最上層的應用進入點用 `anyhow` 統一接收**。兩者搭配，各取所長。這也是後面第 09~13 章成品專案的做法。

---

## 4.9 綜合範例：一連串可能失敗的操作

把本章串起來——一個「讀檔 → 解析數字 → 計算」的流程，任何一步失敗都優雅往上報：

```rust
use anyhow::{Context, Result};

fn sum_numbers_in_file(path: &str) -> Result<i32> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("讀取檔案失敗：{path}"))?;   // 讀檔可能失敗

    let mut total = 0;
    for (i, line) in content.lines().enumerate() {
        let n: i32 = line.trim().parse()
            .with_context(|| format!("第 {} 行不是有效數字：'{}'", i + 1, line))?;  // 解析可能失敗
        total += n;
    }
    Ok(total)
}

fn main() -> Result<()> {
    match sum_numbers_in_file("numbers.txt") {
        Ok(total) => println!("總和：{total}"),
        Err(e) => {
            // {:#} 會把 anyhow 疊加的上下文鏈一併印出
            eprintln!("發生錯誤：{e:#}");
        }
    }
    Ok(())
}
```

觀察：三個可能失敗的點（讀檔、解析、以及整體流程）都用 `?` 串起來，主邏輯讀起來像「快樂路徑」，錯誤處理不打斷閱讀，卻一個都沒漏。

---

## 4.10 常見錯誤

- **到處 `unwrap()`** → 產品程式碼在錯誤輸入下就 panic 當掉。改用 `?` 傳遞。
- **在回傳 `()` 的函式裡用 `?`** → 編譯錯誤。把回傳型別改成 `Result<..., ...>`。
- **錯誤型別不匹配、`?` 轉換失敗** → 用 `thiserror` 的 `#[from]` 或改用 `anyhow`。
- **函式庫直接用 `anyhow`** → 呼叫端無法分辨錯誤種類。函式庫建議用 `thiserror` 保留型別。
- **用 panic 當一般錯誤流程** → panic 是給「不該發生的 bug」，一般可預期的失敗用 `Result`。
- **忽略 `Result`**（沒處理回傳的 Result）→ 編譯器會警告 `unused Result`，別忽視它。

---

## 4.11 本章小結

- Rust 沒有例外，改用型別表達錯誤：**`Result<T, E>`**（可恢復）與 **`panic!`**（不可恢復 bug）。
- `Result` 用 `match` 或便捷方法（`unwrap_or`、`map`、`is_ok`…）處理；**產品程式碼少用 `unwrap`/`expect`**。
- **`?` 運算子**是核心神器：成功取值、失敗自動往上 return Err，讓錯誤處理寫起來很順。用 `?` 的函式回傳型別要是 `Result`。
- 自訂錯誤可用 enum；實務用 **`thiserror`** 優雅定義「具體」錯誤（函式庫），用 **`anyhow`** 快速裝「任何」錯誤 + 加上下文（應用程式）。
- 常見組合：底層 `thiserror` + 頂層 `anyhow`。

---

## 4.12 動手作業

1. 寫函式 `fn divide(a: f64, b: f64) -> Result<f64, String>`：`b == 0` 回傳 `Err`，否則 `Ok(a/b)`。在 `main` 用 `match` 處理。
2. 把上題的呼叫改用 `?`（記得把 `main` 或中介函式的回傳型別改成 `Result`）。
3. 用 `thiserror` 定義一個 `enum ParseError`，至少兩個變體（如 `Empty`、`Invalid(String)`），並實作一個回傳它的解析函式。
4. `cargo add anyhow`，寫一個「讀取一個檔案並回傳它的行數」的函式，用 `.context()` 加上錯誤上下文，故意讓檔案不存在，觀察印出的錯誤訊息。
5. 把第 4 題的檔案讀取，改成「讀多個檔案、任何一個失敗就整體回傳錯誤」，體會 `?` 串接的順暢。

---

## 4.13 驗收清單

- [ ] 我分得清可恢復錯誤（`Result`）與不可恢復錯誤（`panic!`）。
- [ ] 我會用 `match` 和便捷方法處理 `Result`，也知道何時（不）該用 `unwrap`。
- [ ] 我能解釋 `?` 運算子做了什麼，並用它串接多個可能失敗的操作。
- [ ] 我會用 `thiserror` 定義具體錯誤型別，並理解 `#[from]` 的作用。
- [ ] 我會用 `anyhow` 在應用層快速處理錯誤並加上下文。
- [ ] 我能說出 `thiserror` 與 `anyhow` 的定位差異與常見搭配。

---

下一章 [05-collections-iterators-closures.md](./05-collections-iterators-closures.md) 進入日常最常用的資料處理工具：`Vec`、`HashMap` 等集合，以及 Rust 招牌的**迭代器（iterator）**與**閉包（closure）**。你會看到怎麼用 `.iter().map().filter().collect()` 這種鏈式寫法，優雅又零成本地處理資料。
