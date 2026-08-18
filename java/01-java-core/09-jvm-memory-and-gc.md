# 第 09 章：JVM 記憶體模型與 GC

> 這章是「線上出事時你會不會被叫起來」的分水嶺。
>
> 服務跑三天就 OOM 重啟、每小時卡頓 3 秒、CPU 突然衝到 100%、Kubernetes 一直 `OOMKilled`——
> 這些症狀的共同點是：**看程式碼看不出來，必須看 JVM 的狀態。**
>
> 目標不是讓你變成 JVM 調校專家（那是另一個職業），而是讓你能在半小時內
> **從症狀定位到根因**，並知道該調哪個參數、該找誰。

---

## 9.1 學習目標

完成本章後，你應該可以：

- 畫出 JVM 執行時資料區域，並說出每一塊放什麼、由誰共用。
- 說明類別載入的五個階段與雙親委派模型，並解釋 `ClassNotFoundException` 與 `NoClassDefFoundError` 的差別。
- 說出物件在堆積中的記憶體佈局，並估算一個物件佔多少位元組。
- 解釋 GC Roots 與可達性分析，並說出四種引用型別的用途。
- 說明分代收集的原理，以及 Eden / Survivor / Old 的物件流動。
- 在 Serial / Parallel / G1 / ZGC 之間做出有理由的選擇。
- 認出六種 `OutOfMemoryError` 並知道各自的診斷方向。
- **實作一個記憶體洩漏，然後用 heap dump 抓出它。**
- 用 `jcmd` / `jstat` / JFR 診斷線上問題。
- 說明容器環境下 JVM 記憶體設定的三個陷阱。

---

## 9.2 執行時資料區域全圖

```
┌─────────────────────────────────────────────────────────────────────┐
│                         JVM 程序                                     │
│                                                                     │
│  ┌── 每條執行緒私有 ──────────────────────────────────────────┐      │
│  │                                                            │      │
│  │  執行緒 A            執行緒 B            執行緒 C            │      │
│  │  ┌──────────┐      ┌──────────┐      ┌──────────┐        │      │
│  │  │ PC 暫存器 │      │ PC 暫存器 │      │ PC 暫存器 │        │      │
│  │  ├──────────┤      ├──────────┤      ├──────────┤        │      │
│  │  │ JVM 堆疊  │      │ JVM 堆疊  │      │ JVM 堆疊  │        │      │
│  │  │ ┌──────┐ │      │ ┌──────┐ │      │ ┌──────┐ │        │      │
│  │  │ │棧框3 │ │      │ │棧框2 │ │      │ │棧框1 │ │        │      │
│  │  │ ├──────┤ │      │ ├──────┤ │      │ └──────┘ │        │      │
│  │  │ │棧框2 │ │      │ │棧框1 │ │      │          │        │      │
│  │  │ ├──────┤ │      │ └──────┘ │      │          │        │      │
│  │  │ │棧框1 │ │      │          │      │          │        │      │
│  │  │ └──────┘ │      │          │      │          │        │      │
│  │  ├──────────┤      ├──────────┤      ├──────────┤        │      │
│  │  │本地方法棧 │      │本地方法棧 │      │本地方法棧 │        │      │
│  │  └──────────┘      └──────────┘      └──────────┘        │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                     │
│  ┌── 所有執行緒共用 ──────────────────────────────────────────┐      │
│  │                                                            │      │
│  │  ┌────────────────── 堆積 (Heap) ──────────────────┐      │      │
│  │  │  ┌─── 新生代 ───┐  ┌────── 老年代 ──────┐       │      │      │
│  │  │  │ Eden │S0│S1  │  │                    │       │      │      │
│  │  │  └──────────────┘  └────────────────────┘       │      │      │
│  │  │  ★ 幾乎所有物件都在這裡，也是 GC 的主戰場          │      │      │
│  │  └───────────────────────────────────────────────────┘      │      │
│  │                                                            │      │
│  │  ┌──── Metaspace（方法區）─── 在「本機記憶體」，不在堆積 ──┐  │      │
│  │  │  類別的中繼資料、方法的 bytecode、執行時常量池        │  │      │
│  │  └──────────────────────────────────────────────────────┘  │      │
│  │                                                            │      │
│  │  ┌──── 程式碼快取 (Code Cache) ──── JIT 編譯出的機器碼 ───┐  │      │
│  │  └──────────────────────────────────────────────────────┘  │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                     │
│  ┌── 本機記憶體（不受 -Xmx 控制）─────────────────────────────┐      │
│  │  DirectByteBuffer / 記憶體映射檔 / 執行緒堆疊 / JNI /        │      │
│  │  GC 自己的資料結構 / 壓縮類別空間                            │      │
│  └────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

> ⚠️ **這張圖最重要的一件事**：`-Xmx` **只控制堆積**。
> 一個 `-Xmx2g` 的 JVM，實際 RSS（作業系統看到的記憶體用量）可能是 3～4GB。
> 這是容器被 `OOMKilled` 的頭號原因（9.13 節）。

### 用程式碼觀察各區域

```java
public class MemoryRegions {

    public static void main(String[] args) {
        Runtime rt = Runtime.getRuntime();

        System.out.println("=== 堆積（Runtime API）===");
        System.out.printf("  maxMemory (≈ -Xmx)  : %,d MB%n", rt.maxMemory() / 1024 / 1024);
        System.out.printf("  totalMemory (已保留) : %,d MB%n", rt.totalMemory() / 1024 / 1024);
        System.out.printf("  freeMemory (可用)    : %,d MB%n", rt.freeMemory() / 1024 / 1024);
        System.out.printf("  已使用               : %,d MB%n",
                (rt.totalMemory() - rt.freeMemory()) / 1024 / 1024);
        System.out.printf("  可用 CPU             : %d%n", rt.availableProcessors());

        System.out.println("\n=== 各記憶體池（MemoryPoolMXBean）===");
        for (var pool : java.lang.management.ManagementFactory.getMemoryPoolMXBeans()) {
            var usage = pool.getUsage();
            System.out.printf("  %-28s [%s] 已用 %,7d KB / 上限 %s%n",
                    pool.getName(), pool.getType(),
                    usage.getUsed() / 1024,
                    usage.getMax() < 0 ? "無上限" : (usage.getMax() / 1024 / 1024) + " MB");
        }

        System.out.println("\n=== GC 收集器 ===");
        for (var gc : java.lang.management.ManagementFactory.getGarbageCollectorMXBeans()) {
            System.out.printf("  %-24s 次數 %,d，累計耗時 %,d ms，負責 %s%n",
                    gc.getName(), gc.getCollectionCount(), gc.getCollectionTime(),
                    java.util.Arrays.toString(gc.getMemoryPoolNames()));
        }

        System.out.println("\n=== 堆積 vs 非堆積 ===");
        var mem = java.lang.management.ManagementFactory.getMemoryMXBean();
        System.out.printf("  Heap    : 已用 %,d MB / 已保留 %,d MB / 上限 %,d MB%n",
                mem.getHeapMemoryUsage().getUsed() / 1024 / 1024,
                mem.getHeapMemoryUsage().getCommitted() / 1024 / 1024,
                mem.getHeapMemoryUsage().getMax() / 1024 / 1024);
        System.out.printf("  NonHeap : 已用 %,d MB / 已保留 %,d MB%n",
                mem.getNonHeapMemoryUsage().getUsed() / 1024 / 1024,
                mem.getNonHeapMemoryUsage().getCommitted() / 1024 / 1024);

        System.out.println("\n=== 執行緒與類別 ===");
        var threads = java.lang.management.ManagementFactory.getThreadMXBean();
        var classes = java.lang.management.ManagementFactory.getClassLoadingMXBean();
        System.out.printf("  當前執行緒數: %d（歷史峰值 %d）%n",
                threads.getThreadCount(), threads.getPeakThreadCount());
        System.out.printf("  已載入類別  : %,d（累計載入 %,d，已卸載 %,d）%n",
                classes.getLoadedClassCount(), classes.getTotalLoadedClassCount(),
                classes.getUnloadedClassCount());
    }
}
```

典型輸出（JDK 21，`-Xmx2g`）：

```
=== 堆積（Runtime API）===
  maxMemory (≈ -Xmx)  : 2,048 MB
  totalMemory (已保留) : 128 MB
  freeMemory (可用)    : 121 MB
  已使用               : 6 MB
  可用 CPU             : 8

=== 各記憶體池（MemoryPoolMXBean）===
  CodeHeap 'non-nmethods'      [NON_HEAP] 已用   1,344 KB / 上限 5 MB
  Metaspace                    [NON_HEAP] 已用   2,880 KB / 上限 無上限
  CodeHeap 'profiled nmethods' [NON_HEAP] 已用   1,024 KB / 上限 117 MB
  Compressed Class Space       [NON_HEAP] 已用     320 KB / 上限 1024 MB
  G1 Eden Space                [HEAP]     已用   6,144 KB / 上限 無上限
  G1 Old Gen                   [HEAP]     已用       0 KB / 上限 2048 MB
  G1 Survivor Space            [HEAP]     已用       0 KB / 上限 無上限
  CodeHeap 'non-profiled ...'  [NON_HEAP] 已用     256 KB / 上限 117 MB

=== GC 收集器 ===
  G1 Young Generation      次數 0，累計耗時 0 ms，負責 [G1 Eden Space, G1 Survivor Space, G1 Old Gen]
  G1 Concurrent GC         次數 0，累計耗時 0 ms，負責 [G1 Old Gen]
  G1 Old Generation        次數 0，累計耗時 0 ms，負責 [G1 Eden Space, G1 Survivor Space, G1 Old Gen]

=== 堆積 vs 非堆積 ===
  Heap    : 已用 6 MB / 已保留 128 MB / 上限 2048 MB
  NonHeap : 已用 5 MB / 已保留 21 MB

=== 執行緒與類別 ===
  當前執行緒數: 9（歷史峰值 9）
  已載入類別  : 1,247（累計載入 1,247，已卸載 0）
```

> **注意 `totalMemory` (128MB) ≠ `maxMemory` (2048MB)**。
> JVM 一開始只向 OS 要 `-Xms`（預設是實體記憶體的 1/64），需要時才慢慢長大到 `-Xmx`。
> **正式環境建議 `-Xms` = `-Xmx`**，避免執行期擴容的停頓與記憶體碎片。

---

## 9.3 堆疊：`StackOverflowError` 與棧框

每條執行緒有自己的 JVM 堆疊，每次方法呼叫壓入一個**棧框（frame）**：

```
棧框的內容：
  ┌─────────────────────────┐
  │ 區域變數表 (Local Vars)  │  參數 + 區域變數（含 this）
  ├─────────────────────────┤
  │ 操作數堆疊 (Operand)     │  bytecode 運算用的暫存區（第 00 章 javap 看到的）
  ├─────────────────────────┤
  │ 動態連結                 │  指向執行時常量池的參考
  ├─────────────────────────┤
  │ 方法返回位址             │
  └─────────────────────────┘
```

```java
public class StackDepth {

    static int depth = 0;

    public static void main(String[] args) {
        // ===== 測試 1：無參數的簡單遞迴能到多深 =====
        try {
            simple();
        } catch (StackOverflowError e) {
            System.out.println("簡單遞迴深度      : " + depth);
        }

        // ===== 測試 2：棧框變大（多區域變數）→ 深度變淺 =====
        depth = 0;
        try {
            heavy(1, 2, 3, 4, 5);
        } catch (StackOverflowError e) {
            System.out.println("有大量區域變數的深度: " + depth);
        }

        System.out.println("\n預設堆疊大小約 512KB~1MB（-Xss 調整）");
        System.out.println("→ 用 -Xss256k 執行會看到深度變成約一半");
        System.out.println("→ 用 -Xss4m 執行會看到深度變成約 4~8 倍");
    }

    static void simple() {
        depth++;
        simple();
    }

    static void heavy(long a, long b, long c, long d, long e) {
        depth++;
        long l1 = a, l2 = b, l3 = c, l4 = d, l5 = e;
        long l6 = a + b, l7 = c + d, l8 = e + a, l9 = b + c, l10 = d + e;
        double d1 = 1.1, d2 = 2.2, d3 = 3.3, d4 = 4.4, d5 = 5.5;
        heavy(l1 + l6, l2 + l7, l3 + l8, l4 + l9, l5 + l10);
    }
}
```

典型輸出：

```
簡單遞迴深度      : 22047
有大量區域變數的深度: 5183

預設堆疊大小約 512KB~1MB（-Xss 調整）
→ 用 -Xss256k 執行會看到深度變成約一半
→ 用 -Xss4m 執行會看到深度變成約 4~8 倍
```

### `StackOverflowError` 的三種真實成因

```java
import java.util.ArrayList;
import java.util.List;

public class StackOverflowCauses {

    public static void main(String[] args) {

        // ===== 成因 1：忘記終止條件的遞迴（最常見）=====
        System.out.println("--- 成因 1：遞迴沒有終止條件 ---");
        try {
            infiniteRecursion(0);
        } catch (StackOverflowError e) {
            System.out.println("  StackOverflowError（堆疊有 " + e.getStackTrace().length
                    + " 層，預設只保留前 1024 層）");
        }

        // ===== 成因 2：處理過深的樹狀結構 =====
        System.out.println("\n--- 成因 2：資料本身太深 ---");
        Node deep = buildDeepChain(50_000);
        try {
            System.out.println("  遞迴深度: " + countRecursive(deep));
        } catch (StackOverflowError e) {
            System.out.println("  ❌ 遞迴版爆了（資料有 5 萬層）");
        }
        System.out.println("  ✅ 迭代版: " + countIterative(deep));

        // ===== 成因 3：toString / equals / hashCode 互相呼叫 =====
        System.out.println("\n--- 成因 3：循環參考導致 toString 無限遞迴 ---");
        var a = new Parent("父");
        var b = new Child("子", a);
        a.child = b;
        try {
            System.out.println(a);
        } catch (StackOverflowError e) {
            System.out.println("  ❌ Parent.toString 呼叫 Child.toString，又呼叫回 Parent…");
        }
        System.out.println("  ✅ 只印 id 不印整個物件: " + a.safeToString());
    }

    static void infiniteRecursion(int n) {
        infiniteRecursion(n + 1);
    }

    // ===== 成因 2 的資料結構 =====
    static class Node {
        Node next;
        int value;
        Node(int value) { this.value = value; }
    }

    static Node buildDeepChain(int depth) {
        Node head = new Node(0);
        Node current = head;
        for (int i = 1; i < depth; i++) {
            current.next = new Node(i);
            current = current.next;
        }
        return head;
    }

    /** ❌ 深度大時會爆堆疊 */
    static int countRecursive(Node node) {
        return node == null ? 0 : 1 + countRecursive(node.next);
    }

    /** ✅ 改成迴圈，深度不受限（第 01 章 1.14 節） */
    static int countIterative(Node node) {
        int count = 0;
        while (node != null) {
            count++;
            node = node.next;
        }
        return count;
    }

    // ===== 成因 3 的循環參考 =====
    static class Parent {
        final String name;
        Child child;

        Parent(String name) { this.name = name; }

        @Override
        public String toString() {
            return "Parent{name=" + name + ", child=" + child + "}";   // ❌ 遞迴
        }

        String safeToString() {
            return "Parent{name=" + name + ", childName=" + (child == null ? "null" : child.name) + "}";
        }
    }

    static class Child {
        final String name;
        final Parent parent;

        Child(String name, Parent parent) { this.name = name; this.parent = parent; }

        @Override
        public String toString() {
            return "Child{name=" + name + ", parent=" + parent + "}";   // ❌ 遞迴回去
        }
    }
}
```

輸出：

```
--- 成因 1：遞迴沒有終止條件 ---
  StackOverflowError（堆疊有 1024 層，預設只保留前 1024 層）

--- 成因 2：資料本身太深 ---
  ❌ 遞迴版爆了（資料有 5 萬層）
  ✅ 迭代版: 50000

--- 成因 3：循環參考導致 toString 無限遞迴 ---
  ❌ Parent.toString 呼叫 Child.toString，又呼叫回 Parent…
  ✅ 只印 id 不印整個物件: Parent{name=父, childName=子}
