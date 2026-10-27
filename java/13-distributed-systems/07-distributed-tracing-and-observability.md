# 第 07 章：分散式追蹤：一個 traceId 穿過 HTTP 與 MQ

> **上一章**：[第 06 章](06-resilience-in-a-service-mesh.md)讓「等庫存服務」有了上限：逾時預算、重試預算、隔艙、熔斷器。它的每一個數字都是實驗台量出來的 —— 每秒的 Tomcat 執行緒、在呼叫端數的 `CallTap`、在庫存服務那一邊數的 `ServerTap`。線上沒有實驗台。第 04 章 4.10.7 的 K5 量過：訂單服務送出了 `traceparent`，庫存服務的日誌卻用了另一個 traceId。
>
> **這一章**：讓一個 traceId 穿過 HTTP 與 RabbitMQ，送到一個看得到的地方，並且用它回答第 06 章 6.14 的問題 ——**這一張下單慢在哪一段？** 先量現在的樣子：一張慢的下單、抽樣之後、客服拿 traceId 找日誌。然後：
>
> - 換成 OpenTelemetry，送到 Jaeger；兩個服務各有自己的名字（7.3、7.4）
> - HTTP 收的那一邊，只信任自己的服務帶來的 traceparent（7.5）
> - MQ：outbox 記住寫它的那一個 span，消費者接在它底下（7.6）
> - trace 上補兩種 span：每一次遠端呼叫、每一次借連線；用 self time 找出誰慢了（7.7）
> - 選抽樣率，量它的成本（7.8）
> - 決定告警設在哪（7.9）
>
> 最後用一次演練走完「告警 → exemplar → trace → 日誌」（7.11）。
>
> **你手上會有**：從 `d06` 開出來的分支 `d07`。正式程式碼的改變：
>
> - Micrometer Tracing 的實作從 Brave 換成 OpenTelemetry，正式環境用 OTLP 送出（`SHOP_OTLP_ENDPOINT`）；compose 多一個 Jaeger。
> - 兩個角色各有自己的 `spring.application.name`；JSON 日誌的 `service` 欄位跟著它。Spring Security 的觀測關掉。
> - `TraceFilters`：`/internal/**` 而且帶著有效的服務 token，才收 `traceparent`。
> - outbox 多一欄 `traceparent`（V34）；relay 送它；消費者接在它底下，舊的訊息走另一條路。
> - `RemoteInventoryApi` 每一次呼叫一個觀測 `shop.remote.call`；`TracedDataSource`：每一次借連線一個 span。
> - 啟動時檢查日誌拿不拿得到 traceId。
> - 告警規則認 `system="shop"`，不認 job 的名字；使用者的 5xx 只算 `/api/**`。
>
> 測試 362 個，failsafe 契約驗證 39 個。

---

## 7.1 學習目標

讀完這一章，你應該能：

- 說出一個 traceId 從買家的請求，經過 HTTP 到另一個服務、經過 outbox 與 RabbitMQ 到消費者，每一段是誰負責傳、斷在哪裡會是什麼樣子。
- 決定**收的那一邊要信任誰**的 `traceparent`，並說出為什麼不能全收、也不能全不收。
- 讓消費者接在**寫這一筆事件的那一個 span** 底下，而不是只接 traceId；並說出換版那一刻的舊訊息怎麼處理。
- 在 trace 上補上「看不到的那幾段」（遠端呼叫的結果、借連線），用 **self time** 找出一張慢的請求慢在哪一個服務的哪一段。
- 用量的方式選抽樣率：它讓幾個 trace 是完整的、要付多少成本；並說出日誌、exemplar 與 trace 各自在抽樣之下剩下什麼。
- 決定**告警設在哪**：哪一些叫醒人、哪一些是排查時才看的原因；以及告警規則為什麼不能寫死部署的形狀。
- 從一條告警走到一條 trace，指出是哪一個服務慢了。

---

## 7.2 先看見痛：一張慢的下單，查得到慢在哪嗎 ★★★

### 7.2.0 開分支

```bash
git switch -c d07 d06
```

這一章的第一個 commit 只有三個實驗（H1、H2、H3），正式程式碼還是第 06 章的。

### 7.2.1 實驗怎麼做（H1）

第 12 站 9.8.2 加了追蹤（Brave），但**沒有送去任何地方**：span 產生了、traceId 進了 MDC，然後被丟掉。要看「如果送了，後端會收到什麼」，實驗在每一個服務裡掛一個收 span 的掛勾。Boot 會把每一個 Brave 的 `SpanHandler` bean 接到 `Tracing` 上：

```java
@Configuration
@ConditionalOnProperty(name = "lab.d07.span-tap", havingValue = "true")
public class SpanTap {

    @Bean
    SpanHandler d07SpanTap(ShopProperties props) {
        String role = props.deployment().role().serviceName();
        return new SpanHandler() {
            @Override
            public boolean end(TraceContext context, MutableSpan s, Cause cause) {
                if (cause != Cause.FINISHED) return true;
                List<String> events = new ArrayList<>();
                s.annotations().forEach(a -> events.add(String.format("%+.1f ms %s", (a.getKey() - s.startTimestamp()) / 1000.0, a.getValue())));
                Spans.ALL.add(new Spans.Rec(role, s.localServiceName(), s.traceId(), s.id(), s.parentId(), s.name(), String.valueOf(s.kind()),
                        s.startTimestamp(), s.finishTimestamp() - s.startTimestamp(), s.error() != null || s.tags().containsKey("error"),
                        new TreeMap<>(s.tags()), events));
                return true;
            }
        };
    }
}
```

`Spans` 把收到的 span 依 traceId、parent 接成一棵樹印出來（完整的類別在 7.13.1）。每一行是「距第一個 span 開始幾毫秒、多久、`[服務]` 名稱」；parent 找不到的，標出來。服務的名字印兩個：後端會看到的（`spring.application.name`），以及實驗自己知道是哪一個 context 記的。兩個不一樣，就是一個問題。

H1 用正式的角色起兩個服務（在同一個 JVM 裡，第 03 章 `dist03.Roles` 的做法），事件走 RabbitMQ，抽樣 100%：

1. 一張正常的下單。
2. **6.2 的那一張**：第 06 章之前的設定（read timeout 3 秒、最多送 2 次），庫存服務做完預留、回應晚 3 秒（第 03 章的 `LostResponse`）。
3. 付款 → `order.paid` → 兩個服務的消費者。
4. 同一張慢的下單，第 06 章的設定。

另外用第 04 章的 `TraceTap` 記庫存服務**收到的** `traceparent` 與它的日誌用的 traceId。

```bash
mvn test -Pexperiments -Dtest=H1SlowOrderTraceTest
```

### 7.2.2 一張正常的、一張慢的

```
═══ 7.2 ① 一張正常的下單（抽樣 100%；6.2 的設定：read 3000 ms、最多送 2 次、下單的預算 10000 ms）（load { 5.19 6.52 6.17 }）═══
  回應 201（35 ms），X-Trace-Id 6ad58a07d72ac1b4520ed2a6f452a043
  這個 traceId：
    trace 6ad58a07d72ac1b4520ed2a6f452a043：9 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 145.7 ms
         +0.0 ms       34.5 ms  [shop：其實是 order-service] http post /api/orders SERVER  exception=none status=201 uri=/api/orders
        +17.0 ms        8.0 ms    [shop：其實是 order-service] http put CLIENT  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
       +132.9 ms        8.4 ms  [shop：其實是 inventory-service] consume inventory.hot-settlement  ← parent 3f4e42e559dee6f4 不在任何一個 span 裡
       +135.4 ms       10.3 ms  [shop：其實是 order-service] consume notification.order-events  ← parent 67e6b663a6d02baa 不在任何一個 span 裡
  同一段時間裡的其他 trace：1 個（另外 0 個是排程的一輪，只有一個 scheduled span，不印）
    trace 6ad58a0773c3a6ecb2cd9ae3c8a39670：7 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 123.4 ms
         +0.0 ms        6.5 ms  [shop：其實是 inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
       +114.9 ms        8.5 ms  [shop：其實是 order-service] consume catalog.stock-levels  ← parent 245683ed38beb699 不在任何一個 span 裡
  庫存服務 │ PUT /internal/inventory/v1/reservations/21 │ 收到的 traceparent=00-6ad58a07d72ac1b4520ed2a6f452a043-ce855738aa585ce0-01 │ 日誌用的 traceId 6ad58a0773c3a6ecb2cd9ae3c8a39670
```

一張正常的下單，後端會收到**兩個 trace**：

- 訂單服務的那一個：`http post /api/orders`，底下一個 `http put`（送給庫存服務的預留）。
- 庫存服務的那一個：`http put /internal/inventory/v1/reservations/{orderId}`，自己是根。

`TraceTap` 那一行說明了為什麼：庫存服務**收到了**訂單服務的 `traceparent`（`00-6ad58a07d72ac1b4520ed2a6f452a043-…-01`），日誌卻用了另一個 traceId。第 12 站 9.8.4 在最前面把外面帶進來的 trace header 全部藏起來 —— 它分不出「外面的人」與「自己的訂單服務」。

另外三件事：

- **每一個 span 都說自己是 `shop`。** 兩個服務是同一個 jar、同一個 `spring.application.name`。後端的服務清單上只有一個 shop。
- **9 個 span 裡 5 個是 Spring Security 的**（下面不印的那 5 個）：filter chain 的前後、認證、授權、secured request。
- **消費者的 parent 不存在**：`consume notification.order-events` 的 traceId 跟下單的一樣，parent 卻是一個沒有人送出過的 spanId（下一節）。

慢的那一張：

```
═══ 7.2 ① 一張慢的下單：庫存服務做完預留、回應晚 3 秒（load { 5.19 6.52 6.17 }）═══
  回應 503（6,047 ms），X-Trace-Id 6ad58a07e69dc692a169b5d35903d6c4
  這個 traceId：
    trace 6ad58a07e69dc692a169b5d35903d6c4：8 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 6,046.5 ms
         +0.0 ms     6046.5 ms  [shop：其實是 order-service] http post /api/orders SERVER  exception=none status=503 uri=/api/orders
        +23.6 ms     3002.2 ms    [shop：其實是 order-service] http put CLIENT  ERROR  exception=ResourceAccessException status=CLIENT_ERROR uri=/internal/inventory/v1/reservations/{orderId}
      +3028.4 ms     3002.1 ms    [shop：其實是 order-service] http put CLIENT  ERROR  exception=ResourceAccessException status=CLIENT_ERROR uri=/internal/inventory/v1/reservations/{orderId}
  同一段時間裡的其他 trace：2 個（另外 4 個是排程的一輪，只有一個 scheduled span，不印）
    trace 6ad58a07be4567dddb92bea5f4a3d4cd：7 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 143.6 ms
         +0.0 ms        7.2 ms  [shop：其實是 inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
       +135.4 ms        8.1 ms  [shop：其實是 order-service] consume catalog.stock-levels  ← parent 4f720afdee1bcb95 不在任何一個 span 裡
    trace 6ad58a0aff52cdcf4225b2587d5d273e：6 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 12.9 ms
         +0.0 ms       12.9 ms  [shop：其實是 inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
  庫存服務 │ PUT /internal/inventory/v1/reservations/22 │ 收到的 traceparent=00-6ad58a07e69dc692a169b5d35903d6c4-60384a4541fb6862-01 │ 日誌用的 traceId 6ad58a07be4567dddb92bea5f4a3d4cd
  庫存服務 │ PUT /internal/inventory/v1/reservations/22 │ 收到的 traceparent=00-6ad58a07e69dc692a169b5d35903d6c4-ab9ad4f01a476641-01 │ 日誌用的 traceId 6ad58a0aff52cdcf4225b2587d5d273e
```

這就是 6.2 的那 6 秒在 trace 上的樣子：

- 訂單服務的 trace：兩個 `http put`，各 3 秒，都是 `ResourceAccessException`。
- 庫存服務做的事在**另外兩個 trace** 裡：7.2 ms、12.9 ms。

拿著訂單服務的 trace，看得到「等了兩次 3 秒」，看不到「對方只花了幾毫秒就做完了」—— 那兩個 span 在別的 trace 裡，而且沒有任何東西把它們接回來（它們的 traceId 是新的，`orderId` 只在 URL 裡）。6.14 問的「慢在哪一段」，這一張答不出來。

### 7.2.3 付款之後：消費者的 parent

```
═══ 7.2 ② 付款 → order.paid → 兩個服務的消費者（load { 4.40 6.30 6.10 }）═══
  金流回呼 200，X-Trace-Id 6ad58a124bab098410780374c7d5796f
  這個 traceId：
    trace 6ad58a124bab098410780374c7d5796f：7 個 span（其中 Spring Security 的 4 個，下面不印），第一個開始到最後一個結束 90.8 ms
         +0.0 ms       14.8 ms  [shop：其實是 order-service] http post /api/payments/callback SERVER  exception=none status=200 uri=/api/payments/callback
        +79.3 ms       11.5 ms  [shop：其實是 order-service] consume notification.order-events  ← parent 37bd01139c83c361 不在任何一個 span 裡
        +79.3 ms        7.0 ms  [shop：其實是 inventory-service] consume inventory.order-events  ← parent 52839d806165bd64 不在任何一個 span 裡
  同一段時間裡的其他 trace：1 個（另外 1 個是排程的一輪，只有一個 scheduled span，不印）
    trace 6ad58a12f282f2339ad44e459dbcf0e2：6 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 25.7 ms
         +0.0 ms       25.7 ms  [shop：其實是 order-service] http post /api/orders/{orderNo}/payments SERVER  exception=none status=201 uri=/api/orders/{orderNo}/payments
```

`order.paid` 的兩個消費者 —— 庫存服務確認預留、訂單服務寄信 —— 跟金流回呼在**同一個 traceId** 裡（第 12 站 9.8.3 做的：relay 把 outbox 的 `trace_id` 放在 header，消費者 `continueTrace`）。日誌因此接得上。

但它們的 parent 是 `continueTrace` **編出來的** spanId：這個 trace 裡沒有任何一個 span 有那個 id，後端拿到的是三段接不起來的 span。而且 Brave 在消費者那裡**重新決定要不要抽樣**：這一次是 100%，看不出來；下一節是 Boot 預設的 0.1。

第 06 章的設定（③）是同一個形狀，兩個 client span 各 1 秒左右（2 秒的預算）：

```
═══ 7.2 ③ 同一張慢的下單，第 06 章的設定（read 1000 ms、最多送 2 次、下單的預算 2000 ms）（load { 4.25 6.21 6.07 }）═══
  回應 503（2,025 ms），X-Trace-Id 6ad58a19341492bd3d51450e27af7a32
  這個 traceId：
    trace 6ad58a19341492bd3d51450e27af7a32：8 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 2,023.3 ms
         +0.0 ms     2023.3 ms  [shop：其實是 order-service] http post /api/orders SERVER  exception=none status=503 uri=/api/orders
        +41.8 ms     1003.7 ms    [shop：其實是 order-service] http put CLIENT  ERROR  exception=ResourceAccessException status=CLIENT_ERROR uri=/internal/inventory/v1/reservations/{orderId}
      +1046.4 ms      967.0 ms    [shop：其實是 order-service] http put CLIENT  ERROR  exception=ResourceAccessException status=CLIENT_ERROR uri=/internal/inventory/v1/reservations/{orderId}
  同一段時間裡的其他 trace：2 個（另外 2 個是排程的一輪，只有一個 scheduled span，不印）
    trace 6ad58a194d6553296f41fcb44e0873a3：7 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 17.0 ms
         +0.0 ms        7.1 ms  [shop：其實是 inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
        +13.3 ms        3.7 ms  [shop：其實是 order-service] consume catalog.stock-levels  ← parent 3260a77ecf2129ab 不在任何一個 span 裡
    trace 6ad58a1a9ca80b652fddf42a880d7c68：6 個 span（其中 Spring Security 的 5 個，下面不印），第一個開始到最後一個結束 7.0 ms
         +0.0 ms        7.0 ms  [shop：其實是 inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
  庫存服務 │ PUT /internal/inventory/v1/reservations/23 │ 收到的 traceparent=00-6ad58a19341492bd3d51450e27af7a32-70ce88550f72d642-01 │ 日誌用的 traceId 6ad58a194d6553296f41fcb44e0873a3
  庫存服務 │ PUT /internal/inventory/v1/reservations/23 │ 收到的 traceparent=00-6ad58a19341492bd3d51450e27af7a32-7d8d3da3ffa9ea38-01 │ 日誌用的 traceId 6ad58a1a9ca80b652fddf42a880d7c68
  （結束時 load { 3.67 6.02 6.00 }）
```

### 7.2.4 抽樣之後（H2）

正式環境不會抽 100%。Boot 的預設是 `management.tracing.sampling.probability = 0.1`。H2 照預設，做 200 次「下單 → 付款」，用每一個回應的 `X-Trace-Id` 去找：每一段有沒有被送出去、在不在同一個 trace 裡、接不接得上。

```bash
mvn test -Pexperiments -Dtest=H2SamplingTest
```

```
═══ 7.2 ④ 抽樣（management.tracing.sampling.probability = 預設）：200 次「下單 → 付款」（load { 4.83 6.18 6.06 }）═══
  回應帶著 X-Trace-Id 的：200 / 200 次（下單與回呼都有）
  下單 200 次 │ 訂單服務的 span 送出去的：21 個 trace │ 同一個 trace 裡也有庫存服務的預留：0 個
             │ 庫存服務的預留 span 送出去的：24 個；自己是一個 trace 的根：24 個；traceId 是哪一張下單的：0 個
  付款 200 次 │ 回呼的 span 送出去的：21 個 │ 庫存服務消費 order.paid 的 span 送出去的：21 個（traceId 是哪一次回呼的：21 個；那一次回呼的 span 也在的：2 個）
             │ 通知的消費者 span 送出去的：43 個 │ 消費者 span 的 parent 找得到的：庫存 0 / 21、通知 0 / 43
  完整的下單 trace（訂單、庫存兩段都在、每一個 span 都接得上）：0 個；只有其中一段的：21 個
  完整的付款 trace（回呼、兩個消費者都在、每一個 span 都接得上）：0 個
  span 一共 622 個；其中 Spring Security 的 419 個、排程的 1 個
  （結束時 load { 4.62 6.07 6.02 }）
```

- **回應的 `X-Trace-Id` 每一個都有**：抽樣只決定 span 送不送，traceId 照樣產生、照樣進 MDC（第 12 站 9.8.2 觀察過）。
- **下單**：訂單服務的 span 送出去 21 個 trace，沒有一個裡面有庫存服務的預留。庫存服務自己抽了 24 個，全部是根 —— 它收不到 traceparent，每一個請求都自己開一個 trace、自己抽一次。
- **付款**：回呼的 span 送出去 21 個；庫存服務的消費者 21 個，traceId 都對，但「回呼也在」的只有 2 個 —— 兩邊各抽各的，碰在一起的機率大約是 0.1 × 0.1（推論）。parent 一個都接不上。
- **完整的 trace：0 個。** 622 個 span 送出去，沒有一個能回答「這一張下單慢在哪」。其中 419 個是 Spring Security 的。

### 7.2.5 客服拿 traceId 找日誌（H3）

第 12 站 9.8.3：每一個錯誤回應都帶著 traceId，「客服拿著它就能在日誌裡找到那一行」。切開之後還成立嗎？

H3 讓兩個服務**各在自己的 JVM**（第 04 章 `dist04.OrderNode`：跟正式環境一樣各寫各的日誌），日誌用正式環境的格式（一行一個 JSON，第 12 站 9.7）。事故是庫存服務的資料庫變慢：

- 每個預留交易 +600 ms。開關是一個檔案（`SlowSql`）：第 06 章的 `SlowDb` 是一個 static 欄位，另一個 JVM 裡改不到。
- 庫存服務的連線池只有 2 條、借連線最多等 250 ms。
- 12 張下單同時送。

測試這一邊沒有那兩個服務的 bean 可以簽買家的 token，所以起一個只有設定與 `AccessTokens` 的小 context（`Keys`，7.13.1）。

```bash
mvn test -Pexperiments -Dtest=H3SupportLookupTest
```

```
═══ 7.2 ⑤ 客服拿 traceId 找日誌：兩個服務各在自己的 JVM，日誌是一行一個 JSON（load { 4.70 6.01 6.00 }）═══
  一張正常的下單 201，traceId 6ad58a55e916b642dec137fe4bde39bf │ 訂單服務的日誌 2 行 │ 庫存服務的日誌 0 行
    訂單服務 │ 2026-10-19T03:11:17.905717Z INFO  PlaceOrderService │ traceId=6ad58a55e916b642dec137fe4bde39bf │ ORDER_PLACED orderNo=20261019-117354 buyerId=7300001 lines=1 hot=0
    訂單服務 │ 2026-10-19T03:11:17.972403Z INFO  SimulatedMailer │ traceId=6ad58a55e916b642dec137fe4bde39bf │ MAIL_SENT user=7300001 type=ORDER_PLACED 訂單 20261019-117354 已成立，請在 15 分鐘內完成付款
  事故：庫存服務每個預留交易 +600 ms、連線池 2 條、借連線最多等 250 ms；12 張下單同時送 → {201=2, 503=10}
  買家畫面上的錯誤：{"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"系統忙碌中，請稍後再試","instance":"/api/orders","traceId":"6ad58a578402e04972940b149fa4262f"}
  回應的 X-Trace-Id 6ad58a578402e04972940b149fa4262f（跟錯誤內容裡的 traceId 一樣）
  客服用 6ad58a578402e04972940b149fa4262f 找：訂單服務的日誌 0 行、庫存服務的日誌 0 行
  這幾秒，庫存服務的 WARN「拿不到資料庫連線」：10 行；traceId 10 個不一樣的；是這 12 張下單之一的：0 個
    庫存服務 │ 2026-10-19T03:11:19.78108Z WARN  GlobalExceptionHandler │ traceId=6ad58a57cea729712339b9b62e045b44 │ 拿不到資料庫連線：Could not open JPA EntityManager for transaction
    庫存服務 │ 2026-10-19T03:11:19.781087Z WARN  GlobalExceptionHandler │ traceId=6ad58a57b60bb27236d47b654493965f │ 拿不到資料庫連線：Could not open JPA EntityManager for transaction
  這幾秒，訂單服務的日誌 4 行（WARN 以上 0 行）、庫存服務 38 行
  日誌的 service 欄位：訂單服務的檔案 {shop=52}、庫存服務的檔案 {shop=44}
```

買家拿到一個 503，畫面上有一串 traceId。客服拿它去兩個服務的日誌找：**都是 0 行。**

- 庫存服務其實記了：10 行「拿不到資料庫連線」—— 但每一行是它自己開的 trace，10 個不一樣的 traceId，沒有一個是這 12 張下單的。
- 訂單服務**一行都沒有記**：庫存服務的 503 原樣交給買家（第 03 章 3.4.5 的 `PASS_THROUGH`），`RemoteInventoryApi` 不記錄它。
- 兩個檔案的 `service` 欄位都是 `shop`：第 12 站 9.7 寫死的。

### 7.2.6 五件事

| | 在哪裡斷 | 這一章 |
|---|---|---|
| ① | HTTP 收的那一邊：第 12 站 9.8.4 把每一個 trace header 都藏起來 | 7.5 |
| ② | MQ：只傳 traceId，消費者的 parent 是編的、抽樣自己決定 | 7.6 |
| ③ | 抽樣：兩個服務、生產者與消費者各自決定，完整的 trace 0 個 | 7.6、7.8 |
| ④ | 名字：兩個服務都叫 `shop`（span 與日誌） | 7.4 |
| ⑤ | 沒有後端：span 一個都沒有送出去 | 7.3、7.4 |

還有一件不是「斷」，是「看不到」：就算 ① 接上了，6.2 的那張下單也只會多出兩個幾毫秒的 server span。6.14 問的另外三件事 —— 訂單服務自己的交易、庫存服務的連線池、熔斷器 —— trace 上沒有對應的 span（7.7）。

---

## 7.3 選一個後端：OpenTelemetry、Jaeger

7.2 的五件事，有三件跟「送去哪裡」無關：收的那一邊藏起了 traceparent、消費者的 parent 是編的、兩個服務都叫 shop。它們不管用什麼實作、送不送出去，都是斷的。但沒有一個後端，就連「斷了」都看不到 —— 第 12 站 9.8 到現在，span 一個都沒有送出去過，7.2 是靠實驗自己掛的 `SpanTap` 才看見。

### 7.3.1 Micrometer Tracing 底下的兩種實作

Spring Boot 3 的追蹤是 **Micrometer Tracing**：程式碼（包括 Boot 自己的 HTTP 觀測、`RestClient`）只依賴它的 API，底下接一個實作。Spring Cloud Sleuth 不支援 Boot 3，它的工作搬進了 Micrometer Tracing。

實作有兩種，Boot 3.2 都有自動設定：

| | Brave（第 12 站 9.8.2 選的） | OpenTelemetry |
|---|---|---|
| 依賴 | `micrometer-tracing-bridge-brave` | `micrometer-tracing-bridge-otel` |
| 送出去的格式 | Zipkin（多數後端也收） | **OTLP**：Jaeger、Grafana Tempo、各家商用後端都直接收 |
| 抽樣（`management.tracing.sampling.probability`） | `CountingSampler`：每一個服務自己數「一百個裡抽十個」 | `parentBased(traceIdRatioBased)`：有 parent 照 parent；沒有的時候，**看 traceId 決定** |

這一章換成 OpenTelemetry，理由是表格的後兩列：

- **OTLP**：後端可以換，應用程式不用改。第 08 章談基礎設施的時候，後端會是一個選項，不是一個綁定。
- **抽樣看 traceId**：同一個 traceId，每一個服務算出來的結果一樣。有旗標的時候兩種實作都照旗標（parent-based）；差別在沒有旗標的時候 —— 例如外面的系統只送一個 traceId 過來。這是規格上的性質，這一章沒有另外量。

要先說清楚：**7.2 的那些「斷」，換實作一個都修不好。** 它們要靠 7.5（收的那一邊）、7.6（MQ 帶 traceparent）、7.4（服務的名字）。7.8 量到「完整的 trace 從 0 個變成 21 個」，功勞在傳遞，不在 Brave 或 OpenTelemetry。

### 7.3.2 Jaeger

後端選 Jaeger 的 all-in-one：一個容器裡有收（OTLP/HTTP 的 4318）、存（記憶體）、查（網頁與查詢 API 的 16686）。compose 多一個服務：

```yaml
  # 13 站 7.3：trace 的後端。OTLP/HTTP 收 4318（應用程式的 management.otlp.tracing.endpoint）、網頁與查詢 API 在 16686、
  # 它自己的指標（收到幾個 span）在 14269。all-in-one 把資料放在記憶體裡：容器刪了就沒了，只適合本機與演練
  jaeger:
    image: jaegertracing/all-in-one:1.62.0
    profiles: [app, tracing]
    environment:
      MEMORY_MAX_TRACES: "200000"
    ports: ["${SHOP_JAEGER_UI_PORT:-16686}:16686", "${SHOP_OTLP_HTTP_PORT:-4318}:4318", "${SHOP_JAEGER_ADMIN_PORT:-14269}:14269"]
```

- 放在 `tracing` 與 `app` 兩個 profile：`docker compose --profile tracing up -d jaeger` 只起它（實驗用）；`--profile app` 跟應用程式一起起。
- **資料在記憶體裡**：容器刪了就沒了，`MEMORY_MAX_TRACES` 是上限。這只適合本機與演練。正式環境的儲存（Elasticsearch、Cassandra，或換成 Tempo 存在物件儲存）是第 08 章的事。
- 14269 是它自己的指標，7.8 用它數「收到幾個 span」。

---

## 7.4 換掉 Brave

### 7.4.1 依賴與設定

```diff
   <dependencies>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
     <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
-    <!-- 第 09 章（9.8）：traceId。Micrometer Tracing 的 Brave 實作，版本由 Boot 管理；沒有送去任何地方（沒有 Zipkin），只要 traceId 進 MDC -->
-    <dependency><groupId>io.micrometer</groupId><artifactId>micrometer-tracing-bridge-brave</artifactId></dependency>
+    <!-- 第 09 章（9.8）：traceId 進 MDC。13 站 7.4：Brave 換成 OpenTelemetry 的實作，並且真的送出去（OTLP；management.otlp.tracing.endpoint 有設才送）。
+         為什麼換（7.3）：OTLP 是各家後端都收的格式；抽樣的 TraceIdRatioBased 依 traceId 決定 —— 沒有旗標的時候，同一個 traceId 每一個服務也做同一個決定
+         （Brave 的 CountingSampler 各自數）。版本都由 Boot 管理 -->
+    <dependency><groupId>io.micrometer</groupId><artifactId>micrometer-tracing-bridge-otel</artifactId></dependency>
+    <dependency><groupId>io.opentelemetry</groupId><artifactId>opentelemetry-exporter-otlp</artifactId></dependency>
     <!-- 9.7：JSON 日誌。Boot 3.2 還沒有內建的結構化日誌（3.4 才有）；這個版本對應 Boot 3.2 的 Logback 1.4 -->
     <dependency><groupId>net.logstash.logback</groupId><artifactId>logstash-logback-encoder</artifactId><version>7.4</version></dependency>
     <!-- 9.9：/actuator/prometheus（0.6.6：Micrometer → Prometheus）。版本由 Boot 管理 -->
```

Boot 3.2 的 OTLP 匯出器**只有在設了 `management.otlp.tracing.endpoint` 的時候才建**（`OtlpTracingConfigurations` 上的 `@ConditionalOnProperty`）。所以：

- 本機、測試：不設，span 照樣產生（traceId 照樣進 MDC），只是不送。
- 正式環境：`application-prod.yml` 讀 `SHOP_OTLP_ENDPOINT`，跟其他 `SHOP_*` 一樣**沒有預設值**，少了就起不來。compose 的 `app` 給它 `http://jaeger:4318/v1/traces`。

```yaml
  otlp:
    tracing:
      endpoint: ${SHOP_OTLP_ENDPOINT}   # 13 站 7.4：span 送到哪裡（OTLP/HTTP，例如 http://jaeger:4318/v1/traces）。跟其他 SHOP_* 一樣沒有預設值：少了就起不來
```

### 7.4.2 服務的名字

7.2 的每一個 span 都說自己是 `shop`。OpenTelemetry 的 `service.name` 預設是 `spring.application.name`，而第 12 站只有一個名字。兩個角色的 profile 各給一個：

```yaml
  application:
    name: order-service            # 13 站 7.4：trace 的 service.name、JSON 日誌的 service 欄位。單體是 shop；兩個服務都叫 shop 的時候，後端分不出 span 是誰的（7.2）
```

庫存服務是 `inventory-service`。單體照舊叫 `shop`。日誌的 `service` 欄位用同一個值（7.10）。

### 7.4.3 Spring Security 的 span

7.2.4 的 622 個 span 裡，419 個是 Spring Security 6 自己的觀測：每一個請求 5 個（filter chain 的前後、認證、授權、secured request）。它們在 trace 上告訴你「驗 JWT 花了 0.4 ms」—— 認證在記憶體裡做，不出行程，不是「誰慢了」會落在的地方。關掉：

```yaml
  observations:
    enable:
      # 13 站 7.4：Spring Security 6 的觀測每一個請求 5 個 span（filter chain 的前後、認證、授權、secured request）——
      # 7.2 的 200 次下單與付款，559 個 span 裡 357 個是它們。認證不出行程（JWT 在記憶體裡驗），這幾段不是「誰慢了」會落在的地方
      "[spring.security]": false
```

（註解裡的 559、357 是另一輪 H2 的數字，比例跟 7.2.4 差不多。）

`management.observations.enable.<前綴>` 關的是名字以那個前綴開頭的觀測，span 與它附帶的計時器一起關。key 裡有點。Boot 的文件說，值是 `Boolean` 這種純量時，不加 `[...]` 也會保留點；這裡加上，是為了不必記這條規則。

### 7.4.4 ⚠️ MDC 的 traceId 靠一個整個 JVM 只能裝一次的掛勾

同一個 JVM 裡，如果有一個不用 Spring 的單元測試（直接建一個 OpenTelemetry SDK 測 `Traces`）排在 Spring 的測試前面，跟它一起跑的 Spring 測試會這樣：

```
13 站 7.5：訂單服務的 token → 200 X-Trace-Id null
13 站 7.5：使用者的 token → 401 X-Trace-Id null
```

`InternalTraceparentTest` 的五種請求都是 null，驗收 Q7 也紅了。每一個請求都有 span，回應的 `X-Trace-Id` 卻是 null —— 日誌、outbox 的 `trace_id`、稽核表都從 MDC 讀 traceId，也就都拿不到。

原因在 MDC 是怎麼被放進去的：

- Brave 是 Tracing 自己的一個 `ScopeDecorator`，跟著每一個 Tracing 走。
- OpenTelemetry 的版本，是 Boot 在建 `OtelCurrentTraceContext` 的時候，往 OpenTelemetry 的 `ContextStorage` 上裝一個掛勾（`ContextStorage.addWrapper`）。**這個掛勾整個 JVM 只能在第一次用到 `Context` 之前裝**，之後再裝，OpenTelemetry 只記一行 FINE 等級的日誌，然後忽略。

那個單元測試在任何 Spring context 之前就用到了 `Context`，之後 Boot 要裝的掛勾就裝不上去了。所以這一章不寫這種測試：`Traces` 的情況放在 Spring 的測試裡測（7.6.5）。

H6 重現這件事：先在 JVM 裡碰一次 `Context`，再起一個單體。

```bash
mvn test -Pexperiments -Dtest=H6MdcHookTest
```

```
═══ 7.4 ⚠️ 起應用程式之前，同一個 JVM 先用過一次 OpenTelemetry 的 Context（load { 6.35 6.16 6.05 }）═══
  GET /api/products/{id} → 404，X-Trace-Id null
  ERROR TRACE_MDC_BROKEN 日誌拿不到 traceId（span 3eadc981b86519182dad9cb426096408、MDC null）：OpenTelemetry 的 ContextStorage 在 Boot 裝上掛勾之前就被用過了
```

最後一行是這一章加的**啟動時的檢查**：應用程式起來之後開一個 span，看 MDC 裡有沒有它的 traceId，沒有就記一行 ERROR。

```java
    /**
     * 13 站 7.4 ⚠️：MDC 的 traceId 是 OpenTelemetry 的 ContextStorage 上的一個掛勾放的（Boot 在建 OtelCurrentTraceContext 的時候裝）。
     * 這個掛勾整個 JVM 只能在第一次用到 Context 之前裝 —— 有人先用了（例如一個不用 Spring、自己建 OpenTelemetry SDK 的程式），
     * 之後的每一個請求都有 span、日誌卻沒有 traceId，而且沒有任何錯誤。啟動完成時試一次，拿不到就大聲記一行
     */
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void checkLogCorrelation() {
        Span probe = tracer.nextSpan().name("startup-check").start();
        String inMdc;
        try (Tracer.SpanInScope ignored = tracer.withSpan(probe)) {
            inMdc = org.slf4j.MDC.get("traceId");
        } finally {
            probe.abandon();
        }
        if (!probe.context().traceId().equals(inMdc))
            org.slf4j.LoggerFactory.getLogger(Traces.class).error("TRACE_MDC_BROKEN 日誌拿不到 traceId（span {}、MDC {}）：OpenTelemetry 的 ContextStorage 在 Boot 裝上掛勾之前就被用過了",
                    probe.context().traceId(), inMdc);
    }
```

正式環境一個 JVM 只有一個 Spring context，Boot 也在第一個 span 之前就裝好掛勾，平常碰不到。會碰到的情況是：同一個 JVM 裡，有一段程式碼在 Spring 啟動之前就用了 OpenTelemetry 的 API（那個單元測試就是一例）。那時候不會有任何錯誤，日誌就是沒有 traceId。這一行 ERROR 是讓它「有一個錯誤」。

### 7.4.5 ⚠️ `service_IS_UNDEFINED`

日誌的 `service` 欄位原本寫死 `"shop"`（第 12 站 9.7）。改成 Boot 的 `<springProperty>`、讀 `spring.application.name` 之後，`customFields` 裡如果直接寫 `${service}`，`JsonLogFormatTest` 會紅：

```
expected: "shop"
 but was: "service_IS_UNDEFINED"
```

這個測試用 Logback 自己的 `JoranConfigurator` 讀設定檔。`<springProperty>` 只有 Boot 載入的時候（`logging.config`）才認得；Logback 自己讀，就跳過它，`${service}` 沒有值。改成 `${service:-shop}`：

```xml
  <springProperty scope="context" name="service" source="spring.application.name" defaultValue="shop"/>
  <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <timeZone>UTC</timeZone>
      <customFields>{"service":"${service:-shop}"}</customFields>
```

---

## 7.5 HTTP：收的那一邊，只信任自己的服務

第 12 站 9.8.4 在最前面把外面帶進來的 trace header 全部藏起來，結尾留了一句：「以後這個應用程式前面如果有了一個 gateway 或另一個內部服務會呼叫它，這個 filter 就要改成『只信任內部來的』」。現在就是「另一個內部服務」。

「內部來的」怎麼判斷？不看來源 IP（第 12 站 5.6.4 的 `X-Forwarded-For`：header 說的話，要看是誰說的），看**它能不能證明自己是誰**。服務之間的每一個請求本來就帶著一個服務 token（第 03 章 3.6），簽章、到期、發給誰，`ServiceTokens` 都驗得了：

