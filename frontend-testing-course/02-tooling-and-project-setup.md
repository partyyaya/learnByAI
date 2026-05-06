# 02｜工具鏈與專案建置

> 這章要把「能執行測試」這件事一次打通。你會得到一套可直接用在前端專案的測試工具鏈與目錄規範。

## 學習目標

- 了解本課程預設工具鏈為什麼這樣選。
- 完成單元/整合/E2E 的基本安裝與命令設定。
- 建立可維護的測試目錄與命名規則。
- 讓團隊成員能透過同一組指令執行測試。

## 本課程預設工具鏈

- `Vitest`：測試執行器，負責跑單元與整合測試。
- `Testing Library`：以使用者行為為中心寫 UI 測試。
- `MSW`：mock API，讓測試環境可控且穩定。
- `Playwright`：E2E 測試與跨瀏覽器驗證。

### 框架對應（框架無關設計）

- React：`@testing-library/react`
- Vue：`@testing-library/vue` 或 `@vue/test-utils`
- Angular：`@testing-library/angular`

> 核心觀念相同：盡量從使用者可見行為驗證功能，不依賴內部實作。

## 安裝步驟（以 npm 為例）

### 1) 安裝單元與整合測試依賴

```bash
npm install -D vitest @testing-library/dom jsdom @testing-library/user-event
```

如果是 React：

```bash
npm install -D @testing-library/react
```

如果是 Vue：

```bash
npm install -D @testing-library/vue @vue/test-utils
```

### 2) 安裝 API mock 與 E2E

```bash
npm install -D msw playwright
npx playwright install
```

## `package.json` 測試命令建議

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed"
  }
}
```

## 建議目錄結構

```text
your-frontend-app/
  src/
    components/
    features/
    utils/
    test/
      setup.ts
      msw/
        handlers.ts
        server.ts
  tests-e2e/
    auth.spec.ts
    checkout.spec.ts
  playwright.config.ts
  vitest.config.ts
```

## 命名與撰寫規範

- 檔名：`*.test.ts`（單元/整合）、`*.spec.ts`（E2E）。
- 一個測試檔聚焦一個行為主題，不要把所有情境塞在同檔。
- `describe` 描述模組、`it`/`test` 描述可觀察行為。
- 測試名稱應可當文件閱讀，例如「未登入使用者應看到登入提示」。

## 最小設定範例

### `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true
  }
});
```

### `src/test/setup.ts`

```ts
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/dom";
import { server } from "./msw/server";

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());
```

## 常見卡點與排查

- 錯誤：找不到 `document`。
  - 檢查：`environment` 是否設定為 `jsdom`。
- 錯誤：測試互相污染。
  - 檢查：`afterEach` 是否有 `cleanup()` 與 `resetHandlers()`。
- 錯誤：E2E 在 CI 失敗、本機成功。
  - 檢查：是否固定測試資料、等待條件是否基於可見狀態而非固定 `timeout`。

## 本章練習

1. 在現有專案加入 `test` 與 `test:e2e` 指令。
2. 建立 `setup.ts` 並接好 MSW server。
3. 成功執行一次 `npm run test` 與 `npm run test:e2e`。

## 驗收清單

- [ ] 我可以一鍵執行單元與 E2E 測試。
- [ ] 我的測試目錄結構具備可擴充性。
- [ ] 團隊成員能用同樣指令重現測試結果。

---

完成後請前往 [03-your-first-unit-test-red-green-refactor.md](./03-your-first-unit-test-red-green-refactor.md)。
