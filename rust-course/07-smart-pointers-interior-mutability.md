# 第 07 章：智慧指標與內部可變性

> 第 02 章的所有權規則很嚴：一個值一個擁有者、要嘛多讀要嘛一寫。但真實世界有些結構天生「需要共享」或「需要在被共享時還能改」——
> 例如樹狀/圖狀結構、多個地方指向同一份設定、多執行緒共用狀態。這章介紹一組工具（`Box`、`Rc`、`Arc`、`RefCell`、`Mutex`），
> 讓你在**不破壞安全**的前提下，處理這些「單一擁有者不夠用」的情況。這也是理解第 08 章併發的直接前置。

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說明什麼是「智慧指標」，以及 `Deref`/`Drop` 的角色。
- 用 `Box<T>` 把資料放到 heap，並用它做遞迴型別與 trait 物件。
- 用 `Rc<T>` 做「單執行緒的多重擁有」（共享所有權）。
- 用 `RefCell<T>` 達成「內部可變性」，理解它把借用檢查從編譯期移到執行期的取捨。
- 組合 `Rc<RefCell<T>>` 處理「共享且可變」的結構。
- 用 `Arc<T>` 與 `Mutex<T>` 做「多執行緒的共享可變狀態」，並知道它跟單執行緒版本的對應關係。

---

## 7.2 什麼是「智慧指標」

**指標**就是「存著一個記憶體位址的東西」。第 02 章的參考 `&` 就是最基本的指標——它只是借用，不擁有資料。

**智慧指標（smart pointer）**則是「一個行為像指標，但額外帶有一些能力/資料」的型別。它通常**擁有**它指向的資料，並在適當時機自動清理。你其實已經用過兩個智慧指標了：`String` 和 `Vec<T>`——它們都擁有 heap 資料、記著長度容量、離開作用域時自動釋放。

智慧指標靠兩個 trait 運作：

- **`Deref`**：讓你能用 `*` 解參考、也讓智慧指標「用起來像它包住的東西」（例如 `Vec` 能直接呼叫 slice 的方法）。
- **`Drop`**：定義「離開作用域時自動執行的清理邏輯」——這就是第 02 章「擁有者離開就 drop」背後的機制。

> **心智模型**：普通參考 `&` 是「借條」；智慧指標是「保險箱」——它真的裝著東西、負責保管，還在你不用時自動處理善後。

---

## 7.3 Box<T>：把資料放到 heap

`Box<T>` 是最簡單的智慧指標：它把一個值放到 **heap**，Box 本身（在 stack）只存一個指向它的指標。

```rust
fn main() {
    let b = Box::new(5);       // 5 被放到 heap，b 指向它
    println!("{b}");           // 用起來跟一般的 5 沒兩樣（Deref 的功勞）
}                              // b 離開作用域，heap 上的 5 被釋放（Drop）
```

單看這個例子，`Box` 好像沒什麼用（一個 `i32` 幹嘛放 heap）。它真正的價值在兩個場景：

### 場景一：遞迴型別（大小在編譯期無法確定）

假設你要定義一個「鏈結串列」節點：

```rust
// ❌ 這樣不行！編譯器算不出 List 的大小（它包含自己，無限大）
// enum List {
//     Cons(i32, List),
//     Nil,
// }

// ✅ 用 Box 包起來：Box 是一個「固定大小的指標」，大小就確定了
enum List {
    Cons(i32, Box<List>),
    Nil,
}

use List::{Cons, Nil};

fn main() {
    let list = Cons(1, Box::new(Cons(2, Box::new(Cons(3, Box::new(Nil))))));
    // 1 -> 2 -> 3 -> Nil
}
```

**為什麼需要 Box？** Rust 要在編譯期知道每個型別佔多少空間。一個「包含自己」的型別大小是無限的，算不出來。`Box<List>` 是一個指標，大小固定（就是一個位址的大小），於是型別大小就確定了。**Box 把「大小不確定的遞迴」變成「大小確定的指標」。**

### 場景二：trait 物件（動態分派）

第 03 章的泛型是「編譯期」決定型別（單型化）。但有時你想要「執行期才決定是哪個具體型別」，例如一個 `Vec` 裡裝各種不同的、但都實作了某 trait 的東西：

```rust
trait Shape {
    fn area(&self) -> f64;
}

struct Circle { r: f64 }
struct Square { s: f64 }

impl Shape for Circle { fn area(&self) -> f64 { 3.14 * self.r * self.r } }
impl Shape for Square { fn area(&self) -> f64 { self.s * self.s } }

fn main() {
    // Vec 裡裝不同型別，但都是 Shape —— 用 Box<dyn Shape>
    let shapes: Vec<Box<dyn Shape>> = vec![
        Box::new(Circle { r: 2.0 }),
        Box::new(Square { s: 3.0 }),
    ];

    for shape in &shapes {
        println!("面積：{}", shape.area());   // 執行期才知道呼叫的是哪個 area
    }
}
```

