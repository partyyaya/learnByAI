# 第 11 章:Capstone —— 手寫一個 mini-vite

> 第 05 章結尾說過:第 02~05 章學的機制,剛好就是手寫 mini-vite 需要的全部。
> 現在我們兌現它——用大約幾百行程式碼,把 **dev server + 原生 ESM + 即時轉譯 + 依賴預打包 + HMR** 親手實作一遍。
> 目標不是做出能取代 Vite 的東西,而是讓你的理解從「看懂」升級到「做得出來」。
> 做完這章,Vite 對你不再有任何「魔法」——你會知道每一步背後到底發生了什麼。

---

## 11.1 我們要做什麼:範圍與心法

先設定務實的範圍。一個完整的 Vite 有上萬行程式碼,我們不做全部,只實作「最能體現核心原理」的部分:

| 功能 | 對應章節 | 我們做到什麼程度 |
|------|---------|-----------------|
| dev server + HTML 入口 | 01、02 | ✅ 起一個 server,回 index.html、注入 client |
| 攔截模組請求、即時轉譯 TS | 02、04 | ✅ 用 esbuild 把 .ts 轉成 JS |
| 改寫裸匯入(bare import) | 02、03 | ✅ 把 `import 'xxx'` 改寫成可解析路徑 |
| 依賴預打包 | 03 | ✅ 用 esbuild 把依賴打包到快取目錄 |
| HMR | 05 | ✅ WebSocket + 檔案監看 + 簡易 accept |

**心法**:我們會「逐步長出」這個工具——先讓最基本的能跑,再一層層加功能。每加一層,都對應回前面某一章。建議你**邊讀邊真的把 code 打出來跑**,卡住的地方就回去複習對應章節。

---

## 11.2 專案初始化

先建一個專案來「被 mini-vite 服務」,以及 mini-vite 本身。

```bash
mkdir mini-vite-demo && cd mini-vite-demo
npm init -y
npm install esbuild ws         # esbuild:轉譯/預打包;ws:WebSocket(HMR 用)
npm install vue                # 裝一個依賴,用來示範「裸匯入 + 預打包」
```

在 `package.json` 加上 `"type": "module"`(讓我們的 mini-vite 能用 ESM 語法寫):

```json
{
  "type": "module",
  "scripts": {
    "dev": "node mini-vite.js"
  }
}
```

建立「被服務的範例專案」:

```
mini-vite-demo/
├── mini-vite.js          ← 我們的 mini-vite(主角)
├── index.html            ← 入口(第 01 章:HTML 是入口)
└── src/
    ├── main.ts
    └── counter.ts
```

```html
<!-- index.html -->
<!doctype html>
<html>
  <head><title>mini-vite</title></head>
  <body>
    <div id="app"></div>
    <button id="btn">count: 0</button>
    <!-- 第 01 章:type="module" + 直接寫 .ts -->
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

```ts
// src/main.ts
import { setupCounter } from './counter.ts'
// 故意 import 一個第三方依賴,示範裸匯入改寫 + 預打包(這裡只 import 不真的用,專注機制)
import { ref } from 'vue'

console.log('vue 的 ref 載入成功:', typeof ref)
setupCounter(document.querySelector('#btn'))
```

```ts
// src/counter.ts
export function setupCounter(el: HTMLButtonElement) {
  let count = 0
  const set = (n: number) => {
    count = n
    el.textContent = `count: ${count}`
  }
  el.addEventListener('click', () => set(count + 1))
  set(0)
}
```

---

## 11.3 第一步:最基本的 dev server(回應 index.html)

先做最小的事:起一個 HTTP server,訪問 `/` 回傳 `index.html`。

```js
// mini-vite.js
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()        // 專案根目錄

const server = http.createServer(async (req, res) => {
  const url = req.url

  // 處理首頁:回傳 index.html
  if (url === '/' || url === '/index.html') {
    let html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
    res.setHeader('Content-Type', 'text/html')
    res.end(html)
    return
  }

  res.statusCode = 404
  res.end('Not Found')
})

server.listen(3000, () => {
  console.log('mini-vite running at http://localhost:3000')
})
```

跑 `npm run dev`,開 `http://localhost:3000`——你會看到頁面,但 **Console 報錯**:瀏覽器去抓 `/src/main.ts`,我們還沒處理它(404),而且就算回傳了,瀏覽器也看不懂 TS。

