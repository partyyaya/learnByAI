# 第 01 章：基本語法與流程控制

> 這章看起來最「基礎」，但線上事故最多的地方也在這裡：
> 金額算出 `299.99999999999997`、庫存數字跑到負的、`==` 比字串在測試環境剛好過、正式環境炸掉。
> 所以本章不只教語法，每一個型別都會告訴你**它會在什麼情況下騙你**。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說出 8 種基本型別的範圍，並判斷什麼情況會**溢位**。
- 解釋為什麼 `0.1 + 0.2 != 0.3`，並知道金額該用 `BigDecimal` 或整數分。
- 分辨基本型別與包裝型別，說明自動裝箱的兩個經典陷阱（`Integer` 快取、`null` 拆箱）。
- 正確使用 `equals` 比較字串，並解釋字串池與 `==` 為什麼「有時候會過」。
- 使用 `switch` 表達式（箭頭語法）而不是容易漏 `break` 的傳統寫法。
- 熟練 `for` / `for-each` / `while`，並知道什麼時候需要索引、什麼時候不要。
- 說明 Java 的參數傳遞是**值傳遞**，並解釋為什麼「傳物件進去卻被改掉了」。
- 用 `var` 而不濫用它。

---

## 1.2 程式的骨架與註解

```java
package com.example.todo;          // ① 套件宣告，必須是第一行（註解除外）

import java.util.List;             // ② 匯入其他套件的類別
import java.util.ArrayList;

/**
 * ③ Javadoc 註解：會被 javadoc 工具產生文件。
 * 寫在 class / 方法 / 欄位前面。
 */
public class Basics {

    // ④ 單行註解

    /* ⑤ 多行註解 */

    public static void main(String[] args) {
        List<String> tasks = new ArrayList<>();
        tasks.add("寫程式");
        System.out.println(tasks);      // [寫程式]
    }
}
```

三種註解的實務用法：

| 註解 | 什麼時候用 |
|---|---|
| `//` | 解釋「**為什麼**」這樣寫，不是解釋「做了什麼」 |
| `/* */` | 少用；暫時註解掉一段程式碼（其實該用版控） |
| `/** */` | 公開 API、給別人呼叫的方法、參數約束與例外 |

```java
// ❌ 廢話註解：程式碼已經說了
// 把 count 加 1
count++;

// ✅ 有價值的註解：解釋為什麼
// 廠商 API 從 1 開始計頁，我們的 API 從 0 開始，所以要 +1
int vendorPage = page + 1;
```

---

## 1.3 八種基本型別

Java 有 8 種**基本型別（primitive type）**。它們不是物件，直接存值。

| 型別 | 位元數 | 範圍 | 預設值 | 什麼時候用 |
|---|---|---|---|---|
| `byte` | 8 | -128 ~ 127 | 0 | 處理二進位資料、位元組陣列 |
| `short` | 16 | -32,768 ~ 32,767 | 0 | 幾乎不用 |
| `int` | 32 | 約 -21 億 ~ 21 億 | 0 | **整數預設選擇** |
| `long` | 64 | 約 ±9.2×10^18 | 0L | 時間戳、ID、金額（以分為單位）、計數器 |
| `float` | 32 | 約 7 位有效數字 | 0.0f | 幾乎不用 |
| `double` | 64 | 約 15 位有效數字 | 0.0d | 科學計算、比例、座標。**不要用在金額** |
| `char` | 16 | 一個 UTF-16 編碼單元 | `'\u0000'` | 單一字元 |
| `boolean` | JVM 未定義 | `true` / `false` | `false` | 是非 |

```java
byte  level    = 3;
short year     = 2026;
int   quantity = 100;
long  orderId  = 9_007_199_254_740_993L;   // 注意結尾的 L；底線只是給人看的分隔符

float  ratio   = 0.5f;                      // 注意結尾的 f
double pi      = 3.14159265358979;

char  grade    = 'A';                       // 單引號！雙引號是 String
boolean paid   = false;
```

三個語法細節，忘記就編譯不過：

```java
long big = 3000000000;      // ❌ 編譯錯誤：3000000000 先被當成 int，超出範圍
long ok  = 3000000000L;     // ✅ 加 L

float f1 = 1.5;             // ❌ 編譯錯誤：1.5 預設是 double，不能隱含縮小
float f2 = 1.5f;            // ✅

char c1 = "A";              // ❌ "A" 是 String
char c2 = 'A';              // ✅
```

### 進位表示法與底線

```java
int decimal = 1000;
int hex     = 0xFF;              // 255
int octal   = 0755;              // 493（八進位，容易誤用，除了檔案權限別碰）
int binary  = 0b1010_1010;       // 170【Java 7+】

// 底線增加可讀性，編譯後完全不存在
long cardNumber = 1234_5678_9012_3456L;
int  million    = 1_000_000;
```

> **實戰陷阱**：`int port = 08080;` 編譯錯誤，因為開頭的 `0` 讓它變成八進位，而八進位沒有 `8`。
> 讀設定檔的數字時，**永遠用字串再轉換**，不要寫成常值。

---

## 1.4 整數溢位：不會報錯，會給你錯的答案

Java 的整數運算**預設不檢查溢位**。超過範圍就繞回去。

```java
int max = Integer.MAX_VALUE;        // 2147483647
System.out.println(max);            // 2147483647
System.out.println(max + 1);        // -2147483648  ← 沒有例外！直接變負數
```

### 實務案例一：毫秒時間戳用 `int` 存

```java
// ❌ 真實發生過的 bug
int timestamp = (int) System.currentTimeMillis();
// currentTimeMillis() 回傳約 1.77×10^12，遠超過 int 的 21 億
// 強制轉型後變成一個看起來像時間戳、實際毫無意義的數字

// ✅ 時間戳一律用 long
long timestamp = System.currentTimeMillis();
```

### 實務案例二：金額累加

```java
// 情境：統計今年營收，單位是「分」
// ❌ 用 int：只能存到約 2147483647 分 = 21,474,836 元 ≈ 2147 萬
int totalCents = 0;
for (Order order : orders) {
    totalCents += order.amountInCents();     // 營收破 2147 萬就靜默出錯
}

// ✅ 用 long
long totalCents = 0L;
for (Order order : orders) {
    totalCents += order.amountInCents();     // 上限約 9.2×10^18 分，夠用了
}
```

### 實務案例三：二分搜尋的經典溢位

這是 JDK 自己也曾有過的 bug（`Arrays.binarySearch`，2006 年修掉）：

```java
// ❌ 當 low + high 超過 Integer.MAX_VALUE 時，mid 變成負數 → ArrayIndexOutOfBoundsException
int mid = (low + high) / 2;

// ✅ 正確寫法
int mid = low + (high - low) / 2;
```

### 需要「寧可爆掉也不要算錯」時：`Math.xxxExact`

```java
import java.util.Objects;

public class SafeMath {
    public static void main(String[] args) {
        int max = Integer.MAX_VALUE;

        System.out.println(max + 1);                 // -2147483648（靜默錯誤）

        try {
            System.out.println(Math.addExact(max, 1));   // 直接丟例外
        } catch (ArithmeticException e) {
            System.out.println("溢位: " + e.getMessage());  // 溢位: integer overflow
        }
    }
}
```

`Math.addExact` / `subtractExact` / `multiplyExact` / `toIntExact` 在**金額、庫存、計數器**這類「錯了會出事」的計算上很值得用。

### 整數除法與取餘數

```java
System.out.println(5 / 2);        // 2      ← 整數除法會截斷，不是四捨五入
System.out.println(5.0 / 2);      // 2.5    ← 只要有一邊是浮點就變浮點運算
System.out.println(5 % 2);        // 1
System.out.println(-7 % 3);       // -1     ← Java 的餘數跟被除數同號！
System.out.println(1 / 0);        // ArithmeticException: / by zero
System.out.println(1.0 / 0);      // Infinity  ← 浮點除以零不丟例外
System.out.println(0.0 / 0);      // NaN
```

**實務案例：分頁計算**

```java
int totalItems = 95;
int pageSize   = 10;

// ❌ 整數除法截斷，最後不滿一頁的 5 筆被吃掉
int totalPages = totalItems / pageSize;                // 9

// ✅ 向上取整的標準寫法
int totalPages = (totalItems + pageSize - 1) / pageSize;   // 10

// ✅ 或用 Math.ceilDiv（Java 18+），意圖更清楚
int totalPages = Math.ceilDiv(totalItems, pageSize);       // 10
```

**實務案例：`-7 % 3` 的雷**

```java
// 情境：用 hash 值決定分片（sharding）
int shardCount = 4;

// ❌ hashCode() 可能是負數 → index 變負 → ArrayIndexOutOfBoundsException
int index = "someKey".hashCode() % shardCount;

// ✅ 取絕對值（但 Integer.MIN_VALUE 的絕對值還是負的，仍不完全安全）
int index = Math.abs("someKey".hashCode()) % shardCount;

// ✅✅ 最安全：Math.floorMod 一定回傳非負
int index = Math.floorMod("someKey".hashCode(), shardCount);
```

