# 05-service 撰稿複查紀錄（作者側，非課程內容）

> ⚠️ **這個檔案不是給讀者的。** 它是原稿的校對與跨章稽核日誌 ——
> 記錄每一輪複查抓到什麼、修法、以及還沒關掉的風險。
>
> 課程本身的內容在 `../README.md` 與各章檔案裡。
> **讀者不需要知道原稿的第幾版寫錯了什麼**，
> 但作者需要 —— 因為同一類錯誤會重複出現（例如 `ArchRule` 少空格犯了兩次）。

---

## 每次新增章節後要重跑的機械檢查

**00～03 章已通過的機械檢查**（每次新增章節後重跑）：

| 檢查 | 結果 |
|---|---|
| 本章內部小節引用 | ✅ 全部解析成功 |
| 跨章引用（`0N 章 N.M.K`）—— 含「章號與小節首碼相符」 | ✅ 全部解析成功 |
| 跨站引用（`04-controller N.M.K`，612 個小節） | ✅ 全部解析成功 |
| 裸章號歧義（`04 章`） | ✅ 61 處加前綴、15 處確認為本站 |
| `static final ArchRule<變數名>` 少空格 | ✅ 無 |
| 前向指標（前面的章指向後面的修正） | ✅ 19 處 |

> ⚠️ 課程中的程式碼、YAML 與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
> （這台機器上沒有安裝 JDK 與 Maven）。基準版本延續 04-controller：
> **Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1 / Jackson 2.17 / ArchUnit 1.3**。
> 若你的版本不同（尤其是 Boot 3.0/3.1），課程會標註差異，但仍請以你的環境實測為準。

⚠️ **這些檢查抓不到的**：型別／方法存不存在、`final` 欄位被賦值、
散文宣稱的數量與表格列數不符 —— 那些仍然要人工比對，
而**真正能徹底掃乾淨的只有編譯器**（目前這台機器沒有 JDK）。

---

### 00～01 章的複查紀錄

兩章寫完後做了一輪複查，項目與 04-controller 的三輪相同：
**型別存不存在、方法存不存在、框架行為是否屬實、章與章的接縫**。
結論與 04-controller 一致：**錯誤集中在「跨章的接縫」與「我自己補寫的部分」**。

**① 程式碼裡的實質 bug（不是筆誤）**

| bug | 位置 | 後果 |
|---|---|---|
| **狀態機被宣告但沒有任何程式碼在讀它** | 00 章 0.9.2 / 0.9.3 | `OrderStatus.canTransitionTo()` 從未被呼叫 → 不變量 I5 **完全沒有守門人**，而課程宣稱它是 I5 的定義。→ 新增 `Order.transitionTo()` 作為**唯一**改變 `status` 的地方 |
| **第二次「部分出貨」會 500** | 00 章 0.9.2 | 加上 `transitionTo` 之後浮現：`PARTIALLY_SHIPPED → PARTIALLY_SHIPPED` 不在狀態機裡 → 分三批出貨的第二批直接炸。→ 補上 `if (next != status)` 與完整說明 |
| **`indexOf` 對重複明細回傳錯的索引** | 00 章 0.9.4 | `Line` 是 record，兩筆 `Line("P-1", 2)` 相等 → `items[0]` 指向錯的那一列 → 04-controller 的 `errors[]` 定位錯誤。→ 改成索引迴圈 |
| **ArchUnit 的 Jackson 規則實際上會紅燈** | 00 章 0.11.2 | `allowEmptyShould(true)` 被誤用成「例外機制」——它只管「沒有類別符合 `that(...)`」，與 `OrderStatus` 上的 `@JsonEnumDefaultValue` 無關。→ 改用 `ignoreDependency(...)` 並把例外寫出來 |
| **循環規則的 `ignoreDependency(alwaysFalse(), alwaysFalse())` 什麼都不忽略** | 00 章 0.11.2 | 規則照樣紅燈，而下一個人會以為例外處理過了。→ 改成真的忽略 `Actor` 那條邊，並寫下兩個已知循環與各自的處置 |
| **`static final ArchRule分層架構` 少一個空格** | 00 章 0.11.2 | 型別名與變數名黏在一起 → **編譯不過** |
| **Hikari 的註解把 `connection-timeout` 說成「必須大於最長交易時間」** | 00 章 0.11.3 | 完全無關（它是「向池子要連線最多等多久」），而且與同一段給的數值互相矛盾。→ 整段重寫，並說明 `leak-detection-threshold` 才是與交易長度有關的那一個 |

