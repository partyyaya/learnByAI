# 04 前端整合：狀態管理、錯誤處理與認證

## 1. 學習目標

- 把 gRPC client 整合進前端頁面流程。
- 建立一致的 loading/error/success UI 狀態管理。
- 把 gRPC status code 映射成可理解的使用者提示。
- 完成 auth metadata、timeout 與 retry 策略配置。

## 2. 先備知識

- 已完成 `03-client-generation-sdk.md`。
- 熟悉 React Query、SWR 或 Vue Query 任一工具。
- 知道登入 token 與 session 的基本概念。

## 3. 核心觀念

### 3.1 不要讓頁面直接操作底層 client

推薦分層：

```text
Page/View                 # 負責畫面渲染與互動事件（點擊、輸入、導頁）
  -> useCase hook/service # 負責頁面流程：組合資料、管理 loading/error、呼叫業務行為
  -> grpc client wrapper  # 負責 SDK 封裝：統一參數/錯誤轉譯，隔離 UI 與底層 RPC 細節
  -> generated client     # 由 proto 自動生成，負責實際送出 RPC 請求與接收回應
```

各層用途速記：

- `Page/View`：只關心 UI 呈現與使用者互動，不直接寫 RPC 細節。
- `useCase hook/service`：承接頁面需求，協調資料請求流程與狀態。
- `grpc client wrapper`：把「可直接呼叫的業務 API」整理好，避免頁面散落 try/catch 與錯誤處理。
- `generated client`：機器生成的低層 client，跟 proto 契約對齊，通常不直接給頁面使用。

這樣可以避免：

- 每個頁面重複 try/catch
- 錯誤訊息風格不一致
- 後續改 transport 或認證策略時改動過大

### 3.2 建立統一錯誤映射

建議把 gRPC status 統一轉成 domain error：

- `Unauthenticated` -> 重新登入
- `PermissionDenied` -> 權限不足
- `NotFound` -> 資料不存在
- `Unavailable` -> 服務暫時不可用，可提示重試

### 3.3 timeout 與 retry 要有業務語意

- 查詢類 API：可短 timeout + 1~2 次 retry
- 寫入類 API：慎用 retry，避免重複提交

## 4. 實作步驟

### Step 1：封裝 domain service

```ts
export async function fetchTodoDetail(todoId: string) {
  const response = await todoClient.getTodo({ id: todoId });
  return {
    id: response.todo?.id ?? "",
    title: response.todo?.title ?? "",
    done: response.todo?.done ?? false,
  };
}
```

### Step 2：在 UI 層使用 query 管理狀態

```ts
const todoQuery = useQuery({
  queryKey: ["todo", todoId],
  queryFn: () => fetchTodoDetail(todoId),
  retry: 1,
});
```

### Step 3：建立錯誤轉譯函式

```ts
import { Code, ConnectError } from "@connectrpc/connect";

export function toUserMessage(error: unknown): string {
  const e = ConnectError.from(error);
  switch (e.code) {
    case Code.Unauthenticated:
      return "登入已失效，請重新登入。";
    case Code.PermissionDenied:
      return "你沒有操作這筆資料的權限。";
    case Code.NotFound:
      return "查無資料，請確認輸入內容。";
    default:
      return "系統忙碌中，請稍後再試。";
  }
}
```

### Step 4：補上 timeout 與 header

- 在 transport 層設定 `timeoutMs`（或透過 metadata 傳遞 timeout）。
- 由 interceptor 統一注入 `Authorization`、`X-Request-Id`。

## 5. 前後端對接重點

- **錯誤碼約定文件**：後端需提供每個 RPC 可能回傳的 status。
- **idempotency 約定**：重試策略需與後端是否冪等一致。
- **token 更新流程**：401/Unauthenticated 發生時是否可自動 refresh token。
- **追蹤 ID**：前後端共用 request id，方便排查問題。

## 6. 常見坑與排查

- **症狀：畫面顯示「未知錯誤」比例很高**
  - 可能原因：未建立錯誤映射，或後端未回標準 status。
  - 解法：補 mapping 並要求後端錯誤碼治理。
- **症狀：登入過期後頁面狂打 API**
  - 可能原因：query 自動重試且未攔截 Unauthenticated。
  - 解法：對 Unauthenticated 關閉重試並導向登入。
- **症狀：同一畫面重複打多次請求**
  - 可能原因：query key 設計不穩定。
  - 解法：固定 query key 結構並避免每次 render 新建參照。

## 7. 作業

### 必做題

1. 完成 Todo 詳情頁，處理 loading/error/empty/success 四種狀態。
2. 建立統一錯誤轉譯函式，至少處理 4 種 gRPC status。
3. 在 interceptor 加入 `Authorization` 與 `X-Request-Id`。

### 加分題

- 實作 token refresh 後自動重放一次原請求（避免多重重放）。

## 8. 驗收標準

- UI 狀態切換清楚，沒有「無回應」空白畫面。
- 錯誤訊息能對應實際狀態，不是統一彈同一句。
- 重試、timeout、auth 行為有清楚規則與紀錄。
- 程式結構具備擴充性（頁面不耦合底層 client）。

## 9. 延伸閱讀

- [TanStack Query](https://tanstack.com/query/latest)
- [Connect Errors](https://connectrpc.com/docs/web/errors/)
