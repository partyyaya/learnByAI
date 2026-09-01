# 第 04 章：錯誤設計與 Problem Details

> 成功路徑只有一條，錯誤路徑有幾十條。
> 而你會花掉 80% 的除錯時間在錯誤路徑上 —— 不只是你，還有前端、客服、廠商、值班工程師。
> 這一章的目標很具體：**讓一個錯誤回應能在 30 秒內告訴你「誰的錯、哪裡錯、怎麼修、能不能重試、怎麼追」**。
> 做到這件事，你的系統的除錯成本會下降一個量級。

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出一個糟糕的錯誤回應如何浪費你一整天，並列出五種常見的糟糕格式。
- 說出錯誤回應必須回答的五個問題，並用它們檢核任何錯誤格式。
- 完整實作 RFC 9457 Problem Details，包含 `type` URI 的設計原則與擴充欄位。
- 設計業務錯誤碼系統：命名規則、註冊表、與 HTTP 狀態碼的對映。
- 設計驗證錯誤格式：多錯一次回、定位到欄位、處理巢狀與陣列索引。
- 區分「給人看」「給程式看」「給開發者看」三種訊息，並知道安全邊界在哪。
- 把 `traceId` 串起 API 回應、日誌、客服流程。
- 設計重試語意：`Retry-After`、`retryable` 旗標、指數退避的前提。
- 處理批次操作的部分成功。
- 說明為什麼「把系統錯誤標成 4xx」會讓告警失效。
- 完成 shop-service 的錯誤目錄（error catalog），並寫出前端消費它的程式碼。

---

## 4.2 一個糟糕的錯誤回應如何浪費你一整天

### 4.2.1 真實的一天

```
09:14  客服轉來訊息：「客戶說結帳一直失敗，訂單編號他也沒有。」
09:15  你問：「錯誤訊息是什麼？」
09:22  客服回：「客戶說只有『系統錯誤，請稍後再試』。」
09:23  你打開監控。錯誤率 0%（因為全部回 200）。
09:35  你請客服問客戶的手機號碼，用它在資料庫找使用者。
09:52  找到了。翻應用程式日誌，時間範圍不確定（客戶說「早上」）。
10:30  日誌有 4 萬行。grep 使用者 ID —— 沒有，因為日誌沒印使用者 ID。
11:15  改用 grep 錯誤堆疊。找到 200 個 NullPointerException，不知道哪一個是。
13:40  請客戶再試一次，你在旁邊看即時日誌。
13:52  客戶說「這次成功了」。
14:30  你放棄，把工單標記為「無法重現」。
16:20  同樣的問題又來了三張工單。
```

**同樣的問題，如果錯誤設計對了：**

```
09:14  客服轉來訊息，附上客戶截圖：
       「您的信用卡被發卡銀行拒絕（餘額不足）。
         代碼：CARD_DECLINED / 追蹤碼：4f2c8a1e9b7d3f60」
09:15  你貼 traceId 進日誌系統，一秒找到完整請求鏈路。
09:16  確認是銀行拒絕，不是系統問題。
09:17  回覆客服：請客戶換卡或聯絡銀行。
09:18  順手查監控：CARD_DECLINED 今天 47 次，其中 31 次是 insufficient_funds。
       正常範圍。結案。
```

**4 分鐘 vs 一整天。差別全部在錯誤回應的設計。**

### 4.2.2 五種糟糕的格式

**格式 1：資訊量為零**

```jsonc
{ "code": -1, "msg": "error" }
{ "success": false }
{ "error": "系統錯誤" }
```

無法判斷誰的錯、無法定位、無法追蹤、無法決定要不要重試。

**格式 2：狀態碼永遠 200**

第 02 章 2.12 已詳述五個損失。這裡強調對**除錯**的傷害：
你無法從 `access.log` 篩出錯誤請求，因為每一行都是 `200`。

**格式 3：HTML 錯誤頁**

```html
HTTP/1.1 500
Content-Type: text/html

<!DOCTYPE html><html><head><title>HTTP Status 500 – Internal Server Error</title>...
```

前端 `res.json()` 直接拋 `SyntaxError: Unexpected token '<'`，
把「後端錯誤」變成「前端錯誤」，除錯線索完全斷掉。

**這是 Spring Boot 的預設行為**（`BasicErrorController` 會依 `Accept` 回 HTML 或 JSON），
如果客戶端沒送 `Accept: application/json`，就會拿到 HTML。
**要明確處理。**

**格式 4：Stack trace 外洩**

```jsonc
{
  "timestamp": "2026-08-19T06:12:44.123+00:00",
  "status": 500,
  "error": "Internal Server Error",
  "trace": "org.springframework.dao.DataIntegrityViolationException: could not execute statement; SQL [insert into t_order_master (customer_id, coupon_id, ...) values (?, ?, ...)]; constraint [uk_order_no]\n\tat org.hibernate...",
  "message": "could not execute statement",
  "path": "/orders"
}
```

洩漏了：資料表名稱（`t_order_master`）、欄位名稱、約束名稱（`uk_order_no`）、
框架版本、完整套件結構。**這些全部是攻擊者需要的偵查資訊。**

```yaml
# 一定要設（Spring Boot 3 的預設已經是 never，但要確認）
server:
  error:
    include-stacktrace: never
    include-message: never       # ⚠️ 見 4.7.3
    include-binding-errors: never
    include-exception: false
```

**格式 5：訊息把責任推給使用者**

```jsonc
{ "message": "參數錯誤" }
{ "message": "操作失敗" }
{ "message": "資料異常，請聯絡系統管理員" }
```

「參數錯誤」—— 哪個參數？錯在哪？該填什麼？
使用者只能亂試，或直接放棄（然後你少一筆訂單）。

---

## 4.3 錯誤回應要回答的五個問題

**這是本章的核心框架。** 任何錯誤回應都用這五個問題檢核：

| # | 問題 | 由誰回答 | 例子 |
|---|---|---|---|
| 1 | **是誰的錯？** | HTTP 狀態碼類別（4xx / 5xx） | `409` = 你的請求和現狀衝突 |
| 2 | **哪裡錯？** | `errors[].field` / `instance` / 擴充欄位 | `items[2].quantity` |
| 3 | **為什麼？** | `code`（機器）+ `detail`（開發者）+ `userMessage`（使用者） | `INSUFFICIENT_STOCK` |
| 4 | **怎麼修？** | `userMessage` + 擴充欄位（`available: 3`） | 「僅剩 3 件，是否改為 3 件？」 |
| 5 | **能重試嗎？** | `retryable` + `Retry-After` | `retryable: false` |
| 6 | **怎麼追？** | `traceId` | `4f2c8a1e9b7d3f60` |

（是六個，但第 5 和第 6 常被合稱為「可操作性」。）

**一個完整回答全部問題的錯誤回應**：

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
Cache-Control: no-store

