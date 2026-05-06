# 07｜功能流程整合測試

> 單元測試保護函式，整合測試保護「功能流程」。本章要把多個元件、狀態與 API 邊界串起來驗證。

## 學習目標

- 定義整合測試邊界，不與 E2E 混淆。
- 能為一條 feature flow 設計 happy path 與 sad path。
- 使用測試資料與 helper 降低整合測試維護成本。
- 讓測試失敗時能快速定位流程斷點。

## 前置知識

- 已完成 `06` 章 async/API 測試。
- 具備 router、store、API client 基本使用經驗。

## 什麼是整合測試的「好邊界」

整合測試應涵蓋：

- 多個元件間協作。
- 狀態管理更新與畫面同步。
- API 邊界行為（成功、失敗、空資料）。

整合測試不該涵蓋：

- 真實跨瀏覽器細節（那是 E2E 範疇）。
- 每個函式細節（那是單元測試範疇）。

## 流程切片範例：新增待辦功能

流程切片：

1. 使用者輸入文字並送出。
2. 送出期間按鈕 disabled + 顯示 loading。
3. 成功後列表新增項目。
4. 失敗時顯示錯誤訊息且可重試。

## 測試範例

```ts
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderTodoApp } from "./test-utils/renderTodoApp";

describe("todo creation flow", () => {
  it("should create todo and render in list", async () => {
    renderTodoApp();

    await userEvent.type(screen.getByPlaceholderText("Add todo"), "Buy milk");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
  });

  it("should show error and allow retry when api fails", async () => {
    renderTodoApp({ createTodoShouldFail: true });

    await userEvent.type(screen.getByPlaceholderText("Add todo"), "Pay bill");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Unable to save todo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
```

## 測試資料策略

- 每支整合測試都要有獨立初始資料。
- 用 factory 建立資料，避免硬編碼重複 JSON。
- 測試結束後清理狀態（store reset、handler reset）。

## 常見錯誤

- 只測 happy path，忽略高風險錯誤路徑。
- 整合測試做成超大端對端劇本，導致又慢又難修。
- 把 UI 文案改動當作流程失敗（斷言過度依賴細節字串）。

## 面試與實務延伸

- 如何界定某案例該寫整合測試還是 E2E？
- 若團隊抱怨整合測試慢，你會從哪些面向優化？
- 你如何設計「關鍵流程清單」來決定補測優先度？

## 本章練習

1. 選一個核心流程（註冊/下單/搜尋）做流程切片。
2. 至少寫出：
   - 1 支 happy path
   - 1 支 sad path
3. 將測試資料抽成可重用 factory。

## 驗收清單

- [ ] 我能定義整合測試邊界。
- [ ] 我有覆蓋成功與失敗流程。
- [ ] 失敗訊號可定位流程哪個階段出錯。

---

完成後請前往 [08-e2e-testing-critical-user-journeys.md](./08-e2e-testing-critical-user-journeys.md)。
