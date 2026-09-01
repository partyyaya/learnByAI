# 第 06 章：非同步與外部呼叫

> 05 章把「快取」做完了，而它留下三個沒有解決的問題：
> **清快取失敗了怎麼辦、快取掛掉時誰擋住資料庫、多實例之間怎麼同步。**
>
> 三個問題的形狀一模一樣：
>
> **交易 commit 之後，還有一堆事情要做，而它們每一個都可能失敗。**
>
> 在交易裡，「失敗了怎麼辦」有一個標準答案：**rollback**。
> **交易外面沒有這個答案。** 這一章在講交易外面的世界。

---

## 6.0 先看見痛：三個真實事故

### 事故 1：一次例行部署，3,000 封確認信消失了

**現場**（2026-06-11 14:30，客服部門）：

```
客服主管：今天下午開始，客戶一直打來問「我下單了但沒收到確認信」。
         我查了訂單，訂單【都在】，狀態也是 PAID。
         就是信沒寄出去。而且只有 14:05 到 14:12 那七分鐘的單有問題。
```

**14:05 到 14:12 是什麼？** 是那天的部署視窗。

**程式碼**（01 章 1.6.3 的版本，一字未改）：

```java
@Component
public class OrderNotificationListener {

    private final EmailSender email;

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async("notificationExecutor")
    public void onOrderPlaced(OrderPlacedEvent event) {
        try {
            email.send(OrderConfirmationMail.from(event));
        } catch (Exception e) {
            log.warn("訂單確認信寄送失敗：order={}", event.orderId(), e);
        }
    }
}
```

**這段程式碼沒有 bug。** 它的問題在**它沒有寫的地方**：

```yaml
shop:
  async:
    notification:
      core-size: 4
      max-size: 8
      queue-capacity: 500        # ★★ 這一行
```

**發生了什麼**：

| 時間 | 事件 |
|---|---|
| 14:05:00 | 郵件供應商的 API 開始變慢（平常 80ms → 4 秒） |
| 14:05:00～14:12 | 4 條執行緒每條每 4 秒處理一封 → **每秒 1 封**，而下單是每秒 8 張 |
| 14:06:11 | 佇列累積到上限 **500 封**（`queue-capacity: 500`）→ 之後每秒有 7 封**進不去** |
| 14:06:11～14:12 | ⚠️ 進不去的那 **2,500 封**被拒絕策略擋掉（`ABORT` 是預設）—— **有例外、有 log，而沒有人在看** |
| 14:12:00 | 🔴 **部署開始，舊的 pod 收到 SIGTERM** |
| 14:12:00 | `ThreadPoolTaskExecutor.shutdown()` 被呼叫 |
| 14:12:00 | ⚠️ **佇列裡的 500 個任務被直接丟掉** |

**「3,000 封」是這兩個數字加起來的**：

| 怎麼消失的 | 數量 | 有痕跡嗎 |
|---|---|---|
| 佇列滿了被**拒絕** | 約 2,500 | ⚠️ 有 —— `TaskRejectedException` 進了 log（6.2.5） |
| 關機時佇列被**丟掉** | **500** | 🔴 **完全沒有** |

⚠️ **而後面那 500 封是這一節的主題，因為「被丟掉」是完全靜默的** ——
沒有例外、沒有 log、沒有指標變化。

**實測**（6.2.8 有完整的實驗）：

```
[B4] shutdown 前，佇列 = 10
[B4] waitForTasksToCompleteOnShutdown=false → 執行完成的任務 = 0 / 10
[B4] waitForTasksToCompleteOnShutdown=true  → 執行完成的任務 = 10 / 10
```

**`waitForTasksToCompleteOnShutdown` 的預設值是 `false`。**

> 📌 **這個事故的一句話版本**：
> **`@Async` 的佇列是「記憶體」，而記憶體不會跟著部署一起活下來。**
>
> ⚠️ 而它有一個更難堪的版本：把 `waitForTasksToCompleteOnShutdown` 設成 `true`
> **只是把「丟掉 500 封」換成「部署卡住 8 分鐘」** ——
> 因為那 500 封要 500 ÷ 4 條執行緒 × 4 秒 ≈ 500 秒。**兩個都不是解法**（6.8 的 outbox 才是）。

### 事故 2：一個 ERP 的逾時，把整站打成 503

**現場**（2026-04-22 10:15，SRE 值班）：

```
警報：/api/orders 全部 503。而 /api/products 也 503。/health 也 503。
     資料庫 CPU 8%，很閒。應用的 CPU 12%，也很閒。
     ⚠️ 什麼都很閒，但什麼都不能用。
```

**這個事故 00 章 0.3.2 事故 1 提過**，但那時只說了結論。**現在看完整版**：

```java
@Service
public class OrderApplicationService {

    @Transactional                                   // ★ 交易在這裡開始
    public OrderResultView create(CreateOrderCommand cmd, Actor actor) {
        Order order = orderFactory.create(cmd, actor);
        order.lines().forEach(l -> stockPort.tryReserve(l.productId(), l.quantity()));
        orderRepository.save(order);

        erpPort.pushOrder(OrderSnapshot.from(order));  // 🔴 外部 HTTP 呼叫，在交易裡

        return OrderResultView.from(order, actor, clock.instant());
    }                                                // ★ 交易在這裡結束
}
```

**而 `ErpAdapter` 是這樣寫的**：

```java
@Component
public class ErpAdapter implements ErpPort {

    private final RestClient client;

    public ErpAdapter(RestClient.Builder builder, ErpProperties props) {
        this.client = builder.baseUrl(props.baseUrl()).build();
        // 🔴🔴 沒有設任何逾時
    }

    @Override
    @Retryable(maxAttempts = 3)                       // 🔴 而且會重試三次
    public void pushOrder(OrderSnapshot snapshot) {
        client.post().uri("/orders").body(snapshot).retrieve().toBodilessEntity();
    }
}
```

**那天 ERP 的機器沒有掛，它只是「不回應」**（網路分割，TCP 連線建立得起來但沒有回應）。

**於是**：

| 層次 | 值 | 說明 |
|---|---|---|
| `RestClient` 的預設讀取逾時 | ⚠️ **沒有**（無限等） | Boot 不會幫你設 |
| `@Retryable` 的次數 | 3 | 每次都無限等 |
| 一個請求佔住連線多久 | 🔴 **永遠** | |
| Hikari 連線池 | 20 | 20 張訂單之後，池子空了 |
| `connection-timeout` | 3 秒 | 第 21 個請求等 3 秒後失敗 |
| Tomcat 執行緒 | 200 | 全部卡在等連線或等 ERP |
| `/health` | 🔴 503 | 它也要一條 Tomcat 執行緒 |

⚠️⚠️ **注意「什麼都很閒」這件事**：CPU 沒事、資料庫沒事、記憶體沒事。
**耗盡的是「等待的容量」，而那個東西沒有出現在任何一張儀表板上。**

**這個事故有三個獨立的錯誤，而修掉任何一個都能避免它**：

| # | 錯誤 | 修法 | 哪一節 |
|---|---|---|---|
| 1 | **外部呼叫在交易裡** | 移到 `AFTER_COMMIT` | 6.3 |
| 2 | **沒有設逾時** | connect + read + 整體 | **6.5** |
| 3 | **無腦重試** | 重試要有預算與熔斷 | 6.6、6.7 |

> 📌 **而第 2 個是最便宜的**：兩行設定。
> ⚠️ **但只修第 2 個是不夠的** —— 6.5.4 會算給你看：
> **逾時 5 秒 × 重試 3 次 = 一個請求最多佔住連線 15 秒**，
> 而那仍然足以在促銷時打爆連線池。

### 事故 3：金流逾時，我們重試了，客戶被扣兩次款

**現場**（2026-02-14 情人節檔期 21:40，財務部門）：

```
財務：今天有 63 筆訂單，銀行帳上扣了兩次款。
     客戶已經在社群上抱怨了。
```

**程式碼**：

```java
@Retryable(retryFor = PaymentGatewayTimeoutException.class, maxAttempts = 3)
public PaymentResult pay(String orderId, ChargeRequest request) {
    ChargeResult result = paymentGateway.charge(request);
    // …
}
```

**而 `TapPayGateway.charge()` 是這樣拋例外的**（01 章 1.7.3）：

```java
} catch (ResourceAccessException e) {
    // ★★ 連線／讀取逾時 → 結果未知！絕對不可以當成失敗
    throw new PaymentGatewayTimeoutException(request.merchantTradeNo(), e);
}
```

⚠️ **那個註解是對的，而寫 `@Retryable` 的人沒有讀它。**

**發生了什麼**：

```
21:40:12.000  送出請求 → 金流商收到 → 開始處理
21:40:17.000  我們的讀取逾時（5 秒）到了 → 拋 PaymentGatewayTimeoutException
21:40:17.001  🔴 @Retryable 重試 → 送出【第二次】請求
21:40:17.800  金流商完成【第一次】的處理 → 扣款成功（但我們已經不在聽了）
21:40:22.000  金流商完成【第二次】的處理 → 🔴🔴 又扣一次
```

**`merchantTradeNo` 是冪等鍵**（01 章 1.7.2 明確寫了），
**而 `@Retryable` 重試時用的是同一個 `merchantTradeNo`** —— 所以理論上金流商應該擋掉。

⚠️ **理論上。** 而實際上：

| 金流商 | 冪等鍵的視窗 | 那天的情況 |
|---|---|---|
| A 家 | 24 小時 | ✅ 擋掉了 |
| B 家 | ⚠️ **「處理中」的請求不算** | 🔴 第二次進來時第一次還沒完成 → 兩筆都受理 |

> 🔴 **「對方有冪等」不是一個可以假設的事，是一個要驗證的事** ——
> 而**要驗證的不只是「有沒有」，還有「在什麼視窗內、處理中的請求算不算」**。

**04 章 4.9.1 定義的 `safeToRetryBlindly` 在這裡兌現**：

```java
UPSTREAM_TIMEOUT       (HttpStatus.GATEWAY_TIMEOUT, "upstream-timeout",
                        Retry.CHECK_STATUS),         // ★ 不是 BACKOFF_AND_RETRY
PAYMENT_OUTCOME_UNKNOWN(HttpStatus.GATEWAY_TIMEOUT, "payment-outcome-unknown",
                        Retry.CHECK_STATUS),
```

`Retry.CHECK_STATUS` 的意思是：**「不要重試，去查狀態」**。
而 `safeToRetryBlindly()` 對它回傳 `false`。

⚠️ **那是給【客戶端】看的。而事故 3 是【伺服器端】犯的同一個錯。**

> 📌 **這三個事故的共同結構**：
>
> | 事故 | 表面問題 | 真正的問題 |
> |---|---|---|
> | 1 | 信沒寄出去 | **「交給執行緒池」不等於「這件事會完成」** |
> | 2 | 整站 503 | **沒有逾時 = 沒有失敗，而「不會失敗」比「會失敗」危險** |
> | 3 | 重複扣款 | **「逾時」不是「失敗」，它是「不知道」** |
>
> **三個都不是「非同步很難」。**
> 三個都是**「跨越行程邊界之後，我們仍然用行程內的直覺在寫程式」**。

---

## 6.1 學習目標

讀完這一章，你可以：

- 說明 `@Async` 的代理機制，以及它與 `@Transactional`、`@Cacheable` **共用哪些失效情境、又多了哪兩個**。
- 說出 Spring Boot 3.2 的**預設執行緒池組態**，並解釋為什麼它的 `maxPoolSize` **永遠不會被用到**。
- 說明 `corePoolSize` / `queueCapacity` / `maxPoolSize` 的**成長順序**，以及為什麼它與直覺相反。
- 選擇拒絕策略，並說出 `CALLER_RUNS` 在 `AFTER_COMMIT` 場景的**具體後果**。
- 列出 `@Async` 之後**會消失的四個 ThreadLocal**，並說出「locale 不是變成 null，是變成錯的值」為什麼更糟。
- 解釋 `@Async` 方法拋例外時，**`void` 與 `CompletableFuture` 的處置完全不同**，以及哪一個會**靜默吞掉**。
- 說出交易與非同步的**四個衝突**，並用實測說明 `AFTER_COMMIT` 裡「不加 `REQUIRES_NEW` 的寫入」為什麼**看起來會動**。
- 設定 `RestClient` 的**四個層次的逾時**（6.5 從三個開始，而 6.5.4 會證明第四個是必要的），
  並說出只設一個為什麼不夠。
- 計算一條呼叫鏈的**逾時預算**，並說出「逾時 × 重試」的相乘效應。
- 判斷一個操作**可不可以重試**，並說出「逾時」與「明確失敗」在這件事上的決定性差別。
- 設定熔斷器，並說出它與 05 章 5.7.2 的降級**是同一件事的兩個層次**。
- 說明 outbox 模式解決了什麼、**沒有解決什麼**，以及為什麼它讓「事件遺失」變成「事件延遲」。
- 用 `Awaitility` 測試非同步，並說出 `Thread.sleep` 為什麼同時**又慢又不可靠**。

## 前置知識

| 需要 | 用在哪 |
|---|---|
| **02-spring-boot 04 章**（AOP 與代理） | 6.2 —— `@Async` 是第三個用同一套機制的註解 |
| **本站 02 章 2.7**（五種交易失效情境） | 6.2.3 —— `@Async` 有**六種** |
| **本站 02 章 2.12**（`@TransactionalEventListener`） | **6.3 整節** —— 這一章是那一節的完整版 |
| 本站 02 章 2.11（連線池與 TPS） | 6.0 事故 2、6.5.4 |
| 本站 04 章 4.9（`safeToRetryBlindly`） | **6.6.1** —— 那個方法在這裡兌現 |
| 本站 04 章 4.3.4（`SideEffectsCommitted`） | 6.6.5、6.10.3 |
| 本站 05 章 5.7.2（`CacheErrorHandler` 降級） | **6.7.2** —— 降級與熔斷的關係 |
| 本站 01 章 1.7（埠與轉接器） | 6.4、6.5 —— `PaymentGateway` 與 `ErpPort` 在這裡實作完 |

⚠️ **這一章與 02 章的關係最深。**
02 章 2.12 用了四頁講 `@TransactionalEventListener`，
並在 2.12.4 誠實地說「**它不是可靠的訊息傳遞**」。
**這一章 6.8 就是那句話的解法。**

---

## 6.2 `@Async` 與執行緒池 ★★

### 6.2.1 三個註解，同一套機制

**05 章 5.2.2 做過一次這個對照，這裡把第三個加進來**：

| | `@Transactional` | `@Cacheable` | **`@Async`** |
|---|---|---|---|
| 攔截器 | `TransactionInterceptor` | `CacheInterceptor` | **`AsyncExecutionInterceptor`** |
| 由誰註冊 | `@EnableTransactionManagement` | `@EnableCaching` | **`@EnableAsync`** |
| 代理型別 | JDK / CGLIB | 同 | **同** |
| 自呼叫會失效 | ✅ | ✅ | ✅ |
| `final` 方法會失效 | ✅ | ✅ | ✅ |
| **多一個限制** | — | — | 🔴 **回傳型別只能是 `void` 或 `Future`** |

⚠️ **「三個註解共用同一套代理」有一個實務上的後果**：
**它們可以疊在同一個方法上，而順序是由 advisor 的 `order` 決定的。**
05 章 5.2.2 已經把快取與交易的 order 明確設好了 ——
**6.3.2 會說明 `@Async` 必須在最外層，以及為什麼那不是一個選擇題。**

### 6.2.2 `@Async` 的六個步驟

```java
@Async
public void send(String to) { … }
```

呼叫 `mailer.send("a@example.com")` 時：

```
① 呼叫打到【代理】而不是 Mailer 本身
② AsyncExecutionInterceptor.invoke()
③ 決定用哪個 Executor
   ├─ @Async("xxx") 有指名 → 找名叫 xxx 的 bean
   ├─ 沒指名 → AsyncConfigurer.getAsyncExecutor()
   ├─ 沒有 AsyncConfigurer → 找唯一的 TaskExecutor bean
   └─ 都沒有 → ⚠️ SimpleAsyncTaskExecutor（每次開一條新執行緒！）
④ 把「呼叫原方法」包成一個 Callable
⑤ executor.submit(callable)   ← ★ 呼叫端在這裡就回來了
⑥ 依回傳型別決定給呼叫端什麼
   ├─ void            → 回 null
   ├─ Future<T>       → 回一個【尚未完成】的 Future
   └─ 其他            → 🔴 IllegalArgumentException（步驟 ⑥ 才拋！）
```

⚠️ **步驟 ⑥ 那個例外值得單獨看，因為它是【執行期】才拋的**：

```java
@Async
public String sendReturningString(String to) { return "sent"; }   // 🔴 編譯得過
```

**實測**：

```
[A4] 🔴 java.lang.IllegalArgumentException: Invalid return type for async method
     (only Future and void supported): class java.lang.String
[A4] ⚠️ 注意：它是【呼叫時】才拋，不是啟動時
```

> 🔴 **「啟動時不檢查」代表一個沒有被測試涵蓋的 `@Async` 方法
> 可以一路上到生產環境，然後在第一次被呼叫時炸掉。**
> 👉 6.11.5 有一條守門測試專門掃這個。

### 6.2.3 Boot 3.2 的預設執行緒池是什麼 ★★

**這一節的結論會讓大部分人意外。**

**實測**（`@EnableAsync` + Spring Boot 3.2.5，沒有任何自訂）：

```
[A1] 容器裡的 TaskExecutor bean = [applicationTaskExecutor]
[A1]   applicationTaskExecutor -> org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor
[A1]     core=8 max=2147483647 queueCapacity=2147483647 keepAlive=60
```

```
[A2] 呼叫端執行緒 = main
[A2] @Async 方法的執行緒 = task-2
```

**三件事值得注意**：

| # | 觀察 | 意義 |
|---|---|---|
| ① | 它**不是** `SimpleAsyncTaskExecutor` | Boot 的 `TaskExecutionAutoConfiguration` 提供了一個真的池子 —— **這是好消息** |
| ② | `core = 8` | 預設值，可由 `spring.task.execution.pool.core-size` 改 |
| ③ | 🔴 **`max = 2147483647`、`queueCapacity = 2147483647`** | **兩個都是 `Integer.MAX_VALUE`** |

⚠️⚠️ **③ 是一個陷阱，而它需要 6.2.4 的知識才看得出來為什麼。**

> 📌 **順帶一提「找唯一的 TaskExecutor bean」這條規則**：
> 如果你自己定義了**兩個** `ThreadPoolTaskExecutor` bean 而沒有 `AsyncConfigurer`，
> Spring 找不到「唯一的那個」→ 退回 `SimpleAsyncTaskExecutor`
> → **每次呼叫開一條新執行緒**（Spring 6.1 起可以配置成虛擬執行緒，但預設不是）。
> ⚠️ **而這個退回是靜默的**，只有一行 `INFO` 等級的訊息。

### 6.2.4 三個參數的成長順序（與直覺相反）★★

**直覺**：

```
core 滿了 → 開更多執行緒到 max → max 也滿了 → 才進佇列
```

**實際**：

```
core 滿了 → 【進佇列】 → 佇列也滿了 → 才開到 max → max 也滿了 → 拒絕
```

**實測**（`core=2, max=4, queueCapacity=3`，送 6 個會卡住的任務）：

```
[B1] 送 5 個（core=2 queue=3）→ poolSize = 2，佇列 = 3，已開始執行 = 2
[B1] 送第 6 個 → poolSize = 3，佇列 = 3，已開始執行 = 3
```

**送到第 5 個為止，池子裡永遠只有 2 條執行緒。** 第 6 個才讓它長到 3。

⚠️⚠️ **把這個規則套回 6.2.3 的預設值**：

```
core = 8
queueCapacity = 2147483647     ← 佇列永遠不會滿
max = 2147483647               ← 🔴 所以永遠不會被用到
```

**實測**（用 Boot 的預設值，送 1000 個會卡住的任務）：

```
[B2] 送 1000 個任務到「Boot 預設組態」的池子：
[B2]   poolSize = 8（max 是 2147483647）
[B2]   佇列長度 = 992
[B2] ⚠️ maxPoolSize 完全沒有作用 —— 佇列永遠不會滿
```

> 🔴 **`spring.task.execution.pool.max-size` 這個設定，在你沒有同時設
> `queue-capacity` 的情況下，是一個【完全沒有作用】的設定。**
>
> 而它的失敗方式最糟：**你設了它，你以為你設了上限，而你沒有。**

**三種組態的實際行為**：

| 組態 | 實際行為 | 適合 |
|---|---|---|
| `core=8, queue=∞, max=∞`（**Boot 預設**） | 固定 8 條 + 無限佇列 | 🔴 **沒有背壓**，記憶體會漲到 OOM |
| `core=8, queue=0, max=64` | 每個任務都開新執行緒直到 64 | 低延遲、任務很短 |
| `core=4, queue=500, max=8` | ★ 先排隊，排不下才擴充 | ✅ **shop-service 的選擇**（6.2.9） |

⚠️ **`queue=0` 那一列**（`SynchronousQueue`）值得知道：
它讓池子**優先擴充執行緒而不是排隊**，也就是大部分人「以為」的行為。
**Tomcat 的執行緒池就是這樣設計的**（它自訂了一個 `TaskQueue` 來達到這個效果）。

### 6.2.5 拒絕策略：四個選擇 ★

**佇列滿了、執行緒也開到 max 了，第 N+1 個任務怎麼辦？**

**實測**（`core=1, max=1, queue=1`，送第 3 個任務）：

```
[B3] ABORT       → 🔴 拋 TaskRejectedException；在呼叫端執行緒上跑掉的任務數 = 0
[B3] CALLER_RUNS → 沒有拋例外；在呼叫端執行緒上跑掉的任務數 = 1
[B3] DISCARD     → 沒有拋例外；在呼叫端執行緒上跑掉的任務數 = 0
```

| 策略 | 行為 | 代價 | 什麼時候用 |
|---|---|---|---|
| **`ABORT`**（JDK 預設） | 拋 `RejectedExecutionException`（Spring 包成 `TaskRejectedException`） | 呼叫端要處理 | ✅ **有 outbox 兜底時** |
| **`CALLER_RUNS`** | 在呼叫端執行緒上**同步執行** | 🔴 呼叫端被拖慢 | ✅ 沒有兜底、且「不能遺失」 |
| `DISCARD` | ⚠️ **靜默丟掉** | 🔴 沒有任何痕跡 | ❌ 幾乎永遠不對 |
| `DISCARD_OLDEST` | 丟掉佇列裡**最舊的** | 🔴 同上，而且丟的是等最久的 | ❌ 除非是「只要最新值」的場景 |

⚠️⚠️ **`CALLER_RUNS` 在 `AFTER_COMMIT` 場景有一個具體的後果**，
而 02 章 2.12.2 陷阱 ③ 已經提過：

> **`AFTER_COMMIT` 的「呼叫端」是那個剛 commit 完的 Tomcat 執行緒。**
> 於是通知的壓力會**回壓到請求執行緒上** —— 請求變慢，但不會遺失通知。

**而這一章要補上那句話的另一半**：

⚠️ **`CALLER_RUNS` 不只是「變慢」，它會讓「快取失效」的順序錯亂。**

```java
// 兩個 AFTER_COMMIT listener，都是 @Async
@Async("notificationExecutor") public void 寄信(OrderPlacedEvent e) { … }
@Async("notificationExecutor") public void 清快取(OrderPlacedEvent e) { … }
```

佇列滿的時候，`CALLER_RUNS` 讓「寄信」在 Tomcat 執行緒上跑
→ **那條執行緒被郵件 API 卡住 4 秒**
→ 🔴 **「清快取」也排在後面，於是快取有 4 秒的髒值**。

> 📌 **一句話**：
> **`CALLER_RUNS` 把「非同步的壓力」變成「同步的延遲」，
> 而那個延遲會傳染給【同一個池子裡的其他任務】。**
>
> 👉 6.2.9 的結論之一就是：**「不能遺失」與「可以遺失」的任務不要共用池子。**

### 6.2.6 `@Async` 之後，四個 ThreadLocal 全部消失 ★★

**實測**（呼叫端先設好四個 ThreadLocal，再呼叫 `@Async` 方法）：

```
[C1] 呼叫端：thread=main  traceId=TRACE-abc123 locale=ja_JP
             actor=CUSTOMER:C-9527 txActive=true  txName=createOrder
[C1] @Async ：thread=ctx-1 traceId=null          locale=zh_TW_#Hant
             actor=null            txActive=false txName=null
```

| ThreadLocal | 呼叫端 | `@Async` 之後 | 後果 |
|---|---|---|---|
| `MDC`（traceId） | `TRACE-abc123` | `null` | ⚠️ **日誌斷鏈** —— 出事時查不到是哪個請求引發的 |
| `LocaleContextHolder` | `ja_JP` | 🔴 **`zh_TW`** | 🔴🔴 **日本客戶收到中文的確認信** |
| 自訂的 `CURRENT_ACTOR` | `CUSTOMER:C-9527` | `null` | ⚠️ 稽核紀錄的「誰做的」變成 null 或 NPE |
| `TransactionSynchronizationManager` | `true / createOrder` | `false / null` | ✅ **這個是對的**（6.3.2） |

⚠️⚠️ **第二列是這張表的重點，請看清楚它不是 `null`**：

**`LocaleContextHolder.getLocale()` 在沒有設定時回傳 `Locale.getDefault()`
—— 也就是【這台機器的】語言。**

> 🔴 **「變成 null」會爆炸，「變成錯的值」不會。**
>
> 而不會爆炸的那個，會安靜地寄出 3,000 封語言錯誤的信，
> 直到有客戶抱怨為止。
>
> 👉 這正是 00 章 0.14.5 為 `StatusLabelResolver` 新增
> `label(Enum<?>, Locale)` 多載的原因 —— 那個修正**就是為了這一節**。

**三種處理方式**：

```java
// ✅ 解法 A（★ shop-service 的選擇）：把需要的東西【放進事件】
public record OrderPlacedEvent(
        …, Locale locale, String traceId, Instant occurredAt) implements DomainEvent { }
```

```java
// 解法 B：用 TaskDecorator 把 context 複製過去
public class ContextPropagatingTaskDecorator implements TaskDecorator {
    @Override
    public Runnable decorate(Runnable runnable) {
        // ★ 在【提交任務的】執行緒上抓快照
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        LocaleContext locale = LocaleContextHolder.getLocaleContext();
        SecurityContext security = SecurityContextHolder.getContext();

        return () -> {
            // ★ 在【執行任務的】執行緒上還原
            try {
                if (mdc != null) MDC.setContextMap(mdc);
                LocaleContextHolder.setLocaleContext(locale);
                SecurityContextHolder.setContext(security);
                runnable.run();
            } finally {
                // ⚠️⚠️ 這個 finally 不是可選的 ——
                //    池子裡的執行緒會被【重複使用】，不清掉就會洩漏給下一個任務
                MDC.clear();
                LocaleContextHolder.resetLocaleContext();
                SecurityContextHolder.clearContext();
            }
        };
    }
}
```

