# 第 04 章：例外處理

> 這章的判斷標準很簡單：**線上出事的時候，你的 log 能不能讓你在 5 分鐘內找到原因？**
>
> 大部分「查不到原因」的線上問題，都不是因為程式有多難，而是因為例外被吞掉、被包爛、
> 或者訊息裡完全沒有「是哪一筆訂單、哪一個使用者、哪一個參數」。
> 這章要教的不只是 `try-catch` 語法，而是一套**能上線的例外策略**。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 畫出例外的繼承體系，並說明 `Error` 為什麼不該 catch。
- 說出 `try-catch-finally` 的執行順序，並解釋 `finally` 裡的 `return` 為什麼會吃掉例外。
- 在「checked 還是 unchecked」之間做出有理由的選擇。
- 用 try-with-resources 正確關閉資源，並解釋 suppressed exception。
- 設計一套帶錯誤碼的自訂例外體系，讓前端與客服都能對照。
- 規劃分層例外策略：哪一層 catch、哪一層往上拋、哪一層轉成 HTTP 回應。
- 正確記錄例外：知道什麼該記、記幾次、記在哪一層。
- 認出並改掉 8 個常見反模式。
- 判斷什麼時候該用例外、什麼時候該用回傳值或 `Optional`。

---

## 4.2 先看兩個真實的災難

### 災難一：例外被吞掉

```java
// ❌ 這段程式碼上線了三個月，沒有人知道有 12% 的訂單通知從來沒發出去
public void notifyCustomer(Order order) {
    try {
        emailSender.send(order.getEmail(), "訂單成立", buildBody(order));
    } catch (Exception e) {
        // 反正寄信失敗也不是大事
    }
}
```

**後果**：客服接到大量「我沒收到確認信」的客訴。工程師查 log——**什麼都沒有**。
從 log 看起來，系統完全正常。最後是靠比對 SMTP 服務商的後台紀錄才發現的。

### 災難二：例外被包爛

```java
// ❌ 原始原因整個消失
public Order findOrder(String id) {
    try {
        return repository.findById(id);
    } catch (SQLException e) {
        throw new RuntimeException("查詢失敗");     // 沒有 cause、沒有 id
    }
}
```

線上 log 只有：

```
java.lang.RuntimeException: 查詢失敗
    at com.example.OrderService.findOrder(OrderService.java:42)
    at com.example.OrderController.get(OrderController.java:28)
    ...
```

**哪一筆訂單？** 不知道。**資料庫為什麼失敗？** 連線池滿了？SQL 語法錯？逾時？權限不足？
全部看不出來。原始的 `SQLException`（裡面有 error code、SQL state、實際的 SQL）被丟掉了。

正確的寫法只多兩個東西——**cause 和上下文**：

```java
// ✅
public Order findOrder(String id) {
    try {
        return repository.findById(id);
    } catch (SQLException e) {
        throw new OrderQueryException("查詢訂單失敗，orderId=" + id, e);
        //                                                        ↑ 保留原始例外
    }
}
```

```
com.example.OrderQueryException: 查詢訂單失敗，orderId=ORD-20260817-001
    at com.example.OrderService.findOrder(OrderService.java:42)
    ...
Caused by: java.sql.SQLTransientConnectionException:
    HikariPool-1 - Connection is not available, request timed out after 30000ms
    at com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)
    ...
```

現在你 30 秒就知道：**連線池耗盡**。這一章的所有規則，都是為了讓 log 長成下面這樣，而不是上面那樣。

---

## 4.3 例外體系

```
                    Throwable
                   ╱         ╲
              Error           Exception
                │            ╱        ╲
    OutOfMemoryError   RuntimeException  （其他都是 checked）
    StackOverflowError       │            IOException
    NoClassDefFoundError     │            SQLException
                             │            InterruptedException
                    NullPointerException   ClassNotFoundException
                    IllegalArgumentException
                    IllegalStateException
                    IndexOutOfBoundsException
                    ClassCastException
                    ArithmeticException
                    NumberFormatException
```

### 三大類

| 類別 | 該不該 catch | 說明 |
|---|---|---|
| **`Error`** | ❌ **不要** | JVM 層級的嚴重問題，程式無法合理恢復 |
| **checked `Exception`** | ✅ 必須處理（catch 或 throws） | 可預期的外部失敗：檔案不存在、網路斷線 |
| **`RuntimeException`（unchecked）** | 視情況 | 通常是程式 bug 或呼叫方違約 |

### `Error` 為什麼不要 catch

```java
public class DontCatchError {
    public static void main(String[] args) {
        // ❌ 絕對不要這樣做
        try {
            byte[] huge = new byte[Integer.MAX_VALUE];
        } catch (OutOfMemoryError e) {
            System.out.println("繼續跑吧");
            // 記憶體已經不夠了，接下來每一個操作都可能再爆
            // 而且你剛剛把「應該讓程序死掉重啟」的信號吞掉了
        }
    }
}
```

`OutOfMemoryError` 發生時，JVM 的狀態已經不可靠：其他執行緒可能死在一半、資料可能寫到一半。
**正確做法是讓程序掛掉，讓 Kubernetes / systemd 重啟它**，並用第 09 章的方法分析 heap dump 找出根因。

> **唯一的例外**：頂層的「最後防線」可以 catch `Throwable`，但目的**只有記錄 log 然後結束**，
> 不是「繼續跑」。例如執行緒池的 `UncaughtExceptionHandler`。

### `RuntimeException` 常見成員與含意

```java
import java.util.List;
import java.util.Map;

public class CommonExceptions {
    public static void main(String[] args) {

        // NullPointerException：呼叫 null 的方法／存取 null 的欄位
        try {
            String s = null;
            s.length();
        } catch (NullPointerException e) {
            System.out.println("NPE: " + e.getMessage());
            // Cannot invoke "String.length()" because "s" is null   ← Java 14+ 的訊息很好用
        }

        // IllegalArgumentException：參數不合法（呼叫方傳錯）
        try {
            Integer.parseInt("abc");     // NumberFormatException 是它的子類別
        } catch (NumberFormatException e) {
            System.out.println("格式錯誤: " + e.getMessage());
            // For input string: "abc"
        }

        // IllegalStateException：物件當前狀態不允許這個操作
        try {
            List<String> list = List.of("a");
            list.add("b");               // UnsupportedOperationException 也算這一類
        } catch (UnsupportedOperationException e) {
            System.out.println("不支援的操作（不可變集合）");
        }

        // IndexOutOfBoundsException
        try {
            List.of("a").get(5);
        } catch (IndexOutOfBoundsException e) {
            System.out.println("越界: " + e.getMessage());
        }

        // ClassCastException
        try {
            Object o = "字串";
            Integer i = (Integer) o;
        } catch (ClassCastException e) {
            System.out.println("轉型失敗: " + e.getMessage());
        }

        // ArithmeticException
        try {
            int x = 1 / 0;
        } catch (ArithmeticException e) {
            System.out.println("算術錯誤: " + e.getMessage());     // / by zero
        }

        // ConcurrentModificationException（第 05 章詳述）
        try {
            List<String> mutable = new java.util.ArrayList<>(List.of("a", "b"));
            for (String s : mutable) {
                mutable.remove(s);
            }
        } catch (java.util.ConcurrentModificationException e) {
            System.out.println("迭代中修改集合");
        }
    }
}
```

**選對例外型別，等於在告訴讀者「誰的錯」：**

| 例外 | 語意 | 誰該修 |
|---|---|---|
| `IllegalArgumentException` | 你傳了不合法的參數 | 呼叫方 |
| `IllegalStateException` | 物件現在的狀態不能做這件事 | 呼叫方（呼叫順序錯） |
| `NullPointerException` | 通常是被呼叫方沒檢查，或呼叫方傳了 null | 看情況 |
| `UnsupportedOperationException` | 這個實作不支援這個操作 | 設計問題（見第 03 章 LSP） |

```java
import java.util.Objects;

public class WhichException {

    private boolean started = false;

    /** 參數問題 → IllegalArgumentException */
    public void setTimeout(int seconds) {
        if (seconds <= 0) {
            throw new IllegalArgumentException("timeout 必須大於 0，收到: " + seconds);
        }
    }

    /** 參數為 null → NullPointerException（用 Objects.requireNonNull，訊息更一致） */
    public void setName(String name) {
        Objects.requireNonNull(name, "name 不可為 null");
    }

    /** 狀態問題 → IllegalStateException */
    public void stop() {
        if (!started) {
            throw new IllegalStateException("尚未啟動，不能停止");
        }
        started = false;
    }
}
```

---

## 4.4 `try-catch-finally`

### 基本語法與執行順序

```java
public class TryCatchFinally {

    static String demo(int input) {
        try {
            System.out.println("  try 開始");
            if (input == 0) {
                throw new IllegalArgumentException("input 不可為 0");
            }
            System.out.println("  try 結束");
            return "正常";
        } catch (IllegalArgumentException e) {
            System.out.println("  catch: " + e.getMessage());
            return "捕捉到例外";
        } finally {
            // finally 一定會執行，不管有沒有例外、有沒有 return
            System.out.println("  finally 執行");
        }
    }

    public static void main(String[] args) {
        System.out.println("input=1 → " + demo(1));
        System.out.println("input=0 → " + demo(0));
    }
}
```

輸出：

```
  try 開始
  try 結束
  finally 執行
input=1 → 正常
  try 開始
  catch: input 不可為 0
  finally 執行
input=0 → 捕捉到例外
```

**注意順序**：`return` 的值先被計算並暫存，然後執行 `finally`，最後才真正返回。

### ⚠️ 陷阱一：`finally` 裡的 `return` 會吃掉例外

```java
public class FinallyReturnTrap {

    // ❌ 這個方法永遠不會丟例外，也永遠回傳 -1
    static int bad() {
        try {
            throw new RuntimeException("重要的錯誤");
        } finally {
            return -1;              // 💥 例外被完全丟棄
        }
    }

    // ❌ 覆寫了 try 的回傳值
    static int alsoBad() {
        try {
            return 1;
        } finally {
            return 2;               // 實際回傳 2
        }
    }

    public static void main(String[] args) {
        System.out.println(bad());        // -1（例外消失了！）
        System.out.println(alsoBad());    // 2
    }
}
```

> **鐵律：`finally` 區塊裡不要有 `return`、`break`、`continue`、`throw`。**
> `finally` 只做清理。現代 IDE 會對此發出警告，不要忽略它。

### ⚠️ 陷阱二：`finally` 裡丟例外，會蓋掉原始例外

```java
public class FinallyThrowTrap {

    static void bad() throws Exception {
        try {
            throw new IllegalStateException("真正的問題：資料格式錯誤");
        } finally {
            throw new RuntimeException("清理時的次要問題：關閉連線失敗");
        }
    }

    public static void main(String[] args) {
        try {
            bad();
        } catch (Exception e) {
            System.out.println(e.getMessage());
            // 清理時的次要問題：關閉連線失敗
            // ← 真正的問題完全看不到了
        }
    }
}
```

這就是為什麼**手動關閉資源的舊寫法**這麼容易出事：

```java
// ❌ Java 7 之前的寫法，一堆問題
Connection conn = null;
try {
    conn = dataSource.getConnection();
    // ... 業務邏輯，這裡丟出真正重要的例外
} finally {
    if (conn != null) {
        conn.close();       // 如果 close() 也丟例外，就蓋掉上面的例外
    }
}
```

4.8 節的 try-with-resources 從語言層面解決了這個問題。

### `finally` 唯一不執行的情況

```java
public class FinallyNotRun {
    public static void main(String[] args) {
        try {
            System.out.println("try");
            System.exit(0);          // JVM 直接結束，finally 不會執行
        } finally {
            System.out.println("finally");    // 不會印出
        }
    }
}
```

其他情況：JVM 被 `kill -9`、`OutOfMemoryError` 導致執行緒死亡、無窮迴圈。
**實務啟示**：資料一致性不要依賴 `finally`。要用交易（第 05 站 / 第 07 站）。

---

## 4.5 Checked vs Unchecked：設計上的取捨

### 語法差異

```java
import java.io.IOException;

public class CheckedVsUnchecked {

    // checked：呼叫方「被編譯器強迫」處理
    static void readFile() throws IOException {
        throw new IOException("檔案不存在");
    }

    // unchecked：呼叫方可以選擇不處理
    static void validate(int age) {
        if (age < 0) {
            throw new IllegalArgumentException("年齡不可為負: " + age);
        }
    }

    public static void main(String[] args) {
        // readFile();       // ❌ 編譯錯誤：必須 catch 或宣告 throws

        try {
            readFile();       // ✅
        } catch (IOException e) {
            System.out.println("處理: " + e.getMessage());
        }

        validate(-1);         // 編譯通過，執行時才炸
    }
}
```

### 兩派的爭論

**Checked 的原意**：讓編譯器強迫你面對「可預期的失敗」。理論上很美好。

**實際上的問題：**

```java
// ① 逼出無意義的 catch
try {
    doSomething();
} catch (SomeCheckedException e) {
    e.printStackTrace();       // 這行等於「我不知道該怎麼辦，所以什麼都不做」
}

// ② throws 污染整條呼叫鏈
void a() throws IOException { b(); }
void b() throws IOException { c(); }
void c() throws IOException { d(); }
// 中間每一層都被迫宣告，但它們什麼都不能做

// ③ 和 Lambda / Stream 不相容（見下方）
```

### Checked 例外在 Lambda 裡的痛

```java
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public class CheckedInLambda {

    public static void main(String[] args) {
        List<String> paths = List.of("a.txt", "b.txt");

        // ❌ 編譯錯誤：Files.readString 丟 IOException，
        //    但 Function 的 apply() 沒有宣告 throws
        // paths.stream().map(p -> Files.readString(Path.of(p))).toList();

        // 只能寫成又醜又長的樣子
        List<String> contents = paths.stream()
                .map(p -> {
                    try {
                        return Files.readString(Path.of(p));
                    } catch (IOException e) {
                        throw new UncheckedIOException2("讀取失敗: " + p, e);
                    }
                })
                .toList();
    }

    // JDK 其實提供了 java.io.UncheckedIOException，這裡只是示範自訂包裝
    static class UncheckedIOException2 extends RuntimeException {
        UncheckedIOException2(String message, Throwable cause) { super(message, cause); }
    }
}
```

> 這是實務上 checked 例外最大的痛點。因此 Spring、Hibernate 等現代框架**全面改用 unchecked**：
> Spring 的 `DataAccessException`、Hibernate 的 `HibernateException` 都是 `RuntimeException`。

### 實務決策建議

