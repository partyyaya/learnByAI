# Vue 學習地圖

> 這裡收錄本 repo 的 Vue 相關課程，從「會用」到「懂原理」再到「做全端」，你可以照程度挑一條線走。
>
> 定位對照：若你熟 React，Vue 之於你就是另一套宣告式 UI 框架；而 Nuxt 之於 Vue，就像 Next.js 之於 React。

---

## 四條學習線

| 線 | 入口 | 適合誰 | 你會得到 |
|----|------|--------|----------|
| 🟢 **基礎橋接** | [basics/README.md](./basics/README.md) | 會 JS（或會 React）、想快速上手 Vue 3 | `<script setup>`、響應式、元件、表單、Router、Pinia —— 學完能無縫進入下面兩門課 |
| 🧩 **自訂指令** | [01-custom-directives.md](./01-custom-directives.md) | 已會 Vue、需要直接操作 DOM 的場景 | 指令生命週期、`binding`、事件/observer 清理、SSR 與 `getSSRProps` |
| 🔬 **源碼解析** | [vue-source/README.md](./vue-source/README.md) | 想「看得懂、追得動、改得準」Vue 3 原始碼 | Reactivity（3.4 重寫）、Renderer/patch、Compiler、調試工作流與效能優化 |
| 🚀 **Nuxt 全端** | [nuxt/README.md](./nuxt/README.md) | 已有 Vue 3 基礎、想做可上線全端 | 檔案路由、SSR、資料抓取、Nitro API、Prisma、認證、SEO、部署 |

---

## 建議路線

```text
零基礎 / 只會 React
   → basics（精華橋接課，~7 章）
        ├─ 想做產品、全端 → nuxt（Nuxt 4 完整課，16 章）
        └─ 想懂底層原理   → vue-source（源碼解析，12 章）
   自訂指令（01-custom-directives）可在學完 basics 04 元件章後隨時插入
```

- **只想趕快做東西**：basics → nuxt，中間需要碰 DOM 再看自訂指令。
- **想打底 + 面試深度**：basics → vue-source。
- **已經會 Vue**：直接挑 vue-source 或 nuxt。

---

## 各課簡介

### 🟢 basics —— Vue 3 精華橋接課（~7 章）
把「能獨立寫 Vue 3 應用」需要的核心一次補齊：SFC 與 Vite、響應式（`ref`/`reactive`/`computed`/`watch`）、元件與 `props`/`emit`/`v-model`/`slots`、生命週期與 composable、表單與驗證、Vue Router 與 Pinia。定位是「橋接課」——學完就能看懂 vue-source 的組合式 API、也能直接進 Nuxt。

### 🧩 01-custom-directives —— 製作 Vue 自訂指令
什麼時候該用指令（而非 component/composable）、指令的生命週期 hook、`binding`（`value`/`arg`/`modifiers`）、`v-click-outside`/`v-lazy`/`v-permission` 實戰，以及副作用清理、根節點繼承、SSR（`getSSRProps`）等陷阱。

### 🔬 vue-source —— Vue 3 源碼解析課程
從 `reactivity` 走到 `runtime-core` 再到 `compiler-core`：`track`/`trigger`/`effect`、`computed`/`watch`/scheduler、renderer 與 patch、keyed diff 與 LIS、編譯器 parse/transform/codegen、編譯最佳化、進階內建（Teleport/KeepAlive/Suspense）、SFC 與 Vite 整合，最後是真實專案的源碼閱讀工作流與效能優化。

### 🚀 nuxt —— Nuxt 4 完整課程
以「實作優先」設計：檔案式路由、Layouts、渲染模式與 Route Rules、資料抓取（`useFetch`/`useAsyncData`/`$fetch`）、狀態（`useState`/Pinia）、Nitro `server/api`、路由中介層、Prisma 全端 CRUD、Cookie/Session 認證、SEO、效能與測試，最後把一個可上線的全端部落格（[blog-demo/](./nuxt/blog-demo/)）部署出去。

---

> 新手就從 [basics/README.md](./basics/README.md) 開始。
