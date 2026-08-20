# 第 03 章：請求與回應設計

> 這一章決定了前端每天要不要罵你。
> URL 和狀態碼是「骨架」，DTO 是「肉」——使用者真正拿到的每一個欄位、每一個型別、每一個 null，
> 都會變成前端的 `if`、App 的 crash、財務對帳的差額。
> 而且它有一個殘酷的性質：**欄位一旦回出去，就再也拿不回來了。**

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說出「直接回 Entity」的六個實際後果，包含兩種資安事故。
- 區分 Request / Response DTO，並說明為什麼共用會造成 mass assignment 漏洞。
- 用 Java `record` 寫出乾淨的 DTO，並知道 Jackson 對 `record` 的支援細節。
- 決定金額用什麼型別，並說出 JS 浮點誤差與 `MAX_SAFE_INTEGER` 兩個坑。
- 設計日期時間欄位：知道什麼時候用 `Instant`、什麼時候用 `LocalDate`。
- 精確處理 `null`／缺欄位／空字串／空陣列四種狀態。
- 判斷該不該用統一包裝層 `{code, message, data}`，並給出有理由的答案。
- 設計可演進的列舉欄位，避免第 00 章 0.8.3 的災難。
- 設計 `?expand=` 與 `?fields=`，處理 over-fetching 與 N+1 API。
- 完成 shop-service 的 DTO 全家族與 JSON 範例。

---

## 3.2 為什麼不能直接回 Entity

### 3.2.1 先看事故

這是最常見的 Spring Boot 新手寫法：

```java
@Entity
public class Customer {
    @Id @GeneratedValue
    private Long id;
    private String email;
    private String displayName;
    private String passwordHash;              // ← 注意這個
    private String phone;
    private String idNumber;                  // 身分證號（實名認證用）
    private BigDecimal lifetimeValue;         // 內部計算的客戶終身價值
    private Integer riskScore;                // 風控分數
    private String internalNote;              // 客服內部備註
    private LocalDateTime createdAt;
    @OneToMany(mappedBy = "customer")
    private List<Order> orders;
    // getter / setter 略
}
```

```java
@RestController
@RequestMapping("/customers")
public class CustomerController {
    @GetMapping("/{id}")
    public Customer get(@PathVariable Long id) {
        return repo.findById(id).orElseThrow();   // ← 直接回 Entity
    }
}
```

實際回應：

```jsonc
{
  "id": 48213,
  "email": "wang@example.com",
  "displayName": "王小明",
  "passwordHash": "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",  // 🔴
  "phone": "0912345678",
  "idNumber": "A123456789",                    // 🔴 個資
  "lifetimeValue": 128450.00,                  // 🔴 商業機密
  "riskScore": 72,                             // 🔴 內部風控邏輯外洩
  "internalNote": "多次退貨，注意",              // 🔴 客戶看到會投訴
  "createdAt": "2024-03-12T08:14:22",
  "orders": [ ... 整個訂單陣列 ... ]             // 🔴 效能災難
}
```

**六個後果，逐一說明。**

### 3.2.2 後果 1：敏感欄位外洩

`passwordHash` 出去了。

有人會說「那是 bcrypt hash，破不了」。要精確地說：

- bcrypt 有 work factor，離線暴力破解很慢 —— 但**弱密碼仍然會被破**。
  `123456`、`password`、`wang1234` 這種在幾分鐘內就會出來。
- 更重要的是：**它讓你無法否認洩漏**。資安通報時「我們洩漏了密碼雜湊」和
  「我們沒有洩漏密碼」是兩件完全不同的事，後續處理成本差好幾個量級
  （全站強制改密碼、通報主管機關、對外公告）。

`idNumber` 更嚴重 —— 這是個人資料保護法規範的個資。

**而且注意 `internalNote`**：這種欄位外洩不會被資安掃描抓到，
但客戶看到「多次退貨，注意」會直接截圖上網。

### 3.2.3 後果 2：資料庫欄位改名就炸掉前端

```
Sprint 12：後端把 displayName 改名成 nickname（因為 DBA 覺得更精確）
          → 所有前端的 customer.displayName 變成 undefined
          → Web 顯示空白，iOS 若用非 optional 的 Codable → 直接 crash
```

**Entity 的欄位名是給資料庫和 ORM 用的，不該是 API 契約。**
你應該可以自由重構 Entity 而不影響任何 consumer —— 這是分層的基本價值。

### 3.2.4 後果 3：延遲載入與序列化異常

```java
@OneToMany(mappedBy = "customer", fetch = FetchType.LAZY)
private List<Order> orders;
```

Jackson 序列化時會呼叫 `getOrders()` → 觸發延遲載入。三種可能結果：

| 情況 | 結果 |
|---|---|
| Session 已關閉（Controller 層在交易外） | `LazyInitializationException` → `500` |
| Session 還開著（`spring.jpa.open-in-view=true`，Boot **預設值**） | 成功載入 → 但**多打了一次 SQL**，而且客戶端根本不需要 |
| 有 100 張訂單，每張訂單又有 lazy 的 items | **N+1 爆炸**：1 + 100 次查詢 |

> ⚠️ `spring.jpa.open-in-view` 預設是 `true`，而且啟動時 Spring Boot 會印一行警告。
> 很多人忽略它。它讓「在 Controller 觸發延遲載入」不會拋錯，
> 代價是把資料庫 session 的生命週期拉長到整個請求 —— 連線池會更快耗盡。
> 08-jpa-mybatis 會完整處理。

### 3.2.5 後果 4：雙向關聯造成無限遞迴

```java
class Customer { List<Order> orders; }
class Order    { Customer customer; }   // 雙向
```

Jackson 序列化：`Customer` → `orders` → `Order` → `customer` → `orders` → …

```
StackOverflowError
或
Infinite recursion (StackOverflowError) (through reference chain:
  Customer["orders"]->ArrayList[0]->Order["customer"]->Customer["orders"]->...)
```

常見的「解法」是加註解：

```java
@JsonIgnore                          // 或
@JsonManagedReference / @JsonBackReference   // 或
@JsonIdentityInfo
```

**這些都是在用 Jackson 註解修補建模問題。** 後果是：

- Entity 上散落一堆序列化註解 → **Entity 開始知道 JSON 的事**（分層被打破）。
- 同一個 Entity 在不同端點需要不同的序列化行為 → `@JsonIgnore` 無法按端點區分。
- `@JsonView` 可以按端點區分，但它把「API 契約」編碼進 Entity 的註解裡，
  一個 Entity 上有五個 view 之後就沒人看得懂了。

**用 DTO 就完全沒有這個問題** —— DTO 是單向的、沒有關聯、就是一個資料袋。

### 3.2.6 後果 5：Request 方向的 mass assignment 漏洞

**這是最危險的一個，而且最常被忽略。**

```java
@PostMapping("/customers")
public Customer create(@RequestBody Customer customer) {   // 🔴 用 Entity 收請求
    return repo.save(customer);
}
```

攻擊者送：

```json
{
  "email": "attacker@evil.com",
  "displayName": "攻擊者",
  "passwordHash": "$2a$10$我自己算的雜湊",
  "riskScore": 0,
  "lifetimeValue": 9999999,
  "role": "ADMIN"
}
```

如果 Entity 有這些欄位，**它們全部會被寫進資料庫**。

更陰險的版本 —— 更新時：

```java
@PutMapping("/customers/{id}")
public Customer update(@PathVariable Long id, @RequestBody Customer customer) {
    customer.setId(id);                    // 「我有設 id，應該安全吧」
    return repo.save(customer);
}
```

```json
{ "displayName": "王小明", "orders": [{ "id": 9999, "customerId": 48213 }] }
```

如果有 cascade，**這可能把別人的訂單掛到自己名下**。

**這種漏洞叫 mass assignment（OWASP API6:2019 / 現在歸在 API3:2023 Broken Object Property Level Authorization）。**

**根因**：`@RequestBody Customer` 讓客戶端可以寫入 Entity 的**任何**欄位。
你必須明確列出「允許客戶端寫入哪些欄位」—— 這就是 Request DTO 的存在理由。

### 3.2.7 後果 6：無法為不同場景設計不同的表述

```
GET /orders            列表：只要 8 個欄位，一次 20 筆
GET /orders/{id}       詳情：要 30 個欄位 + 明細 + 出貨 + 付款
GET /orders?scope=csv  匯出：要 15 個欄位，扁平化（CSV 不能巢狀）
GET /me                我看自己：要看到 email、phone
GET /customers/{id}    客服看客戶：還要看到 internalNote、riskScore
```

同一個 `Customer` Entity 無法同時滿足這五種需求。
硬要做就會出現「列表端點回 30 個欄位」（over-fetching）
或「詳情端點欄位不夠，前端要再打三支 API」（under-fetching）。

### 3.2.8 唯一的例外：真的沒有例外

有人會說「內部管理後台，圖方便就直接回 Entity 吧」。

三個反駁：

1. **`passwordHash` 不會因為是內部後台就變得可以外洩。** 內部後台的 XSS、
   前端 log 上傳、瀏覽器擴充套件、螢幕錄影都會帶走它。
2. **「內部」很少永遠內部。** 三個月後有人說「這個後台的訂單列表 API 借給廠商用一下」。
3. **成本很低。** 一個 `record` DTO 是 5 行。這不是「圖方便」，是省 5 行程式碼換一個漏洞。

**shop-service 的規則：任何離開 Service 層的資料都是 DTO，沒有例外。**

### 3.2.9 一行指令自我檢查

```bash
# 列出回應的所有欄位路徑（含巢狀）—— 資安審查第一步
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/customers/48213 \
  | jq -r '[paths | join(".")] | .[]'

# 直接搜尋危險欄位名
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/customers/48213 \
  | jq -r '[paths | join(".")] | .[]' \
  | grep -iE 'password|hash|secret|token|salt|idnumber|ssn|internal|cost|risk|score'
```

**把第二個指令放進 CI**，對每個端點跑一次。
這是最便宜的資安護欄：一個 grep 就能擋掉整類事故。

---

## 3.3 DTO 的三種角色

### 3.3.1 命名慣例

| 角色 | 命名 | 例子 | 說明 |
|---|---|---|---|
| **請求** | `XxxRequest` / `XxxCommand` | `CreateOrderRequest` | 客戶端能寫入的欄位 |
| **回應（摘要）** | `XxxSummary` | `OrderSummary` | 列表用，欄位少 |
| **回應（詳情）** | `XxxDetail` / `XxxResponse` | `OrderDetail` | 單筆用，欄位完整 |
| **內部傳遞** | `XxxView` / 領域物件 | `OrderPricingView` | Service 層內部用，不對外 |

**shop-service 的完整命名規則**：

```
CreateOrderRequest        POST /orders 的 body
UpdateOrderRequest        PATCH /orders/{id} 的 body
OrderSummary              GET /orders 陣列的元素
OrderDetail               GET /orders/{id} 的回應
OrderItemResponse         GET /orders/{id}/items 陣列的元素
CreatePaymentRequest      POST /orders/{id}/payments 的 body
PaymentResponse           付款的回應（列表與單筆共用，因為欄位一樣）
PageResponse<T>           分頁外殼（第 05 章）
ProblemDetail             錯誤（第 04 章）
```

**為什麼列表和詳情要分開**：3.2.7 已說明。具體差異：

```jsonc
// OrderSummary（列表，20 筆）—— 8 個欄位
{
  "orderId": "ord_01J5GK...",
  "orderNumber": "ORD-20260819-0001",
  "status": "PAID",
  "statusLabel": "已付款",
  "totalAmount": "1280.50",
  "currency": "TWD",
  "itemCount": 3,
  "createdAt": "2026-08-19T06:12:44Z"
}

// OrderDetail（單筆）—— 完整
{
  "orderId": "ord_01J5GK...",
  "orderNumber": "ORD-20260819-0001",
  "status": "PAID",
  "statusLabel": "已付款",
  "allowedActions": ["CANCEL", "REQUEST_INVOICE"],
  "customer": { "customerId": "cus_...", "displayName": "王小明" },
  "items": [ ... ],
  "amounts": {
    "subtotal": "1500.00", "discount": "-300.00",
    "shippingFee": "80.50", "tax": "0.00", "total": "1280.50"
  },
  "currency": "TWD",
  "shippingAddress": { ... },
  "payments": [ ... ],
  "shipments": [ ... ],
  "invoice": { ... },
  "createdAt": "2026-08-19T06:12:44Z",
  "updatedAt": "2026-08-19T06:15:02Z",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**列表回 8 個欄位 vs 30 個欄位的實際差別**：
20 筆 × 22 個多餘欄位（含巢狀陣列）可能是 4KB vs 180KB。
在 4G 網路上是 0.1 秒 vs 2 秒。

### 3.3.2 為什麼 Request 和 Response 不能共用

**理由 1：欄位集合本質不同**

| 欄位 | Request | Response |
|---|---|---|
| `orderId` | ❌ 由伺服器產生 | ✅ |
| `orderNumber` | ❌ 由伺服器產生 | ✅ |
| `status` | ❌ 由業務邏輯決定 | ✅ |
| `totalAmount` | ❌ **絕對不能讓客戶端指定** | ✅ |
| `createdAt` | ❌ 伺服器時鐘 | ✅ |
| `items[].productId` | ✅ | ✅ |
| `items[].quantity` | ✅ | ✅ |
| `items[].unitPrice` | ❌ **價格由伺服器查** | ✅ |
| `items[].productName` | ❌ 伺服器查 | ✅ |
| `couponCode` | ✅ | ❌（回 `appliedCoupon` 物件） |
| `statusLabel` | ❌ | ✅ |
| `allowedActions` | ❌ | ✅ |

看 `totalAmount` 和 `unitPrice` 那兩列 ——
**如果共用 DTO，客戶端就可以送 `{"totalAmount": "1.00"}` 買走 1280 元的東西。**

這不是理論。這是最經典的電商漏洞：

```http
POST /orders
{ "items": [{"productId": "P-1001", "quantity": 1, "unitPrice": "1.00"}],
  "totalAmount": "1.00" }
```

如果後端信任這些欄位（或者共用 DTO 然後忘記忽略它們），就出事了。

**鐵律：任何金額、價格、折扣、狀態，一律由伺服器計算，客戶端送上來的一律忽略。**

**理由 2：驗證規則不同**

```java
// Request：需要驗證
public record CreateOrderRequest(
    @NotEmpty(message = "訂單至少需要一項商品")
    @Size(max = 50, message = "單筆訂單最多 50 項商品")
    List<@Valid OrderItemRequest> items,

    @NotBlank String shippingAddressId,

    @Size(max = 200) String customerNote,
    @Size(max = 32)  String couponCode
) {}

// Response：不需要驗證（是我們自己產生的）
public record OrderDetail(
    String orderId,
    String orderNumber,
    ...
) {}
```

把驗證註解放在共用 DTO 上，會在序列化回應時造成困惑
（IDE 提示、OpenAPI 產生的 schema 會把 `required` 標錯）。

**理由 3：演進速度不同**

Response 可以自由**新增**欄位（相容）。
Request 新增**必填**欄位是**破壞性變更**。

兩者的變更節奏完全不同，綁在一起會互相拖累。

**理由 4：OpenAPI 的 schema 會很醜**

共用 DTO 在 OpenAPI 裡只能有一份 schema，於是所有欄位都變成選填，
產生出來的 client 會有一堆不該存在的 setter。

### 3.3.3 但也不要過度拆分

三個 DTO 就夠了。**不要為每個端點都造一個新 DTO。**

```
❌ 過度拆分
OrderSummaryForMobileList
OrderSummaryForWebList
OrderSummaryForAdminList
OrderSummaryForExport
```

**判準：欄位差異超過 30% 才拆。** 否則用 `?fields=` 或 `?expand=`（3.8）處理。

如果真的有「行動版要少 5 個欄位」的需求，
那是**前端該用 `?fields=` 篩**，不是後端多造一個 DTO。

---

## 3.4 用 Java `record` 寫 DTO

### 3.4.1 基本形式

```java
package com.example.shop.api.dto;

import java.time.Instant;
import java.util.List;

public record OrderDetail(
    String orderId,
    String orderNumber,
    String status,
    String statusLabel,
    List<String> allowedActions,
    CustomerRef customer,
    List<OrderItemResponse> items,
    Amounts amounts,
    String currency,
    AddressResponse shippingAddress,
    Instant createdAt,
    Instant updatedAt,
    String traceId
) {
    public record CustomerRef(String customerId, String displayName) {}

    public record Amounts(
        String subtotal,
        String discount,
        String shippingFee,
        String tax,
        String total
    ) {}
}
```

**`record` 對 DTO 的四個好處**：

| 好處 | 說明 |
|---|---|
| **不可變** | 所有欄位 `final`，沒有 setter → 不可能在 Controller 之後被偷偷改掉 |
| **極短** | 自動產生建構子、`equals`、`hashCode`、`toString` |
| **意圖明確** | 看到 `record` 就知道「這是資料袋，沒有行為」 |
| **巢狀好寫** | 可以直接把子 DTO 定義在裡面（如上面的 `CustomerRef`） |

### 3.4.2 Jackson 對 `record` 的支援細節

**Jackson 2.12+ 原生支援 `record`**（Spring Boot 3.x 的 Jackson 版本遠高於此，沒有問題）。

**序列化（Java → JSON）**：直接用 accessor（`orderId()`），不需要 `-parameters` 編譯旗標。

**反序列化（JSON → Java）**：Jackson 需要知道參數名。三種情況：

| 情況 | 需要 `-parameters`？ |
|---|---|
| Spring Boot 專案（`spring-boot-starter-parent`） | ❌ 不需要 —— parent POM 已經加了 |
| 自己的 Maven 專案 | ✅ 需要（見下） |
| 只有一個參數的 `record` | ⚠️ 可能被當成 delegating creator，要加 `@JsonCreator(mode = PROPERTIES)` |

```xml
<!-- 非 Spring Boot parent 的專案要自己加 -->
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <configuration>
        <parameters>true</parameters>
    </configuration>
