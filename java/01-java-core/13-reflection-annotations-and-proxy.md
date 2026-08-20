# 第 13 章：反射、註解與動態代理

> 前面十二章，你寫的每一行程式都遵守同一個前提：
> **你呼叫誰，編譯器就檢查誰。** 方法名打錯會紅、參數型別不對會紅、類別不存在會紅。
>
> 這一章要把這個前提拆掉——讓程式在**執行期**才決定要呼叫什麼。
>
> 這聽起來很危險，而它確實很危險。但你已經用了一整站的工具都建立在這上面：
> JUnit 怎麼找到你的 `@Test`、Jackson 怎麼把 JSON 填進你的欄位、
> Mockito 的 `mock()` 回傳的到底是什麼東西——答案全都在這一章。
>
> **這一章是 01 站和 02 站之間的橋。** 讀完之後，Spring 的「魔法」對你來說
> 會變成一句話：「喔，它就是在 classpath 上掃註解，然後動態產代理。」

---

## 13.1 學習目標

完成本章後，你應該可以：

- 說明 `Class` 物件是什麼、從哪來，以及三種取得方式的差別。
- 用反射讀出一個類別的欄位、方法、建構子，並說出 `getXxx` 與 `getDeclaredXxx` 的四個差異。
- 用反射建立物件、呼叫方法，並**正確處理 `InvocationTargetException`**。
- 說明 `setAccessible(true)` 在 Java 17+ 的強封裝下什麼時候會失敗，以及 `--add-opens` 的代價。
- 說明型別抹除的那個例外，並讀出 `List<String>` 裡的 `String`。
- 自訂註解，並說出 `@Retention` 三個值選錯時各自的**症狀**。
- **用 40 行寫出一個能跑的迷你測試框架**，然後知道 JUnit 沒有魔法。
- 用 `Proxy.newProxyInstance` 寫出動態代理，並說明**為什麼代理內部的 `this` 不是代理**。
- 說出反射的四種代價，以及六個「反射會壞掉」的實務情境與修法。
- 把你手寫的東西對應回 Spring / Jackson / JPA / JUnit 的哪個機制。

## 前置知識

- 第 03 章：介面與「對介面編程」（動態代理只能代理介面）。
- 第 04 章：例外鏈與 `getCause()`（處理 `InvocationTargetException` 一定要用）。
- 第 05 章 5.12：型別抹除（本章要講它的例外）。
- 第 09 章 9.6：類別載入機制（`Class` 物件從哪來）。

---

## 13.2 先看見魔法：四件你已經做過、但沒問過為什麼的事

### 魔法 1：你從來沒有呼叫過你的測試方法

第 11 章你寫了 85 個測試。每一個長這樣：

```java
@Test
void 過期的待辦事項應該被標記為逾期() {
    // ...
}
```

**這個方法是 package-private 的，而且沒有任何一行程式碼呼叫它。**
它為什麼會跑？誰呼叫的？

### 魔法 2：Jackson 填進了你沒有 setter 的欄位

第 07 章的 `Todo` 是不可變物件——沒有 setter，欄位是 `private final`。
然後你寫了：

```java
Todo todo = objectMapper.readValue(json, Todo.class);
```

**Jackson 是誰？它憑什麼寫得進你的 `private final` 欄位？**

### 魔法 3：Maven 設定裡那個沒解釋的編譯參數

第 10 章 10.10 節，`maven-compiler-plugin` 裡有這麼一行：

```xml
<arg>-parameters</arg>          <!-- 保留參數名，給反射 / Jackson 用 -->
```

註解寫了「給反射用」，但沒說**不加會怎樣**。（答案在 13.14。）

### 魔法 4：`mock(TodoRepository.class)` 回傳的是什麼

第 11 章：

```java
TodoRepository repo = mock(TodoRepository.class);
when(repo.findById(1L)).thenReturn(Optional.of(todo));
```

`TodoRepository` 是一個**介面**。介面不能 `new`。
那 `repo` 這個變數裡裝的到底是什麼類別的物件？

---

### 四個魔法，三個機制

| 魔法 | 用到的機制 | 本章小節 |
|---|---|---|
| JUnit 找到 `@Test` | 反射掃描 + 自訂註解 | 13.4、13.8、13.10 |
| Jackson 寫入 `private final` | 反射 + `setAccessible` | 13.5、13.6 |
| `-parameters` | 反射讀參數名 | 13.14 |
| `mock()` 回傳的物件 | **動態代理** | 13.11 |

這三個機制（**反射、註解、動態代理**）就是這一章的全部內容。
它們也是下一站 Spring 的全部基礎——
Spring 不是有一百個魔法，它是把這三個機制用了一百次。

---

## 13.3 `Class`：型別在執行期的樣子

編譯之後，`.java` 變成 `.class`。類別載入器把 `.class` 讀進 Metaspace（第 09 章 9.5），
同時在堆積上建立一個 `Class` 物件當作它的「名片」。

**反射的一切都從拿到這張名片開始。**

### 三種取得方式

```java
package com.example.todo.reflect;

public class HowToGetClass {

    public static void main(String[] args) throws Exception {

        // ① 類別字面值：編譯期就決定，最快、最安全
        Class<String> c1 = String.class;

        // ② 從實例拿：執行期的「真實型別」，不是宣告型別
        Object obj = "hello";
        Class<?> c2 = obj.getClass();          // String.class，不是 Object.class

        // ③ 從字串拿：★ 框架都用這個（因為類別名寫在設定檔裡）
        Class<?> c3 = Class.forName("java.lang.String");

        System.out.println(c1 == c2);           // true
        System.out.println(c2 == c3);           // true
    }
}
```

> 🔑 **`Class` 物件是單例的**——同一個類別、同一個 ClassLoader，永遠是同一個 `Class` 物件。
> 所以可以放心用 `==` 比較（第 05 章 5.7 提過 `getClass() == o.getClass()` 的 `equals` 寫法就是靠這個）。
>
> ⚠️ **「同一個 ClassLoader」是關鍵。** 不同 ClassLoader 載入的同一個類別，
> 是兩個不同的 `Class` 物件，`==` 為 `false`，互相轉型會丟 `ClassCastException`。
> 這就是第 09 章 9.6 說的「類別的身分是 **全限定名 + ClassLoader**」。

### `Class.forName` 的兩個陷阱

**陷阱一：它會觸發靜態初始化**

```java
// 這一行不只是「找到類別」，它會執行 static 區塊（第 02 章 2.8 的初始化順序）
Class.forName("com.mysql.cj.jdbc.Driver");
// ↑ 老 JDBC 教學裡的這一行，作用就是讓 Driver 的 static 區塊去註冊自己

// 不想觸發初始化：第二個參數傳 false
Class.forName("com.mysql.cj.jdbc.Driver", false, MyClass.class.getClassLoader());
```

**陷阱二：內部類別與陣列的名字不是你以為的那個**

```java
package com.example.todo.reflect;

import java.util.List;

public class ClassNames {

    static class Nested {}                      // 巢狀類別（第 02 章 2.12）

    public static void main(String[] args) {
        show(String.class);
        show(Nested.class);
        show(int.class);
        show(String[].class);
        show(int[][].class);
        show(List.class);
    }

    static void show(Class<?> c) {
        System.out.printf("%-30s | %-22s | %s%n",
                c.getName(), c.getSimpleName(), c.getCanonicalName());
    }
}
```

輸出：

```
java.lang.String               | String                 | java.lang.String
com.example...ClassNames$Nested| Nested                 | com.example...ClassNames.Nested
int                            | int                    | int
[Ljava.lang.String;            | String[]               | java.lang.String[]
[[I                            | int[][]                | int[][]
java.util.List                 | List                   | java.util.List
```

| 方法 | 用途 | 陷阱 |
|---|---|---|
| `getName()` | **`Class.forName` 吃的名字** | 內部類別用 `$`、陣列是 `[L...;` 這種天書 |
| `getSimpleName()` | 給人看的短名 | 匿名類別會回**空字串** |
| `getCanonicalName()` | 原始碼裡寫的樣子 | 匿名 / 區域類別回 `null` |

> ⚠️ **要用字串載入內部類別，一定要用 `$`**：
> `Class.forName("com.example.ClassNames$Nested")`。
> 寫成 `.Nested` 會丟 `ClassNotFoundException`——
> 這是設定檔裡填類別名時最常見的錯字（第 09 章 9.5 的 `ClassNotFoundException` 排查清單）。

---

## 13.4 讀出一個類別的結構

拿到 `Class` 之後，可以問它四種問題：有哪些**欄位**、**方法**、**建構子**、**註解**。

每一種都有兩個版本：`getXxx()` 和 `getDeclaredXxx()`。**這兩個的差別是本節最重要的事。**

### `getFields` vs `getDeclaredFields`

| | `getFields()` | `getDeclaredFields()` |
|---|---|---|
| 私有成員 | ❌ 看不到 | ✅ 看得到 |
| 繼承來的 | ✅ 看得到（僅 public） | ❌ 看不到 |
| 介面常數 | ✅ 看得到 | ❌ 看不到 |
| 實務上用哪個 | 幾乎不用 | **框架都用這個** |

> 🔑 **記法**：`Declared` = 「這個類別**自己宣告**的全部」，不含繼承、含私有。
> 因為框架要處理的通常是 `private` 欄位，所以答案幾乎永遠是 `getDeclaredFields()`。
>
> **要連父類別的私有欄位一起拿，得自己往上爬**（見下方 `allFields`）——
> 這也是為什麼 Spring 有 `ReflectionUtils.doWithFields()` 這種工具方法。

### 完整範例：印出一個類別的全貌

