# 第 02 章：輸入驗證與綁定錯誤

> 上一章把請求的資料**綁**進 Java 物件了。這一章要問：**那些資料可以信嗎？**
>
> 答案永遠是不行。不是因為使用者是壞人，而是因為：
> 前端會有 bug、App 有舊版本還在線上、第三方會傳錯格式、
> 而且**一定會有人拿 curl 直接打你的 API**。
>
> 這一章不是「怎麼加 `@NotNull`」——那是 5 分鐘的事。
> 這一章是：**哪些欄位要驗什麼、驗到什麼程度、驗失敗要怎麼回、
> 以及為什麼「驗證」其實是一個資安主題而不是一個便利功能。**

---

## 2.1 學習目標

完成本章後，你應該可以：

- 說出「少驗一個欄位」造成的具體損失，並解釋為什麼驗證屬於資安而不是 UX。
- 說出誰在什麼時候觸發驗證，以及三種驗證失敗例外的差別。
- **背出每個約束註解對 `null` 的行為**（這是 Bean Validation 最多 bug 的地方）。
- 正確選擇 `@NotNull` / `@NotEmpty` / `@NotBlank` / `@Size` / `@Min` / `@DecimalMin`。
- 知道 `@Email` 幾乎什麼都沒檢查，以及該用什麼取代它。
- 知道 `@Pattern` 可能造成 **ReDoS**，並會寫出安全的正規表示式。
- 做巢狀驗證、集合元素驗證、`Map` 的 key/value 驗證、`Optional` 與 `JsonNullable` 的容器驗證。
- 用驗證群組讓同一個 DTO 在不同場景有不同必填欄位，並知道 shop-service 為什麼大多不用它。
- 寫出自訂驗證器，並用 `addPropertyNode()` 讓**類別層級驗證產生正確的 `field`**。
- 說出為什麼**不該**在驗證器裡注入 Repository。
- 設計驗證訊息的 i18n，並避開 **EL 注入**風險。
- 把 `BindingResult` 轉成 03-rest-api 第 04 章定義的 `errors[]` 格式（含 `rejectedValue` 遮蔽）。
- 建立四層 DoS 防護：body 大小、JSON 深度、集合長度、字串長度。
- 為驗證寫測試 —— 而且是**不啟動 Spring** 的快測試。

---

## 2.2 先看見痛：少驗一個欄位的代價

### 2.2.1 事故一：`quantity` 沒有上限

一個真實的訂單 API，`CreateOrderRequest.Item` 長這樣：

```java
public record Item(
    @NotBlank String productId,
    @NotNull @Min(1) Integer quantity      // ← 有下限，沒有上限
) {}
```

有人送了：

```json
{ "items": [{ "productId": "P-1001", "quantity": 2000000000 }] }
```

發生的事，依序：

| 步驟 | 結果 |
|---|---|
| 1. 驗證通過 | `2000000000 >= 1` ✅ |
| 2. Service 查商品，算金額 | `640.00 × 2000000000 = 1,280,000,000,000` |
| 3. 檢查庫存 | 庫存 3 < 20 億 → 拋 `InsufficientStockException` → 409 |

**看起來擋住了。但真正的問題在第 2 步之前。**

同一個攻擊者把 `items` 改成 50 項（`@Size(max = 50)` 的上限），每項 20 億：

```
50 次商品查詢（每次都是 DB 往返）
+ 50 次 BigDecimal.multiply（超大數字，但這個很快）
+ 50 次庫存查詢（帶 SELECT ... FOR UPDATE 的行鎖）
```

**每個請求都會取得 50 個行鎖然後回滾。** 200 個並行請求 = 10,000 個行鎖競爭。
資料庫的 lock wait timeout 開始出現，**正常下單的使用者也開始失敗**。

真正的修法有兩個層次：

```java
public record Item(
    @NotBlank @Size(max = 64) String productId,
    @NotNull
    @Min(value = 1, message = "數量最少 1")
    @Max(value = 999, message = "單項數量最多 999")      // ★ 上限
    Integer quantity
) {}
```

外加**跨欄位**的總量檢查（因為 50 項 × 999 = 49,950 也不合理）：

```java
@AssertTrue(message = "訂單總件數超過上限（1000 件）")
public boolean isTotalQuantityWithinLimit() {
    return items.stream().mapToInt(Item::quantity).sum() <= 1000;
}
```

> **原則：每一個數值欄位都要有上限。**
> 「下限有了就好」是最常見的驗證漏洞 —— 因為開發時你想的是「不能是 0 或負數」，
> 沒想過「有人會送 20 億」。

### 2.2.2 事故二：`customerNote` 沒有長度限制

```java
@Size(max = 200) String customerNote      // ✅ 這個有寫
String internalNote                        // ❌ 這個忘了（客服用的欄位）
```

客服系統有個 bug，把整份客訴對話紀錄（1.2 MB）貼進 `internalNote`。

| 步驟 | 結果 |
|---|---|
| 驗證 | 通過（沒有 `@Size`） |
| 寫入 MySQL | `internal_note` 是 `varchar(500)` → `Data truncation` 錯誤 |
| 但這是 `sql_mode` 寬鬆的舊環境 | **靜默截斷成 500 字**，只印一個 warning |
| 回應 | 200 OK |

客服看到「儲存成功」，但只存了前 500 字。三個月後打官司要調紀錄，發現全部不完整。

⚠️ **更糟的變體**：如果那個欄位是 `TEXT` 而沒有截斷，
1.2 MB × 每天 3,000 筆 = 每天 3.6 GB。三個月後資料庫磁碟滿，**整個服務寫不進去**。

> **原則：每一個字串欄位都要有 `@Size(max = ...)`，而且要比資料庫欄位小或等於。**
> 這條規則可以自動檢查（2.13.4 會寫一個測試）。

### 2.2.3 事故三：`@Email` 讓你以為驗過了

```java
@NotBlank @Email String email
```

以下**全部通過** Hibernate Validator 的 `@Email`：

```
a@b
test@localhost
admin@127.0.0.1
"><script>alert(1)</script>@x.co
user@example..com
```

`@Email` 的預設實作幾乎只檢查「有一個 `@`、前後都不是空的、沒有明顯非法字元」。
它**不檢查** TLD 是否存在、不檢查網域是否可收信、不檢查長度。

真實後果：註冊時填 `a@b` → 通過 → 寄驗證信 → SMTP 退信 →
使用者永遠收不到信、也不知道為什麼 → 客服電話。

**正確做法（三層）**：

```java
public record RegisterRequest(
    @NotBlank(message = "請輸入 Email")
    @Size(max = 254, message = "Email 長度上限 254 字元")          // ★ RFC 5321 的上限
    @Email(regexp = EMAIL_REGEX, message = "Email 格式不正確")     // ★ 自己的正規表示式
    String email
) {
    /**
     * 比預設寬鬆度嚴格：要求 TLD 至少 2 字元、不允許連續點。
     * ⚠️ 刻意寫成「沒有巢狀量詞」的形式，避免 ReDoS（2.4.7）。
     */
    static final String EMAIL_REGEX =
        "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
      + "@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
      + "(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";
}
```

**第三層在 Service**：真的寄一封驗證信，只有點了連結才算「已驗證」。

> **`@Email` 的正確心態**：它是「擋掉明顯的打錯字」（少了 `@`），
> **不是**「保證這個 Email 存在」。後者只能靠寄信驗證。

### 2.2.4 把驗證看成資安層而不是 UX 層

前面三個例子有一個共同結構：

```
少驗一個欄位
   ↓
不是「使用者體驗變差」
   ↓
是「資源被耗盡」/「資料靜默錯誤」/「攻擊面打開」
```

| 沒驗的東西 | 開發時想的 | 實際發生的 |
|---|---|---|
| 數值上限 | 「使用者不會買 20 億個」 | 鎖競爭 → 全站下單失敗 |
| 字串長度 | 「備註不會太長」 | 磁碟耗盡 / 靜默截斷 |
| 集合長度 | 「購物車不會有一萬項」 | `IN (10000 個值)` → 查詢計畫崩潰 |
| 列舉值 | 「前端只會送我定義的值」 | 500 + stack trace 洩漏 |
| JSON 深度 | 「沒人會送巢狀 1000 層」 | 反序列化時 `StackOverflowError` |
| 正規表示式 | 「這個 regex 很精確」 | ReDoS：一個 30 字元的輸入卡住 CPU 40 秒 |

> **判準**：問「如果有人**故意**送最壞的值，會發生什麼？」
> 如果答案不是「回一個 4xx」，那就是漏洞。

---

## 2.3 Bean Validation 的機制

### 2.3.1 規格與實作

| 東西 | 是什麼 |
|---|---|
| **Jakarta Validation 3.0**（JSR 380 的 Jakarta 版） | 規格。定義 `@NotNull`、`Validator` 介面等。套件名 `jakarta.validation.*` |
| **Hibernate Validator 8.x** | 參考實作。Spring Boot 3 預設用它 |
| **`spring-boot-starter-validation`** | 把上面兩個 + Jakarta EL 拉進來的 starter |

⚠️ **Spring Boot 2.3 起 `spring-boot-starter-validation` 不再隨 web starter 附帶。**
沒加的話：

```java
@Valid @RequestBody CreateOrderRequest request     // ← 完全不會驗證，也不會報錯
```

**這是「驗證沒生效」最常見的原因**，而且它是**靜默的**：
沒有例外、沒有 WARN，請求帶著 `null` 一路衝進 Service。

**檢查方式**：

```bash
./mvnw dependency:tree | grep -E "hibernate-validator|jakarta.validation"
```

應該看到：

```
[INFO] +- org.springframework.boot:spring-boot-starter-validation:jar:3.2.5:compile
[INFO] |  +- org.apache.tomcat.embed:tomcat-embed-el:jar:10.1.20:compile
[INFO] |  \- org.hibernate.validator:hibernate-validator:jar:8.0.1.Final:compile
[INFO] |     \- jakarta.validation:jakarta.validation-api:jar:3.0.2:compile
```

**`tomcat-embed-el` 也是必要的** —— Hibernate Validator 用 Jakarta EL 做訊息插值。
少了它會在第一次驗證失敗時拋：

```
jakarta.validation.ValidationException: HV000183: Unable to initialize
'jakarta.el.ExpressionFactory'. Check that you have the EL dependencies on the classpath
```

### 2.3.2 誰觸發驗證 ★

這是本章最重要的機制。**有三條完全不同的路徑。**

**路徑 A：`@Valid` 在 `@RequestBody` 上**

```java
public ... create(@Valid @RequestBody CreateOrderRequest request) { }
```

```
RequestResponseBodyMethodProcessor.resolveArgument()
  → HttpMessageConverter 讀出物件
  → validateIfApplicable()：看到 @Valid（或 @Validated）就呼叫 binder.validate()
  → 有錯 → throw new MethodArgumentNotValidException(parameter, bindingResult)
```

**路徑 B：`@Valid` 在 `@ModelAttribute`（查詢參數綁定的物件）上**

```java
public ... list(@Valid @ModelAttribute OrderFilter filter) { }
```

```
ModelAttributeMethodProcessor.resolveArgument()
  → WebDataBinder 綁定（可能已經有型別轉換錯誤）
  → validateIfApplicable()
  → 有錯 → throw new MethodArgumentNotValidException(...)
```

⚠️ **注意路徑 B 的 `BindingResult` 裡可能同時有「型別轉換錯誤」和「約束違反」**。
`?page=abc&size=99999` 會產生兩種錯誤，格式不同（2.9.3 會處理）。

**路徑 C：約束直接放在方法參數上**

```java
public ... get(@PathVariable("orderId") @Size(max = 64) String orderId,
               @RequestHeader("Idempotency-Key") @NotBlank String key) { }
```

這條路徑在 Spring 6.0 與 6.1 **行為不同**，而且差別很大：

| 版本 | 機制 | 需要 `@Validated` 在類別上？ | 失敗例外 | 預設狀態碼 |
|---|---|---|---|---|
| Spring 6.0（Boot 3.0/3.1） | `MethodValidationPostProcessor` 的 **AOP proxy** | ✅ 必須 | `ConstraintViolationException` | ⚠️ **500** |
| **Spring 6.1（Boot 3.2）+** | `RequestMappingHandlerAdapter` **內建** | ❌ 不需要 | `HandlerMethodValidationException` | **400** |

**Spring 6.1 的內建機制好得多**：

- 不需要 AOP proxy（少一層代理，stack trace 乾淨）。
- 例外裡有**完整的參數資訊**（哪個參數、什麼註解、什麼值），
  而 `ConstraintViolationException` 的 `propertyPath` 是 `get.arg0` 這種沒用的東西。
- 預設就是 400 而不是 500。

⚠️ **而且兩者不能並存 —— 有 `@Validated` 會讓內建機制失效。** ★

Spring 6.1 的邏輯是：**如果這個 controller bean 已經被 `MethodValidationPostProcessor` 代理過
（也就是類別上有 `@Validated`），就跳過內建的方法驗證**，
把工作留給 AOP —— 於是你又拿回 `ConstraintViolationException` 與 500。

> **修正 01 章的建議**：01 章為了讓 `@NotBlank` 在 header 參數上生效，
> 在類別上加了 `@Validated`。那是 Boot 3.0/3.1 的做法。
> **在 Boot 3.2+ 應該把 `@Validated` 拿掉**，讓內建機制接手。

**shop-service 的決定**（基準是 Boot 3.2）：

```java
@RestController
@RequestMapping(path = "/orders", produces = MediaType.APPLICATION_JSON_VALUE)
// ★ 不加 @Validated：讓 Spring 6.1 的內建方法驗證生效
public class OrderController {

    @GetMapping("/{orderId}")
    public ResponseEntity<OrderDetail> get(
            @PathVariable("orderId") @Size(max = 64) String orderId, ...) { }
}
```

**怎麼確認你的專案走哪一條路徑**（30 秒驗證）：

```java
@Test
void 方法參數驗證應該回400而不是500() throws Exception {
    mockMvc.perform(get("/orders/" + "x".repeat(200)))
           .andExpect(status().isBadRequest());       // 500 就代表走了 AOP 路徑
}
```

或直接看例外型別：

```yaml
logging:
  level:
    org.springframework.web.servlet.DispatcherServlet: DEBUG
```

失敗時日誌會印出例外類別名稱，`HandlerMethodValidationException` 就是內建路徑。

### 2.3.3 三種驗證失敗例外對照表

| 例外 | 來自 | 拿錯誤明細的方式 | 03 章的對映 |
|---|---|---|---|
| `MethodArgumentNotValidException` | `@Valid @RequestBody` / `@Valid @ModelAttribute` | `getBindingResult().getAllErrors()` | 422 `VALIDATION_FAILED` |
| `HandlerMethodValidationException` | 方法參數上的約束（Spring 6.1+） | `getAllValidationResults()` → 每個有 `getMethodParameter()` 與 `getResolvableErrors()` | 422 `VALIDATION_FAILED` |
| `ConstraintViolationException` | `@Validated` 的 AOP 路徑；或你自己呼叫 `validator.validate()` | `getConstraintViolations()` → `getPropertyPath()` | 422 `VALIDATION_FAILED` |

**三個都要在 advice 裡處理**（03 章 3.5），而且**都要轉成同一種 `errors[]` 格式**。
因為前端不該知道你的驗證是在哪一層做的。

⚠️ 還有第四種：`BindException`。
它出現在「`@ModelAttribute` 綁定失敗且方法有 `BindingResult` 參數但你沒讀它」，
或非 REST 的表單場景。實務上 REST API 很少遇到，但 advice 裡順手處理它比較安全。

### 2.3.4 `@Valid` 與 `@Validated` 的差別

| | `@Valid`（`jakarta.validation`） | `@Validated`（`org.springframework.validation.annotation`） |
|---|---|---|
| 來自 | Jakarta Validation 規格 | Spring |
| 能指定群組 | ❌ | ✅ `@Validated(OnCreate.class)` |
| 能放在類別上啟用方法驗證 | ❌ | ✅（但見 2.3.2 的警告） |
| 能放在欄位上做**巢狀**驗證 | ✅ | ❌ **不行** |

**最後一列很重要**：巢狀驗證只認 `@Valid`。

```java
public record CreateOrderRequest(
    @Valid InvoiceRequest invoice,        // ✅ 會驗證 invoice 內部的約束
    @Validated InvoiceRequest wrong       // ❌ 不會驗證內部（@Validated 不是巢狀標記）
) {}
```

**shop-service 的規則**：
- 方法參數上、欄位上 → 一律 `@Valid`。
- 只有需要指定群組時才用 `@Validated(...)`。

---

## 2.4 完整註解清單與 `null` 行為 ★

### 2.4.1 最重要的一張表

**除了 `@NotNull`、`@NotEmpty`、`@NotBlank` 之外，所有約束都認為 `null` 是合法的。**

這句話是 Bean Validation 的核心規則，也是 bug 的最大來源。

```java
@Size(min = 4, max = 32) String couponCode      // couponCode = null → ✅ 通過
@Min(1) Integer quantity                        // quantity = null → ✅ 通過
@Pattern(regexp = "\\d{8}") String taxId        // taxId = null → ✅ 通過
@Past LocalDate birthday                        // birthday = null → ✅ 通過
```

**為什麼規格這樣設計？** 因為它讓「必填」與「格式」正交：

```java
// 選填欄位：沒送就算了，送了就要符合格式
@Size(max = 32) @Pattern(regexp = "^[A-Z0-9]+$") String couponCode

// 必填欄位：加上 @NotBlank
@NotBlank @Size(max = 32) @Pattern(regexp = "^[A-Z0-9]+$") String couponCode
```

**但它造成的實際 bug**：

```java
public record CreateOrderRequest(
    @Size(max = 50) List<@Valid Item> items,      // ❌ 忘了 @NotEmpty
    ...
) {}
```

送 `{"items": null}` 或完全不送 `items` → **驗證通過** → 
Service 拿到 `null` → `items.stream()` → **NPE → 500**。

> **檢查習慣**：寫完 DTO 後逐一問每個欄位「這個是必填嗎？」
> 是 → 一定要有 `@NotNull` / `@NotEmpty` / `@NotBlank` 其中一個。
> 2.13.4 會寫一個測試自動檢查這件事。

### 2.4.2 `@NotNull` / `@NotEmpty` / `@NotBlank` 的差別

| 註解 | 支援型別 | `null` | `""` | `"  "` | `[]` | `["a"]` |
|---|---|---|---|---|---|---|
| `@NotNull` | 任何 | ❌ | ✅ | ✅ | ✅ | ✅ |
| `@NotEmpty` | `CharSequence`、`Collection`、`Map`、陣列 | ❌ | ❌ | ✅ ⚠️ | ❌ | ✅ |
| `@NotBlank` | **只有 `CharSequence`** | ❌ | ❌ | ❌ | 💥 | 💥 |

**三個要注意的點：**

**① `@NotEmpty` 對 `"  "`（全空白）是通過的。** 字串一律用 `@NotBlank`。

**② `@NotBlank` 放在 `List` 上會拋例外**（不是驗證失敗，是設定錯誤）：

```
jakarta.validation.UnexpectedTypeException: HV000030: No validator could be found
for constraint 'jakarta.validation.constraints.NotBlank' validating type
'java.util.List<Item>'. Check configuration for 'items'
```

⚠️ **這個例外發生在第一次驗證時，不是啟動時。** 也就是說：
你以為端點好了，直到某個請求觸發驗證才 500。
**所以驗證一定要有測試**（2.13）。

**③ `@NotEmpty` 不能用在數字上。**

```java
@NotEmpty Integer quantity     // 💥 UnexpectedTypeException
@NotNull Integer quantity      // ✅
```

**決策口訣**：

```
字串必填 → @NotBlank
集合必填且不可空 → @NotEmpty
數字 / 布林 / 物件 / 日期必填 → @NotNull
集合可以是空的但不可以是 null → @NotNull
```

最後一種很常見：

```java
// 「可以沒有明細，但不能是 null」
@NotNull @Size(max = 50) List<@Valid Item> items
```

⚠️ 但 shop-service 的 `items` 是 `@NotEmpty`（訂單不能沒有商品），
而 `shipments` 在回應方向是「永遠回 `[]` 不回 `null`」（03-rest-api 3.7.2 規則 1）。
**請求方向與回應方向的規則不同**，不要混淆。

### 2.4.3 數值約束：四組註解的分工

| 註解 | 支援型別 | 用途 |
|---|---|---|
| `@Min` / `@Max` | `BigDecimal`、`BigInteger`、`byte`/`short`/`int`/`long` 及其包裝 | 整數上下限。⚠️ **不支援 `float` / `double`** |
| `@DecimalMin` / `@DecimalMax` | 上面 + **`CharSequence`** | 小數上下限；值寫成字串 |
| `@Positive` / `@PositiveOrZero` / `@Negative` / `@NegativeOrZero` | 同 `@Min` | 語意更清楚的常見情況 |
| `@Digits(integer=, fraction=)` | `BigDecimal`、`BigInteger`、`CharSequence`、整數型別 | 限制整數位數與小數位數 |

**⚠️ `@Min` / `@Max` 不支援 `float` / `double` 是規格明文規定的**
（理由是浮點數的捨入誤差會讓邊界判斷不可靠）。放上去會拋 `UnexpectedTypeException`。

**這也是為什麼金額不能用 `double`。** 03-rest-api 第 03 章 3.5.3 的規則：
**金額用 `BigDecimal`（JSON 裡是字串）**。

```java
public record AdjustPriceRequest(
    @NotNull
    @DecimalMin(value = "0.00", inclusive = true, message = "金額不可為負")
    @DecimalMax(value = "9999999999.99", message = "金額超過上限")
    @Digits(integer = 10, fraction = 2, message = "金額最多 2 位小數")
    BigDecimal price
) {}
```

**`@Digits` 是很容易忘但很重要的一個** —— 沒有它的話：

```json
{ "price": "100.123456789012345678901234567890" }
```

會通過 `@DecimalMin` / `@DecimalMax`，然後：

| 步驟 | 結果 |
|---|---|
| 寫入 `DECIMAL(12,2)` | MySQL 四捨五入成 `100.12`（寬鬆模式）或報錯（嚴格模式） |
| 但 Service 已經用完整精度算過折扣、稅 | **總額和明細加起來對不起來** |

**`@Digits` 的兩個細節**：

- `integer` 是**整數部分**的最大位數，`fraction` 是小數部分。
  `@Digits(integer=10, fraction=2)` 允許最大 `9999999999.99`。
- 它檢查的是**實際位數**，不是 scale。`"100.10"` 的 fraction 是 2，`"100.1"` 是 1，都通過。

### 2.4.4 `@Size` 的四種型別與陷阱

```java
@Size(min = 2, max = 100) String keyword                 // 字元數
@Size(max = 50) List<Item> items                          // 元素個數
@Size(max = 20) Map<String, String> metadata              // entry 個數
@Size(max = 10) String[] tags                             // 陣列長度
```

⚠️ **陷阱：字串的「長度」是 UTF-16 code unit 數，不是「字」數。**

```java
@Size(max = 10) String name
```

| 輸入 | `length()` | 通過？ |
|---|---|---|
| `"王小明"` | 3 | ✅ |
| `"abcdefghij"` | 10 | ✅ |
| `"👨‍👩‍👧‍👦"`（一個家庭 emoji） | **11** | ❌ |
| `"𝕊𝕡𝕣𝕚𝕟𝕘"`（數學字母，各 2 code unit） | 12 | ❌ |

**使用者看到的是「6 個字」，你的驗證說「超過 10」。**

這在暱稱、備註欄位上會造成客服問題。要處理的話用自訂驗證器數 code point：

```java
package example.shop.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;
import java.lang.annotation.*;

/** 以「使用者感知的字元數」（code point）計算長度，讓 emoji 不會被誤判。 */
@Documented
@Constraint(validatedBy = TextLengthValidator.class)
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT,
         ElementType.TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface TextLength {
    int min() default 0;
    int max();
    String message() default "{example.shop.validation.TextLength.message}";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
```

```java
package example.shop.common.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

public class TextLengthValidator implements ConstraintValidator<TextLength, CharSequence> {

    private int min;
    private int max;

    @Override
    public void initialize(TextLength annotation) {
        this.min = annotation.min();
        this.max = annotation.max();
        if (min < 0 || max < min) {
            throw new IllegalArgumentException("TextLength 的 min/max 設定錯誤");
        }
    }

    @Override
    public boolean isValid(CharSequence value, ConstraintValidatorContext ctx) {
        if (value == null) return true;                       // ★ null 交給 @NotBlank
        String s = value.toString();
        int count = s.codePointCount(0, s.length());          // ★ 不是 length()
        return count >= min && count <= max;
    }
}
```

⚠️ **`@Target` 要包含 `RECORD_COMPONENT`** —— 但**理由不是「不然會編譯錯誤」**。
完整說明見 2.7.1（那是一個很常被講錯的地方）。