---

## 1.5 浮點數與金額：本章最重要的一節

```java
System.out.println(0.1 + 0.2);              // 0.30000000000000004
System.out.println(0.1 + 0.2 == 0.3);       // false
System.out.println(1.03 - 0.42);            // 0.6100000000000001
System.out.println(4.35 * 100);             // 434.99999999999994
```

**原因**：`double` 是 IEEE 754 二進位浮點數。就像十進位無法精確表示 1/3（0.333...），二進位無法精確表示 0.1、0.2、0.3。這**不是 Java 的 bug**，所有用 IEEE 754 的語言（JavaScript、Python、C）都一樣。

### 實務災難案例

```java
// 情境：電商結帳。商品 4.35 元，買 100 件，打 9 折
double price    = 4.35;
double quantity = 100;
double discount = 0.9;

double total = price * quantity * discount;
System.out.println(total);                          // 391.49999999999994

// 四捨五入到分
System.out.printf("%.2f%n", total);                 // 391.50  ← 看起來沒事

// 但如果程式碼是這樣：
long cents = (long) (total * 100);                  // 39149  ← 少了 1 分！
System.out.println(cents);
```

一筆少一分，一天十萬筆就是一千元對不起來。財務會找你。

### 解法一：`BigDecimal`（金額的標準答案）

```java
import java.math.BigDecimal;
import java.math.RoundingMode;

public class MoneyDemo {
    public static void main(String[] args) {
        // ⚠️ 一定要用「字串」建構子，不要用 double
        BigDecimal price    = new BigDecimal("4.35");
        BigDecimal quantity = new BigDecimal("100");
        BigDecimal discount = new BigDecimal("0.9");

        BigDecimal total = price
                .multiply(quantity)
                .multiply(discount)
                .setScale(2, RoundingMode.HALF_UP);   // 保留 2 位，四捨五入

        System.out.println(total);      // 391.50  ← 精確
    }
}
```

**`BigDecimal` 的四個必知細節：**

```java
import java.math.BigDecimal;
import java.math.RoundingMode;

public class BigDecimalPitfalls {
    public static void main(String[] args) {

        // ① 千萬不要用 double 建構子
        System.out.println(new BigDecimal(0.1));
        // 0.1000000000000000055511151231257827021181583404541015625  ← 把 double 的誤差原封不動搬進來
        System.out.println(new BigDecimal("0.1"));      // 0.1  ✅
        System.out.println(BigDecimal.valueOf(0.1));    // 0.1  ✅（內部走 Double.toString）

        // ② BigDecimal 是不可變的！運算結果要接回去
        BigDecimal a = new BigDecimal("10");
        a.add(new BigDecimal("5"));
        System.out.println(a);                          // 10   ← 沒變！
        a = a.add(new BigDecimal("5"));
        System.out.println(a);                          // 15   ✅

        // ③ equals 比「值 + 精度」，compareTo 只比值
        BigDecimal x = new BigDecimal("1.0");
        BigDecimal y = new BigDecimal("1.00");
        System.out.println(x.equals(y));                // false ← 精度不同！
        System.out.println(x.compareTo(y) == 0);        // true  ✅ 比大小一律用 compareTo

        // ④ 除不盡會丟例外，一定要指定精度與進位方式
        BigDecimal one   = new BigDecimal("1");
        BigDecimal three = new BigDecimal("3");
        // one.divide(three);  // ArithmeticException: Non-terminating decimal expansion
        System.out.println(one.divide(three, 4, RoundingMode.HALF_UP));   // 0.3333  ✅
    }
}
```

> ⚠️ **`BigDecimal` 的 `equals` 陷阱在實務上會咬人**：
> 把 `BigDecimal` 放進 `HashSet` 或當 `HashMap` 的 key，`1.0` 和 `1.00` 會被當成兩個不同的東西。
> 資料庫的 `DECIMAL(12,2)` 讀出來是 `1.00`，程式裡寫的是 `new BigDecimal("1")`，比對就會失敗。
> **記住：金額比較一律 `compareTo(...) == 0`。**

### 解法二：用整數存「最小單位」

```java
// 台幣以「分」為單位，日圓本身就是整數，可以直接用 long
long priceInCents = 435;         // 4.35 元
long quantity     = 100;
long totalInCents = priceInCents * quantity * 9 / 10;   // 39150
System.out.println(totalInCents / 100.0);               // 391.5（只在顯示時才轉）
```

**選擇建議：**

| 情況 | 用什麼 |
|---|---|
| 一般業務金額、需要多幣別與精確捨入規則 | `BigDecimal`（資料庫用 `DECIMAL`） |
| 高頻運算、效能敏感（如撮合引擎） | `long` 存最小單位 |
| 比例、機率、幾何、統計 | `double` 沒問題 |

### 浮點數比較

```java
// ❌ 永遠不要這樣比浮點數
if (a == b) { }

// ✅ 比較容差
double EPSILON = 1e-9;
if (Math.abs(a - b) < EPSILON) { }

// 特殊值判斷
double nan = 0.0 / 0.0;
System.out.println(nan == nan);            // false！NaN 不等於任何東西，包括自己
System.out.println(Double.isNaN(nan));     // true  ✅ 正確做法
System.out.println(Double.isInfinite(1.0 / 0.0));   // true
```

---

## 1.6 型別轉換

### 自動轉換（放大，不會失去精度）

```
byte → short → int → long → float → double
        char ↗
```

```java
int  i = 100;
long l = i;         // ✅ 自動
double d = l;       // ✅ 自動
```

### 強制轉換（縮小，可能失去資料）

```java
double d = 9.99;
int i = (int) d;
System.out.println(i);              // 9  ← 直接截斷，不是四捨五入！

int big = 300;
byte b = (byte) big;
System.out.println(b);              // 44  ← 300 超出 byte 範圍，取低 8 位元

// 想要四捨五入
System.out.println(Math.round(9.99));       // 10 (long)
System.out.println((int) Math.round(9.99)); // 10
```

### 運算時的隱含提升，最容易中招

```java
byte a = 10, b = 20;
// byte c = a + b;          // ❌ 編譯錯誤！a + b 被提升成 int
byte c = (byte) (a + b);    // ✅

// 更常見的雷：整數除法先算完才轉浮點
int done = 3, total = 7;
double rate1 = done / total;                 // 0.0   ← 先整數除法得 0，再轉 double
double rate2 = (double) done / total;        // 0.4285714285714285  ✅
double rate3 = done * 100.0 / total;         // 42.857142857142854  ✅
System.out.printf("完成率 %.1f%%%n", rate3); // 完成率 42.9%
```

> **這是報表數字全部變成 0 或 100 的頭號原因。** 只要分子分母都是整數，就要先轉一邊。

### `char` 也是數字

```java
char c = 'A';
System.out.println((int) c);         // 65
System.out.println(c + 1);           // 66   ← 變成 int！
System.out.println((char) (c + 1));  // B    ✅

// 實務：字母序號轉換（Excel 欄位、選項編號）
for (int i = 0; i < 5; i++) {
    System.out.print((char) ('A' + i) + " ");    // A B C D E
}
System.out.println();

// 數字字元轉數值
char digit = '7';
System.out.println(digit - '0');                     // 7   ✅ 經典技巧
System.out.println(Character.getNumericValue(digit)); // 7  ✅ 意圖更清楚
```

---

## 1.7 包裝型別與自動裝箱

每個基本型別都有對應的**包裝型別（wrapper）**，因為泛型與集合只能裝物件。

| 基本型別 | 包裝型別 |
|---|---|
| `byte` / `short` / `int` / `long` | `Byte` / `Short` / `Integer` / `Long` |
| `float` / `double` | `Float` / `Double` |
| `char` | `Character` |
| `boolean` | `Boolean` |

```java
import java.util.List;
import java.util.ArrayList;

public class BoxingDemo {
    public static void main(String[] args) {
        // List<int> 不合法，只能放物件
        List<Integer> numbers = new ArrayList<>();
        numbers.add(1);              // 自動裝箱：int 1 → Integer.valueOf(1)
        int first = numbers.get(0);  // 自動拆箱：Integer → intValue()
        System.out.println(first);   // 1
    }
}
```

### 陷阱一：`Integer` 快取讓 `==` 有時候會過

```java
public class IntegerCache {
    public static void main(String[] args) {
        Integer a = 127, b = 127;
        System.out.println(a == b);        // true   ← 在 -128~127 的快取範圍內，是同一個物件

        Integer c = 128, d = 128;
        System.out.println(c == d);        // false  ← 超出快取，兩個不同物件

        System.out.println(c.equals(d));   // true   ✅ 正確做法
    }
}
```

`Integer.valueOf()` 對 -128 ~ 127 有快取池。所以**用小數字測試會過，上線遇到大數字就爆**。

**實務災難：**

