# 第 05 章：集合、迭代器與閉包

> 這一章是「日常寫 Rust 最常用」的工具箱：可增長的 `Vec`、鍵值對的 `HashMap`、招牌的**迭代器（iterator）**與**閉包（closure）**。
> 迭代器鏈（`.iter().filter().map().collect()`）是 Rust 程式碼「長那樣」的一大原因——優雅、好讀，而且是第 00 章講的**零成本抽象**的最佳範例。
> 學完這章，你處理資料的手感會截然不同，也為後面資料庫查詢結果、API 回應的處理打好基礎。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 熟練使用 `Vec<T>`（可增長陣列）與 `HashMap<K, V>`（鍵值對）。
- 理解迭代器是「惰性的」，以及 `iter` / `iter_mut` / `into_iter` 的差別。
- 用 `map`、`filter`、`collect`、`sum`、`fold` 等迭代器方法組成處理鏈。
- 寫閉包（closure），並理解它如何「捕捉」環境變數（借用 vs move）。
- 知道 `String` 與 `&str`、`Vec` 與 slice 在迭代裡怎麼配合所有權。

---

## 5.2 Vec<T>：可增長的清單

第 01 章的 array 長度固定。真實程式大多需要「可以動態增刪」的清單，那就是 `Vec<T>`（vector）。

```rust
fn main() {
    let mut v: Vec<i32> = Vec::new();   // 空的 vec
    v.push(1);                           // 加元素到尾端
    v.push(2);
    v.push(3);

    let v2 = vec![10, 20, 30];           // vec! 巨集，直接用初始值建立

    println!("{}", v2[0]);               // 索引存取（越界會 panic）
    println!("{:?}", v2.get(99));        // .get 回傳 Option，越界得到 None（安全）

    println!("長度：{}", v2.len());
}
```

- `Vec` 存在 heap（回扣第 02 章），能動態成長。
- 兩種取值：`v[i]`（越界 panic）與 `v.get(i)`（回傳 `Option`，安全）。要處理不確定的索引時用 `.get`。

### 遍歷 Vec 與借用規則

```rust
let v = vec![100, 32, 57];

for i in &v {                // 借用遍歷（&v），不奪走所有權，之後 v 還能用
    println!("{i}");
}
println!("{:?}", v);         // ✅ v 仍可用

let mut v2 = vec![1, 2, 3];
for i in &mut v2 {           // 可變借用遍歷，可以改元素
    *i += 10;                // *i 解參考後修改（第 07 章講解參考）
}
println!("{:?}", v2);        // [11, 12, 13]
```

> **注意**：`for i in v`（不加 `&`）會**把 v 的所有權 move 進迴圈**，之後 v 不能再用（回扣第 02 章）。想保留 v 就用 `&v`。這個 `&` 的有無，是初學者最常忽略的地方。

---

## 5.3 HashMap<K, V>：鍵值對

`HashMap` 存「鍵 → 值」的對應，像其他語言的 dict / map / object。

```rust
use std::collections::HashMap;         // HashMap 不在 prelude，要 use

fn main() {
    let mut scores = HashMap::new();
    scores.insert(String::from("Alice"), 90);   // 插入 key-value
    scores.insert(String::from("Bob"), 85);

    // 取值：get 回傳 Option<&V>（key 可能不存在）
    match scores.get("Alice") {
        Some(s) => println!("Alice: {s}"),
        None => println!("查無此人"),
    }

    // 遍歷（順序不保證）
    for (name, score) in &scores {
        println!("{name}: {score}");
    }

    // 常用技巧：key 不存在才插入預設，然後拿到可變參考去改
    let counter = scores.entry(String::from("Carol")).or_insert(0);
    *counter += 1;              // 把 Carol 的分數 +1（原本沒有就從 0 開始）
}
```

幾個要點：

- `get` 回傳 `Option<&V>`——因為 key 可能不存在，這又是第 03、04 章「用型別強制你處理沒值」的展現。
- **`entry(...).or_insert(...)`** 是超實用的慣用法：「這個 key 有就拿來、沒有就插入預設值」，常用來做計數、分組。

### 經典應用：統計字數

```rust
use std::collections::HashMap;

fn main() {
    let text = "the quick brown fox the lazy dog the";
    let mut counts: HashMap<&str, i32> = HashMap::new();

    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;   // 每出現一次就 +1
    }

    println!("{:?}", counts);    // {"the": 3, "quick": 1, ...}
}
```

