# 05 — Service（商業邏輯層）

> Service 是整個系統的心臟：訂單能不能成立、庫存怎麼扣、錢怎麼算，都在這一層。
> 這也是唯一應該決定「交易邊界」的地方 —— `@Transactional` 放錯位置造成的資料不一致，比效能問題難查十倍。

---

## 學完你可以

- 說明 Service 層的三個職責（編排、交易邊界、守護不變量），並判斷什麼邏輯該再往下抽成領域物件。
- 列出系統的**不變量清單**，判斷每一條該守在哪一層（Web 驗證 / Domain / 原子 SQL / 資料庫約束），
  並說明為什麼「在 Service 裡 if 一下」在併發下必然失效。
- 判斷一個 Service 該多大、要不要介面、能不能呼叫另一個 Service，並讀懂與解開循環依賴。
- 正確使用 `@Transactional`：傳播行為、唯讀最佳化、rollback 規則，
  並診斷**五種交易失效情境**（自呼叫、非 public / final / static、非 Spring 管理的物件、換執行緒、例外被 catch 掉）。
- 在悲觀鎖、樂觀鎖、原子 UPDATE 之間做選擇，並處理死鎖與寫偏斜。
- 設計 DTO ↔ Entity 轉換，處理 **`PATCH` 的三態語意**與欄位級權限，
  並用掃描測試讓「漏映射一個欄位」變成 CI 紅燈。
- 用**「誰能修好它」**決定一個失敗是 4xx 還是 500，設計分層的業務例外體系與 i18n 訊息。
- 說明 `@Cacheable` 與 `@Transactional` 共用哪些失效情境、在哪一點不同，
  分辨擊穿／雪崩／穿透，並判斷什麼**不該**快取。
- 設定執行緒池與 `RestClient` 的多層逾時，用「**對方處理了嗎**」決定該重試還是該查詢，
  並用熔斷、隔艙、outbox 處理交易之外的失敗。
- 用 Mockito 寫商業邏輯單元測試，知道什麼時候必須用真的資料庫，
  並讀懂突變測試報告 —— 以及為什麼 100% 覆蓋率仍可能漏掉 `>=` 與 `>` 的差別。

## 前置知識

