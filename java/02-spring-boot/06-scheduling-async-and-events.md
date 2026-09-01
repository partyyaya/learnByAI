# 第 06 章：排程、非同步與事件

> 這三個主題放在同一章，因為它們有一個共同點：**程式碼會在「你沒預期的執行緒」上跑**。
>
> 而只要跨了執行緒，四件事會同時失效：
> - 交易（`@Transactional` 綁在 `ThreadLocal` 上）
> - MDC 與追蹤 ID（第 05 章）
> - Security 的認證資訊（`SecurityContextHolder` 也是 `ThreadLocal`）
> - request 作用域的 Bean（第 01 章 1.10）
>
> 這一章的三個主角各有一個「預設值會害到你」的陷阱：
> - **`@Scheduled` 的預設執行緒池只有 1 條**——一個任務卡住，全部排程停擺。
> - **`@Async` 的預設佇列是無上限的**——`maxPoolSize` 永遠用不到，記憶體慢慢被吃光。
> - **`@TransactionalEventListener` 在 `AFTER_COMMIT` 裡寫資料庫，預設不會被 commit**。
>
> 這三個陷阱我都見過造成線上事故。這一章會把它們講到你不可能踩到。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 用 `@Scheduled` 的四種觸發方式，並說清楚 `fixedRate` 與 `fixedDelay` 的差別。
- 寫出正確的 Spring cron 運算式（**六欄，不是五欄**），並處理時區問題。
- **說出 `@Scheduled` 預設單執行緒的後果**，並正確設定排程執行緒池。
- 處理「多實例部署造成排程重複執行」的問題，並實作一個資料庫鎖方案。
- 用 `@Async` 做非同步，並說明預設執行緒池設定為什麼危險。
- 正確設定執行緒池的四個參數，並解釋任務被拒絕時的四種策略。
- 處理 `@Async` 的例外（`void` 與 `CompletableFuture` 兩種情況完全不同）。
- 說明 `@Async` 與 `@Transactional` 一起用時會發生什麼事。
- 用虛擬執行緒【Boot 3.2+ / JDK 21】改寫執行緒池，並判斷什麼時候該用。
- 用 `ApplicationEvent` 解耦模組，並說明它與訊息佇列的界線。
- **精確使用 `@TransactionalEventListener` 的四個階段**，並解決 `AFTER_COMMIT` 裡寫資料庫的問題。
- 為排程、非同步、事件三種程式碼寫出可靠的測試。

---

## 6.2 排程：`@Scheduled`

### 開啟排程

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling                 // ★ 沒有這個，@Scheduled 完全不會執行（也不會報錯）★
public class ShopServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(ShopServiceApplication.class, args);
    }
}
```

> **「排程沒執行」的第一個檢查點就是這個註解。**
> 它跟第 05 章那個「`@Cacheable` 沒作用因為忘了 `@EnableCaching`」是同一類問題——
> 用 `/actuator/conditions` 就能看出來（第 02 章 2.8）。

### 四種觸發方式

```java
package com.example.shop.batch;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;

@Component
public class ScheduledDemo {

    private static final Logger log = LoggerFactory.getLogger(ScheduledDemo.class);

    /** ① fixedDelay：上一次「結束」後隔多久再開始 */
    @Scheduled(fixedDelay = 5000)
    public void everyFiveSecondsAfterFinish() {
        log.info("fixedDelay 任務");
    }

    /** ①' 用 ISO-8601 字串寫，可讀性更好（Spring 5.3+） */
    @Scheduled(fixedDelayString = "PT5S")
    public void withIsoDuration() { }

    /** ①'' 從設定檔讀（★ 實務上最推薦 ★） */
    @Scheduled(fixedDelayString = "${shop.batch.settlement-interval:PT10M}")
    public void fromProperty() { }

    /** ② fixedRate：上一次「開始」後隔多久再開始 */
    @Scheduled(fixedRate = 5000)
    public void everyFiveSecondsFromStart() {
        log.info("fixedRate 任務");
    }

    /** ③ initialDelay：啟動後先等一段時間（避免啟動時所有任務一起衝） */
    @Scheduled(fixedDelay = 60_000, initialDelay = 30_000)
    public void delayedStart() { }

    /** ④ cron：固定時刻 */
    @Scheduled(cron = "0 0 2 * * *", zone = "Asia/Taipei")   // 每天凌晨 2:00
    public void dailyAtTwoAm() {
        log.info("每日對帳");
    }

    /** ④' cron 也可以從設定檔讀 */
    @Scheduled(cron = "${shop.batch.report-cron:0 0 3 * * *}", zone = "Asia/Taipei")
    public void dailyReport() { }
}
```

### `fixedRate` vs `fixedDelay`：一張圖說完

假設間隔 5 秒，任務本身執行 8 秒：

```
fixedDelay = 5000（上次結束 → 等 5 秒 → 下次開始）
  0s ├──── 任務執行 8s ────┤
  8s                       ├── 等 5s ──┤
 13s                                   ├──── 任務執行 8s ────┤
  → 實際週期 = 8 + 5 = 13 秒
  → ✅ 永遠不會有兩個任務同時跑

fixedRate = 5000（上次開始 → 等 5 秒 → 下次開始）
  0s ├──── 任務執行 8s ────┤
  5s      ├──── 想在這裡開始，但單執行緒的話要排隊 ────┤
 10s           ├──── 又想開始 ────┤
  → ⚠️ 任務執行時間 > 間隔 時，會不斷累積落後
```

**選擇準則：**

| 情境 | 用什麼 |
|---|---|
| 「每 5 分鐘掃一次待處理訂單」 | **`fixedDelay`** — 不在乎精確週期，只要不重疊 |
| 「每分鐘上報一次指標」 | `fixedRate` — 要維持固定頻率 |
| 「每天凌晨 2 點對帳」 | `cron` |

> **實務建議：預設用 `fixedDelay`。**
> `fixedRate` 在任務偶爾變慢時會產生「補跑」行為，很容易造成雪崩
> （任務越慢 → 排隊越多 → 資源越吃緊 → 更慢）。

### Spring 的 cron 是六欄，不是五欄

```
┌──────────── 秒（0-59）      ★ Unix cron 沒有這一欄 ★
│ ┌────────── 分（0-59）
│ │ ┌──────── 時（0-23）
│ │ │ ┌────── 日（1-31）
│ │ │ │ ┌──── 月（1-12 或 JAN-DEC）
│ │ │ │ │ ┌── 週（0-7 或 SUN-SAT，0 與 7 都是週日）
│ │ │ │ │ │
* * * * * *
```

> ⚠️ **「週」欄位的編號是最容易抄錯的地方**：
> Spring 是 **0/7 = 週日、1 = 週一 …… 6 = 週六**，
> 而 **Quartz 是 1 = 週日、2 = 週一 …… 6 = 週五**。
> 網路上大量 cron 範例其實是 Quartz 的，**同一個 `6` 差了一天**。
> 不確定時直接用英文縮寫（`FRI`）或自己驗一次：
>
> ```java
> CronExpression.parse("0 0 12 ? * 5#3").next(LocalDateTime.now());
> // 2026-09-18T12:00（週五）—— 用 6#3 會得到 09-19（週六）
> ```

```java
"0 0 2 * * *"        每天 02:00:00
"0 */15 * * * *"     每 15 分鐘（在 0、15、30、45 分）
"0 0 9-18 * * MON-FRI"   週一到週五，9 點到 18 點的整點
"0 30 8 1 * *"       每月 1 號 08:30
"0 0 0 L * *"        每月最後一天午夜（L = last）
"0 0 12 ? * 5#3"     每月第三個週五中午（#n = 第 n 個）
"0 0 4 * * *"        每天 04:00
```

Spring 6 起支援巨集，可讀性好很多：

```java
@Scheduled(cron = "@daily")      // = "0 0 0 * * *"
@Scheduled(cron = "@hourly")     // = "0 0 * * * *"
@Scheduled(cron = "@midnight")   // = "0 0 0 * * *"
@Scheduled(cron = "@weekly")     // = "0 0 0 * * 0"
@Scheduled(cron = "@monthly")    // = "0 0 0 1 * *"
@Scheduled(cron = "@yearly")     // = "0 0 0 1 1 *"
```

### ⚠️ 時區：最容易出事的地方

```java
// ❌ 沒指定 zone → 用 JVM 的預設時區
@Scheduled(cron = "0 0 2 * * *")
public void dailySettlement() { }
```

> **真實案例**：本機開發（macOS，時區 Asia/Taipei）測試正常，
> 部署到 Docker 容器（**預設 UTC**）之後，「凌晨 2 點對帳」變成台灣時間**早上 10 點**執行。
> 對帳任務會鎖住訂單表，結果在流量最高峰時把整個下單功能卡住 20 分鐘。

**兩道防線：**

```java
// 防線 1：明確指定 zone
@Scheduled(cron = "0 0 2 * * *", zone = "Asia/Taipei")
public void dailySettlement() { }
```

```yaml
# 防線 2：明確設定 JVM 時區（Dockerfile 或啟動參數）
# -Duser.timezone=Asia/Taipei
```

```java
// 防線 3：啟動時把時區印出來，一眼確認
@Component
public class TimeZoneReporter {
    private static final Logger log = LoggerFactory.getLogger(TimeZoneReporter.class);

    @EventListener(ApplicationReadyEvent.class)
    public void report() {
        log.info("JVM 時區：{}，目前時間：{}",
                java.time.ZoneId.systemDefault(), java.time.ZonedDateTime.now());
    }
}
```

> **本課建議：資料庫用 UTC 儲存，排程用明確的 `zone` 參數，日誌用 ISO-8601 含時區。**
> 07-mysql 第 00 章會處理資料庫時區的部分。

### `@Scheduled` 方法的限制

```java
// ❌ 不能有參數
@Scheduled(fixedDelay = 5000)
public void bad(String arg) { }        // 啟動時報錯

// ❌ 回傳值會被忽略（不會報錯，但沒有意義）
@Scheduled(fixedDelay = 5000)
public String bad2() { return "..."; } // 回傳值沒人接

// ❌ 不能是 private（AOP 限制，第 04 章）
@Scheduled(fixedDelay = 5000)
private void bad3() { }

// ✅ 正確：public void，無參數
@Scheduled(fixedDelay = 5000)
public void good() { }
```

> ⚠️ 而且 **`@Scheduled` 的 Bean 一定要是單例**。
> 如果加了 `@Scope("prototype")`，Spring 只會為第一個實例註冊排程。

---

## 6.3 ★ 排程的預設執行緒池只有 1 條 ★

### 現象

```java
package com.example.shop.batch;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class ProblematicScheduler {

    private static final Logger log = LoggerFactory.getLogger(ProblematicScheduler.class);

    /** 一個很慢的任務（例如全表掃描產報表） */
    @Scheduled(fixedDelay = 60_000)
    public void slowReport() throws InterruptedException {
        log.info("報表開始");
        Thread.sleep(300_000);             // 5 分鐘
        log.info("報表結束");
    }

    /** 一個需要每 10 秒執行的任務（例如把佇列裡的通知寄出去） */
    @Scheduled(fixedDelay = 10_000)
    public void sendPendingNotifications() {
        log.info("寄送待發通知");
    }
}
```

**實際輸出：**

```
10:00:00  INFO [scheduling-1] 報表開始
10:00:00  INFO [scheduling-1] 寄送待發通知
                                      ← 接下來五分鐘完全沒有通知被寄出
10:05:00  INFO [scheduling-1] 報表結束
10:05:00  INFO [scheduling-1] 寄送待發通知
```

**注意執行緒名稱都是 `scheduling-1`——只有一條。**

> **真實案例**：某系統有 12 個排程任務，其中一個是「同步供應商商品資料」。
> 供應商 API 某天回應變得極慢（每次 40 秒逾時），這個任務跑了兩小時。
> 期間**另外 11 個排程任務全部沒有執行**——包含「檢查逾期未付款訂單並自動取消」。
> 結果那兩小時的訂單全部沒被處理，庫存被鎖住，其他客人買不到。
>
> 最諷刺的是：**監控完全正常**。服務健康、CPU 正常、記憶體正常、沒有任何 ERROR。
> 只是「有些事情沒有發生」——而「沒有發生的事」是最難監控的。

### 為什麼預設是 1

翻開 `TaskSchedulingProperties`：

```java
@ConfigurationProperties("spring.task.scheduling")
public class TaskSchedulingProperties {

    private final Pool pool = new Pool();

    public static class Pool {
        /** 最大允許的執行緒數 */
        private int size = 1;        // ★ 預設值 ★
    }
}
```

**這是刻意的保守設定**（避免使用者無意間開一堆執行緒），但它是實務上最常踩的坑之一。

### 解法 1：設定執行緒池大小

```yaml
spring:
  task:
    scheduling:
      pool:
        size: 8                          # 依排程任務數量決定，通常 4～10
      thread-name-prefix: shop-sched-
      shutdown:
        await-termination: true          # 關閉時等任務跑完
        await-termination-period: 60s
```

驗證：

```
10:00:00  INFO [shop-sched-1] 報表開始
10:00:00  INFO [shop-sched-2] 寄送待發通知      ← 不同執行緒
10:00:10  INFO [shop-sched-2] 寄送待發通知      ← 正常執行
10:00:20  INFO [shop-sched-3] 寄送待發通知
```

### 解法 2：自訂 `TaskScheduler`（要更多控制時）

```java
package com.example.shop.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import java.util.concurrent.ThreadPoolExecutor;

@Configuration
public class SchedulingConfig {

    private static final Logger log = LoggerFactory.getLogger(SchedulingConfig.class);

    @Bean
    public ThreadPoolTaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(8);
        scheduler.setThreadNamePrefix("shop-sched-");

