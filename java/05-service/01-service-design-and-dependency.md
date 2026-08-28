# 第 01 章：Service 設計與依賴管理

> 上一章決定了「**規則放哪裡**」。
> 這一章處理一個你在寫完 0.9.4 之後一定會問的問題：
>
> ```java
> public OrderApplicationService(OrderRepository orders, ProductRepository products,
>                                StockPort stock, CouponRepository coupons,
>                                ShippingAddressRepository addresses,
>                                CustomerRepository customers,
>                                IdempotencyStore idempotency, AuditRecorder audit,
>                                DomainEventPublisher events,
>                                ShippingFeePolicy shippingFeePolicy,
>                                PricingPolicy pricingPolicy,
>                                IdGenerator ids, OrderNumberGenerator orderNumbers,
>                                Clock clock) {
> ```
>
> **14 個參數。這正常嗎？**
>
> 而它會一路引出這一章的每一節：
> Service 該多大、介面要不要、Service 之間能不能互相呼叫、
> 循環依賴怎麼解、外部系統的介面該放哪。
>
> ⚠️ **這一章有兩節（1.3、1.5）會挑戰兩個幾乎沒有人質疑過的慣例。**
> 我會給出立場與理由，但更重要的是讓你能**自己做這個決定並說出代價** ——
> 因為兩邊都有可以辯護的說法，而「跟著慣例做但講不出理由」是最糟的狀態。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 判斷一個 Service 是不是太大，並用三種方式拆它（讀寫分離、use case、資料載入器）。
- 說出「每個 Service 都配一個介面」的六個常見理由，並指出其中**四個已經不成立**。
- 說出介面**真正**有價值的五種情況，並對 shop-service 的每一個 Service 做出決定。
- 熟練建構子注入的細節：`final`、Lombok 的取捨、`Optional`、`ObjectProvider`、`@Lazy`。
- 處理「同一介面多個實作」：`@Qualifier`、`Map<String, T>`、以及策略註冊表。
- 說出「把不確定性注入進來」這個手法的完整清單（`Clock`、`IdGenerator`、亂數、環境）。
- 說出「A Service 直接注入 B Service」的五個後果，以及五種解耦手段各自的適用。
- 讀懂 Spring 的循環依賴錯誤訊息，並用六種方式解它（知道為什麼 `@Lazy` 是最糟的）。
- 設計埠（port）：介面該放哪一邊、什麼時候這層抽象是過度設計。
- 設計 Service 的方法簽章：參數用不用 Command、回傳什麼、`@throws` 怎麼寫。

## 前置知識

[00 章](./00-course-map-business-layer-role.md) 全部，
[02-spring-boot/](../02-spring-boot/) 01 章（IoC 與 DI）與 04 章（AOP 與代理）。

---

## 1.2 一個 Service 該有多大

### 1.2.1 從 14 個依賴開始

先問一個更基本的問題：**14 個依賴到底是不是問題？**

**答案是：它是一個「訊號」，不一定是「問題」。**

把那 14 個依賴分類：

| 類別 | 依賴 | 數量 |
|---|---|---|
| **查資料** | `orders`、`products`、`coupons`、`addresses`、`customers` | 5 |
| **原子操作 / 外部狀態** | `stock`、`idempotency` | 2 |
| **橫切關注點** | `audit`、`events` | 2 |
| **純函式策略** | `shippingFeePolicy`、`pricingPolicy` | 2 |
| **不確定性來源** | `ids`、`orderNumbers`、`clock` | 3 |

**四個觀察：**

> **① 「純函式策略」與「不確定性來源」不算真正的耦合。**
> 它們是無狀態的、不會失敗的、不需要 mock 就能用真的
> （`Clock.fixed()`、`ShippingFeePolicy2026`、一個固定的 `IdGenerator`）。
> **5 個依賴，測試成本接近 0。**
>
> **② 「查資料」的 5 個是真正的複雜度。**
> 每一個都是一個可能失敗的 I/O，每一個在測試裡都要 stub。
>
> **③ `audit` 與 `events` 是橫切關注點，它們會出現在每一個 Service 上。**
> 這是「重複但正確」——把它們藏起來（例如用 AOP）會讓
> 「這個操作有沒有稽核」變成不可見的。
>
> **④ 真正值得警惕的數字是「查資料」那一組。**
> 5 個 Repository 代表「這個 use case 需要 5 個聚合的資料」，
> 而那本身可能是領域邊界劃錯的訊號。

⚠️ **所以正確的問法不是「幾個依賴太多」，而是：**

> **「這些依賴分屬幾種性質？其中『可能失敗的 I/O』有幾個？」**

**shop-service 的判準：**

| 「可能失敗的 I/O」依賴數 | 判斷 |
|---|---|
| 1～3 | 正常 |
| 4～6 | ⚠️ 檢視一次，通常可以拆 |
| 7+ | 🔴 幾乎確定是設計問題 |

`OrderApplicationService.create()` 有 7 個（5 個 Repository + `stock` + `idempotency`）——
**在警戒線上**。1.2.5 會把它降到 4 個。

### 1.2.2 三個該拆的訊號

**訊號 1：不同方法用到的依賴幾乎不重疊**

```java
@Service
public class OrderApplicationService {

    // create() 用：orders, products, stock, coupons, addresses, customers, idempotency
    public Order create(CreateOrderCommand cmd) { … }

    // cancel() 用：orders, stock, refunds
    public CancellationResult cancel(CancelOrderCommand cmd) { … }   // ⚠️ 03 章 3.10.3 ⑨ 改回 CancellationResultView

    // search() 用：orders 只有一個
    public Page<OrderSummary> search(OrderQuery query) { … }

    // exportCsv() 用：orders, exportJobs, objectStorage
    public ExportJob exportCsv(ExportCommand cmd) { … }
}
```

⚠️ **`search()` 只用 1 個依賴，卻被迫「載入」另外 13 個。**

**具體代價：**

| 代價 | 說明 |
|---|---|
| 測試 | 測 `search()` 要建一個有 14 個 mock 的 `@InjectMocks` |
| 啟動 | 每個依賴都要先被建立（雖然很快，但 100 個這種 Service 就有感） |
| **閱讀** | 想知道「`search` 會碰哪些東西」要讀完整個類別 |
| **變更半徑** | 改 `ProductRepository` 的簽章 → `search` 的測試也要重新編譯 |

**訊號 2：方法的交易屬性不同**

```java
@Service
public class OrderApplicationService {
    @Transactional               public Order create(…) { }
    @Transactional(readOnly=true) public Page<OrderSummary> search(…) { }
    @Transactional(readOnly=true) public OrderDetail findById(…) { }
    @Transactional(propagation=REQUIRES_NEW) public void recordAttempt(…) { }
}
```

**混在一起的問題**（0.10.8 已提過一半）：

- 類別層無法設一個合理的預設值。
- 讀寫分離的路由（06 站）以「類別」為單位設定會更簡單。
- **最重要的**：讀者看到 `@Transactional` 缺席時，不知道是「忘了」還是「刻意」。

**訊號 3：一個方法超過 60 行，而它不是「一連串取資料」**

0.9.4 的 `create()` 有 60 行，**但那 60 行全部是「取東西」或「存東西」**。
它可以再拆（1.2.5），但它不是「太複雜」——它是「步驟多」。

⚠️ **要區分這兩種長**：

| 長的原因 | 該怎麼辦 |
|---|---|
| 步驟多（一連串 I/O） | ⚠️ 可以拆成私有方法或載入器，但**不要為了行數硬拆** |
| **邏輯複雜（很多 if / 迴圈 / 計算）** | 🔴 **那些邏輯不該在這裡**（00 章的整章） |

### 1.2.3 拆法一：讀寫分離（最划算的一刀）

**這是投報率最高的拆法，而且幾乎沒有爭議。**

```java
// ── 寫（命令）────────────────────────────────────────
@Service
public class OrderApplicationService implements OrderService {

    @Transactional
    public Order create(CreateOrderCommand cmd) { … }

    @Transactional
    public CancellationResult cancel(CancelOrderCommand cmd) { … }

    @Transactional
    public PaymentResult markPaid(MarkPaidCommand cmd) { … }
}
```

```java
// ── 讀（查詢）────────────────────────────────────────
@Service
@Transactional(readOnly = true)                 // ★ 類別層預設唯讀
public class OrderQueryService {

    private final OrderQueryRepository orders;   // ★ 注意：不同的介面
    private final StatusLabelResolver labels;

    public OrderQueryService(OrderQueryRepository orders, StatusLabelResolver labels) {
        this.orders = orders;
        this.labels = labels;
    }

    public Page<OrderSummaryView> search(OrderQuery query, Actor actor) { … }

    public OrderDetailView findById(String orderId, Actor actor) { … }

    public CursorPage<OrderSummaryView> scroll(OrderCursorQuery query, Actor actor) { … }
}
```

**六個好處：**

| 好處 | 說明 |
|---|---|
| 依賴數 | 命令側 7 → 讀取側 2 |
| 交易屬性 | 類別層一次設定，不會漏 |
| **讀取可以不經過聚合** | ⚠️ **這是最大的好處**，見下方 |
| 讀寫分離路由 | `readOnly` → replica（06 站） |
| 快取策略不同 | 讀取可以大量快取（05 章），寫入不行 |
| 測試 | 讀取側完全不需要 mock 寫入的東西 |

⚠️ **「讀取可以不經過聚合」值得展開。**

```java
// 🔴 用聚合來做「列表查詢」是一個效能災難
public Page<OrderSummaryView> search(OrderQuery q, Actor actor) {
    Page<Order> orders = this.orders.search(q);          // ← 載入 20 個完整聚合
    // 每個 Order 都載入了 lines、payments、shipments、cancellation…
    // 而列表只需要 orderNumber、status、total、createdAt 四個欄位
    return orders.map(this::toSummary);
}
```

**具體數字**（一個真實案例）：

```
用聚合：  20 筆訂單 × (1 + 3 個關聯查詢) = 61 次查詢，180 ms，
          記憶體 20 × 8 KB = 160 KB
用投影：  1 次查詢（只 SELECT 需要的 6 個欄位），12 ms，
          記憶體 20 × 200 B = 4 KB
```

⚠️ 這正是 08 章「N+1」的來源。而**分開讀寫的 Service 讓你可以在讀取側用投影**，
不需要為了「架構一致性」而犧牲 15 倍的效能。

```java
// ✅ 讀取側直接查投影
public interface OrderQueryRepository {

    /** ★ 回傳投影（record），不是聚合。 */
    Page<OrderSummaryProjection> search(OrderQuery query, Actor actor);

    /** ★ 明細也是投影 —— 它的欄位取決於 actor 的角色（04-controller 1.12.2）。 */
    Optional<OrderDetailProjection> findDetail(String orderId, Actor actor);
}
```

> 📌 **這是 CQRS 的「窮人版」** —— 沒有分開的資料庫、沒有事件溯源，
> 只是「讀取與寫入用不同的模型」。
> **它的成本幾乎是零，收益很大。**
> ⚠️ 完整的 CQRS（分開的資料儲存、最終一致）是另一回事，
> shop-service **不做**，因為它引入的複雜度遠超過收益。

### 1.2.4 拆法二：按 use case 拆（Command Handler）

當一個命令側 Service 有超過 5 個 use case 時，可以再拆：

```java
// ── 一個 use case 一個類別 ─────────────────────────────
@Service
public class PlaceOrderHandler {

    private final OrderRepository orders;
    private final OrderDataLoader loader;         // ★ 1.2.5 的載入器
    private final StockPort stock;
    private final IdempotencyStore idempotency;
    private final AuditRecorder audit;
    private final DomainEventPublisher events;
    private final OrderFactory factory;           // ★ 封裝 ids + orderNumbers + policies
    private final Clock clock;

    @Transactional
    public Order handle(CreateOrderCommand cmd) { … }
}

@Service
public class CancelOrderHandler {

    private final OrderRepository orders;
    private final StockPort stock;
    private final RefundPort refunds;
    private final AuditRecorder audit;
    private final DomainEventPublisher events;
    private final Clock clock;

    @Transactional
    public CancellationResult handle(CancelOrderCommand cmd) { … }
}
```

**好處**：每個類別 3～8 個依賴、一個公開方法、測試檔案跟它一對一。

⚠️ **但它有三個真實的代價，不要無腦採用：**

| 代價 | 說明 |
|---|---|
| **類別數暴增** | 70 條端點 → 40 個 handler。找東西變成搜尋而不是瀏覽 |
| **「相關的邏輯」被分開** | `cancel` 與 `expireUnpaid` 共用 `Order.cancel()`，但在兩個檔案裡 |
| **`OrderService` 介面怎麼辦** | 04-controller 站的 Controller 注入的是 `OrderService`，一個介面對 8 個 handler → 需要一個 facade（而 facade 又是一層轉發） |

**shop-service 的選擇**：

> **不拆到「一個 use case 一個類別」。**
> 保持 `OrderApplicationService`（命令）+ `OrderQueryService`（查詢）兩個，
> 用 1.2.5 的載入器把依賴數降下來。
>
> ⚠️ **什麼時候該拆到 handler**：
> 當一個 use case 的**編排步驟超過 15 步**，
> 或它有**自己的一組依賴**（例如「匯出」需要物件儲存與工作佇列）。
> shop-service 的 `OrderExportService` 就是這樣獨立出來的。

### 1.2.5 拆法三：把「取資料」收攏成載入器 ★

> ⚠️ **02 章 2.14.1 ① 會修正本節的載入器**：
> 取商品時要**依 `productId` 排序**，否則「兩張訂單含相同商品但順序不同」會死鎖。
> ★ 那是一個「載入器的順序影響併發正確性」的例子 ——
> 而它說明**載入器不是純粹的效能重構**。

**這是把 7 個 I/O 依賴降到 4 個最直接的方法，而且它不只是「搬移」。**

```java
package example.shop.order.application;

/**
 * 下單所需資料的載入器。
 *
 * <p>★★ 它<b>不是</b>「把 4 個 Repository 包起來」的傳話筒（00 章 0.4.2）。
 * 它做了三件真正有價值的事：
 * <ol>
 *   <li><b>把 N+1 變成批次查詢</b> —— {@code findAllById} 一次取完，
 *       而不是在迴圈裡 {@code findById}。</li>
 *   <li><b>把「缺資料」的例外集中處理</b> ——
 *       「商品不存在」該拋什麼、「地址不屬於這個客戶」該回 404 還是 403，
 *       只有一個地方決定。</li>
 *   <li><b>回傳一個「已經完整」的物件</b> ——
 *       {@code OrderContext} 之後的程式碼不需要再判斷 null。</li>
 * </ol>
 *
 * <p>⚠️ 它<b>沒有</b> {@code @Transactional} —— 它在呼叫端的交易裡執行。
 * （這一點很重要，02 章 2.7 會解釋為什麼「內層不標註」是對的。）
 */
@Component
public class OrderDataLoader {

    private final ProductRepository products;
    private final CouponRepository coupons;
    private final ShippingAddressRepository addresses;
    private final CustomerRepository customers;

    public OrderDataLoader(ProductRepository products, CouponRepository coupons,
                           ShippingAddressRepository addresses,
                           CustomerRepository customers) {
        this.products = products;
        this.coupons = coupons;
        this.addresses = addresses;
        this.customers = customers;
    }

    /**
     * 載入下單需要的一切。
     *
     * @throws ResourceNotFoundException  地址不存在或不屬於這個客戶（★ 刻意回 404）
     * @throws ProductNotFoundException   有商品不存在
     * @throws CouponNotFoundException    券號不存在
     */
    public OrderContext load(CreateOrderCommand cmd) {

        // ── 地址（授權內建在查詢條件裡 —— 00 章 0.9.4 的第 ② 步）──
        ShippingAddress address = addresses
                .findByIdAndCustomerId(cmd.shippingAddressId(), cmd.actor().id())
                .orElseThrow(() -> new ResourceNotFoundException(
                        "ShippingAddress", cmd.shippingAddressId()));

        // ── 商品（★ 一次查完，不在迴圈裡查）──────────────
        List<String> productIds = cmd.lines().stream()
                .map(CreateOrderCommand.Line::productId)
                .distinct()
                .toList();
        Map<String, Product> productMap = products.findAllById(productIds).stream()
                .collect(Collectors.toMap(Product::id, Function.identity()));

        // ★ 缺哪一個要明確說出來 —— 不要只說「有商品不存在」
        List<String> missing = productIds.stream()
                .filter(id -> !productMap.containsKey(id))
                .toList();
        if (!missing.isEmpty()) {
            throw new ProductNotFoundException(missing);
        }

        // ── 券 ─────────────────────────────────────
        Coupon coupon = null;
        if (cmd.couponCode() != null) {
            coupon = coupons.findByCode(cmd.couponCode())
                    .orElseThrow(() -> new CouponNotFoundException(cmd.couponCode()));
        }

        // ── 客戶等級 ────────────────────────────────
        CustomerSummary customer = customers.summaryOf(cmd.actor().id())
                .orElseThrow(() -> new ResourceNotFoundException("Customer", cmd.actor().id()));

        return new OrderContext(address, productMap, coupon, customer);
    }

    /**
     * ★ 下單所需的一切，已經確定完整。
     *
     * <p>⚠️ {@code product(id)} 不回傳 {@code Optional} —— 因為
     * {@link #load} 已經保證每個 ID 都在。
     * <b>「保證」應該表現在型別上，而不是靠呼叫端記得檢查。</b>
     */
    public record OrderContext(ShippingAddress address,
                               Map<String, Product> products,
                               Coupon coupon,               // 可為 null
                               CustomerSummary customer) {

        public OrderContext {
            products = Map.copyOf(products);
        }

        public Product product(String productId) {
            Product p = products.get(productId);
            if (p == null) {
                // ⚠️ 走到這裡代表 load() 有 bug → IllegalStateException（500）
                throw new IllegalStateException("OrderContext 缺少商品：" + productId);
            }
            return p;
        }
    }
}
```

**再把「產生 Order」也收攏起來：**

```java
package example.shop.order.application;

/**
 * {@code Order} 的工廠。
 *
 * <p>★★ 它封裝了「建立一張訂單需要的三個不確定性來源 + 兩個策略」，
 * 於是 {@code OrderApplicationService} 少了 5 個依賴。
 *
 * <p>⚠️ 而它<b>不是</b>傳話筒，因為它做了一件真正的事：
 * <b>把 {@code CreateOrderCommand}（外面的形狀）+ {@code OrderContext}（查到的資料）
 * 翻譯成 {@code Order.place()} 需要的 {@code PricedLine} 清單。</b>
 *
 * <p>👉 而那個翻譯裡有一個關鍵的安全性質：
 * <b>價格只可能來自 {@code pricingPolicy}</b>——
 * 命令物件上沒有價格欄位（04-controller 1.12.5），
 * {@code PricedLine} 只在這裡被建立。
 */
@Component
public class OrderFactory {

    private final PricingPolicy pricingPolicy;
    private final ShippingFeePolicy shippingFeePolicy;
    private final IdGenerator ids;
    private final OrderNumberGenerator orderNumbers;

    public OrderFactory(PricingPolicy pricingPolicy, ShippingFeePolicy shippingFeePolicy,
                        IdGenerator ids, OrderNumberGenerator orderNumbers) {
        this.pricingPolicy = pricingPolicy;
        this.shippingFeePolicy = shippingFeePolicy;
        this.ids = ids;
        this.orderNumbers = orderNumbers;
    }

    /**
     * @param now 由呼叫端的 {@code Clock} 提供 —— ★ 工廠自己不取時間，
     *            否則「同一個交易裡的時間戳一致」這個保證就破了（00 章 0.5.4）
     */
    public Order create(CreateOrderCommand cmd, OrderDataLoader.OrderContext ctx, Instant now) {

        List<PricedLine> pricedLines = cmd.lines().stream()
                .map(line -> {
                    Product p = ctx.product(line.productId());
                    p.requirePurchasable(now);                     // ★ 規則在 Product
                    Money unitPrice = pricingPolicy.priceOf(p, ctx.customer().level(), now);
                    return new PricedLine(p.id(), p.name(), p.sku(), unitPrice, line.quantity());
                })
                .toList();

        return Order.place(
                ids.newOrderId(),
                orderNumbers.next(now),
                cmd.actor().id(),
                cmd.idempotencyKey(),
                pricedLines,
                ctx.address(),
                ctx.coupon(),
                shippingFeePolicy,
                InvoiceSpec.from(cmd.invoice()),
                cmd.customerNote(),
                now);
    }
}
```

**重構後的 `OrderApplicationService.create()`：**

```java
@Service
public class OrderApplicationService implements OrderService {

    private final OrderRepository orders;
    private final OrderDataLoader loader;          // ★ 取代 4 個 Repository
    private final OrderFactory factory;            // ★ 取代 4 個（2 策略 + 2 產生器）
    private final StockPort stock;
    private final CouponRepository coupons;        // ⚠️ 仍需要 —— tryConsume 是寫入
    private final IdempotencyStore idempotency;
    private final AuditRecorder audit;
    private final DomainEventPublisher events;
    private final Clock clock;

    // 9 個依賴（原本 14），其中「可能失敗的 I/O」4 個（原本 7）

    @Override
    @Transactional
    public Order create(CreateOrderCommand cmd) {
        Instant now = clock.instant();

        // ① 冪等
        var existing = idempotency.findOrderId(cmd.actor().id(), cmd.idempotencyKey());
        if (existing.isPresent()) {
            return orders.findById(existing.get()).orElseThrow(
                    () -> new IllegalStateException("冪等紀錄指向不存在的訂單：" + existing.get()));
        }

        // ② 載入（含授權與「缺資料」的例外）
        var ctx = loader.load(cmd);

        // ③ 扣庫存（原子，越可能失敗的越早做 —— 00 章 0.6.2）
        for (var line : cmd.lines()) {
            if (!stock.tryReserve(line.productId(), line.quantity())) {
                throw insufficientStock(cmd, ctx, line);
            }
        }

        // ④ 建立聚合（★ 業務判斷全部在這裡面）
        Order order = factory.create(cmd, ctx, now);

        // ⑤ 存
        orders.save(order);
        idempotency.record(cmd.actor().id(), cmd.idempotencyKey(), order.id(), now);

        // ⑥ 券計數（原子）
        if (ctx.coupon() != null && !coupons.tryConsume(ctx.coupon().code())) {
            throw new CouponExhaustedException(ctx.coupon().code());
        }

        // ⑦ 稽核（同交易）
        audit.record(AuditEvent.orderPlaced(order, cmd.actor(), now));

        // ⑧ 事件（commit 之後）——★ 定義見 00 章 0.12 ⑬
        events.publish(OrderPlacedEvent.from(order, ctx.customer().email(), now));

        return order;
    }

    /** ★ 錯誤路徑抽成私有方法 —— 讓主流程只剩「步驟」。 */
    private InsufficientStockException insufficientStock(
            CreateOrderCommand cmd, OrderDataLoader.OrderContext ctx,
            CreateOrderCommand.Line line) {
        var snap = stock.snapshot(line.productId());
        var product = ctx.product(line.productId());
        return new InsufficientStockException(
                line.productId(), product.name(), line.quantity(),
                snap.map(StockSnapshot::available).orElse(0),
                snap.map(StockSnapshot::restockEstimatedAt).orElse(null),
                cmd.lines().indexOf(line));
    }
}
```

**從 60 行變成 30 行，8 個編號的步驟，沒有一個業務 `if`。**

⚠️ **但要誠實說一件事**：這個重構**沒有減少總複雜度**，
它只是把複雜度**分類**了：

| 類別 | 在哪 |
|---|---|
| 「怎麼取資料 + 缺資料怎麼辦」 | `OrderDataLoader` |
| 「怎麼把命令變成聚合」 | `OrderFactory` |
| 「步驟的順序 + 交易邊界」 | `OrderApplicationService` |
| 「業務規則」 | `Order`、`Product`、`Coupon`、policies |

> 📌 **這才是分層的實際意義**：
> **不是「程式碼變少」，是「讀任何一個檔案時腦裡只需要裝一種東西」。**

### 1.2.6 shop-service 的實際切法

| 類別 | 職責 | 依賴數 | I/O 依賴 | 交易 |
|---|---|---|---|---|
| `OrderApplicationService` | 訂單的 5 個命令 | 9 | 4 | `@Transactional` |
| `OrderQueryService` | 訂單的 3 個查詢 | 2 | 1 | `readOnly = true` |
| `OrderDataLoader` | 下單的資料載入 | 4 | 4 | ❌ 無（在呼叫端的交易裡） |
| `OrderFactory` | 建立聚合 | 4 | 0 | ❌ 無 |
| `OrderPaymentService` | 付款、退款（★ 獨立，因為有 `REQUIRES_NEW`） | 7 | 4 | 混合 |
| `OrderExportService` | CSV 匯出（★ 獨立，有自己的儲存與佇列） | 5 | 3 | 混合 |
| `OrderExpirationJob` | 排程：逾期未付款自動取消 | 4 | 2 | `@Transactional` |
| `CouponApplicationService` | 券的命令 | 3 | 2 | `@Transactional` |
| `StockApplicationService` | 庫存的命令（盤點、補貨） | 3 | 2 | `@Transactional` |

⚠️ **`OrderPaymentService` 為什麼獨立？**
因為 00 章練習 4 的答案：付款流程需要
「先 `REQUIRES_NEW` commit 一筆 PENDING → 交易外呼叫金流 → 再開交易更新」。

**那是一個完全不同的交易形狀**，把它跟 `create()` 放在同一個類別，
讀者會以為它們的交易語意一樣。

> 📌 **「交易形狀不同」是拆 Service 最強的理由之一** ——
> 比「依賴太多」更強，因為它關係到正確性而不只是整潔。

---
## 1.3 介面還是直接寫實作 ★★

