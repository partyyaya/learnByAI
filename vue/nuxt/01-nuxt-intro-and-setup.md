# 第 1 章：Nuxt 是什麼與環境建立

## 本章目標

完成這一章後，你應該可以：

1. 說出 Nuxt 相對於純 Vue（Vite）多解決了哪些問題。
2. 用一句話解釋「Universal Rendering（同構渲染）」與 hydration。
3. 分清 Nuxt 4 與 Nuxt 3 的差別，知道本課用哪個、差在哪。
4. 用官方指令建立一個可正常開發的 Nuxt 4 專案。
5. 看懂 Nuxt 4 專案結構（特別是新的 `app/` 目錄）與日常開發流程。

---

## 1. Vue 之後，為什麼還要 Nuxt？

你在 Vue 課學到的是「用 `.vue` 元件與響應式資料建構 UI」。但一個真正要上線的產品，用純 Vue + Vite 你得自己補很多東西：

- **路由**：純 Vue 要自己裝 Vue Router、手寫路由表；Nuxt 用資料夾就是路由。
- **伺服器渲染（SSR）與 SEO**：Vite SPA 首屏是一份幾乎空白的 HTML，爬蟲與分享預覽看不到內容；Nuxt 預設在伺服器先產出完整 HTML。
- **資料抓取的位置**：SPA 只能在瀏覽器抓資料；Nuxt 可以在**伺服器端**抓，首屏更快、也能藏金鑰。
- **後端能力**：內建 Nitro 伺服器引擎，`server/api/` 直接寫 API，不必另外開一個後端專案。
- **工程化預設**：自動匯入元件與 composable、程式碼分割、payload 傳遞、模組生態，框架幫你處理掉大半。

用一句話記：

> **Vue 負責畫面，Nuxt 負責「把 Vue 變成一個可上線的全端框架」。**

這跟 React → Next.js 是同一個關係。如果你看過本 repo 的 [React/Next.js 課](../../react/nextjs/README.md)，可以邊學邊對照：`pages/` ↔ `app/`、`useFetch` ↔ `fetch`、`server/api` ↔ Route Handlers。

---

## 2. 核心心智模型：Universal Rendering

Nuxt 預設是 **Universal Rendering（同構／通用渲染）**。一個頁面的生命大致是這樣：

```text
① 使用者請求 /posts
        ↓
② 伺服器執行你的 Vue 元件，抓好資料，產出「完整 HTML」回傳
        ↓（瀏覽器馬上看到內容 → 首屏快、SEO 友善）
③ 瀏覽器下載 JS，Vue 在既有 HTML 上「接手」變成互動 App → 這步叫 hydration
        ↓
④ 之後在站內切頁，就像 SPA 一樣由前端接管，不再整頁重載
```

關鍵詞：

- **SSR（Server-Side Rendering）**：步驟 ②，在伺服器把畫面算成 HTML。
- **Hydration（水合）**：步驟 ③，前端 JS 幫靜態 HTML「通電」，綁上事件、恢復響應式。

因為同一份元件程式碼會在**伺服器跑一次、瀏覽器再跑一次**，所以有些寫法要小心（例如直接用 `window`、`document`）。這是 Nuxt 初學者最常踩的坑，第 4 章的 `<ClientOnly>` 會專門處理它。

> 記住這張圖：**先在伺服器算好 HTML，再讓瀏覽器接手。** 本課後面所有「這段程式碼在哪跑」的討論，都是回到這張圖。

---

## 3. Nuxt 4 vs Nuxt 3

Nuxt 4 是目前 `create nuxt` 的預設版本，API 與 Nuxt 3 **大致相容**，多數 composable（`useFetch`、`useState`、`useHead`…）名稱與用法都一樣。本課全程使用 **Nuxt 4**，需要注意的主要差異只有幾個：

| | Nuxt 3 | Nuxt 4（本課採用） |
|---|---|---|
| 原始碼位置 | 專案根目錄（`pages/`、`components/`…） | 集中在 **`app/`** 目錄（`app/pages/`、`app/components/`…） |
| 資料抓取回傳 | `data` 是深層響應式 `ref` | `data` 改為 **`shallowRef`**（效能更好） |
| 同 key 的抓取 | 各自持有資料 | 同 `key` 的 `useFetch`/`useAsyncData` **共用** `data`/`error`/`status` |
| 元件名稱 | 依檔名 | 依路由/目錄結構 |

