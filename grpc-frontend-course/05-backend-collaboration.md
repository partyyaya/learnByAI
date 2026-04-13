# 05 有後端時如何對接：協作流程與 SOP

## 1. 學習目標

- 建立前後端可複用的 gRPC 對接流程。
- 明確定義契約變更、聯調、驗收與發版節點。
- 降低「前後端各做各的」導致的返工與風險。
- 讓新成員可透過文件快速加入協作。

## 2. 先備知識

- 已完成 `02-proto-design.md` 與 `04-frontend-integration.md`。
- 了解團隊目前的分支策略與 CI/CD 流程。
- 有基本後端服務部署與環境區分概念（dev/stage/prod）。

## 3. 核心觀念

### 3.1 對接不是「前端等 API 好了再串」

推薦流程是契約先行：

1. 先 review `proto`
2. 前後端可並行開發
3. 用同一份 SDK / stub 聯調
4. 用 checklist 驗收後再上線

### 3.2 交付物要標準化

每次功能對接至少要有：

- `proto` 變更說明（含是否 breaking）
- 後端 RPC 行為說明（status code、timeout、冪等性）
- 前端 SDK 版本與升級說明
- 聯調紀錄與測試證據（截圖、log、測試報告）

### 3.3 風險前移

把常見風險提前處理：

- 權限規則不一致
- 錯誤碼未對齊
- 測試資料不穩定
- 環境配置差異過大

## 4. 實作步驟（建議 SOP）

### Step 1：需求拆解與契約會議

- 前後端共同確認 RPC 與 message 設計。
- 明確定義「成功、可預期失敗、不可預期失敗」。
- 產出：`proto` PR + 變更說明。

### Step 2：契約守門

- CI 跑 `buf lint` + `buf breaking`。
- 有破壞性變更時，需提出遷移路線與版本策略。
- 產出：可發布的契約版本標籤。

### Step 3：前後端並行開發

- 後端依契約實作 service。
- 前端先使用 stub/mock 或 stage 環境串接。
- 產出：前端功能頁面與後端 API 初版可跑通。

### Step 4：聯調週

- 使用固定測試帳號與測試資料。
- 核對：status code、錯誤訊息、timeout、重試、權限。
- 產出：聯調 checklist 與問題清單。

### Step 5：上線驗收

- smoke test（核心路徑）
- 監控面板確認（延遲、錯誤率）
- rollback 方案演練

## 5. 前後端對接重點

### 5.1 契約管理

- 建議使用單獨 proto repo 或 mono-repo `api/` 目錄。
- 每次 proto 變更都要有 reviewer（至少前端 + 後端各一位）。

### 5.2 錯誤碼對齊表

| gRPC Code | 後端語意 | 前端行為 |
|-----------|----------|----------|
| Unauthenticated | token 無效/過期 | 導向登入或觸發 refresh |
| PermissionDenied | 權限不足 | 顯示無權限提示，不重試 |
| InvalidArgument | 輸入不合法 | 顯示欄位提示 |
| NotFound | 資料不存在 | 顯示空狀態或引導返回 |
| Unavailable | 服務暫時不可用 | 可提示稍後再試，有限重試 |

### 5.3 認證與安全

- 定義 token 放 header metadata 還是 cookie。
- 確認 proxy 允許必要 headers。
- 若為跨域場景，預先完成 CORS 與憑證策略驗證。

### 5.4 發版策略

- proto、後端、前端 SDK 版本要可追蹤。
- 建議對齊 release note 模板，至少記錄：
  - 新增 RPC / 欄位
  - 行為變更
  - 兼容性影響

## 6. 常見坑與排查

- **症狀：前端通過測試但上線後報錯**
  - 可能原因：stage 與 prod 配置不一致。
  - 解法：建立環境差異清單並在上線前逐項核對。
- **症狀：同功能每次都要重講一次規格**
  - 可能原因：沒有固定的對接模板。
  - 解法：把本章 SOP 與 checklist 直接納入團隊流程。
- **症狀：問題定位耗時過久**
  - 可能原因：缺少 request id 或跨服務追蹤。
  - 解法：統一注入追蹤欄位並接到 log/trace 平台。

## 7. 作業

### 必做題

1. 產出一份你團隊可直接使用的「gRPC 對接 checklist」。
2. 建立一張 `gRPC Code -> 前端 UI 行為` 對照表。
3. 模擬一次 proto 變更流程（含 lint、breaking、版本說明）。

### 加分題

- 實際開一次跨團隊對接會，並用本章模板留下會議紀錄。

## 8. 驗收標準

- 流程可複用，不依賴特定人員口頭傳承。
- 契約、實作、聯調、發版每階段都有明確輸出物。
- 出現錯誤時能快速定位前端、proxy 或後端責任邊界。
- 對接時間相較過往明顯縮短（可量化最佳）。

## 9. 延伸閱讀

- [Google API Design Guide](https://cloud.google.com/apis/design)
- [gRPC Status Codes](https://grpc.github.io/grpc/core/md_doc_statuscodes.html)
