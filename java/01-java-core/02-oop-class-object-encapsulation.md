# 第 02 章：類別、物件與封裝

> 很多人「會 Java 語法」但寫出來的還是程序式程式：一個 `main`、幾百行、一堆 `static` 方法互相呼叫。
> 這章的目標是讓你能回答一個實務問題：**這段邏輯應該放在哪個類別裡？**
> 答不出來，Spring Boot 的分層架構就只是抄目錄結構；答得出來，你自然會寫出可測、可改的程式。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 把一段程序式程式碼重構成合理的類別設計，並說出「為什麼這個方法屬於這個類別」。
- 正確使用建構子、`this`、多個建構子的委派。
- 說明四種存取修飾子的可見範圍，並知道欄位為什麼要 `private`。
- 解釋為什麼「每個欄位都給 getter/setter」是反模式，該怎麼改。
- 說明 `static` 的意義、初始化時機，以及**它為什麼會讓程式無法測試**。
- 說出物件的初始化順序（靜態 → 實例 → 建構子）。
- 設計**不可變物件**，並知道什麼時候需要防禦性拷貝。
- 用 Builder 解決「建構子參數太多」的問題。
- 完成練習專案第一版：`Todo` 與 `TodoList`。

---

## 2.2 從一團 `main` 到物件：一次真實的重構

先看一段「能跑但沒人想維護」的程式。這是待辦清單的第一版：

```java
import java.util.ArrayList;
import java.util.List;

public class TodoAppV0 {

    public static void main(String[] args) {
        // 用三個平行的 List 表示「同一批待辦」
        List<String> titles = new ArrayList<>();
        List<Boolean> dones = new ArrayList<>();
        List<Integer> priorities = new ArrayList<>();

        titles.add("寫第 02 章"); dones.add(false); priorities.add(1);
        titles.add("買咖啡");     dones.add(true);  priorities.add(3);
        titles.add("Code review"); dones.add(false); priorities.add(2);

        // 標記第 0 筆完成
        dones.set(0, true);

        // 印出未完成的
        for (int i = 0; i < titles.size(); i++) {
            if (!dones.get(i)) {
                System.out.println("[ ] " + titles.get(i) + " (P" + priorities.get(i) + ")");
            }
        }
    }
}
```

**這段程式的問題不是「不夠物件導向」，而是它會出事：**

| 問題 | 後果 |
|---|---|
| 三個 List 必須永遠等長、順序一致 | 任何一處忘記同步 `add`，資料就永久錯位 |
| `priorities.add(1)` 的 `1` 是什麼？ | 沒有型別約束，`add(99)` 也能過 |
| 「標記完成」的邏輯散在呼叫端 | 十個地方要標記完成，就有十份 `dones.set(i, true)` |
| 想加「完成時間」欄位 | 要再開第四個 List，並修改所有迴圈 |
| 無法測試 | 邏輯全在 `main` 裡，沒有能單獨呼叫的東西 |

### 重構第一步：把「一筆待辦」變成一個型別

```java
public class Todo {
    private String title;
    private boolean done;
    private int priority;
}
```

一句話說完為什麼要這樣做：**原本靠「陣列索引」維持的關聯，現在由型別保證。** 標題和它的完成狀態再也不可能對不上。

### 重構第二步：把「操作待辦」的邏輯搬進去

```java
public class Todo {
    private String title;
    private boolean done;
    private int priority;

    public void markDone() {
        this.done = true;
    }
}
```

**判斷標準（本章最重要的一句話）：**

> 一個方法如果**主要在操作某個類別的資料**，它就應該放在那個類別裡。

`markDone()` 只動 `done` 這個欄位 → 屬於 `Todo`。
「列出所有未完成的待辦」要走過一整個集合 → 屬於 `TodoList`，不屬於單一 `Todo`。
「把待辦存到檔案」牽涉 IO、跟待辦的資料規則無關 → 屬於另一個類別（第 03 章會抽成介面）。

這個判斷標準，就是後面 Controller / Service / Repository 三層分工的原始版本。

---

## 2.3 類別與物件

**類別是模板，物件是依模板建立的實體。**

```java
public class Todo {
    // ① 實例欄位（instance field）：每個物件各有一份
    private String title;
    private boolean done;

    // ② 方法
    public void markDone() {
        this.done = true;
    }

    public boolean isDone() {
        return this.done;
    }
}
```

```java
public class Main {
    public static void main(String[] args) {
        Todo a = new Todo();      // 建立第一個物件
        Todo b = new Todo();      // 建立第二個物件，欄位完全獨立

        a.markDone();

        System.out.println(a.isDone());   // true
        System.out.println(b.isDone());   // false  ← 不受 a 影響
    }
}
```

### `new` 到底做了什麼

```
Todo a = new Todo();
              │
              ├─ ① 在「堆積（heap）」配置記憶體
              ├─ ② 欄位設為預設值（物件 null、int 0、boolean false）
              ├─ ③ 執行實例初始化（欄位初始值、初始化區塊）
              ├─ ④ 執行建構子本體
              └─ ⑤ 回傳物件的「參考」
   │
   └─ 變數 a 存在「堆疊（stack）」上，內容是那個參考
```

```java
Todo a = new Todo();
Todo c = a;              // c 和 a 指向「同一個物件」，不是拷貝
c.markDone();
System.out.println(a.isDone());   // true  ← 透過 c 改的，a 也看到了
```

這正是第 01 章 1.14 節「值傳遞」的另一面：拷貝的是參考，不是物件。
第 09 章講 GC 時會回到這張圖：物件在堆積、變數在堆疊、沒有任何參考指向的物件才會被回收。

---

## 2.4 建構子

建構子負責**保證物件一出生就處於合法狀態**。

```java
public class Todo {
    private String title;
    private boolean done;
    private int priority;

    // 建構子：沒有回傳型別，名稱與類別完全相同
    public Todo(String title, int priority) {
        this.title = title;
        this.priority = priority;
        this.done = false;
    }
}
```

```java
Todo t = new Todo("寫第 02 章", 1);
// Todo t2 = new Todo();     // ❌ 編譯錯誤！
```

### 預設建構子的規則（考題也常出）

- 你**沒寫任何建構子** → 編譯器自動加一個 `public Todo() {}`（第 00 章我們用 `javap` 看過）。
- 你**寫了任何建構子** → 編譯器就**不再**提供無參數建構子。

```java
public class NoDefault {
    private int value;

    public NoDefault(int value) {
        this.value = value;
    }
    // new NoDefault() 現在是編譯錯誤
}
```

> **實務踩雷**：JPA Entity、Jackson 反序列化、部分框架都需要無參數建構子（用反射建立物件）。
> 所以你會在 Entity 上看到 `protected Todo() {}` 這種「只給框架用」的建構子。第 08 站會詳細講。

### 建構子重載與 `this(...)` 委派

```java
public class Todo {
    private String title;
    private boolean done;
    private int priority;

    // 主建構子：所有驗證只寫在這一個地方
    public Todo(String title, int priority, boolean done) {
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("標題不可為空");
        }
        if (priority < 1 || priority > 5) {
            throw new IllegalArgumentException("優先度需在 1~5，收到: " + priority);
        }
        this.title = title.strip();
        this.priority = priority;
        this.done = done;
    }

    // 便利建構子：委派給主建構子，不重複驗證邏輯
    public Todo(String title, int priority) {
        this(title, priority, false);
    }

    public Todo(String title) {
        this(title, 3);          // 預設優先度 3
    }

    public String getTitle() { return title; }
    public int getPriority() { return priority; }
    public boolean isDone() { return done; }

    public static void main(String[] args) {
        System.out.println(new Todo("買咖啡").getPriority());          // 3
        System.out.println(new Todo("寫程式", 1).getPriority());       // 1

        try {
            new Todo("  ");
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());                       // 標題不可為空
        }
        try {
            new Todo("x", 99);
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());                       // 優先度需在 1~5，收到: 99
        }
    }
}
```

**`this(...)` 的規則：**

1. 必須是建構子的**第一行**。
2. 一個建構子只能呼叫一次 `this(...)`（不能同時呼叫 `super(...)`）。

> **實務價值**：驗證邏輯集中在**一個**建構子。如果每個建構子各自驗證，總有一天有人新增建構子忘記驗證，
> 就出現「有些路徑建出來的物件是非法的」——這種 bug 極難追。

### `this` 的三種用途

```java
public class ThisDemo {
    private String name;

    public ThisDemo(String name) {
        this.name = name;                 // ① 區分欄位與同名參數
    }

    public ThisDemo() {
        this("unnamed");                  // ② 呼叫其他建構子
    }

    public ThisDemo withUpperName() {
        this.name = this.name.toUpperCase();
        return this;                      // ③ 回傳自己，支援方法鏈
    }

    @Override
    public String toString() { return "ThisDemo{" + name + "}"; }

    public static void main(String[] args) {
        System.out.println(new ThisDemo("abc").withUpperName());   // ThisDemo{ABC}
        System.out.println(new ThisDemo());                        // ThisDemo{unnamed}
    }
}
```

用途 ① 常被省略（欄位與參數不同名時可以不寫 `this.`），但**建構子與 setter 裡建議一律寫 `this.`**，
因為那裡的參數名通常刻意與欄位同名，漏寫 `this.` 會變成「參數指派給自己」——編譯器不會報錯：

