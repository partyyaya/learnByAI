# 跟 AI 學習的課程

> 這是一個「跟 AI 一起學習」的技術知識倉庫，內容以章節化教材整理，從基礎觀念到實戰落地，幫你建立可持續進步的學習路線。

---

## 這個倉庫有什麼？

- 多條主題課程（演算法、TypeScript、Vue、Nuxt、Browser AI、PWA、Electron、Docker、Nginx）
- 每個主題都有獨立 `README` 與章節路線，適合循序學習
- 內容偏重「實作 + 心智模型」，不是只背指令或 API
- 可依需求走「完整路線」或「針對弱項補課」

## 課程入口總覽

| 主題 | 課程入口 | 內容重點 | 章節數 |
|------|----------|----------|--------|
| 演算法 | [algorithm/README.md](./algorithm/README.md) | 資料結構、回溯、Heap、貪心、圖論與 DP，由基礎到題型應用 | 15 + 2 選修 |
| 通用基礎 | [common/README.md](./common/README.md) | 命令列、CSS、非同步、瀏覽器 API、HTTP、認證與部署 | 12 篇 + 1 示範 |
| TypeScript | [typescript/README.md](./typescript/README.md) | 型別系統、泛型、進階型別、框架整合 | 16 |
| 前端 gRPC | [grpc-frontend-course/README.md](./grpc-frontend-course/README.md) | gRPC-Web、Proto、前後端對接、Streaming 與上線實戰 | 8 |
| Vite 原理與內核 | [vite-course/README.md](./vite-course/README.md) | 建構工具演進、No-bundle Dev Server、依賴預打包、轉換管線、HMR、Plugin、生產建構、Rolldown、手寫 mini-vite | 12 |
| Vue（基礎 / 源碼 / Nuxt） | [vue/README.md](./vue/README.md) | Vue 3 精華橋接、自訂指令、Vue 源碼解析（Reactivity/Renderer/Compiler）、Nuxt 4 全端 | 8 + 12 + 16 |
| Browser AI | [browserAI/README.md](./browserAI/README.md) | WebGPU、ONNX Runtime Web、Transformers.js、Browser LLM | 12 + 1 Deep Dive |
| PWA | [pwa/README.md](./pwa/README.md) | Service Worker、快取策略、推播、部署維運 | 10 |
| Electron | [Electron/README.md](./Electron/README.md) | 桌面應用架構、IPC、安全、打包與自動更新 | 11 |
| Flutter | [flutter-course/README.md](./flutter-course/README.md) | 跨平台 App、Widget 原理、Riverpod、go_router、Dio+Retrofit、Drift、打包上架 | 16 |
| Docker | [docker/README.md](./docker/README.md) | 容器化、Compose、Kubernetes、Swarm、CI/CD | 13 |
| Nginx | [nginx/README.md](./nginx/README.md) | 反向代理、負載均衡、效能、安全與高可用 | 12 |
| Git 與協作 | [git/git.md](./git/git.md) | Git 指令實戰、GitHub 協作、CI/CD 自動化 | 3 文件 |
| Canvas 互動圖形 | [canvas-course/README.md](./canvas-course/README.md) | 渲染模型(immediate/retained)、變換與相機、像素處理、命中測定、場景圖、效能、WebGL/WebGPU、手寫白板 | 12 |
| React | [react/README.md](./react/README.md) | React 與 JS 基礎、TanStack Query、Zustand、可上線專題 | 14 |
| Next.js | [react/nextjs/README.md](./react/nextjs/README.md) | React 全端、App Router、Server Actions、資料庫、認證與部署 | 15 |
| Java 後端 | [java/README.md](./java/README.md) | Java、Spring Boot、REST API、分層、MySQL、認證、Redis、訊息佇列與專題 | 13 個子課程 |
| 前端影音播放器 | [video-player-course/README.md](./video-player-course/README.md) | 編解碼與容器、HLS/DASH/MSE、WebRTC、直播推流、WebCodecs、效能監控 | 14 |
| 圖片加密 | [image-encryption-course/README.md](./image-encryption-course/README.md) | 影像格式、XOR/標頭置亂、WebCrypto AES、Rust WASM、Canvas 渲染加固 | 9 |
| 前端測試 | [frontend-testing-course/README.md](./frontend-testing-course/README.md) | 框架無關測試心法、單元/整合/E2E、可維護可重構可上線 | 14 |
| Cloudflare Pages/Workers | [cloudflare-pages-workers-course/README.md](./cloudflare-pages-workers-course/README.md) | Pages + Workers 部署、串接、儲存選型、CI/CD 自動化 | 11 |
| Python | [python-course/00-what-python-can-do.md](./python-course/00-what-python-can-do.md) | 從零到一的 Python:執行模型、語法、實戰落地 | 38 |
| 資安攻防 | [security-course/README.md](./security-course/README.md) | 駭客思維與法律倫理、隔離實驗室、攻防網路/Linux、OSINT 偵察、主動掃描、Web 攻防(OWASP/Burp/SQLi/注入/XSS)、藍隊防禦、CTF 與授權滲透測試 | 24(已發布 10) |
| 資料庫設計與實戰 | [database-course/README.md](./database-course/README.md) | 資料庫選型、關聯式建模、SQL/交易、索引效能優化、高併發搶票、Redis 快取、NoSQL、搜尋分析、擴展、備份安全與搶票專題 | 11 |