        // 關閉時等任務完成（最多 60 秒）
        scheduler.setWaitForTasksToCompleteOnShutdown(true);
        scheduler.setAwaitTerminationSeconds(60);

        // 任務被拒絕時記錄下來（預設是靜靜丟棄）
        scheduler.setRejectedExecutionHandler((task, executor) ->
                log.error("排程任務被拒絕執行，池已滿：activeCount={} queueSize={}",
                        executor.getActiveCount(), executor.getQueue().size()));

        // 排程任務拋出的例外，預設只會 log，這裡加上更明確的處理
        scheduler.setErrorHandler(t ->
                log.error("排程任務拋出未捕捉的例外", t));

        return scheduler;
    }
}
```

> **`setErrorHandler` 很重要**：`@Scheduled` 方法拋出例外時，
> 預設行為是「記錄之後繼續下一次排程」——這是好事（不會因為一次失敗就永久停止）。
> 但預設的 log 訊息很簡略，自己設一個 handler 可以加上更多上下文。
>
> ⚠️ **例外：如果用的是 `scheduleAtFixedRate` 底層機制，未捕捉的例外會讓那個任務永久停止。**
> `@Scheduled` 有幫你包一層 `ErrorHandler`，所以不會，但**自己寫的排程程式碼要注意**。

### 解法 3：虛擬執行緒【Boot 3.2+ / JDK 21】

```yaml
spring:
  threads:
    virtual:
      enabled: true       # 排程與 @Async 都會改用虛擬執行緒
```

虛擬執行緒**沒有池的概念**——每個任務一條，數量幾乎無上限。
所以「一個任務卡住其他任務」的問題完全消失。

> ⚠️ **但不是萬靈丹**（6.7 會詳談）：
> 虛擬執行緒適合 **IO 密集**的任務。如果排程任務是 **CPU 密集**（大量計算、加解密），
> 用虛擬執行緒會讓所有任務搶同一批載體執行緒，沒有任何好處，
> 而且失去了「用池大小限制併發度」的保護。

### 每個排程任務都該有的三件事

```java
package com.example.shop.batch;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.UUID;

@Component
public class OverdueOrderCanceller {

    private static final Logger log = LoggerFactory.getLogger(OverdueOrderCanceller.class);

    private final OrderCancelService cancelService;
    private final MeterRegistry registry;

    public OverdueOrderCanceller(OrderCancelService cancelService, MeterRegistry registry) {
        this.cancelService = cancelService;
        this.registry = registry;
    }

    @Scheduled(fixedDelayString = "${shop.batch.cancel-overdue-interval:PT5M}")
    public void cancelOverdueOrders() {

        // ① 追蹤 ID：排程沒有 HTTP 請求，要自己產生（第 05 章 5.9）
        MDC.put("traceId", "sched-" + UUID.randomUUID().toString().substring(0, 12));
        MDC.put("job", "cancelOverdueOrders");

        Timer.Sample sample = Timer.start(registry);
        int cancelled = 0;
        String outcome = "SUCCESS";

        try {
            cancelled = cancelService.cancelOrdersOverdueBy(java.time.Duration.ofMinutes(30));
            log.info("逾期訂單清理完成，取消 {} 筆", cancelled);

        } catch (Exception e) {
            // ② 一定要 catch：讓例外逃出去會讓這一輪失敗（雖然下一輪還會跑，但少了上下文）
            outcome = "FAILURE";
            log.error("逾期訂單清理失敗", e);

        } finally {
            // ③ 指標：讓「任務有沒有在跑」變成可監控的事
            sample.stop(Timer.builder("shop.batch.duration")
                    .tag("job", "cancelOverdueOrders")
                    .tag("outcome", outcome)
                    .register(registry));
            registry.counter("shop.batch.processed",
                    "job", "cancelOverdueOrders").increment(cancelled);

            MDC.clear();          // ★ 排程執行緒也會被重複使用 ★
        }
    }
}
```

**對應的告警規則**（第 05 章的延伸）：

```yaml
# 排程任務超過 15 分鐘沒有執行 → 告警
- alert: ScheduledJobNotRunning
  expr: |
    time() - max(shop_batch_duration_seconds_count{job="cancelOverdueOrders"} > 0) by (job)
    > 900
  for: 5m
  annotations:
    summary: "排程任務 {{ $labels.job }} 超過 15 分鐘沒有執行"

# 排程任務失敗
- alert: ScheduledJobFailing
  expr: rate(shop_batch_duration_seconds_count{outcome="FAILURE"}[10m]) > 0
  for: 5m
```

> **「排程沒跑」是最難發現的故障類型**，因為它沒有錯誤、沒有異常流量、沒有任何症狀。
> **一定要用「上次成功執行時間」做告警**，不能只監控失敗。

### 檢視排程任務：Actuator

```bash
$ curl -s localhost:8081/actuator/scheduledtasks | jq
{
  "cron": [
    {
      "runnable": { "target": "com.example.shop.batch.DailySettlement.settle" },
      "expression": "0 0 2 * * *"
    }
  ],
  "fixedDelay": [
    {
      "runnable": { "target": "com.example.shop.batch.OverdueOrderCanceller.cancelOverdueOrders" },
      "initialDelay": 0,
      "interval": 300000
    }
  ],
  "fixedRate": [],
  "custom": []
}
```

**上線後一定要看一次這個端點**，確認排程真的註冊上去了（而且 cron 運算式是你以為的那個）。

---

## 6.4 多實例部署：排程重複執行

### 問題

```
K8s 部署了 3 個 Pod，每個都有 @Scheduled(cron = "0 0 2 * * *")
→ 凌晨 2 點，三個 Pod 同時執行對帳
→ ① 同一筆訂單被處理三次
→ ② 三份重複的對帳報表寄給財務
→ ③ 更糟的情況：庫存被扣三次、退款被執行三次
```

> **真實案例**：某公司的「自動退款」排程在擴容到 3 個實例後，
> 有 40 筆訂單被退款三次。財務追回花了兩週，還有客人不願意退還多收的錢。

### 解法對照

| 方案 | 複雜度 | 可靠性 | 適用 |
|---|---|---|---|
| 只在一個實例啟用（用 profile 或環境變數） | ⭐ 低 | ⚠️ 那個實例掛了排程就停 | 小系統、有專門的 batch 實例 |
| **資料庫鎖（ShedLock / 自己實作）** | ⭐⭐ 中 | ✅ 高 | **多數情況的正解** |
| Redis 分散式鎖 | ⭐⭐ 中 | ⚠️ 要處理鎖過期與續期 | 已有 Redis |
| 領導者選舉（K8s Lease / ZooKeeper） | ⭐⭐⭐⭐ 高 | ✅ 高 | 已有相關基礎設施 |
| 專門的排程系統（XXL-Job / Quartz 叢集 / K8s CronJob） | ⭐⭐⭐ 中高 | ✅ 高 | 排程很多、需要管理介面 |

### 方案 A：只在特定實例啟用（最簡單）

```java
@Component
@ConditionalOnProperty(name = "shop.batch.enabled", havingValue = "true")
public class DailySettlement {
    @Scheduled(cron = "0 0 2 * * *", zone = "Asia/Taipei")
    public void settle() { }
}
```

```yaml
# 一般的 API Pod
shop:
  batch:
    enabled: false

# 專門的 batch Deployment（replicas: 1）
shop:
  batch:
    enabled: true
```

> **優點**：極簡單，而且「API 與批次分離」本身就是好架構
> （批次任務不會吃掉 API 的資源）。
> **缺點**：batch Pod 掛掉時排程就停了。要配合 K8s 的自動重啟與 replicas: 1 保證。

### 方案 B：ShedLock（推薦）

```xml
<dependency>
    <groupId>net.javacrumbs.shedlock</groupId>
    <artifactId>shedlock-spring</artifactId>
    <version>5.16.0</version>
</dependency>
<dependency>
    <groupId>net.javacrumbs.shedlock</groupId>
    <artifactId>shedlock-provider-jdbc-template</artifactId>
    <version>5.16.0</version>
</dependency>
```

```sql
-- Flyway 遷移腳本（07-mysql 第 06 章會講 Flyway）
CREATE TABLE shedlock (
    name       VARCHAR(64)  NOT NULL,
    lock_until TIMESTAMP(3) NOT NULL,
    locked_at  TIMESTAMP(3) NOT NULL,
    locked_by  VARCHAR(255) NOT NULL,
    PRIMARY KEY (name)
);
```

```java
package com.example.shop.config;

import net.javacrumbs.shedlock.core.LockProvider;
import net.javacrumbs.shedlock.provider.jdbctemplate.JdbcTemplateLockProvider;
import net.javacrumbs.shedlock.spring.annotation.EnableSchedulerLock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

@Configuration
@EnableSchedulerLock(defaultLockAtMostFor = "PT30M")
public class ShedLockConfig {

    @Bean
    public LockProvider lockProvider(DataSource dataSource) {
        return new JdbcTemplateLockProvider(
                JdbcTemplateLockProvider.Configuration.builder()
                        .withJdbcTemplate(new org.springframework.jdbc.core.JdbcTemplate(dataSource))
                        .usingDbTime()          // ★ 用資料庫時間，避免各 Pod 時鐘不同步 ★
                        .build());
    }
}
```

```java
package com.example.shop.batch;

