# 第 07 章：Service 層測試

> 06 章做了 33 個實驗，而其中一個的結論是這一章的起點：
>
> **`[E5]` —— 錯誤的寫法在 H2 上通過了測試。**
>
> 這一章要回答的問題只有一個：
>
> **一套 415 個測試、覆蓋率 92%、全部綠燈的測試，
> 到底證明了什麼？**
>
> ⚠️ 而誠實的答案是：**比你以為的少很多。**

---

## 7.0 先看見痛：三個真實事故

### 事故 1：415 個測試全綠，上線第一分鐘超賣 47 筆

**現場**（00 章 0.3.2 事故 3 的完整版）：

```
2026-11-11 00:01  促銷開始
2026-11-11 00:02  營運：「限量 100 台的手機，賣出 147 台。」
```

**而 `OrderApplicationServiceTest` 有 38 個測試，全綠，其中包括這一個**：

```java
@Test
void 庫存不足時拋InsufficientStockException() {
    when(stockPort.tryReserve("P-1", 2))
            .thenThrow(new InsufficientStockException("P-1", 5, 3));

    assertThatThrownBy(() -> service.create(command, actor))
            .isInstanceOf(InsufficientStockException.class);

    verify(orderRepository, never()).save(any());
}
```

⚠️ **這個測試是對的。它測的東西也是對的。而它與超賣完全無關。**

**因為超賣不是發生在「庫存不足時要拋例外」這條規則上**，
它發生在**「兩個執行緒同時看到庫存足夠」**這件事上：

```java
// StockApplicationService（真的實作）
@Transactional
public void deduct(List<OrderLine> lines) {
    for (OrderLine line : lines) {
        Stock stock = stockRepository.findByProductId(line.productId());   // ① SELECT
        if (stock.available() < line.quantity()) {                          // ② if
            throw new InsufficientStockException(...);
        }
        stockRepository.save(stock.deduct(line.quantity()));                // ③ UPDATE
    }
}
```

**① ② ③ 之間有兩道縫，而 02 章 2.9 說過「在 Service 裡 if 一下」在併發下必然失效。**

> 🔴 **關鍵在這裡**：
> `OrderApplicationServiceTest` 把 `StockPort` **mock 掉了**。
>
> **而被 mock 掉的東西，就是沒有被測到的東西。**
>
> 那 38 個測試證明的是「**如果** `StockPort` 正確地拋例外，
> **那麼** `OrderApplicationService` 會正確地處理」——
> 它們對「`StockPort` 到底正不正確」**一個字都沒說**。

**覆蓋率報告怎麼說的**：

```
StockApplicationService.deduct()   行覆蓋率 100%   分支覆蓋率 100%
```

⚠️⚠️ **100% 的覆蓋率，而 bug 就在被覆蓋到的那三行裡。**

> 📌 **這個事故的一句話版本**：
> **覆蓋率量的是「這行有沒有被執行過」，
> 而 bug 在「這行被【兩個執行緒同時】執行時」。**

### 事故 2：一個 `ArgumentCaptor` 讓錯誤的稽核紀錄「被證明是對的」

**現場**（2026-09-03，法遵稽核）：

```
稽核：我們要看「訂單被取消【之前】的狀態」，
     可是稽核表裡每一筆的 before 都是 CANCELLED。
     那是取消【之後】的狀態。
```

**程式碼**：

```java
/**
 * ⚠️ 這個 PR 為了「改前 / 改後對照」而新增了一個埠：
 *     interface BeforeAfterAuditRecorder { void record(String action, Order snapshot); }
 *
 * 🔴 而 00 章 0.12 早就有 AuditRecorder.record(AuditEvent) —— 它收的是【不可變的快照】。
 *    新增這個埠，就是這個事故的根。7.6.3 解法 A 的修法是「回去用本來就有的那一個」。
 */
public void cancel(CancelOrderCommand cmd) {
    Order order = repository.findById(cmd.orderId()).orElseThrow();
    beforeAfterAudit.record("CANCEL_BEFORE", order);     // ★ 此刻 status = PAID
    order.cancel(cmd.actor(), cmd.reason(), cmd.note(),  // ★ 之後才變成 CANCELLED
                 clock.instant());
    repository.save(order);
}
```

**這段程式碼是對的。** `record` 在 `cancel` 之前呼叫。

**而測試也是對的**：

```java
@Test
void 取消訂單時會記錄取消前的狀態() {
    when(repository.findById("O-1")).thenReturn(Optional.of(paidOrder("O-1")));

    service.cancel(new CancelOrderCommand(
            "O-1", CancelReason.CUSTOMER_REQUEST, null, actor, "idem-1"));

    var captor = ArgumentCaptor.forClass(Order.class);
    verify(beforeAfterAudit).record(eq("CANCEL_BEFORE"), captor.capture());
    assertThat(captor.getValue().status()).isEqualTo(OrderStatus.PAID);   // 🔴 這一行
}
```

⚠️ **這個測試會失敗。而它應該失敗嗎？不 —— 程式碼是對的。**

**實測**（⚠️ 實驗用的是它自己的玩具 `Order`／`AuditRecorder`，**不是** 00 章那一個 ——
為的是把情境縮到最小；真實的 `Order` 沒有 `confirm()`，它的狀態機是 `PENDING_PAYMENT → PAID`）：

```
[J3] 呼叫 audit.record("BEFORE", order) 的當下，order.status 是 PENDING
[J3] 之後 order.confirm() 把它改成 CONFIRMED
[J3] captor 抓到的 status = CONFIRMED
[J3] 👉 CONFIRMED = 🔴 抓到的是【參照】，斷言看到的是【最後的狀態】
```

🔴🔴 **`ArgumentCaptor` 抓到的是【物件的參照】，不是【呼叫當下的快照】。**

**於是真實世界發生的是相反的順序**：

```
第 1 週：測試紅燈（captor 抓到 CANCELLED，斷言要 PAID）
第 1 週：有人「修好」了它 —— 把斷言改成 isEqualTo(CANCELLED)  🔴
第 8 週：有人重構，把 record() 移到 cancel() 【之後】
第 8 週：✅ 測試仍然綠燈（因為斷言早就改成 CANCELLED 了）
第 30 週：稽核發現 before 全部是 CANCELLED
```

> 📌 **這個事故的一句話版本**：
> **一條「因為框架的行為而失敗」的測試，
> 會被人用「改斷言」的方式修好 —— 而那會順手把守門人拆掉。**
>
> ⚠️ **而它的根本原因不在 Mockito，在「傳可變物件」**（7.6.3 會給三種解法）。

### 事故 3：加一個依賴，180 個測試綠燈，生產環境 NPE

**現場**（2026-07-19 部署後 4 分鐘）：

```
警報：/api/orders POST 的 500 率 100%
Stack trace: NullPointerException at OrderApplicationService.create(line 88)
```

**那次 PR 做的事**：`OrderApplicationService` 多注入一個 `RiskCheckPort`。

**而測試類別是這樣寫的**：

```java
@ExtendWith(MockitoExtension.class)
class OrderApplicationServiceTest {

    @Mock OrderRepository repository;
    @Mock StockPort stockPort;
    @Mock DomainEventPublisher events;
    // ⚠️ 沒有 @Mock RiskCheckPort —— 因為寫這個測試的時候還沒有它

    @InjectMocks OrderApplicationService service;      // 🔴 這一行
}
```

⚠️ **`@InjectMocks` 找不到 `RiskCheckPort` 的 mock 時，它【不會報錯】—— 它塞 `null`。**

**實測**：

```
[J1] 三個依賴齊全 → ✅ 正常
[J1] 少一個依賴（@InjectMocks 找不到就塞 null）→
[J1]   🔴 NullPointerException（而它發生在【執行期】，不是建構期）
```

**而 180 個測試為什麼是綠的**：

因為那 180 個測試裡，**只有 3 個會走到用 `riskCheck` 的那條路徑** ——
而那 3 個的 stub 剛好都在 `riskCheck` 之前就拋例外了。

> 🔴 **`@InjectMocks` 把「建構子多了一個參數」這件事**
> **從「編譯錯誤」變成了「執行期 NPE」。**
>
> 📌 **而這一站反覆在做的事，正好相反**：
> **把靜默的錯誤換成編譯錯誤。**
> `@InjectMocks` 是往反方向走的 —— 所以 7.3.3 會建議**不要用它**。

> 📌 **這三個事故的共同結構**：
>
> | 事故 | 表面問題 | 真正的問題 |
> |---|---|---|
> | 1 | 超賣 47 筆 | **mock 掉的東西 = 沒被測到的東西** |
> | 2 | 稽核紀錄錯誤 | **測試「證明」了一件它沒有證明的事** |
> | 3 | 生產環境 NPE | **測試工具把編譯期的檢查關掉了** |
>
> **三個都不是「測試寫太少」。**
> 三個都是**「測試給了一個它撐不起來的保證」**。

---

## 7.1 學習目標

讀完這一章，你可以：

- 說出「mock 一個依賴」到底**放棄了什麼保證**，並據此決定哪些東西不該 mock。
- 說明 `@InjectMocks` 的**三個具體風險**，以及為什麼 shop-service 用建構子。
- 分辨 dummy / stub / spy / mock / fake **五種測試替身**，並說出什麼時候 fake 比 mock 好。
- 使用 `ArgumentCaptor`，並說出它**抓到的是參照而不是快照**這件事的後果與三種解法。
- 判斷該用 `verify` 還是斷言回傳值，並說出「驗太多」讓測試變脆的具體形狀。
- 用**一組 fixture + 參數化測試**測完 41 個業務例外，而不是寫 41 個測試方法。
- 說出**單元測試測不到交易**的四件事，以及哪些必須用真的資料庫。
- 寫出能**重現**超賣、寫偏斜、死鎖的併發測試，並說出為什麼它們天生不穩定。
- 說明**行覆蓋率、分支覆蓋率、突變測試**各自量的是什麼，並讀懂一份 PIT 報告。
- 分辨**「探針」與「測試」**，並說出為什麼 06 章那 33 個實驗不該原封不動留在 CI 裡。

## 前置知識

| 需要 | 用在哪 |
|---|---|
| **本站 01 章 1.5**（把不確定性注入進來） | **7.10** —— 那一節的兌現 |
| 本站 01 章 1.7（埠與轉接器） | 7.2、7.8 —— 「埠」是 mock 的邊界 |
| **本站 02 章 2.7、2.9**（交易失效、併發） | **7.11、7.12** |
| **本站 04 章 4.12**（五組守門測試、41 個例外的 fixture） | **7.7、7.15** —— 那組 fixture 在這裡被完整說明 |
| 本站 05 章 5.11（快取的測試） | 7.11 —— 「證明第二次沒打資料庫」 |
| **本站 06 章 6.11**（測試非同步） | **7.13** —— 這一章會修正它的一個建議 |

⚠️ **這一章與 04 章的關係比看起來緊密。**
04 章 4.12 寫了「41 個例外的 fixture」與「五組守門測試」，
**但沒有解釋那個模式為什麼有效** —— 這一章 7.15 補上。

---

## 7.2 「mock 掉的東西就是沒被測到的東西」★★

### 7.2.1 一個 mock 換走了什麼

```java
when(stockPort.tryReserve("P-1", 2)).thenThrow(new InsufficientStockException(...));
```

**這一行做了一個交換**：

| 得到 | 失去 |
|---|---|
| ✅ 測試很快（不用資料庫） | 🔴 `StockPort` 的**實作**沒有被測到 |
| ✅ 可以模擬「庫存不足」 | 🔴 「`StockPort` 真的會在庫存不足時拋這個例外嗎」沒有被驗證 |
| ✅ 測試不會偶發 | 🔴 **併發行為完全消失** |
| ✅ 專注在編排邏輯上 | 🔴 **介面的契約沒有被檢查**（參數順序、null 的處理…） |

> 📌 **一句話**：
> **mock 把「兩個元件之間的互動」換成「我以為它們會怎麼互動」。**
>
> ⚠️ 而那個「我以為」**永遠不會被檢查** ——
> 除非有另一層測試去檢查它。

### 7.2.2 測試金字塔在 Service 層的具體形狀

**抽象的金字塔沒有用。這是 shop-service 的實際分層**：

| 層 | 數量 | 用什麼 | 跑多久 | 抓什麼 | 抓不到什麼 |
|---|---|---|---|---|---|
| **① Domain 單元測試** | ~200 | 🔴 **完全不用 mock** | < 1s | 業務規則、不變量、狀態機 | 一切 I/O |
| **② Application 單元測試** | ~150 | mock 所有埠 | ~3s | **編排順序**、例外對映、交易邊界的「意圖」 | **交易、併發、SQL** |
| **③ Repository 整合測試** | ~60 | 真的資料庫 | ~40s | SQL、映射、**原子性** | 跨聚合的編排 |
| **④ 交易 / 併發測試** | ~15 | 真的資料庫 + 多執行緒 | ~30s | **超賣、寫偏斜、死鎖** | HTTP 層 |
| **⑤ 端到端** | ~20 | 全部真的 | ~2min | 接線、組態 | 邊界情況 |

⚠️ **注意 ① 是最大的一層，而它不用 mock。**

**理由**：00 章 0.9 把規則放進 `Order` 聚合與 `Money` 值物件之後，
**那些規則不需要任何依賴就能測**：

```java
@Test
void 已出貨的訂單不可取消() {
    Order order = anOrder().shipped().build();

    assertThatThrownBy(() -> order.cancel(customer, CancelReason.CUSTOMER_REQUEST, null, now))
            .isInstanceOf(OrderNotCancellableException.class);
}
```

**沒有 `@Mock`、沒有 `@ExtendWith`、沒有 Spring。**

> 📌 **這是 00 章「充血模型」最大的一次回報**：
> **貧血模型的四個代價**（00 章 0.4）裡，第四個就是
> **「規則散在 Service 裡 → 測試規則必須先準備一堆 mock」**。
>
> ⚠️ **反過來說**：如果你發現「測一條業務規則需要 5 個 mock」，
> 那不是測試的問題，是**規則放錯層**的訊號。

### 7.2.3 事故 1 該由哪一層抓

**回到事故 1，把它放進上面那張表**：

| 層 | 會抓到超賣嗎 |
|---|---|
| ① Domain | ❌ `Stock.deduct()` 本身是對的 |
| ② Application（mock 掉 `StockPort`） | ❌ **完全看不到** |
| ③ Repository 整合測試 | ⚠️ **只有在測「原子 UPDATE」時才會** |
| ④ **交易 / 併發測試** | ✅ **它就是為這個存在的** |
| ⑤ 端到端 | ⚠️ 除非它會開 50 條執行緒（通常不會） |

> 🔴 **所以事故 1 的根本問題不是「測試寫得不好」，
> 是【第 ④ 層根本不存在】。**
>
> 而它不存在的原因很典型：**它慢、它偶發、它難寫** ——
> 三個理由都是真的，而它們加起來仍然不足以省掉它（7.12）。

### 7.2.4 一個判準：這個依賴該 mock 嗎

```
                ┌──────────────────────────────┐
                │ 我要不要 mock 這個依賴？        │
                └───────────────┬──────────────┘
                                ▼
              ┌──────────────────────────────────┐
              │ 它是【我們定義的埠】嗎？（01 章 1.7）│
              └────────┬──────────────────┬──────┘
                    否 │                  │ 是
                       ▼                  ▼
        ┌──────────────────────┐   ┌────────────────────────────┐
        │ 🔴 不要 mock（7.9）    │   │ 它有「值得測的邏輯」嗎？      │
        │ 值物件、JDK、框架型別   │   └────┬──────────────────┬────┘
        └──────────────────────┘      是 │                  │ 否
                                          ▼                  ▼
                            ┌────────────────────┐  ┌──────────────────┐
                            │ ★ 用 fake（7.8.4） │  │ ✅ mock 它        │
                            │ 記憶體 Repository   │  │ 外部 API、寄信    │
                            └────────────────────┘  └──────────────────┘
```

⚠️ **中間那條分支（fake）是最常被忽略的一個選項**，
而它正是 `OrderRepository` 應該走的路（7.8.4）。

### 7.2.5 測 Domain 層：最大的一層，卻最少人談

**7.2.2 的表裡，① Domain 是最大的一層（~200 條）。而它是最少被討論的。**

**原因**：它太簡單了 —— 沒有 mock、沒有框架、沒有註解。
**而「簡單」正是它的價值。**

**一組典型的 Domain 測試**：

```java
class OrderTest {

    @Nested
    class 取消 {

        @Test
        void 未付款的訂單客戶可以自己取消() {
            Order order = anOrder().pendingPayment().build();

            CancellationResult result = order.cancel(
                    customer(), CancelReason.CUSTOMER_REQUEST, null, NOW);

            assertThat(order.status()).isEqualTo(OrderStatus.CANCELLED);
            assertThat(result.refundRequired()).isFalse();          // ★ 沒付款 → 不用退
        }

        @Test
        void 已付款的訂單取消時要標記需要退款() {
            Order order = anOrder().paid().build();

            CancellationResult result = order.cancel(
                    customer(), CancelReason.CUSTOMER_REQUEST, null, NOW);

            assertThat(result.refundRequired()).isTrue();
            assertThat(result.refundAmount()).isEqualTo(Money.twd("1180"));
        }

        @Test
        void 客戶在七天後不可自行取消但客服可以() {
            Order order = anOrder().paid().createdAt(NOW.minus(Duration.ofDays(8))).build();

            assertThatThrownBy(() ->
                    order.cancel(customer(), CancelReason.CUSTOMER_REQUEST, null, NOW))
                    .isInstanceOf(SelfCancelWindowExpiredException.class);

            // ★★ 同一個情境，換一個 Actor → 應該成功
            //    ⚠️ 客服必須填 note，否則拋 CancelNoteRequiredException（00 章 0.9.2）
            assertThatCode(() ->
                    order.cancel(support(), CancelReason.SUPPORT_REQUEST, "客戶來電要求", NOW))
                    .doesNotThrowAnyException();
        }
    }
}
```

⚠️ **注意最後一個測試的形狀**：**同一個情境，兩個 Actor，兩個結果。**

> 📌 **這是 04 章 4.7「一個例外兩個狀態碼」在測試裡的樣子** ——
> 而它在 Domain 層測起來只要 4 行，
> **在 Application 層要準備 6 個 mock，在端到端要起一個容器。**

**三個 Domain 層專屬的測試技巧**：

**① `@Nested` 讓「情境」有結構**

```java
class OrderTest {
    @Nested class 建立 { … }
    @Nested class 取消 { … }
    @Nested class 出貨 {
        @Nested class 部分出貨 { … }        // ★ 可以再巢狀
    }
    @Nested class 不變量 { … }
}
```

**IDE 與 CI 的報告會照這個結構顯示**，於是「哪一組壞了」一眼看得出來。

**② 不變量要有一組專屬的測試**

