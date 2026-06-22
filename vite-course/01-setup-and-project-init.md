# 第 01 章:環境與專案初始化

> 上一章我們建立了「Vite = dev 不打包 + build 用 Rollup」的心智模型。
> 這一章開始動手:把專案跑起來、看懂專案結構、認識 `vite.config.ts`,
> 並把 `dev` / `build` / `preview` 三個指令的差別徹底分清楚。
> 每個檔案、每個指令我都會解釋「它是什麼、為什麼存在」。

---

## 1.1 環境準備

Vite 跑在 Node.js 上,所以先確認 Node 版本。

```bash
# 查看目前 Node 版本
node -v
```

**版本要求**:Vite 需要較新的 Node(目前 Vite 6/7 要求 Node 18+ 或 20+)。

**為什麼要管 Node 版本?** 因為 Vite 本身用了不少新版 Node 才有的 API。版本太舊會直接啟動失敗,報一些看起來莫名其妙的錯。如果你機器上同時有多個專案需要不同 Node 版本,強烈建議用版本管理器:

```bash
# 用 nvm(macOS / Linux 常見)安裝並切換 Node 版本
nvm install 20      # 安裝 Node 20
nvm use 20          # 切換到 Node 20
```

### 套件管理器:npm / pnpm / yarn

三者都能用。本課程指令會以 `npm` 為主,但會標註 `pnpm` 寫法,因為 **pnpm 在 Vite 生態越來越主流**(省硬碟、安裝快、對 monorepo 友善)。

```bash
# 確認你有哪個
npm -v
pnpm -v    # 沒有的話:npm install -g pnpm
```

---

## 1.2 用 create-vite 建立專案

Vite 官方提供一個鷹架工具(scaffolding tool)叫 `create-vite`,幫你產生一個最小可跑的專案骨架。

```bash
# npm 寫法
npm create vite@latest

# pnpm 寫法
pnpm create vite
```

**這行指令在做什麼?**

- `npm create vite@latest` 其實是 `npm exec create-vite@latest` 的縮寫。
- 它會去 npm 下載一個叫 `create-vite` 的套件並執行它,這個套件就是個互動式問答程式。
- `@latest` 表示抓最新版,避免用到你電腦上快取的舊版鷹架。

執行後它會問你幾個問題:

```
✔ Project name: … my-vite-app          ← 專案資料夾名稱
✔ Select a framework: › Vue            ← 選框架(Vanilla/Vue/React/Svelte/Solid/Qwik...)
✔ Select a variant: › TypeScript       ← 選變體(JS 還是 TS)
```

- **Framework**:選你要用的框架。選 `Vanilla` 就是純 JS、不綁框架,**本課程示範會用 Vanilla + TypeScript**,因為要研究 Vite 本身,框架越少干擾越好。
- **Variant**:`TypeScript` 或 `JavaScript`。建議 TypeScript,跟現代專案接軌。

也可以一行指定、跳過問答:

```bash
# 直接指定專案名、框架(template)為 vanilla-ts
npm create vite@latest my-vite-app -- --template vanilla-ts
```

> ⚠️ **那個 `--` 是什麼?** npm 規定:要把參數「傳給後面執行的程式(create-vite)」而不是「給 npm 自己」,中間要加 `--` 分隔。少了它,`--template` 會被 npm 吃掉。pnpm 則不需要這個 `--`。

建完之後照它提示做:

```bash
cd my-vite-app      # 進入專案
npm install         # 安裝依賴(pnpm install)
npm run dev         # 啟動開發伺服器
```

執行 `npm run dev`,你會看到:

```
  VITE v7.0.0  ready in 312 ms      ← 注意這個時間!幾百毫秒就好了

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

> 🎯 **第一個「啊哈」時刻**:`ready in 312 ms`。對比 Webpack 大型專案動輒數十秒的冷啟動,這就是第 00 章講的「dev 不打包,所以秒啟動」的實際體感。專案再大,這個數字也不會暴增——這是 Vite 最核心的賣點。

---

## 1.3 專案結構逐一拆解

一個 `vanilla-ts` 專案長這樣。我們一個一個看,**每個檔案都要知道它為什麼在這裡**。

```
my-vite-app/
├── index.html          ← ⭐ 整個應用的入口(注意:在根目錄,不在 src 裡!)
├── package.json        ← 專案資訊、依賴清單、npm scripts
├── tsconfig.json       ← TypeScript 編譯設定
├── vite.config.ts      ← Vite 設定檔(本課程的主角)
├── public/             ← 靜態資源(原樣複製,不經處理)
│   └── vite.svg
└── src/                ← 你的原始碼
    ├── main.ts         ← JS 應用的進入點
    ├── style.css
    ├── counter.ts
    └── typescript.svg
