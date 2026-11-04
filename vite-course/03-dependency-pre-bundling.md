# 第 03 章:依賴預打包 Dependency Pre-bundling

> 第 02 章結尾留了一個洞:「不打包」會讓第三方依賴的請求數量爆炸。
> Vite 的解法是——對 `node_modules` 裡的依賴**先打包一次**,叫「依賴預打包」。
> 這一章我們搞懂:它解決什麼問題、為什麼非做不可、交給誰做、快取怎麼運作、
> 以及你每天會遇到的「重新預打包頁面閃一下」「dependency optimized」到底是什麼。

---

## 3.1 先把問題講清楚:預打包到底在解決什麼?

第 02 章說過,預打包要解決兩個問題。這一章把它們講透,因為這是你理解整章的動機。

### 問題 1:CommonJS / UMD 套件,瀏覽器原生 ESM 根本不能用

這裡兌現第 00 章的伏筆。回憶一下:

- 瀏覽器原生 ESM 只認得 `import` / `export`。
- 但 npm 上**大量套件(尤其老套件)是用 CommonJS 寫的**,用的是 `require` / `module.exports`。

如果一個套件是這樣寫的:

```js
// 某個 CJS 套件 some-cjs-lib 的內容
const dep = require('./dep')          // 瀏覽器不認識 require!
module.exports = function () { ... }  // 瀏覽器不認識 module.exports!
```

你在程式裡 `import x from 'some-cjs-lib'`,瀏覽器抓到上面那段內容,看到 `require`、`module.exports`——**整個爆炸**,因為原生 ESM 環境裡根本沒有 `require` 這個東西。

**所以必須有人把 CommonJS「翻譯」成 ESM**,瀏覽器才吞得下。這個翻譯工作,就是預打包的職責之一。

> **心智模型**:預打包是一道「轉接頭」。npm 世界有 CJS 和 ESM 兩種插頭,但瀏覽器只有 ESM 插孔。預打包負責把所有 CJS 插頭轉成 ESM 插頭。

### 問題 2:模組數量爆炸(請求瀑布)

第 02 章講過了,這裡用具體數字感受一下。看 `lodash-es`(這是 ESM 版的 lodash):

```js
// 你只是想用一個 debounce
import { debounce } from 'lodash-es'
```

但 `lodash-es` 內部是高度模組化的:每個工具函式都是獨立的小 `.js` 檔,而你 import 的 `'lodash-es'` 指向它的入口檔 `lodash.js`,裡面長這樣:

```js
// node_modules/lodash-es/lodash.js(節錄)
export { default as add } from './add.js'
export { default as after } from './after.js'
export { default as debounce } from './debounce.js'
// ……一路列下去,300 多行
```

瀏覽器不會「只抓你用到的那一個」:原生 ESM 必須把入口檔列出的模組**全部**載入、連結完才能執行。結果:

```
你 import 一個 debounce
   → 瀏覽器抓入口 lodash.js
      → 看到 300 多個 export ... from,一口氣發出 300 多個請求
         → 這些模組又各自 import 內部的小工具(_baseXxx.js 之類),再接力往下抓
            → 總共 600+ 個 HTTP 請求 😱
```

一次 600 多個請求,dev 體驗直接崩潰。

**預打包的解法**:把 `lodash-es` 那 600 個內部模組,**打包成「一個」檔案**。於是:

```
你 import debounce
   → 瀏覽器只要抓 1 個檔案:/node_modules/.vite/deps/lodash-es.js
   → 600 個請求變成 1 個 ✅
```

> **一句話總結兩個問題**:預打包 = ① 把 CJS 轉成 ESM(相容性)+ ② 把多檔套件併成單檔(效能)。

---

## 3.2 交給誰來做?

預打包一定要交給**原生語言寫的快速 bundler**:

- **Vite 2～7**:用 **esbuild**(第 00 章那個 Go 寫的、快 10~100 倍的工具),而不是當時負責 build 的 Rollup。
- **Vite 8 起**:改用 **Rolldown**(Rust 寫的),也就是跟生產建構同一個 bundler。

為什麼一定要快、又為什麼 Vite 8 能統一成一個?

