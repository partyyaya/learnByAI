# 05 — Service（商業邏輯層）

> Service 是整個系統的心臟：訂單能不能成立、庫存怎麼扣、錢怎麼算，都在這一層。
> 這也是唯一應該決定「交易邊界」的地方 —— `@Transactional` 放錯位置造成的資料不一致，比效能問題難查十倍。

---

## 學完你可以

- 說明 Service 層的三個職責（編排、交易邊界、守護不變量），以及什麼邏輯應該再往下抽成領域物件。
- 分辨貧血模型與充血模型，並說出貧血模型的**四個可量化代價**。
- 列出系統的**不變量清單**，並判斷每一條該守在哪一層（Web 驗證 / Domain / 原子 SQL / 資料庫約束）。
- 說明為什麼「在 Service 裡 if 一下」在併發下必然失效。
- 判斷一個 Service 該多大、要不要介面、能不能呼叫另一個 Service，並說出每個決定的代價。
- 讀懂 Spring 的循環依賴錯誤訊息，並用六種方式解它。
- 正確使用 `@Transactional`：傳播行為、唯讀最佳化、什麼例外才會 rollback。
- 診斷**五種**交易失效情境（自呼叫、非 public / final / static、非 Spring 管理的物件、
  換了執行緒、例外被 catch 掉），每一種都能寫出一個會紅燈的測試。
- 設計 DTO ↔ Entity 轉換策略，避免 Entity 洩漏到 API 層。
- 設計分層的業務例外體系，讓 Controller 只需要對應狀態碼。
- 用**「誰能修好它」**這個判準決定一個失敗該是 4xx 還是 500，並說出 `IllegalStateException` 為什麼刻意不是業務例外。
- 處理**「同一個例外要對應兩個狀態碼」**，並說出為什麼「在 advice 裡讀 `Actor`」是錯的。
- 說明 `@Cacheable` 與 `@Transactional` **共用哪些失效情境**，以及**在哪一點不同**。
- 解釋為什麼「在交易裡呼叫 `@Cacheable` 方法」會讓**未提交的值永久留在快取裡**。
- 分辨**擊穿、雪崩、穿透**，並說出各自的解法與實測數字。
- 判斷什麼**不該**快取，以及為什麼「授權」與「快取」在同一個方法上不相容。
- 說出執行緒池的 `core` / `queue` / `max` **成長順序**，以及為什麼 Boot 的預設值讓 `maxPoolSize` **完全沒有作用**。
- 列出 `@Async` 之後**會消失的四個 ThreadLocal**，並說出「locale 變成錯的值」為什麼比「變成 null」糟。
- 設定 `RestClient` 的**四個層次的逾時**，並說出「只設 read timeout」擋不住哪兩種慢。
- 用「**對方處理了嗎**」把失敗分成 A/B/C 三類，並據此決定「重試」還是「查詢」。
- 說明 outbox 把「事件遺失」換成了什麼，以及它**真正的成本**（每個消費者都要冪等）。
- 用 Mockito 寫出不碰資料庫的商業邏輯單元測試，並知道什麼時候必須用真的資料庫。
- 說出 `@InjectMocks`、`ArgumentCaptor`、`any()` 三個工具**各自會靜默出錯的地方**。
- 分辨 **fake 與 mock**，並用**契約測試**保證 fake 沒有變成「與現實不同的世界」。
- 讀懂一份**突變測試**報告，並說出為什麼 100% 的覆蓋率仍可能漏掉 `>=` 與 `>` 的差別。
- 分辨**「探針」與「測試」**，並知道為什麼一條從來沒紅過的守門測試等於沒有。
- 讓「漏映射一個欄位」「洩漏敏感欄位」「PATCH 漏處理清空」從**靜默的 bug** 變成**編譯錯誤或 CI 紅燈**。

## 前置知識