```java
package com.example.todo.reflect;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;

public class ClassInspector {

    /** 印出類別自己宣告的結構。 */
    public static void inspect(Class<?> type) {
        System.out.println("=== " + type.getName() + " ===");
        System.out.println("修飾子      : " + Modifier.toString(type.getModifiers()));
        System.out.println("父類別      : " + type.getSuperclass());
        System.out.println("實作介面    : " + List.of(type.getInterfaces()));
        System.out.println("是 record ? : " + type.isRecord());          // Java 16+
        System.out.println("是 sealed ? : " + type.isSealed());          // Java 17+
        System.out.println("是 enum   ? : " + type.isEnum());

        System.out.println("--- 欄位 ---");
        for (Field f : type.getDeclaredFields()) {
            if (f.isSynthetic()) continue;                    // ★ 跳過編譯器產生的（見下方警告）
            System.out.printf("  %s %s %s%n",
                    Modifier.toString(f.getModifiers()), f.getType().getSimpleName(), f.getName());
        }

        System.out.println("--- 建構子 ---");
        for (Constructor<?> c : type.getDeclaredConstructors()) {
            System.out.printf("  %s(%s)%n", type.getSimpleName(), typeNames(c.getParameterTypes()));
        }

        System.out.println("--- 方法 ---");
        for (Method m : type.getDeclaredMethods()) {
            if (m.isSynthetic()) continue;
            System.out.printf("  %s %s %s(%s)%n",
                    Modifier.toString(m.getModifiers()), m.getReturnType().getSimpleName(),
                    m.getName(), typeNames(m.getParameterTypes()));
        }
    }

    /** 含繼承鏈的所有欄位（框架真正需要的版本）。 */
    public static List<Field> allFields(Class<?> type) {
        List<Field> result = new ArrayList<>();
        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            for (Field f : c.getDeclaredFields()) {
                if (!f.isSynthetic() && !Modifier.isStatic(f.getModifiers())) {
                    result.add(f);
                }
            }
        }
        return result;
    }

    private static String typeNames(Class<?>[] types) {
        List<String> names = new ArrayList<>();
        for (Class<?> t : types) names.add(t.getSimpleName());
        return String.join(", ", names);
    }
}
```

### 三個一定會踩的坑

**坑一：順序不保證**

```java
// ❌ 這段程式在你的機器上可能通過，在 CI 上失敗
Field[] fields = Todo.class.getDeclaredFields();
assertThat(fields[0].getName()).isEqualTo("id");
```

規格明確寫著：`getDeclaredFields()` / `getDeclaredMethods()` **回傳順序未定義**。
不同 JVM 版本、不同作業系統可能不同——這正是第 11 章 11.18 提過的
「換一台 CI 機器就開始失敗」的測試裡，最難查的一種。

> ✅ **需要固定順序就自己排**：`Arrays.sort(fields, Comparator.comparing(Field::getName))`。
> 或者對 `record` 用 `getRecordComponents()`——**它保證是宣告順序**（第 12 章 12.5）。

**坑二：`synthetic` 成員**

編譯器會偷偷加東西：內部類別的 `this$0`、enum 的 `$VALUES`、
泛型方法的橋接方法（bridge method）、lambda 的 `lambda$main$0`。
**掃描時一律先 `if (m.isSynthetic()) continue;`**，否則你會處理到不存在於原始碼裡的成員。

**坑三：每次呼叫都回傳新陣列**

`getDeclaredMethods()` 內部會**複製一份陣列**再回傳（防止你改到它的內部狀態）。
在迴圈裡呼叫它 = 每次都配置新物件。**框架一律快取結果**——這也是 13.13 的效能重點。

---

## 13.5 動態建立物件與呼叫方法

讀得到結構之後，下一步是「動手」。

### 建立物件

```java
package com.example.todo.reflect;

import java.lang.reflect.Constructor;
import java.time.Instant;

public class CreateByReflection {

    public static void main(String[] args) throws Exception {

        // ① 無參數建構子 —— 框架最愛的路徑
        Class<?> type = Class.forName("com.example.todo.model.MutableTodo");
        Object o1 = type.getDeclaredConstructor().newInstance();

        // ② 有參數建構子 —— 要先用參數型別把它找出來
        Constructor<?> ctor = type.getDeclaredConstructor(String.class, Instant.class);
        Object o2 = ctor.newInstance("寫第 13 章", Instant.now());

        System.out.println(o1);
        System.out.println(o2);
    }
}
```

> ⚠️ **`type.newInstance()`（沒有 `getDeclaredConstructor()`）在 Java 9 起已棄用。**
> 舊教學到處都是這個寫法，它的問題是**會把建構子丟出的 checked 例外「偷渡」出來**，
> 繞過編譯器的 checked 例外檢查（第 04 章 4.5）。一律用
> `getDeclaredConstructor().newInstance()`。

### 為什麼框架都要求「無參數建構子」

第 02 章 2.4 提過一句「JPA Entity、Jackson 反序列化都需要無參數建構子」。
現在你看得到原因了：

```
框架拿到的資訊：一個 Class 物件 + 一包 JSON / 一列資料庫資料
框架不知道的事：你的建構子參數順序是什麼、哪個參數對應哪個欄位

所以它只能：① 用無參數建構子建出空殼 → ② 一個一個欄位填進去
```

**沒有無參數建構子，框架連第一步都做不到。**

> 🔑 這也解釋了第 12 章 12.7 說的「**`record` 不能當 JPA `@Entity`**」：
> record 沒有無參數建構子，而且欄位是 final（13.6 會看到反射也改不了）。
>
> 但 **Jackson 可以處理 record**——因為 Jackson 支援第二條路：
> 讀 `getRecordComponents()` 拿到元件順序，湊齊參數後**直接呼叫 canonical constructor**。
> 這就是第 12 章 12.5 說的「反序列化一定經過驗證」的實作原理。

### 呼叫方法：`Method.invoke`

```java
package com.example.todo.reflect;

import java.lang.reflect.Method;

public class InvokeByReflection {

    public static void main(String[] args) throws Exception {
        String target = "hello world";

        // 用「方法名 + 參數型別」把 Method 找出來
        Method substring = String.class.getMethod("substring", int.class, int.class);

        // invoke(接收者, 參數...) —— 回傳值一律是 Object
        Object result = substring.invoke(target, 0, 5);
        System.out.println(result);                     // hello

        // static 方法：接收者傳 null
        Method valueOf = String.class.getMethod("valueOf", int.class);
        System.out.println(valueOf.invoke(null, 42));   // "42"
    }
}
```

四個要點：

| 要點 | 說明 |
|---|---|
| 參數型別要**精確** | `getMethod("substring", int.class)` ✅；`Integer.class` ❌ 找不到 |
| 回傳值一律 `Object` | 基本型別會被裝箱（第 01 章 1.7）；`void` 方法回 `null` |
| 找不到方法丟 `NoSuchMethodException` | 而且是 **checked**（第 04 章 4.5） |
| 呼叫失敗丟 `InvocationTargetException` | **★ 下面這一段是本節最重要的** |

### ★ `InvocationTargetException`：反射最常見的坑

```java
package com.example.todo.reflect;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

public class TheWrappingTrap {

    static class Service {
        void doWork() {
            throw new IllegalStateException("庫存不足");
        }
    }

    public static void main(String[] args) throws Exception {
        Method m = Service.class.getDeclaredMethod("doWork");

        // ❌ 錯誤示範：catch 到的例外訊息是 null，完全看不出發生什麼事
        try {
            m.invoke(new Service());
        } catch (InvocationTargetException e) {
            System.out.println("訊息：" + e.getMessage());        // null ← 沒有任何資訊
        }

        // ✅ 正確：真正的例外在 getCause() 裡（第 04 章 4.7 的例外鏈）
        try {
            m.invoke(new Service());
        } catch (InvocationTargetException e) {
            Throwable real = e.getCause();
            System.out.println("真正的例外：" + real);            // java.lang.IllegalStateException: 庫存不足
            throw asRuntime(real);                               // 把它原封不動往上丟
        }
    }

    /** 反射框架的標準做法：解開包裝，保留原始例外。 */
    static RuntimeException asRuntime(Throwable t) {
        if (t instanceof RuntimeException re) return re;          // 第 12 章 12.9 的 instanceof 模式
        if (t instanceof Error err) throw err;
        return new RuntimeException(t);                           // checked 例外只能包起來
    }
}
```

> 🔑 **`InvocationTargetException` 本身永遠沒有訊息。**
> 它只是一層信封——**你要的東西在 `getCause()` 裡**。
>
> 這是所有「框架的堆疊追蹤有 40 層，看不到我的程式」的根源。
> 之後你在 Spring 看到 `UndeclaredThrowableException`、
> 在 JUnit 看到 `InvocationTargetException`，處理方式完全一樣：**先 `getCause()`**。

---

## 13.6 `setAccessible`：打破封裝，以及 Java 17 之後打不破的地方

第 02 章花了一整節講封裝：`private` 是為了不讓外面亂改。
現在要說一件會讓人不安的事：**`private` 擋得住編譯器，擋不住反射。**

```java
package com.example.todo.reflect;

import java.lang.reflect.Field;

public class BreakingEncapsulation {

    static class Account {
        private String owner = "alice";
        private long balance = 100;
    }

    public static void main(String[] args) throws Exception {
        Account account = new Account();

        Field balance = Account.class.getDeclaredField("balance");
        balance.setAccessible(true);                 // ★ 關掉存取檢查

        System.out.println(balance.get(account));    // 100
        balance.set(account, 999_999L);              // 直接改私有欄位
        System.out.println(balance.get(account));    // 999999
    }
}
```

**這就是 Jackson 怎麼填進你 `private final` 欄位的。** 沒有魔法，就是 `setAccessible(true)`。

### Java 9 模組系統之後：三種結果

`setAccessible` 現在會依「目標在哪個模組」有三種完全不同的下場：

