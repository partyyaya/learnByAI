# 第 08 章:生產建構與 Rollup

> 前七章幾乎都在講 dev。現在切換到另一套引擎:`vite build`。
> 第 00 章說「dev 不打包、build 用 Rollup 認真打包」,這一章就把「認真打包」拆開:
> 為什麼 build 要打包?tree shaking 怎麼砍死碼?code splitting 怎麼拆 chunk?
> `import()` 動態載入是什麼?那些 hash 檔名(前面一直提)的完整故事?
> 以及怎麼分析、優化產物體積。這是讓應用「上線跑得快」的關鍵章。

---

## 8.1 先回答:為什麼 dev 不打包,build 卻一定要打包?

這是貫穿全課的核心問題,到這章必須給出完整答案。第 02 章講過「dev 不打包能快」,那為什麼 build 不能也不打包、直接把原始的 ESM 丟上線?

因為**生產環境的需求跟開發環境完全相反**:

| 面向 | dev(開發) | production(上線) |
|------|-----------|-------------------|
| 誰在用 | 你自己,本機 | 全世界使用者,各種網路/瀏覽器 |
| 在意什麼 | 啟動快、改動即時 | 載入快、體積小、相容性、快取 |
| 模組數量 | 不打包 → 幾百個請求,本機可接受 | 不打包 → 使用者要發幾百個跨網路請求,災難 |
| 能接受未壓縮嗎 | 可以(本機不在乎流量) | 不行(使用者要下載,越小越好) |
| 需要相容舊瀏覽器嗎 | 不用(你用新版 Chrome) | 可能要(使用者瀏覽器五花八門) |

具體說,如果上線不打包:

1. **請求瀑布災難**(第 02 章的代價,在跨網路時放大百倍):使用者要對你的伺服器發幾百個 HTTP 請求,每個都有網路延遲,頁面慢到不行。
2. **沒壓縮**:原始碼有註解、長變數名、空白,體積大,使用者下載久。
3. **沒移除廢碼**:你 import 了一個大套件卻只用一個函式,整包都送給使用者。
4. **相容性**:你寫的新語法在舊瀏覽器跑不動。

**所以 build 必須打包**:把幾百個模組合併成少數幾個檔、壓縮、砍廢碼、處理相容性。這件事交給成熟的 **Rollup**。

> **回扣第 00 章的雙引擎**:dev 服務「開發者體驗」(快、即時),build 服務「終端使用者體驗」(小、快、穩)。兩者目標相反,所以用兩套引擎,各自最佳化。`vite build` = 啟動 Rollup 這套引擎。

---

## 8.2 `vite build` 的完整流程

執行 `npm run build`(`tsc && vite build`),Rollup 階段大致做這些事:

```
① 從入口開始(index.html → 裡面的 <script>)
        ↓
② 建立完整的 module graph(把整棵依賴樹爬完——這次是「全部」,不像 dev 按需)
        ↓
③ 跑所有 plugin 的 transform(第 06 章:TS→JS、CSS 處理...)
        ↓
④ Tree shaking:分析誰真的被用到,砍掉沒用到的程式碼(8.3)
        ↓
⑤ Code splitting:把程式碼切成多個 chunk(8.4)
        ↓
⑥ 壓縮(minify):移除空白、縮短變數名、刪註解(8.6)
        ↓
⑦ 產生帶 hash 的檔名,輸出到 dist/(8.5)
        ↓
⑧ 處理 index.html:把 <script src="/src/main.ts"> 換成打包後的真實檔名
```

注意步驟 ②:**build 時 Rollup 會把整棵依賴樹「全部」爬完**,這跟 dev 的「按需只處理當下要的」完全不同。這也是為什麼 build 比 dev 啟動慢——它真的在做完整的打包工作。

---

## 8.3 Tree Shaking:搖掉沒用到的程式碼

「Tree shaking」(搖樹)是個比喻:把程式碼想成一棵樹,搖一搖,枯掉的葉子(沒用到的程式碼)就掉下來被丟掉。

### 它在做什麼

```js
// utils.js —— 匯出三個函式
export function used() { return 'A' }
export function notUsed1() { return 'B' }     // 沒人用
export function notUsed2() { return 'C' }     // 沒人用

// main.js —— 只 import 了一個
import { used } from './utils.js'
console.log(used())
```

Tree shaking 後,`notUsed1` 和 `notUsed2` **完全不會進入最終 bundle**。只有 `used` 被留下。

### 為什麼 ESM 能做 tree shaking,而 CommonJS 很難?

這裡兌現第 00 章最重要的伏筆之一。回憶:

- **ESM 是靜態結構**:`import { used }` 寫死在頂層,Rollup 光「讀」就能 100% 確定「只有 `used` 被用到」。於是它能放心砍掉其他匯出。
- **CommonJS 是動態的**:`const x = require('./utils')` 然後 `x[someVariable]()`——到底用了哪個?要執行才知道。Rollup 不敢亂砍(砍錯就壞了),所以 CJS 的 tree shaking 效果差很多。

> **這就是為什麼套件作者都推薦提供 ESM 版本**(像 `lodash-es` 而非 `lodash`):ESM 的靜態特性讓 tree shaking 生效,使用者只會打包到真正用到的部分。
> **「用 `lodash-es` 而非 `lodash`」這個老生常談的建議,根源就在這裡。**

### 你會踩的坑:副作用(side effects)

Tree shaking 有個前提:Rollup 必須確定「砍掉這段碼是安全的」。但有些模組**光是被 import 就會產生副作用**(例如執行了某些全域設定、注入了 polyfill):

```js
// 這個檔被 import 時,即使你沒用它的任何匯出,它頂層的程式碼也會執行
import './polyfill.js'        // 它修改了全域,有副作用!不能砍
```

Rollup 預設會保留可能有副作用的程式碼(保守、安全)。套件可以在 `package.json` 用 `"sideEffects": false` 告訴打包器「我這個套件沒有副作用,放心砍」:

```json
{
  "name": "my-lib",
  "sideEffects": false
}
```

> **常見錯誤**:「我明明只 import 一個函式,為什麼整個套件都被打包進來?」可能就是該套件沒標 `sideEffects: false`,Rollup 不敢砍。或是該套件是 CJS、無法 tree shaking。**體積異常時,先查這兩點。**

---

## 8.4 Code Splitting:把程式碼拆成多個 chunk

如果把所有東西打包成「一個」巨大的 JS 檔,會有問題:

- 使用者第一次載入就要下載**全部**程式碼,即使首頁只用到其中一小部分。
- 改一行 code,整個大檔的 hash 就變,使用者要重新下載全部(快取全失效)。

**Code splitting(程式碼分割)** 就是把程式碼拆成多個較小的 **chunk**(程式碼塊),按需載入、獨立快取。Vite/Rollup 會自動做一部分,你也能手動控制。

### 自動分割 1:動態 import(`import()`)—— 最重要的分割手段

第 00~05 章我們用的都是**靜態 import**(`import x from 'y'`,寫在頂層、一定會載入)。還有一種**動態 import**:

```js
// 靜態 import:打包時就決定、一定載入
import { heavy } from './heavy.js'

// 動態 import:回傳一個 Promise,「執行到這一行時」才去載入
button.addEventListener('click', async () => {
  // 使用者點按鈕,才載入 heavy.js
  const { heavy } = await import('./heavy.js')
  heavy()
})
```

**Rollup 看到 `import()`,會自動把 `heavy.js` 切成一個獨立 chunk**,並產生「執行到才去抓」的載入邏輯。

**為什麼這超級重要?** 這叫**懶載入(lazy loading)/ 按需載入**。最經典的應用是「**路由層級的分割**」:

```js
// 路由設定:每個頁面用動態 import,各自成為獨立 chunk
const routes = [
  { path: '/', component: () => import('./pages/Home.vue') },
  { path: '/admin', component: () => import('./pages/Admin.vue') },  // 後台頁很大
]
```

效果:使用者進首頁,**只下載首頁的 chunk**;只有真的點進 `/admin`,才下載後台那包(可能很大)的 chunk。**首屏載入因此大幅變快**——使用者不必為「他還沒去的頁面」付下載成本。

> **心智模型**:靜態 import 是「現在就要,一起打包載入」;動態 import 是「之後可能要,先切出去、用到才載入」。把「大而不常用」的東西(後台、編輯器、圖表庫)用動態 import 切出去,是優化首屏最有效的招。

### 自動分割 2:第三方依賴(vendor chunk)

Vite 預設會傾向把 `node_modules` 的依賴跟你的原始碼**分開**打包。為什麼?

因為**你的程式碼天天改,但第三方依賴很少變**。把它們分開:

- 你改了業務碼 → 只有業務碼的 chunk 換 hash,依賴的 chunk hash 不變 → 使用者瀏覽器**繼續用快取的依賴**,只重新下載小小的業務碼。
- 如果混在一起 → 改一行業務碼,整包(含幾 MB 的依賴)hash 全變,使用者重下全部。