這段程式體現了 `entry` 的威力——短短一行就完成「有就累加、沒有就從 0 開始」。

---

## 5.4 迭代器（Iterator）：Rust 的招牌

迭代器是「可以逐一產生元素的東西」。Rust 的迭代器有兩個關鍵特性：**惰性（lazy）** 和 **零成本**。

### 惰性：不主動跑，直到你要結果

```rust
let v = vec![1, 2, 3];

let iter = v.iter().map(|x| x * 2);    // 這行「什麼都還沒做」！只是描述了一個計畫
// map 是惰性的，還沒真的乘 2

let result: Vec<i32> = iter.collect(); // collect 才是「觸發」，真正跑一遍
println!("{:?}", result);              // [2, 4, 6]
```

`map`、`filter` 這類方法叫**適配器（adapter）**，它們只是「描述要做什麼」，回傳一個新的迭代器，**不會真的執行**。真正觸發運算的是**消費者（consumer）**方法，例如 `collect`、`sum`、`for` 迴圈、`count`。

> **心智模型**：迭代器鏈像「組裝一條生產線」——`map`/`filter` 是安裝機台（還沒開機），`collect`/`sum` 是按下開始鈕（東西才真的流過去被加工）。這種惰性讓你能組很長的鏈，卻只跑一次、不產生一堆中間陣列。

### 三種取得迭代器的方式（跟所有權有關）

| 方法 | 產生什麼 | 對原集合的影響 |
|------|----------|----------------|
| `.iter()` | `&T`（不可變參考） | 借用，原集合仍可用 |
| `.iter_mut()` | `&mut T`（可變參考） | 可變借用，可改元素 |
| `.into_iter()` | `T`（值本身） | **move**，消耗掉原集合 |

```rust
let v = vec![1, 2, 3];
let sum: i32 = v.iter().sum();      // 借用，v 之後還能用
println!("{:?}", v);                // ✅ 可用

let v2 = vec![1, 2, 3];
let doubled: Vec<i32> = v2.into_iter().map(|x| x * 2).collect();  // 消耗 v2
// println!("{:?}", v2);            // ❌ v2 已被 move
```

這又是第 02 章所有權的延伸：你要「借看」用 `iter`，要「拿走」用 `into_iter`。

---

## 5.5 常用迭代器方法

這些是你會天天用的：

```rust
let nums = vec![1, 2, 3, 4, 5, 6];

// map：轉換每個元素
let squares: Vec<i32> = nums.iter().map(|x| x * x).collect();
// [1, 4, 9, 16, 25, 36]

// filter：留下符合條件的
let evens: Vec<&i32> = nums.iter().filter(|x| **x % 2 == 0).collect();
// [2, 4, 6]

// filter + map 串接（先篩再轉）
let even_squares: Vec<i32> = nums.iter()
    .filter(|x| **x % 2 == 0)
    .map(|x| x * x)
    .collect();
// [4, 16, 36]

// sum / product：加總 / 連乘
let total: i32 = nums.iter().sum();          // 21

// count：計數
let n = nums.iter().filter(|x| **x > 3).count();  // 3

// find：找第一個符合的（回傳 Option）
let first_even = nums.iter().find(|x| **x % 2 == 0);  // Some(2)

// any / all：是否「有任一 / 全部」符合
let has_big = nums.iter().any(|x| *x > 5);   // true
let all_pos = nums.iter().all(|x| *x > 0);   // true

// enumerate：帶上索引
for (i, val) in nums.iter().enumerate() {
    println!("第 {i} 個是 {val}");
}

// fold：從初始值開始，把元素一個個「摺疊」進去（通用累加器）
let sum2 = nums.iter().fold(0, |acc, x| acc + x);   // 21
```

### 對比命令式寫法

```rust
// 命令式（其他語言常見）：手動迴圈 + 可變累加
let mut result = Vec::new();
for x in &nums {
    if x % 2 == 0 {
        result.push(x * x);
    }
}

// 迭代器（道地 Rust）：宣告式、一眼看懂「做什麼」
let result: Vec<i32> = nums.iter()
    .filter(|x| **x % 2 == 0)
    .map(|x| x * x)
    .collect();
```

