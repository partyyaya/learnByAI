# blog-demo — Nuxt 4 全端部落格（期末專題）

課程第 16 章的期末專題，把 2～15 章的能力整合成一個可實跑的全端部落格：
**檔案式路由 + SSR 資料抓取 + Nitro API + Prisma/SQLite + Cookie 認證 + 動態 SEO**。

> 這是 [Nuxt 課程](../README.md) 的整合範例，可與 [React/Next.js 的 blog-demo](../../../react/nextjs/blog-demo/) 對照，體會 Next 與 Nuxt 的全端思路差異。

---

## 快速開始

```bash
cd blog-demo

# 1) 安裝依賴
npm install

# 2) 建立 SQLite 資料表 + 產生 Prisma client
npx prisma migrate dev --name init

# 3) （選用）塞入幾篇示範文章
npm run db:seed

# 4) 啟動
npm run dev
```

打開 `http://localhost:3000`：

1. 先到 **`/login`** 點「還沒有帳號？點此註冊」建立一個帳號（會直接登入）。
2. 登入後自動進 **`/admin`**，發表一篇文章（可選「立即發佈」或存草稿）。
3. 回 **首頁 `/`** 看已發佈文章列表，點標題進 **`/posts/[id]`** 看詳情。
4. 回後台，你發表的文章會有「刪除」鈕；示範文章（站長發佈）沒有——因為**只能刪自己的**。

> Node 版本需 20 以上。若本機是舊版：`nvm use 20`。

---

## 功能 × 章節對照

| 功能 | 檔案 | 對應章節 |
|---|---|---|
| App 根 + 全站標題模板 | [app/app.vue](./app/app.vue) | 1、3、12 |
| 前台 / 後台兩種版面 | [app/layouts/](./app/layouts/) | 3 |
| 全站錯誤頁 | [app/error.vue](./app/error.vue) | 3、13 |
| 首頁列表（SSR 抓取） | [app/pages/index.vue](./app/pages/index.vue) | 6 |
| 文章詳情（動態路由 + 動態 SEO + 404） | [app/pages/posts/[id].vue](./app/pages/posts/[id].vue) | 2、3、12 |
| 自動匯入元件 | [app/components/PostCard.vue](./app/components/PostCard.vue) | 4 |
| 自動匯入工具函式（純函式，好測） | [app/utils/format.js](./app/utils/format.js) | 4、15 |
| 登入 / 註冊 | [app/pages/login.vue](./app/pages/login.vue) | 11 |
| 後台發文 / 刪除（樂觀更新） | [app/pages/admin/index.vue](./app/pages/admin/index.vue) | 9、10、11 |
| 路由守衛 | [app/middleware/auth.js](./app/middleware/auth.js) | 9 |
| Nitro 文章 CRUD API | [server/api/posts.*](./server/api/) | 8、10 |
| 認證 API（含伺服器端守衛） | [server/api/auth/](./server/api/auth/) | 11 |
| Prisma 單例 | [server/utils/prisma.js](./server/utils/prisma.js) | 10 |
| 資料模型 | [prisma/schema.prisma](./prisma/schema.prisma) | 10、11 |
| 單元測試（純函式 + 元件） | [tests/unit/](./tests/unit/) | 15 |
| E2E 測試（真的跑 SSR 與 API） | [tests/e2e/blog.spec.js](./tests/e2e/blog.spec.js) | 15 |

---

## 專案結構

```text
blog-demo/
├─ nuxt.config.ts          # 模組（nuxt-auth-utils）、CSS、head
├─ vitest.config.ts        # 測試設定（environment: 'nuxt'）
├─ .env                    # DATABASE_URL、NUXT_SESSION_PASSWORD
├─ tests/
│  ├─ unit/                # 純函式與元件測試（跑得快，天天跑）
│  │  ├─ format.spec.js
│  │  └─ PostCard.spec.js
│  └─ e2e/blog.spec.js     # 真的啟動 Nuxt，測 SSR 與 API
├─ prisma/
│  ├─ schema.prisma        # User / Post 模型
│  └─ seed.js              # 示範文章
├─ server/                 # Nitro（只在伺服器執行）
│  ├─ utils/prisma.js      # PrismaClient 單例
│  └─ api/
│     ├─ posts.get.js      # GET  /api/posts（?all=true 需登入）
│     ├─ posts.post.js     # POST /api/posts（需登入）
│     ├─ posts/[id].get.js # GET  /api/posts/:id
│     ├─ posts/[id].delete.js # DELETE（需登入 + 只能刪自己的）
│     └─ auth/             # register / login / logout
└─ app/                    # 前端（Nuxt 4 srcDir）
   ├─ app.vue
   ├─ error.vue
   ├─ assets/css/main.css
   ├─ layouts/             # default / admin
   ├─ middleware/auth.js
   ├─ components/PostCard.vue
   ├─ utils/format.js      # excerpt / formatDate / authorName（自動匯入）
   └─ pages/               # index / login / posts/[id] / admin/index
```

