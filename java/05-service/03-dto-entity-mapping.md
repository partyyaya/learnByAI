# 第 03 章：DTO ↔ Entity 轉換

> 這一章處理的是一條**邊界**：`Order` 這個聚合，怎麼變成 API 回應的 JSON，
> 以及 HTTP 送進來的 JSON，怎麼變成 Domain 能吃的東西。
>
> 它聽起來像是「寫幾個 `toDto()` 方法」的雜事。
> **而它是我見過最容易埋出「靜默」bug 的一層。**
>
> 靜默的意思是：不會拋例外、不會進 log、測試會綠燈、code review 看不出來。
> 你會在三個月後從客服的 ticket、或者財務的對帳差額裡發現它。
>
> ⚠️ 這一章有一件事和前三章不同：
> **00～02 章講的是「怎麼做對」，這一章有一半在講「怎麼讓做錯時會大聲失敗」。**
> 因為轉換的錯誤幾乎不可能靠「小心一點」避免 —— 欄位有 40 個，
> 而人類逐欄位比對 40 個欄位的正確率遠低於你以為的。

---

## 3.0 先看見痛：三個真實事故

### 事故 1：客戶看到了客服對他的評語

一個上線 14 個月的訂單系統，Controller 長這樣：

```java
@GetMapping("/orders/{orderId}")
public Order get(@PathVariable String orderId) {
    return orderRepository.findById(orderId).orElseThrow();   // ← 直接回 Entity
}
```

**它運作得很好，一年多沒出問題。**

然後客服部門提了一個需求：「希望能在訂單上記內部備註」。
後端工程師加了一個欄位：

```java
@Entity
public class Order {
    // ... 既有的 23 個欄位
    @Column(name = "internal_note")
    private String internalNote;          // ★ 新增
}
```

**加完就部署了。沒有改任何 Controller，也不需要改 —— 那正是問題。**

三週後，一個客戶截圖到社群：

```json
{
  "id": "ord_88213",
  "status": "PENDING_PAYMENT",
  "internalNote": "此客戶三次無故取消，建議列入觀察名單，不用太積極處理"
}
```

| 這個事故的關鍵 | 說明 |
|---|---|
| **沒有人「犯錯」** | 加欄位的人不知道 Entity 會被序列化；寫 Controller 的人不知道未來會加敏感欄位 |
| **測試不會抓到** | 現有測試斷言「回應裡有 `status`」，沒有人斷言「回應裡**沒有**其他東西」 |
| **Code review 不會抓到** | 那個 PR 只有一個 `@Column` 和一個欄位 |
| **它是「預設洩漏」** | 🔴 加欄位的預設行為是**公開**，而不是隱藏 |

> 📌 **這一章最核心的一句話**：
> **回傳 Entity 的系統，「新增欄位」的預設行為是「對外公開」。**
> 而任何一個「預設不安全」的設計，早晚一定會出事 ——
> 不是因為有人粗心，而是因為需求會一直來。

### 事故 2：日本站的訂單被當成台幣

同一個系統後來接了日本站。DTO 是手寫的：

```java
public OrderDetail toDetail(Order order) {
    return new OrderDetail(
            order.getId(),
            order.getOrderNumber(),
            order.getStatus().name(),
            order.getTotalAmount(),
            // ⚠️ currency 忘了填 —— 而 record 的參數是 12 個
            null,
            order.getCreatedAt(),
            // ...
    );
}
```

前端拿到 `currency: null`，於是走了 fallback：

```javascript
const cur = order.currency ?? 'TWD';       // 🔴 前端的「貼心」
```

**結果**：日本客戶的 `¥12,800` 訂單在確認頁顯示 `NT$12,800`。
兩者差 4 倍多，而客戶按下了「確認付款」。

| 為什麼沒被發現 | |
|---|---|
| 台灣站測試全部通過 | `currency` 本來就是 `TWD`，fallback 剛好對 |
| mapper 的單元測試有寫 | 但它只斷言了 `orderId`、`status`、`totalAmount` 三個欄位 |
| 編譯器完全沒意見 | `null` 是合法的 `String` |

⚠️ **注意這個 bug 的形狀**：它不是「填錯」，是「**填了 null**」。
而 `null` 對編譯器來說永遠是合法的 ——
所以「手寫 mapper 漏一個欄位」永遠不會是編譯錯誤（3.4.2 會完整拆解）。

### 事故 3：一個 `@JsonIgnore` 讓退款金額憑空消失

第三個事故是「解法本身變成問題」。

事故 1 之後，團隊的處置是「在敏感欄位上加 `@JsonIgnore`」：

```java
@Entity
public class Order {
    @JsonIgnore private String internalNote;
    @JsonIgnore private Integer riskScore;
    @JsonIgnore private Customer customer;        // ← 為了避免遞迴
    // ...
}
```

看起來解決了。**半年後，退款功能上線，出現一個詭異的 bug**：
後台的退款畫面上，「已退金額」永遠是 0。

原因：`Order` 有一個 `refunds` 集合，而它上面有 `@JsonIgnore` ——
因為當初為了「避免序列化整棵物件樹」，有人把幾個集合一起標了。

**而後台的退款畫面用的是同一個端點。**

| 這個事故告訴我們什麼 | |
|---|---|
| **`@JsonIgnore` 是黑名單** | 你必須「想到」每一個要藏的欄位。想不到的就洩漏 |
| **它是全域的** | 同一個 Entity 給客戶看與給後台看，用同一份標註 → 必然衝突 |
| **它把「API 契約」寫進 Domain** | 🔴 `Order` 這個聚合現在依賴 Jackson，而且它的形狀被「客戶端能看什麼」綁住 |

> 📌 三個事故指向同一個結論：
> **「Entity 要不要對外」不是一個可以靠標註管理的問題，
> 它是一個「型別」問題。**
> 而型別問題的處理方式是：**做兩個型別**。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說出「不要回傳 Entity」的**六個具體代價**，每一個都能舉出重現方式。
- 說明為什麼 `@JsonIgnore` 是**錯誤方向**的解法（黑名單 vs 白名單）。
- 說明「用 Entity 接請求」為什麼比「用 Entity 回應」更危險（mass assignment）。
- 分辨**三種轉換策略**（Service 回 Domain / Service 回 DTO / 讀取模型直接查投影），
  並為每一個端點選出合適的一種。
- 重新檢視 00 章 0.14.1 那個「mapper 需要 `actor`、`now`、`locale`」的決定，並說出它揭露了什麼。
- 說出「漏映射一個欄位」的**三種形狀**，以及為什麼三種都是靜默的。
- 說明為什麼 `BeanUtils.copyProperties` 與 `ModelMapper` 在「重構安全性」上比手寫更差。
- 設定 MapStruct，並說出 `unmappedTargetPolicy = ERROR` 是它**唯一不可替代**的價值。
- 說出 MapStruct 做不到或會出錯的**五件事**。
- 處理巢狀與集合轉換，並說出 `List.copyOf` 的**三個邊界**。
- 把 `PATCH` 的三態語意從 HTTP 一路帶到 Domain，而**不讓 `JsonNullable` 進到 Service 層**。
- 設計依角色決定可見性的 DTO，並讓「客服專用 mapper 被客戶端點呼叫」**大聲失敗**。
- 寫出**四個掃描測試**，讓「漏映射」「洩漏敏感欄位」「金額型別錯」在 CI 就紅燈。
- 說出 `LazyInitializationException` 的三種解法，以及為什麼 `open-in-view` 是最差的一種。

## 前置知識

[00 章](./00-course-map-business-layer-role.md)（0.9.2 的 `Order` 聚合、0.10.3「不該回傳 Entity」）、
[01 章](./01-service-design-and-dependency.md)（1.8 方法簽章、1.9.2 `OrderQueryService`、1.9.4 三層投影）、
[02 章](./02-transaction-management-in-depth.md)（2.9 交易邊界 —— 3.9 需要它）。

**04-controller 站的這幾節這一章會反覆引用**：

| 節 | 內容 |
|---|---|
| 04-controller 1.6.4 | `JsonNullable` 與 `PATCH` 的三態 |
| 04-controller 1.11.5 | `PageResponse` / `PageInfo` 的形狀 |
| 04-controller 6.5.7 | **金額對外序列化成字串** |
| 04-controller 6.5.8 | `LabeledEnum` 與 `StatusLabelResolver` |
| 04-controller 6.6.2 | `@Masked` 與 `MaskedCardNumber` |
| 04-controller 6.7.4 | `DtoSerializabilityTest` |
| 04-controller 6.8.3 | 三個 DTO vs `@JsonView` 的決定 |
| 04-controller 7.7 | Object Mother 與 `fullyPopulated()` |

---

## 3.2 為什麼不回傳 Entity ★★

00 章 0.10.3 已經下了結論（「不該回傳 Entity 給 Web 層」），
但它只給了兩行理由。**這一節把代價完整攤開** ——
因為「知道規則」與「知道違反規則時會發生什麼」是兩件事，
而只有後者能讓你在趕上線的那一天不走捷徑。

### 3.2.1 六個具體的代價

| # | 代價 | 症狀 | 什麼時候爆 |
|---|---|---|---|
| 1 | **新增欄位自動洩漏** | 客戶看到 `internalNote`、`riskScore`、`costPrice` | 加欄位的那次部署 |
| 2 | **API 契約被資料庫形狀綁死** | 欄位改名 = 破壞 API；不敢改資料表 | 第一次重構資料表時 |
| 3 | **雙向關聯 → 無限遞迴** | `StackOverflowError` 或 12MB 的 JSON | 加上 `@OneToMany` 的反向關聯時 |
| 4 | **延遲載入 → 交易外爆炸 / N+1** | `LazyInitializationException`、一頁 20 筆發 61 次查詢 | 上生產環境（開發環境資料少看不出來） |
| 5 | **反序列化方向：mass assignment** | 前端送 `{"status":"PAID"}` 就付款成功 | 🔴 被人發現的那天 |
| 6 | **無法演進** | 沒辦法同時支援 v1 與 v2 的欄位形狀 | 第一個第三方客戶接上來時 |

下面逐一給重現。

---

**代價 1：新增欄位自動洩漏**

3.0 的事故 1 就是它。但它有一個更難察覺的變體 —— **關聯物件的欄位**：

```java
@Entity
public class Order {
    @ManyToOne(fetch = FetchType.EAGER)
    private Customer customer;                  // ← 只是想讓前端顯示客戶名字
}

@Entity
public class Customer {
    private String name;
    private String email;
    private String phone;
    private String nationalId;                  // 🔴 身分證號
    private String passwordHash;                // 🔴🔴 密碼雜湊
    private BigDecimal lifetimeValue;            // 🔴 內部指標
}
```

**回傳一張訂單，順便回傳了客戶的密碼雜湊。**

⚠️ 而這個洩漏是**傳遞性**的：`Order → Customer → ...`。
你檢查了 `Order` 的 23 個欄位，但 `Customer` 的 18 個欄位是誰檢查的？
`Customer.address → Address.geoLocation` 又是誰檢查的？

> 📌 **一個可以量化的判準**：
> 回傳 Entity 時，你要人工檢查的欄位數不是「這個 Entity 的欄位數」，
> 而是**它可達的整張物件圖的欄位總數**。
> shop-service 的 `Order` 直接欄位 23 個，可達的物件圖 **147 個欄位**。

---

**代價 2：API 契約被資料庫形狀綁死**

```java
@Entity
public class Order {
    @Column(name = "cust_id")
    private String custId;          // ← 十年前的命名，現在想改成 customerId
}
```

改欄位名有兩個層面：

| 層面 | 難度 |
|---|---|
| 資料庫的欄位名（`cust_id`） | ✅ 改 `@Column(name = ...)` 就好，不影響任何人 |
| **Java 的欄位名（`custId`）** | 🔴 它就是 JSON 的 key → **改了就破壞所有客戶端** |

於是團隊做了那個所有人都做過的決定：**「算了，不改。」**

三年後，這個系統裡有 `custId`、`customerId`、`customer_id` 三種寫法，
新人每次都要問「這三個是同一個東西嗎」。

⚠️ **更糟的方向是反過來**：為了 API 好看而改資料表。

```java
// 前端說「orderNumber 這個名字太長，改成 no」
@Column(name = "no")               // 🔴 資料表欄位跟著改名了
private String no;
```

現在 DBA 的報表、BI 的 SQL、資料倉儲的 ETL 全部要跟著改 ——
**只因為前端覺得欄位名太長**。

> 📌 **DTO 真正的作用是「把兩個變化速率不同的東西解耦」**：
> 資料庫的形狀因**儲存與查詢效率**而變，
> API 的形狀因**客戶端需求**而變。
> 兩者的變化理由完全不同，所以它們必須是兩個型別。

---

**代價 3：雙向關聯 → 無限遞迴**

```java
@Entity
public class Order {
    @OneToMany(mappedBy = "order")
    private List<OrderLine> lines;
}

@Entity
public class OrderLine {
    @ManyToOne
    private Order order;                        // ← 反向關聯（JPA 需要它）
}
```

序列化 `Order`：

```
Order → lines[0] → order → lines[0] → order → lines[0] → ...
```

```
java.lang.StackOverflowError
	at com.fasterxml.jackson.databind.ser.BeanSerializer.serialize(...)
	at com.fasterxml.jackson.databind.ser.std.CollectionSerializer.serialize(...)
	at com.fasterxml.jackson.databind.ser.BeanSerializer.serialize(...)
	... 重複 1024 次
```

**三種「標準解法」，三種都有問題**：

| 解法 | 問題 |
|---|---|
| `@JsonIgnore` 在 `OrderLine.order` 上 | 需要「反向」時（例如查明細列表要顯示訂單編號）沒辦法 |
| `@JsonManagedReference` / `@JsonBackReference` | 只能處理一對關聯；三方環（A→B→C→A）處理不了 |
| `@JsonIdentityInfo` | JSON 變成 `{"@id":1,...}` / `{"@id":1}` 的形狀 —— **前端要自己組圖** |

⚠️ 而三種**都是「在 Domain 類別上加 Jackson 註解」** ——
也就是讓聚合根依賴一個序列化框架。
00 章 0.11.2 的 ArchUnit 規則明確禁止這件事：

```java
@ArchTest
static final ArchRule domain不可依賴Jackson =
        noClasses().that().resideInAPackage("..domain..")
                   .should().dependOnClassesThat()
                   .resideInAnyPackage("com.fasterxml.jackson..");
```

**用 DTO 之後這個問題根本不存在** —— 因為 DTO 是一棵樹，不是一張圖：

```java
public record OrderDetail(String orderId, List<OrderItemDto> items) {}
public record OrderItemDto(String productId, int quantity, String lineTotal) {}
//                          ^^^ 沒有指回 OrderDetail 的欄位，因為不需要
```

> 📌 **這是 DTO 的一個常被忽略的價值**：
> **Domain 是圖（graph），API 是樹（tree）。**
> 而「把圖投影成樹」這件事必須有人做決定 —— 決定從哪裡切、切幾層。
> 那個決定就是 mapper。

---

**代價 4：延遲載入 → 交易外爆炸 / N+1**

這一個 3.9 會完整處理（它需要 02 章的交易知識），這裡先看形狀：

```java
// Controller
@GetMapping("/orders/{id}")
public Order get(@PathVariable String id) {
    return orderService.findById(id);        // ← @Transactional 在這裡結束
}
// ⚠️ 序列化發生在【方法回傳之後】——
//    Jackson 存取 order.getLines() 時，Hibernate Session 已經關了
```

```
org.hibernate.LazyInitializationException:
failed to lazily initialize a collection of role:
example.shop.order.domain.Order.lines - could not initialize proxy - no Session
```

⚠️ **而這個例外的發生時機非常討厭**：它在**序列化中途**才拋。
此時 HTTP 狀態碼 `200` 與部分 body 可能已經寫進 output stream 了 ——
04-controller 3.9.2 講過這個情境：`ResponseEntity` 已提交，
`@ExceptionHandler` 無法再改狀態碼，客戶端收到的是**一段截斷的 JSON**。

```json
{"id":"ord_1","orderNumber":"ORD-20260827-0001","lines":[
```

**客戶端的 JSON parser 報「Unexpected end of input」，而你的 log 裡是 `LazyInitializationException`。**
這兩個訊息之間的距離，就是這個 bug 難查的原因。

---

**代價 5：反序列化方向 —— mass assignment** 🔴

**這是六個代價裡唯一的「安全漏洞」等級。**

```java
@PostMapping("/orders")
public Order create(@RequestBody Order order) {          // 🔴🔴 用 Entity 接請求
    return orderRepository.save(order);
}
```

正常的請求：

```json
{ "customerId": "cus_1", "lines": [{"productId": "P-1", "quantity": 2}] }
```

**攻擊者的請求**：

```json
{
  "customerId": "cus_1",
  "lines": [{"productId": "P-1", "quantity": 2, "unitPrice": 0.01}],
  "status": "PAID",
  "totalAmount": 0.01,
  "paidAt": "2026-08-27T10:00:00Z"
}
```

他建立了一張「已付款、總金額 0.01 元」的訂單。**而倉庫會照著出貨。**

| 為什麼這比代價 1 嚴重 | |
|---|---|
| 代價 1 是**洩漏**（讀） | 這是**竄改**（寫） |
| 代價 1 需要有人注意到 | 這個可以自動化利用 |
| 代價 1 的欄位是你加的 | 🔴 **這裡的欄位是攻擊者選的** —— 他會試 `id`、`version`、`customerId`、`isAdmin`… |

⚠️ **`fail-on-unknown-properties: true` 幫不上忙** ——
04-controller 1.6.5 那個設定擋的是「**未知**欄位」，
而 `status` 對 `Order` 來說是**已知**欄位。

⚠️ **`@JsonIgnore` 也幫不上忙**（至少不是可靠地）：
`@JsonIgnore` 同時關掉讀與寫。當你需要「可以讀但不能寫」時要用
`@JsonProperty(access = READ_ONLY)`，而那又是一個**要記得標**的東西。

**唯一可靠的做法**：用一個**只有可寫欄位**的 request DTO。

```java
/** ★ 04-controller 2.12.1。注意它「沒有」status、totalAmount、id、paidAt。 */
public record CreateOrderRequest(
    @NotEmpty @Size(max = 50) List<@Valid Item> items,
    @NotBlank String shippingAddressId,
    String couponCode,
    @TextLength(max = 200) String customerNote,
    @Valid InvoiceRequest invoice
) {
    public record Item(@NotBlank String productId, @Min(1) @Max(999) int quantity) {}
    // ★★ 沒有 unitPrice —— 價格由 Service 查（00 章 0.6.2）
}
```

> 📌 **「白名單」在這裡是型別層級的**：
> `CreateOrderRequest` 這個 record **不可能**接到 `status`
> —— 不是「會被忽略」，是「這個型別沒有那個欄位」。
> 而 `fail-on-unknown-properties: true` 讓它進一步變成 **400 而不是靜默忽略**。

---

**代價 6：無法演進**

第一個第三方客戶接上來，提出一個需求：

> 「我們的系統只能處理扁平的 JSON，`amounts` 不能是巢狀物件。」

如果回的是 DTO，這是一個 `OrderDetailV2` 的事：

```java
// v1
public record OrderDetail(String orderId, Amounts amounts) {}
// v2（扁平）
public record OrderDetailV2(String orderId, String subtotal, String discount,
                            String shippingFee, String total) {}
```

**兩個 mapper 方法，兩個端點，各自演進。** 完成。

如果回的是 Entity —— 你只有一個 `Order` 類別，而它的形狀由 JPA 與資料表決定。
於是唯一的做法是**在 Controller 裡做 `Map<String, Object>` 手術**，
那比寫 DTO 醜十倍，而且沒有型別檢查。

### 3.2.2 「那我加 `@JsonIgnore` 就好了」為什麼是錯的方向

這是 3.0 事故 3。它值得單獨拆解，因為**它是最常見的錯誤解法**。

```java
// 🔴 黑名單思維
@Entity
public class Order {
    @JsonIgnore private String internalNote;
    @JsonIgnore private Integer riskScore;
    @JsonIgnore private BigDecimal costPrice;
    @JsonIgnore private Customer customer;
    @JsonIgnore private List<AuditLog> auditLogs;
    // ... 然後下一個人加的第 24 個欄位沒有標
}
```

```java
// ✅ 白名單思維
public record OrderDetail(
    String orderId, String orderNumber, OrderStatus status, String statusLabel,
    List<OrderItemDto> items, Amounts amounts, String currency,
    ShippingAddressDto shippingAddress, String couponCode,
    Instant createdAt, Instant shippedAt, Instant cancelledAt
) {}
// ★★ Order 加第 24 個欄位時，這裡什麼都不會發生 —— 那正是我們要的
```

**兩者的差別可以精確地說出來**：

| | 黑名單（`@JsonIgnore`） | 白名單（DTO） |
|---|---|---|
| 加一個敏感欄位，忘記處理 | 🔴 **洩漏** | ✅ 什麼都不發生 |
| 加一個該公開的欄位，忘記處理 | ✅ 自動出現 | ⚠️ **功能沒做出來**（要改 DTO + mapper） |
| 失敗的方向 | **不安全** | **不完整** |

> 📌 **這是「安全預設值」的教科書案例**：
> 兩種設計都會被忘記，差別只在「忘記的後果」。
> 一個是「個資外洩」，一個是「前端說欄位怎麼沒有」。
> **後者會在 5 分鐘內被發現，前者會在 3 個月後被發現。**

⚠️ **`@JsonIgnore` 有一個它確實適合的位置** —— 在 **DTO** 上，不是在 Entity 上：

```java
public record OrderDetail(
    String orderId,
    /** ★ 內部用來排序，不對外。⚠️ 這種情況很少，多數時候該拆成兩個 DTO */
    @JsonIgnore int sortWeight
) {}
```

但即使這樣，**多數時候更好的做法還是「不要把它放進 DTO」**。
如果一個欄位需要 `@JsonIgnore`，先問「它為什麼在這個 DTO 裡」。

### 3.2.3 反方向的完整重現：mass assignment

代價 5 值得一個可執行的測試，因為**這是一個你應該在自己的專案跑一次的實驗**。

```java
package example.shop.order.web;

/**
 * ★★ 這個測試證明「用 DTO 接請求」擋掉了 mass assignment。
 *
 * <p>⚠️ 它是一個「特性測試」（04-controller 7.12.3）——
 * 它斷言的不是我們的商業邏輯，而是<b>框架 + 設定的組合行為</b>。
 * 所以它的價值在於「有人把 fail-on-unknown-properties 改成 false 時會紅燈」。
 */
@WebMvcTest(OrderController.class)
@Import(WebSliceInfraConfig.class)
class MassAssignmentProtectionTest {

    @Autowired MockMvc mvc;
    @MockBean OrderService orderService;        // ⚠️ Boot 3.4 起改名 @MockitoBean（07 章 7.3.6）

    @Test
    void 送出status欄位時回400而不是靜默忽略() throws Exception {
        // ★ 這個 JSON 在「用 Entity 接」的系統上會成功建立一張已付款訂單
        String malicious = """
                {
                  "items": [{"productId": "P-1", "quantity": 1}],
                  "shippingAddressId": "addr_1",
                  "status": "PAID",
                  "totalAmount": "0.01"
                }
                """;

        mvc.perform(post("/api/orders")
                        .contentType(APPLICATION_JSON)
                        .header("Idempotency-Key", "k-1")
                        .content(malicious))
           .andExpect(status().isBadRequest())
           // ★ 04-controller 3.6.2 的 problem+json 形狀
           .andExpect(jsonPath("$.type").value(endsWith("/malformed-request")))
           // ★★ 錯誤訊息要說出「是哪個欄位」，否則前端不知道怎麼修
           .andExpect(jsonPath("$.detail").value(containsString("status")));

        // ★★ 最重要的一條斷言：Service 完全沒有被呼叫
        verifyNoInteractions(orderService);
    }

    @Test
    void 送出unitPrice時同樣被拒() throws Exception {
        // ⚠️ 這是更狡猾的版本：unitPrice 在【巢狀】的 items 裡
        //    「未知欄位」的檢查對巢狀物件同樣生效嗎？→ 這個測試就是在問這件事
        String malicious = """
                {
                  "items": [{"productId": "P-1", "quantity": 1, "unitPrice": "0.01"}],
                  "shippingAddressId": "addr_1"
                }
                """;

        mvc.perform(post("/api/orders").contentType(APPLICATION_JSON)
                        .header("Idempotency-Key", "k-1").content(malicious))
           .andExpect(status().isBadRequest());
    }
}
```

⚠️ **第二個測試比第一個重要**，因為「巢狀 DTO 有沒有繼承同一個設定」
是一個大部分人沒驗證過的假設。
（答案是**有** —— `fail-on-unknown-properties` 是 `ObjectMapper` 層級的設定，
對整棵樹生效。但**驗證過的假設**與**以為的假設**價值不同。）

### 3.2.4 什麼時候「回傳 Domain 物件」是可以接受的

⚠️ 到這裡都在講代價。但**一律禁止**也不對 ——
那會讓你在只有 3 個欄位的內部端點上寫 4 個檔案。

**三種可以接受的情況**：

| 情況 | 為什麼可以 | 邊界條件 |
|---|---|---|
| **① Service 回 Domain，Web 層自己轉 DTO** | Domain 物件**沒有離開 process** —— 它只在 Controller 方法內存在 | ✅ 這正是 00 章的選擇（3.3 會重新檢視） |
| **② 值物件直接進 DTO** | `Money`、`OrderNumber` 這種**沒有身分、沒有關聯、沒有敏感欄位**的東西 | ⚠️ 要有 serializer（04-controller 6.5.7），否則 `Money` 會序列化成 `{"amount":..,"currency":{...}}` |
| **③ 模組內部的方法呼叫** | 同一個聚合內、同一個 bounded context 內 | ⚠️ 不是「內部 API」的藉口 —— HTTP 邊界一律要 DTO |

**而以下三種常見的「例外」是假的**：

| 假例外 | 為什麼假 |
|---|---|
| 「這是內部管理後台，沒有外部客戶」 | 🔴 事故 1 的洩漏對象是**客服對客戶的評語**，而它就在管理後台的 API 上 |
| 「這個 Entity 沒有敏感欄位」 | ⚠️ **現在**沒有。代價 1 講的就是「以後會有」 |
| 「加 DTO 只是多寫程式碼，沒有價值」 | 這一節的六個代價就是價值。⚠️ 但如果你的專案真的只有 3 個端點且不會長大，這個判斷可能是對的 —— 那就明確寫下來（3.10.1 的表） |

> 📌 **一個實用的線**：
> **只要一個型別會被 Jackson 序列化或反序列化，它就必須是「為此而存在」的型別。**
> 不是「順便可以」的型別。

---

## 3.3 三種轉換策略 ★★

3.2 回答了「要不要 DTO」。**這一節回答一個更難的問題：轉換的程式碼放哪一層。**

它難，是因為三個選項都有真實的支持者，而且**三個都對** ——
對的前提是「在哪一種端點上」。

### 3.3.1 三個策略

**策略 A：Service 回 Domain，Web 層轉 DTO**

```java
// Application Service
@Transactional
public Order create(CreateOrderCommand cmd) {
    // ...
    return order;                                    // ★ 回聚合
}

// Controller
@PostMapping
public ResponseEntity<CreateOrderResponse> create(...) {
    Order order = orderService.create(cmd);
    return created(...).body(mapper.toCreateResponse(order, actor, now, locale));
}
```

| | |
|---|---|
| **誰知道 HTTP** | 只有 Web 層 ✅ |
| **誰知道 Domain** | Web 層也知道 ⚠️ |
| **Domain 物件的生命週期** | 離開了交易（3.9 的問題來源）🔴 |

**策略 B：Service 回 DTO（application-level view）**

```java
// Application Service
@Transactional
public OrderResultView create(CreateOrderCommand cmd) {
    // ...
    return OrderResultView.from(order, cmd.actor(), now);   // ★ 在交易內轉完
}

// Controller
@PostMapping
public ResponseEntity<CreateOrderResponse> create(...) {
    var view = orderService.create(cmd);
    return created(...).body(mapper.toCreateResponse(view, locale));  // ★ 只剩「格式」的事
}
```

| | |
|---|---|
| **誰知道 HTTP** | 只有 Web 層 ✅ |
| **誰知道 Domain** | 只有 Service 層 ✅ |
| **Domain 物件的生命週期** | 不離開交易 ✅ |
| **代價** | ⚠️ 多一個型別（`OrderResultView`），而它與 `CreateOrderResponse` 有 80% 重疊 |

**策略 C：讀取模型直接查投影**

```java
// Query Service（01 章 1.9.2）
@Transactional(readOnly = true)
public PageResponse<OrderSummaryView> search(OrderQuery query, Actor actor, Locale locale) {
    var page = orders.search(query, actor);          // ★ SQL 直接查出需要的欄位
    return new PageResponse<>(page.getContent().stream().map(p -> toView(p, locale)).toList(),
                              PageInfo.offset(...));
}
```

| | |
|---|---|
| **有沒有經過 Domain** | ❌ **完全沒有** —— SQL → Projection → View |
| **效能** | ✅ 最好（1.2.3 的「61 次查詢 vs 1 次查詢」） |
| **能不能用在寫入路徑** | 🔴 **不能** —— 它繞過了所有不變量 |

### 3.3.2 對照表

| 面向 | A：回 Domain | B：回 DTO | C：投影 |
|---|---|---|---|
| Web 層需不需要認識 Domain | 🔴 需要 | ✅ 不需要 | ✅ 不需要 |
| **`LazyInitializationException` 風險** | 🔴 有（3.9） | ✅ 無 | ✅ 無 |
| Domain 的重構會不會影響 Web 層 | 🔴 會 | ✅ 不會 | ✅ 不會 |
| 型別數量（每個端點） | 2（Domain + Response） | 3（Domain + View + Response） | 3（Projection + View + Response） |
| **能不能守不變量** | ✅ 能 | ✅ 能 | 🔴 不能（只讀） |
| 效能（列表查詢） | 🔴 差（載完整聚合） | 🔴 差（同上） | ✅ 好 |
| 效能（單筆寫入後回傳） | ✅ 好 | ✅ 好 | ⚠️ 要再查一次 |
| **測試 mapper 的難度** | ⚠️ 要建整個聚合 | ⚠️ 要建整個聚合 | ✅ 建一個 record 就好 |
| 適合 | 單體、Domain 穩定 | 命令路徑 | **查詢路徑** |

⚠️ **注意「型別數量」那一列被很多人當成決定性的理由，而它不是。**

「策略 B 要多一個型別」聽起來很貴，但實際上：

```
策略 A：Order（domain）  →  CreateOrderResponse（web.dto）
                            ↑ 這個 mapper 需要 actor、now、locale

策略 B：Order（domain）  →  OrderResultView（application）  →  CreateOrderResponse
                            ↑ 需要 actor、now              ↑ 需要 locale
```

**多的那個型別買到了一件事：把「需要 actor 與 now」和「需要 locale」分開。**
而下一節會說明為什麼那件事很重要。

### 3.3.3 重新檢視 00 章 0.14.1 的決定 ★★

02 章 2.18 承諾了這一節。**現在來兌現它。**

00 章 0.14.1 把 `OrderWebMapper` 的簽章從

```java
public CreateOrderResponse toCreateResponse(Order order)
```

改成

```java
public CreateOrderResponse toCreateResponse(Order order, Actor actor, Instant now, Locale locale)
```

**當時的理由是對的**（`allowedActions` 需要 `actor` 與 `now`，`statusLabel` 需要 `locale`）。
**但那個修正揭露了一件當時沒有講的事。**

**先問一個問題：這三個參數，性質一樣嗎？**

| 參數 | 它代表什麼 | 它屬於哪一層的知識 |
|---|---|---|
| `locale` | 「用哪種語言顯示」 | ✅ **展示層**（來自 `Accept-Language`） |
| `now` | 「現在幾點」 | ⚠️ **業務層**（00 章 判準 4：時間是業務輸入） |
| `actor` | 「誰在看」 | 🔴🔴 **業務層** —— 而且它是**授權判斷** |

**`actor` 那一列是問題所在。**

```java
// OrderWebMapper 裡實際發生的事
public CreateOrderResponse toCreateResponse(Order order, Actor actor, Instant now, Locale locale) {
    return new CreateOrderResponse(
            // ...
            order.allowedActions(actor, now).stream().map(Enum::name).toList(),
            // ★★ 這一行在做「授權判斷」——「這個人可以做哪些操作」
            // ...
    );
}
```

⚠️ **`allowedActions` 不是格式轉換，它是一個業務問題。**
而它現在被一個叫 `OrderWebMapper` 的類別呼叫 ——
一個放在 `order.web` 套件裡、名字裡有 `Web` 的類別。

**這造成三個具體的後果**：

| # | 後果 | 症狀 |
|---|---|---|
| 1 | **同一個業務判斷有兩個呼叫點** | `OrderWebMapper`（給前端顯示按鈕）與 `OrderApplicationService.cancel()`（實際檢查）。00 章 0.9.2 已經用「共用 `canBeCancelledBy`」處理了**這一個**，但下一個新增的操作呢？ |
| 2 | **Web 層的測試需要建 `Actor`** | 04-controller 7.7 的 Object Mother 現在要能造出「客戶」「客服」「系統」三種 actor，只為了測 mapper |
| 3 | 🔴 **`allowedActions` 沒有辦法在 Service 層被測試** | 因為它只在 Web 層被呼叫。而它是授權邏輯 |

**而第 4 個後果最嚴重，也最隱晦**：

```java
// 04-controller 5.2.3 的批次匯出（跑在另一個執行緒上）
@GetMapping("/orders/export")
public StreamingResponseBody export(...) {
    return out -> {
        orderQueryService.streamAll(query, actor, order -> {
            // 🔴 這裡沒有 OrderWebMapper —— 因為它需要 locale，
            //    而這個執行緒上沒有 LocaleContext（00 章 0.14.5）
            //    → 於是有人在這裡「自己組一份 JSON」
        });
    };
}
```

