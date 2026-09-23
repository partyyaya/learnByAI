# 第 00 章：課程地圖與為什麼需要訊息佇列

> 這一站從零開始。**你不需要用過 RabbitMQ，也不需要知道 offset 是什麼。**
> 這一章結束時，你的機器上會有一台 RabbitMQ、一台 Kafka、一台 MySQL，
> 一個連得上三者的 Spring Boot 專案，以及一個把「訊息現在卡在哪裡」印出來的工具——
> 接下來十一章的每一個數字，都從那個工具來。
>
> 但在敲第一個命令之前，這一章要先做三件事：
>
> **一、把「為什麼需要它」講清楚。**
> [05-service/06](../05-service/06-async-and-external-api-calls.md) 的第一個事故是「一次例行部署，3,000 封確認信消失了」。
> 這一章 0.2.1 會把那個事故**重現給你看**：3,000 封信送進 `ThreadPoolTaskExecutor`，
> 一次 `shutdownNow()` 之後，**2,834 封人間蒸發，消失率 94.5%，而且沒有任何錯誤、沒有任何日誌。**
>
> **二、把「兩個主角是兩種模型」講清楚。**
> RabbitMQ 是**訊息代理**，Kafka 是**分散式日誌**。
> 0.4 會用同樣的三則訊息在兩邊各跑一次：
> RabbitMQ 那邊讀完第三則之後，第二個消費者拿到 `null`——**訊息消失了**；
> Kafka 那邊三個 consumer group 輪流讀了三輪，**topic 裡還是那三則**。
> 這個差別不是「功能多寡」，它決定了你後面每一個設計。
>
> **三、先看見「加上 MQ 之後」的痛。**
> 這一章有**六個實測事故**，其中兩個我要先講，因為它們最反直覺：
>
> - **順序這件事，會在你的本機測試裡「通過」。** 0.5.1：同一張訂單的六個事件，不給 key 送進三分區 topic，
>   在一台機器小量測試下**順序完全正確**（Kafka 的 sticky partitioner 讓它們全進了同一個分區）；
>   同一份程式碼換成兩台機器各送一半 —— **順序立刻亂掉**。
>   你的測試綠燈，正式環境紅字。
> - **一則處理不了的訊息，可以把自己變成 DDoS。** 0.5.2：佇列裡只送進**一則**訊息，
>   消費者丟例外、預設 `requeue`，三秒鐘之內這一則被投遞了 **11,191 次**，
>   噴出 **45 MB、335,755 行**日誌 —— 而**佇列積壓顯示 0**。
>   你的監控看板上，這台服務「完全正常」。
>
> 📌 六個事故分別在 01、02、03、06、08、10 章被解決。
> 先看到它們壞掉的樣子，後面學那些設定的時候才知道自己在防什麼。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 重現「記憶體佇列」的三個死法，並說出每一個的消失率（0.2：94.5% / 95.7% / 100% 無聲失敗）。
- 用一句話說出 MQ 解決什麼（0.3.1），並列出它換來的四個新問題（0.5）。
- 說明 **broker 模型與 log 模型的差別**，並用 `null` 與「三個 group 讀三輪還在」兩個實測證明它（0.4）。
- 用 `kafka-consumer-groups.sh --reset-offsets` 把位移倒回去，並讀懂 `LAG` 從 0 變成 3 的意思（0.4.3）。
- 說明**為什麼「不給 key」在你的本機測試裡會通過**，以及它在哪三種情況下會失效（0.5.1）。
- 說出「一則訊息三秒投遞 11,191 次」的機制，以及為什麼**佇列積壓看不出這件事**（0.5.2）。
- 說出這台機器上的端到端延遲數字（0.5.3：直接呼叫 500 ns、RabbitMQ 0.306 ms、Kafka 0.764 ms），
  並用它回答「這個功能能不能接受非同步」。
- 列出三個「加了 MQ 只會更糟」的場景（0.5.6）。
- 用 `docker run` 起 RabbitMQ 與 Kafka，說明指令裡每一個參數的意思，
  並指出 **Kafka 那個 `advertised.listeners` 為什麼要寫兩份**（0.6.2）。
- 在 CLI 裡送出並讀回第一則訊息，兩邊各一次（0.7）。
- 建好本站的基準專案，並讓 `MsgProbe` 印出第一份快照（0.8）。

---

## 0.2 先看見痛：記憶體佇列的三個死法

### 0.2.0 這一章共用的場景

整站用同一個場景：**一個電商的下單流程**。

```
使用者按下「送出訂單」
  ↓
① 寫入 orders 表                    ← 一定要成功，不然就是沒下單
  ↓
② 扣庫存                            ← 一定要成功，不然會超賣
  ↓
③ 寄出訂單確認信                    ← 慢（SMTP 可能 2 秒）、會失敗、但晚 30 秒寄到也沒人會死
  ↓
④ 推送給倉儲系統                    ← 對方的 API 有時候 500
  ↓
⑤ 丟給資料分析                      ← 純粹是加值，掉了也沒人知道
```

①② 必須跟使用者的請求綁在一起（同步、同一個交易）。
③④⑤ 不必 —— 而且**綁在一起反而有害**：SMTP 慢 2 秒，使用者就要等 2 秒；倉儲 API 回 500，訂單就下不了。

所以幾乎每個人的第一個版本都長這樣：

```java
@Service
public class OrderService {

    @Transactional
    public Order placeOrder(PlaceOrderCommand cmd) {
        Order order = orderRepository.save(Order.of(cmd));     // ①
        inventoryService.deduct(cmd.items());                  // ②
        mailTask.sendConfirmAsync(order);                      // ③ 丟給 @Async
        warehouseTask.notifyAsync(order);                      // ④ 丟給 @Async
        analyticsTask.trackAsync(order);                       // ⑤ 丟給 @Async
        return order;
    }
}
```

`@Async` 背後是一個 `ThreadPoolTaskExecutor`，它背後是一個 `LinkedBlockingQueue`。
**你已經有一個佇列了 —— 只是它在 JVM 的 heap 裡。**

這一節要做的事很簡單：**證明那個佇列不能用。**

> 📌 本節三個實驗都**不需要任何 broker**，`mvn test` 直接跑。
> 程式碼放在 `com.example.lab11.ch00`，環境等 0.6 再裝。

### 0.2.1 死法一：部署一次，2,834 封信人間蒸發 ★★

**這是 [05-service/06](../05-service/06-async-and-external-api-calls.md) 那個事故的重現。**

```java
package com.example.lab11.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

class A0InMemoryQueueTest {

    private ThreadPoolTaskExecutor pool(int queueCapacity) {
        ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
        ex.setCorePoolSize(2);
        ex.setMaxPoolSize(2);
        ex.setQueueCapacity(queueCapacity);
        ex.setThreadNamePrefix("mail-");
        ex.initialize();
        return ex;
    }

    @Test
    void deathOne_restart() throws Exception {
        System.out.println("═══ 0.2.1 死法一：部署一次，佇列裡的東西全沒了 ═══");
        ThreadPoolTaskExecutor ex = pool(10_000);
        AtomicInteger sent = new AtomicInteger(), done = new AtomicInteger();

        for (int i = 0; i < 3000; i++) {
            sent.incrementAndGet();
            ex.execute(() -> {
                try { Thread.sleep(2); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
                done.incrementAndGet();
            });
        }
        System.out.printf("  送進佇列        : %,d 封%n", sent.get());
        System.out.printf("  跑了 200ms 之後 : 已寄出 %,d 封，佇列裡還排著 %,d 封%n",
                done.get(), ex.getThreadPoolExecutor().getQueue().size());

        Thread.sleep(200);
        int inQueue = ex.getThreadPoolExecutor().getQueue().size();

        // 這就是 kubectl rollout / SIGTERM 之後那一瞬間
        ex.getThreadPoolExecutor().shutdownNow();
        ex.getThreadPoolExecutor().awaitTermination(2, TimeUnit.SECONDS);

        System.out.printf("%n  ── 部署了（shutdownNow）──%n");
        System.out.printf("  最後真正寄出    : %,d 封%n", done.get());
        System.out.printf("  永遠不會寄出    : %,d 封  ← 沒有任何錯誤、沒有任何日誌%n", sent.get() - done.get());
        System.out.printf("  消失率          : %.1f%%%n", 100.0 * (sent.get() - done.get()) / sent.get());
        System.out.printf("  （其中 %,d 封是還排在記憶體佇列裡、連跑都沒跑過的）%n", inQueue);
    }
}
```

**輸出**：

```
═══ 0.2.1 死法一：部署一次，佇列裡的東西全沒了 ═══
  送進佇列        : 3,000 封
  跑了 200ms 之後 : 已寄出 4 封，佇列裡還排著 2,994 封

  ── 部署了（shutdownNow）──
  最後真正寄出    : 166 封
  永遠不會寄出    : 2,834 封  ← 沒有任何錯誤、沒有任何日誌
  消失率          : 94.5%
  （其中 2,832 封是還排在記憶體佇列裡、連跑都沒跑過的）
```

**停下來看三個數字**：

| 數字 | 意思 |
|---|---|
| **3,000 送進去，166 寄出** | 兩條執行緒、每封 2 毫秒 → 一秒只能處理 1,000 封。3,000 封要 3 秒，而你的部署不會等 3 秒 |
| **消失率 94.5%** | 這不是「偶爾掉一兩封」，這是**絕大多數都掉了** |
| **0 個錯誤** | `shutdownNow()` 回傳的是「還沒跑的任務清單」，**大部分人不看它**。日誌乾淨、監控綠燈、HTTP 200 全部都回過了 |

⚠️ **最關鍵的一句：HTTP 200 已經回給使用者了。**
使用者看到「訂單成立，確認信已寄出」，然後永遠等不到那封信。
**你的資料庫是對的、你的 API 是對的，只有那 2,834 封信不存在。**

> 📌 有人會說「那我用 `shutdown()` 不要用 `shutdownNow()`，優雅關閉就好了」。
> 這只是把問題往後推：
> - `shutdown()` 會等佇列跑完，但 Kubernetes 的 `terminationGracePeriodSeconds` 預設 **30 秒**，之後直接 `SIGKILL`。
>   佇列裡積了 5 分鐘的量，一樣掉。
> - 而且這只處理「有機會優雅關閉」的情況。**OOM、`SIGKILL`、機器斷電、Pod 被驅逐** —— 一個都不優雅。
> - 更根本的問題：**你永遠不知道掉了哪幾封。** 沒有清單、沒有辦法補寄。

### 0.2.2 死法二：佇列滿了，95.7% 的請求被當場拒絕 ★★

上一個實驗的佇列容量開到 10,000。那把它調小一點呢？
`ThreadPoolTaskExecutor` 的 `queueCapacity` 預設是 `Integer.MAX_VALUE`——
很多人覺得那樣不安全（對，會 OOM），所以設了一個上限。設了上限之後：

```java
    @Test
    void deathTwo_queueFull() {
        System.out.println("\n═══ 0.2.2 死法二：佇列滿了，直接把請求打回去 ═══");
        ThreadPoolTaskExecutor ex = pool(100);
        AtomicInteger accepted = new AtomicInteger(), rejected = new AtomicInteger();

        for (int i = 0; i < 3000; i++) {
            try {
                ex.execute(() -> { try { Thread.sleep(2); } catch (InterruptedException ignored) {} });
                accepted.incrementAndGet();
            } catch (RejectedExecutionException e) {
                rejected.incrementAndGet();
            }
        }
        System.out.printf("  佇列容量        : 100（執行緒 2 條）%n");
        System.out.printf("  收下            : %,d 封%n", accepted.get());
        System.out.printf("  當場拒絕        : %,d 封  ← RejectedExecutionException%n", rejected.get());
        System.out.printf("  拒絕率          : %.1f%%%n", 100.0 * rejected.get() / 3000);
        ex.shutdown();
    }
```

**輸出**：

```
═══ 0.2.2 死法二：佇列滿了，直接把請求打回去 ═══
  佇列容量        : 100（執行緒 2 條）
  收下            : 130 封
  當場拒絕        : 2,870 封  ← RejectedExecutionException
  拒絕率          : 95.7%
```

**你只有兩個選擇，兩個都很糟**：

| 佇列容量 | 結果 |
|---|---|
| `Integer.MAX_VALUE`（預設） | 尖峰時佇列一路長 → **heap 被吃掉 → OOM → 整個服務死**（而且連已經接下的請求一起死） |
| 設一個上限（例如 100） | 尖峰時 **95.7% 的任務被 `RejectedExecutionException` 打回來**。你在 Controller 裡要怎麼處理？回 500 給使用者？那訂單到底成不成立？ |

⚠️ **這裡有一個很容易忽略的細節**：`RejectedExecutionException` 是**在 `placeOrder()` 裡面**丟出來的。
如果你的 `placeOrder()` 有 `@Transactional`，這個例外會**把訂單交易一起回滾**——
「因為寄信的佇列滿了，所以訂單下不了」。
**這是一個典型的「加了非同步，結果把同步流程也弄壞了」**。

> 📌 第三個選擇是 `CallerRunsPolicy`（佇列滿了就讓呼叫者自己跑）。
> 它不會丟例外，但它把「寄信的 2 秒」搬回了 HTTP 執行緒上——
> **非同步的意義完全消失**，而且你的 Tomcat 執行緒會被寄信佔滿，
> 接著整個服務的所有 API 一起變慢。這叫**背壓穿透**。

### 0.2.3 死法三：失敗了，沒有人知道 ★★

前兩個死法至少「有機制可以知道」（`shutdownNow()` 的回傳值、`RejectedExecutionException`）。
這一個連那個都沒有。

```java
package com.example.lab11.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

class A0cSilentFailureTest {

    @Test
    void deathThree_silentFailure() throws Exception {
        ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
        ex.setCorePoolSize(2); ex.setMaxPoolSize(2); ex.setQueueCapacity(10_000);
        ex.setThreadNamePrefix("mail-");
        ex.initialize();

        AtomicInteger ok = new AtomicInteger(), boom = new AtomicInteger();
        for (int i = 0; i < 1000; i++) {
            final int n = i;
            ex.execute(() -> {
                if (n % 10 == 3) {                 // 假設 SMTP 這時候逾時
                    boom.incrementAndGet();
                    throw new RuntimeException("smtp timeout for #" + n);
                }
                ok.incrementAndGet();
            });
        }
        ex.getThreadPoolExecutor().shutdown();
        ex.getThreadPoolExecutor().awaitTermination(10, TimeUnit.SECONDS);

        StringBuilder sb = new StringBuilder();
        sb.append("\n═══ 0.2.3 死法三：失敗了，沒有人知道 ═══\n");
        sb.append(String.format("  送出            : 1,000 封%n"));
        sb.append(String.format("  成功            : %,d 封%n", ok.get()));
        sb.append(String.format("  丟了例外        : %,d 封%n", boom.get()));
        sb.append(String.format("  自動重試        : 0 次%n"));
        sb.append(String.format("  進死信          : 0 封%n"));
        sb.append(String.format("  你在 stderr 拿到 : %,d 份堆疊 —— 然後呢？%n", boom.get()));
        // 一次印完，避免被 stderr 的堆疊切斷
        System.out.println(sb);
    }
}
```