---

## 安全重點

- 登入狀態存在 **`httpOnly` 加密 cookie**（`nuxt-auth-utils`），JS 讀不到、SSR 也拿得到。
- 密碼用 `hashPassword`（scrypt）雜湊後才進資料庫，**不存明文**。
- 每支會改資料的 API 都用 `requireUserSession` 在**伺服器端**再驗一次；前端 `middleware/auth.js` 只負責體驗（導向登入頁）。
- 刪除文章會檢查 `authorId === user.id`，**只能刪自己的**。

> 試試看：登入後打開 DevTools，在 Console 直接 `await $fetch('/api/posts/1', { method: 'DELETE' })` 刪一篇不是你的文章——伺服器會回 **403**。這證明安全不是只靠前端藏按鈕。

---

## 測試（第 15 章）

```bash
npm run test        # 單元測試：純函式 + 元件（約 1 秒）
npm run test:watch  # 單元測試 watch 模式（開發時開著）
npm run test:e2e    # E2E：真的啟動 Nuxt，測 SSR 與 API
```

分兩層，對應兩種問題：

| 測試 | 檔案 | 測什麼 | 需要什麼 |
|---|---|---|---|
| 單元 | [tests/unit/format.spec.js](./tests/unit/format.spec.js) | `excerpt` / `formatDate` / `authorName` 三個純函式的正常值、邊界、空值 | 無 |
| 單元 | [tests/unit/PostCard.spec.js](./tests/unit/PostCard.spec.js) | 用 `mountSuspended` 掛元件：標題、摘要截斷、草稿標籤、連結、無作者時掛站長 | 無 |
| E2E | [tests/e2e/blog.spec.js](./tests/e2e/blog.spec.js) | 首頁 SSR 出得來、`/api/posts` 只回已發佈、未登入拿全部／發文會被擋、不存在的文章回 404 | 先 `npx prisma migrate dev --name init` 建好資料表 |

幾個實作重點：

- [vitest.config.ts](./vitest.config.ts) 用 `defineVitestConfig({ test: { environment: 'nuxt' } })`，測試裡才有自動匯入與 `~` 別名。
- E2E 那支檔案開頭有 `// @vitest-environment node`——它要跑真的伺服器，不能用模擬的 Nuxt 瀏覽器環境。
- E2E 用 `setup({ dev: true })` 起 dev 伺服器：啟動快，而且會自動讀 `.env`。
- E2E 執行時終端機可能出現 `vite:define` 或 `WebSocket port 24678` 的警告，那是 Nuxt dev server 的雜訊，不影響測試結果。
- 那三個「未登入會被擋」的 E2E 測試，測的正是下面〈安全重點〉講的事——**伺服器端真的擋得住**，不是只有前端藏按鈕。

---

## 常用指令

```bash
npm run dev         # 開發
npm run build       # 打包（prisma generate + nuxt build）
npm run preview     # 本機預覽 build 結果
npm run test        # 單元測試
npm run test:e2e    # E2E 測試
npm run db:seed     # 重新塞示範文章
npm run db:studio   # 用 GUI 看資料庫
```

## 部署提醒（第 16 章）

- 有 SSR 與 API，走 `npm run build` + Node 伺服器（或 Vercel/Netlify/Cloudflare，Nitro 自動偵測 preset）。
- 正式環境務必設強隨機的 `NUXT_SESSION_PASSWORD`，並把 SQLite 換成託管資料庫（PostgreSQL 等），部署時跑 `npx prisma migrate deploy`。
