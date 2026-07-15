# 第 14 章：測試、部署與期末專題

## 本章目標

完成這一章後，你應該可以：

1. 在 Vite 專案中設定 Vitest + React Testing Library。
2. 為純函式與 React 元件撰寫可維護的測試。
3. 打包專案、設定環境變數，並部署到靜態託管平台。
4. 獨立完成一個涵蓋全課程能力的期末專題。

---

## 1. 測試在測什麼？

前端測試的重點不是「測 React」，而是**測你的行為承諾**：

- 純函式：給定輸入，輸出是否正確（驗證規則、資料轉換）
- 元件：使用者操作後，畫面是否呈現預期結果

有兩個原則貫穿本章：

> 1. **測行為，不測實作細節。** 測「點了新增後清單多一筆」，不要測「state 變數叫什麼名字」。
> 2. **查詢元素優先用使用者視角。** `getByRole` / `getByLabelText` 優先，`getByTestId` 是最後手段。

---

## 2. 安裝 Vitest + React Testing Library

Vite 專案的標準測試組合：

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

各套件角色：

- `vitest`：測試框架（跑測試、斷言），與 Vite 共用設定，速度快
- `jsdom`：在 Node 中模擬瀏覽器 DOM
- `@testing-library/react`：渲染元件並以使用者視角查詢
- `@testing-library/jest-dom`：補充 DOM 斷言（如 `toBeInTheDocument`）
- `@testing-library/user-event`：模擬真實使用者操作（輸入、點擊）

### 設定 `vite.config.js`

```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/setupTests.js",
  },
});
```

### 建立 `src/setupTests.js`

```js
import "@testing-library/jest-dom";
```

### 加入 npm script

```json
{
  "scripts": {
    "test": "vitest"
  }
}
```

執行 `npm run test`，Vitest 會進入 watch 模式，存檔即重跑。

---

## 3. 第一個測試：純函式

最容易上手也最划算的測試對象，是第 6 章的 `validateForm` 這類純函式。  
先把它抽到獨立檔案（`src/utils/validateForm.js`），再寫測試：

```js
// src/utils/validateForm.test.js
import { describe, expect, it } from "vitest";
import { validateForm } from "./validateForm";

const validInput = {
  title: "React Router 實戰",
  level: "beginner",
  minutes: "60",
  description: "學會巢狀路由與動態參數的實務用法",
};

describe("validateForm", () => {
  it("合法輸入不回傳任何錯誤", () => {
    expect(validateForm(validInput)).toEqual({});
  });

  it("標題太短時回傳錯誤訊息", () => {
    const errors = validateForm({ ...validInput, title: "abc" });
    expect(errors.title).toBe("課程名稱至少 4 個字。");
  });

  it("時長超出範圍時回傳錯誤訊息", () => {
    const errors = validateForm({ ...validInput, minutes: "999" });
    expect(errors.minutes).toBe("課程時長需介於 5 到 180 分鐘。");
  });
});
```

寫測試的節奏是固定的三段式：**準備輸入 → 執行 → 斷言輸出**。

---

## 4. 元件測試：render、screen、userEvent

元件測試模擬的是使用者的完整操作流程：

```jsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
```

- `render(<App />)`：把元件掛進 jsdom
- `screen.getByRole(...)`：像使用者一樣「看到」元素
- `userEvent.setup()`：產生模擬操作者，`type`、`click` 都回傳 Promise，記得 `await`

常用查詢優先序：

| 優先序 | 查詢 | 例子 |
|--------|------|------|
| 1 | `getByRole` | `getByRole("button", { name: "新增" })` |
| 2 | `getByLabelText` | 表單欄位 |
| 3 | `getByPlaceholderText` / `getByText` | 無 label 時 |
| 最後 | `getByTestId` | 上面都拿不到才用 |

> 進階提醒：含 TanStack Query 的元件，測試時要用 `QueryClientProvider` 包住再 render；
> 含 Router 的元件則用 `MemoryRouter` 包住。做期末專題時會用到。

---

## 5. 打包與環境變數

### 打包與本機預覽

```bash
npm run build      # 產出 dist/（壓縮後的靜態檔案）
npm run preview    # 用本機伺服器預覽 dist/，模擬正式環境
```

部署前務必用 `preview` 走一遍主要流程——開發模式（dev）與打包結果偶爾行為不同。

### 環境變數

Vite 只會把 **`VITE_` 開頭**的變數暴露給前端程式：

```bash
# .env.development
VITE_API_URL=http://localhost:3000

# .env.production
VITE_API_URL=https://api.example.com
```

程式中透過 `import.meta.env` 讀取：

```js
const baseURL = import.meta.env.VITE_API_URL;
```

注意：前端環境變數會被打包進 JS，**任何人都看得到**，絕不能放密鑰。

---

## 6. 部署 SPA 的一個關鍵：路由 fallback

React Router 的路徑（如 `/courses/react-basic`）只存在於前端。  
使用者直接重新整理這個網址時，伺服器上並沒有這個檔案，會回 404。

解法是讓伺服器把所有路徑都導回 `index.html`（稱為 history fallback）：

