# 第 05 章:HMR 熱更新原理

> 你改一行 code,畫面**不刷新整頁**就更新了,而且輸入框的內容、彈窗的開關狀態都還在——這就是 HMR(Hot Module Replacement,模組熱替換)。
> 這是 Vite dev 體驗的靈魂。這一章我們把它徹底拆開:
> 第 02 章那個 `@vite/client` 在幹嘛?module graph 是什麼?「HMR 邊界」怎麼決定要更新哪裡、何時整頁重載?
> `import.meta.hot` API 怎麼用?Vue/React 又是怎麼接上 HMR 的?
> 搞懂這章,你就掌握了「手寫 mini-vite」最後一塊核心。

---

## 5.1 先分清三個容易混淆的詞

開始前,把三個常被混用的詞釘清楚,否則整章會亂:

| 名詞 | 意思 | 體驗 |
|------|------|------|
| **整頁重載(Full Reload)** | 整個頁面重新整理(等同按 F5) | 狀態全失:輸入框清空、捲動位置回頂、彈窗關閉 |
| **Live Reload** | 偵測到檔案變動,自動幫你按 F5 | 比手動 F5 方便,但狀態一樣全失 |
| **HMR(熱替換)** | 只替換「變動的那個模組」,**頁面不重載、狀態保留** | 改 code,畫面局部更新,輸入框內容還在 ✅ |

**HMR 的價值就在「狀態保留」**。想像你在除錯一個多步驟表單,填到第 3 步、開了個彈窗,這時你改了一行樣式:

- Live Reload:整頁刷新,表單清空、彈窗關閉,你得重填重點一次。😤
- HMR:樣式即時更新,表單和彈窗**原封不動**。😍

這一章講的就是 HMR 如何做到「精準替換 + 狀態保留」。

---

## 5.2 HMR 的兩個角色:client 與 server

HMR 是一場「伺服器」和「瀏覽器」之間的即時對話。需要兩個角色:

```
┌──────────────────┐         WebSocket          ┌──────────────────┐
│  Vite Dev Server  │ ◀───────(長連線)────────▶ │  瀏覽器             │
│  (Node.js 端)     │                            │  @vite/client      │
│                   │                            │  (Vite 注入的程式) │
│  - 監看檔案變動    │  ──── "檔案 X 變了" ────▶   │  - 收到通知         │
│  - 算出影響範圍    │                            │  - 去重新抓 X       │
│  - 通知瀏覽器      │                            │  - 套用更新         │
└──────────────────┘                            └──────────────────┘
```

### 角色 1:`@vite/client`(瀏覽器端)

還記得第 02 章 Network 面板那個 `@vite/client` 嗎?謎底揭曉:**它就是 Vite 自動注入到你頁面的一小段 JS,專門負責 HMR 的瀏覽器端工作**。它做三件事:

1. 頁面一載入,就跟 dev server 建立一條 **WebSocket** 長連線。
2. 持續**監聽**伺服器透過這條連線發來的訊息。
3. 收到「某模組更新了」的訊息,執行對應的更新動作(重抓模組、套用、或整頁重載)。

> **為什麼是 WebSocket?** 因為 HMR 需要「伺服器**主動推**訊息給瀏覽器」(檔案變了要立刻通知)。一般 HTTP 是瀏覽器問、伺服器才答,做不到主動推。WebSocket 是雙向長連線,伺服器可以隨時推訊息過來。(本倉庫 [common/websocket.md](../common/websocket.md) 有 WebSocket 的詳細說明。)

### 角色 2:Dev Server(Node.js 端)

Vite dev server 用檔案監看器(file watcher)盯著你的專案檔案。一旦你存檔,它就:

1. 知道「哪個檔案變了」。
2. 查它的「module graph」,算出「這個變動會影響哪些模組、要怎麼更新」(下一節)。
3. 透過 WebSocket 把更新指令推給 `@vite/client`。

---

## 5.3 關鍵資料結構:Module Graph(模組依賴圖)

要做到「精準只更新受影響的部分」,Vite 必須隨時知道「**誰 import 了誰**」。它在記憶體裡維護一張圖,叫 **module graph**。

每處理一個模組(第 02 章講的「按需轉譯」過程中),Vite 都會記錄它的依賴關係,建立兩個方向的連結:

```
假設依賴關係是:
  main.ts  →  import App.tsx  →  import Button.tsx
                              →  import utils.ts

Vite 的 module graph 會記住「雙向」關係:

  importers(誰 import 了我 / 父節點):
     Button.tsx 的 importers = [App.tsx]
     utils.ts   的 importers = [App.tsx]
     App.tsx    的 importers = [main.ts]

  importedModules(我 import 了誰 / 子節點):
     App.tsx 的 importedModules = [Button.tsx, utils.ts]
```