```java
public void setName(String name) {
    name = name;          // ❌ 靜默無效！欄位完全沒被改到
}

public void setName(String name) {
    this.name = name;     // ✅
}
```

---

## 2.5 封裝與存取修飾子

### 四種可見範圍

| 修飾子 | 同類別 | 同 package | 子類別（不同 package） | 任何地方 |
|---|---|---|---|---|
| `private` | ✅ | ❌ | ❌ | ❌ |
| （不寫，package-private） | ✅ | ✅ | ❌ | ❌ |
| `protected` | ✅ | ✅ | ✅ | ❌ |
| `public` | ✅ | ✅ | ✅ | ✅ |

```java
package com.example.todo;

public class AccessDemo {
    private   int secret = 1;      // 只有這個類別
              int packageLevel = 2; // 同 package（測試常用）
    protected int forSubclass = 3;  // 子類別 + 同 package
    public    int open = 4;         // 全開
}
```

### 為什麼欄位一定要 `private`

```java
// ❌ 欄位公開 → 任何人可以放進任何值，類別無法保護自己
public class BadTodo {
    public String title;
    public int priority;
}
```

```java
BadTodo t = new BadTodo();
t.title = null;          // 之後每次 t.title.length() 都 NPE
t.priority = -999;       // 排序邏輯直接壞掉
```

```java
// ✅ 封裝：所有改動都要經過類別的檢查
public class GoodTodo {
    private String title;
    private int priority;

    public GoodTodo(String title, int priority) {
        setTitle(title);
        setPriority(priority);
    }

    public String getTitle() { return title; }

    public void setTitle(String title) {
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("標題不可為空");
        }
        this.title = title.strip();
    }

    public int getPriority() { return priority; }

    public void setPriority(int priority) {
        if (priority < 1 || priority > 5) {
            throw new IllegalArgumentException("優先度需在 1~5，收到: " + priority);
        }
        this.priority = priority;
    }
}
```

**封裝的真正價值：把「不變條件（invariant）」的檢查收在一個地方。**
「標題不可為空」這條規則只寫一次，不管誰、從哪裡、什麼時候改標題，都逃不掉。

### `package-private` 的實務用途

不寫修飾子的成員在同 package 可見。因為 Maven 的測試目錄與產品目錄**共用同一組 package**，
所以測試可以看到 package-private 的成員：

```
src/main/java/com/example/todo/TodoList.java     ← package com.example.todo
src/test/java/com/example/todo/TodoListTest.java ← 同一個 package！
```

```java
package com.example.todo;

public class PriceCalculator {

    public long finalPriceInCents(long listPrice, String memberLevel) {
        return applyDiscount(listPrice, discountPercent(memberLevel));
    }

    // 不是 public API，但想單獨測試 → package-private
    long applyDiscount(long listPrice, int percent) {
        return listPrice * (100 - percent) / 100;
    }

    int discountPercent(String memberLevel) {
        return switch (memberLevel) {
            case "GOLD" -> 20;
            case "SILVER" -> 10;
            default -> 0;
        };
    }
}
```

> **不要為了測試把方法改成 `public`。** 用 package-private 表達「這是內部細節，但測試可以碰」。
> 第 11 章會討論「該不該測私有方法」（簡答：通常透過公開方法測，但複雜的計算邏輯值得單獨測）。

---

## 2.6 getter / setter：不要無腦全開

IDE 一鍵產生 getter/setter 很方便，也因此產生了大量**貧血模型（anemic model）**：類別只有資料、沒有行為，
所有邏輯散落在各個 Service 裡。

### 反模式：什麼都能改

```java
// ❌ 這個類別無法保護任何規則
public class Order {
    private String id;
    private String status;
    private long totalCents;
    private LocalDateTime paidAt;

    // 20 個 getter + 20 個 setter …
    public void setStatus(String status) { this.status = status; }
    public void setPaidAt(LocalDateTime paidAt) { this.paidAt = paidAt; }
    public void setTotalCents(long totalCents) { this.totalCents = totalCents; }
}
```

於是 Service 裡就出現這種東西：

```java
// ❌ 商業規則散落在呼叫端，五個地方都要記得寫這三行
order.setStatus("PAID");
order.setPaidAt(LocalDateTime.now());
paymentLog.record(order);
```

有人漏寫 `setPaidAt`，就出現「已付款但沒有付款時間」的資料。有人寫 `setStatus("PIAD")` 拼錯，
編譯器完全不管。

### 正確做法：用「行為方法」取代 setter

```java
import java.time.LocalDateTime;

public class Order {

    public enum Status { CREATED, PAID, SHIPPED, CANCELLED }

    private final String id;
    private Status status;
    private final long totalCents;
    private LocalDateTime paidAt;

    public Order(String id, long totalCents) {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("訂單編號不可為空");
        }
        if (totalCents <= 0) {
            throw new IllegalArgumentException("金額必須大於 0，收到: " + totalCents);
        }
        this.id = id;
        this.totalCents = totalCents;
        this.status = Status.CREATED;
    }

    /** 付款：規則、狀態、時間戳一次搞定，呼叫端不可能寫錯 */
    public void pay(LocalDateTime when) {
        if (status != Status.CREATED) {
            throw new IllegalStateException(
                    "只有 CREATED 的訂單可以付款，目前狀態: " + status);
        }
        this.status = Status.PAID;
        this.paidAt = when;
    }

    public void cancel() {
        if (status == Status.SHIPPED) {
            throw new IllegalStateException("已出貨的訂單不可取消");
        }
        this.status = Status.CANCELLED;
    }

    // 只提供「讀」，不提供「亂改」
    public String getId() { return id; }
    public Status getStatus() { return status; }
    public long getTotalCents() { return totalCents; }
    public LocalDateTime getPaidAt() { return paidAt; }

    public boolean isPayable() { return status == Status.CREATED; }

    public static void main(String[] args) {
        Order order = new Order("ORD-1001", 29900);
        System.out.println(order.getStatus());        // CREATED
        System.out.println(order.isPayable());        // true

        order.pay(LocalDateTime.of(2026, 8, 17, 10, 30));
        System.out.println(order.getStatus());        // PAID
        System.out.println(order.getPaidAt());        // 2026-08-17T10:30

        try {
            order.pay(LocalDateTime.now());           // 重複付款
        } catch (IllegalStateException e) {
            System.out.println(e.getMessage());
            // 只有 CREATED 的訂單可以付款，目前狀態: PAID
        }
    }
}
```

**設計原則（實務上很值得記住）：**

| | 該不該加 |
|---|---|
| getter | 需要讀就加，但不必每個欄位都給。內部計算用的欄位不用暴露 |
| setter | **預設不要加**。想改狀態時，先問「這個改動代表什麼業務動作？」，然後寫成那個動作的方法 |
| 建構子 | 必填欄位放建構子，讓「非法物件建不出來」 |

> **注意 `pay(LocalDateTime when)` 這個簽章**：時間從外面傳進來，而不是在方法裡呼叫 `LocalDateTime.now()`。
> 這樣測試才能固定時間、驗證行為。第 07 章講 `Clock`、第 11 章講可測性時會再深入。

---

## 2.7 `static`：屬於類別，不屬於物件

```java
public class StaticDemo {

    private static int instanceCount = 0;     // 靜態欄位：全類別共用一份
    private final int id;

    public StaticDemo() {
        instanceCount++;                       // 每次建立就加一
        this.id = instanceCount;
    }

    public static int getInstanceCount() {     // 靜態方法：用類別名稱呼叫
        return instanceCount;
    }

    public int getId() { return id; }

    public static void main(String[] args) {
        new StaticDemo();
        new StaticDemo();
        StaticDemo third = new StaticDemo();

        System.out.println(StaticDemo.getInstanceCount());   // 3
        System.out.println(third.getId());                    // 3
    }
}
```

### `static` 方法不能碰實例成員

```java
public class StaticRules {
    private int instanceField = 1;
    private static int staticField = 2;

    public static void staticMethod() {
        System.out.println(staticField);     // ✅
        // System.out.println(instanceField); // ❌ 編譯錯誤：沒有物件，不知道要讀誰的
        // this.doSomething();                // ❌ static 方法裡沒有 this
    }

    public void instanceMethod() {
        System.out.println(instanceField);   // ✅
        System.out.println(staticField);     // ✅ 實例方法可以讀靜態成員
    }
}
```

### `static` 的合理用途

```java
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.regex.Pattern;

public final class MoneyUtils {

    // ① 常數：static final，命名全大寫
    public static final BigDecimal TAX_RATE = new BigDecimal("0.05");
    public static final int SCALE = 2;

    // ② 編譯一次就重用的重物件（Pattern 編譯很貴，不要每次呼叫都建）
    private static final Pattern AMOUNT_PATTERN = Pattern.compile("^\\d+(\\.\\d{1,2})?$");

    // ③ 工具類別不該被實例化
    private MoneyUtils() {
        throw new AssertionError("工具類別不可實例化");
    }

    // ④ 純函式：輸入決定輸出，不依賴任何狀態
    public static BigDecimal withTax(BigDecimal amount) {
        return amount.multiply(BigDecimal.ONE.add(TAX_RATE))
                     .setScale(SCALE, RoundingMode.HALF_UP);
    }

    public static boolean isValidAmount(String input) {
        return input != null && AMOUNT_PATTERN.matcher(input).matches();
    }

    public static void main(String[] args) {
        System.out.println(withTax(new BigDecimal("100")));    // 105.00
        System.out.println(isValidAmount("99.99"));            // true
        System.out.println(isValidAmount("99.999"));           // false
        System.out.println(isValidAmount("abc"));              // false
    }
}
```

