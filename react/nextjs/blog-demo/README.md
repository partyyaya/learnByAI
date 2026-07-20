# blog-demo — Next.js 全端部落格（期末專題）

Next.js 課程（[../](../)）第 15 章的整合成品：用 **App Router + Server Components + Server Actions + Prisma(SQLite) + Cookie 認證** 打造的全端部落格。

## 功能

- 首頁文章列表（只顯示已發佈，ISR 快取）— 對應第 2、5、12 章
- 文章詳情動態頁 + 依文章產生 metadata — 第 6、13 章
- 後台登入 + `middleware.js` 路由守衛 + cookie 認證 — 第 10 章
- 後台文章 CRUD（新增／刪除／切換發佈），全走 Server Actions — 第 8 章
- Prisma + SQLite 資料落地 — 第 9 章
- 亮／暗主題切換 — 第 3、11 章

## 需求

- Node.js **18.18+ 或 20+**（本機若預設太舊：`nvm use 20`）

## 快速開始

```bash
# 1) 安裝依賴（postinstall 會自動 prisma generate）
npm install

# 2) 建立資料庫 + 塞入初始文章（一鍵）
npm run setup
#   等同：prisma generate → prisma migrate deploy → prisma db seed
#   （migrate deploy 會套用已隨專案提交的 migration，非互動、不會重複 seed）

# 3) 啟動開發伺服器
npm run dev
```

打開 <http://localhost:3000>。

> 想改用課程第 9 章教的開發流程（自己產生 migration）也可以：
> ```bash
> npx prisma migrate dev --name init   # 注意：這會「自動」跑一次 seed
> ```
> 用 `migrate dev` 後不必再手動 `db seed`，否則會重複塞資料（id 會往後跳）。

## 登入

後台 `/admin` 受保護，需登入：

- 帳號：`admin`
- 密碼：`admin123`

未登入直接開 `/admin` 會被 `middleware.js` 轉回 `/login`。

## 專案結構

```text
blog-demo/
├─ prisma/
│  ├─ schema.prisma      # Post 資料模型
│  └─ seed.js            # 初始文章
├─ lib/
│  ├─ prisma.js          # 共用 Prisma Client（第 9 章）
│  └─ auth.js            # cookie 登入輔助（第 10 章）
├─ app/
│  ├─ layout.js          # 根版面 + metadata + 主題腳本
│  ├─ globals.css        # 全域樣式（含亮/暗主題變數）
│  ├─ ThemeToggle.js     # 主題切換（Client）
│  ├─ page.js            # 首頁：已發佈文章列表
│  ├─ posts/[id]/
│  │  ├─ page.js         # 文章詳情 + generateMetadata
│  │  └─ not-found.js    # 找不到文章
│  ├─ login/
│  │  ├─ page.js         # 登入表單（Client）
│  │  └─ actions.js      # 登入/登出 Server Actions
│  └─ admin/
│     ├─ layout.js       # 後台版面（雙層登入防護 + 登出）
│     ├─ page.js         # 文章管理列表
│     ├─ actions.js      # 建立/刪除/切換發佈 Server Actions
│     ├─ PostForm.js     # 新增表單（Client）
│     └─ SubmitButton.js # 送出中狀態按鈕（Client）
└─ middleware.js         # 保護 /admin 的第一道防護
```

## 操作導覽

1. **首頁** `/`：看已發佈文章，點標題進詳情。
2. **登入** `/login`：用 `admin` / `admin123` 登入。
3. **後台** `/admin`：發表新文章、切換發佈/草稿、刪除；「已發佈」的可點「檢視」到前台頁。
4. 把某篇「轉為草稿」，回首頁確認它從列表消失（`revalidatePath` 生效）。

## 常用指令

```bash
npm run dev        # 開發模式
npm run build      # 打包（含 prisma generate）
npm start          # 正式模式啟動
npm run db:studio  # 開 Prisma Studio 視覺化看資料
npm run db:seed    # 重新塞初始資料（會先清空）
```

## 部署到 Vercel（重點）

SQLite 檔案無法在 Vercel serverless 持久化，正式環境要換雲端資料庫：

1. `prisma/schema.prisma` 的 `provider` 改成 `postgresql`。
2. 環境變數 `DATABASE_URL` 指向雲端 Postgres（Vercel Postgres / Neon / Supabase）。
3. build 指令已含 `prisma generate`；另在部署流程跑 `npx prisma migrate deploy`。
4. `app/layout.js` 的 `metadataBase` 換成正式網域。

詳見課程第 14 章。

## 延伸挑戰

見課程 [第 15 章](../15-capstone-fullstack-blog.md) 的「延伸挑戰」：編輯文章、分類/標籤、留言、分頁、動態 OG image。
