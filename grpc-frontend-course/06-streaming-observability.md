# 06 Streaming、效能與可觀測性

## 1. 學習目標

- 理解前端使用 Server Streaming 的典型場景與限制。
- 能在 UI 中正確處理串流資料生命週期（開始、更新、結束、取消）。
- 能定義 gRPC API 的核心效能指標與告警門檻。
- 能建立前後端共享的觀測語言（log、metric、trace）。

## 2. 先備知識

- 已完成 `04-frontend-integration.md`。
- 熟悉 Promise/async iterator 基礎。
- 知道基本的監控概念（成功率、延遲、吞吐）。

## 3. 核心觀念

### 3.1 什麼時候該用 Server Streaming

適合：

- 任務進度通知
- 即時事件 feed
- 長任務狀態更新

不適合：

- 只需一次查詢結果的場景（用 unary 更簡單）
- 高頻雙向互動（瀏覽器端可先評估 WebSocket）

### 3.2 串流 UI 的四個狀態

- **connecting**：建立串流中
- **active**：持續收到事件
- **completed**：串流正常結束
- **error/cancelled**：異常或主動中止

### 3.3 可觀測性要能回答三個問題

1. 使用者現在是不是壞了？
2. 壞在哪一層（前端、proxy、後端）？
3. 影響範圍有多大？

## 4. 實作步驟

### Step 1：實作串流訂閱

```ts
export async function subscribeTodoEvents(projectId: string, onEvent: (event: unknown) => void) {
  const stream = todoClient.watchTodoEvents({ projectId });
  for await (const event of stream) {
    onEvent(event);
  }
}
```

### Step 2：加入取消機制

```ts
const abortController = new AbortController();

const stream = todoClient.watchTodoEvents(
  { projectId: "p-1" },
  { signal: abortController.signal }
);

// 頁面離開時取消
abortController.abort();
```

### Step 3：建立監控指標

前端至少記錄：

- API success rate
- gRPC code 分佈
- 首屏資料時間（TTFD）
- 串流中斷率與重連次數

### Step 4：串接告警策略

- `Unavailable` 超過閾值時告警。
- `Unauthenticated` 異常飆升時檢查 auth 流程。
- 串流重連次數過高時檢查網路與 proxy 配置。

## 5. 前後端對接重點

- **事件定義穩定性**：串流 event schema 不可頻繁破壞變更。
- **節流與批次策略**：後端需避免過高事件頻率壓垮前端渲染。
- **重連語義**：中斷後是否支援 cursor/resume token。
- **trace 關聯**：request id 需可串到後端 trace。

## 6. 常見坑與排查

- **症狀：切頁後仍持續收事件**
  - 可能原因：未在 unmount 時 abort stream。
  - 解法：統一在 hook/service 管理取消機制。
- **症狀：串流偶發中斷但無法定位**
  - 可能原因：缺少中斷原因與 code 記錄。
  - 解法：在 catch 區塊記錄 code、message、request id。
- **症狀：前端卡頓**
  - 可能原因：事件更新太頻繁，直接觸發大量 re-render。
  - 解法：導入節流、批次合併或虛擬列表。

## 7. 作業

### 必做題

1. 做一個「任務進度」頁面，使用 server streaming 即時更新進度條。
2. 在頁面離開時正確取消串流連線。
3. 上報至少 3 個觀測指標（成功率、錯誤碼、串流中斷率）。

### 加分題

- 實作串流中斷後自動重連（含退避策略與最大重試次數）。

## 8. 驗收標準

- 串流可穩定顯示並可主動取消。
- 發生中斷時 UI 有可理解提示，不會無聲失敗。
- 有基本監控數據可支援問題追查。
- 能說明重連策略與其風險。

## 9. 延伸閱讀

- [Connect Streaming](https://connectrpc.com/docs/web/using-clients/)
- [OpenTelemetry](https://opentelemetry.io/docs/)