| 目標 | 結果 | 說明 |
|---|---|---|
| **你自己的類別**（classpath 上，unnamed module） | ✅ 成功 | 99% 的情況，包含你的專案與大部分函式庫 |
| **JDK 內部類別**（`java.base` 等未 open 的套件） | ❌ `InaccessibleObjectException` | Java 16 起預設強封裝（JEP 396），Java 17 起無法用旗標整體放寬（JEP 403） |
| **有 `module-info.java` 且沒 `opens` 的模組** | ❌ `InaccessibleObjectException` | 第 10 章 10.12 的 JPMS 模組 |

```
java.lang.reflect.InaccessibleObjectException: Unable to make field private final
  java.lang.String java.lang.String.value accessible: module java.base does not
  "opens java.lang" to unnamed module @0x1b6d3586
```

看到這個訊息，代表有函式庫在偷改 JDK 內部結構。兩條路：

```bash
# ① 治標：開一個洞（要寫進啟動參數，不能只在 IDE 設定）
java --add-opens java.base/java.lang=ALL-UNNAMED -jar app.jar

# ② 治本：升級那個函式庫。它會用這種寫法通常代表它很久沒維護了
#    第 00 章 0.11 的「升 JDK 卡住」排查清單裡，這是第一名的原因
```

> ⚠️ **`--add-opens` 是技術債，不是解法。**
> 它要同步寫進：本機 IDE、Maven Surefire（`argLine`）、Dockerfile 的 `ENTRYPOINT`、
> K8s 的 `JAVA_TOOL_OPTIONS`——**漏掉任何一個地方，就會出現「本機好好的，上線就炸」**。
> 這是 02-spring-boot 第 08 章「設定要一致」那條原則的典型案例。

### record 的欄位：反射也改不了

```java
record Money(String currency, long amount) {}

Field f = Money.class.getDeclaredField("amount");
f.setAccessible(true);              // 這一行會成功
f.set(new Money("TWD", 100), 999);  // ❌ IllegalAccessException: Can not set final field
```

record 的欄位是 JVM 層級的 **trusted final**，反射沒有後門。

> 🔑 這是第 12 章「用 record 表達不可變資料」的一個隱藏好處：
> **它的不可變性連反射都打不破。** 普通類別的 `private final` 反射還是改得掉。

### 什麼時候可以用 `setAccessible`

| 情境 | 可以嗎 | 理由 |
|---|---|---|
| 寫框架 / 序列化 / DI 容器 | ✅ | 這是唯一的做法 |
| 測試裡設定一個沒有 setter 的狀態 | ⚠️ 可以，但先想想 | 通常代表**設計問題**（第 11 章 11.13：難以測試是症狀） |
| 在正式商業邏輯裡改別人的私有欄位 | ❌ **絕對不要** | 對方一改欄位名，你在執行期才炸，而且編譯器與 IDE 都不會警告你 |

---

## 13.7 泛型與反射：型別抹除的那個例外

第 05 章 5.12 講過型別抹除：`List<String>` 和 `List<Integer>` 在執行期是同一個類別。

但那一節結尾留了一句話：

> 型別抹除有一個例外：**類別、欄位、方法簽章上的泛型資訊會保留在位元碼裡**（供反射讀取）。

現在把它兌現。

```java
package com.example.todo.reflect;

import java.lang.reflect.Field;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.List;
import java.util.Map;

public class GenericsAtRuntime {

    static class Holder {
        List<String> names;
        Map<String, List<Integer>> index;
    }

    public static void main(String[] args) throws Exception {

        Field names = Holder.class.getDeclaredField("names");

        System.out.println(names.getType());          // interface java.util.List ← 抹除後的
        System.out.println(names.getGenericType());   // java.util.List<java.lang.String> ← ★ 還在！

        // 取出型別參數
        ParameterizedType pt = (ParameterizedType) names.getGenericType();
        Type[] args1 = pt.getActualTypeArguments();
        System.out.println(args1[0]);                 // class java.lang.String

        // 巢狀泛型也讀得到
        Field index = Holder.class.getDeclaredField("index");
        ParameterizedType pt2 = (ParameterizedType) index.getGenericType();
        System.out.println(pt2.getActualTypeArguments()[1]);   // java.util.List<java.lang.Integer>
    }
}
```

### 保留 vs 不保留：一張表

| 泛型出現的位置 | 執行期讀得到嗎 | 例子 |
|---|---|---|
| **欄位宣告** | ✅ | `List<String> names;` |
| **方法參數 / 回傳型別** | ✅ | `List<Todo> findAll()` |
| **類別 / 介面的父型別** | ✅ | `class TodoRepo implements Repository<Todo>` |
| **區域變數** | ❌ | `List<String> tmp = ...;`（方法內） |
| **實例本身** | ❌ | `new ArrayList<String>()` 建出來的物件不知道自己是 `<String>` |

> 🔑 **一句話**：泛型資訊寫在「**宣告**」上，不寫在「**物件**」上。
> 所以 `list.getClass()` 永遠只會告訴你 `ArrayList`，
> 但 `field.getGenericType()` 會告訴你 `ArrayList<String>`。

### 這就是 Jackson `TypeReference` 的原理

第 07 章 7.17 你寫過這個，當時只說「泛型會被抹除，所以要用 `TypeReference`」：

```java
// ❌ 抹除後 Jackson 不知道要建 List<Todo> 還是 List<Object>
List<Todo> todos = mapper.readValue(json, List.class);

// ✅ 匿名子類別把泛型「釘」在類別宣告上 —— 於是它被寫進了位元碼
List<Todo> todos = mapper.readValue(json, new TypeReference<List<Todo>>() {});
```

`new TypeReference<List<Todo>>() {}` 最後那對大括號很關鍵：
它建立了一個**匿名子類別**，於是 `List<Todo>` 從「區域變數的泛型」變成了
「**類別宣告的父型別泛型**」——上表第三列，執行期讀得到。

`TypeReference` 內部做的事就是：

```java
Type superClass = getClass().getGenericSuperclass();
this.type = ((ParameterizedType) superClass).getActualTypeArguments()[0];
```

> 這個技巧叫 **super type token**。你會在 Jackson、Gson、Guice、Spring 的
> `ParameterizedTypeReference` 裡看到同一段程式碼。

---

## 13.8 註解：自己做一個

到目前為止，反射能讓你「讀得到結構」。但還缺一件事：
**框架怎麼知道哪個方法要被特別對待？**

答案是註解——一種**貼在程式碼上、可以被反射讀到的標籤**。

### 註解的三個要素

```java
package com.example.todo.mini;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 標記一個方法是測試方法。
 */
@Documented                                      // ③ 出現在 Javadoc 裡（可選）
@Target(ElementType.METHOD)                      // ② 只能貼在方法上
@Retention(RetentionPolicy.RUNTIME)              // ① ★ 執行期讀得到 ★
public @interface MiniTest {

    /** 這個測試的說明；留空就用方法名。 */
    String value() default "";

    /** 預期會丟出的例外；預設 None 表示不預期例外。 */
    Class<? extends Throwable> expected() default None.class;

    /** 用來表示「沒有指定」的哨兵型別（註解屬性不能是 null）。 */
    final class None extends Throwable {
        private None() {}
    }
}
```

用起來：

```java
@MiniTest("金額為負數時應該拒絕")
void 負數金額() { ... }

@MiniTest(value = "找不到 id 應該丟例外", expected = NoSuchElementException.class)
void 查無資料() { ... }

@MiniTest                                        // 全部用預設值時，括號可省略
void 基本流程() { ... }
```

### ★ `@Retention`：選錯的三種症狀

這是自訂註解**唯一會讓你卡住一整個下午**的地方。

| 值 | 保留到 | 誰在用 | 選錯的症狀 |
|---|---|---|---|
| `SOURCE` | 只在原始碼，編譯後消失 | `@Override`、`@SuppressWarnings`、Lombok | **執行期 `getAnnotation()` 永遠回 `null`** |
| `CLASS` | 寫進 `.class`，但不載入到記憶體 | 位元碼工具、`@Nullable` 系列 | 同上，**執行期一樣讀不到** |
| `RUNTIME` | **執行期讀得到** | JUnit、Spring、Jackson、JPA、**你** | — |

```java
// ❌ 沒寫 @Retention → 預設是 CLASS → 執行期讀不到
public @interface MyMarker {}

// 於是這一行永遠是 false，而且沒有任何錯誤訊息
boolean has = method.isAnnotationPresent(MyMarker.class);   // false
```

> 🔑 **`@Retention` 的預設值是 `CLASS`，不是 `RUNTIME`。**
> 這是自訂註解的頭號陷阱：**程式不會報錯，只是靜默地什麼都沒發生**——
> 這正是第 04 章 4.12 說的「靜默失敗比爆炸更貴」。
>
> **要被反射讀到的註解，`@Retention(RUNTIME)` 不能忘。**

### `@Target`：貼錯地方要在編譯期就擋下來

```java
@Target({ElementType.METHOD, ElementType.TYPE})   // 方法或類別
@Target(ElementType.FIELD)                        // 欄位
@Target(ElementType.PARAMETER)                    // 參數
@Target(ElementType.ANNOTATION_TYPE)              // 貼在別的註解上（做「元註解」）
@Target({})                                       // 不能貼在任何地方（只能當屬性的型別用）
```

沒寫 `@Target` = **哪裡都能貼**。這通常是壞事：
一個只在方法上有意義的註解被貼到欄位上時，你希望編譯器紅字，
而不是執行期靜默無效。

### 註解屬性的四條規則

```java
public @interface Config {
    String name();                          // 沒有 default = 使用時「必填」
    int retries() default 3;                // 有 default = 選填
    Class<?> handler() default Void.class;  // ✅ 允許：Class
    Level level() default Level.INFO;       // ✅ 允許：enum
    String[] tags() default {};             // ✅ 允許：陣列

    // Duration timeout();                  // ❌ 編譯錯誤：不允許任意物件
    // String name2() default null;         // ❌ 編譯錯誤：預設值不能是 null
}
```

1. 只允許：**基本型別、`String`、`Class`、`enum`、註解、以及以上型別的陣列**。
2. **預設值不能是 `null`**——所以要表達「沒設定」，慣例是用空字串、`-1`、
   或上面 `MiniTest.None` 那種**哨兵型別**。