⚠️ **「mapper 需要三個上下文」的直接結果是「在拿不到上下文的地方，有人會另寫一份」。**
而另寫的那一份**不會有 `allowedActions`，也不會遮蔽敏感欄位**。

> 📌 **這是一個一般性的現象，值得記住**：
> **一個需要很多上下文的元件，會在上下文不足的地方被繞過。**
> 而繞過它的那份程式碼，就是下一個事故。

**shop-service 的最終決定**：

```
命令路徑（POST / PATCH / DELETE）  → 策略 B：Service 回 View
查詢路徑（GET 列表 / GET 單筆）    → 策略 C：Query Service 回 View（投影）
```

**也就是：策略 A 完全不用。** `Order` 這個聚合**不離開 Service 層**。

**新的分工**：

```java
package example.shop.order.application;

/**
 * ★★ 命令執行完之後的結果檢視。
 *
 * <p>它是「策略 B」的產物。三個刻意的設計：
 * <ol>
 *   <li><b>它在交易內組出來</b> —— 所以沒有延遲載入的問題（3.9）。</li>
 *   <li><b>它已經做完所有業務判斷</b>（{@code allowedActions}）——
 *       Web 層拿到的是<b>結論</b>，不是「一個聚合 + 一個 actor」。</li>
 *   <li><b>它<u>不</u>做展示層的事</b> —— 沒有 {@code statusLabel}（那需要 {@code Locale}），
 *       沒有金額字串化（那是 04-controller 6.5.7 的 serializer 的事）。</li>
 * </ol>
 *
 * <p>⚠️ 第 3 點是這個型別與 {@code CreateOrderResponse} 的關鍵差別 ——
 * 否則它們會是同一個東西，那就不值得多一個型別。
 */
public record OrderResultView(
        String orderId,
        String orderNumber,
        OrderStatus status,
        Money total,                        // ★ 還是 Money —— 不是 String
        Currency currency,
        int totalItemQuantity,
        List<OrderAction> allowedActions,   // ★★ 業務判斷的【結論】
        AppliedCouponView appliedCoupon,    // 可為 null
        Instant createdAt,
        Instant paymentDueAt
) {

    /**
     * ★ 從聚合建立。⚠️ 它是 {@code static}，但<b>不是</b>純函式 ——
     * 它需要 {@code actor} 與 {@code now}，而那兩者是業務輸入。
     *
     * <p>👉 放在這裡（而不是一個 {@code OrderViewMapper} bean）的理由：
     * 它<b>只依賴參數</b>，不需要注入任何東西。
     * 03 章 3.4.6 的判準：<b>不需要依賴的轉換寫成 static 工廠，需要依賴的才做成 bean。</b>
     */
    public static OrderResultView from(Order order, Actor actor, Instant now) {
        return new OrderResultView(
                order.id(),
                order.orderNumber().value(),
                order.status(),
                order.total(),
                order.currency(),
                order.totalItemQuantity(),
                order.allowedActions(actor, now),
                AppliedCouponView.from(order.appliedCoupon()),
                order.createdAt(),
                order.expiresAt());
    }

    public record AppliedCouponView(String code, String name, Money discount) {
        /** ⚠️ 收 null 回 null —— 3.5.2 會討論這個決定 */
        static AppliedCouponView from(AppliedCoupon c) {
            return c == null ? null
                             : new AppliedCouponView(c.code(), c.name(), c.discount());
        }
    }
}
```

**Application Service 的簽章跟著改**：

```java
/**
 * ⚠️ 回傳型別從 {@code Order} 改成 {@code OrderResultView}（03 章 3.3.3）。
 *
 * <p>★ 這是 01 章 1.8.2「回傳型別的四個選項」那一節裡
 * 「回傳一個專用的結果型別」那個選項 —— 而 01 章當時選的是「回聚合」。
 * <b>03 章推翻它，理由見 3.3.3。</b>
 */
@Transactional
public OrderResultView create(CreateOrderCommand cmd) {
    Instant now = clock.instant();
    // ... 00 章 0.9.4 的 15 個步驟
    orders.save(order);
    // ★★ 在交易內、在 return 之前轉換完成
    return OrderResultView.from(order, cmd.actor(), now);
}
```

**而 `OrderWebMapper` 變乾淨了**：

```java
/**
 * ⚠️ 對照 00 章 0.14.1 的四參數版本 —— {@code actor} 與 {@code now} 都不見了。
 *
 * <p>它現在只做兩件事：<b>換名字</b>與<b>換格式</b>。
 * 沒有任何一行是業務判斷。
 */
public CreateOrderResponse toCreateResponse(OrderResultView view, Locale locale) {
    return new CreateOrderResponse(
            view.orderId(),
            view.orderNumber(),
            view.status(),
            statusLabels.label(view.status(), locale),        // ★ 展示層的事
            view.total().toPlainString(),                     // ★ 04-controller 6.5.7
            view.currency().getCurrencyCode(),
            view.paymentDueAt(),
            CreateOrderResponse.NextAction.pay(view.orderId()),
            view.createdAt());
}
```

**改完之後，我們可以精確地說出每一層在做什麼**：

| 層 | 輸入 | 輸出 | 它做的事 | 它需要的上下文 |
|---|---|---|---|---|
| Domain | 參數 | 狀態改變 | 守不變量 | `now` |
| Application | Command | `OrderResultView` | 編排、交易、**授權判斷** | `Actor`、`Clock` |
| **Web mapper** | `OrderResultView` | `CreateOrderResponse` | **換名字、換格式** | `Locale` |
| Jackson | DTO | JSON | 序列化 | `ObjectMapper` 設定 |

⚠️ **`OrderWebMapper` 現在可以用一個「一行測試」驗證它沒有業務邏輯**：

```java
/**
 * ★★ ArchUnit：Web 層的 mapper 不可以呼叫 Domain 的方法。
 *
 * <p>它守的是 3.3.3 的整個結論 —— 而不是靠「大家記得」。
 */
@ArchTest
static final ArchRule web層的mapper不可依賴domain =
        noClasses().that().haveSimpleNameEndingWith("WebMapper")
                   .should().dependOnClassesThat().resideInAPackage("..order.domain..")
                   .because("mapper 只做格式轉換；業務判斷（allowedActions）屬於 Application 層（3.3.3）");
```

⚠️⚠️ **但這條規則現在會紅燈**，而那是刻意的 ——
因為 `CreateOrderResponse` 的第三個欄位是 `OrderStatus`，而它在 `order.domain`。

**這逼出一個真正的決定：`OrderStatus` 這個 enum 該不該出現在 Web DTO 裡？**

| 選項 | 代價 |
|---|---|
| ① DTO 用 `OrderStatus`（現況） | ⚠️ Web 層依賴 domain 的一個 enum。但 enum 是**不可變的值**，不是聚合 |
| ② DTO 用 `String` | 🔴 失去型別安全；04-controller 6.5.8 的 `LabeledEnum` 掃描測試失效 |
| ③ Web 層自己一份 `OrderStatusDto` enum | 🔴 兩份 enum 會分岔（domain 加一個狀態，Web 忘了加 → `IllegalArgumentException`） |

**shop-service 選 ①，並把例外明確寫進 ArchUnit**：

```java
// ★★ 這是這條規則的【最終版本】—— 取代上面那一個
@ArchTest
static final ArchRule web層的mapper不可依賴domain =
        noClasses().that().haveSimpleNameEndingWith("WebMapper")
                   .should().dependOnClassesThat().resideInAPackage("..order.domain..")
                   // ★★ 例外：值物件與 enum 可以跨層（它們是「值」不是「行為」）
                   .ignoreDependency(alwaysTrue(),
                           JavaClass.Predicates.assignableTo(Enum.class))
                   .because("""
                            mapper 只做格式轉換；業務判斷（allowedActions）屬於 Application 層（3.3.3）。
                            例外：enum 是不可變的值，跨層傳遞不會帶來耦合 —— \
                            而「Web 層自己一份 enum」會分岔（選項 ③）。""");
```

⚠️ **這個 `ignoreDependency` 是一個真正的例外，不是「把警報關掉」** ——
差別在於：**它排除的是一個「可以精確描述」的類別**（enum），
而不是「一個特定的類別名」。

00 章 0.11.2 有一個相反的例子（`alwaysFalse(), alwaysFalse()` 什麼都不忽略），
而 01 章也討論過同一件事。判準是：

> 📌 **`ignoreDependency` 的判準**：
> 你能不能用一句「所有 X 都可以」來描述例外？
> 能 → 它是規則的一部分（例外要寫進 `because`）。
> 不能（只能列類別名）→ 它是**債**，要有 issue 編號。

### 3.3.4 shop-service 的 12 個端點各用哪個策略

| 端點 | 策略 | Service 回傳 | 理由 |
|---|---|---|---|
| `POST /orders` | **B** | `OrderResultView` | 命令；需要 `allowedActions` |
| `GET /orders` | **C** | `PageResponse<OrderSummaryView>` | 列表；不可載完整聚合 |
| `GET /orders/{id}` | **C** | `OrderDetailView` | 查詢；`JOIN` 一次查完 |
| `GET /orders/{id}` （客服） | **C** | `OrderDetailForSupportView` | 同上，但欄位不同（3.7） |
| `PATCH /orders/{id}` | **B** | `OrderResultView` | 命令（3.6） |
| `POST /orders/{id}/cancel` | **B** | `CancellationResultView` | 命令；回傳「退了多少錢」 |
| `POST /orders/{id}/payments` | **B** | `PaymentResultView` | 命令；回傳付款結果（含「已處理過」） |
| `POST /orders/{id}/shipments` | **B** | `ShipmentResultView` | 命令 |
| `GET /orders/{id}/shipments` | **C** | `List<ShipmentView>` | 查詢 |
| `GET /orders/export` | **C** | `Stream<OrderExportRow>` | ★ 串流；3.5.5 |
| `GET /orders/{id}/invoice.pdf` | — | `byte[]` | 不是 JSON（04-controller 5.4） |
| `DELETE /orders/{id}/coupon` | **B** | `OrderResultView` | 命令 |

⚠️ **注意「命令回什麼」有一個決定要做**：`POST /orders/{id}/cancel` 之後，
前端通常需要**整張訂單的最新狀態**來更新畫面。

| 做法 | 代價 |
|---|---|
| 回 `CancellationResultView`（只有取消的結果） | ⚠️ 前端要再發一次 `GET /orders/{id}` → 多一個往返 |
| 回 `OrderDetailView`（整張訂單） | 🔴 命令路徑要組出「查詢路徑」的形狀 → 兩條路徑的 DTO 綁在一起 |
| **回 `CancellationResultView` + `OrderResultView`** | ✅ shop-service 的選擇（見下） |

```java
/**
 * 取消的結果。
 *
 * <p>★★ 它包含兩部分：
 * <ul>
 *   <li>{@code cancellation} —— 這個「操作」的結果（退款金額、還了多少庫存）。</li>
 *   <li>{@code order} —— 訂單的<b>新狀態</b>，讓前端不用再查一次。</li>
 * </ul>
 *
 * <p>⚠️ 而 {@code order} 刻意是 {@code OrderResultView}（10 個欄位）
 * 而不是 {@code OrderDetailView}（22 個欄位）——
 * 因為前端在「取消成功」之後需要的是「狀態、可執行操作、金額」，
 * 不是完整的地址與明細。
 *
 * <p>👉 如果前端真的需要完整詳情，那是一個 {@code GET} ——
 * <b>不要為了省一個往返而讓命令端點回傳查詢的形狀。</b>
 */
public record CancellationResultView(
        CancellationInfo cancellation,
        OrderResultView order
) {
    public record CancellationInfo(
            boolean refundRequired,
            Money refundAmount,
            List<StockReleaseInfo> releases,
            CancelReason reason,
            Instant cancelledAt) {}

    public record StockReleaseInfo(String productId, int quantity) {}
}
```

### 3.3.5 「Service 回 DTO」不等於「Service 認識 HTTP」

**這是策略 B 最常見的反對意見**，值得正面回答：

> 「讓 Service 回 DTO，Service 就變成為 API 服務的了 ——
> 換一個入口（排程、gRPC、CLI）就不對了。」

⚠️ **這個擔心是對的，但它針對的是另一個東西**。

| 東西 | 它為誰服務 | 例子 |
|---|---|---|
| `CreateOrderResponse`（web.dto） | **HTTP API** | 有 `statusLabel`（i18n）、金額是 `String`、有 `_links` |
| `OrderResultView`（application） | **這個 use case 的呼叫端** | 金額是 `Money`、狀態是 enum、沒有任何 HTTP 概念 |

**`OrderResultView` 沒有一個欄位是「因為 HTTP」而存在的。**
它是「執行完這個 use case 之後，呼叫端會想知道的事」。

**一個可執行的守門測試**：

```java
/**
 * ★★ Application 層不可依賴任何展示層的東西。
 *
 * <p>它守的是「Service 回 DTO」不會滑坡成「Service 回 HTTP 回應」。
 */
@ArchTest
static final ArchRule application層不可認識展示層 =
        noClasses().that().resideInAPackage("..application..")
                   .should().dependOnClassesThat().resideInAnyPackage(
                           "..web..",
                           "org.springframework.http..",
                           "org.springframework.web..",
                           "com.fasterxml.jackson..",
                           "java.util.Locale")      // ★★ 連 Locale 都不行
                   .because("展示層的概念（狀態碼、i18n、序列化）不屬於 use case（3.3.5）");
```

⚠️⚠️ **最後那一行 `java.util.Locale` 是這條規則裡最有價值的一項。**

它會抓到 01 章 1.9.2 的 `OrderQueryService`：

```java
// 01 章 1.9.2（會被這條規則抓到）
public PageResponse<OrderSummaryView> search(OrderQuery query, Actor actor, Locale locale) {
    //                                                               ^^^^^^^^^^^^^ 🔴
}
```

**那是 01 章的一個真實錯誤**，而它一直沒被發現，因為當時沒有這條規則。
3.10.3 ② 會處理它 —— 而處理方式不是「把 `Locale` 拿掉就好」，
因為 `statusLabel` 真的需要它。

> 📌 **先記住這個張力，3.10.3 ② 會解**：
> `statusLabel` 需要 `Locale`；`Locale` 屬於展示層；
> 而如果 label 由 Web 層算，Query Service 就不需要 `Locale` ——
> **但 Web 層算 label 需要知道「哪些欄位要 label」**。
> 這不是一個沒有代價的取捨。

---

## 3.4 手寫 mapper 還是 MapStruct ★★

3.3 決定了「轉換放哪一層」。**這一節決定「怎麼寫」。**

而這一節真正的主題不是「哪個工具好」，是一個更根本的問題：

> **「漏映射一個欄位」這件事，要怎麼讓它變成編譯錯誤？**

因為那是 3.0 事故 2 的根因，而它是這一層最常見的 bug。

### 3.4.1 手寫的完整版

先把手寫的樣子完整寫出來 —— 包含**巢狀**與**集合**，因為
只看單層的例子會低估手寫的成本。

```java
package example.shop.order.web;

import example.shop.common.i18n.StatusLabelResolver;
import example.shop.order.application.view.*;
import example.shop.order.web.dto.*;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Locale;

/**
 * {@code order.application.view} → {@code order.web.dto} 的轉換。
 *
 * <h2>★★ 這個類別的四條規則</h2>
 * <ol>
 *   <li><b>只做兩件事：換名字、換格式。</b>沒有任何業務判斷（3.3.3 的 ArchUnit 規則在守）。</li>
 *   <li><b>一個 DTO 一個方法</b> —— 不做「一個巨型方法處理三層巢狀」（3.5.1）。</li>
 *   <li><b>集合一律回 {@code List.of()} 而不是 {@code null}</b>（3.5.2）。</li>
 *   <li><b>金額一律 {@code toPlainString()}</b>（04-controller 6.5.7）。</li>
 * </ol>
 *
 * <p>⚠️ 它是 {@code @Component} 而不是 static 工具類，唯一的理由是
 * 它需要 {@link StatusLabelResolver}（3.4.6 的判準）。
 */
@Component
public class OrderWebMapper {

    private final StatusLabelResolver statusLabels;

    public OrderWebMapper(StatusLabelResolver statusLabels) {
        this.statusLabels = statusLabels;
    }

    // ══════════════ 請求方向（Web DTO → Command）══════════════

    /** ★ 欄位順序與 04-controller 1.12.5 的 record 宣告一致。 */
    public CreateOrderCommand toCommand(CreateOrderRequest request, Actor actor,
                                        String idempotencyKey) {
        return new CreateOrderCommand(
                actor,
                idempotencyKey,
                request.items().stream().map(OrderWebMapper::toCommandLine).toList(),
                request.shippingAddressId(),          // ★ 只有 ID —— Web 層不查資料庫
                request.couponCode(),
                request.customerNote(),
                toInvoiceSpec(request.invoice()));
    }

    /** ★ 只有 productId 與 quantity —— 刻意沒有價格（00 章 0.6.2）。 */
    private static CreateOrderCommand.Line toCommandLine(CreateOrderRequest.Item item) {
        return new CreateOrderCommand.Line(item.productId(), item.quantity());
    }

    /** ⚠️ 收 null 回 null（發票是選填）。3.5.2 說明為什麼「請求方向」與「回應方向」的 null 政策不同。 */
    private static InvoiceSpec toInvoiceSpec(CreateOrderRequest.InvoiceRequest req) {
        if (req == null) return null;
        return new InvoiceSpec(
                InvoiceType.valueOf(req.type()),
                req.taxId() == null ? null : new TaxId(req.taxId()),
                req.title(),
                req.carrierId());
    }

    // ══════════════ 回應方向（View → Web DTO）══════════════

    public CreateOrderResponse toCreateResponse(OrderResultView view, Locale locale) {
        return new CreateOrderResponse(
                view.orderId(),
                view.orderNumber(),
                view.status(),
                statusLabels.label(view.status(), locale),
                view.total().toPlainString(),
                view.currency().getCurrencyCode(),
                view.paymentDueAt(),
                CreateOrderResponse.NextAction.pay(view.orderId()),
                view.createdAt());
    }

    public OrderDetail toDetail(OrderDetailView view, Locale locale) {
        return new OrderDetail(
                view.orderId(),
                view.orderNumber(),
                view.status(),
                statusLabels.label(view.status(), locale),
                toItems(view.items()),                      // ★ 巢狀集合
                toAmounts(view.amounts()),                  // ★ 巢狀物件
                view.currency().getCurrencyCode(),
                toAddress(view.shippingAddress()),
                view.couponCode(),
                view.createdAt(),
                view.shippedAt(),
                view.cancelledAt());
    }

    /** ⚠️ 集合的 null 政策：回應方向一律非 null（3.5.2）。 */
    private List<OrderItemDto> toItems(List<OrderDetailView.Item> items) {
        if (items == null) return List.of();
        return items.stream().map(OrderWebMapper::toItem).toList();
    }

    private static OrderItemDto toItem(OrderDetailView.Item item) {
        return new OrderItemDto(
                item.productId(),
                item.productName(),
                item.quantity(),
                item.unitPrice().toPlainString(),           // ★ Money → String
                item.lineTotal().toPlainString());
    }

    private static Amounts toAmounts(OrderDetailView.Amounts a) {
        return new Amounts(
                a.subtotal().toPlainString(),
                a.discount().toPlainString(),
                a.shippingFee().toPlainString(),
                a.total().toPlainString());
    }

    private static ShippingAddressDto toAddress(OrderDetailView.Address a) {
        if (a == null) return null;
        return new ShippingAddressDto(
                a.recipientName(), a.phone(), a.zipCode(),
                a.city(), a.district(), a.street());
    }
}
```

**這個類別的規模**：8 個方法、約 90 行、映射 **38 個欄位**。

⚠️ **而它只處理了 12 個端點裡的 3 個。**
完整的 `OrderWebMapper` 大約 **260 行、映射 110 個欄位**。

### 3.4.2 「漏映射一個欄位」的三種形狀 ★

3.0 事故 2 是「填了 `null`」。**它有三種形狀，而三種都是靜默的。**

**形狀 1：填 `null`（record 的參數）**

```java
return new OrderDetail(
        view.orderId(),
        view.orderNumber(),
        view.status(),
        statusLabels.label(view.status(), locale),
        toItems(view.items()),
        toAmounts(view.amounts()),
        null,                                   // 🔴 currency 忘了
        toAddress(view.shippingAddress()),
        // ...
);
```

編譯器的意見：**沒有意見。** `null` 是合法的 `String`。

**形狀 2：位置對調（同型別的相鄰欄位）** 🔴🔴

```java
public record ShippingAddressDto(
    String recipientName, String phone, String zipCode,
    String city, String district, String street) {}
```

```java
return new ShippingAddressDto(
        a.recipientName(), a.phone(), a.zipCode(),
        a.district(), a.city(),                 // 🔴🔴 city 與 district 對調
        a.street());
```

編譯器的意見：**沒有意見。** 六個參數全部是 `String`。

⚠️ **這是三種裡最危險的一種**，因為：

| | |
|---|---|
| 它不是 `null`，所有「非 null」的檢查都通過 | ✅ 綠燈 |
| 3.8.2 的「每個欄位都不是預設值」掃描測試也通過 | ✅ 綠燈 |
| 資料看起來「像是對的」 | 「台北市 / 中山區」變成「中山區 / 台北市」—— **要人眼看** |
| 症狀 | 物流的地址驗證 API 拒收，而錯誤訊息是「查無此地址」 |

> 📌 **這解釋了為什麼「一堆同型別的 `String` 參數」是一個設計問題**，
> 而不只是「不好看」。00 章 0.5.3 的值物件（`TaxId`、`OrderNumber`）
> 就是在減少這件事發生的機會 ——
> 如果 `city` 是 `City` 而 `district` 是 `District`，這個 bug 是編譯錯誤。
>
> ⚠️ 但**不要**為了這個把所有 `String` 都包成值物件 ——
> 那會產生 40 個一行的 record。判準還是 00 章 0.5.3 的三點。

**形狀 3：新增欄位後，舊的 mapper 沒改（setter 式的 DTO）**

如果 DTO 是 record，新增欄位會讓所有 `new OrderDetail(...)` 編譯失敗 ——
**那是 record 的一個真正的優點。**

但如果 DTO 是 class + setter（很多老專案是）：

```java
// 🔴 class + setter：新增欄位是靜默的
OrderDetail dto = new OrderDetail();
dto.setOrderId(view.orderId());
dto.setStatus(view.status());
// ... 新增的 currency 沒有人 set → 它是 null
return dto;
```

| DTO 的形式 | 新增欄位時 |
|---|---|
| **record**（或 all-args constructor） | ✅ **編譯錯誤** —— 所有呼叫點都要改 |
| class + setter | 🔴 靜默（欄位是 `null` / `0` / `false`） |
| Lombok `@Builder` | 🔴 靜默（builder 允許不設） |

> 📌 **這是「用 record 當 DTO」被低估的一個理由**：
> 它讓「新增欄位」從**靜默**變成**編譯錯誤**。
> ⚠️ 而 Lombok 的 `@Builder` **抵銷了這個好處** ——
> 如果你的 DTO 是 record 但用 builder 建，你就同時付了兩邊的代價。

⚠️ **注意 record 只擋住形狀 3，擋不住形狀 1 與 2。**
所以我們需要別的東西。

### 3.4.3 為什麼不用 `BeanUtils.copyProperties` 與 `ModelMapper` ★★

**這一節是這一章最重要的一個反例。**

因為「反射式自動映射」看起來正好解決了 3.4.2 的問題 ——
**而它實際上讓問題變得更糟。**

```java
// 🔴 Spring 的 BeanUtils
OrderDetail dto = new OrderDetail();
BeanUtils.copyProperties(order, dto);      // 「自動」把同名欄位複製過去
```

```java
// 🔴 ModelMapper
private final ModelMapper modelMapper = new ModelMapper();
OrderDetail dto = modelMapper.map(order, OrderDetail.class);
```

**它們的問題不是效能**（雖然效能也差 20～100 倍）。**問題是這五件事**：

| # | 問題 | 具體後果 |
|---|---|---|
| 1 | **改名字不會編譯錯** | 把 `Order.custId` 改成 `Order.customerId` → mapper 不再複製那個欄位 → DTO 的 `custId` 變 `null`。🔴 **零編譯錯誤、零測試失敗** |
| 2 | **漏映射完全不會被發現** | `Order` 沒有 `currency` 欄位（它在 `Money` 裡）→ DTO 的 `currency` 是 `null`。**與事故 2 一模一樣** |
| 3 | **它會做你沒要求的事** | `Order.internalNote` 與 `OrderDetail.internalNote` 同名 → **自動複製過去**。🔴 事故 1 的洩漏在「用了 DTO」之後照樣發生 |
| 4 | **型別不合時的行為不可預測** | `Money` → `String`：`BeanUtils` 靜默跳過；`ModelMapper` 猜（可能呼叫 `toString()` 得到 `Money[amount=100, currency=TWD]`）|
| 5 | **`record` 不支援** | `BeanUtils.copyProperties` 需要 setter → 對 record 完全無效（靜默地什麼都不做）🔴 |

**第 3 點值得展開，因為它很反直覺。**

> **用了 DTO 但用反射映射 = 得到 DTO 的所有樣板成本，但完全沒有得到它的安全性。**

```java
// 有人加了一個欄位到 DTO（因為客服後台要）
public record OrderDetail(..., String internalNote) {}

// 而客戶端點用的是同一個 mapper
modelMapper.map(order, OrderDetail.class);     // 🔴 internalNote 自動被填進去
```

⚠️ **第 5 點是實務上最常撞到的**。Java 16 之後大家開始用 record 當 DTO，
而 `BeanUtils.copyProperties(source, recordInstance)` 的行為是：

```
✅ 編譯通過
✅ 執行不拋例外
🔴 什麼欄位都沒複製（record 沒有 setter）
```

**沒有任何訊號。** 你會得到一個全部欄位都是 `null` 的 DTO。

> 📌 **一個判準，可以用在任何「自動化」工具上**：
> **問「我犯錯的時候，誰會告訴我」。**
>
> | 工具 | 誰告訴你 |
> |---|---|
> | 手寫 mapper | ⚠️ 只有測試（形狀 1、2 測不到） |
> | `BeanUtils` / `ModelMapper` | 🔴 **沒有人** |
> | **MapStruct（`unmappedTargetPolicy = ERROR`）** | ✅ **編譯器** |
>
> 這張表就是下一節的全部理由。

⚠️ **`BeanUtils.copyProperties` 有一個它可以用的地方**：

```java
// ✅ 同一個型別的「複製並改一個欄位」——來源與目標是同一個 class
var copy = new OrderSearchCriteria();
BeanUtils.copyProperties(criteria, copy);
copy.setPage(criteria.getPage() + 1);
```

因為此時「欄位名對不上」不可能發生（是同一個類別）。
⚠️ 但即使這樣，record 的 `with` 風格或一個明確的建構子還是更好。

### 3.4.4 MapStruct：它是編譯期產生程式碼

**MapStruct 與前一節那些工具的差別是根本性的**：
它不在執行期用反射，它在**編譯期產生一個普通的 Java 類別**。

```java
package example.shop.order.web;

import org.mapstruct.*;

/**
 * ★★ 三個設定各自守什麼：
 * <ul>
 *   <li>{@code unmappedTargetPolicy = ERROR} —— <b>這是用 MapStruct 的唯一理由</b>。
 *       目標有欄位沒被映射到 → <b>編譯錯誤</b>（3.4.2 的形狀 1 被擋住）。</li>
 *   <li>{@code unmappedSourcePolicy = WARN} —— 來源有欄位沒被用到 → 警告。
 *       ⚠️ 不設成 ERROR，因為「View 有 22 個欄位、這個 DTO 只要 12 個」是<b>正常的</b>。</li>
 *   <li>{@code nullValueMappingStrategy = RETURN_DEFAULT} —— 集合回 {@code List.of()}
 *       而不是 null（3.5.2）。</li>
 * </ul>
 *
 * <p>⚠️ {@code componentModel = SPRING} 讓它產生 {@code @Component}，
 * 於是可以注入 —— 而它自己也能注入東西（{@code uses}）。
 */
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING,
        unmappedTargetPolicy = ReportingPolicy.ERROR,
        unmappedSourcePolicy = ReportingPolicy.WARN,
        nullValueMappingStrategy = NullValueMappingStrategy.RETURN_DEFAULT,
        uses = { MoneyMapper.class })
public interface OrderDtoMapper {

    /**
     * ⚠️ 注意 {@code statusLabel} 與 {@code currency} 都需要「額外的東西」：
     * <ul>
     *   <li>{@code statusLabel} 需要 {@code Locale} + {@code StatusLabelResolver} → {@code @Context}</li>
     *   <li>{@code currency} 在來源的 {@code Money} 裡，不是頂層欄位 → 明確指定路徑</li>
     * </ul>
     */
    @Mapping(target = "statusLabel", expression = "java(labels.label(view.status(), locale))")
    @Mapping(target = "currency", source = "view.currency.currencyCode")
    OrderDetail toDetail(OrderDetailView view,
                         @Context Locale locale,
                         @Context StatusLabelResolver labels);

    /** ★ 巢狀的元素轉換：MapStruct 會自己找到這個方法並用在集合上。 */
    OrderItemDto toItem(OrderDetailView.Item item);

    Amounts toAmounts(OrderDetailView.Amounts amounts);

    ShippingAddressDto toAddress(OrderDetailView.Address address);
}
```

```java
package example.shop.order.web;

import example.shop.common.money.Money;
import org.mapstruct.Mapper;

/**
 * ★★ 值物件的轉換規則放在一個獨立的 mapper，讓所有 DTO mapper 共用（{@code uses}）。
 *
 * <p>它只有一個方法，但它是「金額一律字串化」（04-controller 6.5.7）
 * 這條規則<b>唯一</b>的實作點 ——
 * 於是 3.8.4 的掃描測試只需要檢查「DTO 的金額欄位是 String」，
 * 不需要檢查「每一個 mapper 都記得呼叫 toPlainString()」。
 */
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING)
public interface MoneyMapper {

    /** ⚠️ null 進 null 出 —— MapStruct 產生的程式碼會自己加 null 檢查。 */
    default String toPlainString(Money money) {
        return money == null ? null : money.toPlainString();
    }
}
```

**產生出來的程式碼長這樣**（`target/generated-sources/annotations/`）：

```java
@Component
public class OrderDtoMapperImpl implements OrderDtoMapper {

    @Autowired private MoneyMapper moneyMapper;

    @Override
    public OrderDetail toDetail(OrderDetailView view, Locale locale, StatusLabelResolver labels) {
        if (view == null) {
            return null;
        }
        String orderId = view.orderId();
        String orderNumber = view.orderNumber();
        OrderStatus status = view.status();
        List<OrderItemDto> items = itemListToOrderItemDtoList(view.items());
        Amounts amounts = toAmounts(view.amounts());
        String currency = viewCurrencyCurrencyCode(view);
        // ... 每一個欄位一行，沒有反射
        String statusLabel = labels.label(view.status(), locale);

        return new OrderDetail(orderId, orderNumber, status, statusLabel, items,
                               amounts, currency, shippingAddress, couponCode,
                               createdAt, shippedAt, cancelledAt);
    }
    // ... 以及一個 null-safe 的 currency 取值方法
}
```

⚠️ **注意產生的程式碼是「一個普通的類別」** ——
可以 debug、可以下中斷點、堆疊追蹤裡看得到它、效能與手寫相同。

**Maven 設定**（含一個大部分人會撞到的陷阱）：

```xml
<properties>
  <mapstruct.version>1.5.5.Final</mapstruct.version>
  <lombok.version>1.18.30</lombok.version>
</properties>

<dependencies>
  <dependency>
    <groupId>org.mapstruct</groupId>
    <artifactId>mapstruct</artifactId>
    <version>${mapstruct.version}</version>
  </dependency>
</dependencies>

<build>
  <plugins>
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-compiler-plugin</artifactId>
      <configuration>
        <annotationProcessorPaths>
          <!-- ⚠️⚠️ 順序有意義：Lombok 必須在 MapStruct 之前 -->
          <path>
            <groupId>org.projectlombok</groupId>
            <artifactId>lombok</artifactId>
            <version>${lombok.version}</version>
          </path>
          <!-- ★ lombok-mapstruct-binding：讓 MapStruct 看得到 Lombok 產生的 getter -->
          <path>
            <groupId>org.projectlombok</groupId>
            <artifactId>lombok-mapstruct-binding</artifactId>
            <version>0.2.0</version>
          </path>
          <path>
            <groupId>org.mapstruct</groupId>
            <artifactId>mapstruct-processor</artifactId>
            <version>${mapstruct.version}</version>
          </path>
        </annotationProcessorPaths>
        <compilerArgs>
          <!-- ★★ 把未映射的欄位變成錯誤（也可以在 @Mapper 上設，這裡是全域預設）-->
          <arg>-Amapstruct.unmappedTargetPolicy=ERROR</arg>
          <!-- ★ 讓產生的程式碼有 @Generated（3.8.7 的掃描測試要排除它）-->
          <arg>-Amapstruct.suppressGeneratorTimestamp=true</arg>
        </compilerArgs>
      </configuration>
    </plugin>
  </plugins>
</build>
```

⚠️ **`suppressGeneratorTimestamp=true` 那一行不是美觀問題**：
沒有它，產生的檔案裡有 `date = "2026-08-27T14:32:11+0800"`，
於是**每次編譯的產出都不同** → Docker layer cache 與 Gradle/Maven 的
增量編譯判斷都失效。

⚠️ **`lombok-mapstruct-binding` 那個 path 是最常見的坑**。
沒有它，而你的來源型別用 `@Data`：

```
error: Unmapped target properties: "orderId, orderNumber, status, ...".
```

**MapStruct 看不到 Lombok 產生的 getter**，於是報「全部欄位都沒映射」。
而錯誤訊息完全不會提到 Lombok。

