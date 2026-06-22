# 第 04 章:模組轉換管線與資源處理

> 第 02 章的「障礙 1」說:瀏覽器只看得懂標準 JS/CSS,而你寫的是 .ts、.css、import 圖片……
> Vite 怎麼把這些「即時轉成瀏覽器能用的模組」?這就是這一章要拆的「轉換管線」。
> 我們會逐一看:TS/JSX 怎麼轉、CSS 怎麼變成 JS 模組、import 一張圖片到底拿到什麼、
> `?raw`/`?url`/`?worker` 這些字尾是什麼、`public` 與 `import` 差在哪、環境變數怎麼運作。
> 全都是你每天寫 code 會碰到的東西。

---

## 4.1 核心觀念:在 Vite 裡,「一切皆模組」

先建立這一章的總綱。在 Vite(以及 Webpack)的世界裡,有一個顛覆直覺的觀念:

> **不只 JS 可以被 `import`,CSS、圖片、JSON、SVG、甚至 Worker,全都可以被 `import`。**

```js
import './style.css'              // import 一個 CSS
import logo from './logo.png'     // import 一張圖片
import data from './data.json'    // import 一份 JSON
import worker from './w.js?worker' // import 一個 Worker
```

但瀏覽器原生 ESM **只能 import JS**!你 `import './style.css'`,瀏覽器拿到一堆 CSS 文字會直接報錯。

**所以 Vite 的工作是**:當瀏覽器來要這些「非 JS」的東西時,Vite 在中間**即時把它們「包裝成一個合法的 JS 模組」**再回傳。瀏覽器收到的永遠是 JS。

這個「把各種資源即時轉成 JS 模組」的處理過程,就叫**轉換管線(transform pipeline)**。本章就是逐一拆解管線對不同資源做了什麼。

> **心智模型**:Vite dev server 是一個「萬能翻譯機」。不管你 import 的是 TS、CSS 還是圖片,它都翻譯成「瀏覽器看得懂的 JS 模組」這一種語言再交付。

---

## 4.2 TypeScript / JSX:用 esbuild「剝型別」

最常見的轉換:把 `.ts` / `.tsx` 轉成 `.js`。Vite 用 **esbuild** 做這件事(又是 esbuild,因為要即時、要快)。

### 它做什麼:transpile(轉譯),不是 type-check(型別檢查)

這點第 01 章強調過,這裡講清楚機制。esbuild 對一個 `.ts` 檔做的事是**「剝掉型別語法(type stripping)」**:

```ts
// 你寫的 TS:
function greet(name: string): string {
  return `Hello, ${name}`
}
const count: number = 5
```

```js
// esbuild 轉出來的 JS(型別語法被剝光):
function greet(name) {
  return `Hello, ${name}`
}
const count = 5
```

**注意**:esbuild **只是把 `: string`、`: number` 這些型別標註刪掉**,它**完全不檢查**你型別寫得對不對。

```ts
const count: number = "我是字串"   // 型別明顯錯誤
// → esbuild 照轉不誤,變成 const count = "我是字串",dev 不報錯!
```

**為什麼故意不檢查?** 再強調一次:型別檢查很慢(要建立完整的型別關係圖),會拖垮「即時轉譯」。Vite 選擇速度,把型別檢查丟給 `tsc`(build 時)和編輯器(即時標紅)。

> **延伸的小陷阱**:因為 esbuild 是「單檔獨立轉譯、不看其他檔案的型別資訊」,有些**依賴型別資訊才能正確編譯**的 TS 特性會出問題,最典型的是:
> - `const enum`:它需要跨檔內聯,esbuild 單檔轉譯處理不了,行為可能不如預期。
> - 純型別的 import 若沒寫 `import type`,可能被誤刪或誤留。
>
> 解法是設定 TS 的 `isolatedModules: true`(現代模板預設就開了),它會強制你寫出「每個檔案都能獨立編譯」的程式碼,避免踩雷。知道有這回事即可。

---

## 4.3 CSS:import 進來會發生什麼?

`import './style.css'` 是最神奇的一個,我們慢慢拆。

### dev 階段:CSS 被包成 JS,透過 JS 注入 `<style>`

dev 時,當瀏覽器來要 `style.css`,Vite **不會**回傳純 CSS,而是回傳一段**JavaScript**,內容大致是:

```js
// Vite 把 style.css 轉成的 JS 模組(簡化示意):
const css = `.title { color: red; }`        // 你的 CSS 內容變成字串
// 一段邏輯:建立 <style> 標籤,把 css 塞進去,append 到 <head>
const style = document.createElement('style')
style.textContent = css
document.head.appendChild(style)
// 還會掛上 HMR 邏輯,讓你改 CSS 時能無刷新更新(第 05 章)
```