```java
@Nested
class 不變量 {

    /** ★★ I2：明細金額的總和必須等於 subtotal（00 章 0.9.2） */
    @Test
    void I2_明細總和必須等於小計() {
        Order order = anOrder().withLines(aLine("P-1", 2, "590"), aLine("P-2", 1, "300")).build();

        assertThat(order.subtotal()).isEqualTo(Money.twd("1480"));
    }

    /** ★★★ 這一條測的是「守門人存在」而不是「值算得對」 */
    @Test
    void I3_庫存與明細不一致時assertInvariants會拋例外() {
        Order order = anOrder().build();
        ReflectionTestUtils.setField(order, "subtotal", Money.twd("999"));   // ⚠️ 破壞它

        assertThatThrownBy(order::assertInvariants)
                .isInstanceOfSatisfying(InvariantViolationException.class,
                        e -> assertThat(e.errorCode()).isEqualTo(ErrorCode.INTERNAL_ERROR));
    }
}
```

⚠️⚠️ **第二個測試用了 `ReflectionTestUtils` 去【破壞】物件，而那通常是壞味道。**

**這裡它是對的，理由**：

> **`assertInvariants()` 的存在意義就是「防禦一個【不應該發生】的狀態」。**
> **而要測一個「不應該發生的狀態」，就必須用不正常的手段製造它。**
>
> 📌 **判準**：
> **用反射製造「正常路徑做不出來的狀態」→ 只有在測「最後一道防線」時才對。**
> 用反射**繞過驗證去準備一般的測試資料** → 🔴 永遠是錯的（7.14.2 決定 ③）。

**③ 值物件的測試：等值、不可變、邊界**

```java
class MoneyTest {

    @Test
    void 相同金額與幣別的Money相等() {
        assertThat(Money.twd("100.00")).isEqualTo(Money.twd("100"));   // ★ scale 被正規化
    }

    @Test
    void 不同幣別不可相加() {
        assertThatThrownBy(() -> Money.twd("100").plus(Money.of("100", "JPY")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("幣別不一致");
    }

    /** ★★ 03 章 3.8.4 那條「金額型別」的掃描測試守的是【用不用 Money】，
     *     這一條守的是【Money 自己算得對不對】 */
    @ParameterizedTest
    @CsvSource({
            "TWD, 100.555, 101",       // ★ 台幣 0 位小數，HALF_UP
            "TWD, 100.4,   100",
            "USD, 100.555, 100.56",    // ★ 美金 2 位小數
            "JPY, 100.5,   101",       // ★ 日圓 0 位小數
    })
    void 建構時依幣別四捨五入(String currency, String input, String expected) {
        assertThat(Money.of(input, currency).toPlainString()).isEqualTo(expected);
    }
}
```

> 📌 **值物件是最划算的測試對象**：
> **它們沒有依賴、跑得極快、而且錯了會影響整個系統**
> —— 00 章 0.3.2 事故 4（一年後對帳差 3,000 元）就是 `Money` 的問題。

---

## 7.3 Mockito 的基礎，以及三個決定

### 7.3.1 shop-service 的第一個 Application 測試

```java
package example.shop.order.application;

/**
 * ★★ 注意這個測試類別<b>沒有</b>：
 * <ul>
 *   <li>{@code @SpringBootTest}（不需要容器）</li>
 *   <li>{@code @InjectMocks}（7.3.3）</li>
 *   <li>任何資料庫</li>
 * </ul>
 * 它跑一次大約 40 毫秒。
 */
@ExtendWith(MockitoExtension.class)
class OrderApplicationServiceTest {

    @Mock OrderRepository       orderRepository;
    @Mock StockPort             stockPort;
    @Mock CouponRepository      couponRepository;
    @Mock CouponUsageRepository couponUsageRepository;
    @Mock OrderDataLoader       dataLoader;
    @Mock DomainEventPublisher  events;
    @Mock IdGenerator           ids;
    @Mock OrderNumberGenerator  numbers;

    // ★★ 這兩個【不是】mock —— 見 7.9 與 7.10
    private final Clock clock = Clock.fixed(Instant.parse("2026-08-28T10:00:00Z"), ZoneOffset.UTC);
    private final OrderFactory factory = new OrderFactory(new DefaultPricingPolicy(),
                                                         new ShippingFeePolicy2026());

    private OrderApplicationService service;

    @BeforeEach
    void setUp() {
        // ★★★ 用建構子，不用 @InjectMocks（7.3.3）
        service = new OrderApplicationService(
                orderRepository, stockPort, couponRepository, couponUsageRepository,
                dataLoader, factory, events, ids, numbers, clock);
    }

    @Test
    void 成立訂單時會依序扣庫存並發出事件() {
        given(dataLoader.load(any())).willReturn(aLoadedContext());
        given(ids.newOrderId()).willReturn("01J8XYZ");
        given(numbers.next(any())).willReturn(new OrderNumber("SO-20260828-0001"));

        OrderResultView result = service.create(aCreateCommand(), aCustomer());

        assertThat(result.orderId()).isEqualTo("01J8XYZ");
        assertThat(result.total()).isEqualTo(Money.twd("1180"));

        // ★ 順序很重要：先扣庫存，再存訂單（02 章 2.14.1 ①）
        InOrder inOrder = inOrder(stockPort, orderRepository, events);
        inOrder.verify(stockPort).tryReserve(anyString(), anyInt());
        inOrder.verify(orderRepository).save(any());
        inOrder.verify(events).publish(any(OrderPlacedEvent.class));
    }
}
```

### 7.3.2 決定 ①：strict stubs（別關掉它）

**Mockito 5 的 `MockitoExtension` 預設是 `Strictness.STRICT_STUBS`，它做兩件事**：

| 檢查 | 什麼時候報錯 |
|---|---|
| **`UnnecessaryStubbingException`** | 準備了 stub 但測試沒用到 |
| **`PotentialStubbingProblem`** | 呼叫了 stub 過的方法但**參數不符** |

**實測**：

```
[J2] 準備了一個沒用到的 stub，測試本身通過。
[J2] ⚠️ MockitoExtension 會在【測試結束後】拋 UnnecessaryStubbingException
```

⚠️ **很多人第一次遇到它會直接關掉**：

```java
@MockitoSettings(strictness = Strictness.LENIENT)      // 🔴 不要
```

**而那兩個檢查各自抓的是真的問題**：

| 檢查 | 它抓到的真實 bug |
|---|---|
| `UnnecessaryStubbingException` | **程式碼路徑改了，而測試沒跟著改** —— 測試還在測一條不存在的路徑 |
| `PotentialStubbingProblem` | 🔴 **參數變了**（例如 `deduct(lines)` 變成 `deduct(orderId, lines)`），而 stub 沒對上 → 回傳 `null` → NPE 或靜默錯誤 |

> 📌 **正確的處理不是關掉整個類別的嚴格模式，而是針對那一行**：
>
> ```java
> lenient().when(clock.instant()).thenReturn(fixedNow);   // ⚠️ 而這通常代表 7.10 的問題
> ```
>
> ⚠️ **如果一個測試類別有超過 2 個 `lenient()`，那是一個訊號**：
> 多半是「`@BeforeEach` 裡準備了所有測試的 stub」——
> 而正確的做法是把 stub 移到**需要它的那個測試**裡。

### 7.3.3 決定 ②：不用 `@InjectMocks` ★★

**事故 3 的直接原因。**

| `@InjectMocks` 的問題 | 說明 |
|---|---|
| ① 🔴 **少一個依賴時塞 `null`，不報錯** | 事故 3（實測 `[J1]`） |
| ② ⚠️ **注入策略是「猜」的** | 建構子 → setter → field，而它會選**參數最多的**建構子 |
| ③ 🔴 **兩個相同型別的依賴會被搞混** | `PaymentGateway primary` 與 `PaymentGateway fallback` —— 它靠**欄位名**猜 |

**改用建構子之後，事故 3 變成什麼**：

```java
service = new OrderApplicationService(orderRepository, stockPort, /* … */);
//                                    🔴 編譯錯誤：actual and formal argument lists differ in length
```

> 📌 **這是這一站的核心手法在測試上的應用**：
> **把「執行期的 NPE」換成「編譯錯誤」。**
>
> ⚠️ **代價是真的**：加一個依賴時，**每一個測試類別的 `setUp()` 都要改**。
> 而那**正是重點** —— 它強迫你看見「這個 Service 有幾個依賴」
> （01 章 1.2「14 個依賴怎麼分析」）。
>
> 🔴 **一個「加依賴不痛」的專案，會累積到 14 個依賴。**

⚠️ **一個折衷（如果 `setUp()` 真的太吵）**：

```java
/** ★ 一個「所有依賴都有預設 mock」的建構器 —— 但它仍然是【明確的建構子呼叫】 */
private OrderApplicationServiceBuilder aService() {
    return new OrderApplicationServiceBuilder()
            .orderRepository(orderRepository)
            .stockPort(stockPort)
            /* … */;
}
```

**它與 `@InjectMocks` 的差別**：加一個建構子參數時，
**`OrderApplicationServiceBuilder` 編譯不過** → 一個地方改，而不是 20 個地方 NPE。

### 7.3.4 決定 ③：`given/willReturn` 而不是 `when/thenReturn`

**兩者功能完全相同**（`BDDMockito` 只是別名）。**shop-service 用 BDD 風格**：

```java
// given（準備）
given(dataLoader.load(any())).willReturn(context);

// when（執行）
OrderResultView result = service.create(command, actor);

// then（斷言）
then(stockPort).should().deduct(any());
```

**理由**：`when` 這個字在測試裡有兩個意思，而它們是**相反的**：

```java
when(mock.foo()).thenReturn(x);      // ← 這是【準備】（given）
// when：                             ← 這是【執行】
```

> 📌 **小事，但它讓「這一行是準備還是執行」不需要思考。**
> ⚠️ 不過**不要混用** —— 一個專案選一種。

### 7.3.5 一個常被誤解的預設行為

**未被 stub 的方法回傳什麼？**

| 回傳型別 | Mockito 的預設 |
|---|---|
| 物件 | `null` |
| `int` / `long` | `0` |
| `boolean` | `false` |
| `Optional<T>` | ✅ **`Optional.empty()`**（不是 `null`！） |
| `List` / `Set` / `Map` | ✅ **空集合** |
| `Stream` | ✅ 空 stream |

⚠️ **`Optional` 與集合那三列是 Mockito 2 之後才有的（`RETURNS_DEFAULTS`），
而它們會讓一類 bug 靜默通過**：

```java
// 忘記 stub findById
OrderResultView r = service.cancel(aCancelCommand("O-1"));
// → repository.findById("O-1") 回 Optional.empty()
// → .orElseThrow() → OrderNotFoundException
// ⚠️ 於是測試「成功地」測到了一條它不打算測的路徑
```

> 📌 **`PotentialStubbingProblem`（7.3.2）擋得住「參數不符」，
> 但擋不住「完全沒 stub」** —— 後者要靠**斷言夠具體**來擋。

### 7.3.6 `@Mock` / `@MockBean` / 測試切片：三個不同的東西 ★★

**這三個常被混用，而它們的成本差了兩個數量級。**

| | `@Mock` | `@MockBean` | 測試切片 |
|---|---|---|---|
| 需要 Spring 容器嗎 | ❌ **不用** | ✅ 要 | ✅ 要 |
| 一個測試類別的啟動成本 | **~0 ms** | **~1～3 秒** | ~1～5 秒 |
| 它做什麼 | 建一個假物件 | **把容器裡的 bean 換掉** | 只載入一部分的容器 |
| 什麼時候用 | ✅ **絕大多數** | 需要容器（AOP、交易、Web） | Repository / Controller |

⚠️ **版本註記**：`@MockBean` 在 **Spring Boot 3.4 起被 `@MockitoBean` 取代**
（`@MockBean` 標為 deprecated）。本站的基準是 **Boot 3.2.5**，所以用 `@MockBean`
—— 它在基準版本上**直接編譯得過**，不需要任何條件組態。

> ⚠️⚠️ **而 04-controller 站刻意選了相反的做法：它全站寫 `@MockitoBean`**
> （04-controller 7.6.1，加逐處註記與一個 `mvn` profile），基準版本一樣是 Boot 3.2.5。
>
> **不是其中一個錯了，是兩站要教的東西不同**：
>
> | 站 | 寫哪一個 | 那一站在教什麼 |
> |---|---|---|
> | **04-controller** | `@MockitoBean` + 逐處註記 | **版本遷移本身** —— 一個註解改名會讓 72 處測試在你的版本上編不過，那一節就是為此存在的 |
> | **05-service（本站）** | `@MockBean` | Mockito 與測試分層。版本問題會佔用注意力，所以寫在基準上能直接跑的那個 |
>
> 🔴 **實務上的意思**：如果你把兩站的測試放進同一個專案，**挑一個統一**。
> 兩者語意完全相同，只有 import 與類別名不同 ——
> 而「哪一個」取決於你的 Boot 版本，不取決於課程。

**🔴 一個最常見的錯誤組合**（練習 1 的第 1 個問題）：

```java
@SpringBootTest
class OrderApplicationServiceTest {
    @Mock OrderRepository repository;          // 🔴 這個 mock 不在容器裡
    @Autowired OrderApplicationService service; // ← 它注入的是【真的】repository
}
```

> 🔴 **`@Mock` 建立的物件與 Spring 容器毫無關係。**
> 於是這個測試**看起來**在用 mock，實際上在用真的實作 ——
> 而 stub 完全沒有生效（`when(...)` 對一個沒人用的物件生效了）。
>
> ⚠️ **strict stubs 會抓到它**（`UnnecessaryStubbingException`）——
> **除非有人把 strictness 關成 `LENIENT`**（練習 1 的第 3 個問題）。
> **兩個錯誤加起來，測試就變成了一個什麼都沒測的綠燈。**

**`@MockBean` 的隱藏成本：它會讓 context cache 失效**

Spring 的 `TestContext` 框架會**快取應用程式上下文**，
快取的鍵包含：`classes`、`profiles`、`properties`、**以及 `@MockBean` 的集合**。

```java
class A { @MockBean ErpPort erp; }                    // ★ context #1
class B { @MockBean ErpPort erp; }                    // ✅ 同一個 key → 重用 #1
class C { @MockBean ErpPort erp; @MockBean MailSender mail; }  // 🔴 新的 key → context #2
```

⚠️ **於是「每個測試類別 mock 掉一點點不同的東西」會造成
【每個測試類別各起一個 Spring 容器】** ——
**20 個類別 × 3 秒 = 一分鐘，全部花在啟動上。**

**shop-service 的規則**：

| 規則 | 理由 |
|---|---|
| ① **預設用 `@Mock` + 建構子** | 不需要容器的就不要用容器 |
| ② 需要容器時，**把 `@MockBean` 的組合集中成幾個固定的 `@TestConfiguration`** | 讓 context cache 命中 |
| ③ **不要用 `@DirtiesContext`**（除非真的必要） | 它明確地把快取丟掉 |

```java
/** ★★ 一個共用的測試組態：所有「需要容器 + 假的外部系統」的測試都用它 */
@TestConfiguration
public class FakeOutboundConfig {
    @Bean @Primary ErpPort erpPort()                 { return new InMemoryErpPort(); }
    @Bean @Primary PaymentGateway paymentGateway()   { return new InMemoryPaymentGateway(); }
    @Bean @Primary EmailSender emailSender()         { return new RecordingEmailSender(); }
}
```

```java
@SpringBootTest
@Import(FakeOutboundConfig.class)      // ★ 20 個測試類別共用同一個 context
class OrderTransactionIntegrationTest { … }
```

> 📌 **注意這裡又出現了 fake（7.8）而不是 mock**：
> **`@Bean` 的 fake 可以被快取，`@MockBean` 不行** ——
> 因為 fake 是組態的一部分，而 `@MockBean` 是「對這個 context 的修改」。
>
> ✅ **而 fake 還多一個好處**：`RecordingEmailSender` 可以在測試裡問
> 「總共寄了幾封、寄給誰」，而不需要 `verify`。

### 7.3.7 三種測試切片

| 切片 | 載入什麼 | 用來測 |
|---|---|---|
| `@DataJpaTest` | JPA + 內嵌資料庫 + **自動 rollback** | Repository |
| `@JdbcTest` | `DataSource` + `JdbcTemplate` | JDBC Repository |
| `@WebMvcTest` | Controller + advice + 轉換器（**沒有 Service**） | 04-controller 站 |

⚠️ **`@DataJpaTest` 預設會 `@Transactional` + rollback** ——
**而 7.11.2 說過那會讓 `AFTER_COMMIT` 的東西測不到。**

```java
@DataJpaTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)   // ★ 需要真的 commit 時
class OutboxRepositoryTest { … }
```

**或更直接**：

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = NONE)     // ★ 用真的資料庫而不是內嵌的
class OrderSearchRepositoryTest { … }
```

---

## 7.4 stub：四種方式與它們的適用範圍

### 7.4.1 四種寫法

```java
// ① 最常見
given(repository.findById("O-1")).willReturn(Optional.of(order));

// ② 拋例外
given(stockPort.tryReserve(anyString(), anyInt()))
        .willThrow(new InsufficientStockException("P-1", 5, 3));

// ③ 依參數決定（Answer）
given(repository.findById(anyString())).willAnswer(inv -> {
    String id = inv.getArgument(0);
    return id.startsWith("O-") ? Optional.of(anOrder(id)) : Optional.empty();
});

// ④ 連續呼叫回不同的值 —— ★ 測「重試」時的關鍵
given(paymentGateway.charge(any()))
        .willThrow(new UpstreamUnavailableException("payment", 503, null))
        .willThrow(new UpstreamUnavailableException("payment", 503, null))
        .willReturn(new ChargeResult.Succeeded("D-1", Money.twd("1180"), now));
```

⚠️ **④ 是 06 章 6.6 的測試方式，而它很容易寫錯**：

```java
// 🔴 錯：這樣寫是「覆蓋」，不是「連續」
given(gateway.charge(any())).willThrow(ex);
given(gateway.charge(any())).willReturn(ok);      // 前一行被蓋掉了
```

### 7.4.2 `Answer` 的三個正當用途與一個誤用

| 用途 | 例子 |
|---|---|
| ✅ **回傳依參數而定的值** | 假的 `IdGenerator` 依序發號 |
| ✅ **回傳「傳進來的東西」** | `given(repo.save(any())).willAnswer(inv -> inv.getArgument(0))` |
| ✅ **模擬延遲**（測逾時／併發） | `willAnswer(inv -> { Thread.sleep(100); return x; })` |
| 🔴 **在 `Answer` 裡放業務邏輯** | ⚠️ 見下 |

```java
// 🔴 誤用：Answer 裡有 if / 計算 / 狀態
given(stockPort.tryReserve(anyString(), anyInt())).willAnswer(inv -> {
    String productId = inv.getArgument(0);
    int quantity     = inv.getArgument(1);
    int remaining = stockMap.get(productId) - quantity;
    if (remaining < 0) throw new InsufficientStockException(productId, quantity, stockMap.get(productId));
    stockMap.put(productId, remaining);
    return true;
});
```

> 🔴 **當一個 `Answer` 開始有狀態與分支時，它已經是一個 fake 了 ——
> 只是一個【寫在測試方法裡、不能重用、沒有名字】的 fake。**
>
> 👉 **正確的做法是把它變成一個真正的 fake 類別**（7.8.4）：
> `InMemoryStockPort` —— 有名字、可重用、可以自己被測試。

### 7.4.3 參數匹配器：一個實測出來的意外 🔴

⚠️ **這個實驗用的是一個只有實驗才有的小介面**
（`interface StockPort { void deduct(List<String> productIds); }`）——
**它不是本站正式的 `StockPort`**（那一個是 `tryReserve(String, int)`，00 章 0.12 ⑩）。
用一個吃 `List` 的方法，是因為要對照的正是「有型別的匹配器」。

```java
stockPort.deduct(null);                 // ← 實際上傳了 null

