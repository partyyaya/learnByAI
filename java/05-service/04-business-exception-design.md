# 第 04 章：業務例外設計

> 前三章一路在做同一件事：**讓「做錯」變成大聲失敗**。
> 03 章結尾留下一個沒有回答的問題 ——
> **那些「刻意拋出來的例外」，到了 Controller 要變成什麼？**
>
> 這一章的答案不是「加一個 `@ExceptionHandler`」。
> 04-controller 03 章已經把 advice 建好了，而它處理的是**框架的例外**
> （驗證失敗、反序列化失敗、405、415）。
> **業務例外的那一半一直沒有被系統性地處理過** ——
> 而「沒有被系統性處理」的具體後果是：**一個 4xx 的情況回了 500**，
> 於是客戶端重試，於是同一張訂單成立七次。

---

## 4.0 先看見痛：三個真實事故

### 事故 1：一個 500 讓客戶重複下單七次

**現場**（促銷日 20:14，客服工單）：

```
客戶：我按了結帳，畫面說「系統忙碌中，請稍後再試」，我按了幾次。
      現在我的訂單列表有七張一樣的訂單，也刷了七次卡。
```

**查 log**：

```
20:14:03 ERROR c.e.s.c.w.ApiExceptionHandler - Unhandled exception at POST /api/orders
java.lang.IllegalStateException: 發票已開立，不可修改
	at example.shop.order.domain.Order.changeInvoice(Order.java:412)
	...
20:14:07 ERROR ... (同上)
20:14:11 ERROR ... (同上)
（共 7 次）
```

**發生了什麼**：

`Order.changeInvoice()` 在「發票已開立」時拋 `IllegalStateException`
（03 章 3.6.5 那一段的第一版）。
它**不是** `BusinessException`，所以 04-controller 3.7.2 的 catch-all 接到它，
給了 **500 + `INTERNAL_ERROR` + `retryable: false`**。

⚠️ **而客戶端的重試邏輯是這樣寫的**：

```typescript
// 前端的通用 fetch wrapper
if (res.status >= 500) {
  // 5xx = 伺服器問題 = 我們的請求沒有錯 → 可以重試
  return retryWithBackoff(req, { maxAttempts: 3 });
}
```

**這個判斷完全正確。** 5xx 的語意就是「伺服器出問題，你的請求本身沒錯」，
而 `retryable: false` 只是**建議**，前端的通用層通常不看它（它看狀態碼）。

**於是**：

| 步驟 | 發生的事 |
|---|---|
| 1 | 客戶送出結帳 → Service 建單成功 → **`changeInvoice` 拋 `IllegalStateException`** |
| 2 | 交易 rollback → 訂單沒進資料庫 ✅ |
| 3 | 但**扣款是外部呼叫**，不在交易裡 → **錢已經扣了** |
| 4 | 回 500 → 前端自動重試 3 次 → 客戶又手動按 4 次 → **7 次扣款** |

⚠️ **注意第 3 步。** 事故的**放大器**是「扣款不在交易裡」（02 章 2.9.2），
而**觸發器**是「一個業務失敗被表達成 500」。

**修好放大器需要 06 章的 outbox。修好觸發器只需要這一章的一件事**：

```java
// 修正前
throw new IllegalStateException("發票已開立，不可修改");

// 修正後
throw new InvoiceAlreadyIssuedException(id, invoiceIssuedAt);   // → 409，retryable: false
```

**409 的客戶端行為**：前端的通用層不重試 4xx，
交給業務層的 `switch (problem.code)` 處理 → 顯示「發票已開立，無法修改」。

> 📌 **這個事故的一般形式**：
> **狀態碼不只是「回應的裝飾」，它是一個「客戶端該怎麼做」的指令。**
> 把「你不能這樣做」表達成 500 = 對客戶端說「請再試一次」。

### 事故 2：客服說「系統壞了」，其實是「你的備註太長」

**現場**（客服部門的抱怨，累積三個月）：

```
客服 A：我改客戶的訂單備註，一直跳「操作無法完成，請稍後再試」。
       我換了三台電腦、清了快取、重新登入，都一樣。
       這功能是不是壞掉了？
```

**查 log**：`warn` 一條也沒有。`error` 有，但沒有人在看。

**第一個懷疑的地方是欄位級權限**（03 章 3.6.6 ③）：

```java
if (cmd.touchesInternalFields() && !cmd.actor().isPrivileged()) {
    throw new InternalFieldNotEditableException(cmd.orderId(), "internalNote",
                                               cmd.actor().type());
}
```

⚠️ **而那不是原因**：`SUPPORT` 這個 `ActorType` 讓 `isPrivileged()` 回傳 `true`
（`isInternal()` 包含 `SUPPORT`，00 章 0.12 ⑫），
所以那個 `if` 根本不會進去 —— **那個例外從來沒有被拋出過。**

**真正的來源是 `Order.changeInternalNote()` 裡的第二道檢查**：

```java
public void changeInternalNote(String note, Actor actor) {
    if (!actor.isInternal()) {
        throw new IllegalStateException("only internal actors can edit internal note");
    }
    if (note != null && note.length() > MAX_NOTE_LENGTH) {
        throw new IllegalStateException("note too long: " + note.length());  // ← 🔴 這裡
    }
    ...
}
```

那位客服習慣把整段對話貼進備註，而備註超過 `MAX_NOTE_LENGTH`（2000）。
`IllegalStateException` → catch-all → **500 + 「操作無法完成，請稍後再試」**。

**三個月沒被發現的原因**：

| 為什麼沒人發現 | 細節 |
|---|---|
| 客服以為是「系統壞了」 | 500 的訊息就是這個語意，她沒有理由懷疑自己的輸入 |
| 監控沒有告警 | ⚠️ `IllegalStateException` **有**進 error log，但那個 endpoint 的 5xx 率是 0.02%，低於告警閾值 |
| 沒有測試 | Web 層的 `@TextLength` 擋掉了正常路徑，**沒有人測「第二道防線被觸發」的樣子** |

**修法是這一章的 4.4.4**：`Order` 的「最後一道防線」不該拋 `IllegalStateException`，
而該拋一個**帶 `ErrorCode` 的 domain 例外**（`NoteTooLongException` → 422 + 「備註最多 2000 字」）。

> 📌 **03 章 3.10.3 ⑦ 已經預告了這件事**：
> 「每一個『Domain 層的最後一道防線』都需要一個 `ErrorCode`，
> 即使正常情況下 Web 層已經擋掉了。」
> **這個事故是那一句話的價碼。**

⚠️⚠️ **而這個事故有一個第二層的教訓**：
**第一個懷疑的地方（欄位級權限）是錯的，而它「看起來完全合理」。**
`InternalFieldNotEditableException` 的存在讓人以為「權限不足」是可能的原因 ——
而真相是**那條路徑不可能被觸發**（`SUPPORT` 永遠是 privileged）。
**4.12.1 的守門測試會抓到這種「宣告了但不可能被拋出」的例外。**

### 事故 3：`catch (Exception e) { log.error }` 讓退款靜默失敗三週

**現場**（財務月結，2026-06-01）：

```
財務：五月有 23 筆退貨單，狀態是「已退款」，但金流商那邊只有 6 筆。
     另外 17 筆客戶的錢沒有回去。
```

**程式碼**：

```java
@Transactional
public void processReturn(ProcessReturnCommand cmd) {
    ReturnRequest req = returns.findById(cmd.returnId()).orElseThrow();
    Order order = orders.findById(req.orderId()).orElseThrow();

    order.markReturned(req.lines(), cmd.actor(), clock.instant());
    orders.save(order);

    try {
        RefundResult result = paymentGateway.refund(order.paymentId(), req.refundAmount());
        req.markRefunded(result.transactionId());
    } catch (Exception e) {
        // ⚠️ 「退款失敗不應該讓整個退貨流程掛掉，客戶已經把貨寄回來了」
        log.error("退款失敗 returnId={}", cmd.returnId(), e);
    }

    req.close();                                    // ★ 不管退款成不成功都關單
    returns.save(req);
}
```

**那個 `catch (Exception e)` 的註解是對的。** 客戶真的已經把貨寄回來了，
退貨單不該因為金流商當機而卡住。

⚠️ **錯的是「關單」在 catch 外面。**

| 情況 | `req` 的狀態 | 客戶看到 |
|---|---|---|
| 退款成功 | `REFUNDED` + `CLOSED` | 「已退款」✅ |
| **退款失敗** | **`CLOSED`（沒有 `REFUNDED`）** | ⚠️ **「已完成」** |

而前端的狀態顯示是這樣寫的：

```java
// ReturnRequestWebMapper
String statusLabel = req.isClosed() ? "已完成" : "處理中";
```

**於是**：退款失敗的 17 筆在客戶端顯示「已完成」，
客戶以為錢會回來，三週後才有人打電話。

**而 `log.error` 為什麼沒有救到它**：

```
ERROR c.e.s.r.a.ReturnService - 退款失敗 returnId=RET-2026-0512-0087
example.shop.payment.PaymentGatewayException: card was closed by issuer
```

這條 log 每天出現 0～2 次，混在每天約 4,000 條 `ERROR` 裡（大部分是爬蟲打 404）。
**沒有人在看它，因為它不是告警。**

**三個修法，這一章要決定用哪一個**：

| 修法 | 效果 | 問題 |
|---|---|---|
| ① 把 `catch (Exception e)` 拿掉 | 退款失敗 → rollback → 退貨單回到「處理中」 | 🔴 客戶的貨已經收了，退貨單卡住 |
| ② `catch` 但**不關單**，狀態設成 `REFUND_FAILED` | ✅ 客戶看到「退款處理中」，運營有一張待辦清單 | 需要一個新狀態與一個補償流程 |
| ③ `catch` 但拋一個**不同的例外** | 讓呼叫端決定 | ⚠️ 呼叫端是 Controller，它不知道該怎麼決定 |

**選 ②。** 而它需要的不只是「別關單」——
它需要**一個能表達「這件事失敗了，但不是使用者的錯，也不是我們的 bug」的例外類別**，
而那正是 4.4 那條「可預期 / 不可預期」界線最難畫的位置（4.4.3 邊界案例 3）。

> 📌 **這三個事故的共同結構**：
>
> | 事故 | 表面問題 | 真正的問題 |
> |---|---|---|
> | 1 | 重複下單 | **業務失敗被表達成 500** |
> | 2 | 客服抱怨 | **Domain 的最後一道防線沒有 `ErrorCode`** |
> | 3 | 退款靜默失敗 | **例外被 catch 掉，而「失敗」沒有進入狀態** |
>
> **三個都不是「忘記寫 try-catch」。** 三個都是**例外的型別設計**問題。

---

## 4.1 學習目標

讀完這一章，你可以：

- 說明「業務例外」與「程式錯誤」的界線在哪，以及**判準是「誰能修好它」**。
- 說出 `IllegalStateException` 為什麼**刻意**不是業務例外，以及那個決定的兩個代價。
- 設計一個例外階層，並說出「三層」「兩層 + 標記介面」「按狀態碼分層」三者的取捨。
- 判斷一個例外該帶哪些資料，以及**為什麼「使用者訊息」不該在例外裡**。
- 處理「同一個例外要對應兩個狀態碼」的情況，並說出為什麼「在 advice 裡看 `Actor`」是錯的。
- 讓例外的 i18n 訊息參數**在 CI 就被檢查**，而不是上線後看到字面的 `{0}`。
- 說明 `ErrorCode.Retry` 的六個值各自對客戶端是什麼指令，以及 `Retry-After` 該從哪裡來。
- 解釋為什麼「所有業務例外繼承 `RuntimeException`」讓 `rollbackFor` 幾乎永遠不需要寫。
- 說出「不要用例外做流程控制」的三個**例外情況**，以及量化的成本數字。
- 寫出五組守門測試，讓「新增例外忘記加 code」「訊息參數個數不對」「例外沒進對應表」「宣告了但不可能被拋出」變成 CI 紅燈。

## 前置知識

| 需要 | 用在哪 |
|---|---|
| **04-controller 03 章全部** | `ErrorCode`、`BusinessException`、`Problem`、`ProblemFactory`、`ApiExceptionHandler` —— 這一章是它的另一半 |
| 04-controller 2.9～2.10 | `FieldViolation` 與 `ValidationFailedException` |
| **本站 02 章 2.6** | rollback 規則 —— 4.10 整節建立在它上面 |
| 本站 02 章 2.12 | `@TransactionalEventListener` —— 4.10.3 |
| 本站 03 章 3.6～3.7 | `Patch<T>`、欄位級權限 —— 4.6.2 與 4.7 的案例來自這裡 |
| 本站 00 章 0.8 | 不變量清單與「守在四個位置」—— 4.4.4 |

⚠️ **這一章的程式碼可以獨立讀，但 4.10 不行。**
它假設你已經知道「預設只對 `RuntimeException` rollback」以及
`UnexpectedRollbackException` 是怎麼發生的（02 章 2.8）。

---

## 4.2 98 個 `ErrorCode` 怎麼組織 ★

### 4.2.1 平坦的 enum 在第 60 個之後會發生什麼

`ErrorCode` 到目前為止的成長：

| 階段 | 數量 | 來源 |
|---|---|---|
| 04-controller 3.4.2 | 79 | 錯誤目錄的第一版 |
| 04-controller 5.12.4 | +4 = **83** | 檔案上傳（`SCAN_PENDING` 等） |
| 本站 00 章 0.12 ⑮ | +10 = **93** | 00～01 章的新例外 |
| 本站 03 章 3.10.3 ⑦ | +4 = **97** | Domain 的最後一道防線 |
| **本章 4.2.4** | **+1 = 98** | ⚠️ 03 章引用了一個不存在的 code |

**一個 700 行的 enum 有四個具體問題**（不是「看起來很長」這種美學問題）：

**問題 1：找不到「有沒有已經存在的 code」**

```
新需求：「訂單超過 30 天不可申請發票」
工程師搜尋 "invoice" → 找到 ORDER_INVOICE_REQUEST_IN_FLIGHT
→ 沒有「期限過了」的 → 新增 ORDER_INVOICE_WINDOW_EXPIRED
```

⚠️ **而 `REFUND_WINDOW_EXPIRED`、`RETURN_WINDOW_EXPIRED`、`SELF_CANCEL_WINDOW_EXPIRED`
已經是同一個模式的三個實例了。**
沒有人看到那個模式，因為它們散在 409 的 19 個常數裡。

**問題 2：分區註解會腐敗**

```java
    // ── 409 狀態衝突 ────────────────────────────────────────────
    ORDER_NOT_CANCELLABLE  (HttpStatus.CONFLICT,              "order-not-cancellable"),
    ...
    // ── 422 語意錯誤 ────────────────────────────────────────────
    VALIDATION_FAILED      (HttpStatus.UNPROCESSABLE_ENTITY,  "validation-failed"),
```

**這個分區是「註解」，不是「型別」。** 加一個 409 的 code 時：

```java
    // ── 422 語意錯誤 ────────────────────────────────────────────
    VALIDATION_FAILED      (HttpStatus.UNPROCESSABLE_ENTITY,  "validation-failed"),
    MY_NEW_CODE            (HttpStatus.CONFLICT,              "my-new-code"),   // ← 🔴 放錯區
```

**編譯得過，測試也綠。** 而下一個人搜尋 409 的區塊時找不到它。

**問題 3：`switch` 上的窮盡性檢查變成負擔而不是幫助**

`OrderStatus.category()` 那個「沒有 `default` 的 switch」（00 章 0.9.3）
是很好的守門人 —— **因為它只有 8 個值**。

⚠️ **98 個值的 `switch` 沒有人寫得完**，於是每個 `switch (errorCode)` 都會有 `default`，
於是窮盡性檢查的價值歸零。

**問題 4：i18n properties 檔與 enum 的順序會漂移**

`error-messages_zh_TW.properties` 有 196 行（98 個 code × 2 行）。
enum 與 properties **是兩個檔案**，而它們的分區順序在第三次改動之後就對不起來了。

> 📌 **這四個問題有一個共同點**：
> **它們都不是「執行期錯誤」，而是「維護成本」。**
> 而維護成本的表現形式是：**重複的 code、放錯區的 code、與訊息檔不同步的 code。**

### 4.2.2 四種組織方式

**方式 A：分組註解（現狀）**

```java
public enum ErrorCode {
    // ── 409 狀態衝突 ────────
    ORDER_NOT_CANCELLABLE(...),
    ...
}
```

| | |
|---|---|
| ✅ | 零成本、`ErrorCode.X` 到處可用、可遍歷 |
| 🔴 | 分區是註解，會腐敗（問題 2） |

**方式 B：巢狀 enum（按領域）**

```java
public final class ErrorCodes {
    public enum Order  { NOT_CANCELLABLE, ALREADY_PAID, ... }
    public enum Coupon { EXPIRED, EXHAUSTED, ... }
    public enum Payment{ CARD_DECLINED, ... }
}
```

| | |
|---|---|
| ✅ | 分區變成型別；`switch` 的窮盡性回來了 |
| 🔴🔴 | **`BusinessException` 收不到共同的型別** —— 需要一個介面，而那就是方式 D |
| 🔴 | **`code` 字串變成 `Order.NOT_CANCELLABLE`** → 對外契約破壞（`ORDER_NOT_CANCELLABLE` 要靠字串拼接產生，而拼接會出錯） |

**方式 C：每個領域一個獨立 enum**

```java
public enum OrderErrorCode implements ErrorCode { ... }
public enum CouponErrorCode implements ErrorCode { ... }
```

| | |
|---|---|
| ✅ | 檔案小、找得到、領域邊界清楚 |
| 🔴🔴 | **`ErrorCode.values()` 不存在了** —— 而 04-controller 3.4.5 與 7.8.2 的一致性測試**整個建立在 `values()` 上** |
| 🔴 | 需要一個註冊機制才能遍歷全部（而「註冊」= 會漏） |

⚠️ **方式 C 的致命問題值得展開。** 04-controller 7.8.2 那個測試是：

```java
@ParameterizedTest
@MethodSource("allErrorCodes")     // ← ErrorCode.values()
void 每個code都有完整契約(ErrorCode code) { ... }
```

**它用一個測試覆蓋 83 個 code**，而那個能力來自「enum 可以遍歷」。
換成方式 C 之後，`allErrorCodes()` 要手動列出所有 enum 類別 ——
**而「手動列出」正是這個測試存在的理由（防止有人漏掉）。**

**方式 D：`sealed interface` + 多 enum**

```java
public sealed interface ErrorCode permits OrderErrorCode, CouponErrorCode, ... { }
```

| | |
|---|---|
| ✅ | 型別安全 + 可遍歷（`permits` 清單就是註冊表，而**漏掉會編譯錯誤**） |
| 🔴🔴 | **改動範圍**：`ErrorCode` 從 enum 變 interface → 所有 `switch` 全改、`name()` 要自己定義、`values()` 要自己組、Jackson 序列化要改、`EnumMap` / `EnumSet` 全部不能用 |

> 📌 **方式 D 是「如果從零開始」的最佳答案**，
> 而 shop-service 不是從零開始 —— 它有 83 個既有 code 與五組建立在 `values()` 上的測試。
> **「更好的設計」與「值得現在改」是兩個不同的判斷。**

### 4.2.3 shop-service 的決定：方式 A + 一條「分區守門」測試 ★★

**保留單一平坦 enum**，理由三個：

| 理由 | 說明 |
|---|---|
| **`values()` 是五個測試的基礎** | 04-controller 3.4.5 的四個一致性測試 + 7.8.2 的契約測試 |
| **`code` 是對外契約** | `ORDER_NOT_CANCELLABLE` 這個字串已經在 API 文件、前端的 `switch`、監控的告警規則裡 |
| 98 個常數的維護成本是**可以用測試買掉的** | 下面那條測試 |

⚠️ **而「分區會腐敗」這個問題（4.2.1 問題 2）要用一條測試關掉。**
**這一小節值得完整走一遍，因為第一版的規則是錯的** ——
而「規則錯了」這件事是**跑測試才知道的**。

#### 第一版規則：常數順序依狀態碼單調不遞減

```java
@Test
void 常數順序依狀態碼遞增() {
    List<String> violations = new ArrayList<>();
    ErrorCode previous = null;
    for (ErrorCode code : ErrorCode.values()) {
        if (previous != null && code.status().value() < previous.status().value()) {
            violations.add("%s(%d) 宣告在 %s(%d) 之後"
                    .formatted(code.name(), code.status().value(),
                               previous.name(), previous.status().value()));
        }
        previous = code;
    }
    assertThat(violations).isEmpty();
}
```

**實際跑出來**（Java 21 / Spring Boot 3.2.5 / 98 個 code）：

```
ORDER_NOT_CANCELLABLE(409) 宣告在 UNSUPPORTED_MEDIA_TYPE(415) 之後
PAYLOAD_TOO_LARGE(413) 宣告在 IF_MATCH_REQUIRED(428) 之後
REQUEST_TIMEOUT(503) 宣告在 PAYMENT_OUTCOME_UNKNOWN(504) 之後
SELF_CANCEL_WINDOW_EXPIRED(409) 宣告在 REQUEST_TIMEOUT(503) 之後
ORDER_INTERNAL_FIELD_NOT_EDITABLE(403) 宣告在 ORDER_PATCH_EMPTY(422) 之後
ORDER_INVOICE_ALREADY_ISSUED(409) 宣告在 ORDER_NOTE_TOO_LONG(422) 之後

違反數 = 6
code 總數 = 98
```

⚠️⚠️ **六個違反分成兩種，而它們的意義完全不同**：

| # | 違反 | 是 bug 嗎 |
|---|---|---|
| 1 | `409` 在 `415` 之後 | 🚫 **不是** —— 04-controller 3.4.2 刻意把 `405 / 406 / 415` 排在一起（它們是「協商類」），而那讓 415 跑到 409 前面 |
| 2 | `413` 在 `428` 之後 | 🚫 **不是** —— `412 / 428` 是「條件請求」的一對 |
| 3 | `REQUEST_TIMEOUT(503)` 在 `504` 之後 | ⚠️ **是** —— 但它是 04-controller 3.4.2 的既有排版瑕疵，不是本站新增的 |
| 4 | `SELF_CANCEL_WINDOW_EXPIRED(409)` 在 `503` 之後 | 🔴 **是** —— 00 章 0.12 ⑮ 把 10 個新 code **append 在最後面** |
| 5 | `ORDER_INTERNAL_FIELD_NOT_EDITABLE(403)` 在 `422` 之後 | 🔴 **是** —— 03 章 3.10.3 ⑦ 同樣 append |
| 6 | `ORDER_INVOICE_ALREADY_ISSUED(409)` 在 `422` 之後 | 🔴 **是** —— 本章 4.2.4 也 append 了 |

**於是第一版規則被實測推翻**：

> 🔴 **「單調不遞減」不是我們要的規則。**
> 分區順序**刻意不是**數字順序（`405/406/415` 一組、`412/428` 一組），
> 而那是對的 —— **分區是按「語意」分的，不是按數字。**

#### 第二版規則：每個狀態碼的常數必須「連續」

**我們真正在意的不是「順序」，是「同一個狀態碼不要出現在兩個地方」。**

```java
package example.shop.common.error;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ErrorCodeLayoutTest {

    /**
     * ★★ 同一個 HTTP 狀態碼的常數必須連續宣告。
     *
     * <p>它抓的是 4.2.1 問題 2 的<b>真實形狀</b>：
     * 不是「順序錯」，而是<b>「409 這一區被切成四塊」</b>——
     * 於是「加一個 409」的人找不到該加在哪裡，就 append 在檔案最後，
     * 於是下一個人再 append，於是分區徹底失效。
     *
     * <p>⚠️ 這條規則<b>不管分區之間的順序</b>，因為那是語意分組
     * （{@code 405/406/415} 是「協商類」、{@code 412/428} 是「條件請求類」），
     * 而語意分組不該被數字大小綁住。
     */
    @Test
    void 每個狀態碼的常數必須連續宣告() {
        ErrorCode[] all = ErrorCode.values();

        // ── 掃出每個狀態碼的「連續區段」──────────────────────────
        Map<HttpStatus, List<int[]>> runs = new LinkedHashMap<>();
        int i = 0;
        while (i < all.length) {
            HttpStatus status = all[i].status();
            int start = i;
            while (i < all.length && all[i].status() == status) { i++; }
            runs.computeIfAbsent(status, k -> new ArrayList<>()).add(new int[]{start, i - 1});
        }

        // ── 超過一個區段 = 這一區被切開了 ────────────────────────
        List<String> violations = new ArrayList<>();
        runs.forEach((status, segments) -> {
            if (segments.size() > 1) {
                var names = segments.stream()
                        .map(seg -> seg[0] == seg[1]
                                ? all[seg[0]].name()
                                : all[seg[0]].name() + ".." + all[seg[1]].name())
                        .toList();
                violations.add("%d 被切成 %d 段：%s".formatted(
                        status.value(), segments.size(), names));
            }
        });

        assertThat(violations)
                .as("""
                    同一個狀態碼的 ErrorCode 要連續宣告。
                    修法：把散落的常數搬回它的分區，不要 append 在檔案最後。
                    """)
                .isEmpty();
    }
}
```

**實際跑出來**：

```
403 FORBIDDEN 被切成 2 段:
    [INSUFFICIENT_ROLE..FORBIDDEN_PARAMETER] [ORDER_INTERNAL_FIELD_NOT_EDITABLE]
409 CONFLICT 被切成 4 段:
    [ORDER_NOT_CANCELLABLE..EMAIL_ALREADY_REGISTERED]
    [SELF_CANCEL_WINDOW_EXPIRED..RETURN_WINDOW_EXPIRED]
    [ORDER_INVOICE_REQUEST_IN_FLIGHT]
    [ORDER_INVOICE_ALREADY_ISSUED]
422 UNPROCESSABLE_ENTITY 被切成 3 段:
    [VALIDATION_FAILED..DEEP_PAGINATION_LIMIT]
    [MIXED_CURRENCY..ORDER_PATCH_EMPTY]
    [ORDER_NOTE_TOO_LONG]
503 SERVICE_UNAVAILABLE 被切成 2 段:
    [SERVICE_UNAVAILABLE..PAYMENT_GATEWAY_UNAVAILABLE] [REQUEST_TIMEOUT]

---- 分區順序 ----
400 401 402 403 404 405 406 415 409 410 412 428 413 422 429 202 500 502 503 504
```

✅ **這一次每一個違反都是真的**：

| 被切開的區 | 誰切的 | 修法 |
|---|---|---|
| **409（4 段）** | 00 章 ⑮ append 4 個、03 章 ⑦ append 1 個、本章 append 1 個 | 全部搬回 `ORDER_NOT_CANCELLABLE..EMAIL_ALREADY_REGISTERED` 那一區 |
| **422（3 段）** | 00 章 ⑮ append 6 個、03 章 ⑦ append 2 個 | 搬回 `VALIDATION_FAILED..DEEP_PAGINATION_LIMIT` |
| **403（2 段）** | 03 章 ⑦ append 1 個 | 搬回 `INSUFFICIENT_ROLE..FORBIDDEN_PARAMETER` |
| **503（2 段）** | ⚠️ **04-controller 3.4.2 本來就有** —— `REQUEST_TIMEOUT` 被放在 `504` 之後 | 搬到 `PAYMENT_GATEWAY_UNAVAILABLE` 之後 |

⚠️ **最後一列值得注意**：這條測試抓到的第一個問題**不在本站**。
04-controller 那個 enum 從第一版就有這個瑕疵，而三輪複查都沒抓到 ——
因為**人在讀 700 行的 enum 時不會去比對每一行的狀態碼**。

#### 一次性的重排，以及它的代價

**把 15 個常數搬回它們的分區**，然後這條測試永遠綠。

⚠️ **而它有一個真實的代價，要誠實說**：

| 代價 | 具體 |
|---|---|
| **新增 code 會改到既有的行** | 加一個 409 要插在 `EMAIL_ALREADY_REGISTERED` 後面 → git diff 顯示「改了兩行」而不是「加了一行」 |
| **合併衝突變多** | 兩個分支各加一個 409 → **同一個位置** → 每次都衝突 |
| `git blame` | 沒有影響（插入不會改動既有常數那一行的內容） |

**「合併衝突」是唯一真的成本**，而它的量級是：
一年新增約 10 個 code、兩個分支同時加同一區的機率不高、
而衝突的解法是「把兩行都留下」—— **10 秒鐘**。

**對照它買到的**：

```
沒有這條測試：三章下來 409 被切成 4 段，第五個人不可能找到該加在哪
有這條測試：  加錯位置 → CI 紅燈 + 一句「把它搬回它的分區」
```

> 📌 **這一小節的真正教訓不是「寫這條測試」，而是**：
>
> **第一版規則（單調遞增）看起來更嚴格、更容易寫、更「正確」——
> 而它是錯的，因為它把「語意分組」誤認為「數字排序」。**
>
> ⚠️⚠️ **而發現它錯的方式是「跑了一次」。**
> 如果只是把它寫進課程，讀者會照抄，然後在自己的專案裡看到 6 個紅燈，
> 然後**加 6 個例外到 `exempt` 清單**，
> 然後那條規則就變成裝飾品 —— **一條有 6 個例外的規則不是規則。**

#### 第三條測試：印出「同模式」的 code 供 review

4.2.1 的問題 1（找不到已存在的同類 code）**不能**用會失敗的測試解決：

```java
    /**
     * ★ 印出「同後綴模式」的 code。
     *
     * <p>⚠️ 它<b>永遠不會失敗</b> —— 它的價值在 CI 的輸出，
     * 讓 review 時看到「你要加的東西已經有三個兄弟了」。
     *
     * <p>為什麼不寫成會失敗的規則：{@code NOT_FOUND} 有 6 個，
     * 而它們<b>全部都是對的</b>（訂單／券／購物車項目／商品／圖片／端點）。
     * 「同模式的要不要合併」是設計判斷（4.2.6），不是機械規則。
     */
    @Test
    void 印出同模式的code供review() {
        var byPattern = new java.util.TreeMap<String, List<String>>();
        for (ErrorCode code : ErrorCode.values()) {
            String[] parts = code.name().split("_");
            if (parts.length < 2) { continue; }
            // 取最後兩段當「模式」：WINDOW_EXPIRED、NOT_FOUND、LIMIT_EXCEEDED…
            String pattern = parts[parts.length - 2] + "_" + parts[parts.length - 1];
            byPattern.computeIfAbsent(pattern, k -> new ArrayList<>()).add(code.name());
        }
        byPattern.entrySet().stream()
                 .filter(e -> e.getValue().size() >= 2)
                 .forEach(e -> System.out.printf("%-22s %s%n", e.getKey(), e.getValue()));

        assertThat(byPattern).isNotEmpty();
    }
```

**實際輸出**（98 個 code）：

```
LIMIT_EXCEEDED    [PRODUCT_IMAGE_LIMIT_EXCEEDED, ORDER_ITEM_LIMIT_EXCEEDED,
                   PURCHASE_LIMIT_EXCEEDED, RATE_LIMIT_EXCEEDED,
                   ADDRESS_CHANGE_LIMIT_EXCEEDED]
NOT_ALLOWED       [METHOD_NOT_ALLOWED, NEGATIVE_STOCK_NOT_ALLOWED]
NOT_EDITABLE      [ORDER_ADDRESS_NOT_EDITABLE, ORDER_INTERNAL_FIELD_NOT_EDITABLE]
NOT_FOUND         [RESOURCE_NOT_FOUND, ENDPOINT_NOT_FOUND, COUPON_NOT_FOUND,
                   CART_ITEM_NOT_FOUND, PRODUCT_NOT_FOUND, PHOTO_NOT_FOUND]
NOT_RETURNABLE    [ORDER_NOT_RETURNABLE, ITEM_NOT_RETURNABLE]
QUANTITY_EXCEEDED [RETURN_QUANTITY_EXCEEDED, SHIPMENT_QUANTITY_EXCEEDED]
WINDOW_EXPIRED    [REFUND_WINDOW_EXPIRED, SELF_CANCEL_WINDOW_EXPIRED,
                   RETURN_WINDOW_EXPIRED]
```

⚠️ **這份輸出立刻暴露了一個之前沒注意到的問題**：

```
NOT_ALLOWED  [METHOD_NOT_ALLOWED, NEGATIVE_STOCK_NOT_ALLOWED]
```

`METHOD_NOT_ALLOWED`（405，**HTTP 的詞彙**）與
`NEGATIVE_STOCK_NOT_ALLOWED`（409，**業務規則**）共用同一個後綴，
**而它們是完全不同的東西**。
依 4.2.5 的規則 2（「不含 HTTP 詞彙」），
`NEGATIVE_STOCK_NOT_ALLOWED` 其實該叫 **`STOCK_WOULD_GO_NEGATIVE`**。

**但它不會被改名**，理由是 4.2.5 開頭那句：**`code` 是對外契約，改名 = 破壞性變更。**
👉 **處置：記進「已知的命名不一致」清單**（4.14 誤區 4），不改。

> 📌 **「印出來的報表」比「會失敗的測試」多做到一件事**：
> 它會回答**你沒有問的問題**。
> 上面那個 `NOT_ALLOWED` 的撞名，沒有任何規則在找它 —— 是那份清單自己浮出來的。

### 4.2.4 本章補上第 98 個：`ORDER_INVOICE_ALREADY_ISSUED` 🔴

03 章 3.10.3 ⑦ 新增了 `ORDER_INVOICE_REQUEST_IN_FLIGHT`，理由欄寫著：

> 與 `ORDER_INVOICE_ALREADY_ISSUED` 不同：一個是「已開立」（終態），一個是「處理中」（**可重試**）

⚠️ **而 `ORDER_INVOICE_ALREADY_ISSUED` 從來沒有被加進 `ErrorCode`。**

**它是怎麼漏的**：

```java
// 03 章 3.6.5 的 Order.clearInvoice()
if (invoiceIssuedAt != null) {
    throw new InvoiceAlreadyIssuedException(id, invoiceIssuedAt);    // ← 有人用它
}
```

例外被**使用**了（javadoc 的 `@throws` 也寫了），
但它的**定義**與對應的 `ErrorCode` 都不存在 ——
**因為 3.10.3 ⑦ 那張表的作者在比較「新 code 與既有 code 的差異」時，
把「既有 code」寫成了一個他以為存在的東西。**

**這是一個「假前提的比較」**：
「A 與 B 不同」這句話成立，**不代表 B 存在**。

```java
    // ── 409 狀態衝突 ──────────────────────────────────────────
    ...
    EMAIL_ALREADY_REGISTERED(HttpStatus.CONFLICT,             "email-already-registered"),
    // ★ 04 章 4.2.4 新增（第 98 個）
    ORDER_INVOICE_ALREADY_ISSUED(HttpStatus.CONFLICT,         "order-invoice-already-issued"),
```

```properties
# error-messages_zh_TW.properties
error.ORDER_INVOICE_ALREADY_ISSUED.title=發票已開立
error.ORDER_INVOICE_ALREADY_ISSUED.user=此訂單的發票已於 {0} 開立，如需更改請聯絡客服。
```

⚠️ **注意 `{0}`**：它代表**每一個**拋這個 code 的地方都必須傳開立時間
（04-controller 3.4.5 的 `訊息參數一致()` 測試會檢查）。

> 📌 **這個漏洞為什麼三章都沒被發現**：
>
> | 方向 | 守它的測試 | 抓不到什麼 |
> |---|---|---|
> | 「每個 **code** 都有例外用它」 | `ErrorCodeUsageTest`（04-controller 3.14.5） | 例外沒有 code |
> | 「每個 **例外** 都有 code」 | 本章 4.12.1 | code 沒有例外 |
> | **「散文引用的 code 存在」** | 🔴 **兩條都抓不到** | **就是這一次漏的** |
>
> 那個 code 既沒有例外也沒有定義 —— 它只存在於**一張表格的理由欄**裡。
> **唯一能抓到它的機制是「符號檢查」**（04-controller 5.12.4 那個把
> 文件裡的型別名與方法名拿去比對真實程式碼的工具）。
> 4.12.5 會把它列進「這個 bug 誰抓得到」的表。

### 4.2.5 `ErrorCode` 的六條命名規則

98 個常數如果沒有命名規則，第 99 個一定會發明第七種寫法。

| # | 規則 | ✅ | 🔴 |
|---|---|---|---|
| 1 | **主體在前，動作／狀態在後** | `ORDER_NOT_CANCELLABLE` | `CANNOT_CANCEL_ORDER` |
| 2 | **不含狀態碼與 HTTP 詞彙** | `INSUFFICIENT_STOCK` | `CONFLICT_STOCK`、`BAD_REQUEST_STOCK` |
| 3 | **不含層名與技術詞** | `ORDER_PATCH_EMPTY` | `SERVICE_VALIDATION_FAILED`、`DAO_ERROR` |
| 4 | **「做不到」用 `NOT_XXX`，「已經是」用 `ALREADY_XXX`** | `ORDER_NOT_SHIPPABLE` / `ORDER_ALREADY_PAID` | `ORDER_SHIP_FAILED` |
| 5 | **期限類一律 `XXX_WINDOW_EXPIRED`** | `RETURN_WINDOW_EXPIRED` | `RETURN_TOO_LATE`、`RETURN_DEADLINE_PASSED` |
| 6 | **上限類一律 `XXX_LIMIT_EXCEEDED`** | `ORDER_ITEM_LIMIT_EXCEEDED` | `TOO_MANY_ITEMS` |

⚠️ **規則 2 值得展開，因為它最容易被違反。**

```java
// 🔴 真實案例（另一個專案）
CONFLICT_ORDER_STATE(HttpStatus.CONFLICT, "conflict-order-state"),
```

**問題不是「醜」，是「狀態碼會變」**：

```
2024-03：CONFLICT_ORDER_STATE → 409
2025-01：產品決定改回 422（因為前端把所有 409 都當「重新整理就好」）
       → code 叫 CONFLICT_ 但回 422
       → 而 code 是對外契約，不能改名
```

**於是永遠有一個叫 `CONFLICT_XXX` 的 422。**

> 📌 **一般規則**：
> **名字裡不要放「比它自己更容易變的東西」。**
> `code` 是最穩定的那一層（它不能改名），
> 所以它不該引用比它更不穩定的東西（狀態碼、層名、實作技術）。

⚠️ **而規則 3 有一個刻意的例外**：`VALIDATION_FAILED`。
它的名字裡沒有層名，但它的**語意**是「Bean Validation 或 Service 語意驗證失敗」——
一個實作概念。4.6.2 會處理它帶來的問題。

### 4.2.6 什麼時候該新增 code，什麼時候該重用

**判準只有一個**：

> **客戶端會不會因為這兩種情況而做不同的事？**

| 情況 | 決定 | 理由 |
|---|---|---|
| `ORDER_NOT_CANCELLABLE` vs `SELF_CANCEL_WINDOW_EXPIRED` | ✅ **兩個** | 一個引導到「此狀態無法取消」，一個引導到**客服**（00 章 0.12 ⑮） |
| `RETURN_WINDOW_EXPIRED` vs `REFUND_WINDOW_EXPIRED` | ✅ **兩個** | 退貨期限（送達 +7 天）vs 金流商期限（180 天）—— 前者引導到客服，後者無解 |
| 「訂單找不到」vs「訂單存在但不是你的」 | 🔴 **一個**（`RESOURCE_NOT_FOUND`） | ⚠️ 刻意合併 —— 分開會洩漏「這張訂單存在」（01 章 1.8.3） |
| `PRODUCT_NOT_FOUND` vs `PRODUCT_DISCONTINUED` | ✅ **兩個** | 一個是「你打錯了」（422），一個是「以前有現在沒了」（410）—— **410 讓客戶端可以清掉本地快取** |
| 「券過期」vs 「券還沒開始」 | ✅ **兩個** | 「還沒開始」要顯示**開始時間** |
| 「備註太長」vs「發票號碼格式錯」 | 🔴 **一個**（`VALIDATION_FAILED` + `errors[]`） | 兩者都是欄位級錯誤，前端的處理完全一樣：**標紅那一欄** |

⚠️ **最後一列與 03 章 3.10.3 ⑦ 的 `ORDER_NOTE_TOO_LONG` 看起來矛盾。** 它不矛盾：

| 位置 | 用什麼 | 為什麼 |
|---|---|---|
| **Web 層**（`@TextLength`） | `VALIDATION_FAILED` + `errors[{field: "customerNote"}]` | 它**知道是哪個欄位** |
| **Domain 層**（`Order.changeCustomerNote`） | `ORDER_NOTE_TOO_LONG` | 它**不知道**這個字串在請求 JSON 裡的路徑 |

**「知不知道欄位路徑」是決定用哪一個的關鍵**，
因為 `errors[].field` 的值必須是**請求 body 的 JSON path**，
而 Domain 層拿到的是一個 `String note` 參數 ——
它不可能知道呼叫者把它放在 `customerNote` 還是 `note` 還是 `items[3].note`。

> 📌 **這一節的一般規則**：
> **`code` 的粒度由「客戶端的分支」決定，不由「錯誤的原因」決定。**
> 兩種原因、同一種處理 → 一個 code。
> 一種原因、兩種處理 → **兩個 code**（4.7 是這個情況的極端版本）。

---

## 4.3 例外階層：三層還是兩層 ★★

### 4.3.1 三個候選階層

04-controller 3.5.1 畫的是**兩層**：

```
RuntimeException
  ├── BusinessException（抽象基底）          ← 「已預期的失敗」
  │     ├── ResourceNotFoundException
  │     ├── OrderNotCancellableException
  │     └── …（26 個具體例外）
  └── 其他 RuntimeException                  ← 「未預期的失敗」= bug
```

⚠️ **而 26 個直接繼承 `BusinessException` 的類別在實務上會出現一個具體問題**：

```java
// ★ 需求：「客服後台要能一次看到某張訂單今天觸發過哪些『訂單狀態類』的錯誤」
//   → 需要「這是不是訂單狀態衝突」這個判斷
if (ex instanceof OrderNotCancellableException
        || ex instanceof OrderNotShippableException
        || ex instanceof OrderNotDeliverableException
        || ex instanceof OrderNotReturnableException
        || ex instanceof OrderAlreadyPaidException
        || ex instanceof SelfCancelWindowExpiredException) {   // ← 🔴 會漏第七個
    ...
}
```

**「六個 `instanceof` 串起來」是「缺一個中間層」的症狀。**

**三個候選**：

**候選 A：兩層（現狀）**

```
BusinessException
  └── 26 個具體例外
```

**候選 B：三層（按領域分組）**

```
BusinessException
  ├── OrderException
  │     ├── OrderNotCancellableException
  │     ├── OrderNotShippableException
  │     └── …
  ├── CouponException
  │     ├── CouponExpiredException
  │     └── …
  ├── PaymentException
  └── ProductException
```

**候選 C：三層（按狀態碼分組）**

```
BusinessException
  ├── StateConflictException        （409）
  ├── SemanticErrorException        （422）
  ├── NotFoundException             （404）
  └── ForbiddenException            （403）
```

### 4.3.2 `OrderNotCancellableException` 該繼承誰

**把三個候選各自套到這個例外上，看它們各自能回答什麼問題**：

| 問題 | A（兩層） | B（按領域） | C（按狀態碼） |
|---|---|---|---|
| 「這是訂單相關的錯誤嗎」 | 🔴 六個 `instanceof` | ✅ `instanceof OrderException` | 🔴 不可能（訂單錯誤散在四個分支） |
| 「這該回 409 嗎」 | ✅ `ex.errorCode().status()` | ✅ 同左 | ✅ 同左（**而且中間層是多餘的**） |
| 「這該記 warn 還是 error」 | ✅ `ex.errorCode().isServerError()` | ✅ 同左 | ✅ 同左 |
| 「客服後台要列出訂單類錯誤」 | 🔴 | ✅ | 🔴 |
| **「新增一個 code 時要不要動階層」** | ✅ 不用 | ⚠️ 要選一個父類別 | 🔴🔴 **狀態碼改了要換父類別** |

⚠️ **候選 C 的最後一列是致命的。** 展開它：

```java
// 2024-03：SELF_CANCEL_WINDOW_EXPIRED 是 409
public class SelfCancelWindowExpiredException extends StateConflictException { }

// 2025-01：產品決定改成 422（「這是輸入問題，不是狀態問題」）
public class SelfCancelWindowExpiredException extends SemanticErrorException { }
//                                                    ↑ 🔴 換父類別 = 破壞所有 catch
```

**而「換父類別」會靜默破壞既有的 `catch`**：

```java
// 某個地方寫了
try { orders.cancel(cmd); }
catch (StateConflictException e) { retryLater(); }    // ← 改了父類別之後這裡不再接到它
```

**編譯得過**（因為 `StateConflictException` 還存在，只是不再是它的父類別），
**測試不一定紅**（那個 `catch` 分支可能沒有測試），
**行為靜默改變**。

> 📌 **一般規則（與 4.2.5 規則 2 是同一件事的另一個形狀）**：
> **階層不該按「會變的維度」分組。**
> 狀態碼會變，領域不會變 —— 一個訂單相關的錯誤永遠是訂單相關的。

### 4.3.3 「按狀態碼分層」為什麼特別誘人

⚠️ 候選 C 值得多花一段，因為**它是最常見的第一版設計**，而理由聽起來很好：

> 「這樣 advice 就可以寫成四個 handler，各自回對應的狀態碼」

```java
@ExceptionHandler(StateConflictException.class)
public ResponseEntity<Problem> handleConflict(StateConflictException ex) {
    return ResponseEntity.status(409).body(...);         // ← 狀態碼寫死在這裡
}
```

**這個寫法的問題不是「多寫三個 handler」，是它把狀態碼放進了第二個地方。**

| 狀態碼的定義位置 | 候選 A/B | 候選 C |
|---|---|---|
| `ErrorCode.status()` | ✅ 唯一 | ⚠️ 一份 |
| 例外的父類別 | — | ⚠️ 第二份 |
| advice 的 handler | — | ⚠️ 第三份 |

**三份 = 一定會不一致**，而不一致的形狀是 04-controller 3.4.1 那個真實案例：
`COUPON_EXPIRED` 在一個端點回 422、在另一個回 400。

✅ **候選 A/B 的 advice 只需要一個 handler**：

```java
@ExceptionHandler(BusinessException.class)
public ResponseEntity<Problem> handle(BusinessException ex, HttpServletRequest req) {
    Problem problem = problems.from(ex, ProblemFactory.instanceOf(req));
    return ResponseEntity.status(ex.errorCode().status()).body(problem);
    //                          ↑ ★ 狀態碼只有一個來源
}
```

> 📌 **「一個 handler 處理 98 種錯誤」是這個設計的成果，不是妥協。**
> 它成立的條件是**狀態碼由資料（`ErrorCode`）決定，而不是由型別決定**。

### 4.3.4 shop-service 的決定：**兩層 + 三個標記介面** ★★

**選候選 A（兩層），並用標記介面補上 4.3.1 那個「六個 `instanceof`」的需求。**

⚠️ **為什麼不選 B**：那個「客服後台列出訂單類錯誤」的需求**只出現一次**，
而 `OrderException` 這個中間層要付的代價是：

| 代價 | 具體 |
|---|---|
| 新增例外要**選父類別** | 「`IdempotencyKeyReusedException` 是 Order 還是 Common？」—— 一個沒有正確答案的問題 |
| 跨領域的例外無處安放 | `MixedCurrencyException` 是 Order 還是 Product 的問題？（它其實是**商品資料**的問題，但在**下單**時才被發現） |
| 階層變深 → `getCause()` 鏈變長 | 除錯時要多看一層 |

**而那一個需求用一行就解決了**：

```java
// 客服後台
boolean isOrderRelated = ex.errorCode().name().startsWith("ORDER_");
```

⚠️⚠️ **「用字串前綴代替型別」聽起來是退步，而在這裡它是對的**，理由：

> **`code` 的命名規則（4.2.5 規則 1：主體在前）已經編碼了「領域」這個資訊。**
> 再用一層類別階層表達同一件事 = **兩份真相**。
> 而如果要守它，一條測試就夠：**「每個 `ORDER_` 開頭的 code 都由 `order` 套件拋出」**（4.12.3）。

#### 三個標記介面

**它們與「分組」無關 —— 它們表達的是「這個例外需要被特殊對待」。**

```java
package example.shop.common.error.marker;

/**
 * ★ 標記：這個例外由 {@code order.domain} 套件拋出（不變量的最後一道防線）。
 *
 * <p>用途有兩個：
 * <ol>
 *   <li>ArchUnit 規則：{@code order.domain} 只能拋實作這個介面的例外（4.12.3）。</li>
 *   <li>它代表「Web 層本來應該擋掉但沒擋到」→ 值得一條 {@code warn} 加上
 *       一個「哪一層漏了」的標籤（4.12.3）。</li>
 * </ol>
 */
public interface DomainException { }
```

```java
package example.shop.common.error.marker;

/**
 * ★★ 標記：這個例外的 {@link example.shop.common.error.ErrorCode}
 * 取決於「誰問的」（4.7）。
 *
 * <p>⚠️ 它<b>不提供</b>「advice 去查 Actor」的能力 ——
 * 那是 4.7.3 明確否決的做法。
 * 它只是一個<b>給守門測試用的標記</b>，讓 4.12.1 能檢查
 * 「這個例外的每一個建構子都收 Actor」。
 */
public interface ActorScopedStatus { }
```

```java
package example.shop.common.error.marker;

/**
 * ★★ 標記：拋這個例外時，<b>已經有不可回復的副作用發生了</b>。
 *
 * <p>它改變三件事：
 * <ol>
 *   <li>advice 的 {@code userMessage} 不可以說「操作未執行」。</li>
 *   <li>日誌等級升到 {@code error} 並<b>觸發告警</b>（即使它是 4xx）。</li>
 *   <li>{@code Problem} 多一個 {@code sideEffects} 欄位，告訴客戶端「哪些事已經做了」。</li>
 * </ol>
 *
 * <p>⚠️ 它<b>不是</b>「這個操作失敗了」的意思 ——
 * 它是「這個操作<b>部分成功</b>，而失敗的那一半需要人處理」。
 */
public interface SideEffectsCommitted {
    /** 已經發生、無法回復的副作用（給客戶端顯示，也給運營查）。 */
    java.util.List<String> committedSideEffects();
}
```

**三個標記各自解決哪一個事故**：

| 標記 | 解決 | 沒有它會怎樣 |
|---|---|---|
| `DomainException` | 事故 2 | Domain 的最後一道防線與 Application 的驗證**在監控上長得一樣**，於是「哪一層漏了」查不出來 |
| `ActorScopedStatus` | 4.7 的問題 | 「同一個例外兩個狀態碼」會被實作成「advice 裡讀 `SecurityContextHolder`」（4.7.3） |
| **`SideEffectsCommitted`** | **事故 3** | ⚠️ 「退款失敗但貨已收」與「退款失敗且什麼都沒做」**在回應上完全相同** |

⚠️ **`SideEffectsCommitted` 是這三個裡唯一「會改變回應內容」的**，
所以它需要 advice 配合。**它就是事故 3 選項 ② 缺的那一半**：

```java
@ExceptionHandler(BusinessException.class)
public ResponseEntity<Problem> handle(BusinessException ex, HttpServletRequest req) {

    Problem problem = problems.from(ex, ProblemFactory.instanceOf(req));

    // ★★ 副作用已發生 → 補一個欄位 + 升級日誌 + 告警
    if (ex instanceof SideEffectsCommitted sec) {
        problem = problem.withExtension("sideEffects", sec.committedSideEffects());
        log.error("業務例外但副作用已發生 code={} sideEffects={}",
                  ex.errorCode(), sec.committedSideEffects(), ex);
        // ⚠️ 這裡是刻意的 error 而不是 warn —— 它需要有人看（事故 3）
    }
    return ResponseEntity.status(ex.errorCode().status()).body(problem);
}
```

`Problem.withExtension` 是這一章要加的一個小工具（`Problem` 是 record，所以要重建）：

```java
// 加到 example.shop.common.web.Problem
/**
 * ★ 補一個擴充欄位（record 是不可變的，所以回傳新實例）。
 *
 * <p>⚠️ 刻意<b>不</b>提供 {@code removeExtension} ——
 * 「例外決定了帶哪些欄位」是 4.5.3 的規則，advice 不該拿掉它們。
 */
public Problem withExtension(String key, Object value) {
    var merged = new java.util.LinkedHashMap<String, Object>(
            extensions == null ? java.util.Map.of() : extensions);
    merged.put(key, value);
    return new Problem(type, title, status, detail, instance, code, userMessage,
                       errors, errorCount, errorsTruncated, retryable, retryStrategy,
                       traceId, timestamp, merged);
}
```

### 4.3.5 標記介面 vs 抽象類別 vs 註解

**「需要標記一群例外」有三種做法。** 為什麼選介面：

| 做法 | 優點 | 為什麼不選 |
|---|---|---|
| **抽象類別**（`abstract class SideEffectException extends BusinessException`） | 可以帶欄位與實作 | 🔴🔴 **Java 單一繼承** —— 一個例外不可能同時是 `DomainException` 與 `SideEffectsCommitted` |
| **註解**（`@SideEffectsCommitted`） | 不影響階層、可以帶屬性 | 🔴 **拿不到資料** —— `committedSideEffects()` 的內容是**執行期**才知道的（哪幾件事已經做了），註解只能放常數 |
| **標記介面** ✅ | 可以多重實作、可以宣告方法、`instanceof` 有型別窄化 | 需要每個類別自己實作方法（而那是好事，見下） |

⚠️ **「註解拿不到資料」這一點是決定性的**，值得看一個具體對照：

```java
// 🔴 註解版：只能說「有副作用」，說不出「是哪些」
@SideEffectsCommitted(kinds = {"REFUND"})     // ← 編譯期常數
public class RefundRejectedException extends BusinessException { }

// ✅ 介面版：可以說「訂單 O-123 的退貨已收貨、退款 NT$1,200 未完成」
public class RefundRejectedException extends BusinessException
        implements SideEffectsCommitted {
    private final List<String> sideEffects;
    @Override public List<String> committedSideEffects() { return sideEffects; }
}
```

> 📌 **一般規則**：
> **註解適合「編譯期就固定的分類」，介面適合「執行期才知道內容的能力」。**
> 而「例外要帶執行期資料」是 4.5 整節的主題。

### 4.3.6 `sealed` 可以用在這裡嗎

Java 21 有 `sealed`，而 `BusinessException` 是抽象基底 —— 看起來很適合：

```java
public sealed abstract class BusinessException extends RuntimeException
        permits ResourceNotFoundException, OrderNotCancellableException, /* …26 個 */ { }
```

**它會買到一件事**：`switch` 上的窮盡性檢查。

```java
String hint = switch (ex) {
    case OrderNotCancellableException e -> "引導到退貨";
    case InsufficientStockException e   -> "引導到調整數量";
    // …26 個 case，沒有 default → 新增例外時編譯失敗
};
```

⚠️ **而它有三個具體問題**：

| 問題 | 說明 |
|---|---|
| **`permits` 要列 26 個，而它們在不同套件** | `sealed` 要求 permitted 子類別**在同一個模組**（未 modularize 的專案是同一個 named/unnamed module，所以技術上可以）—— 但 `common.error` 這個套件會 import 到 `order.domain`、`coupon.domain`… **反向依賴** |
| 🔴🔴 **它與 ArchUnit 的分層規則直接衝突** | 00 章 0.11.2 的規則是「`common` 不可依賴 `order`」，而 `permits` 就是一個依賴 |
| **窮盡的 `switch` 沒有真正的使用者** | advice 只需要 `ex.errorCode()`；沒有任何地方要對 26 種例外分別處理（**而如果有，那正是「邏輯放錯層」的訊號**） |

**第二個問題是決定性的。** 它不只是「規則不允許」——
**`common.error` 依賴 `order.domain` 會讓 `common` 無法被獨立測試或抽成函式庫。**

✅ **不用 `sealed`。** 而「窮盡性」用一條測試買回來：

```java
/**
 * ★ 每個 BusinessException 的具體子類別都必須在 4.6.1 的對應表裡。
 *
 * <p>它取代 sealed 的窮盡性檢查 ——
 * ⚠️ 差別是「CI 紅燈」而不是「編譯錯誤」，晚了幾秒但沒有依賴反轉。
 */
@Test
void 每個業務例外都在對應表裡() { /* 4.12.3 */ }
```

> 📌 **這是本站反覆出現的一個取捨**：
> **「編譯期」比「CI」好，但不能為了它把依賴方向弄反。**
> （00 章 0.11.2 的分層規則、03 章 3.8.2 的掃描測試都是同一個取捨。）

### 4.3.7 套件放哪裡

```
example.shop
├── common
│   └── error
│       ├── BusinessException.java              ★ 抽象基底（04-controller 3.5.2）
│       ├── ErrorCode.java                      ★ 98 個 code
│       ├── FieldViolation.java
│       ├── AlternativeAction.java
│       ├── ValidationFailedException.java      ★ 跨領域，所以在 common
│       ├── ResourceNotFoundException.java      ★ 跨領域
│       ├── InvariantViolationException.java    ★★ 本章 4.4.4 新增
│       └── marker
│           ├── DomainException.java            ★ 本章新增
│           ├── ActorScopedStatus.java          ★ 本章新增
│           └── SideEffectsCommitted.java       ★★ 本章新增
├── order
│   ├── domain
│   │   └── exception                            ★★ 本章新增（見下）
│   │       ├── OrderNotCancellableException.java
│   │       ├── OrderNotShippableException.java
│   │       ├── NoteTooLongException.java
│   │       └── …（14 個）
│   └── application
│       └── exception                            ★ 編排層才發現的錯誤
│           ├── EmptyPatchException.java
│           ├── ProductNotFoundException.java
│           └── …（7 個）
├── coupon
│   └── domain
│       └── exception                            ★ 6 個
└── payment
    └── domain
        └── exception                            ★ 3 個
```

⚠️⚠️ **這裡有一個與 04-controller 3.5.3 不同的決定，要明說。**

04-controller 把 `InsufficientStockException` 與 `OrderNotCancellableException`
放在 **`example.shop.order.service.exception`**。而本站 03 章 3.10.3 把
`order.service` 拆成 `order.application` + `order.domain`（00 章 0.14.3），
所以那個套件**已經不存在了**。

**新的歸屬判準**：

> **例外的套件 = 拋出它的那一層。**

| 例外 | 誰拋 | 套件 |
|---|---|---|
| `OrderNotCancellableException` | `Order.cancel()` | **`order.domain.exception`** |
| `NoteTooLongException` | `Order.changeCustomerNote()` | `order.domain.exception` |
| `EmptyPatchException` | `OrderApplicationService.update()` | **`order.application.exception`** |
| `ProductNotFoundException` | `OrderApplicationService.create()`（查完商品才知道） | `order.application.exception` |
| `InsufficientStockException` | ⚠️ **兩邊都有可能** | 見下 |

⚠️ **`InsufficientStockException` 是唯一需要判斷的一個**：

```java
// application 層：查庫存快照，發現不夠（0.9.4 第 ④ 步的「先檢查」）
if (snapshot.available() < line.quantity()) throw new InsufficientStockException(...);

// domain 層：Stock.reserve() 的最後一道防線（不變量 I3）
public void reserve(int qty) {
    if (available - qty < 0) throw new InsufficientStockException(...);
}
```

**兩個都要拋，而它們是同一個 code。** 三個選項：

| 選項 | 取捨 |
|---|---|
| ① 放 `domain`，application 也 import 它 | ✅ 一份定義。⚠️ application → domain 的依賴，**方向是對的** |
| ② 兩個類別（`...Detected` / `...Violation`） | 🔴 同一個 code 兩個例外 → 4.12.1 的測試要加例外 |
| ③ 放 `common.error` | 🔴 它是**庫存**領域的概念，放 `common` 會讓 `common` 慢慢變成垃圾桶 |

**選 ①。** 而它給出一條一般規則：

> 📌 **例外放在「最深的那一層」，上層 import 它。**
> 理由：**依賴方向永遠是「上層 → 下層」**，
> 所以放在下層的東西上層一定拿得到，反過來不成立。

⚠️ **而這條規則有一個真實的後果**：`order.domain.exception` 裡的例外
會被 `order.application` 與 `order.web` 都 import 到。
**那不是壞事** —— 03 章 3.2 反對的是「Entity 洩漏到 API 層」，
而**例外型別本來就是跨層契約的一部分**
（Controller 的 advice 必須認識 `BusinessException`）。

---

## 4.4 「可預期」與「不可預期」的界線 ★★

### 4.4.1 判準：誰能修好它

04-controller 3.5.1 的二分法是「已預期 / 未預期」，
而**那兩個詞在實務上會吵架** ——
「庫存不足」當然是「預期得到的」，但「資料庫連線斷掉」也是「預期得到的」。

**更好的判準是一個問句**：

> **這件事發生時，誰能做點什麼讓它不再發生？**

| 誰 | 例外種類 | 狀態碼 | 日誌 | 告警 |
|---|---|---|---|---|
| **呼叫端**（改請求內容、改狀態、等一下再來） | `BusinessException` | 4xx | `warn`（不印 stack trace） | ❌ |
| **我們**（改程式、修資料） | 其他 `RuntimeException` | 500 | `error` + 完整 stack trace | ✅ |
| **第三方**（金流商、物流商、DNS） | ⚠️ **看情況**，見 4.4.3 | 502 / 504 / 422 | `error` 或 `warn` | 通常 ✅ |
| **沒有人**（客戶的卡真的被銀行註銷了） | `BusinessException` | 4xx | `warn` | ❌ |

⚠️ **最後一列容易被誤判成 5xx。**
「客戶的卡被註銷」不是我們的 bug，也不是客戶打錯字 ——
**但它是「呼叫端可以做點什麼」（換一張卡），所以是 4xx。**

**把判準寫成一個可以照著問的流程**：

```
① 這件事是「我們的程式或資料有問題」嗎？
    是 → 500，不可預期，告警
    否 → ②

② 呼叫端改變任何東西（請求內容、資源狀態、時間）能讓它成功嗎？
    能 → 4xx，BusinessException，不告警
    不能 → ③

③ 是第三方暫時性的問題嗎（逾時、5xx、限流）？
    是 → 502 / 504，告警（我們要知道上游壞了）
    否 → ④

④ 是第三方的「明確拒絕」嗎（卡被拒、地址無法配送）？
    是 → 4xx，BusinessException，不告警
        ⚠️ 但如果拒絕率突然上升，那是一個【指標】問題不是【例外】問題（4.12.3）
    否 → 回到 ①，你可能漏想了什麼
```

⚠️ **第 ④ 步的那行警告是實務上最有價值的一句**：

```
金流商的「卡被拒」比率從 1.2% 跳到 34% —— 這不會有任何告警，
因為每一筆都是「正常的 402」。
```

**它必須用「指標 + 閾值」抓，而不是用「例外型別」抓。** 4.12.3 會給出那三個指標。

### 4.4.2 為什麼 `IllegalStateException` 刻意不是業務例外

`Order` 裡有大量這樣的檢查（00 章 0.9.2）：

```java
private void assertInvariants() {
    if (lines.isEmpty()) {
        throw new IllegalStateException("I1 violated: order has no lines");
    }
    if (refundedAmount().isGreaterThan(paidAmount())) {
        throw new IllegalStateException("I8 violated: refunded > paid");
    }
    ...
}
```

**這些刻意**不是 `BusinessException`，理由是：

| 理由 | 說明 |
|---|---|
| **它們是「不該發生」的** | `assertInvariants()` 在每個 mutator 結尾跑。它失敗代表**某個 mutator 的邏輯錯了** |
| **它們沒有「呼叫端能做的事」** | 「退款超過付款」不是使用者能修的 —— 是我們的計算錯了 |
| **500 + 告警是對的反應** | 有人要在半夜起來看 |
| **不變量的訊息不能給使用者看** | `"I8 violated: refunded > paid"` 洩漏內部設計 |

⚠️ **而這個決定有兩個真實的代價，04-controller 沒有提到**：

**代價 1：`IllegalStateException` 也被 JDK 與框架用**

```java
// Java 標準庫的 IllegalStateException（不是我們的不變量）
Optional.empty().get();                 // NoSuchElementException（好一點）
List.of(1,2,3).iterator().remove();     // UnsupportedOperationException
someStream.count(); someStream.count(); // IllegalStateException: stream has already been operated upon
```

**於是**：監控上看到「`IllegalStateException` 5 分鐘 12 次」時，
**無法分辨是「不變量被違反」還是「某個 stream 被重複消費」** ——
而兩者的嚴重程度差很多。

**代價 2：`IllegalStateException` 沒有結構化資料**

```
IllegalStateException: I8 violated: refunded > paid
```

**是哪張訂單？退了多少？付了多少？** 全部在那個字串裡，
而字串進 log 之後**不可查詢**（無法「列出這週所有 I8 違反的訂單」）。

### 4.4.3 四個難判斷的邊界案例

**邊界 1：資料庫唯一約束衝突**

```java
orders.save(order);      // → DataIntegrityViolationException: Duplicate entry 'ORD-2026-0827-0001'
```

| 情況 | 該是什麼 |
|---|---|
| 訂單編號重複（`OrderNumberGenerator` 撞號） | 🔴 **500** —— 我們的取號邏輯有 bug（02 章 2.11.4） |
| Email 重複註冊 | ✅ **409** `EMAIL_ALREADY_REGISTERED` —— 呼叫端換一個 email 就好 |
| 冪等鍵重複 | ✅ **409** `IDEMPOTENCY_KEY_REUSED` |

⚠️ **「同一個 Java 例外，三種答案」**，而分辨它們的資訊在**約束名稱**裡。
04-controller 3.7.4 的 `ConstraintNameMapper` 就是為此存在的：

```java
// ConstraintNameMapper（04-controller 3.7.4）
"uk_customers_email"      → ErrorCode.EMAIL_ALREADY_REGISTERED
"uk_idempotency_key"      → ErrorCode.IDEMPOTENCY_KEY_REUSED
"uk_orders_order_number"  → ⚠️ 不對映 → fallthrough 成 500  ← ★ 刻意的
```

> 📌 **「不對映」是一個明確的決定，而不是遺漏。**
> 而它需要一行註解說出來，否則下一個人會「順手補上」——
> 然後訂單取號的 bug 就變成 409，然後客戶端重試，然後永遠重試。

**邊界 2：`OrderStatus.UNKNOWN`**

00 章 0.9.3 給 `OrderStatus` 一個 `UNKNOWN` 常數（`@JsonEnumDefaultValue`），
用途是「讀取外部系統的資料時，遇到我們不認識的狀態不要爆掉」。

**那讀到 `UNKNOWN` 之後要做什麼？**

| 場合 | 該怎麼做 |
|---|---|
| **物流 webhook 送來未知狀態** | ✅ 存下原始字串 + 記 `warn` + **不改變訂單狀態**。⚠️ 不拋例外（拋了 webhook 會一直重送） |
| **查詢時從自己的資料庫讀到 `UNKNOWN`** | 🔴 **500** —— 我們自己的資料庫不該有 `UNKNOWN`。這是 `InvariantViolationException` |
| **客戶端在查詢參數傳 `status=UNKNOWN`** | ✅ **400** `MALFORMED_REQUEST` —— 那不是一個可查詢的值 |

⚠️ **第二列是最容易被漏掉的**，因為「讀出來就用」不會有任何錯誤：

```java
// 🔴 靜默錯誤
OrderStatus status = OrderStatus.valueOf(row.getString("status"));
// ⚠️ 若 DB 存了 'DELIVERED_PARTIAL'（某次遷移留下的），valueOf 會拋 IllegalArgumentException
//    而如果 RowMapper 用了「找不到就給 UNKNOWN」的寫法，它會靜默變成 UNKNOWN
//    → 訂單在客戶端顯示成「未知狀態」，而沒有任何 log
```

**邊界 3：退款被金流商「明確拒絕」（事故 3）**

```java
RefundResult result = paymentGateway.refund(paymentId, amount);
// result.status() == RefundStatus.REJECTED, reason = "card was closed by issuer"
```

**這是三種情況裡最難的**，因為它同時滿足兩邊：

| 論點 | 支持 |
|---|---|
| 「呼叫端做不了任何事」→ 5xx | 客戶不能「換一張卡來收退款」，這筆錢只能人工匯 |
| 「不是我們的 bug」→ 4xx | 我們的程式完全正確 |
| **「有人要處理它」→ 需要告警** | 而 4xx 預設不告警 |

✅ **shop-service 的決定：422 `REFUND_REJECTED` + `SideEffectsCommitted`。**

**三個理由**：

1. **狀態碼是給呼叫端的指令**，而呼叫端（客服後台）確實有事可做：
   `extensions.manualTransferAvailable = true` → 顯示「改用人工匯款」按鈕。
2. **`SideEffectsCommitted` 補上「告警」那一半** —— 4xx 但升級成 `error` + alert（4.3.4）。
3. **它讓事故 3 的選項 ② 可以實作**：退貨單不關單，狀態設成 `REFUND_FAILED`。

```java
package example.shop.payment.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.SideEffectsCommitted;
import example.shop.common.money.Money;

import java.util.List;

/**
 * 金流商明確拒絕退款（原卡註銷、帳戶關閉）。
 *
 * <p>★★ 這是 4.4.3 邊界 3 的答案：<b>422 + SideEffectsCommitted</b>。
 *
 * <p>⚠️ 它<b>不是</b>「退款失敗，什麼都沒發生」——
 * 拋它的時候，退貨的<b>收貨</b>已經完成了（客戶的貨在我們手上）。
 * 那就是 {@code committedSideEffects()} 要說出來的事。
 */
public class RefundRejectedException extends BusinessException
        implements SideEffectsCommitted {

    private final List<String> sideEffects;

    public RefundRejectedException(String returnId, String orderNumber,
                                   Money refundAmount, String gatewayReason,
                                   boolean manualTransferAvailable) {
        super(ErrorCode.REFUND_REJECTED,
              "Gateway rejected refund of %s for return %s: %s"
                      .formatted(refundAmount.toPlainString(), returnId, gatewayReason),
              null,
              ext("returnId", returnId,
                  "orderNumber", orderNumber,
                  "refundAmount", refundAmount.toPlainString(),
                  "currency", refundAmount.currency().getCurrencyCode(),
                  // ★ 讓前端能引導到人工匯款（00 章 0.12 ⑮ 的理由欄）
                  "manualTransferAvailable", manualTransferAvailable),
              // ⚠️ gatewayReason 刻意【不】進 userMessage 的參數 ——
              //    它是英文的、來自第三方、且可能含卡號片段（4.5.5）
              new Object[]{refundAmount.toPlainString()},
              List.of());

        this.sideEffects = List.of(
                "退貨商品已完成收貨（returnId=" + returnId + "）",
                "退款金額 " + refundAmount.toPlainString() + " 尚未匯出");
    }

    @Override
    public List<String> committedSideEffects() { return sideEffects; }
}
```

⚠️ **注意 `gatewayReason` 沒有進 `extensions`。** 那是刻意的：

| 為什麼不放 | 說明 |
|---|---|
| 它會進 `Problem` JSON → 進前端 → 進 Sentry | 而它可能含卡號末四碼或持卡人姓名 |
| 它是**第三方的字串**，格式不受我們控制 | 今天是 `"card was closed by issuer"`，明天可能是一段 JSON |
| 它對呼叫端沒有用 | 客服能做的事是「人工匯款」，不是「解讀金流商的英文」 |

✅ **它該去的地方是 `detail`**（給開發者，而 `detail` 在 5xx 才被遮蔽，4xx 會原樣輸出）
**加上一條結構化的 log**：

```java
log.error("退款被拒 returnId={} gatewayReason={} amount={}",
          returnId, gatewayReason, refundAmount.toPlainString());
```

⚠️⚠️ **等一下 —— `detail` 在 4xx 會原樣輸出給客戶端**，
所以「放 `detail`」與「不放 `extensions`」在**洩漏**這件事上是一樣的。
👉 **修正**：`gatewayReason` **兩個都不放**，只進 log。

```java
        super(ErrorCode.REFUND_REJECTED,
              // ★ 修正：detail 不含 gatewayReason（它一樣會回給客戶端）
              "Gateway rejected refund of %s for return %s."
                      .formatted(refundAmount.toPlainString(), returnId),
              ...
```

> 📌 **這個自我修正值得留在課程裡**，因為它是一個很常見的推理錯誤：
> **「不要放進 `extensions`」與「不要回給客戶端」是兩件事。**
> `Problem` 的 `detail`、`userMessage`、`errors[]`、`extensions`
> **四個欄位全部都會回給客戶端**（4xx 時）。
> 「只有 `extensions` 危險」是錯的直覺，它來自「`extensions` 是我們自己加的欄位」這個印象。

**邊界 4：外部 API 逾時（結果未知）**

```java
try {
    ChargeResult result = paymentGateway.charge(...);
} catch (SocketTimeoutException e) {
    // ⚠️ 錢可能扣了，也可能沒扣 —— 我們不知道
}
```

**這是四個邊界裡唯一「狀態碼不重要」的**：

| 候選 | 問題 |
|---|---|
| 500 | 🔴 客戶端會重試 → **可能重複扣款** |
| 502 | 🔴 同上 |
| **504 `PAYMENT_OUTCOME_UNKNOWN` + `Retry.CHECK_STATUS`** ✅ | 它明確告訴客戶端：**「不要重試，去查狀態」** |

**`Retry.CHECK_STATUS` 這個值就是為這一個情況而存在的**（04-controller 3.4.2）。
而它只有在客戶端**真的有一個「查狀態」的端點**時才有意義 ——
**否則它只是一個好看的欄位。** 06 章會建那個端點。

### 4.4.4 `InvariantViolationException`：修正 03 章的第一件事 ★★

03 章 3.14 的預告列了兩件要修的事，第一件是：

> `IllegalStateException`（3.7.2 的 mapper 斷言）**沒有 traceId** ——
> 04-controller 3.7 的 catch-all 會給它一個，但它不會進 alert，
> 而 3.7.2 說「這件事應該吵醒某個人」。**那需要一個專門的例外型別。**

⚠️ **先釐清一個事實**：`IllegalStateException` **會**拿到 traceId
（`ProblemFactory.build()` 一律從 MDC 讀，04-controller 3.6.3）。
**所以「沒有 traceId」這個說法是錯的。** 真正缺的是**兩件別的事**：

| 缺什麼 | 後果 |
|---|---|
| **告警** | 它與「某個 stream 被重複消費」在監控上長得一樣（4.4.2 代價 1） |
| **結構化資料** | 無法查詢「這週有哪些訂單違反了 I8」（4.4.2 代價 2） |

```java
package example.shop.common.error;

/**
 * ★★ 不變量被違反 —— 這是<b>我們的 bug</b>，不是使用者的錯。
 *
 * <h3>它與 BusinessException 的關係</h3>
 * <p><b>它刻意不繼承 {@link BusinessException}。</b>
 * 理由見 4.4.1 的判準：沒有任何「呼叫端能做的事」能讓它成功。
 * 於是 04-controller 3.7.2 的 catch-all 會把它變成 500，那是對的。
 *
 * <h3>那它為什麼需要自己的型別</h3>
 * <p>因為 {@code IllegalStateException} 少了兩樣東西（4.4.4）：
 * <ol>
 *   <li><b>告警</b> —— advice 有一個專門的 handler 給它，記 {@code error}
 *       並帶上 {@code alert=true} 這個 MDC 欄位。</li>
 *   <li><b>結構化資料</b> —— {@code invariantId} 與 {@code aggregateId}
 *       是欄位而不是字串的一部分，於是
 *       「列出這週所有 I8 違反」變成一個可執行的查詢。</li>
 * </ol>
 *
 * <h3>⚠️ 它不帶 ErrorCode</h3>
 * <p>刻意的。它一律走 {@code INTERNAL_ERROR}，
 * 而那讓 4.12.1 的守門測試（「每個業務例外都有 code」）
 * <b>不需要為它開例外</b> —— 因為它不是業務例外。
 */
public class InvariantViolationException extends IllegalStateException {

    private final String invariantId;      // "I8"
    private final String aggregateType;    // "Order"
    private final String aggregateId;      // "ORD-2026-0827-0001"

    public InvariantViolationException(String invariantId, String aggregateType,
                                       String aggregateId, String description) {
        // ★ 訊息一律英文、給開發者。它【不會】被回給客戶端
        //   （5xx 的 detail 被 ProblemFactory 換成固定文字，04-controller 3.6.3）
        super("%s violated on %s[%s]: %s"
                      .formatted(invariantId, aggregateType, aggregateId, description));
        this.invariantId = invariantId;
        this.aggregateType = aggregateType;
        this.aggregateId = aggregateId;
    }

    public String invariantId()   { return invariantId; }
    public String aggregateType() { return aggregateType; }
    public String aggregateId()   { return aggregateId; }
}
```

⚠️⚠️ **它繼承 `IllegalStateException` 而不是 `RuntimeException`，這是刻意的**：

| 理由 | 說明 |
|---|---|
| **既有的 `catch (IllegalStateException e)` 還會接到它** | 00～03 章有若干處，換型別不會靜默改變行為 |
| 語意正確 | 它真的是「物件處於不該有的狀態」 |
| 🔴 **代價** | 4.4.2 代價 1（與 JDK 的 `IllegalStateException` 混在一起）**只解決了一半** —— 我們的**新**程式碼會用專門型別，但 JDK 的還是 `IllegalStateException` |

**而那一半是可以接受的**，因為監控上要區分的是
「**我們的**不變量違反」與「其他」，而前者現在有專門型別了。

#### `Order.assertInvariants()` 的改寫

```java
// ── 修正前（00 章 0.9.2 原文）─────────────────────────────────
private void assertInvariants() {
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
    // …其餘 9 條
}

// ── 修正後 ─────────────────────────────────────────────────
private void assertInvariants() {
    if (status.isPaid() && payments.stream().noneMatch(Payment::isSucceeded)) {
        throw violated("I7", "status=%s but no succeeded payment".formatted(status));
    }
    if (refundedAmount().compareTo(paidAmount()) > 0) {
        throw violated("I8", "refunded %s > paid %s"
                .formatted(refundedAmount().toPlainString(), paidAmount().toPlainString()));
    }
    // …其餘 9 條
}

/** ★ 一個小工廠，讓 11 條不變量各自只有一行。 */
private InvariantViolationException violated(String invariantId, String description) {
    return new InvariantViolationException(invariantId, "Order", id, description);
}
```

⚠️⚠️ **這個改寫順手改掉了一件事，而它需要被明說：訊息從中文變成英文。**

**理由不是「英文比較專業」**，而是兩個具體的事實：

| 事實 | 後果 |
|---|---|
| **它從來不會給使用者看到** | 5xx 的 `detail` 被 `ProblemFactory` 換成固定文字（04-controller 3.6.3）。所以它的唯一讀者是**開發者與 log 系統** |
| ⚠️ **中文在 log 上會遇到編碼問題** | 容器的 `LANG` 沒設好 → log 檔裡是 `????`；而**那正是你最需要讀它的時候**（半夜的 500 告警） |

⚠️ **而它也不是純粹的改進 —— 有一個代價**：
00 章那些中文訊息**對讀課程的人更好懂**。
👉 **課程的處置**：`InvariantViolationException` 的 `description` 用英文，
而**不變量的中文說明留在 `Order` 的 javadoc 與 00 章 0.8.2 的表格裡**（它們本來就在那裡）。

⚠️ **注意 `Money` 的比較方式沒有改**：

```java
refundedAmount().compareTo(paidAmount()) > 0     // ★ 00 章原本就是這樣寫的
```

`Money` **沒有** `isGreaterThan()`（00 章 0.9.1 只給了
`isGreaterThanOrEqual`、`isLessThan` 與 `compareTo`），
而 00 章的不變量檢查**正確地用了 `compareTo`**。

> 📌 **這一段刻意留著，因為它是一個容易犯的複查錯誤**：
> 讀到 `compareTo(x) > 0` 時很容易「順手改成」更好讀的 `isGreaterThan(x)` ——
> 而那個方法不存在。
> **「這樣寫比較好讀」與「這樣寫得出來」是兩個問題。**

#### advice 端的專門 handler

```java
// 加到 ApiExceptionHandler（04-controller 3.7.2）
//
// ⚠️ 它必須放在「catch-all 的 handler」之前才會被選到 —— 而 Spring 的規則是
//    「最具體的例外型別優先」（04-controller 3.3.3），
//    所以順序不重要，型別具體度才重要。這一條寫下來是因為很多人記錯。

/**
 * ★★ 不變量被違反 —— 500 + 告警 + 結構化欄位。
 *
 * <p>它與 catch-all 的差別只有三件事，但那三件事就是它存在的理由。
 */
@ExceptionHandler(InvariantViolationException.class)
public ResponseEntity<Problem> handleInvariantViolation(
        InvariantViolationException ex, HttpServletRequest request) {

    // ① 結構化的 MDC 欄位 → 可查詢（「列出這週所有 I8 違反」）
    MDC.put("invariantId", ex.invariantId());
    MDC.put("aggregateType", ex.aggregateType());
    MDC.put("aggregateId", ex.aggregateId());
    // ② alert=true → 這個標籤讓告警規則抓得到它（而不是靠 5xx 率）
    MDC.put("alert", "true");
    try {
        log.error("不變量違反：{}", ex.getMessage(), ex);
    } finally {
        // ⚠️ 一定要清掉 —— MDC 是 ThreadLocal，而執行緒會被重用（02 章 2.2.4）
        MDC.remove("invariantId");
        MDC.remove("aggregateType");
        MDC.remove("aggregateId");
        MDC.remove("alert");
    }

    // ③ 回應本身與 catch-all 完全相同：500 + INTERNAL_ERROR + 固定 detail
    //    ★ 刻意的 —— 不變量的名稱（I8）不可以洩漏給客戶端
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(problems.from(ErrorCode.INTERNAL_ERROR,
                                ProblemFactory.instanceOf(request),
                                "invariant violation"));
}
```

⚠️ **那個 `try/finally` 值得注意。**
`MDC.put` 之後如果 `log.error` 拋例外（例如某個 appender 壞了），
**MDC 的四個 key 會留在這個執行緒上** ——
而 Tomcat 的執行緒會服務下一個請求，
於是**下一個請求的每一條 log 都會帶著 `alert=true`**。

> 📌 **這是 02 章 2.2.4「交易、連線、ThreadLocal」的同一個陷阱換一個場景。**
> 一般規則：**`ThreadLocal` 的清理一律放 `finally`，即使中間的程式碼「看起來不會拋例外」。**

### 4.4.5 「Domain 的最後一道防線」其實有兩種 ★★

事故 2（備註太長）與 03 章 3.7.2（mapper 斷言）**都是「Domain 的最後一道防線」**，
而它們的答案**完全相反**：

| | 事故 2：`note.length() > 2000` | 3.7.2：mapper 的欄位斷言 |
|---|---|---|
| 誰能修好它 | ✅ **呼叫端**（縮短備註） | 🔴 **我們**（mapper 漏映射） |
| 該是什麼 | `NoteTooLongException` **extends BusinessException** | `InvariantViolationException` |
| 狀態碼 | **422** | **500** |
| 告警 | ❌ | ✅ |

⚠️ **這個區分是本節的核心，而它很容易被弄反。**
兩者都是「Web 層應該擋掉但沒擋到」，**但那不是判準** ——
判準是 4.4.1 的那個問句：**誰能修好它。**

```java
package example.shop.order.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;

/**
 * 備註超過長度上限。
 *
 * <h3>★★ 為什麼它是 BusinessException 而不是 InvariantViolationException</h3>
 * <p>因為<b>呼叫端可以做點什麼</b>（縮短備註）——
 * 4.4.1 的判準。
 *
 * <p>⚠️ 對照 3.7.2 的 mapper 斷言：那個也是「最後一道防線」，
 * 但呼叫端對它<b>無能為力</b>（是我們的 mapper 漏了欄位），
 * 所以那個是 {@code InvariantViolationException}（500 + 告警）。
 *
 * <h3>它為什麼需要存在（03 章 3.10.3 ⑦）</h3>
 * <p>Web 層的 {@code @TextLength} 已經擋了 99.9% 的情況。
 * 而剩下的 0.1% 是「第二個入口」——排程、CLI、資料遷移腳本。
 * <b>沒有這個例外，那 0.1% 會變成 500</b>（事故 2）。
 */
public class NoteTooLongException extends BusinessException implements DomainException {

    public NoteTooLongException(String orderId, String fieldName,
                                int actualLength, int maxLength) {
        super(ErrorCode.ORDER_NOTE_TOO_LONG,
              "Field %s of order %s is %d characters; max is %d."
                      .formatted(fieldName, orderId, actualLength, maxLength),
              null,
              ext("orderId", orderId,
                  "field", fieldName,
                  "actualLength", actualLength,
                  "maxLength", maxLength),
              // {0} = 上限，{1} = 實際長度
              new Object[]{maxLength, actualLength},
              // ⚠️ 刻意【沒有】errors[] —— Domain 不知道這個字串在請求 JSON 裡的路徑
              //    （4.2.6 最後那張表）
              java.util.List.of());
    }
}
```

```properties
error.ORDER_NOTE_TOO_LONG.title=備註過長
error.ORDER_NOTE_TOO_LONG.user=備註最多 {0} 個字，目前是 {1} 個字，請縮短後再送出。
```

**於是事故 2 的客服看到的是**：

```
備註最多 2000 個字，目前是 3417 個字，請縮短後再送出。
```

⚠️ **而 `Order` 那一端要改的是一行**：

```java
// ── 修正前（03 章 3.10.3 ⑧ 的 changeInternalNote）────────────
if (note != null && note.length() > MAX_NOTE_LENGTH) {
    throw new IllegalStateException("note too long: " + note.length());
}

// ── 修正後 ─────────────────────────────────────────────────
if (note != null && note.length() > MAX_NOTE_LENGTH) {
    throw new NoteTooLongException(id, "internalNote", note.length(), MAX_NOTE_LENGTH);
}
```

⚠️ **同一個方法的第一個檢查則相反**：

```java
if (!actor.isInternal()) {
    throw new IllegalStateException("only internal actors can edit internal note");
}
```

**這一個該保持 500**，理由：

> **Application 層已經檢查過了**（03 章 3.6.6 ③ 的 `touchesInternalFields()`）。
> 如果它還被觸發，代表**有一條路徑繞過了 Application 層的檢查** ——
> 那是我們的架構問題，不是使用者的錯。

✅ **改成 `InvariantViolationException`**（讓它進告警）：

```java
if (!actor.isInternal()) {
    throw new InvariantViolationException("I-AUTH", "Order", id,
            "non-internal actor %s reached changeInternalNote".formatted(actor.type()));
}
```

> 📌 **同一個方法裡的兩個檢查，一個是 422 一個是 500。**
> 這不是不一致 —— 這**正是** 4.4.1 的判準在運作：
> **「備註太長」呼叫端能修，「權限繞過」呼叫端不能修（也不該能）。**

---

## 4.5 例外要帶哪些資料 ★★

### 4.5.1 `orderId` 夠嗎：五個消費者各要什麼

**一個例外被拋出之後，有五個地方會消費它。** 它們要的東西不一樣：

| # | 消費者 | 要什麼 | 從 `Problem` 的哪個欄位拿 |
|---|---|---|---|
| 1 | **終端使用者**（客戶／客服） | 一句「發生什麼事 + 我該做什麼」 | `userMessage` |
| 2 | **前端程式** | 一個可以 `switch` 的字串 + 渲染 UI 需要的資料 | `code` + `extensions` |
| 3 | **開發者**（除錯時） | 精確的技術描述 + 涉及的 id | `detail` + `traceId` |
| 4 | **監控與告警** | code、狀態碼、端點 —— **可聚合的低基數標籤** | `code` / `status` / `instance` |
| 5 | ⚠️ **運營與客服**（事後查） | 「哪張訂單、什麼時候、誰做的」 | ⚠️ **不是從 `Problem` 拿** —— 從 log 拿 |

**用「庫存不足」走一遍這五個消費者**：

```jsonc
{
  "code": "INSUFFICIENT_STOCK",                    // ← ② 前端 switch
  "status": 409,                                    // ← ④ 監控
  "detail": "Product P-1001 has 3 units available but 5 were requested in items[2].",
                                                    // ← ③ 開發者
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。",
                                                    // ← ① 使用者
  "productId": "P-1001",                            // ← ② 前端要標出是哪一筆
  "productName": "無線降噪耳機 Pro",
  "requested": 5,
  "available": 3,                                   // ← ② 前端要把數量欄位的 max 設成 3
  "restockEstimatedAt": "2026-08-22",               // ← ② 前端要顯示「預計 8/22 到貨」
  "errors": [ { "field": "items[2].quantity", ... } ],  // ← ② 前端要標紅
  "traceId": "4f2c8a1e9b7d3f60"                     // ← ③ 開發者
}
```

⚠️ **「`orderId` 夠嗎」的答案是：對消費者 3 夠，對消費者 2 遠遠不夠。**

**判準**：

> **例外要帶的資料 = 「客戶端渲染這個錯誤所需要的一切」。**
>
> ⚠️ **反面測試**：如果前端拿到這個 `Problem` 之後**還要再打一次 API** 才能顯示錯誤，
> 那就是例外帶的資料不夠。

**用這個反面測試檢查 shop-service 的三個例外**：

| 例外 | 前端要顯示什麼 | 資料夠嗎 |
|---|---|---|
| `InsufficientStockException` | 「耳機僅剩 3 件」+ 把 max 設成 3 | ✅ 夠 |
| `OrderNotCancellableException` | 「已出貨，無法取消」+ 一顆「申請退貨」按鈕 | ✅ 夠（`alternativeAction` 帶了 href 與 method） |
| `CouponMinAmountNotMetException` | 「還差 NT$320 才能用這張券」 | ⚠️ **看它帶什麼**，見下 |

```java
// 🔴 第一版：只帶「門檻」
ext("couponCode", code, "minAmount", "1500")
// → 前端要顯示「還差多少」，必須自己算 1500 - subtotal
// → 而 subtotal 在錯誤回應裡沒有 → 前端要用「送出前的購物車金額」
// → ⚠️ 而那個金額可能已經變了（另一個 tab 改了購物車）

// ✅ 第二版：把「差多少」算好
ext("couponCode", code,
    "minAmount", "1500",
    "currentSubtotal", "1180",
    "shortfall", "320")           // ★ 前端直接顯示，不需要自己算
```

> 📌 **一般規則**：
> **「需要客戶端做減法」的錯誤，把減法的結果一起給。**
> 理由不是「省前端的力氣」，而是：
> **我們的減數與被減數是同一個交易裡讀出來的，前端的不是。**

### 4.5.2 為什麼「訊息」不該在例外裡 ★

**最常見的第一版寫法**：

```java
// 🔴
throw new InsufficientStockException("「" + product.name() + "」僅剩 " + available + " 件");
```

**它有六個具體問題**：

| # | 問題 | 具體後果 |
|---|---|---|
| 1 | **不能 i18n** | 日本站的客戶看到中文 |
| 2 | **改文案要改 Java 並重新部署** | 而文案是**行銷部門**在改 |
| 3 | **同一個例外在不同端點需要不同語氣** | 客戶端要「請調整數量」，客服後台要「客戶購買數超過庫存」 |
| 4 | **訊息裡的資料無法被前端單獨使用** | 前端拿到「僅剩 3 件」這串字，**無法**把數量欄位的 max 設成 3 |
| 5 | **它會被寫進 log** | 中文 + 商品名進 log → 4.4.4 那個編碼問題，而且商品名可能是 PII（客製商品含姓名） |
| 6 | ⚠️ **測試會斷言字串** | `assertThat(ex.getMessage()).isEqualTo("「耳機」僅剩 3 件")` → 改文案 = 測試紅燈 |

**第 6 點是最容易被低估的。** 真實的表現：

```
行銷：把「僅剩」改成「剩餘」比較不會給客戶壓力
工程：好，改一個字
CI：  17 個測試紅燈
工程：（把 17 個測試的期望字串也改掉）
一個月後：又要改文案 → 又是 17 個測試
```

✅ **正確的分工**（04-controller 3.6.3 已經建好了，這裡把「為什麼」說完）：

```
例外持有                          properties 持有
─────────────────────            ─────────────────────
ErrorCode                        error.INSUFFICIENT_STOCK.title=庫存不足
資料（productName, available）    error.INSUFFICIENT_STOCK.user=「{0}」僅剩 {1} 件，請調整數量後再結帳。
userMessageArgs = {name, 3}       ↑ 行銷可以改這一行，不動 Java

detail（英文，給開發者）
"Product P-1001 has 3 units available but 5 were requested."
↑ 這一個【可以】寫死在 Java 裡，因為它的讀者是開發者
```

⚠️ **而測試該斷言什麼**：

```java
// 🔴 斷言使用者訊息
assertThat(problem.userMessage()).isEqualTo("「耳機」僅剩 3 件，請調整數量後再結帳。");

// ✅ 斷言「參數對不對」——文案改了不會紅燈
assertThat(ex.userMessageArgs()).containsExactly("耳機", 3);
assertThat(ex.errorCode()).isEqualTo(ErrorCode.INSUFFICIENT_STOCK);

// ✅ 而「訊息本身」用一個【集中的】測試守（4.12.2）：
//    每個 code 的 user 訊息都存在、參數個數與拋出點一致
```

> 📌 **一般規則**：
> **測試斷言「不變的東西」（code、參數），不斷言「會變的東西」（文案）。**
> 而讓兩者分開的方式就是**不要把文案放進例外**。

### 4.5.3 `extensions` 的七條規則

`extensions` 會被平鋪到 `Problem` JSON 的最上層（RFC 9457），
**於是它是對外契約的一部分** —— 而「對外契約」意味著它有規則。

| # | 規則 | 為什麼 |
|---|---|---|
| 1 | **只放 JSON 原生型別**（`String` / 數字 / `boolean` / `List` / `Map`） | ⚠️ 放 `Money` 會變成 `{"amount": 1500, "currency": {"currencyCode": "TWD", ...}}` —— `Currency` 的序列化不受我們控制 |
| 2 | **金額一律 `String`** | 03 章 3.8.4 那條掃描測試的同一個理由：JS 的 `number` 會失精度 |
| 3 | **時間一律 ISO-8601 字串或 `Instant` / `LocalDate`** | Jackson 的 `WRITE_DATES_AS_TIMESTAMPS` 若被改，數字時間戳會突然出現 |
| 4 | 🔴 **絕不放 Entity 或聚合** | 4.5.4 |
| 5 | 🔴 **絕不放第三方回傳的原始字串** | 4.4.3 邊界 3 那個 `gatewayReason` |
| 6 | **欄位名用 camelCase，與 API 的其他地方一致** | `restockEstimatedAt` 不是 `restock_estimated_at` |
| 7 | ⚠️ **`null` 值一律省略，不要輸出 `"field": null`** | `BusinessException.ext()` 已經做了這件事（04-controller 3.5.2） |

⚠️ **規則 1 值得看一個具體的失敗**：

```java
// 🔴 放 Money 物件
ext("refundAmount", refundAmount)
```

**輸出**：

```jsonc
{
  "refundAmount": {
    "amount": 1500.00,                       // ← 🔴 規則 2 也違反了（數字）
    "currency": "TWD"                        // ← ⚠️ 這一行取決於有沒有註冊 CurrencySerializer
  }
}
```

**而它「看起來是對的」**，所以不會有人發現 —— 直到：

| 什麼時候會爆 | 具體 |
|---|---|
| 前端寫 `problem.refundAmount` 想顯示金額 | 拿到一個物件 → `[object Object]` |
| 某次升級 Jackson | `Currency` 的預設序列化從 `"TWD"` 變成 `{"currencyCode": "TWD", "defaultFractionDigits": 2, ...}` |
| 04-controller 6.5.7 註冊的 `MoneySerializer` **只註冊在 web 層的 ObjectMapper** | 而 `Problem` 走的是同一個 mapper，**所以其實會生效** —— ⚠️ 但那是運氣，不是設計 |

✅ **正確寫法（兩個欄位）**：

```java
ext("refundAmount", refundAmount.toPlainString(),      // "1500.00"
    "currency", refundAmount.currency().getCurrencyCode())   // "TWD"
```

⚠️ **而「兩個欄位」是刻意的，不是偷懶。**
`Money` 在 API 上的表示方式在 03 章 3.8.4 已經定案：
**金額與幣別是兩個 `String` 欄位**，
於是 `extensions` 只是遵循同一個慣例。

**一條守門測試**（加進 03 章 3.8.4 那組掃描測試）：

```java
/**
 * ★★ 每個 BusinessException 的 extensions 只含 JSON 原生型別。
 *
 * <p>做法：把每個例外實例化一次（用 4.12 的 fixture），
 * 然後檢查 extensions 的每一個 value。
 *
 * <p>⚠️ 這條測試需要「能實例化每一個例外」，而那需要每個例外都有一組範例參數 ——
 * 那就是 4.12.1 的 {@code ExceptionFixtures} 要做的事。
 */
@ParameterizedTest
@MethodSource("everyBusinessExceptionInstance")
void extensions只含JSON原生型別(BusinessException ex) {
    // ★ 允許的型別。刻意【不】包含 Money / Currency / Instant 以外的東西
    var allowed = java.util.List.<Class<?>>of(
            String.class, Integer.class, Long.class, Boolean.class,
            java.math.BigDecimal.class,          // ⚠️ 允許但規則 2 會另外抓（見下）
            java.time.Instant.class, java.time.LocalDate.class,
            java.util.List.class, java.util.Map.class);

    ex.extensions().forEach((key, value) -> {
        assertThat(value).isNotNull();            // 規則 7
        boolean ok = allowed.stream().anyMatch(t -> t.isInstance(value))
                // ★ AlternativeAction 是我們自己的 record，形狀受我們控制 → 白名單
                || value instanceof example.shop.common.error.AlternativeAction;
        assertThat(ok)
                .as("%s 的 extensions[%s] 是 %s —— 規則 1 只允許 JSON 原生型別",
                    ex.getClass().getSimpleName(), key, value.getClass().getName())
                .isTrue();
    });
}

/** ★ 規則 2：欄位名含 amount / price / total 的一律是 String。 */
@ParameterizedTest
@MethodSource("everyBusinessExceptionInstance")
void 金額欄位一律是String(BusinessException ex) {
    var moneyish = java.util.regex.Pattern.compile(
            "(?i)(amount|price|total|subtotal|shortfall|fee|discount)");
    ex.extensions().forEach((key, value) -> {
        if (moneyish.matcher(key).find()) {
            assertThat(value)
                    .as("extensions[%s] 是金額 → 必須是 String（規則 2）", key)
                    .isInstanceOf(String.class);
        }
    });
}
```

⚠️ **注意 `BigDecimal` 在第一條測試裡是「允許」的，卻在第二條被抓。**
那是刻意的分工：

| 測試 | 抓什麼 |
|---|---|
| 第一條 | **不可序列化的物件**（`Money`、`Order`、`Currency`） |
| 第二條 | **可序列化但會失精度的**（`BigDecimal`、`double`） |

**如果把 `BigDecimal` 從第一條的白名單拿掉**，
那第二條就沒有存在的意義了 —— 但那會擋掉「數量」「百分比」這類**該是數字**的欄位。

### 4.5.4 一個反例：把整個 `Order` 塞進 `extensions`

**這是一個真實的第一版**，而它同時違反了四條規則：

```java
// 🔴🔴🔴
public OrderNotCancellableException(Order order) {
    super(ErrorCode.ORDER_NOT_CANCELLABLE,
          "Order is not cancellable",
          null,
          ext("order", order),          // ← 🔴 整個聚合
          new Object[0],
          List.of());
}
```

**它的動機是可以理解的**：「反正前端可能需要訂單的任何欄位，全部給它最保險」。

**而它的後果有五層**：

| 層 | 後果 |
|---|---|
| 1 | **洩漏** —— `Order` 有 `internalNote`、`Cancellation.staffNote`（03 章 3.7.3）→ **客戶看到客服的評語**（03 章事故 1 的完全重現） |
| 2 | **`LazyInitializationException`** —— 序列化時碰到 `payments` 這個 lazy 集合，而**交易已經結束了**（03 章 3.9.1）。⚠️ 而它發生在 **advice 裡**，於是 04-controller 3.3.6 那個「advice 拋例外」的路徑被觸發 → **回應變成 HTML** |
| 3 | **無限遞迴** —— 若 `Order` ↔ `OrderLine` 是雙向關聯，Jackson 會 stack overflow |
| 4 | **契約失控** —— `Order` 加一個欄位 = 錯誤回應多一個欄位，而**沒有任何測試會發現** |
| 5 | **回應大小** —— 一張 40 筆明細的訂單 → 錯誤回應 18 KB（而正常的 `Problem` 是 400 bytes） |

⚠️⚠️ **第 2 層是最惡毒的**，因為它讓錯誤處理**自己壞掉**：

```
Service 拋 OrderNotCancellableException（409）
  → advice 接到它
  → 組 Problem，序列化 extensions["order"]
  → 碰到 order.payments()（lazy）
  → LazyInitializationException 在 advice 裡拋出
  → ExceptionHandlerExceptionResolver catch 它，log 一條 WARN，回 null
  → 下一個 resolver → 全部失敗 → 重新拋出 → /error
  → 客戶端收到【500 + HTML】
```

**客戶端看到的是 500 而不是 409**（事故 1 的觸發條件），
而 log 裡只有一條不起眼的 `WARN`。

✅ **正確版本**（04-controller 3.5.3 例子 2 已經是對的，這裡看它為什麼）：

```java
ext("orderNumber", orderNumber,                    // ★ 只帶前端要顯示的
    "currentStatus", current.name(),
    "currentStatusLabel", current.label(),
    "cancellableStatuses", cancellable.stream().map(Enum::name).sorted().toList(),
    "alternativeAction", buildAlternative(orderId, current, returnableUntil))
```

**五個欄位，每一個都對應「前端要渲染的一個東西」**：

| 欄位 | 前端用它做什麼 |
|---|---|
| `orderNumber` | 顯示「訂單 ORD-2026-0827-0001 無法取消」 |
| `currentStatusLabel` | 顯示「目前狀態：已出貨」 |
| `cancellableStatuses` | ⚠️ **除錯用**（前端通常不顯示）—— 見下 |
| `alternativeAction` | 渲染一顆「申請退貨」按鈕 |

⚠️ **`cancellableStatuses` 違反了 4.5.1 的判準**（「客戶端渲染所需要的一切」）——
前端不會顯示「可取消的狀態有 PENDING_PAYMENT、PAID、PARTIALLY_SHIPPED」。

**它該留下嗎？** 兩個論點：

| 留下 | 拿掉 |
|---|---|
| 除錯時很有用（「為什麼這張不能取消」一眼看出） | 它是**內部規則**的洩漏 —— 競爭對手能看出我們的狀態機 |
| 它已經在 API 文件裡了（04-controller 07 章的契約測試會斷言它） | 拿掉 = 破壞性變更 |

✅ **決定：留下，但搬到 `detail`。**

```java
// detail 本來就是「給開發者」的，而 4xx 的 detail 會回給客戶端 ——
// ⚠️ 所以「搬到 detail」並沒有解決洩漏問題（4.4.3 邊界 3 的同一個教訓）
```

⚠️⚠️ **上面那個決定是錯的，而它錯得跟 4.4.3 邊界 3 一模一樣。**

✅ **真正的決定：留下，並接受它。** 理由：

> **「狀態機被看到」不是一個真的風險。**
> 那三個狀態名稱在 API 文件裡（`GET /orders/{id}` 的 `allowedActions`）本來就公開了 ——
> 而**公開它是刻意的設計**（03-rest-api 3.10.2：讓客戶端知道能做什麼）。
>
> 📌 **「洩漏」要看洩漏的是什麼**：
> `staffNote` 是**別人的資料** → 真的洩漏。
> `cancellableStatuses` 是**我們的規則** → 而規則本來就該對客戶端明確。

### 4.5.5 `Problem` 的四個文字欄位，各給誰看

⚠️ **這一節存在的原因是 4.4.3 與 4.5.4 各犯了同一個錯一次。**
把它一次講清楚：

| 欄位 | 語言 | 讀者 | 4xx 時 | 5xx 時 | 可以放內部資訊嗎 |
|---|---|---|---|---|---|
| `detail` | **英文** | 開發者 | ⚠️ **原樣回給客戶端** | ✅ 換成固定文字 | 🔴 **不可以** |
| `userMessage` | i18n | 終端使用者 | 回 | 回（+ 短 traceId） | 🔴 不可以 |
| `errors[].message` | 中文（i18n） | 終端使用者 | 回 | 通常沒有 | 🔴 不可以 |
| `extensions` | — | 前端程式 | 回 | ⚠️ **也會回** | 🔴 不可以 |

> 📌 **一句話**：
> **`Problem` 的每一個欄位都會出去。**
> **唯一不會出去的是 log。**

**於是「內部資訊該放哪裡」只有一個答案**：

```java
// ✅ 唯一安全的位置
log.warn("退款被拒 returnId={} gatewayReason={} gatewayCode={}",
         returnId, gatewayReason, gatewayCode);
throw new RefundRejectedException(returnId, orderNumber, amount, manualTransferAvailable);
//                                                              ↑ gatewayReason 不進例外
```

⚠️ **注意這個寫法的一個副作用**：`log` 與 `throw` 分開了，
而「先 log 再 throw」通常是壞味道（會產生兩條記錄）。

**這裡是例外，理由**：

| 通常為什麼壞 | 這裡為什麼可以 |
|---|---|
| 同一件事被記兩次（log + advice 的 log） | ✅ 記的**不是同一件事**：這一條有 `gatewayReason`，advice 那一條沒有 |
| log 在低層，缺少上下文 | ✅ 這裡在 Service 層，上下文完整 |

**而它有一條可以自動檢查的規則**：

```java
// ArchUnit：拋 BusinessException 之前的 log 一律 warn 或 error，不可以是 info
// ⚠️ 這條規則寫不出來（ArchUnit 看不到「之前」這個時序關係）
//    → 改成 code review 的檢核項，並記在 4.16 的驗收清單裡
```

> 📌 **這是一個誠實的缺口**：
> **不是每一條規則都能自動化。**
> 而把「不能自動化」明確寫下來，比假裝它被守住了好。

### 4.5.6 `cause` 什麼時候該帶

`BusinessException` 的建構子有一個 `Throwable cause`（04-controller 3.5.2），
**而 26 個例外裡只有 3 個會用到它。**

| 情況 | 帶 cause 嗎 | 理由 |
|---|---|---|
| 業務規則不成立（庫存不足、狀態不對） | 🔴 **不帶** | 沒有「底層例外」—— 是我們主動判斷的 |
| **包裝第三方例外**（`PaymentGatewayException` → `RefundRejectedException`） | ✅ **帶** | 除錯時要看到金流商的 stack trace |
| **包裝資料庫例外**（`DataIntegrityViolationException` → `EmailAlreadyRegisteredException`） | ✅ **帶** | 約束名稱在 cause 的訊息裡 |
| **包裝 checked exception**（`IOException` → `ExportFailedException`） | ✅ **帶** | 02 章 2.6.4 政策 ② |

⚠️ **而「帶 cause」與 `writableStackTrace = false` 有一個互動，值得說清楚。**

`BusinessException` 的建構子（04-controller 3.5.2）：

```java
super(detail, cause, /*enableSuppression*/ true, /*writableStackTrace*/ false);
```

| 什麼被關掉 | 什麼還在 |
|---|---|
| ⚠️ **`BusinessException` 自己的 stack trace**（空的） | ✅ **`cause` 的 stack trace 完整保留** |

**於是 log 出來是這樣**：

```
WARN  ... - 業務例外 code=EMAIL_ALREADY_REGISTERED
example.shop.customer.EmailAlreadyRegisteredException: Email already registered.
	（沒有 stack trace —— writableStackTrace = false）
Caused by: org.springframework.dao.DuplicateKeyException: Duplicate entry 'a@b.c' for key 'uk_customers_email'
	at org.springframework.jdbc.support.SQLErrorCodeSQLExceptionTranslator.doTranslate(...)
	at ...（40 行完整的 stack trace）
```

✅ **這正是我們要的**：
「我們的例外」沒有 stack trace（省成本），
「真正的技術原因」有完整的 stack trace（可除錯）。

⚠️⚠️ **但有一個陷阱**：如果 advice 用的是「不印 stack trace」的 log 寫法：

```java
// 🔴 業務例外一律不印 stack trace
log.warn("業務例外 code={} detail={}", ex.errorCode(), ex.getMessage());
//                                                     ↑ cause 完全消失
```

**那 `cause` 就白帶了。** ✅ 正確的分支：

```java
// ★ 有 cause 的業務例外要印出來（那是「技術原因」，不是「業務規則」）
if (ex.getCause() != null) {
    log.warn("業務例外（有底層原因）code={} detail={}",
             ex.errorCode(), ex.getMessage(), ex);      // ← 第三個參數 = 印 stack trace
} else {
    log.warn("業務例外 code={} detail={}", ex.errorCode(), ex.getMessage());
}
```

> 📌 **一般規則**：
> **`writableStackTrace = false` 省的是「我們自己判斷出來的失敗」的成本，
> 不是「底層技術失敗」的成本。**
> 而區分兩者的訊號就是 `getCause() != null`。

---

### 4.5.7 32 個業務例外的完整定義 ★★

00 章 0.12 ⑯ 說：

> 其餘 **26** 個新例外類別的完整定義在 04 章 ——
> 那一章的工作正是「把它們排成一棵樹，並與這 93 個 code 一一對應」。

⚠️ **實際寫出來是 32 個**，而那 6 個差額有明確的來源：

| 差額 | 來源 |
|---|---|
| +4 | 03 章 3.10.3 ⑦ 的四個新 code（`EmptyPatchException` 等）—— 00 章寫下「26」時它們還不存在 |
| +1 | 本章 4.2.4 的 `InvoiceAlreadyIssuedException` |
| +1 | `OrderNotCancellableException` 被**重新定義**（換套件 + 4.7 的兩狀態碼），所以它算在本章而不是 04-controller |

**加上 2 個抽象家族基底**（`OrderStateException`、`CouponException`）
與 **1 個非業務例外**（`InvariantViolationException`），
本節總共產出 **35 個類別**。

> ⚠️⚠️ **前向指標：這個「32」也是錯的。**
> 4.6 與 4.7 還會再加 9 個，而**更重要的是「32」本身就數錯了** ——
> 4.12.1 讓 `ClassGraph` 掃一次，答案是 **41**。
>
> 👉 **不要記這一節的數字。** 它的價值在「32 個例外長什麼形狀」，
> 而「有幾個」這個問題**在 4.12.1 交給機器回答**
> （理由就是：**人數過三次，錯了三次**）。

> ⚠️⚠️ **這一節的所有程式碼都在 Java 21 / Spring Boot 3.2.5 上編譯過**
> （35 個類別 + `ErrorCode`(98) + `BusinessException` + `Problem`，`mvn compile` 通過）。
> 這是本站第一章做到這件事的 —— 前四章的機器上沒有 JDK。
> **如果你發現任何一處編譯不過，那是課程的問題。**

#### 家族 1：訂單狀態機（4 個 + 1 個基底）

**先看它們為什麼是一個家族。** 四個例外的建構子有 90% 相同：

```java
// OrderNotShippableException、OrderNotDeliverableException、
// OrderNotReturnableException、OrderAlreadyPaidException
//
// 全部都是：「訂單在 X 狀態，而這個操作需要 Y 之一」
```

```java
package example.shop.order.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;
import example.shop.order.domain.OrderStatus;

import java.util.List;
import java.util.Set;

/**
 * ★★ 「狀態機不允許這個操作」這一族的共同建構邏輯。
 *
 * <p>⚠️ 它<b>不是</b> 4.3.2 否決的那種「中間層」——
 * 差別在於它<b>不被任何人 catch</b>，也不承載狀態碼。
 * 它純粹是「四個子類別的建構子有 90% 相同」的抽取，
 * 而每個子類別仍然帶自己的 {@link ErrorCode}。
 *
 * <p>★ 它是 {@code package-private} 與 {@code abstract} ——
 * 這兩個修飾詞一起保證「沒有人能從外面 catch 它，也沒有人能拋它」。
 */
abstract class OrderStateException extends BusinessException implements DomainException {

    protected OrderStateException(ErrorCode code, String operation,
                                  String orderId, String orderNumber,
                                  OrderStatus current, Set<OrderStatus> allowed) {
        super(code,
              "Cannot %s order %s in %s state; allowed states are %s."
                      .formatted(operation, orderNumber, current, sorted(allowed)),
              null,
              ext("orderId", orderId,
                  "orderNumber", orderNumber,
                  "currentStatus", current.name(),
                  "allowedStatuses", sorted(allowed)),
              // {0} = 目前狀態。⚠️ 為什麼這裡放 name() 而不是中文標籤：4.8.4
              new Object[]{current.name()},
              List.of());
    }

    private static List<String> sorted(Set<OrderStatus> statuses) {
        return statuses.stream().map(Enum::name).sorted().toList();
    }
}
```

**於是四個子類別各自只有六行**：

```java
package example.shop.order.domain.exception;

import example.shop.common.error.ErrorCode;
import example.shop.order.domain.OrderStatus;

import java.util.Set;

public class OrderNotShippableException extends OrderStateException {
    public OrderNotShippableException(String orderId, String orderNumber,
                                      OrderStatus current, Set<OrderStatus> allowed) {
        super(ErrorCode.ORDER_NOT_SHIPPABLE, "ship", orderId, orderNumber, current, allowed);
    }
}
```

| 類別 | `ErrorCode` | `operation` |
|---|---|---|
| `OrderNotShippableException` | `ORDER_NOT_SHIPPABLE` (409) | `"ship"` |
| `OrderNotDeliverableException` | `ORDER_NOT_DELIVERABLE` (409) | `"mark delivered"` |
| `OrderNotReturnableException` | `ORDER_NOT_RETURNABLE` (409) | `"return"` |
| `OrderAlreadyPaidException` | `ORDER_ALREADY_PAID` (409) | `"pay"` |

⚠️⚠️ **「這不是 4.3.2 否決的中間層」需要說清楚，因為它看起來一模一樣。**

| | 4.3.2 否決的 `StateConflictException` | 這裡的 `OrderStateException` |
|---|---|---|
| 承載狀態碼？ | ✅ **是**（它的存在就是為了「409」） | 🔴 **不是**（狀態碼還是來自子類別的 `ErrorCode`） |
| 有人 `catch` 它？ | ✅ 是（advice 有一個專門的 handler） | 🔴 **不可能** —— 它是 `package-private` |
| 換父類別會破壞什麼？ | 所有 `catch` 分支 | **什麼都不會**（沒有人認識它） |
| 它是什麼？ | **分類** | **建構子的重複抽取** |

> 📌 **一般規則**：
> **「抽取重複的建構邏輯」與「建立一個分類層」是兩件事，
> 而區分它們的方式是問「有人會 `catch` 它嗎」。**
> 如果答案是「不會」，那它就只是一個 helper，
> 而讓它 `package-private` + `abstract` 把「不會」變成「不能」。

#### 家族 2：`OrderNotCancellableException`（特殊：帶替代動作）

**它不在家族 1 裡面**，理由是它多做一件事：**`alternativeAction`**。

```java
package example.shop.order.domain.exception;

import example.shop.common.error.AlternativeAction;
import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;
import example.shop.order.domain.OrderStatus;

import java.time.LocalDate;
import java.util.List;
import java.util.Set;

/**
 * 訂單目前的狀態不允許取消。
 *
 * <p>★ 它與家族 1（{@code OrderStateException}）的差別只有一件事：
 * <b>它帶 {@code alternativeAction}</b> ——
 * 「不能取消，但可以申請退貨」。
 *
 * <p>⚠️ 而那一件事讓它<b>不能</b>套用家族 1 的基底，
 * 因為 {@code alternativeAction} 的內容取決於<b>目前是哪個狀態</b>。
 */
public class OrderNotCancellableException extends BusinessException
        implements DomainException {

    public OrderNotCancellableException(String orderId, String orderNumber,
                                        OrderStatus current,
                                        Set<OrderStatus> cancellable,
                                        LocalDate returnableUntil) {
        super(ErrorCode.ORDER_NOT_CANCELLABLE,
              "Order %s is in %s state; cancellable states are %s."
                      .formatted(orderNumber, current,
                                 cancellable.stream().map(Enum::name).sorted().toList()),
              null,
              ext("orderId", orderId,
                  "orderNumber", orderNumber,
                  "currentStatus", current.name(),
                  "cancellableStatuses",
                      cancellable.stream().map(Enum::name).sorted().toList(),
                  "alternativeAction", buildAlternative(orderId, current, returnableUntil)),
              new Object[]{current.name()},
              List.of());
    }

    private static AlternativeAction buildAlternative(String orderId, OrderStatus current,
                                                      LocalDate returnableUntil) {
        // 已出貨 / 已送達 → 可以申請退貨
        if (current == OrderStatus.SHIPPED || current == OrderStatus.DELIVERED) {
            return new AlternativeAction("REQUEST_RETURN", "申請退貨",
                    "/orders/" + orderId + "/returns", "POST", returnableUntil, null);
        }
        // 部分出貨 → 只能找客服（有些包裹已經出去了）
        if (current == OrderStatus.PARTIALLY_SHIPPED) {
            return new AlternativeAction("CONTACT_SUPPORT", "聯絡客服",
                    "/support/tickets", "POST", null, null);
        }
        return null;      // ★ 沒有替代動作就不放這個欄位（ext() 會省略 null）
    }
}
```

⚠️⚠️ **這一版與 04-controller 3.5.3 例子 2 有三處不同，全部是修正**：

| # | 04-controller 3.5.3 | 本章 | 為什麼 |
|---|---|---|---|
| 1 | 套件 `order.service.exception` | **`order.domain.exception`** | `order.service` 在 00 章 0.14.3 已拆掉，那個套件不存在了 |
| 2 | `current == OrderStatus.SHIPPED \|\| current == OrderStatus.COMPLETED` | **`SHIPPED \|\| DELIVERED`** | 🔴 **`OrderStatus` 沒有 `COMPLETED`** —— `COMPLETED` 是 `OrderStatus.Category` 的常數（00 章 0.9.3）。**那一行編譯不過** |
| 3 | `"currentStatusLabel", current.label()` | **移除** | 🔴 **`OrderStatus` 沒有 `label()`** —— 00 章 0.14.1 已經指出這件事。標籤由 Web 層用 `StatusLabelResolver` 加（03 章 3.10.3 ②） |

**第 2 點值得停一下**，因為它是一個**很難用眼睛看出來的錯**：

```java
OrderStatus.COMPLETED           // 🔴 不存在
OrderStatus.Category.COMPLETED  // ✅ 存在
```

兩者只差一層巢狀，而 `import example.shop.order.domain.OrderStatus;`
之後 `OrderStatus.COMPLETED` **看起來完全合理**。

> 📌 **這一處是「有 JDK」與「沒有 JDK」的差別的最好例子。**
> 04-controller 三輪人工複查都沒抓到它 ——
> 而 `javac` 第一次就抓到了：
> ```
> error: cannot find symbol
>         return s == OrderStatus.SHIPPED || s == OrderStatus.COMPLETED;
>                                                            ^
>   symbol:   variable COMPLETED
>   location: class OrderStatus
> ```

#### 家族 3：期限類（3 個）

**共同形狀**：帶「期限有多長」「什麼時候過期」「過期後能做什麼」。

```java
package example.shop.order.domain.exception;

import example.shop.common.error.AlternativeAction;
import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;
import example.shop.order.domain.Actor;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * 自助取消的時間窗已過（00 章 0.12 ⑮）。
 *
 * <h3>★★ 注意它收 {@code Actor}</h3>
 * <p>不是為了「決定狀態碼」（那是 4.7 的主題，而這個例外的狀態碼固定是 409），
 * 而是為了決定<b>要不要給 alternativeAction</b>：
 * <ul>
 *   <li>客戶 → 「聯絡客服」（他自己不能取消了）。</li>
 *   <li>⚠️ 客服 → <b>不給</b> —— 對客服說「請聯絡客服」是荒謬的。</li>
 * </ul>
 *
 * <p>👉 這是「例外要帶什麼」取決於 Actor 的<b>最輕量</b>形式：
 * 只影響一個提示欄位，不影響 code 與狀態碼。4.7 處理更難的版本。
 */
public class SelfCancelWindowExpiredException extends BusinessException
        implements DomainException {

    public SelfCancelWindowExpiredException(String orderId, String orderNumber,
                                            Instant paidAt, Duration window,
                                            Actor actor) {
        super(ErrorCode.SELF_CANCEL_WINDOW_EXPIRED,
              "Self-cancel window (%s) for order %s expired at %s."
                      .formatted(window, orderNumber, paidAt.plus(window)),
              null,
              ext("orderId", orderId,
                  "orderNumber", orderNumber,
                  "windowMinutes", window.toMinutes(),
                  "windowExpiredAt", paidAt.plus(window),
                  // ★ 客服不需要「聯絡客服」這個提示
                  "alternativeAction", actor.isPrivileged() ? null
                          : new AlternativeAction("CONTACT_SUPPORT", "聯絡客服",
                                  "/support/tickets", "POST", null, null)),
              new Object[]{window.toMinutes()},
              List.of());
    }
}
```

⚠️ **`windowMinutes` 用 `long` 而不是 `Duration`** —— 4.5.3 規則 1。
`Duration` 的 Jackson 序列化預設是 `"PT30M"`（ISO-8601），
而前端要顯示「30 分鐘」時**必須自己解析 ISO-8601 duration** ——
那是一件前端不該做的事。

```java
package example.shop.order.domain.exception;

import example.shop.common.error.AlternativeAction;
import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/**
 * 退貨期限已過（送達 + 7 天）。
 *
 * <p>⚠️ 與 {@code REFUND_WINDOW_EXPIRED} 是<b>兩件事</b>（00 章 0.12 ⑮）：
 * <table>
 *   <tr><th></th><th>期限</th><th>誰定的</th><th>過期後</th></tr>
 *   <tr><td>{@code RETURN_WINDOW_EXPIRED}</td><td>送達 +7 天</td>
 *       <td><b>我們</b></td><td>客服可以通融</td></tr>
 *   <tr><td>{@code REFUND_WINDOW_EXPIRED}</td><td>付款 +180 天</td>
 *       <td><b>金流商</b></td><td>⚠️ 無解，只能人工匯款</td></tr>
 * </table>
 *
 * <p>👉 所以只有這一個帶「聯絡客服」的 alternativeAction。
 */
public class ReturnWindowExpiredException extends BusinessException
        implements DomainException {

    public ReturnWindowExpiredException(String orderId, String orderNumber,
                                        Instant deliveredAt, int windowDays,
                                        LocalDate expiredOn) {
        super(ErrorCode.RETURN_WINDOW_EXPIRED,
              "Return window (%d days from %s) for order %s expired on %s."
                      .formatted(windowDays, deliveredAt, orderNumber, expiredOn),
              null,
              ext("orderId", orderId, "orderNumber", orderNumber,
                  "deliveredAt", deliveredAt, "windowDays", windowDays,
                  "expiredOn", expiredOn,
                  "alternativeAction", new AlternativeAction("CONTACT_SUPPORT", "聯絡客服",
                          "/support/tickets", "POST", null, null)),
              new Object[]{windowDays, expiredOn},
              List.of());
    }
}
```

#### 家族 4：數量類（3 個）—— 全部帶 `errors[]`

**共同形狀**：錯誤定位到**某一筆明細的數量欄位**。

```java
package example.shop.order.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.FieldViolation;
import example.shop.common.error.marker.DomainException;

import java.util.List;
import java.util.Map;

/**
 * 出貨數量超過「已訂 − 已出」（不變量 I11，00 章 0.12 ⑮）。
 *
 * <p>★ 它帶 {@code errors[]}，所以倉庫端的 UI 可以直接標紅那一列。
 *
 * <p>⚠️ 注意 {@code remaining} 出現在三個地方：
 * {@code extensions}、{@code userMessageArgs}、{@code errors[].constraint}。
 * <b>那不是重複，而是三個不同消費者</b>（4.5.1 的 ②①② ）。
 */
public class ShipmentQuantityExceededException extends BusinessException
        implements DomainException {

    public ShipmentQuantityExceededException(String orderId, int lineIndex,
                                             String productId, int requested,
                                             int ordered, int alreadyShipped) {
        super(ErrorCode.SHIPMENT_QUANTITY_EXCEEDED,
              "Shipping %d of %s exceeds remaining %d (ordered %d, shipped %d) on order %s."
                      .formatted(requested, productId, ordered - alreadyShipped,
                                 ordered, alreadyShipped, orderId),
              null,
              ext("orderId", orderId, "productId", productId,
                  "requested", requested, "ordered", ordered,
                  "alreadyShipped", alreadyShipped,
                  // ★ 4.5.1：把減法算好
                  "remaining", ordered - alreadyShipped),
              new Object[]{ordered - alreadyShipped},
              List.of(new FieldViolation(
                      "lines[" + lineIndex + "].quantity",
                      "SHIPMENT_QUANTITY_EXCEEDED",
                      "最多還能出 " + (ordered - alreadyShipped) + " 件",
                      requested,
                      Map.of("remaining", ordered - alreadyShipped))));
    }
}
```

⚠️⚠️ **`FieldViolation.message` 這裡放了中文字串，而 4.5.2 說「文案不該在例外裡」。**
**這是一個真實的不一致，要面對它。**

| 選項 | 取捨 |
|---|---|
| ① 現狀（中文寫在例外裡） | 🔴 違反 4.5.2；改文案要動 Java；不能 i18n |
| ② `message` 放 i18n key，advice 解析 | ✅ 一致。⚠️ `FieldViolation` 要多一個 `messageArgs` 欄位 → 動到 02 章與 03 章共 40 處 |
| ③ `message` 放 `null`，讓前端用 `code` 自己組 | ✅ 最乾淨。🔴 **破壞性變更** —— 前端目前直接顯示 `message` |

✅ **決定：選 ②，但這一站不做。**

**理由**：`FieldViolation` 是 02 章 2.9.3 定義的**跨三章的接縫**
（02 章產生它、03 章消費它、04 章也產生它），
而改它的形狀要同時動 `ValidationErrorTranslator`、`Problem`、
以及 04-controller 07 章的契約測試。

👉 **處置**：**寫進 4.14 誤區 5 與 4.16 驗收清單的「已知缺口」**，
並在 `FieldViolation` 的 javadoc 加一行 TODO 指向這裡。

> 📌 **這個處置本身是一個示範**：
> **「發現不一致」與「現在修它」是兩個決定。**
> 而**不修的時候必須留下痕跡** ——
> 否則下一個人會以為「中文寫在例外裡」是刻意的設計。

**另外兩個數量類例外形狀相同**：

| 類別 | `ErrorCode` | `errors[].field` | `userMessageArgs` |
|---|---|---|---|
| `ReturnQuantityExceededException` | `RETURN_QUANTITY_EXCEEDED` (422) | `lines[i].quantity` | `{returnable}` |
| `ReturnItemNotInOrderException` | `RETURN_ITEM_NOT_IN_ORDER` (422) | `lines[i].productId` ⚠️ **多筆** | `{}` |

⚠️ **`ReturnItemNotInOrderException` 一次回報「全部」不在訂單裡的商品**，
而不是「第一個」：

```java
public ReturnItemNotInOrderException(String orderId, List<Offending> offending) {
    super(ErrorCode.RETURN_ITEM_NOT_IN_ORDER,
          "Order %s does not contain product(s) %s."
                  .formatted(orderId, offending.stream().map(Offending::productId).toList()),
          null,
          ext("orderId", orderId,
              "unknownProductIds", offending.stream().map(Offending::productId).toList()),
          new Object[0],
          offending.stream()
                   .map(o -> FieldViolation.of("lines[" + o.index() + "].productId",
                           "RETURN_ITEM_NOT_IN_ORDER", "這件商品不在這張訂單裡",
                           o.productId()))
                   .toList());
}

/** ★ index 是為了組出 errors[].field 的 JSON path；productId 是為了顯示。 */
public record Offending(int index, String productId) {}
```

> 📌 **「一次回報全部」是 04-controller 2.10 的政策**（驗證要收集，不要短路）。
> 而它在這裡的具體價值是：客戶勾了 5 件退貨，其中 3 件不在訂單裡 ——
> **一次告訴他是哪 3 件**，而不是讓他試 3 次。

#### 家族 5：券（7 個 + 1 個基底）

**這是抽取效益最高的一族**，因為七個例外**全部**帶 `couponCode`
且**全部**把錯誤定位到請求的 `couponCode` 欄位。

```java
package example.shop.coupon.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.FieldViolation;
import example.shop.common.error.marker.DomainException;

import java.util.List;
import java.util.Map;

/**
 * ★ 券這一族的共同形狀（同 4.5.7 家族 1 的理由：package-private + abstract）。
 */
abstract class CouponException extends BusinessException implements DomainException {

    protected CouponException(ErrorCode code, String couponCode, String detail,
                              Map<String, Object> extra, Object[] args,
                              String fieldMessage) {
        super(code, detail, null,
              merge(couponCode, extra),
              args,
              fieldMessage == null ? List.of()
                      : List.of(FieldViolation.of("couponCode", code.name(),
                                                  fieldMessage, couponCode)));
    }

    /** ★ couponCode 一定在最前面，其餘照傳入順序（LinkedHashMap）。 */
    private static Map<String, Object> merge(String couponCode, Map<String, Object> extra) {
        var m = new java.util.LinkedHashMap<String, Object>();
        m.put("couponCode", couponCode);
        if (extra != null) { extra.forEach((k, v) -> { if (v != null) m.put(k, v); }); }
        return m;
    }
}
```

⚠️ **注意 `FieldViolation.of(..., code.name(), ...)`** ——
`FieldViolation.code` 直接用 `ErrorCode` 的名字。
**那讓「欄位級的 code」與「頂層的 code」保證一致**，
而手寫的話它們會漂移（`"COUPON_EXPIRE"` vs `"COUPON_EXPIRED"`）。

**七個子類別**：

```java
public class CouponExpiredException extends CouponException {
    public CouponExpiredException(String couponCode, Instant expiredAt) {
        super(ErrorCode.COUPON_EXPIRED, couponCode,
              "Coupon %s expired at %s.".formatted(couponCode, expiredAt),
              Map.of("expiredAt", expiredAt),
              new Object[]{expiredAt}, "折扣碼已過期");
    }
}
```

| 類別 | code | 狀態 | 額外的 `extensions` |
|---|---|---|---|
| `CouponNotFoundException` | `COUPON_NOT_FOUND` | 404 | — |
| `CouponExpiredException` | `COUPON_EXPIRED` | 422 | `expiredAt` |
| `CouponNotStartedException` | `COUPON_NOT_STARTED` | 422 | `startsAt` ★ 「還沒開始」要顯示開始時間 |
| `CouponExhaustedException` | `COUPON_EXHAUSTED` | 409 | `usageLimit` |
| **`CouponMinAmountNotMetException`** | `COUPON_MIN_AMOUNT_NOT_MET` | 422 | ★★ `minAmount` / `currentSubtotal` / **`shortfall`** |
| `CouponNotApplicableException` | `COUPON_NOT_APPLICABLE` | 422 | `reasonCode` / `eligibleCategories` |
| `CouponAlreadyAppliedException` | `COUPON_ALREADY_APPLIED` | 409 | `orderId` / `appliedCouponCode` |

**`CouponMinAmountNotMetException` 是 4.5.1 那條「把減法算好」的實作**：

```java
public CouponMinAmountNotMetException(String couponCode, Money minAmount,
                                      Money currentSubtotal) {
    super(ErrorCode.COUPON_MIN_AMOUNT_NOT_MET, couponCode,
          "Coupon %s requires a subtotal of %s but current subtotal is %s."
                  .formatted(couponCode, minAmount.toPlainString(),
                             currentSubtotal.toPlainString()),
          Map.of("minAmount", minAmount.toPlainString(),
                 "currentSubtotal", currentSubtotal.toPlainString(),
                 // ★★ 4.5.1：前端直接顯示「還差 NT$320」，不做減法
                 "shortfall", minAmount.minus(currentSubtotal).toPlainString(),
                 "currency", minAmount.currency().getCurrencyCode()),
          new Object[]{minAmount.minus(currentSubtotal).toPlainString()},
          "尚未達到折扣碼的最低消費金額");
}
```

⚠️ **`minAmount.minus(currentSubtotal)` 算了兩次。**
那不是效能問題（`BigDecimal.subtract` 很便宜），
**但它是一個維護風險**：改了一個忘了改另一個 → `userMessage` 說「還差 320」
而 `extensions.shortfall` 是 `"420"`。

✅ **修法**（而它需要一個 static factory，因為 `super(...)` 必須是第一句）：

```java
public class CouponMinAmountNotMetException extends CouponException {

    /** ★ 唯一的建構路徑 —— 讓 shortfall 只算一次。 */
    public static CouponMinAmountNotMetException of(String couponCode, Money minAmount,
                                                    Money currentSubtotal) {
        Money shortfall = minAmount.minus(currentSubtotal);
        return new CouponMinAmountNotMetException(couponCode, minAmount,
                                                  currentSubtotal, shortfall);
    }

    private CouponMinAmountNotMetException(String couponCode, Money minAmount,
                                           Money currentSubtotal, Money shortfall) {
        super(ErrorCode.COUPON_MIN_AMOUNT_NOT_MET, couponCode,
              "Coupon %s requires a subtotal of %s but current subtotal is %s."
                      .formatted(couponCode, minAmount.toPlainString(),
                                 currentSubtotal.toPlainString()),
              Map.of("minAmount", minAmount.toPlainString(),
                     "currentSubtotal", currentSubtotal.toPlainString(),
                     "shortfall", shortfall.toPlainString(),
                     "currency", minAmount.currency().getCurrencyCode()),
              new Object[]{shortfall.toPlainString()},
              "尚未達到折扣碼的最低消費金額");
    }
}
```

> 📌 **「`super(...)` 必須是第一句」這個 Java 限制是「例外建構子難寫」的主因**，
> 而 static factory 是標準解法。
> ⚠️ **代價**：`new CouponMinAmountNotMetException(...)` 不再可用 →
> 呼叫端要改成 `CouponMinAmountNotMetException.of(...)`，
> 而**忘記改的地方會編譯錯誤**（建構子是 private）—— 那是對的失敗方式。

#### 家族 6：Application 層（7 個）

**它們的共同特徵**：⚠️ **不實作 `DomainException`**。

```java
package example.shop.order.application.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;

/**
 * 空的 PATCH（03 章 3.6.6 ①）。
 *
 * <h3>★★ 為什麼它與 Web 層的空 PATCH 用不同的 code</h3>
 * <p>03 章 3.14 把這件事列為「04 章要決定的」。答案在 4.6.2。
 *
 * <p>★ 它<b>不</b>實作 {@code DomainException} —— 它由 Application 層拋。
 * 而那個差別是有用的：{@code DomainException} 代表「Web 層漏了」，
 * 而這一個代表「Web 層本來就擋不住」（第二個入口沒有 Bean Validation）。
 */
public class EmptyPatchException extends BusinessException {
    public EmptyPatchException(String resourceId, List<String> patchableFields) {
        super(ErrorCode.ORDER_PATCH_EMPTY,
              "Patch for %s contains no field.".formatted(resourceId),
              null,
              // ★ 把「可以 PATCH 哪些欄位」告訴呼叫端 —— 它通常是打錯欄位名
              ext("resourceId", resourceId, "patchableFields", patchableFields),
              new Object[0],
              List.of());
    }
}
```

⚠️ **`patchableFields` 是一個「看起來多餘但實際救了很多時間」的欄位。**
空 PATCH 最常見的原因**不是**「真的沒送欄位」，
而是**欄位名打錯**（`customer_note` vs `customerNote`）——
而 04-controller 1.13 的 `FAIL_ON_UNKNOWN_PROPERTIES` 若被關掉，
未知欄位會被靜默忽略 → 變成空 PATCH。

**把「可以填什麼」列出來，呼叫端一眼看到自己打錯了。**

| 類別 | code | 狀態 | 特徵 |
|---|---|---|---|
| `EmptyPatchException` | `ORDER_PATCH_EMPTY` | 422 | `patchableFields` |
| `InternalFieldNotEditableException` | `ORDER_INTERNAL_FIELD_NOT_EDITABLE` | **403** | ⚠️ 收 `List<String> fields`（不是單一欄位），見下 |
| `ProductNotFoundException` | `PRODUCT_NOT_FOUND` | 422 | 收 `List<Missing>`，一次報全部 |
| `ProductDiscontinuedException` | `PRODUCT_DISCONTINUED` | **410** | `replacementProductId` ★ 引導到替代品 |
| `ProductNotPurchasableException` | `PRODUCT_NOT_PURCHASABLE` | 422 | `reasonCode` |
| `ReturnRequestEmptyException` | `RETURN_REQUEST_EMPTY` | 422 | 與 `ORDER_EMPTY` 對稱 |
| `OrderAmountMismatchException` | `ORDER_AMOUNT_MISMATCH` | 422 | ★ `Retry.REFETCH_THEN_RETRY` |

⚠️ **`InternalFieldNotEditableException` 收 `List<String>` 而不是單一欄位名**，
這是修正 03 章 3.6.6 ③ 的一處：

```java
// ── 03 章 3.6.6 ③ ─────────────────────────────────────────
throw new InternalFieldNotEditableException(cmd.orderId(), "internalNote",
                                           cmd.actor().type());
//                                          ↑ 🔴 寫死一個欄位名

// ── 本章 ─────────────────────────────────────────────────
throw new InternalFieldNotEditableException(cmd.orderId(),
                                           cmd.touchedInternalFields(),  // ★ List
                                           cmd.actor().type());
```

**理由**：`UpdateOrderCommand` 有**兩個**內部欄位（`internalNote` 與 `invoice` 的部分屬性），
而寫死 `"internalNote"` 會在改 `invoice` 時給出**錯的欄位名** ——
於是客戶端顯示「無法修改欄位『internalNote』」而使用者根本沒動它。

**`touchesInternalFields()` 要跟著改成回傳清單**：

```java
// UpdateOrderCommand（03 章 3.6.4）
/** ★ 從「有沒有」變成「有哪些」—— 錯誤訊息需要後者。 */
public List<String> touchedInternalFields() {
    var touched = new java.util.ArrayList<String>(2);
    if (!internalNote().isAbsent()) { touched.add("internalNote"); }
    if (!invoiceInternalMemo().isAbsent()) { touched.add("invoiceInternalMemo"); }
    return List.copyOf(touched);
}

/** ★ 保留舊方法，用新方法實作 —— 呼叫端的 if 不用改。 */
public boolean touchesInternalFields() { return !touchedInternalFields().isEmpty(); }
```

> 📌 **「從布林變成清單，並用清單實作布林」是一個很常用的擴充手法**：
> 呼叫端的 `if (cmd.touchesInternalFields())` 完全不用改，
> 而需要細節的地方多一個方法可用。
> ⚠️ **代價**：`touchesInternalFields()` 現在會配置一個 `ArrayList`。
> 在「每次 PATCH 一次」的頻率下無關緊要 ——
> **但如果它被放進迴圈，那就是另一回事**（4.11.1 有同類的量測）。

#### 家族 7：付款（3 個）

| 類別 | code | 狀態 | 特殊之處 |
|---|---|---|---|
| `RefundExceedsPaymentException` | `REFUND_EXCEEDS_PAYMENT` | 422 | 不變量 I8 的**第一道**（`Payment.refund()`） |
| **`RefundRejectedException`** | `REFUND_REJECTED` | 422 | ★★ 唯一實作 `SideEffectsCommitted` 的（4.4.3 邊界 3） |
| `OptimisticLockConflictException` | `OPTIMISTIC_LOCK_CONFLICT` | **412** | ★ 唯一**帶 `cause`** 的（4.5.6） |

```java
package example.shop.payment.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.util.List;

/**
 * 樂觀鎖衝突（02 章 2.11.6）。
 *
 * <h3>★ 它是三個裡唯一帶 cause 的</h3>
 * <p>因為它<b>包裝</b>一個框架例外
 * （{@code ObjectOptimisticLockingFailureException} 或
 * {@code OptimisticLockingFailureException}），
 * 而那個例外的 stack trace 告訴你「是哪一次 flush 撞的」——
 * 在 JPA 的自動 flush 之下那不是顯而易見的（02 章 2.11.6）。
 *
 * <h3>★ 它<b>不</b>實作 DomainException</h3>
 * <p>樂觀鎖不是領域規則，是併發控制機制。
 */
public class OptimisticLockConflictException extends BusinessException {

    public OptimisticLockConflictException(String resourceType, String resourceId,
                                           long expectedVersion, long actualVersion,
                                           Throwable cause) {
        super(ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
              "%s[%s] version conflict: expected %d, actual %d."
                      .formatted(resourceType, resourceId, expectedVersion, actualVersion),
              cause,                                   // ★ 這裡
              ext("resourceType", resourceType, "resourceId", resourceId,
                  "expectedVersion", expectedVersion, "actualVersion", actualVersion),
              new Object[0],
              List.of());
    }
}
```

⚠️ **`actualVersion` 有一個實務問題**：
`ObjectOptimisticLockingFailureException` **不告訴你目前的版本是多少**
（它只知道「更新影響了 0 列」）。

**三個選項**：

| 選項 | 取捨 |
|---|---|
| ① 再查一次資料庫拿版本 | 🔴 **在 rollback 之後的交易裡查**，而且它可能又變了 |
| ② `actualVersion` 傳 `-1` 代表未知 | 🔴 `-1` 會出現在 API 回應裡，前端要特別處理 |
| ③ ✅ **`actualVersion` 改成 `Long`（可為 null），拿不到就不放進 extensions** | `ext()` 會省略 null（4.5.3 規則 7） |

✅ **選 ③**：

```java
    public OptimisticLockConflictException(String resourceType, String resourceId,
                                           long expectedVersion, Long actualVersion,
                                           Throwable cause) {
        super(ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
              actualVersion == null
                      ? "%s[%s] version conflict: expected %d, actual unknown."
                              .formatted(resourceType, resourceId, expectedVersion)
                      : "%s[%s] version conflict: expected %d, actual %d."
                              .formatted(resourceType, resourceId, expectedVersion, actualVersion),
              cause,
              ext("resourceType", resourceType, "resourceId", resourceId,
                  "expectedVersion", expectedVersion,
                  "actualVersion", actualVersion),     // ★ null → 這個 key 不會出現
              new Object[0],
              List.of());
    }
```

> 📌 **「拿不到的值不要編造」** ——
> `-1` 是編造，`null`（於是欄位消失）是誠實。
> 而客戶端的處理方式一樣：`Retry.REFETCH_THEN_RETRY` 叫它重新取一次資源。

---

## 4.6 業務例外與狀態碼的完整對應表

### 4.6.1 對應表本身：從 98 個 code 看回去

⚠️ **這張表刻意「從 code 看例外」而不是「從例外看 code」**，
理由是 4.2.4 那個漏洞：**「code 沒有例外」是需要被看見的狀態。**

**98 個 code 分成四類**：

| 類別 | 數量 | 說明 |
|---|---|---|
| ✅ **有業務例外，本站已實作** | **38** | 這一站可以端到端跑通的部分 |
| ⚠️ **有業務例外，但由框架／Web 層產生** | 21 | `MALFORMED_REQUEST`、`METHOD_NOT_ALLOWED`… → `SpringExceptionMapper`（04-controller 3.7.3） |
| ⏳ **尚未有任何拋出點**（後續站台） | 34 | 認證授權（09-spring-security）、購物車、5xx 的一部分 |
| 🔴 **5xx**（不該有業務例外） | 5 | `INTERNAL_ERROR` 等 —— 見下 |

**① 本站已實作的 38 個**（`code` → 例外 → 拋出點）：

| code | 狀態 | 例外 | 誰拋 |
|---|---|---|---|
| `RESOURCE_NOT_FOUND` | 404 | `ResourceNotFoundException` | `OrderApplicationService`（01 章 1.8.3） |
| `VALIDATION_FAILED` | 422 | `ValidationFailedException` | `OrderApplicationService.create()`（04-controller 3.5.3 例子 3） |
| `ORDER_EMPTY` | 422 | `OrderEmptyException` | `Order` I1 |
| `ORDER_ITEM_LIMIT_EXCEEDED` | 422 | `OrderItemLimitExceededException` | `Order` I2 |
| `ORDER_AMOUNT_MISMATCH` | 422 | `OrderAmountMismatchException` | `OrderApplicationService.pay()` |
| `MIXED_CURRENCY` | 422 | `MixedCurrencyException` | `Order` I10 |
| `ORDER_NOT_CANCELLABLE` | 409 | `OrderNotCancellableException` | `Order.cancel()` |
| `SELF_CANCEL_WINDOW_EXPIRED` | 409 | `SelfCancelWindowExpiredException` | `Order.cancel()` |
| `CANCEL_NOTE_REQUIRED` | 422 | `CancelNoteRequiredException` | `Order.cancel()` |
| `ORDER_ALREADY_PAID` | 409 | `OrderAlreadyPaidException` | `Order.markPaid()` |
| `ORDER_NOT_SHIPPABLE` | 409 | `OrderNotShippableException` | `Order.ship()` |
| `SHIPMENT_QUANTITY_EXCEEDED` | 422 | `ShipmentQuantityExceededException` | `Order.ship()` I11 |
| `ORDER_NOT_DELIVERABLE` | 409 | `OrderNotDeliverableException` | `Order.markDelivered()` |
| `ORDER_NOT_RETURNABLE` | 409 | `OrderNotReturnableException` | `Order.requestReturn()` |
| `RETURN_WINDOW_EXPIRED` | 409 | `ReturnWindowExpiredException` | `Order.requestReturn()` |
| `RETURN_REQUEST_EMPTY` | 422 | `ReturnRequestEmptyException` | `ReturnApplicationService` |
| `RETURN_ITEM_NOT_IN_ORDER` | 422 | `ReturnItemNotInOrderException` | `Order.requestReturn()` R6 |
| `RETURN_QUANTITY_EXCEEDED` | 422 | `ReturnQuantityExceededException` | `Order.requestReturn()` R7 |
| `ITEM_NOT_RETURNABLE` | 422 | `ItemNotReturnableException` | `Order.requestReturn()` |
| `ORDER_PATCH_EMPTY` | 422 | `EmptyPatchException` | `OrderApplicationService.update()` |
| `ORDER_INTERNAL_FIELD_NOT_EDITABLE` | 403 | `InternalFieldNotEditableException` | `OrderApplicationService.update()` |
| `ORDER_NOTE_TOO_LONG` | 422 | `NoteTooLongException` | `Order.changeCustomerNote()` / `changeInternalNote()` |
| `ORDER_INVOICE_ALREADY_ISSUED` | 409 | `InvoiceAlreadyIssuedException` | `Order.resetInvoiceToPersonal()` |
| `ORDER_INVOICE_REQUEST_IN_FLIGHT` | 409 | `InvoiceRequestInFlightException` | `Order.changeInvoice()` |
| `ORDER_ADDRESS_NOT_EDITABLE` | 409 | `OrderAddressNotEditableException` | ⚠️ **見 4.6.4** |
| `ADDRESS_CHANGE_LIMIT_EXCEEDED` | 429 | `AddressChangeLimitExceededException` | ⚠️ **見 4.6.4** |
| `INSUFFICIENT_STOCK` | 409 | `InsufficientStockException` | `Stock.reserve()` + `OrderApplicationService` |
| `NEGATIVE_STOCK_NOT_ALLOWED` | 409 | `InvariantViolationException` ⚠️ | **見 4.6.3** |
| `PRODUCT_NOT_FOUND` | 422 | `ProductNotFoundException` | `OrderApplicationService.create()` |
| `PRODUCT_DISCONTINUED` | 410 | `ProductDiscontinuedException` | 同上 |
| `PRODUCT_NOT_PURCHASABLE` | 422 | `ProductNotPurchasableException` | 同上 |
| `COUPON_NOT_FOUND` | 404 | `CouponNotFoundException` | `CouponService.apply()` |
| `COUPON_EXPIRED` | 422 | `CouponExpiredException` | `Coupon.assertUsableAt()` |
| `COUPON_NOT_STARTED` | 422 | `CouponNotStartedException` | 同上 |
| `COUPON_EXHAUSTED` | 409 | `CouponExhaustedException` | `Coupon.consume()` |
| `COUPON_MIN_AMOUNT_NOT_MET` | 422 | `CouponMinAmountNotMetException` | `Coupon.discountFor()` |
| `COUPON_NOT_APPLICABLE` | 422 | `CouponNotApplicableException` | 同上 |
| `COUPON_ALREADY_APPLIED` | 409 | `CouponAlreadyAppliedException` | `Order.applyCoupon()` |
| `REFUND_EXCEEDS_PAYMENT` | 422 | `RefundExceedsPaymentException` | `Payment.refund()` I8 |
| `REFUND_REJECTED` | 422 | `RefundRejectedException` | `ReturnApplicationService.processRefund()` |
| `OPTIMISTIC_LOCK_CONFLICT` | 412 | `OptimisticLockConflictException` | `OrderRepositoryAdapter.save()` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | `IdempotencyKeyReusedException` | `IdempotencyStore.record()` |

⚠️ **上面有 42 列而我說 38 個。** 那個差額是刻意的：
**兩個 code（`ORDER_ADDRESS_NOT_EDITABLE`、`ADDRESS_CHANGE_LIMIT_EXCEEDED`）的例外不存在**（4.6.4），
**一個（`NEGATIVE_STOCK_NOT_ALLOWED`）用的不是業務例外**（4.6.3），
**一個（`COUPON_ALREADY_USED`）我把它與 `COUPON_ALREADY_APPLIED` 弄混了** —— 見下。

**🔴 那個「弄混了」是真的**，而它值得留在課程裡：

| code | 意思 | 拋出點 |
|---|---|---|
| `COUPON_ALREADY_APPLIED` (409) | **這張訂單**已經套過券 | `Order.applyCoupon()` |
| `COUPON_ALREADY_USED` (409) | **這個客戶**用過這張券 | `Coupon.consume()`（`maxPerCustomer`，00 章 0.12 ⑨） |

**兩者都存在，而我上面只寫了一個** —— 於是 `COUPON_ALREADY_USED` 沒有例外，
於是它會 fallthrough 成 500。

```java
package example.shop.coupon.domain.exception;

import example.shop.common.error.ErrorCode;

import java.util.Map;

/**
 * 這個客戶已經用過這張券（{@code maxPerCustomer}，00 章 0.12 ⑨）。
 *
 * <p>⚠️ 與 {@code COUPON_ALREADY_APPLIED} 是兩件事：
 * <ul>
 *   <li>{@code COUPON_ALREADY_APPLIED}：<b>這張訂單</b>已經有一張券了。
 *       → 客戶端該做的是「先移除舊的」。</li>
 *   <li>{@code COUPON_ALREADY_USED}（本例外）：<b>這個客戶</b>用過這張券。
 *       → 客戶端該做的是「換一張券」。</li>
 * </ul>
 * <b>兩個「客戶端該做的事」不同 → 兩個 code</b>（4.2.6 的判準）。
 */
public class CouponAlreadyUsedException extends CouponException {
    public CouponAlreadyUsedException(String couponCode, String customerId,
                                       int usedCount, int maxPerCustomer) {
        super(ErrorCode.COUPON_ALREADY_USED, couponCode,
              "Customer %s already used coupon %s %d time(s); max is %d."
                      .formatted(customerId, couponCode, usedCount, maxPerCustomer),
              // ⚠️ customerId 刻意【不】進 extensions —— 呼叫端已經知道自己是誰，
              //    而客服查別人的訂單時它是別人的 id（03 章事故 1 的同一類洩漏）
              Map.of("usedCount", usedCount, "maxPerCustomer", maxPerCustomer),
              new Object[]{maxPerCustomer},
              maxPerCustomer == 1 ? "這張折扣碼您已經使用過"
                                  : "這張折扣碼您已達使用次數上限");
    }
}
```

⚠️ **注意最後那個三元運算子。** `maxPerCustomer == 1` 時說
「您已經使用過」比「已達使用次數上限（1 次）」自然得多 ——
**而這是唯一一個文案分支在 Java 裡的地方，它違反 4.5.2。**

**兩個選項**：

| 選項 | 取捨 |
|---|---|
| ① 現狀（Java 裡分支） | 🔴 違反 4.5.2；但 `FieldViolation.message` 本來就已經違反了（4.5.7 家族 4） |
| ② 兩個 code（`COUPON_ALREADY_USED` / `COUPON_PER_CUSTOMER_LIMIT`） | 🔴 違反 4.2.6 —— 客戶端做的事**一樣**（換一張券） |
| ③ ✅ **一個 code，兩個 i18n key**：`error.COUPON_ALREADY_USED.user` 與 `.user.once` | ⚠️ `ProblemFactory` 要支援「key 的變體」 |

✅ **選 ①，並記進 4.14 誤區 5 的同一個缺口。**
理由：③ 需要動 `ProblemFactory` 的 API（一個跨 20 處的改動），
而這個文案差異的價值不值那個代價。
**而 ① 與家族 4 的 `FieldViolation.message` 是同一個缺口** ——
所以它不會增加缺口的數量，只是多一個實例。

### 4.6.2 `EmptyPatchException` 的兩種 422 要不要統一（回答 03 章 3.14）★★

03 章 3.14 把這個問題丟給本章：

> `EmptyPatchException` 的 422 與 Web 層的 422 **形狀不同**（3.6.6 ①）。
> 兩種 422 讓前端要寫兩套錯誤處理。04 章 4.6 會決定要不要統一。

**兩種 422 的實際形狀**：

```jsonc
// ① Web 層：@AssertTrue 失敗（04-controller 2.12.4）
{
  "status": 422,
  "code": "VALIDATION_FAILED",
  "userMessage": "請檢查輸入的內容。",
  "errors": [
    { "field": "", "code": "AtLeastOneField",
      "message": "至少要提供一個要修改的欄位" }
  ],
  "errorCount": 1
}

// ② Service 層：EmptyPatchException
{
  "status": 422,
  "code": "ORDER_PATCH_EMPTY",
  "userMessage": "沒有任何要修改的欄位。",
  "resourceId": "ORD-2026-0827-0001",
  "patchableFields": ["customerNote", "invoice", "internalNote"]
  // ⚠️ 沒有 errors[]
}
```

**前端要寫兩套的具體樣子**：

```typescript
// 🔴 前端的 PATCH 錯誤處理
if (problem.status === 422) {
  if (problem.errors) {
    highlightFields(problem.errors);            // ← ① 走這裡
  } else {
    showToast(problem.userMessage);             // ← ② 走這裡
  }
}
```

⚠️ **這段程式碼其實沒有很糟。** 而問題不在這裡 —— 問題在：

```typescript
// ⚠️ 真正的問題：前端沒有辦法知道「422 一定有 errors[]」
//    於是【每一個】422 的處理都要寫 if (problem.errors)
//    而那個 if 有 70 個端點 × 平均 2 個 422 = 140 個位置
```

**四個選項**：

| 選項 | 做法 | 取捨 |
|---|---|---|
| ① **統一成 `VALIDATION_FAILED`** | `EmptyPatchException` 改用 `VALIDATION_FAILED` + 一個 `errors[]` | 🔴🔴 **失去 `patchableFields`**（那是它最有用的欄位），且 `code` 不再精確 |
| ② **統一形狀：讓所有 422 都有 `errors[]`** | `EmptyPatchException` 補一個 `field: null` 的 `FieldViolation` | ✅ 前端的 `if` 消失。⚠️ `field: null` 的語意要定義 |
| ③ **統一形狀：讓所有 422 都**沒有**`errors[]`** | 🔴 不可能 —— 欄位級錯誤沒有 `errors[]` 就沒有價值 | |
| ④ **不統一，用文件說明** | 零成本 | 🔴 140 個 `if` 留著；而「文件說明」不會被讀 |

✅ **選 ②。** 而它的關鍵是 `field` 為 `null` 的語意 ——
**`FieldViolation` 的 javadoc 本來就寫了**（04-controller 3.5.2）：

```java
public record FieldViolation(
    String field,                       // null = 全域錯誤（非欄位級）
    ...
```

**於是 `EmptyPatchException` 改成**：

```java
public class EmptyPatchException extends BusinessException {

    public EmptyPatchException(String resourceId, List<String> patchableFields) {
        super(ErrorCode.ORDER_PATCH_EMPTY,
              "Patch for %s contains no field.".formatted(resourceId),
              null,
              ext("resourceId", resourceId, "patchableFields", patchableFields),
              new Object[0],
              // ★★ 4.6.2：補一個 field=null 的全域錯誤，讓所有 422 形狀一致
              List.of(new FieldViolation(
                      null,                                  // 全域錯誤
                      ErrorCode.ORDER_PATCH_EMPTY.name(),
                      "至少要提供一個要修改的欄位",
                      null,
                      java.util.Map.of("patchableFields", patchableFields))));
    }
}
```

⚠️ **而「所有 422 都有 `errors[]`」需要一條測試守住**，
否則第 39 個業務例外會再破一次：

```java
/**
 * ★★ 每一個 422 的業務例外都至少有一筆 errors[]。
 *
 * <p>它讓 4.6.2 的決定變成一個機械規則，而不是一句約定。
 *
 * <p>⚠️ 這條測試需要「能實例化每一個例外」（4.12.1 的 fixture）。
 */
@ParameterizedTest
@MethodSource("everyBusinessExceptionInstance")
void 每個422都有errors(BusinessException ex) {
    if (ex.errorCode().status() != HttpStatus.UNPROCESSABLE_ENTITY) { return; }

    assertThat(ex.fieldViolations())
            .as("""
                %s 是 422 但沒有 errors[]。
                422 的形狀已統一（4.6.2）：欄位級錯誤填 field，
                全域錯誤填 field = null。
                """.formatted(ex.getClass().getSimpleName()))
            .isNotEmpty();
}
```

⚠️⚠️ **這條測試現在會紅燈**，而那是刻意的。跑一次會列出**還沒補 `errors[]` 的 422**：

| 例外 | 補什麼 `field` |
|---|---|
| `OrderEmptyException` | `null`（全域） |
| `OrderItemLimitExceededException` | `"items"`（整個陣列） |
| `MixedCurrencyException` | ✅ 已有（每一筆明細） |
| `OrderAmountMismatchException` | `"totalAmount"` |
| `NoteTooLongException` | ⚠️ **`null`** —— 4.2.6 說它不知道欄位路徑 |
| `ReturnRequestEmptyException` | `null` |
| `CouponExpiredException` 等 6 個 | ✅ 已有（`couponCode`） |
| `RefundExceedsPaymentException` | `"refundAmount"` |
| `RefundRejectedException` | ⚠️ **`null`** —— 沒有任何欄位是錯的 |

⚠️ **最後兩列暴露了一個新問題**：
`RefundRejectedException` 的 `field: null` 是**「沒有欄位錯」**，
而 `EmptyPatchException` 的 `field: null` 是**「全部欄位都沒填」** ——
**兩個 `null` 的語意不同。**

> 📌 **一個「統一形狀」的決定，把問題從「兩種形狀」搬到「一種形狀、兩種語意」。**
>
> ✅ **而那仍然是進步**，理由很具體：
> 前端的 `if (problem.errors)` 消失了（140 個位置），
> 而換來的是 `errors[0].code` 這個**它本來就要看的欄位**去區分兩種 `null`。
>
> ⚠️ **但它不是免費的**，而「以為它免費」是這類重構最常見的失敗。

### 4.6.3 一個 code 用「非業務例外」：`NEGATIVE_STOCK_NOT_ALLOWED`

**這個 code 是 409，而它對應的不是 `BusinessException`。**

```java
// Stock 聚合
public void adjust(int delta, Actor actor) {
    int next = onHand + delta;
    if (next < 0) {
        // ⚠️ 哪一個？
    }
    onHand = next;
}
```

**兩種情況，而它們的答案不同**：

| 情況 | 誰能修好它（4.4.1） | 該是什麼 |
|---|---|---|
| **倉管在盤點介面輸入 `-50`，而現有庫存 30** | ✅ 呼叫端（改成 `-30`） | **409 `NEGATIVE_STOCK_NOT_ALLOWED`** + `BusinessException` |
| **`Order.cancel()` 回補庫存時算錯，`delta` 是負的** | 🔴 我們 | **500** + `InvariantViolationException` |

⚠️ **同一個 `if`，兩種答案** —— 而分辨它們的資訊**不在 `Stock` 裡面**。

**三個選項**：

| 選項 | 取捨 |
|---|---|
| ① `adjust()` 多一個 `boolean userInitiated` 參數 | 🔴 **布林參數**（01 章 1.10 的反模式），而且呼叫端會傳錯 |
| ② **兩個方法**：`adjustByOperator()` 與 `applyDelta()` | ✅ 名字就是意圖；⚠️ 兩個方法的 body 幾乎相同 |
| ③ 一律拋 `BusinessException`，讓「我們的 bug」也變 409 | 🔴🔴 **監控失效** —— 回補庫存的 bug 永遠不會告警 |

✅ **選 ②**：

```java
/**
 * 倉管手動調整庫存（盤點）。
 *
 * <p>★ 呼叫端是<b>人</b>，所以「調到負數」是可修正的輸入錯誤 → 409。
 */
public void adjustByOperator(int delta, Actor actor, Instant now) {
    int next = onHand + delta;
    if (next < 0) {
        throw new NegativeStockNotAllowedException(productId, onHand, delta);
    }
    applyDeltaInternal(next, actor, now);
}

/**
 * 系統內部的庫存變動（下單扣減、取消回補）。
 *
 * <p>⚠️ 呼叫端是<b>程式</b>，所以「調到負數」代表我們算錯了 → 500 + 告警。
 */
public void applyDelta(int delta, Actor actor, Instant now) {
    int next = onHand + delta;
    if (next < 0) {
        throw new InvariantViolationException("I3", "Stock", productId,
                "onHand %d + delta %d would go negative".formatted(onHand, delta));
    }
    applyDeltaInternal(next, actor, now);
}

/** ★ 兩個公開方法共用的部分（不含那個 if）。 */
private void applyDeltaInternal(int next, Actor actor, Instant now) {
    this.onHand = next;
    this.lastAdjustedBy = actor.id();
    this.lastAdjustedAt = now;
}
```

> 📌 **這一節的一般規則**：
> **「同一個檢查、兩種嚴重程度」的解法是「兩個入口」，不是「一個參數」。**
> 理由：**入口的名字會被 code review 看到，參數的值不會。**
>
> ⚠️ **而它有一條可以自動化的守門規則**：
> **`applyDelta` 只能被 `order` 套件呼叫；`adjustByOperator` 只能被 `warehouse.web` 呼叫。**
> 那是一條 ArchUnit 規則（4.12.3 ⑤）。

### 4.6.4 兩個 code 完全沒有例外 🔴

**跑 4.12.1 的守門測試（反方向）會找出這兩個**：

| code | 狀態 | 誰該拋它 | 為什麼沒有 |
|---|---|---|---|
| `ORDER_ADDRESS_NOT_EDITABLE` | 409 | `Order.changeShippingAddress()` | ⚠️ 02 章 2.14.1 ⑤ 與 03 章 3.6.6 ④ 為這個方法的**簽章**吵了一輪，而**吵完之後沒有人補例外** |
| `ADDRESS_CHANGE_LIMIT_EXCEEDED` | 429 | 同上 | 02 章 2.11.5「一天最多改 3 次地址」給了**完整的 SQL 與鎖策略**，但**沒有給例外類別** |

**兩個都補上**：

```java
package example.shop.order.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;
import example.shop.order.domain.OrderStatus;

import java.util.List;
import java.util.Set;

/**
 * 訂單目前的狀態不允許改地址。
 *
 * <p>★ 它<b>不</b>套用 4.5.7 家族 1 的基底，因為它多帶一個
 * {@code alternativeAction}（「改不了地址，但可以取消重下」）。
 */
public class OrderAddressNotEditableException extends BusinessException
        implements DomainException {

    public OrderAddressNotEditableException(String orderId, String orderNumber,
                                            OrderStatus current,
                                            Set<OrderStatus> editable,
                                            boolean cancellable) {
        super(ErrorCode.ORDER_ADDRESS_NOT_EDITABLE,
              "Cannot change address of order %s in %s state.".formatted(orderNumber, current),
              null,
              ext("orderId", orderId, "orderNumber", orderNumber,
                  "currentStatus", current.name(),
                  "editableStatuses", editable.stream().map(Enum::name).sorted().toList(),
                  "alternativeAction", cancellable
                          ? new example.shop.common.error.AlternativeAction(
                                  "CANCEL_AND_REORDER", "取消後重新下單",
                                  "/orders/" + orderId + "/cancel", "POST", null, null)
                          : null),
              new Object[]{current.name()},
              List.of());
    }
}
```

```java
package example.shop.order.application.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * 一天內改地址次數超過上限（02 章 2.11.5）。
 *
 * <h3>★★ 它是唯一一個 429 的業務例外，而 429 需要 Retry-After</h3>
 * <p>{@code retryAfterSeconds} 這個 extension <b>不是</b>裝飾 ——
 * 4.9.2 會說明 advice 怎麼把它變成一個真的 {@code Retry-After} 標頭。
 *
 * <p>★ 它在 {@code application} 而不是 {@code domain}，因為
 * 「今天改了幾次」<b>不在 {@code Order} 聚合裡</b>
 * （它是一張獨立的 {@code order_address_changes} 表，02 章 2.11.5）。
 */
public class AddressChangeLimitExceededException extends BusinessException {

    public AddressChangeLimitExceededException(String orderId, int limit,
                                                int used, Instant windowResetsAt,
                                                Instant now) {
        super(ErrorCode.ADDRESS_CHANGE_LIMIT_EXCEEDED,
              "Order %s used %d of %d address changes; window resets at %s."
                      .formatted(orderId, used, limit, windowResetsAt),
              null,
              ext("orderId", orderId,
                  "limit", limit,
                  "used", used,
                  "windowResetsAt", windowResetsAt,
                  // ★ 4.9.2：advice 讀這個欄位產生 Retry-After
                  "retryAfterSeconds",
                      Math.max(1, Duration.between(now, windowResetsAt).toSeconds())),
              new Object[]{limit, windowResetsAt},
              List.of());
    }
}
```

⚠️ **`Math.max(1, ...)` 是必要的**：
如果 `windowResetsAt` 已經過去（時鐘偏移、或這一列是舊資料），
`Duration.between` 會是負數 → `Retry-After: -3` → **有些 HTTP client 會直接崩**。

> 📌 **這一節本身是一個方法示範**：
> **4.12.1 的守門測試不只抓「新的錯誤」，它抓「前面章節的遺漏」。**
> 這兩個 code 在 04-controller 的錯誤目錄裡躺了整整一站 ——
> 而 04-controller 3.14.5 的 `ErrorCodeUsageTest` 有一個
> `PLANNED_FOR_LATER` 清單，**它們就在那個清單裡**。
>
> ⚠️⚠️ **「已規劃」清單是一個必要的機制，也是一個危險的機制**：
> 它讓「還沒實作」與「忘記實作」在測試上長得一樣。
> 👉 **4.12.1 的處置**：`PLANNED_FOR_LATER` 的每一項都要標**哪一站會實作它**，
> 而「本站」的項目在本站結束時必須清空。

---

## 4.7 一個例外對應兩個狀態碼 ★★

### 4.7.1 現場：同一個「訂單不可編輯」，客戶是 409、客服是 403

**需求**（03 章 3.7.3 的欄位 × 角色表推導出來的）：

```
客戶 PATCH /api/orders/{id}  改 customerNote
  · 訂單狀態是 PENDING_PAYMENT / PAID  → ✅ 成功
  · 訂單狀態是 SHIPPED                 → 🔴 「已出貨，備註不可再改」→ 409

客服 PATCH /api/support/orders/{id}  改 customerNote
  · 任何狀態                            → ✅ 成功（客服可以繞過狀態限制）

⚠️ 而【客戶】打 /api/support/orders/{id}
  · 任何狀態                            → 🔴 「你不是客服」→ 403
```

**看起來這是兩個不同的檢查**，而實際的程式碼長這樣：

```java
// OrderApplicationService.update()
Order order = orders.findByIdVisibleTo(cmd.orderId(), cmd.actor())
        .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

// ★ 一個檢查，兩種對象
if (!order.status().isEditable() && !cmd.actor().isPrivileged()) {
    throw new OrderNotEditableException(...);      // ← 這個例外該回什麼？
}
```

⚠️ **問題出在「這個 `if` 為 false 的兩種方式」**：

| 誰 | 訂單狀態 | 為什麼被拒 | 該回什麼 |
|---|---|---|---|
| 客戶 | `SHIPPED` | **狀態不對** | **409** `ORDER_ITEM_IMMUTABLE` |
| 客戶（打客服端點） | `PENDING_PAYMENT` | **權限不對** | **403** `INSUFFICIENT_ROLE` |

**而上面那個 `if` 把兩者合成一個。**

⚠️⚠️ **這不是一個假想的問題。** 它的真實症狀是：

```
客戶在 App 上看到「權限不足」（403 的文案），
而他改的是【自己的】訂單。
→ 客服工單：「為什麼我不能改我自己的訂單備註？」
```

### 4.7.2 五個選項

**選項 ①：兩個例外類別**

```java
if (!cmd.actor().isPrivileged() && isSupportEndpoint(cmd)) {
    throw new InsufficientRoleException(...);       // 403
}
if (!order.status().isEditable() && !cmd.actor().isPrivileged()) {
    throw new OrderNotEditableException(...);       // 409
}
```

| | |
|---|---|
| ✅ | 每個例外一個 code、一個狀態碼 —— 與 4.3.4 的設計完全一致 |
| 🔴 | **`isSupportEndpoint(cmd)`** —— Application 層在問「這是哪個 HTTP 端點」（違反 00 章 0.10.6） |

**選項 ②：一個例外，狀態碼由 advice 決定（讀 `Actor`）**

```java
@ExceptionHandler(OrderNotEditableException.class)
public ResponseEntity<Problem> handle(OrderNotEditableException ex) {
    Actor actor = currentActorHolder.get();          // ← 從 ThreadLocal 拿
    ErrorCode code = actor.isPrivileged()
            ? ErrorCode.ORDER_ITEM_IMMUTABLE         // 409
            : ErrorCode.INSUFFICIENT_ROLE;           // 403
    ...
}
```

🔴🔴 **這是最常見的做法，也是錯的。** 4.7.3 專門講它。

**選項 ③：一個例外，在拋出點決定 `ErrorCode`**

```java
throw OrderNotEditableException.forActor(order, cmd.actor(), requiredRole);
//                              ↑ static factory 內部決定用哪個 code
```

| | |
|---|---|
| ✅ | 決定在「有完整資訊的地方」做 |
| ✅ | advice 不需要知道任何事 |
| ⚠️ | 一個例外類別有兩個 `ErrorCode` → 4.12.1 的守門測試要處理 |

**選項 ④：不要拋例外 —— 先做授權，再做狀態檢查**

```java
// ★ 授權在【進 Service 之前】就做完（09-spring-security 的 @PreAuthorize）
@PreAuthorize("hasRole('SUPPORT')")
public OrderResultView updateAsSupport(UpdateOrderCommand cmd) { ... }

@Transactional
public OrderResultView update(UpdateOrderCommand cmd) {
    // ★ 到這裡，「權限」已經是既定事實 → 只剩狀態檢查
    if (!order.status().isEditable()) {
        throw new OrderNotEditableException(order);   // 一律 409
    }
}
```

| | |
|---|---|
| ✅✅ | **「兩個狀態碼」的問題消失了** —— 因為兩個檢查在兩個不同的地方 |
| 🔴 | 需要 09-spring-security（本站還沒有） |
| 🔴 | **兩個 Service 方法** → 03 章 3.7.2 那個「客服專用套件」的延伸 |

**選項 ⑤：一律回 403**

| | |
|---|---|
| ✅ | 最簡單；而且**不洩漏訂單狀態** |
| 🔴🔴 | 客戶看到「權限不足」而他改的是自己的訂單（4.7.1 的症狀） |

### 4.7.3 為什麼「在 advice 裡看 `Actor`」是錯的 ★★

**選項 ② 有四個具體問題，而它們的嚴重程度遞增。**

**問題 1：advice 拿不到 `Actor`（在某些路徑上）**

```
Filter 拋例外 → 3.10.1 的 ErrorResponseFilter 處理，【不經過 advice】
Security 拒絕 → 3.10.2 的 handler 處理，【不經過 advice】
```

而 `currentActorHolder` 是一個 `ThreadLocal`，由 04-controller 4.13.6 的
`ActorArgumentResolver` 填 —— **它在 Controller 方法被呼叫之前才填**。
於是「Filter 階段的例外」拿到的是 `null`。

**問題 2：`@Async` 與排程拿到錯的 `Actor`（或 null）**

這與 00 章 0.14.5 的 `StatusLabelResolver` 讀 `LocaleContextHolder` 是**同一個陷阱**：

| 情境 | ThreadLocal 的值 |
|---|---|
| 正常請求 | ✅ 正確 |
| `@Async` 方法 | 🔴 **null**（新執行緒） |
| 排程 | 🔴 null |
| ⚠️ **執行緒池被重用** | 🔴🔴 **前一個請求的 `Actor`** —— 於是**客戶 A 的錯誤用客戶 B 的權限決定狀態碼** |

**問題 3：狀態碼變成「不可測試的」**

```java
@Test
void 客戶改已出貨訂單回409() {
    // ⚠️ 這個測試要怎麼寫？
    // 它必須設定 ThreadLocal，而那不是被測方法的參數 →
    // 測試變成「setUp 裡塞 ThreadLocal，忘了 tearDown 就污染下一個測試」
}
```

**問題 4（最嚴重）：狀態碼的來源從一個變成兩個**

4.3.3 花了一整節論證「狀態碼只能有一個來源（`ErrorCode.status()`）」。
選項 ② 把它變成：

```
ErrorCode.status()  ← 一個來源
advice 裡的 if      ← 第二個來源
```

**而第二個來源不在 98 個 code 的註冊表裡**，於是：

| 什麼失效 | 為什麼 |
|---|---|
| 04-controller 7.8.2 的契約測試 | 它遍歷 `ErrorCode.values()` 驗證狀態碼 —— 而這個 `if` 不在裡面 |
| API 文件產生 | `orders-api.yaml` 從 `ErrorCode` 產生「這個端點會回哪些狀態碼」 |
| 監控的告警規則 | 「403 突增」的規則抓不到「本來是 409 被改成 403」的那些 |

> 📌 **一般規則（本章第三次出現同一件事）**：
> **決定要在「資訊最完整的地方」做，而且只做一次。**
> `Actor` 在 Service 層是一個**參數**，在 advice 層是一個 **ThreadLocal** ——
> 而參數永遠比 ThreadLocal 可靠。

### 4.7.4 shop-service 的決定：選項 ③（在拋出點決定），並為選項 ④ 留路

```java
package example.shop.order.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.ActorScopedStatus;
import example.shop.common.error.marker.DomainException;
import example.shop.order.domain.Actor;
import example.shop.order.domain.OrderStatus;

import java.util.List;
import java.util.Set;

/**
 * 訂單目前不可編輯。
 *
 * <h3>★★ 這是唯一一個「一個例外、兩個 ErrorCode」的例外（4.7）</h3>
 *
 * <p>兩個 code 的分工：
 * <table>
 *   <tr><th>誰</th><th>為什麼被拒</th><th>code</th><th>狀態</th></tr>
 *   <tr><td>客戶</td><td>訂單狀態不允許</td>
 *       <td>{@code ORDER_ITEM_IMMUTABLE}</td><td>409</td></tr>
 *   <tr><td>客戶（打客服端點）</td><td>不是客服</td>
 *       <td>{@code INSUFFICIENT_ROLE}</td><td>403</td></tr>
 * </table>
 *
 * <h3>⚠️ 為什麼決定在這裡做，而不在 advice</h3>
 * <p>見 4.7.3 的四個問題。一句話：
 * <b>{@code Actor} 在這裡是參數，在 advice 裡是 ThreadLocal。</b>
 *
 * <h3>⚠️ 建構子是 private</h3>
 * <p>強迫走 {@link #forActor} 這個唯一入口 ——
 * 否則「忘記傳 Actor」會靜默地讓所有人都拿到 409。
 */
public class OrderNotEditableException extends BusinessException
        implements DomainException, ActorScopedStatus {

    /**
     * ★★ 唯一的建構入口。
     *
     * @param privilegeRequired {@code true} = 這個端點本身需要內部權限
     *                          （客服專用端點）。
     *                          ⚠️ 它是<b>業務輸入</b>而不是「HTTP 資訊」——
     *                          呼叫端傳的是「這個操作需不需要特權」，
     *                          不是「這是哪個 URL」（對照選項 ① 的問題）。
     */
    public static OrderNotEditableException forActor(
            String orderId, String orderNumber, OrderStatus current,
            Set<OrderStatus> editable, Actor actor, boolean privilegeRequired) {

        boolean lacksPrivilege = privilegeRequired && !actor.isPrivileged();

        return new OrderNotEditableException(
                lacksPrivilege ? ErrorCode.INSUFFICIENT_ROLE      // 403
                               : ErrorCode.ORDER_ITEM_IMMUTABLE,  // 409
                lacksPrivilege,
                orderId, orderNumber, current, editable, actor);
    }

    private OrderNotEditableException(ErrorCode code, boolean lacksPrivilege,
                                      String orderId, String orderNumber,
                                      OrderStatus current, Set<OrderStatus> editable,
                                      Actor actor) {
        super(code,
              lacksPrivilege
                      ? "Actor type %s cannot use the privileged edit path for order %s."
                              .formatted(actor.type(), orderNumber)
                      : "Cannot edit order %s in %s state; editable states are %s."
                              .formatted(orderNumber, current,
                                         editable.stream().map(Enum::name).sorted().toList()),
              null,
              // ⚠️⚠️ 兩個 code 的 extensions【刻意不同】—— 見下方的說明
              lacksPrivilege
                      ? ext("orderId", orderId)
                      : ext("orderId", orderId,
                            "orderNumber", orderNumber,
                            "currentStatus", current.name(),
                            "editableStatuses",
                                editable.stream().map(Enum::name).sorted().toList()),
              lacksPrivilege ? new Object[0] : new Object[]{current.name()},
              List.of());
    }
}
```

⚠️⚠️ **「兩個 code 的 `extensions` 刻意不同」是這一節最重要的細節。**

**403 的那一支只給 `orderId`，理由**：

```
客戶打客服端點，訂單是別人的（或不確定是不是自己的）
→ 回 currentStatus 就洩漏了「那張訂單目前的狀態」
→ 而他沒有權限看那張訂單
```

**409 的那一支給完整資訊，理由**：

```
客戶打自己的端點，訂單確定是自己的（findByIdVisibleTo 已經過濾了）
→ 給 currentStatus 是幫他理解「為什麼不能改」
```

> 📌 **一般規則**：
> **「例外帶什麼資料」與「回什麼狀態碼」是同一個決定的兩面。**
> 403 與 409 不只是數字不同 —— **它們能揭露的資訊量不同。**
>
> ⚠️ **而這一點是選項 ②（advice 裡看 Actor）永遠做不到的**：
> advice 拿到例外時，`extensions` 已經組好了。
> 「先組完整的，再依 Actor 刪掉一些」= **一定會漏刪一個**。

**呼叫端**：

```java
// OrderApplicationService.update()（客戶端點）
if (!order.status().isEditable()) {
    throw OrderNotEditableException.forActor(
            order.id(), order.orderNumber(), order.status(),
            OrderStatus.editableStates(), cmd.actor(),
            /* privilegeRequired */ false);            // ★ 客戶端點：不需要特權
}

// SupportOrderApplicationService.update()（客服端點，03 章 3.10.2 的 support 套件）
if (!cmd.actor().isPrivileged()) {
    throw OrderNotEditableException.forActor(
            order.id(), order.orderNumber(), order.status(),
            OrderStatus.editableStates(), cmd.actor(),
            /* privilegeRequired */ true);             // ★ 客服端點：需要特權
}
// ⚠️ 注意客服端點【沒有】狀態檢查 —— 那正是「客服可以繞過狀態限制」
```

⚠️ **`OrderStatus.editableStates()` 是本章要補的一個方法**：

```java
// 加到 OrderStatus（00 章 0.9.3）
/**
 * ★ 可編輯的狀態集合。
 *
 * <p>它存在的理由是「例外要告訴呼叫端『哪些狀態可以』」——
 * 而在此之前只有 {@code isEditable()}（單一狀態的述詞），
 * <b>沒有辦法列舉</b>。
 *
 * <p>⚠️ 用 {@code values()} 過濾而不是手寫清單 ——
 * 於是新增一個 editable 的狀態時它自動包含進來
 * （「所有需要更新的地方都在這個檔案裡」，00 章 0.9.3 的註解）。
 */
public static Set<OrderStatus> editableStates() {
    return java.util.Arrays.stream(values())
            .filter(OrderStatus::isEditable)
            .collect(java.util.stream.Collectors
                    .toCollection(() -> EnumSet.noneOf(OrderStatus.class)));
}
```

⚠️ **`Collectors.toCollection(() -> EnumSet.noneOf(...))` 而不是 `Collectors.toSet()`** ——
**而寫這一行的理由，在跑過之後被證明是錯的。值得完整看一遍。**

**當初的理由**：

> `toSet()` 回的是 `HashSet`，而 `EnumSet` 的 `toString()` 依 **enum 宣告順序**輸出，
> `HashSet` 的順序是雜湊順序（不穩定）。
> 而那個字串會進 `detail` 與 API 文件，所以順序必須穩定。

**前半段是對的**（實測）：

```
EnumSet : [PENDING_PAYMENT, PAID]      ← 宣告順序
HashSet : [PAID, PENDING_PAYMENT]      ← 雜湊順序
```

🔴 **而後半段是錯的**，因為 `OrderNotEditableException` 的兩個使用點都寫了 `.sorted()`：

```java
editable.stream().map(Enum::name).sorted().toList()
//                                ↑ 這裡把順序正規化了
```

**實測的 `detail`**：

```
Cannot edit order ORD-2026-0827-0001 in SHIPPED state;
  editable states are [PAID, PENDING_PAYMENT].
                       ↑ 字母序 —— 與 EnumSet 或 HashSet 都無關
```

✅ **所以 `EnumSet` 對「序列化的穩定性」毫無貢獻** ——
`.sorted()` 已經做完那件事了。

⚠️ **那它還該留著嗎？** 兩個理由，而它們都比原本那個弱：

| 理由 | 強度 |
|---|---|
| `EnumSet` 是 bitmask 實作，`contains` 是常數時間且無配置 | ⚠️ 弱 —— 這個集合有 2 個元素，一天被建立幾百次 |
| **除錯時直接印它比較好讀**（宣告順序 = 狀態機的順序） | ✅ 真的有用（IDE 的 watch、log 的 `warn`） |

✅ **決定：留著，但把註解改成真實的理由。**

```java
public static Set<OrderStatus> editableStates() {
    // ★ EnumSet 而不是 HashSet：只為了「直接印出來時是宣告順序」（除錯用）。
    //   ⚠️ 它與【序列化的穩定性】無關 —— 那是呼叫端的 .sorted() 在做的。
    return java.util.Arrays.stream(values())
            .filter(OrderStatus::isEditable)
            .collect(java.util.stream.Collectors
                    .toCollection(() -> EnumSet.noneOf(OrderStatus.class)));
}
```

> 📌 **這一段刻意留著完整的推翻過程，因為它是一類很常見的錯誤**：
>
> **「一個正確的技術事實」+「一個沒有驗證的因果連結」= 一個聽起來很專業的錯誤理由。**
>
> `EnumSet` 的順序穩定 ✅ 是對的。
> 「所以序列化輸出會穩定」🔴 需要「輸出直接來自這個集合」這個前提 ——
> 而它不成立。
>
> ⚠️⚠️ **而錯誤的理由比沒有理由更糟**：
> 下一個人看到那條註解，會以為「不能改成 `toSet()`，會破壞 API 輸出」——
> 於是一個真正該被討論的效能／可讀性取捨，被一個假的正確性理由鎖住了。

### 4.7.5 一般規則：狀態碼是「誰問的」的函數

**4.7 這一節可以濃縮成一句**：

> **HTTP 狀態碼不是「發生了什麼」的函數，是「誰問的 × 發生了什麼」的函數。**

**shop-service 有四組這樣的例子**，而只有一組需要 4.7.4 那個機制：

| 情況 | 客戶看到 | 客服看到 | 需要 `ActorScopedStatus` 嗎 |
|---|---|---|---|
| 訂單不存在 vs 訂單是別人的 | 404 | 404 | 🔴 **不用** —— 兩者刻意合併（01 章 1.8.3） |
| 自助取消時間窗過了 | 409 + 「聯絡客服」 | 409（**無提示**） | 🔴 **不用** —— 差別只在 `alternativeAction`（4.5.7 家族 3） |
| **訂單不可編輯** | **409** | **403**（若客戶打客服端點） | ✅ **需要** |
| `internalNote` 欄位 | 403 | ✅ 成功 | 🔴 **不用** —— 客戶根本不知道這個欄位存在（03 章 3.7.3） |

⚠️ **「只有一組需要」是一個重要的觀察**，因為它決定了「這個機制值不值得」：

| 如果需要它的情況有 | 該怎麼做 |
|---|---|
| **1 組**（現狀） | ✅ 一個 static factory + 一個標記介面 |
| 5～10 組 | ⚠️ 抽一個 `ActorScopedErrorCode` 的小框架 |
| **超過 10 組** | 🔴 **設計有問題** —— 那代表授權與業務規則糾纏在一起，該用選項 ④（授權前置） |

> 📌 **這張表本身是一個決策工具**：
> **「要不要抽象」取決於實例的數量，而數量本身也是一個設計品質的訊號。**
>
> ⚠️ 而 09-spring-security 之後，這唯一的一組**也會消失**（選項 ④）——
> 所以 `ActorScopedStatus` 這個標記介面的 javadoc 要寫上這件事，
> **否則它會在授權前置之後留下來變成殭屍**。

```java
/**
 * ★★ 標記：這個例外的 ErrorCode 取決於「誰問的」（4.7）。
 *
 * <p>⚠️⚠️ <b>這個標記預期會在 09-spring-security 之後消失。</b>
 * 屆時授權移到 {@code @PreAuthorize}（4.7.2 選項 ④），
 * 於是「權限不足」與「狀態不對」變成兩個不同位置的檢查，
 * 而這個介面就沒有實作者了。
 *
 * <p>👉 <b>如果你在 09-spring-security 之後還看到它有實作者，那是一個待辦。</b>
 * 4.12.1 有一條測試在數它的實作者數量，並在超過 1 個時失敗 ——
 * 那條測試的訊息會說明為什麼。
 */
public interface ActorScopedStatus { }
```

⚠️ **「一條測試在數實作者數量」聽起來很怪，而它解決一個真的問題**：

```
沒有它：第二個人遇到「兩個狀態碼」的情況 → 看到這個介面 →
        「哦，這是我們的做法」→ 實作它 → 第三個、第四個…
        → 十個之後沒有人記得「這本來是一個過渡方案」

有它：  第二個實作 → CI 紅燈 →
        訊息說「這是過渡方案，超過一個實例就該改用授權前置（4.7.2 選項 ④）」
```

> 📌 **一般規則**：
> **過渡方案要有一個「它變成長期方案」的警報。**
> 而最便宜的警報是「數量測試」。

---

## 4.8 例外的 i18n ★★

### 4.8.1 訊息在哪一層組出來

**四個候選位置**，而只有一個是對的：

| 位置 | 誰會這樣做 | 問題 |
|---|---|---|
| ① **例外的建構子** | 第一版都這樣 | 4.5.2 的六個問題 |
| ② **Service 層**（`messageSource.getMessage()` 後放進例外） | 「反正 Service 也能注入 `MessageSource`」 | 🔴 Service 要知道 `Locale` → 03 章 3.10.3 ② 已經否決過（`OrderQueryService` 的 `Locale` 參數被移除） |
| ③ **advice / `ProblemFactory`** ✅ | | ✅ 它是「唯一的組裝點」（04-controller 3.6.3） |
| ④ **前端**（只回 `code` + `extensions`，前端自己組文案） | 有些團隊這樣 | ⚠️ 見下 |

**選 ③**（04-controller 已經這樣做了）。而 ④ 值得認真討論一下，因為它不是壞主意：

| ④ 的優點 | ④ 的代價 |
|---|---|
| 文案完全由前端控制，改文案不用動後端 | 🔴🔴 **每一個客戶端都要實作 98 個 code 的文案** —— App（iOS/Android）、後台、客服系統、合作商 |
| 文案可以依畫面情境不同（結帳頁 vs 訂單頁） | 🔴 **漏一個 code → 使用者看到 `ORDER_NOT_SHIPPABLE`** |
| 沒有 i18n 的伺服器端成本 | 🔴 後端無法在 email／簡訊裡重用同一份文案 |

✅ **shop-service 的決定：③ 為主，但 `code` + `extensions` 一律完整提供，讓 ④ 成為可能。**

> 📌 **這是一個「兩者都給」而不是「二選一」的情況**：
> `userMessage` 讓「什麼都不做的客戶端」有一句可以顯示的話，
> `code` + `extensions` 讓「想自己組文案的客戶端」有材料。
> ⚠️ 而它的代價是**後端要維護 98 × 2 行文案**，即使某些客戶端不用它。

### 4.8.2 `userMessageArgs` 的順序契約 ★★

**這是本章最容易出錯、最難發現的一節。**

`ProblemFactory` 用 `MessageSource` 解析訊息（04-controller 3.6.3），
而 Spring 的 `MessageSource` 底層是 `java.text.MessageFormat`。

**於是「例外傳的參數」與「properties 裡的 `{0}` `{1}`」形成一個契約** ——
**而那個契約沒有任何型別在守它。**

```java
// 例外
new Object[]{productName, available}          // {0} = 商品名, {1} = 剩餘數

// properties
error.INSUFFICIENT_STOCK.user=「{0}」僅剩 {1} 件，請調整數量後再結帳。
```

⚠️⚠️ **契約被違反時 `MessageFormat` 的行為，全部實測過**
（Java 21，`Locale.TAIWAN`）：

| 情況 | 輸出 | 有例外嗎 |
|---|---|---|
| ✅ 正常（給 2 個） | `「耳機」僅剩 3 件，請調整數量後再結帳。` | — |
| 🔴 **參數不足**（只給 1 個） | **`「耳機」僅剩 {1} 件，請調整數量後再結帳。`** | ❌ **沒有** |
| ⚠️ 參數多（給 3 個） | `「耳機」僅剩 3 件，請調整數量後再結帳。` | ❌ 沒有（靜默忽略） |
| 🔴 **完全沒給** | **`「{0}」僅剩 {1} 件，請調整數量後再結帳。`** | ❌ 沒有 |
| 🔴🔴 **順序顛倒** | **`「3」僅剩 耳機 件，請調整數量後再結帳。`** | ❌ 沒有 |

**三個 🔴 都是「使用者看到壞掉的訊息，而沒有任何錯誤被記錄」。**

⚠️ **「順序顛倒」是最惡毒的**，因為：

| 為什麼難發現 | 說明 |
|---|---|
| 訊息**看起來完整**（沒有 `{0}`） | 只有讀懂中文的人會覺得奇怪 |
| 測試通常斷言「有訊息」而不是「訊息正確」 | `assertThat(problem.userMessage()).isNotBlank()` ✅ 通過 |
| 只有在**那個特定的錯誤發生時**才會出現 | 而業務例外的觸發率通常 < 0.1% |

**04-controller 3.4.5 有一個 `訊息參數一致()` 測試**，而它守的是
「properties 裡的 `{n}` 個數」與「拋出點傳的參數個數」是否相同 ——
**它抓得到「參數不足」，抓不到「順序顛倒」。**

**本章補上第二條**（4.12.2 有完整版）：

```java
/**
 * ★★ 每個 code 的 userMessage 解析後不含字面的「{數字}」。
 *
 * <p>它抓「參數不足」與「完全沒給」——
 * ⚠️ 但抓不到「順序顛倒」（4.8.2）。那需要人看，或需要 4.8.3 的型別化。
 */
@ParameterizedTest
@MethodSource("everyBusinessExceptionInstance")
void 解析後的訊息不含未替換的佔位符(BusinessException ex) {
    String rendered = messageSource.getMessage(
            ex.errorCode().userMessageKey(), ex.userMessageArgs(),
            "MISSING", Locale.TAIWAN);

    assertThat(rendered)
            .as("%s 的 userMessage 有未替換的佔位符 —— 參數個數不對（4.8.2）",
                ex.getClass().getSimpleName())
            .doesNotMatch(".*\\{\\d+.*");
}
```

⚠️ **`\\{\\d+` 而不是 `\\{\\d+\\}`**：
`{0,date,yyyy/MM/dd}` 這種帶格式的佔位符沒有緊接的 `}`。

### 4.8.3 🔴 `Instant` 與 `LocalDate` 當參數是一個真的 bug

**本章 4.5.7 定義的例外裡，有五個把時間物件直接放進 `userMessageArgs`。**
⚠️ **實測結果**（Java 21）：

| 傳什麼 | pattern | 輸出 |
|---|---|---|
| `Instant` | `已於 {0} 開立` | 🔴 **`已於 2026-08-27T08:00:00Z 開立`** |
| `Instant` | `已於 {0,date,yyyy/MM/dd} 開立` | 🔴🔴 **`IllegalArgumentException: Cannot format given Object as a Date`** |
| `LocalDate` | `期限至 {0}` | ⚠️ `期限至 2026-09-03` |
| `LocalDate` | `期限至 {0,date,yyyy/MM/dd}` | 🔴🔴 **同樣拋例外** |
| `java.util.Date` | `已於 {0,date,yyyy/MM/dd} 開立` | ✅ `已於 2026/08/27 開立` |
| **預先格式化的 `String`** | `已於 {0} 開立` | ✅ **`已於 2026/08/27 16:00 開立`** |

**兩個結論**：

1. **`MessageFormat` 只認得 `java.util.Date`**，不認得 `java.time` 的任何型別
   （`MessageFormat` 是 JDK 1.1 的 API，早於 `java.time` 十七年）。
2. **裸給 `Instant` 不會拋例外** —— 它走 `toString()`，
   於是**使用者看到 `2026-08-27T08:00:00Z`**。

⚠️⚠️ **第 2 點是「靜默出錯」的完美例子**，而且它有第二層問題：

```
2026-08-27T08:00:00Z  ← UTC
台灣的使用者看到的是 08:00，而實際是台灣時間 16:00
→ 客戶說「我明明是下午才開的發票，為什麼寫早上八點」
```

**時區錯了 8 小時，而沒有任何錯誤。**

#### 修法：`userMessageArgs` 只放「已經可以直接顯示的東西」

**規則**：

> **`userMessageArgs` 的每一個元素必須是 `String`、`Integer`／`Long`，
> 或 `BigDecimal`。時間一律預先格式化成 `String`。**

⚠️ **而「預先格式化」需要一個時區與一個格式，而它們是展示層的決定** ——
於是我們遇到 03 章 3.10.3 ② 的同一個問題：**Domain 不該認識展示層。**

**三個選項**：

| 選項 | 做法 | 取捨 |
|---|---|---|
| ① 例外收一個 `ZoneId` 與 `DateTimeFormatter` | 🔴🔴 Domain 認識展示層（03 章 3.10.3 ② 明確否決） | |
| ② 例外傳 `java.util.Date`，properties 用 `{0,date,...}` | ⚠️ 可行，`MessageFormat` 會用 `Locale` 的時區（**預設時區**，不是使用者的） | |
| ③ ✅ **例外傳 `Instant`，但放進 `extensions` 而不是 `userMessageArgs`；`userMessage` 不提時間** | 文案改成不需要時間的說法 | |
| ④ ✅ **`ProblemFactory` 負責把 `java.time` 的參數格式化** | 它已經是「唯一的組裝點」，也已經有 `Locale` | |

✅ **選 ④**，並在 `ProblemFactory` 加一個轉換步驟：

```java
// 加到 ProblemFactory（04-controller 3.6.3）

/** 訊息參數裡的時間要用哪個時區顯示。從設定讀。 */
private final ZoneId displayZone;      // ApiProblemProperties 新增 display-zone

/**
 * ★★ 把 java.time 的參數轉成「可以直接塞進 MessageFormat 的東西」。
 *
 * <p>存在的理由（4.8.3）：{@link java.text.MessageFormat} 是 JDK 1.1 的 API，
 * 它<b>只認得 {@link java.util.Date}</b>。
 * 裸給 {@code Instant} 不會拋例外 —— 它走 {@code toString()}，
 * 於是使用者看到 {@code 2026-08-27T08:00:00Z}（而且是 UTC）。
 *
 * <p>⚠️ 為什麼不轉成 {@code java.util.Date} 讓 properties 用
 * {@code {0,date,...}}：那會讓「格式」散到 98 個 properties 條目裡，
 * 而其中大部分作者不知道 {@code MessageFormat} 的 date 語法。
 * <b>轉成已格式化的 String，格式就只有這裡一份。</b>
 */
private Object[] normalizeArgs(Object[] args, Locale locale) {
    if (args == null || args.length == 0) { return new Object[0]; }
    Object[] out = new Object[args.length];
    for (int i = 0; i < args.length; i++) {
        out[i] = normalizeArg(args[i], locale);
    }
    return out;
}

private Object normalizeArg(Object arg, Locale locale) {
    if (arg instanceof Instant instant) {
        return DATE_TIME.withLocale(locale).format(instant.atZone(displayZone));
    }
    if (arg instanceof LocalDate date) {
        return DATE.withLocale(locale).format(date);
    }
    if (arg instanceof LocalDateTime dateTime) {
        return DATE_TIME.withLocale(locale).format(dateTime);
    }
    if (arg instanceof Duration duration) {
        // ⚠️ 「多久」的自然說法依長度而異（30 分鐘 / 2 小時 / 3 天）
        return humanizeDuration(duration, locale);
    }
    if (arg instanceof Money money) {
        // ★ 與 03 章 3.8.4 一致：金額是字串，不做千分位（幣別符號由文案帶）
        return money.toPlainString();
    }
    if (arg instanceof Enum<?> e) {
        // ⚠️ 4.8.4：enum 要變成中文標籤，而那需要 StatusLabelResolver
        return labels.label(e, locale);
    }
    return arg;         // String / Integer / Long / BigDecimal 原樣
}

private static final DateTimeFormatter DATE_TIME =
        DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm");
private static final DateTimeFormatter DATE =
        DateTimeFormatter.ofPattern("yyyy/MM/dd");
```

**然後 `build()` 裡插一行**：

```java
        Object[] args = code.isServerError() && userMessageArgs.length == 0
                ? new Object[]{shortTraceId(traceId)}
                : normalizeArgs(userMessageArgs, locale);       // ★ 這裡
```

⚠️ **`humanizeDuration` 值得單獨看，因為它修一個實測到的問題**：

```
new Object[]{window.toMinutes()}  →  "1,440 分鐘內可取消"
                                       ↑ 實測輸出，一天被說成 1,440 分鐘
```

**而 `1,440` 那個千分位是 `MessageFormat` 自己加的**（實測：
`{0}` 收到 `Long` 時走 `NumberFormat.getInstance(locale)`）。

```java
/**
 * ★ 把 Duration 說成人話。
 *
 * <p>⚠️ 它不是「完整的 i18n duration 格式化」——
 * 那需要 ICU4J 或 {@code java.time.format} 的 pattern，
 * 而 shop-service 只有三個級距（分／時／天）。
 *
 * <p>⚠️⚠️ 而它<b>回傳含單位的字串</b>，
 * 於是 properties 的文案不可以再寫「分鐘」：
 * <pre>
 * 🔴 error.SELF_CANCEL_WINDOW_EXPIRED.user=下單後 {0} 分鐘內才能自行取消
 * ✅ error.SELF_CANCEL_WINDOW_EXPIRED.user=下單後 {0} 內才能自行取消
 * </pre>
 * <b>這是一個文案與程式碼的隱含契約</b>，而 4.12.2 沒有測試在守它。
 * 👉 記進 4.16 的驗收清單。
 */
private String humanizeDuration(Duration d, Locale locale) {
    long minutes = d.toMinutes();
    if (minutes < 60)      { return minutes + " 分鐘"; }
    if (minutes % 1440 == 0) { return (minutes / 1440) + " 天"; }
    if (minutes % 60 == 0)   { return (minutes / 60) + " 小時"; }
    return (minutes / 60) + " 小時 " + (minutes % 60) + " 分鐘";
}
```

⚠️ **這個方法有一個誠實的缺陷：它寫死了中文。**
`locale` 參數收了但沒用。

| 選項 | 取捨 |
|---|---|
| ① 拿掉 `locale` 參數 | ✅ 誠實。🔴 但加日文站時要改簽章（一個跨檔案的改動） |
| ② 保留參數但不用 | 🔴 **一個「看起來支援 i18n 但其實不支援」的 API** —— 比①更糟 |
| ③ ✅ **保留參數，並把單位也走 i18n** | `messageSource.getMessage("duration.minutes", ...)` |

✅ **選 ③**：

```java
private String humanizeDuration(Duration d, Locale locale) {
    long minutes = d.toMinutes();
    if (minutes < 60) {
        return unit("duration.minutes", minutes, locale);
    }
    if (minutes % 1440 == 0) {
        return unit("duration.days", minutes / 1440, locale);
    }
    if (minutes % 60 == 0) {
        return unit("duration.hours", minutes / 60, locale);
    }
    return unit("duration.hours", minutes / 60, locale)
            + unit("duration.minutes", minutes % 60, locale);
}

private String unit(String key, long value, Locale locale) {
    // ★ 值用 String.valueOf 傳，避免 MessageFormat 的千分位（4.8.3 實測）
    return message(key, new Object[]{String.valueOf(value)}, value + "", locale);
}
```

```properties
# error-messages_zh_TW.properties
duration.minutes={0} 分鐘
duration.hours={0} 小時
duration.days={0} 天
```

> 📌 **`String.valueOf(value)` 那一行是這一節最實用的一個小技巧**：
> **`MessageFormat` 對 `Number` 會套 locale 的數字格式（含千分位），對 `String` 不會。**
> 於是「要千分位」與「不要千分位」的控制點是**參數的型別**，
> 而不是 properties 的 pattern。
>
> | 想要 | 傳什麼 |
> |---|---|
> | `共 1,234,567 元` | `Integer` / `Long` ✅ |
> | `訂單 1234567 號` | **`String.valueOf(...)`** ✅ |
> | `備註最多 2,000 個字` | `Integer`（⚠️ 這個千分位其實是好的） |
> | `已用 3 次` | 兩者皆可（小數字沒有差別）|

#### 五個例外要跟著改

| 例外 | 原本傳 | 改成 |
|---|---|---|
| `InvoiceAlreadyIssuedException` | `new Object[]{issuedAt}`（`Instant`） | ✅ **不用改** —— `ProblemFactory.normalizeArg` 接手了 |
| `CouponExpiredException` | `new Object[]{expiredAt}`（`Instant`） | ✅ 不用改 |
| `CouponNotStartedException` | `new Object[]{startsAt}`（`Instant`） | ✅ 不用改 |
| `ReturnWindowExpiredException` | `{windowDays, expiredOn}` | ✅ 不用改 |
| `SelfCancelWindowExpiredException` | `new Object[]{window.toMinutes()}` | 🔴 **改成 `new Object[]{window}`** |
| `AddressChangeLimitExceededException` | `{limit, windowResetsAt}` | ✅ 不用改 |

⚠️ **只有一個要改，而那正是「把轉換放在 `ProblemFactory`」的價值**：

```java
// SelfCancelWindowExpiredException
// 🔴 原本：自己做了轉換（.toMinutes()），而那個轉換是錯的（1,440 分鐘）
new Object[]{window.toMinutes()}

// ✅ 改成：把原始型別交出去，讓唯一的組裝點決定怎麼顯示
new Object[]{window}
```

> 📌 **一般規則（本章第四次出現）**：
> **不要在「資訊不足的地方」做轉換。**
> 例外不知道 `Locale`、不知道時區、不知道文案要不要千分位 ——
> 所以它應該**交出原始型別**，而不是猜一個格式。
>
> ⚠️ **而這條規則與 4.5.3 規則 1（`extensions` 只放 JSON 原生型別）看起來矛盾。**
> 它不矛盾，因為兩者的消費者不同：
>
> | | 消費者 | 該放什麼 |
> |---|---|---|
> | `extensions` | **前端程式** | JSON 原生型別（機器讀，ISO-8601 是對的） |
> | `userMessageArgs` | **`MessageFormat`** | 原始型別，由 `ProblemFactory` 格式化（人讀） |

### 4.8.4 enum 進參數的陷阱：狀態標籤 ★

**4.5.7 家族 1 的 `OrderStateException` 傳的是 `current.name()`**：

```java
new Object[]{current.name()}        // "SHIPPED"
```

**於是使用者看到**：

```
此訂單目前的狀態（SHIPPED）無法出貨。
```

⚠️ **而 04-controller 3.4.4 的 properties 註解明確寫著**：

```properties
# ⚠️ {0} 是【中文的狀態標籤】而不是 enum 名（見 3.11.4 的說明）
error.ORDER_NOT_SHIPPABLE.user=此訂單目前的狀態（{0}）無法出貨。
```

**所以 4.5.7 家族 1 那一行違反了一個已經寫下來的契約。**

**三個修法**：

| 修法 | 問題 |
|---|---|
| ① 例外傳 `current.label()` | 🔴 **`OrderStatus` 沒有 `label()`**（00 章 0.14.1 已經處理過這件事） |
| ② 例外注入 `StatusLabelResolver` | 🔴🔴 Domain 認識展示層；而且例外**不是 Spring bean**，注入不了 |
| ③ ✅ **例外傳 enum 本身，`ProblemFactory` 解析標籤** | 與 4.8.3 的 `Instant` 完全同一個模式 |

✅ **選 ③**（而 4.8.3 的 `normalizeArg` 已經寫好了那個分支）：

```java
    if (arg instanceof Enum<?> e) {
        return labels.label(e, locale);         // ★ StatusLabelResolver（00 章 0.14.5）
    }
```

**於是家族 1 的那一行改成**：

```java
// 🔴 原本
new Object[]{current.name()}

// ✅ 改成
new Object[]{current}
```

⚠️ **注意 `StatusLabelResolver.label(Enum<?>, Locale)` 這個多載是 00 章 0.14.5 新增的**，
理由正是「不要讀 `LocaleContextHolder`（ThreadLocal）」——
而 `ProblemFactory` 已經有一個 `locale` 區域變數（從 `LocaleContextHolder` 讀一次），
所以它是「讀一次、往下傳」而不是「每個元件各自讀」。

> 📌 **這是 00 章 0.14.5 那個修正在本章的第一個實際用途。**
> 那一節當時的理由是「排程與 `@Async` 會拿到錯的語言」——
> 而**這裡是一個更常見的場景**：
> `ProblemFactory` 在 advice 裡跑，它**確實**在請求執行緒上，
> ⚠️ **但「讀一次往下傳」讓這段程式碼在「非請求執行緒」上也是對的**
> （例如 06 章的 outbox 要把失敗原因寫成 email）。

⚠️⚠️ **而 `normalizeArg` 的 enum 分支有一個危險**：

```java
if (arg instanceof Enum<?> e) { return labels.label(e, locale); }
```

**它會攔截「所有」enum**，包括我們**不想**變成標籤的：

```java
new Object[]{actor.type()}      // ActorType.CUSTOMER → 「客戶」？
```

**`ActorType` 有 `labelKey()` 嗎？** —— **沒有**（它沒有實作 `LabeledEnum`）。
於是 `StatusLabelResolver` 會走 fallback（04-controller 6.5.8 的
`LabeledEnum.defaultKeyFor`），輸出可能是 `actorType.CUSTOMER` 這個 **key 本身**。

✅ **修法：只攔截 `LabeledEnum`**：

```java
    // ★ 只有明確實作 LabeledEnum 的才轉標籤 ——
    //   其餘 enum 走 toString()（= name()），那是可預測的
    if (arg instanceof LabeledEnum le) {
        return labels.label((Enum<?>) le, locale);
    }
```

> 📌 **一般規則**：
> **`instanceof` 的攔截範圍要用「明確宣告的能力」，不要用「語言層的分類」。**
> `Enum<?>` 是語言分類（所有 enum），`LabeledEnum` 是宣告的能力（「我有中文標籤」）。

### 4.8.5 單引號會被吃掉 ⚠️

**實測**：

| pattern | 輸出 |
|---|---|
| `客戶'的'訂單 {0}` | 🔴 **`客戶的訂單 X`** |
| `客戶''的''訂單 {0}` | ✅ `客戶'的'訂單 X` |

`MessageFormat` 用單引號做**逸出**，所以文案裡的單引號要寫兩個。

⚠️ **這在中文文案裡很少遇到**（我們用「」），
**但在英文文案裡是常態**：

```properties
# 🔴 en 的文案
error.ORDER_NOT_SHIPPABLE.user=This order can't be shipped in {0} state.
#                                                ↑ 這個 ' 會讓後面的 {0} 【不被替換】

# ✅
error.ORDER_NOT_SHIPPABLE.user=This order can''t be shipped in {0} state.
```

**而它的失敗形狀是「`{0}` 原樣輸出」** ——
✅ **4.8.2 那條測試抓得到它**（它找字面的 `{數字}`）。

> 📌 **這是本章少數「已經有測試在守」的陷阱**，
> 而值得注意的是：那條測試是為了「參數個數不對」寫的，
> **它順便抓到了一個完全不同的 bug。**
>
> 📌 **一般規則**：
> **好的守門測試斷言「結果的性質」而不是「原因」** ——
> 「解析後不該有 `{n}`」比「參數個數要相符」涵蓋更廣。

### 4.8.6 新增一個 code 要動四個地方

**這是 00 章 0.12 ⑮ 最後那個 📌 的完整版**：

| # | 動什麼 | 誰守它 |
|---|---|---|
| 1 | `ErrorCode` 加一個常數（**放進它的狀態碼分區**） | 4.2.3 的 `ErrorCodeLayoutTest` |
| 2 | `error-messages_zh_TW.properties` 加 `title` 與 `user` 兩行 | 04-controller 3.4.5 的 `訊息完整()` |
| 3 | 一個 `BusinessException` 子類別（或說明為什麼不需要） | **本章 4.12.1** |
| 4 | `orders-api.yaml` 的錯誤清單 | 04-controller 7.10.2 的契約測試 |

⚠️ **而本章新增第 5 個**：

| # | 動什麼 | 誰守它 |
|---|---|---|
| **5** | **如果是 422 → 至少一筆 `errors[]`** | **本章 4.6.2 的測試** |

**五個地方，四個有測試守。** 第 4 個（API 文件）只在 04-controller 07 章有 ——
本站沒有跑那個契約測試，所以**它是一個已知的缺口**（4.16）。

### 4.8.7 把整條管線跑一次 ★★

**4.8 這一節做了五個設計決定**，而它們全部建立在
「`MessageFormat` 的行為」與「`ProblemFactory` 的轉換」上。
**把它們接起來跑一次，是唯一能確認「這五個決定加起來真的有效」的方法。**

```java
package example.shop.common.web;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.i18n.LocaleContextHolder;
import org.springframework.context.support.ResourceBundleMessageSource;

import java.time.*;
import java.util.Locale;

/**
 * ★★ 整條 i18n 管線的實測：例外 → normalizeArgs → MessageFormat → userMessage。
 *
 * <p>⚠️ 它<b>不是</b>一個斷言測試 —— 它把六種參數型別的實際輸出印出來。
 * 理由與 4.2.3 的第三條測試相同：
 * <b>「這句中文讀起來對不對」是人的判斷，不是機械規則。</b>
 * 而這份輸出讓那個判斷變成「看一眼 CI log」而不是「上線後等客訴」。
 */
class ProblemFactoryI18nTest {

    private ProblemFactory factory;

    @BeforeEach
    void setUp() {
        var ms = new ResourceBundleMessageSource();
        ms.setBasename("error-messages");
        ms.setDefaultEncoding("UTF-8");            // ⚠️ 少了這行中文會變亂碼
        var labels = new StatusLabelResolver(ms);
        factory = new ProblemFactory(
                new ApiProblemProperties("https://api.shop.example/problems",
                                         ZoneId.of("Asia/Taipei")),
                ms, labels, Clock.systemUTC());
        LocaleContextHolder.setLocale(Locale.TAIWAN);
    }

    private void show(String label, BusinessException ex) {
        Problem p = factory.from(ex, "/api/orders/ORD-1");
        System.out.printf("%-24s | %s%n", label, p.userMessage());
    }

    @Test
    void 六種參數型別的實際輸出() {
        show("Instant 發票已開立",
             new InvoiceAlreadyIssuedException("ORD-1",
                     Instant.parse("2026-08-27T08:00:00Z")));

        show("Duration 30 分鐘",
             new SelfCancelWindowExpiredException("ORD-1", "ORD-2026-0827-0001",
                     Instant.parse("2026-08-27T08:00:00Z"), Duration.ofMinutes(30),
                     new Actor(Actor.ActorType.CUSTOMER, "cus_1", "客戶")));

        show("Duration 1440 分鐘",
             new SelfCancelWindowExpiredException("ORD-1", "ORD-2026-0827-0001",
                     Instant.parse("2026-08-27T08:00:00Z"), Duration.ofMinutes(1440),
                     new Actor(Actor.ActorType.CUSTOMER, "cus_1", "客戶")));

        show("LabeledEnum 狀態",
             new OrderNotShippableException("ORD-1", "ORD-2026-0827-0001",
                     OrderStatus.SHIPPED, OrderStatus.editableStates()));

        show("Integer 備註長度",
             new NoteTooLongException("ORD-1", "internalNote", 3417, 2000));

        show("Money 差額",
             CouponMinAmountNotMetException.of("SUMMER10",
                     Money.twd("1500"), Money.twd("1180")));
    }
}
```

#### 🔴 第一次跑：兩個修正沒有被套用

```
Instant 發票已開立         | 此訂單的發票已於 2026/08/27 16:00 開立，如需更改請聯絡客服。
Duration 30 分鐘          | 下單後 30 內才能自行取消，請聯絡客服協助。
Duration 1440 分鐘        | 下單後 1,440 內才能自行取消，請聯絡客服協助。
LabeledEnum 狀態          | 此訂單目前的狀態（SHIPPED）無法出貨。
Integer 備註長度           | 備註最多 2,000 個字，目前是 3,417 個字，請縮短後再送出。
Money 差額                | 還差 320.00 元才能使用這張折扣碼。
```

⚠️⚠️ **三個問題，而它們全部是「課程說要改但程式碼沒改」**：

| 輸出 | 為什麼 |
|---|---|
| 🔴 `下單後 30 內` | `SelfCancelWindowExpiredException` 還在傳 `window.toMinutes()`（`Long`）→ `normalizeArg` 直接放行 → 而 properties 的文案假設「單位由 `humanizeDuration` 帶」→ **單位消失** |
| 🔴 `下單後 1,440 內` | 同上，加上 `MessageFormat` 給 `Long` 加了千分位（4.8.3 實測） |
| 🔴 `狀態（SHIPPED）` | `OrderStateException` 還在傳 `current.name()`（`String`）→ `normalizeArg` 放行 → **標籤沒被解析** |

> 📌 **這一次的價值不在「找到 bug」，在於它證明了一件事**：
> **4.8.3 與 4.8.4 那兩個「只改一行」的修正，是真的必要的。**
> 沒有跑之前，「傳 `toMinutes()` 還是傳 `Duration`」看起來像風格偏好。
>
> ⚠️ **而更重要的是它們的失敗方式**：
> `下單後 30 內才能自行取消` 這句話 **編譯得過、測試不紅、格式正常**，
> 只有讀中文的人會覺得怪。
> **這就是為什麼這個測試「印出來」而不是「斷言」。**

#### ✅ 套用兩個修正之後

```java
// SelfCancelWindowExpiredException
- new Object[]{window.toMinutes()},
+ new Object[]{window},

// OrderStateException
- new Object[]{current.name()},
+ new Object[]{current},
```

```
Instant 發票已開立         | 此訂單的發票已於 2026/08/27 16:00 開立，如需更改請聯絡客服。
Duration 30 分鐘          | 下單後 30 分鐘 內才能自行取消，請聯絡客服協助。
Duration 1440 分鐘        | 下單後 1 天 內才能自行取消，請聯絡客服協助。
LabeledEnum 狀態          | 此訂單目前的狀態（已出貨）無法出貨。
Integer 備註長度           | 備註最多 2,000 個字，目前是 3,417 個字，請縮短後再送出。
Money 差額                | 還差 320.00 元才能使用這張折扣碼。
```

⚠️ **還剩一個空白問題**：`30 分鐘 內` 中間多一個空格。

**來源**：`humanizeDuration` 回 `"30 分鐘"`，而 pattern 是 `下單後 {0} 內`。

```properties
# 🔴
error.SELF_CANCEL_WINDOW_EXPIRED.user=下單後 {0} 內才能自行取消，請聯絡客服協助。
# ✅
error.SELF_CANCEL_WINDOW_EXPIRED.user=下單後 {0}內才能自行取消，請聯絡客服協助。
```

```
Duration 30 分鐘          | 下單後 30 分鐘內才能自行取消，請聯絡客服協助。
Duration 1440 分鐘        | 下單後 1 天內才能自行取消，請聯絡客服協助。
```

> 📌 **這個空白問題是 4.8.3 那個「隱含契約」的具體代價**：
> `humanizeDuration` **回傳含單位的字串**，
> 於是**文案的作者必須知道這件事**（不要自己寫單位、不要在 `{0}` 後面留空格）。
> 而**沒有任何測試在守它** —— 只有這份輸出。

#### 🔴 `320.00 元` 的真正原因，以及第四個同型 bug

**`Money.twd("1500").minus(Money.twd("1180")).toPlainString()` = `"320.00"`** ——
所以先做的假設是「`Money` 的小數位問題」。

⚠️ **套用 `normalizeArg` 的 `Money` 分支之後，輸出還是 `320.00 元`。**

**因為 `normalizeArg` 根本沒被呼叫** ——
`CouponMinAmountNotMetException` 傳的是：

```java
new Object[]{shortfall.toPlainString()}      // ← 🔴 已經是 String 了
```

**這是 4.8.3（`Duration`）與 4.8.4（enum）之後的第三個同型 bug**，
而它讓我去掃了一次整個專案：

```bash
grep -rn "new Object\[\]{.*toPlainString" src/main/java
```

```
order/application/exception/OrderAmountMismatchException.java:19
payment/domain/exception/RefundExceedsPaymentException.java:28
payment/domain/exception/RefundRejectedException.java:27
```

🔴 **四個例外犯了同一個錯**，而它們是我在 4.5.7 一個一個寫出來的
—— **在寫下 4.8.3 那條規則之前**。

> 📌 **這是「規則寫在使用之後」的典型後果**：
> 4.5.7（定義 32 個例外）在 4.8.3（訂出參數規則）**之前**，
> 於是前者的每一個實例都用了「當時看起來最自然的做法」——
> **把東西轉成字串再交出去。**

#### 那要怎麼守住它

**第一個嘗試：ArchUnit。**

```java
@Test
void 業務例外不可自己格式化Money() {
    noClasses()
            .that().areAssignableTo(BusinessException.class)
            .should().callMethod(Money.class, "toPlainString")
            .check(CLASSES);
}
```

**實測結果**：

```
Rule 'no classes that are assignable to BusinessException
      should call method Money.toPlainString()' was violated (20 times):
  CouponMinAmountNotMetException.<init> calls Money.toPlainString() (line 22)
  CouponMinAmountNotMetException.<init> calls Money.toPlainString() (line 23)
  ...（共 20 條）
```

🔴 **20 個違反，而其中 17 個是對的。**

**為什麼**：`toPlainString()` 有三個正當用途，而只有一個是錯的：

| 用在哪 | 該用 `toPlainString()` 嗎 | 為什麼 |
|---|---|---|
| `extensions` | ✅ **必須** | 4.5.3 規則 2（金額一律 `String`） |
| `detail` | ✅ 必須 | 它是給開發者的英文字串 |
| **`userMessageArgs`** | 🔴 **不可以** | 4.8.3 |

⚠️⚠️ **ArchUnit 表達不出這條規則**，因為它的粒度是
「這個類別有沒有呼叫那個方法」，而我們要說的是
**「不可以在這個參數位置呼叫它」**。

> 📌 **這是一個關於工具邊界的重要觀察**：
> **ArchUnit 看得到「呼叫關係」，看不到「資料流」。**
> 需要資料流的規則要換工具（Error Prone / NullAway 這類 AST 層的），
> 或者 —— **換成執行期檢查**。

**第二個嘗試：在 `BusinessException` 加一個守門的工廠。** ✅

```java
// 加到 BusinessException（04-controller 3.5.2）

/**
 * ★★ 04 章 4.8.7：userMessageArgs 的守門人。
 *
 * <p>它擋的是一個實測到的錯誤：例外<b>自己</b>把 {@code Money} / {@code Instant}
 * 轉成字串，於是 {@code ProblemFactory.normalizeArg} 的格式化（時區、單位、
 * 小數位）全部失效 —— 而失敗方式是「訊息看起來正常但內容怪」。
 *
 * <p>⚠️ 為什麼不用 ArchUnit：那條規則要說的是
 * 「不可以在<b>這個參數位置</b>呼叫 toPlainString()」，
 * 而 ArchUnit 的粒度是「有沒有呼叫這個方法」——
 * 實測寫出來會有 <b>20 個違反，其中 17 個是對的</b>。
 *
 * <p>⚠️⚠️ 它是一個<b>啟發式</b>檢查，不是完備的。
 * 它擋得住 {@code "320.00"} 與 {@code "2026-08-27T08:00:00Z"}，
 * 擋不住 {@code "已於 2026 年開立"} 與 {@code "NT$320"}。
 */
protected static Object[] args(Object... values) {
    if (values == null) { return new Object[0]; }
    for (int i = 0; i < values.length; i++) {
        if (values[i] instanceof String str && PREFORMATTED.matcher(str).matches()) {
            throw new IllegalArgumentException(
                    ("userMessageArgs[%d] = \"%s\" 看起來是預先格式化的數字或時間。"
                     + "請交出原始型別（Money / Instant / LocalDate / Duration / Integer），"
                     + "由 ProblemFactory.normalizeArg 格式化（04 章 4.8.3）。")
                            .formatted(i, str));
        }
    }
    return values;
}

/** 純數字（含小數）、ISO-8601 日期或時間戳。 */
private static final java.util.regex.Pattern PREFORMATTED =
        java.util.regex.Pattern.compile(
                "-?\\d+(\\.\\d+)?"                     // 320 / 320.00 / -5
              + "|\\d{4}-\\d{2}-\\d{2}([T ].*)?");     // 2026-08-27[T08:00:00Z]
```

**於是 32 個例外的最後一個參數從 `new Object[]{...}` 改成 `args(...)`**：

```java
// 之前
new Object[]{maxLength, actualLength},

// 之後
args(maxLength, actualLength),
```

⚠️ **這個守門人在「例外被建立時」就炸，而那有一個代價**：

```
一個 422 的業務失敗 → 例外建構子拋 IllegalArgumentException
→ 原本的業務例外【消失】→ 客戶端看到 500
```

🔴 **它把一個 422 變成 500。** 這值得嗎？

| 論點 | |
|---|---|
| ✅ **值得** | 4.12 的 fixture 測試會實例化**每一個**例外 → **它在 CI 就炸，不會上線** |
| ✅ 值得 | 而如果真的漏到生產，500 + 完整 stack trace 比「使用者看到 `320.00 元`」更容易被發現 |
| ⚠️ 但要注意 | 這是「fail fast」的標準取捨，而它成立的**前提是那個 fixture 測試存在** |

**實測的守門行為**：

```java
@Test
void 擋掉預先格式化的金額與時間() {
    assertThatThrownBy(() -> new Probe("320.00"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("看起來是預先格式化的數字或時間");
    assertThatThrownBy(() -> new Probe("2026-08-27T08:00:00Z")).isInstanceOf(...);
}

@Test
void 放行原始型別與正常字串() {
    assertThatCode(() -> new Probe(Money.twd("320"))).doesNotThrowAnyException();
    assertThatCode(() -> new Probe(Instant.now())).doesNotThrowAnyException();
    assertThatCode(() -> new Probe(2000, 3417)).doesNotThrowAnyException();
    assertThatCode(() -> new Probe("無線降噪耳機 Pro")).doesNotThrowAnyException();
    assertThatCode(() -> new Probe("SUMMER10")).doesNotThrowAnyException();
    assertThatCode(() -> new Probe("ORD-2026-0827-0001")).doesNotThrowAnyException();
}

@Test
void 擋不住的情況_誠實記錄() {
    // ⚠️ 啟發式的邊界，寫成測試讓它有名字
    assertThatCode(() -> new Probe("已於 2026 年開立")).doesNotThrowAnyException();
    assertThatCode(() -> new Probe("NT$320")).doesNotThrowAnyException();
}
```

✅ **三個測試全部通過**（`ORD-2026-0827-0001` 不會被誤擋 ——
它有 `ORD-` 前綴，不符合 `\d{4}-\d{2}-\d{2}` 的 `matches()`）。

⚠️ **`matches()` 而不是 `find()` 是關鍵**：
`find()` 會讓 `"訂單 2026-08-27 的問題"` 被擋掉，而那是一個正當的字串。

> 📌 **第三個測試（`擋不住的情況_誠實記錄`）值得單獨說**：
> **它把「這個檢查的邊界」寫成可執行的文件。**
> 沒有它，下一個人遇到 `NT$320` 沒被擋，會以為守門人壞了 ——
> 而它其實是設計如此。
>
> ⚠️⚠️ **而如果哪天 `NT$320` 被擋住了（例如有人改了 regex），
> 這個測試會紅燈** —— 於是「邊界改變」變成一個需要被討論的事件。

#### ✅ 修正之後的輸出

```
Instant 發票已開立         | 此訂單的發票已於 2026/08/27 16:00 開立，如需更改請聯絡客服。
Duration 30 分鐘          | 下單後 30 分鐘內才能自行取消，請聯絡客服協助。
Duration 1440 分鐘        | 下單後 1 天內才能自行取消，請聯絡客服協助。
LabeledEnum 狀態          | 此訂單目前的狀態（已出貨）無法出貨。
Integer 備註長度           | 備註最多 2,000 個字，目前是 3,417 個字，請縮短後再送出。
Money 差額                | 還差 320 元才能使用這張折扣碼。
```

**六句話全部正確。**

#### 那 `Money` 的小數位到底是不是問題

**`Money.twd("1500").minus(Money.twd("1180")).toPlainString()` = `"320.00"`。**

**為什麼有兩位小數**（實測 `Currency.getDefaultFractionDigits()`）：

| 幣別 | `defaultFractionDigits` | `Money.of("1500", ...)` |
|---|---|---|
| **TWD** | **2** | `"1500.00"` |
| USD | 2 | `"1500.00"` |
| **JPY** | **0** | `"1500"` |
| KRW | 0 | `"1500"` |
| VND | 0 | `"1500"` |

⚠️ **`TWD` 在 ISO 4217 裡確實是 2 位小數**（新台幣有「分」這個單位，
雖然實務上不流通），所以 JDK 的值是**正確的**。

**而「還差 320.00 元」這句話對台灣使用者是怪的。**

**三個選項**：

| 選項 | 取捨 |
|---|---|
| ① 改 `Money` 的 scale 規則（TWD 特別處理成 0） | 🔴🔴 **會改變金額計算** —— 00 章 0.9.1 的 `allocate()` 依賴 scale，改了會讓分攤誤差跑掉 |
| ② `normalizeArg` 對 `Money` 做「整數就去掉小數」 | ⚠️ 只影響**顯示**，不影響計算 ✅；但「1500.50 元」與「1500 元」的格式不一致 |
| ③ 文案改成不含金額（「尚未達到最低消費金額」） | 🔴 失去 4.5.1 那個「把減法算好」的價值 |

✅ **選 ②**：

```java
    if (arg instanceof Money money) {
        // ★ 顯示用：整數金額不顯示小數（「320 元」而不是「320.00 元」）
        //   ⚠️ 只影響 userMessage —— extensions 裡一律是 toPlainString()（4.5.3 規則 2），
        //      因為那是給程式讀的，格式一致比好看重要
        return money.amount().stripTrailingZeros().scale() <= 0
                ? money.amount().stripTrailingZeros().toPlainString()
                : money.toPlainString();
    }
```

⚠️ **`stripTrailingZeros()` 有一個著名的陷阱**：
`new BigDecimal("100.00").stripTrailingZeros()` 的結果是 **`1E+2`**，
而 `toPlainString()` 才會把它變回 `"100"`。
**所以那個 `toPlainString()` 不可以省。**

#### 這一節找到的東西，整理成一張表

| # | 問題 | 種類 | 抓到它的方式 |
|---|---|---|---|
| 1 | `下單後 30 內`（單位消失） | 「修正沒被套用」 | 印出來的測試 |
| 2 | `下單後 1,440 內`（千分位 + 單位消失） | 同上 | 同上 |
| 3 | `狀態（SHIPPED）`（標籤沒解析） | 同上 | 同上 |
| 4 | `30 分鐘 內`（多一個空白） | **文案與程式碼的隱含契約** | 同上 |
| 5 | 🔴 **四個例外自己做了 `toPlainString()`** | **規則寫在使用之後** | 印出來的測試 → `grep` → **`args()` 守門人** |
| 6 | `320.00 元`（TWD 有兩位小數） | JDK 的正確行為在業務上不自然 | 同上 |

⚠️⚠️ **六個問題，沒有一個是「設計錯了」。**

| 種類 | 幾個 | 本質 |
|---|---|---|
| 修正沒被套用 | 3 | **課程說要改一行，而那一行沒改** |
| 隱含契約 | 1 | 兩份東西（程式碼與文案）之間的約定沒有守門人 |
| 規則寫在使用之後 | 1 | 🔴 **32 個實例先寫，規則後訂** |
| JDK 正確但業務不自然 | 1 | 需要一個「只影響顯示」的轉換 |

> 📌 **這一節的整體教訓，以及為什麼它值得佔這麼多篇幅**：
>
> **4.8.1～4.8.6 的五個設計決定全部是對的。**
> 而把它們接起來跑一次，找到六個問題。
>
> ⚠️ **六個裡面有五個的失敗方式是「訊息看起來正常」**：
> `下單後 30 內才能自行取消` 編譯得過、測試不紅、狀態碼正確、
> `errors[]` 完整、`traceId` 有 —— **只有讀中文的人會覺得怪。**
>
> 👉 **而這就是為什麼 4.8.7 的測試是「印出來」而不是「斷言」。**
> 一個斷言測試只能檢查它作者想到的事；
> 一份輸出讓**任何人掃一眼都能看出不對**。
>
> ⚠️⚠️ **第 5 個問題（四個例外自己格式化）是唯一一個「印出來」不夠的** ——
> 它需要一個守門人，因為第 33 個例外的作者不會去讀 4.8.3。
> 而那個守門人**寫不進 ArchUnit**（20 個違反、17 個是對的），
> 所以它變成一個執行期的啟發式檢查 + 一個誠實記錄邊界的測試。

---

## 4.9 重試語意 ★

### 4.9.1 六種 `Retry` 各對客戶端是什麼指令

`ErrorCode.Retry` 有六個值（04-controller 3.4.2）。
**它們不是「嚴重程度」，是「客戶端該執行的動作」**：

| `Retry` | 客戶端該做什麼 | 誰用它（98 個 code 裡） |
|---|---|---|
| `NONE` | **不要重試**。顯示訊息，讓使用者決定 | 84 個（絕大多數業務例外） |
| `MODIFY_REQUEST` | 改請求內容再送（減數量、換卡） | 5 個：`INSUFFICIENT_STOCK`、`CARD_DECLINED`、`INSUFFICIENT_FUNDS`、`EXCEEDS_CREDIT_LIMIT`、`REFUND_REJECTED` |
| `REFETCH_THEN_RETRY` | **重新 GET 資源**，帶新的 version／金額再送 | 2 個：`OPTIMISTIC_LOCK_CONFLICT`、`ORDER_AMOUNT_MISMATCH` |
| `BACKOFF_AND_RETRY` | 指數退避後**原封不動**重送 | 5 個：`RATE_LIMIT_EXCEEDED`、`ADDRESS_CHANGE_LIMIT_EXCEEDED`、`UPSTREAM_ERROR`、`SERVICE_UNAVAILABLE`、`PAYMENT_GATEWAY_UNAVAILABLE`、`REQUEST_TIMEOUT` |
| `CHECK_STATUS` | 🔴 **不要重試** —— 先查結果 | 4 個：`PAYMENT_OUTCOME_UNKNOWN`、`PAYMENT_ALREADY_IN_PROGRESS`、`UPSTREAM_TIMEOUT`、`PAYMENT_GATEWAY_TIMEOUT`、`SCAN_PENDING`、`ORDER_INVOICE_REQUEST_IN_FLIGHT` |
| `REFRESH_TOKEN_THEN_RETRY` | 換 token 再送 | 1 個：`TOKEN_EXPIRED` |

⚠️ **`CHECK_STATUS` 與 `BACKOFF_AND_RETRY` 的差別是這張表最重要的一列**，
而它就是事故 1 的核心：

| | `BACKOFF_AND_RETRY` | `CHECK_STATUS` |
|---|---|---|
| 語意 | 「我確定沒做成，你可以重送」 | 🔴 **「我不知道有沒有做成」** |
| 重送安全嗎 | ✅ 安全（伺服器沒收到／沒處理） | 🔴🔴 **可能重複扣款** |
| 客戶端該做 | `sleep` 然後重送同一個請求 | **打 `GET /payments/{id}` 查狀態** |

⚠️⚠️ **而 `retryable()` 這個方法把兩者混在一起**：

```java
// ErrorCode（04-controller 3.4.2）
public boolean retryable()  { return retry != Retry.NONE; }
```

**於是 `PAYMENT_OUTCOME_UNKNOWN` 的 `retryable` 是 `true`** ——
而 4.0 事故 1 的前端邏輯正是看這個：

```typescript
if (problem.retryable) { return retryWithBackoff(req); }   // 🔴 對 CHECK_STATUS 是災難
```

**三個修法**：

| 修法 | 取捨 |
|---|---|
| ① 把 `CHECK_STATUS` 的 `retryable` 改成 `false` | 🔴 語意上不對（「不能重試」也不準確 —— 它可以重試，但要先查） |
| ② 拿掉 `retryable`，只留 `retryStrategy` | 🔴🔴 **破壞性變更** —— `retryable` 在 API 文件與所有客戶端裡 |
| ③ ✅ **加一個 `safeToRetryBlindly`，並在文件裡把 `retryable` 標為 deprecated** | ⚠️ 兩個布林，客戶端可能看錯 |

✅ **選 ③**：

```java
// 加到 ErrorCode

/**
 * ★★ 客戶端可以「原封不動重送」而不會產生副作用。
 *
 * <p>⚠️ 它與 {@link #retryable()} 的差別只有 {@code CHECK_STATUS} 一組，
 * 而那一組差別就是 4.0 事故 1：
 * <table>
 *   <tr><th></th><th>{@code retryable()}</th><th>{@code safeToRetryBlindly()}</th></tr>
 *   <tr><td>{@code BACKOFF_AND_RETRY}</td><td>true</td><td><b>true</b></td></tr>
 *   <tr><td>{@code CHECK_STATUS}</td><td>true</td><td>🔴 <b>false</b></td></tr>
 * </table>
 *
 * <p>👉 <b>前端的通用重試層應該看這一個，不是 {@code retryable()}。</b>
 *
 * <p>⚠️ {@code MODIFY_REQUEST} 與 {@code REFETCH_THEN_RETRY} 也是 false ——
 * 它們要求客戶端<b>改變請求</b>，所以「原封不動重送」一定失敗。
 */
public boolean safeToRetryBlindly() {
    return retry == Retry.BACKOFF_AND_RETRY;
}
```

**於是 `Problem` 多一個欄位**：

```java
// ProblemFactory.build()
        code.retryable() ? Boolean.TRUE : Boolean.FALSE,      // ★ 保留（相容）
        code.retry() == ErrorCode.Retry.NONE ? null : code.retry().name(),
        // ★★ 新增：讓前端的通用層有一個可以直接用的布林
        code.safeToRetryBlindly() ? Boolean.TRUE : null,
```

⚠️ **`? Boolean.TRUE : null`（而不是 `Boolean.FALSE`）** ——
`@JsonInclude(NON_NULL)` 讓它在 false 時消失，
於是**98 個 code 裡只有 5 個會有這個欄位**，
而「有這個欄位」= 「可以盲重試」是一個更難誤讀的形狀。

⚠️⚠️ **而「`Problem` 多一個欄位」的代價比想像的大，因為它是一個 record。**
編譯器立刻給了答案：

```
error: constructor Problem in record example.shop.common.web.Problem
       cannot be applied to given types;
  required: String,String,int,String,String,String,String,
            List<FieldViolation>,Integer,Boolean,Boolean,String,String,Instant,
            Map<String,Object>
  found:    ...（15 個 → 16 個）
  reason: actual and formal argument lists differ in length
```

**要跟著改的地方**：

| 位置 | 改什麼 |
|---|---|
| `Problem` 的 `@JsonPropertyOrder` | 加 `"safeToRetryBlindly"`（否則它會排到最後） |
| `Problem.withExtension`（4.3.4 新增的） | 多傳一個參數 |
| `ProblemFactory.validationFailed`（04-controller 3.6.3） | 它重建了整個 `Problem` → 多傳一個參數 |
| 04-controller 07 章的契約測試 | ⏳ 本站沒跑（4.16 的已知缺口） |

✅ **而「編譯錯誤」是這裡最好的失敗方式**：
`Problem` 有 **15 個 component 且其中 5 個是 `Boolean`／`String`** ——
如果它是一個有 setter 的 class，「漏設一個欄位」會是靜默的 `null`。

> 📌 **這是 03 章反覆在說的同一件事在本章的一個實例**：
> **record 的「不方便」就是它的價值。**
> 加一個欄位要改四個地方 —— 而那四個地方**每一個都是編譯器指給你的**。

> 📌 **一般規則**：
> **布林欄位如果 90% 是同一個值，讓另外 10% 用「欄位存在」表示。**
> 理由：`retryable: false` 與「沒有 `retryable` 欄位」在客戶端的
> `if (problem.retryable)` 下行為相同，
> 而**少一個欄位就少一個被誤讀的機會**。

### 4.9.2 `Retry-After` 從哪裡來

**`Retry-After` 是一個 HTTP 標頭**，而業務例外**不該知道 HTTP 標頭**（00 章 0.10.6）。

**於是它需要一個轉換**：

```
例外的 extensions["retryAfterSeconds"]   →   advice   →   Retry-After 標頭
        ↑ 業務資訊（「多久之後窗口重置」）              ↑ HTTP 表述
```

```java
// 加到 ApiExceptionHandler（04-controller 3.7.2）

@ExceptionHandler(BusinessException.class)
public ResponseEntity<Problem> handle(BusinessException ex, HttpServletRequest request) {

    Problem problem = problems.from(ex, ProblemFactory.instanceOf(request));

    var response = ResponseEntity.status(ex.errorCode().status());

    // ★★ 4.9.2：extensions 裡有 retryAfterSeconds 就變成標頭
    Object retryAfter = ex.extensions().get("retryAfterSeconds");
    if (retryAfter instanceof Number n && n.longValue() > 0) {
        response = response.header(HttpHeaders.RETRY_AFTER, String.valueOf(n.longValue()));
    }

    if (ex instanceof SideEffectsCommitted sec) { /* 4.3.4 */ }

    return response.body(problem);
}
```

⚠️ **三個細節**：

| 細節 | 為什麼 |
|---|---|
| **`instanceof Number` 而不是 `instanceof Long`** | `ext()` 可能收到 `Integer`（`ext("retryAfterSeconds", 30)` 的字面值是 `int`）→ autoboxing 成 `Integer` |
| **`> 0` 的檢查** | `Retry-After: 0` 的語意是「立刻重試」，而那不是我們的意思。而負數會讓某些 client 崩（4.6.4） |
| **欄位同時留在 `extensions`** | ⚠️ 刻意重複 —— 標頭給 HTTP client 的通用層，`extensions` 給前端顯示「請於 3 分鐘後再試」 |

**哪些 code 該有 `Retry-After`**：

| code | 值從哪來 | 有嗎 |
|---|---|---|
| `RATE_LIMIT_EXCEEDED` | 限流器的窗口剩餘時間 | ✅ 04-controller 04 章的 `RateLimitInterceptor` 直接設標頭（**不走這條路**） |
| `ADDRESS_CHANGE_LIMIT_EXCEEDED` | `windowResetsAt - now` | ✅ 4.6.4 已實作 |
| `ORDER_INVOICE_REQUEST_IN_FLIGHT` | 固定 30 秒（財政部 API 的典型延遲） | ✅ 4.5.7 已實作 |
| `SCAN_PENDING` | 掃毒的預估剩餘時間 | ✅ 04-controller 5.5.6 |
| `SERVICE_UNAVAILABLE` / `PAYMENT_GATEWAY_UNAVAILABLE` | 熔斷器的 open 狀態剩餘時間 | ⏳ **06 章** |
| `UPSTREAM_ERROR` | ⚠️ **不知道** | 🔴 **不設** —— 見下 |

⚠️ **「不知道就不要設」是一個重要的決定。**

```java
// 🔴 常見的第一版
response.header(HttpHeaders.RETRY_AFTER, "60");     // 「隨便給一個吧」
```

**問題**：`Retry-After: 60` 是一個**承諾** ——
客戶端會在 60 秒後重試，而如果上游還沒好，它會再等 60 秒。
**而「沒有 `Retry-After`」讓客戶端用它自己的指數退避**，
那通常比我們瞎猜的固定值好。

> 📌 **一般規則**：
> **不要為了「欄位完整」而編造值。**
> （4.5.7 家族 7 的 `actualVersion` 是同一條規則。）

### 4.9.3 `retryable` 標錯的三個 code 🔴

**跑一次「每個 code 的 retry 策略是否合理」的人工複查，找到三個**：

| code | 現在 | 應該 | 為什麼 |
|---|---|---|---|
| `REFUND_REJECTED` | `MODIFY_REQUEST` | 🔴 **`NONE`** | ⚠️ 「改請求內容再送」對它**沒有意義** —— 原卡註銷，改任何欄位都不會成功。它的替代路徑是**人工匯款**，而那不是「重送這個請求」 |
| `ORDER_INVOICE_REQUEST_IN_FLIGHT` | `CHECK_STATUS` | ✅ **正確** | 「先查開票狀態」正是它的意思 |
| `PAYMENT_ALREADY_IN_PROGRESS` | `CHECK_STATUS` | ✅ 正確 | |

**只有一個要改**，而它的理由值得展開：

```
MODIFY_REQUEST 的語意：「你的請求有一個地方不對，改掉它就能成功」
REFUND_REJECTED 的現實：「請求完全正確，但這條路走不通」
```

⚠️ **而它「看起來」像 `MODIFY_REQUEST`**，因為 00 章 0.12 ⑮ 的理由欄寫著：

> ⚠️ 帶 `manualTransferAvailable` 讓前端能引導到人工匯款

**「引導到另一個動作」不是「修改請求重送」** ——
那是 `alternativeAction` 的職責，而 `alternativeAction` 與 `retryStrategy` 是兩個獨立的欄位。

```java
// ErrorCode 修正
    REFUND_REJECTED        (HttpStatus.UNPROCESSABLE_ENTITY, "refund-rejected"),
//                          ★ 拿掉 Retry.MODIFY_REQUEST
```

> 📌 **一般規則**：
> **`retryStrategy` 回答「重送這個請求會怎樣」，
> `alternativeAction` 回答「不能做 A，可以做 B」。**
> 兩者都有值的情況存在（`SELF_CANCEL_WINDOW_EXPIRED` 是 `NONE` + 「聯絡客服」），
> **而把「有替代方案」誤讀成「可重試」會讓客戶端做錯事。**

### 4.9.4 「可重試」與「冪等」不是同一件事

**最後一個容易混的概念**：

| | 冪等（idempotent） | 可重試（retryable） |
|---|---|---|
| 是什麼的性質 | **端點**（`PUT /orders/{id}` 是；`POST /orders` 不是） | **錯誤**（`RATE_LIMIT_EXCEEDED` 是） |
| 誰決定 | API 設計（03-rest-api 第 02 章） | `ErrorCode` |
| 保證什麼 | 重送**不會**產生第二個副作用 | 重送**有機會**成功 |

⚠️ **兩者的四種組合都存在**：

| 冪等 | 可重試 | 例子 | 客戶端可以怎樣 |
|---|---|---|---|
| ✅ | ✅ | `PUT /orders/{id}` 遇到 `SERVICE_UNAVAILABLE` | 放心重試 |
| ✅ | 🔴 | `PUT /orders/{id}` 遇到 `ORDER_ITEM_IMMUTABLE` | 重試也是同一個錯 |
| 🔴 | ✅ | `POST /orders` 遇到 `RATE_LIMIT_EXCEEDED` | ⚠️ **可以重試，但必須帶同一個 `Idempotency-Key`** |
| 🔴 | 🔴 | `POST /orders` 遇到 `INSUFFICIENT_STOCK` | 改數量後重送（**新的 key**） |

⚠️⚠️ **第三列是實務上最容易錯的**：

```
POST /orders 被限流 → 429 + retryable: true
→ 客戶端重試，但【產生了一個新的 Idempotency-Key】
→ 限流解除後兩個請求都成功 → 【兩張訂單】
```

✅ **正確的客戶端行為**：`Idempotency-Key` 在**第一次**送出時產生，
**整個重試序列共用同一個** —— 這是 03-rest-api 第 02 章的規則，
而它在這裡與 `retryStrategy` 交會。

> 📌 **我們能做的事**：在 `Problem` 上把這件事說清楚。
> `RATE_LIMIT_EXCEEDED` 的 `userMessage` 是給人看的，
> 而**給程式看的提示應該在 `extensions`**：
>
> ```java
> ext("retryAfterSeconds", 30,
>     // ★ 明確告訴客戶端「重試時要沿用同一個 key」
>     "reuseIdempotencyKey", true)
> ```
>
> ⚠️ **而這個欄位只有在「非冪等端點 + 可重試錯誤」時才有意義** ——
> 於是它不該寫在例外裡（例外不知道端點冪不冪等），
> **而該由 04-controller 04 章的 `IdempotencyInterceptor` 加上**。
> 👉 **記進 4.16 的「跨站待辦」。**

---

## 4.10 例外與交易 ★★

### 4.10.1 例外階層天生就對齊 rollback 規則

02 章 2.6.1 的預設規則：

```
RuntimeException / Error   → rollback
checked Exception          → 🔴 commit（！）
```

而 4.3.4 的階層是：

```
RuntimeException
  ├── BusinessException（抽象）→ 26+ 個具體例外
  └── InvariantViolationException extends IllegalStateException
```

✅ **兩者相乘的結果是：`rollbackFor` 在整個 shop-service 出現 0 次。**

**這不是巧合，是 02 章 2.6.4 那條政策的設計目標**：

```
① 所有業務例外繼承 BusinessException extends RuntimeException
   → 預設規則就是對的，不需要 rollbackFor
```

⚠️ **而它有一個容易被忽略的推論**：

> **「不需要寫 `rollbackFor`」不是「省了打字」，而是「不會漏」。**

**對照兩種世界**：

| | 需要 `rollbackFor` 的世界 | shop-service |
|---|---|---|
| 新增一個業務例外 | ⚠️ 要檢查「所有可能拋它的 `@Transactional` 方法有沒有加 `rollbackFor`」 | ✅ **什麼都不用做** |
| 漏了會怎樣 | 🔴 **資料不一致，而且靜默** | — |
| 誰守它 | 一份 checklist（= 會漏） | ✅ **型別系統** |

**而 02 章 2.6.4 的那條 ArchUnit 規則守的是反方向**：

```java
// 「沒有任何 @Transactional 方法宣告 checked exception」
methods().that().areAnnotatedWith(Transactional.class)
         .should(不宣告checked例外)
```

⚠️ **本章補一條它的補集**：

```java
/**
 * ★★ 每一個業務例外都必須是 unchecked。
 *
 * <p>02 章 2.6.4 那條規則守的是「@Transactional 方法不宣告 checked」，
 * 而它有一個缺口：<b>一個 checked 的業務例外可以被
 * 「不是 @Transactional 的方法」拋出，然後往上冒到一個 @Transactional 方法。</b>
 *
 * <pre>
 * // 這條路徑通得過 02 章 2.6.4 的規則
 * &#64;Transactional
 * public void a() { b(); }              // ← 沒宣告 throws（因為 b() 也沒有）
 *
 * private void b() throws MyCheckedException { ... }
 * //                      ↑ 🔴 而如果 MyCheckedException 是 checked，
 * //                        a() 就編譯不過 —— 所以這條路其實走不通
 * </pre>
 *
 * <p>⚠️⚠️ <b>所以這條規則其實是多餘的</b> ——
 * Java 的 checked exception 規則已經保證了它。
 * 保留它的理由只有一個：<b>它讓「為什麼不需要 rollbackFor」變成可執行的文件。</b>
 */
@ArchTest
static final ArchRule 業務例外一律unchecked =
        classes().that().areAssignableTo(BusinessException.class)
                 .should().beAssignableTo(RuntimeException.class)
                 .because("預設的 rollback 規則只對 RuntimeException 生效（02 章 2.6.1）");
```

⚠️ **這條規則被誠實地標成「多餘」**，而那是刻意的示範：

> 📌 **一條「不可能失敗」的規則值不值得留？**
>
> | 論點 | |
> |---|---|
> | ✅ 留 | 它是**可執行的文件** —— `because(...)` 那句話解釋了整個設計 |
> | ✅ 留 | `BusinessException` 的父類別哪天被改（例如有人想讓它繼承 `Exception`），它會紅燈 |
> | 🔴 不留 | 每一條規則都有維護成本（ArchUnit 的執行時間、閱讀成本） |
>
> **判準**：如果一條規則的 `because(...)` 是你想寫在 wiki 上的東西，
> 那它值得留 —— 因為**測試不會過期，wiki 會**。

### 4.10.2 兩個需要 `noRollbackFor` 的真實情況

02 章 2.6.4 說「唯一需要 `rollbackFor` 的情況幾乎不存在」。
⚠️ **而 `noRollbackFor` 是另一回事，它在本章有兩個真實用途。**

**情況 1：業務例外之前的稽核紀錄要保留**

```java
@Transactional
public void applyCoupon(ApplyCouponCommand cmd) {
    Order order = orders.findById(cmd.orderId()).orElseThrow();
    Coupon coupon = coupons.findByCode(cmd.code())
            .orElseThrow(() -> new CouponNotFoundException(cmd.code()));

    // ★ 需求：「券被拒的紀錄要留下來，行銷要分析為什麼」
    couponAttempts.record(cmd.orderId(), cmd.code(), clock.instant());

    coupon.assertUsableAt(clock.instant());        // 🔴 可能拋 CouponExpiredException
    order.applyCoupon(coupon, clock.instant());
}
```

**問題**：`CouponExpiredException` 是 `RuntimeException` → rollback →
**`couponAttempts.record()` 也被回滾了。**

**四個選項**：

| 選項 | 取捨 |
|---|---|
| ① `@Transactional(noRollbackFor = CouponExpiredException.class)` | 🔴🔴 **整個交易都不 rollback**，包括 `order.applyCoupon()` 已經改的東西 |
| ② `couponAttempts.record()` 用 `REQUIRES_NEW` | ⚠️ 一條額外的連線（02 章 2.3.4 的三個代價）；但這裡是**寫入一張獨立的表** |
| ③ 把紀錄搬到 **advice**（catch 到例外時記） | 🔴 Web 層在做業務邏輯；而第二個入口（排程）不會經過 advice |
| ④ ✅ **`TransactionTemplate` + `PROPAGATION_REQUIRES_NEW`，並在 catch 裡記** | 明確、只包住那一行 |

✅ **選 ④**（而它與 ② 的實作幾乎一樣，差別是**「只在失敗時記」**）：

```java
@Transactional
public void applyCoupon(ApplyCouponCommand cmd) {
    Order order = orders.findById(cmd.orderId()).orElseThrow();
    Coupon coupon = coupons.findByCode(cmd.code())
            .orElseThrow(() -> new CouponNotFoundException(cmd.code()));
    try {
        coupon.assertUsableAt(clock.instant());
        order.applyCoupon(coupon, clock.instant());
        orders.save(order);
    } catch (CouponException e) {
        // ★★ 在【獨立交易】裡記錄失敗，然後把例外原封不動拋出去
        //    ⚠️ 順序很重要：先記錄，再 rethrow
        recordAttempt(cmd, e.errorCode());
        throw e;
    }
}

/**
 * ★ 獨立的短交易 —— 外層 rollback 不影響它。
 *
 * <p>⚠️ 它必須是「新的交易」而不是「不 rollback 的同一個交易」，
 * 理由是選項 ① 的問題：{@code noRollbackFor} 會讓
 * <b>整個</b>交易 commit，包括 {@code order} 上已經做的部分修改。
 *
 * <p>⚠️⚠️ 而它有一個 02 章 2.3.4 的代價要接受：
 * <b>它佔用第二條連線</b>，而外層交易還持有第一條。
 * 於是連線池的有效大小在這條路徑上減半。
 * 由於「套用折扣碼失敗」是低頻操作（&lt; 1% 的請求），這個代價可以接受。
 */
private void recordAttempt(ApplyCouponCommand cmd, ErrorCode reason) {
    couponAttemptTemplate.executeWithoutResult(status ->
            couponAttempts.record(cmd.orderId(), cmd.code(), reason.name(),
                                  clock.instant()));
}
```

```java
// 組態
@Bean
TransactionTemplate couponAttemptTemplate(PlatformTransactionManager tm) {
    var template = new TransactionTemplate(tm);
    template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    // ★ 短交易 → 短 timeout。它只 INSERT 一列
    template.setTimeout(3);
    return template;
}
```

⚠️⚠️ **一個很容易寫錯的地方**：

```java
} catch (CouponException e) {
    recordAttempt(cmd, e.errorCode());
    throw e;                              // ★ 必須 rethrow
}
```

**如果忘了 `throw e`**：

| 後果 | |
|---|---|
| 交易 **commit** | `order` 上的部分修改被寫入 |
| Controller 回 **200** | 客戶以為券套用成功了 |
| 而 `couponAttempts` 有一筆「失敗」紀錄 | 🔴 **資料互相矛盾** |

**這與 4.0 事故 3 是同一個形狀**：`catch` 之後沒有把失敗表達出來。

✅ **一條可以守它的測試**：

```java
@Test
void 套用過期的券要拋例外並且不改變訂單() {
    var expired = Coupons.expired("SUMMER10");
    when(coupons.findByCode("SUMMER10")).thenReturn(Optional.of(expired));

    assertThatThrownBy(() -> service.applyCoupon(cmd))
            .isInstanceOf(CouponExpiredException.class);      // ★ 有拋

    verify(orders, never()).save(any());                       // ★ 沒存
    verify(couponAttempts).record(eq("ORD-1"), eq("SUMMER10"),
                                  eq("COUPON_EXPIRED"), any());  // ★ 有記
}
```

> 📌 **`verify(orders, never()).save(any())` 那一行是關鍵。**
> 少了它，「忘記 rethrow」這個 bug 通不過測試 ——
> 因為前兩個斷言在「忘記 rethrow」的版本下**會失敗**（沒有例外）…
>
> ⚠️ **等一下，這個推理是錯的。** `assertThatThrownBy` 會抓到「沒有例外」，
> 所以第一個斷言就足夠了。
> ✅ **`never()).save()` 守的是另一件事**：
> 「有拋例外，但在拋之前已經 `save` 了」——
> 而那在**手動 rollback 失敗**或**`saveAndFlush`** 的情況下是可能的。

**情況 2：`SideEffectsCommitted` 的例外要不要 rollback**

**這是 4.0 事故 3 的正面處理。**

```java
@Transactional
public void processRefund(ProcessRefundCommand cmd) {
    ReturnRequest req = returns.findById(cmd.returnId()).orElseThrow();

    req.markGoodsReceived(cmd.actor(), clock.instant());       // ★ 已收貨（不可回復的事實）

    RefundResult result = paymentGateway.refund(...);           // ⚠️ 外部呼叫
    if (result.isRejected()) {
        throw new RefundRejectedException(...);                 // implements SideEffectsCommitted
    }
    req.markRefunded(result.transactionId());
    returns.save(req);
}
```

⚠️ **`RefundRejectedException` 是 `RuntimeException` → rollback →
`markGoodsReceived()` 被回滾了。**

**而「已收貨」是一個物理事實** —— 貨真的在倉庫裡。回滾它是錯的。

| 選項 | 取捨 |
|---|---|
| ① `noRollbackFor = RefundRejectedException.class` | ✅ 收貨紀錄留下。⚠️ **但退款失敗的狀態也要一起寫入**（見下） |
| ② `markGoodsReceived` 用 `REQUIRES_NEW` | 🔴 兩個交易 → 「收貨了但沒有退貨單」的中間狀態可被看到 |
| ③ ✅ **不拋例外**，把失敗寫成狀態 | 事故 3 的選項 ② |

✅ **選 ③，而它的具體形狀是「不要用例外表達這件事」**：

```java
@Transactional
public RefundOutcome processRefund(ProcessRefundCommand cmd) {
    ReturnRequest req = returns.findById(cmd.returnId()).orElseThrow();
    req.markGoodsReceived(cmd.actor(), clock.instant());

    RefundResult result = paymentGateway.refund(...);

    if (result.isRejected()) {
        // ★★ 不拋例外 —— 把失敗寫成狀態（事故 3 的選項 ②）
        req.markRefundFailed(result.reasonCode(), clock.instant());
        returns.save(req);
        // ⚠️ 交易【commit】：收貨 + 退款失敗狀態一起寫入
        return RefundOutcome.failed(result.reasonCode(), req.refundAmount());
    }
    req.markRefunded(result.transactionId());
    returns.save(req);
    return RefundOutcome.succeeded(result.transactionId());
}
```

⚠️⚠️ **那 `RefundRejectedException` 還存在嗎？**

✅ **存在，但拋出點不同**：

| 拋出點 | 用例外還是狀態 | 為什麼 |
|---|---|---|
| **客服後台手動觸發退款** | ✅ **例外**（422 + `SideEffectsCommitted`） | 客服在等一個同步的答案，而「失敗」要顯示在畫面上 |
| **排程批次處理退款** | 🔴 **狀態** | 沒有人在等；例外只會讓排程停下來 |

**於是 Application 層有兩個方法**：

```java
/** 客服後台用：失敗拋例外（呼叫端要一個同步的答案）。 */
@Transactional
public void processRefundInteractively(ProcessRefundCommand cmd) {
    RefundOutcome outcome = processRefund(cmd);
    if (outcome.isFailed()) {
        // ⚠️ 注意：這裡拋例外會 rollback 掉 processRefund 寫的
        //    markGoodsReceived 與 markRefundFailed
        throw new RefundRejectedException(...);
    }
}
```

🔴 **上面這個寫法是錯的**，而它錯得很典型：**拋例外把該保留的狀態也回滾了。**

✅ **正確做法**：

```java
/**
 * 客服後台用：失敗時<b>先 commit 狀態，再拋例外</b>。
 *
 * <p>⚠️ 這需要「拋例外的位置」在交易外面。
 * 於是它<b>不是</b> {@code @Transactional} —— 它呼叫一個是的。
 */
public void processRefundInteractively(ProcessRefundCommand cmd) {
    // ★ 這一行結束時交易已經 commit（收貨 + 退款失敗狀態都在）
    RefundOutcome outcome = self.processRefund(cmd);

    // ★★ 交易【外面】才拋例外 → 狀態保留，客服也看到錯誤
    if (outcome.isFailed()) {
        throw new RefundRejectedException(cmd.returnId(), outcome.orderNumber(),
                                          outcome.amount(),
                                          outcome.manualTransferAvailable());
    }
}
```

⚠️ **`self.processRefund(cmd)` 那個 `self`** —— 02 章 2.7.1 的自呼叫問題。
`processRefundInteractively` 不是 `@Transactional`，
而它呼叫的 `processRefund` 是 —— **直接呼叫 `this.processRefund()` 會繞過代理**。

**02 章 2.7.1 給的六種解法裡，這裡適用兩種**：

| 解法 | 適用嗎 |
|---|---|
| 注入自己（`@Lazy OrderApplicationService self`） | ✅ 可以，但循環依賴（01 章 1.6） |
| **拆成兩個 bean** | ✅✅ **更好** —— 見下 |
| `TransactionTemplate` | ⚠️ 可以，但這裡的交易邊界剛好是一整個方法 |

✅ **拆成兩個 bean**：

```java
/**
 * ★ 「互動式」的外殼 —— 它的職責只有一個：<b>把 outcome 翻譯成例外</b>。
 *
 * <p>⚠️ 它刻意<b>不是</b> {@code @Transactional}，
 * 而那正是它存在的理由（4.10.2 情況 2）：
 * <b>例外必須在交易 commit 之後才拋。</b>
 */
@Service
public class InteractiveRefundService {

    private final RefundApplicationService refunds;    // ★ 另一個 bean → 走代理

    public InteractiveRefundService(RefundApplicationService refunds) {
        this.refunds = refunds;
    }

    public void processRefund(ProcessRefundCommand cmd) {
        RefundOutcome outcome = refunds.processRefund(cmd);     // ★ 交易在這裡結束
        if (outcome.isFailed()) {
            throw new RefundRejectedException(cmd.returnId(), outcome.orderNumber(),
                                              outcome.amount(),
                                              outcome.manualTransferAvailable());
        }
    }
}
```

> 📌 **這一整段濃縮成一句**：
> **「這件事失敗了」與「這個交易要回滾」是兩個獨立的決定，
> 而例外把它們綁在一起。**
>
> 解開它們的方式是：**讓 Service 回傳結果物件，讓外殼決定要不要變成例外。**
> ⚠️ 而那個外殼**必須在交易外面**。

⚠️⚠️ **代價要說清楚**：這個模式讓一個操作變成
「一個結果型別（`RefundOutcome`）+ 兩個 Service + 一個例外」。
**它只值得用在「有不可回復副作用」的操作上** ——
而 shop-service 只有兩個（退款、扣款）。
**其他 30+ 個業務例外都直接拋，因為它們的交易本來就該全部回滾。**

### 4.10.3 `AFTER_COMMIT` 裡拋業務例外會怎樣

02 章 2.12.2 講了 `AFTER_COMMIT` 的三個陷阱。**這裡加第四個。**

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) {
    // 寄確認信
    if (event.customerEmail() == null) {
        throw new ValidationFailedException(...);      // ⚠️ 這裡拋業務例外會怎樣？
    }
    mailer.sendOrderConfirmation(event);
}
```

**答案分三種情況**（實務上會踩到的順序）：

| 情況 | 結果 |
|---|---|
| **同步的 `AFTER_COMMIT`（預設）** | 例外**往上冒到原本的呼叫端** —— 而交易**已經 commit 了** |
| `@Async` 的 listener | 例外被執行緒池吞掉（只進 log） |
| 有多個 listener | 🔴 **第一個拋例外之後，後面的 listener 不會執行** |

⚠️ **第一種情況的完整後果**：

```
POST /api/orders
  → 交易 commit（訂單已經在資料庫裡）✅
  → AFTER_COMMIT listener 拋 ValidationFailedException
  → 冒到 Controller
  → advice 接到它 → 回【422】
  → 🔴 客戶端看到「驗證失敗」，而訂單已經成立了
```

**這是最糟的一種**：**成功的操作回了失敗的狀態碼。**

✅ **三條規則**：

| # | 規則 | 為什麼 |
|---|---|---|
| 1 | **`AFTER_COMMIT` 的 listener 不可以拋 `BusinessException`** | 業務驗證應該在交易**裡面**做完 |
| 2 | listener 內部一律 `try { ... } catch (Exception e) { log.error }` | ⚠️ 而那正是 4.0 事故 3 的形狀 → 所以要加第 3 條 |
| 3 | **失敗要進 outbox 或一張待重試的表**，不是只進 log | 06 章 |

**規則 1 可以自動化**：

```java
/**
 * ★★ AFTER_COMMIT 的 listener 不可以宣告或拋出 BusinessException。
 *
 * <p>⚠️ ArchUnit 只看得到「宣告」與「呼叫關係」，
 * 所以這條規則抓的是「方法內部有 new 一個 BusinessException」——
 * 它抓不到「呼叫另一個方法，而那個方法拋」。
 *
 * <p>👉 <b>不完備，而它抓得到最常見的形狀。</b>
 */
@ArchTest
static final ArchRule afterCommit不可拋業務例外 =
        noMethods().that().areAnnotatedWith(TransactionalEventListener.class)
                   .should(new ArchCondition<JavaMethod>("建立 BusinessException") {
                       @Override
                       public void check(JavaMethod m, ConditionEvents events) {
                           m.getConstructorCallsFromSelf().stream()
                            .filter(call -> call.getTargetOwner()
                                    .isAssignableTo(BusinessException.class))
                            .forEach(call -> events.add(SimpleConditionEvent.violated(m,
                                    "%s 建立了 %s —— AFTER_COMMIT 的例外會讓「成功的操作回失敗的狀態碼」（4.10.3）"
                                            .formatted(m.getFullName(),
                                                       call.getTargetOwner().getSimpleName()))));
                       }
                   });
```

⚠️ **規則寫成 `noMethods().that().areAnnotatedWith(TransactionalEventListener.class)`
而不是只針對 `AFTER_COMMIT`**，理由：

| phase | 拋業務例外會怎樣 |
|---|---|
| `BEFORE_COMMIT` | ⚠️ 交易會 rollback —— **這個是合理的**（它還在交易裡） |
| `AFTER_COMMIT` | 🔴 4.10.3 的問題 |
| `AFTER_ROLLBACK` | 🔴 例外覆蓋原本的例外 → 原因消失 |
| `AFTER_COMPLETION` | 🔴 同上 |

**四個裡面三個是錯的，而 `BEFORE_COMMIT` 用得極少**
（02 章 2.12.1 的表：shop-service 沒有任何 `BEFORE_COMMIT` 的 listener）。
👉 **所以規則涵蓋全部四個，並在 `because(...)` 說明
「如果你真的需要 `BEFORE_COMMIT` 拋例外，加一個 `@SuppressWarnings` 級別的例外並寫理由」。**

### 4.10.4 業務例外在 `REQUIRES_NEW` 邊界上

**一個容易誤解的情境**：

```java
@Transactional                                          // T1
public void placeOrder(CreateOrderCommand cmd) {
    Order order = ...;
    orders.save(order);

    numberGenerator.next();                             // T2（REQUIRES_NEW，02 章 2.11.4）

    stock.reserve(...);                                 // 🔴 拋 InsufficientStockException
}
```

**問題**：`T2` 已經 commit 了（取號）。`T1` rollback。**號碼呢？**

✅ **號碼被消耗掉了，而那是刻意的**（02 章 2.11.4：「序號會有洞」）。

⚠️ **而反方向的情境才是陷阱**：

```java
@Transactional                                          // T1
public void applyCoupon(...) {
    try {
        couponUsage.increment(code);                    // T2（REQUIRES_NEW）
    } catch (CouponExhaustedException e) {
        // ⚠️ T2 已經 rollback；T1 還活著
        //    ★ 這裡【可以】安全地繼續，因為 T2 的失敗沒有污染 T1
        log.info("券已用完，改用預設折扣");
        applyDefaultDiscount();
    }
}
```

✅ **這是安全的** —— 而它與 02 章 2.8 的 `UnexpectedRollbackException` **不同**：

| | `REQUIRES_NEW` 的內層失敗 | `REQUIRED` 的內層失敗 |
|---|---|---|
| 內層 rollback 影響外層嗎 | 🔴 **不影響**（獨立交易） | ✅ **影響** —— 標記 rollback-only |
| 外層 catch 掉例外之後 commit | ✅ 正常 commit | 🔴 **`UnexpectedRollbackException`** |

⚠️⚠️ **所以「catch 業務例外並繼續」的安全性取決於傳播行為**，
而那個資訊**不在 catch 那一行看得到**：

```java
try {
    couponUsage.increment(code);      // ← 這是 REQUIRED 還是 REQUIRES_NEW？
} catch (CouponExhaustedException e) {
    // 看不出來這裡安不安全
}
```

✅ **一條可以自動化的規則**（02 章 2.13.2 那組「交易政策」測試的補充）：

```java
/**
 * ★★ 被 catch 的業務例外，其來源方法必須是 REQUIRES_NEW。
 *
 * <p>⚠️ <b>這條規則寫不出來。</b>
 * ArchUnit 看不到 try-catch 結構（那是 bytecode 的 exception table，
 * 而 ArchUnit 的 model 沒有暴露它）。
 *
 * <p>👉 <b>處置</b>：改成一條 code review 檢核項，並在每一個
 * 「catch 業務例外並繼續」的位置加一行註解說明傳播行為。
 * shop-service 有 <b>3 處</b>，全部標註過（4.16 的驗收清單）。
 */
```

> 📌 **本章第二次遇到「規則寫不出來」**（第一次是 4.5.5 的 log 順序）。
> **兩次的處置都一樣：明確寫下「這個沒有自動化」，並給出人工的替代。**
>
> ⚠️ **而這比「假裝它被守住了」重要得多** ——
> 一份「全部都有測試」的驗收清單會讓人停止思考。

---

## 4.11 不要用例外做流程控制 —— 以及三個「其實可以」

### 4.11.1 成本量測 ★

**「例外很慢」是一個被過度傳播的說法。** 實測一次
（**Apple Silicon / macOS 14.2.1 / Temurin 21.0.5**，50 萬次，
已 warmup 2 萬次）：

**呼叫堆疊深度 ≈ 63 層**（接近真實 Spring 應用：Controller → advice → Service → Domain → Repository 約 60～120 層）：

| 操作 | ns/op | 相對成本 |
|---|---|---|
| 回傳一個物件（對照組） | **30** | 1× |
| `new RuntimeException`（**無** stack trace） | **34** | **1.1×** |
| `throw` + `catch`（無 stack trace） | **35** | **1.2×** |
| `new RuntimeException`（**有** stack trace） | **1,520** | **51×** |
| `throw` + `catch`（有 stack trace） | **1,519** | 51× |
| `getStackTrace()`（materialize 出來） | **5,956** | **199×** |

**呼叫堆疊深度 ≈ 13 層**（單元測試的環境）：

| 操作 | ns/op |
|---|---|
| 回傳一個物件 | 7 |
| `new`（無 trace） | 19 |
| `throw`+`catch`（無 trace） | **10** |
| `new`（有 trace） | 510 |
| `throw`+`catch`（有 trace） | 472 |
| `getStackTrace()` | 1,594 |

**三個結論**：

| # | 結論 |
|---|---|
| 1 | **成本幾乎全部在 stack trace 的填寫**，而它**與堆疊深度成正比**（13 層 510ns → 63 層 1,520ns） |
| 2 | ✅ **`writableStackTrace = false` 讓例外的成本降到「跟回傳一個物件差不多」**（34ns vs 30ns） |
| 3 | ⚠️ **`getStackTrace()` 比 `new` 更貴**（5,956ns）—— 因為 `fillInStackTrace` 只存一個 native 的 backtrace，**轉成 `StackTraceElement[]` 是另一筆成本** |

⚠️ **第 3 點有一個實務推論**：

```java
// 🔴 一個很常見的「順手」寫法
log.warn("失敗 at {}", e.getStackTrace()[0]);      // ★ 為了印「哪一行」
```

**它把 5,956ns 加到每一次失敗上**，
而 `log.warn("...", e)`（把整個例外交給 logger）在
**log level 沒開時是 0 成本**。

> 📌 **「例外很慢」的正確版本**：
> **「填 stack trace 很慢，而它與呼叫深度成正比。」**
>
> 於是：
> - `BusinessException`（`writableStackTrace = false`）→ **不慢**（1.1×）
> - `InvariantViolationException`（有 trace）→ 慢，**而它應該慢**（它是 bug，頻率該接近 0）

### 4.11.2 那為什麼還是「不要用例外做流程控制」

**因為成本從來不是主要理由。** 三個真正的理由：

**理由 1：控制流變成隱形的**

```java
// 🔴 用例外做流程控制
public Money priceFor(String productId) {
    try {
        return priceList.lookup(productId);
    } catch (PriceNotFoundException e) {
        return defaultPrice(productId);            // ★ 這是正常路徑的一半
    }
}
```

**讀 `priceList.lookup()` 的簽章看不出「它可能走另一條路」** ——
而 `Optional<Money> lookup(...)` 看得出來。

**理由 2：`catch` 的範圍幾乎總是太寬**

```java
try {
    return priceList.lookup(productId);           // 想 catch 的是這個
} catch (PriceNotFoundException e) {
    return defaultPrice(productId);
}
```

**六個月後**：

```java
try {
    Product p = products.findById(productId);      // ★ 新增的一行
    return priceList.lookup(p.priceListId());     // 想 catch 的還是這個
} catch (PriceNotFoundException e) {
    return defaultPrice(productId);
    // 🔴 而 products.findById() 內部也可能拋 PriceNotFoundException
    //    （它查了一個 cached price）→ 靜默走 default
}
```

**理由 3：它讓「真正的錯誤」被同一個 `catch` 吃掉**

這是理由 2 的極端版本，也是 4.0 事故 3 的形狀。

> 📌 **三個理由都與效能無關。**
> 它們全部是**可讀性與正確性**的問題 ——
> 而那正是為什麼 4.11.1 的測量結果**不會改變這條建議**。

### 4.11.3 三個「其實可以」

**① 建構子的參數驗證**

```java
public Money {
    Objects.requireNonNull(amount, "amount");
    // ★ 這是「例外做流程控制」嗎？不是 —— 它沒有 catch
}
```

✅ **判準：「沒有人 catch 它」的例外不是流程控制，是斷言。**

**② 遞迴／深層搜尋的提早退出**

```java
/**
 * ★ 在深層巢狀結構裡找到目標就立刻跳出。
 *
 * <p>⚠️ 用例外跳出 20 層遞迴，比「每一層檢查回傳值」乾淨得多。
 * 而它的成本可以壓到接近零：{@code writableStackTrace = false}。
 */
private static final class Found extends RuntimeException {
    final Object value;
    Found(Object value) {
        super(null, null, false, false);          // ★ 無訊息、無 suppression、無 trace
        this.value = value;
    }
}
```

⚠️ **`super(null, null, false, false)` 的第三個 `false` 是 `enableSuppression`**，
而 `BusinessException` 用的是 `true`（04-controller 3.5.2）。

| 參數 | `BusinessException` | 這裡 |
|---|---|---|
| `enableSuppression` | `true`（try-with-resources 的 suppressed 例外要保留） | **`false`**（它不會有 suppressed） |
| `writableStackTrace` | `false` | `false` |

✅ **實測：`false, false` 的版本在 63 層深度下是 `new` 43ns / `throw`+`catch` 39ns** ——
與「回傳一個物件」（30ns）同一個量級。

⚠️⚠️ **而這個技巧有一個嚴格的使用條件**：

```
① 這個例外是 private（沒有人能從外面 catch 它）
② throw 與 catch 在同一個方法（或同一個類別）
③ catch 的範圍精確到一行
```

**shop-service 用到它的地方：0 處。**
（03 章 3.5.5 的串流匯出是最接近的候選，而它用 `Stream.takeWhile` 解決了。）

> 📌 **「有一個合理的用法，而我們沒有用到」值得寫下來**，
> 因為它讓「不要用例外做流程控制」從一條**教條**變成一個**有邊界的判斷**。

**③ 解析器的回溯**

```java
// 04-controller 06 章的 CursorCodec：解析游標失敗要試下一個格式
try {
    return CursorV2.decode(raw);
} catch (MalformedCursorException e) {
    return CursorV1.decode(raw);         // ★ 舊格式的游標（相容期）
}
```

✅ **可以**，而它需要一個明確的期限：

```java
/**
 * ⚠️ V1 相容路徑。
 *
 * <p><b>移除期限：2026-12-31</b>（游標的 TTL 是 7 天，
 * 所以上線 V2 之後 7 天就不會再有 V1 的游標）。
 *
 * <p>★ 而「期限」不是註解，是一條測試：
 * {@code CursorCompatibilityTest.v1相容期已過()} 在 2026-12-31 之後會紅燈。
 */
```

> 📌 **這是 4.7.5 那個「數量測試」的兄弟**：
> **過渡方案要有一個會自己響的鈴。**
> 那裡是「數量超過 1 就響」，這裡是「日期到了就響」。

### 4.11.4 `Optional` / 結果物件 / 例外的決策表

| 情況 | 用什麼 | 例子 |
|---|---|---|
| **「可能沒有」是正常的** | `Optional<T>` | `orders.findById(id)` |
| **「可能沒有」是錯誤，且呼叫端一定要處理** | ✅ **例外** | `orders.findById(id).orElseThrow(...)` |
| **有多種失敗原因，呼叫端要分別處理** | ✅ **結果物件**（`RefundOutcome`） | 4.10.2 情況 2 |
| **失敗要跨多層冒上去** | ✅ **例外** | 本章的業務例外（⚠️ 到底幾個 —— 見 4.12.1，答案是 **41**） |
| **失敗有不可回復的副作用** | ✅ **結果物件 + 外殼翻譯成例外** | 4.10.2 |
| 「找不到」在一個迴圈裡每次都可能發生 | 🔴 **不要例外** | 4.11.2 理由 1 |

⚠️ **最後一列值得一個具體數字。** 假設一個匯出跑 41 萬筆（03 章 3.5.5），
其中 3% 找不到價格：

| 做法 | 成本 |
|---|---|
| `Optional` + `orElse` | 410,000 × 30ns ≈ **12ms** |
| 例外（無 trace） | 410,000 × 0.03 × 35ns ≈ **0.4ms** ✅ **更快** |
| 例外（**有** trace） | 410,000 × 0.03 × 1,520ns ≈ **19ms** |

⚠️⚠️ **注意「例外（無 trace）」反而最快** —— 因為只有 3% 走那條路。

**而它仍然不是對的選擇**，理由是 4.11.2 的理由 1：
**19ms 或 0.4ms 在一個跑 40 秒的匯出裡都是雜訊，
而「讀不出控制流」的成本是永久的。**

> 📌 **這一節的結論**：
> **效能不是「不要用例外做流程控制」的理由，也不是它的反駁。**
> 兩邊都在 ms 級，而決定因素是**下一個讀這段程式碼的人**。

---

## 4.12 守門測試 ★★

### 4.12.1 「有幾個業務例外」——先讓機器數 🔴

**這一章到目前為止數了三次，三次都不一樣**：

| 誰數的 | 數字 |
|---|---|
| 00 章 0.12 ⑯ | 26 |
| 本章 4.5.7 | 32 |
| **`ClassGraph` 掃描（4.12.1 執行前）** | **40** |
| **`ClassGraph` 掃描（補上 4.12.1 找到的 `RefundWindowExpiredException` 之後）** | **41** |

⚠️⚠️ **前兩個是人數的，而兩個都錯。**
第三、第四個是機器數的 —— **而它們之間的差別，正是這個掃描測試找到的東西。**

**41 個的實際分佈**（實測輸出）：

| 套件 | 數量 |
|---|---|
| `order.domain.exception` | **20** |
| `order.application.exception` | 8 |
| `coupon.domain.exception` | 8 |
| `payment.domain.exception` | **4** |
| `stock.domain.exception` | 1 |
| **合計（具體類別）** | **41** |
| ＋抽象家族基底（`OrderStateException`、`CouponException`） | 2 |
| ＋`InvariantViolationException`（非業務例外） | 1 |
| **本章產出的類別總數** | **44** |

**為什麼人會數錯**（三個原因，都很平凡）：

| 原因 | 具體 |
|---|---|
| 1 | **後面的小節又加了新的** —— 4.6.1 加 `CouponAlreadyUsedException`、4.6.3 加 `NegativeStockNotAllowedException`、4.6.4 加 2 個、4.7.4 加 1 個 |
| 2 | **家族的「(N 個)」標題與實際列出的不符** —— 4.5.7 家族 3 寫「期限類（3 個）」而只給了 2 個（第三個 `REFUND_WINDOW_EXPIRED` 沒有例外） |
| 3 | 「32」是在寫 4.5.7 時數的，而 4.6 與 4.7 是之後才寫的 |

> 📌 **這就是這一節存在的理由。**
> 「有幾個」是一個**每次改動都會變的事實**，
> 而**人不該負責維護一個會變的數字**。

#### 掃描出「所有具體的業務例外」

⚠️ **這段程式碼有三個容易寫錯的地方，全部實測過。**

```java
package example.shop.common.error;

import io.github.classgraph.ClassGraph;
import io.github.classgraph.ScanResult;

import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;

class BusinessExceptionRegistryTest {

    /**
     * ★★ 所有具體的 BusinessException 子類別。
     *
     * <p>⚠️⚠️ 三個容易寫錯的地方：
     * <ol>
     *   <li><b>{@code enableAllInfo()} 而不是 {@code enableClassInfo()}</b> ——
     *       後者只給【直接】子類別。<b>實測：28 vs 43。</b></li>
     *   <li><b>要排除測試類別</b> —— 掃描會把測試裡的 inner class 也算進來。</li>
     *   <li>要排除 {@code abstract}（家族基底）。</li>
     * </ol>
     */
    static List<Class<? extends BusinessException>> concreteBusinessExceptions() {
        var out = new ArrayList<Class<? extends BusinessException>>();
        try (ScanResult scan = new ClassGraph()
                .enableAllInfo()                                       // ★ ①
                .acceptPackages("example.shop")
                .scan()) {
            scan.getSubclasses(BusinessException.class.getName())
                .loadClasses(BusinessException.class)
                .stream()
                .filter(c -> !Modifier.isAbstract(c.getModifiers()))   // ★ ③
                .filter(c -> !c.getName().contains("Test"))            // ★ ②
                .sorted(java.util.Comparator.comparing(Class::getName))
                .forEach(out::add);
        }
        return out;
    }
}
```

⚠️⚠️ **第 ① 點是本節最重要的發現，值得完整看實測**：

```
enableClassInfo()  →  getSubclasses(BusinessException) = 28
enableAllInfo()    →  getSubclasses(BusinessException) = 43
```

**差的 15 個是誰**：

| 漏掉的 | 為什麼 |
|---|---|
| `OrderNotShippableException` 等 **4 個** | 它們繼承 `OrderStateException`（家族基底）→ **不是 `BusinessException` 的直接子類別** |
| **8 個** coupon 例外 | 它們繼承 `CouponException` → 同上 |
| `OrderStateException` / `CouponException` 本身 | abstract（本來就要排除） |
| 1 個測試的 inner class | 要排除 |

🔴 **而「漏掉 12 個具體例外」的後果是災難性的**：

```
4.6.2 的「每個 422 都有 errors[]」→ 漏檢 8 個 coupon 例外
4.8.7 的 args() 守門人 → 12 個例外從來沒被實例化過 → 檢查沒跑到
4.12.2 的訊息參數檢查 → 同上
```

**而這個 bug 的表現形式是：所有測試都綠。**

> 📌📌 **這是本章最重要的一個一般規則**：
>
> **一個「掃描全部 X」的測試，最危險的失敗方式不是紅燈，是「掃到的比你以為的少」。**
>
> ✅ **所以掃描測試必須斷言「掃到幾個」**：
>
> ```java
> assertThat(all).hasSizeGreaterThanOrEqualTo(41);
> ```
>
> ⚠️ 而**不要**寫成 `isEqualTo(41)` —— 那會讓「正常地新增一個例外」變成紅燈。
> `>= 41` 抓的是「掃描機制壞掉」，而不是「例外數量變了」。

⚠️ **注意 4.5.7 家族 1 與家族 5 的「`package-private` + `abstract`」設計
在這裡付了一筆學費**：

| 設計 | 買到什麼 | 付了什麼 |
|---|---|---|
| 家族基底 `package-private` + `abstract` | ✅ 沒有人能 catch 它（4.5.7） | 🔴 **讓「直接子類別」的掃描漏掉 12 個** |

**這不是「設計錯了」，是「一個決定在另一個地方有代價」** ——
而那個代價**只在跑了掃描測試之後才看得到**。

#### 「每個 `ErrorCode` 都有例外用它」

**反射做不到這件事**：

```java
// 🔴 ErrorCode.X 在建構子裡是一次 getstatic —— 反射看不到
for (var f : exceptionClass.getDeclaredFields()) { ... }
```

✅ **用 ArchUnit 讀位元碼**：

```java
private static final JavaClasses MAIN = new ClassFileImporter()
        .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
        .importPackages("example.shop");

/**
 * ★★ 用 ArchUnit 讀「哪些 ErrorCode 常數被例外類別引用」。
 *
 * <p>⚠️ 為什麼不用反射：{@code ErrorCode.X} 在建構子裡是一次
 * {@code getstatic}，反射看不到它。ArchUnit 的
 * {@code getFieldAccessesFromSelf()} 讀的是<b>位元碼</b>，看得到。
 *
 * <p>⚠️⚠️ 而它也是「掃描測試」——所以它也需要
 * {@code assertThat(used).isNotEmpty()} 這條下限斷言。
 */
static Set<ErrorCode> codesUsedByExceptions() {
    Set<ErrorCode> used = EnumSet.noneOf(ErrorCode.class);
    MAIN.stream()
        .filter(c -> c.isAssignableTo(BusinessException.class))
        .flatMap(c -> c.getFieldAccessesFromSelf().stream())
        .filter(a -> a.getTargetOwner().getName().equals(ErrorCode.class.getName()))
        .forEach(a -> {
            try { used.add(ErrorCode.valueOf(a.getTarget().getName())); }
            catch (IllegalArgumentException ignored) {
                // ⚠️ enum 的合成欄位（$VALUES）也會被掃到 —— 它不是常數
            }
        });
    return used;
}
```

⚠️ **那個 `catch (IllegalArgumentException ignored)` 是必要的**：
enum 編譯後有一個 `private static final ErrorCode[] $VALUES` 欄位，
而 `ErrorCode.values()` 會讀它 —— 於是掃描會看到 `$VALUES` 這個「欄位名」。

**實測結果**：

```
有例外的 code = 41 / 沒有例外的 code = 57
```

**57 個沒有例外的 code，分成四類**：

| 類別 | 數量 | 例子 | 該怎麼處理 |
|---|---|---|---|
| **框架／Web 層產生**（`SpringExceptionMapper`，04-controller 3.7.3） | 21 | `MALFORMED_REQUEST`、`METHOD_NOT_ALLOWED`、`UNSUPPORTED_MEDIA_TYPE` | ✅ 正常，加進白名單 |
| **5xx**（不該有業務例外） | 11 | `INTERNAL_ERROR`、`UPSTREAM_ERROR`、`SERVICE_UNAVAILABLE` | ✅ 正常，加進白名單 |
| **後續站台**（09-spring-security、購物車） | 20 | `AUTHENTICATION_REQUIRED`、`CART_EMPTY` | ⚠️ `PLANNED_FOR_LATER`，**要標哪一站** |
| 🔴 **本站該有但漏了** | **5** | 見下 | 🔴 **要補** |

🔴 **五個漏掉的**：

| code | 該由誰拋 | 為什麼漏了 |
|---|---|---|
| **`INSUFFICIENT_STOCK`** | `Stock.reserve()` | ⚠️ 04-controller 3.5.3 定義了 `InsufficientStockException`，而**本站沒有把它搬到新套件** —— 它還在不存在的 `order.service.exception` 裡 |
| **`VALIDATION_FAILED`** | `ValidationFailedException` | 同上（在 `common.error`，04-controller 3.5.3 例子 3）—— ⚠️ 它其實**存在**，只是不在本站的掃描範圍 |
| **`RESOURCE_NOT_FOUND`** | `ResourceNotFoundException` | 同上 |
| **`IDEMPOTENCY_KEY_REUSED`** | `IdempotencyStore.record()` | 同上（04-controller 4.13.6） |
| **`REFUND_WINDOW_EXPIRED`** | ⚠️ **沒有人** | 4.5.7 家族 3 標題寫「期限類（3 個）」而只給了 2 個 —— **這是第三個** |

⚠️⚠️ **前四個是「掃描範圍的問題」而不是「真的漏了」**，
而那本身是一個發現：

> 📌 **這個掃描測試同時暴露了一件事**：
> 04-controller 定義的四個例外，**本站從來沒有確認它們還編譯得過** ——
> 而它們的套件（`order.service.exception`）在 00 章 0.14.3 就被拆掉了。
>
> ✅ **處置**：4.13 的修正表把它們列進去（搬套件 + 確認編譯）。

**第五個是真的漏了**，補上：

```java
package example.shop.payment.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/**
 * 金流商的退款期限已過（付款 + 180 天）。
 *
 * <p>⚠️⚠️ 與 {@code RETURN_WINDOW_EXPIRED} 的差別是 00 章 0.12 ⑮ 特別強調的：
 * <table>
 *   <tr><th></th><th>期限</th><th>誰定的</th><th>過期後</th></tr>
 *   <tr><td>{@code RETURN_WINDOW_EXPIRED}</td><td>送達 +7 天</td>
 *       <td>我們</td><td>✅ 客服可以通融</td></tr>
 *   <tr><td><b>本例外</b></td><td>付款 +180 天</td>
 *       <td><b>金流商</b></td><td>🔴 無解，只能人工匯款</td></tr>
 * </table>
 *
 * <p>★ 所以它<b>沒有</b> {@code alternativeAction}（「聯絡客服」也沒用），
 * 而改帶 {@code manualTransferRequired = true}。
 */
public class RefundWindowExpiredException extends BusinessException
        implements DomainException {

    public RefundWindowExpiredException(String paymentId, Instant paidAt,
                                        int windowDays, LocalDate expiredOn) {
        super(ErrorCode.REFUND_WINDOW_EXPIRED,
              "Refund window (%d days from %s) for payment %s expired on %s."
                      .formatted(windowDays, paidAt, paymentId, expiredOn),
              null,
              ext("paymentId", paymentId, "paidAt", paidAt,
                  "windowDays", windowDays, "expiredOn", expiredOn,
                  // ★ 唯一能做的事：走人工匯款流程
                  "manualTransferRequired", true),
              args(windowDays, expiredOn),
              List.of());
    }
}
```

⚠️ **注意它用了 4.8.7 的 `args(...)`** —— 而 `expiredOn` 是 `LocalDate`，
所以它會被 `normalizeArg` 格式化成 `2026/09/03`。
**如果寫成 `args(windowDays, expiredOn.toString())`，`args()` 會拋例外**
（`"2026-09-03"` 符合 `PREFORMATTED` 的 pattern）。

#### 白名單怎麼寫才不會腐敗

```java
/**
 * ★★ 「沒有業務例外」是正當的三種情況。
 *
 * <p>⚠️⚠️ 每一個 PLANNED_FOR_LATER 的項目<b>必須標哪一站會實作它</b>。
 * 理由（4.6.4 的教訓）：
 * <b>「已規劃」清單讓「還沒實作」與「忘記實作」在測試上長得一樣。</b>
 */
@Test
void 每個ErrorCode都有例外或有正當理由() {
    var used = codesUsedByExceptions();

    // ── ① 框架／Web 層產生（SpringExceptionMapper）────────────
    Set<ErrorCode> byFramework = EnumSet.of(
            ErrorCode.MALFORMED_REQUEST, ErrorCode.UNKNOWN_PARAMETER,
            ErrorCode.METHOD_NOT_ALLOWED, ErrorCode.NOT_ACCEPTABLE,
            ErrorCode.UNSUPPORTED_MEDIA_TYPE, ErrorCode.PAYLOAD_TOO_LARGE,
            ErrorCode.ENDPOINT_NOT_FOUND, ErrorCode.INVALID_CURSOR,
            ErrorCode.MALFORMED_ETAG, ErrorCode.IF_MATCH_REQUIRED,
            ErrorCode.IDEMPOTENCY_KEY_REQUIRED, ErrorCode.FORBIDDEN_PARAMETER,
            ErrorCode.DEEP_PAGINATION_LIMIT, ErrorCode.RATE_LIMIT_EXCEEDED,
            ErrorCode.SCAN_PENDING, ErrorCode.UPLOAD_INTENT_EXPIRED,
            ErrorCode.DOWNLOAD_LINK_EXPIRED, ErrorCode.RESOURCE_GONE,
            ErrorCode.PRODUCT_IMAGE_LIMIT_EXCEEDED, ErrorCode.PHOTO_NOT_FOUND,
            ErrorCode.UNDELIVERABLE_ADDRESS);

    // ── ② 5xx：不該有業務例外（4.3.1 的二分法）───────────────
    Set<ErrorCode> serverErrors = EnumSet.allOf(ErrorCode.class).stream()
            .filter(ErrorCode::isServerError)
            .collect(java.util.stream.Collectors
                    .toCollection(() -> EnumSet.noneOf(ErrorCode.class)));

    // ── ③ 後續站台，★★ 每一項都標「哪一站」──────────────────
    Map<ErrorCode, String> plannedForLater = new java.util.EnumMap<>(ErrorCode.class);
    // 09-spring-security
    plannedForLater.put(ErrorCode.AUTHENTICATION_REQUIRED, "09-spring-security");
    plannedForLater.put(ErrorCode.INVALID_TOKEN,           "09-spring-security");
    plannedForLater.put(ErrorCode.TOKEN_EXPIRED,           "09-spring-security");
    plannedForLater.put(ErrorCode.TOKEN_REVOKED,           "09-spring-security");
    plannedForLater.put(ErrorCode.ACCOUNT_SUSPENDED,       "09-spring-security");
    plannedForLater.put(ErrorCode.INSUFFICIENT_SCOPE,      "09-spring-security");
    plannedForLater.put(ErrorCode.EMAIL_ALREADY_REGISTERED,"09-spring-security");
    // 06-cart（購物車站）
    plannedForLater.put(ErrorCode.CART_EMPTY,              "06-cart");
    plannedForLater.put(ErrorCode.CART_ITEM_NOT_FOUND,     "06-cart");
    // 07-payment（金流站）
    plannedForLater.put(ErrorCode.CARD_DECLINED,           "07-payment");
    plannedForLater.put(ErrorCode.CARD_EXPIRED,            "07-payment");
    plannedForLater.put(ErrorCode.CARD_NUMBER_INVALID,     "07-payment");
    plannedForLater.put(ErrorCode.CVV_INVALID,             "07-payment");
    plannedForLater.put(ErrorCode.INSUFFICIENT_FUNDS,      "07-payment");
    plannedForLater.put(ErrorCode.EXCEEDS_CREDIT_LIMIT,    "07-payment");
    plannedForLater.put(ErrorCode.PAYMENT_DECLINED,        "07-payment");
    plannedForLater.put(ErrorCode.PAYMENT_METHOD_UNSUPPORTED, "07-payment");
    plannedForLater.put(ErrorCode.PAYMENT_NOT_REFUNDABLE,  "07-payment");
    plannedForLater.put(ErrorCode.PAYMENT_ALREADY_IN_PROGRESS, "07-payment");
    // 08-product（商品站）
    plannedForLater.put(ErrorCode.PRODUCT_SKU_DUPLICATE,   "08-product");
    plannedForLater.put(ErrorCode.PURCHASE_LIMIT_EXCEEDED, "08-product");
    plannedForLater.put(ErrorCode.ORDER_ALREADY_CANCELLED, "05-service 07 章練習");
    plannedForLater.put(ErrorCode.ORDER_EXPIRED,           "05-service 06 章（排程逾時取消）");

    var missing = new java.util.TreeMap<String, String>();
    for (ErrorCode code : ErrorCode.values()) {
        if (used.contains(code) || byFramework.contains(code)
                || serverErrors.contains(code)) { continue; }
        String station = plannedForLater.get(code);
        if (station == null) {
            missing.put(code.name(), "🔴 沒有例外，也不在任何白名單裡");
        }
    }

    assertThat(missing)
            .as("""
                以下 ErrorCode 沒有任何業務例外使用它。
                每一個 code 被觸發時都會 fallthrough 成 500（4.6.4）。
                請補上例外，或加進三個白名單之一（並說明理由）。
                """)
            .isEmpty();
}

/**
 * ★★ PLANNED_FOR_LATER 裡標「本站」的項目，在本站結束時必須是空的。
 *
 * <p>它是 4.6.4 那個教訓的機制化：
 * <b>「已規劃」不可以是一個永久的垃圾桶。</b>
 */
@Test
void 本站的已規劃項目在本站結束時要清空() {
    // ⚠️ 這個測試現在【會紅燈】——而那是刻意的（見 4.16 的驗收清單）。
    //    ORDER_ALREADY_CANCELLED 與 ORDER_EXPIRED 都標了「05-service」。
}
```

⚠️⚠️ **最後那個測試「現在會紅燈」，而它是刻意的** ——
與 00 章 0.9.5 那個「狀態機的每一條邊都有對應的操作」是同一個手法：

> 📌 **一個可執行的待辦比 `// TODO` 可靠。**

### 4.12.2 訊息與參數的一致性

**04-controller 3.4.5 有四個一致性測試。本章加兩個。**

**新增 1：解析後的訊息不含未替換的佔位符**（4.8.2 已給程式碼）

**新增 2：實例化每一個例外**

```java
/**
 * ★★ 用「每個例外的範例參數」實例化它，然後跑一組通用斷言。
 *
 * <p>⚠️ 這是本章 <b>五組守門測試的共同基礎</b> ——
 * 4.5.3、4.6.2、4.8.2、4.8.7 全部需要「一個真的例外實例」。
 *
 * <h3>⚠️⚠️ 為什麼不用反射自動產生參數</h3>
 * <p>試過，不可行：
 * <ul>
 *   <li>{@code MixedCurrencyException} 收 {@code List<OffendingLine>} ——
 *       空 list 會讓 {@code errors[]} 是空的 → 4.6.2 的測試誤報。</li>
 *   <li>{@code CouponMinAmountNotMetException} 的建構子是 <b>private</b>
 *       （只有 static factory）→ 反射拿不到。</li>
 *   <li>{@code OrderNotEditableException} 同上。</li>
 *   <li>{@code Money.twd("0")} 會讓 {@code shortfall} 是 0 → 訊息「還差 0 元」
 *       通得過測試但沒有測到東西。</li>
 * </ul>
 *
 * <p>👉 <b>所以 fixture 是手寫的</b>，而「手寫會漏」用一條測試守：
 * {@link #每個具體例外都有fixture()}。
 */
final class ExceptionFixtures {

    private static final Actor CUSTOMER =
            new Actor(Actor.ActorType.CUSTOMER, "cus_1", "王小明");
    private static final Instant NOW = Instant.parse("2026-08-27T08:00:00Z");

    static List<BusinessException> all() {
        return List.of(
            new OrderEmptyException("ORD-1"),
            new OrderItemLimitExceededException("ORD-1", 120, 100),
            new OrderNotShippableException("ORD-1", "ORD-2026-0827-0001",
                    OrderStatus.SHIPPED, EnumSet.of(OrderStatus.PAID)),
            new OrderNotCancellableException("ORD-1", "ORD-2026-0827-0001",
                    OrderStatus.SHIPPED, EnumSet.of(OrderStatus.PAID),
                    LocalDate.of(2026, 9, 3)),
            OrderNotEditableException.forActor("ORD-1", "ORD-2026-0827-0001",
                    OrderStatus.SHIPPED, OrderStatus.editableStates(), CUSTOMER, false),
            new SelfCancelWindowExpiredException("ORD-1", "ORD-2026-0827-0001",
                    NOW, Duration.ofMinutes(30), CUSTOMER),
            new NoteTooLongException("ORD-1", "internalNote", 3417, 2000),
            new MixedCurrencyException("TWD",
                    List.of(new MixedCurrencyException.OffendingLine(2, "P-1001", "JPY"))),
            CouponMinAmountNotMetException.of("SUMMER10",
                    Money.twd("1500"), Money.twd("1180")),
            // …共 40 筆
            new RefundWindowExpiredException("PAY-1", NOW, 180, LocalDate.of(2027, 2, 23))
        );
    }
}
```

```java
/**
 * ★★ 每一個具體的業務例外都要在 fixture 裡出現一次。
 *
 * <p>它讓「手寫 fixture」這個選擇變成安全的 ——
 * 新增第 41 個例外而忘了加 fixture → CI 紅燈。
 */
@Test
void 每個具體例外都有fixture() {
    var covered = ExceptionFixtures.all().stream()
            .map(Object::getClass)
            .collect(java.util.stream.Collectors.toSet());

    var missing = concreteBusinessExceptions().stream()
            .filter(c -> !covered.contains(c))
            .map(Class::getSimpleName)
            .sorted()
            .toList();

    assertThat(missing)
            .as("""
                以下例外沒有 fixture。
                本章有五組守門測試需要「一個真的實例」（4.12.2），
                而沒有 fixture 的例外【不會被任何一組檢查到】。
                """)
            .isEmpty();
}
```

> 📌📌 **「每個具體例外都有 fixture」這條測試是整組守門測試的樑柱。**
>
> ⚠️ 沒有它，另外五組測試會**靜默地只檢查一部分** ——
> 而那正是 4.12.1 那個 `enableClassInfo()` bug 的同一個形狀：
> **「掃到的比你以為的少」。**

#### 五組測試跑起來的實際輸出

```
fixture 覆蓋 41 / 具體例外 41                     ✅

--- 422 但沒有 errors[] 的 (7) ---
  OrderEmptyException (ORDER_EMPTY)
  OrderItemLimitExceededException (ORDER_ITEM_LIMIT_EXCEEDED)
  NoteTooLongException (ORDER_NOTE_TOO_LONG)
  ReturnRequestEmptyException (RETURN_REQUEST_EMPTY)
  OrderAmountMismatchException (ORDER_AMOUNT_MISMATCH)
  RefundExceedsPaymentException (REFUND_EXCEEDS_PAYMENT)
  RefundRejectedException (REFUND_REJECTED)

--- extensions 型別違反 (0) ---                   ✅
--- 金額欄位不是 String (0) ---                    ✅
--- 未替換的佔位符 (0) ---                         ⚠️ 見下
```

**✅ 兩個好消息**：

| 結果 | 意義 |
|---|---|
| `extensions 型別違反 (0)` | 4.5.3 規則 1 在 41 個例外上全部成立 —— **`Money` 物件一個都沒漏進去** |
| `金額欄位不是 String (0)` | 規則 2 同上 |

**⚠️ 而 `422 但沒有 errors[] (7)` 比 4.6.2 預估的 9 個少 2 個**，
因為 `MixedCurrencyException` 與 6 個 coupon 例外**本來就有** `errors[]` ——
4.6.2 那張表把它們標成「✅ 已有」是對的，只是總數算錯了。

**七個的處置**（依 4.6.2 的決定）：

| 例外 | `field` | 理由 |
|---|---|---|
| `OrderEmptyException` | `null` | 全域錯誤（整張訂單沒有明細） |
| `OrderItemLimitExceededException` | `"items"` | 指向整個陣列 |
| `NoteTooLongException` | **`null`** | ⚠️ Domain 不知道欄位路徑（4.2.6） |
| `ReturnRequestEmptyException` | `null` | 與 `ORDER_EMPTY` 對稱 |
| `OrderAmountMismatchException` | `"totalAmount"` | ✅ 它知道欄位 |
| `RefundExceedsPaymentException` | `"refundAmount"` | ✅ 它知道欄位 |
| `RefundRejectedException` | **`null`** | ⚠️ 沒有任何欄位是錯的（4.6.2 那個「兩種 null」） |

#### 🔴 `未替換的佔位符 (0)` 是一個假的綠燈

⚠️⚠️ **這個 0 不代表「41 個訊息都正確」** —— 它代表：

```java
String rendered = MS.getMessage(ex.errorCode().userMessageKey(),
        ex.userMessageArgs(), "MISSING_KEY", Locale.TAIWAN);
//                            ↑ fallback
```

**測試用的 properties 只定義了 6 個訊息**，
其餘 35 個走 fallback `"MISSING_KEY"` ——
**而 `"MISSING_KEY"` 裡沒有 `{n}`，所以測試通過。**

🔴 **一個「沒有訊息」的 code 通過了「訊息正確」的測試。**

✅ **修法：這條測試必須與「每個 code 都有訊息」配對**
（04-controller 3.4.5 的 `訊息完整()`）：

```java
/**
 * ★★ 4.8.2 的那條測試【必須】搭配這一條。
 *
 * <p>⚠️ 單獨跑「解析後不含 {n}」會有假綠燈：
 * 找不到 key 時 {@code getMessage} 回 fallback，而 fallback 裡沒有 {n}。
 *
 * <p>👉 <b>用一個哨兵值讓「找不到」與「找到了」可以分辨。</b>
 */
@ParameterizedTest
@MethodSource("everyBusinessExceptionInstance")
void 每個例外的訊息key都存在(BusinessException ex) {
    String key = ex.errorCode().userMessageKey();
    // ★ 哨兵：一個絕不可能是真實文案的字串
    String sentinel = "<<<MISSING:" + key + ">>>";
    String rendered = MS.getMessage(key, ex.userMessageArgs(), sentinel, Locale.TAIWAN);

    assertThat(rendered)
            .as("%s 用的 code %s 沒有 error.<CODE>.user 訊息（4.8.6 第 2 步）",
                ex.getClass().getSimpleName(), ex.errorCode())
            .isNotEqualTo(sentinel);
}
```

> 📌📌 **這是本章第三次遇到同一類問題**（前兩次是 4.2.3 的錯規則、
> 4.12.1 的 `enableClassInfo`）：
>
> **一個測試「通過」有兩種原因：真的正確，或者它沒檢查到。**
>
> ⚠️ **而分辨兩者的方法只有一個：讓它失敗一次。**
> 把 `error.INSUFFICIENT_STOCK.user` 從 properties 刪掉，
> 這條測試該紅燈 —— **如果沒紅，那它就是裝飾品。**

### 4.12.3 ArchUnit：例外的位置與拋出範圍

**五條規則，而其中兩條抓過真的 bug。**

```java
package example.shop.architecture;

import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

@AnalyzeClasses(packages = "example.shop",
                importOptions = com.tngtech.archunit.core.importer
                        .ImportOption.DoNotIncludeTests.class)
class ExceptionArchitectureTest {

    /** ① 業務例外只能住在 {@code *.exception} 或 {@code common.error}。 */
    @ArchTest
    static final ArchRule 業務例外的套件 =
            classes().that().areAssignableTo(
                            example.shop.common.error.BusinessException.class)
                     .and().areNotInterfaces()
                     .should().resideInAnyPackage("..exception..", "example.shop.common.error")
                     .because("4.3.7：例外的套件 = 拋出它的那一層");

    /** ② Web 層不可以 new 業務例外。 */
    @ArchTest
    static final ArchRule web層不可建立業務例外 =
            noClasses().that().resideInAPackage("..web..")
                       .should().accessClassesThat()
                       .areAssignableTo(example.shop.common.error.BusinessException.class)
                       .because("""
                                業務規則屬於 Service／Domain（00 章 0.10.6）。
                                Web 層需要的錯誤走 Bean Validation 或 SpringExceptionMapper。
                                """);

    /** ③ ★ 實作 DomainException 的例外必須住在 {@code domain} 套件。 */
    @ArchTest
    static final ArchRule DomainException只在domain套件 =
            classes().that().implement(
                            example.shop.common.error.marker.DomainException.class)
                     .should().resideInAPackage("..domain..")
                     .because("""
                              4.3.4：這個標記代表「Web 層本來應該擋掉但沒擋到」，
                              而只有 domain 層的最後一道防線有這個語意。
                              """);

    /** ④ ★★ ActorScopedStatus 的實作者不可超過一個（4.7.5）。 */
    @ArchTest
    static final ArchRule ActorScopedStatus只有一個實作 =
            classes().that().implement(
                            example.shop.common.error.marker.ActorScopedStatus.class)
                     .should(new com.tngtech.archunit.lang.ArchCondition<
                             com.tngtech.archunit.core.domain.JavaClass>("是唯一的實作者") {
                         private final java.util.List<String> found = new java.util.ArrayList<>();
                         @Override
                         public void check(com.tngtech.archunit.core.domain.JavaClass c,
                                           com.tngtech.archunit.lang.ConditionEvents events) {
                             found.add(c.getSimpleName());
                             if (found.size() > 1) {
                                 events.add(com.tngtech.archunit.lang.SimpleConditionEvent
                                         .violated(c, """
                                             ActorScopedStatus 有 %d 個實作者：%s
                                             它是一個【過渡方案】（4.7.5）——
                                             超過一個實例就該改用「授權前置」（4.7.2 選項 ④）。
                                             """.formatted(found.size(), found)));
                             }
                         }
                     });

    /**
     * ⑤ ★ {@code Stock.applyDelta} 只能被 {@code order} 套件呼叫（4.6.3）。
     *
     * <p>⚠️ 它守的是「同一個檢查、兩種嚴重程度」那個決定 ——
     * 倉管的介面呼叫 {@code applyDelta} 會讓「輸入錯誤」變成 500 + 告警。
     */
    @ArchTest
    static final ArchRule applyDelta只給order套件用 =
            noClasses().that().resideOutsideOfPackages("..order..", "..stock..")
                       .should().callMethod(example.shop.stock.domain.Stock.class,
                                            "applyDelta", int.class,
                                            example.shop.order.domain.Actor.class,
                                            java.time.Instant.class)
                       .because("""
                                4.6.3：applyDelta 的失敗是 500 + 告警（系統內部的庫存變動）。
                                人工操作要用 adjustByOperator（409）。
                                """);
}
```

⚠️ **規則 ② 的一個實務問題**：`accessClassesThat().areAssignableTo(BusinessException.class)`
**會把「advice 讀 `ex.errorCode()`」也算成違反** ——
而那是 advice 的本職。

**修法：把 advice 排除**：

```java
    @ArchTest
    static final ArchRule web層不可建立業務例外 =
            noClasses().that().resideInAPackage("..web..")
                       // ★ advice 與 ProblemFactory 必須認識 BusinessException
                       .and().haveSimpleNameNotEndingWith("ExceptionHandler")
                       .and().haveSimpleNameNotEndingWith("ProblemFactory")
                       .should().callConstructorWhere(
                               com.tngtech.archunit.base.DescribedPredicate.describe(
                                   "是 BusinessException 的建構子",
                                   call -> call.getTargetOwner().isAssignableTo(
                                           example.shop.common.error.BusinessException.class)))
                       .because("業務規則屬於 Service／Domain（00 章 0.10.6）");
```

⚠️⚠️ **注意從 `accessClassesThat()` 改成 `callConstructorWhere()`** ——
這是一個**語意的修正**而不只是排除例外：

| 寫法 | 抓什麼 |
|---|---|
| `accessClassesThat().areAssignableTo(...)` | 🔴 **任何接觸**（讀欄位、呼叫方法、當參數型別） |
| `callConstructorWhere(...)` | ✅ **只抓「建立一個新的」** |

**而我們要禁止的是「Web 層自己決定業務規則」= 建立例外**，
不是「Web 層認識例外型別」（那是必要的）。

> 📌 **一般規則**：
> **ArchUnit 的規則寫得太寬時，第一反應不該是「加排除清單」，
> 而該是「我是不是用錯了述詞」。**
> （4.8.7 那條 `callMethod(Money, "toPlainString")` 是相反的情況 ——
> 那裡**沒有**更精確的述詞可用，所以才放棄 ArchUnit。）

### 4.12.4 把 41 個 `userMessage` 全部印出來 ★★

**4.8.7 的「印出來的測試」只跑了 6 個例外。把它擴大到全部 41 個。**

```java
@Test
void 印出41個例外的userMessage() {
    for (var ex : ExceptionFixtures.all()) {
        Problem p = factory.from(ex, "/api/orders/ORD-1");
        System.out.printf("%-3d %-34s | %s%n",
                p.status(), ex.getClass().getSimpleName().replace("Exception", ""),
                p.userMessage());
    }
}
```

#### 第一次跑：三個一模一樣的 bug 🔴

```
409 OrderNotShippable        | 此訂單目前的狀態（已出貨）無法出貨。          ✅
409 OrderNotDeliverable      | 此訂單目前的狀態（已付款）無法標記為已送達。   ✅
409 OrderNotReturnable       | 此訂單目前的狀態（已付款）無法申請退貨。      ✅
409 OrderAlreadyPaid         | 此訂單已經付款完成（已付款），無法再次付款。   ✅
409 OrderNotCancellable      | 此訂單目前的狀態（SHIPPED）無法取消。        🔴
409 OrderNotEditable         | 訂單已進入處理流程（SHIPPED），項目無法再修改。 🔴
409 OrderAddressNotEditable  | 此訂單目前的狀態（SHIPPED）無法修改收件地址。 🔴
```

⚠️⚠️ **前四個對，後三個錯 —— 而分界線恰好是「有沒有繼承 `OrderStateException`」。**

| 例外 | 家族 | `userMessageArgs` |
|---|---|---|
| `OrderNotShippable` / `NotDeliverable` / `NotReturnable` / `AlreadyPaid` | ✅ **家族 1** | 在基底改一行 → 四個一起好了 |
| `OrderNotCancellable`（4.5.7 家族 2） | 🔴 **不在家族裡**（它要 `alternativeAction`） | 🔴 **各自留著 `current.name()`** |
| `OrderNotEditable`（4.7.4） | 🔴 不在家族裡（它有兩個 code） | 🔴 同上 |
| `OrderAddressNotEditable`（4.6.4） | 🔴 不在家族裡（它有 `alternativeAction`） | 🔴 同上 |

> 📌📌 **這是 4.5.7 那個「家族基底」設計最好的一次驗證，也是最好的一次警告**：
>
> ✅ **家族基底讓「改一行修四個」成為可能。**
> 🔴 **而「不在家族裡的那三個」是設計上刻意的例外 —— 於是它們也是修正的例外。**
>
> ⚠️ **一般規則**：
> **每一個「刻意不套用共同基底」的類別，都是一個未來會漏掉修正的位置。**
> 而那不是「不要用基底」的理由 ——
> 是「**改基底的時候要去看誰沒繼承它**」的理由。

**修法（三處，各一行）**：

```java
// OrderNotCancellableException / OrderAddressNotEditableException
- new Object[]{current.name()},
+ args(current),

// OrderNotEditableException（它有兩個分支）
- lacksPrivilege ? new Object[0] : new Object[]{current.name()},
+ lacksPrivilege ? new Object[0] : args(current),
```

⚠️ **`lacksPrivilege` 那一支保持 `new Object[0]`** ——
403 的訊息（`error.INSUFFICIENT_ROLE.user=您沒有權限執行此操作。`）**沒有參數**，
而 4.7.4 那段「兩個 code 的 `extensions` 刻意不同」在這裡有第二個面：
**兩個 code 的 `userMessageArgs` 也不同。**

#### ✅ 修正後的完整輸出（41 句）

```
422 OrderEmpty                    | 訂單沒有任何商品，請加入商品後再送出。
422 OrderItemLimitExceeded        | 單張訂單最多 100 項商品，目前是 120 項。
409 OrderNotShippable             | 此訂單目前的狀態（已出貨）無法出貨。
409 OrderNotDeliverable           | 此訂單目前的狀態（已付款）無法標記為已送達。
409 OrderNotReturnable            | 此訂單目前的狀態（已付款）無法申請退貨。
409 OrderAlreadyPaid              | 此訂單已經付款完成（已付款），無法再次付款。
409 OrderNotCancellable           | 此訂單目前的狀態（已出貨）無法取消。
409 OrderNotEditable              | 訂單已進入處理流程（已出貨），項目無法再修改。
409 OrderAddressNotEditable       | 此訂單目前的狀態（已出貨）無法修改收件地址。
409 SelfCancelWindowExpired       | 下單後 30 分鐘內才能自行取消，請聯絡客服協助。
422 CancelNoteRequired            | 選擇「OTHER」這個原因時必須填寫說明。         ⚠️ 見下
422 NoteTooLong                   | 備註最多 2,000 個字，目前是 3,417 個字，請縮短後再送出。
422 MixedCurrency                 | 購物車中有商品的計價幣別與訂單幣別（TWD）不同，請移除後再結帳。
422 ShipmentQuantityExceeded      | 這項商品最多還能出 2 件。
422 ReturnQuantityExceeded        | 這項商品最多可退 2 件。
422 ReturnItemNotInOrder          | 有商品不在這張訂單裡，請重新選擇。
422 ItemNotReturnable             | 「有機蔬菜箱」屬於不可退貨的商品類別。
409 ReturnWindowExpired           | 退貨期限為送達後 7 天（2026/09/03 截止），如有疑問請聯絡客服。
409 InvoiceAlreadyIssued          | 此訂單的發票已於 2026/08/27 16:00 開立，如需更改請聯絡客服。
409 InvoiceRequestInFlight        | 開票請求正在處理中，請稍後再試。
422 EmptyPatch                    | 沒有指定任何要修改的欄位。
403 InternalFieldNotEditable      | 您沒有權限修改「internalNote」。              ⚠️ 見下
422 ProductNotFound               | 有 1 項商品不存在，請重新選擇。
410 ProductDiscontinued           | 「無線降噪耳機 Pro」已下架，無法購買。
422 ProductNotPurchasable         | 「無線降噪耳機 Pro」目前無法購買，請稍後再試或選擇其他商品。
422 ReturnRequestEmpty            | 退貨申請沒有選擇任何商品。
422 OrderAmountMismatch           | 訂單金額已變更為 1500 元，請重新確認後再送出。
429 AddressChangeLimitExceeded    | 一天最多修改 3 次地址，請於 2026/08/27 17:00 後再試。
404 CouponNotFound                | 折扣碼「SUMMER10」不存在，請確認後再輸入。
422 CouponExpired                 | 這張折扣碼已於 2026/08/27 16:00 過期。
422 CouponNotStarted              | 這張折扣碼將於 2026/08/28 16:00 開始生效。
409 CouponExhausted               | 這張折扣碼的數量已經用完了。
422 CouponMinAmountNotMet         | 還差 320 元才能使用這張折扣碼。
422 CouponNotApplicable           | 這張折扣碼不適用於購物車中的商品。
409 CouponAlreadyApplied          | 這張訂單已套用折扣碼「WINTER20」，請先移除後再套用新的。
409 CouponAlreadyUsed             | 這張折扣碼您已達使用次數上限（1 次）。        ⚠️ 見下
422 RefundExceedsPayment          | 這筆付款最多可退 1200 元。
422 RefundRejected                | 金流商無法退款 1200 元至原付款方式，客服將協助您以人工匯款處理。
412 OptimisticLockConflict        | 這筆資料剛剛被其他人修改過，請重新整理後再試。
409 RefundWindowExpired           | 原付款方式的退款期限為 180 天（2027/02/23 截止），將以人工匯款處理。
409 NegativeStockNotAllowed       | 目前庫存為 30 件，最多只能減到 0。
```

#### 剩下的三個 ⚠️（不是 bug，是待辦）

**⚠️ 1：`選擇「OTHER」這個原因`**

`CancelNoteRequiredException` 收的是 `String reasonName`，而不是 `CancelReason`：

```java
public CancelNoteRequiredException(String orderId, String reasonName) {
//                                                 ↑ 🔴 String → normalizeArg 放行
```

✅ **修法**：改收 `CancelReason`，並讓 `CancelReason` 實作 `LabeledEnum`：

```java
// CancelReason（00 章 0.14.2 從 command 套件搬到 domain 的那個）
public enum CancelReason implements LabeledEnum {
    CHANGED_MIND, WRONG_ITEM, FOUND_CHEAPER, DELIVERY_TOO_SLOW,
    PAYMENT_TIMEOUT, OTHER;

    @Override public String labelKey() { return "cancelReason." + name(); }
}
```

```properties
cancelReason.OTHER=其他
cancelReason.CHANGED_MIND=改變心意
# …六行
```

⚠️ **而這一改會連帶影響 03 章 3.7.3 的 `OrderDetailView.Cancellation.reasonLabel()`**
（它目前自己查標籤）—— 那不是壞事，**它可以改用同一個 resolver**。
👉 **記進 4.13 的修正表。**

**⚠️ 2：`您沒有權限修改「internalNote」`**

欄位名是**程式碼的識別碼**，而它出現在給使用者看的訊息裡。

| 選項 | 取捨 |
|---|---|
| ① 現狀 | ⚠️ 使用者看到 camelCase 的英文欄位名 |
| ② 一張「欄位 → 中文名」的對照表 | ✅ 正確。⚠️ 而那張表要與 03 章 3.7.3 的欄位清單同步（**又一份真相**） |
| ③ 訊息改成不含欄位名（「您沒有權限修改此欄位」） | ✅ 最便宜。🔴 客服要知道是哪個欄位（4.2.4 那個「客服需要知道是哪個欄位」的理由） |
| ④ ✅ **`userMessage` 用 ③，`extensions.fields` 保留欄位名** | 給人的訊息模糊，給程式的資料精確 |

✅ **選 ④** —— 而它與 4.5.1 的「五個消費者」完全一致：
**`userMessage` 給使用者、`extensions` 給前端程式。**
前端知道 `internalNote` 對應哪一個輸入框，**它比後端更適合翻譯欄位名。**

**⚠️ 3：`已達使用次數上限（1 次）`**

`maxPerCustomer == 1` 時這句話很怪（4.6.1 已經討論過）。
👉 **維持現狀，記進 4.14 誤區 5 的同一個缺口。**

> 📌📌 **這一節的價值可以量化**：
>
> | | 數量 |
> |---|---|
> | 41 個 `userMessage` 全部通過五組**斷言**測試 | ✅ |
> | 而**印出來看一眼**找到的問題 | **6 個**（3 個 bug + 3 個待辦） |
>
> ⚠️⚠️ **五組斷言測試一個都沒抓到那 3 個 bug**，因為
> `此訂單目前的狀態（SHIPPED）無法取消。` 這句話：
>
> | 檢查 | 結果 |
> |---|---|
> | 訊息 key 存在 | ✅ |
> | 沒有未替換的 `{n}` | ✅ |
> | `extensions` 型別正確 | ✅ |
> | 金額欄位是 `String` | ✅ |
> | 422 有 `errors[]` | ✅（它是 409） |
>
> **五個全綠，而訊息是壞的。**
>
> 👉 **這就是為什麼「印出來的測試」不是偷懶，是一個獨立的檢查層。**

### 4.12.5 一張「這個 bug 誰抓得到」的對照表 ★★

| bug | 編譯器 | ArchUnit | 掃描測試 | fixture 測試 | 印出來的測試 | 符號檢查 | 🔴 沒人 |
|---|---|---|---|---|---|---|---|
| `OrderStatus.COMPLETED` 不存在（4.5.7） | ✅ | | | | | | |
| `Problem` 加欄位漏改呼叫端（4.9.1） | ✅ | | | | | | |
| `Money` 沒有 `isGreaterThan`（4.4.4） | ✅ | | | | | | |
| 新例外沒有 `ErrorCode`（4.2.4） | | | ✅ | | | | |
| **`code` 沒有例外**（4.6.4 的兩個） | | | ✅ | | | | |
| **散文引用了不存在的 code**（4.2.4） | | | | | | ✅ | |
| `ErrorCode` 放錯分區（4.2.3） | | | ✅ | | | | |
| 422 沒有 `errors[]`（4.6.2） | | | | ✅ | | | |
| 訊息參數個數不對（4.8.2） | | | | ✅ | | | |
| **`Instant` 當訊息參數**（4.8.3） | | | | ✅（`args()`） | ✅ | | |
| **enum 沒轉成標籤**（4.8.4） | | | | | ✅ | | |
| **家族外的三個例外沒跟上修正**（4.12.4） | | | | | ✅ | | |
| **`reasonName` 是 `String` 而非 enum**（4.12.4 ⚠️1） | | | | | ✅ | | |
| **訊息 key 不存在被 fallback 遮住**（4.12.2） | | | | ✅（哨兵） | | | |
| **文案與 `humanizeDuration` 的空白**（4.8.7） | | | | | ✅ | | |
| 例外住錯套件（4.12.3 ①） | | ✅ | | | | | |
| Web 層建立業務例外（4.12.3 ②） | | ✅ | | | | | |
| `ActorScopedStatus` 變成長期方案（4.7.5） | | ✅ | | | | | |
| `applyDelta` 被誤用（4.6.3） | | ✅ | | | | | |
| `@Transactional` 宣告 checked（02 章 2.6.4） | ✅（間接） | ✅ | | | | | |
| `AFTER_COMMIT` 拋業務例外（4.10.3） | | ⚠️ 部分 | | | | | |
| **`catch` 業務例外時的傳播行為**（4.10.4） | | | | | | | 🔴 |
| **log 順序（先 log 再 throw）**（4.5.5） | | | | | | | 🔴 |
| **`FieldViolation.message` 寫死中文**（4.5.7 家族 4） | | | | | | | 🔴 |
| **同模式的 code 該不該合併**（4.2.6） | | | | | ✅（報表） | | |
| **掃描測試漏掉 12 個例外**（4.12.1） | | | ✅（下限斷言） | | | | |

⚠️ **三個 🔴 是這一章的誠實缺口**，而它們有一個共同點：

> **三個都需要「理解時序或語意」，而不只是「看結構」。**
>
> | 缺口 | 需要什麼 |
> |---|---|
> | `catch` 時的傳播行為 | 讀 try-catch 的**結構** + 被呼叫方法的**註解** |
> | log 順序 | 讀敘述**順序** |
> | 文案寫死中文 | 判斷一個字串是**文案**還是**識別碼** |

**而它們的處置一律是「寫進驗收清單，並在原處加註解」**（4.16）。

> 📌📌 **這張表本身是本章最實用的產出**，理由：
> **它讓「加一條測試」這個決定有依據。**
> 一個新的 bug 進來時，先問「這一列該打在哪一欄」——
> 如果答案是 🔴，那才需要新機制；
> 如果答案是「編譯器」，那該做的是**改型別**而不是**加測試**。

---

## 4.13 本章回頭修正前面的地方 ★★

**這一章是本站第一章有 JDK 與 Maven 可用的**，
所以它抓到的東西比前四章多 —— 而其中一部分是**前四章的**。

### 4.13.1 編譯器抓到的（前四章沒有 JDK）

| # | 位置 | 問題 | 修法 |
|---|---|---|---|
| ① | **04-controller 3.5.3 例子 2** | 🔴 **`OrderStatus.COMPLETED` 不存在** —— `COMPLETED` 是 `OrderStatus.Category` 的常數（00 章 0.9.3）。**編譯不過** | 改成 `OrderStatus.DELIVERED`（4.5.7 家族 2） |
| ② | 04-controller 3.5.3 例子 2 | 🔴 `current.label()` 不存在（00 章 0.14.1 已指出） | 移除；標籤由 `ProblemFactory` 解析（4.8.4） |
| ③ | 04-controller 3.5.3 例子 1、2、3 | ⚠️ 套件 `order.service.exception` **不存在**（00 章 0.14.3 拆掉了） | 搬到 `order.domain.exception`（4.3.7） |
| ④ | **04-controller 3.6.3 `ProblemFactory`** | `Problem` 加了 `safeToRetryBlindly` → 建構子參數從 15 變 16 | 4.9.1（`validationFailed` 與 `withExtension` 都要改） |

⚠️ **① 值得單獨強調**，因為它是「三輪人工複查沒抓到、編譯器第一次就抓到」的那一類：

```
error: cannot find symbol
        return s == OrderStatus.SHIPPED || s == OrderStatus.COMPLETED;
                                                           ^
  symbol:   variable COMPLETED
  location: class OrderStatus
```

### 4.13.2 掃描測試抓到的

| # | 位置 | 問題 | 修法 |
|---|---|---|---|
| ⑤ | **03 章 3.10.3 ⑦** | 🔴 理由欄引用了 `ORDER_INVOICE_ALREADY_ISSUED`，而**那個 code 從來沒有被加進 `ErrorCode`** | 4.2.4（第 98 個） |
| ⑥ | **04-controller 3.4.2 的 enum 排版** | ⚠️ `REQUEST_TIMEOUT`（503）被放在 504 之後 → 503 這一區被切成兩段 | 4.2.3（搬到 `PAYMENT_GATEWAY_UNAVAILABLE` 之後） |
| ⑦ | 00 章 0.12 ⑮ + 03 章 3.10.3 ⑦ | ⚠️ 14 個新 code **append 在 enum 最後** → 403／409／422 三區被切開 | 4.2.3（搬回各自的分區） |
| ⑧ | **04-controller 錯誤目錄** | 🔴 `ORDER_ADDRESS_NOT_EDITABLE` 與 `ADDRESS_CHANGE_LIMIT_EXCEEDED` 躺在 `PLANNED_FOR_LATER` 整整一站，**而 02 章 2.11.5 已經實作了那個功能** | 4.6.4（補兩個例外） |
| ⑨ | **本章 4.5.7 家族 3** | 🔴 標題寫「期限類（3 個）」而只列了 2 個 —— `REFUND_WINDOW_EXPIRED` 沒有例外 | 4.12.1（補 `RefundWindowExpiredException`） |
| ⑩ | **本章 4.6.1** | 🔴 `COUPON_ALREADY_USED` 與 `COUPON_ALREADY_APPLIED` 被混為一談 | 4.6.1（補 `CouponAlreadyUsedException`） |

### 4.13.3 「印出來的測試」抓到的

| # | 位置 | 問題 | 修法 |
|---|---|---|---|
| ⑪ | **本章 4.5.7 家族 3** | 🔴 `SelfCancelWindowExpiredException` 傳 `window.toMinutes()` → 訊息變成「下單後 1,440 內」 | 4.8.3（改傳 `Duration`） |
| ⑫ | **本章 4.5.7 家族 1** | 🔴 `OrderStateException` 傳 `current.name()` → 訊息顯示 `SHIPPED` 而不是「已出貨」 | 4.8.4（改傳 enum） |
| ⑬ | **本章 4.5.7／4.6.4／4.7.4 的三個「家族外」例外** | 🔴 `OrderNotCancellable` / `OrderNotEditable` / `OrderAddressNotEditable` **沒跟上 ⑫ 的修正** | 4.12.4 |
| ⑭ | **本章 4.5.7 四個例外** | 🔴 自己呼叫 `toPlainString()` → 金額顯示 `320.00` 而不是 `320` | 4.8.7（`args()` 守門人） |
| ⑮ | 本章 4.5.7 家族 1 | ⚠️ `error.SELF_CANCEL_WINDOW_EXPIRED.user` 的 `{0}` 後面多一個空白 | 4.8.7（改文案） |
| ⑯ | **00 章 0.14.2 的 `CancelReason`** | ⚠️ 它**沒有實作 `LabeledEnum`** → 訊息顯示 `OTHER` | 4.12.4 ⚠️1（實作 `LabeledEnum` + 六行 properties） |

### 4.13.4 設計上的修正

| # | 位置 | 問題 | 修法 |
|---|---|---|---|
| ⑰ | **00 章 0.9.2 `assertInvariants()`** | ⚠️ 11 條不變量全部拋 `IllegalStateException` → 無法告警、無法查詢 | 4.4.4（`InvariantViolationException`） |
| ⑱ | 03 章 3.10.3 ⑧ 的 `changeInternalNote` | 🔴 「備註太長」拋 `IllegalStateException` → **500 + 「請稍後再試」**（事故 2） | 4.4.5（`NoteTooLongException`，422） |
| ⑲ | 03 章 3.10.3 ⑧ 的 `changeInternalNote` | ⚠️ 「非內部人員」拋 `IllegalStateException` → 該保持 500，**但要進告警** | 4.4.5（`InvariantViolationException`） |
| ⑳ | **03 章 3.6.6 ③** | ⚠️ `InternalFieldNotEditableException` 寫死欄位名 `"internalNote"` → 改 `invoice` 時給出錯的欄位名 | 4.5.7 家族 6（改收 `List<String>`） |
| ㉑ | 03 章 3.6.4 `UpdateOrderCommand` | 新增 `touchedInternalFields()`（回清單），舊的 `touchesInternalFields()` 用它實作 | 4.5.7 家族 6 |
| ㉒ | **00 章 0.12 ⑮ `REFUND_REJECTED`** | 🔴 `Retry.MODIFY_REQUEST` 是錯的 —— 原卡註銷，改任何欄位都不會成功 | 4.9.3（改成 `Retry.NONE`） |
| ㉓ | **04-controller 3.4.2 `ErrorCode`** | ⚠️ `retryable()` 把 `CHECK_STATUS` 也算成 `true` → 前端盲重試 → **事故 1** | 4.9.1（新增 `safeToRetryBlindly()`） |
| ㉔ | 04-controller 3.6.2 `Problem` | 新增 `safeToRetryBlindly` 欄位 | 4.9.1 |
| ㉕ | 04-controller 3.7.2 `ApiExceptionHandler` | 新增：`SideEffectsCommitted` 的處理、`Retry-After`、`InvariantViolationException` 的專門 handler | 4.3.4 / 4.9.2 / 4.4.4 |
| ㉖ | **04-controller 3.6.3 `ProblemFactory`** | 新增 `normalizeArgs()` 與 `displayZone` 設定 | 4.8.3 |
| ㉗ | **00 章 0.9.3 `OrderStatus`** | 新增 `editableStates()` | 4.7.4 |
| ㉘ | **04-controller 3.5.2 `BusinessException`** | 新增 `args(...)` 守門工廠 | 4.8.7 |
| ㉙ | 03 章 3.7.3 `OrderDetailView.Cancellation` | ⚠️ `reasonLabel()` 自己查標籤 → 改用 `StatusLabelResolver`（與 ⑯ 一致） | 4.12.4 ⚠️1 |
| ㉚ | **04-controller 3.7.4 `ConstraintNameMapper`** | ⚠️ `uk_orders_order_number` **刻意不對映**（→ 500）—— 需要一行註解說出這是決定而非遺漏 | 4.4.3 邊界 1 |

⚠️⚠️ **㉒ 與 ㉓ 是唯一兩個「會改變對外行為」的**：

| | 改了什麼 | 客戶端受影響嗎 |
|---|---|---|
| ㉒ `REFUND_REJECTED` 的 `retryStrategy` | 從 `"MODIFY_REQUEST"` 變成**沒有這個欄位** | ⚠️ **是** —— 如果有客戶端在讀它 |
| ㉓ 新增 `safeToRetryBlindly` | **只新增，不改既有** | ✅ 不影響（新增欄位是相容的） |

**㉒ 的處置**：它是一個**破壞性變更**（03-rest-api 第 06 章的定義），
而它修的是一個 bug。

| 選項 | 取捨 |
|---|---|
| ① 直接改 | 🔴 破壞相容 |
| ② 保留 `MODIFY_REQUEST`，只在文件加註 | 🔴 bug 留著 |
| ③ ✅ **改，並在版本說明列為「錯誤修正」** | `retryStrategy` 的語意是「建議」，而給錯的建議比不給更糟 |

✅ **選 ③**，理由：**沒有正確的客戶端會因為這個改動而壞掉** ——
一個照著 `MODIFY_REQUEST` 做的客戶端，
會叫使用者「修改請求後重送」，**而那個重送必定再次失敗**。

> 📌 **這一節的統計**：
>
> | 抓到它的機制 | 幾個 |
> |---|---|
> | **編譯器** | 4 |
> | **掃描測試** | 6 |
> | **印出來的測試** | 6 |
> | 設計複查（人） | 14 |
> | **合計** | **30** |
>
> ⚠️⚠️ **前三類共 16 個，全部是「這一章才有 JDK」的直接成果。**
> 前四章的複查紀錄裡有一句反覆出現的話：
>
> > 「⚠️ 這些檢查抓不到的：型別存不存在、方法存不存在…
> > 而**真正能徹底掃乾淨的只有編譯器**（目前這台機器沒有 JDK）。」
>
> **這一章是那句話的兌現。**

---

## 4.14 常見誤區

**誤區 1：把業務失敗表達成 `IllegalStateException`**

```java
throw new IllegalStateException("訂單已出貨，不可取消");
```

| 為什麼錯 | 說明 |
|---|---|
| 客戶端收到 **500** | 而 500 的語意是「請重試」→ **事故 1** |
| 沒有 `ErrorCode` → 前端無法 `switch` | |
| 沒有結構化資料 → 前端無法渲染「申請退貨」按鈕 | |
| 訊息是中文寫死的 → 無法 i18n（4.5.2） | |

✅ **判準（4.4.1）**：問「誰能修好它」。
呼叫端能 → `BusinessException`；我們能 → 500。

**誤區 2：把使用者訊息放在例外裡**

```java
throw new InsufficientStockException("「" + name + "」僅剩 " + n + " 件");
```

**六個代價在 4.5.2。而最容易被低估的是第 6 個**：
17 個測試會斷言那個字串，於是**改一個字 = 改 17 個測試**。

✅ **例外持有 `ErrorCode` + 資料，properties 持有文案。**

**誤區 3：`extensions` 裡放 Entity 或聚合**

```java
ext("order", order)
```

**五層後果在 4.5.4，而第 2 層最惡毒**：
序列化時碰到 lazy 集合 → `LazyInitializationException` **在 advice 裡**拋出
→ advice 回 `null` → `/error` → **客戶端收到 500 + HTML**。

**誤區 4：以為只有 `extensions` 會洩漏**

```java
// 🔴 「gatewayReason 不要放 extensions，放 detail 就好」
```

⚠️ **`Problem` 的四個文字欄位（`detail` / `userMessage` / `errors[].message` /
`extensions`）在 4xx 時全部會回給客戶端**（4.5.5）。
**唯一不會出去的是 log。**

**誤區 5：已知的命名與文案不一致（本章刻意不修的三處）**

| 不一致 | 為什麼不修 |
|---|---|
| `NEGATIVE_STOCK_NOT_ALLOWED` 的 `NOT_ALLOWED` 與 `METHOD_NOT_ALLOWED`（405）撞名 | `code` 是對外契約，改名 = 破壞性變更（4.2.3） |
| **`FieldViolation.message` 寫死中文** | 改 `FieldViolation` 的形狀要動 02／03／04 三章共 40 處（4.5.7 家族 4） |
| `COUPON_ALREADY_USED` 在 `maxPerCustomer == 1` 時文案不自然 | 需要「一個 code 兩個 i18n key」，要動 `ProblemFactory` 的 API（4.6.1） |

⚠️ **「知道但不修」與「不知道」的差別是：前者寫在這裡。**

**誤區 6：在 advice 裡看 `Actor` 決定狀態碼**

**四個問題在 4.7.3，而最嚴重的是第 4 個**：
狀態碼的來源從一個變成兩個，於是
**契約測試、API 文件產生、監控告警規則三個同時失效。**

**誤區 7：`catch (Exception e) { log.error }` 之後繼續往下走**

**事故 3 的形狀。** 兩個問題：

| 問題 | |
|---|---|
| `log.error` 每天 4,000 條，**沒有人在看** | |
| 失敗**沒有進入狀態** → 客戶看到「已完成」 | |

✅ **4.10.2 情況 2 的解法**：把失敗寫成狀態，並在交易**外面**決定要不要變成例外。

**誤區 8：`AFTER_COMMIT` 的 listener 拋業務例外**

**交易已經 commit，而客戶端收到 4xx** ——
**成功的操作回了失敗的狀態碼**（4.10.3）。

**誤區 9：以為「例外很慢」所以不用例外**

**實測（4.11.1）**：`writableStackTrace = false` 的例外在 63 層堆疊下是
**34ns**，而「回傳一個物件」是 **30ns**。

⚠️ **反過來也是誤區**：「例外不慢，所以可以用來做流程控制」——
4.11.2 的三個理由**與效能無關**。

**誤區 10：`retryable: true` 就叫客戶端重試**

⚠️ **`CHECK_STATUS` 的 `retryable` 也是 `true`**（4.9.1），
而它的意思是「**不要重試，去查狀態**」。
盲重試 `PAYMENT_OUTCOME_UNKNOWN` = **重複扣款**。

**誤區 11：掃描測試綠燈就以為掃到全部**

⚠️ **`ClassGraph` 的 `enableClassInfo()` 只給直接子類別** ——
實測漏掉 12 個例外，而**所有測試都綠**（4.12.1）。

✅ **掃描測試必須有下限斷言**：`assertThat(all).hasSizeGreaterThanOrEqualTo(41)`。

**誤區 12：`getMessage(key, args, fallback, locale)` 的 fallback 遮住錯誤**

⚠️ **一個「沒有訊息」的 code 通得過「訊息沒有未替換 `{n}`」的測試**，
因為 fallback 字串裡沒有 `{n}`（4.12.2）。

✅ **用哨兵值**：`"<<<MISSING:" + key + ">>>"`，然後斷言結果不等於它。

**誤區 13：家族基底改了，家族外的忘了改**

⚠️ **4.12.4 實測**：`OrderStateException` 改一行修好四個例外，
而**三個「刻意不繼承它」的例外留著同一個 bug** ——
`此訂單目前的狀態（SHIPPED）無法取消。`

✅ **改基底時要問「誰沒有繼承它」。**

**誤區 14：例外自己格式化 `Money` / `Instant`**

⚠️ **4.8.7 實測**：四個例外自己呼叫 `toPlainString()` →
`ProblemFactory` 的時區、單位、小數位處理全部失效。

✅ **交出原始型別**，讓唯一的組裝點格式化。
而它用 `BusinessException.args(...)` 守住。

---

## 4.15 本章練習

### 練習 1：找出這個例外類別的 11 個問題

```java
package example.shop.order.web;

import example.shop.common.error.ErrorCode;
import example.shop.order.domain.Order;

public class ShipmentFailedException extends Exception {

    private final Order order;
    private final String message;

    public ShipmentFailedException(Order order, String reason) {
        super("出貨失敗：" + reason);
        this.order = order;
        this.message = "訂單 " + order.orderNumber() + " 出貨失敗，請稍後再試。";
    }

    public Order getOrder() { return order; }
    public String getUserMessage() { return message; }
    public int getStatusCode() { return 500; }
}
```

**提示**：問題分佈在套件、繼承、欄位、訊息、狀態碼五個方面。

<details>
<summary>答案</summary>

| # | 問題 | 後果 | 對應節 |
|---|---|---|---|
| 1 | **`extends Exception`（checked）** | 🔴🔴 **預設規則下不 rollback** —— 出貨失敗但庫存已扣 | 02 章 2.6.1、4.10.1 |
| 2 | 🔴 **套件是 `order.web`** | 業務例外在 Web 層 → ArchUnit 規則 ① 與 ② 都紅燈 | 4.3.7、4.12.3 |
| 3 | 🔴 **沒有繼承 `BusinessException`** | 沒有 `ErrorCode`、沒有 `extensions`、advice 接不到 | 4.3.4 |
| 4 | 🔴 **`import ErrorCode` 但沒有用** | 它沒有對應的 code → 被觸發時 fallthrough 成 500 | 4.12.1 |
| 5 | 🔴🔴 **持有整個 `Order` 聚合** | 序列化時 `LazyInitializationException` **在 advice 裡** → 回應變 HTML | 4.5.4 |
| 6 | 🔴 **自己組使用者訊息** | 不能 i18n、改文案要改 Java、測試會斷言字串 | 4.5.2 |
| 7 | ⚠️ **欄位名 `message` 遮蔽 `Throwable.message`** | `getMessage()` 與 `getUserMessage()` 回不同的東西，而讀者會混淆 | — |
| 8 | 🔴 **`getStatusCode()` 回 500** | 出貨失敗有兩種：狀態不對（409）與倉庫系統掛掉（502）。寫死 500 讓兩者不可分 | 4.4.1 |
| 9 | ⚠️ **狀態碼在例外上** | 第二個真相來源（`ErrorCode.status()` 才是唯一來源） | 4.3.3 |
| 10 | ⚠️ **沒有 `writableStackTrace = false`** | 每次出貨失敗多 1,520ns（63 層堆疊） | 4.11.1 |
| 11 | ⚠️ **`getOrder()` / `getUserMessage()` 用 `get` 前綴** | 與本站的 accessor 慣例（`xxx()`）不一致 | 00 章 0.14.1 |

**修正版**：

```java
package example.shop.order.domain.exception;

import example.shop.common.error.BusinessException;
import example.shop.common.error.ErrorCode;
import example.shop.common.error.marker.DomainException;
import example.shop.order.domain.OrderStatus;

import java.util.List;
import java.util.Set;

/**
 * 出貨失敗 —— <b>只涵蓋「狀態不允許」這一種</b>。
 *
 * <p>⚠️ 原版把兩件事混在一起：
 * <ul>
 *   <li>狀態不對 → <b>409</b>，呼叫端能修（先付款／先取消）。</li>
 *   <li>倉庫系統掛掉 → <b>502</b>，呼叫端不能修 → 那是
 *       {@code UpstreamErrorException}，<b>另一個例外</b>。</li>
 * </ul>
 * 4.4.1 的判準：兩者「誰能修好它」不同 → 兩個例外。
 */
public class OrderNotShippableException extends OrderStateException {
    public OrderNotShippableException(String orderId, String orderNumber,
                                      OrderStatus current, Set<OrderStatus> allowed) {
        super(ErrorCode.ORDER_NOT_SHIPPABLE, "ship", orderId, orderNumber, current, allowed);
    }
}
```

⚠️ **注意修正版就是 4.5.7 家族 1 的那一個** ——
而「原版的 `ShipmentFailedException` 該被拆成兩個例外」是最重要的一個發現。

</details>

### 練習 2：這條守門測試為什麼是假綠燈

```java
@Test
void 每個業務例外都有ErrorCode() {
    var exceptions = new ClassGraph()
            .enableClassInfo()
            .acceptPackages("example.shop.order")
            .scan()
            .getSubclasses(BusinessException.class.getName())
            .loadClasses(BusinessException.class);

    for (var cls : exceptions) {
        assertThat(cls.getDeclaredConstructors()).isNotEmpty();
    }
}
```

**問：它有四個問題，而其中兩個讓它「永遠不會失敗」。**

<details>
<summary>答案</summary>

| # | 問題 | 讓它永遠綠嗎 |
|---|---|---|
| 1 | 🔴 **`enableClassInfo()` 只給直接子類別** | ⚠️ 部分 —— 它會漏掉繼承家族基底的 12 個 |
| 2 | 🔴🔴 **`acceptPackages("example.shop.order")`** | ⚠️ 漏掉 `coupon`、`payment`、`stock` 三個套件共 13 個 |
| 3 | 🔴🔴 **斷言的是「有建構子」** | ✅ **永遠綠** —— 每個類別都至少有一個建構子 |
| 4 | 🔴🔴 **沒有下限斷言** | ✅ **永遠綠** —— 即使掃到 0 個，for 迴圈跑 0 次，測試通過 |

⚠️⚠️ **第 4 點是最重要的**：如果套件名打錯（`example.shop.orders`），
`exceptions` 是空的，**測試依然通過**。

**修正版**：

```java
@Test
void 每個業務例外都有ErrorCode() {
    var exceptions = new ClassGraph()
            .enableAllInfo()                              // ★ ① 遞移
            .acceptPackages("example.shop")                // ★ ② 全部套件
            .scan()
            .getSubclasses(BusinessException.class.getName())
            .loadClasses(BusinessException.class)
            .stream()
            .filter(c -> !java.lang.reflect.Modifier.isAbstract(c.getModifiers()))
            .filter(c -> !c.getName().contains("Test"))
            .toList();

    // ★★ ④ 下限斷言 —— 掃描機制壞掉時要紅燈
    assertThat(exceptions)
            .as("掃到的例外數量異常偏低 —— 檢查 enableAllInfo / acceptPackages")
            .hasSizeGreaterThanOrEqualTo(41);

    // ★ ③ 斷言真正在意的事：ErrorCode 不是 null
    for (var cls : exceptions) {
        BusinessException instance = ExceptionFixtures.instanceOf(cls);
        assertThat(instance.errorCode())
                .as("%s 沒有 ErrorCode", cls.getSimpleName())
                .isNotNull();
    }
}
```

⚠️ **而第 3 點的修正需要 `ExceptionFixtures`** ——
「斷言 `errorCode()` 不是 null」需要一個**實例**，
而那就是 4.12.2 那個 fixture 存在的理由。

> 📌 **這一題的一般教訓**：
> **一條測試的價值 = 它失敗的能力。**
> 而檢查它有沒有這個能力的方法是：**把被測的東西弄壞一次，看它紅不紅。**

</details>

### 練習 3：`Retry` 策略的四個判斷

**判斷下面四個情境該用哪個 `Retry`，並說出「客戶端會做什麼」。**

| # | 情境 |
|---|---|
| A | 客戶送出結帳，而促銷券的庫存剛好在同一毫秒被別人搶走（`COUPON_EXHAUSTED`） |
| B | 出貨 API 呼叫倉庫系統，對方回 HTTP 500 |
| C | 出貨 API 呼叫倉庫系統，連線 timeout（30 秒） |
| D | 客戶用一個已經被別人改過的版本送 `PUT /orders/{id}`（`OPTIMISTIC_LOCK_CONFLICT`） |

<details>
<summary>答案</summary>

| # | `Retry` | 客戶端會做什麼 | ⚠️ 關鍵 |
|---|---|---|---|
| A | **`NONE`** | 顯示「折扣碼已用完」，讓使用者移除券 | ⚠️ **不是 `BACKOFF_AND_RETRY`** —— 券用完了不會再回來 |
| B | **`BACKOFF_AND_RETRY`**（`UPSTREAM_ERROR`，502） | 指數退避後**原封不動**重送 | ✅ 對方回 500 代表「它沒處理成」 |
| C | 🔴 **`CHECK_STATUS`**（`UPSTREAM_TIMEOUT`，504） | **打 `GET /shipments/{id}` 查狀態** | ⚠️⚠️ **timeout ≠ 失敗** —— 倉庫可能已經出貨了。盲重試 = **出兩次貨** |
| D | **`REFETCH_THEN_RETRY`**（412） | 重新 `GET` 拿新的 ETag，再帶 `If-Match` 送 | ✅ 原封不動重送必定再次 412 |

⚠️ **B 與 C 的差別是這一題的重點**，而它就是 4.9.1 那張表最重要的一列：

```
對方回 500     → 我們【知道】它沒做成 → 可以盲重試
對方 timeout   → 我們【不知道】       → 🔴 只能查
```

**追問**：那 `safeToRetryBlindly()` 的值呢？

| # | `retryable()` | `safeToRetryBlindly()` |
|---|---|---|
| A | `false` | `false` |
| B | `true` | ✅ **`true`** |
| C | `true` | 🔴 **`false`** ← 這一列就是事故 1 |
| D | `true` | `false`（要先 refetch） |

</details>

### 練習 4：把這段程式碼的例外設計修好

```java
@Transactional
public void cancelOrder(String orderId, String reason, Actor actor) {
    Order order = orders.findById(orderId).orElse(null);
    if (order == null) {
        throw new RuntimeException("訂單不存在");
    }
    if (!order.status().isCancellable()) {
        throw new RuntimeException("訂單狀態不允許取消：" + order.status());
    }
    if (actor.isCustomer() && !order.customerId().equals(actor.id())) {
        throw new RuntimeException("不是你的訂單");
    }
    if (reason == null || reason.isBlank()) {
        throw new RuntimeException("必須填寫取消原因");
    }

    try {
        RefundResult refund = paymentGateway.refund(order.paymentId(), order.paidAmount());
        order.markRefunded(refund.transactionId());
    } catch (Exception e) {
        log.error("退款失敗", e);
    }

    order.cancel(reason, actor, Instant.now());
    orders.save(order);
    mailer.sendCancellationEmail(order);
}
```

**要求**：列出所有問題並給出修正版。

<details>
<summary>答案</summary>

**九個問題**：

| # | 問題 | 對應節 |
|---|---|---|
| 1 | 🔴 **四個 `RuntimeException`** —— 全部變 500，客戶端無法分辨 | 4.4.1 |
| 2 | 🔴🔴 **「不是你的訂單」與「訂單不存在」用不同的訊息** → 洩漏「這張訂單存在」 | 01 章 1.8.3 |
| 3 | 🔴 **`orElse(null)` + 手動 null 檢查** | 4.11.4 |
| 4 | 🔴🔴 **`catch (Exception e) { log.error }` 之後繼續取消** → 事故 3 | 4.10.2 |
| 5 | 🔴 **外部呼叫在交易裡** → 對方 timeout 30 秒 → 連線被卡住 | 02 章 2.9.2、00 章事故 1 |
| 6 | 🔴 **`Instant.now()` 而不是注入的 `Clock`** → 不可測 | 01 章 1.4 |
| 7 | ⚠️ **`sendCancellationEmail` 在交易裡** → 交易 rollback 但信已寄出 | 00 章事故 2 |
| 8 | ⚠️ **`reason` 是 `String`** → 應該是 `CancelReason` enum | 00 章 0.14.2 |
| 9 | ⚠️ **授權檢查散在 Service 裡** → `findByIdVisibleTo` 該一次做完 | 01 章 1.9.4 |

**修正版**：

```java
@Transactional
public CancellationResultView cancel(CancelOrderCommand cmd) {
    Instant now = clock.instant();                                    // ★ 6

    // ★ 2 + 9：「找不到」與「沒權限」合併成同一個 404
    Order order = orders.findByIdVisibleTo(cmd.orderId(), cmd.actor())
            .orElseThrow(() -> new ResourceNotFoundException("Order", cmd.orderId()));

    // ★ 1 + 8：狀態與原因的檢查都在 Domain 裡（它們是不變量）
    //   Order.cancel() 會拋 OrderNotCancellableException（409）、
    //   SelfCancelWindowExpiredException（409）或 CancelNoteRequiredException（422）
    Cancellation cancellation = order.cancel(cmd.reason(), cmd.customerNote(),
                                             cmd.actor(), now);
    orders.save(order);

    // ★ 4 + 5 + 7：退款與寄信【都不在這個交易裡】——
    //   發一個事件，由 AFTER_COMMIT 的 listener 處理（02 章 2.12）
    //   ⚠️ 而 listener 不可以拋業務例外（4.10.3），失敗要進 outbox（06 章）
    events.publish(OrderCancelledEvent.from(order, cancellation, now));

    return CancellationResultView.from(order, cancellation);
}
```

⚠️⚠️ **注意修正版「變短了」**，而那不是因為省略 ——
是因為**四個檢查搬到了它們該在的地方**：

| 原本在 Service 的檢查 | 搬到哪 | 為什麼 |
|---|---|---|
| 訂單不存在 | `findByIdVisibleTo` + `orElseThrow` | 一個表達式 |
| 不是你的訂單 | **同上**（合併） | 不洩漏存在性 |
| 狀態不允許取消 | **`Order.cancel()`** | 它是不變量 I5 |
| 必須填原因 | **`Order.cancel()`** | 它是不變量（依 `reason` 而定，00 章 0.12 ③） |

> 📌 **這一題最重要的發現**：
> **「例外設計不好」常常是「邏輯放錯層」的症狀。**
> 把四個檢查搬回 Domain 之後，
> **Service 裡一個 `throw` 都不需要寫** —— 例外自然就對了。

**追問：`Order.cancel()` 該拋幾個例外？**

| 例外 | 何時 |
|---|---|
| `OrderNotCancellableException`（409） | 狀態不在 `isCancellable()` |
| `SelfCancelWindowExpiredException`（409） | ⚠️ 客戶且已付款超過 30 分鐘（**客服不受限**，4.5.7 家族 3） |
| `CancelNoteRequiredException`（422） | `reason == OTHER` 而 `customerNote` 是空的 |

**三個，而它們的順序有意義**：先檢查「能不能取消」（狀態），
再檢查「你能不能取消」（時間窗），最後檢查「輸入完整嗎」。

⚠️ **反過來的順序會洩漏資訊**：
先檢查 `customerNote` → 客戶填了備註才知道「這張訂單根本不能取消」。

</details>

### 練習 5：設計一個守門測試

**目標**：抓「新增一個 `ErrorCode` 但忘了寫 `error.<CODE>.title`」。

**限制**：
- ⚠️ 不可以用 `getMessage(key, args, fallback, locale)` 的 fallback 判斷（4.12.2 的假綠燈）。
- ⚠️ 要能列出**全部**漏掉的 code，不是第一個。
- 要同時檢查 `zh_TW` 與 `en`（未來的日本站會加 `ja`）。

<details>
<summary>答案</summary>

```java
package example.shop.common.error;

import org.junit.jupiter.api.Test;
import org.springframework.context.support.ResourceBundleMessageSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;

class ErrorMessageCompletenessTest {

    /** ★ 目前支援的語言。新增語言時只改這一行。 */
    private static final List<Locale> LOCALES =
            List.of(Locale.TAIWAN, Locale.ENGLISH);

    private static final ResourceBundleMessageSource MS = new ResourceBundleMessageSource();
    static {
        MS.setBasename("error-messages");
        MS.setDefaultEncoding("UTF-8");
        // ★★ 關鍵：關掉「找不到就退回系統預設語言」
        //    否則 en 缺的 key 會退回 zh_TW，於是測試通過而英文站顯示中文
        MS.setFallbackToSystemLocale(false);
    }

    @Test
    void 每個code的title與user在每個語言都存在() {
        var missing = new ArrayList<String>();

        for (Locale locale : LOCALES) {
            for (ErrorCode code : ErrorCode.values()) {
                for (String key : List.of(code.titleKey(), code.userMessageKey())) {
                    // ★ 哨兵而不是 fallback（4.12.2）
                    String sentinel = "<<<MISSING>>>";
                    String value = MS.getMessage(key, new Object[0], sentinel, locale);
                    if (sentinel.equals(value)) {
                        missing.add("%s / %s".formatted(locale, key));
                    }
                }
            }
        }

        assertThat(missing)
                .as("""
                    以下訊息 key 不存在。
                    ⚠️ ProblemFactory 找不到 key 時會顯示 fallback「操作無法完成，請稍後再試。」
                    —— 一個精確的 4xx 會變成一句無用的話（4.8.6 第 2 步）。
                    共 %d 個。
                    """.formatted(missing.size()))
                .isEmpty();
    }
}
```

**四個關鍵點**：

| # | 做法 | 為什麼 |
|---|---|---|
| 1 | **哨兵值**而不是 fallback | 4.12.2 的假綠燈 |
| 2 | **收集到 `missing` 再一次斷言** | 一次看到全部（04-controller 2.10 的政策） |
| 3 | ⚠️⚠️ **`setFallbackToSystemLocale(false)`** | 否則 `en` 缺的 key 會**退回 `zh_TW`** → 測試通過而英文站顯示中文 |
| 4 | `LOCALES` 是一個常數清單 | 新增語言時只改一行，而**新語言立刻會有 196 個紅燈** ✅ |

⚠️⚠️ **第 3 點是這一題真正的難點。**
`ResourceBundleMessageSource` 的預設 `fallbackToSystemLocale = true`，
而撰稿機器的系統語言是 `zh_TW` ——
於是「英文訊息全部沒寫」這件事**在本機測試上完全看不出來**，
只有在 CI（系統語言通常是 `en_US` 或 `POSIX`）才會露出來。

**而那是最糟的一種**：**行為依賴「測試在哪台機器上跑」。**

> 📌 **追問：新增日文站時這個測試會有 196 個紅燈，那不是很煩嗎？**
>
> ✅ **那正是要的效果。** 對照兩種世界：
>
> | | 有這條測試 | 沒有 |
> |---|---|---|
> | 新增 `ja` | **196 個紅燈**，一次補完 | ✅ 上線 |
> | 使用者體驗 | — | 🔴 日本客戶隨機看到中文 |
>
> ⚠️ 而如果「一次補 196 個」真的不可行，正確的做法是
> **明確宣告「`ja` 只支援 20 個最常見的 code，其餘用英文」** ——
> 而那需要一個白名單，**而白名單是一個被討論過的決定**。

</details>

---

## 4.16 驗收清單

### 完成本章後，你的專案應該有

```
✅ common/error/
   ├── ErrorCode.java                          ★★ 98 個 code，分區連續（4.2.3）
   ├── BusinessException.java                  ★ 新增 args(...) 守門工廠（4.8.7）
   ├── InvariantViolationException.java         ★★ 4.4.4
   ├── FieldViolation.java                      ⚠️ javadoc 加 TODO 指向 4.5.7 家族 4
   ├── AlternativeAction.java
   ├── ResourceNotFoundException.java           ★ 從 04-controller 搬來
   ├── ValidationFailedException.java           ★ 同上
   └── marker/
       ├── DomainException.java                 ★ 4.3.4
       ├── ActorScopedStatus.java               ★★ 過渡方案（4.7.5）
       └── SideEffectsCommitted.java            ★★ 4.3.4

✅ order/domain/exception/          20 個
✅ order/application/exception/      8 個
✅ coupon/domain/exception/          8 個（含 CouponException 家族基底）
✅ payment/domain/exception/         4 個
✅ stock/domain/exception/           1 個
                                    ── 合計 41 個具體例外（4.12.1 實測）

✅ common/web/
   ├── Problem.java                             ★ 新增 safeToRetryBlindly（4.9.1）
   │                                            ★ 新增 withExtension（4.3.4）
   ├── ProblemFactory.java                      ★★ 新增 normalizeArgs（4.8.3）
   ├── ApiProblemProperties.java                ★ 新增 displayZone
   └── ApiExceptionHandler.java                 ★ 三個新增（4.4.4 / 4.3.4 / 4.9.2）

✅ resources/error-messages_zh_TW.properties     ★ 196 行（98 × 2）+ duration 三行
✅ resources/error-messages_en.properties        ⚠️ 見「已知缺口」

✅ 測試
   ├── common/error/ErrorCodeLayoutTest.java             ★★ 分區連續 + 同模式報表（4.2.3）
   ├── common/error/BusinessExceptionRegistryTest.java   ★★ 掃描 + 下限斷言（4.12.1）
   ├── common/error/ExceptionFixtures.java               ★★ 41 個實例（4.12.2）
   ├── common/error/ExceptionContractTest.java           ★★ 五組斷言 + 三份報表
   ├── common/error/MessageArgsGuardTest.java            ★ args() 的邊界（4.8.7）
   ├── common/error/ErrorMessageCompletenessTest.java    ★ 練習 5
   ├── common/web/ProblemFactoryI18nTest.java            ★★ 印出來的測試（4.8.7）
   ├── common/web/AllMessagesReportTest.java             ★★ 41 句全印（4.12.4）
   └── architecture/ExceptionArchitectureTest.java       ★ 五條 ArchUnit（4.12.3）
```

### 我能回答的問題

- [ ] 「誰能修好它」這個判準怎麼用？它與「已預期／未預期」的差別在哪？（4.4.1）
- [ ] `IllegalStateException` 為什麼刻意不是業務例外？那個決定的**兩個代價**是什麼？（4.4.2）
- [ ] 「Domain 的最後一道防線」為什麼有**兩種**，而判準不是「Web 層有沒有擋」？（4.4.5）
- [ ] 「按狀態碼分層」的例外階層為什麼是陷阱？（4.3.3）
- [ ] `OrderStateException` 與 4.3.2 否決的 `StateConflictException` 差在哪？（4.5.7 家族 1）
- [ ] 為什麼「使用者訊息」不該在例外裡？**六個代價**分別是什麼？（4.5.2）
- [ ] `Problem` 的四個文字欄位，哪些會回給客戶端？（4.5.5）
- [ ] 為什麼「在 advice 裡看 `Actor`」是錯的？**四個問題**分別是什麼？（4.7.3）
- [ ] 兩個 `ErrorCode` 的 `extensions` 為什麼刻意不同？（4.7.4）
- [ ] `MessageFormat` 在「參數不足」「順序顛倒」時的行為是什麼？（4.8.2）
- [ ] 為什麼 `Instant` 不可以直接當 `userMessageArgs`？（4.8.3）
- [ ] `retryable()` 與 `safeToRetryBlindly()` 差在哪？那個差別對應哪一個事故？（4.9.1）
- [ ] 為什麼 shop-service 的 `rollbackFor` 出現 0 次？（4.10.1）
- [ ] 「這件事失敗了」與「這個交易要回滾」怎麼解開？（4.10.2）
- [ ] `AFTER_COMMIT` 的 listener 拋業務例外會怎樣？（4.10.3）
- [ ] 「例外很慢」的正確版本是什麼？實測數字是多少？（4.11.1）
- [ ] 「不要用例外做流程控制」的三個理由，哪一個與效能有關？（4.11.2）
- [ ] 掃描測試為什麼必須有「下限斷言」？（4.12.1）
- [ ] 一個測試「通過」的兩種原因是什麼？怎麼分辨？（4.12.2）
- [ ] 為什麼「印出來的測試」不是偷懶？它抓到了哪些斷言測試抓不到的東西？（4.12.4）

### ⚠️ 已知缺口（本章刻意沒有關掉的）

| # | 缺口 | 為什麼不修 | 替代 |
|---|---|---|---|
| 1 | **`FieldViolation.message` 寫死中文** | 改它的形狀要動 02／03／04 三章共 40 處 | javadoc 加 TODO；4.14 誤區 5 |
| 2 | **`catch` 業務例外時的傳播行為** 沒有自動檢查 | ArchUnit 看不到 try-catch 結構 | 3 處全部加註解；code review 檢核項（4.10.4） |
| 3 | **「先 log 再 throw」的順序** 沒有自動檢查 | ArchUnit 看不到時序 | code review 檢核項（4.5.5） |
| 4 | **`humanizeDuration` 回傳含單位** 與文案的隱含契約 | 沒有機制可以守 | 「印出來的測試」+ 這一行（4.8.7） |
| 5 | `COUPON_ALREADY_USED` 在 `maxPerCustomer == 1` 時文案不自然 | 需要「一個 code 兩個 key」，要動 `ProblemFactory` API | 4.6.1 |
| 6 | **`error-messages_en.properties` 只有 12 個 code** | 本站沒有英文需求 | ⚠️ 練習 5 那條測試**現在會紅燈** —— 那是刻意的 |
| 7 | **`orders-api.yaml` 的錯誤清單** 沒有跑契約測試 | 那個測試在 04-controller 07 章 | 4.8.6 第 4 步 |
| 8 | **`ORDER_ALREADY_CANCELLED` 與 `ORDER_EXPIRED`** 標了「本站」但沒實作 | 前者在 07 章練習、後者在 06 章 | 4.12.1 的「本站已規劃項目要清空」測試**現在會紅燈** |
| 9 | **`reuseIdempotencyKey` 欄位** 沒有實作 | 它該由 `IdempotencyInterceptor` 加（04-controller 04 章） | 4.9.4 |

⚠️⚠️ **第 6 與第 8 項的「現在會紅燈」是刻意的。**
與 00 章 0.9.5 的手法一致：

> 📌 **一個可執行的待辦比 `// TODO` 可靠。**

### ⚠️ 環境與驗證狀態

**這一章的所有 Java 程式碼都在本機編譯執行過**：

| 項目 | 值 |
|---|---|
| JDK | **Temurin 21.0.5** |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5** |
| ArchUnit | 1.3.0 |
| ClassGraph | 4.8.172 |
| 平台 | macOS 14.2.1 / Apple Silicon (arm64) |

**跑過的東西**：

| 驗證 | 結果 |
|---|---|
| `mvn compile`：44 個新類別 + `ErrorCode`(98) + `Problem` + `ProblemFactory` | ✅ 通過 |
| `ErrorCodeLayoutTest`（分區連續 + 同模式報表） | ✅（**抓到 4 個被切開的分區**） |
| `BusinessExceptionRegistryTest`（掃描 41 個 + 41 個 code 使用） | ✅ |
| `ExceptionContractTest`（46 個測試案例） | ✅ |
| `ProblemFactoryI18nTest` / `AllMessagesReportTest`（41 句 `userMessage`） | ✅（**抓到 6 個問題**） |
| `ExceptionArchitectureTest`（5 條 ArchUnit） | ✅ |
| `MessageArgsGuardTest`（`args()` 的邊界） | ✅ |
| 例外成本量測（4.11.1） | ✅ |
| `MessageFormat` 的行為（4.8.2、4.8.3） | ✅ |

⚠️ **而有兩件事**仍然**沒有驗證**：

| 沒驗證的 | 為什麼 |
|---|---|
| **`ApiExceptionHandler` 的實際 HTTP 回應** | 那需要 `@WebMvcTest` + 完整的 Controller，而本章的重點是例外設計。⚠️ 04-controller 07 章有那組測試 |
| **交易行為**（4.10 整節） | 需要真的 MySQL（02 章 2.2.5 的理由）。⚠️ **4.10 的每一個結論都來自 02 章已驗證的行為，但本章的組合方式沒有跑過** |

🔴 **4.10 是這一章唯一「沒有實測」的一節，請以你的環境為準。**

---

## 4.17 下一章預告

這一章把「失敗」這件事做完了：
**41 個例外、98 個 code、五組守門測試、一份 41 句的訊息報表。**

**而它留下一個沒有回答的問題**：

> **成功的路徑呢？**
>
> `OrderQueryService.search()` 每次都打資料庫。
> 一個熱門商品頁一分鐘 8,000 次查詢，
> 而那 8,000 次拿到的是**同一份資料**。

**05 章：服務層快取。** 而它的難點不是「怎麼加 `@Cacheable`」——
那是三行設定。難點是**四個問題**：

| 05 章的節 | 主題 |
|---|---|
| 5.2 | `@Cacheable` 到底做了什麼 —— 它與 `@Transactional` **共用同一套代理機制**，所以**同一套失效情境**（02 章 2.7）全部適用 |
| 5.3 ★★ | **快取與交易的互動** —— 「交易 rollback 了，但快取已經被清掉」 |
| 5.4 ★ | **key 設計**：為什麼 `#order.id` 是一個陷阱 |
| 5.5 | 本地快取（Caffeine）vs 分散式（Redis）—— 以及「兩層快取」的一致性 |
| 5.6 ★★ | **失效策略**：`@CacheEvict` 為什麼幾乎總是不夠 |
| 5.7 ★★ | 擊穿、雪崩、穿透 —— 三個名字、三個不同的問題、三個不同的解法 |
| 5.8 | 序列化：`JdkSerializationRedisSerializer` 為什麼是一個地雷 |
| 5.9 ★ | 快取的**可觀測性**：命中率多少才算好 |
| 5.10 | 什麼**不該**快取 |
| 5.11 ★★ | 快取的測試：怎麼證明「第二次沒打資料庫」 |

⚠️ **而 05 章會回頭修正這一章的一件事**：

| 修正 | 為什麼 |
|---|---|
| `ProblemFactory` 的 `messageSource.getMessage()` **每次都查 ResourceBundle** | ⚠️ 41 個例外 × 每秒 200 次 4xx = 每秒 8,200 次 bundle 查詢。`ResourceBundleMessageSource` 有內建快取，**而它的 `cacheMillis` 預設是 -1（永久）** —— 那其實是對的。**05 章 5.10 會用它當「什麼不該再加一層快取」的例子** |

---

**完成本章後**，請確認 4.16 的清單。

⚠️ **最後一件事**：這一章有 **9 個已知缺口**與 **2 節未實測**。
**那個數字比前四章高**，而原因不是這一章寫得比較差 ——
是**這一章第一次有能力發現它們**。

> 📌 **一個誠實的缺口清單比一份「全部通過」的驗收表有用得多。**
> 前者告訴你「還有什麼要做」，後者只告訴你「作者沒有再找了」。

下一章：[05-caching-in-service-layer.md](./05-caching-in-service-layer.md)