```
這個失敗，呼叫方「有可能」做出有意義的處理嗎？
（重試？降級？換備援？提示使用者修正輸入？）
    │
    ├─ 是，而且這是 API 的核心語意
    │      例：「找不到檔案」，呼叫方可以改路徑
    │      → checked（但要謹慎，因為會污染呼叫鏈）
    │
    └─ 否，或這是程式 bug、或呼叫方只能往上拋
           例：資料庫連不上、設定寫錯、參數不合法
           → unchecked
```

**本課建議（也是現代 Java 生態的主流）：**

| 情況 | 選擇 |
|---|---|
| 業務規則違反（餘額不足、庫存不足、狀態不允許） | **unchecked**，讓全域處理器轉成 HTTP 4xx |
| 參數 / 狀態不合法 | **unchecked**（`IllegalArgumentException` / `IllegalStateException`） |
| 基礎設施失敗（DB、HTTP、檔案） | **unchecked**，包裝底層 checked 例外 |
| 你在寫一個給外部使用的函式庫，且失敗是可恢復的核心語意 | 可以 checked，但要克制 |
| `InterruptedException` | JDK 定的 checked，必須正確處理（見 4.12 反模式 6） |

---

## 4.6 `throw` / `throws` / multi-catch

```java
import java.io.IOException;
import java.sql.SQLException;

public class ThrowThrows {

    // throws：宣告「我可能丟出這些」
    static void mayFail(int type) throws IOException, SQLException {
        if (type == 1) throw new IOException("IO 失敗");
        if (type == 2) throw new SQLException("SQL 失敗");
    }

    public static void main(String[] args) {

        // ① 分別 catch：處理方式不同時用這個
        try {
            mayFail(1);
        } catch (IOException e) {
            System.out.println("IO 問題，重試: " + e.getMessage());
        } catch (SQLException e) {
            System.out.println("DB 問題，告警: " + e.getMessage());
        }

        // ② multi-catch【Java 7+】：處理方式相同時，不要複製貼上
        try {
            mayFail(2);
        } catch (IOException | SQLException e) {
            System.out.println("外部系統失敗: " + e.getClass().getSimpleName());
        }

        // ③ catch 的順序：子類別必須在父類別「之前」
        try {
            mayFail(1);
        } catch (IOException e) {          // 具體
            System.out.println("IO");
        } catch (Exception e) {            // 一般
            System.out.println("其他");
        }
        // 反過來寫（Exception 在前）會編譯錯誤：unreachable catch block
    }
}
```

### 別忘記 `catch` 之後可以再拋

```java
public class CatchAndRethrow {

    static void process(String data) {
        try {
            parse(data);
        } catch (NumberFormatException e) {
            // 做了有意義的事（補充上下文），然後往上拋
            throw new IllegalArgumentException(
                    "資料格式錯誤，無法解析: '" + data + "'", e);
        }
    }

    static void parse(String data) {
        Integer.parseInt(data);
    }

    public static void main(String[] args) {
        try {
            process("abc");
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());              // 資料格式錯誤，無法解析: 'abc'
            System.out.println("原因: " + e.getCause());      // 原因: java.lang.NumberFormatException...
        }
    }
}
```

> **原則：只有在你能「加上價值」時才 catch。** 加上上下文、換成更合適的型別、降級處理、重試。
> 如果你只是 `catch` 然後原封不動 `throw e;`，那就不要 catch。

---

## 4.7 例外鏈：`cause` 是你的救命繩

```java
import java.sql.SQLException;

public class ExceptionChaining {

    static class DataAccessException extends RuntimeException {
        DataAccessException(String message, Throwable cause) {
            super(message, cause);      // ← 關鍵：把原因傳給父類別
        }
    }

    static class OrderNotFoundException extends RuntimeException {
        OrderNotFoundException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    static void layer3_database() throws SQLException {
        throw new SQLException("Connection refused: connect", "08S01", 0);
    }

    static void layer2_repository(String orderId) {
        try {
            layer3_database();
        } catch (SQLException e) {
            throw new DataAccessException("查詢 orders 表失敗，orderId=" + orderId, e);
        }
    }

    static void layer1_service(String orderId) {
        try {
            layer2_repository(orderId);
        } catch (DataAccessException e) {
            throw new OrderNotFoundException("無法取得訂單 " + orderId, e);
        }
    }

    public static void main(String[] args) {
        try {
            layer1_service("ORD-001");
        } catch (RuntimeException e) {
            // 走完整條 cause 鏈
            Throwable current = e;
            int level = 0;
            while (current != null) {
                System.out.println("  ".repeat(level) + "→ "
                        + current.getClass().getSimpleName() + ": " + current.getMessage());
                current = current.getCause();
                level++;
            }
        }
    }
}
```

輸出：

```
→ OrderNotFoundException: 無法取得訂單 ORD-001
  → DataAccessException: 查詢 orders 表失敗，orderId=ORD-001
    → SQLException: Connection refused: connect
```

實際的 `printStackTrace()` 會顯示成：

```
OrderNotFoundException: 無法取得訂單 ORD-001
    at ...
Caused by: DataAccessException: 查詢 orders 表失敗，orderId=ORD-001
    at ...
Caused by: java.sql.SQLException: Connection refused: connect
    at ...
```

### 好訊息 vs 爛訊息

```java
// ❌ 這些訊息一點用都沒有
throw new RuntimeException("錯誤");
throw new RuntimeException("失敗了");
throw new IllegalStateException();                      // 連訊息都沒有
throw new RuntimeException(e.getMessage());             // 丟掉了 cause 和堆疊

// ✅ 好訊息包含：發生什麼 + 相關的識別資訊 + 期望值
throw new IllegalArgumentException(
        "折扣率需在 0~100 之間，收到: " + rate);

throw new InsufficientStockException(
        "商品 %s 庫存不足：需要 %d，剩餘 %d".formatted(sku, required, available));

throw new OrderStateException(
        "訂單 %s 狀態為 %s，不允許取消（僅 CREATED / PAID 可取消）"
                .formatted(orderId, currentStatus));
```

**檢查清單——寫例外訊息時問自己：**

1. 光看這行訊息，我知道是**哪一筆資料**出問題嗎？（訂單編號、使用者 ID、SKU）
2. 我知道**實際值**和**期望值**嗎？
3. 我知道**下一步該做什麼**嗎？
4. 訊息裡有**密碼、token、身分證**嗎？（有 → 拿掉）

---

## 4.8 try-with-resources

### 舊寫法的問題

```java
import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;

public class OldStyleClose {

    // ❌ Java 6 的寫法：又長又容易錯
    static String readOld(String path) throws IOException {
        BufferedReader reader = null;
        try {
            reader = new BufferedReader(new FileReader(path));
            return reader.readLine();
        } finally {
            if (reader != null) {
                try {
                    reader.close();       // close() 自己也會丟 IOException
                } catch (IOException e) {
                    // 這裡如果不 catch，就會蓋掉 try 裡真正的例外（4.4 陷阱二）
                }
            }
        }
    }
}
```

### try-with-resources【Java 7+】

```java
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class TryWithResources {

    static String readNew(String path) throws IOException {
        // 括號裡宣告的資源，離開 try 區塊時自動 close()（不論正常或例外）
        try (BufferedReader reader = Files.newBufferedReader(Path.of(path))) {
            return reader.readLine();
        }
    }

    // 多個資源用分號分隔，關閉順序與宣告順序「相反」
    static void copy(String from, String to) throws IOException {
        try (var in = Files.newBufferedReader(Path.of(from));
             var out = Files.newBufferedWriter(Path.of(to))) {
            String line;
            while ((line = in.readLine()) != null) {
                out.write(line);
                out.newLine();
            }
        }
        // 關閉順序：out.close() 先，in.close() 後
    }
}
```

### 自己的類別也可以用：實作 `AutoCloseable`

```java
public class CustomResource {

    /** 實作 AutoCloseable 就能用在 try-with-resources */
    static class DatabaseConnection implements AutoCloseable {
        private final String name;

        DatabaseConnection(String name) {
            this.name = name;
            System.out.println("開啟連線: " + name);
        }

        void query(String sql) {
            System.out.println("  執行: " + sql);
            if (sql.contains("DROP")) {
                throw new IllegalArgumentException("禁止 DROP 語句");
            }
        }

        @Override
        public void close() {
            System.out.println("關閉連線: " + name);
        }
    }

    public static void main(String[] args) {
        System.out.println("--- 正常情況 ---");
        try (DatabaseConnection conn = new DatabaseConnection("conn-1")) {
            conn.query("SELECT * FROM orders");
        }

        System.out.println("--- 例外情況 ---");
        try (DatabaseConnection conn = new DatabaseConnection("conn-2")) {
            conn.query("DROP TABLE orders");
        } catch (IllegalArgumentException e) {
            System.out.println("  捕捉: " + e.getMessage());
        }

        System.out.println("--- 多個資源，關閉順序相反 ---");
        try (DatabaseConnection a = new DatabaseConnection("A");
             DatabaseConnection b = new DatabaseConnection("B")) {
            a.query("SELECT 1");
        }
    }
}
```

輸出：

```
--- 正常情況 ---
開啟連線: conn-1
  執行: SELECT * FROM orders
關閉連線: conn-1
--- 例外情況 ---
開啟連線: conn-2
  執行: DROP TABLE orders
關閉連線: conn-2          ← 例外發生時也會關閉
  捕捉: 禁止 DROP 語句
--- 多個資源，關閉順序相反 ---
開啟連線: A
開啟連線: B
  執行: SELECT 1
關閉連線: B               ← B 先關
關閉連線: A
```

### Suppressed exception：兩個例外都保留

try-with-resources 解決了「close() 蓋掉原始例外」的問題——它把 close() 的例外**壓制（suppress）**，
附加在主例外上。

```java
public class SuppressedDemo {

    static class BrokenResource implements AutoCloseable {
        @Override
        public void close() {
            throw new IllegalStateException("關閉時失敗");
        }
    }

    static void demo() {
        try (BrokenResource r = new BrokenResource()) {
            throw new RuntimeException("業務邏輯失敗（這是重點）");
        }
    }

    public static void main(String[] args) {
        try {
            demo();
        } catch (RuntimeException e) {
            System.out.println("主要例外: " + e.getMessage());
            for (Throwable suppressed : e.getSuppressed()) {
                System.out.println("被壓制的例外: " + suppressed.getMessage());
            }
        }
    }
}
```

輸出：

```
主要例外: 業務邏輯失敗（這是重點）
被壓制的例外: 關閉時失敗
```

**兩個資訊都在**。對照 4.4 節的舊寫法（真正的例外整個消失），這是巨大的進步。

### 【Java 9+】effectively final 資源

```java
public class Java9Resource {

    static class Res implements AutoCloseable {
        private final String name;
        Res(String name) { this.name = name; }
        @Override public void close() { System.out.println("close " + name); }
    }

    public static void main(String[] args) {
        Res existing = new Res("existing");

        // Java 9+ 可以直接用既有的變數（必須是 final 或 effectively final）
        try (existing) {
            System.out.println("使用中");
        }

        // Java 7/8 必須重新宣告
        // try (Res r = existing) { }
    }
}
```

> **實務提醒**：Spring 的 `JdbcTemplate`、JPA 的 `EntityManager` 通常由框架管理生命週期，
> 你不需要自己 try-with-resources。但用原生 JDBC、讀寫檔案、開 HTTP 連線時，**一定要用**。
> 第 06 站會對照「手動管理 vs 框架管理」的差別。

---

## 4.9 自訂例外設計

### 基本模板

```java
/**
 * 業務例外的基底類別。
 * 選 RuntimeException 的理由見 4.5 節：呼叫鏈中間層通常無法處理，
 * 統一由最外層（Controller / 全域處理器）轉成 API 回應。
 */
public abstract class BusinessException extends RuntimeException {

    private final String errorCode;

    protected BusinessException(String errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    protected BusinessException(String errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }

    public String getErrorCode() {
        return errorCode;
    }
}
```

### 帶錯誤碼的完整體系（實務做法）

錯誤碼的價值：**前端可以據此顯示對應文案、客服可以據此查手冊、監控可以據此分類告警**。

```java
/** 錯誤碼集中管理，避免字串散落各處 */
public enum ErrorCode {

    // 通用（1xxx）
    INVALID_ARGUMENT("E1001", "參數不合法", 400),
    UNAUTHORIZED("E1002", "未登入", 401),
    FORBIDDEN("E1003", "無權限", 403),
    NOT_FOUND("E1004", "資源不存在", 404),

    // 訂單（2xxx）
    ORDER_NOT_FOUND("E2001", "訂單不存在", 404),
    ORDER_STATE_INVALID("E2002", "訂單狀態不允許此操作", 409),
    ORDER_ALREADY_PAID("E2003", "訂單已付款", 409),

    // 庫存（3xxx）
    INSUFFICIENT_STOCK("E3001", "庫存不足", 409),

    // 付款（4xxx）
    PAYMENT_DECLINED("E4001", "付款被拒絕", 402),
    PAYMENT_GATEWAY_ERROR("E4002", "付款閘道異常", 502),

    // 系統（9xxx）
    INTERNAL_ERROR("E9001", "系統內部錯誤", 500),
    EXTERNAL_SERVICE_ERROR("E9002", "外部服務異常", 502);

    private final String code;
    private final String defaultMessage;
    private final int httpStatus;      // 讓 Controller 層直接用

    ErrorCode(String code, String defaultMessage, int httpStatus) {
        this.code = code;
        this.defaultMessage = defaultMessage;
        this.httpStatus = httpStatus;
    }

    public String getCode() { return code; }
    public String getDefaultMessage() { return defaultMessage; }
    public int getHttpStatus() { return httpStatus; }
}
```

```java
import java.util.LinkedHashMap;
import java.util.Map;

/** 所有業務例外的基底 */
public class BusinessException extends RuntimeException {

    private final ErrorCode errorCode;
    private final Map<String, Object> context = new LinkedHashMap<>();

    public BusinessException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public BusinessException(ErrorCode errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }

    /** 附加結構化上下文，比塞在訊息字串裡好處理（可以進 log 的 MDC 或 JSON 欄位） */
    public BusinessException with(String key, Object value) {
        context.put(key, value);
        return this;
    }

    public ErrorCode getErrorCode() { return errorCode; }

    public Map<String, Object> getContext() { return Map.copyOf(context); }

    @Override
    public String getMessage() {
        String base = "[%s] %s".formatted(errorCode.getCode(), super.getMessage());
        return context.isEmpty() ? base : base + " " + context;
    }
}
```

具體的例外類別：

