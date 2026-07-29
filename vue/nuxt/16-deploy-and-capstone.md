# 第 16 章：部署與期末專題：全端部落格

## 本章目標

完成這一章後，你應該可以：

1. 分清 `nuxt build`（Node 伺服器）與 `nuxt generate`（純靜態）兩種產出。
2. 說出 Nitro preset 的概念，並知道怎麼部署到 Node、Vercel、Netlify、Cloudflare。
3. 正確設定正式環境的環境變數與資料庫（含 Prisma migration）。
4. 用 `nuxi preview` 在本機驗證 build 結果。
5. 獨立完成期末專題：一個整合全課能力、可實跑的全端部落格。

---

## 1. 兩種產出，先選對

| 指令 | 產出 | 需要 Node 伺服器？ | 用在 |
|---|---|---|---|
| `npm run build` | `.output/`（含 server） | ✅ 要 | 有 SSR/API/`swr` 的站（本課的部落格） |
| `npm run generate` | `.output/public/`（純靜態） | ❌ 不用 | 全站可預渲染（純內容站） |

判斷：**只要有任何一條路由需要 SSR、有 `server/api`、有登入** → 用 `build`。我們的部落格有 API 與認證，所以走 `build`。

啟動 build 後的 Node 伺服器：

```bash
npm run build
node .output/server/index.mjs   # 預設監聽 3000
```

或用 Nuxt 內建預覽：

```bash
npm run preview                  # 等同跑起 .output 來看
```

---

## 2. Nitro Preset：一份程式，多平台部署

Nitro 最強的地方是**同一份程式可以打包成不同平台的格式**，這叫 **preset**。你通常不用手動設定——部署到 Vercel/Netlify/Cloudflare 時會**自動偵測**並套用對應 preset。

| 平台 | 怎麼部署 | preset |
|---|---|---|
| 自己的 Node 伺服器 / Docker | `npm run build` → 跑 `.output/server/index.mjs` | `node-server`（預設） |
| **Vercel** | 連 Git repo，push 自動部署 | 自動 |
| **Netlify** | 連 Git repo，push 自動部署 | 自動 |
| **Cloudflare Pages/Workers** | 連 Git 或 `wrangler` | `cloudflare-pages`（建議部落格用）/ `cloudflare-module` |
| 靜態主機（GitHub Pages…） | `npm run generate` 丟 `.output/public/` | 靜態 |