```java
// ❌ 商品 ID 比對，測試資料 id=1~10 全部正常，正式環境 id=10032 全部比對失敗
if (order.getProductId() == cartItem.getProductId()) { }   // 兩邊都是 Integer

// ✅ 包裝型別一律用 equals
if (Objects.equals(order.getProductId(), cartItem.getProductId())) { }

// ✅✅ 或在資料模型裡就用 long / int（若該欄位不可能是 null）
```

**規則：包裝型別之間比較，永遠用 `equals` 或 `Objects.equals`，永遠不用 `==`。**

### 陷阱二：`null` 拆箱 → NullPointerException

```java
import java.util.HashMap;
import java.util.Map;

public class NullUnboxing {
    public static void main(String[] args) {
        Map<String, Integer> stock = new HashMap<>();
        stock.put("keyboard", 10);

        // 商品不存在 → get 回傳 null → 拆箱成 int 時炸掉
        int mouseStock = stock.get("mouse");   // NullPointerException！
        System.out.println(mouseStock);
    }
}
```

這個 NPE 的堆疊訊息**不會**指向 `stock.get()`，它指向那一行的賦值。很多人盯著看半天。

Java 14+ 的 Helpful NullPointerException 訊息會清楚說明：

```
Exception in thread "main" java.lang.NullPointerException:
  Cannot invoke "java.lang.Integer.intValue()" because the return value of
  "java.util.Map.get(Object)" is null
```

**修法：**

```java
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

public class NullUnboxingFixed {
    public static void main(String[] args) {
        Map<String, Integer> stock = new HashMap<>();
        stock.put("keyboard", 10);

        // ✅ 方法 1：getOrDefault
        int mouseStock = stock.getOrDefault("mouse", 0);
        System.out.println(mouseStock);        // 0

        // ✅ 方法 2：接成包裝型別，明確處理 null
        Integer boxed = stock.get("mouse");
        int safe = (boxed == null) ? 0 : boxed;
        System.out.println(safe);              // 0

        // ✅ 方法 3：Objects.requireNonNullElse（Java 9+）
        int alsoSafe = Objects.requireNonNullElse(stock.get("mouse"), 0);
        System.out.println(alsoSafe);          // 0
    }
}
```

> **實務判斷：欄位該用 `int` 還是 `Integer`？**
>
> - 資料庫欄位 **nullable** → 用 `Integer`（能表達「沒有值」）
> - 資料庫欄位 `NOT NULL` → 用 `int`（少一個 NPE 可能）
> - 計數器、迴圈變數、區域運算 → 一律 `int`（效能好，沒有裝箱開銷）
>
> 這在第 08 站（JPA Entity）會直接影響到你的欄位宣告。

### 陷阱三：三元運算子的隱藏拆箱

```java
Integer count = null;
boolean flag = false;

// ❌ NPE！三元運算子的兩個分支型別不同（Integer vs int），
//    編譯器把整個表達式提升成 int，於是 count 被拆箱
int result = flag ? count : 0;      // NullPointerException

// ✅ 讓兩邊型別一致
Integer result = flag ? count : Integer.valueOf(0);
```

### 陷阱四：迴圈裡的裝箱效能

```java
// ❌ 每一圈都拆箱 + 裝箱，產生 1000 萬個 Long 物件
Long sum = 0L;
for (int i = 0; i < 10_000_000; i++) {
    sum += i;          // sum = Long.valueOf(sum.longValue() + i)
}

// ✅ 用基本型別，快 5~10 倍且不產生垃圾
long sum = 0L;
for (int i = 0; i < 10_000_000; i++) {
    sum += i;
}
```

---

## 1.8 `var`：讓程式更好讀，不是讓你少打字

`var`（Java 10+）是**區域變數型別推斷**。它仍然是靜態型別，只是型別由編譯器從右邊推出來。

```java
var name = "Java";                      // String
var count = 10;                         // int
var list = new ArrayList<String>();     // ArrayList<String>

// 型別確定後不能改
var x = 1;
// x = "hello";      // ❌ 編譯錯誤：x 是 int
```

**限制：**

```java
// var n;                     // ❌ 必須初始化
// var n = null;              // ❌ 推不出型別
// var[] arr = {1, 2};        // ❌ 不能用在陣列宣告
// private var field = 1;     // ❌ 只能用在區域變數（不能用在欄位、參數、回傳型別）
```

### 什麼時候用

```java
// ✅ 右邊已經明說型別，左邊重複很囉唆
var orders = new HashMap<String, List<OrderItem>>();
// 對照舊寫法：
// HashMap<String, List<OrderItem>> orders = new HashMap<String, List<OrderItem>>();

// ✅ 增強 for 迴圈
for (var entry : orders.entrySet()) { }

// ✅ try-with-resources
try (var reader = Files.newBufferedReader(path)) { }

// ❌ 讀者看不出型別
var result = service.process(input);       // 這是什麼？List？Optional？int？
List<Invoice> result = service.process(input);   // ✅ 明確

// ❌ 掩蓋了危險的型別
var price = 4.35;      // 讀者以為是 BigDecimal，其實是 double
```

> **一句話原則**：如果讀者**看同一行**就能知道型別，用 `var`；否則寫出型別。
> 團隊裡最好統一寫進 code style 文件，避免每次 review 都吵。

---

## 1.9 字串：不可變、字串池、還有 `==` 的世紀大坑

### `String` 是不可變的（immutable）

```java
String s = "hello";
s.toUpperCase();
System.out.println(s);                    // hello   ← 沒變！

s = s.toUpperCase();
System.out.println(s);                    // HELLO   ✅
```

`String` 的所有「修改」方法都是**回傳新字串**。不可變帶來的好處：可以安全地共用、可以當 `HashMap` 的 key（hash 不會變）、天生執行緒安全。

### 字串池與 `==`

```java
public class StringPool {
    public static void main(String[] args) {
        String a = "hello";
        String b = "hello";
        System.out.println(a == b);          // true  ← 字串常值都指向池裡同一個物件

        String c = new String("hello");
        System.out.println(a == c);          // false ← new 一定在堆積建新物件
        System.out.println(a.equals(c));     // true  ✅

        String d = "hel" + "lo";             // 編譯期就合併成常值 "hello"
        System.out.println(a == d);          // true

        String part = "hel";
        String e = part + "lo";              // 執行期串接 → 新物件
        System.out.println(a == e);          // false ← 這就是那個坑
        System.out.println(a == e.intern()); // true  ← intern() 把它放回池裡
    }
}
```

### 為什麼 `==` 是災難

```java
// 情境：驗證使用者輸入的優惠碼
public boolean isValidCoupon(String input) {
    return input == "WELCOME2026";     // ❌
}
```

- 單元測試 `isValidCoupon("WELCOME2026")` → **通過**（常值在池裡，同一個物件）
- 從 HTTP request body 讀進來的字串 → **失敗**（執行期新建的物件）
- 從資料庫讀出來的字串 → **失敗**
- 從 JSON 反序列化出來的字串 → **失敗**

**這是最典型的「測試會過、上線就壞」。**

```java
// ✅ 正確
public boolean isValidCoupon(String input) {
    return "WELCOME2026".equals(input);       // 常值放前面，input 是 null 也不會 NPE
}

// ✅ 忽略大小寫
return "WELCOME2026".equalsIgnoreCase(input);

// ✅ 兩邊都可能 null 時
return Objects.equals(expected, input);
```

> **Yoda 寫法**：把常值放在 `equals` 左邊（`"X".equals(input)` 而不是 `input.equals("X")`），
> 可以省掉一個 null 檢查。這是實務上很常見的防禦性寫法。

### 常用方法（實務高頻）

```java
public class StringMethods {
    public static void main(String[] args) {
        String s = "  Hello, Java World  ";

        System.out.println(s.length());                  // 23
        System.out.println(s.trim());                    // "Hello, Java World"
        System.out.println(s.strip());                   // 同上，但支援 Unicode 空白【Java 11+】
        System.out.println(s.isEmpty());                 // false（長度是否為 0）
        System.out.println("   ".isBlank());             // true （是否只有空白）【Java 11+】

        String t = s.strip();
        System.out.println(t.toUpperCase());             // HELLO, JAVA WORLD
        System.out.println(t.contains("Java"));          // true
        System.out.println(t.startsWith("Hello"));       // true
        System.out.println(t.indexOf("Java"));           // 7
        System.out.println(t.indexOf("Python"));         // -1  ← 找不到是 -1，不是例外
        System.out.println(t.substring(7));              // Java World
        System.out.println(t.substring(7, 11));          // Java（含頭不含尾）
        System.out.println(t.replace("Java", "Kotlin")); // Hello, Kotlin World
        System.out.println(t.charAt(0));                 // H
        System.out.println(String.join("-", "a", "b", "c")); // a-b-c
        System.out.println("ab".repeat(3));              // ababab【Java 11+】

        // 分割
        String csv = "1001,keyboard,2990";
        String[] parts = csv.split(",");
        System.out.println(parts.length);                // 3
        System.out.println(parts[1]);                    // keyboard
    }
}
```

