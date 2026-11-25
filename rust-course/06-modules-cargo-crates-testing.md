# 第 06 章：模組、Cargo、crate 生態與測試

> 前五章教你「寫出正確的程式」，這一章教你「把程式組織成一個真正的專案」。
> 你會學到：如何用 `mod` 把程式碼分門別類、用 `pub` 控制什麼能被外面看到、`Cargo.toml` 怎麼管依賴與 workspace、
> 以及怎麼寫測試（Rust 對測試的支援是內建的、一等公民）。這章是語言核心篇的收尾，也是第 09 章架構設計的直接前置。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 用 `mod`、`pub`、`use` 組織與存取程式碼，理解 Rust 的模組樹與可見性規則。
- 分清 package、crate、module 三個層級。
- 讀懂並編輯 `Cargo.toml`，管理依賴、feature、profile。
- 理解 binary crate 與 library crate 的差別，以及一個專案怎麼同時有兩者。
- 用 Cargo workspace 管理多個相關 crate（第 09 章架構的基礎）。
- 寫單元測試與整合測試，並用 `cargo test` 執行。

---

## 6.2 三個層級：package、crate、module

先把名詞理清楚，這是很多人混淆的地方：

| 層級 | 是什麼 | 類比 |
|------|--------|------|
| **package** | 一個 `Cargo.toml` 管理的專案，可含多個 crate | 一個 git repo / npm 專案 |
| **crate** | 編譯的最小單位，產出一個 library 或 executable | 一個「編譯目標」 |
| **module（`mod`）** | crate 內部的程式碼組織單位 | 資料夾 / 命名空間 |

再細看兩種 crate：

- **binary crate**：能編成執行檔，有 `main` 函式，進入點是 `src/main.rs`。
- **library crate**：沒有 `main`，不能單獨執行，是給別人 `use` 的函式庫，進入點是 `src/lib.rs`。

一個 package 最多一個 library crate、可以有多個 binary crate。實務上很常見的組合是「一個 lib（放核心邏輯）+ 一個 bin（薄薄的進入點呼叫 lib）」——這對測試和架構都很友善。

---

## 6.3 模組系統：`mod`、`pub`、`use`

隨著程式變大，全部塞在一個檔案會亂。`mod` 讓你把相關的東西分組。

### 在同一個檔案裡定義模組

```rust
mod restaurant {                       // 定義一個模組
    pub mod front {                    // 巢狀模組，pub 讓外面能看到
        pub fn add_to_waitlist() {     // pub 函式，外面可呼叫
            println!("加入候位");
        }
        fn seat_at_table() {}          // 沒 pub，只有模組內部能用（私有）
    }
}

fn main() {
    // 用路徑存取：模組::子模組::函式
    restaurant::front::add_to_waitlist();
}
```

**可見性核心規則**：**Rust 的東西預設是「私有的」**——只有加了 `pub` 才能被模組外面存取。這跟變數預設不可變是同一種哲學：**預設封閉、要開放才明講**。這強迫你有意識地設計「哪些是對外的 API，哪些是內部細節」。

struct 要特別注意：`pub struct` 只公開型別本身，**欄位仍然各自預設私有**，要外面能讀寫的欄位得另外加 `pub`（6.9 的 `Cart` 就刻意把欄位留成私有）。`pub enum` 則不同，變體會跟著一起公開。

### `use`：把路徑引進來，少打字

每次都寫完整路徑很煩，`use` 幫你「引入」：

```rust
// 跟上面的 mod restaurant 寫在同一個檔案
use restaurant::front::add_to_waitlist;   // 引入後直接用短名

fn main() {
    add_to_waitlist();                     // 不用寫整串路徑了
}
```

你在前面幾章看到的 `use std::collections::HashMap;`、`use rand::RngExt;` 就是這個。

### 把模組拆到不同檔案

專案大了，模組要分檔。Rust 的檔案結構對應模組樹：

```text
src/
├── main.rs           ← crate 根（binary）
├── front.rs          ← mod front 的內容
├── kitchen.rs        ← mod kitchen 的內容
└── kitchen/
    └── cooking.rs    ← mod kitchen::cooking 的內容
```

`src/main.rs` 裡宣告：

