# 第 08 章：併發程式設計

> 併發的難處不是「語法」，而是**錯了不會馬上壞**。
>
> 一段有競態條件的程式碼，在你的筆電上跑一萬次都對，上線後在 16 核心機器上每天錯三筆。
> 你去查 log，什麼異常都沒有——只是數字不對。這種 bug 可以耗掉一個工程師兩週。
>
> 所以這章的重點不是「怎麼開執行緒」（那很簡單），而是**怎麼在錯誤發生前就看出它**，
> 以及**怎麼用高階工具讓自己少寫低階的鎖**。

---

## 8.1 學習目標

完成本章後，你應該可以：

- 分辨併發（concurrency）與平行（parallelism），並判斷你的問題是哪一種。
- 用實驗**親眼看到** `i++` 的競態條件與可見性問題。
- 說明 `synchronized` 鎖住的到底是什麼，以及物件鎖與類別鎖的差別。
- 解釋 Java 記憶體模型的「可見性」問題，以及 `volatile` 解決什麼、不解決什麼。
- 使用 `AtomicInteger` / `LongAdder`，並說明 CAS 的原理與 ABA 問題。
- 製造一個死鎖，然後用 `jstack` 找出它。
- 正確設定 `ThreadPoolExecutor` 的七個參數，並說明為什麼不該用 `Executors.newFixedThreadPool`。
- 用 `CompletableFuture` 組合非同步任務，並處理逾時與例外。
- 說明 `ThreadLocal` 在執行緒池中造成的兩種問題。
- 使用 Java 21 虛擬執行緒，並知道它適合什麼、不適合什麼。

---

## 8.2 併發 vs 平行：先分清楚你的問題

```
併發（Concurrency）：同時「處理」多件事，不一定同時「執行」
   一個廚師在煮麵、烤肉、切菜之間切換
   → 目標：把等待的時間拿來做別的事（IO 等待）

平行（Parallelism）：真的同時執行
   三個廚師各煮一道菜
   → 目標：用更多 CPU 核心把工作做完更快（CPU 運算）
```

**這個區分決定你該用什麼工具：**

| 你的問題 | 特徵 | 該用什麼 |
|---|---|---|
| **IO 密集**：呼叫 20 個外部 API、查 100 次資料庫、讀 1000 個檔案 | 大部分時間在**等** | 虛擬執行緒（8.14 節）或大執行緒池 |
| **CPU 密集**：影像處理、加密、大量數學運算 | 大部分時間在**算** | 平台執行緒池，大小 ≈ CPU 核心數 |
| **混合**：查 DB 後做複雜計算 | 兩者都有 | 拆成兩個池，各自調校 |

```java
public class ConcurrencyVsParallelism {

    public static void main(String[] args) throws Exception {
        int cores = Runtime.getRuntime().availableProcessors();
        System.out.println("CPU 核心數: " + cores);

        // ===== IO 密集：100 個任務，每個等 100ms =====
        System.out.println("\n=== IO 密集（每個任務 sleep 100ms）===");
        System.out.println("循序執行     : " + timeIo(1) + " ms");     // 約 10000 ms
        System.out.println("10 條執行緒  : " + timeIo(10) + " ms");    // 約 1000 ms
        System.out.println("100 條執行緒 : " + timeIo(100) + " ms");   // 約 100 ms
        System.out.println("→ 執行緒數遠超核心數也有效，因為它們都在「等」");

        // ===== CPU 密集：100 個任務，每個算 500 萬次 =====
        System.out.println("\n=== CPU 密集（純計算）===");
        System.out.println("循序執行         : " + timeCpu(1) + " ms");
        System.out.println("核心數條執行緒   : " + timeCpu(cores) + " ms");
        System.out.println("核心數 x8 條     : " + timeCpu(cores * 8) + " ms");
        System.out.println("→ 超過核心數就沒有更快，反而多了排程與快取失效的成本");
    }

    static long timeIo(int threads) throws Exception {
        long start = System.currentTimeMillis();
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(threads)) {
            for (int i = 0; i < 100; i++) {
                pool.submit(() -> {
                    try {
                        Thread.sleep(100);            // 模擬 IO 等待
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            }
        }   // try-with-resources 會 shutdown 並等待完成【Java 19+】
        return System.currentTimeMillis() - start;
    }

    static long timeCpu(int threads) throws Exception {
        long start = System.currentTimeMillis();
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(threads)) {
            for (int i = 0; i < 100; i++) {
                pool.submit(() -> {
                    double sum = 0;
                    for (int j = 1; j <= 5_000_000; j++) {
                        sum += Math.sqrt(j);          // 純 CPU
                    }
                    return sum;
                });
            }
        }
        return System.currentTimeMillis() - start;
    }
}
```

典型輸出（8 核心機器）：

```
CPU 核心數: 8

=== IO 密集（每個任務 sleep 100ms）===
循序執行     : 10120 ms
10 條執行緒  : 1030 ms
100 條執行緒 : 130 ms
→ 執行緒數遠超核心數也有效，因為它們都在「等」

=== CPU 密集（純計算）===
循序執行         : 2850 ms
核心數條執行緒   : 420 ms
核心數 x8 條     : 445 ms
→ 超過核心數就沒有更快，反而多了排程與快取失效的成本
```

> **這張表格是本章所有決策的基礎。** 很多人把執行緒池開得太小（IO 密集卻只開 8 條）
> 或太大（CPU 密集卻開 200 條），兩者都會讓效能變差。

---

## 8.3 `Thread` 基礎

### 建立與啟動

```java
public class ThreadBasics {

    public static void main(String[] args) throws InterruptedException {

        // ① 實作 Runnable（推薦：不佔用 extends 名額，第 03 章 3.11 節）
        Runnable task = () -> System.out.println("執行於: " + Thread.currentThread().getName());
        Thread t1 = new Thread(task, "worker-1");
        t1.start();                     // ✅ start() 才會開新執行緒

        // ⚠️ 常見錯誤：呼叫 run() 而不是 start()
        Thread t2 = new Thread(task, "worker-2");
        t2.run();                       // ❌ 只是在「當前執行緒」呼叫一個普通方法！

        // ② 繼承 Thread（很少用）
        Thread t3 = new Thread("worker-3") {
            @Override
            public void run() {
                System.out.println("繼承版，執行於: " + getName());
            }
        };
        t3.start();

        // ③ 【Java 21】虛擬執行緒（8.14 節詳述）
        Thread t4 = Thread.ofVirtual().name("virtual-1").start(task);

        // 等待結束
        t1.join();
        t3.join();
        t4.join();

        // 常用資訊
        Thread current = Thread.currentThread();
        System.out.println("\n--- 當前執行緒資訊 ---");
        System.out.println("名稱      : " + current.getName());
        System.out.println("優先度    : " + current.getPriority());     // 1~10，預設 5
        System.out.println("狀態      : " + current.getState());
        System.out.println("是否 daemon: " + current.isDaemon());
        System.out.println("執行緒 ID : " + current.threadId());        // Java 19+；舊版 getId()
    }
}
```

輸出（`worker-1` 與 `main` 的相對順序不固定，因為 `t1` 是真的併發）：

```
執行於: worker-1
執行於: main            ← ⚠️ t2.run() 印出的是 main，不是 worker-2！
繼承版，執行於: worker-3
執行於: VirtualThread[#25,virtual-1]/runnable@ForkJoinPool-1-worker-1

--- 當前執行緒資訊 ---
名稱      : main
優先度    : 5
狀態      : RUNNABLE
是否 daemon: false
執行緒 ID : 1
```

> ⚠️ **`run()` vs `start()`** 是最基本也最常見的錯誤，而上面的輸出就是判斷依據。
>
> lambda 印的是 `Thread.currentThread().getName()`——「**實際執行它的那條執行緒**」。
> `t2` 這個 `Thread` 物件雖然叫 `worker-2`，但 `t2.run()` 只是**在 main 執行緒上呼叫一個普通方法**，
> 那條 `worker-2` 執行緒從來沒被建立過。所以印出 `main`。
>
> **除錯技巧**：懷疑「我的非同步任務好像沒有真的非同步」時，
> 在任務裡印一次 `Thread.currentThread().getName()`。看到 `main`（或呼叫者的執行緒名）就是這個問題。

### 執行緒的六個狀態

```
       ┌─────┐
       │ NEW │  new Thread() 之後、start() 之前
       └──┬──┘
          │ start()
          ↓
    ┌──────────┐   進入 synchronized 但拿不到鎖   ┌─────────┐
    │ RUNNABLE │ ──────────────────────────────→ │ BLOCKED │
    │          │ ←────────────────────────────── │         │
    └────┬─────┘            拿到鎖                └─────────┘
         │
         │ wait() / join() / LockSupport.park()      ┌─────────┐
         ├──────────────────────────────────────────→│ WAITING │
         │ ←─────────────────────────────────────────│         │
         │            notify() / notifyAll()          └─────────┘
         │
         │ sleep(n) / wait(n) / join(n)          ┌───────────────┐
         ├──────────────────────────────────────→│ TIMED_WAITING │
         │ ←─────────────────────────────────────│               │
         │              時間到                    └───────────────┘
         │
         │ run() 結束或丟出例外
         ↓
   ┌────────────┐
   │ TERMINATED │
   └────────────┘
```

```java
import java.util.concurrent.CountDownLatch;

public class ThreadStates {

    public static void main(String[] args) throws InterruptedException {
        Object lock = new Object();
        CountDownLatch started = new CountDownLatch(1);

        Thread t = new Thread(() -> {
            started.countDown();
            synchronized (lock) {
                try {
                    lock.wait();               // → WAITING
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "observed");

        System.out.println("start() 前   : " + t.getState());       // NEW
        t.start();
        started.await();
        Thread.sleep(100);                     // 等它進入 wait
        System.out.println("wait() 中    : " + t.getState());       // WAITING

        synchronized (lock) {
            lock.notify();
        }
        t.join();
        System.out.println("結束後       : " + t.getState());       // TERMINATED

        // BLOCKED 的示範
        Object contended = new Object();
        Thread holder = new Thread(() -> {
            synchronized (contended) {
                try { Thread.sleep(500); } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "holder");
        Thread waiter = new Thread(() -> {
            synchronized (contended) { }
        }, "waiter");

        holder.start();
        Thread.sleep(50);
        waiter.start();
        Thread.sleep(50);
        System.out.println("搶不到鎖時   : " + waiter.getState());   // BLOCKED

        holder.join();
        waiter.join();
    }
}
```

> **實務價值**：用 `jstack`（8.17 節）看執行緒堆疊時，你會看到大量 `BLOCKED` 與 `WAITING`。
> - 一堆 `BLOCKED` 在同一個鎖上 → 鎖競爭嚴重，是效能瓶頸。
> - 一堆 `WAITING on ... BlockingQueue` → 執行緒池閒著，任務不夠。
> - 兩條互相 `BLOCKED` → 死鎖（8.8 節）。

### daemon 執行緒

```java
public class DaemonThreads {

    public static void main(String[] args) throws InterruptedException {
        Thread userThread = new Thread(() -> sleepLoop("user"), "user-thread");
        Thread daemonThread = new Thread(() -> sleepLoop("daemon"), "daemon-thread");
        daemonThread.setDaemon(true);          // ⚠️ 必須在 start() 之前設定

        userThread.start();
        daemonThread.start();

        Thread.sleep(300);
        System.out.println("main 結束");
        // JVM 會等所有「非 daemon」執行緒結束才退出。
        // daemon 執行緒會被直接砍掉（finally 也不保證執行！第 04 章 4.4 節）
    }

    static void sleepLoop(String name) {
        try {
            for (int i = 1; i <= 10; i++) {
                Thread.sleep(100);
                System.out.println("  " + name + " tick " + i);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            System.out.println("  " + name + " 的 finally");
        }
    }
}
```

典型輸出：

```
  user tick 1
  daemon tick 1
  user tick 2
  daemon tick 2
main 結束
  user tick 3
  ...
  user tick 10
  user 的 finally
（daemon 執行緒被砍掉，它的 finally 沒有執行）
```

> **實務用途**：監控執行緒、統計上報、快取清理這類「不重要，程式結束就結束」的背景工作用 daemon。
> **但不要用 daemon 執行緒做需要清理的事**——它的 `finally` 不保證執行。
>
> **虛擬執行緒永遠是 daemon**，這是 8.14 節的一個重要注意事項。

### 中斷（interrupt）：Java 的協作式取消

Java **沒有**強制停止執行緒的方法（`Thread.stop()` 已在 Java 20 移除）。取消是**協作式**的。

```java
import java.util.concurrent.TimeUnit;

public class Interruption {

    public static void main(String[] args) throws InterruptedException {

        // ===== 情況 1：任務在 sleep / wait / IO 等待中 =====
        Thread sleeper = new Thread(() -> {
            try {
                System.out.println("開始睡 10 秒");
                TimeUnit.SECONDS.sleep(10);
                System.out.println("睡飽了");                    // 不會執行
            } catch (InterruptedException e) {
                // ⚠️ 例外被拋出時，中斷旗標「已經被清除」了
                System.out.println("被中斷！旗標狀態: " + Thread.currentThread().isInterrupted());
                Thread.currentThread().interrupt();            // ✅ 恢復旗標（第 04 章反模式 6）
                System.out.println("恢復後旗標狀態: " + Thread.currentThread().isInterrupted());
            }
        }, "sleeper");

        sleeper.start();
        Thread.sleep(200);
        sleeper.interrupt();
        sleeper.join();

        // ===== 情況 2：任務在忙迴圈中（不會自動拋例外，必須自己檢查）=====
        System.out.println("\n--- 忙迴圈的中斷 ---");
        Thread worker = new Thread(() -> {
            long count = 0;
            // ✅ 每一圈檢查中斷旗標
            while (!Thread.currentThread().isInterrupted()) {
                count++;
                if (count % 100_000_000 == 0) {
                    System.out.println("  已處理 " + count / 1_000_000 + "M");
                }
            }
            System.out.println("  收到中斷，優雅結束。共處理 " + count / 1_000_000 + "M");
        }, "busy-worker");

        worker.start();
        Thread.sleep(500);
        worker.interrupt();
        worker.join();

        // ===== 情況 3：❌ 吞掉中斷 —— 無法停止的執行緒 =====
        System.out.println("\n--- 錯誤示範：吞掉中斷 ---");
        Thread unstoppable = new Thread(() -> {
            for (int i = 0; i < 5; i++) {
                try {
                    TimeUnit.MILLISECONDS.sleep(200);
                    System.out.println("  還在跑… " + i);
                } catch (InterruptedException e) {
                    // ❌ 什麼都不做 → 旗標被清掉，迴圈繼續
                    System.out.println("  （中斷被吞掉了）");
                }
            }
        }, "unstoppable");

        unstoppable.start();
        Thread.sleep(100);
        unstoppable.interrupt();
        unstoppable.join();
        System.out.println("→ 中斷了也停不下來，這就是為什麼要恢復旗標");
    }
}
```

輸出：

```
開始睡 10 秒
被中斷！旗標狀態: false
恢復後旗標狀態: true

--- 忙迴圈的中斷 ---
  已處理 100M
  已處理 200M
  ...
  收到中斷，優雅結束。共處理 543M

--- 錯誤示範：吞掉中斷 ---
  （中斷被吞掉了）
  還在跑… 1
  還在跑… 2
  還在跑… 3
  還在跑… 4
→ 中斷了也停不下來，這就是為什麼要恢復旗標
```

**三個必記的規則：**

| 規則 | 說明 |
|---|---|
| `InterruptedException` 被拋出時，**旗標已被清除** | 所以要 `Thread.currentThread().interrupt()` 恢復 |
| 忙迴圈要**自己檢查** `isInterrupted()` | 不然中斷對它完全無效 |
| `Thread.interrupted()`（靜態）會**清除**旗標，`isInterrupted()`（實例）不會 | 容易搞錯 |

> **為什麼這麼重要？** 服務關機時，`ExecutorService.shutdownNow()` 會對所有工作執行緒發中斷。
> 如果你的程式碼吞掉中斷，服務就**關不掉**，Kubernetes 只能等 `terminationGracePeriodSeconds`
> 到期後 SIGKILL——正在處理的請求全部被硬砍。

---

## 8.4 競態條件：親眼看到它出錯

### `i++` 不是原子操作

```java
public class RaceCondition {

    static int unsafeCounter = 0;
    static final int THREADS = 10;
    static final int INCREMENTS = 100_000;

    public static void main(String[] args) throws InterruptedException {
        Thread[] threads = new Thread[THREADS];

        for (int i = 0; i < THREADS; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < INCREMENTS; j++) {
                    unsafeCounter++;            // 看起來是一個動作，其實是三個
                }
            });
        }

        for (Thread t : threads) t.start();
        for (Thread t : threads) t.join();

        int expected = THREADS * INCREMENTS;
        System.out.println("期望值: " + expected);
        System.out.println("實際值: " + unsafeCounter);
        System.out.println("遺失  : " + (expected - unsafeCounter) + " 次更新");
    }
}
```

典型輸出（每次都不同）：

```
期望值: 1000000
實際值: 573421
遺失  : 426579 次更新
```

**為什麼？** `unsafeCounter++` 編譯成三個 bytecode 指令（可以用第 00 章的 `javap -c` 驗證）：

```
getstatic  #2    // ① 讀取 unsafeCounter 到操作數堆疊
iconst_1         // ② 推入常數 1
iadd             // ③ 相加
putstatic  #2    // ④ 寫回 unsafeCounter
```

兩條執行緒交錯執行：

```
時間  執行緒 A              執行緒 B              counter 的值
────────────────────────────────────────────────────────────
 1    讀取 counter → 5                              5
 2                        讀取 counter → 5           5
 3    加 1 → 6                                       5
 4                        加 1 → 6                    5
 5    寫回 6                                          6
 6                        寫回 6                      6   ← 應該是 7！
```

**兩次遞增只生效一次。** 這叫**遺失更新（lost update）**。

### 更隱蔽的問題：可見性

```java
public class VisibilityProblem {

    static boolean running = true;         // ⚠️ 沒有 volatile

    public static void main(String[] args) throws InterruptedException {
        Thread worker = new Thread(() -> {
            long count = 0;
            while (running) {              // 可能永遠讀到快取裡的 true
                count++;
            }
            System.out.println("停止了，共 " + count + " 圈");
        });

        worker.start();
        Thread.sleep(1000);

        System.out.println("main：設定 running = false");
        running = false;

        worker.join(3000);
        if (worker.isAlive()) {
            System.out.println("💥 worker 還在跑！它看不到 running 的變更");
            System.exit(0);
        }
    }
}
```

**這段程式在多數 JVM 上會永遠不結束**（開了 JIT 最佳化之後）。

**為什麼？** JIT 看到 `running` 在迴圈裡沒被修改，會把它「提升」到迴圈外：

```java
// JIT 實際產生的等效程式碼
boolean localCopy = running;
while (localCopy) { count++; }        // 永遠是 true
```

這是**合法的最佳化**——因為在沒有同步的情況下，JMM（Java 記憶體模型）不保證一條執行緒能看到
另一條執行緒的寫入。

**修法：加 `volatile`。**

```java
public class VisibilityFixed {

    static volatile boolean running = true;    // ✅

    public static void main(String[] args) throws InterruptedException {
        Thread worker = new Thread(() -> {
            long count = 0;
            while (running) count++;
            System.out.println("停止了，共 " + count / 1_000_000 + "M 圈");
        });

        worker.start();
        Thread.sleep(1000);
        System.out.println("main：設定 running = false");
        running = false;
        worker.join();
        System.out.println("✅ 正常結束");
    }
}
```

### 併發 bug 的三種型態

| 型態 | 原因 | 例子 | 解法 |
|---|---|---|---|
| **原子性（Atomicity）** | 複合操作被打斷 | `i++`、`if (x == null) x = new X()` | `synchronized` / `Atomic` 類別 |
| **可見性（Visibility）** | 一條執行緒的寫入，另一條看不到 | 上面的 `running` | `volatile` / `synchronized` |
| **有序性（Ordering）** | 編譯器 / CPU 重排指令 | 雙重檢查鎖定（8.6 節） | `volatile` / `final` |

> **這三個問題必須全部解決，程式才是正確的。** 只加 `volatile` 解決不了 `i++`（不是原子的）；
> 只加 `synchronized` 到某些地方也不夠（沒同步的讀取仍看不到）。

---

## 8.5 `synchronized`

### 鎖住的到底是什麼

```java
public class SynchronizedBasics {

    private int count = 0;
    private final Object lock = new Object();

    // ① 同步方法：鎖住 this
    public synchronized void incrementA() {
        count++;
    }

    // ② 同步區塊鎖 this：跟 ① 完全等價，但範圍可以更小
    public void incrementB() {
        synchronized (this) {
            count++;
        }
    }

    // ③ 同步區塊鎖「私有物件」：推薦做法
    public void incrementC() {
        synchronized (lock) {
            count++;
        }
    }

    // ④ 靜態同步方法：鎖住 SynchronizedBasics.class（類別鎖）
    private static int staticCount = 0;

    public static synchronized void incrementStatic() {
        staticCount++;
    }

    // ⑤ 等價寫法
    public static void incrementStatic2() {
        synchronized (SynchronizedBasics.class) {
            staticCount++;
        }
    }

    public int getCount() {
        synchronized (lock) {              // ⚠️ 讀取也要同步！否則有可見性問題
            return count;
        }
    }

    public static void main(String[] args) throws InterruptedException {
        var obj = new SynchronizedBasics();
        Thread[] threads = new Thread[10];
        for (int i = 0; i < 10; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < 100_000; j++) obj.incrementC();
            });
        }
        for (Thread t : threads) t.start();
        for (Thread t : threads) t.join();

        System.out.println("結果: " + obj.getCount());          // 1000000  ✅ 每次都對
    }
}
```

**關鍵：`synchronized` 鎖的是「物件」，不是「程式碼」。**

```java
public class LockScope {

    static class Counter {
        private int value = 0;
        public synchronized void increment() { value++; }        // 鎖 this
        public int get() { return value; }
    }

    public static void main(String[] args) throws InterruptedException {
        // 兩個不同的物件 → 兩把不同的鎖 → 不會互斥
        Counter a = new Counter();
        Counter b = new Counter();

        // a 和 b 各自安全，但它們之間沒有互斥（本來也不需要）
        System.out.println("不同物件用不同的鎖，互不影響");

        // ⚠️ 常見錯誤：以為 synchronized 方法就「全域安全」了
        // 如果有 10 個 Counter 物件都要更新一個共用的總數，就必須用同一把鎖
    }
}
```

### ⚠️ 三個 `synchronized` 的經典錯誤

```java
import java.util.ArrayList;
import java.util.List;

public class SynchronizedMistakes {

    // ❌ 錯誤 1：鎖住會變的物件參考
    static class BadLock1 {
        private String lock = "initial";        // String 而且會被重新指派

        public void doWork(String newValue) {
            synchronized (lock) {                // 鎖住的是「當前 lock 指向的物件」
                lock = newValue;                 // 💥 換了鎖！其他執行緒鎖的是舊物件
            }
        }
    }

    // ❌ 錯誤 2：鎖住字串常值或包裝型別（可能與別人共用同一個物件！）
    static class BadLock2 {
        public void doWork() {
            synchronized ("myLock") {            // 💥 字串池是全 JVM 共用的（第 01 章 1.9 節）
                // 任何其他程式碼 synchronized ("myLock") 都會跟你搶同一把鎖
            }
            synchronized (Integer.valueOf(1)) {  // 💥 Integer 快取也是共用的（1.7 節）
            }
        }
    }

    // ✅ 正確：private final 的專用鎖物件
    static class GoodLock {
        private final Object lock = new Object();
        private final List<String> items = new ArrayList<>();

        public void add(String item) {
            synchronized (lock) {
                items.add(item);
            }
        }

        public List<String> snapshot() {
            synchronized (lock) {
                return List.copyOf(items);       // 拷貝後才離開鎖（第 05 章 5.8 節）
            }
        }
    }

    // ❌ 錯誤 3：同步範圍過大 → 效能瓶頸
    static class TooCoarse {
        private final Object lock = new Object();

        public void process(String data) {
            synchronized (lock) {
                String validated = validate(data);      // 純計算，不需要鎖
                String enriched = callExternalApi(validated);  // 💥 IO！鎖住幾百毫秒
                save(enriched);                          // 這個才需要鎖
            }
        }

        String validate(String s) { return s; }
        String callExternalApi(String s) { return s; }
        void save(String s) { }
    }

    // ✅ 正確：只鎖真正需要的那一小段
    static class JustRight {
        private final Object lock = new Object();

        public void process(String data) {
            String validated = validate(data);                // 鎖外
            String enriched = callExternalApi(validated);      // 鎖外（IO 絕不要在鎖裡）
            synchronized (lock) {
                save(enriched);                                // 只鎖這裡
            }
        }

        String validate(String s) { return s; }
        String callExternalApi(String s) { return s; }
        void save(String s) { }
    }
}
```

> **鐵律：不要在鎖裡面做 IO。** 鎖住 100ms 的網路呼叫，等於把系統的併發度降到 10 req/s。
> 而且如果那個 IO 逾時 30 秒，所有等鎖的執行緒都卡 30 秒——這是「系統突然完全沒回應」的常見原因。

### 可重入性

```java
public class Reentrancy {

    private final Object lock = new Object();
    private int depth = 0;

    public void outer() {
        synchronized (lock) {
            depth++;
            System.out.println("outer，深度 " + depth);
            inner();                    // ✅ 同一條執行緒可以再拿同一把鎖
        }
    }

    public void inner() {
        synchronized (lock) {           // 不會死鎖，因為是「可重入鎖」
            depth++;
            System.out.println("inner，深度 " + depth);
        }
    }

    public static void main(String[] args) {
        new Reentrancy().outer();
        // outer，深度 1
        // inner，深度 2
    }
}
```

