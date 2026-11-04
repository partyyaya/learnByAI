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

Next.js 特有的注意點：Vitest 目前不支援 render async Server Component（會在伺服器 `await` 資料的那種元件），這類頁面用 **E2E 測試**（Playwright）更合適。單元測試主要針對：**純函式、驗證邏輯、Client 元件**。

> 要測 async 頁面時，可以用 `npm init playwright@latest` 建立 Playwright。它會開真的瀏覽器，去操作你跑起來的網站。它的測試檔慣例命名為 `*.spec.js`；下面的 Vitest 設定只收 `*.test.js(x)`，兩者不會互相干擾。

---

## 2. 安裝 Vitest + Testing Library

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/dom @testing-library/jest-dom @testing-library/user-event @vitejs/plugin-react
```

`vitest.config.mjs`（用 `.mjs` 和 `next.config.mjs` 同理：檔案裡用的是 `import`／`export`）：

```js
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 讓測試也看得懂 @/ 別名（對應 jsconfig.json 的 "@/*"）
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./vitest.setup.js",
    include: ["**/*.test.{js,jsx}"], // 只收 .test 檔，不收 Playwright 的 .spec 檔
  },
});
```

> Vitest 不會讀 Next.js 的 `jsconfig.json`，沒有 `resolve.alias` 這段的話，被測檔裡的 `import … from "@/lib/…"` 會報 `Failed to resolve import`。

`vitest.setup.js`：

```js
import "@testing-library/jest-dom";
```

`package.json` 加：

```json
{ "scripts": { "test": "vitest" } }
```

`npm test` 會進入監看模式：改檔就自動重跑，按 `q` 離開。在 CI 裡要跑一次就結束，用 `npx vitest run`。

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
// components/Counter.jsx
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

> **為什麼元件檔用 `.jsx`？** Next.js 允許在 `.js` 檔裡寫 JSX，但 Vitest 底層的 Vite 只會解析 `.jsx` 檔裡的 JSX。被測的元件若是 `.js`，會報 JSX 語法錯誤（`Unexpected JSX expression`）。要測的元件檔請改成 `.jsx`，Next.js 兩種副檔名都能用，import 路徑不用寫副檔名，也不必改。

---

## 5. 環境變數

Next.js 的環境變數規則：

- 放在 `.env`（或 `.env.local`）。
- **預設只在伺服器可用**（安全，密鑰不外洩）。
- 加 `NEXT_PUBLIC_` 前綴的變數才會打包進瀏覽器端。

```bash
# .env
DATABASE_URL="file:./dev.db"          # 只在伺服器（Prisma 用）
NEXT_PUBLIC_SITE_URL="http://localhost:3000"  # 前後端都可讀
```

> **`DATABASE_URL` 放 `.env`，不要只放 `.env.local`**：Next.js 兩個檔都會讀，但 Prisma CLI（`prisma migrate`、`prisma db seed`）只讀 `.env`。只放 `.env.local` 的話，網站能跑，跑 migration 時卻會報 `Environment variable not found: DATABASE_URL`。第 9 章和 blog-demo 都是放 `.env`。

```jsx
// 伺服器端（Server Component / Action）
const dbUrl = process.env.DATABASE_URL;         // ✅ 讀得到

// 客戶端（Client Component）
const site = process.env.NEXT_PUBLIC_SITE_URL;  // ✅ 讀得到
const secret = process.env.DATABASE_URL;        // ❌ 在 Client 是 undefined（正確：不外洩）
```

> 鐵則：**任何密鑰、DB 連線、API secret 都不要加 `NEXT_PUBLIC_`。** 只有真的要給瀏覽器用的公開值（站點網址、公開金鑰）才加前綴。

`NEXT_PUBLIC_` 變數是在 **build 時直接把值寫進前端程式碼**，所以要注意兩件事：

- 改了值要重新 build。在 Vercel 上改了環境變數，要重新部署才會生效。
- 要寫成完整的 `process.env.NEXT_PUBLIC_SITE_URL`。像 `process.env[name]` 這種動態取值，Next.js 認不出來，不會替換，在 Client 會變成 `undefined`。

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
- 設了 `revalidate` 的 ISR 頁一樣標 `○`，旁邊的 Revalidate 欄會寫出間隔（例如 `1m`）。

> `next build` 在 Next.js 15 會順便跑 ESLint 和型別檢查（輸出裡的 `Linting and checking validity of types`），lint 的 error 會讓 build 失敗，所以本機先 build 過一次再部署。`next lint` 指令在 15.5 已標示棄用；到了 Next.js 16，`next lint` 被移除，`next build` 也不再跑 lint，要自己用 `npx eslint .` 檢查。

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
- 用 SQLite 時產生的 `prisma/migrations` 是 SQLite 語法，不能拿去套用 Postgres（Prisma 會報 provider 和 `migration_lock.toml` 不符）。把舊的 `prisma/migrations` 資料夾刪掉，讓 `DATABASE_URL` 指向一個 Postgres（可以先用雲端的開發用資料庫），再跑一次 `npx prisma migrate dev --name init`，產生新的 migration 並提交。
- 部署前跑 `npx prisma migrate deploy`（在 build 指令或 CI）。它要排在 `next build` 之前：沒用動態 API 的頁面會在 build 時就查一次資料庫，表還沒建好的話 build 會失敗。

程式碼幾乎不用改——這就是 Prisma 的好處：換資料庫只換連線設定。

> 不用 Vercel、要自己架（VM、Docker）也可以：在伺服器上 `npm run build && npm start` 就能跑。要做成 Docker 映像時，可以在 `next.config.mjs` 設 `output: "standalone"`，build 會在 `.next/standalone` 產生一份只含執行所需檔案的精簡版本。

### 部署前檢查清單

- [ ] `.env`、`.env.local` 有沒有被 `.gitignore`（別把密鑰推上去）
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

> `create-next-app@15` 產生的 `.gitignore` 是用一行 `.env*` 忽略所有 env 檔，這樣也會連下面的 `.env.example` 一起忽略。要提交範例檔，在 `.env*` 下面加一行 `!.env.example`。

> blog-demo 反而把 `.env` 提交了：它的 `.env` 只有 SQLite 檔案路徑、沒有任何密鑰，提交是為了讓人 clone 下來就能直接跑。你的專案一旦在 `.env` 放了雲端資料庫的連線字串（含帳號密碼），就要照上面把它忽略。

### `.env.example`（放進 repo，讓別人知道要設哪些）

```bash
# 複製成 .env 後填入實際值（Prisma CLI 只讀 .env）
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

> `build` 前先 `prisma generate`（確保 Client 產生）、`postinstall` 讓 Vercel 安裝時就產生 Prisma Client——這兩步能避免最常見的部署失敗。Vercel 會快取 `node_modules`，沒有這兩步的話，可能沿用和目前 schema 對不上的舊 Prisma Client，執行時就會出錯。

> 這組設定沒有把 `prisma migrate deploy` 放進 `build`，所以部署前要在 CI 或本機對正式資料庫跑一次。想讓每次部署自動套用，可以把 `build` 改成 `prisma generate && prisma migrate deploy && next build`。

---

## 本章結語

到這裡，你已經走完 Next.js 的完整開發流程：從路由、資料、認證、樣式、SEO，到測試與部署。  
最後一章，把這一切整合成一個真正可上線的作品——**全端部落格期末專題**。