```java
    /** 13 站 7.5：/internal/**，而且 Authorization 是一個發給我的服務 token */
    static boolean fromOurService(HttpServletRequest req, ServiceTokens tokens) {
        if (tokens == null || !req.getRequestURI().startsWith("/internal/")) return false;
        String auth = req.getHeader("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) return false;
        try {
            tokens.decoder().decode(auth.substring("Bearer ".length()));
            return true;
        } catch (org.springframework.security.oauth2.jwt.JwtException invalid) {
            return false;
        }
    }
```

```java
    @Bean
    FilterRegistrationBean<OncePerRequestFilter> dropIncomingTraceHeaders(ObjectProvider<ServiceTokens> serviceTokens) {
        ServiceTokens tokens = serviceTokens.getIfAvailable();
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
                if (fromOurService(req, tokens)) {
                    chain.doFilter(req, res);
                    return;
```

兩個條件都要：

- **`/internal/**`**：使用者的 API 不收，就算帶著服務的 token。
- **一個發給我的服務 token**：使用者的 token、別的服務的 token、過期的，都不算。

這個 filter 排在 Spring Security 前面（它要在 Micrometer 的觀測 filter 讀 header 之前決定），所以 token 在這裡驗一次、Spring Security 再驗一次。HS256 的驗證在記憶體裡做，這一章沒有量它的成本。

單體沒有 `ServiceTokens`（它只在兩個服務的角色裡），`tokens` 是 null，一律不收，跟第 12 站一樣。驗收 Q7 的第 ⑤ 段（外面帶進來的不收）照樣過。

`InternalTraceparentTest` 用庫存服務的角色起來，五種請求都帶同一個 `traceparent`：

```
13 站 7.5：訂單服務的 token → 200 X-Trace-Id 4bf92f3577b34da6a3ce929d0e0e4736
13 站 7.5：使用者的 token → 401 X-Trace-Id f68072b2789b2a1e1934e5e9184e13ed
13 站 7.5：沒有 token → 401 X-Trace-Id 56a050f9f129b33bbe5032e96170231e
13 站 7.5：給 order-service 的 token → 401 X-Trace-Id b9ea5f1740430df636f81eb9e2339687
13 站 7.5：/api/**、服務的 token → 404 X-Trace-Id 5f1971429e1bee16c041292b5b589f94
```

只有第一種接上了。其他四種回應的 `X-Trace-Id` 都是新的。

> 📌 **這個測試要 `@AutoConfigureObservability`。** `@SpringBootTest` 預設把追蹤的傳遞關掉：propagator 是一個什麼都不做的 `NoopTextMapPropagator`（7.6.6）。不加，traceparent 不會被讀，第一種請求也接不上（推論，沒有拿掉它實際跑過）。

---

## 7.6 MQ：traceparent 跟著 outbox 走

### 7.6.1 只有 traceId 不夠

第 12 站 9.8.3 的做法：outbox 存 `trace_id`，relay 放在 header `traceId`，消費者 `continueTrace(traceId)` —— 同一個 traceId、**編一個 parent 的 spanId**。7.2.3 的結果：

- 日誌接得上（第 12 站 Q7 要的就是這個）。
- span 的 parent 不存在：後端畫不出這棵樹。
- 沒有旗標：Brave 在消費者那裡重新抽一次。7.2.4 的 21 個庫存服務消費者的 span 裡，跟回呼的 span 同時在的只有 2 個。

要讓消費者接在**寫這一筆事件的那一個 span** 底下，outbox 要記住它：完整的 W3C `traceparent`（`00-traceId-spanId-旗標`），不只 traceId。

### 7.6.2 outbox 多一欄

```sql
-- 13 站 7.6：寫這一筆事件的那一個 span（W3C traceparent：00-<traceId>-<spanId>-<旗標>，55 個字元）。
-- trace_id（V8）只有 traceId：消費者只能編一個不存在的 parent、自己重新決定要不要抽樣（7.2）。有了它，消費者接在真的 parent 底下，抽樣也照它。
-- NULL：這一欄出現之前寫的事件；寫的時候沒有 span 的（例如直接呼叫 Service、不經過 HTTP 的測試）。一句 DDL、ALGORITHM=INSTANT（同 V13、V14）。
ALTER TABLE outbox_events ADD COLUMN traceparent VARCHAR(55) NULL, ALGORITHM=INSTANT;
```

寫入的時候，用 HTTP 送出時同一個 `Propagator` 寫，不自己拼字串：

```java
        jdbc.update("""
                INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, traceparent)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                eventId, aggregateType, aggregateId, eventType, body, MDC.get("traceId"), traceparent());   // traceId：第 09 章才有人放進 MDC
        return eventId;
    }
```

### 7.6.3 relay 與消費者

relay 兩個 header 都送：

```java
        if (r.traceId() != null) p.setHeader("traceId", r.traceId());       // 9.8：還沒換版的消費者讀這一個
        if (r.traceparent() != null) p.setHeader("traceparent", r.traceparent());   // 13 站 7.6：寫這一筆的那一個 span（W3C），消費者接在它底下
```

消費者有 `traceparent` 就用同一個 `Propagator` 解開：

```java
    /**
     * 13 站 7.6：訊息帶著 traceparent（寫 outbox 的那一個 span，JdbcOutbox）→ 用 HTTP 收的那一個 Propagator 解開，接在它底下：
     * parent 是真的 span、抽樣照它的旗標。沒有 traceparent（7.6 之前寫的事件還在佇列裡）→ ① 的舊路
     */
    public <T> T continueFrom(String traceparent, String traceId, String name, Supplier<T> work) {
        if (traceparent == null) return continueTrace(traceId, name, work);
        Span span = propagator.extract(Map.of("traceparent", traceparent), Map::get).name(name).kind(Span.Kind.CONSUMER).start();
        return inScope(span, work);
    }
```

span 的 kind 是 CONSUMER，parent 是寫 outbox 的那一個 span（多半是 HTTP 請求的 server span），抽樣照它的旗標：

- 那一次請求被抽到了，它的事件的消費者也被抽到。
- 沒抽到，也一起沒抽到。

**不會只送一半。** 消費者又寫了下一個事件（例如庫存服務確認預留之後寫 `inventory.stock-changed`），那一筆的 `traceparent` 是消費者的 span，鏈就一路接下去。7.7 的樹上，`consume catalog.stock-levels` 掛在庫存服務的 server span 底下，就是這樣來的。

### 7.6.4 ⚠️ 舊的訊息：先是例外，再是一個新的 traceId

沒有 `traceparent` 的訊息還是會出現：**換版的那一刻**，舊版寫進 outbox、舊版 relay 送出去的事件，可能還在佇列裡，被新版的消費者收到。它們走 `continueTrace(traceId)` 的舊路。第 12 站的寫法不改，這條路在 OpenTelemetry 上會壞在兩個地方：

**第一個：NullPointerException。** 只換實作、不改這條路，`EventFlowTest` 紅 4 個（等不到消費者做完），日誌裡這個例外一共 192 次：

```
Caused by: java.lang.NullPointerException: Cannot invoke "java.lang.Boolean.booleanValue()" because "this.sampled" is null
	at io.micrometer.tracing.otel.bridge.OtelTraceContextBuilder.build(OtelTraceContextBuilder.java:74)
	at com.example.shop.shared.observability.Traces.continueTrace(Traces.java:52)
```

第 12 站用 `tracer.traceContextBuilder()` 組 parent，沒有給 sampled：Brave 可以，OpenTelemetry 的版本一定要。例外在 `continueTrace` 裡、`handle()` 之前丟出，第 12 站 7.5 的重試階梯接不到它；container 不重新排隊（`setDefaultRequeueRejected(false)`），主佇列也沒有死信交換器 —— **訊息被丟掉了**，每一次例外就是一則。換版那一刻還在佇列裡的舊事件，就這樣不見。

**第二個：traceId 變了。** 補上 `sampled(false)`，不丟例外了，但消費者拿到的是一個**新的** traceId。Micrometer 1.2 的 `OtelTraceContextBuilder.build()` 做出來的 parent 不帶 span，`setParent` 之後 OpenTelemetry 拿的是「現在的 Context」—— 消費者的執行緒上什麼都沒有，等於沒有 parent。

修法：把「只有 traceId」也組成一個 traceparent（parent 的 spanId 照舊是編的、旗標 00），交給同一個 `Propagator`：

```java
    public <T> T continueTrace(String traceId, String name, Supplier<T> work) {
        Span span;
        if (traceId != null && TRACE_ID.matcher(traceId).matches()) {
            String parent = "00-" + (traceId.length() == 16 ? "0".repeat(16) + traceId : traceId)        // W3C：64 位元的 traceId 左邊補 0
                    + "-" + String.format("%016x", ThreadLocalRandom.current().nextLong(1, Long.MAX_VALUE)) + "-00";
            span = propagator.extract(Map.of("traceparent", parent), Map::get).name(name).kind(Span.Kind.CONSUMER).start();
        } else {
            span = tracer.nextSpan().name(name).start();
        }
        return inScope(span, work);
    }
```

旗標 00：日誌照樣是同一個 traceId（Q7 ③ 要的），但不送出一個 parent 不存在的 span。

### 7.6.5 測試

`OutboxTraceparentTest`：真的 relay、真的 RabbitMQ、真的消費者，打開追蹤、抽樣 100%，送出去的 span 收在一個 `SpanProcessor` 裡。

```
13 站 7.6：outbox traceparent 00-4709df42974099dd2355206f97eb6c4e-7adce97fbb6a12ba-01 → 消費者 [consume inventory.hot-settlement（parent 7adce97fbb6a12ba）, consume notification.order-events（parent 7adce97fbb6a12ba）]
13 站 7.6：只有 trace_id 的舊事件 → 寄信那一行的 traceId [0af7651916cd43dd8448eb211c80319c]
```

| 測試 | 守什麼 |
|---|---|
| `eventsCarryTheirParent` | outbox 的 `traceparent` 是寫它的那一個 span；兩個消費者的 parent 都是它；寫它的交易借的連線，也是它的子 span（7.7.2） |
| `notSampledStaysNotSampled` | 旗標 00 的事件，消費者照樣處理，一個 span 都不送 |
| `oldEventsStillFlow` | 只有 `trace_id` 的舊事件：照樣處理、寄信那一行的 traceId 是同一個、不送 span |
| `connectionSpansOnlyInsideATrace` | 7.7.2 |

在兩個服務上看：H1 在這一章最後的程式碼上，7.2.3 的同一張付款（`acquired` 事件的行省略）：

```
═══ 7.2 ② 付款 → order.paid → 兩個服務的消費者（load { 5.72 6.05 6.01 }）═══
  金流回呼 200，X-Trace-Id bdaba6589e2c5be7a84115575d68a93e
  這個 traceId：
    trace bdaba6589e2c5be7a84115575d68a93e：13 個 span，第一個開始到最後一個結束 44.5 ms
         +0.0 ms       16.3 ms  [order-service] http post /api/payments/callback SERVER  exception=none status=200 uri=/api/payments/callback
         +4.6 ms       10.7 ms    [order-service] db connection INTERNAL
        +34.6 ms       10.0 ms    [order-service] consume notification.order-events CONSUMER
        +35.0 ms        2.5 ms      [order-service] db connection INTERNAL
        +37.6 ms        0.4 ms      [order-service] db connection INTERNAL
        +38.0 ms        1.4 ms      [order-service] db connection INTERNAL
        +39.4 ms        1.4 ms      [order-service] db connection INTERNAL
        +40.9 ms        1.0 ms      [order-service] db connection INTERNAL
        +41.9 ms        0.2 ms      [order-service] db connection INTERNAL
        +42.2 ms        1.2 ms      [order-service] db connection INTERNAL
        +43.4 ms        1.1 ms      [order-service] db connection INTERNAL
        +34.6 ms        4.7 ms    [inventory-service] consume inventory.order-events CONSUMER
        +34.9 ms        3.7 ms      [inventory-service] db connection INTERNAL
  同一段時間裡的其他 trace：1 個（另外 1 個是排程的一輪，不印）
    trace 41c674c330b4987f5e02bc13c223cdcd：2 個 span，第一個開始到最後一個結束 24.8 ms
         +0.0 ms       24.8 ms  [order-service] http post /api/orders/{orderNo}/payments SERVER  exception=none status=201 uri=/api/orders/{orderNo}/payments
         +3.0 ms       19.6 ms    [order-service] db connection INTERNAL
```

兩個消費者 —— 訂單服務寄信、庫存服務確認預留 —— 都掛在金流回呼的 server span 底下，在同一棵樹裡。7.2.3 是三段接不起來的 span。

### 7.6.6 ⚠️ 大部分的測試走的是舊路

用 `@SpringBootTest` 起的測試，outbox 寫入的那一刻**有 span**，`traceparent` 卻是 null。原因跟 7.5 的 📌 一樣：`@SpringBootTest` 把傳遞關掉了，`Propagator.inject` 什麼都不寫。

所以用 `@SpringBootTest` 起、又有事件流過的測試（`EventFlowTest` 是其中之一），事件走的全部是舊路；新路只有加了 `@AutoConfigureObservability` 的那兩個測試，以及用 `SpringApplicationBuilder` 起應用程式的（驗收測試、實驗）在走。這不是壞事 —— 舊路本來就要能用 —— 但要知道：**一個測試綠了，不代表它走過你以為的那一條路。**

### 7.6.7 換版的順序與契約

| | 舊版的消費者 | 新版的消費者 |
|---|---|---|
| 舊版 relay 送的（只有 `traceId`） | 第 12 站的樣子 | 舊路：同一個 traceId、不送 span（7.6.4） |
| 新版 relay 送的（兩個都有） | 讀 `traceId`，不認得 `traceparent` | 新路 |

四種組合都能處理，所以兩個服務誰先換版都可以。V34 是加一個可以是 NULL 的欄位（`ALGORITHM=INSTANT`），舊版照樣寫得進去。

`traceparent` 跟第 06 章的 `Shop-Budget-Ms` 一樣，是一個「可以沒有」的 header：事件的契約（第 03 章 3.8.6 的 message pact）比的是 payload，不管它。failsafe 那一段照樣是 39 個。

---

## 7.7 從一條 trace 找出誰慢了

7.3～7.6 之後，一張下單的 span 接成了一棵樹。但樹上只有 Boot 自己會開的那幾種：HTTP 的 server span、`RestClient` 的 client span、消費者。6.14 問的四件事 ——

1. 訂單服務自己的交易
2. 等庫存服務的連線（HTTP）
3. 庫存服務的連線池
4. 熔斷器擋掉了

—— 只有第 2 件看得到。這一節補上另外三件需要的 span，再用 H1 把每一種「慢」做一次，看 trace 指不指得出來。

### 7.7.1 每一次呼叫一個 span：`shop.remote.call`

訂單服務打庫存服務的每一次呼叫（第 06 章的四道保護都在 `RemoteInventoryApi.call()` 裡），包成一個觀測：

```java
    /** 13 站 7.7：一次呼叫的結果（shop.remote.call 的 outcome）、送了幾次 */
    private static final class Result {
        String outcome = "error";
        int attempts;
    }
```

```java
    /**
     * 13 站 7.7：每一次呼叫一個觀測 shop.remote.call —— 一個 span（「inventory reserve」）＋ 一個計時器（shop_remote_call_seconds{service, op, outcome}）。
     * 每一次送出是它底下的一個 HTTP client span（Boot 的 RestClient.Builder 自己會開）。trace 上看得出：送了幾次、每一次等多久，
     * 還是根本沒有送出去（outcome = bulkhead、breaker、budget：這個 span 底下沒有 HTTP 的 span）。
     * 業務的結果（庫存不足、狀態不對）不標成錯誤：搶購時一半的人買不到，那不是庫存服務出事（6.7.2 的同一個理由）
     */
    private <T> T call(String op, Supplier<T> c) {
        Observation obs = Observation.createNotStarted("shop.remote.call", observations).contextualName("inventory " + op)
                .lowCardinalityKeyValue("service", "inventory").lowCardinalityKeyValue("op", op).start();
        Result r = new Result();
        try (Observation.Scope ignored = obs.openScope()) {
            return guarded(op, c, r);
        } catch (RuntimeException e) {
            boolean business = e instanceof InsufficientStockException || e instanceof ShopException s && s.type() == ProblemType.INVALID_STATE;
            if (!business) obs.error(e);
            throw e;
        } finally {
            obs.lowCardinalityKeyValue("outcome", r.outcome).highCardinalityKeyValue("shop.attempts", Integer.toString(r.attempts)).stop();
        }
    }
```

原本的 `call()` 改名 `guarded()`，每一條路多一行 `r.outcome = …`、送出之前 `r.attempts = attempt`（完整的 diff 在 7.13.1）。

一個 Micrometer 的觀測同時是兩樣東西：

- **一個 span**：名字是 `inventory reserve`，每一次送出（Boot 的 `RestClient` 自己開的 client span）掛在它底下。底下有幾個 HTTP 的 span，就是送了幾次；一個都沒有，就是根本沒有送出去（隔艙、熔斷器、預算）。
- **一個計時器** `shop_remote_call_seconds{service, op, outcome}`：每一種呼叫、每一種結果花多久。7.9 會說它是「原因」那一類的指標。

`outcome` 有 `ok`、`4xx`、`5xx`、`no_response`、`bulkhead`、`breaker`、`budget` 七種，再加上預設的 `error`（解不開回應那一種：我們自己的錯，第 06 章 `guarded()` 最後那個 catch）。庫存不足（409）不標成錯誤：搶購時一半的人買不到，那不是庫存服務出事（第 06 章 6.7.2 的同一個理由）。`RemoteInventoryResilienceTest` 多一個測試把四種結果釘住：

```
13 站 7.7：shop.remote.call [inventory reserve outcome=ok attempts=1 error=-, inventory reserve outcome=4xx attempts=1 error=-, inventory reserve outcome=no_response attempts=2 error=ShopException, inventory reserve outcome=breaker attempts=0 error=ShopException, inventory reserve outcome=breaker attempts=0 error=ShopException]
```

（第五筆是 7.7.5 的 `ensureReservable()` 留下的。）

### 7.7.2 借連線：`db connection`

「訂單服務自己的交易」與「庫存服務的連線池」，都是資料庫連線的事。一個交易借一條連線、做完還回去，所以一個從 `getConnection()` 到 `close()` 的 span 就同時回答兩件事：

- **span 的長度** = 這個交易拿著連線多久。
- **開頭到 `acquired` 事件** = 在連線池裡等了多久（第 06 章 6.3 ② 的那一種「等」）。

```java
package com.example.shop.shared.observability;

import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import org.aopalliance.intercept.MethodInterceptor;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 13 站 7.7：借資料庫連線的 span「db connection」—— 從 getConnection() 到 close()（還回連線池）。
 * 一個交易借一條、做完還回去，所以：
 *   span 的長度         = 這一段拿著連線多久（訂單服務自己的交易、庫存服務的預留交易）
 *   開頭到 acquired 事件 = 在連線池裡等了多久（6.3 ② 的那一種「等」）
 * 這兩個是 6.14 問的「慢在哪一段」裡，HTTP 的 span 看不到的兩段。
 *
 * 只在已經有一個 span 的時候開（請求、消費者、排程的一輪）：relay 每 100 ms 借一次連線、沒有 trace —— 不能每一次都變成一個新的 trace。
 * 包法是 Spring AOP 的子類別代理（proxyTargetClass）：bean 還是一個 HikariDataSource（第 12 站的 E7、H6 把它轉型成 HikariDataSource 讀連線池）。
 * 每一句 SQL 一個 span 的做法也有現成的套件；這裡只要連線 —— 一個交易一個 span。
 */
@Component
class TracedDataSource implements BeanPostProcessor {

    private final ObjectProvider<Tracer> tracer;

    TracedDataSource(ObjectProvider<Tracer> tracer) { this.tracer = tracer; }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (!(bean instanceof DataSource)) return bean;
        ProxyFactory f = new ProxyFactory(bean);
        f.setProxyTargetClass(true);
        f.addAdvice((MethodInterceptor) inv -> {
            Tracer t = tracer.getIfAvailable();
            if (!inv.getMethod().getName().equals("getConnection") || t == null || t.currentSpan() == null) return inv.proceed();
            Span span = t.nextSpan().name("db connection").start();
            try {
                Connection c = (Connection) inv.proceed();
                span.event("acquired");
                return returning(c, span);
            } catch (Throwable e) {
                span.error(e);
                span.end();
                throw e;
            }
        });
        return f.getProxy();
    }

    /** 同一條連線，close()（還回連線池）的時候結束 span —— 只結束一次 */
    static Connection returning(Connection c, Span span) {
        AtomicBoolean ended = new AtomicBoolean();
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (proxy, m, args) -> {
            switch (m.getName()) {
                case "equals": return proxy == args[0];
                case "hashCode": return System.identityHashCode(proxy);
                case "close": if (ended.compareAndSet(false, true)) span.end(); break;
                default: break;
            }
            try {
                return m.invoke(c, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        });
    }
}
```

三個決定：

- **只在已經有 span 的時候開。** relay 每 100 ms 借一次連線（第 12 站 7.4.2），它的執行緒上沒有 trace。不設這個條件，每一次都會變成一個新的 trace —— 一秒十個沒有人要看的 trace。`OutboxTraceparentTest` 的第四個測試守住它：所有收到的 `db connection` 都有 parent。
- **bean 還是一個 `HikariDataSource`。** Spring AOP 的子類別代理（`proxyTargetClass`），不是包一層別的類別。第 12 站有兩個實驗把 DataSource 轉型成 `HikariDataSource` 讀連線池；HikariCP 5.0.1 的這個類別沒有 final 方法，每一個呼叫都轉得過去。
- **一個交易一個 span，不是一句 SQL 一個。** 每一句 SQL 一個 span 的做法有現成的套件；這裡要的只是「誰拿著連線多久」。即使這樣，H1 那一張正常的下單，22 個 span 裡 15 個是 `db connection`（7.8 的成本）。

📌 這些 span 也照出一件第 12 站看不到的事：**通知的消費者處理一次付款，借了 8 次連線**（7.6.5 的那一張付款）。`NotificationHandler` 不在交易裡（`transactional() = false`，第 12 站 7.7.2），`JdbcTemplate` 每一句 SQL 各借一次、各還一次。它不慢，但這是一個「看得到之前不知道」的例子。這一章沒有改它。

### 7.7.3 self time：時間花在哪裡

一棵樹有二十幾個 span，用眼睛看「誰最慢」不一定準：父 span 的長度包含了子 span。實驗用的是 **self time**：每一個 span 的長度，扣掉它的子 span 蓋住的部分。

```java
    /**
     * 13 站 7.7：買家等的那一段（根 span 開始到結束），時間花在哪裡。每一個 span 的 self time = 它的長度 − 子 span 蓋住的部分
     * （client span 的 self time 是「送出去到收到回應」裡、對方的 server span 沒有蓋到的：網路、對方的 Tomcat 佇列、回應在路上）。
     * db connection 拆成兩段：開頭到 acquired 事件是「等連線」，之後是「拿著連線」（交易做多久）。根結束之後的（消費者）不算：買家沒有在等它們
     */
    public static List<Part> selfTimes(String traceId) {
        List<Rec> spans = of(traceId).stream().filter(x -> !security(x)).toList();
        Rec root = spans.stream().filter(x -> x.parentId() == null).findFirst().orElse(null);
        if (root == null) return List.of();
        long end = root.endMicros();
        List<Part> parts = new ArrayList<>();
        for (Rec x : spans) {
            if (x.startMicros() >= end) continue;
            long xEnd = Math.min(x.endMicros(), end);
            List<long[]> covered = new ArrayList<>();
            for (Rec c : spans)
                if (x.spanId().equals(c.parentId()))
                    covered.add(new long[]{Math.max(c.startMicros(), x.startMicros()), Math.min(c.endMicros(), xEnd)});
            long self = (xEnd - x.startMicros()) - union(covered);
            String label = x.name() + (x.kind().equals("CLIENT") && x.tags().containsKey("uri") ? " " + x.tags().get("uri") + "（client：送出去到收到回應）" : "");
            if (x.name().equals("db connection")) {
                double wait = x.events().stream().filter(e -> e.endsWith(" acquired")).mapToDouble(e -> Double.parseDouble(e.substring(0, e.indexOf(" ms")))).findFirst().orElse(0);
                parts.add(new Part(x.service(), "db connection：等連線", wait));
                parts.add(new Part(x.service(), "db connection：拿著連線", self / 1000.0 - wait));
            } else {
                parts.add(new Part(x.service(), label, self / 1000.0));
            }
        }
        // 同一個服務、同一段的加起來（一張下單借好幾次連線）
        java.util.Map<String, Part> sum = new java.util.LinkedHashMap<>();
        for (Part p : parts) sum.merge(p.service() + "|" + p.what(), p, (a, b) -> new Part(a.service(), a.what(), a.ms() + b.ms()));
        return sum.values().stream().sorted(Comparator.comparingDouble(Part::ms).reversed()).toList();
    }
```

兩個細節：

- **client span 的 self time**：送出去到收到回應之間，對方的 server span 沒有蓋到的部分 —— 網路、對方的 Tomcat 佇列、回應在路上。第 06 章 6.4.4 說「請求在路上、在對方的佇列裡等的時間，對方不知道」；trace 上它是看得到的：client 與 server 兩個 span 的長度差。
- **只算根 span 結束之前的**：消費者在回應之後才跑，買家沒有在等它們。

新版的 Jaeger 網頁會標出 critical path，想法類似（沒有拿它跟這裡的算法對照過）；這裡自己算，是為了讓實驗的輸出是一行字。

### 7.7.4 五張慢的下單

H1 在這一章最後的程式碼上。編號跟實驗的輸出一樣：①、③ 是 7.2 的那兩張，④～⑥ 是這一章加的。

```bash
mvn test -Pexperiments -Dtest=H1SlowOrderTraceTest
```

**① 6.2 的 6 秒**（第 06 章之前的設定：read 3 秒、最多送 2 次）：

```
═══ 7.2 ① 一張慢的下單：庫存服務做完預留、回應晚 3 秒（load { 4.78 5.88 5.95 }）═══
  回應 503（6,043 ms），X-Trace-Id a094448d1cd6113fb78326cb08cf9d4b
  這個 traceId：
    trace a094448d1cd6113fb78326cb08cf9d4b：16 個 span，第一個開始到最後一個結束 6,042.8 ms
         +0.0 ms     6042.8 ms  [order-service] http post /api/orders SERVER  exception=none status=503 uri=/api/orders
         +3.6 ms        1.1 ms    [order-service] db connection INTERNAL
         +4.9 ms        4.9 ms    [order-service] db connection INTERNAL
        +10.0 ms        4.3 ms    [order-service] db connection INTERNAL
        +14.5 ms        6.8 ms    [order-service] db connection INTERNAL
        +21.5 ms        0.6 ms    [order-service] db connection INTERNAL
        +22.1 ms        0.6 ms    [order-service] db connection INTERNAL
        +23.0 ms     6012.2 ms    [order-service] inventory reserve INTERNAL  ERROR  shop.attempts=2
        +23.4 ms     3006.7 ms      [order-service] http put CLIENT  ERROR  exception=ResourceAccessException status=CLIENT_ERROR uri=/internal/inventory/v1/reservations/{orderId}
        +26.6 ms       13.8 ms        [inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
        +28.9 ms       10.8 ms          [inventory-service] db connection INTERNAL
       +151.8 ms        8.8 ms          [order-service] consume catalog.stock-levels CONSUMER
       +152.1 ms        8.3 ms            [order-service] db connection INTERNAL
      +3032.7 ms     3001.5 ms      [order-service] http put CLIENT  ERROR  exception=ResourceAccessException status=CLIENT_ERROR uri=/internal/inventory/v1/reservations/{orderId}
      +3035.9 ms       21.0 ms        [inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
      +3046.3 ms       10.0 ms          [inventory-service] db connection INTERNAL
  同一段時間裡的其他 trace：0 個（另外 4 個是排程的一輪，不印）
  庫存服務 │ PUT /internal/inventory/v1/reservations/22 │ 收到的 traceparent=00-a094448d1cd6113fb78326cb08cf9d4b-474670798827ea0a-01 │ 日誌用的 traceId a094448d1cd6113fb78326cb08cf9d4b
  庫存服務 │ PUT /internal/inventory/v1/reservations/22 │ 收到的 traceparent=00-a094448d1cd6113fb78326cb08cf9d4b-e3b691bd4b85592c-01 │ 日誌用的 traceId a094448d1cd6113fb78326cb08cf9d4b
  買家等了 6,042.8 ms，花在：[order-service] http put /internal/inventory/v1/reservations/{orderId}（client：送出去到收到回應） 5,973.4 ms；[order-service] db connection：拿著連線 26.0 ms；[inventory-service] db connection：拿著連線 19.4 ms
```

（`acquired`、`exception` 這兩種事件的行省略。）

7.2.2 的同一張下單，現在是**一棵樹**：兩次 `http put`（client，各等 3 秒），各自底下掛著庫存服務的 server span（13.8 ms、21.0 ms），以及它借的連線。self time 的第一名是 client span：**庫存服務做完了，3 秒花在回應回來的路上。** 6.2 的那 6 秒，是兩次「對方早就做完、我還在等」。

（`LostResponse` 讓回應在處理完之後才送，是實驗做出來的；真實的世界裡，這個形狀對應的是網路、或對方的 Tomcat 佇列：client 很長、server 很短。）

**③ 第 06 章的設定**：一樣的形狀，兩次 client span 加起來是 2 秒的預算（1,004.0 ms、979.4 ms）。

**④ 庫存服務的連線池**：每個預留交易 +300 ms、庫存服務的連線池縮成 4 條，6 張同時送：

```
═══ 7.7 ④ 庫存服務的連線池：每個預留交易 +300 ms、連線池 4 條，6 張同時送（load { 5.15 5.90 5.96 }）═══
  6 張：[201（386 ms）, 201（678 ms）, 201（387 ms）, 201（679 ms）, 201（386 ms）, 201（387 ms）]
  最慢的一張 201（679 ms），X-Trace-Id 482bf2720f1a144a2cc9cdb8540fb25b
    trace 482bf2720f1a144a2cc9cdb8540fb25b：22 個 span，第一個開始到最後一個結束 787.0 ms
         +0.0 ms      676.4 ms  [order-service] http post /api/orders SERVER  exception=none status=201 uri=/api/orders
        +15.3 ms        1.1 ms    [order-service] db connection INTERNAL
        +16.5 ms        7.2 ms    [order-service] db connection INTERNAL
        +23.8 ms       11.3 ms    [order-service] db connection INTERNAL
        +35.4 ms        8.4 ms    [order-service] db connection INTERNAL
        +43.9 ms        0.5 ms    [order-service] db connection INTERNAL
        +44.5 ms        0.4 ms    [order-service] db connection INTERNAL
        +45.0 ms      623.0 ms    [order-service] inventory reserve INTERNAL  shop.attempts=1
        +45.2 ms      622.7 ms      [order-service] http put CLIENT  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
        +47.0 ms      620.3 ms        [inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
        +47.9 ms      619.1 ms          [inventory-service] db connection INTERNAL
       +784.3 ms        2.6 ms          [order-service] consume catalog.stock-levels CONSUMER
       +784.5 ms        2.4 ms            [order-service] db connection INTERNAL
       +668.0 ms        4.7 ms    [order-service] db connection INTERNAL
       +672.8 ms        3.1 ms    [order-service] db connection INTERNAL
       +693.4 ms        5.9 ms    [order-service] consume notification.order-events CONSUMER
       +693.5 ms        2.0 ms      [order-service] db connection INTERNAL
       +695.6 ms        0.3 ms      [order-service] db connection INTERNAL
       +695.9 ms        1.8 ms      [order-service] db connection INTERNAL
       +697.7 ms        1.4 ms      [order-service] db connection INTERNAL
       +775.0 ms        2.3 ms    [inventory-service] consume inventory.hot-settlement CONSUMER
       +775.2 ms        2.1 ms      [inventory-service] db connection INTERNAL
  買家等了 676.4 ms，花在：[inventory-service] db connection：拿著連線 310.3 ms；[inventory-service] db connection：等連線 308.8 ms；[order-service] db connection：拿著連線 26.7 ms
```

庫存服務的那一個 `db connection` 開始之後 308.8 ms 才 `acquired`：**等連線**。self time 的前兩名都在庫存服務，一個是等連線、一個是拿著連線（那 300 ms）。

**⑤ 訂單服務自己的交易**：訂單服務的 `INSERT INTO orders` +800 ms：

```
═══ 7.7 ⑤ 訂單服務自己的交易：INSERT INTO orders +800 ms（load { 5.15 5.90 5.96 }）═══
  回應 201（878 ms），X-Trace-Id 56f9dcb76ac06686a7c4316dea8ab56d
    trace 56f9dcb76ac06686a7c4316dea8ab56d：22 個 span，第一個開始到最後一個結束 907.5 ms
         +0.0 ms      872.5 ms  [order-service] http post /api/orders SERVER  exception=none status=201 uri=/api/orders
         +9.5 ms        1.7 ms    [order-service] db connection INTERNAL
        +11.6 ms        5.6 ms    [order-service] db connection INTERNAL
        +17.4 ms        6.1 ms    [order-service] db connection INTERNAL
        +23.6 ms      818.8 ms    [order-service] db connection INTERNAL
       +842.7 ms        1.3 ms    [order-service] db connection INTERNAL
       +844.1 ms        0.9 ms    [order-service] db connection INTERNAL
       +845.3 ms       15.5 ms    [order-service] inventory reserve INTERNAL  shop.attempts=1
       +846.0 ms       14.6 ms      [order-service] http put CLIENT  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
       +848.5 ms       11.5 ms        [inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
       +850.7 ms        8.9 ms          [inventory-service] db connection INTERNAL
       +900.1 ms        4.9 ms          [order-service] consume catalog.stock-levels CONSUMER
       +900.3 ms        4.7 ms            [order-service] db connection INTERNAL
       +860.9 ms        6.8 ms    [order-service] db connection INTERNAL
       +867.8 ms        4.2 ms    [order-service] db connection INTERNAL
       +898.9 ms        5.3 ms    [inventory-service] consume inventory.hot-settlement CONSUMER
       +899.2 ms        5.0 ms      [inventory-service] db connection INTERNAL
       +898.9 ms        8.5 ms    [order-service] consume notification.order-events CONSUMER
       +899.2 ms        3.5 ms      [order-service] db connection INTERNAL
       +902.8 ms        0.5 ms      [order-service] db connection INTERNAL
       +903.4 ms        2.4 ms      [order-service] db connection INTERNAL
       +905.8 ms        1.6 ms      [order-service] db connection INTERNAL
  買家等了 872.5 ms，花在：[order-service] db connection：拿著連線 844.6 ms；[order-service] http post /api/orders 11.6 ms；[inventory-service] db connection：拿著連線 8.0 ms
```

第四個 `db connection`（T1，寫下 RESERVING 的那一個交易）818.8 ms。庫存服務那一段（server span）11.5 ms，跟它無關。

**⑥ 熔斷器擋掉了**：

```
═══ 7.7 ⑥ 熔斷器開著：20 張同時送、每一次預留都晚 3 秒回應（load { 5.14 5.89 5.95 }）═══
  20 張：{503=20}；熔斷器 open
  下一張 503（13 ms）「庫存服務暫時無法使用」，X-Trace-Id e9b6380cab931fadaf969e280b461a92
    trace e9b6380cab931fadaf969e280b461a92：6 個 span，第一個開始到最後一個結束 12.7 ms
         +0.0 ms       12.7 ms  [order-service] http post /api/orders SERVER  exception=none status=503 uri=/api/orders
         +2.4 ms        1.1 ms    [order-service] db connection INTERNAL
         +3.7 ms        2.3 ms    [order-service] db connection INTERNAL
         +6.1 ms        2.6 ms    [order-service] db connection INTERNAL
         +9.0 ms        0.3 ms    [order-service] inventory reserve INTERNAL  ERROR  shop.attempts=0
        +10.0 ms        2.1 ms    [order-service] db connection INTERNAL
  買家等了 12.7 ms，花在：[order-service] db connection：拿著連線 7.5 ms；[order-service] http post /api/orders 4.4 ms；[order-service] db connection：等連線 0.5 ms
  沒有人下單，第 10 秒：熔斷器 open
  沒有人下單，第 20 秒：熔斷器 open
  沒有人下單，第 30 秒：熔斷器 open
  第 1 張下單 201 → 熔斷器 half_open
  第 2 張下單 201 → 熔斷器 half_open
  第 3 張下單 201 → 熔斷器 closed
  第 4 張下單 201 → 熔斷器 closed
```

被擋下的那一張，樹上有一個 0.3 ms 的 `inventory reserve`：ERROR、`shop.attempts=0`、底下沒有 HTTP 的 span —— **一次都沒有送出去**。它的 `outcome` 是 breaker（低基數的標籤，上面的樹只印 `shop.` 開頭的屬性；`RemoteInventoryResilienceTest` 把它釘住）。沒有這個 span 是什麼樣子，見下一節。

整理成一張表：

| 慢在哪 | trace 上的形狀 | self time 第一名 |
|---|---|---|
| 對方做完了，回應在路上（6.2 的 6 秒） | client span 很長，底下的 server span 很短 | 訂單服務的 client span |
| 庫存服務的連線池 | 庫存服務的 `db connection`，開頭到 `acquired` 很長 | 庫存服務：等連線、拿著連線 |
| 訂單服務自己的交易 | 訂單服務的某一個 `db connection` 很長 | 訂單服務：拿著連線 |
| 熔斷器擋掉了 | `inventory reserve` 很短、ERROR、`shop.attempts=0`，底下沒有 HTTP 的 span | （很短：根本沒有等） |

