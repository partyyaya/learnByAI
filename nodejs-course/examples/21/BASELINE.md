# API 契約、分頁／篩選與 OpenAPI：第 21 章契約

本章以[第 20 章契約](../20/BASELINE.md)為基準。文章寫入、狀態稽核原子性、認證／權限、回應投影、錯誤與傳輸限制均保留；擴充兩個列表的 query，新增公開 OpenAPI 文件端點及隔離查詢實驗。沒有新 migration 或套件。

## 1. 列表 query

| 參數 | 公開 /api/articles | 本人 /api/me/articles | 契約 |
|------|--------------------|---------------------|------|
| page | 可 | 可 | 單一十進位字串，轉數字後 1–1000000，預設 1 |
| pageSize | 可 | 可 | 同上，1–100，預設 20 |
| q | 可 | 可 | trim 後 1–80 Unicode code points，不含 NUL；不 normalize |
| sort | 可 | 可 | newest／oldest，省略為 newest |
| status | 不可 | 可 | draft／published／archived，省略為本人全部狀態 |

未知參數、重複參數、空 q、非法 sort／status 都是 400 VALIDATION_ERROR。公開 status=published 也拒絕；authorId 永遠不能指定。私人列表仍先要求登入，再驗證 query。

q 只搜尋 title，不搜尋 content；採 PostgreSQL ILIKE 的大小寫規則，非全文、模糊或重音正規化搜尋。%、_、反斜線均逃脫為字面值，不讓 q 提供 wildcard。SQL 值參數化，排序只從固定 enum 選擇。

newest 為 createdAt DESC、id DESC；oldest 為兩欄 ASC。不開放任意欄位排序。兩欄共同打破平手，不承諾 ID 有語意或符合人類字典序。

## 2. 可見範圍、分頁與 metadata

```text
公開 published／本人 authorId 固定範圍
  AND 可選 status AND 可選 title 搜尋
  → 固定排序 → skip／take
  → 相同 where 的 count
  → 同一 RepeatableRead 快照回 data＋meta
```

公開資料與 total 永遠只有 published，admin 也相同；me 永遠只看登入本人，admin 不例外。Repository 以 AND 相交，不讓外部 status 覆寫固定範圍。單篇與 admin 單篇端點不變，沒有 admin 集合入口。

回應維持 `{ data: Article[], meta: { page, pageSize, total } }`，不增加 echo query 或 cursor。total 是篩選後筆數，越界頁回空 data 但保留 total。篩選先於分頁，不能先取公開前 20 筆再於記憶體搜尋。

RepeatableRead 只涵蓋一次列表請求；不同頁的請求間新增／狀態變更仍可造成重複或跳筆。頁碼與 pageSize 上限也不是 SQL 成本保證；深 offset、精確 count 與子字串搜尋仍可能掃描大量資料。

## 3. OpenAPI 文件

- GET／HEAD /api/openapi.json 公開，handler 不查資料庫，沒有 Swagger UI；正式 main 仍保留必要資料庫的啟動檢查。
- 回傳 OpenAPI 3.1.1 原始物件，不包 data；GET 含 X-Request-ID，HEAD 無 body 且 Content-Length 與 GET 相同。
- 僅接受空 query，其他參數 400；不支援的方法 405、Allow: GET, HEAD；尾斜線與錯誤大小寫 404。
- 文件涵蓋 17 個 path、30 個 operation，包含既有 health、認證、文章、HEAD、NDJSON 與文件自身。
- components 明列文章、分頁、公開使用者、body、錯誤；additionalProperties:false 限定本課 JSON envelope 的已知欄位。
- Request body 的 trim、code point／byte 限制，以及權限、錯誤優先序以 description 補充；不假裝所有執行期行為都能由 JSON Schema 表達。
- Cookie 與 CSRF 在同一 security requirement 代表 AND；本機 course_session／HTTPS __Host-course_session 為替代的 OR。Origin 另外是必填 header。
- register／login 的 Cookie 可為匿名 Session；logout 允許缺 Session，仍需 Origin，有效 Session 另需 CSRF。HEAD csrf 仍可能建立匿名 Session。
- JSON 寫入 16 KiB、UTF-8、媒體類型與讀取期限沿用；HEAD／204 不宣稱有 response content。
- servers 使用同源 `/`。info.version=21.0.0 是文件版本，不新增 /v21 路徑或自動版本協商。