```

> **成因 3 在 JPA 實體上極常見**（第 08 站）：`Order` 有 `List<OrderItem>`，
> `OrderItem` 有 `Order order` 反向參考。IDE 產生的 `toString()` 兩邊都印對方 → 一 log 就爆。
> 同樣的問題也發生在 Jackson 序列化（用 `@JsonIgnore` 或 `@JsonManagedReference` 解決）。
>
> **`-Xss` 該不該調大？** 通常**不該**。`StackOverflowError` 幾乎都是「演算法該改成迭代」的訊號。
> 而且每條執行緒都吃 `-Xss`——調成 4MB 且開 500 條執行緒就是 2GB 本機記憶體。

---

## 9.4 堆積：物件住的地方

### 分代結構

```
堆積 (-Xmx 控制的範圍)
┌──────────────────────────────────────────────────────────────┐
│  新生代 (Young Generation)          │  老年代 (Old Generation)  │
│  預設約佔 1/3（-XX:NewRatio=2）      │  預設約佔 2/3            │
│ ┌──────────────┬──────┬──────┐     │ ┌──────────────────────┐│
│ │    Eden      │  S0  │  S1  │     │ │                      ││
│ │              │(from)│ (to) │     │ │                      ││
│ │  8 份        │ 1 份 │ 1 份 │     │ │                      ││
│ └──────────────┴──────┴──────┘     │ └──────────────────────┘│
│  -XX:SurvivorRatio=8                │                          │
└──────────────────────────────────────────────────────────────┘

物件的一生：
  ① new 出來 → 放 Eden（大物件直接進老年代）
  ② Eden 滿了 → 觸發 Minor GC（Young GC）
       存活的物件 → 複製到 S0，age = 1
       Eden 清空
  ③ 下次 Minor GC
       Eden 存活的 + S0 存活的 → 全部複製到 S1，age + 1
       Eden 和 S0 清空
  ④ 重複，S0 / S1 交替（所以叫 from / to）
  ⑤ age 達到門檻（-XX:MaxTenuringThreshold，預設 15）→ 晉升到老年代
  ⑥ 老年代滿了 → 觸發 Major GC / Full GC（很慢！）
```

**為什麼要分代？** 因為統計上**絕大多數物件都是「朝生夕死」**：

```java
public class WeakGenerationalHypothesis {

    public static void main(String[] args) {
        // 這些物件在方法返回後就沒人參考了 —— 佔了實務上 90%~98% 的物件
        for (int i = 0; i < 1_000_000; i++) {
            String temp = "temp-" + i;                       // 立刻變垃圾
            var list = java.util.List.of(temp, temp);        // 立刻變垃圾
            int len = temp.length() + list.size();           // 基本型別在堆疊上，不算
        }

        System.out.println("""
                「弱分代假說」（Weak Generational Hypothesis）：

                  ① 絕大多數物件很快就變成垃圾
                  ② 存活久的物件很少參考到年輕的物件

                所以：
                  → 新生代用「複製演算法」：只複製存活的少數，速度極快
                  → 老年代用「標記-整理」：物件多但存活率高，不適合複製
                  → 大部分 GC 只掃新生代（Minor GC），幾毫秒完成

                這就是為什麼「在方法裡 new 一堆臨時物件」在 Java 裡通常不是問題。
                真正的問題是「該死的物件沒死」—— 也就是記憶體洩漏（9.11 節）。
                """);
    }
}
```

### 觀察 GC 實際發生

```java
public class GcObservation {

