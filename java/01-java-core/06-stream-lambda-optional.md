# 第 06 章：Lambda、Stream 與 Optional

> Java 8 的這三樣東西，讓 Java 從「囉唆」變成「還算現代」。但也造就了兩種極端：
> 一種人完全不用，還在寫三層巢狀 for 迴圈；另一種人一行寫 200 字，
> `.stream().map().filter().flatMap().collect(groupingBy(..., mapping(..., toList())))`，
> 連自己一週後都看不懂。
>
> 這章的目標是讓你**寫出比 for 迴圈更好讀的 Stream**，並且知道**什麼時候該用回 for 迴圈**。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說明 Lambda 與匿名類別的差別（包含 `this` 的語意）。
- 認得並正確使用四大內建函式介面：`Function` / `Predicate` / `Consumer` / `Supplier`。
- 使用方法參考的四種形式，並知道 `String::length` 為什麼能當 `Function`。
- 解釋「effectively final」限制的存在理由。
- 設計自訂函式介面，寫出重試模板、交易模板這類**高階函式**。
- 說明 Stream 的惰性求值，並解釋為什麼「只有終端操作會觸發執行」。
- 熟練 `map` / `filter` / `flatMap` / `sorted` / `distinct` / `limit`。
- 用 `Collectors.groupingBy` + downstream 寫出多層分組統計。
- 正確使用 `Optional`，並說明 `orElse` 與 `orElseGet` 的關鍵差異。
- 說出平行流的四個陷阱，並判斷什麼時候該用（答案通常是「不要用」）。
- 判斷什麼時候該用 for 迴圈而不是 Stream。

---

## 6.2 從匿名類別到 Lambda

```java
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class LambdaEvolution {
    public static void main(String[] args) {
        List<String> words = new ArrayList<>(List.of("banana", "kiwi", "apple", "fig"));

        // ① Java 7：匿名類別，五行只為了說「按長度排序」
        words.sort(new Comparator<String>() {
            @Override
            public int compare(String a, String b) {
                return Integer.compare(a.length(), b.length());
            }
        });
        System.out.println(words);        // [fig, kiwi, apple, banana]

        // ② Java 8：Lambda
        words.sort((a, b) -> Integer.compare(a.length(), b.length()));

        // ③ 更好：用 Comparator 的工廠方法（第 05 章 5.10 節）
        words.sort(Comparator.comparingInt(String::length));

        // ④ 多欄位：長度 → 字母序
        words.sort(Comparator.comparingInt(String::length).thenComparing(Comparator.naturalOrder()));
        System.out.println(words);        // [fig, kiwi, apple, banana]
    }
}
```

### Lambda 語法的四種寫法

```java
import java.util.function.BiFunction;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.Supplier;

public class LambdaSyntax {
    public static void main(String[] args) {

        // 完整：(參數型別 參數名) -> { 陳述句 }
        Function<String, Integer> f1 = (String s) -> { return s.length(); };

        // 省略型別（編譯器從目標型別推斷）
        Function<String, Integer> f2 = (s) -> { return s.length(); };

        // 單一參數可省略括號
        Function<String, Integer> f3 = s -> { return s.length(); };

        // 單一表達式可省略大括號與 return
        Function<String, Integer> f4 = s -> s.length();

        System.out.println(f4.apply("hello"));       // 5

        // 無參數：括號不可省
        Supplier<String> supplier = () -> "hello";
        System.out.println(supplier.get());          // hello

        // 多參數
        BiFunction<Integer, Integer, Integer> add = (a, b) -> a + b;
        System.out.println(add.apply(3, 4));         // 7

        // 多行需要大括號與 return
        Predicate<String> isValidEmail = email -> {
            if (email == null || email.isBlank()) return false;
            int at = email.indexOf('@');
            return at > 0 && at < email.length() - 1;
        };
        System.out.println(isValidEmail.test("a@b.com"));    // true
        System.out.println(isValidEmail.test("@b.com"));     // false
    }
}
```

### Lambda 與匿名類別的三個差異

```java
public class LambdaVsAnonymous {

    private String name = "外層物件";

    interface Task { void run(); }

    void demo() {
        // ① this 的語意不同
        Task anonymous = new Task() {
            private String name = "匿名類別";

            @Override
            public void run() {
                System.out.println("匿名類別的 this: " + this.name);
                System.out.println("外層的 name    : " + LambdaVsAnonymous.this.name);
            }
        };

        Task lambda = () -> {
            // Lambda 沒有自己的 this，this 就是外層物件
            System.out.println("Lambda 的 this : " + this.name);
        };

        anonymous.run();
        lambda.run();
    }

    public static void main(String[] args) {
        new LambdaVsAnonymous().demo();
    }
}
```

輸出：

```
匿名類別的 this: 匿名類別
外層的 name    : 外層物件
Lambda 的 this : 外層物件
```

| | 匿名類別 | Lambda |
|---|---|---|
| `this` | 指向匿名類別實例 | 指向**外層物件** |
| 可以有欄位 | ✅ | ❌ |
| 可以實作多個方法 | ✅ | ❌ 只能是函式介面（單一抽象方法） |
| 產生 `.class` 檔 | ✅ 每個都產生（`Outer$1.class`） | ❌ 用 `invokedynamic` 在執行時產生 |
| 可以繼承抽象類別 | ✅ | ❌ 只能是介面 |

> **`this` 的差異在實務上會咬人**：把 Lambda 從匿名類別重構過來時，如果原本用了 `this` 指涉匿名實例，
> 行為會改變。反過來說，Lambda 的 `this` 更直覺（就是你寫程式時看到的那個 `this`）。

---

## 6.3 函式介面

**函式介面 = 只有一個抽象方法的介面。** Lambda 就是它的實例。

```java
@FunctionalInterface        // ← 加上這個註解，編譯器會檢查「是否只有一個抽象方法」
interface Validator {
    boolean validate(String input);      // 唯一的抽象方法

    // default / static / Object 的方法不算（第 03 章 3.9 節）
    default Validator and(Validator other) {
        return input -> this.validate(input) && other.validate(input);
    }
}
```

### 四大內建函式介面

```java
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.Supplier;
import java.util.function.UnaryOperator;

public class BuiltinFunctionalInterfaces {
    public static void main(String[] args) {

        // ① Function<T, R>：T → R（有進有出）
        Function<String, Integer> length = String::length;
        System.out.println(length.apply("hello"));                 // 5

        // 組合：andThen（先我後他）、compose（先他後我）
        Function<Integer, String> toLabel = n -> "長度=" + n;
        System.out.println(length.andThen(toLabel).apply("hello")); // 長度=5
        System.out.println(toLabel.compose(length).apply("hello")); // 長度=5（同上）

        // ② Predicate<T>：T → boolean（判斷）
        Predicate<String> isEmpty = String::isEmpty;
        Predicate<String> isBlank = String::isBlank;
        System.out.println(isEmpty.test(""));                      // true
        System.out.println(isEmpty.negate().test(""));             // false
        System.out.println(isBlank.and(s -> s.length() < 5).test("   "));   // true
        System.out.println(isEmpty.or(isBlank).test("  "));        // true

        // ③ Consumer<T>：T → void（只吃不吐）
        Consumer<String> print = System.out::println;
        Consumer<String> printUpper = s -> System.out.println(s.toUpperCase());
        print.andThen(printUpper).accept("hello");                 // hello \n HELLO

        // ④ Supplier<T>：() → T（只吐不吃）
        Supplier<String> now = () -> java.time.LocalTime.now().toString();
        System.out.println(now.get());

        // ⑤ UnaryOperator<T>：T → T（Function 的特例）
        UnaryOperator<String> trim = String::strip;
        System.out.println("[" + trim.apply("  hi  ") + "]");      // [hi]

        // ⑥ BiFunction<T, U, R>：兩個輸入
        BiFunction<String, String, String> join = (a, b) -> a + "-" + b;
        System.out.println(join.apply("a", "b"));                  // a-b
    }
}
```

### 完整對照表

| 介面 | 抽象方法 | 語意 | 常見用途 |
|---|---|---|---|
| `Function<T,R>` | `R apply(T)` | 轉換 | `stream.map()` |
| `BiFunction<T,U,R>` | `R apply(T,U)` | 兩輸入轉換 | `map.merge()` |
| `Predicate<T>` | `boolean test(T)` | 判斷 | `stream.filter()`、`removeIf()` |
| `BiPredicate<T,U>` | `boolean test(T,U)` | 兩輸入判斷 | |
| `Consumer<T>` | `void accept(T)` | 消費 | `stream.forEach()` |
| `BiConsumer<T,U>` | `void accept(T,U)` | 兩輸入消費 | `map.forEach()` |
| `Supplier<T>` | `T get()` | 生產 | `Optional.orElseGet()`、延遲初始化 |
| `UnaryOperator<T>` | `T apply(T)` | 同型別轉換 | `list.replaceAll()` |
| `BinaryOperator<T>` | `T apply(T,T)` | 兩同型別合成一個 | `stream.reduce()`、`Integer::sum` |
| `Runnable` | `void run()` | 無進無出 | 執行緒、`Executor` |
| `Callable<V>` | `V call()` throws | 有回傳、可丟例外 | `ExecutorService.submit()` |

### 基本型別版本：避免裝箱

```java
import java.util.function.IntFunction;
import java.util.function.IntPredicate;
import java.util.function.IntUnaryOperator;
import java.util.function.ToIntFunction;

public class PrimitiveFunctionalInterfaces {
    public static void main(String[] args) {
        // Function<Integer, Integer> 會裝箱兩次；IntUnaryOperator 完全不裝箱
        IntUnaryOperator doubleIt = n -> n * 2;
        System.out.println(doubleIt.applyAsInt(21));         // 42

        IntPredicate isEven = n -> n % 2 == 0;
        System.out.println(isEven.test(4));                  // true

        ToIntFunction<String> len = String::length;
        System.out.println(len.applyAsInt("hello"));         // 5

        IntFunction<String> toStr = n -> "值=" + n;
        System.out.println(toStr.apply(7));                  // 值=7
    }
}
```

命名規則：`IntXxx`（輸入是 int）、`ToIntXxx`（輸出是 int）、`IntToLongFunction`（兩者都指定）。

> **實務影響**：處理百萬筆數字時，`Function<Integer, Integer>` 會產生百萬個 `Integer` 物件
> （第 01 章 1.7 節陷阱四）。`IntStream` + `IntUnaryOperator` 完全不裝箱。

---

## 6.4 方法參考

方法參考是 Lambda 的簡寫，有四種形式。

```java
import java.util.ArrayList;
import java.util.List;
import java.util.function.BiFunction;
import java.util.function.Function;
import java.util.function.Supplier;

public class MethodReferences {

    static class Order {
        private final String id;
        private final long amount;

        Order(String id, long amount) { this.id = id; this.amount = amount; }

        String getId() { return id; }
        long getAmount() { return amount; }
        boolean isBig() { return amount > 1000; }

        static Order parse(String csv) {
            String[] parts = csv.split(",");
            return new Order(parts[0], Long.parseLong(parts[1]));
        }
    }

    public static void main(String[] args) {

        // ① 靜態方法參考：ClassName::staticMethod
        Function<String, Integer> parse1 = Integer::parseInt;
        Function<String, Order> parse2 = Order::parse;
        System.out.println(parse1.apply("42"));                  // 42
        System.out.println(parse2.apply("ORD-1,500").getId());   // ORD-1

        // ② 特定物件的實例方法：instance::method
        Order order = new Order("ORD-9", 2000);
        Supplier<String> getId = order::getId;
        System.out.println(getId.get());                          // ORD-9

        List<String> log = new ArrayList<>();
        java.util.function.Consumer<String> record = log::add;    // 綁定到 log 這個物件
        record.accept("事件 1");
        System.out.println(log);                                  // [事件 1]

        // ③ 任意物件的實例方法：ClassName::instanceMethod
        //    ⚠️ 這個最容易搞混：第一個參數變成「接收者」
        Function<String, Integer> length = String::length;         // s -> s.length()
        Function<Order, String> id = Order::getId;                 // o -> o.getId()
        java.util.function.Predicate<Order> big = Order::isBig;    // o -> o.isBig()
        System.out.println(length.apply("hello"));                 // 5
        System.out.println(id.apply(order));                       // ORD-9
        System.out.println(big.test(order));                       // true

        // 兩個參數的版本：第一個是接收者，第二個是方法參數
        BiFunction<String, String, Boolean> startsWith = String::startsWith;
        System.out.println(startsWith.apply("hello", "he"));       // true

        // ④ 建構子參考：ClassName::new
        Supplier<ArrayList<String>> newList = ArrayList::new;
        System.out.println(newList.get());                         // []

        BiFunction<String, Long, Order> newOrder = Order::new;
        System.out.println(newOrder.apply("ORD-X", 100L).getId()); // ORD-X

        // 陣列的建構子參考
        java.util.function.IntFunction<String[]> newArray = String[]::new;
        System.out.println(newArray.apply(3).length);              // 3
    }
}
```

### 什麼時候該用方法參考、什麼時候不該

```java
import java.util.List;
import java.util.stream.Collectors;

public class WhenToUseMethodRef {

    record Order(String id, long amountCents, String status) { }

    public static void main(String[] args) {
        List<Order> orders = List.of(
                new Order("ORD-1", 29900, "PAID"),
                new Order("ORD-2", 8900, "CREATED"));

        // ✅ 方法參考更簡潔
        orders.stream().map(Order::id).forEach(System.out::println);

        // ✅ 需要額外邏輯時，Lambda 更清楚
        orders.stream()
                .map(o -> o.id() + " (" + o.amountCents() / 100.0 + " 元)")
                .forEach(System.out::println);

        // ❌ 為了用方法參考而硬拆一個方法，反而更難讀
        // orders.stream().map(WhenToUseMethodRef::formatOrderIdWithAmountInDollars)

        // ✅ 但如果這個轉換會被重複使用，抽方法就對了
        orders.stream().map(WhenToUseMethodRef::toDisplay).forEach(System.out::println);
    }

    static String toDisplay(Order o) {
        return "%s %,.2f 元 [%s]".formatted(o.id(), o.amountCents() / 100.0, o.status());
    }
}
```

---

## 6.5 閉包與 effectively final

```java
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

public class ClosureRules {
    public static void main(String[] args) {

        // Lambda 可以捕捉區域變數，但那個變數必須是 final 或 effectively final
        int base = 10;                             // effectively final（賦值一次後不再改）
        Supplier<Integer> s = () -> base + 1;
        System.out.println(s.get());               // 11
        // base = 20;                              // ❌ 加上這行，上面的 Lambda 就編譯錯誤

        // 迴圈變數的差別
        List<Supplier<Integer>> suppliers = new ArrayList<>();

        // ✅ 增強 for 的變數每一圈都是新的，可以捕捉
        for (int n : List.of(1, 2, 3)) {
            suppliers.add(() -> n);
        }
        suppliers.forEach(sup -> System.out.print(sup.get() + " "));    // 1 2 3
        System.out.println();

        // ❌ 傳統 for 的 i 是同一個變數，會不斷改變 → 不是 effectively final
        // for (int i = 0; i < 3; i++) {
        //     suppliers.add(() -> i);             // 編譯錯誤
        // }

        // ✅ 解法：複製到區域變數
        List<Supplier<Integer>> fixed = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            int captured = i;                       // 每一圈都是新變數
            fixed.add(() -> captured);
        }
        fixed.forEach(sup -> System.out.print(sup.get() + " "));        // 0 1 2
        System.out.println();

        // ⚠️ 「物件的內容」可以改，只是「參考」不能重新指向
        List<String> list = new ArrayList<>();
        Runnable r = () -> list.add("加進去了");     // ✅ 修改物件內容
        r.run();
        System.out.println(list);                    // [加進去了]
        // list = new ArrayList<>();                 // ❌ 重新指向就不行
    }
}
```

### 為什麼有這個限制

Java 的 Lambda 捕捉的是**變數的值**（值傳遞，第 01 章 1.14 節），不是變數本身。
如果允許之後修改，Lambda 裡看到的值和外面就不一致，行為無法預期——尤其在多執行緒下。

**用 Lambda 累加時的正確做法：**

```java
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public class AccumulateInLambda {
    public static void main(String[] args) {
        List<Integer> numbers = List.of(1, 2, 3, 4, 5);

        // ❌ 編譯錯誤
        // int sum = 0;
        // numbers.forEach(n -> sum += n);

        // ⚠️ 能編譯但這是反模式：用可變容器繞過限制
        AtomicInteger sum = new AtomicInteger();
        numbers.forEach(sum::addAndGet);
        System.out.println(sum.get());                   // 15

        // ✅ 正確做法：用 Stream 的歸約，不要自己累加
        int properSum = numbers.stream().mapToInt(Integer::intValue).sum();
        System.out.println(properSum);                   // 15

        // ✅ 需要 long 避免溢位時（第 01 章 1.4 節）
        long bigSum = numbers.stream().mapToLong(Integer::longValue).sum();
        System.out.println(bigSum);                      // 15
    }
}
```

> **看到 `AtomicInteger` 在 Lambda 裡被用來累加，通常是「這裡該用 Stream 的歸約」的訊號。**
> 例外：真的需要在多執行緒間共享計數器時（第 08 章）。

---

