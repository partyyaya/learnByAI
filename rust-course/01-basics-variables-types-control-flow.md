# 第 01 章：基礎語法 —— 變數、型別、控制流與函式

> 這一章把 Rust 的「日常語法」講清楚：怎麼宣告變數、有哪些型別、怎麼寫條件與迴圈、怎麼定義函式。
> 就算你會其他語言，也別跳過——Rust 有幾個「跟你直覺不一樣」的設計（預設不可變、`if` 是運算式、shadowing、整數溢位），
> 這些點如果不先弄懂，後面會一直卡。這章也刻意為第 02 章的所有權鋪路，讀的時候留意「值是怎麼被搬動的」。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 用 `let` / `let mut` 宣告變數，並解釋「預設不可變」的意義。
- 說明 shadowing（遮蔽）跟 `mut` 的差別。
- 認得 Rust 的基本型別（整數、浮點、布林、字元、tuple、array）。
- 理解「`if`、`match`、區塊都是運算式（expression）」這個核心觀念。
- 寫出 `loop` / `while` / `for` 迴圈，並用 `match` 做模式比對。
- 定義函式、傳參數、回傳值，並理解「最後一行不加分號＝回傳值」。

---

## 1.2 變數：預設不可變

先看一段會**編譯失敗**的程式：

```rust
fn main() {
    let x = 5;
    x = 6;          // ❌ 編譯錯誤：cannot assign twice to immutable variable `x`
    println!("{x}");
}
```

在 Rust，`let x = 5;` 宣告的變數**預設不可變（immutable）**。要讓它可以改，得加 `mut`：

```rust
fn main() {
    let mut x = 5;   // mut = mutable，可變
    x = 6;           // ✅ 現在可以了
    println!("{x}"); // 6
}
```

**為什麼要預設不可變？** 這是 Rust 刻意的取捨：

- 你讀程式時，看到 `let x`（沒 `mut`），就能確定「這個值之後不會被偷改」，推理更容易。
- 編譯器也能據此做更多最佳化。
- 這是後面**併發安全**的基礎——不可變的資料可以安全地被多執行緒同時讀。

> **心智模型**：其他語言是「預設可改，要防改才特別標記（如 `const` / `final`）」；Rust 反過來，「預設不可改，要改才特別標記（`mut`）」。這個反轉會讓你在寫的時候多想一下「這個變數真的需要變嗎」，通常答案是不需要。

### 常數 `const`

```rust
const MAX_POINTS: u32 = 100_000;   // 數字裡的底線只是給人看的分隔，不影響值
```

`const` 跟 `let`（不可變）的差別：`const` 必須**標註型別**、必須是**編譯期就能算出的常數**、可以放在任何作用域（包含全域），而且慣例用**全大寫**命名。

---

## 1.3 Shadowing（遮蔽）：跟 mut 完全不同

Rust 允許你用同一個名字**重新宣告**變數，這叫 shadowing：

```rust
fn main() {
    let x = 5;
    let x = x + 1;        // 這是「新的」x，遮蔽掉舊的，值是 6
    let x = x * 2;        // 又一個新的 x，值是 12
    println!("{x}");      // 12
}
```

注意每次都用 `let`。這跟 `mut` 有本質差別：

| | `mut`（可變） | shadowing（遮蔽） |
|---|---|---|
| 是不是同一個變數 | 是同一個，改它的值 | 是**全新的變數**，只是名字一樣 |
| 能不能換型別 | ❌ 不能，型別固定 | ✅ 可以，新變數可以是不同型別 |
| 寫法 | `let mut x`，之後 `x = ...` | 每次都 `let x = ...` |

shadowing 最實用的地方是「轉型別但想沿用名字」：

```rust
let spaces = "   ";              // 字串型別
let spaces = spaces.len();       // 數字型別（3）—— 用 shadowing 換了型別

// 如果用 mut 就會失敗：
// let mut spaces = "   ";
// spaces = spaces.len();        // ❌ 型別從 &str 變 usize，mut 不允許換型別
```

> **白話**：`mut` 是「同一個盒子，換裡面的東西（但東西的種類要一樣）」；shadowing 是「拿一個新盒子，剛好貼一樣的標籤」。

---

## 1.4 基本型別（Scalar Types）

Rust 是**靜態強型別**：每個值都有明確型別，編譯期就定好。多數時候編譯器能**自動推斷**，但有時需要你標註。

### 整數

| 長度 | 有號（可負） | 無號（只正） |
|------|------------|------------|
| 8-bit | `i8` | `u8` |
| 16-bit | `i16` | `u16` |
| 32-bit | `i32` | `u32` |
| 64-bit | `i64` | `u64` |
| 128-bit | `i128` | `u128` |
| 依平台 | `isize` | `usize` |