</plugin>
```

**單一參數 `record` 的坑**（實際遇到會很困惑）：

```java
// ⚠️ 這個可能出問題
public record TagRequest(String name) {}

// 送 {"name": "vip"} 可能被解讀成「用整個 JSON 物件當 name」
// 修法：
public record TagRequest(@JsonProperty("name") String name) {}
```

**驗證註解放哪**：`record` 的驗證註解要放在**參數**上，並且需要 `@Valid` 觸發。

```java
public record CreateOrderRequest(
    @NotEmpty @Size(max = 50) List<@Valid OrderItemRequest> items,
    @NotBlank String shippingAddressId,
    @Size(max = 200) String customerNote
) {}

// Controller
@PostMapping("/orders")
public ResponseEntity<OrderDetail> create(@Valid @RequestBody CreateOrderRequest req) { ... }
```

⚠️ **`List<@Valid OrderItemRequest>` 裡的 `@Valid` 很重要** ——
沒有它，陣列元素**不會被驗證**。這是超級常見的漏洞：
`items[0].quantity = -5` 完全通過驗證。

**要加 `@Valid` 到元素上的三種寫法**：

```java
List<@Valid OrderItemRequest> items          // ✅ 元素會被驗證
@Valid List<OrderItemRequest> items          // ⚠️ 只驗證 List 本身（沒用）
List<OrderItemRequest> items                 // ❌ 完全不驗證元素
```

### 3.4.3 `record` 不適合的三種情況

| 情況 | 為什麼 | 改用 |
|---|---|---|
| 需要 `JsonNullable` 三態（第 02 章 2.5.4） | `record` 的不可變性讓「未設定」很難表達（雖然可以用 `JsonNullable` 欄位） | ⚠️ 可以用 `record` + `JsonNullable`，但要小心預設值 |
| 需要繼承 | `record` 是 `final`，不能被繼承 | 介面 + `sealed`；或就不要繼承 |
| 欄位超過 12 個 | 建構子參數太多，呼叫端會出錯（位置搞混） | Builder 模式（Lombok `@Builder`），或拆成巢狀物件 |

**「欄位太多」的正確解法通常是分組**：

```java
// ❌ 20 個平坦欄位
public record OrderDetail(
    String orderId, String orderNumber, String status, String statusLabel,
    String subtotal, String discount, String shippingFee, String tax, String total,
    String currency, String recipient, String phone, String postalCode,
    String addressLine1, String addressLine2, ...
) {}

// ✅ 分組（同時讓 JSON 結構更好讀）
public record OrderDetail(
    String orderId,
    String orderNumber,
    String status,
    String statusLabel,
    Amounts amounts,                // 5 個金額欄位收在一起
    AddressResponse shippingAddress, // 5 個地址欄位收在一起
    ...
) {}
```

**分組不只是為了程式碼好看** —— 它讓 JSON 也變好讀，
而且「金額」整組可以一起演進（例如未來加 `platformFee`）。

### 3.4.4 `JsonNullable` 用在 `record` 上

第 02 章 2.5.4 的解法 1 配合 `record`：

```java
import org.openapitools.jackson.nullable.JsonNullable;

public record UpdateAddressRequest(
    JsonNullable<String> recipient,
    JsonNullable<String> phone,
    JsonNullable<String> line2,     // 可清空
    JsonNullable<String> note       // 可清空
) {
    // ⚠️ 關鍵：Jackson 對「JSON 裡不存在的欄位」會塞 null 而不是 JsonNullable.undefined()
    //          所以要在 canonical constructor 裡正規化
    public UpdateAddressRequest {
        recipient = recipient == null ? JsonNullable.undefined() : recipient;
        phone     = phone     == null ? JsonNullable.undefined() : phone;
        line2     = line2     == null ? JsonNullable.undefined() : line2;
        note      = note      == null ? JsonNullable.undefined() : note;
    }
}
```

**這個 compact constructor 是必要的**，否則你會在 Service 層踩到 `NullPointerException`
（`req.note().isPresent()` 但 `note` 本身是 `null`）。

Service 層使用：

```java
public AddressResponse update(String addressId, UpdateAddressRequest req) {
    Address entity = repo.findByIdAndCustomerId(addressId, currentCustomerId())
            .orElseThrow(() -> new ResourceNotFoundException("address", addressId));

    req.recipient().ifPresent(v -> {
        if (v == null) throw new FieldValidationException("recipient", "收件人為必填");
        entity.setRecipient(v);
    });
    req.line2().ifPresent(entity::setLine2);    // null 就是清空，合法
    req.note().ifPresent(entity::setNote);

    return mapper.toResponse(repo.save(entity));
}
```

注意 `recipient` 和 `line2` 的差別：
**同樣是 `JsonNullable`，但「可不可以是 null」是業務規則，要逐欄位判斷。**

---

## 3.5 JSON 命名與型別慣例

### 3.5.1 命名風格：選一個，全站遵守

| 風格 | 例子 | 誰在用 |
|---|---|---|
| `camelCase` | `orderNumber`、`createdAt` | ★ Java / JS 生態主流；Stripe、Microsoft |
| `snake_case` | `order_number`、`created_at` | GitHub、Twitter、Slack、Python 生態 |
| `PascalCase` | `OrderNumber` | .NET 舊版（現在也多改 camel） |
| `kebab-case` | `order-number` | ❌ 不要（JS 裡要 `obj["order-number"]`） |

**shop-service 選 `camelCase`**，理由：
- Java 的欄位命名就是 camelCase → 不需要轉換設定，少一個出錯點。
- 前端 JS/TS 也是 camelCase → `order.orderNumber` 而不是 `order.order_number`。

**如果你要用 `snake_case`**，全站設定一次：

```yaml
spring:
  jackson:
    property-naming-strategy: SNAKE_CASE
```

⚠️ 這個設定會影響**所有** Jackson 序列化，包含你和第三方 API 通訊的 DTO。
要小心（可以用 `@JsonNaming` 在特定類別覆寫）。

### 3.5.2 命名的具體規則

| 項目 | 規則 | ✅ | ❌ |
|---|---|---|---|
| 時間欄位 | `xxxAt`（時間點）／`xxxOn`（日期） | `createdAt`、`birthDate` | `createTime`、`gmtCreate`、`ctime` |
| 布林 | 選一種並全站一致 | `isDefault` 或 `default` | 混用 `isActive` + `enabled` |
| 數量 | `xxxCount` | `itemCount`、`retryCount` | `itemNum`、`cnt` |
| 集合 | 複數 | `items`、`tags` | `itemList`、`itemArray` |
| ID | `xxxId`，且**是字串** | `"orderId": "ord_1"` | `"orderID"`、`"order_ID"` |
| 列舉 | `UPPER_SNAKE_CASE` 的字串 | `"PENDING_PAYMENT"` | `2`、`"pending payment"` |
| 金額 | 見 3.5.3 | `"totalAmount": "1280.50"` | `1280.5` |
| 縮寫 | 只有第一個字母大寫 | `orderId`、`customerUrl`、`httpStatus` | `orderID`、`customerURL`、`HTTPStatus` |

**「縮寫」那一列容易被忽略但很重要**：

```
❌ 混亂
{ "orderID": "...", "customerUrl": "...", "HTTPStatus": 200, "apiKey": "..." }

✅ 一致（Java Bean 慣例：縮寫當普通字處理）
{ "orderId": "...", "customerUrl": "...", "httpStatus": 200, "apiKey": "..." }
```

理由：`orderID` 在 Java 裡對應的 getter 是 `getOrderID()`，
Jackson 的預設命名推導會產生 `orderID`，但如果有人寫成 `getOrderId()` 就變 `orderId` ——
**同一個系統裡兩種都會出現**。統一用「縮寫只大寫首字母」可以避免這個歧義。

**布林命名的取捨**：

```jsonc
{ "isDefault": true, "isActive": true }      // 選項 A
{ "default": true, "active": true }          // 選項 B
```

- 選項 A 的優點：一看就知道是布林。
- 選項 B 的優點：更簡潔；且 `default` 在 JS 裡是保留字但當屬性名沒問題。
- ⚠️ **選項 B 在 Java 裡有坑**：`record Foo(boolean default)` 編譯不過（`default` 是關鍵字）。

**shop-service 選 A（`isXxx`）**，因為它在 Java 端沒有關鍵字衝突風險。

### 3.5.3 金額：三種方案 ★

**先看問題**：

```javascript
// JS 的浮點數
0.1 + 0.2                    // → 0.30000000000000004
1280.50 * 3                  // → 3841.5000000000005

// 累加訂單金額
[19.99, 29.99, 49.99].reduce((a, b) => a + b)   // → 99.97000000000001
```

在畫面上顯示 `99.97000000000001` 是小事。
**真正的問題是對帳差 1 分錢，然後財務花三天找不出來。**

| 方案 | 表示 | 優點 | 缺點 |
|---|---|---|---|
| **A. 字串 decimal** | `"1280.50"` | ✅ 精確、可讀、無精度問題<br>✅ 保留尾數 0（`"1280.50"` vs `1280.5`） | 前端要用 decimal 庫算（`decimal.js`、`big.js`）<br>不能直接 `+` |
| **B. 整數最小單位** | `128050`（分） | ✅ 精確、可直接整數運算<br>✅ Stripe 用這個 | 前端要記得除 100 顯示<br>⚠️ 不同幣別的小數位不同（JPY 0 位、TWD 2 位、KWD 3 位） |
| **C. JSON number** | `1280.50` | 前端可直接運算 | 🔴 **有精度風險**；`1280.50` 序列化後可能變 `1280.5` |

**shop-service 選方案 A（字串 decimal）+ 明確的 `currency`**：

```jsonc
{
  "amounts": {
    "subtotal": "1500.00",
    "discount": "-300.00",
    "shippingFee": "80.50",
    "tax": "0.00",
    "total": "1280.50"
  },
  "currency": "TWD"
}
```

理由：
- **可讀性最好**（log、debug、對帳報表直接看得懂）。
- **保留精度語意**：`"1280.50"` 明確表達「兩位小數」，`1280.5` 就丟失了。
- 前端本來就不該做金額計算 —— **總額由後端算**，前端只負責顯示。

**Java 端的實作**：

```java
// Entity 用 BigDecimal
@Column(precision = 19, scale = 4)
private BigDecimal totalAmount;

// DTO 用 String（在 mapper 轉換）
public record Amounts(String subtotal, String discount,
                      String shippingFee, String tax, String total) {}

// 轉換：一定要指定 scale 和 RoundingMode
static String money(BigDecimal v) {
    return v.setScale(2, RoundingMode.HALF_UP).toPlainString();
}
```

⚠️ **`toPlainString()` 而不是 `toString()`**：
`BigDecimal("1E+3").toString()` 會給 `"1E+3"`（科學記號），
`toPlainString()` 給 `"1000"`。這在金額上是災難。

**如果選方案 B（整數分），要注意幣別的小數位數**：

```jsonc
{ "amountMinor": 128050, "currency": "TWD", "exponent": 2 }   // 1280.50 TWD
{ "amountMinor": 1280,   "currency": "JPY", "exponent": 0 }   // 1280 JPY（日圓沒有小數）
{ "amountMinor": 128050, "currency": "KWD", "exponent": 3 }   // 128.050 KWD（科威特第納爾 3 位）
```

**沒有 `exponent`（或沒有幣別對照表）的話，`128050` 是 1280.50 還是 128050？**
這是方案 B 最容易出錯的地方。ISO 4217 定義了每個幣別的小數位數。

**絕對不要做的三件事**：

```jsonc
// ❌ 用 float/double
{ "amount": 1280.5 }

// ❌ 單位不明
{ "amount": 128050 }              // 分？元？還是含稅前？

// ❌ 同一個 API 裡混用
{ "totalAmount": "1280.50", "shippingFee": 80.5 }   // 一個字串一個數字 🔴
```

### 3.5.4 ID 一律用字串

第 01 章 1.4.5 已詳述。這裡補一個實測：

```javascript
// 後端回 { "orderId": 1725088331234567890 }
const res = await fetch('/orders/1').then(r => r.json());
console.log(res.orderId);              // 1725088331234567900   ← 最後 2 位被改了
console.log(res.orderId === 1725088331234567890);  // true（因為兩邊都被截斷了）

// 然後你用這個 ID 去查
await fetch(`/orders/${res.orderId}`); // → GET /orders/1725088331234567900 → 404
```

**而且不會有任何錯誤訊息。** JSON.parse 不會警告，型別是 number，看起來完全正常。

**Twitter 的處理方式**（值得抄）：

```jsonc
{
  "id": 1725088331234567890,      // 保留給舊客戶端（會被截斷，但不能移除）
  "id_str": "1725088331234567890" // 新客戶端一律用這個
}
```

**shop-service 從一開始就只給字串**，避免這個歷史包袱。

**Java 端的三種做法**：

```java
// 做法 1：DTO 直接用 String（★ 推薦，最明確）
public record OrderSummary(String orderId, ...) {}
// mapper: String.valueOf(entity.getId())

// 做法 2：全域設定 Long → String
@Bean
Jackson2ObjectMapperBuilderCustomizer longToString() {
    return builder -> builder.serializerByType(Long.class, ToStringSerializer.instance)
                             .serializerByType(Long.TYPE, ToStringSerializer.instance);
}
// ⚠️ 危險：會把所有 Long 都變字串，包含 count、quantity、timestamp

// 做法 3：逐欄位標註
@JsonSerialize(using = ToStringSerializer.class)
private Long orderId;
```

**做法 2 的危險要說清楚**：`itemCount` 變成 `"3"`、`totalElements` 變成 `"1523"`，
前端做 `page.totalElements > 0` 會變成字串比較。
**做法 1 最安全**，因為 DTO 的型別就是契約。

### 3.5.5 不要在 JSON 裡用魔術數字

```jsonc
// ❌
{ "status": 2, "payMethod": 1, "type": 3 }

// ✅
{ "status": "PAID", "paymentMethod": "CREDIT_CARD", "orderType": "NORMAL" }
```

字串列舉的五個好處：

| 好處 | 說明 |
|---|---|
| 可讀 | log 裡看到 `"PAID"` 直接懂，看到 `2` 要查對照表 |
| 可擴充 | 新增值不用擔心編號衝突 |
| 不怕改順序 | 有人在 Java enum 中間插一個值 → 所有 `ordinal()` 全變 🔴 |
| 前端不用維護對照表 | 少一份會不同步的東西 |
| 除錯友善 | 資料庫、log、監控、錯誤訊息全部可讀 |

⚠️ **「不怕改順序」那一列是真實災難**：

```java
// v1
enum OrderStatus { PENDING_PAYMENT, PAID, SHIPPED, COMPLETED, CANCELLED }
// ordinal: 0, 1, 2, 3, 4

// v2：有人在中間插入
enum OrderStatus { PENDING_PAYMENT, PAID, PARTIALLY_SHIPPED, SHIPPED, COMPLETED, CANCELLED }
// ordinal: 0, 1, 2, 3, 4, 5
//                  ↑ 資料庫裡存 2 的全部從 SHIPPED 變成 PARTIALLY_SHIPPED 🔴
```

這也是為什麼 JPA 的 `@Enumerated(EnumType.ORDINAL)`（**預設值！**）是地雷 ——
一定要明確寫 `@Enumerated(EnumType.STRING)`。（08-jpa-mybatis 會再談。）

---

## 3.6 日期與時間

### 3.6.1 三個原則

```
原則 1：一律 ISO-8601 / RFC 3339 格式
原則 2：時間點一律 UTC（結尾 Z）
原則 3：「日期」和「時間點」是不同的型別，不要混
```

```jsonc
{
  "createdAt": "2026-08-19T06:12:44Z",           // 時間點 → Instant → UTC
  "updatedAt": "2026-08-19T06:12:44.123Z",       // 帶毫秒也可以
  "birthDate": "1990-03-12",                      // 純日期 → LocalDate
  "effectiveFrom": "2026-09-01",                  // 純日期
  "businessHours": { "open": "09:00", "close": "18:00" },  // 純時間 → LocalTime
  "expiresIn": 3600,                              // 相對秒數 → 不要用時間格式
  "processingDuration": "PT2M30S"                 // ISO-8601 duration（2 分 30 秒）
}
```

### 3.6.2 為什麼一律 UTC

```jsonc
// ❌ 沒有時區 —— 這是哪裡的 14:12？
{ "createdAt": "2026-08-19 14:12:44" }

// ⚠️ 有時區偏移但不是 UTC —— 技術上正確，但有兩個問題
{ "createdAt": "2026-08-19T14:12:44+08:00" }

// ✅ UTC
{ "createdAt": "2026-08-19T06:12:44Z" }
```

**第一種的問題**：無法判斷是哪個時區。
如果後端在 UTC，資料庫在 `+08:00`，前端在使用者的本地時區，**三方各自猜**。

**第二種（`+08:00`）的兩個問題**：

1. **`+` 在 query string 裡會被解讀成空白**（第 01 章案例 7）：
   ```
   GET /orders?createdFrom=2026-08-19T00:00:00+08:00
   後端收到：2026-08-19T00:00:00 08:00   → 解析失敗
   要寫成：  2026-08-19T00:00:00%2B08:00
   ```
2. **字串排序不等於時間排序**：
   ```
   "2026-08-19T14:00:00+08:00"   （= 06:00 UTC）
   "2026-08-19T10:00:00Z"        （= 10:00 UTC）
   字串比較：14:00... > 10:00...  ❌ 但實際上前者更早
   ```
   這會讓「用字串排序時間」的程式（Redis sorted set 的 member、
   Elasticsearch 的 keyword 欄位、CSV 排序）全部錯。

**UTC 的三個好處**：

| 好處 | 說明 |
|---|---|
| 字串排序 = 時間排序 | 因為格式固定、時區固定 |
| 沒有夏令時間問題 | UTC 不會跳 |
| 沒有 `+` 編碼問題 | `Z` 在 URL 裡安全 |

### 3.6.3 誰負責轉成當地時間

**答案：前端。**

```javascript
// 前端顯示
new Date("2026-08-19T06:12:44Z").toLocaleString('zh-TW', {
  timeZone: 'Asia/Taipei'
});
// → "2026/8/19 下午2:12:44"
```

前端已經知道使用者的時區（`Intl.DateTimeFormat().resolvedOptions().timeZone`），
而後端不知道（除非客戶端明確送上來）。

**例外：需要「營業日」語意的欄位**

```jsonc
{
  "createdAt": "2026-08-19T06:12:44Z",       // 精確時間點（UTC）
  "businessDate": "2026-08-19"                // 台灣營業日（Asia/Taipei）
}
```

**為什麼需要 `businessDate`**：

```
訂單 A：2026-08-19T15:30:00Z  = 台灣時間 8/19 23:30  → 營業日 8/19
訂單 B：2026-08-19T16:30:00Z  = 台灣時間 8/20 00:30  → 營業日 8/20
                ↑ 兩筆只差 1 小時，但屬於不同營業日