**為什麼要記「importers」(誰 import 我)這個反向關係?這是 HMR 的命脈。**

當 `Button.tsx` 變了,Vite 要回答一個問題:「**這個變動該由誰來處理?**」答案藏在反向關係裡——它要**從 Button.tsx 往上(往 importers 方向)走**,去找「有能力處理這個更新的模組」。這個「往上找」的過程,就是下一節的「HMR 邊界」。

> **心智模型**:module graph 是一張「誰依賴誰」的雙向地圖。檔案變動時,Vite 拿著這張地圖,從變動點往上游追溯,找出「更新的責任邊界在哪」。沒有這張圖,Vite 就只能傻傻地整頁重載。

---

## 5.4 HMR 邊界(boundary):決定「更新到哪裡為止」

這是 HMR 最核心、也最精妙的概念。我們用一個情境慢慢推。

### 問題:模組變了,要更新到多廣?

當 `Button.tsx` 變了,理論上有很多選擇:

- 只更新 `Button.tsx` 本身?
- 連 import 它的 `App.tsx` 一起更新?
- 整頁重載最保險?

答案取決於一件事:**「沿著 importers 往上找,誰『宣告』了自己能處理(接住)這個熱更新?」** 那個「能接住」的模組,就是 **HMR 邊界(boundary)**。

### 「能接住更新」是什麼意思?—— `import.meta.hot.accept`

一個模組要宣告「我能處理自己的熱更新」,就要呼叫 `import.meta.hot.accept(...)`。我們先看一個極簡的純手寫例子(框架會幫你自動做這件事,但先理解原理):

```js
// counter.js
export function setupCounter(el) { /* ... */ }

// ⭐ 宣告「這個模組能接住自己的熱更新」
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    // 當 counter.js 變動時,這個 callback 會被呼叫,
    // newModule 是「更新後的新版 counter.js」。
    // 你在這裡決定「拿到新版後要做什麼」——通常是用新邏輯重新初始化,
    // 而不必刷新整頁。
    newModule.setupCounter(document.querySelector('#counter'))
  })
}
```

逐行解釋:

- `if (import.meta.hot)`:`import.meta.hot` 這個物件**只在 dev 存在**(build 時是 `undefined`)。這個 if 保證這段 HMR 程式碼**只在開發跑、不會進到上線產物**。這是固定寫法。
- `import.meta.hot.accept(callback)`:對 Vite 喊「**我這個模組自己能處理更新,別往上傳、別整頁重載**」。於是 `counter.js` 就成了一個 **HMR 邊界**。
- `callback(newModule)`:當 `counter.js` 被改動,Vite 重新編譯出新版,透過 WebSocket 通知瀏覽器,`@vite/client` 重新抓新版模組,然後呼叫這個 callback,把新版交給你。你在裡面用新邏輯更新畫面——**頁面不重載,狀態保留**。

### 完整流程:從存檔到畫面更新

把 5.2、5.3、5.4 串起來,一次 HMR 的完整旅程:

```
① 你存檔修改 counter.js
        ↓
② Dev server 的 file watcher 偵測到 counter.js 變了
        ↓
③ Vite 重新轉譯 counter.js(只轉這一個!按需,第 02 章)
        ↓
④ Vite 查 module graph,從 counter.js 往上游(importers)找 HMR 邊界:
   - counter.js 自己有呼叫 import.meta.hot.accept 嗎?
     → 有!那 counter.js 就是邊界,更新到此為止,不用再往上。
        ↓
⑤ Vite 透過 WebSocket 推訊息給瀏覽器:
   「counter.js 更新了,新版在這個網址:/counter.js?t=時間戳」
        ↓
⑥ @vite/client 收到,用新網址重新 import 新版 counter.js
   (注意網址帶了 ?t=時間戳,確保瀏覽器抓新版而非快取,回扣第 03 章的快取破壞概念)
        ↓
⑦ @vite/client 呼叫 counter.js 當初註冊的 accept callback,
   把新版模組交給它 → 你的 callback 用新邏輯更新畫面
        ↓
⑧ 完成!頁面沒重載,其他狀態(輸入框、捲動位置)全部保留 ✅
```

### 找不到邊界怎麼辦?—— 往上一直找,找不到就整頁重載

關鍵在步驟 ④。如果 `counter.js` **沒有**呼叫 `accept`,Vite 就沿著 importers 往上問:

```
counter.js 變了,但它沒 accept
   → 往上問它的 importer:main.js
      → main.js 有 accept 嗎?也沒有
         → main.js 是入口,再往上沒有了
            → 找不到任何邊界
               → 沒辦法,只能「整頁重載(full reload)」🔄
```