⚠️ 嚴格說 code point 也不是「使用者感知的字元」（grapheme cluster）——
`"👨‍👩‍👧‍👦"` 是 7 個 code point（4 個人 + 3 個 ZWJ）。
真正精確要用 `BreakIterator.getCharacterInstance()`。
但那對「限制長度」這個目的通常過度了；**shop-service 的決定是用 code point**，
並把資料庫欄位開得比驗證上限寬鬆（`varchar(1000)` 對 `max=200`），留出安全邊界。

### 2.4.5 時間約束

| 註解 | 語意 |
|---|---|
| `@Past` / `@PastOrPresent` | 必須在現在之前 |
| `@Future` / `@FutureOrPresent` | 必須在現在之後 |

```java
public record CreateReturnRequest(
    @NotNull @PastOrPresent(message = "收貨日期不可以是未來")
    LocalDate receivedDate,
    ...
) {}
```

⚠️ **三個坑：**

**① 「現在」是誰的現在？** 預設用 `Clock.systemDefaultZone()`。
如果伺服器時區是 UTC 而使用者在 UTC+8，那麼台灣時間 8/20 08:00 時，
UTC 是 8/20 00:00 —— 使用者送 `2026-08-20` 當「今天」是合法的。
但台灣時間 8/20 早上 7 點時，UTC 還是 8/19 23:00，`2026-08-20` 就變成「未來」→ **驗證失敗**。

**每天有 8 小時的窗口，使用者選「今天」會被拒絕。** 這是真實發生過的 bug。

**解法**：自訂 `ClockProvider`：

```java
@Configuration
public class ValidationConfig {

    /** 讓 @Past / @Future 用台灣時區判斷「現在」。 */
    @Bean
    LocalValidatorFactoryBean validator(MessageSource messageSource) {
        var bean = new LocalValidatorFactoryBean();
        bean.setValidationMessageSource(messageSource);              // ★ 見 2.8.2
        bean.setConfigurationInitializer(config ->
                config.clockProvider(() -> java.time.Clock.system(
                        java.time.ZoneId.of("Asia/Taipei"))));
        return bean;
    }
}
```

⚠️ `setConfigurationInitializer` 接受的是 `Consumer<jakarta.validation.Configuration<?>>`。
不同 Spring 版本的方法名可能不同；若不存在，改用
`bean.getValidationPropertyMap().put(...)` 或直接建立自己的 `ValidatorFactory`。

**更穩的做法：不要用 `@Past` / `@Future`，用明確的業務規則。**

```java
@AssertTrue(message = "收貨日期不可晚於今天（以台灣時間計）")
public boolean isReceivedDateValid() {
    return receivedDate == null
        || !receivedDate.isAfter(LocalDate.now(ZoneId.of("Asia/Taipei")));
}
```

**② `@Future` 對「剛好等於現在」的行為。** `@Future` 是嚴格大於，
所以 `Instant.now()` 送出去到伺服器驗證之間的幾毫秒，會讓它變成「過去」→ 失敗。
需要「現在或未來」時一定要用 `@FutureOrPresent`。

**③ 時間相關的驗證幾乎都該是業務規則，不是格式規則。**
「退貨日期不能超過收貨後 7 天」需要查訂單 → 那是 Service 的事（0.7 問題 3）。

### 2.4.6 布林與其他

| 註解 | 用途 |
|---|---|
| `@AssertTrue` / `@AssertFalse` | 布林欄位必須是 true / false；**也可放在無參方法上做跨欄位驗證**（1.7.2） |
| `@Null` | 必須是 `null`。用於「這個欄位不該由客戶端提供」 |

`@Null` 有一個很好的用途：**明確拒絕客戶端送伺服器決定的欄位**。

```java
public record CreateOrderRequest(
    ...
    @Null(message = "訂單金額由系統計算，請勿提供")
    BigDecimal totalAmount            // ★ 存在但必須是 null
) {}
```

比「DTO 裡沒有這個欄位」多了什麼？**明確的錯誤訊息。**

| 做法 | 客戶端送 `totalAmount` 時 |
|---|---|
| DTO 沒這個欄位 + `fail-on-unknown-properties: true` | 400「未知欄位 totalAmount」 |
| DTO 有欄位 + `@Null` | 422「訂單金額由系統計算，請勿提供」← 更好懂 |

⚠️ 但這會讓 DTO 多一個不用的欄位，而且 OpenAPI 會列出它。
**shop-service 的決定：不用 `@Null`，靠「DTO 沒有這個欄位」+ 未知欄位檢查。**
理由是「Request DTO 的欄位清單 = API 契約」，多一個假欄位會讓契約模糊。

### 2.4.7 `@Pattern` 與 ReDoS ★

```java
@Pattern(regexp = "^\\d{8}$", message = "統一編號須為 8 位數字") String taxId
```

**`@Pattern` 是最強大也最危險的約束。** 危險在於 **ReDoS（正規表示式阻斷服務）**。

**問題的來源：災難性回溯（catastrophic backtracking）。**

看這個常見的 Email 正規表示式（在網路上到處都找得到）：

```java
@Pattern(regexp = "^([a-zA-Z0-9_\\.\\-])+\\@(([a-zA-Z0-9\\-])+\\.)+([a-zA-Z0-9]{2,4})+$")
```

⚠️ 注意 `(([a-zA-Z0-9\-])+\.)+` —— **量詞裡面又有量詞**。

送一個這樣的輸入：

```
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!
```

（結尾的 `!` 讓比對必定失敗，於是引擎要窮舉所有可能的切分方式。）

**36 個 `a` → 2³⁶ 種切分 → 單執行緒卡住數十秒到數分鐘。**

```
一個 60 bytes 的請求
→ 一條 Tomcat 執行緒 100% CPU 40 秒
→ 200 個這種請求 = 全部執行緒卡死 = 全站無回應
```

**而且它繞過了所有速率限制**（因為請求數量很少，只是每個很貴）
和所有 timeout（Java 的 `Matcher` 不可中斷，`Thread.interrupt()` 對它無效）。

**四條安全規則：**

| 規則 | 說明 |
|---|---|
| **1. 不要有巢狀量詞** | `(a+)+`、`(a*)*`、`(a\|aa)+` 都是危險模式 |
| **2. 用固定長度** | `\\d{8}` 比 `\\d+` 安全 |
| **3. 用字元類別而不是分組** | `[a-z0-9-]+` 比 `([a-z]\|[0-9]\|-)+` 安全 |
| **4. 一定要有 `@Size` 上限** | 即使 regex 有問題，輸入短就炸不起來 |

**第 4 條是最實用的防線**：

```java
// ✅ 即使 regex 不完美，@Size(max=254) 也把最壞情況限制住了
@Size(max = 254) @Pattern(regexp = EMAIL_REGEX) String email
```

⚠️ **但要注意驗證順序**：Bean Validation **不保證**約束的執行順序！
`@Size` 和 `@Pattern` 是**兩個獨立的約束，兩個都會被執行**。
所以「先檢查長度再檢查 regex」**不會自動發生**。

**要保證順序必須用 `@GroupSequence`**（2.6.4）：

```java
package example.shop.common.validation;

import jakarta.validation.GroupSequence;

public interface ValidationOrder {
    interface Length {}      // 第一階段：長度
    interface Format {}      // 第二階段：格式

    @GroupSequence({Length.class, Format.class})
    interface Sequence {}
}
```

```java
public record RegisterRequest(
    @NotBlank(groups = ValidationOrder.Length.class)
    @Size(max = 254, groups = ValidationOrder.Length.class)          // 先驗
    @Pattern(regexp = EMAIL_REGEX, groups = ValidationOrder.Format.class)  // 後驗
    String email
) { ... }
```

```java
// Controller
public ... register(@Validated(ValidationOrder.Sequence.class) @RequestBody RegisterRequest r) { }
```

**`@GroupSequence` 的語意：前一個群組有任何錯誤就不執行後面的群組。**
於是超長輸入永遠不會進到 `@Pattern`。

⚠️ 這個寫法很囉唆。**shop-service 的實務折衷**：

1. **所有正規表示式都手工審查過沒有巢狀量詞**（這是 code review checklist 的一項）。
2. 用 **request body 大小上限**（2.11.1）當第一道防線 —— 
   body 最多 1 MB，單一欄位就不可能是 36 個 `a` 以外的怪東西…
   ⚠️ 這句話其實不成立：1 MB 的 body 完全可以放 36 個 `a`。
   **所以第 1 條（審查 regex）才是真正的防線，body 大小上限不是。**
3. 只有**明確有 ReDoS 風險又不得不用複雜 regex** 的欄位才用 `@GroupSequence`。

**怎麼審查一個 regex 有沒有 ReDoS 風險？**

```bash
# 用 Node 的 recheck（或 Python 的 regexploit）掃描
npx recheck-cli '^([a-zA-Z0-9_\.\-])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z0-9]{2,4})+$'
# → vulnerable (exponential)
```

或寫一個測試（很粗但有效）：

```java
@Test
void email正規表示式不應有災難性回溯() {
    String evil = "a".repeat(40) + "@" + "a".repeat(40) + "!";
    long start = System.nanoTime();
    boolean matched = java.util.regex.Pattern
            .compile(RegisterRequest.EMAIL_REGEX).matcher(evil).matches();
    long ms = (System.nanoTime() - start) / 1_000_000;

    assertThat(matched).isFalse();
    assertThat(ms).as("regex 比對耗時 %d ms，可能有 ReDoS 風險", ms).isLessThan(100);
}
```

**把這個測試加進每個用 `@Pattern` 的欄位。** 它跑得很快，而且會在 CI 上抓到問題。

### 2.4.8 完整註解速查表

| 註解 | `null` 視為 | 支援型別（摘要） | shop-service 用在 |
|---|---|---|---|
| `@NotNull` | ❌ 失敗 | 任何 | `quantity`、`type`、`receivedDate` |
| `@NotEmpty` | ❌ 失敗 | `CharSequence`/`Collection`/`Map`/陣列 | `items` |
| `@NotBlank` | ❌ 失敗 | 只有 `CharSequence` | `productId`、`shippingAddressId`、`reason` |
| `@Size` | ✅ 通過 | `CharSequence`/`Collection`/`Map`/陣列 | 幾乎所有字串與集合 |
| `@Min` / `@Max` | ✅ 通過 | 整數型別、`BigDecimal`、`BigInteger` | `quantity`、`expiryMonth` |
| `@DecimalMin` / `@DecimalMax` | ✅ 通過 | 上面 + `CharSequence` | 金額 |
| `@Digits` | ✅ 通過 | 數值 + `CharSequence` | 金額 |
| `@Positive` / `@PositiveOrZero` | ✅ 通過 | 數值 | 庫存調整量 |
| `@Pattern` | ✅ 通過 | `CharSequence` | `taxId`、`carrierId`、`phone`、`couponCode` |
| `@Email` | ✅ 通過 | `CharSequence` | ⚠️ 一律搭配 `regexp` + `@Size` |
| `@Past` / `@PastOrPresent` | ✅ 通過 | 時間型別 | ⚠️ 注意時區（2.4.5） |
| `@Future` / `@FutureOrPresent` | ✅ 通過 | 時間型別 | 折扣碼有效期（後台） |
| `@AssertTrue` / `@AssertFalse` | ✅ 通過 | `Boolean`/`boolean`、**無參方法** | 跨欄位驗證 |
| `@Null` | — | 任何 | ❌ 不用（2.4.6） |
| `@Valid` | ✅ 通過 | 物件、容器元素 | 巢狀 DTO |

---

## 2.5 巢狀與集合驗證

### 2.5.1 `@Valid` 的傳遞性：它不會自動遞迴

**這是第二大 bug 來源。**

```java
public record CreateOrderRequest(
    List<Item> items,                    // ❌ 沒有 @Valid → Item 內部的約束完全不會執行
    InvoiceRequest invoice               // ❌ 同上
) {
    public record Item(
        @NotBlank String productId,      // ← 永遠不會被檢查
        @NotNull @Min(1) Integer quantity
    ) {}
}
```

送 `{"items": [{"productId": "", "quantity": -5}]}` → **驗證通過** → 
Service 收到空的 productId 與負數量。

**正確寫法：每一層都要標。**

```java
public record CreateOrderRequest(
    @NotEmpty @Size(max = 50)
    List<@Valid Item> items,             // ★ @Valid 在「元素」上（容器元素約束）

    @Valid
    InvoiceRequest invoice               // ★ @Valid 在欄位上
) { ... }
```

⚠️ **注意兩種位置的差別：**

```java
@Valid List<Item> items          // 舊寫法（Bean Validation 1.x 風格）：也能驗證元素
List<@Valid Item> items          // 新寫法（Bean Validation 2.0 容器元素約束）：更精確
```

兩者在 Hibernate Validator 8 都能驗證元素。**差別在錯誤路徑（`propertyPath`）**：

| 寫法 | 錯誤的 `propertyPath` |
|---|---|
| `@Valid List<Item> items` | `items[0].productId` |
| `List<@Valid Item> items` | `items[0].productId` |

實測**兩者相同**。所以選哪個是風格問題。
**shop-service 選 `List<@Valid Item>`**，因為它和 `List<@NotBlank String>`
（純元素約束，沒有巢狀物件）的寫法一致。

### 2.5.2 集合元素的約束

```java
// 元素本身要符合約束（不是巢狀物件）
List<@NotBlank @Size(max = 64) String> customerId

// Map 的 key 與 value 各自約束
Map<@Pattern(regexp = "^[a-z_]{1,32}$") String, @Size(max = 200) String> metadata

// Optional 裡的值
Optional<@NotBlank String> nickname

// JsonNullable 裡的值（1.6.4）
@Size(max = 200) JsonNullable<String> customerNote
```

**這些叫「容器元素約束」（container element constraints），Bean Validation 2.0 引入。**
它們靠 `ValueExtractor` 實作：Hibernate Validator 內建了 `List`、`Set`、`Map`、
`Optional`、`OptionalInt`… 的 extractor；`JsonNullable` 的 extractor 由
`jackson-databind-nullable` 提供。

⚠️ **`@Size(max = 200) JsonNullable<String>` 這個寫法的語意**：
`@Size` 是放在**欄位**上還是**容器元素**上？

```java
@Size(max = 200) JsonNullable<String> customerNote          // 放在欄位上
JsonNullable<@Size(max = 200) String> customerNote          // 放在元素上（明確）
```

第一種寫法能不能生效，取決於 Hibernate Validator 是否對這個欄位套用 value extraction。
**明確的寫法是第二種。** shop-service 統一用第二種：

```java
public record UpdateOrderRequest(
    JsonNullable<@Size(max = 200) String> customerNote,
    JsonNullable<@Valid CreateOrderRequest.InvoiceRequest> invoice,
    JsonNullable<@Size(max = 500) String> internalNote
) { ... }
```

⚠️ **驗證這件事一定要寫測試**（2.13.3），因為容器元素約束「沒生效」是靜默的。

### 2.5.3 深層巢狀的錯誤路徑

```java
public record CreateOrderRequest(
    List<@Valid Item> items,
    @Valid InvoiceRequest invoice
) {
    public record Item(
        @NotBlank String productId,
        @NotNull @Min(1) Integer quantity,
        List<@Valid Customization> customizations
    ) {}
    public record Customization(
        @NotBlank @Size(max = 32) String key,
        @NotBlank @Size(max = 200) String value
    ) {}
}
```

送出：

```json
{
  "items": [
    { "productId": "P-1", "quantity": 1, "customizations": [{ "key": "", "value": "x" }] }
  ],
  "invoice": { "type": "COMPANY", "taxId": "123" }
}
```

`BindingResult` 裡的 `FieldError.getField()`：

```
items[0].customizations[0].key      ← @NotBlank
invoice.taxId                        ← @Pattern（不是 8 位數字）
```

**這個路徑格式必須原樣回給前端**，因為前端要用它定位輸入框：

```jsonc
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "items[0].customizations[0].key", "code": "NotBlank",
      "message": "不可為空白", "rejectedValue": "" },
    { "field": "invoice.taxId", "code": "Pattern",
      "message": "統一編號須為 8 位數字", "rejectedValue": "123" }
  ]
}
```

（這正是 03-rest-api 第 04 章 4.6.1 定義的格式；2.9 會實作轉換。）

### 2.5.4 集合長度與元素驗證的順序陷阱 ★

**這是 03-rest-api 第 03 章 3.13.3 提到的陷阱，這裡看實作層的真相。**

```java
@NotEmpty @Size(max = 50) List<@Valid Item> items
```

送 100,000 項商品的請求。你以為：

```
@Size(max=50) 失敗 → 立刻回 422 → 便宜
```

**實際發生的是：**

```
1. Jackson 反序列化 100,000 個 Item 物件（記憶體 + CPU）
2. Bean Validation 執行 @Size → 失敗，記一個錯誤
3. Bean Validation 執行 @Valid（每個元素）→ 100,000 × 2 個約束 = 200,000 次驗證
4. BindingResult 裡有 100,001 個錯誤
5. 你的 advice 把 100,001 個錯誤序列化成 JSON → 回應 20 MB
```

**每個約束都會被執行，沒有短路。** 這是 Bean Validation 的規格行為
（除了 `@GroupSequence` 之外沒有順序保證）。

**三層修法：**

**第一層：body 大小上限（最重要）**

```yaml
server:
  tomcat:
    max-swallow-size: 2MB
  # Spring Boot 沒有直接的「JSON body 上限」設定，用 filter 做（2.11.1）
```

**第二層：`@GroupSequence` 讓長度先驗**

```java
public interface SizeFirst {}

public record CreateOrderRequest(
    @NotEmpty(groups = SizeFirst.class)
    @Size(max = 50, groups = SizeFirst.class)
    List<@Valid Item> items,
    ...
) {}

@GroupSequence({SizeFirst.class, Default.class})
public interface CreateOrderSequence {}
```

```java
public ... create(@Validated(CreateOrderSequence.class) @RequestBody CreateOrderRequest r) { }
```

⚠️ 這樣寫的代價：**每個 DTO 都要維護群組**，而且新欄位忘了標群組就不會被驗證
（因為 `Default` 群組在第二階段，而第一階段失敗就不執行第二階段 —— 
所以標錯群組的欄位在「長度錯誤」時完全不會被檢查，這反而不是問題；
真正的問題是**忘了標 `Default`** 的欄位永遠不會被驗證）。

**第三層：錯誤數量上限（一定要做）**

```java
/** 錯誤回應最多列 20 筆，避免 20 MB 的錯誤 JSON。 */
private static final int MAX_ERRORS = 20;

List<FieldViolation> errors = allErrors.stream().limit(MAX_ERRORS).map(this::toDto).toList();
int truncated = Math.max(0, allErrors.size() - MAX_ERRORS);
```

```jsonc
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [ /* 20 筆 */ ],
  "errorCount": 100001,
  "errorsTruncated": true,
  "userMessage": "資料有 100001 個問題，僅顯示前 20 個。"
}
```

**`errorCount` + `errorsTruncated` 讓前端知道「還有更多」**，
而不是以為只有 20 個問題（03-rest-api 第 05 章「靜默截斷是最貴的寬容」的同一個原則）。

**shop-service 的決定**：做第一層與第三層，**不做第二層**。
理由：body 大小上限（1 MB）已經把「100,000 項商品」擋掉了
（每項至少 40 bytes → 100,000 項 ≈ 4 MB > 1 MB），
而 `@GroupSequence` 的維護成本與「忘標群組」的風險不值得。

---

## 2.6 驗證群組

### 2.6.1 問題：同一個 DTO 在不同場景有不同必填欄位

```java
// POST /products：sku 必填
// PATCH /products/{id}：sku 不可修改（不該出現）
public record ProductRequest(
    @NotBlank String sku,          // ← POST 要必填，PATCH 不該有
    @NotBlank String name,
    BigDecimal price
) {}
```

### 2.6.2 群組的寫法

```java
package example.shop.product.web.dto;

public interface ValidationGroups {
    interface OnCreate {}
    interface OnUpdate {}
}
```

```java
public record ProductRequest(
    @NotBlank(groups = OnCreate.class)
    @Null(groups = OnUpdate.class, message = "SKU 建立後不可修改")
    @Size(max = 64)                                    // 沒標群組 → 屬於 Default
    String sku,

    @NotBlank(groups = {OnCreate.class, OnUpdate.class})
    @Size(max = 200)
    String name,

    @NotNull(groups = OnCreate.class)
    @DecimalMin("0.00") @Digits(integer = 10, fraction = 2)
    BigDecimal price
) {}
```

```java
@PostMapping
public ... create(@Validated(OnCreate.class) @RequestBody ProductRequest r) { }

@PatchMapping("/{productId}")
public ... update(@Validated(OnUpdate.class) @RequestBody ProductRequest r) { }
```

### 2.6.3 群組的三個陷阱 ★

**陷阱 1：沒標群組的約束屬於 `Default`，而指定群組時 `Default` 不會執行。**

```java
@Validated(OnCreate.class)      // ← 只驗 OnCreate 群組
```

上面 `ProductRequest` 的 `@Size(max = 64) String sku` **沒標群組 → 屬於 `Default`**，
所以在 `@Validated(OnCreate.class)` 時**完全不會被檢查**。

**這是最常踩的坑**，因為它靜默失效。

**修法一：明確包含 `Default`**

```java
@PostMapping
public ... create(@Validated({OnCreate.class, Default.class}) @RequestBody ProductRequest r) { }
```

**修法二：讓群組繼承 `Default`**

```java
public interface OnCreate extends jakarta.validation.groups.Default {}
```

⚠️ 這個寫法很漂亮但有副作用：`@Validated(Default.class)` 時**不會**包含 `OnCreate`
（繼承方向是單向的）。要理解清楚才用。

**修法三（shop-service 的做法）：每個約束都明確標群組，不留 `Default`。**

```java
public record ProductRequest(
    @NotBlank(groups = OnCreate.class)
    @Null(groups = OnUpdate.class)
    @Size(max = 64, groups = {OnCreate.class, OnUpdate.class})       // ★ 明確
    String sku,
    ...
) {}
```

囉唆，但不會靜默失效。

**陷阱 2：巢狀驗證的群組要自己傳遞。**

```java
@Valid InvoiceRequest invoice                                    // ❌ 群組不會傳下去
@ConvertGroup(from = OnCreate.class, to = OnCreate.class)
@Valid InvoiceRequest invoice                                    // ✅ 明確轉換
```

`@Valid` 對巢狀物件**永遠用 `Default` 群組**，除非用 `@ConvertGroup` 明確轉換。
很多人不知道這件事，於是巢狀物件的群組驗證完全沒生效。

**陷阱 3：`@Valid`（Jakarta）不支援群組，只有 `@Validated`（Spring）支援。**

```java
public ... create(@Valid @RequestBody ProductRequest r) { }              // Default 群組
public ... create(@Validated(OnCreate.class) @RequestBody ProductRequest r) { }  // ✅
```

### 2.6.4 `@GroupSequence`：控制執行順序

群組的另一個用途是**排序**（2.4.7、2.5.4 用過）：

```java
package example.shop.common.validation;

import jakarta.validation.GroupSequence;
import jakarta.validation.groups.Default;

/** 分階段驗證：便宜的先做，避免昂貴的檢查跑在明顯無效的輸入上。 */
public interface Stages {

    /** 第一階段：長度與存在性（最便宜） */
    interface Basic {}

    /** 第二階段：格式（正規表示式，可能昂貴） */
    interface Format {}

    /** 第三階段：跨欄位一致性 */
    interface CrossField {}

    @GroupSequence({Basic.class, Format.class, CrossField.class, Default.class})
    interface All {}
}
```

**語意：前一階段有任何違反就停止，不執行後面的階段。**

```java
public ... register(@Validated(Stages.All.class) @RequestBody RegisterRequest r) { }
```

⚠️ **代價：使用者一次只會看到一個階段的錯誤。**

```
輸入：email 超長 + 密碼太短
→ 只回「email 超長」（Basic 階段失敗，不執行 Format）
→ 使用者改好 email，再送一次，才看到密碼問題
```

**這和 03-rest-api 第 04 章 4.6「一次回全部錯誤」的原則衝突。**

**shop-service 的取捨**：
- **一般 DTO 不用 `@GroupSequence`** → 一次回全部錯誤（使用者體驗優先）。
- **只有明確有 ReDoS 或昂貴檢查風險的欄位**才分階段。
- 而 `Basic` 階段的錯誤（超長、缺欄位）通常代表「這是攻擊或前端 bug」，
  不是「使用者填錯」—— 這種情況只回一個錯誤是可以接受的。

### 2.6.5 為什麼 shop-service 大多用「兩個 DTO」而不是群組

回到 2.6.1 的問題。除了群組，還有一個選項：**寫兩個 DTO**。

```java
public record CreateProductRequest(
    @NotBlank @Size(max = 64) String sku,
    @NotBlank @Size(max = 200) String name,
    @NotNull @DecimalMin("0.00") @Digits(integer = 10, fraction = 2) BigDecimal price
) {}

public record UpdateProductRequest(
    // 沒有 sku —— 型別層面就不可能修改它
    JsonNullable<@Size(max = 200) String> name,
    JsonNullable<@DecimalMin("0.00") @Digits(integer = 10, fraction = 2) BigDecimal> price
) {}
```