verify(stockPort).deduct(any());        // 匹配 null 嗎？
verify(stockPort).deduct(anyList());    // 匹配 null 嗎？
```

**大部分人會說「兩個都匹配」或「兩個都不匹配」。實測**：

```
[J4] verify(stock).deduct(any())     對【null 參數】→ ✅ 匹配成功
[J4] verify(stock).deduct(anyList()) 對【null 參數】→ 🔴 不匹配（WantedButNotInvoked）
```

🔴 **`any()` 匹配 `null`，`anyList()` 不匹配 `null`。**

**整理**（Mockito 5.7.0）：

| 匹配器 | 匹配 `null` 嗎 | 說明 |
|---|---|---|
| `any()` | ✅ **會** | 它是「任何東西，包括 null」 |
| `any(Foo.class)` | 🔴 **不會**（Mockito 2+） | ⚠️ 它在 Mockito 1 會，**升級時行為變了** |
| `anyList()` / `anyString()` / `anyInt()` | 🔴 **不會** | 有型別的匹配器都不匹配 null |
| `isNull()` | ✅ 只匹配 null | |
| `nullable(Foo.class)` | ✅ 會 | ★ 「Foo 或 null」 |

> 📌 **實務上的意義**：
> **`any()` 是一個比它看起來更寬鬆的匹配器。**
>
> 事故 2 的那種問題（「傳錯了東西但測試沒發現」）**多半來自 `any()`** ——
> 而換成 `anyList()` 就會多擋掉一種情況（傳了 null）。
>
> ⚠️ **而最好的做法是連 `anyList()` 都不要用**（7.6）。

### 7.4.4 一個規則：一旦用了匹配器，**全部**參數都要用

```java
// 🔴 InvalidUseOfMatchersException
verify(audit).record("CANCEL", any());

// ✅
verify(audit).record(eq("CANCEL"), any());
```

⚠️ **它的錯誤訊息會指向【下一個】用到 mock 的地方**，
所以有時候紅燈的測試不是出問題的那一個。

---

## 7.5 驗證行為：`verify` 與它的代價

### 7.5.1 什麼時候該 `verify`，什麼時候該斷言回傳值

| 情況 | 用什麼 |
|---|---|
| 方法有回傳值，而回傳值就是結果 | ✅ **斷言回傳值** |
| 方法是 `void`，效果在別的地方 | ✅ `verify` |
| **副作用的順序很重要** | ✅ `InOrder` |
| **某件事【不該】發生** | ✅ `verify(mock, never())` |

⚠️ **最常見的浪費**：兩個都做。

```java
OrderResultView result = service.create(command, actor);

assertThat(result.orderId()).isEqualTo("01J8XYZ");
verify(orderRepository).save(any());                     // ⚠️ 這一行加了什麼？
```

> 📌 **判準**：
> **「如果我把這一行拿掉，有哪個 bug 會溜過去？」**
>
> 上面那個 `verify(save(any()))` 的答案是「沒有」——
> 因為如果沒存，`result.orderId()` 也不會是對的。

### 7.5.2 `never()` 是最有價值的 verify ★

```java
@Test
void 庫存不足時不可以存訂單也不可以發事件() {
    given(stockPort.tryReserve(anyString(), anyInt()))
        .willThrow(new InsufficientStockException("P-1", 5, 3));

    assertThatThrownBy(() -> service.create(command, actor))
            .isInstanceOf(InsufficientStockException.class);

    verify(orderRepository, never()).save(any());        // ★★
    verify(events,          never()).publish(any());     // ★★
}
```

**為什麼 `never()` 比一般的 `verify` 有價值**：

| | 一般 `verify` | `never()` |
|---|---|---|
| 它斷言的是 | 「有做這件事」 | **「沒有做這件事」** |
| 通常也能由 | 回傳值 / 狀態斷言 涵蓋 | 🔴 **沒有別的方式能表達** |
| 抓到的 bug | 「漏做了」 | **「多做了」** —— 而那一類 bug 特別難發現 |

⚠️ **而 `never()` 在這個例子裡守的是一條真的業務規則**：
「庫存不足時不可以送出 `OrderPlacedEvent`」——
否則 06 章的 outbox 會把一封「訂單成立」的信寄給一個沒有訂單的人。

### 7.5.3 `verifyNoMoreInteractions` 的兩面性

```java
verifyNoMoreInteractions(orderRepository, stockPort, events);
```

| | |
|---|---|
| ✅ 它抓到 | 「多做了一件我沒預期的事」 |
| 🔴 它的代價 | **每一次新增一個正當的呼叫，所有用它的測試都紅燈** |

> 📌 **shop-service 的規則：只在【一個地方】用它**，
> 就是「這個方法在失敗路徑上應該什麼都不做」的那組測試。
>
> ⚠️ **不要在快樂路徑上用** —— 那會讓測試變成
> 「程式碼的逐行複寫」，而那種測試**唯一保證的是「程式碼沒有被改過」**。

### 7.5.4 過度驗證的具體形狀

```java
// 🔴 這個測試除了「複述實作」之外什麼都沒做
@Test
void 建立訂單() {
    service.create(command, actor);

    verify(dataLoader).load(any());
    verify(ids).newOrderId();
    verify(numbers).next(any());
    inOrder.verify(stockPort).tryReserve(anyString(), anyInt());
    verify(orderRepository).save(any());
    verify(events).publish(any());
    verifyNoMoreInteractions(dataLoader, ids, numbers, stockPort, orderRepository, events);
}
```

**它的問題不是「太嚴格」，是【它測不到任何業務規則】**：

| 這個測試會紅燈的情況 | 是 bug 嗎 |
|---|---|
| 有人把 `ids.newOrderId()` 搬到 `OrderFactory` 裡 | ❌ **重構，不是 bug** |
| 有人加了一行 `auditRecorder.record(...)` | ❌ **新功能，不是 bug** |
| 🔴 **金額算錯了** | ✅ 是 bug ——**而這個測試不會紅** |

> 🔴 **一個「重構會紅、bug 不會紅」的測試，是負資產。**
> 它的成本（每次重構都要改）大於它的收益（幾乎為零）。

### 7.5.5 命名與結構：CI 上你只看得到名字

**一個測試方法有兩次機會說明自己：名字、與失敗訊息。**

**名字：三段式**

```java
// 🔴 說明不了任何事
void testCancel()
void 取消訂單()
void cancel_shouldWork()

// ✅ 條件 + 動作 + 期望
void 已出貨的訂單被取消時拋OrderNotCancellable()
void 客戶在七天後自行取消時拋SelfCancelWindowExpired()
void 已付款的訂單取消時標記需要退款且金額等於已付金額()
```

⚠️ **中文方法名在 Java 是合法的，而這一站刻意使用它** ——
理由是**測試的名字是給人讀的**，而業務規則本來就是用中文描述的。

> 📌 **一個檢查**：
> **把測試的名字全部列出來，它應該讀起來像一份規格書。**
>
> ```
> Order › 取消
>   ✓ 未付款的訂單客戶可以自己取消
>   ✓ 已付款的訂單取消時要標記需要退款
>   ✓ 客戶在七天後不可自行取消但客服可以
>   ✓ 已出貨的訂單不可取消
> ```
>
> ⚠️ **如果讀起來不像規格書，那通常代表測試是照著【程式碼】寫的，
> 而不是照著【規則】寫的** —— 而那種測試在重構時會全部紅燈（7.5.4）。

**結構：AAA（Arrange / Act / Assert）**

```java
@Test
void 已付款的訂單取消時要標記需要退款() {
    // given
    Order order = anOrder().paid().build();

    // when
    CancellationResult result =
            order.cancel(customer(), CancelReason.CUSTOMER_REQUEST, null, NOW);

    // then
    assertThat(result.refundRequired()).isTrue();
}
```

⚠️ **一個實用的規則：`when` 只有一行。**

**如果 `when` 有三行，那這個測試在測三件事** —— 而失敗時你不知道是哪一件。

**失敗訊息：`as()` 是最便宜的投資**

```java
// 🔴 失敗訊息：expected: 10 but was: 14
assertThat(availableOf("P-1")).isEqualTo(10);

// ✅ 失敗訊息：[剩餘庫存（50 執行緒各買 1 件，初始 10）] expected: 10 but was: 14
assertThat(availableOf("P-1"))
        .as("剩餘庫存（50 執行緒各買 1 件，初始 10）")
        .isEqualTo(10);
```

> 📌 **04 章、05 章、06 章的每一條守門測試都有 `as(...)`，而那不是風格問題**：
> **三個月後半夜三點看到 CI 紅燈的人，只看得到那一行訊息。**
>
> **最好的 `as(...)` 會告訴他「去哪一節看完整的理由」**：
>
> ```java
> .as("金流不可重試（06 章 6.0 事故 3）—— 逾時是【結果未知】而不是失敗")
> ```

**AssertJ 的三個好用但少人用的東西**

```java
// ① 一次斷言多個欄位，而且失敗時【全部】列出來（不是第一個就停）
assertThat(result)
        .extracting(OrderResultView::orderId, OrderResultView::status, OrderResultView::total)
        .containsExactly("01J8XYZ", OrderStatus.PENDING_PAYMENT, Money.twd("1180"));

// ② 集合的內容斷言
assertThat(event.lines())
        .extracting(LineSummary::productId, LineSummary::quantity)
        .containsExactlyInAnyOrder(tuple("P-1", 2), tuple("P-2", 1));

// ③ SoftAssertions：失敗時把【所有】斷言的結果一起報出來
SoftAssertions.assertSoftly(softly -> {
    softly.assertThat(order.status()).isEqualTo(OrderStatus.CANCELLED);
    softly.assertThat(order.cancellation().reason()).isEqualTo(CancelReason.CUSTOMER_REQUEST);
    softly.assertThat(order.cancellation().cancelledAt()).isEqualTo(NOW);
});
```

⚠️ **③ 的取捨**：它讓一次失敗給出更多資訊，
**但也讓「一個測試只測一件事」變得容易被違反**。

> 📌 **shop-service 的用法：只在「一個結果物件的多個欄位」上用 SoftAssertions**，
> 不在「多個不相關的斷言」上用。

---

## 7.6 `ArgumentCaptor` ★★

### 7.6.1 它解決什麼

**「傳下去的東西是對的嗎」** —— 而 `eq(...)` 在物件很大時不好用。

```java
@Test
void 訂單成立的事件帶著客戶email與明細摘要() {
    service.create(aCreateCommandWith2Lines(), aCustomer());

    var captor = ArgumentCaptor.forClass(OrderPlacedEvent.class);
    then(events).should().publish(captor.capture());

    OrderPlacedEvent event = captor.getValue();
    assertThat(event.customerEmail()).isEqualTo("alice@example.com");
    assertThat(event.lines()).hasSize(2);
    assertThat(event.total()).isEqualTo(Money.twd("1180"));

    // ★★ 這一條是 00 章 0.12 ⑬ 那段 javadoc 的守門人
    assertThat(event).extracting("shippingSnapshot").isNull();
}
```

⚠️ **最後一條特別值得看**：00 章刻意讓 `OrderPlacedEvent`
**不帶收件地址與電話**（PII 不進事件）。
**那個決定寫在 javadoc 裡，而 javadoc 不會讓 CI 紅燈。**

> 📌 **凡是「刻意不做的事」，都需要一條測試守著** ——
> 否則下一個人會覺得「加進去比較方便」。

### 7.6.2 🔴 它抓到的是參照，不是快照

**事故 2 的機制。實測**（同 7.0 事故 2 的註記：實驗用的是玩具類別）：

```
[J3] 呼叫 audit.record("BEFORE", order) 的當下，order.status 是 PENDING
[J3] 之後 order.confirm() 把它改成 CONFIRMED
[J3] captor 抓到的 status = CONFIRMED
```

**原因**：Mockito 記錄的是**呼叫的參數陣列**，而陣列裡放的是**物件的參照**。
**呼叫之後那個物件被改了，captor 裡的東西就跟著改。**

⚠️ **它影響的不只是 `ArgumentCaptor`**：

| 也受影響 | 說明 |
|---|---|
| `verify(mock).method(eq(expected))` | ⚠️ `equals` 在**驗證的時刻**才執行 |
| `verify(mock).method(argThat(...))` | 同上 |
| 🔴 **`Answer` 裡存下來的參數** | 同一個參照 |

### 7.6.3 三種解法

```java
// 解法 A（★★ shop-service 的選擇）：把那個 2 參數的埠刪掉，
//          回去用 00 章 0.12 本來就有的 AuditRecorder
auditRecorder.record(AuditEvent.orderCancelled(order, actor, result.refundAmount(), now));
//                   ^^^^^^^^^^^^^^^^^^^^^^^^^ record，在建立當下就把值抄下來
```

```java
// 解法 B：用 Answer 在【呼叫當下】抄一份
var captured = new AtomicReference<OrderStatus>();
willAnswer(inv -> {
    Order o = inv.getArgument(1);
    captured.set(o.status());              // ★ 呼叫當下就取值
    return null;
}).given(beforeAfterAudit).record(any(), any());
```

```java
// 解法 C：用 argThat 在【呼叫當下】斷言
//    ⚠️ 它的失敗訊息很糟（只說「沒有匹配的呼叫」），所以只在 A、B 都不行時用
verify(beforeAfterAudit).record(eq("CANCEL_BEFORE"),
        argThat(o -> o.status() == OrderStatus.PAID));
```

> 📌 **解法 A 是唯一一個「連生產程式碼一起變好」的**：
>
> 傳一個**不可變的快照**給稽核，本來就比傳整個聚合對 ——
> **00 章 0.3.2 事故 6**（`toJson(order)` 把客戶地址存進沒遮蔽的表）
> 說的就是同一件事。
>
> 🔴 **而這是一個一般性的觀察**：
> **「測試很難寫」通常是設計的訊號，而不是測試工具的問題。**

### 7.6.4 `@Captor` 與泛型

```java
// 🔴 編譯警告：無法對泛型型別用 forClass
var captor = ArgumentCaptor.forClass(List<OrderLine>.class);

// ✅ 用 @Captor
@Captor ArgumentCaptor<List<OrderLine>> linesCaptor;
```

---

## 7.7 例外路徑的測試 ★★

### 7.7.1 41 個例外，不要寫 41 個測試方法

**04 章 4.12 已經有一組 `ExceptionFixtures`，這一節解釋它的設計。**

```java
/**
 * ★★ 41 個業務例外各一個「可以被實例化的樣本」。
 *
 * <p>它的價值不在「測試每一個例外」，而在
 * <b>讓「對所有例外都成立的性質」可以被一次驗證</b>。
 *
 * <p>⚠️ 而它自己就是一個守門人：新增一個例外而忘記加 fixture
 * → {@code BusinessExceptionRegistryTest} 紅燈（04 章 4.12.2）。
 */
public final class ExceptionFixtures {

    public static Stream<BusinessException> all() {
        return Stream.of(
                new OrderNotCancellableException("O-1", OrderStatus.SHIPPED),
                new OrderEmptyException(),
                new InsufficientStockException("P-1", 5, 3),
                /* … 38 個 … */);
    }
}
```

**於是「41 個例外的 5 條性質」變成 5 個測試方法**：

```java
@ParameterizedTest
@MethodSource("example.shop.common.error.ExceptionFixtures#all")
void 每個業務例外都有可解析的使用者訊息(BusinessException ex) {
    String message = messageSource.getMessage(
            ex.errorCode().userMessageKey(), ex.userMessageArgs(), Locale.TAIWAN);

    assertThat(message).doesNotContain("{0}", "{1}");     // ★ 參數都被替換了
    assertThat(message).isNotBlank();
}
```

| 性質 | 抓到的 bug |
|---|---|
| ① 訊息可解析、參數都被替換 | 🔴 04 章抓到「`SHIPPED` 沒有被中文化」 |
| ② `errorCode` 有被定義 | 🔴 04 章抓到 `ORDER_INVOICE_ALREADY_ISSUED` **從來沒被定義過** |
| ③ `userMessageArgs` 沒有預先格式化 | 🔴 04 章抓到四個例外自己呼叫 `toPlainString()` |
| ④ 4xx 的 `Problem` 不含敏感欄位 | 04 章 4.5.5 |
| ⑤ `SideEffectsCommitted` 的都有 `committedSideEffects()` | 04 章 4.3.4 |

> 📌 **這個模式的名字是「性質測試」（property-based）的一種簡化版**：
> **不是「測 41 個個案」，是「測 5 個對 41 個都該成立的性質」。**
>
> ✅ **而它的維護成本是【常數】**：新增第 42 個例外時，
> 加一行 fixture，5 條性質自動套用。

### 7.7.2 業務例外的斷言：斷言什麼

```java
// 🔴 太弱：任何 RuntimeException 都會通過
assertThatThrownBy(() -> order.cancel(actor, reason, note, now))
        .isInstanceOf(RuntimeException.class);

// ⚠️ 還是不夠：型別對了，但 code 可能對映錯
assertThatThrownBy(() -> order.cancel(actor, reason, note, now))
        .isInstanceOf(OrderNotCancellableException.class);

// ✅ shop-service 的標準寫法
assertThatThrownBy(() -> order.cancel(actor, reason, note, now))
        .isInstanceOfSatisfying(OrderNotCancellableException.class, e -> {
            assertThat(e.errorCode()).isEqualTo(ErrorCode.ORDER_NOT_CANCELLABLE);
            assertThat(e.extensions()).containsEntry("currentStatus", "SHIPPED");
            // ★★ 04 章 4.9.1：這個例外「盲目重試」是不安全的
            assertThat(e.errorCode().safeToRetryBlindly()).isFalse();
        });
