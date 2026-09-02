# 第 07 章：字串、IO、日期時間與 JSON

> 這章是「跟外面的世界打交道」：讀檔、寫檔、處理時間、序列化成 JSON。
>
> 也是實務事故的密集區：**時區算錯讓報表少一天**、**`YYYY` 寫成小寫還好，寫成大寫在跨年那週全錯**、
> **CSV 用 `split(",")` 遇到欄位內含逗號就崩**、**寫檔寫到一半當機留下半個檔案**。
> 這些都不是「進階題」，是每個後端每年都會遇到一次的東西。

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說明 `String` 的內部結構（compact strings）、字串池與 `intern()` 的實務影響。
- 判斷什麼時候需要 `StringBuilder`，並實測它與 `+` 的差距。
- 解釋 `"👍".length() == 2`，並正確處理 emoji 與中文的字數計算。
- 預編譯 `Pattern`，並認出「災難性回溯」這種正規表達式的 DoS 風險。
- 用 NIO.2（`Path` / `Files`）取代舊的 `java.io.File`。
- 寫出**原子性的檔案寫入**（不會留下半個檔案）。
- 用串流方式處理超過記憶體的大檔。
- 在 `LocalDate` / `LocalDateTime` / `Instant` / `ZonedDateTime` / `OffsetDateTime` 之間選對型別。
- 說明時區與日光節約時間的三個經典陷阱。
- 用 `Clock` 讓「跟時間有關的邏輯」可以被測試。
- 用 Jackson 正確序列化 `java.time` 型別與泛型集合。

---

## 7.2 `String` 的內部結構

### Compact Strings（Java 9+）

```java
public class CompactStrings {
    public static void main(String[] args) {
        // Java 8：String 內部是 char[]，每個字元固定 2 bytes
        // Java 9+：String 內部是 byte[] + 一個 coder 標記
        //   - 全部是 Latin-1（≈ ASCII + 西歐字元）→ 每字元 1 byte
        //   - 有任何非 Latin-1 字元（如中文）→ 整個字串每字元 2 bytes（UTF-16）

        String ascii = "hello world";        // 11 bytes
        String chinese = "你好世界";           // 8 bytes（4 字 × 2）
        String mixed = "hello 你好";          // 8 字元 × 2 = 16 bytes（被中文拉成 UTF16 模式）

        System.out.println(ascii.length());   // 11
        System.out.println(chinese.length()); // 4
        System.out.println(mixed.length());   // 8
    }
}
```

**實務影響**：純英文的資料（ID、SKU、email、URL、log 訊息）在 Java 9+ 省一半記憶體。
這是升級 JDK 就免費拿到的收益之一——一個放了幾百萬個 String 的快取，記憶體可能直接砍半。

> 想關掉（幾乎不需要）：`-XX:-CompactStrings`。

### 字串池與 `intern()`

第 01 章 1.9 節講過 `==` 的坑，這裡補上實務判斷。

```java
public class InternDemo {
    public static void main(String[] args) {
        String a = "PAID";                          // 常值 → 直接在池裡
        String b = new String("PAID");              // 堆積上的新物件
        String c = b.intern();                      // 回傳池裡那一個

        System.out.println(a == b);                 // false
        System.out.println(a == c);                 // true
        System.out.println(a.equals(b));            // true

        // 執行期組出來的字串不在池裡
        String d = "PA" + getSuffix();
        System.out.println(a == d);                 // false
        System.out.println(a == d.intern());        // true
    }

    static String getSuffix() { return "ID"; }
}
```

**該不該用 `intern()`？** 幾乎不該。

| 情況 | 建議 |
|---|---|
| 想節省記憶體（大量重複字串） | ⚠️ 可考慮，但**先量測**。字串池在 Java 7+ 位於堆積，`intern()` 本身有雜湊查找成本 |
| 想用 `==` 比較 | ❌ 絕對不要。改用 `equals` |
| 從 DB 讀出大量重複的狀態碼 / 分類名 | ✅ 更好的做法是**轉成 enum**，或自己維護一個 `Map<String,String>` 快取 |

```java
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class StringDedup {

    // ✅ 自己的字串快取：可控、可監控、可清空。比 intern() 好管理
    private static final Map<String, String> POOL = new ConcurrentHashMap<>();

    static String dedup(String s) {
        if (s == null) return null;
        // computeIfAbsent 是原子的（第 05 章 5.13 節）
        return POOL.computeIfAbsent(s, k -> k);
    }

    public static void main(String[] args) {
        String s1 = dedup(new String("SHIPPED"));
        String s2 = dedup(new String("SHIPPED"));
        System.out.println(s1 == s2);        // true，兩者共用同一個物件
        System.out.println(POOL.size());     // 1
    }
}
```

> **注意 `POOL` 是 `static` 且永不清空——這是第 09 章要抓的記憶體洩漏樣本。**
> 真的要用，改成 Caffeine 的 `maximumSize` 快取。

---

## 7.3 `StringBuilder`：什麼時候真的需要

第 00 章練習 3 用 `javap` 看過：Java 9+ 的單次串接會被編譯成 `invokedynamic`，不需要手動最佳化。
真正的問題在**迴圈**。

```java
public class StringConcatBenchmark {

    static final int N = 50_000;

    public static void main(String[] args) {
        // 暖機（第 00 章 0.9 節）
        for (int i = 0; i < 3; i++) { builder(1000); concatInLoop(1000); }

        System.out.println("=== 迴圈中串接 " + N + " 次 ===");
        System.out.println("StringBuilder : " + builder(N) + " ms");
        System.out.println("+= 串接        : " + concatInLoop(N) + " ms");

        System.out.println("\n=== 單次串接 100 萬次 ===");
        System.out.println("+ 串接         : " + singleConcat() + " ms");
        System.out.println("StringBuilder : " + singleBuilder() + " ms");
    }

    static long builder(int n) {
        long start = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(i).append(',');
        String result = sb.toString();
        return System.currentTimeMillis() - start;
    }

    static long concatInLoop(int n) {
        long start = System.currentTimeMillis();
        String result = "";
        for (int i = 0; i < n; i++) result += i + ",";     // 每圈都建新 String
        return System.currentTimeMillis() - start;
    }

    static long singleConcat() {
        long start = System.currentTimeMillis();
        String s = null;
        for (int i = 0; i < 1_000_000; i++) s = "a" + i + "b";
        return System.currentTimeMillis() - start;
    }

    static long singleBuilder() {
        long start = System.currentTimeMillis();
        String s = null;
        for (int i = 0; i < 1_000_000; i++) s = new StringBuilder().append("a").append(i).append("b").toString();
        return System.currentTimeMillis() - start;
    }
}
```

典型結果：

```
=== 迴圈中串接 50000 次 ===
StringBuilder : 4 ms
+= 串接        : 3200 ms          ← 慢了 800 倍（O(n²)）

=== 單次串接 100 萬次 ===
+ 串接         : 42 ms
StringBuilder : 55 ms             ← 手動 StringBuilder 反而略慢
```

**結論：**

| 情況 | 用什麼 |
|---|---|
| 迴圈中累積字串 | **`StringBuilder`**（差距是數量級的） |
| 單次串接幾個變數 | **`+`**（更好讀，編譯器已最佳化） |
| 用集合的元素組字串 | **`String.join`** 或 `Collectors.joining()` |
| 多執行緒共用同一個 builder | 重新設計；真要用才選 `StringBuffer`（全方法 `synchronized`，單執行緒下純浪費） |

### `StringBuilder` 的實用技巧

```java
public class StringBuilderTips {
    public static void main(String[] args) {

        // ① 預估容量，避免多次擴容（預設 16，每次擴容 2n+2 並複製）
        StringBuilder sb = new StringBuilder(1024);

        // ② 常用方法
        sb.append("hello").append(' ').append(42).append(true);
        sb.insert(0, ">> ");
        sb.replace(0, 2, "**");
        sb.reverse();
        sb.reverse();                       // 轉回來
        System.out.println(sb);             // ** hello 42true
        System.out.println(sb.indexOf("hello"));    // 3
        sb.setLength(0);                    // ✅ 清空並「重用」容量，比 new 一個快

        // ③ 組 SQL / CSV 的常見樣板：處理分隔符
        String[] fields = {"id", "name", "email"};

        // ❌ 手動判斷第一個
        StringBuilder bad = new StringBuilder();
        for (int i = 0; i < fields.length; i++) {
            if (i > 0) bad.append(", ");
            bad.append(fields[i]);
        }

        // ✅ String.join 一行
        System.out.println(String.join(", ", fields));      // id, name, email

        // ✅ 需要前後綴時用 StringJoiner
        var joiner = new java.util.StringJoiner(", ", "SELECT ", " FROM users");
        for (String f : fields) joiner.add(f);
        System.out.println(joiner);         // SELECT id, name, email FROM users

        // StringJoiner 的空值處理
        var empty = new java.util.StringJoiner(",", "[", "]");
        empty.setEmptyValue("(無資料)");
        System.out.println(empty);          // (無資料)
    }
}
```

---

## 7.4 字元編碼：`length()` 說謊的時候

這一節是實務上「字數限制驗證」出錯的根源。

```java
public class CharEncoding {
    public static void main(String[] args) {

        String ascii = "abc";
        String chinese = "你好";
        String emoji = "👍";                 // U+1F44D，需要「兩個」UTF-16 碼元
        String family = "👨‍👩‍👧";              // 三個人 + 兩個 ZWJ（零寬連接符）

        System.out.println("--- length() 回傳的是 UTF-16 碼元數，不是字數 ---");
        System.out.printf("%-12s length=%d codePoints=%d%n", ascii, ascii.length(),
                ascii.codePointCount(0, ascii.length()));
        System.out.printf("%-12s length=%d codePoints=%d%n", chinese, chinese.length(),
                chinese.codePointCount(0, chinese.length()));
        System.out.printf("%-12s length=%d codePoints=%d%n", emoji, emoji.length(),
                emoji.codePointCount(0, emoji.length()));
        System.out.printf("%-12s length=%d codePoints=%d%n", family, family.length(),
                family.codePointCount(0, family.length()));
    }
}
```

輸出：

```
--- length() 回傳的是 UTF-16 碼元數，不是字數 ---
abc          length=3 codePoints=3
你好           length=2 codePoints=2
👍            length=2 codePoints=1      ← 一個 emoji 算 2！
👨‍👩‍👧           length=8 codePoints=5      ← 一個家庭 emoji 算 8！
```

### 實務災難：暱稱長度驗證

```java
public class NicknameValidation {

    static final int MAX = 10;

    // ❌ 使用者輸入 6 個 emoji 就被拒絕（6 × 2 = 12 > 10）
    static boolean validateBad(String nickname) {
        return nickname.length() <= MAX;
    }

    // ⚠️ 較好：算「碼點」數。但家庭 emoji 仍算 5 個
    static boolean validateBetter(String nickname) {
        return nickname.codePointCount(0, nickname.length()) <= MAX;
    }

    // ✅ 最貼近「使用者看到幾個字」：算「字形叢集（grapheme cluster）」
    static int graphemeCount(String s) {
        var it = java.text.BreakIterator.getCharacterInstance(java.util.Locale.ROOT);
        it.setText(s);
        int count = 0;
        while (it.next() != java.text.BreakIterator.DONE) count++;
        return count;
    }

    public static void main(String[] args) {
        String input = "👍👍👍👍👍👍";        // 使用者看到 6 個字

        System.out.println("length()      : " + input.length());              // 12
        System.out.println("codePointCount: " + input.codePointCount(0, input.length()));  // 6
        System.out.println("grapheme      : " + graphemeCount(input));        // 6

        System.out.println("validateBad   : " + validateBad(input));          // false ❌ 誤拒
        System.out.println("validateBetter: " + validateBetter(input));       // true
        System.out.println("grapheme <= 10: " + (graphemeCount(input) <= MAX)); // true

        String family = "👨‍👩‍👧";               // 使用者看到 1 個字
        System.out.println("\n家庭 emoji:");
        System.out.println("  length        : " + family.length());            // 8
        System.out.println("  codePointCount: " + family.codePointCount(0, family.length())); // 5
        System.out.println("  grapheme      : " + graphemeCount(family));      // 1  ✅
    }
}
```

> **實務建議**：
> - 資料庫欄位長度用 `length()` 的上限來規劃（因為 DB 存的是位元組 / 字元數）。
> - **給使用者看的錯誤訊息用字形叢集數**（「暱稱最多 10 個字」）。
> - MySQL 記得用 `utf8mb4` 而不是 `utf8`（後者只支援 3 bytes，**存不了 emoji**）。
>   這是第 07 站會再遇到的經典問題。

### 安全地截斷字串

```java
public class SafeTruncate {

    // ❌ 可能切在代理對（surrogate pair）中間，產生亂碼 �
    static String truncateBad(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    // ✅ 用 offsetByCodePoints，不會切壞字元
    static String truncateSafe(String s, int maxCodePoints) {
        if (s == null) return null;
        int count = s.codePointCount(0, s.length());
        if (count <= maxCodePoints) return s;
        int endIndex = s.offsetByCodePoints(0, maxCodePoints);
        return s.substring(0, endIndex) + "…";
    }

    public static void main(String[] args) {
        String s = "報告👍完成👍了";

        System.out.println("原始: " + s + " (length=" + s.length() + ")");
        System.out.println("bad : " + truncateBad(s, 3));       // 報告? ← 切壞了
        System.out.println("safe: " + truncateSafe(s, 3));      // 報告👍…
    }
}
```

### 位元組與字元的轉換

```java
import java.nio.charset.StandardCharsets;

public class BytesAndChars {
    public static void main(String[] args) {
        String s = "你好 world";

        // ✅ 一律明確指定編碼，不要用 getBytes() 無參數版（跟隨平台預設，環境不同結果不同）
        byte[] utf8 = s.getBytes(StandardCharsets.UTF_8);
        byte[] big5 = s.getBytes(java.nio.charset.Charset.forName("Big5"));

        System.out.println("UTF-8 位元組數: " + utf8.length);    // 12（中文 3 bytes × 2 + 6）
        System.out.println("Big5  位元組數: " + big5.length);     // 10（中文 2 bytes × 2 + 6）

        System.out.println(new String(utf8, StandardCharsets.UTF_8));      // 你好 world
        System.out.println(new String(utf8, StandardCharsets.ISO_8859_1)); // 亂碼（用錯編碼）

        System.out.println("預設編碼: " + java.nio.charset.Charset.defaultCharset());
        // Java 18+ 固定是 UTF-8（JEP 400）；之前跟隨作業系統
    }
}
```

> **鐵律：`getBytes()` 和 `new String(byte[])` 永遠帶上 `StandardCharsets.UTF_8`。**
> 不帶的版本在 Windows（MS950）和 Linux（UTF-8）上結果不同——這是「本機正常、正式環境亂碼」的頭號原因。

---

## 7.5 正規表達式

### 預編譯 `Pattern`

```java
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class RegexPerformance {

    // ❌ String.matches 每次呼叫都重新編譯 Pattern
    static boolean isEmailBad(String s) {
        return s.matches("^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$");
    }

    // ✅ 編譯一次，重複使用（Pattern 是執行緒安全的不可變物件）
    private static final Pattern EMAIL =
            Pattern.compile("^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$");

    static boolean isEmailGood(String s) {
        return s != null && EMAIL.matcher(s).matches();
    }

    public static void main(String[] args) {
        int n = 500_000;
        String input = "user@example.com";

        // 暖機
        for (int i = 0; i < 10_000; i++) { isEmailBad(input); isEmailGood(input); }

        long t1 = System.currentTimeMillis();
        for (int i = 0; i < n; i++) isEmailBad(input);
        System.out.println("每次編譯: " + (System.currentTimeMillis() - t1) + " ms");

        long t2 = System.currentTimeMillis();
        for (int i = 0; i < n; i++) isEmailGood(input);
        System.out.println("預編譯  : " + (System.currentTimeMillis() - t2) + " ms");
    }
}
```

典型結果：

```
每次編譯: 620 ms
預編譯  : 95 ms          ← 快 6 倍以上
```

> ⚠️ **`Pattern` 是執行緒安全的（不可變），但 `Matcher` 不是。**
> 所以 `Pattern` 可以 `static final` 共用，`Matcher` 必須每次 `pattern.matcher(input)` 現做。

### 常用操作

```java
import java.util.regex.MatchResult;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class RegexOperations {

    private static final Pattern ORDER_ID =
            Pattern.compile("ORD-(?<year>\\d{4})(?<month>\\d{2})(?<day>\\d{2})-(?<seq>\\d{3})");

    public static void main(String[] args) {
        String text = "訂單 ORD-20260817-001 與 ORD-20260818-042 已建立";

        Matcher m = ORDER_ID.matcher(text);
        while (m.find()) {
            System.out.printf("完整=%s 年=%s 月=%s 日=%s 序號=%s (位置 %d-%d)%n",
                    m.group(),                  // 完整比對
                    m.group("year"),            // 具名群組，比 group(1) 好維護
                    m.group("month"),
                    m.group("day"),
                    m.group("seq"),
                    m.start(), m.end());
        }

        // 取代（$1 或 ${name} 引用群組）
        System.out.println(ORDER_ID.matcher(text)
                .replaceAll("訂單[${year}/${month}/${day} #${seq}]"));

        // 用 Function 做取代（Java 9+），可以寫任意邏輯
        System.out.println(ORDER_ID.matcher(text)
                .replaceAll(r -> "ORD-***-" + r.group("seq")));

        // 切割：Pattern.split 比 String.split 快（不用重編譯）
        Pattern comma = Pattern.compile("\\s*,\\s*");
        System.out.println(java.util.Arrays.toString(comma.split("a , b,c ,  d")));
        // [a, b, c, d]

        // 找出全部比對結果（Java 9+）
        Pattern.compile("\\d+").matcher("a1b22c333")
                .results()
                .map(MatchResult::group)          // MatchResult 在 java.util.regex，不是 Matcher 的巢狀類別
                .forEach(g -> System.out.print(g + " "));       // 1 22 333
        System.out.println();

        // 跳脫使用者輸入（避免使用者輸入的 . * + 被當成 regex）
        String userInput = "a.b*c";
        System.out.println(Pattern.compile(Pattern.quote(userInput)).matcher("xa.b*cy").find());
        // true（把 userInput 當成字面字串）
    }
}
```

### ⚠️ 災難性回溯：一個真實的 DoS 漏洞

```java
import java.util.regex.Pattern;

public class CatastrophicBacktracking {

    // ❌ 巢狀量詞：(a+)+ 讓引擎需要嘗試指數級的組合
    private static final Pattern EVIL = Pattern.compile("^(a+)+$");

    // ❌ 真實世界的例子：這種「驗證 email」的 regex 在網路上到處被複製
    private static final Pattern EVIL_EMAIL =
            Pattern.compile("^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}[a-z0-9]+[.]{1}(([a-z]{2,3})|([a-z]{2,3}[.]{1}[a-z]{2,3}))$");

    public static void main(String[] args) {
        // 22 個 a 加一個 b：無法比對，但引擎會嘗試所有可能的切分方式
        String attack = "a".repeat(22) + "b";

        long start = System.currentTimeMillis();
        boolean result = EVIL.matcher(attack).matches();
        System.out.printf("22 個 a: %b，耗時 %d ms%n", result, System.currentTimeMillis() - start);

        // 每多一個 a，時間翻倍。30 個 a 就要好幾分鐘
        String attack2 = "a".repeat(26) + "b";
        start = System.currentTimeMillis();
        EVIL.matcher(attack2).matches();
        System.out.printf("26 個 a: 耗時 %d ms%n", System.currentTimeMillis() - start);
    }
}
```

典型結果：

```
22 個 a: false，耗時 180 ms
26 個 a: 耗時 2900 ms          ← 每多一個字元就翻倍
```

**攻擊者只要送一個 40 個字元的字串，就能讓一條執行緒卡住幾小時。**
幾十個請求就能打掛整台伺服器——這叫 **ReDoS（Regular expression Denial of Service）**。

**四個防禦手段：**

```java
import java.util.regex.Pattern;

public class RegexDefense {

    // ① 避免巢狀量詞。能用簡單寫法就別用複雜的
    private static final Pattern SAFE = Pattern.compile("^a+$");

    // ② 用「佔有量詞」（possessive quantifier）+ 號，關掉回溯
    private static final Pattern POSSESSIVE = Pattern.compile("^(a++)+$");

    // ③ email 這種東西不要自己寫 regex。用寬鬆檢查 + 實際寄信驗證
    private static final Pattern PRACTICAL_EMAIL =
            Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

    // ④ 對輸入長度設上限（最簡單也最有效）
    static boolean validateEmail(String input) {
        if (input == null || input.length() > 254) return false;   // RFC 5321 上限
        return PRACTICAL_EMAIL.matcher(input).matches();
    }

    public static void main(String[] args) {
        String attack = "a".repeat(30) + "b";

        long start = System.nanoTime();
        SAFE.matcher(attack).matches();
        System.out.printf("簡化寫法  : %.3f ms%n", (System.nanoTime() - start) / 1e6);

        start = System.nanoTime();
        POSSESSIVE.matcher(attack).matches();
        System.out.printf("佔有量詞  : %.3f ms%n", (System.nanoTime() - start) / 1e6);

        System.out.println(validateEmail("user@example.com"));         // true
        System.out.println(validateEmail("not-an-email"));             // false
        System.out.println(validateEmail("a".repeat(300) + "@b.com")); // false（長度先擋掉）
    }
}
```

輸出：

```
簡化寫法  : 0.012 ms
佔有量詞  : 0.008 ms
true
false
false
```

> **實務規則：**
> 1. **絕不把使用者輸入直接組進 regex**（用 `Pattern.quote`）。
> 2. **絕不從網路複製「完美的 email regex」**——那些長得像天書的 pattern 幾乎都有 ReDoS 風險。
> 3. 對所有要跑 regex 的輸入**設長度上限**。
> 4. 需要處理不受信任的 pattern（如讓使用者自訂搜尋規則），改用 RE2/J（Google 的線性時間 regex 引擎）。
>
> 這在第 09 站（Spring Security）與 `../security-course/` 會從攻擊者視角再看一次。

---

## 7.6 檔案 IO：用 NIO.2，不要用 `java.io.File`

### 為什麼要換掉 `File`