| | 驗證群組 | 兩個 DTO |
|---|---|---|
| 程式碼量 | 一個 DTO | 兩個 DTO（有重複） |
| 「不可修改的欄位」 | 靠 `@Null(groups=OnUpdate)` | **型別上不存在** ✅ |
| 三態語意（`PATCH`） | ❌ 做不到（同一個型別） | ✅ 用 `JsonNullable` |
| OpenAPI | 一個 schema，無法表達「這個欄位在 PATCH 時不可用」 | 兩個 schema，清楚 ✅ |
| 「忘標群組」的風險 | ⚠️ 高（2.6.3 陷阱 1） | 不存在 ✅ |
| 新增欄位時 | 要記得標群組 | 要記得加到兩個 DTO（漏了只是少一個功能，不是漏驗證）✅ |

**shop-service 的決定：一律兩個 DTO。**

決定性的理由是最後一列：**兩種做法都會「忘記」，但失敗模式的嚴重性差 100 倍。**
- 忘標群組 → **驗證靜默失效**（安全問題）。
- 忘加欄位到 `UpdateXxxRequest` → 那個欄位改不了（功能問題，前端立刻回報）。

> **驗證群組剩下的正當用途**：
> `@GroupSequence` 的**排序**功能（2.6.4）。這個沒有替代品。

---

## 2.7 自訂驗證器

### 2.7.1 基本結構

一個自訂約束 = **一個註解 + 一個 `ConstraintValidator`**。

```java
package example.shop.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import java.lang.annotation.*;

/** 台灣身分證統一編號。 */
@Documented
@Constraint(validatedBy = TaiwanIdValidator.class)
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT,
         ElementType.TYPE_USE, ElementType.ANNOTATION_TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface TaiwanId {
    String message() default "{example.shop.validation.TaiwanId.message}";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};

    /** 是否接受新式外來人口統一證號（第二位 8 或 9）。 */
    boolean allowResident() default true;
}
```

**四個必要元素**（規格要求，少一個就編譯錯誤）：

| 元素 | 用途 |
|---|---|
| `@Constraint(validatedBy = ...)` | 指定驗證器 |
| `String message()` | 預設訊息（用 `{key}` 走 i18n） |
| `Class<?>[] groups()` | 支援群組 |
| `Class<? extends Payload>[] payload()` | 規格要求；實務上幾乎不用 |

> ### ⚠️⚠️ `RECORD_COMPONENT` 的真正理由（一個常被講錯的地方）★★
>
> 網路上（以及本課程的早期版本）常說「`@Target` 沒有 `RECORD_COMPONENT`
> 就不能標在 record 元件上，會編譯錯誤」。**那是錯的。**
>
> **證據一：JLS 8.10.1** 明確規定，標在 record 元件上的註解會**自動傳播**到
> 所有「target 允許」的位置：
>
> | 註解的 `@Target` 含 | 那個註解會被複製到 |
> |---|---|
> | `FIELD` | 私有的實例欄位 |
> | `PARAMETER` | 正規建構子的對應參數 |
> | `METHOD` | 自動產生的 accessor |
> | `RECORD_COMPONENT` | record 元件本身（保留在 `RecordComponent` 上） |
>
> **只要至少命中一個**，宣告就是合法的。
>
> **證據二：Jakarta 自己的約束就沒有 `RECORD_COMPONENT`**：
>
> ```java
> // jakarta.validation.constraints.Size
> @Target({ METHOD, FIELD, ANNOTATION_TYPE, CONSTRUCTOR, PARAMETER, TYPE_USE })
> public @interface Size { ... }
> //  ★ 沒有 RECORD_COMPONENT，但 @Size 標在 record 元件上完全正常
> ```
>
> 如果那個說法成立，`record CreateOrderRequest(@Size(max=32) String couponCode)`
> 就編譯不過了 —— 而我們整章都在這樣寫。
>
> **那為什麼還是要加？** 兩個真實的理由：
>
> **① 反射式的發現（真正重要的那一個）**
>
> 有些程式碼是透過 `RecordComponent` 讀註解的，而它**只看得到
> target 含 `RECORD_COMPONENT` 的註解**：
>
> ```java
> for (RecordComponent rc : dto.getRecordComponents()) {
>     Masked masked = rc.getAnnotation(Masked.class);   // ★ 沒有 RECORD_COMPONENT 就是 null
>     ...
> }
> ```
>
> 06 章 6.5.5 的 `ReadOnlyFieldInterceptor`、6.6.2 的遮蔽掃描、
> 07 章 7.8.3 的 `DtoScanner` **全部**是這樣做的。
> **所以：只要這個註解可能被反射掃描，就一定要加。**
>
> **② 「不加會出錯」的那個真實案例**
>
> 如果一個註解的 `@Target` 是 `{METHOD}`（只有 METHOD，例如 `@JsonIgnore`），
> 那它標在 record 元件上**才真的會**編譯錯誤 ——
> 因為 record 元件的位置只允許傳播到 accessor，
> 而 `RECORD_COMPONENT` 本身不在允許清單裡。
>
> ⚠️ **但 `@JsonIgnore` 的 target 其實含 `FIELD`**，所以它也是合法的 ——
> 只是它會落在**私有欄位**上，而 Jackson 讀的是 accessor，於是
> **標了但沒有效果**（03 章 3.6.3 有這個坑的完整版）。
> **「合法但沒效果」比「編譯錯誤」難查得多。**
>
> **shop-service 的規則**：自訂約束的 `@Target` 一律寫
> `{FIELD, PARAMETER, RECORD_COMPONENT, METHOD, ANNOTATION_TYPE, TYPE_USE}` ——
> 全部列上去，就不需要每次判斷。

⚠️ **`ANNOTATION_TYPE`** 是為了讓這個約束可以被「組合」（2.7.6）。

```java
package example.shop.common.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

/**
 * 台灣身分證字號檢查碼驗證。
 *
 * <p>演算法：首字母對映成兩位數 X1X2，
 * sum = X1*1 + X2*9 + d1*8 + d2*7 + d3*6 + d4*5 + d5*4 + d6*3 + d7*2 + d8*1 + d9*1，
 * 合法的條件是 sum % 10 == 0。
 */
public class TaiwanIdValidator implements ConstraintValidator<TaiwanId, CharSequence> {

    /** 首字母 A～Z 對映值（A=10 … I=34、O=35、W=32、X=30、Y=31、Z=33）。 */
    private static final int[] LETTER_VALUE = {
        10, 11, 12, 13, 14, 15, 16, 17, 34, 18,   // A B C D E F G H I J
        19, 20, 21, 22, 35, 23, 24, 25, 26, 27,   // K L M N O P Q R S T
        28, 29, 32, 30, 31, 33                     // U V W X Y Z
    };

    private boolean allowResident;

    @Override
    public void initialize(TaiwanId annotation) {
        this.allowResident = annotation.allowResident();
    }

    @Override
    public boolean isValid(CharSequence value, ConstraintValidatorContext ctx) {
        if (value == null) return true;                    // ★ null 交給 @NotBlank

        String id = value.toString().trim().toUpperCase(java.util.Locale.ROOT);
        if (id.length() != 10) return false;

        char first = id.charAt(0);
        if (first < 'A' || first > 'Z') return false;

        char second = id.charAt(1);
        boolean isCitizen  = (second == '1' || second == '2');
        boolean isResident = (second == '8' || second == '9');
        if (!isCitizen && !(allowResident && isResident)) return false;

        for (int i = 1; i < 10; i++) {
            if (id.charAt(i) < '0' || id.charAt(i) > '9') return false;
        }

        int n = LETTER_VALUE[first - 'A'];
        int sum = (n / 10) * 1 + (n % 10) * 9;
        for (int i = 1; i <= 8; i++) {
            sum += (id.charAt(i) - '0') * (9 - i);        // 權重 8,7,6,5,4,3,2,1
        }
        sum += (id.charAt(9) - '0');                      // 檢查碼權重 1

        return sum % 10 == 0;
    }
}
```

**驗證這個實作**（`A123456789` 是公開的測試用號碼）：

```
A → 10 → X1=1, X2=0
sum = 1*1 + 0*9 = 1
    + 1*8 + 2*7 + 3*6 + 4*5 + 5*4 + 6*3 + 7*2 + 8*1
    = 1 + 8 + 14 + 18 + 20 + 20 + 18 + 14 + 8 = 121
    + 9*1 = 130
130 % 10 == 0 ✅
```

### 2.7.2 統一編號（營利事業）驗證器

發票是 `COMPANY` 型別時要驗統一編號。**用 `@Pattern(regexp = "\\d{8}")` 是不夠的** ——
`12345678` 格式對但檢查碼錯，會在開發票時被財政部退回，而那時訂單已經成立了。

```java
package example.shop.common.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

/**
 * 台灣統一編號（8 碼）檢查碼驗證。
 *
 * <p>權重 {1,2,1,2,1,2,4,1}；各位乘積「取數字和」後相加，
 * 總和能被 5 整除即合法。若第 7 位為 7，總和 +1 也可被 5 整除亦視為合法。
 *
 * <p>⚠️ 財政部曾調整規則（2023-04 起取消「被 10 整除」的變體）。
 * 上線前請以財政部最新公告為準。
 */
public class TaxIdValidator implements ConstraintValidator<TaxId, CharSequence> {

    private static final int[] WEIGHTS = {1, 2, 1, 2, 1, 2, 4, 1};

    @Override
    public boolean isValid(CharSequence value, ConstraintValidatorContext ctx) {
        if (value == null) return true;

        String s = value.toString().trim();
        if (s.length() != 8) return false;
        for (int i = 0; i < 8; i++) {
            if (s.charAt(i) < '0' || s.charAt(i) > '9') return false;
        }

        int sum = 0;
        for (int i = 0; i < 8; i++) {
            int product = (s.charAt(i) - '0') * WEIGHTS[i];
            sum += product / 10 + product % 10;          // ★ 取乘積的數字和
        }

        if (sum % 5 == 0) return true;
        // 第 7 位為 7 的特例
        return s.charAt(6) == '7' && (sum + 1) % 5 == 0;
    }
}
```

**驗證**（台積電的統編 `04595257`）：

```
0*1=0  →0      4*2=8  →8      5*1=5  →5      9*2=18 →9
5*1=5  →5      2*2=4  →4      5*4=20 →2      7*1=7  →7
sum = 0+8+5+9+5+4+2+7 = 40 → 40 % 5 == 0 ✅
```

### 2.7.3 類別層級驗證與 `addPropertyNode()` ★

**這一節修正 01 章 1.7.2 留下的問題。**

01 章用 `@AssertTrue` 做跨欄位驗證：

```java
@AssertTrue(message = "minAmount 不可大於 maxAmount")
public boolean isAmountRangeValid() { ... }
```

它的 `FieldError.getField()` 是 **`amountRangeValid`**（方法名去掉 `is`）。
前端拿到這個沒辦法標任何輸入框。

**正確做法：類別層級的自訂驗證器 + `addPropertyNode()`。**

```java
package example.shop.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import java.lang.annotation.*;

/** 發票資訊的跨欄位一致性：COMPANY 要有統編與公司名，DONATION 要有捐贈碼。 */
@Documented
@Constraint(validatedBy = ValidInvoiceValidator.class)
@Target({ElementType.TYPE, ElementType.ANNOTATION_TYPE})     // ★ TYPE：放在類別上
@Retention(RetentionPolicy.RUNTIME)
public @interface ValidInvoice {
    String message() default "{example.shop.validation.ValidInvoice.message}";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
```

```java
package example.shop.common.validation;

import example.shop.order.web.dto.CreateOrderRequest.InvoiceRequest;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

public class ValidInvoiceValidator
        implements ConstraintValidator<ValidInvoice, InvoiceRequest> {

    @Override
    public boolean isValid(InvoiceRequest v, ConstraintValidatorContext ctx) {
        if (v == null || v.type() == null) return true;    // 交給 @NotNull

        // ★ 關掉預設的「整個類別」違反，改成手動指定欄位
        ctx.disableDefaultConstraintViolation();
        boolean valid = true;

        switch (v.type()) {
            case COMPANY -> {
                if (isBlank(v.taxId())) {
                    violate(ctx, "taxId", "{example.shop.validation.invoice.taxIdRequired}");
                    valid = false;
                }
                if (isBlank(v.companyName())) {
                    violate(ctx, "companyName",
                            "{example.shop.validation.invoice.companyNameRequired}");
                    valid = false;
                }
                if (v.carrierId() != null) {
                    violate(ctx, "carrierId",
                            "{example.shop.validation.invoice.carrierNotAllowedForCompany}");
                    valid = false;
                }
            }
            case DONATION -> {
                if (isBlank(v.donationCode())) {
                    violate(ctx, "donationCode",
                            "{example.shop.validation.invoice.donationCodeRequired}");
                    valid = false;
                }
            }
            case PERSONAL -> {
                if (v.taxId() != null || v.companyName() != null) {
                    violate(ctx, "taxId",
                            "{example.shop.validation.invoice.taxIdNotAllowedForPersonal}");
                    valid = false;
                }
            }
        }
        return valid;
    }

    /** ★ 關鍵：addPropertyNode 讓錯誤定位到具體欄位。 */
    private void violate(ConstraintValidatorContext ctx, String field, String messageTemplate) {
        ctx.buildConstraintViolationWithTemplate(messageTemplate)
           .addPropertyNode(field)
           .addConstraintViolation();
    }

    private boolean isBlank(String s) { return s == null || s.isBlank(); }
}
```

```java
@ValidInvoice                        // ★ 放在 record 上
public record InvoiceRequest(
    @NotNull InvoiceType type,
    @TaxId String taxId,             // 格式與檢查碼（2.7.2）
    @Size(max = 60) String companyName,
    @Pattern(regexp = "^/[0-9A-Z+\\-.]{7}$") String carrierId,
    @Size(max = 10) String donationCode
) {}
```

**結果**：送 `{"type":"COMPANY"}` 時的錯誤：

```jsonc
{
  "errors": [
    { "field": "invoice.taxId", "code": "ValidInvoice",
      "message": "選擇公司發票時必須填寫統一編號" },
    { "field": "invoice.companyName", "code": "ValidInvoice",
      "message": "選擇公司發票時必須填寫公司名稱" }
  ]
}
```

**`field` 是 `invoice.taxId`** —— 前端可以直接標紅那個輸入框。

⚠️ **`addPropertyNode` 的三個細節：**

| 細節 | 說明 |
|---|---|
| **必須先 `disableDefaultConstraintViolation()`** | 不然會同時產生「類別層級」的違反（`field` 是 `invoice`）與你的違反，前端看到重複錯誤 |
| **路徑是相對的** | `addPropertyNode("taxId")` 在巢狀的 `invoice` 上會變成 `invoice.taxId`（Hibernate Validator 自動加前綴） |
| **`code` 是註解名稱** | 所有錯誤的 `code` 都是 `ValidInvoice`，前端無法區分。要區分就得在 message 之外自己帶資訊（2.9.4 會處理） |

### 2.7.4 `@SortWhitelist`：把 01 章的白名單變成註解

```java
package example.shop.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import java.lang.annotation.*;

/** 排序參數的白名單。值格式：`field,asc;field2,desc`。 */
@Documented
@Constraint(validatedBy = SortWhitelistValidator.class)
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT,
         ElementType.TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface SortWhitelist {
    /** 允許的排序欄位（API 欄位名，不是資料庫欄位名）。 */
    String[] value();
    /** 最多幾個排序欄位。 */
    int maxFields() default 3;
    String message() default "{example.shop.validation.SortWhitelist.message}";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
```

```java
package example.shop.common.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import java.util.Arrays;
import java.util.Set;

public class SortWhitelistValidator implements ConstraintValidator<SortWhitelist, CharSequence> {

    private Set<String> allowed;
    private int maxFields;

    @Override
    public void initialize(SortWhitelist annotation) {
        this.allowed = Set.of(annotation.value());
        this.maxFields = annotation.maxFields();
    }

    @Override
    public boolean isValid(CharSequence value, ConstraintValidatorContext ctx) {
        if (value == null || value.length() == 0) return true;

        // ★ 長度上限：擋掉 "a,asc;a,asc;a,asc;…" 重複一萬次的輸入
        if (value.length() > 200) return fail(ctx, "排序參數過長");

        String[] tokens = value.toString().split(";");
        if (tokens.length > maxFields) {
            return fail(ctx, "排序欄位最多 " + maxFields + " 個");
        }

        for (String token : tokens) {
            String[] parts = token.trim().split(",");
            if (parts.length > 2) return fail(ctx, "排序格式錯誤：" + token.trim());

            String field = parts[0].trim();
            if (!allowed.contains(field)) {
                // ⚠️ 訊息裡「可以」列出白名單（那是公開契約），但絕不能回顯 field 本身
                //    （回顯使用者輸入 → 若前端直接渲染就是 XSS 素材）
                return fail(ctx, "不支援的排序欄位。可用欄位："
                        + String.join("、", new java.util.TreeSet<>(allowed)));
            }
            if (parts.length == 2) {
                String dir = parts[1].trim().toLowerCase(java.util.Locale.ROOT);
                if (!dir.equals("asc") && !dir.equals("desc")) {
                    return fail(ctx, "排序方向只能是 asc 或 desc");
                }
            }
        }
        return true;
    }

    private boolean fail(ConstraintValidatorContext ctx, String message) {
        ctx.disableDefaultConstraintViolation();
        // ★ 用 addMessageParameter 而不是把文字直接插進 template（見 2.8.4 的 EL 注入）
        ctx.buildConstraintViolationWithTemplate("{detail}")
           .addMessageParameter("detail", message)
           .addConstraintViolation();
        return false;
    }
}
```

⚠️ **注意 `fail()` 裡「不回顯使用者輸入」與「用 `addMessageParameter`」兩件事**，
理由在 2.8.4。

### 2.7.5 為什麼不該在驗證器裡注入 Repository ★

Spring 支援在 `ConstraintValidator` 裡注入 bean（因為它用 `SpringConstraintValidatorFactory` 建立驗證器）：

```java
// ❌ 技術上可行，但不要這樣做
public class UniqueSkuValidator implements ConstraintValidator<UniqueSku, String> {
    @Autowired private ProductRepository productRepository;

    @Override
    public boolean isValid(String sku, ConstraintValidatorContext ctx) {
        return sku == null || !productRepository.existsBySku(sku);
    }
}
```

**看起來很優雅。但有五個問題：**

**問題 1：TOCTOU（檢查與使用之間的時間差）—— 這是最根本的問題。**

```
時間 T1: 請求 A 驗證「SKU-001 不存在」→ 通過
時間 T2: 請求 B 驗證「SKU-001 不存在」→ 通過
時間 T3: 請求 A 寫入
時間 T4: 請求 B 寫入 → 重複的 SKU（或 UNIQUE 約束錯誤 → 500）
```

驗證器在**交易之外**執行（`@Valid` 發生在參數綁定階段，
而 `@Transactional` 在 Service）。所以它**永遠**無法保證唯一性。

**唯一性只能靠資料庫的 UNIQUE 約束保證**，
Service 要 catch `DataIntegrityViolationException` 並轉成 `PRODUCT_SKU_DUPLICATE`（409）。

**於是驗證器變成「一個會誤導人的加速器」** —— 它讓 90% 的情況給出好訊息，
但另外 10% 還是要靠 Service 處理。而**兩份邏輯就會不一致**。

**問題 2：驗證器會被執行很多次。**

同一個 DTO 可能在 Controller 驗一次、Service 用 `validator.validate()` 再驗一次、
`@Valid` 巢狀時再驗一次。每次都打一次資料庫。

**問題 3：破壞分層。** 驗證器屬於 `web` 套件（或 `common.validation`），
注入 Repository 就是 0.6.3 的違規 —— 而且是繞過 ArchUnit 檢查的違規
（因為 `import` 在驗證器裡，不在 Controller 裡）。

**問題 4：測試變慢。** 原本 `new TaiwanIdValidator()` 就能測，
現在要 mock Repository 或啟動 Spring。

**問題 5：`@Valid` 失敗時錯誤格式是 422，但「SKU 重複」語意上是 409。**
把它塞進驗證錯誤會讓客戶端拿到錯誤的狀態碼與錯誤碼。

**shop-service 的規則：`ConstraintValidator` 一律是純函式，不注入任何東西
（除了設定值）。** 需要查資料庫的檢查一律在 Service。

> **唯一的例外**：注入**設定**（`@ConfigurationProperties`）是可以的。
> 例如「檔案上傳允許的 MIME 型別清單」從 `application.yml` 讀。
> 判準：**注入的東西會不會發 I/O？** 會 → 不行。

### 2.7.6 可組合的約束

同一組約束反覆出現時，把它包成一個註解：

```java
package example.shop.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.OverridesAttribute;
import jakarta.validation.Payload;
import jakarta.validation.ReportAsSingleViolation;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.lang.annotation.*;

/** 資源識別碼：必填、長度 ≤ 64、只允許字母數字底線連字號。 */
@NotBlank
@Size(max = 64)
@Pattern(regexp = "^[A-Za-z0-9_-]+$")
@ReportAsSingleViolation                     // ★ 三個約束合併成一個錯誤
@Documented
@Constraint(validatedBy = {})                // 沒有自己的驗證器，只是組合
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT,
         ElementType.TYPE_USE})
@Retention(RetentionPolicy.RUNTIME)
public @interface ResourceId {
    String message() default "{example.shop.validation.ResourceId.message}";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
```

```java
public record CreateOrderRequest(
    @NotEmpty @Size(max = 50) List<@Valid Item> items,
    @ResourceId String shippingAddressId,          // ← 一個註解取代三個
    ...
) {
    public record Item(
        @ResourceId String productId,
        @NotNull @Min(1) @Max(999) Integer quantity
    ) {}
}
```

**`@ReportAsSingleViolation` 的效果**：

| 有它 | 沒它 |
|---|---|
| 送 `""` → 1 個錯誤：「識別碼格式錯誤」 | 送 `""` → 2 個錯誤：`NotBlank` + `Pattern` |

⚠️ **取捨**：合併後前端不知道「是空的」還是「格式錯」。
對「識別碼」這種欄位無所謂（都是前端 bug），但對**使用者實際會填的欄位**
（密碼、Email）就不該合併 —— 使用者需要知道具體哪裡不合。

**shop-service 的規則**：
- 機器產生的欄位（ID、token、cursor）→ 用組合約束 + `@ReportAsSingleViolation`。
- 使用者填的欄位 → 分開列，讓訊息精確。

---

## 2.8 驗證訊息與 i18n

### 2.8.1 三種寫法

```java
// A. 硬編碼訊息（最直接）
@NotBlank(message = "收件地址為必填")

// B. i18n key（走 resource bundle）
@NotBlank(message = "{example.shop.validation.order.shippingAddressRequired}")

// C. 不寫（用約束的預設訊息）
@NotBlank
```

C 的結果是 Hibernate Validator 內建的訊息：

```
must not be blank
```

⚠️ **英文，而且對使用者毫無幫助**（不知道是哪個欄位）。
它會直接出現在 API 回應裡 → 前端顯示給使用者 → 客訴。

**shop-service 的規則：一律用 B（i18n key）。**
理由：
- 訊息集中在一個檔案，文案人員可以直接改，不用改 Java。
- 支援多語言（客服後台是中文，App 可能要英文）。
- 同一個訊息在 20 個欄位重複時只有一份。

### 2.8.2 讓 Bean Validation 讀 Spring 的 `MessageSource` ★

**這是一個很多人卡住的地方。**

Hibernate Validator 預設讀 **classpath 根目錄的 `ValidationMessages.properties`**
（規格規定的檔名）。而 Spring Boot 的 i18n 是 `messages.properties`（`MessageSource`）。

**兩套機制默認不互通。** 如果你把訊息寫在 `messages_zh_TW.properties` 裡，
Bean Validation 找不到，會直接把 key 原樣輸出：

```json
{ "message": "{example.shop.validation.order.shippingAddressRequired}" }
```

**修法：明確設定 `LocalValidatorFactoryBean`。**

```java
package example.shop.common.config;

import org.springframework.context.MessageSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean;

@Configuration
public class ValidationConfig {

    /**
     * 覆寫 Spring Boot 的 defaultValidator，讓驗證訊息走 Spring 的 MessageSource
     * （也就是 messages*.properties），而不是 ValidationMessages.properties。
     */
    @Bean
    public LocalValidatorFactoryBean defaultValidator(MessageSource messageSource) {
        LocalValidatorFactoryBean validator = new LocalValidatorFactoryBean();
        validator.setValidationMessageSource(messageSource);
        return validator;
    }
}
```

```yaml
spring:
  messages:
    # ★★ shop-service 有【三個】訊息檔案，全部要列在這裡：
    #   messages            —— enum 的顯示文字（06 章 6.5.8 的 orderStatus.*）
    #   validation-messages —— Bean Validation 的訊息（這一章）
    #   error-messages      —— ErrorCode 的 title / user（03 章 3.4.4）
    #
    # ⚠️ 漏掉任何一個的後果都是【靜默的】：
    #   ProblemFactory（3.6.3）與 StatusLabelResolver（6.5.8）都有
    #   防禦性 fallback（回傳 code 名或 enum 名），所以不會拋例外 ——
    #   前端只會看到 "error.CART_EMPTY.title" 或 "PARTIALLY_SHIPPED"。
    # ★ 03 章 3.4.5 的 訊息完整() 測試就是為了在啟動時抓到這件事。
    basename: messages,validation-messages,error-messages
    encoding: UTF-8
    fallback-to-system-locale: false            # ★ 找不到就用預設語言，不看系統語言
    use-code-as-default-message: false          # ★ 找不到就讓呼叫端的 fallback 決定
```