**② 跨章與跨站的接縫**

| 衝突 | 修法 |
|---|---|
| **`Coupon.discountFor()` 有兩種 arity** —— 0.5.5 是 `(subtotal, now)`、0.9.2/0.12 是 `(subtotal, lines, now)` | 統一成三參數；0.5.5 加上「券可能只適用部分商品」的說明 |
| **`OrderPlacedEvent` 有四種形狀**（3／5／5／7 個參數）、`OrderCancelledEvent` 有兩種 | 在 00 章 0.12 ⑬ 定義正式版 + `from(...)` 工廠，五個呼叫點全部改用工廠 |
| **`StatusLabelResolver.label()` 沒有吃 `Locale` 的多載** | 04-controller 6.5.8 的版本讀 `LocaleContextHolder`（ThreadLocal）→ 排程／`@Async`／串流會拿到錯的語言。→ **新增 0.14.5**，補上 `label(Enum<?>, Locale)`，並點出它與 1.4.6 的 `SecurityContextHolder` 是同一個陷阱 |
| **`PageResponse.of(list, number, size, total)` 不存在** | 04-controller 1.11.5 的形狀是 `(items, PageInfo)`。→ 1.9.2 改用 `new PageResponse<>(..., PageInfo.offset(...))` |
| **`StockRepository` 與 `StockPort` 混用** | 統一成 `StockPort`；`RowMapper` 從 `StockSnapshot`（在 port 套件）移到 Repository 實作，否則埠會依賴 JDBC |
| **`customers.levelOf()` 只回等級，但事件需要 email** | 改成 `summaryOf()` 回 `CustomerSummary`（00 章 0.12 ⑭），並說明為什麼不回傳整個 `Customer` |
| **`ProductNotFoundException` 有兩種 arity**（單一 id / List） | 統一收 `List`，一次說完缺哪幾個 |
| **章號歧義** —— 本站與 04-controller 都有 00～07 章，而「06 章 6.5.8」兩邊都說得通 | 全書 ~180 處跨站引用改成 `04-controller X.Y`（見上方「引用慣例」） |

**③ 用到但沒有定義的東西**

| 缺什麼 | 補在哪 |
|---|---|
| **10 個新的 `ErrorCode`** —— 課程新增了 `MixedCurrencyException` 等例外，但 04-controller 的 `ErrorCode` 是一份**封閉的註冊表**，而 3.14.5 有測試在守它 | **新增 0.12 ⑮**：10 個 code 的完整表 + 每一個「為什麼不重用既有的」，總數 83 → **93** |
| `Order.deliveredAt` 與 `markDelivered()` —— 狀態機有 `SHIPPED → DELIVERED`，但**沒有任何方法會走它**；而練習 2 的退貨期限需要 `deliveredAt` | 00 章 0.9.2 |
| `OrderStatus.isReturnable()` | 00 章 0.9.3 |
| `Product.isReturnable()` 與 `Category` —— 練習 2 的「生鮮不可退」需要它 | 00 章 0.12 ⑦（用**白名單**而不是黑名單，並說明理由） |
| `Coupon.maxPerCustomer` —— 01 章練習 2 的步驟 3 呼叫它 | 00 章 0.12 ⑨ |
| `ProductRepository` / `CouponRepository` / `ShippingAddressRepository` / `CustomerRepository` 四個埠 | 00 章 0.12 ⑩ |
| `Actor.SYSTEM` 與 `isPrivileged()` | 00 章 0.12 ⑫ |
| `ChargeStatus` / `RefundResult` / `RefundStatus` | 01 章 1.7.2 補上「它們該長什麼形狀」與 `NOT_FOUND` 為什麼不可省 |
| `@RestClientTest` 缺 `@EnableConfigurationProperties` | 01 章 1.7.3 |

