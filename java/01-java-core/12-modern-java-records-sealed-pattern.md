# 第 12 章：現代 Java 特性

> 前面十一章，我們用「Java 8 就有的東西」蓋出了一個完整的專案。
>
> 這一章要做的是：**把同樣的程式碼，用 Java 17／21 的方式重寫一遍**，
> 然後誠實比較——哪些真的變好了，哪些只是換個寫法。
>
> 重點不是「學會新語法」，而是知道**什麼時候該用、什麼時候不該用**。
> 一個把每個地方都塞滿新特性的專案，和一個停在 Java 8 的專案，同樣難維護。

---

## 12.1 學習目標

完成本章後，你應該可以：

- 說出樣板程式碼的真實成本，以及它如何製造出「編譯得過的 bug」。
- 用 `var` 讓程式更好讀，並說出三種**不該**用它的情況。
- 用文字區塊處理 SQL / JSON / HTML，並解釋縮排是怎麼決定的。
- 用 `record` 取代資料類別，並知道它的 `equals` 在浮點數上的特殊行為。
- 在 compact constructor 裡做驗證與正規化，並處理可變元件的防禦性複製。
- 說出 `record` **不該**用的五種情況（含 JPA `@Entity`）。
- 用 `sealed` 封閉型別階層，並說明它和 `enum` 的分工。
- 用增強的 `instanceof`、switch 模式比對、record pattern 消除型別轉換。
- **用 `sealed` + `record` 把 `null` 從狀態表示中徹底移除。**
- 說明 switch expression 的窮盡性檢查，以及它為什麼是本章最大的實質收益。
- 對照各 Java 版本的特性，判斷你的專案現在能用什麼。
- **用 `record` + `sealed` + 模式比對重寫 Todo 專案，並用第 11 章的測試證明行為沒變。**
- 為既有專案設計一套漸進的遷移策略。

---

## 12.2 樣板程式碼的真實成本

「樣板程式碼很囉唆」是大家都同意的事。但**囉唆本身不是問題**——
IDE 可以幫你產生，你也可以不看它。

真正的問題是：**樣板程式碼會製造出編譯得過、測試也可能過的 bug。**

### 一個真實的故事

某個系統有一個報價快取，key 是這個類別：

```java
public class QuoteKey {

    private final String productCode;
    private final String currency;
    private final int quantity;

    public QuoteKey(String productCode, String currency, int quantity) {
        this.productCode = productCode;
        this.currency = currency;
        this.quantity = quantity;
    }

    public String getProductCode() {
        return productCode;
    }

    public String getCurrency() {
        return currency;
    }

    public int getQuantity() {
        return quantity;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (o == null || getClass() != o.getClass()) {
            return false;
        }
        QuoteKey that = (QuoteKey) o;
        return quantity == that.quantity
                && Objects.equals(productCode, that.productCode)
                && Objects.equals(currency, that.currency);
    }

    @Override
    public int hashCode() {
        return Objects.hash(productCode, currency, quantity);
    }

    @Override
    public String toString() {
        return "QuoteKey{productCode='" + productCode + "', currency='" + currency
                + "', quantity=" + quantity + '}';
    }
}
```

**53 行，其中 3 行是真正的資訊**（三個欄位的名字和型別）。

三個月後，業務需求增加「客戶等級」會影響報價。有人加了一個欄位：

```java
public class QuoteKey {

    private final String productCode;
    private final String currency;
    private final int quantity;
    private final String customerTier;        // ← 新增

    public QuoteKey(String productCode, String currency, int quantity, String customerTier) {
        this.productCode = productCode;
        this.currency = currency;
        this.quantity = quantity;
        this.customerTier = customerTier;     // ← 記得了
    }

    public String getCustomerTier() {         // ← 記得了
        return customerTier;
    }

    // equals 忘了改 ❌
    // hashCode 忘了改 ❌
    // toString 忘了改 ❌
}
```

**編譯通過。所有測試通過。上線。**

然後：

```java
Map<QuoteKey, BigDecimal> cache = new HashMap<>();

cache.put(new QuoteKey("WIDGET", "TWD", 100, "VIP"), new BigDecimal("850"));
cache.put(new QuoteKey("WIDGET", "TWD", 100, "NORMAL"), new BigDecimal("1000"));

// 兩個 key 的 equals 和 hashCode 都相同（因為忘了加 customerTier）
// → 第二次 put 覆蓋了第一次
cache.size();                                              // 1，不是 2
cache.get(new QuoteKey("WIDGET", "TWD", 100, "VIP"));      // 1000，不是 850
```

**VIP 客戶被收了一般價格。** 而且：

- 編譯器不會警告（`equals` 不看你有幾個欄位）。
- 既有測試不會紅（它們都用舊的三個欄位）。
- 症狀是「偶爾價格不對」，在測試環境重現不出來。
- 最後靠客訴發現，追查花了兩週。

> 🔑 **這就是樣板程式碼的真實成本：它把「三個欄位」這一個事實，
> 複製到四個地方（欄位、建構子、`equals`、`hashCode`、`toString`），
> 而編譯器不會檢查這五份副本是否一致。**
>
> 這是第 05 章 5.5 節 `equals`/`hashCode` 契約的延伸：
> 契約本身很難記，而樣板程式碼讓「記得更新」變成人的責任。

### `record` 版本

```java
public record QuoteKey(String productCode, String currency, int quantity, String customerTier) { }
```

**一行。** 而且：

- 加欄位就是改這一行——`equals`、`hashCode`、`toString`、存取器**全部自動同步**。
- **不可能**忘記更新，因為根本沒有可以忘記的地方。
- 存取器叫 `productCode()` 而不是 `getProductCode()`（少三個字，且更像數學上的「投影」）。

### 但這不是「打字比較少」

如果只是為了少打字，Lombok 的 `@Value` 早就能做到，IDE 產生程式碼也只要三秒。

`record` 真正的價值是**它是一個語言層級的宣告**：

| | 手寫類別 / Lombok | `record` |
|---|---|---|
| 「這是一筆不可變的資料」 | 靠慣例與註解 | **語言保證**：欄位一定 `final`，類別一定 `final` |
| `equals` 涵蓋所有欄位 | 靠人記得 | **語言保證** |
| 反序列化會經過驗證 | 常常繞過建構子（反射直接寫欄位） | **語言保證**：一定走 canonical constructor |
| 編譯器能做窮盡性檢查 | ❌ | ✅ 配 `sealed`（12.8 節） |
| 能被解構 | ❌ | ✅ record pattern（12.10 節） |
| 工具（IDE、序列化、框架）知道它是資料 | 靠猜 | 有 `Record` 這個共同父類別可以判斷 |

**最後兩項是關鍵。** `record` 不只是「省略樣板」，
它是**讓編譯器理解「這是資料」的宣告**——
而理解之後，編譯器才能提供 12.8～12.12 節那些檢查。

---

## 12.3 `var`：什麼時候幫忙、什麼時候礙事

Java 10 引入區域變數型別推斷。

```java
// 之前
Map<String, List<Todo>> todosByTag = new HashMap<String, List<Todo>>();

// 鑽石運算子之後（Java 7）
Map<String, List<Todo>> todosByTag = new HashMap<>();

// var 之後（Java 10）
var todosByTag = new HashMap<String, List<Todo>>();
```

### 規則

| 可以用 | 不能用 |
|---|---|
| 區域變數（有初始值） | 欄位 |
| for / for-each 的迴圈變數 | 方法參數 |
| try-with-resources 的資源 | 方法回傳型別 |
| lambda 參數（Java 11+，`(var a, var b) ->`） | 建構子參數 |
| | 沒有初始值的宣告 |
| | 初始值是 `null` |
| | 初始值是 lambda 或方法參考 |

```java
var x;                      // ❌ 沒有初始值，推不出型別
var y = null;               // ❌ null 的型別是什麼？
var f = () -> "hi";         // ❌ lambda 需要目標型別才知道是哪個函式介面
var g = String::valueOf;    // ❌ 同上
var arr = {1, 2, 3};        // ❌ 陣列初始化器需要明確型別
var arr2 = new int[]{1, 2, 3};   // ✅ 這樣可以
```

### 什麼時候 `var` 讓程式更好讀

**① 右邊已經說得很清楚**

```java
// 型別在右邊重複了一次，是純粹的雜訊
JsonFileTodoRepository repository = new JsonFileTodoRepository(store);
var repository = new JsonFileTodoRepository(store);              // ✅ 更好

ByteArrayOutputStream buffer = new ByteArrayOutputStream();
var buffer = new ByteArrayOutputStream();                          // ✅
```

**② 型別長到蓋掉變數名**

```java
// 型別佔了 60 個字元，變數名擠在最後
Map<Priority, Map<Boolean, List<Todo>>> grouped = todos.stream()
        .collect(groupingBy(Todo::priority, groupingBy(Todo::isDone)));

// ✅ 重點回到「grouped 是這樣算出來的」
var grouped = todos.stream()
        .collect(groupingBy(Todo::priority, groupingBy(Todo::isDone)));
```

**③ 迴圈變數**

```java
for (var entry : todosByTag.entrySet()) {           // ✅
    // entry 是 Map.Entry<String, List<Todo>>，寫出來很長且沒人在意
}
```

**④ try-with-resources**

```java
try (var lines = Files.lines(path, UTF_8)) {        // ✅
    return lines.filter(l -> !l.isBlank()).toList();
}
```

### 什麼時候 `var` 讓程式更難讀

**① 右邊看不出型別**

```java
var result = service.process(input);         // ❌ result 是什麼？
var config = loadConfig();                   // ❌
var x = calculate(a, b);                     // ❌

// ✅ 型別本身就是文件
ImportResult result = service.process(input);
```

**判準：讀者需不需要跳到方法定義才能知道型別？** 需要 → 不要用 `var`。

**② 型別是介面，而你想強調的是介面**

```java
// ❌ 推出來是 ArrayList，但你其實想表達「這是一個 List」
var todos = new ArrayList<Todo>();

// ✅ 明確宣告成介面，之後想換成 LinkedList 只改右邊
List<Todo> todos = new ArrayList<>();
```

這一點很重要：**`var` 會推出「最具體」的型別**，
於是你不小心就依賴上了實作細節（第 03 章 3.11 節：對介面編程）。

**③ 數值型別會出乎意料**

```java
var a = 1;              // int
var b = 1L;             // long
var c = 1.0;            // double
var d = 1.0f;           // float
var e = 'x';            // char，不是 String！

var count = 0;          // int
count += someLong;      // ❌ 編譯錯誤：不能把 long 塞回 int

// 第 01 章 1.5 節的溢位問題，用 var 更容易踩到
var total = 0;                      // int
for (var price : prices) {          // price 是 int
    total += price;                 // 超過 21 億就溢位，而型別沒寫出來，更難察覺
}
```

**④ 鑽石運算子 + `var` 的陷阱**

```java
var list = new ArrayList<>();       // ⚠️ 這是 ArrayList<Object>！
list.add("字串");
list.add(42);                       // 編譯過，因為元素型別是 Object
String s = list.get(0);             // ❌ 編譯錯誤：Object 不能轉 String
```

`var` 和 `<>` 都在推斷，兩邊都沒有資訊，結果推成 `Object`。
**`var` 和鑽石運算子不要同時用**，至少要有一邊寫出型別。

### 一份團隊約定

我在專案裡會這樣定：

```java
// ✅ 用 var
var repository = new JsonFileTodoRepository(store);        // 右邊有型別
var grouped = todos.stream().collect(groupingBy(...));     // 型別很長
for (var todo : todos) { }                                  // 迴圈變數
try (var lines = Files.lines(path)) { }                     // 資源

// ❌ 不用 var
List<Todo> todos = repository.findAll();       // 方法回傳，型別是資訊
BigDecimal total = calculate(items);           // 同上
long userId = row.getLong("id");               // 數值型別要明確
Map<String, String> headers = new HashMap<>(); // 想強調介面型別
```

> **一句話原則：`var` 是為了消除「重複的資訊」，不是為了消除「型別資訊」。**
>
> 如果拿掉型別之後，讀者還是能一眼知道這是什麼 → 用 `var`。
> 如果讀者要跳去別的地方查 → 寫出型別。
>
> 這條線每個團隊會畫在不同位置，但**一定要有一條線並寫進 code review 檢查表**，
> 否則同一份程式碼裡會出現兩種風格。

---

## 12.4 文字區塊

Java 15 正式加入。解決的是「多行字串在 Java 裡醜到不行」這件事。

### 之前 vs 之後

```java
// ❌ Java 15 之前：跳脫字元的地獄
String json = "{\n"
        + "  \"id\": 1,\n"
        + "  \"title\": \"買牛奶\",\n"
        + "  \"priority\": \"HIGH\",\n"
        + "  \"tags\": [\"購物\", \"生活\"]\n"
        + "}";

String sql = "SELECT t.id, t.title, t.priority\n"
        + "  FROM todo t\n"
        + " WHERE t.done = false\n"
        + "   AND t.priority = ?\n"
        + " ORDER BY t.created_at DESC";
```

```java
// ✅ 文字區塊
String json = """
        {
          "id": 1,
          "title": "買牛奶",
          "priority": "HIGH",
          "tags": ["購物", "生活"]
        }""";

String sql = """
        SELECT t.id, t.title, t.priority
          FROM todo t
         WHERE t.done = false
           AND t.priority = ?
         ORDER BY t.created_at DESC
        """;
```

**雙引號不用跳脫**，這對 JSON、HTML、正則表達式（第 07 章 7.6 節）是巨大的解放。

### 縮排是怎麼決定的

這是最常搞錯的部分。規則是：

> **找出所有非空白行（以及結束的 `"""` 那一行）的「最小共同縮排」，
> 然後從每一行扣掉它。**

```java
class Demo {
    String sql() {
        return """
                SELECT *
                  FROM todo
                """;
    }
}
```

分析：

```
                SELECT *          ← 縮排 16
                  FROM todo       ← 縮排 18
                """               ← 結束符縮排 16
                                    最小共同縮排 = 16
```

結果：

```
SELECT *
  FROM todo
```

`FROM` 前面的兩個空白**被保留**（18 - 16 = 2），因為它是「有意義的縮排」。

**結束的 `"""` 位置決定基準線**，這是最好用的控制手段：

```java
// 結束符往左移，就會保留左邊的空白
String indented = """
                SELECT *
                  FROM todo
        """;                   // 縮排 8 → 最小共同縮排變成 8
```

結果：

```
        SELECT *
          FROM todo
```

### 結尾換行：`"""` 放哪裡

```java
String withNewline = """
        abc
        """;        // 結束符另起一行 → 字串是 "abc\n"

String withoutNewline = """
        abc""";     // 結束符接在內容後 → 字串是 "abc"（沒有結尾換行）
```

> **實務建議：SQL、JSON、設定檔一律讓結束符另起一行**（有結尾換行，
> 拼接時比較安全）。**訊息、標題這類要嵌進別的字串的，就接在內容後**。

### 三個跳脫序列

```java
// \  行接續：不要換行
String oneLine = """
        這是一個很長的句子，\
        但我不想讓它在輸出時換行。""";
// → "這是一個很長的句子，但我不想讓它在輸出時換行。"

// \s  保留一個空白（防止行尾空白被自動剝除）
String padded = """
        紅  \s
        綠  \s
        藍  \s
        """;
// 每行結尾的空白被保留（\s 本身就是一個空白，且它後面的內容不會被剝除）

// \n \t \" 等傳統跳脫依然有效
String mixed = """
        第一行\n還是第一行（顯式的 \\n）
        """;
```

> ⚠️ **行尾空白預設會被剝除。** 這是刻意的設計（避免看不見的空白造成 diff 雜訊），
> 但如果你在產生固定寬度的報表，就會踩到。用 `\s` 明確保留。

### 常見用途

**① SQL**（第 06～08 站會大量用到）

```java
private static final String FIND_PENDING = """
        SELECT t.id, t.title, t.priority, t.created_at
          FROM todo t
         WHERE t.done = false
           AND t.owner_id = ?
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT ?
        """;
```

**② 測試裡的期望 JSON**（第 11 章）

```java
@Test
void serializesToExpectedJson() throws Exception {
    String actual = mapper.writeValueAsString(new Todo(1L, "買牛奶", Priority.HIGH, NOW));

    assertThatJson(actual).isEqualTo("""
            {
              "id": 1,
              "title": "買牛奶",
              "priority": "HIGH",
              "createdAt": "2026-08-17T10:00:00Z",
              "done": false
            }
            """);
}
```

**③ CLI 說明文字**（第 10 章 10.18 節用過）

```java
System.out.println("""
        todo — 待辦事項命令列工具

        用法：
          todo add <標題> [--priority HIGH|MEDIUM|LOW]
          todo list [--all]
        """);
```

**④ 正則表達式**（雙引號和反斜線都不用跳脫兩次⋯⋯的一半）

```java
// 注意：反斜線「還是」要跳脫，只有雙引號解放了
Pattern p = Pattern.compile("""
        ^(?<code>[A-Z]{3})-(?<seq>\\d{6})$""");
```

### `formatted()`：文字區塊的好搭檔

```java
String report = """
        報表編號：%s
        日期：%s
        已完成：%d／%d
        """.formatted(reportId, date, done, total);
```

`String::formatted`（Java 15）就是 `String.format` 的實例方法版，
讓格式字串和參數在視覺上連在一起。

> ⚠️ **絕對不要用文字區塊 + 字串拼接組 SQL。**
>
> ```java
> // ❌ SQL injection
> String sql = """
>         SELECT * FROM todo WHERE title = '%s'
>         """.formatted(userInput);
> ```
>
> 文字區塊讓 SQL 變好讀，但**參數一律用 `?` 佔位符**（第 06 站會詳談）。
> 好讀的 SQL 不代表安全的 SQL。

> 📌 **關於「字串樣板」（String Templates）**
> Java 21／22 曾以預覽功能推出 `STR."Hello \\{name}"` 這個語法，
> 目標正是安全的字串插值。但它在後續版本被**移除重新設計**，
> 目前沒有可用的正式版本。
> **看到舊教學介紹 `STR.` 語法，不要跟著用**——那段程式碼在新 JDK 上編不過。
> 現階段就用 `formatted()` 或 `MessageFormat`。

---

## 12.5 `record`：一行取代一百行

### 基本形式

```java
public record Point(int x, int y) { }
```

編譯器會產生：

```java
public final class Point extends java.lang.Record {

    private final int x;
    private final int y;

    public Point(int x, int y) {        // canonical constructor
        this.x = x;
        this.y = y;
    }

    public int x() { return x; }        // 存取器：沒有 get 前綴
    public int y() { return y; }

    public boolean equals(Object o) { /* 比較所有元件 */ }
    public int hashCode() { /* 基於所有元件 */ }
    public String toString() { return "Point[x=" + x + ", y=" + y + "]"; }
}
```

```java
var p = new Point(3, 4);

p.x();                              // 3
p.toString();                       // "Point[x=3, y=4]"
p.equals(new Point(3, 4));          // true
```

### 硬性規則

| 規則 | 說明 |
|---|---|
| 隱含 `final` | 不能被繼承 |
| 隱含 `extends java.lang.Record` | **不能繼承其他類別** |
| 可以實作介面 | `record Point(int x, int y) implements Comparable<Point>` |
| 元件是 `private final` 欄位 | 不可變 |
| **不能有額外的實例欄位** | 只能有 `static` 欄位 |
| 可以有 `static` 方法、實例方法、巢狀型別 | |
| 巢狀 record 隱含 `static` | 不會持有外層實例的參考 |
| 可以宣告在方法裡（local record，Java 16） | 很適合當「這個方法內部用的中繼資料」 |

「不能有額外實例欄位」這條常讓人意外，但它是**核心設計**：

> **record 的狀態完全由它的元件決定。**
> 這是 `equals`、`hashCode`、`toString`、解構、序列化能自動正確的前提。
> 一旦允許額外欄位，這些保證全部瓦解。

### 加上行為

`record` 不是「只能放資料」。它可以有方法——**只要那些方法是從元件算出來的**：

```java
public record Money(BigDecimal amount, Currency currency) {

    // static 欄位可以
    public static final Money ZERO_TWD =
            new Money(BigDecimal.ZERO, Currency.getInstance("TWD"));

    // 實例方法：從元件計算，不新增狀態
    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(amount.add(other.amount), currency);
    }

    public Money times(int factor) {
        return new Money(amount.multiply(BigDecimal.valueOf(factor)), currency);
    }

    public boolean isZero() {
        return amount.signum() == 0;
    }

    public String format() {
        return "%s %s".formatted(currency.getSymbol(), amount.setScale(2, RoundingMode.HALF_UP));
    }

    private void requireSameCurrency(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException(
                    "幣別不同：%s vs %s".formatted(currency, other.currency));
        }
    }

    // static factory
    public static Money twd(String amount) {
        return new Money(new BigDecimal(amount), Currency.getInstance("TWD"));
    }
}
```

```java
var a = Money.twd("100.50");
var b = Money.twd("200.25");

a.plus(b).format();         // "NT$ 300.75"
a.times(3).format();        // "NT$ 301.50"
```

> **這才是 record 的正確用法：不可變的值物件 + 從值算出來的行為。**
> 它和第 02 章 2.12 節「不可變物件」是同一件事，
> 只是現在有語言層級的支援。
>
> ⚠️ 但**不要在 record 裡放「和資料無關的行為」**。
> `record Todo(...)` 裡不該有 `saveToDatabase()`——那是 Repository 的事。
> record 是名詞，不是服務。

### 覆寫自動產生的方法

```java
public record Todo(long id, String title, Priority priority, Instant createdAt) {

    // 覆寫存取器（少見，但可以）
    @Override
    public String title() {
        return title == null ? "(無標題)" : title;
    }

    // 覆寫 toString（常見：不想印出敏感資料）
    @Override
    public String toString() {
        return "Todo[id=%d, title=%s]".formatted(id, title);
    }
}
```

**覆寫 `toString` 的實務理由**：預設會印出所有元件。
如果 record 裡有密碼、token、身分證號，它們就會出現在你的 log 裡。

```java
public record Credentials(String username, String password) {

    @Override
    public String toString() {
        return "Credentials[username=%s, password=***]".formatted(username);
    }
}
```