[02-spring-boot/](../02-spring-boot/) 01、04 章（DI 與 AOP 代理），[04-controller/](../04-controller/) 全部。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [00-course-map-business-layer-role.md](./00-course-map-business-layer-role.md) | 課程地圖與商業邏輯層定位 | 2,000 行 `OrderServiceImpl` 的六個真實事故、貧血 vs 充血、`Money` 值物件、**邏輯歸屬的七個判準**、**11 條不變量與「守在四個位置」**、`Order` 聚合與狀態機、不該做的九件事、ArchUnit 守門規則 |
| 01 | [01-service-design-and-dependency.md](./01-service-design-and-dependency.md) | Service 設計與依賴管理 | 「14 個依賴」怎麼分析、讀寫分離、**介面 vs 實作（六個理由四個已失效）**、把不確定性注入進來、Service 之間的界線與五種解耦手段、**循環依賴的六種解法**、埠與轉接器、方法簽章 |
| 02 | [02-transaction-management-in-depth.md](./02-transaction-management-in-depth.md) | 交易管理（**核心章**） | 交易與 ThreadLocal、**七種傳播行為的完整矩陣**、MySQL 的 RR、rollback 規則、**五種失效情境**、`UnexpectedRollbackException`、**交易長度 × 連線池 = TPS 上限**、**悲觀鎖／樂觀鎖／原子 UPDATE 的決策表**、死鎖與固定鎖順序、`AFTER_COMMIT` 的三個陷阱 |
| 03 | [03-dto-entity-mapping.md](./03-dto-entity-mapping.md) | DTO ↔ Entity 轉換 | 三個事故（客戶看到客服評語、日本站被當台幣、`@JsonIgnore` 讓退款消失）、**不回傳 Entity 的六個代價**、mass assignment、MapStruct 與 `unmappedTargetPolicy = ERROR`、**`Patch<T>` 與 PATCH 三態**、欄位級權限、四組掃描測試、`open-in-view` |
| 04 | [04-business-exception-design.md](./04-business-exception-design.md) | 業務例外設計 | 三個事故（500 讓客戶重複下單七次、客服的「系統壞了」、退款靜默失敗三週）、**98 個 `ErrorCode` 的分區守門**、兩層例外 + 三個標記介面、**「誰能修好它」的判準**、**一個例外兩個狀態碼**、`MessageFormat` 的五個實測行為、`safeToRetryBlindly` |
| 05 | [05-caching-in-service-layer.md](./05-caching-in-service-layer.md) | 服務層快取 | 三個事故（rollback 後快取有不存在的價格、兩個方法共用一個項目、`allEntries` 清掉 40 萬筆）、**`@Cacheable` 的四種失效情境**、**交易裡的 `@Cacheable`（實測：髒值永久留著）**、key 設計的四個陷阱、**授權與快取不相容**、擊穿／雪崩／穿透、序列化 |
| 06 | [06-async-and-external-api-calls.md](./06-async-and-external-api-calls.md) | 非同步與外部呼叫 | 三個事故（部署丟掉 3,000 封信、ERP 逾時打成 503、逾時重試重複扣款）、**`@Async` 的六種失效**、**`maxPoolSize` 完全沒作用**、**四個 ThreadLocal 全消失**、graceful shutdown、**交易與非同步的四個衝突**、`RestClient` 的四個逾時、**失敗的 A/B/C 三類**、熔斷與隔艙、**outbox**、Saga |
| 07 | [07-service-testing-with-mockito.md](./07-service-testing-with-mockito.md) | Service 層測試 | 三個事故（350 綠燈卻超賣 47 筆、captor 讓錯的稽核紀錄過關、`@InjectMocks` 造成生產 NPE）、**「mock 掉的東西就是沒被測到的東西」**、不用 `@InjectMocks` 的三個理由、**41 個例外用 5 個測試測完**、五種測試替身與契約測試、**併發測試**、**突變測試**、探針不是測試 |

### 怎麼讀

```
00（定位、不變量、Order 聚合、ArchUnit 骨架）
 └─→ 01（Service 多大、要不要介面、循環依賴、埠與轉接器）
      └─→ 02 ★ 交易管理（核心章，唯一不能跳）
           ├─→ 03（DTO 轉換、PATCH 三態、欄位級權限）
           │    └─→ 04（業務例外：狀態碼、i18n、守門測試）
           ├─→ 05（快取：與交易共用失效情境）
           │    └─→ 06（非同步、外部呼叫、outbox）
           └─→ 07（測試：讀完 02 與 06 再讀，效果最好）
```

⚠️ **如果時間有限**：
**02 是唯一不能跳的一章**（交易失效是靜默的）。
**03 與 04 是「靜默 bug」最密集的兩章**。
**06 是上線後最容易半夜出事的一章。**

---

## 這一站會打破的幾個假設

這一站每一章都在處理同一種東西：
**在單機、低流量、假 Repository 之下【完全正確】，而在正式環境是錯的程式碼。**