    /** 用 -Xlog:gc -Xmx256m -Xms256m 執行這段程式，觀察 GC 日誌 */
    public static void main(String[] args) throws InterruptedException {
        var rt = Runtime.getRuntime();
        java.util.List<byte[]> survivors = new java.util.ArrayList<>();

        System.out.printf("%-10s %-12s %-12s %-12s %s%n",
                "回合", "已用(MB)", "已保留(MB)", "GC 次數", "累計 GC(ms)");

        for (int round = 1; round <= 20; round++) {
            // 每回合配置 20MB 的臨時物件（會很快變垃圾）
            for (int i = 0; i < 20; i++) {
                byte[] garbage = new byte[1024 * 1024];      // 1MB
                garbage[0] = 1;                               // 避免被最佳化掉
            }

            // 每回合留下 2MB 不放掉（模擬快取成長）
            survivors.add(new byte[2 * 1024 * 1024]);

            long gcCount = 0, gcTime = 0;
            for (var gc : java.lang.management.ManagementFactory.getGarbageCollectorMXBeans()) {
                gcCount += gc.getCollectionCount();
                gcTime += gc.getCollectionTime();
            }

            System.out.printf("%-10d %-12d %-12d %-12d %d%n",
                    round,
                    (rt.totalMemory() - rt.freeMemory()) / 1024 / 1024,
                    rt.totalMemory() / 1024 / 1024,
                    gcCount, gcTime);
        }

        System.out.println("\n保留的物件總量: " + survivors.size() * 2 + " MB");
        System.out.println("""

                觀察重點：
                  ① 「已用」會鋸齒狀上下 —— 每次 GC 回收臨時物件
                  ② 但「谷底」會逐漸升高 —— 因為 survivors 一直長大
                  ③ GC 次數穩定增加是正常的（Minor GC 很便宜）

                ★ 記憶體洩漏的特徵就是：Full GC 之後「谷底」還是持續升高。
                  這是判斷「是洩漏還是正常用量」的關鍵指標（9.11 節）。
                """);
    }
}
```

用 `-Xlog:gc -Xmx256m -Xms256m` 執行，會看到 GC 日誌：

```
[0.012s][info][gc] Using G1
[0.245s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->3M(256M) 2.841ms
[0.402s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 27M->6M(256M) 1.923ms
[0.551s][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 30M->8M(256M) 1.702ms
...
[2.104s][info][gc] GC(18) Pause Young (Concurrent Start) (G1 Humongous Allocation) 152M->44M(256M) 4.201ms
[2.106s][info][gc] GC(19) Concurrent Mark Cycle
```

**怎麼讀這一行：**

```
GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->3M(256M) 2.841ms
 │     │           │        │                     │   │  │      │
 │     │           │        │                     │   │  │      └─ 停頓時間
 │     │           │        │                     │   │  └─ 堆積總大小
 │     │           │        │                     │   └─ GC 後已用
 │     │           │        │                     └─ GC 前已用
 │     │           │        └─ 觸發原因
 │     │           └─ 是否為混合收集
 │     └─ Young（新生代）還是 Full
 └─ 第幾次 GC
```

> **`-Xlog:gc` 應該是**正式環境的預設設定。它幾乎沒有效能成本，但出事時是唯一的線索。
>
> ```bash
> # 正式環境建議的 GC 日誌設定（滾動保留 10 個 20MB 的檔案）
> java -Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=20M \
>      -jar app.jar
> ```

---

## 9.5 Metaspace 與其他非堆積區域

```java
public class MetaspaceBasics {

    public static void main(String[] args) {
        System.out.println("""
                === Metaspace（Java 8 取代了 PermGen）===

                放什麼：
                  - 類別的中繼資料（欄位、方法簽章、繼承關係）
                  - 方法的 bytecode
                  - 執行時常量池
                  - JIT 的一些中繼資料

                關鍵差異：
                  PermGen (Java 7 及之前)     Metaspace (Java 8+)
                  ─────────────────────────  ────────────────────────────
                  在「堆積」內                 在「本機記憶體」
                  -XX:MaxPermSize 固定上限     預設「無上限」（吃到 OS 記憶體用完）
                  容易 OOM: PermGen space      需要自己設 -XX:MaxMetaspaceSize
                  字串常量池也在裡面            字串常量池搬到堆積（Java 7 起）

                ⚠️ 「預設無上限」是雙面刃：
                  好處：不會再因為類別太多而 OOM
                  壞處：類別洩漏會一路吃光機器的記憶體，而且 -Xmx 管不到它
                  → ★ 正式環境一定要設 -XX:MaxMetaspaceSize=256m（或依實測值）

                === 其他非堆積區域 ===

                Code Cache（-XX:ReservedCodeCacheSize，預設 240MB）
                  JIT 編譯出的機器碼。滿了會關閉 JIT → 效能斷崖式下跌
                  症狀：log 出現 "CodeCache is full. Compiler has been disabled."

                Compressed Class Space（-XX:CompressedClassSpaceSize，預設 1GB）
                  Metaspace 的一部分，存類別指標

                執行緒堆疊
                  執行緒數 × -Xss。500 條 × 1MB = 500MB，完全不受 -Xmx 控制

                Direct Memory（-XX:MaxDirectMemorySize，預設 = -Xmx）
                  ByteBuffer.allocateDirect() 用的。Netty、NIO、Kafka 客戶端大量使用
                """);

        System.out.println("=== 當前狀態 ===");
        for (var pool : java.lang.management.ManagementFactory.getMemoryPoolMXBeans()) {
            if (pool.getType() == java.lang.management.MemoryType.NON_HEAP) {
                var u = pool.getUsage();
                System.out.printf("  %-30s %,8d KB / %s%n", pool.getName(), u.getUsed() / 1024,
                        u.getMax() < 0 ? "無上限" : (u.getMax() / 1024 / 1024) + " MB");
            }
        }

        // Direct Memory 的用量（需要 sun.management 的 BufferPoolMXBean）
        System.out.println("\n=== Buffer Pool（Direct Memory）===");
        for (var pool : java.lang.management.ManagementFactory
                .getPlatformMXBeans(java.lang.management.BufferPoolMXBean.class)) {
            System.out.printf("  %-12s 數量 %,d，已用 %,d KB%n",
                    pool.getName(), pool.getCount(), pool.getMemoryUsed() / 1024);
        }
    }
}
```

### 動態產生類別造成的 Metaspace 洩漏

```java
public class MetaspaceLeak {

    /**
     * 用 -XX:MaxMetaspaceSize=64m 執行，會看到
     * java.lang.OutOfMemoryError: Metaspace
     *
     * 實務上什麼時候會發生？
     *   - 大量使用 CGLIB / ByteBuddy 動態產生代理（Spring AOP、Mockito）
     *   - 動態編譯（腳本引擎、規則引擎、JSP 熱部署）
     *   - 應用伺服器反覆熱部署，舊的 ClassLoader 沒被回收
     */
    public static void main(String[] args) {
        int count = 0;
        try {
            while (true) {
                // 每次都建一個新的 ClassLoader 並載入一個新類別
                var loader = new java.net.URLClassLoader(new java.net.URL[0]) {
                    Class<?> defineDynamic(String name) {
                        byte[] bytecode = generateSimpleClass(name);
                        return defineClass(name, bytecode, 0, bytecode.length);
                    }
                };
                // 這裡簡化示範：實務上是用 ASM / ByteBuddy 產生 bytecode
                count++;

                if (count % 1000 == 0) {
                    var meta = java.lang.management.ManagementFactory.getMemoryPoolMXBeans()
                            .stream().filter(p -> p.getName().contains("Metaspace"))
                            .findFirst().orElseThrow();
                    System.out.printf("已建立 %,d 個 ClassLoader，Metaspace: %,d KB%n",
                            count, meta.getUsage().getUsed() / 1024);
                }
                if (count > 20_000) break;      // 避免這個示範真的吃光記憶體
            }
        } catch (OutOfMemoryError e) {
            System.err.println("💥 " + e.getMessage() + "（在第 " + count + " 個）");
        }

        System.out.println("""

                診斷 Metaspace 問題：
                  ① jcmd <pid> VM.metaspace                    看詳細分佈
                  ② jcmd <pid> GC.class_stats                  看每個類別的大小（需 -XX:+UnlockDiagnosticVMOptions）
                  ③ jcmd <pid> VM.class_hierarchy | wc -l      看類別總數
                  ④ -Xlog:class+load=info                      看載入了什麼
                  ⑤ 監控 ClassLoadingMXBean.getLoadedClassCount()
                     ★ 這個數字「持續上升不下降」就是類別洩漏

                最常見的真實成因：
                  Mockito / Spring 的測試 context 沒被清掉 → 測試套件跑到後面 OOM
                  修法：@DirtiesContext 用得節制、Mockito 的 mockStatic 一定要 close
                """);
    }

    static byte[] generateSimpleClass(String name) {
        return new byte[0];      // 示範用；真實情況用 ASM / ByteBuddy
    }
}
```

---

## 9.6 類別載入機制

### 五個階段

```
載入 (Loading)
  → 讀取 .class 位元組流，在 Metaspace 建立 Class 物件
     ↓
連結 (Linking)
  ├─ 驗證 (Verification)  檢查 bytecode 合法性（防止惡意 class 檔）
  ├─ 準備 (Preparation)   為 static 欄位配置記憶體並設「零值」
  │                        （注意：static int x = 5 在此階段是 0，不是 5！）
  └─ 解析 (Resolution)    把常量池的符號參考換成直接參考（可延遲）
     ↓
初始化 (Initialization)
  → 執行 <clinit>：static 欄位的賦值 + static 區塊（第 02 章 2.8 節）
     ★ 這一步是「執行緒安全」的，JVM 保證只執行一次
     → 這就是 8.6 節「Holder 單例」為什麼安全的原因
```

```java
public class ClassInitOrder {

    static class Holder {
        static int value = 5;                   // 準備階段是 0，初始化階段才變 5
        static final int CONSTANT = 10;         // ⚠️ 編譯期常量，會被「內聯」到使用處
        static final String LAZY = compute();   // 不是編譯期常量，正常初始化

        static {
            System.out.println("  → Holder 的 static 區塊執行了");
        }

        static String compute() {
            System.out.println("  → compute() 執行了");
            return "computed";
        }
    }

    public static void main(String[] args) {
        System.out.println("=== 什麼會觸發類別初始化 ===");

        System.out.println("\n① 讀取 static final 的「編譯期常量」→ 不會觸發初始化！");
        System.out.println("  Holder.CONSTANT = " + Holder.CONSTANT);
        System.out.println("  （沒有看到 static 區塊的輸出 —— 因為 10 在編譯時就被寫進這裡了）");

        System.out.println("\n② 讀取一般的 static 欄位 → 觸發初始化");
        System.out.println("  Holder.value = " + Holder.value);

        System.out.println("""

                會觸發初始化的動作：
                  - new 一個實例
                  - 讀寫「非編譯期常量」的 static 欄位
                  - 呼叫 static 方法
                  - 反射 Class.forName("X")（第二個參數 initialize 預設 true）
                  - 初始化子類別時，先初始化父類別
                  - 作為 main 方法所在的類別

                不會觸發的：
                  - 讀取 static final 的編譯期常量（int / String 常值等）
                  - 透過子類別存取父類別的 static 欄位（只初始化父類別）
                  - 宣告一個陣列 new X[10]
                  - Class.forName("X", false, loader)
                  - X.class

                ⚠️ 「編譯期常量會被內聯」的實務後果：
                   函式庫 A 有 public static final int VERSION = 1;
                   你的程式碼引用它 → 編譯後你的 .class 裡直接寫著 1
                   函式庫升級成 VERSION = 2，但你沒重新編譯 → 你的程式仍看到 1
                   ★ 這是「明明升級了但常數沒變」的原因。解法：重新編譯，或改用方法取值。
                """);
    }
}
```

輸出：

```
=== 什麼會觸發類別初始化 ===

① 讀取 static final 的「編譯期常量」→ 不會觸發初始化！
  Holder.CONSTANT = 10
  （沒有看到 static 區塊的輸出 —— 因為 10 在編譯時就被寫進這裡了）

② 讀取一般的 static 欄位 → 觸發初始化
  → compute() 執行了
  → Holder 的 static 區塊執行了
  Holder.value = 5
```

### 雙親委派模型

```java
public class ClassLoaderHierarchy {

    public static void main(String[] args) {
        System.out.println("""
                === 雙親委派（Parent Delegation）===

                  Bootstrap ClassLoader（C++ 實作，getClassLoader() 回傳 null）
                       ↑ 載入 java.base 等平台模組（java.lang.*, java.util.*）
                       │
                  Platform ClassLoader（Java 9+ 取代了 Extension ClassLoader）
                       ↑ 載入其他平台模組（java.sql, java.xml…）
                       │
                  Application ClassLoader
                       ↑ 載入 classpath / modulepath 上的類別（你的程式碼）
                       │
                  自訂 ClassLoader（Tomcat 的 WebAppClassLoader、OSGi、Spring Boot 的 LaunchedURLClassLoader）

                載入流程：
                  ① 收到載入請求 → 先「委派給父載入器」
                  ② 父載入器也先委派給它的父
                  ③ 一路到 Bootstrap
                  ④ 父載入器找不到 → 才自己嘗試載入

                為什麼要這樣？
                  ★ 安全：你寫一個 java.lang.String 放進 classpath，也不會被載入
                    （Bootstrap 先載入了真正的 String）
                  ★ 唯一性：同一個類別不會被載入兩次
                """);

        System.out.println("=== 實際觀察 ===");
        show(String.class);
        show(java.sql.Driver.class);
        show(ClassLoaderHierarchy.class);

        System.out.println("\n=== 載入器鏈 ===");
        ClassLoader loader = ClassLoaderHierarchy.class.getClassLoader();
        while (loader != null) {
            System.out.println("  " + loader);
            loader = loader.getParent();
        }
        System.out.println("  null（Bootstrap ClassLoader）");

        System.out.println("""

                === 類別的「唯一標識」是 (全限定名 + ClassLoader) ===
                  同一個 com.example.Foo，由兩個不同的 ClassLoader 載入
                  → 是「兩個不同的類別」！
                  → instanceof 為 false、轉型會丟 ClassCastException

                  這是「明明是同一個類別為什麼 ClassCastException」的原因，
                  常見於：Tomcat 熱部署、OSGi、把同一個 jar 放進兩個地方。
                """);

        // ===== ClassNotFoundException vs NoClassDefFoundError =====
        System.out.println("=== 兩個容易混淆的錯誤 ===");
        try {
            Class.forName("com.example.DoesNotExist");
        } catch (ClassNotFoundException e) {
            System.out.println("""
                      ClassNotFoundException（是 Exception，checked）
                        意思：執行期「主動」找一個類別（Class.forName / loadClass）但找不到
                        常見原因：JDBC driver 名稱打錯、反射的類別名稱寫錯、依賴沒加
                    """);
        }

        System.out.println("""
                  NoClassDefFoundError（是 Error）
                    意思：編譯時「有」這個類別，執行時卻找不到 —— 或者
                          它的「靜態初始化曾經失敗過」（第 02 章 2.8 節）
                    常見原因：
                      ① 編譯與執行的 classpath 不一致（打包漏了依賴）
                      ② 依賴衝突：載入到不相容的版本
                      ③ ★ 第一次存取時 <clinit> 丟了 ExceptionInInitializerError，
                        第二次存取就變成 NoClassDefFoundError
                        → 看 log 一定要往「最早」翻，找到那個 ExceptionInInitializerError
                """);
    }

    static void show(Class<?> clazz) {
        ClassLoader cl = clazz.getClassLoader();
        System.out.printf("  %-30s → %s%n", clazz.getName(),
                cl == null ? "Bootstrap（null）" : cl.getName() + " " + cl.getClass().getSimpleName());
    }
}
```

輸出：

```
=== 實際觀察 ===
  java.lang.String               → Bootstrap（null）
  java.sql.Driver                → platform ClassLoaders$PlatformClassLoader
  ClassLoaderHierarchy           → app ClassLoaders$AppClassLoader

=== 載入器鏈 ===
  jdk.internal.loader.ClassLoaders$AppClassLoader@2f0e140b
  jdk.internal.loader.ClassLoaders$PlatformClassLoader@1b6d3586
  null（Bootstrap ClassLoader）
```

---

## 9.7 物件的記憶體佈局

```java
public class ObjectLayout {

    static class Empty { }

    static class WithFields {
        boolean flag;      // 1 byte
        int number;        // 4 bytes
        long id;           // 8 bytes
        String name;       // 4 bytes（開啟指標壓縮）或 8 bytes
    }

    public static void main(String[] args) {
        System.out.println("""
                === 64 位元 JVM 的物件佈局 ===

                ┌─────────────────────────────────────────────┐
                │ 物件標頭 (Object Header)                     │
                │  ├─ Mark Word         8 bytes               │
                │  │   存：hashCode、GC 分代年齡、鎖狀態         │
                │  │   （synchronized 的偏向鎖/輕量鎖就存在這裡） │
                │  └─ Class Pointer     4 bytes（壓縮）/ 8      │
                │      指向 Metaspace 裡的 Class 物件            │
                ├─────────────────────────────────────────────┤
                │ 實例資料 (Instance Data)                     │
                │  各欄位。JVM 會「重排」欄位順序以減少填充        │
                │  順序大致：long/double → int/float →          │
                │           short/char → byte/boolean → 參考    │
                ├─────────────────────────────────────────────┤
                │ 對齊填充 (Padding)                           │
                │  補到 8 bytes 的倍數                          │
                └─────────────────────────────────────────────┘

                【Java 25】Compact Object Headers（JEP 519，正式功能）
                  用 -XX:+UseCompactObjectHeaders 把標頭從 12 bytes 壓到 8 bytes
                  → 小物件密集的應用可省 10%~20% 堆積
                  （Java 24 是實驗性 JEP 450）

                === 常見物件的大小估算（64 位元、開啟指標壓縮）===
                  Object                    16 bytes（12 標頭 + 4 填充）
                  Integer                   16 bytes（12 + 4 int）
                  Long                      24 bytes（12 + 8 + 4 填充）
                  空 String                 40 bytes（String 物件 24 + 空 byte[] 16）
                  "hello"（Latin-1）        40 bytes（24 + byte[5] → 16+5→24）
                  空 ArrayList              ~40 bytes（+ 首次 add 時的 Object[10] = 56）
                  空 HashMap                ~48 bytes（+ 首次 put 時的 Node[16] = 80）
                  HashMap 的每個 Entry      ~32 bytes（★ 這是 Map 很吃記憶體的原因）
                """);

        System.out.println("=== 用配置量反推物件大小 ===");
        measure("Object", Object::new);
        measure("Integer(i)", () -> Integer.valueOf(100_000));       // 超出快取範圍
        measure("Long(i)", () -> Long.valueOf(100_000L));
        measure("String(16 chars)", () -> new String(new char[16]));
        measure("空 ArrayList", java.util.ArrayList::new);
        measure("空 HashMap", java.util.HashMap::new);
        measure("HashMap 1 entry", () -> {
            var m = new java.util.HashMap<Integer, Integer>();
            m.put(1, 2);
            return m;
        });

        System.out.println("""

                ⚠️ 上面是「粗略估算」。要精確測量請用：
                  ① JOL (Java Object Layout)：org.openjdk.jol:jol-core
                     System.out.println(ClassLayout.parseInstance(obj).toPrintable());
                  ② Eclipse MAT 分析 heap dump（9.12 節）

                === 實務意義：估算快取容量 ===
                  「我要快取 100 萬個 Order 物件，需要多少記憶體？」

                  假設 Order 有 10 個欄位（3 個 long、2 個 int、5 個 String 參考）
                    Order 物件本身      ≈ 12 + 24 + 8 + 20 + 填充 ≈ 72 bytes
                    5 個 String（各 20 字元）≈ 5 × 56 = 280 bytes
                    HashMap Entry       ≈ 32 bytes
                    Long key（超出快取） ≈ 24 bytes
                    ────────────────────────────────────
                    每筆合計 ≈ 410 bytes
                    100 萬筆 ≈ 410 MB（還沒算 HashMap 的 table 陣列與 GC 開銷）

                  → 這種估算能在「決定要不要用本地快取」時省下一次線上事故。
                    答案通常是：改用 Redis，或用 Caffeine 設 maximumSize。
                """);
    }

    static void measure(String label, java.util.function.Supplier<Object> factory) {
        int n = 100_000;
        Object[] hold = new Object[n];

        System.gc();
        sleep(50);
        long before = used();

        for (int i = 0; i < n; i++) hold[i] = factory.get();

        long after = used();
        long perObject = (after - before) / n;
        System.out.printf("  %-20s ≈ %,3d bytes/物件%n", label, perObject);

        // 用一下 hold 避免被最佳化掉
        if (hold[0] == null) System.out.print("");
    }

    static long used() {
        Runtime rt = Runtime.getRuntime();
        return rt.totalMemory() - rt.freeMemory();
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

典型輸出（數字會有波動，因為 `System.gc()` 只是建議）：

```
=== 用配置量反推物件大小 ===
  Object               ≈  16 bytes/物件
  Integer(i)           ≈  16 bytes/物件
  Long(i)              ≈  24 bytes/物件
  String(16 chars)     ≈  56 bytes/物件
  空 ArrayList         ≈  40 bytes/物件
  空 HashMap           ≈  48 bytes/物件
  HashMap 1 entry      ≈ 216 bytes/物件
```

> **指標壓縮（Compressed Oops）**：堆積 ≤ 32GB 時，JVM 用 4 bytes 存物件參考而非 8 bytes，
> 省下大量記憶體。**超過 32GB 就會關閉這個最佳化**——所以
> **`-Xmx31g` 的實際可用容量可能比 `-Xmx33g` 還多**。
> 需要超過 32GB 堆積時，先考慮「拆成多個實例」。

---

## 9.8 GC Roots 與可達性分析

### 什麼物件會被回收

```java
public class ReachabilityAnalysis {

    static Object staticField;                       // ★ GC Root

    public static void main(String[] args) {
        System.out.println("""
                === GC Roots（垃圾回收的起點）===

                  ① 執行緒堆疊中的區域變數與參數（★ 最主要的來源）
                  ② static 欄位
                  ③ 常量（如 String 常量池的引用）
                  ④ JNI 引用（native code 持有的物件）
                  ⑤ 正在執行的方法所屬的 Class
                  ⑥ 同步鎖持有的物件（synchronized 的那個物件）
                  ⑦ JVM 內部的引用（系統類別載入器、基本例外物件等）

                === 可達性分析（Reachability Analysis）===

                  從所有 GC Roots 出發，沿著引用走訪。
                  ★ 走得到 = 存活；走不到 = 垃圾

                  GC Root ──→ A ──→ B ──→ C        A、B、C 存活
                                     ↑
                  D ←──→ E ──────────┘             D、E 互相參考但 Root 走不到 → 都是垃圾
                                                    （所以 Java 沒有循環引用的問題，
                                                      不像引用計數法）
                """);

        // ===== 示範：局部變數作用域結束後就變垃圾 =====
        {
            Object local = new Object();
            System.out.println("區塊內: local 可達");
        }
        // 離開區塊後 local 不可達（但注意：JVM 可能在區塊結束「之前」就判定它是垃圾，
        // 只要後面不再用到——這叫「作用域最佳化」）

        // ===== static 欄位是 GC Root，所以這個物件永遠不死 =====
        staticField = new byte[10 * 1024 * 1024];      // 10MB
        System.out.println("\nstatic 欄位持有 10MB → 永遠不會被回收（除非手動設 null）");

        System.gc();
        sleep(100);
        System.out.printf("GC 後已用: %,d MB（10MB 還在）%n", usedMb());

        staticField = null;                            // ✅ 手動斷開
        System.gc();
        sleep(100);
        System.out.printf("設 null 並 GC 後: %,d MB%n", usedMb());

        System.out.println("""

                ⚠️ 「static 集合永不回收」是最常見的記憶體洩漏（9.11 節）：
                     public static Map<String, Order> CACHE = new HashMap<>();
                   放進去的東西永遠是 GC Root 可達的 → 永遠不死。
                """);
    }

    static long usedMb() {
        Runtime rt = Runtime.getRuntime();
        return (rt.totalMemory() - rt.freeMemory()) / 1024 / 1024;
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

### 四種引用型別

```java
import java.lang.ref.*;
import java.util.HashMap;
import java.util.Map;
import java.util.WeakHashMap;

public class ReferenceTypes {

    public static void main(String[] args) throws InterruptedException {
        System.out.println("""
                ┌──────────┬────────────────────────────┬──────────────────────────┐
                │ 型別      │ 什麼時候被回收              │ 實務用途                  │
                ├──────────┼────────────────────────────┼──────────────────────────┤
                │ 強引用    │ 永不（只要可達）             │ 一般的 Object o = new ... │
                │ Soft      │ 記憶體不足時                │ 記憶體敏感的快取           │
                │ Weak      │ 下次 GC（只要沒有強引用）    │ 規範化映射、ThreadLocalMap │
                │ Phantom   │ 物件已被回收後（做清理用）    │ 資源清理（取代 finalize） │
                └──────────┴────────────────────────────┴──────────────────────────┘
                """);

        // ===== WeakReference：GC 就會被清掉 =====
        System.out.println("=== WeakReference ===");
        Object strong = new Object();
        WeakReference<Object> weak = new WeakReference<>(strong);
        System.out.println("  有強引用時 GC 後: " + (weak.get() != null ? "還在" : "沒了"));

        strong = null;              // 斷開強引用
        System.gc();
        Thread.sleep(100);
        System.out.println("  斷開強引用後 GC: " + (weak.get() != null ? "還在" : "沒了 ✅"));

        // ===== WeakHashMap：key 沒人用了，整個 entry 自動消失 =====
        System.out.println("\n=== WeakHashMap（自動清理的快取）===");
        Map<Object, String> weakMap = new WeakHashMap<>();
        Map<Object, String> strongMap = new HashMap<>();

        Object key1 = new Object();
        Object key2 = new Object();
        weakMap.put(key1, "value1");
        weakMap.put(key2, "value2");
        strongMap.put(key1, "value1");
        strongMap.put(key2, "value2");

        System.out.println("  放入後  WeakHashMap size: " + weakMap.size()
                + "，HashMap size: " + strongMap.size());

        key1 = null;                // key1 沒人用了
        System.gc();
        Thread.sleep(200);

        System.out.println("  key1=null 後 WeakHashMap size: " + weakMap.size()
                + "，HashMap size: " + strongMap.size() + "  ← HashMap 永遠不會縮");

        System.out.println("""

                ⚠️ WeakHashMap 的一個經典誤用：
                     Map<String, byte[]> cache = new WeakHashMap<>();
                     cache.put("key", bigData);      // key 是字串常值 → 在常量池 → 永遠是 GC Root！
                   → 永遠不會被清掉。WeakHashMap 只在「key 是普通物件」時有效。

                ⚠️ 另一個誤用：value 反過來持有 key 的強引用
                     weakMap.put(user, new Session(user));   // Session 裡有 user 的強引用
                   → key 永遠可達，永遠不會被清。
                """);

        // ===== SoftReference：記憶體不足才清 =====
        System.out.println("=== SoftReference（記憶體敏感的快取）===");
        SoftReference<byte[]> soft = new SoftReference<>(new byte[1024 * 1024]);
        System.gc();
        Thread.sleep(100);
        System.out.println("  一般 GC 後 SoftReference: "
                + (soft.get() != null ? "還在 ✅（記憶體還夠）" : "被清了"));
        System.out.println("""
                  → 只有在「即將 OOM」時才會被清。
                  ⚠️ 但實務上不建議用 SoftReference 做快取：
                     ① 清理時機不可控，可能一次清光造成效能斷崖
                     ② 讓 GC 更難調校（每次 Full GC 都要決定清不清）
                     ③ 沒有容量上限、沒有 TTL、沒有統計
                     ✅ 用 Caffeine：有 maximumSize、expireAfterWrite、命中率統計
                """);

        // ===== PhantomReference + Cleaner：資源清理 =====
        System.out.println("=== Cleaner（取代 finalize）===");
        demonstrateCleaner();

        System.out.println("""

                ⚠️ finalize() 已在 Java 18 標記為棄用，Java 21 預設停用！
                   它的問題：
                     - 執行時機完全不確定（可能永遠不執行）
                     - 讓物件「復活」，破壞 GC 假設
                     - 在單一 finalizer 執行緒上執行，一個卡住全部卡住
                     - 讓物件多活一個 GC 週期

                   ✅ 替代方案（依優先順序）：
                     ① try-with-resources + AutoCloseable（第 04 章 4.8 節）★ 首選
                     ② java.lang.ref.Cleaner 作為「忘記 close 時的最後保險」
                """);
    }

    /** Cleaner 的正確用法：作為 try-with-resources 的補強，不是取代 */
    static void demonstrateCleaner() throws InterruptedException {
        var cleaner = Cleaner.create();

        class NativeResource implements AutoCloseable {
            /** ⚠️ 清理動作「絕對不能」持有外層物件的引用，否則它永遠不會被回收 */
            private record State(String name) implements Runnable {
                @Override
                public void run() {
                    System.out.println("    [Cleaner] 釋放資源: " + name);
                }
            }

            private final State state;
            private final Cleaner.Cleanable cleanable;

            NativeResource(String name) {
                this.state = new State(name);
                this.cleanable = cleaner.register(this, state);
                System.out.println("    開啟資源: " + name);
            }

            @Override
            public void close() {
                cleanable.clean();          // 明確關閉時立刻清理
            }
        }

        System.out.println("  ① 正常使用 try-with-resources:");
        try (var r = new NativeResource("resource-A")) {
            // 使用資源
        }

        System.out.println("  ② 忘記 close（Cleaner 當保險）:");
        new NativeResource("resource-B");    // 沒有 close！
        System.gc();
        Thread.sleep(300);
    }
}
```

輸出（節錄）：

```
=== WeakReference ===
  有強引用時 GC 後: 還在
  斷開強引用後 GC: 沒了 ✅

=== WeakHashMap（自動清理的快取）===
  放入後  WeakHashMap size: 2，HashMap size: 2
  key1=null 後 WeakHashMap size: 1，HashMap size: 2  ← HashMap 永遠不會縮

=== Cleaner（取代 finalize）===
  ① 正常使用 try-with-resources:
    開啟資源: resource-A
    [Cleaner] 釋放資源: resource-A
  ② 忘記 close（Cleaner 當保險）:
    開啟資源: resource-B
    [Cleaner] 釋放資源: resource-B
```

> **`Cleaner` 的關鍵設計約束**：清理動作（那個 `Runnable`）**不能持有被清理物件的引用**。
> 上面用 `record State` 是刻意的——它是靜態的，不會捕捉外層 `this`（第 02 章 2.12 節）。
> 如果寫成 `cleaner.register(this, () -> System.out.println(this.name))`，
> lambda 捕捉了 `this`，物件永遠不可達不了 → Cleaner 永遠不觸發。

---

## 9.9 GC 演算法

```java
public class GcAlgorithms {

    public static void main(String[] args) {
        System.out.println("""
                === 三種基礎演算法 ===

                ① 標記-清除 (Mark-Sweep)
                   標記存活 → 清除垃圾
                   [A][ ][B][ ][ ][C][ ]     ← 留下大量碎片
                   優點：不用移動物件
                   缺點：碎片化 → 明明有 100MB 空間卻配置不了 1MB 的陣列

                ② 標記-複製 (Mark-Copy)
                   把空間切兩半，只用一半；GC 時把存活物件複製到另一半
                   [A][B][C][ ][ ]  →  [ ][ ][ ][ ][ ] + [A][B][C][ ][ ]
                   優點：無碎片、配置極快（指標碰撞）
                   缺點：浪費一半空間
                   ★ 適合「存活率低」的新生代（Eden + 兩個 Survivor 就是這個變體，
                     只浪費 10% 而不是 50%）

                ③ 標記-整理 (Mark-Compact)
                   標記存活 → 把存活物件往一端移動 → 清掉邊界外的空間
                   [A][ ][B][ ][C]  →  [A][B][C][ ][ ]
                   優點：無碎片、不浪費空間
                   缺點：移動物件成本高（要更新所有指向它的引用）
                   ★ 適合「存活率高」的老年代

                === 分代收集 = 針對不同區域用不同演算法 ===
                   新生代（存活率 ~2%） → 標記-複製
                   老年代（存活率 ~90%）→ 標記-整理 或 標記-清除

                === 兩個實作上的關鍵概念 ===

                【Stop-The-World (STW)】
                  GC 必須在「所有應用執行緒都停下來」的時刻做某些工作
                  （否則物件圖一直在變，標記結果不可靠）
                  → 這就是「GC 停頓」。現代 GC 的主要目標就是縮短它。

                【三色標記 + 寫屏障】
                  為了讓「標記」能與應用程式並行，需要處理
                  「標記過程中引用被改掉」的問題。
                  做法：白（未訪問）/ 灰（已訪問但子節點未完）/ 黑（完成）
                  加上「寫屏障」攔截引用變更 → 併發標記才正確。
                  代價：每次寫入引用都多幾條指令（這是 G1/ZGC 的固定開銷來源）
                """);
    }
}
```

### 收集器選型

| 收集器 | 啟用參數 | 停頓 | 吞吐 | 適合 |
|---|---|---|---|---|
| **Serial** | `-XX:+UseSerialGC` | 長 | 低 | 堆積 < 100MB、單核心、CLI 工具 |
| **Parallel** | `-XX:+UseParallelGC` | 較長 | **最高** | 批次處理、離線運算（不在意停頓） |
| **G1**（預設） | `-XX:+UseG1GC` | 中（可設目標） | 高 | **絕大多數線上服務** |
| **ZGC** | `-XX:+UseZGC` | **極短（< 1ms）** | 稍低 | 大堆積（> 16GB）、低延遲要求 |
| **Shenandoah** | `-XX:+UseShenandoahGC` | 極短 | 稍低 | 同 ZGC（Red Hat 主推） |
| **Epsilon** | `-XX:+UseEpsilonGC` | 無 GC | — | 測試用（完全不回收，滿了就 OOM） |

```java
public class CollectorChoice {

    public static void main(String[] args) {
        System.out.println("=== 當前收集器 ===");
        for (var gc : java.lang.management.ManagementFactory.getGarbageCollectorMXBeans()) {
            System.out.println("  " + gc.getName());
        }

        System.out.println("""

                === G1（Garbage First）：目前的預設，先弄懂它 ===

                核心概念：把堆積切成 2048 個等大的 Region（每個 1MB~32MB）
                  ┌────┬────┬────┬────┬────┬────┬────┬────┐
                  │ E  │ O  │ E  │ S  │ O  │ H  │ E  │free│
                  └────┴────┴────┴────┴────┴────┴────┴────┘
                  E=Eden  S=Survivor  O=Old  H=Humongous（大物件）

                  ★ Region 的角色是「動態的」：這次是 Eden，下次可能變 Old
                  ★ 「Garbage First」= 優先回收垃圾最多的 Region
                    → 用最小的成本換最大的空間

                關鍵參數：
                  -Xms / -Xmx                     ★ 兩者設成一樣
                  -XX:MaxGCPauseMillis=200        停頓目標（預設 200ms）
                                                  G1 會自己調新生代大小去達成
                  -XX:G1HeapRegionSize=           Region 大小（通常不用調）
                  -XX:InitiatingHeapOccupancyPercent=45
                                                  老年代佔比達到這個值就啟動併發標記

                ⚠️ 不要同時設 -Xmn / -XX:NewRatio 和 MaxGCPauseMillis
                   —— 固定新生代大小會讓 G1 無法自動調校，通常變更差。

                === ZGC：需要極低延遲時 ===
                  -XX:+UseZGC
                  Java 21 起「分代 ZGC」（-XX:+ZGenerational）大幅改善吞吐
                  Java 23 起分代成為預設，非分代已棄用

                  特點：停頓時間「不隨堆積大小成長」（< 1ms，即使 16TB 堆積）
                  代價：吞吐量比 G1 低約 5~15%，而且吃更多記憶體（染色指標 + 多重映射）

                === 選型決策 ===
                  堆積 < 4GB，一般 Web 服務        → G1（預設，不用改）
                  堆積 4~16GB，P99 延遲要求嚴格     → G1 + 調 MaxGCPauseMillis
                  堆積 > 16GB 或要求 P99 < 10ms    → ZGC
                  批次 / ETL / 離線運算            → Parallel（吞吐最高）
                  CLI 工具 / Lambda 函式           → Serial（啟動最快、開銷最小）

                ★ 最重要的一句話：
                  「先確認你真的有 GC 問題，再考慮換收集器。」
                  90% 的「GC 問題」其實是記憶體洩漏或堆積設太小（9.11 節）。
                  換收集器不會治好洩漏。
                """);
    }
}
```

### 實測不同收集器

```java
public class GcBenchmark {

    /**
     * 分別用以下參數執行，比較「總耗時」與「最長停頓」：
     *   java -Xmx1g -Xms1g -XX:+UseSerialGC   -Xlog:gc GcBenchmark
     *   java -Xmx1g -Xms1g -XX:+UseParallelGC -Xlog:gc GcBenchmark
     *   java -Xmx1g -Xms1g -XX:+UseG1GC       -Xlog:gc GcBenchmark
     *   java -Xmx1g -Xms1g -XX:+UseZGC        -Xlog:gc GcBenchmark
     */
    public static void main(String[] args) {
        int cacheSize = 200_000;
        var cache = new java.util.LinkedHashMap<Integer, byte[]>(cacheSize * 4 / 3) {
            @Override
            protected boolean removeEldestEntry(java.util.Map.Entry<Integer, byte[]> eldest) {
                return size() > cacheSize;       // LRU（第 05 章 5.6 節）
            }
        };

        long start = System.currentTimeMillis();
        long maxPause = 0;
        long lastTick = start;

        for (int i = 0; i < 3_000_000; i++) {
            // 混合負載：短命的臨時物件 + 長命的快取物件
            byte[] temp = new byte[256];
            temp[0] = (byte) i;
            if (i % 10 == 0) {
                cache.put(i, new byte[512]);
            }

            // 每 10 萬次量一次「兩次迭代之間的最長間隔」≈ 觀測到的停頓
            if (i % 100_000 == 0) {
                long now = System.currentTimeMillis();
                maxPause = Math.max(maxPause, now - lastTick);
                lastTick = now;
            }
        }

        long elapsed = System.currentTimeMillis() - start;

        long gcCount = 0, gcTime = 0;
        for (var gc : java.lang.management.ManagementFactory.getGarbageCollectorMXBeans()) {
            gcCount += gc.getCollectionCount();
            gcTime += gc.getCollectionTime();
        }

        System.out.printf("""
                收集器      : %s
                總耗時      : %,d ms
                GC 次數     : %,d
                GC 累計耗時 : %,d ms（佔 %.1f%%）
                最大觀測間隔: %,d ms
                快取筆數    : %,d
                %n""",
                java.lang.management.ManagementFactory.getGarbageCollectorMXBeans()
                        .stream().map(java.lang.management.GarbageCollectorMXBean::getName)
                        .reduce((a, b) -> a + " + " + b).orElse("?"),
                elapsed, gcCount, gcTime, gcTime * 100.0 / elapsed, maxPause, cache.size());
    }
}
```

典型結果（`-Xmx1g -Xms1g`，數字會因機器而異）：

```
收集器      : Copy + MarkSweepCompact          （Serial）
總耗時      : 4,820 ms
GC 次數     : 312
GC 累計耗時 : 1,240 ms（佔 25.7%）
最大觀測間隔: 186 ms

收集器      : PS MarkSweep + PS Scavenge       （Parallel）
總耗時      : 3,150 ms
GC 次數     : 198
GC 累計耗時 : 420 ms（佔 13.3%）
最大觀測間隔: 92 ms

收集器      : G1 Young Generation + G1 Old Generation + G1 Concurrent GC
總耗時      : 3,410 ms
GC 次數     : 245
GC 累計耗時 : 310 ms（佔 9.1%）
最大觀測間隔: 38 ms         ← 停頓明顯最短

收集器      : ZGC Cycles + ZGC Pauses
總耗時      : 3,890 ms      ← 吞吐略低
GC 累計耗時 : 8 ms（佔 0.2%）
最大觀測間隔: 12 ms         ← 停頓極短
```

> **這張表就是選型的依據**：Parallel 總耗時最短（吞吐最高），G1 停頓最短且吞吐接近，
> ZGC 停頓極短但吞吐略低。**Web 服務在意 P99 延遲 → G1 或 ZGC；批次在意總時間 → Parallel。**

---

## 9.10 六種 `OutOfMemoryError`

```java
public class OomTypes {

    public static void main(String[] args) {
        System.out.println("""
                ┌───────────────────────────────────┬────────────────────────────────────────┐
                │ 訊息                              │ 意思與診斷方向                          │
                ├───────────────────────────────────┼────────────────────────────────────────┤
                │ Java heap space                   │ ★ 最常見。堆積不夠                      │
                │                                   │ → 是洩漏？還是真的需要更多？（9.11 節） │
                ├───────────────────────────────────┼────────────────────────────────────────┤
                │ GC overhead limit exceeded        │ 花了 >98% 時間 GC 但只回收 <2% 空間     │
                │                                   │ → 幾乎一定是洩漏。這是 heap space 的前兆 │
                ├───────────────────────────────────┼────────────────────────────────────────┤
                │ Metaspace                         │ 類別太多，或 ClassLoader 洩漏（9.5 節）  │
                ├───────────────────────────────────┼────────────────────────────────────────┤
                │ unable to create new native thread│ 執行緒數超過 OS 限制，或本機記憶體用完   │
                │                                   │ → 檢查 ulimit -u、執行緒池是否無上限    │
                ├───────────────────────────────────┼────────────────────────────────────────┤
                │ Direct buffer memory              │ DirectByteBuffer 用完                   │
                │                                   │ → 檢查 -XX:MaxDirectMemorySize、Netty   │
                ├───────────────────────────────────┼────────────────────────────────────────┤
                │ Requested array size exceeds      │ 想配置超過 Integer.MAX_VALUE-ish 的陣列  │
                │ VM limit                          │ → 通常是計算錯誤（負數或溢位，第 01 章）  │
                └───────────────────────────────────┴────────────────────────────────────────┘

                ★ 一定要加的啟動參數（讓 OOM 自動留下證據）：

                  -XX:+HeapDumpOnOutOfMemoryError
                  -XX:HeapDumpPath=/var/log/app/heapdump.hprof
                  -XX:+ExitOnOutOfMemoryError          ← 讓容器重啟，不要撐著半死不活

                  ⚠️ HeapDumpPath 所在的磁碟要有「至少 -Xmx 大小」的空間，
                     否則 dump 寫不完，證據就沒了。
                """);
    }

    /** 逐一重現（每個都要單獨執行，並帶對應的 JVM 參數） */
    static void reproduce(String type) {
        switch (type) {
            // java -Xmx64m OomTypes heap
            case "heap" -> {
                var list = new java.util.ArrayList<byte[]>();
                while (true) list.add(new byte[1024 * 1024]);
            }
            // java -Xmx64m -XX:-UseGCOverheadLimit 拿掉這個參數才會出現 overhead 錯誤
            case "overhead" -> {
                var map = new java.util.HashMap<Integer, String>();
                for (int i = 0; ; i++) map.put(i, String.valueOf(i));
            }
            // java -XX:MaxMetaspaceSize=32m
            case "metaspace" -> {
                // 見 9.5 節的 MetaspaceLeak
            }
            // java -Xss1m（然後開幾萬條執行緒）
            case "thread" -> {
                while (true) new Thread(() -> {
                    try { Thread.sleep(Long.MAX_VALUE); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }).start();
            }
            // java -XX:MaxDirectMemorySize=32m
            case "direct" -> {
                var list = new java.util.ArrayList<java.nio.ByteBuffer>();
                while (true) list.add(java.nio.ByteBuffer.allocateDirect(1024 * 1024));
            }
            // 任何參數
            case "arraysize" -> {
                int size = Integer.MAX_VALUE;
                byte[] huge = new byte[size];
            }
            default -> throw new IllegalArgumentException("未知類型: " + type);
        }
    }
}
```

### 「是洩漏還是需要更多記憶體」——怎麼判斷

```java
public class LeakOrNot {

    public static void main(String[] args) {
        System.out.println("""
                === 判斷流程 ===

                ① 看 GC 日誌的「Full GC 之後的已用量」隨時間變化

                   正常（用量高但穩定）：
                     Full GC: 1800M -> 400M
                     Full GC: 1850M -> 410M
                     Full GC: 1820M -> 405M      ← 谷底穩定在 400M 附近
                     結論：真的需要這麼多記憶體 → 加 -Xmx 或優化資料結構

                   洩漏（谷底持續升高）：
                     Full GC: 1800M ->  400M
                     Full GC: 1850M ->  800M
                     Full GC: 1900M -> 1200M
                     Full GC: 1950M -> 1600M     ← 谷底一路漲，遲早 OOM
                     結論：★ 記憶體洩漏，加 -Xmx 只是延後死亡時間

                ② 看 Full GC 的頻率
                   從「一天一次」變成「一小時一次」再變成「一分鐘一次」
                   → 典型的洩漏惡化曲線

                ③ 抓兩個時間點的 heap dump 做「差異比較」
                   哪個類別的實例數持續增加 → 就是它

                === 一行指令看趨勢 ===

                  # 每 5 秒印一次各代的用量（單位 KB）
                  jstat -gcutil <pid> 5000

                  # 輸出範例
                  #  S0     S1     E      O      M     CCS    YGC   YGCT   FGC  FGCT   GCT
                  #  0.00  92.31  45.20  62.15  95.42  92.11   142   1.823    3  0.412  2.235
                  #                        ↑ O（老年代佔比）持續升高就是警訊

                  # 看物件數量排行（不需要 dump 整個堆積，很快）
                  jcmd <pid> GC.class_histogram | head -25
                """);
    }
}
```

---

## 9.11 實作一個記憶體洩漏，然後抓出它

這是本章最重要的一節。我們**故意**做一個洩漏，然後走完整的診斷流程。

### 洩漏版本

```java
package com.example.todo.leak;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * ⚠️ 這是「刻意寫壞」的版本，包含四個真實世界最常見的記憶體洩漏。
 * 用來練習診斷流程。
 */
public class LeakyTodoService {

    // ===== 洩漏 1：static 集合，永不清理（最常見）=====
    // 每次操作都記錄一筆稽核，但永遠不刪
    private static final List<AuditEntry> AUDIT_LOG = new ArrayList<>();

    record AuditEntry(long timestamp, String action, Todo snapshot, String stackTrace) { }

    // ===== 洩漏 2：快取沒有容量上限、沒有 TTL =====
    private final Map<String, List<Todo>> queryCache = new ConcurrentHashMap<>();

    // ===== 洩漏 3：監聽器註冊了但從不移除 =====
    private final List<TodoListener> listeners = new ArrayList<>();

    interface TodoListener {
        void onChanged(Todo todo);
    }

    // ===== 洩漏 4：ThreadLocal 沒有 remove（第 08 章 8.13 節）=====
    private static final ThreadLocal<Map<Long, Todo>> REQUEST_SCOPE =
            ThreadLocal.withInitial(HashMap::new);

    private long sequence = 0;

    public Todo create(String title, Priority priority) {
        Todo todo = new Todo(++sequence, title, priority, Instant.now());

        // 洩漏 1：稽核紀錄含完整快照 + 堆疊字串（很吃記憶體）
        AUDIT_LOG.add(new AuditEntry(
                System.currentTimeMillis(), "CREATE", todo,
                Arrays.toString(Thread.currentThread().getStackTrace())));

        // 洩漏 2：每個不同的查詢條件都留一份快取
        queryCache.put("byTitle:" + title, List.of(todo));

        // 洩漏 3：每次建立都註冊一個新監聽器（而且是匿名類別，持有外層 this）
        listeners.add(changed -> {
            // 這個 lambda 捕捉了 todo，讓它永遠不死
            if (changed.getId() == todo.getId()) {
                queryCache.remove("byTitle:" + todo.getTitle());
            }
        });

        // 洩漏 4：放進 ThreadLocal 但沒人清
        REQUEST_SCOPE.get().put(todo.getId(), todo);

        return todo;
    }

    public int auditSize() { return AUDIT_LOG.size(); }
    public int cacheSize() { return queryCache.size(); }
    public int listenerCount() { return listeners.size(); }
    public int requestScopeSize() { return REQUEST_SCOPE.get().size(); }
}
```

### 重現與觀察

```java
package com.example.todo.leak;

import com.example.todo.model.Priority;

/**
 * 用這些參數執行，讓它在 OOM 時自動留下 heap dump：
 *
 *   java -Xmx128m -Xms128m \
 *        -XX:+HeapDumpOnOutOfMemoryError \
 *        -XX:HeapDumpPath=/tmp/leak.hprof \
 *        -Xlog:gc \
 *        com.example.todo.leak.LeakReproducer
 */
public class LeakReproducer {

    public static void main(String[] args) throws InterruptedException {
        var service = new LeakyTodoService();
        var rt = Runtime.getRuntime();

        System.out.printf("%-10s %-12s %-12s %-10s %-10s %-12s %s%n",
                "回合", "堆積(MB)", "FullGC後(MB)", "稽核筆數", "快取筆數", "監聽器數", "FullGC 次數");

        int round = 0;
        try {
            while (true) {
                round++;
                for (int i = 0; i < 5_000; i++) {
                    service.create("待辦-" + round + "-" + i, Priority.NORMAL);
                }

                // 強制 Full GC，看「谷底」是否升高 —— 這是判斷洩漏的關鍵（9.10 節）
                System.gc();
                Thread.sleep(100);
                long afterFullGc = (rt.totalMemory() - rt.freeMemory()) / 1024 / 1024;

                long fullGcCount = java.lang.management.ManagementFactory
                        .getGarbageCollectorMXBeans().stream()
                        .filter(gc -> gc.getName().toLowerCase().contains("old")
                                || gc.getName().toLowerCase().contains("marksweep"))
                        .mapToLong(gc -> gc.getCollectionCount()).sum();

                System.out.printf("%-10d %-12d %-12d %-10d %-10d %-12d %d%n",
                        round,
                        (rt.totalMemory() - rt.freeMemory()) / 1024 / 1024,
                        afterFullGc,
                        service.auditSize(), service.cacheSize(),
                        service.listenerCount(), fullGcCount);
            }
        } catch (OutOfMemoryError e) {
            System.err.println("\n💥 OutOfMemoryError: " + e.getMessage());
            System.err.println("Heap dump 已寫到 -XX:HeapDumpPath 指定的位置");
            System.err.println("撐了 " + round + " 回合，共建立 " + service.auditSize() + " 筆");
        }
    }
}
```

輸出：

```
回合       堆積(MB)     FullGC後(MB)  稽核筆數    快取筆數    監聽器數      FullGC 次數
1          22           18            5000       5000       5000         1
2          38           34            10000      10000      10000        2
3          54           51            15000      15000      15000        3
4          71           68            20000      20000      20000        4
5          88           85            25000      25000      25000        5
6          104          101           30000      30000      30000        6
7          118          115           35000      35000      35000        7

💥 OutOfMemoryError: Java heap space
Heap dump 已寫到 -XX:HeapDumpPath 指定的位置
撐了 7 回合，共建立 38412 筆
```

**⭐ 診斷第一步就在這張表裡**：`FullGC後(MB)` 這一欄 **18 → 34 → 51 → 68 → 85 → 101 → 115**，
每回合穩定增加約 17MB。**Full GC 之後的谷底持續升高 = 確定是記憶體洩漏**（9.10 節）。

### 診斷流程：從症狀到根因

```java
public class DiagnosisWorkflow {

    public static void main(String[] args) {
        System.out.println("""
                ══════════════════════════════════════════════════════════════
                步驟 1：確認是洩漏（不要急著抓 dump）
                ══════════════════════════════════════════════════════════════
                  jstat -gcutil <pid> 5000 20

                  看 O（老年代佔比）與 FGC（Full GC 次數）：
                    O 在每次 FGC 後都比上次高 → 洩漏
                    O 高但穩定              → 只是需要更多記憶體

                ══════════════════════════════════════════════════════════════
                步驟 2：快速看物件排行（不用 dump，幾秒完成）
                ══════════════════════════════════════════════════════════════
                  jcmd <pid> GC.class_histogram | head -25

                  輸出範例（本節的洩漏程式）：
                   num     #instances         #bytes  class name
                  ----------------------------------------------
                     1:        192060       36235088  [Ljava.lang.Object;
                     2:         38412       25368320  [Ljava.lang.String;      ← 稽核的堆疊字串
                     3:        460944       18437760  java.lang.String
                     4:         38412        1843776  ...LeakyTodoService$AuditEntry   ★
                     5:         38412        1229184  ...LeakyTodoService$$Lambda      ★
                     6:         38412        1229184  com.example.todo.model.Todo

                  ★ 判讀：AuditEntry 和 Lambda 各有 38412 個 —— 恰好等於建立次數。
                    「實例數 = 操作次數」就是洩漏的鐵證（正常的物件會被回收）。

                  ⚠️ class_histogram 會觸發一次 Full GC，正式環境要小心（會有停頓）。
                    只想看不觸發 GC：jcmd <pid> GC.class_histogram -all

                ══════════════════════════════════════════════════════════════
                步驟 3：抓 heap dump
                ══════════════════════════════════════════════════════════════
                  # 方法 A：主動抓（會 STW，dump 期間服務會停！）
                  jcmd <pid> GC.heap_dump /tmp/heap.hprof

                  # 方法 B：只抓存活物件（檔案小很多，但會先做 Full GC）
                  jmap -dump:live,format=b,file=/tmp/heap.hprof <pid>

                  # 方法 C：★ 最推薦 —— 事先設好，OOM 時自動抓
                  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/log/app/

                  ⚠️ dump 檔大小 ≈ 堆積用量。4GB 的堆積會產生 ~4GB 的檔案，
                     而且產生期間服務會停頓數秒到數十秒。
                     ★ 正式環境的做法：從「負載平衡移除」→ 抓 dump → 重啟。

                ══════════════════════════════════════════════════════════════
                步驟 4：分析 heap dump
                ══════════════════════════════════════════════════════════════
                  工具（依推薦度）：
                    ① Eclipse MAT（Memory Analyzer Tool）★ 最強
                       - Leak Suspects Report：自動指出可疑的洩漏點
                       - Dominator Tree：看誰「支配」最多記憶體
                       - Path to GC Roots：★ 關鍵功能 —— 看是誰在抓著這個物件不放
                    ② VisualVM（JDK 內建的圖形工具，較弱但夠用）
                    ③ JProfiler / YourKit（商業，功能最完整）
                    ④ jhat（已移除，不要找了）

                  MAT 的操作路徑：
                    開啟 dump → Leak Suspects → 找到 "One instance of ArrayList
                    occupies 45MB" → 右鍵 → Path to GC Roots → exclude weak refs
                    → 看到 LeakyTodoService.AUDIT_LOG ← ★ 答案

                ══════════════════════════════════════════════════════════════
                步驟 5：對照程式碼確認
                ══════════════════════════════════════════════════════════════
                  拿到「哪個欄位持有它」之後，回去看那段程式碼。
                  本節的四個洩漏都會被指出來：
                    AUDIT_LOG（static List）
                    queryCache（無上限 Map）
                    listeners（只加不減的 List）
                    ThreadLocal 的 Map

                ══════════════════════════════════════════════════════════════
                替代方案：用 JFR 持續監控（正式環境首選）
                ══════════════════════════════════════════════════════════════
                  # 啟動時就開，開銷 < 2%
                  java -XX:StartFlightRecording=duration=0,filename=/var/log/app/app.jfr,\\
                       settings=profile,maxsize=500m -jar app.jar

                  # 或執行期動態開啟
                  jcmd <pid> JFR.start name=leak settings=profile duration=10m \\
                       filename=/tmp/leak.jfr
                  jcmd <pid> JFR.dump name=leak filename=/tmp/leak.jfr
                  jcmd <pid> JFR.stop name=leak

                  用 JDK Mission Control（JMC）開啟 .jfr 檔案：
                    Memory → Live Objects / Allocation Profile
                    → 直接看到「哪一行程式碼配置了最多記憶體」
                    ★ 比 heap dump 更適合「找出誰在製造垃圾」
                """);
    }
}
```

### 修正版本

```java
package com.example.todo.leak;

import com.example.todo.model.Priority;
import com.example.todo.model.Todo;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * ✅ 修正版：四個洩漏各自對應一個解法。
 */
public class FixedTodoService {

    // ===== 修正 1：有界的稽核紀錄 + 不存完整快照 =====
    // 用 ArrayDeque 當環形緩衝，超過上限就丟最舊的
    private static final int MAX_AUDIT = 1_000;
    private static final Deque<AuditEntry> AUDIT_LOG = new ArrayDeque<>(MAX_AUDIT);

    /** ✅ 只存「必要的識別資訊」，不存整個 Todo 物件、不存堆疊字串 */
    record AuditEntry(Instant at, String action, long todoId, String title) { }

    // ===== 修正 2：有容量上限 + TTL 的快取 =====
    private static final int MAX_CACHE = 500;
    private final Map<String, CacheEntry> queryCache = new LinkedHashMap<>(MAX_CACHE * 4 / 3, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, CacheEntry> eldest) {
            return size() > MAX_CACHE;                     // LRU 淘汰（第 05 章 5.6 節）
        }
    };

    private record CacheEntry(List<Todo> value, Instant expiresAt) { }

    private static final Duration CACHE_TTL = Duration.ofMinutes(5);

    // ===== 修正 3：監聽器由「註冊者」負責移除，並提供 unregister =====
    private final List<TodoListener> listeners = new ArrayList<>();

    public interface TodoListener {
        void onChanged(Todo todo);
    }

    /** 回傳一個「取消註冊」的句柄，讓呼叫者能用 try-with-resources 管理 */
    public AutoCloseable register(TodoListener listener) {
        Objects.requireNonNull(listener, "listener 不可為 null");
        synchronized (listeners) {
            listeners.add(listener);
        }
        return () -> {
            synchronized (listeners) {
                listeners.remove(listener);
            }
        };
    }

    // ===== 修正 4：ThreadLocal 提供明確的 clear，並在 finally 呼叫 =====
    private static final ThreadLocal<Map<Long, Todo>> REQUEST_SCOPE =
            ThreadLocal.withInitial(HashMap::new);

    public static void clearRequestScope() {
        REQUEST_SCOPE.remove();                            // ★ 關鍵（第 08 章 8.13 節）
    }

    private final AtomicLong sequence = new AtomicLong();
    private final java.time.Clock clock;

    public FixedTodoService(java.time.Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock 不可為 null");
    }

    public Todo create(String title, Priority priority) {
        Todo todo = new Todo(sequence.incrementAndGet(), title, priority, clock.instant());

        recordAudit("CREATE", todo);
        putCache("byTitle:" + title, List.of(todo));
        notifyListeners(todo);
        REQUEST_SCOPE.get().put(todo.getId(), todo);

        return todo;
    }

    private void recordAudit(String action, Todo todo) {
        synchronized (AUDIT_LOG) {
            if (AUDIT_LOG.size() >= MAX_AUDIT) {
                AUDIT_LOG.pollFirst();                     // 丟最舊的
            }
            AUDIT_LOG.addLast(new AuditEntry(
                    clock.instant(), action, todo.getId(), todo.getTitle()));
        }
    }

    private void putCache(String key, List<Todo> value) {
        synchronized (queryCache) {
            queryCache.put(key, new CacheEntry(value, clock.instant().plus(CACHE_TTL)));
        }
    }

    public Optional<List<Todo>> getCached(String key) {
        synchronized (queryCache) {
            CacheEntry entry = queryCache.get(key);
            if (entry == null) return Optional.empty();
            if (clock.instant().isAfter(entry.expiresAt())) {
                queryCache.remove(key);                    // 過期就順手清掉
                return Optional.empty();
            }
            return Optional.of(entry.value());
        }
    }

    private void notifyListeners(Todo todo) {
        List<TodoListener> snapshot;
        synchronized (listeners) {
            snapshot = List.copyOf(listeners);              // 拷貝後才離開鎖（第 05 章 5.8 節）
        }
        for (TodoListener l : snapshot) {
            try {
                l.onChanged(todo);
            } catch (RuntimeException e) {
                System.err.println("[WARN] 監聽器失敗（不影響主流程）: " + e.getMessage());
            }
        }
    }

    public int auditSize() {
        synchronized (AUDIT_LOG) { return AUDIT_LOG.size(); }
    }

    public int cacheSize() {
        synchronized (queryCache) { return queryCache.size(); }
    }

    public int listenerCount() {
        synchronized (listeners) { return listeners.size(); }
    }

    public int requestScopeSize() { return REQUEST_SCOPE.get().size(); }
}
```

### 驗證修正有效

```java
package com.example.todo.leak;

import com.example.todo.model.Priority;

import java.time.Clock;

public class FixVerification {

    public static void main(String[] args) throws InterruptedException {
        var service = new FixedTodoService(Clock.systemDefaultZone());
        var rt = Runtime.getRuntime();

        System.out.printf("%-10s %-14s %-10s %-10s %-12s %s%n",
                "回合", "FullGC後(MB)", "稽核筆數", "快取筆數", "監聽器數", "請求範圍");

        for (int round = 1; round <= 20; round++) {
            // 模擬一批請求
            try (var unregister = service.register(todo -> { })) {
                for (int i = 0; i < 5_000; i++) {
                    service.create("待辦-" + round + "-" + i, Priority.NORMAL);
                }
            } catch (Exception e) {
                throw new IllegalStateException(e);
            } finally {
                FixedTodoService.clearRequestScope();      // ★ 每個請求結束都清
            }

            System.gc();
            Thread.sleep(80);

            System.out.printf("%-10d %-14d %-10d %-10d %-12d %d%n",
                    round,
                    (rt.totalMemory() - rt.freeMemory()) / 1024 / 1024,
                    service.auditSize(), service.cacheSize(),
                    service.listenerCount(), service.requestScopeSize());
        }

        System.out.println("""

                ✅ 觀察結果：
                  FullGC 後的用量「穩定不再成長」  ← 洩漏修好了
                  稽核筆數停在 1000（上限）
                  快取筆數停在 500（上限）
                  監聽器數回到 0（try-with-resources 自動取消註冊）
                  請求範圍回到 0（finally 清理）

                → 共建立 100,000 筆待辦，記憶體卻不再成長。
                  對照洩漏版：38,412 筆就 OOM 了。
                """);
    }
}
```

輸出：

```
回合       FullGC後(MB)   稽核筆數    快取筆數    監聽器數      請求範圍
1          9              1000       500        0            0
2          9              1000       500        0            0
3          10             1000       500        0            0
...
19         10             1000       500        0            0
20         9              1000       500        0            0

✅ 觀察結果：
  FullGC 後的用量「穩定不再成長」  ← 洩漏修好了
  稽核筆數停在 1000（上限）
  快取筆數停在 500（上限）
  監聽器數回到 0（try-with-resources 自動取消註冊）
  請求範圍回到 0（finally 清理）

→ 共建立 100,000 筆待辦，記憶體卻不再成長。
  對照洩漏版：38,412 筆就 OOM 了。
```

### 記憶體洩漏的完整清單（實務上的 Top 10）

| # | 洩漏模式 | 典型症狀 | 修法 |
|---|---|---|---|
| 1 | `static` 集合只加不減 | 谷底線性成長 | 設容量上限，或改用 Caffeine |
| 2 | 快取沒有 `maximumSize` / TTL | 同上 | Caffeine 或 Redis |
| 3 | 監聽器 / 回呼註冊了不移除 | 同上 | 提供 `unregister`，用 try-with-resources |
| 4 | `ThreadLocal` 忘記 `remove()` | 執行緒池的執行緒各持一份 | try-finally remove |
| 5 | 資源沒 close（`InputStream` / `Connection` / `Files.lines`） | `Too many open files` + 記憶體漲 | try-with-resources（第 04 章 4.8 節） |
| 6 | 可變物件當 `HashMap` key，改了 hash | 元素永遠拿不出來也刪不掉 | 用不可變 key（第 05 章 5.7 節） |
| 7 | 內部類別持有外層物件 | 大物件跟著小物件活著 | 巢狀類別加 `static`（第 02 章 2.12 節） |
| 8 | `substring` / `subList` 持有原始物件 | 一小段字串抓著整份文件 | Java 7+ 的 `substring` 已修；`subList` 要拷貝 |
| 9 | ClassLoader 洩漏（熱部署、Mockito） | Metaspace 成長、類別數不降 | 減少 context 重建、`mockStatic` 要 close |
| 10 | `ConcurrentHashMap` 的 key 無限增長（如以 traceId 為 key） | 谷底成長 | 加 TTL 清理，或用 `Caffeine.expireAfterWrite` |

> **第 8 項的歷史**：Java 6 的 `String.substring()` 會共用原始的 `char[]`——
> 從一個 10MB 的字串取 10 個字元，那 10MB 就永遠不死。
> **Java 7 修正成「複製」**。這是「舊版 JDK 的知識可能是錯的」的好例子。

---

## 9.12 診斷工具實戰

```java
public class DiagnosticTools {

    public static void main(String[] args) {
        System.out.println("""
                ══════════════════════════════════════════════════════════════
                jcmd —— ★ 現在的首選工具（一個指令做完所有事）
                ══════════════════════════════════════════════════════════════
                  jcmd                              列出所有 Java 程序
                  jcmd <pid> help                   列出這個程序支援的所有指令

                  # 執行緒
                  jcmd <pid> Thread.print                   執行緒堆疊（取代 jstack）
                  jcmd <pid> Thread.dump_to_file -format=json /tmp/t.json   【Java 21+】

                  # 記憶體
                  jcmd <pid> GC.heap_info                   各代用量
                  jcmd <pid> GC.class_histogram             物件數排行（會觸發 Full GC）
                  jcmd <pid> GC.heap_dump /tmp/heap.hprof   抓 dump
                  jcmd <pid> GC.run                         建議做一次 Full GC
                  jcmd <pid> VM.native_memory summary       ★ 本機記憶體明細（需 NMT）

                  # 資訊
                  jcmd <pid> VM.flags                       所有 JVM 參數的「實際值」
                  jcmd <pid> VM.system_properties
                  jcmd <pid> VM.uptime
                  jcmd <pid> VM.metaspace
                  jcmd <pid> VM.classloader_stats

                  # JFR
                  jcmd <pid> JFR.start settings=profile duration=60s filename=/tmp/r.jfr
                  jcmd <pid> JFR.dump filename=/tmp/r.jfr
                  jcmd <pid> JFR.stop

                ══════════════════════════════════════════════════════════════
                jstat —— 看趨勢（唯一能「持續監看」的內建工具）
                ══════════════════════════════════════════════════════════════
                  jstat -gcutil <pid> 1000          每秒印各區佔比（%）
                  jstat -gc <pid> 1000              每秒印各區的 KB 數
                  jstat -gccause <pid> 1000         加上「上次 GC 的原因」
                  jstat -class <pid> 1000           類別載入/卸載數

                  -gcutil 的欄位：
                    S0/S1  兩個 Survivor 的佔比
                    E      Eden 佔比
                    O      ★ 老年代佔比（看洩漏就看這個）
                    M      Metaspace 佔比
                    CCS    Compressed Class Space 佔比
                    YGC    Young GC 次數      YGCT  Young GC 累計秒數
                    FGC    ★ Full GC 次數     FGCT  Full GC 累計秒數
                    GCT    GC 總累計秒數

                ══════════════════════════════════════════════════════════════
                Native Memory Tracking —— 找「-Xmx 之外」的記憶體
                ══════════════════════════════════════════════════════════════
                  # 啟動時開啟（約 5~10% 效能開銷）
                  java -XX:NativeMemoryTracking=summary -jar app.jar

                  jcmd <pid> VM.native_memory summary

                  # 輸出範例（★ 這是診斷「容器 OOMKilled」的關鍵）
                  Total: reserved=3521MB, committed=1204MB
                  -   Java Heap (reserved=2048MB, committed=512MB)      ← -Xmx 管的
                  -         Class (reserved=1052MB, committed=28MB)     ← Metaspace
                  -        Thread (reserved=412MB, committed=412MB)     ← ★ 執行緒堆疊！
                  -          Code (reserved=248MB, committed=42MB)      ← JIT
                  -            GC (reserved=112MB, committed=88MB)      ← G1 自己的結構
                  -      Internal (reserved=8MB, committed=8MB)
                  -        Symbol (reserved=22MB, committed=22MB)
                  - Native Memory Tracking (reserved=12MB, committed=12MB)

                  ★ 判讀：Java Heap 只用 512MB，但 committed 總共 1204MB。
                    Thread 佔了 412MB —— 400 條執行緒 × 1MB。
                    如果容器限制 1GB，這就是被 OOMKilled 的原因。

                ══════════════════════════════════════════════════════════════
                JFR (Java Flight Recorder) —— ★ 正式環境的持續監控
                ══════════════════════════════════════════════════════════════
                  # 建議的正式環境設定（開銷 < 2%，滾動保留）
                  -XX:StartFlightRecording=name=continuous,disk=true,\\
                     maxage=6h,maxsize=500m,filename=/var/log/app/app.jfr,\\
                     settings=profile

                  # 出事時 dump 出當下的 6 小時記錄
                  jcmd <pid> JFR.dump name=continuous filename=/tmp/incident.jfr

                  # 用 JDK Mission Control（JMC）開啟，重點看：
                  #   Java Application → Method Profiling   哪個方法吃 CPU
                  #   Memory → Allocation Profile           ★ 哪一行配置最多記憶體
                  #   Memory → Live Objects                 存活物件分佈
                  #   Java Application → Lock Instances     鎖競爭（第 08 章）
                  #   Garbage Collections                   每次 GC 的細節
                  #   Event Browser → jdk.VirtualThreadPinned  虛擬執行緒釘住（第 08 章 8.14 節）

                  # 命令列也能看（不用開 GUI）
                  jfr summary /tmp/incident.jfr
                  jfr print --events jdk.ObjectAllocationSample /tmp/incident.jfr | head -50
                  jfr print --events jdk.GCPhasePause /tmp/incident.jfr

                ══════════════════════════════════════════════════════════════
                一頁速查：症狀 → 指令
                ══════════════════════════════════════════════════════════════
                  記憶體一直漲       → jstat -gcutil（看 O）→ jcmd GC.class_histogram
                  OOM 了            → 分析 -XX:HeapDumpPath 的 dump（MAT）
                  服務沒回應         → jcmd Thread.print（找 deadlock / BLOCKED）
                  CPU 100%          → top -H → jcmd Thread.print → 對照 nid
                  容器被 OOMKilled  → jcmd VM.native_memory summary
                  Metaspace 漲      → jcmd VM.metaspace + 監控 LoadedClassCount
                  停頓太久          → -Xlog:gc* 看每次 GC 的 phase
                  想知道誰在配置記憶體 → JFR 的 Allocation Profile
                """);
    }
}
```

---

## 9.13 容器環境的三個陷阱

```java
public class ContainerPitfalls {

    public static void main(String[] args) {
        var rt = Runtime.getRuntime();

        System.out.println("=== JVM 看到的資源 ===");
        System.out.printf("  availableProcessors : %d%n", rt.availableProcessors());
        System.out.printf("  maxMemory (-Xmx)    : %,d MB%n", rt.maxMemory() / 1024 / 1024);

        System.out.println("""

                ══════════════════════════════════════════════════════════════
                陷阱 1：-Xmx 設成容器上限 → 一定被 OOMKilled
                ══════════════════════════════════════════════════════════════
                  容器記憶體限制 1GB，設 -Xmx1g
                  → JVM 認為自己可以用 1GB 堆積
                  → 但實際 RSS = 堆積 + Metaspace + Code Cache + 執行緒堆疊 +
                                 GC 結構 + Direct Memory + JVM 自身
                  → 總和超過 1GB → 核心直接 SIGKILL（不是 Java 的 OOM，
                     所以「沒有任何 Java 錯誤訊息」，也不會有 heap dump）

                  症狀：kubectl describe pod 顯示
                        Last State: Terminated
                        Reason: OOMKilled
                        Exit Code: 137            ← 128 + 9 (SIGKILL)

                  ✅ 解法 A：用百分比，讓 JVM 自己算（★ 推薦）
                     -XX:MaxRAMPercentage=70.0
                     -XX:InitialRAMPercentage=70.0

                  ✅ 解法 B：手動預留
                     容器 1GB → -Xmx600m
                     並用 NMT 實測其他區域的用量再調整

                  ⚠️ 注意 -XX:MaxRAMFraction 已棄用（它只能設整數分母，太粗糙）

                ══════════════════════════════════════════════════════════════
                陷阱 2：CPU limit 讓 availableProcessors 變成 1
                ══════════════════════════════════════════════════════════════
                  Kubernetes 設 resources.limits.cpu: 500m（半顆 CPU）
                  → JVM 的 availableProcessors() 回傳 1
                  → 後果連鎖反應：
                      ForkJoinPool.commonPool 平行度 = 0（第 06/08 章的平行流失效）
                      G1 的 GC 執行緒數 = 1（GC 變慢）
                      虛擬執行緒的載體只有 1 條（第 08 章 8.14 節）
                      你自己寫的 `availableProcessors() * 2` 執行緒池變成 2 條

                  ✅ 解法：
                     ① 用 cpu request 而不是只設 limit（讓 JVM 看到合理的值）
                     ② 或明確指定：-XX:ActiveProcessorCount=4
                     ③ ★ 更好的做法：不要對延遲敏感的 Java 服務設 CPU limit，
                       只設 request（避免 CFS 節流造成的隨機停頓）

                ══════════════════════════════════════════════════════════════
                陷阱 3：容器感知有沒有開
                ══════════════════════════════════════════════════════════════
                  Java 10+ 預設開啟 -XX:+UseContainerSupport
                  → JVM 會讀 cgroup 的限制而不是主機的總量

                  ⚠️ Java 8 早期版本（< 8u191）完全不知道容器限制：
                     主機有 64GB，容器限 1GB
                     → JVM 認為自己有 64GB，預設 -Xmx = 16GB
                     → 一定 OOMKilled
                     ★ 如果你還在維護 Java 8 服務，確認版本 >= 8u372 並明確設 -Xmx

                  cgroup v1 vs v2：
                     Java 15+ 支援 cgroup v2（現代 Linux 的預設）
                     舊版 JDK 在 cgroup v2 主機上「讀不到限制」→ 又回到上面的問題

                ══════════════════════════════════════════════════════════════
                ✅ 一份可以直接用的 Dockerfile 參數
                ══════════════════════════════════════════════════════════════
                  ENV JAVA_TOOL_OPTIONS="\\
                    -XX:MaxRAMPercentage=70.0 \\
                    -XX:InitialRAMPercentage=70.0 \\
                    -XX:+UseG1GC \\
                    -XX:MaxGCPauseMillis=200 \\
                    -XX:MaxMetaspaceSize=256m \\
                    -XX:+HeapDumpOnOutOfMemoryError \\
                    -XX:HeapDumpPath=/var/log/app/ \\
                    -XX:+ExitOnOutOfMemoryError \\
                    -Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=5,filesize=20M \\
                    -XX:StartFlightRecording=name=c,disk=true,maxage=6h,maxsize=300m,\\
                       filename=/var/log/app/app.jfr,settings=profile \\
                    -Duser.timezone=UTC \\
                    -Dfile.encoding=UTF-8"

                  搭配的 Kubernetes 設定：
                    resources:
                      requests: { memory: "1Gi", cpu: "1000m" }
                      limits:   { memory: "1Gi" }        # 不設 cpu limit
                    volumeMounts:
                      - { name: logs, mountPath: /var/log/app }   # ★ dump 要有地方寫
                """);

        // 檢查容器感知是否生效
        System.out.println("=== 檢查容器感知 ===");
        try {
            var cgroupV2 = java.nio.file.Path.of("/sys/fs/cgroup/memory.max");
            var cgroupV1 = java.nio.file.Path.of("/sys/fs/cgroup/memory/memory.limit_in_bytes");
            if (java.nio.file.Files.exists(cgroupV2)) {
                String limit = java.nio.file.Files.readString(cgroupV2).strip();
                System.out.println("  cgroup v2 記憶體限制: " + limit);
            } else if (java.nio.file.Files.exists(cgroupV1)) {
                String limit = java.nio.file.Files.readString(cgroupV1).strip();
                System.out.println("  cgroup v1 記憶體限制: "
                        + (Long.parseLong(limit) / 1024 / 1024) + " MB");
            } else {
                System.out.println("  不在容器中（或讀不到 cgroup）");
            }
            System.out.printf("  JVM maxMemory: %,d MB → 佔限制的比例應該在 50~75%%%n",
                    rt.maxMemory() / 1024 / 1024);
        } catch (Exception e) {
            System.out.println("  無法讀取 cgroup: " + e.getMessage());
        }
    }
}
```

---

## 9.14 常見錯誤

| # | 錯誤 | 修法 |
|---|---|---|
| 1 | 以為 `-Xmx` 就是程序的總記憶體 | 用 NMT 看完整明細；容器用 `MaxRAMPercentage` |
| 2 | `-Xms` 與 `-Xmx` 不同 | 正式環境設成一樣，避免執行期擴容停頓 |
| 3 | 沒設 `-XX:+HeapDumpOnOutOfMemoryError` | 加上，否則 OOM 時沒有任何證據 |
| 4 | 沒開 GC 日誌 | 加 `-Xlog:gc*`，成本幾乎為零 |
| 5 | 沒設 `-XX:MaxMetaspaceSize` | Metaspace 預設無上限，會吃光機器記憶體 |
| 6 | 遇到 OOM 就加大 `-Xmx` | 先判斷是洩漏還是真的需要（看 Full GC 後的谷底） |
| 7 | 遇到 GC 問題就換收集器 | 先找洩漏。換收集器治不好洩漏 |
| 8 | 呼叫 `System.gc()` | 它只是「建議」，而且會觸發 Full GC（STW）。正式程式碼不該有 |
| 9 | 用 `finalize()` 釋放資源 | Java 21 已預設停用。用 try-with-resources + `Cleaner` |
| 10 | 用 `SoftReference` 做快取 | 用 Caffeine（有上限、TTL、統計） |
| 11 | `WeakHashMap` 的 key 用字串常值 | 常值在常量池，永遠是 GC Root |
| 12 | `-Xss` 調大來解決 `StackOverflowError` | 改成迭代演算法 |
| 13 | 非靜態內部類別 | 加 `static`，否則持有外層物件 |
| 14 | JPA 實體的 `toString()` 印雙向關聯 | 只印 id，或用 `@JsonIgnore` |
| 15 | 在正式環境跑 `jmap -dump`（全量） | 會 STW 數十秒。先從 LB 移除 |
| 16 | 容器設 CPU limit 給延遲敏感的服務 | 只設 request，或設 `ActiveProcessorCount` |
| 17 | heap dump 路徑的磁碟空間不足 | 預留 ≥ `-Xmx` 的空間 |
| 18 | 堆積設超過 32GB | 會關閉指標壓縮，反而更耗記憶體。考慮拆實例 |

---

## 9.15 本章練習

### 練習 1：判斷這段程式碼會不會洩漏

```java
public class Suspects {

    // A
    private static final Map<String, byte[]> CACHE = new HashMap<>();
    void a(String key) { CACHE.put(key, new byte[1024 * 1024]); }

    // B
    void b() {
        List<byte[]> list = new ArrayList<>();
        for (int i = 0; i < 1000; i++) list.add(new byte[1024 * 1024]);
    }

    // C
    private final Map<Session, UserData> sessions = new WeakHashMap<>();
    void c(Session s) { sessions.put(s, new UserData(s)); }

    // D
    private static final ThreadLocal<StringBuilder> BUFFER =
            ThreadLocal.withInitial(() -> new StringBuilder(1024 * 1024));
    String d(String input) { return BUFFER.get().append(input).toString(); }

    // E
    void e() throws IOException {
        Stream<String> lines = Files.lines(Path.of("huge.log"));
        long count = lines.filter(l -> l.contains("ERROR")).count();
    }

    // F
    private final List<Runnable> tasks = new ArrayList<>();
    void f() { tasks.add(() -> System.out.println("task")); }
}
```

<details>
<summary>參考解答</summary>

| | 會洩漏？ | 說明 |
|---|---|---|
| **A** | ✅ **會** | `static` Map 沒有上限、沒有清理。經典洩漏 #1 |
| **B** | ❌ 不會 | `list` 是區域變數，方法返回後不可達 → 下次 GC 回收。⚠️ 但**瞬間需要 1GB 堆積**，`-Xmx512m` 會直接 OOM——這是「用量問題」不是「洩漏」，兩者要分清楚 |
| **C** | ✅ **會**（隱蔽） | `WeakHashMap` 的 key 是 `Session`，但 **value `UserData` 持有 `Session` 的強引用**（`new UserData(s)`）→ key 永遠可達 → entry 永遠不會被清。這是 `WeakHashMap` 最經典的誤用（9.8 節）。修法：`UserData` 不要存 `Session`，或用 `WeakReference<Session>` |
| **D** | ✅ **會**（兩層） | ① `ThreadLocal` 沒有 `remove()`——在執行緒池中每條執行緒永久持有 1MB 的 `StringBuilder`。200 條執行緒 = 200MB。② 更糟的是 `append` 從不 `setLength(0)`，`StringBuilder` 會**無限成長**。修法：用完 `setLength(0)`，並在請求結束 `remove()` |
| **E** | ✅ **會** | `Files.lines` 回傳的 Stream 持有檔案句柄，沒有 try-with-resources → 句柄洩漏，最終 `Too many open files`（第 07 章 7.7 節）。⚠️ 注意：`count()` 是終端操作但**不會關閉 Stream** |
| **F** | ⚠️ **看情況** | 如果 `tasks` 只加不減就會洩漏。而且這個 lambda 沒有捕捉任何東西（是無狀態的），JVM 會**重用同一個實例**，所以 lambda 本身不佔記憶體——但 `ArrayList` 的元素槽位會一直增加。**如果 lambda 捕捉了外層變數就會嚴重得多** |

**D 的修正示範：**

```java
private static final ThreadLocal<StringBuilder> BUFFER =
        ThreadLocal.withInitial(() -> new StringBuilder(256));   // 別給太大的初始容量

String d(String input) {
    StringBuilder sb = BUFFER.get();
    sb.setLength(0);                        // ① 重用前先清空
    try {
        return sb.append(input).toString();
    } finally {
        if (sb.capacity() > 8192) {
            BUFFER.remove();                // ② 長太大就丟掉，下次重建
        }
    }
}

// 或者更簡單：這種場景根本不需要 ThreadLocal
String dSimple(String input) {
    return new StringBuilder(input.length() + 16).append(input).toString();
    // 現代 JVM 的物件配置極快（指標碰撞），逃逸分析還可能直接配置在堆疊上。
    // ★ 為了「避免 new 一個 StringBuilder」而用 ThreadLocal 是典型的過度最佳化。
}
```

**E 的修正：**

```java
void e() throws IOException {
    try (Stream<String> lines = Files.lines(Path.of("huge.log"))) {
        long count = lines.filter(l -> l.contains("ERROR")).count();
    }
}
```

**這題最重要的觀念：分清「洩漏」與「用量」。**
B 會 OOM 但不是洩漏（加大 `-Xmx` 或分批處理就解決）。
A、C、D、E 是洩漏（加大 `-Xmx` 只是延後死亡）。**診斷的第一步永遠是分辨這兩者**（9.10 節）。

</details>

### 練習 2：讀 GC 日誌並下判斷

```
[10:00:01.234] GC(120) Pause Young (Normal) (G1 Evacuation Pause) 1820M->412M(2048M) 18.421ms
[10:05:11.891] GC(180) Pause Young (Normal) (G1 Evacuation Pause) 1845M->688M(2048M) 22.103ms
[10:11:42.512] GC(245) Pause Young (Concurrent Start) (G1 Humongous Allocation) 1902M->1024M(2048M) 31.882ms
[10:11:42.514] GC(246) Concurrent Mark Cycle
[10:11:44.221] GC(246) Pause Remark 1024M->1020M(2048M) 12.402ms
[10:11:44.892] GC(246) Pause Cleanup 1020M->1018M(2048M) 0.412ms
[10:18:02.114] GC(310) Pause Young (Normal) (G1 Evacuation Pause) 1988M->1402M(2048M) 42.201ms
[10:24:31.552] GC(378) Pause Full (G1 Compaction Pause) 2041M->1688M(2048M) 1842.104ms
[10:26:12.331] GC(392) Pause Full (G1 Compaction Pause) 2044M->1801M(2048M) 2104.882ms
[10:27:01.882] GC(401) Pause Full (G1 Compaction Pause) 2046M->1912M(2048M) 2388.412ms
[10:27:38.114] GC(408) Pause Full (G1 Compaction Pause) 2047M->1988M(2048M) 2712.093ms
```

請回答：① 這是什麼問題？② 判斷依據是什麼？③ 下一步該做什麼？

<details>
<summary>參考解答</summary>

**① 這是記憶體洩漏。**

**② 三個判斷依據：**

**(a) GC 後的「谷底」持續升高**——這是最關鍵的指標：

| 時間 | GC 後已用 |
|---|---|
| 10:00 | 412M |
| 10:05 | 688M |
| 10:11 | 1024M |
| 10:18 | 1402M |
| 10:24 | 1688M（Full GC 之後！） |
| 10:26 | 1801M |
| 10:27 | 1912M → 1988M |

**Full GC 是最徹底的回收，連它之後都留下 1988M**（堆積總共 2048M）。
這代表這 1988M 全部是「GC Roots 可達」的存活物件——它們是**該死沒死**。

**(b) Full GC 的頻率急速上升**：
`10:24 → 10:26 → 10:27:01 → 10:27:38`，間隔從 2 分鐘縮到 100 秒再縮到 37 秒。
這是洩漏惡化的典型曲線。

**(c) Full GC 的停頓時間持續變長**：
`1842ms → 2104ms → 2388ms → 2712ms`。存活物件越多，標記整理就越慢。

**再幾分鐘就會 `OutOfMemoryError: Java heap space` 或 `GC overhead limit exceeded`。**

**額外觀察**：`10:11` 那次的觸發原因是 `G1 Humongous Allocation`——
有人配置了「超過 Region 一半大小」的物件（例如一個很大的 `byte[]` 或 `String`）。
這值得順便查一下，可能與洩漏源有關（例如把整個檔案讀進一個字串）。

**③ 下一步（依序）：**

```bash
# 步驟 1：先確認趨勢（如果服務還活著）
jstat -gcutil <pid> 5000 12
# 看 O 欄位是否還在漲

# 步驟 2：快速看物件排行（幾秒完成，比 dump 快得多）
jcmd <pid> GC.class_histogram | head -30
# 找「實例數異常多」的類別，特別是與業務相關的類別

# 步驟 3：如果 histogram 看不出來，抓 dump
#   ⚠️ 先從負載平衡移除這個實例！dump 會 STW 數十秒
jcmd <pid> GC.heap_dump /tmp/leak-$(date +%s).hprof

# 步驟 4：用 Eclipse MAT 分析
#   Leak Suspects Report → 找出最大的支配者
#   對它 右鍵 → Path to GC Roots → exclude all phantom/weak/soft references
#   → 就會看到「是哪個 static 欄位 / 哪個集合」在抓著它

# 步驟 5：（如果有 JFR）看是誰在配置
jcmd <pid> JFR.dump name=continuous filename=/tmp/incident.jfr
jfr print --events jdk.ObjectAllocationSample /tmp/incident.jfr | head -50
```

**⚠️ 三件不該做的事：**

1. **不要只是加大 `-Xmx`**。從 2G 加到 4G 只會讓 OOM 從「每天一次」變成「每兩天一次」，
   而且 Full GC 的停頓會從 2.7 秒變成 5 秒以上——**體驗更差**。
2. **不要換 GC 收集器**。ZGC 不會讓洩漏的物件消失。
3. **不要只設定「自動重啟」就當作解決了**。這會掩蓋問題，直到某天流量變大、
   洩漏速度加快，重啟頻率高到影響服務。

**唯一的正解是找到並修掉洩漏源。**

**補充：如果谷底是穩定的呢？**

```
GC(120) 1820M->412M(2048M)
GC(180) 1845M->408M(2048M)
GC(245) 1902M->415M(2048M)
GC(310) 1988M->410M(2048M)      ← 谷底穩定在 410M 附近
```

那就**不是洩漏**，而是「Eden 太小導致 Young GC 太頻繁」。
這時候的解法是加大堆積或調 `MaxGCPauseMillis`——**和洩漏的處理方式完全相反**。
這就是為什麼「先判斷是洩漏還是用量」是第一步。

</details>

### 練習 3：估算記憶體用量並做決策

需求：一個電商服務要快取「商品資訊」以減少資料庫查詢。

```java
record Product(
    Long id,                    // 商品 ID
    String sku,                 // 20 字元
    String name,                // 平均 40 字元（中文）
    String description,         // 平均 500 字元（中文）
    BigDecimal price,
    Integer stock,
    String categoryId,          // 36 字元 UUID
    List<String> imageUrls,     // 平均 5 個，每個 80 字元
    Map<String, String> attributes,  // 平均 8 個屬性，key/value 各 10 字元
    Instant createdAt,
    Instant updatedAt
) { }
```

商品總數 50 萬。容器記憶體限制 2GB。請估算並給出建議。

<details>
<summary>參考解答</summary>

**估算（64 位元 JVM，開啟指標壓縮，12 bytes 標頭）：**

```
單一 Product 物件本身
  標頭                                    12
  11 個欄位參考/值 × 4 (壓縮指標)          44
  對齊填充                                 0
  ─────────────────────────────────────────
  小計                                    56 bytes

Long id（超出 -128~127 快取）             24
Instant × 2（各 12 標頭 + 8 秒 + 4 奈秒） 48
BigDecimal price（含內部 BigInteger）    ~80
Integer stock（超出快取）                 24

String 的成本 = String 物件 24 + byte[] (12 + 內容，對齊到 8)
  ⚠️ 中文是非 Latin-1 → compact strings 失效 → 每字元 2 bytes（第 07 章 7.2 節）

  sku (20 英數)          24 + (12 + 20 → 32)          = 56
  name (40 中文)         24 + (12 + 80 → 96)          = 120
  description (500 中文) 24 + (12 + 1000 → 1016)      = 1040   ★ 最大宗
  categoryId (36 英數)   24 + (12 + 36 → 48)          = 72

imageUrls: List.of(5 個 80 字元英數 String)
  ImmutableCollections.ListN  ~16 + Object[5] (12+20→32) = 48
  5 × (24 + (12+80 → 96))    = 5 × 120                  = 600
  小計                                                   = 648

attributes: Map.of(8 對 10 字元 String)
  MapN 物件 + Object[16]                                 ~ 96
  16 個 String × (24 + (12+10 → 24))                     = 16 × 48 = 768
  小計                                                   = 864

HashMap 的 Entry（快取本身）
  Node 物件                                              = 32
  Long key（如果與 Product.id 共用就不用重算）             = 0

───────────────────────────────────────────────────────────
單筆合計 ≈ 56 + 24 + 48 + 80 + 24 + 56 + 120 + 1040 + 72 + 648 + 864 + 32
        ≈ 3,064 bytes ≈ 3 KB

50 萬筆 ≈ 3 KB × 500,000 ≈ 1,500 MB = 1.5 GB
再加 HashMap 的 table 陣列（50 萬 / 0.75 → 2^20 = 1,048,576 槽 × 4 bytes ≈ 4 MB）
```

**結論：約 1.5 GB。**

**決策：❌ 絕對不要這樣做。** 理由：

| 問題 | 說明 |
|---|---|
| **記憶體爆掉** | 容器只有 2GB，`-Xmx` 最多設 1.4GB（`MaxRAMPercentage=70`）。快取 1.5GB 直接 OOM |
| **GC 災難** | 1.5GB 的存活物件都在老年代。每次 Full GC 要標記整理 50 萬 × 十幾個物件 = 停頓數秒 |
| **多實例浪費** | 跑 5 個 Pod 就是 5 份一樣的 1.5GB 快取 = 7.5GB |
| **一致性問題** | 商品改價後，5 個 Pod 的快取要怎麼同步失效？ |

**四個可行方案（依推薦順序）：**

**方案 1：只快取熱資料 + 精簡欄位（★ 首選）**

```java
/** 快取專用的精簡投影：拿掉最大的 description（1040 bytes，佔 1/3！） */
record ProductSummary(
        long id,                    // ✅ 用 long 而非 Long（省 24 bytes 且無裝箱）
        String sku,
        String name,
        long priceCents,            // ✅ 用 long 分而非 BigDecimal（省 80 bytes）
        int stock,                  // ✅ 用 int 而非 Integer
        String categoryId
) { }
// 單筆 ≈ 32(record) + 56(sku) + 120(name) + 72(categoryId) + 32(Entry) ≈ 312 bytes

// 只快取熱門的 2 萬筆（80/20 法則：20% 的商品佔 80% 的查詢）
Cache<Long, ProductSummary> cache = Caffeine.newBuilder()
        .maximumSize(20_000)                          // ★ 有上限
        .expireAfterWrite(Duration.ofMinutes(10))     // ★ 有 TTL
        .recordStats()                                // ★ 有命中率統計
        .build();
// 20,000 × 312 bytes ≈ 6 MB    ← 從 1.5GB 降到 6MB
```

**方案 2：用 Redis（多實例共用）**

```java
// 優點：多 Pod 共用一份、可以主動失效、不佔 JVM 堆積、可以存 50 萬筆
// 代價：每次查詢多一次網路往返（約 0.5~2ms，但遠快於 DB 的 5~50ms）
// ★ 這是實務上最常見的答案（第 05 站會實作）

// 兩層快取更好：
//   L1 = Caffeine（本地，20000 筆，1ms 內）
//   L2 = Redis（共用，全部，2ms）
//   L3 = MySQL（來源）
```

**方案 3：不要快取，優化查詢**

```
先量測：這個查詢真的慢嗎？
  加對索引的 MySQL 主鍵查詢 ≈ 0.5ms
  50 萬筆商品表完全放得進 InnoDB Buffer Pool

★ 很多「需要快取」的判斷其實是沒有量測過就先加複雜度。
  第 07 站會教怎麼用 EXPLAIN 判斷。
```

**方案 4：如果真的必須全量在記憶體**

```
考慮「欄位式儲存」：不要存 50 萬個物件，改存幾個大陣列
  long[] ids;          // 50 萬 × 8 bytes = 4 MB
  int[] prices;        // 2 MB
  int[] stocks;        // 2 MB
  String[] names;      // 這個還是要 60 MB

優點：物件數從 50 萬 × 15 個降到 4 個 → GC 壓力幾乎消失
缺點：程式碼難寫難維護
★ 只在「極端效能需求」（如撮合引擎、風控引擎）才值得
```

**這題最重要的三個洞見：**

1. **`description` 一個欄位佔了 1/3 的記憶體**。快取要問「查詢真的需要這個欄位嗎」——
   列表頁不需要商品描述，只有詳情頁需要。**精簡投影是最有效的優化。**
2. **`Long` / `Integer` / `BigDecimal` 的裝箱成本很高**。快取物件用 `long` / `int` / `long`（分）
   能省下可觀的空間（第 01 章 1.5、1.7 節）。
3. **中文讓 compact strings 失效**，每字元 2 bytes。所以「500 字的中文描述」比
   「500 字的英文描述」貴一倍（第 07 章 7.2 節）。

</details>

### 練習 4：預測輸出

```java
public class Quiz {

    static class Holder {
        static final int CONST = 42;
        static int mutable = 7;
        static { System.out.println("Holder 初始化"); }
    }

    static Object leaked;

    public static void main(String[] args) throws Exception {
        // ①
        System.out.println("A:" + Holder.CONST);

        // ②
        System.out.println("B:" + Holder.mutable);

        // ③
        var weak = new java.lang.ref.WeakReference<>(new Object());
        System.gc(); Thread.sleep(100);
        System.out.println("C:" + (weak.get() == null));

        // ④
        var map = new java.util.WeakHashMap<String, String>();
        map.put("literal", "v");
        System.gc(); Thread.sleep(100);
        System.out.println("D:" + map.size());

        // ⑤
        String big = "x".repeat(1_000_000);
        String sub = big.substring(0, 10);
        big = null;
        System.gc(); Thread.sleep(100);
        System.out.println("E:" + sub.length());

        // ⑥
        System.out.println("F:" + (Runtime.getRuntime().maxMemory()
                == Runtime.getRuntime().totalMemory()));
    }
}
```

<details>
<summary>參考解答</summary>

```
A:42
Holder 初始化
B:7
C:true
D:0
E:10
F:false
```

**逐一說明：**

**① `A:42`（沒有印出「Holder 初始化」）**
`CONST` 是 `static final int` 且值是編譯期常量 → **編譯器直接把 42 內聯到使用處**，
根本沒碰 `Holder` 類別 → 不觸發初始化（9.6 節）。

**② 先印「Holder 初始化」再印 `B:7`**
`mutable` 不是編譯期常量 → 必須真的存取 `Holder` 類別 → 觸發 `<clinit>` →
static 區塊先執行，才讀到 `mutable`。

**③ `C:true`**
`new Object()` 只有 `WeakReference` 指著它（沒有強引用）→ GC 就回收 → `get()` 回 null。
⚠️ 這裡有個細節：`new java.lang.ref.WeakReference<>(new Object())` 這個寫法讓 `new Object()`
沒有任何強引用，所以一定會被回收。如果寫成 `Object o = new Object(); var weak = new WeakReference<>(o);`
就不會（`o` 是 GC Root 可達的區域變數）。

**④ `D:0`**

⚠️ **這題和 9.8 節的說明不同，值得仔細看。**

9.8 節說「`WeakHashMap` 的 key 是字串常值會永遠不被清」。但這裡 `size()` 是 0——為什麼？

因為 `WeakHashMap` 的**弱引用是指向 key 物件本身**，而字串常值 `"literal"`
確實在常量池裡、確實是 GC Root 可達的。**所以 entry 不該被清除。**

但 `map.size()` 回傳 0 的原因是**這段程式碼被 JIT 最佳化了**：
`map` 在 `put` 之後、`size()` 之前沒有其他用途，JVM 的逃逸分析可能判定
整個 `map` 都不可達（`size()` 的結果雖然被印出來，但 map 本身可以被視為死的）。

**實際上這題的輸出「不確定」**——取決於 JIT 是否啟動、是否做了純量替換。
在 `-Xint`（純解譯模式）下跑會得到 `D:1`。

**這正好是本章的一個重要教訓：`System.gc()` 的行為不是規格保證的，
用它來「驗證 GC 行為」的測試本身就不可靠。** 要精確驗證，
應該用 `-XX:+UseSerialGC -Xint` 或直接分析 heap dump。

**⑤ `E:10`**
`substring` 在 **Java 7 之後會複製字元**，所以 `sub` 不持有原始的 1MB `byte[]`。
`big = null` 之後那 1MB 就能被回收，`sub` 仍然正常可用（9.11 節第 8 項）。

在 **Java 6** 上，`substring` 共用原始陣列 → `sub` 會讓 1MB 永遠不死。
這是「舊 JDK 的知識可能過時」的例子。

**⑥ `F:false`**
`maxMemory()` ≈ `-Xmx`（JVM 最多能用多少）。
`totalMemory()` = 當前已向 OS 要到的量（從 `-Xms` 開始，按需成長）。
除非 `-Xms` = `-Xmx` 且已經長滿，否則兩者不同（9.2 節）。

**這題最該記住的兩點：**
1. `static final` 的編譯期常量會被內聯，不觸發類別初始化。
2. **不要用 `System.gc()` 寫測試**——它的行為不保證，而且 JIT 最佳化會讓結果不可預測。

</details>

### 練習 5：診斷情境題

| # | 症狀 | 你的第一個指令是什麼？懷疑什麼？ |
|---|---|---|
| 1 | Pod 每 4 小時被 `OOMKilled`，exit code 137，log 裡沒有任何 Java 錯誤 | ? |
| 2 | API 平均 20ms，但每 30 分鐘有一批請求變成 3 秒 | ? |
| 3 | 服務啟動後前 2 分鐘很慢，之後正常 | ? |
| 4 | 測試套件跑到第 300 個測試就 `OutOfMemoryError: Metaspace` | ? |
| 5 | CPU 100%，但業務吞吐量是 0 | ? |
| 6 | `Too many open files`，重啟後正常，兩天後又出現 | ? |
| 7 | 堆積用量正常（1G/4G），但容器 RSS 是 5GB | ? |

<details>
<summary>參考解答</summary>

| # | 第一個指令 | 懷疑什麼 |
|---|---|---|
| 1 | `jcmd <pid> VM.native_memory summary`（需先加 `-XX:NativeMemoryTracking=summary`） | **`-Xmx` 之外的記憶體超標**。exit 137 = SIGKILL 由核心發出，不是 Java OOM——所以沒有 Java 錯誤也沒有 heap dump。重點看 `Thread`（執行緒數 × `-Xss`）、`Class`（Metaspace）、`Code`。常見答案：執行緒池無上限開了幾百條執行緒，或 Netty 的 direct buffer。修法：`-XX:MaxRAMPercentage=70` + 限制執行緒數（9.13 節） |
| 2 | 看 `-Xlog:gc*` 的日誌，找那個時間點 | **Full GC 停頓**。30 分鐘一次的規律性 → 老年代慢慢填滿後觸發 Full GC。要進一步判斷是「洩漏」（谷底升高）還是「正常但堆積太小」（谷底穩定）。⚠️ 也要排除「排程任務」——每 30 分鐘跑一次的批次可能在製造大量物件 |
| 3 | 正常現象，不需要診斷 | **JIT 暖機**（第 00 章 0.9 節）。JVM 一開始用解譯器，熱點方法要被呼叫幾千次才會被 JIT 編譯。**解法**：① 放進負載平衡前先發暖機請求；② Kubernetes 用 `readinessProbe` 延後接流量；③ 考慮 AOT（Java 24+ 的 `-XX:AOTCache`）或 GraalVM native image |
| 4 | 監控 `ClassLoadingMXBean.getLoadedClassCount()`，並看 `jcmd <pid> VM.classloader_stats` | **ClassLoader 洩漏**。測試環境的頭號嫌犯：① Spring 的 `@DirtiesContext` 用太多 → 每次重建整個 context；② Mockito 的 `mockStatic` 沒 close → 動態產生的類別累積；③ 每個測試類別都用不同的 `@SpringBootTest` 設定 → context 快取爆掉。**修法**：統一測試設定讓 context 能被快取、`mockStatic` 用 try-with-resources、設 `-XX:MaxMetaspaceSize` 讓問題早點暴露（9.5 節） |
| 5 | `top -H -p <pid>` 找出吃 CPU 的執行緒，再 `jcmd <pid> Thread.print` | 兩個可能：① **GC 執行緒吃滿**——`GC overhead limit exceeded` 的前兆，其實是記憶體問題（用 `jstat -gcutil` 確認 FGC 次數飆升）；② **忙迴圈或 CAS 自旋**——`Thread.print` 會看到某條執行緒卡在同一個方法，或大量執行緒在 `AtomicXxx` 上自旋（改用 `LongAdder`，第 08 章 8.7 節） |
| 6 | `lsof -p <pid> | wc -l` 看句柄數，`lsof -p <pid> | awk '{print $NF}' | sort | uniq -c | sort -rn | head` 看是什麼類型 | **資源沒 close**。「重啟後正常、兩天後復發」是典型的洩漏曲線。常見來源：`Files.lines` / `Files.walk` 沒 try-with-resources（第 07 章 7.7 節）、HTTP 連線沒歸還連線池、`ResultSet` / `Connection` 沒關（第 06 站）。⚠️ 也要檢查 `ulimit -n` 是否設得太低（容器預設常是 1024） |
| 7 | `jcmd <pid> VM.native_memory summary` + `pmap -x <pid> | sort -k3 -rn | head -20` | **本機記憶體洩漏**。堆積正常但 RSS 5GB → 問題在 `-Xmx` 之外。四個常見來源：① `DirectByteBuffer` 沒被回收（Netty、Kafka 客戶端）；② JNI / native 函式庫洩漏；③ 記憶體映射檔（`FileChannel.map`）；④ glibc 的 malloc arena 碎片（用 `MALLOC_ARENA_MAX=2` 或換 jemalloc）。⚠️ 這是最難診斷的一類，可能需要 `jemalloc` 的 profiling 或 `async-profiler --alloc` |

**一份可以貼在牆上的速查表：**

```
症狀                          第一個指令                              最可能的原因
──────────────────────────────────────────────────────────────────────────────
記憶體持續漲                   jstat -gcutil（看 O）                  洩漏
OOM: heap space               分析 HeapDumpPath 的 dump（MAT）        洩漏或用量不足
OOM: Metaspace                jcmd VM.classloader_stats              ClassLoader 洩漏
OOMKilled / exit 137          jcmd VM.native_memory summary          -Xmx 外的記憶體
定期卡頓                       -Xlog:gc* 找時間點                     Full GC
服務沒回應、CPU 低             jcmd Thread.print                      死鎖或鎖競爭
CPU 100%、吞吐 0              top -H + jcmd Thread.print             GC 風暴或忙迴圈
Too many open files           lsof -p <pid>                          資源沒 close
啟動慢、之後正常               不用查                                  JIT 暖機（正常）
想知道誰在配置記憶體            JFR 的 Allocation Profile              —
```

**最後一個實務建議**：這些工具**平時就要練**。線上出事時是最糟的學習時機——
有人在你旁邊問「什麼時候會好」，你在 Google「jstat 參數」。
**建議做法**：把 9.11 節的洩漏程式碼放進一個 `playground` 專案，
自己走完一次「重現 → jstat → histogram → dump → MAT」的流程。一小時的投資，會在某個週五晚上還你。

</details>

---

## 9.16 驗收清單

- [ ] 我能畫出 JVM 執行時資料區域，並知道哪些是執行緒私有、哪些共用。
- [ ] 我知道 `-Xmx` 只控制堆積，程序的實際記憶體遠大於它。
- [ ] 我知道 `StackOverflowError` 通常該改演算法，不是調 `-Xss`。
- [ ] 我能說出 Eden / Survivor / Old 的物件流動與晉升機制。
- [ ] 我能解釋「弱分代假說」以及分代收集為什麼有效。
- [ ] 我會讀 `-Xlog:gc` 的每一個欄位。
- [ ] 我知道 Metaspace 在本機記憶體且預設無上限，正式環境要設 `MaxMetaspaceSize`。
- [ ] 我知道類別初始化的五個階段，也知道 `static final` 常量會被內聯。
- [ ] 我能分辨 `ClassNotFoundException` 與 `NoClassDefFoundError`。
- [ ] 我能估算一個物件佔多少 bytes，並用它評估快取容量。
- [ ] 我知道堆積超過 32GB 會關閉指標壓縮。
- [ ] 我能說出 GC Roots 有哪些，並解釋為什麼 Java 沒有循環引用問題。
- [ ] 我知道四種引用型別，也知道 `WeakHashMap` 的兩種誤用。
- [ ] 我知道 `finalize()` 已被停用，該用 try-with-resources + `Cleaner`。
- [ ] 我能在 Serial / Parallel / G1 / ZGC 之間做出有理由的選擇。
- [ ] 我認得六種 `OutOfMemoryError` 並知道各自的診斷方向。
- [ ] **我能用「Full GC 後的谷底是否升高」判斷是洩漏還是用量不足。**
- [ ] 我知道記憶體洩漏的 Top 10 模式，並能在 code review 時認出它們。
- [ ] 我會用 `jcmd` / `jstat` / NMT / JFR，也知道哪個指令會造成 STW。
- [ ] 我知道容器環境的三個陷阱，也有一份可用的啟動參數清單。

---

完成後請前往 [10-build-tools-maven-gradle.md](./10-build-tools-maven-gradle.md)。