⚠️ **`fallback-to-system-locale: false` 很重要。**
預設 `true` 時，找不到使用者語言的訊息會 fallback 到**伺服器的系統語言**。
你的 Docker 容器是 `LANG=C`，所以 fallback 到 `messages.properties`（沒有後綴的那個）。
在本機（`zh_TW`）測試正常，上容器就變英文 —— 經典的「本機好、線上壞」。

**明確指定 bean 名稱是 `defaultValidator`** 的理由：
Spring Boot 的 `ValidationAutoConfiguration` 用
`@ConditionalOnMissingBean(Validator.class)` 判斷，
所以任何 `Validator` bean 都會取代它。但用同樣的名稱最不容易出意外。

### 2.8.3 訊息檔案與參數插值

```properties
# src/main/resources/validation-messages_zh_TW.properties
# ⚠️ Java 9+ 的 properties 檔案預設用 UTF-8 讀取（Java 8 是 ISO-8859-1）

# ── 通用 ────────────────────────────────────────────
example.shop.validation.ResourceId.message=識別碼格式錯誤（限英數字、底線與連字號，最長 64 字）
example.shop.validation.TaiwanId.message=身分證字號格式錯誤
example.shop.validation.TaxId.message=統一編號格式錯誤（請確認 8 位數字與檢查碼）
example.shop.validation.TextLength.message=長度必須在 {min} 到 {max} 個字之間
example.shop.validation.SortWhitelist.message=排序參數錯誤

# ── 訂單 ────────────────────────────────────────────
example.shop.validation.order.itemsRequired=訂單至少需要一項商品
example.shop.validation.order.itemsTooMany=單筆訂單最多 {max} 項商品
example.shop.validation.order.shippingAddressRequired=請選擇收件地址
example.shop.validation.order.quantityRange=數量必須在 {min} 到 {max} 之間
example.shop.validation.order.noteTooLong=備註最多 {max} 個字

# ── 發票 ────────────────────────────────────────────
example.shop.validation.ValidInvoice.message=發票資訊不完整
example.shop.validation.invoice.taxIdRequired=選擇公司發票時必須填寫統一編號
example.shop.validation.invoice.companyNameRequired=選擇公司發票時必須填寫公司名稱
example.shop.validation.invoice.donationCodeRequired=選擇捐贈發票時必須填寫愛心碼
example.shop.validation.invoice.carrierNotAllowedForCompany=公司發票不可使用載具
example.shop.validation.invoice.taxIdNotAllowedForPersonal=個人發票不可填寫統一編號

# ── 覆寫 Hibernate Validator 的內建訊息（用規格定義的 key）────
jakarta.validation.constraints.NotBlank.message=此欄位為必填
jakarta.validation.constraints.NotNull.message=此欄位為必填
jakarta.validation.constraints.NotEmpty.message=此欄位不可為空
jakarta.validation.constraints.Size.message=長度必須在 {min} 到 {max} 之間
jakarta.validation.constraints.Min.message=不可小於 {value}
jakarta.validation.constraints.Max.message=不可大於 {value}
jakarta.validation.constraints.DecimalMin.message=不可小於 {value}
jakarta.validation.constraints.DecimalMax.message=不可大於 {value}
jakarta.validation.constraints.Digits.message=數值格式錯誤（整數最多 {integer} 位、小數最多 {fraction} 位）
jakarta.validation.constraints.Pattern.message=格式不正確
jakarta.validation.constraints.Email.message=Email 格式不正確
jakarta.validation.constraints.Past.message=必須是過去的時間
jakarta.validation.constraints.PastOrPresent.message=不可以是未來的時間
jakarta.validation.constraints.AssertTrue.message=條件不符
```

**最後那一段（覆寫內建訊息）非常划算。**
它讓「忘記寫 `message`」的欄位也有中文訊息，
而不是 `must not be blank`。**這是一道很便宜的安全網。**

**插值變數**：

| 變數 | 來自 | 例子 |
|---|---|---|
| `{min}`、`{max}` | `@Size` / `@Min` 的屬性 | `長度必須在 {min} 到 {max} 之間` |
| `{value}` | `@Min` / `@Max` / `@DecimalMin` | `不可小於 {value}` |
| `{regexp}` | `@Pattern` | 通常不要放（洩漏內部規則且沒人看得懂） |
| 任何屬性名 | 自訂註解的屬性 | `@SortWhitelist` 的 `{maxFields}` |
| `${validatedValue}` | **實際輸入值**（EL） | ⚠️ **絕對不要用**（2.8.4） |

### 2.8.4 EL 注入：`${validatedValue}` 為什麼危險 ★

Hibernate Validator 的訊息插值支援兩種語法：

```
{propertyName}      ← 單純的字串替換（安全）
${EL expression}    ← Jakarta EL 求值（危險）
```

**危險的用法：**

```java
// ❌ 絕對不要
@Size(max = 20, message = "「${validatedValue}」超過長度上限")
```

如果使用者輸入的字串**本身包含 EL 語法**：

```json
{ "name": "${1+1}" }
```

訊息插值時會**執行**那段 EL。歷史上這造成過遠端程式碼執行
（透過 `${''.getClass().forName('java.lang.Runtime')...}` 之類的鏈）。

**Hibernate Validator 6.2 起加了防護**：
`ExpressionLanguageFeatureLevel` 分三級，
**自訂 violation（`buildConstraintViolationWithTemplate`）的預設等級是 `NONE`**（完全關閉 EL），
而約束宣告上的 `message` 預設是 `BEAN_PROPERTIES`（可以用 `${validatedValue}` 但不能呼叫任意方法）。

**但不要依賴這個防護。** 三個理由：

1. 舊版本（HV 6.1 以前）沒有這個機制，而升級不是你能控制的。
2. `BEAN_PROPERTIES` 等級仍然允許讀取 bean 屬性 —— 資訊洩漏。
3. **就算 EL 完全安全，回顯使用者輸入本身就是問題**：
   如果前端把 `message` 直接塞進 `innerHTML`，那是 **XSS**。

**正確做法：**

```java
// ✅ 用 addMessageParameter（單純字串替換，不求值）
ctx.buildConstraintViolationWithTemplate("{detail}")
   .addMessageParameter("detail", safeMessage)
   .addConstraintViolation();

// ✅ 或者用 addExpressionVariable？→ ❌ 不要，那個會走 EL
```

**而「使用者輸入」該放在 `rejectedValue` 欄位，不是 `message` 裡**：

```jsonc
{
  "field": "name",
  "code": "Size",
  "message": "長度必須在 1 到 20 之間",     // ← 不含使用者輸入
  "rejectedValue": "${1+1}"                 // ← 使用者輸入在這裡，前端負責 escape
}
```

**這個分工很重要**：`message` 是給人看的固定文案，`rejectedValue` 是資料。
前端渲染 `rejectedValue` 時本來就該當成不可信資料處理。

**強制檢查（加進 CI）**：

```bash
# 訊息模板裡不該出現 ${
grep -rn 'message *= *"[^"]*\${' src/main/java/ && exit 1 || exit 0
grep -rn '\${' src/main/resources/validation-messages*.properties && exit 1 || exit 0
```

### 2.8.5 語言怎麼決定

Bean Validation 的訊息語言由 `LocaleContextHolder.getLocale()` 決定，
而它由 Spring 的 `LocaleResolver` 設定。

```java
package example.shop.common.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.LocaleResolver;
import org.springframework.web.servlet.i18n.AcceptHeaderLocaleResolver;

import java.util.List;
import java.util.Locale;

@Configuration
public class LocaleConfig {

    /** 純 API 服務：用 Accept-Language header 決定語言，不用 cookie / session。 */
    @Bean
    public LocaleResolver localeResolver() {
        var resolver = new AcceptHeaderLocaleResolver();
        resolver.setSupportedLocales(List.of(
                Locale.forLanguageTag("zh-TW"),
                Locale.forLanguageTag("zh-CN"),
                Locale.ENGLISH));
        resolver.setDefaultLocale(Locale.forLanguageTag("zh-TW"));
        return resolver;
    }
}
```

```
Accept-Language: en-US,en;q=0.9   → validation-messages_en.properties
Accept-Language: zh-TW            → validation-messages_zh_TW.properties
（沒帶）                            → validation-messages_zh_TW.properties（預設）
```

⚠️ **`setSupportedLocales` 一定要設。** 不設的話，
`Accept-Language: xx-YY` 會讓 `LocaleContextHolder` 變成 `xx_YY`，
找不到訊息檔 → fallback 行為依 2.8.2 的設定 → 可能變英文。

⚠️ **`userMessage` 的語言與 `message` 的語言要一致。**
03-rest-api 第 04 章區分了三種訊息（`code` 給機器、`detail` 給開發者、`userMessage` 給使用者）。
`errors[].message` 屬於「給使用者看」那一類，所以要 i18n；
而 `detail` 是給開發者的，**一律英文**（方便搜尋、貼進工單）。

---

## 2.9 從 `BindingResult` 到 `errors[]`

**這一節是本章與 03 章的接縫**：把 Bean Validation 的原生結構，
轉成 03-rest-api 第 04 章 4.6 定義的 `errors[]` 格式。

### 2.9.1 `BindingResult` 的結構

```java
MethodArgumentNotValidException e;

BindingResult br = e.getBindingResult();

br.getAllErrors()      // List<ObjectError>：全部錯誤
br.getFieldErrors()    // List<FieldError>：有欄位的錯誤（FieldError extends ObjectError）
br.getGlobalErrors()   // List<ObjectError>：類別層級的錯誤（沒有欄位）
br.getObjectName()     // "createOrderRequest"
```

`FieldError` 能拿到的東西：

| 方法 | 值（以 `@Size(max=200) String customerNote` 收到 300 字為例） |
|---|---|
| `getField()` | `"customerNote"` |
| `getRejectedValue()` | `"（那 300 個字）"` |
| `getDefaultMessage()` | `"備註最多 200 個字"`（已插值、已 i18n） |
| `getCode()` | `"Size"` |
| `getCodes()` | `["Size.createOrderRequest.customerNote", "Size.customerNote", "Size.java.lang.String", "Size"]` |
| `getArguments()` | `[DefaultMessageSourceResolvable(customerNote), 200, 0]` |
| `isBindingFailure()` | `false`（`true` = 型別轉換失敗，不是約束違反）★ |

**`isBindingFailure()` 是關鍵的區分：**

| 值 | 意思 | 例子 | 該回什麼 |
|---|---|---|---|
| `false` | 約束違反（Bean Validation） | `@Size` 超長 | 422 |
| `true` | **型別轉換失敗** | `?page=abc`、`"quantity": "兩個"` | ⚠️ 語意上是 400（語法錯） |

⚠️ **`isBindingFailure() == true` 時 `getDefaultMessage()` 是這種東西**：

```
Failed to convert property value of type 'java.lang.String' to required type
'java.lang.Integer' for property 'page'; For input string: "abc"
```

**絕對不能直接回給客戶端**：它洩漏內部型別，而且對前端沒有幫助。

### 2.9.2 目標格式

依 03-rest-api 第 04 章 4.6.1：

```jsonc
{
  "type": "https://api.shop.example/problems/validation-failed",
  "title": "請求內容驗證失敗",
  "status": 422,
  "detail": "Request body failed validation: 3 field(s) rejected.",
  "instance": "/orders",
  "code": "VALIDATION_FAILED",
  "userMessage": "請檢查標示紅色的欄位。",
  "errors": [
    {
      "field": "items[0].quantity",
      "code": "Max",
      "message": "數量必須在 1 到 999 之間",
      "messageKey": "example.shop.validation.order.quantityRange",
      "rejectedValue": 5000,
      "constraint": { "min": 1, "max": 999 }
    },
    {
      "field": "invoice.taxId",
      "code": "ValidInvoice",
      "message": "選擇公司發票時必須填寫統一編號",
      "messageKey": "example.shop.validation.invoice.taxIdRequired",
      "rejectedValue": null
    },
    {
      "field": "customerNote",
      "code": "Size",
      "message": "備註最多 200 個字",
      "rejectedValue": "（前 50 字）…",
      "constraint": { "max": 200 }
    }
  ],
  "errorCount": 3,
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-20T06:12:44Z"
}
```

### 2.9.3 轉換實作

```java
package example.shop.common.error;

import java.util.Map;

/**
 * 單一欄位的錯誤，對應 03-rest-api 第 04 章 4.6 的格式。
 *
 * <p>★ 為什麼放在 {@code common.error} 而不是 {@code common.web}？
 * 因為 Service 層也要用它（02 章 2.10.4：階段 2 的驗證失敗要能填進同一個
 * {@code errors[]}）。放在 {@code common.web} 會讓 Service 依賴 web 套件。
 *
 * <p>★ 為什麼沒有 {@code messageKey}？
 * 因為 {@code FieldError.getDefaultMessage()} 拿到的已經是插值後的字串，
 * 反推不出原始 key（見下方 {@code ValidationErrorTranslator} 的註解）。
 * 與其留一個永遠是 {@code null} 的欄位，不如不要它。
 */
public record FieldViolation(
    String field,
    String code,
    String message,
    Object rejectedValue,
    Map<String, Object> constraint
) {
    public static FieldViolation of(String field, String code, String message) {
        return new FieldViolation(field, code, message, null, null);
    }

    public static FieldViolation of(String field, String code, String message,
                                    Object rejectedValue) {
        return new FieldViolation(field, code, message, rejectedValue, null);
    }
}
```

> ⚠️ **03 章會原樣沿用這個 record**（`Problem`、`BusinessException`、
> `ValidationFailedException` 都用它），所以這裡的欄位順序就是最終契約。

```java
package example.shop.common.web;

import jakarta.validation.ConstraintViolation;
import org.springframework.context.MessageSource;
import org.springframework.context.MessageSourceResolvable;
import org.springframework.context.i18n.LocaleContextHolder;
import org.springframework.core.MethodParameter;
import org.springframework.stereotype.Component;
import org.springframework.validation.BindingResult;
import org.springframework.validation.Errors;
import org.springframework.validation.FieldError;
import org.springframework.validation.ObjectError;
import org.springframework.validation.method.ParameterErrors;
import org.springframework.validation.method.ParameterValidationResult;
import org.springframework.web.method.annotation.HandlerMethodValidationException;

import java.util.*;

/**
 * 把 Spring / Bean Validation 的各種錯誤結構統一轉成 FieldViolation。
 *
 * <p>2.3.3 的三種例外都會走到這裡，確保前端只需要理解一種格式。
 *
 * <p>⚠️ {@code ParameterErrors} / {@code ParameterValidationResult} /
 * {@code HandlerMethodValidationException} 的套件位置在 Spring 6.1 才穩定下來；
 * 若你的 IDE 找不到它們，請確認是 Boot 3.2+（2.3.2 的版本表）。
 */
@Component
public class ValidationErrorTranslator {

    /** 錯誤數量上限（2.5.4 的第三層防護）。 */
    public static final int MAX_ERRORS = 20;

    /** rejectedValue 截斷長度。 */
    private static final int MAX_REJECTED_LENGTH = 50;

    /** 這些欄位名（不分大小寫、含子字串）永遠不回顯值。 */
    private static final List<String> SENSITIVE_FIELD_HINTS = List.of(
            "password", "passwd", "pwd", "secret", "token", "apikey", "api_key",
            "cardnumber", "card_number", "cvv", "cvc", "pin", "ssn",
            "taxid", "nationalid", "idnumber", "privatekey", "authorization");

    private final MessageSource messageSource;

    public ValidationErrorTranslator(MessageSource messageSource) {
        this.messageSource = messageSource;
    }

    // ── 來源 A / B：MethodArgumentNotValidException、BindException ──────────

    /**
     * @param errors ⚠️ 型別是 {@link Errors} 而不是 {@link BindingResult}。
     *               <p>★★ 這一個字的差別很重要：{@code ParameterErrors}
     *               （Spring 6.1 方法驗證的結果，見 {@link #fromHandlerMethod}）
     *               <b>只實作 {@code Errors}，沒有實作 {@code BindingResult}</b>。
     *               宣告成 {@code BindingResult} 的話，
     *               {@code from(parameterErrors)} 會編譯不過。
     *               <p>而我們只用到 {@code getAllErrors()} —— 那是 {@code Errors} 就有的。
     */
    public List<FieldViolation> from(Errors errors) {
        return errors.getAllErrors().stream()
                .map(this::toDto)
                .sorted(Comparator.comparing(FieldViolation::field,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .limit(MAX_ERRORS)
                .toList();
    }

    private FieldViolation toDto(ObjectError error) {
        if (error instanceof FieldError fe) {
            return new FieldViolation(
                    fe.getField(),
                    resolveCode(fe),
                    resolveMessage(fe),
                    maskIfSensitive(fe.getField(), fe.getRejectedValue()),
                    extractConstraint(fe));
        }
        // 類別層級的錯誤（沒有欄位）
        // ★ field 給 null 而不是 objectName —— 前端靠 field == null 判斷「這是全域錯誤」
        //   （2.13.2 的處理方式）
        return new FieldViolation(
                null,
                Objects.requireNonNullElse(error.getCode(), "Invalid"),
                Objects.requireNonNullElse(error.getDefaultMessage(), "資料不正確"),
                null, null);
    }

    /**
     * 型別轉換失敗（isBindingFailure）時不能用原始訊息（會洩漏內部型別，2.9.1），
     * 統一換成安全的固定文案。
     */
    private String resolveMessage(FieldError fe) {
        if (fe.isBindingFailure()) {
            return messageSource.getMessage(
                    "example.shop.validation.typeMismatch",
                    new Object[]{fe.getField()},
                    "欄位格式不正確",
                    LocaleContextHolder.getLocale());
        }
        String msg = fe.getDefaultMessage();
        return (msg == null || msg.isBlank()) ? "資料不正確" : msg;
    }

    private String resolveCode(FieldError fe) {
        if (fe.isBindingFailure()) return "TypeMismatch";
        return Objects.requireNonNullElse(fe.getCode(), "Invalid");
    }

    /**
     * 可以回傳給前端的約束屬性名稱（白名單）。
     *
     * <p>★ 刻意<b>不含</b>：
     * <ul>
     *   <li>{@code regexp} / {@code flags}（{@code @Pattern}）——
     *       洩漏內部規則，而且對前端沒有用（前端不該重新實作我們的 regex）。</li>
     *   <li>{@code message} / {@code groups} / {@code payload}（框架內部屬性）。</li>
     *   <li>自訂約束的屬性 —— 預設不曝光。要曝光就明確加進這個集合。</li>
     * </ul>
     */
    private static final Set<String> EXPOSED_ATTRIBUTES =
            Set.of("min", "max", "value", "inclusive", "integer", "fraction");

    /**
     * 抽出約束參數（{@code min}、{@code max}、{@code value}…）給前端做客戶端驗證。
     *
     * <p>★★ 為什麼<b>不</b>用 {@code fe.getArguments()} 的位置索引 ——
     * 這是一個很容易寫錯而且沒有任何警告的地方。
     *
     * <p>{@code SpringValidatorAdapter.getArgumentsForConstraint()} 的實作是：
     * <pre>
     * arguments.add(getResolvableField(objectName, field));   // args[0]
     * Map&lt;String, Object&gt; attributesToExpose = new TreeMap&lt;&gt;();   // ★ TreeMap
     * descriptor.getAttributes().forEach((name, value) -&gt; {
     *     if (!internalAnnotationAttributes.contains(name)) {   // message/groups/payload
     *         if (value instanceof String) value = new ResolvableAttribute(value.toString());
     *         attributesToExpose.put(name, value);
     *     }
     * });
     * arguments.addAll(attributesToExpose.values());            // ★ 依【屬性名的字母順序】
     * </pre>
     *
     * <p>⚠️⚠️ <b>「依屬性名的字母順序」</b>就是陷阱所在：
     *
     * <table>
     *   <tr><th>約束</th><th>屬性（宣告順序）</th><th>實際的 args 順序（字母序）</th></tr>
     *   <tr><td>{@code @Size}</td><td>min, max</td><td>args[1]=<b>max</b>, args[2]=<b>min</b></td></tr>
     *   <tr><td>{@code @Digits}</td><td>integer, fraction</td>
     *       <td>args[1]=<b>fraction</b>, args[2]=<b>integer</b> ★ 與直覺相反</td></tr>
     *   <tr><td>{@code @DecimalMin}</td><td>value, inclusive</td>
     *       <td>args[1]=<b>inclusive</b>（Boolean！）, args[2]=value</td></tr>
     * </table>
     *
     * <p>寫錯的後果是<b>靜默的</b>：{@code @Digits(integer=12, fraction=2)} 會回傳
     * {@code {"integer": 2, "fraction": 12}}，而前端照著做客戶端驗證就會擋掉合法的金額。
     * 而 {@code @DecimalMin} 那一列更糟：{@code args[1]} 是 Boolean，
     * 型別檢查直接讓整個 constraint map 變成 null。
     *
     * <p>★★ <b>所以這裡改成從 {@code ConstraintViolation} 讀屬性 ——「依名字」而不是「依位置」。</b>
     * {@code SpringValidatorAdapter} 產生的 {@code FieldError} 是
     * {@code ViolationFieldError}，它支援 {@code unwrap(ConstraintViolation.class)}。
     */
    private Map<String, Object> extractConstraint(FieldError fe) {
        String code = fe.getCode();
        if (code == null || fe.isBindingFailure()) return null;

        ConstraintViolation<?> violation;
        try {
            violation = fe.unwrap(ConstraintViolation.class);
        }
        catch (IllegalArgumentException e) {
            // ★ 不是 Bean Validation 產生的錯誤（例如 rejectValue() 手動加的）→ 沒有約束屬性
            return null;
        }

        Map<String, Object> attributes = violation.getConstraintDescriptor().getAttributes();
        Map<String, Object> m = new LinkedHashMap<>();

        attributes.forEach((name, value) -> {
            if (!EXPOSED_ATTRIBUTES.contains(name)) return;
            // ★ @Min/@Max/@DecimalMin/@DecimalMax 的屬性都叫 value ——
            //   換成前端看得懂的 min / max
            String key = switch (name) {
                case "value" -> code.endsWith("Min") ? "min"
                              : code.endsWith("Max") ? "max"
                              : "value";
                default -> name;
            };
            putSimple(m, key, value);
        });

        // ⚠️ inclusive 是 true 時不用回傳（那是預設值，只是噪音）
        if (Boolean.TRUE.equals(m.get("inclusive"))) m.remove("inclusive");

        return m.isEmpty() ? null : m;
    }

    /**
     * 只放「JSON 表達得出來而且對前端有意義」的值。
     *
     * <p>⚠️ {@code @DecimalMin("0.01")} 的 {@code value} 是 {@code String}，
     * 而 {@code @Min(1)} 的是 {@code long} —— 兩種都要接受。
     */
    private void putSimple(Map<String, Object> m, String key, Object v) {
        if (v instanceof Number || v instanceof Boolean || v instanceof CharSequence) {
            m.put(key, (v instanceof CharSequence cs) ? cs.toString() : v);
        }
    }

    // ── 來源 C：HandlerMethodValidationException（Spring 6.1 內建方法驗證）──

    /**
     * 處理方法參數上的約束違反（2.3.2 的路徑 C）。
     *
     * <p>{@code HandlerMethodValidationException} 的結構和另外兩種完全不同：
     * 它是「每個方法參數一組錯誤」，而不是「一個 BindingResult」。
     *
     * <p>兩種參數要分開處理：
     * <ul>
     *   <li>{@code ParameterErrors}（參數本身是 {@code @Valid} 的物件）
     *       → 它繼承 {@code ParameterValidationResult} 並實作 {@link Errors}
     *       （⚠️ <b>不是</b> {@link BindingResult}），所以 {@link #from} 的參數
     *       型別必須宣告成 {@code Errors} 才能直接重用。</li>
     *   <li>一般參數（{@code @PathVariable @Size(max=64) String}）
     *       → 沒有 field 名稱，要從 {@code MethodParameter} 取。</li>
     * </ul>
     */
    public List<FieldViolation> fromHandlerMethod(HandlerMethodValidationException ex) {
        List<FieldViolation> result = new ArrayList<>();

        for (ParameterValidationResult parameterResult : ex.getAllValidationResults()) {

            // 情況 1：參數是 @Valid 的物件 → 有完整的欄位路徑
            if (parameterResult instanceof ParameterErrors parameterErrors) {
                result.addAll(from(parameterErrors));
                continue;
            }

            // 情況 2：一般參數（@PathVariable / @RequestParam / @RequestHeader 上的約束）
            String field = resolveParameterName(parameterResult.getMethodParameter());
            Object rejected = maskIfSensitive(field, parameterResult.getArgument());

            for (MessageSourceResolvable resolvable : parameterResult.getResolvableErrors()) {
                result.add(new FieldViolation(
                        field,
                        constraintCodeOf(resolvable),
                        resolveMessage(resolvable),
                        rejected,
                        null));
            }
        }

        return result.stream()
                .sorted(Comparator.comparing(FieldViolation::field,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .limit(MAX_ERRORS)
                .toList();
    }

    /**
     * 參數名稱。
     *
     * <p>⚠️ 需要 {@code -parameters} 編譯選項（01 章 1.4.1），
     * 否則 {@code getParameterName()} 是 {@code null} —— 那時退回 {@code argN}，
     * 前端無法定位，但至少不會 NPE。
     */
    private String resolveParameterName(MethodParameter parameter) {
        String name = parameter.getParameterName();
        return (name != null) ? name : "arg" + parameter.getParameterIndex();
    }

    /**
     * 從 resolvable 的 codes 取出約束名稱。
     *
     * <p>Spring 產生的 code 陣列第一個是最具體的
     * （例如 {@code Size.orderId}），最後一個是約束名（{@code Size}）——
     * 我們要的是後者（機器可讀、穩定）。
     */
    private String constraintCodeOf(MessageSourceResolvable resolvable) {
        String[] codes = resolvable.getCodes();
        if (codes == null || codes.length == 0) return "Invalid";
        return codes[codes.length - 1];
    }

    /** 解析 resolvable 的訊息（走 MessageSource，所以會是中文）。 */
    private String resolveMessage(MessageSourceResolvable resolvable) {
        try {
            return messageSource.getMessage(resolvable, LocaleContextHolder.getLocale());
        } catch (Exception e) {
            String fallback = resolvable.getDefaultMessage();
            return (fallback == null || fallback.isBlank()) ? "資料不正確" : fallback;
        }
    }

    // ── 來源 D：ConstraintViolationException ────────────────────────────

    public List<FieldViolation> fromViolations(Set<? extends ConstraintViolation<?>> violations) {
        return violations.stream()
                .map(v -> new FieldViolation(
                        normalizePath(v.getPropertyPath().toString()),
                        v.getConstraintDescriptor().getAnnotation()
                                .annotationType().getSimpleName(),
                        v.getMessage(),
                        maskIfSensitive(v.getPropertyPath().toString(), v.getInvalidValue()),
                        null))
                .sorted(Comparator.comparing(FieldViolation::field,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .limit(MAX_ERRORS)
                .toList();
    }

    /**
     * ConstraintViolationException 的 propertyPath 是 "create.arg0.quantity" 這種，
     * 前面的「方法名.參數名」對客戶端沒有意義，砍掉。
     */
    private String normalizePath(String path) {
        int idx = path.indexOf('.');
        if (idx < 0) return path;
        String rest = path.substring(idx + 1);
        // arg0.xxx → xxx；arg0 → （保留原樣，讓 advice 補上真正的參數名）
        if (rest.startsWith("arg")) {
            int dot = rest.indexOf('.');
            return (dot < 0) ? rest : rest.substring(dot + 1);
        }
        return rest;
    }

    // ── 敏感值遮蔽（03-rest-api 4.6.4）──────────────────────────────────

    private Object maskIfSensitive(String field, Object value) {
        if (value == null) return null;
        if (field != null) {
            String f = field.toLowerCase(Locale.ROOT).replace("_", "");
            for (String hint : SENSITIVE_FIELD_HINTS) {
                if (f.contains(hint.replace("_", ""))) return "***";
            }
        }
        if (value instanceof CharSequence cs) {
            String s = cs.toString();
            return (s.length() <= MAX_REJECTED_LENGTH)
                    ? s
                    : s.substring(0, MAX_REJECTED_LENGTH) + "…";
        }
        if (value instanceof Collection<?> c) {
            return "（" + c.size() + " 個項目）";           // ★ 不回顯整個集合
        }
        if (value instanceof Map<?, ?> mp) {
            return "（" + mp.size() + " 個項目）";
        }
        return value;
    }
}
```