3. 屬性名叫 `value()` 時可以省略名稱：`@MiniTest("說明")`。
4. 屬性是**方法語法**（有括號），不是欄位。

### 三個好用的元註解

| 元註解 | 作用 | 什麼時候需要 |
|---|---|---|
| `@Inherited` | 子類別會「繼承」父類別上的這個註解 | 只對**類別**有效，對方法無效 ⚠️ |
| `@Repeatable` | 同一個位置可以貼多次 | `@Schedule("週一") @Schedule("週三")` |
| `@Documented` | 出現在 Javadoc | 對外公開的 API 註解 |

> ⚠️ **`@Inherited` 只處理「類別繼承類別」**。
> 介面上的註解**不會**被實作類別繼承，方法上的註解**不會**被覆寫的方法繼承。
> Spring 之所以有一整套 `AnnotatedElementUtils`，就是在補這個洞
> （下一站 02-spring-boot 第 04 章 4.15 會看到「註解在介面上導致 AOP 失效」的實例）。

---

## 13.9 讀取註解

```java
package com.example.todo.reflect;

import java.lang.reflect.Method;
import com.example.todo.mini.MiniTest;

public class ReadAnnotations {

    public static void main(String[] args) throws Exception {
        Method m = SomeTest.class.getDeclaredMethod("負數金額");

        // ① 有沒有貼？
        if (m.isAnnotationPresent(MiniTest.class)) {

            // ② 拿出來讀屬性
            MiniTest a = m.getAnnotation(MiniTest.class);
            System.out.println(a.value());          // 金額為負數時應該拒絕
            System.out.println(a.expected());       // class ...MiniTest$None
        }

        // ③ 全部註解（含其他框架貼的）
        for (var annotation : m.getAnnotations()) {
            System.out.println(annotation.annotationType().getSimpleName());
        }
    }
}
```

四個入口，用法一模一樣：

| 貼在哪 | 從哪讀 |
|---|---|
| 類別 | `type.getAnnotation(X.class)` |
| 方法 | `method.getAnnotation(X.class)` |
| 欄位 | `field.getAnnotation(X.class)` |
| 參數 | `method.getParameters()[i].getAnnotation(X.class)` |

> 💡 **`getAnnotation()` 回傳的物件是什麼？**
> 是 JVM 幫你動態產生的**代理物件**（沒錯，就是 13.11 那個 `Proxy`）——
> 它實作了你的註解介面，每個屬性方法回傳當初寫在原始碼裡的常數。
>
> 所以 `a.getClass().getName()` 會印出 `com.sun.proxy.$Proxy1` 這種東西。
> **註解本身就是動態代理的第一個應用案例。**

---

## 13.10 動手：40 行寫一個能跑的測試框架

現在把 13.4（掃描）、13.5（呼叫）、13.8（註解）串起來，
回答 13.2 的魔法 1：**JUnit 是怎麼跑你的測試的。**

```java
package com.example.todo.mini;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * 一個能跑的迷你測試框架。
 * 它做的事和 JUnit 完全一樣，只是少了 99% 的功能。
 */
public final class MiniTestRunner {

    private MiniTestRunner() {}

    public record Result(String name, boolean passed, Throwable failure) {}

    public static List<Result> run(Class<?> testClass) throws Exception {
        List<Result> results = new ArrayList<>();

        // ① 找出所有貼了 @MiniTest 的方法（排序讓輸出穩定 —— 13.4 坑一）
        Method[] methods = Arrays.stream(testClass.getDeclaredMethods())
                .filter(m -> !m.isSynthetic())
                .filter(m -> m.isAnnotationPresent(MiniTest.class))
                .sorted(Comparator.comparing(Method::getName))
                .toArray(Method[]::new);

        for (Method m : methods) {
            MiniTest spec = m.getAnnotation(MiniTest.class);
            String name = spec.value().isBlank() ? m.getName() : spec.value();

            // ② 每個測試建立一個新實例 —— 這就是 JUnit 的預設「每方法一實例」
            Object instance = testClass.getDeclaredConstructor().newInstance();

            // ③ 測試方法通常不是 public（第 11 章的寫法），所以要開權限
            m.setAccessible(true);

            try {
                m.invoke(instance);
                // 預期會丟例外卻沒丟 → 失敗
                if (spec.expected() != MiniTest.None.class) {
                    results.add(new Result(name, false,
                            new AssertionError("預期 " + spec.expected().getSimpleName() + " 卻沒有丟出")));
                } else {
                    results.add(new Result(name, true, null));
                }
            } catch (InvocationTargetException e) {
                // ④ ★ 真正的例外在 getCause()（13.5）
                Throwable real = e.getCause();
                boolean expectedIt = spec.expected() != MiniTest.None.class
                        && spec.expected().isInstance(real);
                results.add(new Result(name, expectedIt, expectedIt ? null : real));
            }
        }
        return results;
    }

    public static void main(String[] args) throws Exception {
        List<Result> results = run(Class.forName(args[0]));
        long passed = results.stream().filter(Result::passed).count();

        for (Result r : results) {
            System.out.printf("%s  %s%n", r.passed() ? "✅" : "❌", r.name());
            if (!r.passed()) {
                System.out.println("      " + r.failure());
            }
        }
        System.out.printf("%n%d 個測試，%d 個通過，%d 個失敗%n",
                results.size(), passed, results.size() - passed);

        // ⑤ 有失敗就用非 0 結束碼 —— CI 靠這個判斷紅綠（第 10 章 10.16）
        if (passed != results.size()) System.exit(1);
    }
}
```

跑起來：

```
✅  基本流程
❌  金額為負數時應該拒絕
      java.lang.AssertionError: 預期被拒絕，實際上通過了
✅  找不到 id 應該丟例外

3 個測試，2 個通過，1 個失敗
```

### 你剛才寫的，和 JUnit 差在哪

| 你的版本 | JUnit 5 的真實做法 |
|---|---|
| 手動傳入 `Class` | 掃描 classpath / module path 找測試類別 |
| 只認 `@MiniTest` | `@Test`、`@ParameterizedTest`、`@TestFactory`… |
| 沒有生命週期 | `@BeforeEach` / `@AfterEach` / `@BeforeAll`（第 11 章 11.5） |
| 例外 = 失敗 | 同左，另外把 `TestAbortedException` 當「略過」 |
| 順序靠方法名 | `MethodOrderer`（預設刻意不保證，見第 11 章 11.18） |
| 每方法一實例 | **一樣**（`@TestInstance(PER_METHOD)` 是預設值） |

> 🔑 **這一節的重點不是「你會寫測試框架了」，而是「JUnit 沒有魔法」。**
> 你在第 11 章用的每一個註解，背後都是這 40 行的加強版：
> **掃描 → 讀註解 → 反射建物件 → 反射呼叫 → 攔例外**。
>
> 下一站的 Spring 也是同一套流程，只是「掃描」的範圍變成整個 classpath，
> 「建物件」變成解析依賴後遞迴地建，「呼叫」之前多包了一層代理——
> 也就是接下來要講的東西。

---

## 13.11 動態代理：`mock()` 到底回傳了什麼

回答 13.2 的魔法 4。

```java
TodoRepository repo = mock(TodoRepository.class);     // 介面不能 new，那這是什麼？
```

答案：**JVM 在執行期產生了一個實作該介面的類別，並建立它的實例。**
這個機制叫**動態代理**，是 Java 標準函式庫的功能，不需要任何第三方套件。

### 最小可跑的例子

```java
package com.example.todo.proxy;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

public class LoggingProxyDemo {

    /** 第 03 章的介面，這裡直接沿用。 */
    public interface TodoRepository {
        String findById(long id);
        void deleteById(long id);
    }

    /** 真正做事的實作。 */
    static class InMemoryTodoRepository implements TodoRepository {
        @Override public String findById(long id) {
            if (id < 0) throw new IllegalArgumentException("id 不能為負數：" + id);
            return "Todo#" + id;
        }
        @Override public void deleteById(long id) {
            System.out.println("    [真實] 刪除 " + id);
        }
    }

    /** ★ 攔截器：每一次方法呼叫都會先進到這裡。 */
    record LoggingHandler(Object target) implements InvocationHandler {

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            // Object 的方法不要記錄，否則 debugger 一碰就洗版（見下方陷阱二）
            if (method.getDeclaringClass() == Object.class) {
                return method.invoke(target, args);
            }

            long start = System.nanoTime();
            System.out.println("→ 進入 " + method.getName());
            try {
                Object result = method.invoke(target, args);          // 呼叫真正的實作
                System.out.printf("← 離開 %s，耗時 %.2f ms%n",
                        method.getName(), (System.nanoTime() - start) / 1_000_000.0);
                return result;
            } catch (InvocationTargetException e) {
                // ★ 一定要解包，否則呼叫端會收到 InvocationTargetException 而不是原本的例外
                System.out.println("✗ " + method.getName() + " 丟出 " + e.getCause());
                throw e.getCause();
            }
        }
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) {
        TodoRepository real = new InMemoryTodoRepository();

        TodoRepository proxy = (TodoRepository) Proxy.newProxyInstance(
                TodoRepository.class.getClassLoader(),      // ① 用哪個 ClassLoader 定義新類別
                new Class<?>[]{TodoRepository.class},       // ② 要實作哪些介面
                new LoggingHandler(real));                  // ③ 攔截器

        System.out.println(proxy.findById(1));
        proxy.deleteById(1);

        System.out.println("proxy 的類別：" + proxy.getClass().getName());
        System.out.println("是 TodoRepository 嗎？" + (proxy instanceof TodoRepository));
        System.out.println("是 InMemoryTodoRepository 嗎？"
                + (proxy instanceof InMemoryTodoRepository));      // ★ false
    }
}
```

輸出：