```java
public class OrderNotFoundException extends BusinessException {
    public OrderNotFoundException(String orderId) {
        super(ErrorCode.ORDER_NOT_FOUND, "找不到訂單");
        with("orderId", orderId);
    }
}

public class InsufficientStockException extends BusinessException {
    public InsufficientStockException(String sku, int required, int available) {
        super(ErrorCode.INSUFFICIENT_STOCK,
              "商品庫存不足");
        with("sku", sku).with("required", required).with("available", available);
    }
}

public class OrderStateException extends BusinessException {
    public OrderStateException(String orderId, String currentState, String operation) {
        super(ErrorCode.ORDER_STATE_INVALID, "訂單狀態不允許此操作");
        with("orderId", orderId).with("currentState", currentState).with("operation", operation);
    }
}
```

使用與輸出：

```java
public class CustomExceptionDemo {
    public static void main(String[] args) {

        try {
            throw new InsufficientStockException("SKU-1001", 5, 2);
        } catch (BusinessException e) {
            System.out.println(e.getMessage());
            // [E3001] 商品庫存不足 {sku=SKU-1001, required=5, available=2}

            System.out.println("錯誤碼: " + e.getErrorCode().getCode());     // E3001
            System.out.println("HTTP: " + e.getErrorCode().getHttpStatus()); // 409
            System.out.println("上下文: " + e.getContext());
            // {sku=SKU-1001, required=5, available=2}
        }

        try {
            throw new OrderStateException("ORD-001", "DELIVERED", "cancel");
        } catch (BusinessException e) {
            System.out.println(e.getMessage());
            // [E2002] 訂單狀態不允許此操作 {orderId=ORD-001, currentState=DELIVERED, operation=cancel}
        }
    }
}
```

### 自訂例外的設計原則

| 原則 | 說明 |
|---|---|
| 有一個共同基底 | 才能在全域處理器裡一次 catch |
| 錯誤碼用 enum 集中管理 | 避免字串散落、方便對照文件 |
| 建構子強迫傳入必要上下文 | `new OrderNotFoundException(orderId)` 而不是 `new OrderNotFoundException()` |
| 保留 `cause` | 包裝底層例外時一定要傳 |
| 不要為每個 if 都開一個例外類別 | 通常 5～15 個類別就夠。細分用錯誤碼，不用類別 |
| 預設 unchecked | 見 4.5 節 |

> ⚠️ **不要過度設計**。我見過一個專案有 87 個自訂例外類別，大部分只用過一次。
> 「一個基底 + 5～10 個常用子類別 + 錯誤碼 enum」通常就是最佳平衡。

---

## 4.10 分層例外策略

這是把上面所有東西組合成「能上線的架構」的一節。

```
┌────────────────────────────────────────────────────────────┐
│ Controller / Web 層                                        │
│   職責：把例外轉成 HTTP 回應                                 │
│   做法：全域例外處理器（Spring: @RestControllerAdvice）      │
│   不做：不寫 try-catch，不處理業務邏輯                        │
└────────────────────────────────────────────────────────────┘
                          ↑ 往上拋（不 catch）
┌────────────────────────────────────────────────────────────┐
│ Service 層（商業邏輯）                                       │
│   職責：驗證業務規則 → 丟業務例外                             │
│         處理可恢復的失敗（重試、降級、備援）                    │
│   做法：throw new InsufficientStockException(...)           │
│   不做：不 catch 自己丟的例外，不轉成 HTTP 狀態碼              │
└────────────────────────────────────────────────────────────┘
                          ↑ 往上拋
┌────────────────────────────────────────────────────────────┐
│ Repository 層（資料存取）                                    │
│   職責：把技術例外（SQLException / IOException）             │
│         包成統一的 DataAccessException                      │
│   做法：catch (SQLException e) → throw new DataAccess...    │
│   不做：不判斷業務規則，不吞例外                               │
└────────────────────────────────────────────────────────────┘
```

### 完整可執行範例

```java
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

// ===================== 例外定義 =====================

enum ErrorCode {
    NOT_FOUND("E1004", 404),
    INSUFFICIENT_STOCK("E3001", 409),
    ORDER_STATE_INVALID("E2002", 409),
    INTERNAL_ERROR("E9001", 500),
    EXTERNAL_SERVICE_ERROR("E9002", 502);

    private final String code;
    private final int httpStatus;

    ErrorCode(String code, int httpStatus) {
        this.code = code;
        this.httpStatus = httpStatus;
    }

    public String getCode() { return code; }
    public int getHttpStatus() { return httpStatus; }
}

class BusinessException extends RuntimeException {
    private final ErrorCode errorCode;
    private final Map<String, Object> context = new LinkedHashMap<>();

    BusinessException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    BusinessException(ErrorCode errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }

    BusinessException with(String key, Object value) {
        context.put(key, value);
        return this;
    }

    ErrorCode getErrorCode() { return errorCode; }
    Map<String, Object> getContext() { return Map.copyOf(context); }
}

/** Repository 層專用：技術性失敗 */
class DataAccessException extends BusinessException {
    DataAccessException(String message, Throwable cause) {
        super(ErrorCode.INTERNAL_ERROR, message, cause);
    }
}

class ProductNotFoundException extends BusinessException {
    ProductNotFoundException(String sku) {
        super(ErrorCode.NOT_FOUND, "商品不存在");
        with("sku", sku);
    }
}

class InsufficientStockException extends BusinessException {
    InsufficientStockException(String sku, int required, int available) {
        super(ErrorCode.INSUFFICIENT_STOCK, "庫存不足");
        with("sku", sku).with("required", required).with("available", available);
    }
}

// ===================== Repository 層 =====================

interface ProductRepository {
    Optional<Integer> findStock(String sku);
    void updateStock(String sku, int newStock);
}

class JdbcProductRepository implements ProductRepository {

    private final Map<String, Integer> table = new HashMap<>(Map.of(
            "SKU-1001", 10,
            "SKU-1002", 0,
            "SKU-BROKEN", 5));

    @Override
    public Optional<Integer> findStock(String sku) {
        try {
            // 模擬 JDBC 呼叫；SKU-BROKEN 模擬資料庫連線失敗
            if ("SKU-BROKEN".equals(sku)) {
                throw new java.sql.SQLException(
                        "Connection is not available, request timed out after 30000ms",
                        "08001");
            }
            return Optional.ofNullable(table.get(sku));

        } catch (java.sql.SQLException e) {
            // ✅ Repository 的職責：把技術例外包成統一型別，並帶上上下文
            throw new DataAccessException("查詢庫存失敗，sku=" + sku, e);
        }
    }

    @Override
    public void updateStock(String sku, int newStock) {
        table.put(sku, newStock);
    }
}

// ===================== Service 層 =====================

class InventoryService {

    private final ProductRepository repository;

    InventoryService(ProductRepository repository) {
        this.repository = repository;
    }

    /**
     * 扣庫存。
     * ✅ 只丟業務例外，不 catch、不轉 HTTP 狀態碼。
     * ⚠️ 這裡的「查詢 → 判斷 → 更新」在多執行緒/多節點下有競態條件，
     *    正式做法需要資料庫層的原子更新或鎖，見第 07 站。
     */
    void reserve(String sku, int quantity) {
        if (quantity <= 0) {
            throw new IllegalArgumentException("數量必須大於 0，收到: " + quantity);
        }

        int available = repository.findStock(sku)
                .orElseThrow(() -> new ProductNotFoundException(sku));

        if (available < quantity) {
            throw new InsufficientStockException(sku, quantity, available);
        }

        repository.updateStock(sku, available - quantity);
    }
}

// ===================== Controller 層 =====================

/** 模擬 HTTP 回應 */
record ApiResponse(int status, String code, String message, Map<String, Object> details) {
    @Override
    public String toString() {
        return "HTTP %d  {\"code\":\"%s\",\"message\":\"%s\",\"details\":%s}"
                .formatted(status, code, message, details);
    }
}

class InventoryController {

    private final InventoryService service;

    InventoryController(InventoryService service) {
        this.service = service;
    }

    /**
     * ✅ Controller 不寫 try-catch。
     * 這裡的 try-catch 是模擬「全域例外處理器」，
     * 在 Spring 裡它是一個獨立的 @RestControllerAdvice 類別。
     */
    ApiResponse reserve(String sku, int quantity) {
        try {
            service.reserve(sku, quantity);
            return new ApiResponse(200, "OK", "預留成功", Map.of("sku", sku, "quantity", quantity));

        } catch (IllegalArgumentException e) {
            // 參數問題 → 400
            return new ApiResponse(400, "E1001", e.getMessage(), Map.of());

        } catch (BusinessException e) {
            // 業務例外 → 依錯誤碼決定狀態碼
            logByStatus(e);
            return new ApiResponse(e.getErrorCode().getHttpStatus(),
                    e.getErrorCode().getCode(), e.getMessage(), e.getContext());

        } catch (RuntimeException e) {
            // 最後防線：未預期的例外一律 500，且必須記完整堆疊
            System.err.println("[ERROR] 未預期的例外");
            e.printStackTrace();      // 實務用 log.error("...", e)
            return new ApiResponse(500, "E9001", "系統內部錯誤，請稍後再試", Map.of());
        }
    }

    /** 4xx 是使用者問題，記 WARN；5xx 是我們的問題，記 ERROR 加堆疊 */
    private void logByStatus(BusinessException e) {
        int status = e.getErrorCode().getHttpStatus();
        if (status >= 500) {
            System.err.printf("[ERROR] %s %s %s%n",
                    e.getErrorCode().getCode(), e.getMessage(), e.getContext());
            if (e.getCause() != null) {
                System.err.println("        原因: " + e.getCause());
            }
        } else {
            System.out.printf("[WARN] %s %s %s%n",
                    e.getErrorCode().getCode(), e.getMessage(), e.getContext());
        }
    }
}

// ===================== 執行 =====================

public class LayeredExceptionDemo {
    public static void main(String[] args) {
        InventoryController controller =
                new InventoryController(new InventoryService(new JdbcProductRepository()));

        System.out.println("① 正常: " + controller.reserve("SKU-1001", 3));
        System.out.println();

        System.out.println("② 庫存不足:");
        System.out.println("   " + controller.reserve("SKU-1002", 1));
        System.out.println();

        System.out.println("③ 商品不存在:");
        System.out.println("   " + controller.reserve("SKU-9999", 1));
        System.out.println();

        System.out.println("④ 參數錯誤:");
        System.out.println("   " + controller.reserve("SKU-1001", -1));
        System.out.println();

        System.out.println("⑤ 資料庫失敗:");
        System.out.println("   " + controller.reserve("SKU-BROKEN", 1));
    }
}
```

輸出：

```
① 正常: HTTP 200  {"code":"OK","message":"預留成功","details":{...}}

② 庫存不足:
[WARN] E3001 庫存不足 {sku=SKU-1002, required=1, available=0}
   HTTP 409  {"code":"E3001","message":"庫存不足","details":{sku=SKU-1002, required=1, available=0}}

③ 商品不存在:
[WARN] E1004 商品不存在 {sku=SKU-9999}
   HTTP 404  {"code":"E1004","message":"商品不存在","details":{sku=SKU-9999}}

④ 參數錯誤:
   HTTP 400  {"code":"E1001","message":"數量必須大於 0，收到: -1","details":{}}

⑤ 資料庫失敗:
[ERROR] E9001 查詢庫存失敗，sku=SKU-BROKEN {}
        原因: java.sql.SQLException: Connection is not available, request timed out after 30000ms
   HTTP 500  {"code":"E9001","message":"查詢庫存失敗，sku=SKU-BROKEN","details":{}}
```

### 每一層的規則整理

| 層 | 該做 | 不該做 |
|---|---|---|
| Repository | 包裝 `SQLException` / `IOException` 成統一例外，帶上查詢參數 | 判斷業務規則、吞例外、回傳 null 表示失敗 |
| Service | 驗證業務規則並丟業務例外；只在能重試/降級時 catch | catch 自己丟的例外、決定 HTTP 狀態碼 |
| Controller | 什麼都不 catch（交給全域處理器） | 寫業務邏輯、把技術細節洩漏給前端 |
| 全域處理器 | 統一轉成 API 錯誤格式；決定 log 等級 | 讓 5xx 的訊息暴露 SQL、堆疊給前端 |

> ⚠️ **回應給前端的 5xx 訊息要小心**。上面的 `⑤` 為了教學把 `查詢庫存失敗，sku=SKU-BROKEN` 回給前端，
> 實務上 5xx 應該回一個固定文案 + **traceId**，詳細原因只留在 log：
>
> ```json
> {"code":"E9001","message":"系統內部錯誤","traceId":"a1b2c3d4"}
> ```
>
> 這樣客戶回報 traceId，你就能在 log 裡精準找到那一次請求。第 03 站與第 10 站會實作這個。

---

## 4.11 記錄例外：怎麼記才有用

### `printStackTrace()` 為什麼不能用在正式環境

```java
// ❌ 四個問題
catch (Exception e) {
    e.printStackTrace();
}
```

1. 印到 `System.err`，**不會進你的 log 檔**（也就不會被 ELK / Loki / CloudWatch 收集）。
2. **沒有時間戳、沒有等級、沒有執行緒名、沒有 logger 名稱**——無法過濾、無法告警。
3. 高併發下多個堆疊會**交錯混在一起**，讀不出來。
4. 它經常搭配「什麼都不做」使用，等於吞掉例外。

### 正確做法

```java
// 實務上用 SLF4J（Spring Boot 預設就有）
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ProperLogging {

    private static final Logger log = LoggerFactory.getLogger(ProperLogging.class);

    void process(String orderId) {
        try {
            doWork(orderId);

        } catch (InsufficientStockException e) {
            // 業務例外：使用者的問題，不需要堆疊，用 WARN
            log.warn("庫存不足，orderId={}, detail={}", orderId, e.getContext());
            throw e;

        } catch (DataAccessException e) {
            // 技術例外：我們的問題，需要完整堆疊，用 ERROR
            // ⚠️ 注意：例外物件放「最後一個參數」，不要放進 {} 佔位符
            log.error("資料存取失敗，orderId={}", orderId, e);
            throw e;
        }
    }

    void doWork(String orderId) { }
}
```

**SLF4J 的兩個關鍵細節：**

```java
// ✅ 用 {} 佔位符：字串只在真的要輸出時才組裝（level 沒開就零成本）
log.debug("處理訂單 {} 的第 {} 筆項目", orderId, index);

// ❌ 用 + 串接：即使 debug 沒開，字串也已經組好了（白做工）
log.debug("處理訂單 " + orderId + " 的第 " + index + " 筆項目");

// ✅ 例外放最後一個參數，不用 {}
log.error("處理失敗，orderId={}", orderId, e);

// ❌ 這樣只會印出 e.toString()，堆疊完全遺失
log.error("處理失敗，orderId={}, error={}", orderId, e);
```

