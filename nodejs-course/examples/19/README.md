# 第 19 章：Interceptor、Filter 與回應序列化

將文章／使用者回應投影接到明確標記路由的 Interceptor，拆開錯誤資料轉換與 HTTP 寫出，並以 APP_FILTER 注入安全錯誤報告器。保留第 18 章 Session、CSRF、角色、文章版本與所有 HTTP 契約。

[教材](../../19-interceptors-filters-and-cross-cutting-concerns.md) · [契約與驗收邊界](BASELINE.md)

同一 host 的 Cookie 不按 port 隔離；同時練習第 18–23 章時，請各用獨立 curl Cookie jar 或瀏覽器設定檔，避免同名 Session Cookie 覆蓋。詳見[Cookie 與章節端口](../../18-authentication-sessions-and-guards.md#4-cookie-裡放什麼資料庫裡放什麼)。

## 從乾淨環境開始

在本目錄執行：

```bash
docker compose build tools
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run db:status
docker compose up -d api
```

主機 API **3019**、開發 PostgreSQL **15419**；容器內 postgres:5432/course。test-db:5432/course_test 不公開主機端口。Compose 專案 nodejs-course-19 與 volume 均獨立於前章。

check 依序 generate、typecheck、283 項 Jest、build、程序驗證、lab:nest、lab:scopes、lab:validation、lab:responses。test:runtime 依賴 `.test-dist`／`dist`，不可與 npm test 並行。修改 src 後重新 build，再重啟 api。

APP_ORIGIN 必須等於外部來源 `http://127.0.0.1:3019`。示範帳號沿用前章：

| 帳號 | 密碼 | 角色 |
|------|------|------|
| alice@example.test | Alice-course-18! | member，u_demo |
| bob@example.test | Bob-course-18!! | member，u_bob |
| admin@example.test | Admin-course-18! | admin，u_admin |

密碼中的 18 沿用前章，不改成 19。seed CLI 需要 DEMO_AUTH_SEED=1（Compose 已設定），只補缺少的本機教學資料，不覆寫既有密碼、角色或文章。不得將公開示範帳號帶到正式服務。

登入流程仍是 GET csrf → 保存匿名 Cookie／token → POST login → 保存新 Cookie／token。完整命令見[前章操作](../../18-authentication-sessions-and-guards.md#11-docker-啟動與第一次登入)，在本目錄執行並將 origin 改為 http://127.0.0.1:3019。私人寫入仍需 Cookie＋Origin＋X-CSRF-Token。

## 正式 API 檢查

```bash
curl -i http://127.0.0.1:3019/health/ready
curl -i 'http://127.0.0.1:3019/api/articles?page=1&pageSize=1'
curl -I http://127.0.0.1:3019/api/articles/a_1
curl -i http://127.0.0.1:3019/api/me/articles
curl -i http://127.0.0.1:3019/responses/ok
```

預期為 200、200、200 且 HEAD 無 body、401、404。列表維持同層 data 與 meta；錯誤是 error＋requestId；獨立 lab 不掛入正式 API。

## 本章的回應處理

```text
parser → 工作追蹤 Guard → Session／CSRF／admin Guards
  → 工作追蹤 Interceptor
  → 回應投影 Interceptor（只處理明確標記的方法）
  → Pipe → Controller → Service／Repository
  ← 公開欄位、日期與 envelope
  → 未處理錯誤：Filter → 純錯誤投影 → HTTP 傳輸出口
```

| 檔案 | 內容 |
|------|------|
| `src/response-projection.ts` | SerializeResponse metadata、Reflector、map 與四個 presenter |
| `src/articles.controller.ts` | 回傳應用結果，以方法裝飾器選擇文章／分頁投影 |
| `src/auth.module.ts` | register／me／login 使用公開使用者投影，保留 Cookie 與 CSRF |
| `src/article-presenter.ts` | 沿用明確文章欄位與 ISO 日期，沒有複製 model 全部欄位 |
| `src/errors.ts` | normalizeError、errorResponse、sendHttpError，保留 Express laboratory 包裝 |
| `src/contract-exception.filter.ts` | Nest 未知路由轉換、DI reporter、Guard 失敗的工作清理 |
| `src/runtime.module.ts`／`src/app.module.ts` | ERROR_REPORTER、APP_INTERCEPTOR 與 APP_FILTER |
| `src/response-lab.ts` | 獨立的三層 Interceptor、Filter 範圍與恢復實驗 |
| `scripts/check-responses.cjs` | 建置後以真實 HTTP 執行實驗 |

投影不修改原始物件；列表 meta 也採白名單。裝飾器的泛型無法自動證明 handler 型別相符，必須測試實際路由。未標記方法保持原結果；preview、health、logout 204、匯出不自動包 data。

Filter 的純資料轉換與 Express 傳輸出口分開；尚未送出才寫 JSON，已送 header 時中止串流，已結束／離線時不再寫。這仍是 Express adapter 的實作，沒有宣稱直接適用其他平台。

## 獨立實驗

```bash
docker compose run --rm tools npm run lab:responses
```

先 build。指令建立獨立 Nest app、隨機端口、真實 HTTP，最後關閉；不連資料庫：

- ok：global → controller → route 進入，成功值反向傳回。
- route-error／controller-error／outside error：只有最近匹配的 Filter 處理。
- denied：Guard 提前拒絕，沒有 Interceptor 事件。
- recovered：catchError 回傳 of，刻意恢復成 200，不進 Filter。
- raw／empty：純文字與 204 不被 JSON 投影改寫。

實驗的 422／LAB_REJECTED 僅供觀察，不是正式 API 契約。正式業務錯誤不以 of 吞掉；沒有全域 timeout 或 retry。

## 測試

```bash
docker compose run --rm tools npm test -- --testPathPatterns=response
docker compose run --rm tools npm test -- --testPathPatterns=rxjs-boundaries
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run check
```

- response-http：向替身結果加內部欄位、巢狀憑證、自訂 toJSON，確認正式 HTTP 只回白名單；另外測投影失敗、DI reporter、Location、204 與 lab 隔離。
- response-lab：作用順序、就近 Filter、Guard 早退、恢復、HEAD、部分傳輸與並行請求隔離。
- rxjs-boundaries：訂閱次數、map／tap、錯誤重拋／恢復、finalize、取消訂閱不取消 Promise，以及安全 details 投影。
- 完整 Jest 共 23 套、283 項：本章新增 31 項（HTTP 16、lab 10、RxJS／錯誤投影 5）。第 18 章的 252 項回歸案例保留，包括真正 PostgreSQL 上的 32 項文章 HTTP 基準、認證／權限、交易、傳輸與關閉競態。

所有資料庫測試仍要求 TEST_DATABASE_URL／course_test，建立自己的隨機 schema 並清理；不操作開發 public。測試替身不能代替真正交易、撤銷與併發驗證。

RequestWorkGuard／Interceptor 沿用前章：Guard 已開始查資料庫時，客戶端離線也不能提前關 pool。RxJS 的 finalize 不是業務成功或 I/O 已取消的證明。

## 固定版本與 audit

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1。Nest common／core／platform-express／testing 11.2.8，reflect-metadata 0.2.2、RxJS 7.8.2。Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

未新增套件，CommonJS／NodeNext、裝飾器設定及 Express 5.3.0／Multer 2.5.0 overrides 沿用。2026-11-02 npm audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），涉及 Jest／glob／minimatch／deepmerge 開發依賴鏈。與前章紀錄不同的是當次 advisory 結果，lockfile 套件版本未變；未執行 audit fix --force。這不是 19 個彼此獨立的漏洞，也不是完整安全稽核。

## 匯出與停止

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3019/api/articles/export -o /tmp/chapter-19-articles.ndjson
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

NDJSON 仍是獨立教學檔，不隨資料庫文章變動，不是資料庫備份。stop 保留資料 volume。


## 驗證紀錄（2026-11-02）

- 完整 check 通過：23 套共 283 項 Jest、型別檢查、build、程序信號與四個 lab。新增 31 項回應投影、作用範圍及 RxJS 邊界案例；前章 252 項繼續通過。
- 開發資料庫沿用兩份 migration，deploy、seed、status 成功；主機 3019 列表為 200，同層 data／meta 及八個文章欄位保持原契約。
- 實際 API 驗證 Alice、Bob、admin 的資料範圍、CSRF、Location、版本衝突與拒絕後資料不變；me 未登入 401、未掛入的 response lab 404，錯誤 requestId 與 header 相符。
- API 與 PostgreSQL 重啟後，原 Session 與文章仍可使用；登出撤銷舊 Cookie，重複登出 204。文章 HEAD 無 body，Content-Length 與 GET 相同。
- NDJSON 20000 筆、3857788 bytes；GET 與原檔摘要相同，HEAD 無 body、bytesRead 為 0，兩者皆關檔。應用日誌未出現示範密碼、Cookie、CSRF 或摘要欄位。
- lab:responses 的實際 trace 證明 before 由外到內、next 由內到外；Guard 提前拒絕不進 Interceptor，Filter 只由最近匹配的範圍處理，catchError 的刻意恢復回 200。
- 測試資料庫殘留 schema 為 0；第 14–18 章共 377 個範例檔案雜湊未變。兩份文章 HTTP 契約、核心 Service／Repository、認證規則、schema、工作追蹤及 shutdown 與第 18 章相同；lockfile 套件節點未變。
- 本章教材、範例 README 與契約文件的本機連結檢查通過；課程總覽及前章下一章連結已更新。
- API、開發 PostgreSQL 與 test-db 均正常停止，退出碼為 0，資料 volume、驗收文章與教學匯出檔保留。未執行 Git staging 或 commit。