- **`dyn Shape`** 叫 **trait 物件**，表示「某個實作了 `Shape` 的型別，但具體是誰執行期才知道」。
- 因為不同型別大小不同，得用 `Box`（指標，固定大小）包起來才能放進同一個 `Vec`。
- 這叫**動態分派（dynamic dispatch）**——呼叫 `area()` 時，執行期才查表決定跑哪個實作。跟泛型的靜態分派相比，多一點點執行期成本，但換來彈性。

> **靜態 vs 動態分派**：泛型（`impl Trait` / `<T: Trait>`）是編譯期展開、零成本、但每種型別各一份程式碼；trait 物件（`dyn Trait`）是執行期查表、有一點成本、但能把不同型別混在一起。**第 09 章架構設計會用 `dyn Trait` 來做「依賴抽象」**（例如 `Box<dyn UserRepository>`），先在這裡認識它。你也會看到 `Box<dyn Error>`（第 04 章）就是這個道理——裝「任何一種錯誤」。

---

## 7.4 Rc<T>：多重擁有（單執行緒）

第 02 章說「一個值只能有一個擁有者」。但有些結構天生需要「多個地方共同擁有同一份資料」——例如圖中一個節點被多條邊指向。這時用 **`Rc<T>`（Reference Counted，參考計數）**。

```rust
use std::rc::Rc;

fn main() {
    let a = Rc::new(String::from("shared data"));
    println!("計數：{}", Rc::strong_count(&a));   // 1

    let b = Rc::clone(&a);      // 不是深拷貝！只是「多一個擁有者」，計數 +1
    println!("計數：{}", Rc::strong_count(&a));   // 2

    {
        let c = Rc::clone(&a);
        println!("計數：{}", Rc::strong_count(&a)); // 3
    }   // c 離開作用域，計數 -1

    println!("計數：{}", Rc::strong_count(&a));   // 2
    // a、b 都能讀同一份 "shared data"
    println!("{a} {b}");
}
```

`Rc` 的運作：

- 它內部維護一個**計數器**，記錄「有幾個擁有者」。
- `Rc::clone` **不複製資料**，只是把計數 +1（很便宜）。多個 `Rc` 指向同一份 heap 資料。
- 每個 `Rc` 離開作用域時計數 -1；**計數歸零時，資料才真正釋放**。

> **心智模型**：`Rc` 像「一份共用文件 + 一個借閱登記簿」。每多一個人借（`Rc::clone`）就登記 +1，每還一個就 -1，登記簿歸零時才把文件銷毀。這樣就能安全地「多人共享，最後一個離開的人負責清理」。

**重要限制**：`Rc<T>` 只給你**共享的唯讀存取**（`&T`）。它不能讓你改資料——因為多個擁有者同時改會違反借用規則。而且 `Rc` **只能用在單執行緒**（它的計數器不是執行緒安全的）。要在多執行緒共享，用 7.7 的 `Arc`。

---

## 7.5 RefCell<T> 與內部可變性

現在有個矛盾：`Rc` 讓你共享，但只能讀。如果你就是需要「共享的同時還要能改」怎麼辦？這就要**內部可變性（interior mutability）**——`RefCell<T>`。

### 先理解「內部可變性」在講什麼

正常情況下，要改一個值，你得持有它的可變借用 `&mut`（第 02 章）。內部可變性是一種模式：**即使你只拿著一個不可變參考 `&`，也能改裡面的資料**。聽起來像作弊？它的作法是——**把借用規則的檢查從「編譯期」搬到「執行期」**。

```rust
use std::cell::RefCell;

fn main() {
    let data = RefCell::new(5);        // 注意：data 本身不是 mut

    *data.borrow_mut() += 10;          // borrow_mut() 拿到可變借用，改它
    println!("{}", data.borrow());     // 15，borrow() 拿到不可變借用

    // 借用規則仍然存在，只是改在「執行期」檢查！
}
```

- `borrow()`：拿一個不可變借用（`Ref`），可多個。
- `borrow_mut()`：拿一個可變借用（`RefMut`），同時只能一個。

**關鍵取捨**：`RefCell` 仍然強制第 02 章的借用規則（多讀 or 一寫），但**違反時不是編譯錯誤，而是執行期 panic**：

```rust
let data = RefCell::new(5);
let b1 = data.borrow_mut();
let b2 = data.borrow_mut();     // ❌ 執行期 panic：already borrowed
```

> **心智模型**：一般借用是「保全在門口檢查（編譯期，過不了就別想進）」；`RefCell` 是「先讓你進去，但裡面有監視器，違規當場抓（執行期 panic）」。你用一點「執行期檢查成本 + 違規會 panic 的風險」，換來「編譯器不擋你」的彈性。

