# 第 06 章:Plugin 系統(上)—— Rollup 相容 hook

> 前五章你可能以為「框架支援、CSS 處理、那些 import 字尾」是 Vite 內建的魔法。
> 真相是:**Vite 的核心很小,絕大多數能力都是 plugin 做的**,連 `@vitejs/plugin-vue` 也只是一個 plugin。
> 這一章先打地基:Vite 的 plugin 為什麼「長得跟 Rollup plugin 一樣」?
> 一個模組從「被請求」到「變成瀏覽器能用的 JS」,中間經過哪些 hook?
> 我們會親手寫一個 plugin,並理解 `resolveId` / `load` / `transform` 這三個最核心的 hook 與「虛擬模組」。

---

## 6.1 先建立一個顛覆認知的事實:Vite 核心很小

很多人以為 Vite 是一個無所不包的大工具。其實相反:

> **Vite 的核心只做最基礎的事(dev server、模組請求、HMR 框架),其他幾乎所有功能都是 plugin 提供的。**

證據:你用過的這些,全都是 plugin——

- `@vitejs/plugin-vue`:讓 Vite 看懂 `.vue` 檔。
- `@vitejs/plugin-react`:讓 Vite 支援 JSX + React Fast Refresh(第 05 章那個)。
- `@vitejs/plugin-legacy`:讓打包產物相容舊瀏覽器。

甚至 Vite 處理 CSS、靜態資源、依賴預打包的內部邏輯,本身也是用一組「內建 plugin」實作的。

**為什麼要設計成這樣?** 這是軟體設計的經典智慧——**「小核心 + 外掛生態」**:

- 核心保持小而穩定,不會因為要支援一堆框架而變得臃腫。
- 任何人都能寫 plugin 擴充能力,不必改 Vite 原始碼。
- 你只裝你需要的,不背負用不到的功能。

> **心智模型**:Vite 像一支「主機板」,plugin 是「插卡」。主機板本身只提供插槽和匯流排,要支援 Vue 就插一張 Vue 卡,要支援 React 就插一張 React 卡。學會 plugin = 學會自己做插卡。

---

## 6.2 為什麼 Vite plugin「長得像 Rollup plugin」?

這是理解整個 plugin 系統的關鍵歷史背景,務必搞懂。

回憶第 00 章:Vite 的**生產建構用 Rollup**。Rollup 本身有一套非常成熟、設計優良的 plugin 系統,生態裡已經有上千個現成的 Rollup plugin。

當 Vite 團隊要設計自己的 plugin 系統時,他們做了一個聰明的決定:

> **不另創一套,而是「相容 Rollup 的 plugin 介面」,再額外加上幾個 Vite 專屬的 hook。**

這帶來兩個巨大好處:

1. **直接繼承 Rollup 的整個 plugin 生態**:很多 Rollup plugin 不用改就能在 Vite 用。
2. **dev 和 build 用「同一套 plugin 介面」**:你寫一個 plugin,dev(Vite 自己跑這套 hook)和 build(Rollup 跑這套 hook)都能用,不用寫兩份。

於是 Vite 的 plugin 介面 = **Rollup hook(這一章)+ Vite 專屬 hook(第 07 章)**。

> **一個重要的認知校正**:dev 階段其實是 **Vite 自己實作了一個「Rollup 相容的 plugin 容器(plugin container)」**,在按需轉譯每個模組時去跑這些 hook;build 階段才是真正的 Rollup 在跑這些 hook。所以**同一個 plugin,在 dev 和 build 跑的「執行者」不同**,但「介面」一樣。這也是某些 plugin「dev 正常、build 出錯」的根源(又回扣第 00 章雙引擎主題)。

---

## 6.3 一個模組的生命週期:三個核心 hook

當一個模組被請求(dev)或被打包(build),它會依序流經幾個 hook。我們聚焦三個最核心、最常用的:**`resolveId` → `load` → `transform`**。

先用一句話記住它們在回答什麼問題:

```
import 'foo' 出現了,Vite/Rollup 依序問三個問題:

  ① resolveId:「'foo' 這個 id 到底對應到哪裡?」      → 解析出真實 id / 路徑
  ② load:      「這個 id 的『原始內容』是什麼?」        → 給出原始碼字串
  ③ transform: 「拿到內容後,要怎麼『加工』它?」        → 回傳加工後的碼
```

用一個生活比喻串起來:

```
你跟圖書館員說「我要『那本書』」
  ① resolveId = 館員幫你確認「那本書」的確切館藏編號(從模糊名字 → 確切位置)
  ② load      = 館員去書架把那本書「拿出來」(取得原始內容)
  ③ transform = 你拿到書後在上面「畫重點、翻譯」(加工內容)
```

下面逐一拆解。

### Hook 1:`resolveId` —— 解析「id 對應到哪」

當程式碼出現 `import x from 'something'`,`'something'` 這個字串叫 **module id(模組識別字)**。`resolveId` 的工作是把這個(可能很模糊的)id**解析成一個確切的、後續找得到的 id**。

```js
function myPlugin() {
  return {
    name: 'my-plugin',                    // plugin 一定要有 name,報錯時才知道是誰
    resolveId(source, importer) {
      // source:被 import 的字串,例如 'something'、'./utils'、'vue'
      // importer:是「誰」import 它的(發起這次 import 的檔案路徑)

      if (source === 'virtual:my-module') {
        // 回傳一個非 null 值 = 「我認得它,我來負責解析」
        // 後續的 load 就會拿這個回傳的 id 來問「內容是什麼」
        return source
      }
      // 回傳 null / undefined = 「我不管它,交給下一個 plugin 或預設邏輯」
      return null
    },
  }
}
```

**重點理解**:

- `resolveId` 是一條「責任鏈」。每個 plugin 都有機會說「這個 id 我認得、我來解析」(回傳非 null),或「不關我事」(回傳 null,往下傳)。
- 回傳 `null` 時,最終會交給 Vite/Rollup 的**預設解析**(例如把 `'vue'` 解析到 `node_modules` 裡——這正是第 02/03 章「裸匯入解析」的底層機制,它其實就是內建 plugin 的 `resolveId` 在做)。

### Hook 2:`load` —— 給出「原始內容」

`resolveId` 確定了 id 之後,`load` 負責回傳這個 id 的**原始內容字串**。

```js
load(id) {
  // id 是 resolveId 解析出來的結果
  if (id === 'virtual:my-module') {
    // 回傳字串 = 這就是該模組的原始碼(不用真的有這個檔案!)
    return 'export const msg = "我是憑空生出來的模組"'
  }
  // 回傳 null = 「我不提供內容」,交給下一個 plugin 或預設邏輯(從硬碟讀檔)
  return null
}
```

**重點理解**:

- 對一般檔案(如 `main.ts`),沒有任何 plugin 的 `load` 處理它時,**預設行為就是「從硬碟把檔案讀進來」**。
- 但 `load` 可以回傳**任何字串**,不需要對應真實檔案——這就引出了下面的「虛擬模組」。

### Hook 3:`transform` —— 加工內容

`transform` 拿到模組的內容(`load` 給的,或預設讀檔讀到的),對它做**加工轉換**,回傳新的內容。**這是最常用的 hook。**

```js
transform(code, id) {
  // code:模組目前的內容字串
  // id:這個模組的 id

  if (id.endsWith('.special')) {
    // 對 .special 檔做一些處理,回傳新的 code
    const transformed = doSomething(code)
    return {
      code: transformed,
      map: null,        // source map(沒有就 null,有的話放這裡讓除錯能對回原始碼)
    }
  }
  return null           // null = 不改它,原樣放行
}
```

**重點理解**:

- 第 04 章講的「esbuild 把 TS 剝型別」「CSS 包成 JS 注入」——這些**本質上都是 `transform` hook 在做的事**(由 Vite 內建 plugin 實作)。你現在看到了它們的底層長相。
- `transform` 可以被多個 plugin **串接**:plugin A 轉一手、把結果交給 plugin B 再轉一手(順序由第 07 章的 `enforce` 與 plugin 排列決定)。

### 三個 hook 的完整流程圖

```
import 'foo' 被遇到
        │
        ▼
┌──────────────┐   每個 plugin 依序問:這個 id 我認得嗎?
│  resolveId   │   有人回傳非 null → 用它;全都 null → 預設解析(找 node_modules / 相對路徑)
└──────┬───────┘
       │ 得到確切 id
       ▼
┌──────────────┐   每個 plugin 依序問:這個 id 的內容我來給嗎?
│    load      │   有人回傳字串 → 用它;全都 null → 預設(從硬碟讀檔)
└──────┬───────┘
       │ 得到原始內容
       ▼
┌──────────────┐   每個 plugin 依序加工這段內容(可串接多手)
│  transform   │   TS 剝型別、CSS 轉 JS、自訂處理... 都在這層
└──────┬───────┘
       │ 得到最終 JS
       ▼
  回傳給瀏覽器(dev)/ 進入打包(build)
```

