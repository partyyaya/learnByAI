# 第 05 章：集合框架與泛型

> 你每天寫的 Java，大概有一半時間在操作集合。選錯一個集合，可能讓一支 API 從 20ms 變成 2 秒；
> `hashCode` 寫錯一行，可能讓你「放進 `HashMap` 的東西找不到」。
>
> 這章要做兩件事：**建立選型直覺**（什麼情況用什麼集合），
> 以及**講清楚 `equals` / `hashCode` 契約**——它是實務上最常被違反、後果最詭異的一條規則。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 畫出集合框架的繼承地圖，並說出 `List` / `Set` / `Map` / `Queue` 的語意差別。
- 在 `ArrayList` 與 `LinkedList` 之間做出有依據的選擇（並知道為什麼答案幾乎總是 `ArrayList`）。
- 說明 `HashMap` 的內部結構、擴容機制，以及 Java 8 的樹化最佳化。
- 完整說出 `equals` / `hashCode` 契約，並解釋「可變 key」為什麼會讓資料消失。
- 分辨 `Arrays.asList` / `List.of` / `Collections.unmodifiableList` / `List.copyOf` 的差異。
- 避開 `ConcurrentModificationException`，並知道 `removeIf` 與 `Iterator.remove` 的用法。
- 用 `Comparator.comparing().thenComparing()` 寫出多欄位排序，並正確處理 `null`。
- 選對 `Queue` / `Deque` / `PriorityQueue`，並知道為什麼不要用 `Stack`。
- 讀懂 `List<? extends T>` 與 `List<? super T>`，並用 PECS 原則決定該寫哪一個。
- 說明型別抹除帶來的三個限制。

---

## 5.2 集合框架地圖

```
                    Iterable
                        │
                   Collection ──────────────────┐
                   ╱    │    ╲                  │
                List   Set   Queue          (Map 不繼承 Collection)
                 │      │      │                │
    ┌────────────┤      │      ├──────┐         ├── HashMap
    │            │      │      │      │         ├── LinkedHashMap
 ArrayList  LinkedList  │   Deque  PriorityQueue├── TreeMap
                        │      │                ├── EnumMap
            ┌───────────┤   ArrayDeque          ├── Hashtable（過時）
            │           │   LinkedList          └── ConcurrentHashMap
        HashSet    SortedSet
            │           │
    LinkedHashSet   TreeSet
```

**四種語意：**

| 介面 | 語意 | 允許重複 | 有順序 |
|---|---|---|---|
| `List` | **有序序列**，可用索引存取 | ✅ | ✅ 插入順序 |
| `Set` | **不重複的集合** | ❌ | 視實作 |
| `Queue` / `Deque` | **有進出規則的佇列** | ✅ | 依規則 |
| `Map` | **鍵值對應** | key ❌ / value ✅ | 視實作 |

> ⚠️ **`Map` 不是 `Collection`**。這是常見的誤解。`Map` 是獨立的介面，
> 但可以透過 `keySet()` / `values()` / `entrySet()` 取得 `Collection` 視圖。

### 【Java 21】`SequencedCollection`

Java 21 補上了一個長期缺失的抽象：「有明確首尾的集合」。

```java
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.SequencedCollection;

public class SequencedDemo {
    public static void main(String[] args) {
        SequencedCollection<String> list = new ArrayList<>(List.of("a", "b", "c"));

        System.out.println(list.getFirst());          // a  ← 以前要寫 list.get(0)
        System.out.println(list.getLast());            // c  ← 以前要寫 list.get(list.size()-1)
        System.out.println(list.reversed());           // [c, b, a]（是視圖，不是拷貝）

        list.addFirst("z");
        System.out.println(list);                      // [z, a, b, c]

        // LinkedHashSet 也支援
        var set = new LinkedHashSet<>(List.of("x", "y"));
        System.out.println(set.getFirst());             // x

        // LinkedHashMap → SequencedMap
        var map = new LinkedHashMap<String, Integer>();
        map.put("a", 1);
        map.put("b", 2);
        System.out.println(map.firstEntry());           // a=1
        System.out.println(map.lastEntry());            // b=2
    }
}
```

> 在 Java 21 之前，「取最後一個元素」在 `List`、`Deque`、`SortedSet` 上是三種完全不同的寫法。
> 本課仍會示範傳統寫法（因為你會遇到 Java 17 甚至 11 的專案），但有 21 可用時優先用這些新方法。

---

## 5.3 `List`：`ArrayList` vs `LinkedList`

### 內部結構

```
ArrayList：連續的陣列
┌────┬────┬────┬────┬────┬────┬────┐
│ A  │ B  │ C  │ D  │null│null│null│    容量 7，size 4
└────┴────┴────┴────┴────┴────┴────┘
索引存取 O(1)：直接算記憶體位址

LinkedList：雙向連結
null ← ┌───┐ ⇄ ┌───┐ ⇄ ┌───┐ ⇄ ┌───┐ → null
       │ A │   │ B │   │ C │   │ D │
       └───┘   └───┘   └───┘   └───┘
索引存取 O(n)：必須從頭（或尾）一個一個走
```

### 複雜度對照

| 操作 | `ArrayList` | `LinkedList` |
|---|---|---|
| `get(i)` / `set(i, e)` | **O(1)** | O(n) |
| `add(e)` 加在尾端 | O(1) 均攤 | O(1) |
| `add(0, e)` 加在開頭 | O(n) | **O(1)** |
| `remove(i)` 中間 | O(n)（要搬移） | O(n)（要先走到） |
| `contains(e)` | O(n) | O(n) |
| 記憶體 | 陣列 + 預留空間 | 每個元素多兩個參考（約多 40 bytes/元素） |

### 為什麼答案幾乎總是 `ArrayList`

理論上「頻繁在開頭插入用 `LinkedList`」，但實務上：

```java
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;

public class ListPerformance {

    static final int N = 100_000;

    public static void main(String[] args) {
        // 暖機（第 00 章 0.9 節）
        for (int i = 0; i < 3; i++) { randomAccess(new ArrayList<>()); }

        System.out.println("=== 隨機讀取 " + N + " 次 ===");
        System.out.println("ArrayList : " + randomAccess(fill(new ArrayList<>())) + " ms");
        System.out.println("LinkedList: " + randomAccess(fill(new LinkedList<>())) + " ms");

        System.out.println("\n=== 循序走訪（for-each）===");
        System.out.println("ArrayList : " + iterate(fill(new ArrayList<>())) + " ms");
        System.out.println("LinkedList: " + iterate(fill(new LinkedList<>())) + " ms");
    }

    static List<Integer> fill(List<Integer> list) {
        for (int i = 0; i < N; i++) list.add(i);
        return list;
    }

    static long randomAccess(List<Integer> list) {
        if (list.isEmpty()) return 0;
        long start = System.currentTimeMillis();
        long sum = 0;
        for (int i = 0; i < N; i++) {
            sum += list.get((i * 7919) % list.size());     // 偽隨機索引
        }
        return System.currentTimeMillis() - start;
    }

    static long iterate(List<Integer> list) {
        long start = System.currentTimeMillis();
        long sum = 0;
        for (int v : list) sum += v;
        return System.currentTimeMillis() - start;
    }
}
```

典型結果（數量級供參考）：

```
=== 隨機讀取 100000 次 ===
ArrayList : 2 ms
LinkedList: 8000 ms          ← 慢了數千倍

=== 循序走訪（for-each）===
ArrayList : 1 ms
LinkedList: 3 ms             ← 差距不大，但 ArrayList 仍勝（CPU 快取友善）
```

**三個實務理由：**

1. **快取局部性（cache locality）**：`ArrayList` 的元素在記憶體中連續，CPU 快取一次能載入多個。
   `LinkedList` 的節點散在堆積各處，每次都是 cache miss。
2. **「頻繁在開頭插入」的需求，通常真正該用的是 `ArrayDeque`**（5.11 節），它兩端都是 O(1) 且快取友善。
3. **`LinkedList` 的 `get(i)` 是 O(n)**。很多人寫了 `for (int i = 0; i < list.size(); i++) list.get(i)`，
   在 `LinkedList` 上就是 O(n²)——這是實務上「莫名很慢」的一個經典來源。

> **結論：預設用 `ArrayList`。** 需要雙端操作用 `ArrayDeque`。
> `LinkedList` 只在「你已經有 `ListIterator`，要在迭代過程中大量增刪」時才有優勢，這很少見。

### `ArrayList` 的擴容與預設容量

```java
import java.util.ArrayList;
import java.util.List;

public class ArrayListCapacity {
    public static void main(String[] args) {
        // 預設容量 10（實際上是延遲配置，第一次 add 才建立）
        List<Integer> defaultList = new ArrayList<>();

        // 擴容公式：newCapacity = oldCapacity + (oldCapacity >> 1)，也就是 1.5 倍
        // 10 → 15 → 22 → 33 → 49 → 73 → ...
        // 每次擴容都要「配置新陣列 + 複製全部元素」

        // ✅ 已知大小時，預先指定容量，避免多次擴容與陣列複製
        List<Integer> preSized = new ArrayList<>(10_000);
        for (int i = 0; i < 10_000; i++) preSized.add(i);

        // 從既有集合建立時會自動用正確容量
        List<Integer> copied = new ArrayList<>(preSized);
        System.out.println(copied.size());       // 10000
    }
}
```

> **實務價值**：從資料庫查出 10 萬筆資料放進 `ArrayList`，
> 不指定容量會發生約 30 次擴容 + 陣列複製。指定容量能省下可觀的 GC 壓力。
> 這在批次處理（第 03 章的匯入任務）很有感。

---

## 5.4 `List` 常用操作與四個陷阱

```java
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class ListOperations {
    public static void main(String[] args) {
        List<String> list = new ArrayList<>(List.of("b", "a", "c"));

        list.add("d");                    // 尾端加入
        list.add(0, "z");                 // 指定位置插入
        System.out.println(list);         // [z, b, a, c, d]

        System.out.println(list.get(1));           // b
        System.out.println(list.indexOf("c"));     // 3
        System.out.println(list.contains("a"));    // true
        System.out.println(list.size());           // 5

        list.set(0, "Z");                          // 取代
        list.remove("Z");                          // 依「值」移除
        list.remove(0);                            // 依「索引」移除（第 01 章 1.14 節的重載陷阱）
        System.out.println(list);                  // [a, c, d]

        Collections.sort(list);                    // 原地排序
        System.out.println(list);                  // [a, c, d]
        Collections.reverse(list);
        System.out.println(list);                  // [d, c, a]

        list.addAll(List.of("x", "y"));
        System.out.println(list);                  // [d, c, a, x, y]
        list.removeAll(List.of("x", "y"));
        System.out.println(list);                  // [d, c, a]
        list.retainAll(List.of("d", "a"));         // 只保留交集
        System.out.println(list);                  // [d, a]

        list.clear();
        System.out.println(list.isEmpty());        // true
    }
}
```

### 陷阱 1：四種「不可變」List 其實都不一樣

```java
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class ImmutableListVariants {
    public static void main(String[] args) {

        // ① Arrays.asList：固定大小，但可以 set！而且會反向影響原陣列
        String[] array = {"a", "b", "c"};
        List<String> asList = Arrays.asList(array);
        asList.set(0, "CHANGED");
        System.out.println(array[0]);          // CHANGED  ← 原陣列被改了！
        try {
            asList.add("d");
        } catch (UnsupportedOperationException e) {
            System.out.println("① asList 不能 add（固定大小）");
        }

        // ② List.of：真正不可變，且「不允許 null」【Java 9+】
        List<String> of = List.of("a", "b", "c");
        try {
            of.set(0, "x");
        } catch (UnsupportedOperationException e) {
            System.out.println("② List.of 不能 set");
        }
        try {
            List.of("a", null);
        } catch (NullPointerException e) {
            System.out.println("② List.of 不接受 null 元素");
        }

        // ③ Collections.unmodifiableList：唯讀「視圖」，底層還能被改！
        List<String> mutable = new ArrayList<>(List.of("a", "b"));
        List<String> view = Collections.unmodifiableList(mutable);
        mutable.add("c");                       // 從底層改
        System.out.println("③ 視圖跟著變: " + view);   // [a, b, c]  ← 不是真的不可變！

        // ④ List.copyOf：真拷貝 + 不可變，這才是存進欄位時該用的【Java 10+】
        List<String> copy = List.copyOf(mutable);
        mutable.add("d");
        System.out.println("④ 拷貝不受影響: " + copy);  // [a, b, c]
    }
}
```

**選用建議：**

| 情境 | 用什麼 |
|---|---|
| 建立小的常數清單 | `List.of(...)` |
| 存進物件欄位（防禦性拷貝） | `List.copyOf(...)` |
| 從 getter 回傳內部集合 | `List.copyOf(...)` 或 `Collections.unmodifiableList(...)`（前者更安全） |
| 需要可變的 List | `new ArrayList<>(...)` |
| `Arrays.asList` | 只在「要一個固定大小、且刻意要與陣列連動」時用；否則改用 `List.of` |

### 陷阱 2：`Arrays.asList` 對基本型別陣列的行為

```java
import java.util.Arrays;
import java.util.List;

public class AsListWithPrimitives {
    public static void main(String[] args) {
        int[] ints = {1, 2, 3};

        // ❌ 得到 List<int[]>，size 是 1！
        List<int[]> wrong = Arrays.asList(ints);
        System.out.println(wrong.size());                 // 1

        // ✅ 用 Integer[] 或 stream
        Integer[] boxed = {1, 2, 3};
        System.out.println(Arrays.asList(boxed).size());  // 3
        System.out.println(Arrays.stream(ints).boxed().toList().size());   // 3（第 06 章）
    }
}
```

因為泛型不能用基本型別（5.12 節），`Arrays.asList(int[])` 只能把整個陣列當成**一個**元素。

### 陷阱 3：`subList` 是視圖，不是拷貝

```java
import java.util.ArrayList;
import java.util.List;

public class SubListTrap {
    public static void main(String[] args) {
        List<String> list = new ArrayList<>(List.of("a", "b", "c", "d", "e"));

        List<String> sub = list.subList(1, 4);        // [b, c, d]，是「視圖」
        System.out.println(sub);

        sub.set(0, "B");
        System.out.println(list);                      // [a, B, c, d, e]  ← 原 list 被改了

        // ⚠️ 對原 list 做結構性修改後，視圖就失效了
        list.add("f");
        try {
            System.out.println(sub);
        } catch (java.util.ConcurrentModificationException e) {
            System.out.println("原 list 結構改變後，subList 視圖失效");
        }

        // ✅ 想要獨立的拷貝
        List<String> real = new ArrayList<>(list.subList(1, 4));
        list.set(1, "XXX");
        System.out.println(real);                      // 不受影響
    }
}
```

> **實務踩雷**：`subList` 常被用來做分頁（`list.subList(offset, offset + size)`）。
> 如果把這個視圖回傳給呼叫方，之後原 list 被修改，呼叫方就會拿到 `ConcurrentModificationException`。
> **回傳前一定要包成 `new ArrayList<>(...)` 或 `List.copyOf(...)`。**

### 陷阱 4：`remove` 的重載