```rust
mod front;             // 告訴編譯器「去 front.rs 找 front 模組的內容」
mod kitchen;           // 去 kitchen.rs 找

fn main() {
    front::add_to_waitlist();
    kitchen::cooking::boil();
}
```

`src/front.rs`（檔案本身就是模組內容，不用再包一層 `mod front { }`）：

```rust
pub fn add_to_waitlist() {
    println!("加入候位");
}
```

`src/kitchen.rs`：子模組也要在父模組裡宣告，編譯器才會去找 `kitchen/cooking.rs`：

```rust
pub mod cooking;       // 去 kitchen/cooking.rs 找；pub 讓 main.rs 能用 kitchen::cooking
```

`src/kitchen/cooking.rs`：

```rust
pub fn boil() {
    println!("煮水");
}
```

- `mod front;`（分號結尾，沒有 `{}`）＝「這個模組的內容在另一個檔案裡」。
- 檔名 = 模組名。子模組放進跟父模組同名的資料夾，並且要在父模組檔案裡用 `mod` 宣告。**沒被任何 `mod` 宣告到的 `.rs` 檔，編譯器根本不會看。**
- 較舊的專案會把 `kitchen.rs` 的內容寫在 `kitchen/mod.rs`，效果相同。兩種擇一，同時存在會報錯「file for module `kitchen` found at both ...」。

> **心智模型**：`mod xxx;` 像是在說「這裡有一個叫 xxx 的抽屜，內容物在 xxx.rs 這個檔案」。整個 crate 就是一棵從 `main.rs`/`lib.rs` 長出來的模組樹。

### `self`、`super`、`crate`：相對與絕對路徑

```rust
mod a {
    pub fn foo() {}
    pub mod b {
        pub fn bar() {
            self::baz();         // self = 目前這個模組（b）
            super::foo();        // super = 上一層模組（a）
            crate::a::foo();     // crate = 從 crate 根開始的絕對路徑
        }
        fn baz() {}
    }
}
```

模組拆成多個檔案後，要用到「旁邊那個模組」的東西，最常見的寫法就是 `crate::` 開頭的絕對路徑，例如在 `front.rs` 裡寫 `use crate::kitchen::cooking;`。

---

## 6.4 Cargo.toml 深入

`Cargo.toml` 是專案的中樞。逐段看：

```toml
[package]
name = "myapp"
version = "0.1.0"
edition = "2024"     # cargo new 產生的預設值

[dependencies]
serde = { version = "1.0", features = ["derive"] }   # 帶 feature 的依賴
tokio = { version = "1", features = ["full"] }
anyhow = "1.0"

[dev-dependencies]
# 只在測試/範例時需要的依賴（不會進正式產物）
mockall = "0.15"

[profile.release]
opt-level = 3        # 最佳化等級
lto = true           # 連結期最佳化，產物更小更快（編譯更久）
```

重點：

- **`[dependencies]`**：正式依賴。用 `cargo add 套件名` 會自動加進來；要開 feature 就 `cargo add serde --features derive`，加 dev 依賴用 `cargo add --dev mockall`。
- **feature**：很多 crate 把功能切成可選的「feature」，你只開需要的，減少編譯量與體積。例如 `serde` 的 `derive` feature 才有 `#[derive(Serialize)]`。
- **`[dev-dependencies]`**：只在 `cargo test`、範例時用的依賴，不會被打包進正式執行檔。
- **`[profile.release]`**：控制 release 編譯的最佳化（回扣第 00 章 debug/release）。

> 如果你把這份 `Cargo.toml` 原樣貼進新專案，程式卻還沒用到這些套件，`cargo build` 會對沒用到的套件印出「warning: unused dependency」。這只是提醒，不影響編譯；真的用到之後警告就會消失。

### 版本語意（SemVer）

`"1.0"` 其實是 `"^1.0"` 的意思——「相容 1.x 的最新版，但不跳到 2.0」。Rust 生態嚴格遵循語意化版本（SemVer）：主版號變動代表破壞性改動。`Cargo.lock` 會鎖住實際解析到的版本，確保每次 build 一致（回扣第 00 章的 npm 類比）；想在允許範圍內升級，跑 `cargo update`。

兩個常讓人疑惑的地方：

