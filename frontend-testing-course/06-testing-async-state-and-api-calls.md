# 06｜非同步狀態與 API 測試

> 前端測試不穩定，通常不是工具問題，而是非同步控制失敗。本章教你把 async 測試變穩定、可預測。

## 學習目標

- 理解 async 測試常見失敗模式與排查方式。
- 正確使用 `findBy*`、`waitFor`、`userEvent` 來同步測試節奏。
- 用 MSW 模擬成功、錯誤、逾時回應。
- 驗證 loading/error/success 三態的完整行為。

## 前置知識

- 已完成 `05` 章，了解測試替身概念。
- 專案已設定 `MSW` 與測試 `setup.ts`。

## async 測試穩定三原則

1. **等狀態，不等時間**：避免硬寫 `setTimeout` 或 sleep。
2. **測可見行為，不測內部 promise**：只驗證使用者看得到的結果。
3. **每個測試重置環境**：避免前一支案例污染下一支。

## MSW handlers 範例

```ts
import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/api/orders", () => {
    return HttpResponse.json([{ id: "o-1", total: 1000 }]);
  }),
  http.get("/api/orders-error", () => {
    return new HttpResponse(null, { status: 500 });
  })
];
```

## 元件流程測試範例

```ts
import { screen } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { renderOrdersPage } from "./test-utils/renderOrdersPage";

describe("OrdersPage", () => {
  it("shows loading then renders orders", async () => {
    renderOrdersPage();

    expect(screen.getByText("Loading orders...")).toBeInTheDocument();
    expect(await screen.findByText("Order #o-1")).toBeInTheDocument();
    expect(screen.queryByText("Loading orders...")).not.toBeInTheDocument();
  });

  it("shows error message on api failure", async () => {
    renderOrdersPage({ endpoint: "/api/orders-error" });

    expect(await screen.findByText("Failed to load orders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
```

## 錯誤重試流程建議

- 按下 Retry 後，應再次顯示 loading。
- 成功回應後，錯誤訊息要消失。
- 若仍失敗，需保留可重試行為與可讀錯誤訊息。

## 常見錯誤

- 用 `await new Promise((r) => setTimeout(r, 1000))` 等待畫面更新。
- 混用 fake timers 與真實 timers，導致行為不一致。
- 測試結尾未清理 mock handlers，造成案例互相污染。
- `findBy` 與 `getBy` 使用時機混淆。

## 面試與實務延伸

- 為什麼在 async UI 測試中，`findBy` 通常比 `getBy` 更合適？
- 如果 API 失敗是間歇性，你會怎麼設計測試避免假陽性？
- 你會如何向團隊解釋「等待條件」比「等待秒數」更可靠？

## 本章練習

1. 為一個列表頁新增 2 支測試：
   - 成功載入資料
   - API 失敗並提示重試
2. 再補一支「按下重試後成功」測試，驗證完整三態切換。

## 驗收清單

- [ ] 我的 async 測試不依賴硬編碼 sleep。
- [ ] 我能穩定測試 loading/error/success 行為。
- [ ] MSW handlers 在每次測試後都有正確 reset。

---

完成後請前往 [07-integration-testing-for-feature-flows.md](./07-integration-testing-for-feature-flows.md)。
