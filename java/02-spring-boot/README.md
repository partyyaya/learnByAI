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
- **畫出一個 HTTP 請求從 Tomcat 到你的方法之間的每一格**，並說出 Filter / Interceptor / AOP 各住在哪一層。
- 用 Actuator 做健康檢查與指標，把服務接上監控。
- 依「下游容量」定出執行緒池大小與逾時，而不是留著預設值上線。
- 寫出跑得快的測試：分清楚 `@SpringBootTest` 與切片測試的差別。
- 規劃一次 Spring Boot 2 → 3 的遷移，並執行四份除錯 SOP。

## 前置知識

[01-java-core/](../01-java-core/) 的 02、03、10、11 章（OOP、介面、Maven、JUnit），
以及 **13 章（反射、註解與動態代理）**——這一站的每一個「魔法」都建立在那一章的三個機制上。

---

## 章節目錄

| 章節 | 檔案 | 主題 | 重點 |
|------|------|------|------|
| 00 | [00-course-map-why-spring-boot.md](./00-course-map-why-spring-boot.md) | 課程地圖與 Spring Boot 定位 | Spring vs Spring Boot、start.spring.io、專案結構、啟動流程、**一個請求的完整旅程** |
| 01 ★ | [01-ioc-di-and-bean-container.md](./01-ioc-di-and-bean-container.md) | IoC 容器與依賴注入 | `@Component` / `@Bean`、建構子注入為何最好、Bean 生命週期、作用域、循環依賴 |
| 02 | [02-auto-configuration-and-starter.md](./02-auto-configuration-and-starter.md) | 自動組態原理 | `@EnableAutoConfiguration`、`@Conditional` 家族、`AutoConfiguration.imports`、寫自己的 starter |
| 03 | [03-configuration-properties-and-profiles.md](./03-configuration-properties-and-profiles.md) | 設定檔與多環境 | `application.yml` 階層、`@Value` vs `@ConfigurationProperties`、Profile、外部化設定與密鑰管理 |
| 04 ★ | [04-aop-and-proxy-mechanism.md](./04-aop-and-proxy-mechanism.md) | AOP 與代理機制 | 切面、切點運算式、JDK Proxy vs CGLIB、**自呼叫失效**、實作稽核與計時切面 |
| 05 | [05-logging-and-actuator.md](./05-logging-and-actuator.md) | 日誌與可觀測性 | Logback 設定、結構化 JSON 日誌、MDC 追蹤 ID、Actuator 端點、Micrometer 指標 |
| 06 | [06-scheduling-async-and-events.md](./06-scheduling-async-and-events.md) | 排程、非同步與事件 | `@Scheduled`、`@Async` 與執行緒池設定、`ApplicationEvent`、事務事件監聽 |
| 07 | [07-testing-spring-boot.md](./07-testing-spring-boot.md) | Spring Boot 測試策略 | `@SpringBootTest` vs 切片測試、**測試 context 快取**、`@MockitoBean`、Testcontainers |
| 08 | [08-packaging-docker-and-deployment.md](./08-packaging-docker-and-deployment.md) | 打包與部署 | 可執行 jar 結構、分層 Dockerfile、**執行緒池與逾時調參**、優雅關閉、健康檢查 |
| 09 | [09-spring-boot-3-and-pitfalls.md](./09-spring-boot-3-and-pitfalls.md) | Spring Boot 3 與常見雷點 | Jakarta 命名空間遷移、設定變更清單、**四份除錯 SOP** |

### 怎麼讀

```
00（名詞地圖、啟動流程、一個請求的完整旅程）
 └─→ 01 ★ IoC 與 Bean 生命週期（後面每一章都掛在這張圖上）
      ├─→ 02（自動組態：「為什麼加一行依賴就會動」）
      │    └─→ 03（設定與多環境：自動組態讀的就是這些屬性）
      └─→ 04 ★ AOP 與代理（01 的「代理在哪一步產生」的完整版）
           ├─→ 05（日誌、MDC、Actuator、指標）
           │    └─→ 06（排程／非同步／事件：跨執行緒後 05 的 MDC 會不見）
           ├─→ 07（測試：驗證 01～06 每一項真的生效）
           └─→ 08（部署：執行緒池、優雅關閉、零停機）
                └─→ 09（遷移手冊 + 除錯 SOP：把前八章收斂成決策樹）
```

⚠️ **如果時間有限**：
**01 與 04 是這一站的地基** —— 「Bean 是代理」這件事一旦懂了，後面所有「註解沒生效」都不再是玄學。
**06 是「預設值會害你」密度最高的一章**（排程單執行緒、`@Async` 佇列無上限、`AFTER_COMMIT` 寫不進資料庫）。
**09 的四份除錯 SOP 可以先跳讀** —— 但真的遇到問題時記得回來查。

---

## 這一站會打破的幾個假設