[02-spring-boot/](../02-spring-boot/) 01、04 章（DI 與 AOP 代理），[04-controller/](../04-controller/) 全部。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [00-course-map-business-layer-role.md](./00-course-map-business-layer-role.md) ✅ | 課程地圖與商業邏輯層定位 | 2,000 行 `OrderServiceImpl` 的**六個真實事故**、貧血 vs 充血、**`Money` 值物件與 `allocate()`**、四層職責、**邏輯歸屬的七個判準**、**11 條不變量與「守在四個位置」**、`Order` 聚合與狀態機、不該做的九件事、**ArchUnit 六組守門規則** |
| 01 | [01-service-design-and-dependency.md](./01-service-design-and-dependency.md) ✅ | Service 設計與依賴管理 | 「14 個依賴」怎麼分析、讀寫分離、載入器與工廠、**介面 vs 實作（六個理由四個已失效）**、`@Value` vs `@ConfigurationProperties`、**把不確定性注入進來**、多實作的四種做法、**Service 之間的界線與五種解耦手段**、**循環依賴的六種解法**、埠與轉接器、方法簽章 |
| 02 | [02-transaction-management-in-depth.md](./02-transaction-management-in-depth.md) ✅ | 交易管理（**核心章**） | 一個 `@Transactional` 的 **15 個步驟**、交易與 ThreadLocal、**7 種傳播行為的完整矩陣**（含可執行的實驗）、MySQL 的 RR 與快照讀/當前讀、**`timeout` 不是方法逾時**、rollback 規則、**五種失效情境**、`UnexpectedRollbackException`、**交易長度 × 連線池 = TPS 上限**、`TransactionTemplate` 縮短鎖持有時間、**悲觀鎖 / 樂觀鎖 / 原子 UPDATE 的決策表**、寫偏斜、死鎖與固定鎖順序、`@TransactionalEventListener` 的四個 phase 與 `AFTER_COMMIT` 三陷阱、診斷 |
| 03 | [03-dto-entity-mapping.md](./03-dto-entity-mapping.md) ✅ | 資料轉換 | 三個事故（**客戶看到客服評語**、日本站被當台幣、`@JsonIgnore` 讓退款消失）、**不回傳 Entity 的六個代價**、黑名單 vs 白名單、mass assignment、**三種轉換策略與「重新檢視 00 章 0.14.1」**、`OrderResultView`、**漏映射的三種形狀**、`BeanUtils`/`ModelMapper` 為何更糟、MapStruct 與 `unmappedTargetPolicy = ERROR`、**`List.copyOf` 的三個邊界**、串流匯出、**`Patch<T>` sealed interface 與 PATCH 三態**、欄位級權限、**三種角色可見性防護 + 掃描測試**、`MappingCompleteness`、**`open-in-view` 的四個問題** |
| 04 | [04-business-exception-design.md](./04-business-exception-design.md) ✅ | 業務例外設計 | 三個事故（**500 讓客戶重複下單七次**、客服的「系統壞了」、退款靜默失敗三週）、**98 個 `ErrorCode` 的分區守門**、例外階層（**兩層 + 三個標記介面**）、**「誰能修好它」的判準**、`InvariantViolationException`、**41 個業務例外的完整定義**、**一個例外兩個狀態碼**、`MessageFormat` 的五個實測行為、**`args()` 守門人**、`safeToRetryBlindly`、rollback 與例外、**例外成本的實測**、五組守門測試 |
| 05 | [05-caching-in-service-layer.md](./05-caching-in-service-layer.md) ✅ | 服務層快取 | 三個事故（**rollback 後快取有不存在的價格**、兩個方法共用一個快取項目、`allEntries` 清掉 40 萬個項目）、**`@Cacheable` 與 `@Transactional` 的四種失效情境**、**交易裡的 `@Cacheable`（實測：髒值永久留著）**、key 設計的四個陷阱、**授權與快取不相容**、擊穿／雪崩／穿透（**50→1 的實測**）、**三個序列化器全部開箱失敗**、`Money` 無法往返、命中率 99.99% 為什麼是壞消息、**什麼不該快取** |
| 06 | [06-async-and-external-api-calls.md](./06-async-and-external-api-calls.md) ✅ | 非同步與外部呼叫 | 三個事故（**部署丟掉 3,000 封信**、ERP 逾時打成 503、逾時重試**重複扣款**）、**`@Async` 的六個步驟與六種失效**、**Boot 3.2 預設池的 `maxPoolSize` 完全沒作用**（實測）、**成長順序與直覺相反**、拒絕策略、**四個 ThreadLocal 全消失（locale 變成 JVM 預設而非 null）**、**`Future` 沒接住 → 例外完全消失**、graceful shutdown（**0/10 vs 10/10**）、**交易與非同步的四個衝突**、**沒有 `REQUIRES_NEW` 的 `AFTER_COMMIT` 寫入在 H2 上會通過測試**、`RestClient` 的**四個逾時**、**慢慢滴的伺服器 read timeout 不觸發**、逾時 × 重試相乘、**失敗的 A/B/C 三類**、退避與抖動、重試放大與預算、**熔斷三狀態（等待期滿仍是 OPEN）**、**Retry 在熔斷器外層**（實測）、隔艙、**outbox（表、搶單、冪等、三個陷阱）**、領域事件的可靠投遞、Saga 與補償、**四條 ArchUnit + 證明它們會紅燈** |
| 07 | [07-service-testing-with-mockito.md](./07-service-testing-with-mockito.md) ✅ | 商業邏輯測試 | 三個事故（**350 綠燈卻超賣 47 筆**、**captor 讓錯的稽核紀錄「被證明是對的」**、`@InjectMocks` 造成生產 NPE）、**「mock 掉的東西就是沒被測到的東西」**、測試金字塔的**五層具體形狀**、測 Domain 層、**不用 `@InjectMocks` 的三個理由**、strict stubs、**`any()` 匹配 null 而 `anyList()` 不匹配**（實測）、**`ArgumentCaptor` 抓到的是參照不是快照**（實測）、`never()` 的價值、過度驗證、**41 個例外用 5 個測試測完**、**五種測試替身與 fake 的契約測試**、不要 mock 的四種東西、`Clock` / `IdGenerator` / `RandomSource`、**交易測不到的五件事**、**`@SpringBootTest` + `@Transactional` 的假綠燈**、**併發測試（2 執行緒 10/10 重現超賣）**、Test Data Builder、**突變測試（100% 覆蓋率 vs 80% 突變分數）**、**探針不是測試** |

