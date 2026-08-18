# 05 — Service（商業邏輯層）

> Service 是整個系統的心臟：訂單能不能成立、庫存怎麼扣、錢怎麼算，都在這一層。
> 這也是唯一應該決定「交易邊界」的地方 —— `@Transactional` 放錯位置造成的資料不一致，比效能問題難查十倍。

---

## 學完你可以

- 說明 Service 層的職責，以及什麼邏輯應該再往下抽成領域物件。
- 正確使用 `@Transactional`：傳播行為、唯讀最佳化、什麼例外才會 rollback。
- 解釋自呼叫、非 public 方法、非 Runtime 例外三種交易失效情境的原因與解法。
- 設計 DTO ↔ Entity 轉換策略，避免 Entity 洩漏到 API 層。
- 設計分層的業務例外體系，讓 Controller 只需要對應狀態碼。
- 在 Service 層加上快取、非同步與外部 API 呼叫，並處理逾時與重試。
- 用 Mockito 寫出不碰資料庫的商業邏輯單元測試。

## 前置知識

[02-spring-boot/](../02-spring-boot/) 01、04 章（DI 與 AOP 代理），[04-controller/](../04-controller/) 全部。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | `00-course-map-business-layer-role.md` | 課程地圖與商業邏輯層定位 | 為什麼要有 Service、貧血 vs 充血模型、邏輯該放哪的判斷準則 |
| 01 | `01-service-design-and-dependency.md` | Service 設計與依賴管理 | 介面 vs 直接實作、建構子注入、Service 之間互相呼叫的界線、避免循環依賴 |
| 02 | `02-transaction-management-in-depth.md` | 交易管理（核心章） | `@Transactional` 全參數、7 種傳播行為、隔離級別、rollback 規則、三大失效情境 |
| 03 | `03-dto-entity-mapping.md` | 資料轉換 | 為何不要回傳 Entity、手寫 vs MapStruct、巢狀轉換、部分更新（PATCH）處理 |
| 04 | `04-business-exception-design.md` | 業務例外設計 | 例外階層、錯誤碼與訊息、可預期 vs 不可預期錯誤、與 Controller 的對應表 |
| 05 | `05-caching-in-service-layer.md` | 服務層快取 | `@Cacheable` / `@CacheEvict`、Redis 整合、快取一致性、擊穿與雪崩、key 設計 |
| 06 | `06-async-and-external-api-calls.md` | 非同步與外部呼叫 | `@Async` 與執行緒池、`RestClient` / `WebClient`、逾時、重試、熔斷、交易與非同步的衝突 |
| 07 | `07-service-testing-with-mockito.md` | 商業邏輯測試 | Mock Repository、行為驗證、參數捕捉、例外路徑測試、測試邊界條件 |

---

## 常見誤區（課程會逐一破解）

- `@Transactional` 加在 private 方法或同類別自呼叫上 —— 完全沒生效，出錯也不 rollback。
- 交易裡呼叫外部 API，對方逾時 30 秒，資料庫連線被卡住整池耗盡。
- 拋 `Exception`（checked）以為會 rollback，實際上預設只對 `RuntimeException` 生效。
- Entity 直接回傳給前端，一改欄位就破壞 API，還順便外洩敏感欄位。
- 快取加了沒設過期，資料改了畫面永遠是舊的。

## 產出

把 04-controller 留下的介面全部實作完成：訂單成立、庫存扣減、金額計算、狀態流轉，
含交易邊界標註、業務例外體系與完整 Mockito 測試。此時系統已可端到端跑通（Repository 先用記憶體假實作）。