> 📌 **shop-service 的 DTO 與 View 全部是 record**，所以這個坑不存在。
> 但你的專案很可能有 Lombok，所以先把這個 path 加上 ——
> 它在沒有 Lombok 時是無害的。

### 3.4.5 MapStruct 做不到 / 會出錯的五件事

**這一節是為了讓你不要「全站改用 MapStruct」。**

| # | 做不到什麼 | 症狀 / 處置 |
|---|---|---|
| 1 | **條件邏輯** | `allowedActions`、「已取消才有 `cancelledAt`」→ 只能寫 `default` 方法或 `expression = "java(...)"`，而 `expression` 裡的字串**沒有型別檢查** |
| 2 | **需要多個來源做組合判斷** | `OrderDetail.canBeCancelled` 要看 status + createdAt + actor → 這是業務判斷，本來就不該在 mapper（3.3.3）✅ |
| 3 | **`@Context` 的參數不參與映射** | ⚠️ `@Context Locale locale` **不會**被算進「來源欄位」→ 如果你打錯 `expression` 裡的變數名，是**執行期**才錯 |
| 4 | **record 的巢狀 record + 泛型集合** | ⚠️ 多數情況可以，但 `List<Map<String, List<Money>>>` 這種會產生看不懂的錯誤 |
| 5 | **錯誤訊息在 `target/generated-sources`** | 🔴 IDE 沒有跑 annotation processor 時，你會看到「找不到 `OrderDtoMapperImpl`」而不是真正的錯誤 |

**第 1 點與第 3 點值得展開，因為它們互相加乘。**

```java
// 🔴 expression 裡的字串沒有型別檢查
@Mapping(target = "statusLabel", expression = "java(labels.label(view.status(), locale))")
//                                                    ^^^^^^ 如果 @Context 的參數名叫 loc，
//                                                           這裡寫 locale 會編譯錯 ——
//                                                           但錯誤是「找不到符號 locale」，
//                                                           指向 generated-sources 裡的一行
```

編譯錯誤看起來像：

```
/Users/you/proj/target/generated-sources/annotations/example/shop/order/web/OrderDtoMapperImpl.java:47:
  error: cannot find symbol
        String statusLabel = labels.label( view.status(), locale );
                                                          ^
  symbol:   variable locale
  location: class OrderDtoMapperImpl
```

⚠️ **這個訊息指向一個「你沒有寫的檔案」**。
第一次遇到的人會花 20 分鐘找那個檔案在哪、為什麼它存在。

> 📌 **一個實務建議**：
> **如果一個映射需要 `expression = "java(...)"`，不要用 MapStruct 做它。**
> 用一個 `default` 方法（有型別檢查）或直接手寫那個 mapper。
> `expression` 是「用字串寫 Java」——它把編譯期檢查換掉了，
> 而編譯期檢查正是我們用 MapStruct 的唯一理由。

**改成 `default` 方法**：

```java
@Mapper(componentModel = SPRING, unmappedTargetPolicy = ReportingPolicy.ERROR,
        uses = MoneyMapper.class)
public abstract class OrderDtoMapper {          // ★ abstract class 而不是 interface

    @Autowired protected StatusLabelResolver labels;    // ★ 可以注入

    @Mapping(target = "statusLabel", source = ".")       // ★ 整個來源物件傳給下面的方法
    public abstract OrderDetail toDetail(OrderDetailView view, @Context Locale locale);

    /**
     * ★★ 有型別檢查的版本。
     *
     * <p>⚠️ MapStruct 會挑選「參數型別相符、回傳型別相符」的方法來用，
     * 所以這個方法必須是唯一「`OrderDetailView` + `Locale` → `String`」的方法，
     * 否則會出現 "Ambiguous mapping methods" 的編譯錯誤。
     */
    protected String toStatusLabel(OrderDetailView view, @Context Locale locale) {
        return labels.label(view.status(), locale);
    }
}
```

⚠️ **注意這個版本用 `abstract class` 而不是 `interface`** ——
因為它需要 `@Autowired` 一個欄位。而那讓它失去 `interface` 的一個好處
（`default` 方法不能有狀態）。

**這是一個真實的取捨**，不是「MapStruct 比較好」：

| | interface + `uses` | abstract class + `@Autowired` |
|---|---|---|
| 依賴怎麼來 | 只能靠 `uses` 的其他 mapper | ✅ 任意 bean |
| 欄位注入 | — | 🔴 `@Autowired` 欄位注入（01 章 1.4.1 說過它的問題） |
| 可測試性 | ✅ `Mappers.getMapper()` 直接拿 | ⚠️ 要 Spring context 或手動設欄位 |

### 3.4.6 決策表與 shop-service 的決定

| 情況 | 用什麼 | 理由 |
|---|---|---|
| 欄位少（< 8）、有條件邏輯 | **手寫** | MapStruct 的樣板 + `@Mapping` 註解比手寫長 |
| 欄位多（> 15）、幾乎一對一 | **MapStruct** | `unmappedTargetPolicy = ERROR` 的價值隨欄位數線性上升 |
| 需要注入多個 bean | **手寫** | abstract class + `@Autowired` 欄位不值得 |
| 需要 `expression = "java(...)"` | **手寫** | 那等於放棄編譯期檢查（3.4.5） |
| 巢狀三層以上、幾乎一對一 | **MapStruct** | 手寫時每一層都是一個「可能漏欄位」的點 |
| **Domain → Domain** | 手寫（或不做） | ⚠️ 如果 Domain 之間需要 mapper，那通常是聚合切錯了 |
| **DB Projection → View** | **手寫** | 通常只有 6～8 個欄位，而且要處理 `Money` 的組裝 |
| 反序列化方向（Request → Command） | **手寫** | ⚠️ 它有驗證與正規化的語意（3.6），不是純映射 |

**shop-service 的決定**（欄位數一律是 **含巢狀**的數字，算法見 3.10.1）：

| mapper | 欄位數 | 做法 | 理由 |
|---|---|---|---|
| `OrderWebMapper.toCommand` | 13 | **手寫** | ⚠️ 不是因為「欄位少」——是**請求方向**那一列（有 `InvoiceSpec` 的條件轉換與正規化） |
| `OrderWebMapper.toCreateResponse` | 11 | **手寫** | 有 `NextAction.pay(...)` 的組裝邏輯 |
| **`OrderDtoMapper.toDetail`** | **28** | **MapStruct** | ★ 三層巢狀、幾乎一對一 |
| **`OrderDtoMapper.toSupportDetail`** | **31** | **MapStruct** | ★ 欄位最多，而且**漏欄位的後果最嚴重**（3.7） |
| `OrderSummaryMapper` | 7 | 手寫 | 少，而且沒有巢狀 |
| `OrderResultView.from` | 13 | **手寫（static 工廠）** | ★ 不需要任何依賴 → 不做成 bean |
| `OrderSnapshotCodec`（01 章 1.9.4） | 41 | 手寫 | ⚠️ 它需要呼叫 `Order` 的 private 建構子 → MapStruct 做不到 |

⚠️ **`OrderSnapshotCodec` 的 41 個欄位是這張表裡最多的一個，而它必須手寫** ——
也就是「欄位多 → 用 MapStruct」這條判準在它身上不適用。
👉 **所以它需要別的守門人**：01 章 1.9.4 ④ 那個反射比對測試，
以及 3.8.2 的 `MappingCompleteness.of(codec.snapshot(...))`。
**判準是「漏欄位誰會告訴我」，不是「用哪個工具」。**

> 📌 **這張表的形狀本身是結論**：
> **不要全站統一。** 用不用 MapStruct 是**一個 mapper 一個決定**，
> 而判準只有一條：**「這個 mapper 漏一個欄位，誰會告訴我？」**
>
> 欄位少 → 測試看得完 → 手寫。
> 欄位多 → 測試看不完 → 要編譯器。

⚠️ **混用的代價要誠實承認**：

| 代價 | 處置 |
|---|---|
| 新人不知道「這個該用哪個」 | 把上面那張表放進 `docs/adr/0012-mapper-strategy.md` |
| 兩套風格的錯誤訊息不同 | 3.8 的掃描測試對兩者都生效（它掃 DTO 的**結果**，不管誰產生的） |
| `Money → String` 的規則有兩個實作點 | 🔴 **這是真的問題** —— `MoneyMapper`（MapStruct）與 `toPlainString()`（手寫）。3.8.4 的掃描測試是唯一的守門人 |

---

## 3.5 巢狀轉換與集合

單層的映射很簡單。**問題全部出在巢狀與集合上** ——
因為它們有三個「沒有明顯正確答案」的決定要做：

1. `null` 還是空集合？
2. 巢狀物件是 `null` 還是一個「空的」物件？
3. 集合要不要防禦性複製？

而這三個決定**如果每個 mapper 各自決定，就會不一致** ——
於是前端會寫出 `order.items ?? []` 這種防禦性程式碼，
而那種程式碼會掩蓋掉真正的 bug（事故 2 的 `?? 'TWD'`）。

### 3.5.1 巢狀：一個方法一層

**這是唯一需要說的組織原則，但它常被違反。**

```java
// 🔴 一個巨型方法處理三層
public OrderDetail toDetail(OrderDetailView view, Locale locale) {
    return new OrderDetail(
            view.orderId(),
            // ...
            view.items().stream()
                .map(i -> new OrderItemDto(
                        i.productId(),
                        i.productName(),
                        i.quantity(),
                        i.unitPrice().toPlainString(),
                        i.lineTotal().toPlainString(),
                        // ★ 第三層：每個明細的贈品
                        i.gifts() == null ? List.of() : i.gifts().stream()
                            .map(g -> new GiftDto(g.productId(), g.productName(),
                                                  g.quantity(),
                                                  g.source() == null ? null
                                                      : new GiftSourceDto(g.source().type().name(),
                                                                          g.source().refId())))
                            .toList()))
                .toList(),
            // ... 還有 8 個欄位
    );
}
```

**它的問題不是「不好看」，是四個可測量的問題**：

| 問題 | 說明 |
|---|---|
| **沒辦法單獨測第三層** | 要測 `GiftSourceDto` 的轉換，必須建一個完整的 `OrderDetailView` |
| **null 檢查散在各處** | 上面有 2 個三元運算子，而第三層還有一個 —— 政策不可能一致 |
| **git blame 沒用** | 改一個欄位的 diff 涵蓋 20 行（縮排全變） |
| **錯誤訊息沒有位置** | `NullPointerException` 的堆疊只指向這一個方法 |

```java
// ✅ 一個方法一層
public OrderDetail toDetail(OrderDetailView view, Locale locale) {
    return new OrderDetail(
            view.orderId(), view.orderNumber(), view.status(),
            statusLabels.label(view.status(), locale),
            toItems(view.items()),
            toAmounts(view.amounts()),
            view.currency().getCurrencyCode(),
            toAddress(view.shippingAddress()),
            view.couponCode(), view.createdAt(), view.shippedAt(), view.cancelledAt());
}

private static List<OrderItemDto> toItems(List<OrderDetailView.Item> items) {
    return items == null ? List.of() : items.stream().map(OrderWebMapper::toItem).toList();
}

private static OrderItemDto toItem(OrderDetailView.Item i) {
    return new OrderItemDto(i.productId(), i.productName(), i.quantity(),
                            i.unitPrice().toPlainString(), i.lineTotal().toPlainString(),
                            toGifts(i.gifts()));
}

private static List<GiftDto> toGifts(List<OrderDetailView.Gift> gifts) {
    return gifts == null ? List.of() : gifts.stream().map(OrderWebMapper::toGift).toList();
}

private static GiftDto toGift(OrderDetailView.Gift g) {
    return new GiftDto(g.productId(), g.productName(), g.quantity(),
                       toGiftSource(g.source()));
}

private static GiftSourceDto toGiftSource(OrderDetailView.GiftSource s) {
    return s == null ? null : new GiftSourceDto(s.type().name(), s.refId());
}
```

**多了 4 個方法、多了 6 行。買到的**：

| 買到什麼 | |
|---|---|
| 每一層都可以單獨測 | `toGiftSource(null)` 是一個 3 行的測試 |
| null 政策只有一個實作點 | 每個 `toXxxs()` 一律 `== null ? List.of()` |
| **每一層的堆疊追蹤有名字** | `at OrderWebMapper.toGiftSource(OrderWebMapper.java:88)` |
| 3.8.2 的掃描測試可以逐層跑 | 它需要「一個方法一個 target 型別」 |

> 📌 **一個機械化的規則，不需要判斷**：
> **mapper 裡不可以出現超過一層的 lambda 嵌套。**
> 看到 `.map(x -> ... .map(y -> ...))` 就抽方法。
>
> ⚠️ 這條規則可以用 checkstyle 或 PMD 的 `NPathComplexity` 逼近，
> 但實務上寫進 code review checklist 更有效
> —— 因為它的違反很好認（縮排超過 4 層）。

### 3.5.2 集合與 null：三個方向的政策不同 ★

**這一節的結論反直覺**：`null` 的政策**不應該**全站統一，
因為三個方向的語意根本不同。

| 方向 | 集合是 null 時的語意 | 政策 |
|---|---|---|
| **請求（Request → Command）** | 「客戶端沒有送這個欄位」 | ⚠️ **保留 null 或 undefined** —— 它與「送了空陣列」語意不同（3.6） |
| **回應（View → Response DTO）** | 「這張訂單沒有明細」 | ✅ **一律 `List.of()`** —— 前端不需要 null 檢查 |
| **Domain 內部** | 不應該發生 | ✅ 建構子就 `List.copyOf`（會對 null 拋 NPE，那是對的） |

**為什麼回應方向一律非 null？**

```javascript
// 前端如果要處理 null
{order.items?.map(item => <Row key={item.productId} {...item} />) ?? null}

// 前端如果不用處理 null
{order.items.map(item => <Row key={item.productId} {...item} />)}
```

⚠️ 但真正的理由不是「前端方便」，是**這個**：

```javascript
// 🔴 事故 2 的形狀重演
const items = order.items ?? [];       // ← 這行同時吞掉了兩件事：
                                        //   ① 「這張訂單沒有明細」（正常）
                                        //   ② 「mapper 漏了 items」（bug）
```

**「一律非 null」讓後端的 bug 不會被前端的防禦掩蓋。**
如果 `items` 永遠是陣列，那麼 `items` 是 `null` 就代表**後端有 bug**，
而前端可以（也應該）直接讓它炸。

**為什麼請求方向不一樣？**

```json
{ "items": [] }          // ← 客戶端明確說「清空明細」
{ }                      // ← 客戶端說「不要改明細」
```

⚠️ **在 `PATCH` 上這兩者的差別是決定性的**，而「一律轉成 `List.of()`」
會讓它們變成同一件事。3.6 整節在處理這個問題。

**巢狀「物件」呢？**

| 情況 | 政策 | 理由 |
|---|---|---|
| `appliedCoupon`（沒用券） | ✅ `null` | 「沒有券」與「有一張空的券」語意不同 |
| `shippingAddress`（一定有） | ⚠️ `null` 代表 bug → **不要防禦** | 讓它 NPE 比回一個空物件好 |
| `invoice`（選填） | ✅ `null` | 同 `appliedCoupon` |
| `amounts`（一定有） | ⚠️ 同 `shippingAddress` | |

⚠️ **「不要防禦」那兩列值得說明**，因為它與「防禦性程式設計」的直覺相反：

```java
// 🔴 過度防禦
private static ShippingAddressDto toAddress(OrderDetailView.Address a) {
    if (a == null) return new ShippingAddressDto("", "", "", "", "", "");
    // ... 前端收到一張「收件人是空字串」的地址 —— 而它會顯示在畫面上
}

// ✅ 讓它炸
private static ShippingAddressDto toAddress(OrderDetailView.Address a) {
    // ⚠️ 不做 null 檢查。地址是必填（不變量 I2），null 代表資料或程式有問題
    return new ShippingAddressDto(a.recipientName(), a.phone(), a.zipCode(),
                                  a.city(), a.district(), a.street());
}
```

**兩者的差別**：

| | 回空物件 | 讓它 NPE |
|---|---|---|
| 使用者看到 | 一張空白的地址 → 「你們系統壞了」 | 500 + 一個 traceId（04-controller 3.7） |
| 你看到 | ⚠️ **什麼都沒有** | ✅ 堆疊追蹤指向那一行 |
| 資料修好的機會 | 低（沒人知道有幾筆） | 高（log 有 orderId） |

> 📌 **一般原則**：
> **對「不可能為 null 的東西」做 null 檢查，會把「資料錯誤」變成「顯示錯誤」。**
> 前者可以修，後者要靠客戶回報。
>
> ⚠️ 而 `@Nullable` / `@NonNull` 註解（04-controller 6.9.2 用的 JSpecify）
> 讓這件事變成靜態檢查的一部分 —— 那比在執行期加 if 好得多。

### 3.5.3 `List.copyOf` 的邊界在哪 ★

00 章 0.9.2 的 `Order` 用了三次 `List.copyOf`。**它有三個邊界，而三個都會咬人。**

**邊界 1：`List.copyOf` 對 `null` 元素拋 NPE**

```java
List<String> withNull = new ArrayList<>();
withNull.add("a");
withNull.add(null);

List.copyOf(withNull);
// java.lang.NullPointerException
//   at java.base/java.util.ImmutableCollections$ListN.<init>
```

⚠️ **這在 mapper 裡是一個真實的問題**：

```java
// 🔴 如果 toItem 對某些輸入回 null（例如商品已下架）
List<OrderItemDto> items = view.items().stream()
        .map(OrderWebMapper::toItem)         // ← 其中一個回 null
        .toList();                            // ★ Stream.toList() 允許 null！
List.copyOf(items);                           // 🔴 這裡才 NPE
```

**而 `Stream.toList()` 與 `Collectors.toList()` 與 `List.copyOf` 三者的行為不同**：

| 寫法 | 可變？ | 允許 null 元素？ |
|---|---|---|
| `Collectors.toList()` | ✅ 可變（`ArrayList`） | ✅ 允許 |
| `Stream.toList()`（Java 16+） | ❌ 不可變 | ✅ **允許** |
| `List.copyOf(...)` | ❌ 不可變 | 🔴 **NPE** |
| `Collectors.toUnmodifiableList()` | ❌ 不可變 | 🔴 **NPE** |

⚠️⚠️ **第二列是最容易誤解的一列**。很多人以為
`Stream.toList()` 等於 `Collectors.toUnmodifiableList()`。**不是** ——
差別正是 null 元素。

> 📌 **這個差別有一個實用的後果**：
> 如果你想要「不可變**且**不允許 null」，用 `Collectors.toUnmodifiableList()`
> 而不是 `Stream.toList()` —— 前者會在**產生集合的那一刻**炸，
> 後者會在**下游某個地方**炸。

**邊界 2：它是淺拷貝**

```java
public List<Payment> payments() {
    return List.copyOf(payments);        // ★ 00 章 0.9.2 的防禦性複製
}
```

它防住的是：

```java
order.payments().add(...);               // ✅ UnsupportedOperationException
```

它**防不住**的是：**修改元素本身**。

⚠️ **而這不是一個假設的問題** —— 00 章 0.12 ③ 的 `Payment` 有一個
會改變自己狀態的 public 方法：

```java
// 00 章 0.12 ③ 的 Payment
public void refund(Refund refund) {
    Money already = refundedAmount();
    if (already.plus(refund.amount()).compareTo(amount) > 0) {
        throw new RefundExceedsPaymentException(id, amount, already, refund.amount());
    }
    refunds.add(refund);
}
```

```java
// 🔴 List.copyOf 是淺拷貝 → 元素是【同一個】Payment 物件
order.payments().get(0).refund(new Refund(...));
//    ^^^^^^^^^^ 拷貝的是「清單」，不是「清單裡的東西」
```

**這一行真的改到了訂單裡的那筆付款。** 而它的後果很精確：

| 哪一道防線 | 有沒有跑 |
|---|---|
| `Payment.refund()` 自己的檢查（單筆退款 ≤ 單筆付款） | ✅ 跑了 |
| **`Order.assertInvariants()` 的 I8**（`refundedAmount() ≤ paidAmount()`，**跨所有付款**） | 🔴 **完全沒跑** |

⚠️ **而兩者不等價**：`paidAmount()` 只加總 `SUCCEEDED` 的付款，
`refundedAmount()` 卻加總**所有**付款（含 `ORPHANED`）的退款
—— 所以「退一筆 orphaned 付款」會讓 I8 失衡，
而 `Payment.refund()` 看不到這件事。

**所以防禦性複製只在「元素本身不可變」時才是完整的防禦。**

| `Order` 的集合 | 元素型別 | 元素不可變？ | 防禦完整？ |
|---|---|---|---|
| `lines` | `OrderLine`（record） | ✅ | ✅ |
| `payments` | `Payment`（class，有 `refund()`） | 🔴 **不是** | 🔴 |
| `shipments` | `Shipment`（class） | ⚠️ 要看它有沒有 mutator | ⚠️ |

⚠️⚠️ **一個容易搞混的地方，值得說清楚**：
`Payment.refunds()` **本身已經**做了 `List.copyOf`（00 章 0.12 ③ 就寫對了）——

```java
public List<Refund> refunds() { return List.copyOf(refunds); }   // ★ 00 章已經是對的
```

**所以「往 refunds 裡塞東西」這條路是通的嗎？不通**：

```java
order.payments().get(0).refunds().add(new Refund(...));  // ✅ UnsupportedOperationException
```

👉 **也就是：`List.copyOf` 在「每一層都用」的時候是有效的，
問題不在集合，在「元素有 mutator」。**

> 📌 **所以正確的結論不是「加更多 `List.copyOf`」**，而是：
> **`List.copyOf` 保護不了「元素自己會變」的情況 ——
> 那需要的是「不要把可變元素交出去」。**
>
> | 做法 | 代價 |
> |---|---|
> | ① `Payment` 改成 record（不可變），`refund()` 回傳新的 `Payment` | ⚠️ `Order` 要負責替換清單裡那一筆 → 邏輯搬到 `Order` |
> | ② `payments()` 回傳一個唯讀投影（`List<PaymentView>`） | ⚠️ 需要 `Order` 內部另有取得可變 `Payment` 的私有途徑 |
> | ③ **維持現狀 + 一個守門測試** | ✅ shop-service 的選擇（3.10.3 ⑤）—— 因為 ① 與 ② 都會讓 00 章的聚合大改 |
>
> ⚠️ **而要誠實承認 ③ 沒有真的關上這個洞** —— 它只是讓
> 「新增一個回傳可變集合的 accessor」會紅燈。
> **「元素有 mutator」這件事守門測試抓不到。**

**邊界 3：record 的欄位不會自動 `copyOf`**

```java
// 🔴 這個 record 看起來不可變，但它不是
public record OrderDetail(String orderId, List<OrderItemDto> items) {}

var items = new ArrayList<OrderItemDto>();
var dto = new OrderDetail("ord_1", items);
items.add(newItem);                       // 🔴 dto.items() 也變了
```

**record 的「不可變」只保證「欄位的參考不會變」，不保證「參考指向的東西不會變」。**

**處置**：在 compact constructor 裡 copy。

```java
public record OrderDetail(String orderId, List<OrderItemDto> items) {
    public OrderDetail {
        // ★ 一律 copy。⚠️ 用 List.copyOf 而不是 unmodifiableList ——
        //   後者是「唯讀的檢視」，來源變了它也變
        items = items == null ? List.of() : List.copyOf(items);
    }
}
```

⚠️ **`List.copyOf` vs `Collections.unmodifiableList` 的差別很多人不知道**：

```java
var source = new ArrayList<>(List.of("a"));

var view = Collections.unmodifiableList(source);
var copy = List.copyOf(source);

source.add("b");

view.size();      // 2  🔴 它是「檢視」，來源變了它也變
copy.size();      // 1  ✅ 它是「拷貝」
```

| 需求 | 用什麼 |
|---|---|
| DTO / 值物件的欄位 | ✅ `List.copyOf` |
| 「我要給你一個唯讀的檢視，而且我還會改」 | `Collections.unmodifiableList`（⚠️ 這需求很少見且危險） |
| 效能敏感的大集合，來源保證不變 | ⚠️ `unmodifiableList`（省一次複製）—— 但要在 javadoc 寫下那個保證 |

**「一律 copy」的成本呢？**

| 集合大小 | `List.copyOf` 的成本 |
|---|---|
| 5 個元素（一張訂單的明細） | 約 60 ns ——**忽略不計** |
| 1,000 個元素 | 約 4 μs —— 可以接受 |
| 400,000 個元素（匯出） | 🔴 約 12 ms + 一份完整的記憶體副本 |

👉 **所以「一律 copy」的例外只有一個：串流匯出**（3.5.5）。

### 3.5.4 空集合、null、缺欄位在 JSON 上是三件事

**這是前端與後端最常吵的一件事，值得把三種形狀並排看**：

```json
{ "items": [{"productId": "P-1"}] }    // ① 有值
{ "items": [] }                         // ② 空集合
{ "items": null }                       // ③ null
{ }                                     // ④ 欄位不存在
```

**後端的三個設定決定會產生哪一種**：

| 設定 | 效果 |
|---|---|
| mapper 回 `List.of()` | 產生 ② |
| mapper 回 `null` + Jackson 預設 | 產生 ③ |
| mapper 回 `null` + `@JsonInclude(NON_NULL)` | 產生 ④ |

**shop-service 的政策**（04-controller 6.4.3 定的，這裡重申並補上理由）：

```java
// application.yml
spring:
  jackson:
    default-property-inclusion: non_null       # ★ 全站：null 欄位不出現
```

| 欄位 | 產生哪一種 | 理由 |
|---|---|---|
| **集合**（`items`、`shipments`） | ② `[]` | mapper 保證非 null（3.5.2） |
| **選填的巢狀物件**（`appliedCoupon`、`invoice`） | ④ 不出現 | 「沒有」就不要出現在 JSON 裡 |
| **選填的純值**（`shippedAt`、`cancelledAt`） | ④ 不出現 | 同上 |
| **`PATCH` 的回應** | ⚠️ 見 3.6 | 三態的回應方向有特殊考量 |

⚠️ **`non_null` 有一個容易忽略的代價**：

> **客戶端沒辦法分辨「這個欄位不存在」與「這個版本的 API 沒有這個欄位」。**

```json
// v1 的回應
{ "orderId": "ord_1", "status": "PAID" }
// 客戶端：shippedAt 沒有 → 是「還沒出貨」還是「這個 API 不提供」？
```

**處置**：在 OpenAPI 的 schema 裡把「必定存在」的欄位標 `required`。
04-controller 6.9.4 的 springdoc 設定會從 `@Nullable` 推導它 ——
而那是 `@Nullable` 註解的另一個價值。

### 3.5.5 巨大集合：41 萬筆匯出時不要先 map 成 `List`

04-controller 5.2.3 的匯出端點要處理 41 萬筆訂單。

```java
// 🔴 這會 OOM
public List<OrderExportRow> exportAll(OrderQuery query, Actor actor) {
    List<OrderSummaryProjection> all = orders.findAll(query, actor);    // 410,000 筆
    return all.stream().map(this::toExportRow).toList();                 // 🔴 兩份都在記憶體
}
```

**兩個問題**：

| 問題 | 數字 |
|---|---|
| `all` 本身 | 410,000 × 約 200 bytes = **82 MB** |
| `.toList()` 產生第二份 | 再 **82 MB** |
| 🔴 而 JDBC 的 `ResultSet` 預設也會全部撈到記憶體 | 再一份 |

**做法**：一路串流，**mapper 變成 `Function` 而不是「處理集合的方法」**。

```java
package example.shop.order.application;

/**
 * ★★ 串流匯出。
 *
 * <p>三個關鍵：
 * <ol>
 *   <li><b>Repository 回 {@code Stream}</b>（{@code setFetchSize(Integer.MIN_VALUE)}
 *       讓 MySQL 驅動逐列取）。</li>
 *   <li><b>mapper 是「一列一列」的</b> —— {@code toExportRow(projection)}，
 *       不是 {@code toExportRows(list)}。</li>
 *   <li><b>整個過程在交易內</b> —— ⚠️ 而那與 02 章 2.9.2「交易裡不可以做的六件事」
 *       的第 4 條（不要在交易裡寫 HTTP 回應）衝突。</li>
 * </ol>
 *
 * <p>⚠️⚠️ 第 3 點是一個真實的取捨，02 章 2.9.5 討論過：
 * <b>串流匯出必然是一個長交易</b>，因為 cursor 需要交易存活。
 * shop-service 的處置：
 * <ul>
 *   <li>這個端點<b>不共用</b>主連線池（一個 2 條連線的專用池）。</li>
 *   <li>{@code @Transactional(readOnly = true, timeout = 600)} —— 明確的 10 分鐘上限。</li>
 *   <li>04-controller 5.2.4 的「匯出改成非同步 + 產生下載連結」是<b>正解</b>，
 *       而這裡的串流是一個過渡方案。</li>
 * </ul>
 */
@Transactional(readOnly = true, timeout = 600, transactionManager = "exportTransactionManager")
public void streamExport(OrderQuery query, Actor actor, Consumer<OrderExportRow> sink) {
    try (Stream<OrderSummaryProjection> rows = orders.stream(query, actor)) {
        rows.map(OrderExportRow::from)          // ★ 一列一列
            .forEach(sink);                      // ★ 立刻寫出，不累積
    }
}
```

```java
// Controller（04-controller 5.2.3）
@GetMapping(value = "/orders/export", produces = "text/csv")
public StreamingResponseBody export(@Valid OrderQuery query, @CurrentActor Actor actor) {
    return out -> {
        var writer = new CsvWriter(out);
        writer.writeHeader(OrderExportRow.HEADERS);
        // ★★ sink 直接寫進 output stream —— 記憶體用量與筆數無關
        orderExportService.streamExport(query, actor, writer::writeRow);
        writer.flush();
    };
}
```

⚠️ **`OrderExportRow.from` 刻意是 static** —— 它不可以需要任何注入的東西，
因為它會被呼叫 41 萬次，而且它跑在一個沒有 request context 的執行緒上
（00 章 0.14.5 的 `LocaleContextHolder` 陷阱）。

**於是「匯出的 CSV 用哪種語言」必須是一個明確的參數**：

```java
public record OrderExportRow(String orderNumber, String status, String total, ...) {

    public static final String[] HEADERS = {"訂單編號", "狀態", "金額", ...};

    /**
     * ⚠️ 注意它<b>沒有</b> statusLabel —— CSV 匯出用 enum 的 name()。
     *
     * <p>理由：CSV 是給「另一個系統」讀的（財務的 Excel、BI 的 ETL），
     * 而那些系統需要<b>穩定的識別碼</b>而不是本地化的文字。
     * 04-controller 5.2.5 的「匯出的欄位是一份契約」講的就是這件事。
     *
     * <p>👉 如果真的需要中文標籤，做法是「匯出時多一欄 statusLabel」，
     * 而<b>不是</b>把 status 那一欄改成中文 —— 後者會讓歷史檔案不可比對。
     */
    public static OrderExportRow from(OrderSummaryProjection p) {
        return new OrderExportRow(p.orderNumber(), p.status().name(),
                                  p.total().toPlainString(), ...);
    }
}
```

---

## 3.6 `PATCH` 的三態語意 ★★

04-controller 1.6.4 把三態帶到了 Web 層：

```java
public record UpdateOrderRequest(
    JsonNullable<@TextLength(max = 200) String> customerNote,
    JsonNullable<@Valid CreateOrderRequest.InvoiceRequest> invoice,
    JsonNullable<@TextLength(max = 500) String> internalNote
) { ... }
```

**而它留下一個沒有回答的問題**：這三個 `JsonNullable` 到了 Service 層長什麼樣？

04-controller 1.6.4 的答案是一個 builder：

```java
public UpdateOrderCommand toCommand(String orderId, UpdateOrderRequest req, Actor actor) {
    var b = UpdateOrderCommand.builder().orderId(orderId).actor(actor);
    if (req.customerNote().isPresent()) {
        b.customerNote(req.customerNote().get());
    }
    if (req.invoice().isPresent()) {
        b.invoice(toInvoiceSpec(req.invoice().get()));
    }
    return b.build();
}
```

⚠️ **這個答案有一個致命的問題，而 04-controller 沒有指出來。**
這一節從那個問題開始。

### 3.6.1 三態在四層各自長什麼樣

先把「三態」的四層形狀並排：

| 層 | 「不改」 | 「清空」 | 「設成 X」 |
|---|---|---|---|
| **HTTP JSON** | 欄位不存在 | `"customerNote": null` | `"customerNote": "X"` |
| **Web DTO** | `JsonNullable.undefined()` | `JsonNullable.of(null)` | `JsonNullable.of("X")` |
| **Command** | ？ | ？ | ？ |
| **Domain** | 不呼叫任何方法 | `order.clearNote()` | `order.changeNote("X")` |

**第三列就是這一節的主題。**

⚠️ **注意最後一列**：Domain 層**沒有三態** ——
它只有「呼叫」與「不呼叫」，而「清空」是一個明確的操作。
**這一點是整節的結論，3.6.5 會論證它。**

### 3.6.2 04-controller 那個 builder 的致命問題

```java
var b = UpdateOrderCommand.builder().orderId(orderId).actor(actor);
if (req.customerNote().isPresent()) {
    b.customerNote(req.customerNote().get());       // ← 可能是 null（清空）
}
var cmd = b.build();
```

**現在 Service 層拿到 `cmd`，它要怎麼知道「customerNote 該不該改」？**

```java
// 🔴 唯一能寫的東西
if (cmd.customerNote() != null) {
    order.changeNote(cmd.customerNote());
}
```

⚠️⚠️ **「清空」這個操作完全消失了。**

| 客戶端送 | Command 裡是 | Service 做的事 | 應該做的事 |
|---|---|---|---|
| 欄位不存在 | `null` | 不改 ✅ | 不改 |
| `"customerNote": null` | `null` | **不改** 🔴 | **清空** |
| `"customerNote": "X"` | `"X"` | 改成 X ✅ | 改成 X |