**④ 框架事實**

| 原本寫的 | 實際 |
|---|---|
| CGLIB 無法代理 `final` 類別 → 「**編譯不過**」 | **啟動期**才失敗（`AopConfigException`）。而且原本漏了「非 `public` 方法同樣靜默失效」（`publicMethodsOnly` 預設 `true`）與 `static` 方法 |
| 引用 `AopAutoConfiguration` 說明 `@Transactional` 的代理型別 | 決定 `@Transactional` 的是 **`TransactionAutoConfiguration`**（讀同一個屬性，但那是兩個組態）。→ 補上兩者的分工，以及「`proxy-target-class=false` 反而讓失效變成啟動失敗」這個反直覺的安全性 |

**⑤ 複查逼出來的兩個新守門測試**

| 測試 | 抓什麼 |
|---|---|
| **`狀態機的每一條邊都有對應的操作`**（00 章 0.9.5） | 「宣告了轉移但沒有實作」。⚠️ **它現在會紅燈**（`markRefunded` 不存在），而那是刻意的：一個可執行的待辦比 `// TODO` 可靠 |
| **Object Mother 要「走過真實的狀態路徑」**（00 章 0.9.5） | `Orders.inStatus(DELIVERED)` 若只是塞欄位，會因為不變量 I7 拋例外，而錯誤訊息看起來像被測程式碼的 bug |

**⑥ 第二輪（方法層級）**

第一輪查的是「型別存不存在」與「框架行為是否屬實」。
第二輪查「**方法存不存在**」與「**上一輪自己有沒有改壞**」。

**上一輪的修改本身沒有問題**（語法、範圍、事件工廠的呼叫點都對得上），
但方法層級掃描仍抓到 3 處：

| 問題 | 修法 |
|---|---|
| `Order.paymentById()` 與 `requestRefund()` 被 1.11 練習 3 的答案呼叫，但**不存在** | 明確標註「這個練習設計的是**埠**不是聚合」，並連到 0.9.5 那個**現在就紅燈**的邊涵蓋測試 —— 兩者是同一個缺口的兩端 |
| `Coupon.isExpired()` 被 0.5.5 的反例呼叫，但 `Coupon` 刻意只有一個 `discountFor()` | 反例改成直接比對 `endAt()`，並補上「**為什麼刻意不提供拆開的述詞**」——拆開的述詞會邀請呼叫端自己組規則 |
| `JdbcStockRepository` 的 `final` 欄位沒有建構子 | 補上（這一章一直在講建構子注入，範例自己漏掉不太好） |

**另外驗證了 9 組「散文宣稱的數量」與實際表格列數一致**
（17 件事、6 個事故、5 個差別、7 條規則、5 個後果、6 種解法、
6 個理由、5 種手段、4 種做法）—— 全部相符。

**⑦ 02 章寫完後的複查**

02 章對 00／01 章許下的 **20 個「02 章會講」的承諾全部兌現**（機械檢查過小節編號）。
複查抓到 5 處：

| 問題 | 修法 |
|---|---|
| 🔴🔴 **`AFTER_COMMIT` 與「連線歸還」的順序寫反了** | 原本寫「⑬ 歸還連線 → ⑭ AFTER_COMMIT」。實際上 `cleanupAfterCompletion` 在**最外層的 finally**，所以順序是 **commit → AFTER_COMMIT → AFTER_COMPLETION → 才歸還**。<br>👉 後果差很多：`AFTER_COMMIT` 裡 `isActualTransactionActive()` **仍然是 `true`**、連線**仍然綁著** —— 所以用 `REQUIRED` 會「加入一個不會再 commit 的交易」→ **寫入靜默消失**。原本的解釋（「已經沒有交易，會拿新連線」）會讓讀者以為 `REQUIRED` 只是「不夠原子」，實際上是**完全無效** |
| `EventPublisherWithTransactionCheck` 只檢查 `isSynchronizationActive()` | Spring 的實際條件是 `isSynchronizationActive() && isActualTransactionActive()`，少一個會漏掉一半情況 |
| `Innodb_deadlocks` 不是原生 MySQL 的狀態變數 | 它是 Percona / MariaDB 才有的。改用 `Innodb_row_lock_waits`，並說明「儀表板永遠是 0」其實是「沒有在量」 |
| `ON DUPLICATE KEY UPDATE ... VALUES(col)` | MySQL 8.0.20 起已 deprecated，改用 `AS new` 的列別名並標註版本需求 |
| `Order.version()` / `markVersionIncremented()` 被 2.11.6 呼叫但沒定義 | 在 2.14.1 ④ 補上，並誠實討論「version 是持久化細節洩漏到 Domain」的三個選項與取捨 |