```
→ 進入 findById
← 離開 findById，耗時 0.04 ms
Todo#1
→ 進入 deleteById
    [真實] 刪除 1
← 離開 deleteById，耗時 0.11 ms
proxy 的類別：jdk.proxy1.$Proxy0
是 TodoRepository 嗎？true
是 InMemoryTodoRepository 嗎？false
```

### 五個必須知道的性質

**① 只能代理介面**

`Proxy.newProxyInstance` 產生的類別已經 `extends Proxy` 了，
而 Java 不能多重繼承——所以它只能靠 `implements` 介面。

```
沒有介面的類別要怎麼代理？→ 產生「子類別」並覆寫方法
                          → 這需要位元碼生成函式庫：CGLIB / ByteBuddy
                          → 下一站 02-spring-boot 第 04 章 4.5 會手寫一個
```

**② 代理物件不是原物件的子型別**

上面輸出最後一行是 `false`。這在實務上會咬人：

```java
// ❌ Spring 注入的是代理，直接轉型成實作類別會 ClassCastException
InMemoryTodoRepository impl = (InMemoryTodoRepository) proxy;
```

> 這就是第 03 章 3.13「對介面編程」在框架世界的**強制版**：
> 不是「建議你依賴介面」，而是**代理之後你只剩介面可以依賴**。

**③ `equals` / `hashCode` / `toString` 也會被攔截**

`Object` 的這三個方法會進到 `invoke()`。**沒處理的話後果很難查**：
把代理放進 `HashMap` 當 key 時 `hashCode` 走進了你的攔截器，
用 debugger 一步一步走時 `toString` 每次都觸發完整的攔截邏輯。

上面範例第一行的 `if (method.getDeclaringClass() == Object.class)` 就是在擋這個。
（`getClass()`、`wait()`、`notify()` 是 `final` 的，不會被攔截。）

**④ ★ 代理內部的 `this` 不是代理 ★**

這是本章對下一站最重要的一句話：

```java
static class Service implements Api {
    @Override public void outer() {
        System.out.println("outer");
        this.inner();          // ★ 這裡的 this 是「真實物件」，不是代理
    }                          //    → 攔截器完全不會被觸發
    @Override public void inner() {
        System.out.println("inner");
    }
}
```

呼叫 `proxy.outer()` 的流程：

```
呼叫端 → 代理 → 攔截器 ✅ → 真實物件的 outer()
                              └→ this.inner()  ← this 是真實物件，直接呼叫
                                                  代理與攔截器完全被繞過 ❌
```

> 🔑 **記住這張圖。** 下一站 02-spring-boot 第 04 章 4.14 那個標著 ★ 的「自呼叫失效」整節、
> 以及「`@Transactional` / `@Async` / `@Cacheable` / `@PreAuthorize` 為什麼沒生效」
> 這一整類問題，**根因就是這四行**。
>
> 你現在是從機制推出結論，而不是背一條規則——這是這一章存在的理由。

**⑤ 回傳型別要對，`void` 回 `null`**

攔截器的 `invoke` 回傳 `Object`。如果被代理的方法宣告回傳 `int`，
你回 `null` 會得到 `NullPointerException`（拆箱失敗，第 01 章 1.7）。
`void` 方法則要回 `null`。

---

## 13.12 動手：把註解和代理串起來

第 13.8 做了註解、第 13.11 做了代理。合起來就是 AOP。

```java
package com.example.todo.proxy;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)              // ★ 不能忘（13.8）
public @interface Timed {
    /** 超過這個毫秒數就警告。 */
    long thresholdMs() default 100;
}
```

```java
package com.example.todo.proxy;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;

/**
 * 只對貼了 @Timed 的方法計時。
 */
public final class TimedProxy {

    private TimedProxy() {}

    @SuppressWarnings("unchecked")
    public static <T> T wrap(T target, Class<T> iface) {
        return (T) Proxy.newProxyInstance(
                iface.getClassLoader(),
                new Class<?>[]{iface},
                new Handler(target));
    }

    private record Handler(Object target) implements InvocationHandler {

        /** ★ 快取：不要每次呼叫都做一次反射查找（13.13） */
        private static final Map<Method, Method> TARGET_METHODS = new HashMap<>();

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            if (method.getDeclaringClass() == Object.class) {
                return method.invoke(target, args);
            }

            // ⚠️ 註解貼在「實作類別的方法」上，介面的 Method 讀不到 —— 13.8 的 @Inherited 陷阱
            Method impl = TARGET_METHODS.computeIfAbsent(method, m -> {
                try {
                    return target.getClass().getDeclaredMethod(m.getName(), m.getParameterTypes());
                } catch (NoSuchMethodException e) {
                    return m;
                }
            });

            Timed timed = impl.getAnnotation(Timed.class);
            if (timed == null) {
                return call(impl, args);                       // 沒貼註解就直接放行
            }

            long start = System.nanoTime();
            try {
                return call(impl, args);
            } finally {
                long ms = (System.nanoTime() - start) / 1_000_000;
                if (ms > timed.thresholdMs()) {
                    System.out.printf("⚠️  %s 花了 %d ms（門檻 %d ms）%n",
                            method.getName(), ms, timed.thresholdMs());
                } else {
                    System.out.printf("    %s 花了 %d ms%n", method.getName(), ms);
                }
            }
        }

        private Object call(Method m, Object[] args) throws Throwable {
            try {
                return m.invoke(target, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();                             // 13.5
            }
        }
    }
}
```

用起來：

```java
public interface ReportService {
    String monthly(int year, int month);
}

public class SlowReportService implements ReportService {
    @Override
    @Timed(thresholdMs = 50)                     // ← 貼在「實作」上
    public String monthly(int year, int month) {
        try { Thread.sleep(120); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        return year + "-" + month + " 報表";
    }
}

// 組裝（第 03 章的手動 DI）
ReportService service = TimedProxy.wrap(new SlowReportService(), ReportService.class);
service.monthly(2026, 8);
// ⚠️  monthly 花了 121 ms（門檻 50 ms）
```

### 你剛剛寫的東西，Spring 叫它 AOP

| 你寫的 | Spring 的名字 | 下一站章節 |
|---|---|---|
| `@Timed` 註解 | 自訂註解 + `@annotation` 切點 | 02-spring-boot 4.12 |
| `InvocationHandler.invoke` | `@Around` Advice | 02-spring-boot 4.10 |
| `if (impl.getAnnotation(...) == null) 放行` | 切點運算式（pointcut） | 02-spring-boot 4.9 |
| `TimedProxy.wrap(...)` | 容器在建立 Bean 時自動包 | 02-spring-boot 4.7 |
| `method.getDeclaringClass() == Object.class` | Spring 內部一樣要處理 | — |
| **`this.inner()` 繞過代理** | **自呼叫失效** | **02-spring-boot 4.14 ★** |

> 🔑 **Spring AOP 的全部內容，就是把上面這 60 行自動化：**
> 幫你掃描哪些 Bean 需要代理、幫你選 JDK Proxy 還是 CGLIB、
> 幫你把多個攔截器串成一條鏈、幫你在容器裡把原始物件換成代理。
>
> **機制完全一樣。** 下一站你不是在學新東西，是在學它的自動化。

---

## 13.13 反射的四種代價

反射很強大，而每一項能力都有對應的帳單。

### 代價一：型別安全消失

```java
// 編譯期：完全正常，IDE 不會有任何提示
Method m = service.getClass().getMethod("proccessOrder", Long.class);   // 打錯字
m.invoke(service, "not-a-long");                                        // 型別錯誤

// 執行期：NoSuchMethodException / IllegalArgumentException
```

**這是最貴的代價，而且它不會出現在效能報告上。**
編譯器、IDE 的重構功能、`Find Usages`——全部失效。
你把方法改名，字串裡的名字不會跟著改，而且沒有任何工具會警告你。

> 🔑 **判準：如果編譯期就知道要呼叫誰，就不要用反射。**
> 反射只該用在「**編譯期真的不知道**」的地方：框架、外掛系統、序列化、設定驅動的分派。

### 代價二：效能

粗略的量級（**這是數量級，不是精確值——請用下面的方法在你的環境自己量**）：

| 做法 | 相對成本 |
|---|---|
| 直接呼叫 `obj.method()` | 1×（JIT 內聯後幾乎為 0） |
| **快取好的** `Method.invoke()` | 約 2～5× |
| 每次都 `getDeclaredMethod()` 再 invoke | 約 20～100× |
| `Class.forName()` + `newInstance()` | 更貴（含類別查找） |

兩個實務結論：

```java
// ❌ 在熱路徑上每次都查找
for (Order o : orders) {
    Method m = o.getClass().getMethod("getAmount");    // 每次都掃 + 複製陣列（13.4 坑三）
    total += (Long) m.invoke(o);
}

// ✅ 查一次，快取起來
private static final Method GET_AMOUNT = init();
for (Order o : orders) {
    total += (Long) GET_AMOUNT.invoke(o);
}
```

**所有框架都這樣做。** Jackson 第一次序列化某個類別時會建立並快取一份
「欄位 → 存取器」的計畫，之後都走快取——這就是為什麼
「第一次 API 呼叫特別慢」（下一站 02-spring-boot 第 09 章 9.15 的啟動變慢排查會再遇到）。

怎麼量（第 11 章 11.16 的工具在這裡也適用）：

```xml
<!-- 用 JMH 量，不要用 System.nanoTime() 手動計時：JIT 會把你的迴圈最佳化掉 -->
<dependency>
  <groupId>org.openjdk.jmh</groupId>
  <artifactId>jmh-core</artifactId>
  <version>1.37</version>
  <scope>test</scope>
</dependency>
```

### 代價三：例外堆疊變成一堵牆

```
java.lang.reflect.InvocationTargetException
    at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(...)
    at java.base/java.lang.reflect.Method.invoke(Method.java:580)
    at org.junit.platform.commons.util.ReflectionUtils.invokeMethod(...)
    ... 38 more                                     ← 38 層框架
Caused by: java.lang.IllegalStateException: 庫存不足    ← ★ 你要的東西在這裡
    at com.example.OrderService.place(OrderService.java:42)
```