`synchronized` 與 `ReentrantLock` 都是**可重入**的：同一條執行緒可以重複取得已持有的鎖
（JVM 內部維護一個計數器）。這讓「同步方法互相呼叫」不會死鎖。

---

## 8.6 Java 記憶體模型與 `volatile`

### 問題的根源：每個 CPU 核心有自己的快取

```
      ┌─────────┐   ┌─────────┐   ┌─────────┐
      │ Core 1  │   │ Core 2  │   │ Core 3  │
      │ ┌─────┐ │   │ ┌─────┐ │   │ ┌─────┐ │
      │ │ L1  │ │   │ │ L1  │ │   │ │ L1  │ │   ← 每核心私有，最快
      │ └──┬──┘ │   │ └──┬──┘ │   │ └──┬──┘ │
      │ ┌──┴──┐ │   │ ┌──┴──┐ │   │ ┌──┴──┐ │
      │ │ L2  │ │   │ │ L2  │ │   │ │ L2  │ │
      └────┬────┘   └────┬────┘   └────┬────┘
           └─────────────┼─────────────┘
                    ┌────┴────┐
                    │   L3    │              ← 共用
                    └────┬────┘
                    ┌────┴────┐
                    │  主記憶體 │              ← 最慢（約 L1 的 100 倍）
                    └─────────┘

執行緒 A 在 Core 1 寫入 running = false → 可能只寫到 Core 1 的 L1
執行緒 B 在 Core 2 讀取 running        → 讀到 Core 2 的 L1 裡的舊值 true
```

再加上**編譯器與 CPU 的指令重排**（只要單執行緒看起來結果一樣就可以重排），
所以需要一套規則來定義「什麼時候一條執行緒的寫入保證被另一條看見」——這就是 **JMM**。

### `volatile` 提供什麼保證

```java
public class VolatileSemantics {

    // ① 可見性：寫入立刻對其他執行緒可見（實際上是禁止快取 + 插入記憶體屏障）
    private volatile boolean flag = false;

    // ② 禁止重排：volatile 寫入之前的所有操作，不會被排到寫入之後
    private int data = 0;

    public void writer() {
        data = 42;                 // ① 普通寫入
        flag = true;               // ② volatile 寫入 → 保證 ① 在此之前完成且可見
    }

    public void reader() {
        if (flag) {                // ③ volatile 讀取
            System.out.println(data);   // ④ 保證看得到 42（不會是 0）
        }
    }

    // ③ long / double 的原子性
    private volatile long timestamp = 0;
    // 32 位元 JVM 上，非 volatile 的 long 讀寫「不是原子的」（分成高低兩個 32 位元）
    // 可能讀到「一半舊、一半新」的撕裂值。volatile 保證不會。
    // （64 位元 JVM 上實際不會發生，但規格上仍需要 volatile 才保證）
}
```

### ⚠️ `volatile` 不提供原子性

```java
public class VolatileIsNotAtomic {

    static volatile int counter = 0;

    public static void main(String[] args) throws InterruptedException {
        Thread[] threads = new Thread[10];
        for (int i = 0; i < 10; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < 100_000; j++) {
                    counter++;              // ❌ volatile 救不了：讀-改-寫仍不是原子的
                }
            });
        }
        for (Thread t : threads) t.start();
        for (Thread t : threads) t.join();

        System.out.println("期望 1000000，實際 " + counter);    // 仍然會遺失更新
    }
}
```

| | 可見性 | 原子性（複合操作） | 互斥 |
|---|---|---|---|
| `volatile` | ✅ | ❌ | ❌ |
| `synchronized` | ✅ | ✅ | ✅ |
| `AtomicInteger` | ✅ | ✅（單一操作） | ❌ |

**`volatile` 的正確用途只有兩種：**

```java
public class VolatileUseCases {

    // ✅ 用途 1：狀態旗標（只有寫入者一個，讀取者多個，且寫入不依賴舊值）
    private volatile boolean shutdownRequested = false;

    public void requestShutdown() { shutdownRequested = true; }

    public void workLoop() {
        while (!shutdownRequested) {
            // 做事
        }
    }

    // ✅ 用途 2：安全發布不可變物件（一次性寫入 + 多次讀取）
    private volatile Config config;         // Config 是不可變的（第 02 章 2.9 節）

    public void reload(Config newConfig) {
        this.config = newConfig;           // 整份替換，讀取者拿到的永遠是完整的一份
    }

    public Config getConfig() { return config; }

    record Config(String host, int port, int timeoutMillis) { }
}
```

### 雙重檢查鎖定：`volatile` 為什麼必需

```java
public class DoubleCheckedLocking {

    // ❌ 沒有 volatile 的版本：可能拿到「還沒初始化完成」的物件
    static class BrokenSingleton {
        private static BrokenSingleton instance;      // 缺 volatile

        private final String data;

        private BrokenSingleton() {
            this.data = loadData();
        }

        public static BrokenSingleton getInstance() {
            if (instance == null) {                    // ① 第一次檢查（無鎖）
                synchronized (BrokenSingleton.class) {
                    if (instance == null) {            // ② 第二次檢查（有鎖）
                        instance = new BrokenSingleton();   // ③ 💥 問題在這裡
                    }
                }
            }
            return instance;
        }

        private static String loadData() { return "loaded"; }
    }

    /*
     * 為什麼 ③ 有問題？`new BrokenSingleton()` 實際上是三步：
     *   a. 配置記憶體
     *   b. 執行建構子（初始化 data 欄位）
     *   c. 把 instance 指向那塊記憶體
     *
     * JVM 允許把 b 和 c 重排成 c → b（單執行緒看不出差別）。
     * 於是：
     *   執行緒 A 執行到 c（instance 已非 null），但 b 還沒做完（data 還是 null）
     *   執行緒 B 在 ① 看到 instance != null → 直接回傳
     *   執行緒 B 使用 instance.data → 得到 null 💥
     */

    // ✅ 加 volatile：禁止 b 與 c 重排
    static class CorrectSingleton {
        private static volatile CorrectSingleton instance;
        private final String data;

        private CorrectSingleton() { this.data = "loaded"; }

        public static CorrectSingleton getInstance() {
            CorrectSingleton local = instance;         // 讀一次到區域變數（減少 volatile 讀取）
            if (local == null) {
                synchronized (CorrectSingleton.class) {
                    local = instance;
                    if (local == null) {
                        local = new CorrectSingleton();
                        instance = local;
                    }
                }
            }
            return local;
        }

        public String getData() { return data; }
    }

    // ✅✅ 更好：完全不需要鎖，用類別初始化的天然執行緒安全（第 02 章 2.8 節）
    static class HolderSingleton {
        private final String data;

        private HolderSingleton() { this.data = "loaded"; }

        /** 靜態內部類別在「第一次被存取」時才載入，JVM 保證類別初始化是執行緒安全的 */
        private static class Holder {
            static final HolderSingleton INSTANCE = new HolderSingleton();
        }

        public static HolderSingleton getInstance() { return Holder.INSTANCE; }

        public String getData() { return data; }
    }

    // ✅✅✅ 最簡單：enum 單例（自帶執行緒安全、序列化安全、防反射）
    enum EnumSingleton {
        INSTANCE;

        private final String data = "loaded";

        public String getData() { return data; }
    }

    public static void main(String[] args) {
        System.out.println(CorrectSingleton.getInstance().getData());
        System.out.println(HolderSingleton.getInstance().getData());
        System.out.println(EnumSingleton.INSTANCE.getData());

        System.out.println("""

                單例的實務建議（依優先順序）：
                  1. 用 Spring 的 @Component / @Bean —— 容器保證單例，不用自己寫（第 02 站）
                  2. enum 單例 —— 最簡單且無漏洞
                  3. 靜態內部類別（Holder）—— 需要延遲初始化時
                  4. 雙重檢查鎖定 —— 只在需要「參數化的延遲初始化」時，且務必加 volatile
                """);
    }
}
```

### happens-before：JMM 的核心規則

不需要背，但要知道有這些「保證」存在：

| 規則 | 意思 |
|---|---|
| **程式順序** | 同一條執行緒內，前面的操作 happens-before 後面的 |
| **監視器鎖** | `unlock` happens-before 之後對同一把鎖的 `lock` |
| **volatile** | 對 volatile 的寫入 happens-before 之後對它的讀取 |
| **執行緒啟動** | `t.start()` happens-before `t` 裡的任何操作 |
| **執行緒結束** | `t` 裡的所有操作 happens-before `t.join()` 返回 |
| **傳遞性** | A hb B 且 B hb C，則 A hb C |
| **final 欄位** | 建構子中對 final 欄位的寫入，happens-before 其他執行緒看到該物件 |

**實務用法**：只要你的資料交接經過了 `synchronized`、`volatile`、`Atomic`、
併發集合、`ExecutorService.submit`/`Future.get`、`CountDownLatch` 等任一種同步機制，
可見性就有保證。**自己用普通欄位在執行緒間傳資料，才會出問題。**

---

## 8.7 原子類別與 CAS

```java
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.LongAdder;

public class AtomicClasses {

    public static void main(String[] args) throws InterruptedException {

        // ===== AtomicInteger：無鎖的原子操作 =====
        AtomicInteger counter = new AtomicInteger(0);
        Thread[] threads = new Thread[10];
        for (int i = 0; i < 10; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < 100_000; j++) counter.incrementAndGet();
            });
        }
        for (Thread t : threads) t.start();
        for (Thread t : threads) t.join();
        System.out.println("AtomicInteger: " + counter.get());     // 1000000 ✅

        // 常用方法
        AtomicInteger a = new AtomicInteger(10);
        System.out.println("\n--- AtomicInteger API ---");
        System.out.println("get()               : " + a.get());                  // 10
        System.out.println("incrementAndGet()   : " + a.incrementAndGet());      // 11（先加後取）
        System.out.println("getAndIncrement()   : " + a.getAndIncrement());      // 11（先取後加）
        System.out.println("addAndGet(5)        : " + a.addAndGet(5));           // 17
        System.out.println("getAndSet(100)      : " + a.getAndSet(100));         // 17
        System.out.println("compareAndSet(100,7): " + a.compareAndSet(100, 7));  // true
        System.out.println("現在的值            : " + a.get());                   // 7
        System.out.println("updateAndGet(x*2)   : " + a.updateAndGet(x -> x * 2)); // 14
        System.out.println("accumulateAndGet    : " + a.accumulateAndGet(3, Integer::sum)); // 17

        // ===== AtomicReference：原子地替換物件 =====
        System.out.println("\n--- AtomicReference ---");
        AtomicReference<String> ref = new AtomicReference<>("initial");
        System.out.println(ref.compareAndSet("initial", "updated"));   // true
        System.out.println(ref.get());                                  // updated
        System.out.println(ref.compareAndSet("initial", "again"));      // false（值已變）

        // 實務案例：原子地更新不可變物件
        AtomicReference<Config> config = new AtomicReference<>(new Config("localhost", 8080));
        config.updateAndGet(old -> new Config(old.host(), old.port() + 1));
        System.out.println(config.get());                               // Config[host=localhost, port=8081]

        // ===== LongAdder：高競爭下遠勝 AtomicLong =====
        System.out.println("\n--- AtomicLong vs LongAdder（高競爭）---");
        System.out.println("AtomicLong: " + benchAtomicLong() + " ms");
        System.out.println("LongAdder : " + benchLongAdder() + " ms");
    }

    record Config(String host, int port) { }

    static long benchAtomicLong() throws InterruptedException {
        AtomicLong counter = new AtomicLong();
        return bench(() -> counter.incrementAndGet(), counter::get);
    }

    static long benchLongAdder() throws InterruptedException {
        LongAdder adder = new LongAdder();
        return bench(adder::increment, adder::sum);
    }

    static long bench(Runnable increment, java.util.function.Supplier<Long> read)
            throws InterruptedException {
        int threads = Runtime.getRuntime().availableProcessors() * 4;
        Thread[] ts = new Thread[threads];
        long start = System.currentTimeMillis();
        for (int i = 0; i < threads; i++) {
            ts[i] = new Thread(() -> {
                for (int j = 0; j < 500_000; j++) increment.run();
            });
        }
        for (Thread t : ts) t.start();
        for (Thread t : ts) t.join();
        long elapsed = System.currentTimeMillis() - start;
        read.get();      // 確保讀得到
        return elapsed;
    }
}
```

典型輸出：

```
AtomicInteger: 1000000

--- AtomicLong vs LongAdder（高競爭）---
AtomicLong: 1850 ms
LongAdder : 210 ms          ← 快 8 倍以上
```

### CAS 的原理

```
CAS（Compare-And-Swap）是一條 CPU 指令：
  「如果記憶體位置 M 的值等於 expected，就把它改成 newValue，並回傳成功」
  這整件事由硬體保證原子性（x86 的 LOCK CMPXCHG）

AtomicInteger.incrementAndGet() 的實作邏輯：
  do {
      current = get();                          // 讀當前值
      next = current + 1;
  } while (!compareAndSet(current, next));      // 失敗就重試（自旋）
  return next;
```

**CAS vs 鎖：**

| | CAS（樂觀） | 鎖（悲觀） |
|---|---|---|
| 競爭低時 | **很快**（無上下文切換） | 較慢（有鎖的開銷） |
| 競爭高時 | 慢（大量自旋重試浪費 CPU） | **較好**（執行緒直接掛起） |
| 阻塞 | 不阻塞 | 會阻塞 |
| 適合 | 單一變數的簡單更新 | 複合操作、多個變數 |

**`LongAdder` 為什麼快？** 它把計數分散到多個 cell（每個 CPU 核心一個），
寫入時各自更新自己的 cell，`sum()` 才加總。**用空間換掉了競爭。**

```java
import java.util.concurrent.atomic.LongAdder;
import java.util.concurrent.atomic.AtomicLong;

public class LongAdderInternals {
    public static void main(String[] args) {
        System.out.println("""
                AtomicLong：所有執行緒搶同一個記憶體位置
                    T1 ─┐
                    T2 ─┼→ [value]        每次 CAS 失敗都要重試
                    T3 ─┘

                LongAdder：分散到多個 cell
                    T1 → [cell 0]  ┐
                    T2 → [cell 1]  ├→ sum() 時才加總
                    T3 → [cell 2]  ┘

                → 寫入幾乎無競爭；代價是 sum() 不是「精確的瞬間快照」

                選擇：
                  需要「每次都拿到精確值」（如產生序號）→ AtomicLong
                  只是「統計計數」（QPS、錯誤數、命中數）→ LongAdder
                """);

        // LongAdder 沒有 compareAndSet / getAndIncrement，因為它做不到精確的即時值
        LongAdder adder = new LongAdder();
        adder.increment();
        adder.add(10);
        System.out.println("sum      : " + adder.sum());          // 11
        System.out.println("sumThenReset: " + adder.sumThenReset());  // 11，並歸零
        System.out.println("重置後   : " + adder.sum());           // 0
    }
}
```

### ⚠️ ABA 問題

```java
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicStampedReference;

public class AbaProblem {

    public static void main(String[] args) throws InterruptedException {

        // ===== ABA：值從 A 變成 B 又變回 A，CAS 察覺不到中間發生過事 =====
        AtomicInteger balance = new AtomicInteger(100);

        Thread withdrawer = new Thread(() -> {
            int current = balance.get();               // 讀到 100
            try { Thread.sleep(100); } catch (InterruptedException e) { }
            // 這 100ms 內，別人做了 100 → 50 → 100
            boolean ok = balance.compareAndSet(current, current - 30);
            System.out.println("提款 30 " + (ok ? "成功" : "失敗") + "，餘額 " + balance.get());
            // CAS 成功了！因為值「看起來」沒變。但中間的兩筆交易被忽略了
        });

        Thread other = new Thread(() -> {
            try { Thread.sleep(20); } catch (InterruptedException e) { }
            balance.addAndGet(-50);                    // 100 → 50
            System.out.println("  中間操作：扣 50，餘額 " + balance.get());
            balance.addAndGet(50);                     // 50 → 100
            System.out.println("  中間操作：加 50，餘額 " + balance.get());
        });

        withdrawer.start();
        other.start();
        withdrawer.join();
        other.join();

        // ===== 解法：AtomicStampedReference 加上「版本號」=====
        System.out.println("\n--- 用 AtomicStampedReference ---");
        AtomicStampedReference<Integer> stamped = new AtomicStampedReference<>(100, 0);

        int[] stampHolder = new int[1];
        int value = stamped.get(stampHolder);
        int stamp = stampHolder[0];
        System.out.println("讀到值 " + value + "，版本 " + stamp);

        // 別人改了兩次
        stamped.compareAndSet(100, 50, 0, 1);
        stamped.compareAndSet(50, 100, 1, 2);
        System.out.println("別人改了兩次，現在版本是 " + stamped.getStamp());

        // 我用舊版本號 CAS → 失敗（正確！）
        boolean ok = stamped.compareAndSet(value, value - 30, stamp, stamp + 1);
        System.out.println("用舊版本 CAS: " + (ok ? "成功" : "失敗（正確擋下）"));
    }
}
```

輸出：

```
  中間操作：扣 50，餘額 50
  中間操作：加 50，餘額 100
提款 30 成功，餘額 70

--- 用 AtomicStampedReference ---
讀到值 100，版本 0
別人改了兩次，現在版本是 2
用舊版本 CAS: 失敗（正確擋下）
```

> **ABA 在實務上什麼時候真的會出事？** 主要是「無鎖資料結構」（自己實作 lock-free stack / queue）
> 和「基於狀態的樂觀更新」。
>
> **這其實就是資料庫的樂觀鎖！** 第 07 站你會看到：
>
> ```sql
> UPDATE orders SET status = 'PAID', version = version + 1
> WHERE id = ? AND version = ?     -- ← 這個 version 就是 stamp
> ```
>
> JPA 的 `@Version` 註解（第 08 站）做的就是這件事。

---

## 8.8 死鎖：製造它，然後抓出它

### 製造一個死鎖

```java
public class Deadlock {

    private static final Object LOCK_A = new Object();
    private static final Object LOCK_B = new Object();

    public static void main(String[] args) throws InterruptedException {

        Thread t1 = new Thread(() -> {
            synchronized (LOCK_A) {
                System.out.println("T1 取得 A，等待 B");
                sleep(100);
                synchronized (LOCK_B) {          // 等 T2 放掉 B
                    System.out.println("T1 取得 B");
                }
            }
        }, "thread-1");

        Thread t2 = new Thread(() -> {
            synchronized (LOCK_B) {              // ⚠️ 順序相反！
                System.out.println("T2 取得 B，等待 A");
                sleep(100);
                synchronized (LOCK_A) {          // 等 T1 放掉 A
                    System.out.println("T2 取得 A");
                }
            }
        }, "thread-2");

        t1.start();
        t2.start();

        // 用 ThreadMXBean 自動偵測死鎖
        Thread.sleep(1000);
        detectDeadlock();

        System.out.println("\nT1 狀態: " + t1.getState());      // BLOCKED
        System.out.println("T2 狀態: " + t2.getState());        // BLOCKED
        System.out.println("→ 兩條執行緒永遠不會結束，程式必須被 kill");
        System.exit(1);
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** ✅ 程式內自動偵測死鎖：很值得加進監控 */
    static void detectDeadlock() {
        var bean = java.lang.management.ManagementFactory.getThreadMXBean();
        long[] deadlocked = bean.findDeadlockedThreads();

        if (deadlocked == null) {
            System.out.println("沒有偵測到死鎖");
            return;
        }

        System.out.println("\n💀 偵測到 " + deadlocked.length + " 條執行緒死鎖：");
        for (var info : bean.getThreadInfo(deadlocked, true, true)) {
            System.out.printf("  [%s] 狀態=%s%n", info.getThreadName(), info.getThreadState());
            System.out.printf("    等待鎖: %s%n", info.getLockName());
            System.out.printf("    該鎖被 [%s] 持有%n", info.getLockOwnerName());
            System.out.println("    堆疊頂端: " + info.getStackTrace()[0]);
        }
    }
}
```

輸出：

```
T1 取得 A，等待 B
T2 取得 B，等待 A
沒有偵測到死鎖        ← 等等，這裡應該偵測到

💀 偵測到 2 條執行緒死鎖：
  [thread-1] 狀態=BLOCKED
    等待鎖: java.lang.Object@1b6d3586
    該鎖被 [thread-2] 持有
    堆疊頂端: Deadlock.lambda$main$0(Deadlock.java:16)
  [thread-2] 狀態=BLOCKED
    等待鎖: java.lang.Object@4554617c
    該鎖被 [thread-1] 持有
    堆疊頂端: Deadlock.lambda$main$1(Deadlock.java:26)

T1 狀態: BLOCKED
T2 狀態: BLOCKED
→ 兩條執行緒永遠不會結束，程式必須被 kill
```

### 用 `jstack` 診斷（線上診斷的標準流程）

```bash
# ① 找出 Java 程序的 PID
jps -l
# 12345 com.example.Deadlock

# ② 抓執行緒堆疊（jcmd 是現在推薦的工具）
jcmd 12345 Thread.print > threads.txt
# 或舊寫法
jstack 12345 > threads.txt

# ③ 搜尋關鍵字
grep -A 20 "Found one Java-level deadlock" threads.txt
```

`jstack` 的輸出（JVM 會**自動幫你找出死鎖**）：

```
Found one Java-level deadlock:
=============================
"thread-2":
  waiting to lock monitor 0x00007f8e1c0053a8 (object 0x000000070fd0b0c8, a java.lang.Object),
  which is held by "thread-1"
"thread-1":
  waiting to lock monitor 0x00007f8e1c007e58 (object 0x000000070fd0b0d8, a java.lang.Object),
  which is held by "thread-2"

Java stack information for the threads listed above:
===================================================
"thread-2":
        at Deadlock.lambda$main$1(Deadlock.java:26)
        - waiting to lock <0x000000070fd0b0c8> (a java.lang.Object)
        - locked <0x000000070fd0b0d8> (a java.lang.Object)
        ...
"thread-1":
        at Deadlock.lambda$main$0(Deadlock.java:16)
        - waiting to lock <0x000000070fd0b0d8> (a java.lang.Object)
        - locked <0x000000070fd0b0c8> (a java.lang.Object)
        ...

Found 1 deadlock.
```

> **實務流程**：服務沒回應但 CPU 不高 → 第一件事就是 `jcmd <pid> Thread.print`。
> 如果看到 `Found N deadlock`，答案就在眼前。第 09 章會完整講診斷工具。

### 死鎖的四個必要條件與四種預防

```java
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

public class DeadlockPrevention {

    record Account(String id, ReentrantLock lock, java.util.concurrent.atomic.AtomicLong balance) {
        Account(String id, long initial) {
            this(id, new ReentrantLock(), new java.util.concurrent.atomic.AtomicLong(initial));
        }
    }

    // ❌ 會死鎖：A→B 轉帳與 B→A 轉帳同時發生
    static void transferBad(Account from, Account to, long amount) {
        synchronized (from) {
            synchronized (to) {
                from.balance().addAndGet(-amount);
                to.balance().addAndGet(amount);
            }
        }
    }

    // ✅ 方案 1：固定加鎖順序（最常用、最有效）
    static void transferOrdered(Account from, Account to, long amount) {
        // 依 id 排序，保證所有執行緒的加鎖順序一致
        Account first = from.id().compareTo(to.id()) < 0 ? from : to;
        Account second = first == from ? to : from;

        synchronized (first) {
            synchronized (second) {
                from.balance().addAndGet(-amount);
                to.balance().addAndGet(amount);
            }
        }
    }

    // ✅ 方案 2：帶超時的鎖（tryLock）—— 拿不到就放棄重試，而不是永遠等
    static boolean transferWithTimeout(Account from, Account to, long amount)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);

        while (System.nanoTime() < deadline) {
            if (from.lock().tryLock(50, TimeUnit.MILLISECONDS)) {
                try {
                    if (to.lock().tryLock(50, TimeUnit.MILLISECONDS)) {
                        try {
                            from.balance().addAndGet(-amount);
                            to.balance().addAndGet(amount);
                            return true;
                        } finally {
                            to.lock().unlock();
                        }
                    }
                } finally {
                    from.lock().unlock();        // ⚠️ 一定要在 finally 裡解鎖
                }
            }
            // 兩把鎖沒有同時拿到 → 全部放掉，隨機等一下再試（避免活鎖）
            Thread.sleep(1 + (long) (Math.random() * 10));
        }
        return false;       // 超時，讓上層決定重試或報錯
    }

    // ✅ 方案 3：根本不用兩把鎖（改用單一協調點或資料庫交易）
    private static final Object GLOBAL_TRANSFER_LOCK = new Object();

    static void transferGlobalLock(Account from, Account to, long amount) {
        synchronized (GLOBAL_TRANSFER_LOCK) {        // 簡單但併發度低
            from.balance().addAndGet(-amount);
            to.balance().addAndGet(amount);
        }
    }

    public static void main(String[] args) throws InterruptedException {
        var a = new Account("A", 1000);
        var b = new Account("B", 1000);

        // 用有序加鎖，雙向轉帳 10000 次都不會死鎖
        Thread t1 = new Thread(() -> {
            for (int i = 0; i < 10_000; i++) transferOrdered(a, b, 1);
        });
        Thread t2 = new Thread(() -> {
            for (int i = 0; i < 10_000; i++) transferOrdered(b, a, 1);
        });

        t1.start(); t2.start();
        t1.join(); t2.join();

        System.out.println("A 餘額: " + a.balance().get());
        System.out.println("B 餘額: " + b.balance().get());
        System.out.println("總和  : " + (a.balance().get() + b.balance().get()) + "（應為 2000）");

        System.out.println("\n--- tryLock 版本 ---");
        System.out.println("轉帳結果: " + transferWithTimeout(a, b, 100));
        System.out.println("A 餘額: " + a.balance().get());
        System.out.println("B 餘額: " + b.balance().get());
    }
}
```

輸出：

```
A 餘額: 1000
B 餘額: 1000
總和  : 2000（應為 2000）

--- tryLock 版本 ---
轉帳結果: true
A 餘額: 900
B 餘額: 1100
```