⚠️ **第一項是這一輪最有價值的一個**：它是「推理正確但機制記錯」的典型 ——
結論（`AFTER_COMMIT` 寫入要用 `REQUIRES_NEW`）是對的，但**理由是錯的**，
而錯的理由會讓讀者在下一個類似情境做出錯誤的判斷。

⚠️ **這一輪沒有做的事**：仍然沒有編譯執行。
所有「框架行為」的判斷是對照 Spring / ArchUnit / HikariCP 的原始碼語意做的，
**而那不等於實測**。👉 **請以你的環境實測為準**，
如果你發現任何一處不符，那是課程的問題不是你的。

**⑧ 03 章寫完後的複查**

02 章 2.18 對 03 章許下的 **8 個「03 章會講」的承諾**（3.2～3.9）全部兌現，
並且兌現了那個明確的預告 ——「**03 章會回頭檢視 00 章 0.14.1 的決定**」（3.3.3）。

機械檢查過的項目：**本章 64 個相異的內部小節引用全部存在**、
**跨章引用（00／01／02 章）全部解析成功**、
**跨站引用（04-controller）全部解析成功**、
**7 組「散文宣稱的數量」與表格列數一致**
（6 個代價、12 個端點、5 件事、5 條 ArchUnit 規則、4 個 ErrorCode、
練習 1 的 12 個問題、3.10.3 的九處修正）。

複查抓到 5 處：

| 問題 | 修法 |
|---|---|
| 🔴 **三條 `static final ArchRule非support套件…` 型別名與變數名黏在一起** | **編譯不過** —— 與 00 章 0.11.2 抓到的是**同一個 bug 形狀**（`ArchRule分層架構`）。⚠️ 值得注意的是：我在 00 章修過它之後，**在 03 章又犯了三次** —— 這說明它不是「小心一點」能解決的，而是需要一條 checkstyle 規則 |
| **`toDetail` 的欄位數在三張表裡是 22 / 12 / 22** | 根因是「欄位數」沒有定義（頂層？含巢狀？）。→ 3.10.1 明確定義算法（**頂層 / 含巢狀**），三張表全部改成一致，並說明「判準用含巢狀，因為巢狀的欄位一樣會漏」 |
| **3.4.1 手寫的 `toDetail` 與 3.10.1「用 MapStruct」矛盾** | 它不是 bug 而是**章節順序**（先看見痛 → 再給解法），但讀者會以為兩個都存在。→ 3.10.1 明確標出「這是中間狀態」與「測試要改哪一行」 |
| **`UpdateOrderCommand` 的 mapper 方法名 `toCommand` 與 3.10.1 的 `toUpdateCommand` 不一致** | 統一成 `toUpdateCommand`，並補上理由：同類別已有 `toCommand(CreateOrderRequest, …)`，而**「參數型別相近的多載」會把 3.4.2 形狀 2 變成「呼叫錯方法」** |
| **`OrderSnapshotCodec` 是欄位最多的 mapper（41 個）卻必須手寫** | 「欄位多 → 用 MapStruct」這條判準在它身上不適用（它要呼叫 private 建構子）。→ 明確寫出「所以它需要別的守門人」，並把判準收回到 **「漏欄位誰會告訴我」而不是「用哪個工具」** |