## 6.6 自訂函式介面：寫出高階函式

這一節是本章實務價值最高的部分：**把「重複的樣板碼」變成可傳入行為的模板方法。**

### 案例一：重試模板

第 03 章的 `RetryNotifier` 只能重試通知。用泛型 + 函式介面，可以重試任何操作：

```java
import java.util.function.Supplier;

public final class Retry {

    private final int maxAttempts;
    private final long baseBackoffMillis;

    private Retry(int maxAttempts, long baseBackoffMillis) {
        if (maxAttempts < 1) {
            throw new IllegalArgumentException("maxAttempts 必須 >= 1，收到: " + maxAttempts);
        }
        this.maxAttempts = maxAttempts;
        this.baseBackoffMillis = baseBackoffMillis;
    }

    public static Retry times(int maxAttempts) {
        return new Retry(maxAttempts, 100);
    }

    public Retry withBackoff(long baseBackoffMillis) {
        return new Retry(this.maxAttempts, baseBackoffMillis);
    }

    /** 執行有回傳值的操作 */
    public <T> T call(Supplier<T> action) {
        RuntimeException last = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                T result = action.get();
                if (attempt > 1) {
                    System.out.println("  ↳ 第 " + attempt + " 次成功");
                }
                return result;
            } catch (RuntimeException e) {
                last = e;
                System.out.println("  ↳ 第 " + attempt + " 次失敗: " + e.getMessage());
                if (attempt < maxAttempts) {
                    sleep(baseBackoffMillis * (1L << (attempt - 1)));
                }
            }
        }
        throw new IllegalStateException("重試 %d 次後仍失敗".formatted(maxAttempts), last);
    }

    /** 執行沒有回傳值的操作 */
    public void run(Runnable action) {
        call(() -> {
            action.run();
            return null;
        });
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();       // 第 04 章反模式 6
            throw new IllegalStateException("重試等待被中斷", e);
        }
    }

    // ===== 使用示範 =====

    private static int callCount = 0;

    static String flakyApiCall() {
        if (++callCount < 3) {
            throw new RuntimeException("連線逾時");
        }
        return "{\"status\":\"ok\"}";
    }

    public static void main(String[] args) {
        // 任何操作都能重試，不用為每種操作寫一個 RetryXxx 類別
        String result = Retry.times(5).withBackoff(50).call(Retry::flakyApiCall);
        System.out.println("結果: " + result);

        callCount = 0;
        Retry.times(2).run(() -> {
            System.out.println("  執行一個沒有回傳值的操作");
            if (++callCount < 2) throw new RuntimeException("第一次總是失敗");
        });

        // 失敗情境
        try {
            Retry.times(2).withBackoff(10).call(() -> {
                throw new RuntimeException("永遠失敗");
            });
        } catch (IllegalStateException e) {
            System.out.println("最終: " + e.getMessage());
            System.out.println("原因: " + e.getCause().getMessage());
        }
    }
}
```

輸出：

```
  ↳ 第 1 次失敗: 連線逾時
  ↳ 第 2 次失敗: 連線逾時
  ↳ 第 3 次成功
結果: {"status":"ok"}
  執行一個沒有回傳值的操作
  ↳ 第 1 次失敗: 第一次總是失敗
  執行一個沒有回傳值的操作
  ↳ 第 2 次成功
  ↳ 第 1 次失敗: 永遠失敗
  ↳ 第 2 次失敗: 永遠失敗
最終: 重試 2 次後仍失敗
原因: 永遠失敗
```

### 案例二：能丟 checked 例外的函式介面

第 04 章 4.5 節提過，checked 例外在 Lambda 裡很痛。自訂函式介面可以解決：

```java
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Function;

public class CheckedFunction {

    /** 允許丟 checked 例外的 Function */
    @FunctionalInterface
    interface ThrowingFunction<T, R, E extends Exception> {
        R apply(T t) throws E;
    }

    /**
     * 把 ThrowingFunction 包成普通 Function，checked 例外轉成 unchecked。
     *
     * ⚠️ 第三個型別參數要寫死成 `Exception`，不能寫 `? extends Exception`
     *    也不能宣告成方法的型別參數 `<E extends Exception>`：
     *    那樣 `f.apply(t)` 在編譯器眼中丟的是「型別變數 E」，
     *    而 `IOException` 不是 `E` 的子型別 →
     *    `catch (IOException e)` 會被判定成「這個 try 區塊不可能丟出 IOException」而編不過。
     */
    static <T, R> Function<T, R> unchecked(ThrowingFunction<T, R, Exception> f) {
        return t -> {
            try {
                return f.apply(t);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        };
    }

    public static void main(String[] args) throws IOException {
        // 準備測試檔案
        Path dir = Files.createTempDirectory("stream-demo");
        Files.writeString(dir.resolve("a.txt"), "內容 A");
        Files.writeString(dir.resolve("b.txt"), "內容 B");

        List<Path> paths = List.of(dir.resolve("a.txt"), dir.resolve("b.txt"));

        // ❌ 不能直接寫：Files.readString 丟 IOException
        // paths.stream().map(Files::readString).toList();

        // ❌ 醜寫法：每個 lambda 都包 try-catch
        List<String> ugly = paths.stream()
                .map(p -> {
                    try {
                        return Files.readString(p);
                    } catch (IOException e) {
                        throw new UncheckedIOException(e);
                    }
                })
                .toList();

        // ✅ 用 unchecked 包裝，讀起來乾淨多了
        List<String> clean = paths.stream()
                .map(unchecked(Files::readString))
                .toList();

        System.out.println(clean);          // [內容 A, 內容 B]

        // 清理
        for (Path p : paths) Files.deleteIfExists(p);
        Files.deleteIfExists(dir);
    }
}
```

> **實務提醒**：這個手法很方便，但它把 checked 例外藏起來了。
> 用在「讀檔失敗就整批失敗」的場合沒問題；如果你需要「單筆失敗不影響其他筆」，
> 應該回頭用第 03 章 3.8 節的模板方法模式，逐筆 try-catch 並收集錯誤。
>
> Vavr 的 `Try` 或第 05 章練習 4 的 `Result<T>` 是更完整的解法。

### 案例三：交易模板（Spring `TransactionTemplate` 的原型）

```java
import java.util.function.Function;
import java.util.function.Supplier;

public class TransactionTemplate {

    /** 模擬一個資料庫連線 */
    static class Connection implements AutoCloseable {
        private final String id;
        private boolean committed = false;

        Connection(String id) {
            this.id = id;
            System.out.println("  [開啟交易 " + id + "]");
        }

        void execute(String sql) { System.out.println("  執行: " + sql); }

        void commit() {
            committed = true;
            System.out.println("  [提交 " + id + "]");
        }

        void rollback() { System.out.println("  [回滾 " + id + "]"); }

        @Override
        public void close() {
            if (!committed) rollback();
            System.out.println("  [關閉連線 " + id + "]");
        }
    }

    private int seq = 0;

    /**
     * 交易模板：呼叫者只寫「業務邏輯」，
     * 開啟 / 提交 / 回滾 / 關閉全部由模板負責，不可能漏。
     */
    public <T> T execute(Function<Connection, T> work) {
        try (Connection conn = new Connection("TX-" + (++seq))) {
            T result = work.apply(conn);
            conn.commit();
            return result;
        }
    }

    public void executeWithoutResult(java.util.function.Consumer<Connection> work) {
        execute(conn -> {
            work.accept(conn);
            return null;
        });
    }

    public static void main(String[] args) {
        TransactionTemplate tx = new TransactionTemplate();

        System.out.println("=== 成功情境 ===");
        String orderId = tx.execute(conn -> {
            conn.execute("INSERT INTO orders ...");
            conn.execute("UPDATE inventory SET stock = stock - 1 ...");
            return "ORD-1001";
        });
        System.out.println("回傳: " + orderId);

        System.out.println("\n=== 失敗情境（自動回滾）===");
        try {
            tx.execute(conn -> {
                conn.execute("INSERT INTO orders ...");
                throw new IllegalStateException("庫存不足");
            });
        } catch (IllegalStateException e) {
            System.out.println("捕捉: " + e.getMessage());
        }

        System.out.println("\n=== 沒有回傳值 ===");
        tx.executeWithoutResult(conn -> conn.execute("DELETE FROM temp_data"));
    }
}
```

輸出：

```
=== 成功情境 ===
  [開啟交易 TX-1]
  執行: INSERT INTO orders ...
  執行: UPDATE inventory SET stock = stock - 1 ...
  [提交 TX-1]
  [關閉連線 TX-1]
回傳: ORD-1001

=== 失敗情境（自動回滾）===
  [開啟交易 TX-2]
  執行: INSERT INTO orders ...
  [回滾 TX-2]
  [關閉連線 TX-2]
捕捉: 庫存不足

=== 沒有回傳值 ===
  [開啟交易 TX-3]
  執行: DELETE FROM temp_data
  [提交 TX-3]
  [關閉連線 TX-3]
```

> **這就是 Spring 的 `TransactionTemplate`。** 而 `@Transactional` 是它的註解版
> （用第 03 章 3.13 節的代理機制自動包上這個模板）。
>
> **這個模式叫「執行周邊模式」（Execute Around Pattern）**：
> 前置與後置處理固定，中間的行為由呼叫者傳入。用它可以消滅大量重複的 try-finally。

---

## 6.7 Stream 的三段式與惰性求值

```java
import java.util.List;

public class StreamStructure {
    public static void main(String[] args) {
        List<String> words = List.of("banana", "kiwi", "apple", "fig", "cherry");

        List<String> result = words.stream()      // ① 來源
                .filter(w -> w.length() > 3)       // ② 中間操作（可以有 0~N 個）
                .map(String::toUpperCase)          // ② 中間操作
                .sorted()                          // ② 中間操作
                .toList();                         // ③ 終端操作（有且只有一個）

        System.out.println(result);                // [APPLE, BANANA, CHERRY, KIWI]
    }
}
```

### 惰性求值：親眼看見執行順序

```java
import java.util.List;

public class Laziness {
    public static void main(String[] args) {

        System.out.println("=== 沒有終端操作：什麼都不會執行 ===");
        List.of("a", "b", "c").stream()
                .filter(s -> {
                    System.out.println("  filter: " + s);
                    return true;
                })
                .map(s -> {
                    System.out.println("  map: " + s);
                    return s;
                });
        System.out.println("（上面完全沒有輸出）");

        System.out.println("\n=== 有終端操作：逐元素「垂直」執行 ===");
        List.of("a", "b", "c").stream()
                .filter(s -> {
                    System.out.println("  filter: " + s);
                    return true;
                })
                .map(s -> {
                    System.out.println("  map: " + s);
                    return s;
                })
                .forEach(s -> System.out.println("  forEach: " + s));

        System.out.println("\n=== 短路操作：找到就停 ===");
        java.util.Optional<String> found = List.of("a", "bb", "ccc", "dddd").stream()
                .filter(s -> {
                    System.out.println("  檢查: " + s);
                    return s.length() >= 2;
                })
                .findFirst();
        System.out.println("  結果: " + found.get());
    }
}
```

輸出：

```
=== 沒有終端操作：什麼都不會執行 ===
（上面完全沒有輸出）

=== 有終端操作：逐元素「垂直」執行 ===
  filter: a
  map: a
  forEach: a
  filter: b
  map: b
  forEach: b
  filter: c
  map: c
  forEach: c

=== 短路操作：找到就停 ===
  檢查: a
  檢查: bb
  結果: bb
```

**兩個關鍵觀察：**

1. **不是「先 filter 全部，再 map 全部」**，而是「每個元素依序穿過整條管線」。
   這叫**融合（fusion）**——只走訪集合一次，不產生中間集合。
2. **短路操作**（`findFirst` / `anyMatch` / `limit`）只處理必要的元素。
   `checked: ccc` 和 `dddd` 完全沒被檢查。

**這就是 Stream 比「多次 for 迴圈」快的原因：**

```java
// ❌ 三次走訪，兩個中間集合
List<String> filtered = new ArrayList<>();
for (String s : words) if (s.length() > 3) filtered.add(s);
List<String> mapped = new ArrayList<>();
for (String s : filtered) mapped.add(s.toUpperCase());
Collections.sort(mapped);

// ✅ 一次走訪，沒有中間集合
words.stream().filter(s -> s.length() > 3).map(String::toUpperCase).sorted().toList();
```

### Stream 只能消費一次

```java
import java.util.List;
import java.util.stream.Stream;

public class StreamSingleUse {
    public static void main(String[] args) {
        Stream<String> stream = List.of("a", "b").stream();

        System.out.println(stream.count());          // 2

        try {
            System.out.println(stream.count());      // 💥
        } catch (IllegalStateException e) {
            System.out.println(e.getMessage());
            // stream has already been operated upon or closed
        }

        // ✅ 需要多次使用 → 收集成集合，或每次重新建立 Stream
        List<String> list = List.of("a", "b");
        System.out.println(list.stream().count());
        System.out.println(list.stream().findFirst().orElse(""));

        // ✅ 或者把「建立 Stream」包成 Supplier
        java.util.function.Supplier<Stream<String>> supplier = list::stream;
        System.out.println(supplier.get().count());
        System.out.println(supplier.get().count());
    }
}
```

> **這是「不要把 Stream 存進欄位或當回傳型別」的原因。** 回傳 `List` 或 `Collection`，
> 讓呼叫方自己決定要不要開 Stream。
> （例外：資料量極大、需要惰性處理的情況，如 `Files.lines()`——但那時要記得 close。）

### 建立 Stream 的各種方式

```java
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;
import java.util.stream.Stream;

public class CreatingStreams {
    public static void main(String[] args) {

        // 從集合
        List.of("a", "b").stream().forEach(System.out::print);              // ab
        System.out.println();

        // 從陣列
        Arrays.stream(new int[]{1, 2, 3}).forEach(System.out::print);       // 123
        System.out.println();

        // 直接列舉
        Stream.of("x", "y", "z").forEach(System.out::print);                // xyz
        System.out.println();

        // 數值範圍
        IntStream.range(1, 5).forEach(System.out::print);                   // 1234（不含 5）
        IntStream.rangeClosed(1, 5).forEach(System.out::print);             // 12345（含 5）
        System.out.println();

        // 無限流 + limit
        Stream.iterate(1, n -> n * 2).limit(6).forEach(n -> System.out.print(n + " "));
        System.out.println();                                               // 1 2 4 8 16 32

        // 【Java 9+】三參數 iterate：自帶終止條件，不需要 limit
        Stream.iterate(1, n -> n < 100, n -> n * 3).forEach(n -> System.out.print(n + " "));
        System.out.println();                                               // 1 3 9 27 81

        Stream.generate(() -> "x").limit(3).forEach(System.out::print);     // xxx
        System.out.println();

        // 從 Map
        Map<String, Integer> map = Map.of("a", 1, "b", 2);
        map.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(e -> System.out.print(e.getKey() + "=" + e.getValue() + " "));
        System.out.println();                                               // a=1 b=2

        // 從字串
        "hello".chars().forEach(c -> System.out.print((char) c));           // hello
        System.out.println();

        // 空 Stream（比回傳 null 好）
        System.out.println(Stream.empty().count());                         // 0

        // 從可能是 null 的值【Java 9+】
        System.out.println(Stream.ofNullable(null).count());                // 0
        System.out.println(Stream.ofNullable("x").count());                 // 1
    }
}
```

---

## 6.8 中間操作

```java
import java.util.List;
import java.util.stream.Stream;

public class IntermediateOperations {

    record Order(String id, String userId, long amountCents, List<String> tags) { }

    public static void main(String[] args) {
        List<Order> orders = List.of(
                new Order("ORD-1", "u001", 29900, List.of("急件", "禮品")),
                new Order("ORD-2", "u002", 8900, List.of("急件")),
                new Order("ORD-3", "u001", 159900, List.of()),
                new Order("ORD-4", "u003", 45000, List.of("禮品", "大宗")));

        // filter：篩選
        System.out.println(orders.stream()
                .filter(o -> o.amountCents() > 20000)
                .map(Order::id).toList());                    // [ORD-1, ORD-3, ORD-4]

        // map：一對一轉換
        System.out.println(orders.stream().map(Order::userId).toList());
        // [u001, u002, u001, u003]

        // distinct：去重（依 equals）
        System.out.println(orders.stream().map(Order::userId).distinct().toList());
        // [u001, u002, u003]

        // flatMap：一對多「攤平」
        System.out.println(orders.stream()
                .flatMap(o -> o.tags().stream())
                .distinct().toList());                        // [急件, 禮品, 大宗]

        // sorted
        System.out.println(orders.stream()
                .sorted(java.util.Comparator.comparingLong(Order::amountCents).reversed())
                .map(Order::id).toList());                    // [ORD-3, ORD-4, ORD-1, ORD-2]

        // limit / skip：分頁
        System.out.println(orders.stream().skip(1).limit(2).map(Order::id).toList());
        // [ORD-2, ORD-3]

        // 【Java 9+】takeWhile / dropWhile：依條件截斷（假設已排序）
        List<Integer> nums = List.of(1, 3, 5, 8, 9, 2, 11);
        System.out.println(nums.stream().takeWhile(n -> n < 8).toList());    // [1, 3, 5]
        System.out.println(nums.stream().dropWhile(n -> n < 8).toList());    // [8, 9, 2, 11]
        // 注意：takeWhile 遇到第一個不符就停（和 filter 不同！filter 會檢查全部）
        System.out.println(nums.stream().filter(n -> n < 8).toList());       // [1, 3, 5, 2]

        // peek：只用來除錯
        System.out.println(orders.stream()
                .peek(o -> System.out.println("  處理中: " + o.id()))
                .filter(o -> o.amountCents() > 100000)
                .map(Order::id).toList());

        // mapMulti【Java 16+】：flatMap 的低配版，避免建立中間 Stream，效能較好
        System.out.println(Stream.of("a,b", "c,d,e")
                .<String>mapMulti((s, consumer) -> {
                    for (String part : s.split(",")) consumer.accept(part);
                })
                .toList());                                    // [a, b, c, d, e]
    }
}
```