```java
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class WhyNio2 {
    public static void main(String[] args) {
        File old = new File("/tmp/nonexistent/a.txt");

        // ❌ 舊 API 的問題：失敗時只回傳 boolean，完全不知道為什麼失敗
        System.out.println("delete() = " + old.delete());
        // false —— 是檔案不存在？沒權限？被鎖住？路徑是目錄？不知道。

        System.out.println("mkdir()  = " + new File("/root/forbidden").mkdir());
        // false —— 同上

        // ✅ NIO.2：失敗會丟出「說得清楚」的例外
        try {
            Files.delete(Path.of("/tmp/nonexistent/a.txt"));
        } catch (IOException e) {
            System.out.println(e.getClass().getSimpleName() + ": " + e.getMessage());
            // NoSuchFileException: /tmp/nonexistent/a.txt
        }
    }
}
```

| | `java.io.File`（1996） | NIO.2 `Path`/`Files`（Java 7） |
|---|---|---|
| 錯誤處理 | 回傳 `false`，原因不明 | 丟出具體例外（`NoSuchFileException`、`AccessDeniedException`…） |
| 符號連結 | 支援很差 | 完整支援（`NOFOLLOW_LINKS`） |
| 檔案屬性 | 只有幾個基本的 | `PosixFileAttributes`、擴充屬性 |
| 目錄走訪 | `listFiles()` 全部載入記憶體 | `Files.walk()` 惰性串流 |
| 原子操作 | 沒有 | `ATOMIC_MOVE` |
| 監控變更 | 沒有 | `WatchService` |
| 大檔 / 零拷貝 | 沒有 | `FileChannel`、記憶體映射 |

**結論：新程式碼一律用 `Path` / `Files`。** 需要跟舊 API 互通時用 `file.toPath()` / `path.toFile()`。

### `Path` 的操作

```java
import java.nio.file.Path;
import java.nio.file.Paths;

public class PathOperations {
    public static void main(String[] args) {
        Path p = Path.of("/Users/gary/projects", "demo", "src/main/java/App.java");
        // Path.of 是 Java 11+ 的寫法；舊版用 Paths.get(...)

        System.out.println("完整路徑    : " + p);
        System.out.println("檔名        : " + p.getFileName());        // App.java
        System.out.println("父目錄      : " + p.getParent());
        System.out.println("根          : " + p.getRoot());            // /
        System.out.println("層數        : " + p.getNameCount());       // 7
        System.out.println("第 1 段     : " + p.getName(0));           // Users
        System.out.println("子路徑      : " + p.subpath(2, 4));        // projects/demo
        System.out.println("是否絕對    : " + p.isAbsolute());         // true

        // 組合與正規化
        Path relative = Path.of("demo/../demo/./src");
        System.out.println("正規化      : " + relative.normalize());   // demo/src
        System.out.println("轉絕對      : " + relative.toAbsolutePath());

        // resolve：接上子路徑
        Path base = Path.of("/var/data");
        System.out.println(base.resolve("orders/2026.csv"));           // /var/data/orders/2026.csv
        System.out.println(base.resolve("/etc/passwd"));               // /etc/passwd（絕對路徑會取代！）

        // relativize：計算相對路徑
        Path from = Path.of("/var/data/orders");
        Path to = Path.of("/var/data/reports/2026");
        System.out.println(from.relativize(to));                       // ../reports/2026

        // 比較：equals 是「字面」比較，不看檔案系統
        System.out.println(Path.of("/tmp/a").equals(Path.of("/tmp/./a")));            // false
        System.out.println(Path.of("/tmp/a").equals(Path.of("/tmp/./a").normalize())); // true
    }
}
```

### ⚠️ 路徑穿越（Path Traversal）：`resolve` 的安全陷阱

```java
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class PathTraversal {

    static final Path UPLOAD_DIR = Path.of("/var/app/uploads");

    // ❌ 使用者傳 "../../../etc/passwd" 就能讀到系統檔案
    static Path resolveBad(String userFilename) {
        return UPLOAD_DIR.resolve(userFilename);
    }

    // ✅ 正規化後驗證仍在允許的目錄內
    static Path resolveSafe(String userFilename) {
        if (userFilename == null || userFilename.isBlank()) {
            throw new IllegalArgumentException("檔名不可為空");
        }
        Path base = UPLOAD_DIR.toAbsolutePath().normalize();
        Path target = base.resolve(userFilename).normalize();

        if (!target.startsWith(base)) {
            throw new SecurityException("非法的檔案路徑: " + userFilename);
        }
        return target;
    }

    public static void main(String[] args) {
        System.out.println("正常: " + resolveSafe("photo.jpg"));
        // /var/app/uploads/photo.jpg

        System.out.println("bad : " + resolveBad("../../../etc/passwd"));
        // /etc/passwd   💥 洩漏系統檔案

        try {
            resolveSafe("../../../etc/passwd");
        } catch (SecurityException e) {
            System.out.println("safe: 擋下來了 —— " + e.getMessage());
        }

        // 絕對路徑攻擊
        try {
            resolveSafe("/etc/passwd");
        } catch (SecurityException e) {
            System.out.println("safe: 絕對路徑也擋掉");
        }
    }
}
```

> **這是 OWASP Top 10 的常見漏洞。** 任何「檔名來自使用者」的功能（頭像上傳、報表下載、附件預覽）
> 都必須做這個檢查。更安全的做法是**根本不用使用者提供的檔名**——存 UUID，把原始檔名放資料庫。

---

## 7.7 讀寫檔案

### 小檔案：一行搞定

```java
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;

public class SmallFileIo {
    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("io-demo");
        Path file = dir.resolve("notes.txt");

        // ===== 寫入 =====
        // Java 11+：一行寫入字串（預設 UTF-8）
        Files.writeString(file, "第一行\n第二行\n");

        // 附加模式
        Files.writeString(file, "第三行\n", StandardOpenOption.APPEND);

        // 寫入多行
        Files.write(dir.resolve("lines.txt"),
                List.of("A", "B", "C"), StandardCharsets.UTF_8);

        // 寫入位元組
        Files.write(dir.resolve("data.bin"), new byte[]{1, 2, 3});

        // ===== 讀取 =====
        System.out.println("--- readString ---");
        System.out.print(Files.readString(file));               // Java 11+

        System.out.println("--- readAllLines ---");
        System.out.println(Files.readAllLines(file));           // [第一行, 第二行, 第三行]

        System.out.println("--- readAllBytes ---");
        System.out.println(Files.readAllBytes(dir.resolve("data.bin")).length);   // 3

        // ===== 常用查詢 =====
        System.out.println("存在      : " + Files.exists(file));
        System.out.println("是普通檔案: " + Files.isRegularFile(file));
        System.out.println("大小      : " + Files.size(file) + " bytes");
        System.out.println("可讀      : " + Files.isReadable(file));
        System.out.println("最後修改  : " + Files.getLastModifiedTime(file));

        // 清理
        try (var stream = Files.walk(dir)) {
            stream.sorted(java.util.Comparator.reverseOrder())    // 先刪檔案再刪目錄
                    .forEach(p -> {
                        try { Files.delete(p); } catch (IOException ignored) { }
                    });
        }
    }
}
```

> ⚠️ **`Files.readString` / `readAllLines` / `readAllBytes` 會把整個檔案載入記憶體。**
> 檔案大小不確定時（使用者上傳、log 檔）**絕對不要用**——一個 2GB 的檔案直接 OOM。

### 大檔案：串流處理

```java
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

public class LargeFileIo {

    /** ✅ Files.lines：惰性讀取，記憶體只保留當前一行 */
    static long countErrorLines(Path logFile) throws IOException {
        // ⚠️ 一定要 try-with-resources！Files.lines 會開一個檔案句柄
        try (Stream<String> lines = Files.lines(logFile)) {
            return lines.filter(line -> line.contains("ERROR")).count();
        }
    }

    /** ✅ BufferedReader：需要行號、需要 break、或有 checked 例外時（第 06 章 6.16 節）*/
    static void processWithLineNumbers(Path file) throws IOException {
        try (var reader = Files.newBufferedReader(file)) {
            String line;
            int lineNo = 0;
            while ((line = reader.readLine()) != null) {
                lineNo++;
                if (line.isBlank()) continue;
                if (lineNo > 1_000_000) {
                    System.out.println("超過 100 萬行，停止處理");
                    break;                       // Stream 做不到這件事
                }
                // 處理...
            }
            System.out.println("處理了 " + lineNo + " 行");
        }
    }

    /** ✅ 邊讀邊寫：轉換大檔而不吃記憶體 */
    static void transform(Path in, Path out) throws IOException {
        try (var reader = Files.newBufferedReader(in);
             var writer = Files.newBufferedWriter(out)) {
            String line;
            while ((line = reader.readLine()) != null) {
                writer.write(line.toUpperCase());
                writer.newLine();
            }
        }
        // 關閉順序與宣告相反：writer 先關（第 04 章 4.8 節），確保緩衝區被寫出
    }

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("large-io");
        Path log = dir.resolve("app.log");

        // 造一個 10 萬行的假 log
        try (var writer = Files.newBufferedWriter(log)) {
            for (int i = 1; i <= 100_000; i++) {
                writer.write("%s [%s] 訊息 %d".formatted(
                        java.time.LocalDateTime.now(),
                        i % 100 == 0 ? "ERROR" : "INFO", i));
                writer.newLine();
            }
        }

        System.out.println("檔案大小: " + Files.size(log) / 1024 + " KB");
        System.out.println("ERROR 行數: " + countErrorLines(log));    // 1000
        processWithLineNumbers(log);
        transform(log, dir.resolve("upper.log"));
        System.out.println("轉換完成");

        try (var s = Files.walk(dir)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) { }
            });
        }
    }
}
```

> ⚠️ **`Files.lines()`、`Files.walk()`、`Files.list()`、`Files.find()` 回傳的 Stream 都持有檔案句柄，
> 必須用 try-with-resources。** 忘記關的話，句柄會累積直到
> `Too many open files`（Linux 預設每個程序 1024 個）——這是很難查的線上問題，
> 因為它要跑幾小時才會出現。

### ⚠️ 原子性寫入：不要留下半個檔案

```java
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

public class AtomicWrite {

    /**
     * ❌ 直接覆寫的問題：
     *   ① 寫到一半當機／OOM／被 kill → 檔案內容是壞的，舊資料也沒了
     *   ② 有別的程序正在讀 → 讀到一半的內容
     */
    static void writeBad(Path target, String content) throws IOException {
        Files.writeString(target, content);
    }

    /**
     * ✅ 寫入暫存檔 → 原子搬移。
     * 讀者看到的永遠是「完整的舊版」或「完整的新版」，不會有中間狀態。
     */
    static void writeAtomic(Path target, String content) throws IOException {
        Path dir = target.toAbsolutePath().getParent();
        Files.createDirectories(dir);

        // 暫存檔必須在「同一個檔案系統」上，ATOMIC_MOVE 才保證原子性
        Path temp = Files.createTempFile(dir, target.getFileName().toString(), ".tmp");
        try {
            Files.writeString(temp, content);
            Files.move(temp, target,
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            Files.deleteIfExists(temp);          // 失敗時清掉垃圾
            throw e;
        }
    }

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("atomic");
        Path target = dir.resolve("config.json");

        writeAtomic(target, "{\"version\": 1}");
        System.out.println(Files.readString(target));

        writeAtomic(target, "{\"version\": 2}");
        System.out.println(Files.readString(target));

        // 目錄裡沒有殘留的 .tmp 檔
        try (var s = Files.list(dir)) {
            System.out.println("目錄內容: " + s.map(p -> p.getFileName().toString()).toList());
        }

        try (var s = Files.walk(dir)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) { }
            });
        }
    }
}
```

輸出：

```
{"version": 1}
{"version": 2}
目錄內容: [config.json]
```

> **什麼時候需要原子寫入？** 任何「別人會讀」的檔案：設定檔、快取檔、匯出的報表、
> 資料檔（第 7.13 節的待辦事項存檔就會用到）。
>
> **`ATOMIC_MOVE` 的限制**：跨檔案系統（例如從 `/tmp` 搬到 `/var`）會丟 `AtomicMoveNotSupportedException`。
> 所以暫存檔一定要建在**目標的同一個目錄**下。

### ⚠️ `Files.exists` 的競態條件（TOCTOU）

```java
import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

public class TocTou {

    // ❌ 檢查與使用之間有時間差（Time-Of-Check to Time-Of-Use）
    //    另一個執行緒／程序可能在這之間建立了檔案
    static void createBad(Path p) throws IOException {
        if (!Files.exists(p)) {
            Files.createFile(p);          // 可能丟 FileAlreadyExistsException
        }
    }

    // ✅ 讓檔案系統用單一原子操作幫你判斷
    static boolean createIfAbsent(Path p) throws IOException {
        try {
            Files.createFile(p);          // CREATE_NEW 語意：已存在就丟例外
            return true;
        } catch (FileAlreadyExistsException e) {
            return false;
        }
    }

    // ✅ 建目錄用 createDirectories（已存在不會失敗，本身就是冪等的）
    static void ensureDir(Path dir) throws IOException {
        Files.createDirectories(dir);
    }

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("toctou");
        Path f = dir.resolve("lock.txt");

        System.out.println("第一次建立: " + createIfAbsent(f));     // true
        System.out.println("第二次建立: " + createIfAbsent(f));     // false

        ensureDir(dir.resolve("a/b/c"));
        ensureDir(dir.resolve("a/b/c"));                            // 再呼叫也不會失敗
        System.out.println("巢狀目錄已建立");

        try (var s = Files.walk(dir)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) { }
            });
        }
    }
}
```

---

## 7.8 目錄操作與走訪

```java
import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Comparator;
import java.util.List;

public class DirectoryOperations {

    public static void main(String[] args) throws IOException {
        Path root = Files.createTempDirectory("walk-demo");

        // 建立測試結構
        Files.createDirectories(root.resolve("src/main/java"));
        Files.createDirectories(root.resolve("src/test/java"));
        Files.createDirectories(root.resolve("target/classes"));
        Files.writeString(root.resolve("pom.xml"), "<project/>");
        Files.writeString(root.resolve("src/main/java/App.java"), "class App {}");
        Files.writeString(root.resolve("src/main/java/Util.java"), "class Util {}");
        Files.writeString(root.resolve("src/test/java/AppTest.java"), "class AppTest {}");
        Files.writeString(root.resolve("target/classes/App.class"), "binary");

        // ① list：只列出直接子項（不遞迴）
        System.out.println("--- list（直接子項）---");
        try (var s = Files.list(root)) {
            s.forEach(p -> System.out.println("  " + p.getFileName()));
        }

        // ② walk：遞迴走訪（惰性）
        System.out.println("--- walk 找出所有 .java ---");
        try (var s = Files.walk(root)) {
            s.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".java"))
                    .map(root::relativize)
                    .sorted()
                    .forEach(p -> System.out.println("  " + p));
        }

        // ③ walk 限制深度
        System.out.println("--- walk 深度 2 ---");
        try (var s = Files.walk(root, 2)) {
            s.map(root::relativize).filter(p -> !p.toString().isEmpty())
                    .sorted().forEach(p -> System.out.println("  " + p));
        }

        // ④ find：走訪 + 條件一次做完
        System.out.println("--- find 大於 10 bytes 的檔案 ---");
        try (var s = Files.find(root, Integer.MAX_VALUE,
                (path, attrs) -> attrs.isRegularFile() && attrs.size() > 10)) {
            s.forEach(p -> {
                try {
                    System.out.printf("  %-40s %d bytes%n", root.relativize(p), Files.size(p));
                } catch (IOException ignored) { }
            });
        }

        // ⑤ newDirectoryStream + glob：檔名樣式比對
        System.out.println("--- glob *.xml ---");
        try (var s = Files.newDirectoryStream(root, "*.xml")) {
            s.forEach(p -> System.out.println("  " + p.getFileName()));
        }

        // ⑥ 統計：每種副檔名的檔案數與總大小
        System.out.println("--- 依副檔名統計 ---");
        try (var s = Files.walk(root)) {
            s.filter(Files::isRegularFile)
                    .collect(java.util.stream.Collectors.groupingBy(
                            p -> {
                                String name = p.getFileName().toString();
                                int dot = name.lastIndexOf('.');
                                return dot < 0 ? "(無)" : name.substring(dot);
                            },
                            java.util.TreeMap::new,
                            java.util.stream.Collectors.counting()))
                    .forEach((ext, count) -> System.out.printf("  %-8s %d 個%n", ext, count));
        }

        // ⑦ 複製整個目錄樹（walkFileTree 是需要細緻控制時的工具）
        Path copy = root.resolveSibling(root.getFileName() + "-copy");
        copyDirectory(root, copy);
        System.out.println("--- 複製後 ---");
        try (var s = Files.walk(copy)) {
            System.out.println("  項目數: " + s.count());
        }

        // ⑧ 遞迴刪除（沒有內建方法！這是標準做法）
        deleteRecursively(root);
        deleteRecursively(copy);
        System.out.println("已清理: " + !Files.exists(root));
    }

    /** 複製目錄樹 */
    static void copyDirectory(Path source, Path target) throws IOException {
        Files.walkFileTree(source, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs)
                    throws IOException {
                Files.createDirectories(target.resolve(source.relativize(dir)));
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
                    throws IOException {
                Files.copy(file, target.resolve(source.relativize(file)),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /** 遞迴刪除：先深後淺（reverseOrder 讓子項排在父項之前） */
    static void deleteRecursively(Path root) throws IOException {
        if (!Files.exists(root)) return;
        try (var s = Files.walk(root)) {
            List<Path> paths = s.sorted(Comparator.reverseOrder()).toList();
            for (Path p : paths) {
                Files.delete(p);
            }
        }
    }
}
```

輸出（節錄）：

```
--- walk 找出所有 .java ---
  src/main/java/App.java
  src/main/java/Util.java
  src/test/java/AppTest.java
--- 依副檔名統計 ---
  .class   1 個
  .java    3 個
  .xml     1 個
```

> **`deleteRecursively` 的 `reverseOrder()` 是關鍵**：`Files.delete` 不能刪非空目錄，
> 所以必須先刪最深的檔案。這段程式碼值得存下來——JDK 到現在都沒有內建的遞迴刪除。
> （Apache Commons IO 的 `FileUtils.deleteDirectory` 或 Spring 的 `FileSystemUtils.deleteRecursively` 也可以用。）

---

## 7.9 CSV 處理：一個看似簡單的實務陷阱

```java
public class WhyNotSplit {
    public static void main(String[] args) {
        // 看起來很簡單
        String simple = "1001,鍵盤,2990";
        System.out.println(java.util.Arrays.toString(simple.split(",")));
        // [1001, 鍵盤, 2990]  ✅

        // 但真實的 CSV 長這樣
        String real = "1001,\"鍵盤, 無線\",2990";
        System.out.println(java.util.Arrays.toString(real.split(",")));
        // [1001, "鍵盤,  無線", 2990]  ❌ 應該是 3 欄，但欄位內容被拆爛

        // 引號內的引號要用兩個引號逃脫
        String escaped = "1001,\"22\"\" 螢幕\",8990";
        System.out.println(java.util.Arrays.toString(escaped.split(",")));
        // ❌ 完全不對

        // 欄位內可以有換行
        String multiline = "1001,\"商品說明：\n第二行\",2990";
        System.out.println(multiline.split(",").length);
        // ❌ 一筆資料橫跨兩行，逐行讀取就壞了
    }
}
```

### 手寫一個能用的 CSV 解析器

實務上應該用函式庫，但看懂它的邏輯很有價值——這樣你才知道函式庫在幫你處理什麼。

```java
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** 符合 RFC 4180 的最小 CSV 解析器（支援引號、逃脫引號、欄位內換行） */
public final class SimpleCsv {

    private SimpleCsv() { }

    /** 解析一整份 CSV。回傳每一列的欄位清單 */
    public static List<List<String>> parse(Reader source) throws IOException {
        List<List<String>> rows = new ArrayList<>();
        List<String> currentRow = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean inQuotes = false;

        int c;
        while ((c = source.read()) != -1) {
            char ch = (char) c;

            if (inQuotes) {
                if (ch == '"') {
                    // 看下一個字元：是逃脫的引號還是結束引號？
                    int next = source.peek();
                    if (next == '"') {
                        source.read();          // 吃掉第二個引號
                        field.append('"');
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field.append(ch);           // 引號內的逗號與換行都是普通字元
                }
                continue;
            }

            switch (ch) {
                case '"' -> inQuotes = true;
                case ',' -> {
                    currentRow.add(field.toString());
                    field.setLength(0);
                }
                case '\r' -> { /* 忽略，等 \n */ }
                case '\n' -> {
                    currentRow.add(field.toString());
                    field.setLength(0);
                    rows.add(List.copyOf(currentRow));
                    currentRow.clear();
                }
                default -> field.append(ch);
            }
        }

        // 最後一列可能沒有換行結尾
        if (field.length() > 0 || !currentRow.isEmpty()) {
            currentRow.add(field.toString());
            rows.add(List.copyOf(currentRow));
        }
        return rows;
    }

    public static List<List<String>> parseFile(Path path) throws IOException {
        try (BufferedReader br = Files.newBufferedReader(path)) {
            return parse(new Reader(br));
        }
    }

    /** 把一列資料寫成 CSV 格式（該加引號的加引號） */
    public static String toLine(List<String> fields) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < fields.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(escape(fields.get(i)));
        }
        return sb.toString();
    }

    private static String escape(String value) {
        if (value == null) return "";
        boolean needsQuotes = value.indexOf(',') >= 0 || value.indexOf('"') >= 0
                || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0;
        if (!needsQuotes) return value;
        return '"' + value.replace("\"", "\"\"") + '"';
    }

    /** 帶「預讀一個字元」能力的讀取器 */
    static final class Reader {
        private final java.io.Reader delegate;
        private int pushedBack = -2;                // -2 表示沒有預讀的字元

        Reader(java.io.Reader delegate) { this.delegate = delegate; }

        int read() throws IOException {
            if (pushedBack != -2) {
                int c = pushedBack;
                pushedBack = -2;
                return c;
            }
            return delegate.read();
        }

        int peek() throws IOException {
            if (pushedBack == -2) {
                pushedBack = delegate.read();
            }
            return pushedBack;
        }
    }

    // ===== 測試 =====

    public static void main(String[] args) throws IOException {
        String csv = """
                id,name,price,note
                1001,"鍵盤, 無線",2990,普通
                1002,"22"" 螢幕",8990,"說明：
                第二行"
                1003,滑鼠,890,
                """;

        Path dir = Files.createTempDirectory("csv");
        Path file = dir.resolve("products.csv");
        Files.writeString(file, csv);

        List<List<String>> rows = parseFile(file);

        System.out.println("列數: " + rows.size());
        for (int i = 0; i < rows.size(); i++) {
            System.out.printf("第 %d 列（%d 欄）: %s%n", i, rows.get(i).size(), rows.get(i));
        }

        System.out.println("\n--- 寫回 CSV ---");
        for (List<String> row : rows) {
            System.out.println(toLine(row));
        }

        Files.delete(file);
        Files.delete(dir);
    }
}
```