**症狀**：客戶在前端把備註欄位清空、按儲存、重新整理 —— **備註還在**。
而前端工程師會非常確定「我送了 `null`」，因為他真的送了。

⚠️ **這個 bug 的隱蔽性在於：三態裡有兩態是對的。**
所以功能「看起來是好的」，只有「清空」這一個路徑壞掉。
而 QA 的測試案例通常是「改成 A」「改成 B」，很少有「改成空的」。

**而 04-controller 那個寫法還有第二個問題**：

```java
// 如果 Command 用 Lombok @Builder，未設定的欄位是 null；
// 但 orderId 與 actor 是必填 —— builder 不會強制
var cmd = UpdateOrderCommand.builder().build();     // ✅ 編譯過、執行過
//                                                  🔴 orderId 是 null
```

01 章 1.8.1 已經說過「用 Command 物件而不是散開的參數」，
但它沒有說「Command 不該用 builder」。**3.6.3 會補上這個結論。**

### 3.6.3 四個選項

| 選項 | 形狀 | 問題 |
|---|---|---|
| ① `JsonNullable` 直接進 Command | `JsonNullable<String> customerNote` | 🔴 Application 層依賴 `org.openapitools.jackson.nullable`（一個**序列化**函式庫） |
| ② `Optional<Optional<T>>` | 外層 = 有沒有送，內層 = 是不是 null | 🔴 沒有人看得懂；而且 `Optional` 不該當欄位型別 |
| ③ 每個欄位配一個 `boolean` | `String customerNote; boolean customerNotePresent;` | 🔴 兩個欄位可能不一致；3 個欄位 → 6 個欄位 |
| ④ **一個 `Patch<T>` sealed interface** | `Patch<String> customerNote` | ✅ shop-service 的選擇 |

**選項 ① 值得多說一句，因為它是最誘人的一個。**

它「只是一個泛型容器」，看起來很無害。**但**：

```java
// ArchUnit（3.3.5）
noClasses().that().resideInAPackage("..application..")
           .should().dependOnClassesThat()
           .resideInAnyPackage("com.fasterxml.jackson..", ...);
```

`org.openapitools.jackson.nullable.JsonNullable` 這個套件名裡有 `jackson`，
而它的存在理由是「表達 JSON 的三態」。**它是一個序列化層的概念。**

⚠️ **而它有一個具體的技術後果，不只是「架構潔癖」**：

```java
// 排程（01 章 1.9.3）要呼叫同一個 use case
orderService.update(UpdateOrderCommand.builder()
        .orderId(id)
        .customerNote(JsonNullable.of(null))     // 🔴 排程要 import 一個 Jackson 的型別
        .build());
```

**第二個入口（判準 5）被迫依賴一個 HTTP 序列化函式庫。**
而下一個入口（gRPC、CLI、訊息佇列）也一樣。

**選項 ④ 的實作**：

```java
package example.shop.common.patch;

import java.util.function.Consumer;
import java.util.function.Function;

/**
 * ★★ 部分更新的三態。
 *
 * <p>它是 {@code PATCH} 語意在 Application 層的表示：
 * <table>
 *   <tr><th>狀態</th><th>HTTP JSON</th><th>意思</th></tr>
 *   <tr><td>{@link Unchanged}</td><td>欄位不存在</td><td>不要改這個欄位</td></tr>
 *   <tr><td>{@link Clear}</td><td>{@code "field": null}</td><td>把這個欄位清空</td></tr>
 *   <tr><td>{@link Set}</td><td>{@code "field": X}</td><td>設成 X</td></tr>
 * </table>
 *
 * <h2>★ 為什麼是 sealed interface 而不是「值 + boolean」</h2>
 * <p>因為 {@code switch} 的<b>完整性檢查</b>：
 * <pre>{@code
 * switch (cmd.customerNote()) {
 *     case Unchanged<String> u -> { }
 *     case Clear<String> c     -> order.clearNote();
 *     // 🔴 忘了 Set → 【編譯錯誤】: the switch statement does not cover all
 *     //               possible input values
 * }
 * }</pre>
 * <p>👉 這正是 3.4 那個主題的延伸：<b>讓「漏處理一個情況」變成編譯錯誤。</b>
 *
 * <h2>⚠️ 它刻意沒有的東西</h2>
 * <ul>
 *   <li><b>沒有 {@code get()}</b> —— 那會邀請 {@code if (p.isSet()) p.get()} 這種寫法，
 *       而那正是 3.6.2 那個 bug 的形狀。</li>
 *   <li><b>沒有 Jackson 註解</b> —— 它不參與序列化（那是 {@code JsonNullable} 的工作）。</li>
 *   <li><b>沒有 {@code orElse(default)}</b> —— 「不改」與「改成預設值」是兩件事。</li>
 * </ul>
 *
 * @param <T> 欄位的型別。⚠️ {@code T} 本身不可為 null（用 {@link Clear} 表達 null）
 */
public sealed interface Patch<T> {

    /** 欄位不存在 → 不要改。 */
    record Unchanged<T>() implements Patch<T> {}

    /** 明確送了 null → 清空。 */
    record Clear<T>() implements Patch<T> {}

    /**
     * 送了一個值 → 設定。
     *
     * @param value ⚠️ 不可為 null（那是 {@link Clear} 的語意）
     */
    record Set<T>(T value) implements Patch<T> {
        public Set {
            java.util.Objects.requireNonNull(value,
                    "Patch.Set 的值不可為 null —— 請用 Patch.clear()（3.6.3）");
        }
    }

    // ── 工廠 ──────────────────────────────────────────

    @SuppressWarnings("unchecked")
    static <T> Patch<T> unchanged() { return (Patch<T>) UNCHANGED; }

    @SuppressWarnings("unchecked")
    static <T> Patch<T> clear() { return (Patch<T>) CLEAR; }

    static <T> Patch<T> set(T value) { return new Set<>(value); }

    /**
     * ★★ 從「有沒有送」與「送了什麼」建立 —— 這是 Web 層唯一需要的工廠。
     *
     * @param present 欄位有出現在 JSON 裡嗎
     * @param value   送來的值（可為 null）
     */
    static <T> Patch<T> of(boolean present, T value) {
        if (!present) return unchanged();
        return value == null ? clear() : set(value);
    }

    // ── 操作 ──────────────────────────────────────────

    /**
     * ★ 把「有值」的情況轉成另一種型別，其他兩種原樣保留。
     *
     * <p>用途：Web 層的 {@code InvoiceRequest} → Domain 的 {@code InvoiceSpec}。
     */
    default <R> Patch<R> map(Function<? super T, ? extends R> f) {
        return switch (this) {
            case Unchanged<T> u -> unchanged();
            case Clear<T> c     -> clear();
            case Set<T> s       -> set(f.apply(s.value()));
        };
    }

    /**
     * ★★ 這是 Application Service 唯一會用到的方法。
     *
     * <p>⚠️ 它刻意<b>強迫你同時處理「設定」與「清空」</b> ——
     * 因為 3.6.2 那個 bug 的根因正是「只處理了設定」。
     *
     * <pre>{@code
     * cmd.customerNote().apply(
     *         note -> order.changeCustomerNote(note, actor, now),
     *         ()   -> order.clearCustomerNote(actor, now));
     * }</pre>
     *
     * @param onSet   有值時做什麼
     * @param onClear 清空時做什麼
     */
    default void apply(Consumer<? super T> onSet, Runnable onClear) {
        switch (this) {
            case Unchanged<T> u -> { }
            case Clear<T> c     -> onClear.run();
            case Set<T> s       -> onSet.accept(s.value());
        }
    }

    /** 這個欄位有被提到嗎（不管是設定還是清空）。⚠️ 用於「空 PATCH」與稽核。 */
    default boolean isMentioned() {
        return !(this instanceof Unchanged<T>);
    }

    Patch<?> UNCHANGED = new Unchanged<>();
    Patch<?> CLEAR     = new Clear<>();
}
```

⚠️ **`UNCHANGED` / `CLEAR` 那兩個常數與 `@SuppressWarnings` 值得解釋**：
`Unchanged<T>` 與 `Clear<T>` **沒有任何欄位**，所以所有 `T` 的實例都是等價的
（就像 `Collections.emptyList()`）。共用一個實例省掉每次 `PATCH` 的 3 個物件配置。

⚠️ **而 `Patch<?> UNCHANGED` 放在 interface 裡是 `public static final`** ——
它會出現在 public API 上。**這是一個小小的洩漏**，
如果介意，可以搬到一個 package-private 的輔助類別：

```java
// 一個更乾淨（但多一個檔案）的版本
final class PatchConstants {
    static final Patch<?> UNCHANGED = new Patch.Unchanged<>();
    static final Patch<?> CLEAR     = new Patch.Clear<>();
    private PatchConstants() {}
}
```

> 📌 **shop-service 選了「放在 interface 裡」**，理由是
> 「多一個檔案的成本 > 兩個常數出現在 public API 的成本」。
> ⚠️ 但這是一個會被 code review 挑戰的決定，所以在 javadoc 寫下理由。

### 3.6.4 `UpdateOrderCommand` 的完整形狀

```java
package example.shop.order.service.command;

import example.shop.common.patch.Patch;
import example.shop.order.domain.Actor;
import example.shop.order.domain.InvoiceSpec;

import java.util.Objects;

/**
 * {@code PATCH /orders/{orderId}}。
 *
 * <h2>★ 三個刻意的設計</h2>
 * <ol>
 *   <li><b>沒有 builder。</b>⚠️ builder 讓「忘記設 orderId」變成執行期的 NPE
 *       而不是編譯錯誤（3.6.2）。而這個 record 有 5 個參數 —— 還在可讀的範圍。</li>
 *   <li><b>每個可修改的欄位都是 {@code Patch<T>}</b> —— 而不是 {@code T}。</li>
 *   <li><b>compact constructor 做 null 正規化</b> ——
 *       ⚠️ 這裡的 {@code null} 是「呼叫端漏傳」而不是「客戶端送 null」，
 *       所以轉成 {@code unchanged()} 是安全的預設。</li>
 * </ol>
 *
 * <p>⚠️ 為什麼不用 {@code expectedVersion} 而是放在 3.6.6 討論：
 * 樂觀鎖的 {@code If-Match} / ETag 是 02 章 2.11.6 的主題，
 * 而它在這裡有一個特殊的問題（部分更新 × 版本衝突）。
 */
public record UpdateOrderCommand(
        String orderId,
        Actor actor,
        Patch<String> customerNote,
        Patch<InvoiceSpec> invoice,
        Patch<String> internalNote
) {
    public UpdateOrderCommand {
        Objects.requireNonNull(orderId, "orderId");
        Objects.requireNonNull(actor, "actor");
        customerNote = orUnchanged(customerNote);
        invoice      = orUnchanged(invoice);
        internalNote = orUnchanged(internalNote);
    }

    /** ★ 這個 PATCH 有提到任何欄位嗎（04-controller 2.12.4 的 422 在 Web 層擋，這裡是第二道）。 */
    public boolean isEmpty() {
        return !customerNote.isMentioned()
                && !invoice.isMentioned()
                && !internalNote.isMentioned();
    }

    /** ★ 3.6.6 ③ 要用：這個 PATCH 有沒有碰到「只有內部人員能改」的欄位。 */
    public boolean touchesInternalFields() {
        return internalNote.isMentioned();
    }

    private static <T> Patch<T> orUnchanged(Patch<T> p) {
        return p == null ? Patch.unchanged() : p;
    }
}
```

**mapper 變成三行**：

```java
/**
 * ★★ 對照 04-controller 1.6.4 的 builder 版本 —— 沒有 if 了。
 *
 * <p>{@code Patch.of(present, value)} 把「三態的判斷」收在一個地方，
 * 於是「漏處理清空」不可能在這裡發生（3.6.2）。
 *
 * <p>⚠️ 方法名從 04-controller 1.6.4 的 {@code toCommand} 改成 {@code toUpdateCommand} ——
 * 因為同一個類別已經有一個 {@code toCommand(CreateOrderRequest, ...)}（3.4.1），
 * 而兩個多載只差在第一個參數的型別。
 * <b>多載在「參數型別相近」時是一個真實的風險</b>：
 * 3.4.2 形狀 2 那個「同型別參數對調」的問題，在多載上會變成「呼叫錯方法」。
 * 👉 3.10.1 那張表用的是這個名字。
 */
public UpdateOrderCommand toUpdateCommand(String orderId, UpdateOrderRequest req,
                                          Actor actor) {
    return new UpdateOrderCommand(
            orderId,
            actor,
            toPatch(req.customerNote()),
            toPatch(req.invoice()).map(OrderWebMapper::toInvoiceSpec),   // ★ 型別轉換
            toPatch(req.internalNote()));
}

/**
 * ★ {@code JsonNullable} → {@code Patch} 的唯一轉換點。
 *
 * <p>⚠️ {@code JsonNullable.isPresent()} 問的是「欄位有出現在 JSON 裡嗎」，
 * <b>不是</b>「值不是 null 嗎」（04-controller 1.6.4 那張表的第一列）——
 * 而那個容易誤導的命名正是為什麼我們要在邊界上把它換成 {@code Patch}。
 */
private static <T> Patch<T> toPatch(JsonNullable<T> v) {
    return Patch.of(v.isPresent(), v.isPresent() ? v.get() : null);
}
```

⚠️ **`toPatch(req.invoice()).map(...)` 那一行有一個細節**：
`map` 只對 `Set` 生效，所以 `toInvoiceSpec` **不會**收到 null。
於是 `toInvoiceSpec` 裡的 `if (req == null) return null;`（3.4.1）
在這條路徑上是多餘的 —— 但它在 `POST` 路徑上仍然需要。

> 📌 **這是「同一個方法服務兩條路徑」的一個小成本**。
> 可以接受，但要在 javadoc 註明，否則下一個人會刪掉那個 null 檢查。

### 3.6.5 Domain 端：`Order.update(Patch)` 還是三個方法？★

**這是這一節最重要的一個決定。**

```java
// 選項 A：Domain 認識 Patch
public void update(Patch<String> customerNote, Patch<InvoiceSpec> invoice, Actor actor, Instant now) {
    customerNote.apply(n -> this.customerNote = n, () -> this.customerNote = null);
    // ...
}

// 選項 B：Domain 只有明確的操作，Application 層展開
public void changeCustomerNote(String note, Actor actor, Instant now) { ... }
public void clearCustomerNote(Actor actor, Instant now) { ... }
```

**shop-service 選 B。四個理由**：

| # | 理由 |
|---|---|
| 1 | **`Patch` 是「HTTP PATCH 的語意」** —— 00 章 判準 7：換掉 HTTP 這個入口，`Patch` 就沒有意義了。它不是領域概念 |
| 2 | **不變量的檢查對「清空」與「設定」不同** —— 見下方 |
| 3 | **狀態機的守衛不同** —— 客戶只能在 `isEditable()` 的狀態改備註；而「清空發票」在已開立發票之後**永遠不允許** |
| 4 | **稽核紀錄需要「操作的名字」** —— `CLEAR_INVOICE` 比 `UPDATE_ORDER` 有用一百倍（3.6.7） |

**理由 2 的具體例子**：

```java
package example.shop.order.domain;

public class Order {

    /**
     * 修改客戶備註。
     *
     * @throws OrderNotEditableException 狀態不允許修改（I5 的一部分）
     * @throws NoteTooLongException      ⚠️ 這是 Domain 的規則，不是 Web 的驗證 ——
     *                                   04-controller 的 {@code @TextLength(max=200)} 是
     *                                   「第一道」，這裡是「最後一道」（00 章 0.8.3）
     */
    public void changeCustomerNote(String note, Actor actor, Instant now) {
        requireEditableBy(actor, now);
        if (note.length() > MAX_NOTE_LENGTH) {
            throw new NoteTooLongException(id, note.length(), MAX_NOTE_LENGTH);
        }
        this.customerNote = note;
    }

    /** ★ 清空。⚠️ 它<b>沒有</b>長度檢查 —— 那正是「兩個方法」的價值。 */
    public void clearCustomerNote(Actor actor, Instant now) {
        requireEditableBy(actor, now);
        this.customerNote = null;
    }

    /**
     * 修改發票資訊。
     *
     * @throws InvoiceAlreadyIssuedException 發票已開立
     */
    public void changeInvoice(InvoiceSpec spec, Actor actor, Instant now) {
        requireEditableBy(actor, now);
        requireInvoiceNotIssued();
        this.invoice = spec;
    }

    /**
     * ★★ 清空發票資訊 —— <b>這裡的規則與 {@link #changeInvoice} 不同</b>。
     *
     * <p>⚠️ 「改成另一組統編」在發票未開立前是允許的；
     * 但「清空」代表「改成個人（不開統編）」，而那在<b>已經送出開票請求之後</b>
     * 即使還沒開立也不允許 —— 因為財政部的 API 是非同步的，
     * 我們不知道那筆請求會不會成功。
     *
     * <p>👉 這個差別如果寫在一個 {@code update(Patch<InvoiceSpec>)} 方法裡，
     * 會變成一個 {@code if (patch instanceof Clear)} —— 也就是
     * <b>把 HTTP 的三態判斷寫進了 Domain</b>。
     */
    public void clearInvoice(Actor actor, Instant now) {
        requireEditableBy(actor, now);
        requireInvoiceNotIssued();
        if (invoiceRequestSubmitted) {
            throw new InvoiceRequestInFlightException(id);
        }
        this.invoice = null;
    }

    /** ★ 只有內部人員可以改（3.6.6 ③ 會在 Application 層再檢查一次）。 */
    public void changeInternalNote(String note, Actor actor) {
        if (!actor.isPrivileged()) {
            throw new InternalFieldNotEditableException(id, "internalNote", actor.type());
        }
        this.internalNote = note;
    }

    public void clearInternalNote(Actor actor) {
        if (!actor.isPrivileged()) {
            throw new InternalFieldNotEditableException(id, "internalNote", actor.type());
        }
        this.internalNote = null;
    }

    /** ★ 三個「change/clear」共用的守衛 —— 只有一份（00 章 0.9.2 的同一個原則）。 */
    private void requireEditableBy(Actor actor, Instant now) {
        if (!status.isEditable()) {
            throw new OrderNotEditableException(id, status);
        }
        if (actor.isCustomer() && !belongsTo(actor)) {
            throw new OrderNotEditableException(id, status);
        }
    }

    private void requireInvoiceNotIssued() {
        if (invoiceIssuedAt != null) {
            throw new InvoiceAlreadyIssuedException(id, invoiceIssuedAt);
        }
    }
}
```

**Application Service 負責「展開」**：

```java
package example.shop.order.application;

/**
 * ★★ 這個方法是 {@code Patch} 這個型別存在的<b>唯一</b>消費點。
 *
 * <p>⚠️ 注意它做的事：把「三態」翻譯成「呼叫哪個 Domain 方法」。
 * 那個翻譯就是 Application 層的職責 ——
 * 00 章 0.4.1 的三個職責裡的「編排」。
 */
@Transactional
public OrderResultView update(UpdateOrderCommand cmd) {
    // ★ 第二道防線：Web 層的 @AssertTrue 已經擋過空 PATCH（04-controller 2.12.4），
    //   但第二個入口（排程、CLI）不會經過它
    if (cmd.isEmpty()) {
        throw new EmptyPatchException(cmd.orderId());
    }
    // ★ 3.6.6 ③：欄位級權限
    if (cmd.touchesInternalFields() && !cmd.actor().isPrivileged()) {
        throw new InternalFieldNotEditableException(cmd.orderId(), "internalNote",
                                                   cmd.actor().type());
    }

    Instant now = clock.instant();
    Order order = orders.findByIdVisibleTo(cmd.orderId(), cmd.actor())
            .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

    // ★★ 展開三態 —— 每一個欄位兩個分支，而 apply() 強迫你都寫
    cmd.customerNote().apply(
            note -> order.changeCustomerNote(note, cmd.actor(), now),
            ()   -> order.clearCustomerNote(cmd.actor(), now));

    cmd.invoice().apply(
            spec -> order.changeInvoice(spec, cmd.actor(), now),
            ()   -> order.clearInvoice(cmd.actor(), now));

    cmd.internalNote().apply(
            note -> order.changeInternalNote(note, cmd.actor()),
            ()   -> order.clearInternalNote(cmd.actor()));

    orders.save(order);
    auditLog.record(toAuditEntry(cmd, order, now));       // ★ 3.6.7
    return OrderResultView.from(order, cmd.actor(), now);
}
```

⚠️ **這段程式碼有 6 個 lambda，看起來很囉唆。**
「囉唆」是真的，而它換到的是：**新增一個可 PATCH 的欄位時，
如果你只寫了 `change` 沒寫 `clear`，`apply()` 的簽章會逼你補上一個 `Runnable`。**

**不能通過編譯的樣子**：

```java
cmd.shippingAddressId().apply(id -> order.changeAddress(id, ...));
// error: method apply in interface Patch<T> cannot be applied to given types;
//   required: Consumer<? super T>, Runnable
//   found:    (id)->order.chan[...]
```

> 📌 **對照 3.6.2 那個 builder 版本**：
> 那裡「漏處理清空」是**靜默**的；這裡是**編譯錯誤**。
> 而這就是整章反覆在做的同一件事。

### 3.6.6 部分更新的四個陷阱

**① 空的 `PATCH`**

04-controller 2.12.4 已決定回 422。⚠️ **而 Service 層要有第二道**
（上面的 `cmd.isEmpty()`），理由是判準 5：第二個入口不會經過 Bean Validation。

⚠️ **但兩道的例外型別不同**：

| 層 | 例外 | 狀態碼 |
|---|---|---|
| Web（`@AssertTrue`） | `MethodArgumentNotValidException` | 422 + `errors[]`（04-controller 3.5.2） |
| Service | `EmptyPatchException` | 422 + 一句 detail |

👉 **這是刻意的**：Web 層能給「哪個欄位錯了」，Service 層不能
（它只知道「全部都沒提到」）。04 章會把 `EmptyPatchException`
接進 `ErrorCode`（00 章 0.12 ⑮ 的 93 個 code 之一）。

**② 只改一個欄位，卻載入整個聚合 + 樂觀鎖衝突**

```java
Order order = orders.findByIdVisibleTo(...);       // ★ 載入 23 個欄位 + 明細 + 付款 + 出貨
order.changeCustomerNote(note, actor, now);         // ★ 只改一個 String
orders.save(order);                                  // ★ UPDATE 所有欄位 + version + 1
```

**兩個代價**：

| 代價 | 具體 |
|---|---|
| 載入成本 | 一張有 30 筆明細、5 筆付款的訂單 → 4 次查詢（或一次大 JOIN） |
| 🔴 **樂觀鎖假衝突** | A 改備註、B 同時改地址 → **兩個都成功嗎？** |

```
A: 讀 version=7  →  改 customerNote  →  UPDATE ... WHERE version=7  ✅ version→8
B: 讀 version=7  →  改 address       →  UPDATE ... WHERE version=7  🔴 0 rows → 衝突
```

**B 收到 409，而 A 與 B 改的是完全不同的欄位。**

⚠️ **這是樂觀鎖的一個真實代價，而 02 章 2.11.6 沒有展開它。**

**四個處置**：

| 處置 | 適用 |
|---|---|
| **接受它** —— 回 409 讓前端重試 | ✅ shop-service 的選擇（同一張訂單被兩個人同時改是罕見事件） |
| 欄位級版本（`customerNoteVersion`） | 🔴 複雜度爆炸，而且不變量檢查會失效 |
| 「只更新有變的欄位」的 UPDATE | ⚠️ 減少覆寫但**不解決 version 衝突**（version 還是要 +1） |
| **不對「純備註類欄位」遞增 version** | ⚠️ 可行，但需要區分「影響不變量的欄位」與「不影響的」→ 見下 |

**第四個處置值得展開，因為它有一個乾淨的判準**：

```java
/**
 * ★ 這次修改有沒有改到「參與不變量」的欄位。
 *
 * <p>如果沒有（只改備註），那麼「A 與 B 同時改」不會產生不一致 ——
 * 因為兩者的結果都是合法的訂單。
 *
 * <p>⚠️ 而如果有（改明細、改金額），version 必須 +1，
 * 因為 B 的判斷是基於 A 修改前的資料。
 */
public boolean affectsInvariants() {
    return invoice.isMentioned();          // 發票影響 I9（統編格式）
    // ★ customerNote / internalNote 不參與任何不變量 → 不影響
}
```

⚠️ **shop-service 仍然選「接受它」**，理由是：
「哪些欄位參與不變量」這個清單**會過期**，
而過期的後果是「不變量被繞過」——比 409 嚴重得多。

> 📌 **這是一個「明知有更好方案但選簡單方案」的例子，而理由要寫下來**：
> 更好的方案需要一份**必須與不變量清單同步維護**的欄位清單，
> 而 00 章 0.8.2 的不變量清單有 11 條、會成長。
> **沒有守門測試能保證兩者同步**，所以那個優化的期望成本是負的。

**③ `PATCH` 的權限是逐欄位的** ★

```json
PATCH /orders/ord_1
{ "customerNote": "改了", "internalNote": "客戶很難搞" }
```

**客戶自己送這個請求會怎樣？**

| 層 | 有沒有擋 |
|---|---|
| Spring Security（`@PreAuthorize("hasRole('CUSTOMER')")`） | ❌ 客戶確實有權限 `PATCH` 自己的訂單 |
| Bean Validation | ❌ `@TextLength(max = 500)` 只檢查長度 |
| **Application Service**（`touchesInternalFields()`） | ✅ |
| **Domain**（`changeInternalNote` 的 `isPrivileged()`） | ✅ 第二道 |

⚠️ **兩道都要**，而它們的位置不是重複：

| 位置 | 為什麼需要 |
|---|---|
| Application | 🔴 **必須在載入訂單之前檢查** —— 否則「客戶試圖改 internalNote」會先做一次查詢，而那是一個可以被用來探測訂單存在性的側通道 |
| Domain | 判準 5：第二個入口（後台批次工具）會直接呼叫 Domain |

⚠️⚠️ **而「欄位級權限」有一個更難的變體**：
如果客戶送 `{"internalNote": null}`（清空）呢？

```java
cmd.touchesInternalFields()          // → true（isMentioned() 對 Clear 也是 true）✅
```

**`isMentioned()` 的定義（`!(this instanceof Unchanged)`）在這裡是對的** ——
「試圖清空一個你不能改的欄位」同樣要拒絕。

> 📌 如果 `isMentioned()` 寫成 `this instanceof Set`（只看「有值」），
> 客戶就能**清空**客服的內部備註。
> ⚠️ 那是一個非常容易寫錯的一行 —— 所以它需要一個測試（3.12 練習 3）。

**④ 「清空」對不變量的影響**

```json
{ "invoice": null }        // 清空發票 → 改成「不開統編」
```

3.6.5 的 `clearInvoice()` 有三個守衛（`isEditable`、`requireInvoiceNotIssued`、
`invoiceRequestSubmitted`）。**而它們的存在證明了一件事**：

> **「清空」不是「設成 null」，它是一個有自己規則的業務操作。**

⚠️ 而 `Patch<InvoiceSpec>` 有一個更微妙的情況：

```json
{ "invoice": { "type": "PERSONAL" } }     // ← 這是「設成個人發票」還是「清空統編」？
```

**這是 API 設計的問題，不是轉換的問題** ——
而它的答案決定了 `InvoiceSpec` 該長什麼樣：

| 設計 | 「不開統編」怎麼表達 |
|---|---|
| `InvoiceSpec` 有 `type` 欄位 | `{"type": "PERSONAL"}` → **`invoice` 永遠不需要清空** |
| `InvoiceSpec` 只有統編相關欄位 | `null` → 需要三態 |

👉 **shop-service 用第一種**（00 章 0.12 ⑧ 的 `InvoiceSpec` 有 `InvoiceType`），
**所以 `invoice` 這個欄位其實不需要 `Patch`** —— 它只需要 `Optional`！

⚠️ **這是一個誠實的發現，而它值得寫下來**：

> 📌 **「這個欄位需要三態嗎」要一個一個問。**
>
> | 欄位 | 需要三態嗎 | 為什麼 |
> |---|---|---|
> | `customerNote` | ✅ | 「沒有備註」是一個有意義的狀態 |
> | `internalNote` | ✅ | 同上 |
> | `invoice` | 🔴 **不需要** | `InvoiceType.PERSONAL` 就是「不開統編」 |
> | `shippingAddressId` | 🔴 不需要 | 地址必填（I2），不可能清空 |
>
> ⚠️⚠️ **最後一列與 02 章 2.14.1 ⑤ 有衝突，必須說清楚**：
> 那裡把「本章用到但定義在後面章節的方法」列成
> **`Order.changeShippingAddress(patch, actor, now)`** —— 參數叫 `patch`。
>
> **而這一節的結論是「地址不需要三態」。** 兩者不可能都對。
>
> 👉 **本章的裁決：02 章那個簽章要改成
> `changeShippingAddress(String addressId, Actor actor, Instant now)`。**
>
> | 理由 | |
> |---|---|
> | 地址是必填（不變量 I2） | 「清空地址」不是一個合法的操作 —— 它應該是 422 而不是「把 null 寫進去」 |
> | ⚠️ 但 `ShippingSnapshot` 要一起更新 | 00 章 0.9.2 的 `shippingSnapshot` 是下單時的快照 → **改地址要同時換快照**，所以它收的其實是 `ShippingAddress` 而不是 id |
>
> **最終簽章**：`changeShippingAddress(ShippingAddress address, Actor actor, Instant now)`
> —— 而它列在 3.10.3 ⑨ 的「說了一半的型別」旁邊，**04 章與它一起補齊**。
>
> **而 shop-service 仍然讓 `invoice` 用 `Patch`**，理由是**一致性**：
> 三個可 PATCH 的欄位用兩種型別，會讓 `apply()` 的呼叫形狀不一致，
> 而不一致的成本 > 一個多餘的 `Clear` 分支的成本。
>
> ⚠️ 但 `clearInvoice()` 的實作要誠實：它不是「清空」，是「改成個人發票」——
> 所以它應該叫 `resetInvoiceToPersonal()`。**3.10.3 ③ 會改這個名字。**

### 3.6.7 `PATCH` 的稽核紀錄：只記變更的欄位

00 章 0.3.2 的事故 6 是「稽核紀錄用 `toJson(order)`，順便把全部客戶的地址電話存進一張沒有遮蔽的表」。

**`PATCH` 的稽核有一個天然的優勢：我們確切知道改了哪些欄位。**

```java
/**
 * ★★ PATCH 的稽核項目。
 *
 * <p>三個刻意的設計：
 * <ol>
 *   <li><b>只記「被提到的欄位」</b> —— 而不是整張訂單（事故 6）。</li>
 *   <li><b>記 before 與 after</b> —— 「改成什麼」沒有「從什麼改成什麼」有用。</li>
 *   <li><b>敏感欄位只記「有沒有變」不記內容</b> ——
 *       ⚠️ {@code internalNote} 可能包含對客戶的評語，
 *       而稽核表的存取控制通常比訂單表寬鬆。</li>
 * </ol>
 */
public record OrderPatchAudit(
        String orderId,
        String actorId,
        ActorType actorType,
        Instant at,
        List<FieldChange> changes
) {
    public record FieldChange(String field, String before, String after) {}

    /** ★ 這些欄位只記「變了」，不記內容。 */
    private static final java.util.Set<String> REDACTED = java.util.Set.of("internalNote");

    static FieldChange of(String field, Object before, Object after) {
        if (REDACTED.contains(field)) {
            return new FieldChange(field, mask(before), mask(after));
        }
        return new FieldChange(field, str(before), str(after));
    }

    /** ⚠️ 只說「有沒有值」與「長度」—— 足以稽核「客服有沒有亂改」，但不洩漏內容。 */
    private static String mask(Object v) {
        return v == null ? "<empty>" : "<%d chars>".formatted(v.toString().length());
    }

    private static String str(Object v) { return v == null ? null : v.toString(); }
}
```

```java
/**
 * ★ 在 Application Service 裡組出稽核項目。
 *
 * <p>⚠️ 它必須在<b>修改之前</b>取得 before 值 ——
 * 而那意味著它不能寫在 {@code orders.save()} 之後。
 * 這是 00 章 0.5.1 那個「先算後果再改狀態」的同一個陷阱。
 */
private OrderPatchAudit toAuditEntry(UpdateOrderCommand cmd, OrderSnapshot before,
                                     Order after, Instant now) {
    var changes = new ArrayList<OrderPatchAudit.FieldChange>();
    if (cmd.customerNote().isMentioned()) {
        changes.add(OrderPatchAudit.of("customerNote",
                                       before.customerNote(), after.customerNote()));
    }
    if (cmd.invoice().isMentioned()) {
        changes.add(OrderPatchAudit.of("invoice", before.invoice(), after.invoice()));
    }
    if (cmd.internalNote().isMentioned()) {
        changes.add(OrderPatchAudit.of("internalNote",
                                       before.internalNote(), after.internalNote()));
    }
    return new OrderPatchAudit(after.id(), cmd.actor().id(), cmd.actor().type(),
                               now, List.copyOf(changes));
}
```

⚠️ **注意它需要一個 `before` 快照**，而 01 章 1.9.4 ④ 的
`OrderSnapshotCodec` 正好提供這個東西：

```java
Order order = orders.findByIdVisibleTo(...).orElseThrow(...);
OrderSnapshot before = snapshotCodec.snapshot(order);      // ★ 修改前
// ... 展開三態、修改
orders.save(order);
auditLog.record(toAuditEntry(cmd, before, order, now));
```

> 📌 **`OrderSnapshotCodec` 原本是「為了記憶體假實作的深拷貝」而存在的**
> （01 章 1.9.4 ④），而它在這裡有了第二個用途。
> **這是一個好訊號**：01 章當時說「它正好就是 06/08 站需要的東西，
> 所以不是為了測試而寫的浪費」—— 這一節印證了那個判斷。