```

**如果只有 UTC 時間，前端要做「今日訂單統計」就會算錯**：
用 UTC 日期分組會把台灣的 8/20 早上 8 點前的訂單算進 8/19。

**這是真實的坑**：某電商的「每日銷售報表」在台灣時間早上 8 點前（UTC 0 點前）
會把當天的訂單算到前一天。財務對了三個月才發現。

**shop-service 的規則**：
- 所有 `xxxAt` 欄位一律 UTC `Instant`。
- 需要營業日語意的地方，**額外**提供 `businessDate`（`LocalDate`，基於 `Asia/Taipei`）。
- 報表類端點的日期參數（`?createdFrom=2026-08-01`）明確定義為**營業日**，並在文件寫清楚時區。

### 3.6.4 Java 型別對照

| JSON | Java 型別 | 說明 |
|---|---|---|
| `"2026-08-19T06:12:44Z"` | `Instant` | ★ 時間點的首選 |
| `"2026-08-19T06:12:44Z"` | `OffsetDateTime` | 需要保留原始偏移時用 |
| `"2026-08-19"` | `LocalDate` | 純日期 |
| `"09:00"` | `LocalTime` | 純時間 |
| `"PT2M30S"` | `Duration` | 時間長度 |
| `"P1Y2M"` | `Period` | 日期期間 |
| `3600` | `long` | 相對秒數（`expiresIn`） |

**不要用的型別**：

| 型別 | 為什麼不要 |
|---|---|
| `java.util.Date` | 可變、API 難用、沒有時區概念、已被 `java.time` 取代 |
| `java.sql.Timestamp` | 是 JDBC 型別，不該出現在 DTO |
| `LocalDateTime` | ⚠️ **沒有時區資訊** —— 這是最容易誤用的一個 |
| `Calendar` | 更糟 |

**`LocalDateTime` 為什麼危險**：

```java
// 資料庫存 2026-08-19 14:12:44（假設是台北時間，但欄位沒有時區資訊）
LocalDateTime t = entity.getCreatedAt();

// 序列化成 "2026-08-19T14:12:44"（沒有 Z，沒有偏移）
// 前端 new Date("2026-08-19T14:12:44") → 被當成「瀏覽器本地時區的 14:12」
// 台灣使用者：對的（碰巧）
// 日本使用者：以為是 JST 14:12，實際是 15:12 JST → 差 1 小時 🔴
// 美國使用者：差 12～15 小時 🔴
```

**`LocalDateTime` 只在「真的沒有時區概念」時才對**，例如：
「每天 09:00 開店」（不管在哪個分店的時區）。

### 3.6.5 Jackson 的設定

```yaml
spring:
  jackson:
    # 不要把日期寫成 timestamp 數字
    serialization:
      write-dates-as-timestamps: false
      write-durations-as-timestamps: false
    # 反序列化時遇到未知欄位不要報錯（見 3.13.4）
    deserialization:
      fail-on-unknown-properties: false
    default-property-inclusion: non_null
    time-zone: UTC
```

**`write-dates-as-timestamps: false` 很重要**。
Jackson 的 `JavaTimeModule` 預設會把 `Instant` 寫成 epoch 秒數的小數：

```jsonc
// 預設（❌ 難讀）
{ "createdAt": 1755583964.123456789 }

// 設定後（✅）
{ "createdAt": "2026-08-19T06:12:44.123456789Z" }
```

> ⚠️ Spring Boot 的 `JacksonAutoConfiguration` **預設已經**把
> `WRITE_DATES_AS_TIMESTAMPS` 設為 `false`。
> 但如果你自己 `new ObjectMapper()`（例如在測試或某個工具類裡），
> 就會拿到 Jackson 的原始預設值（`true`）→ 兩邊格式不一致。
> **一律注入容器的 `ObjectMapper`，不要自己 new。**

**精度控制**：`Instant` 預設會寫出奈秒精度（`.123456789Z`），
但 JavaScript 的 `Date` 只支援毫秒。

```java
// 統一截到毫秒（避免前端拿到無法表示的精度）
@Bean
Jackson2ObjectMapperBuilderCustomizer millisPrecision() {
    return builder -> builder.featuresToDisable(
        SerializationFeature.WRITE_DATE_TIMESTAMPS_AS_NANOSECONDS);
}
```

或在 mapper 層 `instant.truncatedTo(ChronoUnit.MILLIS)`。

---

## 3.7 `null`、缺欄位、空字串、空陣列

### 3.7.1 四種狀態的語意

| JSON | 語意 | 前端該顯示什麼 |
|---|---|---|
| 欄位不存在 | 「這個 API 版本沒有這個欄位」或「不適用」 | 不顯示這個區塊 |
| `"note": null` | 「有這個欄位，但沒有值」 | 顯示「—」或留白 |
| `"note": ""` | 「有值，值是空字串」 | ⚠️ 通常和 `null` 沒有實質差別 |
| `"tags": []` | 「集合存在，但沒有成員」 | 顯示「無標籤」 |
| `"tags": null` | 🔴 **不要出現** | `tags.map()` 直接爆炸 |

### 3.7.2 三條規則

**規則 1：集合永遠回 `[]`，絕不回 `null`**

```jsonc
// ✅
{ "items": [], "tags": [], "shipments": [] }

// ❌
{ "items": null }
```

**為什麼這條這麼重要**：

```javascript
// 前端
order.items.map(i => <Item key={i.id} {...i} />)
// items 是 null → TypeError: Cannot read properties of null (reading 'map')
// → 整個頁面白畫面（React 未捕捉的錯誤會卸載整棵樹）
```

而如果是 `[]`，`[].map()` 回傳 `[]`，畫面正常顯示「無資料」。

**Java 端的保證方式**：

```java
// DTO 的 compact constructor 做防護
public record OrderDetail(
    String orderId,
    List<OrderItemResponse> items,
    List<String> allowedActions
) {
    public OrderDetail {
        items = items == null ? List.of() : List.copyOf(items);
        allowedActions = allowedActions == null ? List.of() : List.copyOf(allowedActions);
    }
}
```

`List.copyOf()` 同時做了兩件事：**防 null** + **變成不可變**（外部不能改動 DTO 內部）。

⚠️ 注意 `List.copyOf()` 遇到含 `null` 元素的 list 會拋 NPE。
如果來源可能有 null 元素，先過濾。

**Map 同理**：`Map.of()` / `Map.copyOf()`。

**規則 2：選填的純量欄位用「省略」而不是 `null`**

```yaml
spring:
  jackson:
    default-property-inclusion: non_null
```

```jsonc
// 設定後：note 是 null 時整個欄位不出現
{ "orderId": "ord_1", "orderNumber": "ORD-...", "status": "PAID" }

// 而不是
{ "orderId": "ord_1", "orderNumber": "ORD-...", "status": "PAID", "note": null,
  "internalNote": null, "couponCode": null, "cancelledAt": null, ... }
```

**好處**：payload 明顯變小（一個有 30 個欄位、其中 15 個是 null 的物件可以省一半）。

**壞處與注意事項**：

| 問題 | 說明 |
|---|---|
| 前端要用 optional chaining | `order.note?.length` 而不是 `order.note.length` —— 但這本來就該做 |
| **無法區分「不適用」與「無值」** | ⚠️ 有時你需要這個區分 |
| TypeScript 型別要標 optional | `note?: string` 而不是 `note: string \| null` |

**「需要區分」的例子**：

```jsonc
// 訂單還沒取消
{ "status": "PAID" }                                    // cancelledAt 省略

// 訂單已取消
{ "status": "CANCELLED", "cancelledAt": "2026-08-19T..." }
```

這裡「省略」是對的（未取消的訂單沒有取消時間，這個欄位不適用）。

```jsonc
// 但這個情況呢？
{ "customerId": "cus_1", "phone": "0912345678" }         // 有電話
{ "customerId": "cus_2" }                                 // 沒填電話？還是沒權限看？
```

如果「沒權限看」和「使用者沒填」都表現為「欄位消失」，前端就無法正確顯示
（該顯示「未提供」還是「已隱藏」？）。

**解法**：需要區分時，明確用 `null` 或用專用標記：

```jsonc
{ "customerId": "cus_2", "phone": null }                  // 使用者沒填
{ "customerId": "cus_2", "phone": "****5678", "phoneMasked": true }  // 有值但遮蔽
```

**shop-service 的規則**：
- 預設 `non_null`（省略）。
- **需要區分「不適用」與「無值」的欄位，用 `@JsonInclude(ALWAYS)` 個別覆寫。**

```java
public record CustomerDetail(
    String customerId,
    String displayName,
    @JsonInclude(JsonInclude.Include.ALWAYS)   // 明確永遠出現
    String phone,
    String internalNote                         // 沒權限看就省略
) {}
```

**規則 3：`PATCH` 的 `null` 語意要明確定義**

第 02 章 2.5.4 已詳述。摘要：

```
Response 的 null  = 「沒有值」
Request 的 null   = 「請清空這個欄位」（Merge Patch 語意）
Request 的欄位缺少 = 「不要動這個欄位」
```

**這兩個方向的 `null` 語意不同，是最容易搞混的地方。**
在 OpenAPI 裡要分別標註 request schema 和 response schema 的 `nullable`。

### 3.7.3 空字串的處理

```jsonc
{ "note": "" }
```

**問題：空字串和 `null` 有差別嗎？**

實務上 99% 的情況**沒有**。所以最好的做法是**正規化**：

```java
// 在 DTO 的 compact constructor 或 mapper 層
static String blankToNull(String s) {
    return (s == null || s.isBlank()) ? null : s.trim();
}
```

**這同時處理了三個常見問題**：

```
"" 　　　　　→ null    （空字串）
"   " 　　　→ null    （只有空白）
" 王小明 "  → "王小明"  （前後空白，使用者複製貼上很常見）
```

**⚠️ 但要注意「trim 會改變資料」的例外**：

| 欄位 | 該 trim 嗎 |
|---|---|
| 姓名、地址、備註 | ✅ 該 trim |
| 密碼 | ❌ **絕對不要** —— 空白可能是密碼的一部分 |
| API key、token | ❌ 不要 |
| 使用者自訂的程式碼片段、Markdown | ❌ 不要（前後換行可能有意義） |

**驗證層面**：`@NotBlank` 已經處理了「空字串和只有空白」：

```java
@NotNull   // 只檢查非 null（"" 會通過）
@NotEmpty  // 檢查非 null 且長度 > 0（"   " 會通過）
@NotBlank  // 檢查非 null 且 trim 後長度 > 0  ← ★ 字串欄位用這個
```

**這三個的差別是面試常考題，也是實際會出錯的地方**：

```java
@NotEmpty String recipient;    // 送 "   " → 通過驗證 → 資料庫存了三個空白 🔴
@NotBlank String recipient;    // 送 "   " → 422 ✅
```

---

## 3.8 巢狀、展開與欄位篩選

### 3.8.1 三種關聯的表達方式

以「訂單的客戶資訊」為例：

**方式 A：只給 ID（reference）**

```jsonc
{ "orderId": "ord_1", "customerId": "cus_48213" }
```

✅ payload 最小、後端最快。
❌ 前端要顯示客戶名 → 多打一次 `GET /customers/cus_48213`
   → 列表 20 筆 = **20 次額外請求**（N+1 API，第 00 章 0.3.1）。

**方式 B：內嵌最小資訊（embedded reference）★ 推薦**

```jsonc
{
  "orderId": "ord_1",
  "customer": {
    "customerId": "cus_48213",
    "displayName": "王小明"
  }
}
```

✅ 前端可以直接顯示，不用額外請求。
✅ payload 只多一個欄位。
✅ 需要完整資料時仍可打 `GET /customers/cus_48213`。

**這是 90% 情況的正確答案。** 關鍵是**只放「顯示必需」的欄位**：

```
customer:  customerId + displayName（不含 email、phone、地址）
product:   productId + name + imageUrl（不含描述、規格、庫存）
coupon:    code + discountAmount（不含使用條件、有效期詳情）
```

**方式 C：完整內嵌（full embed）**

```jsonc
{
  "orderId": "ord_1",
  "customer": {
    "customerId": "cus_48213", "displayName": "王小明",
    "email": "wang@example.com", "phone": "0912345678",
    "addresses": [ ... ], "orderCount": 42, ...
  }
}
```

❌ payload 爆炸、後端要多查一堆表、可能洩漏欄位。
⚠️ 只在「客戶端一定需要全部」時才用（很少）。

### 3.8.2 `?expand=`：讓客戶端決定要不要展開

```http
GET /orders/ord_1
→ { "orderId": "ord_1", "itemCount": 3, ... }        // 不含 items

GET /orders/ord_1?expand=items
→ { "orderId": "ord_1", "itemCount": 3, "items": [...] }

GET /orders/ord_1?expand=items,shipments,payments
→ 全部展開
```

**設計規則**：

| 規則 | 說明 |
|---|---|
| 白名單 | 只允許明確列出的值，未知值回 `400`（不要靜默忽略） |
| 深度限制 | 只允許一層（`expand=items` ✅，`expand=items.product.reviews` ❌） |
| 數量限制 | 最多 3～5 個（否則變成 GraphQL 的劣化版） |
| 對列表要更嚴格 | `GET /orders?expand=items` 會讓 20 筆訂單各展開明細 → 要限制 `size` |
| 文件要寫清楚 | 每個可 expand 的值會增加多少資料、多少延遲 |

**實作要注意 N+1**：

```java
// ❌ 每筆訂單各查一次 items
orders.stream().map(o -> toDetail(o, itemRepo.findByOrderId(o.getId())))

// ✅ 一次查完再分組（batch loading）
Map<String, List<OrderItem>> itemsByOrder = itemRepo
        .findByOrderIdIn(orderIds)
        .stream()
        .collect(Collectors.groupingBy(OrderItem::getOrderId));
orders.stream().map(o -> toDetail(o, itemsByOrder.getOrDefault(o.getId(), List.of())))
```

**這是 `?expand=` 的隱藏成本**：每一個可 expand 的關聯，
你都要實作一次 batch loading，否則就是 N+1。
（08-jpa-mybatis 會講 `JOIN FETCH`、`@EntityGraph`、`@BatchSize` 三種解法。）

**`?expand=` 對列表的限制範例**：

```
GET /orders?size=20&expand=items          ✅ 允許
GET /orders?size=100&expand=items         ❌ 400：expand 時 size 上限為 20
GET /orders?size=100                       ✅ 允許（不展開時上限 100）
```

```jsonc
// 錯誤回應
{
  "type": "https://api.shop.example/problems/expand-size-limit",
  "title": "使用 expand 時分頁大小受限",
  "status": 400,
  "detail": "When expand includes 'items', size must be <= 20. Requested size=100.",
  "code": "EXPAND_SIZE_LIMIT_EXCEEDED",
  "maxSizeWithExpand": 20
}
```

### 3.8.3 `?fields=`：稀疏欄位集（sparse fieldsets）

```http
GET /orders?fields=orderId,orderNumber,status,totalAmount
→ { "items": [ { "orderId": "...", "orderNumber": "...",
                 "status": "PAID", "totalAmount": "1280.50" } ], ... }
```

**適合的場景**：
- 行動網路，要極小的 payload。
- 匯出／同步，只要幾個欄位。
- 下拉選單只要 `id` + `name`。

**不適合的場景**：
- 大部分一般 API（增加複雜度但省不了多少）。

**四個實作陷阱**：

| 陷阱 | 說明 |
|---|---|
| ID 要強制包含 | 否則前端拿到一堆無法識別的物件 |
| 巢狀語法要定義 | `fields=customer.displayName`？還是 `fields[customer]=displayName`（JSON:API 風格）？ |
| 快取鍵要包含 `fields` | 否則 `?fields=a` 的回應會被當成 `?fields=a,b` 的快取 🔴 |
| 不能省下資料庫查詢 | 除非你動態組 SQL —— 通常只省網路，不省後端 |

**最後一項要說清楚**：很多人以為 `?fields=` 能讓資料庫少查。
實際上除非你動態產生 `SELECT` 欄位（JPA 用 projection、MyBatis 動態 SQL），
否則後端還是查全部、只是序列化時篩掉。**省的是頻寬，不是資料庫負載。**

**shop-service 的決定**：
- ✅ 提供 `?expand=`（解決 under-fetching / N+1 API，價值明確）。
- ❌ **不提供** `?fields=`（複雜度高、收益低）。改為設計好 `Summary` / `Detail` 兩種粒度。
- 如果未來真的有極端頻寬需求，再加。

**這是一個「不做」的決定，而且是有理由的不做。**
API 設計最常見的錯誤之一就是「把所有可能的彈性都做出來」，
結果每個功能都要維護、測試、寫文件，而且 90% 沒人用。

### 3.8.4 決策表

| 需求 | 做法 |
|---|---|
| 前端要顯示關聯物件的名稱 | 方式 B（內嵌最小資訊） |
| 前端有時要明細、有時不要 | `?expand=items` |
| 前端幾乎總是要明細 | 直接內嵌（不用 expand） |
| 前端幾乎從不要明細 | 只給 `itemCount` + 獨立端點 `/orders/{id}/items` |
| 不同前端需要差很多的欄位 | 兩個粒度（`Summary` / `Detail`）；差異真的很大才考慮 BFF |
| 頻寬極度受限 | `?fields=`（但先確認真的需要） |

---

## 3.9 要不要統一包裝層

### 3.9.1 兩種風格

**風格 A：直接回資源（★ 本課程採用）**

```jsonc
// GET /orders/ord_1  →  200
{ "orderId": "ord_1", "status": "PAID", "totalAmount": "1280.50" }