### 7.7.5 ⚠️ 熔斷器擋下的那一張，trace 上什麼都沒有

如果只在 `call()` 裡開觀測，⑥ 被擋下的那一張是這樣：

```
    trace 8ab306d6319c5031cb184b194da626f6：5 個 span，第一個開始到最後一個結束 21.8 ms
         +0.0 ms       21.8 ms  [order-service] http post /api/orders SERVER  exception=none status=503 uri=/api/orders
         +8.4 ms        0.9 ms    [order-service] db connection INTERNAL
         +9.8 ms        3.1 ms    [order-service] db connection INTERNAL
        +13.1 ms        4.3 ms    [order-service] db connection INTERNAL
        +18.7 ms        2.2 ms    [order-service] db connection INTERNAL
  買家等了 21.8 ms，花在：[order-service] http post /api/orders 11.3 ms；[order-service] db connection：拿著連線 10.5 ms；[order-service] db connection：等連線 0.0 ms
```

一個 503，trace 上只有訂單服務自己的四次借連線，**看不出任何一個跟庫存服務有關的東西**。

原因是第 06 章 6.7.5 的 `ensureReservable()`：熔斷器開著的時候，下單在寫訂單之前就被它擋下，根本沒有走到 `call()`，也就沒有 `shop.remote.call`。修法是在擋下的那一刻也留一筆：

```java
    @Override
    public void ensureReservable() {
        CircuitBreaker cb = breakers.get("reserve");
        if (cb.tryAcquirePermission()) {
            cb.releasePermission();
            return;
        }
        rejected("reserve", "breaker");
        ShopException e = new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
        Observation.createNotStarted("shop.remote.call", observations).contextualName("inventory reserve")
                .lowCardinalityKeyValue("service", "inventory").lowCardinalityKeyValue("op", "reserve")
                .lowCardinalityKeyValue("outcome", "breaker").highCardinalityKeyValue("shop.attempts", "0")
                .start().error(e).stop();
        throw e;
    }
```

> 📌 **trace 只看得到你開了 span 的地方。** 「什麼都沒發生」與「被擋下了」在 trace 上長得一樣：都是空的。每一個「不做了」的決定（熔斷器、隔艙、預算、限流），都要留下一個 span 或一個事件，不然排查的人會以為那一段沒有發生。

---

## 7.8 取樣率

### 7.8.1 抽樣之後，完整的有幾個

H2 在這一章最後的程式碼上（抽樣照 `application.yml` 的 0.1）：

```bash
mvn test -Pexperiments -Dtest=H2SamplingTest
```

```
═══ 7.2 ④ 抽樣（management.tracing.sampling.probability = 0.1）：200 次「下單 → 付款」（load { 4.89 5.71 5.89 }）═══
  回應帶著 X-Trace-Id 的：200 / 200 次（下單與回呼都有）
  下單 200 次 │ 訂單服務的 span 送出去的：21 個 trace │ 同一個 trace 裡也有庫存服務的預留：21 個
             │ 庫存服務的預留 span 送出去的：21 個；自己是一個 trace 的根：0 個；traceId 是哪一張下單的：21 個
  付款 200 次 │ 回呼的 span 送出去的：18 個 │ 庫存服務消費 order.paid 的 span 送出去的：18 個（traceId 是哪一次回呼的：18 個；那一次回呼的 span 也在的：18 個）
             │ 通知的消費者 span 送出去的：39 個 │ 消費者 span 的 parent 找得到的：庫存 18 / 18、通知 39 / 39
  完整的下單 trace（訂單、庫存兩段都在、每一個 span 都接得上）：21 個；只有其中一段的：0 個
  完整的付款 trace（回呼、兩個消費者都在、每一個 span 都接得上）：18 個
  span 一共 758 個；其中 Spring Security 的 0 個、排程的 0 個
  （結束時 load { 6.86 6.16 6.04 }）
```

| 200 次「下單 → 付款」，抽樣 0.1 | 7.2.4（之前） | 之後 |
|---|---|---|
| 訂單服務的下單 span 送出去的 | 21 | 21 |
| 其中同一個 trace 裡也有庫存服務的預留 | 0 | 21 |
| 庫存服務的預留 span 是自己一個 trace 的根 | 24 | 0 |
| 回呼與庫存服務的消費者都在 | 2 | 18 |
| 消費者的 parent 找得到 | 0 | 全部 |
| 完整的下單 trace / 只有一段的 | 0 / 21 | 21 / 0 |
| 完整的付款 trace | 0 | 18 |
| span 一共（其中 Spring Security） | 622（419） | 758（0） |

**完整的比例 ≈ 抽樣率，而且沒有「只有一半」的。** 一張下單在訂單服務的入口被決定要不要抽（沒有 parent，看 traceId），之後每一段 —— 庫存服務的 HTTP、outbox、消費者、消費者寫的下一個事件 —— 都照 traceparent 的旗標。

span 的總數比之前多（622 → 758）：Security 的 span 拿掉了，但多了 `db connection` 與 `inventory reserve`，而且之前那些各抽各的、斷掉的 span，現在是一棵一棵完整的樹。

### 7.8.2 成本

H5：兩個服務各在自己的 JVM、span 送到 Jaeger，三種抽樣率（0、0.1、1.0）各三輪、交錯；每一輪重開兩個服務（抽樣率是啟動時的設定），16 條執行緒一直送 3 個品項的下單 20 秒。

```bash
mvn test -Pexperiments -Dtest=H5SamplingCostTest
```

```
═══ 7.8 抽樣率的成本：16 條執行緒送 3 個品項的下單，每輪 20 秒；0 → 0.1 → 1.0 → 1.0 → 0.1 → 0 → 0.1 → 0 → 1.0（load { 5.99 6.08 6.02 }）═══
  抽樣 0    │ 每秒 103.3 張 │ p50 138.0 ms │ p99  395.0 ms │ 不是 201 的 0 張 │ Jaeger 收到       0 個 span（每張下單 0.0 個）│ load { 8.88 6.78 6.28 }
  抽樣 0.1  │ 每秒 130.4 張 │ p50 113.0 ms │ p99  239.0 ms │ 不是 201 的 0 張 │ Jaeger 收到   5,163 個 span（每張下單 2.0 個）│ load { 9.38 7.23 6.48 }
  抽樣 1.0  │ 每秒 135.6 張 │ p50 113.0 ms │ p99  197.0 ms │ 不是 201 的 0 張 │ Jaeger 收到  59,392 個 span（每張下單 21.9 個）│ load { 8.72 7.30 6.56 }
  抽樣 1.0  │ 每秒 131.5 張 │ p50 114.0 ms │ p99  229.0 ms │ 不是 201 的 0 張 │ Jaeger 收到  57,630 個 span（每張下單 21.9 個）│ load { 10.72 7.96 6.85 }
  抽樣 0.1  │ 每秒 126.6 張 │ p50 116.0 ms │ p99  259.0 ms │ 不是 201 的 0 張 │ Jaeger 收到   5,256 個 span（每張下單 2.1 個）│ load { 9.29 7.87 6.89 }
  抽樣 0    │ 每秒 127.9 張 │ p50 116.0 ms │ p99  233.0 ms │ 不是 201 的 0 張 │ Jaeger 收到       0 個 span（每張下單 0.0 個）│ load { 24.78 11.76 8.37 }
  抽樣 0.1  │ 每秒 128.9 張 │ p50 118.0 ms │ p99  224.0 ms │ 不是 201 的 0 張 │ Jaeger 收到   5,934 個 span（每張下單 2.3 個）│ load { 29.28 15.15 9.89 }
  抽樣 0    │ 每秒 125.3 張 │ p50 120.0 ms │ p99  258.0 ms │ 不是 201 的 0 張 │ Jaeger 收到       0 個 span（每張下單 0.0 個）│ load { 31.02 17.75 11.27 }
  抽樣 1.0  │ 每秒 112.8 張 │ p50 131.0 ms │ p99  300.0 ms │ 不是 201 的 0 張 │ Jaeger 收到  49,482 個 span（每張下單 21.9 個）│ load { 17.82 16.59 11.40 }
  三輪合起來：
  抽樣 0    │ 每秒 103 / 128 / 125 張 │ p50 122.0 ms │ p99  295.0 ms │ 每張下單 0.00 個 span │ 每秒 0 個 span
  抽樣 0.1  │ 每秒 130 / 127 / 129 張 │ p50 115.0 ms │ p99  239.0 ms │ 每張下單 2.12 個 span │ 每秒 273 個 span
  抽樣 1.0  │ 每秒 136 / 131 / 113 張 │ p50 118.0 ms │ p99  272.0 ms │ 每張下單 21.92 個 span │ 每秒 2,775 個 span
  （結束時 load { 12.45 15.43 11.16 }）
```

兩件事分開看：

- **後端收到的量：確定是 10 倍。** 抽樣 1.0，每一張下單 21.9 個 span，這個速率下每秒 2,775 個；0.1 是 2.1 個、每秒 273 個。換算到第 12 站 0.6.2 的尖峰（一般商品每秒 50 張下單），100% 就是每秒一千多個 span 要收、要存、要查（推論：只算下單，不算其他 API）。
- **應用程式這一邊的成本：這台筆電上量不出來。** 三輪的吞吐，0 是 103～128、0.1 是 127～130、1.0 是 113～136 張／秒，範圍互相重疊；0 與 1.0 各自三輪之間的差，比三種抽樣率的平均之間的差還大。同樣的實驗另外跑過一次，那一次 1.0 的三輪（116～122）都比 0 的兩輪（137、138）低；上面這一次反過來，1.0 有兩輪比 0 的三輪都高。Jaeger、Docker 的虛擬機與兩個服務在同一台機器上搶 CPU，load（一分鐘平均）在 6 到 31 之間跳。兩次的方向相反，能說的只有：**跟這台機器的雜訊比，它小到量不出來**；要量，得把後端放到另一台機器上。

### 7.8.3 怎麼選

**這一章選 0.1**（跟 Boot 的預設一樣，但寫進 `application.yml`：它是一個決定，不是一個沒人動過的預設值）：

```yaml
  tracing:
    sampling:
      # 13 站 7.8：Boot 的預設也是 0.1，寫出來是因為它是一個決定。100% 時一張下單 22 個 span、後端多 10 倍；
      # 排查一次「誰慢了」只要幾條完整的 trace（7.11：5 分鐘 19 個 exemplar 就夠）。「每一張」要找的是日誌：traceId 不抽樣
      probability: 0.1
```

（註解裡的「19 個 exemplar」是另一輪 H4 的數字；7.11 的是 20 個。）

理由是三樣東西在抽樣之下各剩下什麼：

| | 抽樣 0.1 之下 | 拿來做什麼 |
|---|---|---|
| **日誌的 traceId** | 100%：每一個請求都有（7.2.4 的 `X-Trace-Id` 200 / 200） | 「這一張」：客服、稽核、某一位買家的某一張訂單（7.10） |
| **trace** | 10%，而且是完整的（7.8.1） | 「這一類」：慢在哪一個服務的哪一段（7.7） |
| **exemplar** | 被抽到的請求裡，每一次抓指標每一個桶最多一個 | 從告警走到一條 trace（7.9.4、7.11） |

排查「誰慢了」不需要每一條 trace，需要的是**出事的那幾分鐘裡，有幾條完整的**。7.11 的演練，5 分鐘裡有 20 個 exemplar 可以挑，一條就夠了。「某一張訂單為什麼失敗」要的是那一張，那是日誌的工作。

**0.1 管不到的：出事的那幾張剛好沒被抽到。** 頭端抽樣（head-based，在入口就決定）不知道這一張之後會不會出錯、會不會很慢。要「錯的、慢的全部留下，其他的抽 10%」，得等整條 trace 都結束了再決定 —— **尾端抽樣**（tail-based）：

- 每一個服務 100% 送出，送到一個收集器（例如 OpenTelemetry Collector 的 `tail_sampling`），收集器把同一個 traceId 的 span 收齊、等一段時間（例如 10 秒），再決定留不留。
- 代價：應用程式送出的量回到 100%（7.8.2 的 10 倍）；收集器要在記憶體裡放 10 秒的全部 span；同一個 traceId 的 span 一定要送到同一台收集器，多台的時候前面還要一層依 traceId 分流。

這一章沒有做：這一站量過的事故（第 06 章的慢與重試風暴、7.11 的演練）都是「整段時間都在發生」的，10% 裡就抽得到；個別一張的錯誤，日誌找得到。等到「出事的那一張剛好沒有 trace」真的妨礙了排查，再加一個收集器。

### 7.8.4 尾端抽樣，量一次

這一節的程式碼在 `d09` 分支上，實驗要第 08、09 章的 kind 環境。7.8.3 說頭端抽樣管不到「出事的那幾張剛好沒被抽到」，要尾端抽樣；第 08 章 8.9.2 把 Collector 放到了 span 的路上，規則沒有寫。這裡寫、在 kind 上量。規則放在一份另外的 Collector 設定裡（實驗換上去、量完換回來）：

```yaml
      tail_sampling:
        decision_wait: 10s
        num_traces: 50000
        policies:
          - {name: errors, type: status_code, status_code: {status_codes: [ERROR]}}
          - {name: server-errors, type: string_attribute, string_attribute: {key: outcome, values: [SERVER_ERROR]}}
          - {name: slow, type: latency, latency: {threshold_ms: 500}}
          - {name: rest, type: probabilistic, probabilistic: {sampling_percentage: 10}}
```

前提是頭端不能先丟：入口的 `samplingRate` 從 10 改成 100、兩個服務的 `MANAGEMENT_TRACING_SAMPLING_PROBABILITY` 改成 1.0 —— 每一個 span 都送到 Collector，由它收齊同一個 traceId、等 10 秒再決定。K12 用同一個負載跑兩次（頭端、尾端），每一張下單記下回應的 `X-Trace-Id`，事後一條一條到 Jaeger 查：

```bash
mvn test -Pexperiments -Dtest=K12TailSamplingTest
```

```
═══ 7.8.4／8.9.2 尾端抽樣：每秒 10 張下單、60 秒；慢的 10%（預留 +0.6 秒）、錯的 5%（預留被拒絕）、其他 85% ═══
  ① 頭端抽樣（入口 10%，後面的服務照著它）
    其他 │  516 張 {201=516} │ Jaeger 找得到   62 條（ 12.0%）；其中請求在 500 ms 以內、整條 trace 卻超過 500 ms 的 1 條
    慢的 │   59 張 {201=52, 503=7} │ Jaeger 找得到    9 條（ 15.3%）；其中請求在 500 ms 以內、整條 trace 卻超過 500 ms 的 0 條
    錯的 │   25 張 {500=25} │ Jaeger 找得到    1 條（  4.0%）；其中請求在 500 ms 以內、整條 trace 卻超過 500 ms 的 0 條
    Jaeger 裡這幾條 trace 共 1,658 個 span；Collector 收到 1,679 個 span、送出 1,679 個；Collector 的記憶體 86 MiB
  ② 尾端抽樣（入口、服務都送 100%；Collector 的 tail_sampling：錯的、超過 500 ms 的全留，其他抽 10%）
    其他 │  512 張 {201=512} │ Jaeger 找得到   56 條（ 10.9%）；其中請求在 500 ms 以內、整條 trace 卻超過 500 ms 的 0 條
    慢的 │   56 張 {201=46, 503=10} │ Jaeger 找得到   56 條（100.0%）；其中請求在 500 ms 以內、整條 trace 卻超過 500 ms 的 0 條
    錯的 │   32 張 {500=32} │ Jaeger 找得到   32 條（100.0%）；其中請求在 500 ms 以內、整條 trace 卻超過 500 ms 的 0 條
    Jaeger 裡這幾條 trace 共 2,957 個 span；Collector 收到 13,639 個 span、送出 2,971 個；Collector 的記憶體 211 MiB
  （結束時 load { 6.60 7.66 9.23 }）
```

- **頭端抽樣：三種一樣碰運氣。** 入口在請求一進來就決定（10%），那時候不知道這一張會不會慢、會不會錯：慢的、錯的、其他的，在 Jaeger 裡各找得到 15.3%、4.0%、12.0%。7.8.3 那一句「出事的那幾張剛好沒被抽到」，量出來就是這樣：錯的 25 張只留下 1 條。
- **尾端抽樣：錯的、慢的全部留下**（32／32、56／56），其他的 10.9%（規則是 10%）。
- **代價**：Collector 收到的 span 從 1,679 個變成 13,639 個（8.1 倍：每一個服務都送 100%，7.8.2 量過應用程式的那一半），送到 Jaeger 的從 1,679 變成 2,971 個（1.8 倍：多存的就是那些錯的、慢的）；Collector 的記憶體 86 → 211 MiB（它要把每一條 trace 收齊、等 10 秒）。
- **只能一台**：同一條 trace 的 span 要落在同一台 Collector 才收得齊。要多台，前面再放一層照 traceId 分的（Collector 的 `loadbalancing` exporter）—— 這裡沒有做。
- 錯的那幾張，買家拿到的是 500，不是 503：預留被 trigger 拒絕，庫存服務回 500，訂單服務把它當成「不認得的錯誤」（`RemoteInventoryApi.decode`）—— 第 09 章 9.6.5 那一張 500 走的是同一條路。
- **決定**：k8s/observability 預設仍然是頭端（10%）。尾端的代價是每一個服務送出的 span 變成 10 倍、Collector 要有狀態；換到的是「出事的那幾張一定在」。這個專案的告警與排查（7.11）靠的是 exemplar 加上日誌（100% 有 traceId），還沒有需要；要換的那一天，是「客服拿著一個 traceId 來，Jaeger 裡找不到」的次數多到要處理的時候。

---

## 7.9 告警設在哪

第 06 章 6.9 列了一排新的指標（熔斷器的狀態、隔艙剩幾個位子、被誰擋下的呼叫、預算用完的預留、沒有回應的呼叫），沒有決定哪一個要叫醒人。這一章再多一個 `shop_remote_call_seconds`。

### 7.9.1 叫醒人的只有使用者感受得到的

告警分兩種用途：

| | 叫醒人（page） | 排查的時候看（儀表板、trace） |
|---|---|---|
| 回答的問題 | **使用者現在有沒有受影響？** | **是哪裡出了事？** |
| 量在哪裡 | 使用者的請求進來的那一層（這個系統是訂單服務的 `/api/**`） | 每一個服務、每一種呼叫 |
| 這個系統的 | 第 12 站的 `ShopHigh5xxRatio`、`ShopPlaceOrderSlow`（加上事件流、數字對不上那幾組） | 第 06 章 6.9 的那一排、`shop_remote_call_seconds`、連線池、trace |

第 06 章的那一排全部放在右欄，理由各不一樣：

- **熔斷器的狀態**：它只有在有人要求放行的時候才會從 OPEN 轉成 HALF_OPEN（6.7.5）。7.7.4 的 ⑥ 量到：熔斷器打開之後，30 秒沒有人下單，它一直是 open；第一張下單進來，它才轉成 half_open。半夜沒有人下單，「熔斷器開著」的告警就會一直響，而庫存服務早就好了（30 秒是量的；一整夜是同一個機制的推論）。

```
  沒有人下單，第 10 秒：熔斷器 open
  沒有人下單，第 20 秒：熔斷器 open
  沒有人下單，第 30 秒：熔斷器 open
  第 1 張下單 201 → 熔斷器 half_open
  第 2 張下單 201 → 熔斷器 half_open
  第 3 張下單 201 → 熔斷器 closed
  第 4 張下單 201 → 熔斷器 closed
```

- **隔艙滿了、熔斷器擋下、預算用完、沒有回應**：它們是「庫存服務有事」的訊號，但不一定是「使用者有事」：訂單服務那一次重送成功了（第 06 章 6.5.1），使用者沒有感覺。真的影響到使用者的時候，邊緣的 5xx 比例或下單的延遲就會動 —— 那兩條已經會叫醒人。
- **一個事故不要叫醒人五次。** 庫存服務慢 3 秒（6.2），隔艙滿、熔斷器開、沒有回應、5xx 比例同時都會動。如果每一個都叫醒人，值班的人收到五則訊息，說的是同一件事。

### 7.9.2 ⚠️ 第 12 站的規則寫死了 `job="shop"`

第 12 站 9.10 的 19 條規則，有 16 條長這樣：`http_server_requests_seconds_count{job="shop", …}`。`job` 是 Prometheus 抓指標時的設定（`prometheus.yml` 的 `job_name`），單體只有一個 `shop`。切開之後是兩個服務、兩個 job，例如 `order-service`、`inventory-service` —— **這 16 條就永遠不會響，而且不會有任何錯誤**（下面量了其中兩條；其餘 14 條是同一個 `job="shop"` 選擇器，推論相同）。

把第 12 站的規則拿來，餵切開之後的序列（下單 2% 是 503、outbox 卡了 10 分鐘），期望它們響：

```
  FAILED:
    alertname: ShopHigh5xxRatio, time: 10m, 
        exp:[
            0:
              Labels:{alertname="ShopHigh5xxRatio", severity="page"}
              Annotations:{}
            ], 
        got:[]
```

（第二條 `ShopOutboxBacklog` 一樣是 `got:[]`。）

規則不該寫死部署的形狀。改成認一個標籤 `system="shop"`，由 `prometheus.yml` 在抓的時候加上去：

```yaml
  - job_name: shop
    metrics_path: /actuator/prometheus
    # 13 站 7.9：system=shop —— 告警規則認這個標籤，不認 job 的名字。切開之後是兩個 job（order-service、inventory-service），同一個 system
    static_configs: [{targets: ["app:8081"], labels: {system: shop}}]   # 管理埠（9.9）：只有從這裡進來才放行
```

切開之後的兩個 job 也加同一個標籤（7.11 的演練就是這樣抓的）。規則裡的 `job="shop"` 全部換成 `system="shop"`；需要說出「是哪一個服務」的，用 `by (job)`：

```yaml
      - alert: ShopOutboxBacklog
        expr: max by (job) (shop_outbox_oldest_age_seconds{system="shop"}) > 60   # 13 站 7.9：by (job)，兩個服務各有一個 outbox
        labels: {severity: page}
        annotations:
          summary: "{{ $labels.job }}：最舊的未送出事件已經 {{ $value | humanizeDuration }}"
```

### 7.9.3 使用者的 5xx 只算 `/api/**`

`ShopHigh5xxRatio` 原本是「這個 job 的所有請求裡 5xx 的比例」。單體裡，那差不多就是使用者的請求；切開之後，庫存服務的 `/internal/**` 也在同一個 system 裡：

- 庫存服務回給訂單服務的 503，訂單服務多半也回使用者 503：**同一個失敗數兩次。**
- 訂單服務重送成功了，使用者沒有感覺，但庫存服務那一次 503 還是被算進比例：**不是使用者的失敗也算進去。**
- 分母多了服務之間的請求：一張下單在庫存服務那邊還有一到兩個請求（預留、熱點閘門），比例被稀釋。

所以只算 `uri=~"/api/.*"`：

```yaml
      - alert: ShopHigh5xxRatio
        # 9.10 J8d：只看 5 分鐘窗的話，一次 60 秒的停機在恢復之後 4 分多鐘才響、響半分鐘自己好 —— 加一個 1 分鐘窗：現在還在發生才響
        # 13 站 7.9：只算 /api/**（使用者送來的）。切開之後庫存服務的 /internal/** 也有 5xx —— 那是同一個失敗在下一層又數一次，
        #   而且訂單服務對使用者的那一個 503 已經算過了；分母也不能有它們（服務之間的呼叫不是使用者的請求）
        expr: |
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[5m]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[5m])) > 0.01)
          and
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[1m]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[1m])) > 0.01)
        for: 5m
```

`alerts_test.yml` 多兩組（⑤、⑤'）把這件事釘住：

- 訂單服務的 `/api/orders` 有 2% 是 503 → 響。
- 庫存服務的 `/internal/**` 有一半是 503，但使用者的請求全部成功 → 不響。

另外一組（⑥）：切開之後，outbox 的告警說得出是 `inventory-service`。

```
Checking alerts.yml
  SUCCESS: 19 rules found

  SUCCESS
```

### 7.9.4 exemplar：從告警走到一條 trace

告警響了，下一步是「哪一張慢了」。Prometheus 的 **exemplar** 是直方圖的桶旁邊附的一個樣本：「落在這個桶裡的某一個請求，它的 traceId 是這個」。Boot 有 tracing 的時候會自動附上（`PrometheusExemplarsAutoConfiguration`），只是有兩個條件：

- Prometheus 要用 OpenMetrics 的格式抓（v3.5 預設的抓法會先要它；7.11 的演練沒有另外設定就拿到了），而且要打開 `--enable-feature=exemplar-storage`（compose 的 Prometheus 這一章加上了，diff 在 7.13.1）。
- 只有**被抽到的**請求會變成 exemplar：exemplar 指向一條 trace，沒有被抽到的請求沒有 trace 可以指。

`/actuator/prometheus` 用 OpenMetrics 要，桶的那一行後面多了一段：

```
  ⓪ 訂單服務的 /actuator/prometheus 用 OpenMetrics 要，帶 trace_id 的第一行：http_server_requests_seconds_bucket{error="none",exception="none",method="POST",outcome="SUCCESS",status="201",uri="/api/orders",le="0.05"} 1762.0 # {span_id="fcc5b7913cff2246",trace_id="bc443188c367ef4606684e7154f73bd3"} 0.0336335 1792380516.306
```

7.11 的演練就是從這裡開始的。

### 7.9.5 第 04 章留給這一章的三個訊號

這一節的程式碼在 `d09` 分支上。第 04 章交給這一章三件事：

- 4.2.2：搶購進行中，熱點對帳一次都不修，而 `shop.inventory.hot.drift` 只在**修了**的時候加 1 ——「搶購進行中的不一致，指標上看不到」。
- 4.9：`shop.orders.rejected{reason=PLACEMENT_EXPIRED}` —— 停在 `RESERVING` 太久、被排程補償掉的下單，「沒有替它設告警的門檻」。
- 4.6.3：`shop.inventory.consume.conflict` —— 已經出貨的訂單，它的預留卻已經釋放（計數器自己的說明：「正常應該永遠是 0，發生了要有人看」）。

照 7.9.1 的分法，三個都是**原因**，不是使用者此刻感受得到的：PLACEMENT_EXPIRED 的那幾張，買家當時已經拿到 503（`ShopHigh5xxRatio` 算過了）；少賣的那一件，搶購結束之後一兩分鐘才被放出來；出貨的衝突要有人去倉庫看。所以三條都是 `ticket`，不叫醒人：

```yaml
      - alert: ShopHotStockMismatchPersistent
        # 13 站 7.9.5（第 04 章 4.2.2 留給第 07 章的那一條）：搶購進行中，熱點對帳一次都不修 ——
        #   「連續兩輪看到同一組」永遠不成立，上面那一條（修了才加 1）也就不會響。這一條看「每一輪都有對不上的」：15 分鐘裡每一分鐘的最小值都 > 0。
        #   一張訂單從閘門到落帳的那幾百毫秒裡本來就對不上，所以只要有某一輪對上了，就不響；一場一直有人在買、每一輪都剛好有訂單在路上的搶購，會誤報（推論，沒有量）
        expr: min_over_time(max(shop_inventory_hot_mismatched{system="shop"})[15m:1m]) > 0
        labels: {severity: ticket}
        annotations:
          summary: "熱點商品的 Redis 與 MySQL，15 分鐘裡每一輪都對不上（最少 {{ $value }} 個）"
          why: "13 站 4.2.2：閘門扣了之後、訂單寫下之前當掉的那一件，搶購進行中不會被修 —— 少賣，不是超賣"
      - alert: ShopPlacementsExpired
        # 13 站 7.9.5（第 04 章 4.9）：停在 RESERVING 太久、被排程補償掉的下單。
        #   買家那時候已經拿到 503（ShopHigh5xxRatio 算過了），這一條不叫醒人：它說的是「Saga 卡在中間」—— 協調者當掉、庫存服務沒有回應
        expr: sum(increase(shop_orders_rejected_total{system="shop",reason="PLACEMENT_EXPIRED"}[15m])) > 0
        labels: {severity: ticket}
        annotations:
          summary: "15 分鐘內有 {{ $value }} 張下單停在 RESERVING、被補償掉"
          why: "13 站 4.9：RESERVE_FAILED（庫存不足）是正常的業務，PLACEMENT_EXPIRED 不是"
      - alert: ShopConsumeConflict
        # 13 站 7.9.5（第 04 章 4.6.3）：已經出貨的訂單，它的預留卻已經釋放 —— 貨可能出去了、帳上沒扣
        expr: sum(increase(shop_inventory_consume_conflict_total{system="shop"}[15m])) > 0
        labels: {severity: ticket}
        annotations:
          summary: "出貨時預留已經釋放（{{ $value }} 筆）：要有人去看貨到底在不在"
          why: "13 站 4.6.3：正常應該永遠是 0"
```

第一條要一個新的指標：每一輪對帳看到幾個「Redis 與 MySQL 對不上」的熱點商品，**修了沒有都算**：

```diff
     private final JdbcTemplate jdbc;
     private final Counter drift;
     private final java.util.concurrent.ConcurrentHashMap<Long, String> lastMismatch = new java.util.concurrent.ConcurrentHashMap<>();
+    /** 13 站 7.9.5：最近一輪看到幾個 Redis ≠ MySQL 的熱點商品（不管修了沒有） */
+    private final java.util.concurrent.atomic.AtomicInteger mismatched = new java.util.concurrent.atomic.AtomicInteger();
 
     HotStock(StringRedisTemplate redis, RedisGuard guard, DistributedLock locks, JdbcTemplate jdbc, MeterRegistry meters) {
         this.redis = redis;
…
         this.locks = locks;
         this.jdbc = jdbc;
         this.drift = Counter.builder("shop.inventory.hot.drift").description("對帳發現 Redis 與 MySQL 不一致、並修正的次數").register(meters);
+        // 13 站第 04 章 4.2.2：搶購進行中，「連續兩輪看到同一組」永遠不成立 —— 一次都不修，drift 也就一直是 0。這一個看的是「現在對不上幾個」
+        io.micrometer.core.instrument.Gauge.builder("shop.inventory.hot.mismatched", mismatched, java.util.concurrent.atomic.AtomicInteger::get)
+                .description("最近一輪熱點對帳，Redis 與 MySQL 對不上的商品數（修了沒有都算）").register(meters);
     }
 
     static String key(long productId) { return "stock:" + productId; }
…
                 c.forEachRemaining(k -> ids.add(Long.parseLong(k.substring("stock:".length()))));
             }
         });
-        int fixed = 0;
+        int fixed = 0, off = 0;
         for (long id : ids) {
             Optional<String> before = guard.call("hot-stock.read", () -> redis.opsForValue().get(key(id)));
             if (before.isEmpty()) continue;
             Integer db = jdbc.queryForObject(GATE_BASE_SQL, Integer.class, id);
             String seen = before.get() + "/" + db;
             if (db == null || before.get().equals(String.valueOf(db))) { lastMismatch.remove(id); continue; }
+            off++;
             if (!seen.equals(lastMismatch.put(id, seen))) continue;            // 第一次看到：先記下來
             lastMismatch.remove(id);
             boolean swapped = guard.call("hot-stock.cas", () -> redis.execute(CAS, List.of(key(id)), before.get(), String.valueOf(db))).orElse(0L) == 1L;
…
                 log.warn("HOT_STOCK_DRIFT productId={} redis={} mysql={}（已修正成 MySQL 的值）", id, before.get(), db);
             }
         }
+        mismatched.set(off);
         return fixed;
     }
 
```

一張訂單從閘門到落帳的那幾百毫秒裡，兩邊本來就對不上（第 12 站 6.6 的「連續兩輪」就是為了它）；所以規則看的是「15 分鐘裡**每一分鐘**的最小值都大於 0」—— 只要有一輪對上了，就不是卡住。代價寫在規則的註解裡：一場一直有人在買、每一輪都剛好有訂單在路上的長時間搶購，會誤報（推論，沒有量）。

第二條要的計數器，在第一次被補償掉之前不存在（`OrderTransitionService` 是 `meters.counter(…)` 當下才建）——「任何一次就告警」的第一次就不會響（第 12 站 9.10.2 的 promtool ④）。所以啟動時先註冊 PLACEMENT_EXPIRED 那一條；第 12 站的 `AlertMetricsTest`（alerts.yml 用到的每一個指標，啟動之後就要在）會擋住忘了註冊的：

```
9.10 alerts.yml 用到的 shop_ 指標（啟動之後的序列數）：{shop_audit_denied_suspects=1, shop_audit_dropped_total=1, shop_events_lag_seconds=16, shop_inventory_consume_conflict_total=1, shop_inventory_hot_drift_total=1, shop_inventory_hot_mismatched=1, shop_inventory_hot_shortage_total=1, shop_inventory_uncounted_oldest_age_seconds=1, shop_login_lockout_degraded_total=1, shop_orders_rejected_total=1, shop_outbox_oldest_age_seconds=1, shop_outbox_rejected_total=4, shop_payment_callback_rejected_total=2, shop_reconciliation_diff=3, shop_redis_trips_total=1, shop_refunds_failed_total=1}
```

promtool 多三組：每一輪都有 1～3 個對不上 → 第 16 分鐘響；中間有一輪是 0 → 不響；PLACEMENT_EXPIRED 多 2 → 響，`RESERVE_FAILED` 多再多也不響；出貨的衝突多 1 → 響（`docker/prometheus/alerts_test.yml`）。

---

## 7.10 跨服務的日誌

trace 說的是「慢在哪一段」；日誌說的是「那一段發生了什麼」。兩者用同一個 traceId 接起來，而且**日誌不抽樣**：7.2.4 的 200 次下單與付款，抽樣 0.1，回應的 `X-Trace-Id` 是 200 / 200（第 12 站 9.8.2：抽樣只決定送不送 span）。客服拿著買家畫面上的那一串字，找的是日誌，不是 trace。

7.2.5 的那一張 503，這一章最後的程式碼上：

```bash
mvn test -Pexperiments -Dtest=H3SupportLookupTest
```

```
═══ 7.2 ⑤ 客服拿 traceId 找日誌：兩個服務各在自己的 JVM，日誌是一行一個 JSON（load { 7.46 6.35 6.12 }）═══
  一張正常的下單 201，traceId 04192f8c9a5afc734c6af4bf6fbf2280 │ 訂單服務的日誌 2 行 │ 庫存服務的日誌 0 行
    訂單服務 │ 2026-10-19T03:13:49.531131Z INFO  PlaceOrderService │ traceId=04192f8c9a5afc734c6af4bf6fbf2280 │ ORDER_PLACED orderNo=20261019-922433 buyerId=7300001 lines=1 hot=0
    訂單服務 │ 2026-10-19T03:13:49.592143Z INFO  SimulatedMailer │ traceId=04192f8c9a5afc734c6af4bf6fbf2280 │ MAIL_SENT user=7300001 type=ORDER_PLACED 訂單 20261019-922433 已成立，請在 15 分鐘內完成付款
  事故：庫存服務每個預留交易 +600 ms、連線池 2 條、借連線最多等 250 ms；12 張下單同時送 → {201=2, 503=10}
  買家畫面上的錯誤：{"type":"/problems/temporarily-unavailable","title":"服務暫時無法使用","status":503,"detail":"系統忙碌中，請稍後再試","instance":"/api/orders","traceId":"e551cad7b18aee1686bcfb98a07107a0"}
  回應的 X-Trace-Id e551cad7b18aee1686bcfb98a07107a0（跟錯誤內容裡的 traceId 一樣）
  客服用 e551cad7b18aee1686bcfb98a07107a0 找：訂單服務的日誌 0 行、庫存服務的日誌 3 行
    庫存服務 │ 2026-10-19T03:13:51.422798Z WARN  SqlExceptionHelper │ traceId=e551cad7b18aee1686bcfb98a07107a0 │ SQL Error: 0, SQLState: null
    庫存服務 │ 2026-10-19T03:13:51.423087Z ERROR SqlExceptionHelper │ traceId=e551cad7b18aee1686bcfb98a07107a0 │ HikariPool-1 - Connection is not available, request timed out after 255ms.
    庫存服務 │ 2026-10-19T03:13:51.423411Z WARN  GlobalExceptionHandler │ traceId=e551cad7b18aee1686bcfb98a07107a0 │ 拿不到資料庫連線：Could not open JPA EntityManager for transaction
  這幾秒，庫存服務的 WARN「拿不到資料庫連線」：10 行；traceId 10 個不一樣的；是這 12 張下單之一的：10 個
    庫存服務 │ 2026-10-19T03:13:51.411952Z WARN  GlobalExceptionHandler │ traceId=a44f0d3c5ac25d909f79a88e4ab17a2c │ 拿不到資料庫連線：Could not open JPA EntityManager for transaction
    庫存服務 │ 2026-10-19T03:13:51.41198Z WARN  GlobalExceptionHandler │ traceId=5d44acba4023c34f49819c702b725b5d │ 拿不到資料庫連線：Could not open JPA EntityManager for transaction
  這幾秒，訂單服務的日誌 4 行（WARN 以上 0 行）、庫存服務 38 行
  日誌的 service 欄位：訂單服務的檔案 {order-service=52}、庫存服務的檔案 {inventory-service=44}
```

對照 7.2.5：

| | 之前 | 之後 |
|---|---|---|
| 客服用買家畫面上的 traceId 找 | 訂單服務 0 行、庫存服務 0 行 | 訂單服務 0 行、庫存服務 3 行 |
| 庫存服務的「拿不到資料庫連線」，traceId 是這 12 張下單之一的 | 0 / 10 | 10 / 10 |
| `service` 欄位 | 兩個檔案都是 `shop` | `order-service`、`inventory-service` |