⚠️ **而它有一個代價**：稽核現在依賴一個「必須與 `Order` 的欄位同步」的型別。
01 章 1.9.4 那個「深拷貝涵蓋 `Order` 的每一個欄位」的反射測試同時守住了兩者。

---

## 3.7 依角色決定欄位可見性

04-controller 6.8.3 已經做完了「三個 DTO vs `@JsonView`」的選擇（選三個 DTO），
理由是**「型別問題由編譯器檢查，註解問題由人檢查」**。

**這一節處理它留下的那一半：Service 側怎麼保證「客服的 mapper 不會被客戶端點呼叫」。**

因為「有三個 DTO」只保證了「型別不同」，
它**沒有**保證「對的 DTO 被用在對的地方」。

### 3.7.1 危險的形狀

```java
@GetMapping("/orders/{orderId}")
public OrderDetail get(@PathVariable String orderId, @CurrentActor Actor actor,
                       Locale locale) {
    var view = orderQueryService.findById(orderId, actor);
    return mapper.toDetail(view, locale);
}

@GetMapping("/support/orders/{orderId}")
@PreAuthorize("hasRole('SUPPORT')")
public OrderDetailForSupport getForSupport(@PathVariable String orderId,
                                           @CurrentActor Actor actor, Locale locale) {
    var view = orderQueryService.findDetailForSupport(orderId, actor);
    return mapper.toSupportDetail(view, locale);
}
```

**現在有兩個危險，而它們的形狀不同**：

| # | 危險 | 怎麼發生 |
|---|---|---|
| **A** | 客戶端點呼叫 `toSupportDetail` | 有人為了「重用」而改了第一個方法（例如「客服也要能看客戶視角」的需求） |
| **B** | 客服端點少了 `@PreAuthorize` | 🔴 新增一個 `/support/orders/{id}/refunds` 時忘記標 |

**危險 B 是 04-controller 7.9.5 的「IDOR 授權矩陣」測試的責任**，這裡不重複。
**危險 A 是這一節的主題。**

### 3.7.2 三種防護，以及為什麼要三種都做

**防護 1：mapper 方法自己斷言** ★

```java
/**
 * 組出<b>客服視角</b>的訂單詳情。
 *
 * <p>⚠️⚠️ 它包含 {@code internalNote}、{@code riskScore}、
 * 以及遮蔽後的客戶個資（04-controller 6.6.2）。
 *
 * @param actor ★★ 這個參數<b>不是</b>為了映射任何欄位 ——
 *              它的唯一用途是<b>斷言</b>。
 *              3.3.3 說「mapper 不該收 actor」，而這裡是那條規則的例外，
 *              理由是：<b>洩漏個資的風險 > 「mapper 是純函式」的整潔。</b>
 * @throws IllegalStateException 呼叫者不是內部人員 —— ⚠️ 走到這裡代表<b>程式有 bug</b>
 *                               （端點的授權應該先擋掉），所以是 500 不是 403
 */
public OrderDetailForSupport toSupportDetail(OrderDetailForSupportView view,
                                             Actor actor, Locale locale) {
    // ★★ fail fast。用 IllegalStateException 而不是業務例外，理由同 00 章 0.9.2 的 assertInvariants
    if (!actor.isPrivileged()) {
        throw new IllegalStateException(
                "客服視角的 DTO 被非內部人員的請求組出來了：actor=%s type=%s orderId=%s"
                        .formatted(actor.id(), actor.type(), view.orderId()));
    }
    return new OrderDetailForSupport(/* ... 18 個頂層欄位，含巢狀共 31 個 ... */);
}
```

⚠️ **為什麼是 `IllegalStateException`（500）而不是 `AccessDeniedException`（403）？**

| 選項 | 語意 |
|---|---|
| 403 | 「你沒有權限」—— ⚠️ 這是**對使用者說的話**，暗示「這個操作存在，只是你不能做」 |
| **500** | 「程式有 bug」—— ✅ 授權應該在端點就擋掉，走到 mapper 代表**我們寫錯了** |

👉 **而 500 會進 alert，403 不會。** 那正是我們想要的：
**這件事應該吵醒某個人。**

**防護 2：型別層級的分離**

```java
package example.shop.order.application.view;

/**
 * ★ 標記介面：這個 view 只能給內部人員看。
 *
 * <p>它讓「哪些型別是敏感的」變成一個可以被機械掃描的事實（防護 3）。
 */
public interface InternalOnlyView {}

public record OrderDetailForSupportView(...) implements InternalOnlyView {}
public record RefundAuditView(...)          implements InternalOnlyView {}
public record CustomerRiskView(...)         implements InternalOnlyView {}
```

⚠️ **Web 層需要一個對應的標記介面** ——
因為 3.7.2 防護 3 的第一條規則掃的是 Controller 的**回傳型別**，
而那是 `web.dto` 的型別，不是 `application.view` 的：

```java
package example.shop.order.web.dto;

/**
 * ★ 標記介面：這個 DTO 只能給內部人員看。
 *
 * <p>⚠️ 為什麼需要<b>兩個</b>標記介面（{@code InternalOnlyView} 在 application 層、
 * 這一個在 web 層）而不是共用一個：
 * <ul>
 *   <li>共用的話，它必須放在 {@code common} —— 而 3.3.5 的 ArchUnit 規則
 *       禁止 {@code application} 依賴 {@code web}，反之則允許，
 *       所以「web 層的 DTO 實作 application 層的介面」<b>技術上可行</b>。</li>
 *   <li>⚠️ <b>但那讓「這是一個 DTO」與「這是一個 View」在型別上無法分辨</b>，
 *       而 3.7.2 的兩條規則需要分別掃兩層。</li>
 * </ul>
 *
 * <p>👉 兩個介面各一行，而它們買到「兩層各自可掃」。
 * ⚠️ 代價是<b>一個 support DTO 要記得實作兩個介面中的正確那一個</b> ——
 * 而 3.8.5 的掃描測試正是那個守門人（它的錯誤訊息會說「沒有實作 InternalOnlyDto」）。
 */
public interface InternalOnlyDto {}

public record OrderDetailForSupport(...) implements InternalOnlyDto {}
```

**防護 3：ArchUnit + 掃描測試**

```java
/**
 * ★★ 客戶可存取的端點不可以回傳 {@code InternalOnly} 的 DTO。
 *
 * <p>⚠️ 它靠一個約定：客服端點在 {@code order.web.support} 套件、
 * 路徑以 {@code /support} 開頭。
 * <b>而「約定」需要另一條規則來守</b>（見下方第二條）。
 */
@ArchTest
static final ArchRule 非support套件的Controller不可回傳InternalOnly的DTO =
        noMethods().that().areDeclaredInClassesThat()
                   .resideInAPackage("..order.web..")
                   .and().areDeclaredInClassesThat()
                   .resideOutsideOfPackage("..order.web.support..")
                   .should().haveRawReturnType(
                           JavaClass.Predicates.assignableTo(InternalOnlyView.class))
                   .because("客戶可存取的端點不可回傳內部視角的資料（3.7.2）");

/**
 * ★ 守「約定」本身：{@code order.web.support} 裡的每一個端點都要有 @PreAuthorize。
 *
 * <p>⚠️ 這條規則是上一條的前提 —— 沒有它，
 * 「把 Controller 放進 support 套件」就變成一個繞過檢查的方法。
 */
@ArchTest
static final ArchRule support套件的端點都要有授權標註 =
        methods().that().areDeclaredInClassesThat()
                 .resideInAPackage("..order.web.support..")
                 .and().areAnnotatedWith(GetMapping.class)
                 .should().beAnnotatedWith(PreAuthorize.class)
                 .orShould().beAnnotatedWith(Secured.class);
```

⚠️⚠️ **第二條規則的存在是這一節最重要的一點。**

> 📌 **一條規則如果依賴一個約定，那個約定本身也需要一條規則。**
> 否則你有的不是兩層防護，是**一層防護 + 一個假的安全感**。
>
> 這與 01 章 1.6.6 的「雙重守門」是同一個模式：
> 一條規則擋行為，一條規則擋「繞過那條規則的方法」。

**為什麼三種都要？**

| 防護 | 擋什麼 | 漏什麼 |
|---|---|---|
| 1（mapper 斷言） | ✅ 執行期真的發生時 | 🔴 只在**被觸發**時才知道（可能是在生產環境） |
| 2（標記介面） | ✅ 讓 3 可以掃 | 🔴 自己不擋任何事 |
| 3（ArchUnit） | ✅ **CI 就紅燈** | 🔴 只擋「回傳型別」；擋不到「把欄位塞進客戶的 DTO」 |

⚠️ **第 3 種漏掉的那一項值得看一下**：

```java
// 🔴 ArchUnit 擋不到這個
public record OrderDetail(
    // ... 12 個欄位
    String internalNote          // ← 有人為了「客服後台重用同一個 DTO」而加的
) {}
```

**這需要第四種防護：DTO 的欄位名黑名單掃描**（3.8.5）。

### 3.7.3 欄位 × 角色的完整清單

**這張表應該存在於程式碼旁邊，而不是只在某人的腦子裡。**

| 欄位 | 客戶 | 客服 | 倉庫 | 財務 | 備註 |
|---|---|---|---|---|---|
| `orderId` / `orderNumber` | ✅ | ✅ | ✅ | ✅ | |
| `status` / `statusLabel` | ✅ | ✅ | ✅ | ✅ | |
| `items[].productId` / `productName` / `quantity` | ✅ | ✅ | ✅ | ✅ | |
| `items[].unitPrice` / `lineTotal` | ✅ | ✅ | ❌ | ✅ | 倉庫不需要知道價格 |
| `items[].costPrice` | ❌ | ❌ | ❌ | ✅ | 🔴 成本價絕不對外 |
| `amounts.*` | ✅ | ✅ | ❌ | ✅ | |
| `shippingAddress.*` | ✅ | 🔸 遮蔽 | ✅ | ❌ | 倉庫要完整地址才能出貨 |
| `customerName` | ✅ | 🔸 遮蔽中間 | 🔸 只有姓 | ❌ | 04-controller 6.6.2 |
| `customerEmail` / `customerPhone` | ✅ | 🔸 遮蔽 | ❌ | ❌ | |
| `cardNumber` | 🔸 後四碼 | 🔸 後四碼 | ❌ | 🔸 後四碼 | `MaskedCardNumber` 型別 |
| `internalNote` | ❌ | ✅ | ❌ | ❌ | 🔴 事故 1 |
| `riskScore` | ❌ | ✅ | ❌ | ❌ | |
| `cancellation.note` | 🔸 只有客戶自己填的 | ✅ | ❌ | ❌ | ⚠️ 見下 |
| `payments[].gatewayResponse` | ❌ | 🔸 只有錯誤碼 | ❌ | ✅ | 🔴 原始回應含卡號片段 |

⚠️ **`cancellation.note` 那一列是一個真實的陷阱**：

```java
// 00 章 0.9.2
public CancellationResult cancel(Actor actor, CancelReason reason, String note, Instant now) {
    // ...
    this.cancellation = new Cancellation(actor, reason, note, now);
}
```

**同一個 `note` 欄位，客戶取消時是客戶填的，客服取消時是客服填的。**

```json
// 客服取消時填的
{ "cancellation": { "reason": "OUT_OF_STOCK", "note": "此客戶已列黑名單，不主動通知" } }
```

**而客戶查詢自己的訂單時，會看到這個 note。** 🔴

**處置**：

```java
/**
 * ★★ 取消資訊的客戶視角。
 *
 * <p>⚠️ {@code note} 只在「取消者是客戶自己」時才出現 ——
 * 客服填的備註屬於 {@code internalNote} 的等級（3.7.3 那張表）。
 *
 * <p>👉 而更好的設計是<b>從一開始就分成兩個欄位</b>
 * （{@code customerNote} 與 {@code staffNote}）——
 * 3.10.3 ④ 會做這個修正，因為「靠 mapper 判斷要不要顯示」
 * 是一個<b>每個 mapper 都要記得</b>的規則。
 */
private CancellationDto toCancellation(OrderDetailView.Cancellation c, Locale locale) {
    if (c == null) return null;
    return new CancellationDto(
            c.reason(),
            // ⚠️ reasonLabel 不是 View 的欄位 —— 它由 Web 層算（3.10.3 ②）
            reasonLabels.label(c.reason(), locale),
            // ★ 只有客戶自己取消時才給 note
            c.cancelledByType() == ActorType.CUSTOMER ? c.customerNote() : null,
            c.at());
}
```

⚠️ **這段程式碼要能編譯，`OrderDetailView.Cancellation` 必須有
`cancelledByType()`、`customerNote()`、`at()` 三個 component**
—— 而 3.12 練習 2 的版本只有 `(reason, customerNote, at)`。
👉 **正式的形狀**（3.10.3 ⑨ 會把它列進修正表）：

```java
/**
 * ★ 取消資訊的「客戶視角 View」。
 *
 * <p>⚠️ 它<b>沒有</b> {@code staffNote} —— 那是型別層級的保證（3.7.2 防護 2），
 * 而不是「mapper 記得不要填」。
 *
 * <p>⚠️ 它<b>有</b> {@code cancelledByType} 但<b>沒有</b> {@code cancelledBy}
 * （完整的 {@code Actor}）—— 因為 View 只需要「是誰的類型」來決定要不要顯示備註，
 * 不需要客服的姓名與 id（那是 3.7.3 那張表的「客服 = ❌」那一列）。
 */
public record Cancellation(CancelReason reason,
                           ActorType cancelledByType,
                           String customerNote,
                           Instant at) {}
```

> 📌 **注意這個處置的形狀**：它是一個**在 mapper 裡的 if**。
> 而 3.3.3 剛剛說「mapper 不該有業務判斷」。
>
> **這是一個真實的矛盾，而正確的解法是改資料模型**（3.10.3 ④）：
> 把一個「語意隨角色而變」的欄位拆成兩個語意固定的欄位。
> **只要一個欄位的意思取決於誰在看，它就遲早會洩漏。**

### 3.7.4 遮蔽發生在哪一層 ★

04-controller 6.6.2 用 `@Masked` 註解 + 一個 Jackson serializer：

```java
public record OrderDetailForSupport(
    @Masked(Masked.Style.EMAIL) String customerEmail,
    @Masked(Masked.Style.PHONE) String customerPhone
) {}
```

**也就是：遮蔽在「序列化」時發生。** 這有一個具體的後果：

```java
var dto = mapper.toSupportDetail(view, actor, locale);
dto.customerEmail();          // 🔴 "wang.dachui@example.com"（完整的）
log.info("支援查詢 {}", dto);  // 🔴 完整的 email 進了 log
```

**04-controller 6.6.2 已經指出這件事**（`@Masked` 不影響 log）
並給了兩個解法（不要 log 整個 DTO / 覆寫 `toString`）。

⚠️ **但這一章要問一個更根本的問題：遮蔽應該在哪一層？**

| 選項 | 遮蔽在 | 優點 | 缺點 |
|---|---|---|---|
| **A**（04-controller 的選擇） | 序列化 | ✅ DTO 保留完整值，需要時可用 | 🔴 log / 稽核 / 快取都會拿到完整值 |
| **B** | **mapper** | ✅ DTO 裡就是遮蔽後的值 —— 不可能洩漏 | 🔴 客服「真的需要完整 email 寄信」時沒辦法 |
| **C** | **型別**（`MaskedCardNumber`） | ✅✅ 型別保證 | ⚠️ 每個欄位一個型別，成本高 |

**shop-service 的分工**（這是一個「按敏感度分級」的決定）：

| 敏感度 | 欄位 | 用哪個 |
|---|---|---|
| 🔴🔴 **絕不可能需要完整值** | 卡號、密碼、身分證號 | **C**（型別）—— 完整值連 DTO 都進不來 |
| 🔴 **偶爾需要完整值** | email、phone、地址 | **A**（序列化）+ 一條規則：不可 log DTO |
| ⚠️ 只是「不好看」 | 客戶姓名 | **A** |

⚠️ **「不可 log DTO」那條規則需要一個守門人**，否則它只是一句話：

```java
/**
 * ★★ 禁止把 DTO 傳給 logger。
 *
 * <p>它抓的是 {@code log.info("... {}", dto)} —— 而那會呼叫 {@code toString()}，
 * 繞過 {@code @Masked}（3.7.4）。
 *
 * <p>⚠️ 這條規則有誤報：{@code log.info("orderId={}", dto.orderId())} 是安全的。
 * 所以它只擋「整個 DTO 當參數」的情況 —— 靠的是參數的<b>型別</b>。
 */
@ArchTest
static final ArchRule 不可將含遮蔽欄位的DTO傳給logger =
        noClasses().should().callMethodWhere(
                JavaCall.Predicates.target(owner(assignableTo(org.slf4j.Logger.class)))
                        .and(hasParameterOfMaskedDtoType()))
                .because("@Masked 只影響序列化，不影響 toString()（3.7.4）");
```

⚠️ **這條規則寫起來很麻煩**（`hasParameterOfMaskedDtoType()` 需要自訂述詞），
而它的替代方案便宜得多：

```java
/**
 * ★ 更便宜的做法：讓所有含 @Masked 欄位的 DTO 都必須覆寫 toString()。
 *
 * <p>它把「檢查每個呼叫點」換成「檢查每個型別」——
 * 型別只有 8 個，呼叫點有幾百個。
 */
@ArchTest
static final ArchRule 含Masked欄位的DTO必須覆寫toString =
        classes().that(containAnyFieldAnnotatedWith(Masked.class))
                 .should(overrideToString())
                 .because("record 的預設 toString() 會印出原始值（3.7.4）");
```

> 📌 **這是一個一般化的技巧，值得記住**：
> **當「檢查所有呼叫點」太貴時，改成「檢查所有型別」。**
> 前者的數量隨程式碼成長，後者不會。

### 3.7.5 稽核：誰看過什麼

⚠️ **這一節超出「轉換」的範圍，但它與 3.7.3 那張表是同一件事的另一半**：

> **限制「誰能看什麼」之後，還要記錄「誰實際看了什麼」。**

因為 3.7.3 的表允許客服看客戶的 email，而
「客服查了 3,000 個客戶的 email」與「客服查了 3 個」是完全不同的事 ——
**而前者是個資外洩，後者是正常工作。**

```java
/**
 * ★ 客服視角的查詢一律留下稽核紀錄。
 *
 * <p>⚠️ 它<b>不是</b> {@code @Transactional} 的一部分 ——
 * 這是一個唯讀查詢，而稽核紀錄是寫入。
 * 兩者放在同一個交易裡會讓「唯讀最佳化」失效（02 章 2.5.2）。
 *
 * <p>👉 所以稽核用 {@code REQUIRES_NEW}（02 章 2.3.4）或
 * 直接非同步寫入（06 章）。shop-service 用後者，
 * 理由是「稽核失敗不該讓查詢失敗」——
 * ⚠️ 而那個決定的代價是<b>稽核紀錄可能遺失</b>，
 * 所以它需要一個「掉了幾筆」的指標（06 章 6.9.3）。
 */
@Transactional(readOnly = true)
public OrderDetailForSupportView findDetailForSupport(String orderId, Actor actor) {
    var view = orders.findDetailForSupport(orderId)
            .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));
    // ★★ 記錄「看了哪些敏感欄位」而不是「看了這張訂單」
    accessAudit.recordAsync(new SensitiveDataAccess(
            actor.id(), actor.type(), "Order", orderId,
            List.of("customerEmail", "customerPhone", "internalNote", "riskScore"),
            clock.instant()));
    return view;
}
```

⚠️ **`List.of("customerEmail", ...)` 那個硬編碼的欄位清單有一個維護問題**：
`OrderDetailForSupportView` 加一個敏感欄位時，這裡不會跟著改。

**處置**：從型別推導。

```java
/**
 * ★★ 從 DTO 的 {@code @Masked} 與 {@code @Sensitive} 註解推導欄位清單。
 *
 * <p>它讓「加一個敏感欄位」自動被稽核涵蓋 ——
 * 而不需要記得改另一個地方。
 *
 * <p>⚠️ 這個推導在啟動時做一次並快取（反射不便宜），
 * 而「快取」意味著它假設型別不會在執行期改變 —— 那個假設在 JVM 上成立。
 */
@Component
public class SensitiveFieldRegistry {

    private final Map<Class<?>, List<String>> cache = new ConcurrentHashMap<>();

    public List<String> sensitiveFieldsOf(Class<?> viewType) {
        return cache.computeIfAbsent(viewType, t ->
                Arrays.stream(t.getRecordComponents())
                      .filter(c -> c.isAnnotationPresent(Masked.class)
                                || c.isAnnotationPresent(Sensitive.class))
                      .map(RecordComponent::getName)
                      .toList());
    }
}
```

---

## 3.8 轉換的測試 ★★

**這一節回答一個具體的問題**：
一個映射 **31 個欄位**（18 個頂層 + 13 個巢狀，3.10.1）的 mapper，要怎麼測？

### 3.8.1 逐欄位斷言的問題

```java
@Test
void toSupportDetail_映射所有欄位() {
    var view = Views.fullyPopulatedSupportView();
    var dto = mapper.toSupportDetail(view, Actors.support(), Locale.TAIWAN);

    assertThat(dto.orderId()).isEqualTo("ord_1");
    assertThat(dto.customerId()).isEqualTo("cus_1");
    assertThat(dto.customerName()).isEqualTo("王大槌");
    assertThat(dto.customerEmail()).isEqualTo("wang@example.com");
    // ... 還有 27 行
}
```

**它有四個問題，而第四個是決定性的**：

| # | 問題 |
|---|---|
| 1 | 31 行斷言，寫的人在第 12 行就開始複製貼上 |
| 2 | 新增一個欄位時，這個測試**照樣通過** —— 它只斷言「這 31 個對」，不斷言「沒有第 32 個」 |
| 3 | 讀不出意圖 —— 31 個 `isEqualTo` 沒有告訴你「哪一個是重點」 |
| 4 | 🔴 **它抓不到 3.4.2 的形狀 2（位置對調）** —— 除非測資的 `city` 與 `district` 不同，而且斷言真的有寫對 |

⚠️ **問題 4 值得展開**，因為它揭露了一件事：

```java
// 測資
new ShippingAddressDto("王大槌", "0912345678", "104", "台北市", "中山區", "南京東路一段 1 號")

// mapper 的 bug（city 與 district 對調）
new ShippingAddressDto(a.recipientName(), a.phone(), a.zipCode(),
                       a.district(), a.city(), a.street())

// 測試
assertThat(dto.city()).isEqualTo("中山區");         // 🔴 寫測試的人「照著 mapper 寫」
assertThat(dto.district()).isEqualTo("台北市");     // 🔴 於是測試與 bug 一致
```

> 📌 **「照著實作寫測試」是逐欄位斷言的天然結果**，
> 因為 31 個欄位沒有人記得住 —— 你會打開 mapper 對照著寫。
> **而那讓測試變成「實作的複本」而不是「規格」。**

### 3.8.2 掃描測試 1：目標的每一個欄位都不是預設值 ★★

**這是最划算的一個測試。** 它抓 3.4.2 的形狀 1（漏映射 → null）。

```java
package example.shop.common.test;

import java.lang.reflect.RecordComponent;
import java.util.*;

/**
 * ★★ 「每一個欄位都被映射到了」的通用斷言。
 *
 * <h2>它的原理</h2>
 * <p>給它一個「每個欄位都有非預設值」的來源，跑過 mapper，
 * 然後檢查<b>目標的每一個欄位都不是預設值</b>。
 *
 * <p>👉 於是「漏一個欄位」→ 那個欄位是 {@code null}/{@code 0}/{@code false} → 紅燈。
 *
 * <h2>⚠️ 它抓不到什麼（一定要知道）</h2>
 * <ul>
 *   <li>🔴 <b>位置對調</b>（3.4.2 形狀 2）—— 兩個欄位都非 null，它看不出來。</li>
 *   <li>🔴 <b>值算錯</b> —— {@code total} 填成 {@code subtotal} 它不管。</li>
 *   <li>⚠️ <b>「刻意為 null」的欄位</b> —— 需要用 {@code allowingNull(...)} 明確排除，
 *       而<b>那個排除清單本身就是文件</b>（見下方的用法）。</li>
 * </ul>
 *
 * <p>👉 所以它<b>不能取代</b>手寫斷言（3.8.6），它取代的是
 * 「31 行 assertThat 裡的 28 行沒有價值的那部分」。
 */
public final class MappingCompleteness {

    private final Object target;
    private final Set<String> allowedNull = new HashSet<>();

    private MappingCompleteness(Object target) {
        this.target = target;
    }

    public static MappingCompleteness of(Object target) {
        return new MappingCompleteness(target);
    }

    /**
     * ★ 明確允許為 null 的欄位。
     *
     * <p>⚠️ 每一個都要有理由 —— 而「有理由」是靠 code review 守的。
     * 如果這個清單超過 3 個，那通常代表「一個 DTO 服務了太多情境」。
     */
    public MappingCompleteness allowingNull(String... fields) {
        allowedNull.addAll(Arrays.asList(fields));
        return this;
    }

    public void assertComplete() {
        Class<?> type = target.getClass();
        if (!type.isRecord()) {
            throw new IllegalArgumentException(
                    "MappingCompleteness 只支援 record（DTO 一律用 record，3.4.2 形狀 3）："
                            + type.getName());
        }
        var missing = new ArrayList<String>();
        for (RecordComponent c : type.getRecordComponents()) {
            if (allowedNull.contains(c.getName())) continue;
            Object value = read(c);
            if (isDefault(value, c.getType())) {
                missing.add("%s (%s) = %s".formatted(
                        c.getName(), c.getType().getSimpleName(), value));
            }
        }
        if (!missing.isEmpty()) {
            throw new AssertionError("""
                    %s 有 %d 個欄位是預設值 —— mapper 可能漏了它們：
                    %s

                    ★ 如果某個欄位「刻意」為空，請用 allowingNull("欄位名") 明確排除，
                      並在測試裡註明理由。
                    """.formatted(type.getSimpleName(), missing.size(),
                                  String.join("\n  ", missing)));
        }
    }

    /** ⚠️ 空集合也算「預設值」—— 否則 {@code toItems()} 回 {@code List.of()} 的 bug 抓不到。 */
    private static boolean isDefault(Object value, Class<?> type) {
        if (value == null) return true;
        if (value instanceof Collection<?> c) return c.isEmpty();
        if (value instanceof Map<?, ?> m) return m.isEmpty();
        if (value instanceof String s) return s.isEmpty();
        if (type == int.class || type == long.class || type == short.class
                || type == byte.class) {
            return ((Number) value).longValue() == 0L;
        }
        if (type == double.class || type == float.class) {
            return ((Number) value).doubleValue() == 0.0d;
        }
        if (type == boolean.class) return !((Boolean) value);
        if (type == char.class) return (Character) value == '\0';
        return false;
    }

    private Object read(RecordComponent c) {
        try {
            var accessor = c.getAccessor();
            accessor.setAccessible(true);
            return accessor.invoke(target);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("讀不到 " + c.getName(), e);
        }
    }
}
```

**用法**：

```java
class OrderWebMapperCompletenessTest {

    private final OrderWebMapper mapper =
            new OrderWebMapper(StatusLabelResolver.identity());     // ★ 00 章 0.14.4

    @Test
    void toDetail映射了每一個欄位() {
        var dto = mapper.toDetail(Views.fullyPopulatedDetailView(), Locale.TAIWAN);

        MappingCompleteness.of(dto)
                // ★ 這兩個「刻意可為 null」的欄位，理由寫在這裡
                .allowingNull("cancelledAt")     // 未取消的訂單沒有取消時間
                .allowingNull("couponCode")      // 沒用券
                .assertComplete();
    }

    @Test
    void toSupportDetail映射了每一個欄位() {
        var dto = mapper.toSupportDetail(Views.fullyPopulatedSupportView(),
                                         Actors.support(), Locale.TAIWAN);
        MappingCompleteness.of(dto).assertComplete();      // ★ 31 個欄位，一行
    }

    /**
     * ★★ 巢狀的每一層都要單獨掃 —— 3.5.1「一個方法一層」讓這件事變可能。
     */
    @Test
    void 巢狀的每一層都映射完整() {
        var dto = mapper.toDetail(Views.fullyPopulatedDetailView(), Locale.TAIWAN);

        MappingCompleteness.of(dto.amounts()).assertComplete();
        MappingCompleteness.of(dto.shippingAddress()).assertComplete();
        dto.items().forEach(i -> MappingCompleteness.of(i).assertComplete());
        dto.items().stream().flatMap(i -> i.gifts().stream())
           .forEach(g -> MappingCompleteness.of(g).assertComplete());
    }
}
```

⚠️⚠️ **`Views.fullyPopulatedDetailView()` 是這整套測試的單點失效。**

01 章 1.9.4 ④ 已經指出過這個陷阱：

> **如果它建的物件有欄位是 `null`，那個欄位「映射後也是 null」→ 測試通過 → 漏檢。**

**所以 `fullyPopulated` 系列自己需要一個測試**：

```java
/**
 * ★★ 守門人的守門人。
 *
 * <p>它斷言「每一個 fullyPopulated 工廠產生的物件，本身每個欄位都非預設值」。
 * 沒有它，3.8.2 的所有測試都可能是假綠燈。
 */
@Test
void 所有fullyPopulated工廠產生的物件都真的填滿了() {
    MappingCompleteness.of(Views.fullyPopulatedDetailView()).assertComplete();
    MappingCompleteness.of(Views.fullyPopulatedSupportView()).assertComplete();
    MappingCompleteness.of(Orders.fullyPopulated()).assertComplete();   // ⚠️ 見下
}
```

⚠️ **`Orders.fullyPopulated()` 回的是 `Order`（class 不是 record）**，
所以 `MappingCompleteness` 對它無效（它只支援 record）。

**這是一個真實的限制，而處置有兩個**：

| 處置 | 代價 |
|---|---|
| 讓 `MappingCompleteness` 也支援 class 的欄位反射 | ⚠️ 要處理 `static`、`synthetic`、`final` 的常數 —— 而 `Order` 有 3 個 `static final` |
| **用 `OrderSnapshot`（record）當代理** | ✅ shop-service 的選擇：`MappingCompleteness.of(codec.snapshot(Orders.fullyPopulated()))` |

👉 **第二個更好**，而且它順便驗證了 `OrderSnapshotCodec` ——
01 章 1.9.4 ④ 那個反射測試與這一個是**同一個問題的兩個角度**。

### 3.8.3 掃描測試 2：來源與目標的欄位名對照

**這一個抓的是 3.4.2 的形狀 2（位置對調）** —— 至少抓得到一部分。

```java
/**
 * ★ 用「值本身帶著欄位名」的測資，抓出「位置對調」。
 *
 * <h2>原理</h2>
 * <p>不要用「看起來像真的」的測資（{@code "台北市"}），
 * 而是用<b>欄位名當值</b>（{@code "city"}）——
 * 於是「city 與 district 對調」變成 {@code dto.city() == "district"}，
 * 而那是一個一行就能斷言的事。
 *
 * <h2>⚠️ 它的限制</h2>
 * <p>只適用於「來源與目標的欄位名相同」的映射。
 * {@code view.currency().getCurrencyCode() → dto.currency()} 這種
 * 「同名但值要轉換」的欄位要排除。
 */
@Test
void 同名欄位沒有對調() {
    // ★ 每個 String 欄位的值 = 它自己的欄位名
    var view = new OrderDetailView.Address(
            "recipientName", "phone", "zipCode", "city", "district", "street");

    var dto = OrderWebMapper.toAddress(view);

    // ★★ 用反射逐一比對「同名的欄位值相等」—— 6 行變 1 行
    assertSameNamedFieldsMatch(view, dto);
}

/**
 * ★ 通用斷言：目標的每一個欄位，如果來源有同名欄位，值必須相等。
 *
 * @param exclude 名字相同但值需要轉換的欄位（例如 Money → String）
 */
static void assertSameNamedFieldsMatch(Object source, Object target, String... exclude) {
    var skip = Set.of(exclude);
    var sourceValues = recordValues(source);
    for (var c : target.getClass().getRecordComponents()) {
        if (skip.contains(c.getName())) continue;
        if (!sourceValues.containsKey(c.getName())) continue;      // 目標獨有的欄位
        assertThat(read(target, c))
                .as("欄位 %s 的值與來源不符 —— 檢查 mapper 的參數順序（3.4.2 形狀 2）",
                    c.getName())
                .isEqualTo(sourceValues.get(c.getName()));
    }
}
```

**它在對調時的輸出**：

```
java.lang.AssertionError:
[欄位 city 的值與來源不符 —— 檢查 mapper 的參數順序（3.4.2 形狀 2）]
expected: "city"
 but was: "district"
```

⚠️ **對照逐欄位斷言的輸出**：

```
expected: "中山區"
 but was: "台北市"
```

**後者需要你知道「中山區應該是 district」才看得懂。**
前者的訊息本身就說出了問題。

> 📌 **這是一個一般化的測試技巧**：
> **當你在測「結構」而不是「值」時，讓值本身攜帶結構資訊。**
> 用 `"city"` 當 city 的值、用 `"1"` 當第一筆明細的 quantity ——
> 於是錯誤訊息會直接告訴你錯在哪。

### 3.8.4 掃描測試 3：金額欄位一律是 `String`

04-controller 6.5.7 決定了「金額對外序列化成字串」。
**這一個測試守那個決定。**