- **`cargo add` 寫進去的是完整版號**，例如 `anyhow = "1.0.104"`。它一樣是 `^` 範圍，意思是「至少 1.0.104，但不到 2.0」，不是鎖死在 1.0.104。
- **0.x 版的規則比較緊**：`mockall = "0.15"` 只會升到 0.15.x，不會自動跳到 0.16。因為 0.x 階段的套件，次版號變動就可能有破壞性改動。所以舊文章寫 `0.12`、你 `cargo add` 拿到 `0.15`，兩者可能不相容。

---

## 6.5 拆成 lib + bin 的實際結構

前面說「lib 放核心邏輯、bin 當薄進入點」對測試與架構最友善。做法：在 `cargo new myapp` 建好的專案裡，自己新增 `src/lib.rs`。Cargo 看到 `src/main.rs` 與 `src/lib.rs` 同時存在，就知道這個 package 有一個 bin 和一個 lib，不用改 `Cargo.toml`。

```text
myapp/
├── Cargo.toml
└── src/
    ├── lib.rs          ← library crate 根（放核心邏輯，可被測試）
    ├── main.rs         ← binary crate 根（薄薄的進入點）
    └── calculator.rs   ← 一個模組
```

`src/lib.rs`：

```rust
pub mod calculator;                    // 公開 calculator 模組

pub fn greeting() -> String {
    String::from("hello from lib")
}
```

`src/calculator.rs`：

```rust
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

`src/main.rs`：

```rust
use myapp::calculator;                 // 用 package 名 myapp 引用自己的 lib

fn main() {
    println!("{}", myapp::greeting());
    println!("{}", calculator::add(2, 3));
}
```

兩個容易卡住的細節：

- **lib 的名字就是 `Cargo.toml` 的 package 名**。名字裡的 `-` 在程式碼裡要換成 `_`：`cargo new my-app` 建出來的專案，`main.rs` 要寫 `use my_app::...`。
- **`main.rs` 不要再寫 `mod calculator;`**。模組只在 `lib.rs` 宣告一次；如果 `main.rs` 也宣告，同一個檔案會被 bin 再編一份，變成兩個互不相干的模組。bin 要用 lib 的東西，一律透過 `myapp::...`。

**為什麼要這樣分？** 因為「整合測試」和「其他 crate」只能存取 **library crate 的公開 API**，不能直接進到 `main.rs`。把邏輯放 lib，你就能好好測試它，也能在未來被別的東西重用。這正是第 09 章架構設計的雛形。

---

## 6.6 Workspace：管理多個 crate

當專案大到要拆成多個 crate（例如 `domain`、`db`、`api` 各一個 crate），用 **Cargo workspace** 把它們組織在一起、共用同一個 `Cargo.lock` 與 `target/`。

根目錄的 `Cargo.toml`：

```toml
[workspace]
resolver = "3"
members = [
    "crates/domain",       # 核心領域邏輯
    "crates/db",           # 資料庫存取
    "crates/api",          # web api
]
```

目錄結構：

```text
myproject/
├── Cargo.toml            ← workspace 根（上面那份）
├── Cargo.lock            ← 整個 workspace 共用一份
└── crates/
    ├── domain/
    │   ├── Cargo.toml
    │   └── src/lib.rs
    ├── db/
    │   ├── Cargo.toml     ← 可依賴 domain：domain = { path = "../domain" }
    │   └── src/lib.rs
    └── api/
        ├── Cargo.toml
        └── src/main.rs