找到的那幾行，就是答案：**庫存服務的連線池在 250 ms 內借不到連線**。客服不用知道系統切成了兩個服務。

兩件事沒有變：

- **訂單服務對這張 503 一行日誌都沒有。** 庫存服務的 503 原樣交給買家（第 03 章 3.4.5 的 `PASS_THROUGH`），`RemoteInventoryApi` 不記錄它。現在找得到，是因為庫存服務那一邊有記。
- **成功的預留，庫存服務一行日誌都沒有**（7.11 的排查也是 0 行）。第 12 站 9.8.1 為下單成功加了 `ORDER_PLACED`，庫存服務沒有對應的那一行。要不要加，看的是「出事的時候缺不缺」；這一章沒有加。

---

## 7.11 演練：一次排查紀錄

README 的產出第 4 項：「一次『哪個服務慢了』的排查紀錄」。H4 用正式環境的形狀做一次：

- 兩個服務各在自己的 JVM，管理埠給 Prometheus 抓，日誌一行一個 JSON，span 用 OTLP 送到 Jaeger，抽樣 0.1。
- 一個 Prometheus：同一份 `alerts.yml`、打開 exemplar，兩個 job、同一個 `system=shop`。
- 每秒 10 張下單（開放式負載），正常 2 分鐘 → **庫存服務的資料庫變慢 6 分鐘**（每個預留交易 +600 ms）→ 恢復 3 分鐘。

這是一種「慢、但沒有失敗」的事故：每一張都成立，只是多了 0.6 秒。**沒有任何一行 ERROR 可以搜尋。**

每 5 秒問一次 Prometheus 的告警；叫醒人的那一條一 firing，就照下面四步走一次：

1. Prometheus：這段時間 `POST /api/orders` 的 exemplar，挑最慢的。
2. Jaeger：用那個 traceId 查 trace，算 self time。
3. 兩個服務的日誌：同一個 traceId。
4. 儀表板上的原因：預留的平均延遲、庫存服務的連線池。

```bash
mvn test -Pexperiments -Dtest=H4DrillTest
```

```
═══ 7.11 演練：每秒 10 張下單；正常 120 秒 → 庫存服務每個預留交易 +600 ms 360 秒 → 恢復 180 秒；抽樣 0.1（load { 7.54 13.74 10.76 }）═══
  Prometheus 的 target：[inventory-service up, order-service up]
═══ 7.11 排查：ShopPlaceOrderSlow 在第 435 秒 firing（變慢之後 315 秒）═══
  ⓪ 訂單服務的 /actuator/prometheus 用 OpenMetrics 要，帶 trace_id 的第一行：http_server_requests_seconds_bucket{error="none",exception="none",method="POST",outcome="SUCCESS",status="201",uri="/api/orders",le="0.05"} 1762.0 # {span_id="fcc5b7913cff2246",trace_id="bc443188c367ef4606684e7154f73bd3"} 0.0336335 1792380516.306
  ① Prometheus：過去 5 分鐘 POST /api/orders 的 exemplar 20 個，其中超過 0.5 秒的 20 個（同一段時間超過 0.5 秒的下單 2995 張）
       traceId f9ab799e8d7326490a1fb7539b68a142 │ 0.644 秒
       traceId 8db248e5c33ea0a4f57764f26046f1dc │ 0.643 秒
       traceId a7cdd8c91249ff25f726692af6b0b26f │ 0.637 秒
  ② Jaeger：/api/traces/f9ab799e8d7326490a1fb7539b68a142
       trace f9ab799e8d7326490a1fb7539b68a142：20 個 span，第一個開始到最後一個結束 752.2 ms
            +0.0 ms      644.1 ms  [order-service] http post /api/orders SERVER  exception=none status=201 uri=/api/orders
            +1.3 ms        0.5 ms    [order-service] db connection INTERNAL
            +1.8 ms        3.5 ms    [order-service] db connection INTERNAL
            +5.4 ms        2.0 ms    [order-service] db connection INTERNAL
            +7.5 ms        3.7 ms    [order-service] db connection INTERNAL
           +11.3 ms        0.4 ms    [order-service] db connection INTERNAL
           +11.6 ms        0.3 ms    [order-service] db connection INTERNAL
           +12.0 ms      625.8 ms    [order-service] inventory reserve INTERNAL  shop.attempts=1
           +12.1 ms      625.7 ms      [order-service] http put CLIENT  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
           +12.7 ms      624.7 ms        [inventory-service] http put /internal/inventory/v1/reservations/{orderId} SERVER  exception=none status=204 uri=/internal/inventory/v1/reservations/{orderId}
           +29.4 ms      607.9 ms          [inventory-service] db connection INTERNAL
          +742.7 ms        3.8 ms          [order-service] consume catalog.stock-levels CONSUMER
          +742.7 ms        3.7 ms            [order-service] db connection INTERNAL
          +637.8 ms        3.6 ms    [order-service] db connection INTERNAL
          +641.6 ms        2.2 ms    [order-service] db connection INTERNAL
          +741.7 ms       10.5 ms    [order-service] consume notification.order-events CONSUMER
          +741.7 ms        3.2 ms      [order-service] db connection INTERNAL
          +745.0 ms        0.3 ms      [order-service] db connection INTERNAL
          +745.3 ms        4.0 ms      [order-service] db connection INTERNAL
          +749.6 ms        2.6 ms      [order-service] db connection INTERNAL
     買家等了 644.1 ms，花在：[inventory-service] db connection：拿著連線 607.9 ms；[inventory-service] http put /internal/inventory/v1/reservations/{orderId} 16.9 ms；[order-service] db connection：拿著連線 16.2 ms
  ③ 日誌：訂單服務 2 行、庫存服務 0 行
       訂單服務 │ 2026-10-19T03:30:35.615736Z INFO  PlaceOrderService │ traceId=f9ab799e8d7326490a1fb7539b68a142 │ ORDER_PLACED orderNo=20261019-909205 buyerId=7402897 lines=1 hot=0
       訂單服務 │ 2026-10-19T03:30:35.723589Z INFO  SimulatedMailer │ traceId=f9ab799e8d7326490a1fb7539b68a142 │ MAIL_SENT user=7402897 type=ORDER_PLACED 訂單 20261019-909205 已成立，請在 15 分鐘內完成付款
  ④ 儀表板上的原因（不叫醒人）：訂單服務 → 庫存服務 預留的平均 610 ms（shop_remote_call_seconds，過去 1 分鐘）│ 庫存服務的連線池 active 8、pending 0
  （①～④ 花了 256 ms）
  告警（每 5 秒問一次 Prometheus 的 /api/v1/alerts）：
    第 120 秒 ── 庫存服務的資料庫變慢（每個預留交易 +600 ms）
    第 135 秒 ShopPlaceOrderSlow pending
    第 230 秒 ShopConsumerLag{inventory.hot-settlement} pending
    第 290 秒 ShopConsumerLag{inventory.hot-settlement} firing
    第 435 秒 ShopPlaceOrderSlow firing
    第 480 秒 ── 恢復
    第 540 秒 ShopPlaceOrderSlow 解除
    第 545 秒 ShopConsumerLag{inventory.hot-settlement} 解除
    第 555 秒 ShopPlaceOrderSlow pending
    第 600 秒 ShopPlaceOrderSlow 解除
  正常   │ 下單  1200 張 │ p50     28 ms │ p99     80 ms │ 超過 500 ms 的     0 張 │ {201=1200}
  變慢   │ 下單  3600 張 │ p50    630 ms │ p99    660 ms │ 超過 500 ms 的  3600 張 │ {201=3600}
  恢復   │ 下單  1752 張 │ p50     27 ms │ p99    182 ms │ 超過 500 ms 的     7 張 │ {201=1752}
  Jaeger 收到的 span：15,625 個
  （結束時 load { 4.10 5.80 7.36 }）
```

**告警的時間軸：**

- 變慢之後 15 秒，`ShopPlaceOrderSlow` 進入 pending；315 秒 firing。`for: 5m` 加上 5 分鐘與 1 分鐘兩個窗（第 12 站 9.10.5）：**一個從第一秒就讓幾乎每一張下單都變慢的事故，要 5 分鐘以上才叫醒人。** 「持續 5 分鐘」是第 12 站 0.6.6 定的；這就是它的代價。
- **最先響的不是它**，是 `ShopConsumerLag`（`inventory.hot-settlement`，變慢之後 170 秒 firing）。庫存服務的消費者每一則事件也要多 600 ms（每一則的第一句也是 `INSERT INTO processed_messages`），每秒進來 10 則，處理不完，事件開始積壓。這是同一個原因的另一個症狀 —— 兩條告警說的是同一件事，7.9.1 說的「一個事故叫醒人兩次」在這裡發生了。
- 恢復之後 60 秒，`ShopPlaceOrderSlow` 解除；又過了 15 秒，它再進了一次 pending，45 秒後解除，沒有 firing。恢復那一段還有 7 張超過 500 ms，推論是它們讓 1 分鐘的窗又超過了 1%；是哪幾張、為什麼慢，這一次沒有查。

**排查的四步：**

1. **exemplar**：過去 5 分鐘 20 個，全部超過 0.5 秒；同一段時間超過 0.5 秒的下單有 2,995 張。exemplar 是「被抽到的請求」裡、每一次抓指標每一個桶留一個 —— 樣本的樣本。排查只需要一條。
2. **trace**：self time 的第一名是**庫存服務拿著連線 607.9 ms**。訂單服務自己的交易加起來 16.2 ms。答案是「庫存服務的資料庫」，不是「庫存服務」這麼籠統。
3. **日誌**：訂單服務 2 行（`ORDER_PLACED`、寄信），庫存服務 0 行（7.10：成功的預留沒有日誌）。這一次，日誌沒有幫上忙。
4. **儀表板**：預留的平均延遲 610 ms，庫存服務的連線池 active 8、pending 0。連線池沒有在排隊 —— 所以不是 6.3 那一種「連線不夠」，是每一個交易本身變慢了。跟 trace 的結論一樣：時間在「拿著連線」，不在「等連線」。

四步在程式裡跑了 256 ms。人來做，是四個頁面、兩次複製貼上 traceId —— README 的那一句「三分鐘內指出是哪個服務慢了」，推論是**在告警響了之後**做得到；但告警自己要 5 分鐘以上才響。

> 📌 **README 的產出第 4 項寫的是「Gateway → 訂單 → MQ → 庫存」的 trace。** 這個系統還沒有 gateway（第 08 章），所以這一章的 trace 從訂單服務開始：訂單 → 庫存（HTTP）、訂單 → MQ → 庫存與訂單自己的消費者（7.7 的樹上都有）。

### 7.11.1 一個事故，一張單

這一節的程式碼在 `d09` 分支上。上面的演練裡，`ShopConsumerLag` 在第 290 秒 firing、`ShopPlaceOrderSlow` 在第 435 秒 —— 同一個原因，叫醒人兩次（7.9.1 的「一個事故不要叫醒人五次」）。第 08 章 8.9.1 又遇到一次：compose 上單體停掉，`ShopDown` 與 `ShopServiceGone` 一起響。Alertmanager 的設定一直是第 12 站 9.10.6 的那一份：照告警的**名字**分組 —— 兩個名字，兩組，兩張單。

兩個改動：

```diff
 # 第 09 章（9.10.6）：告警送到哪裡。本機只有一個收件人（alert-sink，印出來）；正式環境依 severity 分：page → 值班、ticket → 工單、warning → 聊天室
 route:
   receiver: local-sink
-  group_by: [alertname]
+  # 13 站 7.11.1：第一版照告警的名字分組 —— 7.11 的演練裡，下單變慢與事件積壓是同一個原因，
+  #   兩個名字兩組、兩次叫醒人。改成照 severity：同一個系統、同一個等級的告警是同一組，值班系統只開一張單（groupKey），
+  #   後來的那一條是那一張單的更新。代價：兩件不相干的事同時發生，也在同一張單裡
+  group_by: [severity]
   group_wait: 10s          # 預設 30 秒：同一組的告警先等這麼久、湊在一起送（J8f 量的是這一段加上 Prometheus 自己的延遲）
   group_interval: 1m
   repeat_interval: 4h
…
     webhook_configs:
       - url: http://alert-sink:8080/alerts
         send_resolved: true
+# 13 站 8.9.1：一個服務整個不見了（ShopServiceGone）的時候，同一個 job 的 ShopDown 不用再說一次 ——
+#   compose 上單體停掉，兩條一起響（8.9.1）。equal：只抑制同一個 job 的
+inhibit_rules:
+  - source_matchers: ['alertname="ShopServiceGone"']
+    target_matchers: ['alertname="ShopDown"']
+    equal: [job]
+  # 13 站 7.11.2：快的那一條響了，慢的那一條說的是同一件事
+  - source_matchers: ['alertname="ShopHigh5xxRatioFast"']
+    target_matchers: ['alertname="ShopHigh5xxRatio"']
+  - source_matchers: ['alertname="ShopPlaceOrderSlowFast"']
+    target_matchers: ['alertname="ShopPlaceOrderSlow"']
```

- **照 severity 分組**：同一個系統、同一個等級的告警是同一組。值班系統（PagerDuty 一類）拿 Alertmanager 的 `groupKey` 當「同一張單」：同一組後來的通知，是那一張單的更新，不是再叫一次。代價寫在註解裡：兩件不相干的事同時發生，也在同一張單裡。
- **抑制**：`ShopServiceGone` 響的時候，同一個 `job` 的 `ShopDown` 不送（整個服務都不見了，「某一台抓不到」是同一件事的一部分）。

H7 不經過 Prometheus，直接把兩次演練的告警照當時的順序送進一台 Alertmanager（compose 的同一個映像檔），收件人（`sink.py`，現在多印一個 `groupKey`）數收到幾則、幾張單；兩份設定各跑一次：

```bash
mvn test -Pexperiments -Dtest=H7AlertRoutingTest
```

```
═══ 7.11.1／8.9.1 Alertmanager 的分組與抑制：同樣的告警，送出幾則通知、開了幾張單（groupKey）═══
  第 09 章結束時的設定（group_by: [alertname]，沒有 inhibit_rules）
    A（下單變慢 + 事件積壓）： 通知 4 則（其中有 firing 的 2 則）、單 2 張：#1 [ShopConsumerLag（firing）]；#2 [ShopPlaceOrderSlow（firing）]；#3 [ShopConsumerLag（resolved）]；#4 [ShopPlaceOrderSlow（resolved）]
    B（單體停掉）： 通知 2 則（其中有 firing 的 2 則）、單 2 張：#1 [ShopServiceGone（firing）]；#2 [ShopDown（firing）]
  現在的設定（group_by: [severity]；ShopServiceGone 抑制同一個 job 的 ShopDown）
    A（下單變慢 + 事件積壓）： 通知 3 則（其中有 firing 的 2 則）、單 1 張：#1 [ShopConsumerLag（firing）]；#2 [ShopPlaceOrderSlow（firing）, ShopConsumerLag（firing）]；#3 [ShopPlaceOrderSlow（resolved）, ShopConsumerLag（resolved）]
    B（單體停掉）： 通知 1 則（其中有 firing 的 1 則）、單 1 張：#1 [ShopServiceGone（firing）]
```

- **A（這一節的演練）**：照名字分組是兩張單、兩則 firing 的通知；照 severity 是**一張單**：第一則只有 `ShopConsumerLag`，第二則（145 秒之後）是同一張單、兩條都在。
- **B（8.9.1）**：照名字是兩張單；加上抑制之後只送了 `ShopServiceGone`。

### 7.11.2 依燃燒速率的告警，與「不要等 5 分鐘」

這一節的程式碼在 `d09` 分支上。上面的時間軸：一個從第一秒就讓每一張下單都慢 0.6 秒的事故，`ShopPlaceOrderSlow` 要 315 秒才 firing。常見的建議是改用「依燃燒速率」的告警（Google 的 SRE Workbook 第 5 章）：SLO 給出一個錯誤預算，告警看預算燒得多快 —— 燒得越快，響得越快。照那一章的建議寫兩條（燃燒速率 14.4 倍：1 小時窗＋5 分鐘窗；6 倍：6 小時窗＋30 分鐘窗），SLO 用第 12 站 0.6.6 的那一個（`/api/**` 的 99% 不是 5xx，預算 1%）：

```yaml
      - alert: ShopErrorBudgetBurn14x
        expr: |
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[1h]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[1h])) > 14.4 * 0.01)
          and
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[5m]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[5m])) > 14.4 * 0.01)
        labels: {severity: page}
```

換之前，先用 promtool 量「什麼事故、哪一條、第幾分鐘響」。四種事故，每一種都先有 6 小時乾淨的流量，第 360 分鐘出事（`docker/prometheus/alerts-burn-rate_test.yml`）；每一格都是兩個斷言：「這個時候還沒響」與「這個時候響了」：

```yaml
  # S1 全部 5xx
  - interval: 15s
    input_series:
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="200",uri="/api/products/{id}"}'
        values: '0+1000x1440 1440000+0x120'
      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="503",uri="/api/products/{id}"}'
        values: '0+0x1440 0+1000x120'
    alert_rule_test:
      - {eval_time: 362m15s, alertname: ShopHigh5xxRatioFast, exp_alerts: []}
      - {eval_time: 363m, alertname: ShopHigh5xxRatioFast, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "5xx 超過一半（59.89%）", why: "13 站 7.11.2：整個壞掉的事故不等 5 分鐘"}}]}
      - {eval_time: 365m, alertname: ShopHigh5xxRatio, exp_alerts: []}
      - {eval_time: 366m, alertname: ShopHigh5xxRatio, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "5xx 超過 1%（100%），持續 5 分鐘", why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"}}]}
      - {eval_time: 368m15s, alertname: ShopErrorBudgetBurn14x, exp_alerts: []}
      - {eval_time: 369m15s, alertname: ShopErrorBudgetBurn14x, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "錯誤預算燃燒速率 > 14.4（1 小時窗 15.07%）"}}]}
      - {eval_time: 381m, alertname: ShopErrorBudgetBurn6x, exp_alerts: []}
      - {eval_time: 382m15s, alertname: ShopErrorBudgetBurn6x, exp_alerts: [{exp_labels: {severity: page}, exp_annotations: {summary: "錯誤預算燃燒速率 > 6（6 小時窗 6.116%）"}}]}
```

| 事故（第 360 分鐘起） | `ShopHigh5xxRatio`（1%、for 5m） | 燃燒速率 14.4 倍 | 燃燒速率 6 倍 | `ShopHigh5xxRatioFast`（下面） |
|---|---|---|---|---|
| S1 全部 5xx | 5～6 分鐘 | 8¼～9¼ 分鐘 | 21～22¼ 分鐘 | 2¼～3 分鐘 |
| S2 20% 5xx | 6 分鐘以內 | 42½～44 分鐘 | 107～109 分鐘 | 不響 |
| S3 2% 5xx | 7～8¼ 分鐘 | 兩小時都不響 | 兩小時都不響 | 不響 |
| S4 全部 5xx，3 分鐘 | 不響（到第 10 分鐘） | 不響 | —— | 2¼～3 分鐘 |

```
Checking alerts.yml
  SUCCESS: 26 rules found

Checking alerts-burn-rate.yml
  SUCCESS: 2 rules found

  SUCCESS

  SUCCESS
```

（`check rules` 兩個規則檔各一行；最後兩個 SUCCESS 是兩個測試檔：`alerts_test.yml`、`alerts-burn-rate_test.yml`。）

- **燃燒速率的告警，每一種事故都比較慢。** 不是規則寫錯。14.4 倍、6 倍這兩個數字跟 SLO 無關（1 小時燒掉一個月預算的 2%、6 小時燒掉 5%）；跟 SLO 有關的是門檻 = 燃燒速率 × 預算：預算 1% 的時候是 14.4% 的 5xx —— 1 小時窗要整整 8.6 分鐘的全部失敗才過得了。同樣的 14.4 倍，99.9% 的 SLO（預算 0.1%）門檻是 1.44%，52 秒（推算，沒有測）。**叫醒人要多快，是 SLO 決定的，不是規則的寫法。**
- **它換到的是「小火不叫醒人」**：S3 的 2%，現在的規則 7 分多鐘就叫醒人；燃燒速率兩小時都不響 —— 照這個速度，一個月的預算要兩週才燒完。這是一個值班的取捨，不是誰對誰錯。
- **S3 的 7～8 分鐘**：5 分鐘窗要過了一半，比例才超過 1%，再加 `for: 5m`。上面演練裡「5 分鐘以上才叫醒人」，錯誤越少，那個「以上」越長。

所以這一節**不換**成燃燒速率（`alerts-burn-rate.yml` 只給 promtool 比較用，Prometheus 沒有載入它），改的是另一件事：**整個壞掉的時候，不要等 5 分鐘。** 多兩條快的：一半以上是 5xx（或一半以上的下單超過 500 ms），5 分鐘窗與 1 分鐘窗都是，沒有 `for`：

```yaml
      - alert: ShopHigh5xxRatioFast
        # 13 站 7.11.2：整個壞掉的時候，不要等 5 分鐘。一半以上是 5xx、5 分鐘窗與 1 分鐘窗都是，沒有 for ——
        #   全部 5xx 的事故 2 分半就響（上面那一條是 5 分多鐘）。50% 是判斷：小的、慢慢燒的，留給上面那一條。兩條都響時，Alertmanager 抑制上面那一條
        expr: |
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[5m]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[5m])) > 0.5)
          and
          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[1m]))
             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[1m])) > 0.5)
        labels: {severity: page}
        annotations:
          summary: "5xx 超過一半（{{ $value | humanizePercentage }}）"
          why: "13 站 7.11.2：整個壞掉的事故不等 5 分鐘"
```

上表最右一欄：全部 5xx 的事故 2¼～3 分鐘響（原本 5～6 分鐘）；20%、2% 的不響，留給原本那一條。代價在 S4：一次 3 分鐘、自己好了的停機，原本不會叫醒人，現在會。兩條一起響的時候，Alertmanager 抑制慢的那一條（7.11.1 的設定）。這一節的演練（每一張都慢 0.6 秒）是 `ShopPlaceOrderSlowFast` 那一種：推論它會在變慢之後兩分半左右響（沒有重跑演練驗證）。

---

## 7.12 流程測試與追溯表

### 7.12.1 這一章新增的測試與實驗

| 名稱 | 種類 | 跑在哪裡 | 守什麼／量什麼 |
|---|---|---|---|
| `InternalTraceparentTest` | 測試（2 個） | Testcontainers，庫存服務的角色，`@AutoConfigureObservability` | 只信任自己的服務帶來的 `traceparent`（7.5） |
| `OutboxTraceparentTest` | 測試（4 個） | Testcontainers、真的 relay 與 RabbitMQ、`@AutoConfigureObservability`、抽樣 100% | outbox 的 `traceparent`、消費者的 parent、旗標 00、舊的事件（7.6）；借連線的 span 只在 trace 裡、bean 還是 `HikariDataSource`（7.7.2） |
| `RemoteInventoryResilienceTest` | 測試（多 1 個） | 不用 Spring、假的庫存服務 | `shop.remote.call` 的 outcome 與送了幾次；熔斷器擋下的那一張也有（7.7.1、7.7.5） |
| `alerts_test.yml` | promtool（多 3 組） | Docker | 切開之後：使用者的 5xx 響、`/internal/**` 的 5xx 不響、outbox 說出是哪一個服務（7.9） |
| H1 `H1SlowOrderTraceTest` | 實驗 | compose、兩個服務在同一個 JVM | 7.2、7.7.4 |
| H2 `H2SamplingTest` | 實驗 | 同上 | 7.2.4、7.8.1 |
| H3 `H3SupportLookupTest` | 實驗 | compose、兩個服務各在自己的 JVM | 7.2.5、7.10 |
| H4 `H4DrillTest` | 實驗 | compose、兩個子 JVM、Jaeger、演練用的 Prometheus | 7.11 |
| H5 `H5SamplingCostTest` | 實驗 | compose、兩個子 JVM、Jaeger | 7.8.2 |
| H6 `H6MdcHookTest` | 實驗 | compose、一個單體 | 7.4.4 |
| 第 04 章的 E4、第 01 章的 B1 | 實驗（重跑） | —— | 7.12.2 |

預設的測試從第 06 章的 355 個變成 362 個（7.13）。

### 7.12.2 E4、B1 重跑

使用者的一天（第 04 章的 E4）：

```
  訂單服務 → 庫存服務：14 次 HTTP、7 種端點（第 03 章：38 次、10 種）
    POST /api/orders → POST /internal/inventory/v1/hot-gate                                              × 2
    POST /api/orders → PUT /internal/inventory/v1/reservations/{n}                                       × 6
    POST /api/seller/orders/{orderNo}/ship → GET /internal/inventory/v1/reservations/{n}/shippable       × 2
    POST /api/seller/products/{id}/hot → PUT /internal/inventory/v1/products/{n}/hot                     × 1
    POST /api/seller/products/{id}/restock → GET /internal/inventory/v1/stock                            × 1
    POST /api/seller/products/{id}/restock → POST /internal/inventory/v1/products/{n}/restocks           × 1
    排程 ReservationReconciliation.run → GET /internal/inventory/v1/reservations                           × 1
```

跟第 06 章一樣：14 次 HTTP、7 種端點。這一章沒有改任何一次呼叫的次數，只改了每一次呼叫帶什麼 header、留下什麼 span。

B1（第 01 章的邊界地圖）：

```
     9 │ catalog+inventory                   │          0 │          0 │        9 │        1 │    5 │  25.0%（9）
    24 │ inventory                           │          0 │          0 │       10 │        0 │    7 │  22.2%（8）
```

跟第 06 章一樣：庫存這一刀的同步呼叫 10 種、第 24 名。這一章沒有改模組之間的介面：追蹤的程式在 `shared`，不在任何一個模組的 API 上。

### 7.12.3 追溯表：這一站的產出

| README 的產出 | 第 00～02 章 | 第 03～06 章 | 第 07 章加上的 |
|---|---|---|---|
| 1. 拆分決策文件 | 不該拆；四個代價；第一刀切 notification；資料的三個階段 | 同步還是非同步；交易各用編排還是協同；跨服務的讀哪些可以晚；每一個「等」的上限；下單不等庫存改的是需求 | 告警叫醒誰：使用者感受得到的在邊緣，原因不叫醒人（7.9） |
| 2. 庫存拆成獨立服務、下單改成 Saga | 兩種部署、獨立的資料庫、對帳 | 正式的服務、契約、Saga、補償、演練、延遲對照；讀模型；下單路徑的四道保護 | 換版那一刻的舊訊息不會被丟掉（7.6.4） |
| 3. 跨服務報表：API 組合版與讀模型版、過時視窗 | 庫存這一刀不切斷報表 | 三個讀的頁面：API 組合 → 讀模型；過時視窗；重建 | （沒有改） |
| 4. 一條完整的 trace、一次排查紀錄 | K5：兩邊都斷 | 送的那一邊好了、收的那一邊還斷 | 訂單 → 庫存（HTTP）、訂單 → MQ → 兩個服務的消費者，一棵樹（7.7）；一次排查紀錄（7.11）；沒有 gateway（第 08 章） |
| 5. 基礎設施選型 | 維運清單 | 一個 jar、三種角色；Pact Broker；熔斷器放在應用程式裡 | OTLP 與 Jaeger；告警規則不寫死部署的形狀（7.9.2）；Jaeger 的儲存（第 08 章） |

---

## 7.13 本章完成後的專案

```
shop/                                                              ← 分支 d07（從 d06 開出來）
├── pom.xml                                                        ← 7.4：bridge-brave → bridge-otel + exporter-otlp
├── compose.yaml                                                   ← 7.3：jaeger（tracing、app）；7.9：Prometheus 打開 exemplar
├── docker/prometheus/prometheus.yml、alerts.yml、alerts_test.yml  ← 7.9：system="shop"、/api/**、切開之後的三組測試
├── src/main/resources/
│   ├── application.yml                                            ← 7.4：關掉 Spring Security 的觀測；7.8：抽樣 0.1
│   ├── application-order-service.yml、application-inventory-service.yml ← 7.4：spring.application.name
│   ├── application-prod.yml                                       ← 7.4：SHOP_OTLP_ENDPOINT
│   ├── logback-json.xml                                           ← 7.10：service 欄位
│   └── db/migration/shared/V34__shared_outbox_traceparent.sql     ← 7.6
├── src/main/java/com/example/shop/
│   ├── shared/web/TraceFilters.java                               ← 7.5：只信任自己的服務
│   ├── shared/observability/Traces.java                           ← 7.6：continueFrom、舊路；7.4：啟動時的檢查
│   ├── shared/observability/TracedDataSource.java                 ← + 7.7.2
│   ├── shared/events/internal/JdbcOutbox.java、OutboxStore.java   ← 7.6：traceparent
│   ├── shared/messaging/internal/RabbitOutboxRelay.java、RabbitConsumers.java ← 7.6
│   └── inventory/internal/remote/RemoteInventoryApi.java          ← 7.7：shop.remote.call
└── src/test/java/com/example/shop/
    ├── dist07/H1…H6、Spans、SpanTap、Calls、Keys、SlowSql、Node、Jaeger、Prom ← 實驗與實驗台
    ├── inventory/internal/web/InternalTraceparentTest.java         ← + 7.5
    ├── shared/events/internal/OutboxTraceparentTest.java           ← + 7.6、7.7.2
    ├── inventory/internal/remote/RemoteInventoryResilienceTest.java ← 7.7
    └── support/InlineEvents.java                                   ← OutboxStore.Row 多一欄
```

**對買家、賣家的 API 沒有改變**（`OpenApiContractTest` 的快照沒有動）。服務之間多了一個可以沒有的 AMQP header `traceparent`，契約沒有改（7.6.7）。一個 migration（V34，加一個可以是 NULL 的欄位）。單體的行為：追蹤換了實作、服務的名字照舊是 `shop`、外面帶進來的 trace header 照舊不收；不設 `management.otlp.tracing.endpoint` 就不送。

完整跑一次：

```bash
mvn clean verify
```

```
TEST_INFRA testcontainers 啟動 10,199 ms：mysql jdbc:mysql://localhost:53741/shop、redis localhost:53732、rabbitmq localhost:53740
TEST_INFRA MySQL 最多同時 31 條連線（max_connections 151）
[INFO] Tests run: 362, Failures: 0, Errors: 0, Skipped: 0
TEST_INFRA testcontainers 啟動 12,745 ms：mysql jdbc:mysql://localhost:55378/shop、redis localhost:55368、rabbitmq localhost:55376
TEST_INFRA MySQL 最多同時 6 條連線（max_connections 151）
[INFO] Tests run: 39, Failures: 0, Errors: 0, Skipped: 0
[INFO] All coverage checks have been met.
[INFO] BUILD SUCCESS
[INFO] Total time:  06:09 min
```

**362 個測試**：第 06 章的 355 個，加上：

| 測試 | 多了幾個 |
|---|---|
| `OutboxTraceparentTest` | 4 |
| `InternalTraceparentTest` | 2 |
| `RemoteInventoryResilienceTest` | 1 |

**failsafe 那一段 39 個**，跟第 06 章一樣（7.6.7）。

第 06 章留下的那一個 —— 第 12 站的驗收 Q10 偶爾會紅 —— 在 `d07` 上還在，沒有修；第 08 章修了它（第 12 站 7.7.2：通知的認領改成租約）。

### 7.13.1 本章其餘檔案的完整內容

正文已經完整列出的：`TracedDataSource`（7.7.2）、V34（7.6.2）。正文列過片段或 diff 的：`pom.xml`（7.4.1）、`Traces`、`TraceFilters`、`JdbcOutbox`、`RabbitOutboxRelay`、`RemoteInventoryApi`、`application*.yml`、`logback-json.xml`、`compose.yaml`、`alerts.yml`、`prometheus.yml`，以及第一個 commit 的 `SpanTap`（7.2.1）。

下面是其餘的檔案：新增的，列 `d07` 分支上的完整內容；改動的，列 diff。

**`src/main/java/com/example/shop/shared/observability/Traces.java`**（7.4.4、7.6）

```diff
 package com.example.shop.shared.observability;
 
 import io.micrometer.tracing.Span;
-import io.micrometer.tracing.TraceContext;
 import io.micrometer.tracing.Tracer;
+import io.micrometer.tracing.propagation.Propagator;
 import org.springframework.stereotype.Component;
 
+import java.util.Map;
 import java.util.concurrent.ThreadLocalRandom;
 import java.util.function.Supplier;
 import java.util.regex.Pattern;
…
  *   ① 消費者：訊息從 outbox 送出時帶著下單那個請求的 traceId（outbox_events.trace_id → header traceId，7.4），
  *      這裡接在同一個 trace 底下開一個新的 span —— 消費者的日誌、它寫的下一個事件，traceId 都跟原本的請求一樣
  *   ② 排程：付款逾時、自動完成、對帳……沒有請求，每一輪一個新的 trace
- * MDC 的 traceId / spanId 由 Brave 在 withSpan 的時候放、結束的時候拿掉。
+ * MDC 的 traceId / spanId 由追蹤的實作在 withSpan 的時候放、結束的時候拿掉（第 12 站是 Brave，13 站 7.4 換成 OpenTelemetry）。
  */
 @Component
 public class Traces {
…
     private static final Pattern TRACE_ID = Pattern.compile("[0-9a-f]{16}|[0-9a-f]{32}");
 
     private final Tracer tracer;
+    private final Propagator propagator;
 
-    Traces(Tracer tracer) { this.tracer = tracer; }
+    Traces(Tracer tracer, Propagator propagator) {
+        this.tracer = tracer;
+        this.propagator = propagator;
+    }
+
+    /**
+     * 13 站 7.6：訊息帶著 traceparent（寫 outbox 的那一個 span，JdbcOutbox）→ 用 HTTP 收的那一個 Propagator 解開，接在它底下：
+     * parent 是真的 span、抽樣照它的旗標。沒有 traceparent（7.6 之前寫的事件還在佇列裡）→ ① 的舊路
+     */
+    public <T> T continueFrom(String traceparent, String traceId, String name, Supplier<T> work) {
+        if (traceparent == null) return continueTrace(traceId, name, work);
+        Span span = propagator.extract(Map.of("traceparent", traceparent), Map::get).name(name).kind(Span.Kind.CONSUMER).start();
+        return inScope(span, work);
+    }
 
-    /** ① 接著別人的 traceId 做事。traceId 是 null 或格式不對（舊的事件、別的系統送來的）→ 開一個新的 trace */
+    /**
+     * ① 接著別人的 traceId 做事。traceId 是 null 或格式不對（舊的事件、別的系統送來的）→ 開一個新的 trace。13 站 7.6 之後只給舊的訊息用。
+     * 13 站 7.6 ⚠️：只知道 traceId，parent 的 spanId 是編的、旗標是 00（不送）—— 日誌照樣帶同一個 traceId（第 12 站 Q7 的 ③），
+     * 但不送出一個 parent 不存在的 span。編好的 traceparent 交給同一個 Propagator 解開，跟有 traceparent 的訊息走同一條路。
+     * 第 12 站（Brave）是 tracer.traceContextBuilder()：換成 OpenTelemetry 之後，第一版少了 sampled → NullPointerException，訊息處理失敗、
+     * 不重新排隊，被丟掉（第 12 站 7.5）；補上 sampled 之後，Micrometer 1.2 做出來的那個 parent 不帶 span，OpenTelemetry 把它當成「沒有 parent」
+     * —— 每一則舊訊息都變成一個新的 traceId
+     */
     public <T> T continueTrace(String traceId, String name, Supplier<T> work) {
         Span span;
         if (traceId != null && TRACE_ID.matcher(traceId).matches()) {
-            TraceContext parent = tracer.traceContextBuilder().traceId(traceId)
-                    .spanId(String.format("%016x", ThreadLocalRandom.current().nextLong(1, Long.MAX_VALUE))).build();
-            span = tracer.spanBuilder().setParent(parent).name(name).start();
+            String parent = "00-" + (traceId.length() == 16 ? "0".repeat(16) + traceId : traceId)        // W3C：64 位元的 traceId 左邊補 0
+                    + "-" + String.format("%016x", ThreadLocalRandom.current().nextLong(1, Long.MAX_VALUE)) + "-00";
+            span = propagator.extract(Map.of("traceparent", parent), Map::get).name(name).kind(Span.Kind.CONSUMER).start();
         } else {
             span = tracer.nextSpan().name(name).start();
         }
         return inScope(span, work);
     }
 
+    /**
+     * 13 站 7.4 ⚠️：MDC 的 traceId 是 OpenTelemetry 的 ContextStorage 上的一個掛勾放的（Boot 在建 OtelCurrentTraceContext 的時候裝）。
+     * 這個掛勾整個 JVM 只能在第一次用到 Context 之前裝 —— 有人先用了（例如一個不用 Spring、自己建 OpenTelemetry SDK 的程式），
+     * 之後的每一個請求都有 span、日誌卻沒有 traceId，而且沒有任何錯誤。啟動完成時試一次，拿不到就大聲記一行
+     */
+    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
+    public void checkLogCorrelation() {
+        Span probe = tracer.nextSpan().name("startup-check").start();
+        String inMdc;
+        try (Tracer.SpanInScope ignored = tracer.withSpan(probe)) {
+            inMdc = org.slf4j.MDC.get("traceId");
+        } finally {
+            probe.abandon();
+        }
+        if (!probe.context().traceId().equals(inMdc))
+            org.slf4j.LoggerFactory.getLogger(Traces.class).error("TRACE_MDC_BROKEN 日誌拿不到 traceId（span {}、MDC {}）：OpenTelemetry 的 ContextStorage 在 Boot 裝上掛勾之前就被用過了",
+                    probe.context().traceId(), inMdc);
+    }
+
     /** ② 排程的一輪：一個新的 trace */
     public void newTrace(String name, Runnable work) {
         inScope(tracer.nextSpan().name(name).start(), () -> { work.run(); return null; });
```