```java
/**
 * ★★ 所有 web DTO 的金額欄位都是 String（04-controller 6.5.7）。
 *
 * <p>它抓的是「有人在新 DTO 裡用了 {@code BigDecimal}」——
 * 而那會讓 JSON 產生 {@code 12800.00}（數字），
 * 於是 JavaScript 的 {@code Number} 會在超過 2^53 時失真，
 * 而且 {@code 0.1 + 0.2} 的問題會回到前端。
 *
 * <p>⚠️ 它也抓 {@code Money} —— Money 不可以直接進 web DTO
 * （即使有 serializer，因為那讓「金額的格式」有兩個決定點）。
 */
@Test
void web層的DTO不含BigDecimal或Money() {
    var classes = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
            .importPackages("example.shop..web.dto");

    var offenders = classes.stream()
            .filter(JavaClass::isRecord)
            .flatMap(c -> c.getFields().stream())
            .filter(f -> f.getRawType().isAssignableTo(java.math.BigDecimal.class)
                      || f.getRawType().getName().equals(Money.class.getName()))
            .map(f -> "%s.%s : %s".formatted(f.getOwner().getSimpleName(),
                                             f.getName(),
                                             f.getRawType().getSimpleName()))
            .toList();

    assertThat(offenders)
            .as("""
                web DTO 的金額欄位必須是 String（04-controller 6.5.7）。
                找到 %d 個違規欄位。
                ★ 修法：在 mapper 裡呼叫 money.toPlainString()，
                  或讓 MapStruct 用 MoneyMapper（3.4.4）。
                """, offenders.size())
            .isEmpty();
}
```

⚠️ **這個測試有一個誤報來源**：「數量」型的 `BigDecimal`
（例如「0.5 公斤」）。**處置是一個明確的白名單型別**：

```java
/** ★ 重量。用一個型別而不是 BigDecimal，讓 3.8.4 的掃描不需要例外清單。 */
public record Weight(BigDecimal kilograms) {
    public String toPlainString() { return kilograms.toPlainString(); }
}
```

> 📌 **「加一個型別」通常比「加一個例外清單」好**，
> 因為例外清單會成長，而型別不會。

### 3.8.5 掃描測試 4：DTO 不可出現敏感欄位名

**這一個補上 3.7.2 防護 3 漏掉的那一項。**

```java
/**
 * ★★ 客戶可見的 DTO 不可以有「內部欄位」的名字。
 *
 * <p>⚠️ 它是一個<b>黑名單</b>，而 3.2.2 剛剛說黑名單不好。
 * 那不矛盾 —— 這裡的黑名單<b>不是</b>安全機制，它是一個
 * <b>提醒機制</b>：真正的安全來自「DTO 只有該有的欄位」（白名單），
 * 而這個測試抓的是「有人往白名單裡加了不該加的」。
 *
 * <p>👉 也就是：<b>白名單防洩漏，黑名單防「白名單被改壞」。</b>
 */
@Test
void 客戶可見的DTO不含內部欄位名() {
    // ★ 這個清單來自 3.7.3 那張表的「客戶 = ❌」那幾列
    var forbidden = List.of(
            "internalNote", "riskScore", "costPrice", "margin",
            "gatewayResponse", "gatewayRawPayload",
            "passwordHash", "nationalId", "salt",
            "staffNote", "blacklistReason");

    var classes = new ClassFileImporter()
            .importPackages("example.shop..web.dto");

    var offenders = classes.stream()
            // ★★ 排除「明確標為內部」的 DTO —— 它們可以有這些欄位
            .filter(c -> !c.isAssignableTo(InternalOnlyDto.class))
            .filter(JavaClass::isRecord)
            .flatMap(c -> c.getFields().stream())
            .filter(f -> forbidden.stream()
                    .anyMatch(bad -> f.getName().equalsIgnoreCase(bad)))
            .map(f -> f.getOwner().getSimpleName() + "." + f.getName())
            .toList();

    assertThat(offenders)
            .as("""
                以下 DTO 含有內部欄位，但沒有實作 InternalOnlyDto：%s

                ★ 兩個處置：
                  ① 這個欄位不該對客戶公開 → 從 DTO 移除，另做一個 support DTO（3.7.1）
                  ② 這個 DTO 本來就只給內部看 → 讓它 implements InternalOnlyDto，
                     並確認它只在 order.web.support 套件的端點被回傳（3.7.2）
                """, offenders)
            .isEmpty();
}
```

### 3.8.6 為什麼還是需要幾個手寫的斷言

**掃描測試抓「結構」，手寫斷言抓「語意」。** 而語意的部分很少 ——
一個 31 欄位的 mapper 大約只有 **4～6 個**斷言真的有價值：

```java
class OrderWebMapperSemanticsTest {

    /** ★ 語意 1：金額的格式（不是「有沒有值」，是「格式對不對」）。 */
    @Test
    void 金額保留幣別的小數位() {
        var view = Views.detailView(b -> b.total(Money.twd("12800")));
        var dto = mapper.toDetail(view, Locale.TAIWAN);

        // ★★ "12800.00" 而不是 "12800" —— Money 的建構子做了 setScale（00 章 0.5.3）
        assertThat(dto.amounts().total()).isEqualTo("12800.00");
    }

    /** ★ 語意 2：日圓沒有小數位。⚠️ 這一個抓的是「有人自己 setScale(2)」。 */
    @Test
    void 日圓不加小數位() {
        var view = Views.detailView(b -> b.total(Money.of("12800", "JPY")));
        assertThat(mapper.toDetail(view, Locale.JAPAN).amounts().total())
                .isEqualTo("12800");
    }

    /** ★ 語意 3：狀態標籤走 i18n（不是 enum.name()）。 */
    @Test
    void 狀態標籤依Locale變化() {
        var view = Views.detailView(b -> b.status(OrderStatus.PENDING_PAYMENT));

        assertThat(mapper.toDetail(view, Locale.TAIWAN).statusLabel()).isEqualTo("待付款");
        assertThat(mapper.toDetail(view, Locale.US).statusLabel()).isEqualTo("Pending payment");
    }

    /** ★ 語意 4：空集合而不是 null（3.5.2）。 */
    @Test
    void 沒有明細時回空陣列() {
        var view = Views.detailView(b -> b.items(List.of()));
        assertThat(mapper.toDetail(view, Locale.TAIWAN).items())
                .isNotNull()
                .isEmpty();
    }

    /** ★ 語意 5：null 集合也回空陣列（防禦上游）。 */
    @Test
    void 明細為null時也回空陣列() {
        var view = Views.detailView(b -> b.items(null));
        assertThat(mapper.toDetail(view, Locale.TAIWAN).items()).isEmpty();
    }

    /** ★★ 語意 6：客服的 mapper 被客戶呼叫時要炸（3.7.2 防護 1）。 */
    @Test
    void 客服視角的mapper拒絕客戶的actor() {
        assertThatThrownBy(() -> mapper.toSupportDetail(
                        Views.fullyPopulatedSupportView(), Actors.customer("cus_1"),
                        Locale.TAIWAN))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("客服視角");
    }
}
```

**一個完整的 mapper 測試套件的組成**：

| 測試 | 數量 | 抓什麼 |
|---|---|---|
| `MappingCompleteness` | 每個 mapper 方法 1 個 | 漏映射（形狀 1） |
| 同名欄位對照 | 有「一對一子物件」時 1 個 | 位置對調（形狀 2） |
| 語意斷言 | 4～6 個 | 格式、i18n、null 政策、授權 |
| **全站掃描** | 3 個（3.8.4、3.8.5、`DtoSerializabilityTest`） | 型別政策、敏感欄位、序列化 |

⚠️ **對照 3.8.1 那個 31 行的版本**：
總行數差不多，但**每一行都有獨立的價值**，
而且新增欄位時只有「該紅的會紅」。

### 3.8.7 MapStruct 產生的程式碼要進版控嗎

**不要。** 但要知道三個具體的後果：

| 後果 | 處置 |
|---|---|
| CI 的第一次 build 一定要跑 annotation processor | ✅ `mvn test` 本來就會 |
| IDE 沒設好時「找不到 `OrderDtoMapperImpl`」 | ⚠️ 在 `README` 寫「先 `mvn compile` 一次」；IntelliJ 要開 Annotation Processing |
| **產生的程式碼不在 code review 裡** | 🔴 **這是真正的代價** —— 見下 |

⚠️ **第三個後果值得展開**：

```java
// 有人改了一個 @Mapping
@Mapping(target = "currency", source = "view.currency.currencyCode")
// 改成
@Mapping(target = "currency", constant = "TWD")        // 🔴 review 時看起來很無害
```

**產生的程式碼**：

```java
String currency = "TWD";                                // 🔴 事故 2 又回來了
```

**處置：一個「產生的程式碼裡不可有硬編碼幣別」的測試**：

```java
/**
 * ★ 掃描 MapStruct 產生的程式碼，找出可疑的 constant。
 *
 * <p>⚠️ 它讀 {@code target/generated-sources} 的原始碼 ——
 * 而那讓它依賴建置目錄的結構。<b>這是一個脆弱的測試</b>，
 * 但它守的東西（3.0 事故 2）值得。
 *
 * <p>👉 一個更穩固的替代：斷言 {@code @Mapping} 註解上沒有 {@code constant}。
 *    ★ shop-service 用這一個 —— 它讀註解而不是讀檔案。
 */
@Test
void mapper上不可使用constant() {
    var mappings = Arrays.stream(OrderDtoMapper.class.getDeclaredMethods())
            .flatMap(m -> Arrays.stream(m.getAnnotationsByType(Mapping.class)))
            .filter(m -> !m.constant().isEmpty())
            .map(m -> m.target() + " = \"" + m.constant() + "\"")
            .toList();

    assertThat(mappings)
            .as("""
                @Mapping(constant = ...) 把一個值硬編碼進 mapper。
                找到：%s
                ★ 如果真的需要常數，讓它來自來源物件或一個具名的常數類別 ——
                  硬編碼的幣別是 3.0 事故 2 的根因。
                """, mappings)
            .isEmpty();
}
```

### 3.8.8 一張「這個 bug 誰抓得到」的對照表

| bug | 編譯器 | `MappingCompleteness` | 同名對照 | 語意斷言 | 全站掃描 |
|---|---|---|---|---|---|
| 漏一個欄位（填 null） | ❌ | ✅ | ⚠️ | ❌ | ❌ |
| 漏一個欄位（MapStruct + `ERROR`） | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| 位置對調（同型別） | ❌ | ❌ | ✅ | ❌ | ❌ |
| 新增欄位沒改 mapper（record） | ✅ | ✅ | ❌ | ❌ | ❌ |
| 新增欄位沒改 mapper（builder） | ❌ | ✅ | ❌ | ❌ | ❌ |
| 金額用了 `BigDecimal` | ❌ | ❌ | ❌ | ⚠️ | ✅ |
| 金額漏了 `setScale` | ❌ | ❌ | ❌ | ✅ | ❌ |
| DTO 多了 `internalNote` | ❌ | ❌ | ❌ | ❌ | ✅ |
| 客服 mapper 被客戶呼叫 | ❌ | ❌ | ❌ | ✅ | ✅（ArchUnit） |
| 集合回 null 而不是 `[]` | ❌ | ⚠️ | ❌ | ✅ | ❌ |
| `statusLabel` 用了 ThreadLocal 的 locale | ❌ | ❌ | ❌ | ✅ | ✅（ArchUnit） |

⚠️ **看第三列（位置對調）**：只有一個測試抓得到它，
而那個測試需要「用欄位名當值」的特殊測資。
**這是這一章唯一一個「沒有便宜的自動化防護」的 bug** ——
所以它也是唯一一個真的需要 code review 注意的。

---

## 3.9 `LazyInitializationException` 的三種解法 ★

02 章 2.18 用這個例外當作 03 章的引子：

```java
var order = orderService.create(...);        // ← 這時候交易已經結束了
var body  = mapper.toCreateResponse(order);  // ← 存取 order.lines()
```

**這一節把它處理完** —— 而結論會回頭確認 3.3.3 的決定。

⚠️ **本站的 Repository 是記憶體假實作，所以這個例外在這一站不會出現。**
那正是 3.9.6 的主題：**假實作太寬鬆，讓一整類 bug 被推遲到 08 站。**

### 3.9.1 為什麼交易一結束就炸

```
① @Transactional 開始
     → Hibernate 開一個 Session（綁在 ThreadLocal，02 章 2.2.4）
② orders.findById("ord_1")
     → SELECT * FROM orders WHERE id = ?
     → 建出 Order 物件
     → ★ lines 欄位不是 List，是一個 PersistentBag（代理）
③ @Transactional 結束
     → commit
     → ★★ Session.close() —— 代理與 Session 的連結斷了
④ Jackson / mapper 存取 order.lines()
     → PersistentBag.iterator()
     → 「我需要去資料庫載入」→ 但 Session 已關
     → 🔴 LazyInitializationException
```

⚠️ **三個容易誤解的點**：

| 誤解 | 實際 |
|---|---|
| 「它是 JPA/Hibernate 的問題」 | ⚠️ 它是「**延遲載入**」這個機制的必然結果 —— MyBatis 的 lazy loading 一樣會 |
| 「交易結束時已經載入的東西也會失效」 | ❌ 已載入的欄位（`id`、`status`）完全正常 |
| 「加 `@Transactional` 到 Controller 就好」 | 🔴 那是 3.9.4 的 `open-in-view` 的變體 —— **它把交易撐到寫完 HTTP 回應** |

### 3.9.2 解法 1：在交易內就轉成 DTO ★★

```java
@Transactional
public OrderResultView create(CreateOrderCommand cmd) {
    // ...
    orders.save(order);
    return OrderResultView.from(order, cmd.actor(), now);   // ★★ 在交易內
}
```

**這就是 3.3.3 的策略 B，而它順便解決了這個問題。**

| 為什麼它有效 | |
|---|---|
| `OrderResultView.from` 在交易內執行 | Session 還活著 → 所有延遲載入都成功 |
| 回傳的 `OrderResultView` 是**純資料** | 沒有代理、沒有 Session 依賴 |
| Web 層拿到它時，交易已結束但無所謂 | 它只是一堆 `String` 與 `Money` |

⚠️ **但它有一個代價，而 3.3.3 沒有講**：

```java
public static OrderResultView from(Order order, Actor actor, Instant now) {
    return new OrderResultView(
            // ...
            order.totalItemQuantity(),      // ★ 這一行會觸發 lines 的載入
            // ...
    );
}
```

**「在交易內轉 DTO」把「載入哪些關聯」這個決定從「Jackson 序列化時」
搬到「mapper 執行時」—— 但它還是在載入。**

也就是：**它解決了「炸掉」，沒有解決「N+1」。**

```
SELECT * FROM orders WHERE id = ?                    -- ① 載入訂單
SELECT * FROM order_lines WHERE order_id = ?         -- ② from() 存取 lines
SELECT * FROM payments WHERE order_id = ?            -- ③ from() 存取 payments
SELECT * FROM shipments WHERE order_id = ?           -- ④ ...
```

**單筆時 4 次查詢可以接受。列表查詢時（20 筆）是 81 次** ——
而那正是 01 章 1.2.3 那個「61 次查詢 vs 1 次查詢」的問題。

👉 **所以策略 B 用在命令路徑（單筆），策略 C 用在查詢路徑（列表）** ——
3.3.4 那張表的分工不是隨意的。

### 3.9.3 解法 2：`JOIN FETCH` / `@EntityGraph`

```java
/**
 * ★ 一次查完訂單 + 明細 + 付款。
 *
 * <p>⚠️ 注意 {@code DISTINCT} 與 {@code Set} —— 兩個 JOIN FETCH 會產生笛卡兒積
 * （3 筆明細 × 2 筆付款 = 6 列），而 Hibernate 6 之後會自動去重，
 * 但<b>分頁會壞掉</b>（見下）。
 */
@Query("""
       SELECT o FROM Order o
         LEFT JOIN FETCH o.lines
         LEFT JOIN FETCH o.payments
        WHERE o.id = :id
       """)
Optional<Order> findByIdWithDetails(@Param("id") String id);
```

```java
// 或用 @EntityGraph（宣告式，比 JPQL 好維護）
@EntityGraph(attributePaths = {"lines", "payments"})
Optional<Order> findById(String id);
```

| 優點 | 缺點 |
|---|---|
| ✅ 一次查詢 | 🔴 **`JOIN FETCH` + 分頁 = 記憶體分頁** —— 見下 |
| ✅ 明確宣告「這個 use case 需要什麼」 | ⚠️ 每個 use case 需要的不同 → 多個 Repository 方法 |
| ✅ Domain 物件仍然完整（不變量可以檢查） | ⚠️ 兩個 `JOIN FETCH` 就有笛卡兒積 |

⚠️⚠️ **「`JOIN FETCH` + 分頁」是一個必須知道的陷阱**：

```java
@Query("SELECT o FROM Order o LEFT JOIN FETCH o.lines WHERE o.customerId = :cid")
Page<Order> findByCustomer(@Param("cid") String cid, Pageable pageable);
```

```
WARN org.hibernate.hql.internal.ast.QueryTranslatorImpl :
  HHH000104: firstResult/maxResults specified with collection fetch;
  applying in memory!
```

**Hibernate 把「全部」訂單撈進記憶體，然後在記憶體裡分頁。**
一個有 12,000 張訂單的客戶 → 一次載入 12,000 張訂單 + 全部明細。

**而它只是一個 WARN，不是錯誤。** 開發環境（3 筆測資）完全看不出來。

👉 **這是「策略 C（投影）在列表查詢上不可取代」的技術理由**，
不只是「效能比較好」。

### 3.9.4 解法 3：`spring.jpa.open-in-view` 為什麼要關掉 ★★

**Spring Boot 的預設值是 `true`。** 它做的事：

```
① DispatcherServlet 收到請求
② ★ OpenEntityManagerInViewInterceptor 開一個 EntityManager（Session）
③ Controller → Service（@Transactional 開始 → commit → 結束）
④ Controller 回傳 DTO / Entity
⑤ ★ Jackson 序列化 —— Session 還活著 → 延遲載入成功
⑥ ★ Interceptor 關閉 Session
```

**它「解決」了問題**：`LazyInitializationException` 不再發生。

⚠️ **而它製造了四個更大的問題**：

| # | 問題 | 具體 |
|---|---|---|
| 1 | **N+1 變成不可見** | 序列化時發的查詢不在任何 `@Transactional` 裡 → APM 的「交易」統計看不到它 |
| 2 | 🔴 **連線持有時間 = 整個請求** | 02 章 2.9.3 那條算式：交易長度 × 連線池 = TPS 上限。⚠️ 而 Boot 2.x 之後 Session 與連線是延遲綁定的，所以**只有真的發查詢時才拿連線** —— 這減輕了問題但沒有消除 |
| 3 | **序列化中途的例外無法處理** | 3.2.1 代價 4 那個「截斷的 JSON」 |
| 4 | 🔴🔴 **它讓「回傳 Entity」變得可行** | ★ **這是最嚴重的一個** —— 它移除了「必須寫 DTO」的技術壓力，於是 3.2 的六個代價全部回來 |

**第 4 點值得強調，因為它是一個「工具改變行為」的例子**：

> 📌 **`open-in-view = true` 的真正代價不是效能，是它讓一個壞設計變得沒有痛感。**
>
> 關掉它之後，「回傳 Entity」會在第一個延遲載入的欄位上炸掉 ——
> 而那個炸掉**就是設計回饋**。
>
> Spring Boot 的官方文件對這個預設值的說明是：
> *"…it can cause data to be loaded lazily outside a transaction,
> which may lead to performance problems. **Enabling it by default
> is a trade-off for convenience.**"*
> —— 也就是：**Spring 團隊自己知道它不對，但為了新手體驗保留了它。**

```yaml
spring:
  jpa:
    # ★★ 明確關掉。⚠️ 不設定的話 Boot 會印一行 WARN 提醒你「你沒有明確設定」
    open-in-view: false
```

⚠️ **關掉它之後，Boot 會停止印那行 WARN** ——
所以「沒有 WARN」不代表「你設好了」，也可能代表「你設成 true」。
**這是一個容易被誤讀的訊號。**

### 3.9.5 三者的決策表

| 情況 | 用哪個 | 為什麼 |
|---|---|---|
| **命令路徑（單筆寫入後回傳）** | **解法 1**（交易內轉 DTO） | ✅ 3.3.3 的策略 B。4 次查詢可接受 |
| **需要完整聚合來守不變量** | **解法 2**（`@EntityGraph`） | 必須載入 payments 才能檢查 I8 |
| **單筆查詢（22 個欄位）** | **策略 C**（投影） | 一次 JOIN 查完，不經過 Domain |
| **列表查詢** | **策略 C**（投影） | 🔴 `JOIN FETCH` + 分頁 = 記憶體分頁 |
| 匯出 41 萬筆 | **策略 C** + 串流（3.5.5） | |
| — | 🔴 **`open-in-view = true`** | ❌ **永不使用** |

**shop-service 的設定**：

```yaml
spring:
  jpa:
    open-in-view: false            # ★★ 3.9.4
    properties:
      hibernate:
        # ★ 讓「查詢次數異常」在測試就看得到（06/08 站會用）
        generate_statistics: true
        # ★★ 禁止在沒有交易的情況下發查詢 —— 它讓 3.9.4 的問題變成錯誤而不是效能問題
        transaction.coordinator_class: jdbc
```

⚠️ **另外一個守門人（08 站會完整展開，這裡先記下來）**：

```java
/**
 * ★★ 斷言「一個請求發了幾次查詢」。
 *
 * <p>它把 N+1 從「效能問題」變成「會紅燈的測試」。
 *
 * <p>⚠️ 而它需要一個「預期次數」的數字，而那個數字會隨實作改變 ——
 * 所以斷言要寫成「不超過 N」而不是「等於 N」，
 * 否則每次最佳化都要改測試。
 */
@Test
void 查詢訂單列表不超過3次SQL() {
    var stats = sessionFactory.getStatistics();
    stats.clear();

    orderQueryService.search(new OrderQuery(...), Actors.customer("cus_1"));

    assertThat(stats.getPrepareStatementCount())
            .as("查詢訂單列表發了 %d 次 SQL —— 可能有 N+1（3.9.3）",
                stats.getPrepareStatementCount())
            .isLessThanOrEqualTo(3);
}
```

### 3.9.6 本站的假實作為什麼看不到這個問題

`InMemoryOrderRepository`（01 章 1.9.4 ③）回的是一個完整的深拷貝 ——
**沒有代理、沒有延遲載入、沒有 Session。**

**於是這一整節的問題在本站全部不存在。**

⚠️ **而 01 章 1.9.4 已經預告了這件事**：

> **假實作的黃金原則：它應該比真的實作「更嚴格」，不是更寬鬆。**

**在「延遲載入」這一項上，記憶體假實作是寬鬆的** —— 而它沒有辦法不寬鬆
（模擬延遲載入需要一個代理機制，那等於重寫半個 Hibernate）。

**所以要做的是「明確寫下這個限制」**：

```java
/**
 * 記憶體版的訂單儲存。
 *
 * <p>⚠️⚠️ <b>已知的三個「比真實作寬鬆」之處</b>（01 章 1.9.4 ③ + 03 章 3.9.6）：
 * <ol>
 *   <li><b>不模擬交易</b> —— rollback 相關的測試必須用 Testcontainers。</li>
 *   <li><b>不模擬延遲載入</b> —— {@code LazyInitializationException} 與 N+1
 *       在這個實作上<b>永遠不會出現</b>（03 章 3.9）。</li>
 *   <li><b>不模擬「同一個交易內讀到自己的寫入」的細節</b> ——
 *       它的 {@code findById} 永遠看得到 {@code save} 的結果，
 *       而真的 JPA 有 flush 時機的問題。</li>
 * </ol>
 *
 * <p>👉 這三項意味著：<b>本站的測試全綠不代表換成 JDBC/JPA 之後會過。</b>
 * 08 站的第一件事就是把整套測試在真的資料庫上跑一遍，
 * 而那時候一定會有東西紅燈 —— <b>那是預期的，不是意外。</b>
 */
@Repository
@Profile("!jdbc")
public class InMemoryOrderRepository implements OrderRepository { ... }
```

> 📌 **這段 javadoc 的價值在於「它讓一個未來的紅燈變成預期」。**
> 沒有它，08 站的人會以為是自己改壞了什麼。

---

## 3.10 shop-service 的轉換總表

### 3.10.1 全部 mapper 清單

⚠️ **「欄位數」的算法先說清楚**，否則這張表不可比對：

> **頂層** = 目標 record 的直接 component 數。
> **含巢狀** = 再加上所有子 record 的 component 數。
>
> **判準用的是「含巢狀」** —— 因為 3.4.6 的問題是「漏一個欄位誰會告訴我」，
> 而巢狀的欄位一樣會漏。

| mapper | 位置 | 方向 | 頂層 / 含巢狀 | 做法 | 需要的依賴 |
|---|---|---|---|---|---|
| `OrderWebMapper.toCommand` | `order.web` | Request → Command | 7 / 13 | 手寫 | — |
| `OrderWebMapper.toUpdateCommand` | `order.web` | Request → Command | 5 / 9 | 手寫 | — |
| `OrderWebMapper.toCreateResponse` | `order.web` | View → Response | 9 / 11 | 手寫 | `StatusLabelResolver` |
| `OrderWebMapper.toCancelResponse` | `order.web` | View → Response | 8 / 14 | 手寫 | 同上 |
| **`OrderDtoMapper.toDetail`** | `order.web` | View → Response | **12 / 28** | **MapStruct** | `MoneyMapper`, `StatusLabelResolver` |
| **`OrderDtoMapper.toSupportDetail`** | `order.web.support` | View → Response | **18 / 31** | **MapStruct** | 同上 |
| `OrderSummaryMapper.toSummary` | `order.web` | View → Response | 7 / 7 | 手寫 | `StatusLabelResolver` |
| `OrderResultView.from` | `order.application.view` | Domain → View | 10 / 13 | **static 工廠** | — |
| `OrderDetailView.from` | `order.application.view` | Projection → View | 12 / 22 | **static 工廠** | — |
| `CancellationResultView.from` | `order.application.view` | Domain → View | 2 / 14 | static 工廠 | — |
| `OrderExportRow.from` | `order.application.view` | Projection → Row | 12 / 12 | **static 工廠** | — ★ 3.5.5 |
| `OrderSnapshotCodec` | `order.infrastructure` | Domain ↔ Snapshot | 23 / 41 | 手寫 | — |
| `JdbcOrderRowMapper` | `order.infrastructure` | ResultSet → Projection | 12 / 12 | 手寫 | — |

⚠️⚠️ **一個必須說清楚的落差**：
**3.4.1 與 3.8 的範例裡，`toDetail` / `toItems` / `toAddress` 是寫在 `OrderWebMapper` 裡的手寫版本**，
而這張表說 `toDetail` 用 MapStruct（在 `OrderDtoMapper`）。

**兩者不是矛盾，是章節的順序**：

| 節 | 那裡的 `toDetail` 是什麼 |
|---|---|
| 3.4.1 | ★ **手寫的完整版** —— 它存在的目的是「讓你看見手寫的真實成本」（8 個方法、38 個欄位） |
| 3.4.6 | 決定：22 個欄位 + 三層巢狀 → **改用 MapStruct** |
| **3.10.1（本表）** | ✅ **最終狀態** |

👉 **而 3.8 的測試對兩者都有效**，因為它們只看**結果**（產生出來的 DTO），
不管是誰產生的。
⚠️ 唯一要改的是測試裡的 mapper 型別：
`new OrderWebMapper(...)` → `Mappers.getMapper(OrderDtoMapper.class)`
（或從 Spring context 注入 —— MapStruct 的 `componentModel = SPRING` 讓它是一個 bean）。

> 📌 **這是「先看見痛，再給解法」的代價**：
> 中間狀態的程式碼會留在課文裡。
> 而把它明確標出來（這張表）比假裝它不存在好 ——
> **一份教材裡最容易出錯的地方，就是「章與章的接縫」**，
> 而 mapper 這一層剛好橫跨三章（00 章的聚合、01 章的 View、本章的 DTO）。

**四個做法各自的判準**（3.4.6 的濃縮）：

| 做法 | 什麼時候 |
|---|---|
| **static 工廠**（`X.from(...)`） | 不需要任何注入的依賴 |
| **手寫 `@Component`** | 需要注入，且欄位 < 15 或有條件邏輯 |
| **MapStruct** | 欄位 ≥ 15 且幾乎一對一 |
| **手寫（不是 bean）** | 需要存取 private 建構子（`OrderSnapshotCodec`） |

### 3.10.2 套件結構

```
order/
├── domain/
│   ├── Order.java                       ★ 聚合（00 章 0.9.2）
│   ├── OrderStatus.java                 ★ 狀態機
│   └── ...
├── application/
│   ├── OrderApplicationService.java     ★ 回 OrderResultView（3.3.3）
│   ├── OrderQueryService.java           ★ 回 XxxView（3.10.3 ②）
│   ├── view/                            ★★ 這一章新增的套件
│   │   ├── OrderResultView.java
│   │   ├── OrderDetailView.java
│   │   ├── OrderDetailForSupportView.java   implements InternalOnlyView
│   │   ├── OrderSummaryView.java
│   │   ├── CancellationResultView.java
│   │   ├── OrderExportRow.java
│   │   └── InternalOnlyView.java             ★ 標記介面（3.7.2）
│   └── port/
│       ├── OrderQueryRepository.java
│       └── OrderSummaryProjection.java   ★ 01 章 1.9.4 ①
├── web/
│   ├── OrderController.java
│   ├── OrderWebMapper.java               ★ 手寫
│   ├── OrderDtoMapper.java               ★ MapStruct（interface）
│   ├── dto/
│   │   ├── CreateOrderRequest.java
│   │   ├── UpdateOrderRequest.java        ★ JsonNullable（只在這一層）
│   │   ├── OrderDetail.java
│   │   └── ...
│   └── support/                           ★★ 客服端點（3.7.2）
│       ├── SupportOrderController.java    ★ 每個方法都要 @PreAuthorize
│       └── dto/OrderDetailForSupport.java  implements InternalOnlyDto
└── infrastructure/
    ├── InMemoryOrderRepository.java
    └── OrderSnapshotCodec.java

common/
├── money/Money.java
├── patch/Patch.java                       ★★ 這一章新增（3.6.3）
├── i18n/StatusLabelResolver.java
└── test/MappingCompleteness.java          ★★ 這一章新增（3.8.2）
```

⚠️ **`Patch` 放在 `common.patch` 而不是 `order.service.command`**，
理由是它會被每一個聚合的 PATCH 用到（訂單、商品、客戶）。

⚠️ **而 `common` 套件會膨脹**，這是一個真實的風險。
判準：**只有「三個以上的模組真的用到」才放 `common`**。
`Patch` 目前只有訂單用 —— **所以它應該先放 `order`，等第二個使用者出現再搬。**

👉 **shop-service 的決定：先放 `common.patch`**，
理由是「搬套件會動到 import，而我們確定商品的 PATCH 已經在 05 站的路線圖上」。
⚠️ **這是一個「預測未來」的決定，而預測會錯。** 記在 ADR 裡。

### 3.10.3 本章回頭修正前面的地方 ★★

沿用慣例：**後面的章節修正前面的，每一處標理由。**

**① `OrderApplicationService` 的回傳型別**

| 位置 | 原本 | 現在 | 理由 |
|---|---|---|---|
| 00 章 0.9.4、01 章 1.8.2、02 章多處 | `Order create(CreateOrderCommand)` | **`OrderResultView create(CreateOrderCommand)`** | 3.3.3：聚合不離開 Service 層 |
| 00 章 0.14.1 | `toCreateResponse(Order, Actor, Instant, Locale)` | **`toCreateResponse(OrderResultView, Locale)`** | 同上 |
| 04-controller 0.10.2 | `var order = orderService.create(cmd)` | `var view = orderService.create(cmd)` | 同上 |

⚠️ **影響範圍**：04-controller 的 70 條端點裡有 **9 條**回傳 `Order`，
以及約 **40 個**測試的 `when(orderService.create(any())).thenReturn(anOrder)`。

**這是這一章最大的一個修正，所以要說清楚它為什麼值得**：

| 買到什麼 | |
|---|---|
| Web 層不再依賴 `order.domain` | 3.3.5 的 ArchUnit 規則可以真的開啟 |
| `LazyInitializationException` 在 08 站不會出現 | 3.9.2 |
| `allowedActions` 的授權判斷回到 Service 層 | 3.3.3 —— **它現在可以在 Service 的測試裡被測** |
| mapper 變成純函式（只需要 `Locale`） | 3.3.3；順便讓 3.5.5 的串流匯出可以重用它 |

⚠️ **而代價要誠實列出**：

| 代價 | |
|---|---|
| 6 個新的 View 型別 | 3.10.1 那張表 |
| 40 個測試的 stub 要改 | ⚠️ **而它們的測資也要改** —— `Orders.pending()` 回 `Order`，現在要 `Views.resultView()` |
| **View 與 Response 有 80% 重疊** | 🔴 這是真的重複，而 3.3.2 那張表已承認它 |

**② `OrderQueryService` 的 `Locale` 參數** ★

3.3.5 那條 ArchUnit 規則會抓到 01 章 1.9.2：

```java
// 01 章 1.9.2（違規）
public PageResponse<OrderSummaryView> search(OrderQuery query, Actor actor, Locale locale)
```

**三個選項**：

| 選項 | 做法 | 代價 |
|---|---|---|
| **A** | 把 `Locale` 從簽章拿掉，`statusLabel` 由 Web 層算 | ⚠️ Web 層要知道「哪些欄位需要 label」 |
| **B** | 保留 `Locale`，把它從 ArchUnit 的黑名單移除 | 🔴 那條規則就沒意義了 |
| **C** | 用一個 application 層的抽象取代 `Locale` | ⚠️ 多一個型別，而它與 `Locale` 一對一 |

**shop-service 選 A。** 理由與具體做法：