- **預設**：不特別標註時，整數是 `i32`。
- `usize` / `isize`：大小跟你的機器位元數一致（64 位元機器就是 64-bit）。**陣列索引、集合長度都是 `usize`**，這點以後常遇到。
- 命名裡的字母：`i` = integer（有號），`u` = unsigned（無號）。

```rust
let a: i32 = -100;
let b: u8 = 255;          // u8 範圍是 0~255
let big: u64 = 10_000_000_000;
```

> **整數溢位的陷阱**：`u8` 最大是 255，如果你在 debug 模式做 `255 + 1`，程式會**panic（當掉）**；但在 release 模式，它會「繞回」變成 0（wrapping）。這是 Rust 的取捨——debug 幫你抓 bug，release 求效能。要明確處理溢位時，用 `wrapping_add`、`checked_add`、`saturating_add` 這些方法，別依賴預設行為。

### 浮點數

```rust
let x = 2.0;        // 預設 f64（雙精度）
let y: f32 = 3.0;   // 單精度
```

### 布林與字元

```rust
let t = true;
let f: bool = false;

let c = 'z';                    // char 用單引號
let heart = '❤';                // Rust 的 char 是 4 bytes，能存任何 Unicode 字元（含中文、emoji）
```

> **注意**：`'z'`（單引號）是**字元 `char`**，`"z"`（雙引號）是**字串 `&str`**，兩者是不同型別。這跟 Python 不同（Python 沒有 char）。

---

## 1.5 複合型別：Tuple 與 Array

### Tuple（元組）：把不同型別綁在一起

```rust
let person: (i32, f64, char) = (25, 175.5, 'M');

let (age, height, gender) = person;   // 解構（destructuring）
println!("{age} {height} {gender}");

let age2 = person.0;                  // 也可以用 .索引 取（從 0 開始）
```

- tuple 長度固定，每個位置型別可以不同。
- 常用來「讓函式回傳多個值」。

### Array（陣列）：同型別、固定長度

```rust
let arr = [1, 2, 3, 4, 5];            // 型別是 [i32; 5]
let zeros = [0; 3];                   // [0, 0, 0]，簡寫「3 個 0」
println!("{}", arr[0]);               // 取索引

let len = arr.len();                  // 5
```

**關鍵**：Rust 的 array **長度固定、編譯期就決定**，而且它存在堆疊（stack）上。如果你要「可變長度、能增刪」的清單，用的是 `Vec<T>`（第 05 章的重點），不是 array。

> **越界會怎樣？** `arr[10]` 這種越界存取，Rust 會在執行期 **panic**，而不是像 C 那樣讀到隨機記憶體。這就是「記憶體安全」的具體展現之一——它寧可讓程式當掉，也不讓你讀到不該讀的地方。

---

## 1.6 最重要的觀念：Rust 是「運算式導向」語言

這一節請特別專心，因為它跟很多語言不一樣，卻是 Rust 程式碼「長那樣」的關鍵原因。

**陳述句（statement）vs 運算式（expression）：**

- **陳述句**：做一件事，**不回傳值**。例如 `let x = 5;`。
- **運算式**：**會算出一個值**。例如 `5 + 3`、函式呼叫、`if`、`match`、甚至一個 `{}` 區塊。

在 Rust，**幾乎所有東西都是運算式，會產生值**。最直接的體現：

### `if` 是運算式，可以直接當值用

```rust
let condition = true;
let number = if condition { 5 } else { 6 };   // if 算出一個值，指派給 number
println!("{number}");                          // 5
```

在 Java/JS 你得寫三元運算子 `condition ? 5 : 6`，或先宣告變數再在 if 裡賦值。Rust 不需要——`if/else` 本身就會算出值。

> **注意**：`if` 和 `else` 兩個分支算出的**型別必須一樣**。`if condition { 5 } else { "six" }` 會編譯失敗，因為一邊是數字、一邊是字串。

### 區塊 `{}` 也是運算式

一個大括號區塊會算出「它最後一個運算式」的值——**前提是最後那行不加分號**：

```rust
let y = {
    let x = 3;
    x + 1        // ← 注意：沒有分號！這一行的值就是整個區塊的值
};
println!("{y}"); // 4
```

**這裡藏著 Rust 最常見的初學陷阱**：加不加分號意義完全不同。

- `x + 1`（無分號）→ 這是運算式，區塊回傳 `4`。
- `x + 1;`（有分號）→ 加了分號變成陳述句，區塊回傳 `()`（叫 unit，等於「空/沒有值」）。

這個規則直接影響函式怎麼回傳值，下一節就會用到。

