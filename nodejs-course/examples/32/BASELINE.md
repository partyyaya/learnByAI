# 第 32 章契約基準

延續 [31 基準](../31/BASELINE.md)，額外加入：

| 項目 | 契約 |
|------|------|
| GET／HEAD /api/me/events | Session，本人通知；HEAD 立即結束且不占串流額度 |
| SSE 游標 | after；Last-Event-ID 優先；非負 int64 字串 |
| SSE 回應 | text/event-stream、no-store、X-Accel-Buffering:no；具名 article-published 事件 |
| WS /api/me/socket | 精確路徑、有效 Cookie、精確 Origin，先升級再讀一次嚴格 after 訊息 |
| 原 HTTP /api/me/socket | 426，Upgrade:websocket |
| 私人邊界 | 包含 admin 在內，只讀自己的 Notification；URL 不能指定收件者 |
| 上限 | 每程序 32／每人 2；輪詢 500ms、20 筆；初始 WS 兩秒、1 KiB |
| 清理 | 斷線／Session 到期／drain 清計時器；drain 先停長連線再等 HTTP，WS 含初始預約回1001 |
| 文件 | OpenAPI32.0.0，23 paths／42 operations；WS 不算 HTTP operation |

Notification.seq 為 BIGINT 字串；不可轉 Number，不要求連號。worker 在分配 seq 前鎖收件者，防止低 seq 晚提交造成漏讀；eventId 唯一約束防止重複業務結果。傳輸可重複，client 用 seq 去重。

非法游標以分階段 schema 驗證，REST／SSE 回400、WS 以1008關閉該連線，服務仍存活。補讀中停止可再次補抓，舊回應受 generation 檢查。

SSE 有 Origin 時須完全相同，無 Origin 的認證讀取允許；WS 必須有 Origin。Upgrade 拒絕不走 Nest JSON envelope。開始串流後不另寫 JSON 錯誤。

[realtime.test.ts](test/realtime.test.ts)、[outbox.test.ts](test/outbox.test.ts)、[queue lifecycle](scripts/check-queue-lifecycle.cjs)、[Chromium](scripts/check-browser.cjs)及 [TLS verifier](scripts/check-production.cjs)提供對應證據。snapshot 計時器統計僅供同程序測試，不暴露 debug API。

這是 31 → 32 的累積選修；33 與 34 分別從 29 分支，比較平台與 ORM，不能直接拿它們的資料庫當作本章 migration 目標。

HTTP 關閉協調器在 listen 前追蹤 socket，drain 時清理零 HTTP bytes 的預連線，並繼續等待已接受請求；保留原有關閉期限及非零失敗語意。見 [shutdown.ts](src/shutdown.ts) 與 [原生 TCP 測試](test/shutdown.test.ts)。

## 驗證紀錄

2026-11-03：完整 Jest 571 項及另行兩個 worker 的 6 項隔離測試通過；Docker 建置、Chromium、TLS 與重啟持久化均已實際驗證。另通過 PG 故障與隔離備份還原。佇列另驗證空 dispatcher 穩定運作、active worker SIGKILL／stalled 恢復及正常關閉。通知頁另驗證真 EventSource／WebSocket 與 Session 到期清除私人畫面；代理另驗證 CA、SSE／WSS 與 Origin 拒絕。

2026-11-04 審閱回歸：31 項（SSE／WS、Outbox、快取、OpenAPI 與 shutdown）通過，含 --detectOpenHandles。另以真 Chromium 驗證補抓中按停止可再次操作、Session 到期清空私人畫面；非法 WS 游標不影響服務，HEAD 不占串流額度，初始 WS 預約 drain 回1001，拒絕 Upgrade 後清掉半開 socket。本輪採針對性回歸，未重跑全部歷史 Jest 或整套正式部署 CI；上方 2026-11-03 為前次完整驗證。