```java
// ── application 層：View 不含 label ────────────────────
public record OrderSummaryView(
        String orderId,
        String orderNumber,
        OrderStatus status,          // ★ enum，不是 label
        Money total,
        Currency currency,
        int itemQuantity,
        Instant createdAt
) {}

// ── OrderQueryService：沒有 Locale ─────────────────────
@Transactional(readOnly = true)
public PageResponse<OrderSummaryView> search(OrderQuery query, Actor actor) {
    var page = orders.search(query, actor);
    return new PageResponse<>(
            page.getContent().stream().map(OrderSummaryView::from).toList(),
            PageResponse.PageInfo.offset(page.getNumber(), page.getSize(),
                                         page.getTotalElements()));
}

// ── Web 層：label 在這裡加上 ───────────────────────────
public OrderSummary toSummary(OrderSummaryView v, Locale locale) {
    return new OrderSummary(
            v.orderId(), v.orderNumber(), v.status(),
            statusLabels.label(v.status(), locale),      // ★ 只有這裡需要 Locale
            v.total().toPlainString(), v.currency().getCurrencyCode(),
            v.itemQuantity(), v.createdAt());
}
```

⚠️ **選項 A 的代價要處理**：「Web 層要知道哪些欄位需要 label」。

**處置**：讓它變成一個機械化的規則 + 一個掃描測試。

```java
/**
 * ★★ 規則：Web DTO 裡每一個 {@code LabeledEnum} 型別的欄位，
 * 都必須有一個對應的 {@code xxxLabel} 欄位。
 *
 * <p>它把「記得加 label」從人的責任變成 CI 的責任。
 *
 * <p>⚠️ 誤報來源：有些 enum 刻意不需要 label
 * （例如 {@code OrderAction} —— 前端自己有按鈕文字）。
 * 👉 處置：用一個 {@code @NoLabel} 註解明確排除，而不是維護一份清單。
 */
@Test
void web層DTO的每個LabeledEnum欄位都有對應的label欄位() {
    var classes = new ClassFileImporter().importPackages("example.shop..web.dto");
    var missing = new ArrayList<String>();

    for (JavaClass c : classes) {
        if (!c.isRecord()) continue;
        var names = c.getFields().stream().map(JavaField::getName)
                     .collect(java.util.stream.Collectors.toSet());
        for (JavaField f : c.getFields()) {
            if (!f.getRawType().isAssignableTo(LabeledEnum.class)) continue;
            if (f.isAnnotatedWith(NoLabel.class)) continue;
            if (!names.contains(f.getName() + "Label")) {
                missing.add("%s.%s 缺少 %sLabel".formatted(
                        c.getSimpleName(), f.getName(), f.getName()));
            }
        }
    }
    assertThat(missing)
            .as("""
                以下 DTO 有 enum 欄位但沒有對應的 label 欄位（3.10.3 ②）：%s
                ★ 兩個處置：① 加上 xxxLabel 欄位並在 mapper 呼叫 StatusLabelResolver；
                          ② 這個 enum 真的不需要 label → 標 @NoLabel 並註明理由
                """, missing)
            .isEmpty();
}
```

> 📌 **這是這一章第三次用到同一個手法**：
> 一個「需要人記得」的規則，換成一個「CI 會提醒」的掃描測試。
> 3.8.4、3.8.5、3.10.3 ② 是同一個模式的三個實例。

**③ `Order.clearInvoice()` 改名**

3.6.6 ④ 的發現：`InvoiceSpec` 有 `InvoiceType`，所以「清空發票」實際上是
「改成個人發票」。

| 原本 | 現在 |
|---|---|
| `Order.clearInvoice(Actor, Instant)` | **`Order.resetInvoiceToPersonal(Actor, Instant)`** |

**理由**：`clearInvoice` 這個名字暗示「發票資訊變成 null」，
而實際行為是「`invoice` 變成 `InvoiceSpec.personal()`」。
⚠️ **而 `null` 與 `personal()` 的差別在「開票時要不要送統編」上是決定性的。**

```java
/** ★ 個人發票（不開統編）。⚠️ 它不是 null —— 「沒有指定」與「明確選擇個人」不同 */
public static InvoiceSpec personal() {
    return new InvoiceSpec(InvoiceType.PERSONAL, null, null, null);
}
```

**④ `Cancellation.note` 拆成兩個欄位** ★

3.7.3 的發現：一個欄位的語意隨「誰填的」而變 → 遲早洩漏。

| 原本（00 章 0.12 ③） | 現在 |
|---|---|
| `Cancellation(Actor cancelledBy, CancelReason reason, String note, Instant at)` | **`Cancellation(Actor cancelledBy, CancelReason reason, String customerNote, String staffNote, Instant at)`** |

```java
/**
 * 取消資訊。
 *
 * <p>★★ {@code customerNote} 與 {@code staffNote} 刻意分開（03 章 3.7.3）。
 *
 * <p>⚠️ 原本是一個 {@code note} 欄位，而它的語意取決於 {@code by.type()} ——
 * 於是「這個 note 能不能給客戶看」變成每一個 mapper 都要判斷的事。
 * <b>而只要一個欄位的意思取決於誰在看，它就遲早會洩漏。</b>
 *
 * <p>👉 拆開之後：{@code customerNote} 對客戶可見，
 * {@code staffNote} 屬於 {@code internalNote} 的等級（3.8.5 的黑名單有它）。
 */
public record Cancellation(Actor cancelledBy, CancelReason reason,
                           String customerNote, String staffNote, Instant at) {

    /**
     * ★ 恰好一個 note 有值 —— 由 {@code Order.cancel()} 依 actor 決定填哪一個。
     *
     * <p>⚠️ 欄位名沿用 00 章 0.12 ③ 的 {@code cancelledBy}（不是 {@code by}）——
     * 它有 {@code Objects.requireNonNull} 的檢查，這裡一併保留。
     */
    public Cancellation {
        java.util.Objects.requireNonNull(cancelledBy, "cancelledBy");
        java.util.Objects.requireNonNull(reason, "reason");
        java.util.Objects.requireNonNull(at, "at");
        if (customerNote != null && staffNote != null) {
            throw new IllegalArgumentException(
                    "customerNote 與 staffNote 不可同時有值 —— 一次取消只有一個人填備註");
        }
    }
}
```

**`Order.cancel()` 跟著改**：

```java
// 00 章 0.9.2 的 cancel()，只改一行
this.cancellation = actor.isCustomer()
        ? new Cancellation(actor, reason, note, null, now)
        : new Cancellation(actor, reason, null, note, now);
```

⚠️ **影響**：3.8.5 的黑名單要加 `staffNote`（已經在上面的清單裡了）。

**⑤ 集合 accessor 的守門測試** ★

**這一項是這九處裡唯一「不是修正」的一項，而那正是它的重點。**

讀完 3.5.3 邊界 2，很容易推出下一步：

> 「`List.copyOf` 只做一層 → 所以 `Payment.refunds()` 也要 `List.copyOf`。」

**⚠️ 去看 00 章 0.12 ③ —— 它本來就是這樣寫的**：

```java
// 00 章 0.12 ③（原文）
public List<Refund> refunds() { return List.copyOf(refunds); }   // ★ 防禦性複製
```

**所以那個推論的結論是錯的。而錯在哪裡值得停下來看**：

| | |
|---|---|
| 「`List.copyOf` 只做一層」 | ✅ 正確 |
| 「所以某個地方漏了 `List.copyOf`」 | 🔴 **不成立** —— 每一層都寫了 |
| 真正的洞 | **`Payment` 有 `refund()` 這個 mutator**（3.5.3 邊界 2） |

> 📌 **這是一個值得記住的推理陷阱**：
> **從一條正確的規則出發，很容易「找到」一個不存在的違例** ——
> 因為你在找「符合這條規則的錯誤」，而不是在看程式碼實際長什麼樣。
>
> ⚠️ 而它的代價比「沒發現」更高：
> 你補上一個已經存在的保護，**然後以為洞補好了**，
> 而真正的洞（元素可變）一動也沒動。

👉 **所以這一項新增的只有一個守門測試**，而要**誠實說出它守得住什麼**：

| 它抓得到 | 它抓不到 |
|---|---|
| ✅ 新增一個回傳**可變集合**的 accessor | 🔴 **元素本身有 mutator** |

**守門測試**：

```java
/**
 * ★★ 聚合的所有集合 accessor 都回傳不可變集合。
 *
 * <p>它用反射掃過 {@code order.domain} 裡每一個回傳 {@code Collection} 的 public 方法，
 * 對每一個都試著 {@code add} 一次。
 *
 * <p>⚠️ 它抓的是 3.5.3 邊界 2：{@code List.copyOf} 只做一層，
 * 所以「新增一個含集合的子物件」時很容易漏。
 */
@Test
void domain的所有集合accessor都不可變() {
    Order order = Orders.fullyPopulated();
    var offenders = new ArrayList<String>();

    assertImmutableCollections(order, "Order", offenders);
    order.payments().forEach(p -> assertImmutableCollections(p, "Payment", offenders));
    order.shipments().forEach(s -> assertImmutableCollections(s, "Shipment", offenders));

    assertThat(offenders)
            .as("""
                以下 accessor 回傳了可變集合（3.5.3 邊界 2）：%s
                ★ 修法：回傳 List.copyOf(...) 而不是內部的 ArrayList
                """, offenders)
            .isEmpty();
}

private static void assertImmutableCollections(Object target, String label,
                                               List<String> offenders) {
    for (Method m : target.getClass().getDeclaredMethods()) {
        if (!Modifier.isPublic(m.getModifiers())) continue;
        if (m.getParameterCount() != 0) continue;
        if (!Collection.class.isAssignableFrom(m.getReturnType())) continue;
        try {
            @SuppressWarnings("unchecked")
            var c = (Collection<Object>) m.invoke(target);
            if (c == null) continue;
            c.add(null);                                    // ★ 應該拋 UnsupportedOperation
            offenders.add(label + "." + m.getName() + "()");
        } catch (InvocationTargetException e) {
            // ✅ UnsupportedOperationException 或 NullPointerException 都算通過
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

⚠️ **`c.add(null)` 那一行有一個陷阱**：`List.of()` 產生的不可變 list
對 `add(null)` 拋的是 `UnsupportedOperationException`，
**但 `List.copyOf` 產生的也一樣** —— 兩者都在檢查可變性之前就拒絕了。
✅ 所以這個測試是對的。
⚠️ 但如果某個 accessor 回的是 `new ArrayList<>(內部)`（拷貝但可變），
`add(null)` 會**成功** → 被抓到。**那正是我們要的**
（回傳可變的拷貝雖然不會影響聚合，但呼叫端的修改會靜默消失）。

**⑥ 新增的 ArchUnit 規則（共 5 條）**

| 規則 | 守什麼 | 節 |
|---|---|---|
| `web層的mapper不可依賴domain` | 3.3.3 的整個結論 | 3.3.3 |
| `application層不可認識展示層`（含 `Locale`） | 3.3.5 | 3.3.5 |
| `非support套件的Controller不可回傳InternalOnly的DTO` | 3.7.2 | 3.7.2 |
| `support套件的端點都要有授權標註` | 上一條的前提 | 3.7.2 |
| `含Masked欄位的DTO必須覆寫toString` | 3.7.4 | 3.7.4 |

**⑦ 新增的 `ErrorCode`（共 4 個）**

00 章 0.12 ⑮ 把 `ErrorCode` 從 83 個增為 93 個。**這一章再加 4 個，總數 97**：

| code | 例外 | 狀態碼 | 為什麼不重用既有的 |
|---|---|---|---|
| `ORDER_PATCH_EMPTY` | `EmptyPatchException` | 422 | ⚠️ Web 層的空 PATCH 用 `VALIDATION_FAILED`（有 `errors[]`），Service 層的沒有 → 兩者的 problem body 形狀不同（3.6.6 ①） |
| `ORDER_INTERNAL_FIELD_NOT_EDITABLE` | `InternalFieldNotEditableException` | 403 | ⚠️ 不用 `FORBIDDEN`（泛用）—— 客服需要知道「是哪個欄位」才能跟客戶解釋 |
| `ORDER_INVOICE_REQUEST_IN_FLIGHT` | `InvoiceRequestInFlightException` | 409 | 與 `ORDER_INVOICE_ALREADY_ISSUED` 不同：一個是「已開立」（終態），一個是「處理中」（**可重試**） |
| `ORDER_NOTE_TOO_LONG` | `NoteTooLongException` | 422 | ⚠️ Web 層的 `@TextLength` 已經擋了，這個 code 只會出現在第二個入口 → **但它必須存在**，否則會 fallthrough 成 500 |

⚠️ **最後一列是一個一般性的觀察**：

> 📌 **每一個「Domain 層的最後一道防線」都需要一個 `ErrorCode`**，
> 即使「正常情況下 Web 層已經擋掉了」。
> 沒有它，那條防線被觸發時會變成 500 ——
> 而 500 不會告訴呼叫端「你的輸入有問題」。
>
> **00 章 0.8.3「不變量可以守在四個位置」有一個沒說完的推論**：
> **每一個位置都需要它自己的錯誤表述。**

---

**⑧ `Order` 的四個欄位必須拿掉 `final`，並新增四個成員** 🔴

**這是這一章最容易被忽略、但會直接編譯失敗的一處。**

00 章 0.9.2 的 `Order` 把兩個「3.6 要修改」的欄位宣告成 `final`：

```java
// 00 章 0.9.2
private final InvoiceSpec invoice;
private final String customerNote;
```

⚠️ **於是 3.6.5 的 `changeCustomerNote()` 與 `changeInvoice()` 編譯不過**：

```
error: cannot assign a value to final variable customerNote
        this.customerNote = note;
             ^
```

| 欄位 | 00 章 | 現在 | 為什麼 00 章當時是對的 |
|---|---|---|---|
| `customerNote` | `final` | **非 `final`** | 00 章只實作了 `place` / `cancel` / `markPaid` / `ship`，**沒有任何操作會改備註** —— 而「能 `final` 就 `final`」是對的預設 |
| `invoice` | `final` | **非 `final`** | 同上 |

> 📌 **這不是 00 章的 bug，是「需求長出來」的正常結果。**
> 而它值得記下來的理由是：**`final` 是一個會被後續需求推翻的決定**，
> 而推翻它的時候，編譯器會告訴你 —— 那正是我們想要的方向
> （對照 3.4.2 形狀 3：新增欄位在 record 上是編譯錯誤，在 setter 上是靜默的）。

**同時要新增四個成員**（3.6.5 用到但 00～02 章都沒有）：

```java
public class Order {

    /** ★ 一則備註的長度上限。⚠️ 與 04-controller 2.12.4 的 {@code @TextLength(max = 200)} 是同一個數字 */
    public static final int MAX_NOTE_LENGTH = 200;

    // ── 3.6 新增 ──────────────────────────────────────
    private String internalNote;              // ★ 只有內部人員可讀寫（3.7.3）
    private Instant invoiceIssuedAt;          // ★ 已開立發票的時間；null = 未開立
    private boolean invoiceRequestSubmitted;  // ★ 已送出開票請求（財政部 API 是非同步的）

    public String internalNote()      { return internalNote; }
    public Instant invoiceIssuedAt()  { return invoiceIssuedAt; }
}
```

⚠️ **`internalNote` 的新增會連帶影響四個地方**，全部都有守門人：

| 影響 | 守門人 |
|---|---|
| `OrderSnapshotCodec` 要多拷貝三個欄位 | ✅ 01 章 1.9.4 ④ 的反射比對測試（**會紅燈**） |
| `Orders.fullyPopulated()` 要填這三個欄位 | ✅ 3.8.2 的「守門人的守門人」 |
| 客戶視角的 DTO 不可以有它 | ✅ 3.8.5 的黑名單掃描（`internalNote` 已在清單裡） |
| 稽核要遮蔽它 | ✅ 3.6.7 的 `REDACTED` 集合 |

> 📌 **這張表本身就是「為什麼要先寫守門測試」的最好論證**：
> 加一個欄位會讓**四個**已存在的測試紅燈，
> 而每一個紅燈都指向一件真的要做的事。

**⑨ `cancel()` 的回傳型別，以及三個「說了一半」的型別**

⚠️ **① 的修正表只列了 `create()`，而 `cancel()` 有同樣的問題**：

| 位置 | 原本 | 現在 |
|---|---|---|
| 00 章 0.9.4、01 章 1.2.2／1.5.3／1.8.4 | `CancellationResult cancel(CancelOrderCommand)` | **`CancellationResultView cancel(CancelOrderCommand)`** |

⚠️ **注意 `Order.cancel()`（Domain）不改** —— 它仍然回 `CancellationResult`。
**兩者是不同層的東西，而名字相近**，所以要說清楚：

| 型別 | 層 | 內容 | 誰產生 |
|---|---|---|---|
| `CancellationResult` | `order.domain.result` | 「取消的**後果**」：要不要退款、退多少、還哪些庫存 | `Order.cancel()`（00 章 0.12 ③） |
| **`CancellationResultView`** | `order.application.view` | 上面那些 + **訂單的新狀態**（給前端） | Application Service（3.3.4） |

```java
/**
 * ★ 它需要<b>兩個</b>輸入 —— 這是 3.10.1 那張表寫「Domain → View」時說得不夠精確的地方。
 */
public static CancellationResultView from(CancellationResult result, Order order,
                                          Actor actor, Instant now) {
    return new CancellationResultView(
            new CancellationInfo(
                    result.refundRequired(), result.refundAmount(),
                    result.releases().stream()
                          .map(r -> new StockReleaseInfo(r.productId(), r.quantity()))
                          .toList(),
                    order.cancellation().reason(),
                    order.cancellation().at()),
            OrderResultView.from(order, actor, now));
}
```

**另外兩個「只出現在表格裡、沒有給形狀」的型別**（3.3.4）：

| 型別 | 狀態 | 處置 |
|---|---|---|
| `PaymentResultView` | ⚠️ 只在 3.3.4 的表格出現 | 它包 00 章 0.9.2 的 `PaymentResult`（含 `alreadyProcessed` / `needsRefund` 三態）+ `OrderResultView`，形狀與 `CancellationResultView` 對稱 → **04-controller 站給完整定義**（它的三態直接對應三個 HTTP 回應） |
| `ShipmentResultView` | ⚠️ 同上 | 包 `Shipment` + `OrderResultView` |

> 📌 **誠實地標出「這個型別只有名字」比讓讀者自己發現好。**
> **「被 `new` 出來但沒有定義的型別」是這類跨層重構最常見的缺口**——
> 而這裡的兩個目前只在表格裡，還沒有被 `new` 出來，
> **所以現在標註它們的成本最低。**

## 3.11 常見誤區

**誤區 1：「加 `@JsonIgnore` 就不會洩漏了」**

3.2.2。它是**黑名單** —— 你必須「想到」每一個要藏的欄位。
而 3.2.1 代價 1 的重點正是「以後會加你現在想不到的欄位」。

👉 **判斷法**：問「下一個人加一個敏感欄位，會發生什麼？」
黑名單 → 洩漏。白名單 → 什麼都不發生。

---

**誤區 2：「用了 DTO 就安全了」**

3.4.3。**用 DTO + `BeanUtils.copyProperties` / `ModelMapper`
= 付了 DTO 的成本，但沒有得到它的安全性。**

因為反射式映射會把「同名的敏感欄位」自動複製過去 ——
`Order.internalNote` → `OrderDetail.internalNote`，一行程式碼都不用寫。

⚠️ 而 `BeanUtils.copyProperties` 對 **record 完全無效**（沒有 setter），
而且**不拋任何例外** —— 你會得到一個全 `null` 的 DTO。

---

**誤區 3：「`Stream.toList()` 等於 `Collectors.toUnmodifiableList()`」**

3.5.3 邊界 1。**不等於** —— 差別是 null 元素：
`Stream.toList()` **允許** null，`toUnmodifiableList()` 拋 NPE。

👉 而那個差別決定了「NPE 在哪裡爆」：
產生集合的那一行，還是下游某個 `List.copyOf`。

---

**誤區 4：「record 是不可變的」**

3.5.3 邊界 3。record 保證的是「**欄位的參考**不會變」，
不是「參考指向的東西不會變」。

```java
var items = new ArrayList<Item>();
var dto = new OrderDetail("ord_1", items);
items.add(x);                                 // 🔴 dto.items() 也變了
```

👉 **在 compact constructor 裡 `List.copyOf`**。

---

**誤區 5：「`List.copyOf` 與 `Collections.unmodifiableList` 差不多」**

3.5.3。前者是**拷貝**，後者是**檢視** —— 來源變了，檢視也變。
用錯的後果是「一個你以為不會變的東西變了」，而那類 bug 極難查。

---

**誤區 6：「`JsonNullable` 就是三態，帶到 Service 層就好」**

3.6.3 選項 ①。它有兩個問題：
① Application 層依賴一個序列化函式庫；
② **第二個入口（排程、CLI）被迫 import 它**。

⚠️ 而 04-controller 1.6.4 那個 builder 寫法有一個更嚴重的問題：
**「清空」這個操作完全消失了**（3.6.2）——
三態裡有兩態是對的，所以功能「看起來是好的」。

---

**誤區 7：「Domain 也應該有一個 `update(Patch)` 方法」**

3.6.5。`Patch` 是「HTTP PATCH 的語意」，不是領域概念（判準 7）。

而更實際的理由：**「清空」與「設定」的規則不同**
（`clearInvoice` 有三個守衛，`changeInvoice` 只有兩個）。
寫成一個方法會變成 `if (patch instanceof Clear)` ——
也就是把 HTTP 的三態判斷寫進 Domain。

---

**誤區 8：「三個 DTO 就保證不會洩漏了」**

3.7.1。**三個 DTO 保證「型別不同」，不保證「對的 DTO 用在對的地方」。**

而 3.7.2 需要**三種防護**：mapper 自己斷言（執行期）、
標記介面（讓掃描可行）、ArchUnit（CI）。
⚠️ 加上第四種：DTO 的欄位名黑名單（3.8.5）——
因為 ArchUnit 擋不到「有人往客戶的 DTO 裡加了 `internalNote`」。

---

**誤區 9：「`@Masked` 保證這個欄位不會外洩」**

3.7.4。它只影響**序列化**。
`log.info("{}", dto)` 會呼叫 record 的預設 `toString()` → **完整值進 log**。

👉 shop-service 的處置是「**含 `@Masked` 欄位的 DTO 必須覆寫 `toString()`**」
（一條 ArchUnit 規則），而不是「檢查每個 log 呼叫點」——
因為型別只有 8 個，呼叫點有幾百個。

---

**誤區 10：「mapper 的測試就是逐欄位斷言」**

3.8.1。31 行 `assertThat` 有四個問題，而最嚴重的是：
**寫測試的人會打開 mapper 對照著寫** —— 於是測試變成實作的複本。

👉 分成四種：`MappingCompleteness`（結構）、
同名欄位對照（位置對調）、4～6 個語意斷言、3 個全站掃描。

---

**誤區 11：「`spring.jpa.open-in-view` 只是效能問題」**

3.9.4。它最嚴重的後果是第 4 個：
**它讓「回傳 Entity」變得沒有痛感** —— 於是 3.2 的六個代價全部回來。

⚠️ 而關掉它之後 Boot 會停止印那行 WARN，
所以「沒有 WARN」不代表「你設對了」。

---

**誤區 12：「在交易內轉 DTO 就解決了 N+1」**

3.9.2。它解決了「**炸掉**」，沒有解決「**N+1**」——
`OrderResultView.from()` 存取 `lines` 時照樣發一次查詢。

👉 所以策略 B 用在命令路徑（單筆，4 次查詢可接受），
策略 C 用在查詢路徑（列表，必須一次查完）。

---

**誤區 13：「`JOIN FETCH` 加上分頁就能一次查完列表」**

3.9.3。Hibernate 會印 `HHH000104: ... applying in memory!` 並把**全部**資料
撈進記憶體再分頁。

⚠️ **而它只是一個 WARN。** 開發環境 3 筆測資完全看不出來。

---

**誤區 14：「這是內部管理後台，不需要 DTO」**

3.2.4。3.0 事故 1 的洩漏對象是「客服對客戶的評語」，
而它就在管理後台的 API 上 —— **而客戶用的是同一個端點**。

⚠️ 判準：**只要一個型別會被 Jackson 序列化，它就必須是「為此而存在」的型別。**

---

## 3.12 本章練習

### 練習 1：找出這個 mapper 的 12 個問題

```java
package example.shop.order.web;

import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Component;

@Component
public class OrderMapper {

    public OrderDetailDto toDto(Order order) {
        OrderDetailDto dto = new OrderDetailDto();
        BeanUtils.copyProperties(order, dto);
        dto.setStatusLabel(order.getStatus().label());
        dto.setItems(order.getLines().stream()
                .map(l -> {
                    ItemDto i = new ItemDto();
                    i.setProductId(l.getProductId());
                    i.setQuantity(l.getQuantity());
                    i.setPrice(l.getUnitPrice().getAmount());
                    i.setGifts(l.getGifts() == null ? null : l.getGifts().stream()
                            .map(g -> new GiftDto(g.getProductId(), g.getName(),
                                    g.getSource() == null ? null
                                            : new SourceDto(g.getSource().getType().name(),
                                                            g.getSource().getRefId())))
                            .collect(java.util.stream.Collectors.toList()));
                    return i;
                })
                .collect(java.util.stream.Collectors.toList()));
        dto.setAddress(order.getShippingSnapshot() == null
                ? new AddressDto("", "", "", "", "", "")
                : new AddressDto(order.getShippingSnapshot().getRecipientName(),
                                 order.getShippingSnapshot().getPhone(),
                                 order.getShippingSnapshot().getZipCode(),
                                 order.getShippingSnapshot().getDistrict(),
                                 order.getShippingSnapshot().getCity(),
                                 order.getShippingSnapshot().getStreet()));
        dto.setTotal(order.total().getAmount());
        return dto;
    }

    public Order fromRequest(CreateOrderRequest request) {
        Order order = new Order();
        BeanUtils.copyProperties(request, order);
        return order;
    }
}
```

<details>
<summary>答案（12 個問題）</summary>

| # | 問題 | 節 | 嚴重度 |
|---|---|---|---|
| 1 | **`BeanUtils.copyProperties(order, dto)`** —— 反射映射：改欄位名不會編譯錯、漏欄位沒人知道、**同名的 `internalNote` 會自動複製過去** | 3.4.3 | 🔴🔴 |
| 2 | **收 `Order`（Domain 物件）而不是 View** —— Web 層依賴 domain；而且交易已結束 → `order.getLines()` 可能拋 `LazyInitializationException` | 3.3.3 / 3.9 | 🔴 |
| 3 | **`order.getStatus().label()` 不存在** —— 00 章 0.14.1 已經指出：enum 上沒有 `label()`，要用 `StatusLabelResolver`（而它需要 `Locale`） | 00 章 0.14.1 | 🔴 編譯不過 |
| 4 | **DTO 是 class + setter** —— 新增欄位是靜默的（形狀 3）；而且 `BeanUtils` 需要 setter 才能運作，所以這個選擇不是偶然 | 3.4.2 | 🔴 |
| 5 | **三層 lambda 嵌套** —— 沒辦法單獨測 `SourceDto` 的轉換；null 檢查散在三處 | 3.5.1 | ⚠️ |
| 6 | **`gifts` 回 `null`** —— 回應方向的集合應該一律 `List.of()`，否則前端的 `?? []` 會掩蓋後端 bug | 3.5.2 | ⚠️ |
| 7 | 🔴🔴 **`AddressDto` 的 `district` 與 `city` 對調** —— 參數順序是 `(recipientName, phone, zipCode, city, district, street)`，而這裡傳 `district, city`（形狀 2） | 3.4.2 | 🔴🔴 |
| 8 | **地址為 null 時回一個空字串的物件** —— 把「資料錯誤」變成「顯示錯誤」；地址是必填（I2），應該讓它 NPE | 3.5.2 | ⚠️ |
| 9 | **金額用 `BigDecimal`**（`i.setPrice(...getAmount())`、`dto.setTotal(...)`）—— 應該 `toPlainString()`；3.8.4 的掃描測試會抓到 | 04-controller 6.5.7 | 🔴 |
| 10 | **`currency` 完全沒有映射** —— `Money.getAmount()` 只取金額，幣別掉了。**這就是 3.0 事故 2** | 3.0 | 🔴🔴 |
| 11 | 🔴🔴 **`fromRequest` 用 `BeanUtils` 建 Domain 物件** —— ① `Order` 的建構子是 private（`place()` 是唯一入口，00 章 0.9.2）→ `new Order()` 編譯不過；② 即使能過，它會**繞過全部不變量檢查**；③ 這是 mass assignment 的入口 | 3.2.1 代價 5 | 🔴🔴 |
| 12 | **`Collectors.toList()` 產生可變 list** —— DTO 的欄位應該不可變（3.5.3 邊界 3）。⚠️ 而這裡的問題不只是「可變」，是 DTO 沒有在建構時 copy | 3.5.3 | ⚠️ |

**額外的觀察**：這 12 個問題裡，**只有 2 個（#3、#11）是編譯錯誤**。
其他 10 個全部會編譯通過、執行不拋例外、而且逐欄位斷言的測試很可能綠燈。

</details>

---

### 練習 2：把這段「回傳 Entity」重構掉

**現況**：

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderRepository orders;

    /** 客戶查自己的訂單 */
    @GetMapping("/{orderId}")
    public Order get(@PathVariable String orderId, @CurrentActor Actor actor) {
        Order order = orders.findById(orderId).orElseThrow();
        if (!actor.isInternal() && !order.getCustomerId().equals(actor.id())) {
            throw new AccessDeniedException("not yours");
        }
        return order;
    }

    /** 客服查訂單（需要看到 internalNote 與 riskScore） */
    @GetMapping("/support/{orderId}")
    @PreAuthorize("hasRole('SUPPORT')")
    public Order getForSupport(@PathVariable String orderId) {
        return orders.findById(orderId).orElseThrow();
    }
}
```

**要求**：
1. 兩個端點都不回傳 Entity。
2. 客戶端點**不可能**看到 `internalNote` / `riskScore`（型別層級的保證）。
3. 授權判斷不在 Controller。
4. 寫出至少 3 個守門測試。

<details>
<summary>參考答案</summary>

**步驟 1：定義兩個 View（application 層）**

```java
package example.shop.order.application.view;

/** 客戶視角。⚠️ 它「沒有」internalNote 與 riskScore —— 那是型別層級的保證。 */
public record OrderDetailView(
        String orderId, String orderNumber, OrderStatus status,
        List<Item> items, Amounts amounts, Currency currency,
        Address shippingAddress, String couponCode,
        Cancellation cancellation,
        Instant createdAt, Instant shippedAt, Instant cancelledAt
) {
    public record Item(String productId, String productName, int quantity,
                       Money unitPrice, Money lineTotal, List<Gift> gifts) {}
    public record Amounts(Money subtotal, Money discount, Money shippingFee, Money total) {}
    public record Address(String recipientName, String phone, String zipCode,
                          String city, String district, String street) {}
    /** ★ 只有 customerNote —— staffNote 不在這個 View（3.10.3 ④、3.7.3） */
    public record Cancellation(CancelReason reason, ActorType cancelledByType,
                               String customerNote, Instant at) {}
    public record Gift(String productId, String productName, int quantity) {}
}

/** 客服視角。★ 標記介面讓 3.7.2 的 ArchUnit 規則抓得到它。 */
public record OrderDetailForSupportView(
        String orderId, String customerId, String customerName,
        String customerEmail, String customerPhone,
        OrderStatus status, Amounts amounts,
        String internalNote,              // ★ 客服專屬
        Integer riskScore,                // ★ 客服專屬
        String cancellationStaffNote,     // ★ 客服專屬（3.10.3 ④）
        Instant createdAt
) implements InternalOnlyView {
    public record Amounts(Money subtotal, Money discount, Money shippingFee, Money total) {}
}
```

**步驟 2：授權進 Query Service（要求 3）**

```java
@Service
@Transactional(readOnly = true)
public class OrderQueryService {

    private final OrderQueryRepository orders;

    /**
     * ⚠️ 授權是<b>查詢條件</b>而不是事後過濾（01 章 1.9.2）。
     *
     * @throws ResourceNotFoundException 不存在<b>或</b>此 actor 看不到（★ 刻意合併，01 章 1.8.3）
     */
    public OrderDetailView findById(String orderId, Actor actor) {
        return orders.findDetail(orderId, actor)          // ★ actor 進 WHERE
                .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));
    }

    /**
     * ★ 客服視角。⚠️ 它<b>不收</b> actor 做過濾（客服看得到所有訂單），
     * 但它有一個 {@code isPrivileged()} 的斷言 + 稽核（3.7.5）。
     */
    public OrderDetailForSupportView findDetailForSupport(String orderId, Actor actor) {
        if (!actor.isPrivileged()) {
            // ★ 走到這裡代表端點的 @PreAuthorize 漏了 → 500 而不是 403（3.7.2）
            throw new IllegalStateException(
                    "非內部人員存取客服視角：actor=%s orderId=%s".formatted(actor.id(), orderId));
        }
        var view = orders.findDetailForSupport(orderId)
                .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));
        accessAudit.recordAsync(SensitiveDataAccess.of(actor, "Order", orderId,
                                                       sensitiveFields.sensitiveFieldsOf(
                                                               OrderDetailForSupportView.class),
                                                       clock.instant()));
        return view;
    }
}
```

**步驟 3：兩個 Controller，兩個套件**

```java
package example.shop.order.web;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderQueryService queries;
    private final OrderDtoMapper mapper;

    @GetMapping("/{orderId}")
    public OrderDetail get(@PathVariable String orderId,
                           @CurrentActor Actor actor, Locale locale) {
        // ★ Controller 只做三件事：取參數、呼叫、轉 DTO（04-controller 0.6）
        return mapper.toDetail(queries.findById(orderId, actor), locale);
    }
}
```

```java
package example.shop.order.web.support;         // ★★ 獨立套件（3.7.2）

@RestController
@RequestMapping("/api/support/orders")
public class SupportOrderController {

    @GetMapping("/{orderId}")
    @PreAuthorize("hasRole('SUPPORT')")          // ★ ArchUnit 在守這個標註
    public OrderDetailForSupport get(@PathVariable String orderId,
                                     @CurrentActor Actor actor, Locale locale) {
        return mapper.toSupportDetail(queries.findDetailForSupport(orderId, actor),
                                      actor, locale);
    }
}
```