**什麼時候用 RefCell？** 當你「邏輯上確定安全，但編譯器的靜態檢查太保守、不讓你過」時。最常見的搭配是下一節的 `Rc<RefCell<T>>`。

---

## 7.6 Rc<RefCell<T>>：共享且可變

把 `Rc`（多重擁有）和 `RefCell`（內部可變）組合起來，就得到「**多個擁有者，且每個都能改**」的資料——這是單執行緒下處理共享可變狀態的經典組合。

```rust
use std::rc::Rc;
use std::cell::RefCell;

fn main() {
    // 多個變數共享同一份、且可變的資料
    let shared = Rc::new(RefCell::new(vec![1, 2, 3]));

    let clone1 = Rc::clone(&shared);
    let clone2 = Rc::clone(&shared);

    clone1.borrow_mut().push(4);       // 透過 clone1 改
    clone2.borrow_mut().push(5);       // 透過 clone2 改

    // 三個變數看到的是同一份資料
    println!("{:?}", shared.borrow()); // [1, 2, 3, 4, 5]
}
```

拆解 `Rc<RefCell<T>>`：

- 外層 `Rc`：允許 `shared`、`clone1`、`clone2` **共同擁有**同一份資料。
- 內層 `RefCell`：允許透過任一個擁有者**修改**資料。

這在實作樹/圖、觀察者模式、共享快取等結構時很常見。

> **給初學者的提醒**：`Rc<RefCell<T>>` 很強大但也容易被濫用。看到自己到處用它時，先想「是不是所有權設計可以更簡單」。它是「單一擁有者真的不夠用」時的解法，不是逃避所有權設計的捷徑。另外，`Rc` 的循環參考（A 指 B、B 指 A）會造成記憶體洩漏，需要用 `Weak<T>` 打破循環——這是進階主題，先知道有這回事即可。

---

## 7.7 Arc<T> 與 Mutex<T>：多執行緒的共享可變

前面 `Rc` 和 `RefCell` 都**只能單執行緒**。要在多執行緒間共享可變狀態，用它們的執行緒安全版本：

| 單執行緒 | 多執行緒 | 作用 |
|---------|---------|------|
| `Rc<T>` | **`Arc<T>`** | 多重擁有（Arc = Atomically Reference Counted，計數用原子操作，執行緒安全） |
| `RefCell<T>` | **`Mutex<T>`**（或 `RwLock<T>`） | 內部可變 + 執行緒間互斥存取 |