```java
// 解法 C（只處理 Security）：Spring Security 內建的包裝
executor = new DelegatingSecurityContextExecutor(realExecutor);
```

⚠️ **為什麼 shop-service 選 A 而不是 B**：

| | 解法 A（放進事件） | 解法 B（`TaskDecorator`） |
|---|---|---|
| 涵蓋範圍 | 只有事件裡有的欄位 | ✅ 所有 ThreadLocal |
| **重試之後還對嗎** | ✅ **對** —— 事件是不可變的快照 | 🔴 **不對** —— outbox 重送時原本的執行緒早就沒了 |
| 顯式程度 | ✅ 看事件的定義就知道 | 🔴 「它為什麼有 traceId」要追到 decorator |
| 跨行程 | ✅ 進 outbox / MQ 之後還在 | 🔴 完全消失 |

> 📌 **判準**：
> **凡是「這個任務可能被重送、被排隊、被搬到另一個行程」的資料，
> 就必須放進「任務本身」，而不是放在執行緒上。**
>
> ⚠️ 而 `TaskDecorator` 仍然要做 —— 它是 A **之外**的兜底，
> 負責那些「我們沒想到要放進事件裡」的東西（尤其是 `traceId`）。

### 6.2.7 `@Async` 的例外去哪了 ★★

**這一節有一個反直覺的結論：`void` 是安全的那個。**

**實測**：

```
[D1] 呼叫端沒有收到任何例外
[D1] AsyncUncaughtExceptionHandler 收到 =
     [voidBoom -> IllegalStateException(void 炸了) params=[ORD-001]]
```

```
[D2] 呼叫 futureBoom() 沒有立刻拋例外，f = CompletableFuture
[D2] f.get() 拋 ExecutionException cause=IllegalStateException
[D2] AsyncUncaughtExceptionHandler 收到 = []（空的 = Future 的例外【不】走 handler）
```

```
[D3] 呼叫了會炸的 futureBoom() 但沒有處理回傳值：
[D3]   handler 收到 = []
[D3]   ⚠️ 例外完全消失（沒有 log、沒有 handler、沒有例外）
```

**整理成表**：

| 回傳型別 | 例外去哪 | 會被發現嗎 |
|---|---|---|
| `void` | → `AsyncUncaughtExceptionHandler` | ✅ **會**（有設 handler 的話） |
| `void`（**沒設 handler**） | → `SimpleAsyncUncaughtExceptionHandler` → `log.error` | ⚠️ 只有 log |
| `Future<T>` + 呼叫端有 `get()` | → `ExecutionException` | ✅ 會 |
| 🔴 **`Future<T>` + 呼叫端丟掉回傳值** | **哪裡都沒有** | 🔴🔴 **完全不會** |

> 🔴 **最後一列是這一節的重點，而它是最常見的寫法**：
>
> ```java
> notificationService.sendAsync(event);      // 回傳 CompletableFuture，直接丟掉
> ```
>
> **它連 `log.error` 都不會有。**
> 而 `void` 版本至少會印一行 error。
>
> 👉 **所以「改成回傳 `CompletableFuture` 比較好」這個直覺是錯的** ——
> 除非你**真的**會去處理那個 future。

**shop-service 的兩條規則**：

```java
// ✅ 規則 1：@Async 的 listener 一律回 void，並設 AsyncUncaughtExceptionHandler
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) -> {
            // ★★ 這裡是「非同步任務失敗」的【唯一】集中點 —— 它必須有指標
            asyncFailures.increment(method.getDeclaringClass().getSimpleName(),
                                    method.getName());
            log.error("非同步方法失敗：{}#{} args={}",
                      method.getDeclaringClass().getSimpleName(), method.getName(),
                      Arrays.toString(params), ex);
        };
    }
}
```

```java
// ✅ 規則 2：回傳 CompletableFuture 的話，呼叫端【一定】要接
CompletableFuture<Void> f = erpPushService.pushAsync(snapshot);
f.exceptionally(ex -> { log.error("ERP 推送失敗", ex); return null; });
```

⚠️ **而規則 2 是靠人守的** —— 6.11.5 有一條 ArchUnit 規則把它變成 CI 的事。

### 6.2.8 關機：那 500 封信 ★★

**事故 1 的直接原因。**

```java
var executor = new ThreadPoolTaskExecutor();
executor.setWaitForTasksToCompleteOnShutdown(false);   // ★ 預設值
```

**實測**（佇列裡有 10 個任務時 shutdown）：

```
[B4] shutdown 前，佇列 = 10
[B4] waitForTasksToCompleteOnShutdown=false → 執行完成的任務 = 0 / 10
[B4] waitForTasksToCompleteOnShutdown=true  → 執行完成的任務 = 10 / 10
```

**Spring Boot 的三層設定，三層都要**：

```yaml
server:
  shutdown: graceful               # ★ ① 停止收新請求，等現有請求做完

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s  # ★ ② 每個關機階段最多等多久

  task:
    execution:
      shutdown:
        await-termination: true                # ★ ③ 等執行緒池把任務做完
        await-termination-period: 20s
```

⚠️ **③ 只影響 Boot 自動配置的 `applicationTaskExecutor`。**
**自己 `new` 出來的池子要自己設**：

```java
@Bean("notificationExecutor")
public ThreadPoolTaskExecutor notificationExecutor(AsyncProperties props) {
    var ex = new ThreadPoolTaskExecutor();
    ex.setCorePoolSize(props.notification().coreSize());
    ex.setMaxPoolSize(props.notification().maxSize());
    ex.setQueueCapacity(props.notification().queueCapacity());
    ex.setThreadNamePrefix("notify-");

    // ★★ 這兩行就是事故 1 的修正
    ex.setWaitForTasksToCompleteOnShutdown(true);
    ex.setAwaitTerminationSeconds(20);

    ex.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    ex.setTaskDecorator(new ContextPropagatingTaskDecorator());
    ex.initialize();
    return ex;
}
```

⚠️⚠️ **但這只是「比較好」，不是「解決了」。** 三個殘留的問題：

| 殘留問題 | 說明 |
|---|---|
| **20 秒不夠** | 事故 1 的 500 封 ÷ 4 條執行緒 × 4 秒 ≈ **8 分鐘**。20 秒之後剩下的仍然被丟掉 |
| **`kill -9` / OOM / 機器掛掉** | 🔴 **完全沒有機會執行任何關機邏輯** |
| **Kubernetes 的 `terminationGracePeriodSeconds`** | ⚠️ 預設 **30 秒**，之後直接 `SIGKILL`。它必須**大於** `timeout-per-shutdown-phase` + `await-termination-period` |

**三個數字必須一起看**：

```
terminationGracePeriodSeconds (K8s)   60s      ← ★ 必須是最大的
  └─ timeout-per-shutdown-phase       30s
       └─ await-termination-period    20s
```

> 🔴 **而即使三個都設對了，事故 1 仍然會發生** ——
> 只是從「丟掉 500 封」變成「丟掉 480 封」
> （20 秒裡 4 條執行緒只做得完 20 封）。
>
> **`@Async` 的佇列在記憶體裡，這件事沒有辦法用組態修好。**
> 👉 **6.8 的 outbox 才是解法**，而它的核心想法只有一句：
> **把「待辦事項」寫進資料庫，跟業務資料在同一個交易裡。**

### 6.2.9 shop-service 的三個執行緒池

**一個關鍵決定：不共用池子。**

| 池子 | core / max / queue | 拒絕策略 | 關機 | 裝什麼 |
|---|---|---|---|---|
| `notificationExecutor` | 4 / 8 / 500 | `CALLER_RUNS` | 等 20s | 確認信、簡訊、推播 |
| `integrationExecutor` | 2 / 4 / 200 | **`ABORT`** | 等 20s | ERP 推送、搜尋索引 |
| `cacheEvictExecutor` | 2 / 2 / 1000 | `CALLER_RUNS` | 等 5s | 清快取（05 章 5.3.5 解法 A） |

⚠️ **為什麼 `integrationExecutor` 用 `ABORT` 而通知用 `CALLER_RUNS`**：

| | 通知 | ERP 推送 |
|---|---|---|
| 有沒有兜底 | 🔴 **沒有**（遺失就是遺失） | ✅ **有 outbox**（6.8） |
| 佇列滿時該怎樣 | 回壓給呼叫端，讓它變慢但別丟 | ✅ **快速失敗**，outbox 之後會補送 |
| 遺失的後果 | 客戶沒收到信 | ⏳ ERP 晚幾分鐘拿到 |

> 📌 **判準一句話**：
> **有兜底就 `ABORT`（快速失敗），沒兜底就 `CALLER_RUNS`（回壓）。**
> **永遠不要用 `DISCARD`。**

⚠️ **而 `cacheEvictExecutor` 的 `queue=1000` 與 `awaitTermination=5s` 是刻意的**：
清快取的任務**極短**（一次 Redis 往返），所以佇列可以很長；
而它**可以遺失**（05 章 5.3.5 解法 C 的短 TTL 是兜底），所以關機時不值得等 20 秒。

**組態類別**（01 章 1.4.2 的 `@ConfigurationProperties` 用法）：

```java
package example.shop.common.async;

@ConfigurationProperties(prefix = "shop.async")
@Validated
public record AsyncProperties(
        @Valid @NotNull PoolSpec notification,
        @Valid @NotNull PoolSpec integration,
        @Valid @NotNull PoolSpec cacheEvict) {

    public record PoolSpec(
            @Min(1)  int coreSize,
            @Min(1)  int maxSize,
            @Min(0)  int queueCapacity,
            @NotNull RejectionPolicy rejectionPolicy,
            @NotNull Duration awaitTermination) {

        /**
         * ★★ 一個「把 6.2.4 那個陷阱變成啟動失敗」的檢查。
         *
         * <p>{@code queueCapacity} 很大而 {@code maxSize > coreSize} 時，
         * maxSize 實際上是一個【謊言】—— 佇列填滿之前它永遠不會被用到，
         * 而 500 個任務排隊時，沒有人會注意到池子還是只有 4 條執行緒。
         */
        public PoolSpec {
            if (maxSize < coreSize) {
                throw new IllegalArgumentException(
                        "maxSize(%d) 不可小於 coreSize(%d)".formatted(maxSize, coreSize));
            }
            if (queueCapacity > 2000 && maxSize > coreSize) {
                throw new IllegalArgumentException(
                        ("queueCapacity=%d 太大而 maxSize(%d) > coreSize(%d)："
                         + "佇列填滿之前 maxSize 永遠不會被用到（06 章 6.2.4）。"
                         + "要嘛把 queueCapacity 調小，要嘛讓 maxSize == coreSize。")
                                .formatted(queueCapacity, maxSize, coreSize));
            }
        }
    }

    public enum RejectionPolicy {
        ABORT, CALLER_RUNS;
        // ⚠️ 刻意【不提供】DISCARD 與 DISCARD_OLDEST —— 見 6.2.5
        public RejectedExecutionHandler toHandler() {
            return this == ABORT ? new ThreadPoolExecutor.AbortPolicy()
                                 : new ThreadPoolExecutor.CallerRunsPolicy();
        }
    }
}
```

> 📌 **注意 `RejectionPolicy` 只有兩個常數。**
> 這是 04 章反覆用的同一個手法：
> **把「不該做的選擇」從型別裡拿掉，比在文件裡寫「不要用 DISCARD」有效。**

```yaml
shop:
  async:
    notification:  { core-size: 4, max-size: 8, queue-capacity: 500,  rejection-policy: CALLER_RUNS, await-termination: 20s }
    integration:   { core-size: 2, max-size: 4, queue-capacity: 200,  rejection-policy: ABORT,       await-termination: 20s }
    cache-evict:   { core-size: 2, max-size: 2, queue-capacity: 1000, rejection-policy: CALLER_RUNS, await-termination: 5s }
```

⚠️ **這份 yaml 與 00 章 0.11.3 的版本有三處不同**，
而三處都是這一章的產出：

| 改了什麼 | 為什麼 |
|---|---|
| 新增 `cache-evict` 池 | 05 章 5.3.5 解法 A 的 listener 原本是同步的 |
| 新增 `await-termination` | 事故 1 |
| `rejection-policy` 只剩兩個合法值 | 6.2.5 |

### 6.2.10 執行緒池的可觀測性

**05 章 5.9 為快取做過一次這件事，這裡是同一個模式。**

```java
@Bean
public MeterBinder executorMetrics(Map<String, ThreadPoolTaskExecutor> executors) {
    return registry -> executors.forEach((name, ex) ->
            new ExecutorServiceMetrics(ex.getThreadPoolExecutor(), name, List.of())
                    .bindTo(registry));
}
```

**四個一定要看的指標**：

| 指標 | 意思 | 告警條件 |
|---|---|---|
| `executor.queued` | 佇列長度 | ⚠️ **持續 > 佇列容量的 50%** |
| `executor.active` | 忙碌中的執行緒 | 持續 == `maxPoolSize` |
| `executor.completed` | 累計完成 | 斜率突然變 0 |
| **`executor.rejected`**（🔴 Micrometer **沒有**內建） | 被拒絕的數量 | **> 0 就要看** |

⚠️⚠️ **最後一列是一個陷阱**：`ExecutorServiceMetrics` **不會**幫你數「被拒絕的任務」。
`CALLER_RUNS` 尤其危險 —— **它不拋例外，所以完全沒有痕跡**。

```java
/**
 * ★★ 會計數的 CALLER_RUNS。
 *
 * <p>原版的 {@link ThreadPoolExecutor.CallerRunsPolicy} 是靜默的：
 * 它把任務在呼叫端跑掉，而<b>沒有任何指標會變化</b>。
 * 於是「通知系統把下單 API 拖慢了」這件事，
 * 在儀表板上看起來像「下單 API 自己變慢了」。
 */
public class CountingCallerRunsPolicy implements RejectedExecutionHandler {

    private final Counter counter;
    private final RejectedExecutionHandler delegate = new ThreadPoolExecutor.CallerRunsPolicy();

    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        counter.increment();
        delegate.rejectedExecution(r, executor);
    }
}
```

> 📌 **這一節與 05 章 5.9 的結論是同一句話**：
> **降級是靜默的，所以降級一定要有指標。**
> `CALLER_RUNS` 是降級，`CacheErrorHandler` 也是降級 ——
> 兩者都會「讓系統看起來還活著」，而那正是它們需要被量測的原因。

---

## 6.3 交易與非同步 ★★

**這一節是整章的核心，而它可以濃縮成一句話**：

> **交易活在一條執行緒上。跨過執行緒邊界，交易就不在了。**

02 章 2.2.4 已經說過機制：交易的一切都掛在 `ThreadLocal` 上
（`TransactionSynchronizationManager` 的那兩個 ThreadLocal）。
**這一節在說那句話的四個後果。**

### 6.3.1 四個衝突的總表

| # | 寫法 | 會發生什麼 | 對嗎 |
|---|---|---|---|
| ① | `@Async` + `@Transactional` **在同一個方法上** | 在非同步執行緒開一個**全新的交易** | ⚠️ **能動，但幾乎不是你要的** |
| ② | `@Transactional` 的方法裡呼叫 `@Async` 方法 | 非同步執行緒**看不到**未提交的資料 | 🔴 **錯**（競態） |
| ③ | `AFTER_COMMIT` + `@Async` | ✅ **正確的組合** | ✅ |
| ④ | `AFTER_COMMIT` 裡寫資料庫，沒有 `REQUIRES_NEW` | ⚠️ **看起來會動**（見 6.3.5） | 🔴 **錯** |

**四個都有實測，一個一個看。**

### 6.3.2 ① `@Async` + `@Transactional` 在同一個方法上

```java
@Async
@Transactional
public void asyncAndTransactional(String id) {
    jdbc.update("insert into orders values (?,?)", id, "PAID");
    throw new IllegalStateException("非同步交易裡炸了");
}
```

**實測**：

```
[E3] asyncAndTransactional: thread=tx-async-1 txActive=true
     txName=…$Orders.asyncAndTransactional
[E3] 訂單在資料庫裡嗎 = false（false = 非同步執行緒【自己的】交易 rollback 了）
```

**它能動。** 非同步執行緒上開了一個**全新的**交易，rollback 也正確。

⚠️ **但有三件事要知道**：

| 事實 | 後果 |
|---|---|
| **`@Async` 必須在外層** | 否則就變成「在原交易裡提交一個任務」（= 情況 ②） |
| 呼叫端**完全不知道**它成功了沒 | 回傳 `void` → 例外只會進 `AsyncUncaughtExceptionHandler` |
| 它**佔用一條連線** | 🔴 非同步池的大小要納入連線池的計算（02 章 2.11） |

**「`@Async` 必須在外層」不是選擇題，而 Spring 已經幫你決定了**：

```java
// AbstractAsyncConfiguration / ProxyAsyncConfiguration
AsyncAnnotationBeanPostProcessor bpp = new AsyncAnnotationBeanPostProcessor();
bpp.setOrder(this.enableAsync.getNumber("order"));    // ★ 預設 Ordered.LOWEST_PRECEDENCE
```

⚠️ **預設是 `LOWEST_PRECEDENCE`（最內層），而那是錯的方向。**

```java
@EnableAsync(order = Ordered.HIGHEST_PRECEDENCE)      // ★★ 明確設成最外層
```

**三個註解的完整順序**（05 章 5.2.2 定了前兩個，這裡補第三個）：

```java
@EnableAsync(order = Ordered.HIGHEST_PRECEDENCE)                    //  最外層
@EnableCaching(order = Ordered.HIGHEST_PRECEDENCE + 100)
@EnableTransactionManagement(order = Ordered.HIGHEST_PRECEDENCE + 200)  // 最內層
```

**為什麼是這個順序**：

```
呼叫進來
  │
  ├─ @Async      ── 換一條執行緒（★ 一定要最先，否則後面兩個都在錯的執行緒上）
  │    │
  │    ├─ @Cacheable ── 命中就直接回（★ 在交易外層 = 命中時不開交易，5.2.2）
  │    │    │
  │    │    └─ @Transactional ── 開交易
  │    │         │
  │    │         └─ 你的方法
```

> 📌 **一句話**：**外層負責「要不要進去」，內層負責「進去之後的資源」。**
> 換執行緒比查快取更「外面」，查快取比開交易更「外面」。

### 6.3.3 ② 在交易裡呼叫 `@Async` 方法 🔴

**這是最常見的錯誤，而它的失敗是【機率性】的。**

```java
@Transactional
public void placeThenCallAsync(String id) {
    jdbc.update("insert into orders values (?,?)", id, "PAID");
    listeners.asyncReadOrder(id);       // ← 另一條執行緒【立刻】去讀這張訂單
    // … 交易還要跑一陣子才 commit
}
```

**實測**：

```
[E4] asyncReadOrder（另一條執行緒，交易還沒 commit）：看得到訂單嗎=false
[E4] 最後訂單在資料庫裡嗎 = false
```

**非同步執行緒看不到那張訂單。** 因為：

| | |
|---|---|
| 非同步執行緒有自己的連線 | 它**不是**呼叫端那條 |
| 隔離等級 | `READ_COMMITTED`（或 MySQL 的 `REPEATABLE_READ`）—— **都看不到未提交的資料** |
| 於是 | 🔴 `OrderNotFoundException`，或更糟：**靜默地什麼都沒做** |

⚠️⚠️ **而它是機率性的**：

```
非同步執行緒【慢】了一點（池子忙、GC）→ 交易已經 commit → ✅ 看得到 → 測試通過
非同步執行緒【快】了一點            → 交易還沒 commit → 🔴 看不到 → 生產環境失敗
```

> 🔴 **「在本機測試 200 次都對，上線第一天就錯 3 次」的典型形狀。**
> 本機的交易短（沒有網路延遲、沒有鎖等待），所以幾乎總是「非同步比較慢」。

**修法只有一個：把它移到 `AFTER_COMMIT`。**

```java
// ✅ 正確
@Transactional
public void place(String id) {
    jdbc.update("insert into orders values (?,?)", id, "PAID");
    events.publish(OrderPlacedEvent.from(order, email, now));   // 只發事件
}

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async("integrationExecutor")
public void onOrderPlaced(OrderPlacedEvent event) { … }         // commit 之後才跑
```

**⚠️ 而 6.11.5 有一條守門測試**，用 ArchUnit 擋掉
「`@Transactional` 的方法直接呼叫 `@Async` 的方法」。

### 6.3.4 ③ `AFTER_COMMIT` + `@Async`：正確的組合 ✅

**實測**（一張訂單成立，三種 listener 各跑一次）：

```
[E1] plainListener:      thread=main       txActive=true  看得到訂單嗎=true
[E1] placeThenSucceed 方法結束（尚未 commit）@main
[E1] syncAfterCommit:    thread=main       txActive=true  看得到訂單嗎=true
[E1] asyncAfterCommit:   thread=tx-async-2 txActive=false 看得到訂單嗎=true
```

**四行輸出裡有四個知識點**：

| 行 | 觀察 | 意義 |
|---|---|---|
| 1 | `@EventListener`（一般的）**在方法還沒結束時就跑了** | 🔴 它是**同步、在交易內**的 —— 它看得到未提交的資料，而它會被 rollback 影響 |
| 2 | 方法結束時**還沒 commit** | 交易的邊界是**代理**，不是方法本體（02 章 2.2.2） |
| 3 | `syncAfterCommit` 的 **`txActive` 仍然是 `true`** | ⚠️⚠️ **這正是 02 章 2.12.3 說的**：commit 完了，但綁定還沒解除 |
| 4 | `asyncAfterCommit` 的 `txActive` **是 `false`** | ✅ `@Async` 換了執行緒 → ThreadLocal 是乾淨的 |

**rollback 時呢**：

```
[E2] rollback 之後，跑過的 listener：
[E2]   plainListener: thread=main txActive=true 看得到訂單嗎=true
[E2] 訂單在資料庫裡嗎 = false
```

🔴 **只有 `plainListener` 跑了，而它「看到」了一張最後不存在的訂單。**

> 📌 **這一格是 `@EventListener` 與 `@TransactionalEventListener` 的全部差別**：
>
> | | `@EventListener` | `@TransactionalEventListener(AFTER_COMMIT)` |
> |---|---|---|
> | 什麼時候跑 | **`publishEvent()` 的那一行** | commit 之後 |
> | 在交易裡嗎 | ✅ 是 | 🔴 不是（雖然 `txActive` 說是） |
> | rollback 時 | 🔴 **已經跑過了** | ✅ 不跑 |
> | 拋例外時 | 🔴 **整個交易 rollback** | 傳給呼叫端（2.12.2 陷阱 ②） |
>
> **「用錯註解」的後果是「訂單 rollback 了但信已經寄出去」** ——
> 也就是 00 章 0.3.2 的事故 2。

**⚠️ 沒有交易的時候呢**（02 章 2.12.2 陷阱 ①）：

```
[E7] 沒有交易的情況下發事件，跑過的 listener：
[E7]   plainListener: thread=main txActive=false 看得到訂單嗎=false
[E7] ⚠️ 只有 plainListener → AFTER_COMMIT 的兩個【靜默地】沒有執行
```

**確認：完全靜默。** 沒有例外、沒有警告、沒有 log。
02 章 2.12.2 的 `EventPublisherWithTransactionCheck` 就是為了這個。

### 6.3.5 ④ `AFTER_COMMIT` 裡寫資料庫：一個「看起來會動」的錯誤 🔴🔴

**02 章 2.12.3 說**：不加 `REQUIRES_NEW` 的話，
「**靜默地不生效，或在 `cleanup` 把 `autoCommit` 設回 `true` 時被意外帶著 commit
—— 行為取決於驅動**」。

**這一章實測了它。結果是後者：**

```
[E5] 沒有 REQUIRES_NEW：points 裡有幾筆 = 1
[E5] 有 REQUIRES_NEW  ：points 裡有幾筆 = 1
```

🔴🔴 **兩個都成功了。也就是說，錯的寫法在測試裡是綠燈。**

⚠️ **而下面這一行證明了它為什麼仍然是錯的**：

```
[E5] writeWithoutRequiresNew: 寫入了 points，txActive=true
[E5] writeWithoutRequiresNew: 從另一條連線看得到嗎 = false
```

**在 listener 執行的當下，那筆 INSERT 從別條連線看不到。**

**完整的機制**（對照 02 章 2.2.2 的步驟）：

```
⑫ connection.commit()                     ← 業務資料在這裡被 commit
⑬ AFTER_COMMIT listener 開始跑
   │
   ├─ jdbc.update("insert into points …")
   │    └─ DataSourceUtils.getConnection() 拿到【ThreadLocal 上綁著的那條】
   │       ⚠️ 那條連線的 autoCommit 仍然是 false（begin 時設的）
   │       → INSERT 進了一個【新的、沒有人管理的】交易
   │
   ├─ ★ 此刻從別條連線看：看不到（實測 false）
   │
⑮ cleanupAfterCompletion
   └─ DataSourceUtils.resetConnectionAfterTransaction()
        └─ con.setAutoCommit(true)
             └─ 🔴 JDBC 規範：setAutoCommit(true) 會 commit 當前交易
                  → 那筆 INSERT 【意外地】被 commit 了
```

⚠️⚠️ **「意外地被 commit」為什麼是災難而不是好運**：

| 問題 | 說明 |
|---|---|
| **它不受任何交易語意保護** | listener 裡有兩個 INSERT，第二個失敗 → 🔴 **第一個仍然會被 commit** |
| **`@Transactional` 的 rollback 規則不適用** | 因為根本沒有交易管理器在管它 |
| 🔴 **它取決於驅動與連線池** | `HikariCP` 的 `autoCommit` 設定、驅動對 `setAutoCommit` 的實作 |
| **測試會通過** | H2 上是綠的，於是這個 bug 會一路上線 |

> 🔴 **這是本章最重要的一個「實測推翻直覺」的地方**：
> **02 章寫「行為取決於驅動」的時候是保守的說法。
> 實測告訴我們：在最常見的測試環境（H2 + Hikari）上，
> 錯誤的寫法【會通過測試】。**
>
> 👉 所以這一條**不能靠測試守，只能靠 ArchUnit 守**（6.11.5 規則 3）。