**這是本章爭議最大的一節。**

Java 專案有一個幾乎沒有人質疑的慣例：

```
OrderService.java          ← 介面
OrderServiceImpl.java      ← 唯一的實作
```

**問題**：這個介面提供了什麼？

### 1.3.1 這個慣例從哪裡來

它有真實的歷史來源，而且**每一個來源都已經失效了**：

| 年代 | 為什麼需要介面 | 現在還成立嗎 |
|---|---|---|
| **EJB 2.x（1999～2006）** | 規範強制要求 Home + Remote 介面 | ❌ EJB 3 就取消了 |
| **Spring 1.x～3.x 的 AOP（2003～2011）** | 預設用 JDK 動態代理，**沒有介面就不能代理** | ❌ Spring 4.3 起 `proxyTargetClass` 已可用；**Boot 2.0 起 CGLIB 是預設值** |
| **早期的 mock 框架** | EasyMock / jMock 只能 mock 介面 | ❌ Mockito 2+ 用 ByteBuddy，可以 mock 具體類別（甚至 final，加 inline mock maker） |
| **「為了以後可能有第二個實作」** | | ⚠️ **這是預測未來，而預測通常是錯的** |
| **DIP（依賴反轉原則）** | 「高層模組不該依賴低層模組」 | ⚠️ **經常被誤用**，見 1.3.2 ⑤ |
| **團隊分工（介面先定，兩邊平行開發）** | | ✅ **這個仍然成立**，但它是流程理由不是設計理由 |

⚠️ **「Boot 2.0 起 CGLIB 是預設值」這件事很多人不知道，而它推翻了最主要的技術理由。**

```java
// Spring Boot 的 TransactionAutoConfiguration（決定 @Transactional 用哪種代理）
@Configuration(proxyBeanMethods = false)
@EnableTransactionManagement(proxyTargetClass = true)
@ConditionalOnProperty(prefix = "spring.aop", name = "proxy-target-class",
                       havingValue = "true", matchIfMissing = true)
//                                            ^^^^^^^^^^^^^^^^^^^^^ ★ 預設 true
static class CglibAutoProxyConfiguration { }
```

⚠️ **注意是 `TransactionAutoConfiguration` 而不是 `AopAutoConfiguration`。**
兩者讀**同一個屬性**（`spring.aop.proxy-target-class`），
但前者管 `@Transactional`、後者管 AspectJ 的 `@Aspect`。

👉 **實務上的意義**：`spring.aop.proxy-target-class=false` 會**同時**
把兩者切回 JDK 動態代理 —— 於是「沒有介面的 Service」上的
`@Transactional` 會在啟動時就失敗（`BeanNotOfRequiredTypeException`），
而不是靜默失效。**這是少數「切回舊行為反而比較安全」的設定。**

**驗證它**：

```java
@SpringBootTest
class ProxyTypeTest {

    @Autowired OrderApplicationService service;   // ★ 注入的是具體類別，不是介面

    @Test
    void 預設用CGLIB代理() {
        assertThat(AopUtils.isCglibProxy(service)).isTrue();
        assertThat(AopUtils.isJdkDynamicProxy(service)).isFalse();
        // ★★ 而它有 @Transactional，代理是必要的 —— 這證明「沒有介面也能有交易」
        assertThat(service.getClass().getName()).contains("$$SpringCGLIB$$");
    }
}
```

⚠️ **但 CGLIB 代理有三個限制**（02 章 2.7.2 會再講）：

| 限制 | 後果 |
|---|---|
| 類別不能是 `final` | **啟動失敗**（`AopConfigException: Cannot subclass final class`）。⚠️ 是執行期，不是編譯期 —— 所以只有真的把應用跑起來才會發現 |
| 方法不能是 `final`、`private` 或 `static` | ⚠️⚠️ **靜默失效** —— `@Transactional` 完全沒有作用，而且**沒有任何警告** |
| 方法必須是 `public` | ⚠️ 同樣靜默 —— `AnnotationTransactionAttributeSource` 預設 `publicMethodsOnly = true`，所以 `protected` / package-private 上的註解會被忽略 |
| 需要可存取的無參或可代理的建構子 | ⚠️ Spring 用 Objenesis 繞過建構子，一般不成問題 |

> 📌 **第二點是真實的危險**：一個 `final` 方法上的 `@Transactional`
> **不會有任何警告**，它就是沒有交易。
> 而 00 章 0.11.2 的 ArchUnit `transactional方法必須是public` 抓的是 private，
> 沒有抓 `final` —— 補上它：

```java
@ArchTest
static final ArchRule transactional方法不可為final =
        methods().that().areAnnotatedWith(Transactional.class)
                 .should().notBeFinal()
                 .because("CGLIB 無法覆寫 final 方法 → @Transactional 靜默失效");
```

### 1.3.2 六個常見理由，逐一檢驗

**① 「為了可以 mock」**

```java
// ✅ Mockito 可以 mock 具體類別
@Mock OrderApplicationService service;         // 不需要介面
```

⚠️ **但有一個真實的差別**：

```java
// mock 介面：只會回傳預設值（null / 0 / false），不會執行任何真實邏輯
@Mock OrderService service;

// mock 具體類別：也是一樣（Mockito 用 ByteBuddy 產生子類別並覆寫所有方法）
@Mock OrderApplicationService service;
```

**兩者行為相同**，除了：

| 情況 | 介面 | 具體類別 |
|---|---|---|
| 類別是 `final` | — | ❌ 需要 inline mock maker |
| 方法是 `final` | — | 🔴 **不會被 mock，會執行真的邏輯**（很難察覺） |
| 建構子有副作用 | — | ⚠️ Mockito 不呼叫建構子，所以沒問題 |

> 📌 **結論**：「為了 mock」在 2026 年**不是**一個需要介面的理由，
> 但如果你的類別或方法有 `final`，那是。

**② 「為了以後換實作」**

⚠️ **問一個具體的問題**：你上一次「換掉一個 Service 的實作」是什麼時候？

實務上「換實作」通常不是「換一個類別」，而是「**改那個類別**」。
而**改一個類別不需要介面**。

**真正會換實作的是**：

```
✅ 外部系統的轉接器（金流商 A → 金流商 B）
✅ 儲存（本機檔案 → S3）
✅ 通知管道（Email → Email + SMS + App push）
✅ 策略（2026 運費方案 → 2027 運費方案）
❌ 「訂單的商業邏輯」—— 它只有一種，就是你們公司的那一種
```

> 📌 **判準**：
> **「這個東西的第二個實作會是『另一個廠商 / 另一種技術 / 另一個方案』嗎？」**
> 是 → 需要介面（那是埠，1.7）。
> 「另一種寫法」→ 不需要。

**③ 「介面是契約，實作是細節」**

⚠️ **這個說法在單一實作時是空的** ——
因為介面的內容完全由那個實作決定，
**改實作的簽章時介面一起改**，它沒有隔離任何變更。

**測試它**：找一個 `XxxServiceImpl`，看它的 git 歷史。
**每一次介面改動，是不是都伴隨實作改動？**
如果是，那個介面沒有提供隔離。

✅ **但有一個例外**：如果介面在**另一個 module**，
而呼叫端只編譯得到介面，那它就真的是契約（1.3.3 的情況 ④）。

**④ 「介面讓 javadoc 有一個好地方放」**

⚠️ **這個理由意外地強。**

00 章 0.9.1 的 `OrderService` javadoc 列出了每個方法會拋什麼例外
（04-controller 0.14 練習 4 的那份清單），而那份清單是 Controller 與 Service 之間的實質契約。

**但它不需要介面** —— javadoc 放在具體類別上一樣有效，
IDE 一樣顯示，`mvn javadoc` 一樣產生。

> ⚠️ **除了一種情況**：介面上的 javadoc 在**多個實作**時是「共同契約」，
> 而寫在其中一個實作上就變成「那一個實作的說明」。

**⑤ 「DIP 說要依賴抽象」**

**這是最常被誤用的一個。** DIP 的原文是：

> High-level modules should not depend on low-level modules.
> **Both should depend on abstractions.**

⚠️ **關鍵是「方向」**。DIP 要解的是：

```
🔴 沒有 DIP：
   OrderApplicationService（高層，業務）
        ↓ 依賴
   JdbcOrderRepository（低層，技術）
   → 換資料庫要改業務程式碼

✅ 有 DIP：
   OrderApplicationService（高層）
        ↓ 依賴
   OrderRepository（介面，★ 定義在高層那一側）
        ↑ 實作
   JdbcOrderRepository（低層）
   → 換資料庫只改低層
```

**注意 DIP 說的是「Repository / 外部系統」那一側的介面**，
而不是「每一個類別都要有介面」。

> 📌 **`OrderService` 這個介面在 DIP 的框架下是什麼？**
> `OrderController`（Web，可以視為「低層」的入口轉接器）
> 依賴 `OrderService`（高層的業務）。
> **依賴方向已經是「往業務」了 —— DIP 沒有被違反，即使沒有介面。**

⚠️ **但有一個反駁值得認真對待**：如果 Web 層直接依賴
`OrderApplicationService` 這個**類別**，那麼 Web 層就依賴了
「Application 層的一個具體型別」，而那個型別的簽章改變會直接影響 Web 層。

**回應**：那個影響**本來就存在**（介面改了 Web 層也要改）。
介面只是讓「改動」變成「兩個檔案的改動」而不是一個。

**⑥ 「團隊平行開發」**

✅ **這個理由成立，而且它是唯一完全成立的一個。**

如果 Controller 與 Service 由不同的人／不同的 sprint 完成
（**這正是 04-controller 站與 05 章的關係**），
先定介面讓兩邊可以平行動工，而且 Controller 的測試可以先用 stub 寫。

⚠️ **但它是「流程理由」不是「設計理由」** ——
意思是：**開發完成之後，那個介面可以被移除**，
如果它已經沒有其他價值。

### 1.3.3 介面真正有價值的五種情況

| # | 情況 | 例子（shop-service） |
|---|---|---|
| ① | **真的有多個實作** | `ShippingFeePolicy2026` / `2027`、`PricingPolicy` 的 A/B 測試版本 |
| ② | **實作在另一個 module / 由別人提供** | `PaymentGateway` 的三個金流商實作 |
| ③ | **實作要在測試裡整批替換** | `OrderRepository`（記憶體 vs JDBC vs JPA） |
| ④ | **跨越編譯邊界**（Maven module / 微服務的 client jar） | `OrderService` **如果** web 與 application 是兩個 module |
| ⑤ | **需要動態代理而類別無法被 CGLIB 代理** | 類別是 `final`、或需要 JDK 代理的特殊場景 |

⚠️ **③ 需要展開，因為它是這一站最實際的一個。**

00 章說「Repository 先用記憶體假實作」。那件事**必須**有介面：

```java
// 埠（介面）
public interface OrderRepository { … }

// 本站：記憶體假實作
@Repository
@Profile("!jdbc")
public class InMemoryOrderRepository implements OrderRepository {
    private final Map<String, Order> store = new ConcurrentHashMap<>();
    // …
}

// 06 站：真的實作
@Repository
@Profile("jdbc")
public class JdbcOrderRepository implements OrderRepository { … }
```

> 📌 **而這正好說明了「介面的價值取決於它兩側有什麼」**：
> `OrderRepository` 有兩個實作 → 介面有價值。
> `OrderService` 只有一個實作 → 介面的價值只剩「平行開發」（已完成）。

### 1.3.4 決策表

```
                ┌────────────────────────────────────┐
                │ 我需要為這個類別建一個介面嗎？        │
                └─────────────┬──────────────────────┘
                              ▼
              ┌───────────────────────────────────┐
              │ 現在（不是「以後」）有第二個實作嗎？  │
              └────┬──────────────────────────┬───┘
                有 │                          │ 沒有
                   ▼                          ▼
              ┌─────────┐    ┌────────────────────────────────────┐
              │ ✅ 要介面 │    │ 它是「外部系統 / 技術選擇」的邊界嗎？│
              └─────────┘    │（DB、HTTP、佇列、檔案、金流）        │
                             └────┬──────────────────────────┬────┘
                                是 │                          │ 否
                                   ▼                          ▼
                             ┌─────────┐   ┌──────────────────────────────────┐
                             │ ✅ 要介面 │   │ 測試需要一個「非 mock 的替代實作」嗎？│
                             │（埠 1.7） │   │（in-memory、fake、stub）           │
                             └─────────┘   └────┬────────────────────────┬────┘
                                              是 │                        │ 否
                                                 ▼                        ▼
                                           ┌─────────┐    ┌────────────────────────┐
                                           │ ✅ 要介面 │    │ 跨越 module 編譯邊界嗎？ │
                                           └─────────┘    └───┬────────────────┬───┘
                                                            是 │                │ 否
                                                               ▼                ▼
                                                        ┌─────────┐   ┌──────────────┐
                                                        │ ✅ 要介面 │   │ ❌ 不需要介面  │
                                                        └─────────┘   │ 直接寫類別     │
                                                                      └──────────────┘
```

### 1.3.5 shop-service 的決定

| 類別 | 有介面？ | 理由 |
|---|---|---|
| `OrderApplicationService` | ⚠️ **有 `OrderService`，但保留是妥協** | 04-controller 站的 70 條端點與 350 個測試都注入它。改動成本 > 收益 |
| `OrderQueryService` | ❌ 沒有 | ★ 本站新增，沒有既有包袱 → 直接寫類別 |
| `OrderDataLoader` | ❌ 沒有 | 它是 `OrderApplicationService` 的內部細節（甚至可以是 package-private） |
| `OrderFactory` | ❌ 沒有 | 同上 |
| `OrderPaymentService` | ❌ 沒有 | ★ 本站新增 |
| `OrderRepository` | ✅ 有 | 情況 ③（記憶體 vs JDBC vs JPA） |
| `StockPort` | ✅ 有 | 情況 ②（之後可能接外部 WMS） |
| `PaymentGateway` | ✅ 有 | 情況 ①②（三個金流商） |
| `ErpPort` | ✅ 有 | 情況 ② |
| `PricingPolicy` | ✅ 有 | 情況 ①（A/B 測試不同定價） |
| `ShippingFeePolicy` | ✅ 有 | 情況 ①（年度方案） |
| `DomainEventPublisher` | ✅ 有 | ⚠️ **這一個可辯論** —— 見下方 |
| `IdGenerator` | ✅ 有 | 情況 ③（測試要固定 ID） |
| `Clock` | ✅ 是 JDK 的抽象類別 | 情況 ③ |
| `AuditRecorder` | ✅ 有 | 情況 ②（稽核之後可能送到 Kafka / 外部 SIEM） |

⚠️ **`DomainEventPublisher` 的辯論**（00 章 0.12 ⑩ 已提過）：

**支持有介面**：Application Service 不依賴 `org.springframework` 的型別，
測試的斷言讀起來是領域語言（`then(events).should().publish(any())`）。

**反對**：`ApplicationEventPublisher` **本身就是介面**，
而它可以直接被 mock。多包一層是 1.7.4 的「過度設計」。

> **shop-service 選「有」**，但這是一個**弱決定** ——
> 如果團隊覺得多餘，直接注入 `ApplicationEventPublisher` 是完全合理的。
> ⚠️ **重點不是選哪一邊，是知道這是一個 5 分鐘的決定而不是原則問題。**

### 1.3.6 怎麼安全地拿掉一個介面

如果你決定移除 `XxxService` 介面，**照這個順序做**：

```
1. 確認沒有第二個實作（IDE 的 "Show Implementations"）
2. 確認不是跨 module 被引用（mvn dependency:tree / IDE 的 Find Usages）
3. 確認測試沒有用 @MockBean XxxService（有的話一起改成具體類別）
4. IDE 的「Inline Interface / Push Members Down」重構
   ⚠️ IntelliJ：對介面按 F6 → "Use interface where possible" 反向操作
      實務上更簡單的做法是：
      ① 把 XxxServiceImpl 改名成 XxxService（Shift+F6）
      ② 刪掉原本的介面（此時編譯錯誤會指出所有引用點）
      ③ 讓 IDE 修掉 import
5. 檢查 @Transactional 仍然生效 ★★
```

⚠️ **第 5 步不可以跳。** 拿掉介面之後代理從 JDK 動態代理變成 CGLIB，
而 CGLIB 無法代理 `final` / `private` 方法。

**寫一個守門測試**：

```java
package example.shop.order.application;

/**
 * ★★ 拿掉介面之後，交易仍然生效嗎？
 *
 * <p>它抓的是 1.3.1 那個「靜默失效」——
 * {@code @Transactional} 加在 CGLIB 無法覆寫的方法上，
 * <b>不會有任何警告</b>，程式只是沒有交易。
 */
@SpringBootTest
class TransactionalProxyTest {

    @Autowired OrderApplicationService service;
    @Autowired ApplicationContext context;

    @Test
    void 是CGLIB代理() {
        assertThat(AopUtils.isAopProxy(service))
                .as("如果不是代理，@Transactional 完全沒有作用")
                .isTrue();
    }

    /**
     * ★★ 更嚴格的檢查：<b>每一個標了 @Transactional 的方法都真的被攔截</b>。
     *
     * <p>它掃描所有 bean，找出「有 @Transactional 但代理攔不到」的方法。
     */
    @Test
    void 所有Transactional方法都被代理攔截() {
        var broken = new ArrayList<String>();

        for (String name : context.getBeanDefinitionNames()) {
            Object bean;
            try {
                bean = context.getBean(name);
            } catch (Exception e) {
                continue;                       // 有些 bean 不能被提早初始化
            }
            Class<?> target = AopUtils.getTargetClass(bean);
            if (!target.getName().startsWith("example.shop")) continue;

            for (Method m : target.getDeclaredMethods()) {
                if (!m.isAnnotationPresent(Transactional.class)) continue;

                if (Modifier.isFinal(m.getModifiers())) {
                    broken.add(target.getSimpleName() + "." + m.getName() + "（final）");
                }
                if (Modifier.isPrivate(m.getModifiers())) {
                    broken.add(target.getSimpleName() + "." + m.getName() + "（private）");
                }
                if (Modifier.isStatic(m.getModifiers())) {
                    broken.add(target.getSimpleName() + "." + m.getName() + "（static）");
                }
                if (!Modifier.isPublic(m.getModifiers())
                        && !Modifier.isPrivate(m.getModifiers())) {
                    // ⚠️ protected / package-private：CGLIB 可以覆寫 protected，
                    //    但 Spring 的 AnnotationTransactionAttributeSource 預設
                    //    只處理 public 方法 → 一樣失效
                    broken.add(target.getSimpleName() + "." + m.getName() + "（非 public）");
                }
            }
            // ★ 有 @Transactional 方法但這個 bean 不是代理 → 一定失效
            boolean hasTx = java.util.Arrays.stream(target.getDeclaredMethods())
                    .anyMatch(m -> m.isAnnotationPresent(Transactional.class))
                    || target.isAnnotationPresent(Transactional.class);
            if (hasTx && !AopUtils.isAopProxy(bean)) {
                broken.add(target.getSimpleName() + "（整個 bean 沒有被代理）");
            }
        }

        assertThat(broken)
                .as("這些 @Transactional 不會生效（1.3.1 的三個 CGLIB 限制）")
                .isEmpty();
    }
}
```

⚠️ **這個測試比 00 章的 ArchUnit 規則更強**，因為它檢查的是
**執行期真的被代理了**，而不只是「宣告上看起來對」。

> 📌 **兩者都要有**：
> ArchUnit 在編譯後立刻跑（快，2 秒），
> 這個測試需要完整的 Spring context（慢，8 秒）但更可靠。

---

## 1.4 依賴注入的實務細節

### 1.4.1 建構子注入（Service 的角度）

04-controller 0.10.4 從「Controller 的依賴數量會被藏起來」的角度講過。
**Service 層還有三個 Controller 沒有的理由：**

**① `final` 讓「交易中途換掉依賴」不可能**

```java
// 🔴 欄位注入
@Autowired private OrderRepository orders;    // 可以被改

// 某個地方（例如測試工具、或一個 @PostConstruct）
ReflectionTestUtils.setField(service, "orders", anotherRepo);
// → 執行期行為改變，而且改變是全域的（Service 是 singleton）
```

**② 不靠 Spring 也能建立 → domain-adjacent 的測試可以很快**

```java
// ✅ 建構子注入
var service = new OrderApplicationService(
        new InMemoryOrderRepository(),
        new OrderDataLoader(products, coupons, addresses, customers),
        new OrderFactory(new DefaultPricingPolicy(), new ShippingFeePolicy2026(),
                         new FixedIdGenerator("ord_1"), new FixedOrderNumberGenerator()),
        new InMemoryStockPort(Map.of("P-1", 10)),
        // …
        Clock.fixed(NOW, UTC));
```

⚠️ **這種「用 fake 而不是 mock」的測試比 Mockito 版本更好，因為**：

| | Mockito | Fake（in-memory 實作） |
|---|---|---|
| 需要 stub 每個呼叫 | ✅ 要 | ❌ 不用 |
| 沒 stub 的呼叫 | 🔴 **回 `null`**（04-controller 7.2.3 的陷阱） | ✅ 行為正確 |
| 測「存進去再讀出來」 | 🔴 要自己 stub 兩次 | ✅ 天然支援 |
| 測「兩次呼叫互相影響」 | 🔴 幾乎不可能 | ✅ 天然支援 |
| 驗證「有沒有被呼叫」 | ✅ `verify` | ⚠️ 要自己記錄 |

**shop-service 的做法**：**兩種都用**，依測試目的選：

```
測「編排的交互」（誰被呼叫了、參數對不對）→ Mockito
測「行為的結果」（存進去的訂單長什麼樣）  → Fake
```

**③ 循環依賴會在啟動時失敗而不是執行期 NPE**

1.6 會展開。

### 1.4.2 Lombok `@RequiredArgsConstructor` 的取捨

```java
// ── 寫法 A：手寫建構子（04-controller 站與 00 章一路用的）─────────
@Service
public class OrderApplicationService {
    private final OrderRepository orders;
    private final OrderDataLoader loader;
    // … 9 個欄位

    public OrderApplicationService(OrderRepository orders, OrderDataLoader loader, …) {
        this.orders = orders;
        this.loader = loader;
        // … 9 行賦值
    }
}
```

```java
// ── 寫法 B：Lombok ────────────────────────────────
@Service
@RequiredArgsConstructor
public class OrderApplicationService {
    private final OrderRepository orders;
    private final OrderDataLoader loader;
    // … 9 個欄位，沒有建構子
}
```

| | 手寫 | Lombok |
|---|---|---|
| 行數 | 9 欄位 + 11 行建構子 = 20 | 9 |
| **依賴數量的「刺眼感」** | ✅ 建構子很長，review 時很明顯 | 🔴 **消失了** —— 加一個欄位只有一行 |
| 加欄位的成本 | 2 處（欄位 + 建構子） | 1 處 |
| 加 `@Qualifier` | ✅ 直接寫在參數上 | ⚠️ 要用 `@Qualifier` 在欄位上 + `lombok.copyableAnnotations` 設定 |
| 建構子裡做驗證 | ✅ 可以 | ❌ 不行（要改用 `@NonNull` 或手寫） |
| IDE 找建構子呼叫者 | ✅ 直接 | ⚠️ 要先 delombok |

⚠️ **`@Qualifier` 那一列是真實的坑：**

```java
// 🔴 Lombok 預設不會把 @Qualifier 複製到建構子參數上
@RequiredArgsConstructor
public class NotificationService {
    @Qualifier("smsSender") private final MessageSender sender;   // ← 註解遺失
}
```

**解法**：在專案根目錄放 `lombok.config`：

```properties
# lombok.config
config.stopBubbling = true
lombok.copyableAnnotations += org.springframework.beans.factory.annotation.Qualifier
lombok.copyableAnnotations += org.springframework.beans.factory.annotation.Value
```

> ⚠️ **這個檔案很容易被漏掉**（它不在 `pom.xml` 裡，新人不會注意到），
> 而漏掉的症狀是「注入到錯的實作」——**而且啟動時不會報錯**。

**shop-service 的決定**：

> **課程一律手寫建構子**，理由是「讓依賴清單可見」（04-controller 0.10.4 的同一個理由）。
>
> ⚠️ **但實務上團隊用 Lombok 是完全合理的** ——
> 前提是：① 有 `lombok.config`；
> ② 有一個「依賴數上限」的檢查（例如 ArchUnit 或 checkstyle），
> 補回 Lombok 拿掉的那個「刺眼感」。

```java
// ★ 補回「刺眼感」的守門測試
@ArchTest
static final ArchRule 依賴數不可超過十個 = classes()
        .that().areAnnotatedWith(Service.class)
        .should(new ArchCondition<JavaClass>("最多 10 個建構子參數") {
            @Override
            public void check(JavaClass clazz, ConditionEvents events) {
                clazz.getConstructors().forEach(c -> {
                    int n = c.getRawParameterTypes().size();
                    if (n > 10) {
                        events.add(SimpleConditionEvent.violated(c,
                                "%s 有 %d 個依賴（上限 10）—— 考慮 1.2.3～1.2.5 的三種拆法"
                                        .formatted(clazz.getSimpleName(), n)));
                    }
                });
            }
        });
```

### 1.4.3 `Optional<T>`、`ObjectProvider<T>`、`@Lazy`

**三個「不是必要依賴」的表達方式，用途完全不同：**

**① `Optional<T>`：這個依賴可能不存在**

```java
@Service
public class OrderApplicationService {

    private final Optional<FraudDetector> fraudDetector;   // ★ 可能沒有

    public OrderApplicationService(Optional<FraudDetector> fraudDetector) {
        this.fraudDetector = fraudDetector;
    }

    @Transactional
    public Order create(CreateOrderCommand cmd) {
        // ⚠️ 而 fraudDetector 只在 production profile 有
        fraudDetector.ifPresent(d -> d.check(cmd));
        // …
    }
}
```