**輸出**：

```
═══ 0.2.3 死法三：失敗了，沒有人知道 ═══
  送出            : 1,000 封
  成功            : 900 封
  丟了例外        : 100 封
  自動重試        : 0 次
  進死信          : 0 封
  你在 stderr 拿到 : 100 份堆疊 —— 然後呢？
```

⚠️ **「然後呢？」是這一節的重點。**

你在日誌裡有 100 份堆疊，告訴你「`smtp timeout for #3`、`#13`、`#23`…」。
現在下游的 SMTP 恢復了，你要補寄那 100 封。**你要怎麼做？**

- 從日誌裡撈？那些 `#3`、`#13` 是迴圈變數，**不是訂單 ID**。
  真實的程式碼裡，你的日誌大概只有 `Exception in thread "mail-1" java.lang.RuntimeException: smtp timeout` ——
  **連是哪一封都不知道。**
- 重跑一次整批？那 900 封成功的會**再寄一次**。
- 寫一支腳本去查「哪些訂單沒有寄信紀錄」？可以 —— 前提是你有「寄信紀錄」這張表。
  但如果你有那張表，你其實已經在自己實作 Outbox 了（02 章）。

> 📌 **這個死法的形狀是「失敗之後沒有任何可以重來的憑據」。**
> MQ 解決它的方式很直接：**訊息在被消費者確認之前，一直留在 broker 上。**
> 消費失敗 → 不確認 → broker 再送一次 → 重試若干次 → 進死信佇列 → 你有一份完整清單可以慢慢處理。
> 這一套機制在 05、06 章（RabbitMQ）與 08、10 章（Kafka）會做兩遍。

### 0.2.4 三個死法的共同形狀

把三個實驗擺在一起：

| | 死法一 | 死法二 | 死法三 |
|---|---|---|---|
| **觸發條件** | 部署 / 重啟 / OOM / Pod 驅逐 | 尖峰流量 | 下游暫時故障 |
| **損失** | 2,834 封（94.5%） | 2,870 封（95.7%） | 100 封（10%） |
| **有錯誤訊息嗎** | 沒有 | 有（但在錯的地方 —— 會回滾訂單） | 有堆疊，但**沒有可以重來的憑據** |
| **事後補得回來嗎** | 補不回來 | 補不回來 | 補不回來 |
| **根因** | 佇列在會死的行程裡 | 佇列容量是有限的 heap | 失敗沒有被「記錄成一件待辦」 |

**三個根因收斂成同一句話**：

> **那個佇列的生命週期，跟你的行程綁在一起。**

MQ 做的第一件事，就是把這個綁定拆開：

```
   之前                            之後
┌──────────────────┐        ┌─────────────┐   ┌──────────┐   ┌─────────────┐
│  你的 JVM        │        │  你的 JVM   │   │  broker  │   │  你的 JVM   │
│  ┌────────────┐  │        │  生產者     │──▶│ (另一台) │──▶│  消費者     │
│  │ 佇列       │  │        └─────────────┘   │          │   └─────────────┘
│  │ (heap 裡)  │  │             ↑ 死了       │  訊息    │        ↑ 死了
│  └────────────┘  │             重啟就好     │  還在    │        重啟就好
└──────────────────┘                          └──────────┘
   行程死 = 佇列死                            佇列活得比任何一個行程久
```

📌 **這就是整站的第一原則**：
**訊息佇列的價值不是「非同步」（`@Async` 也能非同步），是「佇列活得比你的行程久」。**
後面十一章講的每一件事 —— confirm、ack、持久化、offset、Outbox、死信 ——
都是在確保「活得比行程久」這個承諾在各種故障下依然成立。

---

## 0.3 MQ 到底解決了什麼

### 0.3.1 一句話

> **訊息佇列是一個把「待辦事項」存在你的行程外面、並且保證有人會來處理它的伺服器。**

三個關鍵字，每一個都會影響後面的設計：

| 關鍵字 | 意思 | 後果 |
|---|---|---|
| **待辦事項** | 存的不是「資料」而是「一件該做的事」 | 它有**生命週期**（待處理 → 處理中 → 完成 / 失敗），這是 MQ 跟資料庫最大的不同 |
| **行程外面** | 跟你的 Java 程式是兩個行程，通常還是好幾台機器 | 0.2 的三個死法全部消失；但你多了**網路、序列化、broker 自己也會掛**這三類新問題 |
| **保證有人處理** | 訊息在被「確認」之前不會消失，沒人確認就重送 | **重送 = 重複。** 這是 MQ 最貴的代價，03 章整章在處理它 |

### 0.3.2 它換來的四件事

實務上你會因為這四個理由之一去裝 MQ：

**① 解耦 —— 生產者不需要知道誰在聽**

```
之前：OrderService 直接呼叫 MailService、WarehouseClient、AnalyticsClient
      → 新增一個「發推播」的需求，要改 OrderService
      → WarehouseClient 的 API 改了，要改 OrderService
      → 這三個任何一個慢 / 壞，OrderService 一起慢 / 壞

之後：OrderService 只做一件事 —— 送出「訂單已成立」這個事實
      → 誰要聽，自己去訂
      → 新增推播 = 加一個消費者，OrderService 一行都不用改
```

**② 削峰 —— 把尖峰的量攤到後面的時間**

雙十一零點，下單 QPS 從 200 衝到 8,000。
`orders` 表的寫入可以撐（那是必要的），但「寄信」不必在那一秒完成。
訊息進佇列 → 積壓衝到 50 萬 → 消費者以自己的速度慢慢追（10 章會實測這個追平過程）。

⚠️ **削峰有個前提：後面那段真的可以慢。**
如果「扣庫存」也丟進 MQ，那使用者按下送出時你沒辦法回答「買到了沒」——
這是 0.5.6 要講的「不該用 MQ」的第一種情況。

**③ 重試與死信 —— 失敗是一件有紀錄的事**

這是 0.2.3 缺的東西。有了 broker：

```
消費失敗 → 不 ack → broker 重送（可設退避）→ 重試 5 次還是失敗
        → 進死信佇列 → 你有一份「這 100 則處理不了」的完整清單
        → 下游修好之後，把死信倒回主佇列重跑
```

**④ 扇出 —— 一則訊息，多個互不相干的消費者**

「訂單已成立」這件事，寄信要知道、倉儲要知道、資料分析要知道、風控要知道。
生產者送一次，四個消費者各自拿到一份、各自失敗重試、互不影響。

> 📌 **這四件事你可以自己實作**（用資料庫當佇列 + `@Scheduled` 輪詢），
> 而且在小系統裡那其實是個**很合理的選擇**（0.5.6 會說什麼時候）。
> 裝 MQ 的理由不是「做不到」，是「不想自己維護那套東西」。

### 0.3.3 它「不」解決什麼

這一節比上一節重要。**下面每一件事，都是有人以為 MQ 會幫他做、結果出事的**：

| 以為 MQ 會幫你 | 實際上 |
|---|---|
| 「訊息不會掉」 | 會。生產者到 broker、broker 自己、broker 到消費者，**三段都會掉**。01 章整章在講這三段 |
| 「訊息不會重複」 | 會。而且**在正確設定下重複是必然的**，不是 bug。03 章整章在講怎麼接受它 |
| 「訊息有順序」 | 沒有。RabbitMQ 多消費者就沒有；Kafka 只保證**同一個分區內**有序（0.5.1） |
| 「資料庫跟訊息會一起成功或一起失敗」 | 不會。這叫雙寫問題，**02 章整章在講**，答案是 Outbox |
| 「加了 MQ 系統就變快」 | 不會，會變**慢**（0.5.3：多 0.3～0.8 毫秒）。它讓**使用者感覺變快**，因為慢的事被搬走了 |
| 「加了 MQ 系統就變穩」 | 不一定。你多了一個會掛的元件，而且 0.5.2 那種故障形狀**比同步呼叫更難查** |

---

## 0.4 兩種模型：broker 與 log

這一站兩個主角**不是「兩個牌子的 MQ」，是兩種模型**。
搞清楚這件事，後面 07～09 章的 Kafka 設定你會覺得理所當然；搞不清楚，你會一直覺得「Kafka 為什麼這麼麻煩」。

| | **RabbitMQ**：訊息代理（broker） | **Kafka**：分散式日誌（log） |
|---|---|---|
| 心智模型 | **郵局**。信投進去，郵差送給收件人，送到就沒了 | **帳本**。事情寫進去就留著，誰看到哪一行自己記 |
| 訊息被讀走之後 | **從 broker 上消失** | **還在**，直到 retention 到期 |
| 「我讀到哪了」記在哪 | broker 記（它知道哪些還沒 ack） | **消費者記**（offset） |
| 能不能重讀 | 不能。要重播只能請上游重送 | 能。把 offset 倒回去就好 |
| 路由能力 | **很強**。四種 exchange、routing key、header 比對 | 很弱。只有 topic 跟 partition |
| 誰負責分派 | broker（它主動推給消費者） | 消費者（它自己拉） |

下面兩個實測，把「訊息被讀走之後」那一列證明給你看。

### 0.4.1 實測：RabbitMQ —— 讀走就沒了

```java
package com.example.lab11.ch00;

import com.example.lab11.MsgProbe;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.rabbit.core.RabbitAdmin;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class A1BrokerVsLogTest {

    @Autowired MsgProbe probe;
    @Autowired RabbitAdmin rabbitAdmin;
    @Autowired RabbitTemplate rabbit;

    static final String Q = "demo.broker.q";

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    @Test
    void rabbit_consumedIsGone() {
        System.out.println("═══ 0.4.1 broker 模型：讀走就沒了 ═══");
        rabbitAdmin.deleteQueue(Q);
        rabbitAdmin.declareQueue(new Queue(Q, true, false, false));

        for (int i = 1; i <= 3; i++) rabbit.convertAndSend(Q, "order-created-" + i);
        sleep(300);   // broker 的統計不是即時的，等它一下
        System.out.printf("  送了 3 則，佇列積壓 = %d%n", probe.depth(Q));

        System.out.println("\n  ── 消費者 A 讀 ──");
        for (int i = 0; i < 3; i++) {
            Object m = rabbit.receiveAndConvert(Q);
            sleep(200);
            System.out.printf("    收到 %s   （讀完積壓 = %d）%n", m, probe.depth(Q));
        }

        System.out.println("\n  ── 消費者 B 也想讀同樣那 3 則 ──");
        Object again = rabbit.receiveAndConvert(Q);
        System.out.printf("    收到 %s   ← 沒有了。訊息在消費者 A 確認的那一刻就從 broker 上消失%n", again);
        System.out.printf("    佇列積壓 = %d%n", probe.depth(Q));
    }
}
```

**輸出**：

```
═══ 0.4.1 broker 模型：讀走就沒了 ═══
  送了 3 則，佇列積壓 = 3

  ── 消費者 A 讀 ──
    收到 order-created-1   （讀完積壓 = 2）
    收到 order-created-2   （讀完積壓 = 1）
    收到 order-created-3   （讀完積壓 = 0）

  ── 消費者 B 也想讀同樣那 3 則 ──
    收到 null   ← 沒有了。訊息在消費者 A 確認的那一刻就從 broker 上消失
    佇列積壓 = 0
```

📌 **`null`。** 這一個字就是 broker 模型的全部。

**後果 ——「讀過」在 RabbitMQ 裡是一個破壞性動作**：

- 消費者把訊息處理錯了（程式有 bug、算錯金額），想重跑 → **不行**，訊息已經不見了。
  只能請上游把那批訂單重新送一次事件。
- 新增一個消費者（例如「訂單成立要同步到新的 BI 系統」），想補跑過去三個月的資料 → **不行**。
- ⚠️ **注意 `receiveAndConvert()` 的預設行為**：它在拿到訊息的同時就 ack 了。
  如果你的程式在拿到之後、處理完之前掛掉 —— **訊息已經消失，事情沒做**。
  這是 01 章「第三段遺失」的其中一種，05 章會用手動 ack 修掉它。

> 📌 這不是缺點，是**取捨**。
> broker 模型換來的是：**極低的維運成本**（積壓是 0 就是真的處理完了）、
> **極強的路由能力**、**內建的死信與延遲機制**。
> RabbitMQ 在「任務派工」這個場景上比 Kafka 好用得多 —— 11 章會把這個決策表攤開。

### 0.4.2 實測：Kafka —— 讀完還在，而且可以重讀

同樣的三則訊息，換到 Kafka：

```java
    static final String T = "demo.log.t";

    private List<String> drain(String group, boolean fromBeginning) {
        Map<String, Object> cfg = new HashMap<>();
        cfg.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:19092");
        cfg.put(ConsumerConfig.GROUP_ID_CONFIG, group);
        cfg.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        cfg.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        cfg.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, fromBeginning ? "earliest" : "latest");
        cfg.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        List<String> got = new ArrayList<>();
        try (KafkaConsumer<String, String> c = new KafkaConsumer<>(cfg)) {
            c.subscribe(List.of(T));
            long deadline = System.currentTimeMillis() + 8000;
            while (System.currentTimeMillis() < deadline && got.size() < 3) {
                ConsumerRecords<String, String> rs = c.poll(Duration.ofMillis(500));
                rs.forEach(r -> got.add(r.value() + "@p" + r.partition() + ":off" + r.offset()));
            }
            if (!got.isEmpty()) c.commitSync();
        }
        return got;
    }

    @Test
    void kafka_consumedStays() throws Exception {
        System.out.println("\n═══ 0.4.2 log 模型：讀完還在，而且可以重讀 ═══");
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(T).partitions(1).replicas(1).build());
        for (int i = 1; i <= 3; i++) kafka.send(T, "ord", "order-created-" + i).get();
        probe.topicShape(T);

        System.out.println("\n  ── group=billing 讀 ──");
        drain("billing", true).forEach(s -> System.out.println("    " + s));
        probe.topicShape(T);
        probe.lag(T, "billing");

        System.out.println("\n  ── group=analytics 從頭讀同一個 topic ──");
        drain("analytics", true).forEach(s -> System.out.println("    " + s));
        System.out.println("    ↑ 一模一樣的 3 則。兩個 group 互不影響");

        System.out.println("\n  ── 再換一個 group 從頭讀 ──");
        drain("billing-replay", true).forEach(s -> System.out.println("    " + s));
        probe.topicShape(T);
    }
```

**輸出**：

