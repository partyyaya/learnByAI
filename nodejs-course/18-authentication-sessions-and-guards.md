# 18 — 密碼雜湊、Cookie／Session、Guard 與資料權限

第 17 章已能驗證輸入，但「title 格式正確」不代表送出請求的人有權修改文章。到目前為止，管理查詢與建立文章都使用固定作者 u_demo；任何能連到 API 的人都能操作他的資料。

本章把固定作者換成經過登入驗證的身分，並讓權限判斷成為明確的規則。主線使用 **Cookie＋PostgreSQL 伺服器端 Session**，實作註冊、登入、登出、到期、CSRF，以及 owner／admin 的文章權限。

完整獨立快照在 [examples/18](examples/18/README.md)，本章刻意變更的 HTTP 契約記錄於 [BASELINE.md](examples/18/BASELINE.md)。前置為 [17 — DTO 與 Pipe](17-dto-pipes-and-runtime-validation.md)，並理解第 12 章 Service／Repository 與第 16 章模組邊界。

## 1. 本章要解決的三個問題

先把問題分開：

| 問題 | 本章答案 | 負責位置 |
|------|----------|----------|
| 這個請求代表誰？ | Cookie 對應有效 Session，再查 User | SessionGuard／AuthService |
| 這個人能做什麼？ | 本人或 admin 才能改文章；管理員入口另外限制 | ArticleService／AdminGuard |
| 瀏覽器是否被別的網站誘導送出寫入？ | 精確 Origin＋Session 綁定 CSRF token | CsrfGuard |

Authentication 是身分驗證；authorization 是授權。登入成功的 member 仍不能修改別人的文章。CSRF 驗證則是另一條防線：就算瀏覽器自動帶了有效 Cookie，也要確認寫入請求符合來源與 token 要求。

完成後，你應能：

- 說明密碼 hash、Session token、CSRF token 的用途和存放位置。
- 用非同步、有成本限制的密碼雜湊，避免明文密碼與快速 hash。
- 追蹤匿名 Session → 登入輪替 → 已登入 Session → 登出／過期。
- 在 Nest Guard 執行請求層的驗證，在 Service 保留資料權限規則。
- 透過真實 PostgreSQL 證明撤銷、回滾、併發登入與文章權限。
- 說明本章可執行範例的限制，而不是把「有登入」視為安全工作的終點。

本章不增加第三方依賴。Node、Nest、Prisma 與 Zod 版本維持前章設定；使用 Node 內建 crypto.scrypt。沒有留言、密碼重設、email 驗證、MFA、前端或正式部署流程。

## 2. 先固定資料權限矩陣

不要從裝飾器開始猜權限。先寫出每個入口允許的行為：

| 操作 | 未登入 | member | admin |
|------|--------|--------|-------|
| 公開列表／單篇 | 只看 published | 只看 published | 只看 published |
| `/api/me/articles` | 401 | 只看自己的全部狀態 | 只看自己的全部狀態 |
| `/api/me/articles/:id` | 401 | 本人 200；他人／不存在 404 | 本人 200；他人／不存在 404 |
| `/api/admin/articles/:id` | 401 | 403 | 任意作者、任意狀態；不存在 404 |
| 建立文章 | 401 | 作者是自己 | 作者是自己 |
| 編輯／發佈／封存 | 401 | 本人可操作，他人 403 | 可操作任意作者 |
| preview | 可用，不寫入 | 相同 | 相同 |
| NDJSON 匯出 | 公開教學檔 | 相同 | 相同 |

這裡的 admin 也不能透過公開端點看到草稿，更不能透過 `/api/me` 讀別人的資料。「我的資料」與「管理員查詢」是兩個不同入口。

所有成功寫入仍要符合版本與狀態規則；admin 不能修改已封存文章，也不能忽略 expectedVersion。沒有永久 DELETE，非法狀態仍沿用 `INVALID_STATE`。

## 3. 密碼不能直接存入 User