⚠️ **第一項與第二項是這一輪最有價值的兩個，而它們的性質完全不同**：
第一項是**機械錯誤**（可以完全自動化偵測）；
第二項是**定義缺失** —— 三個數字各自都「說得通」，
只有把它們並排才看得出來不一致。
👉 **而那正是為什麼「回頭修正的總表」值得存在**（3.10.1、3.10.3）。

⚠️ **這一輪同樣沒有編譯執行。** 03 章有兩處特別依賴版本行為，
已在 3.14 的結尾明確標出：**MapStruct 的 `@Context` + `expression`**
（1.5.x 與 1.6.x 對 record 的處理有差異）、
以及 **`JsonNullable<@NotNull String>` 的 `ValueExtractor` 註冊**。
👉 **練習 3 的第 3 個測試請真的跑一次。**

### ⑨ 00～03 章的連貫性稽核（跨章）

前八輪複查都是「單章寫完後查自己」。**這一輪查的是四章之間的接縫。**
它抓到的東西與前幾輪性質不同 —— **單看任何一章都是對的，只有並排才看得出來。**

**Ⓐ 章號歧義：一個「以為修完了」的問題** 🔴

README 上面寫著「全書 ~180 處跨站引用改成 `04-controller X.Y`」。
⚠️ **那次只修了「帶小節號」的引用，裸章號一處都沒動。**

| | 數量 | 狀態 |
|---|---|---|
| `04-controller 3.5.2`（帶小節號） | ~180 | ✅ 上一輪修完 |
| **`04 章`（裸章號）** | **86** | 🔴 **完全沒修** |

而本站**也有** 04 章（業務例外設計），所以這 86 處全部有歧義。
最糟的一句在 00 章 3707 行：

```
而 04 章的例外設計（本站 04 章會擴充）讓 Service 只需要：
      ↑ 04-controller          ↑ 05-service      —— 同一句話裡兩個不同的「04 章」
```

**另外 13 處是上一輪 sed 的殘留，直接壞掉**：

| 壞掉的寫法 | 應該是 |
|---|---|
| `（04 章 7 章的核心思想）` | `04-controller 07 章` |
| `04 章 06 章 4804 行定義了 OrderStatus` | `04-controller 06 章`（而且「4804 行」是一個會過期的引用，已刪） |
| `…（04 章的 04 章會整理成完整階層）` | 本站 04 章 |
| `04 章 04-controller 7.9.5`（重複前綴）× 3 | `04-controller 7.9.5` |
| `04 章 03 章的 ErrorCode` × 2 | `04-controller 03 章` |
| `04 章 05 章明確說它是「靜態工具」` | `04-controller 05 章` |

**處置**：13 處壞掉的逐一修正；剩餘 71 處按語意分類後
**61 處**加上 `04-controller 站` 前綴，**15 處**確認是本站 04 章而保留
（其中 3 處補上「**本站** 04 章」讓它明確）。

⚠️ **轉換過程本身踩到一個坑，值得記下來**：
機械替換 `04 章 → 04-controller` 誤傷了 01 章 49 行的
`[02-spring-boot/](../02-spring-boot/) 01 章（IoC 與 DI）與 04 章（AOP 與代理）`
—— 那個「04 章」是 **02-spring-boot 站的** 04 章。
👉 **教訓：這類引用不可能純機械修**，一定要先分類再轉換。

**Ⓑ 03 章用到但不存在的成員（六個）** 🔴🔴

**這是這一輪最有價值的一組** —— 它與 04-controller 三輪複查的第一條教訓
（「被 `new` 出來但沒有定義的型別」）是同一類，而這次是**方法與欄位**層級。