```
═══ 0.4.2 log 模型：讀完還在，而且可以重讀 ═══
  [kafka ] demo.log.t         分區=1   總訊息數=3        p0=3

  ── group=billing 讀 ──
    order-created-1@p0:off0
    order-created-2@p0:off1
    order-created-3@p0:off2
  [kafka ] demo.log.t         分區=1   總訊息數=3        p0=3
  [kafka ] demo.log.t         group=billing        lag=0       p0: 3/3

  ── group=analytics 從頭讀同一個 topic ──
    order-created-1@p0:off0
    order-created-2@p0:off1
    order-created-3@p0:off2
    ↑ 一模一樣的 3 則。兩個 group 互不影響

  ── 再換一個 group 從頭讀 ──
    order-created-1@p0:off0
    order-created-2@p0:off1
    order-created-3@p0:off2
  [kafka ] demo.log.t         分區=1   總訊息數=3        p0=3
```

**三件事值得停下來看**：

1. **讀了三輪，`總訊息數=3` 一次都沒變。** Kafka 上「讀」不刪任何東西。
   刪除只由 **retention**（時間 / 大小）決定 —— 09 章會講怎麼設。
2. **`off0`、`off1`、`off2` 每一輪都一樣。** offset 是「這則訊息在這個分區裡的第幾行」，
   它是**固定的、單調遞增的、永遠不變的**。這是 Kafka 一切設計的基礎。
3. **`lag=0  p0: 3/3`** —— `3/3` 是「已提交位移 / 分區最後位移」。
   這是 Kafka 唯一的進度指標，10 章的監控整節都在看它。

📌 **「兩個 group 互不影響」是 Kafka 扇出的方式。**
RabbitMQ 要扇出得建兩個 queue、綁到同一個 exchange（04 章）；
Kafka 不用建任何東西 —— 換一個 `group.id`，就是一個新的獨立消費者。

### 0.4.3 真正把位移倒回去

上面那個實驗是用「換一個新的 group 名稱」偷懶模擬重讀。
**真的把一個既有 group 的位移倒回去，要用 CLI**：

```bash
# ① 先看現在讀到哪
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group billing
```

```
Consumer group 'billing' has no active members.

GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG   CONSUMER-ID  HOST  CLIENT-ID
billing         demo.log.t      0          3               3               0     -            -     -
```

```bash
# ② 先 dry-run，它會告訴你「要改成什麼」但不真的改
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --group billing --topic demo.log.t \
  --reset-offsets --to-earliest --dry-run
```

```
GROUP                          TOPIC                          PARTITION  NEW-OFFSET
billing                        demo.log.t                     0          0
```

```bash
# ③ 確認沒問題再真的執行
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --group billing --topic demo.log.t \
  --reset-offsets --to-earliest --execute

# ④ 再看一次
docker exec kafka-lab /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:29092 --describe --group billing
```

```
GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG   CONSUMER-ID  HOST  CLIENT-ID
billing         demo.log.t      0          0               3               3     -            -     -
```

**`CURRENT-OFFSET` 從 3 變成 0、`LAG` 從 0 變成 3。**
下次 `billing` 的消費者一啟動，它會把那三則**重新處理一遍**。

⚠️ **兩個一定要記住的限制**：

- **`--reset-offsets` 只能在 group 沒有活躍成員時執行。** 上面輸出的第一行
  `Consumer group 'billing' has no active members.` 不是警告，是**前提**。
  消費者還在跑的時候執行會直接報錯 —— 你必須先把消費者停掉。
- **重放 = 重複處理。** 那三則會被重跑，所以你的消費者**必須是冪等的**，
  否則重放一次就是重複扣款、重複寄信。這就是 03 章存在的理由。

> 📌 `--to-earliest` 只是其中一種。常用的還有
> `--to-datetime 2026-09-21T00:00:00.000`（倒回某個時間點）、
> `--shift-by -1000`（往回 1000 則）、`--to-offset 12345`（指定位移）。
> 08 章 8.7 會把「線上出事之後怎麼安全重放」寫成 SOP。

### 0.4.4 所以這一站為什麼兩個都學

因為**它們擅長的事不一樣，而且不是「一個是另一個的超集」**：

| 需求 | 選哪個 | 為什麼 |
|---|---|---|
| 「寄這封信」「產這張 PDF」—— 派工，做完就沒事 | **RabbitMQ** | 積壓 = 待辦量，一眼看懂。做完就消失正好符合語意 |
| 「訂單已成立」—— 一個事實，五個人想知道，而且未來還會多 | **Kafka** | 新消費者可以補跑歷史。RabbitMQ 做不到 |
| 「延遲 30 分鐘後檢查未付款訂單」 | **RabbitMQ** | TTL + DLX 或延遲外掛，一行設定（06 章）。Kafka 要自己做時間輪 |
| 「每秒 50 萬筆點擊事件」 | **Kafka** | 這是它的設計目標。RabbitMQ 在這個量級會很痛 |
| 「複雜路由：VIP 訂單走這條、一般訂單走那條、金額 > 10 萬額外通知風控」 | **RabbitMQ** | topic exchange 一行 binding（04 章）。Kafka 得自己在消費端過濾 |
| 「同一份事件流，即時消費 + 每天重跑一次做對帳」 | **Kafka** | 兩個 group，各自的 offset |

📌 **這張表在 11 章會擴充成完整的決策表**（加上維運成本、團隊熟悉度、既有系統）。
現在只需要記住一件事：**「哪個比較好」是錯的問題，「這個功能的語意是派工還是事實」才是對的問題。**

---

## 0.5 加上 MQ 之後，多出來的四個問題

0.2 的三個死法解決了，但你換來四個新問題。
**這四個問題是這一站剩下十一章的全部內容**，所以這一節要把它們量給你看。

### 0.5.1 問題一：順序 —— 而且它「小量測試時是對的」★★★

**這是本章最重要的一節。** 不是因為順序最難，是因為**它會騙過你的測試**。

場景：一張訂單的六個狀態事件，按正確順序送出：

```
1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
```

消費者拿這些事件去更新一張「訂單狀態」表。如果 `4-SHIPPED` 比 `2-PAID` 先到，
狀態機就會炸（或者更糟 —— 靜靜地寫進一個不可能的狀態）。

先看**大部分人寫的版本**：不給 key，送進一個三分區的 topic。

```java
package com.example.lab11.ch00;

import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
// ... 其餘 import 見完整檔案

@SpringBootTest
class A2bStickyTrapTest {

    static final String[] STEPS = {
        "1-CREATED", "2-PAID", "3-STOCK_RESERVED", "4-SHIPPED", "5-DELIVERED", "6-CLOSED"
    };

    private KafkaProducer<String, String> producer(String clientId, Map<String, Object> extra) {
        Map<String, Object> cfg = new HashMap<>();
        cfg.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:19092");
        cfg.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        cfg.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        cfg.put(ProducerConfig.CLIENT_ID_CONFIG, clientId);
        cfg.putAll(extra);
        return new KafkaProducer<>(cfg);
    }

    @Test
    void trap1_stickyLooksFine() throws Exception {
        System.out.println("═══ 0.5.1 陷阱：不給 key，但小量測試「看起來是對的」 ═══");
        String t = "demo.sticky.a." + System.currentTimeMillis();
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(t).partitions(3).replicas(1).build());
        List<String> sent = new ArrayList<>();
        try (var p = producer("one-instance", Map.of())) {
            for (String s : STEPS) { p.send(new ProducerRecord<>(t, null, s)).get(); sent.add(s); }
        }
        report("單一 producer、6 則、預設設定", t, sent, readAll(t, STEPS.length));
    }
}
```

**輸出**：

```
═══ 0.5.1 陷阱：不給 key，但小量測試「看起來是對的」 ═══

  生產者送出的順序 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
  消費者讀到的順序 :
    1. 1-CREATED        p0   off0
    2. 2-PAID           p0   off1
    3. 3-STOCK_RESERVED p0   off2
    4. 4-SHIPPED        p0   off3
    5. 5-DELIVERED      p0   off4
    6. 6-CLOSED         p0   off5
  [kafka ] demo.sticky.a.1789965910126 分區=3   總訊息數=6        p0=6 p1=0 p2=0
  【單一 producer、6 則、預設設定】順序正確？ ✅ 是
```

⚠️ **`✅ 是`。三個分區的 topic，不給 key，順序完全正確。**

**為什麼？** `p0=6 p1=0 p2=0` —— 六則**全部進了同一個分區**。

> **沒給 key 時，producer 不是輪流丟到各分區的。**
> 從 Kafka 2.4（KIP-480）引入 sticky partitioner、再到 3.3（KIP-794）換成內建的
> `BuiltInPartitioner` 之後，行為是：**「黏」在同一個分區上，
> 直到為那個分區累積的位元組數超過 `batch.size` 才換一個。**
> 六則十幾個位元組的訊息，離 `batch.size` 差得遠 → 全進同一個分區
> → 同一個分區內保證有序 → **順序正確**。

⚠️ **順帶澄清一個很多文章寫錯的地方**：現在的預設**不是**某個具名的 partitioner 類別。
把設定印出來看：

```java
var pc = new ProducerConfig(Map.of(
        ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:19092",
        ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName(),
        ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName()));
System.out.println("partitioner.class = " + pc.getString(ProducerConfig.PARTITIONER_CLASS_CONFIG));
System.out.println("batch.size        = " + pc.getInt(ProducerConfig.BATCH_SIZE_CONFIG));
```

```
partitioner.class = null        ← 不是 DefaultPartitioner，也不是 StickyPartitioner
batch.size        = 16384
```

`null` 的意思是「用 producer 內建的分區邏輯」（`BuiltInPartitioner`）。
📌 **所以你在網路上看到「把 `partitioner.class` 設回 `DefaultPartitioner` 就好了」的建議要小心** ——
那個類別在 3.3 已經被標為 deprecated，而且**設了它反而會關掉 KIP-794 的自適應分區**。
**正確的做法從頭到尾都只有一個：給 key。**

**這就是那個陷阱**：你的單元測試會過、你的本機手測會過、你的 staging 小量驗證會過。
然後上線。

**同一份程式碼，只把「一台機器」換成「兩台機器」**：

```java
    @Test
    void trap2_twoInstances() throws Exception {
        System.out.println("\n═══ 0.5.1 同樣的程式，換成兩台機器各送一半 ═══");
        String t = "demo.sticky.b." + System.currentTimeMillis();
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(t).partitions(3).replicas(1).build());
        List<String> sent = new ArrayList<>();
        // 每台機器有自己的 producer，各自黏在自己的分區上
        try (var p1 = producer("app-1", Map.of()); var p2 = producer("app-2", Map.of())) {
            for (int i = 0; i < STEPS.length; i++) {
                var p = (i % 2 == 0) ? p1 : p2;
                p.send(new ProducerRecord<>(t, null, STEPS[i])).get();
                sent.add(STEPS[i]);
            }
        }
        report("兩個 producer、6 則", t, sent, readAll(t, STEPS.length));
    }
```

**輸出**：

```
═══ 0.5.1 同樣的程式，換成兩台機器各送一半 ═══

  生產者送出的順序 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
  消費者讀到的順序 :
    1. 1-CREATED        p1   off0
    2. 3-STOCK_RESERVED p1   off1    ← 位置不對
    3. 5-DELIVERED      p1   off2    ← 位置不對
    4. 2-PAID           p0   off0    ← 位置不對
    5. 4-SHIPPED        p0   off1    ← 位置不對
    6. 6-CLOSED         p0   off2
  [kafka ] demo.sticky.b.1789965911635 分區=3   總訊息數=6        p0=3 p1=3 p2=0
  【兩個 producer、6 則】順序正確？ ❌ 否
```

**`4-SHIPPED` 排在 `5-DELIVERED` 後面。** 你的訂單「已送達」之後才「已出貨」。

**再換一種觸發方式：同一台機器，但訊息大到填滿 `batch.size`**（用 `batch.size=1` 模擬）：

```java
    @Test
    void trap3_batchSizeSwitch() throws Exception {
        System.out.println("\n═══ 0.5.1 同一台機器，但 batch.size 被填滿就換分區 ═══");
        String t = "demo.sticky.c." + System.currentTimeMillis();
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(t).partitions(3).replicas(1).build());
        List<String> sent = new ArrayList<>();
        try (var p = producer("tiny-batch", Map.of(ProducerConfig.BATCH_SIZE_CONFIG, 1))) {
            for (String s : STEPS) { p.send(new ProducerRecord<>(t, null, s)).get(); sent.add(s); }
        }
        report("batch.size=1（逼它每則都換分區）", t, sent, readAll(t, STEPS.length));
    }
```

**輸出**：

```
═══ 0.5.1 同一台機器，但 batch.size 被填滿就換分區 ═══

  生產者送出的順序 : 1-CREATED → 2-PAID → 3-STOCK_RESERVED → 4-SHIPPED → 5-DELIVERED → 6-CLOSED
  消費者讀到的順序 :
    1. 2-PAID           p2   off0    ← 位置不對
    2. 6-CLOSED         p2   off1    ← 位置不對
    3. 1-CREATED        p1   off0    ← 位置不對
    4. 3-STOCK_RESERVED p1   off1    ← 位置不對
    5. 5-DELIVERED      p1   off2
    6. 4-SHIPPED        p0   off0    ← 位置不對
  【batch.size=1（逼它每則都換分區）】順序正確？ ❌ 否
```

**`2-PAID` 排第一、`1-CREATED` 排第三。** 訂單還沒建立就付款了。

**把三個實驗擺在一起 —— 這是本章最該記住的一張表**：

| 實驗 | 程式碼 | 環境 | 順序 |
|---|---|---|---|
| ① | 完全一樣 | 一台機器、6 則小訊息 | ✅ 對 |
| ② | 完全一樣 | **兩台機器**各送一半 | ❌ 錯 |
| ③ | 完全一樣 | 一台機器，但**訊息量填滿 batch** | ❌ 錯 |

> ⚠️ **「我在本機測過了」在 MQ 這件事上幾乎沒有保證力。**
> ①②③ 的差別不在程式碼，在**副本數、訊息大小、流量**——
> 這三個東西在你的開發機上跟正式環境天差地遠。
>
> 這也是為什麼本站每一個實驗都會明確寫出「幾台機器、幾則訊息、多大」。
> **請照著條件跑，不要用 3 則訊息驗證順序結論。**

**正確的做法：給 key。**

```java
    // 同樣三分區的 topic，只多了一個 key
    for (String s : STEPS) {
        kafka.send(t, "ORD-1001", "ORD-1001 " + s).get();
    }
```