### `split` 的三個陷阱

```java
public class SplitPitfalls {
    public static void main(String[] args) {

        // ① split 的參數是「正規表達式」，不是普通字串
        System.out.println("a.b.c".split(".").length);      // 0！. 在 regex 是「任意字元」
        System.out.println("a.b.c".split("\\.").length);    // 3  ✅ 要轉義
        System.out.println("1|2|3".split("\\|").length);    // 3  ✅ | 也要轉義

        // ② 尾端的空字串默認被丟掉
        String[] a = "a,b,,".split(",");
        System.out.println(a.length);                       // 2  ← 尾端兩個空的被吃了
        String[] b = "a,b,,".split(",", -1);
        System.out.println(b.length);                       // 4  ✅ limit 給 -1 保留全部

        // ③ 解析 CSV 不要自己 split：欄位裡有逗號、有引號時一定壞
        String line = "1001,\"鍵盤, 無線\",2990";
        System.out.println(line.split(",").length);         // 4  ← 錯了，應該是 3
        // ✅ 用 Apache Commons CSV / OpenCSV 這類函式庫（第 07 章會提）
    }
}
```

### 字串串接的效能

```java
// ❌ 迴圈裡用 + 串接：每一圈都建一個新 String
String result = "";
for (int i = 0; i < 10_000; i++) {
    result += i + ",";          // O(n²) 的時間與記憶體
}

// ✅ 用 StringBuilder
StringBuilder sb = new StringBuilder();
for (int i = 0; i < 10_000; i++) {
    sb.append(i).append(',');
}
String result = sb.toString();
```

> 但**單次串接不用改**。第 00 章練習 3 我們用 `javap` 看過，Java 9+ 的編譯器會把
> `name + ":" + count` 最佳化成 `invokedynamic`，比手動 `StringBuilder` 還快。
> **只有迴圈裡的串接才需要 `StringBuilder`。** 第 07 章會再深入。

### 格式化

```java
public class Formatting {
    public static void main(String[] args) {
        String name = "keyboard";
        int qty = 3;
        double price = 2990.5;

        // printf：直接印，%n 是跨平台換行
        System.out.printf("商品 %s 數量 %d 金額 %.2f%n", name, qty, price);
        // 商品 keyboard 數量 3 金額 2990.50

        // String.format：組成字串
        String msg = String.format("商品 %-10s|%5d|%,10.2f", name, qty, price);
        System.out.println(msg);
        // 商品 keyboard  |    3|  2,990.50

        // formatted：一樣的東西，讀起來更順【Java 15+】
        System.out.println("訂單 #%d 已成立".formatted(1001));
    }
}
```

常用格式指示符：

| 指示符 | 意思 | 例 |
|---|---|---|
| `%s` | 字串 | `%-10s` 左對齊寬度 10 |
| `%d` | 整數 | `%,d` 加千分位、`%05d` 補零 |
| `%f` | 浮點 | `%.2f` 兩位小數 |
| `%%` | 一個百分號 | |
| `%n` | 換行 | 比 `\n` 好，跨平台 |

### 【Java 15+】文字區塊

```java
public class TextBlockDemo {
    public static void main(String[] args) {
        // ❌ 舊寫法：逃脫字元地獄
        String jsonOld = "{\n" +
                "  \"id\": 1001,\n" +
                "  \"name\": \"鍵盤\"\n" +
                "}";

        // ✅ 文字區塊
        String json = """
                {
                  "id": 1001,
                  "name": "鍵盤"
                }""";
        System.out.println(json);

        // 實務最有感的場景：寫 SQL
        String sql = """
                SELECT o.id, o.total_amount, u.email
                FROM orders o
                JOIN users u ON u.id = o.user_id
                WHERE o.status = ?
                  AND o.created_at >= ?
                ORDER BY o.created_at DESC
                """;
        System.out.println(sql);
    }
}
```

**縮排規則（很多人第一次會困惑）**：編譯器會找出所有非空行**和結束的 `"""`** 之中，縮排最少的那個，把該縮排量從每一行扣掉。所以：

```java
// 結束的 """ 位置決定縮排基準
String a = """
        hello
        """;         // "hello\n"        ← 結尾 """ 和 hello 同縮排

String b = """
        hello
    """;             // "    hello\n"   ← 結尾 """ 縮排較少，hello 前面留 4 空格
```

想要**不要結尾換行**，把 `"""` 直接接在最後一個字後面，或用 `\` 續行：

```java
String noNewline = """
        hello""";           // "hello"

String oneLine = """
        Hello, \
        World""";           // "Hello, World"
```

---

## 1.10 運算子

### 算術與複合賦值

```java
int a = 10, b = 3;
System.out.println(a + b);      // 13
System.out.println(a - b);      // 7
System.out.println(a * b);      // 30
System.out.println(a / b);      // 3   ← 整數除法
System.out.println(a % b);      // 1

a += 5;   // a = a + 5
a -= 2;
a *= 2;
a /= 4;

// 複合賦值有隱含強制轉型（這是它和 a = a + b 唯一的差別）
byte x = 10;
// x = x + 5;      // ❌ 編譯錯誤
x += 5;            // ✅ 編譯器自動加 (byte)
```

### 自增自減

```java
int i = 5;
System.out.println(i++);       // 5  ← 先用舊值，再加
System.out.println(i);         // 6
System.out.println(++i);       // 7  ← 先加，再用新值

// ❌ 不要在一個表達式裡出現多次同一變數的自增，可讀性歸零
int j = 5;
int bad = j++ + ++j;    // 5 + 7 = 12，但沒人看得出來，也沒人該花時間看
```

### 比較與邏輯（短路是重點）

```java
public class LogicOps {
    public static void main(String[] args) {
        String name = null;

        // ❌ NPE：& 不短路，右邊一定會執行
        // if (name != null & name.length() > 0) { }

        // ✅ && 短路：左邊 false 就不算右邊
        if (name != null && name.length() > 0) {
            System.out.println("有名字");
        } else {
            System.out.println("沒名字");     // 沒名字
        }

        // || 短路：左邊 true 就不算右邊
        if (name == null || name.isBlank()) {
            System.out.println("需要輸入名字");   // 需要輸入名字
        }
    }
}
```

> **實務規則**：`&&` 和 `||` 幾乎永遠是你要的。`&` / `|` 只用在**位元運算**。
> 短路的順序也很重要：`name != null && name.length() > 0`，兩邊調換就會 NPE。

### 三元運算子

```java
int stock = 0;
String status = stock > 0 ? "有貨" : "缺貨";

// ✅ 可以巢狀，但超過兩層就該用 switch 或抽方法
String level = score >= 90 ? "A"
             : score >= 80 ? "B"
             : score >= 70 ? "C"
             : "F";
```

### 位元運算（實務用得少，但權限旗標會用到）

```java
public class BitOps {
    // 實務案例：用位元旗標表示權限
    static final int READ   = 1;      // 0001
    static final int WRITE  = 1 << 1; // 0010 = 2
    static final int DELETE = 1 << 2; // 0100 = 4
    static final int ADMIN  = 1 << 3; // 1000 = 8

    public static void main(String[] args) {
        int perms = READ | WRITE;                     // 0011 = 3

        System.out.println((perms & READ) != 0);      // true  有讀取權
        System.out.println((perms & DELETE) != 0);    // false 沒有刪除權

        perms |= DELETE;                              // 加上刪除權 → 0111
        System.out.println((perms & DELETE) != 0);    // true

        perms &= ~WRITE;                              // 移除寫入權 → 0101
        System.out.println((perms & WRITE) != 0);     // false
    }
}
```

> 現代 Java 更推薦用 `EnumSet`（第 05 章）表達權限集合，可讀性好得多。
> 位元旗標的價值在**要存進資料庫單一整數欄位**時。

---

## 1.11 條件判斷

### `if / else if / else`

```java
public class OrderStatusDemo {

    // ❌ 巢狀太深，讀起來要一路縮到底
    static String checkBad(Order order) {
        if (order != null) {
            if (order.isPaid()) {
                if (order.getItems() != null && !order.getItems().isEmpty()) {
                    return "可出貨";
                } else {
                    return "沒有商品";
                }
            } else {
                return "未付款";
            }
        } else {
            return "訂單不存在";
        }
    }