### `flatMap` 的三個實務場景

```java
import java.util.List;
import java.util.Map;
import java.util.Optional;

public class FlatMapUseCases {

    record OrderItem(String sku, int quantity, long unitPriceCents) { }
    record Order(String id, List<OrderItem> items) { }

    public static void main(String[] args) {
        List<Order> orders = List.of(
                new Order("ORD-1", List.of(
                        new OrderItem("SKU-A", 2, 1000),
                        new OrderItem("SKU-B", 1, 2500))),
                new Order("ORD-2", List.of(
                        new OrderItem("SKU-A", 3, 1000))),
                new Order("ORD-3", List.of()));

        // ① 攤平巢狀集合：所有訂單的所有明細
        List<OrderItem> allItems = orders.stream()
                .flatMap(o -> o.items().stream())
                .toList();
        System.out.println("① 明細筆數: " + allItems.size());        // 3

        // 2*1000 + 1*2500 + 3*1000 = 7500 分 = 75.00 元
        long total = allItems.stream()
                .mapToLong(i -> (long) i.quantity() * i.unitPriceCents())
                .sum();
        System.out.printf("   總金額: %,.2f 元%n", total / 100.0);   // 75.00 元

        // ② 攤平 Map 的值
        Map<String, List<String>> tagsByOrder = Map.of(
                "ORD-1", List.of("急件", "禮品"),
                "ORD-2", List.of("急件"));
        System.out.println("② 所有標籤: " + tagsByOrder.values().stream()
                .flatMap(List::stream).distinct().sorted().toList());

        // ③ 過濾掉 Optional.empty()（Java 8 的經典用法）
        List<Optional<String>> optionals = List.of(
                Optional.of("a"), Optional.empty(), Optional.of("c"));
        System.out.println("③ 有值的: " + optionals.stream()
                .flatMap(Optional::stream)        // Java 9+；Java 8 要用 filter+map
                .toList());                        // [a, c]

        // ④ 字串切分
        List<String> lines = List.of("a,b,c", "d,e");
        System.out.println("④ 所有欄位: " + lines.stream()
                .flatMap(line -> java.util.Arrays.stream(line.split(",")))
                .toList());                        // [a, b, c, d, e]
    }
}
```

### ⚠️ `peek` 不可靠

```java
import java.util.List;
import java.util.stream.Stream;

public class PeekIsUnreliable {
    public static void main(String[] args) {
        // ⚠️ JDK 可能最佳化掉不必要的走訪，導致 peek 完全不執行
        long count = Stream.of("a", "b", "c")
                .peek(s -> System.out.println("peek: " + s))
                .count();                          // JDK 知道 count 不需要走訪元素
        System.out.println("count = " + count);
    }
}
```

在某些 JDK 版本上，這段程式**完全不會印出任何 `peek:`**——因為 `count()` 可以直接從 size 得知答案。

> **`peek` 只能用來除錯，永遠不要用它做有副作用的事。**
> 需要「處理每個元素並繼續」的話，用 `map` 並回傳元素本身。

---

## 6.9 終端操作

```java
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

public class TerminalOperations {

    record Order(String id, long amountCents, String status) { }

    public static void main(String[] args) {
        List<Order> orders = List.of(
                new Order("ORD-1", 29900, "PAID"),
                new Order("ORD-2", 8900, "CREATED"),
                new Order("ORD-3", 159900, "PAID"),
                new Order("ORD-4", 45000, "CANCELLED"));

        // ===== 收集 =====
        System.out.println(orders.stream().map(Order::id).toList());
        // 【Java 16+】toList()：回傳不可變 List，比 collect(Collectors.toList()) 簡潔

        // ===== 計數與聚合 =====
        System.out.println("筆數: " + orders.stream().filter(o -> o.status().equals("PAID")).count());
        System.out.println("總額: " + orders.stream().mapToLong(Order::amountCents).sum());
        System.out.println("平均: " + orders.stream().mapToLong(Order::amountCents).average().orElse(0));

        // ===== 尋找 =====
        Optional<Order> first = orders.stream().filter(o -> o.amountCents() > 100000).findFirst();
        System.out.println("第一筆大單: " + first.map(Order::id).orElse("(無)"));

        // findAny：平行流時可能回傳任意一個（比 findFirst 快，因為不用保證順序）
        System.out.println("任一筆: " + orders.stream().findAny().map(Order::id).orElse(""));

        // max / min
        System.out.println("最大: " + orders.stream()
                .max(Comparator.comparingLong(Order::amountCents))
                .map(Order::id).orElse(""));

        // ===== 比對 =====
        System.out.println("全部 > 1000? " + orders.stream().allMatch(o -> o.amountCents() > 1000));
        System.out.println("有取消的? " + orders.stream().anyMatch(o -> o.status().equals("CANCELLED")));
        System.out.println("沒有退款的? " + orders.stream().noneMatch(o -> o.status().equals("REFUNDED")));

        // ⚠️ 空 Stream 的比對結果（容易搞錯）
        System.out.println("空流 allMatch : " + List.<Order>of().stream().allMatch(o -> false));  // true！
        System.out.println("空流 anyMatch : " + List.<Order>of().stream().anyMatch(o -> true));   // false
        System.out.println("空流 noneMatch: " + List.<Order>of().stream().noneMatch(o -> true));  // true

        // ===== 走訪 =====
        orders.stream().limit(2).forEach(o -> System.out.println("  " + o.id()));

        // forEachOrdered：平行流時保證順序（單一流兩者相同）
        orders.parallelStream().forEachOrdered(o -> System.out.print(o.id() + " "));
        System.out.println();

        // ===== 歸約 =====
        System.out.println("串接 ID: " + orders.stream().map(Order::id)
                .reduce((a, b) -> a + "," + b).orElse(""));
    }
}
```

> ⚠️ **空 Stream 的 `allMatch` 回傳 `true`**（數學上叫「空真」）。
> 實務上這會造成 bug：「所有項目都通過驗證」在「沒有項目」時也成立。
> 需要「至少有一個且全部通過」時要額外檢查 `!list.isEmpty()`。

### `Collectors.toList()` vs `Stream.toList()` vs `toUnmodifiableList()`

```java
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public class ToListVariants {
    public static void main(String[] args) {

        // ① Collectors.toList()：回傳「未指定型別」的可變 List（實務上是 ArrayList，但不保證）
        List<String> a = Stream.of("x", "y").collect(Collectors.toList());
        a.add("z");                                  // ✅ 可以改
        System.out.println("① " + a);

        // ② Collectors.toUnmodifiableList()【Java 10+】：不可變，不允許 null
        List<String> b = Stream.of("x", "y").collect(Collectors.toUnmodifiableList());
        try {
            b.add("z");
        } catch (UnsupportedOperationException e) {
            System.out.println("② 不可變");
        }

        // ③ Stream.toList()【Java 16+】：不可變，但「允許 null 元素」
        List<String> c = Stream.of("x", null, "y").toList();
        System.out.println("③ " + c);                // [x, null, y]
        try {
            c.add("z");
        } catch (UnsupportedOperationException e) {
            System.out.println("③ 不可變");
        }

        // ② 不允許 null
        try {
            Stream.of("x", (String) null).collect(Collectors.toUnmodifiableList());
        } catch (NullPointerException e) {
            System.out.println("② 不允許 null 元素");
        }
    }
}
```

| | 可變 | 允許 null | 何時用 |
|---|---|---|---|
| `Collectors.toList()` | ✅ | ✅ | 需要之後修改結果時 |
| `Collectors.toUnmodifiableList()` | ❌ | ❌ | Java 10~15 且要不可變 |
| `Stream.toList()` | ❌ | ✅ | **Java 16+ 的預設選擇** |

---

## 6.10 `Collectors`：Stream 的真正威力

### 基本收集器

```java
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

public class BasicCollectors {

    record Employee(String name, String dept, int salary) { }

    public static void main(String[] args) {
        List<Employee> employees = List.of(
                new Employee("小明", "工程", 80_000),
                new Employee("小華", "工程", 95_000),
                new Employee("小美", "業務", 70_000),
                new Employee("小強", "業務", 85_000),
                new Employee("小玉", "設計", 75_000));

        // toSet
        Set<String> depts = employees.stream().map(Employee::dept).collect(Collectors.toSet());
        System.out.println("部門: " + new java.util.TreeSet<>(depts));

        // joining
        System.out.println(employees.stream().map(Employee::name)
                .collect(Collectors.joining(", ")));
        // 小明, 小華, 小美, 小強, 小玉

        System.out.println(employees.stream().map(Employee::name)
                .collect(Collectors.joining(", ", "[", "]")));
        // [小明, 小華, 小美, 小強, 小玉]

        // toMap
        Map<String, Integer> salaryByName = employees.stream()
                .collect(Collectors.toMap(Employee::name, Employee::salary));
        System.out.println(new TreeMap<>(salaryByName));

        // ⚠️ toMap 遇到重複 key 會丟例外！
        try {
            employees.stream().collect(Collectors.toMap(Employee::dept, Employee::name));
        } catch (IllegalStateException e) {
            System.out.println("重複 key: " + e.getMessage());
            // Duplicate key 工程 (attempted merging values 小明 and 小華)
        }

        // ✅ 提供合併函式
        Map<String, String> namesByDept = employees.stream()
                .collect(Collectors.toMap(Employee::dept, Employee::name,
                        (existing, replacement) -> existing + "、" + replacement));
        System.out.println(new TreeMap<>(namesByDept));
        // {工程=小明、小華, 業務=小美、小強, 設計=小玉}

        // ✅ 指定 Map 型別（第四個參數）
        Map<String, Integer> sorted = employees.stream()
                .collect(Collectors.toMap(Employee::name, Employee::salary,
                        (a, b) -> a, TreeMap::new));
        System.out.println("TreeMap: " + sorted);

        // ⚠️ toMap 的 value 不可以是 null！
        try {
            List.of("a").stream().collect(Collectors.toMap(s -> s, s -> (String) null));
        } catch (NullPointerException e) {
            System.out.println("toMap 的 value 不可為 null");
        }
    }
}
```

> **`toMap` 的三個坑：重複 key 丟例外、value 不能是 null、預設回傳 `HashMap`（無序）。**
> 從資料庫查出來的資料做 `toMap(Entity::getCode, ...)`，只要有兩筆同 code 就爆——
> 這是實務上很常見的線上錯誤。**永遠提供合併函式。**

### `groupingBy`：本節重點

```java
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.stream.Collectors;

public class GroupingBy {

    record Employee(String name, String dept, String city, int salary) { }

    public static void main(String[] args) {
        List<Employee> employees = List.of(
                new Employee("小明", "工程", "台北", 80_000),
                new Employee("小華", "工程", "台北", 95_000),
                new Employee("小美", "業務", "台中", 70_000),
                new Employee("小強", "業務", "台北", 85_000),
                new Employee("小玉", "設計", "台中", 75_000),
                new Employee("小龍", "工程", "台中", 110_000));

        // ① 最簡單：分組成 List
        Map<String, List<Employee>> byDept = employees.stream()
                .collect(Collectors.groupingBy(Employee::dept));
        byDept.forEach((d, list) -> System.out.println(d + ": " + list.size() + " 人"));

        // ② counting：每組人數
        System.out.println("\n② 每部門人數");
        System.out.println(new TreeMap<>(employees.stream()
                .collect(Collectors.groupingBy(Employee::dept, Collectors.counting()))));
        // {工程=3, 業務=2, 設計=1}

        // ③ summingInt / averagingInt：加總與平均
        System.out.println("\n③ 每部門薪資總額與平均");
        System.out.println(new TreeMap<>(employees.stream()
                .collect(Collectors.groupingBy(Employee::dept,
                        Collectors.summingInt(Employee::salary)))));
        System.out.println(new TreeMap<>(employees.stream()
                .collect(Collectors.groupingBy(Employee::dept,
                        Collectors.averagingInt(Employee::salary)))));

        // ④ mapping：分組後再轉換
        System.out.println("\n④ 每部門的姓名清單");
        System.out.println(new TreeMap<>(employees.stream()
                .collect(Collectors.groupingBy(Employee::dept,
                        Collectors.mapping(Employee::name, Collectors.toList())))));
        // {工程=[小明, 小華, 小龍], 業務=[小美, 小強], 設計=[小玉]}

        // ⑤ maxBy / minBy：每組最高薪
        System.out.println("\n⑤ 每部門最高薪");
        employees.stream()
                .collect(Collectors.groupingBy(Employee::dept,
                        Collectors.maxBy(java.util.Comparator.comparingInt(Employee::salary))))
                .forEach((d, e) -> System.out.println("  " + d + ": "
                        + e.map(Employee::name).orElse("")));

        // ⑥ collectingAndThen：去掉那個煩人的 Optional
        System.out.println("\n⑥ 每部門最高薪（無 Optional）");
        Map<String, String> topByDept = employees.stream()
                .collect(Collectors.groupingBy(Employee::dept,
                        Collectors.collectingAndThen(
                                Collectors.maxBy(java.util.Comparator.comparingInt(Employee::salary)),
                                opt -> opt.map(Employee::name).orElse("(無)"))));
        System.out.println(new TreeMap<>(topByDept));

        // ⑦ 兩層分組
        System.out.println("\n⑦ 部門 → 城市 → 人數");
        Map<String, Map<String, Long>> nested = employees.stream()
                .collect(Collectors.groupingBy(Employee::dept,
                        TreeMap::new,                                  // 指定外層 Map 型別
                        Collectors.groupingBy(Employee::city,
                                TreeMap::new,
                                Collectors.counting())));
        nested.forEach((d, cities) -> System.out.println("  " + d + " → " + cities));

        // ⑧ summarizing：一次拿到 count/sum/min/max/average
        System.out.println("\n⑧ 每部門薪資摘要");
        employees.stream()
                .collect(Collectors.groupingBy(Employee::dept, TreeMap::new,
                        Collectors.summarizingInt(Employee::salary)))
                .forEach((d, stats) -> System.out.printf(
                        "  %-4s 人數=%d 總額=%d 平均=%.0f 最低=%d 最高=%d%n",
                        d, stats.getCount(), stats.getSum(), stats.getAverage(),
                        stats.getMin(), stats.getMax()));

        // ⑨ filtering【Java 9+】：分組後過濾（保留空組）
        System.out.println("\n⑨ 每部門薪資 > 80000 的人（filtering vs 先 filter）");
        System.out.println("  filtering : " + employees.stream()
                .collect(Collectors.groupingBy(Employee::dept, TreeMap::new,
                        Collectors.filtering(e -> e.salary() > 80_000,
                                Collectors.mapping(Employee::name, Collectors.toList())))));
        // {工程=[小華, 小龍], 業務=[小強], 設計=[]}  ← 設計部保留了空清單

        System.out.println("  先 filter : " + employees.stream()
                .filter(e -> e.salary() > 80_000)
                .collect(Collectors.groupingBy(Employee::dept, TreeMap::new,
                        Collectors.mapping(Employee::name, Collectors.toList()))));
        // {工程=[小華, 小龍], 業務=[小強]}  ← 設計部整組消失

        // ⑩ partitioningBy：分成 true / false 兩組（比 groupingBy 快，且保證兩個 key 都存在）
        System.out.println("\n⑩ 高薪 / 一般");
        Map<Boolean, List<String>> partitioned = employees.stream()
                .collect(Collectors.partitioningBy(e -> e.salary() >= 85_000,
                        Collectors.mapping(Employee::name, Collectors.toList())));
        System.out.println("  高薪: " + partitioned.get(true));
        System.out.println("  一般: " + partitioned.get(false));

        // ⑪ teeing【Java 12+】：同時做兩件事再合併
        System.out.println("\n⑪ teeing：一次拿到總額與人數");
        String summary = employees.stream().collect(Collectors.teeing(
                Collectors.summingInt(Employee::salary),
                Collectors.counting(),
                (sum, count) -> "總額 %d，%d 人，平均 %.0f".formatted(sum, count, (double) sum / count)));
        System.out.println("  " + summary);
    }
}
```

輸出（節錄）：

