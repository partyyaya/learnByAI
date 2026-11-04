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
| `configurePreviewServer` | 操作 `vite preview` 的伺服器(用法同上) | Rollup 沒有 preview |
| `transformIndexHtml` | 處理 HTML 入口 | Rollup 入口是 JS,不管 HTML |
| `handleHotUpdate`(Vite 6 起另有 `hotUpdate`) | 自訂 HMR 行為 | Rollup 沒有 HMR |

> **心智模型**:第 06 章的 hook 管「**模組**」,第 07 章的 hook 管「**Vite 這個工具本身的環境**」(設定、伺服器、網頁、熱更新)。兩者合起來,才是完整的 Vite plugin。

---

## 7.2 `config` 與 `configResolved`:讀寫設定

### `config`:在設定「最終定案前」修改它

`config` hook 讓 plugin 有機會**修改使用者的 vite.config**。這常用於「一個 plugin 想順便幫你補上某些設定」。

```js
import path from 'node:path'

function autoAliasPlugin() {
  return {
    name: 'auto-alias',
    config(userConfig, env) {
      // userConfig:使用者寫的設定(可能還沒補全)
      // env:{ command: 'serve' | 'build', mode: 'development' | ... }
      //
      // 回傳一個「部分設定物件」,Vite 會把它「深層合併」進最終設定。
      // 這裡示範:自動幫使用者加一個 @ 指向專案 src 目錄的別名
      // (別名的值要是檔案系統的絕對路徑,第 01 章)。
      const root = path.resolve(userConfig.root ?? process.cwd())
      return {
        resolve: {
          alias: {
            '@': path.join(root, 'src'),
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

**為什麼要分「修改階段」和「讀取階段」兩個 hook?** 
因為設定的形成是有順序的:所有 plugin 先輪流「提議修改」(`config`)Vite 合併出最終版,再「公告定案」(`configResolved`)。
如果你在還沒定案時就讀,可能讀到不完整或之後被別人改掉的值。**所以:要改設定用 `config`,要讀最終設定用 `configResolved`。**

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
- **`return () => {}` 的進階用法**:`configureServer` 可以回傳一個函式,那個函式會在「Vite 大部分內建中介層裝好之後」才執行。差別在於你的中介層要排在 Vite 前面還是後面:

```js
configureServer(server) {
  // 寫在這裡:你的中介層裝在「Vite 內建中介層之前」
  server.middlewares.use(myMiddlewareA)

  return () => {
    // 寫在這裡(回傳的函式內):裝在模組轉換、靜態檔、SPA fallback「之後」,
    // 但在「送出 index.html」之前(下面細講)
    server.middlewares.use(myMiddlewareB)
  }
}
```

> **什麼時候用前 / 後?** 如果你的中介層要「攔截掉某些請求、不讓 Vite 處理」(像 mock API),放前面(直接寫);如果你要「只處理 Vite 的模組與靜態檔都沒接住的請求」(例如某些頁面網址改回自訂 HTML),放後面(回傳函式內)。

中介層是一條排隊的水管,**誰先掛上去誰先看到請求**。而 Vite 自己也有一堆內建中介層。以預設的 SPA 專案為例,完整的排隊順序是:

```
請求進來
  → ① 你直接寫的中介層(前)
  → ② Vite:模組轉換(/src/main.ts、.vue…)、靜態檔(public/)
  → ③ Vite:SPA fallback —— 「看起來像頁面」的網址,一律把 req.url 改寫成 /index.html
  → ④ 你在回傳函式裡寫的中介層(後)
  → ⑤ Vite:送出(轉換過的)index.html
  → ⑥ Vite:都沒人處理 → 404
