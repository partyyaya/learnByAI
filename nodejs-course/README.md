# Node.js 後端與全端服務開發：從 Express 到 NestJS

> 先理解 Node.js 如何執行程式與處理 I/O，再用 Express 看清 HTTP 請求流程，最後用 NestJS 練習模組、依賴注入與專案整合。整門課使用同一個「文章與留言管理 API」，讓每一層抽象都有前一階段的實作可以對照。

**目前進度：第 00–08 章已完成，09–33 章待撰寫。** 規劃共 **30 章主線（00–29）＋4 章選修（30–33）**；已完成章節提供連結，其餘檔名為預定名稱。

從 [00 — 課程地圖、執行環境與專題契約](00-course-map-and-project-contract.md) 開始。第 00 章提供 [Docker 可執行範例](examples/00/runtime-and-contract.mjs)，先觀察 Node 環境並檢查文章權限與狀態規則；HTTP 服務與資料庫會在後續章節逐步建立。

[01 — Node 版本、npm、TypeScript 建置與專案入口](01-runtime-tooling-and-project-setup.md) 提供[完整專案範例](examples/01/README.md)，可透過 Docker 或本機完成安裝、型別檢查、Jest 測試、建置與除錯。

[02 — 模組、套件入口與環境設定](02-modules-packages-and-configuration.md) 提供[模組與設定範例](examples/02/README.md)，比較 ESM／CommonJS、驗證套件公開入口，並在必要設定缺漏或非法時停止啟動。

[03 — 事件迴圈、microtask、I/O 與併發](03-event-loop-and-concurrency.md) 以[執行模型範例](examples/03/README.md) 比較排程、等待、CPU 阻塞與有限併發；[04 — 非同步錯誤、取消與資源生命週期](04-async-errors-and-resource-lifecycle.md) 提供[錯誤與清理範例](examples/04/README.md)，驗證不同結束路徑的 timer／listener 清理。

[05 — 原生 HTTP](05-native-http-request-response.md) 提供[可呼叫的服務](examples/05/README.md)，實作查詢、草稿預覽與輸入限制；[06 — 檔案、Buffer、串流與背壓](06-files-buffers-streams-backpressure.md) 提供[串流匯出範例](examples/06/README.md)，處理慢速接收、下載中斷與關檔。

[07 — 程序生命週期、信號與有界關閉](07-process-signals-and-graceful-shutdown.md) 提供[關閉流程範例](examples/07/README.md)，驗證進行中請求、資源清理與停止期限；[08 — Express 路由與 HTTP 契約](08-express-routing-and-http-contracts.md) 提供[記憶體文章 API](examples/08/README.md)，實作建立、修改、發佈與封存。

## 課程目標

完成主線後，應能：

- 解釋 Node.js 的事件迴圈、非同步 I/O 與阻塞風險，知道 `async` 不會自動把 CPU 運算移到背景。
- 從原生 HTTP 服務走到 Express，追蹤路由、middleware、錯誤與回應的完整流程。
- 使用 TypeScript 設計資料型別，並在執行期驗證外部輸入。
- 先手動組裝 Controller／Service／Repository，再理解 NestJS 的 DI 與 Module 解決哪些問題。
- 使用關聯式資料庫、migration 與交易，處理資料一致性與併發更新。
- 在伺服器實作登入、角色及資料擁有者權限，測試越權與失敗情境。
- 為核心邏輯、HTTP API 與真實資料庫撰寫測試，完成部署、觀測與故障排查。
- 將服務接到 React、Vue、Next.js 或 Nuxt，分清畫面、BFF 與後端的責任。

## 適合對象與前置知識

適合已有 JavaScript 基礎、想進入 Node.js 後端的前端工程師；也適合寫過簡單 API，想學習結構化專案的人。熟悉 Java／Spring Boot 的讀者可以走後面的快速路線。

開始前建議具備：