⚠️ **`Optional` 當欄位是一般被反對的做法**（`Optional` 設計上是回傳型別），
但**這是一個公認的例外** —— Spring 明確支援它，而且它表達的正是「可能不存在」。

**替代方案（通常更好）**：**空物件模式**

```java
// ✅ 永遠有一個實作，只是有一個什麼都不做
public interface FraudDetector {
    void check(CreateOrderCommand cmd);

    /** ★ 沒有啟用時的實作。 */
    FraudDetector NOOP = cmd -> { };
}

@Bean
@ConditionalOnMissingBean(FraudDetector.class)
public FraudDetector noopFraudDetector() {
    return FraudDetector.NOOP;
}
```

> 📌 **好處**：Service 裡沒有 `if` 也沒有 `ifPresent`。
> **「這個功能有沒有啟用」變成組態的事，不是業務程式碼的事。**

**② `ObjectProvider<T>`：延後取得，或取得「零到多個」**

```java
@Service
public class NotificationDispatcher {

    /** ★ 取得「所有」的通知管道，而且是延後的（新增一個實作不用改這裡）。 */
    private final ObjectProvider<NotificationChannel> channels;

    public NotificationDispatcher(ObjectProvider<NotificationChannel> channels) {
        this.channels = channels;
    }

    public void dispatch(OrderPlacedEvent event) {
        channels.orderedStream()             // ★ 依 @Order 排序
                .forEach(c -> {
                    try {
                        c.send(event);
                    } catch (Exception e) {
                        // ⚠️ 一個管道失敗不影響其他管道 —— 這是 dispatcher 的職責
                        log.warn("通知管道 {} 失敗", c.name(), e);
                    }
                });
    }
}
```

⚠️ **`ObjectProvider` vs `List<T>` 的差別**：

| | `List<NotificationChannel>` | `ObjectProvider<NotificationChannel>` |
|---|---|---|
| 沒有任何實作時 | 🔴 **啟動失敗**（`NoSuchBeanDefinitionException`）⚠️ 除非用 `@Autowired(required=false)` | ✅ 空 stream |
| 取得時機 | 建構時 | **使用時**（打破循環依賴的合法手段，1.6.4） |
| 排序 | ✅ 支援 `@Order` | ✅ `orderedStream()` |

**③ `@Lazy`：延後初始化這個 bean**

```java
@Service
public class OrderApplicationService {
    public OrderApplicationService(@Lazy ExpensiveThing thing) { … }
}
```

⚠️ **它會注入一個代理，第一次呼叫時才真正建立目標 bean。**

**它是打破循環依賴最常見、也最糟的做法**（1.6.4 會解釋為什麼）。

**唯一合理的用途**：那個 bean 的初始化真的很貴（例如載入一個 200 MB 的模型），
而它只在少數請求會用到。

### 1.4.4 同一介面多個實作

**四種做法，適用情況完全不同。**

**做法 ①：`@Qualifier` —— 靜態選擇，編譯期決定**

```java
public interface PaymentGateway {
    ChargeResult charge(ChargeRequest request);
    String providerCode();
}

@Component("tapPay")
public class TapPayGateway implements PaymentGateway { … }

@Component("newebPay")
public class NewebPayGateway implements PaymentGateway { … }
```

```java
@Service
public class RefundService {
    private final PaymentGateway gateway;

    // ★ 明確指定 —— 適合「這個功能只用這一家」
    public RefundService(@Qualifier("tapPay") PaymentGateway gateway) {
        this.gateway = gateway;
    }
}
```

⚠️ **`@Qualifier` 的字串是弱型別的。** 打錯字 → 啟動失敗（好），
但改了 bean 名字 → 所有 `@Qualifier` 都要改（而編譯器不會提醒）。

**改進：自訂的 qualifier 註解**

```java
@Qualifier
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.FIELD, ElementType.METHOD, ElementType.PARAMETER, ElementType.TYPE})
public @interface TapPay { }
```

```java
@Component @TapPay
public class TapPayGateway implements PaymentGateway { … }

public RefundService(@TapPay PaymentGateway gateway) { … }
//                   ^^^^^^^ ★ 打錯字 = 編譯錯誤
```

**做法 ②：`Map<String, T>` —— 執行期依 key 選擇**

```java
@Service
public class PaymentDispatcher {

    /** ★ Spring 會注入「bean 名稱 → 實例」的 Map。 */
    private final Map<String, PaymentGateway> gateways;

    public PaymentDispatcher(Map<String, PaymentGateway> gateways) {
        this.gateways = gateways;
    }

    public ChargeResult charge(String provider, ChargeRequest request) {
        PaymentGateway gateway = gateways.get(provider);
        if (gateway == null) {
            throw new PaymentMethodUnsupportedException(provider, gateways.keySet());
        }
        return gateway.charge(request);
    }
}
```

⚠️ **它有一個隱藏的耦合**：Map 的 key 是**bean 名稱**，
而 bean 名稱來自 `@Component("tapPay")` 或類別名的首字小寫。

**於是「重新命名一個類別」會改變 API 的行為** —— 那非常糟。

**做法 ③：策略註冊表 —— 讓實作自己宣告它處理什麼 ★ 推薦**

```java
public interface PaymentGateway {

    /** ★★ 由實作自己宣告它支援哪些付款方式 —— key 的來源是型別安全的。 */
    Set<PaymentMethod> supportedMethods();

    ChargeResult charge(ChargeRequest request);
}
```

```java
@Component
public class PaymentGatewayRegistry {

    private final Map<PaymentMethod, PaymentGateway> byMethod;

    /**
     * @param gateways ★ 注入「所有」實作 —— 新增一個金流商不用改這個類別
     */
    public PaymentGatewayRegistry(List<PaymentGateway> gateways) {
        var map = new EnumMap<PaymentMethod, PaymentGateway>(PaymentMethod.class);
        for (PaymentGateway g : gateways) {
            for (PaymentMethod m : g.supportedMethods()) {
                PaymentGateway previous = map.put(m, g);
                // ★★ 啟動時就抓到「兩個實作都說自己處理信用卡」
                if (previous != null) {
                    throw new IllegalStateException(
                            "付款方式 %s 有兩個 gateway：%s 與 %s"
                                    .formatted(m, previous.getClass().getSimpleName(),
                                               g.getClass().getSimpleName()));
                }
            }
        }
        this.byMethod = map;

        // ★★ 啟動時就抓到「有付款方式沒有 gateway」
        var missing = EnumSet.allOf(PaymentMethod.class);
        missing.removeAll(map.keySet());
        if (!missing.isEmpty()) {
            // ⚠️ 用 log.warn 而不是拋例外 —— 因為 local profile 可能刻意只裝一家
            log.warn("以下付款方式沒有對應的 gateway，呼叫時會回 422：{}", missing);
        }
    }

    public PaymentGateway forMethod(PaymentMethod method) {
        PaymentGateway g = byMethod.get(method);
        if (g == null) {
            throw new PaymentMethodUnsupportedException(method, byMethod.keySet());
        }
        return g;
    }
}
```

**三個好處：**

| 好處 | 說明 |
|---|---|
| **key 是 enum，型別安全** | 改名 / 刪除 enum 值會編譯錯誤 |
| **新增實作不用改任何既有程式碼** | 開放封閉原則的實際樣子 |
| **★ 衝突與遺漏在啟動時就發現** | 而不是「使用者選了那個付款方式才 500」 |

⚠️ **最後一點是這個做法最大的價值。**
用 `Map<String, T>` 的版本，「沒有對應的 gateway」只有在
**真的有人用那個付款方式時**才會發現 —— 而那通常是上線之後。

**做法 ④：`@ConditionalOnProperty` —— 用設定檔選一個**

```java
@Configuration
public class ShippingFeeConfig {

    @Bean
    @ConditionalOnProperty(name = "shop.shipping.policy", havingValue = "2026",
                           matchIfMissing = true)
    public ShippingFeePolicy shippingFeePolicy2026() {
        return new ShippingFeePolicy2026();
    }

    @Bean
    @ConditionalOnProperty(name = "shop.shipping.policy", havingValue = "2027")
    public ShippingFeePolicy shippingFeePolicy2027() {
        return new ShippingFeePolicy2027();
    }
}
```

⚠️ **`matchIfMissing = true` 那一行很重要** ——
沒有它，設定檔漏了那個 key 時**沒有任何 `ShippingFeePolicy` bean**，
於是啟動失敗（訊息是「找不到 ShippingFeePolicy」而不是「設定檔漏了」）。

> 📌 **一般規則**：`@ConditionalOnProperty` 的一組 bean，
> **一定要有一個 `matchIfMissing = true` 的預設**，
> 並在 yaml 裡把那個 key **明確寫出來**（即使它是預設值）——
> 讓「現在用哪一個」是可讀的。

**四種做法的決策表：**

| 情況 | 用哪個 |
|---|---|
| 這個呼叫點固定用某一個實作 | ① `@Qualifier`（自訂註解版） |
| 依請求內容動態選，key 是 enum 或值物件 | **③ 註冊表** |
| 依請求內容動態選，key 是任意字串 | ② `Map`（⚠️ 但要有一層明確的 key 對應，不要用 bean 名） |
| 依環境 / 版本選一個，其他不載入 | ④ `@ConditionalOnProperty` |
| 全部都要用（通知管道、驗證器） | `List<T>` 或 `ObjectProvider<T>` |

---
### 1.4.5 `@Value` 還是 `@ConfigurationProperties`

```java
// 🔴 散落的 @Value
@Service
public class OrderApplicationService {

    @Value("${shop.order.max-lines:50}")
    private int maxLines;

    @Value("${shop.order.payment-window-minutes:30}")
    private int paymentWindowMinutes;
}
```

**六個問題：**

| 問題 | 說明 |
|---|---|
| **欄位注入** | 不能 `final`，不能在建構子驗證，不能不靠 Spring 建立物件 |
| **打錯 key 不會報錯** | 有預設值時 `${shop.order.maxLines}`（駝峰）會靜默用預設值 |
| **型別轉換失敗在啟動後才發現** | ⚠️ 只有那個 bean 被建立時 |
| **沒有集中的文件** | 「這個服務有哪些設定」要 grep 整個專案 |
| **沒有 IDE 自動完成** | `@ConfigurationProperties` 有（配 `spring-boot-configuration-processor`） |
| **測試要用 `@TestPropertySource`** | 而 properties 物件可以直接 `new` |

```java
// ✅ @ConfigurationProperties
package example.shop.order.application;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

/**
 * 訂單相關的<b>組態</b>（不是業務規則 —— 00 章 0.11.3 的判準）。
 *
 * <p>★★ 注意這裡<b>沒有</b> {@code paymentWindow} 與 {@code maxLines}：
 * 那兩個是<b>業務規則</b>，寫死在 {@code Order} 裡。
 *
 * <p>這裡只有「不同環境要不一樣」的東西。
 *
 * <p>★ 用 {@code record} + {@code @ConfigurationProperties} 是
 * Boot 3 的建構子綁定 —— 它讓這個物件<b>不可變</b>，
 * 而且可以在測試裡直接 {@code new}。
 */
@ConfigurationProperties(prefix = "shop.order")
@Validated
public record OrderProperties(

    /** ★ 匯出一次最多幾筆（04-controller 5.2.3 的 41 萬筆事故）。 */
    @Min(1) @Max(1_000_000) int exportMaxRows,

    /** 排程一次處理幾張逾期訂單。⚠️ 太大會讓交易變長 → 鎖持有時間變長。 */
    @Min(1) @Max(10_000) int expirationBatchSize,

    /** 冪等紀錄保留多久（之後由清理排程刪除）。 */
    @NotNull Duration idempotencyRetention,

    /** ★ 巢狀的設定物件。 */
    @NotNull Retry retry

) {
    /**
     * ★ 用 record 的緊湊建構子做「不能用註解表達」的驗證。
     *
     * <p>⚠️ 這種「跨欄位」的驗證是 {@code @ConfigurationProperties}
     * 相對於 {@code @Value} 最大的優勢之一。
     */
    public OrderProperties {
        if (idempotencyRetention != null && idempotencyRetention.toHours() < 24) {
            throw new IllegalArgumentException(
                    "idempotency-retention 至少 24 小時 —— "
                  + "客戶端的重試視窗通常是 24 小時（04-controller 4.9.2）");
        }
    }

    public record Retry(@Min(0) @Max(10) int maxAttempts,
                        @NotNull Duration initialBackoff,
                        @Min(1) @Max(10) double multiplier) {}
}
```

```yaml
shop:
  order:
    export-max-rows: 500000
    expiration-batch-size: 200
    idempotency-retention: 7d
    retry:
      max-attempts: 3
      initial-backoff: 200ms
      multiplier: 2
```

⚠️ **要讓 `@ConfigurationProperties` 生效，需要註冊它**：

```java
@SpringBootApplication
@ConfigurationPropertiesScan          // ★ 掃描 @ConfigurationProperties（Boot 2.2+）
public class ShopServiceApplication { }
```

> ⚠️ **不加 `@ConfigurationPropertiesScan` 且不加 `@EnableConfigurationProperties`
> 的症狀是「找不到 OrderProperties bean」** ——
> 而如果那個類別上有 `@Component`，它會被建立但**所有欄位是預設值 / null**。
> **後者更危險，因為它不會報錯。**

**加上這個 dependency 讓 IDE 有自動完成與說明：**

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-configuration-processor</artifactId>
    <optional>true</optional>
</dependency>
```

⚠️ **而 javadoc 的第一句會變成 IDE 的提示文字** ——
所以那些 javadoc 不是裝飾，它們是使用者介面。

### 1.4.6 把「不確定性」注入進來 ★★

00 章判準 4 只講了時間。**完整的清單是：**

| 不確定性來源 | 為什麼要注入 | 注入什麼 |
|---|---|---|
| **現在幾點** | 測試無法控制 | `java.time.Clock` |
| **亂數 / UUID** | 測試無法預測 | `IdGenerator`、`RandomSource` |
| **環境變數 / 主機名** | 每台機器不同 | `@ConfigurationProperties` |
| **檔案系統** | 測試會留下垃圾 | 一個 `Storage` 埠 |
| **目前的 locale / timezone** | 隨呼叫端變化 | 明確當參數傳 |
| **⚠️ 目前的使用者** | 隨請求變化 | `Actor` 當參數（**不是** `SecurityContextHolder`） |

⚠️ **最後一項最常被忽略。**

```java
// 🔴 Service 直接讀 SecurityContextHolder
@Transactional
public Order create(CreateOrderCommand cmd) {
    Actor actor = CurrentActorHolder.get();       // ← 從 ThreadLocal 讀
    // …
}
```

**四個後果：**

| 後果 | 說明 |
|---|---|
| 排程無法呼叫 | 沒有 SecurityContext |
| **`@Async` 之後 ThreadLocal 是空的** | 🔴 需要 `DelegatingSecurityContextExecutor` 才能傳遞 |
| 測試要設定 SecurityContext | 而不是傳一個參數 |
| **「誰在操作」變成隱性參數** | 讀方法簽章看不出來 |

✅ **正解**：`Actor` 是 `Command` 的一個欄位（04-controller 1.12.5 已經這樣設計了）。

**`IdGenerator` 的測試實作：**

```java
package example.shop.common.id;

/**
 * ★ 測試用的 ID 產生器：可預測、可重現。
 *
 * <p>⚠️ 不要用 {@code Mockito.mock(IdGenerator.class)} ——
 * 沒 stub 的方法回 {@code null}，而 {@code Order} 的建構子
 * 會拋 {@code NullPointerException}，
 * 錯誤訊息完全不會指向「你忘了 stub newOrderId()」。
 */
public class SequentialIdGenerator implements IdGenerator {

    private final java.util.concurrent.atomic.AtomicInteger counter =
            new java.util.concurrent.atomic.AtomicInteger();
    private final String prefix;

    public SequentialIdGenerator() { this("test"); }

    public SequentialIdGenerator(String prefix) { this.prefix = prefix; }

    @Override public String newOrderId()    { return next("ord"); }
    @Override public String newPaymentId()  { return next("pay"); }
    @Override public String newRefundId()   { return next("ref"); }
    @Override public String newShipmentId() { return next("shp"); }

    private String next(String kind) {
        return "%s_%s_%04d".formatted(kind, prefix, counter.incrementAndGet());
    }
}
```

**正式的實作：**

```java
package example.shop.common.id;

import com.github.f4b6a3.ulid.UlidCreator;
import org.springframework.stereotype.Component;

/**
 * ULID 版本。
 *
 * <p>★★ 為什麼用 ULID 而不是 UUIDv4（04-controller 1.4.3 提過，這裡補資料庫的理由）：
 * <ul>
 *   <li><b>ULID 是「時間有序」的</b> —— 插入 B+Tree 索引時是<b>順序</b>寫入，
 *       而 UUIDv4 是隨機寫入 → 頁分裂 → 寫入放大。
 *       在千萬列的表上，這個差別是 3～5 倍的插入吞吐量（07-mysql 第 03 章）。</li>
 *   <li>字典序 = 時間序 → {@code ORDER BY id} 就是 {@code ORDER BY created_at}，
 *       游標分頁（04-controller 1.9.4 的 {@code Cursor}）可以直接用它。</li>
 *   <li>26 個字元，比 UUID 的 36 個短，而且沒有連字號（URL 友善）。</li>
 * </ul>
 *
 * <p>⚠️ 但它有一個代價：<b>ID 洩漏了建立時間</b>。
 * 對訂單 ID 這不是問題（訂單本來就有 createdAt）；
 * 對「不該洩漏建立時間」的資源（例如邀請碼）要用別的方案。
 *
 * <p>👉 Java 也可以用 UUIDv7（時間有序的 UUID，RFC 9562）——
 * 但 JDK 21 沒有內建，需要函式庫。ULID 的生態比較成熟。
 */
@Component
public class UlidIdGenerator implements IdGenerator {

    @Override public String newOrderId()    { return "ord_" + ulid(); }
    @Override public String newPaymentId()  { return "pay_" + ulid(); }
    @Override public String newRefundId()   { return "ref_" + ulid(); }
    @Override public String newShipmentId() { return "shp_" + ulid(); }

    private String ulid() {
        return UlidCreator.getMonotonicUlid().toLowerCase();
    }
}
```

⚠️ **`getMonotonicUlid()` 而不是 `getUlid()`**：
前者保證「同一毫秒內產生的多個 ULID 仍然遞增」。
沒有它，同一毫秒的兩張訂單的 ID 順序是隨機的 —— 而游標分頁會因此漏資料或重複。

### 1.4.7 不要注入 `ApplicationContext`

```java
// 🔴🔴 這是「放棄 DI」的宣告
@Service
public class OrderApplicationService {

    @Autowired private ApplicationContext context;

    public void doSomething() {
        var repo = context.getBean(OrderRepository.class);   // ← service locator
    }
}
```

**五個後果：**

| 後果 | 說明 |
|---|---|
| **依賴不可見** | 建構子看不出它依賴什麼。1.2.1 的分析完全做不了 |
| 測試要起完整的 context | 或 mock `ApplicationContext`（而那非常噁心） |
| 缺 bean 在執行期才失敗 | 而不是啟動時 |
| **循環依賴被隱藏** | Spring 檢查不到，於是它變成「執行期偶發的 NPE」 |
| ArchUnit 難以檢查依賴方向 | `getBean(Class)` 的參數在 bytecode 裡是常數，但一般規則抓不到 |

⚠️ **唯一合理的用途**：寫框架 / 基礎設施程式碼
（例如一個自訂的 `HandlerMethodArgumentResolver`，
它需要在執行期依型別找 bean）。

**業務程式碼一律不用。** 加一條 ArchUnit：

```java
@ArchTest
static final ArchRule 業務程式碼不可注入ApplicationContext =
        noClasses().that().resideInAnyPackage("..application..", "..domain..")
                   .should().dependOnClassesThat()
                   .areAssignableTo(org.springframework.context.ApplicationContext.class)
                   .because("service locator 讓依賴不可見（1.4.7）");
```

---

## 1.5 Service 之間互相呼叫的界線 ★★

**這是本章第二個爭議點，而它的後果比 1.3 嚴重得多** ——
1.3 選錯只是多／少幾個檔案，1.5 選錯會造出無法拆解的相依網。

### 1.5.1 三種呼叫關係

```
① 上層 → 下層（★ 一定可以）
   OrderApplicationService → OrderRepository / StockPort / Order（domain）

② 同層 → 同層（⚠️ 這一節在討論的）
   OrderApplicationService → CouponApplicationService

③ 下層 → 上層（🔴 絕對不行）
   Order（domain） → OrderApplicationService
   OrderRepository → OrderApplicationService
```

③ 由 ArchUnit 擋（00 章 0.11.2）。**② 是灰色地帶。**

### 1.5.2 「A 直接注入 B 的 Application Service」的五個後果

```java
// ⚠️ 看起來很自然
@Service
public class OrderApplicationService {

    private final CouponApplicationService coupons;      // ← 注入另一個 Application Service

    @Transactional
    public Order create(CreateOrderCommand cmd) {
        // …
        Money discount = coupons.applyCoupon(cmd.couponCode(), subtotal);
        // …
    }
}
```

**後果 1：交易語意變得不可推理**

`CouponApplicationService.applyCoupon()` 上有 `@Transactional`。
**它現在在誰的交易裡？**

答案取決於它的 `propagation`：

| `CouponApplicationService.applyCoupon` 的傳播 | 實際行為 |
|---|---|
| `REQUIRED`（預設） | 加入 `create()` 的交易 → ⚠️ **它的 rollback 會讓整個下單 rollback** |
| `REQUIRES_NEW` | 開新交易 → 🔴 **下單失敗時券已經被扣了** |
| `NESTED` | savepoint → ⚠️ 只有部分 JPA / JDBC 支援 |

⚠️ **而寫 `create()` 的人根本不會去看那個註解。**
於是「券在什麼情況下會被退回」這件事，答案藏在另一個檔案的一個屬性裡。

> 📌 **這是 1.5 最重要的一點**：
> **`@Transactional` 方法呼叫另一個 `@Transactional` 方法，
> 交易的形狀就不再是「讀一個方法就能看懂」的了。**
> 02 章 2.3 會把 7 種傳播行為的組合完整展開。

**後果 2：授權判斷可能被重複做或被跳過**

`CouponApplicationService.applyCoupon()` 如果自己做「這個客戶能不能用這張券」的判斷，
它需要 `Actor`。而 `create()` 傳不傳 `Actor` 決定了那個判斷有沒有發生。

**後果 3：循環依賴幾乎必然出現**

```
OrderApplicationService → CouponApplicationService（下單要用券）
CouponApplicationService → OrderApplicationService（查「這個客戶用過幾次」）
                        ↑ 循環，啟動失敗
```

**這不是假設** —— 它是實務上最常見的循環依賴來源（1.6.1）。

**後果 4：測試需要 mock 一個「有很多行為」的東西**

```java
@Mock CouponApplicationService coupons;
// ⚠️ 它有 8 個方法，而這個測試只用到 1 個。
//    但 mock 它就等於「宣告我依賴它的全部」
```

**後果 5：領域邊界消失**

如果 `order` 可以呼叫 `coupon`、`coupon` 可以呼叫 `customer`、
`customer` 可以呼叫 `order`，那麼**「拆成微服務」永遠不可能**，
而且更立即的問題是：**任何一個改動的影響半徑是整個系統**。

### 1.5.3 規則：編排只能有一層

**shop-service 的規則：**

> **① 一個請求路徑上，只有一個 Application Service 決定交易邊界。
> ② 那個 Service 可以呼叫「其他領域的 Domain 物件」與「其他領域的 Repository / 埠」，
> 但不呼叫「其他領域的 Application Service」。**

```java
// ✅ 這樣是對的
@Service
public class OrderApplicationService {

    private final CouponRepository coupons;      // ★ Repository，不是 ApplicationService

    @Transactional
    public Order create(CreateOrderCommand cmd) {
        Coupon coupon = coupons.findByCode(cmd.couponCode()).orElseThrow(…);
        // ★★ 「能不能用、折多少」由 Coupon（domain）自己判斷
        //    → 規則仍然在 coupon 領域裡，只是執行的地方在 order 的交易裡
        Order order = factory.create(cmd, ctx, now);
        // ★ 「扣券計數」是一個原子操作，直接呼叫 Repository
        if (!coupons.tryConsume(coupon.code())) throw new CouponExhaustedException(…);
    }
}
```

⚠️ **為什麼「呼叫別的領域的 Repository」可以，「呼叫它的 ApplicationService」不行？**

| | 別的領域的 Repository | 別的領域的 ApplicationService |
|---|---|---|
| 有 `@Transactional`？ | ❌ 沒有 → 交易形狀不變 | ✅ 有 → 交易形狀不可推理 |
| 有業務規則？ | ❌ 沒有（規則在 domain） | ✅ 有 → 規則被執行兩次或被跳過 |
| 方法數 | 少（3～6 個） | 多（8～15 個） |
| 循環依賴風險 | 低（Repository 不依賴 Service） | **高** |

> 📌 **一句話**：
> **跨領域可以共用「資料」與「規則」，但不共用「交易邊界」。**

### 1.5.4 五種解耦手段

當你發現「我需要呼叫另一個 Service」時，依這個順序考慮：

**手段 ① 把規則下推到 Domain（最好）**

```java
// 🔴 之前
Money discount = couponService.calculateDiscount(code, subtotal);

// ✅ 之後
Coupon coupon = coupons.findByCode(code).orElseThrow(…);
Money discount = coupon.discountFor(subtotal, lines, now);
```

**適用**：那個「呼叫」其實只是為了執行一段規則。
**這是最常見的情況**（我的經驗裡約 60%）。

**手段 ② 抽出一個「共用的下層 Service」**

```
🔴 之前
   OrderApplicationService ─┐
                            ├─→ 兩邊都要「算可用點數」
   ReturnApplicationService ─┘

