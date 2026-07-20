# 第 14 章：測試與部署

## 本章目標

完成這一章後，你應該可以：

1. 用 Vitest + Testing Library 測純函式與 Client 元件。
2. 測試 Server Action 的行為（驗證邏輯）。
3. 正確管理環境變數（`.env`、`NEXT_PUBLIC_`）。
4. 用 `next build` 打包並理解建置輸出。
5. 部署到 Vercel，並處理正式環境的資料庫。

---

## 1. 測試策略：測行為，不測框架

和 React 課一樣的原則：

> 1. **測行為，不測實作細節。**
> 2. **查詢元素優先用使用者視角**（`getByRole`、`getByLabelText`）。

Next.js 特有的注意點：Server Component（async 元件）目前不適合用單元測試工具直接 render，這類頁面用 **E2E 測試**（Playwright）更合適。單元測試主要針對：**純函式、驗證邏輯、Client 元件**。

---

## 2. 安裝 Vitest + Testing Library

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @vitejs/plugin-react
```

`vitest.config.js`：

```js
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./vitest.setup.js",
  },
});
```

`vitest.setup.js`：

```js
import "@testing-library/jest-dom";
```

`package.json` 加：

```json
{ "scripts": { "test": "vitest" } }
```

---

## 3. 測純函式與驗證邏輯

把驗證邏輯抽成純函式最好測。例如把第 8 章的表單驗證抽出來：

```js
// lib/validate.js
export function validateTitle(title) {
  const t = (title ?? "").trim();
  if (!t) return "標題不可為空";
  if (t.length > 50) return "標題不可超過 50 字";
  return null; // null = 通過
}
```

```js
// lib/validate.test.js
import { describe, it, expect } from "vitest";
import { validateTitle } from "./validate";

describe("validateTitle", () => {
  it("空字串要回錯誤", () => {
    expect(validateTitle("")).toBe("標題不可為空");
  });
  it("過長要回錯誤", () => {
    expect(validateTitle("a".repeat(51))).toBe("標題不可超過 50 字");
  });
  it("正常標題回 null", () => {
    expect(validateTitle("正常標題")).toBeNull();
  });
});
```

---

## 4. 測 Client 元件

```jsx
// components/Counter.js
"use client";
import { useState } from "react";
export default function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>點了 {n} 次</button>;
}
```

```jsx
// components/Counter.test.jsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import Counter from "./Counter";

describe("Counter", () => {
  it("點擊後數字增加", async () => {
    render(<Counter />);
    const btn = screen.getByRole("button");
    await userEvent.click(btn);
    expect(btn).toHaveTextContent("點了 1 次");
  });
});
```

---

## 5. 環境變數

Next.js 的環境變數規則：

- 放在 `.env`（或 `.env.local`）。
- **預設只在伺服器可用**（安全，密鑰不外洩）。
- 加 `NEXT_PUBLIC_` 前綴的變數才會打包進瀏覽器端。

```bash
# .env.local
DATABASE_URL="file:./dev.db"          # 只在伺服器（Prisma 用）
NEXT_PUBLIC_SITE_URL="http://localhost:3000"  # 前後端都可讀
```

```jsx
// 伺服器端（Server Component / Action）
const dbUrl = process.env.DATABASE_URL;         // ✅ 讀得到