```

crate 之間用相對路徑互相依賴：

```toml
# crates/db/Cargo.toml
[dependencies]
domain = { path = "../domain" }
```

實際建立的步驟：

1. 建 `myproject/` 資料夾，手寫根目錄 `Cargo.toml`：`[workspace]`、`resolver` 照上面寫，`members` 先寫 `[]` 就好。
2. 在根目錄執行 `cargo new crates/domain --lib`、`cargo new crates/db --lib`、`cargo new crates/api`。`cargo new` 發現自己在 workspace 裡，會自動把新 crate 加進 `members`。
3. 加 crate 之間的依賴：在 `crates/db` 底下跑 `cargo add domain --path ../domain`（它會多寫一個 `version = "0.1.0"`，對本地路徑依賴沒有影響），或直接手寫上面那行。
4. 在根目錄跑 `cargo build`、`cargo test` 會處理整個 workspace；只針對某個 crate 用 `-p`，例如 `cargo run -p api`。

> **`resolver = "3"` 是什麼？** resolver 是 Cargo「解析依賴版本與 feature」的規則版本。一般 package 會依 `edition` 自動決定（edition 2024 對應 `"3"`），但像上面這種根目錄只有 `[workspace]`、沒有 `[package]` 的 workspace，**要自己寫**；漏寫的話，Cargo 會退回最舊的 `"1"` 並警告「virtual workspace defaulting to `resolver = "1"`」。成員都是 edition 2024 就寫 `"3"`；較舊的專案或文章常見 `resolver = "2"`（edition 2021 的對應值），也能正常使用。

> **這章埋的伏筆**：第 09 章的架構設計會**大量**用到 workspace——把「領域邏輯」「資料庫」「API」拆成獨立 crate，讓依賴方向清楚、各層能獨立編譯與測試。你現在先知道「workspace 就是把多個 crate 綁在一起管」即可。

> **心智模型**（給 JS/TS 背景的人）：workspace ≈ pnpm/npm workspaces（monorepo）。多個套件放一個 repo，彼此用本地路徑依賴。

---

## 6.7 測試：Rust 的一等公民

測試在 Rust 是內建的，不用額外裝框架。任何函式加 `#[test]` 就是一個測試。

### 單元測試：跟被測程式碼放一起

慣例是在同檔案底部放一個 `tests` 模組。以 6.5 的 `src/calculator.rs` 為例：

```rust
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn divide(a: f64, b: f64) -> Result<f64, String> {
    if b == 0.0 {
        Err(String::from("除以零"))
    } else {
        Ok(a / b)
    }
}

#[cfg(test)]                    // 只在測試時才編譯這個模組（正式產物不含它）
mod tests {
    use super::*;              // 引入外層模組所有東西（把 add、divide 帶進來）

    #[test]                    // 標記這是一個測試
    fn test_add() {
        assert_eq!(add(2, 3), 5);          // 相等斷言
    }

    #[test]
    fn test_divide_ok() {
        assert_eq!(divide(10.0, 2.0), Ok(5.0));
    }

    #[test]
    fn test_divide_by_zero() {
        assert!(divide(1.0, 0.0).is_err()); // 布林斷言
    }

    #[test]
    #[should_panic]            // 預期這個測試會 panic
    fn test_panics() {
        panic!("故意的");
    }
}
```

跑測試：

```bash
cargo test                  # 跑所有測試
cargo test test_add         # 只跑名字含 test_add 的
cargo test -- --no-capture  # 顯示測試中的 println! 輸出（舊寫法 --nocapture 也可以）
```

`--` 後面的參數是交給測試執行器、而不是交給 cargo 的。預設情況下，通過的測試裡 `println!` 的輸出會被吞掉，只有失敗的測試才會印出來。

常用斷言：

| 斷言 | 意思 |
|------|------|
| `assert!(條件)` | 條件為 true，否則測試失敗 |
| `assert_eq!(a, b)` | a 等於 b（失敗時印出兩者的值） |
| `assert_ne!(a, b)` | a 不等於 b |
| `#[should_panic]` | 標記「這個測試預期會 panic」 |

- **`#[cfg(test)]`**：這個屬性讓 `tests` 模組**只在測試時編譯**，正式 build 不含測試碼，不佔體積。
- 單元測試放同檔案的好處：**能測到私有函式**（因為它在同一個模組樹內）。

### 整合測試：從外部使用者的角度測

整合測試放在專案根的 `tests/` 資料夾，**只能存取 library crate 的公開 API**（模擬「別人怎麼用你的 crate」）：

```text
myapp/
├── src/
│   └── lib.rs
└── tests/
    └── integration_test.rs    ← 整合測試
```

`tests/integration_test.rs`：

```rust
use myapp::calculator;         // 像外部使用者一樣用 package 名引入

#[test]
fn add_works_from_outside() {
    assert_eq!(calculator::add(2, 2), 4);
}
```

`tests/` 底下的每個檔案都會被編成一個獨立的 crate，本來就只在 `cargo test` 時編譯，所以不用加 `#[cfg(test)]`，也不用包 `mod tests`。

