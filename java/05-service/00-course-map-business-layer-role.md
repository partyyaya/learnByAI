# 第 00 章：課程地圖與商業邏輯層定位

> 上一站（04-controller 站）你把 70 條端點實作完了：綁定、驗證、83 個錯誤碼、traceId、
> 檔案與串流、CORS 與序列化、350 個 MockMvc 測試。
> **而每一個 Controller 方法的最後一行都長得一樣**：
>
> ```java
> return mapper.toXxxResponse(orderService.doSomething(command));
> ```
>
> `orderService` 是一個介面。它的實作在 04-controller 站全部是 stub —— 回傳假資料、
> 或者 `throw new UnsupportedOperationException()`。
>
> **這一站要把它們寫出來。**
>
> 但這一章仍然先不寫 `@Transactional`。
> 因為 Service 層真正的難題不是註解 —— `@Transactional` 你 10 分鐘就會貼了 ——
> 而是**「這個系統的規則，到底該由誰負責守」**。
> 我見過 4,000 行的 `OrderServiceImpl`，它的 `createOrder()` 一個方法 620 行。
> 也見過同一個需求寫成 5 個類別、每個不到 80 行的版本。
> 差別不在誰比較會用 Spring，而在誰想清楚了**不變量該守在哪裡**。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 說出 Service 層的三個職責（編排、交易邊界、守護不變量），以及**哪些事不屬於它**。
- 分辨「貧血模型」與「充血模型」，並說出貧血模型的**四個可量化代價**——
  不是「不夠 OO」，而是重複、漏檢、不可測、規則沒有單一真相。
- 判斷一段業務規則該放在 **Domain 物件**、**Application Service** 還是 **Repository**，
  並說出判準（七個問題，不是憑感覺）。
- 列出一個訂單系統的**不變量清單**，並說出每一條該守在哪一層、以及那一層的可靠度。
- 說明為什麼「在 Service 裡 if 一下」在併發下必然失效，以及正確的守法在哪。
- 把 04-controller 站的 `OrderService` 介面實作成三層：`Order` 聚合、`OrderApplicationService`、
  以及注入的埠（`PaymentGateway`、`StockPort`）。
- 說出 Service 層**不該做的九件事**，每一條都能舉出對應的事故。
- 建好 shop-service 的 service 套件結構，並用 ArchUnit 讓分層規則在 CI 就紅燈。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
           02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署（已完成）
                ↓
           03-rest-api      介面契約設計（已完成，產出 orders-api.yaml）
                ↓
           04-controller    Web 層：接請求、驗參數、回錯誤（已完成，70 條端點）
                ↓
[你在這裡] 05-service       商業邏輯層：交易、不變量、快取、非同步 ← 把規則實作出來
                ↓
           06-repository    資料存取層：連線池、查詢抽象
                ↓
           07 / 08          MySQL / JPA / MyBatis
                ↓
           09 / 10          Spring Security / 期末專題
```

### 0.2.1 04-controller 站結束時留下的五個問題

04-controller 站的最後一節（7.18）刻意留了五個問題，並說「它們全部屬於 05-service」。
把它們攤開來看，**這一站要學什麼就很清楚了**：

| 04-controller 站留下的問題 | 它真正在問什麼 | 本站哪一章 |
|---|---|---|
| 庫存真的不足時，`OrderService.create()` 會不會拋 `InsufficientStockException`？ | **不變量**：`stock >= 0` 由誰守 | 00（0.8）、02 |
| 「一天最多改 3 次地址」在兩個客服同時操作時會不會變成 4 次？ | **併發**：檢查與寫入之間的縫 | 02（2.11） |
| 付款失敗時，已經扣掉的庫存要怎麼還回去？ | **交易邊界**：哪些操作是原子的 | 02、06 |
| `AFTER_COMMIT` 的通知信寄失敗了，要重試幾次？ | **副作用的可靠性**：交易之外的世界 | 06 |
| 合併訂單的過程中資料庫斷線，會留下半張訂單嗎？ | **原子性**：rollback 到底 rollback 什麼 | 02 |

它們有一個共同點，也正好是 Web 層完全沒有碰到的：

> **Web 層的每一個請求是無狀態、獨立、可以重試的。
> Service 層不是** —— 它要處理「一連串操作要嘛全部成功要嘛全部失敗」，
> 以及「兩個人同時做同一件事」。

⚠️ **這個差異大到會改變你的思考習慣。**
在 Web 層，你的問題是「這個輸入合法嗎」——一個純函式問題，測試很好寫。
在 Service 層，你的問題是「這個操作在**當前的資料狀態下**、
在**別人也在操作的情況下**合法嗎」——**兩個變數都不在你的方法參數裡**。

### 0.2.2 這一站的產出

```
第 00 章  Service 層的職責、貧血 vs 充血、不變量清單、三層重構
第 01 章  Service 設計與依賴管理：介面 vs 實作、Service 之間的界線、循環依賴
第 02 章  交易管理（核心章）：@Transactional 全參數、7 種傳播、五種失效、併發控制
第 03 章  DTO ↔ Entity 轉換：為何不回傳 Entity、手寫 vs MapStruct、PATCH 的三態
第 04 章  業務例外設計：例外階層、與 93 個 ErrorCode 的對應（00 章 0.12 ⑮ 新增了 10 個）
第 05 章  服務層快取：@Cacheable、Redis、一致性、擊穿與雪崩
第 06 章  非同步與外部呼叫：@Async、RestClient、逾時、重試、熔斷、事件
第 07 章  Mockito 測試：mock Repository、行為驗證、例外路徑、什麼時候該用真 DB
```

**結束時你會有一個端到端跑得通的訂單系統** ——
從 `POST /orders` 進去，穿過驗證、Service、交易邊界，
到 Repository（**先用記憶體假實作**，真的 SQL 是 06/07/08 站的事），
再原路回來變成 201 + `Location`。

⚠️ **為什麼 Repository 先用記憶體假實作？**
因為這一站要講的是「**交易邊界的形狀**」，而不是「JPA 怎麼寫」。
把兩者混在一起學，你會分不清「這個 bug 是我的邏輯錯，還是 Hibernate 的 flush 時機」——
而那個混淆是初學 Spring 最常見的卡點。

> ⚠️ 但**有一個例外**：交易與併發**沒有辦法**用記憶體假實作學。
> 樂觀鎖、悲觀鎖、隔離級別都是資料庫的行為。
> 所以 02 章會**破例**用 Testcontainers 起一個真的 MySQL ——
> 理由在 2.2.5。
>
> ⚠️ **前向指標**：07 章 7.11 會把「哪些事必須用真的資料庫」列成完整清單 ——
> 而它比這裡說的多。02 章是**第一個**碰真資料庫的地方，不是唯一的。

---

## 0.3 先看見痛：一個 2,000 行的 `OrderServiceImpl`

04-controller 站的 0.3 給你看了一個 800 行的 Controller。
你可能以為「把那些程式碼搬到 Service 就好了」。

**不是。** 搬過去只是換個地方爛。

以下是一個真實專案的 `OrderServiceImpl.createOrder()`（去識別化，
從 620 行壓縮到 150 行，但每一種問題都保留）。
它是「Controller 已經瘦身完成」之後的樣子 —— Controller 只有 5 行，很漂亮。
問題全部在這裡。

```java
@Service
public class OrderServiceImpl implements OrderService {

    @Autowired private OrderRepository orderRepository;
    @Autowired private OrderItemRepository orderItemRepository;
    @Autowired private ProductRepository productRepository;
    @Autowired private StockRepository stockRepository;
    @Autowired private CouponRepository couponRepository;
    @Autowired private CustomerRepository customerRepository;
    @Autowired private AddressRepository addressRepository;
    @Autowired private PointRepository pointRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private RestTemplate restTemplate;
    @Autowired private StringRedisTemplate redis;
    @Autowired private JavaMailSender mailSender;
    @Autowired private SmsClient smsClient;
    @Autowired private ErpClient erpClient;

    @Override
    @Transactional
    public Order createOrder(CreateOrderCommand cmd) {

        // ── 1. 又驗證了一次（04-controller 的 @Valid 已經驗過了）──────────────────
        if (cmd.lines() == null || cmd.lines().isEmpty()) {
            throw new RuntimeException("商品不能為空");
        }
        if (cmd.lines().size() > 50) {
            throw new RuntimeException("最多 50 項");
        }

        // ── 2. 撈資料，順便做授權判斷 ─────────────────────────
        Customer customer = customerRepository.findById(cmd.actor().id()).orElse(null);
        if (customer == null) {
            throw new RuntimeException("客戶不存在");
        }
        Address address = addressRepository.findById(cmd.shippingAddressId()).orElse(null);
        if (address == null) {
            throw new RuntimeException("地址不存在");
        }
        // ⚠️ 沒有檢查這個地址是不是這個客戶的 → IDOR

        // ── 3. 建 Order，用 setter 一個一個塞 ─────────────────
        Order order = new Order();
        order.setId(UUID.randomUUID().toString());
        order.setCustomerId(customer.getId());
        order.setStatus("PENDING");                  // ⚠️ 字串，不是 enum
        order.setCreatedAt(new Date());              // ⚠️ new Date()，測不了
        order.setShippingAddressId(address.getId());

        // ── 4. 價格計算，650 行裡最長的一段 ───────────────────
        BigDecimal subtotal = BigDecimal.ZERO;
        List<OrderItem> items = new ArrayList<>();
        for (CreateOrderCommand.Line line : cmd.lines()) {
            Product p = productRepository.findById(line.productId()).orElse(null);
            if (p == null) {
                throw new RuntimeException("商品不存在：" + line.productId());
            }
            if (!"ON_SALE".equals(p.getStatus())) {
                throw new RuntimeException("商品已下架：" + p.getName());
            }

            // 庫存：先查再扣（⚠️ race condition）
            Stock stock = stockRepository.findByProductId(p.getId());
            if (stock.getQuantity() < line.quantity()) {
                throw new RuntimeException("庫存不足：" + p.getName());
            }
            stock.setQuantity(stock.getQuantity() - line.quantity());
            stockRepository.save(stock);

            // 單價：會員價 → 促銷價 → 原價，三段 if
            BigDecimal unitPrice = p.getPrice();
            if ("VIP".equals(customer.getLevel())) {
                unitPrice = unitPrice.multiply(new BigDecimal("0.95"));
            }
            if (p.getPromotionPrice() != null
                    && p.getPromotionEndAt().after(new Date())) {
                unitPrice = p.getPromotionPrice();
            }
            // ⚠️ 沒有 setScale，也沒有指定 RoundingMode
            BigDecimal lineTotal = unitPrice.multiply(new BigDecimal(line.quantity()));
            subtotal = subtotal.add(lineTotal);

            OrderItem item = new OrderItem();
            item.setOrderId(order.getId());
            item.setProductId(p.getId());
            item.setProductName(p.getName());          // 快照
            item.setUnitPrice(unitPrice);
            item.setQuantity(line.quantity());
            items.add(item);
        }

        // ── 5. 優惠券 ─────────────────────────────────────────
        BigDecimal discount = BigDecimal.ZERO;
        if (cmd.couponCode() != null) {
            Coupon coupon = couponRepository.findByCode(cmd.couponCode());
            if (coupon == null) throw new RuntimeException("優惠券不存在");
            if (coupon.getUsedCount() >= coupon.getTotalCount()) {
                throw new RuntimeException("優惠券已用完");
            }
            if (subtotal.compareTo(coupon.getMinAmount()) < 0) {
                throw new RuntimeException("未達最低消費");
            }
            discount = coupon.getType().equals("FIXED")
                    ? coupon.getValue()
                    : subtotal.multiply(coupon.getValue()).divide(new BigDecimal("100"));
            coupon.setUsedCount(coupon.getUsedCount() + 1);   // ⚠️ 又一個 race
            couponRepository.save(coupon);
        }

        // ── 6. 運費 ───────────────────────────────────────────
        BigDecimal shippingFee = new BigDecimal("60");
        if (subtotal.subtract(discount).compareTo(new BigDecimal("1000")) >= 0) {
            shippingFee = BigDecimal.ZERO;
        }
        if (address.getCity().equals("澎湖縣")
                || address.getCity().equals("金門縣")
                || address.getCity().equals("連江縣")) {
            shippingFee = shippingFee.add(new BigDecimal("100"));
        }

        order.setSubtotal(subtotal);
        order.setDiscount(discount);
        order.setShippingFee(shippingFee);
        order.setTotal(subtotal.subtract(discount).add(shippingFee));

        orderRepository.save(order);
        orderItemRepository.saveAll(items);

        // ── 7. 點數 ───────────────────────────────────────────
        int points = order.getTotal().intValue() / 100;
        pointRepository.addPoints(customer.getId(), points);

        // ── 8. 稽核 ───────────────────────────────────────────
        AuditLog log = new AuditLog();
        log.setAction("CREATE_ORDER");
        log.setDetail(new Gson().toJson(order));       // ⚠️ 含地址與電話
        auditLogRepository.save(log);

        // ── 9. 在交易裡呼叫外部系統 🔴🔴🔴 ──────────────────
        try {
            erpClient.pushOrder(order);                // 沒有逾時設定
        } catch (Exception e) {
            e.printStackTrace();                        // 失敗就吞掉
        }

        // ── 10. 在交易裡寄信與發簡訊 🔴🔴🔴 ─────────────────
        mailSender.send(buildOrderMail(customer, order, items));
        smsClient.send(customer.getPhone(), "您的訂單已成立");

        // ── 11. 清快取 ───────────────────────────────────────
        redis.delete("cart:" + customer.getId());

        return order;
    }
}
```

**它能動。公司靠它賺錢。** 而且比 04-controller 站那個 Controller「進步」了 ——
至少 HTTP 的東西不在裡面了。

**但它是整個系統事故的來源。** 下面把後果一條一條算出來。

### 0.3.1 這一個方法做了幾件事？

| # | 做的事 | 該在哪裡 |
|---|---|---|
| 1 | 重複驗證輸入格式 | ❌ 已經在 04-controller 2.x 的 `@Valid` 做過了 |
| 2 | 查客戶、查地址 | ✅ Application Service（編排） |
| 3 | 檢查地址屬於這個客戶 | 🔴 **完全沒做**（IDOR 漏洞） |
| 4 | 用 setter 組 `Order` | ❌ 應該是 `Order` 的工廠方法 |
| 5 | 判斷商品可否購買 | ❌ `Product.isPurchasable()` |
| 6 | 查庫存、扣庫存 | 🔴 有 race condition，扣減應該是**一句 SQL 的原子操作** |
| 7 | 算單價（三段 if） | ❌ `PricingPolicy`（Domain，純函式） |
| 8 | 算小計、四捨五入 | ❌ `Money` 值物件 |
| 9 | 優惠券的四條規則 | ❌ `Coupon.applyTo(subtotal)` |
| 10 | 優惠券計數 +1 | 🔴 race condition |
| 11 | 運費規則（含外島） | ❌ `ShippingFeePolicy`（Domain，純函式） |
| 12 | 存 order / items | ✅ Application Service |
| 13 | 加點數 | ⚠️ 可以是同交易，也可以是事件 —— **但必須是明確的決定** |
| 14 | 寫稽核紀錄 | ⚠️ 同上，而且 `detail` 不該含 PII |
| 15 | 推 ERP | 🔴🔴 **絕對不能在交易裡** |
| 16 | 寄信 + 發簡訊 | 🔴🔴 **絕對不能在交易裡** |
| 17 | 清購物車快取 | 🔴 應該在 commit **之後** |

**17 件事。其中 6 件是紅色的。**

而最關鍵的觀察不是「太多了」，是：

> **這 17 件事分屬三種完全不同的性質，而它們被寫在同一個 `@Transactional` 裡。**

| 性質 | 例子 | 失敗時應該怎樣 |
|---|---|---|
| **必須原子** | 建訂單、扣庫存、扣券 | 一起成功或一起回滾 |
| **可以稍後、但不能遺失** | 加點數、稽核、推 ERP | 記下來重試，不該讓下單失敗 |
| **可以遺失** | 寄信、發簡訊、清快取 | 失敗就記 log，絕不影響訂單 |

**把三種性質混在一個交易裡，就是這個方法所有事故的根源。**

### 0.3.2 六個具體事故（都真的發生過）

**事故 1：ERP 逾時，資料庫連線池耗盡，整站掛掉**

```
14:02:11  ERP 廠商的機房網路異常，pushOrder() 開始 hang（沒設逾時）
14:02:11  第 1 個下單請求卡在第 9 步，但它持有一條資料庫連線（@Transactional 開著）
14:02:40  30 個下單請求同時卡住 → HikariCP 的 10 條連線全部被佔
14:02:41  「查訂單」也拿不到連線 → 30 秒後 SQLTransientConnectionException
14:02:45  健康檢查（會打 DB）失敗 → K8s 開始重啟 pod
14:02:50  重啟後的新 pod 一接流量就重複上述循環
14:19:00  ERP 恢復。網站在 17 分鐘後才恢復
```

⚠️ **注意這裡的因果**：ERP 掛掉不該讓「查訂單」壞掉。
**是「在交易裡呼叫外部系統」把兩件無關的事綁在了一起。**

一條資料庫連線在 `@Transactional` 期間是**被獨佔**的。
`pushOrder()` 花多久，那條連線就被佔多久。
連線池只有 10 條 —— 意思是**整個服務同時只能有 10 個請求在交易裡**。
把一個 30 秒的網路呼叫放進去，連線池的有效容量就變成 `10 / 30秒`。

> 📌 **這是本站最重要的一條規則，02 章 2.9 會再講一次**：
> **交易裡只能有資料庫操作。** 網路呼叫、寄信、發簡訊、寫檔案、
> `Thread.sleep`、等待鎖 —— 全部不行。

**事故 2：寄信成功，訂單回滾 → 客戶收到一張不存在的訂單**

```java
mailSender.send(...);          // ← 成功了，信寄出去了
smsClient.send(...);           // ← 這裡拋出 RuntimeException（簡訊商 500）
                               // ↓
                               // @Transactional 回滾 → 訂單消失
```

客戶收到「您的訂單 ORD-20260315-0042 已成立」的信，
點進去看到 404。客服完全查不到這張訂單。

⚠️ **`@Transactional` 只能回滾資料庫。** 寄出去的信、發出去的簡訊、
推給 ERP 的資料、刪掉的 Redis key —— **一個都回不來**。

> 這是「交易邊界」這個概念最直觀的意義：
> **邊界之內的東西可以一起消失，邊界之外的東西不能。**
> 於是「哪些操作在邊界之內」就變成一個**必須刻意決定**的事，
> 而不是「程式碼剛好寫在哪裡」。

**事故 3：超賣 —— 庫存 1 個，賣出 3 張訂單**

```
時間      執行緒 A（客戶甲）              執行緒 B（客戶乙）           執行緒 C（客戶丙）
────────────────────────────────────────────────────────────────────────────────
t1        SELECT quantity → 1
t2                                        SELECT quantity → 1
t3                                                                     SELECT quantity → 1
t4        1 >= 1 ✅ 通過
t5                                        1 >= 1 ✅ 通過
t6                                                                     1 >= 1 ✅ 通過
t7        UPDATE stock SET qty = 0
t8                                        UPDATE stock SET qty = 0
t9                                                                     UPDATE stock SET qty = 0
────────────────────────────────────────────────────────────────────────────────
結果：三張訂單成立，庫存 0（而不是 -2）。倉庫只有 1 個貨。
```

⚠️ 這是**檢查與寫入之間的縫**（time-of-check to time-of-use），
是 Service 層最經典、最常被忽略的 bug。

**它在單元測試裡 100% 通不出來** —— 因為單元測試只有一個執行緒。
它在本機開發也不會出現。它只在「同一秒有兩個人買同一個商品」時出現，
所以通常在**促銷活動的第一分鐘**爆發。

正確做法有三種（02 章 2.11 會完整展開），這裡先給結論：

```sql
-- ✅ 做法 A：讓資料庫做原子的「檢查 + 扣減」
UPDATE stock SET quantity = quantity - ?
WHERE product_id = ? AND quantity >= ?;
-- 回傳 0 表示更新失敗 → 庫存不足 → 拋 InsufficientStockException
```

```
✅ 做法 B：悲觀鎖 SELECT ... FOR UPDATE（可以在扣減前做更多判斷）
✅ 做法 C：樂觀鎖 version 欄位 + 重試（適合衝突不頻繁的情境）
```

> 📌 **而最後的防線永遠是資料庫約束**：
> `CHECK (quantity >= 0)` 或 `UNSIGNED` 欄位。
> **應用層的檢查會漏，約束不會。** 0.8.3 會把這件事講透。

**事故 4：一筆訂單的金額對不起來**

```java
BigDecimal unitPrice = p.getPrice();                              // 100
if ("VIP".equals(customer.getLevel())) {
    unitPrice = unitPrice.multiply(new BigDecimal("0.95"));        // 95.00
}
// ⚠️ 沒有 setScale → 如果原價是 33，VIP 價是 31.35
BigDecimal lineTotal = unitPrice.multiply(new BigDecimal(qty));    // 31.35 × 3 = 94.05
```

`subtotal` 是 `94.05`，寫進 `DECIMAL(10,2)` 欄位變成 `94.05`（剛好沒事）。
但如果原價是 `33.33`，VIP 價 `31.6635`，×3 = `94.9905`，
資料庫存進去變成 `94.99`（MySQL 預設四捨五入）。
**而 Java 那一邊的 `order.getTotal()` 是 `94.9905`** ——
於是「訂單金額」與「明細加總」差 0.0005 元。

一年後，財務發現對帳差了 3,000 多元，沒有人查得出來是哪幾筆。

⚠️ 04-controller 6.5.7（）處理的是「金額怎麼**序列化**」。
**這裡的問題不同**：金額怎麼**計算**。而它的正解是：

> **每一步運算後都要明確 `setScale(currency.fractionDigits(), RoundingMode.HALF_UP)`。**
> 而「每一步都要記得」是不可靠的 —— 所以要有一個 `Money` 值物件，
> 讓「忘記」在型別上不可能發生。（0.5.3）

**事故 5：優惠券被用了 1,200 次，上限是 1,000**

```java
if (coupon.getUsedCount() >= coupon.getTotalCount()) throw ...;
coupon.setUsedCount(coupon.getUsedCount() + 1);
```

跟事故 3 一模一樣的縫，換一個欄位。**促銷第一分鐘超發 200 張。**

⚠️ 而它比超賣更難處理，因為**已經送出的折扣不能追回**。
超賣可以取消訂單並道歉；優惠券超發只能認賠。

**事故 6：稽核紀錄外洩客戶地址與電話**

```java
log.setDetail(new Gson().toJson(order));
```

`order` 上有 `shippingAddress`、`phone`。
於是所有客服（有稽核查詢權限的人）都能看到全部客戶的地址電話 ——
而稽核紀錄通常**沒有**做欄位級遮蔽，也常常被匯出到資料倉儲。

> ⚠️ 04-controller 4.6.5 的 `BodyMasker` 處理的是「請求日誌」的遮蔽。
> **Service 層寫的稽核紀錄是另一條路徑，它繞過了那整套機制。**
> 這是「橫切關注點只做了一半」的典型案例。

### 0.3.3 把成本算成錢

| 事故 | 直接損失 | 修復成本 |
|---|---|---|
| 1 ERP 逾時導致全站掛 17 分鐘 | 尖峰時段 17 分鐘營收 ≈ 42 萬 | 3 人日 |
| 2 客戶收到不存在的訂單 | 客服 200 通電話 + 商譽 | 2 人日 |
| 3 超賣 | 47 筆訂單取消 + 補償券 ≈ 18 萬 | 5 人日（含資料修正） |
| 4 對帳差 3,000 元 | 財務 8 人日對帳 | **查不出來，最後認列損失** |
| 5 優惠券超發 200 張 | 200 × 200 元 = 4 萬 | 1 人日 |
| 6 稽核外洩 PII | 個資通報風險 | 4 人日 + 法務 |

**而六個事故的根因只有三個：**

```
① 交易邊界畫錯      → 事故 1、2
② 業務規則沒有原子性 → 事故 3、5
③ 規則散落在流程裡，沒有物件負責 → 事故 4、6
```

**這一站的八章，就是在解這三件事。**

### 0.3.4 「Controller 瘦了」不等於「架構好了」

這一節最重要的一句話：

> **04-controller 站教會你「不要把邏輯放在 Controller」。
> 但如果你把它們原封不動搬到 Service，你只是把 800 行的問題
> 換成 2,000 行的問題 —— 而且更難查，因為它現在還管交易。**

分層的價值不在「檔案變多」，而在**每一層都變得可以獨立推理**：

| 層 | 你在讀它的時候需要在腦裡裝什麼 |
|---|---|
| Controller | HTTP 的規則 |
| Application Service | 「這個 use case 的步驟順序」與「交易邊界」 |
| Domain | **只有業務規則，不需要知道資料庫、HTTP、時間、亂數** |
| Repository | 資料怎麼存取 |

上面那個 `createOrder()` 之所以難改，是因為讀它的時候**四層的東西全部在腦裡**。
620 行不是問題，「620 行裡有四種抽象層次交錯」才是問題。

---

## 0.4 Service 層到底在做什麼

### 0.4.1 三個職責

去掉所有不屬於它的東西之後，Service 層只剩三件事：

```
┌─────────────────────────────────────────────────────────────┐
│ ① 編排（Orchestration）                                      │
│    「這個 use case 的步驟是什麼，順序是什麼」                   │
│    · 取出需要的聚合（Repository）                             │
│    · 呼叫聚合上的方法讓它自己判斷與改變                         │
│    · 呼叫外部埠（金流、通知）                                  │
│    · 存回去                                                  │
│    ⚠️ 它不做業務判斷 —— 判斷在聚合裡                           │
├─────────────────────────────────────────────────────────────┤
│ ② 交易邊界（Transaction boundary）                            │
│    「哪些步驟必須一起成功或一起失敗」                           │
│    · @Transactional 只出現在這一層                            │
│    · 決定哪些副作用要移到 commit 之後                          │
│    · 決定隔離級別與鎖策略                                      │
├─────────────────────────────────────────────────────────────┤
│ ③ 守護不變量（Invariant enforcement）                          │
│    「這個系統永遠不能出現的狀態，由誰擋住」                      │
│    · 聚合內的不變量 → 聚合自己守（Order 不會有負數金額）          │
│    · 跨聚合的不變量 → Service + 鎖 + 資料庫約束                 │
│    ⚠️ 這是本站最難、最容易被忽略的一項                          │
└─────────────────────────────────────────────────────────────┘
```

⚠️ **③ 是很多人完全沒想過的一項。**
大部分教材講 Service 層只講 ①，順便提一下 ②。
但實務上讓你半夜被 call 的，幾乎都是 ③。

### 0.4.2 Service 不是「Controller 與 Repository 之間的轉接頭」

最常見的錯誤 Service，長這樣：

```java
// 🔴 這種 Service 沒有存在的價值
@Service
public class ProductServiceImpl implements ProductService {

    private final ProductRepository repository;

    @Override
    public Product findById(String id) {
        return repository.findById(id).orElseThrow();
    }

    @Override
    public List<Product> findAll() {
        return repository.findAll();
    }

    @Override
    public Product save(Product p) {
        return repository.save(p);
    }

    @Override
    public void delete(String id) {
        repository.deleteById(id);
    }
}
```

這種類別在中文圈有個外號叫「**傳話筒 Service**」。
它有介面、有實作、有 `@Service`、有測試（mock repository 然後
`verify(repository).save(p)`）—— **而它一行業務價值都沒有**。

**四個具體的壞處：**

| 壞處 | 說明 |
|---|---|
| **假的抽象** | 它的方法簽章與 Repository 一模一樣。「換掉 Repository」時它一起要改，所以它沒有隔離任何東西 |
| **假的測試** | `verify(repository).save(p)` 測的是「我呼叫了我呼叫的東西」。**這個測試永遠不會抓到 bug**（04-controller 7.2.3 的同一個病） |
| **鼓勵貧血** | 因為 Service 只轉發，業務邏輯無處可去 → 全部跑回 Controller，或散落在各處 |
| **讓真正的 Service 被淹沒** | 40 個傳話筒 Service 裡混著 3 個真正有邏輯的，code review 會失焦 |

> 📌 **判準**：如果一個 Service 方法的內容是
> 「呼叫一個 Repository 方法然後直接回傳」，
> **它應該不存在** —— Controller 可以直接用 Query Service 或
> Repository 的讀取介面（1.2.4 會給 shop-service 的做法）。

⚠️ **但要小心不要過度反應。** 「Service 必須有邏輯才能存在」不代表
「純 CRUD 的資源不需要 Service」。判準是：

| 情況 | 需要 Service 嗎 |
|---|---|
| 純讀取，沒有授權判斷、沒有組裝 | ❌ 不需要（用 Query Service 直接查） |
| 純讀取，但要判斷「這個 actor 能看到哪些欄位」 | ✅ 需要 |
| 寫入，但只有一個表、沒有規則 | ⚠️ 需要（因為要有交易邊界與稽核），但方法應該很短 |
| 寫入，有規則或跨表 | ✅ 一定需要 |

### 0.4.3 「Use Case」的視角

有一個非常有效的心理模型：

> **一個 Application Service 的公開方法 = 一個使用者故事。**

```
❌ 用資料的角度命名（CRUD 思維）
   OrderService.save(order)
   OrderService.update(order)
   OrderService.updateStatus(id, status)

✅ 用使用者故事的角度命名（use case 思維）
   OrderService.place(PlaceOrderCommand)          客戶下單
   OrderService.cancel(CancelOrderCommand)        客戶或客服取消
   OrderService.markPaid(MarkPaidCommand)         金流回呼確認付款
   OrderService.ship(ShipOrderCommand)            倉庫出貨
   OrderService.changeShippingAddress(...)        客服代改地址
```

**為什麼這個差別很大？**

`updateStatus(id, "SHIPPED")` 這個方法簽章**沒有辦法**表達：
- 只有倉庫角色可以出貨
- 只有 `PAID` 的訂單可以出貨
- 出貨要寫入物流單號與出貨時間
- 出貨後要通知客戶

於是這些規則就只能寫在呼叫端（Controller）—— 又回到 04-controller 0.6 的問題。

而 `ship(ShipOrderCommand)` 這個名字本身就宣告了「這是一個有規則的操作」。

⚠️ **一個很實用的檢查**：
把你的 Service 方法名念給產品經理聽。
如果他/她聽得懂，你的分層大概是對的。
如果他/她問「什麼是 updateStatus」，那個方法就是設計錯了。

> 📌 這也解釋了為什麼 04-controller 站的 `CreateOrderCommand` 要叫 command 而不是 DTO ——
> **它是一個「意圖」而不是「一包資料」**。
> ⚠️ 但 shop-service 的介面已經叫 `create()` 了（04-controller 站一路用到 07 章的
> 350 個測試都在呼叫它）。**這一站不改它** ——
> 1.8.5 會討論 `create` / `place` / `submit` 的命名取捨，
> 以及「為了命名純度去改 350 個測試」值不值得。

---
## 0.5 貧血模型 vs 充血模型 ★

這一節是本章的核心。它決定了你之後八章的程式碼會長什麼樣。

### 0.5.1 兩種寫法對照：同一個「取消訂單」

**規則**（來自 03-rest-api 的契約，04-controller 0.14 練習 4 也用過）：

1. 只有 `PENDING_PAYMENT`、`PAID`、`PARTIALLY_SHIPPED` 可以取消。
2. 已出貨的訂單不能取消（要走退貨流程）。
3. 客戶只能取消自己的訂單；客服可以取消任何訂單但必須填原因。
4. 取消後要記錄原因、取消時間、取消者。
5. 已付款的訂單取消要建立一筆退款。
6. 取消後庫存要還回去。
7. 下單超過 7 天的訂單客戶不能自己取消（要走客服）。

---

**寫法 A：貧血模型（anemic domain model）**

```java
// ── Entity：只有欄位與 getter/setter ────────────────────────
@Entity
public class Order {
    @Id private String id;
    private String customerId;
    private OrderStatus status;
    private BigDecimal totalAmount;
    private Instant createdAt;
    private Instant cancelledAt;
    private String cancelReason;
    private String cancelledBy;

    // ... 40 個 getter，40 個 setter，沒有別的
}
```

```java
// ── Service：所有規則都在這裡 ───────────────────────────────
@Service
public class OrderServiceImpl implements OrderService {

    @Override
    @Transactional
    public Order cancel(CancelOrderCommand cmd) {
        Order order = orderRepository.findById(cmd.orderId())
                .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

        // 規則 3a：客戶只能取消自己的
        if (cmd.actor().isCustomer() && !order.getCustomerId().equals(cmd.actor().id())) {
            throw new ResourceNotFoundException("Order", cmd.orderId());   // 刻意回 404
        }

        // 規則 1、2：狀態判斷
        if (order.getStatus() != OrderStatus.PENDING_PAYMENT
                && order.getStatus() != OrderStatus.PAID
                && order.getStatus() != OrderStatus.PARTIALLY_SHIPPED) {
            throw new OrderNotCancellableException(order.getId(), order.getStatus());
        }

        // 規則 7：7 天
        if (cmd.actor().isCustomer()
                && order.getCreatedAt().isBefore(Instant.now().minus(7, ChronoUnit.DAYS))) {
            throw new OrderNotCancellableException(order.getId(), order.getStatus());
        }

        // 規則 3b：客服必須填原因
        if (cmd.actor().isSupport() && (cmd.note() == null || cmd.note().isBlank())) {
            throw new ValidationFailedException(...);
        }

        // 規則 4：記錄
        order.setStatus(OrderStatus.CANCELLED);
        order.setCancelledAt(Instant.now());
        order.setCancelReason(cmd.reason().name());
        order.setCancelledBy(cmd.actor().id());
        orderRepository.save(order);

        // 規則 5：退款
        if (/* 原本是 PAID？*/ ...) {         // 🔴 已經被上面 setStatus 蓋掉了！
            refundService.create(...);
        }

        // 規則 6：還庫存
        for (OrderItem item : order.getItems()) {
            stockRepository.increase(item.getProductId(), item.getQuantity());
        }
        return order;
    }
}
```

⚠️ **注意第 5 條規則那個 🔴。**
`order.setStatus(CANCELLED)` 已經把原本的狀態蓋掉了，
所以「原本是不是 PAID」查不到了。
於是實務上會出現這種修法：

```java
OrderStatus previousStatus = order.getStatus();     // ← 先存起來
order.setStatus(OrderStatus.CANCELLED);
// ...
if (previousStatus == OrderStatus.PAID) { refundService.create(...); }
```

**它可以動。但你看出問題了嗎？**

> **「取消後要退款」這條規則，現在依賴於「呼叫端有沒有記得先存 previousStatus」。**
> 而 `Order` 這個類別**沒有任何機制**可以強迫你記得。

三個月後，另一個工程師寫「批次取消過期訂單」的排程，
他複製了一部分程式碼但漏了 `previousStatus`。
於是**過期的已付款訂單被取消了，但沒有退款**。

---

**寫法 B：充血模型（rich domain model）**

```java
// ── 聚合：規則在它自己身上 ─────────────────────────────────
package example.shop.order.domain;

public class Order {

    private final String id;
    private final String customerId;
    private OrderStatus status;
    private final Money totalAmount;
    private final Instant createdAt;
    private Cancellation cancellation;      // ★ 取消資訊收成一個值物件

    // ★★ 沒有 public setter。狀態只能透過「有名字的操作」改變。

    /**
     * 取消這張訂單。
     *
     * @return 取消的結果，告訴呼叫端「還需要做什麼」
     * @throws OrderNotCancellableException 當前狀態不允許取消
     */
    public CancellationResult cancel(Actor actor, CancelReason reason,
                                     String note, Instant now) {

        // 規則 1、2：狀態
        if (!status.isCancellable()) {
            throw new OrderNotCancellableException(id, status);
        }

        // 規則 7：客戶的 7 天限制
        if (actor.isCustomer() && createdAt.isBefore(now.minus(SELF_CANCEL_WINDOW))) {
            throw new SelfCancelWindowExpiredException(id, createdAt, SELF_CANCEL_WINDOW);
        }

        // 規則 3b：客服必須填原因
        if (actor.isSupport() && (note == null || note.isBlank())) {
            throw new CancelNoteRequiredException(id);
        }

        // ★★ 關鍵：在改狀態「之前」把需要的資訊算出來
        boolean refundRequired = status.isPaid();
        Money refundAmount = refundRequired ? totalAmount : Money.zero(totalAmount.currency());

        // 規則 4：記錄（狀態與取消資訊一起改，不可能只改一半）
        this.status = OrderStatus.CANCELLED;
        this.cancellation = new Cancellation(actor, reason, note, now);

        // ★ 回傳「還需要做什麼」，而不是自己去做
        return new CancellationResult(
                id,
                refundRequired,
                refundAmount,
                items.stream()
                     .map(i -> new StockRelease(i.productId(), i.quantity()))
                     .toList());
    }

    private static final Duration SELF_CANCEL_WINDOW = Duration.ofDays(7);
}
```

```java
// ── Application Service：只做編排 ───────────────────────────
@Service
public class OrderApplicationService {