---

## 1.7 函式

```rust
fn main() {
    let sum = add(3, 5);
    println!("{sum}");        // 8
    greet("Rust");
}

fn add(a: i32, b: i32) -> i32 {   // 參數要標型別；-> i32 是回傳型別
    a + b                          // 沒有分號 → 這就是回傳值
}

fn greet(name: &str) {             // 沒寫 -> 表示回傳 ()，即「沒有回傳值」
    println!("Hello, {name}!");
}
```

重點：

- **參數一定要標型別**（Rust 不會推斷函式參數型別）。
- 回傳型別寫在 `->` 後面；沒寫就是回傳 `()`（無回傳值）。
- **函式最後一行不加分號＝回傳值**（呼應 1.6）。這是道地 Rust 寫法。

### `return` 也可以用（提早回傳）

```rust
fn abs(x: i32) -> i32 {
    if x < 0 {
        return -x;        // 提早回傳用 return，這裡就得加分號結束陳述句
    }
    x                     // 正常結尾用「無分號運算式」回傳
}
```

> **道地寫法**：只有「需要提早跳出」時才用 `return`；正常的最後結果，用「無分號的運算式」回傳。剛學可能不習慣，寫多了會覺得很順。

---

## 1.8 控制流：迴圈

Rust 有三種迴圈：`loop`、`while`、`for`。

### `loop`：無限迴圈，且能「回傳值」

```rust
let mut counter = 0;
let result = loop {
    counter += 1;
    if counter == 10 {
        break counter * 2;   // break 可以帶一個值出來！loop 就算出這個值
    }
};
println!("{result}");        // 20
```

`loop` 配上 `break 值`，可以讓整個迴圈變成一個「會算出值的運算式」——這是其他語言少見的設計，適合「重試直到成功」的場景。

### `while`：條件迴圈

```rust
let mut n = 3;
while n > 0 {
    println!("{n}!");
    n -= 1;
}
println!("起飛！");
```

### `for`：遍歷（最常用、最安全）

```rust
let arr = [10, 20, 30, 40, 50];

for element in arr {
    println!("值：{element}");
}

// 配合範圍 range
for i in 1..=5 {          // 1,2,3,4,5（..= 含結尾）
    println!("{i}");
}

for i in (1..=3).rev() {  // 倒過來：3,2,1
    println!("{i}");
}
```

> **為什麼推薦 `for`？** 用索引手動遍歷（`while i < arr.len()`）容易寫錯邊界、越界 panic。`for ... in` 讓編譯器幫你顧好邊界，既安全又好讀。這是 Rust（也是多數現代語言）的道地做法。

---

## 1.9 控制流：`match` 模式比對

`match` 是 Rust 最強大的控制流工具，可以想成「超進化版 switch」。

```rust
let number = 3;

match number {
    1 => println!("一"),
    2 => println!("二"),
    3 => println!("三"),
    4 | 5 => println!("四或五"),      // | 表示「或」
    6..=10 => println!("六到十"),      // 範圍比對
    _ => println!("其他"),             // _ 是「其餘全部」，類似 default
}
```

`match` 有兩個關鍵特性，讓它比 `switch` 強太多：

**1. 必須「窮盡」所有可能（exhaustive）**

編譯器會強制你處理**所有情況**。如果你漏掉某個可能，會編譯失敗。這逼你不會忘記處理邊界（例如處理 enum 時漏掉某個變體）。不想一一列，就用 `_` 收尾。

**2. `match` 也是運算式，會回傳值**

```rust
let level = 3;
let text = match level {
    1 => "初級",
    2 => "中級",
    3 => "高級",
    _ => "未知",
};
println!("{text}");     // 高級
```

> **心智模型**：把 `match` 當成「值的路由器」——輸入一個值，依它長什麼樣分流到不同分支，並且每個分支都算出一個結果。它在第 03 章（enum）、第 04 章（Result/Option 錯誤處理）會是主角，這裡先熟悉它的形狀。

### `if let`：只在乎一種情況時的簡寫

當你只關心一種比對結果、其他都不管時，`match` 顯得囉嗦，可用 `if let`：

```rust
let some_value = Some(3);   // Option 型別，第 04 章詳講

// 用 match 要寫兩個分支：
match some_value {
    Some(x) => println!("有值：{x}"),
    None => {}                          // 什麼都不做，卻被迫要寫
}

// 用 if let 更簡潔：
if let Some(x) = some_value {
    println!("有值：{x}");
}
```

---

## 1.10 一段綜合範例：猜數字（精簡版）

把本章語法串起來（部分語法第 04、05 章會再深入，先感受形狀）：