輸出：

```
列數: 4
第 0 列（4 欄）: [id, name, price, note]
第 1 列（4 欄）: [1001, 鍵盤, 無線, 2990, 普通]
第 2 列（4 欄）: [1002, 22" 螢幕, 8990, 說明：
第二行]
第 3 列（4 欄）: [1003, 滑鼠, 890, ]

--- 寫回 CSV ---
id,name,price,note
1001,"鍵盤, 無線",2990,普通
1002,"22"" 螢幕",8990,"說明：
第二行"
1003,滑鼠,890,
```

> **實務上請用函式庫**：`Apache Commons CSV`、`OpenCSV`、`univocity-parsers`（最快）。
> 上面這 100 行只處理了基本情況——真實的 CSV 還有 BOM、不同分隔符、編碼偵測、
> 欄位數不一致、Excel 的方言差異。**自己寫 CSV 解析器是典型的「以為很簡單」陷阱。**

```xml
<!-- 加進 pom.xml -->
<dependency>
  <groupId>org.apache.commons</groupId>
  <artifactId>commons-csv</artifactId>
  <version>1.12.0</version>
</dependency>
```

```java
// Commons CSV 的等價寫法：4 行取代上面 100 行
// try (var reader = Files.newBufferedReader(file);
//      var parser = org.apache.commons.csv.CSVFormat.DEFAULT
//              .builder().setHeader().setSkipHeaderRecord(true).build()
//              .parse(reader)) {
//     for (var record : parser) {
//         System.out.println(record.get("name") + " " + record.get("price"));
//     }
// }
```

---

## 7.10 UTF-8 BOM：一個常見的「第一欄怪怪的」

```java
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public class BomHandling {

    static final String BOM = "﻿";

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("bom");
        Path file = dir.resolve("excel-export.csv");

        // Excel 匯出的 UTF-8 CSV 通常帶 BOM
        Files.writeString(file, BOM + "id,name\n1001,鍵盤\n");

        String content = Files.readString(file);
        String firstHeader = content.split("\n")[0].split(",")[0];

        System.out.println("第一欄名稱      : [" + firstHeader + "]");
        System.out.println("等於 \"id\" 嗎？ : " + firstHeader.equals("id"));    // false！
        System.out.println("長度            : " + firstHeader.length());        // 3（不是 2）
        System.out.println("第一個字元的碼點: U+" +
                Integer.toHexString(firstHeader.codePointAt(0)).toUpperCase());  // U+FEFF

        // ✅ 讀取時去掉 BOM
        String clean = stripBom(content);
        System.out.println("去 BOM 後       : " + clean.split("\n")[0].split(",")[0].equals("id"));

        // ✅ 寫給 Excel 看的 CSV「要」加 BOM，否則 Excel 會用系統編碼開啟 → 中文亂碼
        Files.writeString(dir.resolve("for-excel.csv"), BOM + "商品,價格\n鍵盤,2990\n");
        System.out.println("已寫出帶 BOM 的 Excel 相容 CSV");

        Files.delete(file);
        Files.delete(dir.resolve("for-excel.csv"));
        Files.delete(dir);
    }

    static String stripBom(String s) {
        return s != null && s.startsWith(BOM) ? s.substring(1) : s;
    }
}
```

輸出：

```
第一欄名稱      : [﻿id]
等於 "id" 嗎？ : false
長度            : 3
第一個字元的碼點: U+FEFF
去 BOM 後       : true
已寫出帶 BOM 的 Excel 相容 CSV
```

> **兩個方向都要記住：**
> - **讀** 使用者上傳的 CSV → 去掉 BOM，否則第一欄的欄位名永遠對不上。
> - **寫** 給使用者用 Excel 開的 CSV → 加上 BOM，否則中文變亂碼。
>
> 這是「客戶說我們的匯出功能中文亂碼」的標準答案。

---

## 7.11 `java.time`：先選對型別

Java 8 之前的 `Date` / `Calendar` / `SimpleDateFormat` 有一堆設計問題（可變、非執行緒安全、
月份從 0 開始、年份從 1900 起算）。**新程式碼一律用 `java.time`。**

### 五個核心型別

```
                有日期  有時間  有時區/偏移   代表什麼
LocalDate         ✅     ❌      ❌         「一天」：生日、到職日、結算日
LocalTime         ❌     ✅      ❌         「一天中的時刻」：營業時間 09:00
LocalDateTime     ✅     ✅      ❌         「牆上時鐘」：會議 8/17 14:00（哪個時區未定）
Instant           ✅     ✅      UTC        「時間軸上的一個點」：事件發生的瞬間
ZonedDateTime     ✅     ✅      ZoneId     完整資訊：2026-08-17T14:00+08:00[Asia/Taipei]
OffsetDateTime    ✅     ✅      ZoneOffset 固定偏移，沒有 DST 規則：...T14:00+08:00
```

```java
import java.time.*;

public class TimeTypes {
    public static void main(String[] args) {

        // ===== LocalDate：只有日期 =====
        LocalDate today = LocalDate.now();
        LocalDate birthday = LocalDate.of(1990, 5, 20);
        LocalDate parsed = LocalDate.parse("2026-08-17");
        System.out.println("LocalDate     : " + parsed);              // 2026-08-17
        System.out.println("  月份        : " + parsed.getMonth());    // AUGUST（不是 0-based！）
        System.out.println("  月份數字    : " + parsed.getMonthValue()); // 8
        System.out.println("  星期        : " + parsed.getDayOfWeek()); // MONDAY
        System.out.println("  第幾天      : " + parsed.getDayOfYear()); // 229
        System.out.println("  閏年        : " + parsed.isLeapYear());   // false
        System.out.println("  該月天數    : " + parsed.lengthOfMonth()); // 31

        // ===== LocalTime =====
        LocalTime openTime = LocalTime.of(9, 30);
        LocalTime closeTime = LocalTime.of(21, 0);
        System.out.println("LocalTime     : " + openTime);            // 09:30

        // ===== LocalDateTime：沒有時區的「牆上時間」=====
        LocalDateTime meeting = LocalDateTime.of(2026, 8, 17, 14, 0);
        System.out.println("LocalDateTime : " + meeting);             // 2026-08-17T14:00
        System.out.println("  組合        : " + parsed.atTime(openTime));
        System.out.println("  拆解        : " + meeting.toLocalDate() + " / " + meeting.toLocalTime());

        // ===== Instant：時間軸上的瞬間，永遠是 UTC =====
        Instant now = Instant.now();
        System.out.println("Instant       : " + now);                 // 2026-08-17T06:30:00.123Z
        System.out.println("  epoch 秒    : " + now.getEpochSecond());
        System.out.println("  epoch 毫秒  : " + now.toEpochMilli());
        System.out.println("  從毫秒建立  : " + Instant.ofEpochMilli(1755000000000L));

        // ===== ZonedDateTime：完整的「某地的某時刻」=====
        ZonedDateTime taipei = ZonedDateTime.of(meeting, ZoneId.of("Asia/Taipei"));
        System.out.println("ZonedDateTime : " + taipei);
        // 2026-08-17T14:00+08:00[Asia/Taipei]

        // 同一個瞬間，在不同時區看起來不同
        System.out.println("  → 紐約      : " + taipei.withZoneSameInstant(ZoneId.of("America/New_York")));
        System.out.println("  → 倫敦      : " + taipei.withZoneSameInstant(ZoneId.of("Europe/London")));
        System.out.println("  → UTC       : " + taipei.withZoneSameInstant(ZoneOffset.UTC));

        // ===== OffsetDateTime：固定偏移，沒有時區規則 =====
        OffsetDateTime offset = meeting.atOffset(ZoneOffset.ofHours(8));
        System.out.println("OffsetDateTime: " + offset);              // 2026-08-17T14:00+08:00

        // ===== 互相轉換 =====
        System.out.println("\n--- 轉換 ---");
        System.out.println("Instant → Zoned : " + now.atZone(ZoneId.of("Asia/Taipei")));
        System.out.println("Zoned → Instant : " + taipei.toInstant());
        System.out.println("Local → Instant : " + meeting.toInstant(ZoneOffset.ofHours(8)));
        System.out.println("Local → Zoned   : " + meeting.atZone(ZoneId.systemDefault()));
    }
}
```

### 選型決策表（實務上最重要的一張表）

| 你要表達什麼 | 用什麼 | 為什麼 |
|---|---|---|
| 生日、入職日、發票日期、合約到期日 | `LocalDate` | 「日期」本身與時區無關。你的生日在紐約也是 5/20 |
| 營業時間、鬧鐘時間 | `LocalTime` | 同上 |
| **事件發生的時刻**（建立時間、登入時間、付款時間） | `Instant` 或 `OffsetDateTime` | 這是時間軸上的一個絕對點，必須帶偏移才不會歧義 |
| 使用者輸入的「約會時間」（要跟著當地時區走） | `ZonedDateTime` | 「東京時間下週一早上 9 點」——DST 變動時要跟著調整 |
| 資料庫欄位、API 傳輸 | `Instant`（存 UTC）或 `OffsetDateTime` | 見 7.16 節 |
| 只是要「現在幾點」給人看 | `ZonedDateTime` / `LocalDateTime` | 顯示層才轉時區 |

> **一句話原則：`LocalDateTime` 沒有時區，所以它不代表任何一個真實的瞬間。**
> 用它存「訂單建立時間」是實務上最常見的錯誤——伺服器搬到別的時區，或部署到不同時區的機器，
> 資料的意義就變了。**存時間戳用 `Instant`。**

### 不可變 + 流暢 API

```java
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.temporal.TemporalAdjusters;

public class TimeManipulation {
    public static void main(String[] args) {
        LocalDate date = LocalDate.of(2026, 8, 17);

        // 所有 java.time 型別都不可變 → 每個操作回傳新物件（第 02 章 2.9 節）
        System.out.println("原始       : " + date);
        System.out.println("+7 天      : " + date.plusDays(7));
        System.out.println("+1 個月    : " + date.plusMonths(1));
        System.out.println("-1 年      : " + date.minusYears(1));
        System.out.println("原始未變   : " + date);                    // 2026-08-17

        // with：替換某個欄位
        System.out.println("改成 1 號  : " + date.withDayOfMonth(1));
        System.out.println("改成 12 月 : " + date.withMonth(12));

        // ⚠️ 月底的加減有「智慧調整」
        LocalDate jan31 = LocalDate.of(2026, 1, 31);
        System.out.println("\n1/31 + 1 個月 = " + jan31.plusMonths(1));   // 2026-02-28（不是 3/3）
        System.out.println("再 + 1 個月    = " + jan31.plusMonths(1).plusMonths(1));  // 2026-03-28
        System.out.println("直接 + 2 個月  = " + jan31.plusMonths(2));     // 2026-03-31  ← 不一樣！

        // TemporalAdjusters：常見的「相對日期」
        System.out.println("\n--- TemporalAdjusters ---");
        System.out.println("本月第一天      : " + date.with(TemporalAdjusters.firstDayOfMonth()));
        System.out.println("本月最後一天    : " + date.with(TemporalAdjusters.lastDayOfMonth()));
        System.out.println("下個月第一天    : " + date.with(TemporalAdjusters.firstDayOfNextMonth()));
        System.out.println("下週一          : " + date.with(TemporalAdjusters.next(DayOfWeek.MONDAY)));
        System.out.println("本週或下週一    : " + date.with(TemporalAdjusters.nextOrSame(DayOfWeek.MONDAY)));
        System.out.println("本月第 2 個週五 : " + date.with(TemporalAdjusters.dayOfWeekInMonth(2, DayOfWeek.FRIDAY)));
        System.out.println("本月最後一個週五: " + date.with(TemporalAdjusters.lastInMonth(DayOfWeek.FRIDAY)));

        // 自訂 adjuster：實務案例「下一個工作日」
        System.out.println("\n--- 自訂：下一個工作日 ---");
        for (LocalDate d : new LocalDate[]{
                LocalDate.of(2026, 8, 14),      // 週五
                LocalDate.of(2026, 8, 15),      // 週六
                LocalDate.of(2026, 8, 16)}) {   // 週日
            System.out.printf("  %s (%s) → %s%n", d, d.getDayOfWeek(), nextBusinessDay(d));
        }

        // 比較
        LocalDate a = LocalDate.of(2026, 1, 1);
        LocalDate b = LocalDate.of(2026, 12, 31);
        System.out.println("\na 早於 b: " + a.isBefore(b));         // true
        System.out.println("a 晚於 b: " + a.isAfter(b));            // false
        System.out.println("相等    : " + a.isEqual(b));            // false
        System.out.println("compareTo: " + a.compareTo(b));         // 負數
    }

    /** 下一個工作日：跳過週末 */
    static LocalDate nextBusinessDay(LocalDate date) {
        return date.with(temporal -> {
            LocalDate d = LocalDate.from(temporal);
            int daysToAdd = switch (d.getDayOfWeek()) {
                case FRIDAY -> 3;
                case SATURDAY -> 2;
                default -> 1;
            };
            return d.plusDays(daysToAdd);
        });
    }
}
```

輸出（節錄）：

```
1/31 + 1 個月 = 2026-02-28
再 + 1 個月    = 2026-03-28
直接 + 2 個月  = 2026-03-31  ← 不一樣！

--- 自訂：下一個工作日 ---
  2026-08-14 (FRIDAY) → 2026-08-17
  2026-08-15 (SATURDAY) → 2026-08-17
  2026-08-16 (SUNDAY) → 2026-08-17
```

> ⚠️ **`plusMonths(1).plusMonths(1)` ≠ `plusMonths(2)`**。
> 因為每一步都會把超出月底的日子往前縮。這在「每月扣款日」的計算上會出事：
> 1/31 訂閱的使用者，如果用「上次扣款日 + 1 個月」累加，扣款日會從 31 → 28 → 28 → 28 一路縮下去。
>
> **正確做法：保存「原始扣款日」（31），每次用 `原始日期.plusMonths(n)` 計算。**

---

## 7.12 時區與日光節約時間：三個經典陷阱

```java
import java.time.*;

public class TimeZoneBasics {
    public static void main(String[] args) {
        System.out.println("系統時區: " + ZoneId.systemDefault());
        System.out.println("可用時區數: " + ZoneId.getAvailableZoneIds().size());   // 約 600

        // 找出所有台灣相關的時區 ID
        ZoneId.getAvailableZoneIds().stream()
                .filter(z -> z.contains("Taipei") || z.contains("Asia/Sha"))
                .sorted().forEach(z -> System.out.println("  " + z));

        // ⚠️ 不要用縮寫！CST 同時代表 China Standard Time、Central Standard Time、Cuba Standard Time
        // ZoneId.of("CST");                    // 丟例外
        System.out.println("\n✅ 用 IANA 區域名稱: " + ZoneId.of("Asia/Taipei"));
        System.out.println("❌ 不要用固定偏移代替時區: " + ZoneOffset.ofHours(8));
        //   偏移是「結果」，時區才有「規則」（含 DST 與歷史變更）
    }
}
```

### 陷阱 1：春季調時，有些時刻「不存在」

```java
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

public class DstSpringForward {
    public static void main(String[] args) {
        ZoneId ny = ZoneId.of("America/New_York");

        // 2026-03-08 美東進入日光節約時間：凌晨 2:00 直接跳到 3:00
        // 所以 02:00 ~ 02:59 這一小時「不存在」
        LocalDateTime nonExistent = LocalDateTime.of(2026, 3, 8, 2, 30);

        ZonedDateTime adjusted = nonExistent.atZone(ny);
        System.out.println("要求的時間 : " + nonExistent);       // 2026-03-08T02:30
        System.out.println("實際得到的 : " + adjusted);           // 2026-03-08T03:30-04:00[America/New_York]
        System.out.println("→ 被自動往後推了一小時，沒有任何警告");

        // 這造成一個反直覺的結果
        ZonedDateTime before = LocalDateTime.of(2026, 3, 8, 1, 30).atZone(ny);
        ZonedDateTime after = before.plusHours(1);
        System.out.println("\n01:30 + 1 小時 = " + after);        // 03:30（不是 02:30）

        // 但「加一天」是保持本地時間，實際只過了 23 小時
        ZonedDateTime dayBefore = LocalDateTime.of(2026, 3, 7, 12, 0).atZone(ny);
        ZonedDateTime dayAfter = dayBefore.plusDays(1);
        System.out.println("\n3/7 12:00 + 1 天 = " + dayAfter);   // 3/8 12:00（本地時間相同）
        System.out.println("實際經過的小時數 = "
                + java.time.Duration.between(dayBefore, dayAfter).toHours());   // 23！
    }
}
```

輸出：

```
要求的時間 : 2026-03-08T02:30
實際得到的 : 2026-03-08T03:30-04:00[America/New_York]
→ 被自動往後推了一小時，沒有任何警告

01:30 + 1 小時 = 2026-03-08T03:30-04:00[America/New_York]

3/7 12:00 + 1 天 = 2026-03-08T12:00-04:00[America/New_York]
實際經過的小時數 = 23！
```

**實務影響**：排程系統設定「每天凌晨 2:30 跑批次」，在春季調時那天**該任務不會執行**（或被推到 3:30）。
金融結算、對帳、報表產生都可能因此少跑一天。

### 陷阱 2：秋季調時，有些時刻出現「兩次」

```java
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

public class DstFallBack {
    public static void main(String[] args) {
        ZoneId ny = ZoneId.of("America/New_York");

        // 2026-11-01 美東結束日光節約：凌晨 2:00 退回 1:00
        // 所以 01:00 ~ 01:59 出現「兩次」
        LocalDateTime ambiguous = LocalDateTime.of(2026, 11, 1, 1, 30);

        ZonedDateTime earlier = ambiguous.atZone(ny);                       // 預設選較早的
        ZonedDateTime later = earlier.withLaterOffsetAtOverlap();

        System.out.println("較早的（EDT）: " + earlier);
        System.out.println("較晚的（EST）: " + later);
        System.out.println("兩者相差     : "
                + java.time.Duration.between(earlier, later).toHours() + " 小時");
        System.out.println("是同一瞬間嗎 : " + earlier.toInstant().equals(later.toInstant()));

        System.out.println("\n這一天有幾個小時: "
                + java.time.Duration.between(
                        LocalDateTime.of(2026, 11, 1, 0, 0).atZone(ny),
                        LocalDateTime.of(2026, 11, 2, 0, 0).atZone(ny)).toHours());
    }
}
```

輸出：

```
較早的（EDT）: 2026-11-01T01:30-04:00[America/New_York]
較晚的（EST）: 2026-11-01T01:30-05:00[America/New_York]
兩者相差     : 1 小時
是同一瞬間嗎 : false

這一天有幾個小時: 25
```

**實務影響**：如果你的日誌只存 `LocalDateTime`，那天凌晨 1:30 的紀錄**無法判斷是哪一個 1:30**。
排序會錯亂，「一小時內只能操作一次」的限流會被繞過。

### 陷阱 3：`Duration` vs `Period` 在 DST 下的差別

```java
import java.time.*;

public class DurationVsPeriodDst {
    public static void main(String[] args) {
        ZoneId ny = ZoneId.of("America/New_York");
        ZonedDateTime start = LocalDateTime.of(2026, 3, 7, 12, 0).atZone(ny);

        // Duration：精確的時間量（24 小時就是 24 小時）
        ZonedDateTime byDuration = start.plus(Duration.ofDays(1));

        // Period：日曆上的量（明天的同一個「牆上時間」）
        ZonedDateTime byPeriod = start.plus(Period.ofDays(1));

        System.out.println("起點          : " + start);
        System.out.println("+ Duration 1天: " + byDuration);   // 3/8 13:00（因為少了一小時）
        System.out.println("+ Period   1天: " + byPeriod);     // 3/8 12:00
        System.out.println("兩者相差      : "
                + Duration.between(byPeriod, byDuration).toHours() + " 小時");
    }
}
```

輸出：

```
起點          : 2026-03-07T12:00-05:00[America/New_York]
+ Duration 1天: 2026-03-08T13:00-04:00[America/New_York]
+ Period   1天: 2026-03-08T12:00-04:00[America/New_York]
兩者相差      : 1 小時
```

| | `Duration` | `Period` |
|---|---|---|
| 單位 | 秒 + 奈秒（精確時間量） | 年 / 月 / 日（日曆量） |
| 「1 天」的意義 | 恰好 86400 秒 | 明天的同一個時刻 |
| 適合 | 逾時、快取 TTL、效能量測、限流視窗 | 訂閱週期、租約、年齡、帳單期間 |

### 實務規則：避開所有 DST 問題的四條原則

```java
import java.time.*;

public class TimeBestPractices {

    // ① 儲存與傳輸一律用 Instant（UTC）。時區只在「顯示」時才套用
    record OrderEvent(String orderId, Instant occurredAt) {

        String displayIn(ZoneId zone) {
            return occurredAt.atZone(zone)
                    .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss z"));
        }
    }

    // ② 需要「使用者當地的某個時刻」時，存 LocalDateTime + ZoneId 兩個欄位，
    //    不要存已經算好的 Instant（因為 DST 規則可能被政府修改！）
    record Appointment(String id, LocalDateTime localTime, ZoneId zone) {

        Instant resolveInstant() {
            return localTime.atZone(zone).toInstant();
        }
    }

    // ③ 排程避開 00:00~03:00 這個「危險區間」
    static final LocalTime SAFE_BATCH_TIME = LocalTime.of(4, 30);

    // ④ 純日期的東西就用 LocalDate，不要塞成 LocalDateTime 00:00
    record Invoice(String number, LocalDate issueDate, LocalDate dueDate) { }

    public static void main(String[] args) {
        var event = new OrderEvent("ORD-001", Instant.parse("2026-08-17T06:30:00Z"));

        System.out.println("儲存的值（UTC）: " + event.occurredAt());
        System.out.println("台北顯示       : " + event.displayIn(ZoneId.of("Asia/Taipei")));
        System.out.println("紐約顯示       : " + event.displayIn(ZoneId.of("America/New_York")));
        System.out.println("東京顯示       : " + event.displayIn(ZoneId.of("Asia/Tokyo")));

        var appt = new Appointment("A-1",
                LocalDateTime.of(2026, 11, 1, 1, 30), ZoneId.of("America/New_York"));
        System.out.println("\n預約（本地時間）: " + appt.localTime() + " @ " + appt.zone());
        System.out.println("解析成瞬間      : " + appt.resolveInstant());

        var invoice = new Invoice("INV-2026-0817",
                LocalDate.of(2026, 8, 17), LocalDate.of(2026, 9, 16));
        System.out.println("\n發票: " + invoice);
    }
}
```