```
② 每部門人數
{工程=3, 業務=2, 設計=1}

⑥ 每部門最高薪（無 Optional）
{工程=小龍, 業務=小強, 設計=小玉}

⑦ 部門 → 城市 → 人數
  工程 → {台中=1, 台北=2}
  業務 → {台中=1, 台北=1}
  設計 → {台中=1}

⑧ 每部門薪資摘要
  工程   人數=3 總額=285000 平均=95000 最低=80000 最高=110000
  業務   人數=2 總額=155000 平均=77500 最低=70000 最高=85000
  設計   人數=1 總額=75000 平均=75000 最低=75000 最高=75000

⑨ 每部門薪資 > 80000 的人（filtering vs 先 filter）
  filtering : {工程=[小華, 小龍], 業務=[小強], 設計=[]}
  先 filter : {工程=[小華, 小龍], 業務=[小強]}

⑪ teeing：一次拿到總額與人數
  總額 510000，6 人，平均 85000
```

> **兩個實務重點：**
>
> 1. **`groupingBy` 預設回傳 `HashMap`（無序）**。報表輸出要穩定，一定要用三參數版指定 `TreeMap::new`
>    或 `LinkedHashMap::new`。「同一份資料每次跑出來的順序不同」是很煩人的問題。
> 2. **`filtering` vs 先 `filter`**：前者保留空組，後者讓空組消失。
>    報表要「每個部門都出現一列（即使是 0）」時，必須用 `filtering`。

---

## 6.11 `reduce` vs `collect`

```java
import java.math.BigDecimal;
import java.util.List;
import java.util.stream.Collectors;

public class ReduceVsCollect {
    public static void main(String[] args) {
        List<Integer> numbers = List.of(1, 2, 3, 4, 5);

        // reduce 的三種形式
        // ① 一參數：回傳 Optional（空流時沒有值）
        System.out.println(numbers.stream().reduce(Integer::sum));             // Optional[15]
        System.out.println(List.<Integer>of().stream().reduce(Integer::sum));  // Optional.empty

        // ② 兩參數：有初始值，回傳 T
        System.out.println(numbers.stream().reduce(0, Integer::sum));          // 15
        System.out.println(numbers.stream().reduce(1, (a, b) -> a * b));       // 120

        // ③ 三參數：可平行化（第三個參數是合併函式）
        System.out.println(numbers.stream().reduce(0, Integer::sum, Integer::sum));

        // 實務案例：BigDecimal 加總（第 01 章 1.5 節）
        List<BigDecimal> prices = List.of(
                new BigDecimal("29.90"), new BigDecimal("8.50"), new BigDecimal("159.00"));
        BigDecimal total = prices.stream().reduce(BigDecimal.ZERO, BigDecimal::add);
        System.out.println("總額: " + total);                                   // 197.40

        // ❌ 不要用 reduce 做字串串接：每一步都建新字串，O(n²)
        String bad = List.of("a", "b", "c", "d").stream().reduce("", String::concat);

        // ✅ 用 collect(joining)：內部用 StringBuilder
        String good = List.of("a", "b", "c", "d").stream().collect(Collectors.joining());
        System.out.println(good);                                               // abcd
    }
}
```

### 判斷原則

| 情況 | 用什麼 |
|---|---|
| 歸約成一個**不可變**的值（數字、`BigDecimal`、`boolean`） | `reduce` |
| 歸約成一個**可變容器**（List、Map、StringBuilder） | `collect` |
| 字串串接 | `Collectors.joining()`（**不要**用 `reduce`） |
| 數字加總 | `mapToLong(...).sum()`（比 `reduce` 更清楚也更快） |

```java
import java.util.List;

public class SumComparison {

    record Order(long amountCents) { }

    public static void main(String[] args) {
        List<Order> orders = List.of(new Order(100), new Order(200), new Order(300));

        // ⚠️ 會裝箱
        long a = orders.stream().map(Order::amountCents).reduce(0L, Long::sum);

        // ✅ 不裝箱，意圖更清楚
        long b = orders.stream().mapToLong(Order::amountCents).sum();

        System.out.println(a + " / " + b);      // 600 / 600
    }
}
```

---

## 6.12 原始型別 Stream

```java
import java.util.List;
import java.util.stream.IntStream;
import java.util.stream.LongStream;

public class PrimitiveStreams {

    record Order(String id, long amountCents) { }

    public static void main(String[] args) {
        List<Order> orders = List.of(
                new Order("ORD-1", 29900),
                new Order("ORD-2", 8900),
                new Order("ORD-3", 159900));

        // mapToLong / mapToInt / mapToDouble：轉成原始型別流
        LongStream amounts = orders.stream().mapToLong(Order::amountCents);
        System.out.println("總額: " + amounts.sum());

        // summaryStatistics：一次拿全部統計值
        var stats = orders.stream().mapToLong(Order::amountCents).summaryStatistics();
        System.out.printf("筆數=%d 總額=%d 平均=%.2f 最小=%d 最大=%d%n",
                stats.getCount(), stats.getSum(), stats.getAverage(),
                stats.getMin(), stats.getMax());

        // average / max / min 回傳 Optional（因為空流沒有答案）
        System.out.println(orders.stream().mapToLong(Order::amountCents).average().orElse(0));
        System.out.println(orders.stream().mapToLong(Order::amountCents).max().orElse(0));

        // boxed：轉回物件流
        List<Long> boxed = orders.stream().mapToLong(Order::amountCents).boxed().toList();
        System.out.println(boxed);

        // IntStream.range：取代傳統 for 迴圈
        System.out.println(IntStream.rangeClosed(1, 5).map(n -> n * n).boxed().toList());
        // [1, 4, 9, 16, 25]

        // 帶索引走訪（Stream 沒有內建的 zipWithIndex）
        List<String> names = List.of("a", "b", "c");
        IntStream.range(0, names.size())
                .mapToObj(i -> (i + 1) + ". " + names.get(i))
                .forEach(System.out::println);
        // 1. a
        // 2. b
        // 3. c
    }
}
```

---

## 6.13 實務案例：訂單報表

把第 05 章練習 2 的「集合版」統計，改寫成 Stream 版來對比。

```java
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

public class OrderReport {

    enum Status { CREATED, PAID, SHIPPED, DELIVERED, CANCELLED }

    record OrderItem(String sku, String category, int quantity, long unitPriceCents) {
        long subtotalCents() { return (long) quantity * unitPriceCents; }
    }

    record Order(String id, String userId, Status status,
                 LocalDateTime createdAt, List<OrderItem> items) {

        long totalCents() {
            return items.stream().mapToLong(OrderItem::subtotalCents).sum();
        }

        /** 是否計入營收 */
        boolean countsAsRevenue() {
            return status == Status.PAID || status == Status.SHIPPED || status == Status.DELIVERED;
        }
    }

    private final List<Order> orders;

    OrderReport(List<Order> orders) {
        this.orders = List.copyOf(orders);
    }

    /** ① 每個使用者的總金額（對照第 05 章：4 行 → 1 行） */
    Map<String, Long> totalByUser() {
        return orders.stream().collect(Collectors.groupingBy(
                Order::userId, TreeMap::new, Collectors.summingLong(Order::totalCents)));
    }

    /** ② 每個狀態的訂單數（EnumMap 保持 enum 順序） */
    Map<Status, Long> countByStatus() {
        return orders.stream().collect(Collectors.groupingBy(
                Order::status, () -> new EnumMap<>(Status.class), Collectors.counting()));
    }

    /** ③ 金額最高的前 N 筆 */
    List<Order> topByAmount(int limit) {
        return orders.stream()
                .sorted(Comparator.comparingLong(Order::totalCents).reversed()
                        .thenComparing(Order::id))       // tie-breaker：確保分頁穩定
                .limit(limit)
                .toList();
    }

    /** ④ 每天營收（只算已付款以後） */
    Map<LocalDate, Long> revenueByDate() {
        return orders.stream()
                .filter(Order::countsAsRevenue)
                .collect(Collectors.groupingBy(
                        o -> o.createdAt().toLocalDate(),
                        TreeMap::new,
                        Collectors.summingLong(Order::totalCents)));
    }

    /** ⑤ 有下單的使用者（去重 + 排序） */
    Set<String> activeUsers() {
        return orders.stream().map(Order::userId)
                .collect(Collectors.toCollection(java.util.TreeSet::new));
    }

    /** ⑥ 各分類的銷售額（需要 flatMap 攤平明細） */
    Map<String, Long> revenueByCategory() {
        return orders.stream()
                .filter(Order::countsAsRevenue)
                .flatMap(o -> o.items().stream())
                .collect(Collectors.groupingBy(
                        OrderItem::category, TreeMap::new,
                        Collectors.summingLong(OrderItem::subtotalCents)));
    }

    /** ⑦ 熱銷商品 Top N（依銷售數量），依數量降序輸出 */
    Map<String, Integer> topSellingSkus(int limit) {
        return orders.stream()
                .filter(Order::countsAsRevenue)
                .flatMap(o -> o.items().stream())
                .collect(Collectors.groupingBy(OrderItem::sku,
                        Collectors.summingInt(OrderItem::quantity)))
                .entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed()
                        .thenComparing(Map.Entry.comparingByKey()))
                .limit(limit)
                // LinkedHashMap 才能保留上面的排序結果！用 HashMap 就白排了
                .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue,
                        (a, b) -> a, LinkedHashMap::new));
    }

    /** ⑧ 每個使用者的訂單摘要：筆數 + 總額 + 最大單筆 */
    record UserSummary(long count, long totalCents, long maxCents) {
        @Override
        public String toString() {
            return "%d 筆，總額 %,.2f，最大單筆 %,.2f"
                    .formatted(count, totalCents / 100.0, maxCents / 100.0);
        }
    }

    Map<String, UserSummary> userSummaries() {
        return orders.stream().collect(Collectors.groupingBy(
                Order::userId, TreeMap::new,
                Collectors.collectingAndThen(Collectors.toList(), list -> new UserSummary(
                        list.size(),
                        list.stream().mapToLong(Order::totalCents).sum(),
                        list.stream().mapToLong(Order::totalCents).max().orElse(0)))));
    }

    /** ⑨ 狀態 → 使用者 → 筆數（兩層分組） */
    Map<Status, Map<String, Long>> countByStatusAndUser() {
        return orders.stream().collect(Collectors.groupingBy(
                Order::status, () -> new EnumMap<>(Status.class),
                Collectors.groupingBy(Order::userId, TreeMap::new, Collectors.counting())));
    }

    /** ⑩ 一次拿到「營收訂單」與「非營收訂單」的統計 */
    record RevenueSplit(long revenueCents, long lostCents) { }

    RevenueSplit revenueSplit() {
        return orders.stream().collect(Collectors.teeing(
                Collectors.filtering(Order::countsAsRevenue,
                        Collectors.summingLong(Order::totalCents)),
                Collectors.filtering(o -> !o.countsAsRevenue(),
                        Collectors.summingLong(Order::totalCents)),
                RevenueSplit::new));
    }

    static String money(long cents) { return "%,.2f".formatted(cents / 100.0); }

    // ===== 執行 =====

    public static void main(String[] args) {
        LocalDateTime base = LocalDateTime.of(2026, 8, 15, 10, 0);

        var report = new OrderReport(List.of(
                new Order("ORD-001", "u001", Status.DELIVERED, base, List.of(
                        new OrderItem("SKU-KB01", "鍵盤", 1, 2990_0),
                        new OrderItem("SKU-MS01", "滑鼠", 2, 890_0))),
                new Order("ORD-002", "u002", Status.PAID, base.plusHours(3), List.of(
                        new OrderItem("SKU-MN01", "螢幕", 1, 8990_0))),
                new Order("ORD-003", "u001", Status.SHIPPED, base.plusDays(1), List.of(
                        new OrderItem("SKU-KB01", "鍵盤", 2, 2990_0))),
                new Order("ORD-004", "u003", Status.CANCELLED, base.plusDays(1), List.of(
                        new OrderItem("SKU-MN01", "螢幕", 5, 8990_0))),
                new Order("ORD-005", "u002", Status.DELIVERED, base.plusDays(1), List.of(
                        new OrderItem("SKU-MS01", "滑鼠", 3, 890_0),
                        new OrderItem("SKU-HP01", "耳機", 1, 1590_0))),
                new Order("ORD-006", "u001", Status.CREATED, base.plusDays(2), List.of(
                        new OrderItem("SKU-KB01", "鍵盤", 1, 2990_0))),
                new Order("ORD-007", "u004", Status.PAID, base.plusDays(2), List.of(
                        new OrderItem("SKU-HP01", "耳機", 2, 1590_0)))));

        System.out.println("① 每使用者總金額");
        report.totalByUser().forEach((u, amt) -> System.out.printf("   %s  %12s%n", u, money(amt)));

        System.out.println("\n② 每狀態訂單數");
        report.countByStatus().forEach((s, c) -> System.out.printf("   %-10s %d%n", s, c));

        System.out.println("\n③ 金額最高前 3 筆");
        report.topByAmount(3).forEach(o -> System.out.printf("   %s  %s  %12s%n",
                o.id(), o.userId(), money(o.totalCents())));

        System.out.println("\n④ 每日營收");
        report.revenueByDate().forEach((d, amt) -> System.out.printf("   %s  %12s%n", d, money(amt)));

        System.out.println("\n⑤ 活躍使用者: " + report.activeUsers());

        System.out.println("\n⑥ 各分類銷售額");
        report.revenueByCategory().forEach((c, amt) -> System.out.printf("   %-4s %12s%n", c, money(amt)));

        System.out.println("\n⑦ 熱銷 SKU Top 3");
        report.topSellingSkus(3).forEach((sku, qty) -> System.out.printf("   %-10s %d 件%n", sku, qty));

        System.out.println("\n⑧ 使用者摘要");
        report.userSummaries().forEach((u, s) -> System.out.printf("   %s  %s%n", u, s));

        System.out.println("\n⑨ 狀態 → 使用者 → 筆數");
        report.countByStatusAndUser().forEach((s, m) -> System.out.printf("   %-10s %s%n", s, m));

        var split = report.revenueSplit();
        System.out.printf("%n⑩ 已實現營收 %s / 流失（未付款+取消）%s%n",
                money(split.revenueCents()), money(split.lostCents()));
    }
}
```

輸出：

```
① 每使用者總金額
   u001       1,374.00
   u002       1,325.00
   u003       4,495.00
   u004         318.00

② 每狀態訂單數
   CREATED    1
   PAID       2
   SHIPPED    1
   DELIVERED  2
   CANCELLED  1

③ 金額最高前 3 筆
   ORD-004  u003      4,495.00
   ORD-002  u002        899.00
   ORD-003  u001        598.00

④ 每日營收
   2026-08-15       1,376.00
   2026-08-16       1,024.00
   2026-08-17         318.00

⑤ 活躍使用者: [u001, u002, u003, u004]

⑥ 各分類銷售額
   滑鼠         445.00
   耳機         477.00
   螢幕         899.00
   鍵盤         897.00

⑦ 熱銷 SKU Top 3
   SKU-MS01   5 件
   SKU-HP01   3 件
   SKU-KB01   3 件

⑧ 使用者摘要
   u001  3 筆，總額 1,374.00，最大單筆 598.00
   u002  2 筆，總額 1,325.00，最大單筆 899.00
   u003  1 筆，總額 4,495.00，最大單筆 4,495.00
   u004  1 筆，總額 318.00，最大單筆 318.00

⑨ 狀態 → 使用者 → 筆數
   CREATED    {u001=1}
   PAID       {u002=1, u004=1}
   SHIPPED    {u001=1}
   DELIVERED  {u001=1, u002=1}
   CANCELLED  {u003=1}

⑩ 已實現營收 2,718.00 / 流失（未付款+取消）4,794.00
```

> **對照一下算式，確認你讀懂了每個統計：**
>
> - `2990_0` 是 `29900`（分）＝ 299 元。底線只是分隔符（第 01 章 1.3 節）。
> - `ORD-001` = 鍵盤 1×29900 + 滑鼠 2×8900 = 47700 分 = 477.00 元。
> - ① `u001` = ORD-001 (477) + ORD-003 (598) + ORD-006 (299) = **1,374.00**（不分狀態，全算）。
> - ④ `2026-08-15` 只有 ORD-001（DELIVERED）與 ORD-002（PAID，`base+3h` 仍是同一天）
>   = 477 + 899 = **1,376.00**。
> - ⑥ 注意 `螢幕 899.00 > 鍵盤 897.00`，但 `TreeMap` 是**依 key 排序**不是依值——
>   所以順序是 `滑鼠 → 耳機 → 螢幕 → 鍵盤`（UTF-16 碼元序，見第 05 章 5.15 節的提醒）。
> - ⑩ 已實現 2,718 + 流失 4,794 = 7,512 = ①的四個使用者總和（1374+1325+4495+318）。
>   `teeing` 把一份資料同時餵給兩個收集器，只走訪一次。

### 對照第 05 章的集合版

| 統計 | 集合版行數 | Stream 版行數 |
|---|---|---|
| 每使用者總金額 | 6 | 2 |
| 每狀態訂單數 | 6 | 2 |
| Top N | 5 | 5 |
| 每日營收 | 8 | 6 |
| 各分類銷售額 | 需要巢狀 for | 6 |
| 兩層分組 | 需要巢狀 Map 手動 computeIfAbsent | 3 |

**Stream 的價值在「宣告式」**：程式碼描述「要什麼」，而不是「怎麼一步步做」。
但注意 `topSellingSkus` 那個方法——它有 9 行且用了兩次 collect。
**那已經接近可讀性的極限**，再複雜就該拆方法或改回 for 迴圈（6.16 節）。