import net.javacrumbs.shedlock.spring.annotation.SchedulerLock;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class DailySettlement {

    /**
     * lockAtMostFor：最長持有鎖多久（防止 Pod 突然死掉導致鎖永遠不釋放）
     *                 → 要設得比任務最長可能執行時間長
     * lockAtLeastFor：最短持有鎖多久（防止任務執行極快時，另一個實例又搶到鎖執行一次）
     *                 → 要設得比「各 Pod 之間可能的時鐘誤差」長
     */
    @Scheduled(cron = "0 0 2 * * *", zone = "Asia/Taipei")
    @SchedulerLock(name = "dailySettlement",
                   lockAtMostFor = "PT2H",
                   lockAtLeastFor = "PT5M")
    public void settle() {
        // 只有搶到鎖的那個實例會執行到這裡
    }
}
```

> **`lockAtLeastFor` 常被忽略但很重要**：
> 假設任務只跑 2 秒就完成並釋放鎖。如果 Pod A 的時鐘比 Pod B 快 10 秒，
> Pod B 的 cron 在 10 秒後觸發時，鎖已經被釋放了 → **重複執行**。
> `lockAtLeastFor = "PT5M"` 保證鎖至少持有 5 分鐘，涵蓋時鐘誤差。
>
> ⚠️ `@SchedulerLock` 也是 AOP，所以第 04 章所有限制都適用（不能 private、不能自呼叫）。

### 方案 C：自己實作一個簡單的資料庫鎖

如果不想引入 ShedLock（例如公司對第三方依賴有嚴格審查）：

```sql
CREATE TABLE job_lock (
    job_name     VARCHAR(64)  NOT NULL PRIMARY KEY,
    locked_until TIMESTAMP(3) NOT NULL,
    locked_by    VARCHAR(128) NOT NULL,
    updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
```

```java
package com.example.shop.batch;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.function.Supplier;

/**
 * 極簡的資料庫排程鎖。
 *
 * <p>原理：用 UPDATE ... WHERE locked_until &lt; NOW() 的原子性，
 * 只有一個實例能成功更新（affected rows = 1），那個實例就取得鎖。
 *
 * <p>⚠️ 這個實作刻意保持簡單，沒有處理「鎖續期」。
 * 任務執行時間可能超過 lockDuration 時，請改用 ShedLock。
 */
@Component
public class JobLockManager {

    private static final Logger log = LoggerFactory.getLogger(JobLockManager.class);

    private final JdbcTemplate jdbcTemplate;
    private final String instanceId;

    public JobLockManager(JdbcTemplate jdbcTemplate,
                          @org.springframework.beans.factory.annotation.Value("${HOSTNAME:local}") String hostname) {
        this.jdbcTemplate = jdbcTemplate;
        this.instanceId = hostname + "-" + ProcessHandle.current().pid();
    }

    /**
     * 嘗試取得鎖並執行任務。取不到鎖就直接跳過（不阻塞）。
     *
     * @return 是否真的執行了任務
     */
    public boolean runIfLockAcquired(String jobName, Duration lockDuration, Runnable task) {
        if (!tryAcquire(jobName, lockDuration)) {
            log.debug("任務 {} 的鎖由其他實例持有，本次跳過", jobName);
            return false;
        }
        log.info("任務 {} 取得鎖（instance={}），開始執行", jobName, instanceId);
        try {
            task.run();
            return true;
        } finally {
            // 刻意「不」主動釋放鎖：靠 lockDuration 自然過期。
            // 這樣即使任務跑得很快，也不會在時鐘誤差內被另一個實例重複執行。
            log.info("任務 {} 執行完畢，鎖將於 {} 後過期", jobName, lockDuration);
        }
    }

    public <T> T callIfLockAcquired(String jobName, Duration lockDuration, Supplier<T> task, T skipped) {
        if (!tryAcquire(jobName, lockDuration)) {
            return skipped;
        }
        return task.get();
    }

    private boolean tryAcquire(String jobName, Duration lockDuration) {
        // ① 先確保有這一列（第一次執行時）
        jdbcTemplate.update("""
                INSERT INTO job_lock (job_name, locked_until, locked_by)
                VALUES (?, DATE_SUB(NOW(3), INTERVAL 1 SECOND), ?)
                ON DUPLICATE KEY UPDATE job_name = job_name
                """, jobName, instanceId);

        // ② 原子性搶鎖：只有一個實例的 UPDATE 會影響到 1 列
        int updated = jdbcTemplate.update("""
                UPDATE job_lock
                   SET locked_until = DATE_ADD(NOW(3), INTERVAL ? SECOND),
                       locked_by    = ?,
                       updated_at   = NOW(3)
                 WHERE job_name = ?
                   AND locked_until < NOW(3)
                """, lockDuration.toSeconds(), instanceId, jobName);

        return updated == 1;
    }
}
```

```java
@Component
public class DailySettlement {

    private final JobLockManager lockManager;
    private final SettlementService settlementService;

    public DailySettlement(JobLockManager lockManager, SettlementService settlementService) {
        this.lockManager = lockManager;
        this.settlementService = settlementService;
    }

    @Scheduled(cron = "0 0 2 * * *", zone = "Asia/Taipei")
    public void settle() {
        lockManager.runIfLockAcquired("dailySettlement", Duration.ofHours(2),
                settlementService::runSettlement);
    }
}
```

> **關鍵設計：用 `UPDATE ... WHERE locked_until < NOW()` 的原子性當鎖。**
> 資料庫的單一 UPDATE 是原子操作，所以三個 Pod 同時執行時，
> 只有一個的 `affected rows` 會是 1。
>
> **不主動釋放鎖**（而是靠過期）這個決定，等同於 ShedLock 的 `lockAtLeastFor`——
> 用犧牲一點「即時性」換取「絕對不重複執行」。

### 方案 D：K8s CronJob（把排程移出應用程式）

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: shop-daily-settlement
spec:
  schedule: "0 18 * * *"            # ⚠️ K8s 用 UTC，18:00 UTC = 台灣 02:00
  timeZone: "Asia/Taipei"           # K8s 1.27+ 支援，可以直接寫本地時間
  concurrencyPolicy: Forbid         # ★ 上一次還沒跑完就不要再開 ★
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: settlement
              image: shop-service:1.4.2
              args: ["--spring.profiles.active=prod,batch",
                     "--shop.batch.job=dailySettlement"]
```

搭配 `ApplicationRunner` 執行完就結束：

```java
package com.example.shop.batch;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "shop.batch.job", havingValue = "dailySettlement")
public class SettlementJobRunner implements ApplicationRunner {

    private final SettlementService service;

    public SettlementJobRunner(SettlementService service) {
        this.service = service;
    }

    @Override
    public void run(ApplicationArguments args) {
        service.runSettlement();
        // Runner 執行完，因為 profile 沒有 web，應用程式會自然結束
    }
}
```

> **這個方案的優點**：排程由 K8s 管（有重試、有歷史紀錄、有 `concurrencyPolicy`），
> 不會佔用 API Pod 的資源，而且天生就不會重複執行。
> **缺點**：每次都要冷啟動 JVM（幾秒鐘），排程很密集時不適合。

---

## 6.5 非同步：`@Async`

### 開啟與使用

```java
@SpringBootApplication
@EnableAsync                      // ★ 沒有這個 @Async 不會生效 ★
public class ShopServiceApplication { }
```

```java
package com.example.shop.notification;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletableFuture;

@Service
public class NotificationService {

    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);

    /** ① void：射後不理 */
    @Async
    public void sendEmailAsync(String to, String subject, String body) {
        log.info("寄信給 {}", to);
        // ...
    }

    /** ② CompletableFuture：需要結果或需要知道有沒有失敗 */
    @Async
    public CompletableFuture<Boolean> sendEmailWithResult(String to, String body) {
        boolean success = doSend(to, body);
        return CompletableFuture.completedFuture(success);
    }

    /** ③ 指定執行緒池（不同性質的任務要用不同池，見 6.6）*/
    @Async("notificationExecutor")
    public void sendWithDedicatedPool(String to, String body) { }

    private boolean doSend(String to, String body) { return true; }
}
```

### `@Async` 的限制（全部來自第 04 章的 AOP）

```java
@Service
public class BadAsyncService {

    // ❌ private：CGLIB 無法覆寫
    @Async
    private void bad1() { }

    // ❌ final：無法覆寫
    @Async
    public final void bad2() { }

    // ❌ 自呼叫：不經過代理
    public void caller() {
        this.bad3();       // 同步執行！
    }
    @Async
    public void bad3() { }

    // ⚠️ 回傳 Future 以外的值：值永遠是 null 或 0（因為方法還沒執行完就回傳了）
    @Async
    public String bad4() { return "hello"; }    // 呼叫端拿到 null
}
```

> **最後那一項特別陰險**：程式不會報錯，你就是拿到 `null`。
> **`@Async` 方法的回傳型別只能是 `void`、`Future`、`CompletableFuture`。**

### ★ 例外處理：兩種情況完全不同 ★

#### 情況 A：回傳 `void` → 例外會**完全消失**

```java
@Async
public void sendEmailAsync(String to) {
    throw new RuntimeException("SMTP 連不上");     // 呼叫端完全不知道
}
```

呼叫端：

```java
notificationService.sendEmailAsync("a@b.com");     // 立刻返回，沒有任何例外
// 郵件沒寄出，而且沒有人知道
```

**Spring 預設會用 `SimpleAsyncUncaughtExceptionHandler` 記一行 ERROR**，
但如果你的日誌等級或告警沒設好，這件事就完全靜默了。

**解法：自訂 `AsyncUncaughtExceptionHandler`**

```java
package com.example.shop.config;

import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.aop.interceptor.AsyncUncaughtExceptionHandler;
import org.springframework.stereotype.Component;

import java.lang.reflect.Method;
import java.util.Arrays;

@Component
public class LoggingAsyncExceptionHandler implements AsyncUncaughtExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(LoggingAsyncExceptionHandler.class);

    private final MeterRegistry registry;

    public LoggingAsyncExceptionHandler(MeterRegistry registry) {
        this.registry = registry;
    }

    @Override
    public void handleUncaughtException(Throwable ex, Method method, Object... params) {
        // ★ 加上指標，讓「非同步任務失敗」可以被告警 ★
        registry.counter("shop.async.error",
                "method", method.getDeclaringClass().getSimpleName() + "." + method.getName(),
                "exception", ex.getClass().getSimpleName()).increment();

        log.error("非同步方法 {}.{} 拋出未捕捉的例外，參數：{}",
                method.getDeclaringClass().getSimpleName(),
                method.getName(),
                Arrays.toString(params),      // ⚠️ 參數可能含敏感資料，正式環境要評估
                ex);
    }
}
```

```java
package com.example.shop.config;

import org.springframework.aop.interceptor.AsyncUncaughtExceptionHandler;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.AsyncConfigurer;
import org.springframework.scheduling.annotation.EnableAsync;

import java.util.concurrent.Executor;

@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    private final Executor taskExecutor;
    private final AsyncUncaughtExceptionHandler exceptionHandler;

    public AsyncConfig(Executor taskExecutor, AsyncUncaughtExceptionHandler exceptionHandler) {
        this.taskExecutor = taskExecutor;
        this.exceptionHandler = exceptionHandler;
    }

    @Override
    public Executor getAsyncExecutor() {
        return taskExecutor;
    }

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return exceptionHandler;      // ★ 只對 void 方法生效 ★
    }
}
```

#### 情況 B：回傳 `CompletableFuture` → 例外包在 Future 裡

```java
@Async
public CompletableFuture<Boolean> sendWithResult(String to) {
    throw new RuntimeException("SMTP 連不上");
}
```

```java
CompletableFuture<Boolean> future = service.sendWithResult("a@b.com");

// ① 阻塞等待 → 拋出 ExecutionException（原始例外包在 getCause()）
try {
    future.get(5, TimeUnit.SECONDS);
} catch (ExecutionException e) {
    log.error("失敗", e.getCause());     // ★ 注意是 getCause() ★
} catch (TimeoutException e) {
    log.error("逾時");
}

// ② 非阻塞處理（推薦）
future.whenComplete((result, error) -> {
    if (error != null) {
        log.error("寄信失敗", error);
    } else {
        log.info("寄信結果：{}", result);
    }
});

// ③ 提供備援值
future.exceptionally(error -> {
    log.error("寄信失敗，改用備援管道", error);
    return false;
}).thenAccept(result -> log.info("最終結果：{}", result));
```

> ⚠️ **`AsyncUncaughtExceptionHandler` 對 `CompletableFuture` 方法沒有作用。**
> 這是最容易搞錯的一點：以為設了 handler 就萬無一失，
> 結果 `CompletableFuture` 的例外被吞掉（因為沒有人呼叫 `get()` 或 `whenComplete()`）。
>
> **規則：只要回傳 `CompletableFuture`，呼叫端就有責任處理它。**

### `@Async` 與 `@Transactional`

```java
@Service
public class OrderService {

    @Transactional
    public void placeOrder(Order order) {
        repository.save(order);                       // 交易 T1
        notificationService.sendAsync(order);         // ★ 新執行緒，沒有 T1 的交易上下文 ★
        // 如果後面拋例外，T1 rollback → 訂單沒建立
        // 但通知已經寄出去了！
        validateSomething();      // 這裡失敗
    }
}
```

```java
@Service
public class NotificationService {

    @Async
    @Transactional            // ← 這會開一個「全新的」交易 T2，與 T1 完全無關
    public void sendAsync(Order order) {
        // 這裡讀 order 可能讀不到（T1 還沒 commit，而 T2 看不到 T1 的未提交資料）
        Order fresh = repository.findById(order.id()).orElseThrow();   // 💥 找不到！
    }
}
```

**兩個問題：**

1. **交易不會傳遞**——新執行緒是全新的交易上下文。
2. **時序問題**——非同步任務可能在外層交易 commit **之前**就執行，讀不到剛寫入的資料。

> **真實案例**：某系統「訂單成立後非同步寄確認信」。
> 寄信的方法會去資料庫查訂單明細——但因為非同步任務跑得比外層 commit 快，
> 大約 3% 的情況查不到訂單，寄出「找不到訂單」的錯誤信給客人。
>
> 而且這個 bug **在開發環境幾乎重現不出來**（資料量小、commit 很快）。

**解法：用 `@TransactionalEventListener(AFTER_COMMIT)`**（6.9 會詳談）。

---

## 6.6 ★ 執行緒池設定：預設值的陷阱 ★

### Spring Boot 的預設執行緒池

翻開 `TaskExecutionProperties`：

```java
@ConfigurationProperties("spring.task.execution")
public class TaskExecutionProperties {

    public static class Pool {
        /** 佇列容量 */
        private int queueCapacity = Integer.MAX_VALUE;     // ★★ 無上限 ★★
        /** 核心執行緒數 */
        private int coreSize = 8;
        /** 最大執行緒數 */
        private Integer maxSize = Integer.MAX_VALUE;        // ★★ 無上限 ★★
        private boolean allowCoreThreadTimeout = true;
        private Duration keepAlive = Duration.ofSeconds(60);
    }
}
```

### 為什麼「佇列無上限」是個大問題

先理解 `ThreadPoolExecutor` 的工作流程：

```
提交一個任務
    │
    ├─ 目前執行緒數 < corePoolSize？
    │     └─ 是 → 建立新執行緒執行 ✅
    │
    ├─ 佇列還有空間？
    │     └─ 是 → 放進佇列等待 ✅
    │
    ├─ 目前執行緒數 < maxPoolSize？
    │     └─ 是 → 建立新執行緒執行 ✅
    │
    └─ 都不行 → 執行拒絕策略（RejectedExecutionHandler）
```

**關鍵：「佇列滿了」才會擴充到 `maxPoolSize`。**

所以當 `queueCapacity = Integer.MAX_VALUE`：

```
佇列永遠不會滿
  → 永遠不會擴充到 maxPoolSize
  → 實際上永遠只有 8 條執行緒（coreSize）
  → maxSize = Integer.MAX_VALUE 這個設定完全沒有意義
  → 而任務會無止盡地堆積在佇列裡
```

**後果：**

```
① 任務堆積不會有任何警訊（沒有拒絕、沒有例外）
② 佇列裡的每個任務物件都持有參照 → 記憶體慢慢被吃光 → OOM
③ 使用者按下「送出」，任務排在第 50 萬個 → 兩小時後才執行
④ 服務重啟時，佇列裡的任務全部消失（記憶體佇列不持久）
```

> **真實案例**：某系統用 `@Async` 寄送推播通知。
> 推播供應商某天故障，每次呼叫都卡 30 秒才逾時。
> 8 條執行緒 × 30 秒 = 每分鐘只能處理 16 個任務，但每分鐘進來 2000 個。
>
> 兩小時後：佇列裡有 20 萬個任務，堆積 3.2 GB，Pod 被 OOMKilled。
> 重啟後佇列清空（20 萬個通知永久遺失），然後又開始堆積。
> **而在 OOM 之前，所有監控指標都是正常的**——沒有錯誤、CPU 正常、回應時間正常。

### 正確的設定

```yaml
spring:
  task:
    execution:
      pool:
        core-size: 8
        max-size: 32
        queue-capacity: 200            # ★ 一定要設有限值 ★
        keep-alive: 60s
        allow-core-thread-timeout: true
      thread-name-prefix: shop-async-
      shutdown:
        await-termination: true
        await-termination-period: 30s
```

### 四個參數怎麼算

```
① core-size（核心執行緒數）
   CPU 密集型：CPU 核心數 + 1
   IO 密集型： CPU 核心數 × (1 + 等待時間 / 計算時間)

   例：4 核心，任務 90% 時間在等 IO
       4 × (1 + 9) = 40  ← 但實務上會保守一點

② max-size（最大執行緒數）
   通常是 core-size 的 2～4 倍
   ⚠️ 每條平台執行緒約佔 1 MB 堆疊記憶體，1000 條 = 1 GB

③ queue-capacity（佇列容量）
   關鍵問題：「我願意讓一個任務等多久？」

   可接受延遲 = queue-capacity / 每秒處理能力

   例：8 條執行緒，每個任務 200ms → 每秒處理 40 個
       佇列 200 個 → 最壞情況等 5 秒  ← 可接受
       佇列 10000 個 → 最壞情況等 250 秒 ← 不可接受

④ 拒絕策略（超過容量時怎麼辦）
```

### 四種拒絕策略

```java
package com.example.shop.config;

import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.task.ThreadPoolTaskExecutorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.time.Duration;
import java.util.concurrent.ThreadPoolExecutor;

@Configuration
public class ExecutorConfig {

    private static final Logger log = LoggerFactory.getLogger(ExecutorConfig.class);

    @Bean("notificationExecutor")
    public ThreadPoolTaskExecutor notificationExecutor(ThreadPoolTaskExecutorBuilder builder,
                                                      MeterRegistry registry) {
        ThreadPoolTaskExecutor executor = builder
                .corePoolSize(8)
                .maxPoolSize(32)
                .queueCapacity(200)
                .keepAlive(Duration.ofSeconds(60))
                .threadNamePrefix("shop-notify-")
                .awaitTermination(true)
                .awaitTerminationPeriod(Duration.ofSeconds(30))
                .taskDecorator(new com.example.shop.observability.MdcTaskDecorator())
                .build();

        // ★ 拒絕策略：記錄 + 指標，而不是靜靜丟棄 ★
        executor.setRejectedExecutionHandler((task, exec) -> {
            registry.counter("shop.async.rejected", "executor", "notification").increment();
            log.error("通知任務被拒絕：activeCount={} poolSize={} queueSize={}",
                    exec.getActiveCount(), exec.getPoolSize(), exec.getQueue().size());
            // 這裡可以選擇：丟棄 / 存進資料庫稍後重試 / 同步執行
            throw new java.util.concurrent.RejectedExecutionException("通知佇列已滿");
        });

        return executor;
    }
}
```

| 策略 | 行為 | 適用 |
|---|---|---|
| `AbortPolicy`（**JDK 預設**） | 拋 `RejectedExecutionException` | 呼叫端需要知道失敗 |
| `CallerRunsPolicy`（**Spring 預設**） | **在呼叫端的執行緒執行** | 形成天然的背壓（back pressure） |
| `DiscardPolicy` | 靜靜丟棄 | ❌ 幾乎不該用 |
| `DiscardOldestPolicy` | 丟棄佇列最舊的 | 只要最新資料（例如即時報價） |

> **`CallerRunsPolicy` 是 Spring 的預設值，而且通常是好選擇**：
> 佇列滿時，任務會在「提交任務的執行緒」執行——也就是 Tomcat 的請求執行緒。
> 這會讓 API 變慢，**而變慢會自然地讓上游減少請求速率**。這叫背壓。
>
> ⚠️ 但它也有風險：如果那個任務會卡住 30 秒，Tomcat 執行緒就被佔用 30 秒。
> 併發高的時候，200 條 Tomcat 執行緒全部被佔用 → **整個 API 停止回應**。
>
> **判斷準則**：
> - 任務很快（< 100ms）→ `CallerRunsPolicy` 很好。
> - 任務可能很慢或會呼叫外部服務 → 用 `AbortPolicy` 加上明確的錯誤處理。

### 為不同性質的任務用不同的池（**重要**）

```java
package com.example.shop.config;

import org.springframework.boot.task.ThreadPoolTaskExecutorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.time.Duration;

@Configuration
public class MultiExecutorConfig {

    /** 通知：IO 密集、可容忍延遲、量大 */
    @Bean("notificationExecutor")
    public ThreadPoolTaskExecutor notificationExecutor(ThreadPoolTaskExecutorBuilder builder) {
        return builder.corePoolSize(8).maxPoolSize(32).queueCapacity(500)
                .threadNamePrefix("notify-").build();
    }

    /** 報表產生：CPU 密集、慢、量少 */
    @Bean("reportExecutor")
    public ThreadPoolTaskExecutor reportExecutor(ThreadPoolTaskExecutorBuilder builder) {
        return builder.corePoolSize(2).maxPoolSize(4).queueCapacity(20)
                .threadNamePrefix("report-").build();
    }

    /** 外部 API 呼叫：IO 密集、有逾時、要限制併發避免打爆對方 */
    @Bean("externalApiExecutor")
    public ThreadPoolTaskExecutor externalApiExecutor(ThreadPoolTaskExecutorBuilder builder) {
        return builder.corePoolSize(4).maxPoolSize(8).queueCapacity(50)
                .threadNamePrefix("ext-api-")
                .awaitTermination(true).awaitTerminationPeriod(Duration.ofSeconds(20))
                .build();
    }

    /** 預設池（沒指定名稱的 @Async 會用這個） */
    @Bean("applicationTaskExecutor")
    @Primary
    public ThreadPoolTaskExecutor applicationTaskExecutor(ThreadPoolTaskExecutorBuilder builder) {
        return builder.corePoolSize(4).maxPoolSize(16).queueCapacity(100)
                .threadNamePrefix("app-async-").build();
    }
}
```

```java
@Async("notificationExecutor")   public void sendEmail() { }
@Async("reportExecutor")         public void generateReport() { }
@Async("externalApiExecutor")    public void callSupplierApi() { }
```

> **為什麼要隔離？** 這叫 **bulkhead pattern（艙壁模式）**。
>
> 如果全部共用一個池：報表產生（每次 5 分鐘）把 8 條執行緒全佔滿
> → 通知完全卡住 → 使用者收不到訂單確認信。
>
> **隔離之後，報表慢只會影響報表。**

### 監控執行緒池（一定要做）

Spring Boot 會自動為 `ThreadPoolTaskExecutor` 註冊 Micrometer 指標
（前提是它是一個 Bean 且有 `MeterRegistry`）：

```bash
$ curl -s localhost:8081/actuator/prometheus | grep executor_
executor_active_threads{name="notify-",...} 6.0
executor_pool_size_threads{name="notify-",...} 8.0
executor_pool_max_threads{name="notify-",...} 32.0
executor_queued_tasks{name="notify-",...} 143.0        ← ★ 最重要的一個 ★
executor_queue_remaining_tasks{name="notify-",...} 357.0
executor_completed_tasks_total{name="notify-",...} 92831.0
executor_rejected_tasks_total{name="notify-",...} 0.0  ← ★ 第二重要 ★
```

```yaml
# 告警規則
- alert: AsyncQueueBacklog
  expr: |
    executor_queued_tasks{name="notify-"}
    / (executor_queued_tasks{name="notify-"} + executor_queue_remaining_tasks{name="notify-"})
    > 0.7
  for: 5m
  annotations:
    summary: "通知佇列使用率超過 70%，任務可能開始延遲"

- alert: AsyncTaskRejected
  expr: rate(executor_rejected_tasks_total[5m]) > 0
  for: 2m
  labels: { severity: critical }
  annotations:
    summary: "非同步任務被拒絕，有工作被丟棄"
```

---

## 6.7 虛擬執行緒【Boot 3.2+ / JDK 21】

### 一行設定開啟

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

**這一行會改變什麼：**

| 元件 | 原本 | 開啟後 |
|---|---|---|
| Tomcat 請求處理 | 200 條平台執行緒的池 | 每個請求一條虛擬執行緒 |
| `@Async` | `ThreadPoolTaskExecutor` | `SimpleAsyncTaskExecutor` + 虛擬執行緒 |
| `@Scheduled` | `ThreadPoolTaskScheduler`（池） | `SimpleAsyncTaskScheduler` + 虛擬執行緒 |

### 為什麼虛擬執行緒對 IO 密集有效

```
平台執行緒（傳統）
  一條 Java 執行緒 = 一條 OS 執行緒
  約 1 MB 堆疊記憶體
  阻塞在 IO 時，整條 OS 執行緒被浪費
  → 所以要用「池」限制數量（200 條就是上限）

虛擬執行緒（JDK 21）
  數千條虛擬執行緒共用少數「載體執行緒」（通常 = CPU 核心數）
  約 幾百 bytes 記憶體
  ★ 阻塞在 IO 時，虛擬執行緒會從載體執行緒「卸載」，載體去跑別的虛擬執行緒 ★
  → 可以同時有數十萬條
```

```
情境：一個 API 要呼叫三個外部服務，每個 200ms

平台執行緒（200 條池）：
  最大併發 = 200 個請求
  第 201 個請求要排隊

虛擬執行緒：
  最大併發 = 數萬個請求（受限於外部服務與記憶體，不是執行緒數）
```

### ⚠️ 什麼時候**不該**用

| 情況 | 原因 |
|---|---|
| **CPU 密集任務** | 虛擬執行緒不會增加 CPU 核心數。所有虛擬執行緒搶同一批載體執行緒，反而增加調度成本 |
| **需要限制併發度** | 虛擬執行緒沒有池，失去「用池大小保護下游」的能力。1 萬個虛擬執行緒同時打資料庫 = 連線池瞬間耗盡 |
| **有 `synchronized` 保護的長時間阻塞** | JDK 21 的 `synchronized` 內阻塞會 **pin** 住載體執行緒（JDK 24 已改善） |
| **大量使用 `ThreadLocal` 且值很大** | 每條虛擬執行緒一份，數萬條就會吃很多記憶體 |
| **依賴執行緒池做背壓** | 沒有佇列滿的概念，任務會無限制地被建立 |

> **最重要的一點：虛擬執行緒不會讓你的下游變快。**
>
> 如果資料庫連線池只有 20 條，開了虛擬執行緒之後 1 萬個請求同時進來，
> 結果是 **9980 個請求在等連線**——問題從「請求在 Tomcat 排隊」變成「請求在連線池排隊」，
> 而且後者更難監控。
>
> **開虛擬執行緒之前，先確認下游（資料庫、外部 API）的容量夠不夠。**

### 明確用虛擬執行緒但保留併發限制

```java
package com.example.shop.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.AsyncTaskExecutor;
import org.springframework.core.task.support.TaskExecutorAdapter;

import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

@Configuration
public class VirtualThreadConfig {

    /**
     * 虛擬執行緒 + Semaphore 限流。
     *
     * <p>兼顧兩件事：
     * ① 虛擬執行緒的低成本（不用維護池）
     * ② 併發度上限（保護下游）
     */
    @Bean("limitedVirtualExecutor")
    public AsyncTaskExecutor limitedVirtualExecutor() {
        Semaphore semaphore = new Semaphore(50);      // 最多 50 個同時執行

        return new TaskExecutorAdapter(
                Executors.newVirtualThreadPerTaskExecutor()) {
            @Override
            public void execute(Runnable task) {
                super.execute(() -> {
                    try {
                        semaphore.acquire();
                        task.run();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } finally {
                        semaphore.release();
                    }
                });
            }
        };
    }
}
```

> 01-java-core 第 08 章有虛擬執行緒的完整原理與 `Semaphore` 用法，可以對照閱讀。

### 遷移建議

```
階段 1：先確認 JDK 21，並且沒有大量 synchronized 的阻塞區塊
階段 2：在 staging 開啟 spring.threads.virtual.enabled=true，做壓測對照
階段 3：確認資料庫連線池、外部 API 的容量足夠，並補上限流
階段 4：正式環境開啟，密切監控連線池等待時間與下游錯誤率
```

---

## 6.8 應用程式事件：`ApplicationEvent`

### 為什麼需要事件

回顧第 01 章 1.13 的循環依賴問題：

```java
// 訂單成立後要做五件事
@Service
public class OrderService {

    private final OrderRepository repository;
    private final NotificationService notificationService;      // 寄信
    private final InventoryService inventoryService;            // 扣庫存
    private final PointService pointService;                    // 給紅利點數
    private final InvoiceService invoiceService;                // 開發票
    private final RecommendationService recommendationService;  // 更新推薦模型
    private final AnalyticsService analyticsService;            // 上報數據

    public void placeOrder(Order order) {
        repository.save(order);
        notificationService.sendConfirmation(order);
        inventoryService.decrease(order);
        pointService.award(order);
        invoiceService.issue(order);
        recommendationService.update(order);
        analyticsService.track(order);
    }
}
```

**問題：**

| 問題 | 說明 |
|---|---|
| 依賴爆炸 | 7 個依賴，而且每加一個新需求就多一個 |
| 職責混亂 | `OrderService` 知道「訂單成立後全世界要做什麼」 |
| 容易循環依賴 | `PointService` 可能也需要查訂單 |
| 難測試 | 測「訂單成立」要 mock 六個服務 |
| 錯誤傳播 | 推薦模型更新失敗，整筆訂單 rollback（合理嗎？） |

### 用事件重寫

> 📌 **本章的 `Order` 比第 01 章 1.16 多了一個欄位、換掉一個欄位**，
> 因為「事件」對資料的要求跟「Service 內部傳遞」不一樣：
>
> ```java
> public record Order(Long id,
>                     String customerId,      // ★ 從 customerName 換成 customerId ★
>                     BigDecimal amount,
>                     String paymentMethod,
>                     String status,
>                     Instant createdAt) {
>
>     public Order withId(Long newId) { /* 同 1.16 */ }
>     public Order withStatus(String newStatus) { /* 同 1.16 */ }
> }
> ```
>
> **為什麼要換**：事件會被**別的模組**消費（給點數、開發票、更新索引），
> 而顯示用的名字是會變的（客戶改名、同名同姓），**識別碼才是穩定的**。
> 「事件裡放 name 而不是 id」是實務上常見的錯誤 ——
> 三個月後有人要用這個事件去查客戶資料，就會發現查不到。
>
> 需要名字的監聽者（例如寄信）應該**自己用 `customerId` 去查**，
> 或由發布方在事件裡另外帶一份「當下的快照」並明確標示它是快照。

```java
package com.example.shop.order;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * 訂單成立事件。
 *
 * <p>Spring 4.2+ 事件不需要繼承 ApplicationEvent，任何物件都可以。
 * 用 record 表示不可變事件是最好的選擇。
 *
 * <p>★ 設計要點：事件應該帶「足夠的資訊」，讓監聽者不需要再查資料庫。
 * 但也不要帶整個 Entity（會造成延遲載入問題與序列化困難）。
 */
public record OrderPlacedEvent(
        long orderId,
        String customerId,
        BigDecimal amount,
        String paymentMethod,
        Instant occurredAt) {

    public static OrderPlacedEvent from(Order order) {
        return new OrderPlacedEvent(
                order.id(), order.customerId(), order.amount(),
                order.paymentMethod(), Instant.now());
    }
}
```

```java
package com.example.shop.order;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {

    private final OrderRepository repository;
    private final ApplicationEventPublisher publisher;    // ★ 只剩兩個依賴 ★

    public OrderService(OrderRepository repository, ApplicationEventPublisher publisher) {
        this.repository = repository;
        this.publisher = publisher;
    }

    @Transactional
    public Order placeOrder(Order order) {
        Order saved = repository.save(order);
        publisher.publishEvent(OrderPlacedEvent.from(saved));
        return saved;
    }
}
```

```java
package com.example.shop.notification;

import com.example.shop.order.OrderPlacedEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
public class OrderNotificationListener {

    private static final Logger log = LoggerFactory.getLogger(OrderNotificationListener.class);

    private final NotificationService notificationService;

    public OrderNotificationListener(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    @EventListener
    @Order(10)
    public void onOrderPlaced(OrderPlacedEvent event) {
        log.info("寄送訂單 {} 的確認信", event.orderId());
        notificationService.sendConfirmation(event.customerId(), event.orderId());
    }
}
```

**依賴方向反轉了：**

```
❌ 之前：OrderService ──▶ NotificationService / PointService / ...

✅ 之後：OrderService ──▶ OrderPlacedEvent ◀── NotificationListener
                                          ◀── PointListener
                                          ◀── InvoiceListener
```

**新增需求時，`OrderService` 一個字都不用改**——只要新增一個 Listener。

### `@EventListener` 的進階用法

```java
package com.example.shop.order;

import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class EventListenerFeatures {

    /** ① 條件式監聽（SpEL） */
    @EventListener(condition = "#event.amount > 10000")
    public void onLargeOrder(OrderPlacedEvent event) {
        // 只有大額訂單才觸發（例如通知業務、加強風控）
    }

    /** ② 監聽多種事件 */
    @EventListener({OrderPlacedEvent.class, OrderCancelledEvent.class})
    public void onAnyOrderChange(Object event) { }

    /** ③ 監聽者可以「回傳新事件」，形成事件鏈 */
    @EventListener
    public OrderAuditEvent onOrderPlaced(OrderPlacedEvent event) {
        return new OrderAuditEvent(event.orderId(), "PLACED");    // 自動被發布
    }

    /** ④ 回傳集合 → 發布多個事件 */
    @EventListener
    public List<Object> onOrderPlacedMultiple(OrderPlacedEvent event) {
        return List.of(
                new OrderAuditEvent(event.orderId(), "PLACED"),
                new AnalyticsEvent("order_placed", event.amount()));
    }

    public record OrderCancelledEvent(long orderId, String reason) { }
    public record OrderAuditEvent(long orderId, String action) { }
    public record AnalyticsEvent(String name, java.math.BigDecimal value) { }
}
```

### 同步 vs 非同步

**`@EventListener` 預設是同步的**——在發布事件的同一個執行緒執行。

```java
publisher.publishEvent(event);
// ↑ 這一行會「等所有監聽者都執行完」才返回
```

這意味著：

```java
@Transactional
public Order placeOrder(Order order) {
    Order saved = repository.save(order);
    publisher.publishEvent(OrderPlacedEvent.from(saved));
    // ★ 監聽者也在同一個交易裡 ★
    // ★ 監聽者拋例外 → 整筆訂單 rollback ★
    return saved;
}
```

**這有好有壞：**

| | 同步（預設） | 非同步（`@Async`） |
|---|---|---|
| 交易 | 在同一個交易裡 | 不在（新執行緒） |
| 監聽者失敗 | 整筆 rollback | 主流程不受影響 |
| 效能 | 主流程要等 | 主流程立刻返回 |
| 適用 | 「必須成功」的事（扣庫存） | 「可以失敗」的事（寄信、上報） |

```java
@Component
public class AsyncAnalyticsListener {

    /** 非同步：資料上報失敗不該影響下單 */
    @Async
    @EventListener
    public void onOrderPlaced(OrderPlacedEvent event) {
        analyticsClient.track(event);
    }
}
```

> ⚠️ **`@Async` + `@EventListener` 會遺失 MDC**（第 05 章 5.9）。
> 記得用 `TaskDecorator`。

### 事件 vs 訊息佇列：界線在哪

| | `ApplicationEvent` | 訊息佇列（Kafka / RabbitMQ） |
|---|---|---|
| 範圍 | **同一個 JVM 內** | 跨服務、跨機器 |
| 持久性 | ❌ 服務重啟就消失 | ✅ 持久化 |
| 重試 | 要自己做 | 內建 |
| 順序保證 | 靠 `@Order`（同一執行緒） | 靠 partition |
| 延遲 | 微秒級 | 毫秒級 |
| 複雜度 | 零（框架內建） | 要維護一套基礎設施 |

> **判斷準則：**
>
> - **同一個服務內的模組解耦** → `ApplicationEvent`。
> - **跨服務通訊、需要可靠投遞** → 訊息佇列。
>
> **最重要的警告：不要用 `ApplicationEvent` 做「不能遺失」的事。**
> 服務在監聽者執行前被 `kill -9`，那個事件就永遠消失了。
>
> 「訂單成立要開發票」這種**不能遺失**的需求，正確做法是：
> 1. 在同一個交易裡寫一筆 `outbox` 記錄（transactional outbox 模式）。
> 2. 用排程或 CDC 讀 outbox 送到訊息佇列。
>
> 這樣「訂單」與「待開發票」是同一個交易，不可能只成功一半。

---

## 6.9 ★ `@TransactionalEventListener` ★

### 問題：同步監聽者在交易裡，讀不到「未 commit」的資料

```java
@Service
public class OrderService {

    @Transactional
    public Order placeOrder(Order order) {
        Order saved = repository.save(order);          // 還沒 commit！
        publisher.publishEvent(OrderPlacedEvent.from(saved));
        return saved;
    }
}
```

```java
@Component
public class BadListener {

    @Async
    @EventListener
    public void onOrderPlaced(OrderPlacedEvent event) {
        // ★ 新執行緒，看不到還沒 commit 的資料 ★
        Order order = repository.findById(event.orderId())
                .orElseThrow();      // 💥 EmptyResultDataAccessException
    }
}
```

還有更糟的情況：

```java
@Transactional
public Order placeOrder(Order order) {
    Order saved = repository.save(order);
    publisher.publishEvent(OrderPlacedEvent.from(saved));   // 監聽者寄了信
    validateRiskControl(saved);                              // 這裡拋例外 → rollback
    return saved;
}
// 結果：訂單不存在，但客人收到了「訂單成立」的信
```

### 解法：`@TransactionalEventListener`

```java
package com.example.shop.notification;

import com.example.shop.order.OrderPlacedEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class OrderNotificationListener {

    private static final Logger log = LoggerFactory.getLogger(OrderNotificationListener.class);

    private final NotificationService notificationService;

    public OrderNotificationListener(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    /** ★ 只在交易成功 commit 之後才執行 ★ */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onOrderPlaced(OrderPlacedEvent event) {
        log.info("訂單 {} 已確認 commit，寄送確認信", event.orderId());
        notificationService.sendConfirmation(event.customerId(), event.orderId());
    }
}
```

### 四個階段

```java
@TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)      // ★ 預設值 ★
@TransactionalEventListener(phase = TransactionPhase.AFTER_ROLLBACK)
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMPLETION)  // commit 或 rollback 都執行
```

```
交易生命週期：

  begin
    │
    ├─ 業務邏輯（save / update）
    ├─ publishEvent(...)   ← 事件被「暫存」，還沒送給 TransactionalEventListener
    │
    ├─ BEFORE_COMMIT      ← ★ 還在交易裡，這裡寫資料庫會一起 commit ★
    │
    ├─ commit（或 rollback）
    │
    ├─ AFTER_COMMIT       ← ★ 交易已結束，這裡寫資料庫不會被 commit（見下方）★
    │  或 AFTER_ROLLBACK
    │
    └─ AFTER_COMPLETION
```

### 各階段的用途

| 階段 | 用途 | 注意 |
|---|---|---|
| `BEFORE_COMMIT` | 需要「跟主交易一起成功或失敗」的資料庫寫入 | 這裡拋例外會讓主交易 rollback |
| **`AFTER_COMMIT`** | **外部副作用**：寄信、發推播、呼叫外部 API、送訊息佇列 | 資料已確定存在，安全 |
| `AFTER_ROLLBACK` | 補償動作、記錄失敗 | 主交易已 rollback |
| `AFTER_COMPLETION` | 資源清理 | 用 `TransactionSynchronization.STATUS_*` 判斷結果 |

### ★★ 陷阱 1：`AFTER_COMMIT` 裡寫資料庫「不會被 commit」★★

**這是最容易踩、最難查的坑。**

```java
@Component
public class BadAuditListener {

    private final AuditRepository auditRepository;

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onOrderPlaced(OrderPlacedEvent event) {
        // ⚠️ 這一行「執行了」，但資料不會出現在資料庫裡！
        auditRepository.save(new AuditLog(event.orderId(), "ORDER_PLACED"));
    }
}
```

**為什麼：**

```
AFTER_COMMIT 是在「原交易已 commit 但還沒清理」的階段執行。
此時 Spring 的交易同步機制仍然是「啟動中」，
所以這裡的資料庫操作會加入「那個已經 commit 的交易」——
而它已經 commit 了，不會再 commit 一次。

結果：SQL 執行了，但沒有 commit → 連線歸還時被 rollback → 資料消失。
而且完全沒有錯誤訊息。
```

> **真實案例**：某團隊用 `AFTER_COMMIT` 寫稽核紀錄，測試環境「看起來正常」
> （因為測試用了 `@Transactional` 加上手動 flush 的斷言方式）。
> 上線三週後有人問「為什麼稽核表是空的」——三週的稽核紀錄全部沒有寫進去。

**解法：明確開一個新交易**

```java
package com.example.shop.audit;

import com.example.shop.order.OrderPlacedEvent;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class AuditListener {

    private final AuditRepository auditRepository;

    public AuditListener(AuditRepository auditRepository) {
        this.auditRepository = auditRepository;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Transactional(propagation = Propagation.REQUIRES_NEW)   // ★ 關鍵 ★
    public void onOrderPlaced(OrderPlacedEvent event) {
        auditRepository.save(new AuditLog(event.orderId(), "ORDER_PLACED"));
    }
}
```

> **或者改用 `BEFORE_COMMIT`**——如果稽核紀錄應該與訂單「同生共死」，
> 那 `BEFORE_COMMIT` 反而更正確（它們會在同一個交易裡）。
>
> **判斷準則：**
> - 這筆資料應該與主資料一起成功或失敗 → `BEFORE_COMMIT`
> - 這筆資料是「主資料已成立之後」的獨立紀錄 → `AFTER_COMMIT` + `REQUIRES_NEW`

### ★ 陷阱 2：沒有交易時，監聽者「完全不執行」

```java
@Service
public class OrderService {

    // ⚠️ 沒有 @Transactional
    public Order placeOrder(Order order) {
        Order saved = repository.save(order);
        publisher.publishEvent(OrderPlacedEvent.from(saved));
        return saved;
    }
}
```

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) {
    // ❌ 完全不會執行！因為沒有交易，也就沒有「commit 之後」這個時機
}
```

**而且沒有任何錯誤訊息。** 事件就是靜靜地消失了。

**解法：**

```java
// 解法 A：確保發布事件的方法有 @Transactional（推薦）

