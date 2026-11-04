# 認證、Session 與 Guard：第 18 章契約

本章在第 17 章文章 API 上**刻意新增認證與資料權限要求**。這不是只有框架重構：原本固定作者的公開管理／寫入改成登入後使用可信 actor。原文章狀態、版本、輸入、序列化與傳輸限制持續保留。

## 1. 認證路由

| 路徑 | 方法 | 前置條件 | 成功回應 |
|------|------|----------|----------|
| `/api/auth/csrf` | GET、HEAD | 程序內限流 | 200，data.csrfToken；需要時建立匿名 Session／Set-Cookie |
| `/api/auth/register` | POST | 匿名或登入 Session＋Origin＋CSRF＋限流 | 201，data 為公開使用者；固定 member，不自動登入 |
| `/api/auth/login` | POST | 匿名或登入 Session＋Origin＋CSRF＋限流 | 200，data.user／data.csrfToken；Set-Cookie 輪替憑證 |
| `/api/auth/logout` | POST | 正確 Origin；有效 Session 另需 CSRF；JSON `{}` | 204、無 body，撤銷 Session 並清 Cookie |
| `/api/auth/me` | GET、HEAD | 已登入 Session | 200，data 為公開使用者 |

公開使用者欄位：id、email、displayName、role。回應不帶 passwordHash、tokenHash、原始 Session token。CSRF token 只在 csrf／login 回應中明確提供。

已知路由不支援的方法回 405 並提供 Allow；詳細路徑尾斜線與錯誤大小寫回 404。HEAD 不送 body；GET csrf 的 HEAD 仍可能建立匿名 Session，受同一限流限制。

## 2. Cookie、CSRF 與到期

- 32-byte 隨機 Session token，base64url 43 字元；資料庫僅存 SHA-256 摘要。
- Cookie 是唯一接受的憑證來源，不讀 Authorization、query 或 body。重複 Cookie／非法 token 視為缺少 Session。
- 本機 loopback HTTP 使用 course_session；HTTPS 使用 __Host-course_session 並強制 Secure。兩者皆 HttpOnly、SameSite=Lax、Path=/、有期限、無 Domain。
- APP_ORIGIN 為外部精確 origin，不能包含路徑／尾斜線；正式 main 必須設定。Compose 為 http://127.0.0.1:3018。
- 所有認證與文章狀態寫入都要求精確 Origin＋X-CSRF-Token；preview 公開、不寫入，維持前章行為。
- CSRF token 綁定 Session，必須為合法 43 字元且以 timingSafeEqual 比較。缺少 Origin、null Origin、錯誤 token 回 403 CSRF_REJECTED。
- 匿名 Session 10 分鐘，登入 Session 30 分鐘，固定期限；expiresAt <= now 或 revokedAt 非 null 即失效。Cookie 到期不是伺服器判斷的唯一依據。
- 登入在同一交易撤銷舊 Session、建立新 Session；同一舊 Session 並行登入最多一次成功。
- 登出對缺少、撤銷、過期 Session 都是 204，仍需正確 Origin；有效 Session 缺 CSRF 仍是 403。
- 私人／認證回應由 Guard／handler 設 Cache-Control: no-store。parser 更早拒絕的請求不包含私人資料。
- 本課不開 CORS、不滑動續期、不提供登出所有裝置；過期／撤銷列需要另行安排清理。

## 3. 文章路由與權限