| 你以為 | 實際上 | 在哪一章 |
|---|---|---|
| 「注入進來的就是我寫的那個類別」 | 是 **CGLIB 子類別**；`getClass()` 回傳 `$$SpringCGLIB$$0` | 01 章 1.12、04 章 4.16 |
| 「`@Autowired` 欄位注入比較短，所以比較好」 | 建構子執行時欄位還是 `null`，而且測試只能靠反射塞值 | 01 章 1.7 |
| 「`@Scope("prototype")` 就會每次拿新的」 | 被單例注入時只會注入**一次**，prototype 完全失效 | 01 章 1.10 |
| 「`@Bean` 方法互相呼叫會建立多個實例」 | 預設不會（CGLIB 代理）；但 `proxyBeanMethods = false` 時**真的會** | 01 章 1.14 |
| 「自動組態是編譯期產生程式碼」 | 是**執行期**評估條件；而且**你自己定義的 Bean 一定贏** | 02 章 2.4、2.7 |
| 「`@ConditionalOnBean` 可以放在自己的 `@Configuration` 上」 | 評估時機太早，幾乎永遠是 `false` | 02 章 2.5 |
| 「YAML 的 `NO` 就是字串 "NO"」 | 被當成 boolean `false` —— 挪威的訂單全部被判定為不支援 | 03 章 3.3 |
| 「`application-prod.yml` 一定最優先」 | jar **外**的 `application.yml` 贏過 jar **內**的 profile 檔案 | 03 章 3.4 |
| 「`this.method()` 上的 `@Transactional` 會生效」 | 不經過代理，**完全不生效**，而且不會報錯 | 04 章 4.14 |
| 「`final` 方法加註解只是風格問題」 | `final` **類別**啟動就爆；`final` **方法**靜靜失效 | 04 章 4.15 |
| 「`log.error("失敗：" + e.getMessage())` 夠用了」 | 堆疊完全遺失，而且 `getMessage()` 常常就是 `null` | 05 章 5.4 |
| 「指標多加幾個標籤比較好查」 | `orderId` 當標籤 → 一天 10 萬個時間序列 → Prometheus OOM | 05 章 5.14 |
| 「健康檢查要檢查所有依賴」 | 資料庫抖動 → 所有 Pod liveness 失敗 → **集體重啟雪崩** | 05 章 5.13 |
| 「12 個排程任務會並行跑」 | 預設執行緒池**只有 1 條**，一個卡住全部停擺 | 06 章 6.3 |
| 「`max-size: 200` 代表最多開 200 條」 | 佇列預設無上限 → 永遠只有 8 條 → 任務堆到 OOM | 06 章 6.6 |
| 「`AFTER_COMMIT` 裡存資料庫沒問題」 | SQL 執行了但**不會被 commit**，稽核表永遠是空的 | 06 章 6.9 |
| 「每個測試都掛 `@SpringBootTest` 最保險」 | 47 個 context × 3 秒 = 光啟動就 141 秒 | 07 章 7.5 |
| 「用 H2 測試，反正 SQL 都一樣」 | 大小寫、collation、保留字、鎖行為全都不同 —— 而測試全綠 | 07 章 7.8 |
| 「`ENTRYPOINT java -jar app.jar` 就好」 | `sh` 是 PID 1，SIGTERM 傳不到 JVM，優雅關閉完全沒發生 | 08 章 8.3 |
| 「`-Xmx` 設成容器 limit 剛好用滿」 | 忘了 Metaspace／執行緒堆疊／Code Cache → 必定 OOMKilled | 08 章 8.6、練習 2 |
| 「`server.shutdown: graceful` 就零停機了」 | 還缺 `preStop` —— LB 更新比 SIGTERM 慢，那 2 秒全部 502 | 08 章 8.7 |
| 「升版的難點是改 `javax` import」 | 難點是**編譯通過、啟動成功、但行為變了**（尾斜線 404） | 09 章 9.8 |

每一章最後都有一份「常見錯誤」的完整清單。

---

## 貫穿案例：shop-service

從第 01 章開始，你會跟著課文建立同一個服務 `shop-service`（**用 `start.spring.io` 自己產生，
不是 repo 裡的目錄**），它會一路長大：

| 章節 | 專案演進 |
|------|----------|
| 01 | 容器化改造：介面 + 建構子注入，付款方式用「注入 `List`」實作策略模式 |
| 02 | 抽出 `audit-spring-boot-starter`：三模組結構、條件式 Bean、`ApplicationContextRunner` 測試 |
| 03 | 設定分環境（local / dev / staging / prod）、`record` 設定綁定與驗證、密碼移出程式碼、`ProfileGuard` |
| 04 | 稽核切面與計時切面，實測 `@Transactional` 自呼叫失效 |
| 05 | 結構化 JSON 日誌 + 追蹤 ID + Actuator 指標 |
| 06 | 排程對帳任務 + 非同步寄信 + 領域事件 |
| 07 | 切片測試 vs 完整測試，context 快取實測 |
| 08 | 分層 Dockerfile、環境變數注入、執行緒池與逾時調參、優雅關閉 |
| 09 | Spring Boot 2 → 3 遷移實作與雷點清單 |

