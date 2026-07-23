# 第 03 章：型別系統 —— struct、enum、trait 與泛型

> 有了第 02 章的所有權，這一章要學怎麼「組織資料與行為」。這是 Rust 型別系統的骨架，也是後面架構設計的核心工具。
> 四個主角：`struct`（把資料綁在一起）、`enum`（表達「多選一」的狀態）、`trait`（定義共同行為，Rust 的「介面」）、泛型（寫一次、適用多種型別）。
> 學完這章，你就有能力用型別把你的領域模型「畫」出來——而且畫錯的組合，編譯器會直接擋下。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 定義 `struct`、為它加方法（`impl`），並理解 `&self` / `&mut self` / `self` 的差別。
- 用 `enum` 表達「一個值只可能是幾種情況之一」，並用 `match` 拆解它。
- 理解 `Option<T>` 為什麼能取代 null，以及它如何逼你處理「沒有值」的情況。
- 定義並實作 `trait`（Rust 的介面），理解 trait 是行為的抽象。
- 用泛型 `<T>` 寫出適用多種型別的函式與結構。
- 認識常用的 `derive`（`Debug`、`Clone`、`PartialEq` 等）並知道它替你做了什麼。

---

## 3.2 struct：把相關資料綁成一個型別

`struct`（結構）讓你把「屬於同一個東西的資料」打包成一個具名型別。

```rust
struct User {
    username: String,
    email: String,
    age: u32,
    active: bool,
}

fn main() {
    let user = User {
        username: String::from("alice"),
        email: String::from("alice@example.com"),
        age: 30,
        active: true,
    };

    println!("{} 的信箱是 {}", user.username, user.email);
}
```

- 每個欄位有名字和型別。
- 建立實例時，每個欄位都要給值。
- 用 `.欄位名` 取值。

### 可變性是「整個實例」層級

```rust
let mut user = User { /* ... */ };
user.age = 31;          // 要整個 user 是 mut，才能改任何欄位
```

Rust **不能只把單一欄位標成可變**；可變性是整個實例的性質。要嘛整個 `mut`，要嘛整個不可變。

### 其他兩種 struct 形式

```rust
// Tuple struct：有型別名，但欄位沒名字，用索引取
struct Point(i32, i32);
let origin = Point(0, 0);
println!("{}", origin.0);

// Unit struct：沒有任何欄位，通常拿來當「標記型別」
struct AlwaysEqual;
```

### struct 裡存參考：生命週期會出現

第 02 章說過：只要 struct 裡存的是**參考**，Rust 就需要知道「這個參考至少活多久」。所以型別本身要帶生命週期參數：

```rust
struct Excerpt<'a> {
    text: &'a str,
}

fn first_sentence<'a>(article: &'a str) -> Excerpt<'a> {
    let end = article.find('.').unwrap_or(article.len());
    Excerpt { text: &article[..end] }
}

fn main() {
    let article = String::from("Rust is fast. It is also safe.");
    let ex = first_sentence(&article);
    println!("{}", ex.text);
}
```

`Excerpt<'a>` 的意思不是「讓資料活更久」，而是告訴編譯器：`Excerpt` 裡的 `text` 不能比它借用的原始字串活得更久。

```rust
let ex;
{
    let article = String::from("短命文章");
    ex = Excerpt { text: &article };
} // article 在這裡被 drop
// println!("{}", ex.text); // ❌ 不能用，因為 ex.text 會指向已釋放的 article
```

> **實務建議**：後端的 domain/entity 多半直接擁有資料（例如 `String`），因為它們要跨層、跨 async、放進資料庫或回傳 JSON。`&str` 欄位常出現在「解析器、暫時視圖、零拷貝效能優化」場景。初學做後端時，優先用 owned 型別；等真的需要避免複製，再引入帶生命週期的 struct。

---

## 3.3 為 struct 加方法：`impl`

方法就是「掛在型別上的函式」。用 `impl` 區塊定義：