> **把這張圖記牢**。後面寫任何 plugin、讀任何 plugin 原始碼,你都是在這三個 hook 上做文章。第 04 章的轉換管線,本質就是「一串 plugin 的 resolveId/load/transform 接力」。

---

## 6.4 虛擬模組(Virtual Module):憑空造一個模組

`resolveId` + `load` 合起來,能做一件很強的事:**造出一個「硬碟上根本不存在」的模組**。這叫**虛擬模組**,是 plugin 的高頻用法。

### 為什麼需要虛擬模組?

很多時候你想 `import` 一些「不是來自檔案、而是程式動態生成」的東西。例如:

- 把 build 時間、git commit hash 注入程式:`import { buildTime } from 'virtual:build-info'`
- 把一組設定彙整成一個模組讓全專案 import。
- 框架/工具自動生成路由表:`import routes from 'virtual:routes'`(很多 plugin 都這樣做)。

這些東西沒有對應的實體檔案,但你想用 `import` 的方式取用它。虛擬模組就是答案。

### 完整範例:一個提供「建構資訊」的虛擬模組

```js
// vite.config.ts 裡,或獨立成一個檔案
function buildInfoPlugin() {
  // 約定:虛擬模組 id 慣例用 'virtual:' 開頭
  const virtualModuleId = 'virtual:build-info'
  // 解析後的 id 慣例加一個 '\0' 前綴(null byte),
  // 用來告訴其他 plugin「這是虛擬模組,別把它當真實檔案去碰(例如別想讀檔)」
  const resolvedId = '\0' + virtualModuleId

  return {
    name: 'build-info',

    // ① 有人 import 'virtual:build-info' 時,我認得,回傳帶 \0 的解析 id
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedId
      }
    },

    // ② 當要載入這個解析後的 id,我回傳「憑空生成」的原始碼字串
    load(id) {
      if (id === resolvedId) {
        // 這段字串就是該模組的內容,完全由程式生成
        return `
          export const builtAt = "2026-06-22T10:00:00Z"
          export const version = "1.0.0"
        `
      }
    },
  }
}

// 使用:
export default defineConfig({
  plugins: [buildInfoPlugin()],
})
```

在程式裡就能這樣用:

```js
import { builtAt, version } from 'virtual:build-info'
console.log(`版本 ${version},建構於 ${builtAt}`)
```

**逐點解釋這個範例的精髓**:

- **沒有任何 `virtual:build-info` 的檔案存在**,但你能 `import` 它——因為 `resolveId` 認領了這個 id,`load` 提供了它的內容。
- **`\0`(null byte)前綴的慣例**:Rollup 生態約定,虛擬模組解析後的 id 加一個 `\0`。為什麼?因為其他 plugin(或 Vite 內建邏輯)可能會「對所有 id 嘗試讀檔/處理副檔名」,`\0` 是個明確信號:「這不是真實路徑,別對它做檔案系統操作」。這能避免一堆詭異的衝突。
- **`virtual:` 前綴的慣例**:讓使用者一眼看出「這是虛擬模組,不是真檔案」,也避免跟真實路徑撞名。

> **心智模型**:`resolveId` 是「我認領這個名字」,`load` 是「這個名字的內容由我憑空提供」。兩者一搭,你就能把任何「程式算出來的東西」偽裝成一個可以被 `import` 的模組。這是 plugin 最有威力的模式之一。

---

## 6.5 動手寫第一個有用的 plugin

理論夠了,我們寫一個真正能跑、又能說明 `transform` 的 plugin:**把程式碼裡所有 `__BUILD_DATE__` 字串替換成實際日期**。

```js
// plugins/replace-build-date.js
function replaceBuildDate(dateString) {
  return {
    name: 'replace-build-date',     // 必填:出問題時的識別名

    transform(code, id) {
      // 只處理 JS/TS 檔,跳過 node_modules(別去動第三方套件)
      if (!/\.(js|ts)$/.test(id)) return null
      if (id.includes('node_modules')) return null

      // 程式碼裡沒有這個關鍵字就不動,省效能
      if (!code.includes('__BUILD_DATE__')) return null

      // 做替換
      const transformed = code.replaceAll('__BUILD_DATE__', JSON.stringify(dateString))

      // 回傳新 code(map: null 表示不提供 source map)
      return { code: transformed, map: null }
    },
  }
}

export default replaceBuildDate
```

