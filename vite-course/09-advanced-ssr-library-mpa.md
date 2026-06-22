# 第 09 章:進階場景 —— SSR / Library Mode / 多頁 / Monorepo

> 前八章的主軸是「用 Vite 開發一個單頁應用(SPA)」。但真實世界的需求常常超出這個框架:
> 「我想做 SEO 友善的伺服器渲染」「我想用 Vite 打包一個給別人 `npm install` 的套件」
> 「我的網站不是單頁,是好幾個獨立 HTML」「我在 monorepo 裡開發」。
> 這一章把這四個進階場景講清楚:它們各是什麼、為什麼需要、Vite 怎麼支援、設定怎麼寫。

---

## 9.1 SSR(伺服器端渲染):是什麼、為什麼需要

### 先搞懂 SPA 的問題

前八章我們做的是 **SPA(Single Page Application,單頁應用)**:伺服器只回一個幾乎空的 HTML,剩下全靠 JS 在瀏覽器渲染。

```html
<!-- SPA 的 HTML,伺服器回給瀏覽器/爬蟲的就是這樣 -->
<body>
  <div id="app"></div>           <!-- 空的!內容靠 JS 填 -->
  <script type="module" src="/src/main.ts"></script>
</body>
```

這帶來兩個問題:

1. **SEO 不友善**:搜尋引擎爬蟲抓到的是「空的 div」,看不到內容(雖然現代爬蟲會執行 JS,但不穩定、有延遲)。
2. **首屏慢(白屏時間長)**:使用者要等「下載 JS → 執行 JS → 渲染」整套跑完,才看得到內容。網路慢時白屏明顯。

### SSR 的解法

**SSR(Server-Side Rendering)** 是:**在伺服器上先把頁面渲染成「有內容的完整 HTML」**,直接回給瀏覽器。

```html
<!-- SSR 回給瀏覽器的 HTML,內容已經填好了 -->
<body>
  <div id="app">
    <h1>歡迎光臨</h1>            <!-- 內容已經在這了!伺服器先渲染好的 -->
    <p>這是商品列表...</p>
  </div>
  <script type="module" src="/src/entry-client.js"></script>
</body>
```

效果:

1. **SEO 友善**:爬蟲一抓就看到完整內容。
2. **首屏快**:使用者立刻看到內容(雖然此時還不能互動)。

### Hydration(水合):SSR 的關鍵概念

但這裡有個關鍵問題:伺服器渲染出的 HTML 是「死的」——沒有事件監聽、按鈕點了沒反應。要讓它「活過來」能互動,需要**在瀏覽器端再跑一次框架,把事件、響應式狀態「接管」這份已存在的 HTML**。這個過程叫 **hydration(水合 / 注水)**。

```
SSR 完整流程:
① 伺服器:用框架把頁面渲染成 HTML 字串 → 回傳給瀏覽器
② 瀏覽器:立刻顯示這份 HTML(使用者看到內容了,但還不能互動)
③ 瀏覽器:下載並執行 JS,框架「接管」這份 HTML(hydration)
④ 接管完成:頁面變成可互動的(跟 SPA 一樣)
```

> **心智模型**:SSR = 「伺服器先畫好靜態的殼(讓使用者馬上看到 + SEO),瀏覽器再注入靈魂(讓它能動)」。Hydration 就是「注入靈魂」這一步——把死的 HTML 跟活的 JS 邏輯對接起來。

### Vite 怎麼支援 SSR

Vite 提供了 **SSR 的底層能力(low-level API)**,核心是兩個:

```js
// 1. 你需要兩個入口(而非 SPA 的一個):
//    entry-client.js —— 在瀏覽器跑,負責 hydration
//    entry-server.js —— 在伺服器跑,負責渲染出 HTML 字串

// 2. Vite 提供一個關鍵函式:在 Node 端載入並執行你的 ESM 模組
const { render } = await viteServer.ssrLoadModule('/src/entry-server.js')
const html = await render(url)     // 在伺服器渲染出 HTML
```