```rust
struct Rectangle {
    width: u32,
    height: u32,
}

impl Rectangle {
    // 方法：第一個參數是 self 系列
    fn area(&self) -> u32 {              // &self：唯讀借用自己，只讀不改
        self.width * self.height
    }

    fn scale(&mut self, factor: u32) {   // &mut self：可變借用自己，會改欄位
        self.width *= factor;
        self.height *= factor;
    }

    // 關聯函式（associated function）：沒有 self，常用來當「建構子」
    fn new(width: u32, height: u32) -> Self {   // Self 就是 Rectangle
        Rectangle { width, height }              // 欄位名與變數名相同時可省略
    }
}

fn main() {
    let mut rect = Rectangle::new(30, 50);   // 用 :: 呼叫關聯函式
    println!("面積：{}", rect.area());        // 用 . 呼叫方法
    rect.scale(2);
    println!("放大後面積：{}", rect.area());
}
```

`self` 三種形式，直接對應第 02 章的所有權概念：

| 寫法 | 意義 | 何時用 |
|------|------|--------|
| `&self` | 不可變借用自己 | 只讀取欄位（最常見） |
| `&mut self` | 可變借用自己 | 要修改欄位 |
| `self` | **取得所有權**（會消耗掉實例） | 要「轉換/消費」自己，之後原實例不能再用（少見但重要） |

> **心智模型**：方法的 `self` 就是把第 02 章的借用規則搬到「物件自己」身上。`&self` = 借來讀，`&mut self` = 借來改，`self` = 直接把自己交出去（用完就沒了）。

> **關聯函式 vs 方法**：有 `self` 的是**方法**，用 `實例.方法()` 呼叫；沒有 `self` 的是**關聯函式**，用 `型別::函式()` 呼叫（例如 `Rectangle::new(...)`、你熟悉的 `String::from(...)`）。慣例上把建構用的關聯函式叫 `new`。

---

## 3.4 enum：表達「多選一」

`enum`（列舉）表示「一個值只可能是這幾種情況之一」。這是 Rust 極其強大的特性，遠比其他語言的 enum 有力。

```rust
enum Direction {
    North,
    South,
    East,
    West,
}

let heading = Direction::North;
```

### 真正強大的地方：每個變體可以帶資料

其他語言的 enum 通常只是「一組常數」。Rust 的 enum 變體**可以攜帶不同型別、不同數量的資料**：

```rust
enum Message {
    Quit,                          // 不帶資料
    Move { x: i32, y: i32 },       // 帶一個匿名 struct（具名欄位）
    Write(String),                 // 帶一個 String
    ChangeColor(i32, i32, i32),    // 帶三個 i32
}
```

這一個 `Message` 型別，就能表達四種形狀完全不同的訊息。這在別的語言可能要用「繼承一堆子類別」或「一包 nullable 欄位」才能勉強表達，Rust 用 enum 就乾淨解決。

### 用 `match` 拆解 enum

`enum` 和 `match`（第 01 章）是天生一對。`match` 會強制你處理**每一個變體**，並能同時把裡面的資料**解構**出來：

```rust
fn process(msg: Message) {
    match msg {
        Message::Quit => println!("結束"),
        Message::Move { x, y } => println!("移動到 ({x}, {y})"),
        Message::Write(text) => println!("文字：{text}"),
        Message::ChangeColor(r, g, b) => println!("顏色：{r},{g},{b}"),
    }
}
```

> **為什麼這很重要？** 因為「窮盡檢查」。如果哪天你在 `Message` 加了新變體，所有沒處理它的 `match` **都會編譯失敗**，逼你回去補上。這讓「改了型別卻忘記改某處邏輯」這種 bug 幾乎不可能發生。這是 Rust 型別系統幫你維護正確性的一大利器。

---

## 3.5 `Option<T>`：Rust 沒有 null

這是 Rust 最重要的 enum，直接解決了被稱為「十億美元錯誤」的 null 問題。

**Rust 沒有 null。** 一個「可能有、可能沒有」的值，用標準庫的 `Option<T>` 表達：

```rust
enum Option<T> {      // 這是標準庫定義的（你不用自己寫），T 是泛型（下一節講）
    Some(T),          // 有值，值是 T
    None,             // 沒有值
}
```

用法：

```rust
let some_number: Option<i32> = Some(5);
let no_number: Option<i32> = None;
```

**關鍵好處**：因為「可能沒值」被編碼進型別，你**無法**直接把 `Option<i32>` 當 `i32` 用——編譯器逼你先處理 `None` 的情況：