// 解法 B：允許「沒有交易時直接執行」
@TransactionalEventListener(
        phase = TransactionPhase.AFTER_COMMIT,
        fallbackExecution = true)      // ★ 沒有交易時就當普通 @EventListener ★
public void onOrderPlaced(OrderPlacedEvent event) { }
```

> **建議用解法 A**。`fallbackExecution = true` 會讓行為變得不一致
> （有交易時延後執行、沒交易時立刻執行），測試時很容易被誤導。
>
> **但寫測試時要特別注意這一點**——6.10 會給出正確的測試寫法。

### 陷阱 3：`AFTER_COMMIT` 的例外不會影響主交易，但會消失

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) {
    throw new RuntimeException("寄信失敗");
    // 主交易已 commit，不會受影響 ✅
    // 但這個例外會被 Spring 記錄然後丟棄
}
```

**所以要自己處理容錯：**

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) {
    try {
        notificationService.sendConfirmation(event.customerId(), event.orderId());
    } catch (Exception e) {
        log.error("訂單 {} 確認信寄送失敗，將排入重試佇列", event.orderId(), e);
        retryQueue.enqueue(new PendingNotification(event.orderId()));   // 落地，稍後重試
    }
}
```

### 完整範例：訂單成立的完整事件流

```java
package com.example.shop.order;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final OrderRepository repository;
    private final InventoryService inventoryService;
    private final ApplicationEventPublisher publisher;

    public OrderService(OrderRepository repository,
                        InventoryService inventoryService,
                        ApplicationEventPublisher publisher) {
        this.repository = repository;
        this.inventoryService = inventoryService;
        this.publisher = publisher;
    }

    @Transactional
    public Order placeOrder(Order order) {
        Order saved = repository.save(order);

        // ① 必須在同一個交易裡完成的事：直接呼叫，不用事件
        //    （這個 demo 的 Order 只有金額、沒有品項明細 ——
        //      品項扣減要等 08-jpa-mybatis 才接得完整，這裡讓 InventoryService 自己解析訂單）
        inventoryService.decreaseFor(saved);

        // ② 其他事情用事件解耦
        publisher.publishEvent(OrderPlacedEvent.from(saved));

        log.info("訂單 {} 已建立", saved.id());
        return saved;
    }
}
```

```java
package com.example.shop.order.listener;