```js
// vite.config.ts
import replaceBuildDate from './plugins/replace-build-date.js'

export default defineConfig({
  // 注意:傳入時間字串,而不是在 plugin 內呼叫 new Date()——
  // 這樣每次 build 的值才可控、可重現(回扣工程化思維)
  plugins: [replaceBuildDate('2026-06-22')],
})
```

在程式裡:

```js
console.log('這個版本建構於:' + __BUILD_DATE__)
// transform 後變成:console.log('這個版本建構於:' + "2026-06-22")
```

**這個小 plugin 教會你的事**:

1. `transform` 是「攔截每個模組的內容,動手改它」的地方。
2. **務必加守衛條件**(副檔名、`node_modules`、關鍵字檢查)——`transform` 對**每個模組**都會被呼叫,不加守衛會白白拖慢建構,還可能誤改不該改的檔。
3. plugin 本質是「一個回傳物件的函式」,物件裡是一堆 hook。包成函式是為了能傳參數(像這裡的 `dateString`)。

> **常見錯誤**:在 `transform` 裡不分青紅皂白處理所有模組(包含 `node_modules` 裡成千上萬的檔),導致建構變慢、或意外改壞第三方套件。**第一件事永遠是用 `id` 做過濾。**

---

## 6.6 hook 的兩種型別:同步資料 vs 副作用

Rollup/Vite 的 hook 大致分兩類,理解這個分類有助於你讀懂各種 plugin:

| 類型 | 代表 hook | 它在做什麼 |
|------|-----------|-----------|
| **解析/載入/轉換**(本章) | `resolveId` / `load` / `transform` | 影響「模組內容」,有回傳值、會串接 |
| **建構生命週期** | `buildStart` / `buildEnd` / `closeBundle` 等 | 在建構的某個時間點做事(印 log、清理、產生額外檔案),通常無回傳值或不影響模組內容 |

例如:

```js
{
  name: 'lifecycle-demo',
  buildStart() {
    // 整個建構開始時跑一次,適合做初始化
    console.log('開始建構了')
  },
  buildEnd() {
    // 所有模組處理完時跑,適合收尾統計
    console.log('模組都處理完了')
  },
}
```

這些生命週期 hook 第 08 章(生產建構)會再用到。這裡你只要知道「hook 不只有改內容的那三個,還有管時間點的那一類」即可。

---

## 6.7 本章小結與下一步

這一章打好了 plugin 的地基:

- **認知校正**:Vite 核心很小,框架支援、CSS 處理全是 plugin;學 plugin = 學會擴充 Vite。
- **歷史背景**:Vite plugin 相容 Rollup 介面,所以能繼承整個 Rollup 生態,且 dev/build 共用一套介面(但執行者不同——dev 是 Vite 的 plugin container,build 是 Rollup)。
- **三個核心 hook**:`resolveId`(id 對應到哪)→ `load`(原始內容是什麼)→ `transform`(怎麼加工),這就是第 04 章轉換管線的底層。
- **虛擬模組**:用 `resolveId` + `load` 憑空造一個可被 import 的模組,`virtual:` 與 `\0` 前綴的慣例。
- **動手寫了 plugin**,學到「一定要用 id 過濾」的鐵則。
- **hook 兩大類**:改內容的(resolveId/load/transform)vs 管生命週期的(buildStart 等)。

**下一章(07)**,進入 Plugin 系統的另一半——**Vite 專屬能力**:`config`(改設定)、`configureServer`(掛 dev server 中介層,例如做 mock API)、`transformIndexHtml`(改 HTML)、`handleHotUpdate`(自訂 HMR 行為,接回第 05 章)。還會講 plugin 的**執行順序**(`enforce: 'pre' / 'post'`)和**只在某階段生效**(`apply: 'build' / 'serve'`)——這些是讓多個 plugin 正確協作的關鍵。

> 💡 **動手作業**:① 把 6.4 的虛擬模組 plugin 加進你的專案,`import` 它並印出來,確認真的拿得到「不存在的檔案」的內容。② 把 6.5 的 `replaceBuildDate` 寫進去跑跑看,然後故意拿掉 `id` 的守衛條件,觀察建構是否變慢、或有沒有東西被誤改。