```rust
let x: Option<i32> = Some(5);

// ❌ 不能直接運算，x 可能是 None
// let y = x + 1;

// ✅ 必須先「拆開」，順便處理沒值的情況
let y = match x {
    Some(n) => n + 1,
    None => 0,
};
```

> **對比其他語言**：Java/JS/Python 的變數幾乎都可能是 null/None，你常常「忘了檢查」而在執行期爆 NullPointerException。Rust 把「可能沒值」變成型別的一部分，**編譯器強制你在編譯期就處理**。你不會忘，因為忘了就編譯不過。

常用的便捷方法（第 04 章會更深入）：

```rust
let x = Some(5);
println!("{}", x.unwrap_or(0));        // 有值取值，None 就用預設 0
println!("{}", x.is_some());           // 是不是有值
if let Some(n) = x {                   // 只在乎「有值」時（第 01 章的 if let）
    println!("有值 {n}");
}
```

---

## 3.6 泛型（Generics）：寫一次，適用多種型別

假設你要寫「找出清單中最大值」，對 `i32` 要一個、對 `f64` 又要一個、對 `char` 再一個……重複三份很蠢。泛型讓你**寫一次、適用多種型別**。

```rust
// <T> 宣告一個型別參數 T；這個函式適用任何「可比較大小」的 T
fn largest<T: PartialOrd + Copy>(list: &[T]) -> T {
    let mut largest = list[0];
    for &item in list {
        if item > largest {
            largest = item;
        }
    }
    largest
}

fn main() {
    let numbers = vec![34, 50, 25, 100, 65];
    println!("{}", largest(&numbers));       // 用在 i32

    let chars = vec!['y', 'm', 'a', 'q'];
    println!("{}", largest(&chars));         // 同一個函式，用在 char
}
```

- `<T>`：宣告型別參數，`T` 是一個「之後才決定的型別」。
- `T: PartialOrd + Copy`：這叫 **trait bound（trait 約束）**，意思是「T 必須實作 `PartialOrd`（可比大小）和 `Copy`（可複製）」。沒有這個約束，編譯器不知道 `T` 能不能用 `>` 比較。

### 泛型 struct

```rust
struct Point<T> {
    x: T,
    y: T,
}

let int_point = Point { x: 5, y: 10 };        // T = i32
let float_point = Point { x: 1.0, y: 4.0 };   // T = f64
```

> **零成本**（回扣第 00 章）：Rust 的泛型是「單型化（monomorphization）」——編譯器會在編譯期，針對你實際用到的每種型別**各生成一份專用程式碼**。所以泛型在執行期跟「手寫多份」一樣快，沒有動態分派的成本。抽象免費，就是這個意思。

---

## 3.7 trait：Rust 的「介面」，定義共同行為

`trait` 定義「一組型別可以共享的行為」。如果你熟 Java/C# 的 interface、Go 的 interface，`trait` 是同一個家族——但更強。

```rust
// 定義一個 trait：任何「可以被摘要」的東西
trait Summary {
    fn summarize(&self) -> String;        // 只有簽章，沒有實作（要求實作者提供）

    fn preview(&self) -> String {          // 也可以給「預設實作」
        format!("{}...", &self.summarize()[..5.min(self.summarize().len())])
    }
}

struct Article {
    title: String,
    content: String,
}

struct Tweet {
    username: String,
    text: String,
}

// 為 Article 實作 Summary
impl Summary for Article {
    fn summarize(&self) -> String {
        format!("{}：{}", self.title, self.content)
    }
}

// 為 Tweet 實作 Summary
impl Summary for Tweet {
    fn summarize(&self) -> String {
        format!("@{}: {}", self.username, self.text)
    }
}
```

現在 `Article` 和 `Tweet` 都「會 summarize」，但各有各的做法。

### 用 trait 當參數：接受「任何實作了某 trait 的型別」

```rust
// 接受任何實作了 Summary 的東西
fn notify(item: &impl Summary) {
    println!("最新消息！{}", item.summarize());
}

// 上面是語法糖，等同於這個泛型寫法：
fn notify_generic<T: Summary>(item: &T) {
    println!("最新消息！{}", item.summarize());
}
```