資料庫若存明文密碼，一次資料外洩就會直接暴露使用者的登入秘密。把密碼丟進 SHA-256 也不夠：一般快速 hash 的設計目標是快速計算，不適合增加離線猜密碼的成本。

本章使用 scrypt，每次產生獨立的 16-byte 隨機 salt，固定 `N=131072、r=8、p=1`，輸出 64 bytes。OWASP 建議優先使用 Argon2id；不能使用時可採 scrypt，並列出這組約 128 MiB 記憶體成本的參數。本章選擇內建 scrypt，以保留既有依賴並集中解釋成本與驗證流程。[OWASP 密碼儲存指引](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

[password.ts](examples/18/src/password.ts) 存下的格式是：

```text
scrypt$131072$8$1$<32 個 hex 字元的 salt>$<128 個 hex 字元的摘要>
```

驗證時不是把密碼解密：

```text
讀出已儲存的參數與 salt
  → 用收到的密碼重新執行 scrypt
  → timingSafeEqual 比較固定長度結果
  → 相符才通過
```

salt 不需要保密；它讓相同密碼不會產生相同摘要。真正不能洩漏的是原始密碼，摘要也不能當成公開回應欄位。

這個實作只接受固定格式與固定成本，避免資料庫中的任意參數控制計算資源。呼叫非同步 scrypt，並把 maxmem 設為 160 MiB，以容納演算法的額外空間。Node 的非同步 crypto 工作使用 libuv thread pool；非同步不等於沒有 CPU 或記憶體成本。[Node crypto.scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)

本章另限制每個程序最多同時執行兩個 KDF；超額立即回 `503 AUTH_BUSY`，不建立無界等待佇列。這是資源上限，不是完整的登入攻擊防護。

### 密碼與一般文字欄位不同

[auth.schemas.ts](examples/18/src/auth.schemas.ts) 的規則為：

- email 先 trim、轉小寫，驗證格式，最多 254 字元；本課把大小寫視為同一登入識別。
- password 為 15–128 個 Unicode code points，最多 512 bytes。
- password **不 trim、不 normalize**，空白也是密碼的一部分。
- displayName trim 後為 1–80 個 code points。
- 註冊只接受 email、password、displayName，不能送 role、id 或 passwordHash。

本課沒有組合字元種類的要求；也未實作常見／外洩密碼清單。登入與註冊沿用 strictObject、16 KiB JSON 與 UTF-8 限制，欄位錯誤不反射原始值。

## 4. Cookie 裡放什麼？資料庫裡放什麼？

本章的 Session token 是 `randomBytes(32).toString('base64url')`，長度 43 字元。它是隨機憑證，不包含 userId、role 或密碼，也沒有需要解碼的業務內容。

| 資料 | 存放位置 | 用途 |
|------|----------|------|
| 原始密碼 | 註冊／登入請求中短暫使用 | 驗證秘密，不記錄、不回傳 |
| passwordHash | User | 驗證密碼 |
| 原始 Session token | HttpOnly Cookie | 後續請求出示登入憑證 |
| tokenHash | Session 主鍵 | SHA-256 摘要，查找 Session |
| csrfToken | Session 與客戶端取得的 JSON | 綁定同一 Session 的寫入驗證 |
| userId | Session | 匿名時為 null，登入後指向 User |
| expiresAt／revokedAt | Session | 判斷到期與撤銷 |

Session token 具有高熵隨機性，對它使用 SHA-256 作查找摘要，和對人類密碼使用快速 hash 是不同情境。只取得 Session 資料表的摘要，不能直接把摘要當 Cookie 登入。CSRF token 即使存在資料表中，也不能單獨充當登入憑證。

Cookie 是傳輸機制；Session 是伺服器維護的狀態。Cookie 不會自動替應用查資料庫，也不會自動理解使用者權限。

本機 HTTP 使用 `course_session`，設定 HttpOnly、SameSite=Lax、Path=/、Max-Age 與 Expires。HTTPS origin 改用 `__Host-course_session`，加上 Secure、不設定 Domain。HttpOnly 限制 JavaScript 讀取 Cookie；Secure 限制透過安全連線傳送；前綴也有瀏覽器要求的屬性限制。[OWASP Session 指引](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

Cookie 不依 port 隔離。若同一瀏覽器同時操作 127.0.0.1:3018 與後續章的 3019–3023，同名、同 Path 的 Cookie 可能互相覆蓋，即使資料庫 volume 各自獨立。練習不同章時使用各自 curl Cookie jar、不同瀏覽器設定檔，或一次操作一章。Origin 的比較則包含 scheme、host、port，因此 3018 的寫入 Origin 不能拿到 3019 使用。[RFC 6265 的 port 限制](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5)

程式只允許 loopback 使用 HTTP。正式入口必須提供 APP_ORIGIN，例如本章 Compose 的 `http://127.0.0.1:3018`；它是瀏覽器看到的來源，不是容器內的 `http://api:3000`。HTTPS 設定不能關閉 Secure。

## 5. 為什麼登入前就要有 CSRF token？

CSRF 的典型問題是瀏覽器會自動附帶 Cookie。攻擊者不必讀到 Cookie，也可能誘導瀏覽器送出請求。SameSite 能降低一些跨站風險，但本章仍明確驗證 Origin 與 token，不能只依賴 Cookie 屬性。

登入也可能受到 CSRF 影響：攻擊者誘導受害者登入攻擊者控制的帳號，受害者之後可能把資料寫到錯誤帳號。OWASP 說明可使用登入前 Session 搭配 token，登入成功後應建立新 Session，避免直接把登入前的 Session 提升權限。[OWASP CSRF 指引](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

本章的完整流程：

```text
GET /api/auth/csrf
  → 沒有有效 Session：建立 10 分鐘匿名 Session
  → Set-Cookie：匿名憑證
  → JSON：csrfToken

POST /api/auth/login
  → Cookie＋精確 Origin＋X-CSRF-Token
  → Pipe 驗證 email／password
  → scrypt 驗證密碼
  → 交易中撤銷舊 Session，建立新的 30 分鐘 Session
  → Set-Cookie：新憑證
  → JSON：公開使用者資料＋新的 csrfToken
```

若 GET csrf 已帶有效 Session，只回傳該 Session 的 token，不續期、不換 Cookie。此端點與私人回應使用 `Cache-Control: no-store`。本課沒有開啟 CORS，寫入要求來源完全相符；沒有 Origin、`Origin: null` 或相似網域一律不接受。

CSRF token 必須送在 `X-CSRF-Token` header，不從 query 或 body 讀取。它綁定目前 Session，所以另一個 Cookie jar 的 token、登入前的舊 token，均不能拿來替代。

HttpOnly 與 CSRF 防護不會消除 XSS：若攻擊者已能在本站執行 JavaScript，仍可能取得 CSRF token 並發起請求。輸出處理與瀏覽器安全政策需在後續前端／部署階段繼續處理。

## 6. 註冊與登入 Service

[AuthCoreModule](examples/18/src/auth-core.module.ts) 匯入 DatabaseModule，用 factory 組裝 AUTH_REPOSITORY、AUTH_SERVICE，並匯出 Service 與不可變的 AUTH_OPTIONS。

```text
DatabaseModule → AuthCoreModule → AuthModule
                               → ArticlesModule 使用匯出的 Guards
```

Repository 私有；AuthService 不依賴 Nest 或 Express。Controller 只處理 DTO、Cookie 與公開回應。

### 註冊

註冊先 hash 密碼，再新增 User。角色固定 member，即使其他程式直接呼叫 Repository 並夾帶 role，也會被 Repository 的固定值覆蓋。唯一 email 由資料庫索引保證；兩個並行註冊不能靠「先查有沒有」保證唯一性。

成功為 201，回應只有 id、email、displayName、role；不自動登入。重複 email 為 `409 USER_ALREADY_EXISTS`。這會揭露該 email 已被使用，是本課明列的註冊契約；若產品要求隱藏帳號存在性，必須連同註冊／驗證流程重新設計。

### 登入

登入失敗一律回 `401 INVALID_CREDENTIALS`，不區分未知帳號與密碼錯誤。未知帳號也執行相同成本的假摘要驗證，減少明顯的計算時間差；不宣稱整個 HTTP／資料庫流程具有完全相同時間。

成功登入會產生全新的 Session token 與 CSRF token。原子輪替的核心位於 [prisma-auth-repository.ts](examples/18/src/prisma-auth-repository.ts)：

```ts
const old = await tx.session.updateMany({
  where: { tokenHash: previousHash, revokedAt: null, expiresAt: { gt: now } },
  data: { revokedAt: now },
});
if (old.count !== 1) return false;
await tx.session.create({ data: next });
```

這兩步位於同一交易。新 Session 寫入失敗時，舊 Session 的撤銷一起回滾。兩個請求同時使用同一舊 Session 登入，最多一個能完成輪替，另一個回 401；不能建立兩份有效的登入結果。

一個使用者仍可在不同瀏覽器各自登入。本章只撤銷本次帶入的 Session，不提供「登出所有裝置」。

## 7. Guard 的位置與責任

Nest 的 Guard 在路由處理前決定是否繼續，可透過 ExecutionContext 取得 HTTP request 或 handler metadata。它適合表達身分／入口權限，而不是取代所有業務規則。[Nest Guards](https://docs.nestjs.com/guards)

本章採局部、明確的 Guard 綁定：

```ts
@Post()
@UseGuards(SessionGuard, CsrfGuard)
async create(
  @Body(new ZodValidationPipe(draftSchema)) input: CreateArticleDto,
  @CurrentActor() actor: Actor,
) {
  // 把 actor 傳給 Service；不從 body 取得作者。
}
```

概念片段的完整方法見 [articles.controller.ts](examples/18/src/articles.controller.ts)。`@CurrentActor()` 從已解析的 Session 投影 `{ id, role }`，不讓 Service 接觸整個 Request 或 Cookie。

| Guard | 主要工作 | 失敗 |
|-------|----------|------|
| SessionGuard | 查 Cookie 對應的有效 Session，要求 user 存在 | 401 UNAUTHENTICATED |
| CsrfGuard | 驗證精確 Origin 與 Session 的 CSRF token | 403 CSRF_REJECTED |
| AdminGuard | 已驗證使用者必須是 admin | 403 FORBIDDEN |
| AuthThrottleGuard | 登入、註冊、csrf bootstrap 的程序內 IP 限流 | 429 RATE_LIMITED |

SessionGuard 與 CsrfGuard 在同一請求共用查詢 Promise，不重複查兩次資料庫。Cookie 只能有一個符合名稱的有效 token；重複或非法值直接視為沒有 Session。不從 Authorization、query 或 body 接受 Session token。

這不是 JWT Guard；Nest 的認證教學可以幫助理解 Guard 與使用者資料如何傳入 request，但本章的憑證與撤銷流程依上述 Session 設計實作。[Nest Authentication](https://docs.nestjs.com/security/authentication)

### parser、Guard、Pipe 的先後順序

```text
請求與 body middleware
  → JSON／UTF-8／媒體類型／bytes 限制
  → 全域工作追蹤 Guard
  → SessionGuard → CsrfGuard（依路由設定）
  → Interceptor
  → Body／Query／Param Pipe
  → Controller → Service → Repository
  → 回應或 Filter
```

因此，一個未登入但送錯媒體類型的 POST，可能先回 415；合法 JSON 的未登入寫入則回 401。已登入卻缺 CSRF 的請求，會在欄位 Pipe 前回 403。不能把「未登入永遠先回 401」當成所有原始 HTTP 輸入的保證。

公開讀取不套 SessionGuard，即使帶 Cookie 也只使用 public 查詢範圍。preview 不寫入、沒有使用私人身分，仍公開；NDJSON 也是原本的獨立公開教學檔。

## 8. 擁有者權限為什麼留在 Service？

如果 Guard 先查文章並確認作者，Controller 再請 Service 更新，就把資料規則分散到不同時間點。其他呼叫 Service 的入口也可能忘記這項檢查。

[ArticleService.change](examples/18/src/article-service.ts) 接受可信任的 actor，在同一交易中處理：

```text
要求 actor
  → 查找文章
  → 不存在：404
  → 非本人且非 admin：403
  → expectedVersion 不符：409 VERSION_CONFLICT
  → 狀態非法：409 INVALID_STATE
  → 版本達 Int 上限：409 VERSION_LIMIT
  → 帶 id／authorId／version／status 的條件 UPDATE
  → 未匹配：409 VERSION_CONFLICT
```

其他作者即使猜到目前版本，也不能寫入。先檢查授權再檢查版本／狀態，避免把不必要的狀態資訊帶入越權錯誤。管理讀取則把 authorId 放入 Repository 篩選，找不到可見資料回 404。

角色從每個請求的 Session 查詢連帶讀出，不把 role 固定複製到 Session。因此資料庫把 admin 降為 member，下一個請求就會被限制。已開始執行的請求使用當時取得的身分；這不是對進行中交易的即時中止機制。

Actor 是程式內部的可信輸入，不是可讓 HTTP 客戶端任意提交的 DTO。未來新增 worker 或其他入口時，也必須清楚定義誰有權建立這個身分物件。

## 9. 登出、到期與資料清理

POST logout 的正常流程是：

```text
Origin＋CSRF 通過
  → 將目前 Session.revokedAt 設為現在
  → 回傳清除 Cookie 的 Set-Cookie
  → 204，沒有 body
```

只刪瀏覽器 Cookie 不足以撤銷憑證，因為被複製的 Cookie 仍可能存在於別處。伺服器必須讓資料庫中的那份 Session 失效。

若 Session 已不存在、已撤銷或已過期，logout 仍回 204 並清 Cookie；此時不要求已失效的 CSRF token，但**仍要求正確 Origin**。若有效 Session 還存在，缺少 token 仍回 403。請求 body 固定為 JSON `{}`。

登入 Session 為 30 分鐘固定期限，匿名為 10 分鐘。每次使用都由伺服器比較 `expiresAt <= now`，不靠瀏覽器是否還送 Cookie 判斷；讀取不延長期限。

本章沒有背景排程自動刪除舊 Session。到期判斷已使憑證無效，但資料列仍需維運清理。可以在管理工作中分批刪除 `expiresAt <= 現在` 或 `revokedAt IS NOT NULL` 的列，為長期運行安排頻率、批次上限與監控；不可為了清理而刪掉尚有效的 Session。

## 10. 新 migration 與舊資料

[新增 migration](examples/18/prisma/migrations/202610300001_sessions/migration.sql) 保留舊歷史，加入 UserRole、User 的 email／passwordHash／role，以及 Session 表、索引與外鍵。

email、passwordHash 暫時可為 null，讓第 17 章既有使用者與文章能留下。沒有憑證的舊使用者不能登入。seed 的 update 是空物件，不會偷偷替既有 u_demo 設定公開示範密碼，也不會改寫管理員已調整的角色。

本章 Compose 使用自己的新 volume，乾淨 seed 會建立 Alice、Bob 與 admin。若刻意把舊資料庫升級過來，不能期待 seed 自動開通舊帳號；應設計經身分確認的啟用／重設流程。本課未實作該流程，不以刪庫重建代替 migration。

正式入口與 readiness 同時檢查 Article、Session 及 User 認證欄位。只套過舊文章 migration 不算 ready；main 在 listen 前失敗，HTTP readiness 則回 503。

## 11. Docker 啟動與第一次登入

在專案根目錄執行：

```bash
cd nodejs-course/examples/18
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

API 使用主機 3018、PostgreSQL 使用 15418；test-db 不開主機端口。check 依序 generate、型別檢查、Jest、build、程序驗證與前章三個實驗，不能和另一個會刪 `.test-dist` 的 npm test 並行。

Compose 明確設定 `DEMO_AUTH_SEED=1` 才允許示範 seed CLI。以下帳號僅供本機課程，不能帶到正式服務：

| 帳號 | 密碼 | 角色 |
|------|------|------|
| alice@example.test | Alice-course-18! | member，既有文章作者 u_demo |
| bob@example.test | Bob-course-18!! | member，目前沒有文章 |
| admin@example.test | Admin-course-18! | admin，目前沒有文章 |

### 在同一個 shell 依序操作

下面用 Docker 內的 Node 解析 JSON，不要求主機安裝 Node 或 jq。Cookie jar 放在權限受限的暫存目錄；不要把它提交到 Git。

```bash
umask 077
chapter18_dir=$(mktemp -d)
chapter18_origin=http://127.0.0.1:3018
json_value() {
  docker compose run --rm -T tools node -e '
    let text = "";
    process.stdin.on("data", chunk => text += chunk);
    process.stdin.on("end", () => console.log(
      process.argv[1].split(".").reduce((value, key) => value[key], JSON.parse(text))
    ));
  ' "$1"
}

curl -fsS -c "$chapter18_dir/alice.cookies" \
  "$chapter18_origin/api/auth/csrf" > "$chapter18_dir/csrf.json"
chapter18_csrf=$(json_value data.csrfToken < "$chapter18_dir/csrf.json")

curl -fsS -b "$chapter18_dir/alice.cookies" -c "$chapter18_dir/alice.cookies" \
  -H "Origin: $chapter18_origin" -H "X-CSRF-Token: $chapter18_csrf" \
  -H 'Content-Type: application/json' \
  --data '{"email":"alice@example.test","password":"Alice-course-18!"}' \
  "$chapter18_origin/api/auth/login" > "$chapter18_dir/login.json"
chapter18_csrf=$(json_value data.csrfToken < "$chapter18_dir/login.json")

curl -i -b "$chapter18_dir/alice.cookies" "$chapter18_origin/api/auth/me"
curl -i -b "$chapter18_dir/alice.cookies" "$chapter18_origin/api/me/articles/a_draft"
curl -i -b "$chapter18_dir/alice.cookies" "$chapter18_origin/api/articles/a_draft"
```

預期依序是本人資料 200、管理草稿 200、公開草稿 404。登入後一定要更新 Cookie jar 和 CSRF 變數；使用匿名階段的 token 會被拒絕。

### 建立與修改文章

```bash
curl -fsS -b "$chapter18_dir/alice.cookies" \
  -H "Origin: $chapter18_origin" -H "X-CSRF-Token: $chapter18_csrf" \
  -H 'Content-Type: application/json' \
  --data '{"title":" Session 草稿 ","content":" 本文 "}' \
  "$chapter18_origin/api/articles" > "$chapter18_dir/article.json"
chapter18_article=$(json_value data.id < "$chapter18_dir/article.json")

curl -i -X PATCH -b "$chapter18_dir/alice.cookies" \
  -H "Origin: $chapter18_origin" -H "X-CSRF-Token: $chapter18_csrf" \
  -H 'Content-Type: application/json' \
  --data '{"title":"已驗證的修改","expectedVersion":1}' \
  "$chapter18_origin/api/articles/$chapter18_article"
```

建立回 201，作者 u_demo，文字已 trim，version 1；修改回 200、version 2。再送相同 PATCH 會回 409，不能忽略版本條件。

拿掉 `X-CSRF-Token` 再送合法寫入，應回 403；拿掉 Cookie，應回 401。錯誤請求不應改變文章或版本。

### 登出與冪等性

```bash
curl -i -b "$chapter18_dir/alice.cookies" -c "$chapter18_dir/alice.cookies" \
  -H "Origin: $chapter18_origin" -H "X-CSRF-Token: $chapter18_csrf" \
  -H 'Content-Type: application/json' --data '{}' \
  "$chapter18_origin/api/auth/logout"

curl -i -b "$chapter18_dir/alice.cookies" "$chapter18_origin/api/auth/me"
curl -i -H "Origin: $chapter18_origin" \
  -H 'Content-Type: application/json' --data '{}' \
  "$chapter18_origin/api/auth/logout"
```

預期為 204、401、204。重複登出成功不代表舊 Cookie 還有效；自動測試會保留舊憑證再驗證它確實被撤銷。

完成後停止容器並保留 volume：

```bash
docker compose logs --tail 20 api
docker compose stop api postgres test-db
rm -r "$chapter18_dir"
```

## 12. 測試要證明什麼？

[auth.test.ts](examples/18/test/auth.test.ts) 使用原始 Supertest、真正 Session Repository 與隔離 PostgreSQL schema，涵蓋：

- Cookie 屬性、匿名 Session、登入輪替、公開使用者投影與摘要儲存。
- 並行重複註冊、禁止 role 注入、未知帳號與錯誤密碼的統一失敗。
- 未登入、跨作者、admin、自己的管理入口與公開可見範圍。
- Origin、缺少／錯誤／跨 Session／登入前 CSRF token。
- 登出撤銷、重複登出、固定到期、角色降權、刪除帳號。
- 重建 app 後 Session 仍可用、並行登入只成功一次、輪替失敗回滾。
- 限流、舊帳號保留、缺 Session migration 的 readiness。

時間使用注入的 clock 前進，不等待 30 分鐘。交易與唯一鍵測試使用真正 PostgreSQL，Repository 替身不能證明回滾或鎖的行為。

原 32 項文章 HTTP 基準改為先以 Alice 真正登入，再使用附帶 Cookie／Origin／CSRF 的測試客戶端；原業務斷言保留。這是**認證前置條件的契約變更**，兩份契約檔案的 import 已變，不能再宣稱逐位元相同。

Controller／DI 測試另使用明確的 AuthService 替身。固定測試 token 只由替身接受；正式 AuthService 沒有測試後門。安全整合測試不使用自動附憑證的包裝器，因此能驗證匿名請求。

```bash
docker compose run --rm tools npm test -- --testPathPatterns=auth
docker compose run --rm tools npm run test:baseline
docker compose run --rm tools npm run check
```

### Guard 查資料庫後，關閉流程也要跟著調整

以前的 Controller 會把 Service Promise 登記給 shutdown 協調器。現在 Guard 先開始查資料庫，如果客戶端在這時離線，不能只等 socket 關閉，也不能只追蹤 Guard 本身的 Promise。

[request-work.ts](examples/18/src/request-work.ts) 用全域 Guard 登記一份工作，涵蓋 Guard → Pipe → handler。Interceptor 完成時釋放；若 Guard 先拋錯，由既有 Filter 釋放。協調器等所有工作完成後才關資料庫。

Controller 測試用兩個可控制的 Promise，先停在 Session 查詢，再停在後續 handler；中間讓客戶端離線並啟動 shutdown。兩段工作全部結束前，closeResources 都不能執行。這是新增 I/O 後的資源生命週期要求；第 19 章再深入 Interceptor／Filter。

## 13. Session 與 JWT／Bearer 的差異

Cookie 和 Bearer header 是憑證傳送方式；Session 和 JWT 是另一個層面的設計，不能直接把兩組名詞視為互斥配對。

| 面向 | 本章伺服器端 Session | 自包含、簽章驗證的 JWT 常見做法 |
|------|---------------------|--------------------------------|
| 請求帶什麼 | 隨機 opaque token | 含 claims 的 token |
| 每次驗證 | 查儲存狀態、到期與撤銷 | 驗簽與檢查 claims；視需求再查狀態 |
| 登出撤銷 | 資料庫標記失效 | 需設計期限、撤銷名單或其他狀態機制 |
| 角色更新 | 本章每次查 User，下一請求生效 | 若 role 寫在 token 中，需處理舊 claims |
| 成本 | 有共享儲存與查詢成本 | 自包含驗證可減少查詢，但撤銷有額外設計 |

若 JWT 放在自動附帶的 Cookie，仍須處理 CSRF；若 Session token 放在 Authorization header，它仍是 Session 憑證。本章不建立第二套認證模式，也不把 JWT 當成「比較進階就應該換上去」的下一步。

## 14. 本章邊界與練習

限流是每程序、每 remoteAddress、每分鐘最多 20 次 csrf bootstrap／通過 CSRF 的登入或註冊嘗試，最多保留 1000 個活躍來源。X-Forwarded-For 不被信任。多副本部署與反向代理需要另外設計可信代理設定、共享限流、監控與資源上限；本課這個 Map 不提供分散式保證。

此外，登入憑證只用 HTTPS 才能安全跨網路傳送；本章 HTTP 例外限於本機。範例未提供完整帳號復原、帳號停用流程、外洩密碼檢查、MFA、Session 清理排程或安全事件稽核。應用日誌只寫 request ID、狀態、步驟與錯誤分類，不記錄 Cookie、密碼、CSRF 或 request body。

### 練習一：畫出三個憑證的流向

分別追蹤 password、Session token、CSRF token 從產生、傳送、儲存到失效的位置。

驗收：能解釋為什麼密碼用 scrypt、隨機 Session token 用 SHA-256，並指出哪一個值可以在 JSON 回傳、哪一個只能由 Cookie 傳送。

### 練習二：用 Bob 驗證資料權限

使用另一個 Cookie jar 取得匿名 token，再登入 Bob。讀 Alice 的草稿、編輯 Alice 的 published 文章，再建立 Bob 自己的文章。

驗收：公開草稿 404、me 的他人文章 404、寫他人文章 403；新文章作者為 u_bob。拒絕的寫入不改動版本。

### 練習三：驗證 admin 不是跳過所有規則

登入 admin，比較公開、me、admin 三個入口；操作自己的新草稿及 Alice 的草稿，最後嘗試編輯 archived 文章。

驗收：公開仍只見 published；me 仍只見自己；admin 入口可以跨作者；封存與舊版本衝突仍回 409。

### 練習四：觀察輪替與登出

保留登入前的 Cookie／CSRF，再登入；分別用新舊組合請求。登出後故意重送保存的登入 Cookie。

驗收：舊 Session 與舊 CSRF 不再有權執行寫入；登出後原 Cookie 查 me 為 401；無 Session 的重複登出仍為 204。

### 練習五：故障不能留下半份輪替

閱讀實際資料庫測試，讓新 Session 的 userId 違反外鍵，觀察舊 Session.revokedAt。

驗收：整個交易回滾，舊 Session 沒被撤銷；能說明為何只測兩個 mock 函式有被呼叫無法證明這一點。

### 完成檢查

- [ ] User 不存明文密碼，回應與日誌不洩漏密碼／摘要／Session 憑證。
- [ ] 註冊固定 member，建立文章作者來自 Session。
- [ ] 登入更換 Session 與 CSRF，登出在伺服器撤銷。
- [ ] 未登入、他人、admin 與公開／私人查詢均符合矩陣。
- [ ] CSRF 包含登入流程，Origin 必須精確相符。
- [ ] 版本、狀態、16 KiB、UTF-8、串流與 shutdown 保證仍通過。
- [ ] 真實 PostgreSQL 驗證到期、撤銷、唯一性、併發與回滾。
- [ ] 已完成 Docker check、migration、seed 與 Cookie jar 操作。

下一章 [19 — Interceptor、Filter 與回應序列化](19-interceptors-filters-and-cross-cutting-concerns.md)：深入 Interceptor、Exception Filter、回應序列化與最小必要 RxJS，整理已出現的跨請求共用行為。

---

[上一章：DTO 與 Pipe](17-dto-pipes-and-runtime-validation.md) · [返回課程總覽](README.md) · [本章範例](examples/18/README.md) · [本章契約](examples/18/BASELINE.md)