**死鎖的四個必要條件（打破任一個就不會死鎖）：**

| 條件 | 打破的方法 |
|---|---|
| **互斥**：資源不能共用 | 用不可變物件、CAS、無鎖結構 |
| **持有並等待**：拿著 A 去等 B | 一次取得所有鎖，或拿不到就全放掉（`tryLock`） |
| **不可搶佔**：不能強制拿走別人的鎖 | 用 `tryLock` 帶超時 |
| **循環等待**：A 等 B、B 等 A | **固定加鎖順序**（最常用的解法） |

> **實務首選是「固定加鎖順序」**：定一個全域規則（如按 ID 字典序、按物件的 `System.identityHashCode`），
> 所有需要多把鎖的地方都遵守。這在 code review 時容易檢查。
>
> 更好的做法是**根本不要在應用層鎖兩個以上的資源**——把一致性交給資料庫交易（第 07 站）。

---

## 8.9 `Lock` 家族：比 `synchronized` 更靈活

```java
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.concurrent.locks.StampedLock;

public class LockFamily {

    // ===== ReentrantLock：synchronized 的可控版本 =====
    static class Counter {
        private final ReentrantLock lock = new ReentrantLock();
        private int value = 0;

        void increment() {
            lock.lock();
            try {
                value++;
            } finally {
                lock.unlock();          // ⚠️ 一定要在 finally！忘記就永久死鎖
            }
        }

        /** tryLock：拿不到就放棄，synchronized 做不到 */
        boolean tryIncrement() {
            if (!lock.tryLock()) return false;
            try {
                value++;
                return true;
            } finally {
                lock.unlock();
            }
        }

        /** 帶超時 */
        boolean incrementWithTimeout(long millis) throws InterruptedException {
            if (!lock.tryLock(millis, TimeUnit.MILLISECONDS)) return false;
            try {
                value++;
                return true;
            } finally {
                lock.unlock();
            }
        }

        /** 可中斷：synchronized 在等鎖時不能被中斷 */
        void incrementInterruptibly() throws InterruptedException {
            lock.lockInterruptibly();
            try {
                value++;
            } finally {
                lock.unlock();
            }
        }

        int get() {
            lock.lock();
            try { return value; } finally { lock.unlock(); }
        }

        /** 診斷資訊：synchronized 完全沒有 */
        String diagnostics() {
            return "被鎖住=%s，持有者是我=%s，等待中的執行緒數=%d"
                    .formatted(lock.isLocked(), lock.isHeldByCurrentThread(), lock.getQueueLength());
        }
    }

    public static void main(String[] args) throws InterruptedException {
        var counter = new Counter();

        Thread[] ts = new Thread[8];
        for (int i = 0; i < 8; i++) {
            ts[i] = new Thread(() -> {
                for (int j = 0; j < 100_000; j++) counter.increment();
            });
        }
        for (Thread t : ts) t.start();
        for (Thread t : ts) t.join();
        System.out.println("ReentrantLock 結果: " + counter.get());     // 800000
        System.out.println("診斷: " + counter.diagnostics());

        System.out.println("\ntryLock: " + counter.tryIncrement());     // true
        System.out.println("帶超時: " + counter.incrementWithTimeout(100));  // true

        // ===== 公平鎖 vs 非公平鎖 =====
        System.out.println("""

                new ReentrantLock()      → 非公平（預設）：吞吐量高，但可能有執行緒長期搶不到
                new ReentrantLock(true)  → 公平：先到先服務，吞吐量明顯較低

                實務建議：預設用非公平。只有在「明確觀察到飢餓」時才改成公平。
                """);
    }
}
```

### `ReadWriteLock`：讀多寫少的場景

```java
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantReadWriteLock;

public class ReadWriteLockDemo {

    /** 讀多寫少的快取：讀鎖可以多執行緒同時持有 */
    static class CachedConfig {
        private final Map<String, String> data = new HashMap<>();
        private final ReentrantReadWriteLock rw = new ReentrantReadWriteLock();
        private final ReentrantReadWriteLock.ReadLock readLock = rw.readLock();
        private final ReentrantReadWriteLock.WriteLock writeLock = rw.writeLock();

        String get(String key) {
            readLock.lock();                 // 多個讀取者可以同時進入
            try {
                return data.get(key);
            } finally {
                readLock.unlock();
            }
        }

        void put(String key, String value) {
            writeLock.lock();                // 寫入時排斥所有讀取與其他寫入
            try {
                data.put(key, value);
            } finally {
                writeLock.unlock();
            }
        }

        /** ⚠️ 不能在持有讀鎖時升級成寫鎖（會死鎖！）*/
        String getOrCompute(String key, java.util.function.Function<String, String> loader) {
            readLock.lock();
            try {
                String v = data.get(key);
                if (v != null) return v;
            } finally {
                readLock.unlock();           // ✅ 必須先放掉讀鎖
            }

            writeLock.lock();
            try {
                // 再檢查一次（其他執行緒可能已經填了）
                return data.computeIfAbsent(key, loader);
            } finally {
                writeLock.unlock();
            }
        }

        int size() {
            readLock.lock();
            try { return data.size(); } finally { readLock.unlock(); }
        }
    }

    public static void main(String[] args) throws InterruptedException {
        var config = new CachedConfig();
        config.put("host", "localhost");

        // 8 條讀取執行緒 + 1 條寫入執行緒
        Thread[] readers = new Thread[8];
        for (int i = 0; i < 8; i++) {
            readers[i] = new Thread(() -> {
                for (int j = 0; j < 200_000; j++) config.get("host");
            });
        }
        Thread writer = new Thread(() -> {
            for (int j = 0; j < 1000; j++) config.put("key" + j, "v" + j);
        });

        long start = System.currentTimeMillis();
        for (Thread t : readers) t.start();
        writer.start();
        for (Thread t : readers) t.join();
        writer.join();

        System.out.println("耗時: " + (System.currentTimeMillis() - start) + " ms");
        System.out.println("size: " + config.size());
        System.out.println("getOrCompute: " + config.getOrCompute("new", k -> "computed-" + k));

        System.out.println("""

                ReadWriteLock 的適用條件（三個都要滿足）：
                  ① 讀取遠多於寫入（至少 10:1）
                  ② 讀取操作本身有一定成本（否則鎖的開銷大於節省）
                  ③ 不需要「讀取時升級成寫入」

                否則：直接用 ConcurrentHashMap 或不可變物件 + volatile 替換（8.6 節）
                通常都比自己管 ReadWriteLock 好。
                """);
    }
}
```

### `Condition`：取代 `wait` / `notify`

```java
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

public class ConditionDemo {

    /** 手寫一個有界佇列，展示 Condition 的用法 */
    static class BoundedBuffer<E> {
        private final Deque<E> queue = new ArrayDeque<>();
        private final int capacity;
        private final ReentrantLock lock = new ReentrantLock();
        private final Condition notFull = lock.newCondition();
        private final Condition notEmpty = lock.newCondition();

        BoundedBuffer(int capacity) {
            this.capacity = capacity;
        }

        void put(E item) throws InterruptedException {
            lock.lock();
            try {
                // ⚠️ 一定要用 while 而不是 if！（假醒 spurious wakeup）
                while (queue.size() == capacity) {
                    notFull.await();
                }
                queue.addLast(item);
                notEmpty.signal();          // 只喚醒等「非空」的執行緒
            } finally {
                lock.unlock();
            }
        }

        E take() throws InterruptedException {
            lock.lock();
            try {
                while (queue.isEmpty()) {
                    notEmpty.await();
                }
                E item = queue.pollFirst();
                notFull.signal();
                return item;
            } finally {
                lock.unlock();
            }
        }

        int size() {
            lock.lock();
            try { return queue.size(); } finally { lock.unlock(); }
        }
    }

    public static void main(String[] args) throws InterruptedException {
        var buffer = new BoundedBuffer<Integer>(5);

        Thread producer = new Thread(() -> {
            try {
                for (int i = 1; i <= 20; i++) {
                    buffer.put(i);
                    System.out.println("生產 " + i + "（緩衝區 " + buffer.size() + "）");
                    Thread.sleep(10);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "producer");

        Thread consumer = new Thread(() -> {
            try {
                for (int i = 1; i <= 20; i++) {
                    Thread.sleep(30);          // 消費比生產慢 → 緩衝區會滿
                    int item = buffer.take();
                    System.out.println("        消費 " + item);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "consumer");

        producer.start();
        consumer.start();
        producer.join();
        consumer.join();

        System.out.println("""

                ⚠️ 兩個必記的規則：
                  ① await() 一定要在 while 迴圈裡，不能用 if。
                     原因：「假醒（spurious wakeup）」—— 作業系統可能無故喚醒執行緒。
                     而且 signal 之後到真正拿到鎖之間，狀態可能又被別人改了。
                  ② 用 signal() 而不是 signalAll()，前提是「等待者都在等同一件事」。
                     不確定時用 signalAll() 比較安全（代價是多餘的喚醒）。

                ✅ 但實務上不要自己寫這個 —— 直接用 java.util.concurrent 的
                   ArrayBlockingQueue / LinkedBlockingQueue（8.10 節）。
                   它們是同一批人寫的、經過大量驗證的、而且更快。
                """);
    }
}
```

### 三種鎖的選擇

| | `synchronized` | `ReentrantLock` | `ReadWriteLock` |
|---|---|---|---|
| 語法 | 簡潔，自動釋放 | 手動 `lock`/`unlock` | 同 |
| 忘記釋放 | 不可能 | **會永久死鎖** | 同 |
| 超時 / 可中斷 / tryLock | ❌ | ✅ | ✅ |
| 公平鎖 | ❌ | ✅ | ✅ |
| 多個等待條件 | 只有一個 wait set | ✅ 多個 `Condition` | ✅ |
| 診斷資訊 | jstack 看得到 | ✅ API 可查 | ✅ |
| 效能 | Java 15+ 後與 Lock 相當 | 相當 | 讀多寫少時更好 |
| 虛擬執行緒 | Java 24+ 不再 pin | 不會 pin | 不會 pin |

> **預設用 `synchronized`**（更簡潔、不可能忘記解鎖）。
> 需要**超時、可中斷、tryLock、多個條件**時才用 `ReentrantLock`。
> 需要**讀多寫少**才用 `ReadWriteLock`。
>
> ⚠️ **在 Java 21 上寫虛擬執行緒程式碼時**，`synchronized` 內的阻塞會「釘住」載體執行緒
> （8.14 節）。Java 24（JEP 491）修掉了這個問題。如果你在 Java 21 上大量使用虛擬執行緒，
> 熱路徑上的 `synchronized` 值得改成 `ReentrantLock`。

---

## 8.10 `BlockingQueue`：生產者-消費者的正解

```java
import java.util.concurrent.*;

public class BlockingQueueDemo {

    public static void main(String[] args) throws InterruptedException {

        // ===== 四種常用的 BlockingQueue =====
        System.out.println("""
                ArrayBlockingQueue(n)      有界，陣列實作，一把鎖。最常用
                LinkedBlockingQueue()      預設「無界」⚠️ 可能 OOM；LinkedBlockingQueue(n) 有界
                SynchronousQueue()         容量 0，put 必須等到有人 take（直接交接）
                PriorityBlockingQueue()    無界 + 依優先度取出（第 05 章 5.11 節）
                DelayQueue()               元素到期才能取出（延遲任務）
                LinkedTransferQueue()      更快的無界佇列，支援 transfer()
                """);

        // ===== API 的四組行為（一定要選對！）=====
        BlockingQueue<String> q = new ArrayBlockingQueue<>(2);
        q.put("a");
        q.put("b");

        System.out.println("--- 佇列已滿時的四種行為 ---");
        System.out.println("① add()      → 丟例外");
        try {
            q.add("c");
        } catch (IllegalStateException e) {
            System.out.println("   IllegalStateException: Queue full");
        }

        System.out.println("② offer()    → 回傳 false: " + q.offer("c"));

        System.out.println("③ offer(timeout) → 等一下再放棄: "
                + q.offer("c", 100, TimeUnit.MILLISECONDS));

        System.out.println("④ put()      → 一直等（會阻塞，這裡不示範避免卡住）");

        System.out.println("\n--- 佇列空時 ---");
        q.clear();
        System.out.println("① remove()   → 丟 NoSuchElementException");
        System.out.println("② poll()     → 回傳 null: " + q.poll());
        System.out.println("③ poll(timeout) → " + q.poll(100, TimeUnit.MILLISECONDS));
        System.out.println("④ take()     → 一直等");

        // ===== 生產者-消費者：對照 8.9 節的手寫版，短了一大半 =====
        System.out.println("\n=== 生產者-消費者 ===");
        producerConsumer();
    }

    /** 用 poison pill 通知消費者結束 */
    private static final String POISON_PILL = "__END__";

    static void producerConsumer() throws InterruptedException {
        BlockingQueue<String> queue = new ArrayBlockingQueue<>(5);
        int consumerCount = 3;

        Thread producer = new Thread(() -> {
            try {
                for (int i = 1; i <= 12; i++) {
                    queue.put("任務-" + i);
                    System.out.println("生產 任務-" + i + "（佇列 " + queue.size() + "）");
                }
                // 每個消費者一顆毒藥丸
                for (int i = 0; i < consumerCount; i++) {
                    queue.put(POISON_PILL);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "producer");

        Thread[] consumers = new Thread[consumerCount];
        for (int i = 0; i < consumerCount; i++) {
            consumers[i] = new Thread(() -> {
                try {
                    while (true) {
                        String task = queue.take();
                        if (POISON_PILL.equals(task)) {
                            System.out.println("  " + Thread.currentThread().getName() + " 收到結束訊號");
                            break;
                        }
                        Thread.sleep(50);       // 模擬處理
                        System.out.println("  " + Thread.currentThread().getName()
                                + " 完成 " + task);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }, "consumer-" + i);
        }

        producer.start();
        for (Thread c : consumers) c.start();
        producer.join();
        for (Thread c : consumers) c.join();
        System.out.println("全部完成，佇列剩餘: " + queue.size());
    }
}
```

輸出（節錄）：

```
--- 佇列已滿時的四種行為 ---
① add()      → 丟例外
   IllegalStateException: Queue full
② offer()    → 回傳 false: false
③ offer(timeout) → 等一下再放棄: false
④ put()      → 一直等（會阻塞，這裡不示範避免卡住）

=== 生產者-消費者 ===
生產 任務-1（佇列 1）
生產 任務-2（佇列 2）
...
  consumer-0 完成 任務-1
  consumer-1 完成 任務-2
...
  consumer-0 收到結束訊號
  consumer-1 收到結束訊號
  consumer-2 收到結束訊號
全部完成，佇列剩餘: 0
```

> **`BlockingQueue` 的三個實務價值：**
>
> 1. **天然的背壓（backpressure）**：佇列滿了，生產者自動被阻塞。
>    這比「無界佇列 + 記憶體爆掉」好得多。
> 2. **解耦生產與消費速率**：兩邊可以獨立調整執行緒數。
> 3. **不需要自己寫 `wait`/`notify`**：8.9 節那 40 行手寫版，這裡是 0 行。
>
> ⚠️ **一定要用「有界」佇列**。`new LinkedBlockingQueue<>()` 預設容量是 `Integer.MAX_VALUE`，
> 等於無界——生產者永遠不會被阻塞，記憶體會一直漲到 OOM。**這是 8.11 節的核心議題。**

---

## 8.11 `ExecutorService`：不要自己 `new Thread`

手動 `new Thread` 的三個問題：

1. **建立成本高**：每條平台執行緒約佔 1MB 堆疊 + 作業系統資源，建立需要幾十微秒。
2. **無法限制數量**：來 10000 個請求就開 10000 條執行緒 → `OutOfMemoryError: unable to create new native thread`。
3. **無法重用、無法管理**：沒有統一的關閉、沒有統計、沒有拒絕策略。

### `ThreadPoolExecutor` 的七個參數

```java
import java.util.concurrent.*;

public class ThreadPoolParameters {

    public static void main(String[] args) {
        var pool = new ThreadPoolExecutor(
                4,                                      // ① corePoolSize：核心執行緒數
                16,                                     // ② maximumPoolSize：最大執行緒數
                60L, TimeUnit.SECONDS,                  // ③④ keepAliveTime：非核心執行緒的閒置回收時間
                new ArrayBlockingQueue<>(100),          // ⑤ workQueue：任務佇列（一定要有界！）
                new ThreadFactory() {                   // ⑥ threadFactory：命名 + 例外處理
                    private final java.util.concurrent.atomic.AtomicInteger seq =
                            new java.util.concurrent.atomic.AtomicInteger(1);

                    @Override
                    public Thread newThread(Runnable r) {
                        Thread t = new Thread(r, "order-worker-" + seq.getAndIncrement());
                        t.setUncaughtExceptionHandler((thread, e) ->
                                System.err.printf("[ERROR] 執行緒 %s 未捕捉的例外: %s%n",
                                        thread.getName(), e));
                        return t;
                    }
                },
                new ThreadPoolExecutor.CallerRunsPolicy()  // ⑦ handler：拒絕策略
        );

        System.out.println("""
                任務進來時的決策流程（順序很重要）：

                  submit(task)
                      │
                      ├─ 執行緒數 < corePoolSize？
                      │     是 → 建立新執行緒執行（即使有閒置的核心執行緒也會建！）
                      │
                      ├─ 佇列還有空位？
                      │     是 → 放進佇列排隊
                      │
                      ├─ 執行緒數 < maximumPoolSize？
                      │     是 → 建立新執行緒執行
                      │
                      └─ 都不行 → 交給拒絕策略處理

                ⚠️ 這個順序帶來一個反直覺的後果：
                   「佇列滿了才會開超過 corePoolSize 的執行緒」。
                   所以如果你用「無界佇列」，maximumPoolSize 永遠不會生效！
                """);

        pool.shutdown();
    }
}
```

### ⚠️ 為什麼不要用 `Executors` 的工廠方法

```java
import java.util.concurrent.*;

public class ExecutorsFactoryPitfalls {

    public static void main(String[] args) {
        System.out.println("""
                ❌ Executors.newFixedThreadPool(n)
                   內部：new ThreadPoolExecutor(n, n, 0L, MILLISECONDS,
                                                new LinkedBlockingQueue<Runnable>())
                                                              ↑ 無界！容量 Integer.MAX_VALUE
                   後果：任務堆積時記憶體一路漲 → OOM。而且沒有任何背壓訊號。

                ❌ Executors.newCachedThreadPool()
                   內部：new ThreadPoolExecutor(0, Integer.MAX_VALUE, 60L, SECONDS,
                                                new SynchronousQueue<Runnable>())
                                                   ↑ 執行緒數無上限！
                   後果：突發流量時開出幾萬條執行緒 → OOM: unable to create new native thread

                ❌ Executors.newSingleThreadExecutor()
                   同樣是無界 LinkedBlockingQueue。

                ❌ Executors.newScheduledThreadPool(n)
                   內部用無界的 DelayedWorkQueue。

                ✅ 一律自己 new ThreadPoolExecutor(...)，明確指定有界佇列與拒絕策略。
                   （阿里巴巴 Java 開發手冊、Google Java Style 都明文禁止用 Executors 工廠方法）

                ✅ 例外：Executors.newVirtualThreadPerTaskExecutor()（Java 21+）
                   虛擬執行緒非常輕量，這個是安全的（但仍要用 Semaphore 控制併發，見 8.14 節）
                """);
    }
}
```

**實測無界佇列的後果：**

```java
import java.util.concurrent.*;

public class UnboundedQueueDanger {

    public static void main(String[] args) throws InterruptedException {
        // 用 -Xmx128m 執行這段程式來重現 OOM
        var pool = Executors.newFixedThreadPool(2);      // ❌ 無界佇列

        System.out.println("持續丟入任務，觀察佇列長度…");
        try {
            for (int i = 1; i <= 2_000_000; i++) {
                final int id = i;
                pool.submit(() -> {
                    try {
                        Thread.sleep(1000);              // 每個任務很慢
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    return id;
                });

                if (i % 200_000 == 0) {
                    var tpe = (ThreadPoolExecutor) pool;
                    System.out.printf("已提交 %,d，佇列長度 %,d，已用堆積 %,d MB%n",
                            i, tpe.getQueue().size(),
                            (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory())
                                    / 1024 / 1024);
                }
            }
        } catch (OutOfMemoryError e) {
            System.err.println("💥 OutOfMemoryError：佇列吃光了記憶體");
        }
        pool.shutdownNow();
    }
}
```

典型輸出（`-Xmx128m`）：

```
持續丟入任務，觀察佇列長度…
已提交 200,000，佇列長度 199,998，已用堆積 38 MB
已提交 400,000，佇列長度 399,998，已用堆積 71 MB
已提交 600,000，佇列長度 599,998，已用堆積 105 MB
💥 OutOfMemoryError：佇列吃光了記憶體
```

> **注意佇列長度幾乎等於提交數**——只有 2 條執行緒在做事，其餘全部在排隊。
> 這就是「無界佇列」把「執行緒池」變成「記憶體炸彈」的方式。

### 四種拒絕策略

```java
import java.util.concurrent.*;

public class RejectionPolicies {

    public static void main(String[] args) throws InterruptedException {
        System.out.println("=== 四種拒絕策略對照 ===\n");

        demo("AbortPolicy（預設）", new ThreadPoolExecutor.AbortPolicy());
        demo("CallerRunsPolicy", new ThreadPoolExecutor.CallerRunsPolicy());
        demo("DiscardPolicy", new ThreadPoolExecutor.DiscardPolicy());
        demo("DiscardOldestPolicy", new ThreadPoolExecutor.DiscardOldestPolicy());
        demo("自訂：記 log + 降級", new LoggingRejectionHandler());

        System.out.println("""

                選擇建議：
                  AbortPolicy         → 丟 RejectedExecutionException。上層要 catch 並回 503。
                                        適合「寧可拒絕也不要慢」的 API。
                  CallerRunsPolicy    → 呼叫者自己跑。★ 最實用：天然背壓，
                                        接收請求的執行緒被佔住 → 自動降低接收速率。
                  DiscardPolicy       → 靜默丟棄。❌ 幾乎永遠是錯的（第 04 章反模式 1）。
                  DiscardOldestPolicy → 丟掉最舊的。只適合「新資料比舊資料重要」（如即時報價）。
                  自訂                 → 實務首選：記 log + 上報監控 + 決定降級行為。
                """);
    }

    static void demo(String name, RejectedExecutionHandler handler) throws InterruptedException {
        // 1 條執行緒 + 容量 1 的佇列 → 第 3 個任務就會被拒絕
        var pool = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(1),
                r -> new Thread(r, "worker"),
                handler);

        System.out.println("--- " + name + " ---");
        for (int i = 1; i <= 4; i++) {
            final int id = i;
            try {
                pool.submit(() -> {
                    try { Thread.sleep(200); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    System.out.println("  任務 " + id + " 由 "
                            + Thread.currentThread().getName() + " 完成");
                });
            } catch (RejectedExecutionException e) {
                System.out.println("  任務 " + id + " 被拒絕: RejectedExecutionException");
            }
        }
        pool.shutdown();
        pool.awaitTermination(3, TimeUnit.SECONDS);
        System.out.println();
    }

    /** ✅ 實務上該用的：記錄 + 監控 + 明確的降級行為 */
    static class LoggingRejectionHandler implements RejectedExecutionHandler {
        private final java.util.concurrent.atomic.LongAdder rejected =
                new java.util.concurrent.atomic.LongAdder();

        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
            rejected.increment();
            System.err.printf("  [WARN] 任務被拒絕（第 %d 次）：池大小=%d/%d，"
                            + "佇列=%d，已完成=%d%n",
                    rejected.sum(), executor.getPoolSize(), executor.getMaximumPoolSize(),
                    executor.getQueue().size(), executor.getCompletedTaskCount());

            // 降級策略：這裡選擇「由呼叫者執行」，並在 log 中留下紀錄
            if (!executor.isShutdown()) {
                r.run();
            }
        }
    }
}
```

輸出（節錄）：

```
--- AbortPolicy（預設）---
  任務 3 被拒絕: RejectedExecutionException
  任務 4 被拒絕: RejectedExecutionException
  任務 1 由 worker 完成
  任務 2 由 worker 完成

--- CallerRunsPolicy ---
  任務 3 由 main 完成          ← 呼叫者自己跑了！這就是背壓
  任務 4 由 main 完成
  任務 1 由 worker 完成
  任務 2 由 worker 完成

--- DiscardPolicy ---
  任務 1 由 worker 完成
  任務 2 由 worker 完成
（任務 3、4 完全消失，沒有任何訊息）
```

### 執行緒池大小怎麼定

```java
public class PoolSizing {

    public static void main(String[] args) {
        int cores = Runtime.getRuntime().availableProcessors();

        System.out.printf("CPU 核心數: %d%n%n", cores);

        System.out.println("""
                === CPU 密集型 ===
                  最佳執行緒數 ≈ 核心數（或核心數 + 1）
                  理由：執行緒一直在算，多開只是徒增上下文切換
                  例：影像處理、加密、壓縮、複雜計算
                """);
        System.out.printf("  建議: %d ~ %d 條%n%n", cores, cores + 1);

        System.out.println("""
                === IO 密集型 ===
                  最佳執行緒數 ≈ 核心數 × (1 + 等待時間 / 計算時間)

                  例：一個請求要花 200ms（DB 查詢 190ms + 邏輯 10ms）
                      → 核心數 × (1 + 190/10) = 核心數 × 20
                """);
        int waitMs = 190, computeMs = 10;
        System.out.printf("  以上例計算: %d × (1 + %d/%d) = %d 條%n%n",
                cores, waitMs, computeMs, cores * (1 + waitMs / computeMs));

        System.out.println("""
                ⚠️ 但這個公式只是「起點」，不是答案。實務上還要考慮：

                  ① 下游能承受多少？
                     DB 連線池只有 20 條 → 開 160 條執行緒只會讓 140 條在等連線，
                     還可能把連線池等待逾時的錯誤放大。
                     ★ 執行緒池大小應該 ≤ 下游資源的容量。

                  ② 記憶體夠不夠？
                     每條平台執行緒 ≈ 1MB 堆疊（-Xss 決定）。
                     1000 條 = 1GB，還沒算堆積上的物件。

                  ③ 有沒有多個池互相搶 CPU？
                     一個服務常有：Tomcat 池 + 業務池 + 排程池 + HTTP 客戶端池。
                     總和不該遠超核心數。

                  ④ ★ 最重要：實測。
                     用壓測工具（k6 / JMeter / wrk）逐步加大並發，
                     觀察「吞吐量」與「P99 延遲」的轉折點。
                     吞吐量不再上升而延遲開始飆 → 就是那個大小。

                === Java 21 之後的新選項 ===
                  IO 密集 → 直接用虛擬執行緒（8.14 節），
                            不用再算這個公式，也不用擔心「開太多」。
                  CPU 密集 → 仍然用平台執行緒池，大小 = 核心數。
                """);
    }
}
```