輸出：

```
儲存的值（UTC）: 2026-08-17T06:30:00Z
台北顯示       : 2026-08-17 14:30:00 CST
紐約顯示       : 2026-08-17 02:30:00 EDT
東京顯示       : 2026-08-17 15:30:00 JST

預約（本地時間）: 2026-11-01T01:30 @ America/New_York
解析成瞬間      : 2026-11-01T05:30:00Z

發票: Invoice[number=INV-2026-0817, issueDate=2026-08-17, dueDate=2026-09-16]
```

> **第 ② 點常被忽略但很重要**：時區規則是**政治決定**，會變。
> 埃及 2023 年恢復了 DST、墨西哥 2022 年廢除了 DST、俄羅斯改過好幾次。
> JDK 靠 `tzdata` 更新這些規則（每年好幾次）。
>
> 如果你在 2026 年就把「2028 年某個當地時刻」算成 Instant 存起來，而該國在 2027 年改了規則，
> 你存的那個 Instant 就對應到錯的當地時間。**未來的預約要存「當地時間 + 時區」，執行時才解析。**

---

## 7.13 格式化與解析

```java
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.FormatStyle;
import java.util.Locale;

public class Formatting {

    // ✅ DateTimeFormatter 是不可變且執行緒安全的 → 可以 static final 共用
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private static final DateTimeFormatter DATETIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final DateTimeFormatter COMPACT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");
    private static final DateTimeFormatter WITH_ZONE =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss z", Locale.ROOT);

    public static void main(String[] args) {
        LocalDateTime dt = LocalDateTime.of(2026, 8, 17, 14, 30, 45);

        // ===== 內建格式 =====
        System.out.println("--- ISO 標準格式（優先用這些）---");
        System.out.println("ISO_LOCAL_DATE     : " + dt.format(DateTimeFormatter.ISO_LOCAL_DATE));
        System.out.println("ISO_LOCAL_DATE_TIME: " + dt.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME));
        System.out.println("toString()（就是 ISO）: " + dt);
        System.out.println("ISO_INSTANT        : "
                + DateTimeFormatter.ISO_INSTANT.format(Instant.parse("2026-08-17T06:30:00Z")));

        // ===== 自訂格式 =====
        System.out.println("\n--- 自訂 ---");
        System.out.println("DATE    : " + dt.format(DATE));
        System.out.println("DATETIME: " + dt.format(DATETIME));
        System.out.println("COMPACT : " + dt.format(COMPACT));

        // ===== 本地化 =====
        System.out.println("\n--- 本地化（要傳 Locale）---");
        // ⚠️ 只能用 SHORT / MEDIUM：LONG 與 FULL 的樣式含有時區欄位，
        //    套在沒有時區資訊的 LocalDateTime 上會丟
        //    DateTimeException: Unable to extract ZoneId from temporal ...
        var localized = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM);
        System.out.println("台灣: " + dt.format(localized.withLocale(Locale.TAIWAN)));
        System.out.println("美國: " + dt.format(localized.withLocale(Locale.US)));
        System.out.println("日本: " + dt.format(localized.withLocale(Locale.JAPAN)));

        // 要用 LONG / FULL，就得先給它時區
        var longStyle = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.LONG);
        ZonedDateTime zoned = dt.atZone(ZoneId.of("Asia/Taipei"));
        System.out.println("台灣(LONG): " + zoned.format(longStyle.withLocale(Locale.TAIWAN)));

        System.out.println("星期（中文）: " + dt.format(DateTimeFormatter.ofPattern("EEEE", Locale.TAIWAN)));
        System.out.println("星期（英文）: " + dt.format(DateTimeFormatter.ofPattern("EEEE", Locale.US)));

        // ===== 解析 =====
        System.out.println("\n--- 解析 ---");
        System.out.println(LocalDate.parse("2026-08-17"));                          // ISO 不用 formatter
        System.out.println(LocalDate.parse("2026/08/17", DateTimeFormatter.ofPattern("yyyy/MM/dd")));
        System.out.println(LocalDateTime.parse("2026-08-17 14:30:45", DATETIME));
        System.out.println(Instant.parse("2026-08-17T06:30:00Z"));
        System.out.println(ZonedDateTime.parse("2026-08-17T14:00+08:00[Asia/Taipei]"));

        // 解析失敗會丟 DateTimeParseException（unchecked）
        try {
            LocalDate.parse("2026-13-45");
        } catch (DateTimeParseException e) {
            System.out.println("解析失敗: " + e.getMessage());
        }

        // ⚠️ 型別不匹配：用只有日期的字串解析 LocalDateTime 會失敗
        try {
            LocalDateTime.parse("2026-08-17");
        } catch (DateTimeParseException e) {
            System.out.println("缺少時間部分: " + e.getMessage().split(":")[0]);
        }
        // ✅ 正確做法
        System.out.println("補上時間: " + LocalDate.parse("2026-08-17").atStartOfDay());
    }
}
```

### ⚠️ 格式符號的四個殺手級陷阱

```java
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

public class FormatPatternTraps {
    public static void main(String[] args) {

        // ===== 陷阱 1：YYYY vs yyyy（跨年那週會錯一年）=====
        LocalDate newYearEve = LocalDate.of(2018, 12, 31);      // 這天是週一

        System.out.println("--- 陷阱 1：YYYY vs yyyy ---");
        System.out.println("yyyy-MM-dd: " + newYearEve.format(DateTimeFormatter.ofPattern("yyyy-MM-dd")));
        System.out.println("YYYY-MM-dd: " + newYearEve.format(DateTimeFormatter.ofPattern("YYYY-MM-dd")));
        // yyyy → 2018-12-31  ✅
        // YYYY → 2019-12-31  💥 差了一年！

        // 為什麼？YYYY 是「以週為基準的年（week-based year）」。
        // 2018-12-31 屬於的那個 ISO 週（12/31 ~ 1/6），其週四落在 2019-01-03，
        // 所以該週屬於 2019 年。
        // 這個 bug 每年只在 12 月底出現幾天 —— 測試抓不到，上線才炸。
        // Twitter、iOS 都出過這個 bug。

        // ===== 陷阱 2：DD vs dd（DD 是一年中的第幾天）=====
        LocalDate aug17 = LocalDate.of(2026, 8, 17);
        System.out.println("\n--- 陷阱 2：DD vs dd ---");
        System.out.println("yyyy-MM-dd: " + aug17.format(DateTimeFormatter.ofPattern("yyyy-MM-dd")));
        System.out.println("yyyy-MM-DD: " + aug17.format(DateTimeFormatter.ofPattern("yyyy-MM-DD")));
        // dd → 17（月中的第 17 天）
        // DD → 229（年中的第 229 天）💥

        // ===== 陷阱 3：mm vs MM（分鐘 vs 月份）=====
        LocalDateTime dt = LocalDateTime.of(2026, 8, 17, 14, 30, 45);
        System.out.println("\n--- 陷阱 3：mm vs MM ---");
        System.out.println("正確 yyyy-MM-dd HH:mm:ss → " + dt.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
        System.out.println("錯誤 yyyy-mm-dd HH:MM:ss → " + dt.format(DateTimeFormatter.ofPattern("yyyy-mm-dd HH:MM:ss")));
        // 錯誤版：月份變成分鐘（30）、分鐘變成月份（8）💥

        // ===== 陷阱 4：hh vs HH（12 小時制 vs 24 小時制）=====
        LocalDateTime afternoon = LocalDateTime.of(2026, 8, 17, 14, 30);
        LocalDateTime midnight = LocalDateTime.of(2026, 8, 17, 0, 30);
        System.out.println("\n--- 陷阱 4：hh vs HH ---");
        System.out.println("14:30 用 HH:mm → " + afternoon.format(DateTimeFormatter.ofPattern("HH:mm")));
        System.out.println("14:30 用 hh:mm → " + afternoon.format(DateTimeFormatter.ofPattern("hh:mm")));
        System.out.println("00:30 用 HH:mm → " + midnight.format(DateTimeFormatter.ofPattern("HH:mm")));
        System.out.println("00:30 用 hh:mm → " + midnight.format(DateTimeFormatter.ofPattern("hh:mm")));
        // hh 沒有 a（AM/PM）就分不出上午下午 💥
        System.out.println("正確的 12 小時制 → "
                + afternoon.format(DateTimeFormatter.ofPattern("hh:mm a", java.util.Locale.US)));
    }
}
```

輸出：

```
--- 陷阱 1：YYYY vs yyyy ---
yyyy-MM-dd: 2018-12-31
YYYY-MM-dd: 2019-12-31

--- 陷阱 2：DD vs dd ---
yyyy-MM-dd: 2026-08-17
yyyy-MM-DD: 2026-08-229

--- 陷阱 3：mm vs MM ---
正確 yyyy-MM-dd HH:mm:ss → 2026-08-17 14:30:45
錯誤 yyyy-mm-dd HH:MM:ss → 2026-30-17 14:08:45

--- 陷阱 4：hh vs HH ---
14:30 用 HH:mm → 14:30
14:30 用 hh:mm → 02:30
00:30 用 HH:mm → 00:30
00:30 用 hh:mm → 12:30
正確的 12 小時制 → 02:30 PM
```

**格式符號速查（只列會用到的）：**

| 符號 | 意義 | 例 |
|---|---|---|
| `yyyy` | 年 | 2026 |
| `YYYY` | ⚠️ 以週為基準的年 | **幾乎永遠不要用** |
| `MM` | 月（數字） | 08 |
| `MMM` / `MMMM` | 月（縮寫 / 全名） | Aug / August |
| `dd` | 月中的日 | 17 |
| `DD` | ⚠️ 年中的日 | 229 |
| `HH` | 時（0-23） | 14 |
| `hh` | 時（1-12，需搭配 `a`） | 02 |
| `mm` | 分 | 30 |
| `ss` | 秒 | 45 |
| `SSS` | 毫秒 | 123 |
| `a` | AM/PM | PM |
| `EEEE` / `EEE` | 星期（全名 / 縮寫） | Monday / Mon |
| `z` / `zzzz` | 時區名 | CST / 台北標準時間 |
| `XXX` | 偏移（ISO） | +08:00 |

### ⚠️ `SimpleDateFormat` 不是執行緒安全的

如果你維護舊專案，這是一定會遇到的 bug：

```java
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class SimpleDateFormatNotThreadSafe {

    // ❌ static 的 SimpleDateFormat 是實務上最常見的併發 bug
    static final SimpleDateFormat OLD = new SimpleDateFormat("yyyy-MM-dd");

    // ✅ DateTimeFormatter 不可變，可以安全共用
    static final DateTimeFormatter NEW = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    public static void main(String[] args) throws InterruptedException {
        AtomicInteger oldErrors = new AtomicInteger();
        AtomicInteger newErrors = new AtomicInteger();

        try (ExecutorService pool = Executors.newFixedThreadPool(16)) {
            for (int i = 0; i < 2000; i++) {
                pool.submit(() -> {
                    try {
                        Date d = OLD.parse("2026-08-17");
                        if (!"2026-08-17".equals(OLD.format(d))) oldErrors.incrementAndGet();
                    } catch (ParseException | RuntimeException e) {
                        oldErrors.incrementAndGet();      // NumberFormatException / 錯的結果
                    }
                });
                pool.submit(() -> {
                    try {
                        LocalDate d = LocalDate.parse("2026-08-17", NEW);
                        if (!"2026-08-17".equals(d.format(NEW))) newErrors.incrementAndGet();
                    } catch (RuntimeException e) {
                        newErrors.incrementAndGet();
                    }
                });
            }
        }

        System.out.println("SimpleDateFormat 錯誤次數 : " + oldErrors.get());   // 通常數十到數百
        System.out.println("DateTimeFormatter 錯誤次數: " + newErrors.get());   // 0
    }
}
```

典型輸出：

```
SimpleDateFormat 錯誤次數 : 187
DateTimeFormatter 錯誤次數: 0
```

> `SimpleDateFormat` 內部有一個可變的 `Calendar` 欄位，多執行緒共用時會互相踩。
> 症狀是**偶發的** `NumberFormatException`、解析出離譜的日期（如 2202 年）。
> 偶發性讓它極難重現與除錯。
>
> **舊專案的修法（依成本排序）**：改用 `DateTimeFormatter` > 用 `ThreadLocal<SimpleDateFormat>`
> > 每次 `new SimpleDateFormat`（最慢但至少正確）。

---

## 7.14 `Duration` / `Period` / `ChronoUnit`

```java
import java.time.*;
import java.time.temporal.ChronoUnit;

public class AmountsOfTime {
    public static void main(String[] args) {

        // ===== Duration：時間量 =====
        System.out.println("--- Duration ---");
        Duration d1 = Duration.ofHours(2).plusMinutes(30);
        System.out.println("2h30m           : " + d1);                  // PT2H30M
        System.out.println("  總分鐘        : " + d1.toMinutes());       // 150
        System.out.println("  總秒          : " + d1.toSeconds());       // 9000
        System.out.println("  拆解          : " + d1.toHoursPart() + "h "
                + d1.toMinutesPart() + "m");                            // 2h 30m【Java 9+】

        Instant start = Instant.parse("2026-08-17T09:00:00Z");
        Instant end = Instant.parse("2026-08-17T17:45:30Z");
        Duration worked = Duration.between(start, end);
        System.out.println("工作時長        : " + worked);               // PT8H45M30S
        System.out.printf("  格式化        : %d 小時 %d 分 %d 秒%n",
                worked.toHours(), worked.toMinutesPart(), worked.toSecondsPart());

        System.out.println("  是否為負      : " + worked.isNegative());
        System.out.println("  乘 2          : " + worked.multipliedBy(2));

        // ===== Period：日期量 =====
        System.out.println("\n--- Period ---");
        LocalDate birth = LocalDate.of(1990, 5, 20);
        LocalDate today = LocalDate.of(2026, 8, 17);
        Period age = Period.between(birth, today);
        System.out.printf("年齡: %d 歲 %d 個月 %d 天%n",
                age.getYears(), age.getMonths(), age.getDays());        // 36 歲 2 個月 28 天
        System.out.println("Period toString: " + age);                  // P36Y2M28D

        // ⚠️ Period 的 getDays() 只是「天的部分」，不是總天數
        System.out.println("getDays()       : " + age.getDays());        // 28（不是 13233）
        System.out.println("總天數（正確）  : " + ChronoUnit.DAYS.between(birth, today));

        // ===== ChronoUnit：計算「單一單位」的差距 =====
        System.out.println("\n--- ChronoUnit ---");
        System.out.println("相差天數  : " + ChronoUnit.DAYS.between(birth, today));
        System.out.println("相差月數  : " + ChronoUnit.MONTHS.between(birth, today));
        System.out.println("相差年數  : " + ChronoUnit.YEARS.between(birth, today));
        System.out.println("相差週數  : " + ChronoUnit.WEEKS.between(birth, today));

        System.out.println("相差小時  : " + ChronoUnit.HOURS.between(start, end));
        System.out.println("相差分鐘  : " + ChronoUnit.MINUTES.between(start, end));

        // ⚠️ ChronoUnit 是「向下取整」的
        LocalDate a = LocalDate.of(2026, 1, 1);
        LocalDate b = LocalDate.of(2026, 12, 31);
        System.out.println("\n1/1 到 12/31 相差幾年: " + ChronoUnit.YEARS.between(a, b));   // 0！
        System.out.println("1/1 到 12/31 相差幾天: " + ChronoUnit.DAYS.between(a, b));      // 364

        // ===== 實務案例：可讀的「多久以前」 =====
        System.out.println("\n--- 相對時間顯示 ---");
        Instant now = Instant.parse("2026-08-17T12:00:00Z");
        for (String past : new String[]{
                "2026-08-17T11:59:30Z", "2026-08-17T11:45:00Z", "2026-08-17T09:00:00Z",
                "2026-08-15T12:00:00Z", "2026-07-01T12:00:00Z", "2024-01-01T12:00:00Z"}) {
            System.out.printf("  %s → %s%n", past, humanize(Instant.parse(past), now));
        }
    }

    /** 把時間差轉成「3 分鐘前」這種人看得懂的文字 */
    static String humanize(Instant past, Instant now) {
        Duration d = Duration.between(past, now);
        if (d.isNegative()) return "未來";

        long seconds = d.toSeconds();
        if (seconds < 60) return seconds + " 秒前";
        if (seconds < 3600) return d.toMinutes() + " 分鐘前";
        if (seconds < 86400) return d.toHours() + " 小時前";
        if (seconds < 86400 * 30) return d.toDays() + " 天前";
        if (seconds < 86400 * 365) return (d.toDays() / 30) + " 個月前";
        return (d.toDays() / 365) + " 年前";
    }
}
```

輸出（節錄）：

```
--- 相對時間顯示 ---
  2026-08-17T11:59:30Z → 30 秒前
  2026-08-17T11:45:00Z → 15 分鐘前
  2026-08-17T09:00:00Z → 3 小時前
  2026-08-15T12:00:00Z → 2 天前
  2026-07-01T12:00:00Z → 1 個月前
  2024-01-01T12:00:00Z → 2 年前
```

> ⚠️ **`Period.getDays()` 不是總天數**——它是「拆解後剩下的天數」。
> 「這個訂閱已經用了幾天？」用 `ChronoUnit.DAYS.between()`，不要用 `Period`。
> 這是實務上很常見的計算錯誤。

---

## 7.15 `Clock`：讓時間邏輯可以被測試

這一節解決第 02 章 2.6 節提過的問題：**方法裡直接呼叫 `LocalDateTime.now()` 就無法測試。**

```java
import java.time.*;

public class WhyClock {

    // ❌ 無法測試：結果依賴「執行測試的那一刻」
    static class BadCouponService {
        boolean isExpired(LocalDate expiryDate) {
            return LocalDate.now().isAfter(expiryDate);     // 從環境偷偷取值
        }

        String greet() {
            int hour = LocalTime.now().getHour();
            if (hour < 12) return "早安";
            if (hour < 18) return "午安";
            return "晚安";
        }
        // 想測「晚安」的分支，你得在晚上跑測試？
    }

    // ✅ 注入 Clock：時間變成一個明確的依賴（第 03 章 3.13 節的依賴注入）
    static class CouponService {
        private final Clock clock;

        CouponService(Clock clock) {
            this.clock = java.util.Objects.requireNonNull(clock, "clock 不可為 null");
        }

        boolean isExpired(LocalDate expiryDate) {
            return LocalDate.now(clock).isAfter(expiryDate);
        }

        String greet() {
            int hour = LocalTime.now(clock).getHour();
            if (hour < 12) return "早安";
            if (hour < 18) return "午安";
            return "晚安";
        }

        Instant now() {
            return clock.instant();
        }
    }

    public static void main(String[] args) {
        // 正式環境
        var prod = new CouponService(Clock.systemDefaultZone());
        System.out.println("正式環境問候: " + prod.greet());

        // 測試：把時間固定在任何你想要的瞬間
        System.out.println("\n--- 用 Clock.fixed 測試各分支 ---");
        for (String time : new String[]{"01:00", "09:00", "14:00", "22:00"}) {
            Clock fixed = Clock.fixed(
                    LocalDateTime.parse("2026-08-17T" + time).atZone(ZoneId.of("Asia/Taipei")).toInstant(),
                    ZoneId.of("Asia/Taipei"));
            System.out.printf("  %s → %s%n", time, new CouponService(fixed).greet());
        }

        System.out.println("\n--- 測試優惠券過期 ---");
        Clock aug17 = Clock.fixed(
                Instant.parse("2026-08-17T00:00:00Z"), ZoneId.of("Asia/Taipei"));
        var service = new CouponService(aug17);
        System.out.println("  到期日 8/16 已過期? " + service.isExpired(LocalDate.of(2026, 8, 16)));  // true
        System.out.println("  到期日 8/17 已過期? " + service.isExpired(LocalDate.of(2026, 8, 17)));  // false
        System.out.println("  到期日 8/18 已過期? " + service.isExpired(LocalDate.of(2026, 8, 18)));  // false

        // 其他有用的 Clock
        System.out.println("\n--- Clock 的各種變體 ---");
        System.out.println("systemUTC     : " + Clock.systemUTC().instant());
        System.out.println("固定          : " + aug17.instant());
        System.out.println("往後偏移 1 天  : " + Clock.offset(aug17, Duration.ofDays(1)).instant());
        System.out.println("每分鐘跳一次  : " + Clock.tick(Clock.systemUTC(), Duration.ofMinutes(1)).instant());
    }
}
```

輸出：

```
正式環境問候: 午安

--- 用 Clock.fixed 測試各分支 ---
  01:00 → 早安
  09:00 → 早安
  14:00 → 午安
  22:00 → 晚安

--- 測試優惠券過期 ---
  到期日 8/16 已過期? true
  到期日 8/17 已過期? false
  到期日 8/18 已過期? false

--- Clock 的各種變體 ---
systemUTC     : 2026-08-17T06:30:00.123456Z
固定          : 2026-08-17T00:00:00Z
往後偏移 1 天  : 2026-08-18T00:00:00Z
每分鐘跳一次  : 2026-08-17T06:30:00Z
```

> **在 Spring 裡怎麼做**（第 02 站會實作）：
>
> ```java
> @Configuration
> class ClockConfig {
>     @Bean
>     Clock clock() { return Clock.systemDefaultZone(); }
> }
> ```
>
> 然後 Service 用建構子注入 `Clock`。測試時注入 `Clock.fixed(...)`。
>
> **這是「跟時間有關的業務邏輯」唯一可靠的測試方式。** 對照組是用 Mockito 的 `mockStatic`
> 去攔截 `LocalDate.now()`——那能work，但很脆弱且會拖慢測試。第 11 章會比較這兩種做法。

### `Clock` 的一個進階用途：可控的「時間流動」

