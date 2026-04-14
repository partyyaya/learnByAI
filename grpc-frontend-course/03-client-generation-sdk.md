# 03 Client 生成與 SDK 封裝（JS 必修，TypeScript 選讀）

## 1. 學習目標

- 能從 `proto` 自動生成前端可用 client（不限 JavaScript 或 TypeScript）。
- 能建立 SDK 封裝層，避免頁面直接依賴 codegen 檔案。
- 能配置 interceptor（auth、log、retry、timeout）。
- 能規劃 SDK 版本與發佈策略，讓前後端同步升級。

## 2. 先備知識

- 已完成 `02-proto-design.md`。
- 熟悉 JavaScript 專案結構。
- 了解 npm package 的基本發佈流程。

## 3. 本章學習方式（先核心，再選讀）

### A. 必修核心

- codegen 流程
- transport 與 interceptor
- service client 封裝
- adapter（RPC model -> UI model）

### B. TypeScript 選讀（進階強化）

- 型別收斂、泛型封裝、錯誤型別定義
- 只在你有 TS 需求時再深入

## 4. 核心觀念

### 4.1 為什麼需要 SDK 封裝層

- 隔離 codegen 與業務程式碼。  
  （`codegen` = code generation，指用 `proto` 自動產生前端可呼叫的 client 與型別檔，不是手寫）
- 集中處理重試、錯誤碼映射、metadata 注入。
- 未來切換傳輸層時，業務側改動最小。

### 4.2 建議目錄結構（JavaScript 版）

```text
src/
  grpc/
    gen/                # codegen output
    transport.js        # 建立 transport
    clients/
      todoClient.js     # service-specific client
    adapters/
      todoAdapter.js    # RPC model -> UI model
```

### 4.3 codegen 是可重建資產

- 不要手改 `gen/` 內的檔案。
- 客製邏輯放在 `clients/`、`adapters/`、`services/`。

## 5. 必修實作步驟（JavaScript）

### Step 1：設定 `buf.gen.yaml`

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: src/grpc/gen
  - local: protoc-gen-connect-es
    out: src/grpc/gen
```

### Step 2：生成前端程式碼

```bash
buf generate
```

### Step 3：建立共用 transport

```js
import { createConnectTransport } from "@connectrpc/connect-web";

export function createAppTransport(getToken) {
  return createConnectTransport({
    baseUrl: import.meta.env.VITE_API_BASE_URL,
    interceptors: [
      (next) => async (req) => {
        const token = getToken();
        if (token) req.header.set("Authorization", `Bearer ${token}`);
        return await next(req);
      },
    ],
  });
}
```

### Step 4：封裝 service client

```js
import { createPromiseClient } from "@connectrpc/connect";
import { TodoService } from "../gen/todo/v1/todo_connect";
import { createAppTransport } from "../transport";

export function createTodoClient(getToken) {
  const transport = createAppTransport(getToken);
  return createPromiseClient(TodoService, transport);
}
```

### Step 5：建立 adapter（讓 UI 不直接吃 RPC 結構）

```js
export function toTodoViewModel(response) {
  const todo = response?.todo ?? {};
  return {
    id: todo.id ?? "",
    title: todo.title ?? "",
    done: Boolean(todo.done),
  };
}
```

## 6. 前後端對接重點

- **codegen 觸發時機**：proto 更新後由 CI 自動生成或檢查差異。
- **SDK 升版策略**：對齊 proto 版本，至少維持 minor/major 規範。
- **跨 repo 協作**：如果前後端分 repo，定義明確發布流程與通知機制。
- **相依鎖定**：避免前端自動升到未驗證的 SDK 版本。

## 7. 常見坑與排查

- **症狀：codegen 後 import 路徑錯誤**
  - 可能原因：bundler 與 codegen 設定不一致。
  - 解法：統一 ESM 設定與輸出目錄規則。
- **症狀：每個頁面都在手動加 token**
  - 可能原因：未集中在 transport/interceptor 注入 auth。
  - 解法：統一透過 interceptor 處理。
- **症狀：業務程式到處 import `gen/*`**
  - 可能原因：缺少 SDK 封裝層。
  - 解法：只暴露 `createXxxClient` 與 adapter。

## 8. 作業

### 必做題（JavaScript）

1. 在你的專案中建立 `src/grpc/gen` codegen 目錄。
2. 完成 `createAppTransport` 與 `createTodoClient`。
3. 新增一個 adapter，把 RPC response 轉成 UI model。

### 選做題（TypeScript 強化）

- 把 SDK 抽成獨立 package，並替公開 API 補齊型別定義。

## 9. 驗收標準

- 可一鍵生成 client。
- 業務程式不直接依賴 codegen 檔案。
- auth 與共通邏輯可集中管理。
- 具備可持續升級的 SDK 結構。

## 10. TypeScript 延伸閱讀（選讀）

如果你使用 TypeScript，建議補強以下內容：

- 為 `createXxxClient` 建立明確輸入輸出型別。
- 建立 `DomainError` 型別，統一封裝 gRPC error。
- 用泛型封裝通用 API 呼叫器（含 retry、timeout、error mapping）。
- 詳細講解請見 [03a-typescript-lecture.md](./03a-typescript-lecture.md)。

推薦閱讀：

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Buf Generate](https://buf.build/docs/generate/)
- [Connect for Web](https://connectrpc.com/docs/web/getting-started/)