import com.example.shop.order.OrderPlacedEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class OrderPlacedListeners {

    private static final Logger log = LoggerFactory.getLogger(OrderPlacedListeners.class);

    private final AuditRepository auditRepository;
    private final NotificationService notificationService;
    private final AnalyticsClient analyticsClient;
    private final PointService pointService;

    public OrderPlacedListeners(AuditRepository auditRepository,
                                NotificationService notificationService,
                                AnalyticsClient analyticsClient,
                                PointService pointService) {
        this.auditRepository = auditRepository;
        this.notificationService = notificationService;
        this.analyticsClient = analyticsClient;
        this.pointService = pointService;
    }

    /**
     * ① 紅利點數：必須與訂單同生共死（不能訂單成立了卻沒給點數）
     * → BEFORE_COMMIT，在同一個交易裡
     */
    @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
    @Order(10)
    public void awardPoints(OrderPlacedEvent event) {
        pointService.award(event.customerId(), event.amount());
        // 這裡失敗 → 整筆訂單 rollback（這是刻意的設計）
    }

    /**
     * ② 稽核紀錄：訂單成立之後的獨立紀錄
     * → AFTER_COMMIT + REQUIRES_NEW
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    @Order(20)
    public void writeAudit(OrderPlacedEvent event) {
        auditRepository.save(new AuditLog(event.orderId(), "ORDER_PLACED", event.occurredAt()));
    }

    /**
     * ③ 確認信：外部副作用，失敗不該影響訂單
     * → AFTER_COMMIT + 自行容錯
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Order(30)
    public void sendConfirmation(OrderPlacedEvent event) {
        try {
            notificationService.sendConfirmation(event.customerId(), event.orderId());
        } catch (Exception e) {
            log.error("訂單 {} 確認信寄送失敗", event.orderId(), e);
        }
    }

    /**
     * ④ 數據上報：完全可以失敗，而且不該讓使用者等
     * → AFTER_COMMIT + @Async
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @org.springframework.scheduling.annotation.Async("analyticsExecutor")
    @Order(40)
    public void trackAnalytics(OrderPlacedEvent event) {
        try {
            analyticsClient.track("order_placed", event.amount());
        } catch (Exception e) {
            log.warn("數據上報失敗，忽略", e);
        }
    }

    /**
     * ⑤ 訂單失敗時的補償
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_ROLLBACK)
    public void onRollback(OrderPlacedEvent event) {
        log.warn("訂單 {} 建立失敗並已回滾，客戶={}", event.orderId(), event.customerId());
    }
}
```

**一張表總結四種寫法的選擇：**

| 需求 | 寫法 |
|---|---|
| 必須與主資料一起成功或失敗 | `@TransactionalEventListener(BEFORE_COMMIT)` |
| 主資料成立後的獨立資料庫寫入 | `@TransactionalEventListener(AFTER_COMMIT)` + `@Transactional(REQUIRES_NEW)` |
| 外部副作用（寄信、推播、MQ） | `@TransactionalEventListener(AFTER_COMMIT)` + try-catch |
| 可以失敗且不該讓使用者等 | 上述再加 `@Async` |
| 不能遺失的跨服務通訊 | **不要用事件**，用 transactional outbox + 訊息佇列 |

---

## 6.10 測試

### 測試排程：不要真的等

```java
package com.example.shop.batch;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor;
import org.springframework.scheduling.config.ScheduledTask;
import org.springframework.scheduling.config.ScheduledTaskHolder;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 排程測試的正確做法：
 * ① 驗證「排程有註冊、cron 運算式正確」（不需要等它執行）
 * ② 直接呼叫方法驗證業務邏輯（不透過排程機制）
 */
@SpringBootTest
class SchedulingRegistrationTest {

    @Autowired
    private ScheduledTaskHolder scheduledTaskHolder;

    @Test
    void 對帳排程應正確註冊() {
        Set<ScheduledTask> tasks = scheduledTaskHolder.getScheduledTasks();

        assertThat(tasks)
                .extracting(task -> task.getTask().getRunnable().toString())
                .anyMatch(name -> name.contains("DailySettlement.settle"));
    }

    @Test
    void 對帳排程的cron應為每日凌晨兩點() {
        String cron = scheduledTaskHolder.getScheduledTasks().stream()
                .filter(t -> t.getTask().getRunnable().toString().contains("DailySettlement"))
                .map(t -> t.getTask().toString())
                .findFirst()
                .orElseThrow();

        assertThat(cron).contains("0 0 2 * * *");
    }
}
```

> **為什麼要測「cron 運算式」？**
> 因為 cron 打錯不會報錯，只會在錯的時間執行。
> 「`0 0 2 * * *`」與「`0 2 * * * *`」（每小時的第 2 分鐘）差一個位置，
> 行為完全不同——而且要等到隔天才會發現。

業務邏輯則直接測：

```java
class SettlementServiceTest {

    @Test
    void 應結算前一日所有已付款訂單() {
        // 不透過 @Scheduled，直接呼叫，完全不涉及排程機制
        SettlementService service = new SettlementService(fakeRepository, fixedClock);
        SettlementResult result = service.runSettlement();
        assertThat(result.settledCount()).isEqualTo(3);
    }
}
```

### 測試非同步：用 Awaitility，不要用 `Thread.sleep`

```xml
<dependency>
    <groupId>org.awaitility</groupId>
    <artifactId>awaitility</artifactId>
    <scope>test</scope>
</dependency>
```

```java
package com.example.shop.notification;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

@SpringBootTest
class AsyncNotificationTest {

    @Autowired
    private NotificationService notificationService;

    @Autowired
    private RecordingMailSender mailSender;

    @Test
    void 非同步寄信最終應完成() {
        notificationService.sendEmailAsync("a@b.com", "主旨", "內容");

        // ❌ 不要這樣：Thread.sleep(1000);
        //    → 機器慢的時候會偶發失敗（flaky test），機器快的時候浪費時間

        // ✅ 輪詢直到條件成立，或超過上限才失敗
        await().atMost(Duration.ofSeconds(5))
               .pollInterval(Duration.ofMillis(50))
               .untilAsserted(() -> assertThat(mailSender.sent)
                       .hasSize(1)
                       .first()
                       .extracting("to").isEqualTo("a@b.com"));
    }

    @Test
    void 非同步任務應在不同執行緒執行() {
        String testThread = Thread.currentThread().getName();

        notificationService.sendEmailAsync("a@b.com", "主旨", "內容");

        await().atMost(Duration.ofSeconds(5))
               .until(() -> !mailSender.threads.isEmpty());

        assertThat(mailSender.threads.get(0))
                .isNotEqualTo(testThread)
                .startsWith("shop-async-");
    }

    // ── 測試替身 ──

    static class RecordingMailSender {
        record Sent(String to, String subject, String body) { }
        final List<Sent> sent = new CopyOnWriteArrayList<>();          // ★ 執行緒安全 ★
        final List<String> threads = new CopyOnWriteArrayList<>();

        void send(String to, String subject, String body) {
            threads.add(Thread.currentThread().getName());
            sent.add(new Sent(to, subject, body));
        }
    }

    @TestConfiguration
    static class TestConfig {
        @Bean @Primary
        RecordingMailSender recordingMailSender() { return new RecordingMailSender(); }
    }
}
```

> ⚠️ **測試非同步時，收集結果的集合一定要是執行緒安全的**
> （`CopyOnWriteArrayList` / `ConcurrentLinkedQueue`）。
> 用 `ArrayList` 會在測試執行緒讀取時看不到寫入（記憶體可見性問題），
> 造成間歇性失敗——而且非常難查。

### 讓 `@Async` 在測試中變成同步（更簡單的做法）

```java
package com.example.shop.config;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.core.task.SyncTaskExecutor;
import org.springframework.core.task.TaskExecutor;

/**
 * 測試時把非同步變成同步，讓測試變成確定性的。
 *
 * <p>取捨：測不到「真的在別的執行緒執行」與併發問題，
 * 但可以用簡單的斷言測業務邏輯。兩種測試都需要。
 */
@TestConfiguration
public class SyncExecutorTestConfig {

    @Bean("applicationTaskExecutor")
    @Primary
    public TaskExecutor syncTaskExecutor() {
        return new SyncTaskExecutor();      // 在呼叫端的執行緒直接執行
    }
}
```

### 測試事件：`@RecordApplicationEvents`

```java
package com.example.shop.order;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.event.ApplicationEvents;
import org.springframework.test.context.event.RecordApplicationEvents;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@RecordApplicationEvents         // ★ Spring 5.3.3+ ★
class OrderEventTest {

    @Autowired
    private OrderService orderService;

    @Autowired
    private ApplicationEvents events;

    @Test
    @Transactional
    void 下單應發布OrderPlacedEvent() {
        orderService.placeOrder(new Order(null, "c-001", new BigDecimal("1280"), "LINE_PAY", "CREATED", null));

        assertThat(events.stream(OrderPlacedEvent.class))
                .hasSize(1)
                .first()
                .satisfies(event -> {
                    assertThat(event.customerId()).isEqualTo("c-001");
                    assertThat(event.amount()).isEqualByComparingTo("1280");
                });
    }

    @Test
    @Transactional
    void 應記錄發布的事件總數() {
        orderService.placeOrder(/* ... */);
        assertThat(events.stream()).isNotEmpty();
    }
}
```

### ★ 測試 `@TransactionalEventListener` 的陷阱

```java
@SpringBootTest
@Transactional          // ⚠️ 測試方法本身在一個「會 rollback」的交易裡
class BadTransactionalEventTest {

    @Test
    void AFTER_COMMIT監聽者應執行() {
        orderService.placeOrder(order);

        // ❌ 永遠失敗！
        // 因為測試的 @Transactional 預設會 rollback，
        // 交易永遠不會 commit → AFTER_COMMIT 永遠不會觸發
        assertThat(mailSender.sent).hasSize(1);
    }
}
```

**三種正確做法：**

```java
package com.example.shop.order;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.support.TransactionTemplate;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class TransactionalEventTest {

    @Autowired private OrderService orderService;
    @Autowired private RecordingMailSender mailSender;
    @Autowired private TransactionTemplate transactionTemplate;
    @Autowired private OrderRepository orderRepository;

    /** 做法 1：不加 @Transactional，讓真實交易 commit（記得手動清理資料） */
    @Test
    void 交易commit後應寄出確認信() {
        try {
            Order saved = orderService.placeOrder(newOrder());

            org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(3))
                    .untilAsserted(() -> assertThat(mailSender.sent).hasSize(1));

        } finally {
            orderRepository.deleteAll();      // ★ 沒有自動 rollback，要自己清 ★
        }
    }

    /** 做法 2：用 TransactionTemplate 明確控制交易邊界 */
    @Test
    void 用TransactionTemplate明確commit() {
        Order saved = transactionTemplate.execute(status -> orderService.placeOrder(newOrder()));
        // 這一行執行完，交易已 commit，AFTER_COMMIT 已觸發

        assertThat(mailSender.sent).hasSize(1);
        orderRepository.deleteById(saved.id());
    }

    /** 做法 3：驗證 rollback 時「不會」寄信（負向測試，同樣重要） */
    @Test
    void 交易rollback時不應寄出確認信() {
        try {
            transactionTemplate.execute(status -> {
                orderService.placeOrder(newOrder());
                status.setRollbackOnly();       // ★ 強制 rollback ★
                return null;
            });
        } catch (Exception ignored) { }

        assertThat(mailSender.sent).isEmpty();  // ★ 這才是 AFTER_COMMIT 的價值 ★
    }

    private Order newOrder() {
        return new Order(null, "c-001", new java.math.BigDecimal("100"), "LINE_PAY", "CREATED", null);
    }
}
```

> **做法 3 那個負向測試是最重要的一個**——它驗證的正是
> 「不會出現『訂單不存在但客人收到確認信』」這個 bug。
> 沒有這個測試，`AFTER_COMMIT` 改成 `@EventListener` 也不會有人發現。

---

## 6.11 常見錯誤

### ① 忘記 `@EnableScheduling` / `@EnableAsync`

沒有任何錯誤訊息，就是不執行。用 `/actuator/conditions` 或 `/actuator/scheduledtasks` 確認。

### ② 排程執行緒池只有 1 條

一個慢任務讓所有排程停擺。設 `spring.task.scheduling.pool.size`。

### ③ `@Async` 的預設佇列無上限

任務堆積到 OOM。設 `spring.task.execution.pool.queue-capacity`。

### ④ 多實例排程重複執行

用 ShedLock 或把批次拆成獨立的 Deployment。

### ⑤ cron 沒指定 zone

容器預設 UTC，排程在錯誤的時間執行。

### ⑥ `@Async` 回傳非 Future 的值

呼叫端拿到 `null`，而且不會報錯。

### ⑦ `@Async` void 方法的例外消失

設 `AsyncUncaughtExceptionHandler`，並加上指標。

### ⑧ `CompletableFuture` 的例外沒人處理

`AsyncUncaughtExceptionHandler` 對它無效。呼叫端必須用 `whenComplete` / `exceptionally`。

### ⑨ `@Async` / `@Scheduled` 遺失 MDC 與 Security 上下文

用 `TaskDecorator`（第 05 章 5.9）。Security 的部分要用
`DelegatingSecurityContextAsyncTaskExecutor`（09-spring-security 會講）。

### ⑩ `AFTER_COMMIT` 裡寫資料庫沒有被 commit

加 `@Transactional(propagation = REQUIRES_NEW)`。

### ⑪ 發布事件的方法沒有 `@Transactional`

`@TransactionalEventListener` 完全不執行，且無錯誤訊息。

### ⑫ 用 `ApplicationEvent` 做「不能遺失」的事

服務被 kill 就消失了。改用 transactional outbox + 訊息佇列。

### ⑬ 測試用 `Thread.sleep` 等非同步結果

flaky test。用 Awaitility。

### ⑭ 執行緒池沒有優雅關閉

服務關閉時佇列裡的任務直接消失。設 `shutdown.await-termination: true`。

---

## 6.12 本章練習

### 練習 1：判斷排程行為

```java
@Component
public class Jobs {
    @Scheduled(fixedRate = 10_000)
    public void a() throws InterruptedException { Thread.sleep(25_000); }