**正確的寫法**：

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Transactional(propagation = Propagation.REQUIRES_NEW)     // ★★ 沒有例外
@Async("integrationExecutor")
public void onOrderPlaced(OrderPlacedEvent event) {
    points.grant(event.customerId(), 100);
}
```

⚠️ **注意加了 `@Async` 之後，`REQUIRES_NEW` 就【不再是必要的】**
（換了執行緒 → ThreadLocal 乾淨 → `REQUIRED` 也會開新交易）。

**那為什麼還要寫？** 三個理由：

| 理由 | 說明 |
|---|---|
| ① | **拿掉 `@Async` 時它不會突然壞掉**（而拿掉 `@Async` 是一個很常見的除錯動作） |
| ② | **意圖明確** —— 讀的人不必先確認「這個 listener 有沒有 `@Async`」 |
| ③ | ArchUnit 規則可以直接檢查「`AFTER_COMMIT` 的 listener 有沒有 `REQUIRES_NEW`」 |

### 6.3.6 一張「四種組合」的決策表 ★★

**05 章 5.3.4 為快取做過同樣的表，這裡是非同步版：**

| 我要做的事 | 正確寫法 | 為什麼 |
|---|---|---|
| commit 之後**寄信 / 推播** | `AFTER_COMMIT` + `@Async` + 自己 catch | 可以遺失（00 章 0.3.1） |
| commit 之後**清快取** | `AFTER_COMMIT` + `@Async` + 短 TTL 兜底 | 05 章 5.3.5 解法 A |
| commit 之後**寫另一張表**（點數、稽核） | `AFTER_COMMIT` + `@Async` + **`REQUIRES_NEW`** | 6.3.5 |
| commit 之後**呼叫外部 API**（ERP、金流） | ⚠️ **outbox**（6.8） | 不能遺失，而事件會遺失 |
| commit **之前**做最後檢查 | `BEFORE_COMMIT` | 拋例外會 rollback —— 那正是要的 |
| **必須與業務資料原子** | 🔴 **不要用事件** —— 就寫在同一個交易裡 | 00 章 0.3.1 第一類 |
| 呼叫端**需要知道結果** | 🔴 **不要用 `@Async`** —— 同步做完 | 非同步 = 放棄知道結果 |

> 📌 **最後一列是最常被違反的一條**：
> **「加個 `@Async` 讓它快一點」的前提是「呼叫端不在乎結果」。**
> 如果呼叫端在乎，那它就得等 —— 而那時 `@Async` 只是把等待從
> 「一條執行緒」搬到「兩條執行緒 + 一次交接」，**變得更慢**。

---

## 6.4 `RestClient`：外部呼叫的基礎

### 6.4.1 四個 client，怎麼選

01 章 1.7.3 的 `TapPayGateway` 用了 `RestClient`，這一節解釋為什麼。

| Client | 狀態 | 阻塞？ | 什麼時候用 |
|---|---|---|---|
| `RestTemplate` | ⚠️ **維護模式**（不會再加功能，但不會移除） | 阻塞 | 只有既有程式碼 |
| **`RestClient`**（Spring 6.1+） | ✅ **新的預設** | 阻塞 | ✅ **shop-service 的選擇** |
| `WebClient` | ✅ 完整支援 | 非阻塞 | 需要**反應式**或**大量並行外部呼叫** |
| `@HttpExchange` 介面 | ✅ 宣告式（底層是上面三者之一） | 依底層 | 契約穩定的內部服務 |

⚠️ **「用 `WebClient` 比較快」是一個常見的誤解。**

**它在單一呼叫上並不比較快** —— 它省的是**執行緒**。

| | 阻塞（`RestClient`） | 非阻塞（`WebClient`） |
|---|---|---|
| 一個等待中的外部呼叫佔用 | **一條執行緒** | 幾乎不佔 |
| 200 個並行外部呼叫需要 | 200 條執行緒 | 少數幾條 event loop |
| 除錯難度 | ✅ 堆疊完整 | 🔴 堆疊斷掉 |
| 與 `@Transactional` 相容 | ✅ | 🔴 **交易在 ThreadLocal 上，反應式鏈會換執行緒** |

> 📌 **shop-service 選 `RestClient` 的理由是最後一列**：
> 這是一個**有交易的、阻塞式的**應用。
> 在裡面放一段反應式的鏈，會得到「兩種併發模型的所有缺點」。
>
> ⚠️ **而如果你的服務要 fan-out 呼叫 20 個下游**，那 `WebClient` 是對的 ——
> 那時「省執行緒」不是優化，是**可行性**。

### 6.4.2 🔴 一個沒有人告訴你的預設值

**實測**（`spring-boot-starter-web`，沒有任何額外相依）：

```
[G1] Boot 選的 ClientHttpRequestFactory = org.springframework.http.client.SimpleClientHttpRequestFactory
[G1] classpath 上有 Apache HttpClient 5 嗎 = false
```

**`SimpleClientHttpRequestFactory` 用的是 JDK 的 `HttpURLConnection`，而它：**

| | |
|---|---|
| 連線池 | 🔴 **沒有**（`HttpURLConnection` 的 keep-alive 是 JVM 全域、不可設定的） |
| 每次呼叫 | 重新做 TCP 握手 + TLS 握手 |
| TLS 握手的成本 | ⚠️ **30～100ms**，而它發生在**每一次**呼叫上 |
| 併發上限 | 由 `http.maxConnections` 系統屬性控制（**預設 5**！） |

**加一個相依就換掉它**：

```xml
<dependency>
    <groupId>org.apache.httpcomponents.client5</groupId>
    <artifactId>httpclient5</artifactId>
</dependency>
```

**實測**（加了之後，同一段程式碼）：

```
[G1] Boot 選的 ClientHttpRequestFactory = org.springframework.http.client.HttpComponentsClientHttpRequestFactory
[G1] classpath 上有 Apache HttpClient 5 嗎 = true
```

⚠️⚠️ **注意這件事是【靜默】發生的**：
`ClientHttpRequestFactories.get()` 按 classpath 順序挑實作
（Apache HttpClient 5 → Jetty → OkHttp → JDK），
**沒有任何 log 告訴你它挑了誰**。

> 🔴 **兩個方向的意外**：
> - 你**以為有連線池**，其實沒有（少了相依）→ 每次 TLS 握手。
> - 某個 transitive 相依**帶進了 httpclient5** → 行為（連線池、重導向、逾時語意）
>   在你不知情的情況下換了一套。
>
> 👉 **所以 shop-service 明確地建構它，而不是依賴自動偵測**（6.4.3）。

### 6.4.3 明確建構一個 `RestClient`

```java
package example.shop.common.http;

/**
 * 對外 HTTP 客戶端的工廠。
 *
 * <p>★★ 這個類別存在的理由是「不要依賴自動偵測」（6.4.2）：
 * 每一個外部系統的 client 都<b>明確地</b>宣告
 * 它的逾時、連線池大小與錯誤處理。
 *
 * <p>⚠️ 它<b>不是</b>一個 {@code RestClient} bean —— 是一個工廠。
 * 理由：{@code ErpPort} 與 {@code PaymentGateway} 的逾時<b>必須不同</b>
 * （6.5.5），而共用一個 bean 會讓它們被迫相同。
 */
@Component
public class OutboundClients {

    private final RestClient.Builder builder;
    private final ObservationRegistry observations;

    public RestClient create(String name, HttpClientSpec spec) {
        PoolingHttpClientConnectionManager pool =
                PoolingHttpClientConnectionManagerBuilder.create()
                        // ★ 總連線數與「每個 route（host:port）」的連線數是兩個值
                        //   ⚠️ 預設分別是 25 與 5 —— 而 5 這個值幾乎總是太小
                        .setMaxConnTotal(spec.maxConnections())
                        .setMaxConnPerRoute(spec.maxConnections())
                        .setDefaultConnectionConfig(ConnectionConfig.custom()
                                .setConnectTimeout(Timeout.of(spec.connectTimeout()))
                                .setSocketTimeout(Timeout.of(spec.readTimeout()))
                                // ★★ 池子裡的連線超過這個時間沒用就丟掉
                                //   ⚠️ 它必須【小於】對方的 keep-alive，否則會拿到已被對方關閉的連線
                                //   → 「NoHttpResponseException」的頭號成因
                                .setTimeToLive(TimeValue.ofMinutes(1))
                                .build())
                        .build();

        CloseableHttpClient httpClient = HttpClients.custom()
                .setConnectionManager(pool)
                .setDefaultRequestConfig(RequestConfig.custom()
                        // ★★★ 第三個逾時：向【連線池】要一條連線最多等多久
                        //     6.5.1 會說明為什麼漏掉它是最常見的錯
                        .setConnectionRequestTimeout(Timeout.of(spec.connectionRequestTimeout()))
                        .build())
                // ⚠️ 預設會自動重試冪等方法（GET/HEAD/…）—— 我們要自己控制重試（6.6）
                .disableAutomaticRetries()
                .build();

        return builder.clone()
                .baseUrl(spec.baseUrl())
                .requestFactory(new HttpComponentsClientHttpRequestFactory(httpClient))
                .requestInterceptor(new TraceHeaderInterceptor())       // 6.4.4
                .observationRegistry(observations)                       // ★ 指標
                .observationConvention(new NamedClientConvention(name))
                .defaultStatusHandler(new OutboundStatusHandler(name))   // 6.4.5
                .build();
    }
}
```

⚠️ **`disableAutomaticRetries()` 那一行值得停一下。**

Apache HttpClient 5 **預設會自動重試**冪等的方法（`GET`、`HEAD`、`PUT`、`DELETE`、`OPTIONS`、`TRACE`）
最多 1 次，在 `IOException` 時。

**問題不是「重試」，是「你不知道它在重試」**：

| 後果 | 說明 |
|---|---|
| 逾時預算被**悄悄地乘以 2** | 你算的 5 秒實際上是 10 秒 |
| 指標對不上 | 上游的「呼叫次數」與下游的「收到次數」永遠差一截 |
| 與你自己的 `@Retry` **相乘** | 3 次 × 2 = **6 次**（6.6.4） |

> 📌 **原則**：**重試只能有一個地方負責。**
> shop-service 讓 Resilience4j 負責（6.6），所以底層的自動重試一律關掉。

### 6.4.4 攔截器：traceId 一定要往下傳

```java
/**
 * 把 traceId 放進外送的請求。
 *
 * <p>⚠️ 這是 6.2.6 那張表的另一半：
 * {@code @Async} 讓 traceId 消失在<b>行程內的執行緒邊界</b>上，
 * 而少了這個攔截器，traceId 會消失在<b>行程之間的邊界</b>上。
 */
public class TraceHeaderInterceptor implements ClientHttpRequestInterceptor {

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body,
                                        ClientHttpRequestExecution execution) throws IOException {
        // ★ 04-controller 4.5.2 的 TraceContext：traceId 存在 MDC 裡，常數也在那裡
        String traceId = MDC.get(TraceContext.MDC_TRACE_ID);
        if (traceId != null) {
            request.getHeaders().set(TraceContext.HEADER_TRACE_ID, traceId);
        }
        return execution.execute(request, body);
    }
}
```

⚠️ **注意它讀的是 `MDC`（而 MDC 的底層就是 ThreadLocal）**，
所以在 `@Async` 的執行緒上它是 `null` —— **除非 6.2.6 的 `TaskDecorator` 有裝上**
（6.2.6 的實測 `[C1]` 顯示 `traceId=null`，就是這件事）。

> 📌 **兩件事必須一起做**：
> `TaskDecorator`（行程內傳遞）+ 攔截器（跨行程傳遞）。
> **只做一個，鏈就會在某一段斷掉，而斷掉的那一段正是出事時要查的那一段。**

### 6.4.5 錯誤處理：把 HTTP 狀態翻譯成我們的語言

**`RestClient` 的預設行為**：4xx/5xx → 拋 `RestClientResponseException`。

⚠️ **而 01 章 1.7.3 已經定下了規則**：
**轉接器的職責是翻譯，`application` 層不可以看到任何 HTTP 的東西。**

```java
/**
 * ★★ 把「HTTP 的失敗」翻譯成「我們的失敗」，而翻譯的判準只有一個：
 *
 * <blockquote><b>對方到底有沒有處理我們的請求？</b></blockquote>
 *
 * <p>這個判準決定了「可不可以重試」（6.6.1），而它與 HTTP 狀態碼<b>不是一對一</b>。
 */
public class OutboundStatusHandler implements ResponseErrorHandler {

    private final String clientName;

    @Override
    public void handleError(URI url, HttpMethod method, ClientHttpResponse response)
            throws IOException {
        HttpStatusCode status = response.getStatusCode();
        String bodyExcerpt = readExcerpt(response);        // ⚠️ 最多 512 字，且只進日誌

        throw switch (status.value()) {
            // ★ 429：對方明確說「太快了」→ 可以退避後重試
            case 429 -> new UpstreamRateLimitedException(
                    clientName, retryAfter(response), bodyExcerpt);

            // ★★ 502 / 503：對方【可能】根本沒收到 → 可以重試
            case 502, 503 -> new UpstreamUnavailableException(clientName, status.value(), bodyExcerpt);

            // ★★★ 504：對方【收到了】但它的下游逾時 → 🔴 結果未知，不可盲目重試
            case 504 -> new UpstreamOutcomeUnknownException(clientName, bodyExcerpt);

            // ⚠️ 4xx（429 以外）：是【我們】送錯了 → 程式錯誤，重試永遠不會成功
            default -> status.is4xxClientError()
                    ? new OutboundRequestRejectedException(clientName, status.value(), bodyExcerpt)
                    : new UpstreamUnavailableException(clientName, status.value(), bodyExcerpt);
        };
    }
}
```

⚠️⚠️ **`502/503` 與 `504` 分開處理是這個類別最重要的一行。**

| 狀態 | 語意 | 對方處理了嗎 | 可以重試嗎 |
|---|---|---|---|
| **502 Bad Gateway** | 閘道連不上後端 | ❌ 幾乎確定沒有 | ✅ **可以** |
| **503 Service Unavailable** | 對方明確說「我不行」 | ❌ 沒有 | ✅ **可以** |
| **504 Gateway Timeout** | 閘道等後端等到逾時 | ⚠️ **不知道** | 🔴 **不可以** |
| 連線逾時（`ResourceAccessException`） | 連都連不上 | ❌ 沒有 | ✅ 可以 |
| **讀取逾時**（`ResourceAccessException`） | 送出去了但沒等到回應 | ⚠️ **不知道** | 🔴 **不可以** |

> 🔴 **最後兩列都是 `ResourceAccessException`，而它們的可重試性完全相反。**
>
> **這是 6.0 事故 3 的根本原因**：
> `catch (ResourceAccessException e) { throw new PaymentGatewayTimeoutException(...); }`
> 把「連不上」與「等不到回應」歸成了同一種例外，
> 然後 `@Retryable` 對兩者一視同仁。
>
> 👉 **6.6.1 會把這條分岔補上**（用 `SocketTimeoutException` 的訊息區分是不夠的 ——
> 要靠 `HttpClientContext` 或自訂的 `ExecChainHandler`）。

---

## 6.5 逾時的三個層次 ★★

### 6.5.1 三個逾時，缺一不可

**大部分人知道兩個。而漏掉的那一個最常出事。**

| # | 逾時 | 管什麼 | 漏掉的後果 |
|---|---|---|---|
| ① | **connect timeout** | TCP 握手（+ TLS） | 對方機器不見了 → 等到 OS 的預設值（Linux 約 **130 秒**） |
| ② | **read / socket timeout** | ⚠️ **兩個 byte 之間**最多等多久 | 對方接受連線但不回應 → **永遠等下去** |
| ③ | 🔴 **connection request timeout** | 向**連線池**要一條連線最多等多久 | 🔴🔴 **池子被榨乾時，等待完全不受控** |

⚠️⚠️ **③ 是最常被漏掉的，而它的失敗方式最隱蔽**：

```
連線池大小 = 20
下游變慢，20 條連線全部在等（每條最多 5 秒，因為 read timeout 有設）
  ↓
第 21 個請求：向池子要連線
  ↓
🔴 沒有 connectionRequestTimeout → 它會【無限期】等一條連線
  ↓
Tomcat 的 200 條執行緒逐一卡在「等連線池」上
```

> 🔴 **注意這裡的荒謬之處**：
> **你設了 read timeout 5 秒，而一個請求仍然可以卡住 5 分鐘** ——
> 因為那 5 分鐘花在「排隊等一條連線」，而排隊不受 read timeout 管。
>
> 這與 00 章 0.11.3 的 `hikari.connection-timeout` 是**完全相同的道理**，
> 只是換成了 HTTP 連線池。

**Apache HttpClient 5 的預設值**：

| 逾時 | 預設 | 該設成 |
|---|---|---|
| connect | 3 分鐘 | **1～2 秒**（同機房 200ms 就夠） |
| socket（read） | ⚠️ **無限** | 依下游而定（6.5.5） |
| connection request | **3 分鐘** | ⚠️ **必須很短**（100～500ms） |

### 6.5.2 實測：預設的 `RestClient` 真的會永遠等下去

**實驗設計**：起一個 `ServerSocket`，**接受連線但永遠不回應**。

```java
var c = RestClient.builder().baseUrl("http://localhost:" + port).build();  // 不設任何逾時
```

**實測**：

```
[F1] RestClient.builder() 不設逾時，打一個「接受連線但不回應」的伺服器…
[F1] 8 秒後執行緒還活著嗎 = true（true = 🔴 預設【沒有】讀取逾時，它會一直等下去）
```

**設了之後**：

```
[F2 read=3s] 3028 ms → ResourceAccessException ← SocketTimeoutException : Read timed out
[F3 connect=2s read=30s] 2004 ms → ResourceAccessException ← SocketTimeoutException : Connect timed out
```

⚠️ **注意 F2 與 F3 拋的是【同一種】例外**（`ResourceAccessException`），
只有 `cause` 的訊息不同（`Read timed out` vs `Connect timed out`）——
而 6.4.5 說過，這兩者的**可重試性完全相反**。

**「只設 read timeout」的實測**（打一個黑洞位址）：

```
[F4] 只設 read=3s、【不設】connect，打黑洞位址：
[F4 read=3s only] 4028 ms → ResourceAccessException ← SocketException : Network is unreachable
```

⚠️ **4028 ms > 3000 ms** —— read timeout **沒有**限制住連線階段。
（這台機器上作業系統在 4 秒後回報 unreachable；
**在真正的網路分割上，Linux 的預設是 130 秒左右**，而那才是事故 2 的樣子。）

### 6.5.3 🔴 read timeout 抓不到的那一種慢

**這是本節最重要的一個實驗，而它的結論會讓人不舒服。**

**`read timeout` 的定義是「兩個 byte 之間最多等多久」，不是「整個回應最多多久」。**

**實驗設計**：一個伺服器回 `Transfer-Encoding: chunked`，
**每 500ms 送一小塊，永遠不結束**。read timeout 設 3 秒。

```java
out.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".getBytes());
for (int i = 0; i < 600; i++) {
    out.write("1\r\nx\r\n".getBytes());     // 一個 byte
    out.flush();
    Thread.sleep(500);                       // ★ 500ms < 3s 的 read timeout
}
```

**實測**：

```
[F5] 伺服器每 500ms 回一小塊，read timeout = 3s。
[F5] 10 秒後執行緒還活著嗎 = true（true = 🔴 read timeout 完全沒有觸發）
```

🔴 **read timeout 一次都沒有觸發**，因為**每一次等待都只有 500ms**。

⚠️ **這不是一個人造的邊界情況，它有三個真實的來源**：

| 來源 | 說明 |
|---|---|
| **串流回應** | 對方回一個很大的 CSV / NDJSON，慢慢送 |
| **中間的代理** | nginx / ALB 為了避免逾時而定期送 keep-alive chunk |
| 🔴 **Slowloris 式的下游** | 對方過載時，回應變成「涓涓細流」而不是「失敗」 |

**解法：第四個逾時 —— 整體逾時（overall / request timeout）。**

```java
// ✅ 解法 A（★ shop-service 的選擇）：Resilience4j 的 TimeLimiter
@TimeLimiter(name = "erp")
public CompletableFuture<Void> pushOrder(OrderSnapshot snapshot) { … }
```

```yaml
resilience4j:
  timelimiter:
    instances:
      erp:
        timeout-duration: 8s
        cancel-running-future: true      # ★ 逾時後中斷那條執行緒
```

```java
// 解法 B：Apache HttpClient 5 的 responseTimeout（★ 只管到「開始收到回應」）
RequestConfig.custom().setResponseTimeout(Timeout.ofSeconds(5)).build();
// ⚠️ 它【不】管 body 讀多久 —— 對 F5 那個情境沒有用
```

```java
// 解法 C：限制回應大小（★ 應該【同時】做）
// 一個「永遠不結束的回應」也是一個「無限大的回應」
```

⚠️⚠️ **解法 A 有一個代價，而它必須被說清楚**：

| | |
|---|---|
| `TimeLimiter` 怎麼實作的 | 它在**另一條執行緒**上跑，然後 `future.get(timeout)` |
| 於是 | 🔴 **它需要一個額外的執行緒池**（`bulkhead` / `threadPoolBulkhead`） |
| 而且 | ⚠️ `cancel-running-future: true` 只是 `Thread.interrupt()` —— **阻塞在 socket 讀取上的執行緒不一定會被中斷** |

> 🔴 **誠實的結論**：
> **在阻塞式的 client 上，「整體逾時」沒有一個乾淨的解法。**
> `TimeLimiter` 讓**呼叫端**在 8 秒後解脫，
> 但**那條真正在讀 socket 的執行緒可能還卡著**。
>
> 👉 **所以它必須與「隔艙」（6.7.4）搭配**：
> 至少讓卡住的執行緒有一個上限，不會把整個池子吃光。
>
> ⚠️ 而如果「整體逾時」對你是硬需求 —— **那是選 `WebClient` 的真正理由**
> （`.timeout(Duration)` 在反應式鏈上是真的能取消的）。

### 6.5.4 逾時 × 重試 = 相乘 ★★

**事故 2 的第二段。**

**實測**（read timeout = 2 秒，重試 3 次）：

```
[F6] read=2s、重試 3 次 → 總共 6079 ms（3 次嘗試）
[F6] ⚠️ 這條連線被佔住了 6079 ms，而「逾時設 2 秒」讓人以為是 2 秒
```

**把它換算成事故 2 的數字**：

| | 值 |
|---|---|
| 每次呼叫的逾時 | 5 秒 |
| 重試次數 | 3 |
| 退避（backoff） | 1s、2s |
| **一個請求最長佔用時間** | 5 + 1 + 5 + 2 + 5 = **18 秒** |
| Hikari 連線池 | 20 |
| **理論 TPS 上限**（外部呼叫在交易裡時） | 🔴 20 ÷ 18 ≈ **1.1 TPS** |

⚠️ **而正常情況下的 TPS 是 300。** 也就是說：
**下游從「快」變成「不回應」時，我們的容量掉到原本的 0.4%。**

> 📌 **一個必須內化的公式**（02 章 2.11 的 HTTP 版）：
>
> ```
> 最壞情況的容量 = 連線池大小 ÷ (單次逾時 × 重試次數 + 退避總和)
> ```
>
> **而「最壞情況」不是罕見情況** —— 下游變慢是每個月都會發生的事。

**三個修法，效果差很多**：

| 修法 | 事故 2 還會發生嗎 | 為什麼 |
|---|---|---|
| 只設逾時 | 🔴 **會**（18 秒 → 1.1 TPS） | 逾時只是讓失敗「有時間上限」 |
| 逾時 + **把外部呼叫移出交易**（6.3） | ⚠️ **不會拖垮資料庫**，但 Tomcat 執行緒仍會耗盡 | 兩個池子解耦了一個 |
| 逾時 + 移出交易 + **熔斷**（6.7） | ✅ **不會** | 熔斷讓「已知會失敗的呼叫」**立刻失敗**，不佔資源 |

> 🔴 **「加逾時」是必要條件，不是充分條件。**
> 而很多團隊在事故之後只做了第一件事，於是下一次事故只是**慢一點**發生。

### 6.5.5 shop-service 的逾時矩陣

**逾時不是一個全域值，它是「每個下游一個值」，而值要從 SLO 推導。**

| 下游 | connect | read | 連線池等待 | 整體 | 重試 | 推導理由 |
|---|---|---|---|---|---|---|
| **金流（TapPay）** | 1s | **10s** | 200ms | 12s | 🔴 **0** | 3D 驗證的重導向本來就慢；⚠️ **不可重試**（事故 3） |
| **ERP** | 1s | 3s | 200ms | 5s | 2 | 內部系統，且**有 outbox 兜底**（6.8） |
| 搜尋索引 | 500ms | 1s | 100ms | 2s | 1 | 可以遺失，重建索引有排程兜底 |
| 郵件供應商 | 1s | 3s | 200ms | 5s | 2 | ⚠️ 供應商的 SLA 是 p99 = 2s |
| 發票（財政部） | 2s | **15s** | 500ms | 20s | 🔴 0 | ⚠️ 公家系統本來就慢；且**開票不可重複** |

⚠️ **兩件事值得特別說明**：

**① 「金流的 read timeout 是 10 秒」看起來太長，而它是對的。**

逾時設太短的後果是**製造「結果未知」**：

```
逾時 3 秒 → 對方 4 秒才處理完 → 我們判定逾時 → 🔴 但錢已經扣了
```

> 📌 **對於「不可重試、且結果未知代價很高」的呼叫，
> 逾時應該設得【比你想的長】** ——
> 因為「等到答案」永遠比「不知道答案」便宜。
>
> ⚠️ **而它的代價要用隔艙付**（6.7.4）：
> 金流的呼叫有自己的執行緒配額，卡住 10 秒不會影響其他人。

**② 「整體逾時」永遠要大於 `connect + read`，但不能大太多。**

```
整體 = connect + read + 一點餘裕（TLS 握手、DNS、連線池排隊）
```

⚠️ **如果整體逾時 == connect + read**，那它幾乎總是會先觸發，
而 `TimeLimiter` 的例外（`TimeoutException`）**沒有帶「是哪一階段慢」的資訊**
→ 診斷會變困難。

**一組「逾時政策」的守門測試**：

```java
/**
 * ★★ 讓「有人加了新的下游卻忘記設逾時」在 CI 就紅燈。
 *
 * <p>⚠️ 它擋不住「設了一個很爛的值」——
 * 但它擋得住「完全沒設」，而後者才是事故 2 的成因。
 */
@Test
void 每個下游都必須設滿四個逾時而且大小關係要對() {
    assertThat(props.clients()).isNotEmpty();

    props.clients().forEach((name, spec) -> {
        assertThat(spec.connectTimeout()).as("%s.connect", name)
                .isBetween(Duration.ofMillis(100), Duration.ofSeconds(5));
        assertThat(spec.readTimeout()).as("%s.read", name)
                .isBetween(Duration.ofMillis(200), Duration.ofSeconds(30));
        assertThat(spec.connectionRequestTimeout()).as("%s.connectionRequest", name)
                .isBetween(Duration.ofMillis(50), Duration.ofSeconds(1));

        // ★★ 整體逾時必須涵蓋 connect + read，否則它會提前觸發而遮蔽真正的原因
        assertThat(spec.overallTimeout()).as("%s.overall", name)
                .isGreaterThan(spec.connectTimeout().plus(spec.readTimeout()));

        // ⚠️ 但也不能大太多 —— 否則它形同虛設
        assertThat(spec.overallTimeout()).as("%s.overall 不該超過 (connect+read) 的兩倍", name)
                .isLessThanOrEqualTo(spec.connectTimeout().plus(spec.readTimeout()).multipliedBy(2));
    });
}