> **這正是第 02 章的「障礙 1」**:瀏覽器看不懂 .ts。下一步解決它。

---

## 11.4 第二步:攔截模組請求,用 esbuild 即時轉譯(第 02、04 章)

加上「攔截對 `.ts` 的請求,讀檔 → esbuild 轉譯 → 回傳 JS」。

```js
import { transform } from 'esbuild'

// ...在 createServer 的 callback 裡,首頁處理之後、404 之前,加上:

// 處理 JS/TS 模組請求
if (url.endsWith('.ts') || url.endsWith('.js')) {
  const filePath = path.join(root, url)         // /src/main.ts → 絕對路徑
  let code = fs.readFileSync(filePath, 'utf-8')

  // 第 04 章:用 esbuild 把 TS 剝型別、轉成 JS(只轉譯,不檢查型別!)
  const result = await transform(code, {
    loader: 'ts',
    format: 'esm',         // 輸出 ESM,瀏覽器才能原生跑
  })
  code = result.code

  // ⭐ 關鍵:改寫裸匯入(下一步詳解),先留個 hook
  code = await rewriteImports(code)

  res.setHeader('Content-Type', 'application/javascript')   // 一定要是這個 MIME!
  res.end(code)
  return
}
```

**逐點解釋**:

- `transform(code, { loader: 'ts' })`:這就是第 04 章「esbuild 剝型別」的真身。它**只轉譯不檢查型別**——你現在親手見證了第 01、04 章那句「Vite dev 不檢查型別」是怎麼回事:因為我們呼叫的就是個純轉譯函式。
- `Content-Type: application/javascript`:**極重要**。瀏覽器靠這個 header 決定「要不要把回應當 ES module 執行」。MIME 錯了,瀏覽器會拒絕執行 module,報 `Failed to load module script` 之類的錯。
- `format: 'esm'`:確保輸出是 `import`/`export` 形式,瀏覽器原生 ESM 才吃得下(第 02 章)。

現在 `main.ts` 能被轉成 JS 回傳了。但瀏覽器執行它時,遇到 `import { ref } from 'vue'`——**裸匯入**,瀏覽器不知道 `vue` 在哪(第 02 章障礙 2)。下一步。

---

## 11.5 第三步:改寫裸匯入 + 依賴預打包(第 02、03 章)

這是把第 02、03 兩章合起來的關鍵一步。我們要:

1. **預打包**:啟動時,用 esbuild 把 `vue` 打包成一個檔,放到快取目錄。
2. **改寫**:把程式裡的 `import ... from 'vue'` 改寫成指向那個快取檔的路徑。

### 3a. 依賴預打包(第 03 章)

```js
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const CACHE_DIR = path.join(root, 'node_modules', '.mini-vite')

// 啟動時預打包指定依賴(真實 Vite 會自動掃描,我們簡化成寫死清單)
async function preBundle(deps) {
  console.log('Pre-bundling dependencies:', deps.join(', '))   // 第 03 章那行訊息!
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  for (const dep of deps) {
    await build({
      entryPoints: [dep],                       // 從這個依賴的入口開始
      bundle: true,                             // ⭐ 把它內部幾百個模組打包成一個(第 03 章核心)
      format: 'esm',                            // 輸出 ESM
      outfile: path.join(CACHE_DIR, `${dep}.js`),
      // esbuild 會自己去 node_modules 找 dep、解析它的 CJS/ESM、打包成單檔
    })
  }
  console.log('依賴預打包完成 →', CACHE_DIR)
}
```

**這幾行就是第 03 章的全部精華**:`bundle: true` 讓 esbuild 把 `vue` 內部那些互相 import 的小模組**併成一個 `vue.js`**,放進 `node_modules/.mini-vite/`(對應真實 Vite 的 `.vite/deps`)。這同時解決了「CJS→ESM 轉換」和「請求爆炸」兩個問題(第 03 章的兩大職責)。

### 3b. 改寫裸匯入(第 02 章障礙 2)