> 🔑 **看到框架的堆疊，先往下找 `Caused by:`**（第 04 章 4.7）。
> 這是本課從第 04 章講到現在、實務上省時間最多的一條習慣。

### 代價四：`--add-opens` 與強封裝的維護成本

13.6 講過了：一旦某個依賴需要 `--add-opens`，這個旗標要跟著你的程式
出現在**每一個執行環境**。它會在你最沒預期的地方壞掉（新的 CI runner、
新的 base image、有人改了 Dockerfile 的 `ENTRYPOINT`）。

### 有沒有不用反射的做法？

有，而且愈來愈主流：**把工作移到編譯期**。

| 做法 | 代表 | 原理 |
|---|---|---|
| **註解處理器（APT）** | Lombok、MapStruct、Dagger | 編譯期讀註解，**產生原始碼**。執行期零反射 |
| **`MethodHandle` / `VarHandle`** | JDK 內部、高效能函式庫 | 比反射快，可被 JIT 內聯，但 API 難用很多 |
| **建置期織入** | AspectJ compile-time weaving | 直接改位元碼，沒有代理，也沒有自呼叫問題 |

> 💡 下一站你會在 `MapStruct`（05-service 第 03 章）看到 APT 的實例：
> 它產生的是一個你**打得開、讀得懂、debug 得進去**的 `XxxMapperImpl.java`。
> 這是「零反射」路線最大的好處——**東西是看得見的**。
>
> 這也是 GraalVM 原生映像（02-spring-boot 第 08 章 8.5）能成立的前提，見下一節。

---

## 13.14 反射會壞掉的六個地方

反射在**你的 IDE 裡**永遠是好的。它壞掉的地方都在「打包之後」。

| # | 情境 | 症狀 | 修法 |
|---|---|---|---|
| 1 | **`-parameters` 沒開** | `parameter.getName()` 回 `arg0`、`arg1`；Jackson / Spring 綁不到參數名 | 第 10 章 10.10 的 `<arg>-parameters</arg>`（Spring Boot 的 parent pom 預設已開） |
| 2 | **uber-jar 的 relocation** | `ClassNotFoundException`，但那個類別明明在 jar 裡 | shade 改寫不了**字串裡的**類別名（第 10 章 10.13）。改用分層 jar，或設定 relocation 排除 |
| 3 | **混淆 / minify** | 同上，且方法名變成 `a`、`b` | 為反射用到的類別加 keep 規則（第 10 章 10.13 的代價那段） |
| 4 | **GraalVM 原生映像** | 建置成功，執行期 `ClassNotFoundException` / `NoSuchMethodException` | 原生映像做**封閉世界假設**：沒被靜態分析看到的反射一律砍掉。要寫 `reflect-config.json`，或用框架的 AOT 處理（02-spring-boot 第 08 章 8.5） |
| 5 | **JPMS 強封裝** | `InaccessibleObjectException` | `opens` 你的套件給該框架，或 `--add-opens`（13.6） |
| 6 | **ClassLoader 隔離** | `ClassCastException: X cannot be cast to X`（同名！） | 兩個 ClassLoader 各載入一份（第 09 章 9.6）。應用伺服器、外掛系統、熱重載常見 |

> 🔑 **第 6 項的訊息長得像在開玩笑，但它是真的。**
> `X cannot be cast to X` 永遠只有一個原因：**兩個不同的 ClassLoader**。
> 看到它就去查 `x.getClass().getClassLoader()`，不要懷疑自己的眼睛。

### 一條實務原則

```
你的專案用了反射   → 一定要有「打包後」的測試（第 11 章 11.17 的整合測試）
                     光跑單元測試看不到 1、2、3、4 這四種問題
```

第 10 章 10.18 的練習裡，「打成 jar 之後跑一次冒煙測試」那一步，
擋掉的就是這一類問題。

---

## 13.15 對照表：你剛才寫的東西在框架裡叫什麼

這張表是這一章的**總結**，也是下一站的地圖。

| 你在本章寫的 | Spring | Jackson | JPA / Hibernate | JUnit 5 |
|---|---|---|---|---|
| 掃描 classpath 找註解 | 元件掃描 `@ComponentScan`（02-spring-boot 1.6） | — | Entity 掃描 | 測試探索 |
| `@MiniTest` 自訂註解 | `@Component` / `@Transactional` | `@JsonProperty` | `@Entity` / `@Column` | `@Test` |
| `getDeclaredConstructor().newInstance()` | Bean 實例化（02-spring-boot 1.11） | 反序列化建物件 | Entity 具現化 | 每方法一實例 |
| `field.setAccessible(true)` + `set` | 欄位注入 `@Autowired`（02-spring-boot 1.7） | 填欄位 | 填 Entity 欄位 | 注入 `@TempDir` |
| `Method.invoke` | 呼叫 `@PostConstruct`、事件監聽器 | getter 存取 | — | 執行測試方法 |
| `field.getGenericType()` | `ResolvableType`、泛型注入 | `TypeReference` | 關聯的目標型別 | 參數化測試的型別轉換 |
| `Proxy.newProxyInstance` | **AOP 代理**（02-spring-boot 4.4） | — | 延遲載入代理（08-jpa-mybatis） | Mockito 的 `mock()` |
| `InvocationHandler` | `@Around` Advice（02 章 4.10） | — | — | Mockito 的 stub 邏輯 |
| **`this.inner()` 繞過代理** | **自呼叫失效**（02 章 4.14 ★） | — | 延遲載入失效 | — |
| 快取 `Method` 物件 | `ReflectionUtils` 的快取 | 序列化計畫快取 | Metamodel | — |

> 🔑 **整張表只有一句話：框架 = 反射 + 註解 + 代理 + 大量的邊界處理。**
>
> 你現在已經有能力**讀懂**框架，而不只是使用它。
> 下一站遇到「為什麼沒生效」的時候，你可以問出對的問題：
> 「這個註解是 RUNTIME 嗎？」「這個物件是代理嗎？」「這是不是自呼叫？」

---

## 13.16 常見錯誤

| # | 錯誤 | 症狀 | 修法 |
|---|---|---|---|
| 1 | 自訂註解忘了 `@Retention(RUNTIME)` | **靜默失效**，`isAnnotationPresent` 永遠 `false` | 加上 `@Retention(RetentionPolicy.RUNTIME)` |
| 2 | `catch (InvocationTargetException e)` 後直接記 `e` | log 裡只有 `InvocationTargetException`，沒有真正原因 | 記 / 丟 `e.getCause()` |
| 3 | 用 `getMethods()` 找私有方法 | `NoSuchMethodException` | 改用 `getDeclaredMethod()` |
| 4 | 用 `getDeclaredMethod()` 找父類別的方法 | `NoSuchMethodException` | 自己往 `getSuperclass()` 爬，或用 `getMethod()`（限 public） |
| 5 | 參數型別寫成包裝型別 | `NoSuchMethodException: substring(java.lang.Integer, ...)` | 用 `int.class` 而不是 `Integer.class` |
| 6 | 依賴 `getDeclaredMethods()` 的順序 | 測試在別台機器上失敗 | 明確排序 |
| 7 | 在熱路徑上重複 `getDeclaredMethod()` | CPU 都花在反射查找上 | 快取 `Method` 物件 |
| 8 | 忘了處理 `Object` 的方法 | 代理放進 `HashMap` 時行為詭異；debugger 一碰就觸發攔截 | `if (method.getDeclaringClass() == Object.class)` |
| 9 | 攔截器不解 `InvocationTargetException` | 呼叫端收到 `UndeclaredThrowableException` | `throw e.getCause()` |
| 10 | 把代理轉型成實作類別 | `ClassCastException: $Proxy0 cannot be cast to XxxImpl` | 依賴介面（第 03 章 3.13） |
| 11 | 以為 `this.method()` 會經過代理 | 攔截邏輯（記錄 / 交易 / 快取）靜默失效 | 13.11 ④；解法在 02 章 4.14 |
| 12 | 對 `record` 欄位 `set()` | `IllegalAccessException` | record 是 trusted final，設計上就不該改 |
| 13 | 對 JDK 內部類別 `setAccessible` | `InaccessibleObjectException` | 升級那個函式庫；`--add-opens` 只是止血 |
| 14 | 反射在原生映像 / uber-jar 裡失效 | 只有打包後才發生 | 13.14 的六格表 |
| 15 | 為了「彈性」在商業邏輯裡用反射 | 重構工具失效，改名就在執行期爆 | 編譯期知道就別用反射 |

---

## 13.17 本章練習

### 練習 1：讀出結構（暖身）

寫一個 `describe(Class<?>)`，對任意類別印出：
類別名、是不是 `record` / `sealed`、所有**非 static、非 synthetic** 的欄位
（含父類別繼承來的私有欄位），以及每個欄位的泛型型別。

<details>
<summary>參考解答</summary>

```java
package com.example.todo.reflect;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;

public final class Describe {

    private Describe() {}

    public static void describe(Class<?> type) {
        System.out.printf("%s（record=%b, sealed=%b）%n",
                type.getName(), type.isRecord(), type.isSealed());

        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            for (Field f : c.getDeclaredFields()) {
                if (f.isSynthetic() || Modifier.isStatic(f.getModifiers())) continue;
                System.out.printf("  [%s] %s %s%n",
                        c.getSimpleName(),
                        f.getGenericType().getTypeName(),    // ★ 用 generic 版本才看得到 <String>
                        f.getName());
            }
        }
    }
}
```

**要點**：`getGenericType().getTypeName()` 而不是 `getType().getSimpleName()`——
前者印 `java.util.List<java.lang.String>`，後者只印 `List`（13.7）。

</details>

---

### 練習 2：迷你 DI 容器 ★