```

⚠️ **最後一條斷言值得說明**：它守的不是「這個例外」，
是**「這個例外 → 這個 code → 這個重試語意」這條鏈**。
04 章事故 1（500 讓客戶重複下單七次）就是這條鏈斷掉造成的。

### 7.7.3 例外的**訊息**不該被斷言

```java
// 🔴 不要
assertThatThrownBy(...).hasMessage("訂單 O-1 目前的狀態（已出貨）無法取消");
```

**三個理由**：

| 理由 | 說明 |
|---|---|
| ① | 04 章 4.5.2：**使用者訊息不在例外裡**，它在 `messages.properties` 裡 |
| ② | 改一個字要改 17 個測試 |
| ③ | 🔴 **它把「開發者看的 detail」與「使用者看的 message」搞混了** |

**該斷言的是 `errorCode` 與 `extensions`** —— 因為那兩者是**契約**。

---

## 7.8 五種測試替身 ★★

### 7.8.1 名字要分清楚

| 替身 | 它做什麼 | 例子 |
|---|---|---|
| **Dummy** | 只是為了填參數，**永遠不會被呼叫** | `new OrderService(repo, null, null)` ⚠️ 危險 |
| **Stub** | 回傳寫死的答案 | `given(x.foo()).willReturn(1)` |
| **Spy** | **包住真的物件**，只改幾個方法 | `spy(realList)` |
| **Mock** | Stub + **記錄呼叫**（可以 verify） | `mock(Foo.class)` |
| **Fake** | ✅ **一個真的、簡化的實作** | `InMemoryOrderRepository` |

⚠️ **Mockito 的 `mock()` 同時是 stub 也是 mock**，
所以大部分人只認識這一個 —— 而 **fake 常常是更好的選擇**。

### 7.8.2 Spy 的陷阱

**實測**：

```
[J6] spy 一個空的 ArrayList，然後 when(spy.get(0)).thenReturn("x")：
[J6]   🔴 IndexOutOfBoundsException —— when() 會【真的呼叫】spy.get(0)
[J6] 正確寫法 doReturn("x").when(spy).get(0)：
[J6]   ✅ spy.get(0) = x
```

> 🔴 **`when(spy.foo())` 會【真的執行】 `spy.foo()`。**
> 對 mock 沒問題（方法是空的），**對 spy 是災難**。
>
> ✅ **對 spy 一律用 `doReturn(...).when(spy).foo()`**。

⚠️ **而 spy 還有一個更隱蔽的問題**：

```java
@Spy OrderApplicationService service;      // 🔴 幾乎永遠是錯的
doReturn(x).when(service).計算金額(any());
```

**「spy 自己的 Service 然後 stub 掉它的一部分」** —— 這代表：

> 🔴 **這個類別做了太多事，而你想測其中一半。**
> **正確的做法是把另一半抽出去**（01 章 1.2 的「14 個依賴怎麼分析」）。

### 7.8.3 什麼時候 Mock 比 Fake 好

| 用 Mock | 用 Fake |
|---|---|
| ✅ 外部系統（金流、ERP、郵件） | ✅ **Repository** |
| ✅ 「要驗證有沒有被呼叫」 | ✅ 「要驗證資料的狀態」 |
| ✅ 要模擬特定的失敗 | ✅ 一個測試裡要**連續操作多次** |
| ✅ 用一次就好的東西 | ✅ **20 個測試都要用** |

### 7.8.4 shop-service 的 `InMemoryOrderRepository` ★★

**為什麼 `OrderRepository` 值得一個 fake**：

```java
// 🔴 用 mock：一個「建立後查詢」的測試長這樣
given(repository.findById("O-1")).willReturn(Optional.empty());
service.create(command, actor);
given(repository.findById("O-1")).willReturn(Optional.of(theOrder));   // ⚠️ 手動接線
OrderResultView view = queryService.detail("O-1");
```

⚠️ **那行「手動接線」就是 7.2.1 說的「我以為它們會怎麼互動」** ——
而它有一個具體的風險：**如果 `create` 存的 id 與我 stub 的 id 不同，測試仍然會過。**

```java
// ✅ 用 fake
public class InMemoryOrderRepository implements OrderRepository {

    private final Map<String, Order> store = new ConcurrentHashMap<>();

    @Override public void save(Order order)            { store.put(order.id(), order); }
    @Override public Optional<Order> findById(String id) { return Optional.ofNullable(store.get(id)); }

    /**
     * ★★ 一個「刻意不完整」的實作，而<b>不完整的地方要拋例外而不是回空</b>。
     *
     * <p>⚠️ 這是 fake 最重要的設計原則：
     * <b>沒實作的功能要大聲失敗</b>，否則測試會靜默地測到錯的東西。
     */
    @Override
    public Page<OrderSummary> search(OrderSearchCriteria criteria, Pageable pageable) {
        throw new UnsupportedOperationException(
                "InMemoryOrderRepository 不支援 search()：它的排序與分頁語意與 SQL 不同，"
              + "測 search() 請用 Repository 整合測試（07 章 7.11.3）");
    }
}
```

⚠️⚠️ **fake 的最大風險是「它與真的實作行為不同」**，
而上面那個 `UnsupportedOperationException` 是第一道防線。**第二道是契約測試**：

```java
/**
 * ★★ 契約測試：同一組測試，跑在【fake】與【真的實作】上。
 *
 * <p>它保證 fake 沒有偷偷變成一個「與現實不同的世界」。
 */
abstract class OrderRepositoryContractTest {

    abstract OrderRepository repository();

    @Test
    void 存了之後查得到() { … }

    @Test
    void 查不存在的id回empty() { … }

    /** ★ 這一條是 03 章 3.5.3 那個「淺拷貝」問題的守門人 */
    @Test
    void 查出來的訂單修改之後不影響已存的() { … }
}

class InMemoryOrderRepositoryTest extends OrderRepositoryContractTest {
    @Override OrderRepository repository() { return new InMemoryOrderRepository(); }
}

@DataJpaTest
class JdbcOrderRepositoryTest extends OrderRepositoryContractTest {
    @Override OrderRepository repository() { return realRepository; }
}
```

> 📌 **這一組是這一章最划算的投資之一**：
> 寫一次契約，**兩個實作一起被守著**。
> ⚠️ 而它抓到的第一個 bug 通常是「**fake 回傳的是同一個物件參照**」
> —— 真的 Repository 每次查都給新物件，fake 給的是 Map 裡那一個。
> **那個差異會讓一整類 bug 在單元測試裡消失。**

### 7.8.5 一個完整的前後對照：把 mock 換成 fake

**情境**：測「同一張訂單不可以套用兩張券」（00 章 0.12 的 `COUPON_ALREADY_APPLIED`）。

**用 mock**：

```java
@Test
void 同一張訂單不可套用兩張券() {
    // ⚠️ 六行「準備」，而其中四行是在【手動維護一個假的世界】
    given(couponRepository.findByCode("SAVE100")).willReturn(Optional.of(coupon100()));
    given(couponRepository.findByCode("SAVE200")).willReturn(Optional.of(coupon200()));
    given(orderRepository.findById("O-1")).willReturn(Optional.of(anOrder().paid().build()));
    given(couponUsageRepository.countUsage("SAVE100", "C-1")).willReturn(0);
    given(couponUsageRepository.countUsage("SAVE200", "C-1")).willReturn(0);

    service.applyCoupon("O-1", "SAVE100", actor);

    // 🔴 這一行是問題所在：第一次套用之後，orderRepository 的狀態【沒有改變】
    //    因為 mock 只會回傳我 stub 的那個 order
    assertThatThrownBy(() -> service.applyCoupon("O-1", "SAVE200", actor))
            .isInstanceOf(CouponAlreadyAppliedException.class);
}
```

⚠️⚠️ **這個測試會不會通過，取決於 `anOrder().paid().build()` 回傳的是不是同一個物件實例。**

- 如果是**同一個實例** → 第一次 `applyCoupon` 改了它 → 第二次看得到 → ✅ 通過
- 如果 `willReturn` 每次都建新的 → 🔴 **第二次看不到第一張券 → 測試失敗**

> 🔴 **「測試會不會過，取決於 mock 回傳的是不是同一個物件」——
> 這是一個【與業務規則完全無關】的因素。**
>
> ⚠️ **而更糟的是它的方向**：`willReturn(x)` **每次回傳同一個 `x`**，
> 所以測試**會通過** —— 而真的 Repository **每次查都給新物件**。
> **於是這個測試通過，而生產環境可能是壞的。**

**用 fake**：

```java
@Test
void 同一張訂單不可套用兩張券() {
    // ★ 三行，而且是在「建立世界的初始狀態」而不是「預測互動」
    coupons.save(coupon100());
    coupons.save(coupon200());
    orders.save(anOrder().paid().build());

    service.applyCoupon("O-1", "SAVE100", actor);

    assertThatThrownBy(() -> service.applyCoupon("O-1", "SAVE200", actor))
            .isInstanceOfSatisfying(CouponAlreadyAppliedException.class,
                    e -> assertThat(e.errorCode()).isEqualTo(ErrorCode.COUPON_ALREADY_APPLIED));

    // ★★ 還可以斷言【狀態】而不只是【例外】
    assertThat(orders.findById("O-1").orElseThrow().appliedCoupon().code()).isEqualTo("SAVE100");
    assertThat(couponUsages.countUsage("SAVE200", "C-1")).isZero();   // ★ 沒有被記成用過
}
```

**兩者的差別，整理成表**：

| | mock | fake |
|---|---|---|
| 準備的行數 | 6（且會隨測試變多而增加） | 3 |
| 準備的**性質** | 🔴 「預測每一次互動」 | ✅ 「建立初始狀態」 |
| 第二次呼叫看得到第一次的效果嗎 | ⚠️ **取決於 mock 怎麼寫** | ✅ **當然** |
| 可以斷言「最後的狀態」嗎 | 🔴 只能 `verify` 有沒有被呼叫 | ✅ 可以 |
| 加一個查詢方法時 | 🔴 每個測試都要多一行 stub | ✅ 不用改 |
| 它與真實作行為一致嗎 | 🔴 **沒有任何保證** | ✅ **契約測試保證**（7.8.4） |

> 📌 **一個經驗法則**：
> **當一個測試的「準備」超過 5 行 stub 時，就該考慮 fake 了。**
>
> ⚠️ **而 fake 的成本是真的**：`InMemoryOrderRepository` 大約 80 行，
> 加上契約測試大約 60 行。
> **它在第 3 個測試就回本，在第 20 個測試變成不可或缺。**

---

## 7.9 不要 mock 的四種東西

### 7.9.1 ① 值物件

```java
// 🔴 不要
Money total = mock(Money.class);
given(total.isGreaterThanOrEqual(any())).willReturn(true);

// ✅
Money total = Money.twd("1180");
```

⚠️ **Mockito 5 用 `InlineByteBuddyMockMaker`，它【可以】mock final 類別與 record。實測**：

```
[J5] mock maker = org.mockito.internal.creation.bytebuddy.InlineByteBuddyMockMaker
[J5] mock 一個 record（Money）→ ✅ 成功
```

> 🔴 **「可以」不等於「應該」。**
> mock 一個 `Money` 會得到一個**沒有 `Money` 語意**的東西 ——
> 它的 `plus()` 回 `null`，它的 `equals()` 不看金額。
>
> **而 `Money.twd("1180")` 建立起來只要幾奈秒。**

### 7.9.2 ② 你不擁有的型別

```java
// 🔴 不要 mock RestClient / JdbcTemplate / ObjectMapper
RestClient client = mock(RestClient.class);
given(client.get()).willReturn(mock(RestClient.RequestHeadersUriSpec.class));
// ⚠️ 為了 stub 一個呼叫鏈，要 mock 五層 —— 而它們的介面隨時會變
```

**兩個問題**：

| 問題 | 說明 |
|---|---|
| ① | **你在斷言一個你不理解的契約** —— 「`RestClient` 會呼叫 `.get()` 再 `.uri()`」是實作細節 |
| ② | 🔴 **升級版本時測試綠燈，生產環境炸掉** |

**正確做法**：mock **你自己的埠**（01 章 1.7）。

```java
// ✅ 測 application 層 → mock 我們的 PaymentGateway
@Mock PaymentGateway paymentGateway;

// ✅ 測 TapPayGateway（轉接器）→ 用 MockRestServiceServer 或真的 socket（06 章 6.11.4）
```

> 📌 **埠存在的一個重要理由就是這個**：
> **它是「可以合理 mock」與「不該 mock」之間的那條線。**

### 7.9.3 ③ `Clock`、`IdGenerator` 這類「可以給真的假貨」的東西

```java
// ⚠️ 可以，但沒必要
@Mock Clock clock;
given(clock.instant()).willReturn(fixedNow);

// ✅ 更好：JDK 內建的
Clock clock = Clock.fixed(Instant.parse("2026-08-28T10:00:00Z"), ZoneOffset.UTC);
```

**差別**：

| | mock | `Clock.fixed` |
|---|---|---|
| 沒 stub 到的方法 | 🔴 回 `null` → NPE | ✅ 正常運作 |
| strict stubs | ⚠️ 沒用到會 `UnnecessaryStubbingException` | ✅ 無關 |
| 讀起來 | 「一個假的 Clock」 | ✅ 「時間固定在 2026-08-28」 |

### 7.9.4 ④ 被測類別自己

**7.8.2 說過：`@Spy` 自己的 Service 是一個設計問題的訊號。**

---

## 7.10 時間、隨機、ID：01 章 1.5 的兌現 ★

### 7.10.1 三種不確定性

**01 章 1.5「把不確定性注入進來」列了三種，這一節是它們在測試裡的樣子。**

| 不確定性 | 直接用的話 | 注入之後 |
|---|---|---|
| `Instant.now()` | 🔴 **測不了「30 分鐘後過期」** | `Clock` |
| `UUID.randomUUID()` | 🔴 斷言不了 id | `IdGenerator` |
| `Math.random()` | 🔴 測不了「10% 的機率」 | `RandomSource` |

### 7.10.2 `Clock` 的三種用法

```java
// ① 固定時間（★ 90% 的情況）
Clock clock = Clock.fixed(Instant.parse("2026-08-28T10:00:00Z"), ZoneOffset.UTC);

// ② 可以往前推 —— 測「30 分鐘後自動取消」
MutableClock clock = new MutableClock(Instant.parse("2026-08-28T10:00:00Z"));
service.create(command, actor);
clock.advance(Duration.ofMinutes(31));            // ★ 時間前進
expirationJob.expireUnpaidOrders();
assertThat(repository.findById(orderId).orElseThrow().status())
        .isEqualTo(OrderStatus.CANCELLED);

// ③ 偏移固定量
Clock clock = Clock.offset(Clock.systemUTC(), Duration.ofDays(-7));
```

```java
/**
 * ★ 一個可以推進的 Clock（JDK 沒有內建）。
 *
 * <p>⚠️ 它是 <b>測試用</b>的，所以放在 test source root。
 * 把它放進 main 會讓人在生產程式碼裡用到它。
 */
public class MutableClock extends Clock {
    private Instant instant;
    private final ZoneId zone;

    @Override public Instant instant() { return instant; }
    @Override public ZoneId getZone()  { return zone; }
    @Override public Clock withZone(ZoneId z) { return new MutableClock(instant, z); }

    public void advance(Duration duration) { this.instant = instant.plus(duration); }
    public void setTo(Instant t)           { this.instant = t; }
}
```

⚠️ **一個容易踩的坑：時區。**

```java
// 🔴 這個測試在 CI（UTC）綠燈，在開發機（Asia/Taipei）紅燈
Clock clock = Clock.fixed(Instant.parse("2026-08-28T16:30:00Z"), ZoneId.systemDefault());
assertThat(report.dateLabel()).isEqualTo("2026-08-28");     // 台北是 08-29 00:30
```

> 📌 **規則：測試裡的 `Clock` 一律明確指定 zone，永遠不要用 `systemDefault()`。**
> 而「業務上該用哪個時區」是一個**業務決定**（報表的「今天」是誰的今天），
> 它應該是一個**注入的組態**，不是 `systemDefault()`。

### 7.10.3 為什麼 `IdGenerator` 值得存在

**00 章 0.7 判準 1 說「`UUID.randomUUID()` 算 I/O」，很多人覺得那是潔癖。**

**它在測試裡的具體回報**：

```java
// 🔴 沒有 IdGenerator
OrderResultView result = service.create(command, actor);
assertThat(result.orderId()).isNotBlank();          // ⚠️ 只能斷言「不是空的」

// ✅ 有 IdGenerator
given(ids.newOrderId()).willReturn("01J8XYZ");
OrderResultView result = service.create(command, actor);
assertThat(result.orderId()).isEqualTo("01J8XYZ");   // ★ 而且可以驗證它被存進去、被放進事件
```

**更重要的是「同一個 id 在三個地方要一致」這條規則變得可測**：

```java
@Test
void 訂單id在回應事件與稽核紀錄裡是同一個() {
    given(ids.newOrderId()).willReturn("01J8XYZ");

    OrderResultView result = service.create(command, actor);

    var eventCaptor = ArgumentCaptor.forClass(OrderPlacedEvent.class);
    then(events).should().publish(eventCaptor.capture());
    var orderCaptor = ArgumentCaptor.forClass(Order.class);
    then(orderRepository).should().save(orderCaptor.capture());

    assertThat(result.orderId())
            .isEqualTo(eventCaptor.getValue().orderId())
            .isEqualTo(orderCaptor.getValue().id());
}
```

⚠️ **這條規則聽起來理所當然，而它會壞** —— 05 章 5.13 ③ 就記錄過
**`orderId` 是 ULID、`orderNumber` 是遞增序號，兩者不可混用**。

### 7.10.4 `@Async` 與時間：一個 06 章留下的坑

**06 章 6.2.6 實測了 `LocaleContextHolder` 在 `@Async` 執行緒上是 JVM 預設值。**

**`Clock` 沒有這個問題**（它是注入的 bean，不是 ThreadLocal）——
**而那正是「注入」相對於「ThreadLocal」的價值**。

> 📌 **一句話**：
> **注入的東西跨得過執行緒邊界，ThreadLocal 跨不過。**
> 00 章 0.14.5 為 `StatusLabelResolver` 加 `Locale` 參數，做的是同一件事。

### 7.10.5 測「隨機」：抖動與機率

**06 章 6.6.3 的重試退避帶了抖動，而抖動是隨機的 —— 怎麼測？**

```java
/** ★ 01 章 1.5：把不確定性注入進來 */
public interface RandomSource {
    /** [0, 1) */
    double nextDouble();
    int nextInt(int bound);
}
```

**三種測法，測三件不同的事**：

```java
// ① 測「公式對不對」—— 用一個固定的 RandomSource
@Test
void 第三次重試的退避是800毫秒正負50百分比() {
    RandomSource fixed = new FixedRandomSource(0.0);      // ★ 最小值
    var backoff = new ExponentialBackoff(Duration.ofMillis(200), 2.0, 0.5, fixed);

    assertThat(backoff.delayFor(3)).isEqualTo(Duration.ofMillis(400));   // 800 × (1 - 0.5)

    var max = new ExponentialBackoff(Duration.ofMillis(200), 2.0, 0.5, new FixedRandomSource(1.0));
    assertThat(max.delayFor(3)).isEqualTo(Duration.ofMillis(1200));      // 800 × (1 + 0.5)
}
```

```java
// ② 測「範圍對不對」—— 用真的隨機，但斷言的是【區間】
@Test
void 退避永遠落在正負五成的區間內() {
    var backoff = new ExponentialBackoff(Duration.ofMillis(200), 2.0, 0.5, RandomSource.system());

    for (int i = 0; i < 1000; i++) {
        assertThat(backoff.delayFor(3))
                .isBetween(Duration.ofMillis(400), Duration.ofMillis(1200));
    }
}
```

```java
// ③ 測「分布夠散」—— ⚠️ 這一條是統計的，而它【有機率失敗】
@Test
void 一千次退避至少有一百個不同的值() {
    var backoff = new ExponentialBackoff(Duration.ofMillis(200), 2.0, 0.5, RandomSource.system());

    Set<Duration> distinct = IntStream.range(0, 1000)
            .mapToObj(i -> backoff.delayFor(3))
            .collect(Collectors.toSet());

    // ⚠️ 「至少 100 個」是一個【非常寬鬆】的下限 —— 刻意的
    assertThat(distinct).as("抖動必須真的分散（06 章 6.6.3 的雪崩）").hasSizeGreaterThan(100);
}
```

⚠️ **③ 的門檻刻意設得極寬**，理由與 04 章 4.12.1 的「下限斷言」相同：

> 📌 **一個統計性質的測試，門檻要設在「壞掉時一定會違反」而不是「剛好通過」。**
>
> 如果抖動被誤刪（`randomized-wait-factor` 變成 0），
> **1000 次會得到 1 個不同的值** —— 遠遠低於 100。
> 而如果只是分布稍微不均勻，測試不該紅。

> 🔴 **而 `Math.random()` 直接寫在程式碼裡的話，上面三個測試一個都寫不出來。**
> 這就是 00 章 0.7 判準 1 說「`Math.random()` 算 I/O」的具體回報。

---

## 7.11 交易測不到 ★★

### 7.11.1 單元測試對交易一無所知

```java
@Test
void 建立訂單是一個交易() {
    // 🔴 這個測試不可能存在
}
```

**Application 層的單元測試裡，`@Transactional` 完全不生效**
（沒有代理、沒有交易管理器）。**於是這四件事一個都測不到**：

| 測不到 | 出處 |
|---|---|
| ① `@Transactional` 有沒有**生效**（自呼叫、`final`、非 public） | 02 章 2.7 |
| ② **rollback 規則**（checked exception 不 rollback） | 02 章 2.8 |
| ③ **傳播行為**（`REQUIRES_NEW` 有沒有真的開新交易） | 02 章 2.5 |
| ④ **併發**（鎖、隔離等級、寫偏斜） | 02 章 2.9～2.10 |

⚠️ **而 06 章 6.3.5 加上了第五件**：

| ⑤ `AFTER_COMMIT` 裡不加 `REQUIRES_NEW` 的寫入 | 🔴 **它在 H2 上會通過測試**（06 章實測 `[E5]`） |

### 7.11.2 三種「證明交易真的在」的方式

```java
// ★ 方式 A：ArchUnit（02 章 2.13.2）—— 靜態，快，但只能檢查「形狀」
noMethods().that().areAnnotatedWith(Transactional.class)
           .should().beDeclaredInClassesThat().areNotAnnotatedWith(Service.class)