```

注意 ④ 排在 ⑤ **前面**:放在後面的中介層,會看到**所有頁面請求,包括首頁本身**。你排在 Vite 前面還後面,結果差很多。看兩個對照的例子:

**放前面 → 攔截**:我先看到,處理掉就不給 Vite。

```js
configureServer(server) {
  // 直接寫 → 排在 Vite 內建中介層「之前」
  server.middlewares.use('/api/user', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: 1, name: '測試用戶' }))
    // 沒呼叫 next() → 請求到我這裡就結束,Vite 根本沒機會處理
  })
}
```

為什麼放前面?因為 `/api/user` 這種路徑若讓 Vite 先看到,③ 的 SPA fallback 會把它當成前端路由,回給你一份 `index.html`——你的 `fetch` 拿到的是 HTML 而不是 JSON。你要在 Vite 出手前就攔下來自己回假資料——這就是 **mock API**:搶在 Vite 前面把請求吃掉。

**放後面 → 處理「頁面」請求**:模組和靜態檔 Vite 都處理完了,剩下的頁面請求才輪到我。

```js
configureServer(server) {
  return () => {
    // 寫在回傳的函式內 → 排在 ②③ 之後、⑤ 之前
    server.middlewares.use((req, res, next) => {
      // 能跑到這裡:這是一個「頁面」請求,而且 ③ 已經把 req.url 改成 /index.html,
      // 使用者原本要的網址在 req.originalUrl
      if (req.originalUrl.startsWith('/legacy/')) {
        res.setHeader('Content-Type', 'text/html')
        res.end('<h1>舊版頁面已下線</h1>')
        return
      }
      next()   // ⚠️ 其他請求一定要放行,讓 ⑤ 送出 index.html
    })
  }
}
```

為什麼放後面?因為你只想處理「頁面」,不想碰 `/src/main.ts`、`.vue` 這些模組請求——那些在 ② 就被 Vite 處理掉了,根本不會流到你這裡。如果放前面,它會看到**每一個**請求,稍有不慎就把 Vite 該做的事搶走。

> ⚠️ **常見陷阱:在後面無條件回 404**。直覺上會以為「跑到後面 = Vite 沒接住 = 該回 404」,於是寫 `res.statusCode = 404; res.end(...)` 卻不呼叫 `next()`。但首頁 `/` 在 ③ 也被改寫成 `/index.html`、同樣流到 ④,結果**連首頁都變成 404,整個 app 打不開**。後面的中介層處理不了的請求,一定要 `next()`。

| 目的 | 位置 | 心態 |
|------|------|------|
| 攔截、搶請求(mock API) | 前(直接寫) | 「這個我要,Vite 別碰」 |
| 改寫頁面回應(自訂 HTML) | 後(回傳函式內) | 「模組交給 Vite,頁面我先看一眼,不是我的就 next()」 |

判斷法則:**「我要跟 Vite 搶」→ 放前面;「我只管頁面請求」→ 放後面,而且不是自己要處理的就 `next()`。**

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

第 05 章講了 HMR 的完整機制。`handleHotUpdate` 就是讓 plugin **介入「檔案變動 → 算更新」這個過程**的 hook。`@vitejs/plugin-vue` 就是用它來實現「改 .vue 檔時做框架專屬的熱更新」。(plugin-react 走的是另一條路:在 `transform` 裡注入 React Refresh 的程式碼,第 05 章。)

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
- **發送自訂 HMR 事件**:配合前端的 `import.meta.hot.on('自訂事件', cb)`,做完全客製的熱更新(例如某 plugin 想在資料變動時通知前端重抓,而不重載):

```js
handleHotUpdate(ctx) {
  if (ctx.file.endsWith('.mock.json')) {
    // type: 'custom' + event 名稱,前端用 import.meta.hot.on('mock:changed', ...) 接收
    ctx.server.ws.send({ type: 'custom', event: 'mock:changed', data: { file: ctx.file } })
    return []
  }
}
```

> **回扣第 05 章**:你現在懂了「為什麼 .vue 檔改了能做到框架感知的精準熱更新」——因為 `@vitejs/plugin-vue` 在 `handleHotUpdate` 裡判斷「這次改的是 template 還是 script?是 style 嗎?」,然後決定要走哪種更新、發什麼訊息給前端。HMR 的「框架智慧」就藏在這個 hook 裡。

> **Vite 6 起的新寫法 `hotUpdate`**:Vite 6 引入 Environment API,把 dev server 拆成多個「環境」(瀏覽器端 `client`、伺服器端 `ssr`…),每個環境各有自己的 module graph。新的 `hotUpdate` hook 會**對每個環境各呼叫一次**,用 `this.environment` 知道現在是哪個環境、用 `this.environment.hot.send(...)` 發訊息,參數另外多了 `type`(`'create'` / `'update'` / `'delete'`)可以分辨新增、修改、刪除檔案。`handleHotUpdate` 仍然可用,官方預計未來淘汰它;新寫的 plugin 建議用 `hotUpdate`:
>
> ```js
> hotUpdate({ file }) {
>   if (this.environment.name !== 'client') return   // 只處理瀏覽器端
>   if (file.endsWith('.config.json')) {
>     this.environment.hot.send({ type: 'full-reload' })
>     return []
>   }
> }
> ```

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

Vite 會把所有 plugin(你的 + 它自己內建的)排成下面這個固定順序,同一層裡再照 `plugins` 陣列的順序:

```
① Alias(resolve.alias 的處理)
        ↓