> **這解釋了一個你一定遇過的現象**:「為什麼有時候改 code 是無痛 HMR,有時候卻整頁刷新?」
> - 改的模組(或其上游)**有人宣告 accept** → 找得到邊界 → 無痛 HMR。
> - 一路往上**都沒人 accept** → 找不到邊界 → 整頁重載。
>
> 而你平常寫 Vue/React 元件,改了就無痛更新——那是因為框架的 plugin **自動幫你的元件注入了 accept**(下一節講)。

> **心智模型**:HMR 邊界就像「水往上漫,直到遇到一個能接住它的盤子」。盤子(accept)接住了,更新就停在那層;一路沒有盤子,水漫到頂(入口)溢出來,就只好整頁重載。

---

## 5.5 框架怎麼接上 HMR(Vue / React)

你寫 Vue/React 時,從來沒手寫過 `import.meta.hot.accept`,但 HMR 就是會動。為什麼?**因為框架的 Vite plugin 幫你自動注入了 HMR 邏輯。**

### 以 Vue 為例

當你用 `@vitejs/plugin-vue` 處理一個 `.vue` 檔時,plugin 在把 SFC 編譯成 JS 的同時,**自動在尾巴加上一段 `import.meta.hot.accept` 程式碼**,而且這段邏輯特別聰明:

```js
// plugin 自動為你的 .vue 元件注入的(簡化示意):
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    // 不是粗暴地重新初始化,而是呼叫 Vue 的 HMR runtime API:
    // 用「新元件的 render 函式 / 邏輯」去「重新渲染這個元件的實例」,
    // 但「保留元件當前的響應式狀態(data / ref 的值)」
    __VUE_HMR_RUNTIME__.reload(componentId, newModule.default)
  })
}
```

**關鍵在於「框架知道怎麼保留狀態」**:

- Vite 的 HMR 機制提供「換掉模組 + 給你 callback」的**底層能力**。
- 但「換掉之後,怎麼在不丟失元件狀態的前提下重新渲染」,是**框架的責任**。Vue 有 `__VUE_HMR_RUNTIME__`、React 有 React Refresh(`@vitejs/plugin-react` 整合的 Fast Refresh),它們知道如何「用新的 render 邏輯重繪,但保留 state」。

所以分工是:

| 層 | 負責什麼 |
|----|---------|
| **Vite HMR 機制**(本章主角) | 偵測變動、算邊界、透過 WebSocket 推新模組、呼叫 accept callback |
| **框架 plugin**(plugin-vue / plugin-react) | 自動注入 accept、在 callback 裡呼叫框架的 HMR runtime |
| **框架 HMR runtime**(Vue/React 內建) | 用新邏輯重繪元件,同時**保留元件狀態** |

> **這就是為什麼**:你改一個 Vue 元件的 template,畫面更新了,但元件裡 `ref` 的值、輸入框的內容都還在——因為 plugin-vue 注入的 accept + Vue 的 HMR runtime 聯手保留了狀態。你什麼都不用寫,全自動。

### React 的 Fast Refresh

React 同理,`@vitejs/plugin-react` 整合了 **React Refresh**,自動為你的元件注入 HMR 邏輯,改元件時保留 `useState` 的狀態。(它有些限制,例如元件要是具名匯出、檔案不能混太多非元件的匯出,否則會退回整頁重載——背後原因就是 5.4 的「找不到乾淨的邊界」。)

---

## 5.6 `import.meta.hot` 常用 API 速覽

雖然 90% 情況框架幫你處理好了,但理解這幾個 API 能讓你在「寫 plugin」或「處理非框架模組」時派上用場,也讓你真正讀懂 HMR。

```js
if (import.meta.hot) {
  // 1. accept():接住「自己」的更新(最常用,5.4 講過)
  import.meta.hot.accept((newSelf) => { /* 用新版的自己更新 */ })

  // 2. accept(deps, cb):接住「某個依賴」的更新
  //    當我 import 的某個模組變了,我自己來處理,不用整頁重載
  import.meta.hot.accept('./config.js', (newConfig) => {
    applyConfig(newConfig)
  })

  // 3. dispose():模組「被替換掉之前」執行清理
  //    用來清掉舊模組留下的副作用(計時器、事件監聽、連線),避免外洩
  import.meta.hot.dispose(() => {
    clearInterval(timer)        // 例如清掉舊的計時器
  })

  // 4. data:跨「更新前後」傳遞資料的暫存區
  //    舊模組把要保留的東西塞進 hot.data,新模組啟動時讀回來
  import.meta.hot.data.count = currentCount

  // 5. invalidate():我接了更新,但發現處理不了,主動放棄 → 往上冒泡找邊界
  import.meta.hot.invalidate()
}
```