    @Transactional
    public CancellationResult cancel(CancelOrderCommand cmd) {

        // ① 取出聚合（規則 3a 的授權判斷放在查詢條件裡 —— 見下方說明）
        Order order = orders.findByIdVisibleTo(cmd.orderId(), cmd.actor())
                .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

        // ② 讓聚合自己判斷與改變
        //    ★ now 只取一次 —— 同一個操作裡的所有時間戳必須相同（0.5.4）
        Instant now = clock.instant();
        CancellationResult result = order.cancel(
                cmd.actor(), cmd.reason(), cmd.note(), now);

        // ③ 存回去
        orders.save(order);

        // ④ 依照聚合告訴我的結果，執行需要的後續（同交易）
        result.stockReleases().forEach(
                r -> stock.release(r.productId(), r.quantity()));

        if (result.refundRequired()) {
            refunds.create(order.id(), result.refundAmount(), cmd.actor());
        }

        // ⑤ 交易外的副作用交給事件（06 章 6.7）
        events.publish(OrderCancelledEvent.from(order, result, now));

        return result;
    }
}
```

**Service 從 40 行變成 15 行，而且沒有一個業務 `if`。**

### 0.5.2 差別在哪：五個具體的、可驗證的差別

| # | 貧血模型 | 充血模型 |
|---|---|---|
| 1 | 「取消要退款」依賴呼叫端記得存 `previousStatus` | **`cancel()` 內部算完才改狀態，呼叫端不可能漏** |
| 2 | 排程、客服後台、API 三個入口各寫一份規則 | **三個入口都呼叫 `order.cancel()`，規則只有一份** |
| 3 | 測試「7 天限制」要 mock repository + 起 Spring | **`new Order(...).cancel(...)` 一行，純 JUnit** |
| 4 | 可以 `order.setStatus(SHIPPED)` 從 `CANCELLED` 直接跳過去 | **沒有 setter，不可能** |
| 5 | 規則寫在 Service，讀 `Order` 這個檔案看不到任何規則 | **打開 `Order.java` 就看得到訂單的全部規則** |

⚠️ **第 3 點的具體差距**（這是最能說服人的一點）：

```java
// 貧血模型：測「客戶不能取消 8 天前的訂單」
@ExtendWith(MockitoExtension.class)
class OrderServiceImplTest {

    @Mock OrderRepository orderRepository;
    @Mock StockRepository stockRepository;
    @Mock RefundService refundService;
    @Mock ApplicationEventPublisher events;
    @InjectMocks OrderServiceImpl service;

    @Test
    void 客戶不能取消八天前的訂單() {
        Order order = new Order();
        order.setId("ord_1");
        order.setCustomerId("cus_1");
        order.setStatus(OrderStatus.PAID);
        order.setCreatedAt(Instant.parse("2026-03-01T00:00:00Z"));
        order.setTotalAmount(new BigDecimal("1000"));
        order.setItems(List.of(/* … */));                     // ← 還得建 items
        when(orderRepository.findById("ord_1")).thenReturn(Optional.of(order));
        // ⚠️ 而且 Instant.now() 寫死在 Service 裡 → 這個測試在 2026-03-08 之後才會過
        // ⚠️ 也就是說：這個測試根本沒辦法寫

        assertThatThrownBy(() -> service.cancel(cmd))
                .isInstanceOf(OrderNotCancellableException.class);
    }
}
```

```java
// 充血模型：同一個測試
class OrderCancelTest {

    @Test
    void 客戶不能取消八天前的訂單() {
        Order order = Orders.paid()                          // Object Mother（04-controller 7.7）
                .createdAt(Instant.parse("2026-03-01T00:00:00Z"))
                .build();

        assertThatThrownBy(() -> order.cancel(
                        Actors.customer("cus_1"),
                        CancelReason.CHANGED_MIND,
                        null,
                        Instant.parse("2026-03-09T00:00:00Z")))   // ★ 時間是參數
                .isInstanceOf(SelfCancelWindowExpiredException.class);
    }
}
```

**沒有 mock、沒有 Spring、沒有 `Instant.now()`、3 毫秒跑完。**

> 📌 **`now` 當參數傳進 domain 方法，是充血模型最重要的一個技巧。**
> 它讓「跟時間有關的規則」變成純函式。
> ⚠️ 而 Application Service 那一層用注入的 `Clock`（1.4.6），
> 於是整個系統只有一個地方會呼叫「現在幾點」。

### 0.5.3 值物件：讓「忘記」在型別上不可能

0.3.2 的事故 4（金額差 0.0005 元）的根因是：
**`BigDecimal` 允許你忘記 `setScale`。**

```java
// 🔴 每一步都要記得，而「記得」是不可靠的
BigDecimal unitPrice = p.getPrice().multiply(new BigDecimal("0.95"));
```

解法是一個 `Money` 值物件：

```java
package example.shop.common.money;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Currency;
import java.util.Objects;

/**
 * 金額值物件。
 *
 * <p>★★ 它存在的唯一理由：<b>讓「忘記處理小數位」在型別上不可能發生</b>。
 *
 * <p>三個保證：
 * <ol>
 *   <li>任何運算的結果都已經 {@code setScale(幣別小數位, HALF_UP)}。</li>
 *   <li>不同幣別不能相加 —— 那是編譯不出來的錯誤變成執行期的明確例外。</li>
 *   <li>不可變 —— 不會有「A 的金額被 B 改掉」。</li>
 * </ol>
 *
 * <p>⚠️ 為什麼不用 {@code long}（以「分」為單位）：
 * 因為 TWD 的小數位是 2 但 JPY 是 0、KWD 是 3 ——
 * 「乘以 100」這個假設會在第一次接國際金流時破掉。
 * 讓幣別自己說它有幾位小數，是唯一不會錯的做法。
 *
 * <p>⚠️ 而 04-controller 6.5.7 說「金額對外序列化成字串」——
 * 那是**同一個決定的另一半**：
 * 這裡保證計算正確，那裡保證傳輸不失真。
 */
public record Money(BigDecimal amount, Currency currency) implements Comparable<Money> {

    public Money {
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(currency, "currency");
        // ★★ 正規化發生在建構子 —— 於是「不正規的 Money」不存在
        amount = amount.setScale(currency.getDefaultFractionDigits(), RoundingMode.HALF_UP);
    }

    public static Money of(String amount, String currencyCode) {
        return new Money(new BigDecimal(amount), Currency.getInstance(currencyCode));
    }

    public static Money twd(String amount) {
        return of(amount, "TWD");
    }

    public static Money zero(Currency currency) {
        return new Money(BigDecimal.ZERO, currency);
    }

    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(amount.add(other.amount), currency);
    }

    public Money minus(Money other) {
        requireSameCurrency(other);
        return new Money(amount.subtract(other.amount), currency);
    }

    /** ★ 乘上「數量」——結果自動 setScale。 */
    public Money times(int quantity) {
        if (quantity < 0) throw new IllegalArgumentException("quantity 不可為負");
        return new Money(amount.multiply(BigDecimal.valueOf(quantity)), currency);
    }

    /**
     * 乘上一個比率（折扣、稅率）。
     *
     * <p>★ 用 {@code BigDecimal} 而不是 {@code double} ——
     * {@code 0.95} 這個 double 實際上是 {@code 0.9499999999999999556}。
     */
    public Money times(BigDecimal rate) {
        return new Money(amount.multiply(rate), currency);
    }

    /**
     * 按比例分攤（折扣要分到每一筆明細時用）。
     *
     * <p>⚠️⚠️ 這是實務上最容易出錯的一個運算：
     * 100 元折扣分到 3 筆明細，每筆 33.33，加起來是 99.99 —— <b>少了 1 分</b>。
     *
     * <p>正確做法是「先算前 n-1 筆，最後一筆用減法補齊」——
     * 這個方法把它封起來，讓你不需要每次都想一遍。
     *
     * @param weights 每一筆的權重（通常是各明細的小計）
     * @return 分攤結果，<b>保證加總等於原金額</b>
     */
    public java.util.List<Money> allocate(java.util.List<BigDecimal> weights) {
        BigDecimal totalWeight = weights.stream()
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        if (totalWeight.signum() == 0) {
            throw new IllegalArgumentException("權重總和不可為 0");
        }
        var result = new java.util.ArrayList<Money>(weights.size());
        Money allocated = zero(currency);
        for (int i = 0; i < weights.size() - 1; i++) {
            Money part = new Money(
                    amount.multiply(weights.get(i))
                          .divide(totalWeight, currency.getDefaultFractionDigits(),
                                  RoundingMode.HALF_UP),
                    currency);
            result.add(part);
            allocated = allocated.plus(part);
        }
        result.add(this.minus(allocated));          // ★ 最後一筆吸收誤差
        return result;
    }

    // ⚠️⚠️ 前向指標（05 章 5.8.3 / 5.13 ②）：下面這三個 isXxx() 會被 Jackson
    //    當成 boolean getter → Money 序列化出 5 個欄位而建構子只認得 2 個
    //    → 🔴【Jackson 往返直接失敗】。
    //    ✅ 它在 API 上沒事（03 章 3.8.4 規定金額是 String），
    //    🔴 但在【快取】與【outbox】上會出事（那是另一個 ObjectMapper）。
    //    處置：不改 Money（不讓 domain 依賴 Jackson），改快取的 ObjectMapper
    //    （`IS_GETTER → NONE`，05 章 5.8.5）。
    public boolean isZero()      { return amount.signum() == 0; }
    public boolean isPositive()  { return amount.signum() > 0; }
    public boolean isNegative()  { return amount.signum() < 0; }

    public boolean isGreaterThanOrEqual(Money other) {
        requireSameCurrency(other);
        return amount.compareTo(other.amount) >= 0;
    }

    public boolean isLessThan(Money other) {
        requireSameCurrency(other);
        return amount.compareTo(other.amount) < 0;
    }

    @Override
    public int compareTo(Money other) {
        requireSameCurrency(other);
        return amount.compareTo(other.amount);
    }

    /** ★ 對外的字串表示（04-controller 6.5.7 的 serializer 用它）。 */
    public String toPlainString() {
        return amount.toPlainString();
    }

    private void requireSameCurrency(Money other) {
        if (!currency.equals(other.currency)) {
            // ⚠️ 這是「程式錯誤」不是「使用者錯誤」→ 用 IllegalArgumentException
            //    它會被 03 章的 catch-all 變成 500，那是對的：
            //    幣別不一致代表資料或程式有問題，不該告訴使用者「請修改請求」
            throw new IllegalArgumentException(
                    "幣別不一致：%s vs %s".formatted(currency, other.currency));
        }
    }
}
```

**用了它之後，事故 4 在型別上不可能發生：**

```java
Money unitPrice = product.price().times(new BigDecimal("0.95"));   // 已 setScale
Money lineTotal = unitPrice.times(quantity);                        // 已 setScale
Money subtotal  = lines.stream()
        .map(OrderLine::lineTotal)
        .reduce(Money.zero(TWD), Money::plus);                      // 已 setScale
```

⚠️ **`allocate()` 那個方法值得單獨強調。**
「100 元折扣分到 3 筆，加起來是 99.99」這個 bug
在幾乎每一個電商系統都出現過一次。
它的症狀是**發票金額與訂單金額差 1 分錢**，而財務會在半年後才發現。

```java
@Test
void 折扣分攤後加總必須等於原折扣() {
    Money discount = Money.twd("100");
    var parts = discount.allocate(List.of(
            new BigDecimal("300"), new BigDecimal("300"), new BigDecimal("300")));

    assertThat(parts).containsExactly(
            Money.twd("33.33"), Money.twd("33.33"), Money.twd("33.34"));  // ← 最後一筆吸收
    assertThat(parts.stream().reduce(Money.twd("0"), Money::plus))
            .isEqualTo(discount);                                          // ★ 保證加總相等
}
```

> 📌 **值物件的判準**：如果一個概念滿足以下三點，它就該是值物件。
>
> 1. **由值定義相等**（兩個 100 元 TWD 是同一個東西，不像兩個客戶）。
> 2. **有自己的規則**（不同幣別不能相加）。
> 3. **常常被一起傳遞**（`amount` 與 `currency` 從來不會單獨出現）。
>
> shop-service 的值物件：`Money`、`Quantity`、`Address`、`Cancellation`、
> `OrderNumber`、`TaxId`。

### 0.5.4 充血模型不是「把所有東西塞進 Entity」

這是最常見的誤解，而且它會造出比貧血更糟的東西。

```java
// 🔴🔴 這不是充血模型，這是災難
@Entity
public class Order {

    @Autowired                                    // 🔴 Entity 裡注入！
    private transient OrderRepository repository;

    @Autowired
    private transient PaymentGateway paymentGateway;

    public void cancel(Actor actor) {
        // ...
        repository.save(this);                    // 🔴 自己存自己
        paymentGateway.refund(this.paymentId);    // 🔴 Entity 打外部 API
        emailSender.send(...);                    // 🔴
    }
}
```

**四個致命問題：**

| 問題 | 說明 |
|---|---|
| **不能 `new`** | 測試要起 Spring container 才能建一個 `Order` → 充血模型最大的好處消失 |
| **交易邊界不明** | `repository.save(this)` 在誰的交易裡？呼叫端完全看不出來 |
| **序列化與 JPA 會炸** | JPA 用反射建物件時不會注入；Jackson 反序列化出來的 `Order` 的 repository 是 null |
| **依賴方向反了** | Domain 依賴基礎設施 → 06 章換掉 Repository 時 Domain 要改 |

**正確的界線：**

```
┌────────────────────────────────────────────────────────────┐
│ Domain（Order、OrderStatus、Money、PricingPolicy）           │
│                                                            │
│ ✅ 可以：純運算、狀態判斷、狀態轉移、拋領域例外                 │
│ ✅ 可以：接收「外面算好的東西」當參數（now、pricedLines）       │
│ ✅ 可以：回傳「還需要做什麼」（CancellationResult）            │
│                                                            │
│ ❌ 不可以：注入任何 Spring bean                              │
│ ❌ 不可以：碰 Repository、HTTP、檔案、Redis                   │
│ ❌ 不可以：Instant.now()、UUID.randomUUID()、Math.random()   │
│ ❌ 不可以：@Transactional                                   │
│                                                            │
│ 📌 一句話：Domain 裡不可以有任何 import 指向                  │
│    org.springframework.* 或 jakarta.persistence.*           │
│    （唯一妥協見 0.11.2 的 ArchUnit 規則）                     │
└────────────────────────────────────────────────────────────┘
```

⚠️ **「Domain 不可以呼叫 `Instant.now()`」這一條特別重要，但常被忽略。**

```java
// 🔴 錯：規則變成不可測
public CancellationResult cancel(Actor actor, CancelReason reason) {
    if (createdAt.isBefore(Instant.now().minus(SELF_CANCEL_WINDOW))) { ... }
    this.cancelledAt = Instant.now();       // ← 而且這兩個 now() 還可能不同！
}

// ✅ 對：時間從外面傳進來
public CancellationResult cancel(Actor actor, CancelReason reason,
                                 String note, Instant now) {
    if (createdAt.isBefore(now.minus(SELF_CANCEL_WINDOW))) { ... }
    this.cancellation = new Cancellation(actor, reason, note, now);
}
```

> **副作用**：`now` 當參數之後，「同一個操作裡的所有時間戳都相同」變成自動保證。
> 而那個保證在對帳與排序時非常重要 ——
> 「取消時間比退款時間晚 3 毫秒」這種資料會讓報表的因果關係看起來是反的。

### 0.5.5 判準：`Order` 能不能自己回答這個問題

當你猶豫一段邏輯該放 Domain 還是 Service 時，問這一句：

> **「這個判斷需要的資訊，是不是全部都在這個聚合裡面？」**

| 判斷 | 需要什麼 | 放哪 |
|---|---|---|
| 這張訂單現在可以取消嗎 | `status`、`createdAt` | **Domain**（`Order.cancel()`） |
| 這張訂單的總金額是多少 | `lines`、`discount`、`shippingFee` | **Domain** |
| 這個狀態可以轉到那個狀態嗎 | 只有兩個 enum 值 | **Domain**（`OrderStatus`） |
| 這個運費多少 | `address`、`subtotal`、`weight` | **Domain**（`ShippingFeePolicy`，純函式） |
| 這個客戶今天已經取消幾張了 | **要查別的訂單** | **Service** |
| 這個商品還有庫存嗎 | **要查 Stock 聚合** | **Service** |
| 這個優惠券還能用嗎 | 券自己的狀態 → Domain；**「這個客戶用過沒」** → Service | 兩者都有 |
| 這個地址是這個客戶的嗎 | **要查 Address 聚合** | **Service**（或查詢條件） |

**規律很清楚：**

```
判斷只看「一個聚合的內部狀態」  → Domain
判斷需要「另一個聚合」或「查詢」  → Service
```

⚠️ **而 Service 的正確做法是「把查到的東西當參數傳給 Domain」**，
而不是「在 Service 裡做判斷」：

```java
// ⚠️ 可以，但規則跑到 Service 了
@Transactional
public void applyCoupon(String orderId, String code) {
    Order order = orders.findById(orderId).orElseThrow();
    Coupon coupon = coupons.findByCode(code).orElseThrow();

    // ⚠️ 注意這裡需要 Coupon 上有 isExpired() 這種「拆開的述詞」——
    //    而 0.12 ⑨ 的 Coupon 刻意沒有它，只有一個 discountFor()。
    //    ★ 那不是疏漏：拆開的述詞會邀請呼叫端「自己組規則」，
    //      而組法有很多種（少檢查一條、順序不同、忘了折扣上限）。
    if (clock.instant().isAfter(coupon.endAt())) throw new CouponExpiredException(code);
    if (order.subtotal().isLessThan(coupon.minAmount())) {
        throw new CouponMinAmountNotMetException(code, coupon.minAmount());
    }
    order.setDiscount(coupon.discountFor(order.subtotal(), order.lines(), now));  // 🔴 setter
}

// ✅ 更好：Service 只負責「取出」，判斷交給 Domain
@Transactional
public void applyCoupon(String orderId, String code) {
    Order order = orders.findById(orderId).orElseThrow();
    Coupon coupon = coupons.findByCode(code)
            .orElseThrow(() -> new CouponNotFoundException(code));

    order.applyCoupon(coupon, clock.instant());     // ★ 規則在 Order 與 Coupon 裡
}
```

`Order.applyCoupon()` 內部：

> ⚠️ **這個方法沒有出現在 0.9.2 的 `Order` 完整定義裡**，那是刻意的：
> shop-service 的券**只能在下單時套用**（`Order.place()` 的參數），
> 不支援「先建訂單再套券」。
> 這裡把它寫出來，是因為它是「把物件當協作者傳進去」最清楚的例子。
>
> 👉 如果你的系統真的需要「事後套券」，`applyCoupon()` 就要進 `Order`，
> 而它會需要 `status.isEditable()` 的守衛與 `transitionTo` 之外的一致性檢查
> —— 而那正是這個方法第一行在做的事。

```java
public void applyCoupon(Coupon coupon, Instant now) {
    if (!status.isEditable()) {
        throw new OrderItemImmutableException(id, status);
    }
    if (this.appliedCoupon != null) {
        throw new CouponAlreadyAppliedException(id, this.appliedCoupon.code());
    }
    // ★ 讓 Coupon 自己判斷它能不能用在這個小計上
    // ⚠️ 三個參數：小計、明細（券可能只適用部分商品）、現在
    //    完整簽章見 0.12 ⑨；01 章 1.6.6 會把 List<OrderLine> 換成 DiscountableLine
    Money discount = coupon.discountFor(subtotal(), lines, now);  // 不能用時它自己拋例外
    this.appliedCoupon = new AppliedCoupon(coupon.code(), coupon.name(), discount);
}
```

> 📌 **這叫「把物件當協作者傳進去」**，是充血模型最實用的一招。
> Service 負責「**去哪裡拿**」（I/O），Domain 負責「**拿到之後怎麼判斷**」（規則）。

### 0.5.6 為什麼 Java 生態長期停在貧血模型

值得知道，因為它解釋了為什麼你看到的大部分 Java 專案都是貧血的 ——
**那不完全是工程師的錯**，有四個結構性原因：

| 原因 | 說明 | 現在還成立嗎 |
|---|---|---|
| **JPA 需要無參建構子與可變欄位** | Hibernate 用反射 `new` 然後 set 欄位 | ⚠️ 部分成立。可以用 package-private 建構子 + 沒有 public setter 化解（0.9.2） |
| **早期的框架文件都是貧血範例** | Spring 官方 Petclinic、各種入門書 | ✅ 已改變，但慣性還在 |
| **序列化（Jackson / 早期的 XML）需要 getter/setter** | | ❌ 不成立了。`record` + `@JsonCreator`，而且**Entity 本來就不該直接序列化**（03 章） |
| **「Entity 只放資料」是一種可以被規範化的紀律** | 大團隊喜歡可以寫進 checklist 的規則 | ⚠️ 這是真實的組織理由，不是技術理由 |

**最重要的一點是：**

> **貧血模型在「一個規則只有一個入口」的時候是可以動的。
> 它在「第二個入口出現」的那一天崩掉。**

而第二個入口一定會出現：排程、批次匯入、客服後台、
資料修正腳本、另一個團隊的服務、GraphQL、gRPC……

⚠️ **這一站的立場**：

> **不要求你把所有東西都做成充血模型。**
> 要求你能**說出每一段邏輯為什麼放在那裡**，
> 並且知道「這個決定的代價會在什麼時候顯現」。
>
> shop-service 的做法是**混合的**：
> - `Order`、`OrderStatus`、`Money`、`Coupon` 是充血的（規則密集）。
> - `AuditLog`、`ExportJob` 幾乎是貧血的（只是資料）。
> - **而這是刻意的**：對「只是資料」的東西套充血模型是純粹的成本。

---
## 0.6 四層職責表

04-controller 站講的是三層（Controller / Service / Repository）。
這一站要把中間那一層**再切成兩層**：

```
┌──────────────────────────────────────────────────────────────────┐
│ ① Web 層（04-controller 站，已完成）                                  │
│    example.shop.order.web                                        │
│    HTTP ⇄ Java 的翻譯。不認識業務規則。                             │
└────────────────────────┬─────────────────────────────────────────┘
                         │ Command / Query 物件（純 Java）
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ ② Application Service 層（本站，新）                               │
│    example.shop.order.application                                │
│                                                                  │
│    「這個 use case 的步驟」+「交易邊界」+「跨聚合的協調」             │
│    · @Transactional 只出現在這裡                                   │
│    · 注入 Repository、埠、Clock、事件發佈器                         │
│    · ⚠️ 不做業務判斷（除了「需要查別的聚合才能判斷」的那些）           │
└──────┬───────────────────────────────────────────┬───────────────┘
       │ 呼叫聚合上的方法                             │ 呼叫埠 / Repository
       ▼                                            ▼
┌────────────────────────────────┐   ┌──────────────────────────────┐
│ ③ Domain 層（本站，新）          │   │ ④ 基礎設施（06-repository 等） │
│    example.shop.order.domain    │   │    Repository 實作            │
│                                 │   │    PaymentGateway 實作        │
│    Order、OrderStatus、Money、   │   │    通知、快取、訊息            │
│    PricingPolicy、               │   │                              │
│    ShippingFeePolicy             │   │  ⚠️ 依賴方向：③ 不認識 ④       │
│                                 │   │     ④ 實作 ③ 定義的介面        │
│    ✅ 純 Java，零框架依賴          │   │     （1.7 的埠與轉接器）       │
│    ✅ 可以 new 出來測試            │   │                              │
└────────────────────────────────┘   └──────────────────────────────┘
```

### 0.6.1 每一層能看到什麼、不能看到什麼

| | Web | Application Service | Domain | 基礎設施 |
|---|---|---|---|---|
| `HttpServletRequest` | ✅ | ❌ | ❌ | ❌ |
| `@Transactional` | ❌ | ✅ **只有這裡** | ❌ | ⚠️ 只在極少數情況 |
| Repository | ❌ | ✅ | ❌ | ✅（實作） |
| 另一個聚合 | ❌ | ✅ | ⚠️ 只能當參數收 | ❌ |
| `Instant.now()` | ❌ | ⚠️ 透過注入的 `Clock` | ❌ **一定是參數** | ✅ |
| 外部 API | ❌ | ✅ 透過埠介面 | ❌ | ✅（實作埠） |
| 業務規則 | ❌ | ⚠️ 只有跨聚合那些 | ✅ **主要在這裡** | ❌ |
| 拋 `BusinessException` | ❌ | ✅ | ✅ | ⚠️ 轉譯技術例外 |
| Spring 註解 | ✅ | ✅ | ❌ **零** | ✅ |

⚠️ **「Domain 零 Spring 依賴」是一條可以用 ArchUnit 守住的硬規則**（0.11.2）。
它的價值不是「純潔」，而是：

> **Domain 層的測試不需要 Spring context。**
> 於是 800 個 domain 測試在 4 秒內跑完，
> 而不是 2 分鐘（04-controller 7.4.5 的 context 快取問題）。

### 0.6.2 一個請求的完整穿透：`POST /orders`

把 0.5 學到的東西套到下單這個 use case 上，
**四層各做什麼一目了然**：

```
HTTP: POST /orders
      Idempotency-Key: idem-abc
      Authorization: Bearer …
      {"items":[{"productId":"P-1","quantity":2}],"shippingAddressId":"addr_1",
       "couponCode":"SPRING10"}
   │
   ▼
┌── ① Web 層 ────────────────────────────────────────────────────────┐
│ · CachedBodyFilter 包住 body（04-controller 4.4.6）                          │
│ · TraceIdFilter 產生 traceId（04-controller 4.5）                            │
│ · IdempotencyInterceptor 檢查 Redis 有沒有這個 key（04-controller 4.9）        │
│ · Spring Security 驗 token → CurrentUser                            │
│ · @Valid 驗 CreateOrderRequest（04-controller 2.x）                              │
│ · CurrentActorArgumentResolver → Actor                              │
│ · OrderWebMapper.toCommand(request, actor, idempotencyKey)          │
│                                                                     │
│ 產出：CreateOrderCommand（⚠️ 裡面沒有任何價格欄位 —— 04-controller 1.12.5）   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌── ② OrderApplicationService.create(cmd) ───────────────────────────┐
│ @Transactional 從這裡開始 ← ★ 交易邊界                                │
│                                                                     │
│ 1. 冪等：查 order_idempotency 表（04-controller 站只做了 Redis 那一半，05 章）    │
│ 2. 授權：addresses.findByIdAndCustomerId(cmd.shippingAddressId(),    │
│                                          cmd.actor().id())          │
│    → 空 → ResourceNotFoundException（刻意回 404 而不是 403）          │
│ 3. 取商品：products.findAllById(productIds)                          │
│    → 缺 → ProductNotFoundException                                  │
│ 4. 取客戶摘要：customers.summaryOf(cmd.actor().id())（等級 + email）  │
│ 5. 扣庫存：stock.tryReserve(...)  ← ★ 原子 SQL，不是 if              │
│    → 失敗 → InsufficientStockException                              │
│ 6. 取優惠券（若有）：coupons.findByCode(...)                          │
│ 7. ★★ 呼叫 Domain 算價與建訂單：                                     │
│       Order.place(customer, pricedLines, address, coupon,           │
│                   shippingFeePolicy, clock.instant())               │
│ 8. orders.save(order)                                               │
│ 9. 券計數：coupons.tryConsume(code)  ← ★ 原子 SQL                   │
│ 10. 稽核：audit.record(...)（同交易，因為要能一起回滾）                 │
│ 11. events.publish(new OrderPlacedEvent(...))  ← AFTER_COMMIT       │
│                                                                     │
│ @Transactional 到這裡結束（commit）← ★ 交易邊界                       │
│                                                                     │
│ commit 之後（06 章 6.7 的 @TransactionalEventListener）：            │
│   · 寄確認信      · 推 ERP      · 清購物車快取     · 加點數           │
│   ⚠️ 全部在交易外、在別的執行緒、失敗不影響訂單                         │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌── ③ Domain：Order.place(...) ──────────────────────────────────────┐
│ ✅ 純運算，零 I/O，可以 new 出來測                                    │
│                                                                     │
│ · 檢查明細不為空、數量在 1..99                                        │
│ · PricingPolicy.priceOf(product, customerLevel, now) → Money        │
│   （會員價 → 促銷價 → 原價，一個純函式）                              │
│ · 每筆 lineTotal = unitPrice.times(qty)   ← Money 保證 setScale       │
│ · subtotal = Σ lineTotal                                            │
│ · coupon.discountFor(subtotal, lines, now) → Money（券自己判斷）      │
│ · ShippingFeePolicy.feeFor(address, subtotal.minus(discount))        │
│ · total = subtotal - discount + shippingFee                         │
│ · 不變量檢查：total >= 0                                             │
│ · status = PENDING_PAYMENT，expiresAt = now + 30 分鐘                │
│                                                                     │
│ 產出：一個 Order 聚合，內部狀態一定合法                                │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌── ④ 基礎設施 ───────────────────────────────────────────────────────┐
│ · OrderRepository（06 章：JdbcTemplate / 08 章：JPA）                 │
│ · StockPort.tryReserve → UPDATE … WHERE available >= ?               │
│ · ErpAdapter implements ErpPort（06 章 6.4 的 RestClient + 逾時）      │
└─────────────────────────────────────────────────────────────────────┘
```

⚠️ **請注意第 5 步與第 7 步的順序。** 「扣庫存」在「算價」之前。

為什麼？因為**扣庫存是最可能失敗、也最需要早失敗的一步**。
如果算完價、建好訂單、寫好稽核才發現庫存不足，
那些工作全部浪費（而且會白白佔用鎖）。

> 📌 **編排順序的一般原則**：
> **越可能失敗、成本越低的檢查，越早做。**
> 這條原則會在 02 章 2.10（減少鎖持有時間）再出現一次。

⚠️ **但它有一個例外**：如果「早失敗的檢查」本身需要拿鎖，
而「算價」不需要，那麼把算價放前面反而**縮短了鎖的持有時間**。
shop-service 的選擇是「扣庫存用原子 SQL 不拿長鎖」，
所以先扣沒有代價。

### 0.6.3 什麼時候不需要 Domain 層

**不是每個資源都值得四層。** 硬套四層在 CRUD 資源上是純成本。

| 資源 | 有規則嗎 | 建議 |
|---|---|---|
| `Order` | 11 條不變量、7 個狀態、5 個 use case | ✅ 完整四層 |
| `Coupon` | 5 條規則（有效期、最低消費、次數、適用範圍） | ✅ 充血的 `Coupon` |
| `Product` | 3 條（上架狀態、可購買性、價格） | ⚠️ 輕度充血 |
| `Address` | 只有格式驗證（04-controller 2.x 已做） | ❌ record 即可 |
| `AuditLog` | 沒有 | ❌ record + Repository |
| `ExportJob` | 有狀態機但只有 4 個轉移 | ⚠️ 一個小 enum 就夠 |

**shop-service 的實際分佈：**

```
order/      ✅ 完整四層（web / application / domain / 埠）
coupon/     ✅ 充血 domain，Application Service 很薄
product/    ⚠️ domain 只有 Product + PricingPolicy
stock/      ⚠️ 幾乎沒有 domain —— 因為它的規則「stock >= 0」
            ★★ 是由「原子 SQL + 資料庫約束」守的，不是 Java 程式碼
customer/   ❌ 貧血（這一站只用到「查等級」）
audit/      ❌ 貧血
```

⚠️ **`stock/` 那一列是本章最反直覺的一點，值得單獨想一想**：

> 「庫存不能小於 0」是一條**業務規則**，
> 但它**不能**寫在 Java 裡（0.3.2 事故 3）。
> **有些不變量的唯一可靠位置是資料庫。**

這不是「偷懶」或「把邏輯洩漏到資料庫」——
而是「**選擇一個真的守得住的位置**」。
0.8.3 會把這件事完整展開。

---

## 0.7 邏輯該放哪：七個判準 ★

04-controller 0.7 給了五個問題判斷「Controller vs 其他」。
這裡的七個問題判斷「**Domain vs Application Service vs 基礎設施**」。

### 判準 1：這段程式碼需要 I/O 嗎？

```
需要（查 DB、打 API、讀檔、發訊息）  → Application Service 或基礎設施
不需要（純運算、純判斷）              → Domain
```

**這是最快、最不會錯的一個判準，先問它。**

| 程式碼 | I/O? | 放哪 |
|---|---|---|
| `subtotal.minus(discount).plus(shippingFee)` | ❌ | Domain |
| `orders.findById(id)` | ✅ | Application Service |
| `status == PAID \|\| status == PARTIALLY_SHIPPED` | ❌ | Domain |
| `paymentGateway.charge(...)` | ✅ | Application Service（透過埠） |

⚠️ **陷阱**：`Instant.now()` 與 `UUID.randomUUID()` **算 I/O**。
它們讀取「外部狀態」（系統時鐘、亂數源），
所以它們讓函式不再是純函式 → 不能在 Domain 裡呼叫。

### 判準 2：這個判斷只看單一聚合的狀態嗎？

```
只看一個聚合內部          → Domain
需要另一個聚合或查詢結果   → Application Service（但把結果傳給 Domain 判斷）
```

**0.5.5 已經展開過這一條。**

### 判準 3：這段程式碼失敗時，要回滾什麼？

```
要回滾資料庫的多個寫入      → Application Service（它管交易）
不寫入任何東西             → Domain
要回滾「外部世界」（信、簡訊）→ 🔴 回滾不了 → 移到 commit 之後
```

⚠️ **這一條是 0.3.2 事故 1、2 的直接判準。**

問自己：「這一步失敗，前面做過的事該不該消失？」

| 步驟 | 失敗時前面的事該消失嗎 | 結論 |
|---|---|---|
| 扣庫存失敗 | ✅ 訂單不該存在 | 同交易 |
| 券計數失敗（已用完） | ✅ 訂單不該存在 | 同交易 |
| 稽核寫入失敗 | ✅ ⚠️ 可辯論，shop-service 選同交易 | 同交易 |
| 加點數失敗 | ❌ 訂單該成立，點數之後補 | **事件 + 重試** |
| 寄信失敗 | ❌ | **事件，失敗只記 log** |
| 推 ERP 失敗 | ❌ 但不能遺失 | **事件 + outbox + 重試**（06 章 6.9） |

### 判準 4：它需要知道「現在幾點」嗎？

```
需要 → 時間必須是「參數」，而取得時間的地方在 Application Service
```

**為什麼這值得當一個獨立判準？**
因為「時間」是最常被偷偷寫死在 Domain 裡的 I/O，
而它造成的問題最隱蔽：

```java
// 🔴 這個測試無法寫
public boolean isExpired() {
    return Instant.now().isAfter(expiresAt);
}

// ✅ 這個可以
public boolean isExpired(Instant now) {
    return now.isAfter(expiresAt);
}
```

⚠️ **而「同一個操作裡兩次 `now()` 不相等」會造出真實的 bug**：

```java
// 🔴 在午夜前 1 毫秒執行
order.setCreatedAt(Instant.now());        // 2026-03-15T23:59:59.9995Z
auditLog.setCreatedAt(Instant.now());     // 2026-03-16T00:00:00.0002Z
// → 稽核紀錄的日期比訂單晚一天 → 對帳報表把它們算在不同天
```

### 判準 5：它會不會被第二個入口用到？

```
會（排程、批次、客服後台、另一個 API）→ 一定要往下推到 Domain 或共用的 Service
只有這一個入口                        → 可以先留在 Application Service
```

⚠️ **但「只有這一個入口」幾乎總是暫時的。**

實務上的做法：**規則放 Domain，編排放 Application Service**。
於是第二個入口出現時，你只需要寫一個新的編排，規則自動共用。

```java
// 入口 1：API
@Transactional
public CancellationResult cancel(CancelOrderCommand cmd) {
    Order order = orders.findByIdVisibleTo(cmd.orderId(), cmd.actor()).orElseThrow(...);
    var result = order.cancel(cmd.actor(), cmd.reason(), cmd.note(), clock.instant());
    // ...
}

// 入口 2：排程「取消 30 分鐘未付款的訂單」
@Transactional
public void expireUnpaidOrders() {
    Instant now = clock.instant();
    for (Order order : orders.findExpiredPendingPayment(now, BATCH_SIZE)) {
        // ★★ 完全同一個 cancel()，規則一行都沒有重寫
        var result = order.cancel(Actor.SYSTEM, CancelReason.PAYMENT_TIMEOUT, null, now);
        orders.save(order);
        result.stockReleases().forEach(r -> stock.release(r.productId(), r.quantity()));
        events.publish(new OrderCancelledEvent(order.id(), CancelReason.PAYMENT_TIMEOUT, now));
    }
}
```

⚠️ **注意排程用的是 `Actor.SYSTEM`**，而 `Order.cancel()` 裡的
「客戶 7 天限制」與「客服必須填原因」都不會套用在它身上 ——
因為那兩條規則的條件是 `actor.isCustomer()` / `actor.isSupport()`。

**這正是「把 actor 傳進 domain」的價值**：
角色相關的規則也只有一份。

### 判準 6：它有沒有「不變量」要守？

```
有，而且不變量只涉及一個聚合  → Domain 的建構子與方法裡守
有，涉及多個聚合或多筆資料    → Application Service + 鎖 + 資料庫約束（0.8）
沒有                        → 純計算，放哪都行（放 Domain 比較好測）
```

### 判準 7：這個抽象「換掉實作」時會不會影響業務規則？

```
會 → 它不是抽象，它是規則 → Domain
不會 → 它是基礎設施 → 定義介面（埠）放 Domain 或 Application，實作放基礎設施
```

**例子：**

```java
// 這是「規則」——換一個計算方式就是換一條業務規則
public interface ShippingFeePolicy {
    Money feeFor(Address address, Money orderAmount);
}
// → 放 order.domain。多個實作代表「多種運費方案」，是業務概念。