/** ★★★ 這一條是事故 3 的守門人。 */
@Test
void 不可盲目重試的下游其重試次數必須是0() {
    assertThat(props.clients().get("payment").maxAttempts())
            .as("金流不可重試（6.0 事故 3）—— 逾時是【結果未知】而不是失敗")
            .isZero();
    assertThat(props.clients().get("invoice").maxAttempts())
            .as("開票不可重試 —— 重複開票要作廢，而作廢要人工")
            .isZero();
}
```

> 📌 **最後那條測試的 `as(...)` 訊息比斷言本身重要。**
> 三個月後有人把 `payment.maxAttempts` 改成 2 讓某個測試變綠時，
> **CI 會告訴他為什麼不行，以及去哪一節看完整的理由。**

---

## 6.6 重試 ★★

### 6.6.1 一個問題決定一切：**對方處理了嗎**

**04 章 4.9.1 定義了 `safeToRetryBlindly()`，而它當時是給【客戶端】用的。
這一節是它的伺服器端版本，而判準完全相同。**

```java
/** ★★ 04 章 4.9.1：客戶端可以「原封不動重送」而不會產生副作用。 */
public boolean safeToRetryBlindly() { return retry == Retry.BACKOFF_AND_RETRY; }
```

**把所有失敗分成三類**：

| 類別 | 對方處理了嗎 | 例子 | 可以重試嗎 |
|---|---|---|---|
| **A：確定沒處理** | ❌ 沒有 | 連線逾時、DNS 失敗、502、503、429、熔斷器打開 | ✅ **可以，而且應該** |
| **B：確定失敗了** | ✅ 處理了，結果是失敗 | 卡片被拒、餘額不足、400、422 | 🔴 **不可以** —— 重試 100 次結果一樣 |
| **C：不知道** | ⚠️ **不知道** | **讀取逾時**、504、連線在送出後斷掉 | 🔴🔴 **不可以盲目重試** |

> 🔴 **C 類是這一節的全部重點，而它是三類裡最常見的一類。**
>
> **「不知道」不是「失敗」。** 而大部分程式碼把它當成失敗，
> 因為在 Java 裡它們都是 `catch (Exception e)`。

**A 與 C 在程式碼裡長得一模一樣**（6.5.2 實測過）：

```
[F2 read=3s]              ResourceAccessException ← SocketTimeoutException : Read timed out
[F3 connect=2s read=30s]  ResourceAccessException ← SocketTimeoutException : Connect timed out
```

**同一個例外型別，同一個 cause 型別，只差一個訊息字串。**

⚠️ **而「靠字串判斷」是不可接受的**（訊息會隨 JDK 版本與 locale 變）。

**shop-service 的做法：在轉接器裡分開，而且是靠【階段】而不是靠例外**：

```java
/**
 * ★★ 把「連不上」與「等不到回應」分開。
 *
 * <p>判斷的依據<b>不是</b>例外訊息，而是
 * <b>「請求的 byte 有沒有送出去」</b> ——
 * Apache HttpClient 5 的 {@code ExecChainHandler} 知道這件事。
 */
public class RequestSentMarkerInterceptor implements ExecChainHandler {

    /** ★ 這個 ThreadLocal 的生命週期只在一次 HTTP 呼叫內，由 finally 清掉 */
    static final ThreadLocal<Boolean> REQUEST_SENT = ThreadLocal.withInitial(() -> false);

    @Override
    public ClassicHttpResponse execute(ClassicHttpRequest request, Scope scope,
                                       ExecChain chain) throws IOException, HttpException {
        REQUEST_SENT.set(false);
        try {
            // ★ 走到這一層時連線已經建立好了（它在 connect exec 之後）
            REQUEST_SENT.set(true);
            return chain.proceed(request, scope);
        } finally {
            // ⚠️ 不清會洩漏給池子裡下一個用這條執行緒的呼叫
            REQUEST_SENT.remove();
        }
    }
}
```

```java
} catch (ResourceAccessException e) {
    if (RequestSentMarkerInterceptor.wasRequestSent()) {
        // ★ C 類：送出去了，不知道對方做了什麼
        throw new UpstreamOutcomeUnknownException(request.merchantTradeNo(), e);
    }
    // ★ A 類：根本沒送出去 —— 安全
    throw new UpstreamNotReachedException(request.merchantTradeNo(), e);
}
```

⚠️⚠️ **這個做法有一個誠實的限制**，必須寫在 javadoc 裡：

> **「請求送出去了」不等於「對方收到了」。**
> TCP 把 byte 交給網卡之後，它仍然可能在網路上被丟掉。
>
> 👉 所以它把 C 類**縮小**了，但**沒有消滅** ——
> 剩下的部分只能靠**冪等鍵**與**對帳**（6.6.5、6.8.4）。

### 6.6.2 C 類的正確處置：不是重試，是**查詢**

**01 章 1.7.2 為 `PaymentGateway` 設計 `query()` 方法時說**：

> 「它存在的唯一理由是『逾時之後要對帳』——
> 而**如果一個金流商沒有提供這個 API，那家不能用**。」

**這一節就是那句話的兌現**：

```java
/**
 * 付款。
 *
 * <p>★★ C 類失敗（結果未知）的處理流程，一共四步：
 */
public PaymentResult pay(String orderId, ChargeRequest request) {
    try {
        ChargeResult result = paymentGateway.charge(request);       // ① 送出
        return handle(result);

    } catch (UpstreamOutcomeUnknownException e) {
        // ② 🔴 不重試 —— 改成「查詢」
        Optional<ChargeStatus> status = paymentGateway.query(request.merchantTradeNo());

        return switch (status.orElse(ChargeStatus.UNKNOWN)) {
            // ③-a 對方根本沒收到 → ✅ 這時候【才】可以重送
            case NOT_FOUND  -> retryOnce(request);

            case SUCCEEDED  -> handleSucceeded(orderId, request);
            case FAILED     -> handleDeclined(orderId, request);

            // ③-b 對方還在處理 → 交給對帳排程（6.8.5）
            case PENDING, UNKNOWN -> {
                reconciliation.schedule(request.merchantTradeNo(), orderId);
                yield PaymentResult.pending(request.merchantTradeNo());
            }
        };
    }
}
```

⚠️ **④ 第四步在程式碼裡看不到，而它最重要**：

**`query()` 本身也可能逾時。**

```java
// 🔴 錯：把 query 也包進重試 → 又一個 C 類
@Retryable public Optional<ChargeStatus> query(...) { … }

// ✅ 對：query 是【唯讀】的，所以它【可以】安全重試
//    ⚠️ 而「可以重試」的理由不是「它比較不會壞」，是「它沒有副作用」
```

> 📌 **一個乾淨的規則**：
> **唯讀的呼叫可以無腦重試；有副作用的呼叫只能在「確定沒處理」時重試。**
>
> 而這正是 `PaymentGateway` 為什麼**必須**有 `query()` ——
> 它把一個「不能重試的問題」變成「一個可以重試的問題」。

### 6.6.3 退避與抖動

**05 章 5.6 為快取的 TTL 加過抖動，這裡是同一個道理。**

```yaml
resilience4j:
  retry:
    instances:
      erp:
        max-attempts: 3                  # ★ 包含第一次！不是「重試 3 次」
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        enable-randomized-wait: true     # ★★ 抖動
        randomized-wait-factor: 0.5      # 200ms → 實際等 100～300ms
        retry-exceptions:
          - example.shop.common.http.UpstreamNotReachedException
          - example.shop.common.http.UpstreamUnavailableException
        ignore-exceptions:
          - example.shop.common.http.UpstreamOutcomeUnknownException   # ★★ C 類
          - example.shop.common.http.OutboundRequestRejectedException  # ★ B 類（4xx）
```

⚠️ **`max-attempts: 3` 的意思是「總共 3 次」，不是「失敗後再試 3 次」。**

**實測**（6.7.3 的 H3 實驗）：

```
[H3] 方法【實際被執行】 3 次（max-attempts=3）
```

**為什麼需要抖動**（與 05 章 5.6.2 的雪崩同源）：

```
下游掛掉 → 500 個請求【同時】失敗
         → 500 個請求【同時】等 200ms
         → 500 個請求【同時】重試        🔴 下游剛要爬起來就被再打一次
```

> 📌 **抖動的作用是「把同步變成分散」**，而它在三個地方都需要：
> **快取的 TTL（05 章 5.6.2）、重試的退避（這裡）、排程的起始時間（6.8.3）。**

### 6.6.4 重試放大：一條鏈上每一層都重試會怎樣

```
使用者 → API Gateway（重試 2）→ 我們（重試 3）→ ERP（自己也重試 2）
```

**下游一次故障，實際的請求數**：

```
2 × 3 × 2 = 12 次
```

⚠️ **而每一層都覺得自己「只重試了一點點」。**

**這就是 6.4.3 為什麼要 `disableAutomaticRetries()`**：
Apache HttpClient 5 預設會重試 1 次冪等方法 → **悄悄地把 3 變成 6**。

**三條規則**：

| 規則 | 說明 |
|---|---|
| ① **一條鏈上只有一層負責重試** | 通常是**最靠近使用者**的那一層，因為只有它知道使用者還在不在等 |
| ② **重試必須有預算** | 「這個服務同時最多允許 10% 的請求是重試」 |
| ③ **重試必須被熔斷器看見** | 6.7.3 的 H3 實驗證明 Resilience4j 預設就是這樣 |

**規則 ② 的實作（重試預算）**：

```java
/**
 * ★★ 重試預算：讓「重試」自己也有一個上限。
 *
 * <p>沒有它的話，下游全掛時我們送出的流量是平常的 3 倍 ——
 * 而那正是「下游永遠爬不起來」的原因（retry storm）。
 *
 * <p>⚠️ Resilience4j <b>沒有內建</b>這個功能（2.2.0 版），所以要自己做。
 */
@Component
public class RetryBudget {

    private final AtomicLong attempts = new AtomicLong();
    private final AtomicLong retries  = new AtomicLong();
    private final double maxRatio;              // 0.1 = 重試最多佔總量的 10%

    public boolean allowRetry() {
        long a = attempts.get();
        // ★ 熱身期：量太小的時候不做判斷（否則第一個失敗就會被擋）
        if (a < 100) { retries.incrementAndGet(); return true; }
        if (retries.get() > a * maxRatio) {
            budgetExhausted.increment();        // ★ 一定要有指標
            return false;
        }
        retries.incrementAndGet();
        return true;
    }
}
```

### 6.6.5 什麼絕對不可以重試 🔴

| 操作 | 為什麼 | 正確做法 |
|---|---|---|
| **付款** | 事故 3 | `query()` + 對帳 |
| **開發票** | 重複開票要作廢，作廢要人工 | 冪等鍵 + `query()` |
| **寄信** | 使用者收到兩封 | ⚠️ 供應商的 idempotency key |
| **扣庫存的外部呼叫** | 超賣 | 冪等鍵 |
| **任何拋 `SideEffectsCommitted` 的東西** | 04 章 4.3.4：**已經有不可回復的副作用了** | 🔴 **一律不重試** |

**最後一列可以做成一條程式碼層級的規則**：

```java
/**
 * ★★ 04 章 4.3.4 的 {@code SideEffectsCommitted} 標記在這裡有了第二個用途。
 *
 * <p>它原本的用途是「advice 不可以說『操作未執行』」。
 * 這裡它變成一條<b>重試的禁令</b> ——
 * 而兩個用途說的是同一件事：<b>已經發生的事不能當作沒發生。</b>
 */
public static boolean retryable(Throwable t) {
    if (t instanceof SideEffectsCommitted) return false;      // ★ 最高優先
    if (t instanceof UpstreamOutcomeUnknownException) return false;   // C 類
    if (t instanceof OutboundRequestRejectedException) return false;  // B 類（4xx）
    return t instanceof UpstreamNotReachedException
        || t instanceof UpstreamUnavailableException
        || t instanceof UpstreamRateLimitedException;
}
```

> 📌 **注意這個方法是「白名單」而不是「黑名單」**：
> 預設是 `false`，只有明確列出的三種才回 `true`。
>
> **04 章 4.2 對 `ErrorCode` 做過同樣的決定，理由也相同**：
> 新增一種例外時，**忘記加它會讓它不被重試（安全），
> 而不是讓它被重試（危險）**。

---

## 6.7 熔斷 ★★

### 6.7.1 三個狀態，以及一個沒有人告訴你的細節

```
        失敗率超過門檻
CLOSED ─────────────────→ OPEN
   ↑                       │
   │                       │ 等 waitDurationInOpenState
   │  試探成功              ↓
   └──────────────── HALF_OPEN
                           │ 試探失敗
                           └────────→ OPEN
```

**實測**（`slidingWindowSize=10`、`minimumNumberOfCalls=5`、`failureRateThreshold=50%`）：

```
[H1] 起始狀態 = CLOSED，成功=0 失敗=0 失敗率=-1.0%
[H1] 第 1 次呼叫 → 🔴 IllegalStateException | 狀態=CLOSED 失敗率=-1.0% | 方法實際被執行 1 次
[H1] 第 4 次呼叫 → 🔴 IllegalStateException | 狀態=CLOSED 失敗率=-1.0% | 方法實際被執行 4 次
[H1] 第 5 次呼叫 → 🔴 IllegalStateException | 狀態=OPEN   失敗率=100.0% | 方法實際被執行 5 次
[H1] 第 6 次呼叫 → ⛔ CallNotPermittedException（熔斷器開著，方法【沒有】被呼叫）
                  | 狀態=OPEN | 方法實際被執行 5 次
```

**三個觀察**：

| 觀察 | 意義 |
|---|---|
| 前 4 次的失敗率是 **`-1.0%`** | ⚠️ **Resilience4j 用 `-1` 表示「呼叫數還沒到 `minimumNumberOfCalls`」** —— 而如果你把這個值畫進儀表板，它會變成一條 -1 的線 |
| 第 5 次才打開 | `minimumNumberOfCalls` 是**必要條件** —— 失敗率再高，量不夠就不會打開 |
| 第 6 次起「方法實際被執行」停在 5 | ✅ **熔斷器的價值：不佔用任何資源就失敗** |

⚠️⚠️ **半開的轉換有一個細節，而它會誤導監控**：

```
[H2] 打爆之後狀態 = OPEN
[H2] 等 1.2 秒（wait-duration-in-open-state = 1s）…
[H2] 等完之後狀態 = OPEN（⚠️ 仍是 OPEN —— 它是【被呼叫時】才轉成 HALF_OPEN 的）
[H2] 下游恢復了，開始試探：
[H2]   第 1 次 → ✅ ok | 狀態=HALF_OPEN
[H2]   第 2 次 → ✅ ok | 狀態=CLOSED
```

> 🔴 **「等待時間過了」不等於「狀態變成 HALF_OPEN」。**
> 預設（`automaticTransitionFromOpenToHalfOpenEnabled = false`）下，
> 狀態機是**惰性**的 —— **沒有人呼叫，它就永遠停在 `OPEN`**。
>
> ⚠️ **這對監控有一個具體的後果**：
> 半夜三點某個低流量的下游熔斷了，早上你看到儀表板上「`OPEN` 已經 6 小時」——
> **那不代表它壞了 6 小時，可能只代表 6 小時沒有人呼叫它。**
>
> 👉 想要狀態自己會轉，要開 `automatic-transition-from-open-to-half-open-enabled: true`
> （代價：它需要一條額外的排程執行緒）。

### 6.7.2 熔斷與降級：同一件事的兩個層次 ★★

**05 章 5.7.2 為 Redis 掛掉設計了 `CacheErrorHandler`：**

> 「沒有 `CacheErrorHandler` —— Redis 掛掉 = **所有讀取 500**」

**而 05 章 5.16 的缺口 7 說**：

> 🔴 **快取掛掉時資料庫會被打** —— 需要限流／熔斷 —— ⏳ **06 章**

**這一節把這兩件事接起來。它們是同一個模式的兩層**：

| 層次 | 名字 | 回答的問題 | 05 章 / 06 章 |
|---|---|---|---|
| **第 1 層** | **降級**（fallback） | 「這一次失敗了，回什麼？」 | `CacheErrorHandler` → 回 `null`，去打資料庫 |
| **第 2 層** | **熔斷**（circuit breaker） | 「一直在失敗，還要繼續試嗎？」 | 🔴 **05 章沒做** |

⚠️⚠️ **只做第 1 層的具體後果，就是 05 章缺口 7**：

```
Redis 掛掉
  → CacheErrorHandler 吞掉例外，回 null
  → 每一個請求都變成「快取 miss」
  → 🔴 100% 的流量打到資料庫（平常只有 3%）
  → 資料庫被打掛
  → ⚠️ 而且每個請求還是會先花 200ms 去試 Redis（連線逾時）
```

**加上第 2 層之後**：

```java
/**
 * ★★ 05 章缺口 7 的解法。
 *
 * <p>它做的事只有一件：<b>Redis 連續失敗之後，不要再試了。</b>
 *
 * <p>⚠️ 注意它<b>不會</b>讓資料庫的負載變小 ——
 * 100% 的流量還是會打到資料庫。它省下的是
 * 「每個請求先花 200ms 去試一個已知會失敗的 Redis」。
 *
 * <p>👉 真正保護資料庫的是<b>限流</b>（6.7.5），而不是熔斷。
 * <b>這個區分很重要，而它常被混為一談。</b>
 */
@Component
public class ResilientCacheErrorHandler implements CacheErrorHandler {

    private final CircuitBreaker breaker;      // name = "redis"

    @Override
    public void handleCacheGetError(RuntimeException e, Cache cache, Object key) {
        cacheErrors.increment(cache.getName(), "get");
        // ★ 讓熔斷器知道這次失敗了（Spring 的 CacheErrorHandler 不在 aspect 鏈上）
        breaker.onError(0, TimeUnit.MILLISECONDS, e);
        log.warn("快取讀取失敗，降級為直接查資料庫：cache={} key={}", cache.getName(), key, e);
        // ⚠️ 不重拋 —— 這就是「降級」
    }
}
```

```java
/** ★ 讀取路徑上先問熔斷器，開著就完全跳過 Redis */
public ProductView findById(String id) {
    if (breaker.getState() == CircuitBreaker.State.OPEN) {
        cacheSkipped.increment();
        return loadFromDatabase(id);          // ★ 連 Redis 都不碰，省下 200ms
    }
    return cachedFindById(id);
}
```

> 📌 **兩層的分工一句話**：
> **降級決定「這次回什麼」，熔斷決定「還要不要試」。**
>
> ⚠️ **而兩者都是靜默的**，所以兩者都必須有指標（05 章 5.9 的同一句話）。

### 6.7.3 註解的順序：一個實測出來的意外 ★★

**把 `@Retry` 與 `@CircuitBreaker` 疊在同一個方法上，誰在外層？**

```java
@CircuitBreaker(name = "erp")
@Retry(name = "erp")                 // ★ 寫在下面，所以在內層？
public String pushWithRetry(String id) { … }
```

⚠️ **註解的書寫順序完全不影響結果** —— 決定順序的是 aspect 的 `order`。

**實測**：

```
[H4] 容器裡的 Resilience4j aspect（order 小 = 外層）：
[H4]   order=2147483642  RetryAspect            ← ★ 最外層
[H4]   order=2147483643  CircuitBreakerAspect
[H4]   order=2147483644  RateLimiterAspect
[H4]   order=2147483645  TimeLimiterAspect
[H4]   order=2147483646  BulkheadAspect         ← 最內層
[H4]   order=2147483647  TimerAspect
```

**所以真正的巢狀是**：

```
Retry
 └─ CircuitBreaker
     └─ RateLimiter
         └─ TimeLimiter
             └─ Bulkhead
                 └─ 你的方法
```

**這個順序的後果，實測**：

```
[H3] @CircuitBreaker + @Retry 疊在同一個方法上，呼叫【一次】：
[H3] 方法【實際被執行】 3 次（max-attempts=3）
[H3] 熔斷器記錄到的呼叫數：成功=0 失敗=3
```

🔴 **一次邏輯呼叫，在熔斷器的統計裡算成【三次】失敗。**

⚠️ **這是對的還是錯的？兩種說法都有道理，而它必須是一個【知道的】決定**：

| 順序 | 效果 | 適合 |
|---|---|---|
| **Retry 在外**（Resilience4j 預設） | 熔斷器**更快打開**（每次邏輯呼叫貢獻 N 次失敗） | ✅ **多數情況** —— 下游真的壞掉時，早點放棄是對的 |
| CircuitBreaker 在外 | 熔斷器只看「重試完之後的最終結果」 | 下游**偶爾**抖動、重試通常會成功時 |

> 📌 **shop-service 保留預設（Retry 在外）**，理由：
> **`minimumNumberOfCalls` 的計算要跟著改**。
> 重試 3 次 → 每次邏輯呼叫產生 3 個樣本 →
> `minimumNumberOfCalls: 20` 實際上只需要 **7 次**邏輯呼叫就會達標。
>
> ⚠️ **而這件事必須寫在組態的註解裡**，否則下一個人調 `max-attempts`
> 的時候會不小心改掉熔斷的靈敏度。

### 6.7.4 隔艙：讓「壞掉的下游」只吃掉自己的配額

**6.5.5 說「金流的 read timeout 設 10 秒是對的」，而它的代價要用隔艙付。**

```
沒有隔艙：
  金流變慢 → 200 條 Tomcat 執行緒全部卡在金流上 → 🔴 連查訂單都不能用

有隔艙：
  金流變慢 → 最多 10 條執行緒卡在金流上 → ✅ 其他 190 條照常服務
             第 11 個付款請求 → 立刻失敗（BulkheadFullException）
```

```yaml
resilience4j:
  bulkhead:                       # ★ 號誌式（semaphore）—— 不換執行緒
    instances:
      payment:
        max-concurrent-calls: 10
        max-wait-duration: 0      # ★★ 不等，滿了就立刻失敗
      erp:
        max-concurrent-calls: 5
        max-wait-duration: 100ms
```

⚠️ **兩種隔艙，差別很大**：

| | `bulkhead`（號誌） | `thread-pool-bulkhead` |
|---|---|---|
| 換執行緒嗎 | ❌ 不換 | ✅ 換 |
| 交易 / ThreadLocal | ✅ **保留** | 🔴 **消失**（6.2.6） |
| 能配合 `TimeLimiter` 嗎 | 🔴 **不能**（沒有可取消的 future） | ✅ 能 |
| shop-service 用哪個 | ✅ **號誌式** | 只有 ERP 推送用（它已經在 `@Async` 上） |

> 🔴 **「號誌式隔艙不能配 `TimeLimiter`」是一個很多人踩到的組合**：
> 你設了 `@TimeLimiter` + `@Bulkhead`，啟動沒錯、測試也過，
> **而 `TimeLimiter` 根本沒有生效** ——
> 因為 `TimeLimiterAspect` 只處理回傳 `CompletableFuture` 的方法。
>
> ⚠️ **它是靜默的**（6.11.5 有一條守門測試）。

**隔艙的大小怎麼算**（利特爾法則，02 章 2.11 的同一條公式）：

```
需要的併發數 = 每秒請求數 × 平均回應時間

金流：8 TPS × 0.8 秒 = 6.4  →  設 10（留 1.5 倍餘裕）
ERP ：3 TPS × 0.5 秒 = 1.5  →  設 5
```

⚠️ **餘裕不要留太多** —— 隔艙的價值就在於**它會滿**。
設成 100 的隔艙等於沒有隔艙。

### 6.7.5 熔斷打開時，該回什麼給使用者 ★

**這是 04 章的問題，而它在這裡有了具體的答案。**

```java
@CircuitBreaker(name = "erp", fallbackMethod = "pushToOutbox")
public void pushOrder(OrderSnapshot snapshot) { … }

/**
 * ★ 降級：熔斷器開著時，把它寫進 outbox 等下次補送。
 *
 * <p>⚠️ fallback 方法的簽章規則：<b>與原方法相同，末尾多一個 Throwable</b>。
 * 簽章不對的話 —— 🔴 <b>啟動時不會報錯，呼叫時才拋
 * {@code NoSuchMethodException}</b>（與 6.2.2 的 {@code @Async} 同一種陷阱）。
 */
private void pushToOutbox(OrderSnapshot snapshot, Throwable t) {
    outbox.enqueue(OutboxMessage.of("ERP_PUSH", snapshot));
    erpDegraded.increment();
}
```

**四種下游，四種降級**：

| 下游 | 熔斷打開時 | `ErrorCode` |
|---|---|---|
| **ERP** | ✅ 寫 outbox，**使用者無感** | — |
| **搜尋索引** | ✅ 跳過（排程會重建） | — |
| **金流** | 🔴 **沒有降級** —— 誠實地失敗 | `PAYMENT_GATEWAY_UNAVAILABLE`（503） |
| **商品推薦** | ✅ 回一個靜態的熱門清單 | — |

⚠️ **金流那一列是關鍵**：

> 🔴 **「熔斷 + 降級」不代表「使用者永遠不會看到錯誤」。**
>
> 有些操作**沒有合理的降級**。
> 對這些操作，熔斷器的價值不是「讓它成功」，
> 而是**「讓它在 1 毫秒內失敗，而不是 12 秒」** ——
> 於是使用者可以立刻重試，而不是等到逾時。

**回給客戶端的 `Problem`**（04 章 4.9 的體系）：

```json
{
  "type": "https://api.shop.example/errors/payment-gateway-unavailable",
  "title": "金流服務暫時無法使用",
  "status": 503,
  "detail": "請稍後再試，您的訂單已保留",
  "retry": "BACKOFF_AND_RETRY",
  "retryAfterSeconds": 30
}
```

⚠️ **`Retry.BACKOFF_AND_RETRY` 而不是 `CHECK_STATUS`** —— 而這是一個**正確**的判斷：
熔斷器打開時，**請求根本沒有送到金流商**（H1 實測：`方法實際被執行 5 次`，第 6 次沒有）。
**所以它是 A 類（確定沒處理）→ `safeToRetryBlindly()` 回 `true`。**

> 📌 **這是 04 章 4.9.1 那個方法最漂亮的一次兌現**：
> **同一個下游、同一個 API，「逾時」是 `CHECK_STATUS`，
> 「熔斷」是 `BACKOFF_AND_RETRY`** ——
> 因為判準從來不是「哪個下游」，而是**「它處理了沒有」**。

### 6.7.6 業務失敗不可以觸發熔斷 🔴

**一個很容易犯、而且後果很大的錯。**

```java
@CircuitBreaker(name = "payment")
public ChargeResult charge(ChargeRequest request) { … }
```

**情人節當天，很多人的卡片餘額不足** → `charge()` 拋 `CardDeclinedException`
→ 🔴 **熔斷器打開** → **連卡片正常的人也不能付款了**。

**實測**（`ignore-exceptions` 有列 `CardDeclinedException`）：

```
[H5] 送 6 次【卡片被拒】（業務結果，在 ignore-exceptions 清單裡）：
[H5]   第 6 次 → 🔴 CardDeclinedException | 狀態=CLOSED 失敗數=0
[H5] 👉 熔斷器狀態 = CLOSED（應該還是 CLOSED）

[H5] 送 5 次【金流商掛了】（技術失敗）：
[H5]   第 4 次 → 🔴 IllegalStateException | 狀態=OPEN 失敗數=4
[H5]   第 5 次 → ⛔ CallNotPermittedException（熔斷器開著，方法【沒有】被呼叫）
```

⚠️ **而 01 章 1.7.2 早就用型別解決了這個問題**：

```java
/**
 * <p>⚠️⚠️ 它<b>不拋例外表示「付款失敗」</b>——
 * 「卡片被拒絕」是一個<b>正常的業務結果</b>，不是異常。
 */