| 路徑 | 方法 | 範圍／成功 |
|------|------|-----------|
| `/health/live` | GET、HEAD | 200，data.status = ok |
| `/health/ready` | GET、HEAD | Article、Session 與 User 認證欄位可讀時 200；否則 503 NOT_READY |
| `/api/articles` | GET、HEAD | 所有人只讀 published，含分頁 metadata |
| `/api/articles` | POST | 登入＋CSRF；作者取自 actor，201、Location 指向 me 單篇 |
| `/api/articles/preview` | POST | 公開、200、修剪後文字＋status:draft＋preview:true，不寫入 |
| `/api/articles/export` | GET、HEAD | 公開、200、獨立 NDJSON 教學檔；缺檔 404 EXPORT_NOT_FOUND |
| `/api/articles/:id` | GET、HEAD | 所有人只讀 published；其他狀態／不存在 404 |
| `/api/articles/:id` | PATCH | 登入＋CSRF；本人或 admin，200 |
| `/api/articles/:id/publish` | POST | 登入＋CSRF；本人或 admin，200 |
| `/api/articles/:id/archive` | POST | 登入＋CSRF；本人或 admin，200 |
| `/api/me/articles` | GET、HEAD | 登入；僅自己的全部狀態，包含 admin |
| `/api/me/articles/:id` | GET、HEAD | 登入；自己的文章 200，他人／不存在 404 |
| `/api/admin/articles/:id` | GET、HEAD | 登入且 admin；任意作者／狀態，存在 200、否則 404 |

admin 經公開入口仍不能讀草稿；me 不作跨作者入口。member 存取 admin 入口一律 403。未登入的私人入口為 401。寫入已存在的他人文章為 403；不存在為 404。

所有文章欄位仍為 id、authorId、title、content、status、version、createdAt、updatedAt；時間為 ISO UTC 字串，ID 為不透明字串。列表為 `{ data: Article[], meta: { page, pageSize, total } }`。沒有永久 DELETE；405／Allow 仍按合法方法回傳。

集合根路徑 `/api/articles/` 沿用原別名；詳細路徑採 strict routing。其他未綁 query schema 的單篇與認證路由忽略 query，但絕不從 query 取得登入憑證。

## 4. 輸入與錯誤優先序

傳輸限制：application/json、UTF-8、16 KiB、不接受壓縮 body，沿用讀取期限。strict JSON 拒絕頂層 null／純量為 INVALID_JSON；陣列可解析但由 Zod 拒絕為 VALIDATION_ERROR。

| 輸入 | 規則 |
|------|------|
| register | email、password、displayName，拒絕未知欄位 |
| login | email、password，拒絕未知欄位 |
| email | trim、小寫、email 格式、最多 254 字元 |
| password | 15–128 code points、最多 512 bytes，不 trim、不 normalize |
| displayName | trim 後 1–80 code points |
| logout | 僅空物件 `{}` |
| create／preview | 僅 title、content；trim 後 1–120／1–4000 code points |
| PATCH | expectedVersion＋至少一個 title／content；省略保留，null 拒絕 |
| publish／archive | 僅 expectedVersion |
| expectedVersion | 正安全整數；不把字串轉數字 |
| 列表 query | 僅 page、pageSize，單一十進位字串；預設 1、20；上限 1000000、100 |
| export query | 不接受任何參數 |

parser 在 Guard 前，因此非法媒體類型可能先回 415；合法 JSON 的私人請求先檢查 Session／CSRF，再執行 Pipe。通過 HTTP 邊界後，文章寫入順序為：

```text
要求 actor → 文章不存在 404 → 無權限 403
  → 版本衝突 409 → 狀態衝突 409 → 版本上限 409 → 條件 UPDATE
```

錯誤 envelope 沿用 `{ error: { code, message, details }, requestId }`，requestId 與 X-Request-ID 相同。VALIDATION_ERROR 細項以 body／query／params 起頭；未知欄位不反射名稱與值。其他錯誤 details 為空陣列。未知錯誤為 500 INTERNAL_ERROR，不回傳 SQL、stack 或連線字串。

| 新增錯誤 | HTTP |
|----------|------|
| UNAUTHENTICATED／INVALID_CREDENTIALS | 401 |
| FORBIDDEN／CSRF_REJECTED | 403 |
| USER_ALREADY_EXISTS | 409 |
| RATE_LIMITED | 429 |
| AUTH_BUSY | 503 |