| 問題 | 後果 | 修法 |
|---|---|---|
| 🔴🔴 **`Order.customerNote` 與 `invoice` 在 00 章 0.9.2 是 `final`** | 3.6.5 的 `changeCustomerNote()` / `changeInvoice()` **編譯不過**（`cannot assign a value to final variable`） | 新增 **3.10.3 ⑧**：拿掉 `final`，並說明「**這不是 00 章的 bug，而是 `final` 是一個會被後續需求推翻的決定**」 |
| 🔴 **`Order.internalNote` 從未定義** —— 而 3.6／3.7 整整兩節建立在它上面 | 同上 | 3.10.3 ⑧ 補上，並列出它連帶影響的**四個已存在的守門測試** |
| `invoiceIssuedAt` / `invoiceRequestSubmitted` / `MAX_NOTE_LENGTH` 未定義 | 同上 | 同上 |
| **`Cancellation` 的第一個欄位**：00 章是 `cancelledBy`，我在 3.10.3 ④ 寫成 `by` | 靜默改了欄位名，而 `OrderSnapshotCodec` 與所有呼叫端都會斷 | 改回 `cancelledBy`，並補回 00 章原有的三個 `requireNonNull` |
| **`c.cancelledByType()` / `c.reasonLabel()` / `c.note()` 三個方法都不存在** | 3.7.3 的 `toCancellation` 編譯不過 | 給出 `OrderDetailView.Cancellation` 的正式形狀，並與 3.12 練習 2 的定義對齊 |
| **`Actor.hasRole(Role.PRODUCT_MANAGER)`** —— `Actor` 是 `record Actor(ActorType, String, String)`，**沒有 `hasRole()`，也沒有 `Role` enum** | 練習 3 的答案編譯不過 | 改用 `actor.type() != ActorType.ADMIN`，並把「沒有 PRODUCT_MANAGER 這個角色」明確寫成一個已知缺口 |
| **`InternalOnlyDto` 被用在 4 處但從未宣告** | ArchUnit 規則與掃描測試都編譯不過 | 補上定義，並說明**為什麼需要兩個標記介面**（`InternalOnlyView` 在 application 層、`InternalOnlyDto` 在 web 層） |

**Ⓒ 修正表漏列的一項**

3.10.3 ① 把 `create()` 的回傳型別從 `Order` 改成 `OrderResultView`，
⚠️ **但 `cancel()` 有一模一樣的問題而沒有被列進去**
（00／01 章共 6 處 `CancellationResult cancel(CancelOrderCommand)`）。

👉 新增 **3.10.3 ⑨**，並順手處理三個「只有名字、沒有形狀」的型別：
`CancellationResultView.from` 的真實簽章（它需要**兩個**輸入）、
`PaymentResultView`、`ShipmentResultView`。

**Ⓓ 02 章與 03 章的一個直接矛盾**

| 02 章 2.14.1 ⑤ 說 | 03 章 3.6.6 ④ 說 |
|---|---|
| `Order.changeShippingAddress(**patch**, actor, now)` | `shippingAddressId` **不需要三態**（地址必填，I2） |

**兩者不可能都對。** 03 章 3.6.6 ④ 已加入裁決：
簽章改成 `changeShippingAddress(ShippingAddress address, Actor actor, Instant now)`，
理由是「改地址要同時換 `ShippingSnapshot`，所以它收的是地址而不是 id」。

**Ⓔ 一個結構性的缺口：沒有前向指標** ✅ 已修

**後面的章節修正前面的，但前面的章節原本沒有任何「前向指標」。**

```
02 章 2.14.1 修正了 00／01 章四處  → 00／01 章裡【0 處】提到 2.14.1
03 章 3.10.3 修正了 00～02 章九處  → 00～02 章裡【0 處】提到 3.10.3
```

**後果很具體**：一個讀者停在 01 章 1.8.2，會讀到

> \| **Domain 物件** \| 呼叫端需要完整的狀態（Web 層要轉多種 DTO） \| `Order create(...)` \|

而 03 章 3.3.3 論證的正是**「Web 層要轉多種 DTO」這件事本身就不該發生**。
**讀者沒有任何線索知道這個結論後來被推翻了。**

| 選項 | 代價 |
|---|---|
| ① 在每個被修正的位置加一行警告 | ⚠️ 要動 00～02 章約 40 處；每次新章節都要再動一輪 |
| ② **只在「結論性」的位置加** | ✅ **採用** —— 約 13 處，覆蓋 90% 的誤讀風險 |
| ③ 維持現狀，只靠 README 的修正總表 | 🔴 讀者不會在讀 01 章時去翻 README |