```rust
use rand::Rng;
use std::io;

fn main() {
    let secret = rand::thread_rng().gen_range(1..=100);
    println!("猜一個 1~100 的數字：");

    loop {
        let mut guess = String::new();               // 可變的空字串，用來接輸入
        io::stdin()
            .read_line(&mut guess)                    // 讀一行到 guess（&mut 第 02 章講）
            .expect("讀取失敗");

        // 把字串轉成數字；解析失敗就重來（match 分流成功/失敗）
        let guess: u32 = match guess.trim().parse() {
            Ok(num) => num,
            Err(_) => {
                println!("請輸入數字");
                continue;                             // 跳回迴圈開頭
            }
        };

        // 比大小：cmp 回傳 Ordering，用 match 分三種情況
        use std::cmp::Ordering;
        match guess.cmp(&secret) {
            Ordering::Less => println!("太小了"),
            Ordering::Greater => println!("太大了"),
            Ordering::Equal => {
                println!("猜中了！");
                break;
            }
        }
    }
}
```

你現在不用完全懂每一行（`String`、`&mut`、`match Ok/Err` 之後都會細講），重點是感受：**變數、迴圈、`match`、運算式回傳** 這些本章觀念是怎麼組合成一支真正的程式。

---

## 1.11 常見錯誤

- **忘了 `mut` 就想改值** → `cannot assign twice to immutable variable`。加 `mut`。
- **函式回傳那行多加了分號** → 型別變成 `()`，報「expected i32, found ()」。把分號去掉。
- **`if` 兩個分支型別不一致** → 編譯錯誤。確保 `if` 和 `else` 回傳同型別。
- **用 `==` 比較不同型別**（例如 `i32` 跟 `i64`）→ Rust 不會自動轉型，得明確 `as` 轉換或統一型別。
- **陣列越界** → 執行期 panic。用 `.get(i)` 會回傳 `Option`（安全）而不是直接 panic。
- **整數型別不匹配** → Rust 幾乎不自動轉型，`let x: u64 = some_i32;` 會錯，要 `some_i32 as u64`。

---

## 1.12 本章小結

- 變數**預設不可變**，要改加 `mut`；`const` 是編譯期常數、要標型別、全大寫。
- **shadowing** 是用 `let` 重新宣告同名新變數，可換型別，跟 `mut` 本質不同。
- 基本型別：整數（預設 `i32`，索引/長度用 `usize`）、浮點（預設 `f64`）、`bool`、`char`（4 bytes，能存 Unicode）。
- 複合型別：tuple（不同型別綁一起）、array（同型別、固定長度）。
- **Rust 是運算式導向**：`if`、`match`、`{}` 區塊都會算出值；**最後一行不加分號＝回傳值**。
- 迴圈有 `loop`（可 `break` 帶值）、`while`、`for`（最推薦）。
- `match` 強制窮盡、會回傳值，是 Rust 的核心控制流；只看一種情況用 `if let`。

---

## 1.13 動手作業

1. 寫一個函式 `fahrenheit_to_celsius(f: f64) -> f64`，並在 `main` 呼叫、印出結果。
2. 用 `for` 迴圈印出 1~20 的偶數（提示：`if i % 2 == 0` 或 `(1..=20).step_by(2)`）。
3. 寫一個 `grade(score: u32) -> &'static str`，用 `match` 把分數轉成 A/B/C/D/F（先照抄回傳型別 `&'static str`，第 02 章會懂那個 `'static`）。
4. 用 `loop` + `break 值` 寫一個「從 1 開始累加，直到總和超過 100 就停，回傳當時的數字」。
5. 故意在一個回傳 `i32` 的函式最後一行加上分號，看編譯器報什麼錯，再把分號拿掉修好。

---

## 1.14 驗收清單

- [ ] 我知道變數預設不可變，也分得清 `mut` 與 shadowing。
- [ ] 我認得整數/浮點/bool/char/tuple/array，也知道索引與長度是 `usize`。
- [ ] 我能解釋「運算式導向」以及「分號的有無」如何影響回傳值。
- [ ] 我會寫 `loop`/`while`/`for` 三種迴圈，並知道何時用哪個。
- [ ] 我理解 `match` 必須窮盡、會回傳值，也會用 `if let`。
- [ ] 我能定義函式、標註參數與回傳型別，並用「無分號運算式」回傳。

---

下一章 [02-ownership-borrowing-lifetimes.md](./02-ownership-borrowing-lifetimes.md) 是整門課**最重要**的一章：所有權、借用與生命週期。它是 Rust 的靈魂，也是初學者最容易卡的地方。前面學的語法都是為了這一章鋪路，請務必慢慢讀、多動手。