做一個 30 行的 DI 容器，支援：

- `@Inject` 貼在**建構子**上，容器遞迴地建立它的參數。
- `register(介面.class, 實作.class)` 註冊繫結。
- `get(介面.class)` 拿到實例，且**同一個型別只建立一次**（單例）。

<details>
<summary>參考解答</summary>

```java
package com.example.todo.di;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.CONSTRUCTOR)
@Retention(RetentionPolicy.RUNTIME)
public @interface Inject {}
```

```java
package com.example.todo.di;

import java.lang.reflect.Constructor;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;

public class MiniContainer {

    private final Map<Class<?>, Class<?>> bindings = new HashMap<>();
    private final Map<Class<?>, Object> singletons = new HashMap<>();
    private final Deque<Class<?>> creating = new ArrayDeque<>();     // 循環依賴偵測

    public <T> void register(Class<T> iface, Class<? extends T> impl) {
        bindings.put(iface, impl);
    }

    @SuppressWarnings("unchecked")
    public <T> T get(Class<T> type) {
        Object existing = singletons.get(type);
        if (existing != null) return (T) existing;

        if (creating.contains(type)) {
            throw new IllegalStateException("循環依賴：" + creating + " → " + type.getSimpleName());
        }
        creating.push(type);
        try {
            Class<?> impl = bindings.getOrDefault(type, type);
            Constructor<?> ctor = pickConstructor(impl);

            // ★ 遞迴：先把每個參數建出來
            Object[] args = new Object[ctor.getParameterCount()];
            Class<?>[] paramTypes = ctor.getParameterTypes();
            for (int i = 0; i < args.length; i++) {
                args[i] = get(paramTypes[i]);
            }

            ctor.setAccessible(true);
            Object instance = ctor.newInstance(args);
            singletons.put(type, instance);
            return (T) instance;
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("無法建立 " + type.getName(), e);   // 第 04 章 4.7 例外鏈
        } finally {
            creating.pop();
        }
    }

    private Constructor<?> pickConstructor(Class<?> impl) {
        Constructor<?>[] all = impl.getDeclaredConstructors();
        for (Constructor<?> c : all) {
            if (c.isAnnotationPresent(Inject.class)) return c;
        }
        if (all.length == 1) return all[0];        // ★ 只有一個建構子就不用貼註解
        throw new IllegalStateException(impl.getName() + " 有多個建構子，請用 @Inject 指定一個");
    }
}
```

**這 60 行涵蓋了 Spring 容器的核心語意**，包括：

| 你實作的 | Spring 對應（02 章） |
|---|---|
| `register(iface, impl)` | `@Bean` / `@Component` 註冊（1.5） |
| 遞迴建立建構子參數 | 建構子注入（1.7） |
| `singletons` map | 單例作用域（1.10） |
| **只有一個建構子時不用貼註解** | Spring 4.3 起的相同規則（1.7） |
| `creating` 堆疊偵測循環 | `BeanCurrentlyInCreationException`（1.13） |

</details>

---

### 練習 3：除錯題

同事寫了一個外掛載入器，測試都過，上線後某個外掛拋出的例外
在 log 裡永遠顯示 `null`，完全查不到原因。

```java
public Object runPlugin(String className, String methodName) throws Exception {
    Class<?> c = Class.forName(className);
    Object instance = c.newInstance();
    Method m = c.getMethod(methodName);
    try {
        return m.invoke(instance);
    } catch (Exception e) {
        log.error("外掛執行失敗: {}", e.getMessage());
        return null;
    }
}
```

找出**四個**問題並修好。

<details>
<summary>參考解答</summary>

| # | 問題 | 後果 |
|---|---|---|
| 1 | `e.getMessage()` 對 `InvocationTargetException` 永遠是 `null` | **就是這一題的症狀**（13.5） |
| 2 | `c.newInstance()` 已棄用，且會偷渡 checked 例外 | 繞過編譯器檢查（13.5） |
| 3 | `catch (Exception e)` 然後 `return null` | 吞掉例外（第 04 章 4.12 反模式一），呼叫端拿到 `null` 完全不知道發生什麼 |
| 4 | `getMethod` 只找得到 public 方法 | 外掛的方法不是 public 就 `NoSuchMethodException` |

```java
public Object runPlugin(String className, String methodName) {
    try {
        Class<?> c = Class.forName(className);
        Object instance = c.getDeclaredConstructor().newInstance();     // 修 2
        Method m = c.getDeclaredMethod(methodName);                     // 修 4
        m.setAccessible(true);
        return m.invoke(instance);
    } catch (InvocationTargetException e) {
        Throwable cause = e.getCause();                                 // 修 1
        log.error("外掛 {}#{} 執行失敗", className, methodName, cause);   // 把 Throwable 當最後一個參數
        throw new PluginExecutionException(className, cause);           // 修 3：包起來往上丟
    } catch (ReflectiveOperationException e) {
        throw new PluginLoadException(className, e);                    // 載入失敗和執行失敗要分開
    }
}
```

> 🔑 **「載入失敗」和「執行失敗」是兩種不同的錯誤，要分成兩個例外型別**——
> 第 04 章 4.9 的自訂例外設計原則在這裡完全適用：
> 前者是設定 / 部署問題，後者是外掛本身的 bug，**處理方式與負責人都不同**。

</details>

---

### 練習 4：用代理實作重試

寫一個 `RetryProxy.wrap(target, iface)`，讓貼了
`@Retry(times = 3, on = IOException.class)` 的方法在丟出指定例外時自動重試。

<details>
<summary>參考解答</summary>

```java
package com.example.todo.proxy;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Retry {
    int times() default 3;
    Class<? extends Throwable> on() default Exception.class;
    long delayMs() default 100;
}
```

```java
package com.example.todo.proxy;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

public final class RetryProxy {

    private RetryProxy() {}

    @SuppressWarnings("unchecked")
    public static <T> T wrap(T target, Class<T> iface) {
        return (T) Proxy.newProxyInstance(iface.getClassLoader(), new Class<?>[]{iface},
                (proxy, method, args) -> {
                    if (method.getDeclaringClass() == Object.class) {
                        return method.invoke(target, args);
                    }
                    Method impl = target.getClass()
                            .getDeclaredMethod(method.getName(), method.getParameterTypes());
                    Retry retry = impl.getAnnotation(Retry.class);

                    int attempts = retry == null ? 1 : retry.times();
                    Throwable last = null;

                    for (int i = 1; i <= attempts; i++) {
                        try {
                            return method.invoke(target, args);
                        } catch (InvocationTargetException e) {
                            Throwable cause = e.getCause();
                            // 不是指定的例外就不重試，直接往上丟
                            if (retry == null || !retry.on().isInstance(cause)) throw cause;
                            last = cause;
                            if (i < attempts) {
                                // ★ 第 08 章 8.3：sleep 被中斷時一定要還原中斷旗標
                                try {
                                    Thread.sleep(retry.delayMs());
                                } catch (InterruptedException ie) {
                                    Thread.currentThread().interrupt();
                                    throw cause;
                                }
                            }
                        }
                    }
                    throw last;
                });
    }
}
```

**兩個容易漏的細節**：

1. **不是目標例外就不要重試**——否則 `IllegalArgumentException`（永遠不會成功的錯）
   也會被重試三次，只是把失敗延後 300ms。
2. **重試只對冪等操作安全**。非冪等的 `POST` 被自動重試 = 重複扣款——
   這正是 03-rest-api 第 02 章 2.2 的冪等性，以及該站第 08 章冪等鍵存在的理由。

</details>

---

### 練習 5：判斷題

下面五個情境，哪些**應該**用反射？

| # | 情境 |
|---|---|
| 1 | 寫一個 CSV 匯出功能，要把任意 DTO 的所有欄位輸出成一列 |
| 2 | 在 `OrderService` 裡依訂單狀態呼叫不同的處理方法 |
| 3 | 測試裡要驗證一個沒有 getter 的私有欄位被正確設定了 |
| 4 | 做一個外掛系統，外掛類別名寫在設定檔裡 |
| 5 | 為了「以後好擴充」，把所有 Service 的方法呼叫都改成反射分派 |

<details>
<summary>參考解答</summary>

| # | 該用嗎 | 理由 |
|---|---|---|
| 1 | ✅ **該用** | 「任意 DTO」= 編譯期不知道有哪些欄位。這正是反射的定位 |
| 2 | ❌ 不該 | 編譯期就知道有哪幾種狀態。用第 12 章的 **`sealed` + switch 模式比對**，還能拿到窮盡性檢查 |
| 3 | ⚠️ 可以，但先停下來想 | 通常代表**設計問題**（第 11 章 11.13）。優先考慮：測公開行為、或讓該欄位有 package-private 的存取點 |
| 4 | ✅ **該用** | 類別名在設定檔裡 = 編譯期不可能知道。標準用法 |
| 5 | ❌ **絕對不該** | 「以後好擴充」換來的是：重構工具全失效、型別安全歸零、每次呼叫慢 5 倍、堆疊多 30 層。**這是本章 13.13 代價一的教科書案例** |

> 🔑 **一句話判準**：`編譯期知道 → 不要用反射`。
> 反射不是「更彈性的呼叫方式」，它是**放棄編譯器**的交換。

</details>

---

## 13.18 驗收清單