**為什麼要這樣繞一圈(CSS → JS)?** 因為:

1. 瀏覽器原生 ESM 的 `import` 只能載入 JS。要讓 `import './style.css'` 這個語法成立,回傳的就必須是 JS。
2. 包成 JS 後,Vite 才能在裡面塞 HMR 邏輯——這樣你改 CSS 時,可以**只更新樣式、不刷新整頁**(第 05 章會看到 CSS 的 HMR 體驗超絲滑)。

> 你在第 02 章 Network 面板看到的 `style.css` 請求,點開 Response 會發現它**是 JS**,不是 CSS——現在你懂為什麼了。

### build 階段:CSS 被抽成獨立 .css 檔

dev 用 JS 注入是為了 HMR 方便。但**上線**時用 JS 注入 CSS 不好(會有「樣式閃一下才套用」的問題、也不利快取)。所以 `vite build` 時,Vite 會把 CSS **抽取(extract)成獨立的 `.css` 檔**,用 `<link>` 載入。

> 又一個 dev / build 行為不同的例子(第 00 章主題貫穿全課):dev 為了 HMR 把 CSS 包成 JS 注入,build 為了效能把 CSS 抽成獨立檔。

### CSS Modules:`.module.css`

如果檔名是 `xxx.module.css`,Vite 會啟用 **CSS Modules**——把 class 名稱「在地化(局部作用域化)」,避免全域 class 撞名:

```css
/* button.module.css */
.primary { background: blue; }
```

```js
import styles from './button.module.css'
// styles 是一個物件:{ primary: "_primary_a1b2c3" }
// 原本的 .primary 被改名成帶 hash 的唯一名稱,不會跟別處的 .primary 撞車
element.className = styles.primary
```

**為什麼有用?** 傳統 CSS 全域生效,大型專案 class 名很容易撞。CSS Modules 讓每個檔案的 class 自動變成獨一無二的名字,你引用時透過 `styles.xxx` 拿到真正的名稱。**判斷依據就是副檔名 `.module.css`**,Vite 看到就自動開啟,零設定。

### CSS 預處理器(Sass / Less)

只要裝對應的編譯器,Vite 就自動支援,不用額外設定 loader(這跟 Webpack 要配一堆 loader 很不同):

```bash
npm i -D sass          # 裝了就能 import .scss / .sass
```

```js
import './style.scss'  // Vite 偵測到 .scss,自動先用 sass 編譯成 CSS,再走前面的流程
```

> **為什麼 Vite 不用配 loader?** Vite 對常見資源(CSS、預處理器、JSON、圖片)有**內建**處理,開箱即用。你只要補上「編譯器本身」(如 `sass`)即可。這是 Vite「約定優於設定」哲學的體現。

---

## 4.4 靜態資源:import 一張圖片,到底拿到什麼?

```js
import logoUrl from './logo.png'
console.log(logoUrl)
```

`logoUrl` 是什麼?**它是一個字串——指向那張圖片的 URL**,不是圖片的二進位內容。

```js
// dev 時,logoUrl 大概是:
"/src/assets/logo.png"

// build 後,logoUrl 大概是(檔名加了 hash):
"/assets/logo-a1b2c3d4.png"
```

所以你會這樣用:

```js
import logoUrl from './logo.png'
const img = document.createElement('img')
img.src = logoUrl          // 把 URL 設給 img 的 src
document.body.appendChild(img)
```

**為什麼 import 圖片拿到的是 URL,不是內容?** 因為圖片最終是要瀏覽器透過 `<img src="...">` 去載入的,你需要的是「它的網址」。Vite 幫你做的事是:

- dev:給你一個能在 dev server 上抓到的 URL。
- build:把圖片複製到 `dist/assets/`、**加上內容 hash**(快取破壞,回扣第 01、03 章),然後給你那個最終 URL。

> **這解決了一個老問題**:以前手寫 `<img src="./logo.png">`,build 後路徑、檔名一變就壞掉。現在你 `import` 它,**讓 Vite 來保證「URL 永遠正確」**——它知道檔案 build 後會去哪、叫什麼名字。

### 小檔案會被 inline 成 base64

有個自動最佳化:**很小的圖片**(預設小於 4KB),Vite 不會產生獨立檔案,而是直接把它編碼成 base64 字串內聯進 JS:

```js
import tinyIcon from './tiny.png'
// 若 tiny.png < 4KB,tinyIcon 會是:
// "data:image/png;base64,iVBORw0KG..."
```

**為什麼?** 小圖獨立成檔,反而多一次 HTTP 請求划不來;直接內聯進 JS,省一個請求。這個門檻可調(`build.assetsInlineLimit`)。

---