```java
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;

/** 測試用的可手動推進的 Clock。測快取過期、限流視窗、重試退避時非常好用 */
public class MutableClock extends Clock {

    private Instant instant;
    private final ZoneId zone;

    public MutableClock(Instant start, ZoneId zone) {
        this.instant = start;
        this.zone = zone;
    }

    @Override public ZoneId getZone() { return zone; }

    @Override public Clock withZone(ZoneId zone) { return new MutableClock(instant, zone); }

    @Override public Instant instant() { return instant; }

    /** 手動推進時間 */
    public void advance(Duration duration) { this.instant = this.instant.plus(duration); }

    // ===== 示範：測試一個帶 TTL 的快取 =====

    static class ExpiringCache<K, V> {
        private record Entry<V>(V value, Instant expiresAt) { }

        private final java.util.Map<K, Entry<V>> map = new java.util.HashMap<>();
        private final Clock clock;
        private final Duration ttl;

        ExpiringCache(Clock clock, Duration ttl) {
            this.clock = clock;
            this.ttl = ttl;
        }

        void put(K key, V value) {
            map.put(key, new Entry<>(value, clock.instant().plus(ttl)));
        }

        V get(K key) {
            Entry<V> e = map.get(key);
            if (e == null) return null;
            if (clock.instant().isAfter(e.expiresAt())) {
                map.remove(key);            // 順手清掉，避免無限成長（第 09 章）
                return null;
            }
            return e.value();
        }

        int size() { return map.size(); }
    }

    public static void main(String[] args) {
        var clock = new MutableClock(Instant.parse("2026-08-17T00:00:00Z"), ZoneId.of("UTC"));
        var cache = new ExpiringCache<String, String>(clock, Duration.ofMinutes(5));

        cache.put("session-1", "user-001");
        System.out.println("剛放入      : " + cache.get("session-1"));    // user-001

        clock.advance(Duration.ofMinutes(3));
        System.out.println("3 分鐘後    : " + cache.get("session-1"));    // user-001

        clock.advance(Duration.ofMinutes(3));
        System.out.println("6 分鐘後    : " + cache.get("session-1"));    // null（過期）
        System.out.println("已被清除    : " + (cache.size() == 0));        // true

        // 整個測試在 1 毫秒內跑完 —— 不需要真的 Thread.sleep(5 分鐘)
        System.out.println("\n✅ 測試不需要 sleep，執行時間 ≈ 0");
    }
}
```

輸出：

```
剛放入      : user-001
3 分鐘後    : user-001
6 分鐘後    : null
已被清除    : true

✅ 測試不需要 sleep，執行時間 ≈ 0
```

> **這解決了一個真實的痛點**：測試「5 分鐘後過期」如果用 `Thread.sleep(300_000)`，
> 一個測試就要 5 分鐘，整套測試根本跑不完。用 `MutableClock` 是瞬間完成。
>
> Java 生態裡有現成的：Awaitility（等待條件）、`java.time.Clock` 的各種 test double。
> 但自己寫一個 `MutableClock` 只要 20 行，很值得放進專案的測試工具包。

---

## 7.16 資料庫與 API 的時間欄位設計

這一節是把前面的原則落實到實務決策。

### Java 型別 ↔ 資料庫型別 ↔ JSON 的對應

| 語意 | Java | MySQL | PostgreSQL | JSON |
|---|---|---|---|---|
| 純日期 | `LocalDate` | `DATE` | `date` | `"2026-08-17"` |
| 純時間 | `LocalTime` | `TIME` | `time` | `"14:30:00"` |
| 事件時刻（推薦） | `Instant` | `DATETIME(6)` 存 UTC | `timestamptz` | `"2026-08-17T06:30:00Z"` |
| 事件時刻（帶偏移） | `OffsetDateTime` | `DATETIME(6)` + 另一欄存偏移 | `timestamptz` | `"2026-08-17T14:30:00+08:00"` |
| 未來的當地預約 | `LocalDateTime` + `ZoneId` 兩欄 | `DATETIME` + `VARCHAR` | 同 | 兩個欄位 |
| ⚠️ 不要用 | `LocalDateTime` 單獨存事件時刻 | — | — | — |

### MySQL 的兩個坑

```java
import java.time.Instant;
import java.time.ZoneId;

public class MySqlTimeGotchas {
    public static void main(String[] args) {

        // 坑 1：DATETIME 沒有時區資訊，TIMESTAMP 有但範圍只到 2038 年
        System.out.println("--- MySQL DATETIME vs TIMESTAMP ---");
        System.out.println("DATETIME : 範圍 1000-9999 年，不帶時區，存什麼讀什麼");
        System.out.println("TIMESTAMP: 範圍 1970-2038 年（32 位元！），會依連線時區自動轉換");
        System.out.println("→ 建議：用 DATETIME(6) 明確存 UTC，時區轉換全部在應用層做");

        // 2038 問題示範
        Instant y2038 = Instant.parse("2038-01-19T03:14:07Z");
        System.out.println("\nTIMESTAMP 上限: " + y2038);
        System.out.println("→ 存「30 年期房貸到期日」就會爆掉");

        // 坑 2：小數秒精度
        System.out.println("\n--- 小數秒精度 ---");
        System.out.println("DATETIME    → 秒（小數部分被「四捨五入」，不是截斷！）");
        System.out.println("DATETIME(3) → 毫秒");
        System.out.println("DATETIME(6) → 微秒（Java 的 Instant 是奈秒，會被截到微秒）");

        Instant precise = Instant.parse("2026-08-17T06:30:59.999999999Z");
        System.out.println("Java  奈秒精度: " + precise);
        System.out.println("存進 DATETIME  : 2026-08-17 06:31:00  ← 進位到下一分鐘！");
        System.out.println("存進 DATETIME(6): 2026-08-17 06:30:59.999999");
        System.out.println("→ 建議：一律宣告 DATETIME(6)，並且比較時間時不要依賴奈秒");
    }
}
```

> **實務結論（第 07 站 MySQL 會再實作一次）：**
>
> ```sql
> CREATE TABLE orders (
>   id           BIGINT PRIMARY KEY AUTO_INCREMENT,
>   -- 事件時刻：存 UTC，型別用 DATETIME(6)
>   created_at   DATETIME(6) NOT NULL,
>   paid_at      DATETIME(6) NULL,
>   -- 純日期：用 DATE
>   invoice_date DATE NOT NULL,
>   -- 使用者的當地預約：本地時間 + 時區分開存
>   appointment_local     DATETIME     NULL,
>   appointment_zone      VARCHAR(64)  NULL
> );
> ```
>
> 並且**把資料庫連線與 JVM 的時區都固定成 UTC**，避免「同一份資料在不同機器讀出不同結果」：
>
> ```properties
> # JDBC URL
> jdbc:mysql://host/db?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true
> ```
>
> ```bash
> # JVM 啟動參數（或 Docker 的 TZ 環境變數）
> java -Duser.timezone=UTC -jar app.jar
> ```

### API 的時間格式

```java
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

public class ApiTimeFormat {

    record OrderResponse(
            String id,
            Instant createdAt,        // 序列化成 "2026-08-17T06:30:00Z"
            LocalDate invoiceDate) {  // 序列化成 "2026-08-17"
    }

    public static void main(String[] args) {

        System.out.println("--- API 該回傳什麼格式 ---");
        Instant now = Instant.parse("2026-08-17T06:30:00Z");

        System.out.println("✅ ISO-8601 UTC       : " + now);
        System.out.println("✅ ISO-8601 帶偏移    : " + now.atZone(ZoneId.of("Asia/Taipei")).toOffsetDateTime());
        System.out.println("⚠️ epoch 毫秒         : " + now.toEpochMilli()
                + "（機器友善，但人看不懂、時區不明、JS 精度風險）");
        System.out.println("❌ 自訂格式           : "
                + now.atZone(ZoneId.of("Asia/Taipei"))
                     .format(DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm"))
                + "（沒有時區、非標準、前端要自己解析）");

        System.out.println("""

                建議：
                  1. API 一律用 ISO-8601 字串（`2026-08-17T06:30:00Z`）。
                     所有語言都有標準解析器，JS 的 `new Date(s)` 直接吃。
                  2. 純日期用 `2026-08-17`，不要補上 `T00:00:00Z`（會被時區轉換弄錯一天）。
                  3. 時區轉換是「前端 / 顯示層」的責任，後端只給 UTC。
                     若後端一定要幫忙轉，讓客戶端帶 `X-Timezone: Asia/Taipei` header。
                  4. 不要回傳 epoch 秒/毫秒混用 —— 「這是秒還是毫秒」的猜謎遊戲會害死人。
                """);

        // 純日期補上時間的經典 bug
        System.out.println("--- 純日期加時區的災難 ---");
        LocalDate invoiceDate = LocalDate.of(2026, 8, 17);
        Instant wrong = invoiceDate.atStartOfDay(ZoneId.of("Asia/Taipei")).toInstant();
        System.out.println("台北的 8/17 00:00 = " + wrong);              // 2026-08-16T16:00:00Z
        System.out.println("紐約使用者看到    = "
                + wrong.atZone(ZoneId.of("America/New_York")).toLocalDate());   // 2026-08-16
        System.out.println("→ 發票日期少了一天！純日期就用 LocalDate，不要轉 Instant");
    }
}
```

輸出（節錄）：

```
--- 純日期加時區的災難 ---
台北的 8/17 00:00 = 2026-08-16T16:00:00Z
紐約使用者看到    = 2026-08-16
→ 發票日期少了一天！純日期就用 LocalDate，不要轉 Instant
```

---

## 7.17 JSON 與 Jackson

JSON 是後端的通用語言：API 的請求與回應、設定檔、訊息佇列、log 結構化。
Java 沒有內建 JSON 支援，實務標準是 **Jackson**（Spring Boot 預設就用它）。

### 加入依賴

```xml
<!-- 加進第 00 章的 pom.xml -->
<dependency>
  <groupId>com.fasterxml.jackson.core</groupId>
  <artifactId>jackson-databind</artifactId>
  <version>2.18.2</version>
</dependency>

<!-- ⚠️ 支援 java.time 型別（LocalDate / Instant…）必須加這個！ -->
<dependency>
  <groupId>com.fasterxml.jackson.datatype</groupId>
  <artifactId>jackson-datatype-jsr310</artifactId>
  <version>2.18.2</version>
</dependency>
```

> **Spring Boot 使用者**：用 `spring-boot-starter-web` 就已經包含以上兩個，
> 而且 Spring Boot 會自動幫你註冊 `JavaTimeModule` 並設定成 ISO 格式。
> 這一節教的是「Spring Boot 幫你做了什麼」。

### `ObjectMapper` 的正確用法

```java
package com.example.todo.support;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

public final class Json {

    /**
     * ⚠️ ObjectMapper 建立成本很高（要掃描與快取型別資訊），
     * 但設定完成後是「執行緒安全」的 → 一定要當單例重用。
     *
     * 常見的效能問題就是在每個方法裡 new ObjectMapper()。
     */
    private static final ObjectMapper MAPPER = createMapper();

    private Json() { }

    private static ObjectMapper createMapper() {
        return new ObjectMapper()
                // ① 支援 java.time（沒有這行，LocalDate 會序列化成一堆奇怪欄位）
                .registerModule(new JavaTimeModule())

                // ② 日期輸出成 ISO-8601 字串，而不是 epoch 數字
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

                // ③ 反序列化時忽略 JSON 裡「我們不認識的欄位」。
                //    這是「向前相容」的關鍵：對方 API 加了新欄位，我們不該壞掉。
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)

                // ④ 不要輸出 null 欄位，讓 payload 更小、語意更清楚
                .setSerializationInclusion(JsonInclude.Include.NON_NULL)

                // ⑤ BigDecimal 不要用科學記號輸出（0.00000001 → 1.0E-8 會嚇到前端）
                .enable(SerializationFeature.WRITE_BIGDECIMAL_AS_PLAIN);
    }

    public static ObjectMapper mapper() { return MAPPER; }

    public static String toJson(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            // 包成 unchecked（第 04 章 4.5 節），並帶上型別資訊方便除錯
            throw new IllegalStateException(
                    "JSON 序列化失敗，型別=" + (value == null ? "null" : value.getClass().getName()), e);
        }
    }

    public static String toPrettyJson(Object value) {
        try {
            return MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(value);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("JSON 序列化失敗", e);
        }
    }

    public static <T> T fromJson(String json, Class<T> type) {
        try {
            return MAPPER.readValue(json, type);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalArgumentException(
                    "JSON 解析失敗，目標型別=" + type.getName(), e);
        }
    }

    /** 泛型集合要用 TypeReference（第 05 章 5.12 節講過型別抹除的原因） */
    public static <T> T fromJson(String json, com.fasterxml.jackson.core.type.TypeReference<T> type) {
        try {
            return MAPPER.readValue(json, type);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalArgumentException("JSON 解析失敗", e);
        }
    }
}
```

### 基本序列化與反序列化

```java
import com.fasterxml.jackson.core.type.TypeReference;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

public class JacksonBasics {

    // record 從 Jackson 2.12 起原生支援，不需要任何註解
    record Product(String sku, String name, BigDecimal price, LocalDate releaseDate) { }

    record Order(String id, String userId, Instant createdAt, List<Product> items) { }

    public static void main(String[] args) {

        // ===== 序列化 =====
        var product = new Product("SKU-1001", "機械鍵盤",
                new BigDecimal("2990.00"), LocalDate.of(2026, 3, 15));

        System.out.println("--- 單一物件 ---");
        System.out.println(Json.toJson(product));
        // {"sku":"SKU-1001","name":"機械鍵盤","price":2990.00,"releaseDate":"2026-03-15"}

        var order = new Order("ORD-001", "u001",
                Instant.parse("2026-08-17T06:30:00Z"),
                List.of(product, new Product("SKU-1002", "滑鼠", new BigDecimal("890.00"), null)));

        System.out.println("\n--- 巢狀 + 美化輸出 ---");
        System.out.println(Json.toPrettyJson(order));

        // ===== 反序列化 =====
        System.out.println("\n--- 反序列化 ---");
        String json = """
                {
                  "sku": "SKU-2001",
                  "name": "27 吋螢幕",
                  "price": 8990.50,
                  "releaseDate": "2026-01-20",
                  "unknownField": "對方 API 新增的欄位"
                }
                """;
        Product parsed = Json.fromJson(json, Product.class);
        System.out.println(parsed);
        // Product[sku=SKU-2001, name=27 吋螢幕, price=8990.50, releaseDate=2026-01-20]
        // unknownField 被忽略（因為關掉了 FAIL_ON_UNKNOWN_PROPERTIES）

        // ===== 泛型集合：必須用 TypeReference =====
        System.out.println("\n--- 泛型集合 ---");
        String listJson = """
                [{"sku":"A","name":"甲","price":100},{"sku":"B","name":"乙","price":200}]
                """;

        // ❌ 這樣得到的是 List<LinkedHashMap>，之後轉型就 ClassCastException
        // List<Product> wrong = Json.fromJson(listJson, List.class);

        // ✅ 用 TypeReference 保留泛型資訊
        List<Product> products = Json.fromJson(listJson, new TypeReference<List<Product>>() { });
        System.out.println(products);
        products.forEach(p -> System.out.println("  " + p.name() + " " + p.price()));

        Map<String, Product> map = Json.fromJson(
                """
                {"first":{"sku":"A","name":"甲","price":100}}
                """, new TypeReference<Map<String, Product>>() { });
        System.out.println(map.get("first").name());        // 甲
    }
}
```

輸出（節錄）：

```
--- 單一物件 ---
{"sku":"SKU-1001","name":"機械鍵盤","price":2990.00,"releaseDate":"2026-03-15"}

--- 巢狀 + 美化輸出 ---
{
  "id" : "ORD-001",
  "userId" : "u001",
  "createdAt" : "2026-08-17T06:30:00Z",
  "items" : [ {
    "sku" : "SKU-1001",
    "name" : "機械鍵盤",
    "price" : 2990.00,
    "releaseDate" : "2026-03-15"
  }, {
    "sku" : "SKU-1002",
    "name" : "滑鼠",
    "price" : 890.00
  } ]
}
```

> 注意第二個商品**沒有 `releaseDate` 欄位**——因為它是 `null` 且我們設了 `NON_NULL`。
> 而 `createdAt` 是 `"2026-08-17T06:30:00Z"` 而不是 `1755412200.000000000`——因為關掉了
> `WRITE_DATES_AS_TIMESTAMPS`。**這兩個設定漏掉的話，前端會收到完全不一樣的東西。**

### 常用註解

```java
import com.fasterxml.jackson.annotation.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;

public class JacksonAnnotations {

    /** 對外的 API 回應 DTO */
    @JsonIgnoreProperties(ignoreUnknown = true)      // 類別層級：忽略不認識的欄位
    @JsonInclude(JsonInclude.Include.NON_NULL)
    static class UserDto {

        // ① 改變 JSON 的欄位名稱（Java 用駝峰，API 可能要蛇底線）
        @JsonProperty("user_id")
        private String userId;

        // ② 接受多種輸入名稱（處理對方 API 改名、或相容舊版）
        @JsonAlias({"mail", "emailAddress"})
        private String email;

        // ③ 完全不序列化（密碼、token、內部欄位）
        @JsonIgnore
        private String passwordHash;

        // ④ 只在「輸入」時接受，不在「輸出」時出現
        @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
        private String rawPassword;

        // ⑤ 只在「輸出」時出現，不接受輸入（避免使用者偽造）
        @JsonProperty(access = JsonProperty.Access.READ_ONLY)
        private Instant createdAt;

        // ⑥ 自訂日期格式（⚠️ 盡量不要用，ISO 才是標準）
        @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy/MM/dd")
        private LocalDate birthday;

        // ⑦ 大數字用字串傳，避免 JavaScript 的精度問題
        @JsonFormat(shape = JsonFormat.Shape.STRING)
        private long snowflakeId;

        // ⑧ 控制欄位順序（預設是宣告順序，但反射不保證）
        // 見類別上的 @JsonPropertyOrder

        // ⑨ 計算出來的欄位（沒有對應的成員變數）
        @JsonGetter("displayName")
        public String displayName() {
            return email == null ? userId : email.split("@")[0];
        }

        // getter / setter 省略（Jackson 靠它們讀寫欄位）
        public String getUserId() { return userId; }
        public void setUserId(String userId) { this.userId = userId; }
        public String getEmail() { return email; }
        public void setEmail(String email) { this.email = email; }
        public String getPasswordHash() { return passwordHash; }
        public void setPasswordHash(String h) { this.passwordHash = h; }
        public String getRawPassword() { return rawPassword; }
        public void setRawPassword(String p) { this.rawPassword = p; }
        public Instant getCreatedAt() { return createdAt; }
        public void setCreatedAt(Instant c) { this.createdAt = c; }
        public LocalDate getBirthday() { return birthday; }
        public void setBirthday(LocalDate b) { this.birthday = b; }
        public long getSnowflakeId() { return snowflakeId; }
        public void setSnowflakeId(long s) { this.snowflakeId = s; }
    }

    public static void main(String[] args) {
        var user = new UserDto();
        user.setUserId("u001");
        user.setEmail("gary@example.com");
        user.setPasswordHash("$2a$10$abcdefg");        // 不會出現在 JSON
        user.setRawPassword("secret");                  // WRITE_ONLY，不會出現
        user.setCreatedAt(Instant.parse("2026-08-17T06:30:00Z"));
        user.setBirthday(LocalDate.of(1990, 5, 20));
        user.setSnowflakeId(9_007_199_254_740_993L);    // 超過 JS 的 Number.MAX_SAFE_INTEGER

        System.out.println("--- 序列化（輸出）---");
        System.out.println(Json.toPrettyJson(user));

        System.out.println("\n--- 反序列化（用 alias 與蛇底線）---");
        String input = """
                {
                  "user_id": "u002",
                  "mail": "other@example.com",
                  "rawPassword": "newsecret",
                  "birthday": "1995/12/25",
                  "createdAt": "2020-01-01T00:00:00Z",
                  "somethingNew": "不認識的欄位"
                }
                """;
        UserDto parsed = Json.fromJson(input, UserDto.class);
        System.out.println("userId      : " + parsed.getUserId());        // u002（吃了 user_id）
        System.out.println("email       : " + parsed.getEmail());         // other@...（吃了 mail）
        System.out.println("rawPassword : " + parsed.getRawPassword());   // newsecret（WRITE_ONLY 可讀入）
        System.out.println("birthday    : " + parsed.getBirthday());      // 1995-12-25
        System.out.println("createdAt   : " + parsed.getCreatedAt());     // null ← READ_ONLY 不接受輸入
    }
}
```

輸出：

```
--- 序列化（輸出）---
{
  "user_id" : "u001",
  "email" : "gary@example.com",
  "createdAt" : "2026-08-17T06:30:00Z",
  "birthday" : "1990/05/20",
  "snowflakeId" : "9007199254740993",
  "displayName" : "gary"
}

--- 反序列化（用 alias 與蛇底線）---
userId      : u002
email       : other@example.com
rawPassword : newsecret
birthday    : 1995-12-25
createdAt   : null
```

> **三個實務要點：**
>
> 1. **`@JsonIgnore` 是資安必需品**。忘記加，`passwordHash` 就出現在 API 回應裡。
>    這比第 04 章 4.12 反模式 8（洩漏堆疊）更嚴重。
> 2. **`READ_ONLY` 防偽造**。`createdAt`、`id`、`status` 這類「由伺服器決定」的欄位，
>    如果接受客戶端輸入，使用者就能偽造建立時間或直接把訂單改成 `PAID`。
> 3. **`snowflakeId` 用字串傳**。JavaScript 的 `Number` 只能精確表示到 2^53-1（約 9×10^15）。
>    超過的 `long`（雪花 ID、Twitter ID）傳過去會**靜默失去精度**，
>    `9007199254740993` 變成 `9007199254740992`。這個 bug 極難查，因為只有部分 ID 會錯。

### ⚠️ 三個 Jackson 的安全與正確性陷阱

