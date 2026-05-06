# 04｜以使用者視角做元件測試

> 本章核心：測試的是「使用者能做什麼、看到什麼」，而不是元件內部怎麼寫。

## 學習目標

- 能定義元件的可觀察行為（輸入、點擊、回饋）。
- 熟悉 Testing Library 的查詢與互動模式。
- 寫出可讀、穩定、可維護的元件測試。
- 避免對內部實作（state、method、class）過度耦合。

## 前置知識

- 已完成 `03` 章，熟悉基本斷言與測試節奏。
- 專案已安裝 Testing Library 與 `user-event`。

## 使用者視角的三個原則

1. **先找元素，再互動，再驗證結果**。
2. **優先使用語意化查詢**（role、label、text），避免 `querySelector`。
3. **描述行為結果，不描述內部實作**。

## 常用查詢策略（由優先到次要）

1. `getByRole`：最接近真實可近用語意。
2. `getByLabelText`：表單欄位測試非常實用。
3. `getByText`：驗證可見文案。
4. `getByTestId`：當語意查詢不可行時再使用。

## 範例：登入表單元件測試

### 元件行為需求

- 使用者輸入帳號與密碼後可送出。
- 欄位為空時顯示驗證錯誤。
- API 失敗時顯示錯誤訊息。

### 測試範例（框架無關思維）

```ts
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLoginForm } from "./test-utils/renderLoginForm";

describe("LoginForm", () => {
  it("should submit with valid inputs", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderLoginForm({ onSubmit });

    await userEvent.type(screen.getByLabelText("Email"), "user@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "12345678");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onSubmit).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "12345678"
    });
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
  });

  it("should show validation errors for empty fields", async () => {
    renderLoginForm();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByText("Email is required")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
  });
});
```

## 實作步驟建議

1. 先列出元件對使用者可見的三種狀態（正常、錯誤、邊界）。
2. 以「情境 + 預期」命名測試案例。
3. 每支測試只驗證一個核心行為。
4. 若元件過大，先切成可測試的小型組件。

## 常見錯誤

- 用 `data-testid` 查所有元素，導致可讀性差。
- 測試內直接呼叫元件私有函式。
- 一支測試塞太多斷言，失敗時難定位。
- 忽略錯誤流程，只測 happy path。

## 面試與實務延伸

- 如果 PM 要求快速改版，你如何決定先補哪三支元件測試？
- 當元件設計變動頻繁時，如何讓測試不脆弱？
- 你會如何向團隊解釋「語意化查詢」比 `testid` 更好？

## 本章練習

1. 選一個真實表單元件，寫出 3 個情境：
   - 成功送出
   - 欄位驗證錯誤
   - API 錯誤回饋
2. 將至少 1 個 `data-testid` 查詢改成 `getByRole` 或 `getByLabelText`。

## 驗收清單

- [ ] 我能用使用者行為描述測試案例。
- [ ] 我的查詢方式以語意化為主。
- [ ] 我同時覆蓋成功與失敗流程。

---

完成後請前往 [05-mocks-stubs-spies-and-test-doubles.md](./05-mocks-stubs-spies-and-test-doubles.md)。