### Log 等級怎麼選

| 等級 | 什麼時候用 | 例子 |
|---|---|---|
| `ERROR` | 需要人來處理，該告警 | DB 連不上、外部服務掛掉、未預期的例外 |
| `WARN` | 異常但系統能繼續 | 業務規則被違反、重試成功、降級啟動 |
| `INFO` | 重要的業務事件 | 訂單建立、付款完成、服務啟動 |
| `DEBUG` | 開發除錯用 | 方法參數、中間結果 |
| `TRACE` | 極細節 | 迴圈內每一步 |

### ⚠️ 不要重複記錄同一個例外

```java
// ❌ 同一個錯誤在 log 裡出現三次，堆疊互相干擾，看的人以為有三個問題
class Repository {
    void save() {
        try { /* ... */ }
        catch (SQLException e) {
            log.error("儲存失敗", e);                        // 第 1 次
            throw new DataAccessException("儲存失敗", e);
        }
    }
}

class Service {
    void process() {
        try { repository.save(); }
        catch (DataAccessException e) {
            log.error("處理失敗", e);                        // 第 2 次
            throw e;
        }
    }
}

class Controller {
    void handle() {
        try { service.process(); }
        catch (Exception e) {
            log.error("請求失敗", e);                        // 第 3 次
        }
    }
}
```

**規則：例外只在「最終處理它的地方」記錄一次。**

```java
// ✅ 中間層只包裝與往上拋，不記 log
class Repository {
    void save() {
        try { /* ... */ }
        catch (SQLException e) {
            throw new DataAccessException("儲存訂單失敗，orderId=" + id, e);   // 不記 log
        }
    }
}

// ✅ 只有全域處理器記，記一次，記完整
class GlobalExceptionHandler {
    ApiResponse handle(Exception e) {
        log.error("請求處理失敗，traceId={}", MDC.get("traceId"), e);   // 唯一一次
        return ApiResponse.error(...);
    }
}
```

> **例外**：如果中間層做了「有意義的處理」（重試成功、降級到快取），那要記 `WARN`——
> 因為那是一個獨立的事件，不只是同一個錯誤的轉手。

### 不要 log 敏感資料

```java
// ❌ 會出現在 log、被收集、被備份、被 SRE 看到
log.error("登入失敗，帳號={}, 密碼={}", username, password);
log.info("建立訂單，卡號={}", creditCardNumber);
log.debug("呼叫外部 API，header={}", headers);      // Authorization 就在裡面

// ✅
log.error("登入失敗，帳號={}", username);
log.info("建立訂單，卡號末四碼={}", maskCard(cardNumber));
log.debug("呼叫外部 API，headerKeys={}", headers.keySet());
```

---

## 4.12 八個反模式

### 反模式 1：吞掉例外

```java
// ❌ 最嚴重的一個
try { doWork(); } catch (Exception e) { }
try { doWork(); } catch (Exception e) { e.printStackTrace(); }

// ✅ 三種合理選項，任選一個
try { doWork(); }
catch (SpecificException e) {
    // A. 往上拋（加上上下文）
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, "處理失敗，id=" + id, e);
}
// B. 處理它（重試、降級）並記 WARN
// C. 真的可以忽略 → 記 DEBUG 並寫下註解說明「為什麼可以忽略」
```

「真的可以忽略」的例子（要寫註解說明）：

```java
try {
    Files.deleteIfExists(tempFile);
} catch (IOException e) {
    // 暫存檔刪不掉不影響主流程，作業系統會在重開機時清理 /tmp
    log.debug("暫存檔刪除失敗: {}", tempFile, e);
}
```

### 反模式 2：`catch (Exception e)` 一網打盡

```java
// ❌ 連 NullPointerException（你的 bug）都被當成「業務失敗」處理了
try {
    order.getItems().forEach(this::validate);
    payment.charge(order.getTotal());
} catch (Exception e) {
    return ApiResponse.error("付款失敗");     // 其實是 items 是 null 造成的 NPE
}

// ✅ catch 具體型別
try {
    payment.charge(order.getTotal());
} catch (PaymentDeclinedException e) {
    return ApiResponse.error(ErrorCode.PAYMENT_DECLINED, e.getMessage());
} catch (PaymentGatewayException e) {
    // 閘道問題可以重試
    return retryOrQueue(order);
}
```

### 反模式 3：用例外控制正常流程

```java
// ❌ 把「找不到」當成例外情況
try {
    User user = userRepository.findById(id);
    return user;
} catch (UserNotFoundException e) {
    return createGuestUser();       // 這是正常路徑，不是例外
}

// ✅ 用 Optional 表達「可能沒有」
return userRepository.findById(id).orElseGet(this::createGuestUser);
```

```java
// ❌ 用例外當迴圈終止條件（真的有人這樣寫過）
try {
    int i = 0;
    while (true) {
        System.out.println(array[i++]);
    }
} catch (ArrayIndexOutOfBoundsException e) {
    // 陣列走完了
}

// ✅
for (int value : array) {
    System.out.println(value);
}
```

### 反模式 4：丟掉 `cause`

```java
// ❌
catch (SQLException e) { throw new RuntimeException("查詢失敗"); }
catch (SQLException e) { throw new RuntimeException(e.getMessage()); }   // 一樣爛

// ✅
catch (SQLException e) { throw new DataAccessException("查詢失敗，id=" + id, e); }
```

### 反模式 5：在 `finally` 裡 `return` 或 `throw`

見 4.4 節。用 try-with-resources 取代手動清理。

### 反模式 6：吞掉 `InterruptedException`

```java
// ❌ 這是實務上很嚴重、但很少人注意的問題
try {
    Thread.sleep(1000);
} catch (InterruptedException e) {
    // 什麼都沒做 → 中斷旗標被 catch 清掉了，
    //              上層的執行緒池不知道要停止 → 服務關不掉
}

// ✅ 方案 A：恢復中斷旗標
try {
    Thread.sleep(1000);
} catch (InterruptedException e) {
    Thread.currentThread().interrupt();       // 讓上層還能偵測到
    throw new RuntimeException("等待被中斷", e);
}

// ✅ 方案 B：直接往上拋
void doWork() throws InterruptedException {
    Thread.sleep(1000);
}
```

> 為什麼重要：`InterruptedException` 被丟出時，執行緒的中斷旗標**已經被清除**。
> 如果你不恢復它，上層（如 `ExecutorService.shutdownNow()`）就無法知道該停下來。
> 結果就是「服務關機時卡住」、「Kubernetes 只能 SIGKILL」。第 08 章會完整處理。

### 反模式 7：例外訊息沒有上下文

```java
// ❌ 上線後你只知道「有訂單失敗」，不知道是哪一筆
throw new IllegalStateException("狀態錯誤");

// ✅
throw new OrderStateException(
        "訂單 %s 狀態為 %s，不允許 %s".formatted(orderId, status, operation));
```

### 反模式 8：對外洩漏內部細節

```java
// ❌ 把堆疊、SQL、內部路徑回給前端 → 這是資安漏洞（資訊洩漏）
return ApiResponse.error(500, e.toString());
// {"error":"java.sql.SQLException: Table 'shop.orders_v2_backup' doesn't exist"}
// 攻擊者現在知道你的資料庫名、表名、技術棧

// ✅ 對外給固定文案 + traceId，細節只在 log
String traceId = MDC.get("traceId");
log.error("請求失敗，traceId={}", traceId, e);
return ApiResponse.error(500, "E9001", "系統內部錯誤", traceId);
```

---

## 4.13 例外 vs 回傳值 vs `Optional`

不是所有失敗都該用例外。

| 情況 | 用什麼 | 例子 |
|---|---|---|
| **可能沒有值**，且這很正常 | `Optional` | `findByEmail()` 找不到使用者 |
| **業務規則被違反**，呼叫方通常無法繼續 | 例外 | 庫存不足、餘額不足 |
| **參數不合法**（呼叫方的 bug） | 例外 | `quantity = -1` |
| 需要**回傳多種失敗原因**讓呼叫方分別處理 | `sealed` 結果型別 | 付款結果：成功 / 卡片被拒 / 額度不足 / 閘道逾時 |
| **驗證表單**，要一次回報所有錯誤 | 回傳錯誤清單 | 註冊表單五個欄位都有問題 |

```java
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public class ErrorStrategyComparison {

    // ① Optional：「可能沒有」是正常情況
    static Optional<String> findUserEmail(String userId) {
        Map<String, String> db = Map.of("u001", "a@example.com");
        return Optional.ofNullable(db.get(userId));
    }

    // ② 例外：業務規則違反
    static void withdraw(BigDecimal balance, BigDecimal amount) {
        if (amount.compareTo(balance) > 0) {
            throw new IllegalStateException(
                    "餘額不足：可用 %s，欲提領 %s".formatted(balance, amount));
        }
    }

    // ③ sealed 結果型別：多種失敗都需要呼叫方分別處理
    sealed interface PaymentResult permits Approved, Declined, GatewayTimeout { }
    record Approved(String transactionId) implements PaymentResult { }
    record Declined(String reason, boolean retryable) implements PaymentResult { }
    record GatewayTimeout(int retryAfterSeconds) implements PaymentResult { }

    static PaymentResult charge(String card, BigDecimal amount) {
        if (card.startsWith("4000")) return new Declined("卡片已過期", false);
        if (card.startsWith("4001")) return new Declined("額度不足", true);
        if (card.startsWith("4002")) return new GatewayTimeout(30);
        return new Approved("TX-" + System.nanoTime());
    }

    // ④ 錯誤清單：表單驗證要一次回報全部
    record ValidationError(String field, String message) { }

    static List<ValidationError> validateRegistration(String email, String password, int age) {
        List<ValidationError> errors = new ArrayList<>();
        if (email == null || !email.contains("@")) {
            errors.add(new ValidationError("email", "email 格式錯誤"));
        }
        if (password == null || password.length() < 8) {
            errors.add(new ValidationError("password", "密碼至少 8 字元"));
        }
        if (age < 18) {
            errors.add(new ValidationError("age", "須滿 18 歲"));
        }
        return errors;
    }

    public static void main(String[] args) {

        // ①
        System.out.println(findUserEmail("u001").orElse("(無)"));      // a@example.com
        System.out.println(findUserEmail("u999").orElse("(無)"));      // (無)

        // ②
        try {
            withdraw(new BigDecimal("100"), new BigDecimal("500"));
        } catch (IllegalStateException e) {
            System.out.println(e.getMessage());     // 餘額不足：可用 100，欲提領 500
        }

        // ③ 每種結果有不同的後續動作，用 switch 一次涵蓋（sealed 保證不漏）
        for (String card : List.of("4000111122223333", "4001111122223333",
                                   "4002111122223333", "5555444433332222")) {
            PaymentResult result = charge(card, new BigDecimal("1000"));
            String action = switch (result) {
                case Approved a -> "出貨，交易號 " + a.transactionId();
                case Declined d when d.retryable() -> "提示使用者換卡：" + d.reason();
                case Declined d -> "取消訂單：" + d.reason();
                case GatewayTimeout t -> "排入重試佇列，" + t.retryAfterSeconds() + " 秒後";
            };
            System.out.println(card.substring(0, 4) + "... → " + action);
        }

        // ④
        System.out.println(validateRegistration("bad-email", "123", 15));
        // [ValidationError[field=email, message=email 格式錯誤],
        //  ValidationError[field=password, message=密碼至少 8 字元],
        //  ValidationError[field=age, message=須滿 18 歲]]
    }
}
```

> `case Declined d when d.retryable() ->` 用到了 Java 21 的 **guarded pattern**（守衛條件）。
> 第 12 章會詳細講。

**判斷原則：**

> **例外是給「例外情況」用的。** 如果某個失敗每天發生上千次（如「查無此人」、「密碼錯誤」），
> 它就不是例外情況，用回傳值表達會更清楚也更快。

---

## 4.14 例外的效能

```java
public class ExceptionPerformance {

    static final int N = 1_000_000;

    public static void main(String[] args) {
        // 暖機（第 00 章 0.9 節：JIT 需要暖機才量得準）
        for (int i = 0; i < 3; i++) {
            withException();
            withReturnValue();
            preFilled();
        }

        System.out.println("丟例外（含堆疊）: " + withException() + " ms");
        System.out.println("回傳值:           " + withReturnValue() + " ms");
        System.out.println("重用例外（無堆疊）: " + preFilled() + " ms");
    }

    static long withException() {
        long start = System.currentTimeMillis();
        int count = 0;
        for (int i = 0; i < N; i++) {
            try {
                throw new RuntimeException("test");
            } catch (RuntimeException e) {
                count++;
            }
        }
        return System.currentTimeMillis() - start;
    }

    static long withReturnValue() {
        long start = System.currentTimeMillis();
        int count = 0;
        for (int i = 0; i < N; i++) {
            if (check()) count++;
        }
        return System.currentTimeMillis() - start;
    }

    static boolean check() { return true; }

    /** 關掉堆疊收集：super(msg, cause, suppression, writableStackTrace=false) */
    static class LightException extends RuntimeException {
        LightException(String message) { super(message, null, false, false); }
    }

    static long preFilled() {
        long start = System.currentTimeMillis();
        int count = 0;
        for (int i = 0; i < N; i++) {
            try {
                throw new LightException("test");
            } catch (LightException e) {
                count++;
            }
        }
        return System.currentTimeMillis() - start;
    }
}
```

典型結果（數量級供參考，會因機器而異）：

```
丟例外（含堆疊）: 700 ms      ← 每次約 0.7 微秒
回傳值:           2 ms
重用例外（無堆疊）: 15 ms
```

**成本主要來自 `fillInStackTrace()`**——建立例外時要走過整個呼叫堆疊。

**實務結論：**

- **正常的例外處理（一次請求一兩個例外）完全不需要擔心效能。** 100 萬次才 0.7 秒，
  一次請求的資料庫查詢就要好幾毫秒。
- **只有在「每秒數萬次」的熱路徑上才是問題**。這種場合本來就不該用例外（見反模式 3）。
- 極少數情況（如解析器的流程控制），可以用 `writableStackTrace=false` 建立輕量例外。
  但這樣就沒有堆疊可以除錯了，**通常不值得**。

---

## 4.15 練習專案：Todo CLI 的例外體系

延續第 03 章的專案，加上完整的例外處理。

```
demo/src/main/java/com/example/todo/
├── exception/
│   ├── ErrorCode.java
│   ├── TodoException.java
│   ├── TodoNotFoundException.java
│   ├── TodoAlreadyDoneException.java
│   └── InvalidTodoException.java
├── model/ ...        （第 02 章）
├── repository/ ...   （第 03 章）
├── service/TodoService.java   ← 改用新例外
└── cli/TodoCli.java  ← 新增：最外層處理器
```