> 🔥 **這是一個真實的資安風險。**
> 第 04 章 4.11 節說「例外要用 logger 記錄」——如果你 `log.info("登入請求：{}", credentials)`，
> 而 `Credentials` 是沒覆寫 `toString` 的 record，密碼就明文躺在 log 檔裡了。
>
> **凡是含敏感欄位的 record，一律覆寫 `toString`。**
> 更好的做法是連欄位型別都換掉（用一個 `Secret` 包裝型別，它的 `toString` 永遠是 `***`）。

### 一個容易忽略的細節：浮點數的 `equals`

record 自動產生的 `equals`，對 `float` / `double` 元件用的是
`Float.compare` / `Double.compare` 的語意，**不是 `==`**：

```java
record Measurement(double value) { }

var nan1 = new Measurement(Double.NaN);
var nan2 = new Measurement(Double.NaN);
System.out.println(nan1.equals(nan2));              // true ⚠️
System.out.println(Double.NaN == Double.NaN);       // false

var zero = new Measurement(0.0);
var negZero = new Measurement(-0.0);
System.out.println(zero.equals(negZero));           // false ⚠️
System.out.println(0.0 == -0.0);                    // true
```

**兩個結果都和 `==` 相反。**

這其實是**正確的行為**——它讓 `equals` 符合「自反性」
（`x.equals(x)` 必須為 true，但 `NaN == NaN` 是 false），
也讓 record 能安全地當 `HashMap` 的 key（第 05 章 5.5 節的契約）。

`Double.hashCode(NaN)` 是固定值，所以 `hashCode` 也一致。

> **但你要知道這件事**，否則某天會被「為什麼兩個 NaN 相等」困住半小時。
> 順帶一提：這也是**又一個不要用 `double` 表示金額的理由**（第 01 章 1.7 節）。

### `record` 與 Jackson（第 07 章的延伸）

Jackson 2.12 起原生支援 record，**而且不需要 `-parameters` 編譯旗標**
（第 10 章 10.10 節）——因為 record 的元件名稱被寫進 class 檔的
`Record` 屬性裡，Jackson 讀得到。

```java
public record TodoDto(long id, String title, Priority priority, Instant createdAt) { }
```

```java
var mapper = new ObjectMapper().registerModule(new JavaTimeModule());

String json = mapper.writeValueAsString(new TodoDto(1L, "買牛奶", Priority.HIGH, NOW));
// {"id":1,"title":"買牛奶","priority":"HIGH","createdAt":"2026-08-17T10:00:00Z"}

TodoDto back = mapper.readValue(json, TodoDto.class);      // ✅ 直接可用
```

需要客製時，註解加在元件上：

```java
public record TodoDto(
        @JsonProperty("todo_id") long id,
        String title,
        @JsonFormat(shape = JsonFormat.Shape.STRING) Priority priority,
        @JsonIgnore Instant internalTimestamp) { }
```

> ⚠️ **註解要指定 target。** 元件上的註解會依它的 `@Target`
> 傳播到欄位／建構子參數／存取器。如果某個自訂註解只宣告了 `@Target(FIELD)`，
> 它就只會出現在欄位上，Jackson 讀建構子參數時看不到。
> 遇到「註解沒生效」時，先查那個註解的 `@Target`。

### `record` 與序列化：一個真正的優勢

普通類別的 Java 序列化**會繞過建構子**（用 `Unsafe` 直接寫欄位），
所以你的驗證邏輯完全沒跑：

```java
public class Age implements Serializable {
    private final int value;
    public Age(int value) {
        if (value < 0) throw new IllegalArgumentException("年齡不可為負");
        this.value = value;
    }
}
```

攻擊者可以手工構造一段位元組流，反序列化出 `Age(-1)`——**驗證完全被繞過**。
這是 Java 序列化長年被詬病的問題之一。

**record 不一樣**：反序列化**一定**走 canonical constructor。

```java
public record Age(int value) implements Serializable {
    public Age {
        if (value < 0) {
            throw new IllegalArgumentException("年齡不可為負，收到：" + value);
        }
    }
}
```

無論從哪裡反序列化，這個檢查都會執行。

> 這呼應第 09 章 9.6 節「類別初始化」與第 10 章 10.17 節「供應鏈安全」：
> **不變條件必須由型別本身保證，不能依賴呼叫方守規矩。**
>
> （不過還是要說：**Java 原生序列化本身就該避免**，
> 第 07 章 7.17 節建議用 JSON。record 只是讓「不得不用」的情況安全一些。）

---

## 12.6 compact constructor：驗證與正規化

`record` 的預設建構子只是把參數存起來。要加驗證，用 **compact constructor**：

```java
public record Todo(long id, String title, Priority priority, Instant createdAt) {

    public static final int MAX_TITLE_LENGTH = 100;

    /**
     * Compact constructor：
     * - 沒有參數列表（編譯器知道是那四個）
     * - 沒有 this.xxx = xxx（編譯器在最後自動加上）
     * - 參數是可以「重新賦值」的區域變數 → 可以做正規化
     */
    public Todo {
        // ① 驗證
        if (id <= 0) {
            throw new InvalidTodoException("id 必須是正整數，收到：" + id);
        }
        Objects.requireNonNull(priority, "priority 不可為 null");
        Objects.requireNonNull(createdAt, "createdAt 不可為 null");

        // ② 正規化：直接改參數變數，編譯器最後會用改過的值賦值
        title = title == null ? "" : title.strip();

        // ③ 正規化之後再驗證
        if (title.isEmpty()) {
            throw new InvalidTodoException("標題不可為空白");
        }
        if (title.length() > MAX_TITLE_LENGTH) {
            throw new InvalidTodoException(
                    "標題不可超過 %d 字，收到 %d 字".formatted(MAX_TITLE_LENGTH, title.length()));
        }
        // 這裡不用寫 this.title = title，編譯器會加
    }
}
```

```java
new Todo(1L, "  買牛奶  ", Priority.HIGH, NOW).title();     // "買牛奶"（去了空白）
new Todo(1L, "   ", Priority.HIGH, NOW);                    // ❌ InvalidTodoException
new Todo(0L, "買牛奶", Priority.HIGH, NOW);                 // ❌ InvalidTodoException
```

> 🔑 **`title = title.strip()` 這一行是 compact constructor 最容易被忽略的能力。**
> 你改的是**參數**（一個區域變數），編譯器在方法結尾才做 `this.title = title`。
> 所以正規化「就這樣寫」就好，不需要額外的欄位或工廠方法。

### 完整版 canonical constructor（少用）

你也可以寫出完整的建構子，但要自己賦值：

```java
public record Todo(long id, String title, Priority priority, Instant createdAt) {

    public Todo(long id, String title, Priority priority, Instant createdAt) {
        this.id = id;
        this.title = title.strip();
        this.priority = priority;
        this.createdAt = createdAt;
    }
}
```

**幾乎沒有理由這樣寫**——compact 版短得多也不會漏掉欄位。
唯一的用途是「參數名稱要和元件名稱不同」，而那本身就是可疑的設計。

### 額外的建構子

```java
public record Todo(long id, String title, Priority priority, Instant createdAt) {

    public Todo {
        // 驗證⋯⋯
    }

    /** 便利建構子：優先度預設 MEDIUM */
    public Todo(long id, String title, Instant createdAt) {
        this(id, title, Priority.MEDIUM, createdAt);        // 必須委派給 canonical
    }
}
```

**規則：所有其他建構子的第一行必須是 `this(...)`，最終委派到 canonical constructor。**
這保證了驗證邏輯只有一份、且一定會執行。

### 可變元件：record **不會**幫你防禦性複製

這是 record 最大的陷阱：

```java
public record TodoWithTags(long id, String title, List<String> tags) { }
```

```java
var mutable = new ArrayList<>(List.of("購物", "生活"));
var todo = new TodoWithTags(1L, "買牛奶", mutable);

mutable.add("駭進來的");             // ⚠️ 從外面改
todo.tags();                        // ["購物", "生活", "駭進來的"]

todo.tags().add("再一個");           // ⚠️ 從回傳值改
todo.tags();                        // 四個元素
```

**`record` 只保證「參考不變」，不保證「參考指向的東西不變」。**
這和第 02 章 2.12 節的防禦性複製是同一個問題——**record 沒有幫你解決它**。

**正解：在 compact constructor 複製，存取器也複製**：

```java
public record TodoWithTags(long id, String title, List<String> tags) {

    public TodoWithTags {
        Objects.requireNonNull(tags, "tags");
        // 進來時複製一份，並且變成不可變
        tags = List.copyOf(tags);           // ← 防禦性複製 + 不可變
    }

    // List.copyOf 已經是不可變的，所以存取器不用再複製。
    // 但如果你用的是 new ArrayList<>(tags)，存取器就要回傳
    // Collections.unmodifiableList(tags) 或再複製一份。
}
```

```java
var mutable = new ArrayList<>(List.of("購物"));
var todo = new TodoWithTags(1L, "買牛奶", mutable);

mutable.add("駭進來的");
todo.tags();                        // ["購物"]  ✅ 沒被影響

todo.tags().add("再一個");           // ❌ UnsupportedOperationException  ✅
```

> ⚠️ **`List.copyOf` 不接受 `null` 元素**（會丟 NPE）。
> 如果你的清單可能含 `null`，用 `Collections.unmodifiableList(new ArrayList<>(tags))`。
> 但更好的做法是**一開始就不要讓 `null` 進到集合裡**（第 05 章 5.4 節）。

**同樣要小心的可變型別**：

| 型別 | 怎麼防禦 |
|---|---|
| `List` / `Set` / `Map` | `List.copyOf` / `Set.copyOf` / `Map.copyOf` |
| 陣列 `byte[]` | `array.clone()`（進來和出去都要） |
| `Date` / `Calendar` | **換掉**，改用 `java.time`（第 07 章 7.10 節） |
| `StringBuilder` | 換成 `String` |
| 別人的可變物件 | 複製，或改成不可變的介面 |

陣列的例子（例如存 hash 或加密後的內容）：

```java
public record Digest(byte[] bytes) {

    public Digest {
        bytes = bytes.clone();                  // 進來複製
    }

    @Override
    public byte[] bytes() {
        return bytes.clone();                   // 出去也複製
    }

    // ⚠️ 陣列的 equals 是參考比較，所以 record 自動產生的 equals 對 byte[] 是錯的！
    @Override
    public boolean equals(Object o) {
        return o instanceof Digest other && Arrays.equals(bytes, other.bytes);
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(bytes);
    }

    @Override
    public String toString() {
        return "Digest[" + HexFormat.of().formatHex(bytes) + "]";
    }
}
```

> 🔥 **「record 有陣列元件」是一個明確的警訊。**
> 自動產生的 `equals` 用 `Objects.equals(byte[], byte[])`，
> 那是**參考比較**——兩個內容相同的陣列不相等。
> 用它當 `HashMap` 的 key 會查不到東西（第 05 章 5.5 節的老問題又回來了）。
>
> **如果 record 有陣列元件，你就必須手動覆寫 `equals`、`hashCode`、`toString`
> ——這時 record 的主要優勢已經沒了。** 考慮改用 `List<Byte>`、
> 包裝型別，或乾脆寫普通類別。

### 「wither」：修改不可變物件的正確方式

record 沒有 setter。要「改一個欄位」，就產生一個新物件：

```java
public record Todo(long id, String title, Priority priority, Instant createdAt) {

    public Todo withTitle(String newTitle) {
        return new Todo(id, newTitle, priority, createdAt);     // 走 canonical → 有驗證
    }

    public Todo withPriority(Priority newPriority) {
        return new Todo(id, title, newPriority, createdAt);
    }
}
```

```java
var original = new Todo(1L, "買牛奶", Priority.LOW, NOW);
var upgraded = original.withPriority(Priority.HIGH);

original.priority();        // LOW（沒被改）
upgraded.priority();        // HIGH
```

> **元件超過 5～6 個時，wither 會變得囉唆**（每個都要寫一個，
> 而且新增元件時每個 wither 都要改——樣板程式碼又回來了）。
>
> 這時的選項：
> ① 用 Builder（第 02 章 2.13 節）搭配 `toBuilder()`；
> ② 重新思考——**元件太多通常表示這個 record 混了多個概念**，
>    該拆成巢狀的小 record（12.10 節會看到解構讓巢狀變得好用）。
>
> Java 未來版本討論過「衍生記錄建立」（derived record creation，
> 類似 `original with { priority = HIGH; }`）的語法，
> 但**目前沒有正式版本可用**，先自己寫 wither。

---

## 12.7 `record` 不該用的時候

`record` 很好用，好用到會被濫用。以下五種情況**不要用**。

### ① JPA `@Entity`

```java
// ❌ 這編不過 / 跑不動
@Entity
public record TodoEntity(@Id Long id, String title) { }
```

JPA 規格要求實體類別：

- 有一個 **no-arg 建構子**（record 沒有，也不可能有）
- **不是 `final`**（Hibernate 要產生代理子類別做延遲載入）
- 欄位**可寫**（Hibernate 用反射填值）

三條 record 全部違反。第 08 站會詳談，但結論先記著：
**`@Entity` 用普通類別，DTO 用 record。**

```java
// ✅ 這是正確的分工
@Entity
public class TodoEntity {           // 可變的持久化實體
    @Id @GeneratedValue private Long id;
    private String title;
    protected TodoEntity() { }      // JPA 用
    // ...
}

public record TodoResponse(long id, String title, String priority) {    // 對外的 DTO
    public static TodoResponse from(TodoEntity entity) {
        return new TodoResponse(entity.getId(), entity.getTitle(), entity.getPriority().name());
    }
}
```

> 這個分離**本來就是好設計**（不要把資料庫結構直接暴露成 API），
> record 只是讓 DTO 那一半變得幾乎零成本。第 03～05 站會反覆用到這個模式。

### ② 有身分（identity）的實體

我們的 `Todo` 是一個好例子。它的 `equals` 只比 `id`：

```java
// 第 02 章的設計：兩個 Todo 只要 id 相同就是「同一個待辦事項」，
// 即使標題被改過
@Override
public boolean equals(Object o) {
    return o instanceof Todo other && id == other.id;
}
```

record 的 `equals` **一定**比較所有元件，你可以覆寫，但覆寫之後：

- 你要自己維護 `equals` + `hashCode`（樣板程式碼回來了）
- 你破壞了 record 的核心語意（「狀態由元件決定」）
- 讀者看到 record 會**預期**是值語意，結果不是——這是驚喜，而驚喜在程式碼裡是壞事

> **判準：這個型別是「值」還是「東西」？**
>
> - **值**（value）：兩個內容相同的就是同一個。`Money`、`Point`、`DateRange`、
>   `EmailAddress`、DTO、事件。→ **用 record**
> - **東西**（entity）：有生命週期、有身分、內容會變但還是同一個。
>   `User`、`Order`、`Todo`（有 id 的那種）。→ **用普通類別**
>
> 「我的地址改了，但我還是我」——那 `Person` 是東西。
> 「100 元就是 100 元」——那 `Money` 是值。

（12.16 節會實際面對這個抉擇：把專案的 `Todo` 改成 record 時，
第 11 章的測試會立刻抓出 `equals` 語意的改變，逼你做出明確的決定。）

### ③ 需要繼承的階層

record 隱含 `final` 且已經繼承 `java.lang.Record`。

```java
// ❌ 都不行
public record Base(int x) { }
public record Derived(int x, int y) extends Base { }     // record 不能 extends
public class Sub extends Base { }                         // record 是 final
```

**但這通常不是問題**——12.8 節的 `sealed` + `record` 組合，
提供了比繼承更好的「多型資料」表達方式。
如果你想「共用欄位」，用**組合**（第 03 章 3.12 節）或介面的 `default` 方法。

```java
// ✅ 用 sealed interface 提供共同型別，用組合共用資料
public sealed interface Shape permits Circle, Rectangle { }

public record Circle(Point center, double radius) implements Shape { }
public record Rectangle(Point topLeft, Point bottomRight) implements Shape { }
```

### ④ 元件太多

```java
// ⚠️ 15 個元件的 record，可讀性比普通類別更差
public record OrderRequest(
        String customerId, String customerName, String customerEmail, String customerPhone,
        String shippingStreet, String shippingCity, String shippingZip, String shippingCountry,
        String billingStreet, String billingCity, String billingZip, String billingCountry,
        List<OrderLine> lines, String couponCode, String note) { }
```

問題不在 record，在**設計**：這裡有三個明顯的概念混在一起。

```java
// ✅ 拆成巢狀的小 record
public record Customer(String id, String name, String email, String phone) { }

public record Address(String street, String city, String zip, String country) { }

public record OrderRequest(
        Customer customer,
        Address shipping,
        Address billing,
        List<OrderLine> lines,
        String couponCode,
        String note) { }
```

好處：
- `Address` 可以重用，也可以有自己的驗證（郵遞區號格式）。
- 呼叫端讀起來清楚：`new OrderRequest(customer, shipping, billing, ...)`。
- **12.10 節的 record pattern 會讓存取巢狀資料變得很輕鬆。**

> **經驗值：超過 6～7 個元件，就想想有沒有可以抽出來的概念。**
> 這條規則對普通類別也成立，只是 record 讓「抽出小型別」的成本降到幾乎為零。

### ⑤ 需要延遲初始化 / 快取的欄位

```java
// ❌ record 不能有額外的實例欄位，所以做不到
public record Report(List<Item> items) {
    private BigDecimal cachedTotal;         // ❌ 編譯錯誤
}
```

如果 `total()` 的計算很貴而且會被呼叫很多次，record 沒有地方放快取。

**選項：**

```java
// 選項 A：在建構時就算好，變成一個元件
public record Report(List<Item> items, BigDecimal total) {
    public Report(List<Item> items) {
        this(List.copyOf(items), items.stream()
                .map(Item::amount).reduce(BigDecimal.ZERO, BigDecimal::add));
    }
}

// 選項 B：接受重算（大部分情況其實夠快，先量再說——第 09 章的原則）
public record Report(List<Item> items) {
    public BigDecimal total() {
        return items.stream().map(Item::amount).reduce(BigDecimal.ZERO, BigDecimal::add);
    }
}

// 選項 C：真的需要快取 → 用普通類別
```

> 選項 A 有一個副作用要知道：`total` 變成元件之後，
> 它會**參與 `equals`**。理論上 `items` 相同 `total` 就相同，所以無害；
> 但如果有人用另一個建構子傳入不一致的 `total`，就會出現
> 「items 相同但物件不相等」的怪事。用 compact constructor 檢查一致性可以防住。

### 決策表

| 情況 | 用什麼 |
|---|---|
| DTO / API 請求回應 | ✅ `record` |
| 值物件（`Money`、`Point`、`DateRange`） | ✅ `record` |
| 事件 / 訊息 | ✅ `record` |
| 多回傳值（取代 `Pair`、`Object[]`） | ✅ `record`（甚至 local record） |
| `sealed` 階層的成員 | ✅ `record` |
| Map 的 key（複合鍵） | ✅ `record`（**除非有陣列元件**） |
| JPA `@Entity` | ❌ 普通類別 |
| 有 id 身分的領域實體 | ❌ 普通類別 |
| 需要繼承 | ❌ `sealed interface` + record，或普通類別 |
| 需要可變狀態 | ❌ 普通類別 |
| 需要延遲初始化 / 快取欄位 | ❌ 普通類別 |
| 元件超過 7 個 | ⚠️ 先拆概念 |
| 有陣列元件 | ⚠️ 要手寫 `equals`/`hashCode`，考慮換型別 |

---

## 12.8 `sealed`：讓型別階層封閉

### 問題：`abstract class` 是開放的

第 03 章我們用介面表達「多型」：

```java
public interface Notifier {
    void notifyDone(Todo todo);
}
```

任何人都可以實作它——這正是我們要的（第 03 章 3.11 節：對介面編程）。

但有些階層**不該**被任意擴充：

```java
public interface PaymentResult { }

public class Success implements PaymentResult { }
public class Declined implements PaymentResult { }
public class Pending implements PaymentResult { }
```

處理它的程式碼：

```java
public String describe(PaymentResult result) {
    if (result instanceof Success) {
        return "付款成功";
    } else if (result instanceof Declined) {
        return "付款被拒";
    } else if (result instanceof Pending) {
        return "處理中";
    }
    throw new IllegalStateException("未知的付款結果：" + result);   // ⚠️ 這一行
}
```

**最後那一行是問題所在。**

半年後有人加了 `public class Refunded implements PaymentResult { }`，
然後：

- 編譯器**不會**提醒你去改 `describe`。
- 整個程式碼庫裡可能有 20 個地方在做這種 `instanceof` 鏈。
- 你只能靠 grep 找，而且一定會漏掉幾個。
- 漏掉的地方在正式環境丟 `IllegalStateException`。

### `sealed`：告訴編譯器「就這幾種」

```java
public sealed interface PaymentResult
        permits Success, Declined, Pending { }

public record Success(String transactionId, Money amount) implements PaymentResult { }
public record Declined(String reasonCode, String message) implements PaymentResult { }
public record Pending(String transactionId, Instant retryAfter) implements PaymentResult { }
```

現在編譯器**知道只有三種可能**，於是：

```java
public String describe(PaymentResult result) {
    return switch (result) {                    // 沒有 default！
        case Success s -> "付款成功，交易編號 " + s.transactionId();
        case Declined d -> "付款被拒：" + d.message();
        case Pending p -> "處理中，請於 " + p.retryAfter() + " 後重試";
    };
}
```

**加上 `Refunded` 的那一刻，這個 switch 就編譯失敗：**

```
[ERROR] the switch expression does not cover all possible input values
```

**編譯器幫你找出全部 20 個需要修改的地方。** 這就是 `sealed` 的價值。

> 🔑 **這是本章最重要的一段。**
>
> `record` 省的是打字，`var` 省的是視覺雜訊——它們都是**便利性**。
> 而 `sealed` + switch 窮盡性提供的是**編譯期保證**：
> 「新增一種情況時，所有需要處理它的地方都會編譯失敗」。
>
> 這把「靠人記得」變成「靠編譯器」——和第 10 章 enforcer、
> 第 11 章 ArchUnit 是同一個哲學，只是這次是語言內建的。

### 語法規則

```java
// 1. 明確列出允許的子型別
public sealed interface Shape permits Circle, Rectangle, Triangle { }

// 2. 同一個檔案裡的話，permits 可以省略
public sealed interface Shape {
    record Circle(double radius) implements Shape { }
    record Rectangle(double w, double h) implements Shape { }
    record Triangle(double base, double height) implements Shape { }
}

// 3. sealed class 也可以
public sealed abstract class Vehicle permits Car, Truck { }
```