到第 08 章結束時，它會是一個**可以直接 `docker run` 起來、有健康檢查、有指標、有分環境設定**的服務骨架，
也是 03～09 子課程的共用底座。

---

## 如果只能記住十件事

1. 容器裡的 Bean 是**代理**，不是你 `new` 的那個物件 —— 所有註解都建立在這件事上。
2. 一律**建構子注入** —— 這不是潔癖，是「能不能寫測試」的分界線。
3. **`this.method()` 不經過代理** —— `@Transactional`、`@Async`、`@Cacheable`、`@PreAuthorize` 全部失效。
4. 自動組態是**有條件**的，而且**你自己定義的 Bean 一定贏**。
5. 設定優先序：命令列 > `-D` > 環境變數 > 外部檔案 > jar 內檔案；且 jar 外的 `application.yml` 贏過 jar 內的 profile 檔案。
6. **密碼絕不進版控**，已外洩的金鑰要作廢而不是只改檔案。
7. 每一行日誌都要有 **traceId**；指標的標籤只能是**低基數**的值。
8. **預設值都不是給正式環境的**：`@Scheduled` 單執行緒、`@Async` 佇列無上限、
   Tomcat 200 條 worker 搭 HikariCP 10 條連線、HTTP 用戶端**完全沒有逾時**。四個都要設。
9. **能不啟動 Spring 就不要啟動**；測試 context 的種類要收斂成幾個。
10. **優雅關閉要三層都對**：Spring、容器、K8s。

## 五個除錯端點

| 問題 | 端點 |
|------|------|
| 這個 Bean 在容器裡嗎？ | `/actuator/beans` |
| 這個自動組態為什麼沒生效？ | `/actuator/conditions` |
| 這個設定的最終值是什麼、從哪來？ | `/actuator/env/<key>` |
| 這支 API 在路由表裡嗎？ | `/actuator/mappings` |
| 啟動為什麼變慢？ | `/actuator/startup` |

> ⚠️ 這五個端點**預設全部不開放** —— Spring Boot 3 的預設值只暴露 `/actuator/health`。
> 開發時要在 `application.yml` 明確列出（含 `startup`），
> 而正式環境要收斂成白名單 + 獨立 port（第 05 章 5.16）。

---

## 關於書裡的程式碼

**基準版本**：Java 21 / Spring Boot 3.5（Spring Framework 6.2）/ Maven 3.9。
其餘版本由 `spring-boot-starter-parent` 決定，不需要自己指定
（3.5.0 上是 Logback 1.5、Micrometer 1.15、JUnit 5.12、Mockito 5.17、Testcontainers 1.21）；
只有 ArchUnit（1.3）與 logstash-logback-encoder（8.0）要自己寫版本號。

課文會把「哪一版才有」標在旁邊（例如 `【Boot 3.2+】` 的虛擬執行緒、
`【Boot 3.3+】` 的 `jarmode=tools`、`【Boot 3.4+】` 的結構化日誌與 `@MockitoBean`）。
**如果你的專案還在 3.0 / 3.1，這些地方要換回舊寫法** —— 第 09 章 9.18 有各版本的對照。

⚠️ **三件開始前先知道的事**：

1. **`@MockitoBean` 需要 Boot 3.4+。** 第 07 章統一寫 `@MockitoBean` / `@MockitoSpyBean`；
   在 3.0～3.3 上要改成 `@MockBean` / `@SpyBean`（語意相同，只有 import 與類別名不同）。
2. **第 07、08 章需要 Docker。** Testcontainers（7.8）與映像建置（8.3）都要本機有 Docker daemon；
   沒有 Docker 時這兩節可以只讀不做，其餘章節不受影響。
3. **第 05、08 章的 K8s 設定是「可以抄的範本」，不是可以直接 apply 的完整清單** ——
   它們刻意省略了 namespace、Ingress、憑證這些每家都不一樣的部分。

> 課程中的程式碼與設定已在 **JDK 21 + Maven 3.9 + Spring Boot 3.5 + MySQL 8**（Docker）上
> 抽出實際編譯與執行驗證過 —— 包含 01～04 章的實戰與練習程式碼（45 個測試）、
> 第 03 章的設定優先序實驗、第 04 章的代理與 advice 順序、第 06 章的 cron 運算式與批次表結構、
> 第 07 章的 ArchUnit 陷阱。
> 但各版本行為仍有差異，若你的輸出與課文不符，**請以你的環境與該版本的官方 Release Notes 為準**。

---

完成後請前往 [03-rest-api](../03-rest-api/) —— 那一站會**暫時放下 Spring**，
先把「一組別人看得懂、改得動、不會一改就破壞相容」的 API 契約設計清楚。