第 01 章 1.14 節提過，這裡再強調一次，因為它真的常出事：

```java
import java.util.ArrayList;
import java.util.List;

public class RemoveOverload {
    public static void main(String[] args) {
        List<Integer> list = new ArrayList<>(List.of(10, 20, 30));

        list.remove(1);                       // remove(int index) → 移除索引 1
        System.out.println(list);             // [10, 30]

        list.remove(Integer.valueOf(30));     // remove(Object) → 移除「值」30
        System.out.println(list);             // [10]

        // 更安全的寫法
        List<Integer> l2 = new ArrayList<>(List.of(10, 20, 30));
        l2.removeIf(v -> v == 30);            // 意圖明確，不會誤選重載
        System.out.println(l2);               // [10, 20]
    }
}
```

---

## 5.5 `Set`：三種實作的取捨

```java
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.TreeSet;

public class SetVariants {
    public static void main(String[] args) {
        var input = java.util.List.of("banana", "apple", "cherry", "apple");

        // HashSet：最快，但順序不保證（且會因 JDK 版本、元素而變）
        Set<String> hash = new HashSet<>(input);
        System.out.println("HashSet      : " + hash);
        // [banana, cherry, apple]（順序不可依賴）

        // LinkedHashSet：保留插入順序
        Set<String> linked = new LinkedHashSet<>(input);
        System.out.println("LinkedHashSet: " + linked);
        // [banana, apple, cherry]

        // TreeSet：自動排序（依 Comparable 或 Comparator）
        Set<String> tree = new TreeSet<>(input);
        System.out.println("TreeSet      : " + tree);
        // [apple, banana, cherry]
    }
}
```

| | `HashSet` | `LinkedHashSet` | `TreeSet` |
|---|---|---|---|
| `add` / `contains` / `remove` | **O(1)** | O(1) | O(log n) |
| 順序 | ❌ 不保證 | ✅ 插入順序 | ✅ 排序 |
| 需要 | `hashCode` + `equals` | 同 `HashSet` | `Comparable` 或 `Comparator` |
| `null` 元素 | ✅ 一個 | ✅ 一個 | ❌ 丟 NPE |
| 額外能力 | — | — | `first()` / `last()` / `headSet()` / `tailSet()` / `subSet()` |

### `TreeSet` 的實務用途

```java
import java.util.TreeSet;

public class TreeSetUsage {
    public static void main(String[] args) {
        TreeSet<Integer> prices = new TreeSet<>(java.util.List.of(100, 250, 380, 590, 1200));

        System.out.println(prices.first());          // 100    最小
        System.out.println(prices.last());           // 1200   最大
        System.out.println(prices.floor(400));       // 380    ≤ 400 的最大值
        System.out.println(prices.ceiling(400));     // 590    ≥ 400 的最小值
        System.out.println(prices.lower(380));       // 250    < 380 的最大值
        System.out.println(prices.higher(380));      // 590    > 380 的最小值

        // 範圍查詢：找出 200~600 的價格
        System.out.println(prices.subSet(200, 600)); // [250, 380, 590]
        System.out.println(prices.headSet(380));     // [100, 250]（< 380）
        System.out.println(prices.tailSet(380));     // [380, 590, 1200]（≥ 380）

        System.out.println(prices.descendingSet());  // [1200, 590, 380, 250, 100]
    }
}
```

> **實務案例**：價格區間篩選、時間範圍查詢（找出最接近某時間點的紀錄）、
> 排行榜的「排名附近的人」、限流器的滑動視窗。這些用 `TreeSet` / `TreeMap` 比自己排序快得多。

### `EnumSet`：enum 專用，極快且省記憶體

```java
import java.util.EnumSet;
import java.util.Set;

public class EnumSetDemo {

    enum Permission { READ, WRITE, DELETE, ADMIN }

    public static void main(String[] args) {
        // 內部用 long 的位元遮罩實作，比 HashSet 快得多且幾乎不佔記憶體
        Set<Permission> userPerms = EnumSet.of(Permission.READ, Permission.WRITE);
        Set<Permission> adminPerms = EnumSet.allOf(Permission.class);
        Set<Permission> nonePerms = EnumSet.noneOf(Permission.class);
        Set<Permission> readonly = EnumSet.complementOf(
                EnumSet.of(Permission.WRITE, Permission.DELETE, Permission.ADMIN));

        System.out.println(userPerms);        // [READ, WRITE]（依 enum 宣告順序）
        System.out.println(adminPerms);       // [READ, WRITE, DELETE, ADMIN]
        System.out.println(nonePerms);        // []
        System.out.println(readonly);         // [READ]

        System.out.println(userPerms.contains(Permission.DELETE));   // false

        // 集合運算
        Set<Permission> extra = EnumSet.copyOf(adminPerms);
        extra.removeAll(userPerms);
        System.out.println("管理員多出的權限: " + extra);   // [DELETE, ADMIN]
    }
}
```

> 這是第 01 章 1.10 節「位元旗標」的正確做法——同樣的效能，可讀性好得多。
> **只要集合元素是 enum，就用 `EnumSet` / `EnumMap`。**

---

## 5.6 `Map`：最重要的集合

### `HashMap` 的內部結構

```
HashMap 內部是一個「桶（bucket）陣列」，每個桶是連結串列或紅黑樹

table[0]  → null
table[1]  → [key1,v1] → [key9,v9]           ← hash 衝突，用連結串列串起來
table[2]  → null
table[3]  → [key3,v3]
...
table[15] → [k,v]→[k,v]→[k,v]→...→[k,v]     ← 超過 8 個且 table 長度 ≥ 64
                                              → 轉成紅黑樹，查詢從 O(n) 變 O(log n)

put(key, value) 的流程：
  ① h = key.hashCode()
  ② h = h ^ (h >>> 16)              擾動，讓高位也參與運算
  ③ index = h & (table.length - 1)  取模（因為長度是 2 的次方，位元 AND 等於取模）
  ④ 走訪該桶：先比 hash，再比 equals
  ⑤ 找到相同 key → 覆寫 value；沒找到 → 加在尾端
```

**關鍵參數：**

| 參數 | 預設值 | 意義 |
|---|---|---|
| 初始容量 | 16 | 桶陣列長度，永遠是 2 的次方 |
| 負載因子 | 0.75 | `size > capacity × 0.75` 就擴容 |
| 擴容倍數 | 2 | 16 → 32 → 64 → 128 … |
| 樹化門檻 | 8 | 單一桶超過 8 個節點且 table 長度 ≥ 64 時轉紅黑樹 |
| 退化門檻 | 6 | 樹節點少於 6 時退回連結串列 |

```java
import java.util.HashMap;
import java.util.Map;

public class HashMapCapacity {
    public static void main(String[] args) {
        // ❌ 預期放 1000 筆，用預設容量會擴容 7 次（16→32→...→2048），每次都要 rehash 全部元素
        Map<String, Integer> lazy = new HashMap<>();

        // ✅ 預先指定：容量 = 預期筆數 / 0.75 + 1，向上取到 2 的次方
        //    1000 / 0.75 ≈ 1334 → 2048
        Map<String, Integer> sized = new HashMap<>(2048);

        for (int i = 0; i < 1000; i++) {
            sized.put("key" + i, i);
        }
        System.out.println(sized.size());     // 1000
    }
}
```

### 四種 `Map` 實作

```java
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

public class MapVariants {

    enum Level { HIGH, MEDIUM, LOW }

    public static void main(String[] args) {
        // HashMap：最快，順序不保證
        Map<String, Integer> hash = new HashMap<>();
        hash.put("banana", 2);
        hash.put("apple", 1);
        hash.put("cherry", 3);
        System.out.println("HashMap      : " + hash);

        // LinkedHashMap：保留插入順序
        Map<String, Integer> linked = new LinkedHashMap<>();
        linked.put("banana", 2);
        linked.put("apple", 1);
        linked.put("cherry", 3);
        System.out.println("LinkedHashMap: " + linked);
        // {banana=2, apple=1, cherry=3}

        // TreeMap：依 key 排序
        Map<String, Integer> tree = new TreeMap<>(linked);
        System.out.println("TreeMap      : " + tree);
        // {apple=1, banana=2, cherry=3}

        // EnumMap：key 是 enum 時的最佳選擇（內部是陣列，極快）
        Map<Level, String> enumMap = new EnumMap<>(Level.class);
        enumMap.put(Level.LOW, "低");
        enumMap.put(Level.HIGH, "高");
        System.out.println("EnumMap      : " + enumMap);
        // {HIGH=高, LOW=低}  ← 依 enum 宣告順序，不是插入順序
    }
}
```

| | `HashMap` | `LinkedHashMap` | `TreeMap` | `EnumMap` |
|---|---|---|---|---|
| `get` / `put` | **O(1)** | O(1) | O(log n) | **O(1)** |
| 順序 | ❌ | ✅ 插入（或存取）順序 | ✅ key 排序 | ✅ enum 宣告順序 |
| `null` key | ✅ 一個 | ✅ 一個 | ❌ NPE | ❌ NPE |
| 記憶體 | 中 | 略高（多兩個參考） | 高 | **最低** |

### `Map` 的現代 API（很多人還在用舊寫法）

```java
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class ModernMapApi {
    public static void main(String[] args) {
        Map<String, Integer> stock = new HashMap<>();
        stock.put("keyboard", 10);

        // ① getOrDefault：避免 null 拆箱 NPE（第 01 章 1.7 節）
        System.out.println(stock.getOrDefault("mouse", 0));    // 0

        // ② putIfAbsent：只在不存在時放入
        stock.putIfAbsent("keyboard", 999);
        stock.putIfAbsent("mouse", 5);
        System.out.println(stock);        // {keyboard=10, mouse=5}

        // ③ computeIfAbsent：最常用！「取不到就建一個」
        Map<String, List<String>> ordersByUser = new HashMap<>();

        // ❌ 舊寫法：五行
        // List<String> list = ordersByUser.get("u001");
        // if (list == null) {
        //     list = new ArrayList<>();
        //     ordersByUser.put("u001", list);
        // }
        // list.add("ORD-1");

        // ✅ 一行
        ordersByUser.computeIfAbsent("u001", k -> new ArrayList<>()).add("ORD-1");
        ordersByUser.computeIfAbsent("u001", k -> new ArrayList<>()).add("ORD-2");
        System.out.println(ordersByUser);      // {u001=[ORD-1, ORD-2]}

        // ④ merge：計數器的標準寫法
        Map<String, Integer> wordCount = new HashMap<>();
        for (String word : List.of("a", "b", "a", "c", "a")) {
            wordCount.merge(word, 1, Integer::sum);
        }
        System.out.println(wordCount);         // {a=3, b=1, c=1}

        // ⑤ compute：依現有值計算新值
        stock.compute("keyboard", (k, v) -> v == null ? 1 : v - 3);
        System.out.println(stock.get("keyboard"));    // 7

        // ⑥ computeIfPresent：只在存在時計算
        stock.computeIfPresent("nonexistent", (k, v) -> v + 1);   // 什麼都不做

        // ⑦ 走訪
        stock.forEach((k, v) -> System.out.println("  " + k + " → " + v));

        for (Map.Entry<String, Integer> entry : stock.entrySet()) {
            // ✅ 用 entrySet 走訪，比 keySet + get 快（少一次查詢）
            System.out.println("  " + entry.getKey() + " = " + entry.getValue());
        }

        // ⑧ remove 的兩參數版本：只在 key-value 都符合時移除（原子語意）
        System.out.println(stock.remove("mouse", 999));    // false（value 不符）
        System.out.println(stock.remove("mouse", 5));      // true
    }
}
```

> **`computeIfAbsent` 和 `merge` 是實務上最該記住的兩個。** 它們讓「分組」和「計數」從五行變一行。
> 第 06 章的 `groupingBy` / `counting` 是它們的 Stream 版本。

### `LinkedHashMap` 實作 LRU 快取

`LinkedHashMap` 有一個少人知道的建構子參數 `accessOrder`，讓它變成「最近使用排最後」：

```java
import java.util.LinkedHashMap;
import java.util.Map;

public class LruCache<K, V> extends LinkedHashMap<K, V> {

    private final int maxSize;

    public LruCache(int maxSize) {
        // initialCapacity, loadFactor, accessOrder=true（依存取順序而非插入順序）
        super(Math.max(16, maxSize * 4 / 3 + 1), 0.75f, true);
        if (maxSize <= 0) {
            throw new IllegalArgumentException("maxSize 必須大於 0，收到: " + maxSize);
        }
        this.maxSize = maxSize;
    }

    /** LinkedHashMap 每次 put 之後會呼叫這個方法問「要不要移除最舊的」 */
    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > maxSize;
    }

    public static void main(String[] args) {
        LruCache<String, String> cache = new LruCache<>(3);

        cache.put("a", "1");
        cache.put("b", "2");
        cache.put("c", "3");
        System.out.println(cache);            // {a=1, b=2, c=3}

        cache.get("a");                       // 存取 a → a 移到最後
        System.out.println(cache);            // {b=2, c=3, a=1}

        cache.put("d", "4");                  // 超過容量 → 移除最舊的 b
        System.out.println(cache);            // {c=3, a=1, d=4}

        System.out.println(cache.containsKey("b"));   // false（已被淘汰）
    }
}
```

> ⚠️ **這個實作不是執行緒安全的**。正式環境的快取請用 **Caffeine** 或 **Redis**（第 05 站會講）。
> 但理解這個機制很有價值——面試常考，而且 Caffeine 的淘汰策略就是這個概念的進階版。

---

## 5.7 `equals` / `hashCode` 契約：本章最重要的一節

### 契約

> 1. **如果 `a.equals(b)` 為 `true`，那麼 `a.hashCode() == b.hashCode()` 必須為 `true`。**
> 2. 反之不必然（hash 相同但物件不同，叫做「碰撞」，是允許的）。
> 3. 只要物件沒被修改，多次呼叫 `hashCode()` 必須回傳相同值。

違反第 1 條，`HashMap` / `HashSet` 就會壞掉。

### 災難案例一：只覆寫 `equals`

```java
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class OnlyEquals {

    static class ProductKey {
        private final String sku;
        private final String warehouse;

        ProductKey(String sku, String warehouse) {
            this.sku = sku;
            this.warehouse = warehouse;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof ProductKey other)) return false;
            return sku.equals(other.sku) && warehouse.equals(other.warehouse);
        }

        // ❌ 忘記覆寫 hashCode！
    }

    public static void main(String[] args) {
        ProductKey k1 = new ProductKey("SKU-1001", "TPE");
        ProductKey k2 = new ProductKey("SKU-1001", "TPE");

        System.out.println(k1.equals(k2));      // true   ← equals 說它們相等

        Map<ProductKey, Integer> stock = new HashMap<>();
        stock.put(k1, 100);

        System.out.println(stock.get(k2));      // null   💥 查不到！
        System.out.println(stock.containsKey(k2));  // false

        Set<ProductKey> set = new HashSet<>();
        set.add(k1);
        set.add(k2);
        System.out.println(set.size());         // 2      💥 「不重複」的集合裡有兩個相等的元素
    }
}
```