```js
// 把 import ... from 'vue' 改寫成 import ... from '/@modules/vue'
async function rewriteImports(code) {
  // 用簡易正則找出 from '...' 的部分(真實 Vite 用 es-module-lexer 精準解析,這裡簡化)
  return code.replace(
    /from\s+['"]([^'"]+)['"]/g,
    (full, source) => {
      // 判斷是不是「裸匯入」(不以 / . 開頭)
      if (!source.startsWith('.') && !source.startsWith('/')) {
        // 裸匯入 → 改寫成特殊前綴路徑,等等用這個路徑去拿預打包產物
        return `from '/@modules/${source}'`
      }
      // 相對路徑維持原樣(瀏覽器自己抓得到),但補上副檔名等細節可在此處理
      return full
    }
  )
}
```

### 3c. 處理 `/@modules/xxx` 請求 → 回傳預打包產物

改寫後,瀏覽器會去抓 `/@modules/vue`。我們攔截它,回傳 3a 打包好的檔:

```js
// 在 server callback 裡加上:
if (url.startsWith('/@modules/')) {
  const dep = url.slice('/@modules/'.length)         // 取出 'vue'
  const filePath = path.join(CACHE_DIR, `${dep}.js`) // 預打包產物
  const code = fs.readFileSync(filePath, 'utf-8')
  res.setHeader('Content-Type', 'application/javascript')
  res.end(code)
  return
}
```

### 串起來:啟動時先預打包

```js
// 啟動流程改成:
await preBundle(['vue'])         // 先預打包(第 03 章)
server.listen(3000, () => { /* ... */ })
```

**現在完整跑通了**:打開頁面 → 抓 main.ts(轉譯+改寫)→ 瀏覽器抓 counter.ts(轉譯)和 `/@modules/vue`(預打包產物)→ Console 印出「vue 的 ref 載入成功」,按鈕也能點擊計數。

> 🎯 **停下來體會**:你剛剛親手實作了第 02、03、04 章的全部核心。打開瀏覽器 Network 面板(第 02 章教的),你會看到跟真實 Vite **一模一樣的請求模式**:一個個 .ts 被分別請求、內容是轉譯後的 JS、`vue` 變成一個 `/@modules/vue` 請求。你做出了一個 No-bundle dev server。

---

## 11.6 第四步:加上 HMR(第 05 章)

最後一塊,也是最精彩的——熱更新。回憶第 05 章的三個要素:**WebSocket 連線、檔案監看、`@vite/client` + `import.meta.hot.accept`**。我們逐一實作。

### 4a. 注入 client 程式 + 建立 WebSocket server

先在回傳 `index.html` 時,注入一段 client script(對應第 02、05 章的 `@vite/client`):

```js
// 修改首頁處理:在 html 裡注入 client
if (url === '/' || url === '/index.html') {
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
  // 注入我們的 HMR client(下面 4c 會提供 /@mini-vite/client 的內容)
  html = html.replace('<head>', `<head>\n<script type="module" src="/@mini-vite/client"></script>`)
  res.setHeader('Content-Type', 'text/html')
  res.end(html)
  return
}
```

建立 WebSocket server(第 05 章:伺服器要能主動推訊息給瀏覽器):

```js
import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({ server })    // 掛在同一個 http server 上
wss.on('connection', (socket) => {
  console.log('HMR client 已連線')
})

// 一個工具:廣播訊息給所有連線的瀏覽器
function broadcast(payload) {
  const data = JSON.stringify(payload)
  wss.clients.forEach((c) => c.send(data))
}
```

### 4b. 監看檔案變動,推送 HMR 訊息

```js
// 監看 src 目錄的檔案變動(真實 Vite 用 chokidar,Node 內建 fs.watch 也夠示範)
fs.watch(path.join(root, 'src'), { recursive: true }, (event, filename) => {
  if (!filename) return
  const modulePath = '/src/' + filename.replace(/\\/g, '/')
  console.log('檔案變動:', modulePath)

  // 第 05 章:透過 WebSocket 通知瀏覽器「這個模組更新了」
  broadcast({
    type: 'update',
    path: modulePath,
    timestamp: Date.now(),        // 時間戳,用來破快取(第 03、05 章的 ?t= 概念)
  })
})
```

### 4c. client 端:接收訊息、重抓模組、套用更新

提供 `/@mini-vite/client` 的內容(這就是我們版本的 `@vite/client`):

```js
// 在 server callback 裡加上對 client 的回應:
if (url === '/@mini-vite/client') {
  res.setHeader('Content-Type', 'application/javascript')
  res.end(clientScript)         // clientScript 內容見下
  return
}
```