```

```java
// ★★ 方式 B：執行期探針 —— 證明「這一刻真的在交易裡」
@Transactional
public void create(...) {
    assert TransactionSynchronizationManager.isActualTransactionActive();   // ⚠️ 見下
}
```

```java
// ★★★ 方式 C（shop-service 的選擇）：整合測試 + 真的 rollback
@SpringBootTest
class OrderTransactionIntegrationTest {

    @Test
    void 推ERP失敗時訂單與庫存都要rollback() {
        willThrow(new UpstreamUnavailableException("erp", 503, null))
                .given(erpPort).pushOrder(any());

        assertThatThrownBy(() -> service.createAndPush(command, actor))
                .isInstanceOf(UpstreamUnavailableException.class);

        // ★★ 用【另一個交易】去查，證明真的沒寫進去
        assertThat(jdbc.queryForObject("select count(*) from orders", Integer.class)).isZero();
        assertThat(jdbc.queryForObject(
                "select available from stock where product_id='P-1'", Integer.class)).isEqualTo(10);
    }
}
```

⚠️⚠️ **方式 C 有一個必須知道的陷阱**：

```java
@SpringBootTest
@Transactional          // 🔴🔴 千萬不要加在這種測試上
class OrderTransactionIntegrationTest { … }
```

**`@Transactional` 在測試類別上會做三件事**：

| 它做的事 | 後果 |
|---|---|
| 開一個交易包住整個測試方法 | ⚠️ 被測的 `@Transactional` 變成**巢狀**（`REQUIRED` → 加入） |
| 測試結束後**自動 rollback** | ⚠️ 資料不會真的落地 |
| 🔴 **於是「被測方法的 commit」根本沒發生** | 🔴 **`AFTER_COMMIT` 的 listener 一個都不會跑** |

> 🔴 **`@SpringBootTest` + `@Transactional` 是「交易與事件測試」最常見的假綠燈來源**：
> 你在測「訂單成立後會發事件」，而 **listener 從來沒有被執行過**，
> 因為那個交易永遠不會 commit。
>
> ✅ **正確做法**：不要加 `@Transactional`，改用 `@Sql` 或 `@BeforeEach` 手動清資料。
> **測試要慢一點，但它測的是真的東西。**

### 7.11.3 什麼必須用真的資料庫

| 必須 | 理由 |
|---|---|
| **Repository 的 SQL** | fake 測不到欄位打錯、型別不符、`NULL` 的處理 |
| **原子 UPDATE** | 事故 1 |
| `search()` 的排序與分頁 | fake 的排序語意與 SQL 不同（7.8.4 那個 `UnsupportedOperationException`） |
| **唯一鍵衝突** | outbox 的冪等（06 章 6.8.4）靠它 |
| **樂觀鎖 / `@Version`** | 02 章 2.10 |
| **死鎖與鎖順序** | 02 章 2.14.1 ① |

⚠️ **而「真的資料庫」最好是【真的那一種】**：

| 用什麼 | 抓得到 | 抓不到 |
|---|---|---|
| **H2（相容模式）** | ✅ SQL 語法、映射、大部分邏輯 | 🔴 **MySQL 的鎖行為、`sql_mode`、隔離等級細節** |
| **Testcontainers + 真的 MySQL** | ✅ 幾乎全部 | 慢（每次啟動幾秒） |

> 📌 **02 章與 05 章都說過同一句話**：
> **「把行為釘住」的特性測試必須跑在真的資料庫上。**
>
> ⚠️ **而這一站的所有實驗都是在 H2 上跑的**（撰稿的機器沒有 Docker），
> 所以 06 章 `[E5]` 的結論**只對 H2 成立** —— 這件事在 6.16 的缺口清單裡。

---

## 7.12 測併發 ★★

### 7.12.1 事故 1 的測試長什麼樣

```java
/**
 * ★★ 重現超賣。
 *
 * <p>這是 7.2.3 那張表裡「第 ④ 層」的第一個測試，
 * 而它的存在就是為了 00 章 0.3.2 事故 3。
 */
@SpringBootTest
class StockConcurrencyTest {

    @Test
    void 五十個執行緒同時買庫存十件的商品不可以超賣() throws Exception {
        reset("P-1", 10);

        int threads = 50;
        var pool    = Executors.newFixedThreadPool(threads);
        var start   = new CountDownLatch(1);          // ★ 讓 50 條同時起跑
        var done    = new CountDownLatch(threads);
        var success = new AtomicInteger();

        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                try {
                    start.await();                     // ★★ 這一行是關鍵
                    stockService.deduct("P-1", 1);
                    success.incrementAndGet();
                } catch (Exception ignored) {
                } finally { done.countDown(); }
            });
        }
        start.countDown();
        assertThat(done.await(30, SECONDS)).isTrue();
        pool.shutdownNow();

        assertThat(success.get()).as("成功扣減的次數").isEqualTo(10);
        assertThat(availableOf("P-1")).as("剩餘庫存").isZero();
    }
}
```

⚠️ **`CountDownLatch start` 是這個測試能不能抓到 bug 的關鍵**：
沒有它的話，50 個任務會**依序**被提交、依序執行 —— **競態根本不會發生**。

### 7.12.2 實測：它真的抓得到嗎

**用「天真的實作」（`SELECT` → `if` → `UPDATE`）跑 5 輪**：

```
[L1] 庫存 10，50 個執行緒各買 1 件，重複跑 5 輪：
[L1]   第 1 輪：成功 11 次，拒絕 39 次，剩餘庫存 -1  🔴 超賣！
[L1]   第 2 輪：成功 12 次，拒絕 38 次，剩餘庫存 -2  🔴 超賣！
[L1]   第 3 輪：成功 13 次，拒絕 37 次，剩餘庫存 -3  🔴 超賣！
[L1]   第 4 輪：成功 14 次，拒絕 36 次，剩餘庫存 -4  🔴 超賣！
[L1]   第 5 輪：成功 14 次，拒絕 36 次，剩餘庫存 -4  🔴 超賣！
[L1] 👉 5 輪裡有 5 輪重現了超賣
```

**換成原子 UPDATE**（02 章 2.10）：

```
[L2] 同樣條件，改用原子 UPDATE，重複跑 5 輪：
[L2]   第 1 輪：成功 10 次，拒絕 40 次，剩餘庫存 0  ✅
[L2]   第 2 輪：成功 10 次，拒絕 40 次，剩餘庫存 0  ✅
[L2]   第 3 輪：成功 10 次，拒絕 40 次，剩餘庫存 0  ✅
[L2]   第 4 輪：成功 10 次，拒絕 40 次，剩餘庫存 0  ✅
[L2]   第 5 輪：成功 10 次，拒絕 40 次，剩餘庫存 0  ✅
```

⚠️ **注意「剩餘庫存 -4」這個數字**：
它代表**`available` 欄位變成負數** —— 而 00 章的不變量清單裡
`I3: 庫存不可為負` 是有的，**只是沒有資料庫約束在守**。

> 📌 **一個順帶的結論**：
> 加一條 `CHECK (available >= 0)`（或 `UNSIGNED`）的資料庫約束，
> 會讓這個 bug 從「靜默的超賣」變成「一個很吵的 SQL 例外」——
> **而 00 章 0.8 那張「不變量守在哪一層」的表，第四層就是它。**

### 7.12.3 一個意外：只要 2 個執行緒就夠了

**大部分人以為併發測試需要幾十條執行緒。實測**：

```
[L3] 天真的實作，只用 2 個執行緒，庫存 1，跑 10 輪：
[L3] 10 輪裡有 10 輪重現超賣
[L3] 👉 在 H2 上，2 個執行緒就足以【穩定】重現 ——
[L3]    因為 SELECT 與 UPDATE 之間的窗口比執行緒切換的粒度大得多。
```

> 📌 **這是好消息**：
> **一個 2 執行緒的併發測試，跑起來只要幾十毫秒，而它抓得到同樣的 bug。**
>
> ⚠️ 但**不要把 50 執行緒那個刪掉** —— 兩者測的東西不同：
>
> | 測試 | 抓什麼 |
> |---|---|
> | 2 執行緒 | ✅ **「有沒有競態」**（快、穩定，適合放進每次 CI） |
> | 50 執行緒 | ✅ **「壓力下的正確性」**（連線池、鎖等待、死鎖） |

### 7.12.4 併發測試的四個誠實的限制

| 限制 | 說明 |
|---|---|
| ① 🔴 **它證明不了「沒有 bug」** | 綠燈只代表「這一次沒重現」 |
| ② ⚠️ **它與資料庫強相關** | 上面的數字是 **H2** 的。MySQL InnoDB 的 `REPEATABLE READ` + 間隙鎖的行為**不同**（02 章 2.6） |
| ③ ⚠️ **它與機器強相關** | 單核心的 CI runner 上，競態窗口會變窄 |
| ④ ⚠️ **它慢** | 50 執行緒 × 5 輪 ≈ 幾秒，而它會被排到 `@Tag("slow")` 裡然後被跳過 |

**shop-service 的處置**：

```java
@Tag("concurrency")
class StockConcurrencyTest { … }
```

```xml
<!-- ★ 一般的 CI 跑全部；PR 的快速回饋只跑非 concurrency 的 -->
<configuration>
  <excludedGroups>${excluded.test.groups}</excludedGroups>
</configuration>
```

> 🔴 **而「跳過」必須是一個【明確的、有期限的】決定**：
> `mvn test -Dexcluded.test.groups=concurrency` 只用在**本機開發**，
> **CI 的 main branch 一律跑全部**。
>
> ⚠️ 如果一個團隊發現「併發測試偶爾紅，所以我們把它關掉了」——
> **那個偶爾紅就是它在做它的工作。**

### 7.12.5 測樂觀鎖與死鎖

```java
/** ★ 樂觀鎖（02 章 2.10、2.14.1 ④） */
@Test
void 兩個人同時改同一張訂單第二個會拿到版本衝突() throws Exception {
    String orderId = givenAnOrder();

    var barrier = new CyclicBarrier(2);
    var results = Collections.synchronizedList(new ArrayList<String>());

    Runnable edit = () -> {
        try {
            Order order = repository.findById(orderId).orElseThrow();   // ★ 兩邊都讀到 version=0
            barrier.await();                                            // ★★ 對齊
            order.changeAddress(anAddress(), actor, now);
            repository.save(order);
            results.add("OK");
        } catch (OptimisticLockConflictException e) {
            results.add("CONFLICT");
        } catch (Exception e) {
            results.add("ERROR:" + e.getClass().getSimpleName());
        }
    };

    var t1 = new Thread(edit); var t2 = new Thread(edit);
    t1.start(); t2.start(); t1.join(10_000); t2.join(10_000);

    assertThat(results).containsExactlyInAnyOrder("OK", "CONFLICT");
}
```

⚠️ **`CyclicBarrier` 比 `CountDownLatch` 更適合這裡**：
它讓兩條執行緒**在同一個點會合**，於是「兩邊都已經讀到 version=0」是**確定的**，
而不是碰運氣。

> 📌 **判準**：
> **`CountDownLatch` 用來「一起起跑」，`CyclicBarrier` 用來「在中間對齊」。**
> 測**寫偏斜**（02 章 2.10）時，一定要用後者。

**死鎖**（02 章 2.14.1 ①，「兩張訂單含相同商品但順序不同」）：

```java
@Test
void 兩張訂單含相同商品但順序不同時不可以死鎖() throws Exception {
    // ⚠️ 這個測試在【修好之前】會 timeout 或拋 DeadlockLoserDataAccessException
    //    修好之後（依 productId 排序）它會穩定通過
    …
}
```

⚠️ **死鎖測試在 H2 上與 MySQL 上的行為差很多** ——
**這一條是本站少數「必須用 Testcontainers + MySQL」的測試**（7.11.3）。

---

## 7.13 測非同步：修正 06 章 6.11.3 的一個建議

### 7.13.1 06 章說了什麼

**06 章 6.11.3 建議在測試裡用 `SyncTaskExecutor` 把 `@Async` 變成同步**，
並在 javadoc 裡誠實地列了它測不到的三件事，其中第三件是：

> 🔴 **交易的可見性**（6.3.3）—— 同步執行時「看得到未提交的資料」

**這一章要說的是：那個建議的【預設值】是錯的。**

### 7.13.2 三層，而不是一個開關

| 層 | 用什麼 | 測什麼 |
|---|---|---|
| **① listener 的內容** | ✅ **直接呼叫方法**（連 `@Async` 都不用管） | 「收到這個事件會做什麼」 |
| **② 事件有沒有被發出** | mock `DomainEventPublisher` + `ArgumentCaptor` | 「該發的事件發了，內容對」 |
| **③ 接線** | 🔴 **真的執行緒池 + Awaitility** | 「事件真的會走到 listener」 |

```java
// ★ ① 最多數的情況 —— 一個普通的單元測試
@Test
void 收到訂單成立事件時會寄確認信() {
    var listener = new OrderNotificationListener(emailSender);

    listener.onOrderPlaced(anOrderPlacedEvent());      // ★ 直接呼叫，不經過 Spring

    then(emailSender).should().send(any(OrderConfirmationMail.class));
}
```

> 📌 **① 這一層完全不需要 `SyncTaskExecutor`，因為它根本不經過代理。**
> **而它涵蓋了 listener 測試裡 90% 的內容。**

```java
// ★★ ③ 只有少數幾個「接線測試」需要真的非同步
@SpringBootTest                            // ⚠️ 注意：沒有 @Transactional（7.11.2）
class OrderEventWiringTest {

    @Test
    void 訂單成立會走到通知listener且只走一次() {
        service.create(command, actor);

        await().atMost(5, SECONDS)
               .untilAsserted(() -> then(emailSender).should().send(any()));

        // ★★ 06 章 6.11.2 陷阱 ③：再等一下，確認沒有第二次
        //    ⚠️ 這個 sleep 不能被 Awaitility 取代（「證明沒發生」需要固定的時間）
        sleepQuietly(300);
        then(emailSender).should(times(1)).send(any());
    }
}
```

### 7.13.3 `SyncTaskExecutor` 該用在哪

**只有一個地方：那些「與交易無關」的非同步任務。**

```java
/**
 * ⚠️ 只給【不碰資料庫】的 listener 用。
 *
 * <p>🔴 給碰資料庫的 listener 用會讓 06 章 6.3.3 的 bug
 * （非同步執行緒看不到未提交的資料）變成綠燈。
 *
 * <p>👉 而那個 bug 唯一的守門人是 06 章 6.11.5 的 ArchUnit 規則 2。
 */
@TestConfiguration
public class SyncCacheEvictExecutorConfig {
    @Bean("cacheEvictExecutor") @Primary
    public TaskExecutor cacheEvictExecutor() { return new SyncTaskExecutor(); }
}
```

⚠️ **注意它只覆蓋 `cacheEvictExecutor` 一個 bean，而不是全部。**
**06 章 6.2.9「不共用池子」的決定，在這裡有了第二個回報**：
**池子分開 → 測試也可以分開替換。**

### 7.13.4 一個容易漏的細節：mock 的 `CompletableFuture`

**實測**（Mockito 5.7.0 未 stub 的方法）：

```
[K1] Optional = Optional.empty
[K1] List     = []
[K1] Map      = {}
[K1] Completa = null            ← 🔴
```

🔴 **`CompletableFuture` 的預設回傳是 `null`，不是一個已完成的 future。**

```java
// 🔴 NPE
given(erpPushService.pushAsync(any()));           // 忘記 willReturn
erpPushService.pushAsync(snapshot).thenApply(…);  // → NullPointerException

// ✅
given(erpPushService.pushAsync(any())).willReturn(CompletableFuture.completedFuture(null));
```

> 📌 **這與 06 章 6.2.7 的 `[D3]` 是同一個主題的兩面**：
> **`CompletableFuture` 在生產程式碼裡會吞掉例外，
> 在測試裡會變成 `null`。**
> **兩者都是「它看起來比 `void` 高級，實際上比較容易出錯」。**

---

## 7.14 測試資料的建構

### 7.14.1 問題：一個 `Order` 需要 14 個欄位

```java
// 🔴 每個測試都這樣寫
Order order = new Order("O-1", new OrderNumber("SO-20260828-0001"), "C-1",
        List.of(new OrderLine("P-1", "耳機", 2, Money.twd("590"))),
        Money.twd("1180"), Currency.getInstance("TWD"), OrderStatus.PAID,
        null, null, List.of(), List.of(), 0, now, now.plus(Duration.ofMinutes(30)));