| | 單元測試 | 整合測試 |
|---|---|---|
| 位置 | 被測檔案內的 `#[cfg(test)] mod tests` | 專案根的 `tests/` 資料夾 |
| 能測私有函式嗎 | ✅ 可以 | ❌ 只能測公開 API |
| 觀點 | 「內部零件對不對」 | 「使用者用起來對不對」 |

### 測試回傳 Result 的函式、以及在測試裡用 `?`

測試函式也能回傳 `Result`，方便用 `?`：

```rust
#[test]
fn parse_works() -> Result<(), std::num::ParseIntError> {
    let n: i32 = "42".parse()?;    // 失敗會讓測試失敗
    assert_eq!(n, 42);
    Ok(())
}
```

> **文件測試（doctest）加碼**：Rust 還會把「文件註解裡的程式碼範例」當測試跑！這保證你的範例永遠是能編譯、能跑的，不會過時。這是 Rust 生態文件品質高的原因之一。

`///` 開頭的是文件註解，寫在項目正上方。把 `src/calculator.rs` 的 `add` 改成這樣，`cargo test` 的輸出最後就會多一段「Doc-tests myapp」：

```rust
/// 把兩數相加。
///
/// ```
/// let r = myapp::calculator::add(2, 3);
/// assert_eq!(r, 5);
/// ```
pub fn add(a: i32, b: i32) -> i32 { a + b }
```

文件範例是站在「外部使用者」的角度寫的，所以要用完整路徑 `myapp::calculator::add`。也因此，文件測試只對 library crate 有效，寫在 `main.rs` 裡的範例不會被執行。

---

## 6.8 好用的品質工具

| 指令 | 作用 |
|------|------|
| `cargo fmt` | 依官方風格自動排版（別再為縮排吵架） |
| `cargo clippy` | 進階 lint，會建議更道地的寫法，強烈建議常跑 |
| `cargo test` | 跑所有測試（含文件測試） |
| `cargo doc --open` | 依你的文件註解產生 HTML 文件並打開 |

`rustup` 預設安裝就帶有 `rustfmt` 與 `clippy`；如果執行時說找不到，補裝一次：`rustup component add rustfmt clippy`。

> **實務習慣**：commit 前跑 `cargo fmt` + `cargo clippy` + `cargo test`。很多團隊會把這三個設進 CI，確保進主線的程式碼格式一致、沒有明顯壞味道、測試綠燈。CI 裡通常改用「只檢查、不修改」的寫法：`cargo fmt --check`（格式不對就失敗）、`cargo clippy -- -D warnings`（把警告當錯誤）。

---

## 6.9 綜合範例：一個有模組與測試的小專案

把本章串起來——一個簡單的「購物車」lib。沿用 6.5 的 `myapp` 專案即可：

`src/lib.rs`（保留原本的內容，加上這兩行）：

```rust
pub mod cart;

pub use cart::Cart;         // re-export：讓外部能用 myapp::Cart 而非 myapp::cart::Cart
```

`src/cart.rs`：

```rust
#[derive(Debug, Default)]
pub struct Cart {
    items: Vec<(String, f64)>,     // 私有欄位：外部不能直接動
}

impl Cart {
    pub fn new() -> Self {
        Cart::default()
    }

    pub fn add(&mut self, name: &str, price: f64) {
        self.items.push((name.to_string(), price));
    }

    pub fn total(&self) -> f64 {
        self.items.iter().map(|(_, price)| price).sum()   // 迭代器（第 05 章）
    }