// 客戶端（Client Component）
const site = process.env.NEXT_PUBLIC_SITE_URL;  // ✅ 讀得到
const secret = process.env.DATABASE_URL;        // ❌ 在 Client 是 undefined（正確：不外洩）
```

> 鐵則：**任何密鑰、DB 連線、API secret 都不要加 `NEXT_PUBLIC_`。** 只有真的要給瀏覽器用的公開值（站點網址、公開金鑰）才加前綴。

---

## 6. 打包：next build

```bash
npm run build   # 產生正式版
npm start       # 用正式版啟動（跑在 3000）
```

build 完的輸出會列出每條路由的類型，看懂這些符號：

```text
Route (app)                    Size
┌ ○ /                          ...   ○ 靜態（build 時產生）
├ ● /blog/[slug]               ...   ● SSG（generateStaticParams 預產）
├ ƒ /dashboard                 ...   ƒ 動態（每次請求渲染）
└ ○ /about                     ...
```

- `○` 靜態、`●` SSG、`ƒ` 動態。看到本該靜態的頁變 `ƒ`，回頭檢查是不是不小心用了 `cookies()` 或 `no-store`。

---

## 7. 部署到 Vercel

Vercel 是 Next.js 的原廠平台，部署最順：

1. 把專案推上 GitHub。
2. 到 vercel.com 用 GitHub 登入，Import 這個 repo。
3. 設定環境變數（`DATABASE_URL` 等），Deploy。
4. 每次 push 到 main 會自動部署；PR 會有預覽網址。

### 正式環境的資料庫

SQLite 檔案適合開發，但 Vercel 的 serverless 環境**檔案系統是唯讀且不持久**的，SQLite 無法直接上線。正式環境要換成雲端資料庫：

- 把 Prisma 的 `provider` 改成 `postgresql`。
- `DATABASE_URL` 指向雲端 Postgres（如 Vercel Postgres、Neon、Supabase）。
- 部署前跑 `npx prisma migrate deploy`（在 build 指令或 CI）。

程式碼幾乎不用改——這就是 Prisma 的好處：換資料庫只換連線設定。

### 部署前檢查清單

- [ ] `.env.local` 有沒有被 `.gitignore`（別把密鑰推上去）
- [ ] 密鑰都沒有 `NEXT_PUBLIC_` 前綴
- [ ] `npm run build` 本機能過
- [ ] 正式資料庫連線字串設好、migration 跑過
- [ ] `metadataBase` 換成正式網域

---

## 8. 本章小練習

1. 把一段驗證邏輯抽成純函式並寫 3 個測試。
2. 為一個 Client 計數器元件寫互動測試。
3. 設定 `.env.local`，分別放一個伺服器變數與一個 `NEXT_PUBLIC_` 變數，在頁面驗證可見性。
4. 跑 `npm run build`，看懂每條路由的 ○ / ● / ƒ 標記。
5. 把專案推上 GitHub 並部署到 Vercel。

---

## 最後範例：部署上線一條龍設定

> 一組讓專案可以順利 build 與部署的設定檔與測試。原樣加入你的專案即可。

### `.gitignore`（確認含這些）

```gitignore
# dependencies
/node_modules
# next
/.next
# env（重要：別把密鑰推上去）
.env
.env.local
# prisma 本地 db
/prisma/dev.db
```

### `.env.example`（放進 repo，讓別人知道要設哪些）

```bash
# 複製成 .env.local 後填入實際值
DATABASE_URL="file:./dev.db"
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
```

### `lib/validate.js` + `lib/validate.test.js`

```js
// lib/validate.js
export function validateTitle(title) {
  const t = (title ?? "").trim();
  if (!t) return "標題不可為空";
  if (t.length > 50) return "標題不可超過 50 字";
  return null;
}
```

```js
// lib/validate.test.js
import { describe, it, expect } from "vitest";
import { validateTitle } from "./validate";

describe("validateTitle", () => {
  it("空字串回錯誤", () => expect(validateTitle("")).toBe("標題不可為空"));
  it("過長回錯誤", () => expect(validateTitle("a".repeat(51))).toBe("標題不可超過 50 字"));
  it("正常回 null", () => expect(validateTitle("hi")).toBeNull());
});
```

### `package.json`（重點 scripts）

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "prisma generate && next build",
    "start": "next start",
    "test": "vitest",
    "postinstall": "prisma generate"
  }
}
```

> `build` 前先 `prisma generate`（確保 Client 產生）、`postinstall` 讓 Vercel 安裝時就產生 Prisma Client——這兩步能避免最常見的部署失敗。

---

## 本章結語

到這裡，你已經走完 Next.js 的完整開發流程：從路由、資料、認證、樣式、SEO，到測試與部署。  
最後一章，把這一切整合成一個真正可上線的作品——**全端部落格期末專題**。