⚠️ **注意路徑從 `/api/orders/support/{id}` 改成 `/api/support/orders/{id}`。**
原本的路徑有一個真實的 bug：`/api/orders/support` 會被
`@GetMapping("/{orderId}")` 匹配到（`orderId = "support"`）——
04-controller 1.4.3 的「路徑優先序」講過這件事，
而 Spring 的 `PathPattern` 會選更具體的那一個，所以它「剛好正確」。
**但那是運氣，不是設計。**

**步驟 4：四個守門測試**

```java
/** ★ 1：型別層級 —— 客戶的 DTO 沒有敏感欄位（3.8.5） */
@Test
void 客戶視角的DTO沒有內部欄位() {
    var names = Arrays.stream(OrderDetail.class.getRecordComponents())
                      .map(RecordComponent::getName).toList();
    assertThat(names).doesNotContain("internalNote", "riskScore",
                                     "cancellationStaffNote", "customerEmail");
}

/** ★ 2：ArchUnit —— 非 support 套件不可回傳 InternalOnly（3.7.2） */
@ArchTest
static final ArchRule 非support套件不可回傳內部視角 =
        noMethods().that().areDeclaredInClassesThat().resideInAPackage("..order.web..")
                   .and().areDeclaredInClassesThat()
                   .resideOutsideOfPackage("..order.web.support..")
                   .should().haveRawReturnType(assignableTo(InternalOnlyView.class))
                   .orShould().haveRawReturnType(assignableTo(InternalOnlyDto.class));

/** ★ 3：ArchUnit —— support 套件的端點都有授權標註（3.7.2 的前提） */
@ArchTest
static final ArchRule support端點都要授權 =
        methods().that().areDeclaredInClassesThat()
                 .resideInAPackage("..order.web.support..")
                 .and().areAnnotatedWith(RequestMapping.class)
                 .or().areAnnotatedWith(GetMapping.class)
                 .should().beAnnotatedWith(PreAuthorize.class);

/** ★ 4：執行期 —— 客戶的 actor 呼叫客服的查詢時要炸（3.7.2 防護 1） */
@Test
void 客戶的actor無法取得客服視角() {
    assertThatThrownBy(() -> queries.findDetailForSupport("ord_1", Actors.customer("cus_1")))
            .isInstanceOf(IllegalStateException.class);
}

/** ★ 5（加分）：IDOR —— 客戶查別人的訂單回 404 而不是 403（01 章 1.8.3） */
@Test
void 客戶查別人的訂單回404() {
    assertThatThrownBy(() -> queries.findById("ord_belongs_to_someone_else",
                                              Actors.customer("cus_1")))
            .isInstanceOf(ResourceNotFoundException.class);
}
```

⚠️ **測試 5 的「404 而不是 403」是一個刻意的決定**（01 章 1.8.3）：
403 會洩漏「這張訂單存在」，而那讓攻擊者可以枚舉訂單編號。

</details>

---

### 練習 3：實作 `Patch<T>` 的完整路徑

**要求**：實作 `PATCH /products/{productId}`，可修改 `name`、`price`、`description`。

| 欄位 | 三態語意 | 特殊規則 |
|---|---|---|
| `name` | 不改 / **不可清空** / 設定 | ⚠️ 商品名必填 —— 送 `null` 要回 422 |
| `price` | 不改 / **不可清空** / 設定 | 只有 `ADMIN` 可改（⚠️ 為什麼不是 `PRODUCT_MANAGER` 見答案） |
| `description` | 不改 / 清空 / 設定 | — |

**寫出**：① Request DTO；② Command；③ mapper；④ Application Service；
⑤ Domain 方法；⑥ 4 個測試（含「客戶試圖清空 `name`」與「一般使用者試圖改價」）。

<details>
<summary>參考答案</summary>

**① Request DTO**

```java
package example.shop.product.web.dto;

/**
 * ⚠️ 注意 {@code name} 與 {@code price} 的驗證：
 * {@code JsonNullable<@NotNull String>} 讓「送了 null」在 <b>Web 層</b>就被擋掉
 * （422 + 欄位定位），而不用等到 Service。
 *
 * <p>★ 這是 00 章 0.8.3「不變量守在四個位置」的第一個位置 ——
 * 而 Domain 層仍然要有第二道（判準 5：第二個入口）。
 */
public record UpdateProductRequest(
    JsonNullable<@NotNull @TextLength(max = 200) String> name,
    JsonNullable<@NotNull @DecimalMin("0.00") @Digits(integer = 10, fraction = 2)
                 BigDecimal> price,
    JsonNullable<@TextLength(max = 2000) String> description
) {
    public UpdateProductRequest {
        name        = orUndefined(name);
        price       = orUndefined(price);
        description = orUndefined(description);
    }

    @AssertTrue(message = "{example.shop.validation.product.atLeastOneField}")
    public boolean isAtLeastOneFieldPresent() {
        return name.isPresent() || price.isPresent() || description.isPresent();
    }

    private static <T> JsonNullable<T> orUndefined(JsonNullable<T> v) {
        return v == null ? JsonNullable.undefined() : v;
    }
}
```

⚠️ **`JsonNullable<@NotNull String>` 的語意值得確認**：
04-controller 2.6.2 說明過 —— 約束在**容器元素**上，
所以 `undefined()` 不驗證、`of(null)` 會**驗證失敗**。
✅ 正好是我們要的「不可清空」。

**② Command**

```java
package example.shop.product.service.command;

/**
 * ★ 注意 {@code name} 與 {@code price} 用的是 {@code Optional} 而不是 {@code Patch} ——
 * 因為它們<b>只有兩態</b>（不改 / 設定），沒有「清空」。
 *
 * <p>⚠️ 這與 3.6.6 ④ 那個「shop-service 讓 invoice 用 Patch 求一致性」的決定相反。
 * 差別在於：那裡三個欄位有兩個需要三態；<b>這裡三個欄位有兩個只需要兩態</b>，
 * 而「多數決」讓不一致的成本降低了。
 *
 * <p>👉 更重要的是：<b>用 Optional 讓「不可清空」變成型別層級的事實。</b>
 * 用 {@code Patch} 的話，「客戶送了 null」會走到 {@code apply()} 的 onClear 分支，
 * 而那個分支只能拋例外 —— 也就是用執行期檢查取代型別。
 */
public record UpdateProductCommand(
        String productId,
        Actor actor,
        Optional<String> name,
        Optional<Money> price,
        Patch<String> description        // ★ 只有這一個需要三態
) {
    public UpdateProductCommand {
        Objects.requireNonNull(productId, "productId");
        Objects.requireNonNull(actor, "actor");
        name        = name == null ? Optional.empty() : name;
        price       = price == null ? Optional.empty() : price;
        description = description == null ? Patch.unchanged() : description;
    }

    public boolean isEmpty() {
        return name.isEmpty() && price.isEmpty() && !description.isMentioned();
    }

    /** ★ 只有 ADMIN 可改價（要求表的第二列；為什麼不是 PRODUCT_MANAGER 見 Service 的註解）。 */
    public boolean touchesPrice() { return price.isPresent(); }
}
```

**③ mapper**

```java
public UpdateProductCommand toUpdateCommand(String productId, UpdateProductRequest req,
                                            Actor actor, Currency currency) {
    return new UpdateProductCommand(
            productId,
            actor,
            // ★ @NotNull 已在 Web 層擋掉 of(null)，所以這裡 get() 一定非 null
            toOptional(req.name()),
            toOptional(req.price()).map(amount -> new Money(amount, currency)),
            toPatch(req.description()));
}

/** ★ 兩態：只在「有值」時回 Optional.of。⚠️ 送了 null 時回 empty —— 但那已被 @NotNull 擋掉 */
private static <T> Optional<T> toOptional(JsonNullable<T> v) {
    return v.isPresent() ? Optional.ofNullable(v.get()) : Optional.empty();
}

private static <T> Patch<T> toPatch(JsonNullable<T> v) {
    return Patch.of(v.isPresent(), v.isPresent() ? v.get() : null);
}
```

⚠️ **`currency` 那個參數是一個真實的設計問題**：
`BigDecimal` → `Money` 需要幣別，而 Request 沒有帶它。
**兩個選項**：
① 從商品現有的幣別取（**要先查商品** → mapper 不可以查資料庫）；
② 從一個站台層級的設定取（`@ConfigurationProperties`）。
👉 **這裡用 ②**，並在 Domain 層檢查「新價格的幣別與商品的幣別一致」。

**④ Application Service**

```java
@Transactional
public ProductResultView update(UpdateProductCommand cmd) {
    if (cmd.isEmpty()) {
        throw new EmptyPatchException(cmd.productId());
    }
    // ★★ 欄位級權限 —— 在載入之前（3.6.6 ③）
    // ⚠️ 04-controller 4.13.6 的 Actor 是 record Actor(ActorType, String id, String displayName)
    //    —— 它【沒有】hasRole()，也沒有 Role enum。而 ActorType 只有
    //    ANONYMOUS / CUSTOMER / SUPPORT / WAREHOUSE / ADMIN / SYSTEM。
    // 👉 所以「商品管理員」目前只能用 ADMIN 表達（3.10.3 ⑨ 記了這個缺口）
    if (cmd.touchesPrice() && cmd.actor().type() != ActorType.ADMIN) {
        throw new PriceNotEditableException(cmd.productId(), cmd.actor().type());
    }

    Instant now = clock.instant();
    Product product = products.findById(cmd.productId())
            .orElseThrow(() -> new ResourceNotFoundException("Product", cmd.productId()));
    var before = snapshots.snapshot(product);

    // ★ 兩態：只有 ifPresent
    cmd.name().ifPresent(n -> product.rename(n, cmd.actor(), now));
    cmd.price().ifPresent(p -> product.changePrice(p, cmd.actor(), now));
    // ★★ 三態：apply 強迫你同時處理設定與清空
    cmd.description().apply(
            d  -> product.changeDescription(d, cmd.actor(), now),
            () -> product.clearDescription(cmd.actor(), now));

    products.save(product);
    auditLog.record(toAuditEntry(cmd, before, product, now));
    return ProductResultView.from(product);
}
```

**⑤ Domain 方法**

```java
public class Product {

    /** @throws ProductNameBlankException 名稱為空白 —— ⚠️ Web 層的 @NotNull 擋不到 "   " */
    public void rename(String name, Actor actor, Instant now) {
        requireEditableBy(actor);
        if (name == null || name.isBlank()) {
            throw new ProductNameBlankException(id);
        }
        this.name = name.strip();          // ★ 正規化屬於 Domain
        this.updatedAt = now;
    }

    /**
     * @throws CurrencyMismatchException 新價格的幣別與商品的幣別不同
     * @throws PriceChangeTooLargeException ⚠️ 一次調價超過 50% 需要另一個流程（風控）
     */
    public void changePrice(Money newPrice, Actor actor, Instant now) {
        requireEditableBy(actor);
        if (!newPrice.currency().equals(price.currency())) {
            throw new CurrencyMismatchException(id, price.currency(), newPrice.currency());
        }
        if (isTooLargeChange(newPrice)) {
            throw new PriceChangeTooLargeException(id, price, newPrice);
        }
        this.price = newPrice;
        this.updatedAt = now;
    }

    public void changeDescription(String description, Actor actor, Instant now) {
        requireEditableBy(actor);
        this.description = description;
        this.updatedAt = now;
    }

    /** ★ 清空。⚠️ 它沒有長度檢查 —— 那正是「兩個方法」的價值（3.6.5） */
    public void clearDescription(Actor actor, Instant now) {
        requireEditableBy(actor);
        this.description = null;
        this.updatedAt = now;
    }
}
```

**⑥ 四個測試**

```java
/** ★ 1：三態的「清空」真的清空了 —— 3.6.2 那個 bug 的守門測試 */
@Test
void 送出description為null時清空欄位() {
    var cmd = new UpdateProductCommand("p_1", Actors.admin(),
                                       Optional.empty(), Optional.empty(),
                                       Patch.clear());
    service.update(cmd);
    assertThat(products.findById("p_1").orElseThrow().description()).isNull();
}

/** ★ 2：三態的「不改」真的沒改 */
@Test
void 沒送description時不改動它() {
    products.save(Products.withDescription("原本的描述"));
    var cmd = new UpdateProductCommand("p_1", Actors.admin(),
                                       Optional.of("新名字"), Optional.empty(),
                                       Patch.unchanged());        // ★
    service.update(cmd);
    var after = products.findById("p_1").orElseThrow();
    assertThat(after.name()).isEqualTo("新名字");
    assertThat(after.description()).isEqualTo("原本的描述");        // ★★ 沒被清掉
}

/** ★★ 3：客戶試圖清空 name —— Web 層擋 */
@Test
void 送出name為null時回422() throws Exception {
    mvc.perform(patch("/api/products/p_1").contentType(APPLICATION_JSON)
                    .content("""
                             {"name": null}
                             """))
       .andExpect(status().isUnprocessableEntity())
       // ★ 04-controller 3.5.2 的 errors[] 形狀 —— 要能定位到欄位
       .andExpect(jsonPath("$.errors[0].field").value("name"));
}

/** ★★ 4：一般使用者試圖改價 —— 而且要在「載入商品之前」被擋（3.6.6 ③） */
@Test
void 非商品管理員無法改價且不會查詢商品() {
    var cmd = new UpdateProductCommand("p_1", Actors.support(),
                                       Optional.empty(), Optional.of(Money.twd("1")),
                                       Patch.unchanged());

    assertThatThrownBy(() -> service.update(cmd))
            .isInstanceOf(PriceNotEditableException.class);

    // ★★ 這一條斷言是重點：權限檢查發生在查詢之前
    //    否則「試圖改價」可以被用來探測商品是否存在
    verifyNoInteractions(products);
}

/** ★ 5（加分）：清空一個你不能改的欄位 —— isMentioned() 對 Clear 也要是 true */
@Test
void 非商品管理員也無法清空價格相關欄位() {
    // ⚠️ 這個測試針對的是 Patch.isMentioned() 的實作：
    //    如果它寫成 `this instanceof Set`，這個測試會失敗（3.6.6 ③）
    assertThat(Patch.clear().isMentioned()).isTrue();
    assertThat(Patch.unchanged().isMentioned()).isFalse();
    assertThat(Patch.set("x").isMentioned()).isTrue();
}
```

</details>

---

### 練習 4：寫三個掃描測試

**要求**：為以下三個規則各寫一個掃描測試（不是逐一斷言）。

| # | 規則 |
|---|---|
| A | 所有 `web.dto` 套件的型別都必須是 `record` |
| B | 所有 `application.view` 套件的型別都不可依賴 Jackson、Spring Web、`Locale` |
| C | 所有 `Instant` 型別的 DTO 欄位，名稱必須以 `At` 結尾（`createdAt`、`shippedAt`） |

<details>
<summary>參考答案</summary>

```java
/**
 * ★ A：DTO 一律用 record。
 *
 * <p>理由（3.4.2 形狀 3）：class + setter 讓「新增欄位」變成靜默的 bug，
 * record 讓它變成編譯錯誤。
 *
 * <p>⚠️ 三種必要的例外，而每一種都要能「用一句話描述」（3.3.3 的判準）：
 * <ul>
 *   <li>巢狀 record 的外層容器（{@code OrderViews} 這種只有 interface 的類別）</li>
 *   <li>enum（它們是值，不是資料載體）</li>
 *   <li>{@code package-info} 與 MapStruct 產生的 {@code XxxImpl}</li>
 * </ul>
 */
@ArchTest
static final ArchRule web層的DTO一律是record =
        classes().that().resideInAPackage("..web.dto..")
                 .and().areTopLevelClasses()
                 .and().doNotHaveModifier(JavaModifier.ABSTRACT)
                 .and(are(not(assignableTo(Enum.class))))
                 .and().areNotAnnotatedWith(javax.annotation.processing.Generated.class)
                 .should().beRecords()
                 .because("class + setter 讓新增欄位變成靜默的 bug（3.4.2 形狀 3）");

/**
 * ★★ B：View 不可認識展示層。
 *
 * <p>⚠️ {@code java.util.Locale} 那一項是這條規則最有價值的部分 ——
 * 它抓到了 01 章 1.9.2 的 {@code search(query, actor, locale)}（3.10.3 ②）。
 */
@ArchTest
static final ArchRule application層的View不認識展示層 =
        noClasses().that().resideInAPackage("..application.view..")
                   .should().dependOnClassesThat().resideInAnyPackage(
                           "com.fasterxml.jackson..",
                           "org.springframework.http..",
                           "org.springframework.web..",
                           "jakarta.servlet..")
                   .orShould().dependOnClassesThat().haveFullyQualifiedName(
                           "java.util.Locale")
                   .because("展示層的概念不屬於 use case（3.3.5）");

/**
 * ★ C：時間欄位的命名約定。
 *
 * <p>它看起來只是「風格」，但它有一個實質作用：
 * <b>讓「這個欄位是時間」在讀 JSON 時一目了然</b> ——
 * 而那讓前端不需要查文件就知道要用 {@code new Date(...)} 解析。
 *
 * <p>⚠️ 兩個例外：{@code paymentDueAt} ✅ 符合；
 * 而 {@code expiresAt} ✅ 也符合 —— 所以目前沒有例外。
 * <b>「目前沒有例外」是加這條規則的最好時機</b>（3.13 的驗收清單有這一點）。
 */
@Test
void DTO的時間欄位都以At結尾() {
    var classes = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
            .importPackages("example.shop..web.dto", "example.shop..application.view");

    var offenders = classes.stream()
            .filter(JavaClass::isRecord)
            .flatMap(c -> c.getFields().stream())
            .filter(f -> f.getRawType().isAssignableTo(java.time.Instant.class)
                      || f.getRawType().isAssignableTo(java.time.OffsetDateTime.class))
            .filter(f -> !f.getName().endsWith("At"))
            .map(f -> f.getOwner().getSimpleName() + "." + f.getName()
                      + " : " + f.getRawType().getSimpleName())
            .toList();

    assertThat(offenders)
            .as("""
                以下時間欄位沒有以 At 結尾：%s
                ★ 命名約定讓「這個欄位是時間」在 JSON 上一目了然。
                ⚠️ 如果是「日期」而不是「時間點」，請用 LocalDate 並以 Date 結尾。
                """, offenders)
            .isEmpty();
}
```

⚠️ **測試 C 揭露了一個真實的設計問題**，而它比命名重要：

```java
// 這兩個欄位的型別應該一樣嗎？
Instant createdAt;        // 時間點（有時區意義）
LocalDate deliveryDate;   // 日期（「8 月 30 日到貨」與時區無關）
```

**04-controller 6.5.5 決定了「一律用 `Instant` + ISO-8601 UTC」** ——
⚠️ **而那個決定對「預計到貨日」是錯的**：
`2026-08-30T00:00:00Z` 在台灣是 8 月 30 日早上 8 點，
**但在夏威夷是 8 月 29 日下午 2 點** —— 前端顯示成 8/29。

👉 **這是 06 站（時間處理）的主題，這裡先記下來。**
測試 C 的最後一句 javadoc 就是這個問題的入口。

</details>

---

## 3.13 驗收清單

**為什麼要 DTO**

- [ ] 不回傳 Entity 的**六個代價**，各自舉一個重現方式？
- [ ] 「回傳 Entity 時要人工檢查幾個欄位」的正確算法是什麼？
- [ ] `@JsonIgnore` 為什麼是錯的方向？黑名單與白名單「失敗的方向」差在哪？
- [ ] mass assignment 為什麼比洩漏嚴重？`fail-on-unknown-properties: true` 為什麼擋不住它？
- [ ] `@JsonProperty(access = READ_ONLY)` 與 `@JsonIgnore` 的差別？
- [ ] 「這是內部後台」為什麼不是有效的例外？

**三種策略**

- [ ] 策略 A / B / C 各自的形狀，以及「Web 層需不需要認識 Domain」的答案？
- [ ] 00 章 0.14.1 那三個參數（`actor`、`now`、`locale`）的性質哪裡不同？
- [ ] **為什麼 `actor` 出現在 mapper 上是一個訊號？** 它導致的第四個後果是什麼？
- [ ] `OrderResultView` 與 `CreateOrderResponse` 的**關鍵差別**是什麼（如果沒有那個差別，多一個型別就不值得）？
- [ ] shop-service 為什麼「策略 A 完全不用」？
- [ ] 命令端點該不該回傳查詢的形狀？`CancellationResultView` 為什麼含 `OrderResultView` 而不是 `OrderDetailView`？
- [ ] `OrderStatus` 這個 enum 出現在 Web DTO 裡，三個選項各自的代價？
- [ ] `ignoreDependency` 什麼時候是「真的例外」、什麼時候是「把警報關掉」？

**手寫 vs MapStruct**

- [ ] 「漏映射一個欄位」的**三種形狀**？哪一種連掃描測試都抓不到？
- [ ] 為什麼 record 擋住形狀 3 但擋不住形狀 1 與 2？Lombok `@Builder` 為什麼抵銷了 record 的好處？
- [ ] `BeanUtils.copyProperties` 對 record 的行為是什麼？
- [ ] **「用了 DTO 但用反射映射」為什麼是最糟的組合？**
- [ ] `unmappedTargetPolicy = ERROR` 為什麼是用 MapStruct 的唯一理由？
- [ ] `lombok-mapstruct-binding` 缺了會出現什麼錯誤訊息？
- [ ] `suppressGeneratorTimestamp` 為什麼不只是美觀問題？
- [ ] 為什麼「需要 `expression = "java(...)"` 就不要用 MapStruct」？
- [ ] `interface + uses` 與 `abstract class + @Autowired` 的取捨？
- [ ] shop-service 為什麼不全站統一？判準的那一句話是什麼？

**集合與巢狀**

- [ ] 「一個方法一層」買到了哪四件事？
- [ ] 請求方向與回應方向的 null 政策為什麼不同？
- [ ] 「一律回 `List.of()`」真正的理由是什麼（不是「前端方便」）？
- [ ] 為什麼「對不可能為 null 的東西做 null 檢查」是有害的？
- [ ] `Stream.toList()`、`Collectors.toList()`、`toUnmodifiableList()`、`List.copyOf` 四者的差別？
- [ ] `List.copyOf` 的**三個邊界**？
- [ ] `List.copyOf` 與 `Collections.unmodifiableList` 的差別？各自什麼時候用？
- [ ] record 的「不可變」保證的是什麼、不保證什麼？
- [ ] JSON 上「空集合 / null / 欄位不存在」三者的差別？`non_null` 的代價？
- [ ] 41 萬筆匯出時，mapper 的形狀要怎麼改？為什麼 `OrderExportRow.from` 必須是 static？
- [ ] 為什麼 CSV 匯出用 `enum.name()` 而不是 `statusLabel`？

**PATCH 三態**

- [ ] 三態在四層各自的形狀？**為什麼 Domain 層沒有三態？**
- [ ] 04-controller 1.6.4 那個 builder 寫法的致命問題？它為什麼很難被發現？
- [ ] 四個選項各自的問題？為什麼 `JsonNullable` 進 Command 有一個**技術**後果而不只是架構潔癖？
- [ ] `Patch` 為什麼是 sealed interface 而不是「值 + boolean」？
- [ ] `Patch` 刻意**沒有** `get()`、`orElse()`，為什麼？
- [ ] `apply(onSet, onClear)` 的簽章如何讓「漏處理清空」變成編譯錯誤？
- [ ] `isMentioned()` 為什麼必須包含 `Clear`？寫成 `instanceof Set` 會有什麼漏洞？
- [ ] 「只改一個欄位卻遞增 version」的四個處置？shop-service 為什麼選「接受它」？
- [ ] 欄位級權限為什麼**必須在載入聚合之前**檢查？
- [ ] 「這個欄位需要三態嗎」怎麼判斷？`invoice` 為什麼其實不需要？
- [ ] PATCH 的稽核為什麼比一般稽核容易做對？它需要什麼前置條件？

**角色可見性**

- [ ] 「三個 DTO」保證了什麼、沒保證什麼？
- [ ] 三種防護各自擋什麼、漏什麼？為什麼需要第四種（3.8.5）？
- [ ] mapper 的斷言為什麼用 500 而不是 403？
- [ ] **「一條規則如果依賴一個約定，那個約定本身也需要一條規則」** —— 舉出這一章的實例？
- [ ] 遮蔽發生在序列化 / mapper / 型別三個位置，各自的優缺點？按敏感度怎麼分級？
- [ ] `@Masked` 為什麼防不住 log？兩個處置哪一個更便宜、為什麼？
- [ ] 「一個欄位的意思取決於誰在看」為什麼一定會洩漏？`Cancellation.note` 的正解？
- [ ] 為什麼「限制誰能看」之外還要「記錄誰看了」？

**測試**

- [ ] 逐欄位斷言的四個問題？為什麼「照著實作寫測試」是它的天然結果？
- [ ] `MappingCompleteness` 抓什麼、**抓不到什麼**（三項）？
- [ ] 為什麼空字串與空集合也算「預設值」？
- [ ] `fullyPopulated()` 為什麼是整套測試的單點失效？它自己怎麼被守？
- [ ] `Orders.fullyPopulated()` 回的是 class，兩個處置哪一個更好、為什麼？
- [ ] 「用欄位名當值」的技巧解決了什麼？它的錯誤訊息為什麼更有用？
- [ ] 金額掃描測試的誤報來源？為什麼「加一個型別」比「加一個例外清單」好？
- [ ] 3.8.5 是黑名單，而 3.2.2 說黑名單不好 —— 為什麼不矛盾？
- [ ] 一個 31 欄位的 mapper，語意斷言大約幾個？各自測什麼？
- [ ] MapStruct 產生的程式碼不進版控的**第三個**代價是什麼？處置？
- [ ] 「位置對調」這個 bug 為什麼是唯一需要 code review 注意的？

**LazyInitializationException**

- [ ] 它為什麼在「交易結束之後」才發生？三個容易誤解的點？
- [ ] 為什麼它的發生時機（序列化中途）特別討厭？客戶端看到什麼？
- [ ] 解法 1 解決了什麼、**沒有**解決什麼？
- [ ] `JOIN FETCH` + 分頁會發生什麼？它是錯誤還是警告？
- [ ] `open-in-view = true` 的**四個**問題？哪一個最嚴重、為什麼？
- [ ] 關掉它之後那行 WARN 會消失 —— 為什麼這是一個容易誤讀的訊號？
- [ ] 本站的記憶體假實作有哪**三個**「比真實作寬鬆」之處？

**修正與總表**

- [ ] 這一章修正 00／01 章的**九處**，各自的理由？
- [ ] 🔴 為什麼 `Order.customerNote` 與 `invoice` 的 `final` 必須拿掉？**為什麼那不是 00 章的 bug？**
- [ ] `internalNote` 這一個欄位的新增，會讓哪**四個**已存在的測試紅燈？
- [ ] `CancellationResult` 與 `CancellationResultView` 的差別？各自由誰產生？
- [ ] 為什麼 `InternalOnlyView` 與 `InternalOnlyDto` 是**兩個**介面而不是共用一個？
- [ ] `OrderApplicationService` 改回傳型別，買到四件事、付了三個代價 —— 各是什麼？
- [ ] 01 章 1.9.2 的 `Locale` 參數，三個選項各自的代價？選 A 的代價怎麼處置？
- [ ] `clearInvoice` 為什麼要改名？`null` 與 `InvoiceSpec.personal()` 的差別在哪裡是決定性的？
- [ ] 為什麼「每一個 Domain 層的最後一道防線都需要一個 `ErrorCode`」？

---

## 3.14 下一章預告

這一章一路在做同一件事：**讓「做錯」變成大聲失敗**。
編譯錯誤、CI 紅燈、`IllegalStateException` ——
三種都是「立刻、明確、指向那一行」。

**而它留下一個沒有回答的問題**：

> **那些「刻意拋出來的例外」，到了 Controller 要變成什麼？**

這一章新增了 4 個 `ErrorCode`（3.10.3 ⑦），
而它們是在一個**已經有 93 個 code**的註冊表上加的。
04-controller 03 章建了那張表與 `@RestControllerAdvice`，
但它處理的主要是**框架的例外**（驗證失敗、反序列化失敗、405、415）。

**業務例外的那一半一直沒有被系統性地處理過。** 而它有幾個具體的問題：

| 04 章的節 | 主題 |
|---|---|
| 4.2 | **93 + 4 個 `ErrorCode` 怎麼組織** —— 平坦的 enum 在第 60 個之後會發生什麼 |
| 4.3 ★ | 例外階層：**三層還是兩層**？`OrderNotCancellableException` 該繼承誰 |
| 4.4 | 「可預期」與「不可預期」的界線 —— 以及為什麼 `IllegalStateException` 刻意不是業務例外 |
| 4.5 ★ | **例外要帶哪些資料**：`orderId` 夠嗎？為什麼「訊息」不該在例外裡 |
| 4.6 | 業務例外與 HTTP 狀態碼的**完整對應表**（97 列） |
| 4.7 ★★ | **一個例外對應兩個狀態碼**的情況（同一個 `OrderNotEditableException`，客戶是 409、客服是 403） |
| 4.8 | 例外的 i18n：訊息在哪一層組出來 |
| 4.9 | 重試語意：哪些例外「可重試」？`Retry-After` 從哪裡來 |
| 4.10 | 例外與交易：`rollbackFor` 的政策（02 章 2.6.4）在例外階層上怎麼表達 ★ |
| 4.11 | 不要用例外做流程控制 —— **以及三個「其實可以」的例外** |
| 4.12 | 守門測試：**每一個業務例外都有 `ErrorCode`、都有訊息、都在對應表裡** |

⚠️ **而 04 章會回頭修正這一章的兩件事**：

| 修正 | 為什麼 |
|---|---|
| `IllegalStateException`（3.7.2 的 mapper 斷言）**沒有 traceId** | 04-controller 3.7 的 catch-all 會給它一個，但它不會進 alert —— 而 3.7.2 說「這件事應該吵醒某個人」。**那需要一個專門的例外型別** |
| `EmptyPatchException` 的 422 與 Web 層的 422 **形狀不同**（3.6.6 ①） | 兩種 422 讓前端要寫兩套錯誤處理。04 章 4.6 會決定要不要統一 |

---

**完成本章後**，請確認你的專案有：

```
✅ common/patch/Patch.java                        ★★ sealed interface，三態
✅ common/test/MappingCompleteness.java           ★★ 掃描測試的核心工具
✅ order/application/view/                        ★ 6 個 View + InternalOnlyView 標記介面
   ├── OrderResultView.java                       ★ 命令路徑的回傳型別
   ├── OrderDetailView.java
   ├── OrderDetailForSupportView.java             implements InternalOnlyView
   ├── OrderSummaryView.java                       ★ 已移除 Locale（3.10.3 ②）
   ├── CancellationResultView.java
   └── OrderExportRow.java                        ★ static from()，3.5.5
✅ order/web/OrderWebMapper.java                   ★ 手寫；簽章只剩 (View, Locale)
✅ order/web/OrderDtoMapper.java                   ★ MapStruct；unmappedTargetPolicy = ERROR
✅ order/web/MoneyMapper.java                      ★ Money → String 的唯一實作點
✅ order/web/support/                              ★★ 客服端點的獨立套件
✅ pom.xml 的 annotationProcessorPaths             ★ Lombok → binding → MapStruct 的順序
✅ application.yml: spring.jpa.open-in-view=false  ★★ 3.9.4
✅ architecture/MappingArchitectureTest.java       ★ 5 條新規則（3.10.3 ⑥）
✅ order/web/OrderWebMapperCompletenessTest.java   ★ MappingCompleteness
✅ order/web/OrderWebMapperSemanticsTest.java      ★ 6 個語意斷言
✅ dto/DtoPolicyScanTest.java                      ★ 金額型別、敏感欄位名、時間欄位命名
✅ order/web/MassAssignmentProtectionTest.java     ★ 3.2.3
✅ Order.resetInvoiceToPersonal()                  ★ 改名（3.10.3 ③）
✅ Cancellation(by, reason, customerNote, staffNote, at)  ★ 拆兩個欄位（3.10.3 ④）
✅ Payment.refunds() 回 List.copyOf                ★ 3.10.3 ⑤
✅ 97 個 ErrorCode                                 ★ 93 + 4（3.10.3 ⑦）
✅ Order.customerNote / invoice 拿掉 final          ★★ 否則 3.6.5 編譯不過（3.10.3 ⑧）
✅ Order 新增 internalNote / invoiceIssuedAt /
   invoiceRequestSubmitted / MAX_NOTE_LENGTH       ★ 3.10.3 ⑧
✅ order/web/dto/InternalOnlyDto.java              ★ web 層的標記介面（3.7.2）
✅ cancel() 回傳 CancellationResultView            ★ 3.10.3 ⑨
```

⚠️ 課程中的程式碼、YAML 與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
（這台機器上沒有安裝 JDK 與 Maven）。基準版本延續前三章：
**Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1 / Jackson 2.17 /
MapStruct 1.5.5.Final / ArchUnit 1.3**。

⚠️⚠️ **這一章有兩處特別需要你實測**：

| 處 | 為什麼 |
|---|---|
| **MapStruct 的 `@Context` + `expression`**（3.4.4、3.4.5） | 產生的程式碼形狀隨 MapStruct 版本變化不小；1.6.x 對 record 與 `@Context` 的處理與 1.5.x 有差異 |
| **`JsonNullable<@NotNull String>` 的驗證行為**（3.12 練習 3） | 它依賴 `jackson-databind-nullable` 提供的 `ValueExtractor` 有正確註冊。04-controller 2.13.3 那個測試就是為此存在的 —— **練習 3 的第 3 個測試請真的跑一次** |

下一章：[04-business-exception-design.md](./04-business-exception-design.md)