> ⚠️ **與 04-controller 7.18「05-service 的預告」的差異**：
> 那份預告列的是「併發控制」「領域事件」兩個獨立章節。
> 實際編排把**併發控制併入 02 章**（它與交易是同一件事的兩面），
> **領域事件併入 06 章**（它與非同步、外部呼叫共用同一套執行緒與可靠性機制）。
> 內容一項都沒有少，只是章節邊界依「同一個主題不要拆開」重新畫過。

---

## 目前進度

| 章節 | 狀態 | 篇幅 |
|------|------|------|
| 00 課程地圖與商業邏輯層定位 | ✅ 可讀 | 約 6,800 行 |
| 01 Service 設計與依賴管理 | ✅ 可讀 | 約 4,960 行 |
| 02 交易管理（核心章） | ✅ 可讀 | 約 4,570 行 |
| 03 DTO ↔ Entity 轉換 | ✅ 可讀 | 約 5,960 行 |
| 04 業務例外設計 | ✅ 可讀 | 約 7,680 行 |
| 05 服務層快取 | ✅ 可讀 | 約 4,520 行 |
| 06 非同步與外部呼叫 | ✅ 可讀 | 約 4,510 行 |
| 07 Service 層測試 | ✅ 可讀 | 約 3,420 行 |

### ⚠️ 驗證狀態（各章不同）

**這決定你可以多信任裡面的程式碼**：

| 章節 | 狀態 |
|---|---|
| **00～03** | ⚠️ **逐行檢閱，但沒有編譯執行過** —— 抄進專案之前請自己編一次 |
| **04、05** | ✅ **在本機編譯並執行過** |
| **06、07** | ✅ **同上，而且是「先做實驗、再寫章節」** —— 兩章跑了 **43 組實驗**，全站 **147 個測試全綠** |

**基準版本**（全站一致）：
**Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1.6 / Jackson 2.17 /
MapStruct 1.5.5.Final / MySQL 8.0 / Caffeine 3.1.8 / ArchUnit 1.3 / ClassGraph 4.8**。

⚠️ **有兩組測試請真的跑一次：02 章練習 3 與 03 章練習 3。**
這兩章特別依賴「框架與資料庫的具體行為」，而那些行為會隨版本、驅動設定、`sql_mode` 而變。
那兩組「把行為釘住」的特性測試，存在的理由就是取代「相信文件」。

🔴 **全站沒有驗證到的**：真的 Redis、真的 MySQL（併發、鎖、`SKIP LOCKED`）、真的 MQ、
K8s 的關機流程、壓測。**每一章的驗收清單都有自己的「已知缺口」小節** ——
最完整的是 05 章 5.16、06 章 6.16、07 章 7.22。

## 引用慣例（讀之前先看一眼）

這一站與 04-controller **章號完全重疊**（兩邊都有 00～07 章），
所以「06 章 6.5.8」這種寫法有歧義。全站統一成：

| 寫法 | 意思 |
|---|---|
| `0.8.3`、`1.6.4` | **本章**的小節 |
| `00 章 0.8.3`、`01 章 1.6.4` | **本站（05-service）**其他章的小節 |
| `04-controller 3.5.2` | **04-controller 站**的小節（章號由小節的第一碼決定，不寫「章」） |
| `04-controller 站`、`04-controller 07 章` | 指整個站或整章（**沒有**小節號時） |
| `本站 04 章` | 本站的整章 —— **同一段也提到 04-controller 時必須這樣寫** |
| `03-rest-api 第 04 章 4.9` | 更早的站 |

> 📌 **為什麼需要這張表**：
> 這一站會**大量**回頭引用 04-controller 的程式碼
> （`OrderWebMapper`、`ErrorCode`、`Actor`、70 條端點…），
> 而「這個 3.5.2 是哪一站的」讀錯一次就會找不到東西。