ChargeResult charge(ChargeRequest request);      // ★ Declined 是回傳值的一個分支
```

> 📌 **「卡片被拒是回傳值不是例外」這個設計，在 01 章看起來像是潔癖。
> 這一節是它的回報**：
>
> **因為它是回傳值，所以熔斷器根本不會看到它** ——
> 不需要維護 `ignore-exceptions` 清單，也不會有人在新增例外時忘記加。
>
> ⚠️ **而 `ignore-exceptions` 是一個黑名單**（03 章 3.2 的同一個問題）：
> 新增一種業務例外時**忘記加它，熔斷器就會被誤觸**，
> 而那是一個**在情人節當天才會發現**的 bug。

---

## 6.8 Outbox ★★

### 6.8.1 先數一數：目前有幾個「失敗只進 log」的地方

**02 章 2.12.4 說得很直白**：

> **`@TransactionalEventListener` 不是可靠的訊息傳遞。**

**而 00～05 章一共留下了【六個】依賴它的地方**：

| # | 地方 | 出處 | 遺失的後果 | 分類（00 章 0.3.1） |
|---|---|---|---|---|
| ① | 訂單確認信 | 01 章 1.6.3 | 客戶不知道訂單成立了 | 可以遺失 |
| ② | 推 ERP | 00 章 0.10.10 | 🔴 **出貨單不會產生 —— 訂單永遠不會出貨** | **不能遺失** |
| ③ | **加點數** | 01 章 1.5.4 | 🔴 客戶的點數少了 | **不能遺失** |
| ④ | 清快取 | 05 章 5.3.5 解法 A | 髒值最多留到 TTL 到期 | 可以遺失（短 TTL 兜底） |
| ⑤ | 重建搜尋索引 | 05 章事故 1 | 商品搜尋結果是舊的 | 可以遺失（排程兜底） |
| ⑥ | 稽核紀錄 | 00 章 0.3.2 事故 6 | 🔴 **合規問題** | **不能遺失** |

⚠️ **三個「不能遺失」的，目前的實作全部是「失敗只進 log」。**

**而它們遺失的方式有五種**（02 章 2.12.4 說了三種，這一章補上兩種）：

| # | 遺失方式 | 這一章的出處 |
|---|---|---|
| 1 | commit 之後、listener 執行之前，程序掛掉 | — |
| 2 | `@Async` 的佇列被 `ABORT` 拒絕 | 6.2.5 |
| 3 | listener 拋例外且被 catch | 6.2.7 |
| 4 | 🆕 **部署時佇列被丟掉** | **6.2.8（事故 1，實測 0/10）** |
| 5 | 🆕 **回傳 `CompletableFuture` 而呼叫端沒接** | **6.2.7（實測：連 log 都沒有）** |

> 📌 **outbox 要解決的不是「某一種」遺失，是【全部五種】。**
> 而它做到這件事的方法只有一個想法：
>
> **把「待辦事項」與「業務資料」寫進同一個交易。**

### 6.8.2 核心想法：一次寫入，兩件事

```java
@Transactional
public OrderResultView create(CreateOrderCommand cmd, Actor actor) {
    Order order = orderFactory.create(cmd, actor);
    order.lines().forEach(l -> stockPort.tryReserve(l.productId(), l.quantity()));
    orderRepository.save(order);                             // ① 業務資料

    outbox.enqueue(OutboxMessage.of(                         // ② 待辦事項
            "ORDER_PLACED",
            order.id(),                                      // ★ 聚合 id = 分區鍵
            OrderPlacedEvent.from(order, email, now)));

    return OrderResultView.from(order, actor, clock.instant());
}   // ★★ ① 與 ② 一起 commit，或一起 rollback
```

**這一行改變了什麼**：

| | 事件（`AFTER_COMMIT`） | **Outbox** |
|---|---|---|
| 訂單成立但事件遺失 | 🔴 **可能** | ✅ **不可能**（同一個交易） |
| 事件發出但訂單 rollback | ✅ 不可能 | ✅ 不可能 |
| 程序在 commit 後掛掉 | 🔴 **遺失** | ✅ **記錄還在資料庫裡** |
| 投遞延遲 | ~0 | ⚠️ **輪詢間隔**（1～5 秒） |
| 投遞次數 | 0 或 1 | ⚠️ **至少一次**（可能重複！） |

> 📌 **outbox 的一句話**：
> **它把「事件可能遺失」換成「事件可能延遲、而且可能重複」。**
>
> ⚠️ **後者不是免費的** —— 「可能重複」意味著**每一個消費者都必須冪等**（6.8.4）。
> **這是採用 outbox 最大的隱藏成本，而它常常被輕描淡寫。**

### 6.8.3 表與輪詢器

```sql
CREATE TABLE outbox (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    -- ★ 訊息的身分
    message_id      CHAR(26)     NOT NULL,     -- ULID，給消費端做冪等
    type            VARCHAR(50)  NOT NULL,     -- ORDER_PLACED / ERP_PUSH / …
    aggregate_id    VARCHAR(40)  NOT NULL,     -- ★★ 同一張訂單的訊息要照順序
    payload         JSON         NOT NULL,
    -- ★ 投遞的狀態
    status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',  -- PENDING/SENDING/SENT/DEAD
    attempts        INT          NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3)  NOT NULL,
    last_error      VARCHAR(500) NULL,
    created_at      DATETIME(3)  NOT NULL,
    sent_at         DATETIME(3)  NULL,

    UNIQUE KEY uk_message_id (message_id),
    -- ★★ 輪詢器唯一的查詢用這個索引
    KEY idx_poll (status, next_attempt_at, id),
    -- ★ 清理用
    KEY idx_cleanup (status, sent_at)
) ENGINE=InnoDB;
```

⚠️ **`idx_poll` 的欄位順序是刻意的**：
輪詢的查詢是 `WHERE status='PENDING' AND next_attempt_at <= NOW() ORDER BY id`，
**等值條件在前、範圍條件在中、排序欄位在後** —— 否則會 filesort
（07-mysql 站會完整展開，這裡先知道結論）。

**先把埠定義出來** —— 這六個方法就是輪詢器需要的全部：

```java
package example.shop.common.outbox;

/**
 * outbox 的埠。
 *
 * <p>★★ 注意它<b>沒有</b>一個 {@code save(OutboxMessage)} 之外的通用寫入方法：
 * 每一個狀態轉移都有自己的方法，而它們<b>都是原子的單一 UPDATE</b>
 * （6.8.3 寫法 B）。
 *
 * <p>⚠️ 這是刻意的：如果提供了「讀出來、改一改、存回去」的介面，
 * 一定會有人寫出「先 SELECT 再 UPDATE」——
 * 而那在兩個輪詢器之間<b>必然</b>失效（02 章 2.9）。
 */
public interface OutboxRepository {

    /** 寫入（★ 必須在呼叫端的交易裡 —— 6.8.2）。 */
    void enqueue(OutboxMessage message);

    /** ★ 搶一批待送的訊息：條件式 UPDATE 把 PENDING 改成 SENDING，回傳搶到的那些。 */
    List<OutboxMessage> claimBatch(int batchSize);

    void markSent(long id, Instant sentAt);

    /** ★ 達到重試上限 → 死信。⚠️ 不刪除（6.8.5 陷阱 ①）。 */
    void markDead(long id, String lastError);

    void scheduleRetry(long id, int attempts, Instant nextAttemptAt, String lastError);

    /** ★ 殭屍回收：把卡在 SENDING 超過門檻的改回 PENDING，回傳筆數。 */
    int reclaim(Instant stuckBefore);

    /** ★ 清理：分批刪，回傳這一批刪了幾筆（6.8.5 陷阱 ①）。 */
    int deleteSentBefore(Instant before, int limit);
}
```

**輪詢器**：

```java
@Component
public class OutboxPoller {

    /**
     * ★★ 三個「刻意」的決定：
     * <ol>
     *   <li>{@code fixedDelay} 而不是 {@code fixedRate} ——
     *       後者在一輪跑很久時會<b>堆疊</b>，變成多個輪詢同時跑。</li>
     *   <li>{@code initialDelay} 加抖動 —— 五個實例同時啟動時不要同時打資料庫
     *       （6.6.3 的同一個道理）。</li>
     *   <li>⚠️ 它<b>沒有</b> {@code @Transactional} —— 交易的邊界在
     *       {@code deliverOne} 上，一筆一個交易（見下）。</li>
     * </ol>
     */
    @Scheduled(fixedDelayString = "${shop.outbox.poll-interval:1000}",
               initialDelayString = "#{ T(java.util.concurrent.ThreadLocalRandom).current()"
                                  + ".nextInt(0, 1000) }")
    public void poll() {
        List<OutboxMessage> batch = repository.claimBatch(properties.batchSize());
        for (OutboxMessage message : batch) {
            deliverOne(message);
        }
    }

    /** ★ 一筆一個交易 —— 第 7 筆失敗不會讓前 6 筆重送 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    void deliverOne(OutboxMessage message) {
        try {
            dispatcher.dispatch(message);                 // ★ 真正送出去（HTTP / MQ）
            repository.markSent(message.id(), clock.instant());

        } catch (Exception e) {
            int attempts = message.attempts() + 1;
            if (attempts >= properties.maxAttempts()) {
                // ★★ 死信：不再重試，但【留著】並告警
                repository.markDead(message.id(), summarize(e));
                deadLetters.increment(message.type());
                log.error("outbox 訊息投遞失敗達上限，轉為死信：id={} type={}",
                          message.messageId(), message.type(), e);
            } else {
                repository.scheduleRetry(message.id(), attempts,
                        clock.instant().plus(backoffWithJitter(attempts)), summarize(e));
            }
        }
    }
}
```

**`claimBatch` 的兩種寫法**：

```sql
-- 寫法 A：SELECT … FOR UPDATE SKIP LOCKED（MySQL 8.0+ / PostgreSQL 9.5+）
SELECT * FROM outbox
 WHERE status = 'PENDING' AND next_attempt_at <= NOW(3)
 ORDER BY id LIMIT 50
   FOR UPDATE SKIP LOCKED;
```

```sql
-- 寫法 B（★ shop-service 的選擇）：條件式 UPDATE 搶單
UPDATE outbox
   SET status = 'SENDING', attempts = attempts + 1
 WHERE id = ? AND status = 'PENDING';
-- ★ 回傳 1 = 搶到了；回傳 0 = 別人搶走了
```

**實測**（兩個 worker 同時搶 20 筆）：

```
[I2] 兩個 worker 一共搶到 20 筆，其中不重複的 id 有 20 個
[I2] 有沒有同一筆被兩個 worker 搶到 = false（false = ✅ 條件式 UPDATE 保證了互斥）
[I2] W1 搶到 1 筆，W2 搶到 19 筆
```

⚠️ **注意最後一行：分配非常不平均（1 : 19）。**
這是對的、也是預期的 —— **outbox 的輪詢器不需要負載平衡，它需要的是「不重複」**。

| | 寫法 A（`SKIP LOCKED`） | 寫法 B（條件式 UPDATE） |
|---|---|---|
| 資料庫支援 | MySQL 8.0+ / PG 9.5+ | ✅ **全部** |
| 鎖持有時間 | ⚠️ **整個交易**（包含 HTTP 呼叫！） | ✅ 只有一次 UPDATE |
| 一次抓多筆 | ✅ 一個 query | 需要先 SELECT 再逐筆 UPDATE |
| 崩潰後 | ✅ 鎖自動釋放 | 🔴 **卡在 `SENDING`** → 需要「殭屍回收」 |

> 🔴 **寫法 A 的「鎖持有時間 = 整個交易」是一個致命的細節**：
> 如果你在 `FOR UPDATE` 的交易裡呼叫外部 API（很自然的寫法），
> **那 50 筆訊息的行鎖會被持有整整 5 秒**（HTTP 逾時）——
> 這就是 00 章 0.3.2 事故 1 的翻版，只是換了一張表。

**寫法 B 需要的「殭屍回收」**：

```java
/**
 * ★★ 卡在 SENDING 的訊息 —— 它們的處理者在送出的過程中掛掉了。
 *
 * <p>⚠️ 這個 5 分鐘的門檻<b>必須大於「最長的一次投遞」</b>
 * （整體逾時 × 重試 = 6.5.4 的公式），
 * 否則會把「還在正常處理中」的訊息當成殭屍，造成<b>重複投遞</b>。
 */
@Scheduled(fixedDelay = 60_000)
public void reclaimStuck() {
    int n = repository.reclaim(clock.instant().minus(properties.stuckThreshold()));
    if (n > 0) {
        stuckReclaimed.increment(n);
        log.warn("回收了 {} 筆卡在 SENDING 的 outbox 訊息", n);
    }
}
```

### 6.8.4 至少一次 → 消費端必須冪等 🔴

**這是 outbox 最容易被輕描淡寫的一段。**

**「至少一次」不是罕見的邊界情況，它是【常態】**：

```
投遞成功了 → 正要 UPDATE status='SENT' → 🔴 程序掛掉
                                         → 殭屍回收 → 重送 → 對方收到第二次
```

⚠️ **注意這個縫是【無法消除】的** ——
「送出 HTTP 請求」與「更新資料庫狀態」不可能是原子的（那就是分散式交易了）。

**三種冪等的做法**：

| 做法 | 怎麼做 | 適合 |
|---|---|---|
| **① 對方提供冪等鍵**（★ 最好） | 帶 `message_id` 當 `Idempotency-Key` | ✅ 金流、發票 |
| **② 消費端存已處理的 id** | 一張 `processed_messages` 表 + 唯一鍵 | ✅ 我們自己的服務 |
| **③ 操作本身冪等** | `UPDATE … SET status='SHIPPED'`（做兩次結果一樣） | ✅ 狀態設定類 |

⚠️ **③ 有一個常見的誤用**：

```sql
-- ✅ 冪等（設定成某個值）
UPDATE orders SET status = 'SHIPPED' WHERE id = ?;

-- 🔴 不冪等（相對變化）
UPDATE customers SET points = points + 100 WHERE id = ?;
```

> 🔴 **「加點數」是 6.8.1 的第 ③ 項，而它正是不冪等的那一種。**
> **所以它必須用做法 ②** —— 而那代表點數服務要多一張表。
>
> 📌 **這就是 outbox 的隱藏成本**：
> 它不只是「加一張 outbox 表」，
> 它是**「每一個消費者都要重新設計成冪等的」**。

**做法 ② 的實作**：

```java
@Transactional
public void handle(OutboxMessage message) {
    try {
        // ★★ 先插入「已處理」的記錄 —— 靠【唯一鍵】做互斥，而不是靠「先查再寫」
        processedRepository.insert(message.messageId(), clock.instant());
    } catch (DuplicateKeyException e) {
        duplicatesSkipped.increment(message.type());
        return;                       // ★ 已經處理過了
    }
    // ★ 到這裡保證是第一次 —— 而且與下面的業務寫入在同一個交易裡
    points.grant(message.payload().customerId(), 100);
}
```

⚠️⚠️ **「先插入再處理」而不是「先查再處理」是關鍵**：
02 章 2.9 說過同一件事 —— **「先 SELECT 再 UPDATE」在併發下必然失效**。
兩個執行緒同時處理同一則訊息時，只有唯一鍵擋得住。

### 6.8.5 outbox 的三個陷阱

**陷阱 ①：outbox 表變成最大的表 🔴**

```
每天 5 萬張訂單 × 每張 4 則訊息 = 每天 20 萬列
一年 = 7,300 萬列
```

⚠️ **而 `status='SENT'` 的那些列，99.99% 的查詢用不到它們** ——
但它們**拖慢輪詢的索引**。

```java
/**
 * ★ 清理已送出的訊息。
 *
 * <p>⚠️ 三個細節：
 * <ol>
 *   <li><b>分批刪</b> —— 一次 DELETE 700 萬列會鎖表幾分鐘（02 章 2.14.1）。</li>
 *   <li><b>保留 7 天</b> —— 出事時要能回答「那則訊息到底送了沒」。</li>
 *   <li>🔴 <b>`DEAD` 的永遠不刪</b> —— 它們是待辦事項，不是垃圾。</li>
 * </ol>
 */
@Scheduled(cron = "0 30 3 * * *")            // ★ 離峰
public void purgeSent() {
    Instant before = clock.instant().minus(Duration.ofDays(7));
    int deleted;
    do {
        deleted = repository.deleteSentBefore(before, 1000);    // ★ 一次 1000 列
        sleepQuietly(100);                                       // ★ 讓出 I/O
    } while (deleted == 1000);
}
```

**陷阱 ②：順序 🔴**

```
訂單 O-1 的兩則訊息：ORDER_PLACED（id=100）、ORDER_CANCELLED（id=101）
輪詢器一次抓 50 筆，丟給執行緒池平行送
  → 🔴 ORDER_CANCELLED 先到 ERP，ORDER_PLACED 後到
  → ERP：「取消一張不存在的訂單」→ 錯誤；然後「建立一張訂單」→ 🔴 幽靈訂單
```

**三種處理**：

| 做法 | 保證 | 代價 |
|---|---|---|
| **單執行緒依 `id` 送** | ✅ 全域順序 | 🔴 吞吐量低 |
| **★ 依 `aggregate_id` 分區** | ✅ 同一張訂單有序 | ✅ 不同訂單仍可平行 |
| **消費端自己排序** | ✅ 最有彈性 | 訊息要帶版本號，消費端要能暫存 |

```java
/** ★ shop-service 的選擇：同一個 aggregate 的訊息永遠在同一條執行緒上 */
int partition = Math.floorMod(message.aggregateId().hashCode(), partitions);
executors.get(partition).execute(() -> deliverOne(message));
```

⚠️ **而這個做法有一個必要條件**：
**同一個 aggregate 未送出的訊息，必須依 `id` 順序處理，而且前一則失敗時後面要停住。**

```sql
-- ★ 撈的時候排除「有更早的訊息還卡著」的 aggregate
SELECT o.* FROM outbox o
 WHERE o.status = 'PENDING' AND o.next_attempt_at <= NOW(3)
   AND NOT EXISTS (
        SELECT 1 FROM outbox blocker
         WHERE blocker.aggregate_id = o.aggregate_id
           AND blocker.id < o.id
           AND blocker.status IN ('PENDING','SENDING'))
 ORDER BY o.id LIMIT 50;
```

🔴 **而這個查詢很貴。**
**shop-service 的實際決定：只對 `type IN ('ORDER_PLACED','ORDER_CANCELLED','ORDER_PAID')`
這三種需要順序的訊息做，其他（寄信、清快取）不管順序。**

> 📌 **這是一個很典型的取捨**：
> **「所有訊息都保證順序」的成本，遠高於「找出真正需要順序的那 3 種」。**

**陷阱 ③：輪詢延遲 ⚠️**

```
輪詢間隔 1 秒 → 訊息平均延遲 500ms，最壞 1 秒
```

**對「寄信」沒問題，對「清快取」就是 05 章 5.3.5 說的那個窗口。**

| 需求 | 做法 |
|---|---|
| 大部分訊息 | ✅ 1 秒輪詢就好 |
| **要低延遲** | ★ **outbox + 事件雙軌**：`AFTER_COMMIT` 立刻送一次（快樂路徑），outbox 兜底 |
| 要極低延遲 | CDC（讀 binlog，例如 Debezium）—— ⚠️ **另一套基礎設施** |

```java
/**
 * ★★ 雙軌：立刻送一次，同時也寫 outbox。
 *
 * <p>⚠️ 前提是<b>消費端必須冪等</b>（6.8.4）——
 * 因為快樂路徑成功時，outbox 會再送一次。
 *
 * <p>👉 而「消費端冪等」本來就是 outbox 的必要條件，
 * 所以雙軌<b>沒有增加任何新的要求</b>。這是它划算的原因。
 *
 * <p>⚠️ 事件本身<b>只帶 id</b>，不帶 payload：
 * {@snippet :
 *   public record OutboxEnqueuedEvent(long outboxId, String type) implements DomainEvent { … }
 * }
 * 理由是「資料的唯一真相在那張表上」——
 * 帶 payload 的話，快樂路徑送的內容與輪詢器送的內容<b>可能不一樣</b>。
 */
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async("integrationExecutor")
public void tryImmediateDelivery(OutboxEnqueuedEvent event) {
    try {
        deliverOne(repository.findById(event.outboxId()));
    } catch (Exception e) {
        log.debug("即時投遞失敗，交給輪詢器：id={}", event.outboxId());   // ★ debug 就好
    }
}
```

⚠️ **注意這裡的 `log.debug`** —— 因為**失敗是預期內的**，
而輪詢器一定會補上。**如果這裡用 `warn`，日誌會被淹沒。**

### 6.8.6 什麼該進 outbox、什麼不該

| 訊息 | 進 outbox？ | 理由 |
|---|---|---|
| 推 ERP | ✅ | 不能遺失 |
| 加點數 | ✅ | 不能遺失 |
| 稽核紀錄 | ✅ | 合規 |
| 訂單確認信 | ⚠️ **要** | 「可以遺失」是**過去的**判斷；6.0 事故 1 之後改了 |
| 清快取 | ❌ | 短 TTL 兜底就夠，而 outbox 的延遲反而更糟 |
| 重建搜尋索引 | ❌ | 有全量重建的排程 |

⚠️ **「訂單確認信」那一列是這一章回頭修正 00 章 0.3.1 的地方**：

> 00 章 0.3.1 把通知歸類為「可以遺失」。
> **事故 1 證明那個分類是錯的** —— 客戶沒收到確認信會打客服，
> 而客服要人力，人力要錢。
>
> 📌 **正確的分類判準不是「技術上重不重要」，是**：
> **「遺失的話，誰會發現？發現之後要花多少錢補救？」**
>
> | 分類 | 誰會發現 | 補救成本 |
> |---|---|---|
> | 清快取失敗 | ⚠️ 沒有人（TTL 到期就好了） | 0 |
> | 確認信沒寄 | 🔴 **客戶** | 客服工單 × 3,000 |
> | ERP 沒收到 | 🔴 **倉庫**（貨出不去） | 訂單延遲 |

---

## 6.9 領域事件的可靠投遞

### 6.9.1 把 `DomainEventPublisher` 換掉

**00 章 0.12 定義的埠不用改**（這就是埠的價值）：

```java
public interface DomainEventPublisher {
    void publish(DomainEvent event);
}
```

**換的是實作**：

```java
/**
 * ★★ 事件發佈的實作 —— 依「可靠性等級」路由到兩條不同的路徑。
 *
 * <p>⚠️ 為什麼<b>不是</b>「全部走 outbox」：
 * 清快取走 outbox 的話，快取的髒值窗口會從「幾毫秒」變成
 * 「輪詢間隔 + 投遞時間」——<b>比不用 outbox 更糟</b>（6.8.6）。
 */
@Component
public class RoutingDomainEventPublisher implements DomainEventPublisher {

    private final ApplicationEventPublisher inProcess;
    private final OutboxRepository outbox;

    @Override
    public void publish(DomainEvent event) {
        // ★★ 一律先發行程內的事件（清快取、指標這類「可以遺失」的消費者靠它）
        inProcess.publishEvent(event);

        // ★ 「不能遺失」的事件同時寫進 outbox
        if (event instanceof ReliablyDelivered reliable) {
            outbox.enqueue(OutboxMessage.of(
                    reliable.messageType(), reliable.aggregateId(), event));
        }
    }
}
```

```java
/**
 * ★ 標記介面：這個事件不能遺失。
 *
 * <p>它與 04 章 4.3.4 的三個標記介面是<b>同一個手法</b>：
 * 用型別表達一個「處理方式上的差別」，
 * 而不是用一張要手動維護的清單。
 */
public interface ReliablyDelivered {
    String messageType();
    /** ★ 分區鍵 —— 決定「哪些訊息之間要保證順序」（6.8.5 陷阱 ②）。 */
    String aggregateId();
}
```

```java
public record OrderPlacedEvent(…)
        implements DomainEvent, ReliablyDelivered {          // ★ 加一個介面

    @Override public String messageType() { return "ORDER_PLACED"; }
    @Override public String aggregateId() { return orderId; }
}
```

> 📌 **注意 `publish()` 裡的 `outbox.enqueue()` 是一次資料庫寫入，
> 而它必須在呼叫端的交易裡。**
>
> ⚠️ 02 章 2.12.2 陷阱 ① 的守門（「沒有交易時發事件會遺失」）
> 在這裡變得**更重要**：沒有交易時 `enqueue` 會自己 commit，
> 於是「業務資料 rollback 了但 outbox 留著」——
> **恰好是 outbox 要防的那件事的反面。**

**所以那個守門要升級**：

```java
@Override
public void publish(DomainEvent event) {
    if (event instanceof ReliablyDelivered
            && !TransactionSynchronizationManager.isActualTransactionActive()) {
        // 🔴 這個不能只 log —— 它會造成「幽靈訊息」
        throw new IllegalStateException(
                "不能遺失的事件 %s 必須在交易內發佈，否則 outbox 與業務資料不再原子（06 章 6.9.1）"
                        .formatted(event.getClass().getSimpleName()));
    }
    …
}
```

⚠️ **注意這裡從「dev 才拋、prod 只 log」（02 章 2.12.2 解法 B）
改成了【永遠拋】** —— 因為後果從「事件遺失」升級成了「資料不一致」。

### 6.9.2 事件的相容性：一個會在三個月後咬人的問題

**outbox 裡的訊息會存 7 天。部署時，那些訊息是【舊版】的。**

```
14:00  部署新版：OrderPlacedEvent 多了一個 shippingMethod 欄位
14:00  outbox 裡有 300 則【舊版】的訊息（沒有那個欄位）
14:01  🔴 新版的消費者反序列化舊訊息 → 失敗 → 進死信
```

**四條規則**：

| 規則 | 說明 |
|---|---|
| ① **只加欄位，不刪、不改名、不改型別** | 新欄位一律**可為 null** 或有預設值 |
| ② **訊息帶版本號** | `{"__v": 2, …}` —— 讓消費端能分辨 |
| ③ **反序列化要寬鬆** | `FAIL_ON_UNKNOWN_PROPERTIES = false` |
| ④ **要刪欄位時分兩次部署** | 先讓消費端不再讀它，下一次部署才移除 |

⚠️ **③ 與 03 章 3.4.2 的「白名單」原則看起來矛盾，而它們不矛盾**：

| | API 的請求 | **事件的訊息** |
|---|---|---|
| 來源 | 🔴 **外部**（不可信） | ✅ **我們自己**（上一版的自己） |
| 未知欄位代表 | 攻擊或客戶端錯誤 → **拒絕** | 版本比我新 → **忽略** |
| 原則 | 嚴格 | **寬鬆**（Postel's law） |

> 📌 **判準**：**「不認得的東西」是威脅，還是「未來的自己」？**

⚠️ **而 05 章 5.13 ② 的 `Money` 序列化問題在這裡再一次出現**：

> `Money` 的 `isZero()` / `isPositive()` / `isNegative()` 被 Jackson 當成 getter
> → 序列化出 5 個欄位，而建構子只認得 2 個。

**05 章的解法是給快取的 `ObjectMapper` 設 `IS_GETTER = NONE`。**
**outbox 需要【同一個】修正**，而它是另一個 `ObjectMapper`：

```java
/**
 * ★★ outbox 的 ObjectMapper。
 *
 * <p>⚠️ 它與 05 章 5.8.5 的快取 mapper<b>不是同一個</b>，但有兩個共同的設定：
 * <ul>
 *   <li>{@code IS_GETTER = NONE} —— {@code Money} 的往返（05 章 5.13 ②）</li>
 *   <li>{@code JavaTimeModule} —— {@code Instant} 的往返</li>
 * </ul>
 *
 * <p>而它與快取 mapper<b>不同</b>的地方也有兩個：
 * <ul>
 *   <li>🔴 <b>不開多型型別資訊</b> —— 訊息的型別由 {@code outbox.type} 欄位決定，
 *       把 Java 類別名寫進 payload 會讓「改套件名」變成一個破壞性變更。</li>
 *   <li>✅ {@code FAIL_ON_UNKNOWN_PROPERTIES = false} —— 見上方規則 ③。</li>
 * </ul>
 */
```

> 🔴 **05 章 5.16 的缺口 6 說「`Money` 在其他序列化路徑上仍然是壞的（outbox、Kafka）——
> ⏳ 06 章重新檢查」。這一節就是那個檢查，而結論是：確實壞的，而且要用同一個修法修第二次。**
>
> 👉 6.13 ② 會把它變成一條**掃描測試**：
> **每一個 `ObjectMapper` bean 都必須通過 `Money` 的往返。**

### 6.9.3 稽核紀錄：03 章留下的那個指標

**03 章 3.7.3 的 `findDetailForSupport` 有一段 javadoc**：

> 直接非同步寫入（06 章）。shop-service 用後者，
> 理由是「稽核失敗不該讓查詢失敗」——
> ⚠️ 而那個決定的代價是**稽核紀錄可能遺失**，
> 所以它需要一個「掉了幾筆」的指標（06 章 6.9.3）。

**這一節兌現它，而答案分成兩半 —— 因為「稽核」其實是兩種東西。**

| 稽核的種類 | 例子 | 分類 | 怎麼寫 |
|---|---|---|---|
| **① 合規稽核**（誰改了什麼） | 「客服 S-12 在 10:03 改了訂單 O-1 的地址」 | 🔴 **不能遺失** | ✅ **outbox**（6.8.1 ⑥） |
| **② 存取稽核**（誰看了什麼） | 「客服 S-12 在 10:02 查了訂單 O-1」 | ⚠️ **可以遺失** | `@Async` + **指標** |

⚠️ **03 章那段 javadoc 講的是第 ② 種**，而它的判準是 6.8.6 那張表：

| | 誰會發現遺失 | 補救成本 |
|---|---|---|
| ① 合規稽核 | 🔴 **稽核員**（而且是在稽核當天） | 🔴 **無法補救** —— 事實已經過去了 |
| ② 存取稽核 | ⚠️ 只有在「調查某個外洩」時 | ⚠️ 從 access log 大致還原得到 |

> 📌 **兩者的差別在於「它是不是唯一的真相來源」**：
> **① 是**（沒有別的地方記得「地址被改成什麼」），
> **② 不是**（Nginx 的 access log、APM 的 trace 都留了痕跡）。

**② 的實作與它必須有的三個指標**：

```java
@Component
public class AccessAuditRecorder implements AuditRecorder {

