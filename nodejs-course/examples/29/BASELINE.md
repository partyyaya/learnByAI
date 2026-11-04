# 第 29 章契約：故障與維運

承接 [28](../28/BASELINE.md)，業務API、四份migration、Session／CSRF、留言權限、版本／稽核、前端（管理稽核在登出清空，晚到結果依generation拒絕）與OpenAPI21 paths／38 operations、28.0.0不變。固定應用依賴不新增。

- 開發nodejs-course-29：API3029／PG15429，external-lab3129／upstream3229／performance-lab3329／CORS4029；獨立production HTTP30829／HTTPS localhost:34429，API／PG無主機port。
- CI完整check45套／558項Jest＝540＋操作目標／備份完整性guard18；雙worker另6。Chromium、程序信號／deadline、外部期限／取消／有限GET retry／POST不確定性、TLS／持久化另計。
- 真停止production postgres；live200／metrics200／ready503 NOT_READY／公開文章500 INTERNAL_ERROR，無SQL／連線字串洩漏；恢復後HTTPS確認原文章／留言／Session。
- dump來源固定postgres/course，以PG17 custom format、no-owner／no-acl；檔名backup_32hex.dump，拒絕覆寫。暫停本機API／proxy比對備份前筆數；不宣稱此停站是pg_dump一致性必要條件。
- 還原固定restore-db、獨立restore_data，目標restore_12hex；createdb遇已存在拒絕，pg_restore single-transaction／exit-on-error；不--clean／不覆蓋來源，不migrate reset、不seed替代恢復。計畫拒絕未知來源／非法路徑及目標。
- 實際比較User／Article／Comment／Session／ArticleStatusAudit筆數、四份完成migration、文章／留言欄位、Session摘要對應身分與固定到期／撤銷條件；在還原DB啟動同一Nest應用，以隨機loopback HTTP驗ready／文章／留言／me，正常清理HTTP／Nest／pool。
- 恢復驗證只在隔離容器內，不自動切流量到還原DB；沒有聲稱還原端完成TLS入口驗收。來源原本TLS路徑另有HTTPS恢復驗證。
- init-deploy新增0600 pgpass，來源／還原工具明列secret掛載，不印密碼。沿用本機course高權限角色，API／DDL／backup未分權；同機volume、無加密異地保存／排程／WAL／PITR／完整公開環境設定。
- dump含密碼雜湊、Session／CSRF；.data/backups0700、umask077，私有jar0600；全部被Git／build忽略，artifact只明列安全proof。SHA-256／大小／本次backupRestoreElapsedMs不是來源認證／恢復完整性或SLO／RTO／RPO保證。
- operations-proof讀取實測outage／source-recovery／restore證據後才輸出；保留唯一dump及隔離DB。單DBdump不保存全域角色、原ACL／owner、secret、TLS／主機／外部物件；NDJSON仍非DB備份。
- check-image-switch.sh另跑r1→r2→r1，驗不同image ID、回到原ID、文章／留言／Session保留；只改release metadata，不證明真業務跨版相容，不反向migration。成功寫rollback-proof，結束正常停止本章production。
- 手動failure-drills遇錯停止且保留失敗目標／dump，API可能仍停著，先查證再恢復；CI EXIT保留退出碼並停止本章服務。Session過期須新建驗收基準，不略過期限。
- 不操作其他章服務、不刪volume、不stage／commit，不建立REVIEW／交接報告；00–29主線完成，30–34 選修已完成，詳見課程總覽。

前端401清空本人資料與舊CSRF，取得新匿名CSRF後可重新登入，不retry原寫入；真Chromium驗固定Session到期後重新登入。原生client另以真HTTP部分JSON驗body階段的TIMEOUT／CANCELLED分類。

編輯器generation保護晚到成功：建立新草稿、輸入新內容或切換選擇後，舊儲存／publish／archive不清空目前編輯器。BFF非GET405附Allow: GET，精確接受application/json（可帶參數），另測大小／期限／caller取消。
留言操作綁定原文章／輸入generation；完成後只刷新仍選取的同篇，保留後續輸入；已完成寫入不因列表更新失敗而誤報為寫入失敗。
dump輸出使用noclobber原子保留檔名，真並行兩工作只允許一個成功。原始manifest綁定計畫／SHA-256／bytes，還原前與finish均串流比對；不以新雜湊覆寫原基準。還原逐欄比對migration歷史，不只檢查筆數。