**每個子型別必須明確宣告它自己的封閉性**（三選一）：

```java
// final：不能再被繼承（record 隱含 final，所以最常見）
public record Circle(double radius) implements Shape { }
public final class Circle implements Shape { }

// sealed：繼續封閉，但允許它自己列出的子型別
public sealed interface Quadrilateral extends Shape permits Rectangle, Trapezoid { }

// non-sealed：在這裡「打開」，之後任何人都能繼承
public non-sealed class CustomShape implements Shape { }
```

**`non-sealed` 的用途**：你想封閉大部分情況，但保留一個擴充點。

```java
public sealed interface Event permits UserEvent, SystemEvent, PluginEvent { }

public record UserEvent(long userId, String action) implements Event { }
public record SystemEvent(String component, Level level) implements Event { }

// 外掛的事件無法窮舉，開放給第三方
public non-sealed interface PluginEvent extends Event {
    String pluginId();
}
```

但注意：**一旦有 `non-sealed` 的分支，switch 就需要 `default` 了**
（因為那個分支不再窮盡）。這是合理的取捨。

### 位置限制

| 情況 | 要求 |
|---|---|
| 同一個檔案 | ✅ 可以省略 `permits` |
| 同一個套件（未具名模組） | ✅ 需要 `permits` |
| 不同套件、同一個模組 | ✅ 需要 `permits`，且必須有 `module-info.java` |
| 不同模組 | ❌ **不允許** |

**設計意圖**：`sealed` 的保證只在「你控制的程式碼範圍內」有效。
如果別的 jar 可以加入你的階層，窮盡性就不可能成立。

> ⚠️ **實務上最常踩的是「不同套件、無模組」的情況。**
> 如果你把 `Shape` 放在 `com.example.shape`，`Circle` 放在 `com.example.shape.impl`，
> 而專案沒有 `module-info.java`（大部分 Spring 專案都沒有），
> 編譯會失敗：
>
> ```
> [ERROR] class Circle in unnamed module cannot extend a sealed class
>         in a different package
> ```
>
> **最簡單的做法：sealed 階層的所有型別放在同一個套件**，
> 甚至同一個檔案（用巢狀 record，見上面的語法規則 2）。
> 這對可讀性其實是好事——所有可能性都在一個畫面裡。

### `sealed` vs `enum`：怎麼選

兩者都在表達「有限的幾種可能」，差別在**每一種是否需要攜帶不同的資料**。

```java
// enum：每一種只是一個標籤（或攜帶「相同結構」的資料）
public enum Priority {
    HIGH("高", 3), MEDIUM("中", 2), LOW("低", 1);
    // 每個值都有 label 和 weight，結構相同
}

// sealed：每一種攜帶「不同結構」的資料
public sealed interface PaymentResult {
    record Success(String transactionId, Money amount) implements PaymentResult { }
    record Declined(String reasonCode, String message) implements PaymentResult { }
    record Pending(String transactionId, Instant retryAfter) implements PaymentResult { }
    // Success 有金額，Declined 有原因碼，Pending 有重試時間——結構完全不同
}
```

| | `enum` | `sealed interface` + `record` |
|---|---|---|
| 實例數量 | **固定**（每個常數一個單例） | 無限（每種型別可以有很多實例） |
| 攜帶資料 | 每個常數結構相同 | **每種型別結構不同** |
| switch 窮盡性 | ✅ | ✅ |
| 可以用在 `EnumMap` / `EnumSet` | ✅（第 05 章 5.12 節） | ❌ |
| `values()` 可以列舉 | ✅ | ❌ |
| 適合 | 狀態標籤、選項、常數集合 | 結果型別、AST 節點、事件、狀態機 |

> **決策問題：「這幾種可能，需要攜帶不同的資料嗎？」**
> 不需要 → `enum`。需要 → `sealed` + `record`。
>
> 我們的 `Priority` 是前者（三個標籤，結構相同）。
> 12.12 節會示範把 `Todo` 的完成狀態改成後者。

---
## 12.9 增強的 `instanceof` 與 switch 模式比對

### `instanceof` 模式（Java 16）

老寫法有一個永遠重複的動作：**檢查型別 → 轉型 → 用**。

```java
// ❌ 型別名字寫了三次
if (obj instanceof Todo) {
    Todo todo = (Todo) obj;
    System.out.println(todo.title());
}
```

```java
// ✅ 型別模式：檢查、轉型、綁定變數，一次完成
if (obj instanceof Todo todo) {
    System.out.println(todo.title());
}
```

`todo` 這個變數只在「型別檢查成立」的範圍內存在。編譯器很聰明：

```java
// 條件為 true 的分支裡可用
if (obj instanceof Todo todo && todo.isDone()) { ... }        // ✅ && 右邊看得到 todo

// 短路取反之後，else 分支裡可用
if (!(obj instanceof Todo todo)) {
    return "不是待辦事項";
}
return todo.title();                    // ✅ 這裡看得到！因為上面 return 了

// 或的右邊看不到（因為左邊為 true 時右邊不會執行，todo 可能沒被賦值）
if (obj instanceof Todo todo || todo.isDone()) { }            // ❌ 編譯錯誤
```

**「提早返回 + 反向 instanceof」是最實用的組合**，它讓主邏輯不用巢狀縮排：

```java
@Override
public boolean equals(Object o) {
    // 老寫法要三行：null 檢查、getClass 比較、轉型
    return o instanceof Todo other && id == other.id;
}
```

我們在第 02 章其實已經用了這個寫法，現在你知道它叫什麼了。

### switch 模式比對（Java 21）

`instanceof` 鏈超過兩三個就變得難讀。switch 模式比對是它的進化版：

```java
// ❌ instanceof 鏈
public String describe(Object obj) {
    if (obj == null) {
        return "空值";
    } else if (obj instanceof Integer i) {
        return "整數 " + i;
    } else if (obj instanceof String s) {
        return "字串（長度 " + s.length() + "）";
    } else if (obj instanceof List<?> list) {
        return "清單（" + list.size() + " 個元素）";
    } else {
        return "其他：" + obj.getClass().getSimpleName();
    }
}
```

```java
// ✅ switch 模式比對
public String describe(Object obj) {
    return switch (obj) {
        case null -> "空值";
        case Integer i -> "整數 " + i;
        case String s -> "字串（長度 " + s.length() + "）";
        case List<?> list -> "清單（" + list.size() + " 個元素）";
        default -> "其他：" + obj.getClass().getSimpleName();
    };
}
```

**三個重要細節：**

**① `case null` 是新的，而且很重要**

```java
// Java 21 之前的 switch：傳 null 進去會 NPE
switch (someString) {         // someString 是 null → NullPointerException
    case "a" -> ...;
    default -> ...;           // default 也接不到 null！
}
```

這是 switch 的老行為（**`default` 不接 null**），常常讓人意外。
Java 21 起，你可以明確寫 `case null`：

```java
return switch (obj) {
    case null -> "空值";                  // 明確處理
    case String s -> "字串 " + s;
    default -> "其他";
};

// 也可以合併
return switch (obj) {
    case null, default -> "空值或其他";
    case String s -> "字串 " + s;
};
```

> **規則：如果 switch 沒有 `case null`，傳 `null` 進去就是 NPE**——
> 即使有 `default`。這是為了相容舊行為。
> **所以：不確定會不會是 null 的話，一定要寫 `case null`。**

**② 順序有意義：dominance（支配）檢查**

```java
// ❌ 編譯錯誤
return switch (obj) {
    case Object o -> "任何東西";        // 這個「支配」了下面所有的 case
    case String s -> "字串";            // ERROR: this case label is dominated by a preceding case
};
```

編譯器會抓出「永遠不可能執行到」的 case。**這是好事**——
`instanceof` 鏈寫錯順序時，編譯器什麼都不會說，你只會發現某個分支沒作用。

**③ Guarded pattern：`when` 子句**

```java
public String categorize(Todo todo) {
    return switch (todo) {
        case Todo t when t.isDone() -> "已完成";
        case Todo t when t.priority() == Priority.HIGH -> "緊急待辦";
        case Todo t when t.createdAt().isBefore(weekAgo) -> "陳年待辦";
        case Todo t -> "一般待辦";
    };
}
```

`when` 讓你在型別比對之外加上任意條件。注意：

- **`when` 子句不參與窮盡性檢查。** 上面如果拿掉最後那個 `case Todo t ->`，
  即使邏輯上涵蓋了所有情況，編譯器也會說不窮盡——因為它不會去證明布林運算式。
- 順序很重要（由上往下第一個符合的贏）。
- `when` 是**上下文關鍵字**，你還是可以有叫 `when` 的變數。

### 一個實際的例子：格式化不同型別的值

第 07 章的 JSON 處理常常要面對「型別不確定」的資料：

```java
package com.example.todo.support;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Collection;
import java.util.Map;

/** 把任意值格式化成人類可讀的字串（用於 CLI 顯示、log、報表）。 */
public final class ValueFormatter {

    private static final DateTimeFormatter DATE_TIME =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    private ValueFormatter() {
    }

    public static String format(Object value) {
        return switch (value) {
            case null -> "—";

            // 字串：太長就截斷
            case String s when s.length() > 30 -> s.substring(0, 27) + "...";
            case String s -> s;

            // 數值：金額要對齊、整數不加小數點
            case BigDecimal d -> d.stripTrailingZeros().toPlainString();
            case Double d when d % 1 == 0 -> String.valueOf(d.longValue());
            case Double d -> "%.2f".formatted(d);
            case Number n -> n.toString();

            case Boolean b -> b ? "是" : "否";

            // 時間：第 07 章 7.11 節
            case Instant i -> DATE_TIME.format(i.atZone(java.time.ZoneId.systemDefault()));
            case LocalDate d -> d.toString();

            // 集合：只顯示前三個
            case Collection<?> c when c.isEmpty() -> "（空）";
            case Collection<?> c when c.size() <= 3 -> c.stream()
                    .map(ValueFormatter::format).collect(java.util.stream.Collectors.joining("、"));
            case Collection<?> c -> c.stream().limit(3)
                    .map(ValueFormatter::format)
                    .collect(java.util.stream.Collectors.joining("、", "", "…（共 " + c.size() + " 項）"));

            case Map<?, ?> m -> "{" + m.size() + " 組}";

            case Object[] arr -> format(java.util.Arrays.asList(arr));

            default -> value.toString();
        };
    }
}
```

```java
ValueFormatter.format(null);                              // "—"
ValueFormatter.format("買牛奶");                           // "買牛奶"
ValueFormatter.format(new BigDecimal("100.50"));          // "100.5"
ValueFormatter.format(3.0);                               // "3"
ValueFormatter.format(3.14159);                           // "3.14"
ValueFormatter.format(true);                              // "是"
ValueFormatter.format(List.of("a", "b"));                 // "a、b"
ValueFormatter.format(List.of("a", "b", "c", "d", "e"));  // "a、b、c…（共 5 項）"
```

同樣的邏輯用 `if/else if` 寫，會是 40 行巢狀的 `instanceof` + 轉型，
而且順序寫錯編譯器不會提醒你。

> ⚠️ **注意 `case Collection<?> c` 而不是 `case Collection c`。**
> 用原始型別（raw type）會有未受檢警告；用 `<?>` 才乾淨。
> 也**不能**寫 `case List<String> list`——型別抹除（第 05 章 5.17 節）
> 讓執行期無法區分 `List<String>` 和 `List<Integer>`，編譯器會直接拒絕。

---

## 12.10 record pattern：解構

Java 21 的 record pattern 讓你**在比對型別的同時把元件拆出來**。

### 基本形式

```java
public sealed interface Shape {
    record Circle(double radius) implements Shape { }
    record Rectangle(double width, double height) implements Shape { }
}
```

```java
// 沒有解構：拿到物件再呼叫存取器
public double area(Shape shape) {
    return switch (shape) {
        case Circle c -> Math.PI * c.radius() * c.radius();
        case Rectangle r -> r.width() * r.height();
    };
}

// ✅ 有解構：直接拿到元件
public double area(Shape shape) {
    return switch (shape) {
        case Circle(double radius) -> Math.PI * radius * radius;
        case Rectangle(double width, double height) -> width * height;
    };
}
```

差別看起來不大。但**巢狀時差很多**。

### 巢狀解構：真正的價值

```java
public record Point(int x, int y) { }

public sealed interface Shape {
    record Circle(Point center, double radius) implements Shape { }
    record Rectangle(Point topLeft, Point bottomRight) implements Shape { }
    record Line(Point from, Point to) implements Shape { }
}
```

```java
// ❌ 沒有解構：一層一層挖
public String describe(Shape shape) {
    return switch (shape) {
        case Circle c -> "圓心 (%d, %d)，半徑 %.1f"
                .formatted(c.center().x(), c.center().y(), c.radius());
        case Rectangle r -> "從 (%d, %d) 到 (%d, %d)"
                .formatted(r.topLeft().x(), r.topLeft().y(),
                           r.bottomRight().x(), r.bottomRight().y());
        case Line l -> "從 (%d, %d) 到 (%d, %d)"
                .formatted(l.from().x(), l.from().y(), l.to().x(), l.to().y());
    };
}
```

```java
// ✅ 巢狀解構：資料的形狀一目了然
public String describe(Shape shape) {
    return switch (shape) {
        case Circle(Point(int x, int y), double radius) ->
                "圓心 (%d, %d)，半徑 %.1f".formatted(x, y, radius);
        case Rectangle(Point(int x1, int y1), Point(int x2, int y2)) ->
                "從 (%d, %d) 到 (%d, %d)".formatted(x1, y1, x2, y2);
        case Line(Point(int x1, int y1), Point(int x2, int y2)) ->
                "從 (%d, %d) 到 (%d, %d)".formatted(x1, y1, x2, y2);
    };
}
```

**`case Rectangle(Point(int x1, int y1), Point(int x2, int y2))` 這一行
同時做了六件事**：型別檢查、兩層解構、四個變數綁定。
而且它**長得就像資料本身的樣子**。

### 搭配 `var`

型別很長時，用 `var` 讓模式聚焦在「結構」上：

```java
case Rectangle(var topLeft, var bottomRight) -> /* topLeft、bottomRight 是 Point */
case Circle(Point(var x, var y), var radius) -> /* x、y 是 int，radius 是 double */
```

> **這是 `var` 少數「幾乎總是對」的用法**——
> 在 record pattern 裡，型別已經由 record 的宣告決定了，寫出來只是重複。

### 部分比對與常數

```java
// 只在意其中一個元件
case Circle(Point(var x, _), var radius) -> "x 座標是 " + x;
```

`_`（unnamed pattern，Java 22 起正式）表示「這個位置我不在意」。
Java 21 只能寫一個真的變數名（例如 `var ignored`），
而且如果沒用到會有未使用警告。

> ⚠️ **`_` 需要 Java 22 以上。** 如果你的目標是 Java 21（目前最常見的 LTS），
> 就用一個叫 `ignored` 的變數，並在需要時加 `@SuppressWarnings("unused")`。

### 型別細化

模式可以比宣告的型別更具體：

```java
public sealed interface Json {
    record JsonString(String value) implements Json { }
    record JsonNumber(Number value) implements Json { }
    record JsonArray(List<Json> items) implements Json { }
    record JsonObject(Map<String, Json> fields) implements Json { }
    record JsonNull() implements Json { }
}
```

```java
public String render(Json json) {
    return switch (json) {
        case JsonString(String s) -> "\"" + s.replace("\"", "\\\"") + "\"";

        // 型別細化：只有當 value 真的是 Integer 時才符合
        case JsonNumber(Integer i) -> i.toString();
        case JsonNumber(Number n) -> n.toString();

        case JsonArray(List<Json> items) -> items.stream()
                .map(this::render)
                .collect(Collectors.joining(",", "[", "]"));

        case JsonObject(Map<String, Json> fields) -> fields.entrySet().stream()
                .map(e -> "\"" + e.getKey() + "\":" + render(e.getValue()))
                .collect(Collectors.joining(",", "{", "}"));

        case JsonNull() -> "null";      // 沒有元件的 record，寫成 ()
    };
}
```

`case JsonNumber(Integer i)` 只在 `value` 實際是 `Integer` 時符合——
這是**在解構的同時做型別檢查**。

> ⚠️ **型別細化會影響窮盡性。**
> 上面如果只有 `case JsonNumber(Integer i)` 沒有 `case JsonNumber(Number n)`，
> 編譯器會說不窮盡（因為 `Number` 可能是 `Double`）。
> 這是正確的——它逼你想清楚「不是 Integer 的時候怎麼辦」。

### 實際用途：解析命令列參數

我們的 CLI 目前用字串陣列硬解（第 10 章 10.18 節）。用 sealed + record 重寫：

```java
package com.example.todo.cli;

import com.example.todo.model.Priority;

/** 解析後的指令。sealed 讓 dispatch 有窮盡性檢查。 */
public sealed interface Command {

    record Add(String title, Priority priority) implements Command { }

    record List(boolean includeDone) implements Command { }

    record Done(long id) implements Command { }

    record Remove(long id) implements Command { }

    record Help() implements Command { }

    record Version() implements Command { }
}
```

```java
public int execute(Command command) {
    return switch (command) {
        case Command.Add(String title, Priority priority) -> {
            Todo created = service.add(title, priority);
            out.printf("已新增 #%d %s%n", created.id(), created.title());
            yield EXIT_OK;
        }
        case Command.List(boolean includeDone) -> {
            printTodos(includeDone ? service.findAll() : service.findPending());
            yield EXIT_OK;
        }
        case Command.Done(long id) -> {
            service.markDone(id);
            out.println("已標記完成。");
            yield EXIT_OK;
        }
        case Command.Remove(long id) -> {
            service.remove(id);
            out.println("已刪除。");
            yield EXIT_OK;
        }
        case Command.Help() -> {
            printUsage();
            yield EXIT_OK;
        }
        case Command.Version() -> {
            out.println(BuildInfo.describe());
            yield EXIT_OK;
        }
    };
}
```

**新增一個 `Command.Tag(long id, String tag)` 時：**

1. 加一行 record 宣告。
2. `execute` 立刻編譯失敗，逼你補上處理。
3. 解析器（`parse`）也會被檢查（如果它也用 switch 回傳 `Command`）。

對照第 10 章那個 `switch (command)` 字串版：
新增指令要改**三個地方**（`dispatch` 的 case、`printUsage` 的說明、參數解析），
而且漏掉任何一個編譯器都不會說話。

> 這正是本章想傳達的核心：**現代 Java 特性的價值，
> 在於把「靠人記得」的事情變成「編譯器會抓」。**

---

## 12.11 `switch` expression、窮盡性與 `yield`

前面一直在用，這一節把規則講清楚。

### statement vs expression

```java
// switch statement（陳述式）：做事，不回傳值
switch (priority) {
    case HIGH -> log.warn("高優先度");
    case MEDIUM, LOW -> log.info("一般");
}

// switch expression（運算式）：算出一個值
String label = switch (priority) {
    case HIGH -> "緊急";
    case MEDIUM -> "普通";
    case LOW -> "有空再說";
};
```

**兩者最大的差別是窮盡性要求：**

| | statement | expression |
|---|---|---|
| 必須涵蓋所有情況嗎 | ❌ 不用 | ✅ **必須** |
| 可以沒有 `default` 嗎 | ✅ | 只有在 enum / sealed 已窮盡時 |
| 回傳值 | 無 | 有 |

> **實務建議：能用 expression 就用 expression。**
> 因為只有它有窮盡性檢查——那正是我們要的保護。
>
> 常見的重構：
> ```java
> // ❌ statement + 可變變數
> String label;
> switch (priority) {
>     case HIGH -> label = "緊急";
>     case MEDIUM -> label = "普通";
>     case LOW -> label = "有空再說";
> }
>
> // ✅ expression + final 變數
> String label = switch (priority) { ... };
> ```
> 後者不只是好看：`label` 變成 effectively final（可以在 lambda 裡用，
> 第 06 章 6.5 節），而且編譯器保證它一定被賦值。

### 箭頭 vs 冒號：沒有 fall-through

```java
// ❌ 傳統冒號寫法：忘記 break 就往下掉（bug 的經典來源）
switch (day) {
    case MONDAY:
        System.out.println("週一");
        // 忘了 break！
    case TUESDAY:
        System.out.println("週二");     // 也會執行
        break;
}
```

```java
// ✅ 箭頭寫法：不會 fall-through
switch (day) {
    case MONDAY -> System.out.println("週一");
    case TUESDAY -> System.out.println("週二");
}

// 多個標籤用逗號
switch (day) {
    case SATURDAY, SUNDAY -> System.out.println("週末");
    default -> System.out.println("平日");
}
```

**箭頭寫法一律不 fall-through**。這消滅了 Java 二十幾年來最常見的一類 bug。

> ⚠️ **不能在同一個 switch 裡混用箭頭和冒號**，編譯器會拒絕。
> 遷移舊程式碼時要整個 switch 一起改。

### `yield`：箭頭後面需要多行時

```java
int categoryCode = switch (todo.priority()) {
    case HIGH -> {
        auditLog.record("查詢了高優先度事項");        // 多行邏輯
        yield 1;                                      // 用 yield 回傳值
    }
    case MEDIUM -> 2;                                 // 單行不用 yield
    case LOW -> 3;
};
```

**規則：**
- 箭頭後面是**單一運算式** → 直接寫，那就是值。
- 箭頭後面是**區塊 `{ }`** → 必須用 `yield` 產出值（如果這是 expression）。
- `yield` 不是關鍵字，是「上下文關鍵字」——你還能有叫 `yield` 的變數
  （但拜託不要）。

> ⚠️ **區塊裡不能用 `return`。**
> `return` 會從整個「方法」返回，不是從 switch 返回。
> 在 switch expression 的區塊裡寫 `return` 是編譯錯誤。

### 窮盡性的三個來源

編譯器認定「已窮盡」的情況：

**① 有 `default`**

```java
String s = switch (obj) {
    case String str -> "字串";
    default -> "其他";              // 一定窮盡
};
```

**② enum 涵蓋所有常數**

```java
String label = switch (priority) {
    case HIGH -> "緊急";
    case MEDIUM -> "普通";
    case LOW -> "有空再說";
    // 不用 default，因為 Priority 只有這三個
};
```