### 生命週期管理

```java
import java.util.concurrent.*;

public class ExecutorLifecycle {

    public static void main(String[] args) throws InterruptedException {

        // ===== shutdown vs shutdownNow =====
        System.out.println("=== shutdown()：不收新任務，等現有任務做完 ===");
        var pool1 = newPool();
        submitTasks(pool1, 5);
        pool1.shutdown();                          // 不阻塞，立刻返回
        System.out.println("  isShutdown: " + pool1.isShutdown());
        System.out.println("  isTerminated: " + pool1.isTerminated());   // false，還在跑
        boolean done = pool1.awaitTermination(5, TimeUnit.SECONDS);
        System.out.println("  5 秒內完成: " + done);

        try {
            pool1.submit(() -> System.out.println("不會執行"));
        } catch (RejectedExecutionException e) {
            System.out.println("  shutdown 後提交新任務 → RejectedExecutionException");
        }

        System.out.println("\n=== shutdownNow()：中斷正在執行的任務，回傳未執行的 ===");
        var pool2 = newPool();
        submitTasks(pool2, 10);
        Thread.sleep(150);
        var notRun = pool2.shutdownNow();
        System.out.println("  尚未執行的任務數: " + notRun.size());
        pool2.awaitTermination(2, TimeUnit.SECONDS);

        // ===== ✅ 標準的優雅關閉樣板 =====
        System.out.println("\n=== 優雅關閉樣板 ===");
        var pool3 = newPool();
        submitTasks(pool3, 6);
        shutdownGracefully(pool3, 2, TimeUnit.SECONDS);

        // ===== 【Java 19+】ExecutorService 實作了 AutoCloseable =====
        System.out.println("\n=== try-with-resources（Java 19+）===");
        try (var pool4 = newPool()) {
            submitTasks(pool4, 4);
        }   // close() = shutdown() + 無限等待 awaitTermination()（會被中斷打斷）
        System.out.println("  離開 try 區塊時已全部完成");

        // ===== 監控指標 =====
        System.out.println("\n=== 該監控的指標 ===");
        var pool5 = newPool();
        submitTasks(pool5, 20);
        Thread.sleep(200);
        printMetrics(pool5);
        shutdownGracefully(pool5, 3, TimeUnit.SECONDS);
    }

    static ThreadPoolExecutor newPool() {
        return new ThreadPoolExecutor(2, 4, 60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(10),
                r -> new Thread(r, "task-worker"),
                new ThreadPoolExecutor.CallerRunsPolicy());
    }

    static void submitTasks(ExecutorService pool, int count) {
        for (int i = 1; i <= count; i++) {
            final int id = i;
            pool.submit(() -> {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    System.out.println("    任務 " + id + " 被中斷");
                    return;
                }
            });
        }
    }

    /** ✅ 這段程式碼值得存起來：所有專案的關閉邏輯都長這樣 */
    static void shutdownGracefully(ExecutorService pool, long timeout, TimeUnit unit) {
        pool.shutdown();                            // ① 停止接收新任務
        try {
            // ② 等現有任務完成
            if (!pool.awaitTermination(timeout, unit)) {
                System.out.println("  ⚠️ 超時，強制中斷剩餘任務");
                pool.shutdownNow();                 // ③ 強制中斷
                // ④ 再等一次（給任務反應中斷的時間）
                if (!pool.awaitTermination(timeout, unit)) {
                    System.err.println("  💀 執行緒池無法關閉（有任務吞掉了中斷）");
                }
            } else {
                System.out.println("  ✅ 全部任務正常完成");
            }
        } catch (InterruptedException e) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();      // 恢復旗標（第 04 章反模式 6）
        }
    }

    static void printMetrics(ThreadPoolExecutor pool) {
        System.out.printf("""
                  當前執行緒數 (poolSize)        : %d
                  活躍執行緒數 (activeCount)     : %d
                  歷史最大執行緒數 (largestPool) : %d
                  佇列中等待數 (queue.size)      : %d   ★ 最重要的指標
                  佇列剩餘容量                   : %d
                  已提交總數 (taskCount)         : %d
                  已完成總數 (completedTaskCount): %d
                """,
                pool.getPoolSize(), pool.getActiveCount(), pool.getLargestPoolSize(),
                pool.getQueue().size(), pool.getQueue().remainingCapacity(),
                pool.getTaskCount(), pool.getCompletedTaskCount());

        System.out.println("""
                  → 監控告警規則：
                    ① queue.size 持續接近容量  = 處理能力不足，該擴容或優化
                    ② activeCount 持續等於 max = 池已飽和
                    ③ 拒絕次數 > 0             = 已經在丟任務了，必須立刻處理
                """);
    }
}
```

> **在 Spring Boot 裡**（第 02 站）：用 `ThreadPoolTaskExecutor` 並註冊成 Bean，
> Spring 會在關機時自動呼叫 `shutdown`。搭配 `setWaitForTasksToCompleteOnShutdown(true)`
> 與 `setAwaitTerminationSeconds(30)`，就是上面 `shutdownGracefully` 的設定版。
> Micrometer 也會自動把上面那些指標暴露到 `/actuator/metrics`。

---

## 8.12 `Future` 與 `CompletableFuture`

### `Future` 的侷限

```java
import java.util.List;
import java.util.concurrent.*;

public class FutureBasics {

    public static void main(String[] args) throws Exception {
        try (var pool = Executors.newFixedThreadPool(4)) {

            // submit 回傳 Future
            Future<String> future = pool.submit(() -> {
                Thread.sleep(300);
                return "結果";
            });

            System.out.println("提交後立刻返回，isDone: " + future.isDone());   // false
            System.out.println("get() 會阻塞直到完成: " + future.get());          // 結果
            System.out.println("完成後 isDone: " + future.isDone());             // true

            // 帶超時的 get
            Future<String> slow = pool.submit(() -> {
                Thread.sleep(5000);
                return "很慢";
            });
            try {
                slow.get(200, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                System.out.println("\n超時了，取消任務: " + slow.cancel(true));
                System.out.println("isCancelled: " + slow.isCancelled());
            }

            // 例外會被包成 ExecutionException
            Future<String> failing = pool.submit(() -> {
                throw new IllegalStateException("任務內部失敗");
            });
            try {
                failing.get();
            } catch (ExecutionException e) {
                System.out.println("\nExecutionException 的 cause: " + e.getCause());
                // ⚠️ 一定要看 getCause()，否則看不到真正的錯誤（第 04 章 4.7 節）
            }

            // invokeAll：全部完成才返回
            System.out.println("\n--- invokeAll（等全部）---");
            List<Callable<Integer>> tasks = List.of(
                    () -> { Thread.sleep(100); return 1; },
                    () -> { Thread.sleep(200); return 2; },
                    () -> { Thread.sleep(300); return 3; });
            long start = System.currentTimeMillis();
            List<Future<Integer>> results = pool.invokeAll(tasks);
            System.out.println("耗時: " + (System.currentTimeMillis() - start)
                    + " ms（等最慢的那個）");
            for (Future<Integer> f : results) System.out.print(f.get() + " ");
            System.out.println();

            // invokeAny：任一完成就返回（其餘被取消）
            System.out.println("\n--- invokeAny（取最快）---");
            start = System.currentTimeMillis();
            Integer fastest = pool.invokeAny(tasks);
            System.out.println("最快的結果: " + fastest + "，耗時: "
                    + (System.currentTimeMillis() - start) + " ms");
        }

        System.out.println("""

                Future 的三個侷限（CompletableFuture 就是為了解決它們）：
                  ① 只能用「阻塞的 get()」拿結果，無法註冊「完成後做什麼」的回呼
                  ② 無法組合：「A 完成後用結果去做 B」只能寫成 get() 之後再 submit
                  ③ 無法優雅處理例外：只能 try-catch 包住 get()
                """);
    }
}
```

### `CompletableFuture`：組合非同步任務

```java
import java.util.concurrent.*;
import java.util.List;

public class CompletableFutureBasics {

    // ✅ 一定要自己指定 Executor，不要用預設的 commonPool（見下方說明）
    static final ExecutorService IO_POOL = new ThreadPoolExecutor(
            8, 32, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            r -> {
                Thread t = new Thread(r, "io-pool");
                t.setDaemon(true);
                return t;
            },
            new ThreadPoolExecutor.CallerRunsPolicy());

    public static void main(String[] args) throws Exception {

        // ===== 建立 =====
        System.out.println("--- 建立 ---");
        System.out.println(CompletableFuture.completedFuture("已完成的值").get());
        System.out.println(CompletableFuture.supplyAsync(() -> "非同步結果", IO_POOL).get());
        CompletableFuture.runAsync(() -> System.out.println("沒有回傳值的任務"), IO_POOL).get();

        // ===== 轉換：thenApply（像 Stream 的 map）=====
        System.out.println("\n--- thenApply（轉換）---");
        String result = CompletableFuture
                .supplyAsync(() -> "hello", IO_POOL)
                .thenApply(String::toUpperCase)                 // 在完成的那條執行緒上執行
                .thenApply(s -> s + " WORLD")
                .thenApplyAsync(s -> s + "!", IO_POOL)          // 換到指定的池執行
                .get();
        System.out.println(result);                              // HELLO WORLD!

        // ===== 串接：thenCompose（像 Stream 的 flatMap）=====
        System.out.println("\n--- thenCompose（前一步的結果決定下一步）---");
        String chained = fetchUserId("gary@example.com")
                .thenCompose(CompletableFutureBasics::fetchUserName)   // 回傳 CompletableFuture
                .thenCompose(CompletableFutureBasics::fetchGreeting)
                .get();
        System.out.println(chained);

        // ⚠️ 用 thenApply 接一個回傳 CompletableFuture 的函式會得到巢狀型別
        CompletableFuture<CompletableFuture<String>> nested = fetchUserId("a@b.com")
                .thenApply(CompletableFutureBasics::fetchUserName);   // ❌ 巢狀
        System.out.println("巢狀型別（需要兩次 get）: " + nested.get().get());

        // ===== 合併：thenCombine（兩個獨立任務都完成後合併）=====
        System.out.println("\n--- thenCombine（並行後合併）---");
        long start = System.currentTimeMillis();
        String combined = fetchProfile("u001")
                .thenCombine(fetchOrders("u001"),
                        (profile, orders) -> profile + " 有 " + orders + " 筆訂單")
                .get();
        System.out.printf("%s（耗時 %d ms，兩個查詢是並行的）%n",
                combined, System.currentTimeMillis() - start);

        // ===== 等全部：allOf =====
        System.out.println("\n--- allOf（等全部完成）---");
        start = System.currentTimeMillis();
        List<CompletableFuture<String>> futures = List.of(
                delayedValue("A", 100), delayedValue("B", 200), delayedValue("C", 300));

        // allOf 回傳 CompletableFuture<Void>，要自己收集結果
        CompletableFuture<List<String>> all = CompletableFuture
                .allOf(futures.toArray(CompletableFuture[]::new))
                .thenApply(v -> futures.stream().map(CompletableFuture::join).toList());
        //                                                      ↑ 此時已完成，join 不會阻塞

        System.out.printf("%s（耗時 %d ms，等最慢的）%n", all.get(), System.currentTimeMillis() - start);

        // ===== 取最快：anyOf =====
        System.out.println("\n--- anyOf（取最快）---");
        start = System.currentTimeMillis();
        Object fastest = CompletableFuture.anyOf(
                delayedValue("慢", 500), delayedValue("快", 50), delayedValue("中", 200)).get();
        System.out.printf("%s（耗時 %d ms）%n", fastest, System.currentTimeMillis() - start);

        IO_POOL.shutdown();
    }

    // ===== 模擬的非同步操作 =====

    static CompletableFuture<String> fetchUserId(String email) {
        return CompletableFuture.supplyAsync(() -> {
            sleep(50);
            return "u-" + email.hashCode();
        }, IO_POOL);
    }

    static CompletableFuture<String> fetchUserName(String userId) {
        return CompletableFuture.supplyAsync(() -> {
            sleep(50);
            return "小明(" + userId + ")";
        }, IO_POOL);
    }

    static CompletableFuture<String> fetchGreeting(String name) {
        return CompletableFuture.supplyAsync(() -> "你好, " + name, IO_POOL);
    }

    static CompletableFuture<String> fetchProfile(String userId) {
        return CompletableFuture.supplyAsync(() -> {
            sleep(200);
            return "使用者 " + userId;
        }, IO_POOL);
    }

    static CompletableFuture<Integer> fetchOrders(String userId) {
        return CompletableFuture.supplyAsync(() -> {
            sleep(200);
            return 42;
        }, IO_POOL);
    }

    static CompletableFuture<String> delayedValue(String value, long millis) {
        return CompletableFuture.supplyAsync(() -> {
            sleep(millis);
            return value;
        }, IO_POOL);
    }

    static void sleep(long millis) {
        try { Thread.sleep(millis); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CompletionException(e);
        }
    }
}
```

輸出（節錄）：

```
--- thenCombine（並行後合併）---
使用者 u001 有 42 筆訂單（耗時 210 ms，兩個查詢是並行的）

--- allOf（等全部完成）---
[A, B, C]（耗時 305 ms，等最慢的）

--- anyOf（取最快）---
快（耗時 55 ms）
```

### 例外處理與逾時

```java
import java.util.concurrent.*;

public class CompletableFutureErrors {

    static final ExecutorService POOL = Executors.newFixedThreadPool(4);

    public static void main(String[] args) throws Exception {

        // ===== exceptionally：只在失敗時介入，提供備援值 =====
        System.out.println("--- exceptionally（降級）---");
        String r1 = failing()
                .exceptionally(ex -> {
                    System.out.println("  捕捉到: " + ex.getClass().getSimpleName()
                            + " → " + ex.getCause().getMessage());
                    return "(降級值)";
                })
                .get();
        System.out.println("  結果: " + r1);

        // ===== handle：成功與失敗都處理（像 finally + 轉換）=====
        System.out.println("\n--- handle（兩種情況都處理）---");
        System.out.println("  成功: " + succeeding()
                .handle((value, ex) -> ex == null ? "OK:" + value : "ERR:" + ex.getMessage())
                .get());
        System.out.println("  失敗: " + failing()
                .handle((value, ex) -> ex == null ? "OK:" + value : "ERR:降級")
                .get());

        // ===== whenComplete：只觀察，不改變結果（像 peek）=====
        System.out.println("\n--- whenComplete（觀察但不改變）---");
        try {
            failing()
                    .whenComplete((value, ex) ->
                            System.out.println("  記錄: value=" + value + ", ex=" + ex))
                    .get();
        } catch (ExecutionException e) {
            System.out.println("  例外仍然往外傳: " + e.getCause().getMessage());
        }

        // ===== 逾時【Java 9+】=====
        System.out.println("\n--- orTimeout / completeOnTimeout ---");
        try {
            slowTask(2000).orTimeout(200, TimeUnit.MILLISECONDS).get();
        } catch (ExecutionException e) {
            System.out.println("  orTimeout → " + e.getCause().getClass().getSimpleName());
        }

        System.out.println("  completeOnTimeout → "
                + slowTask(2000).completeOnTimeout("(逾時預設值)", 200, TimeUnit.MILLISECONDS).get());

        // ===== 實務組合：呼叫外部 API 的完整防護 =====
        System.out.println("\n--- 實務樣板：逾時 + 降級 + 記錄 ---");
        for (int i = 0; i < 3; i++) {
            System.out.println("  " + callExternalApiSafely("req-" + i).get());
        }

        // ===== ⚠️ join() vs get() =====
        System.out.println("""

                join() vs get()：
                  get()  → 丟 checked ExecutionException + InterruptedException
                  join() → 丟 unchecked CompletionException

                在 Stream / lambda 裡用 join()（不用處理 checked 例外，第 06 章 6.6 節）：
                    futures.stream().map(CompletableFuture::join).toList()

                ⚠️ 兩者都會「阻塞」。在虛擬執行緒上阻塞很便宜，
                   在平台執行緒上要小心不要佔住整個池。
                """);

        POOL.shutdown();
    }

    static CompletableFuture<String> succeeding() {
        return CompletableFuture.supplyAsync(() -> "成功", POOL);
    }

    static CompletableFuture<String> failing() {
        return CompletableFuture.supplyAsync(() -> {
            throw new IllegalStateException("外部服務 500");
        }, POOL);
    }

    static CompletableFuture<String> slowTask(long millis) {
        return CompletableFuture.supplyAsync(() -> {
            try { Thread.sleep(millis); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return "慢任務完成";
        }, POOL);
    }

    /** ✅ 實務上呼叫外部 API 該長的樣子 */
    static CompletableFuture<String> callExternalApiSafely(String requestId) {
        return CompletableFuture
                .supplyAsync(() -> {
                    // 模擬：三分之一機率失敗、三分之一很慢
                    int r = Math.abs(requestId.hashCode()) % 3;
                    if (r == 0) throw new IllegalStateException("上游 503");
                    if (r == 1) {
                        try { Thread.sleep(1000); } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    return "上游回應 for " + requestId;
                }, POOL)
                .orTimeout(300, TimeUnit.MILLISECONDS)          // ① 逾時保護
                .handle((value, ex) -> {                         // ② 統一降級
                    if (ex == null) return value;
                    Throwable cause = ex instanceof CompletionException ? ex.getCause() : ex;
                    String reason = cause instanceof TimeoutException ? "逾時" : cause.getMessage();
                    System.err.printf("    [WARN] %s 失敗（%s），使用快取降級%n", requestId, reason);
                    return "快取值 for " + requestId;            // ③ 降級值
                });
    }
}
```

輸出（節錄）：

```
--- orTimeout / completeOnTimeout ---
  orTimeout → TimeoutException
  completeOnTimeout → (逾時預設值)

--- 實務樣板：逾時 + 降級 + 記錄 ---
    [WARN] req-0 失敗（上游 503），使用快取降級
  快取值 for req-0
    [WARN] req-1 失敗（逾時），使用快取降級
  快取值 for req-1
  上游回應 for req-2
```

### ⚠️ 不要在 `commonPool` 上做阻塞 IO

```java
import java.util.concurrent.*;
import java.util.stream.IntStream;

public class CommonPoolTrap {

    public static void main(String[] args) throws Exception {
        System.out.println("commonPool 平行度: "
                + ForkJoinPool.getCommonPoolParallelism());
        System.out.println("（= CPU 核心數 - 1，所以 8 核心機器只有 7 條執行緒）\n");

        // ❌ 沒指定 Executor → 用 ForkJoinPool.commonPool()
        System.out.println("=== 不指定 Executor（用 commonPool）===");
        long start = System.currentTimeMillis();
        var futures = IntStream.range(0, 50)
                .mapToObj(i -> CompletableFuture.supplyAsync(() -> {
                    try { Thread.sleep(100); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    return i;
                }))                                          // ← 沒有第二個參數
                .toList();
        CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new)).join();
        System.out.printf("50 個 100ms 的任務耗時: %d ms（受限於 commonPool 的 7 條執行緒）%n",
                System.currentTimeMillis() - start);

        // ✅ 指定專用的 IO 池
        System.out.println("\n=== 指定專用 IO 池 ===");
        try (var ioPool = Executors.newFixedThreadPool(50)) {
            start = System.currentTimeMillis();
            var futures2 = IntStream.range(0, 50)
                    .mapToObj(i -> CompletableFuture.supplyAsync(() -> {
                        try { Thread.sleep(100); } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return i;
                    }, ioPool))                              // ← 指定池
                    .toList();
            CompletableFuture.allOf(futures2.toArray(CompletableFuture[]::new)).join();
            System.out.printf("耗時: %d ms%n", System.currentTimeMillis() - start);
        }

        // ✅✅ Java 21：虛擬執行緒（8.14 節）
        System.out.println("\n=== 虛擬執行緒 ===");
        try (var vPool = Executors.newVirtualThreadPerTaskExecutor()) {
            start = System.currentTimeMillis();
            var futures3 = IntStream.range(0, 50)
                    .mapToObj(i -> CompletableFuture.supplyAsync(() -> {
                        try { Thread.sleep(100); } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return i;
                    }, vPool))
                    .toList();
            CompletableFuture.allOf(futures3.toArray(CompletableFuture[]::new)).join();
            System.out.printf("耗時: %d ms%n", System.currentTimeMillis() - start);
        }

        System.out.println("""

                ⚠️ commonPool 是「整個 JVM 共用」的（第 06 章 6.15 節平行流也用它）。
                   在上面做阻塞 IO 會拖垮所有其他使用者。

                ✅ 規則：CompletableFuture.supplyAsync / thenXxxAsync
                        「永遠」傳入自己的 Executor。
                """);
    }
}
```

典型輸出（8 核心）：

```
commonPool 平行度: 7
（= CPU 核心數 - 1，所以 8 核心機器只有 7 條執行緒）

=== 不指定 Executor（用 commonPool）===
50 個 100ms 的任務耗時: 800 ms（受限於 commonPool 的 7 條執行緒）

=== 指定專用 IO 池 ===
耗時: 107 ms

=== 虛擬執行緒 ===
耗時: 105 ms
```

---

## 8.13 `ThreadLocal`：好用但有兩個坑

```java
import java.text.SimpleDateFormat;
import java.util.concurrent.*;

public class ThreadLocalBasics {

    // ===== 用途 1：讓非執行緒安全的物件可以「每執行緒一份」=====
    // （第 07 章 7.13 節：SimpleDateFormat 不是執行緒安全的）
    private static final ThreadLocal<SimpleDateFormat> FORMATTER =
            ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd"));

    // ===== 用途 2：隱式傳遞上下文（不用把參數穿透十層方法）=====
    record RequestContext(String traceId, String userId, String tenantId) { }

    private static final ThreadLocal<RequestContext> CONTEXT = new ThreadLocal<>();

    public static void main(String[] args) throws Exception {

        // 用途 1
        try (var pool = Executors.newFixedThreadPool(4)) {
            for (int i = 0; i < 8; i++) {
                pool.submit(() -> {
                    String s = FORMATTER.get().format(new java.util.Date());
                    // 每條執行緒有自己的 SimpleDateFormat → 不會互相踩
                    return s;
                });
            }
        }
        System.out.println("✅ 每執行緒一個 SimpleDateFormat，不會有併發問題");

        // 用途 2：模擬一個請求的處理流程
        System.out.println("\n=== 隱式上下文傳遞 ===");
        handleRequest("trace-001", "u001", "tenant-a");
        handleRequest("trace-002", "u002", "tenant-b");
    }

    static void handleRequest(String traceId, String userId, String tenantId) {
        CONTEXT.set(new RequestContext(traceId, userId, tenantId));
        try {
            controllerLayer();
        } finally {
            CONTEXT.remove();          // ⚠️ 一定要 remove！見下方
        }
    }

    static void controllerLayer() {
        log("進入 Controller");
        serviceLayer();
    }

    static void serviceLayer() {
        log("進入 Service");
        repositoryLayer();
    }

    static void repositoryLayer() {
        // 不用從 Controller 一路傳 traceId 進來，也拿得到
        log("進入 Repository，查詢 tenant=" + CONTEXT.get().tenantId());
    }

    static void log(String message) {
        RequestContext ctx = CONTEXT.get();
        System.out.printf("[%s][%s] %s%n",
                ctx == null ? "no-context" : ctx.traceId(),
                Thread.currentThread().getName(), message);
    }
}
```

輸出：

```
✅ 每執行緒一個 SimpleDateFormat，不會有併發問題

=== 隱式上下文傳遞 ===
[trace-001][main] 進入 Controller
[trace-001][main] 進入 Service
[trace-001][main] 進入 Repository，查詢 tenant=tenant-a
[trace-002][main] 進入 Controller
[trace-002][main] 進入 Service
[trace-002][main] 進入 Repository，查詢 tenant=tenant-b
```

> **這正是 SLF4J 的 `MDC`（Mapped Diagnostic Context）與 Spring Security 的
> `SecurityContextHolder` 的實作方式**。第 04 章 4.10 節提到的 traceId，
> 就是靠 `ThreadLocal` 從 Filter 傳到每一層的 log。

### ⚠️ 坑 1：在執行緒池中造成資料洩漏

```java
import java.util.concurrent.*;

public class ThreadLocalLeak {

    private static final ThreadLocal<String> USER = new ThreadLocal<>();

    public static void main(String[] args) throws Exception {
        // 只有 1 條執行緒 → 一定會重用
        try (var pool = Executors.newFixedThreadPool(1)) {

            System.out.println("=== ❌ 忘記 remove()：上一個請求的資料洩漏到下一個 ===");
            pool.submit(() -> {
                USER.set("使用者-A");
                System.out.println("  請求 1 設定: " + USER.get());
                // 忘記 remove()
            }).get();

            pool.submit(() -> {
                // 沒有 set，直接讀
                System.out.println("  請求 2 讀到: " + USER.get() + "  💥 拿到別人的資料！");
            }).get();

            System.out.println("""
                    → 這是嚴重的資安問題：
                      A 使用者的 userId / 權限 / tenantId 洩漏給 B 使用者。
                      在多租戶系統裡，這等於「A 公司看到 B 公司的資料」。
                    """);

            System.out.println("=== ✅ 用 try-finally 保證 remove() ===");
            pool.submit(() -> {
                USER.set("使用者-C");
                try {
                    System.out.println("  請求 3 設定: " + USER.get());
                } finally {
                    USER.remove();
                }
            }).get();

            pool.submit(() -> {
                System.out.println("  請求 4 讀到: " + USER.get() + "  ✅ 乾淨的");
            }).get();
        }
    }
}
```

