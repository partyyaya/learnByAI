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

### Step 1：撰寫初版 proto（註釋版）

```proto
syntax = "proto3"; // 語法版本，現在主流使用 proto3

package todo.v1; // 契約命名空間：{domain}.{version}

message Todo { // message = 資料結構（類似 TS interface / type）
  string id = 1;                  // 欄位格式：<型別> <欄位名> = <field number>;
  string title = 2;               // field number 一旦發布，不可重用
  bool done = 3;                  // bool: true/false
  optional string assignee = 4;   // optional: 欄位可不存在（可判斷有無設定）
  map<string, string> labels = 5; // map<key, value>: 動態鍵值對
}

message GetTodoRequest { // Request message：輸入參數
  string id = 1;
}

message GetTodoResponse { // Response message：回傳資料
  Todo todo = 1;          // 可巢狀使用其他 message 型別
}

service TodoService { // service = RPC 服務集合
  // rpc 宣告格式：rpc 方法名(請求型別) returns (回應型別);
  rpc GetTodo(GetTodoRequest) returns (GetTodoResponse);
}
```

名詞速查：

- `syntax`：指定 proto 語法版本（本課使用 `proto3`）。
- `package`：命名空間 + 版本，避免跨服務命名衝突。
- `message`：資料模型定義（請求、回應、共用物件）。
- `field number`：欄位編號，負責線上編碼識別，**穩定性最重要**。
- `optional`：欄位可不出現，前端可判斷「未傳值」與「有值」。
- `map<K, V>`：字典型欄位，適合 labels、metadata。
- `service`：一組 RPC 方法的集合。
- `rpc ... returns ...`：定義一個遠端方法的輸入與輸出型別。

### Step 2：為未來變更預留規則

`reserved` 的用意與宣告方式：

- 用意：欄位**刪除後**，保留舊編號/舊名稱，避免未來被重用造成相容性問題。
- 數字保留宣告：`reserved 9, 10;` 或 `reserved 20 to 29;`
- 名稱保留宣告：`reserved "legacy_status";`
- 實務建議：刪除欄位時，同步保留「編號 + 欄位名」，最安全。

> 重點：`reserved` 不是「現在還可以用、未來可能刪」；而是「已刪除，且禁止未來重用」。

對應範例（建議直接對照看）：

```proto
// v1（已上線）
message Todo {
  string id = 1;
  string title = 2;
  string legacy_status = 9; // 舊狀態欄位，準備淘汰
  string old_source = 10;    // 舊資料來源欄位，準備淘汰
}

// v2（移除欄位後）
message Todo {
  reserved 9, 10;             // 對應「數字保留宣告」
  reserved "legacy_status";   // 對應「名稱保留宣告」

  string id = 1;
  string title = 2;
}
```

```proto
// 一次保留整段編號（例如規劃 20~29 不再使用）
message Todo {
  reserved 20 to 29; // 對應「reserved 20 to 29;」
}
```

重點：

- `reserved 9, 10;`：明確禁止未來再使用欄位編號 9 和 10。
- `reserved "legacy_status";`：明確禁止未來再用同名欄位。
- 兩者一起用：可同時避免「編號重用」與「名稱重用」造成的混淆。

`deprecated` 的用意與宣告方式（過渡期用）：

- 用意：標記「不建議再使用」，但欄位/方法仍可用於相容舊客戶端。
- 欄位宣告：`string legacy_status = 9 [deprecated = true];`
- RPC 宣告：在方法區塊中使用 `option deprecated = true;`
- 搭配策略：先 `deprecated`（給遷移時間）-> 全部遷移完成後刪除 -> 用 `reserved` 封存舊編號/舊名稱。

```proto
message Todo {
  string id = 1;
  string title = 2;
  string legacy_status = 9 [deprecated = true]; // 可用但不建議新程式再依賴
}

service TodoService {
  rpc GetTodo(GetTodoRequest) returns (GetTodoResponse);

  rpc GetTodoLegacy(GetTodoRequest) returns (GetTodoResponse) {
    option deprecated = true; // 服務端仍可提供，讓舊客戶端有遷移緩衝
  }
}
```

### Step 3：加入 lint 與 breaking check（註釋版）

```yaml
# buf.yaml
version: v2 # 使用 Buf v2 設定格式（目前建議版本）

lint:
  use:
    - STANDARD # 啟用 Buf 內建標準 lint 規則集（命名、結構、可讀性）

breaking:
  use:
    - FILE # 以檔案層級檢查破壞性變更（欄位型別變更、刪除 RPC 等）
```

名詞補充：

- `version: v2`：表示這份設定檔採用 Buf v2 schema。
- `lint`：靜態規範檢查，主要抓「風格與結構」問題。
- `STANDARD`：官方預設推薦規則集，適合多數團隊直接起步。
- `breaking`：相容性檢查，主要抓「會讓舊客戶端壞掉」的變更。
- `FILE`：用檔案層級比對 API 變更，適合課程與一般專案先建立基本防線。

檢查到 breaking change 時會發生什麼事？

```bash
# 常見做法：拿目前分支和 main 比
buf breaking --against '.git#branch=main'
```

```text
（輸出示意）
Failure: Found breaking changes against the target.
  - todo/v1/todo.proto: TodoService.GetTodo: RPC deleted (breaking)
  - todo/v1/todo.proto: Todo.done: field type changed (breaking)

Command failed with exit code 100
```

重點：

- 指令會失敗（non-zero exit code），CI job 也會跟著 fail。
- 你會看到哪個檔案、哪個 message/rpc、哪種 breaking 被抓到。
- 在有 PR gate 的流程下，這類變更通常不能直接合併，必須先修正或走升版策略。

如果不加 breaking check，可能會發生什麼事？

- 破壞性變更可能在 code review 漏掉，直接進到主分支。
- 舊版前端/其他服務在上線後才壞掉（NotFound、解析失敗、型別錯亂）。
- 問題常在「部署後」才被發現，回滾與跨團隊溝通成本高。
- 最糟情況是欄位編號被重用，舊客戶端把新資料解讀成錯誤語意。

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