最有感的就是第一點：**Nuxt 4 把前端原始碼都收進 `app/`**。原因是把程式碼跟 `.git/`、`node_modules/` 分開，檔案監看更快、結構更清楚。第 6 章會再講 `shallowRef` 對你寫資料抓取的實際影響。

> 你在網路上看到教學把 `pages/`、`layouts/` 直接放在專案根目錄，那多半是 Nuxt 3 的寫法。本課一律放在 `app/` 底下，別混用。

---

## 4. 安裝開發環境

### 4.1 Node.js 版本

Nuxt 4 需要較新的 Node，建議直接用 **Node 20 LTS 以上**。確認版本：

```bash
node -v   # 建議 v20 以上
npm -v
```

> ⚠️ 本機若預設是舊版 Node（例如 v12），用它跑 Nuxt 會直接失敗。請用 nvm 切到 20：

```bash
nvm install 20
nvm use 20
node -v   # 例如 v20.19.5
```

### 4.2 推薦工具

- 編輯器：Cursor / VS Code
- VS Code 插件：**Vue - Official**（原 Volar，提供 `.vue` 語法與型別）、ESLint、Prettier
- 瀏覽器：Chrome / Edge

---

## 5. 用官方指令建立專案

Nuxt 4 建議用 `create nuxt`：

```bash
npm create nuxt@latest my-nuxt-course
```

它會問幾個問題，本課建議這樣選：

```text
✔ Which package manager?         › npm      （擇一即可，本課用 npm）
✔ Initialize git repository?     › Yes
✔ Install any modules?           › （先都不裝，後面章節需要再裝）
```

> 也可以用底層 CLI：`npx nuxi@latest init my-nuxt-course`，效果一樣。

建立完成後啟動：

```bash
cd my-nuxt-course
npm run dev
```

打開 `http://localhost:3000`，看到 Nuxt 歡迎頁就代表環境正確。第一次啟動會稍慢（要準備型別與相依），之後就很快。

---

## 6. 專案結構導覽（Nuxt 4）

`create nuxt` 產出的專案，重點檔案如下：

```text
my-nuxt-course/
├─ app/                 ← 你的前端原始碼都放這裡（Nuxt 4 新結構）
│  └─ app.vue           ← App 根元件（整個 App 的最外層）
├─ public/              ← 靜態檔案，原樣輸出（favicon、robots.txt…）
├─ server/              ← Nitro 伺服器程式（API、middleware，第 8 章）
├─ nuxt.config.ts       ← Nuxt 設定檔（模組、routeRules、runtimeConfig…）
├─ package.json
└─ tsconfig.json
```

隨著課程推進，你會在 `app/` 底下長出這些目錄（**放對位置就自動生效，不用註冊**）：

| 目錄／檔案 | 作用 | 對應章節 |
|---|---|---|
| `app/app.vue` | App 根元件 | 本章、第 3 章 |
| `app/pages/` | 檔案式路由，每個檔案是一個頁面 | 第 2 章 |
| `app/layouts/` | 共用版面 | 第 3 章 |
| `app/error.vue` | 全站錯誤頁 | 第 3、13 章 |
| `app/components/` | 元件（自動匯入） | 第 4 章 |
| `app/composables/` | 組合式函式（自動匯入） | 第 4、7 章 |
| `app/middleware/` | 路由中介層 | 第 9 章 |
| `app/plugins/` | 啟動時執行的外掛 | 第 13 章 |
| `app/assets/` | 需經 build 處理的資源（CSS、圖） | 第 14 章 |

留在**根目錄**（不進 `app/`）的：

| 目錄／檔案 | 作用 |
|---|---|
| `nuxt.config.ts` | 全站設定 |
| `server/` | Nitro API 與伺服器 middleware（第 8 章） |
| `public/` | 原樣輸出的靜態檔 |
| `content/` | Nuxt Content 內容（本課不主打） |
| `modules/` | 本地 Nuxt 模組 |