輸出：

```
=== ❌ 忘記 remove()：上一個請求的資料洩漏到下一個 ===
  請求 1 設定: 使用者-A
  請求 2 讀到: 使用者-A  💥 拿到別人的資料！

→ 這是嚴重的資安問題：
  A 使用者的 userId / 權限 / tenantId 洩漏給 B 使用者。
  在多租戶系統裡，這等於「A 公司看到 B 公司的資料」。

=== ✅ 用 try-finally 保證 remove() ===
  請求 3 設定: 使用者-C
  請求 4 讀到: null  ✅ 乾淨的
```

### ⚠️ 坑 2：記憶體洩漏

```java
public class ThreadLocalMemoryLeak {

    public static void main(String[] args) {
        System.out.println("""
                ThreadLocal 的內部結構：

                  Thread 物件
                    └─ threadLocals: ThreadLocalMap
                         └─ Entry[]
                              ├─ key:   WeakReference<ThreadLocal>   ← 弱引用
                              └─ value: Object                        ← 強引用！

                洩漏的路徑：
                  ① ThreadLocal 變數本身沒有強引用了（例如是區域變數，方法結束了）
                  ② key 被 GC 回收 → Entry 的 key 變成 null
                  ③ 但 value 是「強引用」，只要 Thread 還活著就不會被回收
                  ④ 執行緒池的執行緒「永遠活著」→ value 永久洩漏

                → 放了一個 100MB 的快取進 ThreadLocal 又忘記 remove，
                  那 100MB 就永遠回不來（第 09 章會用 heap dump 抓這種問題）

                ✅ 三個防護：
                  ① 一律 try-finally + remove()
                  ② ThreadLocal 宣告成 private static final（避免每次建新的）
                  ③ 用框架提供的機制（Spring 的 RequestContextHolder、
                    SLF4J 的 MDC）而不是自己管
                """);
    }
}
```

### `InheritableThreadLocal` 與虛擬執行緒的問題

```java
import java.util.concurrent.*;

public class ThreadLocalInheritance {

    private static final ThreadLocal<String> NORMAL = new ThreadLocal<>();
    private static final InheritableThreadLocal<String> INHERITABLE = new InheritableThreadLocal<>();

    public static void main(String[] args) throws Exception {
        NORMAL.set("main 的值");
        INHERITABLE.set("main 的可繼承值");

        // 直接 new Thread：可繼承的會傳下去
        Thread child = new Thread(() -> {
            System.out.println("子執行緒 NORMAL      : " + NORMAL.get());        // null
            System.out.println("子執行緒 INHERITABLE : " + INHERITABLE.get());   // main 的可繼承值
        });
        child.start();
        child.join();

        // ⚠️ 執行緒池：執行緒是「重用」的，繼承只發生在「建立時」
        System.out.println("\n--- 執行緒池中的 InheritableThreadLocal ---");
        try (var pool = Executors.newFixedThreadPool(1)) {
            pool.submit(() -> System.out.println("  第一次提交: " + INHERITABLE.get())).get();

            INHERITABLE.set("main 改過的值");
            pool.submit(() -> System.out.println("  改值後提交: " + INHERITABLE.get()
                    + "  ← 還是舊的！執行緒建立時就固定了")).get();
        }

        System.out.println("""

                → 這就是為什麼「非同步任務裡拿不到 traceId」是常見問題。
                  解法：
                    ① 手動把上下文當參數傳給任務（最可靠）
                    ② 用 TaskDecorator 包裝任務，在執行前複製上下文
                       （Spring 的 ThreadPoolTaskExecutor.setTaskDecorator）
                    ③ Java 25：用 ScopedValue（見下方）
                """);
    }
}
```

### 【Java 25】`ScopedValue`：`ThreadLocal` 的現代替代品

```java
public class ScopedValueDemo {

    public static void main(String[] args) {
        System.out.println("""
                Java 25 正式加入 ScopedValue（JEP 506），解決 ThreadLocal 的三個問題：

                  ① 不可變 —— 沒有 set()，只能在一個明確的範圍內綁定值
                  ② 自動清理 —— 離開範圍就失效，不可能忘記 remove()
                  ③ 對虛擬執行緒友善 —— 不需要每條執行緒各存一份

                寫法（Java 25）：

                    private static final ScopedValue<RequestContext> CONTEXT =
                            ScopedValue.newInstance();

                    // 綁定值並在範圍內執行
                    ScopedValue.where(CONTEXT, new RequestContext("trace-001", "u001"))
                               .run(() -> handleRequest());

                    // 範圍內的任何地方都讀得到
                    void repositoryLayer() {
                        String traceId = CONTEXT.get().traceId();
                    }

                    // 範圍外讀取 → 丟 NoSuchElementException（比 ThreadLocal 回 null 好）

                對照表：
                  ┌─────────────┬──────────────┬──────────────┐
                  │             │ ThreadLocal  │ ScopedValue  │
                  ├─────────────┼──────────────┼──────────────┤
                  │ 可變        │ ✅ set()      │ ❌ 不可變     │
                  │ 需手動清理  │ ✅ remove()   │ ❌ 自動      │
                  │ 洩漏風險    │ 高            │ 無           │
                  │ 百萬虛擬執行緒│ 記憶體壓力大  │ 幾乎無成本   │
                  │ 傳給子任務  │ 需 Inheritable│ 結構化併發自動│
                  │ 可用版本    │ Java 1.2+     │ Java 25+     │
                  └─────────────┴──────────────┴──────────────┘

                → 本課基準是 Java 21，所以練習專案仍用 ThreadLocal。
                  但升級到 25 之後，新的上下文傳遞一律該用 ScopedValue。
                """);
    }
}
```

---

## 8.14 Java 21 虛擬執行緒

### 問題：平台執行緒太貴

```
平台執行緒（Platform Thread）
  = 1:1 對應一條作業系統執行緒
  ├─ 堆疊大小固定（預設 1MB，-Xss 調整）
  ├─ 建立成本高（要進系統呼叫）
  ├─ 上下文切換由 OS 排程（要進核心態，約 1~10 微秒）
  └─ 實務上限：幾千條

虛擬執行緒（Virtual Thread，Java 21 正式）
  = 由 JVM 管理，多條虛擬執行緒共用少數「載體執行緒（carrier thread）」
  ├─ 堆疊在堆積上，按需成長（幾百 bytes 起）
  ├─ 建立成本極低（就是配置一個物件）
  ├─ 遇到阻塞時「掛載/卸載」由 JVM 處理，不進核心態
  └─ 實務上限：幾百萬條

        虛擬執行緒 V1  V2  V3  V4 ... V1000000
                    ↓   ↓   ↓   ↓
        載體執行緒   [C1] [C2] ... [C8]      ← 只有 CPU 核心數這麼多
                    ↓    ↓        ↓
        OS 執行緒    T1   T2  ...  T8
```

```java
import java.time.Duration;
import java.util.concurrent.*;
import java.util.stream.IntStream;

public class VirtualThreadsIntro {

    public static void main(String[] args) throws Exception {

        // ===== 建立方式 =====
        System.out.println("--- 三種建立方式 ---");

        Thread v1 = Thread.startVirtualThread(() ->
                System.out.println("  ① startVirtualThread: " + Thread.currentThread()));
        v1.join();

        Thread v2 = Thread.ofVirtual().name("my-virtual").start(() ->
                System.out.println("  ② ofVirtual().start: " + Thread.currentThread()));
        v2.join();

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            executor.submit(() ->
                    System.out.println("  ③ newVirtualThreadPerTaskExecutor: "
                            + Thread.currentThread()));
        }

        // ===== 屬性 =====
        Thread vt = Thread.ofVirtual().unstarted(() -> { });
        System.out.println("\n--- 虛擬執行緒的屬性 ---");
        System.out.println("  isVirtual : " + vt.isVirtual());
        System.out.println("  isDaemon  : " + vt.isDaemon() + "  ⚠️ 永遠是 daemon，不能改");
        System.out.println("  priority  : " + vt.getPriority() + "  ⚠️ setPriority 是空操作");

        // ===== 效能對比：10000 個 IO 任務 =====
        System.out.println("\n=== 10,000 個「等 100ms」的任務 ===");
        System.out.println("平台執行緒池 (200 條): " + benchPlatform(200) + " ms");
        System.out.println("虛擬執行緒          : " + benchVirtual() + " ms");

        // ===== 極限測試：一百萬條 =====
        System.out.println("\n=== 建立 1,000,000 條虛擬執行緒 ===");
        long start = System.currentTimeMillis();
        var latch = new CountDownLatch(1_000_000);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 1_000_000; i++) {
                executor.submit(() -> {
                    try {
                        Thread.sleep(Duration.ofMillis(100));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    latch.countDown();
                });
            }
            latch.await();
        }
        System.out.printf("完成，耗時 %d ms%n", System.currentTimeMillis() - start);
        System.out.println("→ 用平台執行緒做同一件事會直接 OOM（1,000,000 × 1MB = 1TB 堆疊）");
    }

    static long benchPlatform(int poolSize) throws Exception {
        long start = System.currentTimeMillis();
        try (var pool = Executors.newFixedThreadPool(poolSize)) {
            for (int i = 0; i < 10_000; i++) {
                pool.submit(() -> {
                    try { Thread.sleep(100); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            }
        }
        return System.currentTimeMillis() - start;
    }

    static long benchVirtual() throws Exception {
        long start = System.currentTimeMillis();
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 10_000; i++) {
                pool.submit(() -> {
                    try { Thread.sleep(100); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            }
        }
        return System.currentTimeMillis() - start;
    }
}
```

典型輸出：

```
--- 三種建立方式 ---
  ① startVirtualThread: VirtualThread[#23]/runnable@ForkJoinPool-1-worker-1
  ② ofVirtual().start: VirtualThread[#25,my-virtual]/runnable@ForkJoinPool-1-worker-2
  ③ newVirtualThreadPerTaskExecutor: VirtualThread[#27]/runnable@ForkJoinPool-1-worker-1

--- 虛擬執行緒的屬性 ---
  isVirtual : true
  isDaemon  : true  ⚠️ 永遠是 daemon，不能改
  priority  : 5  ⚠️ setPriority 是空操作

=== 10,000 個「等 100ms」的任務 ===
平台執行緒池 (200 條): 5120 ms
虛擬執行緒          : 165 ms          ← 快 30 倍

=== 建立 1,000,000 條虛擬執行緒 ===
完成，耗時 2450 ms
→ 用平台執行緒做同一件事會直接 OOM（1,000,000 × 1MB = 1TB 堆疊）
```

### 五個必知的注意事項

```java
import java.util.concurrent.*;
import java.util.stream.IntStream;

public class VirtualThreadCaveats {

    public static void main(String[] args) throws Exception {

        // ===== ① 不要「池化」虛擬執行緒 =====
        System.out.println("""
                ① ❌ 不要池化虛擬執行緒

                   // 錯誤：池化的意義是「重用昂貴的資源」，虛擬執行緒很便宜
                   var pool = Executors.newFixedThreadPool(100, Thread.ofVirtual().factory());

                   // 正確：每個任務一條
                   var executor = Executors.newVirtualThreadPerTaskExecutor();

                   ⚠️ 但如果目的是「限制併發數」（例如下游 DB 只能承受 20 個連線），
                      不要用池，要用 Semaphore：
                """);

        var semaphore = new Semaphore(20);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 100; i++) {
                final int id = i;
                executor.submit(() -> {
                    semaphore.acquire();                 // 最多 20 個同時進來
                    try {
                        Thread.sleep(50);                // 模擬 DB 查詢
                        return id;
                    } finally {
                        semaphore.release();
                    }
                });
            }
        }
        System.out.println("  ✅ 用 Semaphore 限制併發，100 個任務但同時只有 20 個在跑\n");

        // ===== ② CPU 密集型不會變快 =====
        System.out.println("② CPU 密集型：虛擬執行緒沒有幫助");
        System.out.println("   平台執行緒: " + cpuBench(false) + " ms");
        System.out.println("   虛擬執行緒: " + cpuBench(true) + " ms");
        System.out.println("   → 差不多，因為瓶頸是 CPU 而不是等待\n");

        // ===== ③ 釘住（pinning）=====
        System.out.println("""
                ③ ⚠️ 釘住（Pinning）

                   在 Java 21~23，如果虛擬執行緒在 synchronized 區塊內阻塞，
                   它會「釘住」載體執行緒 —— 載體無法去跑其他虛擬執行緒。
                   大量發生時，等於退化成「只有 CPU 核心數條」的併發度。

                     synchronized (lock) {
                         Thread.sleep(1000);        // 💥 釘住載體執行緒 1 秒
                     }

                   ✅ Java 21~23 的解法：熱路徑改用 ReentrantLock（不會釘住）
                   ✅ Java 24+（JEP 491）：已修正，synchronized 不再釘住

                   仍會釘住的情況（所有版本）：
                     - 呼叫 native 方法 / FFM API
                     - 類別初始化中阻塞

                   偵測方式：
                     -Djdk.tracePinnedThreads=full     （Java 21~23）
                     或用 JFR 的 jdk.VirtualThreadPinned 事件
                """);

        // ===== ④ ThreadLocal 的記憶體壓力 =====
        System.out.println("""
                ④ ThreadLocal 仍然可用，但要注意成本

                   一百萬條虛擬執行緒 × 每條一份 ThreadLocal 值
                   = 一百萬份物件。如果值很大（如一個 SimpleDateFormat）就是災難。

                   ✅ Java 25：改用 ScopedValue（8.13 節）
                   ✅ Java 21~24：確保 ThreadLocal 的值很小，且一定 remove()
                """);

        // ===== ⑤ 載體執行緒池的設定 =====
        System.out.println("""
                ⑤ 載體執行緒（carrier thread）的數量

                   預設 = CPU 核心數。可以調整：
                     -Djdk.virtualThreadScheduler.parallelism=16
                     -Djdk.virtualThreadScheduler.maxPoolSize=256

                   通常「不需要調」。要調的情況：
                     - 有大量無法避免的釘住 → 增加 parallelism 補償
                     - 觀察到載體執行緒不足（JFR 可以看到）
                """);

        System.out.printf("   當前載體執行緒平行度: %s%n",
                System.getProperty("jdk.virtualThreadScheduler.parallelism",
                        String.valueOf(Runtime.getRuntime().availableProcessors())));
    }

    static long cpuBench(boolean virtual) throws Exception {
        int cores = Runtime.getRuntime().availableProcessors();
        long start = System.currentTimeMillis();
        ExecutorService pool = virtual
                ? Executors.newVirtualThreadPerTaskExecutor()
                : Executors.newFixedThreadPool(cores);
        try (pool) {
            for (int i = 0; i < 100; i++) {
                pool.submit(() -> {
                    double sum = 0;
                    for (int j = 1; j <= 3_000_000; j++) sum += Math.sqrt(j);
                    return sum;
                });
            }
        }
        return System.currentTimeMillis() - start;
    }
}
```

### 什麼時候用虛擬執行緒

| 情況 | 用虛擬執行緒？ | 理由 |
|---|---|---|
| Web 服務處理 HTTP 請求（大量 IO） | ✅ **非常適合** | 每個請求一條虛擬執行緒，程式碼是簡單的同步風格 |
| 呼叫多個外部 API 並匯總 | ✅ | 取代複雜的 `CompletableFuture` 鏈 |
| 批次匯入（大量 DB 寫入） | ✅ 搭配 `Semaphore` | 限制對 DB 的併發 |
| 影像處理、加密、壓縮 | ❌ | CPU 密集，用平台執行緒池 |
| 需要 `ThreadLocal` 存大物件 | ⚠️ 小心 | 百萬條 × 大物件 = OOM |
| 大量 `synchronized` 阻塞（Java 21~23） | ⚠️ 改用 `ReentrantLock` | 釘住問題 |
| 需要控制執行緒優先度 | ❌ | `setPriority` 無效 |

> **最重要的觀念轉變**：虛擬執行緒讓你**回到簡單的同步阻塞寫法**。
>
> ```java
> // 過去為了效能，被迫寫成這樣（回呼地獄 / CompletableFuture 鏈）
> return fetchUser(id)
>         .thenCompose(user -> fetchOrders(user.id()))
>         .thenCombine(fetchRecommendations(id), (orders, recs) -> merge(orders, recs))
>         .orTimeout(3, SECONDS)
>         .exceptionally(this::fallback);
>
> // 有虛擬執行緒後，可以寫回這樣（在虛擬執行緒上執行）
> User user = fetchUser(id);              // 阻塞，但很便宜
> List<Order> orders = fetchOrders(user.id());
> List<Rec> recs = fetchRecommendations(id);
> return merge(orders, recs);
> ```
>
> **可讀性、可除錯性（堆疊完整）、例外處理都好得多。**
> 這是 Java 21 最大的實務價值。

---

## 8.15 結構化併發（預覽功能）

```java
public class StructuredConcurrencyPreview {

    public static void main(String[] args) {
        System.out.println("""
                === 問題：非結構化併發很容易寫錯 ===

                    // 呼叫兩個服務，都成功才回傳
                    Future<User> userF = executor.submit(() -> fetchUser(id));
                    Future<Orders> ordersF = executor.submit(() -> fetchOrders(id));
                    User user = userF.get();          // 如果這裡丟例外…
                    Orders orders = ordersF.get();    // ordersF 就洩漏了（沒人取消它）

                  三個問題：
                    ① 一個失敗，另一個仍在跑（浪費資源、可能造成副作用）
                    ② 呼叫者被取消時，兩個子任務不會跟著取消
                    ③ 例外的堆疊看不出「是誰的子任務」

                === 解法：StructuredTaskScope（JEP 505，Java 25 仍是預覽）===

                  核心概念：把「一組相關的併發任務」變成程式碼結構上的一個區塊。
                  任務的生命週期不會超出這個區塊 —— 就像 try-with-resources
                  保證資源被關閉一樣。

                  Java 21 的寫法（--enable-preview）：

                    try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
                        Supplier<User> user = scope.fork(() -> fetchUser(id));
                        Supplier<Orders> orders = scope.fork(() -> fetchOrders(id));

                        scope.join();                    // 等全部完成
                        scope.throwIfFailed();           // 有任一失敗就丟例外

                        return new Result(user.get(), orders.get());
                    }
                    // 離開區塊時，所有子任務保證已結束（成功、失敗、或被取消）

                  ⚠️ 這個 API 在 Java 21 / 22 / 23 / 24 / 25 之間「改過好幾次」。
                     Java 25（JEP 505）改成：
                       StructuredTaskScope.open(Joiner.allSuccessfulOrThrow())

                     所以：正式專案先不要用它，等它脫離預覽。
                     但要知道「這是未來的方向」——
                     虛擬執行緒 + 結構化併發是 Java 併發的終局設計。

                === 用虛擬執行緒 + 現有 API 達到類似效果 ===
                """);

        System.out.println("  見下方 fetchInParallel 的實作");
    }
}
```

```java
import java.util.List;
import java.util.concurrent.*;

/** 在等 StructuredTaskScope 正式化之前，用虛擬執行緒 + invokeAll 達到類似效果 */
public class ParallelFetch {

    record User(String id, String name) { }
    record Order(String id, long amount) { }
    record Dashboard(User user, List<Order> orders, int unreadCount) { }

    /**
     * ✅ 用 invokeAll + 虛擬執行緒：
     *   - try-with-resources 保證執行緒池關閉
     *   - invokeAll 等全部完成
     *   - 任一失敗時，其餘的 Future 會在 close() 時被取消
     */
    static Dashboard loadDashboard(String userId) throws Exception {
        try (var scope = Executors.newVirtualThreadPerTaskExecutor()) {

            Future<User> userF = scope.submit(() -> fetchUser(userId));
            Future<List<Order>> ordersF = scope.submit(() -> fetchOrders(userId));
            Future<Integer> unreadF = scope.submit(() -> fetchUnreadCount(userId));

            // get() 會在任一失敗時丟 ExecutionException
            return new Dashboard(userF.get(), ordersF.get(), unreadF.get());
        }
    }

    /** 失敗時要快速失敗並取消其他任務 */
    static Dashboard loadDashboardFailFast(String userId) throws Exception {
        try (var scope = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Callable<Object>> tasks = List.of(
                    () -> fetchUser(userId),
                    () -> fetchOrders(userId),
                    () -> fetchUnreadCount(userId));

            List<Future<Object>> futures = scope.invokeAll(tasks);

            // 檢查是否有失敗
            for (Future<Object> f : futures) {
                if (f.isCancelled()) {
                    throw new IllegalStateException("子任務被取消");
                }
                f.get();       // 有例外會在這裡丟出
            }

            @SuppressWarnings("unchecked")
            Dashboard result = new Dashboard(
                    (User) futures.get(0).get(),
                    (List<Order>) futures.get(1).get(),
                    (Integer) futures.get(2).get());
            return result;
        }
    }

    public static void main(String[] args) throws Exception {
        long start = System.currentTimeMillis();
        Dashboard dashboard = loadDashboard("u001");
        System.out.printf("載入完成，耗時 %d ms（三個查詢並行）%n",
                System.currentTimeMillis() - start);
        System.out.println(dashboard);

        System.out.println("\n--- 其中一個失敗 ---");
        try {
            loadDashboard("fail");
        } catch (ExecutionException e) {
            System.out.println("捕捉到: " + e.getCause().getMessage());
        }
    }

    static User fetchUser(String id) throws InterruptedException {
        Thread.sleep(150);
        if ("fail".equals(id)) throw new IllegalStateException("使用者服務 503");
        return new User(id, "小明");
    }

    static List<Order> fetchOrders(String id) throws InterruptedException {
        Thread.sleep(200);
        return List.of(new Order("ORD-1", 29900), new Order("ORD-2", 8900));
    }

    static Integer fetchUnreadCount(String id) throws InterruptedException {
        Thread.sleep(100);
        return 5;
    }
}
```

輸出：

```
載入完成，耗時 210 ms（三個查詢並行）
Dashboard[user=User[id=u001, name=小明], orders=[Order[id=ORD-1, amount=29900], Order[id=ORD-2, amount=8900]], unreadCount=5]

--- 其中一個失敗 ---
捕捉到: 使用者服務 503
```

---

## 8.16 併發集合選型（第 05 章的延伸）

```java
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.LongAdder;

public class ConcurrentCollectionChoice {

    public static void main(String[] args) throws Exception {

        // ===== ConcurrentHashMap 的原子操作 =====
        System.out.println("--- ConcurrentHashMap 的原子方法 ---");
        var map = new ConcurrentHashMap<String, Integer>();

        // ❌ 這三行不是原子的：兩條執行緒可能都看到 null
        // if (!map.containsKey("k")) { map.put("k", compute()); }

        // ✅ 原子方法
        map.putIfAbsent("a", 1);
        map.computeIfAbsent("b", k -> 2);
        map.merge("a", 10, Integer::sum);
        map.compute("c", (k, v) -> v == null ? 1 : v + 1);
        System.out.println("  " + new TreeMap<>(map));           // {a=11, b=2, c=1}

        // ⚠️ computeIfAbsent 的 mapping function 不可以再操作同一個 map（會死鎖）
        System.out.println("""
                  ⚠️ computeIfAbsent 的函式內不要再存取同一個 map：
                     map.computeIfAbsent("x", k -> map.get("y"));   // 可能死鎖或 IllegalStateException
                """);

        // ===== 計數器：ConcurrentHashMap + LongAdder =====
        System.out.println("--- 高併發計數器 ---");
        var counters = new ConcurrentHashMap<String, LongAdder>();
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 100_000; i++) {
                final String key = "api-" + (i % 5);
                pool.submit(() -> counters.computeIfAbsent(key, k -> new LongAdder()).increment());
            }
        }
        new TreeMap<>(counters).forEach((k, v) -> System.out.printf("  %-8s %,d%n", k, v.sum()));

        // ===== CopyOnWriteArrayList：讀多寫極少 =====
        System.out.println("\n--- CopyOnWriteArrayList ---");
        List<String> listeners = new CopyOnWriteArrayList<>();
        listeners.add("listener-1");
        listeners.add("listener-2");

        // 迭代時修改不會 ConcurrentModificationException（迭代的是快照）
        for (String l : listeners) {
            listeners.add("added-during-iteration");     // 不會爆
            break;
        }
        System.out.println("  size: " + listeners.size());
        System.out.println("""
                  ⚠️ 每次寫入都「複製整個陣列」→ 寫入 O(n)。
                     1000 個元素、每秒寫 100 次 = 每秒複製 10 萬個元素。
                     只適合「幾乎不寫」的場景（監聽器清單、設定快取）。
                """);

        // ===== 併發集合對照表 =====
        System.out.println("""
                ┌────────────────────────┬───────────────────────────┬────────────────────────┐
                │ 需求                   │ 用什麼                     │ 注意                    │
                ├────────────────────────┼───────────────────────────┼────────────────────────┤
                │ 一般併發 Map           │ ConcurrentHashMap          │ 原子性只在單一方法內      │
                │ 需排序的併發 Map       │ ConcurrentSkipListMap      │ O(log n)                │
                │ 併發 Set               │ ConcurrentHashMap.newKeySet│ 沒有 ConcurrentHashSet   │
                │ 讀多寫極少的 List      │ CopyOnWriteArrayList       │ 寫入 O(n)               │
                │ 生產者-消費者          │ ArrayBlockingQueue(n)      │ ★ 一定要有界             │
                │ 高吞吐無界佇列         │ ConcurrentLinkedQueue      │ size() 是 O(n)!         │
                │ 依優先度的併發佇列     │ PriorityBlockingQueue      │ 無界                    │
                │ 延遲執行               │ DelayQueue                 │ 元素要實作 Delayed       │
                │ 計數器                 │ LongAdder                  │ sum() 非精確瞬時值       │
                │ 不變的共用資料         │ Map.copyOf / List.copyOf   │ ★ 最快，零同步成本       │
                └────────────────────────┴───────────────────────────┴────────────────────────┘

                ⚠️ ConcurrentLinkedQueue.size() 要走訪整個佇列（O(n)）！
                   不要在迴圈或監控裡頻繁呼叫。要知道長度就自己維護一個 LongAdder。
                """);
    }
}
```