✅ 之後
   OrderApplicationService ─┐
                            ├─→ PointCalculator（★ 沒有 @Transactional 的元件）
   ReturnApplicationService ─┘
```

⚠️ **關鍵是那個共用元件「沒有 `@Transactional`」** ——
它在呼叫端的交易裡執行，交易形狀不變。

```java
/**
 * 點數計算。
 *
 * <p>★★ 它是 {@code @Component} 而不是 {@code @Service}，而且<b>沒有</b>
 * {@code @Transactional} —— 這兩件事一起宣告了
 * 「它不是一個 use case，它是一段可以被編排的能力」。
 *
 * <p>⚠️ 命名也刻意避開 {@code Service} 後綴。
 * 名字是給人看的最便宜的文件：{@code Calculator} 讓人不會期待它管交易。
 */
@Component
public class PointCalculator {

    private final PointRuleRepository rules;

    public PointCalculator(PointRuleRepository rules) { this.rules = rules; }

    /** ⚠️ 它會查資料（點數規則），所以不是純函式 —— 但它不開交易。 */
    public int pointsFor(Money amount, CustomerLevel level, Instant now) { … }
}
```

**手段 ③ 領域事件（跨領域的副作用）★**

```java
// 🔴 之前：下單要「通知庫存領域」與「通知點數領域」
@Transactional
public Order create(CreateOrderCommand cmd) {
    // …
    stockApplicationService.reserve(…);        // ← 另一個 ApplicationService
    pointApplicationService.grant(…);          // ← 又一個
}
```

```java
// ✅ 之後
@Transactional
public Order create(CreateOrderCommand cmd) {
    // …
    events.publish(OrderPlacedEvent.from(order, ctx.customer().email(), now));
    return order;
}
```

```java
// 點數領域自己訂閱
@Component
public class PointGrantListener {

    /**
     * ★ AFTER_COMMIT：訂單確定成立才給點數。
     *
     * <p>⚠️ 而它<b>自己開一個新交易</b>（{@code @Transactional(REQUIRES_NEW)}）——
     * 因為外層交易已經 commit 了，沒有交易可以加入。
     *
     * <p>⚠️⚠️ 這裡有一個真實的可靠性問題：
     * 如果這個 listener 失敗，<b>點數就沒了，而訂單已經成立</b>。
     * 06 章 6.9 的 outbox 模式是這個問題的正解。
     * <b>在那之前，這個 listener 必須是「失敗了會被發現」的</b>——
     * 所以它記 ERROR 並發告警，而不是 warn。
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onOrderPlaced(OrderPlacedEvent event) {
        try {
            points.grant(event.customerId(), calculator.pointsFor(event.total(), …));
        } catch (Exception e) {
            log.error("[ALERT] 點數發放失敗，需人工補發：order={} customer={}",
                      event.orderId(), event.customerId(), e);
            throw e;                          // ★ 讓它進 DLQ / 重試機制
        }
    }
}
```

⚠️ **事件不是萬靈丹。三個代價：**

| 代價 | 說明 |
|---|---|
| **可靠性下降** | 交易外的操作可能失敗，需要 outbox / 重試 / 對帳 |
| **流程變隱性** | 「下單之後會發生什麼」要搜尋 listener 才知道 |
| **測試變難** | 要驗證「事件被發佈了」+「listener 做對了」兩件事 |

> 📌 **判準**：
> **必須與主流程原子的 → 不要用事件**（庫存扣減）。
> **可以稍後、失敗可補的 → 用事件**（點數、通知、ERP）。

**手段 ④ 埠與轉接器（跨技術邊界）**

1.7 會展開。

**手段 ⑤ 明確承認耦合，但只單向**

⚠️ **有時候前四種都不適用。** 那就**明確地允許單向依賴**，並記錄它：

```java
/**
 * 訂單的編排。
 *
 * <p>⚠️ <b>已知的跨領域依賴</b>（1.5.5 的完整分析）：
 * <ul>
 *   <li>{@code product} —— 讀取商品資料與可購買性。<b>單向</b>。</li>
 *   <li>{@code coupon} —— 讀取券 + 原子扣減。<b>單向</b>。</li>
 *   <li>{@code stock} —— 原子保留。<b>單向</b>。</li>
 *   <li>{@code customer} —— 讀取會員等級。<b>單向</b>。</li>
 * </ul>
 * <p>★★ 這四個依賴都是<b>單向</b>的，也就是那四個領域
 * <b>都不會反過來依賴 order</b>。這是刻意維持的性質，
 * 而 {@code LayeredArchitectureTest.領域之間沒有循環} 是它的守門人。
 *
 * <p>⚠️ 而「查詢某商品的訂單數」這種需求，
 * <b>不可以</b>讓 product 呼叫 order —— 要用讀取模型（1.5.5 的方向 ③）。
 */
@Service
public class OrderApplicationService { … }
```

### 1.5.5 具體案例：下單要碰 5 個領域

**這是最實際的一節。** `create()` 需要：

| 領域 | 需要什麼 | 用哪個手段 | 結果 |
|---|---|---|---|
| `product` | 讀商品、判斷可購買性、算價 | ① 下推 domain | `products.findAllById()` + `Product.requirePurchasable()` + `PricingPolicy` |
| `stock` | 原子保留 | ⑤ 單向依賴埠 | `stock.tryReserve()` |
| `coupon` | 讀券、判斷可用、算折扣、原子扣減 | ① + ⑤ | `coupons.findByCode()` + `Coupon.discountFor()` + `coupons.tryConsume()` |
| `customer` | 讀會員等級與 email | ⑤ 單向依賴 | `customers.summaryOf()` |
| `point` | 發放點數 | ③ 事件 | `OrderPlacedEvent` → `PointGrantListener` |

**⚠️ 為什麼 `point` 用事件，而 `stock` 不用？**

| | `stock` | `point` |
|---|---|---|
| 必須與訂單原子？ | ✅ **是**（超賣不可接受） | ❌ 不是（點數晚 3 秒沒差） |
| 失敗要 rollback 訂單？ | ✅ 是 | ❌ 不要 |
| 可以事後補？ | ❌ 不行（貨已經被別人買走） | ✅ 可以 |

> 📌 **這張表就是「哪些用事件」的完整判準。**
> **而它跟「哪些放在交易裡」是同一個判準**（00 章判準 3）——
> 因為事件（`AFTER_COMMIT`）本質上就是「交易之外」。

**⚠️ 反方向的需求怎麼辦：「查這個商品賣了幾張訂單」**

```java
// 🔴 讓 product 呼叫 order → 循環依賴
@Service
public class ProductApplicationService {
    private final OrderQueryService orders;         // ← 循環
    public ProductStats stats(String productId) {
        return new ProductStats(orders.countByProductId(productId));
    }
}
```

**三個正解**（依成本排序）：

**方向 ①：查詢放在「需要它的那一側」的讀取模型裡**

```java
// ✅ 這個查詢屬於 product 的「報表」需求 → 給它自己的 Repository 方法
public interface ProductStatsRepository {

    /**
     * ⚠️ 這個查詢會 JOIN order_line 表。
     *
     * <p>★★ <b>「跨領域的 JOIN」在單一資料庫的系統裡是完全可以接受的</b>——
     * 而且它比「product 呼叫 order 的 Service」好得多：
     * <ul>
     *   <li>沒有循環依賴。</li>
     *   <li>一次查詢而不是 N 次。</li>
     *   <li>它是<b>唯讀</b>的 —— 不會破壞 order 的不變量。</li>
     * </ul>
     *
     * <p>⚠️ 代價：如果哪天要拆微服務，這個 JOIN 要改成 API 呼叫或
     * 讀取模型的同步。<b>而那個代價在「拆的時候」才付，不是現在。</b>
     */
    ProductSalesStats salesStats(String productId, LocalDate from, LocalDate to);
}
```

**方向 ②：訂閱事件維護一份讀取模型**

```java
@Component
public class ProductSalesProjectionListener {

    /** ★ 訂單成立時累加銷量 —— 一張 product_sales_daily 表。 */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onOrderPlaced(OrderPlacedEvent event) {
        event.lines().forEach(l -> projection.increment(
                l.productId(), event.businessDate(), l.quantity()));
    }
}
```

⚠️ **代價**：最終一致（延遲幾百毫秒）、可能漏事件（需要對帳排程）。
**只在「方向 ① 的查詢太慢」時才做。**

**方向 ③：接受「product 依賴 order」，但只依賴一個很小的介面**

```java
// order 領域提供一個「給別人用」的最小介面
package example.shop.order.application.api;

/**
 * ★ 訂單領域對外提供的<b>唯讀</b>查詢。
 *
 * <p>⚠️ 它刻意<b>只有</b>其他領域真的需要的方法（目前 2 個），
 * 而不是把 {@code OrderQueryService} 整個曝露出去。
 *
 * <p>👉 這叫「published language」——
 * 領域之間的介面應該比領域內部的介面<b>小得多</b>。
 */
public interface OrderSalesQuery {

    long countOrdersContaining(String productId, LocalDate from, LocalDate to);

    long sumQuantitySold(String productId, LocalDate from, LocalDate to);
}
```

⚠️ **這個做法引入了 `product → order` 的依賴**，
於是「order → product」加上它就是**循環**。

**所以它只在「order 不依賴 product」時可用** —— 而 shop-service 的 order **依賴** product。
**👉 shop-service 選方向 ①。**

### 1.5.6 什麼時候「直接呼叫另一個 Service」是對的

⚠️ **不要把 1.5.3 的規則變成教條。三種情況直接呼叫是對的：**

**情況 ① 那個 Service 明確是「下層的共用能力」而不是「同層的 use case」**

```java
// ✅ 這樣可以 —— 它沒有 @Transactional，名字也不叫 Service
@Component
public class InvoiceNumberAllocator { … }
```

**情況 ② 同一個領域內的兩個 Service**

```java
// ✅ OrderPaymentService 呼叫 OrderApplicationService.markPaid()
//    它們在同一個領域、同一個團隊、同一個聚合
//    ⚠️ 但仍然要想清楚交易傳播（02 章）
```

**情況 ③ 一個明確的 facade，而它自己不管交易**

```java
/**
 * 04-controller 站的 Controller 注入的介面。
 *
 * <p>⚠️ 如果 order 領域拆成 8 個 handler（1.2.4），
 * 這個 facade 讓 Controller 不需要注入 8 個東西。
 *
 * <p>★ 而它<b>自己沒有</b> {@code @Transactional} ——
 * 交易邊界仍然在各個 handler 上。
 * <b>「facade 不管交易」是它可以存在的前提。</b>
 */
@Service
public class OrderServiceFacade implements OrderService {

    private final PlaceOrderHandler place;
    private final CancelOrderHandler cancel;
    // …

    @Override public Order create(CreateOrderCommand cmd) { return place.handle(cmd); }
    @Override public CancellationResult cancel(CancelOrderCommand cmd) { return cancel.handle(cmd); }
}
```

⚠️ **這是「傳話筒」的一個合理版本** ——
0.4.2 說傳話筒沒有價值，而這裡它的價值是
「**讓 8 個 handler 對外看起來像一個介面**」。

> 📌 **判準的差別**：
> 0.4.2 的傳話筒是「一對一轉發，兩邊簽章相同」→ 沒有價值。
> facade 是「多對一收攏」→ 有價值（它改變了介面的形狀）。

---
## 1.6 循環依賴 ★★

**這是 Spring Boot 2.6 之後最常見的啟動失敗原因**，
而錯誤訊息長達 40 行、看起來像框架壞了。

### 1.6.1 為什麼會出現

**三個最常見的來源：**

**來源 ① 兩個領域互相需要（1.5.2 的後果 3）**

```java
@Service
public class OrderApplicationService {
    public OrderApplicationService(CouponApplicationService coupons) { }
}

@Service
public class CouponApplicationService {
    public CouponApplicationService(OrderApplicationService orders) { }
    //                              ^^^^^^^^^^^^^^^^^^^^^^^^ 循環
}
```

**來源 ② 「共用」的東西反過來依賴使用者**

```java
@Service
public class NotificationService {
    // ⚠️ 為了在通知裡放「訂單明細」，注入了 OrderQueryService
    public NotificationService(OrderQueryService orders) { }
}

@Service
public class OrderApplicationService {
    public OrderApplicationService(NotificationService notifications) { }
}
```

⚠️ **這是最陰險的一種**，因為 `NotificationService` 看起來是「基礎設施」，
沒有人預期它會依賴業務。

**正解**：通知需要的資料**由事件帶過去**，而不是讓通知自己去查。

```java
// ✅ 事件帶著它需要的資料（正式定義在 00 章 0.12 ⑬）
public record OrderPlacedEvent(
    String orderId,
    String orderNumber,
    String customerId,
    String customerEmail,          // ★ 帶過去，通知不用回查訂單
    Money total,
    List<LineSummary> lines,       // ★ 帶過去
    Instant occurredAt
) implements DomainEvent {
    public record LineSummary(String productId, String productName,
                              int quantity, Money lineTotal) {}
}
```

⚠️ **但這有一個真實的取捨**：事件變胖了。

| | 瘦事件（只有 ID） | 胖事件（帶資料） |
|---|---|---|
| 循環依賴 | 🔴 消費者要回查 → 容易循環 | ✅ 不需要回查 |
| 資料新鮮度 | ✅ 查到的是最新的 | ⚠️ 是事件產生那一刻的 |
| 事件大小 | 小 | ⚠️ 大（如果進訊息佇列要注意） |
| **消費者失敗重試時** | ⚠️ 資料可能已經變了（訂單被取消） | ✅ **重試的行為一致** |
| 演化 | ✅ 加欄位不影響事件 | ⚠️ 加欄位要改事件（而舊事件沒有那個欄位） |

> 📌 **shop-service 選「中等胖度」**：
> 帶「通知與稽核需要的欄位」，不帶「完整的聚合」。
> ⚠️ 而**最後一列的原因**很重要：
> 一個在 `AFTER_COMMIT` 之後 30 秒才重試成功的 listener，
> 用瘦事件會查到「已經被取消的訂單」→ 寄出一封矛盾的信。

**來源 ③ `@Configuration` 之間的循環**

```java
@Configuration
public class CacheConfig {
    public CacheConfig(RedisConnectionFactory factory) { }
}

@Configuration
public class RedisConfig {
    public RedisConfig(CacheManager cacheManager) { }   // ← 循環
}
```

**正解**：`@Configuration` 的方法參數注入（而不是建構子注入）：

```java
@Configuration
public class CacheConfig {

    // ★ 參數注入 —— Spring 在呼叫這個方法時才需要 factory
    @Bean
    public CacheManager cacheManager(RedisConnectionFactory factory) { … }
}
```

### 1.6.2 Boot 2.6+ 預設禁止

```yaml
spring:
  main:
    allow-circular-references: false     # ★ Boot 2.6+ 的預設值
```

⚠️ **在 Boot 2.6 之前，循環依賴是「可以」的**（Spring 用「提早曝露半成品 bean」化解）。
於是很多舊專案裡有大量循環而沒有人知道。

**升級到 2.6+ 時最常見的處理是：**

```yaml
# 🔴 這是「把警報關掉」而不是「修問題」
spring:
  main:
    allow-circular-references: true
```

⚠️ **為什麼不該這樣做**（即使它讓應用啟動了）：

| 問題 | 說明 |
|---|---|
| **`@Async` / `@Transactional` 可能失效** | 循環化解時注入的是「還沒被代理的原始物件」→ 🔴 **註解完全沒作用** |
| **初始化順序不確定** | A 的 `@PostConstruct` 可能在 B 完全建好之前執行 |
| **`final` 欄位注入不可能** | 必須改成 setter / 欄位注入 → 失去 1.4.1 的所有好處 |
| **它會累積** | 允許一個之後，第二年會有 40 個 |

> ⚠️⚠️ **第一點是真實的、而且非常難查的 bug。**
> 症狀是「這個方法明明有 `@Transactional`，但資料沒有 rollback」——
> 而原因是它拿到的是 raw bean 而不是代理。
> **這正是 1.3.6 那個 `所有Transactional方法都被代理攔截` 測試的價值所在。**

### 1.6.3 錯誤訊息怎麼讀

```
***************************
APPLICATION FAILED TO START
***************************

Description:

The dependencies of some of the beans in the application context form a cycle:

   orderController defined in file [.../OrderController.class]
┌─────┐
|  orderApplicationService defined in file [.../OrderApplicationService.class]
↑     ↓
|  couponApplicationService defined in file [.../CouponApplicationService.class]
↑     ↓
|  orderQueryService defined in file [.../OrderQueryService.class]
└─────┘

Action:

Relying upon circular references is discouraged and they are prohibited by default.
Update your application to remove the dependency cycle between beans.
As a last resort, it may be possible to break the cycle automatically at startup
by setting the property 'spring.main.allow-circular-references' to 'true'.
```

**三個讀法要點：**

| 要點 | 說明 |
|---|---|
| **`┌─────┐` 框住的才是循環** | 上面的 `orderController` 只是「進入點」，它不在循環裡 |
| **循環有 3 個節點** | 不是兩個互相依賴，是 A→B→C→A。⚠️ 實務上 4～6 個節點的循環很常見 |
| **箭頭的方向** | `↑` 與 `↓` 表示依賴方向，順著讀是 `orderApplicationService` 依賴 `couponApplicationService` |

⚠️ **最重要的一件事：從循環裡挑「最不該存在的那一條邊」來斷，
而不是「最容易斷的那一條」。**

在上面的例子裡：

| 邊 | 該不該存在 |
|---|---|
| `orderApplicationService → couponApplicationService` | 🔴 **不該**（1.5.3 的規則） |
| `couponApplicationService → orderQueryService` | ⚠️ 可辯論（券要查「這個客戶用過幾次」） |
| `orderQueryService → orderApplicationService` | 🔴 **不該**（讀取不該依賴命令） |

**斷第一條與第三條，第二條保留。**

### 1.6.4 六種解法與代價

**按「該不該用」排序（好 → 壞）：**

**解法 ① 重新劃分職責（最好，但最花時間）**

問「為什麼這兩個東西互相需要」，答案通常是
「有一個職責被放在錯的地方」。

```java
// 🔴 循環：Order 要算折扣，Coupon 要查訂單歷史
// ✅ 解：把「查訂單歷史」變成 Coupon 自己的 Repository 查詢
public interface CouponUsageRepository {
    /** ★ 它查 coupon_usage 表（coupon 領域自己的表），不查 order 表 */
    int countUsageByCustomer(String couponCode, String customerId);
}
```

⚠️ **注意這裡有一個資料建模的決定**：
「這個客戶用過這張券幾次」的資料**存在 coupon 領域**（一張 `coupon_usage` 表），
而不是「去 order 表查」。

> 📌 **這是解循環依賴最根本的手法**：
> **循環依賴通常是「資料放錯地方」的症狀，不是「注入方式」的問題。**

**解法 ② 事件（1.5.4 手段 ③）**

把「A 需要通知 B」變成「A 發事件，B 訂閱」。
**依賴方向從 `A → B` 變成 `B → 事件型別`。**

⚠️ **事件型別放哪裡？**

```
❌ 放在 A 的套件 → B 依賴 A（依賴還在，只是變成依賴一個 record）
   ⚠️ 但這通常是可以接受的 —— 依賴一個 record 比依賴一個 Service 輕得多

✅ 放在共用的套件（example.shop.common.event 或 order.application.event）
   ⚠️ 代價是「共用套件」會越來越大
```

**shop-service 的選擇**：事件放在**發佈者的**領域裡
（`order.application.event.OrderPlacedEvent`），
訂閱者依賴它。理由：

> 事件是**發佈者的契約**（就像 API 是伺服器的契約）。
> 把它放在共用套件會讓「誰負責它的演化」變得不清楚。

**解法 ③ 抽出共用的下層元件（1.5.4 手段 ②）**

```
🔴 A ⇄ B
✅ A → C ← B
```

**解法 ④ `ObjectProvider<T>` / `Supplier<T>`（延後取得）**

```java
@Service
public class CouponApplicationService {

    /** ★ 延後取得 —— 建構時不需要對方存在 */
    private final ObjectProvider<OrderQueryService> orders;

    public CouponApplicationService(ObjectProvider<OrderQueryService> orders) {
        this.orders = orders;
    }

    public boolean canUse(String code, String customerId) {
        return orders.getObject().countByCustomer(customerId) > 0;
    }
}
```

⚠️ **它是「合法的技術手段」，但它掩蓋了設計問題。**

| | 好 | 壞 |
|---|---|---|
| 循環真的被打破 | ✅ 建構時不需要對方 | |
| `@Transactional` 仍然生效 | ✅ 取得的是代理 | |
| 依賴仍然可見 | ✅ 在建構子簽章裡 | |
| | | 🔴 **設計問題還在**（1.6.3 的「不該存在的邊」仍然存在） |
| | | ⚠️ 缺 bean 在執行期才失敗 |

**適用**：你**知道**這是妥協，而且已經在 backlog 裡排了重構。

**解法 ⑤ setter 注入（不推薦）**

```java
@Service
public class OrderApplicationService {
    private CouponApplicationService coupons;      // ⚠️ 不能 final

    @Autowired
    public void setCoupons(CouponApplicationService coupons) { this.coupons = coupons; }
}
```

⚠️ 失去 1.4.1 的全部好處。**唯一比 `@Lazy` 好的地方是它不會讓代理失效。**

**解法 ⑥ `@Lazy`（最糟）**

```java
public OrderApplicationService(@Lazy CouponApplicationService coupons) { … }
```

⚠️ **為什麼它最糟：**

| 問題 | 說明 |
|---|---|
| **它在「呼叫端」宣告** | 讀 `CouponApplicationService` 完全看不出它參與了一個循環 |
| **注入的是代理的代理** | `@Lazy` 代理包住 `@Transactional` 代理，堆疊變深、除錯變難 |
| **`@Lazy` 有兩種語意** | 「延後初始化」與「打破循環」—— 看到它時不知道是哪一個意圖 |
| **它會擴散** | 一旦團隊發現「加 `@Lazy` 就好了」，第二年有 40 個 `@Lazy` |
| ⚠️ **`equals` / `hashCode` 的行為** | `@Lazy` 代理的 `equals` 是代理的，不是目標物件的 → 放進 `Set` / `Map` 會出問題 |

> 📌 **如果真的要用**，**一定要加註解說明**：

```java
public OrderApplicationService(
        // ⚠️⚠️ @Lazy 是為了打破 order ⇄ coupon 的循環（見 ADR-014）。
        //    正確的修法是把 coupon_usage 移到 coupon 領域（1.6.4 解法 ①），
        //    已排入 2026 Q3。⚠️ 不要複製這個模式到別的地方。
        @Lazy CouponApplicationService coupons) { … }
```

**六種解法的總表：**

| 解法 | 修好設計？ | 代理仍生效？ | 成本 | 什麼時候用 |
|---|---|---|---|---|
| ① 重新劃分職責 | ✅ | ✅ | 高 | **預設選這個** |
| ② 事件 | ✅ | ✅ | 中 | 副作用型的依賴 |
| ③ 抽共用元件 | ✅ | ✅ | 低 | 兩邊都需要同一段邏輯 |
| ④ `ObjectProvider` | ❌ | ✅ | 低 | ⚠️ 明確的臨時妥協 |
| ⑤ setter 注入 | ❌ | ✅ | 低 | ⚠️ 幾乎沒有理由 |
| ⑥ `@Lazy` | ❌ | ⚠️ 堆疊變深 | 低 | 🔴 最後手段 |
| ⑦ `allow-circular-references: true` | ❌ | 🔴 **可能失效** | 零 | 🔴🔴 **不要** |

### 1.6.5 自我循環：`this.method()` 與代理

⚠️ **有一種「循環」Spring 不會報錯，但它會讓 `@Transactional` 失效：**

```java
@Service
public class OrderApplicationService {

    public void processAll(List<String> ids) {
        for (String id : ids) {
            this.processOne(id);           // 🔴 直接呼叫，繞過代理
        }
    }