```js
// clientScript 的內容(字串形式,直接吐給瀏覽器當 module 跑)
const clientScript = `
// 連上 dev server 的 WebSocket(第 05 章:client 的核心職責)
const ws = new WebSocket('ws://localhost:3000')

// 存放每個模組註冊的 accept callback(第 05 章:HMR 邊界)
const hotModules = new Map()

ws.addEventListener('message', async ({ data }) => {
  const payload = JSON.parse(data)
  if (payload.type === 'update') {
    const mod = hotModules.get(payload.path)
    if (mod) {
      // 有人 accept 了這個模組 → 重新 import 新版(加 ?t= 破快取),呼叫 callback
      const newModule = await import(payload.path + '?t=' + payload.timestamp)
      mod.callback(newModule)
      console.log('[mini-vite] hot updated:', payload.path)
    } else {
      // 沒人 accept → 找不到邊界 → 整頁重載(第 05 章的 fallback!)
      location.reload()
    }
  }
})

// 提供給模組使用的 createHotContext,對應 import.meta.hot
export function createHotContext(modulePath) {
  return {
    accept(callback) {
      hotModules.set(modulePath, { callback })   // 註冊:我這個模組能接住更新 → 成為 HMR 邊界
    },
  }
}
`
```

### 4d. 把 `import.meta.hot` 注入到使用者模組

真實 Vite 會把 `import.meta.hot` 注入每個模組。我們簡化:在轉譯模組時,於開頭注入一個 hot context。修改 11.4 的模組處理:

```js
if (url.endsWith('.ts') || url.endsWith('.js')) {
  // ...前面的讀檔、esbuild transform、rewriteImports...

  // 在模組頂部注入 hot context(讓使用者能用 import.meta.hot.accept)
  const cleanUrl = url.split('?')[0]      // 去掉 ?t=xxx
  const hotHeader = `
    import { createHotContext as __vite_createHotContext } from '/@mini-vite/client'
    import.meta.hot = __vite_createHotContext('${cleanUrl}')
  `
  code = hotHeader + code

  res.setHeader('Content-Type', 'application/javascript')
  res.end(code)
  return
}
```

### 4e. 在使用者程式裡用 HMR

現在 `counter.ts` 可以這樣宣告自己是 HMR 邊界(第 05 章的 `accept`):

```ts
// src/counter.ts 末尾加上:
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    // 模組更新時,用新版重新初始化,不整頁刷新(第 05 章)
    newModule.setupCounter(document.querySelector('#btn'))
  })
}
```

**跑跑看**:改 `counter.ts` 裡的文字(例如 `count:` 改成 `次數:`),存檔——瀏覽器**不整頁刷新**就更新了!如果你改的是「沒有 accept」的檔(例如 main.ts 沒寫 accept),則會看到整頁重載。**這完全複現了第 05 章「有邊界就 HMR、沒邊界就整頁重載」的行為。**

> 🎯 **這就是 HMR 的全貌**:WebSocket 推訊息(4a/4b)→ client 收到後重抓新模組(4c)→ 呼叫使用者註冊的 accept callback(4d/4e)→ 局部更新、頁面不重載。你親手把第 05 章那張「從存檔到畫面更新」的流程圖變成了能跑的程式碼。

---

## 11.7 完整骨架回顧

把四步串起來,mini-vite 的骨架是:

```
啟動
  └─ preBundle(['vue'])                    第 03 章:預打包依賴到 .mini-vite/
  └─ http server.listen(3000)
  └─ WebSocketServer(HMR 通道)              第 05 章

每個請求進來:
  ├─ '/' 或 '/index.html'  → 回 html + 注入 client      第 01、02、05 章
  ├─ '/@mini-vite/client'  → 回 HMR client 程式          第 05 章
  ├─ '/@modules/xxx'       → 回預打包產物                第 02、03 章
  └─ '*.ts / *.js'         → 讀檔 → esbuild 轉譯 →        第 02、04 章
                             改寫裸匯入 → 注入 hot →        第 02、05 章
                             回傳 JS

檔案變動(fs.watch):
  └─ broadcast({ type: 'update', path, timestamp })      第 05 章
       └─ client 收到 → 有 accept 就 HMR、沒有就 reload
```