    @Scheduled(fixedDelay = 10_000)
    public void b() throws InterruptedException { Thread.sleep(25_000); }

    @Scheduled(cron = "0 * * * * *")
    public void c() { }
}
```

假設 `spring.task.scheduling.pool.size` 沒有設定，說明前 90 秒內三個方法各執行幾次。

<details>
<summary>參考解答</summary>

**關鍵前提：預設池只有 1 條執行緒，所以三個任務要搶同一條。**

假設 0 秒同時觸發，`a` 先搶到（實際順序不保證）：

```
t=0    a 開始（執行 25 秒）        ← 佔用唯一的執行緒
       b、c 想執行但要排隊
t=25   a 結束，b 開始（執行 25 秒）
       a 想在 t=10、20 執行（fixedRate），但都排隊
t=50   b 結束，a 開始（補跑積欠的）
t=75   a 結束，c 開始（積欠了 t=60 那次）
t=75   c 瞬間結束，a 或 b 開始
t=90   統計時點
```

大約的執行次數：

| 方法 | 次數 | 說明 |
|---|---|---|
| `a` | 2～3 次 | `fixedRate = 10s` 但每次要 25s，**永遠追不上**，會不斷累積積欠 |
| `b` | 1～2 次 | `fixedDelay = 10s`，每輪 25 + 10 = 35 秒，正常應該 2 次，但被 `a` 卡住 |
| `c` | 0～1 次 | 應該每分鐘一次（t=0、60），但幾乎沒機會執行 |

**重點結論：**

1. **`a` 是災難**：`fixedRate` 小於執行時間，會無止盡累積積欠任務。
   即使有足夠的執行緒，也會變成「永遠有多個 `a` 在跑」。
2. **`c` 幾乎不執行**：一個「每分鐘要做的事」實際上可能一小時都跑不到一次。
3. **完全沒有錯誤訊息**——這就是 6.3 那個真實案例的成因。

**修正：**

```yaml
spring:
  task:
    scheduling:
      pool:
        size: 8