> ⚠️ **注意 `topSellingSkus` 最後的 `LinkedHashMap::new`。** 少了它，`toMap` 預設回傳 `HashMap`，
> 前面辛苦排序的結果會被打散。「明明 sorted 了為什麼順序還是亂的」是常見的困惑，答案就在這裡。

---

## 6.14 `Optional`

### `Optional` 是為了什麼存在

```java
import java.util.Map;
import java.util.Optional;

public class WhyOptional {

    record User(String id, String email) { }

    static final Map<String, User> DB = Map.of("u001", new User("u001", "a@example.com"));

    // ❌ 回傳 null：呼叫方不知道要檢查，直到 NPE 才發現
    static User findByIdBad(String id) {
        return DB.get(id);
    }

    // ✅ 回傳 Optional：型別本身就在說「可能沒有」
    static Optional<User> findById(String id) {
        return Optional.ofNullable(DB.get(id));
    }

    public static void main(String[] args) {
        // 呼叫方被型別提醒必須處理「沒有」的情況
        String email = findById("u999")
                .map(User::email)
                .orElse("(未設定)");
        System.out.println(email);          // (未設定)

        // 對照：回傳 null 的版本
        // String bad = findByIdBad("u999").email();     // 💥 NPE
    }
}
```

### 建立與取值

```java
import java.util.NoSuchElementException;
import java.util.Optional;

public class OptionalBasics {
    public static void main(String[] args) {

        // ===== 建立 =====
        Optional<String> a = Optional.of("value");            // 不允許 null
        Optional<String> b = Optional.ofNullable(null);       // 允許 null → empty
        Optional<String> c = Optional.empty();

        try {
            Optional.of(null);
        } catch (NullPointerException e) {
            System.out.println("Optional.of 不接受 null");
        }

        // ===== 取值 =====
        System.out.println(a.orElse("預設"));                  // value
        System.out.println(b.orElse("預設"));                  // 預設
        System.out.println(b.orElseGet(() -> "延遲計算"));      // 延遲計算

        try {
            b.orElseThrow();
        } catch (NoSuchElementException e) {
            System.out.println("orElseThrow: " + e.getMessage());
        }

        try {
            b.orElseThrow(() -> new IllegalStateException("找不到使用者"));
        } catch (IllegalStateException e) {
            System.out.println("自訂例外: " + e.getMessage());
        }

        // ❌ get() 已被視為設計錯誤：名字看不出會丟例外
        // Java 10+ 用 orElseThrow() 取代，語意清楚
        // System.out.println(b.get());     // NoSuchElementException

        // ===== 判斷 =====
        System.out.println(a.isPresent());                     // true
        System.out.println(a.isEmpty());                       // false【Java 11+】

        // ===== 消費 =====
        a.ifPresent(v -> System.out.println("有值: " + v));
        b.ifPresentOrElse(                                      // 【Java 9+】
                v -> System.out.println("有值: " + v),
                () -> System.out.println("沒有值"));
    }
}
```

### ⚠️ `orElse` vs `orElseGet`：最重要的差別

```java
import java.util.Optional;

public class OrElseVsOrElseGet {

    static String expensiveDefault() {
        System.out.println("  ⚠️ 執行了昂貴的計算（查資料庫 / 呼叫 API）");
        return "default";
    }

    public static void main(String[] args) {
        Optional<String> hasValue = Optional.of("actual");

        System.out.println("=== orElse：不管有沒有值，都會先算出參數 ===");
        System.out.println("結果: " + hasValue.orElse(expensiveDefault()));

        System.out.println("\n=== orElseGet：只在空的時候才呼叫 ===");
        System.out.println("結果: " + hasValue.orElseGet(OrElseVsOrElseGet::expensiveDefault));
    }
}
```

輸出：

```
=== orElse：不管有沒有值，都會先算出參數 ===
  ⚠️ 執行了昂貴的計算（查資料庫 / 呼叫 API）
結果: actual

=== orElseGet：只在空的時候才呼叫 ===
結果: actual
```

**`orElse` 的參數是「值」，會被立即求值。`orElseGet` 的參數是 `Supplier`，只在需要時才執行。**

**實務災難：**

```java
// ❌ 每次都查資料庫，就算快取有值
return cache.get(key).orElse(database.findById(key));

// ✅ 只在快取沒有時才查
return cache.get(key).orElseGet(() -> database.findById(key));

// ❌ 每次都建立一個新物件（GC 壓力）
return maybeConfig.orElse(new DefaultConfig());

// ✅
return maybeConfig.orElseGet(DefaultConfig::new);
```

> **規則：參數如果是「已經算好的常數」用 `orElse`；如果需要「計算 / IO / new 物件」用 `orElseGet`。**

### 鏈式操作

```java
import java.util.List;
import java.util.Map;
import java.util.Optional;

public class OptionalChaining {

    record Address(String city, String zipCode) { }
    record Company(String name, Address address) { }
    record User(String id, String email, Company company) { }

    static final Map<String, User> DB = Map.of(
            "u001", new User("u001", "a@example.com",
                    new Company("Acme", new Address("台北", "110"))),
            "u002", new User("u002", "b@example.com",
                    new Company("Beta", null)),               // 沒有地址
            "u003", new User("u003", "c@example.com", null)); // 沒有公司

    static Optional<User> findUser(String id) {
        return Optional.ofNullable(DB.get(id));
    }

    /** ❌ 傳統寫法：巢狀 null 檢查 */
    static String getCityBad(String userId) {
        User user = DB.get(userId);
        if (user != null) {
            Company company = user.company();
            if (company != null) {
                Address address = company.address();
                if (address != null) {
                    return address.city();
                }
            }
        }
        return "未知";
    }

    /** ✅ Optional 鏈式：一路 map，任一環是 empty 就整條 empty */
    static String getCity(String userId) {
        return findUser(userId)
                .map(User::company)          // map 會自動把 null 變 empty
                .map(Company::address)
                .map(Address::city)
                .orElse("未知");
    }

    public static void main(String[] args) {
        System.out.println(getCity("u001"));      // 台北
        System.out.println(getCity("u002"));      // 未知（沒有地址）
        System.out.println(getCity("u003"));      // 未知（沒有公司）
        System.out.println(getCity("u999"));      // 未知（沒有使用者）

        // filter：不符條件就變 empty
        System.out.println(findUser("u001")
                .filter(u -> u.email().endsWith(".com"))
                .map(User::id).orElse("(不符)"));                 // u001

        System.out.println(findUser("u001")
                .filter(u -> u.email().endsWith(".org"))
                .map(User::id).orElse("(不符)"));                 // (不符)

        // flatMap：當 mapper 本身回傳 Optional 時用（避免 Optional<Optional<T>>）
        System.out.println(findUser("u001")
                .flatMap(u -> findUser(u.id()))                    // 回傳 Optional
                .map(User::email).orElse(""));                     // a@example.com

        // or【Java 9+】：備援 Optional
        System.out.println(findUser("u999")
                .or(() -> findUser("u001"))
                .map(User::id).orElse(""));                        // u001

        // stream【Java 9+】：在 Stream 中過濾掉 empty（6.8 節提過）
        List<String> cities = List.of("u001", "u002", "u999").stream()
                .map(OptionalChaining::findUser)
                .flatMap(Optional::stream)
                .map(User::email)
                .toList();
        System.out.println(cities);                                 // [a@example.com, b@example.com]
    }
}
```

### `Optional` 的正確與錯誤用法

```java
import java.util.List;
import java.util.Map;
import java.util.Optional;

public class OptionalDosAndDonts {

    record User(String id, String nickname) { }

    // ===== ❌ 不該做的 =====

    // ① 不要當欄位（不可序列化、增加記憶體、Jackson / JPA 都不友善）
    static class BadUser {
        // private Optional<String> nickname;      // ❌
        private String nickname;                    // ✅ 可為 null，getter 回傳 Optional
        Optional<String> getNickname() { return Optional.ofNullable(nickname); }
    }

    // ② 不要當方法參數（呼叫方要寫 Optional.of(x)，很吵）
    // void process(Optional<String> name) { }      // ❌
    void process(String name) { }                    // ✅ 需要「可選」就用重載或預設值

    // ③ 不要回傳 Optional 的集合（空集合就夠了）
    // Optional<List<User>> findAll() { }            // ❌
    List<User> findAll() { return List.of(); }       // ✅ 空 List 已經表達「沒有」

    // ④ 不要用 isPresent + get（這只是把 null 檢查換個寫法）
    String badStyle(Optional<User> user) {
        if (user.isPresent()) {                      // ❌
            return user.get().id();
        }
        return "unknown";
    }

    String goodStyle(Optional<User> user) {
        return user.map(User::id).orElse("unknown"); // ✅
    }

    // ⑤ 不要 Optional.of(可能是 null 的東西)
    Optional<String> bad(Map<String, String> map, String key) {
        // return Optional.of(map.get(key));         // ❌ 可能 NPE
        return Optional.ofNullable(map.get(key));    // ✅
    }

    // ===== ✅ 該做的 =====

    // ⑥ 回傳型別：表達「可能查不到」
    Optional<User> findById(String id) {
        return Optional.ofNullable(Map.of("u001", new User("u001", "小明")).get(id));
    }

    // ⑦ 搭配 orElseThrow 提供「一定要有」的版本（第 04 章 4.13 節）
    User getById(String id) {
        return findById(id).orElseThrow(
                () -> new IllegalArgumentException("找不到使用者: " + id));
    }

    public static void main(String[] args) {
        var demo = new OptionalDosAndDonts();
        System.out.println(demo.findById("u001").map(User::nickname).orElse("(無暱稱)"));
        System.out.println(demo.findById("u999").map(User::nickname).orElse("(無暱稱)"));
        System.out.println(demo.getById("u001").id());

        try {
            demo.getById("u999");
        } catch (IllegalArgumentException e) {
            System.out.println(e.getMessage());
        }
    }
}
```

**`Optional` 的設計原意**（Brian Goetz，Java 語言架構師的說法）：

> `Optional` 是為了「**方法回傳型別**」而設計的，用來表達「可能沒有結果」。
> 它不是為了取代所有的 `null`。

| 位置 | 用 `Optional`？ |
|---|---|
| 方法回傳型別 | ✅ 這是它的用途 |
| 方法參數 | ❌ 用重載或預設值 |
| 欄位 | ❌ 用可為 null 的欄位 + getter 回傳 Optional |
| 集合的元素 | ❌ `List<Optional<T>>` 幾乎總是設計錯誤 |
| 回傳集合時 | ❌ 空集合就是「沒有」 |

---

## 6.15 平行流：四個陷阱

```java
import java.util.List;
import java.util.stream.IntStream;

public class ParallelBasics {
    public static void main(String[] args) {
        // 語法上只要加 .parallel() 或用 parallelStream()
        long sum = IntStream.rangeClosed(1, 10_000_000).parallel().mapToLong(i -> i).sum();
        System.out.println(sum);

        System.out.println("可用核心數: " + Runtime.getRuntime().availableProcessors());
        System.out.println("預設平行度: " + java.util.concurrent.ForkJoinPool.getCommonPoolParallelism());
    }
}
```

### 陷阱 1：共用同一個 ForkJoinPool

```java
import java.util.List;
import java.util.stream.IntStream;

public class ParallelSharedPool {
    public static void main(String[] args) throws InterruptedException {
        // 所有平行流共用 ForkJoinPool.commonPool()
        // 一個慢的平行流會拖住整個應用程式的所有平行流

        Thread hog = new Thread(() -> {
            System.out.println("開始一個很慢的平行流");
            IntStream.range(0, 8).parallel().forEach(i -> {
                try {
                    Thread.sleep(1000);          // 模擬阻塞 IO
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            System.out.println("慢的平行流結束");
        });
        hog.start();

        Thread.sleep(100);

        long start = System.currentTimeMillis();
        List<Integer> result = IntStream.range(0, 4).parallel().boxed().toList();
        System.out.println("另一個平行流耗時: " + (System.currentTimeMillis() - start)
                + " ms（被拖累了）");

        hog.join();
    }
}
```

> **這是實務上最大的地雷。** 在 Web 應用裡，如果某支 API 用平行流做阻塞 IO（呼叫外部服務、查資料庫），
> 它會佔滿 common pool，導致**所有其他用平行流的地方一起變慢**。
>
> **規則：平行流只能用在「純 CPU 運算」，絕對不要包含阻塞 IO。**

### 陷阱 2：有狀態的 Lambda

```java
import java.util.ArrayList;
import java.util.List;
import java.util.stream.IntStream;

public class ParallelStatefulLambda {
    public static void main(String[] args) {

        // ❌ 往非執行緒安全的集合寫入
        List<Integer> unsafe = new ArrayList<>();
        IntStream.range(0, 10_000).parallel().forEach(unsafe::add);
        System.out.println("ArrayList 結果筆數: " + unsafe.size() + "（期望 10000）");
        // 可能是 9987、可能丟 ArrayIndexOutOfBoundsException、可能有 null

        // ✅ 用 collect / toList，它們有正確的平行合併邏輯
        List<Integer> safe = IntStream.range(0, 10_000).parallel().boxed().toList();
        System.out.println("toList 結果筆數: " + safe.size());        // 10000
    }
}
```

多跑幾次會看到不同的結果——這是最難查的一種 bug（不穩定重現）。

### 陷阱 3：順序不保證

```java
import java.util.stream.IntStream;

public class ParallelOrdering {
    public static void main(String[] args) {
        System.out.print("循序 forEach     : ");
        IntStream.range(0, 10).forEach(i -> System.out.print(i + " "));

        System.out.print("\n平行 forEach     : ");
        IntStream.range(0, 10).parallel().forEach(i -> System.out.print(i + " "));

        System.out.print("\n平行 forEachOrdered: ");
        IntStream.range(0, 10).parallel().forEachOrdered(i -> System.out.print(i + " "));

        // collect 到 List 仍保證順序（因為 List 是有序集合）
        System.out.println("\n平行 toList      : "
                + IntStream.range(0, 10).parallel().boxed().toList());
    }
}
```

輸出（平行的順序每次不同）：

```
循序 forEach     : 0 1 2 3 4 5 6 7 8 9
平行 forEach     : 6 7 5 8 9 2 3 0 1 4
平行 forEachOrdered: 0 1 2 3 4 5 6 7 8 9
平行 toList      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
```

> `forEachOrdered` 保證順序，但**失去了大部分平行的好處**（要等前面的做完）。

### 陷阱 4：平行常常比循序慢

```java
import java.util.List;
import java.util.stream.IntStream;

public class ParallelIsOftenSlower {

    public static void main(String[] args) {
        // 暖機
        for (int i = 0; i < 5; i++) { small(false); small(true); }

        System.out.println("=== 小資料量（1000 筆簡單運算）===");
        System.out.println("循序: " + small(false) + " ns");
        System.out.println("平行: " + small(true) + " ns  ← 平行的排程成本遠大於運算");

        System.out.println("\n=== 大資料量 + CPU 密集 ===");
        System.out.println("循序: " + heavy(false) + " ms");
        System.out.println("平行: " + heavy(true) + " ms  ← 這種情況才划算");
    }

    static long small(boolean parallel) {
        List<Integer> data = IntStream.range(0, 1000).boxed().toList();
        long start = System.nanoTime();
        var stream = parallel ? data.parallelStream() : data.stream();
        stream.map(n -> n * 2).toList();
        return System.nanoTime() - start;
    }

    static long heavy(boolean parallel) {
        long start = System.currentTimeMillis();
        var stream = IntStream.rangeClosed(1, 5_000_000);
        if (parallel) stream = stream.parallel();
        stream.mapToDouble(n -> Math.sqrt(n) * Math.log(n + 1)).sum();
        return System.currentTimeMillis() - start;
    }
}
```

典型結果：

```
=== 小資料量（1000 筆簡單運算）===
循序: 45000 ns
平行: 380000 ns  ← 慢了 8 倍

=== 大資料量 + CPU 密集 ===
循序: 180 ms
平行: 42 ms  ← 這種情況才划算
```

### 什麼時候才該用平行流

**全部條件都滿足才考慮：**

1. 資料量**很大**（至少數萬筆，最好數十萬以上）。
2. 每個元素的運算**很重**（純 CPU：加密、壓縮、數學運算、影像處理）。
3. **沒有任何阻塞 IO**（不查資料庫、不呼叫 HTTP、不讀檔）。
4. 資料來源**容易切分**（`ArrayList` / 陣列 / `IntStream.range` 好切；`LinkedList` / `Iterator` 難切）。
5. 操作**無狀態、無副作用**。
6. 你**實際量測過**，確認變快了。

> **在 Web 應用裡的實務結論：幾乎永遠不要用平行流。**
> 因為伺服器本身已經用多執行緒處理多個請求，CPU 已經被充分利用了。
> 單一請求內再平行化，只是在搶自己的資源，還會污染 common pool。
>
> 需要真正的併發控制時，用 `ExecutorService` 或 Java 21 的虛擬執行緒（第 08 章）——
> 它們讓你**控制自己的執行緒池**，不會影響別人。

---

## 6.16 Stream 什麼時候不該用