| 你以為 | 實際上 | 在哪一章 |
|---|---|---|
| 「`@Transactional` 貼上去就有交易」 | 五種情境下它**完全沒有作用，而且沒有任何警告** | 02 章 2.7 |
| 「拋了例外交易就會回滾」 | 預設只對 unchecked 生效；而 catch 掉之後連標記都不會留 | 02 章 2.6 |
| 「先 `SELECT` 查庫存再 `UPDATE` 扣減」 | 促銷第一分鐘超賣 47 筆，而單元測試全綠 | 00 章 0.8、02 章 2.11 |
| 「用了 DTO 就安全了」 | `BeanUtils.copyProperties` 付了 DTO 的成本卻沒得到安全性，對 record 還完全無效 | 03 章 3.4.3 |
| 「`PATCH` 送 `null` 就能清空欄位」 | 三態裡有兩態是對的，所以**功能看起來是好的** | 03 章 3.6.2 |
| 「業務失敗拋 `IllegalStateException` 就好」 | 500 → 前端自動重試 → 同一張訂單成立七次 | 04 章 4.0 事故 1 |
| 「`retryable: true` 就代表可以重試」 | `CHECK_STATUS` 的 `retryable` 也是 `true`，而它的意思是「去查狀態」 | 04 章 4.9.1 |
| 「加 `@Cacheable` 只是變快」 | 交易裡的未提交值進了快取，rollback 之後**它永久留著** | 05 章 5.3.3 |
| 「設了 `max-size` 執行緒池就有上限」 | 沒同時設 `queue-capacity` 的話它**完全沒有作用** | 06 章 6.2.4 |
| 「逾時了就重試」 | 讀取逾時的意思是「不知道」，不是「失敗」→ 重複扣款 | 06 章 6.6.1 |
| 「350 個測試全綠、覆蓋率 92% 就夠了」 | 100% 覆蓋率仍然漏掉 `>=` 與 `>` 的差別 | 07 章 7.16.2 |

**每一條都有一個跑得起來的實驗把它拆掉**，而不是一段「應該要注意」的說明。
每一章最後都有一份「常見誤區」的完整清單。

---

## 引用慣例（讀之前先看一眼）

這一站與 04-controller **章號完全重疊**（兩邊都有 00～07 章），
所以「06 章 6.5.8」這種寫法有歧義。全站統一成：

| 寫法 | 意思 |
|---|---|
| `0.8.3`、`1.6.4` | **本章**的小節 |
| `00 章 0.8.3` | **本站（05-service）**其他章的小節 |
| `04-controller 3.5.2` | **04-controller 站**的小節（章號由小節第一碼決定） |
| `04-controller 站`、`04-controller 07 章` | 指整個站或整章 |
| `本站 04 章` | 本站的整章 —— 同一段也提到 04-controller 時必須這樣寫 |
| `03-rest-api 第 04 章 4.9` | 更早的站 |

> 📌 這一站會**大量**回頭引用 04-controller 的程式碼
> （`OrderWebMapper`、`ErrorCode`、`Actor`、70 條端點…），
> 而「這個 3.5.2 是哪一站的」讀錯一次就會找不到東西。

---

## 產出

把 04-controller 留下的介面全部實作完成：訂單成立、庫存扣減、金額計算、狀態流轉，
含交易邊界標註、業務例外體系與完整 Mockito 測試。

**此時系統已可端到端跑通** —— 從 `POST /orders` 進去，穿過驗證、Service、交易邊界，
到 Repository（**先用記憶體假實作**），再原路回來變成 201。
真的 SQL 是下一站（[06-repository/](../06-repository/)）的事。

👉 逐項的產出清單在 07 章 7.23，那裡列出八章各自交出了什麼 ——
以及這一站從頭到尾在做的同一件事：**把「靜默的錯誤」換成「編譯錯誤」或「CI 紅燈」。**

---

## 關於書裡的數字

**基準版本**：Java 21 / Spring Boot 3.2.5 / Spring Framework 6.1 / Jackson 2.17 /
MapStruct 1.5.5.Final / MySQL 8.0 / Caffeine 3.1.8 / ArchUnit 1.3 / ClassGraph 4.8。

各章的驗證程度不同，**這決定你可以多信任裡面的程式碼**：

| 章節 | 狀態 |
|---|---|
| **00～03** | ⚠️ **逐行檢閱，但沒有編譯執行過** —— 抄進專案之前請自己編一次 |
| **04、05** | ✅ 在上述版本上編譯並執行過 |
| **06、07** | ✅ 同上，而且是「**先做實驗、再寫章節**」 |

⚠️ **有兩組測試請真的跑一次：02 章練習 3 與 03 章練習 3。**
這兩章特別依賴「框架與資料庫的具體行為」，而那些行為會隨版本、驅動設定、`sql_mode` 而變。