    // ✅ 提前 return（guard clause），主邏輯留在最外層
    static String checkGood(Order order) {
        if (order == null)                  return "訂單不存在";
        if (!order.isPaid())                return "未付款";
        if (order.getItems().isEmpty())     return "沒有商品";
        return "可出貨";
    }
}
```

> **提前 return / 衛述句**是實務上最有效的可讀性技巧之一。看到縮排超過 3 層，先想能不能改成提前 return。

`if` 的條件必須是 `boolean`，這一點救過很多人：

```java
int x = 5;
// if (x = 0) { }        // ❌ 編譯錯誤（C 語言的經典 bug 在 Java 不會發生）
if (x == 0) { }          // ✅
```

### 傳統 `switch`：漏 `break` 是經典 bug

```java
public class SwitchOldStyle {
    static double discountRate(String memberLevel) {
        double rate = 0;
        switch (memberLevel) {
            case "GOLD":
                rate = 0.8;
                // ❌ 忘記 break！會「掉下去」執行 SILVER 的程式碼
            case "SILVER":
                rate = 0.9;
                break;
            case "NORMAL":
                rate = 1.0;
                break;
            default:
                throw new IllegalArgumentException("未知等級: " + memberLevel);
        }
        return rate;
    }

    public static void main(String[] args) {
        System.out.println(discountRate("GOLD"));    // 0.9  ← 金卡拿到銀卡折扣！
    }
}
```

**fall-through 偶爾有用**（多個 case 共用邏輯），但 95% 的情況是 bug。

### 【Java 14+】箭頭語法 `switch`：預設就該用這個

```java
public class SwitchArrow {
    static double discountRate(String memberLevel) {
        return switch (memberLevel) {
            case "GOLD"   -> 0.8;
            case "SILVER" -> 0.9;
            case "NORMAL" -> 1.0;
            default -> throw new IllegalArgumentException("未知等級: " + memberLevel);
        };
    }

    public static void main(String[] args) {
        System.out.println(discountRate("GOLD"));     // 0.8  ✅
    }
}
```

好處：

1. **不會 fall-through**，不用寫 `break`。
2. 是**表達式**，可以直接 `return` 或賦值。
3. 對 enum 有**完整性檢查**（見下方）。

多個標籤合併、需要多行時用 `yield`：

```java
public class SwitchYield {
    static int daysInMonth(int month, int year) {
        return switch (month) {
            case 1, 3, 5, 7, 8, 10, 12 -> 31;
            case 4, 6, 9, 11 -> 30;
            case 2 -> {
                boolean leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
                yield leap ? 29 : 28;        // 多行區塊要用 yield 回傳值
            }
            default -> throw new IllegalArgumentException("月份不合法: " + month);
        };
    }

    public static void main(String[] args) {
        System.out.println(daysInMonth(2, 2024));    // 29
        System.out.println(daysInMonth(2, 2026));    // 28
    }
}
```

### 搭配 enum：編譯器幫你檢查有沒有漏

```java
public class OrderStateMachine {

    enum OrderStatus { CREATED, PAID, SHIPPED, DELIVERED, CANCELLED }

    // 沒有 default，但涵蓋了所有 enum 值 → 編譯通過
    // 之後有人在 enum 新增 REFUNDED，這裡會「編譯失敗」，強迫你來處理
    static String nextAction(OrderStatus status) {
        return switch (status) {
            case CREATED   -> "等待付款";
            case PAID      -> "準備出貨";
            case SHIPPED   -> "等待收貨確認";
            case DELIVERED -> "訂單完成";
            case CANCELLED -> "無後續動作";
        };
    }

    public static void main(String[] args) {
        for (OrderStatus s : OrderStatus.values()) {
            System.out.println(s + " → " + nextAction(s));
        }
    }
}
```

> **這是實務上非常有價值的特性。** 用 `if-else` 或有 `default` 的 `switch`，新增狀態時程式照跑，
> 只是行為悄悄變成 default——上線才發現。用**沒有 default 的 switch 表達式 + enum**，編譯器會替你把關。

`switch` 支援的型別：`byte` / `short` / `char` / `int`（含包裝型別）、`String`、`enum`。
Java 21 起還支援**模式比對**（比對型別、解構 record），第 12 章會講。

---

## 1.12 迴圈

### `for`

```java
for (int i = 0; i < 5; i++) {
    System.out.print(i + " ");        // 0 1 2 3 4
}
System.out.println();

// 多變數、倒著跑、跳著跑
for (int i = 0, j = 10; i < j; i++, j--) { }
for (int i = 10; i > 0; i -= 2) { }
```

### `for-each`（增強 for）：不需要索引時的預設選擇

```java
import java.util.List;

public class ForEachDemo {
    public static void main(String[] args) {
        List<String> tasks = List.of("寫程式", "測試", "部署");

        // ✅ 只是要走過每個元素
        for (String task : tasks) {
            System.out.println("- " + task);
        }

        // 需要索引時才用傳統 for
        for (int i = 0; i < tasks.size(); i++) {
            System.out.println((i + 1) + ". " + tasks.get(i));
        }
    }
}
```

> ⚠️ `for-each` **不能**在迴圈中增刪集合元素（會丟 `ConcurrentModificationException`），
> 也不能改變參考本身。第 05 章會講 `Iterator.remove()` 和 `removeIf`。

### `while` / `do-while`

```java
import java.util.Scanner;

public class WhileDemo {
    public static void main(String[] args) {
        // while：先判斷，可能一次都不執行 —— 適合「條件驅動」
        int stock = 3;
        while (stock > 0) {
            System.out.println("出貨一件，剩 " + (--stock));
        }

        // do-while：先執行一次，再判斷 —— 適合「至少要做一次」，如選單
        Scanner scanner = new Scanner(System.in);
        String input;
        do {
            System.out.print("輸入指令（quit 離開）: ");
            input = scanner.nextLine();
            System.out.println("你輸入了: " + input);
        } while (!"quit".equals(input));
    }
}
```

### `break` / `continue` / 標籤

```java
public class BreakContinue {
    public static void main(String[] args) {

        // continue：跳過本圈
        for (int i = 1; i <= 10; i++) {
            if (i % 2 == 0) continue;
            System.out.print(i + " ");        // 1 3 5 7 9
        }
        System.out.println();

        // break：跳出整個迴圈
        int[] prices = {100, 250, -1, 300};
        for (int p : prices) {
            if (p < 0) {
                System.out.println("發現異常價格，停止處理");
                break;
            }
            System.out.println("處理 " + p);
        }

        // 標籤：跳出「外層」迴圈（實務案例：在二維表中找目標）
        int[][] grid = {{1, 2, 3}, {4, 5, 6}, {7, 8, 9}};
        int target = 5;
        int foundRow = -1, foundCol = -1;

        outer:
        for (int r = 0; r < grid.length; r++) {
            for (int c = 0; c < grid[r].length; c++) {
                if (grid[r][c] == target) {
                    foundRow = r;
                    foundCol = c;
                    break outer;             // 一次跳出兩層
                }
            }
        }
        System.out.println("找到於 (" + foundRow + ", " + foundCol + ")");   // (1, 1)
    }
}
```

> 標籤能用但不常用。多層巢狀想跳出時，**抽成一個方法然後 `return`** 通常更好讀。

### 無窮迴圈與跳出條件

```java
// 實務案例：分頁抓取外部 API，直到沒有下一頁
int page = 0;
while (true) {
    List<String> batch = fetchPage(page);     // 假設這個方法會呼叫外部 API
    if (batch.isEmpty()) break;

    process(batch);
    page++;

    if (page > 1000) {                        // ✅ 一定要有保險絲
        throw new IllegalStateException("分頁超過 1000 頁，可能是 API 沒有正確回傳結尾");
    }
}
```

> **實務鐵則**：任何跟外部系統互動的 `while(true)`，都要有**次數上限或超時**。
> 對方 API 有 bug 一直回同一頁時，你的服務不該無限跑下去。

---

## 1.13 陣列

```java
public class ArrayBasics {
    public static void main(String[] args) {
        // 三種宣告方式
        int[] a = new int[5];                       // 全部是預設值 0
        int[] b = {10, 20, 30};                     // 宣告時直接初始化
        int[] c = new int[]{10, 20, 30};            // 完整寫法（傳參數時要用這個）

        System.out.println(a.length);               // 5   ← 是 length 屬性，不是 length()
        System.out.println(b[0]);                   // 10
        b[0] = 99;
        System.out.println(b[0]);                   // 99

        // 各型別的預設值
        String[] names = new String[3];
        System.out.println(names[0]);               // null  ← 物件陣列預設 null
        boolean[] flags = new boolean[2];
        System.out.println(flags[0]);               // false
        double[] rates = new double[2];
        System.out.println(rates[0]);               // 0.0

        // 索引越界
        try {
            System.out.println(b[3]);
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("越界: " + e.getMessage());
            // Index 3 out of bounds for length 3
        }
    }
}
```

**陣列長度不可變。** 需要動態增減，用 `ArrayList`（第 05 章）。

### `Arrays` 工具類

```java
import java.util.Arrays;