```java
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.core.StreamReadConstraints;

public class JacksonPitfalls {
    public static void main(String[] args) throws Exception {

        // ===== 陷阱 1：不要開啟 Default Typing（遠端程式碼執行漏洞）=====
        System.out.println("--- 陷阱 1：Default Typing ---");
        System.out.println("""
                ❌ 絕對不要這樣寫：
                   mapper.activateDefaultTyping(LaissezFaireSubTypeValidator.instance, ...);
                   mapper.enableDefaultTyping();      // 已棄用

                原因：它會把 JSON 裡的 "@class" 欄位當成「要實例化的類別名稱」。
                攻擊者送一個特製的 JSON，就能讓你的伺服器實例化任意類別 → RCE。
                Jackson 這幾年有一長串 CVE 都是這個問題（所謂的 "gadget chain"）。

                ✅ 需要多型反序列化，用明確的白名單：
                   @JsonTypeInfo(use = Id.NAME, property = "type")
                   @JsonSubTypes({
                       @Type(value = CreditCardPayment.class, name = "credit_card"),
                       @Type(value = LinePayPayment.class, name = "line_pay")
                   })
                   sealed interface Payment permits CreditCardPayment, LinePayPayment { }

                （搭配第 03 章 3.14 節的 sealed，編譯器與 Jackson 雙重把關）
                """);

        // ===== 陷阱 2：巨大 / 深層 JSON 造成的 DoS =====
        System.out.println("--- 陷阱 2：輸入大小限制 ---");
        // Jackson 2.15+ 內建了一些限制，但預設值可能不符合你的需求
        ObjectMapper safe = JsonMapper.builder()
                .streamReadConstraints(StreamReadConstraints.builder()
                        .maxStringLength(1_000_000)      // 單一字串最長 1MB
                        .maxNestingDepth(50)             // 巢狀深度上限（防堆疊溢位）
                        .maxNumberLength(1_000)
                        .build())
                .build();

        // 深度 100 的巢狀陣列
        String deep = "[".repeat(100) + "1" + "]".repeat(100);
        try {
            safe.readTree(deep);
        } catch (Exception e) {
            System.out.println("✅ 擋下過深的巢狀: " + e.getClass().getSimpleName());
        }
        System.out.println("→ 對外的 API 一定要設 streamReadConstraints，並在網關層限制 body 大小\n");

        // ===== 陷阱 3：浮點數精度 =====
        System.out.println("--- 陷阱 3：JSON 數字 → Java 型別 ---");
        String money = "{\"price\": 0.1}";

        // 預設會反序列化成 double → 帶入浮點誤差（第 01 章 1.5 節）
        record WithDouble(double price) { }
        record WithBigDecimal(java.math.BigDecimal price) { }

        var d = Json.fromJson(money, WithDouble.class);
        var bd = Json.fromJson(money, WithBigDecimal.class);

        System.out.println("double     : " + d.price());
        System.out.println("  × 3      : " + (d.price() * 3));            // 0.30000000000000004
        System.out.println("BigDecimal : " + bd.price());
        System.out.println("  × 3      : " + bd.price().multiply(java.math.BigDecimal.valueOf(3)));  // 0.3

        System.out.println("""

                → 金額欄位在 DTO 裡一律宣告成 BigDecimal，不要用 double。
                  另外可考慮 USE_BIG_DECIMAL_FOR_FLOATS，讓所有浮點都變 BigDecimal。
                """);
    }
}
```

輸出（節錄）：

```
--- 陷阱 2：輸入大小限制 ---
✅ 擋下過深的巢狀: StreamConstraintsException
→ 對外的 API 一定要設 streamReadConstraints，並在網關層限制 body 大小

--- 陷阱 3：JSON 數字 → Java 型別 ---
double     : 0.1
  × 3      : 0.30000000000000004
BigDecimal : 0.1
  × 3      : 0.3
```

### 串流讀寫超大 JSON

```java
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.MappingIterator;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public class JsonStreaming {

    record Todo(long id, String title, boolean done) { }

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("json-stream");

        // ===== 寫出 100 萬筆而不吃記憶體 =====
        Path bigFile = dir.resolve("todos.json");
        try (var writer = Files.newBufferedWriter(bigFile);
             var gen = new JsonFactory().createGenerator(writer)) {
            gen.writeStartArray();
            for (long i = 1; i <= 200_000; i++) {
                gen.writeStartObject();
                gen.writeNumberField("id", i);
                gen.writeStringField("title", "待辦 " + i);
                gen.writeBooleanField("done", i % 3 == 0);
                gen.writeEndObject();
            }
            gen.writeEndArray();
        }
        System.out.printf("寫出檔案: %.1f MB%n", Files.size(bigFile) / 1024.0 / 1024);

        // ===== ❌ 一次讀進記憶體：20 萬個物件，可能 OOM =====
        // List<Todo> all = Json.fromJson(Files.readString(bigFile), new TypeReference<>() {});

        // ===== ✅ 串流逐筆讀：記憶體只放一筆 =====
        long start = System.currentTimeMillis();
        long doneCount = 0;
        try (var reader = Files.newBufferedReader(bigFile);
             MappingIterator<Todo> it = Json.mapper().readerFor(Todo.class).readValues(reader)) {
            while (it.hasNext()) {
                Todo todo = it.next();
                if (todo.done()) doneCount++;
            }
        }
        System.out.printf("串流讀取完成: 已完成 %d 筆，耗時 %d ms%n",
                doneCount, System.currentTimeMillis() - start);

        // ===== ✅ 更底層：只挑出需要的欄位，連物件都不建立 =====
        start = System.currentTimeMillis();
        long idSum = 0;
        try (JsonParser parser = new JsonFactory().createParser(bigFile.toFile())) {
            while (parser.nextToken() != null) {
                if (parser.currentToken() == JsonToken.FIELD_NAME
                        && "id".equals(parser.currentName())) {
                    parser.nextToken();
                    idSum += parser.getLongValue();
                }
            }
        }
        System.out.printf("純解析 id 總和: %d，耗時 %d ms%n",
                idSum, System.currentTimeMillis() - start);

        // ===== JSON Lines（每行一個 JSON）：log 與資料管線的常見格式 =====
        Path jsonl = dir.resolve("todos.jsonl");
        try (var writer = Files.newBufferedWriter(jsonl)) {
            for (Todo t : List.of(new Todo(1, "A", false), new Todo(2, "B", true))) {
                writer.write(Json.toJson(t));
                writer.newLine();
            }
        }
        System.out.println("\n--- JSON Lines（可以用 grep / 逐行處理）---");
        try (var lines = Files.lines(jsonl)) {
            lines.forEach(System.out::println);
        }

        Files.delete(bigFile);
        Files.delete(jsonl);
        Files.delete(dir);
    }
}
```

輸出：

```
寫出檔案: 9.4 MB
串流讀取完成: 已完成 66666 筆，耗時 420 ms
純解析 id 總和: 20000100000，耗時 180 ms

--- JSON Lines（可以用 grep / 逐行處理）---
{"id":1,"title":"A","done":false}
{"id":2,"title":"B","done":true}
```

> **實務判斷：**
> - 一般 API 請求/回應（幾 KB ~ 幾 MB）→ 直接 `readValue` / `writeValue`。
> - 匯入/匯出大檔（幾十 MB 以上）→ `MappingIterator` 串流。
> - 只需要少數欄位、要極致效能 → `JsonParser` 手動走 token。
> - log、資料管線、Kafka → **JSON Lines**（每行一個獨立 JSON），可以逐行處理、可以 `grep`、
>   壞掉一行不影響其他行。

---

## 7.18 練習專案：Todo CLI 存到檔案

延續第 06 章的專案，加入 JSON 檔案持久化與 `Clock` 注入。

```
demo/src/main/java/com/example/todo/
├── exception/ ...            （第 04 章）
├── model/
│   ├── Priority.java         （第 04 章）
│   └── Todo.java             ← 改：用 Instant，加 Jackson 註解
├── repository/
│   ├── TodoRepository.java   （第 04 章）
│   ├── InMemoryTodoRepository.java  （第 04 章）
│   └── JsonFileTodoRepository.java  ← 新增
├── support/
│   ├── Json.java             ← 新增（7.17 節）
│   └── TodoFileStore.java    ← 新增：原子寫入 + 備份
├── service/TodoService.java  ← 改：注入 Clock
└── App.java
```

### `Todo.java`（改用 `Instant`）

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;
import com.example.todo.exception.TodoAlreadyDoneException;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Set;

public class Todo {

    private static final int MAX_TITLE_LENGTH = 100;
    private static final int MAX_TAGS = 5;

    private final long id;
    private String title;
    private Priority priority;
    private boolean done;
    // ✅ 事件時刻用 Instant，不是 LocalDateTime（7.11 節）
    private final Instant createdAt;
    private Instant completedAt;
    private final Set<String> tags = new LinkedHashSet<>();

    /**
     * Jackson 用這個建構子反序列化。
     * @JsonProperty 標出每個參數對應的 JSON 欄位名。
     */
    @JsonCreator
    public Todo(@JsonProperty("id") long id,
                @JsonProperty("title") String title,
                @JsonProperty("priority") Priority priority,
                @JsonProperty("createdAt") Instant createdAt,
                @JsonProperty("done") boolean done,
                @JsonProperty("completedAt") Instant completedAt,
                @JsonProperty("tags") Set<String> tags) {
        if (id <= 0) {
            throw new InvalidTodoException("id", id, "id 必須大於 0");
        }
        this.id = id;
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt 不可為 null");
        this.done = done;
        this.completedAt = completedAt;
        setTitle(title);
        if (tags != null) {
            tags.forEach(this::addTag);
        }
        // 一致性檢查：反序列化的資料也可能是壞的（手改過的檔案、舊版格式）
        if (done && completedAt == null) {
            throw new InvalidTodoException("completedAt", null, "已完成的待辦必須有完成時間");
        }
        if (!done && completedAt != null) {
            throw new InvalidTodoException("completedAt", completedAt, "未完成的待辦不應有完成時間");
        }
    }

    /** 一般程式碼用的建構子 */
    public Todo(long id, String title, Priority priority, Instant createdAt) {
        this(id, title, priority, createdAt, false, null, null);
    }