| 能力 | 本倉庫可先讀的教材 | 需要掌握到哪裡 |
|------|--------------------|----------------|
| JavaScript | [JavaScript 補強](../react/02-javascript-core-for-react.md)、[Promise／async-await](../common/promise-async-await-then.md) | 物件、陣列、函式、閉包、Promise 與例外處理 |
| TypeScript | [TypeScript 課程](../typescript/README.md) 01–07、09–11 | 型別、介面、縮窄、類別、泛型與模組；進入 NestJS 前補 13 裝飾器 |
| HTTP 與工具 | [HTTP／HTTPS](../common/http-https.md)、[Git](../git/git.md)、[Bash](../common/bash.md) 或 [Windows 命令列](../common/windows.md) | 能看懂請求與回應、執行指令、提交程式碼 |
| SQL | [資料庫課程](../database-course/README.md) 01–02 | 在本課第 11 章前補主鍵、外鍵、CRUD、JOIN 與交易概念 |

不要求先會 Express、NestJS 或前端框架；前端串接章會提供最小測試頁面，再讓熟悉框架的人自行延伸。

## 為什麼這樣安排？

| 階段 | 核心問題 | 學習方式 |
|------|----------|----------|
| Node.js 基礎 | 程式在哪裡執行？I/O、錯誤與程序怎麼運作？ | 寫小型實驗與一次原生 HTTP 服務 |
| Express 精華 | 一個請求經過哪些函式，最後如何回應？ | 親手串起路由、middleware、資料庫與測試 |
| NestJS 架構 | 功能變多後，如何管理依賴與共通責任？ | 把同一份 API 遷移成模組化單體，再加入業務功能 |
| 專題整合 | 如何確認服務能測、能部署、出事能查？ | 真實資料庫測試、前端串接與故障演練 |