**這個類別做了六件容易被忽略的事** ★：

| # | 事情 | 為什麼 |
|---|---|---|
| 1 | `isBindingFailure()` 時換成安全訊息 | 原始訊息洩漏內部型別（2.9.1） |
| 2 | 敏感欄位遮蔽 | `rejectedValue` 回顯密碼 = 密碼進了 log 與前端 console |
| 3 | 超長值截斷 | 送 1 MB 字串 → 錯誤回應也是 1 MB |
| 4 | 集合不回顯內容 | 送 10,000 項 → 回應是 10,000 項 |
| 5 | 錯誤數量上限 | 2.5.4 的第三層防護 |
| 6 | 依 `field` 排序 | 讓回應穩定、可 diff、可寫測試（不然順序是 `HashSet` 的隨機順序） |

**第 6 點特別實用**：`ConstraintViolationException.getConstraintViolations()` 回傳 `Set`，
順序不固定。不排序的話**同一個請求兩次會得到不同順序的 `errors[]`**，
測試會 flaky、ETag 會不穩定。

⚠️ **`extractMessageKey` 我誠實地回傳 `null`。**
因為 `FieldError.getDefaultMessage()` 拿到的已經是**插值後的字串**，
反推不出原始 key。若真的需要 `messageKey`（讓前端自己決定文案），
做法是在自訂註解上多加一個 `key()` 屬性，或改用
`ConstraintViolation.getConstraintDescriptor().getAttributes().get("message")`
（那個是未插值的模板，例如 `{example.shop.validation.xxx}`）。
`fromViolations` 那條路徑可以做到，`BindingResult` 那條做不到 —— 
**這是兩條路徑無法完全對齊的地方，寫在文件裡比假裝一致好。**

### 2.9.4 自訂約束怎麼提供機器可讀的 `code`

2.7.3 提過一個問題：`@ValidInvoice` 產生的所有錯誤 `code` 都是 `ValidInvoice`，
前端無法區分「缺統編」和「缺公司名」。

**解法：把細分的 code 放進訊息模板的參數。**

```java
private void violate(ConstraintValidatorContext ctx, String field,
                     String code, String messageTemplate) {
    ctx.unwrap(org.hibernate.validator.HibernateConstraintValidatorContext.class)
       .addMessageParameter("code", code)
       .buildConstraintViolationWithTemplate(messageTemplate)
       .addPropertyNode(field)
       .addConstraintViolation();
}
```

⚠️ 但 `addMessageParameter` 只影響**訊息文字**，不會出現在 `FieldError.getCode()`。

**更直接的解法：不要用一個 `@ValidInvoice` 涵蓋五種情況，
改成把「條件必填」變成一個可重用的約束。**

```java
package example.shop.common.validation;

/**
 * 條件必填：當 {@code when} 指定的欄位等於 {@code is} 的任一值時，{@code field} 必填。
 * 可重複套用（Java 8+ 的 @Repeatable）。
 */
@Repeatable(RequiredWhen.List.class)
@Documented
@Constraint(validatedBy = RequiredWhenValidator.class)
@Target({ElementType.TYPE, ElementType.ANNOTATION_TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequiredWhen {
    String field();
    String when();
    String[] is();
    String message() default "{example.shop.validation.RequiredWhen.message}";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};

    @Target({ElementType.TYPE, ElementType.ANNOTATION_TYPE})
    @Retention(RetentionPolicy.RUNTIME)
    @interface List { RequiredWhen[] value(); }
}
```

```java
@RequiredWhen(field = "taxId",        when = "type", is = "COMPANY")
@RequiredWhen(field = "companyName",  when = "type", is = "COMPANY")
@RequiredWhen(field = "donationCode", when = "type", is = "DONATION")
public record InvoiceRequest(
    @NotNull InvoiceType type,
    @TaxId String taxId,
    @Size(max = 60) String companyName,
    @Pattern(regexp = "^/[0-9A-Z+\\-.]{7}$") String carrierId,
    @Size(max = 10) String donationCode
) {}
```

**現在每個錯誤的 `code` 都是 `RequiredWhen`，而 `field` 是精確的。**
前端只要處理「`RequiredWhen` → 標紅 + 顯示 message」一種邏輯。

⚠️ 代價：`RequiredWhenValidator` 要用反射讀屬性值（record 的 accessor），
比手寫的 `switch` 慢一點也脆弱一點（欄位改名不會編譯錯誤）。

**shop-service 的決定：用 2.7.3 的手寫版本。**
理由：發票規則只有一個地方用，而「欄位改名時編譯器會提醒」比「少寫 20 行」值錢。
`@RequiredWhen` 這種通用約束只有在**同一個模式出現 5 次以上**才划算。

---

## 2.10 驗證的分階段策略

### 2.10.1 三個階段

```
階段 1：語法（Controller，Bean Validation）
  · 不需要任何 I/O
  · 例：quantity 在 1～999、productId 長度 ≤ 64、type=COMPANY 時 taxId 必填
  · 失敗 → 422 VALIDATION_FAILED + errors[]
  · 成本：微秒級

階段 2：語意（Service，需要查資料）
  · 例：productId 真的存在、商品沒下架、折扣碼在有效期
  · 失敗 → 422 PRODUCT_NOT_FOUND / COUPON_EXPIRED（有各自的 code）
  · 成本：毫秒級（DB 查詢）

階段 3：業務狀態（Service，在交易內）
  · 例：庫存夠不夠、訂單可不可以取消、金額有沒有變動
  · 失敗 → 409 INSUFFICIENT_STOCK / ORDER_NOT_CANCELLABLE
  · 成本：毫秒級 + 行鎖
```

### 2.10.2 為什麼順序重要

考慮一個惡意請求：50 項商品，每項 `quantity = -1`。

**沒有階段 1**：

```
50 次商品查詢（DB）
+ 50 次庫存查詢（含 SELECT ... FOR UPDATE 行鎖）
+ 發現數量是負數 → 失敗
```

**每個請求付了 100 次 DB 往返與 50 個行鎖的代價，才發現輸入是垃圾。**

**有階段 1**：

```
Bean Validation：quantity < 1 → 422
0 次 DB 查詢
```

**這就是「便宜的驗證要放在便宜的地方」。**

### 2.10.3 每一層的錯誤碼與狀態碼要對齊

同一件事在不同階段失敗，回的東西不同 —— **這是刻意的，不是不一致。**

| 情況 | 階段 | 狀態碼 | `code` |
|---|---|---|---|
| `productId` 是空字串 | 1 | 422 | `VALIDATION_FAILED`（`errors[].code = NotBlank`） |
| `productId` 格式對但不存在 | 2 | 422 | `PRODUCT_NOT_FOUND` |
| 商品存在但已下架 | 2 | 410 | `PRODUCT_DISCONTINUED` |
| 商品可買但庫存不足 | 3 | 409 | `INSUFFICIENT_STOCK` |

**為什麼「不存在」是 422 而不是 404？**
因為 404 的語意是「**你請求的 URL** 指向的資源不存在」，
而這裡 URL（`POST /orders`）是存在的，是 **body 裡的一個值**指向不存在的東西。
（03-rest-api 第 02 章 2.8 的決策樹。）

**為什麼「已下架」是 410 而不是 422？**
410 Gone 表達「這個東西曾經存在，現在永久移除了」，
而且回應裡可以帶 `replacementProductId`。這比 422 對前端更有用。

### 2.10.4 階段 1 不該做什麼

**❌ 不要在 Bean Validation 裡做需要 I/O 的檢查**（2.7.5 的完整論證）。

**❌ 不要在 Controller 手寫 `if` 做階段 2 的檢查。**

```java
// ❌ 這在 Controller 裡
if (!productService.exists(request.items().get(0).productId())) {
    throw new ProductNotFoundException(...);
}
```

理由：
- 它只檢查第一項（有 50 項）。
- 它在交易外檢查，Service 還是得再檢查一次（TOCTOU）。
- 排程與批次匯入不會經過它。

**✅ 讓 Service 一次檢查全部，回報全部問題**：

```java
// Service 裡（05-service 會實作）
List<FieldViolation> errors = new ArrayList<>();
Map<String, Product> products = productRepository.findAllById(productIds);

for (int i = 0; i < cmd.lines().size(); i++) {
    var line = cmd.lines().get(i);
    Product p = products.get(line.productId());
    if (p == null) {
        errors.add(FieldViolation.of("items[" + i + "].productId",
                "PRODUCT_NOT_FOUND", "商品不存在", line.productId()));
    } else if (p.isDiscontinued()) {
        errors.add(FieldViolation.of("items[" + i + "].productId",
                "PRODUCT_DISCONTINUED", "商品已下架", line.productId()));
    }
}
if (!errors.isEmpty()) throw new ValidationFailedException(errors);
```

**注意 `field` 用了 `items[i].productId` 的格式** —— 
和階段 1 的格式完全一致，所以**前端不用區分錯誤來自哪一層**。

> **這是本節最重要的設計決策**：
> 階段 2 / 3 的錯誤也要能填進 `errors[]`，而且 `field` 格式要和階段 1 相同。
> 做到這件事，前端的「標紅欄位」邏輯就只需要寫一次。

---

## 2.11 大小限制與 DoS 防護

### 2.11.1 四層防護

| 層 | 擋什麼 | 怎麼做 | 失敗回應 |
|---|---|---|---|
| **1. 反向代理** | 超大 body | Nginx `client_max_body_size 2m;` | 413（Nginx 的 HTML）⚠️ |
| **2. 容器 / Servlet** | 超大 body、超大 form | `server.tomcat.max-swallow-size`、`spring.servlet.multipart.max-*` | 413 |
| **3. 反序列化** | JSON 深度、超長字串、超長數字 | Jackson `StreamReadConstraints` | 400 |
| **4. Bean Validation** | 欄位級的長度／範圍／集合大小 | `@Size`、`@Max` | 422 |

**四層都要有**，因為每一層擋的東西不同，而且**下面的層失效時上面的層是安全網**。

⚠️ **第 1 層的回應是 HTML** —— Nginx 產生的 413 頁面不是 JSON，
前端 `res.json()` 會拋 `SyntaxError`。
要在 Nginx 設定 JSON 錯誤頁（03-rest-api 第 04 章 4.10.4 給過設定）。

### 2.11.2 限制 request body 大小

Spring Boot **沒有**「JSON body 最大位元組數」的設定。
`server.tomcat.max-http-form-post-size` 只管 form，不管 JSON。

**做法：一個 Filter。**

```java
package example.shop.common.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 限制 request body 大小。
 *
 * <p>先看 Content-Length（快速路徑），沒有或不可信時包裝 InputStream 邊讀邊算。
 * ⚠️ Filter 拋的例外不會進 @RestControllerAdvice（第 00 章 0.8.2），
 * 所以這裡自己寫 Problem JSON。
 */
@Component
@Order(-118)                                   // 早於 Security，晚於 traceId
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    private final long maxBytes;
    private final ProblemWriter problemWriter;

    public RequestSizeLimitFilter(ApiLimitProperties limits, ProblemWriter problemWriter) {
        this.maxBytes = limits.maxRequestBodyBytes();
        this.problemWriter = problemWriter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        long declared = req.getContentLengthLong();
        if (declared > maxBytes) {
            problemWriter.writePayloadTooLarge(req, res, maxBytes, declared);
            return;
        }
        // 沒有 Content-Length（chunked transfer）→ 邊讀邊算
        if (declared < 0) {
            chain.doFilter(new SizeLimitedRequestWrapper(req, maxBytes), res);
            return;
        }
        chain.doFilter(req, res);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        // multipart 由 spring.servlet.multipart.max-request-size 管（05 章）
        String ct = req.getContentType();
        return ct != null && ct.toLowerCase().startsWith("multipart/");
    }
}
```

```java
package example.shop.common.web;

import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

import java.io.IOException;

/** 包裝 InputStream，讀超過上限就拋例外（處理 chunked transfer 的情況）。 */
class SizeLimitedRequestWrapper extends HttpServletRequestWrapper {

    private final long maxBytes;

    SizeLimitedRequestWrapper(HttpServletRequest request, long maxBytes) {
        super(request);
        this.maxBytes = maxBytes;
    }

    @Override
    public ServletInputStream getInputStream() throws IOException {
        ServletInputStream delegate = super.getInputStream();
        return new ServletInputStream() {
            private long count = 0;

            @Override public int read() throws IOException {
                int b = delegate.read();
                if (b != -1 && ++count > maxBytes) throw new PayloadTooLargeException(maxBytes);
                return b;
            }
            @Override public int read(byte[] buf, int off, int len) throws IOException {
                int n = delegate.read(buf, off, len);
                if (n > 0) {
                    count += n;
                    if (count > maxBytes) throw new PayloadTooLargeException(maxBytes);
                }
                return n;
            }
            @Override public boolean isFinished() { return delegate.isFinished(); }
            @Override public boolean isReady() { return delegate.isReady(); }
            @Override public void setReadListener(ReadListener l) { delegate.setReadListener(l); }
        };
    }
}
```

⚠️ **`Content-Length` 不可信** —— 客戶端可以宣告 100 bytes 然後送 100 MB，
或用 `Transfer-Encoding: chunked` 完全不宣告。
所以**兩條路徑都要處理**。這是很多「有做大小限制」的專案實際上沒防住的原因。

### 2.11.3 Jackson 的 `StreamReadConstraints` ★

**Jackson 2.15 起內建了解析限制**，這是一個很重要但少人知道的功能。

**預設值**：

| 限制 | 預設 | 擋什麼 |
|---|---|---|
| `maxNestingDepth` | 1,000 | 巢狀炸彈 `[[[[[…]]]]]` |
| `maxNumberLength` | 1,000 | 超長數字 `1e999999`（`BigDecimal` 解析是 O(n²)） |
| `maxStringLength` | 20,000,000（20 MB） | 單一超長字串 |
| `maxNameLength`（2.16+） | 50,000 | 超長欄位名 |
| `maxDocumentLength`（2.16+） | 無限 | 整份文件大小 |

**預設值太寬鬆。** 對一個訂單 API 來說：

```java
package example.shop.common.config;

import com.fasterxml.jackson.core.StreamReadConstraints;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class JacksonHardeningConfig {

    /**
     * 收緊 Jackson 的解析限制（Jackson 2.15+）。
     * 預設 maxNestingDepth=1000 / maxStringLength=20MB 對 API 來說太寬鬆。
     */
    @Bean
    Jackson2ObjectMapperBuilderCustomizer streamReadConstraintsCustomizer() {
        return builder -> builder.postConfigurer(mapper ->
                mapper.getFactory().setStreamReadConstraints(
                        StreamReadConstraints.builder()
                                .maxNestingDepth(20)          // 我們最深的 DTO 是 4 層
                                .maxNumberLength(40)          // 金額最多 12 整數位 + 2 小數位
                                .maxStringLength(100_000)     // 最長欄位是 internalNote(500)
                                .build()));
    }
}
```

⚠️ **`postConfigurer` 的可用性依 Spring Boot 版本而異。**
若沒有這個方法，改成直接宣告一個 `ObjectMapper` bean，
或用 `builder.factory(...)` 傳入已設定好 constraints 的 `JsonFactory`：

```java
@Bean
Jackson2ObjectMapperBuilderCustomizer hardeningCustomizer() {
    var factory = com.fasterxml.jackson.core.JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxNestingDepth(20).maxNumberLength(40).maxStringLength(100_000).build())
            .build();
    return builder -> builder.factory(factory);
}
```

**沒有這個設定會發生什麼？** 實測一個 900 層巢狀的 JSON：

```bash
python3 -c "print('{\"a\":' * 900 + '1' + '}' * 900)" > bomb.json
curl -X POST localhost:8080/orders -H 'Content-Type: application/json' -d @bomb.json
```

在 Jackson 2.15 之前 → `StackOverflowError`。
⚠️ **`StackOverflowError` 是 `Error` 不是 `Exception`**，
`catch (Exception e)` 抓不到它，`@ExceptionHandler(Exception.class)` 也不會進去
（除非你宣告 `Throwable`）。結果是 Tomcat 的預設錯誤頁 + 一條執行緒的堆疊被打爛。

**Jackson 2.15+ 之後** → `StreamConstraintsException`（`JsonProcessingException` 的子類）
→ `HttpMessageNotReadableException` → 400。✅

**驗證你的設定生效**（07 章會加進測試套件）：

```java
@Test
void 巢狀過深的JSON應回400而不是500() throws Exception {
    String bomb = "{\"a\":".repeat(50) + "1" + "}".repeat(50);
    mockMvc.perform(post("/orders").contentType(APPLICATION_JSON).content(bomb))
           .andExpect(status().isBadRequest())
           .andExpect(jsonPath("$.code").value("MALFORMED_REQUEST"));
}
```

### 2.11.4 完整的 `ApiLimitProperties`

```java
package example.shop.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/** API 層的各種硬上限，集中管理並在啟動時驗證。 */
@Validated
@ConfigurationProperties(prefix = "api.limits")
public record ApiLimitProperties(

    @Min(1) @Max(500)
    int maxPageSize,

    /** 客戶端沒指定 size 時用的值。★ 04 章 4.8.2 的深分頁計算需要它。 */
    @Min(1) @Max(500)
    int defaultPageSize,

    @Min(100) @Max(1_000_000)
    int maxOffset,

    @Min(1024) @Max(50 * 1024 * 1024)
    long maxRequestBodyBytes,

    @Min(1) @Max(100)
    int maxJsonDepth,

    @Min(1) @Max(500)
    int maxOrderItems,

    @Min(1) @Max(100)
    int maxValidationErrors,

    @Min(1) @Max(100)
    int maxMultiValueParams
) {
    public ApiLimitProperties {
        // 提供預設值，讓 application.yml 可以只覆寫部分
        if (maxPageSize == 0)          maxPageSize = 100;
        if (defaultPageSize == 0)      defaultPageSize = 20;
        if (maxOffset == 0)            maxOffset = 10_000;
        if (maxRequestBodyBytes == 0)  maxRequestBodyBytes = 1024 * 1024;
        if (maxJsonDepth == 0)         maxJsonDepth = 20;
        if (maxOrderItems == 0)        maxOrderItems = 50;
        if (maxValidationErrors == 0)  maxValidationErrors = 20;
        if (maxMultiValueParams == 0)  maxMultiValueParams = 20;

        // ★ 跨欄位一致性：設定檔打錯也要在啟動時失敗，而不是執行時才怪
        if (defaultPageSize > maxPageSize) {
            throw new IllegalArgumentException(
                    "api.limits.default-page-size (%d) 不可大於 max-page-size (%d)"
                            .formatted(defaultPageSize, maxPageSize));
        }
    }
}
```

```yaml
api:
  limits:
    max-page-size: 100
    default-page-size: 20
    max-offset: 10000
    max-request-body-bytes: 1048576      # 1 MB
    max-json-depth: 20
    max-order-items: 50
    max-validation-errors: 20
    max-multi-value-params: 20
```

⚠️ **`@Validated` + `@ConfigurationProperties` 讓錯誤的設定在啟動時就失敗**，
而不是等到某個請求觸發。這是 02-spring-boot 第 03 章講過的「fail fast」。

⚠️ **但 `@Max(500)` 這種上限也要有 —— 因為設定檔也會打錯。**
`max-page-size: 10000`（多一個 0）在沒有 `@Max` 時會靜默生效。

---

## 2.12 shop-service 的驗證落地

### 2.12.1 完整的 `CreateOrderRequest`

把前面所有技巧組合起來：

