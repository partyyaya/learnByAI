# 08｜E2E 與關鍵使用者旅程

> E2E 不是拿來把所有功能重測一遍，而是用來守住「最貴、最痛、最不能壞」的流程。

## 學習目標

- 會挑選高價值 E2E 案例（而不是追求數量）。
- 能用 Playwright 撰寫穩定可重跑的旅程測試。
- 理解 E2E 在整體測試策略中的定位。
- 建立 CI 可執行的 E2E 基本流程。

## 前置知識

- 已完成 `07` 章整合測試。
- 能使用 Playwright 基本指令與測試檔案結構。

## 如何選擇 E2E 題目

優先選擇：

- 直接影響轉換或收入的流程（註冊、付款、下單）。
- 權限與安全相關流程（登入、角色、存取控制）。
- 線上曾發生過重大事故的流程。

降低優先：

- 只有文案差異的頁面。
- 已有高覆蓋整合測試且風險低的流程。

## E2E 測試範例（Playwright）

```ts
import { expect, test } from "@playwright/test";

test("user can sign in and see dashboard", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill("user@example.com");
  await page.getByLabel("Password").fill("12345678");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/dashboard/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});
```

## 穩定性守則

1. 使用語意化 selector（`getByRole`、`getByLabel`）。
2. 等待可見狀態（URL、heading、button enabled），不要硬等秒數。
3. 測試資料可重置（每次執行都能回到初始狀態）。
4. 案例彼此獨立，不靠執行順序。

## CI 執行建議

- pull request：跑 smoke E2E（3 到 5 支最關鍵流程）。
- nightly：跑完整 E2E 套件。
- 失敗時保留 trace、screenshot、video 供排查。

## 常見錯誤

- 把 E2E 當整合測試替代品，案例爆量且執行超慢。
- selector 綁 CSS class，UI 改版後大量壞掉。
- 測試資料未隔離，導致偶發失敗（flaky）。

## 面試與實務延伸

- 你會如何說服團隊「E2E 少而精」比「E2E 全覆蓋」更合理？
- 若 CI 時間過長，你會如何分層測試與切分 pipeline？
- 面對 flaky test，你會先查腳本、資料，還是環境？

## 本章練習

1. 為你的產品定義 3 條關鍵旅程。
2. 寫 1 條登入流程 E2E。
3. 再寫 1 條交易流程 E2E（或核心提交流程）。

## 驗收清單

- [ ] E2E 案例聚焦高價值旅程。
- [ ] 腳本可在本機與 CI 穩定重跑。
- [ ] 我能提供失敗時的 trace/screenshot 作為證據。

---

完成後請前往 [09-accessibility-and-visual-regression-basics.md](./09-accessibility-and-visual-regression-basics.md)。