這跟 8.5 的 hash 機制是一套組合拳:**分割 + hash = 最大化快取命中率**。

### 手動控制分割:`manualChunks`

你也能精細控制怎麼分。例如把所有 `node_modules` 的東西歸到一個 `vendor` chunk:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // id 是模組路徑;回傳一個字串 = 「把這個模組丟進名為這個字串的 chunk」
          if (id.includes('node_modules')) {
            return 'vendor'        // 所有第三方 → vendor.js
          }
        },
      },
    },
  },
})
```

更進階可以把超大的庫單獨切開(例如 echarts、monaco 各自一包),避免單一 chunk 過大。

> **注意**:`rollupOptions` 就是「把設定直接傳給底層 Rollup」的逃生艙——表示這層已經是 Rollup 的設定地盤了,再次體現「build = Rollup」。

---

## 8.5 Hash 檔名:快取破壞的完整故事

前面好幾章(01、03、04)都提到「檔名加 hash」,這裡講完整。

### 現象

build 後的檔名長這樣:

```
dist/assets/
├── index-a1b2c3d4.js        ← 你的入口
├── vendor-e5f6g7h8.js       ← 第三方依賴
└── Admin-i9j0k1l2.js        ← 動態 import 切出來的後台 chunk
```

那串 `a1b2c3d4` 是**檔案內容的雜湊值(content hash)**。

### 為什麼要這樣做(快取破壞 cache busting)

問題的根源:**瀏覽器會快取靜態檔案**,而且為了效能,我們會叫瀏覽器「長時間強快取」JS/CSS。但這帶來矛盾:

- 不快取 → 每次都重下載,慢。
- 強快取但檔名固定(`index.js`)→ 你上線了新版,使用者瀏覽器還用舊快取,**看到舊版的 bug**。

**hash 檔名完美解決這個矛盾**:

```
內容沒變 → hash 不變 → 檔名不變 → 瀏覽器繼續用快取(快!)
內容變了 → hash 變了 → 檔名變了 → 瀏覽器視為新檔重新下載(拿到新版!)
```

於是你可以放心地對這些 hash 檔名設「永久強快取」,因為「內容一變檔名就變」這個機制保證使用者永遠不會用到過時的內容。

### 配合 splitting 的威力

把 8.4 和 8.5 合起來看:

```
你只改了業務碼:
  index-XXXX.js   → 內容變 → hash 變 → 使用者重下這個(很小)✅
  vendor-YYYY.js  → 內容沒變 → hash 不變 → 使用者用快取(省下幾 MB 下載)✅
```

**這就是現代前端的快取策略精髓**:把「常變的」和「不常變的」拆開,各自 hash,讓使用者每次更新只需下載「真正變動的那一小塊」。

> 那個 `index.html` 本身通常**不加 hash、不強快取**(因為它是入口,要能拿到最新的)。瀏覽器每次拿最新的 index.html,裡面寫著最新的 `index-XXXX.js` 檔名,順藤摸瓜就拿到對的版本。這是一條設計精巧的快取鏈。

### 「不強快取」是誰決定的?(不是瀏覽器預設)

這裡有個常見誤解要澄清:**要不要快取、快取多久,不是瀏覽器自己決定的,是「伺服器/CDN 回應時帶的 HTTP header」決定的**,由你(或部署平台)設定,瀏覽器只是照 header 行事。控制它的主要是 `Cache-Control`:

```
# 有 hash 的 JS/CSS(內容一變檔名就變)→ 放心永久強快取
Cache-Control: public, max-age=31536000, immutable

# index.html(入口)→ 不強快取,每次回來跟伺服器確認一下
Cache-Control: no-cache
```

這兩行都是**伺服器發的**。Vite `build` 只負責產出檔案,管不到「上線後 header 怎麼設」——那是 Nginx / Vercel / Netlify / Cloudflare 這一層的事。

**反直覺的重點**:如果你**什麼 header 都不設**,瀏覽器不會乖乖「每次拿最新」,它會用**啟發式快取(heuristic caching)**——依 `Last-Modified` 自己猜一個時間偷偷快取起來,結果反而可能讓使用者看到舊的 index.html。所以「index.html 不強快取」不是放著不管就會發生,而是要**明確設定**。

| header | 行為 |
|--------|------|
| `no-cache` | 還是會存,但每次用之前都要跟伺服器**驗證**(帶 ETag,沒變回 304,超小)。又新鮮又有效率,**通常首選** |
| `no-store` | 完全不存,每次重抓整份(較少用) |

> **`no-cache` 不是「不快取」**:它會快取,只是「每次用之前先問伺服器新不新」。真正「完全不存」的是 `no-store`——名字很容易搞反。

自架 Nginx 的話,這條快取鏈大概長這樣:

```nginx
# 有 hash 的資源:永久強快取
location /assets/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}