```

**三個問題**：

| 問題 | 說明 |
|---|---|
| ① | **看不出這個測試在乎哪個欄位** —— 14 個裡只有 `status` 重要 |
| ② | 加一個欄位 → **改 150 個地方** |
| ③ | 🔴 **它會被複製貼上**，於是一個「不合法」的 `Order`（違反不變量）會混進測試 |

### 7.14.2 Test Data Builder（★ shop-service 的選擇）

```java
/**
 * ★★ 訂單的測試資料建構器。
 *
 * <p>三個設計決定：
 * <ol>
 *   <li><b>每個欄位都有合理的預設值</b> —— 測試只需要說出它在乎的那一個。</li>
 *   <li><b>{@code build()} 走真的建構路徑</b> —— 於是不變量會被檢查，
 *       建不出一個「不合法的訂單」（00 章 0.9.2）。</li>
 *   <li>🔴 <b>不提供「跳過驗證」的後門</b> —— 需要一個不合法的訂單來測某個東西時，
 *       那本身是一個訊號：<b>那個狀態不該存在</b>。</li>
 * </ol>
 */
public class OrderTestBuilder {

    private String id = "O-1";
    private OrderStatus status = OrderStatus.PENDING_PAYMENT;
    private List<OrderLine> lines = List.of(aLine("P-1", 2, "590"));
    private Instant createdAt = FIXED_NOW;
    // … 其餘 10 個欄位都有預設值

    public static OrderTestBuilder anOrder()  { return new OrderTestBuilder(); }

    // ★ 語意化的捷徑 —— 讀起來像業務語言
    public OrderTestBuilder paid()      { return status(OrderStatus.PAID); }
    public OrderTestBuilder shipped()   { return status(OrderStatus.SHIPPED).withShipment(); }
    public OrderTestBuilder expired()   { return createdAt(FIXED_NOW.minus(Duration.ofHours(1))); }

    public Order build() {
        // ★★ 走真的路徑：透過狀態機轉移，而不是直接塞 status
        Order order = Order.create(id, orderNumber, customerId, lines, …, createdAt);
        for (OrderStatus next : pathTo(status)) {
            order.transitionTo(next, Actor.SYSTEM, createdAt);
        }
        return order;
    }
}
```

**於是測試變成**：

```java
@Test
void 已出貨的訂單不可取消() {
    Order order = anOrder().shipped().build();      // ★ 只說重要的那一件事

    assertThatThrownBy(() -> order.cancel(customer, reason, null, now))
            .isInstanceOf(OrderNotCancellableException.class);
}
```

⚠️ **決定 ② 值得展開**：

**`build()` 走真的建構路徑，代價是「建一個 `SHIPPED` 的訂單要跑四次狀態轉移」。**
**而收益是**：

> 🔴 **00 章 0.9.2 的複查抓到過一個 bug**：
> 「第二次部分出貨會 500」——
> 因為 `PARTIALLY_SHIPPED → PARTIALLY_SHIPPED` 不在狀態機裡。
>
> **如果測試資料是「直接塞 `status = PARTIALLY_SHIPPED`」建出來的，
> 那個 bug 永遠不會被測試碰到。**

### 7.14.3 Object Mother 與 Builder 的分工

| | Object Mother | Test Data Builder |
|---|---|---|
| 形狀 | `OrderMother.aPaidOrder()` | `anOrder().paid().build()` |
| 適合 | ✅ 少數幾個**很常用**的完整情境 | ✅ 需要**微調一兩個欄位**時 |
| 問題 | 🔴 情境一多就變成 `aPaidOrderWithCouponAndTwoLines()` | 稍微囉唆 |

**shop-service 兩個都用**：Builder 是基礎，Mother 是幾個常用組合的捷徑。

```java
public final class Orders {
    public static Order aPaidOrder()      { return anOrder().paid().build(); }
    public static Order anExpiredOrder()  { return anOrder().expired().build(); }
}
```

⚠️ **上限：Mother 的方法不超過 8 個。** 超過就代表該用 Builder 了。

### 7.14.4 隨機測試資料的誘惑

**看起來很聰明的做法**：

```java
// 🔴 用 Faker / 隨機值產生測試資料
Order order = anOrder()
        .id(UUID.randomUUID().toString())
        .customerId(faker.name().username())
        .lines(randomLines(faker.number().numberBetween(1, 10)))
        .build();
```

**它的賣點是「每次跑都測到不同的組合」。而它有三個問題**：

| 問題 | 說明 |
|---|---|
| ① 🔴 **失敗無法重現** | 「昨天 CI 紅了一次，今天綠了」—— 而那個 bug 還在 |
| ② 🔴 **看不出測試在乎什麼** | 「1 到 10 個明細」—— 為什麼是 10？邊界在哪？ |
| ③ ⚠️ **它其實測不到更多** | 隨機 100 次不如**刻意挑 5 個邊界值** |

⚠️ **而 ③ 是最違反直覺的一點。**

**「一個明細」「最大明細數」「超過上限」「零個」「重複的商品」** ——
這五個值涵蓋的東西，比隨機 1～10 多得多，
**而且每一個都是一個【被命名的】情境**。

> 📌 **判準**：
> **測試資料應該是【刻意挑選】的，不是【隨機產生】的。**
> **而「刻意挑選」的另一個名字叫「等價類別 + 邊界值」。**

⚠️ **一個例外：property-based testing（性質測試）。**

```java
/**
 * ★ jqwik 之類的工具做的是【不同的事】：
 * 它產生隨機輸入，<b>但失敗時會自動「縮小」到最小的反例，並記住種子</b>。
 *
 * <p>👉 於是它沒有問題 ①。
 */
@Property
void 任何兩個相同幣別的Money相加後幣別不變(
        @ForAll("twdAmounts") Money a, @ForAll("twdAmounts") Money b) {
    assertThat(a.plus(b).currency()).isEqualTo(a.currency());
}
```

| | 隨機測試資料 | Property-based |
|---|---|---|
| 失敗可重現 | 🔴 不行 | ✅ **記住種子 + 自動縮小反例** |
| 斷言的是 | 具體的值 | ✅ **一個對所有輸入都成立的性質** |
| 適合 | ❌ 幾乎不適合 | ✅ **值物件、編解碼、序列化往返** |

**shop-service 用它的地方只有兩個**：

| 用在 | 性質 |
|---|---|
| `Money` 的四則運算 | 交換律、結合律、`a - a == zero` |
| **序列化往返** | `deserialize(serialize(x)).equals(x)` —— ★ 05 章 5.13 ② 與 06 章 6.9.2 的 `Money` 問題 |

> 📌 **第二個特別值得做**：
> **`Money` 的 Jackson 往返問題被發現了【兩次】**（快取一次、outbox 一次）。
> **一條 property-based 的往返測試，會在第一次就抓到它，而且對所有值物件都適用。**

---

## 7.15 參數化測試

### 7.15.1 三種來源

```java
// ① @ValueSource：一維
@ParameterizedTest
@ValueSource(ints = {0, -1, -100})
void 數量不可為零或負(int quantity) {
    assertThatThrownBy(() -> new OrderLine("P-1", "耳機", quantity, Money.twd("590")))
            .isInstanceOf(IllegalArgumentException.class);
}

// ② @CsvSource：多維，且看得出「輸入 → 期望」
@ParameterizedTest
@CsvSource({
        "PENDING_PAYMENT, true",
        "PAID,            true",
        "PARTIALLY_SHIPPED, true",
        "SHIPPED,         false",
        "DELIVERED,       false",
        "CANCELLED,       false",
        "REFUNDED,        false",
})
void 哪些狀態可以取消(OrderStatus status, boolean cancellable) {
    assertThat(status.isCancellable()).isEqualTo(cancellable);
}

// ③ @MethodSource：需要複雜物件時
@ParameterizedTest
@MethodSource("example.shop.common.error.ExceptionFixtures#all")
void 每個業務例外都有可解析的使用者訊息(BusinessException ex) { … }
```

⚠️ **② 那個例子有一個重要的性質：它是【窮舉】的。**

**而「窮舉」可以被守**：

```java
/**
 * ★★ 上面的 @CsvSource 列了 7 個狀態，而 OrderStatus 有 8 個（含 UNKNOWN）。
 *
 * <p>這一條測試保證「新增一個狀態時，上面那張表會紅燈」。
 */
@Test
void 取消規則的表涵蓋了所有狀態() {
    Set<OrderStatus> covered = CANCELLABLE_TABLE.keySet();
    assertThat(covered)
            .as("新增 OrderStatus 時必須同時更新取消規則的表")
            .containsExactlyInAnyOrder(OrderStatus.values());
}
```

> 📌 **這是這一站反覆出現的手法的第 N 次應用**：
> **把「有一張表要跟著改」從「希望有人記得」變成「CI 紅燈」。**
> 03 章 3.10.3 ②（每個 enum 欄位都要有 label 欄位）、
> 04 章 4.2.4（`ErrorCode` 分區）、06 章 6.11.5 都是同一件事。

### 7.15.2 `@EnumSource`：最省事的窮舉

```java
@ParameterizedTest
@EnumSource(value = OrderStatus.class, names = {"SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"})
void 這些狀態不可取消(OrderStatus status) {
    assertThatThrownBy(() -> anOrder().status(status).build()
                                      .cancel(customer, reason, null, now))
            .isInstanceOfSatisfying(OrderNotCancellableException.class,
                    e -> assertThat(e.errorCode()).isEqualTo(ErrorCode.ORDER_NOT_CANCELLABLE));
}

// ★★ 更好：用 mode = EXCLUDE，於是新增狀態時【自動】被納入
@ParameterizedTest
@EnumSource(value = OrderStatus.class, mode = EXCLUDE,
            names = {"PENDING_PAYMENT", "PAID", "PARTIALLY_SHIPPED", "UNKNOWN"})
void 除了這四個以外的狀態都不可取消(OrderStatus status) { … }
```

> 📌 **`EXCLUDE` 比 `INCLUDE` 好的理由，與 04 章的「白名單」是同一個**：
> **新增一個 enum 常數時，`INCLUDE` 會靜默地漏掉它，`EXCLUDE` 會自動涵蓋它。**
>
> ⚠️ 而如果新的狀態**應該**可以取消，那這個測試會紅燈 —— **那正是我們要的**。

### 7.15.3 命名：讓失敗訊息可讀

```java
// 🔴 預設的名字：「[3] SHIPPED, false」
@ParameterizedTest
@CsvSource({...})

// ✅
@ParameterizedTest(name = "[{index}] 狀態 {0} 的可取消性應為 {1}")
@CsvSource({...})
```

⚠️ **在 CI 上，測試的名字就是你唯一能看到的東西。**

---

## 7.16 覆蓋率與突變測試 ★★

### 7.16.1 三個指標，量的是三件不同的事

| 指標 | 問的問題 | 事故 1 抓得到嗎 |
|---|---|---|
| **行覆蓋率** | 這一行**被執行過**嗎？ | ❌ 100% 而 bug 在裡面 |
| **分支覆蓋率** | 這個 `if` 的**兩邊**都走過嗎？ | ❌ 同上 |
| **突變測試** | 把這一行**改壞**，有測試會紅嗎？ | ⚠️ **部分** |

> 📌 **一句話**：
> **覆蓋率量的是「測試執行了什麼」，突變測試量的是「測試斷言了什麼」。**
>
> 而兩者的差距非常大 —— 一個**完全沒有斷言**的測試，
> **行覆蓋率可以是 100%**。

### 7.16.2 一個實測的例子

**受測程式碼**：

```java
public class ShippingFeePolicy {

    public static final int BULK_THRESHOLD = 10;

    public Money feeFor(int itemCount, boolean remoteIsland) {
        if (itemCount >= BULK_THRESHOLD) {       // ★ 注意 >=
            return FREE;
        }
        return remoteIsland ? REMOTE : NORMAL;
    }
}
```

**測試**（三個，看起來很完整）：

```java
@Test void 買滿十件免運()      { assertThat(policy.feeFor(15, false)).isEqualTo(Money.twd("0")); }
@Test void 一般地區運費80()    { assertThat(policy.feeFor(3, false)).isEqualTo(Money.twd("80")); }
@Test void 離島運費150()       { assertThat(policy.feeFor(3, true)).isEqualTo(Money.twd("150")); }
```

**行覆蓋率**：

```
>> Line Coverage (for mutated classes only): 7/7 (100%)
```

✅ **100%。分支覆蓋率也是 100%**（`if` 的兩邊都走過、三元的兩邊都走過）。

**而突變測試**（PIT 1.15.8）：

```
>> Generated 5 mutations Killed 4 (80%)
>> Mutations with no coverage 0. Test strength 80%
```

**存活下來的那一個**：

```
SURVIVED  line=22  changed conditional boundary | ConditionalsBoundaryMutator
KILLED    line=22  negated conditional          | NegateConditionalsMutator
KILLED    line=25  negated conditional          | NegateConditionalsMutator
KILLED    line=23  replaced return value with null
KILLED    line=25  replaced return value with null
```

🔴 **`ConditionalsBoundaryMutator` 把 `>=` 改成 `>` —— 而三個測試都沒有紅燈。**

**為什麼**：三個測試用的 `itemCount` 是 **15、3、3** ——
**沒有一個是 10**。而 `>=` 與 `>` 只在 `itemCount == 10` 時不同。

**補上邊界之後**：

```java
@Test
void 邊界剛好十件免運而九件不免() {
    assertThat(policy.feeFor(10, false)).isEqualTo(Money.twd("0"));
    assertThat(policy.feeFor(9,  false)).isEqualTo(Money.twd("80"));
}
```

```
>> Generated 5 mutations Killed 5 (100%)
>> Mutations with no coverage 0. Test strength 100%
```

> 📌 **這個例子的價值在於它有多平凡**：
> **一個 5 行的方法、三個看起來很完整的測試、100% 的覆蓋率 ——
> 而「滿 10 件免運」與「超過 10 件免運」這個差別完全沒有被測到。**
>
> ⚠️ **而這正是真實世界的 off-by-one bug 的形狀。**

### 7.16.3 PIT 的設定與三個實務問題

```xml
<plugin>
  <groupId>org.pitest</groupId>
  <artifactId>pitest-maven</artifactId>
  <version>1.15.8</version>
  <dependencies>
    <dependency>
      <groupId>org.pitest</groupId>
      <artifactId>pitest-junit5-plugin</artifactId>
      <version>1.2.1</version>
    </dependency>
  </dependencies>
  <configuration>
    <!-- ★★ 只跑 domain 層 —— 見下方問題 ② -->
    <targetClasses><param>example.shop.*.domain.*</param></targetClasses>
    <mutationThreshold>85</mutationThreshold>
  </configuration>
</plugin>
```

| 問題 | 說明與處置 |
|---|---|
| ① 🔴 **它用 `target/test-classes`，不會自己編譯** | ⚠️ **實測踩到過**：改了測試沒跑 `mvn test` 就跑 PIT → 分數還是舊的 80%。**一律 `mvn test && mvn pitest:mutationCoverage`** |
| ② ⚠️ **它很慢** | 每一個突變都要跑一次相關的測試。**只對 `domain` 層跑**（那裡的邏輯密度最高、測試最快） |
| ③ ⚠️ **有些突變殺不掉，而那是對的** | 例如「移除一行 `log.debug`」——**沒有測試應該為 log 紅燈**。用 `<avoidCallsTo>` 排除 |

⚠️ **PIT 對 Spring 專案會提示**：

```
!! The following issues were detected during the run !!
Project uses Spring, but the Arcmutate Spring plugin is not present
```

**它只是提示效能可以更好，不影響結果。**

### 7.16.4 覆蓋率門檻該設多少（以及它為什麼是個爛指標）

| 層 | 行覆蓋率 | 突變分數 |
|---|---|---|
| **domain** | 95% | ✅ **85%** ← ★ 這一個才有意義 |
| application | 85% | 不強制（mock 太多，突變測試意義有限） |
| infrastructure | 60% | 不跑 |

> 🔴 **「覆蓋率門檻」最常見的失敗方式**：
>
> 團隊設了 80% 的門檻 → 有人為了過門檻寫了一堆
> **沒有斷言、只是把方法呼叫一次**的測試 →
> **覆蓋率達標，而測試的價值是負的**（它們仍然要維護）。
>
> 📌 **突變分數擋得住這一招** ——
> 一個沒有斷言的測試，**殺不掉任何突變**。

⚠️ **而突變分數也不是萬能的**，它有三個抓不到的東西：

| 抓不到 | 說明 |
|---|---|
| **併發** | 事故 1 —— 突變測試是單執行緒跑的 |
| **缺少的功能** | 「忘記處理退款」不會產生任何突變 |
| **整合** | 「兩個元件的假設不一致」（7.2.1） |

### 7.16.5 測試的效能：475 條測試怎麼維持在四分鐘內

**7.18.1 的總表加起來約 3 分半。而它很容易變成 20 分鐘。**

**四個最大的成本來源，依大小排序**：

| # | 成本來源 | 一次的成本 | 處置 |
|---|---|---|---|
| ① 🔴 **Spring context 啟動** | **1～5 秒** | 減少 context 的**種類**（7.3.6） |
| ② 🔴 **`Thread.sleep`** | 你寫多少就是多少 | Awaitility（06 章 6.11.2） |
| ③ ⚠️ **Testcontainers 啟動** | 3～15 秒 | `@Container static`（整個類別共用）+ **reuse** |
| ④ ⚠️ **每個測試重建 schema** | 0.2～2 秒 | `@Sql` 只清資料，不重建結構 |

⚠️ **① 是最大的一個，而它的成本【不是】線性的**：

```
20 個測試類別，全部共用 1 個 context  →  3 秒
20 個測試類別，各自一個 context       →  60 秒        🔴 20 倍
```

**怎麼知道起了幾個 context**：

```properties
# src/test/resources/logback-test.xml 或 application-test.properties
logging.level.org.springframework.test.context.cache=DEBUG
```

```
Spring test ApplicationContext cache statistics:
  [size = 7, maxSize = 32, parentContextCount = 0, hitCount = 41, missCount = 7]