// GET /orders  →  200
{
  "items": [ {...}, {...} ],
  "page": { "number": 0, "size": 20, "totalElements": 1523, "totalPages": 77 }
}

// 錯誤  →  409 + application/problem+json
{ "type": "...", "title": "庫存不足", "status": 409, "code": "INSUFFICIENT_STOCK" }
```

**風格 B：統一包裝**

```jsonc
// 成功
{ "code": 0, "message": "success", "data": { "orderId": "ord_1", ... } }

// 錯誤
{ "code": 40901, "message": "庫存不足", "data": null }
```

### 3.9.2 包裝層的論點與反駁

| 支持包裝的論點 | 反駁 |
|---|---|
| 「前端可以統一處理」 | 統一**錯誤格式**就能達成（第 04 章），不需要包裝**成功**回應 |
| 「HTTP 狀態碼不夠細，需要業務碼」 | 業務碼可以放在 Problem Details 的 `code` 欄位，不必包裝整個回應 |
| 「舊系統／閘道會吃掉 4xx/5xx」 | ✅ 這是真問題 —— 但正確解法是修閘道；折衷見第 02 章 2.12.4 |
| 「所有回應結構一致，好寫 SDK」 | ⚠️ 有一點道理，但代價是每次取值都要 `.data`，且 OpenAPI 的 schema 變成 `data: object`（失去型別） |
| 「我們公司規範就是這樣」 | 這是真實約束。至少讓狀態碼正確（第 02 章 2.12.4 方案 A） |

**反對包裝的六個具體理由**：

**理由 1：多一層 `.data` 是永久的稅**

```typescript
// 包裝
const order = (await api.get('/orders/1')).data.data;    // 兩層 data 🤦
const items = (await api.get('/orders')).data.data.items; // 三層

// 不包裝
const order = (await api.get('/orders/1')).data;
```

而且每個 SDK、每個 mock、每個測試都要記得這一層。

**理由 2：OpenAPI 的型別會退化**

```yaml
# 包裝：data 是什麼型別？
ApiResponse:
  properties:
    code: { type: integer }
    message: { type: string }
    data: { type: object }        # ← 型別資訊消失了

# 要保留型別必須為每個端點造一個 wrapper schema
OrderDetailApiResponse:
  properties:
    code: { type: integer }
    message: { type: string }
    data: { $ref: '#/components/schemas/OrderDetail' }
# → 端點數量 × 2 個 schema
```

Java 端也一樣：`ApiResponse<OrderDetail>`、`ApiResponse<PageResponse<OrderSummary>>`…
泛型層層嵌套，而且 Swagger UI 顯示起來很難讀。

**理由 3：`code: 0` 是多餘的**

如果狀態碼是 `200`，那 `code: 0` 沒有提供任何資訊。
如果狀態碼是 `409`，`code: 40901` 有價值 —— 但它應該在錯誤格式裡。

**理由 4：`message: "success"` 從來沒人看**

**理由 5：它常常是「全部回 200」的共犯**

有了包裝層，很容易就滑坡成「反正 code 會說明，狀態碼就都回 200 吧」。
第 02 章 2.12 列了五個損失。

**理由 6：`204` 沒有 body，包裝層無處可放**

```
DELETE /orders/1001 → 204（無 body）
```

包裝層的規則「所有回應都是 `{code, message, data}`」在這裡就破功了。
於是有人改成回 `200` + `{code:0, data:null}` —— 又是一個為了形式犧牲語意的例子。

### 3.9.3 shop-service 的決定與混合策略

```
成功回應：直接回資源（風格 A）
集合回應：{ items, page } 外殼（這是「分頁資訊」，不是「包裝層」）
錯誤回應：application/problem+json（RFC 9457，第 04 章）
狀態碼：  一律正確
```

**注意「集合外殼」和「包裝層」的區別**：

```jsonc
// ✅ 集合外殼 —— page 是這個資源本身的一部分（分頁是集合的屬性）
{
  "items": [...],
  "page": { "number": 0, "size": 20, "totalElements": 1523 }
}

// ❌ 包裝層 —— code/message 和資源本身無關
{ "code": 0, "message": "success", "data": { "items": [...] } }
```

**判準：這個欄位是「資源的資訊」還是「傳輸的資訊」？**
資源的資訊（分頁、連結）→ 可以在 body。
傳輸的資訊（成功/失敗、狀態碼）→ 用 HTTP 機制（狀態碼、header）。

### 3.9.4 如果你必須用包裝層

**把傷害降到最低的五條規則**：

```
1. 狀態碼一定要正確（最重要，第 02 章 2.12.4 方案 A）
2. code 用有意義的字串而不是數字（"INSUFFICIENT_STOCK" 而不是 40901）
   —— 數字碼需要對照表，字串碼自我描述
3. 錯誤時額外提供 errors 陣列（驗證錯誤要能定位到欄位，第 04 章 4.6）
4. 一定要有 traceId
5. 在 OpenAPI 裡為每個端點產生正確的 wrapper schema（不要用 data: object）
```

```jsonc
// 折衷後的樣子（狀態碼 409）
{
  "code": "INSUFFICIENT_STOCK",
  "message": "庫存不足",
  "data": null,
  "details": { "productId": "P-1001", "requested": 5, "available": 3 },
  "traceId": "4f2c8a1e9b7d3f60"
}
```

這樣：監控靠狀態碼、前端靠 `code`、除錯靠 `traceId`、恢復靠 `details`。
**不完美，但可用。**

---

## 3.10 列舉設計與演進

### 3.10.1 第 00 章 0.8.3 的災難複習

新增一個列舉值 `PARTIALLY_SHIPPED`，導致 App 的 `switch` 沒有 `default`，
狀態文字空白 + 物流按鈕消失 + 400 通客訴 + 7 天修復。

**這一節要給出完整的預防方案。**

### 3.10.2 三個層次的防護

**層次 1：契約裡明確宣告「這個列舉會擴充」**

```yaml
# orders-api.yaml
OrderStatus:
  type: string
  enum:
    - PENDING_PAYMENT
    - PAID
    - PARTIALLY_SHIPPED
    - SHIPPED
    - COMPLETED
    - CANCELLED
    - RETURNED
  x-extensible-enum: true          # ← 非標準但常見的慣例
  description: |
    ⚠️ 此列舉未來會新增值。客戶端「必須」處理未知值：
      - 顯示：使用回應中的 statusLabel 欄位，不要自己維護對照表
      - 邏輯：使用 allowedActions 判斷可執行的操作，不要用 status 判斷
      - 兜底：switch 必須有 default 分支
    新增值會在 CHANGELOG 公告，但不視為破壞性變更。
```

**光是把這段話寫進文件，就能讓 80% 的客戶端開發者加上 `default`。**

**層次 2：後端提供「顯示用」與「邏輯用」的替代欄位 ★ 最有效**

```jsonc
{
  "status": "PARTIALLY_SHIPPED",           // 機器用（可能是未知值）
  "statusLabel": "部分出貨",                // 顯示用（後端翻譯，永不是未知）
  "statusCategory": "IN_PROGRESS",          // 粗粒度分類（穩定，很少擴充）
  "allowedActions": ["VIEW_SHIPMENT", "CONTACT_SUPPORT"]   // 邏輯用
}
```

**這三個欄位各自解決一個問題**：

| 欄位 | 解決 |
|---|---|
| `statusLabel` | 前端不用維護 status → 中文的對照表 → **新增狀態不會顯示空白** |
| `statusCategory` | 前端要分組（「進行中」/「已完成」/「已取消」）→ 用粗粒度分類，細分類擴充不影響 |
| `allowedActions` | 前端不用寫 `if (status === 'SHIPPED') showTrackingButton()` → **業務規則只在後端一份** |

**`statusCategory` 的設計**：

```
IN_PROGRESS：PENDING_PAYMENT, PAID, PARTIALLY_SHIPPED, SHIPPED
DONE：       COMPLETED
CANCELLED：  CANCELLED, RETURNED
```

粗粒度分類**很少會新增**，所以前端可以安全地 `switch` 它。
細分類再怎麼擴充，都會落進既有的某個 category。

⚠️ **`statusLabel` 的 i18n 問題**：後端翻譯需要知道語言。

```http
GET /orders/ord_1
Accept-Language: zh-TW

→ { "status": "PAID", "statusLabel": "已付款" }
```

```http
Accept-Language: en

→ { "status": "PAID", "statusLabel": "Paid" }
```

**如果你不想做 i18n**，選項是：
- 只回 `status`，讓前端自己翻譯（但要接受「新狀態顯示空白」的風險 → 前端必須有 fallback）。
- 回 `statusLabel` 但只有一種語言（單一市場的產品可以接受）。
- 回 `messageKey` 讓前端查自己的翻譯檔（`"order.status.paid"`）—— 
  **這個折衷很好**：新增 key 時前端沒有翻譯會顯示 key 本身（`order.status.partially_shipped`），
  雖然醜但不會空白，而且工程師一看就知道要補翻譯。

**shop-service 的決定**：回 `status` + `statusLabel`（依 `Accept-Language`，支援 zh-TW / en）
+ `statusCategory` + `allowedActions`。

**層次 3：Java 端安全地反序列化未知值**

如果你是 API 的**客戶端**（例如呼叫金流商 API），要處理對方新增列舉值：

```java
// ❌ 遇到未知值會拋 InvalidFormatException → 整個回應解析失敗
public enum PaymentStatus { PENDING, SUCCEEDED, FAILED }

// ✅ 方案 1：Jackson 全域設定
spring.jackson.deserialization.read-unknown-enum-values-using-default-value: true
// 配合
public enum PaymentStatus {
    PENDING, SUCCEEDED, FAILED,
    @JsonEnumDefaultValue UNKNOWN        // ← 未知值落到這裡
}

