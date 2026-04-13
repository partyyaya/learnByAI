# Frontend gRPC 課程（gRPC-Web / Connect）

> 這是一門面向前端工程師的 gRPC 實戰課，目標是讓你從 `proto` 契約設計，一路走到前端串接、後端聯調、上線與維運。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map.md](./00-course-map.md) | 課程地圖、學習路徑與環境準備 |
| 01 | [01-grpc-web-basics.md](./01-grpc-web-basics.md) | gRPC / gRPC-Web 基礎與瀏覽器限制 |
| 02 | [02-proto-design.md](./02-proto-design.md) | Proto 契約設計與版本相容策略 |
| 03 | [03-client-generation-sdk.md](./03-client-generation-sdk.md) | Client 生成與 SDK 封裝（JS 必修，TS 選讀） |
| 04 | [04-frontend-integration.md](./04-frontend-integration.md) | 前端整合、錯誤處理、認證與狀態管理 |
| 05 | [05-backend-collaboration.md](./05-backend-collaboration.md) | 有後端時的對接流程與跨團隊協作 |
| 06 | [06-streaming-observability.md](./06-streaming-observability.md) | Streaming、效能與可觀測性 |
| 07 | [07-capstone.md](./07-capstone.md) | 專題實戰、驗收標準與發表 |

選讀補充：[`03a-typescript-lecture.md`](./03a-typescript-lecture.md)

---

## 這門課的設計原則

- **契約先行**：先把 API 契約講清楚，再開始前後端開發。
- **前端落地優先**：聚焦瀏覽器真實限制與工程化解法，不只講 RPC 概念。
- **對接流程完整**：從本地聯調、測試、CI 到上線全部串起來。
- **可維護與可演進**：強調版本管理、相容性與長期協作成本。

## 適合對象

- 想從 REST 轉向 gRPC 的前端工程師
- 需要與後端團隊建立穩定契約流程的全端工程師
- 希望建立「可規模化」前端 API 層的技術主管與資深工程師

## 先備知識

- JavaScript 基礎（會 TypeScript 更佳）
- HTTP 與 API 串接經驗
- React 或 Vue 任一框架基礎

## 課程產出

完成本課程後，你會有：

- 一份可擴充的 `proto` 設計規範
- 一套前端 gRPC SDK 封裝模式
- 一套可重複使用的前後端對接 checklist
- 一個可部署、可觀測的專題實作範例

---

建議先從 [00-course-map.md](./00-course-map.md) 開始，確認學習節奏與環境，接著依章節順序完成每週練習。