```

> 📌 **`missCount` 就是「起了幾個 context」。**
> ⚠️ **`missCount` 大於 5 就值得看一下** ——
> 通常是某幾個類別的 `@MockBean` 組合或 `@TestPropertySource` 不一樣。

**② 的具體例子**（06 章 6.11.2 的延伸）：

```
50 個 listener 測試 × Thread.sleep(500) = 25 秒
50 個 listener 測試 × Awaitility（實際平均 30ms） = 1.5 秒
```

⚠️ **而 7.13.2 的分層讓這 50 個裡有 45 個【根本不需要等】**
（直接呼叫 listener 方法）→ **剩下 5 個 × 30ms = 0.15 秒**。

**一個實用的診斷**：

```bash
# 列出最慢的 20 個測試
mvn test && \
  grep -h -o 'time="[0-9.]*"[^>]*name="[^"]*"' target/surefire-reports/*.xml \
  | sort -t'"' -k2 -rn | head -20
```

> 🔴 **一個經驗**：
> **測試套件變慢是【漸進】的，而它的臨界點很明確 ——
> 一旦超過「泡一杯咖啡的時間」，人就會開始跳過它。**
>
> 而「跳過測試」的下一步是「跳過併發測試」（7.12.4），
> 再下一步就是事故 1。

---

## 7.17 探針不是測試 ★★

### 7.17.1 06 章那 33 個實驗是什麼

```java
@Test
void 實驗A1_預設的executor是誰() {
    System.out.println("[A1] 容器裡的 TaskExecutor bean = " + …);
    // ⚠️ 沒有一個 assert
}
```

**它們沒有斷言。它們永遠是綠燈。它們不是測試。**

| | **探針**（probe） | 測試（test） |
|---|---|---|
| 目的 | **回答「它到底做了什麼」** | 「它有沒有壞掉」 |
| 有斷言嗎 | ❌ 印出來給人看 | ✅ |
| 什麼時候跑 | **寫稿／除錯／調查時，人在看** | 每次 CI，沒有人在看 |
| 失敗時 | 🔴 **不會失敗** | 紅燈 |
| 留在 CI 裡的價值 | 🔴 **接近零**（沒有人會讀那些輸出） | ✅ |

> 🔴 **一個永遠不會紅的測試，佔用 CI 的時間而不提供任何保護。**
> 而更糟的是：**它讓「測試數量」這個數字失真。**

### 7.17.2 把探針變成測試

**探針的價值不是零 —— 它的價值在於「它發現的那個事實」。**
**而那個事實應該被固定成一條斷言。**

```java
// 探針（06 章 6.2.3）
System.out.println("[A1] core=" + tpte.getCorePoolSize() + " max=" + tpte.getMaxPoolSize()
                 + " queueCapacity=" + tpte.getQueueCapacity());

// ★★ 變成測試：把發現的事實釘住
@Test
void 三個執行緒池的組態不可以被意外改掉() {
    assertThat(notificationExecutor.getCorePoolSize()).isEqualTo(4);
    assertThat(notificationExecutor.getQueueCapacity()).isEqualTo(500);

    // ★★★ 這一條才是重點：它守的是 06 章 6.2.4 那個「maxSize 是謊言」的陷阱
    assertThat(integrationExecutor.getQueueCapacity())
            .as("queueCapacity 太大會讓 maxPoolSize 永遠不被使用（06 章 6.2.4）")
            .isLessThanOrEqualTo(2000);
}
```

**06 章那 33 個探針，應該被轉成 8 條斷言**：

| 探針發現的事實 | 該固定成的斷言 |
|---|---|
| `[B2]` Boot 預設池的 max 沒作用 | ✅ `AsyncProperties` 的建構子檢查（06 章 6.2.9）**已經做了** |
| `[C1]` ThreadLocal 全部消失 | ✅ 「`@Async` 的 listener 不可讀 `LocaleContextHolder`」的 ArchUnit 規則 |
| `[D3]` `Future` 沒接會吞例外 | ✅ 「回 `CompletableFuture` 的呼叫必須被接住」的規則 |
| `[E5]` 沒有 `REQUIRES_NEW` 的寫入會成功 | ✅ **06 章 6.11.5 規則 3** |
| `[F1]` 預設沒有讀取逾時 | ✅ **06 章 6.5.5 的逾時政策守門測試** |
| `[H4]` Retry 在 CircuitBreaker 外層 | ⚠️ 一條「`minimumNumberOfCalls >= slidingWindowSize`」的組態檢查 |
| `[J3]` captor 抓到參照 | ⚠️ **無法用測試守** —— 只能靠「傳不可變物件」的設計（7.6.3） |
| `[L1]` 天真的實作會超賣 | ✅ **7.12.1 的併發測試** |

### 7.17.3 探針該放哪

```
src/test/java/example/shop/
├── …（正常的測試）
└── probe/                        ★ 探針放這裡
    ├── AsyncBasicsProbe.java
    └── TimeoutProbe.java
```

```java
@Tag("probe")                     // ★ CI 預設【不跑】
@Disabled("探針：需要時手動執行，見 07 章 7.17")
class AsyncBasicsProbe { … }
```

> 📌 **`@Disabled` + 一個說明用途的理由，比刪掉它們好**：
> **下一次有人問「Boot 3.4 的預設池變了嗎」時，
> 那個探針可以直接跑。**
>
> ⚠️ 而它**必須**被標成不跑，否則它會混在 415 個測試裡，
> 讓人以為那 24 個東西有在保護什麼。

---

## 7.18 shop-service 的測試總表

### 7.18.1 五層的實際數字

| 層 | 檔案數 | 測試數 | 時間 | 要不要資料庫 |
|---|---|---|---|---|
| ① Domain 單元 | 18 | ~200 | 0.8s | ❌ |
| ② Application 單元 | 12 | ~150 | 3s | ❌ |
| ③ Repository 整合 | 9 | ~60 | 40s | ✅ H2 |
| ④ 交易 / 併發 | 5 | ~15 | 30s | ✅ H2（**死鎖那條要 MySQL**） |
| ⑤ 守門 / 架構 | 6 | ~30 | 5s | ❌ |
| ⑥ 端到端 | 4 | ~20 | 2min | ✅ |
| **探針** | 12 | ~43（06 章 33 + 本章 10） | — | ⚠️ **`@Disabled`** |

### 7.18.2 守門測試的總清單（跨 00～07 章）

| 出處 | 守什麼 |
|---|---|
| 00 章 0.11.2 | ArchUnit 六組（分層、循環、`@Transactional` 不可 `final`…） |
| 03 章 3.8.4 | 金額型別、`MappingCompleteness`、角色可見性掃描 |
| **04 章 4.12** | 五組例外守門（`ErrorCode` 分區、41 個 fixture、`args()` 守門…） |
| **05 章 5.11.5** | 五條快取守門 |
| **06 章 6.11.5** | 四條非同步 ArchUnit + 一條重試掃描 |
| **07 章（本章）** | 契約測試（fake vs 真實作）、enum 窮舉、突變門檻 |

⚠️ **一共約 30 條，而它們的共同性質是**：

> **它們抓的不是「這次的 bug」，是「三個月後有人會犯的錯」。**

### 7.18.3 CI 的分層

```yaml
# ① PR 的快速回饋（< 1 分鐘）
mvn test -Dgroups='!concurrency & !e2e & !probe'

# ② main branch（全部）
mvn verify

# ③ 每晚
mvn verify -Pnightly            # + 突變測試 + Testcontainers 的 MySQL
```

> 🔴 **一個原則：`main` 一定跑全部。**
> ⚠️ 「因為併發測試偶爾紅，所以 main 也跳過它」是一條會通往事故 1 的路。

---

## 7.19 本章回頭修正前面的地方 ★★

### ① 🔴 06 章 6.11.3 的 `SyncTaskExecutor` 是一個危險的預設

**06 章的建議是「在測試裡把 `@Async` 變成同步」，並列了它測不到的三件事。**

**這一章 7.13.2 把它改成三層**，而 `SyncTaskExecutor` **只用在 `cacheEvictExecutor`**
（唯一一個不碰資料庫的池子）。

### ② ⚠️ 06 章那 33 個實驗不該原封不動留在 CI 裡

**7.17 說明了理由，並列出「哪 8 個事實該被固定成斷言」。**

### ③ 🔴 04 章 4.12 的 fixture 模式缺一個說明

**04 章寫了 `ExceptionFixtures.all()` 與五條性質測試，但沒說它為什麼有效。**
**7.7.1 補上了**：它的維護成本是**常數**，而 41 個個案測試是**線性**的。

### ④ ⚠️ 00 章 0.9.2 的 `Order` 需要一個「測試友善」的建構路徑

**7.14.2 的 `OrderTestBuilder` 靠 `Order.transitionTo()` 一步步走到目標狀態。**
**而那要求 `transitionTo` 是 public（或至少 package-private + 測試同套件）。**

⚠️ **這是一個真實的取捨**：

| | |
|---|---|
| 收益 | ✅ 測試資料一定是**合法的**訂單；00 章 0.9.2 那個「第二次部分出貨」的 bug 會被碰到 |
| 代價 | ⚠️ `transitionTo` 的可見性放寬了一點點 |

**shop-service 的決定：接受。** 而加一條 ArchUnit 規則
「只有 `Order` 自己與測試可以呼叫 `transitionTo`」。

### ⑤ ⚠️ 02 章 2.13.1「證明這個方法真的在交易裡」需要補一句話

**02 章給的方式是在方法裡放 `TransactionSynchronizationManager.isActualTransactionActive()`。**

**06 章 6.3.4 的實測 `[E1]` 顯示**：
`AFTER_COMMIT` 的 listener 裡，那個方法**仍然回 `true`** ——
**所以它不能用來證明「這裡有一個【會 commit 的】交易」。**

**補充的判準**：

```java
// ⚠️ 這個只證明「有綁定」
TransactionSynchronizationManager.isActualTransactionActive()

// ✅ 這個才證明「還沒 commit」
TransactionSynchronizationManager.isSynchronizationActive()
    && !TransactionSynchronizationManager.isCurrentTransactionReadOnly()
// ⚠️ 而最可靠的仍然是：從【另一條連線】去查（06 章 6.3.5 的 [E5] 就是這樣做的）
```

### ⑥ ⚠️ `@SpringBootTest` + `@Transactional` 要進「常見誤區」

**7.11.2 說明了它為什麼會讓 `AFTER_COMMIT` 的測試變成假綠燈。**
**這一條應該回頭補進 02 章 2.15 與 06 章 6.14。**

---

## 7.20 常見誤區

- **用 `@InjectMocks`** —— 少一個依賴時它**塞 `null` 而不報錯**（實測 `[J1]`），把編譯錯誤變成生產環境 NPE。
- 把 strict stubs 關掉（`Strictness.LENIENT`）—— ⚠️ `PotentialStubbingProblem` 抓的是**參數變了而 stub 沒跟上**，那是真的 bug。
- 以為 `ArgumentCaptor` 抓到的是快照 —— 🔴 **它抓到的是參照**（實測 `[J3]`），呼叫之後物件被改，斷言看到的是改完的狀態。
- **`any()` 與 `anyList()` 對 `null` 的行為不同** —— `any()` 匹配 `null`，`anyList()` 不匹配（實測 `[J4]`）。
- 對 spy 用 `when(spy.foo())` —— 🔴 **它會真的執行 `spy.foo()`**（實測 `[J6]`）。要用 `doReturn(...).when(spy).foo()`。
- **`@Spy` 自己的 Service 然後 stub 掉一半** —— 那是「這個類別做太多事」的訊號，不是測試技巧。
- mock 一個 `Money` / `Order` —— ⚠️ Mockito 5 **做得到**（實測 `[J5]`），而做得到不等於該做。
- mock `RestClient` / `JdbcTemplate` —— 🔴 你在斷言一個**你不擁有的契約**，升版時測試綠燈而生產炸掉。
- **mock `Clock`** —— `Clock.fixed(...)` 更好：沒 stub 到的方法不會 NPE。
- 用 `Clock.fixed(instant, ZoneId.systemDefault())` —— 🔴 **CI（UTC）綠、開發機（Asia/Taipei）紅**。
- 忘記 stub 而 Mockito **回 `Optional.empty()` / 空 `List`** —— ⚠️ 測試「成功地」走到了一條你不打算測的路徑。
- 以為 mock 的 `CompletableFuture` 會回一個已完成的 future —— 🔴 **它回 `null`**（實測 `[K1]`）。
- **在快樂路徑上用 `verifyNoMoreInteractions`** —— 讓測試變成「實作的逐行複寫」，重構會紅而 bug 不會紅。
- 只 `verify` 不斷言結果 —— 「有呼叫 `save()`」證明不了「存進去的東西是對的」。
- **斷言例外的訊息文字** —— 🔴 使用者訊息在 `messages.properties` 裡（04 章 4.5.2），改一個字要改 17 個測試。
- 為 41 個例外寫 41 個測試方法 —— ✅ 應該寫**5 條對 41 個都成立的性質**（7.7.1）。
- **`@SpringBootTest` + `@Transactional`** —— 🔴 測試結束自動 rollback → **`AFTER_COMMIT` 的 listener 一個都不會跑**（7.11.2）。
- 用 `SyncTaskExecutor` 測所有 `@Async` —— 🔴 06 章 6.3.3 那個「非同步看不到未提交資料」的 bug **會變成綠燈**（7.13.3）。
- 併發測試不用 `CountDownLatch` 對齊起跑 —— ⚠️ 任務會**依序**執行，競態根本不會發生。
- 以為併發測試需要幾十條執行緒 —— **2 條就夠了**（實測 `[L3]`：10/10 重現）。
- **「併發測試偶爾紅，所以我們關掉了」** —— 🔴 那個偶爾紅**就是它在工作**。
- 只看行覆蓋率 —— 🔴 **100% 的行覆蓋率 + 100% 的分支覆蓋率，仍然漏掉 `>=` 與 `>` 的差別**（實測：突變分數 80%）。
- 設了覆蓋率門檻就以為安全 —— ⚠️ 它可以被「沒有斷言的測試」灌水，而**突變分數不行**。
- 改了測試沒重新編譯就跑 PIT —— ⚠️ **實測踩過**：PIT 讀 `target/test-classes`，分數還是舊的。
- **把探針（沒有斷言的實驗）留在 CI 裡** —— 🔴 它永遠不會紅，卻讓「測試數量」這個數字失真（7.17）。
- 測試資料直接 `new Order(...)` 塞 14 個欄位 —— ⚠️ 看不出測試在乎哪一個，而且可以建出**不合法**的訂單（7.14.1）。

---

## 7.21 本章練習

### 練習 1：找出這個測試的 7 個問題

```java
@SpringBootTest
@Transactional
@MockitoSettings(strictness = Strictness.LENIENT)
class OrderApplicationServiceTest {

    @Mock OrderRepository repository;
    @Mock StockPort stockPort;
    @InjectMocks OrderApplicationService service;

    @Test
    void 建立訂單() throws Exception {
        when(repository.findById(anyString())).thenReturn(Optional.of(new Order()));

        service.create(new CreateOrderCommand(...), new Actor(...));

        Thread.sleep(500);
        verify(repository).save(any());
        verify(events).publish(any());
        assertThat(true).isTrue();
    }
}
```

<details>
<summary>答案</summary>

| # | 問題 | 節 |
|---|---|---|
| 1 | 🔴 **`@SpringBootTest` + `@Mock`** —— `@Mock` 建立的 mock **不在 Spring 容器裡**，所以真正被注入 `service` 的是**真的 bean**。要用 `@MockBean`（或不要用 `@SpringBootTest`） | 7.3.1 |
| 2 | 🔴 **`@Transactional` 在測試類別上** —— 測試結束自動 rollback → **`AFTER_COMMIT` 的 listener 不會跑**，而這個測試在 verify `events.publish` | 7.11.2 |
| 3 | 🔴 **`Strictness.LENIENT`** —— 關掉了「stub 沒被用到」與「參數不符」兩個檢查 | 7.3.2 |
| 4 | 🔴 **`@InjectMocks`** —— 少一個依賴時塞 `null`（事故 3） | 7.3.3 |
| 5 | 🔴 **`Thread.sleep(500)`** —— 又慢又不可靠，該用 Awaitility | 06 章 6.11.1 |
| 6 | 🔴 **`assertThat(true).isTrue()`** —— 一個**永遠成立**的斷言。它讓行覆蓋率上升而測試強度為零 | 7.16.4 |
| 7 | ⚠️ **`verify(repository).save(any())` 沒有斷言存進去的內容** —— 「有呼叫 save」證明不了「存的東西是對的」 | 7.5.1 |

**還有兩個「不算錯但很糟」的**：

| | |
|---|---|
| ⚠️ **`@Mock` 的 `events` 沒有宣告** | 這段程式碼**編譯不過** —— 而如果它有 `@InjectMocks`，那就是事故 3 |
| ⚠️ **測試名叫「建立訂單」** | 它沒有說「什麼條件下、期望什麼」。CI 上這個名字說明不了任何事 |

</details>

### 練習 2：這條測試為什麼抓不到 bug

**受測程式碼**（有一個真的 bug）：

```java
public Money refundableAmount(Order order, Instant now) {
    if (order.status() != OrderStatus.DELIVERED) {
        return Money.zero(order.currency());
    }
    Duration since = Duration.between(order.deliveredAt(), now);
    if (since.toDays() > 7) {                       // 🔴 bug 在這裡
        return Money.zero(order.currency());
    }
    return order.total();
}
```

**測試**：

```java
@Test
void 七天內可全額退款() {
    Order order = anOrder().delivered().deliveredAt(NOW.minus(Duration.ofDays(3))).build();
    assertThat(policy.refundableAmount(order, NOW)).isEqualTo(Money.twd("1180"));
}

@Test
void 超過七天不可退款() {
    Order order = anOrder().delivered().deliveredAt(NOW.minus(Duration.ofDays(30))).build();
    assertThat(policy.refundableAmount(order, NOW)).isEqualTo(Money.twd("0"));
}
```

**問題**：
1. 業務規則是「**七天內**（含第 7 天）可退款」。bug 是什麼？
2. 上面兩個測試的行覆蓋率是多少？
3. 突變測試會怎麼說？
4. 補哪幾個測試？

<details>
<summary>答案</summary>

**① bug**

```java
if (since.toDays() > 7)      // 🔴 第 7 天整（含）到第 8 天之前，toDays() == 7 → 不進這個分支 → 可退款
```

⚠️ **看起來是對的，而它有一個更隱蔽的問題**：

**`Duration.toDays()` 是【無條件捨去】的。**

| 實際經過 | `toDays()` | 這段程式碼 | 業務規則 |
|---|---|---|---|
| 7 天 0 小時 | 7 | ✅ 可退 | ✅ 可退 |
| 7 天 23 小時 | **7** | 🔴 **可退** | 🔴 **不可退**（已經超過 7 天了） |
| 8 天 0 小時 | 8 | ❌ 不可退 | ❌ 不可退 |

> 🔴 **真正的 bug 是「有將近 24 小時的灰色地帶」**，
> 而它會讓財務對不上帳 —— 00 章 0.3.2 事故 4 的同一個形狀。

**② 行覆蓋率**

**兩個測試涵蓋了**：
- `status != DELIVERED` 那個分支 → 🔴 **沒有涵蓋**（兩個訂單都是 `DELIVERED`）

所以**行覆蓋率不是 100%**，第 2、3 行沒被執行。

⚠️ **而這正是重點**：**覆蓋率報告會告訴你「少測了一條分支」，
但它一個字都不會提「7 天的邊界」。**

**③ 突變測試**

| 突變 | 會被殺掉嗎 |
|---|---|
| `> 7` → `>= 7` | 🔴 **不會** —— 沒有測試用 `deliveredAt = NOW - 7 天` |
| `> 7` → `< 7` | ✅ 會（3 天那個測試會紅） |
| 移除 `if (status != DELIVERED)` | 🔴 **不會** —— 沒有測試用非 `DELIVERED` 的訂單 |
| `return order.total()` → `return null` | ✅ 會 |

**突變分數約 50%。**

**④ 要補的測試**

```java
// ★ 補分支
@ParameterizedTest
@EnumSource(value = OrderStatus.class, mode = EXCLUDE, names = "DELIVERED")
void 非已送達的訂單不可退款(OrderStatus status) { … }

// ★★ 補邊界 —— 突變測試指出的那個洞
@Test
void 第七天整仍可退款() {
    Order order = anOrder().delivered().deliveredAt(NOW.minus(Duration.ofDays(7))).build();
    assertThat(policy.refundableAmount(order, NOW)).isEqualTo(Money.twd("1180"));
}

// ★★★ 補「灰色地帶」—— 這一條會【紅燈】，因為它抓到了真的 bug
@Test
void 第七天又二十三小時不可退款() {
    Order order = anOrder().delivered()
            .deliveredAt(NOW.minus(Duration.ofDays(7)).minus(Duration.ofHours(23))).build();
    assertThat(policy.refundableAmount(order, NOW)).isEqualTo(Money.twd("0"));
}
```

**而修法是把「7 天」變成一個明確的時刻**：

```java
Instant deadline = order.deliveredAt().plus(REFUND_WINDOW);   // ★ REFUND_WINDOW = Duration.ofDays(7)
if (now.isAfter(deadline)) {
    return Money.zero(order.currency());
}
```

> 📌 **一般原則**：
> **不要用「經過了幾天」做判斷，要用「截止時刻是什麼時候」。**
> 前者引入了一個捨去，後者沒有。
>
> ⚠️ 而這也讓 API 可以回傳 `refundableUntil` 給客戶端 ——
> **04 章 4.9 的 `AlternativeAction.availableUntil` 就是為這個存在的。**

</details>

### 練習 3：設計「訂單成立」的測試組合

**任務**：`OrderApplicationService.create()` 這一個方法，
在 7.2.2 那五層裡各應該有哪些測試？各測什麼？

<details>
<summary>答案</summary>

| 層 | 測試 | 測什麼 |
|---|---|---|
| **① Domain** | `OrderFactoryTest`（~15 條） | 金額計算、券的折扣、運費、幣別一致、明細上限、`Money` 的四捨五入 |
| | `OrderTest`（~25 條） | 11 條不變量、狀態機、`allowedActions` |
| **② Application** | `OrderApplicationServiceTest`（~18 條） | **編排順序**（`InOrder`：先扣庫存再存訂單）、庫存不足時 `never()` 存訂單、事件的內容（`ArgumentCaptor`）、id 三處一致 |
| **③ Repository** | `OrderRepositoryContractTest`（fake + 真的各跑一次） | 存了查得到、查不到回 empty、集合不可變 |
| | `JdbcOrderRepositoryTest`（~10 條） | SQL、`search()` 的排序與分頁、`NULL` 的處理 |
| **④ 交易 / 併發** | `StockConcurrencyTest`（2 條） | **50 執行緒不超賣**、2 執行緒的快版 |
| | `OrderTransactionIntegrationTest`（3 條） | 推 ERP 失敗時訂單與庫存**都 rollback**、`AFTER_COMMIT` 真的有跑 |
| **⑤ 守門** | `AsyncGuardTest`、`ExceptionArchitectureTest` … | 見 7.18.2 |
| **⑥ 端到端** | `OrderApiE2ETest`（2 條） | `POST /api/orders` 回 201 + `Location`；庫存不足回 409 + `Problem` |

⚠️ **三個「不該有」的測試**：

| 不該有 | 為什麼 |
|---|---|
| 🔴 **在 ② 測「金額算得對不對」** | 那是 Domain 的責任，而在 ② 測它要準備一堆 mock |
| 🔴 **在 ⑥ 測「券過期的錯誤訊息」** | 端到端測試慢 2 分鐘，而那條規則在 ① 只要 3 毫秒 |
| 🔴 **在 ② `verify` 每一個依賴都被呼叫過** | 7.5.4 的過度驗證 |

> 📌 **一個判準**：
> **每一條規則，只在「能用最快的方式測到它」的那一層測。**
>
> ⚠️ 而它的反面也成立：**如果一條規則只能在 ⑥ 測到，
> 那通常代表它放錯層了。**

</details>

### 練習 4：讓「假綠燈」變成不可能

**背景**：7.16.4 說「覆蓋率門檻可以被沒有斷言的測試灌水」。

**任務**：設計一組機制，讓「一個沒有斷言的測試」在 CI 就被抓到。
說出每個機制抓得到什麼、抓不到什麼。

<details>
<summary>答案</summary>

**四個機制，由弱到強**：

| # | 機制 | 抓得到 | 抓不到 |
|---|---|---|---|
| ① | **靜態掃描**：測試方法必須含 `assert` / `verify` / `assertThatThrownBy` | ✅ 完全空的測試 | 🔴 `assertThat(true).isTrue()` |
| ② | **突變分數門檻**（`mutationThreshold`） | ✅ **所有沒有實效的斷言** | 🔴 併發、缺少的功能 |
| ③ | **「守門測試必須紅過」** —— 對每條 ArchUnit 規則做一次故意違反 | ✅ 規則寫錯 | 需要人工，或一組 fixture |
| ④ | **PR 檢查：改了 `main` 卻沒改測試** | ✅ 「加功能不加測試」 | 🔴 加了爛測試 |

**① 的實作**：

```java
/**
 * ★ 掃描測試：每個 @Test 方法都必須有至少一個斷言。
 *
 * <p>⚠️ 它是<b>啟發式</b>的（04 章 4.8.7 的 args() 守門人是同一個性質）：
 * 它看的是「方法體裡有沒有呼叫 assert*/verify*/then*」，
 * 而那擋不住 {@code assertThat(true).isTrue()}。
 *
 * <p>👉 所以它必須與②（突變分數）一起用，而②才是真正的守門人。
 */