---

## 依工程師方向選擇課程

以下依本倉庫已收錄的教材安排。「核心」是建議優先掌握的能力，「選修」依工作需求補強。先選一條主線完成專題，再擴充工具；React 與 Vue、Next.js 與 Nuxt 都可以先擇一。

| 目標 | 核心學習路線 | 第一個完成目標 |
|------|--------------|----------------|
| 前端工程師 | Web 基礎 → JavaScript／TypeScript → React 或 Vue → API 串接 → 測試與部署 | 可操作、可測試、可上線的前端應用 |
| 後端工程師 | 主力語言 → HTTP／REST API → 分層與資料庫 → 認證授權 → 測試與部署 | 有資料持久化、權限與錯誤處理的 API 服務；本倉庫以 Java／Spring Boot 為主線 |
| Node.js 全端工程師 | 前端基礎 → TypeScript／Node.js 基礎 → Next.js 或 Nuxt → API／資料庫／認證 → 測試與部署 | 從畫面到伺服器、資料庫皆能獨立完成的網站 |

### 三種方向共同需要的基礎

| 能力 | 建議課程 | 學習重點 |
|------|----------|----------|
| 命令列與協作 | [Bash](./common/bash.md) 或 [Windows 命令列](./common/windows.md)、[Git](./git/git.md)、[GitHub 協作](./git/github-collaboration.md) | 檔案與程序操作、分支、合併、衝突處理與程式碼審查 |
| 網路與登入流程 | [HTTP／HTTPS](./common/http-https.md)、[JWT 與前後端認證](./common/jwt-auth-frontend-backend.md) | 請求與回應、狀態碼、Cookie／Token、認證與授權的責任邊界 |
| 資料結構與解題 | [演算法](./algorithm/README.md) | 熟悉主力語言後，先讀 01–05，再依需求補樹、圖、Heap 與 DP；可與專題並行 |
| 上線與持續交付 | [網域、DNS 與 HTTPS](./common/domain-dns-https-nginx.md)、[CI/CD](./git/ci-cd.md) | 網域到服務的請求路徑、自動檢查、建置與部署 |

共通教材中的程式範例可能使用 JavaScript／TypeScript；Java 學習者可先理解概念，再搭配 Java 課程中的實作。

### 前端工程師

目標是能完成頁面、互動、資料串接與測試，並處理載入、錯誤、權限提示與不同螢幕尺寸。

