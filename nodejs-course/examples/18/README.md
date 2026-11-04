# 第 18 章：認證、Session、Guard 與資料權限

使用 Cookie＋PostgreSQL Session 實作註冊、登入、登出、期限與撤銷；以 Origin＋Session 綁定 CSRF token 保護寫入，並加入 owner／admin 文章權限。作者不再固定為 u_demo，而是來自經驗證的 Session。

[完整教材與 curl 操作](../../18-authentication-sessions-and-guards.md) · [HTTP 與資料契約](BASELINE.md)

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
curl -i http://127.0.0.1:3018/health/ready
```

主機 API **3018**、開發 PostgreSQL **15418**；容器內 postgres:5432/course。test-db:5432/course_test 不公開主機端口。Compose 專案 nodejs-course-18、node_modules 與資料 volume 均獨立於前章。

check 依序 generate、型別檢查、252 項 Jest、build、程序驗證、lab:nest、lab:scopes、lab:validation。修改 src 後重新 build 並重啟 api；test:runtime 依賴 `.test-dist`／`dist`，不要與 npm test 並行。

正式入口要求 DATABASE_URL 與 APP_ORIGIN；Compose 已設定外部來源 `http://127.0.0.1:3018`。Origin 必須完全一致，不能改用 localhost 卻沿用原設定。HTTPS 使用 Secure 與 __Host Cookie；HTTP 僅允許 loopback。

## 示範帳號與流程

| 帳號 | 密碼 | 角色／資料 |
|------|------|-----------|
| alice@example.test | Alice-course-18! | member，u_demo，原有三篇文章 |
| bob@example.test | Bob-course-18!! | member，u_bob，沒有文章 |
| admin@example.test | Admin-course-18! | admin，u_admin，沒有文章 |

僅供本機課程。seed CLI 需要 DEMO_AUTH_SEED=1（Compose 已設定），只補不存在的資料，不覆寫已有憑證、角色或文章。若升級舊資料庫，原 u_demo 的 nullable 憑證保持空值，不能登入；不要用公開示範密碼替舊帳號自動開通。

```text
GET /api/auth/csrf
  → 保存匿名 Cookie 與 JSON csrfToken
POST /api/auth/login
  → Cookie＋Origin＋X-CSRF-Token＋JSON email/password
  → 保存輪替後 Cookie 與新的 csrfToken
GET /api/auth/me 或 /api/me/articles
  → 帶目前 Cookie
POST／PATCH 文章
  → 帶目前 Cookie＋Origin＋X-CSRF-Token
POST /api/auth/logout
  → 同上，JSON {}，204 並清 Cookie／撤銷 Session
```