    @Transactional
    public void processOne(String id) { … }   // ← 完全沒有交易
}
```

**02 章 2.7.1 會完整處理這個問題**，這裡先給三種解法的預覽：

```java
// 解法 A：拆成兩個 bean（★ 最好）
@Service
public class OrderBatchProcessor {
    private final OrderApplicationService service;    // ★ 注入代理
    public void processAll(List<String> ids) {
        ids.forEach(service::processOne);              // ★ 經過代理
    }
}

// 解法 B：自我注入（⚠️ 這是一種「刻意的循環」，Spring 特別允許它）
@Service
public class OrderApplicationService {
    private final OrderApplicationService self;
    public OrderApplicationService(@Lazy OrderApplicationService self) {
        this.self = self;                              // ⚠️ 需要 @Lazy
    }
    public void processAll(List<String> ids) {
        ids.forEach(self::processOne);
    }
}

// 解法 C：TransactionTemplate（★ 不需要代理，最直接）
@Service
public class OrderApplicationService {
    private final TransactionTemplate tx;
    public void processAll(List<String> ids) {
        ids.forEach(id -> tx.executeWithoutResult(status -> processOne(id)));
    }
}
```

⚠️ **注意解法 B 的「自我注入」需要 `@Lazy`**（在 Boot 2.6+）——
自己依賴自己也是循環。

> ⚠️ Spring Framework 4.3～5.x 曾經**特別允許**自我注入而不需要 `@Lazy`，
> 但 Boot 2.6 的 `allow-circular-references: false` 把它也擋掉了。
> **這是一個真實的升級坑。**

### 1.6.6 雙重守門

**Spring 的啟動檢查只抓「bean 之間的循環」。**
它抓不到「套件之間的循環」——而後者是前者的前兆。

```java
// ★ 這個循環 Spring 不會報錯（因為 bean 層面沒有循環）
// order.application.OrderApplicationService → coupon.domain.Coupon
// coupon.application.CouponApplicationService → order.domain.OrderLine
//                                                ↑ 套件層面已經循環了
```

⚠️ 而上面那個例子**確實會出現**（`Coupon.discountFor()` 收 `List<OrderLine>`）。

**shop-service 的處理：**

```java
/**
 * ★ 領域之間的循環檢查。
 *
 * <p>⚠️ 它會抓到 {@code coupon.domain} 依賴 {@code order.domain}
 * （{@code Coupon.discountFor} 收 {@code List<OrderLine>}）
 * 加上 {@code order.application} 依賴 {@code coupon.domain} 的循環。
 *
 * <p>👉 <b>而那個循環是刻意的、而且不是問題</b> ——
 * 因為 {@code coupon.domain → order.domain} 只是「型別依賴」（一個 record），
 * 不是「行為依賴」。
 *
 * <p>★★ 正確的處理不是「忽略這條規則」，而是<b>消除那個型別依賴</b>：
 * 讓 {@code Coupon.discountFor} 收一個自己定義的最小介面。
 */
@ArchTest
static final ArchRule 領域之間沒有循環 = SlicesRuleDefinition
        .slices().matching("example.shop.(*)..")
        .should().beFreeOfCycles();
```

**消除那個型別依賴：**

```java
package example.shop.coupon.domain;

/**
 * ★ 「一筆可以被折扣的項目」——coupon 領域自己定義的最小介面。
 *
 * <p>⚠️ 於是 {@code order.domain.OrderLine} 實作它，
 * 依賴方向變成 {@code order → coupon}（單向），循環消失。
 *
 * <p>★★ 這叫「介面隔離 + 依賴反轉」的組合，而它的價值是具體的：
 * <ul>
 *   <li>循環消失 → 可以拆 module。</li>
 *   <li>{@code Coupon} 的測試不需要建 {@code OrderLine}
 *       —— 一個 3 行的 record 就夠了。</li>
 *   <li>★ 購物車的試算也可以用同一個 {@code Coupon.discountFor}
 *       （{@code CartLine} 也實作這個介面）—— <b>而這是真實的需求</b>。</li>
 * </ul>
 */
public interface DiscountableLine {
    String productId();
    Money lineTotal();
}
```

```java
// order 那一側
public record OrderLine(String productId, String productName, String sku,
                        Money unitPrice, int quantity)
        implements DiscountableLine {           // ★ 只多這一行

    @Override public Money lineTotal() { return unitPrice.times(quantity); }
}

// coupon 那一側的簽章改成：
public Money discountFor(Money subtotal, List<? extends DiscountableLine> lines, Instant now)
```

⚠️ **注意 `List<? extends DiscountableLine>`。**
`List<OrderLine>` **不是** `List<DiscountableLine>` 的子型別（Java 泛型不可變），
所以少了 `? extends` 就會編譯錯誤。

> 📌 **這是 Java 泛型最常見的一個坑**，而它在「把型別抽成介面」的重構裡幾乎必然出現。

**兩層守門的分工：**

| 守門人 | 抓什麼 | 什麼時候跑 | 速度 |
|---|---|---|---|
| Spring 啟動檢查 | bean 之間的循環 | 應用啟動 / `@SpringBootTest` | 慢（8 秒） |
| **ArchUnit `beFreeOfCycles`** | **套件之間的循環（前兆）** | 單元測試 | 快（2 秒） |
| 1.3.6 的代理檢查 | 循環化解造成的代理失效 | `@SpringBootTest` | 慢 |

---

## 1.7 埠與轉接器（Port / Adapter）

### 1.7.1 Service 需要「外面的東西」時

00 章 0.10.1 說「交易裡不可以呼叫外部系統」。
但**總有某個地方要呼叫它**。那個地方長什麼樣？

```
┌──────────────────────────────────────────────────────────┐
│ order.application                                        │
│                                                          │
│  OrderPaymentService                                     │
│      │                                                   │
│      │ 依賴                                               │
│      ▼                                                   │
│  ┌─────────────────────────────────┐                     │
│  │ PaymentGateway（介面 = 埠）       │  ★ 定義在這一側      │
│  │  ChargeResult charge(...)        │                     │
│  └─────────────────────────────────┘                     │
└────────────────────┬─────────────────────────────────────┘
                     │ 實作（依賴方向反轉）
                     ▼
┌──────────────────────────────────────────────────────────┐
│ order.infrastructure                                     │
│                                                          │
│  TapPayGateway implements PaymentGateway                 │
│      · RestClient、逾時、重試、斷路器                       │
│      · 把 HTTP 錯誤翻譯成領域的 ChargeResult                │
│      · 把 TapPay 的錯誤碼對映到我們的 ErrorCode              │
└──────────────────────────────────────────────────────────┘
```

**「埠」= 我需要的能力（用我的語言描述）。
「轉接器」= 用某個具體技術提供那個能力。**

### 1.7.2 介面放哪一邊 ★

**這是埠與轉接器最容易搞錯的一點。**

```
🔴 錯：介面跟實作放在一起
   order/infrastructure/PaymentGateway.java        ← 介面
   order/infrastructure/TapPayGateway.java         ← 實作
   → application 依賴 infrastructure（依賴方向錯了）

✅ 對：介面放在「使用它的那一側」
   order/application/port/PaymentGateway.java      ← 介面
   order/infrastructure/TapPayGateway.java         ← 實作
   → infrastructure 依賴 application（依賴反轉）
```

⚠️ **為什麼這個位置很重要？**

| 介面在 application | 介面在 infrastructure |
|---|---|
| ✅ 介面的形狀由「業務需要什麼」決定 | 🔴 由「金流商的 API 長什麼樣」決定 |
| ✅ 換金流商不需要改 application | 🔴 換金流商要改介面 → 改 application |
| ✅ `ChargeResult` 是領域的型別 | 🔴 容易變成「TapPay 的 response 物件」 |
| ✅ ArchUnit 可以擋 `application → infrastructure` | 🔴 那條規則會擋掉合法的用法 |

**具體差別：**

```java
// 🔴 介面被 TapPay 的 API 形狀污染
public interface PaymentGateway {
    TapPayChargeResponse charge(String primeToken, long amountInCents,
                                String merchantId, TapPayCardHolder holder);
    //   ^^^^^^^^^^^^^^^^^^^^^^^^ TapPay 的型別洩漏到 application
    //                ^^^^^^^^^^ 「以分為單位」是 TapPay 的約定，不是我們的
}
```

```java
// ✅ 介面用我們的語言
package example.shop.order.application.port;

/**
 * 金流閘道（埠）。
 *
 * <p>★★ 這個介面的<b>每一個型別都是我們自己的</b>：
 * {@link Money}、{@link PaymentMethod}、{@link ChargeResult}。
 * <b>沒有任何一個來自金流商的 SDK。</b>
 *
 * <p>⚠️ 這不是「潔癖」——它的具體價值是：
 * 換金流商時，{@code OrderPaymentService} 一行都不用改，
 * 而它的 40 個測試也一行都不用改。
 */
public interface PaymentGateway {

    /** ★ 由實作宣告它支援什麼（1.4.4 做法 ③ 的註冊表用它）。 */
    Set<PaymentMethod> supportedMethods();

    /**
     * 請款。
     *
     * <p>⚠️⚠️ 它<b>不拋例外表示「付款失敗」</b>——
     * 「卡片被拒絕」是一個<b>正常的業務結果</b>，不是異常。
     *
     * <p>它只在「技術問題」時拋例外：
     * @throws PaymentGatewayTimeoutException  逾時（★ 結果未知！）
     * @throws PaymentGatewayUnavailableException 對方掛了或斷路器打開
     *
     * <p>★★ 「逾時」與「明確失敗」的區別是這整個介面最重要的設計 ——
     * 00 章練習 4 的第 6 個問題。
     */
    ChargeResult charge(ChargeRequest request);

    /**
     * ★★ 查詢一筆交易的狀態。
     *
     * <p>它存在的唯一理由是「逾時之後要對帳」——
     * 而<b>如果一個金流商沒有提供這個 API，那家不能用</b>。
     * <b>這是選金流商時的硬性條件，而很多團隊在出事之後才想到。</b>
     */
    Optional<ChargeStatus> query(String merchantTradeNo);

    /** 退款。⚠️ 完整的退款埠見 1.11 練習 3 —— 它比這一個方法複雜得多。 */
    RefundResult refund(RefundRequest request);
}
```

⚠️ **這個介面提到三個還沒定義的型別**，它們的形狀取決於同一組判準：

| 型別 | 定義在 | 形狀 |
|---|---|---|
| `ChargeStatus` | 06 章 6.8（對帳） | ⚠️ **不是 `boolean`** —— 它至少要有 `PENDING` / `SUCCEEDED` / `FAILED` / `NOT_FOUND` 四態，因為「查不到這筆交易」與「這筆交易失敗了」對後續動作完全不同 |
| `RefundRequest` / `RefundResult` | **1.11 練習 3** | 那個練習就是在設計它們 |
| `RefundStatus` | 06 章 6.8 | 與 `ChargeStatus` 對稱 |

> 📌 **`NOT_FOUND` 那一態最容易被漏掉，而它最重要**：
> 逾時之後查不到交易 → 代表對方**沒有收到請求** → 可以安全重試。
> 而如果只有三態，這個情況會被歸到 `FAILED` → 我們以為使用者付款失敗，
> 但其實他從來沒被扣款過（比較好）—— 或者被歸到「未知」而永遠卡著。

```java
package example.shop.order.application.port;

import example.shop.common.money.Money;
import example.shop.order.domain.PaymentMethod;

/**
 * 請款請求。
 *
 * <p>★ {@code merchantTradeNo} 是<b>我們</b>產生的交易編號，
 * 而它必須是冪等鍵 —— 同一個編號重送不會重複扣款。
 * ⚠️ 這是金流整合最重要的一個欄位，而它常被誤用成「訂單編號」：
 * <b>一張訂單可能有多次付款嘗試</b>（第一次卡片被拒），
 * 所以它必須是「這一次嘗試」的編號。
 */
public record ChargeRequest(
    String merchantTradeNo,
    String orderId,
    Money amount,
    PaymentMethod method,
    /** ★ 前端取得的一次性 token（例如 TapPay 的 prime）—— 我們絕不接觸卡號。 */
    String paymentToken,
    /** 3D 驗證完成後要導回的位址。 */
    String returnUrl
) {}
```

```java
package example.shop.order.application.port;

import example.shop.common.money.Money;

/**
 * 請款結果。
 *
 * <p>★★ 用 sealed interface 而不是「一個帶 boolean 的 record」，
 * 因為<b>三種結果需要的欄位完全不同</b>，
 * 而 sealed + pattern matching 讓「漏處理一種」變成編譯錯誤。
 */
public sealed interface ChargeResult {

    /** 成功。 */
    record Succeeded(String gatewayTradeNo, Money amount,
                     java.time.Instant paidAt) implements ChargeResult {}

    /**
     * 明確失敗。
     *
     * @param reason ★ 對映到我們的 {@code ErrorCode}（CARD_DECLINED /
     *               INSUFFICIENT_FUNDS / CARD_EXPIRED / …），
     *               <b>不是金流商的原始錯誤碼</b>
     * @param gatewayMessage ⚠️ 原始訊息，<b>只進日誌不進回應</b>
     *                       （04-controller 3.11.2 的資訊洩漏）
     */
    record Declined(DeclineReason reason, String gatewayMessage) implements ChargeResult {}

    /**
     * ★★ 需要進一步動作（3D 驗證、超商代碼、轉帳帳號）。
     *
     * <p>⚠️ 這個分支在很多實作裡被漏掉，
     * 而漏掉的結果是「使用者按了付款，什麼都沒發生」。
     */
    record RequiresAction(ActionType type, String redirectUrl,
                          String displayCode,
                          java.time.Instant expiresAt) implements ChargeResult {}

    enum DeclineReason { CARD_DECLINED, INSUFFICIENT_FUNDS, CARD_EXPIRED,
                         CVV_INVALID, RISK_REJECTED, LIMIT_EXCEEDED, OTHER }

    enum ActionType { THREE_D_SECURE, CONVENIENCE_STORE_CODE, BANK_TRANSFER }
}
```

⚠️ **`sealed interface` + `switch` 讓「漏處理」變成編譯錯誤：**

```java
// ★ 沒有 default，新增一種 ChargeResult 時這裡編譯失敗
return switch (result) {
    case ChargeResult.Succeeded s      -> handleSucceeded(order, s);
    case ChargeResult.Declined d       -> handleDeclined(order, d);
    case ChargeResult.RequiresAction a -> handleRequiresAction(order, a);
};
```

> 📌 **這是 Java 21 的 sealed + pattern matching 在業務程式碼裡最有價值的用法**
> （01-java-core 第 12 章的實際應用）。
> **「三種結果」變成型別系統的一部分，而不是文件裡的一句話。**

### 1.7.3 轉接器的實作

```java
package example.shop.order.infrastructure.payment;

import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.ResourceAccessException;

/**
 * TapPay 的轉接器。
 *
 * <p>★★ 它的職責是<b>翻譯</b>，而且是雙向的：
 * <table>
 *   <tr><th>方向</th><th>翻譯什麼</th></tr>
 *   <tr><td>出去</td><td>{@code Money} → TapPay 的「以分為單位的 long」<br>
 *       {@code PaymentMethod} → TapPay 的 {@code pay_by}</td></tr>
 *   <tr><td>回來</td><td>TapPay 的 {@code status} 數字 →
 *       {@code ChargeResult} 的三個分支<br>
 *       HTTP 逾時 → {@code PaymentGatewayTimeoutException}</td></tr>
 * </table>
 *
 * <p>⚠️ 這個類別是<b>唯一</b>認識「TapPay」這個字的地方。
 * 06 章 6.4 會加上重試與斷路器；這裡先把翻譯的形狀定下來。
 */
@Component
public class TapPayGateway implements PaymentGateway {

    private final RestClient client;
    private final TapPayProperties props;

    public TapPayGateway(RestClient.Builder builder, TapPayProperties props) {
        this.props = props;
        this.client = builder
                .baseUrl(props.baseUrl())
                .defaultHeader("x-api-key", props.apiKey())
                // ★★ 逾時一定要設 —— 00 章 0.3.2 事故 1
                .requestFactory(timeouts(props.connectTimeout(), props.readTimeout()))
                .build();
    }

    @Override
    public Set<PaymentMethod> supportedMethods() {
        return Set.of(PaymentMethod.CREDIT_CARD, PaymentMethod.APPLE_PAY);
    }

    @Override
    public ChargeResult charge(ChargeRequest request) {
        var body = new TapPayChargeRequest(
                props.partnerKey(),
                props.merchantId(),
                request.paymentToken(),
                // ★ Money → 以「最小單位」表示的整數
                toMinorUnits(request.amount()),
                request.amount().currency().getCurrencyCode(),
                request.merchantTradeNo(),
                request.returnUrl());

        TapPayChargeResponse response;
        try {
            response = client.post().uri("/tpc/payment/pay-by-prime")
                    .body(body)
                    .retrieve()
                    .body(TapPayChargeResponse.class);

        } catch (ResourceAccessException e) {
            // ★★ 連線／讀取逾時 → 結果未知！絕對不可以當成失敗
            throw new PaymentGatewayTimeoutException(request.merchantTradeNo(), e);

        } catch (RestClientResponseException e) {
            // ⚠️ 5xx 也是「結果未知」—— 對方可能已經處理了才掛掉
            if (e.getStatusCode().is5xxServerError()) {
                throw new PaymentGatewayUnavailableException(
                        request.merchantTradeNo(), e.getStatusCode().value(), e);
            }
            // 4xx 是我們送錯了 → 程式錯誤，不該重試
            throw new IllegalStateException(
                    "TapPay 拒絕了請求（我們的參數有問題）：" + e.getStatusText(), e);
        }

        if (response == null) {
            throw new PaymentGatewayUnavailableException(
                    request.merchantTradeNo(), 200, null);
        }
        return translate(response, request);
    }

    /** ★★ 錯誤碼的對映表 —— 這是這個類別最有價值的部分。 */
    private ChargeResult translate(TapPayChargeResponse r, ChargeRequest request) {
        if (r.status() == 0) {
            return new ChargeResult.Succeeded(
                    r.recTradeId(), request.amount(), Instant.ofEpochSecond(r.transactionTimeSec()));
        }
        if (r.paymentUrl() != null && !r.paymentUrl().isBlank()) {
            return new ChargeResult.RequiresAction(
                    ChargeResult.ActionType.THREE_D_SECURE, r.paymentUrl(), null,
                    Instant.ofEpochSecond(r.transactionTimeSec()).plus(Duration.ofMinutes(15)));
        }
        return new ChargeResult.Declined(DECLINE_REASONS.getOrDefault(
                r.status(), ChargeResult.DeclineReason.OTHER), r.msg());
    }

    /**
     * ⚠️ 這張表必須來自金流商的文件，而且要有一個測試檢查它的完整性。
     *
     * <p>⚠️⚠️ <b>沒對映到的錯誤碼會落到 {@code OTHER}</b>，
     * 而 {@code OTHER} 對使用者是「付款失敗，請稍後再試」——
     * 那對「餘額不足」是<b>錯的建議</b>（他該換一張卡）。
     * 👉 所以要有一個排程檢查日誌裡的 {@code OTHER} 出現頻率。
     */
    private static final Map<Integer, ChargeResult.DeclineReason> DECLINE_REASONS = Map.of(
            10003, ChargeResult.DeclineReason.CARD_DECLINED,
            10009, ChargeResult.DeclineReason.INSUFFICIENT_FUNDS,
            10012, ChargeResult.DeclineReason.CARD_EXPIRED,
            10013, ChargeResult.DeclineReason.CVV_INVALID,
            10021, ChargeResult.DeclineReason.RISK_REJECTED,
            10022, ChargeResult.DeclineReason.LIMIT_EXCEEDED);

    /**
     * ★ {@code Money} → 最小單位的整數。
     *
     * <p>⚠️ 不可以寫 {@code amount.multiply(100)} ——
     * JPY 沒有小數位（100 円 = 100，不是 10000），KWD 有 3 位。
     * {@code Currency.getDefaultFractionDigits()} 是唯一正確的來源
     * （00 章 0.5.3 的 {@code Money} 用同一個方法）。
     */
    private long toMinorUnits(Money money) {
        return money.amount()
                .movePointRight(money.currency().getDefaultFractionDigits())
                .longValueExact();     // ★ 有小數會拋例外 —— 那代表 Money 的正規化壞了
    }
}
```

⚠️ **`longValueExact()` 而不是 `longValue()`** ——
後者會**靜默截斷**小數部分。
如果 `Money` 的正規化因為某個 bug 失效，`longValue()` 會少收錢，
而 `longValueExact()` 會拋 `ArithmeticException`。

> 📌 **在金額相關的程式碼裡，一律用會拋例外的版本。**
> `longValueExact()`、`intValueExact()`、`toBigIntegerExact()`。

**測試轉接器需要 `MockRestServiceServer` 或 WireMock：**

```java
@RestClientTest(TapPayGateway.class)
// ⚠️ @RestClientTest 只載入 RestClient/RestTemplate 相關的自動組態 ——
//    TapPayProperties 不在裡面，少了這一行會是「找不到 TapPayProperties bean」
@EnableConfigurationProperties(TapPayProperties.class)
@TestPropertySource(properties = {
        "shop.payment.tappay.base-url=https://sandbox.tappaysdk.com",
        "shop.payment.tappay.api-key=test-key",
        "shop.payment.tappay.partner-key=test-partner",
        "shop.payment.tappay.merchant-id=TEST_MERCHANT"
})
class TapPayGatewayTest {

    @Autowired TapPayGateway gateway;
    @Autowired MockRestServiceServer server;

    @Test
    void 卡片被拒絕時回傳Declined而不是拋例外() {
        server.expect(requestTo(containsString("/pay-by-prime")))
              .andRespond(withSuccess("""
                      {"status":10003,"msg":"Card declined","rec_trade_id":null}
                      """, MediaType.APPLICATION_JSON));

        ChargeResult result = gateway.charge(charge(Money.twd("1000")));

        assertThat(result).isInstanceOf(ChargeResult.Declined.class);
        assertThat(((ChargeResult.Declined) result).reason())
                .isEqualTo(ChargeResult.DeclineReason.CARD_DECLINED);
    }

    /** ★★ 最重要的一個測試：逾時不可以被當成失敗。 */
    @Test
    void 逾時時拋PaymentGatewayTimeoutException() {
        server.expect(requestTo(containsString("/pay-by-prime")))
              .andRespond(request -> { throw new java.net.SocketTimeoutException("read timeout"); });

        assertThatThrownBy(() -> gateway.charge(charge(Money.twd("1000"))))
                .isInstanceOf(PaymentGatewayTimeoutException.class)
                .as("★ 絕不可以回傳 Declined —— 那會讓上層以為「沒收到錢」");
    }

    /** ★ 對映表的完整性守門。 */
    @Test
    void 所有已知的拒絕碼都有對映() throws Exception {
        // ★ 從一份「金流商文件的快照」讀 —— 而它是版控的一部分
        var documented = objectMapper.readValue(
                new ClassPathResource("tappay-error-codes.json").getInputStream(),
                new TypeReference<Map<String, String>>() {});

        var mapped = ReflectionTestUtils.getField(TapPayGateway.class, "DECLINE_REASONS");
        assertThat(((Map<?, ?>) mapped).keySet().stream().map(String::valueOf))
                .as("金流商文件裡的碼都要有對映，否則使用者會看到錯的建議")
                .containsAll(documented.keySet());
    }