**為什麼？** `HashMap.get(k2)` 先用 `k2.hashCode()` 找桶。`Object` 的預設 `hashCode` 基於物件位址，
`k1` 和 `k2` 的 hash 完全不同 → 找到不同的桶 → 根本走不到 `equals` 比較。

**修正：**

```java
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

public class WithHashCode {

    static class ProductKey {
        private final String sku;
        private final String warehouse;

        ProductKey(String sku, String warehouse) {
            this.sku = Objects.requireNonNull(sku);
            this.warehouse = Objects.requireNonNull(warehouse);
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof ProductKey other)) return false;
            return sku.equals(other.sku) && warehouse.equals(other.warehouse);
        }

        @Override
        public int hashCode() {
            return Objects.hash(sku, warehouse);      // ✅ 用「同一組欄位」
        }

        @Override
        public String toString() {
            return "%s@%s".formatted(sku, warehouse);
        }
    }

    public static void main(String[] args) {
        Map<ProductKey, Integer> stock = new HashMap<>();
        stock.put(new ProductKey("SKU-1001", "TPE"), 100);

        System.out.println(stock.get(new ProductKey("SKU-1001", "TPE")));   // 100  ✅
    }
}
```

### 災難案例二：可變的 key（更難查）

```java
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public class MutableKeyDisaster {

    static class Tag {
        private String name;      // ⚠️ 可變！

        Tag(String name) { this.name = name; }

        void setName(String name) { this.name = name; }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof Tag other)) return false;
            return Objects.equals(name, other.name);
        }

        @Override
        public int hashCode() { return Objects.hash(name); }

        @Override
        public String toString() { return "Tag(" + name + ")"; }
    }

    public static void main(String[] args) {
        Tag tag = new Tag("urgent");

        Map<Tag, Integer> counts = new HashMap<>();
        counts.put(tag, 5);
        System.out.println(counts.get(tag));            // 5   正常

        // 💥 修改了已經放進 Map 的 key
        tag.setName("important");

        System.out.println(counts.get(tag));            // null  ← 用「同一個物件」都查不到了！
        System.out.println(counts.get(new Tag("important")));  // null
        System.out.println(counts.get(new Tag("urgent")));     // null
        System.out.println(counts.size());              // 1     ← 東西還在，但誰都拿不到
        System.out.println(counts);                     // {Tag(important)=5}

        // Set 也一樣
        Set<Tag> set = new HashSet<>();
        Tag t = new Tag("a");
        set.add(t);
        t.setName("b");
        System.out.println(set.contains(t));            // false 💥
        System.out.println(set.contains(new Tag("b"))); // false
    }
}
```

**這是記憶體洩漏的一種形式**：元素永遠留在 Map 裡，但沒有任何方式能取出或移除它。
第 09 章會用 heap dump 抓出這種問題。

**三個修法（按推薦順序）：**

```java
// ✅ 方案 1（最佳）：key 用不可變物件
record ProductKey(String sku, String warehouse) { }     // record 自帶 equals/hashCode（第 12 章）

// ✅ 方案 2：hashCode 只用「不會變的欄位」（通常是 id）
class Order {
    private final long id;         // 不變
    private String status;         // 會變

    @Override public boolean equals(Object o) {
        return o instanceof Order other && id == other.id;      // 只比 id
    }
    @Override public int hashCode() { return Long.hashCode(id); }  // 只用 id
}

// ✅ 方案 3：key 用 String / Long 這類不可變型別
Map<String, Integer> counts = new HashMap<>();       // key 是 sku 字串
```

> **這也解釋了第 02 章 2.16 節為什麼 `Todo.equals` 只用 `id`。**
> 實體（entity）的 `title`、`priority`、`done` 都會變，只有 `id` 不變。
> **對照：值物件（value object，如 `Money`、`DateRange`）本身不可變，才可以用全部欄位。**

### `Objects.hash` vs 手寫

```java
import java.util.Objects;

public class HashCodeImplementations {

    static class Point {
        final int x, y, z;

        Point(int x, int y, int z) { this.x = x; this.y = y; this.z = z; }

        // ✅ 方案 A：Objects.hash（可讀性最好，但會建立一個 varargs 陣列 + 裝箱）
        public int hashCodeA() {
            return Objects.hash(x, y, z);
        }

        // ✅ 方案 B：手寫（無裝箱，效能好；熱路徑上值得）
        public int hashCodeB() {
            int result = Integer.hashCode(x);
            result = 31 * result + Integer.hashCode(y);
            result = 31 * result + Integer.hashCode(z);
            return result;
        }
    }

    public static void main(String[] args) {
        Point p = new Point(1, 2, 3);
        System.out.println(p.hashCodeA());     // 30817
        System.out.println(p.hashCodeB());     // 30817（同樣的演算法）
    }
}
```

**實務建議**：預設用 `Objects.hash`（可讀性優先）。只有在**被證實是熱點**時才手寫。
最好的做法是用 `record`（第 12 章），編譯器會產生高效的實作。

### 為什麼是 31

`31` 是奇質數，且 `31 * i == (i << 5) - i`（JVM 可以最佳化成位移 + 減法）。
這是 `String.hashCode()` 用的常數，沿用它是慣例。

### `hashCode` 品質不好的後果

```java
import java.util.HashMap;
import java.util.Map;

public class BadHashCode {

    static class TerribleKey {
        private final int id;

        TerribleKey(int id) { this.id = id; }

        @Override
        public boolean equals(Object o) {
            return o instanceof TerribleKey other && id == other.id;
        }

        @Override
        public int hashCode() {
            return 1;      // ❌ 合法但災難：所有物件都在同一個桶
        }
    }

    static class GoodKey {
        private final int id;

        GoodKey(int id) { this.id = id; }

        @Override
        public boolean equals(Object o) {
            return o instanceof GoodKey other && id == other.id;
        }

        @Override
        public int hashCode() { return Integer.hashCode(id); }
    }

    public static void main(String[] args) {
        int n = 50_000;

        long start = System.currentTimeMillis();
        Map<TerribleKey, Integer> bad = new HashMap<>();
        for (int i = 0; i < n; i++) bad.put(new TerribleKey(i), i);
        System.out.println("hashCode 全部相同: " + (System.currentTimeMillis() - start) + " ms");

        start = System.currentTimeMillis();
        Map<GoodKey, Integer> good = new HashMap<>();
        for (int i = 0; i < n; i++) good.put(new GoodKey(i), i);
        System.out.println("hashCode 分布良好: " + (System.currentTimeMillis() - start) + " ms");
    }
}
```

典型結果：

```
hashCode 全部相同: 180 ms      ← Java 8+ 會樹化，所以是 O(log n) 而不是 O(n)
hashCode 分布良好: 12 ms
```

> **Java 8 之前這個差距是幾百倍**（O(n) 的連結串列）。
> Java 8 的樹化最佳化把最糟情況從 O(n) 改善到 O(log n)——這也是為什麼樹化這個機制存在：
> 它是對「惡意構造 hash 碰撞」的 DoS 攻擊（hash collision attack）的防禦。

---

## 5.8 不可變集合與防禦性拷貝

第 02 章 2.9 節講過原理，這裡整理成實務規則。

```java
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class Order {

    private final String id;
    private final List<String> itemSkus;
    private final Map<String, String> metadata;
    private final Set<String> tags;

    public Order(String id, List<String> itemSkus,
                 Map<String, String> metadata, Set<String> tags) {
        this.id = Objects.requireNonNull(id, "id 不可為 null");
        // ✅ 進來時「真拷貝」成不可變集合
        this.itemSkus = List.copyOf(itemSkus);
        this.metadata = Map.copyOf(metadata);
        this.tags = Set.copyOf(tags);
    }

    // ✅ 已是不可變，直接回傳安全
    public List<String> getItemSkus() { return itemSkus; }
    public Map<String, String> getMetadata() { return metadata; }
    public Set<String> getTags() { return tags; }

    public String getId() { return id; }

    /** 「新增」回傳新物件，維持不可變 */
    public Order withTag(String tag) {
        var newTags = new java.util.HashSet<>(tags);
        newTags.add(tag);
        return new Order(id, itemSkus, metadata, newTags);
    }

    public static void main(String[] args) {
        List<String> skus = new ArrayList<>(List.of("SKU-1", "SKU-2"));
        Order order = new Order("ORD-001", skus, Map.of("channel", "web"), Set.of("vip"));

        // 外部修改原始集合，不影響 order
        skus.add("SKU-HACKED");
        System.out.println(order.getItemSkus());       // [SKU-1, SKU-2]  ✅

        // 從 getter 也改不到
        try {
            order.getItemSkus().add("SKU-HACKED");
        } catch (UnsupportedOperationException e) {
            System.out.println("getter 回傳的是不可變集合");
        }

        System.out.println(order.withTag("urgent").getTags());   // [vip, urgent]
        System.out.println(order.getTags());                      // [vip]（原物件不變）
    }
}
```

### `copyOf` vs `unmodifiableXxx` 的關鍵差別

| | `List.copyOf(x)` | `Collections.unmodifiableList(x)` |
|---|---|---|
| 是拷貝還是視圖 | **拷貝** | 視圖 |
| 原集合被改時 | 不受影響 ✅ | 跟著變 ❌ |
| 允許 `null` 元素 | ❌ | ✅ |
| 效能 | 需要一次拷貝 | 零成本 |
| 存進欄位時 | **用這個** | 不安全 |
| 只是要「暫時給別人唯讀看」 | 也可以 | 可以（零成本） |

> **`List.copyOf` 的一個小優化**：如果傳入的已經是不可變 List，它會直接回傳同一個物件，不會真的拷貝。

---

## 5.9 迭代與 `ConcurrentModificationException`

```java
import java.util.ArrayList;
import java.util.ConcurrentModificationException;
import java.util.Iterator;
import java.util.List;

public class IterationSafety {
    public static void main(String[] args) {

        // ❌ for-each 中修改集合
        List<String> list1 = new ArrayList<>(List.of("a", "", "b", "", "c"));
        try {
            for (String s : list1) {
                if (s.isEmpty()) list1.remove(s);
            }
        } catch (ConcurrentModificationException e) {
            System.out.println("① for-each 中修改 → ConcurrentModificationException");
        }

        // ✅ 方案 A：removeIf（最簡潔，Java 8+）
        List<String> list2 = new ArrayList<>(List.of("a", "", "b", "", "c"));
        list2.removeIf(String::isEmpty);
        System.out.println("② removeIf: " + list2);        // [a, b, c]

        // ✅ 方案 B：Iterator.remove（需要更複雜的判斷邏輯時用）
        List<String> list3 = new ArrayList<>(List.of("a", "", "b", "", "c"));
        Iterator<String> it = list3.iterator();
        while (it.hasNext()) {
            String s = it.next();
            if (s.isEmpty()) {
                it.remove();          // 透過 iterator 移除，它會同步內部的 modCount
            }
        }
        System.out.println("③ Iterator.remove: " + list3);  // [a, b, c]

        // ✅ 方案 C：倒著用索引走（要在移除的同時做別的事時用）
        List<String> list4 = new ArrayList<>(List.of("a", "", "b", "", "c"));
        for (int i = list4.size() - 1; i >= 0; i--) {
            if (list4.get(i).isEmpty()) {
                list4.remove(i);      // 倒著走，移除不影響尚未走訪的索引
            }
        }
        System.out.println("④ 倒序索引: " + list4);         // [a, b, c]

        // ✅ 方案 D：收集到新集合（原集合不動，最安全）
        List<String> list5 = new ArrayList<>(List.of("a", "", "b", "", "c"));
        List<String> result = new ArrayList<>();
        for (String s : list5) {
            if (!s.isEmpty()) result.add(s);
        }
        System.out.println("⑤ 建新集合: " + result);        // [a, b, c]
    }
}
```

### 為什麼會有這個例外——以及一個更可怕的變體

`ArrayList` 內部有一個 `modCount`（修改次數）。`Iterator` 建立時記下當時的 `modCount`，
每次 `next()` 都檢查有沒有變。這叫 **fail-fast**。

```java
import java.util.ArrayList;
import java.util.List;

public class FailFastNotGuaranteed {
    public static void main(String[] args) {
        // ⚠️ 倒數第二個元素被移除時，迴圈會「靜默結束」而不丟例外
        List<String> list = new ArrayList<>(List.of("a", "b", "c"));
        for (String s : list) {
            System.out.println("走訪: " + s);
            if (s.equals("b")) {
                list.remove(s);       // 移除倒數第二個
            }
        }
        System.out.println("結果: " + list);      // [a, c]，而且沒有丟例外！
    }
}
```

輸出：

```
走訪: a
走訪: b
結果: [a, c]
```

**`c` 完全沒被走訪到，也沒有任何錯誤提示。** 原因是 `hasNext()` 的實作是 `cursor != size`：
移除後 `size` 從 3 變 2，而 `cursor` 剛好是 2 → `hasNext()` 回傳 `false`，迴圈結束。

> **這比丟例外更危險**——你不會發現有元素被跳過。`ConcurrentModificationException` 是
> 「盡力而為」的偵測，**不能依賴它來保證正確性**。
> **規則：迭代時就是不要修改集合。用 `removeIf` 或建新集合。**

---

## 5.10 排序：`Comparable` 與 `Comparator`

### `Comparable`：物件的「自然順序」

```java
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class ComparableDemo {

    static class Version implements Comparable<Version> {
        private final int major, minor, patch;

        Version(int major, int minor, int patch) {
            this.major = major; this.minor = minor; this.patch = patch;
        }

        @Override
        public int compareTo(Version other) {
            // ✅ 用 Integer.compare，不要用相減（見下方溢位陷阱）
            int r = Integer.compare(this.major, other.major);
            if (r != 0) return r;
            r = Integer.compare(this.minor, other.minor);
            if (r != 0) return r;
            return Integer.compare(this.patch, other.patch);
        }

        @Override
        public String toString() { return "%d.%d.%d".formatted(major, minor, patch); }
    }

    public static void main(String[] args) {
        List<Version> versions = new ArrayList<>(List.of(
                new Version(1, 2, 3),
                new Version(1, 10, 0),
                new Version(2, 0, 0),
                new Version(1, 2, 10)));

        Collections.sort(versions);
        System.out.println(versions);       // [1.2.3, 1.2.10, 1.10.0, 2.0.0]
        // 注意：字串排序會得到 [1.10.0, 1.2.10, 1.2.3, 2.0.0]，這是常見的版本號排序 bug
    }
}
```

### ⚠️ `compareTo` 用相減會溢位

```java
public class CompareOverflow {

    public static void main(String[] args) {
        int a = Integer.MAX_VALUE;
        int b = -1;

        // ❌ 相減：溢位得到錯誤的符號
        System.out.println(a - b);                    // -2147483648（負數！）
        System.out.println((a - b) > 0 ? "a > b" : "a <= b");   // a <= b  💥 錯了

        // ✅ Integer.compare
        System.out.println(Integer.compare(a, b));    // 1
        System.out.println(Integer.compare(a, b) > 0 ? "a > b" : "a <= b");  // a > b  ✅
    }
}
```

> 這個 bug 會讓排序結果錯亂，且**只在資料出現極端值時發生**——所以測試通常抓不到。
> **一律用 `Integer.compare` / `Long.compare` / `Double.compare`。**