```

### `index.html` —— 為什麼它在「根目錄」而不是 src 裡?

這是 Vite 跟 Webpack **最不一樣、也最容易讓人困惑**的地方,務必搞懂。

打開 `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <title>Vite App</title>
  </head>
  <body>
    <div id="app"></div>
    <!-- ⭐ 重點在這行 -->
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

注意那行 `<script type="module" src="/src/main.ts">`:

- **`type="module"`**:告訴瀏覽器「這是一個 ES Module」,於是瀏覽器會啟用原生 ESM 模式——還記得第 00 章嗎?這正是 Vite 整套 dev 機制的起點。
- **`src="/src/main.ts"`**:這裡居然直接寫了 `.ts`!瀏覽器明明看不懂 TypeScript。這就是 Vite 的工作:**當瀏覽器來要 `/src/main.ts` 時,Vite dev server 會即時把它轉成瀏覽器看得懂的 JS 再回傳**(第 04 章詳解)。

**Webpack 思維 vs Vite 思維(關鍵差異)**:

| | Webpack | Vite |
|---|---------|------|
| 入口是什麼 | JS 檔(`entry: src/index.js`) | **HTML 檔(`index.html`)** |
| HTML 的角色 | 用 plugin 把打包好的 JS「插進」HTML | HTML 本身就是入口,Vite 去解析它裡面的 `<script>` |
| 心智模型 | 「打包 JS,再把 JS 塞進網頁」 | 「網頁就是起點,順著它的 script 往下抓」 |

**白話翻譯**:Vite 把 `index.html` 當成「地圖的起點」。它讀這個 HTML,看到 `<script src="/src/main.ts">`,就知道「喔,要從 main.ts 開始順藤摸瓜」。這跟瀏覽器實際載入網頁的方式是一致的——所以 Vite 的 dev 行為非常貼近真實瀏覽器。

> **常見錯誤**:很多從 Webpack 來的人,習慣把 `index.html` 放進 `src/`,結果 Vite 找不到入口。記住:**`index.html` 預設要放在專案根目錄**。

### `package.json` —— 指令與依賴的清單

```json
{
  "name": "my-vite-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "typescript": "~5.6.0",
    "vite": "^7.0.0"
  }
}
```

逐行解釋幾個重點欄位:

- **`"type": "module"`**:告訴 Node「這個專案的 `.js` 檔請當成 ESM 來解讀」。**為什麼重要?** 因為 `vite.config.ts` 裡你會寫 `import { defineConfig } from 'vite'`,要能用 `import` 語法,就需要這行(或把設定檔副檔名改成 `.mts`)。
- **`scripts`**:這就是 `npm run xxx` 背後實際執行的指令,下一節 1.4 專門講。
- **`devDependencies`**:`vite` 和 `typescript` 都放在這裡,而不是 `dependencies`。**為什麼?** 因為它們只在「開發 / 建構」時需要,你的程式真正上線跑的時候(那些 dist 裡的檔案)用不到 Vite 本身。`devDependencies` 的東西在 `npm install --production` 時會被跳過。
- **`"private": true`**:防止你手滑 `npm publish` 把專案發佈到公開 npm。

### `vite.config.ts` —— 本課程的主角

`vanilla-ts` 模板可能沒有這個檔(因為 Vanilla 不需要設定),但我們手動建一個,因為整門課都圍繞它。在根目錄建立:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