```java
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

public class WhenNotToUseStream {

    record Order(String id, String userId, long amountCents) { }

    interface UserRepository { String findNameById(String id); }

    public static void main(String[] args) {
        List<Order> orders = List.of(
                new Order("ORD-1", "u001", 1000),
                new Order("ORD-2", "u002", 2000));

        // ===== ① 需要提前結束（break）=====

        // ❌ Stream 沒有 break。用 anyMatch / findFirst 勉強可以，
        //    但如果還要做副作用就很勉強
        // ✅ 用 for 迴圈
        Order found = null;
        for (Order o : orders) {
            if (o.amountCents() > 1500) {
                System.out.println("找到大單，停止掃描");
                found = o;
                break;
            }
        }

        // ===== ② 需要修改外部狀態 =====

        // ❌ 有狀態的 Stream（6.5 節）
        // ✅ for 迴圈很自然
        long runningTotal = 0;
        List<String> auditLog = new ArrayList<>();
        for (Order o : orders) {
            runningTotal += o.amountCents();
            auditLog.add("%s 累計 %d".formatted(o.id(), runningTotal));
        }
        System.out.println(auditLog);

        // ===== ③ 需要處理 checked 例外 =====

        // ❌ Stream 裡的 checked 例外很痛（第 04 章 4.5 節）
        // ✅ for 迴圈可以直接 throws

        // ===== ④ 需要索引 =====

        // ⚠️ Stream 要用 IntStream.range 繞
        // ✅ 傳統 for 更直接
        for (int i = 0; i < orders.size(); i++) {
            System.out.println((i + 1) + ". " + orders.get(i).id());
        }

        // ===== ⑤ 一行太長，可讀性崩壞 =====

        // ❌ 這種東西沒有人想維護
        // Map<String, Map<Boolean, List<String>>> nightmare = orders.stream()
        //     .collect(groupingBy(Order::userId, groupingBy(o -> o.amountCents() > 1500,
        //         mapping(o -> o.id().substring(4) + ":" + o.amountCents() / 100,
        //             collectingAndThen(toList(), l -> { Collections.sort(l); return l; })))));

        // ✅ 拆成有名字的步驟
        Map<String, List<Order>> byUser = orders.stream()
                .collect(Collectors.groupingBy(Order::userId));
        System.out.println(byUser.keySet());

        // ===== ⑥ Stream 裡呼叫資料庫（N+1 問題）=====

        // ❌ 這是實務上最嚴重的效能問題之一
        // orders.stream().map(o -> userRepository.findNameById(o.userId())).toList();
        // 100 筆訂單 = 100 次資料庫查詢

        // ✅ 先批次查詢，再在記憶體中對應
        // Set<String> userIds = orders.stream().map(Order::userId).collect(toSet());
        // Map<String, String> names = userRepository.findNamesByIds(userIds);   // 1 次查詢
        // orders.stream().map(o -> names.get(o.userId())).toList();
    }
}
```

### 判斷原則

| 用 Stream | 用 for 迴圈 |
|---|---|
| 資料轉換、篩選、分組、聚合 | 需要 `break` / `continue` |
| 管線邏輯清楚，每一步都有名字 | 需要修改外部變數（累計、狀態機） |
| 不需要索引 | 需要索引或前後元素比較 |
| 沒有 checked 例外 | 有 checked 例外 |
| 3～5 個操作以內 | 邏輯複雜、要分支 |

> **最重要的判準：哪個版本讓下一個讀 code 的人更快理解？**
> Stream 不是「更高級」，它只是另一種工具。第 05 章那個 `for (Todo t : todos) { ... }`
> 有時候比 Stream 更清楚。

**特別強調第 ⑥ 點**：Stream 裡的每個 lambda 看起來是「一個操作」，
很容易忘記它可能包含一次資料庫查詢或 HTTP 呼叫。
`orders.stream().map(o -> service.enrich(o))` 讀起來優雅，執行起來是 N 次遠端呼叫。
**這是第 08 站（JPA N+1 問題）的主要成因之一。**

---

## 6.17 練習專案：Todo 統計改用 Stream

把第 05 章的 `TodoStatistics` 重寫。

### `TodoStatistics.java`

```java
package com.example.todo.service;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;

import java.time.LocalDate;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.stream.Collectors;

public class TodoStatistics {

    private final List<Todo> todos;

    public TodoStatistics(List<Todo> todos) {
        this.todos = List.copyOf(todos);
    }

    /** 對照第 05 章：6 行 → 2 行 */
    public Map<Priority, Long> countByPriority() {
        return todos.stream().collect(Collectors.groupingBy(
                Todo::priority, () -> new EnumMap<>(Priority.class), Collectors.counting()));
    }

    public Map<Boolean, List<Todo>> partitionByDone() {
        // partitioningBy 保證 true / false 兩個 key 都存在（即使其中一組是空的）
        return todos.stream().collect(Collectors.partitioningBy(Todo::isDone));
    }

    /** 熱門標籤：flatMap 攤平標籤 → 計數 → 排序 → 取 N */
    public Map<String, Long> topTags(int limit) {
        return todos.stream()
                .flatMap(t -> t.tags().stream())
                .collect(Collectors.groupingBy(tag -> tag, Collectors.counting()))
                .entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed()
                        .thenComparing(Map.Entry.comparingByKey()))
                .limit(limit)
                // ⚠️ 一定要 LinkedHashMap，否則上面的排序會被 HashMap 打散
                .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue,
                        (a, b) -> a, LinkedHashMap::new));
    }

    public Map<LocalDate, Long> countByDate() {
        return todos.stream().collect(Collectors.groupingBy(
                t -> t.createdAt().toLocalDate(), TreeMap::new, Collectors.counting()));
    }

    /** 未完成，依優先度 → 建立時間排序 */
    public List<Todo> pendingSorted() {
        return todos.stream()
                .filter(t -> !t.isDone())
                // ⚠️ weight 是「數字大 = 優先度高」，所以要 reversed()
                .sorted(Comparator.comparingInt((Todo t) -> t.priority().weight()).reversed()
                        .thenComparing(Todo::createdAt))
                .toList();
    }

    public double completionRate() {
        if (todos.isEmpty()) return 0.0;
        return todos.stream().filter(Todo::isDone).count() * 100.0 / todos.size();
    }

    /** 每個優先度的完成率（兩層統計） */
    public Map<Priority, String> completionRateByPriority() {
        return todos.stream().collect(Collectors.groupingBy(
                Todo::priority,
                () -> new EnumMap<>(Priority.class),
                Collectors.collectingAndThen(Collectors.toList(), list -> {
                    long done = list.stream().filter(Todo::isDone).count();
                    return "%d/%d (%.0f%%)".formatted(done, list.size(),
                            done * 100.0 / list.size());
                })));
    }

    /** 一次拿到「已完成數」與「總數」（teeing） */
    public String summary() {
        return todos.stream().collect(Collectors.teeing(
                Collectors.filtering(Todo::isDone, Collectors.counting()),
                Collectors.counting(),
                (done, total) -> total == 0
                        ? "沒有待辦"
                        : "%d / %d 完成 (%.1f%%)".formatted(done, total, done * 100.0 / total)));
    }

    /** 標籤 → 未完成的待辦標題（filtering 保留空組） */
    public Map<String, List<String>> pendingTitlesByTag() {
        return todos.stream()
                .flatMap(t -> t.tags().stream().map(tag -> Map.entry(tag, t)))
                .collect(Collectors.groupingBy(Map.Entry::getKey, TreeMap::new,
                        Collectors.mapping(Map.Entry::getValue,
                                Collectors.filtering(t -> !t.isDone(),
                                        Collectors.mapping(Todo::title, Collectors.toList())))));
    }

    /** 最舊的未完成待辦（該優先處理的） */
    public Optional<Todo> oldestPending() {
        return todos.stream()
                .filter(t -> !t.isDone())
                .min(Comparator.comparing(Todo::createdAt));
    }

    /** 給 CLI 顯示的完整報表 */
    public String render() {
        StringBuilder sb = new StringBuilder();
        sb.append("=== 待辦統計 ===\n");
        sb.append("總覽: ").append(summary()).append('\n');

        sb.append("\n依優先度:\n");
        countByPriority().forEach((p, c) ->
                sb.append("  %-4s %d 筆  完成 %s%n".formatted(
                        p.label(), c, completionRateByPriority().get(p))));

        sb.append("\n依日期:\n");
        countByDate().forEach((d, c) -> sb.append("  %s  %d 筆%n".formatted(d, c)));

        sb.append("\n熱門標籤:\n");
        topTags(5).forEach((tag, c) -> sb.append("  %-8s %d 次%n".formatted(tag, c)));

        sb.append("\n待處理（優先度序）:\n");
        pendingSorted().forEach(t -> sb.append("  ").append(t.toDisplayLine()).append('\n'));

        oldestPending().ifPresentOrElse(
                t -> sb.append("\n⚠️ 最久未處理: ").append(t.toDisplayLine())
                        .append(" (建立於 ").append(t.createdAt().toLocalDate()).append(")\n"),
                () -> sb.append("\n✅ 沒有待處理的項目\n"));

        return sb.toString();
    }
}
```

### 執行

```java
package com.example.todo;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.IndexedTodoRepository;
import com.example.todo.service.TodoStatistics;

import java.time.LocalDateTime;

public class StreamStatsDemo {
    public static void main(String[] args) {
        IndexedTodoRepository repo = new IndexedTodoRepository();
        LocalDateTime base = LocalDateTime.of(2026, 8, 12, 9, 0);

        Todo t1 = new Todo(repo.nextId(), "寫第 06 章", Priority.HIGH, base);
        t1.addTag("寫作"); t1.addTag("java");
        repo.save(t1);

        Todo t2 = new Todo(repo.nextId(), "Code review", Priority.MEDIUM, base.plusDays(1));
        t2.addTag("java"); t2.addTag("團隊");
        t2.markDone(base.plusDays(1).plusHours(3));
        repo.save(t2);

        Todo t3 = new Todo(repo.nextId(), "買咖啡", Priority.LOW, base.plusDays(2));
        t3.addTag("生活");
        t3.markDone(base.plusDays(2).plusHours(1));
        repo.save(t3);

        Todo t4 = new Todo(repo.nextId(), "重構 Repository", Priority.MEDIUM, base.plusDays(3));
        t4.addTag("java"); t4.addTag("重構");
        repo.save(t4);

        Todo t5 = new Todo(repo.nextId(), "回信", Priority.LOW, base.plusDays(4));
        t5.addTag("團隊");
        repo.save(t5);

        TodoStatistics stats = new TodoStatistics(repo.findAll());
        System.out.println(stats.render());

        System.out.println("=== 標籤 → 未完成標題（filtering 保留空組）===");
        stats.pendingTitlesByTag().forEach((tag, titles) ->
                System.out.printf("  %-8s %s%n", tag, titles));
    }
}
```

輸出：

```
=== 待辦統計 ===
總覽: 2 / 5 完成 (40.0%)

依優先度:
  高    1 筆  完成 0/1 (0%)
  中    2 筆  完成 1/2 (50%)
  低    2 筆  完成 1/2 (50%)

依日期:
  2026-08-12  1 筆
  2026-08-13  1 筆
  2026-08-14  1 筆
  2026-08-15  1 筆
  2026-08-16  1 筆

熱門標籤:
  java     3 次
  團隊       2 次
  寫作       1 次
  生活       1 次
  重構       1 次

待處理（優先度序）:
  [ ] #1   [高] 寫第 06 章 [寫作, java]
  [ ] #4   [中] 重構 Repository [java, 重構]
  [ ] #5   [低] 回信 [團隊]

⚠️ 最久未處理: [ ] #1   [高] 寫第 06 章 [寫作, java] (建立於 2026-08-12)

=== 標籤 → 未完成標題（filtering 保留空組）===
  java     [寫第 06 章, 重構 Repository]
  團隊       [回信]
  寫作       [寫第 06 章]
  生活       []
  重構       [重構 Repository]
```

**注意 `生活` 那一列是空清單而不是消失**——這就是 `Collectors.filtering` 的價值（6.10 節第 ⑨ 點）。
報表要「每個標籤都出現」時，這個差別很重要。

### ⚠️ 這一版有一個效能問題，你發現了嗎

```java
// ❌ render() 裡面：
countByPriority().forEach((p, c) ->
        sb.append(...completionRateByPriority().get(p)));
//                 ↑ 每一圈都重新計算整個統計！

// ✅ 提到迴圈外
Map<Priority, String> rates = completionRateByPriority();
countByPriority().forEach((p, c) -> sb.append(...rates.get(p)));
```

只有 3 個優先度時看不出來，但如果是 10 萬筆訂單分成 1000 個群組，這就是 1000 倍的浪費。

> **這是 Stream 常見的隱藏成本**：方法呼叫看起來很便宜（`completionRateByPriority()` 只是個名字），
> 實際上它走訪了整個集合。**在迴圈裡呼叫「會走訪集合的方法」之前，先想一下。**

---

## 6.18 常見錯誤

| # | 錯誤 | 修法 |
|---|---|---|
| 1 | `orElse(expensiveCall())` | `orElseGet(() -> expensiveCall())` |
| 2 | `optional.isPresent()` + `get()` | `map().orElse()` |
| 3 | `Optional` 當欄位 / 參數 | 只當回傳型別 |
| 4 | `Optional.of(可能是 null)` | `Optional.ofNullable(...)` |
| 5 | `toMap` 沒給合併函式 | 加第三個參數 |
| 6 | `groupingBy` 後假設有順序 | 指定 `TreeMap::new` / `LinkedHashMap::new` |
| 7 | `sorted()` 後 `toMap` 用預設 HashMap | 指定 `LinkedHashMap::new` |
| 8 | `reduce("", String::concat)` | `Collectors.joining()` |
| 9 | 重複使用同一個 Stream | 每次重新建立，或收集成集合 |
| 10 | `peek` 做有副作用的事 | 只用來除錯 |
| 11 | 平行流做阻塞 IO | 用 `ExecutorService` / 虛擬執行緒 |
| 12 | 平行流 + `ArrayList::add` | `collect` / `toList()` |
| 13 | Stream 裡呼叫資料庫（N+1） | 先批次查詢，再在記憶體對應 |
| 14 | 在迴圈裡呼叫「會走訪集合」的方法 | 提到迴圈外 |
| 15 | 一行 Stream 超過 5 個操作 | 拆成有名字的步驟或改 for 迴圈 |
| 16 | 空 Stream 的 `allMatch` 回 `true` 沒處理 | 額外檢查 `!isEmpty()` |

---

## 6.19 本章練習

### 練習 1：找出所有問題

```java
public class Buggy {

    public List<String> getNames(List<User> users) {
        return users.stream().map(User::getName).collect(Collectors.toList());
    }

    public String getConfig(String key) {
        return configCache.get(key).orElse(loadFromDatabase(key));
    }

    public Map<String, User> indexByEmail(List<User> users) {
        return users.stream().collect(Collectors.toMap(User::getEmail, u -> u));
    }

    public List<String> getTopUsers(List<User> users) {
        return users.stream()
                .sorted(Comparator.comparingInt(User::getScore).reversed())
                .limit(10)
                .collect(Collectors.toMap(User::getId, User::getName))
                .values().stream().toList();
    }

    public void processAll(List<Order> orders) {
        orders.parallelStream().forEach(o -> {
            Customer c = customerRepository.findById(o.getCustomerId());
            emailSender.send(c.getEmail(), "訂單通知");
        });
    }

    public Optional<String> getNickname(User user) {
        return Optional.of(user.getNickname());
    }
}
```

<details>
<summary>參考解答</summary>

**六個問題：**

1. **`getNames`**：`Collectors.toList()` 回傳可變 List。Java 16+ 應該用 `.toList()`（不可變，
   也不會被呼叫方偷改）。
2. **`getConfig`**：`orElse(loadFromDatabase(key))` —— **每次都會查資料庫**，
   就算快取有值（6.14 節）。應該用 `orElseGet`。
3. **`indexByEmail`**：`toMap` 沒給合併函式 —— 有兩個使用者同 email 就丟
   `IllegalStateException`（6.10 節）。
4. **`getTopUsers`**：`sorted` + `limit` 之後用 `toMap` 收集 —— `HashMap` 無序，
   前面的排序完全白做。而且用 Map 只為了取 values，完全沒必要。
5. **`processAll`**：平行流裡做**阻塞 IO**（查資料庫 + 寄信）—— 佔滿 common pool，
   拖累整個應用程式（6.15 節陷阱 1）。而且沒有任何錯誤處理，一筆失敗整批中斷。
6. **`getNickname`**：`Optional.of(可能是 null)` —— nickname 是 null 時直接 NPE。

**修正版：**