---

## 程式碼演進表：如果你做過 04-controller，這些東西變了

**你在 04-controller 寫的程式碼，這一站有 46 處會被改掉。**

> ⚠️ **這一節的前提：它假設你做過 04-controller 站的專案。**
>
> | 你的情況 | 怎麼辦 |
> |---|---|
> | **手上真有那份程式碼** | ✅ 這是你的遷移清單，照「完整說明在」那一欄逐項處理 |
> | **只讀過，沒動手** | 掃過「為什麼」那一欄就好 —— 它是這一站的爭議點索引 |
> | **沒讀過 04-controller** | **整節跳過。** 46 處改動的完整理由都在章節裡，你會在讀到那一節時看到它 |

這不是勘誤，是**設計的演進** —— 04-controller 那些決定在「Service 是 stub」的前提下
是對的，而一旦 Service 變成真的，前提就變了。
（04-controller 的 `allowedActions()` 沒有參數，是因為它回傳假資料；
真的實作起來才發現「這個方法不可能知道呼叫者是誰」。）

> 📌 **這張表本身是一個教學重點，不只是清單**：
> 看「為什麼」那一欄 —— **每一列都是「上游的決定被下游的現實推翻」**。
> 而課程刻意**不回頭改寫前面的章節**，只在原處加一行前向指標，
> 因為「先看見痛，再給解法」需要痛留在原處。