// defineConfig 是一個「身分函式」:它原樣回傳你傳進去的設定物件,
// 唯一的作用是讓編輯器有完整的 TypeScript 型別提示與自動補全。
// 不用它也行(直接 export default {...}),但用了寫設定會輕鬆很多。
export default defineConfig({
  // 這裡之後會放各種設定:plugins、server、build、resolve...
  // 現在先留空,代表全部用預設值。
})
```

**為什麼用 `defineConfig` 而不是直接 `export default {}`?**

直接 `export default {}` 也能跑,但你打 `server.` 的時候編輯器不會提示有哪些選項。`defineConfig` 幫物件套上了 Vite 的型別定義,於是你打字時會跳出所有合法選項——這在你不熟 API 時超級有用。**它沒有任何執行期魔法,純粹是給型別用的。**

> 補充:設定檔可以是 `vite.config.js`、`.ts`、`.mjs`、`.mts`。用 `.ts` 最常見。Vite 啟動時會自己先把這個設定檔轉譯一次再讀取,所以你能在裡面用 TS 和 ESM。

### `tsconfig.json` —— 給 TypeScript 看的,不是給 Vite 看的

這裡有個**極重要、極多人搞錯**的觀念:

> **Vite 在 dev 階段「不做型別檢查」。**

Vite 用 esbuild 把 `.ts` 轉成 `.js` 時,做的是「**剝掉型別語法**(type stripping)」,而**不是「檢查型別對不對」**。也就是說,你寫 `const x: number = "字串"` 這種型別錯誤,**Vite dev 不會報錯,照樣跑給你看**。

**為什麼 Vite 故意不檢查型別?** 因為型別檢查很慢,會拖垮「即時轉譯」的速度。Vite 的哲學是:速度優先,型別檢查交給專門的工具(`tsc`)或編輯器(VS Code 會即時標紅)。

這也解釋了為什麼 `build` 指令長這樣:

```json
"build": "tsc && vite build"
```

- `tsc`(更常見是 `tsc --noEmit` 或 `vue-tsc`):**只做型別檢查**,確認沒有型別錯誤。
- `&&`:前面成功才執行後面。所以**型別有錯就會中斷,不會打包出有問題的產物**。
- `vite build`:真正的打包。

**心智模型**:Vite 負責「把程式碼變成能跑的樣子」(快),`tsc` 負責「確認程式碼型別對不對」(慢但嚴謹)。兩件事分開,各司其職。

### `public/` 與 `src/` 的差別

- **`src/`**:你的原始碼。裡面 `import` 進來的東西**都會經過 Vite 處理**(轉譯、加 hash、最佳化)。
- **`public/`**:放「不想被處理、要原樣輸出」的靜態檔(例如 `robots.txt`、`favicon`、第三方寫死路徑的檔)。裡面的東西會**原封不動**複製到輸出目錄,引用時用根路徑 `/檔名`。

這兩者的差異第 04 章會深入講(包含「為什麼有時候圖片要放 public、有時候要 import」),這裡先有個印象。

---

## 1.4 dev / build / preview 三個指令徹底分清楚

這三個指令對應第 00 章「雙引擎」的不同階段,**搞混它們是新手最大的困惑來源**,我們一個一個講透。

### `vite`(即 `npm run dev`)—— 開發引擎

```bash
npm run dev
```

- **做什麼**:啟動一個開發伺服器(預設 `http://localhost:5173`)。
- **背後引擎**:第 00 章講的「不打包」那一套——瀏覽器原生 ESM + esbuild 即時轉譯 + 依賴預打包 + HMR。
- **特性**:啟動秒級、改檔即時更新(HMR)、**不產生任何檔案到硬碟**(東西都在記憶體裡即時轉)。
- **用途**:你每天 90% 的時間都待在這。

### `vite build`(即 `npm run build`)—— 生產引擎

```bash
npm run build
```

- **做什麼**:用 **Rollup** 把整個專案打包、壓縮、最佳化,輸出到 `dist/` 資料夾。
- **背後引擎**:跟 dev 完全是兩套東西!這裡是 Rollup,認真做 tree shaking、code splitting、壓縮、檔名加 hash。
- **產出**:`dist/` 裡是一堆優化過、可直接丟到任何靜態伺服器的檔案。

打包完去看 `dist/`:

```
dist/
├── index.html
└── assets/
    ├── index-a1b2c3d4.js     ← 檔名帶了一段 hash
    └── index-e5f6g7h8.css
```

> **為什麼檔名要加一段亂碼(hash)?** 這叫「快取破壞(cache busting)」。瀏覽器會快取靜態檔。如果檔名永遠是 `index.js`,你改了程式重新上線,使用者瀏覽器可能還用舊的快取。而把內容的雜湊值寫進檔名,內容一變、檔名就變,瀏覽器就會視為新檔重新下載。內容沒變則檔名不變,快取繼續生效。第 08 章詳解。

### `vite preview`(即 `npm run preview`)—— 預覽「已打包」的結果

```bash
npm run build      # 先 build,產生 dist/
npm run preview    # 再 preview
```

- **做什麼**:起一個簡單的本機伺服器,**把 `dist/` 裡打包好的東西**跑給你看(預設 `http://localhost:4173`)。
- **重點**:它跑的是「**build 後的產物**」,不是你的原始碼。

