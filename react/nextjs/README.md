# Next.js 完整課程（App Router，Next.js 15）

> 這是 React 課程的延伸。學完 [../](../)（React 基礎 + TanStack Query + Zustand）後，這套課帶你進到 **Next.js 15 App Router**：Server Components、Server Actions、資料庫、認證、渲染策略、SEO 與部署，最後做出一個可上線的全端部落格。

---

## 課程目錄

| 章節 | 檔案 | 主題 | 狀態 |
|------|------|------|------|
| 01 | [01-nextjs-intro-and-setup.md](./01-nextjs-intro-and-setup.md) | Next.js 是什麼與環境建立 | 已完成 |
| 02 | [02-app-router-and-routing.md](./02-app-router-and-routing.md) | App Router 檔案系統路由 | 已完成 |
| 03 | [03-server-and-client-components.md](./03-server-and-client-components.md) | Server Components 與 Client Components | 已完成 |
| 04 | [04-layouts-loading-error.md](./04-layouts-loading-error.md) | 版面、載入與錯誤處理 | 已完成 |
| 05 | [05-data-fetching-and-caching.md](./05-data-fetching-and-caching.md) | 資料抓取與快取基礎 | 已完成 |
| 06 | [06-dynamic-routes-and-params.md](./06-dynamic-routes-and-params.md) | 動態路由與參數 | 已完成 |
| 07 | [07-route-handlers-api.md](./07-route-handlers-api.md) | Route Handlers（API 路由） | 已完成 |
| 08 | [08-server-actions-and-forms.md](./08-server-actions-and-forms.md) | Server Actions 與表單 | 已完成 |
| 09 | [09-database-with-prisma.md](./09-database-with-prisma.md) | 資料庫整合（Prisma + SQLite） | 已完成 |
| 10 | [10-auth-and-middleware.md](./10-auth-and-middleware.md) | 認證與 Middleware | 已完成 |
| 11 | [11-styling-fonts-images.md](./11-styling-fonts-images.md) | 樣式、字型與圖片優化 | 已完成 |
| 12 | [12-rendering-and-caching-advanced.md](./12-rendering-and-caching-advanced.md) | 渲染策略與快取進階 | 已完成 |
| 13 | [13-seo-and-metadata.md](./13-seo-and-metadata.md) | SEO 與 Metadata | 已完成 |
| 14 | [14-testing-and-deployment.md](./14-testing-and-deployment.md) | 測試與部署 | 已完成 |
| 15 | [15-capstone-fullstack-blog.md](./15-capstone-fullstack-blog.md) | 期末專題：全端部落格 | 已完成 |

---

## 🚀 整合實戰範例：全端部落格

課程 06～15 章的重點，已整合成一個可實際操作的專案：

> **[blog-demo/](./blog-demo/)** — Next.js 15 App Router + Server Actions + Prisma(SQLite) + Cookie 認證打造的全端部落格。

- 文章列表／詳情（動態路由）、Server Actions 做 CRUD、登入 / 路由守衛、`next/image`、SEO metadata、亮/暗主題。
- 用 SQLite + Prisma，`npm install && npm run dev` 即可跑起，不需額外資料庫伺服器。
- 每個頁面都標註對應章節，邊操作邊對照學習。詳見 [blog-demo/README.md](./blog-demo/README.md)。

```bash
cd blog-demo
npm install
npm run dev
```

登入帳號：`admin` / `admin123`

---

## 你會學到什麼

- 用 App Router 的檔案系統路由設計多頁面站台
- 分清 Server Component 與 Client Component 的邊界與時機
- 在 Server Component 內直接抓資料，並用 `Suspense` 做串流
- 用 Server Actions 處理表單與資料異動，不必手寫 API + fetch
- 用 Route Handlers 建立 REST API
- 整合 Prisma + SQLite 落地真實資料庫 CRUD
- 用 `middleware.js` + cookie 做登入與路由守衛
- 用 `next/image`、`next/font` 與 metadata 顧好效能與 SEO
- 掌握 Static / Dynamic / ISR 渲染策略與快取控制
- 打包並部署 Next.js 應用到 Vercel

## 適合對象

- 已學完本 repo 的 React 課程（或已有等量 React 基礎）的開發者
- 想從 SPA 進到「全端 React 框架」的工程師
- 需要 SEO、伺服器渲染、或後端整合的專案負責人

## 學習建議

1. 先學完 [React 課程](../)，至少要熟元件、hooks、資料抓取。
2. 照章節順序學，01～05 是 App Router 心智模型，最重要。
3. 每章先看完觀念，再手打一次最後範例。
4. 08～10 章開始碰 Server Actions、資料庫與認證，務必實際跑起來。
5. 學完第 15 章後，獨立擴充 [blog-demo/](./blog-demo/)（加留言、分類、標籤），再部署上線。

## 開發環境

- Node.js: **18.18+ 或 20+**（Next.js 15 需求；本機用 `nvm use 20`）
- 套件管理: `npm` / `pnpm` / `yarn` 擇一
- 編輯器: Cursor / VS Code
- 瀏覽器: Chrome / Edge

> 註：若你機器預設 Node 太舊（如 v12），先 `nvm install 20 && nvm use 20` 再操作。

## 快速開始

```bash
# 1) 建立 Next.js 專案（選 App Router、TypeScript 可依喜好）
npx create-next-app@latest my-next-course

# 2) 進入專案
cd my-next-course

# 3) 啟動開發伺服器
npm run dev
```

打開 `http://localhost:3000` 就會看到首頁。

---

> 從 [第 1 章：Next.js 是什麼與環境建立](./01-nextjs-intro-and-setup.md) 開始。
