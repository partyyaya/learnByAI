# Node.js 後端與全端服務開發：從 Express 到 NestJS

> 先理解 Node.js 如何執行程式與處理 I/O，再用 Express 看清 HTTP 請求流程，最後用 NestJS 練習模組、依賴注入與專案整合。整門課使用同一個「文章與留言管理 API」，讓每一層抽象都有前一階段的實作可以對照。

課程分為 **30 章主線（00–29）與 5 章選修（30–34）**，每章附有教材與可執行範例。

從[第 00 章](00-course-map-and-project-contract.md)開始，依序完成環境準備、實作與章末練習。

每章的 `examples/XX` 都是獨立快照，請在該目錄執行指令；不同章的原始碼、node_modules volume 與資料庫 volume 不共用。初次閱讀從 00 開始；想比較 Express 與 Nest 可對照 13、16；想先操作整合專題，可使用[第 29 章範例](examples/29/README.md)，依其 README 安裝套件、執行 migration 與 seed。

瀏覽器 Cookie 不按 port 隔離；同一 host 下切換章節，登入 Cookie 可能互相覆寫。建議一次操作一章，或使用不同瀏覽器 profile。

Node 的安裝與版本切換使用 nvm；尚未安裝的讀者先完成[第 00 章的 nvm 安裝步驟](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)。專案的套件安裝、測試、建置、API 與資料庫仍使用 Docker，從倉庫根目錄執行：

```bash
cd nodejs-course/examples/01
nvm install
nvm use
node --version
npm --version
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
```