`ssrLoadModule` 是 Vite SSR 的核心:它讓你在 Node.js 伺服器端,**用 Vite 的轉換管線(第 04 章那套)即時載入並執行模組**——所以伺服器端也能享受「即時轉譯 TS/Vue、HMR」這些 dev 好處。

**但要誠實說**:直接用 Vite 的 SSR 底層 API 要自己處理很多細節(伺服器框架、路由、entry 管理、生產部署)。所以實務上,**大多數人不直接用 Vite SSR API,而是用建立在 Vite 之上的「上層框架」**:

| 框架 | 基於 | 適用 |
|------|------|------|
| **Nuxt** | Vue + Vite | Vue 生態的 SSR/SSG 全家桶 |
| **SvelteKit** | Svelte + Vite | Svelte 生態 |
| **Astro** | Vite | 內容導向網站,預設零 JS |
| **Remix / React Router** | React + Vite | React 生態 |

> **給你的實務建議**:除非你在做框架/工具,否則**不要自己從零搭 Vite SSR**。理解「SSR 是什麼、hydration 是什麼、Vite 提供了 `ssrLoadModule` 這層能力」就夠了,真要做 SSR 就選 Nuxt/SvelteKit/Astro,讓它們處理那些苦工。這一節的價值在「懂原理」,而非「手刻 SSR」。

### 相關:SSG(靜態生成)

順帶一提:**SSG(Static Site Generation)** 是 SSR 的近親——差別在「渲染的時機」:

- **SSR**:每次使用者請求時,在伺服器即時渲染。
- **SSG**:在 **build 時就把每個頁面渲染成靜態 HTML 檔**,部署的是一堆現成的 .html。適合內容不常變的站(部落格、文件、行銷頁)。

文件型網站(像本倉庫適合用的)常用 **VitePress**(基於 Vite 的 SSG),就是這個原理。

---

## 9.2 Library Mode:用 Vite 打包「套件」而非「應用」

到目前為止,我們都在打包「**應用(application)**」——最終產物是要丟到瀏覽器跑的網站。但有另一種需求:你想**做一個套件(library)**,發佈到 npm,讓別人 `npm install` 後 import 來用(例如一個 UI 元件庫、一個工具函式庫)。

打包「套件」和打包「應用」的目標完全不同,Vite 為此提供 **Library Mode**。

### 應用 vs 套件:差在哪

| 面向 | 打包應用 | 打包套件(Library Mode) |
|------|---------|------------------------|
| 最終誰來跑 | 瀏覽器(使用者) | **別人的打包工具**(使用者的 Vite/Webpack) |
| 入口 | `index.html` | 一個 JS 檔(如 `src/index.ts`) |
| 第三方依賴 | 打包進去(使用者直接拿整包) | **不打包**(列為 external,讓使用者自己的專案提供) |
| 輸出格式 | 給瀏覽器的 ESM | **多種格式**(ESM + CJS),相容不同使用者 |
| 產物 | 完整網站(dist/ 一堆檔 + html) | `.js` + 型別宣告檔(`.d.ts`) |

**最關鍵的差異是「依賴要不要打包進去」**。想一下:你做一個 Vue 元件庫,如果把 Vue 也打包進你的庫——使用者的專案本來就有 Vue,結果裝了你的庫又多一份 Vue,**重複了、還可能版本衝突**。所以套件要把 Vue 標為 `external`(外部依賴),意思是「我用 Vue,但我不帶它,使用者的環境自己會有」。

### 設定範例

```ts
// vite.config.ts(打包一個套件)
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',          // 套件的入口(不是 html!)
      name: 'MyLib',                  // UMD 格式下掛在全域的變數名
      fileName: 'my-lib',             // 輸出檔名
      formats: ['es', 'cjs'],         // 同時輸出 ESM 和 CommonJS 兩種格式
    },
    rollupOptions: {
      // external:這些依賴「不要打包進去」,當作外部依賴
      external: ['vue'],
      output: {
        globals: {
          vue: 'Vue',                 // UMD 格式下,vue 對應全域的 Vue
        },
      },
    },
  },
})
```