// ✅ 方案 2：用 String 收，自己轉（最安全）
public record PaymentResponse(String status) {
    public PaymentStatus statusOrUnknown() {
        try { return PaymentStatus.valueOf(status); }
        catch (IllegalArgumentException e) { return PaymentStatus.UNKNOWN; }
    }
}
```

**方案 2 的額外好處**：你保留了原始字串。
log 裡會顯示 `status=PARTIALLY_REFUNDED`（未知但可讀），
而不是 `status=UNKNOWN`（資訊全失）。

### 3.10.3 列舉值的命名規則

```
✅ UPPER_SNAKE_CASE          PENDING_PAYMENT
❌ camelCase                 pendingPayment
❌ 有空白                     "pending payment"
❌ 中文                       "待付款"（列舉是機器用的，顯示用 statusLabel）
❌ 數字                       2
```

**額外規則**：

| 規則 | 理由 |
|---|---|
| 不要用 `OTHER` / `MISC` | 它會變成垃圾桶，語意隨時間漂移 |
| 不要用否定命名 | `NOT_SHIPPED` 難以組合；用 `PENDING_SHIPMENT` |
| 前綴要一致 | `PENDING_PAYMENT` / `PENDING_SHIPMENT` ✅；`PENDING_PAYMENT` / `AWAITING_SHIPMENT` ❌ |
| 保留 `UNKNOWN` | 給客戶端當 fallback 用 |

### 3.10.4 什麼時候「新增列舉值」是破壞性變更

| 情境 | 破壞性？ |
|---|---|
| **Response** 的列舉新增值 | ⚠️ **對沒有 default 的客戶端是**。要公告，但通常不需要新版本 |
| **Request** 的列舉新增值 | ✅ 相容（客戶端不送新值就沒事） |
| **Request** 的列舉**移除**值 | 🔴 破壞性（客戶端可能還在送） |
| **Response** 的列舉移除值 | ⚠️ 通常安全（客戶端的 case 只是用不到），但如果客戶端有 exhaustive check（Kotlin `when`、TS `never` 檢查）會編譯失敗 |
| 改變列舉值的**語意** | 🔴🔴 最危險（第 00 章 0.8.2） |

**「改變語意」的例子**：

```
v1：SHIPPED 表示「已交給物流」
v2：SHIPPED 表示「已送達」   ← 🔴 值沒變、型別沒變，但意思變了
```

所有客戶端的邏輯全部靜默錯誤，而且測試不會發現（因為值一樣）。
**改語意必須改名字**（第 00 章 0.8.3 的教訓）。

---

## 3.11 集合回應的外殼

### 3.11.1 三種常見設計

**設計 A：裸陣列**

```jsonc
[ { "orderId": "ord_1" }, { "orderId": "ord_2" } ]
```

❌ 不推薦。理由：
- **無法加分頁資訊**（要加就得改結構 → 破壞性變更）。
- **無法加 metadata**（總數、聚合值、警告訊息）。
- ⚠️ 歷史上 JSON 陣列頂層有過 CSRF 相關的安全問題（俗稱 **JSON hijacking**），
  現代瀏覽器已修，但仍有一些安全指南建議避免。

**設計 B：`items` + `page` ★ 本課程採用**

```jsonc
{
  "items": [ {...}, {...} ],
  "page": {
    "number": 0,
    "size": 20,
    "totalElements": 1523,
    "totalPages": 77
  }
}
```

**設計 C：Spring Data `Page` 的預設序列化**

```jsonc
{
  "content": [ ... ],
  "pageable": { "pageNumber": 0, "pageSize": 20, "sort": {...}, "offset": 0, ... },
  "totalElements": 1523,
  "totalPages": 77,
  "last": false, "first": true, "numberOfElements": 20, "empty": false,
  "size": 20, "number": 0, "sort": { "sorted": true, ... }
}
```

**🔴 絕對不要直接把 `Page<T>` 當回應。** 五個理由：

| 問題 | 說明 |
|---|---|
| 欄位冗餘 | `size` / `pageable.pageSize`、`number` / `pageable.pageNumber` 重複 |
| 洩漏內部結構 | `Pageable` 是 Spring Data 的內部型別，不該是你的 API 契約 |
| **會變** | Spring Boot 升版時序列化結構改過 —— Boot 3.3 起會印警告，並建議用 `PagedModel` |
| OpenAPI 難描述 | 產生出來的 schema 很醜 |
| 命名風格可能不一致 | 它不遵守你的 style guide |

> Spring Boot 3.3+ 會對「直接序列化 `Page`」印出警告，
> 並提供 `spring.data.web.pageable.serialization-mode` 與 `PagedModel` 包裝。
> **但最好的做法還是自己定義 DTO** —— 你的 API 契約應該由你決定。

**shop-service 的 `PageResponse`**：

```java
public record PageResponse<T>(
    List<T> items,
    PageInfo page
) {
    public record PageInfo(
        int number,
        int size,
        long totalElements,
        int totalPages
    ) {}

    public static <T> PageResponse<T> of(org.springframework.data.domain.Page<?> p,
                                         List<T> items) {
        return new PageResponse<>(
            items == null ? List.of() : List.copyOf(items),
            new PageInfo(p.getNumber(), p.getSize(), p.getTotalElements(), p.getTotalPages())
        );
    }
}
```

（游標分頁、`totalElements` 的效能代價、`Link` header 等在第 05 章詳談。）

### 3.11.2 集合外殼的額外欄位

有時候集合需要攜帶更多資訊：

```jsonc
{
  "items": [ ... ],
  "page": { "number": 0, "size": 20, "totalElements": 1523, "totalPages": 77 },
  "aggregates": {
    "totalAmount": "1928450.00",
    "currency": "TWD",
    "statusCounts": { "PAID": 812, "SHIPPED": 445, "COMPLETED": 266 }
  },
  "warnings": [
    { "code": "RESULT_TRUNCATED",
      "message": "篩選條件符合超過 10000 筆，僅回傳前 10000 筆的統計" }
  ]
}
```

**`aggregates` 的價值**：管理後台的「訂單列表」上方通常有幾個統計卡片。
如果沒有這個欄位，前端要另外打 `GET /orders/statistics?同樣的篩選條件` ——
**兩次查詢，而且篩選條件要保持同步（很容易不一致）**。

⚠️ **但 `aggregates` 有成本**：它需要額外的聚合查詢（可能很慢）。
所以應該是**選加**的：

```http
GET /orders?status=PAID&include=aggregates
```

**`warnings` 的價值**：讓 API 可以「成功但有話要說」。
比「回 200 但資料悄悄被截斷」好得多。

---

## 3.12 Content-Type 與內容協商

### 3.12.1 請求方向

```http
POST /orders
Content-Type: application/json; charset=utf-8
```

| 情況 | 回應 |
|---|---|
| `Content-Type` 缺少（且有 body） | `415`（Spring 的行為）或 `400` |
| `Content-Type: text/plain` 但端點只吃 JSON | `415 Unsupported Media Type` |
| `Content-Type: application/json` 但 body 不是合法 JSON | `400` |
| `Content-Type: application/merge-patch+json` 但端點沒宣告 | `415` |

**`charset` 要不要寫**：`application/json` 依 RFC 8259 **一律是 UTF-8**，
所以 `charset` 是多餘的。但寫了也無害（有些老客戶端會送）。

**Spring 的 `consumes` 設定**：

```java
@PostMapping(value = "/orders", consumes = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<OrderDetail> create(@Valid @RequestBody CreateOrderRequest req) { ... }

// PATCH 要同時接受兩種（向下相容）
@PatchMapping(value = "/orders/{id}",
              consumes = { "application/merge-patch+json", MediaType.APPLICATION_JSON_VALUE })
public OrderDetail patch(@PathVariable String id, @RequestBody ObjectNode patch) { ... }
```

### 3.12.2 回應方向

```http
GET /orders/ord_1
Accept: application/json
```

| 情況 | 回應 |
|---|---|
| `Accept: application/json` | `200` + JSON |
| `Accept: */*` | `200` + 預設格式（JSON） |
| `Accept` 缺少 | `200` + 預設格式 |
| `Accept: application/xml`（你不支援） | `406 Not Acceptable` |
| 錯誤回應 | `application/problem+json`（第 04 章） |

**`406` vs `415` 的記法**：

```
415 = 我看不懂「你送來的」        （Content-Type 問題）
406 = 我做不出「你想要的」        （Accept 問題）
```

### 3.12.3 多格式支援（如果需要）

```http
GET /orders/ord_1/invoice
Accept: application/pdf          → PDF
Accept: application/json         → JSON
Accept: text/csv                 → CSV
```

```java
@GetMapping(value = "/orders/{id}/invoice",
            produces = { MediaType.APPLICATION_JSON_VALUE, MediaType.APPLICATION_PDF_VALUE })
public ResponseEntity<?> invoice(@PathVariable String id,
                                 @RequestHeader(value = "Accept", defaultValue = "application/json") String accept) {
    ...
}
```

**但要注意快取**：多格式的端點**必須**回 `Vary: Accept`，
否則 CDN 可能把 PDF 版本快取後給要 JSON 的客戶端。

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Vary: Accept                     ← ★ 必須
```

**`Vary` 的完整清單**（很容易漏）：

| 你用了什麼協商 | 要加的 `Vary` |
|---|---|
| `Accept`（多格式） | `Vary: Accept` |
| `Accept-Language`（i18n，例如 `statusLabel`） | `Vary: Accept-Language` |
| `Authorization`（不同使用者不同資料） | `Vary: Authorization` 或直接 `Cache-Control: private` |
| `Origin`（CORS） | `Vary: Origin` |
| 自訂 header（`X-Api-Version`） | `Vary: X-Api-Version` |

**漏掉 `Vary` 的後果是快取污染** —— 這是第 00 章 0.4.2 約束 3 那個「個資外洩」事故的機制之一。

### 3.12.4 檔案上傳的 Content-Type

```http
POST /products/P-1001/images
Content-Type: multipart/form-data; boundary=----abc
```

**⚠️ 絕對不要信任客戶端送的 `Content-Type`**：

```java
// ❌ 只檢查宣告的 content type
if (!file.getContentType().startsWith("image/")) throw new ValidationException(...);
// 攻擊者可以送 Content-Type: image/jpeg 但內容是 .exe 或 .jsp

// ✅ 檢查實際的 magic bytes
byte[] head = new byte[12];
try (InputStream in = file.getInputStream()) { in.read(head); }
if (!isJpeg(head) && !isPng(head) && !isWebp(head)) {
    throw new UnsupportedMediaTypeException("僅支援 JPEG / PNG / WebP");
}
// 更好：用 Apache Tika 偵測，並且重新編碼圖片（去除 EXIF、去除嵌入的惡意內容）
```

三層防護：
1. 檢查宣告的 `Content-Type`（快速篩掉明顯錯的）。
2. 檢查 magic bytes（防偽造）。
3. **重新編碼**（`ImageIO.read()` + `write()`）—— 這一步同時去除 EXIF 個資
   （GPS 座標！）和任何嵌在圖片裡的 payload。

---

## 3.13 大小限制、深度限制與安全

### 3.13.1 為什麼需要限制

```json
{"a":{"a":{"a":{"a":{"a": ... 重複 100000 層 ... }}}}}
```

這叫 **JSON bomb / billion laughs 的 JSON 變體**。後果：

| 攻擊 | 後果 |
|---|---|
| 深度巨大 | 遞迴解析 → `StackOverflowError` → 執行緒死掉 |
| 陣列超大（`[0,0,0,...]` 一百萬個） | 記憶體暴增 → OOM |
| 字串超長（10MB 的單一字串） | 記憶體 + CPU |
| 欄位數超多（一萬個 key） | HashMap 膨脹 |
| 巨大數字（`1e999999999`） | `BigDecimal` 解析炸掉 |

**一個請求就能打掉一台機器。** 而且這不需要認證（如果端點是公開的）。

### 3.13.2 四層防護

**第 1 層：Nginx / ALB**

```nginx
client_max_body_size 1m;          # 一般 API
# 上傳端點單獨放寬
location /products/ {
    client_max_body_size 10m;
}
```

**第 2 層：Spring Boot**

```yaml
server:
  tomcat:
    max-http-form-post-size: 1MB
    max-swallow-size: 2MB
  max-http-request-header-size: 16KB

spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 12MB
```

**第 3 層：Jackson StreamReadConstraints（Jackson 2.15+）★**

```java
@Bean
Jackson2ObjectMapperBuilderCustomizer jsonLimits() {
    return builder -> builder.postConfigurer(mapper ->
        mapper.getFactory().setStreamReadConstraints(
            StreamReadConstraints.builder()
                .maxNestingDepth(32)          // 巢狀深度（預設 1000）
                .maxStringLength(1_000_000)   // 單一字串長度（預設 20_000_000）
                .maxNumberLength(1_000)       // 數字字面長度（預設 1000）
                .maxNameLength(256)           // 欄位名長度
                .maxDocumentLength(2_000_000) // 整份文件（Jackson 2.16+）
                .build()));
}
```

> Jackson 2.15 起有預設的 `StreamReadConstraints`，
> 所以最嚴重的 JSON bomb 已經被擋掉了。但預設值對業務 API 來說仍然太寬鬆
> （1000 層巢狀、20MB 字串）—— **值得自己收緊。**

**第 4 層：Bean Validation（業務層面）**

```java
public record CreateOrderRequest(
    @NotEmpty
    @Size(max = 50, message = "單筆訂單最多 50 項商品")
    List<@Valid OrderItemRequest> items,

    @Size(max = 200, message = "備註最多 200 字")
    String customerNote
) {}

public record OrderItemRequest(
    @NotBlank @Size(max = 64) String productId,
    @NotNull @Min(1) @Max(999) Integer quantity
) {}
```

**四層都要有**，因為它們擋的是不同層次的問題：

```
Nginx      → 擋 100MB 的 body（不進 JVM）
Tomcat     → 擋 header 攻擊
Jackson    → 擋結構攻擊（深度、字串長度）
Validation → 擋業務層面的不合理值（50 項商品、999 個數量）
```

### 3.13.3 陣列長度的驗證陷阱

```java
// ❌ 這個檢查太晚了
@Size(max = 50) List<OrderItemRequest> items
```

`@Size` 是在 **Jackson 已經把整個陣列反序列化成 Java 物件之後**才檢查的。
如果攻擊者送 100 萬個元素，記憶體已經爆了。

**正確做法**：靠第 3 層（Jackson 的 `maxDocumentLength`）+ 第 1 層（Nginx 的 body size）先擋掉。
`@Size` 是給「善意但寫錯的客戶端」看的友善錯誤訊息，不是安全機制。

**這個區分很重要**：

```
安全機制  = Nginx / Jackson 限制（在資源被消耗前擋掉）
使用者體驗 = Bean Validation（給出可讀的錯誤訊息）
```

### 3.13.4 未知欄位要不要報錯

```http
POST /orders
{ "items": [...], "shippingAddressId": "addr_1", "hackerField": "x" }
```

| 策略 | 設定 | 取捨 |
|---|---|---|
| **寬鬆**（忽略未知欄位） | `fail-on-unknown-properties: false`（Spring Boot 預設） | ✅ 客戶端多送欄位不會壞<br>❌ 客戶端打錯欄位名（`shippingAddresId`）**靜默失敗** |
| **嚴格**（未知欄位回 400） | `fail-on-unknown-properties: true` | ✅ 立刻抓到拼錯<br>❌ 客戶端升級後多送新欄位會壞（相容性風險） |

**這是真實的兩難。看一個具體例子**：

```http
POST /orders
{ "items": [...], "shippingAddressld": "addr_1" }
                              ↑ 小寫 L 而不是 I（很難看出來）
```

- 寬鬆模式：`shippingAddressId` 是 `null` → `@NotBlank` 失敗 → `422` ✅ 還好有驗證
- 但如果那個欄位是**選填**的：`customerNotee` 打錯 → 備註沒存進去，**完全沒有錯誤** 🔴

**shop-service 的決定：寬鬆 + 補償措施**

```yaml
spring:
  jackson:
    deserialization:
      fail-on-unknown-properties: false
```

補償措施（三個）：

1. **必填欄位靠 `@NotBlank` / `@NotNull` 抓到**（打錯名字 = 沒送 = 驗證失敗）。
2. **在開發／測試環境開啟嚴格模式**：
   ```yaml
   # application-local.yml, application-test.yml
   spring:
     jackson:
       deserialization:
         fail-on-unknown-properties: true
   ```
   這樣前端在開發時就會發現拼錯，正式環境仍保持寬鬆的相容性。**這是最好的折衷。**
3. **記錄未知欄位**（不報錯但留下線索）：
   ```java
   public record CreateOrderRequest(
       List<OrderItemRequest> items,
       String shippingAddressId,
       String customerNote,
       @JsonAnySetter @JsonAnyGetter Map<String, Object> unknown   // 收集未知欄位
   ) {}
   // 在 Controller 記錄：if (!req.unknown().isEmpty()) log.warn("未知欄位: {}", req.unknown().keySet());
   ```
   然後在監控上看「哪些客戶端在送我們不認識的欄位」——
   通常代表對方版本不對或有誤解，值得主動聯絡。

**回應方向永遠寬鬆**：客戶端**必須**忽略未知欄位（這是可演進性的前提，第 06 章）。
要在文件裡明確要求。

### 3.13.5 敏感欄位的遮蔽

有時候你要回傳部分資訊：

```jsonc
{
  "phone": "0912***678",
  "email": "w***g@example.com",
  "cardLast4": "4242",
  "idNumber": "A12****789"
}
```

**遮蔽的三個原則**：

| 原則 | 說明 |
|---|---|
| 遮蔽在 **mapper 層**做，不在前端做 | 前端遮蔽等於「完整資料已經傳出去了」，devtools 一開就看到 |
| 留下足夠讓使用者確認的資訊 | `0912***678` 讓使用者知道是哪支手機；`***` 完全無用 |
| 遮蔽後**不能反推** | `cardLast4: "4242"` 安全（PCI DSS 允許）；`card: "4242-42**-****-4242"` 洩漏太多 |

**log 也要遮蔽**（很容易漏）：

```java
// ❌ toString() 會印出全部欄位
log.info("建立訂單: {}", req);
// → CreateOrderRequest[items=..., cardNumber=4242424242424242]  🔴

// ✅ record 覆寫 toString()
public record CreatePaymentRequest(String method, String cardToken, String cvv) {
    @Override
    public String toString() {
        return "CreatePaymentRequest[method=%s, cardToken=%s, cvv=***]"
                .formatted(method, mask(cardToken));
    }
}
```

（02-spring-boot 第 05 章講過結構化日誌與遮蔽，可回頭對照。）

---

## 3.14 shop-service 的 DTO 全家族

### 3.14.1 建立訂單

**Request**

```java
public record CreateOrderRequest(
    @NotEmpty(message = "訂單至少需要一項商品")
    @Size(max = 50, message = "單筆訂單最多 50 項商品")
    List<@Valid Item> items,

    @NotBlank(message = "收件地址為必填")
    @Size(max = 64)
    String shippingAddressId,

    @Size(max = 32)
    String couponCode,

    @Size(max = 200)
    String customerNote,

    @Valid
    InvoiceRequest invoice
) {
    public record Item(
        @NotBlank @Size(max = 64) String productId,
        @NotNull @Min(1) @Max(999) Integer quantity
    ) {}

    public record InvoiceRequest(
        @NotNull InvoiceType type,                       // PERSONAL / COMPANY / DONATION
        @Pattern(regexp = "\\d{8}", message = "統一編號須為 8 位數字")
        String taxId,                                     // COMPANY 時必填
        @Size(max = 60) String companyName,
        @Pattern(regexp = "/[0-9A-Z+\\-.]{7}", message = "載具號碼格式錯誤")
        String carrierId,                                 // 手機條碼載具
        @Size(max = 10) String donationCode               // DONATION 時必填
    ) {}
}
```

```jsonc
// POST /orders
{
  "items": [
    { "productId": "P-1001", "quantity": 2 },
    { "productId": "P-2003", "quantity": 1 }
  ],
  "shippingAddressId": "addr_01J5GK...",
  "couponCode": "SUMMER20",
  "customerNote": "麻煩包裝仔細一點",
  "invoice": { "type": "PERSONAL", "carrierId": "/ABC+123" }
}
```

**注意 Request 裡沒有的欄位**：
`unitPrice`、`totalAmount`、`status`、`orderNumber`、`createdAt` ——
**全部由伺服器決定**（3.3.2 的鐵律）。

**跨欄位驗證**（`type=COMPANY` 時 `taxId` 必填）：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = InvoiceConsistencyValidator.class)
public @interface ValidInvoice { String message() default "發票資訊不完整"; ... }

public class InvoiceConsistencyValidator
        implements ConstraintValidator<ValidInvoice, CreateOrderRequest.InvoiceRequest> {
    @Override
    public boolean isValid(CreateOrderRequest.InvoiceRequest v, ConstraintValidatorContext ctx) {
        if (v == null) return true;
        return switch (v.type()) {
            case COMPANY  -> hasText(v.taxId()) && hasText(v.companyName());
            case DONATION -> hasText(v.donationCode());
            case PERSONAL -> true;
        };
    }
}
```

⚠️ **類別層級的驗證錯誤要定位到欄位**（否則前端不知道標哪裡）——
第 04 章 4.6 會講怎麼用 `addPropertyNode()` 產生正確的 `field` 值。

**Response（`201`）**

```jsonc
{
  "orderId": "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
  "orderNumber": "ORD-20260819-0001",
  "status": "PENDING_PAYMENT",
  "statusLabel": "待付款",
  "statusCategory": "IN_PROGRESS",
  "allowedActions": ["PAY", "CANCEL", "EDIT_INVOICE"],
  "amounts": {
    "subtotal": "1500.00",
    "discount": "-300.00",
    "shippingFee": "80.50",
    "tax": "0.00",
    "total": "1280.50"
  },
  "currency": "TWD",
  "itemCount": 3,
  "appliedCoupon": { "code": "SUMMER20", "discountAmount": "-300.00" },
  "createdAt": "2026-08-19T06:12:44Z",
  "expiresAt": "2026-08-19T06:42:44Z",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

`Location: /orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR`

**`expiresAt` 是很實用的欄位**：未付款訂單 30 分鐘後自動取消。
有了它，前端可以顯示倒數計時，而不用寫死「30 分鐘」這個規則。

### 3.14.2 訂單摘要（列表）

```java
public record OrderSummary(
    String orderId,
    String orderNumber,
    String status,
    String statusLabel,
    String statusCategory,
    String totalAmount,
    String currency,
    int itemCount,
    String thumbnailUrl,         // 第一項商品的圖（列表要顯示）
    Instant createdAt
) {}
```

```jsonc
// GET /orders?page=0&size=20
{
  "items": [
    {
      "orderId": "ord_01J5GK...",
      "orderNumber": "ORD-20260819-0001",
      "status": "PAID",
      "statusLabel": "已付款",
      "statusCategory": "IN_PROGRESS",
      "totalAmount": "1280.50",
      "currency": "TWD",
      "itemCount": 3,
      "thumbnailUrl": "https://cdn.shop.example/p/P-1001/thumb.webp",
      "createdAt": "2026-08-19T06:12:44Z"
    }
  ],
  "page": { "number": 0, "size": 20, "totalElements": 1523, "totalPages": 77 }
}
```

**`thumbnailUrl` 的設計理由**：訂單列表要顯示商品圖。
如果不給，前端要為每筆訂單打 `GET /orders/{id}/items` 拿 productId，
再打 `GET /products/{id}` 拿圖 → **一頁 20 筆 = 40 次額外請求**（N+1 API）。

給一個 `thumbnailUrl` 就解決了。**這是「內嵌最小資訊」原則的實例**（3.8.1 方式 B）。

### 3.14.3 訂單詳情

```jsonc
// GET /orders/ord_01J5GK...
{
  "orderId": "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
  "orderNumber": "ORD-20260819-0001",
  "status": "PAID",
  "statusLabel": "已付款",
  "statusCategory": "IN_PROGRESS",
  "allowedActions": ["CANCEL", "REQUEST_INVOICE"],

  "customer": {
    "customerId": "cus_01J5GK...",
    "displayName": "王小明"
  },

  "items": [
    {
      "itemId": "oi_01J5GK...",
      "productId": "P-1001",
      "productName": "無線降噪耳機 Pro",
      "productImageUrl": "https://cdn.shop.example/p/P-1001/thumb.webp",
      "sku": "P-1001-BLACK",
      "quantity": 2,
      "unitPrice": "640.00",
      "lineTotal": "1280.00",
      "shippedQuantity": 0
    },
    {
      "itemId": "oi_01J5GL...",
      "productId": "P-2003",
      "productName": "藍牙喇叭 Mini",
      "productImageUrl": "https://cdn.shop.example/p/P-2003/thumb.webp",
      "sku": "P-2003-WHITE",
      "quantity": 1,
      "unitPrice": "220.00",
      "lineTotal": "220.00",
      "shippedQuantity": 0
    }
  ],

  "amounts": {
    "subtotal": "1500.00",
    "discount": "-300.00",
    "shippingFee": "80.50",
    "tax": "0.00",
    "total": "1280.50"
  },
  "currency": "TWD",
  "appliedCoupon": { "code": "SUMMER20", "discountAmount": "-300.00" },

  "shippingAddress": {
    "recipient": "王小明",
    "phone": "0912***678",
    "postalCode": "10491",
    "city": "台北市",
    "district": "中山區",
    "line1": "民生東路三段 10 號 5 樓",
    "line2": "請放管理室"
  },

  "invoice": {
    "type": "PERSONAL",
    "carrierId": "/ABC+123",
    "invoiceNumber": "AB-12345678",
    "issuedAt": "2026-08-19T06:15:10Z"
  },

  "payments": [
    {
      "paymentId": "pay_01J5GK...",
      "method": "CREDIT_CARD",
      "cardBrand": "VISA",
      "cardLast4": "4242",
      "amount": "1280.50",
      "status": "SUCCEEDED",
      "paidAt": "2026-08-19T06:14:58Z"
    }
  ],

  "shipments": [],
  "cancellation": null,

  "customerNote": "麻煩包裝仔細一點",

  "createdAt": "2026-08-19T06:12:44Z",
  "updatedAt": "2026-08-19T06:15:10Z",
  "businessDate": "2026-08-19",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

`ETag: "v3"`（第 02 章 2.11）

**八個設計決策的理由**：

| 決策 | 理由 |
|---|---|
| `items[].unitPrice` 是**快照** | 商品調價不影響已成立訂單（第 01 章 1.2.2） |
| `items[].productName` 也是快照 | 商品改名不影響歷史訂單 |
| `shippingAddress` 是**內嵌物件**，不是 `addressId` | 同上 —— 客戶改地址不該改動歷史訂單 |
| `phone` 遮蔽成 `0912***678` | 3.13.5；客服版本會回完整號碼（用同一個 DTO，mapper 依角色決定） |
| `shipments: []` 而不是省略 | 集合永遠回陣列（3.7.2 規則 1） |
| `cancellation: null` 而**不是**省略 | ⚠️ 這裡刻意用 `@JsonInclude(ALWAYS)` —— 讓前端知道「這個概念存在，目前沒有」 |
| `items[].shippedQuantity` | 支援分批出貨（`PARTIALLY_SHIPPED` 狀態需要） |
| `businessDate` | 3.6.3 的營業日問題 |

### 3.14.4 客服版本的差異

**同一個端點，不同角色看到不同欄位**：

```jsonc
// GET /orders/ord_1（客服 token）—— 額外欄位
{
  "...": "（顧客看到的全部欄位）",

  "customer": {
    "customerId": "cus_01J5GK...",
    "displayName": "王小明",
    "email": "wang@example.com",          // ← 客服才看得到
    "phone": "0912345678",                 // ← 完整號碼
    "lifetimeOrderCount": 42,              // ← 客服才看得到
    "riskLevel": "LOW"                     // ← 客服才看得到
  },
  "shippingAddress": {
    "phone": "0912345678",                 // ← 完整（不遮蔽）
    "...": "..."
  },
  "internalNotes": [
    { "noteId": "note_1", "author": "李客服",
      "content": "客戶要求提前出貨", "createdAt": "2026-08-19T06:20:00Z" }
  ],
  "margin": { "cost": "820.00", "profit": "460.50", "marginRate": 0.359 },
  "fraudCheck": { "score": 12, "decision": "PASS", "rules": [] }
}
```

**實作方式的三種選擇**：

| 方式 | 說明 | 取捨 |
|---|---|---|
| **A. 兩個 DTO** | `OrderDetail` / `OrderDetailForSupport`（後者可組合前者） | ✅ 型別安全、OpenAPI 清楚<br>❌ 兩份 mapper |
| **B. 一個 DTO + 選填欄位** | 敏感欄位是 `null` 時省略（3.7.2 規則 2） | ✅ 一份 DTO<br>❌ OpenAPI 無法表達「這些欄位只有某些角色看得到」 |
| **C. `@JsonView`** | 用 view 標註欄位可見性 | ⚠️ 把權限邏輯編進 DTO 註解，複雜後很難維護 |

**shop-service 選 A（兩個 DTO）**，理由：
- **OpenAPI 可以明確描述兩種回應**（用 `oneOf` 或分別描述兩個端點的 security scope）。
- **「誰看得到什麼」變成型別層面的事實**，不是散落在 mapper 的 `if`。
- 最重要的：**新增敏感欄位時，不可能不小心加到顧客版本**（因為那是另一個 record）。

```java
// 組合而非重複
public record OrderDetailForSupport(
    @JsonUnwrapped OrderDetail base,      // 顧客看到的全部
    CustomerDetailForSupport customer,     // 覆寫（更多欄位）
    List<InternalNote> internalNotes,
    Margin margin,
    FraudCheck fraudCheck
) {}
```

⚠️ `@JsonUnwrapped` 有限制（不支援 `@JsonAnySetter`、對 `record` 的支援要測試）。
實務上直接列出全部欄位、用 mapper 組裝，可能更直白。

### 3.14.5 完整 DTO 清單

| DTO | 用於 | 欄位數 |
|---|---|---|
| `CreateOrderRequest` | `POST /orders` | 5 |
| `UpdateOrderRequest` | `PATCH /orders/{id}` | 3（`customerNote`、`invoice`、`internalNote`）—— 用 `JsonNullable` |
| `OrderSummary` | `GET /orders` 的元素 | 10 |
| `OrderDetail` | `GET /orders/{id}` | 20 |
| `OrderDetailForSupport` | 同上（客服） | 20 + 5 |
| `OrderItemResponse` | `GET /orders/{id}/items` 的元素 | 9 |
| `CreatePaymentRequest` | `POST /orders/{id}/payments` | 4 |
| `PaymentResponse` | 付款（列表與單筆共用） | 9 |
| `CreateCancellationRequest` | `POST /orders/{id}/cancellations` | 3 |
| `CancellationResponse` | 取消單 | 7 |
| `CreateShipmentRequest` | `POST /orders/{id}/shipments` | 4 |
| `ShipmentResponse` | 出貨單 | 8 |
| `AddressRequest` / `AddressResponse` | 地址 | 7 |
| `ProductSummary` / `ProductDetail` | 商品 | 8 / 18 |
| `CartResponse` / `CartItemResponse` | 購物車 | 8 / 7 |
| `PageResponse<T>` | 所有集合回應 | 2 |
| `ProblemDetail` | 所有錯誤（第 04 章） | 5 + 擴充 |

**總計約 22 個 DTO**。對 70 條端點來說是合理的比例
（大量端點共用同一組 DTO，這正是「不要過度拆分」的結果，3.3.3）。

---

## 3.15 對映層：手寫 vs MapStruct

### 3.15.1 手寫 mapper

```java
@Component
public class OrderMapper {

    private final MessageSource messages;

    public OrderMapper(MessageSource messages) { this.messages = messages; }

    public OrderSummary toSummary(Order o, Locale locale) {
        return new OrderSummary(
            o.getId(),
            o.getOrderNumber(),
            o.getStatus().name(),
            label(o.getStatus(), locale),
            category(o.getStatus()),
            money(o.getTotalAmount()),
            o.getCurrency(),
            o.getItemCount(),
            o.getFirstItemThumbnailUrl(),
            o.getCreatedAt()
        );
    }

    private String label(OrderStatus s, Locale locale) {
        return messages.getMessage("order.status." + s.name().toLowerCase(),
                                   null, s.name(), locale);
    }

    private static String money(BigDecimal v) {
        return v == null ? null : v.setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    private static String category(OrderStatus s) {
        return switch (s) {
            case PENDING_PAYMENT, PAID, PARTIALLY_SHIPPED, SHIPPED -> "IN_PROGRESS";
            case COMPLETED -> "DONE";
            case CANCELLED, RETURNED -> "CANCELLED";
        };
    }
}
```

✅ 完全掌控、可以做複雜轉換（金額格式化、i18n、遮蔽）、除錯直觀。
❌ 欄位多時很囉唆；Entity 加欄位時要記得改 mapper。

### 3.15.2 MapStruct

```java
@Mapper(componentModel = "spring", uses = MoneyFormatter.class)
public interface OrderMapper {

    @Mapping(target = "status",        expression = "java(o.getStatus().name())")
    @Mapping(target = "statusLabel",   ignore = true)     // 需要 locale，手動補
    @Mapping(target = "totalAmount",   source = "totalAmount", qualifiedByName = "money")
    @Mapping(target = "thumbnailUrl",  source = "firstItemThumbnailUrl")
    OrderSummary toSummary(Order o);
}
```

✅ 編譯期產生程式碼（無反射，效能好）、**欄位漏對映時編譯警告**。
❌ 複雜轉換要寫 `expression`（很醜）；產生的程式碼要進 `target/` 才看得到；學習曲線。

**MapStruct 最大的價值是「漏欄位會被抓到」**：

```java
// 加了新欄位 businessDate 但忘記在 mapper 補
// MapStruct：編譯警告 "Unmapped target property: businessDate"
// 手寫：      靜默回 null 🔴
```

可以設定成錯誤（強制處理）：

```xml
<compilerArgs>
    <arg>-Amapstruct.unmappedTargetPolicy=ERROR</arg>
</compilerArgs>
```

### 3.15.3 shop-service 的選擇

| 情況 | 用 |
|---|---|
| 欄位多、對映單純（`Product`、`Address`） | MapStruct |
| 需要 i18n、金額格式化、遮蔽、聚合多個來源（`Order`） | 手寫 |
| 混合 | MapStruct 產生基礎，手寫的 `@AfterMapping` 補特殊欄位 |

**不要為了「統一」而全部用同一種。** 挑合適的工具，並在 style guide 記下判準。

（完整實作在 05-service 第 03 章。）

---

## 3.16 常見誤區

**誤區 1：「內部後台直接回 Entity 沒差」**
3.2.8 已反駁。`passwordHash` 不會因為是內部就變安全。

**誤區 2：「用 `@JsonIgnore` 就能安全地回 Entity」**
`@JsonIgnore` 是黑名單 —— **新增敏感欄位時你必須記得加註解**。
DTO 是白名單 —— 新增欄位**默認不會外洩**。
**安全機制必須是白名單。**

**誤區 3：「金額用 `double` 沒問題，反正只是顯示」**
3.5.3 已詳述。而且「只是顯示」的假設會被打破 —— 
前端遲早會做「小計 = 單價 × 數量」，然後就錯了。

**誤區 4：「時間直接回 `LocalDateTime` 就好」**
3.6.4：沒有時區資訊，跨時區客戶端一定錯。

**誤區 5：「`null` 和不存在一樣，隨便」**
3.7.2：對 `PATCH` 來說完全不一樣（第 02 章 2.5.4）。
對「不適用」vs「無值」的區分也不一樣。

**誤區 6：「集合沒資料回 `null` 比較省」**
省 4 個字元，換前端白畫面。3.7.2 規則 1。

**誤區 7：「回應欄位越多越好，前端要什麼都有」**
Over-fetching 的代價：頻寬、序列化 CPU、資料庫查詢、**以及每個欄位都變成契約**。
回出去的欄位就再也拿不回來了（第 00 章 0.8）。

**誤區 8：「直接把 `Page<T>` 回出去很方便」**
3.11.1：洩漏 Spring Data 內部結構，而且它**升版時真的變過**。

**誤區 9：「用同一個 DTO 收請求和回應比較 DRY」**
3.3.2：mass assignment 漏洞 + 驗證註解混亂 + 演進節奏衝突。
**DRY 不適用於「跨越信任邊界」的型別。**

**誤區 10：「新增列舉值是相容的變更，不用通知」**
3.10.4 + 第 00 章 0.8.3 的災難。對沒有 `default` 的客戶端是破壞性的。

**誤區 11：「未知欄位一律報錯比較嚴謹」**
3.13.4：會讓客戶端升級時壞掉。正確做法是「開發環境嚴格、正式環境寬鬆」。

**誤區 12：「遮蔽敏感資料在前端做就好」**
3.13.5：完整資料已經傳出去了，devtools、log、代理都看得到。

---

## 3.17 本章練習

### 練習 1：找出回應中的問題

以下是某系統的回應。找出所有問題並修正。

```jsonc
// GET /api/order/detail?id=1001
HTTP/1.1 200 OK
Content-Type: text/html

{
  "code": 0,
  "msg": "success",
  "data": {
    "ID": 1001,
    "order_no": "20260819000001",
    "user_id": 48213,
    "userName": "王小明",
    "userEmail": "wang@example.com",
    "userPhone": "0912345678",
    "userIdNumber": "A123456789",
    "userPasswordHash": "$2a$10$N9qo8u...",
    "amount": 1280.5,
    "discount": -300,
    "status": 2,
    "payMethod": 1,
    "createTime": "2026-08-19 14:12:44",
    "updateTime": null,
    "items": null,
    "shipping": {
      "addressId": 8821
    },
    "remark": "",
    "internalCost": 820.0,
    "profitRate": 0.359
  }
}
```

<details>
<summary>參考解答</summary>

**協議層面**

| # | 問題 | 修正 |
|---|---|---|
| 1 | `Content-Type: text/html` 但 body 是 JSON | `application/json` |
| 2 | URL 有動詞、單數、id 在查詢參數 | `GET /orders/ord_01J5GK...`（第 01 章） |
| 3 | 統一包裝層 `{code, msg, data}` | 直接回資源（3.9） |
| 4 | 沒有 `ETag`、沒有 `Cache-Control` | 加 `ETag` + `Cache-Control: private, no-store` |
| 5 | 沒有 `traceId` | 加上（第 04 章 4.8） |

**資安（🔴 最嚴重）**

| # | 問題 | 修正 |
|---|---|---|
| 6 | 🔴 `userPasswordHash` 外洩 | 移除。用 DTO 白名單 |
| 7 | 🔴 `userIdNumber` 身分證號外洩 | 移除（顧客自己也不需要在訂單看到） |
| 8 | 🔴 `internalCost`、`profitRate` 商業機密外洩 | 移除；客服版本才給（3.14.4） |
| 9 | `userEmail`、`userPhone` 未遮蔽 | 顧客版遮蔽為 `w***g@example.com`、`0912***678` |
| 10 | `user_id` 是可枚舉的自增數字 | 用 ULID（第 01 章 1.4） |

**型別與格式**

| # | 問題 | 修正 |
|---|---|---|
| 11 | 命名混用三種風格：`ID`、`order_no`、`userName` | 全站 `camelCase`：`orderId`、`orderNumber`、`customer.displayName` |
| 12 | `ID: 1001` 是數字 | `"orderId": "ord_01J5GK..."`（字串，3.5.4） |
| 13 | `amount: 1280.5` 浮點數，且**尾數 0 消失** | `"totalAmount": "1280.50"` + `"currency": "TWD"`（3.5.3） |
| 14 | `discount: -300` 型別不一致（一個是浮點一個是整數） | `"discount": "-300.00"` |
| 15 | `status: 2` 魔術數字 | `"status": "PAID"` + `statusLabel` + `statusCategory`（3.10） |
| 16 | `payMethod: 1` 魔術數字 | `"method": "CREDIT_CARD"` |
| 17 | `createTime` 無時區、格式非 ISO | `"createdAt": "2026-08-19T06:12:44Z"`（3.6） |
| 18 | 時間欄位命名 `createTime`/`updateTime` | `createdAt` / `updatedAt` |
| 19 | `updateTime: null` | 省略（`non_null`）或給實際值 |
| 20 | 🔴 `items: null` | `"items": []`，或改為 `itemCount` + 獨立端點（3.7.2、3.8） |
| 21 | `remark: ""` 空字串 | 正規化成 `null` → 省略（3.7.3） |
| 22 | `shipping.addressId: 8821` 是**參照**而非快照 | 內嵌地址快照（第 01 章 1.2.2）—— 客戶改地址不該改動歷史訂單 |
| 23 | 客戶資訊平坦展開（`userName`、`userEmail`…） | 收成 `customer: { customerId, displayName }`（3.8.1 方式 B） |

**缺少的欄位**

| # | 缺什麼 | 為什麼要 |
|---|---|---|
| 24 | `statusLabel` | 前端不用維護對照表（3.10.2） |
| 25 | `allowedActions` | 業務規則只在後端一份 |
| 26 | `currency` | 沒有幣別的金額是無意義的 |
| 27 | `orderNumber`（可讀的） | 客服對答案用（第 01 章 1.4.3）—— 現有的 `order_no` 沒有前綴 |
| 28 | 金額明細（`subtotal`/`shippingFee`/`tax`） | 使用者要知道錢怎麼算的 |

**修正後**

```http
GET /orders/ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR
Authorization: Bearer ...

HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store
ETag: "v3"
```

```jsonc
{
  "orderId": "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
  "orderNumber": "ORD-20260819-0001",
  "status": "PAID",
  "statusLabel": "已付款",
  "statusCategory": "IN_PROGRESS",
  "allowedActions": ["CANCEL", "REQUEST_INVOICE"],

  "customer": {
    "customerId": "cus_01J5GK...",
    "displayName": "王小明",
    "email": "w***g@example.com",
    "phone": "0912***678"
  },

  "amounts": {
    "subtotal": "1500.00",
    "discount": "-300.00",
    "shippingFee": "80.50",
    "tax": "0.00",
    "total": "1280.50"
  },
  "currency": "TWD",
  "itemCount": 3,

  "shippingAddress": {
    "recipient": "王小明",
    "phone": "0912***678",
    "postalCode": "10491",
    "city": "台北市",
    "district": "中山區",
    "line1": "民生東路三段 10 號 5 樓"
  },

  "payments": [
    { "paymentId": "pay_01J5GK...", "method": "CREDIT_CARD",
      "cardLast4": "4242", "amount": "1280.50",
      "status": "SUCCEEDED", "paidAt": "2026-08-19T06:14:58Z" }
  ],
  "shipments": [],
  "cancellation": null,

  "createdAt": "2026-08-19T06:12:44Z",
  "updatedAt": "2026-08-19T06:15:10Z",
  "businessDate": "2026-08-19",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**注意 `items` 不在這裡** —— 用 `itemCount` + `GET /orders/{id}/items`，
或 `?expand=items`（3.8.2）。這避免了列表端點的 over-fetching。

</details>

### 練習 2：設計 Request DTO 並找出漏洞

某人寫了這個「更新商品」的端點：

```java
@PutMapping("/products/{id}")
public Product update(@PathVariable String id, @RequestBody Product product) {
    product.setProductId(id);
    return repo.save(product);
}
```

`Product` Entity：

```java
@Entity
public class Product {
    @Id private String productId;
    private String name;
    private String description;
    private BigDecimal price;
    private BigDecimal cost;              // 成本（內部）
    private Integer stock;
    private ProductStatus status;
    private String ownerId;               // 賣家 ID（多賣家平台）
    private Integer viewCount;
    private BigDecimal ratingAvg;
    private Integer ratingCount;
    private Boolean featured;             // 首頁推薦（只有平台可設）
    private BigDecimal commissionRate;    // 平台抽成（只有平台可設）
    private Instant createdAt;
    private Instant updatedAt;
    @OneToMany(mappedBy = "product", cascade = CascadeType.ALL)
    private List<ProductImage> images;
}
```

1. 列出所有可被攻擊者利用的欄位，說明攻擊方式與後果。
2. 設計正確的 Request DTO。
3. 這個端點還有哪些非資安的問題？

<details>
<summary>參考解答</summary>

**1. 可被攻擊的欄位**

| 欄位 | 攻擊 | 後果 |
|---|---|---|
| `ownerId` | 賣家 A 送 `{"ownerId": "seller_B"}` | 🔴 **把自己的商品送給別人**，或更糟 —— 改成自己來**竊取別人的商品**（連同銷售紀錄與評價） |
| `cost` | 送 `{"cost": 0}` | 平台的利潤報表全錯；如果有「成本價保護」規則（不得低於成本銷售）也被繞過 |
| `commissionRate` | 送 `{"commissionRate": 0}` | 🔴 **平台抽不到錢**。直接的財務損失 |
| `featured` | 送 `{"featured": true}` | 🔴 自己把商品放上首頁推薦位（廣告價值可觀） |
| `status` | 送 `{"status": "ACTIVE"}` | 繞過審核流程直接上架（可能上架違禁品） |
| `ratingAvg` / `ratingCount` | 送 `{"ratingAvg": 5.0, "ratingCount": 9999}` | 🔴 **偽造評價**。這是電商最嚴重的信任破壞 |
| `viewCount` | 送 `{"viewCount": 999999}` | 偽造熱度，影響排序演算法 |
| `createdAt` | 送 `{"createdAt": "2020-01-01T00:00:00Z"}` | 偽造「老店」信譽；影響「新品」排序 |
| `images` (cascade ALL) | 送 `{"images": [{"imageId": "img_別人的"}]}` | 🔴 **可能刪除或竊取別人的圖片紀錄**（cascade + orphanRemoval 的組合很危險） |
| `productId` | 雖然被 `setProductId(id)` 覆蓋了 | ⚠️ 但如果哪天有人重構掉那一行… 這種「靠一行程式碼保護」的設計很脆弱 |

**還有一個更隱蔽的問題**：`PUT` + `repo.save()` 是 **upsert**。
送 `PUT /products/P-9999`（不存在）會**建立**一個新商品，
而權限檢查（如果是「查出來看 ownerId」）會因為查不到而跳過 → **任何人可以建立任意 SKU**（第 02 章 2.5.2）。

**2. 正確的 Request DTO**

```java
public record UpdateProductRequest(
    @NotBlank @Size(max = 120)
    String name,

    @Size(max = 5000)
    String description,

    @NotNull @DecimalMin(value = "0.00", inclusive = false)
    @Digits(integer = 10, fraction = 2)
    BigDecimal price
) {}
```

**只有 3 個欄位。** 其他全部由伺服器控制：

| 欄位 | 誰能改 | 怎麼改 |
|---|---|---|
| `stock` | 倉管 | `POST /products/{id}/inventory-adjustments`（第 01 章 1.7.2） |
| `status` | 賣家（送審）/ 平台（核准） | `PUT /products/{id}/status`，且有狀態機檢查 |
| `featured` | **只有平台** | `PATCH /admin/products/{id}` 或 `PUT /products/{id}/featured`（不同權限） |
| `commissionRate` | **只有平台** | 專屬管理端點 |
| `cost` | 賣家 | 獨立端點 `PUT /products/{id}/cost`（因為它不該和公開資訊一起改，且可能有不同的稽核要求） |
| `ownerId` | **沒有人**（除了轉移商品的專用流程） | `POST /products/{id}/ownership-transfers`（需雙方確認） |
| `viewCount`、`ratingAvg`、`ratingCount` | **系統** | 由事件累計，沒有 API |
| `createdAt`、`updatedAt` | **系統** | 時鐘 |
| `images` | 賣家 | `POST /products/{id}/images`、`DELETE /products/{id}/images/{imageId}` |

**Controller**：

```java
@PatchMapping(value = "/products/{id}",
              consumes = "application/merge-patch+json")
public ProductDetail update(@PathVariable String id,
                            @RequestHeader("If-Match") String ifMatch,
                            @Valid @RequestBody UpdateProductRequest req) {

    // ★ 權限檢查放進查詢條件（第 01 章 1.4.1）
    Product p = repo.findByProductIdAndOwnerId(id, currentSellerId())
            .orElseThrow(() -> new ResourceNotFoundException("product", id));

    versionGuard.check(p.getVersion(), ifMatch);   // → 412（第 02 章 2.11）

    p.setName(req.name());
    p.setDescription(req.description());
    p.setPrice(req.price());
    // 就這三個。其他欄位不可能被動到，因為 DTO 裡沒有。

    return mapper.toDetail(repo.save(p));
}
```

**這裡的關鍵是「不可能」而不是「記得不要」**：
DTO 裡沒有 `commissionRate`，所以就算開發者手滑寫了 `p.setCommissionRate(...)`，
編譯就會失敗（`req.commissionRate()` 不存在）。

**3. 非資安的問題**

| # | 問題 | 修正 |
|---|---|---|
| 1 | 用 `PUT` 但前端表單可能只有部分欄位 → **漏欄位被清空**（第 02 章 2.5.1） | 用 `PATCH` |
| 2 | 回傳 Entity（3.2 的全部六個後果） | 回 `ProductDetail` DTO |
| 3 | 沒有 `If-Match` → 併發覆蓋（第 02 章 2.11） | 加上，且回 `428` 強制 |
| 4 | `repo.findById()` 沒有帶 `ownerId` → IDOR | 用複合條件查詢 |
| 5 | `PUT` 的 upsert 語意讓「不存在的 ID」變成建立 | 用 `PATCH`（不會 upsert），或明確檢查存在性 |
| 6 | 沒有驗證（Entity 上可能有 `@Column` 但那是 DDL 層面） | Bean Validation 在 DTO 上 |
| 7 | `images` 的 `cascade = ALL` + 從請求收 | 移除 cascade；圖片用獨立端點 |
| 8 | 沒有稽核紀錄（誰改了價格） | 價格變更用 `POST /products/{id}/price-changes`（第 01 章 1.7.2） |

**這一題的核心教訓**：

> **`@RequestBody Entity` 是一個漏洞，不是一個捷徑。**
> 一個 3 欄位的 `record`（5 行程式碼）擋掉了 10 個攻擊面。

</details>

### 練習 3：金額與時間

某跨境電商的 API 回應：

```jsonc
{
  "orderId": "1001",
  "amount": 99.99,
  "shippingFee": 5.5,
  "tax": 8.25,
  "total": 113.74,
  "createdAt": "2026-08-19 14:12:44",
  "estimatedDelivery": "2026-08-25 00:00:00",
  "paymentDeadline": "2026-08-19 14:42:44"
}
```

系統要支援台灣（TWD）、日本（JPY）、美國（USD）三個市場。

1. 金額有哪些問題？如何修正？
2. 時間有哪些問題？如何修正？
3. 「預計到貨日」和「付款期限」在型別選擇上有什麼不同？

<details>
<summary>參考解答</summary>

**1. 金額問題**

| # | 問題 | 說明 |
|---|---|---|
| 1 | 🔴 **沒有幣別** | `99.99` 是台幣、日圓還是美元？跨境電商完全無法運作 |
| 2 | 用 JSON number（浮點） | `99.99 + 5.5 + 8.25` 在 JS 裡是 `113.74000000000001` |
| 3 | 尾數 0 消失 | `5.5` 應該是 `5.50`；`total` 若是 `113.70` 會變成 `113.7` |
| 4 | 日圓沒有小數位 | JPY 的 `99.99` 是無效金額（日圓最小單位是 1 圓） |
| 5 | 沒有稅的說明 | `tax: 8.25` 是稅率 8.25% 還是稅額 8.25 元？（歧義） |
| 6 | 沒有匯率資訊 | 跨境訂單通常需要「原幣別金額」+「結算幣別金額」+「匯率」 |

**修正**

```jsonc
{
  "orderId": "ord_01J5GK...",
  "amounts": {
    "subtotal": "99.99",
    "shippingFee": "5.50",
    "taxAmount": "8.25",
    "total": "113.74"
  },
  "currency": "USD",
  "taxRate": 0.0825,                    // 稅率單獨給，避免和稅額混淆
  "taxInclusive": false,                // 標價是否已含稅（各國規定不同！）

  // 跨境結算（如果需要）
  "settlement": {
    "currency": "TWD",
    "total": "3549.00",
    "exchangeRate": "31.2000",
    "rateFixedAt": "2026-08-19T06:12:44Z"
  }
}
```

**日圓的處理**：

```jsonc
{
  "amounts": { "subtotal": "1500", "shippingFee": "300", "total": "1800" },
  "currency": "JPY"
}
```

字串 decimal 的好處在這裡體現：`"1500"` 不會被誤解成 `1500.00`。
如果用整數最小單位（方案 B），你需要 `exponent: 0` 才能正確顯示（3.5.3）。

**`taxInclusive` 為什麼重要**：
- 台灣、日本、歐盟：標價**含稅**。
- 美國：標價**不含稅**，結帳時才加。

如果沒有這個欄位，前端無法正確顯示「小計」和「稅金」的關係。
這是跨境電商最容易出錯的地方之一。

**2. 時間問題**

| # | 問題 | 說明 |
|---|---|---|
| 1 | 🔴 **沒有時區** | `14:12:44` 是台北、東京還是紐約時間？三個市場各差 13～16 小時 |
| 2 | 格式非 ISO-8601 | 空白分隔而非 `T`，無法用標準函式庫解析 |
| 3 | `estimatedDelivery` 用 `00:00:00` 假裝是日期 | 它其實是「日期」，不該有時間部分 |

**修正**

```jsonc
{
  "createdAt": "2026-08-19T06:12:44Z",              // Instant（UTC）
  "estimatedDeliveryDate": "2026-08-25",            // LocalDate（純日期）
  "paymentDeadline": "2026-08-19T06:42:44Z",        // Instant（UTC）
  "businessDate": "2026-08-19",                      // 營業日（依市場時區）
  "marketTimeZone": "America/New_York"               // 這筆訂單的市場時區
}
```

**3. 「預計到貨日」vs「付款期限」的型別差異 ★ 這是本題重點**

| | `estimatedDeliveryDate` | `paymentDeadline` |
|---|---|---|
| 型別 | `LocalDate`（`"2026-08-25"`） | `Instant`（`"2026-08-19T06:42:44Z"`） |
| 為什麼 | 「8/25 到貨」是一個**日期概念**，沒有精確時間 | 「30 分鐘後過期」是一個**精確時間點** |
| 時區處理 | 由**收貨地**的時區決定（物流的「8/25」是當地的 8/25） | 全球統一的時間點 |
| 前端顯示 | 直接顯示 `2026/08/25`，**不要做時區轉換** | 轉成使用者當地時間 + 倒數計時 |

**如果搞錯會發生什麼**：

```javascript
// ❌ 把 estimatedDelivery 當成 Instant
new Date("2026-08-25T00:00:00Z").toLocaleDateString('ja-JP', {timeZone:'Asia/Tokyo'})
// → "2026/8/25" ✅ 碰巧對（JST = UTC+9，0點變9點，還是同一天）

new Date("2026-08-25T00:00:00Z").toLocaleDateString('en-US', {timeZone:'America/New_York'})
// → "8/24/2026" 🔴 差一天！（EDT = UTC-4，0點變前一天20點）
```

**美國使用者看到的到貨日比實際早一天。** 這會產生客訴（「你們說 8/24 到，結果 8/25 才到」）。

**正確做法**：`estimatedDeliveryDate` 用 `LocalDate`，前端**直接顯示字串**，
不經過 `Date` 物件，就不會有時區轉換。

```javascript
// ✅ 純日期直接顯示
const [y, m, d] = order.estimatedDeliveryDate.split('-');
display(`${y}/${m}/${d}`);
// 或用 Temporal.PlainDate（新 API）／date-fns 的 parseISO + format（不轉時區）
```

**倒數計時的正確做法**：

```javascript
// paymentDeadline 是 Instant → 可以安全地做時間運算
const remainingMs = new Date(order.paymentDeadline) - Date.now();
// 這個計算在任何時區都正確，因為兩邊都是絕對時間點
```

**這題的總結**：**「日期」和「時間點」是兩種不同的東西，不是同一種東西的不同精度。**
把日期當時間點會產生「差一天」的 bug，而且只在某些時區出現 —— 
最難重現、最難發現的那一類 bug。

</details>

### 練習 4：列舉演進

你的訂單狀態原本有 5 個值。現在產品要新增 `PARTIALLY_SHIPPED`（部分出貨）
和 `PENDING_REFUND`（退款處理中）。

現有 consumer：Web SPA、iOS App（12 萬使用者）、Android App（30 萬）、
3 家廠商 ERP、2 個內部服務。

1. 這是破壞性變更嗎？對哪些 consumer？
2. 設計完整的上線計畫。
3. 如何預防下一次？

<details>
<summary>參考解答</summary>

**1. 對誰是破壞性的**

| Consumer | 破壞性？ | 症狀 |
|---|---|---|
| Web SPA | ⚠️ 看實作 | 若 `switch` 無 `default` → 狀態文字空白（但可當天修） |
| iOS App | 🔴 **可能 crash** | Swift 的 `enum: Codable` 遇到未知 case → `DecodingError` → **整個回應解析失敗，訂單列表全空** |
| Android App | ⚠️ 靜默錯誤 | Gson 遇未知 enum → `null` → 顯示空白或 NPE |
| 廠商 ERP | 🔴 **可能寫入錯誤資料** | 若用 `switch` 對映到自己的狀態碼，未知值可能落到 `else` 分支被當成某個既有狀態 |
| 內部服務 | ⚠️ 看實作 | 若用 Java `enum` + Jackson 預設 → `InvalidFormatException` → 呼叫失敗 |

**最嚴重的是 iOS**：Swift 的 `Codable` 對 `enum` 是嚴格的，
遇到未知 case 會讓**整個** `Order` 物件解析失敗，不只是那一個欄位。
所以「一筆訂單是部分出貨」會導致「整個訂單列表無法顯示」（因為列表解析失敗）。

**2. 上線計畫**

```
── 階段 0：先修客戶端（不改 API）───────────────────────
Day -30  ① 發技術公告：說明列舉會擴充，客戶端必須處理未知值
         ② 提供各平台的正確寫法範例（見下）
         ③ 在 staging 環境提供一個「會回傳未知狀態」的測試端點
            GET /orders?_testUnknownEnum=true  → 回一筆 status: "__TEST_UNKNOWN__"
            ★ 這一步最重要：讓客戶端可以「真的測試」
Day -30  ④ 內部服務先改（Jackson 設定 + UNKNOWN fallback）
Day -25  ⑤ Web SPA 加 default 分支 → 上線（幾天就完成）
Day -20  ⑥ iOS / Android 改用寬鬆解析 → 送審 → 發版
Day -20  ⑦ 通知 3 家廠商，提供測試環境與遷移期限

── 階段 1：加入「相容欄位」（仍不改列舉）──────────────
Day -14  ⑧ API 回應新增：
            statusLabel     （後端翻譯，前端不用對照表）
            statusCategory  （粗粒度，很少擴充）
            allowedActions  （業務規則）
         ⑨ 這一步是「純新增」，對所有 consumer 相容
Day -14  ⑩ 建議所有 consumer 改用這三個欄位

── 階段 2：監控客戶端就緒度 ────────────────────────────
Day -14  ⑪ 記錄每個請求的 consumer 版本（User-Agent / X-Client-Version）
Day -7   ⑫ 檢查舊版 App 的流量佔比
            > 5%  → 延後
            < 5%  → 繼續（並準備公告）
── 階段 3：灰度放量 ────────────────────────────────────
Day 0    ⑬ 對「已知安全」的 consumer 開啟新狀態（用 feature flag 按 client 版本控制）
            例如：只對 iOS >= 3.2.0 的請求回傳 PARTIALLY_SHIPPED
            對舊版仍回傳 SHIPPED（降級對映）★
Day 7    ⑭ 觀察錯誤率、客訴量
Day 14   ⑮ 全量開啟

── 階段 4：清理 ────────────────────────────────────────
Day 90   ⑯ 移除降級對映邏輯
```

**⑬ 的「降級對映」是這個計畫的核心技巧**：

```java
// 對舊客戶端把新狀態對映回舊狀態
String statusForClient(OrderStatus actual, ClientVersion client) {
    if (client.supports(Feature.EXTENDED_ORDER_STATUS)) {
        return actual.name();
    }
    // 舊客戶端：對映到最接近的舊狀態
    return switch (actual) {
        case PARTIALLY_SHIPPED -> "SHIPPED";      // 部分出貨 → 顯示為已出貨
        case PENDING_REFUND    -> "CANCELLED";    // 退款中 → 顯示為已取消
        default -> actual.name();
    };
}
```

⚠️ **降級對映有語意損失，要評估可接受性**：
「部分出貨顯示為已出貨」在使用者體驗上是輕微誤導（他以為全部都出了），
但比「整頁空白」好得多。**這是有意識的取捨，要記錄下來。**

**3. 預防下一次：五個做法**

**做法 1：契約裡宣告可擴充**（3.10.2 層次 1）

```yaml
OrderStatus:
  type: string
  enum: [PENDING_PAYMENT, PAID, PARTIALLY_SHIPPED, SHIPPED, COMPLETED, CANCELLED, PENDING_REFUND, RETURNED]
  x-extensible-enum: true
  description: |
    ⚠️ 此列舉會持續新增值，客戶端必須處理未知值。
    顯示請用 statusLabel；邏輯判斷請用 allowedActions 或 statusCategory。
```

**做法 2：提供 `statusLabel` + `statusCategory` + `allowedActions`**（3.10.2 層次 2）

**這是最有效的一招**，因為它讓客戶端根本不需要認識 `status` 的值。

**做法 3：在測試環境提供「未知值注入」**

```http
GET /orders?_injectUnknownEnum=status
Authorization: Bearer <staging token>

→ 回應中的第一筆訂單 status 為 "__FUTURE_VALUE_FOR_TESTING__"
```

**這是本題最實用的一個建議**：
光說「請處理未知值」沒人會做，**給一個可以真的測試的方法**才有效。
可以放進客戶端的自動化測試裡。

**做法 4：各平台的正確寫法（放進文件）**

```typescript
// TypeScript：用 union + fallback，不要用嚴格 enum
type KnownOrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'SHIPPED' | ...;
type OrderStatus = KnownOrderStatus | (string & {});   // 允許任意字串

function statusText(o: Order): string {
  return o.statusLabel ?? LABELS[o.status as KnownOrderStatus] ?? o.status;
  //     ↑ 優先用後端給的      ↑ 本地對照表      ↑ 最後顯示原始值（不空白）
}
```

```swift
// Swift：用 RawRepresentable + unknown case
enum OrderStatus: String, Codable {
    case pendingPayment = "PENDING_PAYMENT"
    case paid = "PAID"
    case shipped = "SHIPPED"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OrderStatus(rawValue: raw) ?? .unknown    // ★ 關鍵
    }
}
```

```kotlin
// Kotlin：when 一定要有 else
val text = when (order.status) {
    "PAID" -> "已付款"
    "SHIPPED" -> "已出貨"
    else -> order.statusLabel ?: order.status    // ★ 關鍵
}
```

```java
// Java：用 String 收 + 安全轉換（3.10.2 層次 3 方案 2）
public record OrderResponse(String status, String statusLabel) {
    public OrderStatus statusOrUnknown() {
        try { return OrderStatus.valueOf(status); }
        catch (IllegalArgumentException e) { return OrderStatus.UNKNOWN; }
    }
}
```

**做法 5：把「列舉擴充」納入變更管理流程**

```
新增列舉值的 checklist：
□ 是 Response 的列舉嗎？→ 需要走本流程
□ 已在 CHANGELOG 公告？
□ 有 statusLabel / category / allowedActions 保護嗎？
□ 測試環境的「未知值注入」有人測過嗎？
□ 需要對舊客戶端做降級對映嗎？
□ 客戶端版本分布查過了嗎？
□ 3 家廠商都通知了嗎？
```

**這一題的核心教訓**：

> **「新增列舉值是相容的」只在客戶端寫對的前提下成立。**
> 而客戶端會不會寫對，是**你的 API 設計**決定的 ——
> 提供 `statusLabel` 和 `allowedActions`，客戶端就沒有理由去 switch `status`。
> **好的 API 設計會讓客戶端很難寫錯。**

</details>

### 練習 5：設計「我的訂單」的完整 DTO 家族

需求：

- 訂單列表頁：顯示訂單編號、狀態、金額、第一項商品圖與名稱、下單時間、操作按鈕。
- 訂單詳情頁：全部資訊，包含明細、金額拆解、收件地址、付款紀錄、物流追蹤。
- 客服後台的訂單詳情：額外顯示客戶完整聯絡資訊、內部備註、毛利、風控分數。
- 支援中文與英文。
- 訂單可能有 1～50 項商品。
- 手機版希望列表頁的 payload 越小越好。

請設計 DTO 並寫出 JSON 範例。說明每個決策。

<details>
<summary>參考解答</summary>

**DTO 家族**

```java
// ── 列表 ──────────────────────────────────────
public record OrderSummary(
    String orderId,
    String orderNumber,
    String status,
    String statusLabel,           // i18n（依 Accept-Language）
    String statusCategory,
    List<String> allowedActions,  // 決定顯示哪些按鈕
    String totalAmount,
    String currency,
    int itemCount,
    FirstItem firstItem,          // 只給第一項（列表要顯示縮圖與名稱）
    Instant createdAt
) {
    public record FirstItem(String productName, String thumbnailUrl) {}

    public OrderSummary {
        allowedActions = allowedActions == null ? List.of() : List.copyOf(allowedActions);
    }
}

// ── 詳情（顧客） ──────────────────────────────
public record OrderDetail(
    String orderId,
    String orderNumber,
    String status,
    String statusLabel,
    String statusCategory,
    List<String> allowedActions,
    CustomerRef customer,
    List<OrderItemResponse> items,
    Amounts amounts,
    String currency,
    AppliedCoupon appliedCoupon,     // 可為 null → 省略
    AddressResponse shippingAddress,
    InvoiceResponse invoice,          // 可為 null → 省略
    List<PaymentResponse> payments,
    List<ShipmentResponse> shipments,
    CancellationResponse cancellation, // ALWAYS 顯示（null 也出現）
    String customerNote,
    Instant createdAt,
    Instant updatedAt,
    Instant expiresAt,                // 未付款訂單的期限
    LocalDate businessDate,
    String traceId
) { /* compact constructor 做 null → List.of() */ }