Express 本身也能用於正式專案。本課將它安排成精華橋接，是為了集中展示請求處理機制；NestJS 則用於練習一套有一致規範的應用架構。Nest 預設使用 Express 作 HTTP 平台，也可使用 Fastify。[NestJS 官方介紹](https://docs.nestjs.com/)

Node.js 的事件迴圈與部分工作由 worker pool 處理，兩者都可能因工作過重而影響服務；因此執行模型會放在框架之前。[Node.js 官方說明](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)

## 貫穿專題：文章與留言管理 API

選擇這個題材，是因為 CRUD 容易起步，之後又能自然加入擁有者權限、文章狀態、交易、查詢與通知，不需要先理解金流或複雜電商規則。

### 最終功能範圍

| 模組 | 功能與練習重點 |
|------|----------------|
| 使用者與認證 | 註冊、登入、登出、Session 到期與撤銷；密碼雜湊及登入失敗處理 |
| 文章 | 草稿、發佈、封存；新增、修改、查詢、篩選與分頁 |
| 留言 | 對已發佈文章留言、刪除自己的留言；管理員可處理違規內容 |
| 授權 | 訪客只能讀公開內容；作者管理自己的資料；管理員有明確的額外權限 |
| 一致性 | 文章狀態轉換、版本欄位防止覆蓋他人更新，狀態變更與稽核紀錄在同一交易內完成 |
| 工程能力 | API 文件、測試、migration、結構化日誌、健康檢查、容器與 CI |

認證主線先採 **Cookie＋伺服器端 Session**，將登入、撤銷與跨請求狀態說清楚；Session 規劃存於 PostgreSQL，讓主線先能獨立完成。JWT／Bearer Token 會在認證章比較適用情境，完整 refresh token 輪替流程可作延伸練習。

### 專題如何逐步長大

```text
Node.js：用原生 HTTP 回傳健康狀態與固定文章資料
    ↓
Express：本機 CRUD API → PostgreSQL 持久化 → 分層 → HTTP 測試
    ↓
NestJS：保留 CRUD 契約遷移 → 加入認證／權限 → 交易與完整測試
    ↓
交付：最小前端 → 日誌與效能檢查 → Docker／CI → 故障驗收
    ↓
選修：Redis、背景工作、即時通知與 HTTP 平台替換
```

Express 階段的未授權寫入介面只供本機學習。遷移時先維持相同 CRUD 行為，通過原有測試後，再明確新增認證需求與相應測試，避免把架構遷移與業務變更混在一起。

## 預定技術選擇

| 項目 | 規劃 | 教學理由 |
|------|------|----------|
| 語言與執行環境 | 01 章固定 Node.js 24.22.1、npm 11.19.1、TypeScript 5.9.3 | 同時練習型別與執行期行為；以版本檔、映像 digest 與 lockfile 重建 |
| 模組與建置 | 01 章先用 NodeNext＋CommonJS 建置，02 章比較 ESM／CommonJS | 說清楚原始碼、轉譯結果與 Node 執行的差異；進入 Nest 時再加入裝飾器及 metadata 設定 |
| HTTP 框架 | Express 5 精華 → NestJS，主線使用 Express adapter | 保留底層平台，讓遷移先專注於架構變化 |
| 資料庫與 ORM | PostgreSQL＋Prisma | 兩個框架沿用同一資料模型與 migration，不因遷移框架而更換資料庫 |
| 驗證 | Express 使用 schema 驗證；NestJS 示範 DTO／Pipe | 保持對外驗證規則一致，區分 TypeScript 型別與實際輸入檢查 |
| 測試 | Jest＋Supertest；NestJS 加入 TestingModule | 沿用同一測試工具，分開驗證業務邏輯、HTTP 契約與資料庫行為 |
| 執行與部署 | npm scripts、lockfile、Docker Compose、Nginx | 明確區分開發啟動、正式建置、資料持久化與代理設定 |

01 章已固定執行環境、TypeScript 與 Jest，附上 lockfile 與環境驗證步驟。08 章已固定 Express 5.3.0 與 @types/express 5.0.6；ORM 與 HTTP 測試工具會在開始使用的章節確認相容版本，更新對應範例的 lockfile。

## 第一階段：Node.js 基礎（00–07）

目標：先能解釋程式如何運作，再用框架減少重複工作。

| 章節 | 預定檔案 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 00 | [00-course-map-and-project-contract.md](00-course-map-and-project-contract.md) | 課程地圖、Node 與瀏覽器的差異、專題需求與 API 契約 | 用 Docker 執行環境與規則檢查；畫出系統責任，列出成功與失敗回應 |
| 01 | [01-runtime-tooling-and-project-setup.md](01-runtime-tooling-and-project-setup.md) | Node 版本管理、npm、lockfile、TypeScript 建置、測試與除錯入口 | 從乾淨環境安裝、建置、執行並跑第一個測試 |
| 02 | [02-modules-packages-and-configuration.md](02-modules-packages-and-configuration.md) | ESM／CommonJS、套件入口、模組解析、環境變數與組態驗證 | 拆分模組；缺少必要設定時能明確啟動失敗 |
| 03 | [03-event-loop-and-concurrency.md](03-event-loop-and-concurrency.md) | 事件迴圈、microtask、I/O、worker pool；併發與平行 | 比較等待與 CPU 阻塞對另一項工作的影響，驗證有限併發 |
| 04 | [04-async-errors-and-resource-lifecycle.md](04-async-errors-and-resource-lifecycle.md) | Promise 錯誤傳播、EventEmitter、取消、逾時與資源清理 | 讓失敗可被測試；結束工作後清理 listener 與 timer |
| 05 | [05-native-http-request-response.md](05-native-http-request-response.md) | 原生 HTTP、method、path、header、body、狀態碼與回應結束 | 做出 GET／POST 小服務，處理無效 JSON、過大 body 與未知路由 |
| 06 | [06-files-buffers-streams-backpressure.md](06-files-buffers-streams-backpressure.md) | fs／path、Buffer、文字編碼、Stream 與 backpressure | 串流匯出資料，處理用戶端中斷；避免一次讀完整個大檔 |
| 07 | [07-process-signals-and-graceful-shutdown.md](07-process-signals-and-graceful-shutdown.md) | 程序生命週期、信號、資源關閉與停止接收新請求 | 服務停止時完成或有界結束進行中的工作，避免直接截斷所有請求 |

**階段驗收**：能用自己的話追蹤一個 HTTP 請求，說明阻塞與等待的差別，並處理錯誤、取消及關閉流程。原生 HTTP 練習到此收束，後續使用框架。

## 第二階段：Express 精華實作（08–13）

目標：完成一個有資料庫、有分層、有測試的 CRUD API，接著帶著具體問題進 NestJS。

| 章節 | 預定檔案 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 08 | [08-express-routing-and-http-contracts.md](08-express-routing-and-http-contracts.md) | app／Router、params／query／body、回應與 REST 契約 | 實作記憶體文章建立、查詢、修改與封存；區分成功、輸入錯誤及版本衝突 |
| 09 | `09-middleware-order-and-input-validation.md` | middleware 順序、next、JSON parser、schema 驗證、請求識別 | 畫出請求經過的函式；拒絕錯誤輸入與不允許修改的欄位 |
| 10 | `10-error-handling-and-api-tests.md` | 同步／非同步錯誤、錯誤 middleware、headers sent、HTTP 測試 | 建立成功與失敗契約測試，確保一次請求只完成一次回應 |
| 11 | `11-postgres-prisma-and-migrations.md` | 最小 Compose 資料庫環境、schema、migration、Prisma、查詢參數化 | 換成 PostgreSQL；重啟後資料仍存在，空資料庫可由 migration 重建 |
| 12 | `12-service-repository-and-manual-di.md` | 拆分 HTTP、業務、資料存取；手動依賴注入與測試替身 | 從肥大路由重構，保留 HTTP 測試；Service 不依賴 req／res |
| 13 | `13-express-capstone-and-migration-baseline.md` | 完成 CRUD 垂直切片、測試資料隔離、遷移前基準與 Express 的使用界線 | 固定 API 契約與測試，列出下一階段要解決的依賴及模組問題 |

錯誤處理章會明確區分 Express 版本差異與非同步來源；Express 5 對回傳 Promise 的 handler 可自動轉交 rejection，但這不代表所有背景回呼錯誤都會自動進入請求錯誤處理。[Express 官方文件](https://expressjs.com/en/guide/error-handling/)

**階段驗收**：能說明 middleware 順序、先驗證再呼叫業務的原因、錯誤如何到達回應，以及資料庫操作如何被測試。Express 僅保留這 6 章主線，進階應用移到 NestJS 與專題階段。

## 第三階段：NestJS 專案架構（14–23）

目標：以既有 Express 實作為對照，學會依賴管理、模組邊界與可測試的業務邏輯。

| 章節 | 預定檔案 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 14 | `14-nest-bootstrap-and-request-lifecycle.md` | bootstrap、decorator／metadata、Controller、adapter 與請求生命週期 | 把一條文章查詢路由遷移成 Nest，讓同一 HTTP 測試通過 |
| 15 | `15-providers-di-tokens-and-scopes.md` | Provider、DI token、useValue／useFactory、非同步初始化與 scope | 把手動組裝改成 DI；用測試替身替換資料存取，解釋 scope 成本 |
| 16 | `16-modules-boundaries-and-dependencies.md` | 功能模組、imports／exports、循環依賴、設定提供方式 | 完成文章 CRUD 遷移；以模組邊界解決依賴問題，保留契約基準 |
| 17 | `17-dto-pipes-and-runtime-validation.md` | DTO、Pipe、轉型、白名單、可選與 nullable、更新語意 | 對照 Express 驗證案例，拒絕越界參數與意外欄位更新 |
| 18 | `18-authentication-sessions-and-guards.md` | 密碼雜湊、Cookie／Session、登入與撤銷、Guard、角色與擁有者權限、CSRF | 加入身分及資料權限矩陣；測試未登入、他人資料、登出與過期 |
| 19 | `19-interceptors-filters-and-cross-cutting-concerns.md` | Interceptor、Exception Filter、回應序列化、最小必要 RxJS | 分清驗證、授權、業務與錯誤呈現；避免洩漏密碼雜湊或內部錯誤 |
| 20 | `20-persistence-transactions-and-concurrency.md` | Prisma Provider、連線生命週期、交易邊界、唯一約束與樂觀鎖 | 文章狀態與稽核紀錄原子提交；用併發測試驗證舊版本更新被拒絕 |
| 21 | `21-api-contracts-pagination-and-openapi.md` | DTO 與回應契約、OpenAPI、分頁／篩選、相容性與查詢成本 | 提供可測試的 API 文件與列表端點，觀察查詢與索引 |
| 22 | `22-testing-modules-database-and-http.md` | TestingModule、Provider 替換、單元／整合／HTTP 測試、資料隔離 | 讓測試連真實 PostgreSQL，驗證交易回滾、權限與並行執行 |
| 23 | `23-external-http-timeouts-and-retries.md` | 外部 HTTP、取消、有限重試、冪等條件與錯誤轉換 | 串接測試用外部服務，模擬慢回應與失敗，確認重試不造成重複副作用 |

Nest 的 middleware、Guard、Interceptor、Pipe 與 Filter 有各自的生命週期與作用範圍；課程會以追蹤日誌及測試比較，避免把所有 Express middleware 都機械式搬成同一類元件。[NestJS 請求生命週期](https://docs.nestjs.com/faq/request-lifecycle)

測試會從 01、10 章開始持續累積，22 章再深化框架測試與資料庫整合。Nest 提供 TestingModule 與依賴替換能力，適合對照前面手動注入的做法。[NestJS 測試文件](https://docs.nestjs.com/fundamentals/testing)

**階段驗收**：遷移階段保留 API 契約；新增功能階段補上驗證、授權、交易與失敗測試。能說明每段程式的職責，以及為什麼某個 Provider 應由某個 Module 擁有。

## 第四階段：專題整合與上線（24–29）

目標：把可運作的 API 交付成可測試、可部署、可觀察的服務。維持模組化單體，先把單一服務的行為與資料處理做好。

| 章節 | 預定檔案 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 24 | `24-logging-health-and-observability.md` | 結構化日誌、request ID、敏感資料遮蔽、健康與就緒檢查、基本指標 | 由一個失敗回應找到對應日誌；資料庫斷線時呈現可判讀狀態 |
| 25 | `25-performance-load-and-resource-limits.md` | 壓測、事件迴圈延遲、CPU／I/O 瓶頸、連線池、併發上限與限流 | 對照 CPU 阻塞、慢 SQL 與外部等待，根據證據選擇改善方法 |
| 26 | `26-build-docker-ci-and-deployment.md` | 正式建置、容器、環境設定、migration 部署步驟、CI、代理與 HTTPS | 從乾淨環境跑起服務與資料庫，執行 migration、測試與部署驗證 |
| 27 | `27-frontend-integration-and-bff-boundaries.md` | 最小前端串接、Cookie／CORS／CSRF、載入錯誤、Next／Nuxt 的 BFF 邊界 | 跑通登入與文章操作；直接呼叫 API 仍不能越權，伺服器金鑰不進瀏覽器 |
| 28 | `28-capstone-feature-integration-and-acceptance.md` | 整合文章、留言、使用者與稽核，逐條驗收使用者故事 | 完成可操作的專題，交付 API 文件、權限矩陣及測試結果 |
| 29 | `29-capstone-failure-drills-and-operations.md` | 關閉流程、資料庫故障、外部逾時、備份恢復、部署回復與操作手冊 | 演練故障與恢復；說明程式回退與資料 migration 的相容限制 |

**專題驗收重點**：

1. 訪客看不到草稿；使用者不能修改別人的文章或刪除別人的留言。
2. 無效資料不會寫入資料庫，錯誤回應也不會洩漏堆疊、憑證或密碼資料。
3. 文章狀態與稽核紀錄要嘛一起成功、要嘛一起回滾。
4. 兩個請求用相同版本更新文章時，衝突能被偵測並回傳可處理的結果。
5. 登出或 Session 到期後，舊憑證無法繼續讀寫受保護資源。
6. 慢外部服務與資料庫故障有明確的等待上限、回應及可追查日誌。
7. 測試能在乾淨資料庫執行；環境、migration 與種子資料有可重現步驟。
8. 程序停止、重新部署與備份恢復都有實際操作紀錄。

## 第五階段：依需求選修（30–33）

以下均以已完成主線專題為前提，另標示直接依賴。先確認問題，再選擇是否加入額外基礎設施。

| 章節 | 預定檔案 | 主題與重點 | 延伸驗收 |
|------|----------|------------|----------|
| 30 | `30-redis-caching-and-invalidation.md` | Redis、公開文章快取、失效、TTL、降級與權限資料隔離 | 更新後不長期讀到舊資料；快取故障時有預期行為 |
| 31 | `31-background-jobs-outbox-and-idempotency.md` | 背景工作、重試、冪等、Outbox 與通知；工具以 Redis 工作佇列為例，需先有 30 的 Redis 操作基礎 | 提交後程序中斷仍可補送通知；重複工作不產生重複業務結果 |
| 32 | `32-sse-websocket-and-connection-lifecycle.md` | SSE／WebSocket、連線驗證、重連、補抓與資源清理 | 文章通知可恢復，斷線後不殘留無限成長的 listener／timer |
| 33 | `33-fastify-adapter-and-platform-boundaries.md` | 換用 Fastify adapter，檢查平台耦合、插件相容與基準測試 | 以同一 API 契約測試確認行為；用量測比較而非只看框架名稱 |

## Express 與 NestJS 的對照方式

| Express 階段的問題 | NestJS 階段對照 | 必須保留的理解 |
|-------------------|----------------|----------------|
| 路由函式處理輸入與回應 | Controller | HTTP 邊界與業務邏輯要分清楚 |
| 手動建立並傳入 Service | Provider／DI token | 依賴誰、由誰建立、測試如何替換 |
| Router 與資料夾整理功能 | Module 的 imports／exports | Module 管理依賴與可見性，不只是換資料夾名稱 |
| 輸入 schema 驗證 | DTO／Pipe | 編譯期型別無法取代執行期驗證 |
| 身分與權限相關處理 | Guard 配合認證／授權服務 | 驗證身分、角色與資料擁有者是不同檢查 |
| 統一錯誤 middleware | Exception Filter | 區分業務錯誤與內部錯誤，保留對外契約 |
| 包住請求的共通處理 | Middleware 或 Interceptor，依責任選擇 | 兩者不完全等價，要看執行時機與需要的上下文 |

每次介紹 NestJS 元件，都會先回看 Express 版本遇到的問題，再說明新的責任分配。Express 階段保留少量、明確的抽象，避免為了模仿 Nest 提早手寫另一套框架。

## 建議讀法與課程篇幅

- **第一次學後端**：依 00–29 順序讀，完成各階段驗收後再前進；選修可留到專題完成後。
- **已寫過 Express API**：先做 Node 基礎實驗，確認阻塞、錯誤與關閉觀念；通過 13 章的分層、資料庫與契約測試驗收後，進 14 章。
- **已熟悉 Spring Boot 或其他後端框架**：優先讀 01–07，Express 08–13 可濃縮成一次 CRUD 與測試練習，再完整閱讀 Nest 的生命週期、DI、scope 與平台差異。
- **以 Next.js／Nuxt 做全端產品**：先用本課建立 Node 與 API 基礎；需要獨立服務或較明確的業務模組邊界時，再接 Nest 主線，27 章提供串接方式。

章節數不等於等長課時。Express 6 章以一個 CRUD 垂直切片為範圍；NestJS 與專題整合合計 16 章，作為主要練習份量。認證與交易章可拆成數次實作，不要求一口氣讀完。

## 每章預定格式

1. 本章目標與前置知識。
2. 一個可觀察的問題或失敗案例。
3. 從簡單版本到改善版本的推導。
4. 本章新增／修改檔案與完整執行步驟。
5. 成功案例、邊界與失敗路徑測試。
6. 常見錯誤、練習與階段驗收。

專題預計保留原生 HTTP 小練習、Express 版與 NestJS 版的可執行快照，並讓遷移階段共用 HTTP 契約測試。這些範例將隨章節逐步建立。

## 與既有課程搭配

| 想補的能力 | 延伸教材 | 建議時機 |
|------------|----------|----------|
| 型別與裝飾器 | [TypeScript](../typescript/README.md) | 開課前與進入 NestJS 前 |
| 資料建模、索引、交易 | [資料庫設計與實戰](../database-course/README.md) | 11、20、21 章前後 |
| Redis 本體 | [Redis 課程](../database-course/redis-course/README.md) | 選修 30、31 前後 |
| 容器、代理與部署 | [Docker](../docker/README.md)、[Nginx](../nginx/README.md)、[CI/CD](../git/ci-cd.md) | 11 章學最小資料庫環境，26 章深入部署 |
| 前端與 BFF | [React](../react/README.md)、[Vue](../vue/basics/README.md)、[Next.js](../react/nextjs/README.md)、[Nuxt](../vue/nuxt/README.md) | 27 章依熟悉的框架擇一串接 |
| 使用者流程測試 | [前端測試](../frontend-testing-course/README.md) | 前端串接與專題驗收階段 |
| 服務拆分與分散式一致性 | [分散式系統](../java/13-distributed-systems/README.md) | 主線專題完成後選讀架構觀念，Java 實作部分可另讀 |

本課先完成可交付的模組化單體。GraphQL、CQRS、Event Sourcing、微服務、Kubernetes 與完整支付系統留作後續專題，避免第一輪同時引入太多框架與維運問題。

---

[返回倉庫課程總覽](../README.md)