範例使用 Node 24.22.1、npm 11.19.1；找不到 nvm 或 npm 版本不同時，依[第 01 章](01-runtime-tooling-and-project-setup.md#014-先用-nvm-安裝指定版本再用-docker-執行)載入與核對。nvm use 不會改變 Docker 映像內的 Node。

這是一次執行即結束的規則練習；HTTP 服務從 05 開始，PostgreSQL 從 11 開始。11 以後的 check 只建立測試 schema，不替開發資料庫 deploy／seed。本文指令以 Bash／zsh 為主，主機與容器端口依各章 README；不要在倉庫根目錄直接 npm install。同一章的測試／check／程序驗證須依序執行，避免重建編譯產物時互相干擾。

各階段的章節與閱讀順序列於下方；完整操作指令見各章 `examples/XX/README.md`。

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

開始前需要基本 JavaScript 與命令列操作能力，其餘主題依下列章節進入：

| 能力 | 準備與本課銜接方式 |
|------|--------------------|
| JavaScript | 能閱讀物件、陣列與函式；02 章介紹模組，03–04 章練習 Promise 排程、非同步錯誤與取消 |
| TypeScript | 能閱讀基本型別註記；01 章設定型別檢查與建置，09／17 章處理執行期驗證，14 章介紹 Nest 使用的裝飾器與 metadata |
| HTTP 與工具 | 能在終端機執行指令；00–01 章準備 nvm／Node／Docker，05 章從原生 HTTP 說明請求與回應，26 章處理代理與 HTTPS |
| 資料庫 | 11 章從本專題的資料模型、migration 與 CRUD 入手；20 章加入交易與併發，21 章處理分頁與查詢成本 |

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

### 專題功能

| 模組 | 學習內容 | 主要章節 |
|------|----------|----------|
| 使用者與認證 | 註冊、登入、登出、Session 到期與撤銷、密碼雜湊 | 18 |
| 文章 | 草稿、發佈、封存、CRUD、篩選與分頁 | 08–13、20–21 |
| 留言 | 對已發佈文章留言，依本人／管理員權限刪除 | 28 |
| 授權 | 區分訪客、作者與管理員，檢查資料擁有者 | 18、28 |
| 一致性 | 版本衝突、交易回滾、文章狀態與稽核紀錄原子提交 | 11、20 |
| 工程實務 | 測試、OpenAPI、日誌、效能診斷、容器部署與故障恢復 | 10、21–29 |
| 選修擴充 | 公開快取、站內通知、SSE／WebSocket、HTTP 平台與 ORM 比較 | 30–34 |

認證採 Cookie＋伺服器端 Session，Session 存於 PostgreSQL。第 18 章也比較 JWT／Bearer Token 的適用情境；第 27–28 章提供可操作的前端工作台。

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
完成29後，選擇練習方向：
  ├─ 30 Redis → 31 BullMQ／Outbox → 32 SSE／WebSocket
  ├─ 33 Express／Fastify 平台比較（以29為基礎）
  └─ 34 Prisma／TypeORM 對照（以29為基礎）
```

Express 階段的未授權寫入介面只供本機學習。遷移時先維持相同 CRUD 行為，通過原有測試後，再明確新增認證需求與相應測試，避免把架構遷移與業務變更混在一起。

## 本課使用的技術

| 項目 | 採用方式 | 教學理由 |
|------|------|----------|
| 語言與執行環境 | 以 nvm 安裝 Node.js 24.22.1，npm 11.19.1；專案工具與服務使用 Docker，TypeScript 5.9.3 | 以 .nvmrc、映像 digest 與 lockfile 分別固定版本 |
| 模組與建置 | 01 章先用 NodeNext＋CommonJS 建置，02 章比較 ESM／CommonJS | 說清楚原始碼、轉譯結果與 Node 執行的差異；進入 Nest 時再加入裝飾器及 metadata 設定 |
| HTTP 框架 | Express 5 精華 → NestJS，主線使用 Express adapter；33 獨立比較 Fastify | 保留底層平台，讓遷移先專注於架構變化，再檢查平台耦合 |
| 資料庫與 ORM | 主線 PostgreSQL＋Prisma；34 章選修 TypeORM | 框架遷移先保留資料存取，再以獨立範例比較 Entity、Repository、QueryBuilder 與 migration |
| 快取與背景工作 | 30 章 Redis；31 章 BullMQ＋@nestjs/bullmq | 先掌握 Redis 連線、快取與失效，再練習持久化工作、重試、冪等與 Outbox |
| 即時傳輸 | 32 章原生 EventSource＋ws | 共用持久化通知與游標，驗證連線授權、補讀、容量及關閉 |
| 驗證 | Express 使用 schema 驗證；NestJS 示範 DTO／Pipe | 保持對外驗證規則一致，區分 TypeScript 型別與實際輸入檢查 |
| 測試 | Jest＋Supertest；NestJS 加入 TestingModule | 沿用同一測試工具，分開驗證業務邏輯、HTTP 契約與資料庫行為 |
| 執行與部署 | npm scripts、lockfile、Docker Compose、Nginx | 明確區分開發啟動、正式建置、資料持久化與代理設定 |

各章範例已提供版本設定與 lockfile，請依 README 安裝套件並執行。詳細版本見各範例的 `package.json`。

## 第一階段：Node.js 基礎（00–07）

目標：先能解釋程式如何運作，再用框架減少重複工作。

| 章節 | 教材 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 00 | [課程地圖、執行環境與專題契約](00-course-map-and-project-contract.md) | 課程地圖、Node 與瀏覽器的差異、專題需求與 API 契約 | 用 nvm 準備 Node，直接執行環境與規則檢查；畫出系統責任，列出成功與失敗回應 |
| 01 | [Node 版本、npm、TypeScript 建置與專案入口](01-runtime-tooling-and-project-setup.md) | Node 版本管理、npm、lockfile、TypeScript 建置、測試與除錯入口 | 從乾淨環境安裝、建置、執行並跑第一個測試 |
| 02 | [模組、套件入口與環境設定](02-modules-packages-and-configuration.md) | ESM／CommonJS、套件入口、模組解析、環境變數與組態驗證 | 拆分模組；缺少必要設定時能明確啟動失敗 |
| 03 | [事件迴圈、microtask、I/O 與併發](03-event-loop-and-concurrency.md) | 事件迴圈、microtask、I/O、worker pool；併發與平行 | 比較等待與 CPU 阻塞對另一項工作的影響，驗證有限併發 |
| 04 | [非同步錯誤、取消與資源生命週期](04-async-errors-and-resource-lifecycle.md) | Promise 錯誤傳播、EventEmitter、取消、逾時與資源清理 | 讓失敗可被測試；結束工作後清理 listener 與 timer |
| 05 | [原生 HTTP：請求、回應與輸入邊界](05-native-http-request-response.md) | 原生 HTTP、method、path、header、body、狀態碼與回應結束 | 做出 GET／POST 小服務，處理無效 JSON、過大 body 與未知路由 |
| 06 | [檔案、Buffer、串流與背壓](06-files-buffers-streams-backpressure.md) | fs／path、Buffer、文字編碼、Stream 與 backpressure | 串流匯出資料，處理用戶端中斷；避免一次讀完整個大檔 |
| 07 | [程序生命週期、信號與有界關閉](07-process-signals-and-graceful-shutdown.md) | 程序生命週期、信號、資源關閉與停止接收新請求 | 服務停止時完成或有界結束進行中的工作，避免直接截斷所有請求 |

**階段驗收**：能用自己的話追蹤一個 HTTP 請求，說明阻塞與等待的差別，並處理錯誤、取消及關閉流程。原生 HTTP 練習到此收束，後續使用框架。

## 第二階段：Express 精華實作（08–13）

目標：完成一個有資料庫、有分層、有測試的 CRUD API，接著帶著具體問題進 NestJS。

| 章節 | 教材 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 08 | [Express 路由與 HTTP 契約](08-express-routing-and-http-contracts.md) | app／Router、params／query／body、回應與 REST 契約 | 實作記憶體文章建立、查詢、修改與封存；區分成功、輸入錯誤及版本衝突 |
| 09 | [Middleware 順序、next 與輸入驗證](09-middleware-order-and-input-validation.md) | middleware 順序、next、JSON parser、schema 驗證、請求識別 | 畫出請求經過的函式；拒絕錯誤輸入與不允許修改的欄位 |
| 10 | [錯誤處理與 HTTP 契約測試](10-error-handling-and-api-tests.md) | 同步／非同步錯誤、錯誤 middleware、headers sent、HTTP 測試 | 建立成功與失敗契約測試，確保一次請求只完成一次回應 |
| 11 | [PostgreSQL、Prisma 與 migration](11-postgres-prisma-and-migrations.md) | 最小 Compose 資料庫環境、schema、migration、Prisma、查詢參數化 | 換成 PostgreSQL；重啟後資料仍存在，空資料庫可由 migration 重建 |
| 12 | [Controller、Service、Repository 與手動依賴注入](12-service-repository-and-manual-di.md) | 拆分 HTTP、業務、資料存取；手動依賴注入與測試替身 | 從肥大路由重構，保留 HTTP 測試；Service 不依賴 req／res |
| 13 | [Express 專題驗收與 NestJS 遷移基準](13-express-capstone-and-migration-baseline.md) | 完成 CRUD 垂直切片、測試資料隔離、遷移前基準與 Express 的使用界線 | 固定 API 契約與測試，列出下一階段要解決的依賴及模組問題 |

錯誤處理章會明確區分 Express 版本差異與非同步來源；Express 5 對回傳 Promise 的 handler 可自動轉交 rejection，但這不代表所有背景回呼錯誤都會自動進入請求錯誤處理。[Express 官方文件](https://expressjs.com/en/guide/error-handling/)

**階段驗收**：能說明 middleware 順序、先驗證再呼叫業務的原因、錯誤如何到達回應，以及資料庫操作如何被測試。Express 僅保留這 6 章主線，進階應用移到 NestJS 與專題階段。

## 第三階段：NestJS 專案架構（14–23）

目標：以既有 Express 實作為對照，學會依賴管理、模組邊界與可測試的業務邏輯。

| 章節 | 教材 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 14 | [Nest 啟動、裝飾器與請求生命週期](14-nest-bootstrap-and-request-lifecycle.md) | bootstrap、decorator／metadata、Controller、adapter 與請求生命週期 | 把一條文章查詢路由遷移成 Nest，讓同一 HTTP 測試通過 |
| 15 | [Provider、DI token、非同步初始化與 scope](15-providers-di-tokens-and-scopes.md) | Provider、DI token、useValue／useFactory、非同步初始化與 scope | 把手動組裝改成 DI；用測試替身替換資料存取，解釋 scope 成本 |
| 16 | [功能模組、依賴邊界與文章功能遷移](16-modules-boundaries-and-dependencies.md) | 功能模組、imports／exports、循環依賴、設定提供方式 | 完成文章 CRUD 遷移；以模組邊界解決依賴問題，保留契約基準 |
| 17 | [DTO、Pipe、轉型與執行期驗證](17-dto-pipes-and-runtime-validation.md) | DTO、Pipe、轉型、白名單、可選與 nullable、更新語意 | 對照 Express 驗證案例，拒絕越界參數與意外欄位更新 |
| 18 | [密碼雜湊、Cookie／Session、Guard 與資料權限](18-authentication-sessions-and-guards.md) | 密碼雜湊、Cookie／Session、登入與撤銷、Guard、角色與擁有者權限、CSRF | 加入身分及資料權限矩陣；測試未登入、他人資料、登出與過期 |
| 19 | [Interceptor、Exception Filter、回應序列化與最小必要 RxJS](19-interceptors-filters-and-cross-cutting-concerns.md) | Interceptor、Exception Filter、回應序列化、最小必要 RxJS | 分清驗證、授權、業務與錯誤呈現；避免洩漏密碼雜湊或內部錯誤 |
| 20 | [Prisma Provider、連線生命週期、交易與併發](20-persistence-transactions-and-concurrency.md) | Prisma Provider、連線生命週期、交易邊界、唯一約束與樂觀鎖 | 文章狀態與稽核紀錄原子提交；用併發測試驗證舊版本更新被拒絕 |
| 21 | [API 契約、分頁／篩選、OpenAPI 與查詢成本](21-api-contracts-pagination-and-openapi.md) | DTO 與回應契約、OpenAPI、分頁／篩選、相容性與查詢成本 | 提供可測試的 API 文件與列表端點，觀察查詢與索引 |
| 22 | [TestingModule、資料庫、HTTP 測試與資料隔離](22-testing-modules-database-and-http.md) | TestingModule、Provider 替換、單元／整合／HTTP 測試、資料隔離 | 讓測試連真實 PostgreSQL，驗證交易回滾、權限與並行執行 |
| 23 | [外部 HTTP、期限、取消、有限重試與冪等條件](23-external-http-timeouts-and-retries.md) | 外部 HTTP、取消、有限重試、冪等條件與錯誤轉換 | 串接測試用外部服務，模擬慢回應與失敗，確認重試不造成重複副作用 |

Nest 的 middleware、Guard、Interceptor、Pipe 與 Filter 有各自的生命週期與作用範圍；課程會以追蹤日誌及測試比較，避免把所有 Express middleware 都機械式搬成同一類元件。[NestJS 請求生命週期](https://docs.nestjs.com/faq/request-lifecycle)

測試會從 01、10 章開始持續累積，22 章再深化框架測試與資料庫整合。Nest 提供 TestingModule 與依賴替換能力，適合對照前面手動注入的做法。[NestJS 測試文件](https://docs.nestjs.com/fundamentals/testing)

**階段驗收**：遷移階段保留 API 契約；新增功能階段補上驗證、授權、交易與失敗測試。能說明每段程式的職責，以及為什麼某個 Provider 應由某個 Module 擁有。

## 第四階段：專題整合與上線（24–29）

目標：把可運作的 API 交付成可測試、可部署、可觀察的服務。維持模組化單體，先把單一服務的行為與資料處理做好。

| 章節 | 教材 | 主題與重點 | 章末實作／驗收 |
|------|----------|------------|----------------|
| 24 | [結構化日誌、request ID、敏感資料遮蔽、健康／就緒與基本指標](24-logging-health-and-observability.md) | 結構化日誌、request ID、敏感資料遮蔽、健康與就緒檢查、基本指標 | 由一個失敗回應找到對應日誌；資料庫斷線時呈現可判讀狀態 |
| 25 | [壓測、事件迴圈延遲、CPU／I/O 瓶頸、連線池與資源上限](25-performance-load-and-resource-limits.md) | 壓測、事件迴圈延遲、CPU／I/O 瓶頸、連線池、併發上限與限流 | 對照 CPU 阻塞、慢 SQL 與外部等待，根據證據選擇改善方法 |
| 26 | [正式建置、容器、migration 部署步驟、CI、代理與 HTTPS](26-build-docker-ci-and-deployment.md) | 正式建置、容器、環境設定、migration 部署步驟、CI、代理與 HTTPS | 從乾淨環境跑起服務與資料庫，執行 migration、測試與部署驗證 |
| 27 | [最小前端、Cookie／CORS／CSRF、載入錯誤與 BFF 邊界](27-frontend-integration-and-bff-boundaries.md) | 最小前端串接、Cookie／CORS／CSRF、載入錯誤、Next／Nuxt 的 BFF 邊界 | 跑通登入與文章操作；直接呼叫 API 仍不能越權，伺服器金鑰不進瀏覽器 |
| 28 | [專題功能整合：留言、管理端與完整驗收](28-capstone-feature-integration-and-acceptance.md) | 整合文章、留言、使用者與稽核，逐條驗收使用者故事 | 完成可操作的專題，交付 API 文件、權限矩陣及測試結果 |
| 29 | [專題故障演練、備份還原與操作手冊](29-capstone-failure-drills-and-operations.md) | 關閉流程、資料庫故障、外部逾時、備份恢復、部署回復與操作手冊 | 演練故障與恢復；說明程式回退與資料 migration 的相容限制 |

**專題驗收重點**：

1. 訪客看不到草稿；使用者不能修改別人的文章或刪除別人的留言。
2. 無效資料不會寫入資料庫，錯誤回應也不會洩漏堆疊、憑證或密碼資料。
3. 文章狀態與稽核紀錄要嘛一起成功、要嘛一起回滾。
4. 兩個請求用相同版本更新文章時，衝突能被偵測並回傳可處理的結果。
5. 登出或 Session 到期後，舊憑證無法繼續讀寫受保護資源。
6. 慢外部服務與資料庫故障有明確的等待上限、回應及可追查日誌。
7. 測試能在乾淨資料庫執行；環境、migration 與種子資料有可重現步驟。
8. 能實際演練程序停止、重新部署與備份恢復。

## 第五階段：依需求選修（30–34）

以下均以已完成主線專題為前提，另標示直接依賴。先確認問題，再選擇是否加入額外基礎設施。

| 章節 | 教材 | 主題與重點 | 延伸驗收 |
|------|----------|------------|----------|
| 30 | [Redis 快取與失效](30-redis-caching-and-invalidation.md) | Redis Docker、Node client／Nest Provider、cache-aside、key／TTL、失效、降級與權限資料隔離 | 公開文章快取可觀察命中與失效；更新／封存不持續回舊資料，Redis 中斷可降級 |
| 31 | [BullMQ、Outbox 與冪等](31-background-jobs-outbox-and-idempotency.md) | BullMQ／@nestjs/bullmq、Queue／Worker、重試與 backoff、併發、冪等、Outbox、關閉與失敗工作；先完成 30 | 發佈文章後可靠排入通知工作；worker 重啟可恢復，重複投遞不重複建立業務通知 |
| 32 | [SSE／WebSocket 與連線生命週期](32-sse-websocket-and-connection-lifecycle.md) | SSE／WebSocket、連線驗證、游標補抓與資源清理 | 實作可補讀的本人通知，處理登入到期、斷線與服務關閉 |
| 33 | [Fastify adapter 與平台比較](33-fastify-adapter-and-platform-boundaries.md) | Fastify adapter、平台耦合、插件相容與基準測試 | 以相同 API 契約比較兩平台，量測相同負載下的行為 |
| 34 | [TypeORM 與 Prisma 對照](34-typeorm-entities-repositories-and-migrations.md) | Entity、DataSource、Repository／QueryBuilder、獨立 migration 與交易 | 以相同業務契約實作 TypeORM，練習 migration、交易回滾與併發更新 |

30→31→32 為累積路線，依序加入公開快取、站內通知與通知畫面。33、34 各以29為基礎，分別比較 HTTP 平台與 ORM，可在主線結束後各自選讀。34 使用自己的資料庫與 migration 歷史，執行時請依該章 README 設定。

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

## 如何進行每章練習

1. 先閱讀本章目標、前置章節與問題情境。
2. 在對應的 `examples/XX` 目錄，依 README 安裝套件、建置並啟動服務。
3. 觀察成功與失敗路徑，執行測試，對照程式的輸入、輸出與資源清理。
4. 完成章末練習與驗收，再進入下一章。

第 00 章提供單一規則練習；01–34 各有獨立範例。比較章節時請使用各自的目錄與操作步驟。同一章的測試、建置與程序練習請依序執行。