所以單執行緒的 `Rc<RefCell<T>>`，在多執行緒就對應到 **`Arc<Mutex<T>>`**：

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    // 多執行緒共享一個計數器
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for _ in 0..10 {
        let counter = Arc::clone(&counter);     // 每個執行緒拿一份 Arc（計數 +1）
        let handle = thread::spawn(move || {    // move 把 counter 搬進執行緒（第 05 章）
            let mut num = counter.lock().unwrap();  // 上鎖，取得可變存取
            *num += 1;
        });                                     // 鎖在這裡自動釋放（num drop）
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();                 // 等所有執行緒跑完
    }

    println!("最終計數：{}", *counter.lock().unwrap());   // 10
}
```

拆解：

- **`Arc`**：讓 10 個執行緒能共同擁有同一個計數器。為什麼不用 `Rc`？因為 `Rc` 的計數器在多執行緒下會出錯（資料競爭）；`Arc` 用原子操作，安全。
- **`Mutex`（互斥鎖）**：`lock()` 取得鎖後才能存取內部資料，同時只有一個執行緒能持有鎖。用完（變數離開作用域）自動解鎖。這保證「同時只有一個執行緒在改」。
- **`lock()` 回傳 `Result`**：因為持鎖的執行緒若 panic，鎖會「中毒（poisoned）」，所以要處理（這裡簡單 `unwrap`）。

> **這裡藏著 Rust 併發的核心優勢**：如果你少寫了 `Mutex`、想直接在多執行緒改一個共享變數，**Rust 會直接編譯錯誤**——因為那違反第 02 章的借用規則（多個可變存取）。編譯器逼你用 `Arc<Mutex<T>>` 這種安全結構。這就是 Rust 敢說「無懼併發（fearless concurrency）」的底氣，第 08 章會完整展開。

> **`Mutex` vs `RwLock`**：`Mutex` 不管讀寫都獨佔；`RwLock` 允許「多讀或一寫」（讀多寫少時效能更好）。概念上 `RwLock` 更貼近第 02 章的借用規則。

---

## 7.8 怎麼選？一張決策表

| 你的需求 | 用什麼 |
|---------|--------|
| 只是想把資料放 heap / 遞迴型別 / trait 物件 | `Box<T>` |
| 單執行緒，多個地方要共享（唯讀） | `Rc<T>` |
| 單執行緒，只拿到 `&` 卻要改 | `RefCell<T>` |
| 單執行緒，共享 + 可變 | `Rc<RefCell<T>>` |
| 多執行緒，多個地方共享 | `Arc<T>` |
| 多執行緒，共享 + 可變 | `Arc<Mutex<T>>` 或 `Arc<RwLock<T>>` |

> **心智模型總整理**：`Box` = 一個擁有者，放 heap；`Rc`/`Arc` = 多個擁有者共享；`RefCell`/`Mutex` = 在共享時還能安全地改。單執行緒用 `Rc`/`RefCell`，跨執行緒就換成 `Arc`/`Mutex`——它們是一組對應關係。

---

## 7.9 常見錯誤

- **在多執行緒用 `Rc`** → 編譯錯誤「`Rc` cannot be sent between threads safely」。換 `Arc`。
- **`RefCell` 同時 `borrow_mut` 兩次** → 執行期 panic「already borrowed」。縮小借用範圍或重新設計。
- **忘了 `Mutex` 用完會自動解鎖，卻手動持有太久** → 其他執行緒卡住。讓 `lock()` 的結果盡快離開作用域。
- **`Rc` 循環參考** → 記憶體洩漏（計數永遠不歸零）。用 `Weak<T>` 打破循環。
- **濫用 `Rc<RefCell<T>>` 逃避所有權設計** → 程式難懂、執行期 panic 風險。先想有沒有更單純的所有權結構。
- **以為 `RefCell`/`Mutex` 讓外層變數要 `mut`** → 不用。內部可變性的重點就是「外面不可變，裡面仍可改」。

---

## 7.10 本章小結

- **智慧指標**是「行為像指標、但擁有資料並自動清理」的型別，靠 `Deref`（像指標般存取）與 `Drop`（自動清理）運作；`String`/`Vec` 就是。
- **`Box<T>`**：把資料放 heap；用於遞迴型別（把無限大小變成固定指標）與 trait 物件（`Box<dyn Trait>`，動態分派）。
- **`Rc<T>`**：單執行緒多重擁有，`Rc::clone` 只加計數不複製；計數歸零才釋放。只給唯讀共享。
- **`RefCell<T>`**：內部可變性——把借用檢查從編譯期移到**執行期**（違規則 panic），讓你在只有 `&` 時也能改。
- **`Rc<RefCell<T>>`**：單執行緒「共享且可變」的經典組合。
- **`Arc<T>` + `Mutex<T>`**：多執行緒版本，對應 `Rc<RefCell<T>>`；Rust 用借用規則 + 這些型別達成「無懼併發」。

---

## 7.11 動手作業

1. 用 `Box` 定義一個遞迴的整數鏈結串列 `List`，建立 `1 -> 2 -> 3 -> Nil`，寫一個函式遞迴印出所有值。
2. 定義 trait `Speak`，讓 `Dog`、`Cat` 實作，建立 `Vec<Box<dyn Speak>>` 裝兩者並各自呼叫。
3. 用 `Rc` 建立一份共享字串，clone 出三個擁有者，印出每一步的 `Rc::strong_count`。
4. 用 `Rc<RefCell<Vec<i32>>>` 讓兩個變數共享一個 vector，各自 push 一個值，最後印出結果確認是同一份。
5. 用 `Arc<Mutex<i32>>` 開 5 個執行緒，每個把計數 +1，join 後印出最終值（應為 5）。
6. 故意在多執行緒場景用 `Rc` 取代 `Arc`，讀懂那段編譯錯誤，再換回 `Arc` 修好。

---

## 7.12 驗收清單

- [ ] 我能說明智慧指標是什麼，以及 `Deref`/`Drop` 的角色。
- [ ] 我知道 `Box` 用在 heap、遞迴型別與 trait 物件，也懂靜態 vs 動態分派。
- [ ] 我理解 `Rc` 的參考計數機制，以及它只能唯讀、只能單執行緒。
- [ ] 我理解內部可變性，以及 `RefCell` 把借用檢查移到執行期的取捨。
- [ ] 我會用 `Rc<RefCell<T>>` 處理單執行緒的共享可變。
- [ ] 我知道多執行緒要換成 `Arc<Mutex<T>>`，並理解它跟借用規則的關係。

---

下一章 [08-concurrency-and-async-tokio.md](./08-concurrency-and-async-tokio.md) 是進階能力篇的重頭戲：併發與非同步。我們會先講 OS 執行緒與「無懼併發」，再進到 `async`/`await` 與 **Tokio** runtime——這是寫高效能後端服務（第 11 章的 web server 就跑在上面）的必備基礎。本章的 `Arc<Mutex<T>>` 會直接派上用場。