    private ChargeRequest charge(Money amount) {
        return new ChargeRequest("mtn_1", "ord_1", amount,
                                 PaymentMethod.CREDIT_CARD, "prime_xxx", "https://x/return");
    }
}
```

### 1.7.4 什麼時候是過度設計

⚠️ **不是每一個外部依賴都需要埠。**

| 情況 | 需要埠？ | 理由 |
|---|---|---|
| 金流商 | ✅ | 會換、有多家、需要 fake 測試 |
| ERP / 物流 API | ✅ | 同上 |
| 寄信（SMTP / SendGrid） | ✅ | 會換、測試不能真的寄 |
| **Redis 快取** | ❌ | Spring Cache 抽象已經是埠了，再包一層是多餘的 |
| **`ObjectMapper`** | ❌ | 它是一個函式庫，不是外部系統 |
| **`MessageSource`（i18n）** | ❌ | 同上 |
| **Spring 的 `ApplicationEventPublisher`** | ⚠️ 可辯論（1.3.5） | 它本身就是介面 |
| **`Clock`** | ✅ 已經是 JDK 的抽象 | 不用自己定義 |
| 資料庫（透過 Repository） | ✅ | Repository 就是埠 |

**三個判準：**

```
① 它會失敗（網路、逾時、對方掛掉）→ 需要埠
   （因為「失敗怎麼辦」是一個要在領域語言裡表達的決定）
② 它有多個提供者，而且真的會換 → 需要埠
③ 測試不能用真的（會寄信、會扣錢、會很慢）→ 需要埠
```

**三個都不符合 → 直接用那個函式庫。**

⚠️ **一個常見的過度設計**：

```java
// 🔴 為了「不依賴 Jackson」而包一層
public interface JsonSerializer {
    String toJson(Object o);
    <T> T fromJson(String json, Class<T> type);
}
```

**為什麼不值得**：
① Jackson 不會失敗（除了程式錯誤）；
② 你不會換掉它（換了要重測所有序列化行為，成本遠大於「改 import」）；
③ 測試可以用真的。

**而它有一個具體的代價**：
包一層之後，Jackson 的 `@JsonView`、`TypeReference`、
`JsonNode`、`ObjectReader` 全部用不到（或要再包）——
於是你會需要一個「逃生門」方法回傳 `ObjectMapper`，
而那個逃生門會被所有人使用，包裝就白做了。

> 📌 **判準的一句話版本**：
> **抽象的價值 = 「換掉實作的機率」× 「換掉的成本」− 「抽象本身的成本」。**
> 而「抽象本身的成本」包含**它擋掉的功能**，那一項最常被低估。

---
## 1.8 Service 的方法簽章設計

### 1.8.1 參數：Command 物件 vs 散開的參數

```java
// ── 寫法 A：散開 ─────────────────────────────────
Order create(Actor actor, String idempotencyKey, List<Line> lines,
             String shippingAddressId, String couponCode,
             String customerNote, InvoiceSpec invoice);

// ── 寫法 B：Command 物件 ─────────────────────────
Order create(CreateOrderCommand cmd);
```

| | 散開 | Command |
|---|---|---|
| 參數少（1～3 個） | ✅ 更直接 | ⚠️ 過度包裝 |
| 參數多（4+ 個） | 🔴 **相鄰的同型別參數會傳錯** | ✅ |
| 加一個參數 | 🔴 所有呼叫端要改 | ✅ 加一個欄位，`null` 或給預設 |
| **編譯期防呆** | 🔴 `create(actor, key, …)` vs `create(key, actor, …)` **都是 String → 編譯得過** | ✅ |
| 日誌 / 稽核 | ⚠️ 要自己組 | ✅ 一個物件 `toString()` |
| **測試的可讀性** | ⚠️ 一長串位置參數 | ✅ builder |

⚠️ **「相鄰的同型別參數會傳錯」是真實而且很貴的 bug**：

```java
// 🔴 這兩個都是 String，順序寫反編譯得過
create(actor, shippingAddressId, couponCode, customerNote, …);
create(actor, couponCode, shippingAddressId, customerNote, …);
//            ^^^^^^^^^^  ^^^^^^^^^^^^^^^^^ 換位置了
```

**症狀**：訂單的收件地址是券號、券號是地址 ID
→ 地址查不到 → 404 → 而錯誤訊息說「地址不存在」（技術上正確，完全誤導）。

> 📌 **shop-service 的規則**：
> **3 個參數以下用散開，4 個以上用 Command。**
> ⚠️ 而「同型別的參數超過 2 個」時，**即使只有 3 個也用 Command 或值物件**。

**改進散開版本的另一種方式：值物件**

```java
// ✅ 型別讓傳錯不可能
Order create(Actor actor, IdempotencyKey key, OrderLines lines,
             ShippingAddressId addressId, CouponCode couponCode);
//                            ^^^^^^^^^^^^^^^^^  ^^^^^^^^^^ 不同型別
```

⚠️ **代價**：多 5 個 record，而每一個只包一個 `String`。
**是否值得取決於「這個 ID 被傳遞的距離」** ——
如果它只在一個方法裡活著，不值得；
如果它穿過 6 層、進 Map 的 key、進日誌，值得。

### 1.8.2 回傳型別的四個選項

| 回傳 | 什麼時候用 | shop-service 的例子 |
|---|---|---|
| **Domain 物件** | 呼叫端需要完整的狀態（Web 層要轉多種 DTO） | `Order create(...)` ⚠️ **見下方警告** |
| **Result record** | 呼叫端需要「發生了什麼」而不只是「新狀態」 | `CancellationResult`、`PaymentResult` |
| **ID（String）** | 呼叫端只需要「建好了，這是它的 ID」 | ⚠️ shop-service 不用 —— Controller 要回 201 body |
| **`void`** | 真的沒有東西要回 | `AuditRecorder.record(...)` |

⚠️⚠️ **第一列這個決定在 03 章 3.3.3 被推翻了，而理由正是它自己的「什麼時候用」欄位**：

> 「**Web 層要轉多種 DTO**」——
> 03 章 3.3.3 論證的是**這件事本身就不該發生**：
> 讓 Web 層拿到聚合，等於讓它做 `allowedActions(actor, now)` 這種**授權判斷**，
> 而且聚合已經離開交易（`LazyInitializationException`）。

**03 章的最終結論**：

| | 本節（01 章） | 03 章 3.3.3 |
|---|---|---|
| 命令路徑回什麼 | `Order`（聚合） | **`OrderResultView`**（在交易內組好的結果） |
| 誰算 `allowedActions` | Web 層的 mapper | **Application Service** |
| mapper 需要什麼 | `Order` + `actor` + `now` + `locale` | 只要 `View` + `locale` |

👉 **所以這張表的第一列，在 shop-service 最終是「不用」的。**
第二列（Result record）反而變成主要做法 ——
而 `OrderResultView` 就是一個 Result record。

⚠️ **但本節的其餘部分（`void` 與 `boolean` 的誤用）完全不受影響**，
那兩個判斷與「回聚合還是回 DTO」是正交的。

⚠️ **`void` 的一個常見誤用**：

```java
// 🔴 void 但其實有「發生了什麼」需要知道
public void cancel(CancelOrderCommand cmd) {
    Order order = orders.findById(…).orElseThrow(…);
    order.cancel(…);
    orders.save(order);
    if (order.status().isPaid()) {       // 🔴 已經被改成 CANCELLED 了
        refunds.create(…);
    }
}
```

**這正是 00 章 0.5.1 那個 bug。** `CancellationResult` 存在的理由就是它。

⚠️ **另一個常見誤用**：回傳 `boolean` 表示「成功 / 失敗」。

```java
// 🔴 呼叫端很容易忽略回傳值，而編譯器不會警告
public boolean cancel(CancelOrderCommand cmd) { … }

service.cancel(cmd);           // ← 回傳值被丟掉，失敗完全不會被發現
```

> 📌 **規則**：
> **「失敗」用例外表達，不用回傳值。**
> ⚠️ **唯一的例外**是「失敗是預期的正常結果」——
> 例如 `stock.tryReserve()` 回 `boolean`
> （`try` 這個字首就是在宣告「這可能不成功」）。
>
> 而那個例外必須讓「忽略回傳值」變得困難：
> shop-service 的 `tryReserve` 是在一個 `if (!…)` 裡被呼叫的，
> 而 SonarQube / ErrorProne 的 `@CheckReturnValue` 可以強制它。

### 1.8.3 不要「回傳 `Optional` 又同時拋例外」

```java
// 🔴 呼叫端不知道該處理哪一種
Optional<Order> findById(String orderId);        // 找不到 → empty
//                                              // 沒權限 → 拋例外
//                                              // 已刪除 → ？
```

**問題**：這個簽章有三種「沒有結果」的情況，
而 `Optional` 只表達了一種，另兩種要看 javadoc。

**兩種正確的做法：**

```java
// ✅ 做法 A：查詢用 Optional，「找不到就是錯」交給呼叫端決定
public interface OrderRepository {
    /** 找不到回 empty。★ 不做任何授權判斷。 */
    Optional<Order> findById(String orderId);
}

// Application Service 決定「找不到」的意義
Order order = orders.findByIdVisibleTo(id, actor)
        .orElseThrow(() -> new ResourceNotFoundException("Order", id));
```

```java
// ✅ 做法 B：Service 層一律拋例外（因為它知道語意）
public interface OrderService {
    /**
     * @throws ResourceNotFoundException 訂單不存在，<b>或</b>這個 actor 看不到它
     *         （★ 刻意合併 —— 不洩漏「這個 ID 存在」）
     */
    Order findById(String orderId, Actor actor);
}
```

⚠️ **注意做法 B 的 javadoc**：它明確寫下「不存在」與「沒權限」
**刻意回同一個例外**。那是一個安全決定（00 章 0.9.4 的第 ② 步），
而不寫下來的話，下一個人會「修正」它成 403。

**shop-service 的分工：**

```
Repository / 埠  → 回 Optional（它不知道「找不到」是不是錯）
Application Service → 拋例外（它知道語意）
Query Service      → ⚠️ 兩者都有：findById 拋例外，search 回空 Page
```

### 1.8.4 javadoc 的 `@throws` 是實質契約

04-controller 03 章要為每個例外配一個狀態碼。**它靠的就是這份清單。**

```java
/**
 * 取消訂單。
 *
 * <p>行為：
 * <ul>
 *   <li>只有 {@code PENDING_PAYMENT}、{@code PAID}、{@code PARTIALLY_SHIPPED} 可取消。</li>
 *   <li>客戶只能取消自己的訂單，且限下單後 7 天內。</li>
 *   <li>客服可取消任何訂單，但必須填 {@code note}。</li>
 *   <li>已付款的訂單會建立一筆退款（同一交易）。</li>
 *   <li>庫存在同一交易內還回。</li>
 *   <li>提交後（AFTER_COMMIT）非同步寄出取消通知。</li>
 * </ul>
 *
 * <p>⚠️ <b>冪等</b>：對已取消的訂單再次呼叫會拋
 * {@code OrderAlreadyCancelledException}（409）而<b>不是</b>靜默成功 ——
 * 因為「重複取消」通常代表客戶端狀態不同步，該讓它知道。
 *
 * @throws ResourceNotFoundException            訂單不存在或此 actor 看不到（404）
 * @throws OrderNotCancellableException         狀態不允許（409）
 * @throws OrderAlreadyCancelledException       已經取消過（409）
 * @throws SelfCancelWindowExpiredException     客戶超過 7 天（409）
 * @throws CancelNoteRequiredException          客服未填原因（422）
 * @throws RefundExceedsPaymentException        ⚠️ 不變量被破壞（500，代表有 bug）
 */
CancellationResult cancel(CancelOrderCommand command);
```

⚠️ **括號裡的 HTTP 狀態碼是刻意寫的**，即使 0.10.6 說 Service 不該認識 HTTP。

**為什麼可以？** 因為那是**javadoc**（給人看的文件），不是程式碼。
而它的價值是：**Controller 的開發者不需要去翻 `ErrorCode` 就知道會回什麼**。

**加一個守門測試，讓這份清單不會過期：**

```java
/**
 * ★★ javadoc 的 {@code @throws} 與實際會拋的例外一致嗎？
 *
 * <p>⚠️ 完整檢查需要靜態分析（javadoc 不在 bytecode 裡）。
 * 這裡用一個務實的替代：<b>檢查每個宣告的例外都有對應的 ErrorCode</b>，
 * 以及<b>每個 BusinessException 子類別都在某個 Service 的 javadoc 裡出現過</b>。
 *
 * <p>👉 後者用 source 掃描實作 —— 04-controller 7.8.2 的同一個手法。
 */
@Test
void 每個業務例外都有對應的ErrorCode與文件() throws IOException {
    var exceptions = new ClassGraph()
            .acceptPackages("example.shop")
            .enableClassInfo()
            .scan()
            .getSubclasses(BusinessException.class.getName())
            .loadClasses();

    var undocumented = new ArrayList<String>();
    String allSources = Files.walk(Path.of("src/main/java"))
            .filter(p -> p.toString().endsWith("Service.java"))
            .map(p -> {
                try { return Files.readString(p); }
                catch (IOException e) { throw new UncheckedIOException(e); }
            })
            .collect(Collectors.joining("\n"));

    for (Class<?> ex : exceptions) {
        if (!allSources.contains("@throws " + ex.getSimpleName())) {
            undocumented.add(ex.getSimpleName());
        }
    }

    assertThat(undocumented)
            .as("這些業務例外沒有在任何 Service 介面的 javadoc 裡宣告 —— "
              + "Controller 的開發者不會知道要處理它們")
            .isEmpty();
}
```

### 1.8.5 命名：`create` / `place` / `submit`

04-controller 站的介面用 `create()`。**如果從零開始，`place()` 更好：**

| 名字 | 語意 | 適用 |
|---|---|---|
| `create` | CRUD 的 C。**沒有業務含義** | 真的只是「新增一筆資料」（例如 `createAddress`） |
| **`place`** | 「下單」的業界標準說法（place an order） | ✅ 訂單 |
| `submit` | 「送出等待處理」—— 暗示有後續審核 | 退貨申請、報帳單 |
| `open` | 「開啟一段持續的狀態」 | 客服工單、帳戶 |
| `issue` | 「發行一個憑證」 | 發票、優惠券 |

**其他 use case 的命名對照：**

```
❌ CRUD 思維                    ✅ use case 思維
updateStatus(id, "PAID")        markPaid(MarkPaidCommand)
updateStatus(id, "SHIPPED")     ship(ShipOrderCommand)
update(order)                   changeShippingAddress(...)  / addItem(...) / …
delete(id)                      cancel(CancelOrderCommand)
```

⚠️ **`delete` → `cancel` 這一組特別重要。**

訂單**永遠不會被刪除**（財務與法規要求保留）。
一個叫 `delete()` 的方法會讓下一個人寫出 `DELETE FROM orders`，
而那是不可逆的資料損失。

> 📌 **命名的最低標準**：
> **方法名不可以暗示一件它不會做的事。**
> `delete` 暗示資料會消失 —— 而它不會。

**shop-service 的決定**（0.14.3 提過）：

> **保留 `create()`**。改名會影響 04-controller 站的 70 條端點、
> `OrderWebMapper`、350 個測試與 `orders-api.yaml` 的 `operationId`。
>
> ⚠️ **但在 javadoc 的第一行寫下正確的語意**：

```java
public interface OrderService {

    /**
     * <b>下單</b>（place an order）。
     *
     * <p>⚠️ 方法名是 {@code create} 而不是 {@code place} 是歷史原因
     * （04-controller 的 70 條端點與 350 個測試都用它，見 1.8.5）。
     * <b>它不是 CRUD 的 create</b> —— 它是一個有 8 條業務規則的 use case。
     */
    Order create(CreateOrderCommand command);
}
```

> 📌 **這是「無法修正的命名」的正確處理**：
> **不要假裝它是對的，也不要為了純度付出不成比例的代價。
> 把真相寫在文件裡。**

---

## 1.9 shop-service：完整的 Service 層骨架

### 1.9.1 類別清單與依賴數

| 類別 | 套件 | 依賴 | I/O 依賴 | 介面？ | 交易 |
|---|---|---|---|---|---|
| `OrderApplicationService` | `order.application` | 9 | 4 | ⚠️ `OrderService`（歷史） | `@Transactional` |
| `OrderQueryService` | `order.application` | 2 | 1 | ❌ | `readOnly` |
| `OrderPaymentService` | `order.application` | 7 | 4 | ❌ | 混合 |
| `OrderExportService` | `order.application` | 5 | 3 | ❌ | 混合 |
| `OrderExpirationJob` | `order.application` | 4 | 2 | ❌ | `@Transactional` |
| `OrderDataLoader` | `order.application` | 4 | 4 | ❌ | ❌ 無 |
| `OrderFactory` | `order.application` | 4 | 0 | ❌ | ❌ 無 |
| `PaymentGatewayRegistry` | `order.application` | 1（List） | 0 | ❌ | ❌ 無 |
| `CouponApplicationService` | `coupon.application` | 3 | 2 | ❌ | `@Transactional` |
| `StockApplicationService` | `stock.application` | 3 | 2 | ❌ | `@Transactional` |
| `PointCalculator` | `point.application` | 1 | 1 | ❌ | ❌ 無 |

**合計 11 個類別，最大的 9 個依賴、4 個 I/O 依賴。**

### 1.9.2 `OrderQueryService`

```java
package example.shop.order.application;

import example.shop.order.application.port.OrderQueryRepository;
import example.shop.order.domain.Actor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 訂單的讀取。
 *
 * <p>★★ 三個刻意的設計：
 * <ol>
 *   <li><b>類別層 {@code @Transactional(readOnly = true)}</b> ——
 *       這個類別沒有任何寫入方法，所以不需要逐一標註（00 章 0.10.8）。</li>
 *   <li><b>回傳投影而不是聚合</b>（1.2.3）—— 列表查詢不載入完整的 {@code Order}。</li>
 *   <li><b>{@code actor} 是每個方法的參數</b> ——
 *       「這個人看得到哪些訂單」是查詢條件的一部分，不是事後過濾。
 *       ⚠️ 事後過濾會讓分頁的 {@code totalElements} 錯掉
 *       （查 20 筆、過濾掉 3 筆 → 前端看到「共 100 筆」但每頁只有 17 筆）。</li>
 * </ol>
 *
 * <p>⚠️ 它<b>沒有</b>介面（1.3.5）。04-controller 站的 Controller 直接注入這個類別。
 */
@Service
@Transactional(readOnly = true)
public class OrderQueryService {

    private final OrderQueryRepository orders;
    private final StatusLabelResolver labels;

    public OrderQueryService(OrderQueryRepository orders, StatusLabelResolver labels) {
        this.orders = orders;
        this.labels = labels;
    }

    /**
     * 分頁查詢。
     *
     * <p>⚠️ 這個方法<b>沒有</b> {@code @throws} —— 查不到就是空頁，不是錯誤。
     */
    // ⚠️⚠️ 這個 Locale 參數是一個錯誤 —— 03 章 3.10.3 ② 會拿掉它。
    //    Application 層不該認識展示層（03 章 3.3.5 有一條 ArchUnit 規則在守，
    //    而它的黑名單裡就有 java.util.Locale）。
    //    ★ statusLabel 改由 Web 層加上，並用一個掃描測試守
    //      「每個 enum 欄位都有對應的 label 欄位」。
    public PageResponse<OrderSummaryView> search(OrderQuery query, Actor actor, Locale locale) {
        var page = orders.search(query, actor);
        // ★ PageResponse 的形狀是 04-controller 1.11.5 定的：(items, PageInfo)
        //   ⚠️ 它沒有 of(list, number, size, total) 這種工廠 ——
        //      外殼由 PageInfo.offset(...) / PageInfo.cursor(...) 決定
        return new PageResponse<>(
                page.getContent().stream().map(p -> toView(p, locale)).toList(),
                PageResponse.PageInfo.offset(page.getNumber(), page.getSize(),
                                             page.getTotalElements()));
    }

    /**
     * @throws ResourceNotFoundException 訂單不存在<b>或</b>此 actor 看不到（★ 刻意合併，1.8.3）
     */
    public OrderDetailView findById(String orderId, Actor actor, Locale locale) {
        return orders.findDetail(orderId, actor)
                .map(p -> toDetailView(p, actor, locale))
                .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));
    }

    /**
     * ★ 游標分頁（04-controller 1.9.4）。深分頁時比 offset 快得多。
     */
    public CursorPage<OrderSummaryView> scroll(OrderCursorQuery query, Actor actor,
                                               Locale locale) {
        // …
    }

    private OrderSummaryView toView(OrderSummaryProjection p, Locale locale) {
        return new OrderSummaryView(
                p.orderId(), p.orderNumber(), p.status(),
                // ★★ 用吃 Locale 的多載，不是無參版本 ——
                //    無參版本讀 LocaleContextHolder（ThreadLocal），
                //    在排程 / @Async / 串流上會拿到錯的語言（00 章 0.14.5）
                labels.label(p.status(), locale),
                p.total().toPlainString(),
                p.currency(), p.itemQuantity(), p.createdAt());
    }
}
```

⚠️ **「actor 進查詢條件而不是事後過濾」那一段值得再強調。**

```java
// 🔴 事後過濾 —— 分頁完全錯掉
Page<Order> page = orders.findAll(pageable);
List<Order> visible = page.getContent().stream()
        .filter(o -> actor.isInternal() || o.customerId().equals(actor.id()))
        .toList();
return new PageResponse<>(visible, page.getTotalElements());
//                                 ^^^^^^^^^^^^^^^^^^^^^ 這是「全部訂單」的數量
```

**症狀**：客戶看到「共 1,204,891 筆訂單」，
但翻到第 2 頁是空的。而**第一頁看起來完全正常**，
所以這個 bug 在 code review 與手動測試都不會被發現。

> 📌 **04-controller 7.9.5 的「IDOR 授權矩陣」測試會抓到它** ——
> 前提是那個測試要斷言 `totalElements` 而不只是 `content`。

### 1.9.3 `OrderExpirationJob`：第二個入口的實例

```java
package example.shop.order.application;

/**
 * 逾期未付款訂單的自動取消。
 *
 * <p>★★ 它是 00 章 0.7 判準 5「第二個入口」的實際樣子 ——
 * <b>而它一行業務規則都沒有寫</b>：
 * 狀態判斷、庫存還原、退款判斷全部來自 {@code Order.cancel()}。
 *
 * <p>⚠️ 三個排程特有的設計：
 * <ol>
 *   <li><b>分批處理</b> —— 一次一批（{@code expiration-batch-size}），
 *       否則交易變很長、鎖持有時間變長、rollback 成本變高。</li>
 *   <li><b>每一筆一個交易</b> —— 一筆失敗不影響其他筆。
 *       ⚠️ 這需要 {@code REQUIRES_NEW}（02 章 2.3.4），
 *       而它是這一站第一個真正需要非預設傳播行為的地方。</li>
 *   <li><b>多實例的重複執行</b> —— ⚠️ 3 個 pod 會同時跑這個排程。
 *       解法在下方。</li>
 * </ol>
 */
@Component
public class OrderExpirationJob {

    private final OrderRepository orders;
    private final OrderCancellationExecutor executor;   // ★ 見下方說明
    private final OrderProperties props;
    private final Clock clock;

    /**
     * ⚠️ {@code @Scheduled} 在多實例部署下會<b>每個實例都跑</b>。
     *
     * <p>三種處理：
     * <table>
     *   <tr><th>做法</th><th>代價</th></tr>
     *   <tr><td>分散式鎖（ShedLock / Redis）</td><td>多一個元件，但最直接</td></tr>
     *   <tr><td>只在特定 profile 啟用（一個「排程專用」的 pod）</td>
     *       <td>⚠️ 那個 pod 掛了排程就停了</td></tr>
     *   <tr><td><b>★ 讓操作本身冪等</b></td>
     *       <td>不需要鎖 —— 三個實例同時取消同一張訂單，
     *           只有一個會成功（{@code Order.cancel()} 對已取消的訂單拋例外）</td></tr>
     * </table>
     *
     * <p>👉 shop-service 用<b>第三種 + ShedLock</b>：
     * 冪等保證正確性，ShedLock 避免浪費（三個實例做同樣的查詢）。
     */
    @Scheduled(fixedDelayString = "${shop.order.expiration-interval:PT1M}")
    @SchedulerLock(name = "orderExpiration", lockAtMostFor = "5m")
    public void expireUnpaidOrders() {
        Instant now = clock.instant();
        int batchSize = props.expirationBatchSize();

        List<Order> expired = orders.findExpiredPendingPayment(now, batchSize);
        if (expired.isEmpty()) return;

        int cancelled = 0, skipped = 0;
        for (Order order : expired) {
            try {
                // ★ 每一筆一個交易 —— 一筆失敗不影響其他筆
                executor.cancelInNewTransaction(order.id(), now);
                cancelled++;
            } catch (OrderNotCancellableException | OrderAlreadyCancelledException e) {
                // ★ 預期的：別的實例或使用者剛好在同一時間付款/取消了 → 跳過
                skipped++;
            } catch (Exception e) {
                // ⚠️ 不預期的：記 ERROR 但繼續處理其他筆
                log.error("逾期取消失敗：order={}", order.id(), e);
            }
        }
        log.info("逾期訂單處理完成：找到 {} 筆，取消 {} 筆，跳過 {} 筆",
                 expired.size(), cancelled, skipped);

        // ⚠️ 如果這一批滿了，代表還有更多 —— 下一次觸發會繼續。
        //    ★ 不要在這裡用 while 迴圈把全部處理完：那會讓一次執行變成 20 分鐘，
        //      而 lockAtMostFor 到了之後別的實例會開始重複做同一件事。
        if (expired.size() == batchSize) {
            log.info("這一批已滿，仍有逾期訂單待處理");
        }
    }
}
```

⚠️ **`OrderCancellationExecutor` 為什麼要獨立出來？**

因為 `@Transactional(REQUIRES_NEW)` **不能加在 `expireUnpaidOrders()` 上**
（那會讓整批在一個交易裡），也**不能靠 `this.cancelOne()` 呼叫**
（自呼叫繞過代理，1.6.5）。

```java
package example.shop.order.application;

/**
 * ★ 「一筆訂單一個交易」的執行器。
 *
 * <p>⚠️ 它存在的唯一理由是 1.6.5 的自呼叫問題 ——
 * {@code @Transactional} 需要經過代理，而同類別的方法呼叫不會。
 *
 * <p>👉 這是 1.6.5「解法 A：拆成兩個 bean」的實際應用。
 */
@Component
public class OrderCancellationExecutor {

    private final OrderRepository orders;
    private final StockPort stock;
    private final DomainEventPublisher events;

    /**
     * @throws OrderNotCancellableException   狀態已改變（別人先動了）
     * @throws OrderAlreadyCancelledException 已被取消
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void cancelInNewTransaction(String orderId, Instant now) {
        // ★★ 重新讀一次 —— 因為排程查出來到現在可能過了幾百毫秒，
        //    而那期間使用者可能已經付款了（02 章 2.11 的樂觀鎖會處理更嚴格的情況）
        Order order = orders.findById(orderId)
                .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));

        var result = order.cancel(
                Actor.SYSTEM, CancelReason.PAYMENT_TIMEOUT, null, now);

        orders.save(order);
        result.stockReleases().forEach(r -> stock.release(r.productId(), r.quantity()));
        events.publish(OrderCancelledEvent.from(order, result, now));
    }
}
```

⚠️ **`Actor.SYSTEM` 與 `isPrivileged()` 的定義在 00 章 0.12 ⑫。**

它是 04-controller 站的一個缺口（`ActorType` 有 `SYSTEM`，但 `Actor` 上沒有對應的常數），
而排程正是第一個真的需要它的地方。

> ⚠️ **排程用 `SYSTEM` 而不是「某個管理員的帳號」是一個刻意的決定**：
> 稽核紀錄要能區分「人做的」與「系統做的」。
> 用管理員帳號跑排程，會讓那個帳號在稽核報表上有 40 萬筆操作 ——
> 於是真正由那個人做的 12 筆操作永遠找不到。

### 1.9.4 支援型別

**① `PageResponse` 與投影**

```java
package example.shop.order.application.port;

import example.shop.common.money.Money;
import example.shop.order.domain.OrderStatus;
import java.time.Instant;

/**
 * ★ 列表查詢的投影。
 *
 * <p>⚠️ 它<b>不是</b> Web 層的 DTO（那是 {@code OrderSummary}），
 * 也<b>不是</b> Domain 的聚合。
 *
 * <p>它是「資料庫查出來的那幾個欄位」——
 * 而它存在的理由是 1.2.3 那個「61 次查詢 vs 1 次查詢」的差別。
 */
public record OrderSummaryProjection(
    String orderId,
    String orderNumber,
    OrderStatus status,
    Money total,
    String currency,
    int itemQuantity,
    Instant createdAt
) {}
```

⚠️ **三層都有「訂單的摘要」，而它們是三個不同的型別：**

| 型別 | 套件 | 用途 |
|---|---|---|
| `Order` | `order.domain` | 有規則、有行為、完整狀態 |
| `OrderSummaryProjection` | `order.application.port` | 資料庫查出來的欄位 |
| `OrderSummaryView` | `order.application` | 加上 `statusLabel`、金額字串化 |
| `OrderSummary` | `order.web.dto` | 04-controller 站的 API 回應 |

**這看起來很囉唆。它值得嗎？**

| 合併哪兩個 | 代價 |
|---|---|
| `Projection` + `View` | ⚠️ **可以合併** —— shop-service 就合併了（`toView` 直接產生 View）。⚠️ 但 label 需要 `Locale`，而 Repository 不該認識 locale → 所以還是兩個 |
| `View` + `web.dto` | ⚠️ 可以，但 Web 層的 DTO 有 `@JsonInclude`、欄位順序、API 版本的考量（03 章會展開） |
| `Projection` + `Order` | 🔴 **不行** —— 那就是 1.2.3 的效能問題 |

> 📌 **一般原則**：
> **「跨越一個邊界」時可以共用型別，「跨越兩個」時不要。**
> `Projection` 跨 DB↔Application，`web.dto` 跨 Application↔HTTP。
> 讓一個 record 同時扛兩個邊界，就會出現「為了 API 的欄位順序而改 SQL」這種事。

**② `FixedOrderNumberGenerator`（測試用）**

```java
package example.shop.order.application.port;

/**
 * ★ 測試用的訂單編號產生器。
 *
 * <p>⚠️ 為什麼不用 Mockito：{@code OrderNumber} 的建構子會驗證格式，
 * 而 mock 回 {@code null} 會讓 {@code Order} 的建構子拋 NPE ——
 * 而那個 NPE 的訊息不會告訴你「你忘了 stub orderNumbers.next()」。
 */
public class FixedOrderNumberGenerator implements OrderNumberGenerator {

