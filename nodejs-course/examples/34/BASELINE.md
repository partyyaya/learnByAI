# 第 34 章契約基準

從 [29](../29/BASELINE.md)保留業務 HTTP 契約，新增 TypeORM 平行實作。OpenAPI28.0.0、21 paths／38 operations。

| 項目 | 本章契約 |
|------|----------|
| DB 邊界 | course_orm；測試僅 course_test 下自有 orm34_UUID schema；拒絕主線 course |
| Schema | 五個 Entity；明列 FK／CHECK／UNIQUE／索引的獨立 migration |
| History | typeorm_migrations；synchronize=false、migrationsRun=false |
| Nest | TypeOrmModule.forRootAsync／forFeature，原 Service token 接 ORM Repository |
| 交易 | manager 一路傳遞；id／authorId／version／status 條件 UPDATE，affected=1 |
| Audit | 與狀態同交易；真 INSERT 失敗全部 rollback |
| Session | Cookie／CSRF／固定到期／撤銷／輪替，讀取目前 user role |
| 留言 | Article row lock 後檢查 published；本人／admin delete 並檢查 affected |
| 敏感欄位 | passwordHash select:false，登入 addSelect；HTTP presenter 仍必須投影 |
| Migration down | 只允許自有空測試 schema，非空或 public 拒絕；無 production revert CLI |
| Runtime | orm-main；以 WHERE 1 = 0 明列所有 Entity 欄位；空表缺欄位也不監聽；drain 後關閉 DataSource |

[HTTP 共用契約](test/orm-http.test.ts)與 [真交易／查詢測試](test/orm-transactions.test.ts)專門驗證 ORM；歷史 Prisma 測試只作參考，不全算 ORM 覆蓋。[專屬 runtime](scripts/check-orm-runtime.cjs)、[Chromium](scripts/check-browser.cjs)、[production verifier](scripts/check-production.cjs)實際使用 ORM 組裝。

QueryRunner 必須 finally release；N+1 與 JOIN 以真查詢計數比較，不印 SQL 參數或憑證。Entity 關聯不開 eager／cascade，回應不自動序列化整個 Entity。

本章不搬遷主線既有資料，也未實作 ORM 專屬備份還原。保留 prisma/ 及 client 為比較資料，db:deploy／status／seed 不呼叫 Prisma migration。

HTTP 關閉協調器在 listen 前追蹤 socket，drain 時清理零 HTTP bytes 的預連線，並繼續等待已接受請求；保留原有關閉期限及非零失敗語意。見 [shutdown.ts](src/shutdown.ts) 與 [原生 TCP 測試](test/shutdown.test.ts)。

## 驗證紀錄

2026-11-03：完整 Jest 578 項及另行兩個 worker 的 6 項隔離測試通過；Docker 建置、Chromium、TLS 與重啟持久化均已實際驗證。TypeORM 專屬 HTTP／交易測試 38 項，另有真正 orm-main 信號／drain 與缺必要欄位拒絕啟動；歷史 Prisma 案例不全算 ORM 覆蓋。

2026-11-04 審閱回歸：45 項（TypeORM 專屬39項＋shutdown6項）通過；另 build 與真正 orm-main 的信號／drain 驗證通過。空表缺 User／Session／Article／Audit／Comment 欄位均能由 readiness 檢出。本輪採針對性回歸，未重跑全部歷史 Jest 或整套正式部署 CI；上方 2026-11-03 為前次完整驗證。