### `Comparator`：外部定義的排序規則

```java
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class ComparatorDemo {

    record Employee(String name, String department, int salary, LocalDate hiredAt) { }

    public static void main(String[] args) {
        List<Employee> employees = new ArrayList<>(List.of(
                new Employee("小明", "工程", 80_000, LocalDate.of(2020, 3, 1)),
                new Employee("小華", "工程", 95_000, LocalDate.of(2019, 7, 15)),
                new Employee("小美", "業務", 80_000, LocalDate.of(2021, 1, 10)),
                new Employee("小強", "業務", 70_000, LocalDate.of(2018, 5, 20)),
                new Employee("小玉", "工程", 95_000, LocalDate.of(2022, 9, 1))));

        // ① 單一欄位
        employees.sort(Comparator.comparing(Employee::name));
        print("依姓名", employees);

        // ② 數值欄位用 comparingInt / comparingLong / comparingDouble（避免裝箱）
        employees.sort(Comparator.comparingInt(Employee::salary));
        print("依薪水（低→高）", employees);

        // ③ 反向
        employees.sort(Comparator.comparingInt(Employee::salary).reversed());
        print("依薪水（高→低）", employees);

        // ④ 多欄位：部門 → 薪水降序 → 入職日
        employees.sort(Comparator.comparing(Employee::department)
                .thenComparing(Comparator.comparingInt(Employee::salary).reversed())
                .thenComparing(Employee::hiredAt));
        print("部門 → 薪水降序 → 入職日", employees);

        // ⑤ 自訂規則：工程部優先
        employees.sort(Comparator.comparing((Employee e) ->
                        e.department().equals("工程") ? 0 : 1)
                .thenComparing(Employee::name));
        print("工程部優先", employees);
    }

    static void print(String title, List<Employee> list) {
        System.out.println("=== " + title + " ===");
        list.forEach(e -> System.out.printf("  %-4s %-4s %6d %s%n",
                e.name(), e.department(), e.salary(), e.hiredAt()));
    }
}
```

輸出（節錄第 ④ 組）：

```
=== 部門 → 薪水降序 → 入職日 ===
  小華   工程    95000 2019-07-15
  小玉   工程    95000 2022-09-01
  小明   工程    80000 2020-03-01
  小美   業務    80000 2021-01-10
  小強   業務    70000 2018-05-20
```

### `null` 的處理

```java
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class NullSafeComparator {

    record Product(String name, Integer price) { }      // price 可能是 null

    public static void main(String[] args) {
        List<Product> products = new ArrayList<>(List.of(
                new Product("鍵盤", 2990),
                new Product("待定商品", null),
                new Product("滑鼠", 890),
                new Product("未定價", null)));

        // ❌ 直接比較會 NPE
        // products.sort(Comparator.comparing(Product::price));

        // ✅ null 排在前面
        products.sort(Comparator.comparing(Product::price,
                Comparator.nullsFirst(Comparator.naturalOrder())));
        System.out.println("nullsFirst: " + products);

        // ✅ null 排在後面（通常是使用者要的：有價格的商品先顯示）
        products.sort(Comparator.comparing(Product::price,
                Comparator.nullsLast(Comparator.naturalOrder())));
        System.out.println("nullsLast : " + products);

        // ✅ 整個物件可能是 null
        List<Product> withNulls = new ArrayList<>(products);
        withNulls.add(null);
        withNulls.sort(Comparator.nullsLast(
                Comparator.comparing(Product::price,
                        Comparator.nullsLast(Comparator.naturalOrder()))));
        System.out.println("整體 nullsLast: " + withNulls);
    }
}
```

### 排序的兩個實務注意事項

```java
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class SortingCaveats {

    record Item(String name, int priority) { }

    public static void main(String[] args) {

        // ① Java 的排序是「穩定的」：相等元素保持原有相對順序
        List<Item> items = new ArrayList<>(List.of(
                new Item("A", 1), new Item("B", 2), new Item("C", 1), new Item("D", 2)));
        items.sort(Comparator.comparingInt(Item::priority));
        System.out.println(items);
        // [Item[name=A, priority=1], Item[name=C, priority=1],
        //  Item[name=B, priority=2], Item[name=D, priority=2]]
        // A 在 C 前、B 在 D 前，都維持了原順序

        // ② sort() 會修改原 list！不要在方法裡偷排序呼叫者的資料（第 01 章 1.14 節）
        List<Integer> caller = new ArrayList<>(List.of(3, 1, 2));
        sortBad(caller);
        System.out.println("被偷排序了: " + caller);      // [1, 2, 3]

        List<Integer> caller2 = new ArrayList<>(List.of(3, 1, 2));
        System.out.println("回傳新的: " + sortGood(caller2));   // [1, 2, 3]
        System.out.println("原本不變: " + caller2);              // [3, 1, 2]
    }

    static void sortBad(List<Integer> list) {
        list.sort(null);                       // null 表示用自然順序
    }

    static List<Integer> sortGood(List<Integer> list) {
        List<Integer> copy = new ArrayList<>(list);
        copy.sort(null);
        return copy;
    }
}
```

> ⚠️ **`Comparator` 必須符合「傳遞性」與「反對稱性」**，否則 `sort()` 會丟
> `IllegalArgumentException: Comparison method violates its general contract!`。
> 最常見的成因就是用相減造成溢位，或是比較邏輯裡有隨機性/可變狀態。

---

## 5.11 `Queue` / `Deque` / `PriorityQueue`

```java
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedList;
import java.util.Queue;

public class QueueBasics {
    public static void main(String[] args) {

        // Queue：FIFO（先進先出）
        Queue<String> queue = new ArrayDeque<>();
        queue.offer("A");            // 加到尾端（滿了回 false，不丟例外）
        queue.offer("B");
        queue.offer("C");
        System.out.println(queue.peek());       // A（看不移除；空的回 null）
        System.out.println(queue.poll());       // A（取出並移除；空的回 null）
        System.out.println(queue);              // [B, C]

        // 兩組 API 的差別：一組回傳特殊值，一組丟例外
        // offer/poll/peek  → 失敗回傳 false/null    ✅ 通常用這組
        // add/remove/element → 失敗丟例外

        // Deque：雙端佇列，可以當 Queue 也可以當 Stack
        Deque<String> deque = new ArrayDeque<>();
        deque.addFirst("A");
        deque.addLast("B");
        deque.addFirst("Z");
        System.out.println(deque);               // [Z, A, B]
        System.out.println(deque.pollFirst());   // Z
        System.out.println(deque.pollLast());    // B

        // 當 Stack（LIFO）用
        Deque<Integer> stack = new ArrayDeque<>();
        stack.push(1);        // 等於 addFirst
        stack.push(2);
        stack.push(3);
        System.out.println(stack.pop());         // 3（等於 pollFirst）
        System.out.println(stack.peek());        // 2
    }
}
```

### 不要用 `Stack` 和 `Vector`

```java
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Stack;

public class DontUseStack {
    public static void main(String[] args) {
        // ❌ java.util.Stack：繼承 Vector，每個方法都 synchronized（不必要的鎖）
        //    而且它的迭代順序是「從底部往上」，跟 pop 的順序相反 → 極容易搞錯
        Stack<Integer> old = new Stack<>();
        old.push(1); old.push(2); old.push(3);
        System.out.println("Stack 迭代順序: " + old);     // [1, 2, 3]  ← 但 pop 是 3, 2, 1
        System.out.println("pop: " + old.pop());          // 3

        // ✅ ArrayDeque：更快，迭代順序與 pop 順序一致
        Deque<Integer> modern = new ArrayDeque<>();
        modern.push(1); modern.push(2); modern.push(3);
        System.out.println("ArrayDeque 迭代順序: " + modern);   // [3, 2, 1]  ← 與 pop 一致
        System.out.println("pop: " + modern.pop());             // 3
    }
}
```

**`Stack` / `Vector` / `Hashtable` 都是 Java 1.0 的遺物**，全部方法 `synchronized`（單執行緒也付代價），
且 API 設計不佳。現代替代品：

| 過時 | 用這個 |
|---|---|
| `Stack` | `ArrayDeque` |
| `Vector` | `ArrayList`（或 `CopyOnWriteArrayList` 若需執行緒安全） |
| `Hashtable` | `HashMap`（或 `ConcurrentHashMap`） |

### `PriorityQueue`：依優先度取出

```java
import java.util.Comparator;
import java.util.PriorityQueue;

public class PriorityQueueDemo {

    record Task(String name, int priority, long createdAt) { }

    public static void main(String[] args) {
        // 優先度小的先出，相同優先度時先建立的先出
        PriorityQueue<Task> queue = new PriorityQueue<>(
                Comparator.comparingInt(Task::priority)
                        .thenComparingLong(Task::createdAt));

        queue.offer(new Task("寄送電子報", 3, 1000));
        queue.offer(new Task("處理付款", 1, 2000));
        queue.offer(new Task("產生報表", 2, 3000));
        queue.offer(new Task("退款", 1, 1500));

        // ⚠️ 直接印出「不是」排序後的順序！內部是二元堆積，不是排序陣列
        System.out.println("toString: " + queue);

        System.out.println("取出順序:");
        while (!queue.isEmpty()) {
            Task t = queue.poll();
            System.out.printf("  P%d %s%n", t.priority(), t.name());
        }
    }
}
```

輸出：

```
toString: [Task[name=退款, priority=1, createdAt=1500], Task[name=處理付款, ...], ...]

取出順序:
  P1 退款
  P1 處理付款
  P2 產生報表
  P3 寄送電子報
```

**`PriorityQueue` 的三個必知細節：**

1. **只保證 `poll()` 的順序，不保證迭代順序。** 想要「印出排序後的全部」，要 `poll()` 到空，
   或用 `TreeSet` / 先 `sort()`。
2. **不是執行緒安全的**。多執行緒要用 `PriorityBlockingQueue`（第 08 章）。
3. `peek()` 只看得到「最優先的那一個」，看不到第二名。

> **實務案例**：任務排程、Dijkstra 最短路徑、合併 K 個排序串流、
> 「取前 N 名」（維持一個大小為 N 的最小堆積，比全部排序快）。

---

## 5.12 泛型

### 為什麼需要泛型

```java
import java.util.ArrayList;
import java.util.List;

public class WhyGenerics {
    public static void main(String[] args) {
        // ❌ Java 5 之前：沒有泛型，什麼都能放，取出時要轉型
        List raw = new ArrayList();
        raw.add("字串");
        raw.add(42);                    // 編譯器不管
        raw.add(new Object());

        try {
            String s = (String) raw.get(1);     // 執行時才爆
        } catch (ClassCastException e) {
            System.out.println("ClassCastException: " + e.getMessage());
        }

        // ✅ 有泛型：錯誤在編譯期就被抓到
        List<String> typed = new ArrayList<>();
        typed.add("字串");
        // typed.add(42);               // ❌ 編譯錯誤
        String s = typed.get(0);        // 不需要轉型
        System.out.println(s);
    }
}
```

**泛型的價值：把「型別錯誤」從執行期提前到編譯期。**

### 泛型類別與方法

```java
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

public class GenericBasics {

    /** 泛型類別 */
    static class Box<T> {
        private T content;

        void put(T content) { this.content = content; }
        T get() { return content; }
        boolean isEmpty() { return content == null; }
    }

    /** 多個型別參數 */
    static class Pair<K, V> {
        private final K key;
        private final V value;

        Pair(K key, V value) { this.key = key; this.value = value; }

        K getKey() { return key; }
        V getValue() { return value; }

        /** 交換 K 和 V */
        Pair<V, K> swap() { return new Pair<>(value, key); }

        @Override
        public String toString() { return "(" + key + ", " + value + ")"; }
    }

    /** 泛型方法：<T> 寫在回傳型別之前 */
    static <T> List<T> repeat(T element, int times) {
        List<T> result = new ArrayList<>(times);
        for (int i = 0; i < times; i++) result.add(element);
        return result;
    }

    /** 有界型別參數：T 必須實作 Comparable */
    static <T extends Comparable<T>> T max(List<T> list) {
        if (list.isEmpty()) {
            throw new IllegalArgumentException("清單不可為空");
        }
        T best = list.get(0);
        for (T item : list) {
            if (item.compareTo(best) > 0) best = item;
        }
        return best;
    }

    /** 多重界限：T 必須同時滿足兩個條件（類別要放第一個） */
    static <T extends Number & Comparable<T>> T maxNumber(List<T> list) {
        return max(list);
    }

    public static void main(String[] args) {
        Box<String> box = new Box<>();
        box.put("hello");
        System.out.println(box.get());                          // hello

        Pair<String, Integer> pair = new Pair<>("age", 30);
        System.out.println(pair);                                // (age, 30)
        System.out.println(pair.swap());                         // (30, age)

        System.out.println(repeat("x", 3));                      // [x, x, x]
        System.out.println(max(List.of(3, 7, 2)));               // 7
        System.out.println(max(List.of("banana", "apple")));     // banana
        System.out.println(maxNumber(List.of(1.5, 2.7, 0.3)));   // 2.7
    }
}
```

### 型別參數的命名慣例

| 字母 | 意義 |
|---|---|
| `T` | Type（一般型別） |
| `E` | Element（集合元素） |
| `K` / `V` | Key / Value |
| `R` | Result（回傳型別） |
| `S` / `U` | 第二、第三個型別 |

### 萬用字元與 PECS

先看問題：

```java
import java.util.ArrayList;
import java.util.List;

public class WhyWildcard {

    static double sumBad(List<Number> numbers) {
        double sum = 0;
        for (Number n : numbers) sum += n.doubleValue();
        return sum;
    }

    public static void main(String[] args) {
        List<Integer> ints = new ArrayList<>(List.of(1, 2, 3));

        // ❌ 編譯錯誤！List<Integer> 不是 List<Number> 的子型別
        // System.out.println(sumBad(ints));
    }
}
```

**為什麼 `List<Integer>` 不是 `List<Number>`？** 因為如果可以，就會出現：

```java
List<Integer> ints = new ArrayList<>();
List<Number> nums = ints;        // 假設這行合法
nums.add(3.14);                  // 放進一個 Double
Integer i = ints.get(0);         // 💥 ClassCastException
```

**解法：萬用字元。**

```java
import java.util.ArrayList;
import java.util.List;

public class Wildcards {

    /** ? extends Number：「Number 或其任何子型別的 List」——可以「讀」 */
    static double sum(List<? extends Number> numbers) {
        double total = 0;
        for (Number n : numbers) {      // ✅ 讀出來一定是 Number
            total += n.doubleValue();
        }
        // numbers.add(1);              // ❌ 不能寫入！編譯器不知道實際型別是什麼
        return total;
    }

    /** ? super Integer：「Integer 或其任何父型別的 List」——可以「寫」 */
    static void addNumbers(List<? super Integer> target) {
        target.add(1);                  // ✅ 可以寫入 Integer
        target.add(2);
        // Integer i = target.get(0);    // ❌ 讀出來只能當 Object
        Object o = target.get(0);       // ✅
    }

    /** 無界萬用字元：只在乎「是個 List」，不在乎元素型別 */
    static int size(List<?> list) {
        // list.add(anything);          // ❌ 什麼都不能加（除了 null）
        return list.size();
    }

    public static void main(String[] args) {
        System.out.println(sum(List.of(1, 2, 3)));            // 6.0（List<Integer>）
        System.out.println(sum(List.of(1.5, 2.5)));           // 4.0（List<Double>）
        System.out.println(sum(List.of(1L, 2L)));             // 3.0（List<Long>）

        List<Number> numbers = new ArrayList<>();
        addNumbers(numbers);                                   // Number 是 Integer 的父型別
        System.out.println(numbers);                           // [1, 2]

        List<Object> objects = new ArrayList<>();
        addNumbers(objects);                                   // Object 也是
        System.out.println(objects);                           // [1, 2]

        System.out.println(size(List.of("a", "b")));           // 2
    }
}
```