```

```java
@Component
public class Jobs {
    // fixedRate 改成 fixedDelay，或把間隔設得比執行時間長
    @Scheduled(fixedDelay = 10_000)
    public void a() throws InterruptedException { Thread.sleep(25_000); }
    // ...
}
```

**外加：如果任務會執行 25 秒，就該加上「上次執行時間」的指標與告警**，
否則你永遠不知道它有沒有在跑。

</details>

### 練習 2：修正執行緒池設定

```yaml
spring:
  task:
    execution:
      pool:
        core-size: 4
        max-size: 200
```

這個設定有什麼問題？在什麼情況下會出事？

<details>
<summary>參考解答</summary>

**問題：`queue-capacity` 沒有設定，會用預設的 `Integer.MAX_VALUE`。**

後果（回顧 6.6 的流程）：

```
提交任務
  → 執行緒數 < 4？ 是 → 建立新執行緒
  → 佇列有空間？ 永遠有（2^31-1 個）→ 放進佇列
  → 永遠不會走到「建立新執行緒到 max-size」這一步

所以：max-size: 200 完全沒有作用，實際上永遠只有 4 條執行緒。
```

**出事情境：**

```
每秒進來 100 個任務，每個任務 500ms
→ 4 條執行緒每秒只能處理 8 個
→ 每秒堆積 92 個
→ 一小時堆積 33 萬個任務

每個任務物件假設 1 KB（含它持有的參數參照）
→ 330 MB 記憶體被佇列佔用，而且持續成長
→ 幾小時後 OOM

而在 OOM 之前：
  ✅ CPU 正常（只有 4 條執行緒在跑）
  ✅ 沒有任何錯誤或拒絕
  ✅ API 回應時間正常（@Async 立刻返回）
  ❌ 但使用者的通知永遠不會到
```

**修正版：**

```yaml
spring:
  task:
    execution:
      pool:
        core-size: 8
        max-size: 32
        queue-capacity: 200          # ★ 有限值 ★
        keep-alive: 60s
        allow-core-thread-timeout: true
      thread-name-prefix: shop-async-
      shutdown:
        await-termination: true
        await-termination-period: 30s
```

**佇列容量怎麼算：**

```
8 條執行緒 × 每個任務 500ms = 每秒處理 16 個
佇列 200 個 → 最壞情況等 200 / 16 = 12.5 秒

「12.5 秒後才寄出通知」可以接受嗎？
  可以 → 200 剛好
  不行 → 要增加執行緒數，或改用訊息佇列
```

**再加上監控與拒絕處理：**

```java
@Bean
public ThreadPoolTaskExecutor applicationTaskExecutor(ThreadPoolTaskExecutorBuilder builder,
                                                      MeterRegistry registry) {
    ThreadPoolTaskExecutor executor = builder
            .corePoolSize(8).maxPoolSize(32).queueCapacity(200)
            .threadNamePrefix("shop-async-")
            .taskDecorator(new MdcTaskDecorator())
            .build();

    executor.setRejectedExecutionHandler((task, exec) -> {
        registry.counter("shop.async.rejected").increment();
        log.error("任務被拒絕 active={} queue={}", exec.getActiveCount(), exec.getQueue().size());
        // 落地到資料庫，讓排程稍後重試（不要直接丟棄）
        pendingTaskRepository.save(PendingTask.from(task));
    });
    return executor;
}
```

**這題的核心教訓**：`max-size` 在無上限佇列下是**裝飾品**。
看到 `max-size` 設得很大但沒設 `queue-capacity` 的設定，就知道寫的人不了解 `ThreadPoolExecutor` 的機制。

</details>

### 練習 3：修正事件監聽器

```java
@Service
public class OrderService {
    @Transactional
    public Order placeOrder(Order order) {
        Order saved = repository.save(order);
        publisher.publishEvent(new OrderPlacedEvent(saved.id()));
        return saved;
    }
}

@Component
public class Listeners {

    // A
    @EventListener
    public void sendEmail(OrderPlacedEvent e) {
        mailService.send(e.orderId());
    }

    // B
    @TransactionalEventListener
    public void writeAudit(OrderPlacedEvent e) {
        auditRepository.save(new AuditLog(e.orderId()));
    }

    // C
    @Async
    @EventListener
    public void updateSearchIndex(OrderPlacedEvent e) {
        Order order = repository.findById(e.orderId()).orElseThrow();
        searchClient.index(order);
    }

    // D
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void notifyWarehouse(OrderPlacedEvent e) {
        warehouseClient.notify(e.orderId());
        throw new RuntimeException("倉庫系統連不上");
    }
}
```

找出四個監聽器各自的問題。

<details>
<summary>參考解答</summary>

#### A：`@EventListener` 同步執行，會造成「訂單不存在但信已寄出」

```java
@EventListener
public void sendEmail(OrderPlacedEvent e) { mailService.send(e.orderId()); }
```

**問題**：這是同步的，在**交易還沒 commit** 時就執行。
如果 `placeOrder` 後續（或呼叫端）拋例外導致 rollback，
訂單不存在，但確認信已經寄出去了。

**修正：**

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void sendEmail(OrderPlacedEvent e) {
    try {
        mailService.send(e.orderId());
    } catch (Exception ex) {
        log.error("訂單 {} 確認信寄送失敗", e.orderId(), ex);
    }
}
```

#### B：`AFTER_COMMIT`（預設值）裡寫資料庫，資料不會被 commit

```java
@TransactionalEventListener       // phase 預設是 AFTER_COMMIT
public void writeAudit(OrderPlacedEvent e) {
    auditRepository.save(new AuditLog(e.orderId()));    // 💥 SQL 執行了但沒 commit
}
```

**這是 6.9 陷阱 1**。稽核表會永遠是空的，而且沒有任何錯誤。

**兩種修正（取決於語意）：**

```java
// 修正 A：稽核紀錄應與訂單同生共死 → BEFORE_COMMIT
@TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
public void writeAudit(OrderPlacedEvent e) {
    auditRepository.save(new AuditLog(e.orderId()));
}

// 修正 B：稽核是訂單成立後的獨立紀錄 → AFTER_COMMIT + REQUIRES_NEW
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void writeAudit(OrderPlacedEvent e) {
    auditRepository.save(new AuditLog(e.orderId()));
}
```

#### C：`@Async` + `@EventListener` → 讀不到還沒 commit 的訂單

```java
@Async
@EventListener
public void updateSearchIndex(OrderPlacedEvent e) {
    Order order = repository.findById(e.orderId()).orElseThrow();   // 💥 找不到
}
```

**三個問題疊加：**

1. `@EventListener`（不是 Transactional 版）→ 交易還沒 commit 就發布。
2. `@Async` → 新執行緒，看不到原交易的未提交資料。
3. **時序不確定** → 有時候會成功（交易剛好先 commit 了），有時候失敗
   → 這種**間歇性失敗**最難查。
4. 另外還遺失了 MDC（第 05 章）。

**修正：**

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async("indexExecutor")
public void updateSearchIndex(OrderPlacedEvent e) {
    try {
        repository.findById(e.orderId())
                  .ifPresentOrElse(
                          searchClient::index,
                          () -> log.warn("訂單 {} 已不存在，跳過索引", e.orderId()));
    } catch (Exception ex) {
        log.error("訂單 {} 索引更新失敗", e.orderId(), ex);
    }
}
```

> **更好的做法**：把索引需要的欄位直接放進事件，就不用回查資料庫。
> 這也是「事件應該自我完備」的原則。

#### D：`AFTER_COMMIT` 的例外會被丟棄

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void notifyWarehouse(OrderPlacedEvent e) {
    warehouseClient.notify(e.orderId());
    throw new RuntimeException("倉庫系統連不上");
}
```

**問題**：主交易已 commit（訂單成立），但通知倉庫失敗了。
這個例外會被 Spring 記錄後丟棄——**訂單成立了但倉庫不知道要出貨**，
而且沒有任何補救機制。

**修正：落地重試**

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void notifyWarehouse(OrderPlacedEvent e) {
    try {
        warehouseClient.notify(e.orderId());
    } catch (Exception ex) {
        log.error("通知倉庫失敗，排入重試佇列 orderId={}", e.orderId(), ex);
        // ★ 落地：讓排程稍後重試，不要讓這件事消失 ★
        pendingWarehouseNotificationRepository.save(
                new PendingNotification(e.orderId(), Instant.now(), 0));
    }
}
```

---

**整題的核心教訓：**

「通知倉庫出貨」這種**不能遺失**的事，用 `ApplicationEvent` 是**架構選擇錯誤**。
正確做法是 **transactional outbox**：

```java
@Transactional
public Order placeOrder(Order order) {
    Order saved = repository.save(order);

    // ★ 在同一個交易裡寫一筆待處理訊息 ★
    outboxRepository.save(new OutboxMessage(
            "ORDER_PLACED", saved.id(), toJson(saved), Instant.now()));

    return saved;
    // 訂單與 outbox 記錄是同一個交易 → 不可能只成功一半
}
```

```java
@Component
public class OutboxPublisher {

    @Scheduled(fixedDelay = 1000)
    @SchedulerLock(name = "outboxPublisher", lockAtMostFor = "PT5M")
    public void publish() {
        List<OutboxMessage> pending = outboxRepository.findUnpublished(100);
        for (OutboxMessage msg : pending) {
            try {
                messageQueue.send(msg.topic(), msg.payload());
                outboxRepository.markPublished(msg.id());
            } catch (Exception e) {
                log.warn("outbox 訊息 {} 發送失敗，稍後重試", msg.id(), e);
                // 不 markPublished → 下一輪會再試
            }
        }
    }
}
```

**這個模式的價值**：訊息「一定會被發出去」（至少一次），
因為它跟業務資料在同一個交易裡。代價是要處理重複投遞（下游要冪等）。

</details>

### 練習 4：設計一個可靠的批次任務

需求：每天凌晨 3 點，把前一天的訂單匯出成 CSV 上傳到 S3。要求：

1. 多實例部署不會重複執行。
2. 執行失敗要能重試，且重試不會產生重複檔案。
3. 執行狀況可監控（成功/失敗/耗時/筆數）。
4. 排程卡住時不會影響其他排程。
5. 服務關閉時，正在執行的任務要能完成或安全中止。

<details>
<summary>參考解答</summary>

```java
package com.example.shop.batch;

import java.time.Instant;
import java.time.LocalDate;