### `ErrorCode.java`

```java
package com.example.todo.exception;

public enum ErrorCode {

    INVALID_INPUT("T1001", "輸入不合法"),
    TODO_NOT_FOUND("T2001", "待辦不存在"),
    TODO_ALREADY_DONE("T2002", "待辦已完成"),
    STORAGE_ERROR("T9001", "儲存失敗"),
    INTERNAL_ERROR("T9999", "系統內部錯誤");

    private final String code;
    private final String defaultMessage;

    ErrorCode(String code, String defaultMessage) {
        this.code = code;
        this.defaultMessage = defaultMessage;
    }

    public String code() { return code; }
    public String defaultMessage() { return defaultMessage; }
}
```

### `TodoException.java`

```java
package com.example.todo.exception;

import java.util.LinkedHashMap;
import java.util.Map;

/** 所有待辦相關例外的基底。unchecked，理由見第 04 章 4.5 節 */
public class TodoException extends RuntimeException {

    private final ErrorCode errorCode;
    private final Map<String, Object> context = new LinkedHashMap<>();

    public TodoException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public TodoException(ErrorCode errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }

    public TodoException with(String key, Object value) {
        context.put(key, value);
        return this;
    }

    public ErrorCode errorCode() { return errorCode; }

    public Map<String, Object> context() { return Map.copyOf(context); }

    /** 給使用者看的訊息：不含技術細節 */
    public String toUserMessage() {
        return "[%s] %s".formatted(errorCode.code(), getMessage());
    }

    /** 給 log 用的訊息：含完整上下文 */
    public String toLogMessage() {
        return "[%s] %s %s".formatted(errorCode.code(), getMessage(), context);
    }
}
```

### 具體例外

```java
package com.example.todo.exception;

public class TodoNotFoundException extends TodoException {
    public TodoNotFoundException(long id) {
        super(ErrorCode.TODO_NOT_FOUND, "找不到待辦事項");
        with("id", id);
    }
}
```

```java
package com.example.todo.exception;

public class TodoAlreadyDoneException extends TodoException {

    public TodoAlreadyDoneException(long id, String title) {
        super(ErrorCode.TODO_ALREADY_DONE, "此待辦已完成，無需重複標記");
        with("id", id).with("title", title);
    }

    /** 拿不到標題時用（例如在 Repository 層） */
    public TodoAlreadyDoneException(long id) {
        super(ErrorCode.TODO_ALREADY_DONE, "此待辦已完成，無需重複標記");
        with("id", id);
    }
}
```

```java
package com.example.todo.exception;

public class InvalidTodoException extends TodoException {

    public InvalidTodoException(String field, Object value, String reason) {
        super(ErrorCode.INVALID_INPUT, reason);
        with("field", field).with("value", value);
    }

    /** 說不出是哪個欄位時用 */
    public InvalidTodoException(String reason) {
        super(ErrorCode.INVALID_INPUT, reason);
    }
}
```

### 改寫 `Todo` 的驗證（用新例外）

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;
import com.example.todo.exception.TodoAlreadyDoneException;

import java.time.LocalDateTime;
import java.util.Objects;

public class Todo {

    private static final int MAX_TITLE_LENGTH = 100;

    private final long id;
    private String title;
    private Priority priority;
    private boolean done;
    private final LocalDateTime createdAt;
    private LocalDateTime completedAt;

    public Todo(long id, String title, Priority priority, LocalDateTime createdAt) {
        if (id <= 0) {
            throw new InvalidTodoException("id", id, "id 必須大於 0");
        }
        this.id = id;
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt 不可為 null");
        this.done = false;
        setTitle(title);
    }

    public void markDone(LocalDateTime when) {
        if (done) {
            throw new TodoAlreadyDoneException(id, title);      // ← 帶上 id 與 title
        }
        Objects.requireNonNull(when, "完成時間不可為 null");
        if (when.isBefore(createdAt)) {
            throw new InvalidTodoException("completedAt", when, "完成時間不可早於建立時間");
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
            throw new InvalidTodoException("title", title, "標題不可為空");
        }
        String stripped = title.strip();
        if (stripped.length() > MAX_TITLE_LENGTH) {
            throw new InvalidTodoException("title", stripped.length(),
                    "標題長度不可超過 " + MAX_TITLE_LENGTH + " 字");
        }
        this.title = stripped;
    }

    public void changePriority(Priority priority) {
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
    }

    public long id() { return id; }
    public String title() { return title; }
    public Priority priority() { return priority; }
    public boolean isDone() { return done; }
    public LocalDateTime createdAt() { return createdAt; }
    public LocalDateTime completedAt() { return completedAt; }

    public String toDisplayLine() {
        return "%s #%-3d [%s] %s".formatted(done ? "[x]" : "[ ]", id,
                                            priority.label(), title);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Todo other)) return false;
        return id == other.id;
    }

    @Override
    public int hashCode() { return Long.hashCode(id); }

    @Override
    public String toString() {
        return "Todo{id=%d, title='%s', priority=%s, done=%s}"
                .formatted(id, title, priority, done);
    }
}
```

### `Priority.java`（第 02 章原樣搬來，加上安全的字串解析）

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;

import java.util.Arrays;
import java.util.stream.Collectors;

public enum Priority {

    HIGH("高", 3),
    MEDIUM("中", 2),
    LOW("低", 1);

    private final String label;
    private final int weight;

    Priority(String label, int weight) {
        this.label = label;
        this.weight = weight;
    }

    public String label() { return label; }

    public int weight() { return weight; }

    /** 從使用者輸入解析，失敗時給出「合法值有哪些」——好的錯誤訊息（4.7 節） */
    public static Priority parse(String input) {
        if (input == null || input.isBlank()) {
            return MEDIUM;
        }
        String normalized = input.strip().toUpperCase();
        for (Priority p : values()) {
            if (p.name().equals(normalized)) return p;
        }
        String allowed = Arrays.stream(values()).map(Enum::name).collect(Collectors.joining(", "));
        throw new InvalidTodoException("priority", input,
                "無效的優先度，可用值: " + allowed);
    }
}
```

### `TodoRepository` 與實作（第 03 章原樣搬來，改用新例外）

```java
package com.example.todo.repository;

import com.example.todo.exception.TodoNotFoundException;
import com.example.todo.model.Todo;

import java.util.List;
import java.util.Optional;

public interface TodoRepository {

    Todo save(Todo todo);

    /** 「可能沒有」用 Optional 表達，不用例外（4.13 節） */
    Optional<Todo> findById(long id);

    List<Todo> findAll();

    boolean deleteById(long id);

    long nextId();

    /** 「一定要有」的情境才丟例外 */
    default Todo getById(long id) {
        return findById(id).orElseThrow(() -> new TodoNotFoundException(id));
    }

    default long count() { return findAll().size(); }
}
```

```java
package com.example.todo.repository;

import com.example.todo.exception.ErrorCode;
import com.example.todo.exception.TodoException;
import com.example.todo.model.Todo;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

public class InMemoryTodoRepository implements TodoRepository {

    private final Map<Long, Todo> storage = new LinkedHashMap<>();
    private long sequence = 0;

    /** 為了示範例外包裝：讓 id 為 666 時模擬底層失敗 */
    private final boolean simulateFailure;

    public InMemoryTodoRepository() { this(false); }

    public InMemoryTodoRepository(boolean simulateFailure) {
        this.simulateFailure = simulateFailure;
    }

    @Override
    public Todo save(Todo todo) {
        Objects.requireNonNull(todo, "todo 不可為 null");
        try {
            if (simulateFailure) {
                // 模擬底層技術例外（實務上是 SQLException / IOException）
                throw new java.io.IOException("Disk quota exceeded");
            }
            storage.put(todo.id(), todo);
            return todo;
        } catch (java.io.IOException e) {
            // ✅ Repository 的職責：包成統一例外，保留 cause 與上下文
            throw new TodoException(ErrorCode.STORAGE_ERROR, "寫入待辦失敗", e)
                    .with("id", todo.id())
                    .with("title", todo.title());
        }
    }

    @Override
    public Optional<Todo> findById(long id) {
        return Optional.ofNullable(storage.get(id));
    }

    @Override
    public List<Todo> findAll() { return List.copyOf(storage.values()); }

    @Override
    public boolean deleteById(long id) { return storage.remove(id) != null; }

    @Override
    public long nextId() { return ++sequence; }
}
```

### `Notifier`（第 03 章原樣搬來）

```java
package com.example.todo.service;

import com.example.todo.model.Todo;

public interface Notifier {

    void notifyCreated(Todo todo);

    void notifyDone(Todo todo);

    static Notifier noop() {
        return new Notifier() {
            @Override public void notifyCreated(Todo todo) { }
            @Override public void notifyDone(Todo todo) { }
        };
    }
}
```

```java
package com.example.todo.service;

import com.example.todo.model.Todo;

public class ConsoleNotifier implements Notifier {

    @Override
    public void notifyCreated(Todo todo) {
        System.out.println("🔔 新增待辦 #" + todo.id() + "：" + todo.title());
    }

    @Override
    public void notifyDone(Todo todo) {
        System.out.println("🔔 完成待辦 #" + todo.id() + "：" + todo.title());
    }
}
```

### `TodoService.java`

```java
package com.example.todo.service;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;

public class TodoService {

    private final TodoRepository repository;
    private final Notifier notifier;

    public TodoService(TodoRepository repository, Notifier notifier) {
        this.repository = Objects.requireNonNull(repository, "repository 不可為 null");
        this.notifier = Objects.requireNonNull(notifier, "notifier 不可為 null");
    }

    public Todo add(String title, Priority priority) {
        // 驗證在 Todo 建構子裡（規則跟資料放在一起，第 02 章 2.5 節）
        Todo todo = new Todo(repository.nextId(), title, priority, LocalDateTime.now());
        repository.save(todo);
        safeNotify(n -> n.notifyCreated(todo));
        return todo;
    }

    public Todo markDone(long id) {
        Todo todo = repository.getById(id);        // 找不到 → TodoNotFoundException
        todo.markDone(LocalDateTime.now());        // 已完成 → TodoAlreadyDoneException
        repository.save(todo);
        safeNotify(n -> n.notifyDone(todo));
        return todo;
    }

    public boolean remove(long id) {
        repository.getById(id);                    // 找不到 → TodoNotFoundException
        return repository.deleteById(id);
    }

    public List<Todo> findPending() {
        List<Todo> result = new ArrayList<>();
        for (Todo todo : repository.findAll()) {
            if (!todo.isDone()) result.add(todo);
        }
        return result;
    }

    public List<Todo> findAll() { return repository.findAll(); }

    /**
     * ✅ 這是「合理的 catch」：通知失敗不該讓新增待辦失敗。
     * 注意有記 log、有寫註解說明為什麼可以吞——不是無聲吞掉（4.12 反模式 1）。
     */
    private void safeNotify(Consumer<Notifier> action) {
        try {
            action.accept(notifier);
        } catch (RuntimeException e) {
            System.err.println("[WARN] 通知發送失敗（不影響主流程）: " + e.getMessage());
        }
    }
}
```

### `TodoCli.java`：最外層處理器

```java
package com.example.todo.cli;

import com.example.todo.exception.ErrorCode;
import com.example.todo.exception.TodoException;
import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.service.TodoService;

import java.util.Objects;

/**
 * 最外層：唯一 catch 例外並轉成使用者訊息的地方。
 * 相當於 Spring 的 @RestControllerAdvice。
 */
public class TodoCli {

    private final TodoService service;

    public TodoCli(TodoService service) {
        this.service = Objects.requireNonNull(service);
    }

    /** 執行一個指令，回傳給使用者看的輸出。永遠不會拋例外出去。 */
    public String execute(String command) {
        try {
            return dispatch(command);

        } catch (TodoException e) {
            // 已知的業務例外：記 log（含上下文）+ 給使用者友善訊息
            logWarn(e.toLogMessage());
            return "❌ " + e.toUserMessage();

        } catch (IllegalArgumentException | NullPointerException e) {
            // 參數問題
            logWarn("參數錯誤: " + e.getMessage());
            return "❌ [%s] %s".formatted(
                    ErrorCode.INVALID_INPUT.code(), e.getMessage());

        } catch (RuntimeException e) {
            // 最後防線：未預期的例外，記完整堆疊，對外只給固定文案
            String traceId = Long.toHexString(System.nanoTime());
            logError("未預期的例外，traceId=" + traceId, e);
            return "❌ [%s] %s（追蹤碼 %s，請提供給客服）".formatted(
                    ErrorCode.INTERNAL_ERROR.code(),
                    ErrorCode.INTERNAL_ERROR.defaultMessage(), traceId);
        }
    }

    private String dispatch(String command) {
        String[] parts = command.strip().split("\\s+", 3);
        String verb = parts[0].toLowerCase();

        return switch (verb) {
            case "add" -> {
                if (parts.length < 2) {
                    throw new IllegalArgumentException("用法: add <標題> [優先度]");
                }
                Priority p = parts.length >= 3 ? Priority.parse(parts[2]) : Priority.MEDIUM;
                Todo todo = service.add(parts[1], p);
                yield "✅ 已新增 " + todo.toDisplayLine();
            }
            case "done" -> {
                long id = parseId(parts);
                Todo todo = service.markDone(id);
                yield "✅ 已完成 " + todo.toDisplayLine();
            }
            case "delete" -> {
                long id = parseId(parts);
                service.remove(id);
                yield "✅ 已刪除 #" + id;
            }
            case "list" -> {
                StringBuilder sb = new StringBuilder();
                for (Todo todo : service.findAll()) {
                    sb.append(todo.toDisplayLine()).append('\n');
                }
                yield sb.isEmpty() ? "（沒有待辦）" : sb.toString().stripTrailing();
            }
            default -> throw new IllegalArgumentException(
                    "未知指令: " + verb + "（可用: add / done / delete / list）");
        };
    }

    private long parseId(String[] parts) {
        if (parts.length < 2) {
            throw new IllegalArgumentException("請提供待辦編號");
        }
        try {
            return Long.parseLong(parts[1]);
        } catch (NumberFormatException e) {
            // ✅ 包裝時保留 cause，並補上使用者實際輸入的值
            throw new IllegalArgumentException("編號必須是數字，收到: " + parts[1], e);
        }
    }

    private void logWarn(String message) {
        System.err.println("[WARN] " + message);
    }

    private void logError(String message, Throwable e) {
        System.err.println("[ERROR] " + message);
        e.printStackTrace();      // 實務上是 log.error(message, e)
    }
}
```

### 執行