兩者**編譯後效能幾乎相同**（零成本抽象！），但迭代器版本更好讀、更不容易寫錯邊界。這就是為什麼道地 Rust 大量使用迭代器鏈。

> **關於那些 `*` 和 `**`**：`iter()` 給的是參考（`&i32`），`filter` 的閉包參數又多包一層參考，所以有時要 `*` / `**` 解開才能跟數字比較。剛學覺得煩很正常，寫多了會習慣。實在被 `*` 搞暈時，可以在閉包參數用模式解構，例如 `.filter(|&&x| x % 2 == 0)`，把參考在參數處就拆掉。

---

## 5.6 閉包（Closure）：能捕捉環境的匿名函式

上面 `map`、`filter` 裡的 `|x| x * 2` 就是**閉包**——一個「就地定義的匿名函式」。它跟普通函式最大的差別：**能捕捉（記住）它周圍環境的變數**。

```rust
fn main() {
    let multiplier = 3;                      // 環境中的變數

    let multiply = |x: i32| x * multiplier;  // 閉包捕捉了 multiplier

    println!("{}", multiply(5));             // 15
    println!("{}", multiply(10));            // 30
}
```

`multiply` 這個閉包「記住」了外面的 `multiplier`。普通函式做不到這件事——函式無法存取定義它的地方的區域變數。

### 閉包語法

```rust
let add = |a, b| a + b;              // 型別可省略（編譯器推斷）
let add = |a: i32, b: i32| -> i32 { a + b };   // 完整寫法

let say_hi = || println!("hi");      // 無參數
```

跟函式的差別：閉包用 `|參數|` 而非 `(參數)`，型別通常可省略。

### 閉包如何捕捉變數：借用 vs move

閉包捕捉環境變數時，遵循第 02 章的所有權規則，有三種方式（編譯器會依你怎麼用自動選最寬鬆的）：

```rust
let s = String::from("hello");

// 1. 不可變借用（只讀環境變數）
let print_s = || println!("{s}");
print_s();
println!("{s}");            // ✅ 只是借用，s 還能用

// 2. 可變借用（會改環境變數）
let mut count = 0;
let mut increment = || count += 1;
increment();
increment();
println!("{count}");        // 2

// 3. move：強制取得所有權
let s2 = String::from("world");
let consume = move || println!("{s2}");   // move 把 s2 的所有權搬進閉包
consume();
// println!("{s2}");        // ❌ s2 已被 move 進閉包
```

**`move` 關鍵字**很重要：它強制閉包「取得」捕捉變數的所有權，而非借用。**這在多執行緒（第 08 章）幾乎必用**——因為把工作丟到別的執行緒時，那些變數必須「搬過去」，不能只是借用（借用的東西可能在別處被 drop）。

> **心智模型**：閉包預設「能借就借」（盡量不奪走所有權）；加 `move` 就是明確說「這些變數整個搬進閉包裡歸它管」。判斷要不要 `move`：如果閉包會活得比外面的變數久（例如丟到別的執行緒、存起來之後才用），就要 `move`。

---

## 5.7 綜合範例：處理一批訂單資料

把集合、迭代器、閉包串起來，做一個實際會遇到的資料處理（也預告後面 API 回應/DB 查詢結果的處理）：

```rust
#[derive(Debug)]
struct Order {
    id: u64,
    amount: f64,
    paid: bool,
}

fn main() {
    let orders = vec![
        Order { id: 1, amount: 100.0, paid: true },
        Order { id: 2, amount: 250.0, paid: false },
        Order { id: 3, amount: 80.0, paid: true },
        Order { id: 4, amount: 300.0, paid: true },
    ];

    // 1. 已付款訂單的總金額
    let paid_total: f64 = orders.iter()
        .filter(|o| o.paid)               // 只留已付款
        .map(|o| o.amount)                // 取金額
        .sum();                            // 加總
    println!("已付款總額：{paid_total}");   // 480.0

    // 2. 金額 > 100 的訂單 id 清單
    let big_ids: Vec<u64> = orders.iter()
        .filter(|o| o.amount > 100.0)
        .map(|o| o.id)
        .collect();
    println!("大額訂單 id：{:?}", big_ids);  // [2, 4]

    // 3. 有沒有未付款的訂單？
    let has_unpaid = orders.iter().any(|o| !o.paid);
    println!("有未付款：{has_unpaid}");      // true

    // 4. 用 HashMap 依「是否付款」分組計數
    use std::collections::HashMap;
    let mut group: HashMap<bool, u32> = HashMap::new();
    for o in &orders {
        *group.entry(o.paid).or_insert(0) += 1;
    }
    println!("分組：{:?}", group);           // {true: 3, false: 1}
}
```