### PECS：記住這個口訣

> **P**roducer **E**xtends, **C**onsumer **S**uper
>
> - 集合是**生產者**（你從裡面**讀**東西） → `? extends T`
> - 集合是**消費者**（你往裡面**寫**東西） → `? super T`
> - 兩者都要 → 用具體型別 `List<T>`

```java
import java.util.ArrayList;
import java.util.List;

public class PecsDemo {

    /**
     * 經典例子：JDK 的 Collections.copy 就是這個簽章
     * src 是生產者（讀）→ extends
     * dest 是消費者（寫）→ super
     */
    static <T> void copy(List<? extends T> src, List<? super T> dest) {
        for (T item : src) {
            dest.add(item);
        }
    }

    /** 只讀 → extends */
    static double average(List<? extends Number> numbers) {
        if (numbers.isEmpty()) return 0;
        double sum = 0;
        for (Number n : numbers) sum += n.doubleValue();
        return sum / numbers.size();
    }

    /** 只寫 → super */
    static void fillWithZeros(List<? super Integer> target, int count) {
        for (int i = 0; i < count; i++) target.add(0);
    }

    public static void main(String[] args) {
        List<Integer> source = List.of(1, 2, 3);
        List<Number> target = new ArrayList<>();
        copy(source, target);
        System.out.println(target);                    // [1, 2, 3]

        System.out.println(average(List.of(1, 2, 3, 4)));       // 2.5
        System.out.println(average(List.of(1.5, 2.5)));         // 2.0

        List<Object> objects = new ArrayList<>();
        fillWithZeros(objects, 3);
        System.out.println(objects);                    // [0, 0, 0]
    }
}
```

**實務上你什麼時候會需要它？**

寫**給別人用的 API** 時。方法參數用 `? extends T` 能接受更多型別的集合，讓 API 更好用：

```java
// ❌ 呼叫方只能傳 List<Order>，傳 List<PriorityOrder> 會編譯錯誤
public BigDecimal totalAmount(List<Order> orders) { }

// ✅ 兩種都能傳
public BigDecimal totalAmount(List<? extends Order> orders) { }
```

第 06 章會看到 `Stream.map(Function<? super T, ? extends R>)` ——這個簽章就是 PECS 的實踐。

### 型別抹除與它的三個後果

**Java 的泛型是編譯期的**。編譯後，型別參數會被「抹除」成 `Object`（或界限型別）。

```java
import java.util.ArrayList;
import java.util.List;

public class TypeErasure {
    public static void main(String[] args) {

        // 後果 1：執行時無法區分 List<String> 和 List<Integer>
        List<String> strings = new ArrayList<>();
        List<Integer> ints = new ArrayList<>();
        System.out.println(strings.getClass() == ints.getClass());   // true！
        System.out.println(strings.getClass().getName());            // java.util.ArrayList

        // 也因此不能這樣寫
        // if (obj instanceof List<String>) { }      // ❌ 編譯錯誤
        if (strings instanceof List<?>) {            // ✅ 只能用無界萬用字元
            System.out.println("是個 List");
        }
    }

    // 後果 2：不能重載「只有泛型參數不同」的方法（抹除後簽章相同）
    // static void process(List<String> list) { }
    // static void process(List<Integer> list) { }   // ❌ 編譯錯誤

    // 後果 3：不能 new T[] 或 new T()
    static <T> void cannotDo(int size) {
        // T[] array = new T[size];              // ❌
        // T instance = new T();                 // ❌

        @SuppressWarnings("unchecked")
        T[] workaround = (T[]) new Object[size];  // 可行但不優雅
    }

    // 後果 3 的正確做法：傳入 Class<T> 或工廠
    static <T> T create(java.util.function.Supplier<T> factory) {
        return factory.get();
    }

    static <T> T[] createArray(Class<T> type, int size) {
        @SuppressWarnings("unchecked")
        T[] array = (T[]) java.lang.reflect.Array.newInstance(type, size);
        return array;
    }
}
```

**另一個後果：泛型不能用基本型別。**

```java
// List<int> list;          // ❌
List<Integer> list;         // ✅ 只能用包裝型別

// 這也是為什麼有 IntStream / LongStream / DoubleStream（第 06 章）
// 以及為什麼 Comparator 有 comparingInt / comparingLong / comparingDouble
```

### 如何取得泛型的實際型別（進階）

型別抹除有一個例外：**類別、欄位、方法簽章上的泛型資訊會保留在位元碼裡**（供反射讀取）。
這就是 Jackson 能反序列化 `List<Order>` 的原理。

```java
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.List;

public class TypeToken {

    /** 匿名子類別讓泛型參數被記錄在類別簽章上 */
    static abstract class TypeReference<T> {
        private final Type type;

        protected TypeReference() {
            Type superClass = getClass().getGenericSuperclass();
            this.type = ((ParameterizedType) superClass).getActualTypeArguments()[0];
        }

        public Type getType() { return type; }
    }

    public static void main(String[] args) {
        // 注意結尾的 {}：建立一個匿名子類別
        var ref = new TypeReference<List<String>>() { };
        System.out.println(ref.getType());        // java.util.List<java.lang.String>
    }
}
```

> 這就是 Jackson 的 `new TypeReference<List<Order>>() {}` 和 Spring 的 `ParameterizedTypeReference`
> 的實作原理。第 05 站呼叫外部 API 時會用到。

---

## 5.13 併發集合概觀

```java
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.List;

public class ConcurrentCollections {
    public static void main(String[] args) {

        // ❌ HashMap 在多執行緒下：可能資料遺失、size 不對，
        //    Java 7 甚至可能因為擴容時的循環連結導致 CPU 100%
        Map<String, Integer> unsafe = new HashMap<>();

        // ⚠️ 舊做法：整個 Map 一把鎖，併發效能差
        Map<String, Integer> synced = Collections.synchronizedMap(new HashMap<>());

        // ✅ ConcurrentHashMap：分段鎖 / CAS，讀取幾乎無鎖
        Map<String, Integer> concurrent = new ConcurrentHashMap<>();
        concurrent.put("a", 1);
        concurrent.merge("a", 1, Integer::sum);          // 原子操作
        concurrent.computeIfAbsent("b", k -> 2);         // 原子操作
        System.out.println(concurrent);                   // {a=2, b=2}

        // ✅ CopyOnWriteArrayList：每次寫入都拷貝整個陣列
        //    適合「讀多寫極少」（如監聽器清單、設定快取）
        List<String> listeners = new CopyOnWriteArrayList<>();
        listeners.add("listener1");
        // 迭代時不會 ConcurrentModificationException（迭代的是拍下的快照）
        for (String l : listeners) {
            listeners.add("added-during-iteration");     // 不會爆，但這一輪看不到新增的
            break;
        }
        System.out.println(listeners.size());             // 2
    }
}
```

| 集合 | 執行緒安全的替代品 | 適用場景 |
|---|---|---|
| `HashMap` | `ConcurrentHashMap` | 一般併發存取 |
| `ArrayList` | `CopyOnWriteArrayList` | 讀多寫極少 |
| `TreeMap` | `ConcurrentSkipListMap` | 需要排序的併發 Map |
| `ArrayDeque` | `ConcurrentLinkedDeque` / `LinkedBlockingDeque` | 生產者-消費者 |
| `PriorityQueue` | `PriorityBlockingQueue` | 併發任務排程 |

> ⚠️ **`ConcurrentHashMap` 的「原子性」只在單一方法內**：
>
> ```java
> // ❌ 不是原子的！兩個執行緒可能同時看到 null，都執行 put
> if (map.get(key) == null) {
>     map.put(key, compute());
> }
>
> // ✅ 用原子方法
> map.computeIfAbsent(key, k -> compute());
> ```
>
> 第 08 章會完整處理併發，這裡只要記住「多執行緒不要用 `HashMap`」。

---

## 5.14 集合選型決策表

```
需要「鍵 → 值」對應？
├─ 是 → key 是 enum？        → EnumMap
│       需要依 key 排序？      → TreeMap
│       需要保留插入順序？      → LinkedHashMap
│       需要 LRU 淘汰？        → LinkedHashMap(accessOrder=true)
│       多執行緒？             → ConcurrentHashMap
│       否則                  → HashMap  ★ 預設
│
└─ 否 → 需要「不重複」？
        ├─ 是 → 元素是 enum？      → EnumSet
        │       需要排序 / 範圍查詢？ → TreeSet
        │       需要保留插入順序？    → LinkedHashSet
        │       否則                → HashSet  ★ 預設
        │
        └─ 否 → 需要「先進先出 / 後進先出」？
                ├─ 是 → 需要依優先度取出？    → PriorityQueue
                │       需要阻塞（生產者消費者）→ LinkedBlockingQueue（第 08 章）
                │       否則                 → ArrayDeque  ★（別用 Stack）
                │
                └─ 否 → 讀多寫極少 + 多執行緒？ → CopyOnWriteArrayList
                        否則                   → ArrayList  ★ 預設
```

**四個「預設答案」**：`ArrayList`、`HashMap`、`HashSet`、`ArrayDeque`。
90% 的情況就是這四個，其餘都是「有特殊需求才換」。

---

## 5.15 練習專案：用集合重構 Todo

第 03 / 04 章的 `TodoService` 有一堆 for 迴圈。現在加上標籤、索引與統計。

### `Todo.java`（第 04 章版本，加上標籤）

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;
import com.example.todo.exception.TodoAlreadyDoneException;

import java.time.LocalDateTime;
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
    private final LocalDateTime createdAt;
    private LocalDateTime completedAt;
    // LinkedHashSet：不重複 + 保留新增順序（顯示時比較穩定）
    private final Set<String> tags = new LinkedHashSet<>();

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

    public void complete(LocalDateTime when) {
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
        if (stripped.length() > MAX_TITLE_LENGTH) {
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
        String normalized = tag.strip().toLowerCase();       // 統一小寫，避免 "Work" / "work" 重複
        if (tags.size() >= MAX_TAGS && !tags.contains(normalized)) {
            throw new InvalidTodoException("tags", tags.size(),
                    "標籤最多 " + MAX_TAGS + " 個");
        }
        tags.add(normalized);
    }

    public boolean removeTag(String tag) {
        return tag != null && tags.remove(tag.strip().toLowerCase());
    }

    public boolean hasTag(String tag) {
        return tag != null && tags.contains(tag.strip().toLowerCase());
    }

    /** ✅ 回傳不可變拷貝，外部改不到內部集合（5.8 節） */
    public Set<String> getTags() { return Set.copyOf(tags); }

    public long getId() { return id; }
    public String getTitle() { return title; }
    public Priority getPriority() { return priority; }
    public boolean isDone() { return done; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public LocalDateTime getCompletedAt() { return completedAt; }

    public String toDisplayLine() {
        String tagPart = tags.isEmpty() ? "" : " " + tags;
        return "%s #%-3d [%s] %s%s".formatted(
                done ? "[x]" : "[ ]", id, priority.getLabel(), title, tagPart);
    }

    /**
     * ✅ equals/hashCode 只用 id：
     * title / priority / done / tags 都會變，用它們算 hash 會讓物件在 Map 裡「消失」（5.7 節）
     */
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
        return "Todo{id=%d, title='%s', priority=%s, done=%s, tags=%s}"
                .formatted(id, title, priority, done, tags);
    }
}
```

### `Priority.java`（第 04 章原樣搬來）

```java
package com.example.todo.model;

import com.example.todo.exception.InvalidTodoException;

import java.util.Arrays;
import java.util.stream.Collectors;

public enum Priority {

    URGENT(1, "緊急"),
    HIGH(2, "高"),
    NORMAL(3, "普通"),
    LOW(4, "低");

    private final int level;
    private final String label;

    Priority(int level, String label) {
        this.level = level;
        this.label = label;
    }

    public int getLevel() { return level; }

    public String getLabel() { return label; }

    public static Priority parse(String input) {
        if (input == null || input.isBlank()) {
            return NORMAL;
        }
        String normalized = input.strip().toUpperCase();
        for (Priority p : values()) {
            if (p.name().equals(normalized)) return p;
        }
        String allowed = Arrays.stream(values()).map(Enum::name).collect(Collectors.joining(", "));
        throw new InvalidTodoException("priority", input, "無效的優先度，可用值: " + allowed);
    }
}
```

### `IndexedTodoRepository.java`：加上標籤反向索引

```java
package com.example.todo.repository;

import com.example.todo.exception.TodoNotFoundException;
import com.example.todo.model.Priority;
import com.example.todo.model.Todo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * 加上索引的記憶體實作。
 * 重點在示範不同集合的選型：
 *   - LinkedHashMap：主資料，O(1) 查詢 + 保留插入順序
 *   - HashMap<String, Set<Long>>：標籤反向索引，O(1) 依標籤查詢
 *   - EnumMap<Priority, Set<Long>>：優先度索引，key 是 enum 用 EnumMap
 */
public class IndexedTodoRepository implements TodoRepository {

    private final Map<Long, Todo> byId = new LinkedHashMap<>();
    private final Map<String, Set<Long>> byTag = new HashMap<>();
    private final Map<Priority, Set<Long>> byPriority = new EnumMap<>(Priority.class);
    private long sequence = 0;

    @Override
    public Todo save(Todo todo) {
        Objects.requireNonNull(todo, "todo 不可為 null");

        // 更新前先移除舊索引（標籤/優先度可能被改過）
        Todo existing = byId.get(todo.getId());
        if (existing != null) {
            removeFromIndexes(existing);
        }

        byId.put(todo.getId(), todo);
        addToIndexes(todo);
        return todo;
    }

    private void addToIndexes(Todo todo) {
        for (String tag : todo.getTags()) {
            // computeIfAbsent：一行取代「取不到就建一個」的五行（5.6 節）
            byTag.computeIfAbsent(tag, k -> new HashSet<>()).add(todo.getId());
        }
        byPriority.computeIfAbsent(todo.getPriority(), k -> new HashSet<>()).add(todo.getId());
    }

    private void removeFromIndexes(Todo todo) {
        for (String tag : todo.getTags()) {
            Set<Long> ids = byTag.get(tag);
            if (ids != null) {
                ids.remove(todo.getId());
                // ✅ 空集合要移除，否則 byTag 會無限成長（記憶體洩漏，第 09 章）
                if (ids.isEmpty()) byTag.remove(tag);
            }
        }
        Set<Long> ids = byPriority.get(todo.getPriority());
        if (ids != null) {
            ids.remove(todo.getId());
            if (ids.isEmpty()) byPriority.remove(todo.getPriority());
        }
    }