需要手動指定時：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  nitro: { preset: 'node-server' }, // 或 'vercel'、'cloudflare-pages'…（注意是連字號，不是底線）
})
```

或用環境變數 `NITRO_PRESET=node-server npm run build`。

> 心法：**先把 `npm run build` + `npm run preview` 在本機跑通**，再交給平台。平台端多半只要「連 Git、設環境變數、按部署」。

---

## 3. 正式環境的環境變數

第 8 章學過 `runtimeConfig` 用 `NUXT_` 前綴的環境變數覆蓋。正式環境**不要**用 `.env` 檔，而是在平台的「Environment Variables」設定：

```bash
NUXT_SESSION_PASSWORD=<32 字元以上的隨機字串>   # 第 11 章認證
DATABASE_URL=<正式資料庫連線字串>               # Prisma
NUXT_PUBLIC_SITE_URL=https://your-domain.com    # 公開設定
```

重點：

- `NUXT_SESSION_PASSWORD` 正式環境**務必**換成強隨機值。
- 私密值（DB 密碼、金鑰）只放在平台環境變數，**永遠不進版控**。
- `runtimeConfig.public.*` 會進前端，別放機密。

---

## 4. 資料庫上線注意

本課開發用 SQLite（單檔），方便學習。但**多數 Serverless/邊緣平台的檔案系統是唯讀或不持久**的，SQLite 檔會遺失。正式環境建議：

- 換成**託管資料庫**：PostgreSQL（Supabase、Neon）、MySQL（PlanetScale）等。只要改 `schema.prisma` 的 `provider` 與 `DATABASE_URL`，程式碼幾乎不動。
- 部署流程要跑 **migration**（把資料表建到正式 DB）：

```bash
npx prisma migrate deploy   # 正式環境用 deploy（不是 dev）
npx prisma generate         # 產生 client（通常 build 前跑）
```

- 常見做法：在 `package.json` 的 `build` 前掛 `prisma generate`，或在平台的 build command 串起來。

> 如果就是想用 SQLite 上線，選「有持久磁碟」的部署方式（傳統 Node 伺服器 / VPS / 有 volume 的容器），別放到無持久檔案系統的 Serverless。

---

## 5. 上線前檢查清單

- [ ] `npm run build` 沒有錯誤，`npm run preview` 功能正常。
- [ ] 正式環境變數都設好（`NUXT_SESSION_PASSWORD`、`DATABASE_URL`…）。
- [ ] 資料庫已 `migrate deploy`。
- [ ] SEO：`site.url` 指向正式網域，`/sitemap.xml`、`/robots.txt` 正常（第 12 章）。
- [ ] 受保護 API 都有 `requireUserSession`（第 11 章），別只靠前端守衛。
- [ ] 錯誤頁 `error.vue` 正常（第 3、13 章）。
- [ ] 圖片與字型最佳化生效（第 14 章）。

---

## 6. 期末專題：全端部落格 `blog-demo/`

把 1～15 章整合成一個能實跑的作品。課程附了完整範例在 **[`blog-demo/`](./blog-demo/)**，你可以先自己做，再和它對照。

### 專題需求

一個部落格，具備：

1. **首頁**：文章列表（SSR，第 6 章），SEO meta（第 12 章）。
2. **文章詳情** `/posts/[id]`：動態路由（第 2 章）、動態 SEO（第 12 章）、查無走 404（第 3 章）。
3. **認證**：註冊/登入/登出，`httpOnly` session（第 11 章）。
4. **後台** `/admin`：登入才能進（路由中介層 + 伺服器守衛），發表/刪除文章，只能刪自己的（第 9、11 章）。
5. **API + 資料庫**：Nitro `server/api` + Prisma/SQLite CRUD（第 8、10 章）。
6. **版面**：`default` 與 `admin` 兩種 layout（第 3 章）。
7. **狀態**：登入者資訊用 session composable、UI 狀態用 `useState`（第 7 章）。
8. **打磨**：錯誤處理（第 13 章）、可加 Tailwind/圖片（第 14 章）、快取與測試（第 5、15 章）。

### 章節能力對照

| 專題功能 | 用到的章 |
|---|---|
| 檔案式路由、動態路由 | 2 |
| layout / error 頁 | 3 |
| 自動匯入、composable | 4 |
| 渲染模式、快取 | 5、15 |
| 資料抓取 | 6 |
| 狀態管理 | 7 |
| Nitro API、環境設定 | 8 |
| 路由守衛 | 9 |
| 資料庫 CRUD | 10 |
| 認證授權 | 11 |
| SEO | 12 |
| 錯誤/plugin/模組 | 13 |
| 樣式/UI | 14 |
| 測試/部署 | 15、16 |

### 怎麼跑範例

```bash
cd blog-demo
npm install
npx prisma migrate dev --name init   # 建 SQLite 資料表
npm run dev
```

打開 `http://localhost:3000`：先到 `/login` 註冊一個帳號，登入後到 `/admin` 發文，回首頁看列表與詳情。詳細說明見 [`blog-demo/README.md`](./blog-demo/README.md)。

### 進階挑戰（做完基本再挑）

- 文章加分類/標籤與篩選。
- 留言功能（關聯 User 與 Post）。
- 草稿/發布狀態（用到 `published` 欄位）與分頁。
- 換成 PostgreSQL 並部署到 Vercel/Cloudflare。
- 幫關鍵路徑補 E2E 測試（第 15 章）。

---

## 7. 課程總結

從第 1 章的「Nuxt 補了 Vue 缺的哪塊」，到這裡你已經能：

- 用檔案式路由、layout、渲染模式搭出站台結構。
- 在伺服器就抓好資料、管好客戶端與伺服器狀態的分工。
- 用 Nitro 寫自家 API、接資料庫、做認證授權。
- 顧好 SEO、錯誤韌性、樣式、效能與測試。
- 選對產出與 preset，把作品部署上線。

這正是第 1 章那句話的兌現：**Vue 負責畫面，Nuxt 負責把 Vue 變成一個可上線的全端框架。** 接下來就是拿它去做你自己的產品了。

> 想再進一步：官方文件（nuxt.com）、Nitro 文件、以及本 repo 的 [React/Next.js 課](../../react/nextjs/README.md)（拿來對照 Next 與 Nuxt 的全端思路差異，收穫會很大）。