```java
package example.shop.order.web.dto;

import example.shop.common.validation.ResourceId;
import example.shop.common.validation.TaxId;
import example.shop.common.validation.TextLength;
import example.shop.common.validation.ValidInvoice;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

import java.util.List;
import java.util.Locale;

/**
 * POST /orders 的請求主體。
 *
 * <p>刻意「沒有」的欄位（全部由伺服器決定，第 00 章 0.6.2）：
 * unitPrice、subtotal、totalAmount、status、orderNumber、createdAt、customerId。
 */
public record CreateOrderRequest(

    @NotEmpty(message = "{example.shop.validation.order.itemsRequired}")
    @Size(max = 50, message = "{example.shop.validation.order.itemsTooMany}")
    List<@Valid Item> items,

    @NotBlank(message = "{example.shop.validation.order.shippingAddressRequired}")
    @ResourceId
    String shippingAddressId,

    @Size(max = 32)
    @Pattern(regexp = "^[A-Z0-9]{4,32}$",
             message = "{example.shop.validation.order.couponFormat}")
    String couponCode,

    @TextLength(max = 200, message = "{example.shop.validation.order.noteTooLong}")
    String customerNote,

    @Valid
    InvoiceRequest invoice

) {
    /** 訂單總件數上限（2.2.1）。 */
    public static final int MAX_TOTAL_QUANTITY = 1000;

    public CreateOrderRequest {
        items        = (items == null) ? List.of() : List.copyOf(items);
        couponCode   = normalizeCoupon(couponCode);
        customerNote = trimToNull(customerNote);
    }

    // ── 跨欄位驗證 ────────────────────────────────────────────

    @AssertTrue(message = "{example.shop.validation.order.totalQuantityExceeded}")
    public boolean isTotalQuantityWithinLimit() {
        return items.stream()
                .filter(i -> i != null && i.quantity() != null)
                .mapToInt(Item::quantity)
                .sum() <= MAX_TOTAL_QUANTITY;
    }

    @AssertTrue(message = "{example.shop.validation.order.duplicateProduct}")
    public boolean isProductIdsUnique() {
        long distinct = items.stream()
                .map(Item::productId).filter(java.util.Objects::nonNull).distinct().count();
        long total = items.stream().map(Item::productId)
                .filter(java.util.Objects::nonNull).count();
        return distinct == total;
    }

    // ── 巢狀型別 ──────────────────────────────────────────────

    public record Item(
        @NotBlank @ResourceId String productId,

        @NotNull(message = "{example.shop.validation.order.quantityRequired}")
        @Min(value = 1,   message = "{example.shop.validation.order.quantityRange}")
        @Max(value = 999, message = "{example.shop.validation.order.quantityRange}")
        Integer quantity
    ) {}

    @ValidInvoice
    public record InvoiceRequest(
        @NotNull(message = "{example.shop.validation.invoice.typeRequired}")
        InvoiceType type,

        @TaxId
        String taxId,

        @Size(max = 60)
        String companyName,

        @Pattern(regexp = "^/[0-9A-Z+\\-.]{7}$",
                 message = "{example.shop.validation.invoice.carrierFormat}")
        String carrierId,

        @Pattern(regexp = "^\\d{3,10}$",
                 message = "{example.shop.validation.invoice.donationCodeFormat}")
        String donationCode
    ) {
        public InvoiceRequest {
            taxId        = trimToNull(taxId);
            companyName  = trimToNull(companyName);
            carrierId    = (carrierId == null) ? null
                    : carrierId.trim().toUpperCase(Locale.ROOT);
            donationCode = trimToNull(donationCode);
        }
    }

    public enum InvoiceType { PERSONAL, COMPANY, DONATION }

    // ── 工具 ─────────────────────────────────────────────────

    private static String normalizeCoupon(String s) {
        if (s == null) return null;
        String t = s.trim().toUpperCase(Locale.ROOT);
        return t.isEmpty() ? null : t;
    }
    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
```

**`isProductIdsUnique()` 是一個容易漏的規則。**
送兩筆同樣的 `productId`：

```json
{ "items": [{"productId":"P-1","quantity":1}, {"productId":"P-1","quantity":1}] }
```

不擋的話，訂單會有兩筆同商品的明細。後果：

- 前端顯示「無線耳機 × 1」兩次，使用者以為是 bug。
- 庫存扣兩次（各 1）—— 這其實正確，但**退貨時無法對應**。
- 商品調價的快照可能不同（如果中間查了兩次）。

**正確做法是前端合併（同 03-rest-api 1.14.2 的「同商品則累加數量」），
但後端一定要擋** —— 因為前端會有 bug。

### 2.12.2 22 個 DTO 的驗證覆蓋表

| DTO | 必填欄位 | 長度限制 | 範圍限制 | 跨欄位 | 自訂約束 |
|---|---|---|---|---|---|
| `CreateOrderRequest` | `items`、`shippingAddressId` | 5 個 | `quantity` 1–999 | 總件數、productId 唯一 | `@ResourceId`、`@TextLength` |
| `CreateOrderRequest.InvoiceRequest` | `type` | 4 個 | — | `@ValidInvoice` | `@TaxId` |
| `UpdateOrderRequest` | 無（`PATCH`） | 3 個 | — | 至少改一個欄位 | `JsonNullable` |
| `OrderFilter` | 無 | 5 個 | `size` 1–100、`page` ≥ 0 | 金額範圍、日期範圍、page/cursor 互斥、offset 上限 | `@SortWhitelist` |
| `CreatePaymentRequest.CardPayment` | `cardNumber`、`expiryMonth/Year`、`cvv`、`holderName` | 3 個 | 月 1–12、年 2026–2050 | 卡片未過期 | `@LuhnCheck` |
| `CreatePaymentRequest.AtmTransferPayment` | 無 | `preferredBankCode` ≤ 4 | — | — | — |
| `CreatePaymentRequest.ConvenienceStorePayment` | `brand` | — | — | — | — |
| `CreatePaymentRequest.LinePayPayment` | `returnUrl` | ≤ 500 | — | — | `@SafeRedirectUrl` |
| `CreateCancellationRequest` | `reason` | `note` ≤ 500 | — | 「其他」原因時 note 必填 | `@RequiredWhen` |
| `CreateShipmentRequest` | `carrier`、`items` | 3 個 | 出貨量 ≥ 1 | 出貨量 ≤ 訂購量（階段 3） | — |
| `UpdateShippingAddressRequest` | `reason` | 8 個 | — | — | `@TaiwanPhone`、`@PostalCode` |
| `AddressRequest` | `recipient`、`phone`、`city`、`district`、`line1` | 7 個 | — | 郵遞區號與縣市一致 | `@TaiwanPhone` |
| `AddCartItemRequest` | `productId`、`quantity` | 1 個 | 1–999 | — | `@ResourceId` |
| `ApplyCouponRequest` | `code` | 4–32 | — | — | — |
| `ProductFilter` | 無 | 5 個 | `size` 1–48 | 價格範圍、須有 q 或 category | `@SortWhitelist` |
| `CreateReviewRequest` | `rating`、`content` | `content` 10–2000 | `rating` 1–5 | — | `@TextLength` |
| `CreateExportRequest` | `format`、日期範圍 | — | — | 範圍 ≤ 366 天 | — |

**其餘 5 個是純 Response DTO，沒有驗證。**

⚠️ **`@LuhnCheck` 不用自己寫** —— Hibernate Validator 內建：

```java
import org.hibernate.validator.constraints.LuhnCheck;

@NotBlank
@Pattern(regexp = "^\\d{13,19}$", message = "卡號須為 13～19 位數字")
@LuhnCheck(message = "卡號檢查碼錯誤")
String cardNumber
```

⚠️ **但卡號絕對不能出現在 `rejectedValue` 或任何 log 裡。**
2.9.3 的 `SENSITIVE_FIELD_HINTS` 已經包含 `cardnumber`。
**PCI DSS 明文要求不得儲存 CVV**，所以連 `debug` log 都不能有。

⚠️ **`@SafeRedirectUrl`（LINE Pay 的 `returnUrl`）是一個常被忽略的漏洞**：
如果不驗證，攻擊者可以把 `returnUrl` 設成自己的網站 →
使用者付款完被導到釣魚頁 → 輸入帳密。

```java
package example.shop.common.validation;

public class SafeRedirectUrlValidator
        implements ConstraintValidator<SafeRedirectUrl, CharSequence> {

    /** 白名單：只允許自家網域。從設定讀（純設定注入是允許的，2.7.5）。 */
    private final java.util.Set<String> allowedHosts;

    public SafeRedirectUrlValidator(AppUrlProperties props) {
        this.allowedHosts = java.util.Set.copyOf(props.allowedRedirectHosts());
    }

    @Override
    public boolean isValid(CharSequence value, ConstraintValidatorContext ctx) {
        if (value == null) return true;
        try {
            var uri = java.net.URI.create(value.toString());
            if (!"https".equalsIgnoreCase(uri.getScheme())) return false;   // ★ 只允許 https
            String host = uri.getHost();
            if (host == null) return false;
            return allowedHosts.contains(host.toLowerCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
```

⚠️ **注意用 `getHost()` 而不是字串 `startsWith`。**
`https://shop.example.attacker.com` 用 `startsWith("https://shop.example")` 會通過。
`URI.getHost()` 才是正確的解析。

### 2.12.3 `messages` 檔案完整版（訂單相關）

```properties
# src/main/resources/validation-messages_zh_TW.properties

# ── 通用 ─────────────────────────────────────────────
example.shop.validation.typeMismatch=欄位格式不正確
example.shop.validation.ResourceId.message=識別碼格式錯誤（限英數字、底線與連字號，最長 64 字）
example.shop.validation.TextLength.message=長度必須在 {min} 到 {max} 個字之間
example.shop.validation.TaiwanId.message=身分證字號格式錯誤
example.shop.validation.TaxId.message=統一編號格式錯誤（請確認 8 位數字與檢查碼）
example.shop.validation.SortWhitelist.message=排序參數錯誤
example.shop.validation.RequiredWhen.message=此欄位在目前的選擇下為必填
example.shop.validation.SafeRedirectUrl.message=回傳網址不在允許清單中

# ── 訂單 ─────────────────────────────────────────────
example.shop.validation.order.itemsRequired=訂單至少需要一項商品
example.shop.validation.order.itemsTooMany=單筆訂單最多 {max} 項商品
example.shop.validation.order.shippingAddressRequired=請選擇收件地址
example.shop.validation.order.quantityRequired=請輸入數量
example.shop.validation.order.quantityRange=數量必須在 1 到 999 之間
example.shop.validation.order.noteTooLong=備註最多 {max} 個字
example.shop.validation.order.couponFormat=折扣碼格式錯誤（限大寫英數字，4～32 字）
example.shop.validation.order.totalQuantityExceeded=訂單總件數不可超過 1000 件
example.shop.validation.order.duplicateProduct=同一項商品請合併為一筆，不要重複填寫
example.shop.validation.order.atLeastOneField=請至少修改一個欄位

# ── 發票 ─────────────────────────────────────────────
example.shop.validation.ValidInvoice.message=發票資訊不完整
example.shop.validation.invoice.typeRequired=請選擇發票類型
example.shop.validation.invoice.taxIdRequired=選擇公司發票時必須填寫統一編號
example.shop.validation.invoice.companyNameRequired=選擇公司發票時必須填寫公司名稱
example.shop.validation.invoice.donationCodeRequired=選擇捐贈發票時必須填寫愛心碼
example.shop.validation.invoice.carrierNotAllowedForCompany=公司發票不可使用手機載具
example.shop.validation.invoice.taxIdNotAllowedForPersonal=個人發票不可填寫統一編號
example.shop.validation.invoice.carrierFormat=手機載具格式錯誤（例：/ABC+123）
example.shop.validation.invoice.donationCodeFormat=愛心碼須為 3～10 位數字

# ── 付款 ─────────────────────────────────────────────
example.shop.validation.payment.cardNumberFormat=卡號須為 13～19 位數字
example.shop.validation.payment.cardNumberLuhn=卡號有誤，請重新確認
example.shop.validation.payment.cardExpired=卡片已過期
example.shop.validation.payment.cvvFormat=安全碼須為 3～4 位數字

# ── 分頁與查詢 ────────────────────────────────────────
example.shop.validation.page.sizeRange=每頁筆數必須在 1 到 {max} 之間
example.shop.validation.page.pageMin=頁碼不可小於 0
example.shop.validation.page.deepPagination=查詢範圍過深，請縮小條件或改用游標分頁
example.shop.validation.page.cursorConflict=page 與 cursor 不可同時使用
example.shop.validation.filter.amountRange=最低金額不可大於最高金額
example.shop.validation.filter.dateRange=起始日期不可晚於結束日期
example.shop.validation.filter.dateRangeTooWide=查詢區間不可超過 {max} 天
example.shop.validation.filter.scopeRequired=請提供搜尋關鍵字或選擇分類

# ── 覆寫 Hibernate Validator 內建訊息（安全網）────────
jakarta.validation.constraints.NotBlank.message=此欄位為必填
jakarta.validation.constraints.NotNull.message=此欄位為必填
jakarta.validation.constraints.NotEmpty.message=此欄位不可為空
jakarta.validation.constraints.Size.message=長度必須在 {min} 到 {max} 之間
jakarta.validation.constraints.Min.message=不可小於 {value}
jakarta.validation.constraints.Max.message=不可大於 {value}
jakarta.validation.constraints.DecimalMin.message=不可小於 {value}
jakarta.validation.constraints.DecimalMax.message=不可大於 {value}
jakarta.validation.constraints.Digits.message=數值格式錯誤
jakarta.validation.constraints.Pattern.message=格式不正確
jakarta.validation.constraints.Email.message=Email 格式不正確
jakarta.validation.constraints.PastOrPresent.message=不可以是未來的時間
jakarta.validation.constraints.FutureOrPresent.message=不可以是過去的時間
jakarta.validation.constraints.AssertTrue.message=條件不符
org.hibernate.validator.constraints.LuhnCheck.message=卡號有誤，請重新確認
```

⚠️ **`{max}` 這種插值在自訂訊息裡要注意**：
`example.shop.validation.order.itemsTooMany=單筆訂單最多 {max} 項商品`
只有在 `@Size(max = 50, message = "{...itemsTooMany}")` 時才有 `{max}` 可用。
如果那個 key 被用在沒有 `max` 屬性的約束上（例如 `@AssertTrue`），
訊息會原樣輸出 `{max}` —— **這是一個會被使用者看到的 bug**。

**防止方式**：2.13.5 會寫一個測試，檢查所有訊息插值後不含 `{`。

### 2.12.4 `UpdateOrderRequest`：`PATCH` 的完整版

```java
package example.shop.order.web.dto;

import example.shop.common.validation.TextLength;
import example.shop.common.validation.ValidInvoice;
import jakarta.validation.Valid;
import jakarta.validation.constraints.AssertTrue;
import org.openapitools.jackson.nullable.JsonNullable;

/**
 * PATCH /orders/{orderId}。三態語意（1.6.4）：
 * 欄位不存在 = 不改；null = 清空；有值 = 設定。
 */
public record UpdateOrderRequest(

    JsonNullable<@TextLength(max = 200) String> customerNote,

    JsonNullable<@Valid CreateOrderRequest.InvoiceRequest> invoice,

    /** 只有 SUPPORT 角色可用；權限檢查在 Service（0.6.7）。 */
    JsonNullable<@TextLength(max = 500) String> internalNote

) {
    public UpdateOrderRequest {
        customerNote = orUndefined(customerNote);
        invoice      = orUndefined(invoice);
        internalNote = orUndefined(internalNote);
    }

    /**
     * 空的 PATCH（`{}`）應該回 422 而不是「成功但什麼都沒改」。
     * 因為那幾乎一定是前端 bug，靜默成功會讓 bug 藏很久。
     */
    @AssertTrue(message = "{example.shop.validation.order.atLeastOneField}")
    public boolean isAtLeastOneFieldPresent() {
        return customerNote.isPresent() || invoice.isPresent() || internalNote.isPresent();
    }

    private static <T> JsonNullable<T> orUndefined(JsonNullable<T> v) {
        return (v == null) ? JsonNullable.undefined() : v;
    }
}
```

**「空的 `PATCH` 要回 422」是一個有爭議但值得的決定。**

| 立場 | 論點 |
|---|---|
| **回 200（什麼都沒改）** | `PATCH` 空 body 語意上是合法的 no-op，冪等 |
| **回 422** | 空 `PATCH` 幾乎一定是前端 bug（狀態管理錯誤），靜默成功會讓 bug 藏到使用者回報 |

shop-service 選 422，理由和 03-rest-api 第 05 章「靜默忽略是最貴的寬容」一致。
**但要在 API 文件寫清楚**，因為這不是所有 API 的預設行為。

---

## 2.13 驗證的測試

**驗證程式碼一定要有測試，理由和錯誤處理一樣**（03-rest-api 第 04 章 4.16）：
**它出錯的時候不會有人發現。** 驗證靜默失效不會拋例外、不會進 log、
只會讓壞資料進資料庫。

### 2.13.1 不啟動 Spring 直接測 DTO

**這是最划算的測試** —— 3 毫秒一個，可以寫 200 個。

```java
package example.shop.order.web.dto;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CreateOrderRequestValidationTest {

    private static Validator validator;

    @BeforeAll
    static void setUp() {
        // ⚠️ 這個 validator 讀 ValidationMessages.properties，不是 Spring 的 MessageSource。
        //    所以訊息會是 i18n key 原文。要測「訊息內容」得用 @SpringBootTest（2.13.5）。
        try (ValidatorFactory factory = Validation.buildDefaultValidatorFactory()) {
            validator = factory.getValidator();
        }
    }

    // ── 快樂路徑 ───────────────────────────────────────────

    @Test
    void 合法的請求沒有違反() {
        var request = valid();
        assertThat(validator.validate(request)).isEmpty();
    }

    // ── quantity 邊界 ─────────────────────────────────────

    @ParameterizedTest
    @ValueSource(ints = {1, 2, 500, 998, 999})
    void quantity在範圍內通過(int qty) {
        var request = withItems(List.of(new CreateOrderRequest.Item("P-1", qty)));
        assertThat(validator.validate(request)).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(ints = {0, -1, -999, 1000, 1001, Integer.MAX_VALUE})
    void quantity超出範圍被拒(int qty) {
        var request = withItems(List.of(new CreateOrderRequest.Item("P-1", qty)));
        var violations = validator.validate(request);

        assertThat(violations).isNotEmpty();
        assertThat(violations).anySatisfy(v ->
                assertThat(v.getPropertyPath().toString()).isEqualTo("items[0].quantity"));
    }

    @Test
    void quantity為null被拒() {
        var request = withItems(List.of(new CreateOrderRequest.Item("P-1", null)));
        assertThat(validator.validate(request))
                .anySatisfy(v -> assertThat(v.getPropertyPath().toString())
                        .isEqualTo("items[0].quantity"));
    }

    // ── items 邊界 ────────────────────────────────────────

    @Test
    void items為空被拒() {
        assertThat(validator.validate(withItems(List.of()))).isNotEmpty();
    }

    @Test
    void items為null被拒() {
        // compact constructor 會把 null 變成 List.of()，所以這裡驗的是 @NotEmpty
        assertThat(validator.validate(withItems(null))).isNotEmpty();
    }

    @Test
    void items剛好50項通過() {
        var items = java.util.stream.IntStream.range(0, 50)
                .mapToObj(i -> new CreateOrderRequest.Item("P-" + i, 1))
                .toList();
        assertThat(validator.validate(withItems(items))).isEmpty();
    }

    @Test
    void items51項被拒() {
        var items = java.util.stream.IntStream.range(0, 51)
                .mapToObj(i -> new CreateOrderRequest.Item("P-" + i, 1))
                .toList();
        assertThat(validator.validate(withItems(items)))
                .anySatisfy(v -> assertThat(v.getPropertyPath().toString()).isEqualTo("items"));
    }

    // ── 跨欄位規則 ─────────────────────────────────────────

    @Test
    void 總件數超過1000被拒() {
        // 2 項 × 999 = 1998 > 1000（但每項都在 1～999 內，所以只有跨欄位規則會抓到）
        var items = List.of(new CreateOrderRequest.Item("P-1", 999),
                            new CreateOrderRequest.Item("P-2", 999));
        assertThat(validator.validate(withItems(items)))
                .anySatisfy(v -> assertThat(v.getPropertyPath().toString())
                        .isEqualTo("totalQuantityWithinLimit"));   // ⚠️ 見 2.13.2 的評論
    }

    @Test
    void 重複的productId被拒() {
        var items = List.of(new CreateOrderRequest.Item("P-1", 1),
                            new CreateOrderRequest.Item("P-1", 2));
        assertThat(validator.validate(withItems(items))).isNotEmpty();
    }

    // ── 正規化 ────────────────────────────────────────────

    @ParameterizedTest
    @CsvSource({
        "summer20, SUMMER20",
        "'  summer20  ', SUMMER20",
        "SUMMER20, SUMMER20"
    })
    void 折扣碼會被trim並轉大寫(String input, String expected) {
        var request = new CreateOrderRequest(
                List.of(new CreateOrderRequest.Item("P-1", 1)),
                "addr_1", input, null, null);
        assertThat(request.couponCode()).isEqualTo(expected);
        assertThat(validator.validate(request)).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "   "})
    void 空白的折扣碼被正規化成null(String input) {
        var request = new CreateOrderRequest(
                List.of(new CreateOrderRequest.Item("P-1", 1)),
                "addr_1", input, null, null);
        assertThat(request.couponCode()).isNull();
        assertThat(validator.validate(request)).isEmpty();   // null 是合法的（選填）
    }

    @Test
    void 空白的備註被正規化成null() {
        var request = new CreateOrderRequest(
                List.of(new CreateOrderRequest.Item("P-1", 1)),
                "addr_1", null, "   ", null);
        assertThat(request.customerNote()).isNull();
    }

    // ── 工具 ─────────────────────────────────────────────

    private static CreateOrderRequest valid() {
        return withItems(List.of(new CreateOrderRequest.Item("P-1001", 2)));
    }

    private static CreateOrderRequest withItems(List<CreateOrderRequest.Item> items) {
        return new CreateOrderRequest(items, "addr_01J5GK", "SUMMER20", "請小心包裝", null);
    }
}
```

**這個測試檔案的三個要點：**

| 要點 | 說明 |
|---|---|
| **邊界值成對測** | `50` 通過、`51` 被拒；`999` 通過、`1000` 被拒。只測一邊等於沒測 |
| **驗 `propertyPath`** | 只驗「有錯誤」不夠 —— 錯在哪個欄位才是前端要的。而 `items[0].quantity` 這個格式是契約 |
| **正規化與驗證一起測** | 因為它們的執行順序會影響結果（1.6.2） |

### 2.13.2 `@AssertTrue` 的 `propertyPath` 問題（誠實面對）

上面的測試裡有這一行：

```java
assertThat(v.getPropertyPath().toString()).isEqualTo("totalQuantityWithinLimit");
```

**這正是 2.7.3 提過的問題**：`@AssertTrue` 產生的 `field` 是屬性名，
前端無法用它定位輸入框。

**shop-service 對這個問題的三段式處理：**

**① 對「不影響 UI 定位」的規則，接受這個限制。**

「訂單總件數不可超過 1000」不需要標某個輸入框 —— 
前端顯示一個全域錯誤訊息就好。所以 `field: "totalQuantityWithinLimit"` 可以接受，
但要在 advice 裡把它轉成 `null`（表示「這是全域錯誤」）：

```java
/** @AssertTrue 產生的偽欄位名 → 轉成全域錯誤（field = null）。 */
private static final java.util.Set<String> PSEUDO_FIELDS = java.util.Set.of(
        "totalQuantityWithinLimit", "productIdsUnique", "amountRangeValid",
        "dateRangeValid", "paginationModeValid", "atLeastOneFieldPresent",
        "priceRangeValid", "scopeProvided", "offsetWithinLimit");
```

⚠️ **這個清單是手工維護的，會漏。** 2.13.4 會寫測試守住它。

**② 對「需要定位」的規則，改用類別層級驗證器 + `addPropertyNode()`**（2.7.3）。

`@ValidInvoice` 就是這樣做的 —— 因為「缺統編」必須標到統編那格。

**③ 在 API 文件標明「`field` 可能為 `null`（全域錯誤）」。**

```jsonc
{
  "errors": [
    { "field": null, "code": "AssertTrue",
      "message": "訂單總件數不可超過 1000 件" }
  ]
}
```

前端的處理邏輯：

```typescript
for (const e of problem.errors ?? []) {
  if (e.field) markField(e.field, e.message);      // 標紅該欄位
  else         showGlobalError(e.message);          // 顯示在表單頂端
}
```

> **這一段的價值不在技巧，在於「知道框架的限制在哪，並設計一個一致的處理方式」。**
> 假裝 `@AssertTrue` 的 `field` 有用，才會做出前端無法消費的 API。

### 2.13.3 容器元素約束一定要測（因為它會靜默失效）

```java
class UpdateOrderRequestValidationTest {

    private static Validator validator;

    @BeforeAll
    static void setUp() {
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            validator = factory.getValidator();
        }
    }

    @Test
    void JsonNullable裡的Size約束有生效() {
        var request = new UpdateOrderRequest(
                JsonNullable.of("x".repeat(201)),      // 超過 200
                JsonNullable.undefined(),
                JsonNullable.undefined());

        var violations = validator.validate(request);

        // ★ 如果 JsonNullableModule / ValueExtractor 沒註冊好，這裡會是空的
        assertThat(violations)
                .as("JsonNullable 的容器元素約束沒生效 —— 檢查 jackson-databind-nullable 依賴")
                .isNotEmpty();
        assertThat(violations).anySatisfy(v ->
                assertThat(v.getPropertyPath().toString()).isEqualTo("customerNote"));
    }

    @Test
    void undefined不會觸發約束() {
        var request = new UpdateOrderRequest(
                JsonNullable.of("正常長度"),
                JsonNullable.undefined(),
                JsonNullable.undefined());
        assertThat(validator.validate(request)).isEmpty();
    }

    @Test
    void 清空欄位是合法的() {
        var request = new UpdateOrderRequest(
                JsonNullable.of(null),                 // 明確清空
                JsonNullable.undefined(),
                JsonNullable.undefined());
        assertThat(validator.validate(request)).isEmpty();
    }

    @Test
    void 空的PATCH被拒() {
        var request = new UpdateOrderRequest(
                JsonNullable.undefined(),
                JsonNullable.undefined(),
                JsonNullable.undefined());
        assertThat(validator.validate(request)).isNotEmpty();
    }
}
```

**`as("...")` 的訊息很重要** —— 這個測試失敗時，
「JsonNullable 的容器元素約束沒生效」比「expected not empty but was empty」有用一百倍。

### 2.13.4 用反射寫「驗證覆蓋率」測試 ★

