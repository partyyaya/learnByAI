# Nuxt 4 完整課程（全端 Vue 框架）

> 這是一套以「實作優先」設計的 Nuxt 課程。你會從「Nuxt 補了純 Vue 缺的哪一塊」開始，一路做到路由、SSR、資料抓取、自架 API、資料庫、認證、SEO、效能與測試，最後把一個**可上線的全端部落格**部署出去。
>
> 定位上，Nuxt 之於 Vue，就像 Next.js 之於 React。若你學過本 repo 的 [React/Next.js 課](../../react/nextjs/README.md)，可以邊學邊對照。

---

## 課程目錄

| 章節 | 檔案 | 主題 | 狀態 |
|------|------|------|------|
| 01 | [01-nuxt-intro-and-setup.md](./01-nuxt-intro-and-setup.md) | Nuxt 是什麼與環境建立 | 已完成 |
| 02 | [02-file-based-routing.md](./02-file-based-routing.md) | 檔案式路由與頁面 | 已完成 |
| 03 | [03-app-layouts-structure.md](./03-app-layouts-structure.md) | app.vue、Layouts 與版面結構 | 已完成 |
| 04 | [04-auto-imports-and-composables.md](./04-auto-imports-and-composables.md) | 自動匯入、Composables 與 ClientOnly | 已完成 |
| 05 | [05-rendering-modes-and-route-rules.md](./05-rendering-modes-and-route-rules.md) | 渲染模式與 Route Rules | 已完成 |
| 06 | [06-data-fetching.md](./06-data-fetching.md) | 資料抓取（useFetch / useAsyncData / $fetch） | 已完成 |
| 07 | [07-state-usestate-and-pinia.md](./07-state-usestate-and-pinia.md) | 共享狀態（useState 與 Pinia） | 已完成 |
| 08 | [08-nitro-server-api-and-runtime-config.md](./08-nitro-server-api-and-runtime-config.md) | Nitro 伺服器 API 與 Runtime Config | 已完成 |
| 09 | [09-route-middleware-and-guards.md](./09-route-middleware-and-guards.md) | 路由中介層與導航守衛 | 已完成 |
| 10 | [10-database-fullstack-crud.md](./10-database-fullstack-crud.md) | 串接資料庫做全端 CRUD（Prisma） | 已完成 |
| 11 | [11-auth-cookie-session.md](./11-auth-cookie-session.md) | 認證與授權（Cookie / Session） | 已完成 |
| 12 | [12-seo-and-meta.md](./12-seo-and-meta.md) | SEO、Meta 與社群分享 | 已完成 |
| 13 | [13-error-plugins-modules.md](./13-error-plugins-modules.md) | 錯誤處理、Plugins 與 Nuxt 模組 | 已完成 |
| 14 | [14-styling-and-ui.md](./14-styling-and-ui.md) | 樣式與 UI（Tailwind、@nuxt/image、字型） | 已完成 |
| 15 | [15-performance-caching-testing.md](./15-performance-caching-testing.md) | 效能優化、快取與測試 | 已完成 |
| 16 | [16-deploy-and-capstone.md](./16-deploy-and-capstone.md) | 部署與期末專題：全端部落格 | 已完成 |

---

## 🚀 期末專題：全端部落格

整合課程核心的全端能力——**檔案式路由、SSR 資料抓取、Nitro API、Prisma CRUD、Cookie 認證、動態 SEO**——成一個可實際操作的專案：

> **[blog-demo/](./blog-demo/)** — Nuxt 4 + Nitro API + Prisma/SQLite + Cookie 認證打造的全端部落格。

- 檔案式路由、SSR 資料抓取、動態 SEO、`httpOnly` session 登入、後台發文（只能刪自己的）、Nitro `server/api` + Prisma CRUD。
- `npm install && npx prisma migrate dev && npm run dev` 即可跑起，不需另外的後端。
- 附一組可直接跑的測試（第 15 章）：`npm run test` 跑單元測試、`npm run test:e2e` 真的起一個 Nuxt 測 SSR 與 API 權限。
- 每個功能都標註對應章節，邊操作邊對照學習。詳見 [blog-demo/README.md](./blog-demo/README.md)。

```bash
cd blog-demo
npm install
npx prisma migrate dev --name init
npm run dev
```

---

## 你會學到什麼

- 用 `app/pages/` 檔案式路由、`layouts/`、`error.vue` 搭出站台結構
- 分清並運用 SSR / SPA / SSG / Hybrid，四種渲染模式用 `routeRules` 逐路由設定
- 用 `useFetch` / `useAsyncData` 在伺服器就抓好資料，避免瀏覽器重抓
- 分清「伺服器狀態（useFetch）」與「客戶端狀態（useState / Pinia）」
- 用 Nitro 在 `server/api/` 寫自家 API、用 `runtimeConfig` 安全管金鑰
- 用路由中介層守衛頁面、用 `requireUserSession` 在伺服器端守衛 API
- 用 Prisma + SQLite 做可持久化的全端 CRUD
- 用 `nuxt-auth-utils` 做以加密 cookie 為基礎的認證與授權
- 用 `useSeoMeta` / `useHead` 做動態 SEO 與社群分享卡片
- 用延遲水合、Nitro 快取、`@nuxt/image` 顧好效能
- 用 `@nuxt/test-utils` + Vitest 寫測試，並選對 Nitro preset 部署上線

## 適合對象

- 已有 Vue 3（`<script setup>`、`ref`/`computed`）基礎，想學全端 Nuxt 的開發者
- 用純 Vue + Vite 做過 SPA，想補上 SSR、SEO、後端能力的人
- 想從「會寫前端畫面」進階到「能獨立交付可上線全端產品」的工程師

## 學習建議

1. 照章節順序學，不要跳章——每章的最後範例都接續前一章。
2. 每章先看完觀念，再手打一次最後範例，跑起來看效果。
3. 範例打完後，先自己改 1～2 個需求再進下一章。
4. 到第 8～11 章時，務必實際把 API、資料庫、登入都跑通（這是全端的核心）。
5. 學完第 16 章後，獨立完成期末專題並嘗試部署，再與 [blog-demo/](./blog-demo/) 對照架構。

## 開發環境

- Node.js: 20 LTS 以上（本機若是舊版，用 `nvm use 20`）
- 套件管理: `npm` / `pnpm` / `yarn` 擇一
- 編輯器: Cursor / VS Code（裝 **Vue - Official** 外掛）
- 瀏覽器: Chrome / Edge（善用 Nuxt DevTools）

## 快速開始

```bash
# 1) 建立 Nuxt 4 專案
npm create nuxt@latest my-nuxt-course

# 2) 安裝依賴並啟動
cd my-nuxt-course
npm run dev
```

打開 `http://localhost:3000` 看到歡迎頁即代表環境正確。

---

> 從 [第 1 章：Nuxt 是什麼與環境建立](./01-nuxt-intro-and-setup.md) 開始。
