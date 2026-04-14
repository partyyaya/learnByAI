# 00 課程地圖與學習路徑

> 先看這份文件，再進入章節學習。它會告訴你每週做什麼、每章如何驗收，以及有無後端時各自的學習路線。

---

## 1. 學習目標

完成本課程後，你應該可以：

- 說清楚 gRPC、gRPC-Web、Connect 在前端場景的差異。
- 與後端一起制定可演進的 `proto` 契約（含版本與相容性策略）。
- 在 React/Vue 專案中建立可維護的 gRPC SDK 與 API 層。
- 使用一致方式處理認證、錯誤碼、重試、timeout 與觀測。
- 完成一個可上線、可監控的前端 gRPC 專題。

## 2. 建議課程節奏（6 週）

| 週次 | 章節 | 主題 | 當週產出 |
|------|------|------|----------|
| Week 1 | 00 + 01 | 架構認知與基礎 | 跑起第一個 gRPC-Web 範例 |
| Week 2 | 02 | Proto 契約設計 | 完成一份 Todo/Task 服務 proto |
| Week 3 | 03 | Client 與 SDK（JS 必修） | 可重複使用的前端 API 客戶端 |
| Week 4 | 04 + 05 | 前端整合與後端對接 | 完成本地聯調與錯誤碼對齊 |
| Week 5 | 06 | Streaming 與觀測 | 完成串流頁面與指標面板 |
| Week 6 | 07 | 專題實戰 | Demo、測試與發表 |

## 3. 兩種學習路線

### A. 你有後端團隊（推薦）

1. 先走 `02`，和後端一起 review `proto`。
2. 在 `03` 產生 client，建立 SDK 封裝（JavaScript 即可完成）。
3. 在 `04`、`05` 完成聯調：auth、status、timeout、重試。
4. `06` 補上觀測與效能優化，再進入 `07` 專題。

### B. 你目前沒有後端團隊

1. 先使用範例 gRPC server 或 mock server 完成 `01` 到 `04`。
2. 在 `05` 依照對接流程建立「可交接文件」。
3. 之後只要接上真實後端，即可直接套用既有 SDK 與流程。

## 4. 每章固定學習流程

每一章都建議照這個節奏走：

1. **先讀概念**：理解架構圖、術語與限制。
2. **再做實作**：跟著步驟跑通最小可用案例。
3. **完成作業**：至少做完必做題。
4. **對照驗收**：確認功能、錯誤處理、可觀測都達標。

## 5. 開課前環境清單

- Node.js 20+
- pnpm 或 npm
- Docker / Docker Compose
- 課程內建 demo stack：`grpc-frontend-course/compose.yaml`
- `buf`（lint、breaking check、codegen）
- `protoc`（或只用 `buf generate`）
- Postman / grpcurl / Bruno（任一 API 測試工具）
- 團隊導入時：直接把 `05-backend-collaboration.md` 當對接 SOP。

---

準備完成後，前往 [01-grpc-web-basics.md](./01-grpc-web-basics.md)。
