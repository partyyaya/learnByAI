# 第 03 章:依賴預打包 Dependency Pre-bundling

> 第 02 章結尾留了一個洞:「不打包」會讓第三方依賴的請求數量爆炸。
> Vite 的解法是——對 `node_modules` 裡的依賴**先用 esbuild 打包一次**,叫「依賴預打包」。
> 這一章我們搞懂:它解決什麼問題、為什麼非做不可、esbuild 怎麼做、快取怎麼運作、
> 以及你每天會遇到的「重新預打包頁面閃一下」「new dependencies optimized」到底是什麼。

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

但 `lodash-es` 內部是高度模組化的:`debounce` 依賴 `isObject`、`now`、`toNumber`……每個工具函式都是獨立的小 `.js` 檔,互相 import。結果:

```
你 import 一個 debounce
   → 瀏覽器要抓 debounce.js
      → 它 import 了 isObject.js、now.js、toNumber.js...
         → 那些又各自 import 別的...
            → 最終可能引爆 600+ 個 HTTP 請求 😱
```

600 個請求的請求瀑布,dev 體驗直接崩潰。

**預打包的解法**:把 `lodash-es` 那 600 個內部模組,**用 esbuild 打包成「一個」檔案**。於是:

```
你 import debounce
   → 瀏覽器只要抓 1 個檔案:/node_modules/.vite/deps/lodash-es.js
   → 600 個請求變成 1 個 ✅
```

> **一句話總結兩個問題**:預打包 = ① 把 CJS 轉成 ESM(相容性)+ ② 把多檔套件併成單檔(效能)。

---

## 3.2 為什麼是 esbuild 來做?

預打包用的是 **esbuild**(第 00 章那個 Go 寫的、快 10~100 倍的工具),不是 Rollup。為什麼?

1. **快**:依賴可能很大(整個 node_modules 動輒幾百 MB)。如果用 JS 寫的打包器處理,啟動會慢到無法接受。esbuild 的原生速度讓「啟動時順手打包依賴」這件事的成本低到可以忽略。
2. **這階段不需要 Rollup 的精細功能**:預打包的產物只在 dev 用、不上線,不需要極致的 tree shaking、code splitting。只要「快速併成能用的 ESM」即可。esbuild 剛好擅長這個。

> **回扣第 00 章**:這就是 esbuild 在 Vite 裡的角色之一——它太快了,適合幹「啟動時要趕快做完」的粗活(預打包、即時轉譯)。而需要精雕細琢的生產建構,才交給 Rollup。

---

## 3.3 預打包何時觸發?產物放哪?

### 觸發時機

依賴預打包(Vite 內部叫 `optimizeDeps`)在這些情況會跑:

1. **第一次啟動 dev server**:Vite 掃描你的原始碼,找出所有用到的裸匯入(`import ... from '套件名'`),把它們預打包。
2. **發現新的、還沒打包過的依賴**:你開發到一半,新 `import` 了一個之前沒用過的套件,Vite 偵測到「咦,這個沒預打包過」,會即時補打包(這就是你會看到的「new dependencies optimized」,3.5 節詳談)。
3. **快取失效時**:某些設定或 lockfile 變了,Vite 判斷舊的預打包產物不能用了,會重打(3.4 節詳談)。

### 產物位置:`node_modules/.vite/deps/`

預打包的結果存在這裡:

```
node_modules/
└── .vite/
    └── deps/
        ├── vue.js              ← vue 預打包後的單檔
        ├── lodash-es.js        ← lodash-es 那 600 個模組,併成這一個
        ├── _metadata.json      ← 記錄這次預打包的「指紋」,用來判斷快取能不能用
        └── package.json
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

預打包有成本(雖然 esbuild 快,但掃描+打包整個依賴還是要時間)。所以 Vite 會**快取**結果,只要依賴沒變,就重用上次的,不重打。這就是為什麼你第一次 `npm run dev` 稍慢、之後幾次都飛快。

Vite 怎麼判斷「依賴有沒有變、快取能不能用」?它在 `_metadata.json` 裡記了一份「指紋」,啟動時比對下列東西有沒有變化:

```
判斷快取是否有效,Vite 會看:
  ① package.json 裡的 dependencies(你裝了/移除了套件?)
  ② lockfile(package-lock.json / pnpm-lock.yaml,版本變了?)
  ③ vite.config 裡跟依賴解析相關的設定(resolve.alias、optimizeDeps 等)
  ④ patches 等其他可能影響依賴內容的因素

任何一項變了 → 快取失效 → 重新預打包
全部沒變 → 直接用 node_modules/.vite/deps 裡現成的 → 啟動超快
```

### 那個 `?v=雜湊` 是給瀏覽器看的快取

剛剛路徑後面的 `?v=a1b2c3d4`,作用是**控制瀏覽器的 HTTP 快取**:

- 預打包產物 Vite 會叫瀏覽器「**強快取**」起來(因為依賴不常變,讓瀏覽器存著、下次不用重抓,加速)。
- 但萬一依賴真的變了(你升級了套件),Vite 重新預打包後會**換一個新的 `?v=` 值**。網址一變,瀏覽器就認為是新檔、重新下載,不會用到舊快取。

> **心智模型(兩層快取)**:
> - **第一層(檔案系統)**:`.vite/deps` 存著打包產物,避免每次啟動都重打 → 加速「Vite 端」。
> - **第二層(瀏覽器)**:`?v=雜湊` 讓瀏覽器強快取產物,避免每次刷新都重抓 → 加速「瀏覽器端」。
> 兩層配合,所以你日常 dev 幾乎感覺不到依賴的載入成本。

### 手動清快取

偶爾快取會出怪問題(例如你手動改了 node_modules 裡的東西,但指紋沒變,Vite 不知道要重打)。強制重打的方法:

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

### 現象 1:啟動時的 `Pre-bundling dependencies`

第一次啟動(或快取失效)時,終端機會出現:

```
Pre-bundling dependencies:
  vue
  lodash-es