**`src/main/java/com/example/shop/shared/web/TraceFilters.java`**（7.5）

```diff
 import jakarta.servlet.ServletException;
 import jakarta.servlet.http.HttpServletRequest;
 import jakarta.servlet.http.HttpServletResponse;
+import com.example.shop.shared.security.ServiceTokens;
 import org.slf4j.MDC;
+import org.springframework.beans.factory.ObjectProvider;
 import org.springframework.boot.web.servlet.FilterRegistrationBean;
 import org.springframework.context.annotation.Bean;
 import org.springframework.context.annotation.Configuration;
…
 class TraceFilters {
 
     static final String HEADER = "X-Trace-Id";
-    /** W3C（traceparent、tracestate）與 B3（單一 header、多個 header）：Boot 3.2 的 Brave 預設全部都收 */
+    /** W3C（traceparent、tracestate）與 B3（單一 header、多個 header）：Boot 3.2 的 Brave 預設全部都收（13 站 7.4 換成 OpenTelemetry 之後一樣：Boot 3.2 預設三種都收、只送 W3C） */
     static final java.util.Set<String> INCOMING = java.util.Set.of("traceparent", "tracestate", "b3",
             "x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid", "x-b3-sampled", "x-b3-flags");
 
…
      * 實測：不擋的話，帶 traceparent: 00-0af7…-…-01 的請求，回應的 X-Trace-Id 就是 0af7…（b3、X-B3-TraceId 也一樣）——
      * 攻擊者可以讓一千個請求共用一個 traceId、或拿別人的 traceId 混淆調查；稽核表的 trace_id 也會是他決定的。
      * 要放在 Micrometer 的 ServerHttpObservationFilter（HIGHEST_PRECEDENCE + 1）之前：它在那裡讀這些 header
+     *
+     * 13 站 7.5：例外只有一種 —— 自己的另一個服務。/internal/** 的請求、帶著一個發給我的服務 token（ServiceTokens 驗得過：
+     * 服務的金鑰、到期、iss、aud = 我）→ 照收：訂單服務的 traceparent 要接上，不然庫存服務的每一個 span 都是另一個 trace 的根（7.2）。
+     * 這裡比 Spring Security 早（它在 -100）：token 在這裡多驗一次。單體沒有 ServiceTokens（只在兩個服務的角色裡）→ 一律不收，跟第 12 站一樣
      */
     @Bean
-    FilterRegistrationBean<OncePerRequestFilter> dropIncomingTraceHeaders() {
+    FilterRegistrationBean<OncePerRequestFilter> dropIncomingTraceHeaders(ObjectProvider<ServiceTokens> serviceTokens) {
+        ServiceTokens tokens = serviceTokens.getIfAvailable();
         FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter() {
             @Override
             protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
+                if (fromOurService(req, tokens)) {
+                    chain.doFilter(req, res);
+                    return;
+                }
                 chain.doFilter(new jakarta.servlet.http.HttpServletRequestWrapper(req) {
                     @Override public String getHeader(String name) { return INCOMING.contains(name.toLowerCase(java.util.Locale.ROOT)) ? null : super.getHeader(name); }
                     @Override public java.util.Enumeration<String> getHeaders(String name) {
…
         return reg;
     }
 
+    /** 13 站 7.5：/internal/**，而且 Authorization 是一個發給我的服務 token */
+    static boolean fromOurService(HttpServletRequest req, ServiceTokens tokens) {
+        if (tokens == null || !req.getRequestURI().startsWith("/internal/")) return false;
+        String auth = req.getHeader("Authorization");
+        if (auth == null || !auth.startsWith("Bearer ")) return false;
+        try {
+            tokens.decoder().decode(auth.substring("Bearer ".length()));
+            return true;
+        } catch (org.springframework.security.oauth2.jwt.JwtException invalid) {
+            return false;
+        }
+    }
+
     @Bean
     FilterRegistrationBean<OncePerRequestFilter> traceIdHeader() {
         FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter() {
```

**`src/main/java/com/example/shop/shared/events/internal/JdbcOutbox.java`**（7.6.2）

```diff
 import com.example.shop.shared.events.Outbox;
 import com.fasterxml.jackson.core.JsonProcessingException;
 import com.fasterxml.jackson.databind.ObjectMapper;
+import io.micrometer.tracing.Span;
+import io.micrometer.tracing.Tracer;
+import io.micrometer.tracing.propagation.Propagator;
 import org.slf4j.MDC;
+import org.springframework.beans.factory.ObjectProvider;
 import org.springframework.jdbc.core.JdbcTemplate;
 import org.springframework.stereotype.Component;
 import org.springframework.transaction.annotation.Propagation;
 import org.springframework.transaction.annotation.Transactional;
 
+import java.util.HashMap;
 import java.util.Map;
 import java.util.UUID;
 
…
 
     private final JdbcTemplate jdbc;
     private final ObjectMapper json;
+    private final ObjectProvider<Tracer> tracer;
+    private final ObjectProvider<Propagator> propagator;
 
-    JdbcOutbox(JdbcTemplate jdbc, ObjectMapper json) {
+    JdbcOutbox(JdbcTemplate jdbc, ObjectMapper json, ObjectProvider<Tracer> tracer, ObjectProvider<Propagator> propagator) {
         this.jdbc = jdbc;
         this.json = json;
+        this.tracer = tracer;
+        this.propagator = propagator;
     }
 
     @Override
…
             throw new IllegalArgumentException("事件 " + eventType + " 的 payload 無法轉成 JSON", e);
         }
         jdbc.update("""
-                INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id)
-                VALUES (?, ?, ?, ?, ?, ?)""",
-                eventId, aggregateType, aggregateId, eventType, body, MDC.get("traceId"));   // traceId：第 09 章才有人放進 MDC
+                INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, traceparent)
+                VALUES (?, ?, ?, ?, ?, ?, ?)""",
+                eventId, aggregateType, aggregateId, eventType, body, MDC.get("traceId"), traceparent());   // traceId：第 09 章才有人放進 MDC
         return eventId;
     }
 
+    /**
+     * 13 站 7.6：現在這一個 span 的 W3C traceparent（00-traceId-spanId-旗標）—— 用 HTTP 送出時同一個 Propagator 寫，不自己拼字串。
+     * 消費者接在這個 span 底下（parent 是真的），旗標也跟著走：這一次請求沒有被抽到，它的事件也不會被抽到（7.8）
+     */
+    private String traceparent() {
+        Tracer t = tracer.getIfAvailable();
+        Propagator p = propagator.getIfAvailable();
+        Span span = t == null ? null : t.currentSpan();
+        if (span == null || p == null) return null;
+        Map<String, String> carrier = new HashMap<>();
+        p.inject(span.context(), carrier, Map::put);
+        return carrier.get("traceparent");
+    }
+
     @Override
     public java.util.List<Recorded> recorded(String aggregateType, long aggregateId) {
         return jdbc.query("""
```

**`src/main/java/com/example/shop/shared/events/internal/OutboxStore.java`**（7.6）

```diff
 @Component
 public class OutboxStore {
 
+    /** traceparent：寫這一筆的那一個 span（13 站 7.6，V34）；舊的事件是 null */
     public record Row(long id, String eventId, String aggregateType, long aggregateId, String eventType, String payload,
-                      Instant createdAt, String traceId) {}
+                      Instant createdAt, String traceId, String traceparent) {}
 
     public record Backlog(long pending, double oldestAgeSeconds) {}
 
…
     @Transactional(propagation = Propagation.MANDATORY)
     public List<Row> claim(int batch, java.time.Duration lease) {
         List<Row> rows = jdbc.query("""
-                SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id
+                SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id, traceparent
                   FROM outbox_events
                  WHERE published_at IS NULL AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(3))
                  ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED""",
                 (rs, i) -> new Row(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4), rs.getString(5),
-                        rs.getString(6), rs.getTimestamp(7).toInstant(), rs.getString(8)), batch);
+                        rs.getString(6), rs.getTimestamp(7).toInstant(), rs.getString(8), rs.getString(9)), batch);
         if (rows.isEmpty()) return rows;
         String in = String.join(",", Collections.nCopies(rows.size(), "?"));
         List<Object> args = new java.util.ArrayList<>();
```

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitOutboxRelay.java`**（7.6.3）

```diff
         p.setContentEncoding("UTF-8");
         p.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
         p.setTimestamp(Date.from(r.createdAt()));
-        if (r.traceId() != null) p.setHeader("traceId", r.traceId());
+        if (r.traceId() != null) p.setHeader("traceId", r.traceId());       // 9.8：還沒換版的消費者讀這一個
+        if (r.traceparent() != null) p.setHeader("traceparent", r.traceparent());   // 13 站 7.6：寫這一筆的那一個 span（W3C），消費者接在它底下
         return new Message(env.toString().getBytes(StandardCharsets.UTF_8), p);
     }
 
```

**`src/main/java/com/example/shop/shared/messaging/internal/RabbitConsumers.java`**（7.6.3）

```diff
     /**
      * 9.8：接著下單那個請求的 traceId 處理（relay 把 outbox_events.trace_id 放在 header traceId，7.4）。
      * 第 07 章到第 08 章，header 一直都在，但沒有人讀它 —— 消費者的每一行日誌都沒有 traceId（驗收 Q7 的第 ③ 段）
+     * 13 站 7.6：有 traceparent（寫這一筆事件的那一個 span）就接在它底下；沒有（換版之前寫的事件）才走 traceId 的舊路
      */
     void onMessage(EventHandler h, Message m, Channel ch) throws IOException {
         Object traceId = m.getMessageProperties().getHeaders().get("traceId");
+        Object traceparent = m.getMessageProperties().getHeaders().get("traceparent");
         try {
-            traces.continueTrace(traceId == null ? null : traceId.toString(), "consume " + h.consumer(), () -> {
+            traces.continueFrom(traceparent == null ? null : traceparent.toString(), traceId == null ? null : traceId.toString(), "consume " + h.consumer(), () -> {
                 try { handle(h, m, ch); } catch (IOException e) { throw new java.io.UncheckedIOException(e); }
                 return null;
             });
```

**`src/main/java/com/example/shop/inventory/internal/remote/RemoteInventoryApi.java`**（7.7.1、7.7.5）

```diff
 import io.github.resilience4j.micrometer.tagged.TaggedCircuitBreakerMetrics;
 import io.micrometer.core.instrument.Counter;
 import io.micrometer.core.instrument.MeterRegistry;
+import io.micrometer.observation.Observation;
+import io.micrometer.observation.ObservationRegistry;
 import org.slf4j.Logger;
 import org.slf4j.LoggerFactory;
 import org.springframework.context.annotation.Primary;
…
     private final InventoryClient client;
     private final ObjectMapper json;
     private final MeterRegistry meters;
+    private final ObservationRegistry observations;
     private final Duration readTimeout;
     private final int maxAttempts;
     private final long openSeconds;
…
     private final Bulkhead orderPath, others;
     private final Map<String, CircuitBreaker> breakers = new HashMap<>();
 
-    RemoteInventoryApi(RestClient.Builder builder, ShopProperties props, ServiceTokens tokens, ObjectMapper json, MeterRegistry meters) {
+    RemoteInventoryApi(RestClient.Builder builder, ShopProperties props, ServiceTokens tokens, ObjectMapper json, MeterRegistry meters,
+                       ObservationRegistry observations) {
         ShopProperties.Remote r = props.deployment().inventory();
         HttpClient http = HttpClient.newBuilder().connectTimeout(r.connectTimeout()).build();
         // 6.4：每一次送出有自己的 read timeout。JdkClientHttpRequestFactory 的逾時是整個 factory 一個值，所以每一次送出 new 一個 ——
…
         this.client = HttpServiceProxyFactory.builderFor(RestClientAdapter.create(rest)).build().createClient(InventoryClient.class);
         this.json = json;
         this.meters = meters;
+        this.observations = observations;
         this.readTimeout = r.readTimeout();
         this.maxAttempts = r.maxAttempts();
         this.retryBudget = new RetryBudget(r.retryRatio(), r.minRetries());
…
     /**
      * 13 站 6.7.5：預留的熔斷器開著 → 503。要用 tryAcquirePermission()、再還回去，不能只看 getState()：
      * OPEN 是「被要求放行時」才轉成 HALF_OPEN（05-service/06 的 6.7.1）—— 只看狀態、從來不要求放行，它就永遠開著
+     * 13 站 7.7 ⚠️：擋下來的時候也留一個 shop.remote.call（outcome = breaker、送了 0 次）。第一版沒有：這一張的 trace 上一個庫存的 span 都沒有，
+     * 只看得到訂單服務自己的十幾毫秒，說不出為什麼是 503
      */
     @Override
     public void ensureReservable() {
…
             return;
         }
         rejected("reserve", "breaker");
-        throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
+        ShopException e = new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
+        Observation.createNotStarted("shop.remote.call", observations).contextualName("inventory reserve")
+                .lowCardinalityKeyValue("service", "inventory").lowCardinalityKeyValue("op", "reserve")
+                .lowCardinalityKeyValue("outcome", "breaker").highCardinalityKeyValue("shop.attempts", "0")
+                .start().error(e).stop();
+        throw e;
     }
 
     // 13 站 4.6：confirm、release、consume 不在 InventoryApi 上了（庫存服務自己收 order.paid、order.cancelled、order.shipped）
…
         call(op, () -> { r.run(); return null; });
     }
 
+    /** 13 站 7.7：一次呼叫的結果（shop.remote.call 的 outcome）、送了幾次 */
+    private static final class Result {
+        String outcome = "error";
+        int attempts;
+    }
+
+    /**
+     * 13 站 7.7：每一次呼叫一個觀測 shop.remote.call —— 一個 span（「inventory reserve」）＋ 一個計時器（shop_remote_call_seconds{service, op, outcome}）。
+     * 每一次送出是它底下的一個 HTTP client span（Boot 的 RestClient.Builder 自己會開）。trace 上看得出：送了幾次、每一次等多久，
+     * 還是根本沒有送出去（outcome = bulkhead、breaker、budget：這個 span 底下沒有 HTTP 的 span）。
+     * 業務的結果（庫存不足、狀態不對）不標成錯誤：搶購時一半的人買不到，那不是庫存服務出事（6.7.2 的同一個理由）
+     */
+    private <T> T call(String op, Supplier<T> c) {
+        Observation obs = Observation.createNotStarted("shop.remote.call", observations).contextualName("inventory " + op)
+                .lowCardinalityKeyValue("service", "inventory").lowCardinalityKeyValue("op", op).start();
+        Result r = new Result();
+        try (Observation.Scope ignored = obs.openScope()) {
+            return guarded(op, c, r);
+        } catch (RuntimeException e) {
+            boolean business = e instanceof InsufficientStockException || e instanceof ShopException s && s.type() == ProblemType.INVALID_STATE;
+            if (!business) obs.error(e);
+            throw e;
+        } finally {
+            obs.lowCardinalityKeyValue("outcome", r.outcome).highCardinalityKeyValue("shop.attempts", Integer.toString(r.attempts)).stop();
+        }
+    }
+
     /**
      * 13 站 6.4～6.7：一次呼叫。
      *   ① 隔艙：同時在等庫存服務的請求有上限，滿了立刻 503 —— 不排隊（6.6）
…
      *   ③ 熔斷器（只有下單路徑上往前走的兩種：reserve、gate-hot）開著 → 立刻 503，Retry-After = 它要開多久（6.7）
      *   ④ 沒有回應 → 再送一次，只在：還沒送滿 max-attempts、剩下的預算還夠一次、重試預算還有（6.5）
      */
-    private <T> T call(String op, Supplier<T> c) {
+    private <T> T guarded(String op, Supplier<T> c, Result r) {
         Bulkhead bulkhead = ORDER_PATH.contains(op) ? orderPath : others;
         if (!bulkhead.tryAcquirePermission()) {
             rejected(op, "bulkhead");
+            r.outcome = "bulkhead";
             throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務忙碌中，請稍後再試").with("retryAfter", 1);
         }
         try {
…
                 Duration timeout = attemptTimeout();
                 if (timeout == null) {
                     rejected(op, "budget");
+                    r.outcome = "budget";
                     throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "這一次的時間已經用完，請再送一次").with("retryAfter", 1);
                 }
                 if (breaker != null && !breaker.tryAcquirePermission()) {
                     rejected(op, "breaker");
+                    r.outcome = "breaker";
                     throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", openSeconds);
                 }
                 long t0 = System.nanoTime();
                 ATTEMPT.set(timeout);
+                r.attempts = attempt;
                 try {
                     T result = c.get();
                     if (breaker != null) breaker.onSuccess(System.nanoTime() - t0, TimeUnit.NANOSECONDS);
+                    r.outcome = "ok";
                     return result;
                 } catch (RestClientResponseException e) {                   // 對方回應了：照它說的
                     if (breaker != null) {                                  // 5xx 算失敗；4xx 是業務的結果（庫存不足、狀態不對），不算（05-service/06 的 6.7.6）
                         if (e.getStatusCode().is5xxServerError()) breaker.onError(System.nanoTime() - t0, TimeUnit.NANOSECONDS, e);
                         else breaker.onSuccess(System.nanoTime() - t0, TimeUnit.NANOSECONDS);
                     }
+                    r.outcome = e.getStatusCode().is5xxServerError() ? "5xx" : "4xx";
                     throw decode(op, e.getStatusCode().value(), e.getResponseBodyAsString());
                 } catch (ResourceAccessException e) {                       // 沒有回應：不知道它做了沒有 —— 每一支端點都可以重送（3.5）
                     if (breaker != null) breaker.onError(System.nanoTime() - t0, TimeUnit.NANOSECONDS, e);
…
                         continue;
                     }
                     log.error("INVENTORY_UNAVAILABLE op={}：送了 {} 次都沒有回應：{}", op, attempt, e.getMessage());
+                    r.outcome = "no_response";
                     throw new ShopException(ProblemType.TEMPORARILY_UNAVAILABLE, "庫存服務暫時無法使用，請稍後再試").with("retryAfter", 1);
                 } catch (RuntimeException e) {                              // 其他（解不開回應……）：我們的錯，不是庫存服務的
                     if (breaker != null) breaker.releasePermission();
```

**`src/main/resources/application.yml`**（7.4.3）

```diff
     timeout-scan-interval: 30s
 
 management:
+  tracing:
+    sampling:
+      # 13 站 7.8：Boot 的預設也是 0.1，寫出來是因為它是一個決定。100% 時一張下單 22 個 span、後端多 10 倍；
+      # 排查一次「誰慢了」只要幾條完整的 trace（7.11：5 分鐘 19 個 exemplar 就夠）。「每一張」要找的是日誌：traceId 不抽樣
+      probability: 0.1
+  observations:
+    enable:
+      # 13 站 7.4：Spring Security 6 的觀測每一個請求 5 個 span（filter chain 的前後、認證、授權、secured request）——
+      # 7.2 的 200 次下單與付款，559 個 span 裡 357 個是它們。認證不出行程（JWT 在記憶體裡驗），這幾段不是「誰慢了」會落在的地方
+      "[spring.security]": false
   metrics:
     distribution:
       slo:
```

**`src/main/resources/application-order-service.yml`**（7.4.2）

```diff
     jobs-enabled: false            # 熱點對帳、INV-2/INV-3 的對帳讀的是庫存的表 —— 那是庫存服務的排程
 
 spring:
+  application:
+    name: order-service            # 13 站 7.4：trace 的 service.name、JSON 日誌的 service 欄位。單體是 shop；兩個服務都叫 shop 的時候，後端分不出 span 是誰的（7.2）
   jpa:
     hibernate:
       ddl-auto: none               # 庫存的兩個實體還在 jar 裡、表不在這個庫裡：validate 會讓服務起不來（第 02 章 2.4.6）。
```

**`src/main/resources/application-inventory-service.yml`**（7.4.2）

```diff
       enabled: false               # 這個庫沒有 users
 
 spring:
+  application:
+    name: inventory-service        # 13 站 7.4：同 application-order-service.yml
   jpa:
     hibernate:
       ddl-auto: none               # 商品、訂單的實體還在 jar 裡、表不在這個庫裡
```

**`src/main/resources/application-prod.yml`**（7.4.1）

```diff
 management:
   server:
     port: 8081                     # 9.9：actuator（health、prometheus）只在這個埠；它不對外，負載平衡器與 Prometheus 從內部網路來
+  otlp:
+    tracing:
+      endpoint: ${SHOP_OTLP_ENDPOINT}   # 13 站 7.4：span 送到哪裡（OTLP/HTTP，例如 http://jaeger:4318/v1/traces）。跟其他 SHOP_* 一樣沒有預設值：少了就起不來
   endpoint:
     health:
       show-details: when-authorized
```

**`src/main/resources/logback-json.xml`**（7.4.5、7.10）

```diff
   第 09 章（9.7）：正式環境的日誌。application-prod.yml 的 logging.config 指到這裡；本機與測試照舊用 Boot 預設的文字格式。
   一行一個 JSON：@timestamp 一律 UTC（0.10.4：「第 09 章會把日誌也統一成 UTC」）、traceId / spanId（9.8）、userId、orderNo（0.6.6）。
   0.6.5：email、JWT 在編碼的最後一步再遮一次 —— 程式碼裡已經用 Email.mask()，這一層是給「某一行忘了遮」的
+  13 站 7.10：service 是 spring.application.name（單體 shop、兩個服務各自的名字）。原本寫死 "shop"：切開之後兩個服務的日誌都說自己是 shop。
+  springProperty 只有 Boot 載入這個檔的時候才認得（logging.config）；Logback 自己讀的時候（JsonLogFormatTest）是 :- 之後的 shop
 -->
 <configuration>
+  <springProperty scope="context" name="service" source="spring.application.name" defaultValue="shop"/>
   <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
     <encoder class="net.logstash.logback.encoder.LogstashEncoder">
       <timeZone>UTC</timeZone>
-      <customFields>{"service":"shop"}</customFields>
+      <customFields>{"service":"${service:-shop}"}</customFields>
       <fieldNames>
         <version>[ignore]</version>
         <levelValue>[ignore]</levelValue>
```

**`compose.yaml`**（7.3.2、7.9.4）

```diff
       SHOP_PAYMENT_CALLBACK_SECRET: compose-local-only-payment-callback-secret-0123
       SHOP_BOOTSTRAP_ADMIN_EMAIL: admin@example.com
       SHOP_BOOTSTRAP_ADMIN_PASSWORD: compose-local-only-admin-password
+      SHOP_OTLP_ENDPOINT: http://jaeger:4318/v1/traces   # 13 站 7.3
     ports: ["${SHOP_HTTP_PORT:-8080}:8080"]   # 8081（actuator）不對外
     healthcheck:
       test: ["CMD", "curl", "-fs", "localhost:8081/actuator/health/readiness"]
…
       migrate: {condition: service_completed_successfully}
       redis: {condition: service_healthy}
       rabbitmq: {condition: service_healthy}
+      jaeger: {condition: service_started}
 
   prometheus:
     image: prom/prometheus:v3.5.0
     profiles: [app]
-    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=7d"]
+    # 13 站 7.9：exemplar —— 直方圖的桶旁邊記著「落在這個桶裡的某一個請求的 traceId」，從「下單變慢」的告警一步走到一條 trace。v3.5 還要另外打開
+    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=7d", "--enable-feature=exemplar-storage"]
     volumes: [./docker/prometheus:/etc/prometheus:ro]
     ports: ["${SHOP_PROMETHEUS_PORT:-9090}:9090"]
     depends_on: [app, alertmanager]
…
     depends_on:
       mysql: {condition: service_healthy}
 
+  # 13 站 7.3：trace 的後端。OTLP/HTTP 收 4318（應用程式的 management.otlp.tracing.endpoint）、網頁與查詢 API 在 16686、
+  # 它自己的指標（收到幾個 span）在 14269。all-in-one 把資料放在記憶體裡：容器刪了就沒了，只適合本機與演練
+  jaeger:
+    image: jaegertracing/all-in-one:1.62.0
+    profiles: [app, tracing]
+    environment:
+      MEMORY_MAX_TRACES: "200000"
+    ports: ["${SHOP_JAEGER_UI_PORT:-16686}:16686", "${SHOP_OTLP_HTTP_PORT:-4318}:4318", "${SHOP_JAEGER_ADMIN_PORT:-14269}:14269"]
+
   # 13 站 3.8.6 的追記：契約的「中央倉庫」—— 呼叫端每一次建置把契約發布上來，提供端從這裡拿要驗證的契約、把結果發布回來，
   # 部署之前問它 can-i-deploy。只在 --profile contracts 時起；sqlite 只適合本機（資料在容器裡，容器刪了就沒了）
   pact-broker:
```

**`docker/prometheus/prometheus.yml`**（7.9.2）

```diff
 scrape_configs:
   - job_name: shop
     metrics_path: /actuator/prometheus
-    static_configs: [{targets: ["app:8081"]}]        # 管理埠（9.9）：只有從這裡進來才放行
+    # 13 站 7.9：system=shop —— 告警規則認這個標籤，不認 job 的名字。切開之後是兩個 job（order-service、inventory-service），同一個 system
+    static_configs: [{targets: ["app:8081"], labels: {system: shop}}]   # 管理埠（9.9）：只有從這裡進來才放行
   - job_name: rabbitmq
     metrics_path: /metrics/detailed                    # 每一個佇列一條（/metrics 只有加總，9.9）
     params: {family: [queue_coarse_metrics]}
```

**`docker/prometheus/alerts.yml`**（7.9）

```diff
 # 第 09 章（9.10）：告警規則。0.6.6 的七條，加上各章留給第 09 章的那幾個數字。
 # 每一條的 annotations.why 寫「為什麼是這個門檻、從哪一章來」；門檻是判斷的，寫明是判斷。
 # promtool test rules alerts_test.yml 會跑這些規則（docker/prometheus/test.sh）
+# 13 站 7.9：規則認 system="shop"（prometheus.yml 的 scrape 設定加上的標籤），不認 job 的名字 ——
+#   單體是一個 job（shop），切開之後是兩個（order-service、inventory-service）。第 12 站寫的是 job="shop"：19 條裡有 16 條，切開之後永遠不會響
+# 叫醒人的只有「使用者感受得到的」（shop-slo 這一組，只算 /api/**）。熔斷器、隔艙、預算、沒有回應這幾個是原因，不叫醒人：
+#   它們在被叫醒之後用 —— 儀表板、exemplar → trace（13 站 7.9）
 groups:
   - name: shop-slo                      # 0.6.6 的前兩條：使用者感受得到的
     rules:
       - alert: ShopHigh5xxRatio
         # 9.10 J8d：只看 5 分鐘窗的話，一次 60 秒的停機在恢復之後 4 分多鐘才響、響半分鐘自己好 —— 加一個 1 分鐘窗：現在還在發生才響
+        # 13 站 7.9：只算 /api/**（使用者送來的）。切開之後庫存服務的 /internal/** 也有 5xx —— 那是同一個失敗在下一層又數一次，
+        #   而且訂單服務對使用者的那一個 503 已經算過了；分母也不能有它們（服務之間的呼叫不是使用者的請求）
         expr: |
-          (sum(rate(http_server_requests_seconds_count{job="shop",status=~"5.."}[5m]))
-             / sum(rate(http_server_requests_seconds_count{job="shop"}[5m])) > 0.01)
+          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[5m]))
+             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[5m])) > 0.01)
           and
-          (sum(rate(http_server_requests_seconds_count{job="shop",status=~"5.."}[1m]))
-             / sum(rate(http_server_requests_seconds_count{job="shop"}[1m])) > 0.01)
+          (sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*",status=~"5.."}[1m]))
+             / sum(rate(http_server_requests_seconds_count{system="shop",uri=~"/api/.*"}[1m])) > 0.01)
         for: 5m
         labels: {severity: page}
         annotations:
…
         # 9.10 J8d：第一版只有 5 分鐘窗 —— Redis 停 60 秒，恢復之後 4 分 23 秒才 firing、31 秒後自己解除。加 1 分鐘窗
         expr: |
           ((
-            sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[5m]))
-            - sum(rate(http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",le="0.5"}[5m]))
-          ) / sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[5m])) > 0.01)
+            sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[5m]))
+            - sum(rate(http_server_requests_seconds_bucket{system="shop",uri="/api/orders",method="POST",le="0.5"}[5m]))
+          ) / sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[5m])) > 0.01)
           and
           ((
-            sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[1m]))
-            - sum(rate(http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",le="0.5"}[1m]))
-          ) / sum(rate(http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST"}[1m])) > 0.01)
+            sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[1m]))
+            - sum(rate(http_server_requests_seconds_bucket{system="shop",uri="/api/orders",method="POST",le="0.5"}[1m]))
+          ) / sum(rate(http_server_requests_seconds_count{system="shop",uri="/api/orders",method="POST"}[1m])) > 0.01)
         for: 5m
         labels: {severity: page}
         annotations:
…
   - name: shop-flow                     # 事件流：0.6.4 的「最終一致」有多久
     rules:
       - alert: ShopOutboxBacklog
-        expr: max(shop_outbox_oldest_age_seconds{job="shop"}) > 60
+        expr: max by (job) (shop_outbox_oldest_age_seconds{system="shop"}) > 60   # 13 站 7.9：by (job)，兩個服務各有一個 outbox
         labels: {severity: page}
         annotations:
-          summary: "最舊的未送出事件已經 {{ $value | humanizeDuration }}"
+          summary: "{{ $labels.job }}：最舊的未送出事件已經 {{ $value | humanizeDuration }}"
           why: "0.6.6、0.6.4（落帳、通知 60 秒）。9.2.1 那一種（relay 被卡住）就是靠它看見的"
       - alert: ShopOutboxUnroutable
-        expr: sum(increase(shop_outbox_rejected_total{job="shop",reason="unroutable"}[5m])) > 0
+        expr: sum(increase(shop_outbox_rejected_total{system="shop",reason="unroutable"}[5m])) > 0
         labels: {severity: page}
         annotations:
           summary: "有人訂閱的事件被 broker 退回：拓撲壞了"
           why: "9.2.1。沒有人訂閱的類型不送（shop_outbox_unsubscribed_total），這裡只剩「綁定不見了」"
       - alert: ShopConsumerLag
-        expr: max by (consumer) (shop_events_lag_seconds{job="shop",quantile="0.99"}) > 60
+        expr: max by (consumer) (shop_events_lag_seconds{system="shop",quantile="0.99"}) > 60
         for: 1m
         labels: {severity: page}
         annotations:
…
           summary: "{{ $labels.queue }} 有 {{ $value }} 則死信"
           why: "0.6.6：每一則死信都要有人看（7.5.5 的重放）"
       - alert: ShopUncountedReservationsOld
-        expr: max(shop_inventory_uncounted_oldest_age_seconds{job="shop"}) > 60
+        expr: max(shop_inventory_uncounted_oldest_age_seconds{system="shop"}) > 60
         labels: {severity: page}
         annotations:
           summary: "熱點預留 {{ $value | humanizeDuration }} 還沒落帳"
           why: "7.10：0.6.4 的 60 秒"
       - alert: ShopRefundFailed
-        expr: sum(increase(shop_refunds_failed_total{job="shop"}[15m])) > 0
+        expr: sum(increase(shop_refunds_failed_total{system="shop"}[15m])) > 0
         labels: {severity: page}
         annotations:
           summary: "退款重試用完仍然失敗"
…
   - name: shop-integrity                # 數字不對：每一個都應該永遠是 0
     rules:
       - alert: ShopReconciliationDiff
-        expr: max by (check) (shop_reconciliation_diff{job="shop"}) > 0
+        expr: max by (check) (shop_reconciliation_diff{system="shop"}) > 0
         labels: {severity: page}
         annotations:
           summary: "對帳 {{ $labels.check }} 差 {{ $value }} 筆"
           why: "0.6.6、7.10；8.7.3 證明它會變成 1"
       - alert: ShopHotStockShortage
-        expr: sum(increase(shop_inventory_hot_shortage_total{job="shop"}[15m])) > 0
+        expr: sum(increase(shop_inventory_hot_shortage_total{system="shop"}[15m])) > 0
         labels: {severity: page}
         annotations:
           summary: "熱點商品：回了 201、落帳時才發現不夠"
           why: "7.6.3：有人被答應了又反悔"
       - alert: ShopHotStockDrift
-        expr: sum(increase(shop_inventory_hot_drift_total{job="shop"}[15m])) > 0
+        expr: sum(increase(shop_inventory_hot_drift_total{system="shop"}[15m])) > 0
         labels: {severity: ticket}
         annotations:
           summary: "熱點對帳修正了 Redis 與 MySQL 的差異"
           why: "6.6：正常的系統這個計數器永遠是 0"
       - alert: ShopAuditDropped
-        expr: sum(increase(shop_audit_dropped_total{job="shop"}[5m])) > 0
+        expr: sum(increase(shop_audit_dropped_total{system="shop"}[5m])) > 0
         labels: {severity: page}
         annotations:
           summary: "有稽核沒有寫進 audit_logs"
…
   - name: shop-security
     rules:
       - alert: ShopPaymentCallbackRejected
-        expr: sum by (reason) (increase(shop_payment_callback_rejected_total{job="shop"}[5m])) > 0
+        expr: sum by (reason) (increase(shop_payment_callback_rejected_total{system="shop"}[5m])) > 0
         labels: {severity: page}
         annotations:
           summary: "付款回呼被拒絕（{{ $labels.reason }}）"
           why: "0.6.6：簽章錯誤任何一次就告警（可能是攻擊）；US-ORD-2 AC-4 金額不符"
       - alert: ShopAccessDeniedSuspects
-        expr: max(shop_audit_denied_suspects{job="shop"}) > 0
+        expr: max(shop_audit_denied_suspects{system="shop"}) > 0
         labels: {severity: page}
         annotations:
           summary: "{{ $value }} 位使用者過去一小時越權超過 50 次（是誰：日誌的 AUDIT_DENIED_SUSPECTS）"
           why: "US-ORD-5 AC-4；5.8.4：時間窗一小時"
       - alert: ShopLoginLockoutDegraded
-        expr: sum(increase(shop_login_lockout_degraded_total{job="shop"}[5m])) > 0
+        expr: sum(increase(shop_login_lockout_degraded_total{system="shop"}[5m])) > 0
         labels: {severity: page}
         annotations:
           summary: "Redis 不能用：登入失敗鎖定暫停中（fail-open）"
…
   - name: shop-dependencies
     rules:
       - alert: ShopDown
-        expr: up{job="shop"} == 0
+        expr: up{system="shop"} == 0
         for: 1m
         labels: {severity: page}
         annotations:
           summary: "Prometheus 抓不到 {{ $labels.instance }}"
           why: "連指標都抓不到"
       - alert: ShopRedisDegraded
-        expr: sum(increase(shop_redis_trips_total{job="shop"}[5m])) > 0
+        expr: sum(increase(shop_redis_trips_total{system="shop"}[5m])) > 0
         labels: {severity: warning}
         annotations:
           summary: "RedisGuard 跳開過：熱點下單 503、排行降級"
```

**`docker/prometheus/alerts_test.yml`**（7.9）

```diff
   # ① 5xx 2%：for 5m —— 4 分鐘時還沒響，6 分鐘時響了
   - interval: 15s
     input_series:
-      - series: 'http_server_requests_seconds_count{job="shop",status="200",uri="/api/products/{id}"}'
+      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="200",uri="/api/products/{id}"}'
         values: '0+980x60'
-      - series: 'http_server_requests_seconds_count{job="shop",status="503",uri="/api/orders"}'
+      - series: 'http_server_requests_seconds_count{job="shop",system="shop",status="503",uri="/api/orders"}'
         values: '0+20x60'
     alert_rule_test:
       - {eval_time: 4m, alertname: ShopHigh5xxRatio, exp_alerts: []}
…
   # ② 下單：每 15 秒 100 個，其中 2 個超過 500 ms（2% > 1%）
   - interval: 15s
     input_series:
-      - series: 'http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST",status="201"}'
+      - series: 'http_server_requests_seconds_count{job="shop",system="shop",uri="/api/orders",method="POST",status="201"}'
         values: '0+100x60'
-      - series: 'http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
+      - series: 'http_server_requests_seconds_bucket{job="shop",system="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
         values: '0+98x60'
     alert_rule_test:
       - eval_time: 6m
…
   # ②' 只有 0.5% 超過：不響
   - interval: 15s
     input_series:
-      - series: 'http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST",status="201"}'
+      - series: 'http_server_requests_seconds_count{job="shop",system="shop",uri="/api/orders",method="POST",status="201"}'
         values: '0+200x60'
-      - series: 'http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
+      - series: 'http_server_requests_seconds_bucket{job="shop",system="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
         values: '0+199x60'
     alert_rule_test:
       - {eval_time: 10m, alertname: ShopPlaceOrderSlow, exp_alerts: []}
…
   #     加了 1 分鐘窗：恢復之後 1 分鐘內就不成立，pending 等不到 5 分鐘 —— 不響
   - interval: 15s
     input_series:
-      - series: 'http_server_requests_seconds_count{job="shop",uri="/api/orders",method="POST",status="201"}'
+      - series: 'http_server_requests_seconds_count{job="shop",system="shop",uri="/api/orders",method="POST",status="201"}'
         values: '0+75x40'
-      - series: 'http_server_requests_seconds_bucket{job="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
+      - series: 'http_server_requests_seconds_bucket{job="shop",system="shop",uri="/api/orders",method="POST",status="201",le="0.5"}'
         values: '0+75x8 600+67x4 868+75x28'
     alert_rule_test:
       - {eval_time: 7m30s, alertname: ShopPlaceOrderSlow, exp_alerts: []}
…
   # ③ outbox：最舊的事件 45 秒 → 不響；75 秒 → 響（沒有 for）
   - interval: 15s
     input_series:
-      - series: 'shop_outbox_oldest_age_seconds{job="shop"}'
+      - series: 'shop_outbox_oldest_age_seconds{job="shop",system="shop"}'
         values: '0 15 30 45 60 75'
     alert_rule_test:
       - {eval_time: 45s, alertname: ShopOutboxBacklog, exp_alerts: []}
       - eval_time: 75s
         alertname: ShopOutboxBacklog
         exp_alerts:
-          - exp_labels: {severity: page}
-            exp_annotations: {summary: "最舊的未送出事件已經 1m 15s", why: "0.6.6、0.6.4（落帳、通知 60 秒）。9.2.1 那一種（relay 被卡住）就是靠它看見的"}
+          - exp_labels: {severity: page, job: shop}
+            exp_annotations: {summary: "shop：最舊的未送出事件已經 1m 15s", why: "0.6.6、0.6.4（落帳、通知 60 秒）。9.2.1 那一種（relay 被卡住）就是靠它看見的"}
   # ④ ⚠️ 陷阱（這一個測試描述的是「不會響」）：計數器在第一次發生時才註冊 —— 序列一出現就是 1，
   #    increase() 沒有前一個點可以比，算出來是 0。「任何一次就告警」的第一次永遠不會響。所以計數器要在啟動時先註冊成 0（④'）
   - interval: 15s
     input_series:
-      - series: 'shop_payment_callback_rejected_total{job="shop",reason="signature"}'
+      - series: 'shop_payment_callback_rejected_total{job="shop",system="shop",reason="signature"}'
         values: '_ _ _ _ 1 1 1 1 1 1'
     alert_rule_test:
       - {eval_time: 90s, alertname: ShopPaymentCallbackRejected, exp_alerts: []}
   # ④' 同一件事，計數器在啟動時就先註冊成 0
   - interval: 15s
     input_series:
-      - series: 'shop_payment_callback_rejected_total{job="shop",reason="signature"}'
+      - series: 'shop_payment_callback_rejected_total{job="shop",system="shop",reason="signature"}'
         values: '0 0 0 0 1 1 1 1 1 1'
     alert_rule_test:
       - eval_time: 90s
…
         exp_alerts:
           - exp_labels: {severity: page, reason: signature}
             exp_annotations: {summary: "付款回呼被拒絕（signature）", why: "0.6.6：簽章錯誤任何一次就告警（可能是攻擊）；US-ORD-2 AC-4 金額不符"}
+  # ⑤ 13 站 7.9：切開之後 —— 兩個 job，同一個 system。使用者的請求只到訂單服務：/api/orders 有 2% 是 503 → 響
+  - interval: 15s
+    input_series:
+      - series: 'http_server_requests_seconds_count{job="order-service",system="shop",status="201",uri="/api/orders"}'
+        values: '0+980x60'
+      - series: 'http_server_requests_seconds_count{job="order-service",system="shop",status="503",uri="/api/orders"}'
+        values: '0+20x60'
+      - series: 'http_server_requests_seconds_count{job="inventory-service",system="shop",status="204",uri="/internal/inventory/v1/reservations/{orderId}"}'
+        values: '0+1000x60'
+    alert_rule_test:
+      - eval_time: 6m
+        alertname: ShopHigh5xxRatio
+        exp_alerts:
+          - exp_labels: {severity: page}
+            exp_annotations:
+              summary: "5xx 超過 1%（2%），持續 5 分鐘"
+              why: "0.6.6。Redis 掛了的時候熱點下單照設計回 503（0.6.3），這條也會響 —— 那是一次事故，該響"
+  # ⑤' 庫存服務的 /internal/** 有一半是 503，但使用者的請求全部成功（例如重送在訂單服務那一層就成功了）→ 不響：
+  #     那不是使用者感受得到的。它是原因，排查的時候看（13 站 7.9）
+  - interval: 15s
+    input_series:
+      - series: 'http_server_requests_seconds_count{job="order-service",system="shop",status="201",uri="/api/orders"}'
+        values: '0+1000x60'
+      - series: 'http_server_requests_seconds_count{job="inventory-service",system="shop",status="503",uri="/internal/inventory/v1/reservations/{orderId}"}'
+        values: '0+500x60'
+      - series: 'http_server_requests_seconds_count{job="inventory-service",system="shop",status="204",uri="/internal/inventory/v1/reservations/{orderId}"}'
+        values: '0+500x60'
+    alert_rule_test:
+      - {eval_time: 10m, alertname: ShopHigh5xxRatio, exp_alerts: []}
+  # ⑥ 13 站 7.9：切開之後，outbox 的告警說得出是哪一個服務的
+  - interval: 15s
+    input_series:
+      - series: 'shop_outbox_oldest_age_seconds{job="order-service",system="shop"}'
+        values: '0 0 0 0 0 0'
+      - series: 'shop_outbox_oldest_age_seconds{job="inventory-service",system="shop"}'
+        values: '0 15 30 45 60 75'
+    alert_rule_test:
+      - eval_time: 75s
+        alertname: ShopOutboxBacklog
+        exp_alerts:
+          - exp_labels: {severity: page, job: inventory-service}
+            exp_annotations: {summary: "inventory-service：最舊的未送出事件已經 1m 15s", why: "0.6.6、0.6.4（落帳、通知 60 秒）。9.2.1 那一種（relay 被卡住）就是靠它看見的"}
```

**`src/test/java/com/example/shop/dist07/Spans.java`**（7.2.1、7.7.3）

```java
package com.example.shop.dist07;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.stream.Collectors;

/**
 * 13 站第 07 章的實驗：每一個服務「送出去」的 span（實驗在每一個服務裡掛一個收 span 的掛勾，SpanTap），跟追蹤的實作無關。
 * 印成一棵樹：同一個 traceId、依 parent 接起來；parent 不在任何一個收到的 span 裡 → 標出來（後端會把它當成斷掉的）。
 *
 * service 是後端會看到的服務名稱（spring.application.name）；role 是實驗自己知道「是哪一個 context 記的」—— 兩個不一樣，就是一個問題。
 */
public final class Spans {

    public record Rec(String role, String service, String traceId, String spanId, String parentId, String name, String kind,
                      long startMicros, long durationMicros, boolean error, Map<String, String> tags, List<String> events) {
        long endMicros() { return startMicros + durationMicros; }
    }

    public static final ConcurrentLinkedQueue<Rec> ALL = new ConcurrentLinkedQueue<>();

    private Spans() {}

    public static void reset() { ALL.clear(); }

    public static List<Rec> of(String traceId) {
        return ALL.stream().filter(s -> s.traceId().equals(traceId)).sorted(Comparator.comparingLong(Rec::startMicros)).toList();
    }

    public static Map<String, List<Rec>> byTrace() {
        return ALL.stream().collect(Collectors.groupingBy(Rec::traceId, LinkedHashMap::new, Collectors.toList()));
    }

    /** parent 在收到的 span 裡找不到（不是根、卻接不上任何一個） */
    public static boolean orphan(Rec s) {
        return s.parentId() != null && ALL.stream().noneMatch(o -> o.traceId().equals(s.traceId()) && o.spanId().equals(s.parentId()));
    }

    /** Spring Security 6 自己的觀測：每一個請求 5 個 span（filter chain 的前後、認證、授權、secured request）。印樹的時候收起來，它們的子 span 照印 */
    static boolean security(Rec s) {
        return s.name().startsWith("security filterchain") || s.name().startsWith("authenticate ") || s.name().startsWith("authorize ")
                || s.name().equals("secured request");
    }

    /** 根是「scheduled」的 trace：排程的每一輪（第 12 站 9.8.3 的 TracedJobs）；13 站 7.7 之後底下多了它借的連線 */
    public static boolean scheduledOnly(String traceId) {
        List<Rec> spans = of(traceId);
        return !spans.isEmpty() && spans.stream().filter(s -> s.parentId() == null).allMatch(s -> s.name().equals("scheduled"))
                && spans.stream().anyMatch(s -> s.parentId() == null);
    }

    /** 一個 trace 印成一棵樹：每一行是「距第一個 span 開始幾毫秒、多久、[服務] 名稱」 */
    public static List<String> tree(String traceId) {
        List<Rec> spans = of(traceId);
        List<String> out = new ArrayList<>();
        if (spans.isEmpty()) { out.add("（這個 trace 一個 span 都沒有）"); return out; }
        long t0 = spans.get(0).startMicros();
        long end = spans.stream().mapToLong(Rec::endMicros).max().orElse(t0);
        long sec = spans.stream().filter(Spans::security).count();
        out.add(String.format("trace %s：%d 個 span%s，第一個開始到最後一個結束 %,.1f ms", traceId, spans.size(),
                sec == 0 ? "" : "（其中 Spring Security 的 " + sec + " 個，下面不印）", (end - t0) / 1000.0));
        Set<String> ids = spans.stream().map(Rec::spanId).collect(Collectors.toSet());
        Set<String> printed = new HashSet<>();
        for (Rec root : spans)
            if (root.parentId() == null || !ids.contains(root.parentId())) print(root, spans, t0, 0, out, printed);
        return out;
    }

    private static void print(Rec s, List<Rec> spans, long t0, int depth, List<String> out, Set<String> printed) {
        if (!printed.add(s.spanId())) return;
        int next = depth;
        if (!security(s)) {
            String note = s.parentId() == null ? "" : depth == 0 ? "  ← parent " + s.parentId() + " 不在任何一個 span 裡" : "";
            out.add(String.format("%+9.1f ms %10.1f ms  %s[%s%s] %s%s%s%s%s", (s.startMicros() - t0) / 1000.0, s.durationMicros() / 1000.0,
                    "  ".repeat(depth), s.service(), s.service().equals(s.role()) ? "" : "：其實是 " + s.role(), s.name(),
                    s.kind() == null || s.kind().equals("null") ? "" : " " + s.kind(), s.error() ? "  ERROR" : "", tags(s), note));
            for (String e : s.events()) out.add(" ".repeat(26) + "  ".repeat(depth + 1) + "· " + e);
            next = depth + 1;
        }
        for (Rec c : spans) if (s.spanId().equals(c.parentId())) print(c, spans, t0, next, out, printed);
    }

    /** 一段時間：哪一個服務、哪一段、幾毫秒 */
    public record Part(String service, String what, double ms) {}

    /**
     * 13 站 7.7：買家等的那一段（根 span 開始到結束），時間花在哪裡。每一個 span 的 self time = 它的長度 − 子 span 蓋住的部分
     * （client span 的 self time 是「送出去到收到回應」裡、對方的 server span 沒有蓋到的：網路、對方的 Tomcat 佇列、回應在路上）。
     * db connection 拆成兩段：開頭到 acquired 事件是「等連線」，之後是「拿著連線」（交易做多久）。根結束之後的（消費者）不算：買家沒有在等它們
     */
    public static List<Part> selfTimes(String traceId) {
        List<Rec> spans = of(traceId).stream().filter(x -> !security(x)).toList();
        Rec root = spans.stream().filter(x -> x.parentId() == null).findFirst().orElse(null);
        if (root == null) return List.of();
        long end = root.endMicros();
        List<Part> parts = new ArrayList<>();
        for (Rec x : spans) {
            if (x.startMicros() >= end) continue;
            long xEnd = Math.min(x.endMicros(), end);
            List<long[]> covered = new ArrayList<>();
            for (Rec c : spans)
                if (x.spanId().equals(c.parentId()))
                    covered.add(new long[]{Math.max(c.startMicros(), x.startMicros()), Math.min(c.endMicros(), xEnd)});
            long self = (xEnd - x.startMicros()) - union(covered);
            String label = x.name() + (x.kind().equals("CLIENT") && x.tags().containsKey("uri") ? " " + x.tags().get("uri") + "（client：送出去到收到回應）" : "");
            if (x.name().equals("db connection")) {
                double wait = x.events().stream().filter(e -> e.endsWith(" acquired")).mapToDouble(e -> Double.parseDouble(e.substring(0, e.indexOf(" ms")))).findFirst().orElse(0);
                parts.add(new Part(x.service(), "db connection：等連線", wait));
                parts.add(new Part(x.service(), "db connection：拿著連線", self / 1000.0 - wait));
            } else {
                parts.add(new Part(x.service(), label, self / 1000.0));
            }
        }
        // 同一個服務、同一段的加起來（一張下單借好幾次連線）
        java.util.Map<String, Part> sum = new java.util.LinkedHashMap<>();
        for (Part p : parts) sum.merge(p.service() + "|" + p.what(), p, (a, b) -> new Part(a.service(), a.what(), a.ms() + b.ms()));
        return sum.values().stream().sorted(Comparator.comparingDouble(Part::ms).reversed()).toList();
    }

    static long union(List<long[]> ranges) {
        List<long[]> r = ranges.stream().filter(a -> a[1] > a[0]).sorted(Comparator.comparingLong(a -> a[0])).toList();
        long total = 0, curS = -1, curE = -1;
        for (long[] a : r) {
            if (a[0] > curE) { if (curE > curS) total += curE - curS; curS = a[0]; curE = a[1]; }
            else curE = Math.max(curE, a[1]);
        }
        if (curE > curS) total += curE - curS;
        return total;
    }

    /** self time 前 n 名，一行 */
    public static String top(String traceId, int n) {
        List<Part> parts = selfTimes(traceId);
        Rec root = of(traceId).stream().filter(x -> x.parentId() == null).findFirst().orElse(null);
        StringBuilder b = new StringBuilder(String.format("買家等了 %,.1f ms，花在：", root == null ? 0 : root.durationMicros() / 1000.0));
        for (int i = 0; i < Math.min(n, parts.size()); i++)
            b.append(String.format("%s[%s] %s %,.1f ms", i == 0 ? "" : "；", parts.get(i).service(), parts.get(i).what(), parts.get(i).ms()));
        return b.toString();
    }

    /** 每一種 span 只印幾個看得懂的 tag */
    static String tags(Rec s) {
        List<String> keep = new ArrayList<>();
        s.tags().forEach((k, v) -> {
            if (k.equals("uri") || k.equals("status") || k.equals("exception") || k.startsWith("shop.")) keep.add(k + "=" + v);
        });
        return keep.isEmpty() ? "" : "  " + String.join(" ", keep);
    }
}
```

**`src/test/java/com/example/shop/dist07/SpanTap.java`**（7.2.1；這是 7.4 之後的版本）

```java
package com.example.shop.dist07;

import com.example.shop.shared.config.ShopProperties;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.SpanId;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import io.opentelemetry.sdk.trace.ReadWriteSpan;
import io.opentelemetry.sdk.trace.ReadableSpan;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.data.SpanData;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站 7.2：在每一個服務裡收它送出去的 span。第一個 commit 是 Brave 的 SpanHandler；7.4 換成 OpenTelemetry 之後是一個 SpanProcessor
 * （Boot 把每一個 SpanProcessor 的 bean 接到 SdkTracerProvider 上，跟送 OTLP 的那一個 BatchSpanProcessor 並排）：
 * 每一個結束、而且被抽到的 span 記一筆。記的是後端會收到的那幾個欄位：service.name（resource）、traceId、spanId、parent、名稱、開始與長度、屬性、事件。
 * 同步收，不經過 BatchSpanProcessor 的 5 秒 —— 實驗印樹的時候不用等。
 */
@Configuration
@ConditionalOnProperty(name = "lab.d07.span-tap", havingValue = "true")
public class SpanTap {

    static final AttributeKey<String> SERVICE_NAME = AttributeKey.stringKey("service.name");

    @Bean
    SpanProcessor d07SpanTap(ShopProperties props) {
        String role = props.deployment().role().serviceName();
        return new SpanProcessor() {
            @Override public void onStart(Context parentContext, ReadWriteSpan span) {}
            @Override public boolean isStartRequired() { return false; }
            @Override public boolean isEndRequired() { return true; }

            @Override
            public void onEnd(ReadableSpan span) {
                SpanData d = span.toSpanData();
                Map<String, String> tags = new TreeMap<>();
                d.getAttributes().forEach((k, v) -> tags.put(k.getKey(), String.valueOf(v)));
                List<String> events = new ArrayList<>();
                d.getEvents().forEach(e -> events.add(String.format("%+.1f ms %s", (e.getEpochNanos() - d.getStartEpochNanos()) / 1e6, e.getName())));
                String parent = SpanId.isValid(d.getParentSpanId()) ? d.getParentSpanId() : null;
                Spans.ALL.add(new Spans.Rec(role, d.getResource().getAttribute(SERVICE_NAME), d.getTraceId(), d.getSpanId(), parent,
                        d.getName(), d.getKind().name(), d.getStartEpochNanos() / 1000, (d.getEndEpochNanos() - d.getStartEpochNanos()) / 1000,
                        d.getStatus().getStatusCode() == StatusCode.ERROR, tags, events));
            }
        };
    }
}
```

**`src/test/java/com/example/shop/dist07/Calls.java`**（7.2）

```java
package com.example.shop.dist07;

import com.example.shop.dist00.SplitLab;
import com.example.shop.payment.internal.CallbackSignature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 13 站第 07 章的實驗：買家、金流的動作，全部走 HTTP、打訂單服務。跟第 03 章的 Shop 一樣，只多回傳一樣東西：
 * 回應的 X-Trace-Id（第 12 站 9.8.3）—— 這一章要拿它去找 span 與日誌，就像客服拿著買家畫面上的那一串字。
 */
final class Calls {

    static final ObjectMapper JSON = new ObjectMapper();

    record Res(int status, String body, long millis, String traceId) {
        JsonNode json() {
            try { return JSON.readTree(body); } catch (Exception e) { throw new IllegalStateException(body, e); }
        }
    }

    private Calls() {}

    static Res send(int port, String method, String path, String token, Object body, Map<String, String> headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(60)).header("Content-Type", "application/json")
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        if (token != null) b.header("Authorization", token);
        headers.forEach(b::header);
        long t0 = System.nanoTime();
        HttpResponse<String> r = SplitLab.CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
        return new Res(r.statusCode(), r.body(), (System.nanoTime() - t0) / 1_000_000, r.headers().firstValue("X-Trace-Id").orElse(null));
    }

    /** 下單：每個商品 1 件、單價 100 */
    static Res place(int port, String buyerToken, long... products) throws Exception {
        List<Map<String, Object>> items = new ArrayList<>();
        for (long p : products) items.add(Map.of("productId", p, "quantity", 1, "unitPrice", new BigDecimal("100.00")));
        return send(port, "POST", "/api/orders", buyerToken, Map.of("items", items), Map.of("Idempotency-Key", UUID.randomUUID().toString()));
    }

    /** 建立付款、送出簽好章的金流回呼（成功）。回傳回呼的回應 —— 它的 X-Trace-Id 就是 order.paid 那一串事件的 traceId */
    static Res pay(int port, String buyerToken, String orderNo, String callbackSecret) throws Exception {
        Res p = send(port, "POST", "/api/orders/" + orderNo + "/payments", buyerToken, null, Map.of());
        if (p.status() != 201) throw new IllegalStateException("建立付款 " + p.status() + " " + p.body());
        long paymentId = p.json().get("paymentId").asLong();
        BigDecimal amount = new BigDecimal(p.json().get("amount").asText());
        String txn = "d07-" + UUID.randomUUID();
        return send(port, "POST", "/api/payments/callback", null, Map.of("paymentId", paymentId, "providerTxnId", txn, "amount", amount,
                "result", "SUCCEEDED", "signature", CallbackSignature.sign(callbackSecret, CallbackSignature.canonical(paymentId, txn, amount, true))), Map.of());
    }
}
```

**`src/test/java/com/example/shop/dist07/H1SlowOrderTraceTest.java`**（7.2、7.7.4）

```java
package com.example.shop.dist07;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.DbTap;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Flow;
import com.example.shop.dist03.LostResponse;
import com.example.shop.dist03.Roles;
import com.example.shop.dist04.Nodes;
import com.example.shop.dist04.TraceTap;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 13 站 7.2：一張慢的下單，在線上查得到慢在哪一段嗎？
 *
 * 第 06 章 6.2 的那 6 秒：庫存服務的預留做完、回應晚 3 秒（第 03 章的 LostResponse），訂單服務等 3 秒、再送一次、再等 3 秒。
 * 兩個服務用正式的角色、事件走 RabbitMQ。每一個服務掛一個收 span 的掛勾（SpanTap），抽樣 100%：先看「每一個 span 都送了」的時候，
 * 後端會拿到什麼。三件事：
 *   ① 一張正常的下單、一張慢的下單（6.2 的設定：read timeout 3 秒、最多送 2 次、預算放寬到 10 秒）：trace 長什麼樣子、庫存服務的 span 在哪裡
 *   ② 付款 → order.paid → 庫存服務的消費者：接得上嗎
 *   ③ 同一張慢的下單，第 06 章的設定（read 1 秒、預算 2 秒）
 * 7.7 之後（OpenTelemetry、收的那一邊接上、MQ 帶 traceparent、shop.remote.call、db connection）再加三種「慢」，每一種印 self time 的前三名：
 *   ④ 庫存服務的連線池：每個預留交易 +300 ms（SlowSql）、連線池 4 條，6 張同時送
 *   ⑤ 訂單服務自己的交易：INSERT INTO orders +800 ms
 *   ⑥ 熔斷器開著：20 張同時送、每一次預留都晚 3 秒回應 → 熔斷器打開 → 下一張；之後 30 秒沒有人下單，熔斷器的指標是什麼
 *
 *   mvn test -Pexperiments -Dtest=H1SlowOrderTraceTest
 */
@Tag("experiment")
class H1SlowOrderTraceTest {

    static final long BUYER = 7_100_001;
    /** 第 06 章之前的設定（6.2）：read timeout 3 秒、最多送 2 次。預算與排程補償的門檻要跟著放寬，不然起不來（6.4.2 的兩條檢查） */
    static final List<String> BEFORE_06 = List.of("--shop.deployment.inventory.read-timeout=3s", "--shop.order.placement-budget=10s",
            "--shop.order.placement-timeout=100s");
    final PrintStream out = System.out;

    @Test
    void slowOrder() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        LostResponse.reset();
        TraceTap.reset();
        Spans.reset();
        SlowSql.set(0);
        List<String> lab = List.of("--lab.d07.span-tap=true", "--management.tracing.sampling.probability=1.0");
        ConfigurableApplicationContext inv = Roles.inventoryService(Nodes.with(Broker.args(), lab, List.of("--lab.d03.lost-response=true", "--lab.d04.trace-tap=true",
                "--spring.datasource.url=" + SplitLab.url(Split.INV_DB) + "&queryInterceptors=" + DbTap.class.getName() + "," + SlowSql.class.getName(),
                "--spring.datasource.hikari.maximum-pool-size=4")));
        List<String> orderDb = List.of("--spring.datasource.url=" + SplitLab.url(Split.ORDER_DB) + "&queryInterceptors=" + DbTap.class.getName() + "," + SlowSql.class.getName());
        try {
            ConfigurableApplicationContext order = Roles.orderService(inv, Nodes.with(Broker.args(), lab, BEFORE_06, orderDb));
            try {
                SplitLab.seed(Split.ORDER_DB, true, false);
                SplitLab.seed(Split.INV_DB, false, true);
                Calls.Res rebuilt = Calls.send(SplitLab.port(order), "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(order, 1, Role.ADMIN), null, Map.of());
                if (rebuilt.status() != 200) throw new IllegalStateException("重建副本 " + rebuilt.status() + " " + rebuilt.body());
                for (int i = 0; i < 20; i++) Calls.place(SplitLab.port(order), TestTokens.bearer(order, BUYER + 100 + i), SplitLab.FIRST_PRODUCT + i);   // 暖機
                Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 30_000);
                Spans.reset();
                TraceTap.reset();

                ShopProperties.Remote r = order.getBean(ShopProperties.class).deployment().inventory();
                out.printf("═══ 7.2 ① 一張正常的下單（抽樣 100%%；6.2 的設定：read %d ms、最多送 %d 次、下單的預算 %d ms）（load %s）═══%n",
                        r.readTimeout().toMillis(), r.maxAttempts(), order.getBean(ShopProperties.class).order().placementBudget().toMillis(), SplitLab.load());
                Calls.Res ok = Calls.place(SplitLab.port(order), TestTokens.bearer(order, BUYER), SplitLab.FIRST_PRODUCT + 500);
                Thread.sleep(500);
                out.printf("  回應 %d（%,d ms），X-Trace-Id %s%n", ok.status(), ok.millis(), ok.traceId());
                printTraces(ok.traceId());
                seen();
                top(ok.traceId());

                out.printf("═══ 7.2 ① 一張慢的下單：庫存服務做完預留、回應晚 3 秒（load %s）═══%n", SplitLab.load());
                slow(order);

                out.printf("═══ 7.2 ② 付款 → order.paid → 兩個服務的消費者（load %s）═══%n", SplitLab.load());
                Spans.reset();
                String orderNo = ok.json().get("orderNo").asText();
                Calls.Res paid = Calls.pay(SplitLab.port(order), TestTokens.bearer(order, BUYER), orderNo, order.getBean(ShopProperties.class).payment().callbackSecret());
                Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 30_000);
                Thread.sleep(500);
                out.printf("  金流回呼 %d，X-Trace-Id %s%n", paid.status(), paid.traceId());
                printTraces(paid.traceId());
            } finally {
                order.close();
            }

            ConfigurableApplicationContext after06 = Roles.orderService(inv, Nodes.with(Broker.args(), lab, orderDb));
            try {
                ShopProperties p = after06.getBean(ShopProperties.class);
                out.printf("═══ 7.2 ③ 同一張慢的下單，第 06 章的設定（read %d ms、最多送 %d 次、下單的預算 %d ms）（load %s）═══%n",
                        p.deployment().inventory().readTimeout().toMillis(), p.deployment().inventory().maxAttempts(), p.order().placementBudget().toMillis(), SplitLab.load());
                slow(after06);
                more(after06);
            } finally {
                after06.close();
            }
        } finally {
            if (inv.isActive()) inv.close();
            LostResponse.reset();
            SlowSql.set(0);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 接下來兩次預留（第一次與重送）都晚 3 秒回應 */
    void slow(ConfigurableApplicationContext order) throws Exception {
        Spans.reset();
        TraceTap.reset();
        LostResponse.arm("PUT", "/reservations/", 3_000, 2);
        Calls.Res slow = Calls.place(SplitLab.port(order), TestTokens.bearer(order, BUYER + 1), SplitLab.FIRST_PRODUCT + 501);
        Thread.sleep(4_000);                                                // 庫存服務那一邊，第二次的回應還要再 3 秒才送出
        out.printf("  回應 %d（%,d ms），X-Trace-Id %s%n", slow.status(), slow.millis(), slow.traceId());
        printTraces(slow.traceId());
        seen();
        top(slow.traceId());
        LostResponse.reset();
    }

    /** 13 站 7.7：self time 的前三名 */
    void top(String traceId) {
        out.println("  " + Spans.top(traceId, 3));
    }

    /** 13 站 7.7：④ 連線池、⑤ 訂單服務自己的交易、⑥ 熔斷器 */
    void more(ConfigurableApplicationContext order) throws Exception {
        int port = SplitLab.port(order);
        out.printf("═══ 7.7 ④ 庫存服務的連線池：每個預留交易 +300 ms、連線池 4 條，6 張同時送（load %s）═══%n", SplitLab.load());
        Spans.reset();
        SlowSql.set(300);
        Thread.sleep(500);
        List<Calls.Res> pool = parallel(6, i -> Calls.place(port, TestTokens.bearer(order, BUYER + 10 + i), SplitLab.FIRST_PRODUCT + 510 + i));
        SlowSql.set(0);
        Thread.sleep(2_000);
        out.printf("  6 張：%s%n", pool.stream().map(r -> r.status() + "（" + r.millis() + " ms）").toList());
        Calls.Res slowest = pool.stream().filter(r -> r.status() == 201).max(java.util.Comparator.comparingLong(Calls.Res::millis)).orElseThrow();
        out.printf("  最慢的一張 %d（%,d ms），X-Trace-Id %s%n", slowest.status(), slowest.millis(), slowest.traceId());
        Spans.tree(slowest.traceId()).forEach(l -> out.println("    " + l));
        top(slowest.traceId());

        out.printf("═══ 7.7 ⑤ 訂單服務自己的交易：INSERT INTO orders +800 ms（load %s）═══%n", SplitLab.load());
        Spans.reset();
        SlowSql.set(800, "insert into orders");
        Thread.sleep(500);
        Calls.Res own = Calls.place(port, TestTokens.bearer(order, BUYER + 20), SplitLab.FIRST_PRODUCT + 520);
        SlowSql.set(0);
        Thread.sleep(1_000);
        out.printf("  回應 %d（%,d ms），X-Trace-Id %s%n", own.status(), own.millis(), own.traceId());
        Spans.tree(own.traceId()).forEach(l -> out.println("    " + l));
        top(own.traceId());

        out.printf("═══ 7.7 ⑥ 熔斷器開著：20 張同時送、每一次預留都晚 3 秒回應（load %s）═══%n", SplitLab.load());
        Spans.reset();
        LostResponse.arm("PUT", "/reservations/", 3_000, 40);
        List<Calls.Res> trip = parallel(20, i -> Calls.place(port, TestTokens.bearer(order, BUYER + 30 + i), SplitLab.FIRST_PRODUCT + 530 + i));
        out.printf("  20 張：%s；熔斷器 %s%n", codes(trip), breaker(order));
        Spans.reset();
        Calls.Res blocked = Calls.place(port, TestTokens.bearer(order, BUYER + 60), SplitLab.FIRST_PRODUCT + 560);
        Thread.sleep(500);
        out.printf("  下一張 %d（%,d ms）%s，X-Trace-Id %s%n", blocked.status(), blocked.millis(), blocked.body().contains("暫時無法使用") ? "「庫存服務暫時無法使用」" : blocked.body(), blocked.traceId());
        Spans.tree(blocked.traceId()).forEach(l -> out.println("    " + l));
        top(blocked.traceId());
        LostResponse.reset();
        for (int s = 10; s <= 30; s += 10) {
            Thread.sleep(10_000);
            out.printf("  沒有人下單，第 %d 秒：熔斷器 %s%n", s, breaker(order));
        }
        for (int i = 0; i < 4; i++) {
            Calls.Res r = Calls.place(port, TestTokens.bearer(order, BUYER + 70 + i), SplitLab.FIRST_PRODUCT + 570 + i);
            out.printf("  第 %d 張下單 %d → 熔斷器 %s%n", i + 1, r.status(), breaker(order));
        }
    }

    interface Call { Calls.Res place(int i) throws Exception; }

    static List<Calls.Res> parallel(int n, Call c) throws Exception {
        try (var ex = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            List<java.util.concurrent.Future<Calls.Res>> fs = new java.util.ArrayList<>();
            for (int i = 0; i < n; i++) { int k = i; fs.add(ex.submit(() -> c.place(k))); }
            List<Calls.Res> out = new java.util.ArrayList<>();
            for (var f : fs) out.add(f.get());
            return out;
        }
    }

    static Map<Integer, Long> codes(List<Calls.Res> rs) {
        return rs.stream().collect(java.util.stream.Collectors.groupingBy(Calls.Res::status, java.util.TreeMap::new, java.util.stream.Collectors.counting()));
    }

    /** resilience4j_circuitbreaker_state{name="inventory-reserve"}：值是 1 的那一個 state */
    static String breaker(ConfigurableApplicationContext order) {
        var m = order.getBean(io.micrometer.core.instrument.MeterRegistry.class);
        return m.find("resilience4j.circuitbreaker.state").tag("name", "inventory-reserve").gauges().stream()
                .filter(g -> g.value() == 1).map(g -> g.getId().getTag("state")).findFirst().orElse("?");
    }

    /** 先印這個 traceId 的樹；再印同一段時間裡其他的 trace（庫存服務的 span 如果沒有接上，會在這裡） */
    void printTraces(String traceId) {
        out.println("  這個 traceId：");
        Spans.tree(traceId).forEach(l -> out.println("    " + l));
        Set<String> others = new LinkedHashSet<>();
        Spans.ALL.stream().filter(s -> !s.traceId().equals(traceId)).forEach(s -> others.add(s.traceId()));
        long jobs = others.stream().filter(Spans::scheduledOnly).count();
        out.printf("  同一段時間裡的其他 trace：%d 個（另外 %d 個是排程的一輪，不印）%n", others.size() - jobs, jobs);
        for (String t : others) if (!Spans.scheduledOnly(t)) Spans.tree(t).forEach(l -> out.println("    " + l));
    }

    void seen() {
        for (TraceTap.Seen s : TraceTap.SEEN)
            out.printf("  庫存服務 │ %s %s │ 收到的 traceparent=%s │ 日誌用的 traceId %s%n", s.method(), s.path(), s.traceparent(), s.mdcTraceId());
    }
}
```

**`src/test/java/com/example/shop/dist07/H2SamplingTest.java`**（7.2.4、7.8.1）

```java
package com.example.shop.dist07;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Flow;
import com.example.shop.dist03.Roles;
import com.example.shop.dist04.Nodes;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/**
 * 13 站 7.2：抽樣之後，後端收到的 trace 有幾個是完整的？
 *
 * 抽樣率用 Boot 的預設（management.tracing.sampling.probability = 0.1）。200 次「下單 → 付款」，每一次：
 *   下單：訂單服務的 POST /api/orders → 庫存服務的預留（HTTP）
 *   付款：金流回呼 → order.paid → 庫存服務的消費者（確認預留）、訂單服務的消費者（通知）
 * 每一個服務掛一個收 span 的掛勾（SpanTap）。用回應的 X-Trace-Id 去找：每一段有沒有被送出去、在不在同一個 trace 裡、接不接得上。
 *
 *   mvn test -Pexperiments -Dtest=H2SamplingTest
 */
@Tag("experiment")
class H2SamplingTest {

    static final long BUYER = 7_200_001;
    static final int N = Integer.getInteger("h2.n", 200);
    final PrintStream out = System.out;