- [ ] 我知道 `Class` 物件從哪來，也知道它的身分是「全限定名 + ClassLoader」。
- [ ] 我知道 `Class.forName()` 預設會觸發靜態初始化，也知道怎麼關掉。
- [ ] 我知道內部類別要用 `$` 才載入得到。
- [ ] **我能說出 `getFields()` 和 `getDeclaredFields()` 的四個差異。**
- [ ] 我知道要拿父類別的私有欄位得自己往上爬。
- [ ] 我知道反射回傳的成員**順序未定義**，需要固定順序就自己排。
- [ ] 我知道掃描時要跳過 `isSynthetic()` 的成員。
- [ ] 我知道 `getDeclaredMethods()` 每次都複製陣列，所以框架都要快取。
- [ ] 我知道為什麼框架要求無參數建構子，也知道 Jackson 怎麼處理 `record`。
- [ ] 我知道 `type.newInstance()` 已棄用，以及它為什麼危險。
- [ ] **我知道 `InvocationTargetException` 的訊息永遠是 `null`，真正的例外在 `getCause()`。**
- [ ] 我知道 `setAccessible(true)` 對自己的類別可行，對 JDK 內部類別會丟 `InaccessibleObjectException`。
- [ ] 我知道 `--add-opens` 要同步出現在 IDE、Surefire、Dockerfile、K8s，漏一個就會「本機好好的」。
- [ ] 我知道 `record` 的欄位連反射都改不了。
- [ ] **我知道泛型資訊寫在「宣告」上而不是「物件」上，也知道這就是 `TypeReference` 的原理。**
- [ ] 我能自訂一個註解，並說出三個要素各自的作用。
- [ ] **我知道 `@Retention` 的預設值是 `CLASS`，忘了寫 `RUNTIME` 會靜默失效。**
- [ ] 我知道註解屬性的預設值不能是 `null`，以及慣用的哨兵寫法。
- [ ] 我知道 `@Inherited` 只處理「類別繼承類別」，介面與方法都不算。
- [ ] **我能用反射 + 註解寫出一個會跑的迷你測試框架，並說出它和 JUnit 的差別。**
- [ ] 我知道 `Proxy.newProxyInstance` 只能代理介面，沒有介面要靠 CGLIB / ByteBuddy。
- [ ] 我知道代理物件**不是**實作類別的子型別，硬轉型會 `ClassCastException`。
- [ ] 我知道 `equals` / `hashCode` / `toString` 也會進到攔截器，必須特別處理。
- [ ] **我能畫出「代理 → 真實物件 → `this.inner()`」的流程圖，並說明攔截器為什麼被繞過。**
- [ ] 我知道攔截器一定要把 `InvocationTargetException` 解包再往上丟。
- [ ] 我能說出反射的四種代價，並知道「型別安全消失」才是最貴的那個。
- [ ] 我知道熱路徑上要快取 `Method` 物件。
- [ ] 我知道 APT（Lombok / MapStruct）、`MethodHandle`、建置期織入這三種「不用反射」的路線。
- [ ] **我能說出反射在打包後會壞掉的六種情境，以及各自的修法。**
- [ ] 我知道用了反射就一定要有「打包之後」的測試。
- [ ] 我能把本章的每個機制對應回 Spring / Jackson / JPA / JUnit 的名字。
- [ ] 我的判準是「**編譯期知道就不要用反射**」。

---

## 13.19 第 01 站結業

你完成了整個「Java 語言核心與 JVM」站。回頭看看走過的路。

### 專案的旅程

```
第 02 章  三個平行的 List             →  Todo / TodoList / Priority
第 03 章  寫死的實作                  →  TodoRepository / Notifier 介面 + 手動 DI
第 04 章  到處 printStackTrace        →  ErrorCode + 例外體系 + 最外層統一處理
第 05 章  每次查詢都掃全部             →  標籤反向索引 + EnumMap
第 06 章  巢狀 for 迴圈的統計          →  groupingBy / teeing / filtering
第 07 章  關掉程式資料就不見           →  JSON 檔案持久化（原子寫入 + 備份）
第 08 章  一個一個來源慢慢匯入         →  虛擬執行緒併發匯入 + Semaphore
第 09 章  跑三天就 OOM                →  親手做出洩漏，再用 heap dump 抓出來
第 10 章  「在我電腦上可以跑」          →  四個 Maven 模組 + 可執行 jar + Docker
第 11 章  改完只能「跑一下看看」        →  85 個測試 + 契約測試 + 突變測試
第 12 章  150 行樣板 + 到處 null 檢查  →  record + sealed + 模式比對
第 13 章  框架是黑箱                  →  手寫測試框架、DI 容器、AOP 代理
```

**每一章解決的都是上一章留下的真實問題。** 這不是巧合——
這就是軟體演進的樣子。

### 你現在會什麼

| 能力 | 出自 |
|---|---|
| 選對 JDK 版本，理解 LTS 與授權 | 第 00 章 |
| 知道 `4.35 * 100` 為什麼是 `434.99999999999994` | 第 01 章 |
| 設計封裝良好、不可變的類別 | 第 02 章 |
| 用組合而非繼承，對介面編程 | 第 03 章 |
| 設計例外體系，知道什麼該 catch | 第 04 章 |
| `HashMap` 內部怎麼運作、`equals`/`hashCode` 契約 | 第 05 章 |
| 寫出宣告式而非迴圈式的資料處理 | 第 06 章 |
| 正確處理編碼、時區、原子寫入、JSON | 第 07 章 |
| 併發、鎖、執行緒池、虛擬執行緒、死鎖診斷 | 第 08 章 |
| **從症狀定位到 JVM 根因** | 第 09 章 |
| 依賴管理、打包出貨、供應鏈安全 | 第 10 章 |
| **寫出敢重構的安全網** | 第 11 章 |
| 用型別讓無效狀態變成不可能 | 第 12 章 |
| **讀懂框架，而不只是使用框架** | 第 13 章 |

### 貫穿全站的四個觀念

回頭看，這十四章其實一直在講同樣的四件事：

**① 先看見災難，再學解法**

`4.35 * 100`、`==` 比字串、忘記 `hashCode`、Stream 裡的 N+1、
Full GC 谷底升高、log 打包後消失、100% 覆蓋率下的差一錯誤、
`@Retention` 忘了寫 `RUNTIME`——
**每一個「規則」背後都有一個真實的事故。** 記住事故，規則自然就記住了。

**② 讓錯誤在最早的階段被發現**

```
執行期發現（客訴）  ←  最糟   ← 第 13 章的反射把你推回這裡，所以要謹慎使用
    ↑
測試期發現          ←  第 11 章
    ↑
建置期發現          ←  第 10 章（enforcer、dependencyConvergence）
    ↑
編譯期發現          ←  第 12 章（sealed、窮盡性）  ←  最好
```

整站有一條清晰的主線：**把「靠人記得」的事，一層一層往前推**。
第 10 章的 enforcer、第 11 章的 ArchUnit、第 12 章的窮盡性檢查——
**三個不同的工具，同一個哲學。**

而第 13 章是這條主線唯一的「逆行」：**反射把檢查推回執行期**。
這正是它只該用在「編譯期真的不知道」的地方的原因。

**③ 明確的依賴**

第 03 章的「對介面編程」、第 07 章的「注入 `Clock`」、
第 11 章的「難以測試是設計問題的症狀」、第 12 章的「用型別表達狀態」、
第 13 章的「DI 容器就是遞迴地建構子注入」——它們都在說同一件事：

> **把隱含的東西變明確。** 隱含的全域狀態 → 明確的建構子參數。
> 隱含的「可能是 null」→ 明確的 `Optional` 或 sealed 型別。
> 隱含的「只有這幾種」→ 明確的 `sealed permits`。

**④ 工具會騙你，行為不會**

覆蓋率 100% 的假測試、`-Xmx` 不等於 RSS、`dependency:tree` 的 verbose 輸出、
`equals` 只比 id 讓斷言永遠通過、在 IDE 裡好好的反射一打包就壞——

**每一個指標都可以被操弄。唯一誠實的是「改壞一行，會不會被抓到」。**

### 誠實的提醒

這一站的所有程式碼與設定都經過逐行檢閱，但**沒有在本機編譯執行驗證**
（撰寫環境沒有安裝 JDK 與 Maven）。

**強烈建議你自己跑一遍。** 具體來說：

1. 依第 00 章裝好 JDK 21（或 25）與 Maven。
2. 依第 10 章 10.18 節建出四模組專案。
3. 依第 11 章 11.19 節補上測試，跑 `make verify`。
4. **依第 09 章 9.11 節重現一次記憶體洩漏，走完 `jstat → histogram → dump → MAT` 的流程。**
5. 依第 12 章 12.16 節做一次 record 重構，看第 11 章的測試怎麼紅、怎麼引導你。
6. **依第 13 章 13.10 與 13.12 節，把迷你測試框架和 `@Timed` 代理跑起來。**

第 4、5、6 步特別值得——**它們是「讀過」和「做過」差距最大的三章**。
尤其第 6 步：**你會在下一站的第一天就用上它。**

### 下一站

```
你現在在這裡
    ↓
01-java-core ✅  ── 語言核心與 JVM
    ↓
02-spring-boot   ── IoC 容器、自動配置、設定管理
                    ⚠️ 你會發現 Spring 的每一個「魔法」，
                       都是這一站某個概念的自動化版本：
                       - DI 容器  = 第 03 章的手動組裝、第 13 章 13.17 的迷你容器
                       - @Transactional = 第 13 章 13.11 的動態代理
                       - 自呼叫失效 = 第 13 章 13.11 ④，一模一樣的原因
                       - @RestControllerAdvice = 第 04 章 4.10 節的最外層處理器
                       - 元件掃描 = 第 13 章 13.10 的「掃描 + 讀註解」
                       - TransactionTemplate = 第 06 章 6.6 節的高階函式
                       - Actuator /info = 第 10 章 10.6 節的 BuildInfo
    ↓
03～09           ── REST API、Controller、Service、Repository、
                    MySQL、JPA/MyBatis、Spring Security
    ↓
10-capstone      ── 把全部組起來
```

> **這一站刻意不用框架，就是為了讓你在第 02 站能分辨
> 「這是 Java 語言本來就有的」和「這是 Spring 加上去的」。**
>
> 很多人學 Spring 學得很痛苦，是因為他們同時在學兩件事，
> 而且分不清哪件是哪件。你不會有這個問題——
> **因為你已經自己寫過一遍了。**

準備好了就前往 [02-spring-boot](../02-spring-boot/)。
