# 第 07 章:Plugin 系統(下)—— Vite 專屬能力

> 第 06 章學的 `resolveId` / `load` / `transform` 是「Rollup 相容」的部分——它們管「模組內容」。
> 但 Vite 是個 dev server,還需要管「設定、dev server 行為、HTML、HMR」這些 Rollup 沒有的東西。
> 這就是 Vite **專屬 hook**。這一章我們學:`config`、`configureServer`(做 mock API!)、
> `transformIndexHtml`、`handleHotUpdate`(自訂 HMR,接回第 05 章),
> 以及讓多個 plugin 正確協作的兩個關鍵旋鈕:**`enforce`(順序)** 與 **`apply`(階段)**。
> 學完這兩章,你就能讀懂、也能寫出真實世界的 Vite plugin。

---

## 7.1 為什麼需要「Vite 專屬」hook?

第 06 章說 Vite plugin 相容 Rollup。但 Rollup 本質是個**打包器**——它只懂「模組怎麼變成 bundle」,它不知道什麼是「dev server」「HTML 入口」「HMR」。

而 Vite 是個**開發伺服器 + 打包器**。所以 Vite 在 Rollup 的 hook 之上,**額外加了一組只有 Vite 才有的 hook**,專門處理 Rollup 管不到的領域:

| Vite 專屬 hook | 管什麼領域 | Rollup 為何沒有 |
|----------------|-----------|----------------|
| `config` / `configResolved` | 修改、讀取最終設定 | Rollup 設定模型不同 |
| `configureServer` | 操作 dev server(加中介層) | Rollup 沒有 dev server |
| `transformIndexHtml` | 處理 HTML 入口 | Rollup 入口是 JS,不管 HTML |
| `handleHotUpdate` | 自訂 HMR 行為 | Rollup 沒有 HMR |

> **心智模型**:第 06 章的 hook 管「**模組**」,第 07 章的 hook 管「**Vite 這個工具本身的環境**」(設定、伺服器、網頁、熱更新)。兩者合起來,才是完整的 Vite plugin。

---

## 7.2 `config` 與 `configResolved`:讀寫設定

### `config`:在設定「最終定案前」修改它

`config` hook 讓 plugin 有機會**修改使用者的 vite.config**。這常用於「一個 plugin 想順便幫你補上某些設定」。

```js
function autoAliasPlugin() {
  return {
    name: 'auto-alias',
    config(userConfig, env) {
      // userConfig:使用者寫的設定(可能還沒補全)
      // env:{ command: 'serve' | 'build', mode: 'development' | ... }
      //
      // 回傳一個「部分設定物件」,Vite 會把它「深層合併」進最終設定。
      // 這裡示範:自動幫使用者加一個 @ 指向 /src 的別名。
      return {
        resolve: {
          alias: {
            '@': '/src',
          },
        },
      }
    },
  }
}
```

**重點**:

- 你**回傳一個片段**,Vite 負責合併,而不是你直接改 `userConfig`(雖然也能改,但回傳片段更安全、語意更清楚)。
- `env.command` 告訴你現在是 `serve`(dev)還是 `build`——讓你能「dev 時補這個、build 時補那個」。

### `configResolved`:設定「定案後」唯讀地拿到它

`config` 是「定案前修改」,`configResolved` 是「**定案後讀取**」。所有 plugin 的 `config` 都跑完、Vite 把設定合併補全後,會呼叫 `configResolved`,把**最終、完整的設定**交給你。

```js
function envAwarePlugin() {
  let resolvedConfig            // 用一個變數存起來,後面其他 hook 要用

  return {
    name: 'env-aware',
    configResolved(config) {
      // config 是最終定案的完整設定(唯讀,不要再改它)
      resolvedConfig = config
    },
    transform(code, id) {
      // 後面的 hook 就能用最終設定來決定行為
      if (resolvedConfig.command === 'build') {
        // build 時才做某些事
      }
    },
  }
}
```

**為什麼要分「修改階段」和「讀取階段」兩個 hook?** 因為設定的形成是有順序的:所有 plugin 先輪流「提議修改」(`config`),Vite 合併出最終版,再「公告定案」(`configResolved`)。如果你在還沒定案時就讀,可能讀到不完整或之後被別人改掉的值。**所以:要改設定用 `config`,要讀最終設定用 `configResolved`。**

---

## 7.3 `configureServer`:操作 dev server(做一個 mock API!)