@Test
void 每個測試方法都要有斷言() {
    try (ScanResult scan = new ClassGraph()
            .enableAllInfo().acceptPackages("example.shop").scan()) {
        List<String> violations = scan.getAllClasses().stream()
                .flatMap(c -> c.getMethodInfo().stream())
                .filter(m -> m.hasAnnotation("org.junit.jupiter.api.Test"))
                .filter(m -> !callsAnyAssertion(m))
                .map(MethodInfo::toString)
                .toList();

        assertThat(violations)
                .as("這些測試方法沒有任何斷言（07 章 7.17：它們可能是探針）")
                .isEmpty();
    }
}
```

⚠️ **而它需要一個例外機制**：**探針**（7.17）本來就沒有斷言。

```java
.filter(m -> !m.getClassInfo().hasAnnotation("org.junit.jupiter.api.Disabled"))
```

**③ 的實作**（最有價值、也最少人做的一個）：

```java
/**
 * ★★★ 「守門測試必須紅過」的自動化版本。
 *
 * <p>做法：在 test source 裡放一組<b>故意違反規則</b>的類別，
 * 然後斷言「規則對它們是紅的」。
 *
 * <p>⚠️ 那些類別必須在一個<b>不會被正式規則掃到</b>的套件裡
 * （例如 {@code example.violations}），否則正式的規則會永遠紅燈。
 */
@Test
void 規則3對故意違反的類別會紅燈() {
    JavaClasses violations = new ClassFileImporter().importPackages("example.violations");

    assertThatThrownBy(() -> AFTER_COMMIT_REQUIRES_NEW.check(violations))
            .isInstanceOf(AssertionError.class)
            .hasMessageContaining("AFTER_COMMIT 的 listener 但沒有");
}
```

> 📌 **這一條把 06 章 6.11.5 那個「手動驗證一次」的動作變成了 CI 的一部分。**
>
> 🔴 **而它的價值在於：規則本身也會被改壞。**
> 有人為了讓某個 PR 過關，把 `.allowEmptyShould(true)` 加成
> `.because("暫時關閉")` —— 而 ③ 會紅燈。

</details>

---

## 7.22 驗收清單

### 完成本章後，你的專案應該有

```
✅ 測試基礎設施
   ├── OrderTestBuilder.java              ★★ 走真的建構路徑（7.14.2）
   ├── Orders.java（Object Mother）        ★  ≤ 8 個方法
   ├── MutableClock.java                  ★  7.10.2（test source only）
   ├── InMemoryOrderRepository.java       ★★ fake + UnsupportedOperationException（7.8.4）
   ├── InMemoryStockPort.java             ★★
   └── ExceptionFixtures.java（41 個）     （04 章 4.12，7.7.1 說明了它為何有效）

✅ 契約測試
   ├── OrderRepositoryContractTest.java   ★★ 抽象，兩個實作各跑一次
   └── StockPortContractTest.java         ★★

✅ 分層的測試
   ├── domain/…（~200 條，不用 mock）       ★★ 7.2.2 第 ① 層
   ├── application/…（~150 條）             ★  7.2.2 第 ② 層
   ├── repository/…（~60 條，H2）           ★
   ├── concurrency/StockConcurrencyTest.java  ★★★ 事故 1（@Tag("concurrency")）
   ├── concurrency/OptimisticLockTest.java    ★★ CyclicBarrier（7.12.5）
   └── transaction/OrderTransactionIntegrationTest.java ★★ ⚠️ 沒有 @Transactional

✅ 守門
   ├── 06 章的四條 AsyncGuardTest              ★★
   ├── EnumCoverageTest.java                  ★  7.15.1
   ├── AssertionPresenceTest.java             ★  7.21 練習 4 ①
   └── GuardRuleMustFailTest.java             ★★★ 7.21 練習 4 ③

✅ 突變測試
   └── pitest-maven（domain 層，門檻 85%）     ★★ 7.16.3

⚠️ 探針
   └── probe/…（06 章 33 個 + 本章 10 個）      ★ @Tag("probe") + @Disabled（7.17.3）

🔴 改掉
   ├── 所有 @InjectMocks → 建構子              ★★ 事故 3
   ├── 所有測試類別上的 @Transactional          ★★ 7.11.2
   ├── 所有 Thread.sleep → Awaitility           ★  06 章 6.11.2
   └── 6.11.3 的全域 SyncTaskExecutor → 只換 cacheEvictExecutor ★★ 7.13.3
```

### 我能回答的問題

- [ ] 「mock 一個依賴」放棄了哪四個保證？（7.2.1）
- [ ] 事故 1（超賣）該由哪一層抓？為什麼 Application 的單元測試不可能抓到？（7.2.3）
- [ ] `@InjectMocks` 的三個風險是什麼？（7.3.3）
- [ ] strict stubs 的兩個檢查各抓什麼真實 bug？（7.3.2）
- [ ] 未 stub 的方法回傳什麼？`Optional`、`List`、`CompletableFuture` 各是什麼？（7.3.5、7.13.4）
- [ ] `any()` 與 `anyList()` 對 `null` 的行為差在哪？（7.4.3）
- [ ] `ArgumentCaptor` 抓到的是參照還是快照？有哪三種解法？（7.6.2、7.6.3）
- [ ] `never()` 為什麼比一般的 `verify` 有價值？（7.5.2）
- [ ] 什麼樣的測試是「重構會紅、bug 不會紅」？（7.5.4）
- [ ] 41 個例外怎麼用 5 個測試方法測完？（7.7.1）
- [ ] 為什麼不該斷言例外的訊息文字？（7.7.3）
- [ ] 五種測試替身分別是什麼？什麼時候 fake 比 mock 好？（7.8.1、7.8.3）
- [ ] fake 最大的風險是什麼？怎麼防？（7.8.4）
- [ ] 對 spy 為什麼不能用 `when(spy.foo())`？（7.8.2）
- [ ] 不該 mock 的四種東西是什麼？（7.9）
- [ ] `Clock.fixed` 為什麼比 `mock(Clock.class)` 好？（7.9.3）
- [ ] 單元測試測不到交易的哪五件事？（7.11.1）
- [ ] `@SpringBootTest` + `@Transactional` 會讓什麼變成假綠燈？（7.11.2）
- [ ] 併發測試裡 `CountDownLatch` 與 `CyclicBarrier` 各用在哪？（7.12.1、7.12.5）
- [ ] 幾個執行緒才夠重現超賣？（7.12.3）
- [ ] `SyncTaskExecutor` 該用在哪、不該用在哪？（7.13.3）
- [ ] 行覆蓋率、分支覆蓋率、突變分數各量什麼？（7.16.1）
- [ ] 一個 100% 覆蓋率的方法，突變分數為什麼可能只有 80%？（7.16.2）
- [ ] 突變測試抓不到哪三種問題？（7.16.4）
- [ ] 「探針」與「測試」的差別是什麼？探針該怎麼處理？（7.17）

### ⚠️ 已知缺口

| # | 缺口 | 為什麼不修 | 替代 |
|---|---|---|---|
| 1 | 🔴 **所有併發實驗都在 H2 上** | 沒有 Docker | ⚠️ 7.12.4 明確標註了它與 MySQL 的差異 |
| 2 | 🔴 **死鎖測試沒有寫出完整程式碼** | 它在 H2 上與 MySQL 上行為不同，寫一個 H2 版會誤導 | 7.12.5 說明了它需要 Testcontainers |
| 3 | ⚠️ **`OrderRepositoryContractTest` 是設計，沒有完整實作** | 需要完整的 `Order` 聚合（驗證專案裡沒有） | 契約測試的三條與分工是完整的 |
| 4 | ⚠️ **突變測試只在一個 5 行的類別上跑過** | 完整的 domain 層不在驗證專案裡 | ✅ **那個例子本身是實測的**（80% → 100%） |
| 5 | ⚠️ **7.21 練習 4 ③ 的 `GuardRuleMustFailTest` 沒有跑過** | — | ⚠️ 06 章 6.11.5 用**手動**做了同一件事（四條規則全紅） |
| 6 | ⚠️ **`OrderTestBuilder` 的 `pathTo(status)` 沒有實作** | 需要完整的狀態機 | 設計與取捨（7.19 ④）是完整的 |
| 7 | ⚠️ **7.18.1 的數字是估計，不是實際專案的統計** | 完整的 shop-service 不存在於驗證專案 | 比例與分層是有依據的 |
| 8 | ⚠️ **沒有測「測試本身的執行時間」** | — | 7.18.3 的 CI 分層是替代 |

### ⚠️ 環境與驗證狀態

| 項目 | 值 |
|---|---|
| JDK | Temurin 21.0.5 |
| Maven | 3.9.16 |
| Spring Boot | 3.2.5 |
| **Mockito** | **5.7.0**（`InlineByteBuddyMockMaker`） |
| AssertJ | 3.24.2 |
| Awaitility | 4.2.1 |
| **PIT** | **1.15.8** + `pitest-junit5-plugin` 1.2.1 |
| 資料庫 | **H2 2.2.224** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗**：

| 組 | 實驗 | 結果 |
|---|---|---|
| J | Mockito 的六個陷阱 | ✅ `@InjectMocks` 塞 null → NPE；**captor 抓到參照**；**`any()` 匹配 null 而 `anyList()` 不匹配**；可以 mock record；`when(spy.get(0))` 真的執行 |
| K | 未 stub 的預設回傳 | ✅ `Optional.empty` / `[]` / `{}` / **`CompletableFuture` 是 `null`** |
| L | 併發重現超賣 | ✅ **50 執行緒 5/5 輪重現**（剩餘 -1 ～ -4）；原子 UPDATE **5/5 輪正確**；**2 執行緒 10/10 輪重現** |
| PIT | 突變測試 | ✅ 行覆蓋率 100% 而突變分數 **80%**（`ConditionalsBoundaryMutator` 存活）；補邊界後 **100%** |

🔴 **沒有驗證的**：

| 沒驗證的 | 影響哪一節 |
|---|---|
| **真的 MySQL 的鎖行為** | 7.11.3、7.12.4、7.12.5 |
| 契約測試跑在真的 Repository 上 | 7.8.4 |
| `GuardRuleMustFailTest` | 7.21 練習 4 |
| Testcontainers | 7.11.3 |

---

## 7.23 這一站的結尾

**05-service 站到這裡結束。八章，一個結論：**

> **這一站從頭到尾在做同一件事 ——
> 把「靜默的錯誤」換成「編譯錯誤」或「CI 紅燈」。**

**而八章各自換掉了什麼**：

| 章 | 原本會靜默出錯的事 | 換成了 |
|---|---|---|
| 00 | 規則散在 Service 裡，不變量沒有守門人 | 聚合 + `assertInvariants()` + ArchUnit |
| 01 | 循環依賴讓 `@Transactional` 靜默失效 | `allow-circular-references: false` + 啟動失敗 |
| 02 | 自呼叫讓交易完全沒開 | ArchUnit + 執行期探針 + 15 步驟的理解 |
| 03 | **PATCH 送 null 想清空，什麼都沒發生** | `Patch<T>` sealed interface（編譯錯誤） |
| 04 | 業務失敗變 500，前端盲重試 | 41 個例外 + 98 個 code + `safeToRetryBlindly` |
| 05 | rollback 之後快取留著髒值 | ArchUnit + `AFTER_COMMIT` + 短 TTL |
| 06 | **部署時 470 封信被丟掉** | outbox（寫進同一個交易） |
| **07** | **測試「證明」了一件它沒有證明的事** | **契約測試 + 突變測試 + 守門測試必須紅過** |

⚠️ **而 07 章的那一列是特別的，因為它是【元】層次的**：

> **前七章加了大約 30 條守門測試。**
> **而 07 章要問的是：那 30 條，有幾條是真的會紅的？**

### 這一站留下的最大一個未解問題

**每一章的「已知缺口」都指向同一個方向**：

| 章 | 缺口的共同形狀 |
|---|---|
| 02 | 「交易行為要用真的 MySQL」 |
| 05 | 「本章沒有真的 Redis」 |
| 06 | 「沒有真的 MQ、沒有真的 MySQL、沒有 K8s」 |
| 07 | 「所有併發實驗都在 H2 上」 |

> 🔴 **這一站的程式碼在 H2 上是綠的，而它要跑在 MySQL 上。**
>
> **而 06 章 `[E5]` 已經給了一個具體的例子**：
> **一個錯誤的寫法，在 H2 上通過了測試。**

**這正是下一站的內容。**

---

## 下一站：06-repository

| 站 | 主題 | 這一站留給它的問題 |
|---|---|---|
| **06-repository** | Repository 與資料存取 | 「`OrderRepository` 這個介面，真的實作起來長什麼樣」 |
| 07-mysql | MySQL | **02 章的鎖與隔離等級、07 章的併發測試，在真的 MySQL 上如何** |
| 08-jpa-mybatis | JPA / MyBatis | 03 章的 `open-in-view`、Lazy 載入、N+1 |

**而 05-service 站交出去的東西是**：

```
✅ 一個完整的 Application 層（編排 + 交易邊界）
✅ 一個充血的 Domain 層（11 條不變量 + 狀態機 + 值物件）
✅ 41 個業務例外 + 98 個 ErrorCode
✅ 七個快取 + 各自的 TTL 與失效策略
✅ 三個執行緒池 + outbox + 熔斷 + 六個外部呼叫的逾時矩陣
✅ 約 475 條測試 + 約 30 條守門測試
⚠️ 一個【記憶體的】Repository 假實作 —— 06-repository 站會把它換成真的
```

> 📌 **最後一句話**：
>
> 這一站的八章裡，**最有價值的內容全部來自「跑一次看看」** ——
> 而不是來自「文件上說」。
>
> **04 章的編譯器抓到 `OrderStatus.COMPLETED` 不存在。**
> **05 章的實驗推翻了 02 章的一個說法。**
> **06 章的實驗發現「錯的寫法在 H2 上會通過測試」。**
> **07 章的突變測試發現「100% 覆蓋率漏掉了 `>=` 與 `>`」。**
>
> ⚠️ **四個發現都不是靠讀程式碼得到的。**
>
> **而這就是這一站想教的最後一件事：**
> **對於「框架到底做了什麼」這種問題，
> 一個十行的實驗，勝過一小時的文件閱讀。**