    /**
     * ★ 存取稽核：非同步、可以遺失，但<b>遺失必須可見</b>。
     *
     * <p>⚠️ 它<b>刻意不用</b> outbox：
     * 存取稽核的量是合規稽核的 100 倍以上（每一次查詢都算一筆），
     * 而把它寫進 outbox 會讓 6.8.5 陷阱 ① 的成長速度再乘以 100。
     */
    @Async("integrationExecutor")
    void recordAsync(AuditEvent event) {                 // ★ package-private，給 self 呼叫
        try {
            repository.append(event);
            recorded.increment(event.action());
        } catch (Exception e) {
            // 🔴 這一行就是「可以遺失」的代價，而它必須被量測
            dropped.increment(event.action(), "write-failed");
            log.warn("存取稽核寫入失敗：action={} actor={}",
                     event.action(), event.actor().id(), e);
        }
    }
}
```

**三個指標**（缺一不可）：

| 指標 | 意思 | 告警 |
|---|---|---|
| `audit.access.recorded` | 成功寫入 | 斜率突然變 0 |
| 🔴 **`audit.access.dropped{reason="write-failed"}`** | 寫入失敗掉的 | **> 0 就要看** |
| 🔴 **`audit.access.dropped{reason="rejected"}`** | 🆕 **被執行緒池拒絕掉的** | **> 0 就要看** |

⚠️⚠️ **第三個是這一節的重點，而它非常容易被漏掉。**

`integrationExecutor` 的拒絕策略是 **`ABORT`**（6.2.9）——
佇列滿時 `@Async` 的呼叫端會收到 `TaskRejectedException`。

**而那個例外會在哪裡被拋？**

```java
auditRecorder.record(event);            // ← 代理在這一行 submit，佇列滿 → 這一行拋例外
```

🔴 **它會拋在【呼叫端】—— 也就是那個正在查訂單的請求上 →
「稽核失敗不該讓查詢失敗」這個決定被推翻了。**

**修法**：

```java
/**
 * ★★ 把「提交任務」本身也保護起來。
 *
 * <p>⚠️ 這是一個很少人做、但 6.2.5 的表直接推導得出的結論：
 * <b>{@code ABORT} 策略的例外，會出現在呼叫 {@code @Async} 方法的那一行。</b>
 */
@Override                                    // ★ AuditRecorder.record(AuditEvent)（00 章 0.12）
public void record(AuditEvent event) {
    try {
        self.recordAsync(event);             // ★ 經過代理，才會非同步
    } catch (TaskRejectedException e) {
        dropped.increment(event.action(), "rejected");
        // ⚠️ 不重拋 —— 這就是「稽核失敗不該讓查詢失敗」
    }
}
```

> 🔴 **這是本章第二次遇到「降級必須有指標」**（第一次是 6.2.10 的 `CALLER_RUNS`）。
> **而兩次的形狀完全相同**：
> **一個「讓系統看起來還活著」的機制，如果沒有指標，就等於一個消失的功能。**

⚠️ **注意 `self.recordAsync(event)` 那個 `self`** ——
它是 02 章 2.7.1 的自呼叫問題（06 章 6.2.1 說 `@Async` 共用同一個陷阱）。
**這裡必須經過代理，否則整段都是同步的。**

> 📌 **而 6.11.5 的 ArchUnit 規則 2**（`@Transactional` 不可呼叫 `@Async`）
> **在這裡剛好是安全的**：`findDetailForSupport` 是 `readOnly = true` 的查詢，
> 它不會 rollback，而稽核也不需要看到未提交的資料。
>
> ⚠️ **但規則 2 仍然會擋下它** —— 所以這裡需要一個明確的例外標記
> （與 6.13 ③ 的 `@NoDatabaseWrite` 同一個機制）。
> **「規則擋到一個合法的用法」時，正確的處理是把例外寫出來，而不是放寬規則。**

---

## 6.10 Saga：跨服務的「rollback」★

### 6.10.1 為什麼不能用 `@Transactional`

```java
@Transactional                        // 🔴 它只管【我們的】資料庫
public void create(CreateOrderCommand cmd, Actor actor) {
    orderRepository.save(order);      // ✅ rollback 得掉
    stockService.deduct(...);         // ✅ 同一個資料庫，rollback 得掉
    paymentGateway.charge(...);       // 🔴🔴 rollback 不掉 —— 錢已經扣了
    erpPort.pushOrder(...);           // 🔴 rollback 不掉
}
```

**02 章的一切（傳播行為、隔離等級、鎖）都建立在一個前提上：
所有參與者共用一個交易管理器。**
**跨過行程邊界，那個前提就沒有了。**

⚠️ **「那用 XA / 兩階段提交呢？」**

| | 說明 |
|---|---|
| 金流商支援 XA 嗎 | 🔴 **不支援**（沒有任何一家支援） |
| 效能 | 🔴 鎖持有時間 = 整個分散式交易 |
| 可用性 | 🔴 協調者掛掉 → **參與者全部卡住** |

> 📌 **一句話**：**XA 在你能控制所有參與者時才可能，而外部 API 永遠不在其中。**

### 6.10.2 補償不是 rollback ★★

**這是整節最重要的觀念。**

| | rollback | **補償**（compensation） |
|---|---|---|
| 事情發生過嗎 | ❌ **像沒發生過** | ✅ **發生過，而且留下痕跡** |
| 例子 | `UPDATE` 被撤銷 | 扣款 → **退款**（銀行帳上有兩筆） |
| 中間狀態被看到嗎 | ❌ 不會 | ⚠️ **會**（客戶可能看到「已付款」再看到「已退款」） |
| 會失敗嗎 | 幾乎不會 | 🔴 **會**（退款也會失敗！） |

⚠️⚠️ **最後一列是 Saga 最難的地方：補償本身會失敗。**

```
扣庫存 ✅ → 扣款 ✅ → 推 ERP 🔴 失敗
                    ↓
              補償：退款 🔴 也失敗（原卡註銷 —— 04 章的 REFUND_REJECTED）
                    ↓
              🔴🔴 現在怎麼辦？
```

**答案：交給人。而「交給人」必須是一個【被設計的】路徑，不是一個 catch 區塊。**

```java
/**
 * ★★ 補償失敗 = 需要人工介入。
 *
 * <p>它使用 04 章 4.3.4 的 {@link SideEffectsCommitted} 標記，
 * 因為它的語意完全吻合：<b>已經有不可回復的副作用發生了</b>。
 */
public class CompensationFailedException extends BusinessException
        implements SideEffectsCommitted {

    @Override
    public List<String> committedSideEffects() {
        return List.of("已扣款 " + amount.toPlainString() + " 元（退款失敗）",
                       "已扣庫存 " + itemCount + " 項（已釋放）");
    }
}
```

```java
@Component
public class ManualInterventionQueue {
    /**
     * ★★ 它是一張【資料庫的表】，不是一個告警。
     *
     * <p>⚠️ 理由：告警會被忽略、會被 ack 掉、會在下班時間被靜音。
     * 而一張「未結案的人工待辦」表可以：
     * <ul>
     *   <li>被計數（「現在有 12 筆待處理」是一個可以放進儀表板的指標）</li>
     *   <li>被稽核（「這一筆是誰在什麼時候處理的」）</li>
     *   <li>被 SLA 管理（「超過 4 小時未處理」才是告警）</li>
     * </ul>
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void raise(String type, String aggregateId, String description, Map<String, Object> context) { … }
}
```

### 6.10.3 編排式 vs 協同式

| | **編排式**（orchestration） | 協同式（choreography） |
|---|---|---|
| 誰知道流程 | ★ 一個 `OrderSaga` 類別 | 沒有人 —— 每個服務只知道「收到 X 就做 Y」 |
| 加一個步驟 | 改一個類別 | 改多個服務 |
| 看得出全貌嗎 | ✅ **看得出** | 🔴 **要把所有服務的 listener 拼起來** |
| 耦合 | ⚠️ 協調者知道所有參與者 | ✅ 參與者互不認識 |

> 📌 **shop-service 選編排式**，理由只有一個：
> **「出事的時候，我要能在一個地方讀完整個流程。」**
>
> ⚠️ 協同式在服務數量很多、團隊各自獨立時才划算 ——
> 而它的代價是**沒有人能回答「這張訂單現在卡在哪一步」**。

### 6.10.4 shop-service 的下單 Saga

```java
/**
 * 下單 Saga。
 *
 * <p>★★ 它的狀態機<b>存在資料庫裡</b>（一張 saga_instance 表），
 * 而不是存在記憶體或某個框架裡。理由與 outbox 相同：
 * <b>程序會掛掉，而流程做到一半不能消失。</b>
 */
public enum OrderSagaStep {
    STOCK_RESERVED   (Compensation.RELEASE_STOCK),
    PAYMENT_CHARGED  (Compensation.REFUND),
    ORDER_CONFIRMED  (Compensation.CANCEL_ORDER),
    ERP_PUSHED       (Compensation.NONE);       // ★ 最後一步不需要補償

    private final Compensation compensation;
}
```

**執行與補償**：

```
正向：STOCK_RESERVED → PAYMENT_CHARGED → ORDER_CONFIRMED → ERP_PUSHED
                                              │
                            第 3 步失敗       ↓
反向：                  RELEASE_STOCK ← REFUND
                        （★ 逆序補償已完成的步驟）
```

⚠️ **三個容易做錯的地方**：

| # | 做錯 | 正確 |
|---|---|---|
| ① | 補償**照順序**做 | 🔴 **必須逆序** —— 後面的步驟可能依賴前面的 |
| ② | 只補償「失敗那一步之前」的 | ⚠️ **失敗那一步本身也可能有副作用**（C 類！）→ 要先 `query()` 確認 |
| ③ | 補償不可重試 | ✅ **補償必須可重試** —— 它也走 outbox |

> 🔴 **② 是最微妙的一個**：
> 「扣款逾時」的那一步到底算不算完成？
> **不知道 —— 所以要先 `query()`**（6.6.2），查完才知道要不要補償。
>
> **一個「不知道有沒有做」的步驟，補償它與不補償它都可能是錯的。**

**Saga 的可觀測性**（與 outbox 的死信同一個道理）：

| 指標 | 告警條件 |
|---|---|
| `saga.active`（進行中） | 持續 > 100 或有實例存活 > 10 分鐘 |
| `saga.compensated` | 斜率突增 |
| 🔴 **`saga.compensation_failed`** | **> 0 就要看** |
| 🔴 **`manual_intervention.open`** | **> 0 且超過 4 小時** |

---

## 6.11 測試非同步 ★★

### 6.11.1 `Thread.sleep` 為什麼同時又慢又不可靠

```java
@Test
void 訂單成立後會寄確認信() throws Exception {
    orderService.create(command, actor);
    Thread.sleep(1000);                                    // 🔴
    verify(emailSender).send(any());
}
```

**兩個問題，方向相反**：

| 問題 | 說明 |
|---|---|
| **太短** | CI 的機器比較慢 → 偶發紅燈 → 有人把它改成 `sleep(3000)` |
| **太長** | 50 個這種測試 × 3 秒 = **測試多花 2.5 分鐘**，而且 99% 的時間在等一件早就做完的事 |

⚠️ **而「偶發紅燈」的真正代價不是那次紅燈，是團隊學會了「重跑一次就好」** ——
**之後真的 bug 造成的紅燈也會被重跑掉。**

### 6.11.2 Awaitility：等到條件成立，而不是等一段時間

```java
@Test
void 訂單成立後會寄確認信() {
    orderService.create(command, actor);

    await().atMost(Duration.ofSeconds(5))
           .pollInterval(Duration.ofMillis(20))
           .untilAsserted(() -> verify(emailSender).send(any(OrderConfirmationMail.class)));
}
```

| | `Thread.sleep(1000)` | `await().atMost(5s)` |
|---|---|---|
| 條件在 30ms 就成立 | 等 **1000ms** | ✅ 等 **~30ms** |
| 條件要 2 秒才成立 | 🔴 **失敗** | ✅ 通過 |
| 條件永遠不成立 | 🔴 失敗，訊息是 `Wanted but not invoked` | ✅ 失敗，訊息**同上但多了「等了 5 秒」** |

⚠️ **`untilAsserted` 與 `until` 的差別，而它會咬人**：

```java
// ✅ untilAsserted：斷言失敗 = 「還沒成立」，會繼續輪詢
await().untilAsserted(() -> assertThat(repository.count()).isEqualTo(1));

// ⚠️ until：回傳 boolean，斷言失敗會【直接拋出去】而不是重試
await().until(() -> repository.count() == 1);      // ✅ 這樣寫是對的
await().until(() -> { assertThat(...).isEqualTo(1); return true; });  // 🔴 第一次就炸
```

**三個常見的陷阱**：

| 陷阱 | 說明 |
|---|---|
| ① **條件本身有副作用** | `await().until(() -> queue.poll() != null)` —— 🔴 **每次輪詢都消費一個** |
| ② **忘記 `atMost`** | 預設只有 **10 秒** —— 通常夠，但慢的 CI 上會偶發 |
| ③ 🔴 **只驗「有沒有發生」，不驗「發生幾次」** | 重複投遞的 bug（6.8.4）**完全測不出來** |

```java
// ✅ ③ 的修法：等到之後【再等一下】，確認沒有第二次
await().atMost(5, SECONDS).untilAsserted(() -> verify(erpPort, times(1)).pushOrder(any()));
Thread.sleep(300);                                    // ⚠️ 這裡的 sleep 是【必要】的
verify(erpPort, times(1)).pushOrder(any());           // ★ 確認還是 1 次
```

> 📌 **「證明某件事【沒有】發生」永遠需要等一段固定的時間。**
> Awaitility 解決的是「等到發生」，它**解決不了**「等到確定不會發生」。
> ⚠️ 而那個 `sleep(300)` 應該有一行註解說明它為什麼不能被換掉。

### 6.11.3 用同步執行緒池，把非同步測掉

**大部分「非同步的邏輯」其實不需要真的非同步來測。**

```java
@TestConfiguration
public class SynchronousAsyncConfig {
    /**
     * ★★ 在測試裡把 @Async 變成同步執行。
     *
     * <p>它讓 90% 的 listener 測試變成普通的單元測試 ——
     * 不需要 Awaitility、不會偶發、快 100 倍。
     *
     * <p>⚠️ 而它<b>測不到</b>三件事，那三件事必須另外測：
     * <ol>
     *   <li>ThreadLocal 的遺失（6.2.6）—— 同步執行時 ThreadLocal 還在！</li>
     *   <li>執行緒池滿了的行為（6.2.5）</li>
     *   <li>🔴 <b>交易的可見性</b>（6.3.3）—— 同步執行時「看得到未提交的資料」</li>
     * </ol>
     */
    @Bean @Primary
    public TaskExecutor applicationTaskExecutor() {
        return new SyncTaskExecutor();
    }
}
```

> 🔴 **第 3 點是這個做法最危險的地方，而它必須被寫下來**：
>
> 6.3.3 那個「非同步執行緒看不到未提交的資料」的 bug，
> **在 `SyncTaskExecutor` 下會通過測試** ——
> 因為同步執行時它跟本體在同一條執行緒、同一個交易裡。
>
> 👉 **所以 6.11.5 的規則 2（ArchUnit）不是「多一層保險」，
> 它是那個 bug【唯一】的守門人。**

### 6.11.4 測外部呼叫：`MockRestServiceServer` 與逾時

**測「正常回應」很容易，測「逾時」與「慢」才是重點。**

```java
/** ★ 層次 1：測翻譯（01 章 1.7.3 的 ChargeResult 對映） */
@Test
void 金流回status_0時轉成Succeeded() {
    server.expect(requestTo("/tpc/payment/pay-by-prime"))
          .andExpect(method(POST))
          .andExpect(jsonPath("$.order_number").value("TRX-001"))
          .andRespond(withSuccess("""
              {"status":0,"rec_trade_id":"D2026","transaction_time_millis":1770000000000}
              """, APPLICATION_JSON));

    ChargeResult result = gateway.charge(request);

    assertThat(result).isInstanceOfSatisfying(ChargeResult.Succeeded.class,
            s -> assertThat(s.gatewayTradeNo()).isEqualTo("D2026"));
}
```

```java
/** ★★ 層次 2：測逾時 —— 🔴 MockRestServiceServer 做不到 */
```

⚠️ **`MockRestServiceServer` 攔的是 `ClientHttpRequestFactory`，
所以它【完全繞過】了 socket** —— 逾時、連線池、TLS 一個都測不到。

**兩種真的能測逾時的做法**：

```java
// 做法 A（★ 本章實驗用的）：起一個真的 ServerSocket，接受連線但不回應
try (ServerSocket silent = new ServerSocket(0)) {
    var client = clients.create("test", spec.withReadTimeout(Duration.ofMillis(300)));
    assertThatThrownBy(() -> client.get().uri("/").retrieve().body(String.class))
            .isInstanceOf(ResourceAccessException.class)
            .hasRootCauseInstanceOf(SocketTimeoutException.class);
}
```

```java
// 做法 B：MockWebServer（OkHttp 的測試工具）—— ✅ 可以模擬「慢慢滴」
mockWebServer.enqueue(new MockResponse()
        .setBody("{}")
        .throttleBody(1, 1, TimeUnit.SECONDS));       // ★ 每秒 1 byte
```

> 📌 **判準**：
> **`MockRestServiceServer` 測「翻譯」，真的 socket 測「韌性」。**
> 兩層都要，而它們測的是完全不同的東西。

**測熔斷**：

```java
@Test
void 連續失敗五次之後熔斷器打開且不再呼叫下游() {
    breaker.reset();
    IntStream.range(0, 5).forEach(i -> callAndIgnore());
    assertThat(breaker.getState()).isEqualTo(State.OPEN);

    int callsBefore = fakeErp.callCount();
    assertThatThrownBy(() -> erpPort.pushOrder(snapshot))
            .isInstanceOf(CallNotPermittedException.class);

    // ★★ 最重要的斷言：下游【完全沒有被呼叫】
    assertThat(fakeErp.callCount()).isEqualTo(callsBefore);
}
```

⚠️ **`breaker.reset()` 不是可有可無的**：
熔斷器是**單例、有狀態**的 bean，測試之間會互相污染 ——
**這與 05 章 5.11.2 的「測試之間的快取污染」是同一個問題。**

### 6.11.5 五條守門測試 ★★

**四條 ArchUnit + 一條掃描，全部實測過**（違反時會紅燈，見下方輸出）。

```java
/** ★ 規則 1：@Async 的方法只能回 void 或 Future（6.2.2 —— 否則執行期才炸） */
@Test
void 規則1_Async方法的回傳型別() {
    ArchRule rule = methods().that().areAnnotatedWith(Async.class)
            .should(new ArchCondition<JavaMethod>("回傳 void 或 Future") {
                @Override
                public void check(JavaMethod method, ConditionEvents events) {
                    String rt = method.getRawReturnType().getName();
                    boolean ok = rt.equals("void")
                            || method.getRawReturnType().isAssignableTo(Future.class);
                    if (!ok) {
                        events.add(SimpleConditionEvent.violated(method,
                                method.getFullName() + " 的回傳型別是 " + rt
                                + "，@Async 只支援 void 與 Future（06 章 6.2.2）"));
                    }
                }
            })
            .allowEmptyShould(true);
    rule.check(CLASSES);
}
```

```java
/** ★★ 規則 2：@Transactional 的方法不可直接呼叫 @Async 的方法（6.3.3） */
@Test
void 規則2_交易裡不可呼叫Async方法() {
    ArchRule rule = methods().that().areAnnotatedWith(Transactional.class)
            .should(new ArchCondition<JavaMethod>("不直接呼叫 @Async 的方法") {
                @Override
                public void check(JavaMethod method, ConditionEvents events) {
                    method.getMethodCallsFromSelf().forEach(call ->
                        call.getTarget().resolveMember().ifPresent(target -> {
                            if (target.isAnnotatedWith(Async.class)) {
                                events.add(SimpleConditionEvent.violated(method,
                                        method.getFullName() + " 呼叫了 @Async 方法 "
                                        + target.getFullName()
                                        + "：非同步執行緒看不到未提交的資料（06 章 6.3.3）"));
                            }
                        }));
                }
            })
            .allowEmptyShould(true);
    rule.check(CLASSES);
}
```

```java
/** ★★★ 規則 3：AFTER_COMMIT 的 listener 必須有 REQUIRES_NEW（6.3.5） */
@Test
void 規則3_AFTER_COMMIT的listener必須有REQUIRES_NEW() {
    ArchRule rule = methods().that().areAnnotatedWith(TransactionalEventListener.class)
            .should(new ArchCondition<JavaMethod>("AFTER_COMMIT 時要有 REQUIRES_NEW") {
                @Override
                public void check(JavaMethod method, ConditionEvents events) {
                    var listener = method.getAnnotationOfType(TransactionalEventListener.class);
                    if (listener.phase() != TransactionPhase.AFTER_COMMIT) return;
                    boolean requiresNew = method.isAnnotatedWith(Transactional.class)
                            && method.getAnnotationOfType(Transactional.class)
                                     .propagation() == Propagation.REQUIRES_NEW;
                    if (!requiresNew) {
                        events.add(SimpleConditionEvent.violated(method,
                                method.getFullName()
                                + " 是 AFTER_COMMIT 的 listener 但沒有 "
                                + "@Transactional(propagation = REQUIRES_NEW)"
                                + "：寫入會落進一個【已經 commit 完】的連線（06 章 6.3.5）"));
                    }
                }
            })
            .allowEmptyShould(true);
    rule.check(CLASSES);
}
```

```java
/** ★ 規則 4：@TimeLimiter 的方法必須回 CompletableFuture（6.7.4 —— 否則靜默失效） */
@Test
void 規則4_TimeLimiter必須回CompletableFuture() {
    ArchRule rule = methods().that()
            .areAnnotatedWith(io.github.resilience4j.timelimiter.annotation.TimeLimiter.class)
            .should(new ArchCondition<JavaMethod>("回傳 CompletableFuture") {
                @Override
                public void check(JavaMethod method, ConditionEvents events) {
                    if (!method.getRawReturnType().isAssignableTo(CompletableFuture.class)) {
                        events.add(SimpleConditionEvent.violated(method,
                                method.getFullName()
                                + " 有 @TimeLimiter 但不回 CompletableFuture"
                                + " → TimeLimiterAspect 會【靜默地】不生效（06 章 6.7.4）"));
                    }
                }
            })
            .allowEmptyShould(true);
    rule.check(CLASSES);
}
```

⚠️⚠️ **四條規則都加了 `allowEmptyShould(true)`，而那正是它們的危險之處。**

**00 章 0.11.2 的複查抓過同一個問題**（`allowEmptyShould` 被誤用成例外機制）。
**這一次的問題不同**：`allowEmptyShould(true)` 讓「一個 `@Async` 方法都沒有」時
規則變成綠燈 —— 而那是對的，但它也代表**規則本身可能寫錯了卻永遠是綠的**。

**所以這四條規則必須被「證明它會紅燈」。**

**做法：暫時加一個故意違反的類別，跑一次，確認四條都紅**：

```
[ERROR] Tests run: 4, Failures: 4, Errors: 0
Rule 'methods that are annotated with @Async should 回傳 void 或 Future' was violated (1 times):
  Violations.違反規則1() 的回傳型別是 java.lang.String，@Async 只支援 void 與 Future（06 章 6.2.2）
Rule 'methods that are annotated with @Transactional should 不直接呼叫 @Async 的方法' was violated (1 times):
  Violations.違反規則2() 呼叫了 @Async 方法 Violations.被交易呼叫的Async方法()：
  非同步執行緒看不到未提交的資料（06 章 6.3.3）
Rule '… @TransactionalEventListener should AFTER_COMMIT 時要有 REQUIRES_NEW' was violated (1 times):
  Violations.違反規則3(java.lang.String) 是 AFTER_COMMIT 的 listener 但沒有
  @Transactional(propagation = REQUIRES_NEW)：寫入會落進一個【已經 commit 完】的連線（06 章 6.3.5）
Rule 'methods that are annotated with @TimeLimiter should 回傳 CompletableFuture' was violated (1 times):
  Violations.違反規則4() 有 @TimeLimiter 但不回 CompletableFuture
  → TimeLimiterAspect 會【靜默地】不生效（06 章 6.7.4）
```

> 📌 **05 章練習 3 問的就是這件事**（「這條測試為什麼是假綠燈」）。
> **一條從來沒有紅過的守門測試，與沒有那條測試是等價的。**
>
> 👉 **而 07 章 7.16 會給這個問題一個系統性的答案**（突變測試）。

**規則 5：`@Retryable` / `@Retry` 的方法不可以有副作用標記**

```java
/**
 * ★★ 掃描測試（不是 ArchUnit）：ClassGraph 掃出所有標了重試的方法，
 * 檢查它們宣告的例外裡沒有 SideEffectsCommitted（6.6.5）。
 *
 * <p>⚠️ 用 ClassGraph 而不是 ArchUnit 的理由與 04 章 4.12.5 相同：
 * 這條規則要看的是<b>「方法宣告的 throws 與註解的組合」</b>，
 * 而 ArchUnit 的 API 表達這個很彆扭。
 */
@Test
void 規則5_不可重試的操作不可標重試註解() { … }
```

---

## 6.12 shop-service 的總表

### 6.12.1 六個外部呼叫

| 下游 | 逾時（c/r/整體） | 重試 | 熔斷 | 隔艙 | 降級 |
|---|---|---|---|---|---|
| **金流 TapPay** | 1s / 10s / 12s | 🔴 **0** | ✅ 50% / 20 次 | 10 | 🔴 **無** → 503 |
| **ERP** | 1s / 3s / 5s | 2 | ✅ 50% / 20 次 | 5 | ✅ **outbox** |
| 郵件供應商 | 1s / 3s / 5s | 2 | ✅ | 8 | ✅ outbox |
| 搜尋索引 | 500ms / 1s / 2s | 1 | ✅ | 4 | ✅ 跳過 |
| 發票（財政部） | 2s / 15s / 20s | 🔴 **0** | ✅ 30% / 10 次 | 3 | ✅ outbox |
| Redis（快取） | 200ms | 0 | ✅ **（05 章缺口 7）** | — | ✅ 打資料庫 |

### 6.12.2 套件結構

```
src/main/java/example/shop/
│
├── common/
│   ├── async/
│   │   ├── AsyncConfig.java                    ★★ 三個池 + 例外 handler（6.2.7、6.2.9）
│   │   ├── AsyncProperties.java                ★★ 含「maxSize 是謊言」的檢查（6.2.9）
│   │   ├── ContextPropagatingTaskDecorator.java ★★ 6.2.6
│   │   └── CountingCallerRunsPolicy.java        ★  6.2.10
│   │
│   ├── http/
│   │   ├── OutboundClients.java                ★★ 明確建構（6.4.3）
│   │   ├── HttpClientProperties.java           ★★ 四個逾時（6.5.5）
│   │   ├── OutboundStatusHandler.java          ★★ 502/503 vs 504（6.4.5）
│   │   ├── TraceHeaderInterceptor.java         ★  6.4.4
│   │   ├── RequestSentMarkerInterceptor.java   ★★ A 類 vs C 類（6.6.1）
│   │   └── exception/
│   │       ├── UpstreamNotReachedException.java        （A 類 —— 可重試）
│   │       ├── UpstreamUnavailableException.java       （A 類）
│   │       ├── UpstreamRateLimitedException.java       （A 類）
│   │       ├── UpstreamOutcomeUnknownException.java    ★★（C 類 —— 🔴 不可重試）
│   │       └── OutboundRequestRejectedException.java   （B 類 —— 我們送錯了）
│   │
│   ├── resilience/
│   │   ├── ResilienceConfig.java               ★  6.7
│   │   ├── RetryBudget.java                    ★★ 6.6.4
│   │   └── ResilientCacheErrorHandler.java     ★★ 05 章缺口 7 的解法（6.7.2）
│   │
│   ├── outbox/
│   │   ├── OutboxMessage.java                  ★★ 6.8.3
│   │   ├── OutboxRepository.java               ★★ 條件式 UPDATE 搶單
│   │   ├── OutboxPoller.java                   ★★ 6.8.3
│   │   ├── OutboxDispatcher.java               ★  依 type 路由
│   │   ├── OutboxObjectMapper.java             ★★ Money 往返（6.9.2、05 章 5.13 ②）
│   │   ├── OutboxPurgeJob.java                 ★  6.8.5 陷阱 ①
│   │   └── ProcessedMessageRepository.java     ★★ 消費端冪等（6.8.4）
│   │
│   ├── event/
│   │   ├── DomainEvent.java                    （00 章 0.12）
│   │   ├── DomainEventPublisher.java           （00 章 0.12 —— ★ 介面沒變）
│   │   ├── ReliablyDelivered.java              ★★ 6.9.1
│   │   └── RoutingDomainEventPublisher.java    ★★ 6.9.1
│   │
│   └── saga/
│       ├── SagaInstance.java                   ★  6.10.4
│       ├── SagaStep.java
│       └── ManualInterventionQueue.java        ★★ 6.10.2
│
└── order/
    ├── application/listener/                   （00 章 0.11.1 已規劃）
    │   ├── OrderNotificationListener.java      ★ 改用 outbox（6.8.6）
    │   ├── OrderErpListener.java               ★ 改用 outbox
    │   └── OrderCacheListener.java             ★ 留在事件（6.8.6）
    ├── application/OrderSaga.java              ★★ 6.10.4
    └── infrastructure/
        ├── payment/TapPayGateway.java          ★ 01 章 1.7.3 + 本章的逾時與熔斷
        └── erp/ErpAdapter.java                 ★ 事故 2 的三個修正
```

### 6.12.3 組態全文

```yaml
server:
  shutdown: graceful

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
  task:
    execution:
      shutdown: { await-termination: true, await-termination-period: 20s }

shop:
  async:
    notification:  { core-size: 4, max-size: 8, queue-capacity: 500,  rejection-policy: CALLER_RUNS, await-termination: 20s }
    integration:   { core-size: 2, max-size: 4, queue-capacity: 200,  rejection-policy: ABORT,       await-termination: 20s }
    cache-evict:   { core-size: 2, max-size: 2, queue-capacity: 1000, rejection-policy: CALLER_RUNS, await-termination: 5s }