### 同步工具類

```java
import java.util.concurrent.*;

public class SynchronizerTools {

    public static void main(String[] args) throws Exception {

        // ===== CountDownLatch：等 N 件事完成（一次性）=====
        System.out.println("--- CountDownLatch：等所有初始化完成 ---");
        var latch = new CountDownLatch(3);
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (String svc : new String[]{"資料庫", "快取", "訊息佇列"}) {
                pool.submit(() -> {
                    Thread.sleep(100 + (long) (Math.random() * 200));
                    System.out.println("  " + svc + " 就緒");
                    latch.countDown();
                    return null;
                });
            }
            latch.await();          // 等三個都 countDown
            System.out.println("  ✅ 全部就緒，開始接收流量");
        }

        // ===== CyclicBarrier：多階段同步（可重複使用）=====
        System.out.println("\n--- CyclicBarrier：分階段處理 ---");
        int workers = 3;
        var barrier = new CyclicBarrier(workers,
                () -> System.out.println("  === 所有人完成本階段，進入下一階段 ==="));

        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int w = 0; w < workers; w++) {
                final int id = w;
                pool.submit(() -> {
                    for (int phase = 1; phase <= 2; phase++) {
                        Thread.sleep(50 + (long) (Math.random() * 100));
                        System.out.println("  worker-" + id + " 完成階段 " + phase);
                        barrier.await();
                    }
                    return null;
                });
            }
        }

        // ===== Semaphore：限制併發數 =====
        System.out.println("\n--- Semaphore：限制對下游的併發 ---");
        var semaphore = new Semaphore(3);
        var concurrent = new java.util.concurrent.atomic.AtomicInteger();
        var maxConcurrent = new java.util.concurrent.atomic.AtomicInteger();

        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 20; i++) {
                pool.submit(() -> {
                    semaphore.acquire();
                    try {
                        int now = concurrent.incrementAndGet();
                        maxConcurrent.updateAndGet(max -> Math.max(max, now));
                        Thread.sleep(50);
                        concurrent.decrementAndGet();
                    } finally {
                        semaphore.release();       // ⚠️ 一定要在 finally
                    }
                    return null;
                });
            }
        }
        System.out.println("  20 個任務，觀察到的最大併發: " + maxConcurrent.get() + "（上限 3）");

        // ===== Exchanger / Phaser（少用，知道有就好）=====
        System.out.println("""

                其他同步工具：
                  Exchanger  → 兩條執行緒交換資料（很少用）
                  Phaser     → CyclicBarrier 的進階版，參與者數量可動態變化

                實務上 90% 的需求：
                  ① 等一批任務完成      → CountDownLatch，或直接用 ExecutorService.invokeAll
                  ② 限制併發            → Semaphore
                  ③ 生產者-消費者       → BlockingQueue
                  ④ 分階段同步          → CyclicBarrier（不常見）
                """);
    }
}
```

---

## 8.17 併發問題的診斷

```java
public class ConcurrencyDiagnostics {

    public static void main(String[] args) {
        System.out.println("""
                === 症狀 → 工具 → 該看什麼 ===

                【症狀 1】服務沒回應，但 CPU 很低
                  → jcmd <pid> Thread.print
                  看：
                    ① "Found N Java-level deadlock"  → 死鎖（8.8 節）
                    ② 大量 BLOCKED 在同一個 monitor  → 鎖競爭
                    ③ 大量 WAITING on ...BlockingQueue → 池空閒，是上游沒送任務
                    ④ 大量 TIMED_WAITING 在 socketRead → 下游 IO 慢

                【症狀 2】CPU 100% 但沒進度
                  → top -H -p <pid>          找出吃 CPU 的「執行緒」
                  → printf '%x\\n' <tid>      把 tid 轉成 16 進位
                  → jcmd <pid> Thread.print | grep -A 20 '"nid=0x<hex>'
                  看：
                    ① 忙迴圈（while(true) 沒有 sleep）
                    ② CAS 自旋過度（大量 AtomicXxx 競爭 → 改 LongAdder）
                    ③ GC 執行緒吃滿 → 其實是記憶體問題（第 09 章）

                【症狀 3】數字不對但沒有例外
                  → 這是競態條件。工具幫不了你，要靠 code review：
                    ① 找所有「共用的可變狀態」
                    ② 檢查每一處讀寫是否都在同一把鎖內
                    ③ 檢查是否有「檢查後再動作」（check-then-act）沒被原子化

                【症狀 4】服務關不掉 / Kubernetes 只能 SIGKILL
                  → 檢查是否吞掉了 InterruptedException（8.3 節）
                  → jcmd <pid> Thread.print 看還有哪些非 daemon 執行緒活著

                【症狀 5】任務莫名消失
                  → 檢查拒絕策略是不是 DiscardPolicy（8.11 節）
                  → 檢查 submit() 回傳的 Future 有沒有人檢查例外
                     ⚠️ pool.submit(runnable) 的例外會被「吞進 Future」，
                        沒有人呼叫 get() 就永遠看不到！

                === submit vs execute 的重要差異 ===
                """);

        demoSubmitSwallowsException();
    }

    static void demoSubmitSwallowsException() {
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(1)) {

            System.out.println("--- execute()：例外會傳到 UncaughtExceptionHandler ---");
            var pool2 = new java.util.concurrent.ThreadPoolExecutor(
                    1, 1, 0L, java.util.concurrent.TimeUnit.SECONDS,
                    new java.util.concurrent.ArrayBlockingQueue<>(10),
                    r -> {
                        Thread t = new Thread(r, "with-handler");
                        t.setUncaughtExceptionHandler((thread, e) ->
                                System.out.println("  ✅ 捕捉到: " + e.getMessage()));
                        return t;
                    });
            pool2.execute(() -> { throw new IllegalStateException("execute 的例外"); });
            sleep(200);
            pool2.shutdown();

            System.out.println("\n--- submit()：例外被「藏進 Future」 ---");
            var future = pool.submit(() -> {
                throw new IllegalStateException("submit 的例外");
            });
            sleep(200);
            System.out.println("  ❌ 什麼都沒印出來 —— 例外被吞進 Future 了");
            System.out.println("  isDone: " + future.isDone());

            try {
                future.get();
            } catch (Exception e) {
                System.out.println("  只有呼叫 get() 才看得到: " + e.getCause().getMessage());
            }

            System.out.println("""

                    ✅ 三個防護：
                      ① 用 execute() 提交「不需要結果」的任務，搭配 UncaughtExceptionHandler
                      ② 用 submit() 時「一定要」處理回傳的 Future
                      ③ 在任務內部自己 try-catch，不要讓例外逃出去
                         （尤其是 scheduleAtFixedRate —— 任務一丟例外就「永久停止排程」！）
                    """);

            demoScheduledTaskDies();
        }
    }

    /** ⚠️ 這個坑害過很多人：排程任務丟例外就再也不執行了 */
    static void demoScheduledTaskDies() {
        System.out.println("--- scheduleAtFixedRate 的致命陷阱 ---");
        var scheduler = java.util.concurrent.Executors.newScheduledThreadPool(1);
        var count = new java.util.concurrent.atomic.AtomicInteger();

        // ❌ 沒有 try-catch
        scheduler.scheduleAtFixedRate(() -> {
            int n = count.incrementAndGet();
            System.out.println("  執行第 " + n + " 次");
            if (n == 3) {
                throw new IllegalStateException("第 3 次失敗");
            }
        }, 0, 50, java.util.concurrent.TimeUnit.MILLISECONDS);

        sleep(500);
        System.out.println("  → 500ms 後只執行了 " + count.get() + " 次，排程已「永久停止」");
        scheduler.shutdownNow();

        System.out.println("\n  ✅ 正確寫法：任務內部包住所有例外");
        var scheduler2 = java.util.concurrent.Executors.newScheduledThreadPool(1);
        var count2 = new java.util.concurrent.atomic.AtomicInteger();
        scheduler2.scheduleAtFixedRate(() -> {
            try {
                int n = count2.incrementAndGet();
                if (n == 3) throw new IllegalStateException("第 3 次失敗");
                System.out.println("  執行第 " + n + " 次");
            } catch (RuntimeException e) {
                System.out.println("  ⚠️ 第 " + count2.get() + " 次失敗但排程繼續: " + e.getMessage());
            }
        }, 0, 50, java.util.concurrent.TimeUnit.MILLISECONDS);

        sleep(400);
        System.out.println("  → 400ms 後執行了 " + count2.get() + " 次，排程存活");
        scheduler2.shutdownNow();
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

輸出（節錄）：

```
--- scheduleAtFixedRate 的致命陷阱 ---
  執行第 1 次
  執行第 2 次
  執行第 3 次
  → 500ms 後只執行了 3 次，排程已「永久停止」

  ✅ 正確寫法：任務內部包住所有例外
  執行第 1 次
  執行第 2 次
  ⚠️ 第 3 次失敗但排程繼續: 第 3 次失敗
  執行第 4 次
  ...
  → 400ms 後執行了 8 次，排程存活
```

> **`scheduleAtFixedRate` 的例外會讓排程永久停止**，這是實務上非常常見且難察覺的問題：
> 「為什麼我的定時清理任務三個月前就不跑了？」——因為某天它丟了一次 NPE。
>
> Spring 的 `@Scheduled` 有一樣的行為。**排程任務的第一行就該是 `try {`。**

---

## 8.18 練習專案：併發匯入待辦事項

延續第 07 章的專案，加入「從多個來源併發匯入」的功能。

```
demo/src/main/java/com/example/todo/
├── ...（第 07 章）
├── importer/
│   ├── TodoSource.java          ← 新增：匯入來源介面
│   ├── FileSource.java          ← 新增
│   ├── HttpSource.java          ← 新增（模擬）
│   ├── ImportResult.java        ← 新增
│   └── ConcurrentTodoImporter.java  ← 新增：核心
└── repository/
    └── JsonFileTodoRepository.java  ← 改：加上執行緒安全
```

### `TodoSource.java`

```java
package com.example.todo.importer;

import java.util.List;

/**
 * 匯入來源。可能是檔案、HTTP API、資料庫…
 * 實作可以阻塞（會在虛擬執行緒上執行）。
 */
public interface TodoSource {

    /** 來源名稱，用於 log 與錯誤報告 */
    String name();

    /**
     * 讀取原始資料列。
     * @throws Exception 允許丟 checked 例外（Callable 語意）
     */
    List<String[]> read() throws Exception;
}
```

### `ImportResult.java`

```java
package com.example.todo.importer;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * 匯入結果。不可變（第 02 章 2.9 節），可以安全地在執行緒間傳遞。
 */
public record ImportResult(
        int totalRows,
        int imported,
        int failed,
        Duration elapsed,
        Map<String, SourceResult> bySource,
        List<RowError> errors) {

    public ImportResult {
        bySource = Map.copyOf(bySource);
        errors = List.copyOf(errors);
    }

    public record SourceResult(String source, int rows, int imported, int failed,
                               Duration elapsed, String errorMessage) {

        public boolean sourceFailed() { return errorMessage != null; }
    }

    public record RowError(String source, int rowIndex, String rawRow, String reason) { }

    public double successRate() {
        return totalRows == 0 ? 0 : imported * 100.0 / totalRows;
    }

    public String render() {
        StringBuilder sb = new StringBuilder();
        sb.append("=== 匯入報告 ===\n");
        sb.append("總列數   : %,d\n".formatted(totalRows));
        sb.append("成功     : %,d (%.1f%%)\n".formatted(imported, successRate()));
        sb.append("失敗     : %,d\n".formatted(failed));
        sb.append("總耗時   : %d ms\n".formatted(elapsed.toMillis()));

        sb.append("\n--- 各來源 ---\n");
        new java.util.TreeMap<>(bySource).forEach((name, r) -> {
            if (r.sourceFailed()) {
                sb.append("  ❌ %-20s 來源失敗: %s\n".formatted(name, r.errorMessage()));
            } else {
                sb.append("  ✅ %-20s %,4d 列，成功 %,4d，失敗 %,3d，%,5d ms\n"
                        .formatted(name, r.rows(), r.imported(), r.failed(), r.elapsed().toMillis()));
            }
        });

        if (!errors.isEmpty()) {
            sb.append("\n--- 失敗的列（前 10 筆）---\n");
            errors.stream().limit(10).forEach(e ->
                    sb.append("  [%s:%d] %s → %s\n".formatted(
                            e.source(), e.rowIndex(), String.join(",", e.rawRow()), e.reason())));
            if (errors.size() > 10) {
                sb.append("  …還有 %d 筆\n".formatted(errors.size() - 10));
            }
        }
        return sb.toString();
    }
}
```

### `ConcurrentTodoImporter.java`：核心

```java
package com.example.todo.importer;

import com.example.todo.exception.TodoException;
import com.example.todo.model.Priority;
import com.example.todo.model.Todo;
import com.example.todo.repository.TodoRepository;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.LongAdder;

/**
 * 併發匯入器。
 *
 * 設計要點：
 *   ① 用虛擬執行緒 —— 來源是 IO 密集（讀檔、HTTP），數量可能很多
 *   ② 用 Semaphore 限制「同時對外連線數」—— 不要把下游打爆
 *   ③ 一個來源失敗不影響其他來源（第 03 章 3.8 節模板方法的原則）
 *   ④ 一列失敗不影響其他列，並記錄原因
 *   ⑤ 所有解析在併發階段完成，「寫入 repository」集中在單執行緒 —— 避免併發寫檔
 */
public class ConcurrentTodoImporter {

    private final TodoRepository repository;
    private final Clock clock;
    private final int maxConcurrentSources;
    private final Duration perSourceTimeout;

    public ConcurrentTodoImporter(TodoRepository repository, Clock clock,
                                  int maxConcurrentSources, Duration perSourceTimeout) {
        this.repository = Objects.requireNonNull(repository, "repository 不可為 null");
        this.clock = Objects.requireNonNull(clock, "clock 不可為 null");
        if (maxConcurrentSources < 1) {
            throw new IllegalArgumentException(
                    "maxConcurrentSources 必須 >= 1，收到: " + maxConcurrentSources);
        }
        this.maxConcurrentSources = maxConcurrentSources;
        this.perSourceTimeout = Objects.requireNonNull(perSourceTimeout, "timeout 不可為 null");
    }

    /** 併發從所有來源讀取並解析，最後單執行緒寫入 */
    public ImportResult importFrom(List<TodoSource> sources) {
        Objects.requireNonNull(sources, "sources 不可為 null");
        long startNanos = System.nanoTime();

        // 限制同時對外的來源數（避免把下游 API 打爆）
        Semaphore gate = new Semaphore(maxConcurrentSources);

        // 併發階段的共用狀態：全部用執行緒安全的結構
        Map<String, ImportResult.SourceResult> bySource = new ConcurrentHashMap<>();
        List<ImportResult.RowError> errors = Collections.synchronizedList(new ArrayList<>());
        LongAdder totalRows = new LongAdder();

        // 解析出來的 Todo 暫存在併發佇列，之後單執行緒寫入
        ConcurrentLinkedQueue<ParsedTodo> parsed = new ConcurrentLinkedQueue<>();
        // ConcurrentLinkedQueue.size() 是 O(n)，所以自己維護計數（8.16 節）
        AtomicInteger parsedCount = new AtomicInteger();

        // ===== 階段 1：併發讀取 + 解析 =====
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<?>> futures = new ArrayList<>(sources.size());

            for (TodoSource source : sources) {
                futures.add(executor.submit(() -> {
                    processSource(source, gate, bySource, errors, totalRows, parsed, parsedCount);
                    return null;
                }));
            }

            // ✅ 一定要檢查每個 Future，否則例外會被吞掉（8.17 節）
            for (Future<?> f : futures) {
                try {
                    f.get();
                } catch (ExecutionException e) {
                    // processSource 內部已經處理了所有預期的失敗，
                    // 走到這裡代表是預期外的 bug —— 要讓它顯眼
                    System.err.println("[ERROR] 匯入任務發生預期外的例外");
                    e.getCause().printStackTrace();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new TodoException(
                            com.example.todo.exception.ErrorCode.INTERNAL_ERROR, "匯入被中斷", e);
                }
            }
        }

        // ===== 階段 2：單執行緒批次寫入 =====
        // 為什麼不併發寫？因為 repository 背後是「一個檔案」，
        // 併發寫會互相覆蓋。而且批次寫一次比寫 N 次快得多（第 07 章 7.18 節）
        List<Todo> toSave = new ArrayList<>(parsedCount.get());
        for (ParsedTodo p : parsed) {
            Todo todo = new Todo(repository.nextId(), p.title(), p.priority(), clock.instant());
            for (String tag : p.tags()) {
                try {
                    todo.addTag(tag);
                } catch (RuntimeException e) {
                    // 標籤超過上限之類的問題不該讓整筆失敗
                    errors.add(new ImportResult.RowError(
                            p.source(), p.rowIndex(), p.title(), "標籤忽略: " + e.getMessage()));
                }
            }
            toSave.add(todo);
        }

        if (repository instanceof com.example.todo.repository.JsonFileTodoRepository jsonRepo) {
            jsonRepo.saveAll(toSave);              // 只寫一次檔
        } else {
            toSave.forEach(repository::save);
        }

        return new ImportResult(
                (int) totalRows.sum(),
                toSave.size(),
                errors.size(),
                Duration.ofNanos(System.nanoTime() - startNanos),
                bySource,
                errors);
    }

    /** 處理單一來源。所有預期的失敗都在這裡被吸收，不往外拋 */
    private void processSource(TodoSource source,
                               Semaphore gate,
                               Map<String, ImportResult.SourceResult> bySource,
                               List<ImportResult.RowError> errors,
                               LongAdder totalRows,
                               ConcurrentLinkedQueue<ParsedTodo> parsed,
                               AtomicInteger parsedCount) {
        long sourceStart = System.nanoTime();
        int rows = 0, imported = 0, failed = 0;

        boolean acquired = false;
        try {
            // 限制併發 + 超時
            acquired = gate.tryAcquire(perSourceTimeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!acquired) {
                bySource.put(source.name(), new ImportResult.SourceResult(
                        source.name(), 0, 0, 0,
                        Duration.ofNanos(System.nanoTime() - sourceStart),
                        "等待併發配額超時"));
                return;
            }

            List<String[]> rawRows = source.read();
            rows = rawRows.size();
            totalRows.add(rows);

            for (int i = 0; i < rawRows.size(); i++) {
                String[] row = rawRows.get(i);
                try {
                    parsed.add(parseRow(source.name(), i, row));
                    parsedCount.incrementAndGet();
                    imported++;
                } catch (RuntimeException e) {
                    failed++;
                    errors.add(new ImportResult.RowError(
                            source.name(), i, String.join(",", row), e.getMessage()));
                }
            }

            bySource.put(source.name(), new ImportResult.SourceResult(
                    source.name(), rows, imported, failed,
                    Duration.ofNanos(System.nanoTime() - sourceStart), null));

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();       // 恢復旗標（第 04 章反模式 6）
            bySource.put(source.name(), new ImportResult.SourceResult(
                    source.name(), rows, imported, failed,
                    Duration.ofNanos(System.nanoTime() - sourceStart), "被中斷"));

        } catch (Exception e) {
            // ✅ 來源整體失敗（檔案不存在、HTTP 500…）：記錄下來，不影響其他來源
            bySource.put(source.name(), new ImportResult.SourceResult(
                    source.name(), rows, imported, failed,
                    Duration.ofNanos(System.nanoTime() - sourceStart),
                    e.getClass().getSimpleName() + ": " + e.getMessage()));

        } finally {
            if (acquired) gate.release();             // ⚠️ 一定要在 finally
        }
    }

    /** 解析一列：`標題,優先度,標籤1|標籤2` */
    private ParsedTodo parseRow(String source, int index, String[] row) {
        if (row.length < 1 || row[0] == null || row[0].isBlank()) {
            throw new IllegalArgumentException("標題不可為空");
        }
        String title = row[0].strip();

        Priority priority = row.length >= 2 && !row[1].isBlank()
                ? Priority.parse(row[1])              // 無效值會丟 InvalidTodoException
                : Priority.NORMAL;

        List<String> tags = row.length >= 3 && !row[2].isBlank()
                ? List.of(row[2].split("\\|"))        // 記得跳脫 |（第 01 章 1.9 節）
                : List.of();

        return new ParsedTodo(source, index, title, priority, tags);
    }

    private record ParsedTodo(String source, int rowIndex, String title,
                              Priority priority, List<String> tags) { }
}
```

### 兩個來源實作

```java
package com.example.todo.importer;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/** 從 CSV 檔讀取。用 BufferedReader 逐行處理，大檔也不吃記憶體（第 07 章 7.7 節）*/
public class FileSource implements TodoSource {

    private final Path file;

    public FileSource(Path file) {
        this.file = Objects.requireNonNull(file, "file 不可為 null");
    }

    @Override
    public String name() { return "file:" + file.getFileName(); }

    @Override
    public List<String[]> read() throws IOException {
        List<String[]> rows = new ArrayList<>();
        try (var reader = Files.newBufferedReader(file)) {
            String line;
            boolean first = true;
            while ((line = reader.readLine()) != null) {
                if (first) {
                    first = false;
                    // 去掉 BOM（第 07 章 7.10 節）
                    if (line.startsWith("﻿")) line = line.substring(1);
                    if (line.toLowerCase().startsWith("title")) continue;   // 跳過標頭
                }
                if (line.isBlank()) continue;
                rows.add(line.split(",", -1));         // limit=-1 保留尾端空欄位
            }
        }
        return rows;
    }
}
```

```java
package com.example.todo.importer;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 模擬 HTTP 來源。
 * 真實版本會用 java.net.http.HttpClient（Java 11+）。
 */
public class HttpSource implements TodoSource {

    private final String url;
    private final long latencyMillis;
    private final boolean shouldFail;
    private final int rowCount;

    public HttpSource(String url, long latencyMillis, boolean shouldFail, int rowCount) {
        this.url = url;
        this.latencyMillis = latencyMillis;
        this.shouldFail = shouldFail;
        this.rowCount = rowCount;
    }

    @Override
    public String name() { return "http:" + url.replaceAll("^https?://", ""); }

    @Override
    public List<String[]> read() throws IOException, InterruptedException {
        // 模擬網路延遲 —— 這是「阻塞」，在虛擬執行緒上完全沒問題
        Thread.sleep(latencyMillis);

        if (shouldFail) {
            throw new IOException("HTTP 503 Service Unavailable: " + url);
        }

        List<String[]> rows = new ArrayList<>(rowCount);
        for (int i = 1; i <= rowCount; i++) {
            String priority = switch (i % 4) {
                case 0 -> "URGENT";
                case 1 -> "HIGH";
                case 2 -> "NORMAL";
                default -> "LOW";
            };
            // 故意讓每 20 筆有一筆壞資料，測試「一列失敗不影響其他列」
            if (i % 20 == 0) {
                rows.add(new String[]{"", priority, "遠端"});          // 標題空白
            } else if (i % 33 == 0) {
                rows.add(new String[]{"任務 " + i, "SUPER", "遠端"});  // 無效優先度
            } else {
                rows.add(new String[]{"遠端任務 " + i, priority, "遠端|api"});
            }
        }
        return rows;
    }
}
```

### `JsonFileTodoRepository` 加上執行緒安全

```java
package com.example.todo.repository;

import com.example.todo.model.Todo;
import com.example.todo.support.TodoFileStore;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 第 07 章版本 + 執行緒安全。
 *
 * 用 ReadWriteLock 而非 synchronized：讀取（findById / findAll）遠多於寫入，
 * 而且寫入牽涉檔案 IO（慢），值得讓多個讀取者並行（8.9 節）。
 */
public class JsonFileTodoRepository implements TodoRepository {

    private final TodoFileStore store;
    private final Map<Long, Todo> cache = new LinkedHashMap<>();
    private final AtomicLong sequence = new AtomicLong(0);

    private final ReentrantReadWriteLock rw = new ReentrantReadWriteLock();
    private final ReentrantReadWriteLock.ReadLock read = rw.readLock();
    private final ReentrantReadWriteLock.WriteLock write = rw.writeLock();

    public JsonFileTodoRepository(TodoFileStore store) {
        this.store = Objects.requireNonNull(store, "store 不可為 null");
        reload();
    }

    public final void reload() {
        write.lock();
        try {
            cache.clear();
            long max = 0;
            for (Todo todo : store.load()) {
                cache.put(todo.getId(), todo);
                max = Math.max(max, todo.getId());
            }
            sequence.set(max);
        } finally {
            write.unlock();
        }
    }

    @Override
    public Todo save(Todo todo) {
        Objects.requireNonNull(todo, "todo 不可為 null");
        write.lock();
        try {
            cache.put(todo.getId(), todo);
            flushLocked();
            return todo;
        } finally {
            write.unlock();
        }
    }

    /** ✅ 批次寫入：N 筆只寫檔一次。匯入時務必用這個 */
    public void saveAll(List<Todo> todos) {
        Objects.requireNonNull(todos, "todos 不可為 null");
        if (todos.isEmpty()) return;
        write.lock();
        try {
            for (Todo todo : todos) {
                cache.put(todo.getId(), todo);
            }
            flushLocked();
        } finally {
            write.unlock();
        }
    }

