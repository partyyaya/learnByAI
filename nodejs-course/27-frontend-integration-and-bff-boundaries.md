# 27 — 最小前端、Cookie／CORS／CSRF、載入錯誤與 BFF 邊界

> 瀏覽器負責呈現狀態，API 仍負責每一次授權；把前端接起來，也要測真正的瀏覽器行為。

承接[第 26 章](26-build-docker-ci-and-deployment.md)。本章有[完整獨立快照](examples/27/README.md)，延續固定版本、Session／CSRF、文章版本與 TLS 映像，新增不需前端框架的文章工作台。正式 API 不新增 JSON 端點，OpenAPI 仍 18 paths／32 operations、info.version=24.0.0；HTML／assets 是另外的呈現介面。

完成後你應能：

- 從同源頁面登入、建立／編輯／發佈／封存文章，重新整理仍使用 DB Session。
- 分開處理載入中、空列表、網路失敗、401／403 與版本衝突。
- 以 HttpOnly Cookie 保存 Session，CSRF 只留於目前頁面的記憶體。
- 用真 Chromium 觀察 preflight、credentialed CORS 與來源拒絕。
- 寫一個有界 BFF 讀取邊界，不把服務憑證、角色或任意代理能力交給瀏覽器。

## 27.1 先選同源，讓身分流程容易看清楚

```text
瀏覽器 GET /
  → 同一個服務提供 HTML／ES modules／CSS
  → fetch('/api/auth/csrf')，必要時建立匿名 Cookie
  → fetch 登入，瀏覽器自行帶 Cookie 與 Origin
  → API 輪替 Session／CSRF
  → 頁面只把公開 user 與 CSRF 放在記憶體
```

開發入口 http://127.0.0.1:3027，TLS 入口 https://localhost:34427。相對路徑 /api/... 與目前頁面同源，主線不需要開啟 CORS；沒有為了串接而加入 Access-Control-Allow-Origin:*。

Cookie 不按 port 隔離。3027、4027 是不同 origin，但相同 hostname 的 Cookie 仍可能跨 port 出現；localhost 與 127.0.0.1 也不是可以任意互換的 Origin。每章請使用獨立瀏覽器設定檔／Cookie jar，避免相同 Cookie 名稱互蓋。

## 27.2 從乾淨環境開始

未安裝工具時，先完成[第 00 章 nvm／Node](00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)與[第 01 章 Docker](01-runtime-tooling-and-project-setup.md)。從倉庫根目錄：

```bash
cd nodejs-course/examples/27
nvm install
nvm use
docker compose build tools browser-tests
docker compose up -d --wait postgres test-db
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm browser-tests npm run test:browser
docker compose run --rm tools npm run db:deploy
docker compose run --rm tools npm run db:seed
docker compose run --rm tools npm run seed
docker compose up -d api
```

開啟 http://127.0.0.1:3027。DB 15427、外部 lab 3127／3227、效能 lab 3327 仍獨立。Compose 專案 nodejs-course-27，各章 volume 不共用；示範 Alice 密碼仍為 Alice-course-18!，Bob／admin 密碼也沿用 18 章原值。

browser-tests 在固定 Node 基底上另安裝 Chromium，只用於測試，不放入 API runtime。Chromium／字型由該次 apt 來源提供，不宣稱每次重建相同瀏覽器版本；Node／npm／應用 lockfile 仍固定。所有會重建或讀取 .test-dist 的測試／browser／check 指令依序執行。

## 27.3 工作台的狀態不是授權憑證

[app.js](examples/27/web/app.js)使用三類狀態：

| 狀態 | 來源與用途 |
|------|------------|
| user | GET /api/auth/me／登入回應；呈現名稱與可用操作 |
| CSRF | csrf／登入回應；在記憶體中隨 Session 輪替 |
| selected article＋version | 目前編輯的資料快照；PATCH／狀態操作帶 expectedVersion |

登入後載入 /api/me/articles，只管理本人文章，admin 也相同。畫面上的按鈕只是方便使用，不能代替 SessionGuard、CsrfGuard 或資料擁有者檢查。

密碼送出後立刻清空欄位，不放進 localStorage、sessionStorage、URL、畫面訊息或 console。Session 由 HttpOnly Cookie 搭配 DB 保存；頁面無須也不能用 document.cookie 讀取它。重新整理後重新取得 csrf／me，不能從自己保存的 role 判斷登入身分。

登出成功後清除頁面 user／CSRF／本人列表；API 撤銷 DB Session，而不是只藏起工作區。

## 27.4 fetch 成功完成，不表示 HTTP 操作成功

[api-client.js](examples/27/web/api-client.js)明確區分：

- transport／deadline／caller 取消：沒有可採用的成功結果。
- HTTP 401：清除本人畫面與舊CSRF，取得新的匿名CSRF後讓使用者重新登入；不重送原寫入。
- HTTP 403：來源、CSRF 或權限未通過，不當成網路故障重送。
- HTTP 409 VERSION_CONFLICT：保留輸入，提示重新讀取新版本。
- 204：直接完成，不呼叫 response.json()。
- HTML、壞 JSON 或缺 data：BAD_RESPONSE，不把代理的原始 body 顯示出來。