> 一句話：**「畫面相關的東西進 `app/`，伺服器與設定留在根目錄。」**

---

## 7. 日常開發流程與 Nuxt DevTools

常用指令（都在 `package.json` 的 `scripts`）：

```bash
npm run dev        # 開發伺服器（含 HMR 熱更新）
npm run build      # 打包成 Node 伺服器版本（.output/）
npm run generate   # 產出純靜態網站（第 5、16 章）
npm run preview    # 本機預覽 build 後的結果
```

啟動 `npm run dev` 後，畫面下方會有一個浮動的 **Nuxt DevTools** 按鈕（預設開啟）。點開它可以看到：

- **Pages**：目前所有路由
- **Components**：元件樹與來源
- **Composables**：這頁用到哪些 composable
- **Server Routes**：`server/api` 端點，可直接在裡面打 API 測試

> Nuxt DevTools 是學 Nuxt 最好的地圖。每學一個新概念，就到 DevTools 對應的分頁看它實際長怎樣。

---

## 8. 本章小練習

1. 用 `nvm use 20` 確認 Node 版本，再用 `npm create nuxt@latest` 建立專案並成功啟動。
2. 打開 Nuxt DevTools，找出目前有幾個 Pages、幾個 Components。
3. 把 `app/app.vue` 的內容清空，改成自己的一行字，存檔看畫面是否即時更新（HMR）。
4. 試著在專案根目錄（不是 `app/`）建立一個 `pages/` 資料夾放頁面，觀察 Nuxt 4 會不會理你——體會「原始碼要放 `app/`」。

---

## 最後範例：把歡迎頁換成你自己的第一個 App

> 目標：清掉樣板，換上一個最小但完整的根元件，確認結構正確、HMR 正常。原樣建立／覆蓋以下檔案即可。

### `app/app.vue`

```vue
<script setup>
// script setup 是 Vue 3 的元件寫法；Nuxt 完全沿用。
// 這裡先不抓資料，只放一個本地響應式狀態，確認互動與 HMR 都正常。
const count = ref(0) // ref 由 Nuxt 自動匯入，不用手動 import
</script>

<template>
  <main class="wrap">
    <h1>我的第一個 Nuxt 4 App</h1>
    <p>這份 HTML 是伺服器先算好的，你按下面的按鈕才由瀏覽器接手（hydration）。</p>

    <button class="btn" @click="count++">
      被點了 {{ count }} 次
    </button>

    <p class="hint">
      改這個檔案存檔，畫面會即時更新（HMR）。下一章開始用 <code>app/pages/</code> 做真正的路由。
    </p>
  </main>
</template>

<style scoped>
.wrap {
  max-width: 640px;
  margin: 48px auto;
  padding: 0 16px;
  font-family: -apple-system, "Segoe UI", sans-serif;
  color: #111827;
  line-height: 1.7;
}
h1 { font-size: 28px; }
.btn {
  margin: 12px 0;
  padding: 10px 18px;
  font-size: 16px;
  color: #fff;
  background: #00dc82; /* Nuxt 的招牌綠 */
  border: none;
  border-radius: 10px;
  cursor: pointer;
}
.btn:hover { background: #00b86b; }
.hint { color: #6b7280; font-size: 14px; }
code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
</style>
```

存檔後回到 `http://localhost:3000`：

- 看到標題與按鈕 → SSR 正常（用「檢視原始碼」可看到 HTML 裡就有這些字，證明是伺服器產出的）。
- 點按鈕數字會加 → hydration 正常，前端已接手。
- 改 `app.vue` 的文字存檔，畫面秒更新 → HMR 正常。

三個都通過，代表你的 Nuxt 4 環境完全就緒。

---

## 本章結語

你已經知道 Nuxt 補了純 Vue 缺的哪一塊、Universal Rendering 是怎麼運作的，也建好了一個 Nuxt 4 專案、認得 `app/` 新結構。
下一章進到 Nuxt 最基本、也最迷人的功能：**用資料夾就是路由**——把 `app/pages/` 一放，網址自動長出來。