完整可複製的命令在[教材第 11 節](../../18-authentication-sessions-and-guards.md#11-docker-啟動與第一次登入)，用 Docker 內 Node 解析 JSON，不要求主機安裝 Node 或 jq。登入後忘記更換 token，下一次寫入會回 403。

先觀察匿名與公開邊界：

```bash
curl -i http://127.0.0.1:3018/api/auth/me
curl -i http://127.0.0.1:3018/api/me/articles/a_draft
curl -i http://127.0.0.1:3018/api/articles/a_draft
curl -i http://127.0.0.1:3018/api/articles/a_1
```

預期 401、401、404、200。admin 經公開入口也只能看 published；`/api/me` 永遠只看本人。跨作者讀取使用 `/api/admin/articles/:id`。preview 仍是公開、不寫入的輸入示範。

## 核心實作

| 檔案 | 重點 |
|------|------|
| `auth.schemas.ts`／`password.ts` | 嚴格欄位、密碼不 trim、非同步 scrypt、每程序最多兩個 KDF |
| `auth-model.ts`／`auth-options.ts` | 公開使用者、Actor、Session、期限與精確 origin |
| `auth-repository.ts`／`prisma-auth-repository.ts` | Session 摘要儲存、原子輪替、撤銷與公開欄位投影 |
| `auth-service.ts` | 匿名 bootstrap、註冊、登入、到期、程序內限流 |
| `auth-http.ts`／`auth.guards.ts` | Cookie、CurrentActor、Session／CSRF／admin／限流 Guards |
| `auth-core.module.ts`／`auth.module.ts` | DI、認證路由、body parser 與 DTO Pipe |
| `article-service.ts`／`prisma-article-repository.ts` | own/public/all 範圍、owner 或 admin、條件 UPDATE |
| `request-work.ts`／`contract-exception.filter.ts` | 從 Guard 到 handler 的完整工作追蹤，避免離線後提早關資料庫 |
| `prisma/migrations/202610300001_sessions/migration.sql` | 增量 migration，保留舊 User／Article |

密碼使用 scrypt N=131072、r=8、p=1，獨立 16-byte salt，64-byte 輸出，maxmem 160 MiB；格式固定，不接受資料庫任意指定成本。Session token 為 32-byte 隨機數，只以 SHA-256 摘要存入資料庫。

匿名期限 10 分鐘，登入期限 30 分鐘，固定到期、不滑動續期。登入撤銷舊 Session 並更換 CSRF；登出在資料庫標記撤銷。缺少／已失效 Session 的 logout 仍為 204，但仍檢查 Origin；有效 Session 必須有 CSRF。

註冊永遠 member；admin 僅由本機示範 seed 建立，沒有公開升權 API。每次 Session 查詢連帶取得目前 User.role，降權影響下一請求。回應不包含 passwordHash、tokenHash 或原始 Session token。

## 契約與測試

- `auth.test.ts`：真正 PostgreSQL 與原始 HTTP 客戶端，驗證匿名、登入、CSRF、權限、撤銷、到期、輪替競態與回滾。
- `auth-unit.test.ts`：密碼 salt／驗證、KDF 上限、輸入 schema 與設定限制。
- 原 32 項文章 HTTP 基準先登入 Alice，保留業務斷言；兩份契約 import 已變，不宣稱逐位元相同。
- `authenticated-test-client.ts` 只供既有已授權案例附憑證。正式 AuthService 不接受固定測試 token；DI 替身在 module-fixture 明確定義。
- `controller.test.ts` 新增 Session Guard 查詢中離線的 shutdown 回歸測試；`article-service.test.ts` 直接驗證 Service 權限，避免僅靠 HTTP Guard。
- 原資料庫、31 項 HTTP／匯出傳輸案例、框架實驗與程序測試繼續執行。

```bash
docker compose run --rm tools npm test -- --testPathPatterns=auth
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run check
```

每個資料庫 suite 僅接受 TEST_DATABASE_URL／course_test，建立隨機 schema，結束時只刪自己的 schema。開發 public 不作測試清理目標。時間測試用注入 clock，不靠長時間 sleep。

## 限制與維運邊界

本章是一個可執行的同源 API 教學範例，沒有開啟 CORS，也沒有 JWT／refresh token 第二條認證流程。HttpOnly 不消除 XSS，CSRF token 也不替代資料權限。

認證限流為每程序每 remoteAddress 每分鐘共 20 次 csrf bootstrap／通過 CSRF 的登入或註冊嘗試，來源表最多 1000 筆；不信任 X-Forwarded-For。多副本與反向代理需要另外設計共享限流與可信來源。本章未提供 email 驗證、密碼重設、MFA、外洩密碼清單或正式部署。

過期／撤銷會立即影響後續驗證，但不自動刪除資料列。長期運行需安排分批清理；本章沒有背景工作。角色降權與登出不會中止已經取得身分的進行中請求。

## 固定版本

Node 24.22.1、npm 11.19.1、TypeScript 5.9.3、Jest 30.2.0、Express 5.3.0、Zod 4.6.7、Supertest 7.3.1。Nest common／core／platform-express／testing 11.2.8，reflect-metadata 0.2.2、RxJS 7.8.2。Prisma CLI／Client／adapter-pg 7.10.1、pg 8.23.1、PostgreSQL 17。

沒有新增套件。CommonJS／NodeNext、裝飾器設定與 Express 5.3.0／Multer 2.5.0 overrides 保留；2026-11-02 複查 npm ci 的 audit 回報 19 個受影響套件節點（3 low、16 moderate，無 high／critical），涉及 Jest／glob／minimatch／deepmerge 開發依賴鏈。advisory 結果會隨時間改變；本次未更改套件或 lockfile，也未執行 audit fix --force。這不是 19 個彼此獨立的漏洞。

## 匯出與停止

```bash
docker compose run --rm tools npm run seed
curl -f http://127.0.0.1:3018/api/articles/export -o /tmp/chapter-18-articles.ndjson
docker compose logs --tail 20 api
docker compose stop api postgres test-db
```

NDJSON 是獨立教學檔，不隨資料庫文章變動，也不是資料庫備份。stop 保留資料 volume，不以 down -v 作一般停止。


## 驗證紀錄（2026-10-30；2026-11-02 完成收尾）

- 2026-10-30 完整 check 通過：20 套共 252 項 Jest、型別檢查、build、程序信號與 Nest／scope／validation 三個實驗。相較前章新增 48 項，涵蓋認證、權限、設定及 Guard I/O 的關閉競態。
- 原 32 項文章 HTTP 基準通過，登入前置改用真正 Cookie／Session，文章業務斷言保留；原 HTTP／匯出傳輸案例繼續通過。
- 開發資料庫兩份 migration、seed、status 均成功；主機端口 3018 的 readiness 為 200。缺少 APP_ORIGIN 或 Session 表時，正式入口拒絕監聽。
- 2026-11-02 實際 API 驗證 Alice、Bob、admin 的公開／me／admin 範圍、CSRF 拒絕、owner 寫入與版本衝突；被拒絕的操作不改變文章。
- API 與 PostgreSQL 正常重啟後，重啟前的 Session 及文章仍可使用；登出後原 Cookie 為 401，重複登出 204。跨日中斷前的文章仍保留，過期 Session 被拒絕。
- 教材第 11 節 Cookie jar、Docker JSON 解析、登入、建立／修改與登出命令已逐段執行，回應符合說明；暫存 Cookie jar 已移除。
- 獨立 NDJSON 為 20000 筆、3857788 bytes；實際 GET 與原檔摘要一致，HEAD 長度相同且無 body。日誌未出現示範密碼、Cookie、CSRF token 或儲存摘要欄位。
- 測試資料庫殘留 schema 為 0。第 14–17 章共 279 個範例檔案雜湊未變；依賴套件節點與第 17 章相同，文件連結檢查通過。
- API、開發 PostgreSQL、test-db 均已正常停止，退出碼為 0；資料 volume、手動驗收文章與教學匯出檔保留。未執行 Git staging 或 commit。
