# 第 28 章契約：留言、管理端與完整驗收

承接 [27](../27/BASELINE.md)，既有文章、Session／CSRF、版本、狀態稽核、觀測、前端（管理稽核在登出清空，晚到結果依generation拒絕）與部署契約保留。固定版本及依賴不新增。

- 開發 nodejs-course-28：API／PG=3028／15428，external-lab／upstream／performance-lab=3128／3228／3328，CORS lab4028；獨立 production HTTP30828／HTTPS localhost:34428。
- 四份 migration，新增 202611030001_comments；前三份不改。Comment 欄位 id／articleId／authorId／content／createdAt，Restrict FK、char_length 1–1000 CHECK、(articleId,createdAt,id) 索引。
- GET／HEAD /api/articles/:id/comments：文章只在 published 可讀，其他狀態／不存在對所有角色 404。page／pageSize、createdAt＋id ASC、RepeatableRead 同 snapshot 篩選與 count，未知 query 拒絕。
- POST 同 path：Session＋CSRF、201；strict content trim 後1–1000 code points、不含 NUL；共用16 KiB／UTF-8／期限。作者由 actor 決定，不接受 authorId 等未知欄位。
- ReadCommitted 交易 SELECT Article FOR UPDATE，鎖內檢查 published 再 INSERT。封存先持鎖／提交後，留言等待並回404；資料庫失敗回滾、不 retry。identifier 僅可信 schema metadata，值參數化。
- 留言不改文章 version／updatedAt，也不寫 ArticleStatusAudit；沒有留言 PATCH、文章永久 DELETE 或假歷史回填。
- DELETE /api/comments/:id：Session＋CSRF；不存在404 → 留言作者／admin判斷403 → deleteMany id＋authorId affected1；204無 body，重複404。文章作者無額外權限；封存後可刪已知 ID。拒絕 request body／未知 query。
- GET／HEAD /api/admin/articles/:id/status-audits：Session＋AdminGuard，member403；任意狀態文章，page／pageSize、toVersion ASC、RepeatableRead、明列原稽核欄位。沒有變更／刪除稽核 API。
- OpenAPI 3.1.1，21 paths／38 operations、28.0.0；前三條新 path 共6 operations。啟動／ready 增查 Comment，故障 ready503／live200，錯誤安全。
- UI 新增留言區與 admin 稽核區，全部文字呈現；後端獨立授權、記憶體 CSRF、不 retry 寫入；維持目前頁面分頁資料，不宣稱完整列出全部留言。
- 44 套／540 項 Jest（524＋新16）；雙worker另6。真雙pool row lock／並行刪除、CHECK／FK／回滾、舊schema升級、readiness、OpenAPI均受測。Chromium 另驗留言 XSS／新增／刪除。
- production verifier 驗 HTTPS、Secure Cookie／CSRF、文章＋留言＋Session 重啟持久化。runtime 不帶 CLI／seed／Chromium；沿用26本機部署限制，不宣稱完整公開站台安全／合規稽核。
- CI／手動流程依序執行，只停止本章服務、保留 volumes／資料／proof，不 down -v／stage／commit。

前端401清空本人資料與舊CSRF，取得新匿名CSRF後可重新登入，不retry原寫入；真Chromium驗固定Session到期後重新登入。原生client另以真HTTP部分JSON驗body階段的TIMEOUT／CANCELLED分類。

編輯器generation保護晚到成功：建立新草稿、輸入新內容或切換選擇後，舊儲存／publish／archive不清空目前編輯器。BFF非GET405附Allow: GET，精確接受application/json（可帶參數），另測大小／期限／caller取消。
留言操作綁定原文章／輸入generation；完成後只刷新仍選取的同篇，保留後續輸入；已完成寫入不因列表更新失敗而誤報為寫入失敗。