② 你的 plugin,enforce: 'pre'
        ↓
③ Vite 核心 plugin(解析、CSS、TS/JSX 轉譯、JSON、靜態資源…)
        ↓
④ 你的 plugin,沒寫 enforce
        ↓
⑤ Vite 的 build plugin(只在 build 時)
        ↓
⑥ 你的 plugin,enforce: 'post'
        ↓
⑦ Vite 的 post build plugin(壓縮、manifest、輸出報告)
```

注意 ③ 在 ④ **前面**:沒寫 `enforce` 的 plugin 拿到 `.ts` 檔時,型別**已經被剝掉了**,拿到的是 JS。

**怎麼選?用「我想在轉換前還是轉換後動手」來判斷**:

- **`enforce: 'pre'`**:你想**搶在 Vite 內建轉換之前**處理原始碼。例如:你寫一個 plugin 要在 TS 被剝型別「之前」對原始 TS 做點手腳,就用 `pre`。
- **不寫(預設)**:大多數情況,你的 plugin 拿到「Vite 已經轉成 JS」的內容再加工就好。
- **`enforce: 'post'`**:你想**等所有轉換都做完、拿到最終結果**再處理。例如:你要分析/檢查最終產出的 JS,就用 `post`。

> **常見錯誤**:plugin 順序錯導致「我想處理的語法,在輪到我之前已經被別的 plugin 轉掉了」。例如你想處理 JSX,但它在 ③ 就被轉成 JS 了,你在 ④ 拿到的根本沒有 JSX。解法就是 `enforce: 'pre'` 搶在它前面。
> **遇到「我的 transform 拿到的內容不是我預期的原始樣子」,先想 enforce 順序。**

`enforce` 是整個 plugin 一起調順序。如果只想調**某一個 hook** 的順序,可以把 hook 寫成物件,加上 `order`(值也是 `'pre'` / `'post'`):

```js
{
  name: 'my-plugin',
  transform: {
    order: 'pre',                 // 只有 transform 提前,其他 hook 照原本的位置
    handler(code, id) { /* ... */ },
  },
}
```

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
2. **避免衝突**:第 06 章說過「dev 是 Vite plugin container 跑、build 是 bundler 跑」。有些 plugin 的邏輯在某一邊會出問題,用 `apply` 限定它只在能正常運作的階段啟用,就能避開(又一次回扣第 00 章的雙路徑)。

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
    closeBundle() { /* build 全部結束;dev 則是在 server 關閉時 */ },
  }
}
```

> **學習建議**:把這張骨架截圖存著。以後讀任何 plugin 原始碼,先對照「它用了哪些 hook」,你就能快速判斷它在做什麼:有 `configureServer` → 它動了 dev server;有 `transform` → 它改模組內容;有 `handleHotUpdate` → 它客製了 HMR。

上面是「空殼」。接下來三個範例,是把這張骨架**填成真的能跑的 plugin**——每個都刻意組合好幾個 hook,讓你看到它們怎麼協作。建議照著抄進自己的專案跑一次。

### 範例一:建置資訊虛擬模組(`configResolved` + `resolveId` + `load` + `transformIndexHtml`)

**要解決的問題**:我想在程式裡 `import` 一份「這次是哪個模式、什麼時候建的」資訊,拿來顯示版本號、方便線上排查。這份資訊沒有對應的實體檔案——正是第 06 章「**虛擬模組**」的場景,再配上第 07 章的 `configResolved` 拿最終設定。