也常見於**靜態工廠方法**，語意比建構子清楚：

```java
public class Duration2 {
    private final long millis;

    private Duration2(long millis) { this.millis = millis; }

    // 名稱本身就說明了單位，比 new Duration2(5000) 清楚
    public static Duration2 ofSeconds(long s) { return new Duration2(s * 1000); }
    public static Duration2 ofMinutes(long m) { return new Duration2(m * 60_000); }

    public long toMillis() { return millis; }

    public static void main(String[] args) {
        System.out.println(Duration2.ofMinutes(2).toMillis());   // 120000
    }
}
```

JDK 裡到處是這種寫法：`List.of()`、`Optional.of()`、`Integer.valueOf()`、`LocalDate.of()`。

### ⚠️ `static` 為什麼會毀掉你的可測性

這是實務上最重要的 `static` 議題。

```java
// ❌ 靜態方法直呼資料庫
public class OrderService {
    public void ship(String orderId) {
        Order order = OrderRepository.findById(orderId);     // static！
        order.markShipped();
        OrderRepository.save(order);                          // static！
        EmailSender.send(order.getEmail(), "已出貨");          // static！
    }
}
```

想測 `ship()`，你會發現：

- 沒辦法換掉 `OrderRepository` → **測試一定會連真的資料庫**。
- 沒辦法換掉 `EmailSender` → **測試會真的寄信給客戶**。
- 沒有任何地方可以「插入假的實作」，因為 `static` 呼叫在編譯期就綁死了。

```java
// ✅ 依賴注入：把協作物件當成建構子參數傳進來
public class OrderService {

    private final OrderRepository repository;
    private final EmailSender emailSender;

    public OrderService(OrderRepository repository, EmailSender emailSender) {
        this.repository = repository;
        this.emailSender = emailSender;
    }

    public void ship(String orderId) {
        Order order = repository.findById(orderId);
        order.markShipped();
        repository.save(order);
        emailSender.send(order.getEmail(), "已出貨");
    }
}
```

測試時傳入假的 `repository` 與 `emailSender` 就好。

> **這就是 Spring 的 DI（依賴注入）在解決的問題。**
> 第 02 站你會看到 `@Service` + 建構子注入——它做的事情，就是上面這段程式碼的自動化版本。
> 現在先記住判斷法則：

| 情況 | 用 `static` 嗎 |
|---|---|
| 純函式：只依賴參數，沒有 IO、沒有狀態（`Math.max`、格式化、驗證） | ✅ 可以 |
| 常數 | ✅ `static final` |
| 有狀態、有 IO、要連外部系統（DB / HTTP / 檔案 / 寄信） | ❌ 用實例 + 注入 |
| 可變的靜態欄位（`static Map cache = ...`） | ❌ 執行緒安全與記憶體洩漏的常客（第 08、09 章） |

---

## 2.8 初始化順序

這一節在面試常考，而在實務上是「為什麼我的欄位在建構子裡是 null」的答案。

```java
public class InitOrder {

    static { System.out.println("2. 靜態初始化區塊"); }

    private static final String STATIC_FIELD = init("1. 靜態欄位");

    { System.out.println("4. 實例初始化區塊"); }

    private final String instanceField = init("3. 實例欄位");

    public InitOrder() {
        System.out.println("5. 建構子本體");
    }

    private static String init(String label) {
        System.out.println(label);
        return label;
    }

    public static void main(String[] args) {
        System.out.println("--- main 開始 ---");
        new InitOrder();
        System.out.println("--- 第二個物件 ---");
        new InitOrder();
    }
}
```

輸出：

```
1. 靜態欄位
2. 靜態初始化區塊
--- main 開始 ---
3. 實例欄位
4. 實例初始化區塊
5. 建構子本體
--- 第二個物件 ---
3. 實例欄位
4. 實例初始化區塊
5. 建構子本體
```

**規則：**

1. **靜態的**（欄位 + `static {}`）在**類別載入時執行一次**，依原始碼順序。
2. **實例的**（欄位 + `{}`）在**每次 `new` 時執行**，依原始碼順序，且**在建構子本體之前**。
3. 有繼承時，父類別的初始化先於子類別（第 03 章）。

注意上面輸出：靜態區塊在 `main` **之前**就跑了，因為 JVM 要先載入 `InitOrder` 才能執行它的 `main`。

### 實務案例：靜態區塊初始化失敗，錯誤訊息很難懂

```java
public class BadStaticInit {

    private static final java.util.Map<String, String> CONFIG = loadConfig();

    private static java.util.Map<String, String> loadConfig() {
        throw new IllegalStateException("找不到設定檔");    // 假設讀檔失敗
    }

    public static void main(String[] args) {
        System.out.println(CONFIG);
    }
}
```

```
Exception in thread "main" java.lang.ExceptionInInitializerError
Caused by: java.lang.IllegalStateException: 找不到設定檔
```

`ExceptionInInitializerError` 就代表「靜態初始化階段炸了」。更麻煩的是，**第二次**存取這個類別會得到
`NoClassDefFoundError`（類別被標記為錯誤狀態），完全看不出原因。

> **實務建議**：**不要在靜態初始化裡做可能失敗的事**（讀檔、連 DB、呼叫網路）。
> 把它移到明確呼叫的初始化方法，或交給框架的生命週期（Spring 的 `@PostConstruct`）。

---

## 2.9 不可變物件：實務上最被低估的設計

**不可變（immutable）** = 物件建立後狀態永遠不變。

```java
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Objects;

public final class Money {                      // ① final：不能被繼承（否則子類別可能加上可變狀態）

    private final BigDecimal amount;            // ② 所有欄位 final
    private final String currency;

    private Money(BigDecimal amount, String currency) {
        this.amount = amount;
        this.currency = currency;
    }

    public static Money of(String amount, String currency) {
        Objects.requireNonNull(amount, "amount 不可為 null");
        Objects.requireNonNull(currency, "currency 不可為 null");
        return new Money(new BigDecimal(amount).setScale(2, RoundingMode.HALF_UP),
                         currency.toUpperCase());
    }

    // ③ 「修改」一律回傳新物件
    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(this.amount.add(other.amount), this.currency);
    }

    public Money minus(Money other) {
        requireSameCurrency(other);
        return new Money(this.amount.subtract(other.amount), this.currency);
    }

    public Money times(int factor) {
        return new Money(this.amount.multiply(BigDecimal.valueOf(factor)), this.currency);
    }

    private void requireSameCurrency(Money other) {
        if (!this.currency.equals(other.currency)) {
            throw new IllegalArgumentException(
                    "幣別不同不可運算: %s vs %s".formatted(this.currency, other.currency));
        }
    }

    public BigDecimal getAmount() { return amount; }   // BigDecimal 本身不可變，直接回傳安全
    public String getCurrency() { return currency; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Money other)) return false;
        // 金額比較用 compareTo（第 01 章 1.5 節）
        return currency.equals(other.currency) && amount.compareTo(other.amount) == 0;
    }

    @Override
    public int hashCode() {
        return Objects.hash(amount.stripTrailingZeros(), currency);
    }

    @Override
    public String toString() {
        return amount + " " + currency;
    }

    public static void main(String[] args) {
        Money a = Money.of("100.00", "TWD");
        Money b = Money.of("50.50", "TWD");

        System.out.println(a.plus(b));            // 150.50 TWD
        System.out.println(a);                    // 100.00 TWD  ← a 完全沒被改到
        System.out.println(a.times(3));           // 300.00 TWD

        try {
            a.plus(Money.of("10", "USD"));
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());   // 幣別不同不可運算: TWD vs USD
        }
    }
}
```

### 不可變帶來什麼好處

| 好處 | 實務意義 |
|---|---|
| 天生執行緒安全 | 多執行緒共用不需要鎖（第 08 章） |
| 可以安全當 `Map` key / `Set` 元素 | hash 不會變，不會「放進去卻找不到」（第 05 章） |
| 沒有「被別人偷改」的可能 | 傳給第三方函式庫也安心 |
| 除錯容易 | 值不會變，就不用追「誰在什麼時候改了它」 |
| 可以放心快取、共用 | `BigDecimal.ZERO`、`String` 常量池都靠這個 |

### 防禦性拷貝：`final` 不等於不可變

這是很多人第一次會漏掉的：