```java
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;
import java.util.stream.Collectors;

public class Fixed {

    record User(String id, String name, String email, String nickname, int score) { }
    record Order(String id, String customerId) { }
    record Customer(String id, String email) { }

    interface ConfigCache { Optional<String> get(String key); }
    interface CustomerRepository {
        Customer findById(String id);
        Map<String, Customer> findAllByIds(java.util.Set<String> ids);
    }
    interface EmailSender { void send(String to, String subject); }

    private final ConfigCache configCache;
    private final CustomerRepository customerRepository;
    private final EmailSender emailSender;

    Fixed(ConfigCache c, CustomerRepository r, EmailSender e) {
        this.configCache = c; this.customerRepository = r; this.emailSender = e;
    }

    /** ① Stream.toList()：不可變，Java 16+ 的預設選擇 */
    public List<String> getNames(List<User> users) {
        return users.stream().map(User::name).toList();
    }

    /** ② orElseGet：只在快取沒有時才查資料庫 */
    public String getConfig(String key) {
        return configCache.get(key).orElseGet(() -> loadFromDatabase(key));
    }

    /**
     * ③ toMap 給合併函式。
     * 這裡選「保留第一筆並記錄警告」——email 重複本身就是資料問題，不該靜默覆蓋。
     */
    public Map<String, User> indexByEmail(List<User> users) {
        return users.stream().collect(Collectors.toMap(
                User::email,
                Function.identity(),
                (existing, duplicate) -> {
                    System.err.printf("[WARN] email 重複: %s（保留 %s，忽略 %s）%n",
                            existing.email(), existing.id(), duplicate.id());
                    return existing;
                }));
    }

    /** ④ 不需要 Map，直接排序取前 N 再 map */
    public List<String> getTopUsers(List<User> users, int limit) {
        return users.stream()
                .sorted(Comparator.comparingInt(User::score).reversed()
                        .thenComparing(User::id))          // tie-breaker，結果才穩定
                .limit(limit)
                .map(User::name)
                .toList();
    }

    /**
     * ⑤ 三個修正：
     *   a. 批次查詢取代 N 次查詢（避免 N+1）
     *   b. 用自己的執行緒池，不污染 ForkJoinPool.commonPool()
     *   c. 單筆失敗不中斷整批
     */
    public void processAll(List<Order> orders) {
        // (a) 一次查完所有客戶
        var customerIds = orders.stream().map(Order::customerId)
                .collect(Collectors.toSet());
        Map<String, Customer> customers = customerRepository.findAllByIds(customerIds);

        // (b) 自己的執行緒池。Java 21 可用 Executors.newVirtualThreadPerTaskExecutor()
        //     （IO 密集最適合虛擬執行緒，見第 08 章）
        try (ExecutorService pool = Executors.newFixedThreadPool(8)) {
            for (Order order : orders) {
                pool.submit(() -> {
                    // (c) 單筆的錯誤自己吸收，不影響其他筆
                    try {
                        Customer c = customers.get(order.customerId());
                        if (c == null) {
                            System.err.println("[WARN] 找不到客戶: " + order.customerId());
                            return;
                        }
                        emailSender.send(c.email(), "訂單通知");
                    } catch (RuntimeException e) {
                        System.err.printf("[ERROR] 訂單 %s 通知失敗: %s%n",
                                order.id(), e.getMessage());
                    }
                });
            }
        }   // try-with-resources 會呼叫 close()，等所有任務完成【Java 19+】
    }

    /** ⑥ ofNullable */
    public Optional<String> getNickname(User user) {
        return Optional.ofNullable(user.nickname());
    }

    private String loadFromDatabase(String key) {
        System.out.println("  查資料庫: " + key);
        return "value-of-" + key;
    }
}
```

**第 ⑤ 點的三個修正，每一個都對應一個真實的線上事故類型：**

| 修正 | 沒修的後果 |
|---|---|
| 批次查詢 | 1000 筆訂單 = 1000 次 DB 查詢，API 從 50ms 變 30 秒 |
| 自己的執行緒池 | 拖慢整個應用程式所有用平行流的地方 |
| 單筆錯誤隔離 | 第 3 筆的客戶不存在，後面 997 筆都沒發通知 |

</details>

### 練習 2：用 Stream 重寫統計

給定以下資料，用 Stream 完成六項統計。

```java
record Student(String name, String className, String subject, int score) { }

List<Student> data = List.of(
    new Student("小明", "A班", "數學", 85),
    new Student("小明", "A班", "英文", 92),
    new Student("小華", "A班", "數學", 78),
    new Student("小華", "A班", "英文", 88),
    new Student("小美", "B班", "數學", 95),
    new Student("小美", "B班", "英文", 76),
    new Student("小強", "B班", "數學", 62),
    new Student("小強", "B班", "英文", 70));
```

1. 每個學生的總分與平均（依總分降序）
2. 每個班級每個科目的平均分
3. 每個科目的最高分學生
4. 及格（≥60）與不及格的學生名單（去重）
5. 全部科目都 ≥ 80 的學生
6. 各班級的成績分布（優 ≥90 / 良 80-89 / 中 70-79 / 待加強 <70）

<details>
<summary>參考解答</summary>

```java
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

public class StudentStatistics {

    record Student(String name, String className, String subject, int score) { }

    record StudentTotal(String name, String className, int total, double average, int subjects) {
        @Override
        public String toString() {
            return "%s(%s) 總分 %d 平均 %.1f（%d 科）"
                    .formatted(name, className, total, average, subjects);
        }
    }

    private final List<Student> data;

    StudentStatistics(List<Student> data) {
        this.data = List.copyOf(data);
    }

    /** ① 每個學生的總分與平均，依總分降序 */
    List<StudentTotal> studentTotals() {
        return data.stream()
                .collect(Collectors.groupingBy(Student::name,
                        Collectors.collectingAndThen(Collectors.toList(), list -> {
                            int total = list.stream().mapToInt(Student::score).sum();
                            return new StudentTotal(
                                    list.get(0).name(),
                                    list.get(0).className(),
                                    total,
                                    (double) total / list.size(),
                                    list.size());
                        })))
                .values().stream()
                .sorted(Comparator.comparingInt(StudentTotal::total).reversed()
                        .thenComparing(StudentTotal::name))
                .toList();
    }

    /** ② 班級 → 科目 → 平均分（兩層分組） */
    Map<String, Map<String, Double>> averageByClassAndSubject() {
        return data.stream().collect(Collectors.groupingBy(
                Student::className, TreeMap::new,
                Collectors.groupingBy(Student::subject, TreeMap::new,
                        Collectors.averagingInt(Student::score))));
    }

    /** ③ 每個科目的最高分學生（collectingAndThen 去掉 Optional） */
    Map<String, String> topStudentBySubject() {
        return data.stream().collect(Collectors.groupingBy(
                Student::subject, TreeMap::new,
                Collectors.collectingAndThen(
                        Collectors.maxBy(Comparator.comparingInt(Student::score)),
                        opt -> opt.map(s -> "%s (%d 分)".formatted(s.name(), s.score()))
                                  .orElse("(無資料)"))));
    }

    /**
     * ④ 及格 / 不及格的學生名單（去重）。
     * 注意語意：這裡定義為「有任何一科不及格就算不及格」，
     * 所以要先算「每個學生的最低分」，不能直接對每筆成績 partition。
     */
    Map<Boolean, Set<String>> passFailStudents() {
        return data.stream()
                .collect(Collectors.groupingBy(Student::name,
                        Collectors.collectingAndThen(
                                Collectors.minBy(Comparator.comparingInt(Student::score)),
                                opt -> opt.map(Student::score).orElse(0))))
                .entrySet().stream()
                .collect(Collectors.partitioningBy(e -> e.getValue() >= 60,
                        Collectors.mapping(Map.Entry::getKey,
                                Collectors.toCollection(java.util.TreeSet::new))));
    }

    /** ⑤ 全部科目都 ≥ 80 的學生 */
    Set<String> allSubjectsAbove(int threshold) {
        return data.stream()
                .collect(Collectors.groupingBy(Student::name, TreeMap::new,
                        Collectors.toList()))
                .entrySet().stream()
                .filter(e -> e.getValue().stream().allMatch(s -> s.score() >= threshold))
                .map(Map.Entry::getKey)
                .collect(Collectors.toCollection(java.util.LinkedHashSet::new));
    }

    /** ⑥ 各班級的成績分布 */
    enum Grade {
        EXCELLENT("優 (≥90)"), GOOD("良 (80-89)"), FAIR("中 (70-79)"), POOR("待加強 (<70)");

        private final String label;
        Grade(String label) { this.label = label; }
        String getLabel() { return label; }

        static Grade of(int score) {
            if (score >= 90) return EXCELLENT;
            if (score >= 80) return GOOD;
            if (score >= 70) return FAIR;
            return POOR;
        }
    }

    Map<String, Map<Grade, Long>> gradeDistribution() {
        return data.stream().collect(Collectors.groupingBy(
                Student::className, TreeMap::new,
                Collectors.groupingBy(s -> Grade.of(s.score()),
                        () -> new java.util.EnumMap<>(Grade.class),      // 保持 enum 順序
                        Collectors.counting())));
    }

    // ===== 執行 =====

    public static void main(String[] args) {
        var stats = new StudentStatistics(List.of(
                new Student("小明", "A班", "數學", 85),
                new Student("小明", "A班", "英文", 92),
                new Student("小華", "A班", "數學", 78),
                new Student("小華", "A班", "英文", 88),
                new Student("小美", "B班", "數學", 95),
                new Student("小美", "B班", "英文", 76),
                new Student("小強", "B班", "數學", 62),
                new Student("小強", "B班", "英文", 70)));

        System.out.println("① 學生總分排名");
        stats.studentTotals().forEach(s -> System.out.println("   " + s));

        System.out.println("\n② 班級 × 科目平均");
        stats.averageByClassAndSubject().forEach((cls, subjects) -> {
            System.out.println("   " + cls);
            subjects.forEach((sub, avg) -> System.out.printf("     %-4s %.1f%n", sub, avg));
        });

        System.out.println("\n③ 各科最高分");
        stats.topStudentBySubject().forEach((sub, top) ->
                System.out.printf("   %-4s %s%n", sub, top));

        System.out.println("\n④ 及格狀況（任一科 <60 即不及格）");
        var passFail = stats.passFailStudents();
        System.out.println("   全部及格: " + passFail.get(true));
        System.out.println("   有不及格: " + passFail.get(false));

        System.out.println("\n⑤ 全科 ≥80: " + stats.allSubjectsAbove(80));
        System.out.println("   全科 ≥70: " + stats.allSubjectsAbove(70));

        System.out.println("\n⑥ 成績分布");
        stats.gradeDistribution().forEach((cls, dist) -> {
            System.out.println("   " + cls);
            for (Grade g : Grade.values()) {
                System.out.printf("     %-12s %d 人次%n", g.getLabel(), dist.getOrDefault(g, 0L));
            }
        });
    }
}
```

輸出：

```
① 學生總分排名
   小明(A班) 總分 177 平均 88.5（2 科）
   小美(B班) 總分 171 平均 85.5（2 科）
   小華(A班) 總分 166 平均 83.0（2 科）
   小強(B班) 總分 132 平均 66.0（2 科）

② 班級 × 科目平均
   A班
     英文   90.0
     數學   81.5
   B班
     英文   73.0
     數學   78.5

③ 各科最高分
   英文   小明 (92 分)
   數學   小美 (95 分)

④ 及格狀況（任一科 <60 即不及格）
   全部及格: [小明, 小美, 小華, 小強]
   有不及格: []

⑤ 全科 ≥80: [小明]
   全科 ≥70: [小明, 小華, 小強]

⑥ 成績分布
   A班
     優 (≥90)      1 人次
     良 (80-89)    2 人次
     中 (70-79)    1 人次
     待加強 (<70)   0 人次
   B班
     優 (≥90)      1 人次
     良 (80-89)    0 人次
     中 (70-79)    2 人次
     待加強 (<70)   1 人次
```

**四個容易做錯的地方：**

1. **第 ④ 題的語意陷阱**。直覺會寫成 `partitioningBy(s -> s.score() >= 60)`，
   但那是「及格的**成績筆數**」分組，同一個學生會同時出現在兩邊。
   題目要的是「學生」層級，所以必須先 group 到學生，算出最低分，再 partition。
   **這類「聚合層級」的錯誤在報表需求裡極常見。**

2. **第 ⑤ 題的 `allMatch`**。注意空 Stream 的 `allMatch` 回傳 `true`（6.9 節）——
   如果有學生一科都沒考，他會被算成「全科 ≥80」。實際專案要加 `!list.isEmpty()`。

3. **第 ⑥ 題用 `getOrDefault(g, 0L)`**。`groupingBy` 不會產生沒有資料的群組，
   所以「待加強 0 人」需要在輸出時補（或用 `Collectors.filtering`，見 6.10 節第 ⑨ 點）。
   少了這步，A 班的報表就不會顯示「待加強」那一列，格式不整齊。

4. **每個 `sorted` 都加 tie-breaker**（`.thenComparing(StudentTotal::name)`）。
   兩個學生同分時，沒有 tie-breaker 的排序結果不穩定。

</details>

### 練習 3：實作函式介面工具

實作三個高階函式工具：

1. `Memoizer`：把任何 `Function` 包成有快取的版本
2. `Timer`：測量任何操作的耗時並記錄
3. `Validator`：可組合的驗證器，收集所有錯誤

<details>
<summary>參考解答</summary>

```java
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

// ============ ① Memoizer ============

/**
 * 把任何 Function 包成帶快取的版本。
 * 用 ConcurrentHashMap.computeIfAbsent 保證同一個 key 只計算一次（第 05 章 5.13 節）。
 */
public final class Memoizer<T, R> implements Function<T, R> {

    private final Function<T, R> delegate;
    private final Map<T, R> cache = new ConcurrentHashMap<>();
    private final AtomicLong hits = new AtomicLong();
    private final AtomicLong misses = new AtomicLong();

    private Memoizer(Function<T, R> delegate) {
        this.delegate = Objects.requireNonNull(delegate, "delegate 不可為 null");
    }

    public static <T, R> Memoizer<T, R> of(Function<T, R> f) {
        return new Memoizer<>(f);
    }

    @Override
    public R apply(T input) {
        Objects.requireNonNull(input, "ConcurrentHashMap 不允許 null key");
        R cached = cache.get(input);
        if (cached != null) {
            hits.incrementAndGet();
            return cached;
        }
        // computeIfAbsent 是原子的：多執行緒同時進來也只會算一次
        return cache.computeIfAbsent(input, k -> {
            misses.incrementAndGet();
            return delegate.apply(k);
        });
    }

    public void clear() { cache.clear(); }

    public int size() { return cache.size(); }

    public String stats() {
        long h = hits.get(), m = misses.get(), total = h + m;
        return "命中 %d / %d (%.1f%%)，快取 %d 筆"
                .formatted(h, total, total == 0 ? 0.0 : h * 100.0 / total, cache.size());
    }
}
```

```java
import java.util.function.Supplier;

// ============ ② Timer ============

/** 測量任何操作的耗時。用 6.6 節的「執行周邊模式」。 */
public final class Timer {

    @FunctionalInterface
    public interface ThrowingRunnable {
        void run() throws Exception;
    }

    private final java.util.function.BiConsumer<String, Long> reporter;

    private Timer(java.util.function.BiConsumer<String, Long> reporter) {
        this.reporter = reporter;
    }

    /** 預設印到 stdout */
    public static Timer console() {
        return new Timer((label, nanos) ->
                System.out.printf("  ⏱ %-24s %8.3f ms%n", label, nanos / 1_000_000.0));
    }

    /** 可換成寫入 Micrometer / Prometheus */
    public static Timer to(java.util.function.BiConsumer<String, Long> reporter) {
        return new Timer(reporter);
    }

    /** 有回傳值的操作 */
    public <T> T measure(String label, Supplier<T> action) {
        long start = System.nanoTime();
        try {
            return action.get();
        } finally {
            // finally 保證「即使丟例外也會記錄耗時」——這對排查逾時很重要
            reporter.accept(label, System.nanoTime() - start);
        }
    }

    /** 沒有回傳值 */
    public void measure(String label, Runnable action) {
        measure(label, () -> {
            action.run();
            return null;
        });
    }

    /** 允許丟 checked 例外的版本（6.6 節案例二的手法） */
    public void measureChecked(String label, ThrowingRunnable action) throws Exception {
        long start = System.nanoTime();
        try {
            action.run();
        } finally {
            reporter.accept(label, System.nanoTime() - start);
        }
    }
}
```

```java
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Function;
import java.util.function.Predicate;

// ============ ③ Validator ============

/**
 * 可組合的驗證器。
 * 關鍵設計：and() 不是短路的——它會「收集所有錯誤」，
 * 因為表單驗證要一次回報全部問題（第 04 章 4.13 節）。
 */
@FunctionalInterface
public interface Validator<T> {

    List<String> validate(T target);

    // ===== 工廠方法 =====

    /** 從 Predicate 建立單一規則 */
    static <T> Validator<T> rule(Predicate<T> predicate, String errorMessage) {
        Objects.requireNonNull(predicate, "predicate 不可為 null");
        Objects.requireNonNull(errorMessage, "errorMessage 不可為 null");
        return target -> predicate.test(target) ? List.of() : List.of(errorMessage);
    }

    /** 錯誤訊息可以引用實際值 */
    static <T> Validator<T> rule(Predicate<T> predicate, Function<T, String> messageBuilder) {
        return target -> predicate.test(target)
                ? List.of()
                : List.of(messageBuilder.apply(target));
    }

    /** 永遠通過（組合的起點） */
    static <T> Validator<T> valid() {
        return target -> List.of();
    }

    // ===== 組合 =====

    /** 收集兩邊的所有錯誤（非短路） */
    default Validator<T> and(Validator<T> other) {
        Objects.requireNonNull(other, "other 不可為 null");
        return target -> {
            List<String> errors = new ArrayList<>(this.validate(target));
            errors.addAll(other.validate(target));
            return List.copyOf(errors);
        };
    }

    /** 短路版：前面失敗就不驗後面（用於「先確認非 null 再檢查長度」） */
    default Validator<T> andThen(Validator<T> other) {
        return target -> {
            List<String> errors = this.validate(target);
            return errors.isEmpty() ? other.validate(target) : errors;
        };
    }

    /** 對巢狀屬性套用驗證器 */
    default <U> Validator<U> on(Function<U, T> extractor, String fieldName) {
        return parent -> this.validate(extractor.apply(parent)).stream()
                .map(e -> fieldName + ": " + e)
                .toList();
    }

    // ===== 執行 =====

    default boolean isValid(T target) {
        return validate(target).isEmpty();
    }

    default void assertValid(T target) {
        List<String> errors = validate(target);
        if (!errors.isEmpty()) {
            throw new IllegalArgumentException("驗證失敗: " + String.join("; ", errors));
        }
    }
}
```