(this will be run only when your dependencies or config change)
```

這就是 Vite 在掃描你的原始碼、找出所有裸匯入、然後用 esbuild 打包它們。括號那句話正是 3.4 講的快取機制:**只有依賴或設定變了才會跑**。沒變的話你下次啟動看不到這段,因為直接用快取了。

### 現象 2:開發中突然 `new dependencies optimized` 然後頁面自動刷新

你開發到一半,新 import 了一個之前沒用過的套件,終端機跳出:

```
[vite] new dependencies optimized: dayjs
[vite] optimized dependencies changed. reloading
```

接著瀏覽器**整頁刷新**了一下。發生了什麼?

1. 你新增了 `import dayjs from 'dayjs'`,但 `dayjs` 從沒被預打包過。
2. Vite 偵測到這個新依賴,即時用 esbuild 把它預打包,放進 `.vite/deps`。
3. 因為「可用的依賴集合變了」,Vite 觸發一次**整頁重載(full reload)**,讓頁面用上新打包好的依賴。

> **為什麼是「整頁刷新」而不是第 05 章那種無痛 HMR?** 因為依賴集合變動牽涉到模組路徑改寫,影響面較大,直接整頁重載最安全。這是預期行為,不是 bug。

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

偶爾某個套件被 esbuild 預打包後反而出問題(常見於本身已經是良好 ESM、或有特殊載入需求的套件)。可以把它排除在預打包之外:

```ts
export default defineConfig({
  optimizeDeps: {
    // exclude:這些依賴不要預打包,讓瀏覽器直接用它原本的 ESM。
    exclude: ['某個不想被預打包的套件'],
  },
})
```

> **什麼時候用?** 90% 的情況你都不用碰 `include`/`exclude`,Vite 的自動掃描很準。只有遇到「開發中途老是觸發重新預打包很煩」(用 `include`)或「某套件預打包後出錯」(用 `exclude`)時才動它。記住這兩個選項解決什麼問題就好。

---

## 3.6 一個常被混淆的重點:預打包只在 dev,不在 build

務必把這件事釘死,否則容易跟第 08 章搞混:

> **依賴預打包(optimizeDeps)是「dev 專屬」的機制。** `vite build`(生產建構)**不做**這套預打包。

為什麼?因為兩個階段的目的不同:

| | dev 預打包 | build(生產) |
|---|-----------|--------------|
| 工具 | esbuild | Rollup |
| 目的 | 避免 dev 請求爆炸、轉 CJS→ESM | 產生最佳化的上線檔案 |
| 處理依賴的方式 | 預先打成 `.vite/deps` | 跟你的原始碼一起,由 Rollup 統一打包、tree shaking |
| 產物去向 | `node_modules/.vite`(暫存) | `dist/`(上線用) |

build 時,Rollup 本來就會把所有東西(你的碼 + 依賴)一起打包最佳化,所以不需要 dev 那套「先預打包」的前置動作。

> **這也是「dev 沒事、build 卻出錯」這類問題的根源之一**(第 00 章伏筆再次兌現):dev 用 esbuild 預打包依賴、build 用 Rollup,兩條路徑處理依賴的方式不同,偶爾會暴露出不一致。遇到這種狀況,先想到「是不是兩套引擎處理依賴的差異」。

---

## 3.7 本章小結與下一步

這一章我們把「依賴預打包」拆解完畢:

- **它解決兩個問題**:① 把 CommonJS 套件轉成瀏覽器能用的 ESM(相容性);② 把多檔套件併成單檔,避免請求爆炸(效能)。
- **用 esbuild 做**,因為夠快,適合「啟動時順手做完」的粗活。
- **產物在 `node_modules/.vite/deps/`**,裸匯入會被改寫成指向它的路徑(回扣第 02 章)。
- **兩層快取**:檔案系統(`.vite/deps`)+ 瀏覽器(`?v=雜湊`),靠指紋判斷失效,所以第二次啟動超快。
- **看懂日常現象**:`Pre-bundling`、`new dependencies optimized` 整頁刷新、`include`/`exclude` 各解決什麼。
- **釘死一個觀念**:預打包只在 dev,build 用 Rollup 不走這套。

**下一章(04)**,我們回到「你的原始碼」這條線,深入第 02 章「障礙 1」的解法——**模組轉換管線**:Vite 怎麼把 `.ts`、`.css`、圖片、`?raw`、`?url`、`?worker` 這些東西即時轉成瀏覽器能用的模組?`public/` 和 `import` 進來的資源差在哪?環境變數 `import.meta.env` 怎麼運作?這些是你每天寫 code 都會碰到的東西。

> 💡 **動手作業**:做第 02 章作業裝的 `lodash-es`,現在去看 `node_modules/.vite/deps/` 裡有沒有 `lodash-es.js`,打開它瞄一眼(會看到它把很多東西併在一起了)。然後試試 `npm run dev -- --force`,觀察終端機重新出現 `Pre-bundling dependencies`。