```java
import java.util.ArrayList;
import java.util.List;

public final class BrokenImmutableTodoList {

    private final List<String> items;         // final 只保證「參考不變」

    public BrokenImmutableTodoList(List<String> items) {
        this.items = items;                   // ❌ 直接存外部傳進來的 List
    }

    public List<String> getItems() {
        return items;                          // ❌ 直接把內部 List 交出去
    }

    public static void main(String[] args) {
        List<String> source = new ArrayList<>();
        source.add("A");

        BrokenImmutableTodoList list = new BrokenImmutableTodoList(source);

        // 漏洞 1：從外部改
        source.add("B");
        System.out.println(list.getItems());        // [A, B]  ← 內部狀態被外面改了！

        // 漏洞 2：從 getter 改
        list.getItems().clear();
        System.out.println(list.getItems());        // []      ← 被清空了！
    }
}
```

**修正：進來時拷貝、出去時包成唯讀。**

```java
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

public final class SafeTodoList {

    private final List<String> items;

    public SafeTodoList(List<String> items) {
        Objects.requireNonNull(items, "items 不可為 null");
        this.items = List.copyOf(items);          // ✅ 進來時拷貝成不可變 List（Java 10+）
    }

    public List<String> getItems() {
        return items;                              // ✅ 本身已是不可變，直接回傳安全
    }

    /** 「新增」回傳新物件，維持不可變 */
    public SafeTodoList with(String item) {
        List<String> copy = new ArrayList<>(items);
        copy.add(item);
        return new SafeTodoList(copy);
    }

    public static void main(String[] args) {
        List<String> source = new ArrayList<>();
        source.add("A");

        SafeTodoList list = new SafeTodoList(source);

        source.add("B");
        System.out.println(list.getItems());        // [A]     ✅ 不受影響

        try {
            list.getItems().add("C");
        } catch (UnsupportedOperationException e) {
            System.out.println("唯讀，不能改");      // ✅ 擋下來了
        }

        System.out.println(list.with("C").getItems());   // [A, C]
        System.out.println(list.getItems());             // [A]  ← 原物件不變
    }
}
```

> **`List.copyOf` vs `Collections.unmodifiableList`**：
> `List.copyOf` 建立**新的**不可變 List（真拷貝，安全）。
> `Collections.unmodifiableList(x)` 只是**唯讀的視圖**——別人改 `x`，視圖跟著變。
> 存進欄位時用 `List.copyOf`。第 05 章會再細講。

> **可變欄位也要拷貝**：如果欄位是 `Date`、陣列、或你自己的可變類別，一樣要在建構子和 getter 拷貝。
> 這也是為什麼第 07 章要你用 `java.time`（`LocalDate`、`Instant` 全都不可變）而不是老舊的 `java.util.Date`。

### 什麼時候不要追求不可變

- 大集合的頻繁更新（每次都拷貝會很慢）。
- JPA Entity（框架需要能改欄位、需要無參數建構子）。
- 需要「同一個物件被多方共同修改」的場景（如快取）。

**實務常見的分工**：Entity 可變、DTO 與值物件（Money、Address、DateRange）不可變。

---

## 2.10 `toString` / `equals` / `hashCode` 的基本盤

三個方法都繼承自 `Object`，預設實作幾乎都不是你要的。

### `toString`：一定要覆寫

```java
public class NoToString {
    private final String title = "寫程式";

    public static void main(String[] args) {
        System.out.println(new NoToString());
        // NoToString@1b6d3586   ← 類別名 + hashCode 的十六進位，對除錯毫無幫助
    }
}
```

```java
import java.util.List;

public class Todo {
    private final String title;
    private final int priority;
    private boolean done;

    public Todo(String title, int priority) {
        this.title = title;
        this.priority = priority;
    }

    @Override
    public String toString() {
        return "Todo{title='%s', priority=%d, done=%s}".formatted(title, priority, done);
    }

    public static void main(String[] args) {
        Todo t = new Todo("寫第 02 章", 1);
        System.out.println(t);
        // Todo{title='寫第 02 章', priority=1, done=false}

        // 集合會自動呼叫每個元素的 toString
        System.out.println(List.of(t, new Todo("買咖啡", 3)));
        // [Todo{title='寫第 02 章', priority=1, done=false}, Todo{title='買咖啡', priority=3, done=false}]
    }
}
```

> ⚠️ **`toString` 不要印敏感資料**。密碼、身分證、信用卡號、token 都會出現在 log 裡。
> 這是真實的資安事故來源。實務做法是遮罩：

```java
@Override
public String toString() {
    return "User{email='%s', password='***'}".formatted(email);
}
```

### `equals` / `hashCode`：先建立正確觀念

```java
public class EqualsBasics {

    static class Point {
        final int x, y;
        Point(int x, int y) { this.x = x; this.y = y; }
    }

    public static void main(String[] args) {
        Point a = new Point(1, 2);
        Point b = new Point(1, 2);

        System.out.println(a == b);          // false
        System.out.println(a.equals(b));     // false  ← Object 的預設 equals 就是 ==
    }
}
```

正確覆寫的標準模板：

```java
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

public class Point {
    private final int x;
    private final int y;

    public Point(int x, int y) {
        this.x = x;
        this.y = y;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;                       // ① 同一個物件，快速返回
        if (!(o instanceof Point other)) return false;    // ② 型別檢查 + 模式比對綁定（Java 16+）
        return x == other.x && y == other.y;              // ③ 逐欄位比較
    }

    @Override
    public int hashCode() {
        return Objects.hash(x, y);                        // ④ 用相同的欄位算 hash
    }

    @Override
    public String toString() {
        return "Point(%d, %d)".formatted(x, y);
    }

    public static void main(String[] args) {
        Point a = new Point(1, 2);
        Point b = new Point(1, 2);

        System.out.println(a.equals(b));     // true  ✅

        Set<Point> set = new HashSet<>();
        set.add(a);
        System.out.println(set.contains(b));  // true  ✅ 因為 hashCode 也一致
    }
}
```

**鐵律：`equals` 和 `hashCode` 必須一起覆寫，而且用同一組欄位。**
只寫 `equals` 不寫 `hashCode`，物件放進 `HashMap` / `HashSet` 就會「找不到自己剛放進去的東西」。

第 05 章 5.7 節會用實際案例把這個契約講透，並解釋為什麼**可變欄位不該參與 `hashCode`**。

---

## 2.11 建構子參數太多：Builder 模式

實務上一定會遇到這種類別：

```java
// ❌ 誰記得第 5 個參數是什麼？誰知道哪些可以傳 null？
Order order = new Order("ORD-1001", "user@example.com", 29900,
                        "台北市信義區...", "0912345678", null, true, false, "COUPON50");
```

問題：

1. 參數順序記不住，兩個相鄰的 `String` 傳反了編譯器也不會抗議。
2. 可選參數要開一堆建構子重載（伸縮建構子反模式）。
3. 呼叫端看不出每個值的意義。

### Builder 解法

```java
import java.util.Objects;

public final class Order {

    private final String id;              // 必填
    private final String email;           // 必填
    private final long totalCents;        // 必填
    private final String address;         // 選填
    private final String phone;           // 選填
    private final String couponCode;      // 選填
    private final boolean giftWrap;       // 選填，預設 false

    private Order(Builder b) {
        this.id = b.id;
        this.email = b.email;
        this.totalCents = b.totalCents;
        this.address = b.address;
        this.phone = b.phone;
        this.couponCode = b.couponCode;
        this.giftWrap = b.giftWrap;
    }

    /** 必填欄位放在入口方法上，漏了就編譯不過 */
    public static Builder builder(String id, String email, long totalCents) {
        return new Builder(id, email, totalCents);
    }

    public static final class Builder {
        private final String id;
        private final String email;
        private final long totalCents;
        private String address;
        private String phone;
        private String couponCode;
        private boolean giftWrap = false;

        private Builder(String id, String email, long totalCents) {
            this.id = id;
            this.email = email;
            this.totalCents = totalCents;
        }

        public Builder address(String address)       { this.address = address; return this; }
        public Builder phone(String phone)           { this.phone = phone; return this; }
        public Builder couponCode(String couponCode) { this.couponCode = couponCode; return this; }
        public Builder giftWrap(boolean giftWrap)    { this.giftWrap = giftWrap; return this; }

        public Order build() {
            // 所有驗證集中在這裡
            if (id == null || id.isBlank()) {
                throw new IllegalArgumentException("訂單編號不可為空");
            }
            if (email == null || !email.contains("@")) {
                throw new IllegalArgumentException("email 格式錯誤: " + email);
            }
            if (totalCents <= 0) {
                throw new IllegalArgumentException("金額必須大於 0，收到: " + totalCents);
            }
            if (giftWrap && address == null) {
                throw new IllegalArgumentException("選擇禮物包裝時必須提供地址");
            }
            return new Order(this);
        }
    }

    @Override
    public String toString() {
        return "Order{id='%s', email='%s', totalCents=%d, giftWrap=%s, coupon='%s'}"
                .formatted(id, email, totalCents, giftWrap, couponCode);
    }

    public static void main(String[] args) {
        // ✅ 每個值的意義一目了然，順序也不重要
        Order order = Order.builder("ORD-1001", "user@example.com", 29900)
                .address("台北市信義區...")
                .phone("0912345678")
                .couponCode("COUPON50")
                .giftWrap(true)
                .build();
        System.out.println(order);
        // Order{id='ORD-1001', email='user@example.com', totalCents=29900, giftWrap=true, coupon='COUPON50'}

        // 選填的可以全部省略
        System.out.println(Order.builder("ORD-1002", "a@b.com", 100).build());
        // Order{id='ORD-1002', email='a@b.com', totalCents=100, giftWrap=false, coupon='null'}

        // 跨欄位驗證也在 build() 裡把關
        try {
            Order.builder("ORD-1003", "a@b.com", 100).giftWrap(true).build();
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());     // 選擇禮物包裝時必須提供地址
        }
    }
}
```

