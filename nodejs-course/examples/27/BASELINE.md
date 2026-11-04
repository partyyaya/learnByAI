# 第 27 章契約：前端與 BFF

承接 [26](../26/BASELINE.md)，API 業務／認證／日誌／TLS／migration 不變，沒有新增依賴或 JSON 路由。OpenAPI 仍 18 paths／32 operations、24.0.0。

- 開發 nodejs-course-27：API／PG=3027／15427，external-lab／upstream／performance-lab=3127／3227／3327；CORS lab 4027。部署獨立 production：HTTP 30827、HTTPS localhost:34427。
- 固定 HTML／assets 不列入 JSON OpenAPI；GET／HEAD、no-store／nosniff／CSP，無任意磁碟路徑。主工作台 script／style／connect 只允許 self。
- Session 僅 HttpOnly Cookie，CSRF 在頁面記憶體，重新整理查 csrf／me；登入輪替、登出 DB 撤銷。密碼送出清空，不寫 browser storage／URL／console。
- UI 不是授權邊界；本人列表 admin 仍只查本人，API 每請求查 Session／role。
- client 同源 /api/、same-origin credentials／no-store／redirect:error、5 秒 signal 涵蓋 fetch／body，timer finally 清理；204 不解析 JSON，錯誤固定訊息＋安全 UUID，不顯示原始 exception／proxy body，不 retry。
- 公開查詢以 abort＋generation 防晚到結果；取消不宣稱取消 SQL。409 保留輸入，不自動採新版本重送。401 清本人畫面。所有資料 textContent／value，不插入 HTML。
- 獨立 CORS lab 只允許 http://127.0.0.1:3027、GET、X-Lab-Token，credentialed 精確 origin／Vary；localhost origin 拒絕。無文章／Session API、不回 Cookie 值。主線不開 CORS；port 不隔離 Cookie，CORS 不取代 CSRF／授權。
- BFF 只 GET 固定本人摘要；每 request 挑選相應 Cookie，無任意 URL、Authorization／服務角色或私人全域快取。1 秒／128 KiB／schema 白名單、no-store、redirect 拒絕。Next／Nuxt 是整合責任說明，非完整可執行框架專案。
- 42 套／524 項 Jest＝原 515＋frontend／BFF 9；雙 worker另6。web client 原生斷言與真 Chromium 另計，瀏覽器以自有 schema／profile 驗證登入／reload／建立／發佈／conflict／XSS／logout／CORS，最後清理。CDP 不開主機 port，sandbox 選項只用於隔離受控測試。
- CI 依序跑 check、Chromium、映像／TLS／持久化；runtime 增加 web，不帶瀏覽器，沿用非 root／唯讀與前章本機部署限制。只正常停止本章服務、保留資料與 proof，不 down -v／stage／commit。

前端401清空本人資料與舊CSRF，取得新匿名CSRF後可重新登入，不retry原寫入；真Chromium驗固定Session到期後重新登入。原生client另以真HTTP部分JSON驗body階段的TIMEOUT／CANCELLED分類。

編輯器generation保護晚到成功：建立新草稿、輸入新內容或切換選擇後，舊儲存／publish／archive不清空目前編輯器。BFF非GET405附Allow: GET，精確接受application/json（可帶參數），另測大小／期限／caller取消。