| 改了什麼 | 原本在哪 | 為什麼 | 完整說明在 |
|---|---|---|---|
| `OrderWebMapper` 的 accessor 改成 `xxx()`；`allowedActions(actor, now)`；`statusLabel` 改用 `StatusLabelResolver` | 04-controller 0.10.3 | `Order` 聚合沒有 `getXxx()`，也沒有 `OrderStatus.label()`；而 `allowedActions()` 無參數會讓**客服看到的可執行操作與客戶相同** | 00 章 0.14.1、0.14.4 |
| `CancelReason` 從 `order.service.command` 搬到 `order.domain`，並新增 `PAYMENT_TIMEOUT` | 04-controller 1.12.5 | 它是領域概念，而 `Cancellation` 值物件需要它（domain 不可依賴 command 套件） | 00 章 0.14.2 |
| `order.service` 拆成 `order.application` + `order.domain`（介面與 command 留在原處） | 04-controller 0.11.2 | 交易邊界與規則要分開；但改介面會動到 350 個測試 | 00 章 0.14.3 |
| **`StatusLabelResolver` 新增 `label(Enum<?>, Locale)`** | 04-controller 6.5.8 | 原版讀 `LocaleContextHolder`（ThreadLocal），排程與 `@Async` 會拿到錯的語言 | 00 章 0.14.5 |
| 新增 `Actor.SYSTEM` 與 `Actor.isPrivileged()` | 04-controller 4.13.6 | `ActorType` 有 `SYSTEM` 但 `Actor` 上沒有對應常數；而排程需要它 | 00 章 0.12 ⑫ |
| **`ErrorCode` 從 83 個增為 93 個** | 04-controller 3.4.2 | 本站新增的 10 個業務例外需要對應的 code，否則 3.14.5 的守門測試紅燈 | 00 章 0.12 ⑮ |
| 04-controller 0.10.3 的 mapper 測試 `new OrderWebMapper()` 編譯不過 | 04-controller 0.10.3 | 同一節的正式碼建構子是 `OrderWebMapper(StatusLabelResolver)` | 00 章 0.14.4 |
| ArchUnit 新增「`@Transactional` 方法不可為 `final`」 | 00 章 0.11.2 | CGLIB 無法覆寫 `final` 方法 → **靜默失效** | 01 章 1.3.1 |
| **`create()` 扣庫存前先依 `productId` 排序**（固定鎖順序） | 00 章 0.9.4、01 章 1.2.5 | 兩張訂單含相同商品但順序不同 → **死鎖** | 02 章 2.14.1 ① |
| `OrderNumberGenerator` 的實作（獨立短交易）+「序號會有洞」寫進 javadoc | 00 章 0.12 ⑩ | 用悲觀鎖取號會把下單序列化成 125 TPS | 02 章 2.11.4、2.14.1 ② |
| `StockPort` 補 `findByProductIdForUpdate` | 00 章 0.12 ⑩ | 盤點調整需要「讀與寫之間做複雜判斷」 | 02 章 2.14.1 ③ |
| `Order` 補 `version` 欄位（樂觀鎖 / ETag） | 00 章 0.9.2 | 離線編輯與 412 需要它 | 02 章 2.14.1 ④ |
| **`OrderApplicationService` 回傳 `OrderResultView` 而不是 `Order`** | 00 章 0.9.4、01 章 1.8.2、04-controller 0.10.2 | 聚合離開交易 → `LazyInitializationException`；而 `allowedActions` 的**授權判斷**跑到了 Web 層 | 03 章 3.3.3、3.10.3 ① |
| **`OrderWebMapper.toCreateResponse` 從四參數變兩參數** | 00 章 0.14.1 | `actor` 與 `now` 是業務輸入，不屬於 mapper；而「需要三個上下文的元件會在上下文不足的地方被繞過」 | 03 章 3.3.3 |
| **`OrderQueryService` 的 `Locale` 參數移除** | 01 章 1.9.2 | 🔴 01 章的真實錯誤：Application 層不該認識展示層。`statusLabel` 改由 Web 層加上，並用一條掃描測試守「每個 enum 欄位都有對應的 label 欄位」 | 03 章 3.10.3 ② |
| `UpdateOrderCommand` 的 builder 改成 `Patch<T>` | 04-controller 1.6.4 | 🔴 原本的寫法讓「**清空**」這個操作完全消失（三態裡有兩態是對的，所以功能看起來是好的） | 03 章 3.6.2、3.6.4 |
| `Order.clearInvoice()` 改名 `resetInvoiceToPersonal()` | 03 章 3.6.5 | 它的實際行為是「改成個人發票」而不是「設成 null」，而兩者在開票時是決定性的差別 | 03 章 3.10.3 ③ |
| **`Cancellation.note` 拆成 `customerNote` + `staffNote`** | 00 章 0.12 ③ | 🔴 一個欄位的語意取決於「誰填的」→ 客戶查自己的訂單會看到客服的評語 | 03 章 3.7.3、3.10.3 ④ |
| 新增「聚合的集合 accessor 都不可變」守門測試 | 00 章 0.9.2 | `List.copyOf(payments)` 是**淺拷貝** → `order.payments().get(0).refund(...)` 會繞過 `Order` 的不變量 I8。⚠️ 而守門測試**只能抓「回傳可變集合」，抓不到「元素有 mutator」** | 03 章 3.5.3、3.10.3 ⑤ |
| **`ErrorCode` 從 93 個增為 97 個** | 00 章 0.12 ⑮ | 每一個「Domain 層的最後一道防線」都需要自己的 code，否則被觸發時會 fallthrough 成 500 | 03 章 3.10.3 ⑦ |
| `spring.jpa.open-in-view` 明確設成 `false` | — | 它最嚴重的後果不是效能，是**讓「回傳 Entity」變得沒有痛感** | 03 章 3.9.4 |
| `/api/orders/support/{id}` 改成 `/api/support/orders/{id}` | 04-controller 1.4.3 | 原本的路徑會與 `@GetMapping("/{orderId}")` 競爭（`orderId = "support"`）。Spring 選了更具體的那一個，所以它**剛好正確** —— 但那是運氣 | 03 章 3.12 練習 2 |
| 🔴 **`OrderStatus.COMPLETED` 不存在**（`COMPLETED` 是 `OrderStatus.Category` 的常數） | 04-controller 3.5.3 例子 2 | **編譯不過**。三輪人工複查沒抓到，`javac` 第一次就抓到 | 04 章 4.13.1 ① |
| 例外的套件從 `order.service.exception` 搬到 `order.domain.exception` / `order.application.exception` | 04-controller 3.5.3 | `order.service` 在 00 章 0.14.3 已經拆掉了 —— **那個套件不存在** | 04 章 4.3.7、4.13.1 ③ |
| **`ErrorCode` 從 97 個增為 98 個**，並**重排分區** | 00 章 0.12 ⑮、03 章 3.10.3 ⑦ | 🔴 03 章引用了一個**從來沒被定義**的 `ORDER_INVOICE_ALREADY_ISSUED`；而 14 個新 code 被 append 在最後 → 403／409／422 三區被切開 | 04 章 4.2.3、4.2.4 |
| **`Problem` 新增 `safeToRetryBlindly`；`ErrorCode` 新增同名方法** | 04-controller 3.4.2、3.6.2 | 🔴 `retryable()` 把 `CHECK_STATUS` 也算成 `true` → 前端盲重試 → **重複扣款**（04 章事故 1） | 04 章 4.9.1 |
| **`ProblemFactory` 新增 `normalizeArgs()`** | 04-controller 3.6.3 | 🔴 `Instant` 直接當訊息參數 → 使用者看到 `2026-08-27T08:00:00Z`（而且是 UTC，差 8 小時） | 04 章 4.8.3 |
| **`BusinessException` 新增 `args(...)` 守門工廠** | 04-controller 3.5.2 | 🔴 四個例外自己呼叫 `toPlainString()` → `ProblemFactory` 的格式化全部失效 | 04 章 4.8.7 |
| `Order.assertInvariants()` 的 11 條改拋 `InvariantViolationException` | 00 章 0.9.2 | `IllegalStateException` 無法告警、無法查詢；而它與 JDK／框架拋的混在一起 | 04 章 4.4.4 |
| **`REFUND_REJECTED` 的 `Retry.MODIFY_REQUEST` 拿掉** | 00 章 0.12 ⑮ | 原卡註銷，「改請求內容再送」對它沒有意義 | 04 章 4.9.3 |
| 🔴 **02 章 2.7.2 的 `publicMethodsOnly` 說法是錯的** | 02 章 2.7.2 | 實測：Spring 6.1 的 `ProxyTransactionManagementConfiguration` 明確傳 `false` → **`package-private` 的 `@Transactional` 會生效** | 05 章 5.2.3、5.13 ① |
| 🔴 **`Money` 無法通過 Jackson 往返** | 00 章 0.9.1 | `isZero()`／`isPositive()`／`isNegative()` 被當成 getter → 序列化 5 個欄位而建構子只認得 2 個。⚠️ API 上沒事（金額是 `String`），**快取上會出事** | 05 章 5.8.3、5.13 ② |
| `@EnableCaching` 與 `@EnableTransactionManagement` 明確設 `order` | — | 兩者預設都是 `LOWEST_PRECEDENCE` → **誰在外層是未定義的** | 05 章 5.2.2 |
| **`ProblemFactory` 不需要再加一層快取** | 04 章 4.17 的預告 | ✅ `ResourceBundleMessageSource` 的 `cacheMillis` 預設是 `-1`（永久） | 05 章 5.13 ④ |
| **`@EnableAsync` 明確設 `order = HIGHEST_PRECEDENCE`** | — | 預設是 `LOWEST_PRECEDENCE`（最內層）→ 🔴 **換執行緒發生在開交易之後，方向反了** | 06 章 6.3.2 |
| **`ErpAdapter`：加四個逾時、拿掉 `@Retryable`、改走 outbox** | 00 章 0.10.10 | 🔴 事故 2：沒有逾時 + 重試 3 次 → 一個請求佔住連線 18 秒 → **整站 503** | 06 章 6.0 事故 2、6.5.5 |
| **`TapPayGateway` 的 `ResourceAccessException` 要分成兩類** | 01 章 1.7.3 | 🔴 「連不上」（可重試）與「等不到回應」（**不可重試**）是**同一個例外型別**，而 `@Retryable` 一視同仁 → **重複扣款** | 06 章 6.6.1 |
| 🔴 **`OrderNotificationListener` 改走 outbox** | 01 章 1.6.3 | 00 章 0.3.1 把通知歸類為「可以遺失」——**事故 1 推翻了它**。判準改成「遺失的話**誰會發現、補救多少錢**」 | 06 章 6.8.6、6.13 ④ |
| `OrderCacheListener` 改成 `@Async("cacheEvictExecutor")` | 05 章 5.3.5 解法 A | 原版是同步的 → 清快取的 Redis 往返加在請求上 | 06 章 6.13 ③ |
| **`DomainEventPublisher` 的實作換成 `RoutingDomainEventPublisher`** + 新增 `ReliablyDelivered` | 00 章 0.12 ⑬ | `@TransactionalEventListener` **有五種遺失方式**（02 章說了三種，06 章實測補上兩種） | 06 章 6.9.1 |
| **02 章 2.12.2 的守門從「dev 才拋」改成「永遠拋」** | 02 章 2.12.2 | 有了 outbox 之後，「沒有交易時發事件」的後果從「事件遺失」升級成**「outbox 與業務資料不再原子」** | 06 章 6.9.1 |
| **00 章 0.11.3 的 yaml 三處改動** | 00 章 0.11.3 | 新增 `cache-evict` 池、新增 `await-termination`（事故 1）、`rejection-policy` **只留兩個合法值**（`DISCARD` 從型別裡拿掉） | 06 章 6.2.9 |
| **05 章缺口 7 的答案是「限流」而不只是「熔斷」** | 05 章 5.16 缺口 7 | 🔴 熔斷保護的是**我們**，限流保護的是**下游** —— 原本的「限流／熔斷」那個斜線掩蓋了這個區分 | 06 章 6.13 ① |
| 🔴 **`Money` 的序列化問題要修第二次**（outbox 的 `ObjectMapper`） | 05 章 5.13 ② | 同一個 `IS_GETTER=NONE` 的修法要做兩次 → 加一條「**每個 `ObjectMapper` bean 都要能讓 `Money` 往返**」的掃描測試 | 06 章 6.13 ② |
| 🔴 **所有 `@InjectMocks` 改成建構子；測試類別上的 `@Transactional` 全部拿掉** | （測試） | ① `@InjectMocks` 少一個依賴時**塞 null 不報錯** ② 測試上的 `@Transactional` 讓 **`AFTER_COMMIT` 的 listener 一個都不跑** | 07 章 7.3.3、7.11.2 |
| **06 章 6.11.3 的全域 `SyncTaskExecutor` 改成只換 `cacheEvictExecutor`** | 06 章 6.11.3 | 🔴 它讓 06 章 6.3.3 那個「非同步看不到未提交資料」的 bug **變成綠燈** | 07 章 7.13.3 |