1. **快**:依賴可能很大(整個 node_modules 動輒幾百 MB)。如果用 JS 寫的打包器處理,啟動會慢到無法接受。原生工具的速度讓「啟動時順手打包依賴」這件事的成本低到可以忽略。這也是 Vite 2～7 不用 Rollup 做預打包的原因——Rollup 是 JS 寫的,太慢。
2. **這階段不需要精細的最佳化**:預打包的產物只在 dev 用、不上線,不需要極致的 tree shaking、壓縮。只要「快速併成能用的 ESM」即可。
3. **Vite 8 的好處:dev 與 build 處理依賴的方式一致**。以前 dev 由 esbuild 把 CJS 轉成 ESM、build 由 Rollup 的 commonjs plugin 轉,兩邊的互通細節不同,偶爾出現「dev 正常、build 壞掉」。現在兩邊都是 Rolldown,這類落差小很多。

> **相關設定**:要調整預打包的打包選項,Vite 8 用 `optimizeDeps.rolldownOptions`(舊的 `optimizeDeps.esbuildOptions` 已棄用,Vite 會自動轉換)。

---

## 3.3 預打包何時觸發?產物放哪?

### 觸發時機

依賴預打包(Vite 內部叫 `optimizeDeps`)在這些情況會跑:

1. **第一次啟動 dev server**:Vite 從入口(預設是 `index.html`)開始掃描你的原始碼,找出所有用到的裸匯入(`import ... from '套件名'`),把它們預打包。這件事在背景進行,所以終端機會先印出 `ready in xxx ms`;瀏覽器第一次載入時,Vite 會等這次載入用到的靜態 import 都處理過一遍、確認沒有漏掉的依賴,才把預打包結果交給瀏覽器,避免中途才發現新依賴又要重來。
2. **發現新的、還沒打包過的依賴**:你開發到一半,新 `import` 了一個之前沒用過的套件,Vite 偵測到「咦,這個沒預打包過」,會即時補打包(這就是你會看到的「dependency optimized」,3.5 節詳談)。
3. **快取失效時**:某些設定或 lockfile 變了,Vite 判斷舊的預打包產物不能用了,會重打(3.4 節詳談)。

### 產物位置:`node_modules/.vite/deps/`

預打包的結果存在這裡:

```
node_modules/
└── .vite/
    └── deps/
        ├── vue.js              ← vue 預打包後的單檔
        ├── lodash-es.js        ← lodash-es 那 600 個模組,併成這一個
        ├── chunk-XXXXXXXX.js   ← 多個依賴共用的程式碼會抽成共享 chunk(有才會出現)
        ├── *.js.map            ← 對應的 source map
        ├── _metadata.json      ← 記錄這次預打包的「指紋」,用來判斷快取能不能用
        └── package.json        ← 內容是 { "type": "module" },讓這些檔案被當成 ESM
```

**為什麼放在 `node_modules/.vite` 裡?** 因為:

- 它是「衍生產物 / 快取」,本來就不該進版控。`node_modules` 預設就被 `.gitignore` 排除,放這裡剛好順便被忽略。
- 它跟著 `node_modules` 走,刪掉 `node_modules` 重裝時也會一起清掉,語意一致。

回憶第 02 章 Network 看到的:

```
import 'vue'  被改寫成  →  /node_modules/.vite/deps/vue.js?v=a1b2c3d4
```

現在你懂那個路徑了:它指向的就是預打包後的產物。後面那個 `?v=a1b2c3d4` 是版本雜湊,3.4 節會講它的用途。

---

## 3.4 快取機制:為什麼第二次啟動「更快」

預打包有成本(雖然原生 bundler 快,但掃描+打包整個依賴還是要時間)。所以 Vite 會**快取**結果,只要依賴沒變,就重用上次的,不重打。這就是為什麼你第一次 `npm run dev` 稍慢、之後幾次都飛快。

Vite 怎麼判斷「依賴有沒有變、快取能不能用」?它在 `_metadata.json` 裡記了一份「指紋」(`lockfileHash`、`configHash` 等),啟動時比對下列東西有沒有變化:

```
判斷快取是否有效,Vite 會看:
  ① lockfile 的內容(package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock)
     → 裝了、移除了、升級了套件,lockfile 都會變
  ② patches 資料夾的修改時間(用 patch-package 之類改過依賴?)
  ③ vite.config 裡跟依賴相關的設定(resolve.alias、optimizeDeps、plugins 等)
  ④ NODE_ENV 的值

任何一項變了 → 快取失效 → 重新預打包
全部沒變 → 直接用 node_modules/.vite/deps 裡現成的 → 啟動超快
```

注意這裡**不看 `package.json`**:你只改了 `package.json`、還沒重新 install,lockfile 沒變,Vite 就不會重打。