```
═══ 給了 key：同一個 key 進同一個分區，順序回來了 ═══
  生產者用 orderId 當 key：
    送 1-CREATED        key=ORD-1001 → 落在 p1
    送 2-PAID           key=ORD-1001 → 落在 p1
    送 3-STOCK_RESERVED key=ORD-1001 → 落在 p1
    送 4-SHIPPED        key=ORD-1001 → 落在 p1
    送 5-DELIVERED      key=ORD-1001 → 落在 p1
    送 6-CLOSED         key=ORD-1001 → 落在 p1
  [kafka ] demo.order.withkey 分區=3   總訊息數=6        p0=0 p1=6 p2=0

  消費者讀到的順序：
    1. ORD-1001 1-CREATED (p1 off0)
    2. ORD-1001 2-PAID  (p1 off1)
    3. ORD-1001 3-STOCK_RESERVED (p1 off2)
    4. ORD-1001 4-SHIPPED (p1 off3)
    5. ORD-1001 5-DELIVERED (p1 off4)
    6. ORD-1001 6-CLOSED (p1 off5)

  順序正確？ 是 ← 六則全部進 p1
```

**這次的「全進 p1」跟實驗 ① 的「全進 p0」，是完全不同的兩件事**：

| | 實驗 ① | 給了 key |
|---|---|---|
| 為什麼全進一個分區 | producer 的 batch 剛好還沒滿 —— **巧合** | `hash("ORD-1001") % 3 == 1` —— **保證** |
| 換一台機器送 | 可能進別的分區 | **還是 p1** |
| 訊息變大 | 會換分區 | **還是 p1** |
| 重啟 producer | 可能換分區 | **還是 p1** |

> 📌 **這一站關於順序的核心結論，現在就記住**：
>
> **Kafka 保證的是「同一個分區內有序」，不是「topic 有序」。**
> **key 決定分區，所以 key 決定了「誰跟誰之間有順序保證」。**
>
> 選 key 的方式就是回答一個問題：**「哪些訊息之間的順序，我非要不可？」**
> 訂單狀態事件 → key 用 `orderId`（同一張訂單有序，不同訂單之間不管）。
> 使用者的操作紀錄 → key 用 `userId`。
> 全域都要有序 → 只能一個分區 → 吞吐鎖死在單一消費者（07 章 7.4 會量這個代價）。

⚠️ **RabbitMQ 也有順序問題，而且更隱蔽**：單一佇列本身是 FIFO，
但只要你開了**第二個消費者**（或 `concurrency > 1`），兩個消費者處理速度不同，
順序立刻沒了 —— 而且 RabbitMQ 的**佇列**沒有 key 這個層級可以救。
05 章 5.5 會實測它的嚴重程度（**200 張訂單、49% 的最終狀態是錯的**），
並給出三條解法：單一消費者（放棄併發）、業務層版本號、
以及用 `x-consistent-hash` exchange 自己做分片 —— **三條都有代價**。

### 0.5.2 問題二：重複 —— 一則訊息、三秒、45 MB 日誌 ★★

**MQ 的核心承諾是「沒人確認就重送」。** 那如果它永遠處理不好呢？

這是 Spring AMQP 的**預設行為**（`default-requeue-rejected=true`）：

```java
package com.example.lab11.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
// ... 其餘 import 見完整檔案

@SpringBootTest(properties = {
        // Spring AMQP 的預設：消費者丟例外 → 訊息 requeue 回去 → 再送給你
        "spring.rabbitmq.listener.simple.default-requeue-rejected=true",
        "spring.rabbitmq.listener.simple.acknowledge-mode=auto"
})
class A4RequeueStormTest {

    static final String Q = "storm.q";
    static final AtomicInteger deliveries = new AtomicInteger();
    static volatile boolean armed = false;

    @TestConfiguration
    static class Cfg {
        @Bean Queue stormQ() { return new Queue(Q, true, false, false); }
        @Bean Handler handler() { return new Handler(); }
    }

    @Component
    static class Handler {
        @RabbitListener(queues = Q)
        void onMessage(String body) {
            if (!armed) return;
            deliveries.incrementAndGet();
            throw new RuntimeException("下游的收款服務現在 500");    // 一則永遠處理不好的「毒藥訊息」
        }
    }

    @Test
    void oneBadMessageBecomesAStorm() throws Exception {
        System.out.println("═══ 0.5.2 一則處理不了的訊息，可以自己變成 DDoS ═══");
        armed = true;
        deliveries.set(0);
        rabbit.convertAndSend(Q, "order-9527");     // 只送一則

        int[] perSec = new int[3];
        for (int sec = 0; sec < 3; sec++) {
            Thread.sleep(1000);
            perSec[sec] = deliveries.get();
        }
        armed = false;
        int total = deliveries.get();
        int depth = admin.getQueueInfo(Q).getMessageCount();
        admin.deleteQueue(Q);       // 把毒藥訊息清掉，不要留給下一個測試
        // ... 印出統計（一次印完，避免被 stderr 的堆疊切斷）
    }
}
```

**輸出**：

```
═══ 0.5.2 一則處理不了的訊息，可以自己變成 DDoS ═══
  第 1 秒：這「一則」訊息累計被投遞 2,949 次
  第 2 秒：這「一則」訊息累計被投遞 7,096 次
  第 3 秒：這「一則」訊息累計被投遞 11,191 次

  送進佇列的訊息數 : 1 則
  三秒內的投遞次數 : 11,191 次  （約 3,730 次/秒）
  佇列積壓          : 0 則  ← 監控上看起來「很正常」
```

同一次執行，把整個 `mvn test` 的輸出存下來量一下：

```bash
mvn -q -Dtest=A4RequeueStormTest test 2>/dev/null > /tmp/storm.out
grep -c "下游的收款服務現在 500" /tmp/storm.out   # 例外次數
wc -l < /tmp/storm.out                            # 日誌行數
du -h /tmp/storm.out                              # 日誌大小
```

```
11191
  335755
 45M	/tmp/storm.out
```

⚠️ **三秒鐘、一則訊息、11,191 次投遞、335,755 行日誌、45 MB。**

推算一下正式環境：

| | 三秒 | 一分鐘 | 一小時 |
|---|---|---|---|
| 投遞次數 | 11,191 | 22 萬 | 1,340 萬 |
| 日誌量 | 45 MB | **900 MB** | **54 GB** |

**這 54 GB 會發生三件事**：

1. **磁碟被寫爆。** 很多正式環境的第一個症狀不是「訊息處理失敗」，是 `No space left on device`，
   然後**所有**服務一起死（包括跟這件事完全無關的）。
2. **日誌收集系統被打爛。** 如果你用集中式日誌，這 54 GB 會塞滿 ingestion pipeline，
   **其他服務的日誌全部延遲或遺失** —— 你正好在最需要日誌的時候失去日誌。
3. **broker 的 CPU 被吃掉。** 3,730 次/秒的 deliver + nack + requeue，
   同一台 broker 上**其他佇列的處理跟著變慢**。

**但最可怕的是這一行**：

```
  佇列積壓          : 0 則  ← 監控上看起來「很正常」
```

📌 **這是 MQ 特有的故障形狀：光看積壓看不出來。**

你的監控看板：積壓 0～1、吞吐「很高」（3,730/秒！）、沒有訊息堆積告警。
一切正常。同時你的磁碟在 20 分鐘後會滿。

**要看出這件事，你需要監控的是別的東西**（10 章會設定）：

| 指標 | 正常 | 這個故障時 |
|---|---|---|
| 佇列積壓 | 0 | **0** ← 看不出來 |
| `deliver_get` 速率 | 跟業務量相符 | **暴增**，而且跟上游流量完全不成比例 |
| `redeliver` 速率 | 接近 0 | **等於 deliver 速率** ← 這是決定性的指標 |
| 消費者錯誤率 | 接近 0 | **100%** |
| 死信佇列深度 | 0 | **0** ← 因為根本沒設死信 |

> 📌 **正確的做法（06 章 6.2）**：
> `default-requeue-rejected=false` + 死信交換器（DLX）。
> 訊息失敗 → 不 requeue → 進死信佇列 → 佇列積壓 0、死信佇列 1。
> 你的告警是「死信佇列 > 0」，三秒之後你就知道了，而且你有那則訊息可以慢慢看。

**這一節的另一半：重複是必然的，不是 bug。**

即使你設定完全正確、程式完全沒 bug，重複還是會發生：

| 情境 | 為什麼重複 |
|---|---|
| 消費者處理完了，ack 送出前被 `kill -9` | broker 沒收到 ack → 重送。**事情做了兩次** |
| 消費者處理完了，ack 在網路上丟了 | 同上 |
| Kafka 消費者處理完了，offset 還沒提交就 rebalance | 新的消費者從舊 offset 開始 → 重讀（08 章 8.3 會實測） |
| 生產者送出了，confirm 在網路上丟了，生產者重送 | broker 上有**兩則一樣的訊息**（09 章的冪等 producer 解決 Kafka 這一半） |

📌 **所以 03 章的標題不是「怎麼避免重複」，是「冪等消費」。**
你不能避免重複，你只能讓「處理兩次」跟「處理一次」的結果一樣。

### 0.5.3 問題三：延遲 —— 從 500 ns 變成 0.3 ms

```java
    @Test
    void endToEndLatency() throws Exception {
        int N = 500;
        System.out.println("═══ 0.5.3 端到端延遲：直接呼叫 vs 過 RabbitMQ vs 過 Kafka ═══");
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name(T).partitions(1).replicas(1).build());
        Thread.sleep(1500);   // 等 listener 接上

        // ① 直接呼叫
        for (int i = 0; i < 200_000; i++) handleDirectly("warmup");   // 讓 JIT 先編譯
        long[] direct = new long[N];
        for (int i = 0; i < N; i++) {
            long s = System.nanoTime();
            handleDirectly("mail-" + i);
            direct[i] = System.nanoTime() - s;
        }
        stats("① 直接呼叫（同一個執行緒）", direct, N);

        // ② RabbitMQ：把送出時的 nanoTime 塞進 payload，listener 收到時相減
        rabbitArrivals.clear();
        long[] r = new long[N];
        for (int i = 0; i < N; i++) {
            rabbit.convertAndSend(Q, String.valueOf(System.nanoTime()));
            Long v = rabbitArrivals.poll(5, TimeUnit.SECONDS);
            r[i] = v == null ? Long.MAX_VALUE : v;
        }
        stats("② 過 RabbitMQ（送→收，一來一回）", r, N);

        // ③ Kafka：同樣的做法
        kafkaArrivals.clear();
        long[] k = new long[N];
        for (int i = 0; i < N; i++) {
            kafka.send(T, String.valueOf(System.nanoTime()));
            Long v = kafkaArrivals.poll(10, TimeUnit.SECONDS);
            k[i] = v == null ? Long.MAX_VALUE : v;
        }
        stats("③ 過 Kafka（送→收，一來一回）", k, N);
    }
```

**輸出**：

```
═══ 0.5.3 端到端延遲：直接呼叫 vs 過 RabbitMQ vs 過 Kafka ═══
  ① 直接呼叫（同一個執行緒）             p50 = 500 ns      p99 = 0.011 ms    max = 0.154 ms
  ② 過 RabbitMQ（送→收，一來一回）        p50 = 0.306 ms    p99 = 0.939 ms    max = 9.901 ms
  ③ 過 Kafka（送→收，一來一回）           p50 = 0.764 ms    p99 = 2.000 ms    max = 29.361 ms

  把訊息交給別人做，最快也要 0.306 ms 才會真的被做到。
```

| | p50 | 相對直接呼叫 | p99 | max |
|---|---|---|---|---|
| 直接呼叫 | 500 ns | 1× | 0.011 ms | 0.154 ms |
| RabbitMQ | 0.306 ms | **612×** | 0.939 ms | 9.901 ms |
| Kafka | 0.764 ms | **1,528×** | 2.000 ms | **29.361 ms** |

⚠️ **這是在同一台筆電上、broker 跑在本機 Docker、完全沒有網路延遲、沒有其他負載的情況下量的。**
真實環境 broker 在另一台機器上，再加 0.2～1 毫秒；broker 有負載、有持久化、有副本同步的時候，
p99 會是這裡的好幾倍（01 章開了 confirm 之後會再量一次，數字很不一樣）。

**怎麼用這三個數字**：

- **`max` 那一欄才是你該看的。** Kafka 的 `max = 29 ms` 不是異常值 ——
  那是 producer 在等 `linger.ms` 湊批次、或 broker 在做 log flush。
  如果某個功能「不能超過 10 毫秒」，那它不能過 MQ。
- **Kafka 比 RabbitMQ 慢 2.5 倍是正常的，而且是設計使然。**
  Kafka 為了吞吐做批次（`linger.ms`、`batch.size`），批次天生會增加單則延遲。
  它的強項在 0.5.4 的吞吐那張表。
- **0.3 ms 對「寄信」完全不重要。** 寄信本身要 2,000 ms。
  重點是**問對問題**：不是「MQ 會不會讓系統變慢」，是「這個功能能不能接受多 1 毫秒與偶爾 30 毫秒」。

> 📌 **有一類東西絕對不能過 MQ：使用者在等答案的東西。**
> 「這件商品還有庫存嗎」、「登入密碼對不對」、「這張卡刷得過嗎」——
> 這些是**請求 / 回應**，不是訊息。
> 把它們塞進 MQ 然後用「回覆佇列」等答案，你會得到一個又慢又難查的 RPC。
> （RabbitMQ 有 RPC 模式，但那是給特殊場景的，不是給一般 API 的。）

### 0.5.4 生產者吞吐：先建立尺度感

```java
    @Test
    void publishThroughput() throws Exception {
        int N = 20_000;
        System.out.println("\n═══ 0.5.4 生產者吞吐：只管送出去，不等確認 ═══");
        rabbitAdmin.deleteQueue("tp.q");
        rabbitAdmin.declareQueue(new Queue("tp.q", true, false, false));
        kafkaAdmin.createOrModifyTopics(TopicBuilder.name("tp.t").partitions(1).replicas(1).build());
        String payload = "x".repeat(200);

        long s = System.nanoTime();
        for (int i = 0; i < N; i++) rabbit.convertAndSend("tp.q", payload);
        long ms1 = (System.nanoTime() - s) / 1_000_000;

        s = System.nanoTime();
        for (int i = 0; i < N; i++) kafka.send("tp.t", payload);
        kafka.flush();
        long ms2 = (System.nanoTime() - s) / 1_000_000;

        System.out.printf("  RabbitMQ convertAndSend x %,d : %,d ms  → %,d 則/秒%n", N, ms1, N * 1000L / Math.max(1, ms1));
        System.out.printf("  Kafka    send + flush   x %,d : %,d ms  → %,d 則/秒%n", N, ms2, N * 1000L / Math.max(1, ms2));
        rabbitAdmin.deleteQueue("tp.q");
    }
```

**輸出**：