## 4.5 import 字尾(query suffix):`?raw` / `?url` / `?worker` / `?inline`

有時候預設行為不是你要的。Vite 提供一組「字尾」,讓你**明確指定要怎麼 import** 一個資源。這是 Vite 很實用、但很多人不知道的功能。

### `?raw` —— 我要「原始文字內容」

```js
import shaderSource from './shader.glsl?raw'
// shaderSource 是 shader.glsl 的「原始文字字串」
// "void main() { ... }"
```

**用途**:你想拿到檔案的「文字內容本身」,而不是它的 URL。常見於 shader、模板、想內嵌的程式碼片段。

### `?url` —— 我要「URL」,不要內容

```js
import workletUrl from './worklet.js?url'
// 強制拿到 URL 字串,即使它是 JS(預設 import JS 會執行它,加 ?url 就只給你網址)
```

**用途**:有些 API 需要的是「檔案的網址」(例如 `new Worker(url)`、`audioWorklet.addModule(url)`)。`?url` 保證你拿到的是 URL,而非被當模組執行。

### `?worker` —— 我要把它當 Web Worker

```js
import MyWorker from './heavy-task.js?worker'
const worker = new MyWorker()      // 直接 new 出一個 Worker
worker.postMessage('start')
```

**用途**:把一支 JS 當 Web Worker 載入(背景執行緒跑重運算)。Vite 幫你處理好 Worker 的打包與載入細節,你只要加 `?worker` 字尾、再 `new` 它就好。

### `?inline` —— 強制內聯

```js
import css from './style.css?inline'
// 拿到 CSS 字串本身,而且「不要」自動注入 <style>
```

> **心智模型**:這些字尾是你對 Vite 下的「明確指令」。預設行為(import 圖片給 URL、import CSS 自動注入)適用大多數情況;當你要的不是預設,就用字尾覆寫它。記住最常用的 `?raw`(要文字)和 `?url`(要網址)即可,其他遇到再查。

---

## 4.6 `public/` vs `import`:兩種放靜態資源的方式

第 01 章提過,這裡講清楚「**什麼時候該用哪個**」,因為這是高頻困惑點。

### 方式 A:放 `src/`,用 `import`(推薦,大多數情況)

```js
import logoUrl from './assets/logo.png'
img.src = logoUrl
```

- Vite **會處理它**:加 hash(快取破壞)、小檔內聯、保證 build 後 URL 正確。
- **優點**:檔名 hash 讓快取永遠正確;檔案沒被任何地方 import 到,build 時會被自動排除(不會打包沒用到的圖)。
- **適用**:你程式裡會引用、由 JS/CSS 帶出來的資源(99% 的圖片、字型)。

### 方式 B:放 `public/`,用絕對路徑引用

```
public/
└── robots.txt
└── favicon.ico
```

```html
<!-- 直接用根路徑 / 引用,不經 import -->
<link rel="icon" href="/favicon.ico">
```

- Vite **完全不處理它**:`public/` 裡的東西原封不動複製到 `dist/` 根目錄,**檔名不變、不加 hash**。
- **適用**(滿足以下任一才用 public):
  - 檔名**必須固定**、不能加 hash 的(例如 `robots.txt`、`manifest.json`、`favicon.ico`,因為外部會用固定網址找它)。
  - 不會被任何程式 import、但就是要存在於輸出目錄的檔。
  - 引用路徑需要寫死(例如第三方腳本指定要某個固定路徑的檔)。

### 一張表決定用哪個

| 問題 | 答案 → 用哪個 |
|------|--------------|
| 這檔會被 JS/CSS `import` 引用嗎? | 會 → `import`(放 src) |
| 檔名能不能變(加 hash)? | 能 → `import`;**不能(要固定)→ public** |
| 需要快取破壞嗎? | 要 → `import`(自動加 hash) |
| 是 robots.txt / favicon / 寫死路徑的檔嗎? | 是 → `public/` |

> **白話總結**:**預設都用 `import`**(讓 Vite 幫你管 URL 和快取)。只有「檔名必須固定、不能被 Vite 改」的少數檔案才放 `public/`。

---

## 4.7 環境變數:`import.meta.env`

最後一塊日常必用的東西:在程式裡讀環境變數(例如 API 網址、是否為正式環境)。

### 怎麼用

Vite 把環境變數掛在 `import.meta.env` 上:

```js
console.log(import.meta.env.MODE)        // 'development' 或 'production'
console.log(import.meta.env.DEV)         // dev 時為 true
console.log(import.meta.env.PROD)        // build 時為 true
console.log(import.meta.env.BASE_URL)    // 部署的基底路徑
```

### 自訂變數:`.env` 檔 + `VITE_` 前綴

在專案根目錄建 `.env` 檔:

```bash
# .env
VITE_API_URL=https://api.example.com
DB_PASSWORD=super-secret              # 注意:沒有 VITE_ 前綴
```

```js
console.log(import.meta.env.VITE_API_URL)    // "https://api.example.com" ✅
console.log(import.meta.env.DB_PASSWORD)     // undefined ❌ 讀不到!
```

**為什麼只有 `VITE_` 開頭的讀得到?這是個關鍵的安全設計**:

你的前端程式碼最終會被打包、送到使用者瀏覽器,**任何人都能看到原始碼**。如果 Vite 把所有環境變數(包含 `DB_PASSWORD` 這種機密)都塞進前端,那等於把密碼公開給全世界。

所以 Vite 規定:**只有以 `VITE_` 開頭的變數,才會被注入到前端程式碼**。其他變數(像 `DB_PASSWORD`)Vite 故意不給,逼你不要把機密寫進前端。這是一道「防呆 + 防洩漏」的護欄。

> **常見錯誤**:「我設了環境變數但讀到 undefined!」99% 是忘了加 `VITE_` 前綴。記住:**前端要讀的環境變數,名字一定要 `VITE_` 開頭。**

### 多環境 `.env` 檔

```
.env                # 所有情況都載入
.env.local          # 所有情況載入,但會被 git ignore(放本機機密)
.env.development    # 只在 dev(vite)載入
.env.production     # 只在 build(vite build)載入
```

**用途**:讓 dev 連測試 API、production 連正式 API,自動切換:

```bash
# .env.development
VITE_API_URL=http://localhost:8080

# .env.production
VITE_API_URL=https://api.example.com
```

程式裡照樣寫 `import.meta.env.VITE_API_URL`,Vite 會依當下是 dev 還是 build **自動載入對應的 `.env` 檔**,你不用改任何程式碼。

### build 時的真相:環境變數是「靜態替換」

有一個底層細節值得知道:`import.meta.env.VITE_API_URL` 在 build 時**不是「執行時去讀變數」,而是在打包當下被「文字替換」成實際的值**:

```js
// 你寫的:
fetch(import.meta.env.VITE_API_URL + '/users')

// build 後,實際變成(值被寫死進去了):
fetch("https://api.example.com" + '/users')
```

**為什麼這很重要?** 兩個推論:

1. **環境變數的值在 build 那一刻就定死了**。你不能 build 完一次,再靠改環境變數去改變產物的行為——要改就得重新 build。
2. 因為是靜態替換,`import.meta.env.PROD` 這種布林值在 build 後會變成 `true`/`false` 字面量,於是 `if (import.meta.env.PROD) {...}` 裡的 dev-only 程式碼會被 tree shaking 整段砍掉(第 08 章)。這是個很有用的特性。

---

## 4.8 本章小結與下一步

這一章我們拆完了 Vite 的「轉換管線」與資源處理:

- **核心觀念**:一切皆模組,Vite 把各種資源**即時包裝成 JS 模組**回傳給瀏覽器。
- **TS/JSX**:esbuild 只「剝型別」不「檢查型別」,所以快;型別檢查交給 tsc。
- **CSS**:dev 包成 JS 注入(為了 HMR),build 抽成獨立檔(為了效能);`.module.css` 自動開 CSS Modules。
- **靜態資源**:import 圖片拿到的是 **URL**(且 build 會加 hash);小檔自動 base64 內聯。
- **import 字尾**:`?raw`(要文字)、`?url`(要網址)、`?worker`(當 Worker)、`?inline`(強制內聯)。
- **public vs import**:預設用 import(Vite 管 URL 與快取);只有檔名必須固定的才放 public。
- **環境變數**:`import.meta.env` + `VITE_` 前綴(安全護欄);多 `.env` 檔自動切環境;build 時是靜態文字替換。

**下一章(05)是 dev 體驗的靈魂——HMR 熱更新**:你改一行 code,為什麼畫面能「不刷新整頁就更新」,還保留住目前的狀態(例如輸入框沒被清空)?第 02 章那個 `@vite/client` 到底在幹嘛?module graph、HMR 邊界、`import.meta.hot` API 怎麼運作?框架(Vue/React)怎麼接上 HMR?下一章全部揭曉,也為「手寫 mini-vite」的 capstone 打下最後一塊基礎。

> 💡 **動手作業**:① 在 `main.ts` 裡 `import` 一張圖片並設給 `img.src`,build 後去 `dist/assets/` 看它的檔名有沒有 hash。② 建一個 `.env`,設 `VITE_HELLO=world`,在程式 `console.log(import.meta.env.VITE_HELLO)`;再故意設一個沒有 `VITE_` 前綴的,確認它讀到 `undefined`。