### 那個 `?v=雜湊` 是給瀏覽器看的快取

剛剛路徑後面的 `?v=a1b2c3d4`,作用是**控制瀏覽器的 HTTP 快取**:

- 預打包產物 Vite 會叫瀏覽器「**強快取**」起來(因為依賴不常變,讓瀏覽器存著、下次不用重抓,加速)。
- 但萬一依賴真的變了(你升級了套件),Vite 重新預打包後會**換一個新的 `?v=` 值**。網址一變,瀏覽器就認為是新檔、重新下載,不會用到舊快取。

> **心智模型(兩層快取)**:
> - **第一層(檔案系統)**:`.vite/deps` 存著打包產物,避免每次啟動都重打 → 加速「Vite 端」。
> - **第二層(瀏覽器)**:`?v=雜湊` 讓瀏覽器強快取產物,避免每次刷新都重抓 → 加速「瀏覽器端」。
> 兩層配合,所以你日常 dev 幾乎感覺不到依賴的載入成本。

### 手動清快取

偶爾快取會出怪問題(例如你手動改了 node_modules 裡的東西,但 lockfile 沒變,Vite 不知道要重打)。強制重打的方法:

```bash
# 方法 1:啟動時加 --force,強制重新預打包
npm run dev -- --force

# 方法 2:手動刪掉快取目錄,下次啟動自然重打
rm -rf node_modules/.vite
```

> **常見錯誤**:升級套件後出現「明明改了卻沒生效」「import 到舊版本」的詭異現象,八成是預打包快取沒更新。先試 `--force`,十之八九解決。

---

## 3.5 你每天會遇到的現象:逐一解釋

理論都鋪好了,現在來解釋你**實際操作時一定會撞見**的幾個畫面。看懂它們,你就真的懂預打包了。

### 現象 1:啟動時看不到預打包的訊息,快取失效時才會說

第一次啟動時,預打包在背景安靜地進行,終端機通常只會看到 `ready in xxx ms`。只有在「快取為什麼失效」值得告訴你時,Vite 才會印出來:

```
[vite] (client) Re-optimizing dependencies because lockfile has changed
[vite] (client) Re-optimizing dependencies because vite config has changed
[vite] (client) Forced re-optimization of dependencies      ← 用了 --force
```

這正是 3.4 講的快取機制:**只有 lockfile 或設定變了才會重打**。想親眼看到它在做事,就去看 `node_modules/.vite/deps/` 裡的檔案。(訊息前面的 `(client)` 是 Vite 6 起的「環境」名稱,代表這是給瀏覽器端用的預打包。)

### 現象 2:開發中突然出現 `dependency optimized`,有時頁面還會自動刷新

你開發到一半,新 import 了一個之前沒用過的套件,終端機跳出:

```
[vite] (client) dependency optimized: dayjs
[vite] (client) optimized dependencies changed. reloading
```

(一次多個新依賴時,第一行會寫成 `dependencies optimized: dayjs, axios`。)

如果出現第二行,瀏覽器會**整頁刷新**一下。發生了什麼?

1. 你新增了 `import dayjs from 'dayjs'`,但 `dayjs` 從沒被預打包過。
2. Vite 偵測到這個新依賴,即時把它預打包,放進 `.vite/deps`。
3. 新依賴有時會讓其他已經打包好的依賴也跟著變(例如共用的 chunk 重新切分)。只要頁面已經載入的依賴檔案變了,Vite 就觸發一次**整頁重載(full reload)**,讓頁面用上新打包好的版本;沒影響到的話就不必刷新。

> **為什麼是「整頁刷新」而不是第 05 章那種無痛 HMR?** 因為已經在瀏覽器裡執行的依賴檔案換掉了,影響面太大,直接整頁重載最安全。這是預期行為,不是 bug。