  http:
    clients:
      payment: { base-url: "${TAPPAY_URL}", connect-timeout: 1s,   read-timeout: 10s, connection-request-timeout: 200ms, overall-timeout: 12s, max-connections: 20, max-attempts: 0 }
      erp:     { base-url: "${ERP_URL}",    connect-timeout: 1s,   read-timeout: 3s,  connection-request-timeout: 200ms, overall-timeout: 5s,  max-connections: 10, max-attempts: 2 }
      invoice: { base-url: "${MOF_URL}",    connect-timeout: 2s,   read-timeout: 15s, connection-request-timeout: 500ms, overall-timeout: 20s, max-connections: 5,  max-attempts: 0 }
      search:  { base-url: "${SEARCH_URL}", connect-timeout: 500ms,read-timeout: 1s,  connection-request-timeout: 100ms, overall-timeout: 2s,  max-connections: 10, max-attempts: 1 }

  outbox:
    poll-interval: 1000
    batch-size: 50
    max-attempts: 10
    stuck-threshold: 5m           # ⚠️ 必須 > 最長的一次投遞（6.8.3）
    retention: 7d

resilience4j:
  circuitbreaker:
    configs:
      default:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 20
        # ⚠️⚠️ 注意：Retry 在 CircuitBreaker 外層（6.7.3 實測），
        #    所以 max-attempts=2 時，10 次邏輯呼叫就會產生 20 個樣本
        minimum-number-of-calls: 20
        failure-rate-threshold: 50
        wait-duration-in-open-state: 30s
        permitted-number-of-calls-in-half-open-state: 3
        # ★ 沒有它的話，低流量的下游會【永遠】停在 OPEN（6.7.1 的 H2 實測）
        automatic-transition-from-open-to-half-open-enabled: true
    instances:
      payment: { base-config: default }
      erp:     { base-config: default }
      invoice: { base-config: default, failure-rate-threshold: 30, minimum-number-of-calls: 10 }
      redis:   { base-config: default, wait-duration-in-open-state: 10s }

  retry:
    configs:
      default:
        max-attempts: 2
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        enable-randomized-wait: true
        randomized-wait-factor: 0.5
        retry-exceptions:
          - example.shop.common.http.exception.UpstreamNotReachedException
          - example.shop.common.http.exception.UpstreamUnavailableException
          - example.shop.common.http.exception.UpstreamRateLimitedException
        # ★★ C 類與 B 類永遠不重試（6.6.1）
        ignore-exceptions:
          - example.shop.common.http.exception.UpstreamOutcomeUnknownException
          - example.shop.common.http.exception.OutboundRequestRejectedException