```
═══ 0.5.4 生產者吞吐：只管送出去，不等確認 ═══
  RabbitMQ convertAndSend x 20,000 : 347 ms  → 57,636 則/秒
  Kafka    send + flush   x 20,000 : 163 ms  → 122,699 則/秒
```

| | 吞吐 | 每則成本 |
|---|---|---|
| RabbitMQ | 57,636 則/秒 | 17 μs |
| Kafka | **122,699 則/秒** | 8 μs |

⚠️ **這兩個數字都「不保證訊息真的進了 broker」。**

- `convertAndSend()` 沒開 publisher confirm → **它只保證「交給了本機的 TCP 緩衝區」**。
- `kafka.send()` 是非同步的，`flush()` 只等到「送出去了」，`acks` 是預設值。

**01 章會把確認加回來，再看一次這張表 —— 數字會掉一個數量級。**
現在這兩個數字的用途只有一個：**建立尺度感**。
一台本機 Docker 的單節點 broker，量級是「每秒幾萬則」。
如果你的需求是每秒 100 則，兩個都綽綽有餘，選型該看別的（11 章）；
如果你的需求是每秒 50 萬則，那從一開始就只有 Kafka 能談。

### 0.5.5 問題四：看不見 —— 你唯一的窗口

同步呼叫出事的時候，你有：stack trace、traceId 貫穿全程、APM 上一條完整的呼叫鏈。

非同步之後，**這條鏈斷了**。生產者的 traceId 到 `send()` 就結束，
消費者那一側是一條全新的、跟前面毫無關係的 trace。使用者說「我沒收到信」，你要回答：

```
訊息送出去了嗎？            → 生產者的日誌？如果沒印呢？confirm 有回來嗎？
訊息在 broker 上嗎？        → 佇列積壓 / topic 的 end offset
訊息被消費了嗎？            → RabbitMQ：積壓變 0 就是被消費了（但成功還是失敗？）
                              Kafka：committed offset 往前了就是被消費了（同上）
處理成功了嗎？              → ？？？
處理失敗的那則在哪？        → 死信佇列（如果你設了）
```

**你唯一的窗口是「積壓」與「lag」這兩個數字**，而 0.5.2 已經證明它們**可以完全正常但系統正在死**。

這一站的兩個工具：

| 工具 | 在哪一章 | 解決什麼 |
|---|---|---|
| `MsgProbe`（積壓 + lag） | 本章 0.8.5 | 「訊息現在在哪」的最低配版本，整站每個實驗都用它 |
| traceId 跨 MQ 傳遞 | 10 章 10.3 | 把斷掉的那條鏈接回去：生產者把 traceId 塞進 header，消費者取出來放進 MDC |

### 0.5.6 所以什麼時候**不該**用 MQ

📌 **這一節請認真讀。** 這一站教的每個東西都有維護成本，而**很多系統加了 MQ 只是變得更難查**。

**① 使用者在等答案的時候** —— 0.5.3 講過了。請求 / 回應不要用訊息做。

**② 「必須立刻知道結果」的業務判斷**

```java
// ❌ 錯的
public OrderResult placeOrder(cmd) {
    kafka.send("stock.deduct", cmd);     // 扣庫存丟給 MQ
    return OrderResult.accepted();       // 回「已接受」
}
// 使用者：「我到底買到了沒？」
// 你：「呃，你等一下重新整理看看」
```

如果這是搶購（10-redis 那種預扣庫存場景），**扣庫存必須同步**。
MQ 可以處理「扣成功之後的通知」，不能處理「到底扣不扣得成」。

**③ 你的量級根本不需要它**

一天 500 筆訂單、寄 500 封信。
一張 `outbox` 表 + 一個 `@Scheduled(fixedDelay = 5000)` 的輪詢，**50 行程式碼**，
給你：持久化、重試、死信（`status='FAILED'`）、完整的查詢能力（`SELECT * FROM outbox WHERE status='FAILED'`）、
以及**跟訂單在同一個交易裡**（連 02 章的雙寫問題都一起解決了）。

而裝一台 MQ 你要：部署、監控、備份、版本升級、憑證輪替、學會兩套心智模型、
訓練團隊每一個人、處理它半夜掛掉、處理 0.5.2 那種故障形狀。

> ⚠️ **判斷準則**：
> **如果「一張表 + 一個輪詢」能解決，而且你的量級在可見的未來都不會撐爆它 —— 就用那個。**
> 這不是偷懶，這是正確的工程判斷。
>
> 需要 MQ 的訊號是這些（有一個就夠）：
> - 需要**削峰**：尖峰是平均的 20 倍以上，而且下游撐不住。
> - 需要**扇出**：同一個事件有 3 個以上的消費者，而且還在增加。
> - 需要**重讀**：新的消費者要補跑歷史資料（→ Kafka）。
> - 需要**跨團隊 / 跨語言解耦**：訂單是 Java、風控是 Python、BI 是 Go。
> - 輪詢的延遲已經不能接受（5 秒太久），或輪詢的負載已經壓到資料庫。
>
> 📌 **但 02 章的 Outbox 你一定要學，即使你不用 MQ。**
> 因為「資料庫改了、通知沒送出」這個問題**跟有沒有 MQ 無關** ——
> 你用 `@Async` 有這個問題、你用 MQ 有這個問題、你打 HTTP 呼叫別人也有這個問題。

---

## 0.6 起環境

三台容器。跟這一站的其他部分一樣，**每一個參數都有理由**。

### 0.6.1 RabbitMQ

```bash
docker run -d --name rabbit-lab \
  -p 5673:5672 -p 15673:15672 \
  -e RABBITMQ_DEFAULT_USER=lab -e RABBITMQ_DEFAULT_PASS=lab \
  rabbitmq:3.13-management
```

| 參數 | 意思 | 為什麼這樣設 |
|---|---|---|
| `--name rabbit-lab` | 容器取名 | 後面所有命令都用 `docker exec rabbit-lab ...` |
| `-p 5673:5672` | AMQP 協定的埠，對到本機 **5673** | **刻意不用 5672**：你機器上可能有別的 RabbitMQ，撞埠會連到錯的 broker 而且極難發現 |
| `-p 15673:15672` | **管理介面**的埠 | 瀏覽器開 <http://localhost:15673>，帳密 `lab` / `lab`。這個介面在 04～06 章會一直用 |
| `RABBITMQ_DEFAULT_USER/PASS` | 建一個帳號 | 預設的 `guest` / `guest` **只能從 localhost 連**，容器裡的 localhost 不是你的 localhost → 從外面連會被拒。這是新手第一個卡住的地方 |
| `rabbitmq:3.13-management` | 映像版本 | **釘住版本**，而且要 `-management` 那個 tag（不帶的話沒有管理介面與 `rabbitmqadmin`） |

確認它活著：

```bash
docker exec rabbit-lab rabbitmqctl version
docker exec rabbit-lab rabbitmq-diagnostics -q ping
```

```
3.13.7
Ping succeeded
```

> 📌 **`rabbitmq-diagnostics` 比 `rabbitmqctl status` 好用得多。**
> `-q` 是安靜模式（不印那一大堆標頭）。
> 06 章會用到 `rabbitmq-diagnostics check_running`、`check_port_connectivity`、`memory_breakdown`。

### 0.6.2 Kafka（以及 `advertised.listeners` 這個坑）

```bash
docker run -d --name kafka-lab -p 19092:9092 \
  -e KAFKA_NODE_ID=1 \
  -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS=HOST://:9092,INTERNAL://:29092,CONTROLLER://:9093 \
  -e KAFKA_ADVERTISED_LISTENERS=HOST://localhost:19092,INTERNAL://localhost:29092 \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,HOST:PLAINTEXT,INTERNAL:PLAINTEXT \
  -e KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
  -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
  -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
  -e KAFKA_NUM_PARTITIONS=1 \
  -e KAFKA_AUTO_CREATE_TOPICS_ENABLE=true \
  apache/kafka:3.8.0
```

**這一長串看起來很嚇人，但它只在講四件事**：

**① 這是一台 KRaft 模式的單節點 Kafka（沒有 ZooKeeper）**

| 參數 | 意思 |
|---|---|
| `KAFKA_NODE_ID=1` | 這個節點的編號 |
| `KAFKA_PROCESS_ROLES=broker,controller` | 這一個行程同時當 broker（存訊息）跟 controller（管中繼資料）。正式環境會分開 |
| `KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093` | controller 的選舉名單，只有自己一個 |
| `KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER` | 哪個 listener 是給 controller 之間通訊用的 |

> 📌 Kafka 2.8 開始支援 KRaft，3.5 之後是預設推薦，**4.0 已經完全移除 ZooKeeper**。
> 你在網路上看到的「先起一台 ZooKeeper」的教學都過時了。

**② ⚠️ `advertised.listeners` —— 這一站最容易卡住的地方**

**先講機制，因為這個坑會纏著你一整站**：

```
你的 Java 程式                              kafka-lab 容器
     │
     │ ① 連 bootstrap-servers: localhost:19092
     ├───────────────────────────────────────────▶ 收到
     │                                              │
     │ ② 「這個 cluster 的 broker 在哪？」          │
     │ ◀───────────────────────────────────────────┤ 回答：advertised.listeners 的值
     │                                              │
     │ ③ 用②拿到的地址，重新連過去實際讀寫
     └───────────────────────────────────────────▶
```

**關鍵在②**：客戶端拿到的地址是 broker **自己說的**，不是你連進來的那個地址。
所以如果 `advertised.listeners` 寫成 `PLAINTEXT://kafka-lab:9092`，
你的 Java 程式會在第③步去連 `kafka-lab:9092` —— 你的 Mac 不認識 `kafka-lab` 這個主機名 → **連不上**。

那寫成 `localhost:19092` 呢？你的 Java 程式可以了，但**容器裡的 CLI 工具會壞**：
它在容器內解析 `localhost:19092`，而容器內的 19092 什麼都沒有。

```bash
# 只宣告一個 advertised listener = localhost:19092 的時候，在容器裡跑 CLI：
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
```

```
WARN [LegacyAdminClient clientId=admin-1] Connection to node 1 (localhost/127.0.0.1:19092)
     could not be established. Node may not be available.
localhost:19092 (id: 1 rack: null) -> ERROR: org.apache.kafka.common.errors.DisconnectException
```

📌 **所以要宣告兩份**，這就是上面那三行的意思：

| listener | 容器內監聽 | 對外宣告 | 誰在用 |
|---|---|---|---|
| `HOST` | `:9092` | `localhost:19092` | **你的 Java 程式**（從 Mac 連，經過 `-p 19092:9092`） |
| `INTERNAL` | `:29092` | `localhost:29092` | **容器內的 CLI 工具**（`docker exec` 進去跑） |
| `CONTROLLER` | `:9093` | —— | Kafka 自己的 controller 通訊 |

⚠️ **這不是「實驗環境的怪招」，這是正式環境最常見的故障之一。**
「本機跑得好好的，上 K8s 就連不上 Kafka」十次有八次是 `advertised.listeners` 寫錯。
症狀很有特色：**能連上、能拿到 metadata、但一讀寫就逾時** —— 因為第①步成功了，第③步失敗了。

**③ 單節點必須把副本數設成 1**

| 參數 | 為什麼 |
|---|---|
| `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1` | Kafka 用一個內部 topic `__consumer_offsets` 存位移，它預設要 3 個副本。單節點只有 1 個 broker → **不設會啟動失敗 / 提交位移永遠失敗** |
| `KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1` | 同理，交易狀態的內部 topic（09 章的 Kafka 交易會用到） |
| `KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1` | 同上 |

**④ 幾個讓實驗好做的設定**

| 參數 | 為什麼 |
|---|---|
| `KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0` | 預設 3000。它讓第一個消費者加入 group 時先等 3 秒（讓其他消費者一起來，少一次 rebalance）。**實驗時每次都等 3 秒很煩**，設 0。⚠️ 正式環境不要設 0 |
| `KAFKA_NUM_PARTITIONS=1` | 自動建立的 topic 預設幾個分區。設 1 是**刻意的**：本站每個實驗都明確指定分區數，不讓預設值偷偷影響結果 |
| `KAFKA_AUTO_CREATE_TOPICS_ENABLE=true` | 送到不存在的 topic 時自動建。⚠️ **正式環境務必設 false**（07 章 7.8）—— 打錯一個字就多一個 topic，而且是用預設設定建的 |

確認它活著（**注意用 29092**）：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh --version
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
```

```
3.8.0
```

（`--list` 現在是空的，很正常。）

### 0.6.3 MySQL（02 章的 Outbox 要用）

```bash
docker run -d --name mysql-lab -p 13306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=lab11 \
  -e MYSQL_USER=lab -e MYSQL_PASSWORD=lab \
  mysql:8.0
```

```bash
docker exec mysql-lab mysqladmin -ulab -plab ping
```

```
mysqld is alive
```

⚠️ **為什麼一定要真的 MySQL，不能用 H2**：
02 章的 Outbox 要用 `SELECT ... FOR UPDATE SKIP LOCKED` 來讓多台輪詢器不互搶同一批訊息。
`SKIP LOCKED` 是 **MySQL 8.0 才有**的，H2 的行為不一樣。
而 02 章整章的重點就是「交易邊界」—— 用一個交易行為跟正式環境不同的資料庫來學，會學到錯的結論。

### 0.6.4 三台一起確認

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
```

```
NAMES        IMAGE                      PORTS                                             STATUS
mysql-lab    mysql:8.0                  0.0.0.0:13306->3306/tcp, 33060/tcp                Up 3 minutes
kafka-lab    apache/kafka:3.8.0         0.0.0.0:19092->9092/tcp                           Up 3 minutes
rabbit-lab   rabbitmq:3.13-management   0.0.0.0:5673->5672/tcp, 0.0.0.0:15673->15672/tcp  Up 3 minutes
```

**本站的埠一覽**（後面每一章都假設這些）：

| 服務 | 本機埠 | 用途 |
|---|---|---|
| RabbitMQ AMQP | **5673** | 你的 Java 程式連這個 |
| RabbitMQ 管理介面 | **15673** | 瀏覽器開 <http://localhost:15673>（`lab` / `lab`） |
| Kafka（給 Java） | **19092** | `bootstrap-servers` |
| Kafka（容器內 CLI） | 29092 | `docker exec` 裡面用 |
| MySQL | **13306** | 02 章的 Outbox |

📌 **一次把三台都停掉 / 起來**（每天開工用）：

```bash
docker stop  rabbit-lab kafka-lab mysql-lab
docker start rabbit-lab kafka-lab mysql-lab
```

⚠️ 三台都沒有掛載 volume —— **`docker rm` 之後資料全沒**。
這是刻意的：本站很多實驗需要「乾淨的 broker」，
而且你會在 06、08 章刻意把 broker 打壞來看它怎麼恢復。