// 這是「基礎設施」——換 HTTP client 不影響任何規則
public interface ErpPort {
    void pushOrder(OrderSnapshot snapshot);
}
// → 介面放 order.application.port，實作放 order.infrastructure。
```

### 0.7.1 決策流程圖

```
                     ┌──────────────────────────┐
                     │ 一段業務相關的程式碼        │
                     └────────────┬─────────────┘
                                  ▼
                    ┌───────────────────────────────┐
                    │ 它認識 HTTP 的詞彙嗎？          │
                    │（狀態碼、header、request）      │
                    └──────┬─────────────────┬──────┘
                        是 │                 │ 否
                           ▼                 ▼
                   ┌──────────────┐   ┌─────────────────────────────┐
                   │ Web 層（04）  │   │ 它需要 I/O 嗎？               │
                   └──────────────┘   │（DB / API / now() / random）  │
                                      └────┬──────────────────┬─────┘
                                        是 │                  │ 否
                                           ▼                  ▼
                        ┌──────────────────────────┐   ┌─────────────────────┐
                        │ 它是「取得資料」還是         │   │ 它是「規則 / 計算」   │
                        │ 「決定步驟順序」？           │   │        ↓            │
                        └───┬──────────────────┬────┘   │ ┌─────────────────┐ │
                    取得資料 │                  │ 決定順序 │ │ 只看一個聚合？    │ │
                            ▼                  ▼        │ └──┬───────────┬──┘ │
              ┌──────────────────────┐  ┌────────────┐  │  是 │           │ 否  │
              │ Repository / 埠       │  │ Application│  │    ▼           ▼    │
              │ （介面在上層，         │  │ Service    │  │ ┌────────┐ ┌──────┐│
              │   實作在基礎設施）      │  │ @Transact… │  │ │ Domain │ │ Policy││
              └──────────────────────┘  └────────────┘  │ │ 聚合方法 │ │純函式 ││
                                                        │ └────────┘ └──────┘│
                                                        └─────────────────────┘
```

⚠️ **「Policy 純函式」那一格值得說明。**
有些規則不屬於任何聚合 —— 例如「運費怎麼算」既不屬於 `Order`
也不屬於 `Address`。它們是**獨立的策略物件**：

```java
package example.shop.order.domain;

/**
 * 運費計算策略。
 *
 * <p>★★ 為什麼它是一個介面而不是 {@code Order} 上的方法：
 * <ol>
 *   <li>運費方案會變（免運門檻調整、外島加價調整），而<b>訂單的歷史運費不能變</b>。
 *       把它做成獨立物件，才能讓「舊訂單用舊方案、新訂單用新方案」。</li>
 *   <li>它會被<b>試算</b>用到 —— 購物車頁面要顯示「還差 200 元免運」，
 *       那時候還沒有 {@code Order}。</li>
 *   <li>它是純函式，可以用 {@code @ParameterizedTest} 把所有縣市 × 金額組合掃一遍
 *       （04-controller 7.8 的手法）。</li>
 * </ol>
 */
public interface ShippingFeePolicy {

    Money feeFor(Address address, Money amountAfterDiscount);

    /** ★ 給購物車頁「還差多少免運」用。null = 已免運或不適用。 */
    Money amountToFreeShipping(Address address, Money amountAfterDiscount);
}
```

```java
package example.shop.order.domain;

/**
 * 2026 年的運費方案。
 *
 * <p>⚠️ 類別名帶年份是刻意的 —— 它明示「這個東西會被取代而不是被修改」。
 * 舊訂單的運費已經寫在 order 表裡，不會因為換方案而變動。
 */
public class ShippingFeePolicy2026 implements ShippingFeePolicy {

    private static final Money BASE_FEE       = Money.twd("60");
    private static final Money OUTLYING_EXTRA = Money.twd("100");
    private static final Money FREE_THRESHOLD = Money.twd("1000");

    /** 外島縣市。⚠️ 用縣市名比對是脆弱的，正式版該用郵遞區號區間。 */
    private static final java.util.Set<String> OUTLYING_POSTAL_PREFIXES =
            java.util.Set.of("880", "881", "882", "883", "884", "885",   // 澎湖
                             "890", "891", "892", "893", "894", "896",   // 金門
                             "209", "210", "211", "212");                // 連江

    @Override
    public Money feeFor(Address address, Money amountAfterDiscount) {
        if (amountAfterDiscount.isGreaterThanOrEqual(FREE_THRESHOLD)) {
            // ⚠️ 免運只免基本運費，外島加價仍然要收 —— 這是一條真實的規則，
            //    而它非常容易寫錯成「免運就全免」。
            return isOutlying(address) ? OUTLYING_EXTRA : Money.zero(BASE_FEE.currency());
        }
        return isOutlying(address) ? BASE_FEE.plus(OUTLYING_EXTRA) : BASE_FEE;
    }

    @Override
    public Money amountToFreeShipping(Address address, Money amountAfterDiscount) {
        if (amountAfterDiscount.isGreaterThanOrEqual(FREE_THRESHOLD)) return null;
        return FREE_THRESHOLD.minus(amountAfterDiscount);
    }

    private boolean isOutlying(Address address) {
        String postal = address.postalCode();
        return postal != null && postal.length() >= 3
                && OUTLYING_POSTAL_PREFIXES.contains(postal.substring(0, 3));
    }
}
```

⚠️ **注意 `feeFor` 裡那條註解。**
「免運只免基本運費」是一條真實但反直覺的規則。
如果它寫在 `createOrder()` 的第 340 行，
**沒有人會發現它被寫錯了** —— 因為外島訂單只佔 0.8%，
而測試資料裡通常沒有外島地址。

而寫成獨立的 policy 之後，它可以被這樣測：

```java
@ParameterizedTest
@CsvSource({
    // 郵遞區號, 折後金額, 期望運費, 說明
    "  100,   500,  60, 台北未達免運",
    "  100,  1000,   0, 台北達免運",
    "  100,  1500,   0, 台北超過免運",
    "  880,   500, 160, 澎湖未達免運（60 + 100）",
    "  880,  1000, 100, 澎湖達免運 → ★ 仍收外島加價",
    "  880,  9999, 100, 澎湖大額 → ★ 仍收外島加價",
    "  209,  1000, 100, 連江達免運",
    "  999,  1000,   0, 未知郵遞區號視為本島",
})
void 運費計算(String postal, String amount, String expectedFee, String description) {
    var policy = new ShippingFeePolicy2026();
    var address = Addresses.withPostalCode(postal);

    assertThat(policy.feeFor(address, Money.twd(amount)))
            .as(description)
            .isEqualTo(Money.twd(expectedFee));
}
```

**8 個案例，8 毫秒，零 mock。** 這就是「純函式放 Domain」的報酬。

⚠️ 最後一列（未知郵遞區號視為本島）是刻意的：
它記錄了一個**決定**。「未知的郵遞區號要怎麼辦」不寫測試的話，
半年後沒有人知道當初是有意還是漏了。

### 0.7.2 20 段程式碼的歸屬

用上面七個判準，把常見的程式碼歸位。**建議先自己判斷再看答案。**

| # | 程式碼 | 判準 | 歸屬 |
|---|---|---|---|
| 1 | `if (status != PAID) throw ...` | 2 | **Domain**（`Order`） |
| 2 | `orders.findById(id).orElseThrow()` | 1 | Application Service |
| 3 | `subtotal.times(new BigDecimal("0.05"))`（稅） | 1、2 | **Domain**（`TaxPolicy`） |
| 4 | `redis.opsForValue().get("token:" + t)` | 1 | 🔴 **Web 層 / Security**，不該在 Service |
| 5 | `if (customer.level() == VIP) price = price.times(0.95)` | 2 | **Domain**（`PricingPolicy`） |
| 6 | `UPDATE stock SET qty = qty - ? WHERE qty >= ?` | 1、6 | **基礎設施**（Repository），規則靠約束 |
| 7 | `if (coupon.usedCount() >= coupon.total()) throw` | 6 | 🔴 **陷阱**：看似 Domain，但在併發下無效 → 見 0.8 |
| 8 | `mailSender.send(...)` | 3 | commit 之後的事件監聽器 |
| 9 | `Instant.now()` | 1、4 | Application Service（注入 `Clock`） |
| 10 | `order.total().isNegative()` 檢查 | 6 | **Domain**（建構子的不變量） |
| 11 | `if (actor.isCustomer() && !order.belongsTo(actor)) → 404` | 2 | ⚠️ **兩者都有**：查詢條件（Service）+ `belongsTo`（Domain） |
| 12 | `ResponseEntity.created(location)` | — | Web 層 |
| 13 | `@Transactional(propagation = REQUIRES_NEW)` | 3 | Application Service |
| 14 | 判斷「這個狀態能不能轉到那個狀態」 | 2 | **Domain**（`OrderStatus`） |
| 15 | `auditLogRepository.save(...)` | 1 | Application Service |
| 16 | 把 `Order` 轉成 `OrderDetail` | — | Web 層的 mapper（03 章會討論邊界） |
| 17 | 「一天最多改 3 次地址」 | 2、6 | ⚠️ Application Service（要查歷史）+ 資料庫 UNIQUE |
| 18 | 「訂單 30 分鐘未付款自動取消」的判斷 | 2、4 | **Domain**（`isExpired(now)`），排程在 Service |
| 19 | `paymentGateway.charge(...)` 的重試邏輯 | 1 | 基礎設施（06 章的重試與斷路器（`@Retryable`）） |
| 20 | 100 元折扣分攤到 3 筆明細 | 2 | **Domain**（`Money.allocate()`） |

⚠️ **第 7 題是最重要的一題。** 它看起來完全符合「只看一個聚合的狀態」
（`Coupon` 自己的 `usedCount`），所以判準 2 說它該在 Domain。

**而它在 Domain 裡是錯的** —— 因為 0.3.2 事故 5。

**這不是判準失效，是判準不完整。** 補上判準 6 之後才對：

> **「這條規則在兩個執行緒同時執行時還成立嗎？」**
>
> `Coupon.canBeUsed()` 這個方法**可以**留在 Domain（它表達了規則），
> 但**它不能是唯一的守門人**。真正的守門在
> `UPDATE coupon SET used_count = used_count + 1 WHERE code = ? AND used_count < total_count`
> 這一句原子 SQL，以及 `CHECK (used_count <= total_count)` 這條約束。

**下一節把這件事講透。**

---
## 0.8 不變量：Service 層真正在守的東西 ★★

這一節是整個 05-service 最重要的一節。

### 0.8.1 什麼是不變量

> **不變量（invariant）= 這個系統在任何時刻都不可以出現的狀態。**

它與「驗證」的差別很關鍵：

| | 驗證（validation） | 不變量（invariant） |
|---|---|---|
| 檢查什麼 | **輸入**合不合法 | **系統狀態**合不合法 |
| 什麼時候檢查 | 請求進來時 | **永遠成立** |
| 誰負責 | Web 層（04-controller 2.x） | Domain + Service + 資料庫 |
| 失敗的意義 | 使用者送錯了 → 400/422 | 系統壞了 → 可能是 409，也可能是 500 |
| 例子 | `quantity` 必須是 1..99 | **庫存不可以是負數** |

⚠️ **兩者常常長得很像，但守的位置完全不同。**

```
「quantity 必須 >= 1」          → 驗證。@Min(1)，Web 層擋掉。
「訂單的明細數量總和 = 扣掉的庫存」 → 不變量。Web 層不可能檢查（它不知道庫存）。
```

### 0.8.2 shop-service 的不變量清單

**這份清單應該是一個專案的正式文件。** 它比 API 文件更重要 ——
API 可以改版，不變量被破壞就是資料錯了。

| # | 不變量 | 破壞的後果 |
|---|---|---|
| I1 | 庫存數量 `>= 0` | 超賣。倉庫沒貨，客戶已付款 |
| I2 | 優惠券使用次數 `<= 總數` | 超發折扣，直接虧錢 |
| I3 | 訂單總金額 `= 小計 - 折扣 + 運費`，且 `>= 0` | 對帳不平，可能出現負數收款 |
| I4 | 訂單總金額 `=` 所有明細 `lineTotal` 之和 `-` 折扣 `+` 運費 | 發票金額與訂單不符（稅務問題） |
| I5 | 訂單狀態轉移只能沿著狀態機 | `CANCELLED` 的訂單被出貨 |
| I6 | 已取消的訂單一定有 `cancellation`（原因、時間、取消者） | 稽核查不到誰取消的 |
| I7 | 已付款的訂單一定有至少一筆成功的 `payment` | 帳上有錢但找不到來源 |
| I8 | 退款總額 `<=` 付款總額 | **退款超過收款 → 直接資金損失** |
| I9 | 一個 `idempotencyKey` 最多對應一張訂單 | 重複下單、重複扣款 |
| I10 | 一張訂單的所有明細幣別相同 | 金額加總無意義 |
| I11 | 出貨數量 `<=` 訂購數量 | 倉庫多發貨 |

⚠️ **I8 是最貴的一條。** 「退款超過付款」在很多系統上是可行的 ——
因為退款流程通常是「客服輸入金額 → 送出」，
而「累計退款 + 這次退款 <= 付款總額」這個檢查
如果只寫在 Java 的 `if` 裡，兩個客服同時操作就會突破。

### 0.8.3 不變量可以守在四個位置 ★★

**這張表是本章的結論，值得記下來：**

| 位置 | 可靠度 | 併發下有效？ | 錯誤訊息品質 | 適用 |
|---|---|---|---|---|
| ① **Web 層驗證**（04-controller 2.x） | ⭐ | ❌ | ⭐⭐⭐⭐⭐ 最好（欄位級） | 只能擋「明顯的壞輸入」 |
| ② **Domain 物件** | ⭐⭐⭐ | ❌ **單一聚合內有效** | ⭐⭐⭐⭐ | 聚合內部的不變量 |
| ③ **原子 SQL / 鎖** | ⭐⭐⭐⭐ | ✅ | ⭐⭐⭐ | 跨聚合、有競爭的不變量 |
| ④ **資料庫約束** | ⭐⭐⭐⭐⭐ 最高 | ✅ | ⭐ 最差（`SQLIntegrityConstraintViolationException`） | 最後防線 |

**兩個關鍵觀察：**

> **① 可靠度與錯誤訊息品質「成反比」。**
> 所以正確做法**不是選一個**，而是**四層都放**：
> 上層給好訊息，下層保證正確。
>
> **② 只有 ③ 與 ④ 在併發下有效。**
> ①② 是「早期回饋」，不是「保證」。

**把 I1（庫存不為負）四層都做一遍：**

```java
// ── ① Web 層（04-controller 2.x）：擋掉明顯的壞輸入 ─────────────────────
public record CreateOrderRequest(
    @NotEmpty @Size(max = 50) @Valid List<Item> items,
    // ...
) {
    public record Item(
        @NotBlank String productId,
        @NotNull @Min(1) @Max(99) Integer quantity      // ★ 擋 0 與負數
    ) {}
}
// 效果：quantity = -5 直接 422，不會進到 Service。
// ⚠️ 但它完全不知道庫存有幾個 → 擋不住「買 10 個但只有 3 個」
```

```java
// ── ② Domain：表達規則，給好訊息 ────────────────────────────
package example.shop.stock.domain;

/**
 * 庫存。
 *
 * <p>⚠️⚠️ 這個類別存在的意義**不是**「守住庫存不為負」——
 * 那件事它做不到（0.3.2 事故 3）。
 *
 * <p>它存在的意義是：
 * <ol>
 *   <li>讓「庫存不足」這條規則<b>有一個可以被閱讀與測試的地方</b>。</li>
 *   <li>讓<b>試算</b>（購物車顯示「僅剩 2 件」）可以重用同一段判斷。</li>
 *   <li>產生<b>好的錯誤訊息</b>（含商品名、可用量、預計補貨日）。</li>
 * </ol>
 *
 * <p>★★ 真正的守門在 ③ 的原子 SQL 與 ④ 的 CHECK 約束。
 */
public class Stock {

    private final String productId;
    private int available;
    private int reserved;

    /** 試算：夠不夠。⚠️ 這個答案在下一毫秒可能就過期了。 */
    public boolean canReserve(int quantity) {
        return quantity > 0 && available >= quantity;
    }

    /**
     * 保留庫存。
     *
     * <p>⚠️ 這個方法只在「已經用悲觀鎖鎖住這一列」時才可以呼叫
     *    （02 章 2.11.3 的 {@code findByProductIdForUpdate}）。
     *    在沒有鎖的情況下呼叫它，它會通過但資料會錯。
     *
     * <p>👉 shop-service 的下單路徑<b>不走這個方法</b>，走 ③ 的原子 SQL。
     *    這個方法只給「盤點調整」這種低頻、需要複雜判斷的路徑用。
     */
    public void reserve(int quantity) {
        if (!canReserve(quantity)) {
            throw new InsufficientStockException(productId, quantity, available);
        }
        available -= quantity;
        reserved += quantity;
        // ★ 不變量斷言：即使上面的判斷寫錯，這裡也會抓到
        assertInvariant();
    }

    public void release(int quantity) {
        if (quantity <= 0) throw new IllegalArgumentException("quantity 必須為正");
        available += quantity;
        reserved = Math.max(0, reserved - quantity);
        assertInvariant();
    }

    /**
     * ★★ 不變量斷言。
     *
     * <p>用 {@code IllegalStateException}（→ 500）而不是業務例外，
     * 因為走到這裡代表<b>程式有 bug</b>，不是使用者做錯事。
     * 告訴使用者「請減少數量」是誤導 —— 他做什麼都不會改變這個結果。
     */
    private void assertInvariant() {
        if (available < 0 || reserved < 0) {
            throw new IllegalStateException(
                    "庫存不變量被破壞：product=%s available=%d reserved=%d"
                            .formatted(productId, available, reserved));
        }
    }
}
```

```java
// ── ③ 原子 SQL：真正的守門（併發下有效）────────────────────
package example.shop.stock.infrastructure;

@Repository
public class JdbcStockRepository implements StockPort {

    private final JdbcTemplate jdbc;
    private final Clock clock;              // ★ 判準 4 —— 連基礎設施也用同一個時間源

    public JdbcStockRepository(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /**
     * ★★ 原子的「檢查 + 扣減」。
     *
     * <p>關鍵在 {@code AND available >= ?} 這個條件<b>與 UPDATE 在同一句</b>——
     * 資料庫會對這一列加行鎖，於是「檢查」與「扣減」之間沒有縫。
     *
     * <p>⚠️ 對照 0.3.2 事故 3 的錯誤寫法：
     * <pre>
     * // 🔴 SELECT 與 UPDATE 之間有縫，三個執行緒都會通過檢查
     * Stock s = repo.findByProductId(id);
     * if (s.getQuantity() &gt;= qty) { repo.update(id, s.getQuantity() - qty); }
     * </pre>
     *
     * @return true = 扣減成功；false = 庫存不足（<b>不是「商品不存在」</b>）
     */
    @Override
    public boolean tryReserve(String productId, int quantity) {
        int updated = jdbc.update("""
                UPDATE stock
                   SET available = available - ?,
                       reserved  = reserved  + ?,
                       updated_at = ?
                 WHERE product_id = ?
                   AND available >= ?
                """, quantity, quantity, Timestamp.from(clock.instant()), productId, quantity);
        return updated == 1;
    }

    /**
     * ⚠️ {@code tryReserve} 回傳 false 時，呼叫端需要知道
     * 「是庫存不足還是商品不存在」才能給出正確的錯誤碼
     * （{@code INSUFFICIENT_STOCK} 409 vs {@code PRODUCT_NOT_FOUND} 422）。
     *
     * <p>★ 這一次查詢<b>不需要精確</b>（它只是用來產生訊息），
     *    所以不用加鎖 —— 這是「錯誤路徑可以慢一點、可以不精確」的一個好例子。
     */
    @Override
    public Optional<StockSnapshot> snapshot(String productId) {
        return jdbc.query("""
                SELECT product_id, available, reserved, restock_estimated_at
                  FROM stock WHERE product_id = ?
                """, STOCK_ROW_MAPPER, productId).stream().findFirst();
    }

    /**
     * ★ {@code RowMapper} 放在 Repository 而不是 {@link StockSnapshot} 上。
     *
     * <p>⚠️ 理由：{@code StockSnapshot} 在 {@code application.port} 套件，
     * 而 {@code RowMapper} 是 {@code org.springframework.jdbc} 的型別 ——
     * 讓埠依賴 JDBC 就違反了 01 章 1.7.2 的「介面放在使用它的那一側」。
     */
    private static final RowMapper<StockSnapshot> STOCK_ROW_MAPPER = (rs, rowNum) ->
            new StockSnapshot(
                    rs.getString("product_id"),
                    rs.getInt("available"),
                    rs.getInt("reserved"),
                    Optional.ofNullable(rs.getDate("restock_estimated_at"))
                            .map(java.sql.Date::toLocalDate).orElse(null));
}
```

```sql
-- ── ④ 資料庫約束：最後防線 ────────────────────────────────
CREATE TABLE stock (
    product_id           VARCHAR(32)  NOT NULL PRIMARY KEY,
    available            INT          NOT NULL,
    reserved             INT          NOT NULL,
    restock_estimated_at DATE         NULL,
    updated_at           DATETIME(6)  NOT NULL,

    -- ★★ MySQL 8.0.16+ 真的會執行 CHECK（8.0.16 之前是「解析但忽略」！）
    CONSTRAINT chk_stock_available_non_negative CHECK (available >= 0),
    CONSTRAINT chk_stock_reserved_non_negative  CHECK (reserved  >= 0)
);
```

⚠️ **「MySQL 8.0.16 之前 CHECK 是被忽略的」是一個真實的坑。**
在那些版本上，`CHECK` 寫了跟沒寫一樣，而且**不會有任何警告**。
所以：

```sql
-- 8.0.16 之前的替代方案：用 UNSIGNED
available INT UNSIGNED NOT NULL,     -- 扣成負數會直接報錯
```

> ⚠️ 但 `UNSIGNED` 有一個陷阱：MySQL 在非嚴格模式下會把
> 負數**截斷成 0** 而不是報錯。所以還要確認
> `sql_mode` 含 `STRICT_TRANS_TABLES`（07-mysql 第 01 章）。
> **「約束存在」與「約束生效」是兩件事，要實測。**

**四層合起來的行為：**

| 情境 | 誰擋下 | 使用者看到 |
|---|---|---|
| `quantity = -5` | ① Web 驗證 | 422 + `errors[0].field = "items[0].quantity"` |
| 買 10 個，庫存 3 個（無競爭） | ③ 原子 SQL 回 false → 查 snapshot → 拋例外 | 409 `INSUFFICIENT_STOCK` + `available: 3` + 預計補貨日 |
| 兩人同時買最後 1 個 | ③ 原子 SQL（一個成功一個回 false） | 慢的那個看到 409 |
| 有人寫了 bug 繞過 ③ | ④ 資料庫約束 | 500（🔴 訊息很醜，但**資料是對的**） |

> 📌 **這就是「四層都放」的意義：
> 上面三層決定「使用者體驗好不好」，
> 最下面那一層決定「資料對不對」。
> 而它們不可以互相取代。**

### 0.8.4 為什麼「應用層檢查」永遠不夠

有些人會說：「我在 Service 裡加 `synchronized` 就好了。」

**不行，四個理由：**

| 想法 | 為什麼不行 |
|---|---|
| `synchronized` | 只在**單一 JVM** 內有效。生產環境有 3 個 pod → 完全無效 |
| `ReentrantLock` | 同上 |
| Redis 分散式鎖 | ⚠️ 有效**但有前提**：鎖過期時間 vs 交易時間、Redis 掛掉時的行為、鎖續期。而且它是「額外的一個可能失敗的元件」 |
| 「機率很低啦」 | 促銷第一分鐘的請求密度是平常的 500 倍。**低機率事件在高流量下是必然事件** |

**而資料庫的行鎖天生就是分散式的** ——
它在資料所在的地方，所有 pod 都經過它。

> 📌 **一句話總結**：
> **不變量要守在「資料所在的地方」，不是「程式所在的地方」。**

⚠️ **一個重要的例外**：如果不變量涉及的資料**不在資料庫**
（例如「同一個 actor 同時最多 5 個 SSE 連線」——
04-controller 5.11.6 的 `SseEmitterRegistry`），
那它就**只能**在應用層守，而且**只在單一實例內正確**。
那時候你要做的是**明確承認這個限制**，
而不是假裝它是全域的。

### 0.8.5 不變量的守門測試

每一條不變量都應該有一個**會紅燈的守門人**（04-controller 07 章的核心思想）。

```java
package example.shop.stock;

/**
 * I1（庫存 >= 0）的守門測試。
 *
 * <p>★★ 它<b>必須</b>用真的資料庫（Testcontainers）——
 * 因為要測的正是「資料庫的行鎖與約束」，
 * 而記憶體假實作沒有那些東西。
 *
 * <p>⚠️ 這是 05-service 唯一必須碰真 DB 的一類測試（02 章 2.2.5）。
 */
@SpringBootTest
@Testcontainers
class StockInvariantTest extends MySqlIntegrationTestBase {

    @Autowired StockPort stock;
    @Autowired JdbcTemplate jdbc;
    /** ★ 測試專用的補資料方法，定義在 {@code JdbcStockPortTestSupport} 上而不是埠上。 */
    @Autowired StockTestSupport stockFixtures;

    @Test
    void 二十個執行緒同時買最後一個_只有一個成功() throws Exception {
        stockFixtures.upsert("P-1", 1);               // 只有 1 個

        int threads = 20;
        var barrier = new java.util.concurrent.CyclicBarrier(threads);
        var successes = new java.util.concurrent.atomic.AtomicInteger();
        var pool = java.util.concurrent.Executors.newFixedThreadPool(threads);

        var futures = java.util.stream.IntStream.range(0, threads)
                .mapToObj(i -> pool.submit(() -> {
                    barrier.await();                  // ★ 讓 20 個執行緒同時起跑
                    if (stock.tryReserve("P-1", 1)) successes.incrementAndGet();
                    return null;
                }))
                .toList();
        for (var f : futures) f.get();
        pool.shutdown();

        // ★★ 這一行是整個測試的重點
        assertThat(successes.get()).isEqualTo(1);
        assertThat(stock.snapshot("P-1").orElseThrow().available()).isZero();
    }

    @Test
    void 直接用SQL把庫存扣成負數會被約束擋下() {
        stockFixtures.upsert("P-2", 1);

        // ★ 繞過 tryReserve 的 WHERE 條件，模擬「有人寫了 bug」
        assertThatThrownBy(() -> jdbc.update(
                        "UPDATE stock SET available = available - 5 WHERE product_id = ?", "P-2"))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    }
}
```

⚠️ **`CyclicBarrier` 是這類測試的關鍵。**
如果只是 `pool.submit()` 20 次而不設 barrier，
執行緒會依序啟動，第一個可能已經跑完第二個才開始 ——
**於是這個測試會「通過」，即使程式碼有 race condition**。

> 📌 **併發測試的三個必要條件**：
> ① barrier 讓執行緒真的同時起跑；
> ② 執行緒數 >> CPU 核心數（增加交錯機率）；
> ③ **重複跑多次**（`@RepeatedTest(10)`）—— race condition 是機率性的。

而「第二個測試」（直接用 SQL 扣成負數）的意義是：

> **它證明第 ④ 層真的生效了。**
> 這個測試就是防止「以為寫了 `CHECK` 就有用，
> 但實際上 MySQL 版本太舊而被忽略」的那個守門人。

---
## 0.9 完整重構：把 04-controller 站的 stub 變成真的

現在把前面所有觀念套到一個完整的例子上。
**目標**：把 04-controller 站的 `OrderService.create()`（stub）實作成三層。

### 0.9.1 04-controller 站留下的契約

04-controller 站的 Controller 是這樣呼叫它的（00 章 0.10.2）：

```java
var order = orderService.create(mapper.toCommand(request, user.actor(), idempotencyKey));
var body  = mapper.toCreateResponse(order);
```

而 `mapper.toCreateResponse(order)` 用到了這些（04-controller 0.10.3）：

```java
order.getId()、order.getOrderNumber()、order.getStatus()、
order.getStatus().label()、order.allowedActions()、
order.getCurrency()、order.totalItemQuantity()、
order.getAppliedCoupon()、order.getCreatedAt()、order.getExpiresAt()
```

⚠️ **注意 mapper 用的是 `getXxx()` 而 0.5 的充血模型用的是 `xxx()`。**
這是一個真實的接縫問題，而它有三個選項：

| 選項 | 代價 |
|---|---|
| A. 改 mapper 用 `xxx()` | 改 04-controller 站的 mapper 與部分測試（約 15 處） |
| B. Domain 上同時提供 `getXxx()` 與 `xxx()` | 兩份 accessor，永遠有人用錯 |
| C. Domain 用 `getXxx()` | ⚠️ 與 `record` 風格的值物件不一致 |

**shop-service 選 A**，理由：

> `getXxx()` 這個命名慣例來自 JavaBeans 規範，
> 而它的存在理由（框架用反射找 getter）**在這一層不成立** ——
> Domain 物件不被序列化、不被 JPA 直接映射（0.9.2 會說明怎麼做到）。
> 而 04-controller 站的值物件（`Money`、`Actor`、`CreateOrderCommand`）**已經是 `record` 風格**了，
> 讓聚合跟它們一致比較好。

👉 **這一站會回頭修改 04-controller 站的 `OrderWebMapper`**，
改動清單記在 0.14，跟 04-controller 站的做法一致（每一處都標理由）。

### 0.9.2 `Order` 聚合

```java
package example.shop.order.domain;

import example.shop.common.money.Money;
import example.shop.order.domain.exception.*;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Currency;
import java.util.List;
import java.util.Objects;

/**
 * 訂單聚合根。
 *
 * <h2>★★ 這個類別的四條設計規則</h2>
 * <ol>
 *   <li><b>沒有 public setter。</b>狀態只能透過「有名字的操作」改變
 *       （{@link #cancel}、{@link #markPaid}、{@link #ship}）。</li>
 *   <li><b>沒有 Spring 依賴、沒有 JPA 註解、沒有 {@code Instant.now()}。</b>
 *       它是純 Java，可以 {@code new} 出來測（0.11.2 的 ArchUnit 規則會守）。</li>
 *   <li><b>每一個改變狀態的方法結束時，不變量都成立</b>
 *       （{@link #assertInvariants()}）。</li>
 *   <li><b>它不做 I/O，需要的東西一律當參數收。</b>
 *       商品資訊、優惠券、運費方案、「現在幾點」都是參數。</li>
 * </ol>
 *
 * <h2>⚠️ 這個類別「不是」JPA Entity</h2>
 * <p>08-jpa-mybatis 會討論兩種做法：
 * <ul>
 *   <li><b>做法 A</b>：讓它<b>就是</b> Entity（加 {@code @Entity}，
 *       用 package-private 無參建構子 + 欄位存取，不開 setter）。
 *       ⚠️ 代價是 Domain 依賴 {@code jakarta.persistence}。</li>
 *   <li><b>做法 B</b>：另有一個 {@code OrderRecord}（貧血、給 JPA/JDBC 用），
 *       Repository 實作負責雙向轉換。
 *       ⚠️ 代價是多一層 mapper，而且「忘記映射新欄位」是靜默的 bug。</li>
 * </ul>
 * <p>👉 <b>本站不做這個選擇</b>（Repository 是記憶體假實作，兩種都不需要），
 *    但把它明確記下來，因為 06/08 站一定會碰到。
 *    shop-service 最終選 <b>做法 A</b>，理由與代價在 08 章。
 */
public class Order {

    /** ★ 付款期限。放在這裡而不是設定檔，因為它是<b>業務規則</b>不是組態。 */
    private static final Duration PAYMENT_WINDOW = Duration.ofMinutes(30);

    /** ★ 客戶自行取消的時限（0.5.1 的規則 7）。 */
    private static final Duration SELF_CANCEL_WINDOW = Duration.ofDays(7);

    /** ★ 一張訂單最多的明細筆數。⚠️ 與 02 章 {@code @Size(max = 50)} 是同一個數字。 */
    public static final int MAX_LINES = 50;

    // ── 身分（不可變）──────────────────────────────────────
    private final String id;
    private final OrderNumber orderNumber;
    private final String customerId;
    private final Currency currency;
    private final Instant createdAt;
    private final String idempotencyKey;

    // ── 內容 ─────────────────────────────────────────────
    private final List<OrderLine> lines;
    private final String shippingAddressId;
    private final ShippingSnapshot shippingSnapshot;   // 下單時的地址快照
    private AppliedCoupon appliedCoupon;
    private final Money shippingFee;
    // ⚠️⚠️ 這兩個欄位在 03 章 3.10.3 ⑧ 會【拿掉 final】——
    //    PATCH 要能改備註與發票（03 章 3.6.5），而 final 讓那些方法編譯不過。
    //    ★ 現在是 final 是對的：本章沒有任何操作會改它們（「能 final 就 final」）。
    private final InvoiceSpec invoice;
    private final String customerNote;
    // ⚠️ 03 章 3.10.3 ⑧ 還會新增三個欄位：internalNote、invoiceIssuedAt、
    //    invoiceRequestSubmitted（以及常數 MAX_NOTE_LENGTH）。

    // ── 狀態 ─────────────────────────────────────────────
    // ⚠️ 02 章 2.14.1 ④ 會在這裡補一個 version 欄位（樂觀鎖 / ETag）——
    //    並誠實討論「version 是持久化細節洩漏到 Domain」的三個選項與取捨。
    private OrderStatus status;
    private Instant expiresAt;
    private Instant deliveredAt;                       // ★ 退貨期限的起算點
    private Cancellation cancellation;
    private final List<Payment> payments = new ArrayList<>();
    private final List<Shipment> shipments = new ArrayList<>();

    /**
     * ★★ 唯一的建構子是 private —— 外面只能透過 {@link #place} 建立。
     *
     * <p>這保證了「一個 Order 物件存在」就代表「它通過了所有不變量檢查」。
     */
    private Order(String id, OrderNumber orderNumber, String customerId, Currency currency,
                  Instant createdAt, String idempotencyKey, List<OrderLine> lines,
                  String shippingAddressId, ShippingSnapshot shippingSnapshot,
                  AppliedCoupon appliedCoupon, Money shippingFee,
                  InvoiceSpec invoice, String customerNote) {
        this.id = Objects.requireNonNull(id, "id");
        this.orderNumber = Objects.requireNonNull(orderNumber, "orderNumber");
        this.customerId = Objects.requireNonNull(customerId, "customerId");
        this.currency = Objects.requireNonNull(currency, "currency");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.idempotencyKey = idempotencyKey;
        this.lines = List.copyOf(lines);
        this.shippingAddressId = Objects.requireNonNull(shippingAddressId, "shippingAddressId");
        this.shippingSnapshot = shippingSnapshot;
        this.appliedCoupon = appliedCoupon;
        this.shippingFee = Objects.requireNonNull(shippingFee, "shippingFee");
        this.invoice = invoice;
        this.customerNote = customerNote;
        this.status = OrderStatus.PENDING_PAYMENT;
        this.expiresAt = createdAt.plus(PAYMENT_WINDOW);
        assertInvariants();
    }

    /**
     * ★★ 下單。這是建立 {@code Order} 的唯一入口。
     *
     * <p><b>它需要的每一樣東西都是參數</b> —— 沒有任何一項是它自己去查的：
     *
     * <table>
     *   <tr><th>參數</th><th>誰算出來的</th><th>為什麼不由 Order 自己查</th></tr>
     *   <tr><td>{@code id}、{@code orderNumber}</td><td>Application Service</td>
     *       <td>它們來自 ID 產生器（有隨機性 / 需要序號表）→ 是 I/O</td></tr>
     *   <tr><td>{@code pricedLines}</td><td>Application Service 查商品 +
     *       {@link PricingPolicy} 算價</td>
     *       <td>查商品是 I/O。⚠️ <b>但算價不是</b> —— 算價的規則在 Domain</td></tr>
     *   <tr><td>{@code coupon}</td><td>Application Service 查券</td>
     *       <td>查券是 I/O；<b>但「能不能用」由 {@code Coupon} 自己判斷</b></td></tr>
     *   <tr><td>{@code shippingFeePolicy}</td><td>注入（它是無狀態的純函式物件）</td>
     *       <td>它是策略，不是資料</td></tr>
     *   <tr><td>{@code now}</td><td>Application Service 的 {@code Clock}</td>
     *       <td>判準 4</td></tr>
     * </table>
     *
     * @throws OrderEmptyException             明細為空
     * @throws OrderItemLimitExceededException 明細超過 {@value #MAX_LINES} 筆
     * @throws MixedCurrencyException          明細幣別不一致（I10）
     * @throws CouponNotApplicableException    優惠券不適用（由 {@code Coupon} 拋）
     */
    public static Order place(String id,
                              OrderNumber orderNumber,
                              String customerId,
                              String idempotencyKey,
                              List<PricedLine> pricedLines,
                              ShippingAddress address,
                              Coupon coupon,                    // 可為 null
                              ShippingFeePolicy shippingFeePolicy,
                              InvoiceSpec invoice,              // 可為 null
                              String customerNote,              // 可為 null
                              Instant now) {

        // ── 不變量：明細 ────────────────────────────────
        if (pricedLines == null || pricedLines.isEmpty()) {
            throw new OrderEmptyException(customerId);
        }
        if (pricedLines.size() > MAX_LINES) {
            throw new OrderItemLimitExceededException(pricedLines.size(), MAX_LINES);
        }

        // ── 不變量 I10：幣別一致 ────────────────────────
        Currency currency = pricedLines.get(0).unitPrice().currency();
        boolean mixed = pricedLines.stream()
                .anyMatch(l -> !l.unitPrice().currency().equals(currency));
        if (mixed) {
            throw new MixedCurrencyException(
                    pricedLines.stream()
                               .map(l -> l.unitPrice().currency().getCurrencyCode())
                               .distinct().toList());
        }

        // ── 建明細並算小計 ─────────────────────────────
        List<OrderLine> lines = pricedLines.stream().map(OrderLine::from).toList();
        Money subtotal = lines.stream()
                .map(OrderLine::lineTotal)
                .reduce(Money.zero(currency), Money::plus);

        // ── 折扣：讓 Coupon 自己判斷 ────────────────────
        AppliedCoupon applied = null;
        Money discount = Money.zero(currency);
        if (coupon != null) {
            // ★★ 這一行裡的所有規則（有效期、最低消費、適用商品）都在 Coupon 裡。
            //    不適用時它自己拋 CouponXxxException —— 所以這裡沒有 if。
            discount = coupon.discountFor(subtotal, lines, now);
            applied = new AppliedCoupon(coupon.code(), coupon.name(), discount);
        }

        // ── 運費 ─────────────────────────────────────
        Money afterDiscount = subtotal.minus(discount);
        Money shippingFee = shippingFeePolicy.feeFor(address, afterDiscount);

        return new Order(id, orderNumber, customerId, currency, now, idempotencyKey,
                         lines, address.id(), ShippingSnapshot.of(address),
                         applied, shippingFee, invoice, customerNote);
    }