public class ArraysUtil {
    public static void main(String[] args) {
        int[] nums = {5, 2, 9, 1, 7};

        System.out.println(Arrays.toString(nums));            // [5, 2, 9, 1, 7]
        // 直接 println(nums) 會印出 [I@1b6d3586 這種東西（型別 + hashCode）

        Arrays.sort(nums);
        System.out.println(Arrays.toString(nums));            // [1, 2, 5, 7, 9]

        System.out.println(Arrays.binarySearch(nums, 7));     // 3（陣列必須先排序！）

        int[] copy = Arrays.copyOf(nums, 3);
        System.out.println(Arrays.toString(copy));            // [1, 2, 5]

        int[] range = Arrays.copyOfRange(nums, 1, 4);
        System.out.println(Arrays.toString(range));           // [2, 5, 7]（含頭不含尾）

        int[] filled = new int[3];
        Arrays.fill(filled, 7);
        System.out.println(Arrays.toString(filled));          // [7, 7, 7]

        System.out.println(Arrays.equals(new int[]{1, 2}, new int[]{1, 2}));   // true
        // ⚠️ 陣列的 equals() 是比參考！比內容一定要用 Arrays.equals
        System.out.println(new int[]{1, 2}.equals(new int[]{1, 2}));           // false

        System.out.println(Arrays.stream(nums).sum());        // 24（第 06 章）
    }
}
```

### 二維陣列

```java
import java.util.Arrays;

public class Array2D {
    public static void main(String[] args) {
        // 規則的二維陣列
        int[][] matrix = {
            {1, 2, 3},
            {4, 5, 6}
        };
        System.out.println(matrix.length);        // 2（列數）
        System.out.println(matrix[0].length);     // 3（第 0 列的長度）
        System.out.println(matrix[1][2]);         // 6

        for (int[] row : matrix) {
            System.out.println(Arrays.toString(row));
        }

        // Java 的二維陣列其實是「陣列的陣列」，每列長度可以不同（jagged array）
        int[][] jagged = new int[3][];
        jagged[0] = new int[]{1};
        jagged[1] = new int[]{1, 2};
        jagged[2] = new int[]{1, 2, 3};
        System.out.println(Arrays.deepToString(jagged));   // [[1], [1, 2], [1, 2, 3]]
    }
}
```

### 實務案例：計算月營收

```java
import java.util.Arrays;

public class MonthlyRevenue {
    public static void main(String[] args) {
        // 每個訂單的金額（單位：分）
        long[] orderCents = {29900, 15050, 88000, 4990, 120000};

        long total = 0;
        long max = Long.MIN_VALUE;
        long min = Long.MAX_VALUE;

        for (long cents : orderCents) {
            total += cents;
            if (cents > max) max = cents;
            if (cents < min) min = cents;
        }

        // 平均：注意除法要轉浮點，否則會截斷
        double avg = (double) total / orderCents.length;

        System.out.printf("筆數: %d%n", orderCents.length);
        System.out.printf("總額: %,.2f 元%n", total / 100.0);
        System.out.printf("平均: %,.2f 元%n", avg / 100.0);
        System.out.printf("最大: %,.2f 元%n", max / 100.0);
        System.out.printf("最小: %,.2f 元%n", min / 100.0);

        // 中位數：先排序
        long[] sorted = Arrays.copyOf(orderCents, orderCents.length);   // 不要動到原陣列
        Arrays.sort(sorted);
        long median = (sorted.length % 2 == 1)
                ? sorted[sorted.length / 2]
                : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        System.out.printf("中位: %,.2f 元%n", median / 100.0);
    }
}
```

輸出：

```
筆數: 5
總額: 2,579.40 元
平均: 515.88 元
最大: 1,200.00 元
最小: 49.90 元
中位: 299.00 元
```

> 注意 `Arrays.copyOf` 那一行。`Arrays.sort` 是**原地排序**，會改掉你傳進去的陣列。
> 如果呼叫者之後還要用原始順序（例如「按建立時間列出」），就會出現非常難查的 bug。

---

## 1.14 方法

### 定義與呼叫

```java
public class MethodBasics {

    // [修飾子] 回傳型別 方法名(參數列表)
    static int add(int a, int b) {
        return a + b;
    }

    static void log(String message) {          // void 不回傳值
        System.out.println("[LOG] " + message);
    }

    public static void main(String[] args) {
        System.out.println(add(3, 4));         // 7
        log("完成");                            // [LOG] 完成
    }
}
```

### Java 是值傳遞——這是最常被誤解的一件事

```java
import java.util.ArrayList;
import java.util.List;

public class PassByValue {

    static void tryChangeInt(int n) {
        n = 999;                      // 改的是「n 這份拷貝」
    }

    static void tryChangeString(String s) {
        s = "changed";                // 改的是「s 這個參考變數的拷貝」，指向新物件
    }

    static void tryChangeList(List<String> list) {
        list.add("added");            // ✅ 透過參考「修改物件內容」→ 呼叫者看得到
    }

    static void tryReplaceList(List<String> list) {
        list = new ArrayList<>();     // ❌ 只是把本地拷貝指到新物件
        list.add("new");
    }

    public static void main(String[] args) {
        int n = 1;
        tryChangeInt(n);
        System.out.println(n);              // 1        ← 沒變

        String s = "original";
        tryChangeString(s);
        System.out.println(s);              // original ← 沒變

        List<String> list = new ArrayList<>();
        list.add("first");
        tryChangeList(list);
        System.out.println(list);           // [first, added]  ← 變了！

        tryReplaceList(list);
        System.out.println(list);           // [first, added]  ← 沒被換掉
    }
}
```

**正確的理解**：

> Java **永遠**是值傳遞。對於物件，傳進去的「值」是**參考（記憶體位址）的拷貝**。
> 所以你能透過那份拷貝**修改物件的內容**，但無法讓呼叫者的變數指向別的物件。

**實務影響：**

```java
// ❌ 有隱藏副作用的方法簽章：呼叫者不知道自己的 list 會被改
static void applyDiscount(List<OrderItem> items) {
    for (OrderItem item : items) {
        item.setPrice(item.getPrice() * 0.9);      // 改了呼叫者的資料！
    }
}

// ✅ 回傳新的集合，不動原始資料
static List<OrderItem> withDiscount(List<OrderItem> items) {
    List<OrderItem> result = new ArrayList<>();
    for (OrderItem item : items) {
        result.add(new OrderItem(item.getName(), item.getPrice() * 0.9));
    }
    return result;
}
```

第 02 章講不可變物件、第 06 章講 Stream 時，都會回到這個原則：**回傳新值，不要偷改參數。**

### 方法重載（overload）

同名、**參數列表不同**的方法。回傳型別不算在內。

```java
public class Overload {
    static String describe(int n)      { return "整數: " + n; }
    static String describe(double n)   { return "浮點: " + n; }
    static String describe(String s)   { return "字串: " + s; }
    static String describe(int a, int b) { return "兩個整數: " + a + "," + b; }

    // static int describe(int n) { return n; }   // ❌ 編譯錯誤：只有回傳型別不同

    public static void main(String[] args) {
        System.out.println(describe(1));        // 整數: 1
        System.out.println(describe(1.0));     // 浮點: 1.0
        System.out.println(describe("a"));     // 字串: a
        System.out.println(describe(1, 2));    // 兩個整數: 1,2
    }
}
```

**重載解析的陷阱**（真的會出事）：

```java
import java.util.ArrayList;
import java.util.List;

public class OverloadTrap {
    public static void main(String[] args) {
        List<Integer> list = new ArrayList<>(List.of(10, 20, 30));

        list.remove(1);                        // 呼叫 remove(int index) → 移除索引 1
        System.out.println(list);              // [10, 30]

        list.remove(Integer.valueOf(30));      // 呼叫 remove(Object) → 移除值 30
        System.out.println(list);              // [10]
    }
}
```

`List` 有 `remove(int index)` 和 `remove(Object o)` 兩個重載。傳 `int` 會選前者，
所以「我想移除數值 30，結果它去刪索引 30 或刪錯元素」是很常見的 bug。

**選擇順序**：精確匹配 → 自動放大轉換（`int` → `long`）→ 自動裝箱 → 可變參數。
所以**不要讓重載方法的參數只差在基本型別與包裝型別**，會很難預測。

### 可變參數（varargs）

```java
public class VarargsDemo {

    static long sum(long... numbers) {         // 內部其實就是一個陣列
        long total = 0;
        for (long n : numbers) {
            total += n;
        }
        return total;
    }

    // 至少要一個參數時，這樣宣告
    static String join(String separator, String first, String... rest) {
        StringBuilder sb = new StringBuilder(first);
        for (String s : rest) {
            sb.append(separator).append(s);
        }
        return sb.toString();
    }

    public static void main(String[] args) {
        System.out.println(sum());                      // 0
        System.out.println(sum(1, 2, 3));               // 6
        System.out.println(sum(new long[]{1, 2, 3}));   // 6（可以直接傳陣列）

        System.out.println(join("-", "a", "b", "c"));   // a-b-c
    }
}
```

**規則**：可變參數必須是**最後一個**參數，一個方法只能有一個。

實務上最常見的用途就是日誌與例外訊息：

```java
// 這就是 SLF4J 的 API 長相
logger.info("訂單 {} 由使用者 {} 建立，金額 {}", orderId, userId, amount);
```

### 遞迴

```java
public class Recursion {