---

## 0.7 第一則訊息（先在 CLI 裡）

**在寫任何 Java 之前，先在 CLI 裡把一則訊息送進去、讀出來。**
理由跟 10-redis 站把前半留在 `redis-cli` 裡一樣：
**當你的 Java 程式收不到訊息時，你要能分辨「是我的程式錯了」還是「訊息根本沒進去」。**

### 0.7.1 RabbitMQ：`rabbitmqadmin`

`-management` 那個映像帶了一支 `rabbitmqadmin`，它是操作 RabbitMQ 最快的方式。

```bash
# ① 建一個持久化的佇列
docker exec rabbit-lab rabbitmqadmin -u lab -p lab declare queue name=hello.q durable=true
```

```
queue declared
```

```bash
# ② 送一則進去（不指定 exchange = 用預設 exchange，routing_key 就是佇列名）
docker exec rabbit-lab rabbitmqadmin -u lab -p lab publish routing_key=hello.q payload="第一則訊息"
```

```
Message published
```

```bash
# ③ 看佇列裡有幾則
docker exec rabbit-lab rabbitmqctl -q list_queues name messages consumers
```

```
name	messages	consumers
hello.q	1	0
```

```bash
# ④ 讀出來（ackmode=ack_requeue_false 表示「讀走就確認，不要放回去」）
docker exec rabbit-lab rabbitmqadmin -u lab -p lab get queue=hello.q ackmode=ack_requeue_false
```

```
+-------------+----------+---------------+---------+---------------+------------------+------------+-------------+
| routing_key | exchange | message_count | payload | payload_bytes | payload_encoding | properties | redelivered |
+-------------+----------+---------------+---------+---------------+------------------+------------+-------------+
| hello.q     |          | 0             | 第一則訊息 | 15            | string           |            | False       |
+-------------+----------+---------------+---------+---------------+------------------+------------+-------------+
```

**這張表的每一欄都值得認一下，後面幾章會一直看到它**：

| 欄位 | 這次的值 | 意思 |
|---|---|---|
| `routing_key` | `hello.q` | 訊息被投遞時用的路由鍵。04 章的重點 |
| `exchange` | 空的 | 空字串是**預設 exchange**（direct 型），它的 routing key 就是佇列名。04 章會講為什麼「不指定 exchange」其實是指定了一個 |
| `message_count` | `0` | **讀走這則之後，佇列裡剩幾則**。0.4.1 那個 `null` 的另一種寫法 |
| `payload` | `第一則訊息` | 內容 |
| `payload_bytes` | `15` | 五個中文字 × 3 bytes = 15。**broker 不知道這是什麼編碼，它只看到位元組** |
| `payload_encoding` | `string` | `rabbitmqadmin` 判斷這是可印字串（二進位會顯示 `base64`） |
| `properties` | 空的 | 訊息的 header 與屬性（`delivery_mode`、`content_type`、`message_id`…）。**03 章的去重靠 `message_id`、10 章的 traceId 靠 header** |
| `redelivered` | `False` | **這則是不是重送的**。0.5.2 那個風暴裡，這一欄全部是 `True` |

```bash
# ⑤ 再看一次 —— 空了
docker exec rabbit-lab rabbitmqctl -q list_queues name messages
```

```
name	messages
hello.q	0
```

> 📌 也可以直接開瀏覽器：<http://localhost:15673> → `lab` / `lab` → Queues 分頁。
> 管理介面可以手動送訊息、看訊息、看每秒速率圖 ——
> **05、06 章的實驗強烈建議一邊跑一邊開著它**，你會看到 prefetch 跟 DLX 在圖上的形狀。

### 0.7.2 Kafka：`kafka-topics` / console producer / consumer

```bash
# ① 建一個三分區的 topic
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:29092 \
  --create --topic hello.t --partitions 3 --replication-factor 1
```

```
WARNING: Due to limitations in metric names, topics with a period ('.') or underscore ('_')
         could collide. To avoid issues it is best to use either, but not both.
Created topic hello.t.
```

> ⚠️ **那個 WARNING 是真的，不是雜訊。** Kafka 的 JMX 指標名稱會把 `.` 跟 `_` 混在一起，
> 所以 `hello.t` 跟 `hello_t` 兩個 topic 的指標會**撞在一起**。
> 本站為了可讀性用 `.`，但**正式環境請全站統一用一種**（建議全用 `.`，例如 `order.created.v1`）。
> 命名慣例在 07 章 7.8 會有一節。

```bash
# ② 看它長什麼樣子
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:29092 --describe --topic hello.t
```

```
Topic: hello.t	TopicId: MysOa6CaQnCvmtyeuYCESg	PartitionCount: 3	ReplicationFactor: 1	Configs:
	Topic: hello.t	Partition: 0	Leader: 1	Replicas: 1	Isr: 1	Elr: 	LastKnownElr:
	Topic: hello.t	Partition: 1	Leader: 1	Replicas: 1	Isr: 1	Elr: 	LastKnownElr:
	Topic: hello.t	Partition: 2	Leader: 1	Replicas: 1	Isr: 1	Elr: 	LastKnownElr:
```

**先認四個欄位**（07 章會全部展開）：

| 欄位 | 意思 |
|---|---|
| `Partition: 0 / 1 / 2` | 這個 topic 被切成三份。**每一份是一個獨立的、有序的檔案** |
| `Leader: 1` | 這個分區的讀寫由 broker 1 負責。**所有讀寫都只走 leader** |
| `Replicas: 1` | 這個分區有哪些 broker 存了副本。我們只有一台，所以只有 `1` |
| `Isr: 1` | **In-Sync Replicas —— 跟上 leader 的副本有哪些。** 這是 01 章「訊息會不會掉」最關鍵的數字：`acks=all` 等的就是 ISR 裡的副本都寫了 |

```bash
# ③ 送三則進去（帶 key，用 : 分隔）
printf 'ORD-1001:第一則訊息\nORD-1001:第二則訊息\nORD-2002:別的訂單\n' | \
docker exec -i kafka-lab /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server localhost:29092 --topic hello.t \
  --property parse.key=true --property key.separator=:
```

（沒有輸出，正常。）

```bash
# ④ 從頭讀
docker exec kafka-lab /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:29092 --topic hello.t --from-beginning \
  --timeout-ms 5000 \
  --property print.key=true --property print.partition=true --property print.offset=true
```

```
Partition:2	Offset:0	ORD-2002	別的訂單
Partition:1	Offset:0	ORD-1001	第一則訊息
Partition:1	Offset:1	ORD-1001	第二則訊息
[... ERROR ... org.apache.kafka.common.errors.TimeoutException]
Processed a total of 3 messages
```

**這四行輸出就是 Kafka 的全部核心概念**：

1. **`ORD-1001` 的兩則都在 `Partition:1`，`ORD-2002` 在 `Partition:2`。**
   → **key 決定分區。** 0.5.1 那一整節的結論，在這裡一行看完。
2. **`ORD-1001` 的 offset 是 0 跟 1，`ORD-2002` 的 offset 也是 0。**
   → **offset 是「分區內的行號」，不是「topic 內的流水號」。** 不同分區的 offset 互不相干。
3. **輸出順序是 `p2` 先、`p1` 後** —— 跟送出順序（`ORD-1001` 先）不一樣。
   → **跨分區沒有順序保證。** consumer 是輪流從各分區拉的。
4. 最後那個 `TimeoutException` 不是錯誤，是 `--timeout-ms 5000` 到了。
   → **console consumer 預設會一直掛著等新訊息**，因為 topic 不會「讀完」。
     這就是 log 模型：沒有「空了」這個狀態。

### 0.7.3 兩邊的 CLI 對照表

📌 **貼在牆上。** 這一站的每一章都會用到左右兩邊：

| 你想做的事 | RabbitMQ | Kafka |
|---|---|---|
| 版本 | `rabbitmqctl version` | `kafka-topics.sh --version` |
| 活著嗎 | `rabbitmq-diagnostics -q ping` | `kafka-broker-api-versions.sh --bootstrap-server localhost:29092` |
| 建容器 | `rabbitmqadmin declare queue name=x durable=true` | `kafka-topics.sh --create --topic x --partitions 3 --replication-factor 1` |
| 列出容器 | `rabbitmqctl -q list_queues name messages consumers` | `kafka-topics.sh --list` |
| 看容器細節 | `rabbitmqadmin list queues` | `kafka-topics.sh --describe --topic x` |
| 送一則 | `rabbitmqadmin publish routing_key=x payload="hi"` | `kafka-console-producer.sh --topic x` |
| 讀一則 | `rabbitmqadmin get queue=x ackmode=ack_requeue_false` | `kafka-console-consumer.sh --topic x --from-beginning` |
| 積了幾則 | `rabbitmqctl -q list_queues name messages` | `kafka-consumer-groups.sh --describe --group g`（看 `LAG`） |
| 誰在消費 | `rabbitmqctl -q list_consumers` | `kafka-consumer-groups.sh --describe --group g`（看 `CONSUMER-ID`） |
| 清空 | `rabbitmqctl purge_queue x` | **沒有這個動作** ← log 模型的直接後果 |
| 重讀 | **沒有這個動作** | `kafka-consumer-groups.sh --reset-offsets --to-earliest --execute` |
| 刪掉 | `rabbitmqadmin delete queue name=x` | `kafka-topics.sh --delete --topic x` |

⚠️ **最後三列是這一站的重點**：
**「清空」與「重讀」在兩邊各只有一個存在。**
這不是功能缺失，這是 0.4 那兩種模型的必然結果 ——
broker 模型裡訊息會消失，所以需要「清空」；log 模型裡訊息不會消失，所以需要「重讀」。

---

## 0.8 本站的基準專案

整站只有一個 Maven 專案，每一章往上加東西。現在先把它建起來。

### 0.8.1 `pom.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>lab11</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <properties><java.version>21</java.version></properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-amqp</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.kafka</groupId>
      <artifactId>spring-kafka</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
      <groupId>com.mysql</groupId>
      <artifactId>mysql-connector-j</artifactId>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
```

各個相依的角色：

| 相依 | 角色 | 注意 |
|---|---|---|
| `spring-boot-starter-amqp` | `RabbitTemplate`、`@RabbitListener`，底層是 **Spring AMQP + amqp-client** | Boot 3.2.5 帶的是 spring-rabbit 3.1.x |
| `spring-kafka` | `KafkaTemplate`、`@KafkaListener`，底層是 Apache 官方的 `kafka-clients` | ⚠️ **注意它不叫 `spring-boot-starter-kafka`** —— Boot 沒有這個 starter，要直接依賴 `org.springframework.kafka:spring-kafka`（版本由 Boot 的 parent 管） |
| `spring-boot-starter-web` | 後面幾章需要真的用 HTTP 打進來（02 章的下單 API、10 章的 traceId） | —— |
| `spring-boot-starter-data-jpa` + `mysql-connector-j` | 02 章的 Outbox、03 章的去重表 | **一定要真 MySQL 不能用 H2**，理由見 0.6.3 |

📌 **兩邊的版本可以用一行印出來確認**（後面對照課文輸出時很有用）：

```java
System.out.println(org.springframework.amqp.rabbit.core.RabbitTemplate.class
        .getPackage().getImplementationVersion());      // 3.1.4
System.out.println(org.apache.kafka.common.utils.AppInfoParser.getVersion());   // 3.6.x
```

### 0.8.2 `application.yml`

```yaml
spring:
  rabbitmq:
    host: localhost
    port: 5673              # 0.6.1 刻意避開 5672
    username: lab
    password: lab
  kafka:
    bootstrap-servers: localhost:19092    # 0.6.2 的 HOST listener
  datasource:
    url: jdbc:mysql://localhost:13306/lab11?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Taipei
    username: lab
    password: lab
  jpa:
    hibernate.ddl-auto: update
    open-in-view: false
logging:
  level:
    root: WARN
    com.example.lab11: INFO
```

⚠️ **這裡故意「沒有」設任何可靠性選項。**

沒有 publisher confirm、沒有手動 ack、沒有 `acks=all`、沒有重試、沒有死信。
**這是 Spring Boot 的預設狀態，也是絕大多數專案上線時的狀態** ——
01 章會實測這個預設有多不可靠（訊息掉在哪裡、掉幾則），**然後才**把設定加回來。
現在先保持原樣，這樣你才看得到差別。

### 0.8.3 本站的版本與預設值（整站的對照基準）

⚠️ **這一小節請不要跳過。**

本站接下來十一章會一直說「XX 的預設是 YY」。
**而「預設值」是這一整個主題裡最容易過時、也最容易被文章寫錯的東西** ——
Kafka 3.0 改過一次 producer 的預設（01 章 1.3.5 會看到那個坑）、
Spring Boot 每個大版本也可能動。

所以：**不要背，把它印出來。** 這支測試整站通用：

```java
package com.example.lab11.verify;

@SpringBootTest
class DefaultsTest {

    @Autowired KafkaTemplate<String, String> kafkaTemplate;

    @Test
    void whatAreTheActualDefaults() {
        System.out.println("  spring-rabbit  : " + RabbitTemplate.class.getPackage().getImplementationVersion());
        System.out.println("  spring-kafka   : " + KafkaTemplate.class.getPackage().getImplementationVersion());
        System.out.println("  kafka-clients  : " + AppInfoParser.getVersion());
        System.out.println("  amqp-client    : " + com.rabbitmq.client.ConnectionFactory.class
                                                      .getPackage().getImplementationVersion());

        // Kafka：用一組最小設定建一個 ProducerConfig / ConsumerConfig，剩下的就是預設值
        var pc = new ProducerConfig(Map.of(BOOTSTRAP_SERVERS_CONFIG, "localhost:19092",
                KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName(),
                VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName()));
        System.out.println("  acks           : " + pc.getString(ProducerConfig.ACKS_CONFIG));
        // ... 其餘同理

        // Spring AMQP：直接問物件
        System.out.println("  new Queue(\"x\").isDurable()      : " + new Queue("x").isDurable());
        System.out.println("  MessageProperties deliveryMode  : " + new MessageProperties().getDeliveryMode());
        System.out.println("  ContainerProperties ackMode     : " + new ContainerProperties("t").getAckMode());
    }
}
```

**本站環境跑出來的結果**：

```
═══ 版本 ═══
  spring-rabbit          : 3.1.4
  spring-kafka           : 3.1.4
  kafka-clients          : 3.6.2
  amqp-client            : 5.19.0

═══ Kafka producer 預設 ═══
  Spring 這邊有設 acks 嗎        : (沒有，用客戶端預設)
  kafka-clients acks 預設        : -1            ← -1 就是 all
  kafka-clients enable.idempotence 預設 : true
  kafka-clients batch.size 預設  : 16384
  kafka-clients linger.ms 預設   : 0
  kafka-clients retries 預設     : 2147483647
  kafka-clients delivery.timeout.ms : 120000
  kafka-clients max.in.flight...    : 5
  kafka-clients partitioner.class   : null