**③ sealed 型別涵蓋所有 permits 的子型別**

```java
double area = switch (shape) {
    case Circle c -> Math.PI * c.radius() * c.radius();
    case Rectangle r -> r.width() * r.height();
    case Triangle t -> t.base() * t.height() / 2;
    // 不用 default，因為 Shape 只 permits 這三個
};
```

### 🔥 不要對 enum / sealed 加 `default`

這是本節最重要的實務建議。

```java
// ❌ 加了 default，就失去了窮盡性檢查的保護
String label = switch (priority) {
    case HIGH -> "緊急";
    case MEDIUM -> "普通";
    case LOW -> "有空再說";
    default -> "未知";              // ← 這一行殺死了編譯期檢查
};
```

半年後有人加了 `Priority.URGENT`：
- **沒有 `default`** → 這個 switch 編譯失敗，你被逼著處理 → ✅
- **有 `default`** → 編譯通過，`URGENT` 顯示成「未知」→ 上線後才被發現 ❌

**這是「防禦性程式設計」在這裡反而有害的少數場合。**
你以為 `default` 讓程式更穩健，實際上它把「編譯期錯誤」降級成「執行期的錯誤資料」。

> **但 enum 有一個特殊情況要知道**：
> 如果 enum 定義在**另一個 jar**，而那個 jar 在你編譯之後升級新增了常數，
> 執行期就會遇到「沒有任何 case 符合」的情況。
> 這時 JVM 會丟 `MatchException`（Java 21+）或 `IncompatibleClassChangeError`。
>
> 換句話說：**窮盡性是編譯期的保證，不是執行期的保證**——
> 這和第 10 章 10.4 節「用 `release` 而不是 `source/target`」是同一類問題
> （編譯時看到的世界和執行時可能不同）。
>
> 對**自己專案內**的 enum / sealed，放心不加 `default`。
> 對**第三方 jar** 的 enum，如果你擔心它升級，那就加 `default` 並在裡面
> **丟例外**（而不是回傳一個假的值）：
>
> ```java
> default -> throw new IllegalStateException("未預期的優先度：" + priority);
> ```
>
> 這樣至少會大聲失敗，而不是安靜地產生錯誤資料（第 04 章 4.4 節的原則）。

### 舊 switch 的三個限制（都被解決了）

| 舊限制 | 現在 |
|---|---|
| 只支援 `int`、`char`、`String`、enum | ✅ 支援任何型別（模式比對） |
| 忘記 `break` 會 fall-through | ✅ 箭頭寫法不會 |
| 不能當運算式用 | ✅ switch expression |
| 傳 `null` 會 NPE | ✅ `case null`（但要明確寫） |
| 不做窮盡性檢查 | ✅ expression + enum/sealed 會檢查 |

---

## 12.12 用 `sealed` + `record` 消滅 `null`

這一節是本章的高潮：把前面所有特性組合起來，解決一個真實的設計問題。

### 問題：`null` 表示「沒有值」

我們的 `Todo` 是這樣表示完成狀態的（第 11 章的版本）：

```java
private boolean done;
private Instant completedAt;        // 未完成時是 null
```

這造成三個問題：

**① 兩個欄位可能不一致**

```java
todo.isDone();          // true
todo.completedAt();     // null ⚠️ 這是有效狀態嗎？
```

`(done=true, completedAt=null)` 和 `(done=false, completedAt=某時間)`
在型別上都是合法的，但**在領域上都是無效的**。
你只能靠建構子和方法裡的檢查來維持一致性——而那是「靠人記得」。

**② 每個使用者都要檢查 `null`**

```java
// 這段程式碼到處都是
if (todo.completedAt() != null) {
    Duration took = Duration.between(todo.createdAt(), todo.completedAt());
    // ...
}
```

漏掉一次就是 NPE。而編譯器**完全不知道** `completedAt()` 可能是 null。

**③ 測試要一直處理 null**（第 11 章寫測試時就感受到了）

```java
assertThat(todo.completedAt()).isNull();       // 未完成
assertThat(todo.completedAt()).isEqualTo(NOW); // 已完成
```

### 解法：讓狀態成為型別

```java
package com.example.todo.model;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/**
 * 待辦事項的完成狀態。
 *
 * <p>用 sealed + record 取代「boolean done + 可能為 null 的 completedAt」：
 * 不可能建立出 (done=true, completedAt=null) 這種無效狀態。
 */
public sealed interface Completion {

    /** 未完成。沒有任何附帶資料，所以用單例。 */
    record Pending() implements Completion {
        private static final Pending INSTANCE = new Pending();
    }

    /** 已完成。一定有完成時間——型別保證。 */
    record Done(Instant at) implements Completion {
        public Done {
            Objects.requireNonNull(at, "完成時間不可為 null");
        }
    }

    /** 已取消。有時間，也有原因。 */
    record Cancelled(Instant at, String reason) implements Completion {
        public Cancelled {
            Objects.requireNonNull(at, "取消時間不可為 null");
            reason = reason == null ? "" : reason.strip();
            if (reason.isEmpty()) {
                throw new IllegalArgumentException("取消原因不可為空白");
            }
        }
    }

    // ── 工廠方法 ──

    static Completion pending() {
        return Pending.INSTANCE;
    }

    static Completion done(Instant at) {
        return new Done(at);
    }

    static Completion cancelled(Instant at, String reason) {
        return new Cancelled(at, reason);
    }

    // ── 從狀態算出來的查詢（default 方法） ──

    default boolean isPending() {
        return this instanceof Pending;
    }

    /** 已完成或已取消，都算「結束了」 */
    default boolean isFinished() {
        return !isPending();
    }

    /** 結束的時間。未完成時是空的——用 Optional 而不是 null */
    default java.util.Optional<Instant> finishedAt() {
        return switch (this) {
            case Pending() -> java.util.Optional.empty();
            case Done(Instant at) -> java.util.Optional.of(at);
            case Cancelled(Instant at, String ignored) -> java.util.Optional.of(at);
        };
    }

    /** 給人看的說明 */
    default String describe() {
        return switch (this) {
            case Pending() -> "待辦";
            case Done(Instant at) -> "已完成於 " + at;
            case Cancelled(Instant at, String reason) -> "已取消（%s）".formatted(reason);
        };
    }
}
```

### 使用時的差別

```java
// ❌ 之前：要記得檢查 null，而且要記得 done 和 completedAt 是配對的
public Duration timeToComplete(Todo todo) {
    if (!todo.isDone() || todo.completedAt() == null) {
        return Duration.ZERO;                 // 或丟例外？或回 null？
    }
    return Duration.between(todo.createdAt(), todo.completedAt());
}
```

```java
// ✅ 之後：編譯器保證每個分支都被處理，而且 Done 一定有時間
public Duration timeToComplete(Todo todo) {
    return switch (todo.completion()) {
        case Pending() -> Duration.ZERO;
        case Done(Instant at) -> Duration.between(todo.createdAt(), at);
        case Cancelled(Instant at, String ignored) -> Duration.between(todo.createdAt(), at);
    };
}
```

**沒有 `null` 檢查。沒有 `default`。沒有「這個組合有效嗎」的疑問。**

而且如果之後加了 `Completion.Deferred(Instant until)`，
**所有處理 `Completion` 的 switch 都會編譯失敗**，逼你想清楚新狀態該怎麼處理。

### 這個設計換來的四件事

| 之前 | 之後 |
|---|---|
| `(done=true, completedAt=null)` 是可以建構的無效狀態 | **型別上不可能** |
| 每個使用者都要檢查 null | 編譯器強迫處理每個分支 |
| 加一個「已取消」狀態要改 `boolean done`、加 `cancelReason`、改所有 `if (done)` | 加一個 record，編譯器指出所有要改的地方 |
| 測試要斷言「done 是 true 且 completedAt 不是 null」 | `assertThat(todo.completion()).isEqualTo(new Done(NOW))` |

### `Optional` 還是 `sealed`？

第 06 章講過 `Optional`。什麼時候用哪個？

```java
// Optional：只有「有值 / 沒值」兩種，而且「沒值」不需要攜帶資訊
Optional<Todo> findById(long id);

// sealed：多於兩種，或「沒值」也有不同原因
public sealed interface FindResult {
    record Found(Todo todo) implements FindResult { }
    record NotFound(long id) implements FindResult { }
    record AccessDenied(long id, String requiredRole) implements FindResult { }
}
```

| | `Optional<T>` | `sealed interface` |
|---|---|---|
| 情況數 | 剛好兩種 | 兩種以上 |
| 「空」需要攜帶原因嗎 | 不需要 | 需要 |
| 使用成本 | 低（`map`/`orElse`/`ifPresent`） | 較高（要寫 switch） |
| 窮盡性檢查 | ❌ 沒有 | ✅ 有 |
| 適合 | 查詢結果、可選欄位 | 操作結果、狀態機、AST |

> **實務判準：如果你發現自己在寫 `Optional<Result>` 而 `Result` 裡又有
> 一個 `errorCode` 欄位，或者在回傳 `Optional` 之外還要丟例外來區分
> 「不存在」和「沒權限」——那就該換成 sealed。**
>
> 第 06 章 6.16 節那個練習寫的 `Result<T>` 型別，就是這個模式的雛形。
> 現在你有語言支援可以把它寫得更好。

### 但不要走火入魔

```java
// ❌ 過度設計：這裡 Optional 就夠了
public sealed interface MaybeTitle {
    record HasTitle(String value) implements MaybeTitle { }
    record NoTitle() implements MaybeTitle { }
}

// ✅
Optional<String> title();
```

**判準：這個「多型」有沒有讓呼叫端的程式碼變簡單？**
如果呼叫端只是 `switch` 出兩個分支然後做一樣的事，那 `Optional` 更好。

> 一個實用的觀察：**當「不同情況需要攜帶不同資料」時，sealed 才划算。**
> `Pending` 沒有資料、`Done` 有時間、`Cancelled` 有時間和原因——
> 這三個結構不同，所以值得。

---

## 12.13 其他現代特性速覽

以下是不夠格開一節、但你會常常用到的。

### Sequenced Collections（Java 21）

長年的痛點：取「第一個」「最後一個」元素，每種集合寫法都不一樣。

```java
// ❌ Java 21 之前
list.get(0);                                    // List
list.get(list.size() - 1);                      // List 的最後一個
linkedHashSet.iterator().next();                // Set 的第一個
// LinkedHashSet 的最後一個？只能整個迭代一遍！
deque.peekFirst();                              // Deque
treeMap.firstKey();                             // SortedMap
```

```java
// ✅ Java 21：統一的介面
list.getFirst();
list.getLast();
linkedHashSet.getFirst();
linkedHashSet.getLast();
linkedHashMap.firstEntry();
linkedHashMap.lastEntry();

// 反轉檢視（不複製，是同一份資料的另一個視角）
for (var todo : todos.reversed()) { }

list.addFirst(todo);
list.removeLast();
```

新介面：`SequencedCollection`、`SequencedSet`、`SequencedMap`。
`List`、`Deque`、`LinkedHashSet`、`SortedSet` 都自動獲得這些方法。

> ⚠️ **`getFirst()` 在空集合上丟 `NoSuchElementException`**，
> 不是回傳 `null`（和 `list.get(0)` 的 `IndexOutOfBoundsException` 不同）。
> 這是刻意的——`Deque.peekFirst()` 回傳 `null` 的設計已經被證明容易出錯。

### `Stream.toList()`（Java 16）

```java
// 之前
List<String> titles = todos.stream().map(Todo::title).collect(Collectors.toList());

// 現在
List<String> titles = todos.stream().map(Todo::title).toList();
```

**但要知道差別：**

| | `collect(toList())` | `toList()` | `collect(toUnmodifiableList())` |
|---|---|---|---|
| 可修改 | ✅（通常是 `ArrayList`） | ❌ **不可修改** | ❌ |
| 允許 `null` 元素 | ✅ | ✅ | ❌ **丟 NPE** |
| 保證的型別 | 沒有保證（實務上是 ArrayList） | 沒有保證 | 沒有保證 |

```java
var list = Stream.of("a", "b").toList();
list.add("c");          // ❌ UnsupportedOperationException
```

> 這個差異咬過很多人：把 `collect(toList())` 全域取代成 `toList()` 之後，
> 某個「拿到清單再排序」的地方就爆炸了。
> **`toList()` 之後要修改的話，包一層 `new ArrayList<>(...)`。**

### `String` 的新方法

```java
"  ".isBlank();                     // true（Java 11）——比 trim().isEmpty() 好
"  文字  ".strip();                  // "文字"（Java 11）——認得 Unicode 空白，trim() 不認得
"文字".repeat(3);                    // "文字文字文字"（Java 11）
"a\nb\nc".lines().toList();          // [a, b, c]（Java 11）——不含換行符
"Hi %s".formatted("Bob");            // "Hi Bob"（Java 15）
"a-b-c".split("-");                  // 老朋友
```

第 07 章 7.3 節講過 `strip()` vs `trim()`：
`trim()` 只去掉 `<= U+0020` 的字元，**認不得全形空白 `　`（U+3000）**。
`strip()` 用 `Character.isWhitespace`，認得。**一律用 `strip()`。**

### 好用的小工具

```java
// Objects：處理 null 的預設值
Objects.requireNonNullElse(title, "(無標題)");                    // Java 9
Objects.requireNonNullElseGet(config, DefaultConfig::new);        // 延遲求值
Objects.requireNonNull(clock, "clock 不可為 null");                // Java 7，最常用

// HexFormat（Java 17）：取代手寫的 byte[] → hex 迴圈
HexFormat.of().formatHex(digest);                    // "a3f5b8c2..."
HexFormat.of().withUpperCase().withDelimiter(":").formatHex(mac);   // "A3:F5:B8"
HexFormat.of().parseHex("a3f5b8");                   // byte[]

// Math（Java 21）
Math.clamp(value, 0, 100);                           // 限制在範圍內
Math.floorDiv(-7, 2);                                // -4（不是 -3）
Math.toIntExact(someLong);                           // 溢位就丟例外（第 01 章 1.5 節）

// Files（Java 11）
String content = Files.readString(path, StandardCharsets.UTF_8);
Files.writeString(path, content, StandardCharsets.UTF_8);
```

### `Optional` 的補充方法

```java
optional.or(() -> anotherOptional);          // Java 9：空的話換一個 Optional
optional.stream();                           // Java 9：轉成 0 或 1 個元素的 Stream
optional.ifPresentOrElse(this::use, this::handleEmpty);   // Java 9
optional.isEmpty();                          // Java 11：比 !isPresent() 好讀
```

`Optional.stream()` 的經典用途——過濾掉空值並攤平：

```java
// 把一堆 id 查出來，忽略查不到的
List<Todo> found = ids.stream()
        .map(repository::findById)      // Stream<Optional<Todo>>
        .flatMap(Optional::stream)      // Stream<Todo>，空的自動消失
        .toList();
```

### 集合工廠（Java 9）

```java
List.of("a", "b", "c");                      // 不可變
Set.of(1, 2, 3);
Map.of("k1", "v1", "k2", "v2");              // 最多 10 組
Map.ofEntries(Map.entry("k", "v"), ...);     // 更多組時
List.copyOf(existing);                       // 不可變複本（第 05 章 5.10 節）
```

> ⚠️ **三個要記住的特性**：
> ① **不接受 `null`**（會丟 NPE）——這是刻意的。
> ② **不可修改**（`add` / `remove` 丟 `UnsupportedOperationException`）。
> ③ **`Set.of` / `Map.of` 的迭代順序是隨機化的**（每次 JVM 啟動不同）——
>    刻意的，防止你依賴未定義的順序。第 11 章 11.18 節那個 flaky test 的來源之一。

### Java 25 的新東西（先知道，不急著用）

Java 25 是 Java 21 之後的下一個 LTS。幾個和寫程式方式有關的：

**① 精簡原始檔與實例 main 方法**——讓入門程式不用寫 `class` 和 `String[] args`：

```java
// Hello.java —— 這是完整的檔案內容
void main() {
    IO.println("Hello, World!");
}
```

```bash
java Hello.java
```

主要是為了教學與腳本，**正式專案還是寫完整的類別**。

**② 模組匯入宣告**——一行匯入整個模組的公開套件：

```java
import module java.base;      // 取代一堆 java.util.*、java.io.* 的 import
```

**③ 彈性建構子本體**——`super()` 之前可以有陳述式：

```java
public class Sub extends Base {
    public Sub(int value) {
        if (value < 0) {                    // 以前這行不能寫在 super() 之前
            throw new IllegalArgumentException("不可為負");
        }
        super(value);
    }
}
```

> 這三個都不影響既有程式碼。**知道它們存在就好**，
> 等你的專案升到 Java 25 再考慮採用。
> 升級前一定要看官方的 release notes——本書寫作時的資訊可能已經有變動。

### 一個消失了的特性：字串樣板

Java 21／22 有過 `STR."Hello \{name}"` 的預覽功能，後來被移除重新設計。
**目前沒有可用的正式版本**，看到舊教學不要跟著寫。

> 這也是一個提醒：**預覽功能（preview feature）不要用在正式專案。**
> 它們需要 `--enable-preview` 旗標，而且**下一個版本就可能改或消失**——
> 字串樣板就是活生生的例子。
>
> 第 08 章 8.15 節的結構化併發也是同樣的狀況。

---

## 12.14 版本對照：你現在能用什麼

```
Java 8  (2014, LTS)  ── lambda、Stream、Optional、java.time、介面 default 方法
                        ⚠️ 仍有大量企業系統停在這裡
Java 9  (2017)       ── 模組系統、List.of/Set.of/Map.of、Optional.or/stream、
                        私有介面方法、Stream.takeWhile/dropWhile
Java 10 (2018)       ── var
Java 11 (2018, LTS)  ── String.isBlank/strip/lines/repeat、Files.readString/writeString、
                        HttpClient、單檔案執行、lambda 參數的 var
Java 14 (2020)       ── switch expression（正式）、有用的 NPE 訊息
Java 15 (2020)       ── 文字區塊（正式）、String.formatted
Java 16 (2021)       ── record（正式）、instanceof 模式（正式）、Stream.toList
Java 17 (2021, LTS)  ── sealed（正式）、HexFormat、強封裝 JDK 內部 API
                        ⚠️ 目前企業的主流基準
Java 21 (2023, LTS)  ── switch 模式比對（正式）、record pattern（正式）、
                        虛擬執行緒、Sequenced Collections、Math.clamp
                        ⚠️ 新專案的建議起點
Java 22 (2024)       ── 未具名變數與模式 `_`（正式）
Java 25 (2025, LTS)  ── 精簡原始檔與實例 main、模組匯入宣告、彈性建構子本體、
                        Scoped Values（正式）、精簡物件標頭
```

### 「我的專案能用什麼」決策

| 你的基準版本 | 這一章可以用的 |
|---|---|
| **Java 8** | ❌ 都不行。**升級的優先度高於任何重構**（第 00 章 0.4 節） |
| **Java 11** | `var`、`String` 新方法、`Files.readString` |
| **Java 17** | ➕ 文字區塊、`record`、`instanceof` 模式、`sealed`、`Stream.toList` |
| **Java 21** | ➕ switch 模式比對、record pattern、Sequenced Collections、虛擬執行緒 |
| **Java 25** | ➕ 上面全部，加上 Java 25 的新東西 |

> 🔑 **這一章最大的收益（sealed + switch 模式比對 + record pattern）
> 需要 Java 21。**
>
> 如果你的專案停在 Java 8 或 11，那**升級版本比學新語法更重要**——
> 而且升級同時會帶來 GC 改善（第 09 章 9.9 節）、
> 虛擬執行緒（第 08 章 8.14 節）、更好的 NPE 訊息、
> 以及持續的安全性修補（第 10 章 10.17 節）。

### 怎麼確認專案的基準版本

```bash
# 專案設定的目標版本（第 10 章 10.4 節）
./mvnw help:evaluate -Dexpression=maven.compiler.release -q -DforceStdout

# 實際編譯用的 JDK
./mvnw -v

# 已編譯的 class 檔是哪個版本
javap -verbose -p target/classes/com/example/todo/model/Todo.class | grep major
# major version: 65 → Java 21（61 = 17、55 = 11、52 = 8）
```

class 檔版本對照：**44 + Java 版本**。
所以 52 = Java 8、55 = 11、61 = 17、65 = 21、69 = 25。

---

## 12.15 什麼時候不要用這些特性

這一節可能比前面十四節加起來更重要。

### 一個反面教材

```java
// ❌ 每個特性都用上了，但沒有一個是必要的
public sealed interface Result<T> permits Ok, Err { }
public record Ok<T>(T value) implements Result<T> { }
public record Err<T>(String message) implements Result<T> { }

public Result<String> getName(Object obj) {
    var r = switch (obj) {
        case null -> new Err<String>("null");
        case String s when !s.isBlank() -> new Ok<>(s);
        case String s -> new Err<String>("blank");
        default -> new Err<String>("wrong type");
    };
    return r;
}

// 呼叫端
var result = getName(input);
String name = switch (result) {
    case Ok<String>(String v) -> v;
    case Err<String>(String m) -> throw new IllegalArgumentException(m);
};
```

原本需要的東西：

```java
// ✅ 這樣就好
public String getName(Object obj) {
    if (obj instanceof String s && !s.isBlank()) {
        return s;
    }
    throw new IllegalArgumentException("需要非空白的字串，收到：" + obj);
}
```

**新特性的成本不是零。** 每一個都增加：讀者需要理解的概念、
新人上手的時間、code review 的負擔、以及「這裡為什麼要這麼複雜」的疑問。

### 五個「不要用」的判準

**① 團隊還不熟時，不要在關鍵路徑上首次採用**

新特性要學。在支付流程上第一次用 sealed，
出事時大家連「這段程式在做什麼」都要邊查邊看。

**做法**：先在測試程式碼、內部工具、新的小模組上用。
熟了再進核心。

**② 「省了幾行」不是理由，「編譯器會抓錯」才是**

| 特性 | 真正的價值 | 只是「省字」的部分 |
|---|---|---|
| `record` | 序列化走建構子、可解構、配 sealed 可窮盡 | 少寫 `equals`/`hashCode` |
| `sealed` | **窮盡性檢查** | — |
| switch 模式 | **窮盡性 + dominance 檢查** | 少寫轉型 |
| `var` | — | 少寫型別 |
| 文字區塊 | 少一類跳脫錯誤 | 好看 |