    pub fn count(&self) -> usize {
        self.items.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_cart_total_is_zero() {
        let cart = Cart::new();
        assert_eq!(cart.total(), 0.0);
    }

    #[test]
    fn add_items_and_sum() {
        let mut cart = Cart::new();
        cart.add("apple", 30.0);
        cart.add("banana", 20.0);
        assert_eq!(cart.count(), 2);
        assert_eq!(cart.total(), 50.0);
    }
}
```

這個小專案示範了：模組拆分（`cart` 模組）、可見性（`items` 私有、方法公開）、re-export（`pub use`）、以及貼著程式碼的單元測試。這正是一個健康 Rust 專案的縮影。

---

## 6.10 常見錯誤

- **忘了加 `pub`** → 外部存取不到，報「function is private」。想被外面用就加 `pub`。
- **`mod xxx;` 但找不到對應檔案** → 報「file not found for module `xxx`」。檢查檔名/路徑是否符合模組名規則（`xxx.rs` 或 `xxx/mod.rs`）；子模組的檔案要放在父模組同名的資料夾裡。
- **新增了 `.rs` 檔卻沒寫 `mod`** → 編譯器根本不會讀那個檔案，裡面的東西也就「找不到」。在 `main.rs`/`lib.rs`（或父模組）補上 `mod xxx;`。
- **整合測試想測私有函式** → 不行。整合測試只能碰公開 API，私有邏輯用單元測試。
- **測試碼寫在正式模組沒加 `#[cfg(test)]`** → 會被編進正式產物。測試模組記得加 `#[cfg(test)]`。
- **binary-only 專案想寫整合測試卻沒 lib** → `tests/` 只能引用 library crate。把邏輯抽到 `lib.rs`。
- **feature 沒開就用該功能** → 例如用 `serde` 的 `derive` 卻沒開 `features = ["derive"]`，報找不到巨集。

---

## 6.11 本章小結

- 三層級：**package**（一個 Cargo.toml）＞ **crate**（編譯單位，lib 或 bin）＞ **module**（`mod`，程式碼組織）。
- 模組系統：`mod` 定義/宣告模組、`pub` 開放可見性（**預設私有**）、`use` 引入路徑；檔案結構對應模組樹。
- `Cargo.toml` 管依賴、feature、dev-dependencies、profile；遵循 SemVer，`Cargo.lock` 鎖版本。
- 實務常用「lib（核心邏輯）+ bin（薄進入點）」結構，利於測試與重用。
- **Workspace** 把多個 crate 綁一起管，是第 09 章架構的基礎。
- 測試是一等公民：`#[test]` + `assert_eq!`；單元測試（同檔、可測私有）、整合測試（`tests/`、測公開 API）、文件測試（文件範例當測試跑）。
- 品質工具：`cargo fmt` / `clippy` / `test` / `doc`。

---

## 6.12 動手作業

1. 建一個 lib 專案，做一個 `mod math` 含 `add`、`sub`、`mul`，每個都加單元測試，`cargo test` 全綠。
2. 把 `math` 模組從 `lib.rs` 內嵌改成拆到獨立的 `math.rs` 檔案，確認仍能編譯與測試。
3. 為第 1 題加一個 `tests/` 整合測試，從外部呼叫你的公開函式。
4. 故意把某個函式的 `pub` 拿掉，觀察整合測試報什麼錯，再加回去。
5. 用 6.9 的 `Cart` 為基礎，新增 `remove` 或 `clear` 方法並補上對應測試。
6. （挑戰）建一個含兩個 crate 的最小 workspace：`calc`（lib，放一個函式）與 `app`（bin，依賴 calc 並呼叫它）。（crate 別取名 `core`、`std`，會跟標準函式庫撞名。）

---

## 6.13 驗收清單

- [ ] 我分得清 package / crate / module，也知道 lib 與 bin crate 的差別。
- [ ] 我會用 `mod`/`pub`/`use` 組織程式碼，理解「預設私有」。
- [ ] 我會把模組拆到不同檔案，並知道檔名與模組名的對應。
- [ ] 我看得懂 `Cargo.toml` 的依賴、feature、dev-dependencies、profile。
- [ ] 我知道 workspace 是拿來管多個 crate 的，也知道它是第 09 章的基礎。
- [ ] 我會寫單元測試與整合測試，並用 `cargo test` 執行。

---

語言核心篇（01~06）到此結束——你已經能寫出正確、且組織良好的 Rust 程式了。接下來進入**進階能力篇**。下一章 [07-smart-pointers-interior-mutability.md](./07-smart-pointers-interior-mutability.md) 講智慧指標（`Box`/`Rc`/`Arc`）與內部可變性（`RefCell`/`Mutex`）——當所有權的「單一擁有者」規則不夠用時，這些工具讓你在「共享」與「可變」之間找到安全的出路，也是理解第 08 章併發的關鍵。