⚠️ **有兩列值得單獨挑出來看，因為它們是「原本的程式碼會靜默出錯」**：

| | |
|---|---|
| `UpdateOrderCommand` 的 builder → `Patch<T>` | 🔴 原本的寫法讓「**清空一個欄位**」完全失效。三態裡有兩態是對的，所以功能**看起來是好的** —— 而 QA 的測試案例通常是「改成 A」「改成 B」，很少有「改成空的」 |
| `Cancellation.note` 拆成兩個欄位 | 🔴 客服填的取消備註，**客戶查自己的訂單時看得到** |

> 📌 **這一站反覆在做同一件事**：
> 把「靜默出錯」換成「編譯錯誤」或「CI 紅燈」。
> 上面兩列是「為什麼值得這樣做」的最好例子 ——
> 它們都不是「寫錯了」，而是「**寫的時候沒有任何東西會告訴你**」。

---

## 常見誤區（課程會逐一破解）

**每一條後面的括號，是它的完整說明在哪一章／哪一節** —— 這一節可以當索引用。

- `@Transactional` 加在 private 方法或同類別自呼叫上 —— 完全沒生效，出錯也不 rollback（02 章）。
- 交易裡呼叫外部 API，對方逾時 30 秒，資料庫連線被卡住整池耗盡（00 章 0.3.2 事故 1）。
- 寄信成功、訂單回滾 —— 客戶收到一封「不存在的訂單」的確認信（00 章 0.3.2 事故 2）。
- **先 `SELECT` 查庫存再 `UPDATE` 扣減** —— 促銷第一分鐘超賣 47 筆（00 章 0.3.2 事故 3）。
- 金額計算漏了 `setScale` —— 一年後財務發現對帳差 3,000 元，查不出是哪幾筆（00 章 0.3.2 事故 4）。
- 稽核紀錄用 `toJson(order)` —— 順便把全部客戶的地址電話存進一張沒有遮蔽的表（00 章 0.3.2 事故 6）。
- 拋 `Exception`（checked）以為會 rollback，實際上預設只對 `RuntimeException` 生效（02 章）。
- Entity 直接回傳給前端，一改欄位就破壞 API，還順便外洩敏感欄位（03 章 3.2）。
- 用了 DTO 但用 `BeanUtils.copyProperties` 映射 —— **付了 DTO 的成本卻沒得到它的安全性**，而且對 record 完全無效且不拋例外（03 章 3.4.3）。
- **`PATCH` 送 `null` 想清空欄位，結果什麼都沒發生** —— 三態裡有兩態是對的，所以功能看起來是好的（03 章 3.6.2）。
- `@Masked` 以為就不會外洩，但 `log.info("{}", dto)` 印出完整值（03 章 3.7.4）。
- `spring.jpa.open-in-view` 留著預設的 `true`，於是「回傳 Entity」再也不會痛（03 章 3.9.4）。
- **`allow-circular-references: true`** 讓應用啟動了，但 `@Transactional` 靜默失效（01 章 1.6.2）。
- 「每個 Service 都配一個介面」—— 而那六個理由裡有四個在 Boot 2.0 之後已經不成立（01 章 1.3）。
- **業務失敗拋 `IllegalStateException`** → 500 → 前端自動重試 → **同一張訂單成立七次**（04 章事故 1）。
- 把**使用者訊息**寫進例外裡 —— 不能 i18n、改一個字要改 17 個測試（04 章 4.5.2）。
- `extensions` 裡放整個 `Order` → 序列化時 `LazyInitializationException` **在 advice 裡**拋出 → 回應變 HTML（04 章 4.5.4）。
- 以為只有 `extensions` 會洩漏 —— ⚠️ **`Problem` 的四個文字欄位在 4xx 時全部會回給客戶端**（04 章 4.5.5）。
- 在 advice 裡讀 `Actor` 決定狀態碼 —— 狀態碼的來源從一個變成兩個，契約測試、API 文件、告警規則同時失效（04 章 4.7.3）。
- `Instant` 直接當訊息參數 → 使用者看到 `2026-08-27T08:00:00Z`，而且時區差 8 小時（04 章 4.8.3）。
- 以為 `retryable: true` 就能重試 —— ⚠️ **`CHECK_STATUS` 的 `retryable` 也是 `true`**，而它的意思是「不要重試，去查狀態」（04 章 4.9.1）。
- **在交易裡呼叫 `@Cacheable` 方法** → 未提交的值進快取 → rollback 之後**它永久留著**（05 章 5.3.3 實測）。
- 兩個方法共用一個 `cacheNames` → `SimpleKeyGenerator` **不把「哪個方法」放進 key** → `ClassCastException`，或**看到別人的資料**（05 章 5.4.2）。
- **快取一個做授權的方法** —— 命中時方法完全不執行，**授權檢查被跳過**（05 章 5.4.4）。
- 加 `unless = "#result == null"` 省記憶體 —— 它把**穿透保護**關掉了（05 章 5.7.3）。
- 沒有 `CacheErrorHandler` —— Redis 掛掉 = **所有讀取 500**（05 章 5.7.2）。
- 快取加了沒設過期，資料改了畫面永遠是舊的（05 章 5.3.5）。
- **快取庫存** —— 它把「幾毫秒的縫」變成「30 秒的縫」→ 超賣是必然的（05 章 5.10.1）。
- **`@Async` 自呼叫** —— 它不是「沒有非同步」，是**同步執行了**（06 章實測 `[A3]`）。
- 設了 `spring.task.execution.pool.max-size` 就以為有上限 —— 🔴 **沒同時設 `queue-capacity` 的話它完全沒作用**（06 章 6.2.4）。
- 以為 `@Async` 之後 locale 是 `null` —— 🔴 **它是 JVM 預設值**，於是日本客戶收到中文信（06 章 6.2.6）。
- 把 `@Async` 改成回傳 `CompletableFuture` 以為更安全 —— 🔴 **呼叫端不接的話，例外連 log 都沒有**（06 章 6.2.7）。
- **部署時執行緒池佇列被丟掉** —— `waitForTasksToCompleteOnShutdown` 預設是 `false`（06 章事故 1）。
- **`AFTER_COMMIT` 裡寫資料庫不加 `REQUIRES_NEW`** —— 🔴🔴 **它在 H2 上會通過測試**（06 章 6.3.5）。
- **`RestClient.builder()` 不設逾時** —— 🔴 沒有讀取逾時，它會一直等下去（06 章 6.5.2）。
- 以為 read timeout 管的是「整個回應」—— 🔴 它管的是**兩個 byte 之間**（06 章 6.5.3）。
- **把「讀取逾時」當成失敗然後重試** —— 🔴 重複扣款（06 章事故 3）。它是「不知道」。
- **業務失敗（卡片被拒）觸發熔斷** —— 🔴 情人節當天，卡片正常的人也不能付款（06 章 6.7.6）。
- 以為 outbox 只是「加一張表」—— 🔴 真正的成本是**每個消費者都要改成冪等**（06 章 6.8.4）。
- **用 `@InjectMocks`** —— 少一個依賴時它塞 `null` 而不報錯（07 章事故 3）。
- 以為 `ArgumentCaptor` 抓到的是快照 —— 🔴 **它抓到的是參照**（07 章事故 2）。
- **`@SpringBootTest` + `@Transactional`** —— 🔴 測試結束自動 rollback → **`AFTER_COMMIT` 的 listener 一個都不會跑**（07 章 7.11.2）。
- 只看行覆蓋率 —— 🔴 **100% 覆蓋率仍然漏掉 `>=` 與 `>` 的差別**（07 章 7.16.2，突變分數只有 80%）。
- **「併發測試偶爾紅，所以我們關掉了」** —— 🔴 那個偶爾紅**就是它在工作**（07 章 7.12.4）。

---

## 產出

把 04-controller 留下的介面全部實作完成：訂單成立、庫存扣減、金額計算、狀態流轉，
含交易邊界標註、業務例外體系與完整 Mockito 測試。

**此時系統已可端到端跑通** —— 從 `POST /orders` 進去，穿過驗證、Service、交易邊界，
到 Repository（**先用記憶體假實作**），再原路回來變成 201。
真的 SQL 是下一站（[06-repository/](../06-repository/)）的事。

👉 **逐項的產出清單在 07 章 7.23** —— 那裡列出八章各自交出了什麼，
以及這一站從頭到尾在做的同一件事：**把「靜默的錯誤」換成「編譯錯誤」或「CI 紅燈」。**