**排序**：`sealed` + switch 模式 > `record` > 文字區塊 > `var`。
如果你的重構時間有限，**從能帶來編譯期檢查的開始**。

**③ 不要為了用而重構能跑的程式碼**

一個穩定跑了三年、沒人動過、沒有 bug 的類別，
把它從普通類別改成 `record` 的收益是**零**，風險是**大於零**。

**做法**：**改到那裡的時候順手改**（boy scout rule）。
不要開一個「現代化重構」的 ticket 去掃全專案。

> 例外：如果你有第 11 章那種測試安全網，成本會低很多。
> 但即使如此，優先順序還是應該排在「有 bug 的地方」和「常改的地方」之後。

**④ 別人要讀的公開 API，改動要更保守**

把一個 public 類別改成 `record`：

- `getTitle()` 變成 `title()` → **所有使用者都要改**
- 類別變成 `final` → **繼承它的人編不過**
- 這是 **breaking change**，需要主版本號（第 10 章 10.3 節）

**做法**：內部類別可以直接改；對外 API 要走廢棄流程
（`@Deprecated(forRemoval = true, since = "2.0")` → 下下個版本才移除）。

**⑤ `var` 特別容易被濫用**

它是這幾個特性裡**唯一沒有帶來編譯期保證**的。
它純粹是可讀性的取捨，而可讀性是主觀的。

**做法**：訂一條線（12.3 節有我的版本），寫進 code review 檢查表，
不要每次都辯論。

### 一份採用順序建議

如果你要在既有專案引入這些特性，我的順序是：

```
1. 文字區塊          風險最低，SQL / JSON 立刻變好讀，不改任何行為
2. record（新的 DTO）  只用在新寫的 DTO 上，不動舊程式碼
3. instanceof 模式    改起來機械化，IDE 可以自動轉換
4. switch expression  把既有的 switch statement 轉成 expression，
                      **這一步會立刻抓出幾個沒處理的 enum 值**
5. sealed             用在新的「結果型別」「狀態」上
6. switch 模式比對    有 sealed 之後自然會用到
7. record pattern     最後，而且只在巢狀資料上用
8. var                隨時，但要先有團隊約定
```

**第 4 步通常會有驚喜。** 把 `switch (status) { case A: ... }`
轉成 expression 之後，編譯器會告訴你「你沒處理 `CANCELLED`」——
而那個 bug 已經在正式環境跑了兩年。

---
## 12.16 練習專案：用 `record` + `sealed` 重寫 Todo

現在把整章用在專案上。目標不是「用到每個特性」，
而是**只在能帶來實質好處的地方改**，並且用第 11 章的測試證明沒改壞。

### 改什麼、不改什麼

| 型別 | 改嗎 | 理由 |
|---|---|---|
| `Priority` | ❌ 保持 `enum` | 三個標籤，結構相同——12.8 節的判準，enum 就是對的 |
| `ErrorCode` | ❌ 保持 `enum` | 同上 |
| `Todo` | ✅ 改成 `record` | 見下方的取捨討論 |
| **完成狀態** | ✅ 新增 `sealed interface Completion` | 消滅 `null`（12.12 節） |
| CLI 指令 | ✅ 新增 `sealed interface Command` | 窮盡性檢查（12.10 節） |
| `TodoRepository` | ❌ 保持介面 | 它是行為抽象，不是資料 |
| `TodoService` | ⚠️ 小改 | 因為 `Todo` 變不可變，`markDone` 要改成回傳新物件 |
| 例外類別 | ❌ 保持普通類別 | 例外必須繼承 `Throwable`，record 不能繼承 |

### `Completion`：完成狀態

12.12 節那個 `Completion` 直接搬過來用，這裡放最終版：

```java
package com.example.todo.model;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * 待辦事項的完成狀態。
 *
 * <p>取代原本的「boolean done + 可能為 null 的 completedAt」：
 * 型別上不可能建立出 (done=true, completedAt=null) 這種無效狀態。
 */
public sealed interface Completion {

    /** 未完成 */
    record Pending() implements Completion {
        static final Pending INSTANCE = new Pending();
    }

    /** 已完成，一定有時間 */
    record Done(Instant at) implements Completion {
        public Done {
            Objects.requireNonNull(at, "完成時間不可為 null");
        }
    }

    /** 已取消，有時間也有原因 */
    record Cancelled(Instant at, String reason) implements Completion {
        public Cancelled {
            Objects.requireNonNull(at, "取消時間不可為 null");
            reason = reason == null ? "" : reason.strip();
            if (reason.isEmpty()) {
                throw new IllegalArgumentException("取消原因不可為空白");
            }
        }
    }

    static Completion pending() {
        return Pending.INSTANCE;
    }

    static Completion done(Instant at) {
        return new Done(at);
    }

    static Completion cancelled(Instant at, String reason) {
        return new Cancelled(at, reason);
    }

    default boolean isPending() {
        return this instanceof Pending;
    }

    default boolean isDone() {
        return this instanceof Done;
    }

    default boolean isFinished() {
        return !isPending();
    }

    /** 結束時間。未完成時是空的——不用 null */
    default Optional<Instant> finishedAt() {
        return switch (this) {
            case Pending() -> Optional.empty();
            case Done(Instant at) -> Optional.of(at);
            case Cancelled(Instant at, String ignored) -> Optional.of(at);
        };
    }

    /** 顯示用的短標籤 */
    default String label() {
        return switch (this) {
            case Pending() -> "待辦";
            case Done(Instant ignored) -> "完成";
            case Cancelled(Instant ignored, String ignoredReason) -> "取消";
        };
    }
}
```

### `Todo`：從 150 行到 60 行

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;
import com.example.todo.exception.TodoAlreadyDoneException;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Set;

/**
 * 待辦事項。不可變——所有「修改」都回傳新實例。
 *
 * @param completion 完成狀態。永遠不為 null（未完成時是 {@link Completion.Pending}）
 * @param tags       標籤。建構時會複製並轉為不可變
 */
public record Todo(
        long id,
        String title,
        Priority priority,
        Instant createdAt,
        Completion completion,
        Set<String> tags) {

    public static final int MAX_TITLE_LENGTH = 100;
    public static final int MAX_TAGS = 5;

    /** 驗證 + 正規化 + 防禦性複製，全部在這裡（12.6 節） */
    public Todo {
        if (id <= 0) {
            throw new InvalidTodoException("id 必須是正整數，收到：" + id);
        }
        Objects.requireNonNull(priority, "priority 不可為 null");
        Objects.requireNonNull(createdAt, "createdAt 不可為 null");
        Objects.requireNonNull(completion, "completion 不可為 null");

        title = title == null ? "" : title.strip();
        if (title.isEmpty()) {
            throw new InvalidTodoException("標題不可為空白");
        }
        if (title.length() > MAX_TITLE_LENGTH) {
            throw new InvalidTodoException(
                    "標題不可超過 %d 字，收到 %d 字".formatted(MAX_TITLE_LENGTH, title.length()));
        }

        tags = normalizeTags(tags);
    }

    /** 常用的建構捷徑：新建立的事項一定是未完成、沒有標籤 */
    public Todo(long id, String title, Priority priority, Instant createdAt) {
        this(id, title, priority, createdAt, Completion.pending(), Set.of());
    }

    private static Set<String> normalizeTags(Set<String> raw) {
        if (raw == null) {
            return Set.of();
        }
        var normalized = new LinkedHashSet<String>();
        for (String tag : raw) {
            String trimmed = tag == null ? "" : tag.strip().toLowerCase();
            if (trimmed.isEmpty()) {
                throw new InvalidTodoException("標籤不可為空白");
            }
            normalized.add(trimmed);
        }
        if (normalized.size() > MAX_TAGS) {
            throw new InvalidTodoException("標籤最多 " + MAX_TAGS + " 個，收到 " + normalized.size());
        }
        return Set.copyOf(normalized);      // 不可變 + 防禦性複製（12.6 節）
    }

    // ── 查詢（從元件算出來，不新增狀態） ──

    public boolean isDone() {
        return completion.isDone();
    }

    public boolean isPending() {
        return completion.isPending();
    }

    // ── 狀態轉換：回傳新實例（12.6 節的 wither） ──

    public Todo markDone(Instant at) {
        if (completion.isFinished()) {
            throw new TodoAlreadyDoneException(id);
        }
        return new Todo(id, title, priority, createdAt, Completion.done(at), tags);
    }

    public Todo cancel(Instant at, String reason) {
        if (completion.isFinished()) {
            throw new TodoAlreadyDoneException(id);
        }
        return new Todo(id, title, priority, createdAt, Completion.cancelled(at, reason), tags);
    }

    public Todo withTitle(String newTitle) {
        return new Todo(id, newTitle, priority, createdAt, completion, tags);
    }

    public Todo withPriority(Priority newPriority) {
        return new Todo(id, title, newPriority, createdAt, completion, tags);
    }

    public Todo withTag(String tag) {
        var merged = new LinkedHashSet<>(tags);
        merged.add(tag == null ? "" : tag.strip().toLowerCase());
        return new Todo(id, title, priority, createdAt, completion, merged);
    }

    /** CLI 顯示用的一行（和第 02 章相同，只是資料來源換成 completion） */
    public String toDisplayLine() {
        String tagPart = tags.isEmpty() ? "" : " " + tags;
        return "%s #%-3d [%s] %s%s".formatted(
                isDone() ? "[x]" : "[ ]", id, priority.label(), title, tagPart);
    }

    /** 不印出全部元件——tags 可能很長，log 會很吵（12.5 節） */
    @Override
    public String toString() {
        return "Todo[id=%d, title=%s, priority=%s, %s]"
                .formatted(id, title, priority, completion.label());
    }
}
```

**60 行，其中約 35 行是驗證與狀態轉換的真實邏輯。**
`equals`、`hashCode`、六個存取器、建構子賦值——全部消失了。

### ⚠️ 一個真正的行為改變：`equals`

第 02 章的 `Todo` 是這樣：

```java
@Override
public boolean equals(Object o) {
    return o instanceof Todo other && id == other.id;      // 只比 id
}
```

改成 record 之後，`equals` **比較所有元件**。這是**行為改變**，不是重構。

而且——**第 11 章的測試立刻抓到了：**

```
[ERROR] TodoTest$Equality.equalsById:412
Expecting actual:
  Todo[id=1, title=買牛奶, priority=HIGH, 待辦]
to be equal to:
  Todo[id=1, title=完全不同, priority=LOW, 待辦]
but was not.

[ERROR] TodoTest$Equality.worksInHashSet:437
Expecting actual: 2  to be equal to: 1
```

> 🔑 **這正是第 11 章那個安全網的價值。**
> 沒有測試的話，這個改動會安靜地通過 code review，
> 然後在某個「用 `Set<Todo>` 去重」的地方造成資料重複。
>
> **有測試的話，你在改的當下就被迫做一個明確的決定。**

**這裡我們要做的決定是：`Todo` 到底是「值」還是「東西」？**（12.7 節的判準）

三個選項：

| 選項 | 做法 | 代價 |
|---|---|---|
| **A. 接受值語意** | 刪掉 `equalsById` / `worksInHashSet` 測試，改寫成驗證值語意 | 需要「依 id 去重」的地方要改成 `Map<Long, Todo>` 或 `toMap(Todo::id, ...)` |
| **B. 覆寫 `equals`** | 在 record 裡手寫只比 id 的 `equals`/`hashCode` | 樣板程式碼回來了，而且違反 record 的預期語意（12.7 節②） |
| **C. 不改 `Todo`** | 保持普通類別 | 少了 60 行的簡化 |

**我選 A**，理由：

1. 檢查全專案，實際依賴 id-equals 的只有兩個地方（`FakeTodoRepository` 的
   內部 `Map` 已經是用 id 當 key，`TodoStatistics` 用的是 `groupingBy`）——
   **它其實沒有被依賴，只是「以為需要」。**
2. 不可變 + 值語意讓併發（第 08 章）安全得多：`Todo` 現在可以自由跨執行緒共享。
3. 值語意讓測試更好寫：`assertThat(actual).isEqualTo(expected)` 直接比全部欄位，
   不需要 `usingRecursiveComparison`（第 11 章 11.6 節那個陷阱消失了）。

**測試改成這樣：**

```java
@Nested
@DisplayName("equals / hashCode")
class Equality {

    @Test
    @DisplayName("所有元件都相同才相等（值語意）")
    void equalsByAllComponents() {
        Todo a = new Todo(1L, "買牛奶", Priority.HIGH, NOW);
        Todo b = new Todo(1L, "買牛奶", Priority.HIGH, NOW);

        assertThat(a).isEqualTo(b).hasSameHashCodeAs(b);
    }

    @Test
    @DisplayName("id 相同但內容不同就不相等——這和舊版的實體語意不同")
    void sameIdDifferentContentIsNotEqual() {
        Todo a = new Todo(1L, "買牛奶", Priority.HIGH, NOW);
        Todo b = new Todo(1L, "完全不同", Priority.LOW, NOW);

        assertThat(a).isNotEqualTo(b);
    }

    @Test
    @DisplayName("wither 產生的是新物件，原物件不變")
    void withersDoNotMutate() {
        Todo original = new Todo(1L, "買牛奶", Priority.LOW, NOW);

        Todo upgraded = original.withPriority(Priority.HIGH);

        assertThat(original.priority()).isEqualTo(Priority.LOW);
        assertThat(upgraded.priority()).isEqualTo(Priority.HIGH);
        assertThat(upgraded).isNotSameAs(original);
    }

    @Test
    @DisplayName("要依 id 去重時，明確用 id 當 key")
    void deduplicateById() {
        var todos = java.util.List.of(
                new Todo(1L, "原本", Priority.HIGH, NOW),
                new Todo(1L, "換個標題", Priority.LOW, NOW));

        var byId = todos.stream().collect(
                java.util.stream.Collectors.toMap(Todo::id, t -> t, (first, second) -> second));

        assertThat(byId).hasSize(1);
        assertThat(byId.get(1L).title()).isEqualTo("換個標題");
    }
}
```

> **最後那個測試很重要**：它把「依 id 去重」這個需求**明確寫出來**，
> 而不是隱含地依賴 `equals` 的行為。這其實比原本的設計更清楚——
> 讀者一眼看到「這裡是刻意依 id 去重的」。

### `TodoService`：跟著改成不可變

```java
package com.example.todo.service;

import com.example.todo.exception.TodoNotFoundException;
import com.example.todo.model.Completion;
import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;

import java.time.Clock;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

public class TodoService {

    private final TodoRepository repository;
    private final Clock clock;
    private final Notifier notifier;

    public TodoService(TodoRepository repository, Clock clock, Notifier notifier) {
        this.repository = Objects.requireNonNull(repository, "repository");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.notifier = Objects.requireNonNull(notifier, "notifier");
    }

    public Todo add(String title, Priority priority) {
        Todo todo = new Todo(repository.nextId(), title, priority, clock.instant());
        Todo saved = repository.save(todo);
        notifier.notifyCreated(saved);
        return saved;
    }

    /** 冪等：已結束的事項再標記完成，直接回傳現況（第 11 章 11.2 節的需求） */
    public Todo markDone(long id) {
        Todo todo = find(id);
        if (todo.completion().isFinished()) {
            return todo;
        }
        // ⚠️ 這裡是最大的改動：markDone 回傳新物件，要把它存回去
        Todo completed = todo.markDone(clock.instant());
        Todo saved = repository.save(completed);
        notifier.notifyDone(saved);
        return saved;
    }

    public Todo cancel(long id, String reason) {
        Todo todo = find(id);
        if (todo.completion().isFinished()) {
            return todo;
        }
        return repository.save(todo.cancel(clock.instant(), reason));
    }

    public void remove(long id) {
        if (!repository.deleteById(id)) {
            throw new TodoNotFoundException(id);
        }
    }

    public List<Todo> findAll() {
        return repository.findAll().stream()
                .sorted(Comparator.comparing((Todo t) -> t.completion().isFinished())
                        .thenComparing(t -> -t.priority().weight())
                        .thenComparing(Todo::createdAt))
                .toList();
    }

    public List<Todo> findPending() {
        return findAll().stream().filter(Todo::isPending).toList();
    }

    private Todo find(long id) {
        return repository.findById(id).orElseThrow(() -> new TodoNotFoundException(id));
    }
}
```

> 🔑 **`Todo completed = todo.markDone(...); repository.save(completed);` 這個模式
> 是不可變物件的核心差異。**
>
> 舊版的 `todo.markDone(now)` 直接改物件，然後 `repository.save(todo)` 只是「通知」——
> 事實上如果 repository 是記憶體版，**連 `save` 都可以不呼叫**（物件已經被改了）。
>
> 這其實是舊設計的一個隱藏 bug 來源：
> **「改了物件但忘記 save」在記憶體版會過，換成 JSON 檔案版就資料遺失。**
> 不可變版本強迫你把新物件存回去，否則改動就消失了——**編譯器和邏輯都會提醒你**。

### `Command`：CLI 指令的窮盡性

```java
package com.example.todo.cli;

import com.example.todo.model.Priority;

/** 解析後的指令。sealed → execute 的 switch 有窮盡性檢查（12.10 節）。 */
public sealed interface Command {

    record Add(String title, Priority priority) implements Command { }

    record List(boolean includeDone) implements Command { }

    record Done(long id) implements Command { }

    record Cancel(long id, String reason) implements Command { }

    record Remove(long id) implements Command { }

    record Help() implements Command { }

    record Version() implements Command { }
}
```

```java
package com.example.todo.cli;

import com.example.todo.model.Priority;

import java.util.Arrays;
import java.util.Locale;

/** 把 String[] 變成 Command。所有參數錯誤都在這裡被攔下來。 */
public final class CommandParser {

    private CommandParser() {
    }

    public static Command parse(String[] args) {
        if (args.length == 0) {
            return new Command.Help();
        }

        String[] rest = Arrays.copyOfRange(args, 1, args.length);

        return switch (args[0]) {
            case "add" -> parseAdd(rest);
            case "list" -> new Command.List(hasFlag(rest, "--all"));
            case "done" -> new Command.Done(parseId(rest, "todo done <id>"));
            case "cancel" -> parseCancel(rest);
            case "remove", "rm" -> new Command.Remove(parseId(rest, "todo remove <id>"));
            case "--help", "-h", "help" -> new Command.Help();
            case "--version", "-v", "version" -> new Command.Version();
            default -> throw new IllegalArgumentException("未知的指令：" + args[0]);
        };
    }

    private static Command parseAdd(String[] args) {
        if (args.length == 0) {
            throw new IllegalArgumentException(
                    "用法：todo add <標題> [--priority HIGH|MEDIUM|LOW]");
        }
        Priority priority = Priority.MEDIUM;
        for (int i = 1; i < args.length - 1; i++) {
            if ("--priority".equals(args[i])) {
                priority = parsePriority(args[i + 1]);
            }
        }
        return new Command.Add(args[0], priority);
    }

    private static Command parseCancel(String[] args) {
        long id = parseId(args, "todo cancel <id> <原因>");
        if (args.length < 2) {
            throw new IllegalArgumentException("用法：todo cancel <id> <原因>");
        }
        return new Command.Cancel(id, args[1]);
    }

    private static boolean hasFlag(String[] args, String flag) {
        return Arrays.asList(args).contains(flag);
    }

    private static long parseId(String[] args, String usage) {
        if (args.length == 0) {
            throw new IllegalArgumentException("用法：" + usage);
        }
        try {
            return Long.parseLong(args[0]);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("id 必須是數字，收到：" + args[0], e);
        }
    }

    private static Priority parsePriority(String raw) {
        try {
            return Priority.valueOf(raw.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(
                    "優先度必須是 HIGH / MEDIUM / LOW，收到：" + raw, e);
        }
    }
}
```

### `App`：用模式比對分派

```java
    int run(String[] args) {
        try {
            return execute(CommandParser.parse(args));

        } catch (TodoException e) {
            err.printf("錯誤 [%s] %s%n", e.errorCode().code(), e.getMessage());
            log.debug("業務例外", e);
            return EXIT_USER_ERROR;

        } catch (IllegalArgumentException e) {
            err.println("參數錯誤：" + e.getMessage());
            err.println("用 todo --help 看說明。");
            return EXIT_USER_ERROR;

        } catch (Exception e) {
            log.error("未預期的錯誤", e);
            err.println("發生未預期的錯誤，詳情請看 ~/.todo/logs/todo.log");
            err.println("版本：" + BuildInfo.describe());
            return EXIT_SYSTEM_ERROR;
        }
    }

    /** 沒有 default——新增 Command 時這裡會編譯失敗（12.11 節） */
    private int execute(Command command) {
        return switch (command) {

            case Command.Add(String title, Priority priority) -> {
                Todo created = service.add(title, priority);
                out.printf("已新增 #%d %s%n", created.id(), created.title());
                yield EXIT_OK;
            }

            case Command.List(boolean includeDone) -> {
                printTodos(includeDone ? service.findAll() : service.findPending());
                yield EXIT_OK;
            }

            case Command.Done(long id) -> {
                Todo done = service.markDone(id);
                out.printf("已標記完成 #%d %s%n", done.id(), done.title());
                yield EXIT_OK;
            }

            case Command.Cancel(long id, String reason) -> {
                Todo cancelled = service.cancel(id, reason);
                out.printf("已取消 #%d（%s）%n", cancelled.id(), reason);
                yield EXIT_OK;
            }

            case Command.Remove(long id) -> {
                service.remove(id);
                out.println("已刪除。");
                yield EXIT_OK;
            }

            case Command.Help() -> {
                printUsage();
                yield EXIT_OK;
            }

            case Command.Version() -> {
                out.println(BuildInfo.describe());
                yield EXIT_OK;
            }
        };
    }