    private final java.util.concurrent.atomic.AtomicInteger seq =
            new java.util.concurrent.atomic.AtomicInteger();

    @Override
    public OrderNumber next(java.time.Instant now) {
        return OrderNumber.of(now, seq.incrementAndGet());
    }
}
```

**③ `InMemoryOrderRepository`（本站的假實作）**

```java
package example.shop.order.infrastructure;

/**
 * 記憶體版的訂單儲存（本站用，06 站會換成 JDBC）。
 *
 * <p>★★ 它是 1.3.3 情況 ③「介面真的有價值」的實例。
 *
 * <p>⚠️ 三個刻意的行為，讓它「像真的資料庫一樣會出錯」：
 * <ol>
 *   <li><b>{@code save} 存的是深拷貝</b> ——
 *       否則「忘記 save」的 bug 在記憶體版會通過（因為改的就是同一個物件），
 *       換成真資料庫才爆。<b>這是假實作最重要的一個細節。</b></li>
 *   <li><b>{@code findById} 回的也是拷貝</b> —— 同上。</li>
 *   <li><b>不模擬交易</b> —— ⚠️ 所以「rollback 有沒有把庫存還回去」
 *       這類測試<b>必須</b>用 Testcontainers（00 章 0.9.5 的第三層）。
 *       這個限制要明確寫下來，否則會有人寫出「在記憶體版通過但實際是錯的」測試。</li>
 * </ol>
 */
@Repository
@Profile("!jdbc")
public class InMemoryOrderRepository implements OrderRepository {

    private final Map<String, Order> store = new ConcurrentHashMap<>();
    private final OrderSnapshotCodec codec;      // ★ 深拷貝用

    @Override
    public void save(Order order) {
        store.put(order.id(), codec.copy(order));      // ★ 深拷貝
    }

    @Override
    public Optional<Order> findById(String orderId) {
        return Optional.ofNullable(store.get(orderId)).map(codec::copy);
    }

    @Override
    public Optional<Order> findByIdVisibleTo(String orderId, Actor actor) {
        // ★ isPrivileged() = isInternal() || SYSTEM（00 章 0.12 ⑫）
        return findById(orderId).filter(o -> actor.isPrivileged() || o.belongsTo(actor));
    }

    @Override
    public List<Order> findExpiredPendingPayment(Instant now, int limit) {
        return store.values().stream()
                .filter(o -> o.isExpired(now))
                .sorted(Comparator.comparing(Order::createdAt))
                .limit(limit)
                .map(codec::copy)
                .toList();
    }

    @Override
    public long countByCustomerId(String customerId) {
        return store.values().stream()
                .filter(o -> o.customerId().equals(customerId))
                .count();
    }

    /** ★ 測試用：清空。⚠️ 不在介面上 —— 它是這個實作的細節。 */
    public void clear() { store.clear(); }
}
```

⚠️ **「深拷貝」那一點是本節最重要的細節。**

```java
// 🔴 淺存：這個測試會通過，但程式碼是錯的
@Test
void 取消訂單() {
    Order order = orders.findById("ord_1").orElseThrow();
    order.cancel(actor, reason, null, now);
    // ⚠️ 忘了 orders.save(order)
    assertThat(orders.findById("ord_1").orElseThrow().status())
            .isEqualTo(OrderStatus.CANCELLED);      // ★ 通過！因為是同一個物件
}
```

**換成真的資料庫之後這個測試會失敗**（除了用 JPA 的 dirty checking 時 ——
而那又是另一個坑，08 章）。

> 📌 **假實作的黃金原則**：
> **它應該比真的實作「更嚴格」，不是更寬鬆。**
> 寬鬆的假實作會讓 bug 一路帶到生產環境。

**④ `OrderSnapshotCodec`：深拷貝**

```java
package example.shop.order.infrastructure;

/**
 * {@code Order} 的深拷貝。
 *
 * <p>⚠️ 為什麼不用 Java 序列化或 Jackson：
 * <ul>
 *   <li>Java 序列化需要 {@code Serializable}，而 domain 不該為了基礎設施加介面。</li>
 *   <li>Jackson 會讓 domain 依賴 Jackson（00 章 0.11.2 的 ArchUnit 規則）。</li>
 * </ul>
 *
 * <p>👉 所以用一個明確的「快照 record + 還原」——
 * ★ 而它<b>正好就是 06/08 站需要的東西</b>（持久化的形狀），
 * 所以這不是為了測試而寫的浪費。
 *
 * <p>⚠️ 但它有一個維護成本：<b>{@code Order} 加一個欄位，這裡要跟著改</b>，
 * 而漏改是<b>靜默的</b>（拷貝出來的物件少一個欄位）。
 * 👉 所以要有一個守門測試（見下方）。
 */
@Component
public class OrderSnapshotCodec {

    public Order copy(Order order) {
        return restore(snapshot(order));
    }

    public OrderSnapshot snapshot(Order order) { … }

    public Order restore(OrderSnapshot snapshot) { … }
}
```

```java
/**
 * ★★ 守門測試：{@code Order} 的每一個欄位都被拷貝了嗎？
 *
 * <p>它用反射比對「拷貝前」與「拷貝後」的每一個欄位 ——
 * 於是「加了欄位但忘記改 codec」會紅燈。
 */
@Test
void 深拷貝涵蓋Order的每一個欄位() throws Exception {
    Order original = Orders.fullyPopulated();      // ★ 每個欄位都有非預設值
    Order copy = codec.copy(original);

    for (Field f : Order.class.getDeclaredFields()) {
        if (Modifier.isStatic(f.getModifiers())) continue;
        f.setAccessible(true);
        assertThat(f.get(copy))
                .as("欄位 %s 沒有被拷貝 —— OrderSnapshotCodec 漏了它", f.getName())
                .isEqualTo(f.get(original));
    }
    // ★★ 而且必須是「不同的物件」（否則不是深拷貝）
    assertThat(copy).isNotSameAs(original);
    assertThat(copy.payments()).isNotSameAs(original.payments());
}
```

⚠️ **`Orders.fullyPopulated()` 是這個測試的關鍵。**
如果它建的 `Order` 有欄位是 `null`，那個欄位「拷貝後也是 null」→ 測試通過 → 漏檢。

> 📌 **這是「反射掃描測試」的通用陷阱**：
> 掃描本身是對的，但**輸入資料不完整會讓它變成假綠燈**。
> 04-controller 7.7 的 Object Mother 要有一個 `fullyPopulated()` 變體，
> 專門給這類測試用。

---
## 1.10 常見誤區

**誤區 1：「Service 一定要有介面」**

1.3 的整節。一句話：

> **介面的價值取決於它兩側有什麼。**
> 一個介面配一個實作、而且兩者永遠一起改 —— 那個介面沒有隔離任何東西。

⚠️ 而最重要的一點是：**「為了 AOP 要介面」在 Boot 2.0 之後已經不成立**
（CGLIB 是預設值）。很多人的直覺還停在 Spring 3 的時代。

---

**誤區 2：「依賴多就是壞設計，要想辦法減少」**

不精確。**要看那些依賴的性質**（1.2.1）。

```
Clock、IdGenerator、PricingPolicy、ShippingFeePolicy  → 5 個，測試成本接近 0
OrderRepository、ProductRepository、StockPort…        → 5 個，每個都是可能失敗的 I/O
```

**後者才是複雜度。** 而把前者「藏起來」（例如用一個 `ServiceContext` 包住）
只是讓依賴變得不可見，不是變少。

---

**誤區 3：「拆成越多小類別越好」**

1.2.4 的三個代價。**拆分是有成本的**：

| 成本 | 說明 |
|---|---|
| 找東西 | 40 個 handler 之後，「取消訂單的邏輯在哪」變成搜尋而不是瀏覽 |
| 相關邏輯被分開 | `cancel` 與 `expireUnpaid` 共用 `Order.cancel()` 卻在兩個檔案 |
| 介面的形狀 | 一個介面對 8 個實作 → 需要 facade，而 facade 又是一層轉發 |

> 📌 **判準不是「幾行」或「幾個依賴」，是
> 「讀這個檔案時，腦裡需要裝幾種抽象層次」**（00 章 0.3.4）。

---

**誤區 4：「用 `@Lazy` 解掉循環依賴就好了」**

1.6.4 解法 ⑥。它**沒有修好設計**，只是讓啟動不失敗。

⚠️ 而它的五個問題裡最嚴重的是：
**它在「呼叫端」宣告** —— 讀被依賴的那個類別完全看不出它參與了循環。

---

**誤區 5：「`allow-circular-references: true` 只是一個設定」**

🔴 **它可能讓 `@Transactional` 與 `@Async` 靜默失效**（1.6.2）。

症狀是「這個方法明明有 `@Transactional`，但資料沒有 rollback」——
而那是**在生產環境的資料損毀之後**才被發現的那種 bug。

---

**誤區 6：「Service A 呼叫 Service B 很正常，大家都這樣寫」**

1.5.2 的五個後果。最關鍵的一個：

> **`@Transactional` 方法呼叫另一個 `@Transactional` 方法，
> 交易的形狀就不再是「讀一個方法就能看懂」的了。**

⚠️ 而「大家都這樣寫」通常是真的 —— 但那些專案也都有
「不知道為什麼這個交易沒有 rollback」的 issue。

---

**誤區 7：「介面放哪裡不重要，反正編譯得過」**

1.7.2。**介面放在 `infrastructure` 會讓它的形狀被外部 API 決定**，
而那正是埠與轉接器要避免的事。

**檢查方法**：看那個介面的方法簽章。
如果裡面有金流商 SDK 的型別、或「以分為單位的 long」這種外部約定，
它就放錯邊了。

---

**誤區 8：「每個外部依賴都要包一層介面」**

1.7.4。**抽象本身有成本，而「它擋掉的功能」最常被低估。**

包 `ObjectMapper` 的專案，最後都會有一個
`ObjectMapper raw()` 的逃生門，而所有人都用它。

---

**誤區 9：「回傳 `boolean` 表示成功失敗很方便」**

1.8.2。**呼叫端會忽略它，而編譯器不會警告。**

```java
service.cancel(cmd);       // 🔴 回傳的 false 被丟掉，取消失敗完全沒有人知道
```

⚠️ **唯一的例外**是方法名以 `try` 開頭（`tryReserve`、`tryConsume`）——
那個字首在宣告「這可能不成功，你必須處理」。

---

**誤區 10：「假實作寬鬆一點沒關係，反正是測試用的」**

1.9.4。🔴 **相反：假實作應該比真的更嚴格。**

`InMemoryOrderRepository` 如果不做深拷貝，
「忘記 `save()`」的 bug 在所有測試裡都會通過，
然後在上線第一天爆發。

---

**誤區 11：「`@Value` 跟 `@ConfigurationProperties` 差不多，看習慣」**

1.4.5 的六個差別。最實際的兩個：

| 差別 | 後果 |
|---|---|
| `@Value` 的 key 打錯 + 有預設值 | 🔴 **靜默使用預設值** —— 於是你的設定檔那一行是死的 |
| `@Value` 不能做跨欄位驗證 | 「retention 至少 24 小時」這種規則無處可放 |

---

**誤區 12：「`Map<String, T>` 注入多實作很優雅」**

1.4.4 做法 ②。⚠️ **它的 key 是 bean 名稱**，
於是「重新命名一個類別」會改變 API 的行為。

**用策略註冊表（做法 ③）**：key 由實作自己宣告，型別安全，
而且衝突與遺漏在**啟動時**就發現。

---

## 1.11 本章練習

### 練習 1：判斷這 10 個類別要不要介面

用 1.3.4 的決策表。**先自己判斷，再看答案。**

```
① OrderApplicationService     訂單的 5 個命令，只有一個實作
② EmailSender                 目前用 SMTP，公司在評估換 SendGrid
③ OrderWebMapper              Order → DTO 的轉換，只有一個實作
④ TaxCalculator               台灣 5% 營業稅，公司明年要開日本站
⑤ CsvWriter                   靜態工具，寫 CSV 的一列
⑥ InvoiceNumberAllocator      發票號碼配號，需要查資料庫的字軌表
⑦ AuditRecorder               目前寫 DB，未來可能改送 Kafka
⑧ OrderProperties             @ConfigurationProperties
⑨ StockPort                   目前查自家 DB，未來可能接外部 WMS
⑩ PasswordHasher              目前用 BCrypt，可能升級到 Argon2
```

<details>
<summary>答案</summary>

| # | 要介面？ | 理由 | 判準 |
|---|---|---|---|
| ① `OrderApplicationService` | ⚠️ **不需要**（shop-service 保留是歷史包袱） | 只有一個實作、不跨 module、測試用 Mockito 可以 mock 具體類別 | 全部否 → 不需要 |
| ② `EmailSender` | ✅ **要** | 「公司在評估換」= **現在**就有第二個實作的計畫；而且測試不能真的寄信 | 情況 ①③ |
| ③ `OrderWebMapper` | ❌ **不要** | 一個實作、純函式、測試直接 `new` 它（04-controller 0.10.3 明講「絕對不要 mock 它」） | 全部否 |
| ④ `TaxCalculator` | ✅ **要** | 台灣 5% / 日本 10%（還有輕減稅率 8%）= 兩個實作。⚠️ 而且它是**業務規則**，介面讓「哪一個稅制」變成一個明確的選擇 | 情況 ① |
| ⑤ `CsvWriter` | ❌ **不要** | 靜態工具、純函式、不會換。⚠️ 04-controller 05 章明確說它是「靜態工具」 | 全部否 |
| ⑥ `InvoiceNumberAllocator` | ⚠️ **看情況** | 它查 DB（會失敗）→ 傾向要。⚠️ 但如果它只有一個實作、也不需要 fake 測試（可以用 Testcontainers），那就不要。**shop-service 選「要」**，因為單元測試需要一個「回傳固定號碼」的實作 | 情況 ③ |
| ⑦ `AuditRecorder` | ✅ **要** | 「未來可能改送 Kafka」⚠️ 這是「預測未來」（1.3.2 ②）—— 但**測試需要一個「記錄在記憶體裡好斷言」的實作**，那才是真正的理由 | 情況 ③ |
| ⑧ `OrderProperties` | ❌ **不要** | 它是資料，不是行為。⚠️ 它是 `record`，介面對 record 沒有意義 | 全部否 |
| ⑨ `StockPort` | ✅ **要** | 外部系統的邊界（即使現在是自家 DB）+ 測試要 fake | 情況 ②③ |
| ⑩ `PasswordHasher` | ✅ **要** | ⚠️ 但**不要自己定義** —— Spring Security 的 `PasswordEncoder` 已經是那個介面了（1.7.4：不要重複包裝既有的抽象） | 情況 ① |

⚠️ **⑥ 與 ⑦ 的共同點值得注意**：
它們「要介面」的真正理由**不是**「未來可能換實作」，
而是「**測試需要一個非 mock 的替代實作**」。

> 📌 **1.3.2 ② 說「為了以後換實作」是預測未來、通常是錯的。
> 但「為了測試」是現在就成立的需求。**
> **這兩個理由常被混為一談，而它們的可靠度差很多。**

</details>

---

### 練習 2：解掉這個循環依賴

```java
@Service
public class OrderApplicationService {
    private final CouponApplicationService coupons;
    private final NotificationService notifications;
    // …
    @Transactional
    public Order create(CreateOrderCommand cmd) {
        Money discount = coupons.applyAndConsume(cmd.couponCode(), subtotal, cmd.actor());
        // …
        notifications.sendOrderConfirmation(order.id());
        return order;
    }
}

@Service
public class CouponApplicationService {
    private final OrderQueryService orders;

    @Transactional
    public Money applyAndConsume(String code, Money subtotal, Actor actor) {
        Coupon coupon = repository.findByCode(code).orElseThrow(…);
        // 規則：同一個客戶同一張券只能用 3 次
        long used = orders.countOrdersWithCoupon(actor.id(), code);
        if (used >= 3) throw new CouponAlreadyUsedException(code);
        // …
    }
}

@Service
public class NotificationService {
    private final OrderQueryService orders;

    public void sendOrderConfirmation(String orderId) {
        OrderDetailView detail = orders.findById(orderId, Actor.SYSTEM, Locale.TAIWAN);
        mailSender.send(buildMail(detail));
    }
}

@Service
@Transactional(readOnly = true)
public class OrderQueryService {
    private final OrderApplicationService orderService;   // 為了重用一段「可見性」判斷
    // …
}
```

**任務**：
1. 畫出所有循環。
2. 對每一條邊判斷「該不該存在」。
3. 用 1.6.4 的解法修好它，並說出每一步的代價。

<details>
<summary>答案</summary>

**① 循環**

```
循環 A：orderApplicationService → couponApplicationService → orderQueryService
                               → orderApplicationService
循環 B：orderApplicationService → notificationService → orderQueryService
                               → orderApplicationService
```

**兩個循環共用同一條「回頭邊」**：`orderQueryService → orderApplicationService`。

**② 每一條邊**

| 邊 | 該不該存在 | 理由 |
|---|---|---|
| `order → coupon`（ApplicationService） | 🔴 **不該** | 1.5.3 的規則：跨領域不呼叫對方的 Application Service。⚠️ 而且 `applyAndConsume` 有 `@Transactional`，交易形狀不可推理 |
| `coupon → orderQuery` | 🔴 **不該** | 「這個客戶用過幾次」的資料應該在 coupon 領域（1.6.4 解法 ①） |
| `order → notification` | 🔴 **不該** | 通知是 commit 之後的副作用（00 章判準 3） |
| `notification → orderQuery` | 🔴 **不該** | 1.6.1 來源 ②：基礎設施反過來依賴業務 |
| `orderQuery → orderApplicationService` | 🔴 **不該** | **讀取不該依賴命令**。而「重用一段可見性判斷」的正解是把它抽成一個純函式或放進查詢條件 |

**四條邊全部不該存在。** 這不意外 —— 循環依賴幾乎總是「好幾個設計問題疊在一起」。

**③ 逐步修復**

**步驟 1：斷 `orderQuery → orderApplicationService`（解法 ③ 抽共用元件）**

「可見性判斷」是一段純邏輯，抽成 domain 的方法：

```java
// order/domain/OrderVisibility.java
/**
 * ★ 「這個 actor 看得到哪些訂單」的規則，唯一的一份。
 *
 * <p>⚠️ 它是純函式（沒有 I/O），所以放 domain。
 * 而 Repository 用它產生查詢條件、Domain 用它做第二道檢查。
 */
public final class OrderVisibility {

    public static boolean canSee(Actor actor, String orderCustomerId) {
        return actor.isPrivileged() || orderCustomerId.equals(actor.id());
    }

    /** ★ 給 Repository 產生 WHERE 條件用：null = 不限制。 */
    public static String customerIdFilter(Actor actor) {
        return actor.isPrivileged() ? null : actor.id();
    }

    private OrderVisibility() {}
}
```

**代價**：多一個類別。**收益**：規則只有一份，而且是純函式（好測）。

**步驟 2：斷 `coupon → orderQuery`（解法 ① 重新劃分職責）**

「同一個客戶同一張券用過幾次」的資料搬到 coupon 領域：

```sql
CREATE TABLE coupon_usage (
    coupon_code  VARCHAR(32) NOT NULL,
    customer_id  VARCHAR(32) NOT NULL,
    order_id     VARCHAR(32) NOT NULL,
    used_at      DATETIME(6) NOT NULL,
    PRIMARY KEY (coupon_code, customer_id, order_id),
    -- ★★ 這條索引讓「這個客戶用過幾次」是一次索引掃描
    KEY idx_coupon_customer (coupon_code, customer_id)
);
```

```java
public interface CouponUsageRepository {

    int countUsage(String couponCode, String customerId);

    /**
     * ★★ 原子的「檢查次數 + 記錄使用」。
     *
     * <p>⚠️ 只有 {@code countUsage} + {@code if} 是不夠的（00 章 0.8.4）——
     * 兩個請求同時查到 2 次 → 都通過 → 變成 4 次。
     *
     * <p>👉 主鍵 {@code (coupon_code, customer_id, order_id)} 讓
     * 「同一張訂單重複記錄」不可能；而「次數上限」則靠
     * <b>先 INSERT 再 count，超過就讓交易 rollback</b>：
     *
     * @return true = 記錄成功且未超過上限
     */
    boolean tryRecordUsage(String couponCode, String customerId,
                           String orderId, int maxPerCustomer, Instant at);
}
```

**代價**：多一張表、需要在下單時寫入它。
**收益**：循環消失、查詢變快（不用 JOIN order 表）、而且**併發正確**。

⚠️ **這個步驟同時修好了一個原本就存在的 race condition** ——
這很典型：**循環依賴常常與併發問題同源**（都是「資料放錯地方」）。

**步驟 3：斷 `order → coupon`（解法 ① 下推 domain）**

```java
// ✅ Application Service 只用 Repository 與 domain
@Transactional
public Order create(CreateOrderCommand cmd) {
    // …
    Coupon coupon = couponRepository.findByCode(cmd.couponCode()).orElseThrow(…);

    // ★ 「能不能用、折多少」在 Coupon 裡（00 章 0.12 ⑨）
    Order order = factory.create(cmd, ctx, now);

    // ★ 「次數上限 + 記錄」是原子操作，直接呼叫 Repository
    if (!couponUsage.tryRecordUsage(coupon.code(), cmd.actor().id(),
                                    order.id(), coupon.maxPerCustomer(), now)) {
        throw new CouponAlreadyUsedException(coupon.code());
    }
    if (!couponRepository.tryConsume(coupon.code())) {
        throw new CouponExhaustedException(coupon.code());
    }
    // …
}
```

**代價**：`OrderApplicationService` 多一個依賴（`couponUsage`；`couponRepository` 本來就有）。
**收益**：交易形狀完全可見（全部在同一個 `@Transactional` 裡）。

⚠️ **這是一個真實的取捨**：依賴數從 9 變成 10。
**而它是對的** —— 因為「多兩個 Repository」比「交易形狀不可推理」便宜太多。

**步驟 4：斷 `order → notification` 與 `notification → orderQuery`（解法 ② 事件）**

```java
// ✅ 事件帶著通知需要的資料（1.6.1 的「中等胖度」，工廠見 00 章 0.12 ⑬）
events.publish(OrderPlacedEvent.from(order, ctx.customer().email(), now));
```

```java
@Component
public class OrderNotificationListener {

    private final EmailSender email;               // ★ 只依賴埠，不依賴任何 Service

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async("notificationExecutor")
    public void onOrderPlaced(OrderPlacedEvent event) {
        try {
            email.send(OrderConfirmationMail.from(event));
        } catch (Exception e) {
            // ⚠️ 通知失敗不影響訂單（00 章 0.3.1 的「可以遺失」那一類）
            log.warn("訂單確認信寄送失敗：order={}", event.orderId(), e);
        }
    }
}
```

**代價**：事件變胖（多帶 email 與明細）；通知變成最終一致。
**收益**：兩條邊一次消失，而且通知不再佔用交易時間（00 章 0.3.2 事故 1）。

**④ 修完之後的依賴圖**

```
OrderApplicationService ──→ OrderRepository、CouponRepository、CouponUsageRepository、
                            StockPort、OrderDataLoader、OrderFactory、
                            DomainEventPublisher、Clock
                            （★ 全部是「下層」，沒有任何 ApplicationService）

OrderQueryService ─────────→ OrderQueryRepository、StatusLabelResolver
                            （★ 不依賴任何 ApplicationService）

OrderNotificationListener ─→ EmailSender
                            （★ 只依賴埠）

CouponApplicationService ──→ CouponRepository、CouponUsageRepository
                            （★ 不依賴 order）
```

**零循環，而且每一條邊都指向「更下層」。**

⚠️ **順手記錄一個觀察**：四個步驟裡有三個的正解是
「**把資料 / 邏輯放到正確的領域**」，只有一個是「換注入方式」。

> 📌 **這就是 1.6.4 那張表的結論**：
> **循環依賴是設計問題的症狀，`@Lazy` 只是把體溫計藏起來。**

</details>

---

### 練習 3：設計一個「退款」的埠

**需求**：
- 退款要打金流商的 API。
- 可以全額退，也可以部分退。
- 一筆付款可以退很多次（但總額不可超過付款金額）。
- 金流商的退款是**非同步**的：呼叫之後回「受理中」，實際結果由 webhook 通知。
- 有些付款方式（超商代碼）**不能線上退款**，要走人工匯款。
- 退款可能失敗（原卡片已註銷）。

**任務**：設計 `RefundPort` 介面、請求與結果型別，並說出每個決定的理由。

<details>
<summary>答案</summary>

```java
package example.shop.order.application.port;

/**
 * 退款埠。
 *
 * <p>★★ 這個介面最重要的三個設計決定：
 * <ol>
 *   <li><b>{@code refund} 的結果是「受理狀態」而不是「退款結果」</b> ——
 *       因為金流商是非同步的。把它設計成同步會讓上層寫出
 *       「呼叫完就以為退好了」的程式碼。</li>
 *   <li><b>「不支援線上退款」是一個明確的結果分支</b>，不是例外 ——
 *       超商代碼付款要走人工匯款，那是一個<b>正常的業務流程</b>。</li>
 *   <li><b>有一個 {@code query} 方法</b> —— 理由與 {@code PaymentGateway.query}
 *       相同（1.7.2）：webhook 會遺失，必須有對帳的能力。</li>
 * </ol>
 */
public interface RefundPort {