每次 request 預設五秒 deadline，signal 涵蓋 fetch 與 body；body讀取時的取消／逾時仍分別歸類CANCELLED／TIMEOUT，不誤當壞JSON；timer 在 finally 清理。GET 可因後續查詢取消；任何寫入均不自動 retry。等待逾時不代表 server 沒有提交，畫面應先重新查詢，不直接再按一次強制覆蓋。

client 只接受同源 /api/ 路徑、固定方法、credentials:same-origin、no-store、redirect:error。Origin 由瀏覽器決定，程式不嘗試設定這個受限制 header。CSRF header 由記憶體值帶入，沒有把 Cookie 當成 CSRF 的替代品。

錯誤訊息採固定對照，request ID 只有符合 UUID 樣式才呈現；不直接採用任意 Error.message、代理 HTML 或伺服器內部訊息。

## 27.5 過期查詢與版本衝突是不同問題

搜尋 A 尚未完成，使用者又輸入 B 時：

```text
取消 A 的等待 → 為 B 建立新 controller／generation
  → 只允許目前 generation 更新 DOM
```

取消 signal 不保證 SQL 已停止，因此仍用 generation 擋下晚到結果。本人列表也有 generation，登出後不應由稍後到達的舊回應重新填回畫面。

成功回應也可能晚到：送出文章A後立刻開始新草稿，A的成功回應不能清空新輸入；對A發佈／封存也不能清空目前正在編輯的B。編輯器用generation記錄輸入、選擇與清空的變化，只有仍是送出時的畫面才清空；否則保留輸入並說明尚未送出，不自動重試。

編輯衝突則不能靠取消處理：頁面讀到 version=1，另一個請求已改為 2，PATCH 仍帶 1 就得到 409。此時保留輸入，讓使用者比較新舊內容；不自動把 expectedVersion 改成 2 後重送。

## 27.6 用文字呈現資料，不把資料變成 HTML

文章標題、正文、displayName 都透過 createElement／textContent／value 放入頁面，不使用 innerHTML 或字串模板插入 DOM。

例如標題是 `<img src=x onerror=window.pwned=1>`，它應顯示成文字，不能建立 img 或執行事件。Chromium 驗收會真的送出這個標題並檢查 DOM。

[frontend.ts](examples/27/src/frontend.ts)只提供固定資產清單，不將使用者路徑拼成檔案名稱；回應 no-store、nosniff、no-referrer 與 CSP。主工作台的 script／style／connect 只允許 self，不使用 inline script、eval 或公開金鑰設定。

這不是完整的富文字清理器；若之後允許 Markdown／HTML，需要另外定義與測試渲染安全邊界，不能直接把 textContent 換成 innerHTML。

## 27.7 CORS 是瀏覽器讀取政策，不是 API 授權

CORS 的 origin 由 scheme、hostname、port 組成。credentialed 跨來源回應不能用 wildcard 取代明確來源；非簡單 header 會使瀏覽器先送 OPTIONS。[Fetch 的 CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol)

本章使用獨立 lab，不更改正式文章 API：

```bash
docker compose up -d api cors-lab
```

開啟 http://127.0.0.1:3027/cors.html，再開 http://localhost:3027/cors.html，按「測試跨來源讀取」。第一個來源在 allowlist，第二個不在，瀏覽器應拒絕後者讀取。

```text
GET + X-Lab-Token + credentials:include
  → browser OPTIONS
  → lab 檢查精確 Origin／GET／header
  → 回精確 Allow-Origin、Allow-Credentials:true、Vary:Origin
  → browser 才發出並允許頁面讀取 GET 結果
```

lab 的 Cookie 只是 teaching-only，沒有文章／Session API，也不回任何 Cookie 值。Cookie 可能因 hostname／SameSite 規則跨 port 送出，不能以為不同 port 就隔離秘密；不要把真憑證交給不可信來源。

CORS 不會阻止所有請求抵達 server，也不約束 curl、伺服器端 fetch 或其他 HTTP client。主線寫入仍需精確 Origin＋CSRF＋Session；不以「瀏覽器看不到回應」當成沒有副作用。此頁只供 HTTP loopback 實驗，不當成 HTTPS 部署跨站 Cookie 方案。

## 27.8 BFF 也需要自己的邊界