| 順序 | 核心課程 | 建議讀法與驗收 |
|------|----------|----------------|
| 1 | [通用基礎](./common/README.md) 的 CSS、Promise／async-await、HTTP 與瀏覽器 API；[JavaScript 補強](./react/02-javascript-core-for-react.md) | 先能排版、處理事件與非同步請求，再進框架；這些教材屬於補強，完全新手仍需先具備 HTML、CSS、JavaScript 基本語法 |
| 2 | [TypeScript](./typescript/README.md) | 優先完成 01–12，練習資料型別、縮窄、泛型、模組與框架整合；13–16 可後讀 |
| 3 | [React](./react/README.md) 或 [Vue 基礎](./vue/basics/README.md) | 擇一完成元件、表單、路由、狀態管理與 API 串接；能說明 UI 狀態與伺服器資料的差別 |
| 4 | [前端測試](./frontend-testing-course/README.md) | 配合自己的功能練單元、元件、整合與 E2E 測試，包含載入失敗、操作失敗與可近用性 |
| 5 | [Vite](./vite-course/README.md)、[Nginx](./nginx/README.md) | Vite 先讀 00–04 與 08，掌握開發與生產建置；自架站台再讀 Nginx 01–04、06，完成靜態網站與 API 代理部署 |

**建議專題**：完成有列表、搜尋、分頁、表單與登入狀態的管理後台，補上關鍵流程測試並部署。可參考 [React 後台範例](./react/admin-demo/README.md)；其中 API 使用 Mock，串接真實後端時仍需驗證伺服器端權限與錯誤契約。

**依方向選修**：需要 SSR／SEO 時學 [Next.js](./react/nextjs/README.md) 或 [Nuxt](./vue/nuxt/README.md)；離線能力選 [PWA](./pwa/README.md)，桌面應用選 [Electron](./Electron/README.md)，互動圖形選 [Canvas](./canvas-course/README.md)，影音選 [播放器課程](./video-player-course/README.md)，瀏覽器 AI 選 [Browser AI](./browserAI/README.md)。框架與工具原理可再讀 [Vue 源碼](./vue/vue-source/README.md) 與 Vite 後半段。

### 後端工程師（以 Java／Spring Boot 為主線）

後端的共同能力包含 API、資料建模、交易、權限、測試與維運。本倉庫有完整的 [Java 學習地圖](./java/README.md)；若選其他語言，可沿用這些能力目標，再補對應框架的實作。

| 順序 | 核心課程 | 建議讀法與驗收 |
|------|----------|----------------|
| 1 | [Java 核心](./java/01-java-core/README.md) → [Spring Boot](./java/02-spring-boot/README.md) | 掌握集合、例外、測試、建置工具與框架組態，先啟動一個可測試的服務 |
| 2 | [REST API](./java/03-rest-api/README.md) → [Controller](./java/04-controller/README.md)、[Service](./java/05-service/README.md)、[Repository](./java/06-repository/README.md) | 設計資源、驗證輸入、統一錯誤格式，分清 Web、商業邏輯與資料存取責任 |
| 3 | [MySQL](./java/07-mysql/README.md) → [JPA／MyBatis](./java/08-jpa-mybatis/README.md) | 完成建模、JOIN、索引、交易與資料存取；搭配 [資料庫課程](./database-course/README.md) 00–03 補觀念，09 補備份與安全，重複內容可交叉查閱 |
| 4 | [Spring Security](./java/09-spring-security/README.md) | 實作認證與授權，測試未登入、權限不足與越權存取；測試應隨前面各層實作一起加入 |
| 5 | [Docker](./docker/README.md)、[Nginx](./nginx/README.md) | Docker 先完成 01–05，再讀 08–10；Nginx 先讀反向代理、HTTPS、日誌與排錯，部署 API 與資料庫 |
| 6 | [Redis](./java/10-redis/README.md) → [訊息佇列](./java/11-messaging/README.md) → [訂單系統專題](./java/12-capstone/README.md) | 在基本 API 與資料庫可運作後，練習快取失效、冪等、可靠投遞，再完成含測試與監控的整合專題 |