**實際加了 19 處**（比預估的 13 處多，因為 `Cancellation` 與 `Order` 的欄位宣告
也算結論性 —— 它們是「型別的定義」，比散文更容易被當成最終答案）：

| 位置 | 指向 | 內容 |
|---|---|---|
| 00 章 0.9.2 `Order` 的 `final` 欄位 | 03 章 3.10.3 ⑧ | ⚠️ 這兩個欄位會拿掉 `final`；**並說明「現在是 `final` 是對的」** |
| 00 章 0.9.2 `status` 欄位區塊 | 02 章 2.14.1 ④ | 會補 `version` |
| 00 章 0.9.4 `create()` 簽章 | 03 章 3.10.3 ① | 回傳型別會改成 `OrderResultView` |
| 00 章 0.9.4 取商品那一步 | 02 章 2.14.1 ① | 會加 `.sorted()` —— **固定鎖順序** |
| 00 章 0.12 ③ `Cancellation` | 03 章 3.10.3 ④ | `note` 會拆成兩個欄位 |
| 00 章 0.12 ⑩ `StockPort` | 02 章 2.14.1 ③ | 會補 `findByProductIdForUpdate` |
| **01 章 1.8.2 的表** | 03 章 3.3.3 | ★ **加了一整段對照表**，說明「第一列被推翻，但 `void`／`boolean` 那兩段不受影響」 |
| 01 章 1.2.5 載入器 | 02 章 2.14.1 ① | 載入器的順序影響併發正確性 |
| 01 章 1.9.2 `search(…, Locale)` | 03 章 3.10.3 ② | 🔴 這個參數是一個錯誤 |
| 01 章 1.2.2 `cancel()` | 03 章 3.10.3 ⑨ | 回傳型別會改 |
| 02 章 2.14.1 ⑤ `changeShippingAddress` | 03 章 3.6.6 ④ | 簽章被改掉 |

⚠️ **一個刻意的取捨**：前向指標寫成**註解**（在程式碼裡）或**引用區塊**（在散文裡），
而**不是**改掉原本的內容。
理由與整站的慣例一致：**「先看見痛，再給解法」需要痛留在原處。**
如果 00 章直接寫成最終答案，讀者就學不到「為什麼 `final` 是一個會被推翻的決定」。

**Ⓕ 一個「假修正」——比漏掉更危險** 🔴

初稿的 3.10.3 ⑤ 寫著「`Payment.refunds()` 要補 `List.copyOf`」。
⚠️ **而 00 章 0.12 ③ 本來就寫對了**：

```java
public List<Refund> refunds() { return List.copyOf(refunds); }   // ★ 00 章原文
```

**這是一個「推理正確但事實記錯」的典型**：
「`List.copyOf` 只做一層」是對的，
但由此推論「所以 00 章漏了 `Payment.refunds()`」是錯的。

⚠️⚠️ **而它比單純漏掉更危險**，因為它讓人以為洞補好了 ——
**真正的洞在別的地方**：

```java
// Payment 有一個 public mutator，而 List.copyOf 是淺拷貝 → 元素是同一個物件
order.payments().get(0).refund(new Refund(...));
```

| 哪一道防線 | 有沒有跑 |
|---|---|
| `Payment.refund()` 自己的檢查（單筆退款 ≤ 單筆付款） | ✅ |
| **`Order.assertInvariants()` 的 I8**（跨所有付款） | 🔴 **完全沒跑** |

**而兩者不等價**：`paidAmount()` 只加總 `SUCCEEDED`，
`refundedAmount()` 加總**所有**付款（含 `ORPHANED`）的退款。

👉 **處置**：3.5.3 邊界 2 整段重寫（給出真實的繞過路徑與三個選項的取捨），
3.10.3 ⑤ 改名成「集合 accessor 的守門測試（**這一項不是修正**）」，
並**誠實寫出「守門測試沒有真的關上這個洞」** ——
它只能抓「新增一個回傳可變集合的 accessor」，
**抓不到「元素有 mutator」**。

---