**這是本章最有價值的一個測試。** 它自動抓「忘記加驗證」的欄位。

```java
package example.shop.common.validation;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.RegexPatternTypeFilter;

import jakarta.validation.constraints.*;
import java.lang.annotation.Annotation;
import java.lang.reflect.RecordComponent;
import java.util.*;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 架構測試：確保每個 Request DTO 的欄位都有適當的驗證。
 *
 * <p>這個測試會在「新增欄位但忘了加驗證」時失敗，而那正是最常見的漏洞來源（2.2）。
 */
class RequestDtoValidationCoverageTest {

    /** 掃描所有 *Request / *Filter 結尾的 record。 */
    private static List<Class<?>> requestDtos() {
        var scanner = new ClassPathScanningCandidateComponentProvider(false) {
            @Override protected boolean isCandidateComponent(
                    org.springframework.beans.factory.annotation.AnnotatedBeanDefinition bd) {
                return true;                    // 允許非 @Component 的類別
            }
        };
        scanner.addIncludeFilter(new RegexPatternTypeFilter(
                Pattern.compile(".*\\.(dto|web)\\..*(Request|Filter)$")));

        List<Class<?>> result = new ArrayList<>();
        for (var bd : scanner.findCandidateComponents("example.shop")) {
            try {
                Class<?> c = Class.forName(bd.getBeanClassName());
                collectRecords(c, result);
            } catch (ClassNotFoundException ignored) { }
        }
        return result;
    }

    private static void collectRecords(Class<?> c, List<Class<?>> out) {
        if (c.isRecord()) out.add(c);
        for (Class<?> nested : c.getDeclaredClasses()) collectRecords(nested, out);
    }

    @Test
    @DisplayName("每個字串欄位都必須有長度上限（@Size / @TextLength / 組合約束）")
    void 字串欄位都有長度上限() {
        List<String> missing = new ArrayList<>();

        for (Class<?> dto : requestDtos()) {
            for (RecordComponent rc : dto.getRecordComponents()) {
                if (!CharSequence.class.isAssignableFrom(rc.getType())) continue;
                if (hasLengthConstraint(rc)) continue;
                missing.add(dto.getSimpleName() + "." + rc.getName());
            }
        }

        assertThat(missing)
                .as("以下字串欄位沒有長度上限，可能造成資料庫截斷或磁碟耗盡（2.2.2）")
                .isEmpty();
    }

    @Test
    @DisplayName("每個數值欄位都必須有上限（@Max / @DecimalMax / @Digits）")
    void 數值欄位都有上限() {
        List<String> missing = new ArrayList<>();

        for (Class<?> dto : requestDtos()) {
            for (RecordComponent rc : dto.getRecordComponents()) {
                if (!isNumeric(rc.getType())) continue;
                if (hasUpperBound(rc)) continue;
                missing.add(dto.getSimpleName() + "." + rc.getName());
            }
        }

        assertThat(missing)
                .as("以下數值欄位沒有上限，可能造成鎖競爭或溢位（2.2.1）")
                .isEmpty();
    }

    @Test
    @DisplayName("每個集合欄位都必須有大小上限")
    void 集合欄位都有大小上限() {
        List<String> missing = new ArrayList<>();

        for (Class<?> dto : requestDtos()) {
            for (RecordComponent rc : dto.getRecordComponents()) {
                if (!Collection.class.isAssignableFrom(rc.getType())
                        && !Map.class.isAssignableFrom(rc.getType())) continue;
                if (rc.isAnnotationPresent(Size.class)) continue;
                missing.add(dto.getSimpleName() + "." + rc.getName());
            }
        }

        assertThat(missing).as("以下集合欄位沒有大小上限").isEmpty();
    }

    @Test
    @DisplayName("原生型別不該出現在 Request DTO（無法區分「沒送」與「0」）")
    void 沒有原生型別欄位() {
        List<String> found = new ArrayList<>();

        for (Class<?> dto : requestDtos()) {
            for (RecordComponent rc : dto.getRecordComponents()) {
                if (rc.getType().isPrimitive()) {
                    found.add(dto.getSimpleName() + "." + rc.getName()
                            + " (" + rc.getType().getSimpleName() + ")");
                }
            }
        }

        assertThat(found)
                .as("原生型別在 JSON 缺欄位時會是 0/false，讓 @Min(1) 才擋得住（1.6.2）")
                .isEmpty();
    }

    // ── 判斷工具 ─────────────────────────────────────────

    private static boolean hasLengthConstraint(RecordComponent rc) {
        return isPresent(rc, Size.class)
                || isPresent(rc, TextLength.class)
                || isPresent(rc, ResourceId.class)         // 組合約束內含 @Size
                || isPresent(rc, TaxId.class)              // 固定長度
                || isPresent(rc, TaiwanId.class)
                || isPresent(rc, SortWhitelist.class)      // 驗證器內部有長度檢查
                || hasBoundedPattern(rc);
    }

    /** `@Pattern` 若使用固定量詞（{n} 或 {n,m}）就算有長度上限。 */
    private static boolean hasBoundedPattern(RecordComponent rc) {
        Pattern p = rc.getAnnotation(Pattern.class);
        if (p == null) return false;
        String regex = p.regexp();
        return regex.matches(".*\\{\\d+(,\\d+)?}.*") && !regex.contains("+") && !regex.contains("*");
    }

    private static boolean hasUpperBound(RecordComponent rc) {
        return isPresent(rc, Max.class) || isPresent(rc, DecimalMax.class)
                || isPresent(rc, Digits.class) || isPresent(rc, Negative.class)
                || isPresent(rc, NegativeOrZero.class);
    }

    private static boolean isNumeric(Class<?> t) {
        return Number.class.isAssignableFrom(t)
                || t == int.class || t == long.class || t == short.class
                || t == byte.class || t == double.class || t == float.class;
    }

    private static boolean isPresent(RecordComponent rc, Class<? extends Annotation> a) {
        // 直接標註 或 透過 TYPE_USE（容器元素）標註
        if (rc.isAnnotationPresent(a)) return true;
        return rc.getAnnotatedType().isAnnotationPresent(a);
    }
}
```

⚠️ **這個測試會有誤報**（例如 `JsonNullable<@Size(...) String>` 的註解在泛型參數上，
`getAnnotatedType()` 要往下鑽一層）。**實務上的處理方式**：

```java
/** 明確排除的欄位（附上理由，並且要 code review）。 */
private static final Set<String> ALLOWED_EXCEPTIONS = Set.of(
        "OrderFilter.cursor",           // 由 StringToCursorConverter 檢查長度（1.9.4）
        "CreatePaymentRequest.CardPayment.cardNumber"   // 用 @Pattern{13,19} + @LuhnCheck
);
```

**「有 allowlist 的架構測試」比「沒有測試」好非常多**，
因為每一次加例外都要寫理由，而理由會被 review。

### 2.13.5 訊息完整性測試

```java
package example.shop.common.validation;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.i18n.LocaleContextHolder;

import jakarta.validation.Validator;
import java.util.List;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 這個測試要啟動 Spring，因為它驗的是「Spring MessageSource 有沒有接上」。
 * 2.13.1 的 Validator 用的是 ValidationMessages.properties，測不到這件事。
 */
@SpringBootTest
class ValidationMessageResolutionTest {

    @Autowired Validator validator;         // ★ Spring 注入的，已接上 MessageSource

    @Test
    void 所有驗證訊息都已被解析成中文() {
        LocaleContextHolder.setLocale(Locale.forLanguageTag("zh-TW"));

        var bad = new CreateOrderRequest(List.of(), "", "abc", "x".repeat(300), null);
        var violations = validator.validate(bad);

        assertThat(violations).isNotEmpty();
        for (var v : violations) {
            assertThat(v.getMessage())
                    .as("欄位 %s 的訊息沒有被解析（key 原樣輸出）", v.getPropertyPath())
                    .doesNotStartWith("{")
                    .doesNotContain("{");           // ★ 也檢查插值變數都被替換了
            assertThat(v.getMessage())
                    .as("欄位 %s 的訊息是英文預設值", v.getPropertyPath())
                    .isNotEqualTo("must not be blank")
                    .isNotEqualTo("must not be empty");
        }
    }
}
```

**`doesNotContain("{")` 抓的是 2.12.3 提過的 bug**：
訊息裡有 `{max}` 但那個約束沒有 `max` 屬性 → 原樣輸出 → 使用者看到 `最多 {max} 項商品`。

### 2.13.6 測試金字塔：哪一層測什麼

| 測什麼 | 用什麼 | 速度 | 例子 |
|---|---|---|---|
| 單一約束的邊界值 | `Validation.buildDefaultValidatorFactory()` | ~1 ms | `quantity` 0/1/999/1000 |
| 自訂驗證器的演算法 | `new TaiwanIdValidator()` 直接呼叫 | ~0.1 ms | 200 個身分證號 |
| 容器元素約束有沒有生效 | 同上（純 Validator） | ~1 ms | 2.13.3 |
| 訊息有沒有接上 MessageSource | `@SpringBootTest` | ~3 s | 2.13.5 |
| **驗證失敗的 HTTP 回應格式** | `@WebMvcTest` + MockMvc | ~0.8 s | **07 章** |
| 驗證覆蓋率（架構規則） | 反射 / ArchUnit | ~200 ms | 2.13.4 |

**80% 的驗證測試應該在第一層**（純 Validator，不啟動 Spring）。
只有「格式（422 + `errors[]`）」需要 MockMvc，而那是 03 章與 07 章的事。

---

## 2.14 常見誤區

**誤區 1：「加了 `@Valid` 就有驗證了」**

三個可能失效的原因：
1. 沒加 `spring-boot-starter-validation`（2.3.1）—— **完全靜默**。
2. 巢狀物件沒標 `@Valid`（2.5.1）—— 內層完全沒驗。
3. 用了群組但忘標（2.6.3 陷阱 1）—— 沒標群組的約束不執行。

**三個都是靜默失效。** 所以 2.13 的測試不是「加分項」，是必需品。

**誤區 2：「`@NotNull` 就是必填」**

對字串來說不夠：`@NotNull String name` 會讓 `""` 和 `"   "` 通過。
字串一律 `@NotBlank`。

**誤區 3：「有 `@Min(1)` 就不用 `@NotNull`」**

`@Min(1) Integer quantity` 對 `null` 是**通過**的（2.4.1）。
兩個都要。

**誤區 4：「`@Email` 驗過了就是有效的 Email」**

2.2.3。`a@b` 通過。要搭配 `regexp` + `@Size`，而且真正的驗證是寄信。

**誤區 5：「驗證訊息越詳細越好」**

```java
// ❌ 洩漏內部規則
@Pattern(regexp = "^ord_[0-9A-HJKMNP-TV-Z]{26}$",
         message = "訂單編號須符合 ord_ 前綴加 26 位 Crockford Base32")
```

這告訴攻擊者你的 ID 生成方式（ULID）與字元集。
而且對合法的客戶端沒用（他們的 ID 是你給的，不會自己組）。

```java
// ✅
@ResourceId    // 訊息：「識別碼格式錯誤」
```

⚠️ **但「可用的排序欄位清單」可以回傳**（2.7.4）—— 那是公開契約的一部分，
而且對客戶端很有用。**判準：這個資訊在 API 文件裡嗎？在 → 可以回；不在 → 不要回。**

**誤區 6：「跨欄位驗證用 `@AssertTrue` 就好」**

`field` 是屬性名，前端無法定位（2.13.2）。
需要定位的用類別層級驗證器 + `addPropertyNode()`。

**誤區 7：「在驗證器裡查資料庫比較方便」**

2.7.5 的五個理由。最重要的是 TOCTOU —— 它**根本無法保證唯一性**，
只是製造一種安全感。

**誤區 8：「驗證是為了使用者體驗」**

2.2.4。驗證是資源保護與攻擊面收斂。
使用者體驗是副產品（而且很多驗證的錯誤訊息使用者永遠看不到，
因為那些請求是機器發的）。

**誤區 9：「`@Size(max = 200)` 就等於資料庫的 `varchar(200)`」**

兩個不一致的地方：
1. **字元 vs 位元組**：MySQL 的 `varchar(200)` 在 `utf8mb4` 下是 200 個**字元**
   （最多 800 bytes），這個對得上。但如果欄位是 `varchar(200)` 而 charset 是 `latin1`，
   一個中文字就佔不下。
2. **UTF-16 code unit vs code point**（2.4.4）：
   emoji 在 Java 算 2、在 MySQL `utf8mb4` 算 1 個字元。
   所以 `@Size(max = 200)` 通過的字串**一定**放得進 `varchar(200)`（Java 的計數更嚴格）。

👉 **實務建議：資料庫欄位開得比驗證上限寬鬆（1.5～2 倍）**，
留出安全邊界，也讓「放寬驗證上限」不用改 schema。

**誤區 10：「一次回全部錯誤 vs 分階段驗證」二選一**

其實可以兼顧：**同一階段內一次回全部，階段之間才短路**。
shop-service 的做法就是這樣（2.10）：
Bean Validation 一次回全部（階段 1），
階段 1 全過才進階段 2，階段 2 也一次回全部。

---

## 2.15 本章練習

### 練習 1：找出這個 DTO 的 12 個驗證問題

```java
public record CreateReviewRequest(
    @NotNull String productId,
    @NotNull Integer rating,
    String title,
    @NotBlank String content,
    List<String> imageUrls,
    Boolean anonymous,
    @Email String contactEmail,
    Double helpfulScore,
    @Past LocalDate purchaseDate,
    Map<String, String> metadata
) {
    public record Reply(String content, String authorId) {}
}
```

<details>
<summary>解答</summary>

| # | 問題 | 後果 | 修正 |
|---|---|---|---|
| 1 | `productId` 用 `@NotNull` 而非 `@NotBlank` | `""` 通過 → 查不到商品但錯誤訊息是 404 | `@NotBlank @ResourceId` |
| 2 | `productId` 沒有長度上限 | 2.2.2 | `@ResourceId`（內含 `@Size(max=64)`） |
| 3 | `rating` 沒有範圍 | 送 `999999` 或 `-5` → 平均分數被汙染 | `@Min(1) @Max(5)` |
| 4 | `title` 沒有任何約束 | 超長字串 → 資料庫截斷 | `@TextLength(max = 100)` |
| 5 | `content` 只有 `@NotBlank`，沒有長度 | 同上；而且評價可能被塞 1 MB 的文字 | `@TextLength(min = 10, max = 2000)` |
| 6 | `imageUrls` 沒有大小上限 | 送 10,000 個 URL | `@Size(max = 5)` |
| 7 | `imageUrls` 元素沒有驗證 | 每個 URL 可以是 1 MB 字串，或是 `javascript:` scheme | `List<@SafeImageUrl @Size(max = 500) String>` |
| 8 | `contactEmail` 只有 `@Email` | 2.2.3；且沒有長度上限 | `@Size(max = 254) @Email(regexp = ...)` |
| 9 | `helpfulScore` 是 `Double` 且客戶端可送 | **這是伺服器計算的欄位** —— mass assignment | 從 DTO 移除 |
| 10 | `helpfulScore` 用 `Double` | `@Min`/`@Max` **不支援 `double`**（2.4.3），加了會拋 `UnexpectedTypeException` | 移除；若真需要用 `BigDecimal` |
| 11 | `purchaseDate` 用 `@Past` | 時區問題（2.4.5）：台灣早上 7 點前，「今天」會被判為未來 → 驗證失敗 | 改用 `@AssertTrue` + 明確時區，或 `@PastOrPresent` + `ClockProvider` |
| 12 | `metadata` 沒有任何約束 | key 與 value 都無限制；`Map` 可以有 100,000 個 entry | `@Size(max = 10) Map<@Pattern(regexp="^[a-z_]{1,32}$") String, @Size(max=200) String>` |

**額外三個（送你）**：

| # | 問題 |
|---|---|
| 13 | `anonymous` 是 `Boolean` 可以是 `null` → Service 要處理三態。應在 compact constructor 給預設值 `false` |
| 14 | 巢狀的 `Reply` record **完全沒有驗證**，而且它出現在 Request DTO 裡很奇怪（回覆評價應該是另一個端點 `POST /reviews/{id}/replies`） |
| 15 | 沒有「購買過才能評價」的檢查 —— 但那是**階段 2**（需要查訂單），屬於 Service（2.10） |

**修正後**：

```java
package example.shop.product.web.dto;

import example.shop.common.validation.*;
import jakarta.validation.constraints.*;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

/**
 * POST /products/{productId}/reviews
 *
 * <p>注意 productId 來自路徑，不在 body 裡（避免兩個來源不一致）。
 * helpfulScore、createdAt、authorId 全部由伺服器決定。
 */
public record CreateReviewRequest(

    @NotNull(message = "{example.shop.validation.review.ratingRequired}")
    @Min(value = 1, message = "{example.shop.validation.review.ratingRange}")
    @Max(value = 5, message = "{example.shop.validation.review.ratingRange}")
    Integer rating,

    @TextLength(max = 100)
    String title,

    @NotBlank(message = "{example.shop.validation.review.contentRequired}")
    @TextLength(min = 10, max = 2000,
                message = "{example.shop.validation.review.contentLength}")
    String content,

    @Size(max = 5, message = "{example.shop.validation.review.tooManyImages}")
    List<@NotBlank @Size(max = 500) @SafeImageUrl String> imageUrls,

    Boolean anonymous,

    @Size(max = 254)
    @Email(regexp = EMAIL_REGEX, message = "{jakarta.validation.constraints.Email.message}")
    String contactEmail,

    LocalDate purchaseDate

) {
    static final String EMAIL_REGEX =
        "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
      + "@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
      + "(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";

    private static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Taipei");

    public CreateReviewRequest {
        title      = trimToNull(title);
        content    = (content == null) ? null : content.strip();
        imageUrls  = (imageUrls == null) ? List.of() : List.copyOf(imageUrls);
        anonymous  = (anonymous != null) && anonymous;         // ★ 預設 false
    }

    /** 用明確時區判斷「不可以是未來」，避開 @Past 的時區坑（2.4.5）。 */
    @AssertTrue(message = "{example.shop.validation.review.purchaseDateFuture}")
    public boolean isPurchaseDateNotFuture() {
        return purchaseDate == null
                || !purchaseDate.isAfter(LocalDate.now(BUSINESS_ZONE));
    }

    /** 圖片 URL 不可重複（前端 bug 會送重複的）。 */
    @AssertTrue(message = "{example.shop.validation.review.duplicateImages}")
    public boolean isImageUrlsUnique() {
        return imageUrls.size() == imageUrls.stream().distinct().count();
    }

    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.strip();
        return t.isEmpty() ? null : t;
    }
}
```

**`@SafeImageUrl` 的必要性**：不驗證的話，`imageUrls` 可以是

```
javascript:alert(document.cookie)
data:text/html;base64,PHNjcmlwdD4...
http://internal-admin.local/  ← SSRF：如果後端會去抓圖產縮圖
```

前端把它放進 `<img src="...">` 就是 XSS；
後端去抓它產縮圖就是 **SSRF**。

```java
public class SafeImageUrlValidator implements ConstraintValidator<SafeImageUrl, CharSequence> {

    private final java.util.Set<String> allowedHosts;

    public SafeImageUrlValidator(CdnProperties props) {
        this.allowedHosts = java.util.Set.copyOf(props.allowedImageHosts());
    }

    @Override
    public boolean isValid(CharSequence value, ConstraintValidatorContext ctx) {
        if (value == null) return true;
        try {
            var uri = java.net.URI.create(value.toString());
            if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
            String host = uri.getHost();
            return host != null
                    && allowedHosts.contains(host.toLowerCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
```

⚠️ **更好的設計是根本不接受 URL** ——
讓客戶端先 `POST /uploads` 上傳圖片拿到 `imageId`，
評價 DTO 只收 `List<@ResourceId String> imageIds`。
這樣就完全沒有 SSRF / XSS 的空間。**（05 章會實作上傳端點。）**

</details>

### 練習 2：實作 `@ValidCardExpiry`

需求：信用卡的 `expiryMonth`（1–12）與 `expiryYear`（4 位數）必須組合成「未來的月份」。

規則：
- 卡片在**到期月份的最後一天**仍然有效（`expiryMonth=8, expiryYear=2026` 在 2026-08-31 有效）。
- 以台灣時區判斷「現在」。
- 錯誤要定位到 `expiryYear`（因為那是使用者比較可能填錯的）。
- `expiryMonth` 或 `expiryYear` 是 `null` 時不報這個錯（交給 `@NotNull`）。

<details>
<summary>解答</summary>

```java
package example.shop.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import java.lang.annotation.*;

/** 信用卡到期日：月／年必須組成未來（含當月）的月份。 */
@Documented
@Constraint(validatedBy = ValidCardExpiryValidator.class)
@Target({ElementType.TYPE, ElementType.ANNOTATION_TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface ValidCardExpiry {
    String message() default "{example.shop.validation.payment.cardExpired}";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
```

```java
package example.shop.common.validation;

import example.shop.order.web.dto.CreatePaymentRequest.CardPayment;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

import java.time.Clock;
import java.time.YearMonth;
import java.time.ZoneId;

public class ValidCardExpiryValidator
        implements ConstraintValidator<ValidCardExpiry, CardPayment> {

    private static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Taipei");

    /** 可注入以便測試（純設定／時鐘，不是 I/O，符合 2.7.5 的規則）。 */
    private final Clock clock;

    public ValidCardExpiryValidator() {
        this(Clock.system(BUSINESS_ZONE));
    }

    ValidCardExpiryValidator(Clock clock) {
        this.clock = clock;
    }

    @Override
    public boolean isValid(CardPayment card, ConstraintValidatorContext ctx) {
        if (card == null) return true;
        Integer month = card.expiryMonth();
        Integer year  = card.expiryYear();

        // ★ null 或超出範圍時不報這個錯 —— 交給 @NotNull / @Min / @Max
        if (month == null || year == null) return true;
        if (month < 1 || month > 12) return true;
        if (year < 1000 || year > 9999) return true;

        YearMonth expiry = YearMonth.of(year, month);
        YearMonth now    = YearMonth.now(clock);

        // 到期月份的最後一天仍然有效 → 用 isBefore 而不是 !isAfter
        if (!expiry.isBefore(now)) return true;

        ctx.disableDefaultConstraintViolation();
        ctx.buildConstraintViolationWithTemplate(
                   "{example.shop.validation.payment.cardExpired}")
           .addPropertyNode("expiryYear")            // ★ 定位到年份欄位
           .addConstraintViolation();
        return false;
    }
}
```

```java
@ValidCardExpiry
public record CardPayment(
    @NotBlank
    @Pattern(regexp = "^\\d{13,19}$",
             message = "{example.shop.validation.payment.cardNumberFormat}")
    @org.hibernate.validator.constraints.LuhnCheck(
             message = "{example.shop.validation.payment.cardNumberLuhn}")
    String cardNumber,

    @NotNull @Min(1) @Max(12) Integer expiryMonth,
    @NotNull @Min(2000) @Max(2100) Integer expiryYear,

    @NotBlank
    @Pattern(regexp = "^\\d{3,4}$",
             message = "{example.shop.validation.payment.cvvFormat}")
    String cvv,

    @NotBlank @TextLength(max = 60) String holderName
) implements CreatePaymentRequest {}
```

**測試**：

```java
class ValidCardExpiryValidatorTest {

    /** 固定時鐘：2026-08-20（台灣時間）。 */
    private final Clock fixed = Clock.fixed(
            java.time.Instant.parse("2026-08-20T02:00:00Z"),
            ZoneId.of("Asia/Taipei"));

    private final ValidCardExpiryValidator validator = new ValidCardExpiryValidator(fixed);

    @ParameterizedTest
    @CsvSource({
        "8,  2026, true",    // 當月 → 有效（月底才過期）
        "9,  2026, true",
        "12, 2030, true",
        "7,  2026, false",   // 上個月 → 過期
        "12, 2025, false",
        "1,  2020, false"
    })
    void 到期日判斷(int month, int year, boolean expected) {
        var card = new CardPayment("4242424242424242", month, year, "123", "WANG");
        assertThat(validator.isValid(card, mockContext())).isEqualTo(expected);
    }

    @ParameterizedTest
    @CsvSource({",2026", "8,", ","})
    void 缺值時不報這個錯(Integer month, Integer year) {
        var card = new CardPayment("4242424242424242", month, year, "123", "WANG");
        assertThat(validator.isValid(card, mockContext())).isTrue();
    }

    @Test
    void 月份超出範圍時不報這個錯() {
        // 交給 @Min/@Max 報，避免同一個問題出現兩個錯誤
        var card = new CardPayment("4242424242424242", 13, 2026, "123", "WANG");
        assertThat(validator.isValid(card, mockContext())).isTrue();
    }
}
```

**兩個設計決策值得強調：**

**① 「月份超出範圍時不報錯」很重要。**
如果 `expiryMonth = 13`，`YearMonth.of(2026, 13)` 會拋 `DateTimeException` → 
驗證器拋例外 → **`ValidationException` → 500**。

而且即使不拋例外，同一個問題出現兩個錯誤（`@Max(12)` 和 `@ValidCardExpiry`）
對前端是噪音。