```java
package com.example.todo;

import com.example.todo.cli.TodoCli;
import com.example.todo.repository.InMemoryTodoRepository;
import com.example.todo.service.ConsoleNotifier;
import com.example.todo.service.TodoService;

import java.util.List;

public class App {
    public static void main(String[] args) {

        TodoCli cli = new TodoCli(new TodoService(
                new InMemoryTodoRepository(), new ConsoleNotifier()));

        List<String> commands = List.of(
                "add 寫第04章 HIGH",
                "add 買咖啡",
                "list",
                "done 1",
                "done 1",              // 重複完成
                "done 99",             // 不存在
                "done abc",            // 編號不是數字
                "add",                 // 缺參數
                "add x SUPER_URGENT",  // 無效優先度
                "fly"                  // 未知指令
        );

        for (String cmd : commands) {
            System.out.println("\n$ " + cmd);
            System.out.println(cli.execute(cmd));
        }
    }
}
```

輸出（`[WARN]` / `[ERROR]` 走 stderr，實際終端機會交錯）：

```
$ add 寫第04章 HIGH
🔔 新增待辦 #1：寫第04章
✅ 已新增 [ ] #1   [高] 寫第04章

$ add 買咖啡
🔔 新增待辦 #2：買咖啡
✅ 已新增 [ ] #2   [中] 買咖啡

$ list
[ ] #1   [高] 寫第04章
[ ] #2   [中] 買咖啡

$ done 1
🔔 完成待辦 #1：寫第04章
✅ 已完成 [x] #1   [高] 寫第04章

$ done 1
[WARN] [T2002] 此待辦已完成，無需重複標記 {id=1, title=寫第04章}
❌ [T2002] 此待辦已完成，無需重複標記

$ done 99
[WARN] [T2001] 找不到待辦事項 {id=99}
❌ [T2001] 找不到待辦事項

$ done abc
[WARN] 參數錯誤: 編號必須是數字，收到: abc
❌ [T1001] 編號必須是數字，收到: abc

$ add
[WARN] 參數錯誤: 用法: add <標題> [優先度]
❌ [T1001] 用法: add <標題> [優先度]

$ add x SUPER_URGENT
[WARN] [T1001] 無效的優先度，可用值: HIGH, MEDIUM, LOW {field=priority, value=SUPER_URGENT}
❌ [T1001] 無效的優先度，可用值: HIGH, MEDIUM, LOW

$ fly
[WARN] 參數錯誤: 未知指令: fly（可用: add / done / delete / list）
❌ [T1001] 未知指令: fly（可用: add / done / delete / list）
```

**檢查看看這一版符合了本章的哪些原則：**

- ✅ 例外只在最外層 catch 一次（4.11 節）
- ✅ 每個例外都帶著結構化上下文（4.7 節）
- ✅ 錯誤碼集中管理，使用者訊息與 log 訊息分開（4.9 節）
- ✅ 業務例外記 `WARN`、未預期例外記 `ERROR` 加堆疊（4.11 節）
- ✅ 未預期例外對外只給固定文案 + traceId（4.12 反模式 8）
- ✅ 通知失敗被吞掉，但有記 log 且有註解說明理由（4.12 反模式 1）
- ✅ 「找不到」在 Repository 用 `Optional`，只在 `getById` 才轉例外（4.13 節）

> 試著把 `new InMemoryTodoRepository()` 改成 `new InMemoryTodoRepository(true)`（模擬儲存失敗），
> 觀察 `T9001` 例外如何從 Repository 一路帶著 `IOException` 的 cause 傳到最外層。

---

## 4.16 常見錯誤

| # | 錯誤 | 修法 |
|---|---|---|
| 1 | `catch (Exception e) { }` 空的 catch | 往上拋、處理它、或記 DEBUG 加註解 |
| 2 | `e.printStackTrace()` | 用 logger，例外放最後一個參數 |
| 3 | `throw new RuntimeException("失敗")` 丟掉 cause | `throw new XException("失敗，id=" + id, e)` |
| 4 | `finally` 裡 `return` | 移除；用 try-with-resources |
| 5 | 吞掉 `InterruptedException` | `Thread.currentThread().interrupt()` |
| 6 | 同一個例外記 log 三次 | 只在最終處理處記一次 |
| 7 | 例外訊息沒有識別資訊 | 加上 id、實際值、期望值 |
| 8 | 把堆疊回給前端 | 對外固定文案 + traceId |
| 9 | 用例外表示「找不到」 | 用 `Optional` |
| 10 | catch `Error` / `Throwable` 想繼續跑 | 讓它掛掉；只在頂層記 log |

---

## 4.17 本章練習

### 練習 1：找出並修正所有問題

```java
public class Buggy {

    public String readConfig(String path) {
        BufferedReader reader = null;
        try {
            reader = new BufferedReader(new FileReader(path));
            return reader.readLine();
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        } finally {
            try {
                reader.close();
            } catch (Exception e) {
            }
            return "";
        }
    }

    public void processOrder(String orderId) {
        try {
            Order order = repository.findById(orderId);
            order.pay();
        } catch (Exception e) {
            throw new RuntimeException("處理失敗");
        }
    }

    public void waitAndRetry() {
        try {
            Thread.sleep(1000);
        } catch (InterruptedException e) {
        }
    }
}
```

<details>
<summary>參考解答</summary>

**問題清單：**

`readConfig`：

1. 手動 `finally` 關閉，應該用 try-with-resources。
2. `catch (Exception e)` 太寬，把 NPE 之類的 bug 也一起吞了。
3. `printStackTrace()` 不進 log。
4. 回傳 `null` 表示失敗，呼叫方會 NPE。
5. `reader.close()` 沒有 null 檢查——如果 `new FileReader` 就失敗，`reader` 是 null，
   `finally` 裡直接 NPE，**蓋掉真正的 FileNotFoundException**。
6. `finally` 裡的 `return ""` **吃掉所有例外和回傳值**——這個方法永遠回傳 `""`。

`processOrder`：

7. `catch (Exception e)` 把「訂單不存在」、「狀態不允許」、「NPE」全混在一起。
8. `new RuntimeException("處理失敗")` 丟掉 cause 和 orderId。

`waitAndRetry`：

9. 吞掉 `InterruptedException`，沒有恢復中斷旗標。

**修正版：**

```java
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Fixed {

    private static final Logger log = LoggerFactory.getLogger(Fixed.class);

    private final OrderRepository repository;

    public Fixed(OrderRepository repository) {
        this.repository = repository;
    }

    /**
     * ✅ try-with-resources、只 catch 具體型別、
     *    「找不到檔案」用 Optional 表達（正常情況）、其他 IO 失敗才丟例外
     */
    public Optional<String> readConfig(String path) {
        try (var reader = Files.newBufferedReader(Path.of(path))) {
            return Optional.ofNullable(reader.readLine());

        } catch (NoSuchFileException e) {
            // 設定檔不存在是可預期的正常情況 → 用 Optional.empty() 表達，記 DEBUG
            log.debug("設定檔不存在，將使用預設值: {}", path);
            return Optional.empty();

        } catch (IOException e) {
            // 其他 IO 失敗（權限、磁碟、編碼）是真的問題 → 包裝後往上拋，保留 cause
            throw new UncheckedIOException("讀取設定檔失敗: " + path, e);
        }
    }

    /**
     * ✅ 不 catch 自己能力範圍外的東西。
     *    Repository 的 Optional 轉成明確的業務例外；
     *    order.pay() 的 IllegalStateException 直接往上拋，由全域處理器轉 409。
     */
    public void processOrder(String orderId) {
        Order order = repository.findById(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));
        order.pay();
    }

    /** ✅ 恢復中斷旗標，並讓呼叫方知道發生了什麼 */
    public void waitAndRetry() {
        try {
            Thread.sleep(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();       // 關鍵：恢復旗標
            throw new IllegalStateException("重試等待被中斷", e);
        }
    }

    // 為了讓範例完整
    interface OrderRepository {
        Optional<Order> findById(String id);
    }

    interface Order {
        void pay();
    }

    static class OrderNotFoundException extends RuntimeException {
        OrderNotFoundException(String orderId) {
            super("找不到訂單: " + orderId);
        }
    }
}
```

**注意 `readConfig` 的設計決定**：「檔案不存在」和「讀取失敗」是兩件不同的事。
前者常常是正常的（第一次啟動沒有設定檔），後者是真的錯誤。
用 `Optional.empty()` 和例外分別表達，呼叫方就不需要靠 `null` 猜。

</details>

### 練習 2：設計電商的例外體系

為一個電商系統設計例外類別與錯誤碼，需涵蓋：

- 商品不存在、商品已下架
- 庫存不足
- 優惠券無效、已使用、已過期
- 訂單狀態不允許操作
- 付款被拒、付款閘道逾時
- 使用者未登入、無權限

<details>
<summary>參考解答</summary>

```java
import java.util.LinkedHashMap;
import java.util.Map;

/** 錯誤碼：前四碼分類，方便對照文件與監控分群 */
enum ShopErrorCode {

    // 1xxx 認證授權
    UNAUTHORIZED("S1001", 401, "請先登入"),
    FORBIDDEN("S1002", 403, "您沒有權限執行此操作"),

    // 2xxx 商品
    PRODUCT_NOT_FOUND("S2001", 404, "商品不存在"),
    PRODUCT_UNAVAILABLE("S2002", 409, "商品已下架"),

    // 3xxx 庫存
    INSUFFICIENT_STOCK("S3001", 409, "庫存不足"),

    // 4xxx 優惠券
    COUPON_NOT_FOUND("S4001", 404, "優惠券不存在"),
    COUPON_EXPIRED("S4002", 409, "優惠券已過期"),
    COUPON_ALREADY_USED("S4003", 409, "優惠券已使用"),
    COUPON_NOT_APPLICABLE("S4004", 409, "此優惠券不適用於本次訂單"),

    // 5xxx 訂單
    ORDER_NOT_FOUND("S5001", 404, "訂單不存在"),
    ORDER_STATE_INVALID("S5002", 409, "訂單狀態不允許此操作"),

    // 6xxx 付款
    PAYMENT_DECLINED("S6001", 402, "付款被拒絕"),
    PAYMENT_GATEWAY_TIMEOUT("S6002", 504, "付款閘道無回應"),
    PAYMENT_GATEWAY_ERROR("S6003", 502, "付款閘道異常"),

    // 9xxx 系統
    DATA_ACCESS_ERROR("S9001", 500, "資料存取失敗"),
    EXTERNAL_SERVICE_ERROR("S9002", 502, "外部服務異常"),
    INTERNAL_ERROR("S9999", 500, "系統內部錯誤");

    private final String code;
    private final int httpStatus;
    private final String userMessage;      // 對外文案，可以直接給前端顯示

    ShopErrorCode(String code, int httpStatus, String userMessage) {
        this.code = code;
        this.httpStatus = httpStatus;
        this.userMessage = userMessage;
    }

    public String getCode() { return code; }
    public int getHttpStatus() { return httpStatus; }
    public String getUserMessage() { return userMessage; }

    /** 5xx 是我們的問題，需要告警；4xx 是使用者的問題 */
    public boolean isOurFault() { return httpStatus >= 500; }
}

/** 基底例外 */
class ShopException extends RuntimeException {

    private final ShopErrorCode errorCode;
    private final Map<String, Object> context = new LinkedHashMap<>();

    ShopException(ShopErrorCode errorCode) {
        super(errorCode.getUserMessage());
        this.errorCode = errorCode;
    }

    ShopException(ShopErrorCode errorCode, String detail) {
        super(detail);
        this.errorCode = errorCode;
    }

    ShopException(ShopErrorCode errorCode, String detail, Throwable cause) {
        super(detail, cause);
        this.errorCode = errorCode;
    }

    ShopException with(String key, Object value) {
        context.put(key, value);
        return this;
    }

    ShopErrorCode getErrorCode() { return errorCode; }
    Map<String, Object> getContext() { return Map.copyOf(context); }

    /** 對外：不含內部細節 */
    String toUserMessage() { return errorCode.getUserMessage(); }

    /** 對內：完整資訊 */
    String toLogMessage() {
        return "[%s] %s %s".formatted(errorCode.getCode(), getMessage(), context);
    }
}

// ===== 具體例外：只開「呼叫端需要分別處理」的類別 =====

class ProductNotFoundException extends ShopException {
    ProductNotFoundException(String sku) {
        super(ShopErrorCode.PRODUCT_NOT_FOUND, "商品不存在: " + sku);
        with("sku", sku);
    }
}

class ProductUnavailableException extends ShopException {
    ProductUnavailableException(String sku, String reason) {
        super(ShopErrorCode.PRODUCT_UNAVAILABLE, "商品已下架: " + sku);
        with("sku", sku).with("reason", reason);
    }
}

class InsufficientStockException extends ShopException {
    private final int available;

    InsufficientStockException(String sku, int required, int available) {
        super(ShopErrorCode.INSUFFICIENT_STOCK,
              "庫存不足: sku=%s 需要 %d 剩餘 %d".formatted(sku, required, available));
        this.available = available;
        with("sku", sku).with("required", required).with("available", available);
    }

    /** 前端可以用這個顯示「僅剩 N 件」 */
    int getAvailable() { return available; }
}

/** 優惠券的多種失敗共用一個類別，用錯誤碼區分 —— 避免類別爆炸（4.9 節） */
class CouponException extends ShopException {
    CouponException(ShopErrorCode errorCode, String couponCode, String detail) {
        super(errorCode, detail);
        with("couponCode", couponCode);
    }

    static CouponException notFound(String code) {
        return new CouponException(ShopErrorCode.COUPON_NOT_FOUND, code, "優惠券不存在: " + code);
    }

    static CouponException expired(String code, java.time.LocalDate expiredAt) {
        CouponException e = new CouponException(ShopErrorCode.COUPON_EXPIRED, code,
                "優惠券已於 %s 過期".formatted(expiredAt));
        e.with("expiredAt", expiredAt);
        return e;
    }

    static CouponException alreadyUsed(String code, String usedByOrderId) {
        CouponException e = new CouponException(ShopErrorCode.COUPON_ALREADY_USED, code,
                "優惠券已於訂單 %s 使用".formatted(usedByOrderId));
        e.with("usedByOrderId", usedByOrderId);
        return e;
    }

    static CouponException notApplicable(String code, String reason) {
        return new CouponException(ShopErrorCode.COUPON_NOT_APPLICABLE, code,
                "優惠券不適用: " + reason);
    }
}

class OrderStateException extends ShopException {
    OrderStateException(String orderId, String currentState, String operation) {
        super(ShopErrorCode.ORDER_STATE_INVALID,
              "訂單 %s 狀態為 %s，不允許 %s".formatted(orderId, currentState, operation));
        with("orderId", orderId).with("currentState", currentState).with("operation", operation);
    }
}

/** 付款例外：帶 retryable 讓呼叫端決定要不要重試 */
class PaymentException extends ShopException {
    private final boolean retryable;

    private PaymentException(ShopErrorCode code, String detail, boolean retryable, Throwable cause) {
        super(code, detail, cause);
        this.retryable = retryable;
    }

    static PaymentException declined(String orderId, String gatewayReason) {
        PaymentException e = new PaymentException(ShopErrorCode.PAYMENT_DECLINED,
                "付款被拒: " + gatewayReason, false, null);
        e.with("orderId", orderId).with("gatewayReason", gatewayReason);
        return e;
    }

    static PaymentException timeout(String orderId, int timeoutMillis, Throwable cause) {
        PaymentException e = new PaymentException(ShopErrorCode.PAYMENT_GATEWAY_TIMEOUT,
                "付款閘道逾時 (%d ms)".formatted(timeoutMillis), true, cause);
        e.with("orderId", orderId).with("timeoutMillis", timeoutMillis);
        return e;
    }

    boolean isRetryable() { return retryable; }
}

class AuthException extends ShopException {
    AuthException(ShopErrorCode code, String detail) {
        super(code, detail);
    }
}

// ===== 使用示範 =====

public class ShopExceptionDemo {

    record ApiError(int status, String code, String message, Map<String, Object> details) { }

    /** 模擬全域例外處理器 */
    static ApiError handle(RuntimeException e) {
        if (e instanceof ShopException se) {
            // 依錯誤碼決定 log 等級
            if (se.getErrorCode().isOurFault()) {
                System.err.println("[ERROR] " + se.toLogMessage());
                if (se.getCause() != null) {
                    System.err.println("        cause: " + se.getCause());
                }
                // 5xx 不把細節給前端
                return new ApiError(se.getErrorCode().getHttpStatus(),
                        se.getErrorCode().getCode(), se.toUserMessage(), Map.of());
            }
            System.out.println("[WARN]  " + se.toLogMessage());
            // 4xx 可以把有用的上下文給前端（例如「僅剩 2 件」）
            return new ApiError(se.getErrorCode().getHttpStatus(),
                    se.getErrorCode().getCode(), se.toUserMessage(), se.getContext());
        }
        System.err.println("[ERROR] 未預期的例外");
        e.printStackTrace();
        return new ApiError(500, ShopErrorCode.INTERNAL_ERROR.getCode(),
                ShopErrorCode.INTERNAL_ERROR.getUserMessage(), Map.of());
    }

    public static void main(String[] args) {
        java.util.List<RuntimeException> samples = java.util.List.of(
                new ProductNotFoundException("SKU-9999"),
                new InsufficientStockException("SKU-1001", 5, 2),
                CouponException.expired("SUMMER2025", java.time.LocalDate.of(2025, 8, 31)),
                CouponException.alreadyUsed("WELCOME50", "ORD-777"),
                new OrderStateException("ORD-001", "DELIVERED", "cancel"),
                PaymentException.declined("ORD-002", "insufficient_funds"),
                PaymentException.timeout("ORD-003", 30_000,
                        new java.net.SocketTimeoutException("Read timed out")),
                new AuthException(ShopErrorCode.FORBIDDEN, "user u001 缺少 ORDER_CANCEL 權限"),
                new NullPointerException("cart is null")
        );

        for (RuntimeException e : samples) {
            System.out.println("→ " + handle(e));
            System.out.println();
        }

        // 呼叫端可以據此決定重試
        try {
            throw PaymentException.timeout("ORD-004", 30_000, null);
        } catch (PaymentException e) {
            System.out.println(e.isRetryable() ? "排入重試佇列" : "直接失敗");
        }
    }
}
```