這是 Vite 專屬 hook 裡**最實用**的一個。它讓你拿到 dev server 物件,往上面掛東西——最常見的就是**加中介層(middleware)做 API mock**。

Vite 的 dev server 底層是一個 [Connect](https://github.com/senchalabs/connect) 應用(跟 Express 的中介層機制類似)。`configureServer` 把這個 server 交給你:

```js
function mockApiPlugin() {
  return {
    name: 'mock-api',
    configureServer(server) {
      // server.middlewares 是一個 Connect 中介層堆疊,可以 .use() 掛東西
      server.middlewares.use('/api/user', (req, res, next) => {
        // 攔截對 /api/user 的請求,直接回一個假資料
        // 這樣前端開發時,後端 API 還沒好也能先跑
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ id: 1, name: '測試用戶' }))
        // 注意:這裡直接 res.end 結束了,沒呼叫 next(),
        // 表示「這個請求我處理完了,不要再往後傳」
      })
    },
  }
}
```

現在 dev 時,前端打 `fetch('/api/user')` 就會拿到假資料,**不需要真的後端**。

**幾個關鍵理解**:

- **中介層是什麼?** 它是一個函式 `(req, res, next) => {}`,夾在「請求進來」和「Vite 處理」之間。你可以決定:① 自己回應(`res.end`),或 ② 放行交給下一個(`next()`)。
- **`return () => {}` 的進階用法**:`configureServer` 可以回傳一個函式,那個函式會在「Vite 自己的中介層都裝好之後」才執行。差別在於你的中介層要排在 Vite 前面還是後面:

```js
configureServer(server) {
  // 寫在這裡:你的中介層裝在「Vite 內建中介層之前」
  server.middlewares.use(myMiddlewareA)

  return () => {
    // 寫在這裡(回傳的函式內):裝在「Vite 內建中介層之後」
    server.middlewares.use(myMiddlewareB)
  }
}
```

> **什麼時候用前 / 後?** 如果你的中介層要「攔截掉某些請求、不讓 Vite 處理」(像 mock API),放前面(直接寫);如果你要「處理 Vite 沒接住的請求」(像自訂 fallback),放後面(回傳函式內)。

> **實務價值**:`configureServer` 是「前端先行開發」的利器。後端 API 還沒做好?用它 mock。要在 dev 加個健康檢查端點、加個特殊的 header、記錄請求 log?都在這裡。很多知名 plugin(mock、SSR 中介層)都靠它。

---

## 7.4 `transformIndexHtml`:改 HTML 入口

回憶第 01 章:**Vite 的入口是 `index.html`**。`transformIndexHtml` 就是讓你在 HTML 送給瀏覽器前動手改它的 hook。

```js
function injectMetaPlugin() {
  return {
    name: 'inject-meta',
    transformIndexHtml(html) {
      // 最簡單的形式:拿到 html 字串,回傳改過的字串
      return html.replace(
        '</head>',
        `  <meta name="generated-by" content="my-vite-plugin">\n</head>`
      )
    },
  }
}
```

更結構化、也更推薦的形式是回傳「要注入的標籤描述」,讓 Vite 幫你正確插入:

```js
transformIndexHtml(html) {
  return {
    html,                                   // 原本的 html(可不動)
    tags: [                                 // 要注入的標籤
      {
        tag: 'script',
        attrs: { src: 'https://cdn.example.com/analytics.js', async: true },
        injectTo: 'head',                   // 注入位置:head / body / head-prepend...
      },
    ],
  }
}
```

**典型用途**:

- 注入分析腳本(Google Analytics)、第三方 SDK。
- 根據環境變數動態改 `<title>`、注入 meta 標籤。
- 把某些變數(如 CDN 網址)插進 HTML 給前端用。

> **為什麼需要這個 hook?** 因為 HTML 是 Vite 的入口,而 Rollup 不管 HTML(它只管 JS)。要在「打包/啟動的流程裡」動態改 HTML,只能靠這個 Vite 專屬 hook。它在 dev(改完即時送瀏覽器)和 build(改完寫進 dist/index.html)都會跑。

---

## 7.5 `handleHotUpdate`:自訂 HMR 行為(接回第 05 章)

第 05 章講了 HMR 的完整機制。`handleHotUpdate` 就是讓 plugin **介入「檔案變動 → 算更新」這個過程**的 hook。框架 plugin(plugin-vue/react)就是用它來實現「改 .vue 檔時做框架專屬的熱更新」。

```js
function customHmrPlugin() {
  return {
    name: 'custom-hmr',
    handleHotUpdate(ctx) {
      // ctx.file:變動的檔案絕對路徑
      // ctx.server:dev server,可以手動發送 HMR 訊息
      // ctx.modules:這個檔案對應的 module graph 節點(第 05 章的 module graph!)
      // ctx.read:讀取變動後檔案內容的函式

      if (ctx.file.endsWith('.config.json')) {
        // 例如:某個設定檔變了,我想「整頁重載」而不是嘗試 HMR
        ctx.server.ws.send({ type: 'full-reload' })
        return []     // 回傳空陣列 = 「我處理掉了,Vite 不要再做預設 HMR」
      }

      // 不回傳(或回傳 ctx.modules) = 走 Vite 預設 HMR 流程
    },
  }
}
```

**它能做的幾件事**(對應第 05 章概念):

- **改變更新範圍**:回傳一個「要更新的 module 陣列」,縮小或擴大第 05 章講的「受影響模組」。
- **強制整頁重載**:用 `ctx.server.ws.send({ type: 'full-reload' })`——這就是第 05 章「找不到邊界就整頁重載」的手動版,你可以主動觸發。
- **發送自訂 HMR 事件**:配合前端的 `import.meta.hot.on('自訂事件', cb)`,做完全客製的熱更新(例如某 plugin 想在資料變動時通知前端重抓,而不重載)。

> **回扣第 05 章**:你現在懂了「為什麼 .vue 檔改了能做到框架感知的精準熱更新」——因為 `@vitejs/plugin-vue` 在 `handleHotUpdate` 裡判斷「這次改的是 template 還是 script?是 style 嗎?」,然後決定要走哪種更新、發什麼訊息給前端。HMR 的「框架智慧」就藏在這個 hook 裡。

---

## 7.6 plugin 的執行順序:`enforce`

當你裝了好幾個 plugin,它們的 hook 執行**順序**會影響結果(尤其 `transform` 是串接的——A 先轉還是 B 先轉,結果可能不同)。Vite 用 `enforce` 控制順序。

```js
function myPlugin() {
  return {
    name: 'my-plugin',
    enforce: 'pre',     // 'pre' | 'post' | 不寫(預設)
    transform(code, id) { /* ... */ },
  }
}
```

執行順序的規則是分三批:

```
① enforce: 'pre' 的 plugin（最先跑）
        ↓
② 沒寫 enforce 的 plugin + Vite 核心 plugin（中間,按陣列順序）
        ↓
③ enforce: 'post' 的 plugin（最後跑）
```

**怎麼選?用「我想在轉換前還是轉換後動手」來判斷**:

- **`enforce: 'pre'`**:你想**搶在別人(尤其 Vite 內建轉換、框架 plugin)之前**處理原始碼。例如:你寫一個 plugin 要在 TS 被剝型別「之前」對原始 TS 做點手腳,就用 `pre`。
- **不寫(預設)**:大多數情況,你的 plugin 跟一般轉換一起跑就好。
- **`enforce: 'post'`**:你想**等所有轉換都做完、拿到最終結果**再處理。例如:你要分析/檢查最終產出的 JS,就用 `post`。

> **常見錯誤**:plugin 順序錯導致「我想處理的語法,在輪到我之前已經被別的 plugin 轉掉了」。例如你想處理 JSX,但 React plugin 已經先把 JSX 轉成 JS 了,你拿到的根本沒有 JSX。解法就是 `enforce: 'pre'` 搶在它前面。**遇到「我的 transform 拿到的內容不是我預期的原始樣子」,先想 enforce 順序。**

---

## 7.7 plugin 的生效階段:`apply`

有些 plugin 只在 dev 有意義(例如 mock API server),有些只在 build 有意義(例如壓縮、產生 bundle 分析報告)。`apply` 讓你指定 plugin **只在某個階段啟用**。

```js
function devOnlyPlugin() {
  return {
    name: 'dev-only',
    apply: 'serve',     // 'serve'(只在 dev)| 'build'(只在 build)
    configureServer(server) { /* 只有 dev 才需要 */ },
  }
}
```

```js
function buildOnlyPlugin() {
  return {
    name: 'build-only',
    apply: 'build',     // 只在 vite build 時啟用
    // ...產生報告、額外最佳化之類的
  }
}
```

`apply` 也可以是函式,做更細的判斷:

```js
apply(config, { command }) {
  // 例如:只在「build 且不是 SSR」時啟用
  return command === 'build' && !config.build?.ssr
}
```

**為什麼需要 `apply`?**

1. **效能 / 正確性**:把只在 dev 有用的 plugin 排除在 build 之外,避免它在 build 時做無意義甚至有害的事。
2. **避免衝突**:第 06 章說過「dev 是 Vite plugin container 跑、build 是 Rollup 跑」。有些 plugin 的邏輯在某一邊會出問題,用 `apply` 限定它只在能正常運作的階段啟用,就能避開(又一次回扣第 00 章雙引擎)。

> **`enforce` 和 `apply` 的關係**:`enforce` 管「**順序**」(同一階段裡誰先誰後),`apply` 管「**要不要在這個階段出現**」。兩者正交,可以同時用。

---

## 7.8 把兩章串起來:一個 plugin 的完整骨架

把第 06、07 章學的全放在一起,一個「功能完整」的 plugin 骨架長這樣。不用全部用上,但這張全景圖能幫你定位任何 hook:

```js
function fullPlugin(options) {
  let resolvedConfig

  return {
    name: 'full-plugin',          // 【必填】識別名
    enforce: 'pre',               // 【可選】執行順序:pre / post / 不寫
    apply: 'serve',               // 【可選】生效階段:serve / build / 函式

    // ── 設定階段(Vite 專屬,第 07 章) ──
    config(userConfig, env) { /* 修改設定,回傳片段 */ },
    configResolved(config) { resolvedConfig = config },  // 讀最終設定

    // ── dev server(Vite 專屬,第 07 章) ──
    configureServer(server) { /* 掛中介層,做 mock 等 */ },

    // ── 建構生命週期(Rollup 相容,第 06 章) ──
    buildStart() { /* 建構開始 */ },

    // ── 模組處理(Rollup 相容,第 06 章核心三 hook) ──
    resolveId(source, importer) { /* id 解析、虛擬模組認領 */ },
    load(id) { /* 提供內容、虛擬模組內容 */ },
    transform(code, id) { /* 加工內容 */ },

    // ── HTML(Vite 專屬,第 07 章) ──
    transformIndexHtml(html) { /* 改 HTML 入口 */ },

    // ── HMR(Vite 專屬,第 07 章) ──
    handleHotUpdate(ctx) { /* 自訂熱更新 */ },

    // ── 收尾(Rollup 相容) ──
    closeBundle() { /* build 全部結束 */ },
  }
}
```

> **學習建議**:把這張骨架截圖存著。以後讀任何 plugin 原始碼,先對照「它用了哪些 hook」,你就能快速判斷它在做什麼:有 `configureServer` → 它動了 dev server;有 `transform` → 它改模組內容;有 `handleHotUpdate` → 它客製了 HMR。

---

## 7.9 本章小結與下一步

這一章補完了 plugin 系統的另一半——Vite 專屬能力:

- **為何需要專屬 hook**:Rollup 只管模組/打包,不懂 dev server、HTML、HMR,所以 Vite 額外加了一組。
- **`config` / `configResolved`**:前者「定案前修改設定」,後者「定案後讀取最終設定」。
- **`configureServer`**:操作 dev server 加中介層,**做 mock API**、自訂端點;`return () => {}` 控制排在 Vite 中介層前或後。
- **`transformIndexHtml`**:改 HTML 入口(注入腳本、meta),因為 Rollup 不管 HTML。
- **`handleHotUpdate`**:自訂 HMR 行為,揭曉第 05 章「框架感知熱更新」的實作位置。
- **`enforce`(順序)**:`pre` 搶在前、`post` 殿後;解決「我的 transform 拿到的不是預期內容」。
- **`apply`(階段)**:限定 plugin 只在 `serve` 或 `build` 啟用,避免無謂運作與雙引擎衝突。

**下一章(08)**,我們離開 dev,正式進入**生產建構與 Rollup**:`vite build` 到底做了什麼?tree shaking 怎麼砍掉沒用到的程式碼?code splitting 怎麼自動拆出 chunk、`import()` 動態載入怎麼運作?那些 hash 檔名(第 01、04 章一直提到的)的完整故事?以及怎麼分析、優化你的產物體積。這是讓你的應用「上線跑得快」的關鍵一章。

> 💡 **動手作業**:① 用 `configureServer` 在你的專案做一個 `/api/hello` 的 mock,前端 `fetch` 它拿到假資料,體會「前端先行」。② 寫兩個都有 `transform` 的 plugin,一個 `enforce: 'pre'`、一個不寫,在 transform 裡 `console.log` 出 id,觀察執行順序,印證 7.6 的規則。