    @Test
    void sampling() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        Spans.reset();
        List<String> lab = new ArrayList<>(List.of("--lab.d07.span-tap=true"));
        String p = System.getProperty("h2.probability");
        if (p != null) lab.add("--management.tracing.sampling.probability=" + p);
        ConfigurableApplicationContext inv = Roles.inventoryService(Nodes.with(Broker.args(), lab));
        try (ConfigurableApplicationContext order = Roles.orderService(inv, Nodes.with(Broker.args(), lab))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Calls.Res rebuilt = Calls.send(SplitLab.port(order), "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(order, 1, Role.ADMIN), null, Map.of());
            if (rebuilt.status() != 200) throw new IllegalStateException("重建副本 " + rebuilt.status() + " " + rebuilt.body());
            Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 30_000);
            Spans.reset();

            out.printf("═══ 7.2 ④ 抽樣（management.tracing.sampling.probability = %s）：%d 次「下單 → 付款」（load %s）═══%n",
                    order.getEnvironment().getProperty("management.tracing.sampling.probability", "沒有設定（Boot 的預設 0.1）"), N, SplitLab.load());
            String secret = order.getBean(ShopProperties.class).payment().callbackSecret();
            List<String> placed = new ArrayList<>(), paid = new ArrayList<>();
            int withHeader = 0;
            for (int i = 0; i < N; i++) {
                String token = TestTokens.bearer(order, BUYER + i);
                Calls.Res r = Calls.place(SplitLab.port(order), token, SplitLab.FIRST_PRODUCT + i % SplitLab.PRODUCTS);
                if (r.status() != 201) throw new IllegalStateException("下單 " + r.status() + " " + r.body());
                Calls.Res c = Calls.pay(SplitLab.port(order), token, r.json().get("orderNo").asText(), secret);
                if (c.status() != 200) throw new IllegalStateException("回呼 " + c.status() + " " + c.body());
                placed.add(r.traceId());
                paid.add(c.traceId());
                if (r.traceId() != null && c.traceId() != null) withHeader++;
            }
            Flow.quiet(List.of(order, inv), List.of(Split.ORDER_DB, Split.INV_DB), 60_000);
            Thread.sleep(1_000);

            out.printf("  回應帶著 X-Trace-Id 的：%d / %d 次（下單與回呼都有）%n", withHeader, N);
            report(placed, paid);
        } finally {
            if (inv.isActive()) inv.close();
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    void report(List<String> placed, List<String> paid) {
        Predicate<Spans.Rec> orderServer = s -> s.role().equals("order-service") && s.name().equals("http post /api/orders");
        Predicate<Spans.Rec> reservation = s -> s.role().equals("inventory-service") && s.name().startsWith("http put /internal/inventory/v1/reservations");
        Predicate<Spans.Rec> callback = s -> s.role().equals("order-service") && s.name().equals("http post /api/payments/callback");
        Predicate<Spans.Rec> invConsumer = s -> s.role().equals("inventory-service") && s.name().equals("consume inventory.order-events");
        Predicate<Spans.Rec> ntfConsumer = s -> s.role().equals("order-service") && s.name().equals("consume notification.order-events");

        Set<String> placedSet = Set.copyOf(placed), paidSet = Set.copyOf(paid);
        long orderKept = count(placed, orderServer);
        long joined = placed.stream().filter(t -> has(t, orderServer) && has(t, reservation)).count();
        List<Spans.Rec> reserves = Spans.ALL.stream().filter(reservation).toList();
        long reserveRoots = reserves.stream().filter(s -> s.parentId() == null).count();
        long reserveInPlaced = reserves.stream().filter(s -> placedSet.contains(s.traceId())).count();
        out.printf("  下單 %d 次 │ 訂單服務的 span 送出去的：%d 個 trace │ 同一個 trace 裡也有庫存服務的預留：%d 個%n", placed.size(), orderKept, joined);
        out.printf("             │ 庫存服務的預留 span 送出去的：%d 個；自己是一個 trace 的根：%d 個；traceId 是哪一張下單的：%d 個%n",
                reserves.size(), reserveRoots, reserveInPlaced);

        long cbKept = count(paid, callback);
        List<Spans.Rec> invC = Spans.ALL.stream().filter(invConsumer).toList(), ntfC = Spans.ALL.stream().filter(ntfConsumer).toList();
        long invInPaid = invC.stream().filter(s -> paidSet.contains(s.traceId())).count();
        long bothCbInv = paid.stream().filter(t -> has(t, callback) && has(t, invConsumer)).count();
        long invParentFound = invC.stream().filter(s -> !Spans.orphan(s)).count();
        out.printf("  付款 %d 次 │ 回呼的 span 送出去的：%d 個 │ 庫存服務消費 order.paid 的 span 送出去的：%d 個（traceId 是哪一次回呼的：%d 個；那一次回呼的 span 也在的：%d 個）%n",
                paid.size(), cbKept, invC.size(), invInPaid, bothCbInv);
        out.printf("             │ 通知的消費者 span 送出去的：%d 個 │ 消費者 span 的 parent 找得到的：庫存 %d / %d、通知 %d / %d%n",
                ntfC.size(), invParentFound, invC.size(), ntfC.stream().filter(s -> !Spans.orphan(s)).count(), ntfC.size());

        long fullPlace = placed.stream().filter(t -> has(t, orderServer) && has(t, reservation) && Spans.of(t).stream().noneMatch(Spans::orphan)).count();
        long fullPay = paid.stream().filter(t -> has(t, callback) && has(t, invConsumer) && has(t, ntfConsumer)
                && Spans.of(t).stream().noneMatch(Spans::orphan)).count();
        long partialPlace = placed.stream().filter(t -> has(t, orderServer) != has(t, reservation)).count();
        out.printf("  完整的下單 trace（訂單、庫存兩段都在、每一個 span 都接得上）：%d 個；只有其中一段的：%d 個%n", fullPlace, partialPlace);
        out.printf("  完整的付款 trace（回呼、兩個消費者都在、每一個 span 都接得上）：%d 個%n", fullPay);
        out.printf("  span 一共 %,d 個；其中 Spring Security 的 %,d 個、排程的 %,d 個%n", Spans.ALL.size(),
                Spans.ALL.stream().filter(Spans::security).count(), Spans.ALL.stream().filter(s -> s.name().equals("scheduled")).count());
    }

    static boolean has(String traceId, Predicate<Spans.Rec> p) {
        return Spans.ALL.stream().anyMatch(s -> s.traceId().equals(traceId) && p.test(s));
    }

    static long count(List<String> traces, Predicate<Spans.Rec> p) {
        return traces.stream().filter(t -> has(t, p)).count();
    }
}
```

**`src/test/java/com/example/shop/dist07/H3SupportLookupTest.java`**（7.2.5、7.10）

```java
package com.example.shop.dist07;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.DbTap;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist04.Nodes;
import com.example.shop.dist04.OrderNode;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.Collectors;

/**
 * 13 站 7.2：買家回報「下單失敗」，錯誤畫面上有一串 traceId（第 12 站 9.8.3：每一個錯誤回應都帶著它）。
 * 客服拿它去兩個服務的日誌裡找，找得到什麼？
 *
 * 兩個服務各在自己的 JVM（dist04.OrderNode，跟正式環境一樣各寫各的日誌），日誌用正式環境的格式：一行一個 JSON（第 12 站 9.7，logback-json.xml）。
 * 事故：庫存服務的資料庫變慢 —— 每個預留交易 +600 ms（SlowSql），連線池只有 2 條、借連線最多等 250 ms；12 張下單同時送。
 *
 *   mvn test -Pexperiments -Dtest=H3SupportLookupTest
 */
@Tag("experiment")
class H3SupportLookupTest {

    static final int INV_PORT = 18711, ORDER_PORT = 18712;
    static final long BUYER = 7_300_001;
    final PrintStream out = System.out;

    @Test
    void lookup() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        SlowSql.set(0);
        List<String> json = List.of("--logging.config=classpath:logback-json.xml");
        List<String> invExtra = Nodes.with(Broker.args(), json, List.of(
                "--spring.datasource.url=" + SplitLab.url(Split.INV_DB) + "&queryInterceptors=" + DbTap.class.getName() + "," + SlowSql.class.getName(),
                "--spring.datasource.hikari.maximum-pool-size=2", "--spring.datasource.hikari.connection-timeout=250",
                "--spring.datasource.hikari.validation-timeout=250"));
        try (ConfigurableApplicationContext keys = Keys.start();
             OrderNode inv = OrderNode.inventory("d07-h3-inventory", INV_PORT, invExtra);
             OrderNode order = OrderNode.start("d07-h3-order", ORDER_PORT, INV_PORT, Nodes.with(Broker.args(), json))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Calls.Res rebuilt = Calls.send(ORDER_PORT, "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(keys, 1, Role.ADMIN), null, Map.of());
            if (rebuilt.status() != 200) throw new IllegalStateException("重建副本 " + rebuilt.status() + " " + rebuilt.body());
            for (int i = 0; i < 20; i++) Calls.place(ORDER_PORT, TestTokens.bearer(keys, BUYER + 100 + i), SplitLab.FIRST_PRODUCT + i);   // 暖機
            Thread.sleep(2_000);
            Path orderLog = log("d07-h3-order"), invLog = log("d07-h3-inventory");

            out.printf("═══ 7.2 ⑤ 客服拿 traceId 找日誌：兩個服務各在自己的 JVM，日誌是一行一個 JSON（load %s）═══%n", SplitLab.load());
            Calls.Res ok = Calls.place(ORDER_PORT, TestTokens.bearer(keys, BUYER), SplitLab.FIRST_PRODUCT + 500);
            Thread.sleep(1_000);
            out.printf("  一張正常的下單 %d，traceId %s │ 訂單服務的日誌 %d 行 │ 庫存服務的日誌 %d 行%n", ok.status(), ok.traceId(),
                    withTrace(orderLog, ok.traceId()).size(), withTrace(invLog, ok.traceId()).size());
            withTrace(orderLog, ok.traceId()).forEach(l -> out.println("    訂單服務 │ " + brief(l)));

            int orderFrom = lines(orderLog).size(), invFrom = lines(invLog).size();
            SlowSql.set(600);
            Thread.sleep(500);                                              // SlowSql 每 200 ms 重讀一次開關
            List<Calls.Res> burst = new ArrayList<>();
            try (ExecutorService ex = Executors.newVirtualThreadPerTaskExecutor()) {
                List<Future<Calls.Res>> fs = new ArrayList<>();
                for (int i = 0; i < 12; i++) {
                    long b = BUYER + 1 + i;
                    long product = SplitLab.FIRST_PRODUCT + 600 + i;
                    fs.add(ex.submit(() -> Calls.place(ORDER_PORT, TestTokens.bearer(keys, b), product)));
                }
                for (Future<Calls.Res> f : fs) burst.add(f.get());
            }
            SlowSql.set(0);
            Thread.sleep(3_000);
            Map<Integer, Long> codes = burst.stream().collect(Collectors.groupingBy(Calls.Res::status, TreeMap::new, Collectors.counting()));
            out.printf("  事故：庫存服務每個預留交易 +600 ms、連線池 2 條、借連線最多等 250 ms；12 張下單同時送 → %s%n", codes);
            Calls.Res failed = burst.stream().filter(r -> r.status() == 503).findFirst().orElseThrow(() -> new IllegalStateException("沒有 503：" + codes));
            String traceId = failed.json().path("traceId").asText(null);
            out.printf("  買家畫面上的錯誤：%s%n", failed.body());
            out.printf("  回應的 X-Trace-Id %s（跟錯誤內容裡的 traceId %s）%n", failed.traceId(), failed.traceId().equals(traceId) ? "一樣" : "不一樣：" + traceId);

            List<JsonNode> orderNew = lines(orderLog).subList(orderFrom, lines(orderLog).size());
            List<JsonNode> invNew = lines(invLog).subList(invFrom, lines(invLog).size());
            List<JsonNode> o = orderNew.stream().filter(l -> traceId.equals(l.path("traceId").asText(null))).toList();
            List<JsonNode> i = invNew.stream().filter(l -> traceId.equals(l.path("traceId").asText(null))).toList();
            out.printf("  客服用 %s 找：訂單服務的日誌 %d 行、庫存服務的日誌 %d 行%n", traceId, o.size(), i.size());
            o.forEach(l -> out.println("    訂單服務 │ " + brief(l)));
            i.forEach(l -> out.println("    庫存服務 │ " + brief(l)));

            Set<String> burstTraces = burst.stream().map(Calls.Res::traceId).collect(Collectors.toSet());
            List<JsonNode> noConn = invNew.stream().filter(l -> l.path("message").asText("").startsWith("拿不到資料庫連線")).toList();
            Set<String> noConnTraces = noConn.stream().map(l -> l.path("traceId").asText("（沒有）")).collect(Collectors.toSet());
            out.printf("  這幾秒，庫存服務的 WARN「拿不到資料庫連線」：%d 行；traceId %d 個不一樣的；是這 12 張下單之一的：%d 個%n",
                    noConn.size(), noConnTraces.size(), noConnTraces.stream().filter(burstTraces::contains).count());
            noConn.stream().limit(2).forEach(l -> out.println("    庫存服務 │ " + brief(l)));
            out.printf("  這幾秒，訂單服務的日誌 %d 行（WARN 以上 %d 行）、庫存服務 %d 行%n", orderNew.size(),
                    orderNew.stream().filter(l -> !l.path("level").asText().equals("INFO")).count(), invNew.size());
            out.printf("  日誌的 service 欄位：訂單服務的檔案 %s、庫存服務的檔案 %s%n", services(orderLog), services(invLog));
        } finally {
            SlowSql.set(0);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    static Path log(String node) { return Path.of("target", "d04-" + node + ".log"); }

    /** 日誌檔裡每一行 JSON（JVM 自己印的那幾行不是 JSON，跳過） */
    static List<JsonNode> lines(Path file) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        for (String l : Files.readAllLines(file, StandardCharsets.UTF_8))
            if (l.startsWith("{")) try { out.add(Calls.JSON.readTree(l)); } catch (Exception notJson) { /* 半行 */ }
        return out;
    }

    static List<JsonNode> withTrace(Path file, String traceId) throws Exception {
        return lines(file).stream().filter(l -> traceId.equals(l.path("traceId").asText(null))).toList();
    }

    static Map<String, Long> services(Path file) throws Exception {
        return lines(file).stream().collect(Collectors.groupingBy(l -> l.path("service").asText("（沒有）"), TreeMap::new, Collectors.counting()));
    }

    static String brief(JsonNode l) {
        String logger = l.path("logger_name").asText();
        String m = l.path("message").asText().replace('\n', ' ');
        return String.format("%s %-5s %s │ traceId=%s │ %s", l.path("@timestamp").asText(), l.path("level").asText(),
                logger.substring(logger.lastIndexOf('.') + 1), l.path("traceId").asText("（沒有）"), m.length() > 150 ? m.substring(0, 150) + "…" : m);
    }
}
```

**`src/test/java/com/example/shop/dist07/Keys.java`**（7.2.5）

```java
package com.example.shop.dist07;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.security.AccessTokens;
import org.springframework.boot.Banner;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

import java.time.Clock;

/**
 * 13 站第 07 章：兩個服務都在另一個 JVM 裡的時候（dist04.OrderNode），測試這一邊沒有它們的 bean 可以拿來簽買家的 token、金流回呼的簽章。
 * 起一個只有設定與 AccessTokens 的 context（不是 Web、沒有資料庫）：讀同一份 application.yml + local profile，所以金鑰跟那兩個行程一樣。
 * 不標 @Configuration：它在 com.example.shop 底下，標了就會被那兩個服務的元件掃描抓進去（clock 這個 bean 撞名，起不來）
 */
@EnableConfigurationProperties(ShopProperties.class)
@Import(AccessTokens.class)
class Keys {

    @Bean
    Clock clock() { return Clock.systemUTC(); }

    static ConfigurableApplicationContext start() {
        return new SpringApplicationBuilder(Keys.class).web(WebApplicationType.NONE).bannerMode(Banner.Mode.OFF).logStartupInfo(false)
                .run("--spring.profiles.active=local", "--logging.level.root=WARN");
    }
}
```

**`src/test/java/com/example/shop/dist07/SlowSql.java`**（7.2.5、7.7.4）

```java
package com.example.shop.dist07;

import com.mysql.cj.MysqlConnection;
import com.mysql.cj.Query;
import com.mysql.cj.interceptors.QueryInterceptor;
import com.mysql.cj.log.Log;
import com.mysql.cj.protocol.Resultset;
import com.mysql.cj.protocol.ServerSession;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import java.util.function.Supplier;

/**
 * 13 站第 07 章：第 06 章 SlowDb 的另一個 JVM 版。SlowDb 的開關是 static 的欄位，只有同一個 JVM 裡的測試改得到；
 * 服務在另一個 JVM（dist04.OrderNode）的時候，開關是一個檔案：target/d07-slow-ms，每 200 ms 重讀一次。
 *   「600」                    ：INSERT INTO processed_messages（每一個預留交易的第一句，第 03 章 3.5）之前睡 600 ms
 *   「800 insert into orders」：含這一段的 SQL（不分大小寫）之前睡 800 ms（訂單服務的 T1）
 * 從連線池看，就是那一句 SQL 在 MySQL 裡跑了那麼久。
 */
public class SlowSql implements QueryInterceptor {

    static final Path SWITCH = Path.of("target", "d07-slow-ms");
    static final String DEFAULT_SQL = "INSERT INTO processed_messages";
    private static volatile long readAt, ms;
    private static volatile String sqlPart = DEFAULT_SQL.toLowerCase(java.util.Locale.ROOT);

    public static void set(long millis) throws Exception { set(millis, DEFAULT_SQL); }

    public static void set(long millis, String sql) throws Exception {
        Files.createDirectories(SWITCH.getParent());
        Files.writeString(SWITCH, millis + (sql.equals(DEFAULT_SQL) ? "" : " " + sql));
        readAt = 0;
    }

    static long ms() {
        long now = System.nanoTime();
        if (now - readAt > 200_000_000L) {
            try {
                String[] v = Files.exists(SWITCH) ? Files.readString(SWITCH).strip().split(" ", 2) : new String[]{"0"};
                ms = Long.parseLong(v[0]);
                sqlPart = (v.length > 1 ? v[1] : DEFAULT_SQL).toLowerCase(java.util.Locale.ROOT);   // Hibernate 寫的 SQL 是小寫的
            } catch (Exception e) { ms = 0; }
            readAt = now;
        }
        return ms;
    }

    @Override
    public QueryInterceptor init(MysqlConnection c, Properties props, Log log) { return this; }

    @Override
    public <T extends Resultset> T preProcess(Supplier<String> sql, Query query) {
        long sleep = ms();
        if (sleep <= 0) return null;
        String s = sql.get();
        if (s != null && s.toLowerCase(java.util.Locale.ROOT).contains(sqlPart)) {
            try { Thread.sleep(sleep); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        return null;
    }

    @Override
    public boolean executeTopLevelOnly() { return true; }

    @Override
    public void destroy() {}

    @Override
    public <T extends Resultset> T postProcess(Supplier<String> sql, Query query, T originalResultSet, ServerSession serverSession) { return null; }
}
```

**`src/test/java/com/example/shop/dist07/H4DrillTest.java`**（7.11）

```java
package com.example.shop.dist07;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist04.Nodes;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * 13 站 7.11：一次演練 —— 告警響了，照排查的步驟走一次，看能不能指出是哪一個服務慢了。
 *
 * 兩個服務各在自己的 JVM（Node：管理埠、JSON 日誌、OTLP → Jaeger）、抽樣 0.1；一個演練用的 Prometheus（同一份 alerts.yml、打開 exemplar）抓它們的管理埠。
 * 每秒 10 張下單（開放式負載）：正常 2 分鐘 → 庫存服務的資料庫變慢 6 分鐘（每個預留交易 +600 ms，SlowSql）→ 恢復 3 分鐘。
 * 「慢、但沒有失敗」：每一張都成立，只是多了 0.6 秒 —— 沒有任何一行 ERROR 可以找。
 * 每 5 秒問一次 Prometheus 的告警。叫醒人的那一條（ShopPlaceOrderSlow）一 firing，就照 7.11 的步驟：
 *   ① Prometheus：這段時間 POST /api/orders 的 exemplar（直方圖的桶旁邊記著的 traceId）
 *   ② Jaeger：用最慢的那一個 traceId 查 trace，算 self time
 *   ③ 兩個服務的日誌：同一個 traceId
 *   ④ 儀表板上的原因（不叫醒人的那幾個）
 *
 *   mvn test -Pexperiments -Dtest=H4DrillTest        （約 13 分鐘；試跑：-Dh4.normal=20 -Dh4.incident=40 -Dh4.after=10 -Dh4.investigateAt=55）
 */
@Tag("experiment")
class H4DrillTest {

    static final int INV_PORT = 18741, INV_MGMT = 18742, ORDER_PORT = 18743, ORDER_MGMT = 18744;
    static final AtomicLong BUYERS = new AtomicLong(7_400_000);
    static final String ORDERS = "http_server_requests_seconds_bucket{system=\"shop\",uri=\"/api/orders\",method=\"POST\"}";

    final long normal = Long.getLong("h4.normal", 120), incident = Long.getLong("h4.incident", 360), after = Long.getLong("h4.after", 180);
    final int rate = Integer.getInteger("h4.rate", 10);
    /** 試跑用：短的版本等不到告警（for: 5m），在這一秒強制走一次排查 */
    final long forceAt = Long.getLong("h4.investigateAt", -1);
    final PrintStream out = System.out;

    record Done(long atMs, int status, long millis, String traceId) {}

    @Test
    void drill() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        SlowSql.set(0);
        Jaeger.restart();
        try (ConfigurableApplicationContext keys = Keys.start();
             Node inv = Node.inventory("h4-inventory", INV_PORT, INV_MGMT, Node.common("0.1"));
             Node order = Node.order("h4-order", ORDER_PORT, ORDER_MGMT, INV_PORT, Node.common("0.1"));
             Prom prom = Prom.start(new TreeMap<>(Map.of("order-service", ORDER_MGMT, "inventory-service", INV_MGMT)))) {
            SplitLab.seed(Split.ORDER_DB, true, false);
            SplitLab.seed(Split.INV_DB, false, true);
            Calls.Res rebuilt = Calls.send(ORDER_PORT, "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(keys, 1, Role.ADMIN), null, Map.of());
            if (rebuilt.status() != 200) throw new IllegalStateException("重建副本 " + rebuilt.status() + " " + rebuilt.body());
            for (int i = 0; i < 60 && !(prom.targets().size() == 2 && prom.targets().stream().allMatch(t -> t.contains(" up"))); i++) Thread.sleep(1_000);
            for (int i = 0; i < 600; i++)                                   // 暖機：剛起來的 JVM 前幾百張很慢，不要算進「正常」
                Calls.place(ORDER_PORT, TestTokens.bearer(keys, BUYERS.incrementAndGet()), SplitLab.FIRST_PRODUCT + i % SplitLab.PRODUCTS);

            out.printf("═══ 7.11 演練：每秒 %d 張下單；正常 %d 秒 → 庫存服務每個預留交易 +600 ms %d 秒 → 恢復 %d 秒；抽樣 0.1（load %s）═══%n",
                    rate, normal, incident, after, SplitLab.load());
            out.printf("  Prometheus 的 target：%s%n", prom.targets());

            ConcurrentLinkedQueue<Done> done = new ConcurrentLinkedQueue<>();
            AtomicBoolean stop = new AtomicBoolean();
            ExecutorService load = Executors.newVirtualThreadPerTaskExecutor();
            long t0 = System.nanoTime();
            Thread sender = new Thread(() -> {
                long gap = 1_000_000_000L / rate;
                for (long i = 0; !stop.get(); i++) {
                    long wait = t0 + i * gap - System.nanoTime();
                    if (wait > 0) try { Thread.sleep(wait / 1_000_000, (int) (wait % 1_000_000)); } catch (InterruptedException e) { return; }
                    long at = (System.nanoTime() - t0) / 1_000_000;
                    load.submit(() -> {
                        try {
                            Calls.Res r = Calls.place(ORDER_PORT, TestTokens.bearer(keys, BUYERS.incrementAndGet()),
                                    SplitLab.FIRST_PRODUCT + ThreadLocalRandom.current().nextInt(SplitLab.PRODUCTS));
                            done.add(new Done(at, r.status(), r.millis(), r.traceId()));
                        } catch (Exception e) {
                            done.add(new Done(at, -1, -1, null));
                        }
                    });
                }
            });
            sender.start();

            List<String> timeline = new ArrayList<>();
            Map<String, String> state = new LinkedHashMap<>();
            boolean investigated = false;
            long total = normal + incident + after;
            for (long s = 0; s < total; s += 5) {
                long sleep = t0 + s * 1_000_000_000L - System.nanoTime();
                if (sleep > 0) Thread.sleep(sleep / 1_000_000);             // 先等到這一秒，再切開關（第一版先切才等：早了 5 秒）
                if (s == normal) { SlowSql.set(600); timeline.add(String.format("第 %3d 秒 ── 庫存服務的資料庫變慢（每個預留交易 +600 ms）", s)); }
                if (s == normal + incident) { SlowSql.set(0); timeline.add(String.format("第 %3d 秒 ── 恢復", s)); }
                Map<String, String> now = new LinkedHashMap<>();
                for (Prom.Alert a : prom.alerts())
                    now.put(a.name() + (a.labels().containsKey("job") ? "{" + a.labels().get("job") + "}" : "")
                            + (a.labels().containsKey("consumer") ? "{" + a.labels().get("consumer") + "}" : ""), a.state());
                for (var e : now.entrySet()) if (!e.getValue().equals(state.get(e.getKey()))) timeline.add(String.format("第 %3d 秒 %s %s", s, e.getKey(), e.getValue()));
                for (var k : state.keySet()) if (!now.containsKey(k)) timeline.add(String.format("第 %3d 秒 %s 解除", s, k));
                state = now;
                if (!investigated && ("firing".equals(now.get("ShopPlaceOrderSlow")) || s == forceAt)) {
                    investigated = true;
                    investigate(prom, order, inv, s, s - normal, done, s == forceAt ? "試跑：第 " + s + " 秒強制排查" : "ShopPlaceOrderSlow 在第 " + s + " 秒 firing");
                }
            }
            stop.set(true);
            sender.join();
            load.shutdown();
            load.awaitTermination(60, TimeUnit.SECONDS);

            out.println("  告警（每 5 秒問一次 Prometheus 的 /api/v1/alerts）：");
            timeline.forEach(l -> out.println("    " + l));
            if (!investigated) out.println("  ShopPlaceOrderSlow 一直沒有 firing，沒有排查");
            for (String[] p : new String[][]{{"正常", "0", String.valueOf(normal)}, {"變慢", String.valueOf(normal), String.valueOf(normal + incident)},
                    {"恢復", String.valueOf(normal + incident), String.valueOf(total)}}) {
                long from = Long.parseLong(p[1]) * 1000, to = Long.parseLong(p[2]) * 1000;
                List<Done> in = done.stream().filter(d -> d.atMs() >= from && d.atMs() < to).toList();
                long[] ms = in.stream().filter(d -> d.millis() >= 0).mapToLong(Done::millis).sorted().toArray();
                Map<Integer, Long> codes = in.stream().collect(Collectors.groupingBy(Done::status, TreeMap::new, Collectors.counting()));
                out.printf("  %-4s │ 下單 %5d 張 │ p50 %6d ms │ p99 %6d ms │ 超過 500 ms 的 %5d 張 │ %s%n", p[0], in.size(), pct(ms, 50), pct(ms, 99),
                        in.stream().filter(d -> d.millis() > 500).count(), codes);
            }
            out.printf("  Jaeger 收到的 span：%,d 個%n", Jaeger.received());
        } finally {
            SlowSql.set(0);
        }
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 7.11 的排查步驟：告警 → exemplar → trace → 日誌 → 儀表板上的原因 */
    void investigate(Prom prom, Node order, Node inv, long s, long sinceIncident, ConcurrentLinkedQueue<Done> done, String why) throws Exception {
        long started = System.nanoTime();
        double now = System.currentTimeMillis() / 1000.0;
        out.printf("═══ 7.11 排查：%s（變慢之後 %d 秒）═══%n", why, sinceIncident);
        out.printf("  ⓪ 訂單服務的 /actuator/prometheus 用 OpenMetrics 要，帶 trace_id 的第一行：%s%n", exemplarLine());
        List<Prom.Exemplar> ex = prom.exemplars(ORDERS, now - 300, now);
        long slow = done.stream().filter(d -> d.atMs() >= (s - 300) * 1000 && d.millis() > 500).count();
        List<Prom.Exemplar> slowEx = ex.stream().filter(e -> e.seconds() > 0.5).sorted(Comparator.comparingDouble(Prom.Exemplar::seconds).reversed()).toList();
        out.printf("  ① Prometheus：過去 5 分鐘 POST /api/orders 的 exemplar %d 個，其中超過 0.5 秒的 %d 個（同一段時間超過 0.5 秒的下單 %d 張）%n",
                ex.size(), slowEx.size(), slow);
        slowEx.stream().limit(3).forEach(e -> out.printf("       traceId %s │ %.3f 秒%n", e.traceId(), e.seconds()));
        if (slowEx.isEmpty()) { out.println("  （沒有慢的 exemplar，排查停在這裡）"); return; }
        String traceId = slowEx.get(0).traceId();
        List<Spans.Rec> spans = Jaeger.trace(traceId);
        for (int i = 0; i < 20 && spans.isEmpty(); i++) { Thread.sleep(1_000); spans = Jaeger.trace(traceId); }
        Spans.reset();
        Spans.ALL.addAll(spans);
        out.printf("  ② Jaeger：/api/traces/%s%n", traceId);
        Spans.tree(traceId).forEach(l -> out.println("       " + l));
        out.println("     " + Spans.top(traceId, 3));
        out.printf("  ③ 日誌：訂單服務 %d 行、庫存服務 %d 行%n", lines(order.log, traceId).size(), lines(inv.log, traceId).size());
        lines(order.log, traceId).forEach(l -> out.println("       訂單服務 │ " + H3SupportLookupTest.brief(l)));
        lines(inv.log, traceId).forEach(l -> out.println("       庫存服務 │ " + H3SupportLookupTest.brief(l)));
        out.printf("  ④ 儀表板上的原因（不叫醒人）：訂單服務 → 庫存服務 預留的平均 %.0f ms（shop_remote_call_seconds，過去 1 分鐘）│ 庫存服務的連線池 active %.0f、pending %.0f%n",
                1000 * prom.value("sum(rate(shop_remote_call_seconds_sum{job=\"order-service\",op=\"reserve\"}[1m])) / sum(rate(shop_remote_call_seconds_count{job=\"order-service\",op=\"reserve\"}[1m]))"),
                prom.value("max(hikaricp_connections_active{job=\"inventory-service\"})"), prom.value("max(hikaricp_connections_pending{job=\"inventory-service\"})"));
        out.printf("  （①～④ 花了 %,d ms）%n", (System.nanoTime() - started) / 1_000_000);
    }

    static List<JsonNode> lines(Path file, String traceId) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        for (String l : Files.readAllLines(file, StandardCharsets.UTF_8))
            if (l.startsWith("{") && l.contains(traceId)) try { out.add(Calls.JSON.readTree(l)); } catch (Exception half) { }
        return out;
    }

    /** /actuator/prometheus 用 OpenMetrics 要的時候，帶 trace_id 的第一行 */
    static String exemplarLine() throws Exception {
        HttpResponse<String> r = Jaeger.HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + ORDER_MGMT + "/actuator/prometheus"))
                .header("Accept", "application/openmetrics-text; version=1.0.0").build(), HttpResponse.BodyHandlers.ofString());
        return r.body().lines().filter(l -> l.startsWith("http_server_requests_seconds_bucket{") && l.contains("/api/orders") && l.contains("trace_id"))
                .findFirst().orElse("（沒有）");
    }

    static long pct(long[] sorted, int p) {
        if (sorted.length == 0) return 0;
        return sorted[Math.min(sorted.length - 1, (int) Math.ceil(p / 100.0 * sorted.length) - 1)];
    }
}
```

**`src/test/java/com/example/shop/dist07/Node.java`**（7.11）

```java
package com.example.shop.dist07;

import com.example.shop.ShopApplication;
import com.example.shop.dist02.DbTap;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist03.Roles;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * 13 站第 07 章：一個服務、一個 JVM（第 04 章 dist04.OrderNode 的做法），多兩樣東西：
 *   管理埠（management.server.port）：Prometheus 只能從管理埠抓 /actuator/prometheus（第 12 站 9.9），readiness 也在這裡問
 *   正式環境的日誌格式（logback-json.xml）與 OTLP：span 送到 Jaeger（compose --profile tracing）
 * 日誌寫到 target/d07-<name>.log。
 */
final class Node implements AutoCloseable {

    static final String OTLP = "http://localhost:4318/v1/traces";

    final String name;
    final int port, mgmt;
    final Path log;
    private Process process;

    private Node(String name, int port, int mgmt) {
        this.name = name;
        this.port = port;
        this.mgmt = mgmt;
        this.log = Path.of("target", "d07-" + name + ".log");
    }

    /** 庫存服務：庫存庫加上 SlowSql（開關是 target/d07-slow-ms） */
    static Node inventory(String name, int port, int mgmt, List<String> extra) throws Exception {
        List<String> a = Split.override(Roles.inventoryArgs(), List.of(
                "--spring.datasource.url=" + SplitLab.url(Split.INV_DB) + "&queryInterceptors=" + DbTap.class.getName() + "," + SlowSql.class.getName()));
        return new Node(name, port, mgmt).boot(Split.override(a, extra));
    }

    static Node order(String name, int port, int mgmt, int inventoryPort, List<String> extra) throws Exception {
        return new Node(name, port, mgmt).boot(Split.override(Roles.orderArgs(inventoryPort), extra));
    }

    /** 兩個服務都要的：broker、JSON 日誌、OTLP、抽樣率 */
    static List<String> common(String probability) {
        List<String> a = new ArrayList<>(Broker.args());
        a.addAll(List.of("--logging.config=classpath:logback-json.xml", "--logging.level.com.example.shop=INFO",
                "--management.otlp.tracing.endpoint=" + OTLP, "--management.tracing.sampling.probability=" + probability));
        return a;
    }

    private Node boot(List<String> args) throws Exception {
        List<String> a = Split.override(args, List.of("--server.port=" + port, "--management.server.port=" + mgmt));
        List<String> cmd = new ArrayList<>(List.of(ProcessHandle.current().info().command().orElse("java"),
                "-Dshop.test.infra=compose", "-cp", System.getProperty("java.class.path"), ShopApplication.class.getName()));
        cmd.addAll(a);
        process = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log.toFile()).start();
        HttpClient c = HttpClient.newHttpClient();
        for (int i = 0; i < 240; i++) {
            try {
                if (c.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + mgmt + "/actuator/health/readiness")).build(),
                        HttpResponse.BodyHandlers.discarding()).statusCode() == 200) return this;
            } catch (Exception notYet) { /* 還沒開始聽 */ }
            if (!process.isAlive()) throw new IllegalStateException(name + " 沒有起來，看 " + log);
            Thread.sleep(250);
        }
        process.destroyForcibly();
        throw new IllegalStateException(name + " 60 秒內沒有 ready，看 " + log);
    }

    @Override
    public void close() throws Exception {
        if (process != null && process.isAlive()) {
            process.destroy();
            if (!process.waitFor(30, TimeUnit.SECONDS)) process.destroyForcibly().waitFor(10, TimeUnit.SECONDS);
        }
    }
}
```

**`src/test/java/com/example/shop/dist07/Jaeger.java`**（7.3.2、7.11）

```java
package com.example.shop.dist07;

import com.fasterxml.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 13 站第 07 章：compose 裡的 Jaeger（--profile tracing）。all-in-one 把 trace 放在記憶體裡：每一個實驗開始前重開一次，從空的開始。
 *   trace(traceId)：查詢 API（16686 的 /api/traces/{id}）—— 跟網頁上看到的是同一份資料，換成 Spans.Rec 印成樹
 *   received()    ：它自己的指標（14269 的 /metrics）裡，收到的 span 數
 */
final class Jaeger {

    static final HttpClient HTTP = HttpClient.newHttpClient();

    private Jaeger() {}

    static void restart() throws Exception {
        sh("docker", "compose", "--profile", "tracing", "rm", "-sf", "jaeger");
        sh("docker", "compose", "--profile", "tracing", "up", "-d", "jaeger");
        for (int i = 0; i < 120; i++) {
            try {
                if (get("http://localhost:16686/api/services").statusCode() == 200 && get("http://localhost:14269/metrics").statusCode() == 200) return;
            } catch (Exception notYet) { /* 還沒起來 */ }
            Thread.sleep(500);
        }
        throw new IllegalStateException("Jaeger 60 秒內沒有起來");
    }

    static void sh(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes());
        if (p.waitFor() != 0) throw new IllegalStateException(String.join(" ", cmd) + "：" + out);
    }

    static HttpResponse<String> get(String url) throws Exception {
        return HTTP.send(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofString());
    }

    /** 一條 trace 的每一個 span（找不到 → 空的） */
    static List<Spans.Rec> trace(String traceId) throws Exception {
        HttpResponse<String> r = get("http://localhost:16686/api/traces/" + traceId);
        List<Spans.Rec> out = new ArrayList<>();
        if (r.statusCode() != 200) return out;
        JsonNode t = Calls.JSON.readTree(r.body()).path("data").path(0);
        JsonNode processes = t.path("processes");
        for (JsonNode s : t.path("spans")) {
            Map<String, String> tags = new TreeMap<>();
            s.path("tags").forEach(x -> tags.put(x.path("key").asText(), x.path("value").asText()));
            String parent = null;
            for (JsonNode ref : s.path("references")) if (ref.path("refType").asText().equals("CHILD_OF")) parent = ref.path("spanID").asText();
            long start = s.path("startTime").asLong();
            List<String> events = new ArrayList<>();
            s.path("logs").forEach(l -> {
                String name = "";
                for (JsonNode f : l.path("fields")) if (f.path("key").asText().equals("event")) name = f.path("value").asText();
                events.add(String.format("%+.1f ms %s", (l.path("timestamp").asLong() - start) / 1000.0, name));
            });
            String service = processes.path(s.path("processID").asText()).path("serviceName").asText();
            String kind = tags.getOrDefault("span.kind", "internal").toUpperCase(java.util.Locale.ROOT);
            boolean error = "true".equals(tags.get("error")) || "ERROR".equals(tags.get("otel.status_code"));
            out.add(new Spans.Rec(service, service, s.path("traceID").asText(), s.path("spanID").asText(), parent, s.path("operationName").asText(),
                    kind, start, s.path("duration").asLong(), error, tags, events));
        }
        return out;
    }

    /** 兩個服務送來的 span 數（jaeger_collector_spans_received_total 依 svc 分；Jaeger 自己也送一個，不算） */
    static long received() throws Exception {
        long n = 0;
        for (String l : get("http://localhost:14269/metrics").body().split("\n"))
            if (l.startsWith("jaeger_collector_spans_received_total") && (l.contains("svc=\"order-service\"") || l.contains("svc=\"inventory-service\"")))
                n += (long) Double.parseDouble(l.substring(l.lastIndexOf(' ') + 1));
        return n;
    }
}
```

**`src/test/java/com/example/shop/dist07/Prom.java`**（7.11）

```java
package com.example.shop.dist07;

import com.fasterxml.jackson.databind.JsonNode;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 13 站 7.11：演練用的 Prometheus —— 跟 compose 的同一個映像檔、同一份 alerts.yml，打開 exemplar 的儲存；
 * 抓的是這台機器上的兩個子 JVM（host.docker.internal 的管理埠），兩個 job、同一個 system=shop（prometheus.yml 的寫法）。
 */
final class Prom implements AutoCloseable {

    static final String NAME = "d07-prometheus";
    static final int PORT = 19090;

    record Alert(String name, String state, String activeAt, Map<String, String> labels) {}

    record Exemplar(String traceId, double seconds, double at) {}