`notify` 可以吃 `&Article`、也可以吃 `&Tweet`——只要它實作了 `Summary`。這就是**基於行為的抽象**：函式不在乎你是什麼具體型別，只在乎「你會不會 summarize」。

> **心智模型**：trait 是「能力認證」。`Summary` 就像一張證照，`Article` 和 `Tweet` 各自去考取（`impl Summary for ...`）。`notify` 說「我只服務有這張證照的人，不管你本業是什麼」。這正是第 09 章架構設計的核心——**依賴抽象（trait），而非具體型別**。

### trait 也讓泛型約束更精準

回顧 3.6 的 `T: PartialOrd + Copy`——那些 `PartialOrd`、`Copy` 就是 trait。泛型 + trait bound 合起來，讓你能寫「適用任何具備某些能力的型別」的通用程式碼。

---

## 3.8 derive：讓編譯器自動幫你實作常見 trait

有些 trait 太常用了（印出來 debug、複製、比較相等），Rust 提供 `#[derive(...)]` 讓編譯器自動生成實作，你不用手寫：

```rust
#[derive(Debug, Clone, PartialEq)]
struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let p1 = Point { x: 1, y: 2 };
    let p2 = p1.clone();               // 因為 derive 了 Clone

    println!("{:?}", p1);              // 因為 derive 了 Debug，{:?} 能印出結構
    println!("{p1:#?}");               // {:#?} 是「漂亮列印」，多行縮排

    println!("{}", p1 == p2);          // 因為 derive 了 PartialEq，能用 == 比較
}
```

常見可 derive 的 trait：

| trait | 給你什麼能力 |
|-------|------------|
| `Debug` | 用 `{:?}` / `{:#?}` 印出（開發除錯必備） |
| `Clone` | `.clone()` 深拷貝 |
| `Copy` | 讓型別變成 Copy 語意（僅限全欄位都是 Copy） |
| `PartialEq` / `Eq` | 用 `==` `!=` 比較相等 |
| `PartialOrd` / `Ord` | 用 `<` `>` 比較大小、可排序 |
| `Hash` | 能當 `HashMap` 的 key |
| `Default` | 有 `Type::default()` 產生預設值 |

> **實務習慣**：幾乎每個你自訂的 struct/enum 都會加 `#[derive(Debug)]`，因為除錯時要能把它印出來看。要比較、複製、當 key 時再加對應的 derive。

### `{}` vs `{:?}`：兩種列印

- `{}`（Display）：給「人看的、正式的」輸出，**要自己實作 `Display` trait**（不能 derive）。像 `String`、數字這些標準型別已內建。
- `{:?}`（Debug）：給「開發者除錯看的」輸出，可以直接 `#[derive(Debug)]`。

初學時你自訂的型別大多用 `{:?}` 就好。

---

## 3.9 綜合範例：用型別把領域模型畫出來

把本章工具串起來，模擬一個「訂單狀態」的小模型（也預告第 09 章的領域建模）：

```rust
#[derive(Debug, Clone, PartialEq)]
enum OrderStatus {
    Pending,
    Paid { transaction_id: String },   // 已付款，帶交易編號
    Shipped { tracking: String },      // 已出貨，帶物流單號
    Cancelled,
}

#[derive(Debug)]
struct Order {
    id: u64,
    amount: f64,
    status: OrderStatus,
}

impl Order {
    fn new(id: u64, amount: f64) -> Self {
        Order { id, amount, status: OrderStatus::Pending }
    }

    // 依狀態回傳一句人看得懂的描述
    fn describe(&self) -> String {
        match &self.status {
            OrderStatus::Pending => format!("訂單 {} 待付款 ${}", self.id, self.amount),
            OrderStatus::Paid { transaction_id } =>
                format!("訂單 {} 已付款（交易 {}）", self.id, transaction_id),
            OrderStatus::Shipped { tracking } =>
                format!("訂單 {} 已出貨（物流 {}）", self.id, tracking),
            OrderStatus::Cancelled => format!("訂單 {} 已取消", self.id),
        }
    }
}

fn main() {
    let mut order = Order::new(1001, 299.0);
    println!("{}", order.describe());

    order.status = OrderStatus::Paid { transaction_id: String::from("TXN-88") };
    println!("{}", order.describe());
    println!("{:#?}", order);          // Debug 漂亮列印整個訂單
}
```