使用示範：

```java
import java.util.List;
import java.util.function.Function;

public class FunctionalToolsDemo {

    record Address(String city, String zipCode) { }
    record User(String email, int age, String password, Address address) { }

    /** 模擬一個很慢的計算 */
    static long slowFibonacci(int n) {
        try {
            Thread.sleep(20);          // 模擬耗時
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return n <= 1 ? n : n * 1000L;
    }

    public static void main(String[] args) {

        // ===== ① Memoizer =====
        System.out.println("=== Memoizer ===");
        Timer timer = Timer.console();
        Memoizer<Integer, Long> memo = Memoizer.of(FunctionalToolsDemo::slowFibonacci);

        timer.measure("第一次 fib(30)", () -> memo.apply(30));
        timer.measure("第二次 fib(30)", () -> memo.apply(30));       // 命中快取
        timer.measure("第三次 fib(30)", () -> memo.apply(30));
        timer.measure("第一次 fib(40)", () -> memo.apply(40));
        System.out.println("  " + memo.stats());

        // ===== ② Timer 的例外情境 =====
        System.out.println("\n=== Timer（失敗也會記錄耗時）===");
        try {
            timer.measure("會失敗的操作", () -> {
                try { Thread.sleep(30); } catch (InterruptedException e) { }
                throw new IllegalStateException("boom");
            });
        } catch (IllegalStateException e) {
            System.out.println("  捕捉: " + e.getMessage());
        }

        // ===== ③ Validator =====
        System.out.println("\n=== Validator ===");

        Validator<String> emailValidator =
                Validator.<String>rule(s -> s != null && !s.isBlank(), "不可為空")
                        .andThen(Validator.<String>rule(s -> s.contains("@"),
                                        s -> "格式錯誤: " + s)
                                .and(Validator.rule(s -> s.length() <= 100, "長度不可超過 100")));

        Validator<Integer> ageValidator =
                Validator.<Integer>rule(a -> a != null, "不可為空")
                        .andThen(Validator.<Integer>rule(a -> a >= 18, a -> "須滿 18 歲，實際 " + a)
                                .and(Validator.rule(a -> a <= 150, "年齡不合理")));

        Validator<String> passwordValidator =
                Validator.<String>rule(p -> p != null && p.length() >= 8, "至少 8 字元")
                        .and(Validator.rule(
                                p -> p != null && p.chars().anyMatch(Character::isDigit),
                                "須包含數字"))
                        .and(Validator.rule(
                                p -> p != null && p.chars().anyMatch(Character::isUpperCase),
                                "須包含大寫字母"));

        Validator<Address> addressValidator =
                Validator.<String>rule(z -> z != null && z.matches("\\d{3,5}"), "郵遞區號須為 3-5 位數字")
                        .on(Address::zipCode, "zipCode");

        // 組合成整個 User 的驗證器
        Validator<User> userValidator = Validator.<User>valid()
                .and(emailValidator.on(User::email, "email"))
                .and(ageValidator.on(User::age, "age"))
                .and(passwordValidator.on(User::password, "password"))
                .and(addressValidator.on(User::address, "address"));

        System.out.println("--- 合法的使用者 ---");
        User good = new User("user@example.com", 30, "Secret123", new Address("台北", "110"));
        System.out.println("  通過? " + userValidator.isValid(good));

        System.out.println("--- 有問題的使用者 ---");
        User bad = new User("not-an-email", 15, "abc", new Address("台北", "ABC"));
        userValidator.validate(bad).forEach(e -> System.out.println("  - " + e));

        System.out.println("--- assertValid 丟例外 ---");
        try {
            userValidator.assertValid(bad);
        } catch (IllegalArgumentException e) {
            System.out.println("  " + e.getMessage());
        }

        System.out.println("--- 短路 vs 收集 ---");
        System.out.println("  andThen（短路）: " + emailValidator.validate(null));
        System.out.println("  and（收集）    : " + passwordValidator.validate("abc"));
    }
}
```

輸出：

```
=== Memoizer ===
  ⏱ 第一次 fib(30)             20.412 ms
  ⏱ 第二次 fib(30)              0.008 ms
  ⏱ 第三次 fib(30)              0.003 ms
  ⏱ 第一次 fib(40)             20.187 ms
  命中 2 / 4 (50.0%)，快取 2 筆

=== Timer（失敗也會記錄耗時）===
  ⏱ 會失敗的操作                30.294 ms
  捕捉: boom

=== Validator ===
--- 合法的使用者 ---
  通過? true
--- 有問題的使用者 ---
  - email: 格式錯誤: not-an-email
  - age: 須滿 18 歲，實際 15
  - password: 至少 8 字元
  - password: 須包含數字
  - password: 須包含大寫字母
  - address: zipCode: 郵遞區號須為 3-5 位數字
--- assertValid 丟例外 ---
  驗證失敗: email: 格式錯誤: not-an-email; age: 須滿 18 歲，實際 15; ...
--- 短路 vs 收集 ---
  andThen（短路）: [不可為空]
  and（收集）    : [至少 8 字元, 須包含數字, 須包含大寫字母]
```

**三個設計重點：**

| 工具 | 關鍵設計 |
|---|---|
| `Memoizer` | 用 `ConcurrentHashMap.computeIfAbsent`——它是**原子的**，多執行緒同時請求同一個 key 也只計算一次。用 `containsKey` + `put` 就不是原子的（第 05 章 5.13 節） |
| `Timer` | 計時放在 `finally`——**失敗的操作也要記錄耗時**。實務上「逾時導致失敗」是最需要看耗時的情況，如果只在成功時記錄就完全看不到 |
| `Validator` | 提供 `and`（收集全部錯誤）和 `andThen`（短路）兩種組合。null 檢查用 `andThen`（避免後續規則 NPE），其他規則用 `and`（一次回報全部） |

**`on()` 方法的設計**：它把 `Validator<String>` 提升成 `Validator<User>`，
這樣同一個 email 驗證器可以用在任何有 email 欄位的型別上。這是函式式程式設計的「提升（lift）」概念。

> **實務對照**：`Validator` 這個模式的成熟版是 **Bean Validation（`@NotNull` / `@Email` / `@Size`）**，
> 第 04 站（Controller）會用到。`Memoizer` 的成熟版是 **Caffeine**。
> `Timer` 的成熟版是 **Micrometer**。手寫一遍讓你知道它們在做什麼。

</details>

### 練習 4：預測輸出

```java
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public class Quiz {
    public static void main(String[] args) {
        // ①
        System.out.println(Stream.of("a", "b", "c")
                .peek(s -> System.out.print("peek:" + s + " "))
                .filter(s -> s.equals("b"))
                .findFirst().orElse(""));

        // ②
        List<Integer> nums = List.of(1, 3, 5, 8, 9, 2);
        System.out.println(nums.stream().takeWhile(n -> n < 8).toList());
        System.out.println(nums.stream().filter(n -> n < 8).toList());

        // ③
        System.out.println(List.<String>of().stream().allMatch(s -> false));

        // ④
        Optional<String> opt = Optional.of("value");
        System.out.println(opt.orElse(sideEffect("orElse")));
        System.out.println(opt.orElseGet(() -> sideEffect("orElseGet")));

        // ⑤
        Map<String, Integer> m = Stream.of("apple", "avocado", "banana")
                .collect(Collectors.toMap(s -> s.substring(0, 1), String::length,
                        (a, b) -> a + b));
        System.out.println(new TreeMap<>(m));

        // ⑥
        System.out.println(Stream.of(1, 2, 3).reduce(10, (a, b) -> a + b));
        System.out.println(Stream.of(1, 2, 3).map(n -> n * 2)
                .sorted(Comparator.reverseOrder()).limit(2).toList());
    }

    static String sideEffect(String who) {
        System.out.print("[執行了 " + who + "] ");
        return "default";
    }
}
```

<details>
<summary>參考解答</summary>

```
peek:a peek:b b
[1, 3, 5]
[1, 3, 5, 2]
true
[執行了 orElse] value
value
{a=12, b=6}
16
[6, 4]
```

**逐一說明：**

**①** `peek:a peek:b b`
惰性求值 + 短路：`findFirst` 找到 `"b"` 就停，`"c"` 完全沒被走訪（6.7 節）。

**②** `[1, 3, 5]` vs `[1, 3, 5, 2]`
`takeWhile` 遇到第一個不符（`8`）就**停止**，後面的 `9`、`2` 不再檢查。
`filter` 會**檢查全部**，所以最後的 `2` 也被保留。**這兩個很容易混淆。**

**③** `true`
空 Stream 的 `allMatch` 永遠回傳 `true`（空真），即使斷言是 `s -> false`（6.9 節）。

**④** `[執行了 orElse] value` 然後 `value`
`orElse` 的參數是「值」，**不管有沒有值都會先求值**。
`orElseGet` 的參數是 `Supplier`，Optional 有值時**完全不呼叫**（6.14 節）。

**⑤** `{a=12, b=6}`
`"apple"`（5 字）和 `"avocado"`（7 字）的首字母都是 `a` → key 衝突 → 呼叫合併函式
`(a, b) -> a + b` → `5 + 7 = 12`。`"banana"` 是 6。
**如果沒給合併函式，這裡會丟 `IllegalStateException: Duplicate key a`**（6.10 節）。

**⑥** `16` 和 `[6, 4]`
`reduce(10, ...)`：初始值 10 + 1 + 2 + 3 = 16。
`map(n -> n*2)` 得 `[2, 4, 6]`，`sorted(reverseOrder())` 得 `[6, 4, 2]`，`limit(2)` 得 `[6, 4]`。

**這題最該記住的三點：**
1. `takeWhile`（遇到不符就停）≠ `filter`（檢查全部）
2. `orElse`（總是求值）≠ `orElseGet`（延遲求值）
3. `toMap` 的合併函式不是可選的，是必要的

</details>

### 練習 5：判斷該用 Stream 還是 for

| # | 需求 | 你的選擇 |
|---|---|---|
| 1 | 把 `List<Order>` 轉成 `List<OrderDto>` | ? |
| 2 | 找出第一筆金額 > 10000 的訂單，找到就記 log 並中止 | ? |
| 3 | 計算每個使用者的訂單總額 | ? |
| 4 | 逐行讀 CSV 檔（可能 100 萬行），有格式錯誤的行要記錄行號 | ? |
| 5 | 對每筆訂單呼叫外部風控 API，取得評分 | ? |
| 6 | 計算移動平均（每個元素需要前後 3 個元素） | ? |
| 7 | 把巢狀的分類樹攤平成清單 | ? |
| 8 | 檢查購物車所有商品都有庫存 | ? |

<details>
<summary>參考解答</summary>

| # | 選擇 | 理由 |
|---|---|---|
| 1 | **Stream** | 純轉換，一行搞定：`orders.stream().map(OrderDto::from).toList()` |
| 2 | **Stream**（`findFirst`）或 **for**（`break`） | 兩者都可以。`findFirst()` 短路等同 break。但如果找到之後還要做複雜的副作用（記 log、發通知、寫審計），**for + break 更直白**——`findFirst().ifPresent(o -> {...})` 也可以，看哪個好讀 |
| 3 | **Stream** | `groupingBy` + `summingLong` 就是為此而生 |
| 4 | **for 迴圈** | 三個理由：① 需要**行號**；② 讀檔有 **checked 例外**；③ 需要「一行錯不中斷整批」的錯誤收集。這正是第 03 章 3.8 節模板方法的場景。（若只是單純轉換每行，`Files.lines()` + Stream 也行，但要記得 try-with-resources） |
| 5 | **都不要用單純的迴圈** | 這是 IO 密集的 N 次遠端呼叫。用 `ExecutorService` 或虛擬執行緒併發呼叫（第 08 章），並加上超時、重試、熔斷。**絕對不要用 `parallelStream()`**（6.15 節陷阱 1）。能改成批次 API 就更好 |
| 6 | **for 迴圈**（用索引） | 需要存取「前後元素」，Stream 天生不擅長（每個元素是獨立處理的）。用 `IntStream.range` + `list.get(i-1)` 能寫但很醜。**Java 24+ 的 Stream Gatherers（`windowSliding`）解決了這個場景**，但在 Java 21 上用 for 迴圈 |
| 7 | **Stream + 遞迴 flatMap** 或 **for + Deque** | 遞迴 `flatMap` 很優雅但深度大時會 `StackOverflowError`（第 01 章 1.14 節）。層級不確定的分類樹用 **`ArrayDeque` 當 stack 的迭代版**更安全 |
| 8 | **Stream** | `items.stream().allMatch(i -> stock.hasEnough(i))` —— 短路且語意清楚。⚠️ 但要注意空購物車會回 `true`（6.9 節），實務上要先檢查 `!items.isEmpty()` |

**第 6 題的兩種寫法對比：**

```java
// for 迴圈：清楚
List<Double> movingAvg = new ArrayList<>();
for (int i = 0; i < prices.size(); i++) {
    int from = Math.max(0, i - 2);
    int to = Math.min(prices.size(), i + 3);
    double sum = 0;
    for (int j = from; j < to; j++) sum += prices.get(j);
    movingAvg.add(sum / (to - from));
}

// Stream：能寫，但沒有更好讀
List<Double> movingAvg2 = IntStream.range(0, prices.size())
        .mapToObj(i -> prices.subList(Math.max(0, i - 2), Math.min(prices.size(), i + 3))
                .stream().mapToDouble(Double::doubleValue).average().orElse(0))
        .toList();
```

**第 7 題的迭代版（避免遞迴爆堆疊）：**

```java
record Category(String name, List<Category> children) { }

static List<String> flattenIterative(Category root) {
    List<String> result = new ArrayList<>();
    Deque<Category> stack = new ArrayDeque<>();
    stack.push(root);
    while (!stack.isEmpty()) {
        Category current = stack.pop();
        result.add(current.name());
        // 反向 push，讓走訪順序符合直覺（深度優先、左到右）
        for (int i = current.children().size() - 1; i >= 0; i--) {
            stack.push(current.children().get(i));
        }
    }
    return result;
}
```

**最重要的一條判準（再說一次）：**

> 不是「Stream 比較高級」，而是「**哪個版本讓下一個讀 code 的人更快理解**」。
> 第 1、3、8 題用 Stream 明顯更好；第 4、6 題用 for 明顯更好；第 2 題兩者皆可，看團隊習慣。

</details>

---

## 6.20 驗收清單

- [ ] 我知道 Lambda 的 `this` 指向外層物件，和匿名類別不同。
- [ ] 我認得四大函式介面，也知道 `IntFunction` 這類原始型別版本的用途。
- [ ] 我會用方法參考的四種形式，也知道 `String::length` 為什麼能當 `Function<String, Integer>`。
- [ ] 我能解釋 effectively final，也知道不該用 `AtomicInteger` 在 Lambda 裡累加。
- [ ] 我能設計自訂函式介面，寫出重試模板、交易模板這類高階函式。
- [ ] 我能解釋惰性求值，並知道「沒有終端操作就什麼都不會執行」。
- [ ] 我知道 Stream 只能消費一次，也知道不該把 Stream 當回傳型別。
- [ ] 我知道 `takeWhile` 遇到不符就停、`filter` 會檢查全部。
- [ ] 我知道空 Stream 的 `allMatch` 回傳 `true`。
- [ ] 我用 `groupingBy` + downstream 寫多層統計，且會指定 `TreeMap::new` 保證順序。
- [ ] 我知道 `toMap` 必須提供合併函式，也知道它的 value 不可為 null。
- [ ] 我知道 `sorted()` 後接 `toMap` 要指定 `LinkedHashMap::new`。
- [ ] 我能說出 `orElse` 與 `orElseGet` 的差別，並知道什麼時候用哪個。
- [ ] 我只把 `Optional` 用在回傳型別，不用在欄位、參數、集合元素。
- [ ] 我能說出平行流的四個陷阱，也知道 Web 應用幾乎不該用它。
- [ ] 我知道 Stream 裡呼叫資料庫會造成 N+1，該先批次查詢。
- [ ] 我能判斷什麼時候該用 for 迴圈而不是 Stream。

---

前 7 章（00～06）到此完成，你已經有寫出可維護 Java 程式的完整基礎。

下一章 `07-string-io-datetime-json.md`（字串效能、NIO.2 檔案 IO、`java.time` 時區、Jackson 序列化）
將接續本章，把待辦事項 CLI 的資料真正落地到檔案。
