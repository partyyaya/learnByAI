# 第30章契約：公開快取

承接[29](../29/BASELINE.md)主線；不改業務JSON契約、四份Prisma migration、OpenAPI21／38與28.0.0。新增固定ioredis5.8.2及Redis7.2映像。

- dev專案nodejs-course-30，API3030／PG15430，lab3130／3230／3330／4030；production HTTPS34430／HTTP30830，另有自己的cache-redis。
- cache-redis無主機port、64MiB allkeys-lru、無持久化；容器memory128MiB。工作佇列不共用這個淘汰政策。
- 所有公開cache hit先PG確認published／版本或公開列表fingerprint。schema／query／id／version／total參與SHA-256 key，不能用舊key繞過封存或私人範圍。
- 單篇cache-aside與列表fingerprint均保留DB成本；RepeatableRead只保證同次指紋／列表snapshot，非跨請求offset穩定或零SQL。
- 私有、admin、認證、Session及404不快取。回應／cache值只投影明列欄位，日期復原，壞值回源。trusted cache不提供抗惡意管理者的內容簽章。
- 寫入先DB commit再DEL舊單篇key，失效失敗不改已提交的HTTP結果；列表以新fingerprint邏輯失效。舊key與晚到回填不被新版本使用。
- connect200ms、command150ms、offline queue關閉、不重試單筆命令；背景1秒重連。單程序相同miss合併registry最多64，payload512KiB（GET 取回後才驗證；超大既有值刪除後回源），TTL20–30秒jitter；不宣稱全服務admission或HTTP硬期限。
- Provider constructor不連線，onModuleInit啟動，onModuleDestroy關閉；compile失敗不留下Redis socket。測試只清自己的隨機前綴，無FLUSHALL。
- CI額外真停止／恢復production cache-redis，以相同HTTPS文章／Session驗降級，PG仍ready。沿用本機secret／CA／角色與29備份限制，cache不是DB備份。
- 保留所有volume／proof，不down -v，不stage／commit，不新增REVIEW檔。

HTTP 關閉協調器在 listen 前追蹤 socket，drain 時清理零 HTTP bytes 的預連線，並繼續等待已接受請求；保留原有關閉期限及非零失敗語意。見 [shutdown.ts](src/shutdown.ts) 與 [原生 TCP 測試](test/shutdown.test.ts)。

## 驗證紀錄

2026-11-03：完整 Jest 563 項及另行兩個 worker 的 6 項隔離測試通過；Docker 建置、Chromium、TLS 與重啟持久化均已實際驗證。另通過 PG 故障與隔離備份還原。

2026-11-04 審閱回歸：11 項（快取與 shutdown）通過。補強真實晚到回填競態、超大值清除與零 bytes TCP 預連線關閉。本輪採針對性回歸，未重跑全部歷史 Jest 或整套正式部署 CI；上方 2026-11-03 為前次完整驗證。