    private void printTodos(java.util.List<Todo> todos) {
        if (todos.isEmpty()) {
            out.println("目前沒有待辦事項。");
            return;
        }
        out.printf("%-5s %-8s %-6s %-16s %s%n", "ID", "優先", "狀態", "建立時間", "標題");
        out.println("─".repeat(70));
        for (Todo t : todos) {
            out.printf("%-5d %-8s %-6s %-16s %s%n",
                    t.id(),
                    t.priority(),
                    t.completion().label(),                      // 不用 if (isDone) 了
                    DISPLAY.format(t.createdAt().atZone(displayZone)),
                    t.title());
        }
        out.printf("%n共 %d 筆%n", todos.size());
    }
```

**新增 `Command.Tag(long id, String tag)` 時會發生什麼：**

```
[ERROR] App.java:[87,16] the switch expression does not cover all possible input values
```

**編譯器直接指出來。** 對照第 10 章那個字串 switch 版本——
那時新增指令要記得改三個地方，漏了也沒人知道。

### `Json`：序列化 sealed 型別

`Completion` 是 sealed，Jackson 需要知道怎麼區分三種子型別。
用多型型別資訊（第 07 章 7.17 節說過「不要用 Default Typing」，
但**明確宣告的多型是安全的**）：

```java
package com.example.todo.model;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(
        use = JsonTypeInfo.Id.NAME,
        include = JsonTypeInfo.As.PROPERTY,
        property = "state")
@JsonSubTypes({
        @JsonSubTypes.Type(value = Completion.Pending.class, name = "PENDING"),
        @JsonSubTypes.Type(value = Completion.Done.class, name = "DONE"),
        @JsonSubTypes.Type(value = Completion.Cancelled.class, name = "CANCELLED")
})
public sealed interface Completion {
    // ... 同上
}
```

產生的 JSON：

```json
{
  "id": 1,
  "title": "買牛奶",
  "priority": "HIGH",
  "createdAt": "2026-08-17T10:00:00Z",
  "completion": { "state": "DONE", "at": "2026-08-17T11:30:00Z" },
  "tags": ["購物"]
}
```

> ⚠️ **`@JsonSubTypes` 的名稱是資料格式的一部分。**
> 一旦有資料寫進檔案／資料庫，就**不能再改這些名稱**（會讀不回來）。
> 這和第 10 章 10.3 節「發佈的版本不可變」是同一類的相容性約束。
>
> 這也是「明確列出名稱」比「用類別全名」好的原因——
> 用全名的話，你連改套件名稱都會讓舊資料讀不回來。

### 前後對照

| | 之前 | 之後 | 差 |
|---|---|---|---|
| `Todo.java` | 152 行 | 118 行 | −34（且沒有手寫的 `equals`/`hashCode`/存取器） |
| 完成狀態表示 | `boolean` + 可為 null 的 `Instant` | `sealed Completion` | 無效狀態變成**不可能** |
| `App.dispatch` | `switch` 字串 + 6 個私有方法 | `CommandParser` + 窮盡的 `switch` | 新增指令有**編譯期檢查** |
| 需要 `null` 檢查的地方 | 7 處 | **0 處** | |
| 執行緒安全 | `Todo` 可變，跨執行緒要小心（第 08 章） | **不可變，可自由共享** | |
| 「改了但忘記 save」的 bug | 可能發生 | **不可能**（改動不存回去就消失） | |

### 驗收：跑第 11 章的測試

```bash
./mvnw -T 1C clean verify
```

```
[ERROR] Tests run: 83, Failures: 4, Errors: 0, Skipped: 0
[ERROR] TodoTest$Equality.equalsById:412 »  id 相同但內容不同，現在不相等了
[ERROR] TodoTest$Equality.worksInHashSet:437 » 期望 1 個，實際 2 個
[ERROR] TodoTest$MarkDone.marksDone:301 » markDone 現在回傳新物件，原物件不變
[ERROR] TodoServiceWithFakeTest.markDonePersists:142 » completedAt() 方法不存在了
```

**四個失敗，全部都是「刻意的行為改變」——這正是我們要的。**

第 11 章 11.2 節說過：測試的價值在於**它讓你知道自己改了什麼**。
如果這次重構一個測試都沒紅，那反而可疑（表示那些行為根本沒被測到）。

逐一處理：

| 失敗的測試 | 處理方式 |
|---|---|
| `equalsById` | 改寫成 `sameIdDifferentContentIsNotEqual`（上面已寫） |
| `worksInHashSet` | 改寫成 `deduplicateById`（明確用 id 當 key） |
| `marksDone` | 改成斷言「回傳的新物件已完成，原物件不變」 |
| `markDonePersists` | `completedAt()` → `completion().finishedAt()` |

改完之後：

```
[INFO] Tests run: 85, Failures: 0, Errors: 0, Skipped: 0
[INFO] --- jacoco:0.8.12:check (check) @ todo-core ---
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
```

**其他 79 個測試一行都沒改就通過了**——這證明重構沒有意外的副作用。

### 除了測試，還有四個檔案要跟著改

`Todo` 從可變類別變成 record，**編譯器會直接把所有需要改的地方指出來**。
完整清單只有四處，而且每一處的修法都是同一個模式：
**「就地修改」變成「產生新物件」，「可能是 null」變成「問 `completion`」。**

| 檔案 | 編譯錯誤 | 修法 |
|---|---|---|
| `ConcurrentTodoImporter`（第 08 章） | `addTag(String)` 找不到 | `todo.addTag(t)` → `todo = todo.withTag(t)`（回傳值要接住！） |
| `TodoBuilder`（第 11 章） | `tags.forEach(todo::addTag)` 不是合法方法參考 | `for (String t : tags) todo = todo.withTag(t);` |
| `TodoAssert`（第 11 章） | `completedAt()` 找不到 | `actual.completion().finishedAt()`（回傳 `Optional<Instant>`） |
| `TodoServiceTest` / `TodoServiceWithFakeTest`（第 11 章） | 同上 | 同上 |

> 🔑 **注意這四個都是編譯錯誤，不是執行期錯誤。**
> 這就是 12.12 節那句話的實際兌現：**把「可能忘記」變成「編不過」。**
> 如果 `Todo` 還是可變的、`completedAt` 還是可能為 null，
> 這四處會安靜地繼續編譯 —— 然後在某個沒有測到的路徑上回傳 `null`。

> 🔑 **這一節真正想示範的不是「怎麼用 record」，
> 是「怎麼在有安全網的情況下做行為改變」：**
>
> 1. 改一小塊，跑測試。
> 2. 紅的測試逐一檢視：**這是 bug，還是刻意的改變？**
> 3. 是 bug → 修程式碼。是刻意的 → 改測試，**並在測試名稱裡寫清楚新行為**。
> 4. 綠了才做下一塊。
>
> 沒有第 11 章，這一章的重構就是一場賭博。

---

## 12.17 既有專案的遷移策略

上面是在一個 500 行的小專案上做的。50,000 行的專案怎麼辦？

### 原則：不要開「現代化」的 ticket

我看過最失敗的做法是：開一個 sprint 叫「Java 17 現代化」，
把全專案的類別都改成 record。結果：

- 一個 2,000 個檔案的 PR，沒人能 review。
- 混雜了真正的行為改變（`equals` 語意）和純粹的語法變更，看不出哪個是哪個。
- 衝到所有人正在進行的分支，合併地獄。
- 最後 revert，團隊對「現代化」產生反感。

### 五個階段

**階段 0：先升版本，什麼都不改**

```xml
<maven.compiler.release>21</maven.compiler.release>
```

只改這一行，然後：

```bash
./mvnw clean verify
```

修掉所有編譯錯誤與警告（通常是：被移除的 JDK 內部 API、
第三方函式庫版本不相容、`--illegal-access` 相關）。

**這一步就有回報，而且不需要改任何業務邏輯**：
更好的 GC（第 09 章 9.9 節）、更好的 NPE 訊息、安全性修補。

> **有用的旗標**：`-Xlint:all` + `--release` 會抓出很多潛在問題
> （第 10 章 10.4 節）。第一次跑會噴幾百個警告，先看
> `deprecation` 和 `removal` 這兩類。

**階段 1：文字區塊（零風險）**

SQL、JSON、HTML 的字串拼接改成文字區塊。

- 不改任何行為（產生的字串一模一樣，只要注意結尾換行）。
- IDE 有自動轉換（IntelliJ：Alt+Enter → "Replace with text block"）。
- 立即的可讀性回報。

**驗證方式**：改完跑測試。如果那段 SQL 沒有測試⋯⋯那是另一個問題。

**階段 2：新程式碼用新特性**

**從今天起，所有新寫的 DTO 用 record，所有新的結果型別用 sealed。**
既有程式碼一行不動。

在 code review 檢查表加一條：
「新增的資料類別是否可以用 record？」

這一步是**零風險、零成本**的，而且三個月後你會發現專案裡已經有不少 record 了。

**階段 3：`switch` statement → expression（高回報）**

這是**最值得主動做**的一步，因為它會找出真正的 bug。

```bash
# 找出所有 switch
grep -rn "switch (" --include=*.java src/main/java | wc -l
```

一個一個轉：

```java
// 之前
String label;
switch (status) {
    case ACTIVE: label = "啟用"; break;
    case SUSPENDED: label = "暫停"; break;
    default: label = "未知";
}

// 之後
String label = switch (status) {
    case ACTIVE -> "啟用";
    case SUSPENDED -> "暫停";
    case CLOSED -> "已關閉";          // ← 編譯器逼你補上的，之前落到 default「未知」
};
```

**經驗**：一個中型專案這樣掃一遍，通常會找出 3～10 個「某個 enum 值沒被處理」
的真實 bug。它們都躲在 `default` 後面。

> ⚠️ **這一步要小心 `default` 的既有行為。**
> 如果 `default` 原本有意義（例如「未來新增的狀態一律視為未知」），
> 就不要移除它。判斷方式：**問「這個 default 是刻意的策略，
> 還是只是為了讓編譯器閉嘴？」**

**階段 4：既有類別改 record / sealed（順手做）**

**只在你已經要改那個檔案的時候做。** 判斷順序：

```
這個類別我正在改嗎？
├─ 否 → 不要動
└─ 是 → 它有測試嗎？
        ├─ 否 → 先補測試（第 11 章），再考慮
        └─ 是 → 它是「值」還是「東西」？（12.7 節）
                ├─ 東西 → 保持普通類別
                └─ 值 → 它是 public API 的一部分嗎？
                        ├─ 是 → 走廢棄流程，或不改
                        └─ 否 → ✅ 改成 record
```

### 對外 API 的處理

如果 `getTitle()` 已經被別的團隊／別的 jar 使用，改成 `title()` 是破壞性變更。

**選項 A：加上相容方法（過渡期）**

```java
public record TodoDto(long id, String title) {

    /** @deprecated 改用 {@link #title()}。將於 3.0 移除。 */
    @Deprecated(since = "2.4", forRemoval = true)
    public String getTitle() {
        return title;
    }
}
```

**選項 B：不改**。如果一個 public API 已經穩定，
「省 30 行樣板」不值得讓所有使用者改程式碼。

> 第 10 章 10.3 節的語意化版本規則在這裡適用：
> **移除或改名 public 方法 = 主版本號 +1。** 這不是小事。

### 一個實用的檢查腳本

```bash
#!/usr/bin/env bash
# find-record-candidates.sh —— 找出可能適合改成 record 的類別
# 條件：所有欄位都是 final、有 equals/hashCode、沒有 setter、不是 @Entity
set -euo pipefail

find src/main/java -name "*.java" | while read -r f; do
  # 排除已經是 record 的、@Entity、抽象類別、介面
  grep -q "^public record\|@Entity\|abstract class\|^public interface" "$f" && continue

  has_equals=$(grep -c "public boolean equals(Object" "$f" || true)
  has_setter=$(grep -c "public void set[A-Z]" "$f" || true)
  non_final=$(grep -cE "^\s+private (?!final)[A-Za-z]" "$f" 2>/dev/null || true)

