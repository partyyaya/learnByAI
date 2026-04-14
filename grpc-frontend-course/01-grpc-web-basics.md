# 01 gRPC-Web 基礎與瀏覽器限制

## 1. 學習目標

- 理解 gRPC、gRPC-Web、Connect 在前端中的定位。
- 知道為什麼瀏覽器不能直接使用原生 gRPC。
- 能跑通第一個 unary call，並看懂回傳狀態。
- 能描述「前端 -> Proxy -> gRPC 後端」的基本對接路徑。

## 2. 先備知識

- 會使用 `fetch` 或 axios 串 REST API。
- 知道 HTTP request / response 與狀態碼概念。
- 具備 TypeScript 基礎（介面、型別、async/await）。

## 3. 核心觀念

### 3.1 gRPC 在前端的實際架構

在瀏覽器中，常見路徑是：

```text
Browser App
  -> gRPC-Web / Connect 客戶端
  -> Envoy / Connect Proxy（可選）
  -> gRPC Server（Go / Java / Node / Rust）
```

### 3.2 為什麼瀏覽器不能直接打原生 gRPC

- 原生 gRPC 依賴 HTTP/2 framing 與 trailers。
- 瀏覽器對底層 HTTP/2 控制有限，不易直接操作 gRPC wire format。
- 因此前端常透過 gRPC-Web 或 Connect 協定由 Proxy 轉換。

### 3.3 Unary 與 Streaming

- **Unary**：一次請求一次回應（前端最常見）。
- **Server Streaming**：一次請求，多次回應（通知、進度、即時資料）。
- **Client/Bidi Streaming**：在瀏覽器場景相對少見，通常由後端或 Node client 使用。

### 3.4 gRPC 的優缺點

- **優點：契約清楚、型別一致**  
  以 `proto` 作為單一契約來源，前後端共用型別，降低欄位對不上的風險。
- **優點：效能與傳輸效率佳**  
  Protobuf 體積通常比 JSON 小，對高頻請求與低延遲場景更有利。
- **優點：錯誤語意標準化**  
  可用一致的 status code（如 `NotFound`、`Unauthenticated`）處理錯誤情境。
- **缺點：前端接入較複雜**  
  瀏覽器不能直接用原生 gRPC，通常需要 gRPC-Web/Connect 與 proxy。
- **缺點：除錯可讀性不如 REST**  
  二進位 payload 不像 JSON 直觀，排查時更依賴工具與日誌。
- **缺點：學習與維運成本較高**  
  團隊需要熟悉 `proto`、codegen、版本管理與部署流程。

### 3.5 gRPC 適合使用的場景

- **內部系統服務間通訊（microservices）**  
  需要高吞吐、低延遲，且可控雙方技術棧與協定。
- **多端共享同一份 API 契約**  
  Web、App、後端 worker 同時使用時，`proto` 有助於維持一致性。
- **需要嚴謹型別與長期演進的 API**  
  適合大型團隊協作，降低「文件與實作不一致」問題。
- **需要 Streaming 的互動場景**  
  如進度推播、即時事件、長時間任務狀態更新。
- **跨語言團隊協作**  
  後端多語言（Go/Java/Node/Rust）時，gRPC 的跨語言支援更有優勢。

## 4. 實作步驟

### Step 1：啟動後端與 Proxy

- 使用課程提供的 compose（或團隊現有環境）啟動：
  - gRPC server
  - gRPC-Web proxy（例如 Envoy）
  - 前端開發伺服器

### Step 2：建立前端 transport 與 client

```ts
import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { TodoService } from "./gen/todo/v1/todo_connect";

const transport = createConnectTransport({
  baseUrl: import.meta.env.VITE_API_BASE_URL,
});

export const todoClient = createPromiseClient(TodoService, transport);
```

### Step 3：呼叫第一個 API

```ts
const response = await todoClient.getTodo({ id: "todo-001" });
console.log("todo title:", response.todo?.title);
```

### Step 4：處理基本錯誤

```ts
import { Code, ConnectError } from "@connectrpc/connect";

try {
  await todoClient.getTodo({ id: "not-exists" });
} catch (err) {
  const e = ConnectError.from(err);
  if (e.code === Code.NotFound) {
    // 顯示資料不存在提示
  }
}
```

## 5. 前後端對接重點

- **契約來源一致**：確認前端與後端使用同一份 `proto`。
- **路由與網域設定**：確認 proxy 路由、CORS、cookie/header 行為。
- **認證資料**：先約定 token 放在 metadata 或 cookie。
- **錯誤語義**：先對齊 `NotFound`、`Unauthenticated`、`PermissionDenied` 等語意。

## 6. 常見坑與排查

- **症狀：瀏覽器報 CORS 錯誤**
  - 可能原因：proxy 未開放 `grpc-timeout` 或自訂 metadata header。
  - 解法：補上對應 allow headers 與 methods。
- **症狀：呼叫成功但拿不到正確錯誤碼**
  - 可能原因：後端把所有錯誤都包成 `Unknown`。
  - 解法：統一使用標準 gRPC status code。
- **症狀：前端打不到後端**
  - 可能原因：base URL 指錯或 proxy 未啟動。
  - 解法：先用 health check endpoint 驗證服務狀態。

## 7. 作業

### 必做題

1. 建立 `PingService`（`ping` 回 `pong`）並從前端呼叫成功。
2. 設計一個「查詢單筆 Todo」的 unary API，前端完成 UI 顯示。
3. 讓「查不到資料」回傳 `NotFound`，前端顯示友善訊息。

### 加分題

- 在開發者工具中截圖一次成功與一次失敗請求，標出 status 差異。

## 8. 驗收標準

- 能口頭說明 gRPC-Web 架構與限制。
- 前端可穩定呼叫 unary API。
- 基本錯誤碼可在 UI 呈現不同訊息。
- 有簡短紀錄「踩到的坑與修正方式」。

## 9. 延伸閱讀

- [gRPC 官方文件](https://grpc.io/docs/)
- [Connect RPC 文件](https://connectrpc.com/docs/)
- [gRPC-Web 文件](https://github.com/grpc/grpc-web)