這段展示了「宣告式資料處理」的威力——每一段都是在描述「我要什麼」，而非「怎麼一步步迴圈」。後面第 10 章從資料庫撈出一堆 row、第 12 章拿到一堆 API 回應，處理手法都是這一套。

---

## 5.8 常見錯誤

- **`for x in v` 忘了加 `&`** → v 被 move 進迴圈，之後不能用。要保留就 `for x in &v`。
- **迭代器建了卻沒消費** → 編譯器警告「iterators are lazy and do nothing unless consumed」。加上 `collect`/`sum`/`for` 等消費者。
- **`collect` 沒標型別** → 編譯器不知道你要收成 `Vec` 還是 `HashMap` 等，報「type annotations needed」。用 `let x: Vec<_> = ...` 或 `.collect::<Vec<_>>()` 指定。
- **閉包裡 `*` / `**` 用錯層數** → 型別對不上。可改在參數用模式解構（如 `|&x|`）減少 `*`。
- **該 `move` 沒 `move`**（例如把閉包丟到執行緒） → 借用活不夠久的錯誤。加 `move`。
- **`HashMap` 忘了 `use std::collections::HashMap;`** → 找不到型別。

---

## 5.9 本章小結

- **`Vec<T>`**：可增長清單，存 heap；`v[i]` 越界 panic、`v.get(i)` 回 `Option` 較安全。
- **`HashMap<K, V>`**：鍵值對；`get` 回 `Option`；`entry().or_insert()` 是超實用慣用法。
- **迭代器**是惰性的：`map`/`filter` 只描述計畫，`collect`/`sum`/`for` 才觸發執行；且是零成本抽象。
- `iter()`（借用）/ `iter_mut()`（可變借用）/ `into_iter()`（move）對應第 02 章的所有權。
- 常用方法：`map`、`filter`、`collect`、`sum`、`find`、`any`、`all`、`enumerate`、`fold`。
- **閉包**是能捕捉環境變數的匿名函式；捕捉方式有借用/可變借用/`move`，多執行緒場景常用 `move`。

---

## 5.10 動手作業

1. 建一個 `Vec<i32>`，用迭代器鏈算出「所有偶數的平方和」。
2. 用 `HashMap` 統計一句英文裡每個字母出現幾次（提示：`s.chars()`）。
3. 給一個 `Vec<String>` 名字清單，用迭代器過濾出「長度 > 3」的名字，轉成大寫（`.to_uppercase()`），收成新的 `Vec<String>`。
4. 寫一個閉包 `make_adder`，接收一個數字 `n`，回傳「一個會把輸入加上 n 的閉包」（提示：回傳型別用 `impl Fn(i32) -> i32`，並可能需要 `move`）。
5. 用 5.7 的 `Order` 結構，算出「未付款訂單的平均金額」（提示：`filter` 後 `sum` 除以 `count`，注意除以 0）。
6. 把第 1 題同時用「命令式 for 迴圈」和「迭代器鏈」各寫一次，比較兩者可讀性。

---

## 5.11 驗收清單

- [ ] 我會用 `Vec` 的 `push`/索引/`get`，也知道 `[i]` 與 `.get(i)` 的差別。
- [ ] 我會用 `HashMap` 的 `insert`/`get`/`entry().or_insert()`。
- [ ] 我理解迭代器是惰性的，知道要用消費者方法才會執行。
- [ ] 我分得清 `iter`/`iter_mut`/`into_iter` 對所有權的影響。
- [ ] 我能用 `map`/`filter`/`collect` 等組成處理鏈，並理解它零成本。
- [ ] 我會寫閉包，理解它捕捉環境的三種方式與何時要 `move`。

---

下一章 [06-modules-cargo-crates-testing.md](./06-modules-cargo-crates-testing.md) 我們把視角拉高到「專案層級」：如何用 `mod` 組織程式碼、`Cargo.toml` 怎麼管依賴與 workspace、怎麼寫單元測試與整合測試。這章學完，你就有能力把程式碼組織成一個真正的專案，銜接第 09 章的架構設計。