    @Override
    public Optional<Todo> findById(long id) {
        return Optional.ofNullable(byId.get(id));
    }

    @Override
    public List<Todo> findAll() {
        return List.copyOf(byId.values());
    }

    @Override
    public boolean deleteById(long id) {
        Todo removed = byId.remove(id);
        if (removed == null) return false;
        removeFromIndexes(removed);
        return true;
    }

    @Override
    public long nextId() { return ++sequence; }

    /** ✅ O(1)：直接從索引拿 id，不用掃全部 */
    public List<Todo> findByTag(String tag) {
        if (tag == null) return List.of();
        Set<Long> ids = byTag.getOrDefault(tag.strip().toLowerCase(), Set.of());
        List<Todo> result = new ArrayList<>(ids.size());
        for (Long id : ids) {
            Todo todo = byId.get(id);
            if (todo != null) result.add(todo);
        }
        return result;
    }

    public List<Todo> findByPriority(Priority priority) {
        Set<Long> ids = byPriority.getOrDefault(priority, Set.of());
        List<Todo> result = new ArrayList<>(ids.size());
        for (Long id : ids) {
            Todo todo = byId.get(id);
            if (todo != null) result.add(todo);
        }
        return result;
    }

    /** 所有使用中的標籤（依字母排序，給 CLI 顯示） */
    public Set<String> allTags() {
        return Collections.unmodifiableSet(new java.util.TreeSet<>(byTag.keySet()));
    }

    /** 每個標籤的使用次數 */
    public Map<String, Integer> tagCounts() {
        Map<String, Integer> counts = new java.util.TreeMap<>();     // TreeMap → 依標籤排序
        byTag.forEach((tag, ids) -> counts.put(tag, ids.size()));
        return counts;
    }
}
```

### `TodoStatistics.java`：用集合做統計

```java
package com.example.todo.service;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

public class TodoStatistics {

    private final List<Todo> todos;

    public TodoStatistics(List<Todo> todos) {
        this.todos = List.copyOf(todos);          // 防禦性拷貝
    }

    /** 依優先度統計數量（EnumMap，key 是 enum） */
    public Map<Priority, Integer> countByPriority() {
        Map<Priority, Integer> result = new EnumMap<>(Priority.class);
        for (Todo todo : todos) {
            result.merge(todo.getPriority(), 1, Integer::sum);      // merge：計數器標準寫法
        }
        return result;
    }

    /** 依完成狀態分組 */
    public Map<Boolean, List<Todo>> partitionByDone() {
        Map<Boolean, List<Todo>> result = new HashMap<>();
        result.put(true, new ArrayList<>());
        result.put(false, new ArrayList<>());
        for (Todo todo : todos) {
            result.get(todo.isDone()).add(todo);
        }
        return result;
    }

    /** 標籤使用次數，依次數降序（次數相同時依標籤名） */
    public List<Map.Entry<String, Integer>> topTags(int limit) {
        Map<String, Integer> counts = new HashMap<>();
        for (Todo todo : todos) {
            for (String tag : todo.getTags()) {
                counts.merge(tag, 1, Integer::sum);
            }
        }
        List<Map.Entry<String, Integer>> entries = new ArrayList<>(counts.entrySet());
        entries.sort(Map.Entry.<String, Integer>comparingByValue().reversed()
                .thenComparing(Map.Entry.comparingByKey()));
        return entries.subList(0, Math.min(limit, entries.size()));
    }

    /** 依建立日期分組（TreeMap → 日期自動排序） */
    public Map<java.time.LocalDate, Integer> countByDate() {
        Map<java.time.LocalDate, Integer> result = new TreeMap<>();
        for (Todo todo : todos) {
            result.merge(todo.getCreatedAt().toLocalDate(), 1, Integer::sum);
        }
        return result;
    }

    /** 未完成的待辦，依優先度 → 建立時間排序（最該做的排最前面） */
    public List<Todo> pendingSorted() {
        List<Todo> pending = new ArrayList<>();
        for (Todo todo : todos) {
            if (!todo.isDone()) pending.add(todo);
        }
        pending.sort(Comparator
                .comparingInt((Todo t) -> t.getPriority().getLevel())   // 數字小 = 優先度高
                .thenComparing(Todo::getCreatedAt));
        return pending;
    }