  bulkhead:
    instances:
      payment: { max-concurrent-calls: 10, max-wait-duration: 0 }
      erp:     { max-concurrent-calls: 5,  max-wait-duration: 100ms }
      invoice: { max-concurrent-calls: 3,  max-wait-duration: 0 }
```

---

## 6.13 本章回頭修正前面的地方 ★★

### ① 🔴 05 章 5.16 缺口 7：快取掛掉時資料庫會被打

**05 章的原文**：

> | 7 | 🔴 **快取掛掉時資料庫會被打** | 需要限流／熔斷 | ⏳ **06 章** |

**這一章的答案有兩半，而只有一半是熔斷**：

| 問題 | 解法 | 在哪 |
|---|---|---|
| 每個請求先花 200ms 試一個已知壞掉的 Redis | ✅ **熔斷**（6.7.2） | `ResilientCacheErrorHandler` |
| 🔴 **100% 的流量打到資料庫** | ⚠️ **熔斷解決不了** —— 需要**限流** | 見下 |

```java
/**
 * ★★ 快取掛掉時保護資料庫的，是限流不是熔斷。
 *
 * <p>⚠️ 這一點在 05 章的缺口清單裡被寫成「需要限流／熔斷」，
 * 而那個「／」掩蓋了一個重要的區分：
 * <ul>
 *   <li><b>熔斷</b>保護的是<b>我們</b>（不要浪費資源在已知會失敗的呼叫上）</li>
 *   <li><b>限流</b>保護的是<b>下游</b>（不要把它打掛）</li>
 * </ul>
 */
@RateLimiter(name = "productQuery")
public ProductView findById(String id) { … }
```

```yaml
resilience4j:
  ratelimiter:
    instances:
      productQuery:
        # ★ 資料庫在快取正常時只承受 3% 的流量（約 240 QPS）
        #   給它 2 倍的餘裕，但不是 30 倍
        limit-for-period: 500
        limit-refresh-period: 1s
        timeout-duration: 50ms      # ⚠️ 等不到就快速失敗（503）而不是排隊
```

> 🔴 **誠實的補充**：**這樣做的結果是「快取掛掉時，一部分使用者會看到 503」。**
> 而那是**刻意的** —— 比「所有人都看到 503（資料庫被打掛）」好。
>
> 📌 **「保護下游」與「讓所有請求成功」是不相容的目標，必須選一個。**

### ② 🔴 05 章 5.16 缺口 6：`Money` 在 outbox 上仍然是壞的

**05 章的原文**：

> | 6 | **`Money` 在其他序列化路徑上仍然是壞的**（outbox、Kafka） | 本章只處理快取 | ⏳ **06 章重新檢查** |

**檢查結果：確實是壞的。** 6.9.2 用同一個修法（`IS_GETTER = NONE`）修了第二次。

⚠️ **而「同一個修法要做兩次」本身就是問題。**

**這一章的處置是加一條掃描測試，讓第三次不會被漏掉**：

```java
/**
 * ★★ 每一個 ObjectMapper bean 都必須能讓 Money 往返。
 *
 * <p>⚠️ 為什麼不是「統一用一個 ObjectMapper」：
 * 它們的其他設定<b>必須不同</b>（快取要多型型別資訊，outbox 不要 —— 6.9.2），
 * 所以能統一的只有「這幾個共同的要求」。
 */
@Test
void 每個ObjectMapper都能讓Money與Instant往返() {
    Map<String, ObjectMapper> mappers = context.getBeansOfType(ObjectMapper.class);
    assertThat(mappers).as("至少要有 web / cache / outbox 三個").hasSizeGreaterThanOrEqualTo(3);

    mappers.forEach((name, mapper) -> {
        Money original = Money.twd("1234.50");
        assertThatCode(() -> {
            String json = mapper.writeValueAsString(original);
            assertThat(mapper.readValue(json, Money.class))
                    .as("%s：Money 往返（05 章 5.13 ②、06 章 6.9.2）", name)
                    .isEqualTo(original);
        }).doesNotThrowAnyException();
    });
}
```

> 📌 **這是這一站反覆在做的同一件事**：
> **把「同一個錯誤犯第三次」從「可能」變成「CI 紅燈」。**

### ③ ⚠️ 05 章 5.3.5 解法 A 的 listener 是同步的

**05 章的預告說**：

> | **5.3.5 解法 A 的 listener 是同步的** | 清快取的延遲（Redis 往返）會加到請求上。
> 而改成 `@Async` 會踩到 6.3 那個「事件遺失」 |

**這一章的結論：改成 `@Async`，而「事件遺失」不是問題。**

理由：**清快取是「可以遺失」的**（6.8.6），因為 05 章 5.3.5 解法 C 的短 TTL 是兜底。

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async("cacheEvictExecutor")                        // ★ 6.2.9 的第三個池
public void onOrderChanged(OrderChangedEvent event) {
    try {
        cacheManager.getCache("orders").evict(OrderContentKeys.of(event.orderId()));
    } catch (Exception e) {
        cacheEvictFailures.increment();              // ★ 05 章 5.6.6 的指標
        log.warn("清快取失敗，將由 TTL 兜底：orderId={}", event.orderId(), e);
    }
}
```

⚠️ **注意它【沒有】`REQUIRES_NEW`**（規則 3 會抓到它）——
因為**它不寫資料庫**。

> 📌 **所以規則 3 需要一個例外機制**，而 shop-service 的做法是
> **加一個 `@NoDatabaseWrite` 標記註解**，讓例外**明確且可被搜尋**
> —— 而不是在 ArchUnit 規則裡硬寫類別名（00 章 0.11.2 的教訓）。

### ④ 🔴 00 章 0.3.1 的三分類需要一個新判準

**00 章把通知歸類為「可以遺失」。事故 1 證明那是錯的。**

**修正**：分類的判準從「技術上重不重要」改成
**「遺失的話誰會發現、補救要多少錢」**（6.8.6 的表）。

**具體變更**：訂單確認信從「可以遺失」改成「不能遺失」→ 走 outbox。

### ⑤ ⚠️ 02 章 2.12.2 陷阱 ① 的守門要升級成「永遠拋例外」

**原本**：dev/test 拋例外，prod 只 log（`strict` 旗標）。

**改成**：對 `ReliablyDelivered` 的事件**永遠拋**（6.9.1）——
因為後果從「事件遺失」升級成了「outbox 與業務資料不再原子」。

### ⑥ ⚠️ 01 章 1.7.3 的 `TapPayGateway` 有兩個修正

| 修正 | 原因 |
|---|---|
| `catch (ResourceAccessException e)` **要分成 A 類與 C 類** | 6.6.1 —— 「連不上」與「等不到回應」的可重試性相反 |
| **加 `disableAutomaticRetries()`** | 6.4.3 —— Apache HttpClient 5 預設會重試冪等方法 |

### ⑦ ⚠️ 00 章 0.11.3 的 yaml 有三處要改

見 6.2.9（新增 `cache-evict` 池、新增 `await-termination`、`rejection-policy` 只剩兩個合法值）。

### ⑧ 本章新增的組態與類別

| 類別 | 給誰用 |
|---|---|
| `ReliablyDelivered` | 00 章 0.12 ⑬ 的兩個事件要實作它 |
| `UpstreamOutcomeUnknownException` | 01 章 1.7.3 的轉接器 |
| `@NoDatabaseWrite` | 05 章 5.3.5 的 cache listener |
| `ManualInterventionQueue` | 04 章 4.3.4 的 `SideEffectsCommitted` 有了消費者 |

---

## 6.14 常見誤區

- **`@Async` 加在同類別自呼叫上** —— 完全沒生效，而它**同步執行了**（實測 `[A3]`：`相同嗎 = true`）。
- **`@Async` 的方法回傳 `String`** —— 編譯得過，**呼叫時才拋 `IllegalArgumentException`**（6.2.2）。
- 以為 `spring.task.execution.pool.max-size` 設了就有上限 —— ⚠️ **沒有同時設 `queue-capacity` 的話它完全沒作用**（實測 `[B2]`：poolSize 停在 8）。
- 以為執行緒池「core 滿了就開到 max」—— 🔴 **實際上是「core 滿了先進佇列」**（實測 `[B1]`）。
- **拒絕策略用 `DISCARD`** —— 任務靜默消失，沒有例外、沒有 log、沒有指標。
- 用了 `CALLER_RUNS` 就以為安全 —— ⚠️ 它會把延遲**傳染給同一個池子裡的其他任務**（6.2.5）。
- **以為 `@Async` 之後 locale 會是 `null`** —— 🔴 **它會是 JVM 的預設值**，於是日本客戶收到中文信（實測 `[C1]`）。
- 把 `@Async` 方法改成回傳 `CompletableFuture` 以為更好 —— 🔴 **呼叫端不接的話，例外連 `log.error` 都沒有**（實測 `[D3]`）。
- **部署時執行緒池佇列裡的任務被丟掉** —— `waitForTasksToCompleteOnShutdown` 預設是 `false`（實測 `[B4]`：0/10）。
- 以為 `waitForTasksToCompleteOnShutdown = true` 就解決了 —— ⚠️ 它只是把「丟掉 500 封」換成「部署卡住」（6.2.8）。
- **在 `@Transactional` 方法裡呼叫 `@Async` 方法** —— 🔴 非同步執行緒**看不到未提交的資料**，而失敗是機率性的（實測 `[E4]`）。
- 用 `@EventListener` 而不是 `@TransactionalEventListener` —— 🔴 **rollback 之後信已經寄出去了**（實測 `[E2]`）。
- **`AFTER_COMMIT` 裡寫資料庫而沒有 `REQUIRES_NEW`** —— 🔴🔴 **它在 H2 上會通過測試**（實測 `[E5]`），因為 `setAutoCommit(true)` 意外地 commit 了它（6.3.5）。
- 沒有交易時發事件 —— ⚠️ `AFTER_COMMIT` 的 listener **靜默地不執行**（實測 `[E7]`）。
- **`RestClient.builder()` 不設逾時** —— 🔴 **沒有讀取逾時，它會一直等下去**（實測 `[F1]`：8 秒後執行緒還活著）。
- 只設 read timeout 就以為安全 —— ⚠️ 它管不到**連線階段**（實測 `[F4]`：4028ms > 3000ms）。
- **忘記 `connectionRequestTimeout`** —— 🔴 池子被榨乾時，等待時間完全不受控（6.5.1）。
- 以為 read timeout 是「整個回應的上限」—— 🔴 **它是「兩個 byte 之間」的上限**，慢慢滴的伺服器**永遠不會觸發它**（實測 `[F5]`）。
- 逾時設了就不算 —— ⚠️ **逾時 × 重試是相乘的**（實測 `[F6]`：2s × 3 = 6079ms）。
- **把「讀取逾時」當成「失敗」然後重試** —— 🔴 **重複扣款**（事故 3）。它是「不知道」，正確做法是 `query()`（6.6.2）。
- 一條鏈上每一層都重試 —— 2 × 3 × 2 = **12 次**，而每一層都覺得自己只重試了一點點（6.6.4）。
- 忘記關掉 Apache HttpClient 的 `automaticRetries` —— ⚠️ 它**悄悄地把重試次數乘以 2**（6.4.3）。
- **業務失敗（卡片被拒）觸發熔斷** —— 🔴 情人節當天，卡片正常的人也不能付款了（實測 `[H5]`）。
- 以為 `@CircuitBreaker` 寫在 `@Retry` 上面就在外層 —— ⚠️ **順序由 aspect 的 `order` 決定**，而 Resilience4j 的預設是 **Retry 在外**（實測 `[H4]`）。
- 看到儀表板顯示熔斷器 `OPEN` 六小時就以為下游壞了六小時 —— ⚠️ **它可能只是六小時沒人呼叫**（實測 `[H2]`）。
- **`@TimeLimiter` 配號誌式 `@Bulkhead`** —— 🔴 `TimeLimiter` **靜默地不生效**（6.7.4）。
- 以為 outbox 只是「加一張表」—— 🔴 它的真正成本是**每一個消費者都要改成冪等的**（6.8.4）。
- outbox 用 `SELECT … FOR UPDATE SKIP LOCKED` 然後在交易裡呼叫外部 API —— 🔴 **行鎖被持有整個 HTTP 逾時**（6.8.3）。
- `points = points + 100` 當成冪等操作 —— 🔴 **它不是**（6.8.4）。
- outbox 表不清理 —— ⚠️ 一年 7,300 萬列，而 99.99% 用不到（6.8.5）。
- 補償照**順序**做 —— 🔴 **必須逆序**（6.10.4）。
- 以為補償一定會成功 —— 🔴 **退款也會失敗**，而那需要一條被設計的人工路徑（6.10.2）。
- 用 `Thread.sleep` 測非同步 —— ⚠️ **同時又慢又不可靠**（6.11.1）。
- 用 `SyncTaskExecutor` 測 listener 就以為測完了 —— 🔴 **6.3.3 那個 bug 在同步執行下會通過測試**（6.11.3）。
- 用 `MockRestServiceServer` 測逾時 —— 🔴 **它繞過了 socket，逾時一個都測不到**（6.11.4）。
- ArchUnit 規則加了 `allowEmptyShould(true)` 就沒再管過 —— ⚠️ **一條從來沒紅過的守門測試等於沒有**（6.11.5）。

---

## 6.15 本章練習

### 練習 1：找出這段程式碼的 10 個問題

```java
@Service
public class OrderIntegrationService {

    private final RestClient erp = RestClient.builder()
            .baseUrl("http://erp.internal/api")
            .build();

    @Transactional
    public void markPaidAndPush(String orderId, PaidNotice notice) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.markPaid(notice.paymentId(), notice.amount(), notice.method(),
                       notice.paidAt(), Instant.now());
        orderRepository.save(order);

        pushToErpAsync(order);
        sendConfirmationMail(order);
    }

    @Async
    @Retryable(maxAttempts = 3)
    public String pushToErpAsync(Order order) {
        var snapshot = erpRepository.loadSnapshot(order.id());
        return erp.post().uri("/orders").body(snapshot).retrieve().body(String.class);
    }

    @Async
    public CompletableFuture<Void> sendConfirmationMail(Order order) {
        String subject = messages.getMessage("mail.orderPlaced.subject", null,
                                             LocaleContextHolder.getLocale());
        mailer.send(order.customerEmail(), subject, render(order));
        return CompletableFuture.completedFuture(null);
    }
}
```

<details>
<summary>答案</summary>

| # | 問題 | 節 |
|---|---|---|
| 1 | 🔴 **`RestClient` 沒有設任何逾時** —— ERP 不回應時會永遠等（實測 `[F1]`） | 6.5.2 |
| 2 | 🔴 **在 `@Transactional` 裡呼叫 `@Async` 方法** —— 兩個都是（6.3.3） | 6.3.3 |
| 3 | 🔴 **`pushToErpAsync` 與 `sendConfirmationMail` 是【自呼叫】** —— `@Async` **完全沒生效**，於是外部 HTTP 呼叫**在交易裡**（事故 2） | 6.2.1、實測 `[A3]` |
| 4 | 🔴 **`pushToErpAsync` 回傳 `String`** —— `@Async` 只支援 `void` 與 `Future`，**執行期才拋**（如果 3 修好的話） | 6.2.2、實測 `[A4]` |
| 5 | 🔴 **`@Retryable` 對「推 ERP」無條件重試** —— 讀取逾時是 C 類（結果未知），重試會造成**重複的出貨單** | 6.6.1 |
| 6 | 🔴 **`pushToErpAsync` 在非同步執行緒裡呼叫 `erpRepository.loadSnapshot()`** —— 交易未提交時讀不到（如果 3 修好的話） | 6.3.3、實測 `[E4]` |
| 7 | 🔴 **`LocaleContextHolder.getLocale()` 在 `@Async` 執行緒上是 JVM 預設值** —— 日本客戶收到中文信 | 6.2.6、實測 `[C1]` |
| 8 | 🔴 **`sendConfirmationMail` 回傳 `CompletableFuture` 而呼叫端丟掉它** —— 例外**完全消失** | 6.2.7、實測 `[D3]` |
| 9 | ⚠️ **傳 `Order`（聚合／Entity）給 `@Async` 方法** —— 另一條執行緒上 Session 已關 → `LazyInitializationException`；正確做法是傳**事件**（不可變快照） | 6.2.6、03 章 3.3.3 |
| 10 | ⚠️ **推 ERP 是「不能遺失」的，卻用 `@Async`** —— 部署時佇列會被丟掉，應該走 outbox | 6.8.1、實測 `[B4]` |

⚠️ **注意 3 是一個「遮蔽者」**：因為自呼叫讓 `@Async` 失效，
所以 4、6、7 這三個問題**在目前的程式碼裡不會發生**。

> 🔴 **而這正是最危險的形狀**：
> 有人把 `pushToErpAsync` 搬到另一個 bean（一個看起來很安全的重構）
> → `@Async` 開始生效 → **4、6、7 同時爆發**。
>
> 📌 **「因為另一個 bug 而沒有發作的 bug」，會在修 bug 的那一天一起發作。**

**修好之後**：

```java
@Service
public class OrderApplicationService {

    @Transactional
    public void markPaidAndPush(String orderId, PaidNotice notice) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.markPaid(notice.paymentId(), notice.amount(), notice.method(),
                       notice.paidAt(), clock.instant());
        orderRepository.save(order);

        // ★ 只發事件，帶著下游需要的一切（含 locale）
        events.publish(OrderPaidEvent.from(order, customerLocale, clock.instant()));
    }
}

@Component
public class OrderIntegrationListener {

    /** ★ ERP：不能遺失 → outbox（RoutingDomainEventPublisher 已經寫進去了） */

    /** ★ 通知：不能遺失 → 也走 outbox（6.8.6 的修正） */

    /** ★ 只有「可以遺失」的才留在 @Async 的 listener 上 */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async("cacheEvictExecutor")
    @NoDatabaseWrite
    public void evictCache(OrderPaidEvent event) { … }
}
```

</details>

### 練習 2：計算逾時預算

**情境**：一個 `POST /api/orders` 的端點，SLO 是 **p99 < 2 秒**。
它會呼叫三個下游：

| 下游 | 呼叫時機 | p50 | p99 |
|---|---|---|---|
| 商品服務（查價格） | ⚠️ **同步、在交易前** | 20ms | 80ms |
| 庫存服務（扣庫存） | ⚠️ **同步、在交易裡** | 30ms | 120ms |
| ERP | commit 之後 | 200ms | 1,500ms |

**問題**：
1. 三個下游的逾時各該設多少？
2. 如果三個都設成 5 秒會發生什麼？
3. 連線池要多大？

<details>
<summary>答案</summary>

**① 逾時**

**逾時要從 SLO 往回推，而不是從「下游多快」往前推。**

```
SLO = 2000ms
  ├─ 商品服務   逾時 = ?
  ├─ 庫存服務   逾時 = ?
  ├─ 自己的處理 約 100ms
  └─ ERP        ★ 在 commit 之後，【不算在 SLO 裡】
```

**規則：同步呼叫的逾時總和 + 自己的處理 ≤ SLO。**

| 下游 | 逾時 | 推導 |
|---|---|---|
| 商品服務 | **300ms** | p99 的 ~4 倍。⚠️ 不是 80ms —— 逾時設在 p99 上會讓 1% 的正常請求失敗 |
| 庫存服務 | **500ms** | p99 的 ~4 倍 |
| 自己 | 100ms | — |
| **合計** | **900ms** | ✅ < 2000ms，留了 1.1 秒的餘裕給重試與抖動 |
| ERP | **5s / 整體 8s** | ✅ 在 commit 之後 → **不受 SLO 約束** |

> 📌 **「逾時是 p99 的 3～5 倍」是一個好的起點**，理由：
> **逾時的目的不是「抓慢的請求」，是「抓死掉的請求」。**
> 設在 p99 附近的逾時會把**正常的尾端延遲**變成錯誤。

**② 三個都設 5 秒**

```
最壞情況 = 5000 + 5000 + 100 = 10,100ms
```

🔴 **SLO 是 2 秒，而最壞情況是 10 秒 —— 超出 5 倍。**

⚠️ **而更糟的是它的傳染性**：使用者等 10 秒之後**通常會重新整理**，
於是同一個請求被送第二次，而第一個還佔著連線 → **雪上加霜**。

> 📌 **一個好用的檢查**：
> **「所有同步逾時的總和」如果大於 SLO，那個 SLO 就是假的。**

**③ 連線池**

**利特爾法則**（02 章 2.11 的同一條）：

```
需要的併發連線數 = QPS × 平均回應時間
```

假設下單 **50 QPS**：

| 下游 | QPS | 平均（p50） | 需要 | 設定（1.5～2 倍餘裕） |
|---|---|---|---|---|
| 商品服務 | 50 | 20ms | 1.0 | **5** |
| 庫存服務 | 50 | 30ms | 1.5 | **5** |
| ERP | 50 | 200ms | 10 | **20** |

⚠️ **但這是「正常情況」。異常情況要用逾時算**：

```
商品服務逾時 300ms 時：50 × 0.3 = 15 條
```

🔴 **而池子只有 5 條** → 其餘的請求會卡在 `connectionRequestTimeout` 上。

**兩種決定，都對，但要知道自己選了哪一個**：

| 選擇 | 池子 | 效果 |
|---|---|---|
| **按正常情況設**（5） | 小 | ✅ 下游變慢時**快速失敗**（等於一個隱含的隔艙） |
| 按最壞情況設（15） | 大 | ⚠️ 下游變慢時我們陪著慢，但成功率高 |

> 📌 **shop-service 選前者**，理由與 6.7.4 相同：
> **「會滿的池子」才有保護作用。**

</details>

### 練習 3：這個 outbox 有 6 個問題

```java
@Transactional
public void placeOrder(CreateOrderCommand cmd) {
    Order order = orderFactory.create(cmd);
    orderRepository.save(order);
    outboxRepository.save(new Outbox("ORDER_PLACED", toJson(order)));
}

@Scheduled(fixedRate = 1000)
@Transactional
public void poll() {
    List<Outbox> messages = outboxRepository.findByStatus("PENDING");
    for (Outbox m : messages) {
        try {
            erpClient.send(m.payload());
            m.setStatus("SENT");
        } catch (Exception e) {
            log.error("送失敗", e);
        }
    }
}
```

<details>
<summary>答案</summary>

| # | 問題 | 節 |
|---|---|---|
| 1 | 🔴 **`toJson(order)` 把整個聚合序列化進去** —— 00 章 0.3.2 事故 6 的重演（地址、電話進了一張沒遮蔽的表）；而且 `Money` 往返是壞的 | 6.9.2、05 章 5.13 ② |
| 2 | 🔴 **`fixedRate` 而不是 `fixedDelay`** —— 一輪跑 3 秒時，會有 3 個輪詢**同時**跑 → 同一則訊息被送多次 | 6.8.3 |
| 3 | 🔴 **`findByStatus("PENDING")` 沒有 `LIMIT`** —— 累積 50 萬筆時，一次撈進記憶體 | 6.8.3 |
| 4 | 🔴🔴 **整個 `poll()` 是一個交易，裡面有 HTTP 呼叫** —— 事故 2 的翻版：一輪 50 筆 × 5 秒 = **連線被佔 250 秒** | 6.8.3、00 章 0.3.2 事故 1 |
| 5 | 🔴 **沒有搶單機制** —— 兩個實例會送同一則訊息 | 6.8.3、實測 `[I2]` |
| 6 | 🔴 **失敗只 `log.error`，沒有 `attempts`／`next_attempt_at`／死信** —— 一則永遠會失敗的訊息會**每秒被重送一次，直到永遠** | 6.8.3 |

⚠️ **第 6 個有一個特別惡劣的後果**：
一則毒訊息（poison message）會讓輪詢器**每一輪都先處理它**（因為它是最舊的 `PENDING`），
於是**後面的訊息永遠排不到** —— 這叫**隊頭阻塞**（head-of-line blocking）。

**還有一個不算「錯」但值得指出的**：

⚠️ **沒有 `message_id`** → 消費端無法做冪等（6.8.4）
→ 而「至少一次」保證下，**這不是可選的**。

</details>

### 練習 4：設計「訂單 30 分鐘未付款自動取消」的可靠投遞

**00 章 0.11.1 有一個 `OrderExpirationJob`。**

**需求**：
- 訂單成立 30 分鐘後未付款 → 自動取消 → 釋放庫存 → 通知客戶。
- 系統有 5 個實例。
- 取消要通知 ERP（不能遺失）。
- ⚠️ **客戶可能在第 29 分 59 秒付款成功。**

**任務**：設計它，並說出三個競態條件與各自的處理。

<details>
<summary>答案</summary>

**三個競態條件**：

| # | 競態 | 處理 |
|---|---|---|
| ① | **5 個實例同時撿到同一張訂單** | ✅ `SELECT … FOR UPDATE`（02 章 2.11）：**行鎖讓 5 個實例序列化**，第二個進來時狀態已經是 `CANCELLED`。⚠️ ShedLock 是**省資源**的，不是保證正確性的（01 章 1.9.3） |
| ② | 🔴 **付款與取消同時發生** | ✅ **同一個鎖就解決了** —— 付款也走 `findByIdForUpdate`；誰先拿到鎖誰先做，另一個看到的是**已經改完的狀態** |
| ③ | ⚠️ **取消成功了，但「釋放庫存」的那一步掛掉** | ✅ 兩者在**同一個交易**裡（00 章 0.3.1 第一類：必須原子） |

**實作**：

```java
@Component
public class OrderExpirationJob {

    /**
     * ★ fixedDelay + 抖動的 initialDelay（6.8.3 的同一組理由）。
     *
     * <p>⚠️ 分散式鎖（ShedLock）在這裡的角色，與大部分人以為的<b>不同</b>：
     * <table>
     *   <tr><th></th><th>誰負責</th></tr>
     *   <tr><td><b>正確性</b>（不會重複取消）</td>
     *       <td>✅ <b>資料庫的行鎖 + 狀態檢查</b> —— 見下方 expireOne()</td></tr>
     *   <tr><td>效率（5 個實例不做同樣的 SELECT）</td>
     *       <td>ShedLock</td></tr>
     * </table>
     *
     * <p>👉 這與 <b>01 章 1.9.3</b> 的結論一致：
     * shop-service 用「<b>冪等 + ShedLock</b>」——
     * <b>冪等保證正確性，ShedLock 只是避免浪費</b>。
     *
     * <p>🔴 <b>而順序不能反過來</b>：
     * 分散式鎖會失敗、會過期、會在 GC 停頓時失效。
     * <b>把正確性押在它上面，等於把正確性押在一個新的、更難的問題上。</b>
     */
    @Scheduled(fixedDelayString = "PT30S")
    @SchedulerLock(name = "orderExpiration", lockAtMostFor = "5m")   // ★ 只為了省資源
    public void expireUnpaidOrders() {
        Instant now = clock.instant();
        // ★ 01 章 1.9.3 的 OrderExpirationJob 已經定義了這個方法
        List<Order> expired = orderRepository.findExpiredPendingPayment(now, 100);

        for (Order candidate : expired) {
            try {
                expireOne(candidate.id());
            } catch (Exception e) {
                log.warn("訂單逾時取消失敗，下一輪會重試：orderId={}", orderId, e);
            }
        }
    }

    /** ★ 一張訂單一個交易 —— 第 7 張失敗不影響前 6 張 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    void expireOne(String orderId) {
        // ★★ ① 與 ② 都靠這一行解決：【行鎖】讓 5 個實例序列化，
        //    而下一行的狀態檢查處理「客戶剛付款成功」的競態。
        //    ⚠️ 為什麼不是 6.8.3 寫法 B 的「條件式 UPDATE」：
        //    那個做法只在「整個操作就是一個 UPDATE」時成立。
        //    這裡要【讀出聚合、讓領域決定還多少庫存、再寫回】——
        //    正是 02 章 2.11.8 決策表裡「必須用悲觀鎖」的那一格。
        Order order = orderRepository.findByIdForUpdate(orderId).orElseThrow();

        if (order.status() != OrderStatus.PENDING_PAYMENT) {
            // ✅ 別的實例做過了，或客戶剛付款成功 —— 兩者都是【正常】的
            expirationSkipped.increment();
            return;
        }

        CancellationResult result = order.cancel(
                Actor.SYSTEM, CancelReason.PAYMENT_TIMEOUT, null, clock.instant());
        orderRepository.save(order);

        // ★ ③ 釋放庫存與取消在同一個交易裡（00 章 0.3.1 第一類：必須原子）
        result.stockReleases()
              .forEach(r -> stockPort.release(r.productId(), r.quantity()));

        // ★ 不能遺失 → outbox（RoutingDomainEventPublisher 與業務資料同一個交易）
        events.publish(OrderCancelledEvent.from(order, result, clock.instant()));
    }
}
```

⚠️ **「用行鎖而不是條件式 UPDATE」是這一題的核心判斷**，而它有一個代價：

| | 條件式 UPDATE（6.8.3 寫法 B） | **行鎖 + 狀態檢查**（這裡） |
|---|---|---|
| 能不能在鎖裡做複雜判斷 | 🔴 **不能** | ✅ **能**（這一題需要） |
| 鎖持有時間 | 一次 UPDATE | ⚠️ **整個交易** |
| 於是 | ✅ 幾乎不佔鎖 | 🔴 **交易裡絕不可以有外部呼叫**（事故 2） |

> 📌 **注意上面的程式碼沒有任何 HTTP 呼叫** ——
> 通知 ERP、寄信全部走 outbox（`events.publish`）。
> **而那不是巧合，是「鎖持有時間 = 整個交易」逼出來的。**

⚠️ **三個容易漏掉的細節**：

| 細節 | 說明 |
|---|---|
| **`findExpiredPendingPayment` 要有 `LIMIT`** | 系統停機一天後開機，會有 5 萬張過期訂單 |
| 🔴 **「狀態不是 `PENDING_PAYMENT`」不是錯誤** | 它是**正常路徑**（有 5 個實例）。用 `warn` 記它會淹沒日誌 —— 用一個 counter |
| ⚠️ **`Order.PAYMENT_WINDOW` 與排程間隔的關係** | 30 秒的間隔代表訂單實際上會在 **30:00～30:30** 之間被取消 —— **這件事要寫進 API 文件**，否則客戶會問「為什麼我 30 分 10 秒付款還是成功了」 |

**⚠️ 而最後一列有一個更深的問題**：

> **「30 分鐘」這個規則，到底是由誰執行的？**
>
> | 做法 | 問題 |
> |---|---|
> | 只靠排程 | 🔴 排程掛了 → **訂單永遠不會過期**，而且沒有人會發現 |
> | ★ **付款時也檢查** | ✅ `Order.pay()` 裡檢查 `expiresAt` → 即使排程掛了，**過期的訂單也付不了款** |
>
> 📌 **這是 00 章 0.8 那條原則的又一次應用**：
> **不變量要守在「它會被違反的地方」，而不是守在「有一個排程會來檢查」。**
> **排程是清理，不是守門。**

</details>

---

## 6.16 驗收清單

### 完成本章後，你的專案應該有

```
✅ common/async/
   ├── AsyncConfig.java                      ★★ 三個池 + AsyncUncaughtExceptionHandler
   │                                         ★★ @EnableAsync(order = HIGHEST_PRECEDENCE)
   ├── AsyncProperties.java                  ★★ 含「maxSize 是謊言」的建構子檢查（6.2.9）
   ├── ContextPropagatingTaskDecorator.java  ★★ 含 finally 清理（6.2.6）
   └── CountingCallerRunsPolicy.java         ★  6.2.10

✅ common/http/
   ├── OutboundClients.java                  ★★ 明確建構 + disableAutomaticRetries
   ├── HttpClientProperties.java             ★★ 四個逾時（6.5.1）
   ├── OutboundStatusHandler.java            ★★ 502/503 vs 504
   ├── RequestSentMarkerInterceptor.java     ★★ A 類 vs C 類（6.6.1）
   └── exception/（5 個）                     ★★ 依「對方處理了嗎」分類

✅ common/resilience/
   ├── ResilienceConfig.java
   ├── RetryBudget.java                      ★★ 6.6.4
   └── ResilientCacheErrorHandler.java       ★★ 05 章缺口 7

✅ common/outbox/（7 個類別）                  ★★ 6.8
✅ common/event/ReliablyDelivered.java        ★★ 6.9.1
✅ common/saga/ManualInterventionQueue.java   ★★ 6.10.2

✅ 組態
   ├── server.shutdown: graceful                    ★★ 事故 1
   ├── spring.task.execution.shutdown.*             ★★ 事故 1
   ├── 每個下游各自的四個逾時                        ★★ 6.5.5
   └── resilience4j 的 circuitbreaker/retry/bulkhead ★★ 6.12.3

✅ 測試
   ├── async/AsyncGuardTest.java               ★★ 四條 ArchUnit（6.11.5，✅ 已證明會紅燈）
   ├── async/AsyncBasicsExperimentTest.java    ★  A1～A5
   ├── async/ThreadPoolGrowthExperimentTest.java ★★ B1～B4
   ├── async/AsyncContextExperimentTest.java   ★★ C1（ThreadLocal）
   ├── async/AsyncExceptionExperimentTest.java ★★ D1～D3
   ├── async/AsyncTransactionExperimentTest.java ★★ E1～E7（本章最重要的一組）
   ├── http/TimeoutExperimentTest.java         ★★ F1～F6
   ├── resilience/ResilienceExperimentTest.java ★★ H1～H5
   └── outbox/OutboxExperimentTest.java        ★  I1～I2

🔴 改掉
   ├── ErpAdapter：加逾時、拿掉 @Retryable、改走 outbox    ★★ 事故 2
   ├── TapPayGateway：ResourceAccessException 分兩類       ★★ 6.6.1
   ├── OrderNotificationListener：改走 outbox               ★  6.8.6
   └── OrderCacheListener：改成 @Async（05 章 5.3.5 解法 A） ★  6.13 ③
```

### 我能回答的問題

- [ ] `@Async`、`@Cacheable`、`@Transactional` 的 advisor 順序該怎麼設？為什麼？（6.3.2）
- [ ] Boot 3.2 的預設執行緒池是什麼？它的 `maxPoolSize` 為什麼沒有用？（6.2.3、6.2.4）
- [ ] `core=4, max=8, queue=500` 的池子，送 100 個任務時有幾條執行緒？（6.2.4）
- [ ] `CALLER_RUNS` 會傳染延遲給誰？（6.2.5）
- [ ] `@Async` 之後 `LocaleContextHolder.getLocale()` 回傳什麼？為什麼那比 `null` 糟？（6.2.6）
- [ ] `void` 與 `CompletableFuture` 的 `@Async` 方法，哪一個的例外會消失？（6.2.7）
- [ ] `waitForTasksToCompleteOnShutdown = true` 解決了事故 1 嗎？（6.2.8）
- [ ] `@Transactional` 的方法裡呼叫 `@Async` 方法會怎樣？為什麼本機測不出來？（6.3.3）
- [ ] `@EventListener` 與 `@TransactionalEventListener` 在 rollback 時的差別？（6.3.4）
- [ ] `AFTER_COMMIT` 裡不加 `REQUIRES_NEW` 的寫入，**在 H2 上**會發生什麼？為什麼那是壞消息？（6.3.5）
- [ ] `RestClient.builder()` 的預設讀取逾時是多少？（6.5.2）
- [ ] 三個（四個）逾時各管什麼？哪一個最常被漏掉？（6.5.1）
- [ ] 一個「每 500ms 回一個 byte」的伺服器，read timeout 會觸發嗎？（6.5.3）
- [ ] 「最壞情況的容量」的公式是什麼？（6.5.4）
- [ ] 失敗的三類（A/B/C）分別是什麼？哪一類最常見？（6.6.1）
- [ ] 「讀取逾時」與「連線逾時」在程式碼裡怎麼分辨？（6.6.1）
- [ ] C 類失敗的正確處置是什麼？為什麼 `query()` 可以重試？（6.6.2）
- [ ] `max-attempts: 3` 是「試 3 次」還是「重試 3 次」？（6.6.3）
- [ ] Resilience4j 的 `@Retry` 與 `@CircuitBreaker` 誰在外層？後果是什麼？（6.7.3）
- [ ] 熔斷器等待時間過了之後，狀態會自動變成 `HALF_OPEN` 嗎？（6.7.1）
- [ ] 熔斷與降級的分工是什麼？哪一個保護資料庫？（6.7.2、6.13 ①）
- [ ] 為什麼「卡片被拒是回傳值不是例外」讓熔斷器變簡單？（6.7.6）
- [ ] outbox 把「事件遺失」換成了什麼？代價是什麼？（6.8.2）
- [ ] `SKIP LOCKED` 與條件式 UPDATE 各自的問題？（6.8.3）
- [ ] `points = points + 100` 是冪等的嗎？（6.8.4）
- [ ] outbox 的順序問題有哪三種解法？shop-service 選哪個？（6.8.5）
- [ ] 補償與 rollback 的四個差別？（6.10.2）
- [ ] 為什麼 `SyncTaskExecutor` 測不出 6.3.3 的 bug？（6.11.3）
- [ ] 為什麼 `MockRestServiceServer` 測不到逾時？（6.11.4）
- [ ] 一條 ArchUnit 規則怎麼證明它不是假綠燈？（6.11.5）

### ⚠️ 已知缺口

| # | 缺口 | 為什麼不修 | 替代 |
|---|---|---|---|
| 1 | 🔴 **沒有真的 MQ**（Kafka / RabbitMQ） | 這台機器沒有 Docker | outbox 直接打 HTTP；6.9.2 的相容性規則對 MQ 一樣適用 |
| 2 | 🔴 **`SKIP LOCKED` 只在 H2 2.2.224 上驗過【語法】** | 沒有真的 MySQL | ⚠️ **shop-service 選的是條件式 UPDATE，它不依賴這個** |
| 3 | ⚠️ **`RequestSentMarkerInterceptor` 沒有實測** | 需要一個「收到請求後才斷線」的伺服器 | ⏳ 6.15 練習之外的延伸 |
| 4 | ⚠️ **Saga 的程式碼是設計，不是完整實作** | 完整的 Saga 引擎超出一章的篇幅 | 狀態機與補償順序的規則是完整的 |
| 5 | ⚠️ **`TimeLimiter` 的「中斷不了阻塞的 socket 讀取」沒有實測** | 需要精確控制 socket 狀態 | 6.5.3 已標註它是「誠實的限制」而非結論 |
| 6 | **限流（6.13 ①）沒有實測** | — | 組態經逐行檢閱 |
| 7 | ⚠️ **`@NoDatabaseWrite` 的 ArchUnit 例外機制沒有寫出完整程式碼** | — | 6.13 ③ 說明了設計 |
| 8 | 🔴 **沒有測「部署中」的真實行為** | 需要 K8s | 6.2.8 的 B4 實驗涵蓋了執行緒池那一層 |
| 9 | ⚠️ **三個執行緒池的大小是推導出來的，不是壓測出來的** | 沒有壓測環境 | 6.7.4 的利特爾法則給了推導方法 |

### ⚠️ 環境與驗證狀態

| 項目 | 值 |
|---|---|
| JDK | Temurin 21.0.5 |
| Maven | 3.9.16 |
| Spring Boot | 3.2.5（Framework 6.1.6） |
| Apache HttpClient | 5.2.x（Boot 管理） |
| Resilience4j | **2.2.0** |
| 資料庫 | **H2 2.2.224**（真的交易管理器） |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗**（共 **33 個**）：

| 組 | 實驗 | 結果 |
|---|---|---|
| A | 預設 executor / 自呼叫 / 回傳型別 | ✅ `core=8, max=MAX_VALUE, queue=MAX_VALUE`；自呼叫**同步執行**；回傳 `String` **執行期才拋** |
| B | 池子成長順序 / 拒絕策略 / shutdown | ✅ **佇列先滿才開新執行緒**；`DISCARD` 靜默；shutdown **0/10 vs 10/10** |
| C | ThreadLocal 傳遞 | ✅ 四個全部消失，**locale 變成 JVM 預設值而非 null** |
| D | 例外去哪 | ✅ `void` → handler；**`Future` 沒接 → 完全消失** |
| E | 交易與非同步（7 個） | ✅ `syncAfterCommit` 的 `txActive` **仍是 `true`**；rollback 時只有 `plainListener` 跑；**沒有 `REQUIRES_NEW` 的寫入在 H2 上會成功，但當下從別條連線看不到** |
| F | 逾時（6 個） | ✅ 預設**無讀取逾時**；`3028ms` / `2004ms`；**慢慢滴的伺服器 read timeout 不觸發**；`2s × 3 = 6079ms` |
| G | request factory | ✅ 加 `httpclient5` **靜默地**換掉實作 |
| H | 熔斷與重試（5 個） | ✅ 第 5 次打開；等待期滿**仍是 `OPEN`**；**Retry 在外層**（1 次呼叫 = 3 次失敗）；`ignore-exceptions` 有效 |
| I | outbox 搶單 | ✅ 條件式 UPDATE **零重複**（分配 1:19） |

🔴 **沒有驗證的**：

| 沒驗證的 | 影響哪一節 |
|---|---|
| **真的 MySQL 的 `SKIP LOCKED`** | 6.8.3 |
| **真的 MQ** | 6.9 |
| K8s 的關機流程 | 6.2.8 |
| `TimeLimiter` + 阻塞 socket | 6.5.3 |
| 限流 | 6.13 ① |
| Saga 的完整執行 | 6.10.4 |

---

## 6.17 下一章預告

這一章一共做了 **33 個實驗**，而它們有一個共同點：

> **每一個實驗都在回答「這段程式碼到底做了什麼」，
> 而不是「這段程式碼應該做什麼」。**

⚠️ **而其中至少四個實驗的結果，與大部分人的直覺相反**：

| 實驗 | 直覺 | 事實 |
|---|---|---|
| `[B1]` | core 滿了會開新執行緒 | **先進佇列** |
| `[C1]` | `@Async` 之後 locale 是 `null` | **是 JVM 預設值** |
| `[D3]` | `Future` 比 `void` 安全 | **例外完全消失** |
| `[E5]` | 錯的寫法會失敗 | **在 H2 上會通過測試** |

> 🔴 **最後一列是整章最重要的一句話**：
> **「測試通過」與「程式碼正確」是兩件事。**

**07 章：Service 層測試。** 而它的第一個問題就是這個：

> **一套 415 個測試、覆蓋率 92%、全部綠燈的測試，
> 為什麼上線第一天就超賣了 47 筆？**

| 07 章的節 | 主題 |
|---|---|
| 7.2 ★★ | **mock 掉的東西就是沒被測到的東西** —— 測試金字塔在 Service 層的具體形狀 |
| 7.3 | Mockito 的基礎，以及**為什麼 shop-service 不用 `@InjectMocks`** |
| 7.5 ★ | 驗證行為：`verify` / `never` / `InOrder`，以及**「驗太多」的代價** |
| 7.6 ★★ | `ArgumentCaptor`：怎麼證明「傳下去的參數是對的」 |
| 7.7 ★★ | **41 個業務例外怎麼測而不寫 41 個測試** |
| 7.8 ★★ | 五種測試替身，以及**什麼時候該用 fake 而不是 mock** |
| 7.9 | **不要 mock 的四種東西** |
| 7.10 ★ | 時間、隨機、ID —— 01 章 1.5「把不確定性注入進來」的兌現 |
| 7.11 ★★ | **交易測不到** —— 哪些事必須用真的資料庫 |
| 7.12 ★★ | 測併發：02 章的悲觀鎖／樂觀鎖怎麼寫測試 |
| 7.14 | 測試資料建構：Object Mother 與 Test Data Builder |
| 7.16 ★★ | **突變測試** —— 6.11.5 那個「假綠燈」問題的系統性答案 |

⚠️ **而 07 章會回頭修正這一章的兩件事**：

| 修正 | 為什麼 |
|---|---|
| **6.11.3 的 `SyncTaskExecutor` 是一個危險的預設** | 它讓 6.3.3 的 bug 變成綠燈。07 章 7.13 會給一個更好的分層 |
| **本章的 33 個實驗不是「測試」** | 它們是**探針**（印出結果給人看），而不是**斷言**。07 章 7.17 會說明兩者的差別，以及為什麼探針**不該**留在 CI 裡 |

---

**完成本章後**，請確認 6.16 的清單。

⚠️ **最後一件事**：這一章有 **9 個已知缺口**，其中 **4 個**
（真的 MQ、真的 MySQL、K8s、壓測）都是**「這台機器上做不到」**。

> 📌 **而 05 章說過的那句話在這裡要再說一次**：
> **「沒做」是一個決定，「做不到」是一個限制。**
> 兩者都要寫下來，而**只有前者需要被辯護**。
>
> ⚠️ 這一章多了第三種：**「做了，但結果與預期不同」**（`[E5]`）。
> **那一種最有價值 —— 它是這一章存在的理由。**

下一章：`07-service-testing-with-mockito.md`