BFF 可協助前端彙整資料與保存伺服器端設定，但它的 Route Handler 同樣可被直接呼叫；它不會讓後端授權自動變成可信。[Next.js BFF 官方指南](https://nextjs.org/docs/app/guides/backend-for-frontend)

本章提供可執行、受測的 [bff-boundary.ts](examples/27/src/bff-boundary.ts)，只實作 GET 本人摘要：

```text
每次 BFF request
  → 只挑目前 origin 對應的 Session Cookie
  → 固定上游 /api/me/articles?pageSize=5
  → server-side fetch，不轉送 Authorization／任意用戶 header
  → 一秒整體 signal、最多 128 KiB、拒絕 redirect
  → schema 投影 id／title／status／version，no-store 回應
```

Cookie 不放在 singleton 的欄位中，每次呼叫各自取得；並行 A／B 的測試確認不會混用。沒有 service token 代替使用者，也不接受 body 的 authorId／role、任意目的 URL 或共享私人資料快取。上游 401／403 仍拒絕，不因 BFF 身分而越權。

非GET回405並附Allow: GET；上游media type以完整application/json判斷，可附charset參數，不把application/jsonp當JSON。新增真HTTP測試覆蓋128 KiB、慢body期限與caller取消。405的Allow要求可對照 [RFC9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-405-method-not-allowed)。

此模組只做讀取，不處理登入／Set-Cookie 或寫入代理；不要把它當成已完成 Session 跨域搬移。BFF 回應產生自己的 request ID，沒有宣稱已自動串接跨服務 tracing。

在 Next 的 server-only Route Handler，可將 GET(request) 交給這個邊界；Nuxt 的 server route 也可採同樣責任切分。框架的 cookie／request／response 轉接、header 重設與錯誤格式仍須測試。此快照沒有安裝或宣稱可執行完整 Next／Nuxt 專案；可執行主線是原生 HTML＋Nest，BFF 核心以真 HTTP 測試，不為邊界介紹加入兩套框架依賴。

伺服器金鑰只能留在 server-only 設定，不放進 NEXT_PUBLIC_*、public runtimeConfig、HTML 或 browser bundle。隱藏按鈕、Server Component 或 BFF 路由都不能取代 API 的 Session／權限檢查。

## 27.9 真瀏覽器驗收與 TLS 延續

```bash
docker compose run --rm browser-tests npm run test:browser
```

瀏覽器測試以CDP在回應階段暫停真正的HTTP回應，先切換編輯畫面再釋放，驗證晚到成功不會清空新草稿；不只檢查失敗409。CORS頁面另等待module完成載入才點按鈕，DOM上已有button不表示click handler已安裝。

測試在 browser container 啟動自己的 loopback Nest app、隨機測試 schema、臨時 Chromium profile 與獨立 CORS lab。使用 Node 內建 WebSocket 驅動 CDP，不新增 Playwright／前端框架依賴，不打開主機 debugging port。

它驗證登入、欄位清空、document.cookie 無 Session、空 browser storage、文章建立／發佈／衝突保留輸入、重新整理 Session、固定到期後重新登入、XSS 文字、登出撤銷，以及真 preflight／來源拒絕。結果在 .data/browser-proof.json，不保存密碼、Cookie 或 CSRF。結束先關瀏覽器／應用，再清自己的 schema／profile。

Chromium 的 --no-sandbox 只用在隔離的本機測試容器，測試僅開啟本章 loopback 頁面，不能用這個命令瀏覽不可信網站。API runtime 不含 Chromium，也不增加這個執行選項。

完整 CI 延續 TLS 部署驗收：

```bash
sh ci/check.sh
```

主工作台 web/ 會進交付映像，相對 API 路徑在 HTTPS 仍同源。瀏覽器測試本身使用 HTTP loopback；TLS／Secure Cookie 的交付檢查由原 HTTPS verifier 執行，不聲稱已在瀏覽器信任庫安裝 CA。

## 27.10 練習與完成檢查

1. 登入後開啟同一篇草稿編輯，透過另一請求更新版本，再儲存舊版本。確認輸入保留、顯示 request ID，且沒有自動重送。
2. 搜尋不存在標題，再快速送出另一個搜尋。空列表與載入中應不同，較舊回應不得蓋掉新結果。
3. 比較 127.0.0.1 與 localhost 的 CORS 頁面，指出 origin、Cookie 範圍與 CSRF 分別管什麼。
4. 修改 BFF 測試，讓上游新增 passwordHash／內部欄位；公開摘要仍不能含它們。

<details><summary>參考判讀</summary>

1：版本是寫入前提，不能悄悄採最新版本。2：取消是等待控制，generation 是畫面更新控制。3：origin 不同不等於 Cookie 一定隔離，CORS 不等於授權。4：明確 schema 投影與 no-store 才能維持私人邊界，不能直接轉送整個上游物件。

</details>

本章全量 42 套、524 項 Jest（原 515＋frontend／BFF 9），雙 worker 另 6 項；web client 原生斷言與 Chromium 不灌入 Jest 數量。CI 還跑原交易／查詢／外部／效能／migration／TLS。文章與 Session 資料保留，不用 down -v。

```bash
docker compose stop cors-lab api performance-lab external-lab upstream postgres test-db
docker compose -f compose.production.yaml stop proxy api postgres
```

下一章：[28 — 專題整合與驗收](28-capstone-feature-integration-and-acceptance.md)，加入留言及管理員狀態稽核查詢。

---

[上一章：建置與部署](26-build-docker-ci-and-deployment.md) · [總覽](README.md) · [範例](examples/27/README.md) · [契約](examples/27/BASELINE.md)
