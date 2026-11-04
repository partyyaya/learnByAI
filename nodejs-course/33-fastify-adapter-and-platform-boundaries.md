# 33 — Fastify adapter、平台邊界與契約比較

> 平台替換的第一個問題是原 API 是否仍正確；效能比較要等契約一致後才有意義。

前置：[13 遷移基準](13-express-capstone-and-migration-baseline.md)、[16 Nest 模組](16-modules-boundaries-and-dependencies.md)、[25 效能](25-performance-load-and-resource-limits.md)、[29 主線完成](29-capstone-failure-drills-and-operations.md)。[本章獨立快照](examples/33/README.md)**從 29 分支**，保留 Prisma 與 PostgreSQL，不包含 30–32 的 Redis、Outbox 或即時通知。

新增 @nestjs/platform-fastify **11.2.8**、Fastify **5.11.3**、@fastify/cookie **11.0.2**；保留 platform-express 以比較。Nest 各平台套件使用相同版本，不直接以最新版替換 lockfile。

## 33.1 Nest 沒有消除 HTTP 平台差異

Nest 提供 Controller、DI、Guard、Pipe、Interceptor 與 Filter，但底層 request、reply、路由器、body parser、Cookie 及檔案 API 仍有平台差異。官方切換入口是 FastifyAdapter；依賴 Express API 的程式仍須調整。[Nest 官方 Fastify 說明](https://docs.nestjs.com/techniques/performance)

| 層次 | 本章處理 |
|------|----------|
| Article Service／Repository | 保留業務規則、Prisma 與交易 |
| Nest Controller／Guard／Filter | 經小型 ResponsePort 接平台回應 |
| Request body／URL／錯誤 | 保留原限制與安全錯誤契約，明確設定解析順序 |
| Cookie | Express writer 與 Fastify cookie plugin 各自組裝 |
| HTTP listener／串流 | 使用原生 Node request／response 接生命週期 |
| 正式入口 | fastify-main，與原 Express 入口分開 |

不應只改 import，再用 any 壓過型別錯誤。原生物件有哪些能力，是介面設計與驗證的一部分。

## 33.2 先盤點平台耦合

在 [http-platform.ts](examples/33/src/http-platform.ts)觀察：

- 原本 `res.status().json()`、location、header、Cookie 封裝為小型 ResponsePort。
- Fastify 的 `reply.raw` 是 Node ServerResponse，需直接串流時明確 hijack。
- Cookie maxAge 原 Express 以毫秒表示，Fastify cookie plugin 以秒表示；轉換不能遺漏。
- rawRequest 提供 socket、取消與傳輸狀態；不把 FastifyRequest 強制當成完整 Express Request 使用。
- 正常 FastifyReply 與 parser middleware 出錯時的原生 ServerResponse 是不同情況，錯誤出口兩者都要處理。

ResponsePort 只列目前需要的操作，沒有仿造完整 Express API。測試替身也要提供它實際使用的介面，不能假設只含 location 的物件就是完整 response。

## 33.3 真正使用 Fastify 的入口

[application.ts](examples/33/src/application.ts)接受可信組裝選項 `platform`，Express 為既有比較基準；[fastify-main.ts](examples/33/src/fastify-main.ts)明確指定 Fastify。dev Compose 與交付映像都啟動 fastify-main，不以回應 header 猜測平台。

[fastify-server.ts](examples/33/src/fastify-server.ts)使用真正 NestFastifyAdapter。原生 Node serverFactory 接原有 request ID、metrics、drain 與錯誤觀測；Nest 仍負責實際 API 的 Controller／Guard／Pipe。

保留 server.ts 作 Express 比較入口，並不代表兩套服務同時占用 3033。

## 33.4 Body parser 與錯誤順序

本課既有契約限制 JSON body 16 KiB、只接受指定 JSON media type，並有固定的 INVALID_JSON、PAYLOAD_TOO_LARGE 等錯誤。本章沿用已測試的有界 body consumer，透過 Fastify 的 middleware 支援整合；移除預設重複解析，再把已解析 body 交給 Fastify／Nest。

這是為了比較同一份既有契約所做的明確相容層。新 Fastify 專案可從原生 content-type parser 設計，不能直接套用本章設定並假設任意外掛都相容。

順序要回答四件事：

1. request ID 與 observability 在何時建立？
2. body 是由誰讀取，是否可能讀兩次？
3. parser 的 SyntaxError 在 Nest 轉成一般錯誤前，在哪裡正規化？
4. 原生錯誤與 Controller 錯誤是否都回同樣安全的 envelope？

本章明確拒絕不合法的 percent encoding，避免 Fastify 的預設路由錯誤覆蓋 `400 INVALID_URL` 契約。資料庫、密碼雜湊與 stack 都不出現在 HTTP body。

## 33.5 方法、尾斜線與靜態檔

Express 的 GET 加 all fallback 與 Fastify 重複註冊的處理不同。adapter 的 all 僅註冊尚未占用的方法；否則 GET／HEAD 可能因重複 route 在啟動時失敗。

仍維持：

```text
GET /api/articles/       → 正規化為既有 collection
GET /api/articles/id/    → 404
HEAD 已有查詢            → 同 status／headers，無 body
不支援的方法             → 405，指定 Allow
```

[frontend.ts](examples/33/src/frontend.ts)以固定 allowlist、非同步 readFile 提供小型工作台檔案，不使用 Express sendFile。保留 MIME、CSP、no-store 與 HEAD。沒有公開任意檔案路徑或新增 Range 下載契約；NDJSON 匯出仍使用原有有界串流流程。

## 33.6 業務契約不能隨平台變動

[platform-contract.test.ts](examples/33/test/platform-contract.test.ts)對兩個平台各啟動真正 HTTP server、獨立 PG schema 與 Cookie jar，各執行相同 33 項驗證，共 66 項：

- 共用 articleContract 與 migrationContract：文章 CRUD、版本、狀態、權限、JSON 限制、HEAD、尾斜線及匯出。
- Cookie／CSRF、留言擁有者與 admin 邊界、狀態稽核及安全 metrics。

完整 check 也保留原有單元／HTTP／DB／生命週期驗證。這 66 項是共用契約的覆蓋範圍，不表示每個歷史實驗都在 Fastify 下各執行兩次。原 Express 教學實驗保留原平台。

測試不是比較回傳字串一樣就算完成；例如兩個作者同時修改時，仍只能有一個 expectedVersion 成功。平台切換不能繞過 Service 的判斷或 SQL 條件更新。

## 33.7 以同一工作量量測

```bash
docker compose run --rm tools npm run lab:platform
```

[比較腳本](examples/33/scripts/check-platform-comparison.cjs)各以新 child process 啟動 Express 與 Fastify，使用相同 seed、公開文章 PG 列表、五次暖身、40 次請求、併發 4。每次確認 200 與相同資料筆數，輸出：

```text
.data/platform-comparison.json
  elapsedMs／p50Ms／p95Ms
  successes／requests／concurrency
  eventLoopUtilization／eventLoopDelayMaxMs
```

腳本固定先 Express 再 Fastify；正式比較應增加多輪並交錯順序，控制 PG 快取與背景負載，避免把順序效應當成平台差異。

它沒有速度通過門檻。40 次樣本只適合確認比較流程與觀察局部差異；p95 受樣本數、KDF 初始化後的資源、容器排程、PG 與其他程序影響。要下容量結論，需增加多輪隔離測量、不同工作負載與資源曲線。

若 API 主要等待資料庫，換 router 不會消除 DB 等待；若 CPU 密集，框架吞吐差異也不會讓同步計算離開事件迴圈。配合第 25 章的 CPU profile／event loop／失敗率一起解讀。

## 33.8 操作與交付

在 `examples/33` 依 README 初始化後：

```bash
docker compose up -d api
docker compose run --rm browser-tests npm run test:browser
sh ci/check.sh
```

開發入口 `http://127.0.0.1:3033/`；正式 HTTPS `https://localhost:34433/`。Chromium 啟動的也是 Fastify 組裝，檢查登入、版本衝突、留言、重新登入、CORS 與輸入保留。TLS verifier 驗證交付映像的實際 API、Secure Cookie、CSRF 與重啟持久化。

runtime 檢查確認啟動 fastify-main、非 root／唯讀與編譯閉包；migration 仍獨立使用 Prisma release job。沿用 29 的故障／備份隔離驗證，沒有在 API 啟動時自動 migration。

OpenAPI 仍為 **28.0.0、21 paths／38 operations**。套件或平台改變本身不需要改業務 API 版本；若有可見契約變更才另行決定。

## 33.9 常見錯誤與練習

| 現象 | 檢查位置 |
|------|----------|
| 啟動報重複 route | GET／HEAD 與 all 的註冊方法 |
| Cookie 登入後立刻失效 | maxAge 單位、Secure／Origin 與 plugin 註冊 |
| malformed JSON 回不同 body | parser → adapter error handler → Nest filter 的順序 |
| 匯出重複回應或沒有結束 | reply hijack、原生 res 與 drain |
| 型別通過但測試替身失敗 | ResponsePort 需要的實際方法 |

1. 刪掉 Fastify 指定，證明預設仍跑 Express；再確認正式 entrypoint 明確啟動 Fastify。
2. 對兩平台送 malformed JSON、錯誤 URI、HEAD、過大 body 與錯誤 Origin，逐項對照 status／headers／body。
3. 讀取比較 JSON，說明哪些數字能支持結論、哪些需要更多測量。
4. 新增依賴平台功能前，列出本課相容層與外掛的責任，補相應契約測試。

[上一章](32-sse-websocket-and-connection-lifecycle.md) · [下一章：TypeORM](34-typeorm-entities-repositories-and-migrations.md) · [課程總覽](README.md) · [範例](examples/33/README.md) · [契約](examples/33/BASELINE.md)
