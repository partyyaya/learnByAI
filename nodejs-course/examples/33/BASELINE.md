# 第 33 章契約基準

以 [29](../29/BASELINE.md)為業務基準，API 不增加端點，OpenAPI28.0.0、21 paths／38 operations。

| 項目 | 契約／證據 |
|------|-----------|
| 兩平台 | 真正 Express 與 Nest FastifyAdapter，沒有以名稱模擬 |
| 正式入口 | fastify-main；dev／runtime／Chromium 均明確指定 |
| 比較契約 | 每平台共用 33 項，共 66；Article／migration／auth／comments／admin |
| Body | 有界 JSON parser，16 KiB、指定 media type、安全錯誤 |
| URL／方法 | collection 斜線別名、單篇尾斜線404、HEAD無body、405 Allow |
| 回應 | 小型 ResponsePort；Cookie maxAge 毫秒轉秒，串流使用 raw + hijack |
| 業務 | Service、Prisma 條件更新、Audit 交易、Session／CSRF／owner 不因平台改變 |
| 測量 | 每平台新程序，五次暖身、40 請求、併發4，無速度門檻 |
| 交付 | 非 root／唯讀、獨立 Prisma migration、TLS／Secure Cookie 與資料重啟驗證 |

歷史獨立 Express 實驗仍保留原平台；66 項共用契約不等於完整歷史測試雙跑。[platform-contract.test.ts](test/platform-contract.test.ts)、[比較腳本](scripts/check-platform-comparison.cjs)、[瀏覽器](scripts/check-browser.cjs)、[production verifier](scripts/check-production.cjs)可重現比較。

本章沒有 30–32 的 Redis／Outbox；不要把 31／32 資料庫誤作本章獨立快照的部署目標。

HTTP 關閉協調器在 listen 前追蹤 socket，drain 時清理零 HTTP bytes 的預連線，並繼續等待已接受請求；保留原有關閉期限及非零失敗語意。見 [shutdown.ts](src/shutdown.ts) 與 [原生 TCP 測試](test/shutdown.test.ts)。

## 驗證紀錄

2026-11-03：完整 Jest 624 項及另行兩個 worker 的 6 項隔離測試通過；Docker 建置、Chromium、TLS 與重啟持久化均已實際驗證。另通過 PG 故障與隔離備份還原。分程序 Express／Fastify 比較另執行，未設速度門檻。

2026-11-04 審閱回歸：72 項（兩平台共用契約66項＋shutdown6項）通過。更正教材 URI 錯誤碼為 INVALID_URL，補充固定測量順序的限制。本輪採針對性回歸，未重跑全部歷史 Jest 或整套正式部署 CI；上方 2026-11-03 為前次完整驗證。