🔴 **這一站沒有驗證到的**：真的 Redis、真的 MySQL 的併發與鎖、真的 MQ、
K8s 的關機流程、壓測。**每一章的驗收清單都有自己的「已知缺口」小節。**

---

## 程式碼演進

**你在 04-controller 寫的程式碼，這一站會改動它** ——
不是勘誤，是**設計的演進**：那些決定在「Service 是 stub」的前提下是對的，
而一旦 Service 變成真的，前提就變了。

課程刻意**不回頭改寫前面的章節**，只在原處加一行前向指標，
因為「先看見痛，再給解法」需要痛留在原處。

| 改了什麼 | 為什麼 | 說明在 |
|---|---|---|
| `order.service` 拆成 `order.application` + `order.domain` | 交易邊界與規則要分開（介面與 command 留在原處） | 00 章 0.14.3 |
| `allowedActions()` 加上 `actor` 參數 | 無參數版本會讓**客服看到的可執行操作與客戶相同** | 00 章 0.14.1 |
| `StatusLabelResolver` 新增 `label(Enum<?>, Locale)` | 原版讀 `LocaleContextHolder`（ThreadLocal），排程與 `@Async` 會拿到錯的語言 | 00 章 0.14.5 |
| `create()` 扣庫存前先依 `productId` 排序 | 兩張訂單含相同商品但順序不同 → **死鎖** | 02 章 2.14.1 |
| Application Service 回傳 `OrderResultView` 而不是 `Order` | 聚合離開交易 → `LazyInitializationException`；而授權判斷跑到了 Web 層 | 03 章 3.3.3 |
| `UpdateOrderCommand` 的 builder 改成 `Patch<T>` | 🔴 原本的寫法讓「**清空一個欄位**」完全失效，而三態裡有兩態是對的 | 03 章 3.6.2 |
| `Cancellation.note` 拆成 `customerNote` + `staffNote` | 🔴 一個欄位的語意取決於「誰填的」→ 客戶查訂單會看到客服的評語 | 03 章 3.7.3 |
| `Order.assertInvariants()` 改拋 `InvariantViolationException` | `IllegalStateException` 無法告警、無法查詢，且與 JDK 拋的混在一起 | 04 章 4.4.4 |
| `Problem` 新增 `safeToRetryBlindly` | 🔴 `retryable()` 把 `CHECK_STATUS` 也算成 `true` → 前端盲重試 → **重複扣款** | 04 章 4.9.1 |
| `@EnableAsync` 明確設 `order = HIGHEST_PRECEDENCE` | 🔴 預設是最內層 → **換執行緒發生在開交易之後，方向反了** | 06 章 6.3.2 |
| `ErpAdapter` 加四個逾時、拿掉 `@Retryable`、改走 outbox | 🔴 沒有逾時 + 重試 3 次 → 一個請求佔住連線 18 秒 → **整站 503** | 06 章 6.5.5 |
| `OrderNotificationListener` 改走 outbox | 00 章把通知歸類為「可以遺失」—— 而一次例行部署丟掉了 3,000 封信 | 06 章 6.8.6 |
| 所有 `@InjectMocks` 改成建構子注入 | 少一個依賴時它**塞 `null` 而不報錯** | 07 章 7.3.3 |
| 測試類別上的 `@Transactional` 全部拿掉 | 測試結束自動 rollback → **`AFTER_COMMIT` 的 listener 一個都不跑** | 07 章 7.11.2 |

> 📌 **這張表本身是一個教學重點**：每一列都是「上游的決定被下游的現實推翻」。
> 而其中兩列特別值得看，因為它們是「**原本的程式碼會靜默出錯**」——
> `Patch<T>` 那一列（清空欄位失效，而 QA 很少測「改成空的」）
> 與 `Cancellation.note` 那一列（客服的評語，客戶看得到）。
>
> **這一站反覆在做同一件事：把「靜默出錯」換成「編譯錯誤」或「CI 紅燈」。**