**設計決策說明：**

| 決策 | 理由 |
|---|---|
| 優惠券的四種失敗**共用 `CouponException`**，用靜態工廠方法 + 錯誤碼區分 | 呼叫端很少需要分別 catch「過期」和「已使用」，都是提示使用者換一張。避免類別爆炸 |
| 庫存不足**單獨一個類別**，且暴露 `getAvailable()` | 前端要顯示「僅剩 2 件」，呼叫端需要這個值 |
| 付款例外帶 `retryable` 旗標 | 逾時可以重試、被拒不能重試，呼叫端的行為完全不同 |
| 錯誤碼帶 `httpStatus` 與 `userMessage` | Controller 層不需要寫 `if-else` 對照，全域處理器一行搞定 |
| `isOurFault()` 決定 log 等級 | 4xx 洗版 ERROR 會讓真正的問題被埋掉；監控只該對 5xx 告警 |
| 4xx 回傳 `context`，5xx 不回傳 | 4xx 的上下文對使用者有用；5xx 的上下文可能洩漏內部結構（反模式 8） |

**類別數量控制**：這裡只有 7 個例外類別，涵蓋了 17 個錯誤碼。這是 4.9 節說的平衡點。

</details>

### 練習 3：實作帶重試的外部 API 呼叫

實作一個方法，呼叫外部付款 API，要求：

1. 逾時或 5xx 錯誤時重試最多 3 次，指數退避（1s、2s、4s）
2. 4xx 錯誤不重試（是我們的請求有問題）
3. 全部失敗後丟出帶完整資訊的例外
4. 每次重試都記 log

<details>
<summary>參考解答</summary>

```java
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 模擬外部 API 的回應 */
class HttpResponse {
    private final int status;
    private final String body;

    HttpResponse(int status, String body) {
        this.status = status;
        this.body = body;
    }

    int getStatus() { return status; }
    String getBody() { return body; }

    boolean isSuccess() { return status >= 200 && status < 300; }
    boolean isClientError() { return status >= 400 && status < 500; }
    boolean isServerError() { return status >= 500; }
}

/** 模擬外部 API 客戶端 */
interface PaymentGatewayClient {
    HttpResponse charge(String orderId, long amountCents) throws java.io.IOException;
}

/** 例外定義 */
class PaymentGatewayException extends RuntimeException {
    private final Map<String, Object> context = new LinkedHashMap<>();
    private final boolean retryable;

    PaymentGatewayException(String message, boolean retryable, Throwable cause) {
        super(message, cause);
        this.retryable = retryable;
    }

    PaymentGatewayException with(String key, Object value) {
        context.put(key, value);
        return this;
    }

    boolean isRetryable() { return retryable; }

    @Override
    public String getMessage() {
        return super.getMessage() + " " + context;
    }
}

/** 帶重試的付款服務 */
class ResilientPaymentService {

    private final PaymentGatewayClient client;
    private final int maxAttempts;
    private final long baseBackoffMillis;

    ResilientPaymentService(PaymentGatewayClient client, int maxAttempts, long baseBackoffMillis) {
        if (maxAttempts < 1) {
            throw new IllegalArgumentException("maxAttempts 必須 >= 1，收到: " + maxAttempts);
        }
        this.client = client;
        this.maxAttempts = maxAttempts;
        this.baseBackoffMillis = baseBackoffMillis;
    }

    String charge(String orderId, long amountCents) {
        // 記錄每次嘗試的失敗原因，最後一起放進例外
        List<String> attemptLog = new ArrayList<>();
        Throwable lastCause = null;

        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                HttpResponse response = client.charge(orderId, amountCents);

                if (response.isSuccess()) {
                    if (attempt > 1) {
                        logWarn("付款成功（第 %d 次嘗試），orderId=%s".formatted(attempt, orderId));
                    }
                    return response.getBody();
                }

                if (response.isClientError()) {
                    // ✅ 4xx 不重試：重試一百次結果都一樣，只是浪費時間並可能重複扣款
                    throw new PaymentGatewayException(
                            "付款請求被拒絕，不重試", false, null)
                            .with("orderId", orderId)
                            .with("status", response.getStatus())
                            .with("body", response.getBody())
                            .with("attempt", attempt);
                }

                // 5xx → 可重試
                attemptLog.add("第 %d 次: HTTP %d %s"
                        .formatted(attempt, response.getStatus(), response.getBody()));

            } catch (java.io.IOException e) {
                // 網路層失敗（逾時、連線被拒）→ 可重試
                attemptLog.add("第 %d 次: %s: %s"
                        .formatted(attempt, e.getClass().getSimpleName(), e.getMessage()));
                lastCause = e;

            } catch (PaymentGatewayException e) {
                // 4xx 的情況直接往上拋，不進重試迴圈
                logWarn(e.getMessage());
                throw e;
            }

            // 還有下一次的話，退避等待
            if (attempt < maxAttempts) {
                long backoff = baseBackoffMillis * (1L << (attempt - 1));   // 1x, 2x, 4x
                logWarn("付款失敗，%d ms 後重試（%d/%d），orderId=%s，原因=%s"
                        .formatted(backoff, attempt, maxAttempts, orderId,
                                   attemptLog.get(attemptLog.size() - 1)));
                sleep(backoff);
            }
        }

        // 全部失敗：訊息裡帶上「每一次」的失敗原因，這是查問題時最需要的資訊
        throw new PaymentGatewayException(
                "付款失敗，已重試 %d 次".formatted(maxAttempts), true, lastCause)
                .with("orderId", orderId)
                .with("amountCents", amountCents)
                .with("attempts", attemptLog);
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();       // 反模式 6：一定要恢復旗標
            throw new PaymentGatewayException("重試等待被中斷", false, e);
        }
    }

    private void logWarn(String message) {
        System.out.println("[WARN] " + message);
    }
}

// ===== 測試 =====

public class RetryDemo {

    /** 前 N 次回 503，之後成功 */
    static PaymentGatewayClient failingTimes(int failures) {
        return new PaymentGatewayClient() {
            private int count = 0;

            @Override
            public HttpResponse charge(String orderId, long amountCents) {
                if (++count <= failures) {
                    return new HttpResponse(503, "Service Unavailable");
                }
                return new HttpResponse(200, "{\"txId\":\"TX-" + orderId + "\"}");
            }
        };
    }

    public static void main(String[] args) {

        System.out.println("=== 情境 1：第 2 次成功 ===");
        var s1 = new ResilientPaymentService(failingTimes(1), 3, 100);
        System.out.println("結果: " + s1.charge("ORD-001", 29900));

        System.out.println("\n=== 情境 2：一直失敗，重試耗盡 ===");
        var s2 = new ResilientPaymentService(failingTimes(99), 3, 100);
        try {
            s2.charge("ORD-002", 29900);
        } catch (PaymentGatewayException e) {
            System.out.println("最終失敗: " + e.getMessage());
            System.out.println("可重試: " + e.isRetryable());
        }

        System.out.println("\n=== 情境 3：4xx 不重試 ===");
        var s3 = new ResilientPaymentService(
                (orderId, amount) -> new HttpResponse(400, "invalid_card_number"), 3, 100);
        try {
            s3.charge("ORD-003", 29900);
        } catch (PaymentGatewayException e) {
            System.out.println("最終失敗: " + e.getMessage());
            System.out.println("可重試: " + e.isRetryable());
        }

        System.out.println("\n=== 情境 4：網路逾時後成功 ===");
        var s4 = new ResilientPaymentService(new PaymentGatewayClient() {
            private int count = 0;

            @Override
            public HttpResponse charge(String orderId, long amountCents) throws java.io.IOException {
                if (++count == 1) {
                    throw new java.net.SocketTimeoutException("Read timed out");
                }
                return new HttpResponse(200, "{\"txId\":\"TX-retry-ok\"}");
            }
        }, 3, 100);
        System.out.println("結果: " + s4.charge("ORD-004", 29900));
    }
}
```

輸出：

```
=== 情境 1：第 2 次成功 ===
[WARN] 付款失敗，100 ms 後重試（1/3），orderId=ORD-001，原因=第 1 次: HTTP 503 Service Unavailable
[WARN] 付款成功（第 2 次嘗試），orderId=ORD-001
結果: {"txId":"TX-ORD-001"}

=== 情境 2：一直失敗，重試耗盡 ===
[WARN] 付款失敗，100 ms 後重試（1/3），orderId=ORD-002，原因=第 1 次: HTTP 503 Service Unavailable
[WARN] 付款失敗，200 ms 後重試（2/3），orderId=ORD-002，原因=第 2 次: HTTP 503 Service Unavailable
最終失敗: 付款失敗，已重試 3 次 {orderId=ORD-002, amountCents=29900, attempts=[第 1 次: HTTP 503 Service Unavailable, 第 2 次: HTTP 503 Service Unavailable, 第 3 次: HTTP 503 Service Unavailable]}
可重試: true

=== 情境 3：4xx 不重試 ===
[WARN] 付款請求被拒絕，不重試 {orderId=ORD-003, status=400, body=invalid_card_number, attempt=1}
最終失敗: 付款請求被拒絕，不重試 {orderId=ORD-003, status=400, body=invalid_card_number, attempt=1}
可重試: false

=== 情境 4：網路逾時後成功 ===
[WARN] 付款失敗，100 ms 後重試（1/3），orderId=ORD-004，原因=第 1 次: SocketTimeoutException: Read timed out
[WARN] 付款成功（第 2 次嘗試），orderId=ORD-004
結果: {"txId":"TX-retry-ok"}
```

**設計重點：**

1. **4xx 不重試**是最重要的一條。付款 API 的 4xx 代表「你的請求有問題」，重試只會浪費時間；
   而且如果閘道其實已經收到了扣款請求，重試可能造成**重複扣款**。
2. **指數退避** `baseBackoff * 2^(attempt-1)`：避免在對方服務剛掛掉時用固定間隔猛打，
   讓對方更難恢復（thundering herd）。
3. **例外訊息帶上每一次的失敗原因**。只記最後一次的話，你不知道是「三次都是 503」還是
   「先逾時、再 503、最後連線被拒」——這兩者的根因完全不同。
4. **重試成功也要記 WARN**。這是一個獨立的事件（外部服務不穩定），值得監控。
   如果重試成功率突然升高，代表對方服務在惡化。
5. **`Thread.currentThread().interrupt()`** 不能漏（反模式 6）。

> **實務補充**：真正的付款重試還需要 **idempotency key（冪等鍵）**——每次重試帶同一個 key，
> 讓閘道能識別「這是同一筆」，避免重複扣款。第 03 站（REST API）與第 10 站（期末專題）會實作。
> 另外實務上會用 **Resilience4j** 或 **Spring Retry** 而不是手寫，但你現在懂它在做什麼了。

</details>

### 練習 4：預測輸出