```js
function buildInfoPlugin() {
  const virtualId = 'virtual:build-info'
  const resolvedId = '\0' + virtualId   // \0 前綴是慣例:標記「這是虛擬模組」,別的 plugin 就不會來搶
  let info                              // 跨 hook 共用的狀態(呼應 7.2 的 resolvedConfig 手法)

  return {
    name: 'build-info',

    configResolved(config) {
      // 設定定案後,把要用的資訊「一次算好、存起來」,後面幾個 hook 都會用到
      info = {
        mode: config.mode,              // 'development' / 'production' / 自訂
        command: config.command,        // 'serve' / 'build'
        buildTime: new Date().toISOString(),
      }
    },

    resolveId(id) {
      // 有人 import 'virtual:build-info' 時,我認領它,回傳帶 \0 的 id
      if (id === virtualId) return resolvedId
    },

    load(id) {
      // 認領的 id 被載入時,現場「生」一段 JS 原始碼當作這個模組的內容
      if (id === resolvedId) {
        return `export default ${JSON.stringify(info)}`
      }
    },

    transformIndexHtml(html) {
      // 順手把建置時間寫進 HTML 的 meta,線上用「檢視原始碼」就能看出是哪次建的
      return {
        html,
        tags: [
          { tag: 'meta', attrs: { name: 'build-time', content: info.buildTime }, injectTo: 'head' },
        ],
      }
    },
  }
}
```

用起來就像一個真的模組:

```js
// 你的前端程式碼裡
import info from 'virtual:build-info'
console.log(`模式:${info.mode},建置時間:${info.buildTime}`)
```

> **這個範例串起了什麼**:`resolveId` + `load` 是第 06 章的「虛擬模組」(內容用生的,不是讀檔);`configResolved` 是第 07 章的「讀最終設定」;`transformIndexHtml` 是第 07 章的「改 HTML」。一個 plugin 同時碰了模組、設定、HTML 三個面向——這就是骨架被填滿的樣子。
> (小提醒:TypeScript 專案 import 虛擬模組會報型別錯,需另外 `declare module 'virtual:build-info'`,這屬於型別宣告範疇,先略過。)

### 範例二:物件式 Mock Server(`apply` + `configureServer`)

**要解決的問題**:7.3 教的 mock 是「一個路徑寫一段」,實務上我希望**傳一個物件進來就自動生出多條 mock 路由**,而且這東西**只在 dev 需要**、build 完全用不到。

```js
function mockPlugin(mocks = {}) {
  return {
    name: 'simple-mock',
    apply: 'serve',        // 關鍵:mock 只在 dev 有意義,build 時這個 plugin 直接不啟用(7.7)

    configureServer(server) {
      // mocks 例如:{ '/api/user': {...}, '/api/todos': [...] }
      for (const [path, data] of Object.entries(mocks)) {
        // 每條路徑掛一個中介層。直接寫在這裡 → 排在 Vite 內建中介層「之前」(7.3),
        // 這樣才能搶在 SPA fallback 把 /api/... 回成 index.html 之前先回假資料。
        server.middlewares.use(path, (req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(data))
          // 沒呼叫 next() → 請求到我這裡就結束
        })
      }
    },
  }
}
```

在 `vite.config` 裡用,一次配好多條:

```js
export default {
  plugins: [
    mockPlugin({
      '/api/user': { id: 1, name: '小明' },
      '/api/todos': [{ id: 1, text: '學 Vite plugin' }],
    }),
  ],
}
```

> **這個範例串起了什麼**:`configureServer` 是第 07 章 dev server 的核心用法(掛中介層、放前面攔截);`apply: 'serve'` 把它限制在 dev,避免 build 時做無意義的事(7.7 的正確性理由)。真實的 mock plugin(如 `vite-plugin-mock`)差別只在於:它會去掃一個 `mock/` 資料夾、支援不同 HTTP 方法、還能配合 `handleHotUpdate` 讓你改 mock 檔不用重啟——但骨幹就是這兩個 hook。

### 範例三:極簡 Markdown loader(`enforce` + `transform` + `handleHotUpdate`)

**要解決的問題**:我想 `import` 一個 `.md` 檔,直接拿到渲染好的 HTML 字串。這需要把非 JS 的內容「轉成 JS 模組」——第 06 章的 `transform`;再配第 07 章的 `handleHotUpdate` 決定改檔時怎麼熱更新。