未知帳號與錯誤密碼回相同 INVALID_CREDENTIALS；未知帳號仍執行假摘要 KDF。註冊重複 email 明確回 409，未隱藏帳號存在性。

## 5. 資料與一致性

UserRole 為 member／admin，註冊 Repository 固定 member。seed 提供三個本機帳號，但 update:{} 不覆寫已有憑證與角色。舊 User 的 email／passwordHash 可為 null，舊文章保留，無憑證帳號不能登入。

Session 外鍵連到 User，刪除 User 時 cascade 刪除其 Session。每次 Session 查詢加入目前 User 公開欄位，不把角色固化在 Session；降權影響下一請求。已取得 actor 的進行中請求不會被自動中止。

密碼 scrypt 成本固定 N=131072、r=8、p=1、keyLength=64、salt=16 bytes、maxmem=160 MiB。每程序最多兩個 KDF，不無界排隊。認證限流使用 remoteAddress，每分鐘共 20 次 csrf／通過 CSRF 的登入或註冊嘗試，最多 1000 個來源；非分散式，不信任 X-Forwarded-For。

| 狀態 | PATCH | publish | archive |
|------|-------|---------|---------|
| draft | 保持 draft | published | archived |
| published | 保持 published | 409 INVALID_STATE | archived |
| archived | 409 INVALID_STATE | 409 INVALID_STATE | 409 INVALID_STATE |

成功寫入 version 加 1；上限 2147483647，達上限回 VERSION_LIMIT。UPDATE 帶 id＋authorId＋version＋status，檢查受影響筆數；SELECT／UPDATE／讀回在同一交易。列表資料與 count 仍使用 RepeatableRead，先篩選再分頁，createdAt DESC、id DESC。

Session 輪替的撤銷與新增共用交易；新增失敗會回滾撤銷。條件更新保證同一舊 Session 的兩個登入不會同時成功。使用者不同瀏覽器可以各自有有效 Session。

## 6. 測試與生命周期

原 api-contract.ts（3 項）與 migration-contract.ts（29 項）保留文章業務斷言，但 import 改成 authenticated-test-client。migration-baseline 在每個案例前真正登入 Alice，故不再是逐位元不變，也不代表匿名仍可操作文章。

安全測試 auth.test.ts 直接使用原始 Supertest 與真正 PostgreSQL，驗證匿名／錯誤憑證和權限矩陣。HTTP／DI 單元測試另使用明確 AuthService 替身；正式認證流程沒有固定測試 token 後門。

auth-unit 驗證密碼、資源上限與設定；controller 新增 Guard 查詢中離線的完整工作追蹤案例；article-service 直接驗證權限。既有資料庫交易、回滾、不同 pool、31 項 HTTP／匯出傳輸案例、Nest／scope／validation 實驗與程序信號檢查繼續執行。

每個資料庫 suite 建立自己的隨機 schema，僅接受 course_test；清理不影響開發 public。到期使用注入 clock，不靠 sleep。缺 Session 表也必須 readiness 503。

全域 RequestWorkGuard 登記 Guard 到 handler 的整段工作；RequestWorkInterceptor 完成時釋放，Guard 失敗由 Filter 釋放。socket 離線不代表工作已結束，關閉仍等 HTTP／工作全部完成後才關 Nest 與資料庫。原 shutdown.ts 未改動。

## 7. 環境與後續邊界

Compose nodejs-course-18，API 3018、PG 15418；版本、lockfile 套件節點與前章相同，沒有新增依賴。main 要求 APP_ORIGIN，並在監聽前檢查認證 migration 可用。

第 00 章最終名稱 INVALID_ARTICLE_STATE 尚未套用，本章保留 INVALID_STATE。留言、稽核交易、快取、背景工作、正式部署與帳號復原尚未實作。

公開 NDJSON 仍是獨立檔案，不是資料庫查詢、匯出或備份。認證章不能讓它悄悄變成暴露私人文章的下載入口。