注意：如果你之後在 `OrderStatus` 加一個新狀態（例如 `Refunded`），`describe` 裡的 `match` 會**立刻編譯失敗**，提醒你「還沒處理這個狀態」。這就是用型別系統守護正確性的威力。

---

## 3.10 常見錯誤

- **想只讓一個欄位可變** → 不行，可變性是整個實例的。整個 `mut`，或重新設計。
- **`match` 沒窮盡** → 編譯錯誤，補齊變體或用 `_`。這通常是好事（提醒你漏了）。
- **把 `Option<T>` 當 `T` 用** → 編譯錯誤，先 `match` / `if let` / `unwrap_or` 拆開。
- **泛型少了 trait bound** → 「cannot compare」之類的錯，因為編譯器不知道 `T` 有沒有那個能力，補上 `T: SomeTrait`。
- **忘了 `#[derive(Debug)]` 就用 `{:?}` 印** → 報「doesn't implement Debug」，加上 derive。
- **`self` vs `&self` 用錯**：用了 `self`（取得所有權）後，實例就被消耗掉不能再用；只想讀就用 `&self`。

---

## 3.11 本章小結

- **struct** 把相關資料綁成具名型別；用 `impl` 加方法。方法的 `&self`/`&mut self`/`self` 對應第 02 章的借用/所有權。
- **關聯函式**（無 `self`，用 `::` 呼叫）常拿來當建構子（慣例叫 `new`）。
- **enum** 表達「多選一」，變體可攜帶資料；配 `match` 拆解並享受**窮盡檢查**。
- **`Option<T>`** 取代 null，把「可能沒值」編進型別，逼你在編譯期處理。
- **泛型 `<T>`** 讓你寫一次適用多型別，靠 **trait bound** 約束能力；單型化讓它零成本。
- **trait** 是 Rust 的介面，定義共同行為；用 `impl Trait for Type` 實作，用 `impl Trait` / 泛型當參數，達成「依賴行為而非具體型別」。
- **`#[derive(...)]`** 自動實作常見 trait（`Debug`、`Clone`、`PartialEq`…），開發必備。

---

## 3.12 動手作業

1. 定義 `struct Circle { radius: f64 }`，加 `area(&self)` 與關聯函式 `new`，在 `main` 建立並印面積。
2. 定義 `enum Shape { Circle(f64), Rectangle(f64, f64) }`，寫函式用 `match` 算面積。
3. 寫函式 `fn find_user(id: u32) -> Option<String>`：id 為 1 回傳 `Some("alice")`，否則 `None`；在 `main` 用 `match` 處理兩種結果。
4. 定義 trait `Animal { fn sound(&self) -> String; }`，讓 `Dog`、`Cat` 各自實作，寫一個 `fn describe(a: &impl Animal)` 印出叫聲。
5. 幫上面所有 struct/enum 加上 `#[derive(Debug)]`，並用 `{:#?}` 印出來觀察格式。
6. 在第 2 題的 `Shape` 新增一個 `Triangle`，觀察 `match` 沒補上時的編譯錯誤，再補好。

---

## 3.13 驗收清單

- [ ] 我會定義 struct、加 `impl` 方法，並分得清 `&self`/`&mut self`/`self`。
- [ ] 我知道關聯函式（`::`）與方法（`.`）的差別。
- [ ] 我會用 enum 表達多選一、變體帶資料，並用 `match` 窮盡拆解。
- [ ] 我理解 `Option<T>` 如何取代 null，並知道怎麼安全拆開它。
- [ ] 我會寫泛型函式/struct，並用 trait bound 約束型別能力。
- [ ] 我會定義與實作 trait，並用它當函式參數做行為抽象。
- [ ] 我知道常用 derive 各給我什麼能力，也分得清 `{}` 與 `{:?}`。

---

下一章 [04-error-handling-result-option.md](./04-error-handling-result-option.md) 我們專攻**錯誤處理**。你會看到 `Option` 的兄弟 `Result<T, E>`、超好用的 `?` 運算子，以及 `thiserror` / `anyhow` 這兩個實務必備的 crate。錯誤處理是 Rust 「可靠」名聲的另一半，也是寫後端服務天天要用的。