// ── 詳情（客服） ──────────────────────────────
public record OrderDetailForSupport(
    // 顧客版的全部欄位（略）
    ...,
    CustomerDetailForSupport customer,   // 覆寫：更多欄位
    List<InternalNote> internalNotes,
    Margin margin,
    FraudCheck fraudCheck,
    List<StatusChange> statusHistory     // 客服要看變更軌跡
) {}
```

**列表 JSON（`GET /orders?page=0&size=20`）**

```jsonc
{
  "items": [
    {
      "orderId": "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
      "orderNumber": "ORD-20260819-0001",
      "status": "PAID",
      "statusLabel": "已付款",
      "statusCategory": "IN_PROGRESS",
      "allowedActions": ["CANCEL", "REQUEST_INVOICE"],
      "totalAmount": "1280.50",
      "currency": "TWD",
      "itemCount": 3,
      "firstItem": {
        "productName": "無線降噪耳機 Pro",
        "thumbnailUrl": "https://cdn.shop.example/p/P-1001/thumb.webp"
      },
      "createdAt": "2026-08-19T06:12:44Z"
    }
  ],
  "page": { "number": 0, "size": 20, "totalElements": 42, "totalPages": 3 }
}
```

**每筆約 300 bytes，20 筆約 6KB**（gzip 後約 1.2KB）。

**詳情 JSON（`GET /orders/ord_01J5GK...`）**

```jsonc
{
  "orderId": "ord_01J5GKQ8Z4W9V2X3Y6N7M8P0QR",
  "orderNumber": "ORD-20260819-0001",
  "status": "PAID",
  "statusLabel": "已付款",
  "statusCategory": "IN_PROGRESS",
  "allowedActions": ["CANCEL", "REQUEST_INVOICE"],

  "customer": { "customerId": "cus_01J5GK...", "displayName": "王小明" },

  "items": [
    {
      "itemId": "oi_01J5GK...",
      "productId": "P-1001",
      "productName": "無線降噪耳機 Pro",
      "productImageUrl": "https://cdn.shop.example/p/P-1001/thumb.webp",
      "sku": "P-1001-BLACK",
      "variantLabel": "黑色 / 標準版",
      "quantity": 2,
      "unitPrice": "640.00",
      "lineTotal": "1280.00",
      "shippedQuantity": 0,
      "returnableUntil": "2026-08-26"
    }
  ],

  "amounts": {
    "subtotal": "1500.00",
    "discount": "-300.00",
    "shippingFee": "80.50",
    "tax": "0.00",
    "total": "1280.50"
  },
  "currency": "TWD",
  "appliedCoupon": { "code": "SUMMER20", "name": "夏季 20% 折扣", "discountAmount": "-300.00" },

  "shippingAddress": {
    "recipient": "王小明",
    "phone": "0912***678",
    "postalCode": "10491",
    "city": "台北市",
    "district": "中山區",
    "line1": "民生東路三段 10 號 5 樓",
    "line2": "請放管理室"
  },

  "invoice": {
    "type": "PERSONAL",
    "typeLabel": "個人（載具）",
    "carrierId": "/ABC+123",
    "invoiceNumber": "AB-12345678",
    "issuedAt": "2026-08-19T06:15:10Z"
  },

  "payments": [
    {
      "paymentId": "pay_01J5GK...",
      "method": "CREDIT_CARD",
      "methodLabel": "信用卡",
      "cardBrand": "VISA",
      "cardLast4": "4242",
      "amount": "1280.50",
      "status": "SUCCEEDED",
      "statusLabel": "付款成功",
      "paidAt": "2026-08-19T06:14:58Z"
    }
  ],

  "shipments": [],
  "cancellation": null,

  "customerNote": "麻煩包裝仔細一點",
  "createdAt": "2026-08-19T06:12:44Z",
  "updatedAt": "2026-08-19T06:15:10Z",
  "businessDate": "2026-08-19",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**客服版的額外欄位**

```jsonc
{
  "...": "（顧客版全部）",
  "customer": {
    "customerId": "cus_01J5GK...",
    "displayName": "王小明",
    "email": "wang@example.com",
    "phone": "0912345678",
    "memberNumber": "M00048213",
    "memberTier": "GOLD",
    "lifetimeOrderCount": 42,
    "lifetimeValue": "128450.00",
    "returnRate": 0.048,
    "riskLevel": "LOW"
  },
  "shippingAddress": { "phone": "0912345678", "...": "（不遮蔽）" },
  "internalNotes": [
    { "noteId": "note_01J5GK...", "author": { "type": "SUPPORT", "displayName": "李客服" },
      "content": "客戶電話確認要提前出貨", "createdAt": "2026-08-19T06:20:00Z" }
  ],
  "margin": { "cost": "820.00", "grossProfit": "460.50", "marginRate": 0.3596 },
  "fraudCheck": { "score": 12, "decision": "PASS", "triggeredRules": [] },
  "statusHistory": [
    { "from": null, "to": "PENDING_PAYMENT",
      "changedBy": { "type": "CUSTOMER", "id": "cus_01J5GK..." },
      "changedAt": "2026-08-19T06:12:44Z" },
    { "from": "PENDING_PAYMENT", "to": "PAID",
      "changedBy": { "type": "SYSTEM", "id": "payment-webhook" },
      "changedAt": "2026-08-19T06:14:58Z",
      "reference": "pay_01J5GK..." }
  ]
}
```

**十二個設計決策與理由**

| # | 決策 | 理由 |
|---|---|---|
| 1 | 列表只給 `firstItem`，不給完整 `items` | 需求是「顯示第一項商品圖與名稱」。給全部 = over-fetching（3.8） |
| 2 | 列表有 `itemCount` | 前端顯示「共 3 項」；也讓使用者知道還有更多 |
| 3 | 列表和詳情都有 `allowedActions` | 列表的按鈕（取消／再買一次）和詳情的按鈕都由後端決定（3.10.2） |
| 4 | `statusLabel` 依 `Accept-Language` | 需求要中英文。後端翻譯 → 新增狀態不會顯示空白 |
| 5 | `statusCategory` | 前端要做 tab 分組（進行中／已完成／已取消），用粗粒度分類才穩定 |
| 6 | 金額全部用字串 decimal + `currency` | 3.5.3 |
| 7 | `items[].unitPrice`、`productName` 是快照 | 商品調價／改名不影響歷史訂單（第 01 章 1.2.2） |
| 8 | `shippingAddress` 內嵌，不是 `addressId` | 同上 |
| 9 | `phone` 顧客版遮蔽、客服版完整 | 3.13.5；用兩個 DTO 保證不會搞錯（3.14.4） |
| 10 | `shipments: []` 而非省略；`cancellation: null` 而非省略 | 陣列一律 `[]`（3.7.2）；`cancellation` 用 `ALWAYS` 讓前端知道「概念存在但目前沒有」 |
| 11 | `items[].returnableUntil` | 前端要決定「申請退貨」按鈕能不能按。給日期比給布林好 —— 可以顯示「剩 3 天」 |
| 12 | 客服版用**獨立 DTO**（`OrderDetailForSupport`） | 新增敏感欄位時不可能誤加到顧客版（3.14.4） |

**「手機版希望 payload 越小」怎麼處理**

三個選項，按推薦度排序：

| 選項 | 說明 | 評價 |
|---|---|---|
| **A. 開啟 gzip / brotli** | `server.compression.enabled=true` | ★ **先做這個**。JSON 的壓縮率通常 70～85%，6KB → 1.2KB。<br>零 API 複雜度增加 |
| **B. 已經做的：Summary / Detail 分離** | 列表只回 11 個欄位 | ★ 已完成 |
| **C. `?fields=` 稀疏欄位** | 讓客戶端指定欄位 | ⚠️ 3.8.3：複雜度高、收益低（在 A 之後幾乎沒差） |

```yaml
server:
  compression:
    enabled: true
    mime-types: application/json,application/problem+json,text/plain
    min-response-size: 1024
```

**這一題最重要的一個觀念**：
「payload 太大」的第一個解法永遠是**壓縮**，不是設計更複雜的 API。
先量測（`curl -w '%{size_download}'` + 開關 gzip 對照），再決定要不要加彈性。

**過早加 `?fields=` 的代價**：多一個參數要驗證、要進快取鍵、要寫文件、要測試，
而且一旦提供就很難移除（第 00 章 0.8）。

</details>

---

## 3.18 驗收清單

- [ ] 我能說出「直接回 Entity」的六個後果，包含 mass assignment 這個 Request 方向的漏洞。
- [ ] 我知道 `@JsonIgnore` 是黑名單、DTO 是白名單，也知道安全機制必須是白名單。
- [ ] 我能用 `jq paths` 一行指令檢查回應有沒有洩漏敏感欄位，並知道可以放進 CI。
- [ ] 我知道為什麼 Request 和 Response 不能共用 DTO（四個理由），特別是「金額不能由客戶端指定」。
- [ ] 我知道 `Summary` / `Detail` 分離的判準是「欄位差異超過 30% 才拆」。
- [ ] 我能用 `record` 寫 DTO，並知道 `List<@Valid X>` 的 `@Valid` 位置很關鍵。
- [ ] 我知道 `record` + `JsonNullable` 需要 compact constructor 做正規化。
- [ ] 我能決定金額的表示方式，並說出 JS 浮點誤差、尾數 0 消失、幣別小數位三個問題。
- [ ] 我知道 `BigDecimal` 要用 `toPlainString()` 而不是 `toString()`。
- [ ] 我知道 ID 一律用字串，也知道全域 `Long → String` 的做法會誤傷 `count` 這類欄位。
- [ ] 我知道列舉用字串，也知道 JPA 的 `@Enumerated` 預設是 `ORDINAL`（地雷）。
- [ ] 我能區分 `Instant` / `LocalDate` / `LocalTime`，並知道 `LocalDateTime` 為什麼危險。
- [ ] 我知道「日期」被當成「時間點」會產生「某些時區差一天」的 bug。
- [ ] 我知道為什麼需要 `businessDate`，以及跨時區統計會怎麼錯。
- [ ] 我知道集合永遠回 `[]`，並會在 compact constructor 用 `List.copyOf()` 保證。
- [ ] 我知道 `non_null` 的取捨，也知道「需要區分不適用 vs 無值」時要用 `ALWAYS` 覆寫。
- [ ] 我知道 `@NotNull` / `@NotEmpty` / `@NotBlank` 的差別，也知道字串欄位該用哪個。
- [ ] 我知道空字串該正規化成 `null`，也知道密碼和 token 不能 trim。
- [ ] 我能設計 `?expand=`，並知道它的隱藏成本是每個關聯都要做 batch loading。
- [ ] 我知道 `?fields=` 省的是頻寬不是資料庫負載，也能說出為什麼 shop-service 選擇不做。
- [ ] 我能給出「該不該用統一包裝層」的有理由答案，並知道區分「集合外殼」與「包裝層」的判準。
- [ ] 我知道不能直接回 `Page<T>`，也知道 Spring Boot 3.3+ 會對此印警告。
- [ ] 我能設計可演進的列舉：`statusLabel` + `statusCategory` + `allowedActions` 三層防護。
- [ ] 我知道在測試環境提供「未知值注入」是讓客戶端真的能測試的關鍵。
- [ ] 我知道 `Vary` header 的完整清單，也知道漏掉會造成快取污染。
- [ ] 我知道不能信任客戶端的 `Content-Type`，要檢查 magic bytes 並重新編碼圖片。
- [ ] 我能說出 JSON bomb 的四層防護，並知道 `@Size` 是 UX 不是安全機制。
- [ ] 我知道「開發環境嚴格、正式環境寬鬆」是未知欄位的最佳折衷。
- [ ] 我知道遮蔽要在 mapper 層做，而且 `toString()` 也要遮蔽（避免 log 洩漏）。
- [ ] 我完成了 shop-service 的 DTO 全家族（約 22 個）與 JSON 範例。

---

完成後請前往 [04-error-handling-and-problem-details.md](./04-error-handling-and-problem-details.md)。