    static long factorial(int n) {
        if (n < 0) throw new IllegalArgumentException("n 不可為負: " + n);
        if (n <= 1) return 1;                  // ✅ 一定要有終止條件
        return n * factorial(n - 1);
    }

    public static void main(String[] args) {
        System.out.println(factorial(20));     // 2432902008176640000

        // 沒有終止條件 → StackOverflowError
        try {
            infinite(0);
        } catch (StackOverflowError e) {
            System.out.println("堆疊爆了");
        }
    }

    static void infinite(int n) {
        infinite(n + 1);
    }
}
```

> **實務注意**：Java 沒有尾遞迴最佳化。預設執行緒堆疊約 512KB～1MB，遞迴深度大約幾千到一萬層就會
> `StackOverflowError`。處理深層樹狀結構（例如無限層級的分類目錄）時，**改用迴圈 + 明確的 stack**。
> 第 09 章會講 `-Xss` 怎麼調，以及為什麼調大它通常不是正解。

---

## 1.15 常見錯誤總整理

### 錯誤 1：用 `==` 比較字串或包裝型別

```java
// ❌
if (status == "PAID") { }
if (userId == otherId) { }        // 兩個 Integer

// ✅
if ("PAID".equals(status)) { }
if (Objects.equals(userId, otherId)) { }
```

### 錯誤 2：用 `double` 算錢

```java
// ❌
double total = price * quantity;

// ✅
BigDecimal total = price.multiply(BigDecimal.valueOf(quantity))
                        .setScale(2, RoundingMode.HALF_UP);
```

### 錯誤 3：整數除法算比例

```java
// ❌ 永遠是 0 或 1
double rate = done / total;

// ✅
double rate = (double) done / total;
```

### 錯誤 4：`Map.get` 的結果直接拆箱

```java
// ❌ key 不存在就 NPE
int count = counterMap.get(key);

// ✅
int count = counterMap.getOrDefault(key, 0);
```

### 錯誤 5：傳統 `switch` 漏 `break`

```java
// ✅ 一律用箭頭語法，從根本上避免
return switch (level) {
    case "GOLD" -> 0.8;
    case "SILVER" -> 0.9;
    default -> 1.0;
};
```

### 錯誤 6：`split` 忘記轉義

```java
// ❌
String[] parts = line.split("|");        // | 是 regex 的「或」

// ✅
String[] parts = line.split("\\|");
```

### 錯誤 7：在方法裡偷改參數集合

```java
// ❌ 呼叫者的資料被改了卻不知道
void process(List<Item> items) { items.clear(); }

// ✅ 明確回傳新集合，或在方法名上講清楚（processAndClear）
```

### 錯誤 8：`for-each` 中修改集合

```java
// ❌ ConcurrentModificationException
for (String task : tasks) {
    if (task.isBlank()) tasks.remove(task);
}

// ✅
tasks.removeIf(String::isBlank);
```

---

## 1.16 本章練習

### 練習 1：找出並修正所有 bug

```java
public class Buggy {
    public static void main(String[] args) {
        int totalMillis = (int) System.currentTimeMillis();

        double price = 19.99;
        int qty = 3;
        double total = price * qty;
        System.out.println("總計: " + total);

        String status = new String("PAID");
        if (status == "PAID") {
            System.out.println("已付款");
        }

        int completed = 7, all = 9;
        double rate = completed / all;
        System.out.println("完成率: " + rate * 100 + "%");

        String csv = "1|2|3";
        System.out.println("欄位數: " + csv.split("|").length);
    }
}
```

<details>
<summary>參考解答</summary>

五個 bug：

**① 時間戳用 `int`**——`currentTimeMillis()` 約 1.77×10^12，遠超 `int` 上限，強制轉型後是垃圾值。

**② 用 `double` 算錢**——`19.99 * 3` 得到 `59.97000000000001`。

**③ `==` 比字串**——`new String("PAID")` 不在字串池，永遠不等於常值 `"PAID"`，`if` 不會進去。

**④ 整數除法**——`7 / 9` 是 `0`，完成率變成 `0.0%`。

**⑤ `split("|")`**——`|` 是 regex 的「或」，`split("|")` 會把字串拆成單一字元，得到 5。

修正版：

```java
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Arrays;

public class Fixed {
    public static void main(String[] args) {
        // ① long
        long totalMillis = System.currentTimeMillis();
        System.out.println("時間戳: " + totalMillis);

        // ② BigDecimal，字串建構子
        BigDecimal price = new BigDecimal("19.99");
        int qty = 3;
        BigDecimal total = price.multiply(BigDecimal.valueOf(qty))
                                .setScale(2, RoundingMode.HALF_UP);
        System.out.println("總計: " + total);            // 59.97

        // ③ equals，常值放左邊
        String status = new String("PAID");
        if ("PAID".equals(status)) {
            System.out.println("已付款");                 // 會印出來了
        }

        // ④ 轉浮點，並用 printf 控制格式
        int completed = 7, all = 9;
        double rate = (double) completed / all;
        System.out.printf("完成率: %.1f%%%n", rate * 100);  // 完成率: 77.8%

        // ⑤ 轉義 |
        String csv = "1|2|3";
        String[] parts = csv.split("\\|");
        System.out.println("欄位數: " + parts.length);      // 3
        System.out.println(Arrays.toString(parts));         // [1, 2, 3]
    }
}
```

</details>

### 練習 2：訂單金額計算器

寫一個方法，輸入單價（字串，如 `"4.35"`）、數量、會員等級，回傳應付金額（保留 2 位小數，四捨五入）。

折扣規則：`GOLD` 8 折、`SILVER` 9 折、`NORMAL` 不打折；未知等級丟 `IllegalArgumentException`。
另外：小計滿 1000 元再折 50 元（折扣後計算，且不可為負）。

<details>
<summary>參考解答</summary>

```java
import java.math.BigDecimal;
import java.math.RoundingMode;

public class OrderCalculator {

    private static final BigDecimal FREE_SHIPPING_THRESHOLD = new BigDecimal("1000");
    private static final BigDecimal COUPON = new BigDecimal("50");

    public static BigDecimal calculate(String unitPrice, int quantity, String memberLevel) {
        if (unitPrice == null || unitPrice.isBlank()) {
            throw new IllegalArgumentException("單價不可為空");
        }
        if (quantity <= 0) {
            throw new IllegalArgumentException("數量必須大於 0，收到: " + quantity);
        }

        BigDecimal rate = switch (memberLevel) {
            case "GOLD"   -> new BigDecimal("0.8");
            case "SILVER" -> new BigDecimal("0.9");
            case "NORMAL" -> BigDecimal.ONE;
            default -> throw new IllegalArgumentException("未知會員等級: " + memberLevel);
        };

        BigDecimal subtotal = new BigDecimal(unitPrice)
                .multiply(BigDecimal.valueOf(quantity))
                .multiply(rate);

        if (subtotal.compareTo(FREE_SHIPPING_THRESHOLD) >= 0) {
            subtotal = subtotal.subtract(COUPON);
        }

        // 不可為負
        if (subtotal.compareTo(BigDecimal.ZERO) < 0) {
            subtotal = BigDecimal.ZERO;
        }

        return subtotal.setScale(2, RoundingMode.HALF_UP);
    }

    public static void main(String[] args) {
        System.out.println(calculate("4.35", 100, "GOLD"));    // 298.00 (435*0.8=348, -50)
        System.out.println(calculate("4.35", 100, "NORMAL"));  // 385.00 (435, -50)
        System.out.println(calculate("19.99", 3, "SILVER"));   // 53.97  (59.97*0.9, 未達門檻)

        try {
            calculate("100", 1, "PLATINUM");
        } catch (IllegalArgumentException e) {
            System.out.println("錯誤: " + e.getMessage());     // 錯誤: 未知會員等級: PLATINUM
        }
    }
}
```

**三個關鍵點：**

1. 折扣率也用 `BigDecimal`，不要 `subtotal.multiply(BigDecimal.valueOf(0.8))`——`0.8` 這個 `double` 本身就不精確。
2. 門檻比較用 `compareTo`，不是 `equals`。
3. `setScale` 放在**最後**。中途每一步都 setScale 會累積捨入誤差。

</details>

### 練習 3：分頁資訊計算

寫一個方法，輸入總筆數 `totalItems`、每頁筆數 `pageSize`、當前頁碼 `page`（從 1 開始），
回傳格式化字串：`第 3/10 頁，顯示第 21-30 筆，共 95 筆`。
最後一頁要顯示正確的結束筆數。

<details>
<summary>參考解答</summary>

```java
public class Pagination {