**如何避免它在開發中途打斷你?** 如果你**事先就知道**會用到某些依賴,可以在設定裡明確列出,讓 Vite 啟動時就一次打包好:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: {
    // include:強制這些依賴在「啟動時」就預打包,
    // 避免開發中途才發現、才打包、才整頁刷新。
    include: ['dayjs', 'lodash-es'],
  },
})
```

### 現象 3:某個套件預打包後就壞了 —— `exclude`

偶爾某個套件被預打包後反而出問題。最常見的是**套件用相對路徑載入自己的檔案**,例如 `new URL('./engine.wasm', import.meta.url)` 或 `new Worker(new URL('./worker.js', import.meta.url))`:預打包把它搬進 `.vite/deps/` 之後,相對路徑就指錯地方了。這時可以把它排除在預打包之外:

```ts
export default defineConfig({
  optimizeDeps: {
    // exclude:這些依賴不要預打包,讓瀏覽器直接用它原本的 ESM。
    exclude: ['some-wasm-lib'],
    // 被排除的套件如果內部依賴 CJS 套件,那個 CJS 套件還是得預打包,
    // 用「外層 > 內層」的寫法指名它
    include: ['some-wasm-lib > some-cjs-dep'],
  },
})
```

> **什麼時候用?** 90% 的情況你都不用碰 `include`/`exclude`,Vite 的自動掃描很準。只有遇到「開發中途老是觸發重新預打包很煩」「某依賴是由 plugin 產生的程式碼引入、掃描找不到」(用 `include`)或「某套件預打包後出錯」(用 `exclude`)時才動它。記住這兩個選項解決什麼問題就好。

---

## 3.6 一個常被混淆的重點:預打包只在 dev,不在 build

務必把這件事釘死,否則容易跟第 08 章搞混:

> **依賴預打包(optimizeDeps)是「dev 專屬」的機制。** `vite build`(生產建構)**不做**這套預打包。

為什麼?因為兩個階段的目的不同:

| | dev 預打包 | build(生產) |
|---|-----------|--------------|
| 工具 | Rolldown(Vite 7 以前是 esbuild) | Rolldown(Vite 7 以前是 Rollup) |
| 目的 | 避免 dev 請求爆炸、轉 CJS→ESM | 產生最佳化的上線檔案 |
| 處理依賴的方式 | 每個依賴先各自打成 `.vite/deps` 裡的檔案 | 跟你的原始碼一起統一打包、tree shaking |
| 產物去向 | `node_modules/.vite`(暫存) | `dist/`(上線用) |

build 時,bundler 本來就會把所有東西(你的碼 + 依賴)一起打包最佳化,所以不需要 dev 那套「先預打包」的前置動作。

> **這也是「dev 沒事、build 卻出錯」這類問題的根源之一**(第 00 章伏筆再次兌現):dev 先把依賴各自打包、build 跟原始碼一起打包,兩條路徑處理依賴的方式不同,偶爾會暴露出不一致。Vite 7 以前更明顯,因為兩邊連工具都不同(esbuild vs Rollup 的 commonjs plugin),CJS 套件的互通細節常常對不上;Vite 8 兩邊都是 Rolldown,這類落差小了很多。遇到這種狀況,先想到「是不是兩條路徑處理依賴的差異」。

---

## 3.7 本章小結與下一步

這一章我們把「依賴預打包」拆解完畢:

- **它解決兩個問題**:① 把 CommonJS 套件轉成瀏覽器能用的 ESM(相容性);② 把多檔套件併成單檔,避免請求爆炸(效能)。
- **交給原生 bundler 做**(Vite 8 是 Rolldown,Vite 7 以前是 esbuild),因為夠快,適合「啟動時順手做完」的粗活。
- **產物在 `node_modules/.vite/deps/`**,裸匯入會被改寫成指向它的路徑(回扣第 02 章)。
- **兩層快取**:檔案系統(`.vite/deps`)+ 瀏覽器(`?v=雜湊`),靠 lockfile、設定等指紋判斷失效,所以第二次啟動超快。
- **看懂日常現象**:快取失效時的 `Re-optimizing dependencies`、中途的 `dependency optimized` 與整頁刷新、`include`/`exclude` 各解決什麼。
- **釘死一個觀念**:預打包只在 dev,build 會把依賴跟原始碼一起打包,不走這套。

**下一章(04)**,我們回到「你的原始碼」這條線,深入第 02 章「障礙 1」的解法——**模組轉換管線**:Vite 怎麼把 `.ts`、`.css`、圖片、`?raw`、`?url`、`?worker` 這些東西即時轉成瀏覽器能用的模組?`public/` 和 `import` 進來的資源差在哪?環境變數 `import.meta.env` 怎麼運作?這些是你每天寫 code 都會碰到的東西。

> 💡 **動手作業**:做第 02 章作業裝的 `lodash-es`,現在去看 `node_modules/.vite/deps/` 裡有沒有 `lodash-es.js`,打開它瞄一眼(會看到它把很多東西併在一起了)。然後試試 `npm run dev -- --force`,觀察終端機出現 `Forced re-optimization of dependencies`。