```java
public class Quiz {

    static int a() {
        try {
            return 1;
        } finally {
            System.out.println("A finally");
        }
    }

    static int b() {
        int x = 1;
        try {
            return x;
        } finally {
            x = 2;
            System.out.println("B finally, x=" + x);
        }
    }

    static int c() {
        try {
            throw new RuntimeException("boom");
        } finally {
            return 3;
        }
    }

    static String d() {
        StringBuilder sb = new StringBuilder("start");
        try {
            return sb.toString();
        } finally {
            sb.append("-modified");
            System.out.println("D finally, sb=" + sb);
        }
    }

    public static void main(String[] args) {
        System.out.println("a() = " + a());
        System.out.println("b() = " + b());
        System.out.println("c() = " + c());
        System.out.println("d() = " + d());
    }
}
```

<details>
<summary>參考解答</summary>

```
A finally
a() = 1
B finally, x=2
b() = 1
c() = 3
D finally, sb=start-modified
d() = start
```

**逐一說明：**

**`a()`**：`finally` 在 `return` 之前執行，但不影響回傳值。

**`b()`**：關鍵——`return x` 時**已經把 `x` 的值（1）複製到回傳槽**了。
`finally` 裡改 `x = 2` 只改了區域變數，回傳值仍是 1。

**`c()`**：`finally` 裡的 `return 3` **完全吃掉了例外**。這個方法永遠回傳 3，永遠不丟例外。
這是 4.4 節陷阱一。

**`d()`**：`sb.toString()` 在 `return` 時就已經產生了一個**新的 String**（`"start"`），
回傳槽存的是那個 String 的參考。之後 `sb.append` 改的是 `StringBuilder`，
不影響已經產生的 String（`String` 不可變，第 01 章 1.9 節）。

**如果 `d()` 改成回傳 `sb` 本身呢？**

```java
static StringBuilder e() {
    StringBuilder sb = new StringBuilder("start");
    try {
        return sb;                    // 回傳的是「參考」
    } finally {
        sb.append("-modified");       // 透過同一個參考修改物件內容
    }
}
// e() 回傳的 StringBuilder 內容是 "start-modified"
```

這正是第 01 章 1.14 節「值傳遞：拷貝的是參考」的另一個面向：
**回傳值被固定的是「參考」，不是「物件的內容」。**

</details>

### 練習 5：設計 API 錯誤回應格式

設計一個 API 錯誤回應的資料結構與轉換邏輯，要能同時滿足：

- 前端能據此顯示對應文案並定位到出錯的表單欄位
- 客服能用一個碼查到處理手冊
- 工程師能用 traceId 在 log 中找到那次請求
- 不洩漏內部技術細節

<details>
<summary>參考解答</summary>

```java
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 欄位層級的錯誤，給前端定位表單 */
record FieldError(String field, String code, String message, Object rejectedValue) { }

/** 統一的錯誤回應格式 */
record ApiErrorResponse(
        String code,                  // 錯誤碼，給客服與前端對照：S3001
        String message,               // 對外文案，可直接顯示：庫存不足
        String traceId,               // 追蹤碼，客戶回報時提供
        String timestamp,             // 發生時間
        String path,                  // 哪一支 API
        Map<String, Object> details,  // 額外資訊（僅 4xx 才給）
        List<FieldError> fieldErrors  // 表單驗證錯誤
) {

    static ApiErrorResponse of(String code, String message, String traceId, String path) {
        return new ApiErrorResponse(code, message, traceId,
                Instant.now().toString(), path, Map.of(), List.of());
    }

    ApiErrorResponse withDetails(Map<String, Object> details) {
        return new ApiErrorResponse(code, message, traceId, timestamp, path,
                Map.copyOf(details), fieldErrors);
    }

    ApiErrorResponse withFieldErrors(List<FieldError> errors) {
        return new ApiErrorResponse(code, message, traceId, timestamp, path,
                details, List.copyOf(errors));
    }

    /** 序列化成 JSON（實務上由 Jackson 處理，這裡手寫給你看形狀） */
    String toJson() {
        StringBuilder sb = new StringBuilder("{\n");
        sb.append("  \"code\": \"").append(code).append("\",\n");
        sb.append("  \"message\": \"").append(message).append("\",\n");
        sb.append("  \"traceId\": \"").append(traceId).append("\",\n");
        sb.append("  \"timestamp\": \"").append(timestamp).append("\",\n");
        sb.append("  \"path\": \"").append(path).append("\"");
        if (!details.isEmpty()) {
            sb.append(",\n  \"details\": ").append(details);
        }
        if (!fieldErrors.isEmpty()) {
            sb.append(",\n  \"fieldErrors\": [\n");
            for (int i = 0; i < fieldErrors.size(); i++) {
                FieldError fe = fieldErrors.get(i);
                sb.append("    {\"field\":\"").append(fe.field())
                  .append("\",\"code\":\"").append(fe.code())
                  .append("\",\"message\":\"").append(fe.message()).append("\"}");
                if (i < fieldErrors.size() - 1) sb.append(",");
                sb.append("\n");
            }
            sb.append("  ]");
        }
        return sb.append("\n}").toString();
    }
}

// ===== 例外定義（練習 2 的簡化版，原樣搬來所需部分）=====

enum ShopErrorCode {
    VALIDATION_FAILED("S1000", 400, "輸入資料有誤"),
    INSUFFICIENT_STOCK("S3001", 409, "庫存不足"),
    PAYMENT_GATEWAY_ERROR("S6003", 502, "付款服務暫時無法使用"),
    INTERNAL_ERROR("S9999", 500, "系統暫時無法處理您的請求");

    private final String code;
    private final int httpStatus;
    private final String userMessage;

    ShopErrorCode(String code, int httpStatus, String userMessage) {
        this.code = code;
        this.httpStatus = httpStatus;
        this.userMessage = userMessage;
    }

    String getCode() { return code; }
    int getHttpStatus() { return httpStatus; }
    String getUserMessage() { return userMessage; }
    boolean isOurFault() { return httpStatus >= 500; }
}

class ShopException extends RuntimeException {
    private final ShopErrorCode errorCode;
    private final Map<String, Object> context = new LinkedHashMap<>();

    ShopException(ShopErrorCode errorCode, String detail) {
        super(detail);
        this.errorCode = errorCode;
    }

    ShopException(ShopErrorCode errorCode, String detail, Throwable cause) {
        super(detail, cause);
        this.errorCode = errorCode;
    }

    ShopException with(String key, Object value) {
        context.put(key, value);
        return this;
    }

    ShopErrorCode getErrorCode() { return errorCode; }
    Map<String, Object> getContext() { return Map.copyOf(context); }
}

class ValidationException extends ShopException {
    private final List<FieldError> fieldErrors;

    ValidationException(List<FieldError> fieldErrors) {
        super(ShopErrorCode.VALIDATION_FAILED, "共 " + fieldErrors.size() + " 個欄位驗證失敗");
        this.fieldErrors = List.copyOf(fieldErrors);
    }

    List<FieldError> getFieldErrors() { return fieldErrors; }
}

// ===== 全域處理器 =====

class GlobalExceptionHandler {

    /** 產生 traceId。實務上由 Micrometer Tracing / Sleuth 從 MDC 取得 */
    private String currentTraceId() {
        return Long.toHexString(System.nanoTime()).substring(0, 12);
    }

    ApiErrorResponse handle(RuntimeException e, String path) {
        String traceId = currentTraceId();

        // ① 表單驗證：一次回報所有欄位
        if (e instanceof ValidationException ve) {
            logWarn(traceId, path, ve.getMessage(), ve.getFieldErrors().toString());
            return ApiErrorResponse.of(
                            ve.getErrorCode().getCode(),
                            ve.getErrorCode().getUserMessage(), traceId, path)
                    .withFieldErrors(ve.getFieldErrors());
        }

        // ② 已知的業務例外
        if (e instanceof ShopException se) {
            ShopErrorCode code = se.getErrorCode();

            if (code.isOurFault()) {
                // 5xx：完整堆疊進 log，對外「不給」details
                logError(traceId, path, se);
                return ApiErrorResponse.of(code.getCode(), code.getUserMessage(), traceId, path);
            }

            // 4xx：details 對使用者有用（例如「僅剩 2 件」）
            logWarn(traceId, path, se.getMessage(), se.getContext().toString());
            return ApiErrorResponse.of(code.getCode(), code.getUserMessage(), traceId, path)
                    .withDetails(se.getContext());
        }

        // ③ 未預期：一律 500，對外不透露任何細節
        logError(traceId, path, e);
        return ApiErrorResponse.of(
                ShopErrorCode.INTERNAL_ERROR.getCode(),
                ShopErrorCode.INTERNAL_ERROR.getUserMessage(), traceId, path);
    }

    private void logWarn(String traceId, String path, String message, String context) {
        System.out.printf("[WARN ] traceId=%s path=%s msg=%s ctx=%s%n",
                traceId, path, message, context);
    }

    private void logError(String traceId, String path, Throwable e) {
        System.err.printf("[ERROR] traceId=%s path=%s msg=%s%n", traceId, path, e.getMessage());
        Throwable cause = e.getCause();
        while (cause != null) {
            System.err.printf("        caused by: %s: %s%n",
                    cause.getClass().getName(), cause.getMessage());
            cause = cause.getCause();
        }
        // 實務上是 log.error("...", e)，會輸出完整堆疊
    }
}

public class ApiErrorFormatDemo {
    public static void main(String[] args) {
        GlobalExceptionHandler handler = new GlobalExceptionHandler();

        System.out.println("=== ① 表單驗證失敗（400）===");
        List<FieldError> errors = new ArrayList<>();
        errors.add(new FieldError("email", "INVALID_FORMAT", "email 格式錯誤", "not-an-email"));
        errors.add(new FieldError("quantity", "MIN", "數量至少為 1", 0));
        System.out.println(handler.handle(new ValidationException(errors), "/api/orders").toJson());

        System.out.println("\n=== ② 庫存不足（409，details 給前端）===");
        var stockError = new ShopException(ShopErrorCode.INSUFFICIENT_STOCK, "庫存不足")
                .with("sku", "SKU-1001").with("required", 5).with("available", 2);
        System.out.println(handler.handle(stockError, "/api/orders").toJson());

        System.out.println("\n=== ③ 外部服務失敗（502，details 不給前端）===");
        var gatewayError = new ShopException(
                ShopErrorCode.PAYMENT_GATEWAY_ERROR,
                "呼叫 https://pay.internal.example.com/v2/charge 失敗",
                new java.net.SocketTimeoutException("Read timed out after 30000ms"))
                .with("gatewayUrl", "https://pay.internal.example.com/v2/charge")
                .with("orderId", "ORD-001");
        System.out.println(handler.handle(gatewayError, "/api/payments").toJson());

        System.out.println("\n=== ④ 未預期的 NPE（500）===");
        System.out.println(handler.handle(
                new NullPointerException(
                        "Cannot invoke \"Order.getItems()\" because \"order\" is null"),
                "/api/orders/123").toJson());
    }
}
```

輸出（節錄）：

```
=== ① 表單驗證失敗（400）===
[WARN ] traceId=1a2b3c4d5e6f path=/api/orders msg=共 2 個欄位驗證失敗 ctx=[...]
{
  "code": "S1000",
  "message": "輸入資料有誤",
  "traceId": "1a2b3c4d5e6f",
  "timestamp": "2026-08-17T02:30:00.123Z",
  "path": "/api/orders",
  "fieldErrors": [
    {"field":"email","code":"INVALID_FORMAT","message":"email 格式錯誤"},
    {"field":"quantity","code":"MIN","message":"數量至少為 1"}
  ]
}

=== ② 庫存不足（409，details 給前端）===
[WARN ] traceId=... path=/api/orders msg=庫存不足 ctx={sku=SKU-1001, required=5, available=2}
{
  "code": "S3001",
  "message": "庫存不足",
  "traceId": "...",
  ...
  "details": {sku=SKU-1001, required=5, available=2}
}

=== ③ 外部服務失敗（502，details 不給前端）===
[ERROR] traceId=... path=/api/payments msg=呼叫 https://pay.internal.example.com/v2/charge 失敗
        caused by: java.net.SocketTimeoutException: Read timed out after 30000ms
{
  "code": "S6003",
  "message": "付款服務暫時無法使用",
  "traceId": "...",
  "path": "/api/payments"
}
```

**四個關鍵設計：**

| 需求 | 怎麼滿足 |
|---|---|
| 前端顯示文案 + 定位欄位 | `message`（已本地化的對外文案）+ `fieldErrors[].field` |
| 客服查手冊 | `code`（`S3001`），對照一份「錯誤碼 → 處理方式」的文件 |
| 工程師查 log | `traceId`，客戶截圖回報後可精準搜尋 |
| 不洩漏細節 | **5xx 不回傳 `details`**。注意情境 ③：內部 URL `pay.internal.example.com` 和 `SocketTimeoutException` 只出現在 log，回應裡完全沒有 |

**特別注意 `message` 的語意**：它是**給終端使用者看的**（「付款服務暫時無法使用」），
不是給工程師看的（「呼叫 https://... 失敗」）。兩者用途不同，必須分開。
這是 4.12 反模式 8 最容易被忽略的地方——很多專案直接把 `e.getMessage()` 塞進回應，
結果內部主機名、資料表名、框架版本全都洩漏出去。

> **實務對照**：這個格式接近 RFC 9457（Problem Details for HTTP APIs）的精神。
> Spring Boot 3 內建 `ProblemDetail` 支援，第 03 站與第 04 站會實作 `@RestControllerAdvice` 版本。

</details>

---

## 4.18 驗收清單

- [ ] 我能畫出例外體系，並說明 `Error` 為什麼不該 catch。
- [ ] 我知道 `finally` 裡的 `return` 會吃掉例外，也知道 `finally` 丟例外會蓋掉原始例外。
- [ ] 我能在 checked 與 unchecked 之間做出有理由的選擇，也知道現代框架為什麼偏好 unchecked。
- [ ] 我一律用 try-with-resources，也能解釋 suppressed exception。
- [ ] 我包裝例外時**永遠**傳入 `cause`。
- [ ] 我的例外訊息包含識別資訊（id）、實際值、期望值，且不含敏感資料。
- [ ] 我能設計一套「基底例外 + 錯誤碼 enum + 少量子類別」的體系。
- [ ] 我知道 Repository / Service / Controller 各層該怎麼處理例外。
- [ ] 我不用 `printStackTrace()`，並知道 SLF4J 的例外參數該放在最後。
- [ ] 我知道同一個例外只該記 log 一次。
- [ ] 我知道 `InterruptedException` 必須恢復中斷旗標。
- [ ] 我能判斷什麼時候該用例外、`Optional`、還是 `sealed` 結果型別。
- [ ] 我知道 5xx 的回應不該洩漏內部細節，要用 traceId 代替。

---

完成後請前往 [05-collections-and-generics.md](./05-collections-and-generics.md)。