═══ Kafka consumer 預設 ═══
  kafka-clients enable.auto.commit 預設 : true
  kafka-clients auto.offset.reset 預設  : latest
  kafka-clients max.poll.records 預設   : 500
  kafka-clients max.poll.interval.ms    : 300000
  kafka-clients session.timeout.ms      : 45000

═══ Spring AMQP 預設 ═══
  new Queue("x") 的 durable          : true
  MessageProperties 預設 deliveryMode : PERSISTENT
  DEFAULT_PREFETCH_COUNT             : 250

═══ Spring Kafka listener 預設 ═══
  ContainerProperties 預設 ackMode   : BATCH
```

📌 **四個現在就該記住的，它們是 01～03 章的伏筆**：

| 設定 | 預設 | 後果 |
|---|---|---|
| `spring.rabbitmq.publisher-confirm-type` | **`none`** | **送出去了不知道有沒有到**（01 章 1.3.1：500 則無聲消失） |
| `spring.rabbitmq.listener.simple.acknowledge-mode` | **`auto`** | 方法正常回傳就 ack、丟例外就 nack + **requeue**（0.5.2 的風暴） |
| `acks`（Kafka producer） | **`-1`（all）+ `enable.idempotence=true`** | ⚠️ 預設其實是安全的 —— 但**你一動它就會靜默失去冪等**（01 章 1.3.5） |
| `enable.auto.commit`（Kafka consumer） | 客戶端是 `true`；**`@KafkaListener` 的容器會覆寫成 `false`** | ⚠️ 只有走 `@KafkaListener` 才安全；自己 `createConsumer()` 就是 `true`（01 章 1.5.2） |

⚠️ **最後一列特別容易誤會。** 很多人（包括很多文章）說「Spring Kafka 的預設是 `false`」——
更精確的說法是：**`ConsumerFactory` 根本沒設它，是 listener 容器在建 consumer 時覆寫的。**
01 章 1.5.2 會把這兩條路徑的實際設定印出來對照。

### 0.8.4 `LabConfig`：一個你會踩到的小坑

```java
package com.example.lab11;

import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitAdmin;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class LabConfig {

    /**
     * Boot 自動組態出來的那顆 admin，@Bean 的宣告型別是 AmqpAdmin，
     * 而 getQueueInfo() 只存在於 RabbitAdmin 上 —— 所以自己宣告一顆。
     */
    @Bean
    RabbitAdmin rabbitAdmin(ConnectionFactory cf) {
        RabbitAdmin admin = new RabbitAdmin(cf);
        admin.setAutoStartup(true);
        return admin;
    }
}
```

⚠️ **沒有這段的話，`@Autowired RabbitAdmin` 會啟動失敗**：

```
NoSuchBeanDefinitionException: No qualifying bean of type
  'org.springframework.amqp.rabbit.core.RabbitAdmin' available
```

**這個錯誤很容易讓人以為「RabbitMQ 沒連上」，其實跟連線完全無關。**

原因：Boot 的 `RabbitAutoConfiguration` 裡那顆 bean 長這樣：

```java
@Bean
@ConditionalOnSingleCandidate(ConnectionFactory.class)
@ConditionalOnProperty(prefix = "spring.rabbitmq", name = "dynamic", matchIfMissing = true)
@ConditionalOnMissingBean
public AmqpAdmin amqpAdmin(ConnectionFactory connectionFactory) {   // ← 宣告型別是介面
    return new RabbitAdmin(connectionFactory);
}
```

Spring 在做**按型別注入**時看的是 `@Bean` 方法的**宣告回傳型別**（`AmqpAdmin`），
不是它實際 new 出來的型別（`RabbitAdmin`）。
而我們需要的 `getQueueInfo()`（讀佇列積壓）**只在 `RabbitAdmin` 上，不在 `AmqpAdmin` 介面上**。

兩個解法：

```java
// 解法 A：注入介面然後轉型（不用改設定，但很醜）
@Autowired AmqpAdmin amqpAdmin;
int depth = ((RabbitAdmin) amqpAdmin).getQueueInfo("x").getMessageCount();

// 解法 B：自己宣告一顆 RabbitAdmin（本站用這個）
//         @ConditionalOnMissingBean 會讓 Boot 那顆自動退讓
```

> 📌 這個坑本身是一堂小課：**`@Bean` 的回傳型別就是它的注入契約。**
> 你在自己的專案裡把 `@Bean` 的回傳型別從實作類改成介面，
> 別人的 `@Autowired 實作類` 就會壞掉 —— 而且是在啟動時壞，不是在編譯時。

### 0.8.5 `MsgProbe`：整站共用的觀測工具

這是本站最該先裝好的東西。它回答 0.5.5 那個問題：**訊息現在在哪裡？**

```java
package com.example.lab11;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.ListOffsetsResult;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.common.TopicPartition;
import org.springframework.amqp.core.QueueInformation;
import org.springframework.amqp.rabbit.core.RabbitAdmin;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Component
public class MsgProbe {

    @Autowired(required = false) RabbitAdmin rabbitAdmin;
    @Autowired(required = false) KafkaAdmin kafkaAdmin;

    /** RabbitMQ：這個佇列現在積了幾則、有幾個消費者掛著 */
    public void queue(String name) {
        QueueInformation info = rabbitAdmin.getQueueInfo(name);
        if (info == null) {
            System.out.printf("  [rabbit] %-24s 不存在%n", name);
            return;
        }
        System.out.printf("  [rabbit] %-24s 積壓=%-8d 消費者=%d%n",
                name, info.getMessageCount(), info.getConsumerCount());
    }

    public int depth(String name) {
        QueueInformation info = rabbitAdmin.getQueueInfo(name);
        return info == null ? -1 : info.getMessageCount();
    }