**為什麼需要 preview?它跟 dev 差在哪?**

這是關鍵。`dev` 跑的是「未打包的原始碼 + 即時轉譯」,而真正上線的是「`build` 打包後的產物」。**這兩者是不同引擎,偶爾行為會不一致**(第 00 章埋的伏筆,這裡兌現了)。

例如:某段程式碼在 `dev` 好好的,`build` 後卻壞掉(可能是依賴某個只在 dev 才有的行為、或 tree shaking 把你以為會留著的東西砍了)。`preview` 就是讓你在「丟上正式環境之前」,先在本機驗證「打包後的版本真的能跑」。

> **心智模型一句話**:
> - `dev` = 開發時用,跑原始碼,快、有 HMR。
> - `build` = 產生上線檔案,跑 Rollup,慢但優化。
> - `preview` = 在本機檢查 build 出來的東西對不對,**preview 不是用來開發的**。

### 三者對照表

| 指令 | 引擎 | 跑的是什麼 | 產生檔案? | 主要用途 |
|------|------|-----------|-----------|----------|
| `vite`(dev) | esbuild + 原生 ESM | 未打包的原始碼 | ❌(記憶體) | 日常開發 |
| `vite build` | Rollup | — | ✅ 輸出 `dist/` | 產生上線檔案 |
| `vite preview` | 簡易靜態伺服器 | `dist/` 的產物 | ❌ | 驗證打包結果 |

---

## 1.5 vite.config.ts 常用設定速覽(先建立地圖)

設定的細節會散落在後面各章,但這裡先給你一張「全貌地圖」,讓你知道一個設定檔大概長怎樣、各區塊管什麼。**現在不用背,看過有印象即可**,之後遇到再回來查。

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  // 1. plugins:外掛陣列。框架支援(@vitejs/plugin-vue / -react)都是 plugin。
  //    第 06、07 章整整兩章在講這個。
  plugins: [],

  // 2. server:dev server 的設定。
  server: {
    port: 5173,          // 開發伺服器埠號
    open: true,          // 啟動時自動開瀏覽器
    proxy: {             // 代理:把某些 API 請求轉發到後端,解決開發時的跨域問題
      '/api': 'http://localhost:8080',
    },
  },

  // 3. resolve:模組怎麼被「找到」。
  resolve: {
    alias: {
      // 設定路徑別名:讓你用 @/utils 代替 ../../../src/utils
      '@': '/src',
    },
  },

  // 4. build:生產建構(Rollup)的設定。第 08 章詳解。
  build: {
    outDir: 'dist',      // 輸出目錄
    sourcemap: false,    // 是否產生 source map
  },

  // 5. css:CSS 相關(預處理器、modules、postcss)。第 04 章會碰到。
  css: {},

  // 6. optimizeDeps:依賴預打包的設定。第 03 章的主角。
  optimizeDeps: {},
})
```

這六個區塊就是你 90% 會動到的設定。把它們對應到第 00 章的雙引擎:

- `server`、`optimizeDeps` → 偏 **dev** 引擎。
- `build` → 偏 **生產** 引擎。
- `plugins`、`resolve`、`css` → 兩邊都會用到。

---

## 1.6 本章小結與下一步

這一章我們把專案跑起來,並且:

- 學會用 `create-vite` 建專案,理解每個指令參數。
- 拆解了專案結構,**重點搞懂「為什麼 `index.html` 是入口、且放在根目錄」**(Vite vs Webpack 的核心差異)。
- 釐清了**「Vite dev 不做型別檢查」**,所以 `build` 要先跑 `tsc`。
- **徹底分清 `dev` / `build` / `preview` 三個指令**,以及它們對應的不同引擎。
- 看過 `vite.config.ts` 的全貌地圖。

**下一章(02)是整門課的技術核心**:我們會打開瀏覽器 DevTools 的 Network 面板,**親眼驗證「dev 真的沒打包」**——你會看到瀏覽器一個一個去抓 `.ts` 模組,而 Vite 即時把它們轉成 ESM 回傳。第 00 章講的理論,第 02 章變成你眼前的事實。

> 💡 **動手作業**:現在就把專案跑起來(`npm run dev`),記下你的 `ready in xxx ms`。然後試著 `npm run build` 再 `npm run preview`,打開 `dist/` 資料夾看看打包後的檔案長怎樣。帶著這個體感進第 02 章。