    // ── 計算（純函式，可以被 mapper 與 domain 內部重複呼叫）────────

    public Money subtotal() {
        return lines.stream().map(OrderLine::lineTotal)
                    .reduce(Money.zero(currency), Money::plus);
    }

    public Money discount() {
        return appliedCoupon == null ? Money.zero(currency) : appliedCoupon.discount();
    }

    /** ★ 不變量 I3、I4 就是這個方法的定義。 */
    public Money total() {
        return subtotal().minus(discount()).plus(shippingFee);
    }

    public int totalItemQuantity() {
        return lines.stream().mapToInt(OrderLine::quantity).sum();
    }

    public Money paidAmount() {
        return payments.stream()
                .filter(Payment::isSucceeded)
                .map(Payment::amount)
                .reduce(Money.zero(currency), Money::plus);
    }

    public Money refundedAmount() {
        return payments.stream()
                .flatMap(p -> p.refunds().stream())
                .map(Refund::amount)
                .reduce(Money.zero(currency), Money::plus);
    }

    // ── 狀態查詢 ────────────────────────────────────────

    public boolean isExpired(Instant now) {
        return status == OrderStatus.PENDING_PAYMENT
                && expiresAt != null && now.isAfter(expiresAt);
    }

    public boolean belongsTo(Actor actor) {
        return actor.isCustomer() && customerId.equals(actor.id());
    }

    /**
     * ★ 客戶端可以做的操作（04-controller {@code CreateOrderResponse.allowedActions}）。
     *
     * <p>⚠️ 它<b>刻意</b>與 {@link #cancel} 等方法的守衛條件用同一個來源
     * （{@link OrderStatus}），否則會出現
     * 「按鈕顯示得出來但按下去 409」的經典 bug。
     * 0.9.5 有一個守門測試在檢查這件事。
     */
    public List<OrderAction> allowedActions(Actor actor, Instant now) {
        var actions = new ArrayList<OrderAction>();
        if (status == OrderStatus.PENDING_PAYMENT && !isExpired(now)) {
            actions.add(OrderAction.PAY);
        }
        if (canBeCancelledBy(actor, now)) {
            actions.add(OrderAction.CANCEL);
        }
        if (status.isEditable()) {
            actions.add(OrderAction.CHANGE_ADDRESS);
        }
        if (status == OrderStatus.DELIVERED) {
            actions.add(OrderAction.REQUEST_RETURN);
        }
        if (actor.isInternal() && status == OrderStatus.PAID) {
            actions.add(OrderAction.SHIP);
        }
        return List.copyOf(actions);
    }

    /** ★ {@link #allowedActions} 與 {@link #cancel} 共用的判斷 —— 只有一份。 */
    public boolean canBeCancelledBy(Actor actor, Instant now) {
        if (!status.isCancellable()) return false;
        if (actor.isCustomer()) {
            return belongsTo(actor)
                    && !createdAt.isBefore(now.minus(SELF_CANCEL_WINDOW));
        }
        // ★ isPrivileged() = isInternal() || SYSTEM —— 定義見 0.12 ⑫
        return actor.isPrivileged();
    }

    // ── 狀態轉移 ────────────────────────────────────────

    /**
     * 取消訂單。
     *
     * @param now 現在的時間（判準 4）
     * @return 取消的<b>後果</b>：需不需要退款、要還多少庫存
     * @throws OrderNotCancellableException     狀態不允許（I5）
     * @throws SelfCancelWindowExpiredException 客戶超過 7 天自行取消
     * @throws CancelNoteRequiredException      客服未填原因
     */
    public CancellationResult cancel(Actor actor, CancelReason reason,
                                     String note, Instant now) {
        if (!status.isCancellable()) {
            throw new OrderNotCancellableException(id, status);
        }
        if (actor.isCustomer()) {
            if (!belongsTo(actor)) {
                // ⚠️ 理論上 Application Service 的查詢條件已經擋掉了，
                //    但 Domain 仍然自己檢查一次 —— 因為第二個入口可能忘記。
                throw new OrderNotCancellableException(id, status);
            }
            if (createdAt.isBefore(now.minus(SELF_CANCEL_WINDOW))) {
                throw new SelfCancelWindowExpiredException(id, createdAt, SELF_CANCEL_WINDOW);
            }
        }
        if (actor.isSupport() && (note == null || note.isBlank())) {
            throw new CancelNoteRequiredException(id);
        }

        // ★★ 在改狀態「之前」把後果算出來（0.5.1 那個 bug 的正解）
        boolean refundRequired = status.isPaid() && paidAmount().isPositive();
        Money refundAmount = refundRequired
                ? paidAmount().minus(refundedAmount())
                : Money.zero(currency);
        List<StockRelease> releases = lines.stream()
                .map(l -> new StockRelease(l.productId(), l.quantity()))
                .toList();

        transitionTo(OrderStatus.CANCELLED);           // ★ 不變量 I5 在這裡守
        this.cancellation = new Cancellation(actor, reason, note, now);
        this.expiresAt = null;
        assertInvariants();

        return new CancellationResult(id, refundRequired, refundAmount, releases);
    }

    /**
     * 標記為已付款（金流回呼觸發）。
     *
     * <p>⚠️ 它是<b>冪等</b>的：同一筆付款重複回呼時不會重複加金額。
     * 金流商重送回呼是常態（06 章 6.8），這個保證必須在 Domain 裡。
     *
     * @throws OrderExpiredException      訂單已逾期（付款期限已過）
     * @throws OrderAlreadyPaidException  已經付款且金額不同（真的異常）
     * @throws PaymentAmountMismatchException 付款金額與訂單金額不符
     */
    public PaymentResult markPaid(String paymentId, Money amount,
                                  PaymentMethod method, Instant paidAt, Instant now) {
        // ★ 冪等：同一個 paymentId 已經記錄過 → 直接回「已處理」
        var existing = payments.stream()
                .filter(p -> p.id().equals(paymentId))
                .findFirst();
        if (existing.isPresent()) {
            return PaymentResult.alreadyProcessed(existing.get());
        }

        if (status == OrderStatus.CANCELLED) {
            // ⚠️ 這是一個真實而且很痛的情境：訂單已被取消，但金流回呼才到。
            //    ★ 不可以直接拋例外了事 —— 錢已經收了。
            //    正確做法是「記錄一筆需要退款的付款」，讓後續流程退回去。
            payments.add(Payment.orphaned(paymentId, amount, method, paidAt));
            assertInvariants();
            return PaymentResult.needsRefund(payments.get(payments.size() - 1));
        }
        if (status != OrderStatus.PENDING_PAYMENT) {
            throw new OrderAlreadyPaidException(id, status);
        }
        if (isExpired(now)) {
            // ⚠️ 同上：逾期但錢收了 → 也要退
            payments.add(Payment.orphaned(paymentId, amount, method, paidAt));
            assertInvariants();
            return PaymentResult.needsRefund(payments.get(payments.size() - 1));
        }
        if (!amount.equals(total())) {
            throw new PaymentAmountMismatchException(id, total(), amount);
        }

        payments.add(Payment.succeeded(paymentId, amount, method, paidAt));
        transitionTo(OrderStatus.PAID);
        this.expiresAt = null;
        assertInvariants();
        return PaymentResult.paid(payments.get(payments.size() - 1));
    }

    /**
     * 建立一筆出貨。
     *
     * @throws OrderNotShippableException      狀態不允許出貨
     * @throws ShipmentQuantityExceededException 出貨數量超過訂購數量（I11）
     */
    public Shipment ship(List<ShipmentLine> shipLines, String trackingNumber,
                         Carrier carrier, Instant now) {
        if (!status.isShippable()) {
            throw new OrderNotShippableException(id, status);
        }
        // ── 不變量 I11 ──────────────────────────────
        for (ShipmentLine sl : shipLines) {
            int ordered = lines.stream()
                    .filter(l -> l.productId().equals(sl.productId()))
                    .mapToInt(OrderLine::quantity).sum();
            int alreadyShipped = shipments.stream()
                    .flatMap(s -> s.lines().stream())
                    .filter(l -> l.productId().equals(sl.productId()))
                    .mapToInt(ShipmentLine::quantity).sum();
            if (alreadyShipped + sl.quantity() > ordered) {
                throw new ShipmentQuantityExceededException(
                        id, sl.productId(), ordered, alreadyShipped, sl.quantity());
            }
        }

        var shipment = new Shipment(shipLines, trackingNumber, carrier, now);
        shipments.add(shipment);

        // ★ 全部出完 → SHIPPED；否則 → PARTIALLY_SHIPPED
        OrderStatus next = isFullyShipped() ? OrderStatus.SHIPPED
                                            : OrderStatus.PARTIALLY_SHIPPED;
        // ⚠️⚠️ 這個 if 不可以省。
        //    第二次「部分出貨」時 status 與 next 都是 PARTIALLY_SHIPPED，
        //    而狀態機裡沒有 PARTIALLY_SHIPPED → PARTIALLY_SHIPPED 這條邊
        //    （終態以外的自我轉移一律不允許 —— 見 0.9.3 的 TRANSITIONS）。
        //    少了它，「一張訂單分三批出貨」的第二批就會 500。
        if (next != status) {
            transitionTo(next);
        }
        assertInvariants();
        return shipment;
    }

    /**
     * 送達。
     *
     * <p>⚠️ 它由物流商的 webhook 觸發，而 webhook <b>會重送</b>——
     * 所以它必須<b>冪等</b>：已經是 {@code DELIVERED} 就直接回，不拋例外。
     *
     * <p>★ {@code deliveredAt} 是退貨期限的起算點（0.16 練習 2 的 R4），
     * 所以重送時<b>不可以</b>更新它 —— 否則每次重送都把退貨期限往後延。
     *
     * @throws OrderNotDeliverableException 狀態不是 {@code SHIPPED}
     */
    public void markDelivered(Instant deliveredAt) {
        if (status == OrderStatus.DELIVERED) return;          // ★ 冪等
        if (status != OrderStatus.SHIPPED) {
            throw new OrderNotDeliverableException(id, status);
        }
        transitionTo(OrderStatus.DELIVERED);
        this.deliveredAt = deliveredAt;
        assertInvariants();
    }

    /** ★ 退貨期限的起算點。尚未送達時為 {@code null}。 */
    public Instant deliveredAt() { return deliveredAt; }

    /**
     * ★★ <b>唯一</b>改變 {@code status} 的地方 —— 不變量 I5 的執行點。
     *
     * <p>⚠️ 在加入這個方法之前，{@link OrderStatus#canTransitionTo} 只是
     * 「一份寫下來的狀態機」，<b>沒有任何程式碼在讀它</b> ——
     * 於是 {@code cancel()} 的守衛與狀態機的定義可能悄悄分岔。
     *
     * <p>👉 它與各方法的守衛<b>不是重複</b>，而是兩層不同的東西：
     * <table>
     *   <tr><th>層</th><th>回答什麼</th><th>失敗時</th></tr>
     *   <tr><td>方法的守衛（{@code isCancellable()} 等）</td>
     *       <td>「這個<b>操作</b>現在合法嗎」（含角色、時限）</td>
     *       <td>業務例外（409 / 422）</td></tr>
     *   <tr><td><b>{@code transitionTo}</b></td>
     *       <td>「這個<b>狀態轉移</b>合法嗎」</td>
     *       <td>{@code IllegalStateException}（500）—— 走到這裡代表<b>守衛寫錯了</b></td></tr>
     * </table>
     */
    private void transitionTo(OrderStatus target) {
        if (!status.canTransitionTo(target)) {
            throw new IllegalStateException(
                    "非法的狀態轉移：order=%s %s → %s（允許：%s）"
                            .formatted(id, status, target, status.nextStates()));
        }
        this.status = target;
    }

    private boolean isFullyShipped() {
        return lines.stream().allMatch(l -> {
            int shipped = shipments.stream().flatMap(s -> s.lines().stream())
                    .filter(sl -> sl.productId().equals(l.productId()))
                    .mapToInt(ShipmentLine::quantity).sum();
            return shipped >= l.quantity();
        });
    }

    /**
     * ★★ 聚合的不變量斷言。
     *
     * <p><b>每一個改變狀態的方法結束時都呼叫它。</b>
     *
     * <p>⚠️ 用 {@link IllegalStateException}（→ 500）而不是業務例外：
     * 走到這裡代表<b>程式有 bug</b>。
     * 告訴使用者「請修改請求」是誤導（0.8.3 的同一個理由）。
     *
     * <p>⚠️ 但它<b>不是</b>「防禦性程式設計」的藉口 ——
     * 它只斷言<b>不變量</b>（不可能為真的狀態），
     * 不斷言「參數不為 null」這種前置條件。
     */
    private void assertInvariants() {
        // I3：總金額不可為負
        if (total().isNegative()) {
            throw new IllegalStateException(
                    "訂單總金額為負：order=%s subtotal=%s discount=%s fee=%s"
                            .formatted(id, subtotal(), discount(), shippingFee));
        }
        // I6：已取消一定有取消資訊
        if (status == OrderStatus.CANCELLED && cancellation == null) {
            throw new IllegalStateException("已取消的訂單缺少取消資訊：order=" + id);
        }
        // I7：已付款一定有成功的付款
        if (status.isPaid() && payments.stream().noneMatch(Payment::isSucceeded)) {
            throw new IllegalStateException("已付款的訂單沒有付款紀錄：order=" + id);
        }
        // I8：退款不可超過付款
        if (refundedAmount().compareTo(paidAmount()) > 0) {
            throw new IllegalStateException(
                    "退款超過付款：order=%s paid=%s refunded=%s"
                            .formatted(id, paidAmount(), refundedAmount()));
        }
        // I10：幣別一致
        boolean mixed = lines.stream().anyMatch(l -> !l.unitPrice().currency().equals(currency));
        if (mixed) {
            throw new IllegalStateException("訂單明細幣別不一致：order=" + id);
        }
    }

    // ── accessor（無 setter）────────────────────────────
    public String id()                        { return id; }
    public OrderNumber orderNumber()          { return orderNumber; }
    public String customerId()                { return customerId; }
    public OrderStatus status()               { return status; }
    public Currency currency()                { return currency; }
    public Instant createdAt()                { return createdAt; }
    public Instant expiresAt()                { return expiresAt; }
    // ⚠️ deliveredAt() 定義在 markDelivered 旁邊（讓它與寫入點放在一起）
    public String idempotencyKey()            { return idempotencyKey; }
    public List<OrderLine> lines()            { return lines; }                 // 已 List.copyOf
    public String shippingAddressId()         { return shippingAddressId; }
    public ShippingSnapshot shippingSnapshot(){ return shippingSnapshot; }
    public AppliedCoupon appliedCoupon()      { return appliedCoupon; }
    public Money shippingFee()                { return shippingFee; }
    public InvoiceSpec invoice()              { return invoice; }
    public String customerNote()              { return customerNote; }
    public Cancellation cancellation()        { return cancellation; }
    public List<Payment> payments()           { return List.copyOf(payments); }  // ★ 防禦性複製
    public List<Shipment> shipments()         { return List.copyOf(shipments); } // ★ 同上
}
```

⚠️ **`payments()` 與 `shipments()` 做防禦性複製，`lines()` 不做。**
差別在於 `lines` 是 `final` 且在建構子就 `List.copyOf` 過了（已經不可變），
而 `payments` / `shipments` 是可變的 `ArrayList` ——
直接回傳它們等於**把「新增付款」的能力洩漏給呼叫端**：

```java
// 🔴 如果 payments() 直接回傳內部的 ArrayList
order.payments().add(Payment.succeeded(...));    // ← 繞過了 markPaid 的所有檢查
```

### 0.9.3 `OrderStatus`：狀態機

04-controller 06 章定義了 `OrderStatus` 的 enum 常數與 `labelKey()`。
**這一站把狀態機補上去。**

```java
package example.shop.order.domain;

import com.fasterxml.jackson.annotation.JsonEnumDefaultValue;
import example.shop.common.web.LabeledEnum;

import java.util.EnumSet;
import java.util.Set;

/**
 * 訂單狀態與狀態機。
 *
 * <p>★★ <b>狀態機定義在 enum 上，而不是在 Service 的 switch 裡。</b>
 * 三個理由：
 * <ol>
 *   <li><b>單一真相</b> —— {@code Order.cancel()} 的守衛、
 *       {@code allowedActions()}、以及 04-controller 站的 {@code statusLabel}
 *       全部讀同一份定義。</li>
 *   <li><b>新增狀態時編譯器會提醒</b> —— {@code EnumSet} 的初始化在這個檔案裡，
 *       改動集中。而散在 5 個 Service 的 {@code if} 不會提醒任何人。</li>
 *   <li><b>可以被完整掃描測試</b> —— 7×7 = 49 個轉移組合可以一次跑完（0.9.5）。</li>
 * </ol>
 *
 * <pre>
 *                    ┌──────────────────┐
 *                    │ PENDING_PAYMENT  │ ← place()
 *                    └───┬──────┬───────┘
 *              markPaid()│      │cancel() / 逾期
 *                        ▼      ▼
 *                  ┌────────┐  ┌───────────┐
 *                  │  PAID  │  │ CANCELLED │ ← 終態
 *                  └─┬────┬─┘  └───────────┘
 *            ship()  │    │ cancel()
 *          （部分）   │    └──────────► CANCELLED
 *                    ▼
 *          ┌───────────────────┐
 *          │ PARTIALLY_SHIPPED │──cancel()──► CANCELLED
 *          └─────────┬─────────┘
 *              ship()│（出完）
 *                    ▼
 *              ┌──────────┐
 *              │ SHIPPED  │
 *              └────┬─────┘
 *          deliver()│
 *                    ▼
 *             ┌───────────┐
 *             │ DELIVERED │──refund()──► REFUNDED ← 終態
 *             └───────────┘
 * </pre>
 */
public enum OrderStatus implements LabeledEnum {

    PENDING_PAYMENT,
    PAID,
    PARTIALLY_SHIPPED,
    SHIPPED,
    DELIVERED,
    CANCELLED,
    REFUNDED,

    /** 見 04-controller 6.5.8 的完整說明（未知值的落點，只用於讀取外部系統的資料）。 */
    @JsonEnumDefaultValue
    UNKNOWN;

    // ★★ 狀態機定義。static 區塊在所有常數之後，避免 enum 初始化順序問題。
    private static final java.util.Map<OrderStatus, Set<OrderStatus>> TRANSITIONS;

    static {
        var m = new java.util.EnumMap<OrderStatus, Set<OrderStatus>>(OrderStatus.class);
        m.put(PENDING_PAYMENT,   EnumSet.of(PAID, CANCELLED));
        m.put(PAID,              EnumSet.of(PARTIALLY_SHIPPED, SHIPPED, CANCELLED));
        m.put(PARTIALLY_SHIPPED, EnumSet.of(SHIPPED, CANCELLED));
        m.put(SHIPPED,           EnumSet.of(DELIVERED));
        m.put(DELIVERED,         EnumSet.of(REFUNDED));
        m.put(CANCELLED,         EnumSet.noneOf(OrderStatus.class));   // 終態
        m.put(REFUNDED,          EnumSet.noneOf(OrderStatus.class));   // 終態
        m.put(UNKNOWN,           EnumSet.noneOf(OrderStatus.class));   // ⚠️ 不可轉出
        TRANSITIONS = java.util.Collections.unmodifiableMap(m);
    }

    /** ★ 不變量 I5 的定義本身。 */
    public boolean canTransitionTo(OrderStatus target) {
        return TRANSITIONS.get(this).contains(target);
    }

    public Set<OrderStatus> nextStates() {
        return TRANSITIONS.get(this);
    }

    // ── 業務語意的述詞（predicate）★ ────────────────────────
    //
    // ⚠️ 它們不是「多餘的包裝」。對照兩種寫法：
    //
    //   if (status == PAID || status == PARTIALLY_SHIPPED)          ← 讀者要自己推論意圖
    //   if (status.isShippable())                                   ← 意圖寫在名字裡
    //
    // 而更重要的是：新增一個狀態時，
    // 「所有需要更新的地方」都在這個檔案裡。

    /** 可以被取消（規則 1、2）。 */
    public boolean isCancellable() {
        return this == PENDING_PAYMENT || this == PAID || this == PARTIALLY_SHIPPED;
    }

    /** 已經收到錢（決定取消時要不要退款）。 */
    public boolean isPaid() {
        return this == PAID || this == PARTIALLY_SHIPPED
                || this == SHIPPED || this == DELIVERED;
    }

    /** 可以出貨。 */
    public boolean isShippable() {
        return this == PAID || this == PARTIALLY_SHIPPED;
    }

    /** 可以申請退貨。⚠️ 「7 天內」是 {@code Order} 的規則，不在這裡。 */
    public boolean isReturnable() {
        return this == DELIVERED;
    }

    /** 內容還可以修改（改地址、改明細）。 */
    public boolean isEditable() {
        return this == PENDING_PAYMENT || this == PAID;
    }

    /** ★ 04-controller 0.14 練習 4 用到的：地址可否修改。 */
    public boolean isAddressEditable() {
        return isEditable();
    }

    /** 終態：不會再變了（決定要不要繼續輪詢、要不要進歷史歸檔）。 */
    public boolean isTerminal() {
        return nextStates().isEmpty() && this != UNKNOWN;
    }

    /** ★ 03-rest-api 3.10.2 的分類（給前端上色用）。 */
    public Category category() {
        return switch (this) {
            case PENDING_PAYMENT              -> Category.WAITING;
            case PAID, PARTIALLY_SHIPPED, SHIPPED -> Category.IN_PROGRESS;
            case DELIVERED                    -> Category.COMPLETED;
            case CANCELLED, REFUNDED          -> Category.CLOSED;
            case UNKNOWN                      -> Category.UNKNOWN;
        };
    }

    public enum Category implements LabeledEnum {
        WAITING, IN_PROGRESS, COMPLETED, CLOSED, UNKNOWN;

        @Override public String labelKey() { return "orderStatusCategory." + name(); }
    }

    @Override
    public String labelKey() {
        return "orderStatus." + name();
    }
}
```

⚠️ **`category()` 用 `switch` 而不是 `EnumMap`，而且沒有 `default`。**
這是刻意的：**沒有 `default` 的 switch expression 在新增 enum 常數時會編譯失敗**
（Java 21 的窮盡性檢查）。

> 📌 **這是「讓編譯器當守門人」最便宜的一招。**
> 對照 `isCancellable()` 那種 `==` 比較 —— 新增狀態時它會**靜默地回傳 false**。
> ⚠️ 所以理想上所有述詞都該寫成窮盡的 switch。
> shop-service 沒有全部這樣做（可讀性 vs 安全性的取捨），
> 但補上了 0.9.5 的掃描測試作為替代守門人。

### 0.9.4 `OrderApplicationService`

```java
package example.shop.order.application;

import example.shop.common.money.Money;
import example.shop.order.application.port.*;
import example.shop.order.domain.*;
import example.shop.order.service.command.CreateOrderCommand;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * 訂單的 use case 編排。
 *
 * <p>★★ 它的每一個方法都符合同一個結構：
 * <pre>
 *   1. 冪等檢查（若是寫入操作）
 *   2. 取出需要的東西（Repository / 埠）
 *   3. 呼叫聚合的方法 ← ★★ 業務判斷全部在這一行裡面
 *   4. 存回去
 *   5. 依照聚合回傳的「後果」執行後續（同交易）
 *   6. 發佈事件（交易外的副作用）
 * </pre>
 *
 * <p><b>如果你在這個類別裡看到業務 {@code if}，那就是設計錯了</b> ——
 * 除了「需要查別的聚合才能判斷」的那些（0.5.5）。
 */
@Service
public class OrderApplicationService implements OrderService {

    private final OrderRepository orders;
    private final ProductRepository products;
    private final StockPort stock;
    private final CouponRepository coupons;
    private final ShippingAddressRepository addresses;
    private final CustomerRepository customers;
    private final IdempotencyStore idempotency;
    private final AuditRecorder audit;
    private final DomainEventPublisher events;
    private final ShippingFeePolicy shippingFeePolicy;
    private final PricingPolicy pricingPolicy;
    private final IdGenerator ids;
    private final OrderNumberGenerator orderNumbers;
    private final Clock clock;                     // ★ 判準 4

    // 建構子注入（1.4.1 會討論「14 個依賴」這件事，以及怎麼降下來）
    public OrderApplicationService(OrderRepository orders, ProductRepository products,
                                   StockPort stock, CouponRepository coupons,
                                   ShippingAddressRepository addresses,
                                   CustomerRepository customers,
                                   IdempotencyStore idempotency, AuditRecorder audit,
                                   DomainEventPublisher events,
                                   ShippingFeePolicy shippingFeePolicy,
                                   PricingPolicy pricingPolicy,
                                   IdGenerator ids, OrderNumberGenerator orderNumbers,
                                   Clock clock) {
        this.orders = orders;
        this.products = products;
        this.stock = stock;
        this.coupons = coupons;
        this.addresses = addresses;
        this.customers = customers;
        this.idempotency = idempotency;
        this.audit = audit;
        this.events = events;
        this.shippingFeePolicy = shippingFeePolicy;
        this.pricingPolicy = pricingPolicy;
        this.ids = ids;
        this.orderNumbers = orderNumbers;
        this.clock = clock;
    }

    /**
     * 下單。
     *
     * <p>⚠️ {@code @Transactional} 沒有指定 {@code rollbackFor} ——
     * 因為所有業務例外都繼承 {@code BusinessException extends RuntimeException}
     * （04-controller 3.5.2），預設規則已經涵蓋。
     * <b>02 章 2.6 會說明什麼時候真的需要 {@code rollbackFor}。</b>
     */
    @Override
    @Transactional
    // ⚠️⚠️ 回傳型別在 03 章 3.10.3 ① 會改成 OrderResultView ——
    //    理由是「聚合離開交易會拋 LazyInitializationException，
    //    而 allowedActions 的授權判斷跑到了 Web 層」（03 章 3.3.3）。
    //    ★ 讀到這裡先接受「回聚合」，03 章會論證為什麼那是錯的。
    public Order create(CreateOrderCommand cmd) {

        Instant now = clock.instant();

        // ── ① 冪等（04-controller 4.9 只做了 Redis 那一半，這裡是持久的那一半）──
        var existing = idempotency.findOrderId(cmd.actor().id(), cmd.idempotencyKey());
        if (existing.isPresent()) {
            // ★ 回傳「上一次的結果」而不是拋例外 —— 這是冪等的定義
            return orders.findById(existing.get())
                    .orElseThrow(() -> new IllegalStateException(
                            "冪等紀錄指向不存在的訂單：" + existing.get()));
        }

        // ── ② 授權：地址必須屬於這個客戶（04-controller 0.3 那個 IDOR 的正解）──
        //    ⚠️ 用「查詢條件」而不是「查出來再 if」：
        //       ① 少一次資料外洩的機會（查不到就沒有資料在記憶體裡）
        //       ② 回 404 而不是 403 —— 不洩漏「這個 ID 存在」
        ShippingAddress address = addresses
                .findByIdAndCustomerId(cmd.shippingAddressId(), cmd.actor().id())
                .orElseThrow(() -> new ResourceNotFoundException(
                        "ShippingAddress", cmd.shippingAddressId()));

        // ── ③ 取商品 ─────────────────────────────────
        // ⚠️⚠️ 02 章 2.14.1 ① 會在這裡加一個 .sorted() ——
        //    因為第 ⑤ 步的扣庫存會逐一鎖定商品列，
        //    而「兩張訂單含相同商品但順序不同」→ 死鎖。
        //    ★ 固定鎖順序（依 productId 排序）是唯一不需要重試的解法。
        List<String> productIds = cmd.lines().stream()
                .map(CreateOrderCommand.Line::productId).distinct().toList();
        Map<String, Product> productMap = products.findAllById(productIds).stream()
                .collect(java.util.stream.Collectors.toMap(Product::id, Function.identity()));

        // ★ 缺哪幾個要一次說完 —— 一個一個回報會讓使用者來回試 5 次
        List<String> missing = productIds.stream()
                .filter(id -> !productMap.containsKey(id))
                .toList();
        if (!missing.isEmpty()) {
            throw new ProductNotFoundException(missing);
        }

        // ★ 一次取回「下單需要的客戶資訊」——等級（算價）+ email（事件）
        //   ⚠️ 不要為了 email 再查一次：那是 N+1 的起點，也讓時間點不一致
        CustomerSummary customer = customers.summaryOf(cmd.actor().id())
                .orElseThrow(() -> new ResourceNotFoundException("Customer", cmd.actor().id()));
        CustomerLevel level = customer.level();

        // ── ④ 扣庫存（原子 SQL，0.8.3 的 ③）──────────
        //    ⚠️ 放在算價之前 —— 越可能失敗的越早做（0.6.2）
        //
        //    ⚠️⚠️ 用<b>索引</b>迴圈而不是 for-each + indexOf：
        //    {@code Line} 是 record，兩筆 {@code Line("P-1", 2)} 是 equal 的，
        //    於是 {@code indexOf} 對第二筆會回傳<b>第一筆的索引</b> ——
        //    錯誤訊息的 {@code items[0]} 指向錯的那一列（04-controller 2.9.3 的 errors[] 會用它定位）。
        for (int i = 0; i < cmd.lines().size(); i++) {
            var line = cmd.lines().get(i);
            if (!stock.tryReserve(line.productId(), line.quantity())) {
                // ★ 失敗才查 snapshot（錯誤路徑可以慢，0.8.3）
                var snap = stock.snapshot(line.productId());
                var product = productMap.get(line.productId());
                throw new InsufficientStockException(
                        line.productId(), product.name(), line.quantity(),
                        snap.map(StockSnapshot::available).orElse(0),
                        snap.map(StockSnapshot::restockEstimatedAt).orElse(null),
                        i);
            }
        }

        // ── ⑤ 算價（★ 純函式，規則在 Domain）───────────
        List<PricedLine> pricedLines = cmd.lines().stream()
                .map(line -> {
                    Product p = productMap.get(line.productId());
                    // ★★ 「這個商品能不能買」由 Product 自己判斷（不適用時它拋例外）
                    p.requirePurchasable(now);
                    Money unitPrice = pricingPolicy.priceOf(p, level, now);
                    return new PricedLine(p.id(), p.name(), p.sku(),
                                          unitPrice, line.quantity());
                })
                .toList();

        // ── ⑥ 取券（能不能用由 Coupon 判斷）─────────────
        Coupon coupon = null;
        if (cmd.couponCode() != null) {
            coupon = coupons.findByCode(cmd.couponCode())
                    .orElseThrow(() -> new CouponNotFoundException(cmd.couponCode()));
        }

        // ── ⑦ ★★ 建立聚合：所有業務判斷都在這一行裡 ────
        Order order = Order.place(
                ids.newOrderId(),
                orderNumbers.next(now),
                cmd.actor().id(),
                cmd.idempotencyKey(),
                pricedLines,
                address,
                coupon,
                shippingFeePolicy,
                InvoiceSpec.from(cmd.invoice()),
                cmd.customerNote(),
                now);

        // ── ⑧ 存 ────────────────────────────────────
        orders.save(order);
        idempotency.record(cmd.actor().id(), cmd.idempotencyKey(), order.id(), now);

        // ── ⑨ 券計數（原子，0.3.2 事故 5 的正解）────────
        if (coupon != null && !coupons.tryConsume(coupon.code())) {
            // ★ 拋例外 → 整個交易回滾（含庫存），這是對的
            throw new CouponExhaustedException(coupon.code());
        }

        // ── ⑩ 稽核（同交易 —— 判準 3）──────────────────
        audit.record(AuditEvent.orderPlaced(order, cmd.actor(), now));

        // ── ⑪ 事件（commit 之後才會被處理 —— 06 章 6.7）──
        //    ★ 「中等胖度」的事件 —— 完整定義與取捨見 0.12 ⑬ 與 01 章 1.6.1
        events.publish(OrderPlacedEvent.from(order, customer.email(), now));

        return order;
    }
}
```

**⚠️ 這個方法有 60 行，而它做的每一件事都是「取東西」或「存東西」。**
**業務判斷 0 個** —— 全部在 `Order.place()`、`Product.requirePurchasable()`、
`Coupon.discountFor()`、`ShippingFeePolicy.feeFor()` 裡面。

⚠️ **注意第 ⑨ 步的位置。** 券計數在 `orders.save()` **之後**。
為什麼不放前面？

因為 `Order.place()` 可能拋 `CouponNotApplicableException`
（未達最低消費）—— 那時候券不該被計數。
把 `tryConsume` 放在 `place()` 成功之後，就不需要「失敗時退回計數」的補償邏輯。

> 📌 **編排順序的第二條原則**（第一條在 0.6.2）：
> **有副作用的步驟，放在所有可能失敗的判斷「之後」。**
> 這樣就不需要補償。

⚠️ **但庫存為什麼不遵守這條原則？** 它在 `place()` 之前，而且有副作用。

**因為兩條原則衝突了**，而衝突時要選代價小的：

| 選項 | 好處 | 代價 |
|---|---|---|
| 先扣庫存（現在的做法） | 早失敗，不浪費算價與鎖 | `place()` 失敗時要靠 rollback 還庫存 |
| 先算價再扣庫存 | 不需要 rollback 還庫存 | 高併發時大量請求算完價才發現沒貨 |

**shop-service 選前者**，因為 `tryReserve` 與 `place()` 在**同一個交易裡**，
`place()` 拋例外會讓庫存的 UPDATE 一起回滾 —— **rollback 是免費的補償**。

> ⚠️⚠️ **而這正是「交易邊界」的價值**：
> 在交易之內，「補償」由資料庫免費提供；
> 在交易之外（券計數若走 Redis、庫存若走外部 WMS），
> 你必須自己寫補償邏輯 —— 而那是 06 章 6.9 的 Saga。

### 0.9.5 三層各自的測試

**這是分層最直接的報酬：三層有三種完全不同的測試，各自很快。**

```java
// ── ① Domain 測試：純 JUnit，零框架 ────────────────────────
class OrderPlaceTest {

    private static final Instant NOW = Instant.parse("2026-03-15T10:00:00Z");

    @Test
    void 下單後狀態是待付款_且付款期限是三十分鐘後() {
        Order order = Orders.place()                    // Object Mother（04-controller 7.7）
                .line("P-1", 2, Money.twd("500"))
                .at(NOW)
                .build();

        assertThat(order.status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
        assertThat(order.expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(30)));
        assertThat(order.total()).isEqualTo(Money.twd("1000"));   // 500×2，達免運
    }

    @Test
    void 明細幣別不一致會被拒絕() {
        assertThatThrownBy(() -> Orders.place()
                        .line("P-1", 1, Money.of("500", "TWD"))
                        .line("P-2", 1, Money.of("20", "USD"))
                        .build())
                .isInstanceOf(MixedCurrencyException.class);
    }

    @Test
    void 總金額為負會拋不變量例外() {
        // ★ 折扣 1500 > 小計 1000 → 這是「Coupon 算錯了」的情境
        assertThatThrownBy(() -> Orders.place()
                        .line("P-1", 2, Money.twd("500"))
                        .couponDiscount(Money.twd("1500"))
                        .build())
                .isInstanceOf(IllegalStateException.class)     // ← 不是業務例外
                .hasMessageContaining("訂單總金額為負");
    }

    /**
     * ★★ 掃描測試：{@code allowedActions()} 與實際操作的守衛必須一致。
     *
     * <p>它防的是「按鈕顯示得出來但按下去 409」這個經典 bug。
     */
    @ParameterizedTest
    @EnumSource(value = OrderStatus.class, names = "UNKNOWN", mode = EXCLUDE)
    void allowedActions說可以取消_就真的可以取消(OrderStatus status) {
        Order order = Orders.inStatus(status).ownedBy("cus_1").at(NOW).build();
        Actor customer = Actors.customer("cus_1");

        boolean advertised = order.allowedActions(customer, NOW)
                                  .contains(OrderAction.CANCEL);

        if (advertised) {
            assertThatCode(() -> order.cancel(
                            customer, CancelReason.CHANGED_MIND, null, NOW))
                    .as("狀態 %s 宣告可取消，就不該拋例外", status)
                    .doesNotThrowAnyException();
        } else {
            assertThatThrownBy(() -> order.cancel(
                            customer, CancelReason.CHANGED_MIND, null, NOW))
                    .as("狀態 %s 宣告不可取消，就該拋例外", status)
                    .isInstanceOf(RuntimeException.class);
        }
    }