逐項解釋:

- **`lib.entry`**:套件入口是一個 JS 檔(你的 API 都從這裡 export 出去),不是 html。
- **`formats: ['es', 'cjs']`**:為什麼要輸出多種格式?因為使用者的環境不一定——有人用現代 ESM、有人的舊工具鏈還在用 CommonJS。輸出多種格式才能讓最多人用得了(回扣第 00 章 CJS/ESM 共存的現實)。
- **`external: ['vue']`**:把 Vue 排除在打包外,避免重複。
- **`globals`**:給 UMD/IIFE 格式用的,告訴打包器「external 的 vue,在全域是叫 `Vue`」。

### 別忘了型別宣告(.d.ts)

如果你的套件是 TS 寫的,使用者會期待有型別提示。但第 01、04 章說過:**Vite/esbuild 只剝型別、不產生型別宣告檔**。所以要額外用工具產生 `.d.ts`:

```bash
npm i -D vite-plugin-dts
```

```ts
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [dts()],     // build 時自動產生 .d.ts 型別宣告檔
})
```

> **回扣第 01 章**:Vite 不管型別,所以「型別檢查」交給 `tsc`、「產生型別宣告」交給 `vite-plugin-dts`。Vite 只負責「把 TS 變成能跑的 JS」這一件事——再次體現它「速度優先、各司其職」的哲學。

> **package.json 的搭配**:做套件還要正確設定 `package.json` 的 `main`(CJS 入口)、`module`(ESM 入口)、`types`(型別入口)、`exports`(現代的入口對應表)欄位,讓使用者的工具找得到對的檔案。這屬於 npm 發佈知識,這裡點到為止。

---

## 9.3 多頁應用(MPA):不只一個 HTML

SPA 只有一個 `index.html`。但有些網站天生是**多個獨立頁面**(MPA,Multi-Page Application),例如:`/` 首頁、`/admin` 後台、`/login` 登入頁,各自是獨立的 HTML 入口,彼此跳轉是真正的頁面切換(而非 SPA 的前端路由)。

Vite 原生支援多入口。設定方式:

```ts
import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        // 每個 key 是一個入口,value 是對應的 html 路徑
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
        login: resolve(__dirname, 'login/index.html'),
      },
    },
  },
})
```

目錄結構大致:

```
專案根/
├── index.html              ← 首頁入口
├── admin/
│   └── index.html          ← 後台入口
├── login/
│   └── index.html          ← 登入頁入口
└── src/
    ├── main.ts
    ├── admin.ts
    └── login.ts
```

**重點理解**:

- 還記得第 01 章「Vite 的入口是 HTML」嗎?MPA 就是「**多個 HTML 入口**」的自然延伸。每個 HTML 各自 `<script>` 自己的 JS。
- Vite 會把每個入口**各自打包**,但共用的依賴(它們都 import 的東西)會被抽成共享 chunk(回扣第 08 章 code splitting),不會重複打包。
- dev 時直接訪問 `http://localhost:5173/admin/` 就能進後台頁。

> **什麼時候用 MPA vs SPA?**
> - **SPA**:應用感強、頁面間共享大量狀態、要流暢的前端切換(後台系統、編輯器)。
> - **MPA**:頁面相對獨立、SEO 重要、各頁技術棧可不同(行銷站、文件站、傳統網站)。
> Vite 兩者都支援,差別只在「一個 html 入口」還是「多個 html 入口」。

---

## 9.4 Monorepo 整合

**Monorepo** 是「一個 git repo 裡放多個套件/應用」的專案組織方式,例如:

```
my-monorepo/
├── packages/
│   ├── ui/              ← 共用元件庫(用 9.2 的 Library Mode 打包)
│   └── utils/           ← 共用工具庫
└── apps/
    ├── web/             ← 主站(Vite 應用)
    └── admin/           ← 後台(Vite 應用)
```

`apps/web` 會 import `packages/ui` 和 `packages/utils`。Vite 在 monorepo 裡有幾個你該知道的點:

### 1. 用 pnpm workspace(推薦)

第 01 章提過 pnpm 對 monorepo 友善。`pnpm-workspace.yaml` 定義哪些目錄是 workspace 套件,套件間用 `workspace:*` 互相依賴,pnpm 會用符號連結(symlink)把本地套件「裝」起來,改了本地套件立刻生效。

### 2. Vite 能直接吃「沒打包的本地原始碼」

這是 Vite 在 monorepo 的一個甜蜜點。當 `apps/web` import `packages/ui` 時,如果 `ui` 還沒打包(只是原始 TS),Vite **能直接處理它的原始碼**(因為 Vite 本來就會即時轉譯 TS),於是:

- 你改 `packages/ui` 的元件 → `apps/web` 的 dev 能**即時 HMR**,不需要先 build ui。

這比傳統工具(要先 build 共用套件、才能在應用裡看到變化)順暢太多。

### 3. 注意 `server.fs.allow`

Vite dev server 預設基於安全考量,**限制只能存取專案根目錄內的檔案**。monorepo 裡 `apps/web` 要 import `packages/ui`(在根目錄的另一個分支),可能超出範圍而被擋。需要時放寬:

```ts
export default defineConfig({
  server: {
    fs: {
      // 允許存取 monorepo 根目錄(讓 apps 能讀到 packages)
      allow: ['..'],
    },
  },
})
```

> **為什麼預設要限制?** 安全。dev server 會把「能存取的檔案」透過 HTTP 暴露出去。如果不限制,惡意網頁可能透過 dev server 讀到你電腦上的任意檔案(`/etc/passwd` 之類)。所以 Vite 預設只開放專案目錄,monorepo 要跨目錄時才手動放寬到「確實需要的範圍」。

### 4. 依賴預打包的 monorepo 細節

回扣第 03 章:預打包針對 `node_modules` 的依賴。monorepo 裡的「本地 workspace 套件」通常被當成原始碼處理(不預打包),但如果某個本地套件已經是打包好的、或包含大量 CJS,你可能需要用 `optimizeDeps.include` 把它納入預打包,避免請求瀑布。這是 monorepo 偶爾要調的點。

---

## 9.5 本章小結與下一步

這一章帶你走出「單頁應用」的舒適圈,看了四個進階場景:

- **SSR**:伺服器先渲染有內容的 HTML(SEO + 首屏快),再靠 hydration 在瀏覽器「注入靈魂」;Vite 提供 `ssrLoadModule` 等底層能力,但實務建議用 Nuxt/SvelteKit/Astro。順帶認識 SSG。
- **Library Mode**:打包「給別人用的套件」而非應用,關鍵差異是「依賴設 external 不打包」、「輸出多格式(ESM+CJS)」、「要另外產生 .d.ts」。
- **MPA**:多個 HTML 入口,是第 01 章「HTML 即入口」的自然延伸;用 `rollupOptions.input` 設定多入口。
- **Monorepo**:pnpm workspace + Vite 能直接吃本地原始碼(改了即時 HMR);注意 `server.fs.allow` 的安全限制。

**下一章(10)**,我們談 Vite 的**引擎內幕與未來**:為什麼 dev 用 esbuild、build 用 Rollup 會造成「行為不一致」?Vite 團隊為什麼要用 Rust 寫一個新引擎 **Rolldown** 來統一兩者?它跟 **Turbopack**、**esbuild** 的競合關係是什麼?這一章會把全課反覆提到的「雙引擎取捨」做一個總收束,讓你理解 Vite 正在往哪裡走。

> 💡 **動手作業**:① 把一個專案改成 Library Mode 打包一個小工具函式(設 `lib.entry`、`external`),看產物跟「打包應用」差在哪。② 試著做一個有兩個 html 入口的 MPA 專案,build 後觀察 dist 裡的結構。③ (選做)用 pnpm 建一個最小 monorepo,讓 app 直接 import 一個本地 package,改 package 看 app 會不會即時 HMR。
