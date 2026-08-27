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
- 解釋自呼叫、非 public 方法、非 Runtime 例外三種交易失效情境的原因與解法。
- 設計 DTO ↔ Entity 轉換策略，避免 Entity 洩漏到 API 層。
- 設計分層的業務例外體系，讓 Controller 只需要對應狀態碼。
- 在 Service 層加上快取、非同步與外部 API 呼叫，並處理逾時與重試。
- 用 Mockito 寫出不碰資料庫的商業邏輯單元測試，並知道什麼時候必須用真的資料庫。
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
| 04 | `04-business-exception-design.md` | 業務例外設計 | 例外階層、錯誤碼與訊息、可預期 vs 不可預期錯誤、與 Controller 的對應表 |
| 05 | `05-caching-in-service-layer.md` | 服務層快取 | `@Cacheable` / `@CacheEvict`、Redis 整合、快取一致性、擊穿與雪崩、key 設計 |
| 06 | `06-async-and-external-api-calls.md` | 非同步與外部呼叫 | `@Async` 與執行緒池、`RestClient` / `WebClient`、逾時、重試、熔斷、交易與非同步的衝突、outbox 與 Saga |
| 07 | `07-service-testing-with-mockito.md` | 商業邏輯測試 | Mock Repository、行為驗證、參數捕捉、例外路徑測試、併發測試、什麼時候該用真的資料庫 |

> ⚠️ **與 04-controller 第 04-controller 7.18「05-service 的預告」的差異**：
> 那份預告列的是「併發控制」「領域事件」兩個獨立章節。
> 實際編排把**併發控制併入 02 章**（它與交易是同一件事的兩面），
> **領域事件併入 06 章**（它與非同步、外部呼叫共用同一套執行緒與可靠性機制）。
> 內容一項都沒有少，只是章節邊界依「同一個主題不要拆開」重新畫過。

---

## 目前進度

| 章節 | 狀態 | 篇幅 |
|------|------|------|
| 00 課程地圖與商業邏輯層定位 | ✅ 可讀 | 約 6,790 行 |
| 01 Service 設計與依賴管理 | ✅ 可讀 | 約 4,960 行 |
| 02 交易管理（核心章） | ✅ 可讀 | 約 4,540 行 |
| 03 DTO ↔ Entity 轉換 | ✅ 可讀 | 約 5,960 行 |
| 04 業務例外設計 | ⏳ 未開始 | |
| 05 服務層快取 | ⏳ 未開始 | |
| 06 非同步與外部呼叫 | ⏳ 未開始 | |
| 07 Service 層測試 | ⏳ 未開始 | |

> ⚠️⚠️ **請以你的環境實測為準。**
> 課程中的程式碼、YAML 與設定都經過逐行檢閱，
> 但**尚未在本機編譯執行驗證**（撰稿的機器上沒有 JDK 與 Maven）。
>
> 基準版本延續 04-controller：
> **Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1 / Jackson 2.17 /
> MapStruct 1.5.5.Final / MySQL 8.0 / Testcontainers 1.19 / ArchUnit 1.3**。
>
> 若你的版本不同（尤其是 Boot 3.0/3.1），課程會標註差異。
> **如果你發現任何一處不符，那是課程的問題，不是你的。**

⚠️ **02 章與 03 章特別依賴「框架與資料庫的具體行為」**，
而那些行為會隨版本、驅動設定、`sql_mode` 而變。
兩章各有一組「把行為釘住」的特性測試（02 章練習 3、03 章練習 3）——
**那兩組請真的跑一次**，它們的存在就是為了取代「相信文件」。

### 引用慣例

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

> 📌 **為什麼把這張表放在最前面**：
> 這一站會**大量**回頭引用 04-controller 的程式碼
> （`OrderWebMapper`、`ErrorCode`、`Actor`、70 條端點…），
> 而「這個 3.5.2 是哪一站的」讀錯一次就會找不到東西。

---

### 程式碼演進表：如果你做過 04-controller，這些東西變了

**你在 04-controller 寫的程式碼，這一站有 22 處會被改掉。**

這不是勘誤，是**設計的演進** —— 04-controller 那些決定在「Service 是 stub」的前提下
是對的，而一旦 Service 變成真的，前提就變了。
（04-controller 的 `allowedActions()` 沒有參數，是因為它回傳假資料；
真的實作起來才發現「這個方法不可能知道呼叫者是誰」。）

> 📌 **這張表本身是一個教學重點，不只是清單**：
> 看「為什麼」那一欄 —— **每一列都是「上游的決定被下游的現實推翻」**。
> 而課程刻意**不回頭改寫前面的章節**，只在原處加一行前向指標，
> 因為「先看見痛，再給解法」需要痛留在原處。

⚠️ **怎麼用這張表**：
- 如果你**跟著做專案** → 照「記在哪」那一欄去看該節的完整理由與新程式碼。
- 如果你**只是讀** → 掃過「為什麼」那一欄就好，它是這一站的爭議點索引。

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
- 快取加了沒設過期，資料改了畫面永遠是舊的（05 章）。

## 產出

把 04-controller 留下的介面全部實作完成：訂單成立、庫存扣減、金額計算、狀態流轉，
含交易邊界標註、業務例外體系與完整 Mockito 測試。此時系統已可端到端跑通（Repository 先用記憶體假實作）。