```js
function miniMarkdownPlugin() {
  return {
    name: 'mini-markdown',
    enforce: 'pre',        // 搶在別人之前認領 .md,否則可能先被當成未知檔案處理掉(7.6)

    transform(code, id) {
      if (!id.endsWith('.md')) return    // 只處理 .md,其它一律放行(回傳 undefined = 不動它)

      // 極簡「渲染」:# 開頭當標題,其餘當段落(真實會用 markdown-it 之類的函式庫)
      const html = code
        .split('\n')
        .map(line => line.startsWith('# ')
          ? `<h1>${line.slice(2)}</h1>`
          : `<p>${line}</p>`)
        .join('\n')

      // 回傳一個 JS 模組:預設匯出這段 HTML 字串
      return {
        code: `export default ${JSON.stringify(html)}`,
        map: { mappings: '' },   // 整段都是新生成的,沒有可對應的位置 → 明確表示「不提供 source map」(第 06 章)
      }
    },

    handleHotUpdate(ctx) {
      if (ctx.file.endsWith('.md')) {
        // 我們產出的 .md 模組不好做「精準」HMR,乾脆整頁重載最單純可靠(7.5)
        ctx.server.ws.send({ type: 'full-reload' })
        return []           // 回空陣列 = 「我處理掉了,Vite 別再走預設 HMR」
      }
      // 不是 .md 就不回傳 → 交還給 Vite 走預設流程
    },
  }
}
```

用起來:

```js
import readme from './README.md'
document.querySelector('#app').innerHTML = readme
```

> **這個範例串起了什麼**:`transform` 是第 06 章「改/生模組內容」的核心;`enforce: 'pre'` 確保我先看到原始 `.md`(7.6 順序);`handleHotUpdate` 是第 07 章的 HMR 客製——這裡示範了「我知道自己做不到精準熱更新,就主動選整頁重載」的實務判斷(回扣第 05 章「找不到邊界就整頁重載」)。

> **看完三個範例,回頭再看 7.8 的骨架**:你會發現每個真實 plugin 都只是「從骨架挑幾個 hook 填上內容」。沒有哪個 plugin 會用滿全部——挑對 hook,才是寫 plugin 的關鍵。

---

## 7.9 本章小結與下一步

這一章補完了 plugin 系統的另一半——Vite 專屬能力:

- **為何需要專屬 hook**:Rollup 只管模組/打包,不懂 dev server、HTML、HMR,所以 Vite 額外加了一組。
- **`config` / `configResolved`**:前者「定案前修改設定」,後者「定案後讀取最終設定」。
- **`configureServer`**:操作 dev server 加中介層,**做 mock API**、自訂端點;`return () => {}` 控制排在 Vite 中介層前或後(後面的中介層會看到所有頁面請求,處理不了一定要 `next()`)。
- **`transformIndexHtml`**:改 HTML 入口(注入腳本、meta),因為 Rollup 不管 HTML。
- **`handleHotUpdate` / `hotUpdate`**:自訂 HMR 行為,揭曉第 05 章「框架感知熱更新」的實作位置;Vite 6 起建議用依環境呼叫的 `hotUpdate`。
- **`enforce`(順序)**:`pre` 在 Vite 核心轉換之前、不寫在核心之後、`post` 殿後;只想調單一 hook 就用 `order`。
- **`apply`(階段)**:限定 plugin 只在 `serve` 或 `build` 啟用,避免無謂運作與 dev / build 兩條路徑的衝突。

**下一章(08)**,我們離開 dev,正式進入**生產建構**:`vite build` 到底做了什麼?tree shaking 怎麼砍掉沒用到的程式碼?code splitting 怎麼自動拆出 chunk、`import()` 動態載入怎麼運作?那些 hash 檔名(第 01、04 章一直提到的)的完整故事?以及怎麼分析、優化你的產物體積。這是讓你的應用「上線跑得快」的關鍵一章。

> 💡 **動手作業**:① 用 `configureServer` 在你的專案做一個 `/api/hello` 的 mock,前端 `fetch` 它拿到假資料,體會「前端先行」。② 寫兩個都有 `transform` 的 plugin,一個 `enforce: 'pre'`、一個不寫,在 transform 裡 `console.log` 出 id,觀察執行順序,印證 7.6 的規則。