> **實務補充**：專案裡通常用 **Lombok 的 `@Builder`** 自動產生這段樣板碼。
> 但你要先看得懂手寫版，才知道 Lombok 幫你做了什麼、以及為什麼跨欄位驗證仍需要自己寫。
>
> **什麼時候用 Builder**：參數超過 4～5 個，或有多個同型別的可選參數。
> 參數少（2～3 個）用建構子就好，別過度設計。第 12 章講 `record` 時會給另一種輕量解法。

---

## 2.12 巢狀類別（先建立概念）

```java
public class Outer {

    private int outerField = 1;

    // ① 靜態巢狀類別：跟外層只有「命名空間」關係，最常用
    static class StaticNested {
        void print() {
            System.out.println("靜態巢狀，看不到 outerField");
        }
    }

    // ② 內部類別（非靜態）：持有外層物件的隱含參考
    class Inner {
        void print() {
            System.out.println("內部類別看得到 outerField: " + outerField);
        }
    }

    void useLocalClass() {
        // ③ 區域類別：定義在方法裡
        class Local {
            void print() { System.out.println("區域類別"); }
        }
        new Local().print();
    }

    public static void main(String[] args) {
        new StaticNested().print();

        Outer outer = new Outer();
        Outer.Inner inner = outer.new Inner();     // 注意這個奇怪的語法
        inner.print();

        outer.useLocalClass();

        // ④ 匿名類別：當場實作一個介面（第 03 章、第 06 章會大量出現）
        Runnable task = new Runnable() {
            @Override
            public void run() {
                System.out.println("匿名類別");
            }
        };
        task.run();
    }
}
```

**實務建議：巢狀類別預設加 `static`。**

非靜態內部類別會持有外層物件的參考，兩個後果：

1. 外層物件無法被 GC 回收 → 記憶體洩漏（第 09 章會做一個實例）。
2. 序列化時會意外把整個外層物件一起帶上。

`Map.Entry`、上面的 `Order.Builder` 都是靜態巢狀類別。

---

## 2.13 package 與專案結構

```java
package com.example.todo.model;        // 必須對應目錄 com/example/todo/model/
```

### 命名慣例

```
com.公司名.專案名.模組名
com.example.todo.model
com.example.todo.service
```

反向網域名稱（`com.example`）是為了全球唯一，避免不同函式庫的類別撞名。

### 兩種常見的結構

**按技術分層（layer-based）**——教學與小專案常見：

```
com.example.todo
├── model/          Todo, TodoList, Priority
├── repository/     TodoRepository（介面）, FileTodoRepository
├── service/        TodoService
└── cli/            TodoCli, CommandParser
```

**按功能分包（feature-based / package-by-feature）**——大型專案更推薦：

```
com.example.shop
├── order/          OrderController, OrderService, OrderRepository, Order
├── product/        ProductController, ProductService, ...
├── payment/
└── shared/         共用的工具與例外
```

> **為什麼大專案偏好按功能分包？**
> 改一個功能時，所有相關檔案在同一個目錄——不用在 5 個資料夾之間跳。
> 而且 package-private 可以真正發揮作用：`OrderRepository` 可以只對 `order` package 可見，
> 從編譯期就阻止別的模組亂用。
>
> 本課練習專案（純 Java、規模小）用按技術分層，第 10 站的期末專題會用按功能分包。

### `import` 的細節

```java
import java.util.List;              // ✅ 明確匯入
import java.util.*;                 // ⚠️ 通配匯入：容易撞名，IDE 也不推薦
import static java.lang.Math.max;   // 靜態匯入：之後可以直接寫 max(a, b)

// java.lang 底下的東西不用 import（String、Integer、Object、Exception…）
```

**撞名時必須寫全名：**

```java
import java.util.Date;

public class NameClash {
    public static void main(String[] args) {
        Date utilDate = new Date();                            // java.util.Date
        java.sql.Date sqlDate = new java.sql.Date(0L);         // 只能寫全名
        System.out.println(utilDate.getClass().getName());     // java.util.Date
        System.out.println(sqlDate.getClass().getName());       // java.sql.Date
    }
}
```

> `java.util.Date` / `java.sql.Date` / `java.sql.Timestamp` 的撞名，是 Java 8 之前處理日期的日常痛苦。
> 第 07 章會告訴你：新專案一律用 `java.time`，這個問題就消失了。

---

## 2.14 `enum` 是一種特別的類別

初學者常把 `enum` 當常數清單用，其實它可以帶欄位與方法，這在實務上非常好用。

```java
public enum Priority {

    // 每個常數都是 Priority 的一個實例
    HIGH("高", 3, "🔴"),
    MEDIUM("中", 2, "🟡"),
    LOW("低", 1, "⚪");

    private final String label;
    private final int weight;      // 數字大 = 優先度高，排序時直接比大小
    private final String icon;

    // enum 的建構子一定是 private（寫不寫都是）
    Priority(String label, int weight, String icon) {
        this.label = label;
        this.weight = weight;
        this.icon = icon;
    }

    // ⚠️ 本課的取值方法一律不加 `get` 前綴（`label()` 而不是 `getLabel()`）。
    //    這是為了和第 12 章的 `record` 對齊 —— record 自動產生的存取器就是這個形式。
    //    JavaBean 的 `getXxx` 慣例在框架（JSP、舊版 Jackson）裡仍然重要，
    //    但在自己的領域模型上，簡潔的形式現在更常見。
    public String label() { return label; }
    public int weight() { return weight; }
    public String icon() { return icon; }

    public boolean needsAttentionToday() {
        return this == HIGH;
    }

    /** 從外部輸入（API 參數、CSV）安全轉換 */
    public static Priority fromWeight(int weight) {
        for (Priority p : values()) {
            if (p.weight == weight) return p;
        }
        throw new IllegalArgumentException("無效的優先度: " + weight);
    }

    public static void main(String[] args) {
        Priority p = Priority.HIGH;

        System.out.println(p);                        // HIGH         ← 預設 toString 是常數名
        System.out.println(p.name());                 // HIGH
        System.out.println(p.ordinal());              // 0            ← 宣告順序（別存進資料庫！）
        System.out.println(p.icon() + p.label());     // 🔴高
        System.out.println(p.needsAttentionToday());  // true

        System.out.println(Priority.valueOf("LOW"));  // LOW（找不到會丟 IllegalArgumentException）
        System.out.println(Priority.fromWeight(2));   // MEDIUM

        for (Priority each : Priority.values()) {
            System.out.printf("%s %s (weight=%d)%n", each.icon(), each.label(), each.weight());
        }
    }
}
```

### enum 的兩個實務重點

**① 不要把 `ordinal()` 存進資料庫。**

```java
// ❌ 存 ordinal：有人在 enum 中間插入一個新值，全部資料的意義就變了
int stored = priority.ordinal();

// ✅ 存 name() 或自訂的穩定編碼
String stored = priority.name();          // "HIGH"
int stored2 = priority.weight();          // 3（自己定義的、不會因宣告順序改變）
```

這在第 08 站（JPA）會對應到 `@Enumerated(EnumType.STRING)` vs `EnumType.ORDINAL`——
**永遠選 `STRING`**，理由就是上面這條。

**② enum 可以讓每個常數有不同行為**（策略模式的輕量版）：

```java
import java.math.BigDecimal;
import java.math.RoundingMode;

public enum MemberLevel {

    GOLD("0.8"),
    SILVER("0.9"),
    NORMAL("1.0");

    private final BigDecimal rate;

    MemberLevel(String rate) {
        this.rate = new BigDecimal(rate);
    }

    public BigDecimal apply(BigDecimal amount) {
        return amount.multiply(rate).setScale(2, RoundingMode.HALF_UP);
    }

    public static void main(String[] args) {
        BigDecimal price = new BigDecimal("1000");
        for (MemberLevel level : values()) {
            System.out.println(level + ": " + level.apply(price));
        }
        // GOLD: 800.00
        // SILVER: 900.00
        // NORMAL: 1000.00
    }
}
```

比一堆 `if (level.equals("GOLD"))` 好太多：新增等級只要加一個常數，不用去找所有 `if`。

---

## 2.15 `record` 預告

Java 16 起，「只是裝資料」的不可變類別可以一行寫完：

```java
public record Point(int x, int y) { }
```

編譯器自動產生：`private final` 欄位、全參數建構子、`x()` / `y()` 存取器、`equals`、`hashCode`、`toString`。

```java
public class RecordPreview {

    record Point(int x, int y) { }

    public static void main(String[] args) {
        Point a = new Point(1, 2);
        Point b = new Point(1, 2);

        System.out.println(a);              // Point[x=1, y=2]
        System.out.println(a.equals(b));    // true
        System.out.println(a.x());          // 1  ← 注意是 x() 不是 getX()
    }
}
```

**本章仍然用完整的類別寫法**，因為：