  if [ "$has_equals" -gt 0 ] && [ "$has_setter" -eq 0 ]; then
    lines=$(wc -l < "$f")
    echo "$lines  $f"
  fi
done | sort -rn | head -30
```

```
152  src/main/java/com/example/shop/model/OrderLine.java
118  src/main/java/com/example/shop/dto/CustomerResponse.java
 94  src/main/java/com/example/shop/model/Address.java
 ...
```

**行數最多的排前面**——那是收益最大的。
但**還是只在「你剛好要改那個檔案」時動手**。

> 這個腳本是**啟發式的**，會有誤判（例如有身分語意的實體）。
> 它的用途是「產生候選清單給人判斷」，不是「自動重構」。

### 用 ArchUnit 鎖住新規範

第 11 章 11.19 節的 ArchUnit 也可以用在這裡：

```java
@ArchTest
static final ArchRule DTO 應該是 record = classes()
        .that().resideInAPackage("..dto..")
        .and().haveSimpleNameEndingWith("Response")
        .should().beRecords()
        .because("對外的 DTO 是不可變的值物件（第 12 章 12.7 節）");

@ArchTest
static final ArchRule 實體不可以是 record = noClasses()
        .that().areAnnotatedWith(jakarta.persistence.Entity.class)
        .should().beRecords()
        .because("JPA 需要 no-arg 建構子與非 final 類別（第 12 章 12.7 節）");
```

**把團隊決定變成會失敗的測試**——第 10 章 enforcer、第 11 章 ArchUnit，
同一個哲學的第三次出現。

---
## 12.18 常見錯誤

| # | 錯誤 | 後果 | 正解 |
|---|------|------|------|
| 1 | 手寫 `equals`/`hashCode`，新增欄位時忘記更新 | `HashMap` 查不到、快取回傳錯的值，**編譯與測試都不會發現**（12.2 節） | 值物件用 `record`；不得已時用 IDE 重新產生並加測試 |
| 2 | `var list = new ArrayList<>()` | 推成 `ArrayList<Object>`，之後全部要轉型 | `var` 和鑽石運算子至少要有一邊寫出型別 |
| 3 | `var` 用在方法回傳值上 | 讀者要跳到方法定義才知道型別 | 右邊看不出型別就寫出來（12.3 節） |
| 4 | `var count = 0` 然後累加 `long` | 編譯錯誤，或更糟：溢位（第 01 章 1.5 節）而型別沒寫出來更難察覺 | 數值型別一律明寫 |
| 5 | 以為文字區塊會保留你寫的縮排 | 縮排被剝掉，SQL / YAML 格式跑掉 | 縮排由「最小共同縮排」決定，用結束的 `"""` 位置控制（12.4 節） |
| 6 | 文字區塊行尾的空白不見了 | 固定寬度報表對不齊 | 用 `\s` 明確保留 |
| 7 | 用文字區塊 + `formatted()` 組 SQL | **SQL injection** | 參數一律用 `?` 佔位符 |
| 8 | 跟著舊教學寫 `STR."Hello \{name}"` | 編譯失敗——字串樣板已被移除重新設計 | 用 `formatted()`（12.4 節） |
| 9 | `record` 有 `List` / `Map` 元件卻沒複製 | **外部可以改掉「不可變」物件的內容** | compact constructor 裡 `List.copyOf(...)`（12.6 節） |
| 10 | `record` 有陣列元件 | 自動產生的 `equals` 是**參考比較**，當 Map key 會查不到 | 手寫 `equals`/`hashCode` 用 `Arrays.equals`，或換成 `List` |
| 11 | `record` 含密碼 / token 但沒覆寫 `toString` | **明文密碼進 log**（12.5 節） | 一律覆寫 `toString` 遮蔽敏感欄位 |
| 12 | 把 JPA `@Entity` 寫成 `record` | 啟動失敗——JPA 需要 no-arg 建構子與非 final 類別 | `@Entity` 用普通類別，DTO 用 record（12.7 節） |
| 13 | 把有 id 身分的實體改成 `record` | `equals` 語意從「同一個東西」變成「內容相同」，去重邏輯壞掉 | 先判斷是「值」還是「東西」（12.7 節） |
| 14 | 期待 `record` 的 `double` 元件用 `==` 比較 | `NaN.equals(NaN)` 是 **true**，`0.0` 和 `-0.0` **不相等** | 知道它用 `Double.compare` 語意；金額本來就不該用 `double` |
| 15 | `sealed` 型別放在不同套件又沒有 `module-info.java` | `class X cannot extend a sealed class in a different package` | 放同一個套件，或同一個檔案裡用巢狀 record（12.8 節） |
| 16 | 對 enum / sealed 的 switch 加 `default` | **殺死窮盡性檢查**——新增值時不會編譯失敗，只會產生錯誤資料 | 不加 `default`；真的要加就在裡面丟例外（12.11 節） |
| 17 | 用 switch **statement** 而不是 expression | statement 不做窮盡性檢查，等於沒有保護 | 能用 expression 就用（12.11 節） |
| 18 | switch 傳 `null` 進去 | **NPE**——即使有 `default` 也接不到 | 明確寫 `case null`（12.9 節） |
| 19 | switch expression 的區塊裡寫 `return` | 編譯錯誤（`return` 是從方法返回） | 用 `yield` |
| 20 | 同一個 switch 混用 `->` 和 `:` | 編譯錯誤 | 整個 switch 一起改 |
| 21 | `case List<String> list` | 編譯錯誤——型別抹除讓執行期分不出泛型參數（第 05 章 5.17 節） | 用 `case List<?> list` |
| 22 | 模式的順序寫錯，把 `case Object o` 放前面 | 編譯錯誤（dominance 檢查）——這是好事 | 從最具體排到最一般 |
| 23 | 以為 `when` 子句算進窮盡性 | 編譯器說不窮盡，即使邏輯上涵蓋了全部 | 補一個沒有 `when` 的 fallback case |
| 24 | `Stream.toList()` 之後想排序 / 修改 | `UnsupportedOperationException`——它回傳不可修改的清單 | 包一層 `new ArrayList<>(...)`（12.13 節） |
| 25 | `List.of(...)` 傳 `null` 元素 | NPE | 用 `Arrays.asList` 或先過濾掉 `null` |
| 26 | 斷言 `Set.of(...)` 的迭代順序 | **每次 JVM 啟動順序都不同**（刻意隨機化），測試偶爾紅 | `containsExactlyInAnyOrder`（第 11 章 11.18 節） |
| 27 | `list.getFirst()` 在空集合上 | `NoSuchElementException`（不是回傳 `null`） | 先檢查 `isEmpty()`，或用 `stream().findFirst()` |
| 28 | 為了用新特性而重構穩定的舊程式碼 | 引入風險，收益是零 | 改到那裡時順手改（12.15 節） |
| 29 | 把 `getXxx()` 改成 `xxx()` 卻是 public API | **破壞性變更**，所有使用者編不過 | 走廢棄流程或不改（12.17 節） |
| 30 | 在正式專案用預覽功能（`--enable-preview`） | 下一版可能改或消失——字串樣板就是例子 | 預覽功能只用在實驗專案 |

---

## 12.19 本章練習

### 練習 1：選對型別

以下六個需求，各自該用 `record`、`enum`、`sealed interface` + `record`、
還是普通類別？說明理由，並寫出宣告。

```
A) HTTP 回應的狀態：2xx 成功（帶 body）、4xx 客戶端錯誤（帶錯誤碼與訊息）、
   5xx 伺服器錯誤（帶 trace id）、逾時（帶等待了多久）

B) 系統支援的三種匯出格式：CSV、JSON、Excel。每種有副檔名與 MIME type

C) 地理座標：緯度、經度

D) 使用者帳號：有 id、email、密碼雜湊、建立時間、最後登入時間、
   狀態（啟用/停用），email 和密碼可以被修改，會存進資料庫

E) 一個方法要同時回傳「處理成功幾筆」和「失敗的清單」

F) 一段時間區間：開始時間、結束時間，需要判斷「是否重疊」「是否包含某時刻」
```

<details>
<summary>參考解答</summary>

**A) `sealed interface` + `record`**

四種情況**攜帶的資料結構完全不同**——這是 12.8 節的判準。
而且處理它的地方需要窮盡性檢查（漏掉逾時的處理是很常見的 bug）。

```java
public sealed interface HttpOutcome {

    record Success(int status, String body) implements HttpOutcome {
        public Success {
            if (status < 200 || status >= 300) {
                throw new IllegalArgumentException("Success 的狀態碼必須是 2xx，收到 " + status);
            }
        }
    }

    record ClientError(int status, String errorCode, String message) implements HttpOutcome { }

    record ServerError(int status, String traceId) implements HttpOutcome { }

    record Timeout(java.time.Duration waited) implements HttpOutcome { }
}
```

用起來：

```java
public String describe(HttpOutcome outcome) {
    return switch (outcome) {
        case Success(int status, String body) -> "成功（%d，%d bytes）".formatted(status, body.length());
        case ClientError(int s, String code, String msg) -> "請求錯誤 %s：%s".formatted(code, msg);
        case ServerError(int s, String traceId) -> "伺服器錯誤，請提供 trace id：" + traceId;
        case Timeout(var waited) -> "逾時（等了 %d 秒）".formatted(waited.toSeconds());
    };
}
```

**B) `enum`**

三個選項，**每個攜帶相同結構的資料**（副檔名 + MIME type）——12.8 節的判準。
而且是固定的集合，適合用 `EnumMap` / `EnumSet`（第 05 章 5.12 節）。

```java
public enum ExportFormat {

    CSV("csv", "text/csv"),
    JSON("json", "application/json"),
    EXCEL("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    private final String extension;
    private final String mimeType;

    ExportFormat(String extension, String mimeType) {
        this.extension = extension;
        this.mimeType = mimeType;
    }

    public String extension() {
        return extension;
    }

    public String mimeType() {
        return mimeType;
    }

    public String fileName(String base) {
        return base + "." + extension;
    }
}
```

> 陷阱：如果之後每種格式需要**不同的匯出參數**
> （CSV 要分隔符、Excel 要工作表名稱），那就該換成 sealed。
> 但**現在不需要就不要提前設計**。

**C) `record`**

純值物件。兩個內容相同的座標就是同一個地方——值語意正確。

```java
public record Coordinate(double latitude, double longitude) {

    public Coordinate {
        if (latitude < -90 || latitude > 90) {
            throw new IllegalArgumentException("緯度必須在 -90 到 90 之間，收到 " + latitude);
        }
        if (longitude < -180 || longitude > 180) {
            throw new IllegalArgumentException("經度必須在 -180 到 180 之間，收到 " + longitude);
        }
    }

    public double distanceKmTo(Coordinate other) {
        // Haversine 公式⋯⋯
        return 0;
    }
}
```

> ⚠️ **注意 `double` 元件的 `equals` 語意**（12.5 節）：
> `Coordinate(Double.NaN, 0)` 會 `equals` 另一個 `Coordinate(Double.NaN, 0)`。
> 這裡我們在 compact constructor 擋掉了 NaN（`NaN` 的所有比較都是 false，
> 所以 `NaN < -90` 是 false、`NaN > 90` 也是 false——**擋不掉！**）。
>
> 要真的擋掉要明寫：
> ```java
> if (Double.isNaN(latitude) || Double.isNaN(longitude)) {
>     throw new IllegalArgumentException("座標不可為 NaN");
> }
> ```
> **這是一個很好的提醒：`NaN` 讓所有範圍檢查失效。**

**D) 普通類別**

三個理由，任一個都足以否決 record：

1. **會存進資料庫** → 大概是 JPA `@Entity` → record 不行（12.7 節①）。
2. **有身分**：改了 email 還是同一個使用者 → 實體語意（12.7 節②）。
3. **可變**：email 和密碼會被修改。

```java
@Entity
public class UserAccount {

    @Id @GeneratedValue
    private Long id;

    private String email;
    private String passwordHash;
    private Instant createdAt;
    private Instant lastLoginAt;

    @Enumerated(EnumType.STRING)
    private AccountStatus status;      // 這個用 enum

    protected UserAccount() { }        // JPA 需要

    // 行為方法而不是裸 setter（第 02 章 2.9 節）
    public void changeEmail(String newEmail) { /* 驗證 + 賦值 */ }
    public void recordLogin(Instant at) { this.lastLoginAt = at; }

    @Override
    public boolean equals(Object o) {
        return o instanceof UserAccount other && id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return getClass().hashCode();      // JPA 實體的常見做法，第 08 站會詳談
    }
}
```

但**對外的 DTO 應該是 record**：

```java
public record UserResponse(long id, String email, Instant createdAt, String status) {

    public static UserResponse from(UserAccount account) {
        return new UserResponse(account.getId(), account.getEmail(),
                account.getCreatedAt(), account.getStatus().name());
    }
}
```

注意 `UserResponse` **沒有 `passwordHash`**——這是把實體和 DTO 分開的
另一個重要理由（不小心把密碼雜湊序列化出去是真實發生過的事故）。

**E) `record`（多回傳值）**

這是 record 最被低估的用途：取代 `Pair`、`Object[]`、輸出參數。

```java
public record ImportResult(int imported, List<Failure> failures) {

    public ImportResult {
        if (imported < 0) {
            throw new IllegalArgumentException("imported 不可為負");
        }
        failures = List.copyOf(failures);       // 防禦性複製（12.6 節）
    }

    public record Failure(int lineNumber, String reason) { }

    public int failed() {
        return failures.size();
    }

    public boolean isFullySuccessful() {
        return failures.isEmpty();
    }
}
```

如果這個型別**只在一個方法裡用**，可以宣告成 local record：

```java
public Report analyse(List<Todo> todos) {
    // 只有這個方法看得到，不污染套件層級的命名空間
    record Bucket(Priority priority, long count, Duration avgAge) { }

    List<Bucket> buckets = todos.stream()
            .collect(groupingBy(Todo::priority))
            .entrySet().stream()
            .map(e -> new Bucket(e.getKey(), e.getValue().size(), averageAge(e.getValue())))
            .toList();

    return new Report(buckets.stream().map(Bucket::toString).toList());
}
```

**F) `record` + 行為**

值物件，而且有豐富的領域行為——這是 record 的理想使用場景。

```java
public record TimeRange(Instant start, Instant end) {

    public TimeRange {
        Objects.requireNonNull(start, "start");
        Objects.requireNonNull(end, "end");
        if (!start.isBefore(end)) {
            throw new IllegalArgumentException(
                    "開始時間必須早於結束時間：%s / %s".formatted(start, end));
        }
    }

    public boolean contains(Instant moment) {
        return !moment.isBefore(start) && moment.isBefore(end);      // [start, end)
    }

    public boolean overlaps(TimeRange other) {
        return start.isBefore(other.end) && other.start.isBefore(end);
    }

    public Duration duration() {
        return Duration.between(start, end);
    }

    public Optional<TimeRange> intersection(TimeRange other) {
        if (!overlaps(other)) {
            return Optional.empty();
        }
        return Optional.of(new TimeRange(
                start.isAfter(other.start) ? start : other.start,
                end.isBefore(other.end) ? end : other.end));
    }

    public TimeRange extendedBy(Duration amount) {
        return new TimeRange(start, end.plus(amount));      // wither
    }
}
```

> 💡 **注意 `contains` 用的是半開區間 `[start, end)`。**
> 這個決定必須寫在文件和測試裡（第 11 章 11.9 節的邊界測試），
> 否則「一個事件剛好在另一個結束的瞬間開始，算不算重疊」會有兩種答案。

**總表**

| | 選擇 | 決定性理由 |
|---|---|---|
| A | `sealed` + `record` | 每種情況攜帶不同結構的資料 + 需要窮盡性 |
| B | `enum` | 固定的三個選項，結構相同 |
| C | `record` | 純值物件 |
| D | 普通類別 | JPA 實體 + 有身分 + 可變 |
| E | `record` | 多回傳值 |
| F | `record` | 值物件 + 領域行為 |

</details>

---

### 練習 2：找出這三個 record 的 bug

```java
// ── A ──
public record ShoppingCart(String customerId, List<CartItem> items) {

    public BigDecimal total() {
        return items.stream().map(CartItem::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }
}

// ── B ──
public record ApiKey(String keyId, byte[] secret, Instant expiresAt) { }

// ── C ──
public record LoginRequest(String username, String password, String mfaCode) {

    public LoginRequest {
        Objects.requireNonNull(username, "username");
        Objects.requireNonNull(password, "password");
    }
}
```

每個都指出：①bug 是什麼 ②會造成什麼後果 ③怎麼修 ④寫一個會抓到它的測試。

<details>
<summary>參考解答</summary>

**A —— 可變元件沒有防禦性複製（12.6 節）**

**① Bug**：`List<CartItem> items` 只保證「參考不變」，
不保證「清單內容不變」。

**② 後果**：

```java
var items = new ArrayList<CartItem>();
items.add(new CartItem("A", new BigDecimal("100")));
var cart = new ShoppingCart("C001", items);

cart.total();                    // 100

items.add(new CartItem("免費的", new BigDecimal("-1000")));   // 從外面塞
cart.total();                    // -900 ⚠️

cart.items().clear();            // 從回傳值改
cart.total();                    // 0
```

在購物車的情境下這是**直接的金錢損失**：
如果 `ShoppingCart` 被建立後傳給結帳流程，而中間有任何程式碼
（或攻擊者控制的輸入路徑）還握著原本的 `items` 參考，就能改動金額。

更隱蔽的情況是**併發**（第 08 章）：一條執行緒在算 `total()`，
另一條在改 `items` → `ConcurrentModificationException`
或算出錯誤的總額。「不可變物件可以自由跨執行緒共享」的前提被破壞了。

**③ 修法**：

```java
public record ShoppingCart(String customerId, List<CartItem> items) {

    public ShoppingCart {
        Objects.requireNonNull(customerId, "customerId");
        items = List.copyOf(items);       // ← 複製 + 轉成不可變
    }

    public BigDecimal total() {
        return items.stream().map(CartItem::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    /** 新增品項回傳新的購物車（wither） */
    public ShoppingCart plus(CartItem item) {
        var merged = new ArrayList<>(items);
        merged.add(item);
        return new ShoppingCart(customerId, merged);
    }
}
```

> ⚠️ `List.copyOf` 不接受 `null` 元素。如果來源可能含 `null`，
> 要先過濾（而且應該問「為什麼會有 null 品項」）。

**④ 測試**：

```java
@Test
@DisplayName("外部修改原始清單不影響購物車")
void isImmuneToExternalMutation() {
    var items = new ArrayList<CartItem>();
    items.add(new CartItem("A", new BigDecimal("100")));
    var cart = new ShoppingCart("C001", items);

    items.add(new CartItem("駭進來的", new BigDecimal("-1000")));

    assertThat(cart.items()).hasSize(1);
    assertThat(cart.total()).isEqualByComparingTo("100");
}

@Test
@DisplayName("items() 回傳不可修改的清單")
void itemsIsUnmodifiable() {
    var cart = new ShoppingCart("C001", List.of(new CartItem("A", BigDecimal.TEN)));

    assertThatThrownBy(() -> cart.items().clear())
            .isInstanceOf(UnsupportedOperationException.class);
}
```

---

**B —— 陣列元件讓 `equals` / `hashCode` / `toString` 全部失效（12.6 節）**

**① Bug**：三個問題疊在一起。

1. `byte[] secret` 的 `equals` 是**參考比較**，record 自動產生的
   `equals` 用的是 `Objects.equals(byte[], byte[])`，所以
   **兩個內容相同的 `ApiKey` 不相等**。
2. `hashCode` 用的是陣列的身分雜湊——每個實例都不同。
3. `toString` 會印出 `[B@1b6d3586` 這種東西，**而且** `secret` 是機密，
   本來就不該出現在 log 裡。
4. 沒有防禦性複製——外部可以改掉 secret 的內容。

**② 後果**：

```java
var a = new ApiKey("k1", "secret".getBytes(UTF_8), expiry);
var b = new ApiKey("k1", "secret".getBytes(UTF_8), expiry);

a.equals(b);                     // false ⚠️

Map<ApiKey, Permissions> cache = new HashMap<>();
cache.put(a, perms);
cache.get(b);                    // null ⚠️ 快取永遠 miss
cache.size();                    // 每次請求都 +1 → 記憶體洩漏（第 09 章 9.11 節）

log.info("驗證金鑰：{}", a);      // 印出 secret 的記憶體位址（沒洩漏，但也沒用）
```

**最糟的組合**：如果有人「修好」了 `toString` 讓它印出 `Arrays.toString(secret)`，
**機密就明文進 log 了**。

**③ 修法**：最好的答案是**換掉型別**。

```java
public record ApiKey(String keyId, Secret secret, Instant expiresAt) {

    public ApiKey {
        Objects.requireNonNull(keyId, "keyId");
        Objects.requireNonNull(secret, "secret");
        Objects.requireNonNull(expiresAt, "expiresAt");
    }

    public boolean isExpired(Clock clock) {
        return !clock.instant().isBefore(expiresAt);
    }
}
```

```java
/** 機密位元組。equals 用常數時間比較，toString 永遠遮蔽。 */
public final class Secret {

    private final byte[] bytes;

    public Secret(byte[] bytes) {
        this.bytes = bytes.clone();                 // 進來複製
    }

    public byte[] bytes() {
        return bytes.clone();                       // 出去也複製
    }

    @Override
    public boolean equals(Object o) {
        // ⚠️ 用常數時間比較，避免時序攻擊（timing attack）
        return o instanceof Secret other && MessageDigest.isEqual(bytes, other.bytes);
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(bytes);
    }

    @Override
    public String toString() {
        return "Secret[***]";                       // 永遠不洩漏
    }
}
```

如果非要保留 `byte[]`，就必須手寫三個方法：

```java
public record ApiKey(String keyId, byte[] secret, Instant expiresAt) {

    public ApiKey {
        secret = secret.clone();
    }

    @Override
    public byte[] secret() {
        return secret.clone();
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof ApiKey other
                && keyId.equals(other.keyId)
                && MessageDigest.isEqual(secret, other.secret)
                && expiresAt.equals(other.expiresAt);
    }

    @Override
    public int hashCode() {
        return Objects.hash(keyId, Arrays.hashCode(secret), expiresAt);
    }

    @Override
    public String toString() {
        return "ApiKey[keyId=%s, secret=***, expiresAt=%s]".formatted(keyId, expiresAt);
    }
}
```

**但這時 record 的優勢已經沒了**（12.6 節說過）——三個方法都手寫，
還多一個存取器。**這就是「有陣列元件就該重新考慮」的意思。**

**④ 測試**：

```java
@Test
@DisplayName("內容相同的金鑰相等，且可以當 Map 的 key")
void equalityIsByContent() {
    var a = new ApiKey("k1", new Secret("secret".getBytes(UTF_8)), EXPIRY);
    var b = new ApiKey("k1", new Secret("secret".getBytes(UTF_8)), EXPIRY);

    assertThat(a).isEqualTo(b).hasSameHashCodeAs(b);

    var cache = new HashMap<ApiKey, String>();
    cache.put(a, "perms");
    assertThat(cache).containsEntry(b, "perms");        // 用 b 查得到 a 存的
}

@Test
@DisplayName("toString 不會洩漏機密")
void toStringHidesSecret() {
    var key = new ApiKey("k1", new Secret("super-secret".getBytes(UTF_8)), EXPIRY);

    assertThat(key.toString())
            .contains("k1")
            .doesNotContain("super-secret");
}

@Test
@DisplayName("外部無法透過回傳的陣列改動機密")
void secretIsDefensivelyCopied() {
    var secret = new Secret("original".getBytes(UTF_8));

    byte[] leaked = secret.bytes();
    Arrays.fill(leaked, (byte) 0);

    assertThat(new String(secret.bytes(), UTF_8)).isEqualTo("original");
}
```

---

**C —— 敏感欄位進了自動產生的 `toString`（12.5 節）**

**① Bug**：`LoginRequest` 有 `password` 和 `mfaCode`，
但沒有覆寫 `toString`。record 預設會印出**所有元件**。

**② 後果**：

```java
log.info("收到登入請求：{}", request);
```

```
2026-08-17 10:00:00 INFO  AuthController - 收到登入請求：
    LoginRequest[username=alice, password=Tr0ub4dor&3, mfaCode=482913]
```

**明文密碼和 MFA 驗證碼躺在 log 檔裡。** 而且：

- log 通常會被收集到中央系統（ELK、Datadog），存取權限比資料庫寬鬆得多。
- log 會被備份、被保留 90 天、被工程師隨手 grep。
- 這在 GDPR / 個資法下是可申報的資安事件。

**更隱蔽的觸發路徑**：你自己可能從沒寫過那行 log，
但**例外處理**會（第 04 章 4.11 節）：

```java
catch (Exception e) {
    log.error("登入失敗，請求內容：{}", request, e);      // 一樣中獎
}
```

或者 Spring 的 `@RestControllerAdvice` 印出參數、
或者某個 debug log、或者 APM 工具自動記錄方法參數。
**只要那個物件的 `toString` 會洩漏，遲早會洩漏。**

**③ 修法**（三層防禦）：

```java
public record LoginRequest(String username, String password, String mfaCode) {

    public LoginRequest {
        Objects.requireNonNull(username, "username");
        Objects.requireNonNull(password, "password");
        username = username.strip().toLowerCase(Locale.ROOT);
    }

    /** 第一層：永遠不印出敏感欄位 */
    @Override
    public String toString() {
        return "LoginRequest[username=%s, password=***, mfaCode=%s]"
                .formatted(username, mfaCode == null ? "none" : "***");
    }
}
```

第二層是**型別層級**的保護（更徹底）：

```java
public record LoginRequest(String username, Secret password, Secret mfaCode) { }
// Secret 的 toString 永遠是 "Secret[***]"，不可能忘記
```

第三層是**用 ArchUnit 鎖住規範**（第 11 章 11.19 節）：

```java
@ArchTest
static final ArchRule 含敏感欄位的_record_必須覆寫_toString = classes()
        .that().areRecords()
        .and(new DescribedPredicate<JavaClass>("有 password / secret / token 元件") {
            @Override
            public boolean test(JavaClass clazz) {
                return clazz.getAllFields().stream()
                        .map(f -> f.getName().toLowerCase(Locale.ROOT))
                        .anyMatch(n -> n.contains("password") || n.contains("secret")
                                || n.contains("token") || n.contains("credential"));
            }
        })
        .should(new ArchCondition<JavaClass>("覆寫 toString") {
            @Override
            public void check(JavaClass clazz, ConditionEvents events) {
                boolean overrides = clazz.getMethods().stream()
                        .anyMatch(m -> m.getName().equals("toString")
                                && m.getRawParameterTypes().isEmpty());
                if (!overrides) {
                    events.add(SimpleConditionEvent.violated(clazz,
                            clazz.getName() + " 有敏感欄位但沒覆寫 toString"));
                }
            }
        })
        .because("record 預設的 toString 會把所有元件印出來，敏感資料會進 log（第 12 章 12.5 節）");
```

**④ 測試**：

```java
@Test
@DisplayName("toString 不含密碼與 MFA 驗證碼")
void toStringHidesSensitiveFields() {
    var request = new LoginRequest("alice", "Tr0ub4dor&3", "482913");

    assertThat(request.toString())
            .contains("alice")
            .doesNotContain("Tr0ub4dor&3")
            .doesNotContain("482913");
}

@Test
@DisplayName("實際 log 出去時不含密碼（端對端驗證）")
void loggingDoesNotLeakPassword() {
    var logCapture = new ByteArrayOutputStream();
    // ... 把 logback 的 appender 導到 logCapture

    log.info("收到登入請求：{}", new LoginRequest("alice", "Tr0ub4dor&3", "482913"));

    assertThat(logCapture.toString(UTF_8)).doesNotContain("Tr0ub4dor&3");
}
```

> 🔑 **三個 bug 的共通點：`record` 幫你產生的方法「太好用」，
> 好用到你忘記檢查它們對你的資料是否正確。**
>
> **每寫一個 record，問三個問題：**
> 1. 有沒有可變元件（`List`/`Map`/陣列/`Date`）？→ 要防禦性複製。
> 2. 有沒有陣列元件？→ `equals`/`hashCode` 會錯，考慮換型別。
> 3. 有沒有敏感元件？→ 一定覆寫 `toString`。

</details>

---

### 練習 3：用 `sealed` 重構狀態機

一個訂單狀態機目前長這樣：

```java
public class Order {

    private String status;        // "DRAFT" / "PAID" / "SHIPPED" / "CANCELLED"
    private Instant paidAt;       // 只有 PAID 之後才有值
    private String paymentId;     // 只有 PAID 之後才有值
    private String trackingNo;    // 只有 SHIPPED 之後才有值
    private Instant shippedAt;    // 只有 SHIPPED 之後才有值
    private String cancelReason;  // 只有 CANCELLED 才有值
    private Instant cancelledAt;  // 只有 CANCELLED 才有值

    public String describe() {
        if ("DRAFT".equals(status)) {
            return "草稿";
        } else if ("PAID".equals(status)) {
            return "已付款（" + paymentId + "）";
        } else if ("SHIPPED".equals(status)) {
            return "已出貨，物流編號 " + trackingNo;
        } else if ("CANCELLED".equals(status)) {
            return "已取消：" + cancelReason;
        }
        return "未知狀態";
    }
}
```

①列出這個設計的五個問題 ②用 `sealed` + `record` 重寫狀態部分
③示範狀態轉換該怎麼寫 ④說明重寫之後哪些 bug 變得不可能。

<details>
<summary>參考解答</summary>

**① 五個問題**

| # | 問題 | 具體後果 |
|---|---|---|
| 1 | **狀態用字串** | 打錯字（`"SHIPED"`）編譯器不會抓；`equals` 順序寫錯會 NPE；無法窮盡 |
| 2 | **七個欄位有六個可能是 null** | 每次存取都要檢查；`getPaymentId()` 對草稿訂單回傳什麼？ |
| 3 | **無效狀態可以被建構** | `status="DRAFT"` 但 `trackingNo="ABC"` 完全合法；`status="PAID"` 但 `paymentId=null` 也合法 |
| 4 | **`describe()` 的 `return "未知狀態"`** | 新增狀態時編譯器不提醒；漏掉的分支變成執行期的錯誤資料 |
| 5 | **狀態轉換沒有規則** | 任何人都能把 `CANCELLED` 的訂單改成 `SHIPPED`——只要設個欄位 |

**② 重寫**

```java
package com.example.shop.order;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * 訂單狀態。每個狀態攜帶它自己需要的資料——不多也不少。
 *
 * <p>設計要點：不可能建立出「已付款但沒有付款編號」這種狀態。
 */
public sealed interface OrderState {

    /** 草稿：還沒付款，沒有任何附加資料 */
    record Draft() implements OrderState {
        static final Draft INSTANCE = new Draft();
    }

    /** 已付款：一定有付款編號與時間 */
    record Paid(String paymentId, Instant at) implements OrderState {
        public Paid {
            Objects.requireNonNull(at, "付款時間");
            paymentId = requireNonBlank(paymentId, "付款編號");
        }
    }

    /** 已出貨：保留付款資訊（出貨一定在付款之後），加上物流編號 */
    record Shipped(String paymentId, Instant paidAt,
                   String trackingNo, Instant shippedAt) implements OrderState {
        public Shipped {
            Objects.requireNonNull(paidAt, "付款時間");
            Objects.requireNonNull(shippedAt, "出貨時間");
            paymentId = requireNonBlank(paymentId, "付款編號");
            trackingNo = requireNonBlank(trackingNo, "物流編號");
            if (shippedAt.isBefore(paidAt)) {
                throw new IllegalArgumentException("出貨時間不可早於付款時間");
            }
        }
    }

    /** 已取消：一定有原因 */
    record Cancelled(String reason, Instant at) implements OrderState {
        public Cancelled {
            Objects.requireNonNull(at, "取消時間");
            reason = requireNonBlank(reason, "取消原因");
        }
    }

    // ── 工廠 ──

    static OrderState draft() {
        return Draft.INSTANCE;
    }

    // ── 從狀態算出來的查詢 ──

    default String describe() {
        return switch (this) {                          // 沒有 default
            case Draft() -> "草稿";
            case Paid(String paymentId, Instant at) -> "已付款（%s）".formatted(paymentId);
            case Shipped(var pid, var paidAt, String trackingNo, var shippedAt) ->
                    "已出貨，物流編號 " + trackingNo;
            case Cancelled(String reason, Instant at) -> "已取消：" + reason;
        };
    }

    /** 只有已付款的訂單才有付款編號——型別上就說清楚了 */
    default Optional<String> paymentId() {
        return switch (this) {
            case Paid(String id, var at) -> Optional.of(id);
            case Shipped(String id, var paidAt, var tn, var sa) -> Optional.of(id);
            case Draft() -> Optional.empty();
            case Cancelled(var reason, var at) -> Optional.empty();
        };
    }

    default boolean isCancellable() {
        return this instanceof Draft || this instanceof Paid;
    }

    private static String requireNonBlank(String value, String field) {
        String stripped = value == null ? "" : value.strip();
        if (stripped.isEmpty()) {
            throw new IllegalArgumentException(field + "不可為空白");
        }
        return stripped;
    }
}
```

> ⚠️ **一個 `case` 標籤只能有一個「模式」。**
>
> `case A, B ->` 這種逗號合併，只在標籤是**常數**時可用
> （enum 常數、字串、數字），以及 `case null, default` 這個特例。
> **模式不行**——下面這樣寫在 Java 21 是編譯錯誤：
>
> ```java
> case Draft(), Cancelled(var r, var a) -> Optional.empty();   // ❌
> ```
>
> 兩個分支結果相同時，就老實寫兩行（像上面的 `paymentId()`）。
> 或者，如果不需要解構，用一個共同的父型別：
>
> ```java
> case Draft d -> Optional.empty();
> case Cancelled c -> Optional.empty();
> ```
>
> 這是模式比對目前的限制之一，未來版本可能放寬——
> 但**不要用預覽功能去賭**（12.15 節）。

**③ 狀態轉換**

轉換規則本身也用模式比對表達，**不合法的轉換直接丟例外**：

```java
package com.example.shop.order;

import java.time.Clock;
import java.time.Instant;
import java.util.Objects;

public class Order {

    private final long id;
    private final Instant createdAt;
    private OrderState state;

    public Order(long id, Instant createdAt) {
        this.id = id;
        this.createdAt = Objects.requireNonNull(createdAt);
        this.state = OrderState.draft();
    }

    public OrderState state() {
        return state;
    }

    /** 付款。只有草稿可以付款。 */
    public void pay(String paymentId, Clock clock) {
        state = switch (state) {
            case OrderState.Draft() ->
                    new OrderState.Paid(paymentId, clock.instant());
            case OrderState.Paid(String existing, var at) ->
                    throw new IllegalStateException("訂單 %d 已付款（%s）".formatted(id, existing));
            case OrderState.Shipped(var pid, var pa, var tn, var sa) ->
                    throw new IllegalStateException("訂單 %d 已出貨".formatted(id));
            case OrderState.Cancelled(String reason, var at) ->
                    throw new IllegalStateException("訂單 %d 已取消：%s".formatted(id, reason));
        };
    }

    /** 出貨。只有已付款可以出貨，而且要把付款資訊帶過去。 */
    public void ship(String trackingNo, Clock clock) {
        state = switch (state) {
            case OrderState.Paid(String paymentId, Instant paidAt) ->
                    new OrderState.Shipped(paymentId, paidAt, trackingNo, clock.instant());
            case OrderState.Draft() ->
                    throw new IllegalStateException("訂單 %d 尚未付款，不能出貨".formatted(id));
            case OrderState.Shipped(var pid, var pa, String tn, var sa) ->
                    throw new IllegalStateException("訂單 %d 已出貨（%s）".formatted(id, tn));
            case OrderState.Cancelled(String reason, var at) ->
                    throw new IllegalStateException("訂單 %d 已取消".formatted(id));
        };
    }

    /** 取消。草稿和已付款可以取消，已出貨不行。 */
    public void cancel(String reason, Clock clock) {
        state = switch (state) {
            // 一個 case 只能有一個模式，所以兩種可取消的狀態要分開寫
            case OrderState.Draft() ->
                    new OrderState.Cancelled(reason, clock.instant());
            case OrderState.Paid(var paymentId, var paidAt) ->
                    new OrderState.Cancelled(reason, clock.instant());
            case OrderState.Shipped(var pid, var pa, String tn, var sa) ->
                    throw new IllegalStateException(
                            "訂單 %d 已出貨（%s），請走退貨流程".formatted(id, tn));
            case OrderState.Cancelled(String existing, var at) ->
                    throw new IllegalStateException("訂單 %d 已經取消過了".formatted(id));
        };
    }
}
```

> 🔑 **注意 `ship()` 那個 case：`Paid(String paymentId, Instant paidAt)`
> 解構出付款資訊，然後傳給 `Shipped`。**
>
> 這是舊設計做不到的——舊設計裡 `paymentId` 是一個可能為 null 的欄位，
> 出貨時你只能「希望」它有值。現在**型別保證了它一定有值**，
> 因為你是從 `Paid` 這個 case 拿到的。

**④ 哪些 bug 變得不可能**

| bug | 舊設計 | 新設計 |
|---|---|---|
| 狀態字串打錯（`"SHIPED"`） | 執行期才發現，`describe()` 回傳「未知狀態」 | **編譯錯誤**（沒有這個型別） |
| 已付款但 `paymentId` 是 null | 可以建構，NPE 在某個報表程式裡爆炸 | **不可能**（compact constructor 擋住） |
| 草稿訂單有 `trackingNo` | 可以建構，出貨報表出現不該存在的訂單 | **不可能**（`Draft` 沒有那個元件） |
| 已取消的訂單被改成已出貨 | 只要 `order.setStatus("SHIPPED")` | **不可能**（`cancel` 之後只能丟例外） |
| 新增 `Refunded` 狀態時漏改某處 | 悄悄落到 `"未知狀態"` | **所有 switch 編譯失敗** |
| 出貨時間早於付款時間 | 沒人檢查 | compact constructor 擋住 |

**還有一個不明顯的收穫：測試變簡單了。**

```java
// ❌ 舊設計：要斷言七個欄位的組合
assertThat(order.getStatus()).isEqualTo("PAID");
assertThat(order.getPaymentId()).isEqualTo("PAY-001");
assertThat(order.getPaidAt()).isEqualTo(NOW);
assertThat(order.getTrackingNo()).isNull();
assertThat(order.getShippedAt()).isNull();
assertThat(order.getCancelReason()).isNull();
assertThat(order.getCancelledAt()).isNull();

// ✅ 新設計：一行
assertThat(order.state()).isEqualTo(new OrderState.Paid("PAY-001", NOW));
```

> **這個練習示範的模式（用 sealed 表達狀態機）
> 適用於任何有「狀態 + 每個狀態有不同附加資料」的領域**：
> 訂單、工單、審核流程、部署狀態、匯入任務⋯⋯
>
> 判斷訊號很簡單：**當你看到一個類別有一堆「只有某些狀態才有值」的欄位時，
> 那就是它。**

</details>

---

### 練習 4：`default` 藏起來的 bug

以下程式碼在正式環境跑了兩年。找出兩個 bug，並說明為什麼一直沒被發現。

```java
public enum ShipmentStatus {
    CREATED, PICKED, PACKED, SHIPPED, DELIVERED, RETURNED
}
```

```java
public class ShipmentService {

    /** 計算應付給物流商的費用 */
    public BigDecimal carrierFee(Shipment s) {
        BigDecimal fee;
        switch (s.getStatus()) {
            case SHIPPED:
                fee = baseRate(s).multiply(new BigDecimal("1.0"));
                break;
            case DELIVERED:
                fee = baseRate(s).multiply(new BigDecimal("1.0"));
                break;
            case RETURNED:
                fee = baseRate(s).multiply(new BigDecimal("1.5"));   // 退貨要付來回
                break;
            default:
                fee = BigDecimal.ZERO;      // 還沒出貨，不用付錢
        }
        return fee;
    }

    /** 這個包裹還能不能取消 */
    public boolean isCancellable(Shipment s) {
        switch (s.getStatus()) {
            case CREATED:
            case PICKED:
                return true;
            default:
                return false;
        }
    }
}
```

半年前，團隊新增了一個狀態：

```java
public enum ShipmentStatus {
    CREATED, PICKED, PACKED, SHIPPED, IN_TRANSIT, DELIVERED, RETURNED
}
```

①兩個 bug 是什麼 ②為什麼測試沒抓到 ③用 switch expression 重寫
④重寫之後編譯器會說什麼。

<details>
<summary>參考解答</summary>

**① 兩個 bug**

**Bug 1：`IN_TRANSIT` 的包裹，物流費算成 0。**

`IN_TRANSIT`（運送中）明明已經出貨了，應該和 `SHIPPED` 一樣付費。
但它落到 `default`，`fee = BigDecimal.ZERO`。

**這是直接的財務錯誤**：物流商該收的錢沒被計算。
如果對帳是自動的，差額會累積；如果是人工，物流商會來吵。

**Bug 2（比較隱蔽）：`isCancellable` 對 `IN_TRANSIT` 回傳 `false`——
這個「剛好是對的」。**

⋯⋯但它是**碰巧對的**，不是設計出來的。
下次新增 `PENDING_PICKUP`（等待取件）時，它也會落到 `default` 回傳 `false`，
而那時**應該是 `true`**（還沒被取走，當然可以取消）。

> 這是 `default` 最陰險的地方：**它讓「漏掉」和「刻意」看起來一樣。**
> 讀者無法分辨 `default -> false` 是「所有其他狀態都不可取消」的深思熟慮，
> 還是「我只想到兩個狀態」的偷懶。

**還有第三個問題**（不算 bug 但很糟）：
`case SHIPPED` 和 `case DELIVERED` 的邏輯一模一樣，卻寫了兩次。
用 `case SHIPPED, DELIVERED ->` 一行就好。

**② 為什麼測試沒抓到**

三個原因疊加：

1. **測試是照著實作寫的。** 原本的測試大概是：
   ```java
   @Test void shippedCostsBaseRate() { ... }
   @Test void deliveredCostsBaseRate() { ... }
   @Test void returnedCostsOneAndHalf() { ... }
   @Test void createdCostsNothing() { ... }
   ```
   新增 `IN_TRANSIT` 時，**沒有人想到要加一個測試**——
   因為沒有任何東西提醒他們。

2. **沒有用 `@EnumSource` 窮舉**（第 11 章 11.8 節）。
   如果有這樣一個測試：
   ```java
   @ParameterizedTest
   @EnumSource(ShipmentStatus.class)
   void everyStatusHasDefinedFee(ShipmentStatus status) {
       // 至少會逼你想「這個狀態的費用是多少」
   }
   ```
   新增 enum 值時它會**自動涵蓋**，`IN_TRANSIT` 算成 0 就會被看到。

3. **覆蓋率是 100%。** 每一行都被執行過了
   （`default` 那行被 `CREATED` 的測試涵蓋）。
   這正是第 11 章 11.16 節說的「覆蓋率會騙你」。

**③ 重寫**

```java
public BigDecimal carrierFee(Shipment shipment) {
    BigDecimal base = baseRate(shipment);

    return switch (shipment.getStatus()) {
        // 還沒交給物流商，不用付錢
        case CREATED, PICKED, PACKED -> BigDecimal.ZERO;

        // 已經在物流商手上，付基本費
        case SHIPPED, IN_TRANSIT, DELIVERED -> base;

        // 退貨要付來回
        case RETURNED -> base.multiply(new BigDecimal("1.5"));
    };
}

public boolean isCancellable(Shipment shipment) {
    return switch (shipment.getStatus()) {
        // 還沒交給物流商，可以取消
        case CREATED, PICKED -> true;

        // 已經打包或之後，要走退貨流程
        case PACKED, SHIPPED, IN_TRANSIT, DELIVERED, RETURNED -> false;
    };
}
```

**三個改進：**

1. **沒有 `default`** → 新增狀態時編譯失敗。
2. **相同邏輯用逗號合併** → 少一半的行數，而且「這三種狀態一樣」變得明確。
3. **每個分支有註解說明「為什麼」** → 讀者知道 `PACKED` 不可取消是刻意的。

**④ 重寫之後編譯器會說什麼**

**如果直接把舊 enum（沒有 `IN_TRANSIT`）搭配新程式碼**：

```
[ERROR] ShipmentService.java:[15,20] an enum switch case label must be the
        unqualified name of an enumeration constant
        symbol: IN_TRANSIT
```

**如果 enum 有 `IN_TRANSIT` 但程式碼漏掉它**：

```
[ERROR] ShipmentService.java:[14,16] the switch expression does not cover
        all possible input values
```

**下次新增 `PENDING_PICKUP` 時**，兩個方法都會編譯失敗：

```
[ERROR] ShipmentService.java:[14,16] the switch expression does not cover all possible input values
[ERROR] ShipmentService.java:[29,16] the switch expression does not cover all possible input values
```

**開發者被迫回答兩個問題**：
「這個狀態的物流費是多少？」「這個狀態能不能取消？」

⋯⋯而這正是他新增狀態時**本來就該想的事**。

**加碼：用測試補上第二層保護**

即使有窮盡性檢查，還是值得加這個測試（第 11 章 11.8 節）：

```java
@ParameterizedTest(name = "{0}")
@EnumSource(ShipmentStatus.class)
@DisplayName("每個狀態的物流費都不為負，且已交運的狀態一定要收費")
void everyStatusHasSensibleFee(ShipmentStatus status) {
    var shipment = aShipment().status(status).baseRate("100").build();

    BigDecimal fee = service.carrierFee(shipment);

    assertThat(fee).isNotNegative();

    if (Set.of(SHIPPED, IN_TRANSIT, DELIVERED, RETURNED).contains(status)) {
        assertThat(fee)
                .as("%s 已交給物流商，不該是 0 元", status)
                .isPositive();
    }
}
```

> **為什麼有了編譯期檢查還要測試？**
> 因為編譯器只保證「你有處理這個 case」，**不保證你處理得對**。
> 有人可能為了讓它編譯過，隨手寫 `case PENDING_PICKUP -> BigDecimal.ZERO`。
> 這個測試會問「你確定嗎」。
>
> **編譯期檢查 + 窮舉測試，兩層一起用。**

</details>

---

### 練習 5：文字區塊的縮排

以下五個文字區塊，寫出它們實際的字串內容（用 `·` 表示空白，`⏎` 表示換行）。

```java
class Demo {

    String a() {
        return """
            hello
            world
            """;
    }

    String b() {
        return """
            hello
              world
        """;
    }

    String c() {
        return """
                hello
                world""";
    }

    String d() {
        return """
            hello \
            world
            """;
    }

    String e() {
        return """
            a   
            b\s\s
            """;
    }
}
```

<details>
<summary>參考解答</summary>

**規則回顧**（12.4 節）：

1. 收集**所有非空白行**加上**結束 `"""` 那一行**的縮排。
2. 取其中的**最小值**。
3. 每一行都扣掉這個最小值。
4. **每一行的行尾空白會被剝除**（除非用 `\s`）。
5. 結束 `"""` 另起一行 → 有結尾換行；接在內容後 → 沒有。

---

**a)**

```
            hello        ← 縮排 12
            world        ← 縮排 12
            """          ← 縮排 12
                           最小 = 12
```

```
hello⏎world⏎
```

即 `"hello\nworld\n"`。**最單純的情況。**

---

**b)**

```
            hello        ← 縮排 12
              world      ← 縮排 14
        """              ← 縮排 8  ← 結束符最左！
                           最小 = 8
```

每行扣 8：

```
····hello⏎······world⏎
```

即 `"    hello\n      world\n"`。

> **關鍵：結束的 `"""` 也參與計算，而且它在這裡是最左邊的。**
> 這是刻意的設計——把結束符往左移，就能保留內容的左邊縮排。
> 常見用途：產生有縮排的 YAML / Python 程式碼。

---

**c)**

```
                hello        ← 縮排 16
                world"""     ← 縮排 16，結束符「接在內容後」
                               最小 = 16
```

```
hello⏎world
```

即 `"hello\nworld"`——**沒有結尾換行**。

> 因為結束符沒有另起一行，所以它不貢獻縮排、也不產生換行。

---

**d)**

```
            hello \       ← 行尾的 \ 是「行接續」
            world         ← 縮排 12
            """           ← 縮排 12
                            最小 = 12
```

`\` 在行尾表示「這一行不要換行，直接接下一行」。

**但要注意順序**：先剝除行尾空白，再處理 `\`。
這裡 `hello \` 的 `\` 前面有一個空白，那個空白**在 `\` 之前**，所以會保留。

```
hello·world⏎
```

即 `"hello world\n"`。

> ⚠️ **如果寫成 `hello\`（`\` 前沒有空白），結果就是 `"helloworld\n"`。**
> 這個差異很容易在 code review 時看不出來——
> 所以用 `\` 接續時，**明確在前面留一個空白，或用 `\s`**。

---

**e)**

```
            a␣␣␣          ← 行尾有三個空白
            b\s\s          ← \s 是「保留一個空白」
            """
                            最小 = 12
```

- 第一行 `a` 後面的三個空白：**行尾空白，被剝除** → `a`
- 第二行 `b\s\s`：`\s` 明確產生空白，**而且它會阻止該行的剝除** → `b··`

```
a⏎b··⏎
```

即 `"a\nb  \n"`。

> **`\s` 的真正語意是「一個空白字元，且它左邊的內容不會被當成行尾空白剝除」。**
>
> 實務上最常見的用法是「只在最後一個要保留的空白後面放一個 `\s`」：
> ```java
> """
> 姓名：___________\s
> 電話：___________\s
> """
> ```
> 這樣每行結尾的對齊空白就保得住。

---

**總表**

| | 內容 | 說明 |
|---|---|---|
| a | `hello⏎world⏎` | 標準情況 |
| b | `····hello⏎······world⏎` | 結束符最左 → 保留 4/6 個空白 |
| c | `hello⏎world` | 結束符接在內容後 → 無結尾換行 |
| d | `hello·world⏎` | `\` 行接續，`\` 前的空白保留 |
| e | `a⏎b··⏎` | 行尾空白被剝除，`\s` 的保住了 |

**一個實用的驗證方式**：不確定時，直接印出來看：

```java
System.out.println(a().replace(" ", "·").replace("\n", "⏎\n"));
```

或者寫成測試（第 11 章）：

```java
@Test
@DisplayName("SQL 文字區塊沒有意外的縮排")
void sqlHasNoLeadingWhitespace() {
    assertThat(FIND_PENDING.lines())
            .allSatisfy(line -> assertThat(line).doesNotStartWith("    "));
}
```

</details>

---

## 12.20 驗收清單

- [ ] 我能說出樣板程式碼的真實成本（同一個事實散落在五個地方，編譯器不檢查一致性）。
- [ ] 我知道 `record` 的價值不只是少打字，而是**讓編譯器理解「這是資料」**。
- [ ] 我知道 `var` 能用在哪、不能用在哪。
- [ ] **我知道 `var list = new ArrayList<>()` 會推成 `ArrayList<Object>`。**
- [ ] 我有一條「什麼時候用 `var`」的團隊約定，而不是每次都辯論。
- [ ] 我能算出一個文字區塊的實際內容（最小共同縮排 + 行尾剝除）。
- [ ] 我知道結束的 `"""` 位置同時決定縮排基準和有沒有結尾換行。
- [ ] 我知道 `\s` 和 `\` 在文字區塊裡各自的作用。
- [ ] 我知道字串樣板（`STR.`）已被移除，不該跟著舊教學寫。
- [ ] 我能寫出 `record`，並說出它自動產生了什麼。
- [ ] 我知道 record 隱含 `final`、不能繼承、不能有額外的實例欄位。
- [ ] 我會用 compact constructor 做驗證與**正規化**（改參數變數）。
- [ ] **我知道 record 不會自動做防禦性複製，可變元件要自己 `List.copyOf`。**
- [ ] **我知道有陣列元件時，自動產生的 `equals` 是參考比較（會壞掉）。**
- [ ] **我知道含敏感欄位的 record 一定要覆寫 `toString`。**
- [ ] 我知道 record 的 `double` 元件用 `Double.compare` 語意（`NaN` 相等、`0.0 != -0.0`）。
- [ ] 我知道 record 反序列化一定走 canonical constructor（驗證不會被繞過）。
- [ ] 我能說出 record **不該**用的五種情況。
- [ ] **我能判斷一個型別是「值」還是「東西」，並據此選擇 record 或普通類別。**
- [ ] 我知道 JPA `@Entity` 不能是 record，而 DTO 應該是。
- [ ] 我能用 `sealed` 封閉型別階層，並知道 `final` / `sealed` / `non-sealed` 三選一的規則。
- [ ] 我知道 sealed 的跨套件限制（沒有 `module-info.java` 時要放同一個套件）。
- [ ] **我能說出 `sealed` vs `enum` 的判準（每種情況是否攜帶不同結構的資料）。**
- [ ] 我會用 `instanceof` 模式，也知道「反向 + 提早返回」的寫法。
- [ ] 我會用 switch 模式比對，並知道 `case null` 的必要性。
- [ ] 我知道 dominance 檢查會抓出永遠執行不到的 case。
- [ ] 我知道 `when` 子句不參與窮盡性檢查。
- [ ] 我會用 record pattern 解構巢狀資料。
- [ ] 我知道 `case List<String> l` 因為型別抹除而不合法。
- [ ] **我知道 switch expression 才有窮盡性檢查，statement 沒有。**
- [ ] **我知道對 enum / sealed 加 `default` 會殺死窮盡性檢查。**
- [ ] 我知道 switch expression 的區塊要用 `yield` 而不是 `return`。
- [ ] **我能用 `sealed` + `record` 把 `null` 從狀態表示中移除。**
- [ ] 我知道什麼時候該用 `Optional`、什麼時候該用 `sealed`。
- [ ] 我知道 Sequenced Collections 的 `getFirst()` 在空集合上丟例外。
- [ ] 我知道 `Stream.toList()` 回傳的是**不可修改**的清單。
- [ ] 我知道 `List.of` 不接受 `null`，`Set.of` 的迭代順序是隨機化的。
- [ ] 我知道自己專案的基準 Java 版本，也知道怎麼查。
- [ ] **我知道本章最大的收益（sealed + 模式比對）需要 Java 21。**
- [ ] 我能說出五個「不要用新特性」的判準。
- [ ] 我知道採用順序應該從「能帶來編譯期檢查」的開始。
- [ ] 我知道把 `getXxx()` 改成 `xxx()` 對 public API 是破壞性變更。
- [ ] **我知道在有測試安全網的情況下才做行為改變，並讓紅燈引導決策。**
- [ ] 我知道遷移既有專案要「順手改」，不要開一個全專案重構的 ticket。

---

## 12.21 下一章

這一章讓編譯器理解了「這是資料」「只有這幾種情況」。
下一章要做相反的事：**讓程式在執行期才決定要呼叫什麼**。

那是框架的世界——JUnit 怎麼找到你的 `@Test`、Jackson 怎麼寫進你的
`private final` 欄位、`mock(TodoRepository.class)` 到底回傳了什麼。
第 13 章會把這三件事拆開，然後你會親手寫一個測試框架、一個 DI 容器、一個 AOP 代理。

**那是 01 站的最後一章，也是通往 Spring 的橋。**

前往 [第 13 章：反射、註解與動態代理](./13-reflection-annotations-and-proxy.md)。