> **通用原則：類別層級驗證器要假設「欄位層級的驗證可能失敗」，
> 遇到明顯無效的值就回 `true`（不報錯），讓欄位層級的約束去報。**

**② 用注入的 `Clock` 而不是 `YearMonth.now()`。**
沒有它就無法寫「2026-08 時當月有效」這種測試 —— 
只能寫「明年一定有效」這種會隨時間腐化的測試。

</details>

### 練習 3：設計三階段驗證

需求：`POST /orders/{orderId}/returns`（申請退貨）

```jsonc
{
  "items": [ { "orderItemId": "oi_1", "quantity": 1, "reason": "DEFECTIVE" } ],
  "description": "耳機左邊沒聲音",
  "photoIds": ["img_1", "img_2"],
  "refundMethod": "ORIGINAL_PAYMENT"
}
```

業務規則（共 9 條）：
1. 至少一項商品。
2. 每項數量 ≥ 1。
3. `reason` 是列舉（`DEFECTIVE` / `WRONG_ITEM` / `NOT_AS_DESCRIBED` / `CHANGED_MIND`）。
4. `reason = DEFECTIVE` 時 `description` 必填且 ≥ 10 字，且至少一張照片。
5. `orderItemId` 必須屬於這張訂單。
6. 退貨數量不可超過該項的**已出貨數量減已退貨數量**。
7. 訂單狀態必須是 `COMPLETED`。
8. 距收貨日不可超過 7 天。
9. `refundMethod = ORIGINAL_PAYMENT` 時，原付款必須還可退款（超過 180 天信用卡無法退）。

請把 9 條規則分配到三個階段，並寫出階段 1 的完整 DTO。

<details>
<summary>解答</summary>

**階段分配**

| # | 規則 | 階段 | 實作 | 失敗回應 |
|---|---|---|---|---|
| 1 | 至少一項商品 | **1** | `@NotEmpty` | 422 `VALIDATION_FAILED` |
| 2 | 數量 ≥ 1 | **1** | `@Min(1) @Max(999)` | 422 `VALIDATION_FAILED` |
| 3 | `reason` 是列舉 | **1** | `@Pattern` + Service 轉 enum（1.9.2） | 422 `VALIDATION_FAILED` |
| 4 | `DEFECTIVE` 要有描述與照片 | **1** | 類別層級驗證器（跨欄位，不需 I/O） | 422 `VALIDATION_FAILED` |
| 5 | `orderItemId` 屬於這張訂單 | **2** | Service 查明細 | 422 `RETURN_ITEM_NOT_IN_ORDER` |
| 6 | 數量 ≤ 已出貨 − 已退貨 | **2** | Service 計算 | 422 `RETURN_QUANTITY_EXCEEDED` |
| 7 | 訂單狀態是 `COMPLETED` | **3** | Service 在交易內查狀態 | 409 `ORDER_NOT_RETURNABLE` |
| 8 | 7 天內 | **3** | Service 比對收貨日 | 409 `ORDER_NOT_RETURNABLE`（帶 `returnableUntil`） |
| 9 | 原付款可退款 | **3** | Service 查付款 + 呼叫金流商 | 409 `PAYMENT_NOT_REFUNDABLE` |

**兩個容易分錯的**：

- **規則 4 是階段 1**，雖然它跨了三個欄位。判準是「需要 I/O 嗎」（0.7 問題 3）——
  `reason`、`description`、`photoIds` 都在同一個請求裡，不需要查資料庫。
- **規則 8（7 天內）是階段 3 不是階段 1**。雖然「日期比較」聽起來很像格式驗證，
  但**收貨日在資料庫裡**，客戶端沒送。

**階段 1 的完整實作**

```java
package example.shop.order.web.dto;

import example.shop.common.validation.ResourceId;
import example.shop.common.validation.TextLength;
import example.shop.common.validation.ValidReturnRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

import java.util.List;
import java.util.Locale;

@ValidReturnRequest
public record CreateReturnRequest(

    @NotEmpty(message = "{example.shop.validation.return.itemsRequired}")
    @Size(max = 50, message = "{example.shop.validation.return.tooManyItems}")
    List<@Valid Item> items,

    @TextLength(max = 1000)
    String description,

    @Size(max = 10, message = "{example.shop.validation.return.tooManyPhotos}")
    List<@NotBlank @ResourceId String> photoIds,

    @NotBlank(message = "{example.shop.validation.return.refundMethodRequired}")
    @Pattern(regexp = "^(ORIGINAL_PAYMENT|STORE_CREDIT|BANK_TRANSFER)$",
             message = "{example.shop.validation.return.refundMethodInvalid}")
    String refundMethod

) {
    /** 需要描述與照片的退貨原因。 */
    public static final java.util.Set<String> REASONS_REQUIRING_EVIDENCE =
            java.util.Set.of("DEFECTIVE", "WRONG_ITEM", "NOT_AS_DESCRIBED");

    public CreateReturnRequest {
        items        = (items == null) ? List.of() : List.copyOf(items);
        photoIds     = (photoIds == null) ? List.of() : List.copyOf(photoIds);
        description  = trimToNull(description);
        refundMethod = (refundMethod == null) ? null
                : refundMethod.trim().toUpperCase(Locale.ROOT);
    }

    /** 同一項訂單明細不可重複申請（前端 bug 防護）。 */
    @AssertTrue(message = "{example.shop.validation.return.duplicateItem}")
    public boolean isItemsUnique() {
        long distinct = items.stream().map(Item::orderItemId)
                .filter(java.util.Objects::nonNull).distinct().count();
        long total = items.stream().map(Item::orderItemId)
                .filter(java.util.Objects::nonNull).count();
        return distinct == total;
    }

    /** 照片不可重複。 */
    @AssertTrue(message = "{example.shop.validation.return.duplicatePhoto}")
    public boolean isPhotoIdsUnique() {
        return photoIds.size() == photoIds.stream().distinct().count();
    }

    /** 是否有任何一項需要舉證（供類別層級驗證器使用）。 */
    public boolean requiresEvidence() {
        return items.stream()
                .map(Item::reason)
                .filter(java.util.Objects::nonNull)
                .anyMatch(REASONS_REQUIRING_EVIDENCE::contains);
    }

    public record Item(
        @NotBlank @ResourceId String orderItemId,

        @NotNull(message = "{example.shop.validation.return.quantityRequired}")
        @Min(value = 1,   message = "{example.shop.validation.return.quantityRange}")
        @Max(value = 999, message = "{example.shop.validation.return.quantityRange}")
        Integer quantity,

        @NotBlank(message = "{example.shop.validation.return.reasonRequired}")
        @Pattern(regexp = "^(DEFECTIVE|WRONG_ITEM|NOT_AS_DESCRIBED|CHANGED_MIND)$",
                 message = "{example.shop.validation.return.reasonInvalid}")
        String reason
    ) {
        public Item {
            reason = (reason == null) ? null : reason.trim().toUpperCase(Locale.ROOT);
        }
    }

    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.strip();
        return t.isEmpty() ? null : t;
    }
}
```

```java
package example.shop.common.validation;

import example.shop.order.web.dto.CreateReturnRequest;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

/** 規則 4：需要舉證的退貨原因必須有描述（≥ 10 字）與至少一張照片。 */
public class ValidReturnRequestValidator
        implements ConstraintValidator<ValidReturnRequest, CreateReturnRequest> {

    private static final int MIN_DESCRIPTION_LENGTH = 10;

    @Override
    public boolean isValid(CreateReturnRequest r, ConstraintValidatorContext ctx) {
        if (r == null || !r.requiresEvidence()) return true;

        ctx.disableDefaultConstraintViolation();
        boolean valid = true;

        String desc = r.description();
        int length = (desc == null) ? 0 : desc.codePointCount(0, desc.length());
        if (length < MIN_DESCRIPTION_LENGTH) {
            ctx.buildConstraintViolationWithTemplate(
                       "{example.shop.validation.return.descriptionRequired}")
               .addPropertyNode("description")
               .addConstraintViolation();
            valid = false;
        }
        if (r.photoIds().isEmpty()) {
            ctx.buildConstraintViolationWithTemplate(
                       "{example.shop.validation.return.photoRequired}")
               .addPropertyNode("photoIds")
               .addConstraintViolation();
            valid = false;
        }
        return valid;
    }
}
```

**Service 介面（階段 2、3 的契約）**

```java
public interface ReturnService {
    /**
     * 申請退貨。
     *
     * <p>階段 2（語意）：
     * <ul>
     *   <li>{@code orderItemId} 必須屬於這張訂單 → {@link ReturnItemNotInOrderException}</li>
     *   <li>退貨量 ≤ 已出貨 − 已退貨 → {@link ReturnQuantityExceededException}</li>
     *   <li>{@code photoIds} 必須是這位使用者上傳的 → {@link PhotoNotFoundException}</li>
     * </ul>
     *
     * <p>階段 3（狀態，交易內）：
     * <ul>
     *   <li>訂單狀態必須是 COMPLETED → {@link OrderNotReturnableException}</li>
     *   <li>距收貨日 ≤ 7 天 → {@link OrderNotReturnableException}（帶 returnableUntil）</li>
     *   <li>原付款可退款 → {@link PaymentNotRefundableException}</li>
     * </ul>
     */
    ReturnRequest create(CreateReturnCommand command);
}
```

**⚠️ 我在階段 2 多加了一條規則**：`photoIds` 必須是這位使用者上傳的。
原需求沒寫，但不檢查的話：攻擊者可以猜別人的 `photoId` 塞進自己的退貨申請
（讀取別人的照片）—— **這是 IDOR**。

**這就是「把規則分階段」的附加價值**：
逐條寫下「這條規則需要查什麼」時，會發現需求漏掉的檢查。

**錯誤碼新增清單**（對照 03-rest-api 第 04 章的錯誤目錄）：

| `code` | 狀態碼 | 擴充欄位 |
|---|---|---|
| `RETURN_ITEM_NOT_IN_ORDER` | 422 | `orderItemId`, `orderNumber` |
| `RETURN_QUANTITY_EXCEEDED` | 422 | `orderItemId`, `shipped`, `alreadyReturned`, `requested` |
| `ORDER_NOT_RETURNABLE` | 409 | `orderNumber`, `currentStatus`, `returnableUntil` |
| `PAYMENT_NOT_REFUNDABLE` | 409 | `paymentStatus`, `refundableUntil`, `alternativeAction` |
| `PHOTO_NOT_FOUND` | 422 | `photoId` |

</details>

### 練習 4：這 6 段驗證程式碼各有什麼問題？

```java
// (1)
@NotNull @Size(min = 8) String password;

// (2)
@Pattern(regexp = "^([a-zA-Z0-9]+)+$") String username;

// (3)
@Size(max = 20, message = "「${validatedValue}」太長了") String nickname;

// (4)
public class UniqueEmailValidator implements ConstraintValidator<UniqueEmail, String> {
    @Autowired UserRepository users;
    public boolean isValid(String v, ConstraintValidatorContext c) {
        return v == null || !users.existsByEmail(v);
    }
}

// (5)
@Min(0) @Max(100) double discountRate;

// (6)
public record UpdateProfileRequest(
    @NotBlank String name,
    @NotBlank String phone
) {}
// 用於 PATCH /me
```

<details>
<summary>解答</summary>

**(1) 兩個問題**

| 問題 | 說明 |
|---|---|
| **沒有 `max`** | `@Size(min = 8)` 允許 1 MB 的密碼。bcrypt 對超長輸入很慢（而且 bcrypt 只用前 72 bytes，所以超長也沒有安全意義）→ **DoS 向量** |
| **`@NotNull` 而非 `@NotBlank`** | `"        "`（8 個空白）通過 |

```java
@NotBlank
@Size(min = 12, max = 128, message = "{example.shop.validation.auth.passwordLength}")
String password
```

⚠️ **而且 `password` 絕對不能出現在 `rejectedValue`**（2.9.3 已處理）。
另外**不要**用 `@Pattern` 強制「必須有大小寫數字符號」——
NIST SP 800-63B 已經建議放棄組合規則，改用長度 + 洩漏密碼比對。
那個比對需要 I/O，所以在 Service（階段 2）。

**(2) ReDoS**

`^([a-zA-Z0-9]+)+$` 是**教科書級的災難性回溯**（2.4.7）：
外層 `+` 包著內層 `+`。

```
輸入 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" （30 個 a + 一個非法字元）
→ 2³⁰ 種切分 → 卡住數十秒
```

```java
// ✅ 不需要分組
@NotBlank @Size(min = 3, max = 32)
@Pattern(regexp = "^[a-zA-Z0-9_]{3,32}$")
String username
```

**(3) EL 注入 + XSS**

`${validatedValue}` 會走 Jakarta EL 求值（2.8.4）。
即使 HV 6.2+ 限制了功能等級，**回顯使用者輸入到 `message` 本身就是問題**
（前端若用 `innerHTML` 渲染就是 XSS）。

```java
// ✅ 訊息固定，值放 rejectedValue
@Size(max = 20, message = "{example.shop.validation.user.nicknameTooLong}")
String nickname
```

**(4) 五個問題（2.7.5）**

最重要的是 **TOCTOU** —— 驗證在交易外，無法保證唯一性。
兩個並行的註冊請求都會通過驗證，然後其中一個在寫入時撞到 UNIQUE 約束 → 500。

```java
// ✅ 移除這個驗證器；改成
// 1. Service 在交易內做「友善的預先檢查」（給好訊息）
// 2. 資料庫 UNIQUE 約束當真相
// 3. catch DataIntegrityViolationException → 409 EMAIL_ALREADY_REGISTERED
```

⚠️ **註冊端點還有一個安全考量**：
「這個 Email 已被註冊」是**帳號枚舉漏洞**。
攻擊者可以用它列舉哪些 Email 有帳號。
安全的做法是「一律回 202 並寄信」（有帳號寄「有人試圖註冊」，沒帳號寄驗證信）。
這是 09-spring-security 的主題。

**(5) `@Min` / `@Max` 不支援 `double`**

```
jakarta.validation.UnexpectedTypeException: HV000030: No validator could be found
for constraint 'jakarta.validation.constraints.Min' validating type 'double'
```

⚠️ **這個例外在第一次驗證時才拋** —— 端點看起來好的，直到有請求打進來才 500。

而且**折扣率用 `double` 本身就是 bug**：`0.1 + 0.2 != 0.3`。

```java
// ✅
@NotNull
@DecimalMin(value = "0.00") @DecimalMax(value = "100.00")
@Digits(integer = 3, fraction = 2)
BigDecimal discountRate
```

**(6) `PATCH` 用了 `@NotBlank`**

`PATCH /me` 只想改 `name` 時，`phone` 是缺欄位 → `null` → **`@NotBlank` 失敗** → 422。
**使用者無法只改一個欄位。**

```java
// ✅ PATCH 用 JsonNullable + 不要 @NotBlank
public record UpdateProfileRequest(
    JsonNullable<@NotBlank @TextLength(max = 30) String> name,
    JsonNullable<@Pattern(regexp = "^09\\d{8}$") String> phone
) {
    public UpdateProfileRequest {
        name  = (name == null) ? JsonNullable.undefined() : name;
        phone = (phone == null) ? JsonNullable.undefined() : phone;
    }

    @AssertTrue(message = "{example.shop.validation.order.atLeastOneField}")
    public boolean isAtLeastOneFieldPresent() {
        return name.isPresent() || phone.isPresent();
    }
}
```

⚠️ **注意 `JsonNullable<@NotBlank String> name` 的語意**：
`@NotBlank` 在容器元素上 → 只有「有送值」時才檢查。
所以「不送」合法，「送 `""`」被拒 —— 這正是我們要的。

但「送 `null`（清空姓名）」呢？`@NotBlank` 對 `null` 是失敗的，
所以清空姓名會被拒 —— **這也正確**（姓名不該能清空）。

如果某個欄位**可以**清空（例如 `line2`），就不要加 `@NotBlank`：

```java
JsonNullable<@TextLength(max = 100) String> line2      // 可清空
```

**三態語意 × Bean Validation 的組合是一張需要想清楚的表**：

| 宣告 | 不送 | 送 `null` | 送 `""` | 送 `"值"` |
|---|---|---|---|---|
| `JsonNullable<@NotBlank String>` | ✅ 不改 | ❌ 拒絕 | ❌ 拒絕 | ✅ 設定 |
| `JsonNullable<@Size(max=100) String>` | ✅ 不改 | ✅ 清空 | ✅ 設成空字串 ⚠️ | ✅ 設定 |

⚠️ 第二列的「送 `""`」值得注意：它會設成空字串而不是 `null`。
若不想要這個狀態，在 compact constructor 正規化：

```java
line2 = normalizeEmptyToNull(line2);

private static JsonNullable<String> normalizeEmptyToNull(JsonNullable<String> v) {
    if (v == null) return JsonNullable.undefined();
    if (!v.isPresent()) return v;
    String s = v.get();
    if (s == null) return v;
    String t = s.strip();
    return JsonNullable.of(t.isEmpty() ? null : t);
}
```

</details>

---

## 2.16 驗收清單

- [ ] 我能說出「數值沒有上限」如何造成鎖競爭與全站下單失敗。
- [ ] 我知道「字串沒有長度上限」會造成靜默截斷或磁碟耗盡。
- [ ] 我知道 `@Email` 接受 `a@b`，也知道正確的三層做法（`@Size` + 自訂 `regexp` + 寄信驗證）。
- [ ] 我把驗證當成資源保護與攻擊面收斂，而不是 UX 功能。
- [ ] 我知道 `spring-boot-starter-validation` 沒加時驗證會**靜默失效**，也會用 `dependency:tree` 檢查。
- [ ] 我知道 `tomcat-embed-el` 是必要的，缺了會在第一次驗證失敗時拋 `HV000183`。
- [ ] 我能說出三條驗證觸發路徑，以及它們各自拋什麼例外。
- [ ] 我知道 Spring 6.1 起方法參數驗證是內建的（400），而類別上的 `@Validated` 會讓它退回 AOP 路徑（500）。
- [ ] 我知道 `@Valid` 支援巢狀但不支援群組，`@Validated` 反之。
- [ ] **我能背出「除了 `@NotNull` / `@NotEmpty` / `@NotBlank`，所有約束都認為 `null` 合法」。**
- [ ] 我知道 `@NotEmpty` 對 `"  "` 是通過的，字串一律用 `@NotBlank`。
- [ ] 我知道 `@NotBlank` 放在 `List` 上會拋 `UnexpectedTypeException`，而且是在執行時才拋。
- [ ] 我知道 `@Min` / `@Max` 不支援 `float` / `double`，也知道這是金額不能用 `double` 的另一個理由。
- [ ] 我知道 `@Digits` 的必要性（沒有它金額精度會靜默不一致）。
- [ ] 我知道 `@Size` 數的是 UTF-16 code unit，emoji 會被誤判，也知道 `@TextLength` 的做法。
- [ ] 我知道自訂約束的 `@Target` 要包含 `RECORD_COMPONENT`，而**理由是「反射掃描讀得到」而不是「不然編譯不過」**（2.7.1）。
- [ ] 我知道 `@Past` / `@Future` 的時區坑（每天有 8 小時窗口會誤判）。
- [ ] 我能識別 ReDoS 的危險模式（巢狀量詞），也會寫一個計時測試守住它。
- [ ] 我知道 `@Size` 和 `@Pattern` 之間**沒有**執行順序保證，要順序得用 `@GroupSequence`。
- [ ] 我知道巢狀驗證每一層都要標 `@Valid`，漏一層就整層不驗。
- [ ] 我會用容器元素約束（`List<@NotBlank String>`、`JsonNullable<@Size String>`），也知道它會靜默失效所以一定要測。
- [ ] 我知道「集合長度」與「元素驗證」都會執行，沒有短路，所以要有 body 大小上限與錯誤數量上限。
- [ ] 我知道錯誤回應要帶 `errorCount` 與 `errorsTruncated`，不能靜默截斷。
- [ ] 我知道驗證群組的三個陷阱，尤其是「沒標群組的約束屬於 `Default`，指定群組時不執行」。
- [ ] 我知道巢狀驗證的群組要用 `@ConvertGroup` 明確傳遞。
- [ ] 我理解 shop-service 為什麼選「兩個 DTO」而不是驗證群組（失敗模式的嚴重性差距）。
- [ ] 我能寫出自訂約束（註解 + `ConstraintValidator`），並知道四個必要元素。
- [ ] 我能用 `disableDefaultConstraintViolation()` + `addPropertyNode()` 讓類別層級驗證定位到欄位。
- [ ] 我知道類別層級驗證器要「遇到明顯無效的值就回 `true`」，避免拋例外與重複錯誤。
- [ ] **我知道不該在 `ConstraintValidator` 裡注入 Repository，並能說出 TOCTOU 這個根本理由。**
- [ ] 我知道注入「設定」是可以的，判準是「會不會發 I/O」。
- [ ] 我會用組合約束 + `@ReportAsSingleViolation`，也知道它不該用在使用者實際會填的欄位。
- [ ] 我知道要用 `setValidationMessageSource` 才能讓驗證訊息走 Spring 的 `MessageSource`。
- [ ] 我知道 `fallback-to-system-locale: false` 是必要的，否則容器上會變英文。
- [ ] 我會覆寫 Hibernate Validator 的內建訊息當安全網。
- [ ] **我知道 `${validatedValue}` 有 EL 注入與 XSS 風險，使用者輸入該放 `rejectedValue`。**
- [ ] 我會用 `addMessageParameter` 而不是把文字插進 template。
- [ ] 我知道 `isBindingFailure()` 區分「型別轉換失敗」與「約束違反」，且前者的訊息不能回傳。
- [ ] 我知道 `errors[]` 要遮蔽敏感欄位、截斷超長值、不回顯集合內容、依 `field` 排序。
- [ ] 我知道 `ConstraintViolationException` 的 `propertyPath` 需要正規化（去掉 `方法名.arg0`）。
- [ ] 我能說出三階段驗證的分工，以及「便宜的驗證放在便宜的地方」。
- [ ] 我知道階段 2 / 3 的錯誤也要能填進 `errors[]`，`field` 格式要與階段 1 一致。
- [ ] 我知道「body 裡的 ID 不存在」是 422 不是 404。
- [ ] 我能建立四層 DoS 防護，並知道 `Content-Length` 不可信（chunked transfer）。
- [ ] 我知道 Jackson 2.15 的 `StreamReadConstraints`，也知道預設值太寬鬆。
- [ ] 我知道 `StackOverflowError` 是 `Error`，`catch (Exception)` 抓不到。
- [ ] 我會用 `@Validated @ConfigurationProperties` 讓錯誤設定在啟動時失敗，且限制值本身也有上限。
- [ ] 我知道 `@LuhnCheck` 是 Hibernate Validator 內建的，也知道卡號絕不能進 log。
- [ ] 我知道 `returnUrl` / `imageUrl` 這類欄位要用 `URI.getHost()` 比對白名單，不能用 `startsWith`。
- [ ] 我知道「更好的設計是不接受 URL，改成接受上傳後的 ID」。
- [ ] 我能不啟動 Spring 就測 DTO 驗證，而且會成對測邊界值。
- [ ] 我知道 `@AssertTrue` 的 `field` 是屬性名，並有一個一致的處理方式（轉成全域錯誤）。
- [ ] 我會寫「驗證覆蓋率」的反射測試，抓「新增欄位忘了加驗證」。
- [ ] 我會測「訊息有沒有被解析」（不含 `{`、不是英文預設值）。
- [ ] 我知道 80% 的驗證測試該在「純 Validator」那一層。

---

## 2.17 下一章預告

現在驗證會失敗了，但**失敗的回應還是 Spring 的預設格式**：

```json
{
  "timestamp": "2026-08-20T06:12:44.123+00:00",
  "status": 400,
  "error": "Bad Request",
  "path": "/orders"
}
```

沒有 `code`、沒有 `errors[]`、沒有 `traceId`、沒有 `userMessage`，
而且狀態碼是 400 不是 422。

**03 章要把 03-rest-api 第 04 章的錯誤目錄（約 60 個 `code`）全部落地。** 內容包括：

- `@RestControllerAdvice` 的完整結構，以及它和 `ResponseEntityExceptionHandler` 的關係。
- 用 enum 當**錯誤碼註冊表**，把 `code → 狀態碼 / type / retryable / i18n key` 綁在一起。
- 領域例外的分層設計，以及「Service 拋什麼、Web 層怎麼翻譯」。
- 本章三種驗證例外 + Spring 內建的 15 種例外的完整處理。
- `ProblemDetail`（Spring 6 內建）vs 自己的 record：怎麼選。
- **Filter 層的例外**（不會進 advice）與 **Security 的 401 / 403** 怎麼統一格式。
- 5xx 的 `detail` 為什麼必須是固定文字，以及怎麼防止 stack trace 洩漏。
- 錯誤日誌的分級（4xx 用 `warn` 不印 stack trace、5xx 用 `error`）與指標。
- 一個 advice、70 條端點、零個 try-catch 的完整證明。

---

完成後請前往 [03-global-exception-handling.md](./03-global-exception-handling.md)。