    /** ★★ 狀態機的 7×7 = 49 個組合一次掃完。 */
    @Test
    void 狀態機沒有孤島也沒有不可達狀態() {
        var reachable = EnumSet.of(OrderStatus.PENDING_PAYMENT);
        var frontier = new java.util.ArrayDeque<>(reachable);
        while (!frontier.isEmpty()) {
            for (OrderStatus next : frontier.poll().nextStates()) {
                if (reachable.add(next)) frontier.add(next);
            }
        }
        assertThat(reachable)
                .as("除了 UNKNOWN，每個狀態都要能從 PENDING_PAYMENT 到達")
                .containsAll(EnumSet.complementOf(EnumSet.of(OrderStatus.UNKNOWN)));
    }
}
```

**執行時間：49 個案例 + 12 個測試 ≈ 40 毫秒。**

⚠️⚠️ **`Orders.inStatus(status)` 這個 Object Mother 有一個陷阱，值得單獨講。**

`Order` 的建構子與每個狀態轉移都會呼叫 `assertInvariants()`，
而 I7 說「已付款的訂單一定有成功的付款紀錄」。
`OrderStatus.isPaid()` 涵蓋 `PAID`、`PARTIALLY_SHIPPED`、`SHIPPED`、`DELIVERED` 四個狀態。

👉 **所以 `Orders.inStatus(DELIVERED)` 如果只是「把 status 設成 DELIVERED」，
它會拋 `IllegalStateException`** —— 而失敗訊息是
「已付款的訂單沒有付款紀錄」，看起來像是**被測程式碼的 bug**。

**正確的 Object Mother 要「走過真實的狀態路徑」**：

```java
public static OrderBuilder inStatus(OrderStatus target) {
    return new OrderBuilder().drivenTo(target);
}

/**
 * ★★ 不是「設定 status 欄位」，而是<b>真的呼叫那些狀態轉移方法</b>。
 *
 * <p>三個好處：
 * <ol>
 *   <li>產生的 {@code Order} 一定滿足所有不變量（因為它是真的走過來的）。</li>
 *   <li>★ 它<b>順便測了狀態機</b> —— 如果某條路徑走不通，
 *       所有用到那個狀態的測試都會紅燈，而那是正確的訊號。</li>
 *   <li>⚠️ 而「用反射直接塞欄位」的 Object Mother 會產生
 *       <b>真實系統裡不可能存在的訂單</b>，於是測試通過但生產環境爆炸。</li>
 * </ol>
 */
private OrderBuilder drivenTo(OrderStatus target) {
    // PENDING_PAYMENT 是起點，不用做任何事
    if (target == OrderStatus.PENDING_PAYMENT) return this;

    this.postBuild = order -> {
        if (target == OrderStatus.CANCELLED) {
            order.cancel(Actors.support("sup_1"), CancelReason.OTHER, "測試", at);
            return;
        }
        // 其餘狀態都要先付款
        order.markPaid("pay_1", order.total(), PaymentMethod.CREDIT_CARD, at, at);
        switch (target) {
            case PAID -> { }
            case PARTIALLY_SHIPPED -> order.ship(halfOf(order), "TRK-1", Carrier.BLACK_CAT, at);
            case SHIPPED, DELIVERED, REFUNDED -> {
                order.ship(allOf(order), "TRK-1", Carrier.BLACK_CAT, at);
                if (target != OrderStatus.SHIPPED) order.markDelivered(at);
                // ⚠️ REFUNDED 需要 DELIVERED → REFUNDED 的轉移，
                //    而 Order 目前沒有那個方法（04-controller 站的退貨流程）——
                //    所以這個 builder 現在支援不到 REFUNDED
            }
            default -> throw new IllegalArgumentException("不支援的目標狀態：" + target);
        }
    };
    return this;
}
```

⚠️ **注意最後那段註解揭露的一件事**：
`OrderStatus` 的狀態機有 `DELIVERED → REFUNDED` 這條邊，
但 **`Order` 上沒有任何方法會走它**。

**這不是 builder 的問題，是 `Order` 的缺口** ——
退款流程（`Order.requestRefund()` / `markRefunded()`）在
**04 章（業務例外設計）與 01 章練習 3** 才會補上。

> 📌 **而「Object Mother 寫不出某個狀態」正是發現這個缺口的方式。**
> 這也是為什麼 0.9.5 的
> `狀態機沒有孤島也沒有不可達狀態` 那個測試值得存在 ——
> 它會告訴你「狀態機宣告了一條路，但沒有人走得到」。
>
> ⚠️ 嚴格說，那個測試檢查的是「狀態**可達**」而不是「有方法可以走」。
> **兩者都要有守門人**，所以再加一個：

```java
/**
 * ★★ 狀態機的每一條邊，都要有一個公開方法會走它。
 *
 * <p>它抓的是「宣告了轉移但沒有實作」——
 * 而那個狀態會永遠是不可達的死碼。
 */
@Test
void 狀態機的每一條邊都有對應的操作() {
    // ⚠️ 這份對照表要手動維護，而那正是重點：
    //    新增一條邊時，你必須在這裡寫下「誰會走它」，
    //    否則測試紅燈。
    var edges = Map.of(
            PENDING_PAYMENT, Map.of(PAID, "markPaid", CANCELLED, "cancel"),
            PAID, Map.of(PARTIALLY_SHIPPED, "ship", SHIPPED, "ship", CANCELLED, "cancel"),
            PARTIALLY_SHIPPED, Map.of(SHIPPED, "ship", CANCELLED, "cancel"),
            SHIPPED, Map.of(DELIVERED, "markDelivered"),
            DELIVERED, Map.of(REFUNDED, "markRefunded"));   // ⚠️ 目前不存在 → 紅燈

    var missing = new ArrayList<String>();
    for (var from : EnumSet.complementOf(EnumSet.of(UNKNOWN))) {
        for (var to : from.nextStates()) {
            String method = edges.getOrDefault(from, Map.of()).get(to);
            if (method == null) {
                missing.add(from + " → " + to + "（沒有登記負責的方法）");
            } else if (Arrays.stream(Order.class.getDeclaredMethods())
                             .noneMatch(m -> m.getName().equals(method)
                                          && Modifier.isPublic(m.getModifiers()))) {
                missing.add(from + " → " + to + "（登記的 " + method + "() 不存在）");
            }
        }
    }
    assertThat(missing).isEmpty();
}
```

⚠️ **這個測試現在會紅燈**（`markRefunded` 不存在），而**那是刻意的**：
它是一個「還沒做完」的可執行待辦，比 `// TODO` 可靠得多。
04 章補上退款流程時，它會自動變綠。

```java
// ── ② Application Service 測試：mock repository ─────────────
@ExtendWith(MockitoExtension.class)
class OrderApplicationServiceTest {

    @Mock OrderRepository orders;
    @Mock StockPort stock;
    @Mock ProductRepository products;
    @Mock ShippingAddressRepository addresses;
    // …（07 章會完整展開，包含「14 個 mock 是一個設計訊號」）

    /**
     * ★★ 這一層的測試該測什麼：<b>編排的順序與交互</b>，不是業務規則。
     *
     * <p>業務規則已經由 ① 測過了。這裡重複測它是浪費
     * （而且會在規則改變時讓兩個地方一起紅燈）。
     */
    @Test
    void 庫存扣減失敗時不會建立訂單() {
        given(addresses.findByIdAndCustomerId(any(), any()))
                .willReturn(Optional.of(Addresses.taipei()));
        given(products.findAllById(any())).willReturn(List.of(Products.p1()));
        given(customers.summaryOf(any())).willReturn(Optional.of(Customers.normal()));
        given(stock.tryReserve("P-1", 2)).willReturn(false);           // ★ 庫存不足
        given(stock.snapshot("P-1")).willReturn(Optional.of(
                new StockSnapshot("P-1", 1, 0, LocalDate.of(2026, 3, 20))));

        assertThatThrownBy(() -> service.create(Commands.createOrder("P-1", 2)))
                .isInstanceOf(InsufficientStockException.class);

        // ★★ 這一行是這個測試真正的重點
        then(orders).should(never()).save(any());
        then(events).should(never()).publish(any());
    }

    @Test
    void 相同冪等鍵回傳同一張訂單而不重複建立() {
        given(idempotency.findOrderId("cus_1", "idem-abc"))
                .willReturn(Optional.of("ord_existing"));
        given(orders.findById("ord_existing")).willReturn(Optional.of(Orders.paid().build()));

        Order result = service.create(Commands.createOrder().idempotencyKey("idem-abc").build());

        assertThat(result.id()).isEqualTo("ord_existing");
        then(stock).shouldHaveNoInteractions();       // ★ 完全沒有碰庫存
        then(orders).should(never()).save(any());
    }
}
```

**執行時間 ≈ 200 毫秒（Mockito 的初始化成本）。**

```java
// ── ③ 交易與併發測試：真的 MySQL（02 章 2.2.5）──────────────
@SpringBootTest
@Testcontainers
class OrderTransactionIntegrationTest extends MySqlIntegrationTestBase {

    @Test
    void 券已用完時整個下單回滾_庫存也還回去() {
        stock.upsert("P-1", 10);
        coupons.insertExhausted("SPRING10");          // usedCount == totalCount

        assertThatThrownBy(() -> service.create(
                        Commands.createOrder("P-1", 3).couponCode("SPRING10").build()))
                .isInstanceOf(CouponExhaustedException.class);

        // ★★ 這是整個測試的重點：庫存被 rollback 還回去了
        assertThat(stock.snapshot("P-1").orElseThrow().available()).isEqualTo(10);
        assertThat(orders.countByCustomerId("cus_1")).isZero();
    }
}
```

**執行時間 ≈ 6 秒（含容器啟動，但容器在整個測試 session 內共用）。**

**三層的測試成本對照：**

| 層 | 測什麼 | 需要什麼 | 一個測試的時間 | 數量 |
|---|---|---|---|---|
| Domain | 業務規則、不變量、狀態機 | 什麼都不用 | **< 1 ms** | **最多**（約 200 個） |
| Application | 編排順序、交互、例外傳播 | Mockito | ~5 ms | 中等（約 60 個） |
| 交易 / 併發 | rollback、鎖、約束 | Testcontainers | ~200 ms | **最少**（約 15 個） |

> 📌 **這個金字塔跟 04-controller 7.3 的「Web 層是梯形」不一樣 ——
> Service 層是一個真正的金字塔。**
> 原因是：Domain 的規則可以在**完全沒有依賴**的情況下測，
> 而 Web 層的每一個行為都需要至少一個 servlet 容器的模擬。

---
## 0.10 Service 層不該做的九件事

對照 04-controller 0.6 的「Controller 不該做的十件事」。

### 0.10.1 不該做：在交易裡呼叫外部系統

```java
// 🔴 0.3.2 事故 1
@Transactional
public Order create(CreateOrderCommand cmd) {
    // ...
    erpClient.pushOrder(order);          // ← 佔著資料庫連線做網路 I/O
}
```

```java
// ✅ 發事件，commit 之後在別的執行緒做
@Transactional
public Order create(CreateOrderCommand cmd) {
    // ...
    events.publish(new OrderPlacedEvent(...));
    return order;
}

// 另一個類別
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async("integrationExecutor")
public void pushToErp(OrderPlacedEvent event) {
    erpPort.push(event.orderId());       // ★ 交易外、別的執行緒、有逾時、有重試
}
```

⚠️ **「外部系統」包含的比你想的多**：

| 也是外部系統 | 為什麼常被忽略 |
|---|---|
| Redis | 「它很快啊」—— 但它會 timeout，而且 timeout 時預設要等好幾秒 |
| S3 / 物件儲存 | 上傳一個 5MB 的檔案在交易裡 = 佔連線 2 秒 |
| 寄信（SMTP） | SMTP 握手 + TLS 可能超過 3 秒 |
| 另一個微服務 | 即使它平常 20ms |
| **另一個資料庫** | ⚠️ 不同 DataSource 不在同一個交易裡 |
| `Thread.sleep` / 等鎖 | 沒有網路，但一樣佔著連線 |

### 0.10.2 不該做：把 `HttpServletRequest`、`ServletRequest`、session 往下傳

```java
// 🔴
public Order create(CreateOrderCommand cmd, HttpServletRequest request) { }
```

**三個具體後果**（04-controller 0.6.9 已講過一半，這裡補 Service 層特有的）：

| 後果 | 說明 |
|---|---|
| 排程與批次無法呼叫 | 它們沒有 request |
| **`@Async` 之後 request 已被回收** | Tomcat 會 recycle `Request` 物件 → 讀到別人的資料 🔴 |
| 測試要 mock servlet API | Domain 測試的「零依賴」優勢消失 |

⚠️ 第二點是真實的資安問題：Tomcat 會**重用** `Request` 物件。
非同步執行緒拿著一個已經回收的 request 讀 header，
讀到的是**下一個請求**的內容。

### 0.10.3 不該做：回傳 Entity 給 Web 層

03 章會完整處理。這裡先給結論與**一個容易忽略的理由**：

```java
// ⚠️ 04-controller 站的 Controller 就是這樣寫的（0.10.2）：
var order = orderService.create(...);      // ← Order 聚合
var body  = mapper.toCreateResponse(order); // ← 立刻轉成 DTO
```

**shop-service 的立場是「Service 回傳 Domain 物件，Web 層負責轉 DTO」**，
而不是「Service 回傳 DTO」。理由：

| 理由 | 說明 |
|---|---|
| Service 不該知道「這次要回哪一種 DTO」 | 同一個 `create()` 被 API、排程、gRPC 呼叫，各要不同形狀 |
| DTO 的欄位可見性取決於 actor 角色 | 那是 Web 層的判斷（04-controller 1.12.2 的 `user.role()`） |
| **`Order` 到了 Web 層已經脫離交易** | ⚠️ 用 JPA 時這會變成 `LazyInitializationException` —— **08 章的重點坑** |

⚠️ **最後一點是「回傳 Domain」這個決定的真實代價，要誠實承認**：
`Order` 上如果有延遲載入的關聯，在 Controller 存取它會炸。
**08 章會給三種解法**（DTO projection、`@EntityGraph`、
在 Service 內就把需要的東西 touch 過）。

### 0.10.4 不該做：吞例外

```java
// 🔴 出現頻率最高的一個反模式
try {
    stock.reserve(productId, qty);
} catch (Exception e) {
    log.error("扣庫存失敗", e);          // ← 然後呢？
}
// ↓ 程式繼續往下跑，訂單成立了，庫存沒扣
```

**三條規則：**

```
① 你不知道怎麼處理 → 不要 catch，讓它往上拋
② 你要換一個例外   → catch + throw new XxxException(..., e)  ← 一定要帶 cause
③ 你真的要忽略它   → 寫下「為什麼可以忽略」的註解，並考慮它會不會靜默失敗
```

⚠️ **而在 `@Transactional` 方法裡 catch 例外特別危險**：

```java
// 🔴🔴 這個交易已經被標記為 rollback-only 了
@Transactional
public void doSomething() {
    try {
        repositoryA.save(x);          // ← 假設這裡拋了 DataIntegrityViolationException
    } catch (Exception e) {
        log.warn("忽略", e);
    }
    repositoryB.save(y);              // ← 繼續執行
}                                     // ← commit 時拋 UnexpectedRollbackException
```

**症狀**：方法看起來成功了，但最後拋 `UnexpectedRollbackException`，
而 stack trace 完全沒有指向真正的原因。
**這是 02 章 2.8 會詳細處理的「交易標記為 rollback-only」問題。**

### 0.10.5 不該做：在 Service 裡重複做輸入驗證

```java
// 🔴 04-controller 2.x 的 @Valid 已經做過了
if (cmd.lines() == null || cmd.lines().isEmpty()) {
    throw new RuntimeException("商品不能為空");
}
```

**兩份規則一定會分岔。** 而分岔的方向通常是
「Web 層改成 max 100，Service 還是 50」——
於是使用者送 80 筆，通過驗證，被 Service 拒絕，錯誤訊息還是英文的。

⚠️ **但「不重複驗證」不等於「不做前置條件斷言」**：

| | 目的 | 用什麼 | 失敗的意義 |
|---|---|---|---|
| **驗證**（Web 層） | 擋使用者的壞輸入 | Bean Validation | 422 + 欄位級訊息 |
| **前置條件**（Service） | 抓程式錯誤 | `Objects.requireNonNull` | 500，因為是 bug |
| **不變量**（Domain） | 保護系統狀態 | `assertInvariants()` | 500，因為是 bug |

```java
// ✅ 這不是重複驗證，這是前置條件
public Order create(CreateOrderCommand cmd) {
    Objects.requireNonNull(cmd, "cmd");
    Objects.requireNonNull(cmd.actor(), "actor");
    // ⚠️ 不要寫 if (cmd.lines().isEmpty()) throw new BusinessException(...)
    //    那是驗證，而它已經做過了。
    //    「明細為空」在 Domain 裡由 Order.place() 的 OrderEmptyException 守
    //    —— 那是不變量，不是驗證（0.8.1 的區別）
}
```

### 0.10.6 不該做：讓 Service 認識錯誤碼與 HTTP 狀態

```java
// 🔴
throw new BusinessException(ErrorCode.INSUFFICIENT_STOCK, HttpStatus.CONFLICT, "...");
```

⚠️ 04-controller 3.5.6 已經處理過這個妥協：
`ErrorCode` **裡面**有 `HttpStatus`，但 Service 只用 `ErrorCode`，
不直接碰 `HttpStatus`。**「狀態碼」的知識集中在 enum 的定義處。**

而 04-controller 的例外設計（**本站 04 章**會擴充）讓 Service 只需要：

```java
throw new InsufficientStockException(productId, name, requested, available, restockAt, index);
```

**不需要知道它會變成 409。**

### 0.10.7 不該做：`@Transactional` 加在錯的地方

02 章的整章都在講這個。這裡先列三個最常見的：

```java
// 🔴 ① private 方法 —— 完全沒有效果（代理攔不到）
@Transactional private void doIt() { }

// 🔴 ② 同類別自呼叫 —— 完全沒有效果
public void outer() { this.inner(); }
@Transactional public void inner() { }

// 🔴 ③ 加在整個類別上 —— 讀取方法也開了交易
@Service @Transactional
public class OrderApplicationService {
    public Order findById(String id) { }     // ← 開了一個什麼都沒寫的交易
}
```

### 0.10.8 不該做：把「查詢」與「命令」混在一個 Service 裡而不區分交易屬性

```java
// ⚠️ 可以動，但效率差
@Service
@Transactional                                  // ← 全部都是可寫交易
public class OrderApplicationService {
    public Order create(...) { }
    public OrderDetail findById(...) { }        // ← 也開了可寫交易
    public Page<OrderSummary> search(...) { }   // ← 也開了可寫交易
}
```

**可寫交易的代價**（02 章 2.5 會量化）：

| 代價 | 說明 |
|---|---|
| Hibernate 的 dirty checking | 讀出來的每一個 Entity 都要在 flush 時比對，大列表時明顯 |
| 讀寫分離失效 | `readOnly = true` 是「路由到 replica」的判斷依據（06 章） |
| 佔用可寫連線 | 有些架構的 primary 連線池比 replica 小很多 |

```java
// ✅
@Transactional(readOnly = true)                 // ← 類別層預設唯讀
public class OrderQueryService { }

@Transactional                                  // ← 命令方法明確標註
public Order create(...) { }
```

### 0.10.9 不該做：在 Service 裡處理「顯示」的事

```java
// 🔴
public String cancel(CancelOrderCommand cmd) {
    // ...
    return "訂單已取消，退款將於 3-5 個工作日內退回";   // ← i18n 訊息在 Service
}
```

⚠️ 04-controller 3.4（）已經建立了 `userMessage` 的 i18n 機制，
訊息由 `ErrorCode.userMessageKey()` + `MessageSource` 產生。
**Service 只提供資料（`ext("refundDays", 5)`），不組字串。**

**理由**：Service 不知道呼叫端的語言。
排程呼叫它的時候根本沒有 `Locale`。

### 0.10.10 九件事的總表

| # | 不該做 | 後果 | 哪一章解 |
|---|---|---|---|
| 1 | 交易裡呼叫外部系統 | 連線池耗盡（事故 1） | 06 |
| 2 | 往下傳 `HttpServletRequest` | 非同步時讀到別人的資料 | 本章 |
| 3 | 回傳 Entity 到 Web 層 | 序列化外洩、Lazy 例外 | 03、08 站 |
| 4 | 吞例外 | 資料不一致、`UnexpectedRollbackException` | 02、04 |
| 5 | 重複做輸入驗證 | 兩份規則分岔 | 本章 |
| 6 | 認識 HTTP 狀態碼 | 無法被非 HTTP 入口重用 | 04 |
| 7 | `@Transactional` 放錯位置 | **完全沒有交易** | **02（核心）** |
| 8 | 讀寫不分交易屬性 | 效能、讀寫分離失效 | 02 |
| 9 | 組 i18n 訊息 | 排程無法呼叫、語言錯 | 04 |

---

## 0.11 shop-service 的 service 套件結構

### 0.11.1 套件

04-controller 0.11.1 選了 package-by-feature。**這一站把 `order/` 底下攤開**：

```
src/main/java/example/shop/
│
├── common/
│   ├── money/
│   │   └── Money.java                        ★ 0.5.3
│   ├── error/                                （04-controller 站已建立）
│   │   ├── ErrorCode.java                    93 個 code（04-controller 83 + 本站 10）
│   │   ├── BusinessException.java
│   │   ├── FieldViolation.java
│   │   └── ResourceNotFoundException.java
│   ├── time/
│   │   └── ClockConfig.java                  ★ 提供 Clock bean（1.4.6）
│   ├── event/
│   │   ├── DomainEvent.java                  ★ 事件的標記介面
│   │   └── DomainEventPublisher.java         ★ 埠（實作用 Spring 的 publisher）
│   ├── id/
│   │   ├── IdGenerator.java                  ★ 埠
│   │   └── UlidIdGenerator.java              實作
│   └── web/                                  （04-controller 站的 Web 基礎設施）
│
├── order/
│   ├── web/                                  ← 04-controller 的產出（已完成）
│   │   ├── OrderController.java
│   │   ├── OrderWebMapper.java
│   │   └── dto/…
│   │
│   ├── application/                          ★★ 本站新增：編排 + 交易邊界
│   │   ├── OrderApplicationService.java      實作 OrderService
│   │   ├── OrderQueryService.java            ★ 讀取（readOnly）
│   │   ├── OrderExpirationJob.java           排程「30 分鐘未付款自動取消」
│   │   ├── port/                             ★ 對外的埠（介面，1.7）
│   │   │   ├── OrderRepository.java
│   │   │   ├── ProductRepository.java
│   │   │   ├── StockPort.java
│   │   │   ├── CouponRepository.java
│   │   │   ├── ShippingAddressRepository.java
│   │   │   ├── CustomerRepository.java
│   │   │   ├── IdempotencyStore.java
│   │   │   ├── AuditRecorder.java
│   │   │   ├── PaymentGateway.java           ★ 外部金流
│   │   │   └── ErpPort.java                  ★ 外部 ERP
│   │   ├── listener/                         ★ commit 之後的副作用（06 章）
│   │   │   ├── OrderNotificationListener.java
│   │   │   ├── OrderErpListener.java
│   │   │   └── OrderCacheListener.java
│   │   └── event/
│   │       ├── OrderPlacedEvent.java
│   │       ├── OrderCancelledEvent.java
│   │       └── OrderPaidEvent.java
│   │
│   ├── domain/                               ★★ 本站新增：規則（零框架依賴）
│   │   ├── Order.java                        聚合根（0.9.2）
│   │   ├── OrderStatus.java                  狀態機（0.9.3）
│   │   ├── OrderLine.java
│   │   ├── OrderNumber.java                  值物件
│   │   ├── OrderAction.java                  enum：PAY / CANCEL / SHIP …
│   │   ├── Payment.java、Refund.java
│   │   ├── Shipment.java、ShipmentLine.java
│   │   ├── Cancellation.java、CancelReason.java
│   │   ├── AppliedCoupon.java
│   │   ├── ShippingSnapshot.java
│   │   ├── Actor.java                        （04-controller 站已定義，⚠️ 見下方註記）
│   │   ├── PricingPolicy.java                ★ 策略介面
│   │   ├── DefaultPricingPolicy.java
│   │   ├── ShippingFeePolicy.java            ★ 策略介面
│   │   ├── ShippingFeePolicy2026.java
│   │   ├── result/
│   │   │   ├── CancellationResult.java
│   │   │   ├── PaymentResult.java
│   │   │   └── StockRelease.java
│   │   └── exception/
│   │       ├── OrderEmptyException.java
│   │       ├── OrderNotCancellableException.java
│   │       ├── SelfCancelWindowExpiredException.java
│   │       ├── MixedCurrencyException.java
│   │       └── …（本站 04 章會整理成完整階層）
│   │
│   └── infrastructure/                       ← 06/07/08 站的產出
│       ├── JdbcOrderRepository.java          （本站先用記憶體假實作）
│       ├── PaymentGatewayAdapter.java
│       └── ErpAdapter.java
│
├── stock/
│   ├── application/StockApplicationService.java
│   ├── domain/Stock.java                     （0.8.3）
│   └── infrastructure/JdbcStockRepository.java
│
├── coupon/…
├── product/…
└── customer/…
```

⚠️ **`Actor` 的位置是一個已知的妥協**（04-controller 4.13.6 記錄過）：
它在 `order.domain`，但 `common.web` 的 resolver 與 `stock`、`coupon` 都用它。
**正確的位置是 `common.domain`（或一個 `shared-kernel` 模組）。**

> 👉 **這一站不搬它**，理由與 04-controller 站一致：搬動會影響 9 處 import 與 350 個測試，
> 而收益是「套件名比較合理」。**但這一站會把它記進 ArchUnit 的例外清單**，
> 讓「跨領域依賴」這件事至少是**明確被承認**的，而不是被忽略的。

### 0.11.2 ArchUnit：讓分層規則在 CI 就紅燈

**這一節是本章唯一「一定要照做」的部分。**
0.6.1 那張表如果沒有守門人，三個月後就不成立了。

```xml
<dependency>
    <groupId>com.tngtech.archunit</groupId>
    <artifactId>archunit-junit5</artifactId>
    <version>1.3.0</version>
    <scope>test</scope>
</dependency>
```

```java
package example.shop.architecture;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.library.dependencies.SlicesRuleDefinition;
import org.springframework.transaction.annotation.Transactional;

import java.lang.reflect.Modifier;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.*;
import static com.tngtech.archunit.library.Architectures.layeredArchitecture;

/**
 * 分層架構的守門測試。
 *
 * <p>★★ 它抓的是「三個月後才會顯現」的問題：
 * 一個趕時間的 PR 在 domain 裡注入了一個 Repository，
 * code review 沒看到，於是 domain 測試開始需要 Spring context，
 * 於是測試從 4 秒變成 90 秒，於是沒有人想寫 domain 測試了。
 *
 * <p><b>而這個滑坡的每一步都很小，只有守門測試看得見。</b>
 */
@AnalyzeClasses(
        packages = "example.shop",
        importOptions = ImportOption.DoNotIncludeTests.class)
class LayeredArchitectureTest {

    // ── ① Domain 層零框架依賴 ★★ 最重要的一條 ──────────────

    @ArchTest
    static final ArchRule domain不可依賴Spring =
            noClasses().that().resideInAPackage("..domain..")
                       .should().dependOnClassesThat()
                       .resideInAnyPackage("org.springframework..")
                       .because("Domain 測試不該需要 Spring context（0.6.1）");

    @ArchTest
    static final ArchRule domain不可依賴JPA =
            noClasses().that().resideInAPackage("..domain..")
                       .should().dependOnClassesThat()
                       .resideInAnyPackage("jakarta.persistence..", "org.hibernate..")
                       .because("⚠️ 這條規則在 08 章會被「刻意放寬」——"
                              + "屆時要改成允許 @Entity 但禁止 EntityManager");

    /**
     * ⚠️⚠️ 這條規則有<b>一個真實的例外</b>：{@code OrderStatus} 上的
     * {@code @JsonEnumDefaultValue}（04-controller 6.5.8 —— 讓未知的 enum 值
     * 落到 {@code UNKNOWN} 而不是拋例外）。
     *
     * <p>👉 <b>{@code allowEmptyShould(true)} 不能拿來當例外機制</b> ——
     * 它只是「沒有任何類別符合 that(...) 時不要報錯」，
     * 跟「允許某個類別違反」完全無關。用它會讓這條規則<b>直接紅燈</b>。
     *
     * <p>正確的做法是 {@code ignoreDependency(...)}，把例外<b>寫出來</b>：
     * 例外清單是文件，而「規則綠燈但沒有人知道為什麼」是最糟的狀態。
     */
    @ArchTest
    static final ArchRule domain不可依賴Jackson =
            noClasses().that().resideInAPackage("..domain..")
                       .should().dependOnClassesThat()
                       .resideInAnyPackage("com.fasterxml.jackson..")
                       .ignoreDependency(
                               // ★ 唯一的例外，連理由一起寫在這裡
                               DescribedPredicate.describe("OrderStatus（@JsonEnumDefaultValue）",
                                       (JavaClass c) -> c.getName().endsWith(".OrderStatus")),
                               DescribedPredicate.alwaysTrue())
                       .because("Domain 物件不被序列化 —— 序列化的是 DTO（0.10.3）");

    @ArchTest
    static final ArchRule domain不可碰資料庫或網路 =
            noClasses().that().resideInAPackage("..domain..")
                       .should().dependOnClassesThat()
                       .resideInAnyPackage("java.sql..", "javax.sql..",
                                           "java.net..", "java.nio.channels..");

    // ── ② 依賴方向 ────────────────────────────────────────

    @ArchTest
    static final ArchRule domain不可依賴application或web =
            noClasses().that().resideInAPackage("..domain..")
                       .should().dependOnClassesThat()
                       .resideInAnyPackage("..application..", "..web..", "..infrastructure..")
                       .because("依賴方向必須指向 domain，不可以反向");

    @ArchTest
    static final ArchRule web不可依賴infrastructure =
            noClasses().that().resideInAPackage("..web..")
                       .should().dependOnClassesThat()
                       .resideInAPackage("..infrastructure..")
                       .because("Web 層只認識 application 的介面（04-controller 0.6.3）");

    @ArchTest
    static final ArchRule web不可依賴Repository =
            noClasses().that().resideInAPackage("..web..")
                       .should().dependOnClassesThat()
                       .haveSimpleNameEndingWith("Repository")
                       .because("04-controller 0.6.3 的規則，這裡讓它變成 CI 的一部分");

    // ── ③ @Transactional 只出現在 application ★★ ─────────

    @ArchTest
    static final ArchRule transactional只在application層 =
            classes().that().areAnnotatedWith(Transactional.class)
                     .should().resideInAnyPackage("..application..")
                     .because("交易邊界只能由編排層決定（0.4.1）");

    @ArchTest
    static final ArchRule transactional方法只在application層 =
            methods().that().areAnnotatedWith(Transactional.class)
                     .should().beDeclaredInClassesThat()
                     .resideInAnyPackage("..application..");

    /**
     * ★★ {@code @Transactional} 必須是 public。
     *
     * <p>它抓的是 0.10.7 的 ① —— <b>而那個 bug 是靜默的</b>：
     * 程式碼看起來有交易，實際上完全沒有。
     */
    @ArchTest
    static final ArchRule transactional方法必須是public =
            methods().that().areAnnotatedWith(Transactional.class)
                     .should().bePublic()
                     .because("非 public 方法上的 @Transactional 完全沒有效果（02 章 2.7.2）");

    // ── ④ Domain 不可以呼叫「現在幾點」★ ────────────────────

    /**
     * ⚠️ ArchUnit 沒有內建「禁止呼叫某個靜態方法」的簡潔語法，
     * 所以用 {@code callMethod} 明確列出。
     *
     * <p>👉 更完整的做法是用 {@code ArchCondition} 自訂，
     * 但明確列出這幾個反而比較好讀 —— 它就是一份「不確定性來源」的清單。
     */
    @ArchTest
    static final ArchRule domain不可呼叫now或random =
            noClasses().that().resideInAPackage("..domain..")
                       .should().callMethod(java.time.Instant.class, "now")
                       .orShould().callMethod(java.time.LocalDate.class, "now")
                       .orShould().callMethod(java.time.LocalDateTime.class, "now")
                       .orShould().callMethod(java.time.ZonedDateTime.class, "now")
                       .orShould().callMethod(System.class, "currentTimeMillis")
                       .orShould().callMethod(java.util.UUID.class, "randomUUID")
                       .orShould().callMethod(Math.class, "random")
                       .because("時間與亂數必須從外面傳進來（判準 4），"
                              + "否則規則變成不可測（0.5.2 第 3 點）");

    // ── ⑤ 沒有循環依賴（1.6 會展開）─────────────────────────

    /**
     * ⚠️ 這條規則<b>目前會紅燈</b>，而那是刻意的 —— 它指出兩個真實的循環：
     * <ol>
     *   <li>{@code Actor} 定義在 {@code order.domain}，但 {@code stock}、
     *       {@code coupon} 都用它 → {@code stock → order}
     *       （0.11.1 記錄的妥協）。</li>
     *   <li>{@code Coupon.discountFor} 收 {@code List<OrderLine>}
     *       → {@code coupon → order}，而 {@code order → coupon} 已經存在
     *       （01 章 1.6.6 用 {@code DiscountableLine} 消除它）。</li>
     * </ol>
     *
     * <p>👉 <b>不要用 {@code alwaysFalse()} 的 {@code ignoreDependency} 假裝修好了</b>——
     * 那對兩個參數都傳 {@code alwaysFalse()} 的寫法<b>什麼都不會忽略</b>，
     * 規則照樣紅燈，而且下一個人會以為例外已經處理過了。
     *
     * <p>正確做法二選一：
     * <ul>
     *   <li><b>真的修掉</b>（01 章 1.6.6 對 ② 做的事）。</li>
     *   <li><b>明確列出例外並寫下計畫</b>（下面對 ① 做的事）。</li>
     * </ul>
     */
    @ArchTest
    static final ArchRule 領域之間沒有循環 = SlicesRuleDefinition
            .slices().matching("example.shop.(*)..")
            .should().beFreeOfCycles()
            // ⚠️ 已知例外 ①：Actor 應該搬到 common.domain（0.11.1）。
            //    ⚠️ 這是「明確承認」不是「修好」—— 排入 2026 Q3。
            .ignoreDependency(
                    DescribedPredicate.describe("非 order 領域",
                            (JavaClass c) -> !c.getPackageName().startsWith("example.shop.order")),
                    DescribedPredicate.describe("order.domain.Actor",
                            (JavaClass c) -> c.getName().endsWith("order.domain.Actor")
                                          || c.getName().contains("order.domain.Actor$")));

    // ── ⑥ 整體分層 ───────────────────────────────────────

    @ArchTest
    static final ArchRule 分層架構 = layeredArchitecture().consideringAllDependencies()
            .layer("Web").definedBy("..web..")
            .layer("Application").definedBy("..application..")
            .layer("Domain").definedBy("..domain..")
            .layer("Infrastructure").definedBy("..infrastructure..")

            .whereLayer("Web").mayNotBeAccessedByAnyLayer()
            .whereLayer("Application").mayOnlyBeAccessedByLayers("Web", "Infrastructure")
            .whereLayer("Domain").mayOnlyBeAccessedByLayers(
                    "Web", "Application", "Infrastructure")
            .whereLayer("Infrastructure").mayNotBeAccessedByAnyLayer();
}
```

⚠️ **`whereLayer("Domain").mayOnlyBeAccessedByLayers("Web", ...)` 裡有 Web，
這看起來違反了「Web 不該碰 Domain」。**

**它是刻意的**：04-controller 站的 `OrderWebMapper` 就是把 `Order` 轉成 DTO 的地方，
所以 Web 層**必須**認識 `Order`。
**真正的規則是「Web 層可以讀 Domain，但不可以改它」** ——
而 `Order` 沒有 public setter，所以那件事在型別上已經不可能。

> 📌 **這是 ArchUnit 規則設計的一般原則**：
> 規則要反映**真實的設計意圖**，而不是教科書的理想。
> 一條「必須靠 30 個例外才能通過」的規則，會在第 31 個例外時被整條刪掉。

⚠️ **`domain不可依賴JPA` 那條的 `because` 值得特別注意** ——
它明確寫下「這條規則在 08 章會被放寬」。

> **一條會被改的規則，要在規則裡寫下它會怎麼被改。**
> 否則 08 章的人會直接刪掉它（而不是放寬它），
> 於是「domain 不可以注入 `EntityManager`」這個仍然有效的部分一起消失。

### 0.11.3 `application.yml`（Service 層相關）

```yaml
spring:
  # ── 交易 ───────────────────────────────────────────────
  transaction:
    # ⚠️ 預設是 -1（無限）。設一個上限讓「忘記關的交易」會失敗而不是永遠佔著連線
    default-timeout: 10s
    rollback-on-commit-failure: true

  # ── 資料源與連線池（06 站會完整展開）───────────────────
  datasource:
    hikari:
      maximum-pool-size: 20
      # ★ 「向池子要一條連線」最多等多久。⚠️ 它與「交易多長」無關 ——
      #   短一點反而好：池子被榨乾時要<b>快速失敗</b>並回 503，
      #   而不是讓 200 個請求一起排隊到 Tomcat 執行緒也用完（0.3.2 事故 1 的第二段）
      connection-timeout: 3000
      # ⚠️ HikariCP 要求 validation-timeout < connection-timeout，否則啟動時被改寫
      validation-timeout: 1000
      # ★★ 超過這個時間沒歸還就印 stack trace。
      #   它必須「大於最長的正常交易」但「小於明顯不正常的時間」——
      #   我們的 default-timeout 是 10s，所以設 15s：
      #   正常交易永遠不會觸發，而卡住的交易 15 秒後就有 stack trace 可看
      leak-detection-threshold: 15000

  # ── 循環依賴（1.6.2）───────────────────────────────────
  main:
    allow-circular-references: false     # ★ Boot 2.6+ 的預設值，明確寫出來

  # ── JPA（08 站，這裡先關掉 open-in-view）────────────────
  jpa:
    # ★★ 一定要 false。true（預設！）會讓 Session 開到 view render 結束
    #    → 0.10.3 的 Lazy 例外被「隱藏」起來，然後在別的地方以連線洩漏的形式爆發
    open-in-view: false

# ── 執行緒池（06 章）────────────────────────────────────
shop:
  async:
    notification:
      core-size: 4
      max-size: 8
      queue-capacity: 500
      # ★ 佇列滿時的策略。CALLER_RUNS 會讓「發事件的那個交易」變慢 —— 刻意的：
      #   它讓壓力可見，而不是靜默丟棄通知
      rejection-policy: CALLER_RUNS
    integration:
      core-size: 2
      max-size: 4
      queue-capacity: 200
      rejection-policy: ABORT           # ★ ERP 推送用 outbox 補，可以拒絕

  order:
    payment-window: 30m                 # ⚠️ 與 Order.PAYMENT_WINDOW 重複 —— 見下方
    self-cancel-window: 7d

logging:
  level:
    # ★ 查交易問題時打開這兩個 —— 02 章 2.4.4 會示範怎麼讀它們的輸出
    org.springframework.transaction.interceptor: TRACE
    org.springframework.orm.jpa.JpaTransactionManager: DEBUG
```

⚠️ **`shop.order.payment-window` 與 `Order.PAYMENT_WINDOW` 重複了。**

**這是一個要刻意決定的事，兩種做法都對**：

| 做法 | 適用 |
|---|---|
| **寫死在 Domain**（現在的做法） | 它是**業務規則**，改它要改程式碼、要經過 review、要有測試 |
| 放設定檔並注入 | 它是**組態**，不同環境／不同租戶要不一樣 |

**shop-service 選前者**，並把 yaml 裡那兩行**刪掉**（留著只會有兩個真相）。

> 📌 **判準**：
> **「改這個值需要重新測試業務邏輯嗎？」**
> 需要 → 它是規則，放程式碼。
> 不需要（例如連線池大小） → 它是組態，放設定檔。

---
## 0.12 支援型別：前面用到但還沒定義的東西

**這一節補上 0.9 出現過、但還沒給出定義的型別。**
它們會被 01～07 章一路用下去，所以放在這裡而不是散在各節。

⚠️ 跨層重構最常見的缺口是：**「被 `new` 出來但沒有定義的型別」
與「被呼叫但不存在的方法」是最容易累積的錯誤**。
這一站從第一章就把它們集中定義。

**① `OrderLine` 與 `PricedLine`：訂單明細的兩個形狀**

```java
package example.shop.order.domain;

import example.shop.common.money.Money;

/**
 * ★ 「已定價的一筆明細」—— Application Service 算完價之後交給 Domain 的東西。
 *
 * <p>⚠️ 它與 {@link OrderLine} 的差別只有一個：
 * <b>{@code PricedLine} 是輸入，{@code OrderLine} 是已成為訂單一部分的狀態。</b>
 *
 * <p>為什麼要分成兩個 record 而不共用一個？
 * <ul>
 *   <li>{@code OrderLine} 之後會加欄位（出貨數量、退貨數量），
 *       而那些欄位在「下單的輸入」上是沒有意義的。</li>
 *   <li>★ 更重要的：{@code Order.place()} 的簽章收 {@code PricedLine}，
 *       就<b>在型別上宣告了「價格必須由外面算好」</b>——
 *       而那正好呼應 04-controller 1.12.5 的
 *       「{@code CreateOrderCommand.Line} 上刻意沒有價格欄位」。
 *       <b>兩個決定合起來，「客戶端送價格」這個漏洞在型別上不可能存在。</b></li>
 * </ul>
 */
public record PricedLine(
    String productId,
    String productName,      // ★ 快照 —— 商品改名不影響歷史訂單
    String sku,              // ★ 快照
    Money unitPrice,         // ★ 由 PricingPolicy 算出，不是客戶端送的
    int quantity
) {
    public PricedLine {
        if (quantity <= 0) throw new IllegalArgumentException("quantity 必須為正");
        if (unitPrice.isNegative()) throw new IllegalArgumentException("unitPrice 不可為負");
    }

    public Money lineTotal() {
        return unitPrice.times(quantity);
    }
}
```

```java
package example.shop.order.domain;

import example.shop.common.money.Money;

/**
 * 訂單明細（訂單的一部分）。
 *
 * <p>★★ 它是<b>不可變</b>的。「修改明細數量」是
 * 「移除舊的 + 加入新的」而不是「改一個欄位」——
 * 因為那樣才能留下稽核軌跡（哪一筆被改了、改成什麼）。
 */
public record OrderLine(
    String productId,
    String productName,
    String sku,
    Money unitPrice,
    int quantity
) {
    static OrderLine from(PricedLine priced) {
        return new OrderLine(priced.productId(), priced.productName(),
                             priced.sku(), priced.unitPrice(), priced.quantity());
    }

    public Money lineTotal() {
        return unitPrice.times(quantity);
    }
}
```

**② `OrderNumber`：給人看的訂單編號**

```java
package example.shop.order.domain;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.regex.Pattern;

/**
 * 訂單編號，格式 {@code ORD-yyyyMMdd-NNNN}。
 *
 * <p>★★ 為什麼它是一個值物件而不是 {@code String}：
 * <ol>
 *   <li><b>格式在型別裡被保證</b> —— 不可能有 {@code "ord_123"} 這種東西進到系統。</li>
 *   <li><b>它與 {@code id} 是兩個不同的概念</b> ——
 *       {@code id} 是 ULID（技術主鍵，永不對外顯示於單據），
 *       {@code orderNumber} 是給客服電話唸的。<b>把兩者都做成 {@code String}
 *       就是在等一個「傳錯參數」的 bug</b>（而它編譯得過）。</li>
 *   <li>可以掛上「同一天的編號要連續」這種規則的驗證。</li>
 * </ol>
 *
 * <p>⚠️ 產生它需要「當天的序號」→ 那是 I/O → 所以有一個
 * {@link OrderNumberGenerator} 埠，而不是在這裡 {@code static} 產生。
 */
public record OrderNumber(String value) {

    private static final Pattern FORMAT = Pattern.compile("ORD-\\d{8}-\\d{4,}");
    private static final DateTimeFormatter DATE_PART =
            DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneId.of("Asia/Taipei"));

    public OrderNumber {
        if (value == null || !FORMAT.matcher(value).matches()) {
            throw new IllegalArgumentException("訂單編號格式錯誤：" + value);
        }
    }

    /** ★ 供 {@link OrderNumberGenerator} 的實作使用。 */
    public static OrderNumber of(Instant date, int sequence) {
        return new OrderNumber("ORD-%s-%04d".formatted(DATE_PART.format(date), sequence));
    }

    @Override public String toString() { return value; }
}
```

⚠️ **`DATE_PART` 寫死 `Asia/Taipei` 是刻意的。**
訂單編號的日期是「營業日」，而營業日的定義是業務決定的，
不是「伺服器所在時區」也不是「使用者的時區」。
用 `ZoneId.systemDefault()` 會讓同一張訂單在不同機器上算出不同編號。

> 📌 04-controller 6.5.6 講「時間對外序列化用 `Instant`（UTC）」。
> **這裡是同一個問題的另一面**：
> **「顯示 / 分組用的日期」必須明確指定時區，而且那個時區是業務決定。**

**③ 取消相關：`Cancellation`、`CancelReason`、`CancellationResult`**

```java
package example.shop.order.domain;

import java.time.Instant;

/**
 * 取消資訊（不變量 I6）。
 *
 * <p>★ 把「取消原因、時間、取消者」收成一個值物件而不是三個欄位，
 * 是為了讓「已取消但沒有取消資訊」這個狀態<b>難以出現</b>：
 * {@code cancellation == null} 是一個判斷，
 * 而「三個欄位有兩個是 null」是八種組合。
 */
// ⚠️⚠️ 03 章 3.10.3 ④ 會把 note 拆成 customerNote + staffNote ——
//    因為「同一個欄位，客戶取消時是客戶填的、客服取消時是客服填的」，
//    於是客戶查自己的訂單會看到客服的評語（03 章 3.7.3）。
//    📌 只要一個欄位的意思取決於誰在看，它就遲早會洩漏。
public record Cancellation(Actor cancelledBy, CancelReason reason, String note, Instant at) {

    public Cancellation {
        java.util.Objects.requireNonNull(cancelledBy, "cancelledBy");
        java.util.Objects.requireNonNull(reason, "reason");
        java.util.Objects.requireNonNull(at, "at");
    }
}
```

```java
package example.shop.order.domain;

import example.shop.common.web.LabeledEnum;

/**
 * 取消原因。
 *
 * <p>⚠️ 04-controller 1.12.5 的 {@code CancelOrderCommand.CancelReason} 是<b>同一個概念</b>，
 * 而它定義在 {@code order.service.command} 套件裡。
 *
 * <p>★★ 這一站把它<b>搬到 {@code order.domain}</b>，理由：
 * <ul>
 *   <li>它是領域概念（會進報表、會影響退款規則），不是「命令的一部分」。</li>
 *   <li>{@code Cancellation} 值物件需要它，而 domain 不可以依賴 command 套件。</li>
 * </ul>
 * <p>👉 這是 0.14.2 記錄的搬遷之一。
 *
 * <p>⚠️ 這一站<b>新增了 {@code PAYMENT_TIMEOUT}</b>（0.7 判準 5 的排程用），
 * 而新增 enum 值對客戶端不是破壞性變更 —— 前提是它實作了
 * {@link LabeledEnum}（04-controller 6.5.8）。
 */
public enum CancelReason implements LabeledEnum {
    CHANGED_MIND, FOUND_CHEAPER, SHIPPING_TOO_SLOW, SHIPPING_FEE_TOO_HIGH,
    WRONG_ITEM, DUPLICATE_ORDER, PAYMENT_ISSUE,
    /** ★ 本站新增：30 分鐘未付款，由排程取消。 */
    PAYMENT_TIMEOUT,
    OTHER;

    /** ★ 只有這些原因是「客戶自己選的」—— API 的 enum 白名單。 */
    public boolean isCustomerSelectable() {
        return this != PAYMENT_TIMEOUT;
    }

    @Override public String labelKey() { return "cancelReason." + name(); }
}
```

```java
package example.shop.order.domain.result;

import example.shop.common.money.Money;
import java.util.List;

/**
 * 取消的「後果」。
 *
 * <p>★★ 這個 record 是本章最重要的設計技巧的載體：
 * <b>Domain 不執行副作用，它回傳「需要執行什麼」。</b>
 *
 * <p>三個好處：
 * <ol>
 *   <li>{@code Order.cancel()} 保持純粹（不需要注入 Repository）。</li>
 *   <li>「需不需要退款」這個判斷在改狀態<b>之前</b>算完
 *       —— 0.5.1 那個 bug 在型別上不可能重演。</li>
 *   <li>Application Service 讀起來像一份清單，而不是一堆 {@code if}。</li>
 * </ol>
 */
public record CancellationResult(
    String orderId,
    boolean refundRequired,
    Money refundAmount,
    List<StockRelease> stockReleases
) {
    public CancellationResult {
        stockReleases = List.copyOf(stockReleases);
    }
}
```

```java
package example.shop.order.domain.result;

/** 要還回去的庫存。 */
public record StockRelease(String productId, int quantity) {
    public StockRelease {
        if (quantity <= 0) throw new IllegalArgumentException("quantity 必須為正");
    }
}
```

**④ 付款相關：`Payment`、`Refund`、`PaymentResult`、`PaymentMethod`**

```java
package example.shop.order.domain;

import example.shop.common.money.Money;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 一筆付款。
 *
 * <p>⚠️ {@link Status#ORPHANED} 是一個真實而且很重要的狀態：
 * <b>「錢收到了，但訂單已經取消或已逾期」</b>（{@code Order.markPaid} 的兩個分支）。
 *
 * <p>如果沒有這個狀態，程式只有兩個選擇：
 * <ul>
 *   <li>拋例外 → 金流商收到 4xx/5xx → 它會重送 → 一直失敗 →
 *       <b>而錢已經在我們帳上了，沒有任何紀錄</b>。</li>
 *   <li>靜默忽略 → 同樣沒有紀錄。</li>
 * </ul>
 * <p>👉 <b>「不知道怎麼處理」的正確做法是「先記下來」</b>，
 *    而不是「拋例外」或「忽略」。
 */
public class Payment {

    public enum Status { SUCCEEDED, FAILED, ORPHANED }

    private final String id;
    private final Money amount;
    private final PaymentMethod method;
    private final Instant paidAt;
    private final Status status;
    private final List<Refund> refunds = new ArrayList<>();

    private Payment(String id, Money amount, PaymentMethod method,
                    Instant paidAt, Status status) {
        this.id = java.util.Objects.requireNonNull(id, "id");
        this.amount = java.util.Objects.requireNonNull(amount, "amount");
        this.method = method;
        this.paidAt = paidAt;
        this.status = status;
    }

    public static Payment succeeded(String id, Money amount, PaymentMethod m, Instant at) {
        return new Payment(id, amount, m, at, Status.SUCCEEDED);
    }

    public static Payment failed(String id, Money amount, PaymentMethod m, Instant at) {
        return new Payment(id, amount, m, at, Status.FAILED);
    }

    /** ★ 「錢收了但訂單不接受」—— 需要後續退款。 */
    public static Payment orphaned(String id, Money amount, PaymentMethod m, Instant at) {
        return new Payment(id, amount, m, at, Status.ORPHANED);
    }

    /**
     * 記錄一筆退款。
     *
     * <p>★ 不變量 I8 在這裡守第一道 —— {@code Order.assertInvariants()} 守第二道，
     * 資料庫的 {@code CHECK} 守第三道。
     */
    public void refund(Refund refund) {
        Money already = refundedAmount();
        if (already.plus(refund.amount()).compareTo(amount) > 0) {
            throw new RefundExceedsPaymentException(id, amount, already, refund.amount());
        }
        refunds.add(refund);
    }

    public Money refundedAmount() {
        return refunds.stream().map(Refund::amount)
                      .reduce(Money.zero(amount.currency()), Money::plus);
    }

    public boolean isSucceeded()  { return status == Status.SUCCEEDED; }
    public boolean isOrphaned()   { return status == Status.ORPHANED; }

    public String id()                { return id; }
    public Money amount()             { return amount; }
    public PaymentMethod method()     { return method; }
    public Instant paidAt()           { return paidAt; }
    public Status status()            { return status; }
    public List<Refund> refunds()     { return List.copyOf(refunds); }   // ★ 防禦性複製
}
```

```java
package example.shop.order.domain;

import example.shop.common.money.Money;
import java.time.Instant;

/** 一筆退款。 */
public record Refund(String id, Money amount, RefundReason reason,
                     Actor requestedBy, Instant at) {}
```

```java
package example.shop.order.domain;

import example.shop.common.web.LabeledEnum;

public enum RefundReason implements LabeledEnum {
    ORDER_CANCELLED, RETURN_ACCEPTED, PRICE_ADJUSTMENT, ORPHANED_PAYMENT, GOODWILL;

    @Override public String labelKey() { return "refundReason." + name(); }
}
```

```java
package example.shop.order.domain;

import example.shop.common.web.LabeledEnum;

/** ⚠️ 與 04-controller 1.12.3 的多型付款 body 的 {@code type} 對應。 */
public enum PaymentMethod implements LabeledEnum {
    CREDIT_CARD, BANK_TRANSFER, CONVENIENCE_STORE, LINE_PAY, APPLE_PAY;

    @Override public String labelKey() { return "paymentMethod." + name(); }
}
```

```java
package example.shop.order.domain.result;

import example.shop.order.domain.Payment;

/**
 * {@code Order.markPaid()} 的結果。
 *
 * <p>★★ 為什麼要有這個型別而不是 {@code void} 或 {@code boolean}：
 * 因為呼叫端（金流回呼的 Application Service）需要知道**三種不同的後續**：
 *
 * <table>
 *   <tr><th>{@link Kind}</th><th>Application Service 要做什麼</th></tr>
 *   <tr><td>{@code PAID}</td><td>發 {@code OrderPaidEvent} → 通知客戶、通知倉庫</td></tr>
 *   <tr><td>{@code ALREADY_PROCESSED}</td><td><b>什麼都不做</b>，回 200 給金流商</td></tr>
 *   <tr><td>{@code NEEDS_REFUND}</td><td>建立退款、<b>發告警</b>（這是異常但不是錯誤）</td></tr>
 * </table>
 *
 * <p>⚠️ 三種都要回 <b>200</b> 給金流商 —— 回 4xx 會讓對方重送，
 * 而重送不會改變結果（06 章 6.8 的 webhook 原則）。
 */
public record PaymentResult(Kind kind, Payment payment) {

    public enum Kind { PAID, ALREADY_PROCESSED, NEEDS_REFUND }

    public static PaymentResult paid(Payment p)             { return new PaymentResult(Kind.PAID, p); }
    public static PaymentResult alreadyProcessed(Payment p)  { return new PaymentResult(Kind.ALREADY_PROCESSED, p); }
    public static PaymentResult needsRefund(Payment p)       { return new PaymentResult(Kind.NEEDS_REFUND, p); }

    public boolean isNewPayment() { return kind == Kind.PAID; }
}
```

**⑤ 出貨相關：`Shipment`、`ShipmentLine`、`Carrier`**

```java
package example.shop.order.domain;

import java.time.Instant;
import java.util.List;

public record Shipment(List<ShipmentLine> lines, String trackingNumber,
                       Carrier carrier, Instant shippedAt) {
    public Shipment {
        lines = List.copyOf(lines);
        if (lines.isEmpty()) throw new IllegalArgumentException("出貨明細不可為空");
    }
}
```

```java
package example.shop.order.domain;

public record ShipmentLine(String productId, int quantity) {
    public ShipmentLine {
        if (quantity <= 0) throw new IllegalArgumentException("quantity 必須為正");
    }
}
```

```java
package example.shop.order.domain;

import example.shop.common.web.LabeledEnum;

public enum Carrier implements LabeledEnum {
    BLACK_CAT, HSINCHU, POST_OFFICE, SEVEN_ELEVEN, FAMILY_MART, SELF_PICKUP;

    @Override public String labelKey() { return "carrier." + name(); }
}
```

**⑥ `OrderAction`：04-controller `allowedActions` 的型別**

```java
package example.shop.order.domain;

import example.shop.common.web.LabeledEnum;

/**
 * 客戶端在當前狀態下可以做的操作。
 *
 * <p>⚠️ 04-controller 0.10.3 的 mapper 寫的是
 * {@code order.allowedActions().stream().map(Enum::name).toList()} ——
 * 所以它<b>已經</b>假設這是一個 enum。這裡把它定義出來。
 *
 * <p>★★ 而 0.14.1 修正了那一行：它現在需要 {@code (actor, now)} 兩個參數，
 * 因為「客戶能不能取消」取決於角色與時間（0.9.2 的 {@code canBeCancelledBy}）。
 */
public enum OrderAction implements LabeledEnum {
    PAY, CANCEL, CHANGE_ADDRESS, REQUEST_RETURN, SHIP, DOWNLOAD_INVOICE;

    @Override public String labelKey() { return "orderAction." + name(); }
}
```

**⑦ 商品與定價：`Product`、`CustomerLevel`、`PricingPolicy`**

```java
package example.shop.product.domain;

import example.shop.common.money.Money;
import example.shop.product.domain.exception.*;

import java.time.Instant;

/**
 * 商品（輕度充血 —— 0.6.3 的判斷）。
 *
 * <p>★ 它只有三條規則，但那三條都很重要：上架狀態、可購買性、促銷價的有效期。
 */
public record Product(
    String id,
    String sku,
    String name,
    Money price,
    Money promotionPrice,          // 可為 null
    Instant promotionEndAt,        // 可為 null
    Status status,
    int purchaseLimitPerOrder,     // 0 = 無限制
    /** ★ 商品分類 —— 生鮮不可退貨（0.16 練習 2 的 R7）。 */
    Category category
) {
    public enum Status { DRAFT, ON_SALE, OFF_SHELF, DISCONTINUED }

    public enum Category { GENERAL, FRESH_FOOD, PERSONAL_CARE, DIGITAL_CONTENT, CUSTOM_MADE }

    /**
     * ★ 這個商品可不可以退貨。
     *
     * <p>⚠️ 用 {@code EnumSet} 的白名單而不是 {@code category != FRESH_FOOD}：
     * <b>新增一個分類時，預設應該是「不可退」還是「可退」？</b>
     * 黑名單的預設是「可退」—— 於是新增「客製化商品」時
     * 沒有人記得把它加進黑名單，客戶就退得成。
     *
     * <p>👉 <b>安全性相關的判斷一律用白名單</b>（04-controller 2.4 的排序白名單同一個道理）。
     */
    public boolean isReturnable() {
        return RETURNABLE_CATEGORIES.contains(category);
    }

    private static final java.util.EnumSet<Category> RETURNABLE_CATEGORIES =
            java.util.EnumSet.of(Category.GENERAL, Category.PERSONAL_CARE);

    /**
     * ★★ 「這個商品現在能不能買」。
     *
     * <p>不回傳 {@code boolean} 而是<b>拋例外</b>，因為呼叫端
     * （{@code OrderApplicationService} 的第 ⑤ 步）需要的是
     * 「不能買的話告訴使用者為什麼」——
     * 而三種原因對應三個不同的 {@code ErrorCode}：
     *
     * <table>
     *   <tr><th>狀態</th><th>例外</th><th>ErrorCode / HTTP</th></tr>
     *   <tr><td>{@code DISCONTINUED}</td><td>{@code ProductDiscontinuedException}</td>
     *       <td>{@code PRODUCT_DISCONTINUED} / <b>410 Gone</b></td></tr>
     *   <tr><td>{@code OFF_SHELF}、{@code DRAFT}</td>
     *       <td>{@code ProductNotPurchasableException}</td>
     *       <td>{@code PRODUCT_NOT_PURCHASABLE} / 422</td></tr>
     * </table>
     *
     * <p>⚠️ 410 與 422 的差別對客戶端很重要：410 代表「永遠不會再有」
     * （前端該把它從收藏移除），422 代表「現在不行」（可以顯示「補貨通知我」）。
     */
    public void requirePurchasable(Instant now) {
        switch (status) {
            case DISCONTINUED -> throw new ProductDiscontinuedException(id, name);
            case OFF_SHELF, DRAFT -> throw new ProductNotPurchasableException(id, name, status);
            case ON_SALE -> { /* ok */ }
        }
    }

    /** ★ 促銷價是否在有效期內（純函式，now 是參數 —— 判準 4）。 */
    public boolean hasActivePromotion(Instant now) {
        return promotionPrice != null
                && promotionEndAt != null
                && now.isBefore(promotionEndAt);
    }
}
```

```java
package example.shop.customer.domain;

import example.shop.common.web.LabeledEnum;
import java.math.BigDecimal;

public enum CustomerLevel implements LabeledEnum {
    NORMAL(BigDecimal.ONE),
    SILVER(new BigDecimal("0.98")),
    GOLD(new BigDecimal("0.95")),
    VIP(new BigDecimal("0.92"));

    private final BigDecimal discountRate;

    CustomerLevel(BigDecimal discountRate) { this.discountRate = discountRate; }

    /** ★ 折扣率放在 enum 上而不是 if-else 鏈（0.3 那段程式碼的問題之一）。 */
    public BigDecimal discountRate() { return discountRate; }

    @Override public String labelKey() { return "customerLevel." + name(); }
}
```

```java
package example.shop.order.domain;

import example.shop.common.money.Money;
import example.shop.customer.domain.CustomerLevel;
import example.shop.product.domain.Product;

import java.time.Instant;

/**
 * 定價策略。
 *
 * <p>⚠️ 它是介面而不是 {@code Product} 上的方法，因為
 * 「會員折扣要不要疊促銷價」這種規則<b>會變</b>，
 * 而變的時候不該去改 {@code Product}（0.7 判準 7）。
 */
public interface PricingPolicy {
    Money priceOf(Product product, CustomerLevel level, Instant now);
}
```

```java
package example.shop.order.domain;

import example.shop.common.money.Money;
import example.shop.customer.domain.CustomerLevel;
import example.shop.product.domain.Product;

import java.time.Instant;

/**
 * 預設定價：促銷價優先，促銷價<b>不再</b>疊會員折扣。
 *
 * <p>★★ 這一行註解就是 0.3 那段程式碼最大的 bug：
 * 它先算會員價再用促銷價覆蓋，所以
 * <b>「促銷價比會員價貴」時 VIP 會被漲價</b>。
 *
 * <p>⚠️ 而「促銷價要不要疊會員折扣」是一個<b>業務決定</b>，
 * 不是技術細節。它必須被寫在一個有名字的地方，並且有測試。
 */
public class DefaultPricingPolicy implements PricingPolicy {

    @Override
    public Money priceOf(Product product, CustomerLevel level, Instant now) {
        if (product.hasActivePromotion(now)) {
            // ★ 促銷價已經是最終價，不疊會員折扣
            return product.promotionPrice();
        }
        Money memberPrice = product.price().times(level.discountRate());
        // ★★ 保險：會員價不可能比原價貴（防 discountRate 被設錯）
        return memberPrice.isLessThan(product.price()) ? memberPrice : product.price();
    }
}
```

```java
// 對應的測試 —— 它把「促銷 vs 會員」這個決定釘住
@ParameterizedTest
@CsvSource({
    // 原價, 促銷價, 促銷中?, 等級,   期望價,  說明
    " 1000,       ,  false,  VIP,      920, 無促銷 → VIP 92 折",
    " 1000,    900,   true,  VIP,      900, ★ 促銷中 → 用促銷價，不疊 92 折（920 > 900）",
    " 1000,    950,   true,  VIP,      950, ★★ 促銷價比 VIP 價貴，仍然用促銷價 —— 這是決定",
    " 1000,    900,  false,  VIP,      920, 促銷已過期 → 回到 VIP 價",
    " 1000,       ,  false, NORMAL,   1000, 一般會員無折扣",
    "   33,       ,  false,  VIP,    30.36, ★ 33 × 0.92 = 30.36，Money 保證兩位小數",
})
void 定價策略(String price, String promo, boolean promoActive,
             CustomerLevel level, String expected, String description) { /* … */ }
```

⚠️ **第 3 列是這組測試存在的理由。**
「促銷價比會員價貴時要用哪一個」沒有標準答案 ——
但**它必須是一個被寫下來的決定**。
沒有這一列，下一個工程師會「順手修正」成「取兩者較低」，
而那會讓行銷部門精心設計的促銷失效。

**⑧ 地址：`ShippingAddress`、`Address`、`ShippingSnapshot`**

```java
package example.shop.order.domain;

/**
 * 收件地址（客戶的地址簿裡的一筆）。
 *
 * <p>⚠️ 它有 {@code customerId} —— 而 {@code OrderApplicationService}
 * 用 {@code findByIdAndCustomerId} 查它，所以「這個地址是不是這個客戶的」
 * 在<b>查詢條件</b>裡就決定了（0.9.4 的第 ② 步）。
 */
public record ShippingAddress(
    String id,
    String customerId,
    String recipientName,
    String phone,
    String postalCode,
    String city,
    String district,
    String street
) implements Address {}
```

```java
package example.shop.order.domain;

/**
 * ★ 「有郵遞區號與縣市」的最小介面。
 *
 * <p>{@link ShippingFeePolicy} 只需要這些，所以它收 {@code Address} 而不是
 * {@code ShippingAddress} —— 於是<b>購物車的試算</b>（還沒有地址簿 ID 時）
 * 也可以呼叫同一個 policy（0.7.1 那段 javadoc 的理由 ②）。
 */
public interface Address {
    String postalCode();
    String city();
    String district();
}
```

```java
package example.shop.order.domain;

/**
 * 下單時的地址快照。
 *
 * <p>★★ 為什麼要快照而不是存 {@code shippingAddressId}：
 * 客戶改了地址簿裡的那一筆之後，<b>三個月前那張訂單的收件地址不可以跟著變</b>。
 * 否則「這張訂單當時寄到哪裡」永遠查不到，客訴無法處理。
 *
 * <p>⚠️ {@code Order} 同時存了 {@code shippingAddressId} 與快照：
 * 前者給「重新下單」用（要對應到現在的地址簿），
 * 後者給「當時寄到哪」用。<b>兩者都需要，而它們會分岔 —— 那是正確的。</b>
 */
public record ShippingSnapshot(
    String recipientName, String phone, String postalCode,
    String city, String district, String street
) implements Address {

    static ShippingSnapshot of(ShippingAddress a) {
        return new ShippingSnapshot(a.recipientName(), a.phone(), a.postalCode(),
                                    a.city(), a.district(), a.street());
    }
}
```

**⑨ 優惠券：`Coupon`、`AppliedCoupon`**

```java
package example.shop.coupon.domain;

import example.shop.common.money.Money;
import example.shop.coupon.domain.exception.*;
import example.shop.order.domain.OrderLine;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Set;

/**
 * 優惠券（充血 —— 它有 5 條規則）。
 *
 * <p>⚠️⚠️ <b>注意這個類別「沒有」{@code usedCount} 的檢查方法。</b>
 *
 * <p>0.7.2 第 7 題已經解釋過：那條規則<b>不能</b>在 Java 裡守，
 * 它必須是 {@code CouponRepository.tryConsume()} 的原子 SQL
 * 加上資料庫的 {@code CHECK (used_count <= total_count)}。
 *
 * <p>★ 把「守不住的檢查」<b>從 Domain 移除</b>，
 * 比「留著它但在旁邊寫註解說它不可靠」更好 ——
 * 因為留著它，下一個人會以為它有用。
 */
public record Coupon(
    String code,
    String name,
    Type type,
    BigDecimal value,             // FIXED → 金額；PERCENTAGE → 百分比（10 = 10%）
    Money minAmount,              // 最低消費，可為 null
    Money maxDiscount,            // 折扣上限（百分比券用），可為 null
    Instant startAt,
    Instant endAt,
    Set<String> applicableProductIds,  // 空 = 全站適用
    /**
     * ★ 同一個客戶最多能用幾次。
     *
     * <p>⚠️ 與 {@code totalCount}（全站總量）是<b>兩條不同的規則</b>，
     * 而且守法也不同：全站總量靠 {@code coupon.used_count} 的原子 UPDATE，
     * 每人次數靠 {@code coupon_usage} 表的主鍵 + 計數
     * （01 章練習 2 的步驟 2）。
     */
    int maxPerCustomer
) {
    public enum Type { FIXED, PERCENTAGE }

    /**
     * ★★ 「這張券用在這筆訂單上，折多少」。
     *
     * <p>不適用時<b>拋例外而不是回 0</b>——
     * 因為使用者<b>明確送了券號</b>，靜默地折 0 元是
     * 04-controller 4.2.3「靜默篩選」的同一種災難：
     * 使用者以為套用了，看到金額不對，卻沒有任何訊息。
     *
     * @throws CouponNotStartedException     還沒開始
     * @throws CouponExpiredException        已過期
     * @throws CouponMinAmountNotMetException 未達最低消費
     * @throws CouponNotApplicableException  沒有適用的商品
     */
    public Money discountFor(Money subtotal, List<OrderLine> lines, Instant now) {
        // ⚠️ 參數型別 List<OrderLine> 讓 coupon.domain 依賴 order.domain，
        //    而 order.application 已經依賴 coupon.domain → 套件層的循環。
        //    👉 01 章 1.6.6 會把它換成
        //       List<? extends DiscountableLine>（coupon 自己定義的最小介面）。

        if (now.isBefore(startAt))  throw new CouponNotStartedException(code, startAt);
        if (!now.isBefore(endAt))   throw new CouponExpiredException(code, endAt);

        // ★ 適用商品的小計（全站券 = 全部）
        Money applicableSubtotal = applicableProductIds.isEmpty()
                ? subtotal
                : lines.stream()
                       .filter(l -> applicableProductIds.contains(l.productId()))
                       .map(OrderLine::lineTotal)
                       .reduce(Money.zero(subtotal.currency()), Money::plus);

        if (applicableSubtotal.isZero()) {
            throw new CouponNotApplicableException(code, applicableProductIds);
        }
        if (minAmount != null && applicableSubtotal.isLessThan(minAmount)) {
            throw new CouponMinAmountNotMetException(code, minAmount, applicableSubtotal);
        }

        Money discount = switch (type) {
            case FIXED -> new Money(value, subtotal.currency());
            case PERCENTAGE -> applicableSubtotal.times(
                    value.divide(new BigDecimal("100"), 4, java.math.RoundingMode.HALF_UP));
        };

        // ★ 折扣上限
        if (maxDiscount != null && discount.compareTo(maxDiscount) > 0) {
            discount = maxDiscount;
        }
        // ★★ 折扣不可超過適用小計（否則 Order 的 I3 會被破壞 → 500 而不是 422）
        return discount.compareTo(applicableSubtotal) > 0 ? applicableSubtotal : discount;
    }
}
```

⚠️ **最後那一行 `return discount.compareTo(...) > 0 ? applicableSubtotal : discount;`
是一個真實的坑。**

如果沒有它，一張「折 500 元」的固定券用在 300 元的訂單上，
`total()` 會是負數 → `Order.assertInvariants()` 拋 `IllegalStateException` → **500**。

**而使用者看到 500 是錯的** —— 他做的事沒有錯，
只是「折扣不能超過訂單金額」這個常識沒有被寫下來。

> 📌 **一般規則**：
> **Domain 的不變量斷言（→500）只該抓「不可能發生的事」。
> 如果一個使用者的正常操作可以觸發它，那代表某條業務規則漏了。**

```java
package example.shop.order.domain;

import example.shop.common.money.Money;

/** 訂單上已套用的券（快照 —— 券的內容之後可能改，訂單的折扣不能改）。 */
public record AppliedCoupon(String code, String name, Money discount) {}
```

**⑩ 埠（介面）：本站用到的全部**

```java
package example.shop.order.application.port;

import example.shop.order.domain.Order;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 訂單的持久化埠。
 *
 * <p>⚠️ 它<b>不是</b> Spring Data 的 {@code Repository}。
 * 06 站會討論兩者的關係；這一站它是一個手寫的介面，
 * 實作是記憶體假的（{@code InMemoryOrderRepository}）。
 *
 * <p>★★ 注意方法的形狀：它們是<b>「以領域的語言問問題」</b>，
 * 而不是「以 SQL 的語言」。
 * {@code findByIdVisibleTo(id, actor)} 而不是
 * {@code findByIdAndCustomerId(id, customerId)} ——
 * 因為「可見性」的規則（客服看得到全部、客戶只看自己的）
 * 屬於這個介面的<b>語意</b>，不該讓每個呼叫端自己組條件。
 */
public interface OrderRepository {

    void save(Order order);

    Optional<Order> findById(String orderId);

    /** ★ 授權內建在查詢裡（0.9.4 第 ② 步的同一個手法）。 */
    Optional<Order> findByIdVisibleTo(String orderId, Actor actor);

    /** ★ 給排程用：逾期未付款的訂單，一次最多 {@code limit} 筆。 */
    List<Order> findExpiredPendingPayment(Instant now, int limit);

    long countByCustomerId(String customerId);
}
```

```java
package example.shop.order.application.port;

/**
 * 庫存埠。
 *
 * <p>★★ 只有兩個方法，而它們的形狀就是 0.8.3 的結論：
 * <ul>
 *   <li>{@code tryReserve} —— <b>原子的檢查 + 扣減</b>，回 boolean。</li>
 *   <li>{@code snapshot} —— 只給「產生錯誤訊息」用，<b>不保證精確</b>。</li>
 * </ul>
 *
 * <p>⚠️ 刻意<b>沒有</b> {@code findByProductId(): Stock} 這種方法 ——
 * 因為它的存在就是在邀請別人寫出 0.3.2 事故 3 的那段程式碼。
 * <b>介面的設計可以讓錯誤的用法「不方便」。</b>
 */
public interface StockPort {

    boolean tryReserve(String productId, int quantity);

    void release(String productId, int quantity);

    // ⚠️ 02 章 2.14.1 ③ 會補上 findByProductIdForUpdate(...) ——
    //    盤點調整需要「讀出來、做複雜判斷、再寫回」，而那是 tryReserve
    //    這種原子 UPDATE 做不到的唯一情境（02 章 2.11.8 的決策表）。
    //    ★ 它標 @Transactional(MANDATORY)：沒有外層交易時直接失敗。

    java.util.Optional<StockSnapshot> snapshot(String productId);
}
```

```java
package example.shop.order.application.port;

import java.time.LocalDate;

/** ⚠️ 它是「某一刻的樣子」，在下一毫秒可能就過期了 —— 名字明說這件事。 */
public record StockSnapshot(String productId, int available, int reserved,
                            LocalDate restockEstimatedAt) {}
```

**其餘四個查詢埠**（方法就是前面呼叫過的那些，一個不多）：

```java
package example.shop.order.application.port;

public interface ProductRepository {
    /** ★ 批次 —— 沒有 findById，因為那會邀請別人在迴圈裡呼叫（1.2.5 的同一個理由）。 */
    java.util.List<Product> findAllById(java.util.Collection<String> productIds);
}

public interface CouponRepository {

    java.util.Optional<Coupon> findByCode(String code);

    /**
     * ★★ 原子的「檢查總量 + 計數 +1」。
     *
     * @return false = 已用完（<b>不是</b>「券不存在」——那由 findByCode 負責）
     */
    boolean tryConsume(String code);
}

public interface ShippingAddressRepository {
    /** ★ 授權內建在查詢條件裡（0.9.4 第 ② 步）。 */
    java.util.Optional<ShippingAddress> findByIdAndCustomerId(String id, String customerId);
}

public interface CustomerRepository {
    /** ★ 只回下單需要的欄位（見 ⑭ 的 CustomerSummary）。 */
    java.util.Optional<CustomerSummary> summaryOf(String customerId);
}
```

⚠️ **四個介面加起來只有 5 個方法。** 這是刻意的：

> **跨領域的介面應該比領域內部的介面小得多**（01 章 1.5.5 的
> 「published language」）。
> `ProductRepository` 在 product 領域內部有 20 幾個方法 ——
> 但 order 領域只看得到它需要的那一個。

```java
package example.shop.order.application.port;

import java.time.Instant;
import java.util.Optional;

/**
 * 冪等紀錄（04-controller 4.9 只做了 Redis 那一半）。
 *
 * <p>★★ 為什麼需要「持久的那一半」：
 * Redis 的紀錄有 TTL，而且 Redis 可能被清空。
 * <b>而「同一個冪等鍵不可以建出兩張訂單」是不變量 I9</b> ——
 * 不變量要守在資料所在的地方（0.8.4）。
 *
 * <p>👉 實作是一張 {@code order_idempotency} 表，
 * 主鍵是 {@code (actor_id, idempotency_key)} 的 UNIQUE 約束
 * —— 那條約束才是 I9 真正的守門人。
 */
public interface IdempotencyStore {

    Optional<String> findOrderId(String actorId, String idempotencyKey);

    /**
     * @throws IdempotencyKeyReusedException 同一個鍵已對應到另一張訂單
     *         （⚠️ 這個例外由 UNIQUE 約束的違反轉譯而來，04-controller 4.13.6 定義）
     */
    void record(String actorId, String idempotencyKey, String orderId, Instant at);
}
```

```java
package example.shop.common.event;

/** 領域事件的標記介面。 */
public interface DomainEvent {
    java.time.Instant occurredAt();
}
```

```java
package example.shop.common.event;

/**
 * 事件發佈埠。
 *
 * <p>⚠️ 為什麼不直接注入 Spring 的 {@code ApplicationEventPublisher}：
 * 那會讓 Application Service 依賴 Spring 的型別，
 * 而它的測試就得準備一個 Spring 的 publisher mock。
 *
 * <p>★ 但這是一個<b>很薄的包裝</b>，而 1.7.4 會討論
 * 「什麼時候這種包裝是過度設計」——
 * 這一個的理由是：它讓 {@code then(events).should().publish(any())}
 * 這種斷言讀起來是領域的語言。
 */
public interface DomainEventPublisher {
    void publish(DomainEvent event);
}
```

```java
package example.shop.common.id;

/** ID 產生埠（0.7 判準 1：{@code UUID.randomUUID()} 算 I/O）。 */
public interface IdGenerator {
    String newOrderId();
    String newPaymentId();
    String newRefundId();
    String newShipmentId();
}
```

```java
package example.shop.order.application.port;

import example.shop.order.domain.OrderNumber;
import java.time.Instant;

/**
 * 訂單編號產生埠。
 *
 * <p>⚠️ 它需要「當天已經開了幾張單」→ 是 I/O → 所以是埠而不是純函式。
 *
 * <p>★★ 而它的實作有一個經典的併發問題：
 * {@code SELECT MAX(seq) + 1} 在兩個請求同時進來時會產生同一個號碼。
 * 正解是一張 {@code order_number_sequence} 表 +
 * {@code INSERT ... ON DUPLICATE KEY UPDATE seq = seq + 1} 或
 * {@code SELECT ... FOR UPDATE}（02 章 2.11.4 會實作它）。
 */
public interface OrderNumberGenerator {
    OrderNumber next(Instant now);
}
```

```java
package example.shop.order.application.port;

import example.shop.order.domain.Actor;
import example.shop.order.domain.Order;
import java.time.Instant;

/**
 * 稽核紀錄埠。
 *
 * <p>⚠️ {@link AuditEvent} 的建構刻意<b>不吃整個 {@code Order}</b>
 * 的序列化結果 —— 0.3.2 事故 6 就是那樣外洩 PII 的。
 * 它只取明確列出的欄位。
 */
public interface AuditRecorder {
    void record(AuditEvent event);
}
```

```java
package example.shop.order.application.port;

import example.shop.common.money.Money;
import example.shop.order.domain.Actor;
import example.shop.order.domain.Order;
import java.time.Instant;
import java.util.Map;

/**
 * 稽核事件。
 *
 * <p>★★ {@code details} 是一個<b>明確列舉的</b> Map，而不是
 * {@code objectMapper.convertValue(order, Map.class)}。
 *
 * <p>⚠️ 差別是：前者「新增一個欄位到 Order」不會讓它自動進稽核，
 * 後者會 —— 而那正是事故 6 的機制。
 * <b>稽核紀錄的欄位應該是白名單，不是黑名單。</b>
 */
public record AuditEvent(String action, String resourceType, String resourceId,
                         Actor actor, Instant at, Map<String, Object> details) {

    public AuditEvent {
        details = Map.copyOf(details);
    }

    public static AuditEvent orderPlaced(Order order, Actor actor, Instant at) {
        return new AuditEvent("ORDER_PLACED", "Order", order.id(), actor, at,
                Map.of("orderNumber", order.orderNumber().value(),
                       "total",       order.total().toPlainString(),
                       "currency",    order.currency().getCurrencyCode(),
                       "lineCount",   order.lines().size(),
                       "itemQuantity", order.totalItemQuantity(),
                       // ⚠️ 刻意「不」記 shippingSnapshot、customerNote、invoice
                       //    —— 它們含 PII，而稽核不需要它們
                       "couponCode",  order.appliedCoupon() == null
                                        ? "" : order.appliedCoupon().code()));
    }

    public static AuditEvent orderCancelled(Order order, Actor actor,
                                            Money refundAmount, Instant at) {
        return new AuditEvent("ORDER_CANCELLED", "Order", order.id(), actor, at,
                Map.of("orderNumber",  order.orderNumber().value(),
                       "reason",       order.cancellation().reason().name(),
                       "refundAmount", refundAmount.toPlainString(),
                       // ⚠️ note 是客服自由輸入 → 可能含 PII → 只記「有沒有填」
                       "hasNote",      order.cancellation().note() != null));
    }
}
```

⚠️ **`AuditEvent.orderPlaced` 裡那兩行「刻意不記」的註解，是這個 record 存在的全部理由。**
如果它接受一個 `Map<String, Object>` 而沒有工廠方法，
呼叫端就會寫 `Map.of("order", order)`，於是事故 6 重演。

> 📌 **把「安全的用法」做成唯一方便的用法** ——
> 這是本章反覆出現的手法：
> `CreateOrderCommand` 沒有價格欄位、`StockPort` 沒有 `findByProductId`、
> `AuditEvent` 只有工廠方法、`Order` 沒有 setter。
> **它們都不是「限制」，是「讓錯誤變得不方便」。**

**⑪ 其他小型別**

```java
package example.shop.order.domain;

import example.shop.common.web.LabeledEnum;

/** ⚠️ 與 04-controller 1.12.5 的 {@code CreateOrderCommand.InvoiceSpec} 對應。 */
public record InvoiceSpec(InvoiceType type, String taxId, String companyName,
                          String carrierId, String donationCode) {

    /** ★ 從 command 的巢狀型別轉過來（套件不同，內容相同）。 */
    public static InvoiceSpec from(
            example.shop.order.service.command.CreateOrderCommand.InvoiceSpec c) {
        return c == null ? null
                : new InvoiceSpec(c.type(), c.taxId(), c.companyName(),
                                  c.carrierId(), c.donationCode());
    }
}
```

```java
package example.shop.order.domain;

import example.shop.common.web.LabeledEnum;

/** ⚠️ 04-controller 站已定義在 {@code order.domain}，這裡只列出以便對照。 */
public enum InvoiceType implements LabeledEnum {
    PERSONAL, COMPANY, DONATION, CARRIER;

    @Override public String labelKey() { return "invoiceType." + name(); }
}
```

```java
package example.shop.common.time;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import java.time.Clock;
import java.time.ZoneId;

/**
 * ★★ 提供 {@link Clock} bean —— 整個系統唯一取得「現在」的地方。
 *
 * <p>⚠️ 用 {@code Clock.system(ZoneId.of("UTC"))} 而不是
 * {@code Clock.systemDefaultZone()}：後者的行為取決於機器設定，
 * 於是同一個測試在你的筆電與 CI 上結果不同。
 *
 * <p>👉 而「顯示用的時區」由呼叫端明確指定
 * （{@code OrderNumber} 的 {@code Asia/Taipei}、
 * 04-controller 6.5.6 的序列化）—— 兩件事分開。
 */
@Configuration
public class ClockConfig {

    @Bean
    public Clock clock() {
        return Clock.system(ZoneId.of("UTC"));
    }
}
```

⚠️ **測試怎麼換掉它**（04-controller 7.4.4 已建立的手法，這一站的 domain 測試不需要它，
但 Application Service 測試需要）：

```java
@TestConfiguration
public class FixedClockConfig {

    public static final Instant FIXED = Instant.parse("2026-03-15T10:00:00Z");

    @Bean @Primary
    public Clock fixedClock() {
        return Clock.fixed(FIXED, ZoneId.of("UTC"));
    }
}
```

**⑫ `Actor.SYSTEM`：04-controller 站遺漏的一個常數 ★**

04-controller 4.13.6 的 `Actor` 定義了 `ANONYMOUS`，
但 `ActorType` 有 `SYSTEM` 而**沒有對應的常數**。

而這一站的 0.7 判準 5（排程取消逾期訂單）與 0.9.2 的
`Order.canBeCancelledBy()` 都需要它 —— 所以補上：

```java
// 加在 order/domain/Actor.java

/**
 * ★ 系統本身（排程、批次、對帳、資料修正腳本）。
 *
 * <p>⚠️ 它<b>不是</b>「沒有登入的人」（那是 {@link #ANONYMOUS}）——
 * 它是「這個操作不是任何一個人發起的」。
 *
 * <p>★★ 兩者的差別在稽核紀錄上很重要：
 * {@code ANONYMOUS} 代表<b>可能有人</b>（只是沒認證），
 * {@code SYSTEM} 代表<b>確定沒有人</b>。
 * 把排程的操作記成 {@code ANONYMOUS} 會讓「誰動了這筆資料」永遠查不清楚。
 */
public static final Actor SYSTEM =
        new Actor(ActorType.SYSTEM, "system", "系統");
```

⚠️ **而 `isInternal()` 刻意「不含」`SYSTEM`**（04-controller 站的定義是
`SUPPORT || WAREHOUSE || ADMIN`）。

**這是對的，而且要保持**：`isInternal()` 的語意是「內部**人員**」，
它被用在「這個人看得到客服專用的欄位嗎」這種判斷上，
而排程不需要看任何欄位。

👉 **所以「需要 SYSTEM 的地方」要寫成兩個條件**：

```java
// 🔴 第一版：兩個條件寫在每一個呼叫點
return actor.isInternal() || actor.type() == ActorType.SYSTEM;
```

⚠️ **而「兩個條件總是一起出現」本身就是一個訊號。**
它在 shop-service 出現 **4 次**：

| 出現位置 | 節次 |
|---|---|
| `Order.canBeCancelledBy()` | 0.9.2 |
| `OrderRepository.findByIdVisibleTo()` | 01 章 1.9.4 |
| `OrderVisibility.canSee()` | 01 章練習 2 |
| `OrderQueryRepository` 的查詢條件 | 01 章 1.9.2 |

**所以它應該有一個名字**：

```java
/**
 * ★ 「不是終端客戶」—— 內部人員或系統。
 *
 * <p>⚠️ 它與 {@link #isInternal()} 的差別只有 {@code SYSTEM} 一個值，
 * 而那個差別很重要：
 * <table>
 *   <tr><th>問題</th><th>用哪一個</th></tr>
 *   <tr><td>「這個人看得到客服專用的欄位嗎」</td><td>{@code isInternal()}</td></tr>
 *   <tr><td>「這個操作可以繞過客戶的限制嗎」</td><td><b>{@code isPrivileged()}</b></td></tr>
 * </table>
 *
 * <p>👉 換句話說：<b>{@code isInternal} 問的是「能看到什麼」，
 * {@code isPrivileged} 問的是「能做什麼」。</b>
 */
public boolean isPrivileged() {
    return isInternal() || type == ActorType.SYSTEM;
}
```

⚠️ **課程中 0.9.2、01 章 1.9.2/1.9.4、01 章練習 2 都已改用 `isPrivileged()`。**

**⑬ 領域事件：`OrderPlacedEvent` 與 `OrderCancelledEvent`**

```java
package example.shop.order.application.event;

import example.shop.common.event.DomainEvent;
import example.shop.common.money.Money;
import example.shop.order.domain.Order;

import java.time.Instant;
import java.util.List;

/**
 * 訂單成立。
 *
 * <h3>★★ 它的「胖度」是一個刻意的決定</h3>
 *
 * <p>它帶了 {@code customerEmail} 與 {@code lines} —— 消費者
 * （通知、ERP、點數）<b>不需要回查訂單</b>。
 *
 * <p>三個理由（完整的取捨表在 01 章 1.6.1）：
 * <ol>
 *   <li><b>避免循環依賴</b> —— 通知領域若要回查，就得依賴
 *       {@code OrderQueryService}，而 order 已經依賴通知的埠。</li>
 *   <li><b>重試的行為一致</b> —— listener 在 30 秒後重試成功時，
 *       回查會拿到「已經被取消的訂單」→ 寄出一封矛盾的信。</li>
 *   <li><b>它是「發生過的事實」</b> —— 事實不會因為之後的狀態改變而改變。</li>
 * </ol>
 *
 * <p>⚠️ 而它<b>刻意不帶</b>的東西同樣重要：
 * <b>收件地址、電話、發票的統編</b>。
 * 事件會進日誌、進訊息佇列、可能被外部系統消費 ——
 * 需要 PII 的消費者應該<b>自己去查</b>並自己負責存取控制
 * （0.3.2 事故 6 的同一個教訓）。
 */
public record OrderPlacedEvent(
    String orderId,
    String orderNumber,
    String customerId,
    String customerEmail,
    Money total,
    List<LineSummary> lines,
    Instant occurredAt
) implements DomainEvent {

    public OrderPlacedEvent {
        lines = List.copyOf(lines);
    }

    /** 明細摘要 —— 通知信需要的最小集合。 */
    public record LineSummary(String productId, String productName,
                              int quantity, Money lineTotal) {}

    /**
     * ★ 唯一的建立入口。
     *
     * <p>⚠️ 用工廠而不是讓呼叫端自己 {@code new}，理由與 {@link AuditEvent} 相同：
     * <b>「哪些欄位進事件」是一個要集中決定的事</b>。
     * 開放建構子的話，某個趕時間的 PR 會塞一個
     * {@code shippingSnapshot} 進去，而沒有人會注意到。
     */
    public static OrderPlacedEvent from(Order order, String customerEmail, Instant now) {
        return new OrderPlacedEvent(
                order.id(),
                order.orderNumber().value(),
                order.customerId(),
                customerEmail,
                order.total(),
                order.lines().stream()
                     .map(l -> new LineSummary(l.productId(), l.productName(),
                                               l.quantity(), l.lineTotal()))
                     .toList(),
                now);
    }
}
```

```java
package example.shop.order.application.event;

import example.shop.common.event.DomainEvent;
import example.shop.common.money.Money;
import example.shop.order.domain.CancelReason;
import example.shop.order.domain.Order;
import example.shop.order.domain.result.CancellationResult;

import java.time.Instant;

/**
 * 訂單取消。
 *
 * <p>★ 它帶 {@code refundRequired} 與 {@code refundAmount}，
 * 因為<b>通知的內容取決於它們</b>：
 * 未付款的取消是「訂單已取消」，已付款的是「訂單已取消，退款 X 元將於 3-5 個工作日退回」。
 *
 * <p>⚠️ 讓 listener 自己判斷「要不要退款」會造成
 * <b>兩份規則</b>（{@code Order.cancel()} 一份、listener 一份），
 * 而它們一定會分岔（0.5.2 的第 2 點）。
 */
public record OrderCancelledEvent(
    String orderId,
    String orderNumber,
    String customerId,
    CancelReason reason,
    boolean refundRequired,
    Money refundAmount,
    Instant occurredAt
) implements DomainEvent {

    public static OrderCancelledEvent from(Order order, CancellationResult result, Instant now) {
        return new OrderCancelledEvent(
                order.id(),
                order.orderNumber().value(),
                order.customerId(),
                order.cancellation().reason(),
                result.refundRequired(),
                result.refundAmount(),
                now);
    }
}
```

⚠️ **`OrderCancelledEvent.from` 讀的是 `order.cancellation().reason()`
而不是命令裡的 `reason`。**

看起來多此一舉，但它保證了**事件裡的原因與訂單上記錄的原因永遠一致** ——
而那兩者分岔的情況真的會發生（例如某個路徑忘了把 reason 傳給 `cancel()`）。

> 📌 **一般原則**：**事件的內容從「已經改變的聚合」讀，不從「命令」讀。**
> 命令是「想做什麼」，聚合是「實際變成什麼」。

**⑭ `CustomerSummary`：下單需要的客戶資訊**

```java
package example.shop.order.application.port;

import example.shop.customer.domain.CustomerLevel;

/**
 * 下單需要的客戶資訊。
 *
 * <p>★★ 為什麼不是「回傳整個 {@code Customer}」：
 * <ul>
 *   <li>訂單流程只需要<b>等級</b>（算價）與 <b>email</b>（事件）。</li>
 *   <li>{@code Customer} 上有生日、身分證、地址簿 —— 把它整個載入到
 *       訂單的流程裡，就是 0.3.2 事故 6 的入口
 *       （某天有人「順手」把它塞進稽核或事件）。</li>
 * </ul>
 *
 * <p>⚠️ 而它<b>刻意不叫 {@code Customer}</b> ——
 * 名字裡的 {@code Summary} 明說「這不是完整的客戶」，
 * 於是沒有人會期待在它上面找到電話。
 */
public record CustomerSummary(String customerId, CustomerLevel level, String email) {}
```

**⑮ 新增的 `ErrorCode` ★★**

⚠️ **04-controller 03 章的 `ErrorCode` 是一份「封閉的註冊表」**，
而 3.14.5 有一個 `ErrorCodeUsageTest` 在守它。
**這一站新增的例外必須同時新增對應的 code，否則那個測試會紅燈。**

04-controller 站結束時是 **83** 個（79 + 05 章的 4 個）。00～01 章新增 **10** 個，**合計 93**：

| 新增的 code | 狀態碼 | 對應的例外 | 為什麼不重用既有的 |
|---|---|---|---|
| `MIXED_CURRENCY` | 422 | `MixedCurrencyException` | 不變量 I10。⚠️ 它其實代表**商品資料有問題**，但回 422 讓客戶端可以移除那筆重試 |
| `SELF_CANCEL_WINDOW_EXPIRED` | 409 | `SelfCancelWindowExpiredException` | ★ 與 `ORDER_NOT_CANCELLABLE` 的**建議動作不同**：這個要引導去客服，那個是「此狀態無法取消」 |
| `CANCEL_NOTE_REQUIRED` | 422 | `CancelNoteRequiredException` | 有欄位級錯誤（`note`），走 `errors[]` |
| `SHIPMENT_QUANTITY_EXCEEDED` | 422 | `ShipmentQuantityExceededException` | 不變量 I11。`RETURN_QUANTITY_EXCEEDED` 是退貨那一側 |
| `ORDER_NOT_DELIVERABLE` | 409 | `OrderNotDeliverableException` | 物流 webhook 送來的狀態與我們不同步 |
| `COUPON_ALREADY_APPLIED` | 409 | `CouponAlreadyAppliedException` | 「這張訂單已經套過券」≠「這張券你用過了」（`COUPON_ALREADY_USED`） |
| `RETURN_WINDOW_EXPIRED` | 409 | `ReturnWindowExpiredException` | ⚠️ **與 `REFUND_WINDOW_EXPIRED` 是兩件事**：退貨期限（送達 +7 天）vs 退款期限（金流商的 180 天） |
| `ITEM_NOT_RETURNABLE` | 422 | `ItemNotReturnableException` | 生鮮不可退。帶 `productId` 讓前端標出是哪一筆 |
| `RETURN_REQUEST_EMPTY` | 422 | `ReturnRequestEmptyException` | 與 `ORDER_EMPTY` 對稱 |
| `REFUND_REJECTED` | 422 | `RefundRejectedException` | 金流商拒絕退款（原卡註銷）。⚠️ 帶 `manualTransferAvailable` 讓前端能引導到人工匯款 |

```java
// 加到 ErrorCode enum（04-controller 3.4.2）

    // ── 409 狀態衝突（新增）─────────────────────────────────
    SELF_CANCEL_WINDOW_EXPIRED(HttpStatus.CONFLICT,          "self-cancel-window-expired"),
    ORDER_NOT_DELIVERABLE  (HttpStatus.CONFLICT,             "order-not-deliverable"),
    COUPON_ALREADY_APPLIED (HttpStatus.CONFLICT,             "coupon-already-applied"),
    RETURN_WINDOW_EXPIRED  (HttpStatus.CONFLICT,             "return-window-expired"),

    // ── 422 語意錯誤（新增）─────────────────────────────────
    MIXED_CURRENCY         (HttpStatus.UNPROCESSABLE_ENTITY, "mixed-currency"),
    CANCEL_NOTE_REQUIRED   (HttpStatus.UNPROCESSABLE_ENTITY, "cancel-note-required"),
    SHIPMENT_QUANTITY_EXCEEDED(HttpStatus.UNPROCESSABLE_ENTITY,"shipment-quantity-exceeded"),
    ITEM_NOT_RETURNABLE    (HttpStatus.UNPROCESSABLE_ENTITY, "item-not-returnable"),
    RETURN_REQUEST_EMPTY   (HttpStatus.UNPROCESSABLE_ENTITY, "return-request-empty"),
    REFUND_REJECTED        (HttpStatus.UNPROCESSABLE_ENTITY, "refund-rejected",
                            Retry.MODIFY_REQUEST),
```

⚠️ **同時要補 `messages_zh_TW.properties` 的 20 行**（每個 code 各 `title` 與 `user` 兩行）——
04-controller 3.4.5 的 `訊息完整()` 測試會檢查。

**⑯ 這兩章「用到但定義在**本站 04 章**的例外」對照表**

| 例外 | 定義在 | 本站怎麼用 |
|---|---|---|
| `BusinessException`（基底） | 04-controller 3.5.2 | 所有業務例外的父類別 |
| `ResourceNotFoundException` | 04-controller 3.5.3 | 訂單 / 地址 / 客戶找不到（含**刻意合併「沒權限」**，01 章 1.8.3） |
| `InsufficientStockException` | 04-controller 3.5.3 | 0.9.4 第 ④ 步 |
| `OrderNotCancellableException` | 04-controller 3.5.3 | `Order.cancel()` |
| `IdempotencyKeyReusedException` | 04-controller 4.13.6 | `IdempotencyStore.record()` |
| `RefundExceedsPaymentException` | 04-controller 3.14.3 | `Payment.refund()`（不變量 I8） |
| `ValidationFailedException` | 04-controller 2.10.4 | Service 層的語意驗證 |
| `OptimisticLockConflictException` | 04-controller 3.14.3 | ⏳ 02 章 2.11 的樂觀鎖會用到 |

**其餘 26 個新例外類別的完整定義在 04 章**（業務例外設計）——
那一章的工作正是「把它們排成一棵樹，並與這 93 個 code 一一對應」。

> 📌 **這一節本身就是一個方法示範**：
> **每新增一個例外，同一次 commit 要動四個地方** ——
> 例外類別、`ErrorCode`、兩行 i18n 訊息、以及 `orders-api.yaml` 的錯誤清單。
> 04-controller 3.14.5 的 `ErrorCodeUsageTest` 與 04-controller 7.10.2 的契約測試各守其中一半。

---
## 0.13 這一站的八章地圖

| 章 | 主題 | 核心問題 | 產出 |
|---|---|---|---|
| **00**（本章） | 商業邏輯層定位 | 規則該由誰守 | `Order` 聚合、`Money`、狀態機、ArchUnit 守門 |
| **01** | Service 設計與依賴 | 一個 Service 該有多大、介面要不要 | 拆分後的 Service、埠與轉接器、循環依賴的解法 |
| **02** ★ | 交易管理 | `@Transactional` 到底做了什麼 | 7 種傳播、**五種**失效、樂觀/悲觀鎖、`tryReserve` 的完整實作 |
| **03** | DTO ↔ Entity 轉換 | 邊界上的資料要怎麼變形 | mapper 策略、PATCH 三態、MapStruct 的取捨 |
| **04** | 業務例外設計 | **93 個** `ErrorCode` 怎麼對應到例外階層 | 完整例外樹、與 04-controller 03 章 advice 的對應表 |
| **05** | 服務層快取 | 快取的一致性怎麼保證 | `@Cacheable`、Redis、擊穿與雪崩、key 設計 |
| **06** | 非同步與外部呼叫 | 交易之外的世界怎麼可靠 | `@Async`、`RestClient`、重試熔斷、事件、outbox、Saga |
| **07** | Service 層測試 | 什麼時候該用真的資料庫 | Mockito 深入、`ArgumentCaptor`、併發測試、Testcontainers |

**依賴關係**：

```
00（觀念與 domain 骨架）
 ├─→ 01（Service 的形狀）
 │    └─→ 02 ★★ 交易（最關鍵，其他章都依賴它）
 │         ├─→ 05 快取（快取與交易的互動）
 │         └─→ 06 非同步（AFTER_COMMIT、outbox）
 ├─→ 03 DTO 轉換（可獨立讀）
 ├─→ 04 例外設計（可獨立讀，但 02 的 rollback 規則會用到）
 └─→ 07 測試（讀完 02 再讀效果最好）
```

⚠️ **如果你時間有限，02 章是唯一不能跳的。**
它是這一站的核心，也是「Spring 用了三年但講不清楚」最常見的一章。

---

## 0.14 回頭修正 04-controller 的五處

04-controller 站的做法是「後面的章節修正前面的，每一處標理由」。這一站沿用。

### 0.14.1 `OrderWebMapper` 的 accessor 命名與 `allowedActions` 簽章

**位置**：04-controller 0.10.3

```java
// ── 修正前（04-controller 站）────────────────────────────────
public CreateOrderResponse toCreateResponse(Order order) {
    return new CreateOrderResponse(
            order.getId(),
            order.getOrderNumber(),
            order.getStatus().name(),
            order.getStatus().label(),                 // ← 🔴 label() 不存在
            order.getStatus().category().name(),
            order.allowedActions().stream().map(Enum::name).toList(),  // ← 🔴 缺參數
            toAmounts(order),
            order.getCurrency().getCurrencyCode(),
            order.totalItemQuantity(),
            toCoupon(order.getAppliedCoupon()),
            order.getCreatedAt(),
            order.getExpiresAt()
    );
}
```

**三個問題：**

| 問題 | 說明 |
|---|---|
| `getXxx()` vs `xxx()` | 0.9.1 已決定統一用 `xxx()` |
| **`order.getStatus().label()` 不存在** | 04-controller 6.5.8 的結論是 `LabeledEnum.labelKey()` + `StatusLabelResolver`（要 `Locale`），enum 上**沒有** `label()` |
| **`allowedActions()` 需要 `(actor, now)`** | 「客戶能不能取消」取決於角色與時間（0.9.2） |

```java
// ── 修正後 ────────────────────────────────────
/**
 * @param actor 決定 {@code allowedActions} —— ⚠️ 04-controller 站沒有傳它，
 *              於是客服看到的可執行操作與客戶相同（而客服可以 SHIP）
 * @param now   同上（客戶的 7 天取消時限）
 */
public CreateOrderResponse toCreateResponse(Order order, Actor actor, Instant now,
                                            Locale locale) {
    return new CreateOrderResponse(
            order.id(),
            order.orderNumber().value(),                        // ★ 值物件 → String
            order.status(),
            statusLabels.label(order.status(), locale),          // ★ 04-controller 6.5.8 的 resolver
            order.total().toPlainString(),                      // ★ 04-controller 6.5.7：金額用字串
            order.currency().getCurrencyCode(),
            order.expiresAt(),                                  // paymentDueAt
            CreateOrderResponse.NextAction.pay(order.id()),
            order.createdAt()
    );
}
```

⚠️ **注意這個修正順手解決了一個真實的權限 bug**：
04-controller 站的 `allowedActions()` 沒有參數，所以它不可能知道呼叫者是誰 ——
**於是客服在後台看到的按鈕與客戶一樣**（少了「出貨」）。
那個 bug 在 04-controller 站不會被發現，因為 `allowedActions()` 是 stub。

> 📌 **這是「stub 掩蓋設計問題」的一個典型例子。**
> stub 讓程式編譯得過、測試綠燈，但它也讓
> 「這個方法需要哪些資訊」這個問題沒有被問。

### 0.14.2 `CancelReason` 從 command 套件搬到 domain

**位置**：04-controller 1.12.5 的 `CancelOrderCommand.CancelReason`

| 原本 | 現在 |
|---|---|
| `example.shop.order.service.command.CancelOrderCommand.CancelReason`（巢狀） | `example.shop.order.domain.CancelReason`（頂層） |

**兩個理由**（0.12 ③ 的 javadoc 已說明）：
① 它是領域概念（進報表、影響退款規則）；
② `Cancellation` 值物件需要它，而 domain 不可依賴 command 套件（ArchUnit 會擋）。

⚠️ **影響範圍**：`CancelOrderCommand` 的 import，
以及 04-controller 07 章那個「所有 `CancelReason` 都有 i18n 訊息」的掃描測試。
**新增了 `PAYMENT_TIMEOUT`，所以 `messages_zh_TW.properties` 要補一行**：

```properties
cancelReason.PAYMENT_TIMEOUT=超過付款期限，訂單已自動取消
```

### 0.14.3 `order.service` 套件改名為 `order.application`

**位置**：04-controller 0.11.2 的骨架

```
04-controller 站：  order/service/OrderService.java          ← 介面
        order/service/command/…
        order/service/exception/…

本站：  order/application/OrderApplicationService.java   ← 實作
        order/application/port/…
        order/domain/exception/…                          ← ★ 例外搬到 domain
        order/service/OrderService.java                    ← ⚠️ 介面留在原處
        order/service/command/…                            ← ⚠️ command 留在原處
```

⚠️ **`OrderService` 介面與 `command` 套件刻意留在 `order.service`。**

理由：改動它們會影響 04-controller 站的 70 條端點與 350 個測試的 import，
而收益只是「套件名比較一致」。

> 📌 **但要誠實承認代價**：現在有 `order.service`（介面 + command）
> 與 `order.application`（實作 + 埠）兩個套件，
> 而新人會問「差別是什麼」。
> **1.3.5 會重新檢視這個決定** —— 屆時的問題是
> 「`OrderService` 這個介面到底有沒有存在的必要」，
> 而如果答案是「沒有」，這個套件的尷尬會一起消失。

⚠️ **例外類別搬到 `order.domain.exception` 是必要的**（不是取捨）：
`Order.cancel()` 要拋 `OrderNotCancellableException`，
而 domain 不可以依賴 `order.service.exception` —— ArchUnit 的
`domain不可依賴application或web` 會擋（雖然 `service` 不在那條規則裡，
但依賴方向上它屬於上層）。

👉 **修正**：把那條 ArchUnit 規則的套件清單補上 `..service..`：

```java
@ArchTest
static final ArchRule domain不可依賴application或web =
        noClasses().that().resideInAPackage("..domain..")
                   .should().dependOnClassesThat()
                   .resideInAnyPackage("..application..", "..web..",
                                       "..infrastructure..", "..service..");
```

### 0.14.4 `Order` 上 04-controller 站假設存在、但實際不同的方法

**「被呼叫但不存在的方法」是這一站最需要小心的一類缺口 —— 這是第一次碰到它。**

| 04-controller 站寫的 | 實際（0.9.2） | 出現在 |
|---|---|---|
| `order.getId()` | `order.id()` | 0.10.3、mapper 多處 |
| `order.getOrderNumber()` → String | `order.orderNumber()` → `OrderNumber` | 同上 |
| `order.getStatus().label()` | `statusLabels.label(status, locale)` | 0.10.3 |
| `order.allowedActions()` | `order.allowedActions(actor, now)` | 0.10.3、06 章 5445 行的 DTO |
| `order.getCurrency()` | `order.currency()` | 0.10.3 |
| `order.getAppliedCoupon()` | `order.appliedCoupon()` | 0.10.3 |
| `order.getExpiresAt()` | `order.expiresAt()` | 0.10.3 |
| `order.totalItemQuantity()` | ✅ 相同 | 0.10.3 |
| `order.getStatus().category()` | ✅ 相同（0.9.3 有定義） | 0.10.3 |

⚠️ 另外 **04-controller 0.10.3 的 mapper 測試**寫了 `new OrderWebMapper()`（無參建構子），
而同一節的正式碼是 `OrderWebMapper(StatusLabelResolver)`。

**那個測試在 04-controller 站就編譯不過。** 修正：

```java
@Test
void toCommand_把header與認證資訊一起收攏() {
    // ★ mapper 需要 StatusLabelResolver，但 toCommand() 不會用到它 →
    //   傳一個假的比 mock 一個更清楚（它明示「這個測試不關心 label」）
    var mapper = new OrderWebMapper(StatusLabelResolver.identity());
    // …
}
```

⚠️ 而 `StatusLabelResolver.identity()` 是**這一站新增**的靜態工廠
（回傳 `enum.name()`），理由是：
**測試需要一個「明顯不是真的、但不會 NPE」的實作**，
而 `Mockito.mock()` 在沒有 stub 時回 `null` ——
那正是 04-controller 7.2.3 的陷阱。

### 0.14.5 `StatusLabelResolver` 需要一個吃 `Locale` 的多載 ★

**位置**：04-controller 6.5.8

```java
// ── 04-controller 站的定義 ────────────────────────────────
public String label(Enum<?> value) {
    return messageSource.getMessage(
            LabeledEnum.labelKeyOf(value), new Object[0], value.name(),
            LocaleContextHolder.getLocale());     // ← ⚠️ ThreadLocal
}
```

⚠️ **它從 `LocaleContextHolder` 讀語言，而那是一個 `ThreadLocal`。**

在 Web 層這完全沒問題（`LocaleChangeInterceptor` 會在請求開始時設好）。
**但 Service 層有三個地方會出錯**：

| 情境 | 會發生什麼 |
|---|---|
| 排程呼叫（`OrderExpirationJob`，01 章 1.9.3） | ThreadLocal 是空的 → 用 JVM 的預設語言（在容器裡通常是 `en`） |
| `@Async` 的 listener（06 章） | 🔴 **同上** —— 而通知信正是最需要正確語言的地方 |
| 批次匯出 41 萬筆（04-controller 5.2.3） | `StreamingResponseBody` 跑在另一個執行緒上 |

> 📌 **這正是 01 章 1.4.6 那條規則的另一個實例**：
> **「目前的使用者」不可以從 `SecurityContextHolder` 讀，
> 「目前的語言」同樣不可以從 `LocaleContextHolder` 讀。**
> 兩者是同一個 ThreadLocal 陷阱。

**修正**：加一個明確吃 `Locale` 的多載，並讓既有的無參版本委派給它。

```java
@Component
public class StatusLabelResolver {

    private final MessageSource messageSource;

    public StatusLabelResolver(MessageSource messageSource) {
        this.messageSource = messageSource;
    }

    /**
     * ★★ 明確指定語言 —— <b>Service 層一律走這一個</b>。
     *
     * @param locale 不可為 null。⚠️ 呼叫端「拿不到 locale」時，
     *               正確的做法是把它變成方法參數往上傳，
     *               而不是傳 {@code Locale.getDefault()}
     */
    public String label(Enum<?> value, Locale locale) {
        if (value == null) return null;
        Objects.requireNonNull(locale, "locale");
        return messageSource.getMessage(
                LabeledEnum.labelKeyOf(value), new Object[0], value.name(), locale);
    }

    /**
     * Web 層用的便利多載 —— 從 {@code LocaleContextHolder} 取語言。
     *
     * <p>⚠️ <b>只有在「確定跑在請求執行緒上」時才可以用它</b>。
     * Service、排程、{@code @Async}、串流一律用
     * {@link #label(Enum, Locale)}。
     */
    public String label(Enum<?> value) {
        return label(value, LocaleContextHolder.getLocale());
    }

    /** 保留 {@code OrderStatus} 的多載 —— 04-controller 站既有的呼叫端不必改。 */
    public String label(OrderStatus status) {
        return label((Enum<?>) status);
    }

    /**
     * ★ 測試用：直接回常數名。
     *
     * <p>⚠️ 不要用 {@code Mockito.mock(StatusLabelResolver.class)} ——
     * 沒 stub 時它回 {@code null}，而 {@code null} 的 {@code statusLabel}
     * 會讓斷言在一個完全無關的地方失敗（04-controller 7.2.3 的陷阱）。
     */
    public static StatusLabelResolver identity() {
        return new StatusLabelResolver(new StaticMessageSource()) {
            @Override public String label(Enum<?> v, Locale l) { return v == null ? null : v.name(); }
        };
    }
}
```

⚠️ **`identity()` 用匿名子類別覆寫，所以 `label` 不可以是 `final`** ——
而這正好呼應 01 章 1.3.1 的 CGLIB 限制：
**「這個類別會不會被子類別化」是一個要想清楚的設計決定**，
不是「加不加 final 都行」。

👉 **受影響的呼叫點**：0.14.1 的 `OrderWebMapper.toCreateResponse`、
01 章 1.9.2 的 `OrderQueryService`，兩處都明確傳 `Locale`。

---

## 0.15 常見誤區

**誤區 1：「Service 就是放商業邏輯的地方」**

不精確，而這個不精確會直接造出 2,000 行的類別。

```
Application Service = 編排 + 交易邊界
Domain             = 業務規則
```

**判準**：如果一段程式碼**不需要 I/O**，它就不該在 Application Service。

---

**誤區 2：「加了 `@Transactional` 就安全了」**

`@Transactional` 保證的是**資料庫操作的原子性**。它不保證：

| 它不保證 | 為什麼 |
|---|---|
| 併發正確性 | 兩個交易可以同時通過同一個 `if`（0.3.2 事故 3） |
| 外部系統回滾 | 信寄出去了就回不來 |
| **它自己生效** | private 方法、自呼叫、非 Spring 管理的物件上完全無效（02 章） |
| 快取一致性 | Redis 不在交易裡 |

---

**誤區 3：「每個 Entity 都要有對應的 Service 與 Repository」**

這個「對稱性」的直覺會產出 40 個傳話筒 Service（0.4.2）。

**正確的粒度是「聚合」而不是「表」**：
`Order`、`OrderLine`、`Payment`、`Shipment` 是四張表、
但**只有一個聚合根、一個 Repository、一個 Application Service**。

---

**誤區 4：「Domain 物件不能有邏輯，因為它要對應資料庫」**

這是把「持久化的形狀」誤當成「領域的形狀」。

⚠️ **兩者確實會互相影響**（08 章會誠實面對），
但方向應該是「先想清楚領域，再決定怎麼存」，
而不是「表長這樣，所以物件也長這樣」。

---

**誤區 5：「用了 DDD 的名詞就是 DDD」**

把 `OrderServiceImpl` 改名叫 `OrderAggregateRoot` 而內容不變，
只是換了一個更難懂的名字。

**這一站不教 DDD 的完整方法論**，只用其中三個真的有用的工具：
**聚合邊界**（哪些東西要一起改）、**值物件**（`Money`）、
**領域事件**（交易外的副作用）。

---

**誤區 6：「先讓它動，之後再重構」**

在 Service 層這句話特別危險，因為：

> **交易邊界一旦畫錯，重構它需要重新測試所有併發情境。**
> 而那些情境的測試（0.8.5）通常在「先讓它動」的階段沒有寫。

⚠️ **可以先簡化的**：不做快取、不做非同步、Repository 用假實作、
`ShippingFeePolicy` 只有一個實作。
**不可以先簡化的**：交易邊界、不變量的守門位置、原子操作。

---

**誤區 7：「不變量在 Java 裡檢查就夠了」**

0.8.4 的整節。一句話：

> **不變量要守在資料所在的地方。**

---

**誤區 8：「`readOnly = true` 只是效能優化，不加也沒差」**

它有三個非效能的作用：

| 作用 | 說明 |
|---|---|
| **意圖宣告** | 讀者立刻知道這個方法不會改資料 |
| **讀寫分離的路由依據** | `LazyConnectionDataSourceProxy` + `AbstractRoutingDataSource` 靠它決定連 primary 還是 replica |
| **意外寫入會失敗** | Hibernate 的 `FlushMode.MANUAL` 讓「不小心改了 Entity」不會被 flush ⚠️ 但這是**靜默的**，別依賴它當保護 |

---

**誤區 9：「Service 之間可以自由互相呼叫」**

它會產生循環依賴、交易邊界混亂、以及「改一個地方壞五個地方」。
**01 章 1.5 整節在講這個。**

---

**誤區 10：「Domain 測試不重要，反正整合測試會涵蓋」**

整合測試會涵蓋 happy path。它不會涵蓋：
「折扣 1500 但小計 1000」、「幣別混合」、「7×7 的狀態轉移」——
**因為那些情境在整合測試裡難以構造**（要先讓資料庫進入那個狀態）。

⚠️ 而 0.9.5 的對照很明確：
**同一個規則，domain 測試 1 毫秒、整合測試 200 毫秒。**
200 倍的成本差距會直接決定「這個規則有沒有被測到」。

---
## 0.16 本章練習

### 練習 1：判斷這 18 段程式碼屬於哪一層

用 0.7 的七個判準。**先自己判斷，再看答案。**
答案不只要說「哪一層」，還要說「為什麼」與「如果放錯會怎樣」。

```java
// ①
if (order.status() != OrderStatus.PAID) throw new OrderNotShippableException(...);

// ②
Order order = orders.findById(id).orElseThrow(() -> new ResourceNotFoundException(...));

// ③
BigDecimal tax = subtotal.multiply(new BigDecimal("0.05"))
                         .setScale(2, RoundingMode.HALF_UP);

// ④
if (Duration.between(order.createdAt(), now).toDays() > 7) throw ...;

// ⑤
int updated = jdbc.update("UPDATE stock SET available = available - ? "
                        + "WHERE product_id = ? AND available >= ?", qty, id, qty);

// ⑥
redisTemplate.delete("cart:" + customerId);

// ⑦
String orderNumber = "ORD-" + LocalDate.now().format(FMT) + "-" + (maxSeq + 1);

// ⑧
List<Money> parts = totalDiscount.allocate(lines.stream()
        .map(OrderLine::lineTotal).map(Money::amount).toList());

// ⑨
if (customerLevel == VIP && !product.hasActivePromotion(now)) price = price.times(0.92);

// ⑩
mailSender.send(buildConfirmationMail(order));

// ⑪
if (shipments.stream().mapToInt(s -> s.quantity()).sum() + qty > orderedQty) throw ...;

// ⑫
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void recordFailedAttempt(String orderId, String reason) { … }

// ⑬
long todayChanges = addressChangeLog.countByOrderIdAndDate(orderId, today);
if (todayChanges >= 3) throw new AddressChangeLimitExceededException(...);

// ⑭
return status == PENDING_PAYMENT || status == PAID || status == PARTIALLY_SHIPPED;

// ⑮
ResponseEntity.status(HttpStatus.CONFLICT).body(problem);

// ⑯
if (!MessageDigest.isEqual(expectedSig.getBytes(UTF_8), providedSig.getBytes(UTF_8)))
    throw new InvalidWebhookSignatureException();

// ⑰
Money refundable = paidAmount().minus(refundedAmount());
if (requested.compareTo(refundable) > 0) throw new RefundExceedsPaymentException(...);

// ⑱
CompletableFuture.runAsync(() -> erpPort.push(snapshot), integrationExecutor);
```

<details>
<summary>答案</summary>

| # | 層 | 判準 | 放錯會怎樣 |
|---|---|---|---|
| ① | **Domain**（`Order.ship()` 的守衛） | 2（只看自己的 status） | 放 Service → 排程／客服後台各寫一份 → 分岔 |
| ② | **Application Service** | 1（I/O） | 放 Domain → Domain 需要注入 Repository → 測試要 Spring |
| ③ | **Domain**（`TaxPolicy` 或 `Money`） | 1（純運算）、2 | 放 Service → 稅率規則散落，而稅率會變 |
| ④ | **Domain**，但 `now` 是參數 | 2、4 | 用 `Instant.now()` → 這個規則**無法寫測試** |
| ⑤ | **基礎設施**（Repository 實作） | 1 | 放 Service → SQL 洩漏到編排層，換 DB 要改 Service |
| ⑥ | **基礎設施**，而且要在 **commit 之後** | 1、3 | 在交易裡 → 交易回滾但購物車已清掉（不可逆） |
| ⑦ | 🔴 **陷阱**：`LocalDate.now()` 是 I/O，`maxSeq + 1` 有 race。→ **`OrderNumberGenerator` 埠**，實作用原子的序號表 | 1、4、6 | 併發下產生重複編號 → UNIQUE 違反 → 下單失敗（或更糟：沒有 UNIQUE 時重複） |
| ⑧ | **Domain**（`Money.allocate()`） | 1、2 | 放 Service → 每個呼叫點各寫一次「最後一筆補齊」→ 有的忘記 → 差 1 分錢 |
| ⑨ | **Domain**（`PricingPolicy`） | 1、2 | 放 Service → 購物車試算與下單算出不同價格 |
| ⑩ | **交易外的事件監聽器** | 3 | 在交易裡 → 事故 1、2 |
| ⑪ | **Domain**（`Order.ship()`，不變量 I11） | 2、6 | 放 Service → 第二個入口漏檢 → 多發貨 |
| ⑫ | **Application Service** | 3（它就是在決定交易邊界） | 放 Domain → Domain 依賴 Spring |
| ⑬ | 🔴 **陷阱**：`countBy…` 是 I/O → **Application Service**。⚠️ 但 `>= 3` 這個判斷在併發下無效 → 需要 **UNIQUE `(order_id, business_date, seq)`** | 1、2、6 | 04-controller 0.14 練習 4 的那個 race → 一天改 4 次 |
| ⑭ | **Domain**（`OrderStatus.isCancellable()`） | 2 | 寫在 Service 的 `if` 裡 → 新增狀態時沒有人知道要改它 |
| ⑮ | **Web 層** | — | 放 Service → Service 認識 HTTP（0.10.6） |
| ⑯ | **Web 層**（或 security filter） | — | 驗簽是「這個請求是不是對方送的」→ 是認證，不是業務（04-controller 1.12.5 ④） |
| ⑰ | **Domain**（`Payment.refund()`，不變量 I8） | 2、6 | 放 Service → 兩個客服同時退款 → **突破上限**。⚠️ 所以還需要「同一交易 + 對 payment 列加鎖」（02 章） |
| ⑱ | **Application Service**（發事件）或 **listener**（執行） | 1、3 | ⚠️ 直接寫在 Service 的交易裡 → 非同步執行緒可能在 commit 之前就跑 → 讀不到資料 |

⚠️ **⑦、⑬、⑰ 三題的共同點**：它們看起來是「單一聚合的判斷」（判準 2 說 Domain），
但**在併發下不成立**（判準 6）。

> 📌 **這是本章最重要的一個模式**：
> **「規則的表達」放 Domain，「規則的保證」放資料庫。**
> 兩者都要有，而且要知道哪一個是哪一個。

</details>

---

### 練習 2：把這段 Service 分層

以下是一段真實的「客戶申請退貨」程式碼。
**任務**：把它重構成 Domain + Application Service 兩層，
並列出「哪些不變量需要資料庫層的保護」。

```java
@Service
public class ReturnServiceImpl implements ReturnService {

    @Autowired private OrderRepository orderRepository;
    @Autowired private ReturnRepository returnRepository;
    @Autowired private ProductRepository productRepository;
    @Autowired private RestTemplate restTemplate;
    @Autowired private JavaMailSender mailSender;

    @Override
    @Transactional
    public ReturnRequest apply(String orderId, List<ReturnItemDto> items,
                              String reason, String customerId) {

        Order order = orderRepository.findById(orderId).orElse(null);
        if (order == null) throw new RuntimeException("訂單不存在");
        if (!order.getCustomerId().equals(customerId)) {
            throw new RuntimeException("無權限");
        }
        if (!"DELIVERED".equals(order.getStatus())) {
            throw new RuntimeException("只有已送達的訂單可以退貨");
        }
        // 7 天內
        if (order.getDeliveredAt().before(
                new Date(System.currentTimeMillis() - 7L * 24 * 3600 * 1000))) {
            throw new RuntimeException("已超過退貨期限");
        }

        BigDecimal refundTotal = BigDecimal.ZERO;
        List<ReturnItem> returnItems = new ArrayList<>();
        for (ReturnItemDto dto : items) {
            OrderItem oi = order.getItems().stream()
                    .filter(i -> i.getProductId().equals(dto.getProductId()))
                    .findFirst().orElse(null);
            if (oi == null) throw new RuntimeException("此商品不在訂單中");

            // 已退過的數量
            int alreadyReturned = returnRepository
                    .sumReturnedQuantity(orderId, dto.getProductId());
            if (alreadyReturned + dto.getQuantity() > oi.getQuantity()) {
                throw new RuntimeException("退貨數量超過訂購數量");
            }

            Product p = productRepository.findById(dto.getProductId()).orElse(null);
            if (p != null && p.getCategory().equals("FRESH_FOOD")) {
                throw new RuntimeException("生鮮食品不可退貨");
            }

            refundTotal = refundTotal.add(
                    oi.getUnitPrice().multiply(new BigDecimal(dto.getQuantity())));
            returnItems.add(new ReturnItem(dto.getProductId(), dto.getQuantity()));
        }

        // 運費不退
        ReturnRequest req = new ReturnRequest();
        req.setId(UUID.randomUUID().toString());
        req.setOrderId(orderId);
        req.setStatus("PENDING_REVIEW");
        req.setRefundAmount(refundTotal);
        req.setReason(reason);
        req.setItems(returnItems);
        req.setCreatedAt(new Date());
        returnRepository.save(req);

        // 通知物流來收件
        restTemplate.postForObject("https://logistics.example.com/pickup",
                Map.of("orderId", orderId), String.class);

        mailSender.send(buildReturnMail(order, req));
        return req;
    }
}
```

<details>
<summary>答案</summary>

**① 先找出所有規則與它們的性質**

| # | 規則 | 需要什麼 | 層 |
|---|---|---|---|
| R1 | 訂單必須存在 | 查詢 | Application（查詢條件） |
| R2 | 只能退自己的訂單 | 訂單的 `customerId` | ⚠️ **兩者**：查詢條件 + `Order.belongsTo()` |
| R3 | 只有 `DELIVERED` 可退 | `order.status` | **Domain** |
| R4 | 送達後 7 天內 | `deliveredAt` + `now` | **Domain**（`now` 當參數） |
| R5 | 商品必須在訂單中 | `order.lines` | **Domain** |
| R6 | 退貨數量不可超過訂購數量 | **要查已退過的量** | ⚠️ Application 查 + Domain 判斷 + **資料庫約束** |
| R7 | 生鮮食品不可退 | **要查 Product** | Application 查 + Domain 判斷 |
| R8 | 退款金額 = Σ(單價 × 退貨數量)，運費不退 | 純運算 | **Domain** |
| R9 | 通知物流 | 外部 API | 🔴 **事件 + commit 之後** |
| R10 | 寄信 | 外部 | 🔴 **事件 + commit 之後** |

**② Domain：`Order.requestReturn(...)`**

```java
package example.shop.order.domain;

/** 退貨期限。⚠️ 業務規則 → 寫死在 Domain（0.11.3 的判準）。 */
private static final Duration RETURN_WINDOW = Duration.ofDays(7);

/**
 * 申請退貨。
 *
 * @param requested       想退的品項與數量
 * @param alreadyReturned 每個商品「已經退過」的數量（★ 由 Application 查來傳入）
 * @param returnable      每個商品「是否可退」（★ 生鮮判斷，由 Application 查 Product 傳入）
 * @return 一張待審核的退貨單
 *
 * @throws OrderNotReturnableException     狀態不是 DELIVERED
 * @throws ReturnWindowExpiredException    超過 7 天
 * @throws ReturnItemNotInOrderException   商品不在訂單中
 * @throws ReturnQuantityExceededException 退貨數量超過（不變量）
 * @throws ItemNotReturnableException      商品類別不可退（生鮮）
 */
public ReturnRequest requestReturn(String returnId,
                                   List<ReturnLine> requested,
                                   Map<String, Integer> alreadyReturned,
                                   Map<String, Boolean> returnable,
                                   Actor actor,
                                   String reason,
                                   Instant now) {

    if (!status.isReturnable()) {                       // R3
        throw new OrderNotReturnableException(id, status);
    }
    if (!actor.isPrivileged() && !belongsTo(actor)) {   // R2（第二道）
        throw new OrderNotReturnableException(id, status);
    }
    Instant deliveredAt = deliveredAt();
    if (deliveredAt == null || deliveredAt.isBefore(now.minus(RETURN_WINDOW))) {  // R4
        throw new ReturnWindowExpiredException(id, deliveredAt, RETURN_WINDOW);
    }
    if (requested.isEmpty()) {
        throw new ReturnRequestEmptyException(id);
    }

    Money refund = Money.zero(currency);
    var returnLines = new ArrayList<ReturnLine>();

    for (ReturnLine rl : requested) {
        OrderLine ol = lines.stream()
                .filter(l -> l.productId().equals(rl.productId()))
                .findFirst()
                .orElseThrow(() -> new ReturnItemNotInOrderException(   // R5
                        id, rl.productId()));

        if (!Boolean.TRUE.equals(returnable.get(rl.productId()))) {     // R7
            throw new ItemNotReturnableException(id, rl.productId(), ol.productName());
        }

        int already = alreadyReturned.getOrDefault(rl.productId(), 0);
        if (already + rl.quantity() > ol.quantity()) {                  // R6
            throw new ReturnQuantityExceededException(
                    id, rl.productId(), ol.quantity(), already, rl.quantity());
        }

        // R8：單價 × 數量，運費不退
        refund = refund.plus(ol.unitPrice().times(rl.quantity()));
        returnLines.add(rl);
    }

    // ★★ 不變量：退款不可超過已付款（I8）
    Money refundable = paidAmount().minus(refundedAmount());
    if (refund.compareTo(refundable) > 0) {
        throw new IllegalStateException(
                "退款超過可退金額：order=%s refund=%s refundable=%s"
                        .formatted(id, refund, refundable));
    }

    return ReturnRequest.pending(returnId, id, returnLines, refund, reason, actor, now);
}
```

**③ Application Service**

```java
@Service
public class ReturnApplicationService implements ReturnService {

    @Override
    @Transactional
    public ReturnRequest apply(RequestReturnCommand cmd) {
        Instant now = clock.instant();

        // R1 + R2（第一道，在查詢條件裡）
        Order order = orders.findByIdVisibleTo(cmd.orderId(), cmd.actor())
                .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

        List<String> productIds = cmd.lines().stream()
                .map(ReturnLine::productId).distinct().toList();

        // R6 的「已退過多少」—— ⚠️ 這一查在併發下不可靠，見 ④
        Map<String, Integer> alreadyReturned =
                returns.sumReturnedQuantityByProduct(cmd.orderId(), productIds);

        // R7 的「可不可退」—— 規則的「資料」由這裡取得，判斷在 Domain
        Map<String, Boolean> returnable = products.findAllById(productIds).stream()
                .collect(toMap(Product::id, Product::isReturnable));

        // ★★ 全部規則在這一行裡
        ReturnRequest req = order.requestReturn(
                ids.newReturnId(), cmd.lines(), alreadyReturned, returnable,
                cmd.actor(), cmd.reason(), now);

        returns.save(req);
        audit.record(AuditEvent.returnRequested(order, req, cmd.actor(), now));

        // R9、R10：交易之外
        events.publish(new ReturnRequestedEvent(
                req.id(), order.id(), order.customerId(), req.refundAmount(), now));

        return req;
    }
}
```

**④ 需要資料庫保護的不變量**

| 不變量 | 為什麼 Java 守不住 | 資料庫的守法 |
|---|---|---|
| **退貨數量總和 <= 訂購數量** | 兩個請求同時查到 `alreadyReturned = 0` | ⚠️ 沒有單一欄位可以下 CHECK。解法：對 `order` 那一列 `SELECT … FOR UPDATE`（02 章 2.11.3），或在 `return_item` 上加 `(order_id, product_id)` 的彙總表 + CHECK |
| **一張訂單同時只能有一張待審退貨單** | 同上 | UNIQUE partial index：`(order_id) WHERE status = 'PENDING_REVIEW'` ⚠️ MySQL 不支援 partial index → 改用「產生欄位 + UNIQUE」的技巧（07-mysql 第 02 章） |
| **退款總額 <= 付款總額（I8）** | 兩個客服同時退 | 對 `payment` 列加鎖 + `CHECK (refunded_amount <= amount)` |

**⑤ 順手抓到的原始碼 bug**

| bug | 說明 |
|---|---|
| `p != null && p.getCategory().equals("FRESH_FOOD")` | ⚠️ **商品不存在時「可以退」** —— 邏輯反了。商品查不到應該拒絕 |
| `new Date(System.currentTimeMillis() - 7L*24*3600*1000)` | 沒有處理夏令時間與閏秒；而且 `Date` 的比較是 `before` 不是 `isBefore`，很容易寫反 |
| `restTemplate.postForObject(...)` 沒設逾時 | 事故 1 |
| 退貨單建立後才通知物流，但**沒有處理「通知失敗」** | 退貨單建了，物流不知道 → 客戶等不到人來收 |
| `req.setStatus("PENDING_REVIEW")` 字串 | 打錯字不會被發現 |

</details>

---

### 練習 3：設計不變量清單

**任務**：為「購物車」設計不變量清單，並為每一條指出守在哪一層。

購物車的需求：
- 一個客戶只有一台購物車。
- 同一個商品在車裡只有一列（加同樣的商品是把數量加上去）。
- 每個商品最多 99 個。
- 車裡最多 50 種商品。
- 商品下架後，車裡那一列要標記為「不可結帳」但**不自動移除**（讓客戶看到）。
- 車裡的價格是「顯示用的參考價」，結帳時以當時價格為準。

<details>
<summary>答案</summary>

| # | 不變量 | 守在哪 | 為什麼 |
|---|---|---|---|
| C1 | 一個客戶一台車 | ④ **UNIQUE `(customer_id)`** | 兩個 tab 同時加商品會建兩台車 |
| C2 | 同商品在車裡只有一列 | ④ **UNIQUE `(cart_id, product_id)`** + ② `Cart.addItem()` 合併 | 同上 |
| C3 | 單品數量 1..99 | ① Web `@Min(1) @Max(99)` + ② `Cart.addItem()` | ⚠️ ② 是必要的：`addItem` 是**加總**，`98 + 5` 要在 Domain 擋 |
| C4 | 最多 50 種商品 | ② `Cart.addItem()` | ⚠️ 併發下可能變 51 —— **但這條可以接受**（見下方） |
| C5 | 下架商品標記不可結帳 | ⚠️ **不是不變量** —— 它是「讀取時的計算」 | 見下方 |
| C6 | 結帳價 = 當時價格 | ⚠️ **不是不變量** —— 它是「不要存價格」這個設計 | 見下方 |

**⚠️ C4 為什麼可以接受「偶爾 51」**

這是一個重要的判斷：**不是每個不變量都值得用鎖保護**。

判準是「**破壞它的後果有多嚴重**」：

| 不變量 | 破壞的後果 | 值得加鎖嗎 |
|---|---|---|
| 庫存 >= 0 | 超賣、退款、商譽 | ✅ 一定要 |
| 退款 <= 付款 | 直接資金損失 | ✅ 一定要 |
| **購物車最多 50 種** | 使用者的車裡有 51 種 | ❌ **不值得** |

> 📌 **「用鎖保護」是有成本的**（延遲、死鎖風險、複雜度）。
> **對「後果輕微」的不變量，用樂觀的做法 + 讀取時修正就夠了。**
>
> ⚠️ 但這必須是**明確的決定**並寫下來，
> 而不是「沒想到」。

**⚠️ C5 與 C6 為什麼「不是不變量」**

它們是**設計決定**，而把它們誤當成不變量會造出錯的東西：

```java
// 🔴 誤把 C5 當不變量 → 需要在「商品下架時」去更新所有購物車
@Transactional
public void offShelf(String productId) {
    products.updateStatus(productId, OFF_SHELF);
    cartItems.markUnavailable(productId);      // ← 可能要更新 30 萬筆
}
```

```java
// ✅ 正確：讀取購物車時計算
public CartView view(String customerId) {
    Cart cart = carts.findByCustomerId(customerId).orElseGet(Cart::empty);
    Map<String, Product> products = this.products.findAllById(cart.productIds());
    return CartView.of(cart, products);        // ★ 「可不可結帳」在這裡算
}
```

**判準**：

> **不變量 = 「不可以被『存』成這樣」。
> 衍生狀態 = 「可以由別的資料算出來」。**
>
> ⚠️ **把衍生狀態存起來**，就多了一個「可能不一致」的地方。
> C6（不存價格）就是同一個原則的應用 ——
> 存了「參考價」就要處理「參考價過期」，而不存就沒有這個問題。

</details>

---

### 練習 4：找出這段程式碼的 11 個問題

```java
@Service
@Transactional
public class PaymentServiceImpl implements PaymentService {

    @Autowired private OrderRepository orderRepository;
    @Autowired private PaymentRepository paymentRepository;
    @Autowired private CacheManager cacheManager;
    @Autowired private PaymentGatewayClient gateway;

    public PaymentResult pay(String orderId, String cardToken, BigDecimal amount) {
        Order order = orderRepository.findById(orderId).get();

        if (order.getStatus().equals("PAID")) {
            return new PaymentResult(false, "已付款");
        }

        // 呼叫金流
        GatewayResponse resp = gateway.charge(cardToken, amount, orderId);

        if (resp.isSuccess()) {
            order.setStatus("PAID");
            order.setPaidAt(new Date());
            orderRepository.save(order);

            Payment p = new Payment();
            p.setOrderId(orderId);
            p.setAmount(amount);
            p.setStatus("SUCCESS");
            paymentRepository.save(p);

            cacheManager.getCache("orders").evict(orderId);
            return new PaymentResult(true, "成功");
        } else {
            log.error("付款失敗：" + resp.getMessage());
            return new PaymentResult(false, resp.getMessage());
        }
    }

    private void notifyCustomer(Order order) {
        // ...
    }
}
```

<details>
<summary>答案</summary>

| # | 問題 | 嚴重度 | 說明 |
|---|---|---|---|
| 1 | **在交易裡呼叫金流** | 🔴🔴 | 事故 1。金流的 P99 是 3 秒，連線池 20 條 → 有效容量 20/3秒 |
| 2 | **`amount` 由呼叫端傳入** | 🔴🔴 | 客戶端可以付 1 元買 10 萬的訂單。**應該用 `order.total()`** |
| 3 | **金流成功但後續失敗 → 錢收了訂單沒付款** | 🔴🔴 | `orderRepository.save()` 若拋例外 → 交易回滾 → **錢已經扣了**。這是「交易不能回滾外部世界」的最貴版本 |
| 4 | **`findById(orderId).get()`** | 🔴 | 訂單不存在時 `NoSuchElementException` → 500 而不是 404 |
| 5 | **沒有冪等** | 🔴 | 使用者連點兩次「付款」→ 扣兩次錢。⚠️ 而 04-controller 4.9 的 `Idempotency-Key` 只擋了「同一個 key」，連點兩次是**兩個不同的 key** → 需要「同一張訂單同時只能有一筆進行中的付款」（`PAYMENT_ALREADY_IN_PROGRESS`） |
| 6 | **「付款結果未知」完全沒處理** | 🔴🔴 | `gateway.charge()` 逾時時 `resp` 是什麼？如果拋例外 → 交易回滾 → **但錢可能已經扣了**。正解：先寫一筆 `PENDING` 的 payment（`REQUIRES_NEW`，獨立 commit），再呼叫金流，用查詢 API 對帳（06 章 6.8） |
| 7 | **字串狀態 `"PAID"` / `"SUCCESS"`** | ⚠️ | 打錯字不會被發現 |
| 8 | **類別層 `@Transactional`** | ⚠️ | 讀取方法也開可寫交易（0.10.8） |
| 9 | **`new Date()`** | ⚠️ | 不可測；而且 `Date` 已過時（用 `Instant` + 注入 `Clock`） |
| 10 | **快取清除在 commit 之前** | ⚠️ | 交易回滾了但快取已清 → 下一次讀會重新載入（這個方向還好），⚠️ **但如果是「更新快取」而不是「清除」就會寫入未 commit 的資料** → 必須在 `AFTER_COMMIT` |
| 11 | **回傳 `PaymentResult(false, msg)` 而不是拋例外** | ⚠️ | 呼叫端很容易忽略回傳值。而 `msg` 直接來自金流商 → **可能含卡號後四碼或內部錯誤細節** → 04-controller 3.11.2 的資訊洩漏 |

**⑫ 額外**：`notifyCustomer` 是 private 且沒有被呼叫 —— 死碼，
而它的存在暗示「原本要寄信但忘了」。

**正確的架構**（06 章 6.8 會完整實作）：

```
① @Transactional(REQUIRES_NEW) 寫一筆 payment（PENDING）→ 立刻 commit
      ★ 這一步的目的：讓「我們嘗試過付款」這件事在資料庫裡留下痕跡
② 交易外 呼叫金流（有逾時、有斷路器）
③ 依結果：
   成功       → @Transactional order.markPaid(...)（★ 冪等，0.9.2）
   明確失敗   → @Transactional payment 標記 FAILED
   結果未知   → ⚠️ 什麼都不改，交給對帳排程用金流的查詢 API 確認
                （ErrorCode.PAYMENT_OUTCOME_UNKNOWN / 504 + Retry.CHECK_STATUS）
```

⚠️ **注意 ③ 的第三種情況**：
「結果未知」時**絕對不可以**猜。猜「成功」→ 沒收到錢卻出貨；
猜「失敗」→ 客戶被扣款卻沒有訂單。
**正確答案是「承認不知道，並建立一個會去查清楚的機制」。**

</details>

---

## 0.17 驗收清單

讀完本章，你應該能回答：

**觀念**

- [ ] Service 層的三個職責是什麼？哪一個最常被忽略？
- [ ] 「傳話筒 Service」的四個壞處是什麼？什麼情況下 CRUD 資源仍然需要 Service？
- [ ] 貧血模型的四個代價分別是什麼？舉出一個「第二個入口出現時崩掉」的具體例子。
- [ ] 充血模型與「把 Repository 注入 Entity」的差別在哪？後者的四個致命問題？
- [ ] `Money` 值物件解決了哪三個問題？`allocate()` 為什麼必要？
- [ ] 「驗證」與「不變量」的五個差別？
- [ ] 不變量可以守在哪四個位置？可靠度與錯誤訊息品質的關係是什麼？
- [ ] 為什麼 `synchronized` / `ReentrantLock` 不能用來守不變量？
- [ ] 「不變量要守在資料所在的地方」這句話的例外是什麼？

**判斷**

- [ ] 七個判準各自在問什麼？哪一個最快、最不會錯？
- [ ] 為什麼 `Instant.now()` 與 `UUID.randomUUID()` 算 I/O？
- [ ] 一段規則「只看單一聚合狀態」但「併發下不成立」時，該怎麼辦？
- [ ] 「編排順序」的兩條原則是什麼？它們衝突時怎麼選？
- [ ] 什麼情況下不需要 Domain 層？shop-service 的 `stock/` 為什麼幾乎沒有 domain？
- [ ] 一個不變量「不值得加鎖」的判準是什麼？

**實作**

- [ ] `Order.place()` 為什麼是 static 工廠而不是建構子？建構子為什麼是 private？
- [ ] **`transitionTo()` 與各方法的守衛「不是重複」，差別在哪？兩者失敗時的狀態碼為什麼不同？**
- [ ] **`ship()` 裡的 `if (next != status)` 少了會怎樣？**
- [ ] `Order.cancel()` 為什麼要「在改狀態之前算出後果」？
- [ ] `CancellationResult` 這個 record 存在的三個理由？
- [ ] `Order.markPaid()` 的 `ORPHANED` 狀態解決什麼問題？
- [ ] `payments()` 做防禦性複製而 `lines()` 不做，為什麼？
- [ ] `OrderStatus.category()` 為什麼用沒有 `default` 的 switch？
- [ ] `assertInvariants()` 為什麼拋 `IllegalStateException` 而不是業務例外？
- [ ] `Coupon` 為什麼「刻意沒有」`usedCount` 的檢查？
- [ ] `Coupon.discountFor()` 最後那行「折扣不超過小計」為什麼必要？
- [ ] `StockPort` 為什麼刻意沒有 `findByProductId()`？
- [ ] `AuditEvent` 為什麼只有工廠方法？

**環境**

- [ ] 六組 ArchUnit 規則各自守什麼？
- [ ] **`allowEmptyShould(true)` 為什麼不能拿來當「例外機制」？正確的是什麼？**
- [ ] **`ignoreDependency(alwaysFalse(), alwaysFalse())` 會忽略什麼？**
- [ ] 為什麼 `domain不可依賴JPA` 的 `because` 要寫「這條規則會在 08 章被放寬」？
- [ ] **`connection-timeout` 與「交易長度」有關嗎？真正與交易長度有關的是哪一個設定？**
- [ ] **新增一個業務例外時，同一次 commit 要動哪四個地方？**
- [ ] `spring.jpa.open-in-view` 為什麼一定要 `false`？
- [ ] 「這個值該放程式碼還是設定檔」的判準是什麼？
- [ ] 三層測試各自需要什麼、各自多快、各自該有多少個？
- [ ] 併發測試的三個必要條件是什麼？
- [ ] **為什麼 Object Mother 要「走過真實的狀態路徑」而不是直接塞欄位？**
- [ ] **`狀態機的每一條邊都有對應的操作` 這個測試現在為什麼是紅的？那樣可以嗎？**

**如果有任何一題答不出來，回去讀對應的小節**：

| 題目範圍 | 小節 |
|---|---|
| Service 的職責、傳話筒 | 0.4 |
| 貧血 / 充血、`Money`、值物件 | 0.5 |
| 四層職責、請求穿透 | 0.6 |
| 七個判準 | 0.7 |
| 不變量（最重要） | **0.8** |
| `Order`、`OrderStatus`、Application Service | 0.9 |
| 不該做的九件事 | 0.10 |
| 套件、ArchUnit、設定 | 0.11 |
| 支援型別 | 0.12 |

---

## 0.18 下一章預告

這一章決定了「**規則放哪裡**」。
下一章（01）處理一個更實際的問題：

> **`OrderApplicationService` 現在有 14 個建構子參數。這正常嗎？**

0.9.4 那個建構子確實很長。而它引出一整串問題：

| 問題 | 01 章哪一節 |
|---|---|
| 一個 Service 該有多大？14 個依賴是設計問題還是自然結果？ | 1.2 |
| **`OrderService` 這個介面到底有沒有必要？** 每個 Service 都配一個介面是慣例還是迷信？ | **1.3 ★** |
| 同一個介面有多個實作（三種運費方案）時怎麼注入？ | 1.4.4 |
| `Clock`、`IdGenerator` 這種「把不確定性注入進來」的手法還可以用在哪？ | 1.4.6 |
| `OrderApplicationService` 需要呼叫 `CouponApplicationService` 時，可以直接注入它嗎？ | **1.5 ★** |
| 兩個 Service 互相需要對方（訂單要查優惠券、優惠券要查訂單）怎麼辦？ | **1.6 ★** |
| `PaymentGateway` 這個介面該放 domain 還是 application？ | 1.7 |
| Service 方法該回傳 Domain、DTO 還是 `void`？ | 1.8 |

⚠️ **1.3 與 1.5 是全站爭議最大的兩節**，
因為它們挑戰的是兩個幾乎沒有人質疑過的慣例：
「Service 一定要有介面」與「Service 之間可以互相呼叫」。

**而 1.6（循環依賴）是最實用的一節** ——
它是 Spring Boot 2.6 之後最常見的啟動失敗原因，
而錯誤訊息長達 40 行、看起來像框架的問題。

---

**完成本章後**，請確認你的專案有：

```
✅ common/money/Money.java                     含 allocate() 與它的測試
✅ order/domain/Order.java                     沒有 setter、沒有 Spring import
✅ order/domain/OrderStatus.java               狀態機 + 述詞 + category()
✅ order/domain/ShippingFeePolicy2026.java     + 8 個參數化測試
✅ order/domain/DefaultPricingPolicy.java      + 6 個參數化測試（含「促銷比會員貴」）
✅ order/application/OrderApplicationService.java
✅ architecture/LayeredArchitectureTest.java   ★ 六組 ArchUnit 規則全綠
✅ stock/StockInvariantTest.java               ★ 20 執行緒併發測試
```

⚠️ 課程中的程式碼、YAML 與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
（這台機器上沒有安裝 JDK 與 Maven）。基準版本延續 04-controller 站：
**Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1 / Jackson 2.17 / ArchUnit 1.3**。
若你的版本不同，課程會標註差異，但仍請以你的環境實測為準。

下一章：[01-service-design-and-dependency.md](./01-service-design-and-dependency.md)