1. 你需要先知道 `record` 幫你省掉了什麼。
2. `record` 是不可變的，不適合有生命週期狀態的物件（如 `Order` 要能 `pay()`）。
3. 你會遇到大量非 `record` 的既有程式碼。

第 12 章會完整講 `record`（含驗證、緊湊建構子、什麼時候不該用）。

---

## 2.16 練習專案：Todo CLI 第一版

現在把本章的東西組成一個能跑的東西。目錄結構：

```
demo/
└── src/main/java/com/example/todo/
    ├── model/
    │   ├── Priority.java
    │   ├── Todo.java
    │   └── TodoList.java
    └── App.java
```

### `Priority.java`

```java
package com.example.todo.model;

public enum Priority {

    HIGH("高", 3),
    MEDIUM("中", 2),
    LOW("低", 1);

    private final String label;
    private final int weight;      // 數字大 = 優先度高

    Priority(String label, int weight) {
        this.label = label;
        this.weight = weight;
    }

    public String label() { return label; }

    public int weight() { return weight; }

    public static Priority fromWeight(int weight) {
        for (Priority p : values()) {
            if (p.weight == weight) return p;
        }
        throw new IllegalArgumentException("無效的優先度: " + weight);
    }
}
```

### `Todo.java`

```java
package com.example.todo.model;

import java.time.LocalDateTime;
import java.util.Objects;

public class Todo {

    private final long id;
    private String title;
    private Priority priority;
    private boolean done;
    private final LocalDateTime createdAt;
    private LocalDateTime completedAt;

    public Todo(long id, String title, Priority priority, LocalDateTime createdAt) {
        if (id <= 0) {
            throw new IllegalArgumentException("id 必須大於 0，收到: " + id);
        }
        this.id = id;
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt 不可為 null");
        this.done = false;
        setTitle(title);                      // 重用驗證邏輯
    }

    /** 標記完成：狀態與時間一起更新，呼叫端不可能只做一半 */
    public void markDone(LocalDateTime when) {
        if (done) {
            throw new IllegalStateException("待辦 #" + id + " 已經完成，不需重複標記");
        }
        Objects.requireNonNull(when, "完成時間不可為 null");
        if (when.isBefore(createdAt)) {
            throw new IllegalArgumentException("完成時間不可早於建立時間");
        }
        this.done = true;
        this.completedAt = when;
    }

    public void reopen() {
        this.done = false;
        this.completedAt = null;
    }

    public void setTitle(String title) {
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("標題不可為空");
        }
        if (title.strip().length() > 100) {
            throw new IllegalArgumentException("標題長度不可超過 100 字");
        }
        this.title = title.strip();
    }

    public void changePriority(Priority priority) {
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
    }

    // 取值方法不加 `get` 前綴（2.14 節說明過理由）。
    // 例外是 boolean 的 `isDone()` —— `done()` 讀起來不像在問問題。
    public long id() { return id; }
    public String title() { return title; }
    public Priority priority() { return priority; }
    public boolean isDone() { return done; }
    public LocalDateTime createdAt() { return createdAt; }
    public LocalDateTime completedAt() { return completedAt; }

    /** 給 CLI 顯示用的一行文字 */
    public String toDisplayLine() {
        return "%s #%-3d [%s] %s".formatted(done ? "[x]" : "[ ]", id,
                                            priority.label(), title);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Todo other)) return false;
        return id == other.id;           // 有 id 的實體，用 id 判斷同一性
    }

    @Override
    public int hashCode() {
        return Long.hashCode(id);
    }

    @Override
    public String toString() {
        return "Todo{id=%d, title='%s', priority=%s, done=%s}"
                .formatted(id, title, priority, done);
    }
}
```

> **注意 `equals` 用 `id` 而不是所有欄位。** 這是實體（entity）的慣例：
> 兩個物件只要 id 相同就是「同一筆待辦」，即使標題被改過。
> 對照第 2.9 節的 `Money`——值物件（value object）才用「所有欄位」比較。第 05 章會再對比這兩種語意。

### `TodoList.java`

```java
package com.example.todo.model;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

public class TodoList {

    private final List<Todo> todos = new ArrayList<>();
    private long nextId = 1;

    /** 新增待辦，回傳建立好的物件（id 由 TodoList 負責產生） */
    public Todo add(String title, Priority priority) {
        Todo todo = new Todo(nextId, title, priority, LocalDateTime.now());
        todos.add(todo);
        nextId++;
        return todo;
    }

    public Optional<Todo> findById(long id) {
        for (Todo todo : todos) {
            if (todo.id() == id) return Optional.of(todo);
        }
        return Optional.empty();
    }

    /** 找不到時丟例外的版本，給「一定要有」的情境用 */
    public Todo getById(long id) {
        return findById(id).orElseThrow(
                () -> new IllegalArgumentException("找不到待辦 #" + id));
    }

    public void markDone(long id) {
        getById(id).markDone(LocalDateTime.now());
    }

    public boolean remove(long id) {
        return todos.removeIf(t -> t.id() == id);
    }

    /** 回傳唯讀視圖，外部無法直接增刪內部集合 */
    public List<Todo> all() {
        return Collections.unmodifiableList(todos);
    }

    public List<Todo> pending() {
        List<Todo> result = new ArrayList<>();
        for (Todo todo : todos) {
            if (!todo.isDone()) result.add(todo);
        }
        return result;
    }

    public List<Todo> completed() {
        List<Todo> result = new ArrayList<>();
        for (Todo todo : todos) {
            if (todo.isDone()) result.add(todo);
        }
        return result;
    }

    public int size() { return todos.size(); }

    public int pendingCount() { return pending().size(); }

    /** 完成率，0~100 */
    public double completionRate() {
        if (todos.isEmpty()) return 0.0;
        return (double) completed().size() / todos.size() * 100;   // 記得轉 double！
    }
}
```

### `App.java`

```java
package com.example.todo;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.model.TodoList;

public class App {

    public static void main(String[] args) {
        TodoList list = new TodoList();

        list.add("寫第 02 章", Priority.HIGH);
        list.add("Code review", Priority.MEDIUM);
        list.add("買咖啡", Priority.LOW);

        list.markDone(3);

        System.out.println("=== 全部 ===");
        for (Todo todo : list.all()) {
            System.out.println(todo.toDisplayLine());
        }

        System.out.println("=== 未完成 ===");
        for (Todo todo : list.pending()) {
            System.out.println(todo.toDisplayLine());
        }

        System.out.printf("完成率: %.1f%% (%d/%d)%n",
                list.completionRate(), list.size() - list.pendingCount(), list.size());

        // 封裝驗證：外部拿不到可變集合
        try {
            list.all().add(null);
        } catch (UnsupportedOperationException e) {
            System.out.println("all() 是唯讀的，不能從外面亂加");
        }

        // 業務規則驗證
        try {
            list.markDone(3);
        } catch (IllegalStateException e) {
            System.out.println("錯誤: " + e.getMessage());
        }
        try {
            list.getById(99);
        } catch (IllegalArgumentException e) {
            System.out.println("錯誤: " + e.getMessage());
        }
    }
}
```

執行結果：

```
=== 全部 ===
[ ] #1   [高] 寫第 02 章
[ ] #2   [中] Code review
[x] #3   [低] 買咖啡
=== 未完成 ===
[ ] #1   [高] 寫第 02 章
[ ] #2   [中] Code review
完成率: 33.3% (1/3)
all() 是唯讀的，不能從外面亂加
錯誤: 待辦 #3 已經完成，不需重複標記
錯誤: 找不到待辦 #99
```

### 對照一開始的版本，我們得到了什麼

| | V0（三個平行 List） | V1（類別設計） |
|---|---|---|
| 資料一致性 | 靠人工同步索引 | 型別保證 |
| 加欄位 | 改所有迴圈 | 只改 `Todo` |
| 業務規則 | 散在呼叫端 | 集中在 `Todo` / `TodoList` |
| 非法資料 | 隨時能寫入 | 建構子與 setter 擋掉 |
| 可測試性 | 只有 `main` | 每個方法都可單獨測 |

> **但這一版還有幾個問題**，正好是後面幾章的主題：
> - `findById` 用 for 迴圈掃全部 → 第 05 章換成 `Map`
> - `pending()` / `completed()` 一堆重複的 for 迴圈 → 第 06 章用 Stream
> - 資料存在記憶體，關掉就沒了 → 第 07 章存檔
> - `TodoList` 直接管儲存 → 第 03 章抽出介面
> - 例外訊息還不夠系統化 → 第 04 章
> - 完全沒有測試 → 第 11 章

---

## 2.17 常見錯誤

### 錯誤 1：setter 裡漏寫 `this.`

```java
// ❌ 靜默無效
public void setTitle(String title) { title = title; }

// ✅
public void setTitle(String title) { this.title = title; }
```

### 錯誤 2：`final` 集合欄位以為就安全了

```java
// ❌ final 只保證參考不變，內容照樣能改
private final List<String> items = new ArrayList<>();
public List<String> getItems() { return items; }      // 外部可以 clear()

// ✅
public List<String> getItems() { return List.copyOf(items); }
```

### 錯誤 3：只覆寫 `equals` 沒覆寫 `hashCode`