    public void markDone(Instant when) {
        if (done) {
            throw new TodoAlreadyDoneException(id, title);
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
        // ✅ 用碼點數判斷長度，emoji 才不會被當成兩個字（7.4 節）
        if (stripped.codePointCount(0, stripped.length()) > MAX_TITLE_LENGTH) {
            throw new InvalidTodoException("title", stripped.length(),
                    "標題長度不可超過 " + MAX_TITLE_LENGTH + " 字");
        }
        this.title = stripped;
    }

    public void changePriority(Priority priority) {
        this.priority = Objects.requireNonNull(priority, "priority 不可為 null");
    }

    public void addTag(String tag) {
        if (tag == null || tag.isBlank()) {
            throw new InvalidTodoException("tag", tag, "標籤不可為空");
        }
        String normalized = tag.strip().toLowerCase();
        if (tags.size() >= MAX_TAGS && !tags.contains(normalized)) {
            throw new InvalidTodoException("tags", tags.size(), "標籤最多 " + MAX_TAGS + " 個");
        }
        tags.add(normalized);
    }

    public boolean removeTag(String tag) {
        return tag != null && tags.remove(tag.strip().toLowerCase());
    }

    public boolean hasTag(String tag) {
        return tag != null && tags.contains(tag.strip().toLowerCase());
    }

    // ⚠️ 存取子沒有 `get` 前綴時，Jackson 的預設內省**找不到任何屬性** ——
    //    序列化會直接丟 InvalidDefinitionException（"no properties discovered"）。
    //    所以每一個都要用 @JsonProperty 明講欄位名。理由見下方說明。
    @JsonProperty("id")          public long id() { return id; }
    @JsonProperty("title")       public String title() { return title; }
    @JsonProperty("priority")    public Priority priority() { return priority; }
    @JsonProperty("done")        public boolean isDone() { return done; }
    @JsonProperty("createdAt")   public Instant createdAt() { return createdAt; }
    @JsonProperty("completedAt") public Instant completedAt() { return completedAt; }
    @JsonProperty("tags")        public Set<String> tags() { return Set.copyOf(tags); }

    /** @JsonIgnore：這是顯示用的衍生資料，不要寫進檔案 */
    @JsonIgnore
    public String toDisplayLine() {
        String tagPart = tags.isEmpty() ? "" : " " + tags;
        return "%s #%-3d [%s] %s%s".formatted(
                done ? "[x]" : "[ ]", id, priority.label(), title, tagPart);
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

> ⚠️ **`getXxx` 不見了，Jackson 就瞎了。**
>
> 本課的 `Todo` 用的是 `id()` / `title()` 這種不加 `get` 的存取子（第 02 章 2.14 節說明過理由）。
> 但 Jackson 的**預設內省規則是找 `getXxx()` / `isXxx()`**，所以它在 `Todo` 上
> 一個屬性都找不到，序列化時直接丟：
>
> ```
> InvalidDefinitionException: No serializer found for class com.example.todo.model.Todo
> and no properties discovered to create BeanSerializer
> ```
>
> **三種解法**：
>
> | 解法 | 寫法 | 適用 |
> |---|---|---|
> | ① 每個存取子標 `@JsonProperty` | 上面用的做法 | 少數幾個類別，最明確 |
> | ② 改用 `record` | 第 12 章 12.5 節 | **Jackson 2.12+ 原生支援 record**，不用任何註解 |
> | ③ 改欄位可見度規則 | `mapper.setVisibility(FIELD, ANY)` 直接讀欄位、不看方法 | 整個專案統一時 |
>
> **這正是第 12 章把 `Todo` 改成 `record` 的其中一個好處** —— 這七行 `@JsonProperty` 會全部消失。

### `TodoFileStore.java`：原子寫入 + 自動備份

```java
package com.example.todo.support;

import com.example.todo.exception.ErrorCode;
import com.example.todo.exception.TodoException;
import com.example.todo.model.Todo;
import com.fasterxml.jackson.core.type.TypeReference;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * 負責「把待辦清單存成 JSON 檔 / 從 JSON 檔讀回來」。
 * 只做 IO，不含任何業務規則（第 04 章 4.10 節的分層原則）。
 */
public class TodoFileStore {

    private static final DateTimeFormatter BACKUP_STAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneId.systemDefault());

    private static final int MAX_BACKUPS = 5;

    private final Path dataFile;
    private final Path backupDir;
    private final Clock clock;

    public TodoFileStore(Path dataFile, Clock clock) {
        this.dataFile = Objects.requireNonNull(dataFile, "dataFile 不可為 null").toAbsolutePath();
        this.clock = Objects.requireNonNull(clock, "clock 不可為 null");
        this.backupDir = this.dataFile.getParent().resolve("backups");
    }

    /** 讀取。檔案不存在是正常情況（第一次執行）→ 回傳空清單，不丟例外 */
    public List<Todo> load() {
        try {
            String json = Files.readString(dataFile);
            // 去掉可能的 BOM（7.10 節）——手動編輯過的檔案常常帶 BOM
            if (json.startsWith("﻿")) {
                json = json.substring(1);
            }
            if (json.isBlank()) {
                return new ArrayList<>();
            }
            List<Todo> todos = Json.fromJson(json, new TypeReference<List<Todo>>() { });
            return new ArrayList<>(todos);

        } catch (NoSuchFileException e) {
            // ✅ 第一次執行沒有檔案，這是預期情況（第 04 章練習 1）
            return new ArrayList<>();

        } catch (IOException e) {
            throw new TodoException(ErrorCode.STORAGE_ERROR, "讀取資料檔失敗", e)
                    .with("file", dataFile.toString());

        } catch (IllegalArgumentException e) {
            // JSON 格式壞掉：可能是手改壞了、或是上次寫入被中斷（雖然我們用原子寫入）
            throw new TodoException(ErrorCode.STORAGE_ERROR,
                    "資料檔格式錯誤，請檢查或還原備份", e)
                    .with("file", dataFile.toString())
                    .with("backupDir", backupDir.toString());
        }
    }

    /**
     * 寫入。用「暫存檔 + ATOMIC_MOVE」保證不會留下半個檔案（7.7 節）。
     * 寫入前先備份舊版。
     */
    public void save(List<Todo> todos) {
        Objects.requireNonNull(todos, "todos 不可為 null");
        try {
            Files.createDirectories(dataFile.getParent());
            backupIfExists();

            Path temp = Files.createTempFile(
                    dataFile.getParent(), dataFile.getFileName().toString(), ".tmp");
            try {
                Files.writeString(temp, Json.toPrettyJson(todos));
                Files.move(temp, dataFile,
                        StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException | RuntimeException e) {
                Files.deleteIfExists(temp);
                throw e;
            }

        } catch (IOException e) {
            throw new TodoException(ErrorCode.STORAGE_ERROR, "寫入資料檔失敗", e)
                    .with("file", dataFile.toString())
                    .with("count", todos.size());
        }
    }

    private void backupIfExists() throws IOException {
        if (!Files.exists(dataFile)) return;

        Files.createDirectories(backupDir);
        String name = "%s.%s.bak".formatted(
                dataFile.getFileName(), BACKUP_STAMP.format(clock.instant()));
        Files.copy(dataFile, backupDir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
        pruneOldBackups();
    }

    /** 只保留最新的 N 份備份，避免檔案無限成長 */
    private void pruneOldBackups() throws IOException {
        try (var stream = Files.list(backupDir)) {
            List<Path> backups = stream
                    .filter(p -> p.getFileName().toString().endsWith(".bak"))
                    .sorted(Comparator.comparing((Path p) -> p.getFileName().toString()).reversed())
                    .toList();

            for (int i = MAX_BACKUPS; i < backups.size(); i++) {
                Files.deleteIfExists(backups.get(i));
            }
        }
    }

    public List<Path> listBackups() {
        if (!Files.exists(backupDir)) return List.of();
        try (var stream = Files.list(backupDir)) {
            return stream.sorted(Comparator.comparing((Path p) -> p.getFileName().toString()).reversed())
                    .toList();
        } catch (IOException e) {
            throw new TodoException(ErrorCode.STORAGE_ERROR, "列出備份失敗", e);
        }
    }

    public Path getDataFile() { return dataFile; }
}
```

### `JsonFileTodoRepository.java`

```java
package com.example.todo.repository;

import com.example.todo.model.Todo;
import com.example.todo.support.TodoFileStore;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * 檔案版的 Repository。
 * 策略：啟動時全部載入記憶體，每次變更後寫回檔案（write-through）。
 *
 * ⚠️ 這只適用於「小資料量的單機工具」。
 *    資料量大或多程序共用時，要用真正的資料庫（第 06～08 站）。
 */
public class JsonFileTodoRepository implements TodoRepository {

    private final TodoFileStore store;
    private final Map<Long, Todo> cache = new LinkedHashMap<>();
    private long sequence = 0;

    public JsonFileTodoRepository(TodoFileStore store) {
        this.store = Objects.requireNonNull(store, "store 不可為 null");
        reload();
    }

    /** 從檔案載入到記憶體，並把 sequence 對齊到最大 id */
    public final void reload() {
        cache.clear();
        List<Todo> loaded = store.load();
        for (Todo todo : loaded) {
            cache.put(todo.id(), todo);
            sequence = Math.max(sequence, todo.id());     // ✅ 避免重啟後 id 撞號
        }
    }

    @Override
    public Todo save(Todo todo) {
        Objects.requireNonNull(todo, "todo 不可為 null");
        cache.put(todo.id(), todo);
        flush();
        return todo;
    }

    @Override
    public Optional<Todo> findById(long id) {
        return Optional.ofNullable(cache.get(id));
    }

    @Override
    public List<Todo> findAll() {
        return List.copyOf(cache.values());
    }

    @Override
    public boolean deleteById(long id) {
        boolean removed = cache.remove(id) != null;
        if (removed) flush();
        return removed;
    }

    @Override
    public long nextId() {
        return ++sequence;
    }

    /** 批次寫入：一次存多筆時，只寫檔一次（避免 N 次 IO） */
    public void saveAll(List<Todo> todos) {
        for (Todo todo : todos) {
            cache.put(todo.id(), todo);
        }
        flush();
    }

    private void flush() {
        store.save(List.copyOf(cache.values()));
    }
}
```

### `App.java`：組裝與示範

```java
package com.example.todo;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.service.ConsoleNotifier;
import com.example.todo.repository.JsonFileTodoRepository;
import com.example.todo.support.TodoFileStore;
import com.example.todo.service.TodoService;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

public class App {

    private static final DateTimeFormatter DISPLAY =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault());

    public static void main(String[] args) throws IOException {
        Path dataDir = Files.createTempDirectory("todo-data");
        Path dataFile = dataDir.resolve("todos.json");

        Clock clock = Clock.systemDefaultZone();

        // ===== 第一次執行：檔案不存在 =====
        System.out.println("=== 第一次執行（檔案不存在）===");
        var store = new TodoFileStore(dataFile, clock);
        var repo = new JsonFileTodoRepository(store);
        var service = new TodoService(repo, new ConsoleNotifier(), clock);

        System.out.println("載入筆數: " + repo.findAll().size());          // 0

        Todo t1 = service.add("寫第 07 章", Priority.HIGH);
        t1.addTag("寫作"); t1.addTag("java");
        repo.save(t1);

        Todo t2 = service.add("整理 IO 筆記 📝", Priority.HIGH);
        t2.addTag("java");
        repo.save(t2);

        Todo t3 = service.add("買咖啡 ☕", Priority.LOW);
        service.markDone(t3.id());

        System.out.println("\n檔案內容:");
        System.out.println(Files.readString(dataFile));

        // ===== 模擬重新啟動：重新從檔案載入 =====
        System.out.println("=== 重新啟動（從檔案載入）===");
        var store2 = new TodoFileStore(dataFile, clock);
        var repo2 = new JsonFileTodoRepository(store2);

        System.out.println("載入筆數: " + repo2.findAll().size());          // 3
        for (Todo todo : repo2.findAll()) {
            System.out.printf("  %s  建立於 %s%s%n",
                    todo.toDisplayLine(),
                    DISPLAY.format(todo.createdAt()),
                    todo.completedAt() == null ? ""
                            : "，完成於 " + DISPLAY.format(todo.completedAt()));
        }

        // ✅ id 沒有撞號（sequence 對齊到最大 id）
        System.out.println("下一個 id: " + repo2.nextId());                 // 4

        // ===== 備份機制 =====
        System.out.println("\n=== 備份 ===");
        var service2 = new TodoService(repo2, new ConsoleNotifier(), clock);
        service2.add("觸發第二次寫入", Priority.MEDIUM);
        service2.add("觸發第三次寫入", Priority.MEDIUM);

        store2.listBackups().forEach(p ->
                System.out.println("  " + p.getFileName()));

        // ===== 用 Clock 測試「多久以前」 ====
        System.out.println("\n=== 用固定 Clock 顯示相對時間 ===");
        Clock future = Clock.offset(clock, Duration.ofHours(26));
        for (Todo todo : repo2.findAll()) {
            System.out.printf("  #%d %s → %s%n", todo.id(), todo.title(),
                    humanize(todo.createdAt(), future.instant()));
        }

        // ===== 壞掉的檔案 =====
        System.out.println("\n=== 資料檔壞掉時 ===");
        Files.writeString(dataFile, "{ 這不是合法的 JSON");
        try {
            new JsonFileTodoRepository(new TodoFileStore(dataFile, clock));
        } catch (RuntimeException e) {
            System.out.println("  " + e.getMessage());
        }

        cleanup(dataDir);
    }

    static String humanize(Instant past, Instant now) {
        Duration d = Duration.between(past, now);
        long seconds = d.toSeconds();
        if (seconds < 60) return seconds + " 秒前";
        if (seconds < 3600) return d.toMinutes() + " 分鐘前";
        if (seconds < 86400) return d.toHours() + " 小時前";
        return d.toDays() + " 天前";
    }

    static void cleanup(Path dir) throws IOException {
        try (var s = Files.walk(dir)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) { }
            });
        }
    }
}
```

`TodoService` 也要改成注入 `Clock`：

```java
package com.example.todo.service;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

public class TodoService {

    private final TodoRepository repository;
    private final Notifier notifier;
    private final Clock clock;          // ✅ 時間變成明確的依賴（7.15 節）

    public TodoService(TodoRepository repository, Notifier notifier, Clock clock) {
        this.repository = Objects.requireNonNull(repository, "repository 不可為 null");
        this.notifier = Objects.requireNonNull(notifier, "notifier 不可為 null");
        this.clock = Objects.requireNonNull(clock, "clock 不可為 null");
    }

    public Todo add(String title, Priority priority) {
        Todo todo = new Todo(repository.nextId(), title, priority, clock.instant());
        repository.save(todo);
        safeNotify(n -> n.notifyCreated(todo));
        return todo;
    }

    public Todo markDone(long id) {
        Todo todo = repository.getById(id);
        todo.markDone(clock.instant());
        repository.save(todo);
        safeNotify(n -> n.notifyDone(todo));
        return todo;
    }

    public boolean remove(long id) {
        repository.getById(id);
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

    /** 通知失敗不該讓主流程失敗（第 04 章 4.12 反模式 1） */
    private void safeNotify(java.util.function.Consumer<Notifier> action) {
        try {
            action.accept(notifier);
        } catch (RuntimeException e) {
            System.err.println("[WARN] 通知發送失敗（不影響主流程）: " + e.getMessage());
        }
    }
}
```

執行輸出：

```
=== 第一次執行（檔案不存在）===
載入筆數: 0
🔔 新增待辦 #1：寫第 07 章
🔔 新增待辦 #2：整理 IO 筆記 📝
🔔 新增待辦 #3：買咖啡 ☕
🔔 完成待辦 #3：買咖啡 ☕

檔案內容:
[ {
  "id" : 1,
  "title" : "寫第 07 章",
  "priority" : "HIGH",
  "createdAt" : "2026-08-17T06:30:00.123456Z",
  "done" : false,
  "tags" : [ "java", "寫作" ]
}, {
  "id" : 2,
  "title" : "整理 IO 筆記 📝",
  "priority" : "HIGH",
  "createdAt" : "2026-08-17T06:30:00.234567Z",
  "done" : false,
  "tags" : [ "java" ]
}, {
  "id" : 3,
  "title" : "買咖啡 ☕",
  "priority" : "LOW",
  "createdAt" : "2026-08-17T06:30:00.245678Z",
  "done" : true,
  "completedAt" : "2026-08-17T06:30:00.256789Z",
  "tags" : [ ]
} ]

=== 重新啟動（從檔案載入）===
載入筆數: 3
  [ ] #1   [高] 寫第 07 章 [java, 寫作]  建立於 2026-08-17 14:30
  [ ] #2   [高] 整理 IO 筆記 📝 [java]  建立於 2026-08-17 14:30
  [x] #3   [低] 買咖啡 ☕  建立於 2026-08-17 14:30，完成於 2026-08-17 14:30
下一個 id: 4

=== 備份 ===
🔔 新增待辦 #4：觸發第二次寫入
🔔 新增待辦 #5：觸發第三次寫入
  todos.json.20260817-143000.bak

=== 用固定 Clock 顯示相對時間 ===
  #1 寫第 07 章 → 1 天前
  #2 整理 IO 筆記 📝 → 1 天前
  ...

=== 資料檔壞掉時 ===
  [T9001] 資料檔格式錯誤，請檢查或還原備份 {file=/tmp/.../todos.json, backupDir=/tmp/.../backups}
```

### 這一版用到本章的哪些技術

| 技術 | 用在哪 | 為什麼 |
|---|---|---|
| `Instant` 而非 `LocalDateTime` | `Todo.createdAt` | 事件時刻必須無歧義（7.11 節） |
| `Clock` 注入 | `TodoService`、`TodoFileStore` | 可測試性（7.15 節） |
| 原子寫入（temp + `ATOMIC_MOVE`） | `TodoFileStore.save` | 不留半個檔案（7.7 節） |
| `NoSuchFileException` 單獨處理 | `TodoFileStore.load` | 「第一次執行」是正常情況，不是錯誤 |
| BOM 去除 | `TodoFileStore.load` | 使用者可能用記事本編輯過（7.10 節） |
| `codePointCount` 驗證長度 | `Todo.setTitle` | emoji 不該算兩個字（7.4 節） |
| `@JsonCreator` + 一致性檢查 | `Todo` 建構子 | 反序列化的資料也可能是壞的 |
| `@JsonIgnore` | `toDisplayLine()` | 衍生資料不寫進檔案 |
| `TypeReference<List<Todo>>` | `TodoFileStore.load` | 泛型抹除（7.17 節） |
| `sequence = max(id)` | `reload()` | 重啟後 id 不撞號 |
| 備份輪替 | `pruneOldBackups` | 檔案不無限成長 |

### ⚠️ 換成 `Instant` 之後，第 06 章的 `TodoStatistics` 編不過了

`createdAt` 從 `LocalDateTime` 變成 `Instant`，第 06 章那個「依日期分組」的方法就壞了：

```java
// ❌ 編不過：Instant 沒有 toLocalDate()
return todos.stream().collect(Collectors.groupingBy(
        t -> t.createdAt().toLocalDate(), TreeMap::new, Collectors.counting()));
```

**這不是打錯字，是型別在提醒你一件事**：`Instant` 是時間軸上的一個點，
它**沒有「日期」這個概念** —— 同一個 `Instant`，在台北是 8/16，在紐約是 8/15（7.11 節）。
所以「這是哪一天的待辦」這個問題，**一定要先講定用誰的日曆**：

完整的更新版（其餘方法與第 06 章相同，只有兩個用到「日期」的地方要加 `.atZone(zone)`）：

```java
package com.example.todo.service;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;
import java.util.stream.Collectors;

public class TodoStatistics {

    private final List<Todo> todos;
    private final ZoneId zone;          // ✅ 時區變成明確的依賴，和 Clock 一樣（7.15 節）

    public TodoStatistics(List<Todo> todos, ZoneId zone) {
        this.todos = List.copyOf(todos);
        this.zone = Objects.requireNonNull(zone, "zone 不可為 null");
    }

    public Map<Priority, Long> countByPriority() {
        return todos.stream().collect(Collectors.groupingBy(
                Todo::priority, () -> new EnumMap<>(Priority.class), Collectors.counting()));
    }

    public Map<Boolean, List<Todo>> partitionByDone() {
        return todos.stream().collect(Collectors.partitioningBy(Todo::isDone));
    }

    public Map<String, Long> topTags(int limit) {
        return todos.stream()
                .flatMap(t -> t.tags().stream())
                .collect(Collectors.groupingBy(tag -> tag, Collectors.counting()))
                .entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed()
                        .thenComparing(Map.Entry.comparingByKey()))
                .limit(limit)
                .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue,
                        (a, b) -> a, LinkedHashMap::new));
    }

    /** ★ 改動點 1／2 */
    public Map<LocalDate, Long> countByDate() {
        return todos.stream().collect(Collectors.groupingBy(
                t -> t.createdAt().atZone(zone).toLocalDate(),   // ← 明確指定時區
                TreeMap::new, Collectors.counting()));
    }

    public List<Todo> pendingSorted() {
        return todos.stream()
                .filter(t -> !t.isDone())
                .sorted(Comparator.comparingInt((Todo t) -> t.priority().weight()).reversed()
                        .thenComparing(Todo::createdAt))
                .toList();
    }

    public double completionRate() {
        if (todos.isEmpty()) return 0.0;
        return todos.stream().filter(Todo::isDone).count() * 100.0 / todos.size();
    }

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

    public String summary() {
        return todos.stream().collect(Collectors.teeing(
                Collectors.filtering(Todo::isDone, Collectors.counting()),
                Collectors.counting(),
                (done, total) -> total == 0
                        ? "沒有待辦"
                        : "%d / %d 完成 (%.1f%%)".formatted(done, total, done * 100.0 / total)));
    }

    public Map<String, List<String>> pendingTitlesByTag() {
        return todos.stream()
                .flatMap(t -> t.tags().stream().map(tag -> Map.entry(tag, t)))
                .collect(Collectors.groupingBy(Map.Entry::getKey, TreeMap::new,
                        Collectors.mapping(Map.Entry::getValue,
                                Collectors.filtering(t -> !t.isDone(),
                                        Collectors.mapping(Todo::title, Collectors.toList())))));
    }

    public Optional<Todo> oldestPending() {
        return todos.stream()
                .filter(t -> !t.isDone())
                .min(Comparator.comparing(Todo::createdAt));
    }

    public String render() {
        StringBuilder sb = new StringBuilder();
        sb.append("=== 待辦統計 ===\n");
        sb.append("總覽: ").append(summary()).append('\n');

        sb.append("\n依優先度:\n");
        Map<Priority, String> rates = completionRateByPriority();     // 提到迴圈外（6.17 節）
        countByPriority().forEach((p, c) ->
                sb.append("  %-4s %d 筆  完成 %s%n".formatted(p.label(), c, rates.get(p))));

        sb.append("\n依日期:\n");
        countByDate().forEach((d, c) -> sb.append("  %s  %d 筆%n".formatted(d, c)));

        sb.append("\n熱門標籤:\n");
        topTags(5).forEach((tag, c) -> sb.append("  %-8s %d 次%n".formatted(tag, c)));

        sb.append("\n待處理（優先度序）:\n");
        pendingSorted().forEach(t -> sb.append("  ").append(t.toDisplayLine()).append('\n'));

        /** ★ 改動點 2／2 */
        oldestPending().ifPresentOrElse(
                t -> sb.append("\n⚠️ 最久未處理: ").append(t.toDisplayLine())
                        .append(" (建立於 ").append(t.createdAt().atZone(zone).toLocalDate())
                        .append(")\n"),
                () -> sb.append("\n✅ 沒有待處理的項目\n"));

        return sb.toString();
    }
}
```

> **不要用 `ZoneId.systemDefault()` 當預設值。** 那是把問題藏起來 ——
> 同一份報表在你的筆電和正式機（通常是 UTC）會跑出不同結果，而且不會有任何警告。
> **讓呼叫端明講**：報表要給台灣使用者看，就傳 `ZoneId.of("Asia/Taipei")`。

> **這一版還有兩個問題留給後面章節：**
> - 每次變更都寫整個檔案 → 資料量大時很慢。第 08 章會加上「批次匯入時只寫一次」。
> - 多執行緒同時操作 `cache` 會壞 → 第 08 章處理併發。

---

## 7.19 常見錯誤

| # | 錯誤 | 修法 |
|---|---|---|
| 1 | 迴圈裡用 `+=` 串接字串 | `StringBuilder`（單次串接用 `+` 沒問題） |
| 2 | `getBytes()` / `new String(byte[])` 沒指定編碼 | 加上 `StandardCharsets.UTF_8` |
| 3 | 用 `length()` 驗證使用者輸入的字數 | `codePointCount` 或 `BreakIterator` |
| 4 | `String.matches()` 在熱路徑上重複呼叫 | `static final Pattern` 預編譯 |
| 5 | 從網路複製「完美的 email regex」 | 用寬鬆檢查 + 長度上限，避免 ReDoS |
| 6 | `UPLOAD_DIR.resolve(userInput)` | `normalize()` 後檢查 `startsWith(base)` |
| 7 | `Files.readAllLines` 讀大檔 | `Files.lines`（記得 try-with-resources） |
| 8 | `Files.lines` / `walk` 忘記關 | 一律 try-with-resources |
| 9 | 直接覆寫重要檔案 | temp + `ATOMIC_MOVE` |
| 10 | `if (!Files.exists(p)) Files.createFile(p)` | 直接 `createFile` 並 catch `FileAlreadyExistsException` |
| 11 | 用 `split(",")` 解析 CSV | 用 Commons CSV / OpenCSV |
| 12 | 讀 Excel 匯出的 CSV 沒去 BOM | `stripBom`；寫給 Excel 的要**加** BOM |
| 13 | 用 `LocalDateTime` 存事件時刻 | `Instant` |
| 14 | 格式字串寫 `YYYY` | `yyyy`（`YYYY` 是週基準年，跨年會錯一年） |
| 15 | 格式字串寫 `DD` / `mm` / `hh` | `dd` / `MM` / `HH` |
| 16 | `static SimpleDateFormat` | `DateTimeFormatter`（不可變、執行緒安全） |
| 17 | 用 `Period.getDays()` 當總天數 | `ChronoUnit.DAYS.between()` |
| 18 | 方法內直接呼叫 `LocalDate.now()` | 注入 `Clock` |
| 19 | 每個方法 `new ObjectMapper()` | 當單例重用（建立成本高、設定完成後執行緒安全） |
| 20 | 忘記 `registerModule(new JavaTimeModule())` | 加上，否則 `java.time` 序列化成怪東西 |
| 21 | `mapper.readValue(json, List.class)` | `new TypeReference<List<T>>() {}` |
| 22 | 開啟 Jackson 的 Default Typing | 用 `@JsonTypeInfo` + `@JsonSubTypes` 白名單 |
| 23 | DTO 金額用 `double` | `BigDecimal` |
| 24 | `long` ID 直接傳給前端 | `@JsonFormat(shape = STRING)` |
| 25 | 密碼欄位沒加 `@JsonIgnore` | 加上；或用專門的 DTO |

---

## 7.20 本章練習

### 練習 1：找出所有問題

```java
public class Buggy {

    static final SimpleDateFormat FMT = new SimpleDateFormat("YYYY-mm-DD");

    public String buildReport(List<Order> orders) {
        String result = "";
        for (Order o : orders) {
            result += o.getId() + "," + o.getAmount() + "\n";
        }
        return result;
    }

    public List<String> readLines(String path) throws IOException {
        return Files.readAllLines(Paths.get(path));
    }

    public void saveConfig(String json) throws IOException {
        Files.writeString(Path.of("/etc/app/config.json"), json);
    }

    public Path getUserFile(String filename) {
        return Path.of("/var/uploads").resolve(filename);
    }

    public boolean isExpired(LocalDate expiry) {
        return LocalDate.now().isAfter(expiry);
    }

    public String toJson(Object o) throws Exception {
        return new ObjectMapper().writeValueAsString(o);
    }

    public boolean validateNickname(String nick) {
        return nick.length() <= 10;
    }
}
```

<details>
<summary>參考解答</summary>

**八個問題：**

1. **`static SimpleDateFormat`**——非執行緒安全（7.13 節），且格式字串三個都錯：
   `YYYY`（週基準年）、`mm`（分鐘當月份）、`DD`（年中日當月中日）。
2. **`buildReport` 迴圈中 `+=`**——O(n²)（7.3 節）。
3. **`readAllLines`**——不確定大小的檔案會 OOM（7.7 節）。
4. **`saveConfig` 直接覆寫**——寫到一半當機就毀了設定檔（7.7 節）。
5. **`getUserFile`**——路徑穿越漏洞（7.6 節）。
6. **`isExpired` 用 `LocalDate.now()`**——無法測試（7.15 節）。
7. **`toJson` 每次 `new ObjectMapper()`**——效能問題，且沒註冊 `JavaTimeModule`（7.17 節）。
8. **`validateNickname` 用 `length()`**——emoji 被當兩個字（7.4 節），且沒有 null 檢查。

**修正版：**

```java
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.*;
import java.text.BreakIterator;
import java.time.Clock;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.stream.Stream;

public class Fixed {

    // ① DateTimeFormatter 不可變、執行緒安全；格式符號全部修正
    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    // ⑦ ObjectMapper 當單例（設定見 7.17 節的 Json 類別）
    private static final ObjectMapper MAPPER = Json.mapper();

    private final Clock clock;

    Fixed(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock 不可為 null");
    }

    /** ② StringBuilder，並預估容量 */
    public String buildReport(List<Order> orders) {
        StringBuilder sb = new StringBuilder(orders.size() * 32);
        for (Order o : orders) {
            sb.append(o.id()).append(',').append(o.amount()).append('\n');
        }
        return sb.toString();
    }

    /** ③ 串流處理，呼叫者決定要不要收集；用 Stream 讓大檔也能處理 */
    public long countMatchingLines(Path path, String keyword) throws IOException {
        try (Stream<String> lines = Files.lines(path)) {      // ⑧ try-with-resources
            return lines.filter(l -> l.contains(keyword)).count();
        }
    }

    /** ④ 原子寫入：temp + ATOMIC_MOVE */
    public void saveConfig(Path target, String json) throws IOException {
        Path dir = target.toAbsolutePath().getParent();
        Files.createDirectories(dir);
        Path temp = Files.createTempFile(dir, target.getFileName().toString(), ".tmp");
        try {
            Files.writeString(temp, json);
            Files.move(temp, target,
                    StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            Files.deleteIfExists(temp);
            throw e;
        }
    }

    /** ⑤ 防路徑穿越 */
    private static final Path UPLOAD_DIR = Path.of("/var/uploads").toAbsolutePath().normalize();

    public Path getUserFile(String filename) {
        if (filename == null || filename.isBlank()) {
            throw new IllegalArgumentException("檔名不可為空");
        }
        Path target = UPLOAD_DIR.resolve(filename).normalize();
        if (!target.startsWith(UPLOAD_DIR)) {
            throw new SecurityException("非法的檔案路徑: " + filename);
        }
        return target;
    }

    /** ⑥ 注入 Clock */
    public boolean isExpired(LocalDate expiry) {
        Objects.requireNonNull(expiry, "expiry 不可為 null");
        return LocalDate.now(clock).isAfter(expiry);
    }

    /** ⑦ 重用 mapper，並包裝例外 */
    public String toJson(Object o) {
        try {
            return MAPPER.writeValueAsString(o);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException(
                    "序列化失敗，型別=" + (o == null ? "null" : o.getClass().getName()), e);
        }
    }

    /** ⑧ 用字形叢集數，emoji 算一個字 */
    public boolean validateNickname(String nick) {
        if (nick == null || nick.isBlank()) return false;
        return graphemeCount(nick.strip()) <= 10;
    }

    static int graphemeCount(String s) {
        BreakIterator it = BreakIterator.getCharacterInstance(Locale.ROOT);
        it.setText(s);
        int count = 0;
        while (it.next() != BreakIterator.DONE) count++;
        return count;
    }

    record Order(String id, java.math.BigDecimal amount) { }
}
```

</details>

### 練習 2：實作訂閱扣款日計算

實作 `nextBillingDate(LocalDate subscribedOn, int cycleMonths, int cyclesElapsed)`，
回傳下一次扣款日。要處理：

1. 月底訂閱（1/31）不能一路縮成 28 號
2. 2 月沒有 31 號時取月底
3. 週期可以是 1 / 3 / 6 / 12 個月

<details>
<summary>參考解答</summary>

```java
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Set;

public class BillingCalculator {

    private static final Set<Integer> ALLOWED_CYCLES = Set.of(1, 3, 6, 12);

    /**
     * ❌ 錯誤做法：從「上次扣款日」累加。
     * 1/31 → 2/28 → 3/28 → 4/28 …  扣款日永久縮成 28 號
     */
    static LocalDate wrongWay(LocalDate lastBilling, int cycleMonths) {
        return lastBilling.plusMonths(cycleMonths);
    }

    /**
     * ✅ 正確做法：永遠從「原始訂閱日」計算第 N 個週期。
     * 1/31 → 2/28 → 3/31 → 4/30 → 5/31 …  日期會「回彈」
     */
    static LocalDate nextBillingDate(LocalDate subscribedOn, int cycleMonths, int cyclesElapsed) {
        java.util.Objects.requireNonNull(subscribedOn, "subscribedOn 不可為 null");
        if (!ALLOWED_CYCLES.contains(cycleMonths)) {
            throw new IllegalArgumentException(
                    "週期必須是 %s 個月，收到: %d".formatted(ALLOWED_CYCLES, cycleMonths));
        }
        if (cyclesElapsed < 0) {
            throw new IllegalArgumentException("cyclesElapsed 不可為負: " + cyclesElapsed);
        }

        // plusMonths 會自動處理「該月沒有這一天」的情況（縮到月底）
        // 但因為每次都從 subscribedOn 算，所以下個月又會回到原本的日子
        return subscribedOn.plusMonths((long) cycleMonths * (cyclesElapsed + 1));
    }

    /** 產生未來 N 期的扣款日 */
    static List<LocalDate> schedule(LocalDate subscribedOn, int cycleMonths, int periods) {
        return java.util.stream.IntStream.range(0, periods)
                .mapToObj(i -> nextBillingDate(subscribedOn, cycleMonths, i))
                .toList();
    }

    public static void main(String[] args) {

        System.out.println("=== 錯誤做法：從上次扣款日累加 ===");
        LocalDate d = LocalDate.of(2026, 1, 31);
        System.out.print("  " + d);
        for (int i = 0; i < 5; i++) {
            d = wrongWay(d, 1);
            System.out.print(" → " + d);
        }
        System.out.println("  💥 永久停在 28 號");

        System.out.println("\n=== 正確做法：從原始訂閱日算第 N 期 ===");
        LocalDate subscribed = LocalDate.of(2026, 1, 31);
        System.out.println("  訂閱日: " + subscribed);
        schedule(subscribed, 1, 6).forEach(date ->
                System.out.printf("    %s (%s，該月 %d 天)%n",
                        date, date.getDayOfWeek(), date.lengthOfMonth()));

        System.out.println("\n=== 30 號訂閱 ===");
        schedule(LocalDate.of(2026, 1, 30), 1, 4)
                .forEach(date -> System.out.println("    " + date));

        System.out.println("\n=== 季繳（3 個月）===");
        schedule(LocalDate.of(2026, 1, 31), 3, 4)
                .forEach(date -> System.out.println("    " + date));

        System.out.println("\n=== 年繳，遇到閏年 2/29 ===");
        schedule(LocalDate.of(2024, 2, 29), 12, 4)
                .forEach(date -> System.out.println("    " + date));

        System.out.println("\n=== 驗證 ===");
        try {
            nextBillingDate(LocalDate.now(), 2, 0);
        } catch (IllegalArgumentException e) {
            System.out.println("  " + e.getMessage());
        }

        // 計算剩餘天數（要用 ChronoUnit，不是 Period.getDays()）
        LocalDate today = LocalDate.of(2026, 8, 17);
        LocalDate next = nextBillingDate(LocalDate.of(2026, 1, 31), 1, 6);
        System.out.printf("%n距離下次扣款 (%s) 還有 %d 天%n",
                next, ChronoUnit.DAYS.between(today, next));
    }
}
```

輸出：

```
=== 錯誤做法：從上次扣款日累加 ===
  2026-01-31 → 2026-02-28 → 2026-03-28 → 2026-04-28 → 2026-05-28 → 2026-06-28  💥 永久停在 28 號

=== 正確做法：從原始訂閱日算第 N 期 ===
  訂閱日: 2026-01-31
    2026-02-28 (SATURDAY，該月 28 天)
    2026-03-31 (TUESDAY，該月 31 天)
    2026-04-30 (THURSDAY，該月 30 天)
    2026-05-31 (SUNDAY，該月 31 天)
    2026-06-30 (TUESDAY，該月 30 天)
    2026-07-31 (FRIDAY，該月 31 天)

=== 30 號訂閱 ===
    2026-02-28
    2026-03-30
    2026-04-30
    2026-05-30

=== 季繳（3 個月）===
    2026-04-30
    2026-07-31
    2026-10-31
    2027-01-31

=== 年繳，遇到閏年 2/29 ===
    2025-02-28
    2026-02-28
    2027-02-28
    2028-02-29

=== 驗證 ===
  週期必須是 [1, 3, 6, 12] 個月，收到: 2

距離下次扣款 (2026-07-31) 還有 -17 天
```

**關鍵洞見：**

保存「原始訂閱日 + 已過期數」而不是「上次扣款日」，是這類問題的通用解法。
同樣的模式適用於：

- 房貸還款日
- 保險繳費日
- 定期定額投資日
- Cron 表達式的「每月最後一天」

> **注意年繳那組**：2024-02-29 訂閱，之後三年都變成 2/28，直到 2028 閏年才回到 2/29。
> 這正是 `plusMonths` 的「智慧調整 + 從原點計算」帶來的正確行為。

</details>

### 練習 3：實作 log 檔分析器

寫一個工具，分析一個可能有數 GB 的 log 檔（格式：`2026-08-17T06:30:00Z [ERROR] OrderService - 訊息`），
輸出：

1. 每個等級的行數
2. 每小時的錯誤數
3. 最常出現的 5 個錯誤訊息（相同前 50 字視為同一種）
4. 找出「錯誤爆發」的時段（一分鐘內超過 10 個 ERROR）

要求：**記憶體用量不隨檔案大小成長**。

<details>
<summary>參考解答</summary>

```java
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class LogAnalyzer {

    // ✅ 預編譯（7.5 節）。用具名群組讓程式碼可讀
    private static final Pattern LINE = Pattern.compile(
            "^(?<ts>\\S+)\\s+\\[(?<level>\\w+)]\\s+(?<logger>\\S+)\\s+-\\s+(?<message>.*)$");

    private static final int MESSAGE_KEY_LENGTH = 50;
    private static final int BURST_THRESHOLD = 10;

    // ===== 累積的統計狀態：大小只跟「不同的 key 數量」有關，不跟行數有關 =====
    private final Map<String, Long> countByLevel = new TreeMap<>();
    private final Map<String, Long> errorsByHour = new TreeMap<>();
    private final Map<String, Long> errorMessageCounts = new HashMap<>();
    private final Map<String, Long> errorsByMinute = new TreeMap<>();
    private long totalLines = 0;
    private long unparseableLines = 0;

    /** 逐行掃描。記憶體只放一行 + 統計表 */
    public void analyze(Path logFile) throws IOException {
        try (var reader = Files.newBufferedReader(logFile)) {
            String line;
            while ((line = reader.readLine()) != null) {
                totalLines++;
                if (line.isBlank()) continue;
                accept(line);
            }
        }
    }

    private void accept(String line) {
        Matcher m = LINE.matcher(line);
        if (!m.matches()) {
            unparseableLines++;
            return;
        }

        String level = m.group("level");
        countByLevel.merge(level, 1L, Long::sum);

        if (!"ERROR".equals(level)) return;

        // 解析時間戳
        Instant ts;
        try {
            ts = Instant.parse(m.group("ts"));
        } catch (DateTimeParseException e) {
            unparseableLines++;
            return;
        }

        LocalDateTime local = LocalDateTime.ofInstant(ts, ZoneId.of("UTC"));
        errorsByHour.merge(local.withMinute(0).withSecond(0).withNano(0).toString(), 1L, Long::sum);
        errorsByMinute.merge(local.withSecond(0).withNano(0).toString(), 1L, Long::sum);

        // 訊息正規化：取前 N 字，並把數字換成 # 讓「訂單 123 失敗」和「訂單 456 失敗」歸為一類
        String message = m.group("message");
        String key = message.substring(0, Math.min(MESSAGE_KEY_LENGTH, message.length()))
                .replaceAll("\\d+", "#");
        errorMessageCounts.merge(key, 1L, Long::sum);
    }

    // ===== 報表 =====

    public String render() {
        StringBuilder sb = new StringBuilder();
        sb.append("=== Log 分析報告 ===\n");
        sb.append("總行數     : %,d\n".formatted(totalLines));
        sb.append("無法解析   : %,d\n".formatted(unparseableLines));

        sb.append("\n--- 各等級行數 ---\n");
        countByLevel.forEach((lvl, c) -> sb.append("  %-6s %,8d\n".formatted(lvl, c)));

        sb.append("\n--- 每小時錯誤數 ---\n");
        errorsByHour.forEach((hour, c) ->
                sb.append("  %s  %4d %s\n".formatted(hour, c, "█".repeat((int) Math.min(c, 40)))));

        sb.append("\n--- 最常見的錯誤 Top 5 ---\n");
        errorMessageCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed()
                        .thenComparing(Map.Entry.comparingByKey()))
                .limit(5)
                .forEach(e -> sb.append("  %4d 次  %s\n".formatted(e.getValue(), e.getKey())));

        sb.append("\n--- 錯誤爆發時段（一分鐘內 > %d 個）---\n".formatted(BURST_THRESHOLD));
        List<Map.Entry<String, Long>> bursts = errorsByMinute.entrySet().stream()
                .filter(e -> e.getValue() > BURST_THRESHOLD)
                .toList();
        if (bursts.isEmpty()) {
            sb.append("  （無）\n");
        } else {
            bursts.forEach(e -> sb.append("  ⚠️ %s  %d 個錯誤\n".formatted(e.getKey(), e.getValue())));
        }
        return sb.toString();
    }

    // ===== 測試 =====

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("log-analyzer");
        Path log = dir.resolve("app.log");

        // 造一個測試 log：50 萬行，其中有一段「錯誤爆發」
        System.out.println("產生測試 log…");
        Instant base = Instant.parse("2026-08-17T00:00:00Z");
        String[] loggers = {"OrderService", "PaymentService", "InventoryService"};
        String[] errorMsgs = {
                "資料庫連線逾時",
                "呼叫付款閘道失敗，orderId=%d",
                "庫存不足，sku=SKU-%d",
                "找不到訂單 ORD-%d"};

        try (var writer = Files.newBufferedWriter(log)) {
            for (int i = 0; i < 500_000; i++) {
                Instant ts = base.plusSeconds(i / 6);       // 每秒約 6 行 → 涵蓋約 23 小時
                String level;
                String message;

                // 在第 14 小時製造一次爆發
                boolean inBurst = (i / 6) >= 14 * 3600 && (i / 6) < 14 * 3600 + 60;

                if (inBurst && i % 3 == 0) {
                    level = "ERROR";
                    message = "資料庫連線池耗盡";
                } else if (i % 500 == 0) {
                    level = "ERROR";
                    message = errorMsgs[i % errorMsgs.length].contains("%d")
                            ? errorMsgs[i % errorMsgs.length].formatted(i)
                            : errorMsgs[i % errorMsgs.length];
                } else if (i % 97 == 0) {
                    level = "WARN";
                    message = "重試成功";
                } else if (i % 1000 == 1) {
                    level = "DEBUG";
                    message = "細節資訊";
                } else {
                    level = "INFO";
                    message = "處理完成";
                }

                writer.write("%s [%s] %s - %s".formatted(
                        ts, level, loggers[i % loggers.length], message));
                writer.newLine();
            }
            // 故意加幾行格式錯的
            writer.write("這是一行格式不對的 log");
            writer.newLine();
            writer.write("2026-08-17T99:99:99Z [ERROR] X - 時間戳壞掉");
            writer.newLine();
        }

        System.out.printf("檔案大小: %.1f MB%n%n", Files.size(log) / 1024.0 / 1024);

        long start = System.currentTimeMillis();
        var analyzer = new LogAnalyzer();
        analyzer.analyze(log);
        long elapsed = System.currentTimeMillis() - start;

        System.out.println(analyzer.render());
        System.out.printf("分析耗時: %d ms（%,.0f 行/秒）%n",
                elapsed, analyzer.totalLines * 1000.0 / Math.max(elapsed, 1));

        Files.delete(log);
        Files.delete(dir);
    }
}
```

輸出（節錄）：

```
產生測試 log…
檔案大小: 41.3 MB

=== Log 分析報告 ===
總行數     : 500,002
無法解析   : 2

--- 各等級行數 ---
  DEBUG      500
  ERROR     1,020
  INFO    493,325
  WARN      5,155

--- 每小時錯誤數 ---
  2026-08-17T00:00    44 ████████████████████████████████████████
  ...
  2026-08-17T14:00   164 ████████████████████████████████████████
  ...

--- 最常見的錯誤 Top 5 ---
   120 次  資料庫連線池耗盡
   255 次  資料庫連線逾時
   ...

--- 錯誤爆發時段（一分鐘內 > 10 個）---
  ⚠️ 2026-08-17T14:00  120 個錯誤

分析耗時: 1180 ms（423,729 行/秒）
```

**四個設計要點：**

| 要點 | 說明 |
|---|---|
| **記憶體與檔案大小無關** | 用 `BufferedReader` 逐行讀（7.7 節），統計表的大小只跟「不同的 key 數」有關（等級 4 個、小時 24 個、訊息種類幾十個） |
| **訊息正規化** | `replaceAll("\\d+", "#")` 讓「訂單 123 失敗」和「訂單 456 失敗」歸為一類。沒做這步的話 Top 5 會全是不同 ID 的同一種錯誤，看不出重點 |
| **格式錯的行不中斷整批** | `unparseableLines` 計數而不丟例外——真實的 log 一定有壞行（多行堆疊、截斷的寫入）。這是第 03 章 3.8 節模板方法的原則 |
| **爆發偵測用「分桶」而非滑動視窗** | 按分鐘分桶只需要一個 `Map`，滑動視窗需要保存時間戳佇列。分桶會漏掉「跨分鐘邊界的爆發」，但對告警來說夠用且成本低得多 |

**如果要更進一步（實務上會做的）：**

- 用 `Files.lines(log).parallel()`？**不要**——這是 IO 密集（第 06 章 6.15 節），
  而且統計表會有併發問題。真要平行化，用「切割檔案 → 每塊獨立統計 → 合併」的 map-reduce 模式。
- 訊息正規化用 Drain3 這類 log 模板探勘演算法，比正則取代準確得多。
- 實務上這件事交給 Loki / Elasticsearch / CloudWatch Insights 做。
  自己寫的價值在於**離線分析一個下載回來的 log 檔**，這時候沒有基礎設施可用。

</details>

### 練習 4：預測輸出

```java
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.Period;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

public class Quiz {
    public static void main(String[] args) {
        // ①
        System.out.println("👍".length() + " " + "你好".length());

        // ②
        LocalDate d = LocalDate.of(2018, 12, 31);
        System.out.println(d.format(DateTimeFormatter.ofPattern("yyyy")) + " "
                + d.format(DateTimeFormatter.ofPattern("YYYY")));

        // ③
        LocalDate jan31 = LocalDate.of(2026, 1, 31);
        System.out.println(jan31.plusMonths(1).plusMonths(1) + " " + jan31.plusMonths(2));

        // ④
        LocalDate a = LocalDate.of(2026, 1, 1);
        LocalDate b = LocalDate.of(2026, 12, 31);
        System.out.println(Period.between(a, b).getDays() + " "
                + ChronoUnit.DAYS.between(a, b));

        // ⑤
        ZoneId ny = ZoneId.of("America/New_York");
        ZonedDateTime z = LocalDateTime.of(2026, 3, 8, 2, 30).atZone(ny);
        System.out.println(z.toLocalTime());

        // ⑥
        System.out.println("a.b.c".split("\\.").length + " " + "a.b.c".split(".").length);

        // ⑦
        System.out.println(Path.of("/var/data").resolve("/etc/passwd"));
    }
}
```

<details>
<summary>參考解答</summary>

```
2 2
2018 2019
2026-03-28 2026-03-31
30 364
03:30
3 0
/etc/passwd
```

**逐一說明：**

**①** `2 2`
`"👍"` 是 U+1F44D，超出 BMP，需要**兩個** UTF-16 碼元（代理對）→ `length()` 是 2。
`"你好"` 兩個中文字各佔一個碼元 → 也是 2。**兩個看起來字數不同的字串，`length()` 相同。**（7.4 節）

**②** `2018 2019`
`yyyy` 是曆年 → 2018。
`YYYY` 是**以週為基準的年**：2018-12-31 是週一，該 ISO 週的週四落在 2019-01-03，
所以該週屬於 2019 → 印出 2019。**差了一年。**（7.13 節）

**③** `2026-03-28 2026-03-31`
`1/31 + 1 月` → 2 月沒有 31 號，縮到 `2026-02-28`。
再 `+ 1 月` → `2026-03-28`（已經被縮過，回不去了）。
直接 `+ 2 月` → `2026-03-31`（3 月有 31 號）。
**這就是練習 2 訂閱扣款日的核心問題。**（7.11 節）

**④** `30 364`
`Period.between(1/1, 12/31)` = `P11M30D`，`getDays()` 只取「天的部分」= 30。
總天數要用 `ChronoUnit.DAYS.between()` = 364（2026 非閏年，365 天減去起始那天）。（7.14 節）

**⑤** `03:30`
2026-03-08 美東進入 DST，凌晨 2:00 直接跳到 3:00，所以 **02:30 不存在**。
`atZone` 會靜默把它調整成 `03:30`。（7.12 節陷阱 1）

**⑥** `3 0`
`split("\\.")` 正確跳脫 → 3 個欄位。
`split(".")` 的 `.` 在 regex 是「任意字元」→ 每個字元都是分隔符 → 全部變成空字串，
而 `split` 預設丟掉尾端空字串 → 長度 0。（第 01 章 1.9 節、7.5 節）

**⑦** `/etc/passwd`
`resolve` 遇到**絕對路徑**時，會直接回傳那個絕對路徑，**完全忽略 base**。
這就是 7.6 節路徑穿越漏洞的另一種形式——除了 `../`，直接給絕對路徑也能逃出限制。
所以檢查必須是 `normalize()` 之後 `startsWith(base)`，不能只擋 `..`。

</details>

### 練習 5：判斷該用哪個時間型別

| # | 需求 | 你的選擇 |
|---|---|---|
| 1 | 使用者的生日 |  ? |
| 2 | 訂單建立時間 | ? |
| 3 | 「每天 09:00 開始營業」 | ? |
| 4 | 使用者在 App 裡設定的「下週三 14:00 開會」（要跟著他的時區） | ? |
| 5 | 快取的過期時間 | ? |
| 6 | 「這個訂閱還剩幾天」 | ? |
| 7 | 「這支 API 花了多久」 | ? |
| 8 | 發票的開立日期 | ? |
| 9 | 資料庫的 `created_at` 欄位 | ? |
| 10 | JWT 的 `exp` 欄位 | ? |

<details>
<summary>參考解答</summary>

| # | 選擇 | 理由 |
|---|---|---|
| 1 | **`LocalDate`** | 生日與時區無關。「1990-05-20」在任何地方都是同一天。用 `Instant` 存會導致「跨時區的使用者看到生日錯一天」 |
| 2 | **`Instant`** | 事件時刻，時間軸上的絕對點。**不要用 `LocalDateTime`**（沒有時區，伺服器搬家資料意義就變了） |
| 3 | **`LocalTime`** | 「09:00」是各分店的當地時間，跟具體日期與時區無關。搭配門市的 `ZoneId` 欄位在需要時解析 |
| 4 | **`LocalDateTime` + `ZoneId` 兩個欄位** | 關鍵在「未來」+「要跟著當地時區」。存成 `Instant` 的話，若該國在會議之前改了 DST 規則，會議就跑掉一小時（7.12 節第 ② 點）。這也是 Google Calendar 的做法 |
| 5 | **`Instant`**（絕對過期點）或 **`Duration`**（TTL） | 存 `Instant expiresAt` 讓判斷簡單（`clock.instant().isAfter(expiresAt)`）。設定用 `Duration.ofMinutes(5)` 表達 TTL |
| 6 | **`ChronoUnit.DAYS.between()`** | **不要用 `Period.getDays()`**（只是天的部分，不是總天數） |
| 7 | **`Duration`** + `System.nanoTime()` | ⚠️ 量測耗時要用 `System.nanoTime()` 或 `Clock.tick`，**不要用 `Instant.now()` 相減**——系統時鐘可能被 NTP 校正而倒退，算出負的耗時。`nanoTime` 是單調遞增的 |
| 8 | **`LocalDate`** | 純日期。發票日期是法律文件上的日期，不是時刻 |
| 9 | **`DATETIME(6)` 存 UTC ↔ Java `Instant`** | 見 7.16 節。PostgreSQL 用 `timestamptz` 更好 |
| 10 | **epoch 秒（`long`）** | JWT 規格（RFC 7519）明定 `exp` / `iat` / `nbf` 是 **NumericDate**，即 epoch 秒。Java 端用 `Instant.getEpochSecond()` / `Instant.ofEpochSecond()` 轉換。這是「規格說了算」的情況，不要自己改成 ISO 字串 |

**第 7 題值得單獨示範，因為它是常見錯誤：**

```java
import java.time.Duration;
import java.time.Instant;

public class MeasuringElapsedTime {
    public static void main(String[] args) throws InterruptedException {

        // ❌ 用系統時鐘量耗時：NTP 校正、手動改時間、DST 都會影響
        Instant t1 = Instant.now();
        Thread.sleep(50);
        Instant t2 = Instant.now();
        System.out.println("Instant 相減 : " + Duration.between(t1, t2).toMillis() + " ms");
        // 大多數時候正確，但如果這 50ms 內系統時鐘被往後校正了 1 秒，
        // 你會得到「-950 ms」這種不可能的結果

        // ✅ 用 nanoTime：單調遞增，專為量測時間差設計
        long n1 = System.nanoTime();
        Thread.sleep(50);
        long n2 = System.nanoTime();
        System.out.printf("nanoTime 相減: %.2f ms%n", (n2 - n1) / 1e6);

        System.out.println("""

                規則：
                  「現在是什麼時候」  → Instant.now() / clock.instant()
                  「這件事花了多久」  → System.nanoTime()
                nanoTime 的絕對值沒有意義（不是 epoch），只能用來相減。
                """);
    }
}
```

</details>

---

## 7.21 驗收清單

- [ ] 我知道 Java 9+ 的 compact strings 讓純英文字串省一半記憶體。
- [ ] 我知道只有「迴圈中串接」才需要 `StringBuilder`。
- [ ] 我能解釋 `"👍".length() == 2`，也知道驗證使用者字數該用碼點或字形叢集。
- [ ] 我的 `getBytes` / `new String(byte[])` 一律帶 `StandardCharsets.UTF_8`。
- [ ] 我把 `Pattern` 宣告成 `static final`，也知道 `Matcher` 不能共用。
- [ ] 我知道什麼是災難性回溯，也知道不要從網路複製複雜的 email regex。
- [ ] 我用 `Path` / `Files` 而不是 `java.io.File`。
- [ ] 我知道 `resolve` 遇到絕對路徑會忽略 base，也知道路徑穿越的正確防禦寫法。
- [ ] 我知道 `Files.lines` / `walk` / `list` 必須 try-with-resources。
- [ ] 我會用 temp + `ATOMIC_MOVE` 做原子寫入。
- [ ] 我知道 CSV 不能用 `split(",")` 解析，也知道 BOM 該什麼時候去掉、什麼時候加上。
- [ ] 我能在 `LocalDate` / `LocalDateTime` / `Instant` / `ZonedDateTime` / `OffsetDateTime` 之間選對。
- [ ] 我知道事件時刻要用 `Instant`，純日期要用 `LocalDate`。
- [ ] 我能說出春季/秋季調時的兩個陷阱，以及 `Duration` 與 `Period` 在 DST 下的差別。
- [ ] 我知道 `YYYY` / `DD` / `mm` / `hh` 這四個格式符號的坑。
- [ ] 我知道 `SimpleDateFormat` 不是執行緒安全的。
- [ ] 我用 `ChronoUnit.between` 算總天數，不用 `Period.getDays()`。
- [ ] 我用注入的 `Clock` 而不是直接呼叫 `now()`，也知道量測耗時該用 `System.nanoTime()`。
- [ ] 我知道 `ObjectMapper` 要當單例，也知道必須 `registerModule(new JavaTimeModule())`。
- [ ] 我知道泛型集合要用 `TypeReference`，也知道絕不能開啟 Jackson 的 Default Typing。
- [ ] 我知道 `long` ID 傳給前端要轉字串，密碼欄位要 `@JsonIgnore`。

---

完成後請前往 [08-concurrency-thread-executor.md](./08-concurrency-thread-executor.md)。


