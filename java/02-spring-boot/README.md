# 02 — Spring Boot 框架原理

> Spring Boot 最大的問題是「太好用」：加一個註解就會動，但出事時完全不知道從哪查。
> 這一站把黑箱打開 — 容器怎麼建 Bean、自動組態怎麼決定要不要生效、`@Transactional` 為什麼是靠代理實作。
> 懂了原理，後面 04 / 05 / 06 三層才不會是死背。

---

## 學完你可以

- 說明 IoC 與 DI 解決了什麼問題，以及 Bean 的生命週期與作用域。
- 讀懂一份 `spring-boot-starter-*` 到底幫你設定了什麼，並自己寫一個 starter。
- 用 Profile 管理多環境設定，把密碼從程式碼裡拿掉。
- 說明 AOP 代理機制，並解釋為什麼「同類別內部呼叫」會讓 `@Transactional` 失效。
- 用 Actuator 做健康檢查與指標，把服務接上監控。
- 寫出跑得快的測試：分清楚 `@SpringBootTest` 與切片測試的差別。

## 前置知識

[01-java-core/](../01-java-core/) 的 02、03、10、11 章（OOP、介面、Maven、JUnit）。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [00-course-map-why-spring-boot.md](./00-course-map-why-spring-boot.md) | 課程地圖與 Spring Boot 定位 | Spring vs Spring Boot、start.spring.io、專案結構、啟動流程做了什麼 |
| 01 | [01-ioc-di-and-bean-container.md](./01-ioc-di-and-bean-container.md) | IoC 容器與依賴注入 | `@Component` / `@Bean`、建構子注入為何最好、Bean 生命週期、作用域、循環依賴 |
| 02 | [02-auto-configuration-and-starter.md](./02-auto-configuration-and-starter.md) | 自動組態原理 | `@EnableAutoConfiguration`、`@Conditional` 家族、`AutoConfiguration.imports`、寫自己的 starter |
| 03 | [03-configuration-properties-and-profiles.md](./03-configuration-properties-and-profiles.md) | 設定檔與多環境 | `application.yml` 階層、`@Value` vs `@ConfigurationProperties`、Profile、外部化設定與密鑰管理 |
| 04 | [04-aop-and-proxy-mechanism.md](./04-aop-and-proxy-mechanism.md) | AOP 與代理機制 | 切面、切點運算式、JDK Proxy vs CGLIB、自呼叫失效、實作稽核與計時切面 |
| 05 | [05-logging-and-actuator.md](./05-logging-and-actuator.md) | 日誌與可觀測性 | Logback 設定、結構化 JSON 日誌、MDC 追蹤 ID、Actuator 端點、Micrometer 指標 |
| 06 | `06-scheduling-async-and-events.md` | 排程、非同步與事件 | `@Scheduled`、`@Async` 與執行緒池設定、`ApplicationEvent`、事務事件監聽 |
| 07 | `07-testing-spring-boot.md` | Spring Boot 測試策略 | `@SpringBootTest` vs 切片測試、測試 context 快取、`@MockBean`、Testcontainers |
| 08 | `08-packaging-docker-and-deployment.md` | 打包與部署 | 可執行 jar 結構、分層 Dockerfile、環境變數注入、優雅關閉、健康檢查 |
| 09 | `09-spring-boot-3-and-pitfalls.md` | Spring Boot 3 與常見雷點 | Jakarta 命名空間遷移、設定變更清單、啟動變慢、Bean 找不到的除錯流程 |

---

## 常見誤區（課程會逐一破解）

- 全部用 `@Autowired` 欄位注入，寫測試時無法替換依賴。
- 密碼寫死在 `application.yml` 然後 commit 進 Git。
- 每個測試都掛 `@SpringBootTest`，測試跑十分鐘。
- 以為加了 `@Async` 就一定非同步（同類別呼叫一樣失效）。
- Spring Boot 2 → 3 直接升版，`javax.*` 全紅。

## 練習專案

`demo/`（`shop-service`）會建立一個最小 Spring Boot 服務，隨章節長出設定檔分環境、稽核切面、排程任務、Actuator 端點與 Docker 映像檔，作為 03～09 子課程的共用底座。

| 章節 | 專案演進 |
|------|----------|
| 01 | 容器化改造：介面 + 建構子注入，付款方式用「注入 `List`」實作策略模式 |
| 02 | 抽出 `audit-spring-boot-starter`：三模組結構、條件式 Bean、`ApplicationContextRunner` 測試 |
| 03 | 設定分環境（local / dev / staging / prod）、`record` 設定綁定與驗證、密碼移出程式碼、`ProfileGuard` |
| 04 | 稽核切面與計時切面，實測 `@Transactional` 自呼叫失效 |
| 05 | 結構化 JSON 日誌 + 追蹤 ID + Actuator 指標 |
| 06 | 排程對帳任務 + 非同步寄信 + 領域事件 |
| 07 | 切片測試 vs 完整測試，context 快取實測 |
| 08 | 分層 Dockerfile、環境變數注入、優雅關閉 |
| 09 | Spring Boot 2 → 3 遷移實作與雷點清單 |

---

## 進度

**第 00～05 章已完成**（含每章的驗收清單與附解答練習），06～09 章撰寫中。

| 章節 | 狀態 | 篇幅 |
|------|------|------|
| 00 課程地圖與 Spring Boot 定位 | ✅ 完成 | 約 1,400 行 |
| 01 IoC 容器與依賴注入 | ✅ 完成 | 約 3,200 行 |
| 02 自動組態原理 | ✅ 完成 | 約 2,500 行 |
| 03 設定檔與多環境 | ✅ 完成 | 約 3,100 行 |
| 04 AOP 與代理機制 | ✅ 完成 | 約 3,200 行 |
| 05 日誌與可觀測性 | ✅ 完成 | 約 3,100 行 |
| 06～09 | ⏳ 撰寫中 | — |

> ⚠️ 課程中的程式碼與設定均經逐行檢閱，但**尚未在本機編譯執行驗證**
> （這台機器上沒有安裝 JDK 與 Maven）。若你在實作時遇到與課文不符的輸出，請以你的環境為準。