| 平台 | 設定方式 |
|------|----------|
| Vercel | 偵測到 Vite 專案自動處理，通常零設定 |
| Netlify | 在 `public/` 加 `_redirects` 檔，內容：`/*  /index.html  200` |
| GitHub Pages | 不支援 rewrite，需設定 `base` 並用 404.html 技巧（或改用 HashRouter） |
| Nginx | `try_files $uri $uri/ /index.html;` |

部署流程以 Vercel 為例：推上 GitHub → 在 Vercel 匯入 repo → 它自動執行 `npm run build` 並發布 `dist/`，之後每次 push 自動重新部署。

---

## 7. 期末專題：課程管理後台

把 14 章的能力收斂成一個完整專案。題目：**線上課程管理後台**。

### 必做需求

| # | 需求 | 對應章節 |
|---|------|----------|
| 1 | 登入頁：受控表單 + 同步驗證，登入態存 Zustand | 06、11 |
| 2 | 多頁路由：Layout、巢狀路由、動態參數、404、路由守衛 | 08 |
| 3 | 課程列表：`useQuery` 抓資料，loading / error / empty 三態 | 09 |
| 4 | 課程新增與刪除：`useMutation` + 樂觀更新 + 失敗回滾 | 10 |
| 5 | 篩選與搜尋：條件放 Zustand，接進 `queryKey` 自動重抓 | 11、12 |
| 6 | 效能：大型列表用 `memo` / `useMemo`，頁面用 `React.lazy` 拆包 | 13 |
| 7 | 測試：至少 1 個純函式測試 + 2 個元件互動測試 | 14 |
| 8 | 部署：發布到 Vercel 或 Netlify，重新整理深層路由不 404 | 14 |

### 加分項

- `useInfiniteQuery` 無限捲動列表
- 亮 / 暗主題切換並以 `persist` 保存
- Error Boundary 包住主要內容區

### 驗收清單

- [ ] 重新整理任一頁面，登入態與偏好設定不丟失
- [ ] 關閉網路後操作，畫面有明確錯誤回饋而非白屏
- [ ] 樂觀更新失敗時，列表會回滾到操作前狀態
- [ ] `npm run test` 全數通過、`npm run build` 無錯誤

### 參考實作

卡關時可對照課程附帶的 [admin-demo/](./admin-demo/)——它就是這份規格的完整參考解答（外加使用者管理與效能實驗室）。建議先自己做，再回頭比對架構差異。

---

## 8. 本章小練習

1. 幫第 5 章的任務追蹤器補上「新增任務」與「切換完成」兩個元件測試。
2. 把第 6 章的 `validateForm` 抽成獨立模組並寫齊錯誤分支測試。
3. 用 `npm run build && npm run preview` 驗證打包結果可正常操作。
4. 把任一章的最終範例部署到 Vercel，確認深層路由重新整理不會 404。

---

## 最後範例：為學習任務追蹤器補上測試

以第 5 章的最終範例（學習任務追蹤器）為測試對象，元件程式不需修改。

### `src/App.test.jsx`

```jsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

describe("學習任務追蹤器", () => {
  it("預設渲染三筆任務", () => {
    render(<App />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("輸入文字並送出後，清單新增一筆任務", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByPlaceholderText(/新增任務/),
      "完成第 14 章測試練習"
    );
    await user.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.getByText("完成第 14 章測試練習")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("空白輸入送出時，不會新增任務", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("勾選任務會切換完成狀態", async () => {
    const user = userEvent.setup();
    render(<App />);

    const checkbox = screen.getByLabelText("手打 JSX 範例一遍");
    await user.click(checkbox);

    expect(checkbox).toBeChecked();
  });

  it("刪除任務後，清單少一筆", async () => {
    const user = userEvent.setup();
    render(<App />);

    const deleteButtons = screen.getAllByRole("button", { name: "刪除" });
    await user.click(deleteButtons[0]);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("完成 React 第 1 章")).not.toBeInTheDocument();
  });
});
```

### 執行結果

```bash
npm run test

 ✓ src/App.test.jsx (5)
   ✓ 學習任務追蹤器 (5)
     ✓ 預設渲染三筆任務
     ✓ 輸入文字並送出後，清單新增一筆任務
     ✓ 空白輸入送出時，不會新增任務
     ✓ 勾選任務會切換完成狀態
     ✓ 刪除任務後，清單少一筆

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### 範例解釋

1. 所有查詢都走使用者視角（`getByRole`、`getByLabelText`、`getByText`），元件內部重構不會弄壞測試。
2. `userEvent` 的操作都要 `await`，它會模擬完整的事件序列（focus、keydown、input…）。
3. 「空白輸入不新增」測的是邊界行為——這類測試最能在日後改壞邏輯時救你。
4. `queryByText` 用於斷言「元素不存在」；`getByText` 找不到會直接拋錯，不適合這個場景。

---

## 本章結語

到這裡，整套課程正式完成。你已經走過：元件與資料流（01～05）、表單與副作用（06～07）、路由（08）、伺服器狀態與本地狀態分工（09～12）、效能與除錯（13），以及測試與部署（14）。

最後一步是把期末專題做完、部署上線，再與 [admin-demo/](./admin-demo/) 比對架構差異——能獨立完成這個專題，你就具備了開發可維護 React 應用的完整能力。