**對照真實 Vite,我們省略了什麼**(這也是真實 Vite 複雜度的來源,值得知道):

- **module graph**:我們沒建依賴圖,所以 HMR 沒辦法「沿 importers 往上找邊界」(第 05 章),只做了「模組自己 accept」的最簡版。真實 Vite 會精準計算更新邊界。
- **plugin 系統**:我們把轉譯寫死了,沒有第 06、07 章的 `resolveId/load/transform` 可擴充架構。
- **精準的 import 解析**:我們用正則改寫,真實 Vite 用 `es-module-lexer` 精準解析,能處理各種邊角情況。
- **CSS、靜態資源、各種 import 字尾**(第 04 章)、**生產建構**(第 08 章)、**快取的失效判斷**(第 03 章)等等,我們都沒做。

> **但這不減損價值**:我們做的這幾百行,正是 Vite「**為什麼能不打包還跑得起來**」的最小完整骨架。你現在理解的,是 Vite 的「心臟」。其餘的都是在這顆心臟上長出的器官。

---

## 11.8 延伸挑戰(給想更進一步的你)

如果你想把 mini-vite 變得更像真的,這些是好的下一步練習,每個都對應一章:

1. **加一個極簡 plugin 系統**(第 06、07 章):把「轉譯」改成一串 `transform` hook,讓功能可插拔。試著把「TS 轉譯」「裸匯入改寫」都變成 plugin。
2. **建立 module graph**(第 05 章):記錄「誰 import 誰」,讓 HMR 能沿 importers 往上找邊界,而不只是「自己 accept」。
3. **支援 CSS**(第 04 章):攔截 `.css` 請求,把它包成「建立 `<style>` 注入」的 JS 模組,並加上 CSS 的 HMR(換 `<style>` 內容)。
4. **自動掃描依賴**(第 03 章):不要寫死 `['vue']`,而是掃描原始碼裡的裸匯入,自動決定要預打包哪些。
5. **加快取失效判斷**(第 03 章):記錄 `package.json`/lockfile 的指紋,沒變就跳過預打包。

> 做完任何一個,你對對應章節的理解都會再深一層。這就是「手寫」的價值——它逼你面對所有「看書時以為懂、其實沒想清楚」的細節。

---

## 11.9 課程總結

恭喜你走到這裡。回顧整門課,你從「為什麼前端需要建構工具」一路走到「親手實作一個 mini-vite」:

- **第 00 章**:建構工具演進史、CJS vs ESM、「dev 不打包 + build 用 Rollup」的雙引擎心智模型。
- **第 01 章**:專案結構、`index.html` 是入口、dev/build/preview 的差別。
- **第 02 章**:No-bundle dev server——瀏覽器原生 ESM 是一切的根基。
- **第 03 章**:依賴預打包——用 esbuild 解決 CJS 相容與請求爆炸。
- **第 04 章**:轉換管線——各種資源如何即時變成 JS 模組。
- **第 05 章**:HMR——module graph、邊界、`import.meta.hot` 的精妙設計。
- **第 06、07 章**:Plugin 系統——Vite 的能力幾乎都是 plugin,小核心 + 大生態。
- **第 08 章**:生產建構——tree shaking、code splitting、hash 快取的完整故事。
- **第 09 章**:進階場景——SSR、Library Mode、MPA、Monorepo。
- **第 10 章**:引擎內幕與 Rolldown——雙引擎的代價與 Rust 化的未來。
- **第 11 章**:把 02~05 章親手實作成 mini-vite。

但這門課真正想留給你的,不是這些功能的用法(它們會隨版本變),而是**第 10 章那個判斷框架**:面對任何工具,問「它解決了什麼痛、帶來什麼新代價、什麼場景不划算」。Vite 會演進、Rolldown 會成為主流、未來還會有新工具——但你建立的這套「看穿工具設計取捨」的能力,會一直有用。

> 💡 **最後的作業**:把你的 mini-vite 完整跑通(11.3~11.6),然後挑 11.8 的任一個延伸挑戰做做看。當你能對著自己寫的 mini-vite,清楚講出「這一行對應 Vite 的哪個機制、為什麼這樣設計」,你就真正從「會用 Vite 的人」變成了「懂 Vite 的人」。這正是本課程的終點,也是你下一段學習的起點。