    /** Kafka：每個分區的最後位移（= 這個分區寫進去幾則） */
    public Map<TopicPartition, Long> endOffsets(String topic) {
        try (AdminClient ac = AdminClient.create(kafkaAdmin.getConfigurationProperties())) {
            var desc = ac.describeTopics(List.of(topic)).allTopicNames().get().get(topic);
            Map<TopicPartition, OffsetSpec> req = desc.partitions().stream()
                    .collect(Collectors.toMap(p -> new TopicPartition(topic, p.partition()),
                                              p -> OffsetSpec.latest()));
            ListOffsetsResult r = ac.listOffsets(req);
            Map<TopicPartition, Long> out = new HashMap<>();
            for (var tp : req.keySet()) out.put(tp, r.partitionResult(tp).get().offset());
            return out;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Kafka：consumer group 的 lag（已提交位移 / 最後位移） */
    public void lag(String topic, String group) {
        try (AdminClient ac = AdminClient.create(kafkaAdmin.getConfigurationProperties())) {
            var committed = ac.listConsumerGroupOffsets(group)
                    .partitionsToOffsetAndMetadata().get();
            Map<TopicPartition, Long> ends = endOffsets(topic);
            long total = 0;
            StringBuilder sb = new StringBuilder();
            for (var e : ends.entrySet().stream()
                    .sorted((a, b) -> a.getKey().partition() - b.getKey().partition()).toList()) {
                var om = committed.get(e.getKey());
                long c = om == null ? 0 : om.offset();
                long lag = e.getValue() - c;
                total += lag;
                sb.append(String.format("p%d: %d/%d  ", e.getKey().partition(), c, e.getValue()));
            }
            System.out.printf("  [kafka ] %-18s group=%-14s lag=%-6d  %s%n", topic, group, total, sb);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public void topicShape(String topic) {
        Map<TopicPartition, Long> ends = endOffsets(topic);
        long sum = ends.values().stream().mapToLong(Long::longValue).sum();
        System.out.printf("  [kafka ] %-18s 分區=%-3d 總訊息數=%-8d %s%n",
                topic, ends.size(), sum,
                ends.entrySet().stream()
                        .sorted((a, b) -> a.getKey().partition() - b.getKey().partition())
                        .map(e -> "p" + e.getKey().partition() + "=" + e.getValue())
                        .collect(Collectors.joining(" ")));
    }
}
```

**三個方法各自回答什麼**：

| 方法 | 回答 | 對應 CLI |
|---|---|---|
| `queue(name)` / `depth(name)` | RabbitMQ：**還有幾則沒處理** | `rabbitmqctl list_queues name messages` |
| `topicShape(topic)` | Kafka：**總共寫進去幾則、分區怎麼分佈** | `kafka-topics.sh --describe` + `kafka-get-offsets.sh` |
| `lag(topic, group)` | Kafka：**這個 group 還差幾則** | `kafka-consumer-groups.sh --describe --group g` |

⚠️ **兩個一定要知道的限制，否則你會被它的數字騙**：

- **`depth()` 不是即時的。** RabbitMQ 的統計是週期性彙總的（預設 5 秒），
  所以 0.4.1 那個實驗裡每次讀完要 `sleep(200)`。
  **如果你的實驗「送了 5 則但積壓顯示 1」，先加個 `sleep` 再懷疑程式。**
- **`AdminClient` 每次呼叫都會建一條新連線。** 這個 probe 是**給實驗用的**，
  不要照抄進正式環境 —— 正式環境的 lag 監控要用常駐的 exporter（10 章 10.4）。

### 0.8.6 跑起來確認

```java
package com.example.lab11.ch00;

import com.example.lab11.MsgProbe;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Queue;
// ... 其餘 import

@SpringBootTest
class ProbeSmokeTest {

    @Autowired MsgProbe probe;
    @Autowired RabbitAdmin rabbitAdmin;
    @Autowired RabbitTemplate rabbit;
    @Autowired KafkaTemplate<String, String> kafka;
    @Autowired KafkaAdmin kafkaAdmin;
    @Autowired JdbcTemplate jdbc;

    @Test
    void itWorks() throws Exception {
        System.out.println("═══ 0.8.6 MsgProbe 試跑 ═══");

        System.out.println("── RabbitMQ ──");
        rabbitAdmin.deleteQueue("smoke.q");
        rabbitAdmin.declareQueue(new Queue("smoke.q", true, false, false));
        probe.queue("smoke.q");
        for (int i = 0; i < 5; i++) rabbit.convertAndSend("smoke.q", "hello-" + i);
        Thread.sleep(300);
        probe.queue("smoke.q");
        for (int i = 0; i < 2; i++) rabbit.receiveAndConvert("smoke.q");
        Thread.sleep(300);
        probe.queue("smoke.q");

        System.out.println("── Kafka ──");
        kafkaAdmin.createOrModifyTopics(
                TopicBuilder.name("smoke.t").partitions(2).replicas(1).build());
        probe.topicShape("smoke.t");
        for (int i = 0; i < 5; i++) kafka.send("smoke.t", "k" + i, "hello-" + i).get();
        probe.topicShape("smoke.t");

        System.out.println("── MySQL ──");
        System.out.printf("  版本 = %s%n", jdbc.queryForObject("SELECT VERSION()", String.class));

        rabbitAdmin.deleteQueue("smoke.q");
    }
}
```

先確保 Kafka 那個 topic 是乾淨的，再跑：

```bash
docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:29092 --delete --topic smoke.t
mvn -Dtest=ProbeSmokeTest test
```

```
═══ 0.8.6 MsgProbe 試跑 ═══
── RabbitMQ ──
  [rabbit] smoke.q                  積壓=0        消費者=0
  [rabbit] smoke.q                  積壓=5        消費者=0
  [rabbit] smoke.q                  積壓=3        消費者=0
── Kafka ──
  [kafka ] smoke.t            分區=2   總訊息數=0        p0=0 p1=0
  [kafka ] smoke.t            分區=2   總訊息數=5        p0=2 p1=3
── MySQL ──
  版本 = 8.0.46
```

**看到這個輸出，環境就對了。** 順便驗證四件事：

1. **RabbitMQ 積壓 `0 → 5 → 3`**：送 5 則、讀走 2 則 → 剩 3。**讀走的那 2 則消失了**（0.4.1）。
2. **Kafka `總訊息數 0 → 5`，`p0=2 p1=3`**：五個不同的 key 被 hash 到兩個分區，分佈不平均是正常的。
3. **MySQL 8.0.46**：`SKIP LOCKED` 可用，02 章的 Outbox 有工具了。
4. **那行 `--delete --topic smoke.t` 不是多餘的**：如果不刪，你會看到 `總訊息數 5 → 10`。
   ⚠️ **Kafka 的 topic 不會因為你重跑測試而歸零** —— 這是 log 模型的直接後果，
   也是本站實驗最容易讓人困惑的地方（「為什麼我的數字比課文大？」）。
   **本站之後的 Kafka 實驗一律用帶時間戳的 topic 名稱**（`demo.sticky.a.1789965910126`）來避開這件事。

### 0.8.7 命名慣例

| 套件 | 放什麼 | 說明 |
|---|---|---|
| `com.example.lab11.chNN` | **刻意寫壞的實驗變體** | 例如本章的 `ch00.A4RequeueStormTest`。這些程式碼是拿來看它壞掉的，**不要照抄** |
| `com.example.lab11.shop` | **本站建議的樣子** | 每一章最後的「落地到 shop-service」會往這裡加東西 |
| `com.example.lab11.MsgProbe` | 共用工具 | 整站共用 |

**broker 上的命名**：

| | 格式 | 例子 |
|---|---|---|
| RabbitMQ 佇列 | `<領域>.<動作>.q` | `order.confirm-mail.q` |
| RabbitMQ exchange | `<領域>.x` | `order.x` |
| RabbitMQ 死信 | `<原佇列>.dlq` | `order.confirm-mail.dlq` |
| Kafka topic | `<領域>.<事件>.v<版本>` | `order.created.v1` |
| Kafka consumer group | `<服務名>.<用途>` | `mail-service.confirm` |
| 實驗用的拋棄式 topic | `demo.<主題>.<時間戳>` | `demo.sticky.a.1789965910126` |

- **實測輸出的標頭就是節號**：每段輸出都印 `═══ 節號 標題 ═══`，可以直接對回課文。
- **本站所有引用都是站內引用**。

---

## 0.9 這一站的地圖

### 0.9.1 十二章，分三段

```
共通基礎（兩邊都要，跳過的話後面兩邊都會走味）
  00  課程地圖與為什麼需要 MQ          ← 你在這裡
  01  可靠投遞的三段                  ★ 核心：訊息在哪三個地方會掉
  02  Outbox 與交易一致性              ★ 核心：資料庫跟訊息怎麼一起成功
  03  冪等消費                        ★ 核心：接受重複，而不是避免重複
      ↓
RabbitMQ（broker 模型）
  04  拓撲與 Spring AMQP              exchange / queue / binding、四種 exchange
  05  可靠性設定                      confirm、手動 ack、prefetch
  06  重試、延遲與叢集                DLX、退避、延遲佇列、quorum queue
      ↓
Kafka（log 模型）
  07  模型與生產者                    partition / offset / ISR、acks、批次
  08  消費者與位移                    ★ 核心：consumer group、rebalance、提交時機
  09  交易與保留                      冪等 producer、精確一次、retention、compaction
      ↓
收尾
  10  錯誤處理與可觀測性              死信主題、重試階梯、traceId 跨 MQ、lag 監控、重放 SOP
  11  選型與混用                      決策表、共存架構、什麼時候不該用 MQ
```

📌 **01～03 為什麼放在兩套實作之前**：
因為它們是**跟品牌無關的難題**。
「訊息會掉」不是 RabbitMQ 的 bug，「訊息會重複」不是 Kafka 的缺陷 ——
它們是「跨兩個行程送一件待辦事項」這件事的本質困難。
先把問題想清楚，再去看兩套工具各自怎麼處理它，你會發現 04～09 章的每一個設定項都有名字了。

### 0.9.2 本章的六個事故分別在哪裡被解決

| 事故 | 節 | 症狀 | 根因 | 解在 |
|---|---|---|---|---|
| ① 部署掉 2,834 封信 | 0.2.1 | 沒有任何錯誤 | 佇列在會死的行程裡 | **01 章**（搬到 broker + 持久化 + confirm） |
| ② 佇列滿了拒絕 95.7% | 0.2.2 | 連訂單交易一起回滾 | heap 是有限的 | **01 章**（broker 的容量不是你的 heap） |
| ③ 失敗 100 封沒有憑據 | 0.2.3 | 只有堆疊，補不回來 | 失敗沒被記錄成待辦 | **06 / 10 章**（DLX + 死信主題 + 重放 SOP） |
| ④ 順序在測試裡「是對的」 | 0.5.1 | 上線才亂 | 沒給 key、sticky partitioner | **07 章**（key 與分區）、**05 章**（RabbitMQ 的併發） |
| ⑤ 一則訊息三秒 45 MB 日誌 | 0.5.2 | **積壓顯示 0** | `requeue=true` 無退避 | **06 章**（DLX + 退避）、**10 章**（監控 redeliver 率） |
| ⑥ 訊息送了但資料庫回滾 | 0.3.3 | 通知寄出、訂單不存在 | 雙寫問題 | **02 章**（Outbox） |

### 0.9.3 這一站**不**處理的四件事

**① 不教 broker 的內部原理**

RabbitMQ 的 Erlang 行程模型、Kafka 的 log segment 檔案格式、副本同步協定的細節 ——
這些是**維運 broker** 的知識。本站的立場是「你是使用者，broker 由別人（或雲端）維運」，
所以只教「這個設定會造成什麼行為」，不教「它在 broker 裡怎麼實作的」。

⚠️ **但有兩個例外，因為不懂它們就一定會寫錯**：
Kafka 的**分區與 ISR**（07 章）、RabbitMQ 的**prefetch 與 channel**（05 章）。

**② 不教叢集架設**

本站全程單節點。副本數永遠是 1、RabbitMQ 永遠是單機。
06 章會談 classic / quorum queue 的差別、07 章會談 `min.insync.replicas` 的語意，
但**不會帶你架三節點叢集** —— 那是另一門課的份量，而且雲端託管服務（MSK、CloudAMQP、Confluent）
已經把這件事拿走了。

**③ 不教 Kafka Streams / ksqlDB / Kafka Connect**

那是「用 Kafka 做流式處理」，是另一個世界。
本站只把 Kafka 當**訊息傳輸**用。09 章會提一句「把 Kafka 當事件來源」的取捨，然後就停在那裡。

**④ 不教 Spring Cloud Stream**

它是一層把 RabbitMQ 與 Kafka 都包起來的抽象（`binder`）。
**刻意不教的理由**：這一站的重點正好是「兩者的差別」，
而 Spring Cloud Stream 的價值在於「讓你不必知道差別」。
📌 你學完這一站之後再去看它會很輕鬆；反過來先學它，你會不知道自己在設什麼。

---

## 0.10 常見誤區

**① 「加了 MQ 系統就變快了」**

0.5.3 實測：端到端多了 **0.306 ms（RabbitMQ）到 0.764 ms（Kafka）**，p99 多 1～2 ms，max 可能 30 ms。
**系統變慢了，只有使用者感覺變快** —— 因為那 2 秒的寄信被搬走了。
如果你搬走的東西本來只要 5 毫秒，那你純粹是讓系統變慢又變複雜。

**② 「訊息設了 persistent 就不會掉」**

不夠。至少還有三個缺口，01 章會逐一實測：

- 生產者送出去了，**但 broker 還沒收到就斷線** —— 沒開 confirm 的話你不會知道（0.8.2）。
- broker 收下了，**但還在記憶體裡沒落盤就斷電**（RabbitMQ 的 `delivery_mode=2` 不等於同步 fsync）。
- 訊息落盤了，**但消費者 ack 之後才掛掉**（事情沒做、訊息已刪）。

**③ 「Kafka 有順序保證」**

**它保證的是「同一個分區內有序」。** 0.5.1 實測：三分區、不給 key、兩台機器 → 順序全亂。
而且最壞的是**小量測試時它是對的**，所以這個 bug 會活到正式環境。

**④ 「消費失敗就 requeue，反正會重試」**

0.5.2 實測：一則訊息、三秒、**11,191 次投遞、45 MB 日誌、佇列積壓 0**。
`requeue=true` 沒有退避、沒有次數上限。**它不是重試機制，它是無窮迴圈。**

**⑤ 「我會小心寫，不會有重複」**

跟你寫得多小心無關。0.5.2 下半節列了四種情境，其中「處理完了，ack 在網路上丟了」
**沒有任何程式寫法可以避免** —— 這是 at-least-once 的定義。
📌 **正確的心態：假設每一則訊息都會被處理兩次，然後讓它不出事（03 章）。**

**⑥ 「訊息送出去了，資料庫也寫了，兩件事都成功」**

不是。`@Transactional` 管不到 broker，broker 的 confirm 管不到你的交易。
先送訊息 → 資料庫回滾 → **通知寄出、訂單不存在**。
先寫資料庫 → 送訊息前掛掉 → **訂單存在、通知永遠不來**。
兩種寫法都錯，**02 章整章在講唯一的解法**。

**⑦ 「用 `AFTER_COMMIT` 事件送訊息就安全了」**

[05-service/06](../05-service/06-async-and-external-api-calls.md) 6.3.5 講過一半，02 章會把另一半講完：
`AFTER_COMMIT` 只保證「交易提交之後才送」，它**不保證「一定會送」**。
交易提交完、送出訊息前那一瞬間服務被 `kill -9` —— **訂單在、訊息永遠不存在，而且沒有任何紀錄**。
那個時間窗很小（毫秒級），但你一天有 10 萬筆訂單、一年重啟幾百次。

**⑧ 「積壓是 0 就表示一切正常」**

0.5.2 實測：積壓 0、系統正在死。
**積壓是 0 有三種可能**：真的處理完了、沒有人在生產、或者**訊息正在以每秒三千次的速度失敗重投**。
你需要的是 `redeliver` 率、消費者錯誤率、死信深度（10 章）。

**⑨ 「先用 MQ，量大再說」**

反了。0.5.6：**量小的時候「一張表 + 一個輪詢」是更好的工程選擇**，
而且它連 02 章的雙寫問題都順便解決了。
MQ 的成本不在「裝起來」，在「團隊每一個人都要懂它、而且半夜它會壞」。

**⑩ 「Kafka 比 RabbitMQ 新，所以比較好」**

它們解決的問題不一樣（0.4.4）。
「延遲 30 分鐘後檢查未付款訂單」在 RabbitMQ 是一行設定，在 Kafka 你要自己寫時間輪。
反過來「新的 BI 消費者要補跑三個月歷史」在 Kafka 是改一個 offset，在 RabbitMQ **做不到**。

---

## 0.11 本章小結

**這一章建立了四件事**：

1. **一個第一原則**（0.2.4）：**MQ 的價值不是「非同步」，是「佇列活得比你的行程久」。**
   `@Async` 也能非同步，但它的佇列跟行程同生共死 —— 94.5% 的消失率。
2. **兩種模型**（0.4）：broker 模型讀走就沒了（`null`）、log 模型讀完還在（讀三輪還是 3 則）。
   **這不是功能多寡，是兩種語意**：派工 vs 事實。
3. **四個新問題**（0.5）：順序（而且會騙過測試）、重複（而且是必然的）、
   延遲（0.3～0.8 ms）、看不見（積壓 0 但系統在死）。
4. **一套環境與工具**（0.6～0.8）：三台釘住版本的容器、一個 Spring Boot 專案、
   一個 `MsgProbe` —— 接下來十一章都在這上面跑。

### 0.11.1 驗收清單

做得到才往下走：

- [ ] `docker exec rabbit-lab rabbitmq-diagnostics -q ping` 回 `Ping succeeded`。
- [ ] `docker exec kafka-lab /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list` 不報錯。
- [ ] 瀏覽器開得開 <http://localhost:15673>，登得進去。
- [ ] 說得出 Kafka 那個 `KAFKA_ADVERTISED_LISTENERS` **為什麼要宣告兩份**，
      以及只宣告 `localhost:19092` 時會壞在哪一邊。
- [ ] 說得出 `KAFKA_AUTO_CREATE_TOPICS_ENABLE=true` 為什麼**不該**出現在正式環境。
- [ ] 跑完 0.2 的三個死法，說出三個根因收斂成的那一句話。
- [ ] 說出 0.4.1 那個 `null` 代表什麼，以及它讓你「不能做什麼」。
- [ ] 說出 `--reset-offsets` 的兩個限制（group 不能有活躍成員、重放 = 重複處理）。
- [ ] **不看課文**，說出 0.5.1 三個實驗的差別在哪（提示：程式碼完全一樣）。
- [ ] 說出「積壓是 0」的三種可能。
- [ ] 說出三個「不該用 MQ」的場景。
- [ ] `ProbeSmokeTest` 印出和 0.8.6 一樣格式的輸出。

### 0.11.2 本章練習

**練習一（10 分鐘）**：把 0.2.1 的佇列容量從 10,000 改成 `Integer.MAX_VALUE`（預設值），
然後把送出的數量從 3,000 改成 300 萬，`-Xmx256m` 跑。
**記錄它死掉的方式與時間點。** 你會拿到一份 `OutOfMemoryError`，
而且**已經接下的請求也一起死了** —— 這是「無界佇列」的真實代價。

**練習二（15 分鐘）**：把 0.4.1 的 `receiveAndConvert()` 換成
`rabbit.execute(channel -> channel.basicGet(Q, false))`（`false` = 不自動 ack），
然後**不要 ack**，直接讓測試結束。
用 `rabbitmqctl -q list_queues name messages messages_unacknowledged` 看佇列。
**`messages` 是 0 但 `messages_unacknowledged` 不是 0** ——
這個「第三種狀態」是 05 章 prefetch 與 06 章 DLX 的基礎，先親眼看到它。

**練習三（20 分鐘）**：重跑 0.5.1 的三個實驗，但把分區數從 3 改成 1。
**三個實驗現在都會通過。** 想一想為什麼，然後回答：
「把分區數設成 1 來保證順序」這個做法的代價是什麼？（07 章 7.4 會量給你看，先自己想。）

**練習四（15 分鐘）**：重跑 0.5.2 的風暴，但這次**一邊跑一邊開著管理介面**
（<http://localhost:15673> → Queues → `storm.q`）。
**看那張圖**：找出 `Deliver` 與 `Redeliver` 兩條線，記錄它們的數值。
然後回答：如果你只有「積壓」這一個告警，你要多久才會發現這件事？

**練習五（進階，30 分鐘）**：在你自己的機器上重跑 0.5.3 與 0.5.4。
**你的數字跟課文差多少？** 如果 Kafka 的 p99 差超過 3 倍，
試著調 `spring.kafka.producer.properties.linger.ms`（預設 0，Spring 的 `KafkaTemplate` 會用它）
到 5、20、100，各量一次。
**畫成一張表：linger.ms → p50 / p99 / 吞吐。**
你要親眼看到「延遲與吞吐是同一個旋鈕的兩端」——07 章 7.6 會用到這張表。

**練習六（進階，30 分鐘）**：用 0.5.6 的思路，**不裝任何 MQ**，
用一張 `outbox` 表 + `@Scheduled(fixedDelay = 5000)` 實作「訂單成立後寄信」。
要求：失敗要重試、重試三次進 `status='FAILED'`、可以用 SQL 列出所有失敗的。
**記錄你寫了幾行、花了多久。**
02 章會拿你這個版本跟 Outbox 模式對照 —— 你會發現你已經寫出了 Outbox 的一半，
而缺的那一半（跟訂單同一個交易、多台輪詢不互搶）正好是 02 章的重點。

---

## 0.12 下一章預告

下一章（01）只回答一個問題：**一則訊息，會在哪裡掉？**

答案是**三個地方**，而且三個都會用實測給你看它掉：

```
生產者 ──①──▶ broker ──②──▶ 消費者
         ↑         ↑          ↑
       第一段    第二段     第三段
     送出去了     收下了     收到了
     但沒到       但沒落盤   但沒做完
```

這一章會回答四個問題，而且四個都反直覺：

- **沒開 confirm 的時候，`convertAndSend()` 回傳成功代表什麼？**
  實測：broker 活著、連線正常、**routing key 少打一個字母** ——
  500 則訊息回傳 500 次成功、0 個例外，然後被 broker 靜靜丟掉。
- **開了 confirm 之後，吞吐剩下多少？**
  實測：`47,619 → 8,000 → 1,359` 則/秒。
  光是「把 channel 切到 confirm 模式」就掉了 6 倍，**每則都等**再掉 6 倍。
- **`acks=0` / `acks=1` / `acks=all` 到底差在哪？**
  實測（**兩台 broker、拔掉一台**）：`acks=1` 回報「成功，offset 3」，
  訊息也確實寫在 leader 的磁碟上 —— 但**沒有任何消費者讀得到它**，
  而且 consumer lag 顯示 0。`acks=all` 是唯一一個當場拒絕你的選項。
- **「不重不漏」為什麼做不到？**
  這一章會把它講成一個**必須選邊的取捨**，而不是一個「設定對了就有」的功能。
  選了「不漏」（at-least-once）就要接受重複 → 03 章；
  選了「不重」（at-most-once）就要接受遺失 → 只有分析類的資料可以這樣。

01 章結束時，你會有一張「三段 × 兩個 broker × 防守手段與代價」的表 ——
那張表是後面 04～09 章所有設定項的索引。