逐一說用途:

- **`accept`**:核心。宣告「我能處理更新」,讓自己成為 HMR 邊界。
- **`dispose`**:**最容易被忽略、卻最重要的清理鉤子**。模組熱替換時,舊模組可能開了計時器、加了事件監聽。如果不在 `dispose` 裡清掉,每次熱更新就累積一個,最後一堆殭屍計時器在跑(經典的 HMR 記憶體外洩 / 重複觸發 bug)。
- **`data`**:在「舊模組」和「新模組」之間傳遞資料的橋。例如想在熱更新後保留某個計數值,就舊模組存進 `hot.data`、新模組讀回來。
- **`invalidate`**:「我本來說我能接,結果發現這次更新我搞不定」,主動把更新往上游冒泡,讓更上層去處理(或最終整頁重載)。React Refresh 在偵測到「這個變動沒辦法安全地局部更新」時就會用它。

> **動手理解 `dispose` 的價值**:寫一個模組,在頂層 `setInterval(() => console.log('tick'), 1000)`,但**不寫** `dispose`。
> 然後改幾次這個檔案,看 console——你會看到 `tick` 越印越快(每次熱更新都多一個沒被清掉的計時器在跑)。
> 加上 `import.meta.hot.dispose(() => clearInterval(timer))` 後再試,就正常了。這個實驗會讓你永遠記得 `dispose`。

---

## 5.7 CSS 的 HMR:為什麼改樣式「永遠」是無痛的

第 04 章說「dev 時 CSS 被包成 JS 注入」,現在可以解釋它跟 HMR 的關係了。

CSS 的 HMR 是體驗最絲滑的——改 CSS **幾乎永遠**不會整頁重載,純粹換樣式。原因:

- 第 04 章講過,CSS 被 Vite 包成一個「會建立 `<style>` 標籤注入樣式」的 JS 模組。
- 這個 JS 模組裡,Vite 自動加好了 `accept` 邏輯:當 CSS 變動,它就**把舊的 `<style>` 內容換成新的**,如此而已。
- 換 `<style>` 內容不影響任何 JS 狀態、不動 DOM 結構,所以**狀態 100% 保留**,連 React/Vue 元件都不用重繪。

> 這就是為什麼調樣式時,你可以一邊看著彈窗開著、表單填著,一邊瘋狂改 CSS,畫面即時變、狀態全不丟。CSS 是 HMR 的最佳示範。

---

## 5.8 本章小結與下一步

這一章我們把 HMR 從頭拆到尾:

- **三個詞**:整頁重載 / Live Reload / HMR,差別在「狀態保不保留」,HMR 的價值就是保留狀態。
- **兩個角色**:`@vite/client`(瀏覽器端,WebSocket 長連線收訊息)+ dev server(Node 端,監看檔案、算影響、推訊息)。
- **module graph**:記錄雙向依賴(尤其「誰 import 我」),是 HMR 精準定位的地圖。
- **HMR 邊界**:從變動點沿 importers 往上找「呼叫了 `accept` 的模組」;找到就更新到那層,一路找不到就整頁重載——這解釋了「為何有時無痛、有時整頁刷新」。
- **框架整合**:plugin-vue / plugin-react 自動注入 accept,並用框架的 HMR runtime 做到「重繪但保留狀態」。
- **`import.meta.hot` API**:`accept` / `dispose`(清理副作用,別忘!)/ `data`(跨更新傳值)/ `invalidate`(放棄並上冒)。
- **CSS HMR**:因為被包成可替換 `<style>` 的 JS 模組,所以改樣式永遠絲滑。

**到這裡,前六章(原理篇 + 日常篇核心)完成了。** 你現在應該能完整回答:Vite dev 為什麼快(02 不打包)、依賴怎麼處理(03 預打包)、各種資源怎麼變成模組(04 轉換管線)、改 code 為什麼能無痛更新(05 HMR)。這四章合起來,正好就是「手寫一個 mini-vite」需要的全部核心機制——dev server + 即時轉譯 + 預打包 + HMR。

**接下來的章節(規劃中)**:第 06、07 章進入 **Plugin 系統**(你會發現本課程提過的「框架支援」「CSS 處理」其實都是 plugin),第 08 章講**生產建構與 Rollup**(tree shaking、code splitting、那些 hash 檔名的全貌),第 09 章進階場景,第 10 章 Rolldown,第 11 章親手把這六章的原理實作成 mini-vite。

> 💡 **動手作業**:做 5.6 那個 `dispose` 的計時器實驗,親眼看到「不清理副作用」會怎樣;再體會 5.7,開著一個有狀態的畫面狂改 CSS,感受 HMR 的絲滑。這兩個體感會讓這章的原理真正內化。