/** 匯出任務的執行紀錄，用來做冪等與監控 */
public record ExportRun(
        Long id,
        LocalDate targetDate,
        Status status,
        int recordCount,
        String fileKey,
        Instant startedAt,
        Instant finishedAt,
        String errorMessage) {

    public enum Status { RUNNING, SUCCESS, FAILED }
}
```

```sql
CREATE TABLE export_run (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    target_date    DATE         NOT NULL,
    status         VARCHAR(16)  NOT NULL,
    record_count   INT          NOT NULL DEFAULT 0,
    file_key       VARCHAR(512),
    started_at     TIMESTAMP(3) NOT NULL,
    finished_at    TIMESTAMP(3),
    error_message  TEXT,
    KEY idx_date_status (target_date, status),
    -- ★ 「同一天只能有一筆 SUCCESS」用 generated column + UNIQUE 表達 ★
    --   只有 status='SUCCESS' 時這一欄才有值，其餘是 NULL；
    --   而 MySQL 的 UNIQUE 允許多個 NULL → FAILED 可以有很多筆（重試才跑得下去）
    success_date DATE GENERATED ALWAYS AS
        (CASE WHEN status = 'SUCCESS' THEN target_date END) STORED,
    UNIQUE KEY uk_success_date (success_date)
) ;
-- ⚠️ 千萬不要寫成 UNIQUE (target_date, status)：
--    那會讓「同一天的第二次 FAILED」insert 失敗，重試邏輯直接壞掉。
```

```java
package com.example.shop.batch;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import net.javacrumbs.shedlock.spring.annotation.SchedulerLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDate;
import java.util.UUID;

@Component
public class DailyOrderExportJob {

    private static final Logger log = LoggerFactory.getLogger(DailyOrderExportJob.class);
    private static final String JOB_NAME = "dailyOrderExport";

    private final OrderExportService exportService;
    private final MeterRegistry registry;
    private final Clock clock;

    public DailyOrderExportJob(OrderExportService exportService,
                               MeterRegistry registry,
                               Clock clock) {
        this.exportService = exportService;
        this.registry = registry;
        this.clock = clock;
    }

    /**
     * 需求 1（不重複執行）：@SchedulerLock
     * 需求 4（不影響其他排程）：靠 spring.task.scheduling.pool.size &gt; 1
     *                          + lockAtMostFor 防止鎖永久卡住
     */
    @Scheduled(cron = "${shop.batch.export-cron:0 0 3 * * *}", zone = "Asia/Taipei")
    @SchedulerLock(name = JOB_NAME, lockAtMostFor = "PT2H", lockAtLeastFor = "PT5M")
    public void exportYesterdayOrders() {
        LocalDate target = LocalDate.now(clock).minusDays(1);
        run(target);
    }

    /** 補跑用的入口（手動觸發或重試排程呼叫） */
    public void run(LocalDate target) {
        MDC.put("traceId", "job-" + UUID.randomUUID().toString().substring(0, 12));
        MDC.put("job", JOB_NAME);
        MDC.put("targetDate", target.toString());

        Timer.Sample sample = Timer.start(registry);
        String outcome = "SUCCESS";
        int count = 0;

        try {
            // 需求 2（冪等）：已成功就跳過
            if (exportService.alreadyExported(target)) {
                log.info("{} 已匯出過，跳過", target);
                outcome = "SKIPPED";
                return;
            }
            count = exportService.export(target);
            log.info("匯出完成，共 {} 筆", count);

        } catch (Exception e) {
            outcome = "FAILURE";
            log.error("匯出失敗", e);
            // 不重新拋出：讓排程機制繼續，改由重試排程處理

        } finally {
            // 需求 3（可監控）
            sample.stop(Timer.builder("shop.batch.duration")
                    .tag("job", JOB_NAME).tag("outcome", outcome)
                    .publishPercentiles(0.5, 0.95)
                    .register(registry));
            registry.counter("shop.batch.records",
                    "job", JOB_NAME, "outcome", outcome).increment(count);
            MDC.clear();
        }
    }

    /** 需求 2（重試）：每 30 分鐘檢查有沒有失敗的匯出要補跑 */
    @Scheduled(fixedDelayString = "PT30M")
    @SchedulerLock(name = JOB_NAME + "-retry", lockAtMostFor = "PT1H")
    public void retryFailedExports() {
        exportService.findFailedWithinDays(7).forEach(failedDate -> {
            log.info("重試匯出 {}", failedDate);
            run(failedDate);
        });
    }
}
```

```java
package com.example.shop.batch;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

@Service
public class OrderExportService {

    private static final Logger log = LoggerFactory.getLogger(OrderExportService.class);

    private final ExportRunRepository runRepository;
    private final OrderRepository orderRepository;
    private final ObjectStorageClient storage;
    private final Clock clock;

    public OrderExportService(ExportRunRepository runRepository,
                              OrderRepository orderRepository,
                              ObjectStorageClient storage,
                              Clock clock) {
        this.runRepository = runRepository;
        this.orderRepository = orderRepository;
        this.storage = storage;
        this.clock = clock;
    }

    public boolean alreadyExported(LocalDate date) {
        return runRepository.existsByTargetDateAndStatus(date, ExportRun.Status.SUCCESS);
    }

    public List<LocalDate> findFailedWithinDays(int days) {
        return runRepository.findFailedDatesSince(LocalDate.now(clock).minusDays(days));
    }

    /**
     * ⚠️ 刻意「不」在整個匯出過程上加 @Transactional。
     *
     * <p>理由：匯出可能跑幾十分鐘，一個長交易會：
     * ① 持有資料庫連線整段時間（連線池耗盡）
     * ② 產生巨大的 undo log（MySQL 的 MVCC 成本，07-mysql 第 04 章）
     * ③ 阻擋其他交易的 DDL
     *
     * <p>改用：短交易記錄狀態 + 交易外做實際工作。
     */
    public int export(LocalDate date) {
        Long runId = startRun(date);          // 短交易 ①

        try {
            // ★ 需求 2：檔名含日期，重跑會覆蓋同一個檔案，不會產生重複 ★
            String fileKey = "orders/%s/orders-%s.csv".formatted(date.getYear(), date);

            int count = 0;
            try (var writer = storage.openWriter(fileKey)) {
                writer.write("orderId,customerId,amount,status,createdAt\n");

                // ★ 需求 5：檢查中斷旗標，讓服務關閉時能安全停止 ★
                for (Order order : orderRepository.streamByDate(date)) {
                    if (Thread.currentThread().isInterrupted()) {
                        throw new InterruptedException("任務被中斷（服務關閉中）");
                    }
                    writer.write(toCsvLine(order));
                    count++;
                }
            }

            finishRun(runId, ExportRun.Status.SUCCESS, count, fileKey, null);   // 短交易 ②
            return count;

        } catch (Exception e) {
            finishRun(runId, ExportRun.Status.FAILED, 0, null, e.getMessage()); // 短交易 ②'
            throw new ExportFailedException("匯出 " + date + " 失敗", e);
        }
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    protected Long startRun(LocalDate date) {
        return runRepository.save(new ExportRun(
                null, date, ExportRun.Status.RUNNING, 0, null,
                Instant.now(clock), null, null)).id();
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    protected void finishRun(Long runId, ExportRun.Status status,
                             int count, String fileKey, String error) {
        runRepository.updateResult(runId, status, count, fileKey,
                Instant.now(clock), truncate(error, 2000));
    }

    private String toCsvLine(Order o) {
        return "%d,%s,%s,%s,%s%n".formatted(
                o.id(), o.customerId(), o.amount(), o.status(), o.createdAt());
    }

    private String truncate(String s, int max) {
        return s == null ? null : s.length() <= max ? s : s.substring(0, max);
    }

    public static class ExportFailedException extends RuntimeException {
        public ExportFailedException(String message, Throwable cause) { super(message, cause); }
    }
}
```

> ⚠️ **注意 `startRun` / `finishRun` 是 `protected` 且被自呼叫——這會踩到第 04 章的自呼叫失效！**
> 上面的寫法是**錯的**，正式版應該把它們拆到另一個 Bean：

```java
@Service
public class ExportRunTracker {

    private final ExportRunRepository runRepository;
    private final Clock clock;

    public ExportRunTracker(ExportRunRepository runRepository, Clock clock) {
        this.runRepository = runRepository;
        this.clock = clock;
    }

    @Transactional
    public Long start(LocalDate date) {
        return runRepository.save(new ExportRun(
                null, date, ExportRun.Status.RUNNING, 0, null,
                Instant.now(clock), null, null)).id();
    }

    @Transactional
    public void finish(Long runId, ExportRun.Status status,
                       int count, String fileKey, String error) {
        runRepository.updateResult(runId, status, count, fileKey, Instant.now(clock), error);
    }
}
```

```java
// OrderExportService 改為注入 tracker
private final ExportRunTracker tracker;

public int export(LocalDate date) {
    Long runId = tracker.start(date);       // ✅ 經過代理，交易生效
    // ...
    tracker.finish(runId, SUCCESS, count, fileKey, null);
}
```

**設定：**

```yaml
spring:
  task:
    scheduling:
      pool:
        size: 8                              # 需求 4
      thread-name-prefix: shop-sched-
      shutdown:
        await-termination: true              # 需求 5
        await-termination-period: 120s       # 給匯出任務時間收尾

server:
  shutdown: graceful                         # 第 08 章

shop:
  batch:
    export-cron: "0 0 3 * * *"
```

**告警：**

```yaml
- alert: DailyExportMissing
  expr: |
    absent_over_time(
      shop_batch_duration_seconds_count{job="dailyOrderExport",outcome="SUCCESS"}[26h]
    )
  annotations:
    summary: "每日訂單匯出超過 26 小時沒有成功執行"

- alert: DailyExportFailing
  expr: increase(shop_batch_duration_seconds_count{job="dailyOrderExport",outcome="FAILURE"}[1h]) > 2
  annotations:
    summary: "訂單匯出連續失敗"
```

**五個需求的對應總結：**

| 需求 | 實作 |
|---|---|
| 1. 不重複執行 | `@SchedulerLock` + `lockAtLeastFor` |
| 2. 可重試且不產生重複檔案 | `export_run` 表記錄狀態 + 檔名含日期（覆蓋而非新增）+ 重試排程 |
| 3. 可監控 | Timer + Counter + `export_run` 表 + 告警規則（含「沒執行」的告警） |
| 4. 不影響其他排程 | 排程池 size=8 + `lockAtMostFor` 防止鎖卡死 |
| 5. 安全關閉 | `await-termination` + 迴圈裡檢查 `isInterrupted()` |

**額外的重要設計決定**：匯出過程**不用長交易**。
這是新手最常犯的錯——在整個批次上加 `@Transactional`，
結果一個跑 40 分鐘的交易把連線池與 undo log 都撐爆。

</details>

---

## 6.13 驗收清單

- [ ] 我知道 `@EnableScheduling` / `@EnableAsync` 少了會靜靜失效。
- [ ] 我能說出 `fixedRate` 與 `fixedDelay` 的差別，也知道預設該用 `fixedDelay`。
- [ ] 我知道 Spring 的 cron 是**六欄**，第一欄是秒。
- [ ] 我一律為 cron 指定 `zone`，並知道容器預設是 UTC。
- [ ] **我知道 `@Scheduled` 的預設執行緒池只有 1 條，也知道這造成過什麼事故。**
- [ ] 我會設定 `spring.task.scheduling.pool.size`。
- [ ] 我知道排程任務要有 traceId、要 catch 例外、要有指標。
- [ ] 我知道「排程沒跑」要用「上次成功執行時間」告警，不能只監控失敗。
- [ ] 我能說出多實例排程重複執行的四種解法，並知道 ShedLock 的 `lockAtLeastFor` 為什麼重要。
- [ ] 我知道 `@Async` 方法的回傳型別只能是 `void` / `Future` / `CompletableFuture`。
- [ ] **我知道 `@Async` 的預設佇列是無上限的，也能說出「`max-size` 因此失效」的原因。**
- [ ] 我能計算執行緒池的四個參數，並用「可接受延遲」推導佇列容量。
- [ ] 我知道四種拒絕策略，也知道 `CallerRunsPolicy` 的背壓效果與風險。
- [ ] 我會為不同性質的任務使用不同的執行緒池（艙壁模式）。
- [ ] 我會監控 `executor_queued_tasks` 與 `executor_rejected_tasks_total`。
- [ ] 我知道 `void` 方法的例外要用 `AsyncUncaughtExceptionHandler` 處理。
- [ ] 我知道 `AsyncUncaughtExceptionHandler` 對 `CompletableFuture` 無效。
- [ ] 我知道 `@Async` + `@Transactional` 會開新交易，且可能讀不到未 commit 的資料。
- [ ] 我知道虛擬執行緒適合 IO 密集，也能說出五種不該用的情況。
- [ ] 我知道虛擬執行緒不會讓下游變快，開啟前要確認連線池容量。
- [ ] 我能用 `ApplicationEvent` 解耦模組，並知道事件應該自我完備。
- [ ] 我知道 `@EventListener` 預設是同步的，也知道這帶來的交易語意。
- [ ] 我能說出 `ApplicationEvent` 與訊息佇列的界線。
- [ ] **我知道不能用 `ApplicationEvent` 做「不能遺失」的事，並知道 transactional outbox 模式。**
- [ ] 我能正確使用 `@TransactionalEventListener` 的四個階段。
- [ ] **我知道 `AFTER_COMMIT` 裡寫資料庫需要 `REQUIRES_NEW`，否則資料會靜靜消失。**
- [ ] 我知道發布事件的方法沒有 `@Transactional` 時，`@TransactionalEventListener` 完全不執行。
- [ ] 我知道 `AFTER_COMMIT` 的例外會被丟棄，所以要自己落地重試。
- [ ] 我會用 `ScheduledTaskHolder` 測試排程有沒有註冊、cron 對不對。
- [ ] 我用 Awaitility 測非同步，不用 `Thread.sleep`。
- [ ] 我知道測試非同步時收集結果的集合要是執行緒安全的。
- [ ] 我知道測試 `@TransactionalEventListener` 不能用 `@Transactional`（會 rollback），並會用 `TransactionTemplate`。
- [ ] 我會寫「rollback 時不應寄信」這種負向測試。

---

完成後請前往 [07-testing-spring-boot.md](./07-testing-spring-boot.md)。
