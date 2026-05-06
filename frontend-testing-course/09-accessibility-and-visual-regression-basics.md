# 09｜可近用性與視覺回歸入門

> 功能能跑不代表品質完整。這章會讓你補上兩個常被忽略的保護層：可近用性與視覺回歸。

## 學習目標

- 理解 a11y 自動化檢查在測試策略中的角色。
- 能為關鍵頁面加入基本可近用性測試。
- 建立視覺回歸基準與更新流程。
- 知道如何降低視覺測試誤報（false positive）。

## 前置知識

- 已完成 `08` 章，熟悉 E2E 基本流程。
- 了解語意化 HTML 與基礎 ARIA 概念。

## 可近用性測試重點

建議優先檢查：

- 表單欄位是否有 label。
- 互動元件是否可被鍵盤操作。
- 圖片是否有合理替代文字。
- 顏色對比與焦點狀態是否清楚。

## a11y 自動化範例（測試概念）

```ts
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import LoginPage from "./LoginPage";

describe("LoginPage accessibility", () => {
  it("should have no obvious accessibility violations", async () => {
    const { container } = render(<LoginPage />);
    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });
});
```

> 若非 React，仍可沿用同概念：渲染頁面後執行 a11y 規則檢查。

## 視覺回歸測試定位

- 用途：抓出排版破版、樣式退化、元件位置異常。
- 限制：不擅長判斷商業邏輯正確性。
- 建議：與功能測試互補，不互相替代。

## Playwright 視覺快照範例

```ts
import { expect, test } from "@playwright/test";

test("product card visual baseline", async ({ page }) => {
  await page.goto("/products");
  await expect(page.getByTestId("product-card-list")).toHaveScreenshot("products-list.png");
});
```

## 降低誤報技巧

1. 固定字型、時區、語系與視窗尺寸。
2. 避免測試中包含隨機資料或即時時間戳。
3. 對動態區塊做遮罩或獨立測試。
4. 建立「基準圖更新規範」，避免任意覆寫。

## 常見錯誤

- 把 a11y 工具當成萬能，忽略手動鍵盤巡檢。
- 視覺快照測太大頁面，導致噪音過高難維護。
- 沒有 review 流程就直接更新基準圖。

## 面試與實務延伸

- 你會如何解釋「a11y 是品質議題，不是額外加分題」？
- 視覺回歸出現 diff 時，如何判斷是預期變更或缺陷？
- 在資源有限下，你會先補 a11y 還是視覺回歸，為什麼？

## 本章練習

1. 為 1 個關鍵頁面加入 a11y 自動檢查。
2. 為 1 個高曝光元件建立視覺基準圖。
3. 撰寫一份「基準圖更新規範」草案（誰能更新、何時更新、如何審查）。

## 驗收清單

- [ ] 我知道 a11y 自動化能覆蓋哪些風險。
- [ ] 我有一個可執行的視覺回歸案例。
- [ ] 我知道如何避免視覺測試誤報。

---

完成後請前往 [10-test-data-fixtures-and-maintainability.md](./10-test-data-fixtures-and-maintainability.md)。