{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "detail": "Product P-1001 has 3 units available but 5 were requested in items[2].",
  "instance": "/orders",
  "code": "INSUFFICIENT_STOCK",
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。",
  "errors": [
    { "field": "items[2].quantity", "code": "INSUFFICIENT_STOCK",
      "message": "僅剩 3 件", "rejectedValue": 5 }
  ],
  "productId": "P-1001",
  "productName": "無線降噪耳機 Pro",
  "requested": 5,
  "available": 3,
  "restockEstimatedAt": "2026-08-22",
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

**逐欄位對應五個問題**：

```
是誰的錯？   → 409（4xx = 你的請求問題）
哪裡錯？     → errors[0].field = "items[2].quantity"
為什麼？     → code = INSUFFICIENT_STOCK / detail（給開發者的英文說明）
怎麼修？     → userMessage（給使用者的中文行動指示）+ available: 3
能重試嗎？   → retryable: false（改數量才有用，重試無效）
怎麼追？     → traceId
```

**前端可以直接用這份資料做出好的 UI**：

```typescript
// 不需要任何硬編碼的錯誤處理邏輯
if (problem.code === 'INSUFFICIENT_STOCK') {
  showDialog({
    message: problem.userMessage,
    primaryAction: {
      label: `改為 ${problem.available} 件`,
      onClick: () => updateQuantity(problem.productId, problem.available),
    },
    secondaryAction: { label: '移除此商品', onClick: () => remove(problem.productId) },
    footer: problem.restockEstimatedAt
      ? `預計 ${problem.restockEstimatedAt} 補貨` : undefined,
  });
}
```

**對照一下 `{"code":-1,"msg":"error"}` 能做出什麼 UI**：一個「失敗」的 toast。

---

## 4.4 RFC 9457 Problem Details

### 4.4.1 它是什麼

**RFC 9457「Problem Details for HTTP APIs」**（2023 年 7 月發布，
取代 2016 年的 RFC 7807）是**HTTP 錯誤回應的標準格式**。

**為什麼要用標準而不是自己發明**：

| 好處 | 說明 |
|---|---|
| Spring 原生支援 | Spring Framework 6 / Boot 3 有 `ProblemDetail` 類別、`ErrorResponse` 介面 |
| 工具支援 | OpenAPI 有標準 schema；一些 client 產生器認得它 |
| 跨團隊／跨語言一致 | 新人不用學你們公司的私有格式 |
| `Content-Type` 自我描述 | `application/problem+json` 讓中介元件知道「這是錯誤」（第 00 章 0.4.2 子約束 4c） |
| 可擴充 | 標準只定 5 個欄位，其他你自由加 |

### 4.4.2 五個標準欄位

```jsonc
{
  "type":     "https://api.shop.example/problems/insufficient-stock",
  "title":    "庫存不足",
  "status":   409,
  "detail":   "Product P-1001 has 3 units available but 5 were requested.",
  "instance": "/orders"
}
```

| 欄位 | 型別 | 語意 | 必填？ |
|---|---|---|---|
| `type` | URI | **錯誤類型**的識別碼。同一種問題永遠同一個 `type` | 建議（預設 `"about:blank"`） |
| `title` | string | 人類可讀的**類型摘要**。同一個 `type` 的 `title` 應該固定 | 建議 |
| `status` | integer | HTTP 狀態碼（和實際回應的必須一致） | 建議 |
| `detail` | string | 這**一次**發生的具體說明 | 選填 |
| `instance` | URI | 這**一次**發生的識別（通常是請求路徑或事件 ID） | 選填 |

**`title` vs `detail` 的關鍵區別**（最常搞錯）：

```
title  = 類型層級，固定不變     → 「庫存不足」
detail = 實例層級，每次不同     → 「商品 P-1001 只剩 3 件，但要求 5 件」
```

**判準：`title` 應該可以拿去當「錯誤類型」分組統計；`detail` 不行（因為每次都不同）。**

```
❌ 錯誤示範（title 含實例資訊 → 無法分組）
"title": "商品 P-1001 庫存不足（剩 3 件）"

✅ 正確
"title": "庫存不足"
"detail": "Product P-1001 has 3 units available but 5 were requested."
```

### 4.4.3 `type` URI 的設計

**三個常見疑問**：

**疑問 1：`type` 一定要是可以打開的 URL 嗎？**

**不一定。** RFC 說它「應該」（SHOULD）指向人類可讀的文件，但不強制。
不解析時，`type` 就只是一個**唯一識別字串**。

**疑問 2：那要不要真的做一個文件頁面？**

**強烈建議做。** 這是投報率極高的一件事：

```
https://api.shop.example/problems/insufficient-stock
  ↓ 一個靜態頁面，內容：
  - 這個錯誤什麼時候發生
  - 客戶端該怎麼處理
  - 相關的擴充欄位說明
  - 常見原因與排除方式
```

**價值**：第三方廠商遇到錯誤，直接點連結看說明，**不用開工單問你**。
GitHub API 的 `documentation_url` 就是這個概念（第 02 章 2.16 練習 5）。

**疑問 3：`type` 該怎麼命名？**

```
✅ https://api.shop.example/problems/insufficient-stock
✅ https://api.shop.example/problems/order-not-cancellable
✅ urn:problem:shop:insufficient-stock          （URN 也可以，不需要 host）

❌ https://api.shop.example/problems/error       太籠統
❌ https://api.shop.example/problems/409         用狀態碼當類型（失去意義）
❌ /problems/insufficient-stock                  相對 URI（RFC 允許但容易衝突）
```

**四條命名規則**：

| 規則 | 說明 |
|---|---|
| 用 kebab-case | 和 URL 慣例一致 |
| 對應 `code` 欄位 | `INSUFFICIENT_STOCK` ↔ `insufficient-stock`（機械式轉換，好維護） |
| **永不改變** | `type` 是契約。改了等於新增一種錯誤類型 |
| 域名要穩定 | 用你控制的域名，而且不要用會過期的（`api.shop.example` 而不是 `shop-2024-new.example`） |

### 4.4.4 擴充欄位

**RFC 9457 明確允許加任意欄位。** 這是它最實用的地方。

```jsonc
{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "detail": "Product P-1001 has 3 units available but 5 were requested.",
  "instance": "/orders",

  // ── 以下全部是擴充欄位 ──
  "code": "INSUFFICIENT_STOCK",
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件",
  "errors": [ ... ],
  "productId": "P-1001",
  "available": 3,
  "requested": 5,
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

**三條擴充規則**：

| 規則 | 說明 |
|---|---|
| 不要和標準欄位撞名 | 不要自己定義 `type`、`title`、`status`、`detail`、`instance` 的其他語意 |
| **相同 `type` 的擴充欄位要固定** | 客戶端才能安全地讀 `problem.available`（否則要處處判斷有沒有） |
| 在文件裡列出每個 `type` 的擴充欄位 | OpenAPI 用 `oneOf` + `discriminator: code` |

**第二條的實際意義**：

```typescript
// ✅ 契約保證 INSUFFICIENT_STOCK 一定有 available
if (problem.code === 'INSUFFICIENT_STOCK') {
  showDialog(`僅剩 ${problem.available} 件`);   // 不需要 ?? 或 if
}
```

如果 `available` 有時有有時沒有，前端就要寫防禦性程式碼，
而且測試時很難確定「什麼情況下會沒有」。

### 4.4.5 `application/problem+json`

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
```

**為什麼不用 `application/json`**：

| 好處 | 說明 |
|---|---|
| 自我描述 | 中介元件（閘道、監控、日誌）看 `Content-Type` 就知道這是錯誤，不用解析 body |
| 客戶端可以統一處理 | `if (contentType.includes('problem+json')) parseAsProblem(...)` |
| 和成功回應區分 | 成功是 `application/json`，錯誤是 `application/problem+json` |

**⚠️ 一個實務注意點**：某些老舊的客戶端／閘道遇到不認識的 `Content-Type` 會出問題。
如果遇到，可以**同時接受兩種**：

```java
// Spring：ProblemDetail 預設就會用 application/problem+json
// 若需要強制 application/json（相容老客戶端）：
return ResponseEntity.status(409)
        .contentType(MediaType.APPLICATION_JSON)
        .body(problemDetail);
```

**但要注意**：`Accept: application/json` 的請求，Spring 仍然會回 `application/problem+json`
（因為 `problem+json` 是 `json` 的子型別，內容協商會通過）。這是正確行為。

### 4.4.6 Spring Boot 3 的內建支援

```yaml
spring:
  mvc:
    problemdetails:
      enabled: true        # 讓 Spring 內建的例外處理也回 Problem Details
```

**開啟後的效果**：

```http
# 未開啟（Spring Boot 的預設錯誤格式）
GET /orders/nonexistent
→ 404
{
  "timestamp": "2026-08-19T06:12:44.123+00:00",
  "status": 404,
  "error": "Not Found",
  "path": "/orders/nonexistent"
}

# 開啟後
→ 404
Content-Type: application/problem+json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "No static resource orders/nonexistent.",
  "instance": "/orders/nonexistent"
}
```

**但這只是起點。** 預設的 `type: "about:blank"` 和英文 `title` 對使用者沒有價值。
你需要自己的 `RestControllerAdvice`（04-controller 第 03 章會完整實作）。

**`ProblemDetail` 的用法**：

```java
import org.springframework.http.ProblemDetail;

ProblemDetail pd = ProblemDetail.forStatusAndDetail(
        HttpStatus.CONFLICT,
        "Product P-1001 has 3 units available but 5 were requested.");
pd.setType(URI.create("https://api.shop.example/problems/insufficient-stock"));
pd.setTitle("庫存不足");
pd.setInstance(URI.create("/orders"));

// 擴充欄位
pd.setProperty("code", "INSUFFICIENT_STOCK");
pd.setProperty("userMessage", "「無線降噪耳機 Pro」僅剩 3 件");
pd.setProperty("productId", "P-1001");
pd.setProperty("available", 3);
pd.setProperty("requested", 5);
pd.setProperty("retryable", false);
pd.setProperty("traceId", MDC.get("traceId"));

return ResponseEntity.of(pd).build();
```

⚠️ **`ProblemDetail` 的兩個小坑**：

1. `setProperty()` 存進一個 `Map`，序列化時**展平**到頂層（這是我們要的）。
   但如果 key 和標準欄位撞名，行為未定義 —— 不要撞名。
2. `ProblemDetail` 的 `properties` map 在 `null` 時不會建立，
   `getProperties()` 可能回 `null`。取值時要小心。

**更好的做法：自訂型別（shop-service 採用）**

`ProblemDetail` 的 `setProperty()` 是弱型別的（`Object`），
容易打錯 key、沒有 IDE 補全、OpenAPI 描述不出來。

```java
public record ApiProblem(
    URI type,
    String title,
    int status,
    String detail,
    URI instance,
    String code,
    String userMessage,
    List<FieldError> errors,
    Boolean retryable,
    Integer retryAfterSeconds,
    String traceId,
    Instant timestamp,
    @JsonAnyGetter Map<String, Object> extensions    // 型別特有的欄位
) {
    public record FieldError(
        String field,
        String code,
        String message,
        Object rejectedValue
    ) {}
}
```

搭配 builder（04-controller 會完整實作）。

---

## 4.5 業務錯誤碼設計

### 4.5.1 為什麼狀態碼不夠

```http
POST /orders/ord_1/payments
→ 409 Conflict
```

`409` 可能是：

- 訂單已付款
- 訂單狀態不允許付款（已取消）
- 已有進行中的付款
- 庫存在下單後被別人買走
- 折扣碼已被用完

**客戶端要用不同的 UI 處理這五種情況**：

| 原因 | 前端該做什麼 |
|---|---|
| 已付款 | 導向訂單詳情，顯示「已付款」 |
| 已取消 | 顯示「此訂單已取消」+ 導向購物車 |
| 有進行中付款 | 顯示「正在處理付款」+ 輪詢 |
| 庫存被買走 | 顯示「商品缺貨」+ 移除商品的按鈕 |
| 折扣碼用完 | 顯示「折扣碼已失效」+ 移除折扣碼的按鈕 |

**狀態碼給的是「類別」，錯誤碼給的是「具體原因」。** 兩者都需要。

### 4.5.2 命名規則：字串 vs 數字

| | 字串（`INSUFFICIENT_STOCK`） | 數字（`40901`） |
|---|---|---|
| 可讀性 | ★ 自我描述 | 需要對照表 |
| log 除錯 | ★ 直接看得懂 | 要查 |
| 前端程式碼 | `code === 'INSUFFICIENT_STOCK'` ★ 意圖清楚 | `code === 40901` 意圖不明 |
| 新增 | 直接取名 | 要維護編號分配（會撞號） |
| 傳輸大小 | 稍大（幾十 bytes） | 小 |
| 分類 | 靠前綴 | 靠號段 |

**shop-service 選字串**，理由：可讀性的價值遠大於幾十 bytes。

**如果你必須用數字**（公司規範），至少：
- 維護一份**可查詢的對照表端點**：`GET /error-codes`。
- 在錯誤回應裡**同時**給 `code`（數字）和 `codeName`（字串）。

### 4.5.3 命名慣例

```
格式：<領域>_<問題>            或  <問題>
      ORDER_NOT_CANCELLABLE       INSUFFICIENT_STOCK
      PAYMENT_METHOD_UNSUPPORTED  TOKEN_EXPIRED
      COUPON_EXPIRED              VALIDATION_FAILED
```

**五條規則**：

| 規則 | ✅ | ❌ |
|---|---|---|
| `UPPER_SNAKE_CASE` | `INSUFFICIENT_STOCK` | `insufficientStock`、`Insufficient-Stock` |
| 描述**原因**不是**結果** | `COUPON_EXPIRED` | `COUPON_ERROR`、`COUPON_FAILED` |
| 不含狀態碼 | `ORDER_NOT_FOUND` | `ERROR_404_ORDER` |
| 不含實例資訊 | `INSUFFICIENT_STOCK` | `INSUFFICIENT_STOCK_P1001` |
| 領域前綴一致 | `ORDER_*`、`PAYMENT_*`、`COUPON_*` | `ORDER_*` 和 `ORD_*` 混用 |

**「描述原因不是結果」的重要性**：

```
❌ PAYMENT_FAILED        → 前端只能顯示「付款失敗」
✅ CARD_DECLINED         → 「卡片被拒絕，請換卡」
✅ CARD_EXPIRED          → 「卡片已過期，請更新有效期限」
✅ INSUFFICIENT_FUNDS    → 「餘額不足」
✅ CARD_LOST_OR_STOLEN   → 「此卡已掛失，請聯絡發卡行」（⚠️ 見 4.7.4 的安全考量）
✅ FRAUD_SUSPECTED       → ⚠️ 對外要模糊化（不能告訴詐騙者被抓到了）
✅ GATEWAY_TIMEOUT       → 「系統忙碌，請稍後再試」（可重試）
```

一個 `PAYMENT_FAILED` 和七個具體錯誤碼，對使用者體驗的差別是**完成率**。

### 4.5.4 真實案例：付款失敗的 12 種原因

```
── 客戶端問題（不可重試，要改東西）──────────────
CARD_NUMBER_INVALID          卡號格式錯誤            422
CARD_EXPIRED                 卡片已過期              422
CVV_INVALID                  安全碼錯誤              422
BILLING_ADDRESS_MISMATCH     帳單地址不符（AVS 檢查）422

── 銀行拒絕（不可重試，要換卡或找銀行）─────────
INSUFFICIENT_FUNDS           餘額不足                402
CARD_DECLINED_BY_ISSUER      發卡行拒絕（原因不明）  402
CARD_LOST_OR_STOLEN          卡片已掛失              402
EXCEEDS_CREDIT_LIMIT         超過信用額度            402
CARD_NOT_SUPPORTED           不支援此卡種            402

── 需要額外驗證（可繼續流程）───────────────────
THREE_DS_REQUIRED            需要 3D 驗證            202 + nextAction

── 我們的問題（可重試）─────────────────────────
GATEWAY_TIMEOUT              金流商超時              504
GATEWAY_UNAVAILABLE          金流商維護              503 + Retry-After

── 風控（要模糊化，見 4.7.4）───────────────────
PAYMENT_DECLINED             （對外統一訊息）        402
```

**注意最後一組**：詐騙偵測的結果**不能**告訴客戶端真實原因。

```jsonc
// ❌ 洩漏風控邏輯
{ "code": "FRAUD_SUSPECTED", "detail": "IP 位址與帳單地址國家不符，且 24 小時內 5 次失敗" }
// → 詐騙者知道要換 IP、要間隔更久

// ✅ 對外模糊，內部詳細
{
  "code": "PAYMENT_DECLINED",
  "userMessage": "此筆交易無法完成，請聯絡您的發卡銀行或改用其他付款方式。",
  "traceId": "4f2c8a1e9b7d3f60"
}
// 內部日誌：fraud_rule=IP_COUNTRY_MISMATCH,VELOCITY_5_IN_24H score=87 traceId=4f2c...
```

**`traceId` 在這裡的價值**：客服可以用它查到真實原因（如果是誤判就人工放行），
但客戶端拿不到細節。**這是「可追蹤」與「不洩漏」兼得的做法。**

### 4.5.5 錯誤碼註冊表

**錯誤碼必須有單一來源**，否則會出現：
同一個問題兩個碼、同一個碼兩個意思、前端不知道有哪些碼。

**做法 1：Java enum（★ shop-service 採用）**

```java
public enum ErrorCode {

    // ── 驗證 ──────────────────────────────────
    VALIDATION_FAILED(HttpStatus.UNPROCESSABLE_ENTITY, "validation-failed", false),
    MALFORMED_REQUEST(HttpStatus.BAD_REQUEST, "malformed-request", false),

    // ── 認證授權 ──────────────────────────────
    AUTHENTICATION_REQUIRED(HttpStatus.UNAUTHORIZED, "authentication-required", false),
    TOKEN_EXPIRED(HttpStatus.UNAUTHORIZED, "token-expired", false),
    INVALID_TOKEN(HttpStatus.UNAUTHORIZED, "invalid-token", false),
    INSUFFICIENT_ROLE(HttpStatus.FORBIDDEN, "insufficient-role", false),

    // ── 資源 ──────────────────────────────────
    RESOURCE_NOT_FOUND(HttpStatus.NOT_FOUND, "resource-not-found", false),
    RESOURCE_GONE(HttpStatus.GONE, "resource-gone", false),

    // ── 訂單 ──────────────────────────────────
    ORDER_NOT_CANCELLABLE(HttpStatus.CONFLICT, "order-not-cancellable", false),
    ORDER_ALREADY_PAID(HttpStatus.CONFLICT, "order-already-paid", false),
    ORDER_EXPIRED(HttpStatus.CONFLICT, "order-expired", false),

    // ── 庫存 ──────────────────────────────────
    INSUFFICIENT_STOCK(HttpStatus.CONFLICT, "insufficient-stock", false),

    // ── 付款 ──────────────────────────────────
    CARD_DECLINED(HttpStatus.PAYMENT_REQUIRED, "card-declined", false),
    PAYMENT_GATEWAY_TIMEOUT(HttpStatus.GATEWAY_TIMEOUT, "payment-gateway-timeout", true),
    PAYMENT_GATEWAY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "payment-gateway-unavailable", true),

    // ── 併發 ──────────────────────────────────
    OPTIMISTIC_LOCK_CONFLICT(HttpStatus.PRECONDITION_FAILED, "version-conflict", true),
    IF_MATCH_REQUIRED(HttpStatus.PRECONDITION_REQUIRED, "if-match-required", false),

    // ── 限流 ──────────────────────────────────
    RATE_LIMIT_EXCEEDED(HttpStatus.TOO_MANY_REQUESTS, "rate-limit-exceeded", true),

    // ── 系統 ──────────────────────────────────
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "internal-error", false),
    SERVICE_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "service-unavailable", true),
    UPSTREAM_ERROR(HttpStatus.BAD_GATEWAY, "upstream-error", true);

    private static final String TYPE_BASE = "https://api.shop.example/problems/";

    private final HttpStatus status;
    private final String typeSlug;
    private final boolean retryable;

    ErrorCode(HttpStatus status, String typeSlug, boolean retryable) {
        this.status = status;
        this.typeSlug = typeSlug;
        this.retryable = retryable;
    }

    public HttpStatus status()   { return status; }
    public boolean retryable()   { return retryable; }
    public URI type()            { return URI.create(TYPE_BASE + typeSlug); }
    /** i18n 的 message key：error.insufficient-stock.title / .user-message */
    public String messageKey()   { return "error." + typeSlug; }
}
```

**這個 enum 一次解決五件事**：

| 解決 | 怎麼做到 |
|---|---|
| 錯誤碼的單一來源 | 全部在一個檔案，不可能重複 |
| **`code` → 狀態碼的對映** | 不會出現「同一個錯誤在兩個地方回不同狀態碼」 |
| `code` → `type` URI | 機械式產生，永不打錯 |
| `code` → `retryable` | 客戶端的重試決策由後端定義 |
| `code` → i18n key | `title` 和 `userMessage` 都從 `messages.properties` 來 |

**做法 2：YAML 註冊表（適合非工程師也要維護時）**

```yaml
# error-catalog.yml
errors:
  INSUFFICIENT_STOCK:
    status: 409
    type: insufficient-stock
    retryable: false
    title:
      zh-TW: 庫存不足
      en: Insufficient stock
    userMessage:
      zh-TW: "「{productName}」僅剩 {available} 件，請調整數量。"
      en: "Only {available} units of \"{productName}\" remain."
    extensions: [productId, productName, requested, available, restockEstimatedAt]
    docs: |
      商品庫存不足時回傳。客戶端應顯示 available 並提供「調整為 N 件」的操作。
```

好處：可以自動產生**文件頁面**（4.4.3 的 `type` URI 目標頁）、
可以讓 PM／客服直接編輯 `userMessage`、可以驗證「每個 code 都有 i18n」。

### 4.5.6 對外碼與內部碼要分開

```
內部（日誌、監控）：
  fraud_rule=IP_COUNTRY_MISMATCH,VELOCITY_5_IN_24H
  db_constraint=uk_order_no
  upstream=newebpay error_code=10100073

對外（API 回應）：
  code=PAYMENT_DECLINED
  code=ORDER_NUMBER_CONFLICT
  code=PAYMENT_GATEWAY_ERROR
```

**規則：對外碼是「客戶端需要區別的最小集合」，不是「你系統內部所有錯誤的列舉」。**

如果你有 200 種內部錯誤，但客戶端只需要用 20 種不同方式處理，
那就只暴露 20 個對外碼。**多的只會讓客戶端無法窮舉處理。**

---

## 4.6 驗證錯誤格式

驗證錯誤是**最高頻**的錯誤類型（佔 4xx 的 60～80%），值得單獨設計。

### 4.6.1 完整格式

```http
POST /orders
Content-Type: application/json

{
  "items": [
    { "productId": "P-1001", "quantity": 2 },
    { "productId": "", "quantity": 0 },
    { "productId": "P-2003", "quantity": -5 }
  ],
  "shippingAddressId": "",
  "customerNote": "（201 個字的備註...）",
  "invoice": { "type": "COMPANY", "taxId": "1234567" }
}
```

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
```

```jsonc
{
  "type": "https://api.shop.example/problems/validation-failed",
  "title": "請求內容驗證失敗",
  "status": 422,
  "detail": "6 field(s) failed validation.",
  "instance": "/orders",
  "code": "VALIDATION_FAILED",
  "userMessage": "部分欄位填寫有誤，請檢查後再送出。",
  "errors": [
    {
      "field": "items[1].productId",
      "code": "REQUIRED",
      "message": "商品編號為必填",
      "rejectedValue": ""
    },
    {
      "field": "items[1].quantity",
      "code": "MIN",
      "message": "數量至少為 1",
      "rejectedValue": 0,
      "constraint": { "min": 1 }
    },
    {
      "field": "items[2].quantity",
      "code": "MIN",
      "message": "數量至少為 1",
      "rejectedValue": -5,
      "constraint": { "min": 1 }
    },
    {
      "field": "shippingAddressId",
      "code": "REQUIRED",
      "message": "收件地址為必填",
      "rejectedValue": ""
    },
    {
      "field": "customerNote",
      "code": "MAX_LENGTH",
      "message": "備註最多 200 字（目前 201 字）",
      "rejectedValue": null,
      "constraint": { "max": 200, "actual": 201 }
    },
    {
      "field": "invoice.taxId",
      "code": "PATTERN",
      "message": "統一編號須為 8 位數字",
      "rejectedValue": "1234567",
      "constraint": { "pattern": "\\d{8}" }
    }
  ],
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

### 4.6.2 五個設計要點

**要點 1：一次回全部錯誤，不要一個一個回**

```
❌ 一次一個
第 1 次送出 → "商品編號為必填"
使用者改好 → 第 2 次送出 → "數量至少為 1"
使用者改好 → 第 3 次送出 → "收件地址為必填"
...使用者放棄
```

Bean Validation 預設就是**收集全部**（不是 fail-fast），所以這是免費的。
⚠️ 但如果你自己寫驗證邏輯，很容易寫成 fail-fast：

```java
// ❌ fail-fast
if (req.items().isEmpty()) throw new ValidationException("items", "至少一項商品");
if (req.shippingAddressId() == null) throw new ValidationException("shippingAddressId", "必填");

// ✅ 收集
List<FieldError> errors = new ArrayList<>();
if (req.items().isEmpty()) errors.add(new FieldError("items", "REQUIRED", "至少一項商品", null));
if (isBlank(req.shippingAddressId())) errors.add(new FieldError("shippingAddressId", "REQUIRED", "必填", null));
if (!errors.isEmpty()) throw new ValidationFailedException(errors);
```

**⚠️ 一個例外：驗證有先後依賴時要分階段。**

```
階段 1：格式驗證（全部收集）
        → 有錯就回 422，不進階段 2
階段 2：業務驗證（需要查資料庫：商品存在嗎、庫存夠嗎、折扣碼有效嗎）
        → 全部收集後回 422
```

不分階段的話，`productId` 是空字串時你還去查資料庫，浪費且可能拋出奇怪的錯誤。

**要點 2：`field` 要能精確定位，包含陣列索引**

```
✅ items[1].productId          陣列索引
✅ invoice.taxId               巢狀物件
✅ items[1].variants[0].sku    多層
✅ shippingAddressId           頂層

❌ items.productId             不知道是哪一項
❌ productId                   不知道在哪
❌ item 1 的商品編號            人類可讀但機器無法定位
```

**為什麼精確定位這麼重要**：

```typescript
// 前端可以直接把錯誤標到對應的表單欄位上
problem.errors.forEach(e => {
  form.setError(e.field, e.message);
  // React Hook Form / Formik / VeeValidate 都吃這個路徑格式
});
```

如果 `field` 是 `"items.productId"`，前端無法知道要標在第幾個商品上，
只能顯示一個全域的錯誤訊息 —— 使用者要自己找哪一項錯了。

**Spring 的實際行為**：`MethodArgumentNotValidException` 的
`FieldError.getField()` **已經包含索引**（`items[1].productId`）。
✅ 直接用就對了。

**但類別層級的驗證（`@ValidInvoice`）預設沒有 field**：

```java
// ObjectError（類別層級）的 getField() 不存在
// 要用 ConstraintValidatorContext 指定欄位
public boolean isValid(InvoiceRequest v, ConstraintValidatorContext ctx) {
    if (v.type() == COMPANY && isBlank(v.taxId())) {
        ctx.disableDefaultConstraintViolation();
        ctx.buildConstraintViolationWithTemplate("公司發票必須填統一編號")
           .addPropertyNode("taxId")            // ★ 指定欄位
           .addConstraintViolation();
        return false;
    }
    return true;
}
```

⚠️ 注意：`addPropertyNode("taxId")` 產生的 field 是相對於被驗證的物件，
所以在 `invoice` 上驗證時會得到 `invoice.taxId`（正確）。

**要點 3：`code` 讓前端可以做程式化處理**

```jsonc
{ "field": "customerNote", "code": "MAX_LENGTH", "constraint": { "max": 200, "actual": 201 } }
```

前端可以：
- 用 `code` 做自己的 i18n（不依賴後端的 `message`）。
- 用 `constraint.max` 顯示字數上限的 UI（`201 / 200`，紅色）。
- 對特定 `code` 做特殊處理（例如 `REQUIRED` 加紅框、`MAX_LENGTH` 顯示計數器）。

**驗證 `code` 的標準集合**（要固定，寫進 style guide）：

| `code` | 對應的 Bean Validation | 說明 |
|---|---|---|
| `REQUIRED` | `@NotNull` `@NotBlank` `@NotEmpty` | 必填 |
| `MIN` / `MAX` | `@Min` `@Max` `@DecimalMin` `@DecimalMax` | 數值範圍 |
| `MIN_LENGTH` / `MAX_LENGTH` | `@Size` | 長度 |
| `PATTERN` | `@Pattern` | 格式 |
| `EMAIL` | `@Email` | Email |
| `TYPE_MISMATCH` | Jackson 反序列化失敗 | 型別錯 |
| `INVALID_ENUM_VALUE` | 列舉值不存在 | 要列出 `allowedValues` |
| `NOT_FOUND` | 業務驗證 | 參照的資源不存在 |
| `DUPLICATE` | 業務驗證 | 重複 |
| `INVALID_COMBINATION` | 跨欄位驗證 | 組合不合法 |
| `OUT_OF_RANGE` | 業務驗證 | 日期區間等 |

**要點 4：`rejectedValue` 的安全處理**

```jsonc
// ✅ 一般欄位可以回
{ "field": "quantity", "rejectedValue": -5 }

// 🔴 敏感欄位絕對不能回
{ "field": "password", "rejectedValue": "MyRealPassword123" }
{ "field": "cardNumber", "rejectedValue": "4242424242424242" }
{ "field": "cvv", "rejectedValue": "123" }
```

**為什麼危險**：這個值會出現在
瀏覽器 devtools、前端的錯誤上報（Sentry）、後端日誌、APM trace、客服的截圖裡。

**實作：黑名單過濾**

```java
private static final Set<String> SENSITIVE_FIELDS = Set.of(
    "password", "currentPassword", "newPassword", "confirmPassword",
    "cardNumber", "cvv", "securityCode", "pin",
    "token", "refreshToken", "apiKey", "secret",
    "idNumber", "ssn", "passportNumber"
);

static Object safeRejectedValue(String field, Object value) {
    String leaf = field.substring(field.lastIndexOf('.') + 1)
                       .replaceAll("\\[\\d+\\]$", "");
    if (SENSITIVE_FIELDS.contains(leaf)) return "***";
    if (value instanceof CharSequence s && s.length() > 100) {
        return s.subSequence(0, 100) + "...(truncated)";   // 避免超長字串灌爆回應
    }
    return value;
}
```

⚠️ 黑名單有漏網之魚的風險。**更嚴格的做法是白名單**：
只對明確標記為「可回顯」的欄位回 `rejectedValue`。

```java
@SafeToEcho          // 自訂註解
@Min(1) Integer quantity;

@Min(1) Integer pin;  // 沒標註 → 不回 rejectedValue
```

**shop-service 用黑名單 + 長度截斷**（實務上足夠，且不會漏標），
但在 code review 的 checklist 裡加一條：「新增敏感欄位時要更新 `SENSITIVE_FIELDS`」。

**要點 5：i18n —— 訊息由誰翻譯**

| 方案 | 說明 | 取捨 |
|---|---|---|
| **A. 後端翻譯**（依 `Accept-Language`） | `message: "數量至少為 1"` | ✅ 前端零成本；新增錯誤自動有訊息<br>❌ 後端要維護語言檔；前端無法客製文案 |
| **B. 前端翻譯**（後端只給 `code` + `constraint`） | `code: "MIN", constraint: {min: 1}` | ✅ 前端完全掌控文案<br>❌ 前端要維護對照表；新增 code 前端要跟著改 |
| **C. 兩者都給** ★ | `code` + `message`（後端翻譯的預設值） | ✅ 前端可以選擇用哪個<br>❌ payload 稍大 |

**shop-service 選 C**：

```jsonc
{
  "field": "items[1].quantity",
  "code": "MIN",                          // 前端要自訂文案時用這個
  "message": "數量至少為 1",               // 後端的預設翻譯（依 Accept-Language）
  "messageKey": "validation.min",          // 前端要查自己的語言檔時用這個
  "constraint": { "min": 1 }               // 動態參數
}
```

**這樣三種客戶端都滿足**：

```typescript
// 客戶端 A：直接用後端訊息（最省事）
form.setError(e.field, e.message);

// 客戶端 B：完全自訂
form.setError(e.field, t(e.messageKey, e.constraint));

// 客戶端 C：混合（有自訂就用，沒有就 fallback）
form.setError(e.field, t(e.messageKey, e.constraint) ?? e.message);
```

**Spring 的 i18n 設定**：

```properties
# messages_zh_TW.properties
validation.min=數量至少為 {min}
validation.required={field} 為必填
error.insufficient-stock.title=庫存不足
error.insufficient-stock.user-message=「{productName}」僅剩 {available} 件，請調整數量。
```

```java
// Bean Validation 的訊息也可以走 MessageSource
@Bean
LocalValidatorFactoryBean validator(MessageSource messageSource) {
    LocalValidatorFactoryBean v = new LocalValidatorFactoryBean();
    v.setValidationMessageSource(messageSource);
    return v;
}
```

```java
public record OrderItemRequest(
    @NotBlank(message = "{validation.required.productId}") String productId,
    @Min(value = 1, message = "{validation.min}") Integer quantity
) {}
```

⚠️ `{...}` 的花括號語法會讓 Bean Validation 去 `MessageSource` 查 key。
但 Bean Validation 的參數插值（`{min}`）和 Spring 的 `MessageSource` 參數（`{0}`）語法不同 ——
混用時要測試。實務上很多團隊選擇**在 `RestControllerAdvice` 統一組訊息**，
不依賴 Bean Validation 的 `message` 屬性。

### 4.6.3 常見的驗證錯誤情境

**情境 1：型別錯誤（Jackson 反序列化失敗）**

```http
POST /orders
{ "items": [{ "productId": "P-1001", "quantity": "two" }] }
```

**Spring 的行為**：`HttpMessageNotReadableException` → `400`，
而且**只會有一個錯誤**（Jackson 遇到第一個錯就停）。

```jsonc
{
  "type": "https://api.shop.example/problems/malformed-request",
  "title": "請求格式錯誤",
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "userMessage": "請求資料格式不正確。",
  "errors": [
    {
      "field": "items[0].quantity",
      "code": "TYPE_MISMATCH",
      "message": "應為整數",
      "rejectedValue": "two",
      "constraint": { "expectedType": "integer" }
    }
  ],
  "traceId": "..."
}
```

**要從 `InvalidFormatException` 挖出 field 路徑**（04-controller 會實作）：

```java
@ExceptionHandler(HttpMessageNotReadableException.class)
public ResponseEntity<ApiProblem> handle(HttpMessageNotReadableException ex) {
    if (ex.getCause() instanceof InvalidFormatException ife) {
        String field = ife.getPath().stream()
                .map(r -> r.getFieldName() != null
                        ? r.getFieldName()
                        : "[" + r.getIndex() + "]")
                .collect(Collectors.joining("."))
                .replace(".[", "[");                  // items.[0].quantity → items[0].quantity
        ...
    }
}
```

**情境 2：列舉值不存在**

```http
{ "invoice": { "type": "INVALID_TYPE" } }
```

```jsonc
{
  "field": "invoice.type",
  "code": "INVALID_ENUM_VALUE",
  "message": "無效的發票類型",
  "rejectedValue": "INVALID_TYPE",
  "constraint": { "allowedValues": ["PERSONAL", "COMPANY", "DONATION"] }
}
```

**`allowedValues` 是很實用的細節**：前端可以直接顯示「可用選項：個人／公司／捐贈」，
而不用去翻文件。

**情境 3：跨欄位驗證**

```http
GET /orders?createdFrom=2026-08-31&createdTo=2026-08-01
```

```jsonc
{
  "errors": [
    {
      "field": "createdTo",
      "code": "INVALID_COMBINATION",
      "message": "結束日期不可早於開始日期",
      "rejectedValue": "2026-08-01",
      "constraint": { "relatedField": "createdFrom", "relatedValue": "2026-08-31" }
    }
  ]
}
```

**要標在哪個欄位？** 慣例：**標在「使用者最後改動的那個」或「較不合理的那個」**。
這裡標 `createdTo`（因為 `createdFrom` 本身沒問題）。

⚠️ 如果無法判斷，就**同時標兩個欄位**（兩筆 error），讓前端都標紅。
不要用 `field: null`（前端不知道標哪裡）。

**情境 4：業務驗證（需要查資料庫）**

```jsonc
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [
    {
      "field": "items[0].productId",
      "code": "NOT_FOUND",
      "message": "商品不存在或已下架",
      "rejectedValue": "P-9999"
    },
    {
      "field": "couponCode",
      "code": "EXPIRED",
      "message": "折扣碼已於 2026-08-01 過期",
      "rejectedValue": "SUMMER20",
      "constraint": { "expiredAt": "2026-08-01T23:59:59Z" }
    },
    {
      "field": "shippingAddressId",
      "code": "NOT_FOUND",
      "message": "收件地址不存在",
      "rejectedValue": "addr_deleted"
    }
  ]
}
```

**注意 `couponCode` 的 `expiredAt`**：讓前端可以顯示「已於 8/1 過期」而不只是「已過期」。
使用者會問「什麼時候過期的」，直接給答案省一次客服。

**情境 5：查詢參數驗證**

```http
GET /orders?page=-1&size=10000&sort=nonexistentField,desc
```

```jsonc
{
  "status": 400,
  "code": "MALFORMED_REQUEST",
  "errors": [
    { "field": "page", "code": "MIN", "message": "頁碼不可小於 0",
      "rejectedValue": -1, "constraint": { "min": 0 } },
    { "field": "size", "code": "MAX", "message": "每頁最多 100 筆",
      "rejectedValue": 10000, "constraint": { "max": 100 } },
    { "field": "sort", "code": "INVALID_ENUM_VALUE", "message": "不支援此排序欄位",
      "rejectedValue": "nonexistentField",
      "constraint": { "allowedValues": ["createdAt", "updatedAt", "totalAmount", "orderNumber"] } }
  ]
}
```

⚠️ **`sort` 的白名單非常重要**：如果直接把使用者的字串塞進 `ORDER BY`，
那是 SQL injection（即使用 JPA 的 `Sort` 也可能）。第 05 章會詳談。

---

## 4.7 三種訊息：給人看、給程式看、給開發者看

### 4.7.1 三層結構

```jsonc
{
  "code": "INSUFFICIENT_STOCK",                          // ① 給程式看
  "detail": "Product P-1001 has 3 units available but 5 were requested.",   // ② 給開發者看
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。"       // ③ 給使用者看
}
```

| 層 | 欄位 | 讀者 | 語言 | 可以改嗎 |
|---|---|---|---|---|
| ① 機器 | `code` | 程式的 `if` / `switch` | 英文常數 | ❌ **絕不能改**（是契約） |
| ② 開發者 | `detail`、`title` | 工程師除錯、log | 英文（技術用語 OK） | ⚠️ 可以改（不該有人用它做邏輯） |
| ③ 使用者 | `userMessage` | 終端使用者 | 使用者語言 | ✅ 隨時可改（PM 可以改文案） |

### 4.7.2 為什麼要分三層

**理由 1：`code` 不能改，但文案要能改**

```
PM：「『庫存不足』太生硬，改成『這個商品被搶光了 😢』」
→ 只改 userMessage，不動 code
→ 前端的 if (code === 'INSUFFICIENT_STOCK') 不用改
→ 不用發版
```

如果前端是用 `message === '庫存不足'` 判斷（真的有人這樣寫），改文案就會炸掉。
**有了 `code`，就沒有理由用訊息內容做判斷。**

**理由 2：開發者要技術細節，使用者不要**

```
detail:      "Optimistic lock failed: expected version 7, current is 8"
userMessage: "此訂單已被其他人修改，請重新載入後再試。"
```

給使用者看 `Optimistic lock failed` 只會讓他打電話給客服。
給開發者看「請重新載入」則完全沒有除錯價值。

**理由 3：i18n 只需要做一層**

`code` 不需要翻譯，`detail` 不需要翻譯（開發者看英文），
**只有 `userMessage` 需要 i18n**。

### 4.7.3 `detail` 的安全邊界 ★

**`detail` 是給開發者看的 —— 但它會被傳到客戶端。**
所以它**不能**包含真正的內部細節。

| ❌ 絕對不能出現在 `detail` | 為什麼 |
|---|---|
| SQL 語句、資料表名、約束名 | 洩漏 schema，幫助 SQL injection |
| Stack trace、套件名、類別名 | 洩漏框架版本 → 已知漏洞 |
| 內部 IP、主機名、埠號 | 洩漏拓樸（第 00 章 0.4.2 約束 5） |
| 檔案路徑 | 洩漏部署結構 |
| 其他使用者的資料 | 個資洩漏 |
| 內部服務名與錯誤原文 | 洩漏架構 |
| 風控規則、詐騙偵測邏輯 | 幫助攻擊者規避（4.5.4） |
| 環境變數、設定值 | 可能含密鑰 |

**「可以」出現在 `detail` 的**：

```
✅ "Product P-1001 has 3 units available but 5 were requested."
   （業務事實，客戶端本來就知道 P-1001 和 5）
✅ "Order ORD-20260819-0001 is in SHIPPED state; cancellable states are PENDING_PAYMENT, PAID."
   （狀態機資訊，這是文件裡就有的）
✅ "Field 'items[1].quantity' must be >= 1."
   （驗證資訊）
✅ "Expected version v7 but current is v8."
   （版本號，客戶端已經有 ETag 了）
```

**判準：`detail` 只能包含「客戶端已經知道或有權知道」的資訊。**

**5xx 錯誤的 `detail` 要特別小心**：

```jsonc
// ❌ 洩漏一切
{
  "status": 500,
  "detail": "org.springframework.dao.DataIntegrityViolationException: could not execute statement; SQL [insert into t_order_master ...]; constraint [uk_order_no]"
}

// ✅ 完全不透露，用 traceId 讓開發者去查日誌
{
  "type": "https://api.shop.example/problems/internal-error",
  "title": "系統錯誤",
  "status": 500,
  "detail": "An unexpected error occurred. Provide the traceId when contacting support.",
  "code": "INTERNAL_ERROR",
  "userMessage": "系統暫時發生問題，請稍後再試。若持續發生請聯絡客服並提供追蹤碼。",
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**5xx 的規則：`detail` 一律是固定的通用文字，真正的細節只進日誌。**

```java
@ExceptionHandler(Exception.class)
public ResponseEntity<ApiProblem> handleUnexpected(Exception ex, HttpServletRequest req) {
    String traceId = MDC.get("traceId");

    // ★ 完整細節只進日誌
    log.error("未預期的錯誤 traceId={} path={} method={}",
              traceId, req.getRequestURI(), req.getMethod(), ex);

    // ★ 回應不含任何細節
    return ResponseEntity.status(500)
            .contentType(MediaType.APPLICATION_PROBLEM_JSON)
            .body(ApiProblem.of(ErrorCode.INTERNAL_ERROR, traceId, req));
}
```

⚠️ **注意 `handleUnexpected` 必須是「最後一道」**。
如果它攔到了本該回 4xx 的例外（例如你自己的 `ValidationException` 忘記註冊 handler），
就會把 4xx 變成 5xx → 4.12 的告警問題。
所以要**先註冊具體的 handler**，這個放最後。

### 4.7.4 `userMessage` 的撰寫原則

| 原則 | ❌ | ✅ |
|---|---|---|
| 說發生了什麼 | 「操作失敗」 | 「此訂單已出貨，無法取消」 |
| 說該怎麼做 | 「庫存不足」 | 「僅剩 3 件，請調整數量後再結帳」 |
| 不用技術術語 | 「樂觀鎖衝突」 | 「此訂單已被其他人修改，請重新載入」 |
| 不責怪使用者 | 「你輸入的資料有誤」 | 「請確認統一編號為 8 位數字」 |
| 不洩漏內部 | 「資料庫連線失敗」 | 「系統暫時無法處理，請稍後再試」 |
| 給下一步 | 「付款失敗」 | 「卡片被拒絕，請換卡或聯絡發卡行」 |
| 需要人工協助時給追蹤碼 | 「請聯絡管理員」 | 「請聯絡客服並提供追蹤碼 4f2c8a1e」 |

**風控類訊息要刻意模糊（4.5.4）**：

```jsonc
// ❌ 告訴詐騙者他被抓到了，以及為什麼
{ "userMessage": "偵測到異常交易行為：您的 IP 位址與帳單地址國家不符" }

// ✅ 模糊但仍給出口
{ "userMessage": "此筆交易無法完成，請改用其他付款方式或聯絡客服。",
  "traceId": "4f2c8a1e9b7d3f60" }
```

**「使用者列舉」的訊息也要模糊（第 02 章 2.9.3）**：

```jsonc
// ❌
{ "userMessage": "此 Email 尚未註冊" }
{ "userMessage": "密碼錯誤" }

// ✅ 兩種情況同一個訊息
{ "code": "INVALID_CREDENTIALS", "userMessage": "帳號或密碼錯誤" }
```

---

## 4.8 錯誤與可追蹤性

### 4.8.1 `traceId` 的完整鏈路

**這是本章投報率最高的一節。**

```
① 請求進來
   Nginx 產生 X-Request-Id（如果客戶端沒帶）
       ↓
② Spring Filter 讀取，放進 MDC
   MDC.put("traceId", requestId)
       ↓
③ 所有日誌自動帶上
   2026-08-19T06:12:44Z ERROR [shop-service] [traceId=4f2c8a1e9b7d3f60] ...
       ↓
④ 呼叫下游服務時傳遞
   headers.add("X-Request-Id", MDC.get("traceId"))
       ↓
⑤ 錯誤回應帶上
   { "traceId": "4f2c8a1e9b7d3f60" }
       ↓
⑥ 前端顯示給使用者
   「系統錯誤，請聯絡客服並提供追蹤碼：4f2c8a1e」
       ↓
⑦ 前端上報 Sentry 時帶上
   Sentry.captureException(err, { tags: { traceId } })
       ↓
⑧ 使用者截圖給客服 → 客服貼進日誌系統 → 一秒找到完整鏈路
```

**⑥ 那一步是關鍵**：如果錯誤回應有 `traceId` 但前端不顯示，
整條鏈路就斷在使用者那裡（回到 4.2.1 的一整天）。

**實作（Filter）**：

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    private static final String HEADER = "X-Request-Id";
    private static final String MDC_KEY = "traceId";

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        String traceId = req.getHeader(HEADER);
        if (traceId == null || traceId.isBlank() || traceId.length() > 64
                || !traceId.matches("[A-Za-z0-9._-]+")) {     // ★ 驗證！見下
            traceId = generate();
        }
        MDC.put(MDC_KEY, traceId);
        res.setHeader(HEADER, traceId);                        // ★ 回傳給客戶端
        try {
            chain.doFilter(req, res);
        } finally {
            MDC.remove(MDC_KEY);                               // ★ 一定要清（執行緒池會重用）
        }
    }

    private String generate() {
        return HexFormat.of().formatHex(...);   // 16 bytes random hex
    }
}
```

**⚠️ 三個容易出錯的地方**：

| 問題 | 後果 | 解法 |
|---|---|---|
| 不驗證客戶端送的 `X-Request-Id` | 🔴 **log injection**：攻擊者送含換行的值 → 偽造日誌行 | 白名單字元 + 長度限制 |
| 忘記 `MDC.remove()` | 執行緒池重用時，下一個請求帶到上一個的 traceId | `finally` 清除 |
| `@Async` / `CompletableFuture` 不會繼承 MDC | 非同步的日誌沒有 traceId | `TaskDecorator` 複製 MDC（02-spring-boot 第 06 章） |

### 4.8.2 與 OpenTelemetry / W3C Trace Context 整合

現代做法是用**標準的 `traceparent` header**（W3C Trace Context）：

```http
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  └─ trace-id (32 hex) ────────┘ └─ span-id ──┘ └ flags
             └─ version
```

Spring Boot 3 + Micrometer Tracing 會自動處理：

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
```

```yaml
logging:
  pattern:
    level: "%5p [${spring.application.name},%X{traceId:-},%X{spanId:-}]"
```

**在錯誤回應裡用哪個？**

```jsonc
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",   // ★ 用 OTel 的 trace id
  "spanId": "00f067aa0ba902b7"                      // 選填
}
```

**好處**：這個 `traceId` 可以直接貼進 Jaeger / Tempo / Zipkin / Datadog，
**看到完整的跨服務呼叫圖**（不只是日誌）。

**shop-service 的決定**：
- 用 Micrometer Tracing 的 `traceId`（OTel 格式）。
- 同時接受 `traceparent`（標準）與 `X-Request-Id`（相容既有工具）。
- 錯誤回應與回應 header 都帶。

### 4.8.3 前端要顯示 `traceId`

```typescript
// ✅ 錯誤 UI 的完整樣子
function ErrorDialog({ problem }: { problem: ApiProblem }) {
  return (
    <Dialog>
      <Title>{problem.title}</Title>
      <Body>{problem.userMessage}</Body>
      {problem.retryable && <Button onClick={retry}>重試</Button>}
      {problem.traceId && (
        <Footer>
          <small>
            追蹤碼：<code>{problem.traceId.slice(0, 8)}</code>
            <CopyButton value={problem.traceId} />
          </small>
        </Footer>
      )}
    </Dialog>
  );
}
```

**設計細節**：

| 細節 | 理由 |
|---|---|
| 只顯示前 8 碼 | 32 個 hex 太長，使用者不會唸；前 8 碼在日誌系統裡通常夠唯一 |
| 提供「複製」按鈕 | 使用者不用手抄（手抄一定會錯） |
| 只在錯誤時顯示 | 成功時顯示只是雜訊 |
| 5xx 一定顯示，4xx 可選 | 4xx 使用者自己能解決，不需要客服 |

**同時上報到前端監控**：

```typescript
Sentry.captureException(error, {
  tags: { traceId: problem.traceId, errorCode: problem.code },
  contexts: { problem },
});
```

**這樣前端的 Sentry 事件和後端的日誌可以用 `traceId` 對起來** ——
「前端報了一個錯，後端發生了什麼」變成一次查詢就能回答。

---

## 4.9 重試語意

### 4.9.1 誰決定要不要重試

**客戶端無法自己判斷**，因為它不知道你的內部狀況。所以**後端要告訴它**。

```jsonc
{
  "code": "PAYMENT_GATEWAY_TIMEOUT",
  "status": 504,
  "retryable": true,
  "retryAfterSeconds": 5,
  "userMessage": "付款處理超時，請稍後再試。"
}
```

```http
HTTP/1.1 504 Gateway Timeout
Retry-After: 5
Content-Type: application/problem+json
```

**`Retry-After` header 和 `retryAfterSeconds` 欄位都要給**：

| 給誰 | 用哪個 |
|---|---|
| HTTP 客戶端函式庫、Envoy、Istio 的自動重試 | `Retry-After` header（它們只看 header） |
| 前端的 UI（顯示「5 秒後自動重試」） | `retryAfterSeconds` 欄位（JS 讀 header 需要 CORS expose） |

⚠️ 別忘了 `Access-Control-Expose-Headers: Retry-After`（第 02 章 2.7.2）。

### 4.9.2 `retryable` 的對照表

| `code` | 狀態碼 | `retryable` | 理由 |
|---|---|---|---|
| `VALIDATION_FAILED` | 422 | ❌ | 內容不改，重試一百次都一樣 |
| `MALFORMED_REQUEST` | 400 | ❌ | 同上 |
| `AUTHENTICATION_REQUIRED` | 401 | ❌ | 要先取得憑證（但**刷新 token 後可以重試**，見下） |
| `TOKEN_EXPIRED` | 401 | ⚠️ **刷新後可** | 前端該做的是刷新 token 再重試，不是直接重試 |
| `INSUFFICIENT_ROLE` | 403 | ❌ | 換帳號才有用 |
| `RESOURCE_NOT_FOUND` | 404 | ❌ | — |
| `ORDER_NOT_CANCELLABLE` | 409 | ❌ | 狀態不會自己變回來 |
| `INSUFFICIENT_STOCK` | 409 | ⚠️ **補貨後可** | 立即重試無用；但不是永久失敗 |
| `OPTIMISTIC_LOCK_CONFLICT` | 412 | ✅ **重讀後可** | 要先 `GET` 拿新 `ETag` |
| `RATE_LIMIT_EXCEEDED` | 429 | ✅ | 等 `Retry-After` |
| `INTERNAL_ERROR` | 500 | ❌ | 通常是 bug，重試也會失敗 |
| `UPSTREAM_ERROR` | 502 | ✅ | 上游可能恢復 |
| `SERVICE_UNAVAILABLE` | 503 | ✅ | 暫時性 |
| `PAYMENT_GATEWAY_TIMEOUT` | 504 | ✅ | ⚠️ **但必須有冪等鍵！** 見 4.9.4 |

**注意有三種「條件式可重試」**，用一個布林表達不夠：

```jsonc
// 更精確的表達
{
  "code": "OPTIMISTIC_LOCK_CONFLICT",
  "retryable": true,
  "retryStrategy": "REFETCH_THEN_RETRY",     // ★ 告訴客戶端「怎麼」重試
  "currentVersion": "v8"
}

{
  "code": "TOKEN_EXPIRED",
  "retryable": true,
  "retryStrategy": "REFRESH_TOKEN_THEN_RETRY"
}

{
  "code": "PAYMENT_GATEWAY_TIMEOUT",
  "retryable": true,
  "retryStrategy": "BACKOFF_AND_RETRY",
  "retryAfterSeconds": 5
}

{
  "code": "INSUFFICIENT_STOCK",
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",          // 改內容才有用
  "available": 3
}
```

**`retryStrategy` 的四個值**：

| 值 | 客戶端該做什麼 |
|---|---|
| `BACKOFF_AND_RETRY` | 等 `retryAfterSeconds`（或指數退避）後重送**同樣的請求** |
| `REFETCH_THEN_RETRY` | 先 `GET` 拿最新狀態／`ETag`，再重送 |
| `REFRESH_TOKEN_THEN_RETRY` | 刷新憑證後重送 |
| `MODIFY_REQUEST` | **不要重試** —— 要改請求內容 |

**shop-service 採用 `retryable` + `retryStrategy` 兩個欄位。**

### 4.9.3 指數退避與抖動

**客戶端該怎麼退避**（寫在你的 API 文件裡，幫助 consumer 做對）：

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const problem = err.problem as ApiProblem | undefined;

      if (!problem?.retryable) throw err;                    // 不可重試 → 立刻放棄
      if (problem.retryStrategy === 'MODIFY_REQUEST') throw err;
      if (attempt === maxAttempts - 1) throw err;            // 最後一次了

      // 伺服器指定的優先；否則指數退避
      const baseMs = problem.retryAfterSeconds != null
        ? problem.retryAfterSeconds * 1000
        : Math.min(1000 * 2 ** attempt, 30_000);

      // ★ 加抖動（jitter），避免所有客戶端同時重試造成二次雪崩
      const jitteredMs = baseMs * (0.5 + Math.random() * 0.5);
      await sleep(jitteredMs);
    }
  }
  throw lastError;
}
```

**抖動（jitter）為什麼必要**：

```
沒有抖動：
  10:00:00  1000 個客戶端同時收到 503
  10:00:05  1000 個客戶端同時重試   ← 又打掛一次
  10:00:15  1000 個客戶端同時重試   ← 再打掛一次
  → 「重試風暴」（retry storm），比原本的問題更嚴重

有抖動（±50%）：
  10:00:02.5 ~ 10:00:05  重試平均分散在 2.5 秒內
  → 伺服器有機會恢復
```

**這是分散式系統的經典陷阱**，而且**你的 API 文件應該主動教 consumer 這件事** ——
否則他們的重試邏輯會變成對你的 DDoS。

### 4.9.4 重試的前提：冪等性

**🔴 這是最容易被忽略的一點：`retryable: true` 的前提是這個操作可以安全重試。**

```
POST /orders/{id}/payments  →  504 Gateway Timeout
                                retryable: true
```

**問題**：`504` 表示「我等上游超時」。但**上游可能已經扣款成功了**，
只是回應沒回來（第 02 章 2.2.4 的時間軸）。

如果客戶端重試，就會**扣款兩次**。

**所以 `retryable: true` 只在以下情況成立**：

| 情況 | 可以標 `retryable: true`？ |
|---|---|
| `GET` / `PUT` / `DELETE`（天生冪等） | ✅ |
| `POST` + 客戶端帶了 `Idempotency-Key` | ✅ |
| `POST` **沒有**冪等鍵 | 🔴 **不可以** —— 要標 `retryable: false` 並要求客戶端查詢狀態 |

**沒有冪等鍵時的正確回應**：

```jsonc
{
  "type": "https://api.shop.example/problems/payment-outcome-unknown",
  "title": "付款結果未知",
  "status": 504,
  "detail": "The payment gateway did not respond in time. The payment may or may not have been completed.",
  "code": "PAYMENT_OUTCOME_UNKNOWN",
  "userMessage": "付款處理中，請稍候並查看訂單狀態。請勿重複付款。",
  "retryable": false,
  "retryStrategy": "CHECK_STATUS",                        // ★ 特殊策略
  "statusCheckUrl": "/orders/ord_01J5GK.../payments",
  "recommendedCheckAfterSeconds": 10,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**`retryStrategy: "CHECK_STATUS"` 告訴客戶端：不要重送，去查狀態。**

**更好的做法：一開始就要求冪等鍵**（第 02 章 2.2.4）。

```jsonc
// 沒帶 Idempotency-Key 的 POST /orders/{id}/payments
{
  "type": "https://api.shop.example/problems/idempotency-key-required",
  "title": "缺少冪等鍵",
  "status": 400,
  "detail": "This endpoint requires an Idempotency-Key header (a client-generated UUID) to make retries safe.",
  "code": "IDEMPOTENCY_KEY_REQUIRED",
  "userMessage": "系統錯誤，請聯絡客服。",
  "retryable": false
}
```

**這樣就不會有「無法安全重試」的情況** ——
所有關鍵的 `POST` 都有冪等鍵，所以都可以標 `retryable: true`。

**shop-service 的規則**：

```
所有涉及金錢或建立資源的 POST → 強制 Idempotency-Key（沒帶回 400）
                              → 因此可以安全地標 retryable: true
不涉及金錢的 POST（重寄通知）  → 選填冪等鍵
```

---

## 4.10 領域例外 → HTTP 的對映

### 4.10.1 分層的例外設計

**原則：Service 層拋領域例外（不知道 HTTP），Controller 層轉成 HTTP。**

```java
// ── 領域層（05-service）：完全不知道 HTTP ─────────────
public abstract class DomainException extends RuntimeException {
    private final ErrorCode code;
    private final Map<String, Object> context;

    protected DomainException(ErrorCode code, String message, Map<String, Object> context) {
        super(message);
        this.code = code;
        this.context = context == null ? Map.of() : Map.copyOf(context);
    }

    public ErrorCode code() { return code; }
    public Map<String, Object> context() { return context; }
}

public class InsufficientStockException extends DomainException {
    public InsufficientStockException(String productId, String productName,
                                     int requested, int available, LocalDate restockAt) {
        super(ErrorCode.INSUFFICIENT_STOCK,
              "Product %s has %d units available but %d were requested."
                      .formatted(productId, available, requested),
              Map.of("productId", productId,
                     "productName", productName,
                     "requested", requested,
                     "available", available,
                     "restockEstimatedAt", restockAt));
    }
}

public class OrderNotCancellableException extends DomainException {
    public OrderNotCancellableException(String orderNumber, OrderStatus current) {
        super(ErrorCode.ORDER_NOT_CANCELLABLE,
              "Order %s is in %s state; cancellable states are PENDING_PAYMENT, PAID."
                      .formatted(orderNumber, current),
              Map.of("orderNumber", orderNumber,
                     "currentStatus", current.name(),
                     "cancellableStatuses", List.of("PENDING_PAYMENT", "PAID")));
    }
}
```

```java
// ── Web 層（04-controller）：統一轉換 ────────────────
@RestControllerAdvice
public class DomainExceptionHandler {

    private final MessageSource messages;

    @ExceptionHandler(DomainException.class)
    public ResponseEntity<ApiProblem> handle(DomainException ex,
                                             HttpServletRequest req,
                                             Locale locale) {
        ErrorCode code = ex.code();

        // 4xx 用 warn（不告警），5xx 用 error（會告警）—— 見 4.12
        if (code.status().is5xxServerError()) {
            log.error("領域錯誤 code={} traceId={} ctx={}",
                      code, MDC.get("traceId"), ex.context(), ex);
        } else {
            log.warn("領域錯誤 code={} traceId={} ctx={} msg={}",
                     code, MDC.get("traceId"), ex.context(), ex.getMessage());
        }

        ApiProblem problem = ApiProblem.builder()
                .type(code.type())
                .title(messages.getMessage(code.messageKey() + ".title", null, locale))
                .status(code.status().value())
                .detail(ex.getMessage())                          // 開發者訊息（英文）
                .instance(URI.create(req.getRequestURI()))
                .code(code.name())
                .userMessage(messages.getMessage(code.messageKey() + ".user-message",
                                                 toArgs(ex.context()), locale))
                .retryable(code.retryable())
                .traceId(MDC.get("traceId"))
                .timestamp(Instant.now())
                .extensions(ex.context())                          // 擴充欄位
                .build();

        return ResponseEntity.status(code.status())
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(problem);
    }
}
```

**這個設計的五個好處**：

| 好處 | 說明 |
|---|---|
| **Service 層可以在非 HTTP 環境使用** | 排程、訊息佇列的 consumer、CLI 工具都能用同一份業務邏輯 |
| **狀態碼的對映只有一處** | 在 `ErrorCode` enum 裡（4.5.5），不可能兩個地方不一致 |
| **擴充欄位自動帶入** | 例外的 `context` 直接變成 Problem Details 的擴充欄位 |
| **i18n 只在一處** | Web 層查 `MessageSource` |
| **日誌等級由狀態碼決定** | 不會有「4xx 也 log.error」的告警噪音（4.12） |

### 4.10.2 完整對映表

| 領域例外 | `ErrorCode` | 狀態碼 |
|---|---|---|
| `ResourceNotFoundException` | `RESOURCE_NOT_FOUND` | `404` |
| `ResourceGoneException` | `RESOURCE_GONE` | `410` |
| `ValidationFailedException` | `VALIDATION_FAILED` | `422` |
| `InsufficientStockException` | `INSUFFICIENT_STOCK` | `409` |
| `OrderNotCancellableException` | `ORDER_NOT_CANCELLABLE` | `409` |
| `OrderAlreadyPaidException` | `ORDER_ALREADY_PAID` | `409` |
| `OrderExpiredException` | `ORDER_EXPIRED` | `409` |
| `CouponExpiredException` | `COUPON_EXPIRED` | `422` |
| `CouponExhaustedException` | `COUPON_EXHAUSTED` | `409` |
| `CardDeclinedException` | `CARD_DECLINED` | `402` |
| `PaymentGatewayTimeoutException` | `PAYMENT_GATEWAY_TIMEOUT` | `504` |
| `PaymentGatewayUnavailableException` | `PAYMENT_GATEWAY_UNAVAILABLE` | `503` |
| `OptimisticLockException`（Spring/JPA） | `OPTIMISTIC_LOCK_CONFLICT` | `412` |
| `AccessDeniedException`（Spring Security） | `INSUFFICIENT_ROLE` | `403` |
| `AuthenticationException`（Spring Security） | `AUTHENTICATION_REQUIRED` | `401` |
| 其他未攔截的 `Exception` | `INTERNAL_ERROR` | `500` |

### 4.10.3 框架例外也要處理

**Spring 內建的例外如果不處理，會回預設格式（不是你的 Problem Details）。**
最少要處理這幾個：

| 例外 | 狀態碼 | `code` |
|---|---|---|
| `MethodArgumentNotValidException`（`@Valid` 失敗） | `422` | `VALIDATION_FAILED` |
| `ConstraintViolationException`（`@Validated` 在參數上） | `422` | `VALIDATION_FAILED` |
| `HttpMessageNotReadableException`（JSON 壞掉） | `400` | `MALFORMED_REQUEST` |
| `MethodArgumentTypeMismatchException`（路徑／查詢參數型別錯） | `400` | `MALFORMED_REQUEST` |
| `MissingServletRequestParameterException` | `400` | `MALFORMED_REQUEST` |
| `HttpMediaTypeNotSupportedException` | `415` | `UNSUPPORTED_MEDIA_TYPE` |
| `HttpMediaTypeNotAcceptableException` | `406` | `NOT_ACCEPTABLE` |
| `HttpRequestMethodNotSupportedException` | `405` | `METHOD_NOT_ALLOWED`（要帶 `Allow`） |
| `NoResourceFoundException`（Boot 3.2+ 的 404） | `404` | `RESOURCE_NOT_FOUND` |
| `MaxUploadSizeExceededException` | `413` | `PAYLOAD_TOO_LARGE` |
| `AsyncRequestTimeoutException` | `503` | `SERVICE_UNAVAILABLE` |

**做法：繼承 `ResponseEntityExceptionHandler`**（它已經處理了大部分，你只要覆寫格式）：

```java
@RestControllerAdvice
public class FrameworkExceptionHandler extends ResponseEntityExceptionHandler {

    // 覆寫這個方法，所有框架例外的回應都會經過它
    @Override
    protected ResponseEntity<Object> createResponseEntity(
            Object body, HttpHeaders headers, HttpStatusCode status, WebRequest request) {

        if (body instanceof ProblemDetail pd) {
            // 把 Spring 產生的 ProblemDetail 補上我們的欄位
            pd.setProperty("code", mapToCode(status).name());
            pd.setProperty("traceId", MDC.get("traceId"));
            pd.setProperty("timestamp", Instant.now());
            pd.setProperty("retryable", mapToCode(status).retryable());
        }
        return super.createResponseEntity(body, headers, status, request);
    }
}
```

⚠️ **一個常見的漏洞**：`ResponseEntityExceptionHandler` 只處理它認得的例外。
**Spring Security 的 `AuthenticationException` 和 `AccessDeniedException`
在 Filter 層就被攔截了，根本不會進 `@RestControllerAdvice`。**

所以 `401` / `403` 要另外設定：

```java
// 09-spring-security 會完整實作
http.exceptionHandling(ex -> ex
    .authenticationEntryPoint(problemAuthenticationEntryPoint)   // 401
    .accessDeniedHandler(problemAccessDeniedHandler));           // 403
```

**如果忘記這一步**，你的 `401`/`403` 會是 Spring Security 的預設格式
（空 body 或 HTML），和其他錯誤格式不一致 —— **這是最常見的「錯誤格式不統一」原因**。

### 4.10.4 別忘了非 Controller 的錯誤

| 錯誤來源 | 預設行為 | 要做什麼 |
|---|---|---|
| Spring Security Filter（401/403） | 空 body / HTML | `AuthenticationEntryPoint` + `AccessDeniedHandler` |
| Servlet 容器層（400 malformed request line） | Tomcat 的 HTML 頁 | 通常無法改（在 Spring 之前）；靠 Nginx 統一錯誤頁 |
| Nginx / ALB（502、504、413） | Nginx 的 HTML 頁 | `error_page` + 自訂 JSON |
| 找不到路由（404） | `NoResourceFoundException`（Boot 3.2+）或 `BasicErrorController` | 設 `spring.mvc.throw-exception-if-no-handler-found=true` 並處理 |
| 非同步／排程的錯誤 | 只進日誌 | 沒有 HTTP 回應，但要告警 |

**Nginx 的統一錯誤頁**（讓基礎設施層的錯誤也是 Problem Details）：

```nginx
# 讓 Nginx 自己產生的錯誤也是 JSON
error_page 502 503 504 = @json_error;

location @json_error {
    default_type application/problem+json;
    return 503 '{"type":"https://api.shop.example/problems/service-unavailable","title":"服務暫時無法使用","status":503,"code":"SERVICE_UNAVAILABLE","userMessage":"系統忙碌中，請稍後再試。","retryable":true}';
}
```

**這一步常被忽略，但很重要**：如果你的服務掛了，
客戶端收到的是 Nginx 的 HTML 頁 → 前端 `res.json()` 拋 `SyntaxError`
→ 使用者看到「未知錯誤」而不是「系統忙碌中」。

---

## 4.11 批次操作的部分成功

### 4.11.1 問題

```http
POST /orders/ord_1/items
[
  { "productId": "P-1001", "quantity": 2 },   ← 成功
  { "productId": "P-9999", "quantity": 1 },   ← 商品不存在
  { "productId": "P-2003", "quantity": 999 }  ← 庫存不足
]
```

回 `201`？回 `422`？

### 4.11.2 三種策略

**策略 A：全有全無（atomic）★ 預設選這個**

```http
→ 422 Unprocessable Content
```

```jsonc
{
  "type": "https://api.shop.example/problems/validation-failed",
  "title": "批次操作驗證失敗",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "userMessage": "部分項目無法加入，整批已取消。請修正後重新送出。",
  "detail": "2 of 3 items failed; no changes were applied.",
  "errors": [
    { "field": "[1].productId", "code": "NOT_FOUND",
      "message": "商品不存在", "rejectedValue": "P-9999" },
    { "field": "[2].quantity", "code": "INSUFFICIENT_STOCK",
      "message": "僅剩 3 件", "rejectedValue": 999,
      "constraint": { "available": 3 } }
  ],
  "atomic": true,                     // ★ 明確告知「沒有任何變更被套用」
  "traceId": "..."
}
```

**優點**：語意簡單，客戶端不用處理「一半成功」的狀態。
**缺點**：一筆錯就全部要重送。

**適合**：小批量（< 50）、且項目之間有關聯（例如一張訂單的明細）。

**⚠️ `atomic: true` 這個欄位很重要**：讓客戶端確定「不用去查哪些成功了」。
沒有它，客戶端只能猜（或多打一次 `GET`）。

**策略 B：逐筆結果（`207 Multi-Status` 或 `200`）**

```http
→ 207 Multi-Status
```

```jsonc
{
  "summary": { "total": 3, "succeeded": 1, "failed": 2 },
  "results": [
    {
      "index": 0,
      "status": 201,
      "location": "/orders/ord_1/items/oi_01J5GK...",
      "data": { "itemId": "oi_01J5GK...", "productId": "P-1001", "quantity": 2 }
    },
    {
      "index": 1,
      "status": 422,
      "error": {
        "code": "PRODUCT_NOT_FOUND",
        "title": "商品不存在",
        "detail": "Product P-9999 does not exist.",
        "userMessage": "此商品已下架"
      }
    },
    {
      "index": 2,
      "status": 409,
      "error": {
        "code": "INSUFFICIENT_STOCK",
        "title": "庫存不足",
        "userMessage": "僅剩 3 件",
        "available": 3
      }
    }
  ],
  "traceId": "..."
}
```

**`207` vs `200` 的選擇**：

| | `207 Multi-Status` | `200 OK` |
|---|---|---|
| 出身 | WebDAV（RFC 4918） | 通用 |
| 語意精確度 | ★ 明確表達「多個結果」 | 需要看 body |
| 客戶端支援 | ⚠️ 有些函式庫不認識，可能當成錯誤 | ✅ 都認識 |
| 監控 | ✅ 可以單獨統計 | 混在成功裡 |

**shop-service 選 `207`**，理由：
- 語意最精確，而且 `2xx` 所以不會被當成失敗。
- 監控上可以看「207 的比例」→ 批次操作的失敗率。

⚠️ **但要在文件裡明確說明**，因為不是所有 consumer 都知道 `207`。

**策略 C：非同步工作（大批量）**

第 01 章 1.12.1 做法 D + 第 02 章 2.10。錯誤明細用獨立端點分頁：

```http
GET /order-import-jobs/job_01J5GK.../errors?page=0&size=50
→ 200 OK
{
  "items": [
    { "row": 42, "code": "PRODUCT_NOT_FOUND", "field": "productId",
      "value": "P-9999", "message": "商品不存在" }
  ],
  "page": { "number": 0, "size": 50, "totalElements": 60 }
}
```

**為什麼錯誤要分頁**：匯入 5 萬筆可能有 3000 筆錯誤，一次回會爆掉。

### 4.11.3 選擇指引

| 批量 | 項目間有關聯？ | 策略 | 狀態碼 |
|---|---|---|---|
| 1～50 | ✅ 有（訂單明細） | A 全有全無 | `201` / `422` |
| 1～50 | ❌ 無（批次貼標籤） | B 逐筆結果 | `207` |
| 50～500 | — | B 逐筆結果 | `207` |
| > 500 或耗時 > 5 秒 | — | C 非同步工作 | `202` |

**「項目間有關聯」的判準**：如果部分成功會產生**不一致的業務狀態**，就要用 A。

```
訂單明細：部分成功 → 訂單金額算錯 → 必須 atomic
批次貼標籤：部分成功 → 沒關係，重試失敗的就好 → 可以逐筆
批次寄信：部分成功 → 沒關係 → 可以逐筆
批次轉帳：🔴 部分成功 → 帳目不平 → 必須 atomic（而且要交易）
```

### 4.11.4 交易邊界的坑

**策略 A 需要真正的交易保證**：

```java
@Transactional            // ★ 必須有
public List<OrderItemResponse> addItems(String orderId, List<AddItemRequest> reqs) {
    List<FieldError> errors = new ArrayList<>();
    List<OrderItem> created = new ArrayList<>();

    for (int i = 0; i < reqs.size(); i++) {
        try {
            created.add(doAdd(orderId, reqs.get(i)));
        } catch (DomainException ex) {
            errors.add(toFieldError("[" + i + "]", ex));
        }
    }

    if (!errors.isEmpty()) {
        throw new ValidationFailedException(errors);   // ★ 觸發 rollback
    }
    return created.stream().map(mapper::toResponse).toList();
}
```

⚠️ **兩個常見的坑**：

| 坑 | 說明 |
|---|---|
| 例外被 catch 但沒重拋 | 交易不會 rollback，變成「部分成功」但回 `422` → **最糟的狀態** |
| 呼叫了外部 API（寄信、扣款） | 🔴 **外部呼叫無法 rollback**。要把它們移到交易外（用領域事件，02-spring-boot 第 06 章） |

**第二個坑的具體例子**：

```java
@Transactional
public void addItems(...) {
    for (...) {
        item = save(...);
        emailService.sendItemAddedNotification(...);   // 🔴 寄出去就收不回來
    }
    throw new ValidationFailedException(errors);        // 資料庫 rollback 了，信已經寄了
}
```

正確做法：交易內只發領域事件，`@TransactionalEventListener(phase = AFTER_COMMIT)` 才真正寄信。

---

## 4.12 不要把系統錯誤標成 4xx（監控的視角）

### 4.12.1 為什麼這件事這麼重要

**你的告警規則長這樣**：

```yaml
# Prometheus alert rule
- alert: HighErrorRate
  expr: |
    sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
      / sum(rate(http_server_requests_seconds_count[5m])) > 0.01
  for: 5m
  labels: { severity: critical }
  annotations: { summary: "5xx 錯誤率超過 1%" }
```

**如果你把系統錯誤標成 4xx，這個告警永遠不會響。**

### 4.12.2 常見的錯誤標記

| 實際問題 | 錯誤的標記 | 正確標記 |
|---|---|---|
| 資料庫連線池耗盡 | `400 Bad Request` | `503` + `Retry-After` |
| 下游服務掛了 | `400`（「參數錯誤」） | `502` |
| 下游服務超時 | `400` | `504` |
| Redis 連不上 | `400` | `503` |
| 程式 NPE | `400`（catch-all 寫成 400） | `500` |
| 磁碟滿了 | `400` | `500` 或 `507` |
| 設定檔缺少必要的值 | `400` | `500` |
| 反序列化自己的快取失敗 | `400` | `500` |

**最常見的來源是「catch-all 寫錯」**：

```java
// 🔴 這是災難的來源
@ExceptionHandler(Exception.class)
@ResponseStatus(HttpStatus.BAD_REQUEST)     // ← 全部變 400
public ApiProblem handle(Exception ex) {
    return ApiProblem.of("BAD_REQUEST", ex.getMessage());
}
```

**為什麼有人會這樣寫**：因為 `500` 會觸發告警，開發者被告警轟炸後想「先讓它安靜」。

**這是把溫度計砸掉來降溫。**

### 4.12.3 正確的做法：修告警，不是修狀態碼

**如果 5xx 告警太多，正確的處理順序是**：

```
1. 看是不是真的有 bug → 修 bug（多數情況）
2. 是不是某個外部依賴不穩 → 加熔斷 + 標成 503（正確的狀態碼）
3. 是不是告警閾值太敏感 → 調閾值（例如 1% → 2%，或 for: 5m → 10m）
4. 是不是某類錯誤不該告警 → 加 label 排除，而不是改狀態碼
```

**第 4 點的做法**：

```yaml
# 用 exception label 排除已知的、不需要值班處理的錯誤
- alert: HighErrorRate
  expr: |
    sum(rate(http_server_requests_seconds_count{
      status=~"5..",
      exception!~"PaymentGatewayTimeoutException|UpstreamUnavailableException"
    }[5m])) / sum(rate(http_server_requests_seconds_count[5m])) > 0.01
```

```yaml
# 那些排除的錯誤用另一條較寬鬆的告警
- alert: PaymentGatewayDegraded
  expr: |
    sum(rate(http_server_requests_seconds_count{status="504",uri=~"/orders/.*/payments"}[10m])) > 5
  for: 15m
  labels: { severity: warning }        # ← warning 不叫人起床
```

**這樣你保留了正確的狀態碼（監控與客戶端都對），同時控制了告警噪音。**

### 4.12.4 日誌等級也要對

```java
// ❌ 4xx 用 error → 日誌被驗證失敗灌爆 → 真正的錯誤被埋掉
log.error("驗證失敗: {}", errors);

// ✅ 依狀態碼決定等級
if (code.status().is5xxServerError()) {
    log.error("...", ex);                 // 含 stack trace
} else if (code.status().value() == 429) {
    log.info("限流: ...");                // 正常運作，不是錯誤
} else {
    log.warn("...");                       // 4xx：不含 stack trace
}
```

**為什麼 4xx 不該印 stack trace**：

| 理由 | 說明 |
|---|---|
| 4xx 是預期的 | 使用者填錯表單是正常流程，不是異常 |
| stack trace 很貴 | 產生 stack trace 有 CPU 成本；高頻 4xx 會影響效能 |
| 會埋掉真正的錯誤 | 日誌裡 99% 是驗證失敗的 stack trace，你找不到那 1% 的 NPE |
| 日誌量與成本 | 一個 stack trace 約 2～5KB，每天百萬次 4xx = 幾 GB |

**`429` 用 `info` 的理由**：限流被觸發表示保護機制**正常運作**，不是錯誤。
（但要有另外的指標監控「限流觸發次數」的趨勢 —— 暴增可能是攻擊。）

### 4.12.5 指標設計

**要能回答的問題**：

| 問題 | 指標 |
|---|---|
| 整體錯誤率 | `http_server_requests{status=~"5.."}` / total |
| 哪個端點在出錯 | 上面按 `uri` 分組 |
| 哪種業務錯誤在暴增 | **需要自訂指標**（見下） |
| 驗證失敗最常發生在哪個欄位 | 需要自訂指標 |

**自訂指標：業務錯誤碼**

```java
@Component
public class ErrorMetrics {
    private final MeterRegistry registry;

    public void record(ErrorCode code, String uri) {
        Counter.builder("api.errors")
               .tag("code", code.name())               // ★ 低基數（約 30 個值）
               .tag("status", String.valueOf(code.status().value()))
               .tag("uri", normalize(uri))             // ★ /orders/{id} 而不是 /orders/ord_123
               .register(registry)
               .increment();
    }
}
```

⚠️ **標籤必須是低基數**（02-spring-boot 第 05 章講過）。

```
✅ code = INSUFFICIENT_STOCK          約 30 個值
✅ uri = /orders/{orderId}/payments   約 55 個值（相異 URI 模板數）
❌ productId = P-1001                 可能幾萬個值 → 指標爆炸
❌ traceId = 4f2c...                  每次都不同 → 直接把 Prometheus 打掛
```

**有了這個指標，你可以做出很有價值的告警**：

```yaml
# 庫存不足暴增 → 可能是熱門商品缺貨，行銷要知道
- alert: InsufficientStockSpike
  expr: rate(api_errors_total{code="INSUFFICIENT_STOCK"}[10m]) > 10
  labels: { severity: warning, team: merchandising }

# 卡片被拒暴增 → 可能是金流商問題，或風控規則設太嚴
- alert: CardDeclinedSpike
  expr: |
    rate(api_errors_total{code="CARD_DECLINED"}[10m])
      / rate(api_errors_total{code=~"CARD_.*|PAYMENT_.*"}[10m]) > 0.3
  labels: { severity: critical, team: payments }

# 驗證失敗暴增在某個端點 → 可能是前端發版出 bug
- alert: ValidationFailureSpike
  expr: rate(api_errors_total{code="VALIDATION_FAILED"}[5m]) > 50
  labels: { severity: warning, team: frontend }
```

**注意最後一條**：`VALIDATION_FAILED` 暴增通常表示**前端剛發版且送錯格式**。
這是「4xx 也值得告警」的例子 —— 但用 `warning` 而不是 `critical`。

**這一節的總結**：

> **狀態碼是給機器的訊號，不要為了讓告警安靜而扭曲它。**
> 告警太多是告警規則的問題，用告警規則解決。

---

## 4.13 shop-service 錯誤目錄

這是本章的產出。第 07 章會把它寫進 `orders-api.yaml`。

### 4.13.1 通用錯誤

| `code` | 狀態碼 | `title` | `retryable` | 擴充欄位 |
|---|---|---|---|---|
| `MALFORMED_REQUEST` | 400 | 請求格式錯誤 | ❌ | `errors[]` |
| `VALIDATION_FAILED` | 422 | 請求內容驗證失敗 | ❌ | `errors[]` |
| `AUTHENTICATION_REQUIRED` | 401 | 需要登入 | ❌ | — |
| `INVALID_TOKEN` | 401 | 憑證無效 | ❌ | — |
| `TOKEN_EXPIRED` | 401 | 憑證已過期 | ✅ `REFRESH_TOKEN_THEN_RETRY` | `expiredAt` |
| `TOKEN_REVOKED` | 401 | 憑證已失效 | ❌ | `revokedAt` |
| `INSUFFICIENT_ROLE` | 403 | 權限不足 | ❌ | `requiredRole` |
| `INSUFFICIENT_SCOPE` | 403 | 授權範圍不足 | ❌ | `requiredScope` |
| `ACCOUNT_SUSPENDED` | 403 | 帳號已停權 | ❌ | `suspendedAt`, `reason` |
| `FORBIDDEN_PARAMETER` | 403 | 無權使用此參數 | ❌ | `parameter` |
| `RESOURCE_NOT_FOUND` | 404 | 資源不存在 | ❌ | `resourceType`, `resourceId` |
| `METHOD_NOT_ALLOWED` | 405 | 不支援此方法 | ❌ | `allowedMethods[]` |
| `NOT_ACCEPTABLE` | 406 | 無法提供要求的格式 | ❌ | `supportedTypes[]` |
| `RESOURCE_GONE` | 410 | 資源已永久移除 | ❌ | `removedAt`, `replacementId` |
| `IF_MATCH_REQUIRED` | 428 | 必須帶 If-Match | ❌ | — |
| `OPTIMISTIC_LOCK_CONFLICT` | 412 | 資料已被其他人修改 | ✅ `REFETCH_THEN_RETRY` | `expectedVersion`, `currentVersion`, `modifiedBy`, `modifiedAt` |
| `PAYLOAD_TOO_LARGE` | 413 | 請求內容過大 | ❌ | `maxBytes`, `actualBytes` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 不支援的內容類型 | ❌ | `supportedTypes[]` |
| `RATE_LIMIT_EXCEEDED` | 429 | 請求過於頻繁 | ✅ `BACKOFF_AND_RETRY` | `limit`, `remaining`, `resetAt`, `retryAfterSeconds` |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | 缺少冪等鍵 | ❌ | — |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 冪等鍵被用於不同的請求 | ❌ | `originalRequestHash` |
| `INTERNAL_ERROR` | 500 | 系統錯誤 | ❌ | — |
| `UPSTREAM_ERROR` | 502 | 上游服務異常 | ✅ | — |
| `SERVICE_UNAVAILABLE` | 503 | 服務暫時無法使用 | ✅ | `retryAfterSeconds` |
| `UPSTREAM_TIMEOUT` | 504 | 上游服務超時 | ⚠️ 需冪等鍵 | — |

### 4.13.2 訂單錯誤

| `code` | 狀態碼 | `title` | `userMessage` | 擴充欄位 |
|---|---|---|---|---|
| `ORDER_NOT_CANCELLABLE` | 409 | 訂單無法取消 | 此訂單已{statusLabel}，無法取消。如需協助請聯絡客服。 | `orderNumber`, `currentStatus`, `cancellableStatuses[]` |
| `ORDER_ALREADY_PAID` | 409 | 訂單已付款 | 此訂單已完成付款。 | `orderNumber`, `paidAt`, `paymentId` |
| `ORDER_ALREADY_CANCELLED` | 409 | 訂單已取消 | 此訂單已於 {cancelledAt} 取消。 | `orderNumber`, `cancelledAt` |
| `ORDER_EXPIRED` | 409 | 訂單已逾時 | 此訂單因超過付款期限已自動取消，請重新下單。 | `orderNumber`, `expiredAt` |
| `ORDER_NOT_SHIPPABLE` | 409 | 訂單無法出貨 | — | `orderNumber`, `currentStatus` |
| `ORDER_NOT_RETURNABLE` | 409 | 訂單無法退貨 | 已超過 7 天退貨期限（{returnableUntil}）。 | `orderNumber`, `returnableUntil` |
| `ORDER_ITEM_IMMUTABLE` | 409 | 訂單明細不可修改 | 訂單成立後無法修改商品，請取消後重新下單。 | `orderNumber` |
| `ORDER_EMPTY` | 422 | 訂單無商品 | 請至少選擇一項商品。 | — |
| `ORDER_ITEM_LIMIT_EXCEEDED` | 422 | 商品項數超過上限 | 單筆訂單最多 50 項商品。 | `max`, `actual` |
| `ORDER_AMOUNT_MISMATCH` | 422 | 金額不符 | 訂單金額已變動，請重新確認。 | `expectedAmount`, `providedAmount` |

### 4.13.3 商品與庫存錯誤

| `code` | 狀態碼 | `title` | 擴充欄位 |
|---|---|---|---|
| `PRODUCT_NOT_FOUND` | 422 | 商品不存在 | `productId` |
| `PRODUCT_DISCONTINUED` | 410 | 商品已下架 | `productId`, `discontinuedAt`, `replacementProductId` |
| `PRODUCT_NOT_PURCHASABLE` | 422 | 商品目前無法購買 | `productId`, `reason` |
| `INSUFFICIENT_STOCK` | 409 | 庫存不足 | `productId`, `productName`, `requested`, `available`, `restockEstimatedAt` |
| `NEGATIVE_STOCK_NOT_ALLOWED` | 409 | 庫存調整會導致負庫存 | `productId`, `current`, `delta` |
| `PRODUCT_SKU_DUPLICATE` | 409 | SKU 重複 | `sku`, `existingProductId` |
| `PURCHASE_LIMIT_EXCEEDED` | 422 | 超過購買限制 | `productId`, `limitPerCustomer`, `alreadyPurchased` |

### 4.13.4 付款與退款錯誤

| `code` | 狀態碼 | `title` | `retryable` | 擴充欄位 |
|---|---|---|---|---|
| `CARD_NUMBER_INVALID` | 422 | 卡號格式錯誤 | ❌ | — |
| `CARD_EXPIRED` | 422 | 卡片已過期 | ❌ | — |
| `CVV_INVALID` | 422 | 安全碼錯誤 | ❌ | — |
| `CARD_DECLINED` | 402 | 卡片被拒絕 | ❌ | `declineCode`, `issuerMessage` |
| `INSUFFICIENT_FUNDS` | 402 | 餘額不足 | ❌ | — |
| `EXCEEDS_CREDIT_LIMIT` | 402 | 超過信用額度 | ❌ | — |
| `PAYMENT_METHOD_UNSUPPORTED` | 422 | 不支援此付款方式 | ❌ | `supportedMethods[]` |
| `THREE_DS_REQUIRED` | 202 | 需要 3D 驗證 | — | `nextAction.type`, `nextAction.redirectUrl` |
| `PAYMENT_DECLINED` | 402 | 交易無法完成 | ❌ | （風控，刻意模糊，4.7.4） |
| `PAYMENT_ALREADY_IN_PROGRESS` | 409 | 已有付款正在處理 | ✅ `CHECK_STATUS` | `paymentId`, `statusCheckUrl` |
| `PAYMENT_OUTCOME_UNKNOWN` | 504 | 付款結果未知 | ⚠️ `CHECK_STATUS` | `statusCheckUrl`, `recommendedCheckAfterSeconds` |
| `PAYMENT_GATEWAY_TIMEOUT` | 504 | 金流商超時 | ✅（需冪等鍵） | — |
| `PAYMENT_GATEWAY_UNAVAILABLE` | 503 | 金流商維護中 | ✅ | `retryAfterSeconds`, `estimatedRecoveryAt` |
| `REFUND_EXCEEDS_PAYMENT` | 422 | 退款金額超過付款金額 | ❌ | `paymentAmount`, `alreadyRefunded`, `requested` |
| `REFUND_WINDOW_EXPIRED` | 409 | 超過可退款期限 | ❌ | `refundableUntil` |
| `PAYMENT_NOT_REFUNDABLE` | 409 | 此付款無法退款 | ❌ | `paymentStatus` |

### 4.13.5 折扣碼與購物車錯誤

| `code` | 狀態碼 | `title` | 擴充欄位 |
|---|---|---|---|
| `COUPON_NOT_FOUND` | 404 | 折扣碼不存在 | `code` |
| `COUPON_EXPIRED` | 422 | 折扣碼已過期 | `code`, `expiredAt` |
| `COUPON_NOT_STARTED` | 422 | 折扣碼尚未生效 | `code`, `startsAt` |
| `COUPON_EXHAUSTED` | 409 | 折扣碼已用完 | `code` |
| `COUPON_ALREADY_USED` | 409 | 您已使用過此折扣碼 | `code`, `usedAt` |
| `COUPON_MIN_AMOUNT_NOT_MET` | 422 | 未達折扣碼最低消費 | `code`, `minAmount`, `currentAmount` |
| `COUPON_NOT_APPLICABLE` | 422 | 折扣碼不適用於購物車商品 | `code`, `applicableCategories[]` |
| `CART_EMPTY` | 422 | 購物車為空 | — |
| `CART_ITEM_NOT_FOUND` | 404 | 購物車項目不存在 | `itemId` |

### 4.13.6 完整範例集

**1) 驗證失敗（`422`）** —— 見 4.6.1。

**2) 庫存不足（`409`）**

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
Cache-Control: no-store
```
```jsonc
{
  "type": "https://api.shop.example/problems/insufficient-stock",
  "title": "庫存不足",
  "status": 409,
  "detail": "Product P-1001 has 3 units available but 5 were requested in items[2].",
  "instance": "/orders",
  "code": "INSUFFICIENT_STOCK",
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。",
  "errors": [
    { "field": "items[2].quantity", "code": "INSUFFICIENT_STOCK",
      "message": "僅剩 3 件", "rejectedValue": 5, "constraint": { "available": 3 } }
  ],
  "productId": "P-1001",
  "productName": "無線降噪耳機 Pro",
  "requested": 5,
  "available": 3,
  "restockEstimatedAt": "2026-08-22",
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

**3) 訂單無法取消（`409`）**

```jsonc
{
  "type": "https://api.shop.example/problems/order-not-cancellable",
  "title": "訂單無法取消",
  "status": 409,
  "detail": "Order ORD-20260819-0001 is in SHIPPED state; cancellable states are PENDING_PAYMENT, PAID.",
  "instance": "/orders/ord_01J5GK.../cancellations",
  "code": "ORDER_NOT_CANCELLABLE",
  "userMessage": "此訂單已出貨，無法取消。您可以在收到商品後 7 天內申請退貨。",
  "orderNumber": "ORD-20260819-0001",
  "currentStatus": "SHIPPED",
  "currentStatusLabel": "已出貨",
  "cancellableStatuses": ["PENDING_PAYMENT", "PAID"],
  "alternativeAction": {
    "code": "REQUEST_RETURN",
    "label": "申請退貨",
    "href": "/orders/ord_01J5GK.../returns",
    "method": "POST",
    "availableUntil": "2026-08-28"
  },
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**`alternativeAction` 是很高價值的欄位**：
它把「不能做 A」變成「不能做 A，但可以做 B」，前端可以直接顯示替代按鈕。
使用者不會卡住，客服也少一通電話。

**4) 卡片被拒（`402`）**

```jsonc
{
  "type": "https://api.shop.example/problems/card-declined",
  "title": "卡片被拒絕",
  "status": 402,
  "detail": "The card was declined by the issuing bank.",
  "instance": "/orders/ord_01J5GK.../payments",
  "code": "INSUFFICIENT_FUNDS",
  "userMessage": "您的卡片餘額不足，請改用其他付款方式。",
  "declineCode": "insufficient_funds",
  "cardLast4": "4242",
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",
  "alternativeAction": {
    "code": "CHANGE_PAYMENT_METHOD",
    "label": "更換付款方式",
    "supportedMethods": ["CREDIT_CARD", "ATM_TRANSFER", "CONVENIENCE_STORE", "LINE_PAY"]
  },
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**5) 樂觀鎖衝突（`412`）**

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json
ETag: "v8"
```
```jsonc
{
  "type": "https://api.shop.example/problems/version-conflict",
  "title": "資料已被其他人修改",
  "status": 412,
  "detail": "Expected version v7 but current is v8.",
  "instance": "/orders/ord_01J5GK...",
  "code": "OPTIMISTIC_LOCK_CONFLICT",
  "userMessage": "此訂單已被李客服於 14:14 修改，請重新載入後再試。",
  "expectedVersion": "v7",
  "currentVersion": "v8",
  "modifiedBy": { "type": "SUPPORT", "displayName": "李客服" },
  "modifiedAt": "2026-08-19T06:14:02Z",
  "retryable": true,
  "retryStrategy": "REFETCH_THEN_RETRY",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**6) 限流（`429`）**

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1755584006
Content-Type: application/problem+json
```
```jsonc
{
  "type": "https://api.shop.example/problems/rate-limit-exceeded",
  "title": "請求過於頻繁",
  "status": 429,
  "detail": "Rate limit of 100 requests per minute exceeded for this API key.",
  "instance": "/orders",
  "code": "RATE_LIMIT_EXCEEDED",
  "userMessage": "操作過於頻繁，請 42 秒後再試。",
  "limit": 100,
  "windowSeconds": 60,
  "remaining": 0,
  "resetAt": "2026-08-19T06:13:26Z",
  "retryAfterSeconds": 42,
  "retryable": true,
  "retryStrategy": "BACKOFF_AND_RETRY",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**7) 系統錯誤（`500`）**

```jsonc
{
  "type": "https://api.shop.example/problems/internal-error",
  "title": "系統錯誤",
  "status": 500,
  "detail": "An unexpected error occurred. Provide the traceId when contacting support.",
  "instance": "/orders",
  "code": "INTERNAL_ERROR",
  "userMessage": "系統暫時發生問題，請稍後再試。若持續發生，請聯絡客服並提供追蹤碼 4f2c8a1e。",
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

**注意 `detail` 完全不透露任何內部資訊**（4.7.3）。

**8) 服務維護（`503`）**

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 1800
```
```jsonc
{
  "type": "https://api.shop.example/problems/payment-gateway-unavailable",
  "title": "金流服務維護中",
  "status": 503,
  "detail": "The payment gateway is under scheduled maintenance until 2026-08-19T08:00:00Z.",
  "instance": "/orders/ord_01J5GK.../payments",
  "code": "PAYMENT_GATEWAY_UNAVAILABLE",
  "userMessage": "付款服務維護中，預計 16:00 恢復。您的訂單已保留，稍後可繼續付款。",
  "estimatedRecoveryAt": "2026-08-19T08:00:00Z",
  "retryAfterSeconds": 1800,
  "retryable": true,
  "retryStrategy": "BACKOFF_AND_RETRY",
  "alternativeAction": {
    "code": "CHANGE_PAYMENT_METHOD",
    "label": "改用 ATM 轉帳",
    "supportedMethods": ["ATM_TRANSFER", "CONVENIENCE_STORE"]
  },
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**注意 `userMessage` 說「您的訂單已保留」** ——
這一句話避免了大量「我的訂單會不會不見」的客服詢問。

### 4.13.7 錯誤目錄的自我檢核

```
□ 每個 code 都有唯一的 type URI
□ 每個 code 都有固定的狀態碼（不會在不同地方回不同的）
□ 每個 code 都有 title（zh-TW + en）
□ 每個 4xx 的 code 都有 userMessage（使用者能理解且知道下一步）
□ 每個 code 的擴充欄位都有明確定義（且相同 code 一定有這些欄位）
□ 每個 code 都標了 retryable 與 retryStrategy
□ 所有 code 都有 traceId
□ 5xx 的 detail 不含任何內部資訊
□ 風控相關的 code 已模糊化
□ 沒有洩漏使用者存在性的 code（登入一律 INVALID_CREDENTIALS）
□ rejectedValue 不會回顯敏感欄位
□ 每個 type URI 有對應的文件頁面
□ 錯誤碼總數在客戶端可窮舉處理的範圍（< 60 個）
```

**最後一條的判準**：如果客戶端需要為 200 個錯誤碼各寫一個分支，那就太多了。
客戶端通常只需要對 10～20 個做特殊處理，其餘用 `userMessage` 通用顯示。

---

## 4.14 前端怎麼消費錯誤

**這一節證明前面的設計是否值得。**

### 4.14.1 TypeScript 型別

```typescript
// api/problem.ts
export interface ApiProblem {
  // RFC 9457 標準欄位
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;

  // 我們的擴充欄位（契約保證）
  code: string;
  userMessage: string;
  traceId: string;
  timestamp: string;
  retryable: boolean;
  retryStrategy?: 'BACKOFF_AND_RETRY' | 'REFETCH_THEN_RETRY'
                | 'REFRESH_TOKEN_THEN_RETRY' | 'MODIFY_REQUEST' | 'CHECK_STATUS';
  retryAfterSeconds?: number;
  errors?: FieldError[];
  alternativeAction?: AlternativeAction;

  // 型別特有的擴充欄位
  [key: string]: unknown;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
  messageKey?: string;
  rejectedValue?: unknown;
  constraint?: Record<string, unknown>;
}

export interface AlternativeAction {
  code: string;
  label: string;
  href?: string;
  method?: string;
  availableUntil?: string;
  supportedMethods?: string[];
}

export class ApiError extends Error {
  constructor(public readonly problem: ApiProblem, public readonly response: Response) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
}
```

**型別特有欄位的窄化**（讓 TS 幫你檢查）：

```typescript
interface InsufficientStockProblem extends ApiProblem {
  code: 'INSUFFICIENT_STOCK';
  productId: string;
  productName: string;
  requested: number;
  available: number;
  restockEstimatedAt?: string;
}

function isInsufficientStock(p: ApiProblem): p is InsufficientStockProblem {
  return p.code === 'INSUFFICIENT_STOCK';
}

// 使用時有完整的型別提示
if (isInsufficientStock(problem)) {
  console.log(problem.available);   // ✅ number，不是 unknown
}
```

### 4.14.2 統一的請求封裝

```typescript
// api/client.ts
export async function request<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (init.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey);

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  throw new ApiError(await parseProblem(res), res);
}

async function parseProblem(res: Response): Promise<ApiProblem> {
  const contentType = res.headers.get('Content-Type') ?? '';

  if (contentType.includes('json')) {
    try {
      const body = await res.json();
      // ★ 防禦：確保必要欄位存在（後端可能有漏，或是 Nginx 的錯誤頁）
      return {
        type: body.type ?? 'about:blank',
        title: body.title ?? res.statusText,
        status: body.status ?? res.status,
        code: body.code ?? `HTTP_${res.status}`,
        userMessage: body.userMessage ?? body.title ?? '發生錯誤，請稍後再試。',
        traceId: body.traceId ?? res.headers.get('X-Request-Id') ?? '',
        timestamp: body.timestamp ?? new Date().toISOString(),
        retryable: body.retryable ?? res.status >= 500,
        ...body,
      };
    } catch {
      /* 不是合法 JSON，落到下面 */
    }
  }

  // ★ 非 JSON 回應（Nginx HTML 錯誤頁、Cloudflare 攔截頁）
  return {
    type: 'about:blank',
    title: res.statusText || '網路錯誤',
    status: res.status,
    code: `HTTP_${res.status}`,
    userMessage: res.status >= 500
      ? '系統暫時無法使用，請稍後再試。'
      : '請求無法完成，請稍後再試。',
    traceId: res.headers.get('X-Request-Id') ?? '',
    timestamp: new Date().toISOString(),
    retryable: res.status >= 500 || res.status === 429,
  };
}
```

**`parseProblem` 的防禦性設計很重要**：
即使後端漏了某個欄位，或者請求根本沒到後端（Nginx 502、Cloudflare 攔截），
前端也不會爆掉。**這是「後端做對」和「前端仍要防禦」並行的例子。**

### 4.14.3 錯誤處理的分派

```typescript
// api/error-handler.ts
export async function handleApiError(
  error: unknown,
  ctx: { retry?: () => Promise<void>; form?: FormApi }
): Promise<void> {
  if (!(error instanceof ApiError)) {
    toast.error('網路連線異常，請檢查網路後再試。');
    return;
  }

  const p = error.problem;

  // ① 上報監控（帶 traceId，可以和後端日誌對起來）
  if (p.status >= 500) {
    Sentry.captureException(error, {
      tags: { traceId: p.traceId, errorCode: p.code, status: p.status },
      contexts: { problem: p },
    });
  }

  // ② 驗證錯誤 → 標到表單欄位
  if (p.errors?.length && ctx.form) {
    p.errors.forEach(e => ctx.form!.setFieldError(e.field, e.message));
    // 捲動到第一個錯誤欄位
    ctx.form.scrollToField(p.errors[0].field);
    return;
  }

  // ③ 認證問題 → 刷新 token 後重試
  if (p.retryStrategy === 'REFRESH_TOKEN_THEN_RETRY') {
    const ok = await auth.refresh();
    if (ok && ctx.retry) { await ctx.retry(); return; }
    router.push('/login?reason=session_expired');
    return;
  }

  // ④ 樂觀鎖衝突 → 顯示衝突對話框
  if (p.code === 'OPTIMISTIC_LOCK_CONFLICT') {
    showConflictDialog({
      message: p.userMessage,
      onReload: () => ctx.retry?.(),
    });
    return;
  }

  // ⑤ 有替代動作 → 顯示雙按鈕對話框
  if (p.alternativeAction) {
    showDialog({
      title: p.title,
      message: p.userMessage,
      primary: {
        label: p.alternativeAction.label,
        onClick: () => performAlternative(p.alternativeAction!),
      },
      secondary: { label: '取消' },
    });
    return;
  }

  // ⑥ 可自動重試 → 顯示倒數 + 自動重試
  if (p.retryable && p.retryStrategy === 'BACKOFF_AND_RETRY' && ctx.retry) {
    const seconds = p.retryAfterSeconds ?? 5;
    toast.warning(`${p.userMessage}（${seconds} 秒後自動重試）`);
    setTimeout(() => ctx.retry!(), seconds * 1000);
    return;
  }

  // ⑦ 通用：顯示 userMessage + traceId（5xx 才顯示 traceId）
  toast.error(p.userMessage, {
    description: p.status >= 500 && p.traceId
      ? `追蹤碼：${p.traceId.slice(0, 8)}`
      : undefined,
    action: p.status >= 500 && p.traceId
      ? { label: '複製追蹤碼', onClick: () => navigator.clipboard.writeText(p.traceId) }
      : undefined,
  });
}
```

**注意這整段程式碼裡沒有一個硬編碼的中文訊息**（除了通用的網路錯誤）。
**所有文案都來自後端的 `userMessage`。**

**這就是前面所有設計的回報**：
- PM 想改文案 → 改後端的 `messages.properties`，前端不用發版。
- 新增錯誤碼 → 前端自動用 ⑦ 的通用路徑處理，不會壞掉。
- 需要特殊 UI → 加一個 `if (p.code === '...')` 分支。

### 4.14.4 特定情境的客製處理

```typescript
// features/checkout/checkout.ts
async function submitOrder(cart: Cart) {
  try {
    const order = await request<OrderDetail>('/orders', {
      method: 'POST',
      body: JSON.stringify(toCreateOrderRequest(cart)),
      idempotencyKey: cart.idempotencyKey,       // ★ 整個結帳流程共用一個 key
    });
    router.push(`/orders/${order.orderId}`);

  } catch (err) {
    if (err instanceof ApiError && isInsufficientStock(err.problem)) {
      const p = err.problem;
      const confirmed = await showDialog({
        title: '庫存不足',
        message: p.userMessage,
        primary: { label: `改為 ${p.available} 件` },
        secondary: { label: '移除此商品' },
      });
      if (confirmed) {
        await updateCartQuantity(p.productId, p.available);
        return submitOrder(await refetchCart());       // 更新後重試
      }
      await removeFromCart(p.productId);
      return;
    }

    if (err instanceof ApiError && err.problem.code === 'ORDER_AMOUNT_MISMATCH') {
      // 金額變了（促銷結束、運費調整）→ 讓使用者重新確認
      await showDialog({
        title: '金額已變動',
        message: err.problem.userMessage,
        primary: { label: '重新確認' },
      });
      return refreshCheckout();
    }

    await handleApiError(err, { retry: () => submitOrder(cart), form: checkoutForm });
  }
}
```

**注意 `idempotencyKey` 在整個結帳流程共用一個**：
使用者調整數量後重試，用**同一個 key** —— 這樣即使第一次其實成功了（只是回應丟了），
第二次也會拿到同一張訂單，不會重複下單。

⚠️ **但這裡有一個微妙的問題**：如果請求內容變了（數量從 5 改成 3），
用同一個冪等鍵會怎樣？

正確的伺服器行為是回 `409 IDEMPOTENCY_KEY_REUSED`（4.13.1）：

```jsonc
{
  "code": "IDEMPOTENCY_KEY_REUSED",
  "status": 409,
  "title": "冪等鍵已用於不同的請求",
  "detail": "The Idempotency-Key was previously used with a different request body.",
  "userMessage": "請求已變更，請重新送出。"
}
```

**所以正確的前端行為是：改動內容後產生新的冪等鍵。**

```typescript
if (confirmed) {
  await updateCartQuantity(p.productId, p.available);
  const updated = await refetchCart();
  updated.idempotencyKey = crypto.randomUUID();     // ★ 內容變了 → 新 key
  return submitOrder(updated);
}
```

（第 08 章會詳談冪等鍵的完整語意。）

---

## 4.15 常見誤區

**誤區 1：「錯誤訊息越詳細越好」**
給**開發者**的訊息越詳細越好（進日誌），
給**客戶端**的訊息要在「夠用」和「不洩漏」之間平衡（4.7.3）。

**誤區 2：「回 `500` 比較安全，反正不透露細節」**
`500` 表示「我們的 bug」，會觸發告警、會算進 SLO。
把 4xx 標成 `500` 會讓值班工程師被使用者的輸入錯誤叫醒。

**誤區 3：「把系統錯誤標成 `400` 可以讓告警安靜」**
4.12：這是砸溫度計。正確做法是調告警規則。

**誤區 4：「`title` 就是給使用者看的訊息」**
`title` 是**類型**的摘要（固定），`userMessage` 是給使用者的**行動指示**。
`title` 要能拿去分組統計（4.4.2）。

**誤區 5：「有 `message` 就不需要 `code`」**
文案會改，`code` 不會。用訊息內容做判斷的前端會在改文案時壞掉（4.7.2）。

**誤區 6：「驗證錯誤一個一個回比較簡單」**
使用者要送出五次才知道全部問題。Bean Validation 預設就會收集全部（4.6.2）。

**誤區 7：「`rejectedValue` 一律回顯比較好除錯」**
密碼、卡號、CVV 絕對不能回顯（4.6.2 要點 4）。

**誤區 8：「`traceId` 只要進日誌就好，不用回給客戶端」**
那客服拿到的就只有「系統錯誤」，回到 4.2.1 的一整天。

**誤區 9：「`retryable: true` 就可以安全重試」**
🔴 前提是操作冪等。沒有冪等鍵的 `POST` 標 `retryable: true` 會造成重複扣款（4.9.4）。

**誤區 10：「客戶端會自己做指數退避」**
不會。要在文件裡教，而且要給 `Retry-After`。
沒有抖動的重試會變成對你的 DDoS（4.9.3）。

**誤區 11：「Spring Boot 3 開了 `problemdetails` 就完成了」**
那只讓框架例外用 Problem Details 格式，
`type` 還是 `about:blank`、`title` 還是英文、沒有 `code`／`traceId`／`userMessage`。
而且 **Spring Security 的 401/403 完全不受影響**（4.10.3）。

**誤區 12：「批次操作回 `207` 就好」**
先判斷「項目間有關聯嗎」。訂單明細的部分成功會產生金額錯誤 → 必須 atomic（4.11.3）。

**誤區 13：「錯誤格式定好了就不會變」**
錯誤格式也是契約。新增擴充欄位是安全的，但**移除或改變欄位語意是破壞性變更**
（第 06 章的規則同樣適用）。

---

## 4.16 本章練習

### 練習 1：改寫糟糕的錯誤回應

以下是某系統的錯誤回應。改寫成符合本章標準的版本。

```jsonc
// 情境 1：使用者送了空的訂單
HTTP/1.1 200 OK
{ "code": -1, "msg": "參數錯誤" }

// 情境 2：訂單已出貨但使用者想取消
HTTP/1.1 500 Internal Server Error
{ "error": "IllegalStateException", "message": "order status is SHIPPED" }

// 情境 3：資料庫唯一鍵衝突
HTTP/1.1 500
Content-Type: text/html
<html><body>Whitelabel Error Page ... org.hibernate.exception.ConstraintViolationException:
could not execute statement; SQL [insert into t_order (order_no,...) values (?,...)];
constraint [uk_order_no] ...</body></html>

// 情境 4：金流商超時
HTTP/1.1 200 OK
{ "success": false, "errorMessage": "timeout" }

// 情境 5：token 過期
HTTP/1.1 403 Forbidden
{ "message": "Forbidden" }
```

<details>
<summary>參考解答</summary>

**情境 1：空訂單**

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
```
```jsonc
{
  "type": "https://api.shop.example/problems/validation-failed",
  "title": "請求內容驗證失敗",
  "status": 422,
  "detail": "Field 'items' must contain at least one element.",
  "instance": "/orders",
  "code": "VALIDATION_FAILED",
  "userMessage": "請至少選擇一項商品。",
  "errors": [
    { "field": "items", "code": "REQUIRED",
      "message": "訂單至少需要一項商品", "rejectedValue": [] }
  ],
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

修正的四點：`200` → `422`；加 `code`；加 `errors` 定位到欄位；加 `traceId`。

**情境 2：訂單已出貨**

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
```
```jsonc
{
  "type": "https://api.shop.example/problems/order-not-cancellable",
  "title": "訂單無法取消",
  "status": 409,
  "detail": "Order ORD-20260819-0001 is in SHIPPED state; cancellable states are PENDING_PAYMENT, PAID.",
  "instance": "/orders/ord_01J5GK.../cancellations",
  "code": "ORDER_NOT_CANCELLABLE",
  "userMessage": "此訂單已出貨，無法取消。您可以在收到商品後 7 天內申請退貨。",
  "orderNumber": "ORD-20260819-0001",
  "currentStatus": "SHIPPED",
  "currentStatusLabel": "已出貨",
  "cancellableStatuses": ["PENDING_PAYMENT", "PAID"],
  "alternativeAction": {
    "code": "REQUEST_RETURN", "label": "申請退貨",
    "href": "/orders/ord_01J5GK.../returns", "method": "POST"
  },
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

修正的五點：
🔴 **`500` → `409`**（這是使用者的操作問題，不是我們的 bug —— 會誤觸告警）；
移除例外類別名（洩漏實作）；加 `userMessage` 說明下一步；
加 `alternativeAction` 讓使用者不卡住；加 `traceId`。

**情境 3：唯一鍵衝突**

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
```
```jsonc
{
  "type": "https://api.shop.example/problems/order-number-conflict",
  "title": "訂單編號衝突",
  "status": 409,
  "detail": "An order with the same order number already exists.",
  "instance": "/orders",
  "code": "ORDER_NUMBER_CONFLICT",
  "userMessage": "訂單建立失敗，請重新送出。",
  "retryable": true,
  "retryStrategy": "BACKOFF_AND_RETRY",
  "retryAfterSeconds": 1,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

日誌（**只有這裡才有細節**）：
```
ERROR [shop-service] [traceId=4f2c8a1e9b7d3f60]
  訂單編號衝突 constraint=uk_order_no orderNo=ORD-20260819-0001
  org.hibernate.exception.ConstraintViolationException: ...（完整 stack trace）
```

修正的五點：
🔴 **移除 HTML 錯誤頁**（前端 `res.json()` 會拋 `SyntaxError`）；
🔴 **移除 SQL、資料表名、約束名**（洩漏 schema）；
`500` → `409`（唯一鍵衝突是狀態衝突）；
標 `retryable: true`（重新產生編號就會成功）；
細節只進日誌。

⚠️ **另外要修的是根因**：訂單編號衝突表示編號產生機制有併發問題
（第 01 章 1.16 練習 5 的原子遞增）。API 層的修正只是止血。

**情境 4：金流商超時**

```http
HTTP/1.1 504 Gateway Timeout
Content-Type: application/problem+json
```
```jsonc
{
  "type": "https://api.shop.example/problems/payment-outcome-unknown",
  "title": "付款結果未知",
  "status": 504,
  "detail": "The payment gateway did not respond within 30s. The payment may or may not have been completed.",
  "instance": "/orders/ord_01J5GK.../payments",
  "code": "PAYMENT_OUTCOME_UNKNOWN",
  "userMessage": "付款正在處理中，請稍候並查看訂單狀態。請勿重複付款。",
  "retryable": false,
  "retryStrategy": "CHECK_STATUS",
  "statusCheckUrl": "/orders/ord_01J5GK.../payments",
  "recommendedCheckAfterSeconds": 10,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

修正的四點：
🔴 **`200` → `504`**（全回 200 讓監控看不到金流問題）；
用 `PAYMENT_OUTCOME_UNKNOWN` 而不是 `TIMEOUT`（更精確地描述業務狀態）；
**`retryable: false` + `CHECK_STATUS`**（因為結果未知，重試可能重複扣款 —— 4.9.4）；
`userMessage` 明確說「請勿重複付款」。

**如果這個端點強制要求 `Idempotency-Key`**，就可以標 `retryable: true`：

```jsonc
{
  "code": "PAYMENT_GATEWAY_TIMEOUT",
  "status": 504,
  "userMessage": "付款處理超時，請稍後再試。",
  "retryable": true,
  "retryStrategy": "BACKOFF_AND_RETRY",
  "retryAfterSeconds": 5,
  "note": "重試請使用相同的 Idempotency-Key"
}
```

**情境 5：token 過期**

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="shop-api", error="invalid_token",
                  error_description="The access token expired at 2026-08-19T06:00:00Z"
Content-Type: application/problem+json
```
```jsonc
{
  "type": "https://api.shop.example/problems/token-expired",
  "title": "憑證已過期",
  "status": 401,
  "detail": "The access token expired at 2026-08-19T06:00:00Z.",
  "instance": "/orders",
  "code": "TOKEN_EXPIRED",
  "userMessage": "登入已逾時，請重新登入。",
  "expiredAt": "2026-08-19T06:00:00Z",
  "retryable": true,
  "retryStrategy": "REFRESH_TOKEN_THEN_RETRY",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

修正的四點：
🔴 **`403` → `401`**（第 02 章 2.9.1 —— 回 `403` 會讓前端不刷新 token，使用者被登出）；
加 `WWW-Authenticate`（RFC 9110 要求，且 `error="invalid_token"` 來自 RFC 6750）；
`retryStrategy: REFRESH_TOKEN_THEN_RETRY`（明確告訴前端該做什麼）；
`code` 區分 `TOKEN_EXPIRED` / `INVALID_TOKEN` / `TOKEN_REVOKED`（前端可以分別處理）。

**這一題的總結**：五個情境裡有 **4 個狀態碼是錯的**，
其中 2 個會造成告警誤觸（`500`），1 個會造成登出迴圈（`403`），
1 個會讓監控完全看不到問題（`200`）。**狀態碼是錯誤設計裡影響最大的單一決定。**

</details>

### 練習 2：設計驗證錯誤回應

以下請求有 7 個錯誤。設計完整的錯誤回應。

```jsonc
POST /customers
Content-Type: application/json

{
  "email": "not-an-email",
  "password": "123",
  "confirmPassword": "1234",
  "displayName": "",
  "birthDate": "2030-01-01",
  "phone": "091234567",
  "addresses": [
    { "recipient": "王小明", "postalCode": "104", "line1": "民生東路" },
    { "recipient": "", "postalCode": "abcde", "line1": "" }
  ],
  "acceptTerms": false
}
```

規則：Email 格式；密碼至少 8 字元含大小寫與數字；兩次密碼須相同；
暱稱 1～20 字；生日不可為未來；手機須為 10 位數字以 09 開頭；
郵遞區號 3 或 5 位數字；必須同意條款。

<details>
<summary>參考解答</summary>

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
Cache-Control: no-store
```

```jsonc
{
  "type": "https://api.shop.example/problems/validation-failed",
  "title": "請求內容驗證失敗",
  "status": 422,
  "detail": "9 field(s) failed validation.",
  "instance": "/customers",
  "code": "VALIDATION_FAILED",
  "userMessage": "部分欄位填寫有誤，請檢查後再送出。",
  "errors": [
    {
      "field": "email",
      "code": "EMAIL",
      "message": "Email 格式不正確",
      "messageKey": "validation.email",
      "rejectedValue": "not-an-email"
    },
    {
      "field": "password",
      "code": "MIN_LENGTH",
      "message": "密碼至少 8 個字元",
      "messageKey": "validation.minLength",
      "rejectedValue": "***",
      "constraint": { "min": 8, "actual": 3 }
    },
    {
      "field": "password",
      "code": "PATTERN",
      "message": "密碼須包含大寫字母、小寫字母與數字",
      "messageKey": "validation.password.complexity",
      "rejectedValue": "***"
    },
    {
      "field": "confirmPassword",
      "code": "INVALID_COMBINATION",
      "message": "兩次輸入的密碼不一致",
      "messageKey": "validation.passwordMismatch",
      "rejectedValue": "***",
      "constraint": { "relatedField": "password" }
    },
    {
      "field": "displayName",
      "code": "REQUIRED",
      "message": "暱稱為必填",
      "messageKey": "validation.required",
      "rejectedValue": ""
    },
    {
      "field": "birthDate",
      "code": "PAST",
      "message": "生日不可為未來日期",
      "messageKey": "validation.past",
      "rejectedValue": "2030-01-01",
      "constraint": { "maxDate": "2026-08-19" }
    },
    {
      "field": "phone",
      "code": "PATTERN",
      "message": "手機號碼須為 10 位數字，並以 09 開頭",
      "messageKey": "validation.phone.tw",
      "rejectedValue": "091234567",
      "constraint": { "pattern": "^09\\d{8}$", "expectedLength": 10, "actualLength": 9 }
    },
    {
      "field": "addresses[1].recipient",
      "code": "REQUIRED",
      "message": "收件人為必填",
      "messageKey": "validation.required",
      "rejectedValue": ""
    },
    {
      "field": "addresses[1].postalCode",
      "code": "PATTERN",
      "message": "郵遞區號須為 3 或 5 位數字",
      "messageKey": "validation.postalCode.tw",
      "rejectedValue": "abcde",
      "constraint": { "pattern": "^\\d{3}(\\d{2})?$" }
    },
    {
      "field": "addresses[1].line1",
      "code": "REQUIRED",
      "message": "地址為必填",
      "messageKey": "validation.required",
      "rejectedValue": ""
    },
    {
      "field": "acceptTerms",
      "code": "MUST_BE_TRUE",
      "message": "請閱讀並同意服務條款",
      "messageKey": "validation.acceptTerms",
      "rejectedValue": false
    }
  ],
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

**十個設計決策**

| # | 決策 | 理由 |
|---|---|---|
| 1 | 🔴 **`password` 與 `confirmPassword` 的 `rejectedValue` 是 `"***"`** | 4.6.2 要點 4。這個值會進 devtools、Sentry、日誌、客服截圖 |
| 2 | `password` 有**兩筆** error（長度 + 複雜度） | 兩個獨立的規則都失敗了。使用者要一次知道全部要求 |
| 3 | 陣列索引精確：`addresses[1].recipient` | 前端才能標在第二個地址的收件人欄位上 |
| 4 | `addresses[0]` **完全沒有 error** | 它的 `postalCode: "104"` 合法（3 位數字）。**不要因為同一個陣列有錯就全部報錯** |
| 5 | `confirmPassword` 標在 `confirmPassword` 而非 `password` | 使用者最後改的是確認欄位，標在那裡最直觀（4.6.3 情境 3） |
| 6 | `constraint` 帶 `actual` | 前端可顯示「3 / 8 字元」的計數器 |
| 7 | `phone` 的 `constraint` 帶 `actualLength` | 使用者可以看出「少一位數」 |
| 8 | `birthDate` 的 `maxDate` 是**今天** | 讓前端的日期選擇器可以直接設上限，避免再錯一次 |
| 9 | 三層訊息都給：`code` + `message` + `messageKey` | 4.6.2 要點 5 |
| 10 | `detail` 說「9 field(s)」而 `errors` 有 11 筆 | ⚠️ **這是刻意的**：9 個**欄位**失敗，但有 11 筆規則違反（`password` 佔 2 筆）。<br>如果覺得混淆，就改成 `"11 constraint violation(s) across 9 field(s)."` |

**⚠️ 一個重要的安全考量：註冊端點的 email 重複檢查**

```
如果 email 格式正確但已被註冊：
  ❌ 422 { field: "email", code: "DUPLICATE", message: "此 Email 已被註冊" }
     → 可用來列舉哪些 email 有註冊（第 02 章 2.9.3）
  ✅ 409 EMAIL_ALREADY_EXISTS + 對此端點加嚴格限流
     （B2C 服務的實務選擇：可用性優先，用限流防大規模列舉）
```

**⚠️ 另一個實務細節：`password` 的驗證要在格式驗證階段就做完**

不要「先建立使用者再檢查密碼強度」—— 那會留下垃圾資料。
密碼強度是純格式驗證（不需要查資料庫），應該在第一階段（4.6.2 要點 1）。

**⚠️ 第三個細節：不要在錯誤訊息裡洩漏密碼規則的全部細節**

```
✅ "密碼須包含大寫字母、小寫字母與數字"          （幫助使用者）
⚠️ "密碼不可與前 5 次使用過的密碼相同"          （這個要說，否則使用者困惑）
❌ "密碼不可包含您的 email 前綴 wang"            （洩漏了你在做什麼檢查）
```

第三種雖然對使用者友善，但它告訴攻擊者「這個帳號的 email 前綴是 wang」——
在忘記密碼流程裡尤其危險。

</details>

### 練習 3：追蹤 ID 的完整鏈路

你的系統架構：

```
瀏覽器 → Cloudflare → Nginx → order-service → payment-service → 綠界金流
                                     ↓
                              inventory-service
```

使用者說「結帳失敗」。設計完整的 `traceId` 傳遞方案，
使得客服拿到一個代碼就能查到整條鏈路。

<details>
<summary>參考解答</summary>

**方案設計**

```
① 瀏覽器
   前端在每個請求產生 traceparent（或讓 OTel SDK 自動產生）
   traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
   ⚠️ 如果前端沒有 OTel，就讓 Nginx 產生（見 ③）

② Cloudflare
   保留 traceparent（不要 strip）
   Cloudflare 自己的 cf-ray 也記錄下來（查 CDN 層問題用）
   → 在 order-service 的日誌裡同時記 traceId 和 cf-ray

③ Nginx
   # 如果客戶端沒帶就產生
   map $http_traceparent $trace_header {
       ""      "00-$request_id$request_id-0000000000000001-01";
       default $http_traceparent;
   }
   proxy_set_header traceparent $trace_header;
   proxy_set_header X-Request-Id $request_id;

   # ★ access.log 一定要記
   log_format api '$remote_addr $request_id "$request" $status $request_time '
                  'trace="$trace_header" cf_ray="$http_cf_ray"';

④ order-service
   - TraceIdFilter（4.8.1）讀 traceparent → MDC
   - Micrometer Tracing 自動處理（如果用 OTel bridge）
   - 所有日誌帶 [traceId, spanId]
   - 回應 header 帶 X-Request-Id 與 traceresponse
   - 錯誤 body 帶 traceId

⑤ order-service → payment-service
   RestClient / WebClient 的 interceptor 自動注入 traceparent
   （Micrometer Tracing 的 ObservationRestClientCustomizer 會做）
   payment-service 產生新的 spanId，但 traceId 相同

⑥ order-service → inventory-service
   同上

⑦ payment-service → 綠界金流
   ⚠️ 外部系統不吃 traceparent
   → 把我們的 traceId 塞進他們的「商店訂單編號」或「自訂欄位」
     MerchantTradeNo: ORD20260819000001
     CustomField1:    4bf92f3577b34da6 （traceId 前 16 碼）
   → 記錄雙向對映：
     log.info("送出付款 traceId={} gatewayTradeNo={} merchantTradeNo={}",
              traceId, resp.tradeNo(), req.merchantTradeNo());
   → 綠界的 webhook 回來時，用 MerchantTradeNo 找回原始 traceId

⑧ 錯誤回應
   { "code": "PAYMENT_GATEWAY_TIMEOUT",
     "userMessage": "付款處理超時，請稍後再試。若持續發生請聯絡客服並提供追蹤碼 4bf92f35。",
     "traceId": "4bf92f3577b34da6a3ce929d0e0e4736" }

⑨ 前端
   - 顯示前 8 碼 + 複製按鈕（4.8.3）
   - Sentry.captureException(err, { tags: { traceId } })

⑩ 客服流程
   客服後台有一個「追蹤碼查詢」欄位：
   輸入 4bf92f35 →
     - 查日誌系統（Loki/ELK）：{traceId=~"4bf92f35.*"}
     - 查 trace 系統（Tempo/Jaeger）：直接開 trace 圖
     - 查 Sentry：tags.traceId
     - 一頁顯示：使用者、時間、經過哪些服務、哪一步失敗、金流商回應
```

**日誌實際長什麼樣**

```
# order-service
2026-08-19T06:12:44.102Z INFO  [order-service,4bf92f3577b34da6a3ce929d0e0e4736,00f067aa0ba902b7]
  c.e.shop.web.OrderController : POST /orders/ord_01J5GK.../payments customerId=cus_01J5GK...

2026-08-19T06:12:44.150Z INFO  [order-service,4bf92f3577b34da6a3ce929d0e0e4736,00f067aa0ba902b7]
  c.e.shop.svc.PaymentService : 呼叫 payment-service amount=1280.50 method=CREDIT_CARD

# payment-service（同一個 traceId，不同 spanId）
2026-08-19T06:12:44.201Z INFO  [payment-service,4bf92f3577b34da6a3ce929d0e0e4736,a3f5c9e112345678]
  c.e.pay.svc.EcpayClient : 送出付款 merchantTradeNo=ORD20260819000001

2026-08-19T06:13:14.203Z ERROR [payment-service,4bf92f3577b34da6a3ce929d0e0e4736,a3f5c9e112345678]
  c.e.pay.svc.EcpayClient : 綠界回應超時 elapsed=30002ms merchantTradeNo=ORD20260819000001
  java.net.SocketTimeoutException: Read timed out
    at ...

# order-service（收到下游錯誤）
2026-08-19T06:13:14.250Z WARN  [order-service,4bf92f3577b34da6a3ce929d0e0e4736,00f067aa0ba902b7]
  c.e.shop.web.GlobalExceptionHandler : 領域錯誤 code=PAYMENT_OUTCOME_UNKNOWN
  traceId=4bf92f3577b34da6a3ce929d0e0e4736 ctx={orderId=ord_01J5GK..., paymentId=pay_01J5GK...}
```

**一個 traceId 貫穿三個服務、兩個 spanId、一次外部呼叫。**

**七個實務要點**

| # | 要點 | 說明 |
|---|---|---|
| 1 | **驗證外部傳入的 traceparent** | 🔴 攻擊者可以送含換行的值 → log injection（4.8.1）。要驗格式 |
| 2 | **`finally` 清 MDC** | 執行緒池重用會帶到上一個請求的 traceId |
| 3 | **`@Async` / 執行緒池要傳遞 MDC** | 用 `TaskDecorator` 複製（02-spring-boot 第 06 章） |
| 4 | **外部系統的對映要雙向可查** | 綠界的 `tradeNo` ↔ 我們的 `traceId`，webhook 回來才找得到 |
| 5 | **webhook 進來時要建立「關聯」而非「延續」** | webhook 是新的 trace（新 traceId），但要用 `links` 或日誌欄位關聯到原始 trace |
| 6 | **取樣（sampling）要小心** | 生產環境常設 1% 取樣。**錯誤請求要 100% 取樣**，否則客服查不到 |
| 7 | **保留期要夠長** | 客訴常常延遲 3～7 天才來。trace 至少保留 7 天，錯誤的日誌保留 30 天 |

**第 6 點特別重要**：

```java
// OTel 的取樣設定：錯誤一定保留
@Bean
Sampler sampler() {
    return Sampler.parentBased(
        Sampler.traceIdRatioBased(0.01));    // 一般請求 1%
}
// 但錯誤要靠 tail-based sampling（在 collector 端決定）
// 或者：所有 5xx / 4xx 的請求強制設 sampled flag
```

```yaml
# OTel Collector 的 tail sampling（正確做法）
processors:
  tail_sampling:
    policies:
      - name: errors                      # 錯誤 100% 保留
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow                        # 慢請求 100% 保留
        type: latency
        latency: { threshold_ms: 3000 }
      - name: baseline                    # 其餘 1%
        type: probabilistic
        probabilistic: { sampling_percentage: 1 }
```

**如果沒做這件事**，會發生最尷尬的情況：
客戶提供了 traceId，但因為取樣，那筆 trace 根本沒被保留 —— 
你有完整的追蹤機制，卻查不到這一筆。

</details>

### 練習 4：批次操作的錯誤設計

設計「批次更新商品價格」的錯誤回應。

- 一次最多 100 個商品。
- 可能的失敗原因：商品不存在、無權限（不是自己的商品）、
  價格低於成本、價格變動超過 ±50% 需要審核、商品已下架。
- 要讓前端能標出「哪幾筆失敗、為什麼」。

<details>
<summary>參考解答</summary>

**先決定策略**（4.11.3）：

```
批量：1～100
項目間有關聯？→ ❌ 沒有（每個商品獨立，部分成功不會產生不一致）
→ 策略 B（逐筆結果，207 Multi-Status）
```

**請求**

```http
PATCH /products/batch-price-updates
Content-Type: application/json
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1

{
  "updates": [
    { "productId": "P-1001", "price": "1180.00" },
    { "productId": "P-9999", "price": "500.00" },
    { "productId": "P-2003", "price": "100.00" },
    { "productId": "P-3005", "price": "50.00" },
    { "productId": "P-4007", "price": "999.00" },
    { "productId": "P-5009", "price": "888.00" }
  ]
}
```

**回應**

```http
HTTP/1.1 207 Multi-Status
Content-Type: application/json
```

```jsonc
{
  "summary": {
    "total": 6,
    "succeeded": 2,
    "failed": 3,
    "pendingApproval": 1
  },
  "results": [
    {
      "index": 0,
      "productId": "P-1001",
      "status": 200,
      "outcome": "UPDATED",
      "data": {
        "productId": "P-1001",
        "previousPrice": "1280.00",
        "price": "1180.00",
        "changePercent": -7.81,
        "effectiveAt": "2026-08-19T06:12:44Z"
      }
    },
    {
      "index": 1,
      "productId": "P-9999",
      "status": 404,
      "outcome": "FAILED",
      "error": {
        "type": "https://api.shop.example/problems/resource-not-found",
        "title": "商品不存在",
        "code": "PRODUCT_NOT_FOUND",
        "detail": "Product P-9999 does not exist.",
        "userMessage": "找不到此商品，請確認商品編號。",
        "retryable": false
      }
    },
    {
      "index": 2,
      "productId": "P-2003",
      "status": 403,
      "outcome": "FAILED",
      "error": {
        "type": "https://api.shop.example/problems/insufficient-role",
        "title": "無權限修改此商品",
        "code": "PRODUCT_NOT_OWNED",
        "detail": "Product P-2003 belongs to another seller.",
        "userMessage": "您沒有權限修改此商品。",
        "retryable": false
      }
    },
    {
      "index": 3,
      "productId": "P-3005",
      "status": 422,
      "outcome": "FAILED",
      "error": {
        "type": "https://api.shop.example/problems/price-below-cost",
        "title": "價格低於成本",
        "code": "PRICE_BELOW_COST",
        "detail": "Price 50.00 is below the product cost 120.00.",
        "userMessage": "價格 50 元低於成本 120 元，無法設定。",
        "cost": "120.00",
        "minimumAllowedPrice": "120.00",
        "retryable": false,
        "retryStrategy": "MODIFY_REQUEST"
      }
    },
    {
      "index": 4,
      "productId": "P-4007",
      "status": 202,
      "outcome": "PENDING_APPROVAL",
      "data": {
        "productId": "P-4007",
        "previousPrice": "3200.00",
        "requestedPrice": "999.00",
        "changePercent": -68.78,
        "approvalId": "apr_01J5GK...",
        "approvalUrl": "/price-change-approvals/apr_01J5GK...",
        "reason": "CHANGE_EXCEEDS_THRESHOLD",
        "threshold": 50,
        "approvers": ["林經理"],
        "userMessage": "降價幅度 68.8% 超過 50%，已送交林經理審核。"
      }
    },
    {
      "index": 5,
      "productId": "P-5009",
      "status": 409,
      "outcome": "FAILED",
      "error": {
        "type": "https://api.shop.example/problems/product-discontinued",
        "title": "商品已下架",
        "code": "PRODUCT_DISCONTINUED",
        "detail": "Product P-5009 was discontinued on 2026-07-01.",
        "userMessage": "此商品已下架，無法調整價格。如需重新上架請先變更商品狀態。",
        "discontinuedAt": "2026-07-01T00:00:00Z",
        "retryable": false,
        "alternativeAction": {
          "code": "REACTIVATE_PRODUCT",
          "label": "重新上架",
          "href": "/products/P-5009/status",
          "method": "PUT"
        }
      }
    }
  ],
  "traceId": "4f2c8a1e9b7d3f60",
  "timestamp": "2026-08-19T06:12:44Z"
}
```

**八個設計決策**

| # | 決策 | 理由 |
|---|---|---|
| 1 | `207 Multi-Status` | 4.11.2：`2xx` 所以不被當失敗，但明確表達「多個結果」 |
| 2 | 每筆有 `index` **和** `productId` | `index` 讓前端對回原始陣列位置；`productId` 讓人類看得懂（以及順序被打亂時仍可對應） |
| 3 | 每筆有自己的 `status` | 前端可以用同一套錯誤處理邏輯處理每一筆 |
| 4 | **`outcome` 欄位**（`UPDATED`/`FAILED`/`PENDING_APPROVAL`） | 🔴 **關鍵**：不只是成功／失敗二元。`202 PENDING_APPROVAL` 既不是成功也不是失敗 |
| 5 | `summary` 分開算 `pendingApproval` | 讓前端可以顯示「2 筆成功、1 筆待審核、3 筆失敗」 |
| 6 | 每筆的 `error` 是**完整的 Problem 結構** | 前端可以重用單筆操作的錯誤處理元件，不用寫第二套 |
| 7 | 失敗的項目有 `minimumAllowedPrice` / `alternativeAction` | 讓前端能直接提供修正操作，不用使用者自己想 |
| 8 | `traceId` 在**頂層**（不是每筆） | 整批是一個請求，一個 traceId 就夠。<br>⚠️ 但日誌裡每筆要記 `productId` 才能定位 |

**前端如何呈現**

```typescript
const res = await request<BatchPriceUpdateResponse>('/products/batch-price-updates', {
  method: 'PATCH',
  body: JSON.stringify({ updates }),
  idempotencyKey: crypto.randomUUID(),
});

// 在表格上逐列標記
res.results.forEach(r => {
  const row = table.rowAt(r.index);
  switch (r.outcome) {
    case 'UPDATED':
      row.setStatus('success', `已更新（${r.data.changePercent > 0 ? '+' : ''}${r.data.changePercent}%）`);
      break;
    case 'PENDING_APPROVAL':
      row.setStatus('warning', r.data.userMessage);
      row.setAction({ label: '查看審核', href: r.data.approvalUrl });
      break;
    case 'FAILED':
      row.setStatus('error', r.error.userMessage);
      if (r.error.minimumAllowedPrice) {
        row.setAction({
          label: `改為 ${r.error.minimumAllowedPrice}`,
          onClick: () => setPrice(r.index, r.error.minimumAllowedPrice),
        });
      } else if (r.error.alternativeAction) {
        row.setAction(r.error.alternativeAction);
      }
      break;
  }
});

// 摘要橫幅
banner.show(
  `${res.summary.succeeded} 筆成功、` +
  `${res.summary.pendingApproval} 筆待審核、` +
  `${res.summary.failed} 筆失敗`,
  res.summary.failed > 0 ? 'warning' : 'success'
);

// 只重送失敗的（★ 很實用）
const retriable = res.results
  .filter(r => r.outcome === 'FAILED' && r.error.retryable)
  .map(r => updates[r.index]);
if (retriable.length) banner.addAction({ label: `重試 ${retriable.length} 筆`, onClick: () => submit(retriable) });
```

**三個容易被忽略的細節**

**細節 1：交易邊界**

策略 B 是逐筆處理，所以**每一筆要有自己的交易**：

```java
// ❌ 整批一個交易 → 一筆失敗會 rollback 全部（那就變成策略 A 了）
@Transactional
public BatchResult updatePrices(List<PriceUpdate> updates) { ... }

// ✅ 每筆一個交易
public BatchResult updatePrices(List<PriceUpdate> updates) {
    List<ItemResult> results = new ArrayList<>();
    for (int i = 0; i < updates.size(); i++) {
        results.add(updateOne(i, updates.get(i)));    // ← 內部有 @Transactional
    }
    return summarize(results);
}

@Transactional(propagation = Propagation.REQUIRES_NEW)
ItemResult updateOne(int index, PriceUpdate u) {
    try { ... } catch (DomainException ex) { return ItemResult.failed(index, ex); }
}
```

⚠️ **注意 `REQUIRES_NEW` 和自呼叫問題**：
`updateOne` 是同類別內部呼叫 → **不經過代理 → `@Transactional` 失效**
（02-spring-boot 第 04 章）。要把 `updateOne` 移到另一個 bean，或注入自己。

**細節 2：冪等鍵的語意**

整批用**一個**冪等鍵。重試時：

```
第一次：2 成功、1 待審核、3 失敗
重試（同 key）：回傳「和第一次完全相同的結果」（不重新執行）
```

**不是**「只重跑失敗的那 3 筆」。
如果要重跑失敗的，客戶端要用**新的冪等鍵**送**新的（較小的）批次**。

**細節 3：`202` 混在 `207` 裡合理嗎**

`202 PENDING_APPROVAL` 表示「已接受但未完成」——
在批次結果裡它是第三種 outcome，這是合理的用法。

⚠️ 但要在文件裡寫清楚，因為它打破了「成功／失敗」的二元假設。
很多客戶端會寫成 `if (r.status < 300) success else fail` ——
那樣 `202` 會被當成成功（但價格其實還沒改）。

**所以 `outcome` 欄位是必要的**（決策 4）：它強迫客戶端處理三種情況，
而不是憑 `status < 300` 猜。

</details>

### 練習 5：審查錯誤處理程式碼

以下是某專案的錯誤處理。找出所有問題。

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, Object> handleAll(Exception ex) {
        log.error("錯誤", ex);
        return Map.of("code", -1, "msg", ex.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(
            MethodArgumentNotValidException ex) {
        log.error("驗證失敗", ex);
        String msg = ex.getBindingResult().getFieldErrors().get(0).getDefaultMessage();
        return ResponseEntity.ok(Map.of("code", 400, "msg", msg));
    }

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Map<String, Object>> handleBusiness(BusinessException ex) {
        log.error("業務錯誤: " + ex.getMessage(), ex);
        return ResponseEntity.status(500).body(Map.of(
            "code", ex.getCode(),
            "msg", ex.getMessage(),
            "sql", ex.getSql()
        ));
    }
}
```

<details>
<summary>參考解答</summary>

**`handleAll` 的六個問題**

| # | 問題 | 嚴重度 | 修正 |
|---|---|---|---|
| 1 | 🔴 **catch-all 回 `400`** | 極高 | 系統錯誤（NPE、資料庫掛掉）全部變成 `400` → **5xx 告警永遠不會響**（4.12.2）。改回 `500` |
| 2 | 🔴 **`ex.getMessage()` 直接回給客戶端** | 極高 | 可能包含 SQL、內部 IP、檔案路徑、stack 資訊（4.7.3）。5xx 的 `detail` 要用固定文字 |
| 3 | 沒有 `traceId` | 高 | 使用者回報時無法追蹤（4.8） |
| 4 | 不是 Problem Details 格式 | 中 | 用 `{code, msg}` 自訂格式；改用 `application/problem+json` |
| 5 | 沒有 `userMessage` | 中 | `ex.getMessage()` 是英文技術訊息，使用者看不懂 |
| 6 | `@ExceptionHandler(Exception.class)` 會**攔截所有例外** | 高 | 包含 Spring MVC 本身的例外（`HttpMediaTypeNotSupportedException` 等）→ 全部變 `400`。<br>要繼承 `ResponseEntityExceptionHandler` 讓框架例外先被正確處理 |

**`handleValidation` 的五個問題**

| # | 問題 | 嚴重度 | 修正 |
|---|---|---|---|
| 7 | 🔴 **回 `ResponseEntity.ok()`（`200`）** | 極高 | 驗證失敗回 `200` → 第 02 章 2.12 的全部五個損失。改 `422` |
| 8 | 🔴 **`.get(0)` 只回第一個錯誤** | 高 | 使用者要送出 N 次才知道全部問題（4.6.2 要點 1）。<br>而且如果 `getFieldErrors()` 為空（只有類別層級錯誤）→ `IndexOutOfBoundsException` |
| 9 | **`log.error` 用在 4xx** | 中 | 驗證失敗是預期流程。日誌被灌爆、真正的錯誤被埋掉、stack trace 有成本（4.12.4）。改 `log.warn` 且不印 stack trace |
| 10 | 沒有 `field` 資訊 | 高 | 前端無法標到對應欄位（4.6.2 要點 2） |
| 11 | 只看 `getFieldErrors()`，漏了 `getGlobalErrors()` | 中 | 類別層級的驗證（`@ValidInvoice`）會被完全忽略 → **驗證失敗但回 200 + 空訊息** |

**`handleBusiness` 的六個問題**

| # | 問題 | 嚴重度 | 修正 |
|---|---|---|---|
| 12 | 🔴🔴 **`"sql"` 欄位回給客戶端** | 極高 | 洩漏完整 SQL 語句、資料表、欄位名。這是嚴重的資安問題（4.7.3）。**刪掉** |
| 13 | 🔴 **業務錯誤一律回 `500`** | 極高 | 「庫存不足」「訂單已出貨」是 4xx。全回 `500` → 告警被業務錯誤淹沒（4.12） |
| 14 | 狀態碼沒有從 `ErrorCode` 對映 | 高 | 應該由 `ex.getCode()` 決定狀態碼（4.5.5、4.10.1） |
| 15 | `log.error` 用字串串接 | 低 | `log.error("業務錯誤: " + msg, ex)` 應該用 `{}` 佔位符（避免不必要的字串串接，且結構化日誌才能解析欄位） |
| 16 | 業務錯誤印 stack trace | 中 | 4xx 的業務錯誤不需要 stack trace（4.12.4） |
| 17 | 沒有 `retryable` | 中 | 客戶端無法決定要不要重試（4.9） |

**整體缺漏（四項）**

| # | 缺什麼 | 說明 |
|---|---|---|
| 18 | Spring Security 的 `401`/`403` 沒處理 | 它們在 Filter 層被攔截，**不會進 `@RestControllerAdvice`**（4.10.3）→ 格式不一致 |
| 19 | `Content-Type` 沒設 | 應該是 `application/problem+json` |
| 20 | 沒有 `@Order` | 多個 `@RestControllerAdvice` 時順序不確定；`Exception.class` 的 handler 應該最低優先 |
| 21 | 錯誤回應可能被快取 | 應加 `Cache-Control: no-store` |

**修正後的版本**

```java
@RestControllerAdvice
@Order(Ordered.LOWEST_PRECEDENCE)                    // ★ 20
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {   // ★ 6

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private final MessageSource messages;
    private final ErrorMetrics metrics;

    GlobalExceptionHandler(MessageSource messages, ErrorMetrics metrics) {
        this.messages = messages;
        this.metrics = metrics;
    }

    // ── 業務錯誤 ────────────────────────────────────
    @ExceptionHandler(DomainException.class)
    public ResponseEntity<ApiProblem> handleDomain(DomainException ex,
                                                   HttpServletRequest req,
                                                   Locale locale) {
        ErrorCode code = ex.code();                             // ★ 14：狀態碼從 ErrorCode 來

        if (code.status().is5xxServerError()) {                 // ★ 9, 16
            log.error("領域錯誤 code={} traceId={} ctx={}",
                      code, traceId(), ex.context(), ex);
        } else if (code.status().value() == 429) {
            log.info("限流 code={} traceId={}", code, traceId());
        } else {
            log.warn("領域錯誤 code={} traceId={} ctx={} msg={}",
                     code, traceId(), ex.context(), ex.getMessage());   // ★ 15：佔位符
        }
        metrics.record(code, req.getRequestURI());

        return problem(code, ex.getMessage(), ex.context(), req, locale);
    }

    // ── 驗證錯誤（覆寫父類別的方法）──────────────────
    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {

        log.warn("驗證失敗 traceId={} errorCount={}",
                 traceId(), ex.getBindingResult().getErrorCount());     // ★ 9

        List<ApiProblem.FieldError> errors = new ArrayList<>();

        // ★ 8, 10, 11：全部收集，含 field 與 global
        ex.getBindingResult().getFieldErrors().forEach(fe -> errors.add(
                new ApiProblem.FieldError(
                        fe.getField(),
                        toErrorCode(fe.getCode()),
                        fe.getDefaultMessage(),
                        safeRejectedValue(fe.getField(), fe.getRejectedValue()))));

        ex.getBindingResult().getGlobalErrors().forEach(ge -> errors.add(
                new ApiProblem.FieldError(
                        ge.getObjectName(),                     // 或從 constraint 挖出欄位
                        toErrorCode(ge.getCode()),
                        ge.getDefaultMessage(),
                        null)));

        ApiProblem body = ApiProblem.builder()
                .from(ErrorCode.VALIDATION_FAILED, messages, localeOf(request))
                .detail("%d field(s) failed validation.".formatted(errors.size()))
                .instance(uriOf(request))
                .errors(errors)
                .traceId(traceId())
                .build();

        // ★ 7：422，不是 200
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)        // ★ 19
                .cacheControl(CacheControl.noStore())                    // ★ 21
                .body(body);
    }

    // ── 最後一道防線 ────────────────────────────────
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiProblem> handleUnexpected(Exception ex,
                                                       HttpServletRequest req,
                                                       Locale locale) {
        // ★ 3：完整細節只進日誌
        log.error("未預期的錯誤 traceId={} method={} path={}",
                  traceId(), req.getMethod(), req.getRequestURI(), ex);
        metrics.record(ErrorCode.INTERNAL_ERROR, req.getRequestURI());

        // ★ 1：500，不是 400
        // ★ 2：detail 是固定文字，不含 ex.getMessage()
        return problem(ErrorCode.INTERNAL_ERROR,
                       "An unexpected error occurred. Provide the traceId when contacting support.",
                       Map.of(), req, locale);
    }

    private ResponseEntity<ApiProblem> problem(ErrorCode code, String detail,
                                               Map<String, Object> ctx,
                                               HttpServletRequest req, Locale locale) {
        ApiProblem body = ApiProblem.builder()
                .from(code, messages, locale)              // type / title / userMessage / retryable
                .detail(detail)
                .instance(URI.create(req.getRequestURI()))
                .extensions(ctx)                            // ★ 12：不含 sql
                .traceId(traceId())
                .timestamp(Instant.now())
                .build();

        return ResponseEntity.status(code.status())
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .cacheControl(CacheControl.noStore())
                .body(body);
    }

    private static String traceId() {
        return MDC.get("traceId");
    }
}
```

**外加：Spring Security 的 401/403（★ 18）**

```java
@Configuration
class SecurityErrorConfig {

    @Bean
    AuthenticationEntryPoint problemEntryPoint(ObjectMapper om, MessageSource ms) {
        return (req, res, ex) -> writeProblem(res, om, ms,
                ErrorCode.AUTHENTICATION_REQUIRED, req,
                Map.of(), "Bearer realm=\"shop-api\", error=\"invalid_token\"");
    }

    @Bean
    AccessDeniedHandler problemAccessDeniedHandler(ObjectMapper om, MessageSource ms) {
        return (req, res, ex) -> writeProblem(res, om, ms,
                ErrorCode.INSUFFICIENT_ROLE, req, Map.of(), null);
    }
}
```

**問題數量統計**

```
🔴 極高（資安或監控失效）：5 個
   - catch-all 回 400（告警失效）
   - ex.getMessage() 洩漏內部
   - 驗證失敗回 200（監控失效）
   - "sql" 欄位洩漏 SQL
   - 業務錯誤一律 500（告警被淹沒）

🟠 高：5 個
🟡 中：7 個
🟢 低：1 個
缺漏：4 個
────────────────
總計：21 個問題（在 30 行程式碼裡）
```

**這一題的總結**：錯誤處理是「看起來很簡單，但每一行都可能出錯」的程式碼。
它的特殊性在於 —— **它自己出錯時不會有人發現**（因為它就是處理錯誤的地方）。

**所以錯誤處理必須有測試**：

```java
@WebMvcTest(OrderController.class)
class ErrorHandlingTest {

    @Test
    void 驗證失敗回422並含所有欄位錯誤() throws Exception {
        mockMvc.perform(post("/orders")
                        .contentType(APPLICATION_JSON)
                        .content("""
                                {"items": [], "shippingAddressId": ""}
                                """))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"))
                .andExpect(jsonPath("$.errors", hasSize(2)))          // ★ 不是 1
                .andExpect(jsonPath("$.errors[*].field",
                        containsInAnyOrder("items", "shippingAddressId")))
                .andExpect(jsonPath("$.traceId").isNotEmpty())
                .andExpect(jsonPath("$.userMessage").isNotEmpty());
    }

    @Test
    void 系統錯誤回500且不洩漏內部細節() throws Exception {
        when(orderService.create(any()))
                .thenThrow(new RuntimeException(
                        "could not execute statement; SQL [insert into t_order ...]"));

        mockMvc.perform(post("/orders").contentType(APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.detail", not(containsString("SQL"))))       // ★
                .andExpect(jsonPath("$.detail", not(containsString("t_order"))))   // ★
                .andExpect(jsonPath("$.sql").doesNotExist())                        // ★
                .andExpect(jsonPath("$.trace").doesNotExist())
                .andExpect(jsonPath("$.traceId").isNotEmpty());
    }

    @Test
    void 業務錯誤回對應的狀態碼而非500() throws Exception {
        when(orderService.create(any()))
                .thenThrow(new InsufficientStockException("P-1001", "耳機", 5, 3, null));

        mockMvc.perform(post("/orders").contentType(APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isConflict())                     // ★ 409 不是 500
                .andExpect(jsonPath("$.code").value("INSUFFICIENT_STOCK"))
                .andExpect(jsonPath("$.available").value(3))
                .andExpect(jsonPath("$.retryable").value(false));
    }
}
```

**最後三個測試就能抓到本題 21 個問題裡的大部分。**
（04-controller 第 03 章與 07-testing 會完整實作。）

</details>

---

## 4.17 驗收清單

- [ ] 我能說出「糟糕的錯誤回應」如何把 4 分鐘的除錯變成一整天。
- [ ] 我能用「是誰的錯／哪裡錯／為什麼／怎麼修／能重試嗎／怎麼追」六問檢核任何錯誤格式。
- [ ] 我知道 RFC 9457 的五個標準欄位，並能區分 `title`（類型，固定）與 `detail`（實例，每次不同）。
- [ ] 我知道 `type` URI 該怎麼命名，也知道做一個對應的文件頁面投報率很高。
- [ ] 我知道相同 `type` 的擴充欄位必須固定，客戶端才能安全地讀。
- [ ] 我知道要用 `application/problem+json`，也知道它讓中介元件能識別錯誤。
- [ ] 我知道 `spring.mvc.problemdetails.enabled=true` 只是起點，還要自己的 advice。
- [ ] 我能設計業務錯誤碼：字串、`UPPER_SNAKE_CASE`、描述原因不是結果。
- [ ] 我會用 enum 當錯誤碼註冊表，把 `code → 狀態碼 / type / retryable / i18n key` 綁在一起。
- [ ] 我知道對外碼是「客戶端需要區別的最小集合」，不是內部錯誤的完整列舉。
- [ ] 我知道風控與詐騙偵測的原因**不能**告訴客戶端，但要能用 `traceId` 內部查到。
- [ ] 我能設計驗證錯誤：一次回全部、`field` 含陣列索引、`code` + `message` + `messageKey` + `constraint`。
- [ ] 我知道 `rejectedValue` 不能回顯密碼、卡號、CVV，也知道要截斷超長字串。
- [ ] 我知道類別層級驗證要用 `addPropertyNode()` 才會有正確的 `field`。
- [ ] 我知道驗證要分階段（格式先、業務後），避免對明顯無效的輸入去查資料庫。
- [ ] 我能區分 `code`（機器，不可改）／`detail`（開發者）／`userMessage`（使用者，可隨時改）。
- [ ] 我知道 `detail` 只能包含「客戶端已經知道或有權知道」的資訊。
- [ ] 我知道 5xx 的 `detail` 一律是固定文字，真正的細節只進日誌。
- [ ] 我能設計 `traceId` 的完整鏈路，包含前端顯示、Sentry 上報、客服查詢。
- [ ] 我知道要驗證客戶端傳入的 trace header（防 log injection）、要在 `finally` 清 MDC。
- [ ] 我知道錯誤請求要 100% 取樣，否則客服拿到 traceId 也查不到。
- [ ] 我知道 `retryable` 要搭配 `retryStrategy`，因為「可重試」有四種不同做法。
- [ ] 我知道 `retryable: true` 的前提是操作冪等，沒有冪等鍵的 `POST` 要用 `CHECK_STATUS`。
- [ ] 我知道重試要有抖動，也知道要在文件裡教 consumer 這件事。
- [ ] 我能設計分層的例外（Service 拋領域例外、Web 層轉 HTTP），並說出五個好處。
- [ ] 我知道 Spring Security 的 401/403 不會進 `@RestControllerAdvice`，要另外設定。
- [ ] 我知道 Nginx 層的錯誤頁也要是 JSON，否則前端 `res.json()` 會拋 `SyntaxError`。
- [ ] 我能按「項目間有關聯嗎」選擇批次錯誤策略，並知道 `atomic: true` 欄位的價值。
- [ ] 我知道逐筆結果要用 `outcome` 而不是只靠 `status < 300`，因為有 `202` 這種第三態。
- [ ] 我能說出「把系統錯誤標成 4xx」為什麼會讓告警失效，也知道正確做法是調告警規則。
- [ ] 我知道 4xx 用 `warn`（不印 stack trace）、5xx 用 `error`、429 用 `info`。
- [ ] 我知道自訂指標的標籤必須低基數，也能設計出「業務錯誤暴增」的告警。
- [ ] 我完成了 shop-service 的錯誤目錄，並能寫出前端消費它的完整程式碼。
- [ ] 我知道錯誤處理程式碼本身必須有測試，因為它出錯時不會有人發現。

---

## 4.18 本站前半段回顧

第 00～04 章走完了，你現在有的東西：

| 章 | 產出 |
|---|---|
| 00 | 領域盤點、訂單狀態機、動詞→資源對照表、六個 API 判準 |
| 01 | 83 條端點的完整 URL 表、識別碼方案、非 CRUD 動作的五種手法 |
| 02 | 每條端點的方法／狀態碼契約、全域規則清單、契約冒煙測試腳本 |
| 03 | 22 個 DTO 的全家族、JSON 命名／金額／時間規範、列舉演進三層防護 |
| 04 | 錯誤目錄（約 60 個 `code`）、Problem Details 格式、前端消費程式碼 |

**這五章合起來，已經是一份可以交給團隊實作的完整契約前半部。**

剩下的部分：

| 章 | 主題 | 為什麼放在後面 |
|---|---|---|
| 05 | 分頁、篩選與排序 | 它有自己的一整套設計問題（offset vs cursor、`totalElements` 的代價、排序白名單） |
| 06 | 版本控管與相容性 | 需要前面四章的「什麼是破壞性變更」當基礎 |
| 07 | OpenAPI 與文件 | 把 00～06 的所有決定寫成 `orders-api.yaml` |
| 08 | 冪等、快取與限流 | 前面各章反覆提到（`Idempotency-Key`、`ETag`、`Retry-After`），這裡收攏成完整實作 |
| 09 | 測試與協作 | 把契約變成可執行的測試，以及前後端協作流程 |

**一個建議**：如果你正在為實際專案設計 API，
現在就可以把 00～04 章的五張表（資源清單、URL 表、狀態碼契約、DTO 清單、錯誤目錄）
拉出來做一次團隊 review。**這五張表就是 API 設計的核心產出**，
後面幾章是把它們變得更完整、更好維護。

---

完成後請前往 [05-pagination-filter-sort-search.md](./05-pagination-filter-sort-search.md)。
