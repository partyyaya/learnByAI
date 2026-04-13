# 02 Proto 契約設計與版本相容

## 1. 學習目標

- 能用 `proto3` 設計前後端共同契約。
- 理解欄位編號（field number）與相容性的核心原則。
- 會用 `buf lint`、`buf breaking` 管理契約品質。
- 能規劃 API 演進策略，避免破壞前端既有功能。

## 2. 先備知識

- 已完成 `01-grpc-web-basics.md`。
- 了解 CRUD API 常見模式。
- 會使用 git 與基本 CI 流程。

## 3. 核心觀念

### 3.1 Proto 設計原則

- **命名一致**：`{domain}.{version}`，例如 `todo.v1`。
- **欄位穩定**：欄位編號一旦發布，不可重用。
- **語意清楚**：盡量避免模糊欄位（如 `data`, `info`）。
- **可演進性**：預留擴充空間，刪除欄位時使用 `reserved`。

### 3.2 常用型別與結構

- `optional`：表示欄位可能不存在（前端可判斷是否有值）。
- `oneof`：互斥輸入（查詢條件、不同 payload 類型常用）。
- `repeated`：陣列資料。
- `map<string, string>`：動態標籤或 metadata。

### 3.3 Breaking Change 觀念

以下通常屬於破壞性變更：

- 刪除 service method
- 變更既有欄位型別
- 重用已刪除欄位的 field number

## 4. 實作步驟

### Step 1：撰寫初版 proto

```proto
syntax = "proto3";

package todo.v1;

message Todo {
  string id = 1;
  string title = 2;
  bool done = 3;
  optional string assignee = 4;
  map<string, string> labels = 5;
}

message GetTodoRequest {
  string id = 1;
}

message GetTodoResponse {
  Todo todo = 1;
}

service TodoService {
  rpc GetTodo(GetTodoRequest) returns (GetTodoResponse);
}
```

### Step 2：為未來變更預留規則

```proto
message Todo {
  reserved 9, 10;
  reserved "legacy_status";
  // ... existing fields
}
```

### Step 3：加入 lint 與 breaking check

```yaml
# buf.yaml
version: v2
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
```

### Step 4：建立 PR 審查清單

每次修改 proto 都要確認：

1. 是否為破壞性變更
2. 前端 SDK 是否需要同步升版
3. 是否補上遷移說明（migration note）

## 5. 前後端對接重點

- **單一契約來源**：共用 mono-repo 或獨立 proto repo。
- **版本策略**：明確定義 `v1 -> v2` 何時開新 package。
- **回溯相容**：新增欄位可接受，修改既有欄位型別需避開。
- **文件同步**：每次 proto 變更需附 changelog 與影響面。

## 6. 常見坑與排查

- **症狀：前端解析不到某欄位**
  - 可能原因：後端升版但前端未更新 codegen。
  - 解法：在 CI 增加 SDK 版本檢查。
- **症狀：舊版前端突然壞掉**
  - 可能原因：後端做了 breaking change 卻未升 major/versioned package。
  - 解法：導入 `buf breaking` 強制檢查。
- **症狀：欄位值語意混亂**
  - 可能原因：同一欄位承載多種業務語意。
  - 解法：改用 `oneof` 或拆分 message。

## 7. 作業

### 必做題

1. 設計 `TaskService`，至少包含 `GetTask`、`ListTasks`、`CreateTask` 三個 RPC。
2. 在 message 中使用一次 `oneof`（例如以 `id` 或 `slug` 查詢）。
3. 補上 `buf.yaml`，並在本地跑通 lint。

### 加分題

- 設計一個 `v2` 版本草案，說明你為何要升版，以及如何平滑遷移。

## 8. 驗收標準

- proto 命名一致且可讀性高。
- 能說明每個欄位是否可能影響相容性。
- lint 與 breaking check 可執行。
- 有清楚寫出版本與遷移策略。

## 9. 延伸閱讀

- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)
- [Buf Lint and Breaking](https://buf.build/docs/lint/overview/)