```java
// ❌ 放進 HashSet 就會出現「重複元素」或「找不到」
@Override public boolean equals(Object o) { ... }

// ✅ 一起寫，用同一組欄位
@Override public int hashCode() { return Objects.hash(...); }
```

### 錯誤 4：用可變的靜態欄位當共用狀態

```java
// ❌ 多執行緒環境下必壞（第 08 章），而且永遠不會被 GC（第 09 章）
public class Cache {
    public static Map<String, Order> CACHE = new HashMap<>();
}
```

### 錯誤 5：把所有邏輯放在 Service，Model 只有 getter/setter

```java
// ❌ 貧血模型：訂單自己不知道自己能不能付款
if (order.getStatus().equals("CREATED") && order.getTotalCents() > 0) {
    order.setStatus("PAID");
    order.setPaidAt(LocalDateTime.now());
}

// ✅ 規則放在物件裡
order.pay(LocalDateTime.now());
```

### 錯誤 6：在建構子裡呼叫可被覆寫的方法

```java
// ❌ 子類別覆寫 init() 時，它會在子類別欄位初始化「之前」被呼叫 → 看到 null
public class Base {
    public Base() { init(); }
    protected void init() { }
}
```

第 03 章 3.6 節會示範這個坑的完整版本。

### 錯誤 7：`toString` 印出敏感資料

```java
// ❌ 密碼、token 直接進 log
return "User{email=" + email + ", password=" + password + "}";

// ✅
return "User{email=" + email + ", password=***}";
```

---

## 2.18 本章練習

### 練習 1：重構貧血模型

下面的 `BankAccount` 是典型的貧血模型。請重構它，讓非法狀態不可能出現。

```java
public class BankAccount {
    public String accountNo;
    public long balanceCents;
    public boolean frozen;

    public void setBalanceCents(long balanceCents) { this.balanceCents = balanceCents; }
    public void setFrozen(boolean frozen) { this.frozen = frozen; }
}
```

<details>
<summary>參考解答</summary>

```java
import java.util.Objects;

public class BankAccount {

    private final String accountNo;
    private long balanceCents;
    private boolean frozen;

    public BankAccount(String accountNo, long initialBalanceCents) {
        if (accountNo == null || accountNo.isBlank()) {
            throw new IllegalArgumentException("帳號不可為空");
        }
        if (initialBalanceCents < 0) {
            throw new IllegalArgumentException("初始餘額不可為負: " + initialBalanceCents);
        }
        this.accountNo = accountNo.strip();
        this.balanceCents = initialBalanceCents;
        this.frozen = false;
    }

    public void deposit(long amountCents) {
        requireActive();
        requirePositive(amountCents);
        // 溢位保護（第 01 章 1.4 節）
        this.balanceCents = Math.addExact(this.balanceCents, amountCents);
    }

    public void withdraw(long amountCents) {
        requireActive();
        requirePositive(amountCents);
        if (amountCents > balanceCents) {
            throw new IllegalStateException(
                    "餘額不足：可用 %d，欲提領 %d".formatted(balanceCents, amountCents));
        }
        this.balanceCents -= amountCents;
    }

    public void transferTo(BankAccount target, long amountCents) {
        Objects.requireNonNull(target, "目標帳戶不可為 null");
        if (this == target) {
            throw new IllegalArgumentException("不可轉帳給自己");
        }
        // 注意：這裡只是單機示範。真正的轉帳需要交易保證兩邊一起成功或一起失敗，
        // 見第 05 站（@Transactional）與第 07 站（MySQL 交易與鎖）。
        this.withdraw(amountCents);
        target.deposit(amountCents);
    }

    public void freeze() { this.frozen = true; }

    public void unfreeze() { this.frozen = false; }

    private void requireActive() {
        if (frozen) {
            throw new IllegalStateException("帳戶 " + accountNo + " 已凍結");
        }
    }

    private static void requirePositive(long amountCents) {
        if (amountCents <= 0) {
            throw new IllegalArgumentException("金額必須大於 0，收到: " + amountCents);
        }
    }

    public String getAccountNo() { return accountNo; }
    public long getBalanceCents() { return balanceCents; }
    public boolean isFrozen() { return frozen; }

    @Override
    public String toString() {
        return "BankAccount{accountNo='%s', balance=%.2f, frozen=%s}"
                .formatted(accountNo, balanceCents / 100.0, frozen);
    }

    public static void main(String[] args) {
        BankAccount a = new BankAccount("A-001", 100_00);
        BankAccount b = new BankAccount("B-002", 0);

        a.transferTo(b, 30_00);
        System.out.println(a);        // balance=70.00
        System.out.println(b);        // balance=30.00

        try {
            a.withdraw(999_00);
        } catch (IllegalStateException e) {
            System.out.println(e.getMessage());    // 餘額不足：可用 7000，欲提領 99900
        }

        a.freeze();
        try {
            a.deposit(100);
        } catch (IllegalStateException e) {
            System.out.println(e.getMessage());    // 帳戶 A-001 已凍結
        }
    }
}
```

**關鍵改動：**

1. 拿掉 `setBalanceCents`——餘額只能透過 `deposit` / `withdraw` 改，每次都檢查規則。
2. `accountNo` 改 `final`——帳號不該變。
3. 金額用 `long`（分），避免第 01 章的浮點誤差。
4. `frozen` 改用 `freeze()` / `unfreeze()` 表達動作。
5. 用 `Math.addExact` 防溢位。

</details>

### 練習 2：設計不可變的 `DateRange`

設計一個表示日期區間的不可變類別，要能：判斷某天是否落在區間內、計算天數、判斷兩個區間是否重疊。
建構時驗證開始不可晚於結束。

<details>
<summary>參考解答</summary>

```java
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.Objects;

public final class DateRange {

    private final LocalDate start;      // LocalDate 本身不可變，不需防禦性拷貝
    private final LocalDate end;        // 含頭含尾（inclusive）

    private DateRange(LocalDate start, LocalDate end) {
        this.start = start;
        this.end = end;
    }

    public static DateRange of(LocalDate start, LocalDate end) {
        Objects.requireNonNull(start, "start 不可為 null");
        Objects.requireNonNull(end, "end 不可為 null");
        if (start.isAfter(end)) {
            throw new IllegalArgumentException(
                    "開始日不可晚於結束日: %s > %s".formatted(start, end));
        }
        return new DateRange(start, end);
    }

    public static DateRange singleDay(LocalDate day) {
        return of(day, day);
    }

    public boolean contains(LocalDate date) {
        Objects.requireNonNull(date, "date 不可為 null");
        return !date.isBefore(start) && !date.isAfter(end);
    }

    public long days() {
        return ChronoUnit.DAYS.between(start, end) + 1;    // +1 因為含頭含尾
    }

    public boolean overlaps(DateRange other) {
        Objects.requireNonNull(other, "other 不可為 null");
        // 兩區間重疊 ⟺ 我的開始不晚於你的結束，且我的結束不早於你的開始
        return !this.start.isAfter(other.end) && !this.end.isBefore(other.start);
    }

    /** 「修改」回傳新物件 */
    public DateRange extendTo(LocalDate newEnd) {
        return of(this.start, newEnd);
    }

    public LocalDate getStart() { return start; }
    public LocalDate getEnd() { return end; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof DateRange other)) return false;
        return start.equals(other.start) && end.equals(other.end);
    }

    @Override
    public int hashCode() { return Objects.hash(start, end); }

    @Override
    public String toString() { return start + " ~ " + end; }

    public static void main(String[] args) {
        DateRange august = DateRange.of(LocalDate.of(2026, 8, 1), LocalDate.of(2026, 8, 31));

        System.out.println(august);                                        // 2026-08-01 ~ 2026-08-31
        System.out.println(august.days());                                 // 31
        System.out.println(august.contains(LocalDate.of(2026, 8, 17)));    // true
        System.out.println(august.contains(LocalDate.of(2026, 9, 1)));     // false

        DateRange promo = DateRange.of(LocalDate.of(2026, 8, 25), LocalDate.of(2026, 9, 5));
        System.out.println(august.overlaps(promo));                        // true

        DateRange september = DateRange.of(LocalDate.of(2026, 9, 1), LocalDate.of(2026, 9, 30));
        System.out.println(august.overlaps(september));                    // false

        System.out.println(august.extendTo(LocalDate.of(2026, 9, 15)));    // 2026-08-01 ~ 2026-09-15
        System.out.println(august);                                        // 原物件不變

        try {
            DateRange.of(LocalDate.of(2026, 9, 1), LocalDate.of(2026, 8, 1));
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());
            // 開始日不可晚於結束日: 2026-09-01 > 2026-08-01
        }
    }
}
```

**`overlaps` 的邏輯值得記住**：不要去列舉「包含、被包含、左重疊、右重疊」四種情況，
直接用否命題：`!(我完全在你之後) && !(我完全在你之前)`。行程衝突檢查、優惠券期間重疊、
訂房日期衝突都是同一個公式。

</details>

### 練習 3：用 Builder 建立 HTTP 請求設定

設計 `HttpConfig`：必填 `url`；選填 `method`（預設 `"GET"`）、`timeoutMillis`（預設 5000）、
`retryCount`（預設 0）、`headers`（Map）。
驗證：`timeoutMillis` 必須 > 0、`retryCount` 在 0~5、`method` 必須是 GET/POST/PUT/DELETE 之一。