# 入口 HTML:不強快取,每次驗證
location = /index.html {
  add_header Cache-Control "no-cache";
}
```

> 像 Vercel、Netlify 這類平台**確實預設**幫你設好這條鏈(hashed 資源 `immutable`、index.html 不強快取),所以你可能沒設也正常——但那是**平台/伺服器的預設,不是瀏覽器的預設**。換成自架就得自己寫。

---

## 8.6 壓縮(Minify)與其他最佳化

### 壓縮

build 預設會壓縮 JS(Vite 預設用 esbuild 壓縮,因為快):

```js
// 壓縮前
function calculateTotalPrice(itemPrice, quantity) {
  const total = itemPrice * quantity
  return total          // 算總價
}

// 壓縮後(變數名縮短、空白註解全刪)
function c(a,b){return a*b}
```

效果:體積大幅縮小。可在設定調整:

```ts
export default defineConfig({
  build: {
    minify: 'esbuild',     // 預設,快;也可設 'terser'(更極致但較慢)或 false(不壓縮,debug 用)
  },
})
```

### CSS 也會被處理

第 04 章說過:dev 時 CSS 包成 JS 注入,**build 時抽成獨立 `.css` 檔**並壓縮、加 hash。這樣上線用 `<link>` 載入,避免「樣式閃一下」、也能獨立快取。

### 自動相容性處理

Vite build 預設會根據 `build.target` 把語法降級到目標瀏覽器能懂的程度。要支援很舊的瀏覽器(如 IE11),用官方的 `@vitejs/plugin-legacy`(第 06 章說過它是 plugin),它會額外產生 legacy 版本 + 注入 polyfill。

---

## 8.7 分析與優化產物體積

build 完,怎麼知道「哪個東西把包撐大了」?

### 看 build 輸出

`vite build` 結束時,終端機會列出每個 chunk 的大小:

```
dist/assets/index-a1b2c3d4.js     143.21 kB │ gzip: 46.32 kB
dist/assets/vendor-e5f6g7h8.js    512.88 kB │ gzip: 161.05 kB   ← 這個很大!
```

**重點看 `gzip` 後的大小**:因為伺服器傳輸時通常會 gzip 壓縮,gzip 後的數字才接近使用者「真正下載的量」。

### 用視覺化工具找肥肉

裝一個分析 plugin,把 bundle 組成畫成圖:

```bash
npm i -D rollup-plugin-visualizer
```

```ts
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  plugins: [
    visualizer({ open: true }),     // build 後自動開一張「誰佔了多少體積」的圖
  ],
})
```

它會產生一張方塊圖,一眼看出「哪個依賴佔最多體積」。常見的優化動作:

1. **發現某個大庫只用到一點點** → 換更小的替代品,或用動態 import 切出去。
2. **發現重複打包** → 某個依賴被打進好幾個 chunk,調整 `manualChunks`。
3. **發現該 tree shake 卻沒 shake** → 回去查 8.3 的 `sideEffects` / CJS 問題。
4. **發現首屏載入了不該載的大頁面** → 用動態 import 做路由懶載入(8.4)。

> **優化的正確順序**:先用工具「測量」(visualizer),找出真正的肥肉,再針對性優化。不要憑感覺亂優化——「過早優化是萬惡之源」,先量再改。

---

## 8.8 一個常見的真實問題:dev 正常,build 後白屏

這是 Vite 使用者最常遇到、也最能驗證你「真的懂雙引擎」的問題。串起前面所有章節來診斷:

**症狀**:`npm run dev` 一切正常,`npm run build` + `npm run preview` 後頁面白屏或報錯。

**為什麼會這樣?** 因為 dev 和 build 是兩套引擎(第 00 章),處理方式不同。常見原因:

| 原因 | 對應章節 | 怎麼查 |
|------|---------|--------|
| 依賴在 dev(esbuild 預打包)和 build(Rollup)行為不一致 | 第 03 章 | 看是不是某個 CJS 套件作怪 |
| 資源路徑寫死(沒用 import / public 用錯) | 第 04 章 | 檢查圖片、資源路徑 build 後對不對 |
| 部署的 base 路徑不對(子目錄部署) | 本章 8.9 | 設 `base` |
| 動態 import 的路徑 build 後對不上 | 本章 8.4 | 檢查動態 import 寫法 |
| 用了只在 dev 存在的東西(如 `import.meta.hot` 沒包 if) | 第 05 章 | build 時 `import.meta.hot` 是 undefined |

**正確的工作習慣**:`npm run preview` 是你的好朋友(第 01 章)。上線前一定先 `build` + `preview`,在本機就抓出這類「dev 沒事 build 出事」的問題,別等部署到正式環境才發現。

---

## 8.9 部署相關:`base` 路徑

最後一個實務必備設定。如果你的網站不是部署在網域根目錄,而是在子路徑(例如 `https://example.com/my-app/`),要設定 `base`:

```ts
export default defineConfig({
  // 所有資源的引用都會加上這個前綴
  base: '/my-app/',
})
```

**為什麼需要?** 因為 build 時產生的資源引用預設是 `/assets/index-xxx.js`(根路徑)。如果你部署在 `/my-app/` 子目錄下,瀏覽器會去 `https://example.com/assets/...` 找(找不到,白屏)。設了 `base: '/my-app/'`,引用就變成 `/my-app/assets/...`,才找得到。

> **這是「dev 正常 build 白屏」的高頻原因之一**(8.8 那張表),部署到子目錄卻忘了設 `base`。記住這個設定能省你很多除錯時間。

### 不確定會部署到哪?用相對路徑 `./`

上面的 `base: '/my-app/'` 有個前提:**你得事先知道部署路徑**。但有時你根本不知道——同一份產物可能被丟到根目錄、也可能丟到 `/a/`、`/b/c/` 任意子目錄。這時可以把 `base` 設成相對路徑:

```ts
export default defineConfig({
  base: './',   // 資源引用改用「相對路徑」,不寫死前綴
})
```

差別在產出的引用長相:

```
base: '/my-app/'  →  <script src="/my-app/assets/index-xxx.js">   (絕對,綁死路徑)
base: './'        →  <script src="./assets/index-xxx.js">          (相對,相對於 index.html)
```

因為 `./assets/...` 是**相對於 index.html 所在位置**去解析的,所以整個 `dist/` 資料夾你**丟到哪個子目錄都能跑**,不用改設定。適合:不確定部署路徑、純靜態 demo、打包成 Electron / 用 `file://` 開的場景。

> **但相對路徑有個坑,用 SPA 前端路由(history 模式)要小心**:假設使用者停在 `https://example.com/my-app/users/123` 按重新整理,伺服器回 index.html,但瀏覽器此時認定的「目前位置」是 `/my-app/users/`,於是 `./assets/...` 會被解析成 `/my-app/users/assets/...`(錯的,白屏)。**巢狀路由 + history 模式的 SPA,還是用絕對的 `base: '/my-app/'` 最穩**;`./` 比較適合沒有巢狀路由、或用 hash 路由(`/#/users/123`)的情況。

---

## 8.10 本章小結與下一步

這一章拆完了生產建構:

- **為何 build 要打包**:生產需求(體積、請求數、相容、快取)跟 dev 相反,所以用 Rollup 認真打包。
- **Tree shaking**:靠 ESM 的靜態特性砍掉沒用到的碼(回扣第 00 章 CJS/ESM);注意 `sideEffects` 和 CJS 套件的坑。
- **Code splitting**:動態 `import()` 做懶載入(路由分割是首屏優化神器);vendor chunk 分離提升快取命中;`manualChunks` 手動控制。
- **Hash 檔名**:content hash 實現快取破壞,配合 splitting 讓使用者每次只下載變動的部分。
- **壓縮 + 相容性**:esbuild 壓縮、CSS 抽取、`plugin-legacy` 處理舊瀏覽器。
- **分析優化**:用 visualizer 先測量再優化。
- **實務問題**:「dev 正常 build 白屏」的系統性診斷 + `base` 路徑設定。

**下一章(09)**,進入**進階場景**:SSR(伺服器渲染,為什麼需要、Vite 怎麼支援)、Library Mode(用 Vite 打包一個「給別人用的套件」而非「應用」,差在哪)、多頁應用(MPA)、以及 monorepo 整合。這些是當你的需求超出「單頁應用」時會用到的能力。

> 💡 **動手作業**:① 在專案裡用動態 `import()` 切出一個 chunk(例如點按鈕才載入某個模組),build 後在 dist 看到它變成獨立檔。② 裝 `rollup-plugin-visualizer`,build 後看那張體積圖,找出你專案裡最大的依賴是什麼。③ 故意設一個錯的 `base`,build + preview,親眼看「白屏」長怎樣,再改回來——這個體感會讓你記住 8.8 / 8.9。