    /** ★ 由實作宣告它支援哪些付款方式的線上退款。 */
    Set<PaymentMethod> onlineRefundableMethods();

    /**
     * 送出退款請求。
     *
     * <p>⚠️ 它<b>不代表退款完成</b>。實際結果由 webhook 或 {@link #query} 得知。
     *
     * @throws RefundGatewayTimeoutException 逾時 —— ★ 結果未知，<b>不可以重試</b>，
     *         要用 {@code query} 確認
     */
    RefundAcceptance refund(RefundRequest request);

    /** ★ 對帳用：查一筆退款現在的狀態。 */
    Optional<RefundStatus> query(String refundTradeNo);
}
```

```java
/**
 * 退款請求。
 *
 * <p>⚠️ {@code refundTradeNo} 是<b>我們</b>產生的，而且是冪等鍵 ——
 * 同一個編號重送不會退兩次。
 * <b>「一筆付款可以退很多次」就是它不能用 paymentId 的原因。</b>
 */
public record RefundRequest(
    String refundTradeNo,
    /** ★ 對應的原始付款（金流商需要它來找那筆交易）。 */
    String gatewayTradeNo,
    PaymentMethod originalMethod,
    Money amount,
    RefundReason reason,
    /** ⚠️ 只有部分退款需要 —— 有些金流商要求指明退哪幾個品項。 */
    List<RefundLine> lines
) {
    public record RefundLine(String productId, int quantity, Money amount) {}
}
```

```java
/**
 * 退款受理的結果。
 *
 * <p>★★ sealed interface 的四個分支，涵蓋所有真實情況。
 */
public sealed interface RefundAcceptance {

    /** 已受理，等待 webhook 或對帳。⚠️ <b>不是「已退款」</b>。 */
    record Accepted(String gatewayRefundNo, Instant acceptedAt,
                    /** ★ 預估到帳時間 —— 客服最常被問的問題 */
                    Duration estimatedCompletion) implements RefundAcceptance {}

    /**
     * ★ 已完成（少數金流商的小額退款是同步的）。
     *
     * <p>⚠️ 這個分支存在的理由：如果沒有它，同步完成的退款
     * 也要等 webhook —— 而那個 webhook 可能永遠不會來。
     */
    record Completed(String gatewayRefundNo, Instant completedAt) implements RefundAcceptance {}

    /**
     * ★★ 不支援線上退款 → 走人工匯款。
     *
     * <p>⚠️ 這<b>不是</b>錯誤 —— 它是一個正常的業務分支。
     * 上層要建立一張「人工匯款工單」而不是回 500。
     */
    record RequiresManualTransfer(ManualTransferReason reason) implements RefundAcceptance {}

    /**
     * 金流商拒絕。
     *
     * @param reason ★ 對映到我們的 ErrorCode，不是金流商的原始碼
     */
    record Rejected(RejectReason reason, String gatewayMessage) implements RefundAcceptance {}

    enum ManualTransferReason {
        /** 超商代碼／ATM 轉帳，金流商不支援退回原路 */
        METHOD_NOT_REFUNDABLE,
        /** 超過金流商的退款期限（通常 180 天） */
        REFUND_WINDOW_EXPIRED,
        /** 原始交易已被結算，不能沖銷 */
        ALREADY_SETTLED
    }

    enum RejectReason {
        ORIGINAL_TRANSACTION_NOT_FOUND, AMOUNT_EXCEEDS_ORIGINAL,
        CARD_CLOSED, MERCHANT_BALANCE_INSUFFICIENT, OTHER
    }
}
```

**上層怎麼用它（展示 sealed 的價值）：**

> ⚠️ **下面的程式碼呼叫了 `Order` 上還不存在的兩個方法**：
> `order.paymentById(paymentId)` 與 `order.requestRefund(...)`。
>
> 那是**刻意的**：退款是 `DELIVERED → REFUNDED` 這條狀態機的邊，
> 而 00 章 0.9.5 的 `狀態機的每一條邊都有對應的操作` 測試
> **現在就因為它紅燈**（`markRefunded` 不存在）。
>
> 👉 **這個練習設計的是「埠」，不是聚合**。
> 聚合那一側（`requestRefund` / `markRefunded` / `paymentById`
> 與不變量 I8 的守法）在 **04 章（業務例外設計）**補上 ——
> 屆時那個測試會自動變綠。

```java
@Transactional
public RefundResult refund(RefundCommand cmd) {
    Order order = orders.findById(cmd.orderId()).orElseThrow(…);
    Payment payment = order.paymentById(cmd.paymentId());

    // ★ 不變量 I8 在 domain 裡先檢查（給好的錯誤訊息）
    Refund refund = order.requestRefund(
            ids.newRefundId(), cmd.paymentId(), cmd.amount(), cmd.reason(),
            cmd.actor(), clock.instant());
    orders.save(order);

    // ⚠️ 埠的呼叫要在交易外 —— 這裡簡化，06 章 6.8 會給正確的形狀
    RefundAcceptance acceptance = refundPort.refund(toRequest(refund, payment));

    // ★★ 沒有 default —— 新增一個分支時這裡編譯失敗
    return switch (acceptance) {
        case RefundAcceptance.Accepted a -> {
            refund.markAccepted(a.gatewayRefundNo(), a.acceptedAt());
            yield RefundResult.pending(refund, a.estimatedCompletion());
        }
        case RefundAcceptance.Completed c -> {
            refund.markCompleted(c.completedAt());
            events.publish(new RefundCompletedEvent(order.id(), refund.id(), …));
            yield RefundResult.completed(refund);
        }
        case RefundAcceptance.RequiresManualTransfer m -> {
            // ★ 建立人工工單，而不是失敗
            manualTransfers.create(order, refund, m.reason());
            yield RefundResult.manualTransferRequired(refund, m.reason());
        }
        case RefundAcceptance.Rejected r -> {
            refund.markRejected(r.reason());
            // ⚠️ gatewayMessage 只記 log，不進回應（04-controller 3.11.2）
            log.warn("退款被拒：refund={} reason={} msg={}",
                     refund.id(), r.reason(), r.gatewayMessage());
            throw new RefundRejectedException(refund.id(), r.reason());
        }
    };
}
```

**五個關鍵決定的理由：**

| 決定 | 理由 |
|---|---|
| `refund()` 回「受理」而不是「結果」 | 金流商是非同步的。同步的簽章會讓上層寫錯 |
| `RequiresManualTransfer` 是結果不是例外 | 它是正常業務流程（超商代碼付款佔台灣電商約 20%） |
| 有 `query()` | webhook 會遺失，必須能對帳 |
| `refundTradeNo` 而不是 `paymentId` 當冪等鍵 | 一筆付款可以退很多次 |
| 用 `sealed interface` | 新增分支時所有 `switch` 編譯失敗 |

⚠️ **一個常見的錯誤設計，值得對照：**

```java
// 🔴 這個簽章讓上層無法寫對
boolean refund(String paymentId, BigDecimal amount);
```

**它的四個問題**：
① `boolean` 不能表達「受理中」；
② `paymentId` 當冪等鍵 → 第二次部分退款會被當成重複；
③ `BigDecimal` 沒有幣別；
④ 「不支援線上退款」只能用例外表達 → 上層會 catch 然後不知道該做什麼。

</details>

---

### 練習 4：找出這段程式碼的 12 個問題

```java
@Service
@Transactional
public class MemberServiceImpl implements MemberService {

    @Autowired private MemberRepository memberRepository;
    @Autowired private OrderService orderService;
    @Autowired private PointService pointService;
    @Autowired private CouponService couponService;
    @Autowired private NotificationService notificationService;
    @Autowired private ApplicationContext context;

    @Value("${member.upgrade.gold-threshold}")
    private int goldThreshold;

    @Value("${member.upgrade.vipThreshold}")
    private int vipThreshold;

    public boolean upgradeIfEligible(String memberId) {
        Member member = memberRepository.findById(memberId).get();

        BigDecimal yearlyAmount = orderService.sumAmountThisYear(memberId);

        String newLevel = member.getLevel();
        if (yearlyAmount.intValue() >= vipThreshold) {
            newLevel = "VIP";
        } else if (yearlyAmount.intValue() >= goldThreshold) {
            newLevel = "GOLD";
        }

        if (newLevel.equals(member.getLevel())) {
            return false;
        }

        member.setLevel(newLevel);
        member.setUpgradedAt(new Date());
        memberRepository.save(member);

        // 升等禮
        pointService.grant(memberId, 500);
        couponService.issueUpgradeCoupon(memberId, newLevel);
        notificationService.sendUpgradeNotification(memberId, newLevel);

        AuditService audit = context.getBean(AuditService.class);
        audit.log("MEMBER_UPGRADE", memberId, newLevel);

        return true;
    }

    private void doDowngrade(String memberId) {
        Member m = memberRepository.findById(memberId).get();
        m.setLevel("NORMAL");
        memberRepository.save(m);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    private void recordAttempt(String memberId) { … }
}
```

<details>
<summary>答案</summary>

| # | 問題 | 嚴重度 | 節次 |
|---|---|---|---|
| 1 | **注入 4 個其他 Service** | 🔴🔴 | 1.5.2 —— 交易形狀不可推理；而 `orderService → memberService` 幾乎必然造成循環 |
| 2 | **注入 `ApplicationContext`** | 🔴 | 1.4.7 —— 依賴不可見，`AuditService` 在建構子上看不到 |
| 3 | **`@Value("${member.upgrade.vipThreshold}")` 駝峰** | 🔴 | 1.4.5 —— ⚠️ **relaxed binding 對 `@Value` 不生效**，這個 key 找不到 → 啟動失敗（還算幸運）。若有預設值就是**靜默用預設值** |
| 4 | **`@Transactional` 在 private 方法上** | 🔴 | 1.3.1 —— `recordAttempt` **完全沒有交易**，而且 `REQUIRES_NEW` 的意圖完全落空 |
| 5 | **`findById(...).get()`** | 🔴 | 1.8.3 —— 不存在時 `NoSuchElementException` → 500 而不是 404 |
| 6 | **在交易裡發通知** | 🔴🔴 | 00 章 0.3.2 事故 1、2 —— 升等失敗回滾了但信已經寄出 |
| 7 | **升等規則寫在 Service** | 🔴 | 00 章 0.5 —— 應該是 `MemberLevel.forYearlyAmount(amount)` 這種 domain 方法。⚠️ 而它會被「排程批次升等」重寫一次 |
| 8 | **`yearlyAmount.intValue()`** | ⚠️ | 00 章 0.5.3 —— 靜默截斷小數；而且金額該用 `Money` |
| 9 | **字串等級 `"VIP"` / `"GOLD"`** | ⚠️ | 打錯字不會被發現；`CustomerLevel` enum 已經存在（00 章 0.12 ⑦） |
| 10 | **`new Date()`** | ⚠️ | 1.4.6 —— 不可測；該注入 `Clock` |
| 11 | **回傳 `boolean`** | ⚠️ | 1.8.2 —— 呼叫端會忽略；而且「升到哪一級」這個資訊遺失了。應該回 `UpgradeResult`（含 `previousLevel`、`newLevel`、`grantedRewards`） |
| 12 | **類別層 `@Transactional`** | ⚠️ | 0.10.8 —— 讀取方法也開可寫交易 |

**⑬ 額外**：`doDowngrade` 是 private 且沒有被呼叫 —— 死碼，
而它暗示「降等功能寫到一半」。**而降等沒有稽核、沒有通知**，
若哪天被接上去會是一個資料事故。

**⑭ 一個隱藏的邏輯 bug**：

```java
String newLevel = member.getLevel();          // ← 從當前等級開始
if (yearlyAmount >= vipThreshold) newLevel = "VIP";
else if (yearlyAmount >= goldThreshold) newLevel = "GOLD";
```

⚠️ **已經是 VIP 的人，如果今年消費掉到 GOLD 門檻以下，`newLevel` 保持 "VIP"**
（因為初始值是當前等級，而兩個 `if` 都不成立）。

**這可能是刻意的（等級只升不降），也可能是 bug。**
而**看程式碼看不出來** —— 這正是 00 章 0.5.2 說的
「規則寫在流程裡，讀 `Member` 這個檔案看不到任何規則」。

**重構後：**

```java
// ── domain ──────────────────────────────────────────
public enum CustomerLevel {
    NORMAL(Money.twd("0")), SILVER(Money.twd("30000")),
    GOLD(Money.twd("100000")), VIP(Money.twd("300000"));

    private final Money yearlyThreshold;

    /**
     * ★★ 依年度消費決定等級。
     *
     * <p>⚠️ <b>只升不降</b>是一個明確的業務決定（見 {@link Member#evaluateUpgrade}）——
     * 這個方法只回答「這個金額對應哪一級」，不處理升降。
     */
    public static CustomerLevel forYearlyAmount(Money amount) {
        return Arrays.stream(values())
                .filter(l -> amount.isGreaterThanOrEqual(l.yearlyThreshold))
                .max(Comparator.comparing(CustomerLevel::ordinal))
                .orElse(NORMAL);
    }
}
```

```java
// ── Member 聚合 ──────────────────────────────────────
public class Member {

    /**
     * 依年度消費評估升等。
     *
     * <p>★★ <b>只升不降</b> —— 這是刻意的業務規則：
     * 降等會讓客戶感覺被懲罰，而挽回一個流失客戶的成本
     * 遠高於多給一年的折扣。<b>（原程式碼的行為是對的，只是沒有寫下來。）</b>
     *
     * @return 升等的結果；沒有升等時是 {@link UpgradeResult#none()}
     */
    public UpgradeResult evaluateUpgrade(Money yearlyAmount, Instant now) {
        CustomerLevel eligible = CustomerLevel.forYearlyAmount(yearlyAmount);
        if (eligible.ordinal() <= this.level.ordinal()) {
            return UpgradeResult.none();               // ★ 只升不降
        }
        CustomerLevel previous = this.level;
        this.level = eligible;
        this.upgradedAt = now;
        return UpgradeResult.upgraded(previous, eligible, UpgradeReward.forLevel(eligible));
    }
}
```

```java
// ── Application Service ─────────────────────────────
@Service
public class MemberApplicationService {

    private final MemberRepository members;
    private final OrderStatsRepository orderStats;    // ★ Repository，不是 OrderService
    private final AuditRecorder audit;
    private final DomainEventPublisher events;
    private final Clock clock;
    // 5 個依賴（原本 6 個 Service + context + 2 個 @Value）

    /**
     * @throws ResourceNotFoundException 會員不存在
     */
    @Transactional
    public UpgradeResult evaluateUpgrade(String memberId) {
        Instant now = clock.instant();
        Member member = members.findById(memberId)
                .orElseThrow(() -> new ResourceNotFoundException("Member", memberId));

        // ★ 直接查統計，不經過 OrderService
        Money yearly = orderStats.sumAmountInYear(memberId, Year.now(clock).getValue());

        UpgradeResult result = member.evaluateUpgrade(yearly, now);
        if (!result.upgraded()) return result;

        members.save(member);
        audit.record(AuditEvent.memberUpgraded(member, result, now));

        // ★ 點數、優惠券、通知全部交給事件（commit 之後）
        events.publish(new MemberUpgradedEvent(
                memberId, result.previousLevel(), result.newLevel(),
                result.rewards(), now));

        return result;
    }
}
```

**依賴從 6 個 Service + `ApplicationContext` + 2 個 `@Value`
變成 5 個（其中 2 個是 `Clock` 與 `AuditRecorder`）。**

</details>

---

## 1.12 驗收清單

**Service 的大小**

- [ ] 「14 個依賴」該怎麼分析？哪一類才是真正的複雜度？
- [ ] 三個「該拆」的訊號是什麼？
- [ ] 讀寫分離的六個好處裡，哪一個最重要？為什麼？
- [ ] 「用聚合做列表查詢」的具體代價是多少？
- [ ] 拆成「一個 use case 一個 handler」的三個代價是什麼？
- [ ] `OrderDataLoader` 為什麼不是傳話筒？它做了哪三件真正的事？
- [ ] `OrderPaymentService` 為什麼要獨立出來？

**介面**

- [ ] 「每個 Service 配一個介面」的六個理由，哪四個已經不成立？
- [ ] Spring Boot 從哪個版本開始 CGLIB 是預設？這推翻了哪個理由？
- [ ] CGLIB 代理的三個限制是什麼？哪一個是「靜默失效」？
- [ ] 介面真正有價值的五種情況？
- [ ] 「為了以後換實作」與「為了測試需要 fake」哪一個是可靠的理由？
- [ ] 拿掉介面之後一定要做的第 5 步是什麼？

**依賴注入**

- [ ] 建構子注入在 Service 層特有的三個理由？
- [ ] Lombok `@RequiredArgsConstructor` 的最大代價是什麼？怎麼補回來？
- [ ] `lombok.config` 沒設定的症狀是什麼？
- [ ] `Optional<T>`、`ObjectProvider<T>`、`@Lazy` 各自的用途？
- [ ] `List<T>` 與 `ObjectProvider<T>` 在「沒有任何實作」時的差別？
- [ ] 「多實作」的四種做法各自適用什麼？為什麼策略註冊表最好？
- [ ] `@ConditionalOnProperty` 的一組 bean 為什麼一定要有 `matchIfMissing`？
- [ ] `@Value` 與 `@ConfigurationProperties` 的六個差別？
- [ ] 「把不確定性注入進來」的完整清單有哪六項？
- [ ] 為什麼 `SecurityContextHolder` 不該在 Service 裡讀？
- [ ] ULID 相對 UUIDv4 的三個好處與一個代價？
- [ ] `getMonotonicUlid()` 與 `getUlid()` 的差別會造成什麼 bug？

**Service 之間**

- [ ] 三種呼叫關係哪一種是灰色地帶？
- [ ] 「A 注入 B 的 ApplicationService」的五個後果？哪一個最嚴重？
- [ ] 為什麼「呼叫別的領域的 Repository」可以，「ApplicationService」不行？
- [ ] 五種解耦手段各自適用什麼？哪一種最常用？
- [ ] 為什麼 `stock` 不用事件而 `point` 用？
- [ ] 「查這個商品賣了幾張訂單」的三個正解？shop-service 選哪一個、為什麼？
- [ ] 三種「直接呼叫另一個 Service 是對的」情況？
- [ ] facade 與傳話筒的差別在哪？

**循環依賴**

- [ ] 循環依賴的三個常見來源？
- [ ] 為什麼 `allow-circular-references: true` 可能讓 `@Transactional` 失效？
- [ ] 錯誤訊息的三個讀法要點？
- [ ] 「從循環裡挑哪一條邊來斷」的原則是什麼？
- [ ] 六種解法的排序與各自的代價？為什麼 `@Lazy` 最糟？
- [ ] 胖事件與瘦事件的五個差別？重試時哪一種比較好？
- [ ] 自我注入為什麼需要 `@Lazy`？三種替代解法？
- [ ] ArchUnit 的 `beFreeOfCycles` 抓的是什麼？跟 Spring 的檢查有什麼不同？
- [ ] `List<OrderLine>` 為什麼不能傳給 `List<DiscountableLine>` 的參數？

**埠與方法簽章**

- [ ] 埠的介面該放哪一邊？放錯的四個後果？
- [ ] `ChargeResult` 為什麼用 sealed interface？
- [ ] 「逾時」與「明確失敗」為什麼一定要分開？
- [ ] `PaymentGateway.query()` 存在的理由是什麼？它對「選金流商」有什麼意義？
- [ ] `longValueExact()` 與 `longValue()` 的差別？
- [ ] 三個「需要埠」的判準？包 `ObjectMapper` 為什麼是過度設計？
- [ ] Command 物件 vs 散開參數的判準？
- [ ] 「回傳 `boolean` 表示成敗」的問題？唯一的例外是什麼？
- [ ] 「回傳 `Optional` 又拋例外」為什麼不好？兩種正確做法？
- [ ] `delete` 為什麼不可以用在訂單上？

**如果有任何一題答不出來，回去讀對應的小節**：

| 題目範圍 | 小節 |
|---|---|
| Service 的大小與拆分 | 1.2 |
| 介面 vs 實作（爭議點 1） | **1.3** |
| 依賴注入的細節 | 1.4 |
| Service 之間（爭議點 2） | **1.5** |
| 循環依賴 | **1.6** |
| 埠與轉接器 | 1.7 |
| 方法簽章 | 1.8 |
| shop-service 骨架 | 1.9 |

---

## 1.13 下一章預告

這一章決定了「**Service 長什麼樣、依賴誰**」。
下一章是這一站的**核心章**，也是唯一不能跳的一章：

> **`@Transactional` 到底做了什麼？而它在什麼時候完全沒有作用？**

這一章已經三次提到「02 章會講」，把它們收集起來就是下一章的地圖：

| 這一章埋的伏筆 | 02 章哪一節 |
|---|---|
| CGLIB 代理的三個限制（1.3.1） | 2.7.2 —— **「非 public / final / static」這個失效情境的完整機制** |
| `this.method()` 繞過代理（1.6.5） | 2.7.1 —— 自呼叫，以及四種解法 |
| `REQUIRED` / `REQUIRES_NEW` / `NESTED` 的差別（1.5.2） | **2.3 —— 七種傳播行為的完整矩陣** |
| `readOnly = true` 的三個非效能作用（00 章 0.10.8） | 2.5 |
| `tryReserve` 的原子 SQL（00 章 0.8.3） | 2.11 —— **樂觀鎖 vs 悲觀鎖 vs 原子 UPDATE** |
| 「檢查與寫入之間的縫」（00 章 0.3.2 事故 3） | 2.11.2 |
| `OrderCancellationExecutor` 的 `REQUIRES_NEW`（1.9.3） | 2.3.4 |
| 交易裡 catch 例外 → `UnexpectedRollbackException`（00 章 0.10.4） | 2.8 |
| `spring.transaction.default-timeout`（00 章 0.11.3） | 2.9 |
| 「一天最多改 3 次地址」的 race（04-controller 0.14 練習 4） | 2.11.5 |

**02 章的章節地圖：**

| 節 | 主題 |
|---|---|
| 2.1～2.2 | 交易是什麼、ACID 在 Spring 裡的實際樣子、**為什麼這一章要用真的 MySQL** |
| 2.3 ★ | 七種傳播行為，以及「哪一種在哪一種裡面」的完整矩陣 |
| 2.4 | 隔離級別：四種、三種讀異常、MySQL 的預設值為什麼是 `REPEATABLE READ` |
| 2.5 | `readOnly`、`timeout`、`rollbackFor` 的完整語意 |
| 2.6 | rollback 規則：**為什麼 checked exception 預設不 rollback** |
| 2.7 ★★ | **五種失效情境**：自呼叫、非 public / final / static、非 Spring 管理的物件、換了執行緒、例外被 catch 掉 |
| 2.8 | `UnexpectedRollbackException` 與 rollback-only 標記 |
| 2.9 | 交易的邊界與長度：連線池、逾時、**交易裡不可以做的六件事** |
| 2.10 | `TransactionTemplate` 與程式式交易：什麼時候比註解好 |
| 2.11 ★★ | **併發控制**：樂觀鎖、悲觀鎖、原子 UPDATE、以及它們的選擇 |
| 2.12 | 事件與交易：`@TransactionalEventListener` 的四個 phase |
| 2.13 | 診斷：怎麼證明「這個方法真的在交易裡」 |

⚠️ **02 章會破例使用 Testcontainers 起一個真的 MySQL**，
理由是 00 章 0.2.2 說的：**交易與併發沒有辦法用記憶體假實作學。**

---

**完成本章後**，請確認你的專案有：

```
✅ order/application/OrderApplicationService.java   9 個依賴（原本 14）
✅ order/application/OrderQueryService.java         readOnly，回傳投影
✅ order/application/OrderDataLoader.java           批次查詢 + 缺資料的例外
✅ order/application/OrderFactory.java              ★ 價格只可能來自 PricingPolicy
✅ order/application/OrderExpirationJob.java        + OrderCancellationExecutor
✅ order/application/PaymentGatewayRegistry.java    ★ 啟動時檢查衝突與遺漏
✅ order/application/port/PaymentGateway.java       ★ sealed ChargeResult
✅ order/infrastructure/TapPayGateway.java          + @RestClientTest
✅ order/infrastructure/InMemoryOrderRepository.java ★ 深拷貝
✅ coupon/domain/DiscountableLine.java              ★ 消除套件循環
✅ TransactionalProxyTest.java                      ★★ 所有 @Transactional 都被代理攔截
✅ LayeredArchitectureTest 新增 3 條規則            final 方法、ApplicationContext、依賴數上限
```

⚠️ 課程中的程式碼、YAML 與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
（這台機器上沒有安裝 JDK 與 Maven）。基準版本延續 04-controller 站：
**Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1 / Jackson 2.17 / ArchUnit 1.3**。
若你的版本不同，課程會標註差異，但仍請以你的環境實測為準。

下一章：[02-transaction-management-in-depth.md](./02-transaction-management-in-depth.md)