    static Prom start(Map<String, Integer> jobs) throws Exception {
        Path dir = Path.of("target", "d07-drill").toAbsolutePath();
        Files.createDirectories(dir);
        Files.copy(Path.of("docker/prometheus/alerts.yml"), dir.resolve("alerts.yml"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        StringBuilder y = new StringBuilder("""
                global: {scrape_interval: 15s, evaluation_interval: 15s}
                rule_files: [alerts.yml]
                scrape_configs:
                """);
        jobs.forEach((job, mgmt) -> y.append("""
                  - job_name: %s
                    metrics_path: /actuator/prometheus
                    static_configs: [{targets: ["host.docker.internal:%d"], labels: {system: shop}}]
                """.formatted(job, mgmt)));
        Files.writeString(dir.resolve("prometheus.yml"), y.toString());
        try { Jaeger.sh("docker", "rm", "-f", NAME); } catch (Exception none) { /* 沒有舊的 */ }
        Jaeger.sh("docker", "run", "-d", "--name", NAME, "--add-host=host.docker.internal:host-gateway", "-p", PORT + ":9090",
                "-v", dir + ":/etc/prometheus:ro", "prom/prometheus:v3.5.0",
                "--config.file=/etc/prometheus/prometheus.yml", "--enable-feature=exemplar-storage");
        for (int i = 0; i < 120; i++) {
            try { if (Jaeger.get("http://localhost:" + PORT + "/-/ready").statusCode() == 200) return new Prom(); } catch (Exception notYet) { }
            Thread.sleep(500);
        }
        throw new IllegalStateException("Prometheus 60 秒內沒有起來");
    }

    JsonNode api(String path) throws Exception {
        return Calls.JSON.readTree(Jaeger.get("http://localhost:" + PORT + path).body());
    }

    static String q(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }

    /** 每一個 target 現在 up 嗎 */
    List<String> targets() throws Exception {
        List<String> out = new ArrayList<>();
        for (JsonNode t : api("/api/v1/targets").path("data").path("activeTargets"))
            out.add(t.path("labels").path("job").asText() + " " + t.path("health").asText() + (t.path("lastError").asText().isEmpty() ? "" : "（" + t.path("lastError").asText() + "）"));
        return out;
    }

    List<Alert> alerts() throws Exception {
        List<Alert> out = new ArrayList<>();
        for (JsonNode a : api("/api/v1/alerts").path("data").path("alerts")) {
            Map<String, String> labels = new java.util.TreeMap<>();
            a.path("labels").fields().forEachRemaining(e -> labels.put(e.getKey(), e.getValue().asText()));
            out.add(new Alert(labels.get("alertname"), a.path("state").asText(), a.path("activeAt").asText(), labels));
        }
        return out;
    }

    /** 一個即時查詢的第一個值（沒有 → NaN） */
    double value(String promql) throws Exception {
        JsonNode r = api("/api/v1/query?query=" + q(promql)).path("data").path("result");
        return r.isEmpty() ? Double.NaN : r.path(0).path("value").path(1).asDouble();
    }

    /** 這段時間（epoch 秒）裡，這個查詢的 exemplar：traceId、那一個請求的秒數 */
    List<Exemplar> exemplars(String promql, double from, double to) throws Exception {
        List<Exemplar> out = new ArrayList<>();
        for (JsonNode series : api("/api/v1/query_exemplars?query=" + q(promql) + "&start=" + from + "&end=" + to).path("data"))
            for (JsonNode e : series.path("exemplars"))
                out.add(new Exemplar(e.path("labels").path("trace_id").asText(), e.path("value").asDouble(), e.path("timestamp").asDouble()));
        return out;
    }

    @Override
    public void close() throws Exception { Jaeger.sh("docker", "rm", "-f", NAME); }
}
```

**`src/test/java/com/example/shop/dist07/H5SamplingCostTest.java`**（7.8.2）

```java
package com.example.shop.dist07;

import com.example.shop.dist00.SplitLab;
import com.example.shop.dist02.Split;
import com.example.shop.dist03.Broker;
import com.example.shop.dist04.Nodes;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 13 站 7.8：抽樣率的成本。兩個服務各在自己的 JVM（Node）、span 送到 Jaeger（跟服務在同一台筆電上）。
 * 三種抽樣率（0、0.1、1.0）× 3 輪、交錯；每一輪重開兩個服務（抽樣率是啟動時的設定），
 * 暖機 5 秒之後，16 條執行緒一直送 3 個品項的下單（封閉式負載）20 秒：每秒幾張、p50、p99、Jaeger 這一輪收到幾個 span。
 *
 *   mvn test -Pexperiments -Dtest=H5SamplingCostTest        （約 10 分鐘）
 */
@Tag("experiment")
class H5SamplingCostTest {

    static final int INV_PORT = 18751, INV_MGMT = 18752, ORDER_PORT = 18753, ORDER_MGMT = 18754;
    static final AtomicLong BUYERS = new AtomicLong(7_500_000);
    static final String[] ROUNDS = System.getProperty("h5.rounds", "0,0.1,1.0,1.0,0.1,0,0.1,0,1.0").split(",");
    static final int SECONDS = Integer.getInteger("h5.seconds", 20);
    final PrintStream out = System.out;

    record Round(String p, long orders, long notCreated, List<Long> millis, long spans) {}

    @Test
    void cost() throws Exception {
        Split.freshDatabases();
        Nodes.flushRedis(Split.ORDER_REDIS);
        Nodes.flushRedis(Split.INV_REDIS);
        Broker.freshVhost();
        SlowSql.set(0);
        Jaeger.restart();
        List<Round> rounds = new ArrayList<>();
        try (ConfigurableApplicationContext keys = Keys.start()) {
            out.printf("═══ 7.8 抽樣率的成本：16 條執行緒送 3 個品項的下單，每輪 %d 秒；%s（load %s）═══%n", SECONDS, String.join(" → ", ROUNDS), SplitLab.load());
            boolean seeded = false;
            for (String p : ROUNDS) {
                try (Node inv = Node.inventory("h5-inventory", INV_PORT, INV_MGMT, Node.common(p));
                     Node order = Node.order("h5-order", ORDER_PORT, ORDER_MGMT, INV_PORT, Node.common(p))) {
                    if (!seeded) {
                        SplitLab.seed(Split.ORDER_DB, true, false);
                        SplitLab.seed(Split.INV_DB, false, true);
                        Calls.Res r = Calls.send(ORDER_PORT, "POST", "/api/admin/stock-levels/rebuild", TestTokens.bearer(keys, 1, Role.ADMIN), null, Map.of());
                        if (r.status() != 200) throw new IllegalStateException("重建副本 " + r.status() + " " + r.body());
                        seeded = true;
                    }
                    run(keys, 5, new ArrayList<>());                         // 暖機
                    Thread.sleep(6_000);                                     // BatchSpanProcessor 每 5 秒送一次：暖機的 span 送完
                    long before = Jaeger.received();
                    List<Long> millis = Collections.synchronizedList(new ArrayList<>());
                    long[] r = run(keys, SECONDS, millis);
                    Thread.sleep(6_000);
                    long spans = Jaeger.received() - before;
                    Round round = new Round(p, r[0], r[1], millis, spans);
                    rounds.add(round);
                    List<Long> s = new ArrayList<>(millis);
                    Collections.sort(s);
                    out.printf("  抽樣 %-4s │ 每秒 %5.1f 張 │ p50 %5.1f ms │ p99 %6.1f ms │ 不是 201 的 %d 張 │ Jaeger 收到 %,7d 個 span（每張下單 %.1f 個）│ load %s%n",
                            p, r[0] / (double) SECONDS, pct(s, 50), pct(s, 99), r[1], spans, r[0] == 0 ? 0 : spans / (double) r[0], SplitLab.load());
                }
            }
        }
        Map<String, List<Round>> by = new TreeMap<>();
        rounds.forEach(r -> by.computeIfAbsent(r.p(), k -> new ArrayList<>()).add(r));
        out.println("  三輪合起來：");
        by.forEach((p, rs) -> {
            List<Long> all = new ArrayList<>();
            rs.forEach(r -> all.addAll(r.millis()));
            Collections.sort(all);
            long orders = rs.stream().mapToLong(Round::orders).sum(), spans = rs.stream().mapToLong(Round::spans).sum();
            out.printf("  抽樣 %-4s │ 每秒 %s 張 │ p50 %5.1f ms │ p99 %6.1f ms │ 每張下單 %.2f 個 span │ 每秒 %,.0f 個 span%n", p,
                    String.join(" / ", rs.stream().map(r -> String.format("%.0f", r.orders() / (double) SECONDS)).toList()),
                    pct(all, 50), pct(all, 99), orders == 0 ? 0 : spans / (double) orders, spans / (double) (SECONDS * rs.size()));
        });
        out.printf("  （結束時 load %s）%n", SplitLab.load());
    }

    /** 16 條執行緒一直送，seconds 秒；回傳 {201 的張數, 不是 201 的張數} */
    long[] run(ConfigurableApplicationContext keys, int seconds, List<Long> millis) throws Exception {
        long end = System.nanoTime() + seconds * 1_000_000_000L;
        AtomicLong ok = new AtomicLong(), bad = new AtomicLong();
        ExecutorService ex = Executors.newFixedThreadPool(16);
        for (int t = 0; t < 16; t++)
            ex.submit(() -> {
                while (System.nanoTime() < end) {
                    long[] ids = ThreadLocalRandom.current().longs(0, SplitLab.PRODUCTS).distinct().limit(3).map(i -> SplitLab.FIRST_PRODUCT + i).toArray();
                    try {
                        Calls.Res r = Calls.place(ORDER_PORT, TestTokens.bearer(keys, BUYERS.incrementAndGet()), ids);
                        if (r.status() == 201) { ok.incrementAndGet(); millis.add(r.millis()); } else bad.incrementAndGet();
                    } catch (Exception e) {
                        bad.incrementAndGet();
                    }
                }
                return null;
            });
        ex.shutdown();
        ex.awaitTermination(seconds + 60, TimeUnit.SECONDS);
        return new long[]{ok.get(), bad.get()};
    }

    static double pct(List<Long> sorted, int p) {
        if (sorted.isEmpty()) return 0;
        return sorted.get(Math.min(sorted.size() - 1, (int) Math.ceil(p / 100.0 * sorted.size()) - 1));
    }
}
```

**`src/test/java/com/example/shop/dist07/H6MdcHookTest.java`**（7.4.4）

```java
package com.example.shop.dist07;

import com.example.shop.ShopApplication;
import com.example.shop.dist00.SplitLab;
import com.example.shop.dist04.Nodes;
import com.example.shop.support.CapturedLogs;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.PrintStream;
import java.util.Map;

/**
 * 13 站 7.4 ⚠️：MDC 的 traceId 靠 OpenTelemetry 的 ContextStorage 上的一個掛勾 —— 整個 JVM 只能在第一次用到 Context 之前裝。
 * 這一章的第一版有一個不用 Spring、自己建 OpenTelemetry SDK 的單元測試：它在同一個 JVM 裡比任何一個 Spring context 都早碰到 Context，
 * 之後的 Spring context 日誌都沒有 traceId（驗收 Q7 紅了）。這裡重現：先碰一次 Context，再起一個單體，打一個請求。
 *
 *   mvn test -Pexperiments -Dtest=H6MdcHookTest
 */
@Tag("experiment")
class H6MdcHookTest {

    static final String DB = "shop_d07_mono";
    static final int REDIS = 11;
    final PrintStream out = System.out;

    @Test
    void touchedTooEarly() throws Exception {
        SplitLab.freshDatabase(DB);
        Nodes.flushRedis(REDIS);
        out.printf("═══ 7.4 ⚠️ 起應用程式之前，同一個 JVM 先用過一次 OpenTelemetry 的 Context（load %s）═══%n", SplitLab.load());
        io.opentelemetry.context.Context.current();                         // 這一行：ContextStorage 初始化了，之後 Boot 要裝的掛勾裝不上去
        try (ConfigurableApplicationContext app = new SpringApplicationBuilder(ShopApplication.class).run(SplitLab.common(DB, REDIS).toArray(String[]::new));
             CapturedLogs logs = CapturedLogs.attach()) {                   // 啟動之後才掛：Boot 啟動時會重設 Logback，之前掛的會被拿掉
            Calls.Res r = Calls.send(SplitLab.port(app), "GET", "/api/products/" + SplitLab.FIRST_PRODUCT, null, null, Map.of());
            out.printf("  GET /api/products/{id} → %d，X-Trace-Id %s%n", r.status(), r.traceId());
            app.getBean(com.example.shop.shared.observability.Traces.class).checkLogCorrelation();   // 啟動完成時那一次檢查，再做一次給這裡收
            logs.events().stream().filter(e -> e.getFormattedMessage().startsWith("TRACE_MDC_BROKEN"))
                    .forEach(e -> out.println("  " + e.getLevel() + " " + e.getFormattedMessage()));
        }
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/web/InternalTraceparentTest.java`**（7.5）

```java
package com.example.shop.inventory.internal.web;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.support.TestInfra;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13 站 7.5：庫存服務只信任「自己的另一個服務」帶來的 traceparent —— /internal/**、而且 Authorization 是一個發給它的服務 token。
 * 其他人（使用者的 token、沒有 token、給別的服務的 token、/api/**）帶來的一律藏起來，跟第 12 站 9.8.4 一樣。
 *
 * @AutoConfigureObservability：@SpringBootTest 預設把追蹤的傳遞關掉（propagator 是 noop，traceparent 根本不會被讀）——
 * 要測「收不收」，得先打開它（7.6 的 ⚠️ 也是從這裡來的）
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "shop.deployment.role=inventory-service", "shop.deployment.service-token.secret=" + InventoryServiceApiTest.SECRET,
        "shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false", "shop.security.bootstrap-admin.enabled=false",
        "spring.jpa.hibernate.ddl-auto=none", "spring.flyway.locations=classpath:db/migration/inventory,classpath:db/migration/shared",
        "spring.data.redis.database=5", "management.tracing.sampling.probability=1.0"})
@AutoConfigureObservability
class InternalTraceparentTest {

    static final String DB = "shop_svc_inventory_trace";
    static final String TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
    static final String TRACEPARENT = "00-" + TRACE + "-00f067aa0ba902b7-01";

    static volatile String url;

    @DynamicPropertySource
    static void ownDatabase(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> {
            if (url == null) {
                JdbcTemplate admin = TestInfra.adminJdbc();
                admin.execute("DROP DATABASE IF EXISTS " + DB);
                admin.execute("CREATE DATABASE " + DB);
                admin.execute("GRANT ALL PRIVILEGES ON `" + DB + "`.* TO 'shop_migrator'@'%' WITH GRANT OPTION");
                url = TestInfra.jdbcUrl(DB);
            }
            return url;
        });
    }

    @LocalServerPort int port;
    @Autowired AccessTokens userTokens;

    final HttpClient http = HttpClient.newHttpClient();

    HttpResponse<String> get(String path, String auth) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).header("traceparent", TRACEPARENT);
        if (auth != null) b.header("Authorization", auth);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    static String service(String sub, String aud) {
        return "Bearer " + InventoryServiceApiTest.token(sub, aud, Duration.ofMinutes(5), InventoryServiceApiTest.SECRET);
    }

    String traceOf(HttpResponse<String> r) { return r.headers().firstValue("X-Trace-Id").orElse(null); }

    @Test @DisplayName("7.5：訂單服務的服務 token + traceparent → 庫存服務接上同一個 traceId")
    void ourOwnServiceIsTrusted() throws Exception {
        HttpResponse<String> r = get("/internal/inventory/v1/stock?productIds=1", service("order-service", "inventory-service"));
        System.out.println("13 站 7.5：訂單服務的 token → " + r.statusCode() + " X-Trace-Id " + traceOf(r));
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(traceOf(r)).isEqualTo(TRACE);
    }

    @Test @DisplayName("7.5：其他人帶來的 traceparent 不收 —— 使用者的 token、沒有 token、給別的服務的 token、/api/**")
    void everyoneElseIsNot() throws Exception {
        var cases = new java.util.LinkedHashMap<String, HttpResponse<String>>();
        cases.put("使用者的 token", get("/internal/inventory/v1/stock?productIds=1", TestTokens.bearer(userTokens, 1001)));
        cases.put("沒有 token", get("/internal/inventory/v1/stock?productIds=1", null));
        cases.put("給 order-service 的 token", get("/internal/inventory/v1/stock?productIds=1", service("order-service", "order-service")));
        cases.put("/api/**、服務的 token", get("/api/products/1", service("order-service", "inventory-service")));
        cases.forEach((what, r) -> System.out.println("13 站 7.5：" + what + " → " + r.statusCode() + " X-Trace-Id " + traceOf(r)));
        assertThat(cases.values()).allSatisfy(r -> assertThat(traceOf(r)).isNotNull().isNotEqualTo(TRACE));
    }
}
```

**`src/test/java/com/example/shop/shared/events/internal/OutboxTraceparentTest.java`**（7.6.5）

```java
package com.example.shop.shared.events.internal;

import com.example.shop.shared.events.EventTypes;
import com.example.shop.shared.events.Outbox;
import com.example.shop.support.CapturedLogs;
import com.example.shop.support.InlineEvents;
import com.zaxxer.hikari.HikariDataSource;
import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import io.opentelemetry.api.trace.SpanId;
import io.opentelemetry.context.Context;
import io.opentelemetry.sdk.trace.ReadWriteSpan;
import io.opentelemetry.sdk.trace.ReadableSpan;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.data.SpanData;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * 13 站 7.6、7.7：事件帶著寫它的那一個 span 走 —— outbox 的 traceparent（V34）→ relay 的 header → 消費者接在它底下。
 * 真的 relay、真的 RabbitMQ、真的消費者（跟 EventFlowTest 一樣，結束時關掉 context）；追蹤打開（@AutoConfigureObservability）、抽樣 100%，
 * 送出去的 span 收在一個 SpanProcessor 裡。順便守住 TracedDataSource：借連線的 span 只在已經有 span 的時候開、bean 還是 HikariDataSource
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {"shop.order.jobs-enabled=false", "shop.inventory.jobs-enabled=false",
        "shop.messaging.relay-enabled=true", "shop.messaging.consumers-enabled=true", "management.tracing.sampling.probability=1.0"})
@AutoConfigureObservability
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Import(OutboxTraceparentTest.Captured.class)
class OutboxTraceparentTest {

    static final long BUYER = 997_801;

    @TestConfiguration
    static class Captured {
        static final List<SpanData> SPANS = new CopyOnWriteArrayList<>();

        @Bean
        SpanProcessor d07Captured() {
            return new SpanProcessor() {
                @Override public void onStart(Context parentContext, ReadWriteSpan span) {}
                @Override public boolean isStartRequired() { return false; }
                @Override public void onEnd(ReadableSpan span) { SPANS.add(span.toSpanData()); }
                @Override public boolean isEndRequired() { return true; }
            };
        }
    }

    @Autowired Outbox outbox;
    @Autowired Tracer tracer;
    @Autowired JdbcTemplate jdbc;
    @Autowired DataSource dataSource;
    @Autowired PlatformTransactionManager tm;
    @Autowired ApplicationContext ctx;

    @BeforeEach
    void setUp() {
        InlineEvents.skipBacklog(ctx);
        if (!com.example.shop.support.TestInfra.containers()) com.example.shop.support.TestQueues.purgeConsumerQueues(ctx);
        jdbc.update("DELETE FROM notifications WHERE user_id BETWEEN ? AND ?", BUYER, BUYER + 9);
    }

    Map<String, Object> placed(long buyer) {
        return Map.of("orderId", buyer, "orderNo", "D07-" + buyer, "buyerId", buyer, "hotProductIds", List.of());
    }

    @Test @DisplayName("7.6：outbox 那一列的 traceparent 是寫它的那一個 span；兩個消費者都接在它底下；7.7：寫它的交易借的連線也是它的子 span")
    void eventsCarryTheirParent() {
        Span span = tracer.nextSpan().name("d07 test").start();
        String eventId;
        try (Tracer.SpanInScope ignored = tracer.withSpan(span)) {
            eventId = new TransactionTemplate(tm).execute(s -> outbox.add("ORDER", BUYER, EventTypes.ORDER_PLACED, placed(BUYER)));
        } finally {
            span.end();
        }
        String traceId = span.context().traceId(), spanId = span.context().spanId();
        String stored = jdbc.queryForObject("SELECT traceparent FROM outbox_events WHERE event_id = ?", String.class, eventId);
        assertThat(stored).isEqualTo("00-" + traceId + "-" + spanId + "-01");

        await().atMost(Duration.ofSeconds(20)).until(() -> consumers(traceId).size() == 2);
        System.out.println("13 站 7.6：outbox traceparent " + stored + " → 消費者 " + consumers(traceId).stream()
                .map(c -> c.getName() + "（parent " + c.getParentSpanId() + "）").toList());
        assertThat(consumers(traceId)).extracting(SpanData::getName)
                .containsExactlyInAnyOrder("consume notification.order-events", "consume inventory.hot-settlement");
        assertThat(consumers(traceId)).allSatisfy(c -> assertThat(c.getParentSpanId()).isEqualTo(spanId));
        assertThat(Captured.SPANS).filteredOn(s -> s.getName().equals("db connection") && s.getParentSpanId().equals(spanId))
                .singleElement().satisfies(c -> assertThat(c.getEvents()).extracting(e -> e.getName()).containsExactly("acquired"));
    }

    @Test @DisplayName("7.6：traceparent 的旗標是 00（那一次請求沒有被抽到）→ 消費者照樣處理、一個 span 都不送：不會只送一半")
    void notSampledStaysNotSampled() {
        String eventId = UUID.randomUUID().toString(), traceId = "5b8aa5a2d2c872e8321cf37308d69df2";
        insert(eventId, BUYER + 2, "D07-unsampled", traceId, "00-" + traceId + "-00f067aa0ba902b7-00");
        await().atMost(Duration.ofSeconds(20)).until(() -> sent(eventId));
        assertThat(Captured.SPANS).noneMatch(s -> s.getTraceId().equals(traceId));
    }

    @Test @DisplayName("7.6 ⚠️：7.6 之前寫的事件（只有 trace_id、沒有 traceparent）照樣被處理、日誌是同一個 traceId —— 不送 span、不丟例外")
    void oldEventsStillFlow() {
        String eventId = UUID.randomUUID().toString(), traceId = "0af7651916cd43dd8448eb211c80319c";
        try (CapturedLogs logs = CapturedLogs.attach()) {
            insert(eventId, BUYER + 1, "D07-old", traceId, null);
            await().atMost(Duration.ofSeconds(20)).until(() -> sent(eventId));
            List<String> mail = logs.events().stream().filter(e -> e.getFormattedMessage().contains("D07-old"))
                    .map(e -> e.getMDCPropertyMap().get("traceId")).toList();
            System.out.println("13 站 7.6：只有 trace_id 的舊事件 → 寄信那一行的 traceId " + mail);
            assertThat(mail).isNotEmpty().allSatisfy(t -> assertThat(t).isEqualTo(traceId));
        }
        assertThat(Captured.SPANS).noneMatch(s -> s.getTraceId().equals(traceId));
    }

    void insert(String eventId, long buyer, String orderNo, String traceId, String traceparent) {
        jdbc.update("INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, trace_id, traceparent) VALUES (?, 'ORDER', ?, ?, ?, ?, ?)",
                eventId, buyer, EventTypes.ORDER_PLACED, "{\"orderId\":" + buyer + ",\"orderNo\":\"" + orderNo + "\",\"buyerId\":" + buyer + ",\"hotProductIds\":[]}",
                traceId, traceparent);
    }

    boolean sent(String eventId) {
        return "SENT".equals(jdbc.query("SELECT status FROM notifications WHERE dedup_key = ?", rs -> rs.next() ? rs.getString(1) : null, eventId + ":ORDER_PLACED"));
    }

    @Test @DisplayName("7.7：借連線的 span 只在已經有 span 的時候開（relay 每 100 ms 借一次，不能每一次都變成一個 trace）；DataSource 還是 HikariDataSource")
    void connectionSpansOnlyInsideATrace() {
        jdbc.queryForObject("SELECT 1", Integer.class);                    // 測試的執行緒上沒有 span
        assertThat(dataSource).isInstanceOf(HikariDataSource.class);
        assertThat(Captured.SPANS).filteredOn(s -> s.getName().equals("db connection")).allSatisfy(s -> assertThat(SpanId.isValid(s.getParentSpanId())).isTrue());
    }

    List<SpanData> consumers(String traceId) {
        return Captured.SPANS.stream().filter(s -> s.getTraceId().equals(traceId) && s.getName().startsWith("consume ")).toList();
    }
}
```

**`src/test/java/com/example/shop/inventory/internal/remote/RemoteInventoryResilienceTest.java`**（7.7.1）

```diff
  *   重試預算：10 秒裡的重送有上限
  *   隔艙：同時在等的有上限，滿了立刻 503、不送
  *   熔斷：預留、熱點閘門各一個；5xx 與沒有回應算失敗，4xx 不算；打開之後不送、Retry-After = 開著的秒數；補償不經過熔斷器
+ *   13 站 7.7：每一次呼叫一個觀測 shop.remote.call（trace 上的「inventory reserve」）：結果、送了幾次
  */
 class RemoteInventoryResilienceTest {
 
…
     void stop() { server.stop(0); }
 
     RemoteInventoryApi api(String... overrides) {
+        return api(io.micrometer.observation.ObservationRegistry.NOOP, overrides);
+    }
+
+    RemoteInventoryApi api(io.micrometer.observation.ObservationRegistry observations, String... overrides) {
         Map<String, String> m = new HashMap<>(Map.of(
                 "shop.order.payment-timeout", "15m", "shop.order.timeout-scan-interval", "30s",
                 "shop.security.jwt-secret", "unit-test-user-jwt-secret-0123456789abcdef",
…
                 "shop.deployment.service-token.secret", "unit-test-service-token-secret-0123456789"));
         for (int i = 0; i < overrides.length; i += 2) m.put(overrides[i], overrides[i + 1]);
         ShopProperties props = new Binder(new MapConfigurationPropertySource(m)).bind("shop", ShopProperties.class).get();
-        return new RemoteInventoryApi(RestClient.builder(), props, new ServiceTokens(props, Clock.systemUTC()), new ObjectMapper(), meters);
+        return new RemoteInventoryApi(RestClient.builder(), props, new ServiceTokens(props, Clock.systemUTC()), new ObjectMapper(), meters, observations);
     }
 
     double rejected(String by) {
…
         inventory.returnHot(LINE);
         assertThat(seen).extracting(Seen::path).endsWith("/internal/inventory/v1/reservations/1", "/internal/inventory/v1/hot-gate/returns");
     }
+
+    // ───────── 13 站 7.7：觀測 ─────────
+
+    @Test @DisplayName("7.7：每一次呼叫一個 shop.remote.call —— outcome 說出結果、shop.attempts 說出送了幾次；庫存不足不標成錯誤")
+    void observesEveryCall() {
+        List<String> stopped = new java.util.concurrent.CopyOnWriteArrayList<>();
+        var registry = io.micrometer.observation.ObservationRegistry.create();
+        registry.observationConfig().observationHandler(new io.micrometer.observation.ObservationHandler<>() {
+            @Override public boolean supportsContext(io.micrometer.observation.Observation.Context c) { return true; }
+            @Override public void onStop(io.micrometer.observation.Observation.Context c) {
+                stopped.add(c.getContextualName() + " outcome=" + c.getLowCardinalityKeyValue("outcome").getValue()
+                        + " attempts=" + c.getHighCardinalityKeyValue("shop.attempts").getValue()
+                        + " error=" + (c.getError() == null ? "-" : c.getError().getClass().getSimpleName()));
+            }
+        });
+        RemoteInventoryApi inventory = api(registry, "shop.deployment.inventory.breaker.minimum-calls", "4", "shop.deployment.inventory.read-timeout", "100ms");
+        inventory.reserve(1L, LINE, List.of());                            // 204
+        script.add(new Object[]{409, 0L, INSUFFICIENT});
+        assertThatThrownBy(() -> inventory.reserve(2L, LINE, List.of())).isInstanceOf(InsufficientStockException.class);
+        script.add(new Object[]{204, 300L, null});
+        script.add(new Object[]{204, 300L, null});
+        assertThatThrownBy(() -> inventory.reserve(3L, LINE, List.of())).isInstanceOf(ShopException.class);   // 兩次都沒有回應 → 熔斷器 4 次裡失敗 2 次，打開
+        assertThatThrownBy(() -> inventory.reserve(4L, LINE, List.of())).isInstanceOf(ShopException.class);   // 熔斷器擋下，沒有送
+        assertThatThrownBy(inventory::ensureReservable).isInstanceOf(ShopException.class);                   // 寫訂單之前問（6.7.5）：也留一筆
+        System.out.println("13 站 7.7：shop.remote.call " + stopped);
+        assertThat(stopped).containsExactly(
+                "inventory reserve outcome=ok attempts=1 error=-",
+                "inventory reserve outcome=4xx attempts=1 error=-",
+                "inventory reserve outcome=no_response attempts=2 error=ShopException",
+                "inventory reserve outcome=breaker attempts=0 error=ShopException",
+                "inventory reserve outcome=breaker attempts=0 error=ShopException");
+        assertThat(seen).hasSize(4);
+    }
 }
```

**`src/test/java/com/example/shop/inventory/internal/remote/RemoteInventoryApiTest.java`**（7.7.1）

```diff
                 "shop.deployment.inventory.read-timeout", "300ms",
                 "shop.deployment.service-token.secret", "unit-test-service-token-secret-0123456789"))).bind("shop", ShopProperties.class).get();
         tokens = new ServiceTokens(props, Clock.systemUTC());
-        inventory = new RemoteInventoryApi(RestClient.builder(), props, tokens, new ObjectMapper(), meters);
+        inventory = new RemoteInventoryApi(RestClient.builder(), props, tokens, new ObjectMapper(), meters, io.micrometer.observation.ObservationRegistry.NOOP);
     }
 
     @AfterEach
```

**`src/test/java/com/example/shop/inventory/internal/remote/InventoryClientPactTest.java`**（7.7.1）

```diff
                 "shop.payment.callback-secret", "pact-test-payment-callback-secret-01234",
                 "shop.deployment.role", "order-service", "shop.deployment.inventory.url", server.getUrl(),
                 "shop.deployment.service-token.secret", "pact-test-service-token-secret-0123456789"))).bind("shop", ShopProperties.class).get();
-        return new RemoteInventoryApi(RestClient.builder(), props, new ServiceTokens(props, Clock.systemUTC()), new ObjectMapper(), new SimpleMeterRegistry());
+        return new RemoteInventoryApi(RestClient.builder(), props, new ServiceTokens(props, Clock.systemUTC()), new ObjectMapper(), new SimpleMeterRegistry(),
+                io.micrometer.observation.ObservationRegistry.NOOP);
     }
 }
```

**`src/test/java/com/example/shop/support/InlineEvents.java`**（7.6）

```diff
         int delivered = 0;
         for (int round = 0; round < 10; round++) {
             List<OutboxStore.Row> rows = new ArrayList<>(jdbc.query("""
-                    SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id
+                    SELECT id, event_id, aggregate_type, aggregate_id, event_type, payload, created_at, trace_id, traceparent
                       FROM outbox_events WHERE published_at IS NULL ORDER BY id""",
                     (rs, i) -> new OutboxStore.Row(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4), rs.getString(5),
-                            rs.getString(6), rs.getTimestamp(7).toInstant(), rs.getString(8))));
+                            rs.getString(6), rs.getTimestamp(7).toInstant(), rs.getString(8), rs.getString(9))));
             rows.removeIf(which.negate());
             if (rows.isEmpty()) return delivered;
             for (OutboxStore.Row r : rows) {
```


---

## 7.14 常見誤區

- **「有 traceId 就有分散式追蹤。」** 第 12 站之後每一行日誌都有 traceId，7.2 的完整 trace 是 0 個：收的那一邊藏起了 traceparent、消費者的 parent 是編的、兩個服務各抽各的。traceId 是一個字串；追蹤是一棵樹，要每一段都接得上。
- **「收到的 traceparent 都接起來。」** 網路上任何人都可以寫它（第 12 站 9.8.4）。只接「能證明自己是誰」的呼叫端帶來的（7.5）。
- **「MQ 帶 traceId 就夠了。」** 只有 traceId，消費者的 parent 只能編、抽樣只能重來；要帶的是寫這一筆事件的那一個 span（`traceparent`），而且要存進 outbox —— relay 送出的時候，那個請求早就結束了（7.6）。
- **「換了追蹤的實作，舊的訊息照樣能處理。」** 第 12 站的舊路在 OpenTelemetry 上先是丟例外、讓訊息不見，再是換掉 traceId（7.6.4）。換版那一刻佇列裡一定有舊訊息。
- **「測試綠了，新的那條路就沒問題。」** `@SpringBootTest` 預設把傳遞關掉，用它起的測試，事件走的是舊路（7.6.6）；一個不用 Spring 的測試，還能讓一起跑的 Spring 測試拿不到 traceId（7.4.4）。
- **「trace 上沒有，就是沒發生。」** 熔斷器擋下的那一張，不另外留一筆，trace 上什麼都沒有（7.7.5）。trace 只看得到開了 span 的地方。
- **「父 span 最長的那一個就是慢的。」** 父 span 包含子 span。看 self time；client span 的 self time 是網路與對方的佇列（7.7.3）。
- **「抽樣 100% 最保險。」** 這一章的下單，每一張 21.9 個 span（7.8）。要的是「出事的時候找得到幾條完整的」，不是「每一條都有」—— 每一條都有的是日誌。
- **「每一個不正常的指標都該叫醒人。」** 熔斷器沒有流量時會一直開著（7.9.1）；一個原因同時讓五個指標動。叫醒人的是使用者感受得到的那幾個，其他的在排查時看。
- **「告警規則寫好了就不用動。」** 第 12 站的 16 條寫死了 `job="shop"`，切開之後一條都不會響，而且不會有任何錯誤（7.9.2）。

---

## 7.15 本章小結

- 7.2：一張慢的下單，後端拿到的是三個不相干的 trace；抽樣 0.1，200 次下單與付款，完整的 trace 0 個；客服拿 traceId 找日誌，兩個服務都是 0 行。
- **換成 OpenTelemetry、送到 Jaeger**（7.3、7.4）：理由是 OTLP 與「看 traceId 抽樣」；兩個服務各有名字；Spring Security 的 span 關掉。真正修好「斷」的是傳遞，不是實作。
- **HTTP**：只信任 `/internal/**` 上、帶著有效服務 token 的 `traceparent`（7.5）。
- **MQ**：outbox 存 `traceparent`，消費者接在寫它的那一個 span 底下、抽樣照它的旗標；舊的訊息照樣處理、同一個 traceId、不送 span（7.6）。
- **看得到才找得到**：每一次遠端呼叫一個 `shop.remote.call`（結果、送了幾次）、每一次借連線一個 `db connection`（等多久、拿多久）；用 self time 指出慢在哪一個服務的哪一段（7.7）。
- **抽樣 0.1**：完整的比例跟抽樣率一樣、不會只有一半；日誌不抽樣，exemplar 只指向被抽到的（7.8）。
- **告警**：叫醒人的只有使用者感受得到的（邊緣的 5xx、下單的延遲）；規則認 `system`，不認 job 的名字（7.9）。
- 演練：告警 → exemplar → trace → 日誌，指出「庫存服務的資料庫」；告警自己要 5 分鐘以上才響（7.11）。

### 7.15.1 驗收清單

- [ ] 從 `d06` 開出 `d07`，在第一個 commit 上跑 H1：說出慢的那一張為什麼是三個 trace、庫存服務收到的 `traceparent` 去了哪裡（7.2.2）。
- [ ] 跑 H2，說出為什麼完整的 trace 是 0 個，以及「兩邊都在」的那幾個大約是 0.1 × 0.1（7.2.4）。
- [ ] **不看課文**，畫出一張下單與它的付款，traceId 經過的每一段：誰寫、誰傳、誰讀（HTTP、outbox、relay、消費者）。
- [ ] 說出 `TraceFilters` 為什麼要兩個條件（`/internal/**`、發給我的服務 token），各少一個會怎樣（7.5）。
- [ ] 把 `Traces.continueTrace` 改回第 12 站的 `traceContextBuilder()` 寫法，跑 `OutboxTraceparentTest`，說出哪一個測試紅、為什麼（7.6.4）。
- [ ] 在最後的 commit 上跑 H1，用 self time 說出 ①～⑥ 每一張慢在哪一個服務的哪一段（7.7.4）。
- [ ] 說出 exemplar、trace、日誌三樣東西，在抽樣 0.1 之下各剩多少（7.8、7.9.4、7.10）。
- [ ] 用 promtool 跑 `alerts_test.yml`，說出 ⑤' 為什麼不該響（7.9.3）。
- [ ] 跑 H4，從告警響的那一刻起，照 7.11 的四步自己走一次（Prometheus 的網頁、Jaeger 的網頁、日誌檔）。
- [ ] `mvn clean verify` 全綠（7.13）。

---

## 7.16 下一章預告

這一章的演練，兩個服務、Jaeger、Prometheus 都在同一台筆電上，用固定的埠互相找到對方：

- 訂單服務找庫存服務：`shop.deployment.inventory.url`，一個寫死的位址。
- Prometheus 找兩個服務：`prometheus.yml` 裡兩行 `host.docker.internal:埠`。
- span 送到哪裡：`SHOP_OTLP_ENDPOINT`。

庫存服務多開一台、換一台機器、搬到 K8s，這三個地方都要改。第 08 章處理**基礎設施**：服務發現、設定管理、閘道、負載平衡四件事，Spring Cloud 與 K8s 原生各怎麼做；README 產出第 4 項缺的 gateway；Jaeger 的資料放在哪裡；以及第 06 章 6.3.5 留下的 —— 服務網格的 sidecar 預設就會重試，要算進乘法。