openapi.ts 明確維護 wire 契約，沒有從 TypeScript 型別反射出驗證器，也沒有用它替代 Guard／Pipe。檔案匯出為 .data/openapi.json，與 HTTP 內容一致；不含真實 Cookie、CSRF、密碼或連線字串。

## 4. 測試及相容性

完整 Jest 27 套、339 項。原 304 項保留，新增 list-query 25、openapi 10；原 32 項文章 HTTP 基準繼續通過，api-contract.ts／migration-contract.ts 與第 20 章逐位元相同。

新增案例包括 Unicode／重複／非法 query、字面 wildcard、搜尋只含 title、先篩選再分頁、admin／owner 範圍、穩定排序、跨請求 offset 推移、HEAD、文件內容及 Controller metadata 對照、$ref／operationId、Cookie＋CSRF 與實際 HTTP schema 對照。

test/openapi-contract.ts 只驗證本課用到的 JSON Schema 子集（型別、required、白名單、ref、enum、const、陣列、長度、數值界線、pattern、日期與 anyOf）。它不是完整 OpenAPI／JSON Schema validator，不宣稱已覆蓋所有 keyword 或第三方 client generator。權限、正規化、status／header／傳輸等仍由獨立 HTTP 斷言確認。

預設請求與回應不變。新增 query 是明確擴充，以前 sort=title 仍拒絕；沒有放寬成任意排序欄位。移除欄位、改型別、改 enum、收緊輸入、改預設排序或 total 語意需獨立評估相容性，不能只改文件。

## 5. 查詢實驗與生命週期

lab:queries 使用 TEST_DATABASE_URL／course_test、自有隨機 schema，建立 30000 篇合成文章，執行 ANALYZE 與六組 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)：第一頁、深 offset、count、搜尋、本人狀態篩選、移除 status 複合索引後第一頁。

它只在自己的 schema 移除索引，finally 清理 schema，不碰開發 public。結果寫 .data/query-plans.json。查詢只投影 id，不是 API 完整欄位、序列化、網路或正式負載基準；不測試固定毫秒、計畫名稱或強制索引。

既有 status＋createdAt＋id、authorId＋createdAt＋id 索引保留，沒有新 migration。精確 count 不因 LIMIT 20 自動只算 20 筆；ILIKE '%q%' 也不因一般 B-tree 索引而成為廉價全文搜尋。

DATABASE Provider、pool、readiness、工作追蹤與 shutdown 沿用。取消 HTTP／RxJS 訂閱不表示資料庫工作取消。未加入 timeout／retry／cache／cursor／全文搜尋或新 ORM。

## 6. Docker 與驗收

Compose nodejs-course-21，API 3021、開發 PostgreSQL 15421，APP_ORIGIN=http://127.0.0.1:3021；test-db 不公開端口。版本、lockfile 套件節點及 Express／Multer overrides 沿用。示範帳號密碼仍含 18，seed 不覆寫舊憑證、角色與文章。

check 順序：generate → typecheck → Jest → build → test:runtime → lab:nest → lab:scopes → lab:validation → lab:responses → lab:queries → openapi:export。npm test 不能與依賴 .test-dist 的程序／查詢實驗並行。

test:query-api 連執行中的 Compose API，真正登入三角色，建立六篇驗收文章，驗證搜尋、排序、公開／本人範圍、文件與三筆狀態稽核。test:query-persistence 在 API／PG 重啟後比對保存資料；proof 不保存憑證。前章 test:status-api／test:status-persistence 也保留。

沒有新增留言、稽核列表、帳號復原或部署功能。NDJSON 仍是公開獨立教學檔，不是資料庫／稽核備份。正常停止保留 volume，不用 down -v 收尾；不執行 Git staging／commit。
