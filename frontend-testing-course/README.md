# Frontend Testing 課程（框架無關）

> 這套課程面向「幾乎沒寫過測試」的前端工程師，目標是讓你能用測試建立可維護、可重構、可上線的前端專案。

---

## 課程目錄

| 章節 | 檔案 | 主題 | 狀態 |
|------|------|------|------|
| 00 | [00-course-map-and-testing-mindset.md](./00-course-map-and-testing-mindset.md) | 課程地圖、測試思維與學習節奏 | 初稿完成 |
| 01 | [01-testing-fundamentals-and-quality-model.md](./01-testing-fundamentals-and-quality-model.md) | 測試基礎與品質模型 | 初稿完成 |
| 02 | [02-tooling-and-project-setup.md](./02-tooling-and-project-setup.md) | 工具鏈與專案建置 | 初稿完成 |
| 03 | [03-your-first-unit-test-red-green-refactor.md](./03-your-first-unit-test-red-green-refactor.md) | 第一個單元測試與 RGR 循環 | 初稿完成 |
| 04 | [04-component-testing-user-perspective.md](./04-component-testing-user-perspective.md) | 以使用者視角做元件測試 | 初稿完成 |
| 05 | [05-mocks-stubs-spies-and-test-doubles.md](./05-mocks-stubs-spies-and-test-doubles.md) | 測試替身：Mock/Stub/Spy | 初稿完成 |
| 06 | [06-testing-async-state-and-api-calls.md](./06-testing-async-state-and-api-calls.md) | 非同步狀態與 API 測試 | 初稿完成 |
| 07 | [07-integration-testing-for-feature-flows.md](./07-integration-testing-for-feature-flows.md) | 功能流程整合測試 | 初稿完成 |
| 08 | [08-e2e-testing-critical-user-journeys.md](./08-e2e-testing-critical-user-journeys.md) | E2E 與關鍵使用者旅程 | 初稿完成 |
| 09 | [09-accessibility-and-visual-regression-basics.md](./09-accessibility-and-visual-regression-basics.md) | 可近用性與視覺回歸 | 初稿完成 |
| 10 | [10-test-data-fixtures-and-maintainability.md](./10-test-data-fixtures-and-maintainability.md) | 測試資料與可維護性 | 初稿完成 |
| 11 | [11-ci-quality-gates-and-test-reporting.md](./11-ci-quality-gates-and-test-reporting.md) | CI、品質門檻與報表 | 初稿完成 |
| 12 | [12-legacy-code-safety-and-refactor-strategy.md](./12-legacy-code-safety-and-refactor-strategy.md) | 舊系統補測與重構策略 | 初稿完成 |
| 13 | [13-capstone-real-world-testing-playbook.md](./13-capstone-real-world-testing-playbook.md) | 專題實戰與落地手冊 | 初稿完成 |

---

## 預設工具鏈（已確認）

本課程採「框架無關」設計，但為了讓新手可以快速實作，示範工具預設如下：

- `Vitest`：單元測試與元件測試執行器（速度快、設定簡潔）。
- `Testing Library`：以使用者視角撰寫 UI 測試（React/Vue/Angular 皆有對應實作）。
- `MSW`：攔截 API 請求，讓整合測試可控且穩定。
- `Playwright`：E2E 測試、跨瀏覽器驗證與 CI 執行。

備選方案（課程內會對照概念）：`Jest`、`Cypress`。

## 建議學習節奏

1. 基礎與心法：`00` ~ `03`
2. 實戰核心：`04` ~ `08`
3. 團隊落地：`09` ~ `13`

## 你會得到什麼

- 一套可重複使用的前端測試分層策略。
- 一份可直接套到專案的測試目錄與命名規範。
- 一套從本地到 CI 的測試執行流程。

---

建議先從 [00-course-map-and-testing-mindset.md](./00-course-map-and-testing-mindset.md) 開始。