**建議專題**：先交付含登入、權限、CRUD 與交易的單體 API，再逐步完成訂單系統中的庫存、快取、非同步通知與監控。

**依需求選修**：[分散式系統](./java/13-distributed-systems/README.md) 排在單體專題之後；[資料庫課程](./database-course/README.md) 的高併發、搜尋分析與擴展章節依瓶頸選讀。Kubernetes、Swarm 與微服務可在實際需要部署編排或服務拆分時再學。

### Node.js 全端工程師

以 JavaScript／TypeScript 同時處理畫面與伺服器邏輯，建議先選一組搭配：**React → Next.js**，或 **Vue → Nuxt**。

| 順序 | 核心課程 | 建議讀法與驗收 |
|------|----------|----------------|
| 1 | 前端路線的 Web／JavaScript 基礎 → [TypeScript](./typescript/README.md) → [React](./react/README.md) 或 [Vue 基礎](./vue/basics/README.md) | 先能完成頁面與非同步資料串接，熟悉模組、型別與錯誤處理 |
| 2 | Node.js 基礎（需另補，見下方） | 理解事件迴圈、非同步 I/O、模組、環境變數與程序生命週期，能啟動並排查 HTTP 服務 |
| 3 | [Next.js](./react/nextjs/README.md) 或 [Nuxt](./vue/nuxt/README.md) | 按所選框架順序學；Next.js 著重 03、05、07–10，Nuxt 著重 05–11，完成伺服器端資料讀寫、認證與渲染邊界 |
| 4 | [資料庫設計與實戰](./database-course/README.md)、[REST API 設計](./java/03-rest-api/README.md) | 資料庫先讀 00–03 與 09，搭配框架 CRUD 進度學；REST API 課取資源、狀態碼、錯誤與冪等觀念，Java 範例可選讀 |
| 5 | [前端測試](./frontend-testing-course/README.md)＋所選全端框架的測試章節 | 同時驗證畫面與伺服器端輸入、授權、資料異動；再補真實資料庫整合測試，不能只測 Mock 成功回應 |
| 6 | [Docker](./docker/README.md)、[Nginx](./nginx/README.md)、[CI/CD](./git/ci-cd.md) | 完成應用與資料庫部署，處理伺服器環境變數、migration、日誌與健康檢查，再完成全端專題 |

**Node.js 尚需補齊的基礎**：目前倉庫沒有獨立完整的 Node.js、Express／Fastify／NestJS 課程。建議補事件迴圈與阻塞風險、ESM／CommonJS、套件與 lockfile、檔案與 Stream／Buffer、環境變數、錯誤處理、程序關閉及 API／資料庫整合測試。可先用 [Promise／async-await](./common/promise-async-await-then.md) 補非同步觀念，再於實作伺服器時逐項練習；若要開發獨立 API 服務，再選一個後端框架深入。

**建議專題**：從 [Next.js 全端部落格](./react/nextjs/blog-demo/README.md) 或 [Nuxt 全端部落格](./vue/nuxt/blog-demo/README.md) 擇一開始，擴充文章、留言、分頁與角色權限，補上資料驗證、migration、API 整合與 E2E 測試，最後部署。前端路由守衛只處理導覽與體驗，每次讀寫資料仍需由伺服器驗證權限。

**依需求選修**：[Redis](./database-course/redis-course/README.md)、[SSE](./common/sse.md)、[WebSocket](./common/websocket.md) 與 [前端 gRPC](./grpc-frontend-course/README.md)。[Cloudflare Pages／Workers](./cloudflare-pages-workers-course/README.md) 可作邊緣部署方向；Workers 有自己的執行環境與相容性限制，學習時須另外確認 Node API、套件與部署方式是否適用。