    public static String describe(int totalItems, int pageSize, int page) {
        if (pageSize <= 0) throw new IllegalArgumentException("pageSize 必須 > 0");
        if (page <= 0)     throw new IllegalArgumentException("page 從 1 開始");

        // 向上取整；totalItems 為 0 時頁數算 1，避免顯示「第 1/0 頁」
        int totalPages = Math.max(1, (totalItems + pageSize - 1) / pageSize);

        if (page > totalPages) {
            return "第 %d/%d 頁，沒有資料，共 %d 筆".formatted(page, totalPages, totalItems);
        }

        int from = (page - 1) * pageSize + 1;
        int to   = Math.min(page * pageSize, totalItems);      // ← 最後一頁的關鍵

        return "第 %d/%d 頁，顯示第 %d-%d 筆，共 %d 筆"
                .formatted(page, totalPages, from, to, totalItems);
    }

    public static void main(String[] args) {
        System.out.println(describe(95, 10, 3));    // 第 3/10 頁，顯示第 21-30 筆，共 95 筆
        System.out.println(describe(95, 10, 10));   // 第 10/10 頁，顯示第 91-95 筆，共 95 筆
        System.out.println(describe(95, 10, 11));   // 第 11/10 頁，沒有資料，共 95 筆
        System.out.println(describe(0, 10, 1));     // 第 1/1 頁，顯示第 1-0 筆，共 0 筆
        System.out.println(describe(100, 10, 10));  // 第 10/10 頁，顯示第 91-100 筆，共 100 筆
    }
}
```

**兩個容易錯的地方：**

1. `to` 要用 `Math.min`，否則最後一頁會顯示「第 91-100 筆」但實際只有 95 筆。
2. `totalItems = 0` 時 `totalPages` 是 0，前端顯示「第 1/0 頁」很怪，所以用 `Math.max(1, ...)`。

這兩個 bug 在真實專案的分頁 API 裡非常常見。第 03 站（REST API）講分頁時會再回到這裡。

</details>

### 練習 4：`switch` 表達式與狀態機

用 `enum` + `switch` 表達式實作一個訂單狀態轉移檢查：`canTransition(from, to)` 回傳是否允許。

規則：

```
CREATED   → PAID, CANCELLED
PAID      → SHIPPED, REFUNDED
SHIPPED   → DELIVERED
DELIVERED → （終態）
CANCELLED → （終態）
REFUNDED  → （終態）
```

<details>
<summary>參考解答</summary>

```java
import java.util.Set;

public class OrderTransition {

    enum Status { CREATED, PAID, SHIPPED, DELIVERED, CANCELLED, REFUNDED }

    // 沒有 default：日後在 enum 加新狀態，這裡會編譯失敗，強迫你來補規則
    static Set<Status> allowedNext(Status from) {
        return switch (from) {
            case CREATED   -> Set.of(Status.PAID, Status.CANCELLED);
            case PAID      -> Set.of(Status.SHIPPED, Status.REFUNDED);
            case SHIPPED   -> Set.of(Status.DELIVERED);
            case DELIVERED, CANCELLED, REFUNDED -> Set.of();      // 終態
        };
    }

    static boolean canTransition(Status from, Status to) {
        return allowedNext(from).contains(to);
    }

    /** 實務上通常再包一層，直接丟例外比回傳 boolean 好用 */
    static void assertTransition(Status from, Status to) {
        if (!canTransition(from, to)) {
            throw new IllegalStateException(
                    "不允許的狀態轉移: %s → %s（%s 只能轉為 %s）"
                            .formatted(from, to, from, allowedNext(from)));
        }
    }

    public static void main(String[] args) {
        System.out.println(canTransition(Status.CREATED, Status.PAID));        // true
        System.out.println(canTransition(Status.CREATED, Status.SHIPPED));     // false
        System.out.println(canTransition(Status.DELIVERED, Status.REFUNDED));  // false

        try {
            assertTransition(Status.DELIVERED, Status.CANCELLED);
        } catch (IllegalStateException e) {
            System.out.println(e.getMessage());
            // 不允許的狀態轉移: DELIVERED → CANCELLED（DELIVERED 只能轉為 []）
        }
    }
}
```

**為什麼這樣寫比一堆 `if` 好：**

1. 規則集中在一個地方，讀 code 就是讀規格。
2. 沒有 `default` → 新增狀態時編譯器提醒你。這是本章 1.11 節提過、實務上最有價值的一招。
3. 例外訊息帶上「合法的下一步」，線上 debug 時省掉一輪來回。

</details>

### 練習 5：解析設定字串

有一份設定字串：`"host=localhost;port=3306;user=root;timeout=30"`。
寫一個方法把它解析成 `Map<String, String>`，並提供 `getInt(key, defaultValue)` 讀取整數設定。
要能容忍多餘空白、空的區段、以及重複的 key（後者覆蓋前者）。

<details>
<summary>參考解答</summary>

```java
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

public class ConfigParser {

    private final Map<String, String> values;

    private ConfigParser(Map<String, String> values) {
        this.values = values;
    }

    public static ConfigParser parse(String raw) {
        Map<String, String> map = new LinkedHashMap<>();   // 保留輸入順序，除錯時好讀
        if (raw == null || raw.isBlank()) {
            return new ConfigParser(map);
        }

        // limit = -1 保留尾端空字串，才不會漏掉最後的空區段
        for (String segment : raw.split(";", -1)) {
            String trimmed = segment.strip();
            if (trimmed.isEmpty()) continue;              // 容忍 ";;" 或尾端 ";"

            // limit = 2：value 裡如果也有 '=' 不會被拆爛
            String[] pair = trimmed.split("=", 2);
            if (pair.length != 2) {
                throw new IllegalArgumentException("設定格式錯誤，缺少 '=': " + trimmed);
            }

            String key = pair[0].strip();
            String value = pair[1].strip();
            if (key.isEmpty()) {
                throw new IllegalArgumentException("設定的 key 不可為空: " + trimmed);
            }
            map.put(key, value);                          // 重複 key 自然覆蓋
        }
        return new ConfigParser(map);
    }

    public String get(String key, String defaultValue) {
        String v = values.get(key);
        return (v == null || v.isBlank()) ? defaultValue : v;
    }

    public int getInt(String key, int defaultValue) {
        String v = values.get(key);
        if (v == null || v.isBlank()) return defaultValue;
        try {
            return Integer.parseInt(v.strip());
        } catch (NumberFormatException e) {
            // 不要靜默吞掉：設定寫錯應該讓人知道
            throw new IllegalArgumentException(
                    "設定 %s 應為整數，實際為 '%s'".formatted(key, v), e);
        }
    }

    @Override
    public String toString() {
        return values.toString();
    }

    public static void main(String[] args) {
        ConfigParser cfg = ConfigParser.parse(
                " host = localhost ; port=3306 ;; user=root; timeout=30 ; port=3307 ;");

        System.out.println(cfg);                        // {host=localhost, port=3307, user=root, timeout=30}
        System.out.println(cfg.get("host", "127.0.0.1"));   // localhost
        System.out.println(cfg.get("charset", "utf8"));     // utf8（用預設值）
        System.out.println(cfg.getInt("port", 3306));       // 3307（後者覆蓋）
        System.out.println(cfg.getInt("maxPool", 10));      // 10

        try {
            ConfigParser.parse("timeout=abc").getInt("timeout", 30);
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());
            // 設定 timeout 應為整數，實際為 'abc'
        }
    }
}
```

**這題練到的重點：**

1. `split(";", -1)` 的 `limit = -1`（1.9 節的陷阱②）。
2. `split("=", 2)` 的 `limit = 2`，避免 value 裡的 `=` 被拆掉——密碼、連線字串常有 `=`。
3. `strip()` 而不是 `trim()`（能處理全形空白等 Unicode 空白）。
4. 解析失敗**不要回預設值**，要丟例外並帶上原因。「設定寫錯卻靜默用預設值」是很難查的線上問題。第 04 章會系統性地講這件事。

</details>

---

## 1.17 驗收清單

- [ ] 我知道 8 種基本型別的範圍，也知道時間戳與金額累加要用 `long`。
- [ ] 我能解釋 `0.1 + 0.2 != 0.3`，並知道金額要用 `BigDecimal`（且用字串建構子）。
- [ ] 我知道 `BigDecimal` 比較要用 `compareTo` 而不是 `equals`。
- [ ] 我知道整數除法會截斷，算比例要先轉 `double`。
- [ ] 我能說出 `Integer` 快取為什麼讓 `==` 在小數字下「假通過」。
- [ ] 我知道 `Map.get()` 的結果直接拆箱會 NPE，也知道 `getOrDefault`。
- [ ] 我一律用 `equals` 比字串，並習慣把常值放左邊。
- [ ] 我用箭頭語法的 `switch`，並知道 enum + 無 default 能得到完整性檢查。
- [ ] 我能解釋 Java 是值傳遞，以及為什麼「傳 List 進去內容卻被改了」。
- [ ] 我知道 `split` 吃的是 regex，也知道 `limit` 參數的兩種用法。
- [ ] 我能判斷什麼時候該用 `var`、什麼時候該寫出型別。

---

完成後請前往 [02-oop-class-object-encapsulation.md](./02-oop-class-object-encapsulation.md)。