    public double completionRate() {
        if (todos.isEmpty()) return 0.0;
        long done = todos.stream().filter(Todo::isDone).count();
        return (double) done / todos.size() * 100;
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
import java.util.Map;

public class CollectionsDemo {
    public static void main(String[] args) {
        IndexedTodoRepository repo = new IndexedTodoRepository();

        LocalDateTime base = LocalDateTime.of(2026, 8, 15, 9, 0);

        Todo t1 = new Todo(repo.nextId(), "寫第 05 章", Priority.URGENT, base);
        t1.addTag("寫作"); t1.addTag("java");
        repo.save(t1);

        Todo t2 = new Todo(repo.nextId(), "Code review", Priority.HIGH, base.plusHours(1));
        t2.addTag("java"); t2.addTag("團隊");
        repo.save(t2);

        Todo t3 = new Todo(repo.nextId(), "買咖啡", Priority.LOW, base.plusDays(1));
        t3.addTag("生活");
        repo.save(t3);

        Todo t4 = new Todo(repo.nextId(), "重構 Repository", Priority.HIGH, base.plusDays(1).plusHours(2));
        t4.addTag("java"); t4.addTag("重構");
        repo.save(t4);

        Todo t5 = new Todo(repo.nextId(), "回信", Priority.NORMAL, base.plusDays(2));
        t5.addTag("團隊");
        t5.complete(base.plusDays(2).plusHours(1));
        repo.save(t5);

        System.out.println("=== 全部 ===");
        repo.findAll().forEach(t -> System.out.println("  " + t.toDisplayLine()));

        System.out.println("\n=== 依標籤 java（O(1) 索引查詢）===");
        repo.findByTag("java").forEach(t -> System.out.println("  " + t.toDisplayLine()));

        System.out.println("\n=== 依優先度 HIGH ===");
        repo.findByPriority(Priority.HIGH).forEach(t -> System.out.println("  " + t.toDisplayLine()));

        System.out.println("\n=== 所有標籤（TreeSet 排序）===");
        System.out.println("  " + repo.allTags());

        System.out.println("\n=== 標籤使用次數 ===");
        repo.tagCounts().forEach((tag, count) -> System.out.printf("  %-6s %d%n", tag, count));

        TodoStatistics stats = new TodoStatistics(repo.findAll());

        System.out.println("\n=== 依優先度統計（EnumMap 順序 = enum 宣告順序）===");
        stats.countByPriority().forEach((p, c) -> System.out.printf("  %-4s %d%n", p.getLabel(), c));

        System.out.println("\n=== 依日期統計（TreeMap 自動排序）===");
        stats.countByDate().forEach((d, c) -> System.out.printf("  %s  %d%n", d, c));

        System.out.println("\n=== 待處理（優先度 → 建立時間）===");
        stats.pendingSorted().forEach(t -> System.out.println("  " + t.toDisplayLine()));

        System.out.println("\n=== 熱門標籤 Top 3 ===");
        stats.topTags(3).forEach(e -> System.out.printf("  %-6s %d 次%n", e.getKey(), e.getValue()));

        System.out.printf("%n完成率: %.1f%%%n", stats.completionRate());

        System.out.println("\n=== 驗證索引在刪除後正確維護 ===");
        System.out.println("  刪除前 java 標籤: " + repo.findByTag("java").size() + " 筆");
        repo.deleteById(t4.getId());
        System.out.println("  刪除後 java 標籤: " + repo.findByTag("java").size() + " 筆");
        System.out.println("  重構標籤是否還在: " + repo.allTags().contains("重構"));
    }
}
```

輸出：

```
=== 全部 ===
  [ ] #1   [緊急] 寫第 05 章 [寫作, java]
  [ ] #2   [高] Code review [java, 團隊]
  [ ] #3   [低] 買咖啡 [生活]
  [ ] #4   [高] 重構 Repository [java, 重構]
  [x] #5   [普通] 回信 [團隊]

=== 依標籤 java（O(1) 索引查詢）===
  [ ] #1   [緊急] 寫第 05 章 [寫作, java]
  [ ] #2   [高] Code review [java, 團隊]
  [ ] #4   [高] 重構 Repository [java, 重構]

=== 依優先度 HIGH ===
  [ ] #2   [高] Code review [java, 團隊]
  [ ] #4   [高] 重構 Repository [java, 重構]

=== 所有標籤（TreeSet 排序）===
  [java, 團隊, 寫作, 生活, 重構]

=== 標籤使用次數 ===
  java   3
  團隊    2
  寫作    1
  生活    1
  重構    1

=== 依優先度統計（EnumMap 順序 = enum 宣告順序）===
  緊急   1
  高    2
  普通   1
  低    1

=== 依日期統計（TreeMap 自動排序）===
  2026-08-15  2
  2026-08-16  2
  2026-08-17  1

=== 待處理（優先度 → 建立時間）===
  [ ] #1   [緊急] 寫第 05 章 [寫作, java]
  [ ] #2   [高] Code review [java, 團隊]
  [ ] #4   [高] 重構 Repository [java, 重構]
  [ ] #3   [低] 買咖啡 [生活]

=== 熱門標籤 Top 3 ===
  java   3 次
  團隊    2 次
  寫作    1 次

完成率: 20.0%

=== 驗證索引在刪除後正確維護 ===
  刪除前 java 標籤: 3 筆
  刪除後 java 標籤: 2 筆
  重構標籤是否還在: false
```

> ⚠️ **中文的 `TreeSet` / `TreeMap` 排序不是「筆劃」也不是「注音」**，而是 `String.compareTo` 的
> UTF-16 碼元順序（所以上面是 `團 → 寫 → 生 → 重`，看起來毫無邏輯）。
> 要按注音或筆劃排序，得用 `Collator`：
>
> ```java
> java.text.Collator collator = java.text.Collator.getInstance(java.util.Locale.TAIWAN);
> Set<String> byPinyin = new TreeSet<>(collator);
> ```
>
> 這是「使用者抱怨排序很亂」的常見原因。第 07 章講國際化時會再回到 `Locale` 與 `Collator`。

### 這一版用到的每一個集合，都有理由

| 用途 | 集合 | 理由 |
|---|---|---|
| 主資料 | `LinkedHashMap<Long, Todo>` | O(1) 查詢 + `findAll()` 順序穩定 |
| 標籤反向索引 | `HashMap<String, Set<Long>>` | O(1) 依標籤查詢，取代 O(n) 全表掃描 |
| 索引的值 | `HashSet<Long>` | 不重複、O(1) 增刪 |
| 優先度索引 | `EnumMap<Priority, Set<Long>>` | key 是 enum → 內部陣列，最快最省 |
| Todo 的標籤 | `LinkedHashSet<String>` | 不重複 + 保留新增順序 |
| 顯示所有標籤 | `TreeSet<String>` | 自動字母排序 |
| 依標籤排序統計 | `TreeMap<String, Integer>` | 同上 |
| 日期統計 | `TreeMap<LocalDate, Integer>` | 日期自動排序 |
| 對外回傳 | `List.copyOf` / `Set.copyOf` | 防禦性拷貝 |

> **下一章的預告**：`TodoStatistics` 裡的每個方法都是「建一個集合 → for 迴圈 → merge / add」。
> 第 06 章會用 `Collectors.groupingBy` / `counting` / `partitioningBy` 把它們各壓成一行。

---

## 5.16 常見錯誤

| # | 錯誤 | 修法 |
|---|---|---|
| 1 | 只覆寫 `equals` 沒覆寫 `hashCode` | 一起覆寫，用同一組欄位 |
| 2 | 用可變物件當 `Map` key | 用不可變物件，或只用 id 算 hash |
| 3 | `for-each` 中修改集合 | `removeIf` 或 `Iterator.remove` |
| 4 | `Arrays.asList(...)` 之後 `add` | `new ArrayList<>(List.of(...))` |
| 5 | 用 `Collections.unmodifiableList` 存進欄位 | `List.copyOf` |
| 6 | `list.remove(intValue)` 誤刪索引 | `removeIf` 或 `remove(Integer.valueOf(x))` |
| 7 | `compareTo` 用相減 | `Integer.compare` |
| 8 | `LinkedList` + `get(i)` 迴圈 | 用 `ArrayList`，或改 for-each |
| 9 | 多執行緒用 `HashMap` | `ConcurrentHashMap` |
| 10 | 用 `Stack` / `Vector` / `Hashtable` | `ArrayDeque` / `ArrayList` / `HashMap` |
| 11 | 假設 `HashMap` / `HashSet` 有順序 | 需要順序就用 `LinkedHashMap` / `TreeMap` |
| 12 | 反向索引的空集合不移除 | `if (set.isEmpty()) map.remove(key)` |
| 13 | 回傳 `subList` 視圖給呼叫方 | 包成 `new ArrayList<>(...)` |
| 14 | 以為 `PriorityQueue` 的迭代是排序的 | 只有 `poll()` 保證順序 |

---

## 5.17 本章練習

### 練習 1：找出所有問題

```java
public class Buggy {
    public static void main(String[] args) {
        List<String> list = Arrays.asList("a", "b", "c");
        list.add("d");

        List<Integer> nums = new ArrayList<>(List.of(10, 20, 30));
        nums.remove(20);

        for (String s : list) {
            if (s.equals("b")) list.remove(s);
        }

        Map<Point, String> map = new HashMap<>();
        Point p = new Point(1, 2);
        map.put(p, "第一個");
        p.x = 99;
        System.out.println(map.get(p));

        List<Employee> emps = getEmployees();
        emps.sort((a, b) -> a.getSalary() - b.getSalary());
    }

    static class Point {
        int x, y;
        Point(int x, int y) { this.x = x; this.y = y; }
        @Override public boolean equals(Object o) {
            return o instanceof Point p && p.x == x && p.y == y;
        }
        @Override public int hashCode() { return Objects.hash(x, y); }
    }
}
```

<details>
<summary>參考解答</summary>

**六個問題：**

1. `Arrays.asList` 回傳固定大小的 List → `add` 丟 `UnsupportedOperationException`。
2. `nums.remove(20)` 選到 `remove(int index)` → 索引 20 越界 → `IndexOutOfBoundsException`。
3. `for-each` 中 `remove` → `ConcurrentModificationException`（或更糟：靜默跳過元素）。
4. `Point` 是**可變的**，放進 `HashMap` 後改 `p.x` → `hashCode` 變了 → `map.get(p)` 回傳 `null`，
   且那筆資料永遠拿不出來（5.7 節）。
5. `a.getSalary() - b.getSalary()` 相減可能溢位（5.10 節）。
6. `emps.sort(...)` 會修改 `getEmployees()` 回傳的集合——如果那是內部集合，呼叫方的資料被偷改了。

**修正版：**

```java
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class Fixed {

    /** ✅ 不可變的 key */
    record Point(int x, int y) { }        // record 自帶 equals/hashCode

    record Employee(String name, int salary) { }

    public static void main(String[] args) {

        // ① 需要可變 → 包一層 ArrayList
        List<String> list = new ArrayList<>(List.of("a", "b", "c"));
        list.add("d");
        System.out.println(list);                        // [a, b, c, d]

        // ② 依值移除 → removeIf（意圖明確，不會誤選重載）
        List<Integer> nums = new ArrayList<>(List.of(10, 20, 30));
        nums.removeIf(v -> v == 20);
        System.out.println(nums);                        // [10, 30]

        // ③ 迭代中移除 → removeIf
        list.removeIf(s -> s.equals("b"));
        System.out.println(list);                        // [a, c, d]

        // ④ key 不可變 → 沒有「改了就找不到」的問題
        Map<Point, String> map = new HashMap<>();
        Point p = new Point(1, 2);
        map.put(p, "第一個");
        System.out.println(map.get(p));                  // 第一個
        System.out.println(map.get(new Point(1, 2)));    // 第一個  ✅

        // 想「改」座標 → 建新物件（不可變的正確用法）
        Point moved = new Point(99, 2);
        System.out.println(map.get(moved));              // null（本來就該是不同的 key）

        // ⑤⑥ 用 comparingInt（無溢位）+ 拷貝後排序（不動原集合）
        List<Employee> original = getEmployees();
        List<Employee> sorted = new ArrayList<>(original);
        sorted.sort(Comparator.comparingInt(Employee::salary));
        System.out.println("排序後: " + sorted);
        System.out.println("原集合: " + original);       // 順序未變
    }

    static List<Employee> getEmployees() {
        return List.of(new Employee("小華", 95_000),
                       new Employee("小明", 80_000),
                       new Employee("小強", Integer.MIN_VALUE + 100));   // 極端值測試溢位
    }
}
```

**驗證第 ⑤ 點的溢位**：資料裡有 `Integer.MIN_VALUE + 100`。
用相減的版本 `95000 - (MIN_VALUE + 100)` 會溢位成負數，排序結果錯亂。
`Comparator.comparingInt` 內部用 `Integer.compare`，不會有這個問題。

</details>

### 練習 2：實作訂單統計（只用集合，不用 Stream）

給定訂單清單，實作以下統計。**這一題刻意不用 Stream**，第 06 章會請你用 Stream 重寫，好對比兩者。

1. 每個使用者的訂單總金額
2. 每個狀態的訂單數量
3. 金額最高的前 3 筆訂單
4. 每天的營收（依日期排序）
5. 有下過訂單的使用者清單（去重，依字母排序）

<details>
<summary>參考解答</summary>

```java
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

public class OrderStatistics {

    enum Status { CREATED, PAID, SHIPPED, DELIVERED, CANCELLED }

    record Order(String id, String userId, Status status,
                 long amountCents, LocalDateTime createdAt) { }

    private final List<Order> orders;

    OrderStatistics(List<Order> orders) {
        this.orders = List.copyOf(orders);
    }

    /** ① 每個使用者的訂單總金額 */
    Map<String, Long> totalAmountByUser() {
        Map<String, Long> result = new HashMap<>();
        for (Order o : orders) {
            result.merge(o.userId(), o.amountCents(), Long::sum);
        }
        return result;
    }

    /** ② 每個狀態的訂單數量（EnumMap：key 是 enum） */
    Map<Status, Integer> countByStatus() {
        Map<Status, Integer> result = new EnumMap<>(Status.class);
        for (Order o : orders) {
            result.merge(o.status(), 1, Integer::sum);
        }
        return result;
    }

    /**
     * ③ 金額最高的前 N 筆。
     * 資料量大時用大小為 N 的最小堆積比全排序快（O(n log N) vs O(n log n)），
     * 但這裡資料小，直接排序更清楚。
     */
    List<Order> topByAmount(int limit) {
        List<Order> sorted = new ArrayList<>(orders);
        sorted.sort(Comparator.comparingLong(Order::amountCents).reversed()
                .thenComparing(Order::id));          // 金額相同時用 id，確保結果穩定
        return sorted.subList(0, Math.min(limit, sorted.size()));
    }

    /** ④ 每天的營收（TreeMap 自動依日期排序；只算已付款以後的狀態） */
    Map<LocalDate, Long> revenueByDate() {
        Map<LocalDate, Long> result = new TreeMap<>();
        for (Order o : orders) {
            if (o.status() == Status.CANCELLED || o.status() == Status.CREATED) {
                continue;      // 未付款/已取消不算營收
            }
            result.merge(o.createdAt().toLocalDate(), o.amountCents(), Long::sum);
        }
        return result;
    }

    /** ⑤ 有下過訂單的使用者（TreeSet：去重 + 排序） */
    java.util.Set<String> activeUsers() {
        java.util.Set<String> result = new TreeSet<>();
        for (Order o : orders) {
            result.add(o.userId());
        }
        return result;
    }

    static String money(long cents) {
        return "%,.2f".formatted(cents / 100.0);
    }

    public static void main(String[] args) {
        LocalDateTime base = LocalDateTime.of(2026, 8, 15, 10, 0);

        var stats = new OrderStatistics(List.of(
                new Order("ORD-001", "u001", Status.DELIVERED, 299_00, base),
                new Order("ORD-002", "u002", Status.PAID, 1_599_00, base.plusHours(2)),
                new Order("ORD-003", "u001", Status.SHIPPED, 89_00, base.plusDays(1)),
                new Order("ORD-004", "u003", Status.CANCELLED, 5_000_00, base.plusDays(1)),
                new Order("ORD-005", "u002", Status.DELIVERED, 2_990_00, base.plusDays(1)),
                new Order("ORD-006", "u001", Status.CREATED, 450_00, base.plusDays(2)),
                new Order("ORD-007", "u004", Status.PAID, 1_200_00, base.plusDays(2))));

        System.out.println("① 每個使用者的訂單總金額");
        // 為了輸出穩定，排序後印出（HashMap 順序不保證）
        new TreeMap<>(stats.totalAmountByUser())
                .forEach((u, amt) -> System.out.printf("   %s  %10s%n", u, money(amt)));

        System.out.println("\n② 每個狀態的訂單數量");
        stats.countByStatus().forEach((s, c) -> System.out.printf("   %-10s %d%n", s, c));

        System.out.println("\n③ 金額最高的前 3 筆");
        for (Order o : stats.topByAmount(3)) {
            System.out.printf("   %s  %s  %10s%n", o.id(), o.userId(), money(o.amountCents()));
        }

        System.out.println("\n④ 每天營收（不含 CREATED / CANCELLED）");
        stats.revenueByDate()
                .forEach((d, amt) -> System.out.printf("   %s  %10s%n", d, money(amt)));

        System.out.println("\n⑤ 有下單的使用者");
        System.out.println("   " + stats.activeUsers());
    }
}
```

輸出：

```
① 每個使用者的訂單總金額
   u001     8,380.00
   u002    45,890.00
   u003    50,000.00
   u004    12,000.00

② 每個狀態的訂單數量
   CREATED    1
   PAID       2
   SHIPPED    1
   DELIVERED  2
   CANCELLED  1

③ 金額最高的前 3 筆
   ORD-004  u003   50,000.00
   ORD-005  u002   29,900.00
   ORD-002  u002   15,990.00

④ 每天營收（不含 CREATED / CANCELLED）
   2026-08-15   18,980.00
   2026-08-16   30,790.00
   2026-08-17   12,000.00

⑤ 有下單的使用者
   [u001, u002, u003, u004]
```

**這題練到的集合選型：**

| 需求 | 集合 | 理由 |
|---|---|---|
| 分組加總 | `HashMap` + `merge` | O(1)，`merge` 一行完成「有就加、沒有就放」 |
| enum 分組 | `EnumMap` | 最快最省，且輸出順序 = enum 宣告順序（穩定） |
| 依日期排序的統計 | `TreeMap` | key 自動排序，不用另外 sort |
| 去重 + 排序 | `TreeSet` | 兩件事一次做完 |
| Top N | `sort` + `subList` | 小資料直接排序；大資料改用 `PriorityQueue` 維持大小 N 的堆積 |

**兩個容易忽略的細節：**

1. `topByAmount` 加了 `.thenComparing(Order::id)`——沒有這個 tie-breaker 的話，
   金額相同的兩筆訂單順序不確定，API 分頁會出現「同一筆資料在第 1 頁和第 2 頁都出現」的 bug。
2. 印 `HashMap` 前先包成 `TreeMap`——`HashMap` 的順序不保證，會讓測試斷言不穩定。

</details>

### 練習 3：實作 LRU 快取（不繼承 `LinkedHashMap`）

用 `HashMap` + `Deque` 自己實作一個 LRU 快取，支援 `get` / `put`，容量滿時淘汰最久未使用的。

<details>
<summary>參考解答</summary>

```java
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * 用「雙向連結串列 + HashMap」實作 LRU。
 * 這是 LeetCode 146 的標準解，也是 Redis / Caffeine 的核心概念。
 *
 * 為什麼要自己寫連結串列，不用 ArrayDeque？
 * 因為需要「O(1) 把中間某個節點移到尾端」——ArrayDeque 做不到（remove(Object) 是 O(n)）。
 */
public class LruCache<K, V> {

    private static final class Node<K, V> {
        final K key;
        V value;
        Node<K, V> prev;
        Node<K, V> next;

        Node(K key, V value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private final Map<K, Node<K, V>> index;
    private final Node<K, V> head;      // 哨兵：head.next 是「最久未使用」
    private final Node<K, V> tail;      // 哨兵：tail.prev 是「最近使用」
    private int hits = 0;
    private int misses = 0;

    public LruCache(int capacity) {
        if (capacity <= 0) {
            throw new IllegalArgumentException("capacity 必須大於 0，收到: " + capacity);
        }
        this.capacity = capacity;
        this.index = new HashMap<>(capacity * 4 / 3 + 1);
        // 用兩個哨兵節點，省掉所有 null 檢查
        this.head = new Node<>(null, null);
        this.tail = new Node<>(null, null);
        head.next = tail;
        tail.prev = head;
    }

    public V get(K key) {
        Node<K, V> node = index.get(key);
        if (node == null) {
            misses++;
            return null;
        }
        hits++;
        moveToTail(node);           // 標記為「最近使用」
        return node.value;
    }

    public void put(K key, V value) {
        Objects.requireNonNull(key, "key 不可為 null");

        Node<K, V> existing = index.get(key);
        if (existing != null) {
            existing.value = value;
            moveToTail(existing);
            return;
        }

        if (index.size() >= capacity) {
            evictOldest();
        }

        Node<K, V> node = new Node<>(key, value);
        index.put(key, node);
        appendToTail(node);
    }

    public V remove(K key) {
        Node<K, V> node = index.remove(key);
        if (node == null) return null;
        unlink(node);
        return node.value;
    }

    public boolean containsKey(K key) { return index.containsKey(key); }

    public int size() { return index.size(); }

    public String stats() {
        int total = hits + misses;
        double rate = total == 0 ? 0 : (double) hits / total * 100;
        return "命中 %d / %d (%.1f%%)".formatted(hits, total, rate);
    }

    // ===== 連結串列操作，全部 O(1) =====

    private void appendToTail(Node<K, V> node) {
        node.prev = tail.prev;
        node.next = tail;
        tail.prev.next = node;
        tail.prev = node;
    }

    private void unlink(Node<K, V> node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
        node.prev = null;
        node.next = null;
    }

    private void moveToTail(Node<K, V> node) {
        unlink(node);
        appendToTail(node);
    }

    private void evictOldest() {
        Node<K, V> oldest = head.next;
        if (oldest == tail) return;         // 空的
        index.remove(oldest.key);
        unlink(oldest);
    }

    /** 從最久未使用到最近使用 */
    public Map<K, V> snapshot() {
        Map<K, V> result = new LinkedHashMap<>();
        for (Node<K, V> n = head.next; n != tail; n = n.next) {
            result.put(n.key, n.value);
        }
        return result;
    }

    // ===== 測試 =====

    public static void main(String[] args) {
        LruCache<String, String> cache = new LruCache<>(3);

        cache.put("a", "1");
        cache.put("b", "2");
        cache.put("c", "3");
        System.out.println("初始（舊→新）: " + cache.snapshot());     // {a=1, b=2, c=3}

        System.out.println("get(a) = " + cache.get("a"));
        System.out.println("存取 a 後  : " + cache.snapshot());        // {b=2, c=3, a=1}

        cache.put("d", "4");
        System.out.println("放入 d 後  : " + cache.snapshot());        // {c=3, a=1, d=4}
        System.out.println("b 被淘汰   : " + !cache.containsKey("b")); // true

        System.out.println("get(b) = " + cache.get("b"));              // null

        cache.put("c", "3-updated");
        System.out.println("更新 c 後  : " + cache.snapshot());        // {a=1, d=4, c=3-updated}

        System.out.println("remove(a) = " + cache.remove("a"));
        System.out.println("移除後     : " + cache.snapshot());        // {d=4, c=3-updated}

        System.out.println("\n" + cache.stats());
        // 命中 2 / 3 (66.7%)

        // 邊界測試
        try {
            new LruCache<String, String>(0);
        } catch (IllegalArgumentException e) {
            System.out.println("容量驗證: " + e.getMessage());
        }

        LruCache<String, String> single = new LruCache<>(1);
        single.put("x", "1");
        single.put("y", "2");
        System.out.println("容量 1: " + single.snapshot());             // {y=2}
    }
}
```

**設計要點：**

1. **為什麼需要雙向連結串列？** LRU 的核心操作是「把中間某個節點移到最後」。
   單向串列做不到 O(1)（找不到前驅），`ArrayDeque` 的 `remove(Object)` 是 O(n)。
2. **哨兵節點（head / tail）**：讓 `unlink` 和 `appendToTail` 不需要任何 `null` 檢查。
   這是連結串列實作的標準技巧，能大幅減少邊界 bug。
3. **`HashMap` 存的是節點而不是值**：這樣 `get(key)` 才能 O(1) 拿到節點並移動它。
4. **`remove` 時要同時清 `index` 和串列**——只清一邊就是記憶體洩漏。
5. **不是執行緒安全的**。要併發請用 `Caffeine`（它用 W-TinyLFU，比 LRU 命中率更高）。

**與 5.6 節 `LinkedHashMap` 版本的對比：**

| | `LinkedHashMap` 版 | 手寫版 |
|---|---|---|
| 程式碼量 | 10 行 | 130 行 |
| 實務上該用哪個 | ✅ 這個 | ❌ |
| 面試該會哪個 | 提一下 | ✅ 這個 |
| 可擴充性（加 TTL、加權重） | 困難 | 容易 |

</details>

### 練習 4：泛型 API 設計

設計一個泛型的 `Result<T>` 型別，表達「成功帶值」或「失敗帶錯誤訊息」，並提供：

- `map`：轉換成功的值
- `orElse`：失敗時回傳預設值
- `combine`：合併兩個 `Result`（都成功才成功）

<details>
<summary>參考解答</summary>

```java
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.BiFunction;
import java.util.function.Function;

/**
 * 成功或失敗的結果型別。
 * 用途見第 04 章 4.13 節：需要回傳多種失敗原因、或要一次收集多個錯誤時，
 * 比丟例外更適合。
 */
public sealed interface Result<T> permits Result.Success, Result.Failure {

    record Success<T>(T value) implements Result<T> {
        public Success {
            Objects.requireNonNull(value, "成功的值不可為 null");
        }
    }

    record Failure<T>(List<String> errors) implements Result<T> {
        public Failure {
            Objects.requireNonNull(errors, "errors 不可為 null");
            if (errors.isEmpty()) {
                throw new IllegalArgumentException("失敗必須至少有一個錯誤訊息");
            }
            errors = List.copyOf(errors);        // record 的緊湊建構子可以重新賦值參數
        }
    }

    // ===== 工廠方法 =====

    static <T> Result<T> success(T value) {
        return new Success<>(value);
    }

    static <T> Result<T> failure(String error) {
        return new Failure<>(List.of(error));
    }

    static <T> Result<T> failure(List<String> errors) {
        return new Failure<>(errors);
    }

    // ===== 查詢 =====

    default boolean isSuccess() { return this instanceof Success; }

    default boolean isFailure() { return this instanceof Failure; }

    default List<String> errors() {
        return this instanceof Failure<T> f ? f.errors() : List.of();
    }

    // ===== 轉換 =====

    /**
     * 轉換成功的值；失敗時原封不動傳遞。
     * 注意 Function 的簽章：? super T（消費 T）、? extends R（生產 R）—— PECS（5.12 節）
     */
    default <R> Result<R> map(Function<? super T, ? extends R> mapper) {
        Objects.requireNonNull(mapper, "mapper 不可為 null");
        return switch (this) {
            case Success<T> s -> Result.success(mapper.apply(s.value()));
            case Failure<T> f -> Result.failure(f.errors());
        };
    }

    /** map 的巢狀版：mapper 本身回傳 Result，避免 Result<Result<R>> */
    default <R> Result<R> flatMap(Function<? super T, Result<R>> mapper) {
        Objects.requireNonNull(mapper, "mapper 不可為 null");
        return switch (this) {
            case Success<T> s -> mapper.apply(s.value());
            case Failure<T> f -> Result.failure(f.errors());
        };
    }

    // ===== 取值 =====

    default T orElse(T defaultValue) {
        return this instanceof Success<T> s ? s.value() : defaultValue;
    }

    default T orElseThrow() {
        return switch (this) {
            case Success<T> s -> s.value();
            case Failure<T> f -> throw new IllegalStateException(
                    "取值失敗: " + String.join("; ", f.errors()));
        };
    }

    // ===== 合併 =====

    /**
     * 合併兩個 Result：都成功才成功；有失敗則「收集所有錯誤」。
     * 這是表單驗證想要的行為——一次告訴使用者全部問題，不是一個一個試。
     */
    default <U, R> Result<R> combine(Result<U> other,
                                     BiFunction<? super T, ? super U, ? extends R> merger) {
        Objects.requireNonNull(other, "other 不可為 null");
        Objects.requireNonNull(merger, "merger 不可為 null");

        if (this instanceof Success<T> a && other instanceof Success<U> b) {
            return Result.success(merger.apply(a.value(), b.value()));
        }
        List<String> all = new ArrayList<>(this.errors());
        all.addAll(other.errors());
        return Result.failure(all);
    }

    /** 把多個同型別的 Result 合成一個 Result<List<T>> */
    static <T> Result<List<T>> sequence(List<Result<T>> results) {
        List<T> values = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        for (Result<T> r : results) {
            switch (r) {
                case Success<T> s -> values.add(s.value());
                case Failure<T> f -> errors.addAll(f.errors());
            }
        }
        return errors.isEmpty() ? Result.success(List.copyOf(values)) : Result.failure(errors);
    }
}
```

使用示範：

```java
import java.util.List;

public class ResultDemo {

    record RegistrationForm(String email, int age, String password) { }

    static Result<String> validateEmail(String email) {
        if (email == null || email.isBlank()) return Result.failure("email 不可為空");
        if (!email.contains("@")) return Result.failure("email 格式錯誤: " + email);
        return Result.success(email.strip().toLowerCase());
    }

    static Result<Integer> validateAge(String raw) {
        if (raw == null || raw.isBlank()) return Result.failure("年齡不可為空");
        try {
            int age = Integer.parseInt(raw.strip());
            if (age < 18) return Result.failure("須滿 18 歲，收到: " + age);
            if (age > 150) return Result.failure("年齡不合理: " + age);
            return Result.success(age);
        } catch (NumberFormatException e) {
            return Result.failure("年齡必須是數字，收到: " + raw);
        }
    }

    static Result<String> validatePassword(String pw) {
        if (pw == null || pw.length() < 8) return Result.failure("密碼至少 8 字元");
        if (pw.chars().noneMatch(Character::isDigit)) return Result.failure("密碼須含數字");
        return Result.success(pw);
    }

    static Result<RegistrationForm> validate(String email, String age, String password) {
        // combine 會「收集」所有錯誤，不是遇到第一個就停
        return validateEmail(email)
                .combine(validateAge(age), (e, a) -> new Object[]{e, a})
                .combine(validatePassword(password),
                        (pair, pw) -> new RegistrationForm((String) pair[0], (Integer) pair[1], pw));
    }

    public static void main(String[] args) {

        System.out.println("=== 全部合法 ===");
        System.out.println(validate("USER@Example.com ", "30", "secret123"));
        // Success[value=RegistrationForm[email=user@example.com, age=30, password=secret123]]

        System.out.println("\n=== 全部不合法（一次回報全部）===");
        Result<RegistrationForm> bad = validate("not-an-email", "15", "abc");
        System.out.println("成功? " + bad.isSuccess());
        bad.errors().forEach(e -> System.out.println("  - " + e));
        // - email 格式錯誤: not-an-email
        // - 須滿 18 歲，收到: 15
        // - 密碼至少 8 字元

        System.out.println("\n=== map：轉換成功的值 ===");
        System.out.println(validateAge("30").map(a -> a * 2));           // Success[value=60]
        System.out.println(validateAge("abc").map(a -> a * 2));          // Failure[errors=[...]]

        System.out.println("\n=== flatMap：串接可能失敗的操作 ===");
        Result<String> chained = validateEmail("a@b.com")
                .flatMap(email -> email.endsWith(".com")
                        ? Result.success(email.toUpperCase())
                        : Result.failure("只接受 .com 網域"));
        System.out.println(chained);                                      // Success[value=A@B.COM]

        System.out.println("\n=== orElse / orElseThrow ===");
        System.out.println(validateAge("abc").orElse(-1));                // -1
        try {
            validateAge("abc").orElseThrow();
        } catch (IllegalStateException e) {
            System.out.println(e.getMessage());
        }

        System.out.println("\n=== sequence：批次驗證 ===");
        System.out.println(Result.sequence(List.of(
                validateAge("20"), validateAge("30"), validateAge("40"))));
        // Success[value=[20, 30, 40]]

        System.out.println(Result.sequence(List.of(
                validateAge("20"), validateAge("abc"), validateAge("10"))));
        // Failure[errors=[年齡必須是數字，收到: abc, 須滿 18 歲，收到: 10]]
    }
}
```

**這題練到的泛型技巧：**

| 技巧 | 出現在哪 | 為什麼 |
|---|---|---|
| `sealed interface` + `record` | 型別宣告 | 讓 `switch` 能完整性檢查，不需要 `default`（第 03 章 3.14 節） |
| `Function<? super T, ? extends R>` | `map` | PECS：消費 T 用 `super`，生產 R 用 `extends`，讓 API 能接受更多型別的 lambda |
| 泛型方法 `static <T> Result<List<T>> sequence(...)` | `sequence` | 靜態方法的型別參數要自己宣告 |
| `List.copyOf` 在 record 的緊湊建構子裡 | `Failure` | 防禦性拷貝（5.8 節） |
| 多型別參數 `<U, R>` | `combine` | 兩個輸入型別 + 一個輸出型別 |

**為什麼 `combine` 收集錯誤而不是短路？**

短路（遇到第一個錯誤就停）在**串接操作**時是對的（用 `flatMap`）；
但**表單驗證**要一次回報全部，否則使用者要送出五次才知道五個問題。
這正是第 04 章 4.13 節「錯誤清單」那一列的實作。

> **實務對照**：這個型別在 Rust（`Result<T, E>`）、Scala（`Either`）、Kotlin（`Result`）是內建的。
> Java 沒有，但 Vavr 函式庫提供了 `Either` / `Validation`。
> 實務上小專案自己寫一個就夠，大專案可以考慮引入 Vavr。

</details>

### 練習 5：集合選型判斷

為以下需求選出最合適的集合，並說明理由：

| # | 需求 |
|---|---|
| 1 | 記錄使用者最近瀏覽的 20 個商品，重複瀏覽要移到最前面 |
| 2 | 判斷某個 IP 是否在黑名單中（10 萬筆，每秒查詢上千次） |
| 3 | 記錄每個 API 端點的呼叫次數（多執行緒） |
| 4 | 依「開始時間」找出所有與某時段重疊的會議 |
| 5 | 待處理的通知佇列，緊急通知要先發 |
| 6 | 使用者的權限集合（權限是 enum，約 20 種） |
| 7 | 系統設定，啟動時載入後不再變更，會被多執行緒讀取 |
| 8 | 每日訂單編號 → 訂單物件，報表要依編號排序輸出 |

<details>
<summary>參考解答</summary>

| # | 選擇 | 理由 |
|---|---|---|
| 1 | **`LinkedHashSet`**（或 `LinkedHashMap` accessOrder=true） | 需要「不重複」+「有順序」。重複瀏覽時 `remove` 再 `add` 就會移到最後。若要自動淘汰第 21 個，用 5.6 節的 `LinkedHashMap(accessOrder=true)` + `removeEldestEntry`。**不要用 `List`**——`contains` 是 O(n)，且去重要自己寫 |
| 2 | **`HashSet<String>`** | 只需要 `contains`，O(1)。10 萬筆的記憶體完全沒問題。**不要用 `List`**（O(n) 掃描，每秒上千次就是災難）。若要支援「IP 網段」查詢（`192.168.1.0/24`），改用 `TreeMap` 的 `floorEntry` 做區間查找 |
| 3 | **`ConcurrentHashMap<String, LongAdder>`** | 多執行緒必須用併發集合。計數器用 `LongAdder` 比 `AtomicLong` 在高競爭下快得多（第 08 章）。用 `computeIfAbsent(path, k -> new LongAdder()).increment()`。**不要用 `HashMap` + `synchronized`**（整個 map 一把鎖） |
| 4 | **`TreeMap<LocalDateTime, List<Meeting>>`** | 需要範圍查詢。用 `subMap(start, end)` 找出時段內的會議，O(log n + k)。搭配第 02 章練習 2 的 `DateRange.overlaps` 做精確判斷。**不要用 `List` + 全掃**（會議多了就慢） |
| 5 | **`PriorityQueue`**（單執行緒）／ **`PriorityBlockingQueue`**（多執行緒） | 「依優先度取出」正是它的定義。`Comparator.comparingInt(Notification::priority).thenComparingLong(Notification::createdAt)` 讓同優先度先進先出。**不要用 `List` + 每次排序** |
| 6 | **`EnumSet`** | key 是 enum → 內部用 `long` 位元遮罩，比 `HashSet` 快數倍且幾乎不佔記憶體。20 種權限剛好放進一個 `long`。集合運算（`containsAll` / `removeAll`）也是位元運算，極快 |
| 7 | **`Map.copyOf(...)`（不可變 Map）** | 不可變物件天生執行緒安全，不需要任何鎖（第 02 章 2.9 節）。讀取效能等同 `HashMap`。**不要用 `ConcurrentHashMap`**——它是為了「併發寫入」設計的，這裡完全不寫入，用不可變更好 |
| 8 | **`TreeMap<String, Order>`** | 需要「依 key 排序輸出」。`TreeMap` 走訪時自然有序，不用另外 sort。若查詢遠多於輸出報表，也可以用 `HashMap` + 輸出時 `new TreeMap<>(map)`——看哪個操作更頻繁 |

**幾個追加的判斷：**

**第 2 題如果要支援網段呢？**

```java
// 用 TreeMap 存「網段起始 IP → 網段資訊」，用 floorEntry 找出包含目標 IP 的網段
TreeMap<Long, CidrBlock> blacklist = new TreeMap<>();
Map.Entry<Long, CidrBlock> entry = blacklist.floorEntry(ipToLong(target));
boolean blocked = entry != null && entry.getValue().contains(target);
```

**第 7 題為什麼不用 `ConcurrentHashMap`？**

這是實務上常見的過度設計。`ConcurrentHashMap` 的成本（記憶體、CAS 操作）是為了支援併發寫入。
如果資料在啟動後就不變，**不可變集合是嚴格更好的選擇**：更快、更省、且從型別上就保證沒人能改它。

**第 3 題為什麼是 `LongAdder` 而不是 `AtomicLong`？**

`AtomicLong` 在高競爭下所有執行緒搶同一個記憶體位置（CAS 失敗重試）。
`LongAdder` 把計數分散到多個 cell，最後才加總——寫入吞吐量高得多。
代價是 `sum()` 不是精確的瞬間快照，但對「呼叫次數統計」完全足夠。

</details>

---

## 5.18 驗收清單

- [ ] 我知道四個「預設答案」：`ArrayList`、`HashMap`、`HashSet`、`ArrayDeque`。
- [ ] 我能說出為什麼 `LinkedList` 幾乎總是輸給 `ArrayList`。
- [ ] 我知道 `HashMap` 的桶結構、負載因子 0.75、樹化門檻 8，也知道預先指定容量的好處。
- [ ] 我能完整說出 `equals` / `hashCode` 契約，也能說明「可變 key」為什麼會讓資料消失。
- [ ] 我知道實體用 `id` 算 hash、值物件用全部欄位。
- [ ] 我能分辨 `Arrays.asList` / `List.of` / `unmodifiableList` / `List.copyOf` 的差異。
- [ ] 我知道存進欄位要用 `List.copyOf`，而不是 `Collections.unmodifiableList`。
- [ ] 我不在迭代中修改集合，會用 `removeIf` 或 `Iterator.remove`。
- [ ] 我知道 `ConcurrentModificationException` 不保證一定會拋出（可能靜默跳過元素）。
- [ ] 我用 `Comparator.comparing().thenComparing()`，且用 `Integer.compare` 不用相減。
- [ ] 我知道排序要處理 `null`，也知道 `sort()` 會修改原集合。
- [ ] 我用 `ArrayDeque` 而不是 `Stack`，也知道 `PriorityQueue` 的迭代順序不是排序的。
- [ ] 我能說出 PECS 原則，並判斷該用 `? extends T` 還是 `? super T`。
- [ ] 我知道型別抹除的三個後果，也知道 `TypeReference` 的原理。
- [ ] 我知道多執行緒不能用 `HashMap`，也知道 `ConcurrentHashMap` 的原子性只在單一方法內。
- [ ] 我知道 key 是 enum 時該用 `EnumMap` / `EnumSet`。

---

完成後請前往 [06-stream-lambda-optional.md](./06-stream-lambda-optional.md)。