    @Override
    public Optional<Todo> findById(long id) {
        read.lock();
        try {
            return Optional.ofNullable(cache.get(id));
        } finally {
            read.unlock();
        }
    }

    @Override
    public List<Todo> findAll() {
        read.lock();
        try {
            return List.copyOf(cache.values());      // 拷貝後才離開鎖（第 05 章 5.8 節）
        } finally {
            read.unlock();
        }
    }

    @Override
    public boolean deleteById(long id) {
        write.lock();
        try {
            boolean removed = cache.remove(id) != null;
            if (removed) flushLocked();
            return removed;
        } finally {
            write.unlock();
        }
    }

    /** ✅ AtomicLong 保證併發下不會撞號 */
    @Override
    public long nextId() {
        return sequence.incrementAndGet();
    }

    /** 呼叫者必須已持有寫鎖 */
    private void flushLocked() {
        store.save(List.copyOf(cache.values()));
    }
}
```

### 執行

```java
package com.example.todo;

import com.example.todo.importer.*;
import com.example.todo.repository.JsonFileTodoRepository;
import com.example.todo.support.TodoFileStore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public class ImportDemo {

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("import-demo");
        Clock clock = Clock.systemDefaultZone();

        // 準備兩個 CSV 檔
        Files.writeString(dir.resolve("work.csv"), """
                title,priority,tags
                寫第 08 章,URGENT,寫作|java
                Code review,HIGH,團隊
                ,HIGH,壞資料沒有標題
                重構匯入器,NORMAL,java|重構
                無效優先度,SUPER_URGENT,測試
                """);

        Files.writeString(dir.resolve("life.csv"), """
                title,priority,tags
                買咖啡,LOW,生活
                運動,NORMAL,健康
                """);

        // 組裝來源：2 個檔案 + 5 個模擬的 HTTP 端點（其中一個會失敗、一個很慢）
        List<TodoSource> sources = new ArrayList<>();
        sources.add(new FileSource(dir.resolve("work.csv")));
        sources.add(new FileSource(dir.resolve("life.csv")));
        sources.add(new FileSource(dir.resolve("missing.csv")));         // 檔案不存在
        sources.add(new HttpSource("https://api.example.com/team-a", 300, false, 60));
        sources.add(new HttpSource("https://api.example.com/team-b", 250, false, 40));
        sources.add(new HttpSource("https://api.example.com/team-c", 200, true, 0));   // 503
        sources.add(new HttpSource("https://api.example.com/team-d", 800, false, 100)); // 慢
        sources.add(new HttpSource("https://api.example.com/team-e", 150, false, 30));

        var store = new TodoFileStore(dir.resolve("todos.json"), clock);
        var repo = new JsonFileTodoRepository(store);

        var importer = new ConcurrentTodoImporter(
                repo, clock,
                4,                              // 同時最多 4 個來源
                Duration.ofSeconds(5));

        System.out.println("開始匯入 " + sources.size() + " 個來源…\n");
        ImportResult result = importer.importFrom(sources);
        System.out.println(result.render());

        System.out.println("Repository 現有筆數: " + repo.findAll().size());
        System.out.println("資料檔大小: " + Files.size(dir.resolve("todos.json")) / 1024 + " KB");

        // ===== 對照：循序匯入要多久 =====
        System.out.println("\n=== 對照：循序匯入 ===");
        var seqStore = new TodoFileStore(dir.resolve("todos-seq.json"), clock);
        var seqRepo = new JsonFileTodoRepository(seqStore);
        var seqImporter = new ConcurrentTodoImporter(
                seqRepo, clock, 1, Duration.ofSeconds(10));   // 併發數 = 1
        ImportResult seqResult = seqImporter.importFrom(sources);
        System.out.printf("循序耗時: %,d ms%n", seqResult.elapsed().toMillis());
        System.out.printf("併發耗時: %,d ms%n", result.elapsed().toMillis());
        System.out.printf("加速比  : %.1fx%n",
                (double) seqResult.elapsed().toMillis() / result.elapsed().toMillis());

        // ===== 驗證併發下 id 不撞號 =====
        System.out.println("\n=== 驗證 id 唯一性 ===");
        long distinct = repo.findAll().stream().map(t -> t.getId()).distinct().count();
        System.out.println("總筆數: " + repo.findAll().size() + "，不同 id 數: " + distinct);
        System.out.println(distinct == repo.findAll().size() ? "✅ 沒有撞號" : "❌ 有重複 id");

        cleanup(dir);
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

輸出：

```
開始匯入 8 個來源…

=== 匯入報告 ===
總列數   : 235
成功     : 222 (94.5%)
失敗     : 13
總耗時   : 1063 ms

--- 各來源 ---
  ❌ file:missing.csv       來源失敗: NoSuchFileException: /tmp/.../missing.csv
  ✅ file:life.csv          2 列，成功 2，失敗 0，     3 ms
  ✅ file:work.csv          5 列，成功 3，失敗 2，     4 ms
  ✅ http:api.example.com/team-a   60 列，成功 57，失敗 3，  305 ms
  ✅ http:api.example.com/team-b   40 列，成功 38，失敗 2，  253 ms
  ❌ http:api.example.com/team-c   來源失敗: IOException: HTTP 503 Service Unavailable: ...
  ✅ http:api.example.com/team-d  100 列，成功 95，失敗 5，  803 ms
  ✅ http:api.example.com/team-e   30 列，成功 29，失敗 1，  153 ms

--- 失敗的列（前 10 筆）---
  [file:work.csv:2] ,HIGH,壞資料沒有標題 → 標題不可為空
  [file:work.csv:4] 無效優先度,SUPER_URGENT,測試 → 無效的優先度，可用值: URGENT, HIGH, NORMAL, LOW
  [http:api.example.com/team-a:19] ,LOW,遠端 → 標題不可為空
  ...
  …還有 3 筆

Repository 現有筆數: 222
資料檔大小: 68 KB

=== 對照：循序匯入 ===
循序耗時: 1,724 ms
併發耗時: 1,063 ms
加速比  : 1.6x

=== 驗證 id 唯一性 ===
總筆數: 222，不同 id 數: 222
✅ 沒有撞號
```

### 這一版用到本章的哪些技術

| 技術 | 用在哪 | 為什麼 |
|---|---|---|
| 虛擬執行緒 | `importFrom` 的 executor | 來源是 IO 密集，數量不定（8.14 節） |
| `Semaphore` | 限制 `maxConcurrentSources` | 不要把下游 API 打爆（8.14 節注意事項 ①） |
| `tryAcquire(timeout)` | 等配額 | 避免無限等待（8.9 節） |
| `ConcurrentHashMap` | `bySource` 統計 | 多執行緒寫入（8.16 節） |
| `LongAdder` | `totalRows` | 純計數，高併發下比 `AtomicLong` 快（8.7 節） |
| `ConcurrentLinkedQueue` + `AtomicInteger` | 暫存解析結果 | `size()` 是 O(n)，所以自己計數（8.16 節） |
| `Collections.synchronizedList` | `errors` | 錯誤數不多，簡單同步就夠 |
| 檢查每個 `Future.get()` | 階段 1 結尾 | 否則預期外的例外會被吞掉（8.17 節） |
| `ReadWriteLock` | `JsonFileTodoRepository` | 讀多寫少，寫入牽涉檔案 IO（8.9 節） |
| `AtomicLong` 產生 id | `nextId()` | 併發下不撞號（8.7 節） |
| **單執行緒寫入** | 階段 2 | 背後是一個檔案，併發寫會互相覆蓋 |
| 批次 `saveAll` | 階段 2 | 222 筆只寫檔一次，不是 222 次 |
| `Thread.currentThread().interrupt()` | catch `InterruptedException` | 恢復旗標（第 04 章反模式 6） |
| `finally { gate.release(); }` | `processSource` | 忘記就永久少一個配額 |

> **注意「加速比只有 1.6x」而不是 8x。** 因為 `maxConcurrentSources = 4`，而且最慢的來源
> （team-d，800ms）決定了下限。這是併發的現實：**加速比受限於最慢的那條路徑（Amdahl 定律）**。
>
> 把 `maxConcurrentSources` 調成 8 會更快，但要先確認下游 API 承受得住。

---

## 8.19 常見錯誤

| # | 錯誤 | 修法 |
|---|---|---|
| 1 | 呼叫 `thread.run()` 而不是 `start()` | 用 `start()` |
| 2 | 吞掉 `InterruptedException` | `Thread.currentThread().interrupt()` |
| 3 | 忙迴圈沒檢查 `isInterrupted()` | 每圈檢查 |
| 4 | 用 `volatile` 想解決 `i++` | 用 `AtomicInteger` 或 `synchronized` |
| 5 | 共用旗標沒加 `volatile` | 加上，或用 `AtomicBoolean` |
| 6 | 鎖住 `String` 常值 / `Integer` / 會變的參考 | `private final Object lock = new Object()` |
| 7 | 在鎖裡做 IO | 把 IO 移到鎖外 |
| 8 | `ReentrantLock` 的 `unlock` 沒放 `finally` | 一律 `try { } finally { unlock(); }` |
| 9 | 多把鎖沒有固定順序 | 依 ID 排序，或用 `tryLock` |
| 10 | `Condition.await()` 用 `if` 而不是 `while` | 一律 `while`（假醒） |
| 11 | 用 `Executors.newFixedThreadPool` | 自己 `new ThreadPoolExecutor`，有界佇列 |
| 12 | `LinkedBlockingQueue` 沒給容量 | 一律指定容量 |
| 13 | 用 `DiscardPolicy` | 用 `CallerRunsPolicy` 或自訂（會記 log） |
| 14 | `submit()` 的 `Future` 沒人檢查 | 檢查 `get()`，或改用 `execute()` + handler |
| 15 | `scheduleAtFixedRate` 的任務沒包 try-catch | 包住，否則一次例外就永久停止排程 |
| 16 | 沒有優雅關閉執行緒池 | 用 8.11 節的 `shutdownGracefully` 樣板 |
| 17 | `CompletableFuture.supplyAsync` 沒指定 Executor | 一律指定；預設的 commonPool 是全 JVM 共用 |
| 18 | `ExecutionException` 沒看 `getCause()` | 看 cause 才知道真正的錯誤 |
| 19 | `ThreadLocal` 忘記 `remove()` | `try-finally`；這是資安問題（跨請求資料洩漏） |
| 20 | 池化虛擬執行緒 | 用 `newVirtualThreadPerTaskExecutor`；限流用 `Semaphore` |
| 21 | 虛擬執行緒上做 CPU 密集運算 | 用平台執行緒池 |
| 22 | Java 21~23 在 `synchronized` 內阻塞虛擬執行緒 | 改用 `ReentrantLock`，或升級到 Java 24+ |
| 23 | 多執行緒用 `HashMap` / `ArrayList` | `ConcurrentHashMap` / `CopyOnWriteArrayList` |
| 24 | `if (!map.containsKey(k)) map.put(k, v)` | `putIfAbsent` / `computeIfAbsent` |
| 25 | 頻繁呼叫 `ConcurrentLinkedQueue.size()` | 自己維護 `LongAdder` |
| 26 | 併發寫同一個檔案 | 集中到單執行緒，或用檔案鎖 |
| 27 | 期待 `InheritableThreadLocal` 在執行緒池中傳遞 | 手動傳、用 `TaskDecorator`、或 `ScopedValue` |

---

## 8.20 本章練習

### 練習 1：找出所有問題

```java
public class Buggy {

    private static Map<String, Integer> cache = new HashMap<>();
    private static int requestCount = 0;
    private boolean shutdown = false;

    private final ExecutorService pool = Executors.newCachedThreadPool();

    public void handleRequest(String key) {
        requestCount++;
        if (!cache.containsKey(key)) {
            cache.put(key, loadFromDb(key));
        }
        pool.submit(() -> process(cache.get(key)));
    }

    public void workLoop() {
        while (!shutdown) {
            try {
                Thread.sleep(1000);
                doPeriodicWork();
            } catch (InterruptedException e) {
            }
        }
    }

    public void requestShutdown() {
        shutdown = true;
        pool.shutdown();
    }

    public CompletableFuture<String> fetchAll(List<String> ids) {
        return CompletableFuture.supplyAsync(() ->
                ids.stream().map(this::httpGet).collect(Collectors.joining(",")));
    }

    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    public void withTenant(String tenant, Runnable action) {
        TENANT.set(tenant);
        action.run();
    }
}
```

<details>
<summary>參考解答</summary>

**九個問題：**

1. **`static HashMap` 當快取**——多執行緒下會壞（第 05 章 5.13 節）。Java 7 甚至可能 CPU 100%。
2. **`requestCount++`**——不是原子操作（8.4 節）。
3. **`shutdown` 沒有 `volatile`**——`workLoop` 可能永遠看不到變更（8.4 節）。
4. **`containsKey` + `put`**——check-then-act，不是原子的（8.16 節）。
5. **`Executors.newCachedThreadPool()`**——執行緒數無上限，突發流量會 OOM（8.11 節）。
6. **吞掉 `InterruptedException`**——`workLoop` 停不下來（8.3 節）。
7. **`shutdown()` 後沒有 `awaitTermination`**——不知道任務是否完成（8.11 節）。
8. **`supplyAsync` 沒指定 Executor**，而且裡面用 `stream().map(httpGet)` 做**循序**的 HTTP 呼叫——
   沒有任何併發效果，還佔住 commonPool（8.12 節、第 06 章 6.16 節）。
9. **`ThreadLocal` 沒有 `remove()`**——執行緒池重用時跨租戶資料洩漏（8.13 節）。

**修正版：**

```java
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.LongAdder;
import java.util.stream.Collectors;

public class Fixed implements AutoCloseable {

    // ① 併發 Map
    private final ConcurrentHashMap<String, Integer> cache = new ConcurrentHashMap<>();

    // ② 純計數用 LongAdder（8.7 節）
    private final LongAdder requestCount = new LongAdder();

    // ③ 用 AtomicBoolean（比 volatile boolean 多了 compareAndSet 能力）
    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    // ⑤ 有界執行緒池 + 有界佇列 + 明確的拒絕策略
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(
            8, 32, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(200),
            new NamedThreadFactory("request-worker"),
            new ThreadPoolExecutor.CallerRunsPolicy());

    // ⑧ 專用的 IO 池（真實專案可用虛擬執行緒）
    private final ExecutorService ioPool = Executors.newVirtualThreadPerTaskExecutor();

    public void handleRequest(String key) {
        requestCount.increment();

        // ④ computeIfAbsent 是原子的
        Integer value = cache.computeIfAbsent(key, this::loadFromDb);

        Future<?> f = pool.submit(() -> process(value));
        // ⑭ 至少要有人處理例外（8.17 節）。這裡選擇非阻塞地掛一個回呼
        pool.submit(() -> {
            try {
                f.get();
            } catch (ExecutionException e) {
                System.err.println("[ERROR] 處理失敗: " + e.getCause());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    public void workLoop() {
        while (!shutdown.get() && !Thread.currentThread().isInterrupted()) {
            try {
                Thread.sleep(1000);
                // ⑮ 任務丟例外不該讓迴圈死掉
                try {
                    doPeriodicWork();
                } catch (RuntimeException e) {
                    System.err.println("[WARN] 週期任務失敗，下一輪繼續: " + e.getMessage());
                }
            } catch (InterruptedException e) {
                // ⑥ 恢復旗標並結束迴圈
                Thread.currentThread().interrupt();
                break;
            }
        }
        System.out.println("workLoop 結束");
    }

    public void requestShutdown() {
        shutdown.set(true);
    }

    /** ⑦ 優雅關閉（8.11 節樣板） */
    @Override
    public void close() {
        requestShutdown();
        shutdownGracefully(pool, 10, TimeUnit.SECONDS);
        shutdownGracefully(ioPool, 10, TimeUnit.SECONDS);
    }

    static void shutdownGracefully(ExecutorService pool, long timeout, TimeUnit unit) {
        pool.shutdown();
        try {
            if (!pool.awaitTermination(timeout, unit)) {
                pool.shutdownNow();
                if (!pool.awaitTermination(timeout, unit)) {
                    System.err.println("執行緒池無法關閉");
                }
            }
        } catch (InterruptedException e) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    /** ⑧ 真正的併發抓取：每個 id 一個任務，指定專用池 */
    public CompletableFuture<String> fetchAll(List<String> ids) {
        List<CompletableFuture<String>> futures = ids.stream()
                .map(id -> CompletableFuture
                        .supplyAsync(() -> httpGet(id), ioPool)
                        .orTimeout(3, TimeUnit.SECONDS)
                        .exceptionally(ex -> {
                            System.err.println("[WARN] " + id + " 抓取失敗: " + ex.getMessage());
                            return "";                       // 降級：空字串
                        }))
                .toList();

        return CompletableFuture
                .allOf(futures.toArray(CompletableFuture[]::new))
                .thenApply(v -> futures.stream()
                        .map(CompletableFuture::join)
                        .filter(s -> !s.isEmpty())
                        .collect(Collectors.joining(",")));
    }

    // ⑨ ThreadLocal 一律 try-finally
    private static final ThreadLocal<String> TENANT = new ThreadLocal<>();

    public void withTenant(String tenant, Runnable action) {
        java.util.Objects.requireNonNull(tenant, "tenant 不可為 null");
        String previous = TENANT.get();      // 支援嵌套呼叫
        TENANT.set(tenant);
        try {
            action.run();
        } finally {
            if (previous == null) {
                TENANT.remove();             // ★ 關鍵
            } else {
                TENANT.set(previous);
            }
        }
    }

    public static String currentTenant() {
        String t = TENANT.get();
        if (t == null) {
            throw new IllegalStateException("不在租戶上下文中");
        }
        return t;
    }

    /** 具名執行緒工廠：出事時 log 才看得出是哪個池 */
    static class NamedThreadFactory implements ThreadFactory {
        private final String prefix;
        private final java.util.concurrent.atomic.AtomicInteger seq =
                new java.util.concurrent.atomic.AtomicInteger(1);

        NamedThreadFactory(String prefix) { this.prefix = prefix; }

        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, prefix + "-" + seq.getAndIncrement());
            t.setUncaughtExceptionHandler((thread, e) ->
                    System.err.printf("[ERROR] %s 未捕捉的例外: %s%n", thread.getName(), e));
            return t;
        }
    }

    // 假實作
    private Integer loadFromDb(String key) { return key.hashCode(); }
    private void process(Integer value) { }
    private void doPeriodicWork() { }
    private String httpGet(String id) {
        try { Thread.sleep(100); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return "data-" + id;
    }
}
```

**特別注意 `withTenant` 的巢狀處理**：直接 `remove()` 會在巢狀呼叫時
把外層的租戶也清掉。保存 `previous` 並還原，是正確的做法。

</details>

### 練習 2：實作一個執行緒安全的限流器

實作 `RateLimiter`，限制「每秒最多 N 次操作」。要求：

1. 執行緒安全
2. 提供 `tryAcquire()`（立刻回傳）與 `acquire()`（阻塞等待）
3. 用滑動視窗，不是固定視窗
4. 可注入 `Clock`（第 07 章 7.15 節）以便測試

<details>
<summary>參考解答</summary>

```java
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Objects;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 滑動視窗限流器。
 *
 * 為什麼不用固定視窗？
 *   固定視窗（每秒歸零）在邊界會允許「兩倍流量」：
 *   00:00.999 打 100 次 + 00:01.001 打 100 次 = 2ms 內 200 次。
 *   滑動視窗看的是「過去 1 秒內」，不會有這個問題。
 */
public class SlidingWindowRateLimiter {

    private final int permitsPerWindow;
    private final Duration window;
    private final Clock clock;

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition permitAvailable = lock.newCondition();

    /** 記錄每次通過的時間戳（毫秒）。視窗外的會被移除 */
    private final Deque<Long> timestamps = new ArrayDeque<>();

    // 統計
    private long granted = 0;
    private long rejected = 0;

    public SlidingWindowRateLimiter(int permitsPerWindow, Duration window, Clock clock) {
        if (permitsPerWindow < 1) {
            throw new IllegalArgumentException("permits 必須 >= 1，收到: " + permitsPerWindow);
        }
        Objects.requireNonNull(window, "window 不可為 null");
        if (window.isZero() || window.isNegative()) {
            throw new IllegalArgumentException("window 必須為正數，收到: " + window);
        }
        this.permitsPerWindow = permitsPerWindow;
        this.window = window;
        this.clock = Objects.requireNonNull(clock, "clock 不可為 null");
    }

    public static SlidingWindowRateLimiter perSecond(int permits) {
        return new SlidingWindowRateLimiter(permits, Duration.ofSeconds(1), Clock.systemUTC());
    }

    /** 非阻塞：拿到配額回 true，否則立刻回 false */
    public boolean tryAcquire() {
        lock.lock();
        try {
            long now = clock.millis();
            evictExpired(now);

            if (timestamps.size() < permitsPerWindow) {
                timestamps.addLast(now);
                granted++;
                return true;
            }
            rejected++;
            return false;
        } finally {
            lock.unlock();
        }
    }

    /** 阻塞：等到有配額為止（或超時） */
    public boolean acquire(Duration timeout) throws InterruptedException {
        Objects.requireNonNull(timeout, "timeout 不可為 null");
        long deadlineNanos = System.nanoTime() + timeout.toNanos();

        lock.lock();
        try {
            while (true) {
                long now = clock.millis();
                evictExpired(now);

                if (timestamps.size() < permitsPerWindow) {
                    timestamps.addLast(now);
                    granted++;
                    return true;
                }

                // 算出「最舊的那個配額」什麼時候會離開視窗
                long oldestExpiresAt = timestamps.peekFirst() + window.toMillis();
                long waitMillis = Math.max(1, oldestExpiresAt - now);

                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0) {
                    rejected++;
                    return false;
                }

                // ⚠️ 用 while 迴圈 + await(timeout)，處理假醒（8.9 節）
                long waitNanos = Math.min(remainingNanos,
                        java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(waitMillis));
                permitAvailable.awaitNanos(waitNanos);
            }
        } finally {
            lock.unlock();
        }
    }

    /** 呼叫者必須持有鎖 */
    private void evictExpired(long now) {
        long cutoff = now - window.toMillis();
        boolean evicted = false;
        while (!timestamps.isEmpty() && timestamps.peekFirst() <= cutoff) {
            timestamps.pollFirst();
            evicted = true;
        }
        if (evicted) {
            permitAvailable.signalAll();     // 有配額釋出，喚醒等待者
        }
    }

    /** 當前視窗內的用量 */
    public int currentUsage() {
        lock.lock();
        try {
            evictExpired(clock.millis());
            return timestamps.size();
        } finally {
            lock.unlock();
        }
    }

    public String stats() {
        lock.lock();
        try {
            long total = granted + rejected;
            return "通過 %d / %d (%.1f%%)，當前用量 %d/%d".formatted(
                    granted, total, total == 0 ? 0.0 : granted * 100.0 / total,
                    timestamps.size(), permitsPerWindow);
        } finally {
            lock.unlock();
        }
    }

    // ===== 測試 =====

    /** 可手動推進時間的 Clock（第 07 章 7.15 節，原樣搬來） */
    static class MutableClock extends Clock {
        private Instant instant;
        private final java.time.ZoneId zone;

        MutableClock(Instant start, java.time.ZoneId zone) {
            this.instant = start;
            this.zone = zone;
        }

        @Override public java.time.ZoneId getZone() { return zone; }
        @Override public Clock withZone(java.time.ZoneId z) { return new MutableClock(instant, z); }
        @Override public synchronized Instant instant() { return instant; }

        synchronized void advance(Duration d) { this.instant = this.instant.plus(d); }
    }

    public static void main(String[] args) throws InterruptedException {

        // ===== 測試 1：用 MutableClock 精確驗證行為（不需要 sleep）=====
        System.out.println("=== 測試 1：滑動視窗行為（固定時鐘）===");
        var clock = new MutableClock(Instant.parse("2026-08-17T00:00:00Z"), java.time.ZoneId.of("UTC"));
        var limiter = new SlidingWindowRateLimiter(3, Duration.ofSeconds(1), clock);

        System.out.println("  t=0.0s 前三次:");
        for (int i = 1; i <= 3; i++) {
            System.out.println("    第 " + i + " 次: " + limiter.tryAcquire());   // true
        }
        System.out.println("    第 4 次: " + limiter.tryAcquire());                // false
        System.out.println("    當前用量: " + limiter.currentUsage());              // 3

        clock.advance(Duration.ofMillis(500));
        System.out.println("  t=0.5s: " + limiter.tryAcquire() + "（還在視窗內，應為 false）");

        clock.advance(Duration.ofMillis(501));
        System.out.println("  t=1.001s: " + limiter.tryAcquire() + "（前三次已過期，應為 true）");
        System.out.println("    當前用量: " + limiter.currentUsage());              // 1
        System.out.println("  " + limiter.stats());

        // ===== 測試 2：滑動視窗 vs 固定視窗的邊界差異 =====
        System.out.println("\n=== 測試 2：邊界行為 ===");
        var clock2 = new MutableClock(Instant.parse("2026-08-17T00:00:00Z"), java.time.ZoneId.of("UTC"));
        var sliding = new SlidingWindowRateLimiter(5, Duration.ofSeconds(1), clock2);

        clock2.advance(Duration.ofMillis(999));
        int burst1 = 0;
        for (int i = 0; i < 10; i++) if (sliding.tryAcquire()) burst1++;
        System.out.println("  t=0.999s 打 10 次，通過 " + burst1);       // 5

        clock2.advance(Duration.ofMillis(2));
        int burst2 = 0;
        for (int i = 0; i < 10; i++) if (sliding.tryAcquire()) burst2++;
        System.out.println("  t=1.001s 打 10 次，通過 " + burst2);       // 0（滑動視窗擋住了）
        System.out.println("  → 3ms 內共通過 " + (burst1 + burst2) + " 次（上限 5）✅");
        System.out.println("  固定視窗的話會通過 10 次（兩個視窗各 5 次）❌");

        // ===== 測試 3：真實併發 =====
        System.out.println("\n=== 測試 3：50 條虛擬執行緒搶 10 個配額 ===");
        var realLimiter = SlidingWindowRateLimiter.perSecond(10);
        var passed = new java.util.concurrent.atomic.AtomicInteger();

        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 50; i++) {
                pool.submit(() -> {
                    if (realLimiter.tryAcquire()) passed.incrementAndGet();
                });
            }
        }
        System.out.println("  50 次嘗試，通過 " + passed.get() + " 次（應為 10）");
        System.out.println("  " + realLimiter.stats());

        // ===== 測試 4：阻塞式 acquire =====
        System.out.println("\n=== 測試 4：阻塞式 acquire ===");
        var blocking = SlidingWindowRateLimiter.perSecond(2);
        long start = System.currentTimeMillis();
        for (int i = 1; i <= 5; i++) {
            boolean ok = blocking.acquire(Duration.ofSeconds(5));
            System.out.printf("  第 %d 次 %s（累計 %,d ms）%n",
                    i, ok ? "通過" : "超時", System.currentTimeMillis() - start);
        }
        System.out.println("  → 每秒 2 次，5 次約需 2 秒");

        System.out.println("\n=== 超時測試 ===");
        var tight = SlidingWindowRateLimiter.perSecond(1);
        tight.tryAcquire();
        System.out.println("  100ms 超時的 acquire: " + tight.acquire(Duration.ofMillis(100)));
    }
}
```

輸出：

```
=== 測試 1：滑動視窗行為（固定時鐘）===
  t=0.0s 前三次:
    第 1 次: true
    第 2 次: true
    第 3 次: true
    第 4 次: false
    當前用量: 3
  t=0.5s: false（還在視窗內，應為 false）
  t=1.001s: true（前三次已過期，應為 true）
    當前用量: 1
  通過 4 / 6 (66.7%)，當前用量 1/3

=== 測試 2：邊界行為 ===
  t=0.999s 打 10 次，通過 5
  t=1.001s 打 10 次，通過 0
  → 3ms 內共通過 5 次（上限 5）✅
  固定視窗的話會通過 10 次（兩個視窗各 5 次）❌

=== 測試 3：50 條虛擬執行緒搶 10 個配額 ===
  50 次嘗試，通過 10 次（應為 10）
  通過 10 / 50 (20.0%)，當前用量 10/10

=== 測試 4：阻塞式 acquire ===
  第 1 次 通過（累計 0 ms）
  第 2 次 通過（累計 1 ms）
  第 3 次 通過（累計 1002 ms）
  第 4 次 通過（累計 1003 ms）
  第 5 次 通過（累計 2004 ms）
  → 每秒 2 次，5 次約需 2 秒

=== 超時測試 ===
  100ms 超時的 acquire: false
```

**六個設計要點：**

| 要點 | 說明 |
|---|---|
| **`ReentrantLock` 而非 `synchronized`** | 需要 `Condition` 來實作阻塞式 `acquire` 的等待/喚醒（8.9 節） |
| **`while` 迴圈包住 `await`** | 假醒 + 醒來後狀態可能又變了（8.9 節） |
| **`awaitNanos` 而非 `await`** | 沒有人 signal 時也要能自己醒來檢查（時間到了配額就該釋出） |
| **注入 `Clock`** | 測試 1、2 完全不用 `sleep`，瞬間跑完且結果確定（第 07 章 7.15 節） |
| **`evictExpired` 裡 `signalAll`** | 有配額釋出時喚醒等待者，否則阻塞的執行緒要等超時 |
| **滑動窗而非固定窗** | 測試 2 證明了差異：固定窗在邊界會放行兩倍流量 |

**這個實作的限制（實務上要知道）：**

1. **記憶體與 `permitsPerWindow` 成正比**。限制「每秒 100 萬次」就要存 100 萬個時間戳。
   高流量場景該用 **token bucket**（只存一個 token 數 + 上次補充時間，O(1) 記憶體）。
2. **單機限流**。分散式系統要用 Redis（第 05 站會實作 `INCR` + `EXPIRE` 或 Redis Cell）。
3. **實務上用 Resilience4j / Bucket4j / Guava `RateLimiter`**，不要自己寫。
   自己寫一遍的價值是理解「滑動 vs 固定」、「阻塞 vs 非阻塞」這些設計取捨。

</details>

### 練習 3：修正一段會死鎖的程式

```java
public class BankTransfer {

    static class Account {
        final String id;
        long balance;
        Account(String id, long balance) { this.id = id; this.balance = balance; }
    }

    public void transfer(Account from, Account to, long amount) {
        synchronized (from) {
            synchronized (to) {
                if (from.balance < amount) {
                    throw new IllegalStateException("餘額不足");
                }
                from.balance -= amount;
                to.balance += amount;
            }
        }
    }

    public long totalBalance(List<Account> accounts) {
        long total = 0;
        for (Account a : accounts) {
            total += a.balance;
        }
        return total;
    }
}
```

<details>
<summary>參考解答</summary>

**兩個問題：**

1. **`transfer` 會死鎖**：A→B 與 B→A 同時發生時，加鎖順序相反（8.8 節）。
2. **`totalBalance` 沒有同步**：讀取時可能看到「錢已扣但還沒加」的中間狀態，
   算出的總額是錯的。這叫**不一致的快照**。

```java
import java.util.List;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

public class BankTransferFixed {

    static final class Account {
        private final String id;
        private final ReentrantLock lock = new ReentrantLock();
        private long balance;

        Account(String id, long balance) {
            this.id = Objects.requireNonNull(id, "id 不可為 null");
            if (balance < 0) {
                throw new IllegalArgumentException("初始餘額不可為負: " + balance);
            }
            this.balance = balance;
        }

        String id() { return id; }
        ReentrantLock lock() { return lock; }

        /** 呼叫者必須持有本帳戶的鎖 */
        long balanceLocked() { return balance; }

        void debitLocked(long amount) {
            if (balance < amount) {
                throw new IllegalStateException(
                        "餘額不足：帳戶 %s 可用 %d，欲扣 %d".formatted(id, balance, amount));
            }
            balance -= amount;
        }

        void creditLocked(long amount) {
            balance = Math.addExact(balance, amount);      // 防溢位（第 01 章 1.4 節）
        }

        /** 安全的單筆讀取 */
        long balance() {
            lock.lock();
            try { return balance; } finally { lock.unlock(); }
        }
    }

    /**
     * ✅ 修正 1：固定加鎖順序（依 id 字典序）
     * 這是最簡單也最有效的死鎖預防（8.8 節）
     */
    public void transfer(Account from, Account to, long amount) {
        validate(from, to, amount);

        Account first = from.id().compareTo(to.id()) < 0 ? from : to;
        Account second = (first == from) ? to : from;

        first.lock().lock();
        try {
            second.lock().lock();
            try {
                from.debitLocked(amount);
                to.creditLocked(amount);
            } finally {
                second.lock().unlock();
            }
        } finally {
            first.lock().unlock();
        }
    }

    /**
     * ✅ 修正 1 的替代方案：tryLock 帶超時。
     * 適合「加鎖順序無法預先決定」的情況（例如 id 可能相同、或有第三方鎖介入）
     */
    public boolean transferWithTimeout(Account from, Account to, long amount, long timeoutMillis)
            throws InterruptedException {
        validate(from, to, amount);
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);

        while (System.nanoTime() < deadline) {
            if (from.lock().tryLock(20, TimeUnit.MILLISECONDS)) {
                try {
                    if (to.lock().tryLock(20, TimeUnit.MILLISECONDS)) {
                        try {
                            from.debitLocked(amount);
                            to.creditLocked(amount);
                            return true;
                        } finally {
                            to.lock().unlock();
                        }
                    }
                } finally {
                    from.lock().unlock();       // 沒拿到第二把就放掉第一把
                }
            }
            // 隨機退避，避免兩條執行緒同步重試造成活鎖（livelock）
            Thread.sleep(1 + (long) (Math.random() * 10));
        }
        return false;
    }

    private void validate(Account from, Account to, long amount) {
        Objects.requireNonNull(from, "from 不可為 null");
        Objects.requireNonNull(to, "to 不可為 null");
        if (from == to) {
            throw new IllegalArgumentException("不可轉帳給自己: " + from.id());
        }
        if (amount <= 0) {
            throw new IllegalArgumentException("金額必須大於 0，收到: " + amount);
        }
    }

    /**
     * ✅ 修正 2：一致的快照。
     * 依 id 排序後鎖住「全部」帳戶，才能得到正確的總額。
     * ⚠️ 這會凍結所有轉帳 —— 只適合對帳、稽核這類低頻操作。
     */
    public long totalBalanceConsistent(List<Account> accounts) {
        List<Account> sorted = accounts.stream()
                .sorted(java.util.Comparator.comparing(Account::id))      // 固定順序 → 不死鎖
                .toList();

        // 依序鎖住全部
        for (Account a : sorted) a.lock().lock();
        try {
            long total = 0;
            for (Account a : sorted) {
                total = Math.addExact(total, a.balanceLocked());
            }
            return total;
        } finally {
            // 反序解鎖（習慣上更清楚；ReentrantLock 其實不要求）
            for (int i = sorted.size() - 1; i >= 0; i--) {
                sorted.get(i).lock().unlock();
            }
        }
    }

    /**
     * ✅ 更好的做法：完全避開「鎖全部帳戶」。
     * 用一個全域的「總額不變量」計數器，轉帳時不改變它（扣多少加多少）。
     * 讀取總額變成 O(1) 且無鎖。
     */
    static class BankWithInvariant {
        private final AtomicLong totalCents = new AtomicLong();
        private final BankTransferFixed transferService = new BankTransferFixed();

        void openAccount(Account a) {
            totalCents.addAndGet(a.balance());
        }

        void transfer(Account from, Account to, long amount) {
            transferService.transfer(from, to, amount);
            // 總額不變，所以什麼都不用做
        }

        void deposit(Account a, long amount) {
            a.lock().lock();
            try {
                a.creditLocked(amount);
            } finally {
                a.lock().unlock();
            }
            totalCents.addAndGet(amount);
        }

        /** O(1)，無鎖 */
        long total() { return totalCents.get(); }
    }

    // ===== 驗證 =====

    public static void main(String[] args) throws InterruptedException {
        var service = new BankTransferFixed();
        var a = new Account("A", 10_000);
        var b = new Account("B", 10_000);
        var c = new Account("C", 10_000);
        List<Account> all = List.of(a, b, c);
        long initialTotal = 30_000;

        System.out.println("=== 雙向轉帳 6 萬次，驗證不死鎖且總額守恆 ===");
        var errors = new java.util.concurrent.atomic.LongAdder();

        try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 20_000; i++) {
                pool.submit(() -> safeTransfer(service, a, b, 1, errors));
                pool.submit(() -> safeTransfer(service, b, c, 1, errors));
                pool.submit(() -> safeTransfer(service, c, a, 1, errors));
            }
        }

        System.out.println("  A: " + a.balance());
        System.out.println("  B: " + b.balance());
        System.out.println("  C: " + c.balance());
        long total = service.totalBalanceConsistent(all);
        System.out.println("  總額: " + total + "（初始 " + initialTotal + "）");
        System.out.println("  餘額不足的次數: " + errors.sum());
        System.out.println(total == initialTotal ? "  ✅ 總額守恆，無死鎖" : "  ❌ 錢不見了");

        System.out.println("\n=== tryLock 版本 ===");
        System.out.println("  轉帳結果: " + service.transferWithTimeout(a, b, 100, 1000));
        System.out.println("  總額: " + service.totalBalanceConsistent(all));

        System.out.println("\n=== O(1) 總額版本 ===");
        var bank = new BankWithInvariant();
        var x = new Account("X", 5_000);
        var y = new Account("Y", 5_000);
        bank.openAccount(x);
        bank.openAccount(y);
        System.out.println("  初始總額: " + bank.total());
        bank.transfer(x, y, 1_000);
        System.out.println("  轉帳後總額: " + bank.total() + "（O(1) 讀取，無需鎖住所有帳戶）");
        bank.deposit(x, 500);
        System.out.println("  存款後總額: " + bank.total());
    }

    static void safeTransfer(BankTransferFixed service, Account from, Account to,
                             long amount, java.util.concurrent.atomic.LongAdder errors) {
        try {
            service.transfer(from, to, amount);
        } catch (IllegalStateException e) {
            errors.increment();        // 餘額不足是正常的業務結果，不是 bug
        }
    }
}
```

輸出：

```
=== 雙向轉帳 6 萬次，驗證不死鎖且總額守恆 ===
  A: 10000
  B: 10000
  C: 10000
  總額: 30000（初始 30000）
  餘額不足的次數: 0
  ✅ 總額守恆，無死鎖

=== tryLock 版本 ===
  轉帳結果: true
  總額: 30000

=== O(1) 總額版本 ===
  初始總額: 10000
  轉帳後總額: 10000（O(1) 讀取，無需鎖住所有帳戶）
  存款後總額: 10500
```

**三個層次的解法對照：**

| 解法 | 併發度 | 複雜度 | 適用 |
|---|---|---|---|
| 固定加鎖順序 | 高（只鎖 2 個帳戶） | 低 | ★ 轉帳的標準解 |
| `tryLock` + 退避 | 高 | 中 | 加鎖順序無法預定時 |
| 鎖住全部帳戶算總額 | **極低**（凍結全系統） | 低 | 只能用在對帳等低頻操作 |
| 維護總額不變量 | 高（O(1) 讀取） | 中 | ★ 需要頻繁讀總額時 |

> **實務上這整題的答案是「交給資料庫」**（第 07 站）：
>
> ```sql
> BEGIN;
> UPDATE accounts SET balance = balance - 100 WHERE id = 'A' AND balance >= 100;
> UPDATE accounts SET balance = balance + 100 WHERE id = 'B';
> COMMIT;
> ```
>
> 資料庫的交易與列鎖已經解決了原子性、隔離性、持久性。
> 應用層的鎖只在**單機記憶體狀態**（快取、計數器、連線池）時才需要。
>
> 但要注意：資料庫也會死鎖（MySQL 的 `Deadlock found when trying to get lock`），
> 而且成因完全一樣——**加鎖順序不一致**。所以本節學的原則直接適用。

</details>

### 練習 4：預測輸出

```java
public class Quiz {

    static int counter = 0;
    static volatile boolean flag = false;

    public static void main(String[] args) throws Exception {
        // ①
        Thread t = new Thread(() -> System.out.println("A:" + Thread.currentThread().getName()));
        t.run();

        // ②
        ExecutorService pool = Executors.newFixedThreadPool(1);
        Future<?> f = pool.submit(() -> { throw new RuntimeException("boom"); });
        Thread.sleep(100);
        System.out.println("B:" + f.isDone());

        // ③
        var latch = new CountDownLatch(2);
        latch.countDown();
        System.out.println("C:" + latch.await(100, TimeUnit.MILLISECONDS));

        // ④
        var vt = Thread.ofVirtual().unstarted(() -> {});
        System.out.println("D:" + vt.isDaemon() + "," + vt.isVirtual());

        // ⑤
        var q = new ArrayBlockingQueue<Integer>(1);
        q.offer(1);
        System.out.println("E:" + q.offer(2) + "," + q.size());

        // ⑥
        var cf = CompletableFuture.supplyAsync(() -> 1)
                .thenApply(n -> n / 0)
                .exceptionally(ex -> -1);
        System.out.println("F:" + cf.get());

        // ⑦
        var map = new ConcurrentHashMap<String, Integer>();
        map.put("a", 1);
        System.out.println("G:" + map.merge("a", 10, Integer::sum)
                + "," + map.merge("b", 10, Integer::sum));

        pool.shutdown();
    }
}
```

<details>
<summary>參考解答</summary>

```
A:main
B:true
C:false
D:true,true
E:false,1
F:-1
G:11,10
```

**逐一說明：**

**① `A:main`**
`t.run()` 不是 `t.start()`——它只是在**當前執行緒**（main）呼叫一個普通方法。
所以 `Thread.currentThread().getName()` 是 `main`，不是新執行緒的名字（8.3 節）。

**② `B:true`**
任務丟了例外，但 `submit()` 把例外**吞進 Future**，什麼都不會印出來。
`isDone()` 仍是 `true`（「完成」包含「異常結束」）。
只有呼叫 `f.get()` 才會看到 `ExecutionException`（8.17 節）。

**③ `C:false`**
`CountDownLatch(2)` 需要 `countDown()` 兩次才會歸零，只做了一次。
`await(timeout)` 超時後回傳 `false`（沒有丟例外）。

**④ `D:true,true`**
虛擬執行緒**永遠是 daemon**，而且不能改（8.14 節）。
這代表：如果 main 結束了，還在跑的虛擬執行緒會被直接砍掉——
所以一定要用 `join()` 或 try-with-resources 的 executor 等它們完成。

**⑤ `E:false,1`**
容量 1 的佇列已經有一個元素，`offer(2)` 放不進去 → 回傳 `false`（不丟例外）。
`size()` 仍是 1。如果用 `add(2)` 會丟 `IllegalStateException`（8.10 節）。

**⑥ `F:-1`**
`thenApply(n -> n / 0)` 丟出 `ArithmeticException`，被 `exceptionally` 攔下並回傳 `-1`。
注意 `exceptionally` 收到的是被包裝過的 `CompletionException`，
所以要看真正原因時得取 `getCause()`（8.12 節）。

**⑦ `G:11,10`**
`merge(key, value, remappingFn)` 的語意：
- key **存在** → 呼叫 `remappingFn(舊值, 新值)`，這裡是 `1 + 10 = 11`
- key **不存在** → 直接放入 `value`，**不呼叫函式**，所以是 `10` 而不是 `null + 10`

這是計數器的標準寫法（第 05 章 5.6 節）：`map.merge(key, 1, Integer::sum)`。

</details>

### 練習 5：併發工具選型

| # | 需求 | 你的選擇 |
|---|---|---|
| 1 | 統計每個 API 端點的呼叫次數（高併發） | ? |
| 2 | 服務啟動時，等資料庫、快取、MQ 三個都連上才開始接流量 | ? |
| 3 | 呼叫 5 個外部 API，全部成功才回傳，任一失敗就整體失敗 | ? |
| 4 | 匯入 100 萬筆資料到 MySQL（連線池只有 20 條） | ? |
| 5 | 產生全域唯一的訂單序號 | ? |
| 6 | 一個設定物件，啟動後偶爾會 reload，被大量執行緒讀取 | ? |
| 7 | 背景執行緒每 30 秒清理過期的快取 | ? |
| 8 | 一個「請求處理中的 traceId」要傳到 Service / Repository 各層 | ? |
| 9 | 圖片縮圖服務：上傳一張圖產生 5 種尺寸 | ? |
| 10 | 限制「同一個使用者每分鐘最多下 3 筆訂單」 | ? |

<details>
<summary>參考解答</summary>

| # | 選擇 | 理由 |
|---|---|---|
| 1 | **`ConcurrentHashMap<String, LongAdder>`** + `computeIfAbsent` | `LongAdder` 在高競爭下遠勝 `AtomicLong`（8.7 節）。實務上直接用 Micrometer 的 `Counter`，它內部就是這個 |
| 2 | **`CountDownLatch(3)`** | 一次性的「等 N 件事」。或者直接用 `ExecutorService.invokeAll`（它本身就會等全部完成）。Spring Boot 用 `ApplicationRunner` + 健康檢查 |
| 3 | **`CompletableFuture.allOf` + `orTimeout`**，或**虛擬執行緒 + `invokeAll`** | 前者是函式式風格；後者程式碼更直覺（8.15 節）。⚠️ 兩者都要記得處理「一個失敗時取消其他」——這是 `StructuredTaskScope` 想解決的問題 |
| 4 | **虛擬執行緒 + `Semaphore(20)`** | 匯入任務數量大（IO 密集）→ 虛擬執行緒；但下游只能承受 20 → 用 `Semaphore` 而不是「20 條執行緒的池」（8.14 節）。⚠️ 實務上更該用**批次 INSERT**（`rewriteBatchedStatements=true`），把 100 萬筆變成 1000 次批次 |
| 5 | **依需求分兩種** | 單機、可接受不連續 → `AtomicLong.incrementAndGet()`。分散式 → 雪花演算法（Snowflake）或資料庫序列。⚠️ 訂單號通常還要含日期與商戶碼，不能只是遞增數字（也不該讓人猜到「昨天有幾筆訂單」） |
| 6 | **`volatile` 欄位存不可變物件** | `private volatile Config config;` + reload 時整份替換（8.6 節）。**不要用 `ConcurrentHashMap`**——它是為併發寫入設計的，這裡幾乎不寫。讀取零成本 |
| 7 | **`ScheduledExecutorService.scheduleAtFixedRate`** | ⚠️ **任務內部一定要包 try-catch**，否則一次例外就永久停止排程（8.17 節）。實務上用 Spring 的 `@Scheduled`（一樣要包 try-catch），或 Caffeine 的自動過期（根本不需要清理執行緒） |
| 8 | **`ThreadLocal` + try-finally remove()**（Java 21）／ **`ScopedValue`**（Java 25） | 就是 SLF4J 的 `MDC`（8.13 節）。⚠️ 非同步任務裡拿不到——要用 `TaskDecorator` 複製上下文 |
| 9 | **平台執行緒池，大小 = CPU 核心數** | 影像處理是 CPU 密集，虛擬執行緒沒有幫助（8.14 節）。⚠️ 還要限制「同時處理的圖片數」，否則 5 張大圖同時解碼會 OOM |
| 10 | **Redis 的 `INCR` + `EXPIRE`** | **不能用單機限流器**——多台伺服器各自算，實際會變成「N 台 × 3 筆」。這是分散式限流，必須有共用狀態（第 05 站會實作）。單機版只適合「保護自己不要打爆下游」 |

**第 4 題值得展開，因為它是實務上最常見的錯誤組合：**

```java
// ❌ 錯誤 1：用 100 萬條虛擬執行緒直接打 DB
try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
    for (Record r : millionRecords) {
        pool.submit(() -> jdbcTemplate.update("INSERT ...", r));   // 💥 連線池瞬間耗盡
    }
}

// ❌ 錯誤 2：改成 20 條平台執行緒 —— 對了一半，但仍是 100 萬次 round-trip
try (var pool = Executors.newFixedThreadPool(20)) {
    for (Record r : millionRecords) {
        pool.submit(() -> jdbcTemplate.update("INSERT ...", r));
    }
}
// 每次 INSERT 約 1ms 網路往返 → 100 萬 / 20 × 1ms ≈ 50 秒（而且 DB 壓力很大）

// ✅ 正確：批次 + Semaphore 限制併發批次數
var semaphore = new Semaphore(20);
List<List<Record>> batches = partition(millionRecords, 1000);      // 切成 1000 筆一批

try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
    for (List<Record> batch : batches) {
        pool.submit(() -> {
            semaphore.acquire();
            try {
                jdbcTemplate.batchUpdate("INSERT ...", batch);      // 一次 1000 筆
            } finally {
                semaphore.release();
            }
        });
    }
}
// 1000 次批次 / 20 併發 × 20ms ≈ 1 秒
```

**關鍵洞見：併發不是萬靈丹。** 減少 round-trip（批次）比增加併發有效得多。
第 06 站（Repository）與第 07 站（MySQL）會深入這個主題。

</details>

---

## 8.21 驗收清單

- [ ] 我能分辨 IO 密集與 CPU 密集，並知道兩者的執行緒數該怎麼定。
- [ ] 我知道 `run()` 與 `start()` 的差別。
- [ ] 我知道 `InterruptedException` 被拋出時中斷旗標已被清除，必須恢復。
- [ ] 我能解釋 `i++` 為什麼不是原子的，也能解釋「可見性」問題。
- [ ] 我知道併發 bug 的三種型態：原子性、可見性、有序性。
- [ ] 我知道 `synchronized` 鎖的是物件，也知道不要鎖字串常值或會變的參考。
- [ ] 我不在鎖裡做 IO。
- [ ] 我能說出 `volatile` 提供什麼、不提供什麼。
- [ ] 我知道雙重檢查鎖定為什麼必須加 `volatile`，也知道有更簡單的單例寫法。
- [ ] 我知道 CAS 的原理，也知道 `LongAdder` 為什麼在高競爭下更快。
- [ ] 我能製造死鎖，也能用 `jcmd Thread.print` 找出它。
- [ ] 我知道「固定加鎖順序」是最實用的死鎖預防手段。
- [ ] 我知道 `Condition.await()` 一定要在 `while` 迴圈裡。
- [ ] 我不用 `Executors.newFixedThreadPool` / `newCachedThreadPool`，改自己 `new ThreadPoolExecutor`。
- [ ] 我知道無界佇列會讓 `maximumPoolSize` 失效並可能 OOM。
- [ ] 我知道四種拒絕策略，也知道 `CallerRunsPolicy` 提供天然背壓。
- [ ] 我有一份「優雅關閉執行緒池」的樣板。
- [ ] 我知道 `submit()` 的例外會被吞進 `Future`，一定要處理。
- [ ] 我知道 `scheduleAtFixedRate` 的任務丟例外會永久停止排程。
- [ ] 我的 `CompletableFuture.supplyAsync` 一律指定 Executor。
- [ ] 我知道 `ThreadLocal` 忘記 `remove()` 會造成跨請求資料洩漏（資安問題）。
- [ ] 我知道虛擬執行緒適合 IO 密集、不適合 CPU 密集，也知道不要池化它。
- [ ] 我知道要限制併發時用 `Semaphore`，不是用小的虛擬執行緒池。
- [ ] 我知道 Java 21~23 的釘住問題，以及 Java 24+ 已修正。
- [ ] 我知道 `ConcurrentLinkedQueue.size()` 是 O(n)。

---

完成後請前往 [09-jvm-memory-and-gc.md](./09-jvm-memory-and-gc.md)。