<details>
<summary>參考解答</summary>

```java
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class HttpConfig {

    private static final Set<String> ALLOWED_METHODS = Set.of("GET", "POST", "PUT", "DELETE");

    private final String url;
    private final String method;
    private final int timeoutMillis;
    private final int retryCount;
    private final Map<String, String> headers;

    private HttpConfig(Builder b) {
        this.url = b.url;
        this.method = b.method;
        this.timeoutMillis = b.timeoutMillis;
        this.retryCount = b.retryCount;
        this.headers = Map.copyOf(b.headers);        // ✅ 拷貝成不可變
    }

    public static Builder builder(String url) {
        return new Builder(url);
    }

    public static final class Builder {
        private final String url;
        private String method = "GET";
        private int timeoutMillis = 5000;
        private int retryCount = 0;
        private final Map<String, String> headers = new HashMap<>();

        private Builder(String url) {
            this.url = url;
        }

        public Builder method(String method) {
            this.method = method == null ? null : method.toUpperCase();
            return this;
        }

        public Builder timeoutMillis(int timeoutMillis) {
            this.timeoutMillis = timeoutMillis;
            return this;
        }

        public Builder retryCount(int retryCount) {
            this.retryCount = retryCount;
            return this;
        }

        public Builder header(String name, String value) {
            Objects.requireNonNull(name, "header 名稱不可為 null");
            this.headers.put(name, value);
            return this;
        }

        public HttpConfig build() {
            if (url == null || url.isBlank()) {
                throw new IllegalArgumentException("url 不可為空");
            }
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                throw new IllegalArgumentException("url 必須以 http:// 或 https:// 開頭: " + url);
            }
            if (!ALLOWED_METHODS.contains(method)) {
                throw new IllegalArgumentException(
                        "不支援的 method: %s（允許 %s）".formatted(method, ALLOWED_METHODS));
            }
            if (timeoutMillis <= 0) {
                throw new IllegalArgumentException("timeoutMillis 必須 > 0，收到: " + timeoutMillis);
            }
            if (retryCount < 0 || retryCount > 5) {
                throw new IllegalArgumentException("retryCount 需在 0~5，收到: " + retryCount);
            }
            // 跨欄位規則：重試會放大總耗時，避免整體 timeout 失控
            if ((long) timeoutMillis * (retryCount + 1) > 60_000L) {
                throw new IllegalArgumentException(
                        "timeout × (retry+1) 不可超過 60 秒，目前 %d ms"
                                .formatted((long) timeoutMillis * (retryCount + 1)));
            }
            return new HttpConfig(this);
        }
    }

    public String getUrl() { return url; }
    public String getMethod() { return method; }
    public int getTimeoutMillis() { return timeoutMillis; }
    public int getRetryCount() { return retryCount; }
    public Map<String, String> getHeaders() { return headers; }

    @Override
    public String toString() {
        return "HttpConfig{%s %s, timeout=%dms, retry=%d, headers=%s}"
                .formatted(method, url, timeoutMillis, retryCount, headers.keySet());
    }

    public static void main(String[] args) {
        HttpConfig cfg = HttpConfig.builder("https://api.example.com/orders")
                .method("post")
                .timeoutMillis(3000)
                .retryCount(2)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer xxx")
                .build();

        System.out.println(cfg);
        // HttpConfig{POST https://api.example.com/orders, timeout=3000ms, retry=2,
        //            headers=[Content-Type, Authorization]}

        // 最小設定
        System.out.println(HttpConfig.builder("https://a.com").build());
        // HttpConfig{GET https://a.com, timeout=5000ms, retry=0, headers=[]}

        try {
            HttpConfig.builder("https://a.com").method("PATCH").build();
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());
        }

        try {
            HttpConfig.builder("https://a.com").timeoutMillis(30_000).retryCount(3).build();
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());
            // timeout × (retry+1) 不可超過 60 秒，目前 120000 ms
        }

        // headers 是不可變的
        try {
            cfg.getHeaders().put("X-Hack", "1");
        } catch (UnsupportedOperationException e) {
            System.out.println("headers 唯讀");
        }
    }
}
```

**三個設計重點：**

1. `toString()` 只印 header 的 **key**，不印 value——因為 `Authorization` 是機密（2.17 錯誤 7）。
2. `Map.copyOf(b.headers)` 讓 Builder 之後被繼續使用也不會影響已建立的物件。
3. 跨欄位驗證（timeout × retry）只有在 `build()` 才能做，這是 Builder 比「一堆 setter」好的地方之一。

</details>

### 練習 4：`static` 的判斷

以下四個方法，哪些應該是 `static`？為什麼？

```java
class A { int calculateTax(int amount) { return amount * 5 / 100; } }
class B { Order findById(String id) { /* 查資料庫 */ } }
class C { String formatCurrency(long cents) { return cents / 100.0 + " 元"; } }
class D { void sendEmail(String to, String body) { /* 呼叫 SMTP */ } }
```

<details>
<summary>參考解答</summary>

| 方法 | 該不該 static | 理由 |
|---|---|---|
| `calculateTax` | ✅ **可以** | 純函式：輸入決定輸出、無 IO、無狀態。但若稅率會依國家/年度變動，就該注入設定，改成實例方法 |
| `findById` | ❌ **不要** | 有 IO（資料庫）。做成 static 就無法在測試中替換成假資料 |
| `formatCurrency` | ✅ **可以** | 純函式。但若要支援多語言/多幣別（需要 `Locale`），就該把 `Locale` 當參數傳入，或改成實例方法 |
| `sendEmail` | ❌ **不要** | 有 IO（SMTP）。做成 static 的話，測試會真的寄信給客戶 |

**判斷公式**：這個方法會不會**碰到外面的世界**（DB、網路、檔案、時鐘、隨機數）？
會 → 實例方法 + 依賴注入；不會 → 可以 static。

補充：注意 `formatCurrency` 這種「純函式」也有陷阱——如果它內部呼叫 `Locale.getDefault()`，
就變成依賴環境，測試在不同機器上會有不同結果。**依賴要當參數傳進來，不要偷偷從環境拿。**
`LocalDateTime.now()`、`Math.random()`、`System.getenv()` 都是同類問題，
第 11 章會教怎麼用 `Clock` 之類的抽象處理。

</details>

### 練習 5：預測初始化順序

不執行程式，寫下輸出：

```java
public class Quiz {
    static int a = print("a");
    int b = print("b");

    static { print("static block"); }
    { print("instance block"); }

    Quiz() { print("constructor"); }

    static int print(String s) {
        System.out.println(s);
        return 0;
    }

    public static void main(String[] args) {
        print("main");
        new Quiz();
        new Quiz();
    }
}
```

<details>
<summary>參考解答</summary>

```
a
static block
main
b
instance block
constructor
b
instance block
constructor
```

**推導：**

1. JVM 要執行 `main`，先載入 `Quiz` → 執行靜態初始化，**依原始碼順序**：`a` → `static block`。
2. `main` 開始 → `main`。
3. 第一個 `new Quiz()`：實例欄位與實例區塊**依原始碼順序**（`b` 在 `instance block` 前面）→ `b`、`instance block`，最後才是建構子本體 → `constructor`。
4. 第二個 `new Quiz()`：靜態部分**不再執行**（只執行一次），實例部分重跑。

**實務啟示**：實例欄位的初始值在建構子本體**之前**就跑完了。所以下面這段程式的 `size` 是 0，不是 3：

```java
class Broken {
    private final List<String> items = new ArrayList<>();
    private final int size = items.size();      // ← 這裡執行時 items 還是空的

    Broken() {
        items.add("a"); items.add("b"); items.add("c");
        // size 已經是 0 了，而且是 final，改不了
    }
}
```

「衍生欄位」要嘛在建構子最後才算，要嘛做成方法即時計算。

</details>

---

## 2.19 驗收清單

- [ ] 我能判斷「一個方法應該放在哪個類別」，並說出判斷依據。
- [ ] 我知道寫了任何建構子後，編譯器就不再提供無參數建構子。
- [ ] 我用 `this(...)` 把驗證邏輯集中在一個主建構子。
- [ ] 我知道四種存取修飾子的範圍，也知道 package-private 對測試的用途。
- [ ] 我不再無腦產生 setter，而是用「業務動作」命名的方法取代。
- [ ] 我能說出 `static` 什麼時候可以用、什麼時候會毀掉可測性。
- [ ] 我能寫出「靜態 → 實例欄位 → 實例區塊 → 建構子」的初始化順序。
- [ ] 我能設計不可變類別，也知道 `final` 集合欄位仍需防禦性拷貝。
- [ ] 我知道 `equals` 和 `hashCode` 必須一起覆寫。
- [ ] 我知道參數超過 4～5 個時可以用 Builder，也知道跨欄位驗證要放在 `build()`。
- [ ] 我知道 `enum` 可以帶欄位與方法，也知道不要把 `ordinal()` 存進資料庫。
- [ ] 我完成了 Todo CLI 第一版，並能說出它還有哪些問題留給後面章節。

---

完成後請前往 [03-inheritance-polymorphism-interface.md](./03-inheritance-polymorphism-interface.md)。
