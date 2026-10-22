# Flex 排版細節、CSS 變數與 `@property` 實戰

> 把「能排出畫面」進一步變成「能解釋尺寸、溢位、繼承與動畫」。先理解 Flex 如何分配空間，再用 CSS 自訂屬性組織主題與元件參數，最後用 `@property` 定義型別與插值行為。

## 0. 學習目標與閱讀方式

本文預設你已認識 CSS 選擇器、盒模型與基本層疊規則。範例主要使用水平書寫模式；談到左右、上下時，請留意 `direction` 與 `writing-mode` 也會影響軸向。

| 主題 | 要能回答的問題 |
|---|---|
| Flex 軸向與對齊 | 為什麼改成 column 後，`justify-content` 的方向不同？ |
| grow／shrink／basis | `flex: 1` 為什麼不一定讓元素完全等寬？ |
| 自動最小尺寸 | 為什麼文字把容器撐爆，或內容區不肯捲動？ |
| CSS 自訂屬性 | `var()` fallback 為什麼沒有救回錯誤的顏色？ |
| `@property` | 註冊型別如何影響初始值、繼承與動畫？ |

各節片段可獨立實驗；§9 提供完整 HTML，可另存成檔案，用瀏覽器開啟。使用 DevTools 的 Flex 視覺化與 Computed 面板觀察，不要只猜 CSS 是否生效。

## 1. Flex 的兩條軸：先找方向，再談置中

`display: flex` 讓容器的一般流直接子項成為 flex items；更深一層的後代不會因此自動成為該容器的 flex items。
`inline-flex` 的內部排版同樣是 Flex，差別在容器本身如何參與外部排版。

```css
.toolbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
}
```

| 設定 | 主要影響 |
|---|---|
| `flex-direction` | 決定主軸及其方向；另一條是交叉軸 |
| `justify-content` | 在主軸分配完成後，安排剩餘空間 |
| `align-items` | 設定每一行內項目在交叉軸的對齊 |
| `align-self` | 覆寫單一項目的交叉軸對齊 |
| `align-content` | 安排可換行容器中各 flex line 的交叉軸空間 |

一般水平、由左到右書寫時，`row` 的主軸是水平，`column` 的主軸是垂直。
因此「`justify-content` 是水平置中」不完整，正確說法是「主軸對齊」。

### 1.1 `align-items` 與 `align-content` 不是同一件事

```css
.tags {
  display: flex;
  flex-wrap: wrap;
  block-size: 240px;
  align-items: center;       /* 各行中的項目對齊 */
  align-content: flex-start; /* 各行集中在交叉軸起點 */
  gap: 8px 16px;
}
```

`flex-wrap: nowrap` 的單行容器不受 `align-content` 影響。換行容器即使目前只有一行，也可能受它影響；不要把「現在看到一行」等同於「nowrap 容器」。
要看出空間分配差異，交叉軸也必須有可分配的空間。`align-items: stretch` 則需要項目的交叉軸尺寸為 auto，且仍受 min／max 限制。

### 1.2 自動 margin：把操作按鈕推到另一端

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.toolbar__actions {
  margin-inline-start: auto;
}
```

在一般 row 排版中，auto margin 先吸收主軸的正剩餘空間，再輪到 `justify-content`。
如果 grow 已經吃完空間，`justify-content: space-between` 可能看不出效果。Flex 項目也不能靠 `justify-self` 做主軸個別對齊。
對齊細節見 [MDN：Aligning items in a flex container](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Flexible_box_layout/Aligning_items)。

## 2. 尺寸分配：`flex-grow`、`flex-shrink`、`flex-basis`

```css
.item {
  flex: 1 1 200px;
  /* grow  shrink  basis */
}
```

先用以下模型理解一行的計算：

```text
決定每個項目的基準尺寸
  → 扣除 gap、margin 等，判斷這一行剩餘或不足多少空間
  → 正空間依 grow 分配；負空間依 shrink 與基準尺寸分攤
  → 套用 min/max 限制，必要時凍結部分項目並重新分配
```

下面的數字案例先排除 margin、padding、border 與 min/max 限制，使用明確的容器主軸尺寸。
真實演算法還包含內容尺寸、凍結與重算，不能只用一次比例計算解釋所有版面。

### 2.1 grow 分配的是「剩餘空間」，不是最終寬度

容器內容寬 600px，三個項目的 basis 都是 100px，gap 是 20px，grow 分別是 1、2、1：

```text
剩餘空間 = 600 - (100 + 100 + 100) - 2 × 20 = 260px
分配比例 = 1 : 2 : 1
增加尺寸 = 65px、130px、65px
最終尺寸 = 165px、230px、165px
```

中間 grow 是 2，不代表最終寬度是旁邊的兩倍；原本的 basis 也要算進去。
若 grow 總和小於 1，還可能只取走部分剩餘空間，本例的比例公式不能直接套用。

### 2.2 shrink 會乘上基準尺寸

容器寬 400px，兩個項目的 basis 分別為 300px、200px，shrink 都是 1，沒有 gap：

```text
不足空間 = 300 + 200 - 400 = 100px
縮小權重 = 1 × 300 : 1 × 200 = 3 : 2
各自縮小 = 60px、40px
最終尺寸 = 240px、160px
```

兩者 shrink 都是 1，也不是各減 50px。大的項目通常承擔較多縮小量。
`flex-shrink: 0` 可保護圖示或固定側欄，但不會保證整個容器沒有溢位。
機制與計算背景見 [MDN：Controlling flex item ratios](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Flexible_box_layout/Controlling_flex_item_ratios)。

### 2.3 basis、width 與簡寫

`flex-basis` 是主軸的起始尺寸，並非最後尺寸。在 row 常對應寬，在 column 常對應高。
`flex-basis: auto` 會參考主軸尺寸屬性，例如 row 的 `width`；若該尺寸也是 auto，再由內容參與決定。
若給了明確的非 auto basis，它會優先作為基準，但最終仍受 grow／shrink／min／max 影響。見 [flex-basis](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/flex-basis)。

| 寫法 | 展開／用途 |
|---|---|
| 初始值 `flex: 0 1 auto` | 不成長，可以縮小，基準參考主軸尺寸或內容 |
| `flex: auto` | `1 1 auto`，保留不同基準再分配空間 |
| `flex: none` | `0 0 auto`，不伸縮 |
| `flex: 1` | 瀏覽器通常展開成 `1 1 0%` |
| `flex: 1 1 0` | 明確使用零長度基準，較容易表達從零分配 |
| `flex: 0 0 12rem` | 以 12rem 為基準且不伸縮，仍要留意最小尺寸等限制 |

`0%` 與 `0` 在容器主軸尺寸不明確時可能不同：百分比 basis 不能解析時可能依內容處理，零長度則是確定的零。
另外，`flex: 1` 仍受到自動最小尺寸與 padding／border 影響，不是保證等寬的咒語。
簡寫差異見 [flex](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/flex)。

## 3. 最常見的坑：為什麼縮不下去、捲不起來？

### 3.1 長文字撐爆：先檢查 `min-width: auto`

Flex 項目在主軸的自動最小尺寸可能受到內容限制。即使允許 shrink，長網址、不換行的標題仍可能阻止它繼續縮小。

```html
<div class="row">
  <span class="icon">★</span>
  <div class="content">
    <p class="title">very-long-project-name-without-spaces-that-must-fit</p>
  </div>
  <button class="action">編輯</button>
</div>
```

```css
.row { display: flex; gap: 12px; align-items: center; }
.icon, .action { flex: none; }
.content { flex: 1 1 0; min-inline-size: 0; }
.title {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

水平書寫下，`min-inline-size: 0` 對應常見的 `min-width: 0`。
關鍵是允許 `.content` 這個 flex item 縮小，不能只在內部文字加省略號。
如果設計允許換行，可用 `overflow-wrap: anywhere`；如果有多層 Flex，還要沿祖先檢查是哪一層的最小尺寸在阻擋。

### 3.2 垂直內容區：`min-height: 0` 與高度邊界

```css
.app {
  display: flex;
  flex-direction: column;
  block-size: 100dvh;
}
.header { flex: none; }
.body {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-block-size: 0;
}
.list {
  flex: 1 1 0;
  min-block-size: 0;
  overflow: auto;
}
```

`.app` 建立有限高度，`.body` 允許縮到內容以下，`.list` 才能在剩餘空間中捲動。
`min-block-size: 0` 在水平書寫下對應 `min-height: 0`。只給 `overflow: auto`，但整條父層沒有尺寸邊界，容器仍可能跟著內容長大。
捲動相關 overflow 設定也會影響自動最小尺寸，不應把規則簡化成「所有 flex item 永遠都是 min-content」。詳見 [Flexbox 規範：Automatic Minimum Size](https://www.w3.org/TR/css-flexbox-1/#min-size-auto)。

## 4. 換行、gap、排序與 Grid 的選擇

```css
.cards { display: flex; flex-wrap: wrap; gap: 16px; }
.card { flex: 1 1 240px; min-inline-size: 0; }
```

上例讓卡片以 240px 為基準換行，再各自在所在行分配空間。最後一行只有一張時，也可能長滿整行。
Flex 各行獨立計算，不保證上下列的欄線對齊；需要固定欄線時可考慮 Grid。

| 情境 | 常見選擇 |
|---|---|
| 工具列、導覽、圖示加文字、單行操作區 | Flex |
| 二維卡片網格、跨行跨欄、明確欄線對齊 | Grid |
| 頁面整體欄位 + 卡片內部按鈕列 | 外層 Grid、內層 Flex |

`gap` 也是版面占用空間；三個 `width: 33.333%` 再加 gap 不會自動維持總寬 100%。
`box-sizing: border-box` 有助於管理 padding／border，但不會把 gap 算進項目自己的寬度。

`order`、`row-reverse` 只改變視覺排序，不會同步改 DOM、讀屏與一般鍵盤焦點順序；不要用它們修補語意錯誤的 DOM 結構。
相關規則見 [Flexbox 規範：Ordering and Orientation](https://www.w3.org/TR/css-flexbox-1/#ordering-and-orientation)。

## 5. CSS 變數：其實是參與層疊的自訂屬性

### 5.1 宣告、使用與局部覆寫

```css
:root {
  --app-brand: #2563eb;
  --app-space: 12px;
}
.panel {
  --panel-gap: var(--app-space);
  display: flex;
  gap: var(--panel-gap);
  color: var(--app-brand);
}
.panel--compact { --panel-gap: 6px; }
```

未註冊的 `--名稱` 預設會繼承，名稱區分大小寫；`--brand` 與 `--Brand` 是不同屬性。
`:root` 是常見的全頁預設值位置，但變數不是脫離 DOM 的全域 JS 常數，而是在元素上依層疊與繼承計算。
也不同於 Sass 編譯期變數：它可以隨 class、主題與 JavaScript 在執行時改變。

```css
:root { --app-surface: white; --app-text: #172033; }
[data-theme="dark"] { --app-surface: #172033; --app-text: #f8fafc; }
.panel { background: var(--app-surface); color: var(--app-text); }
```

主題可設在根元素，也能只包住某個區域。子元素如果自己宣告同名變數，就會使用自己的宣告，而非繼承值。
參考 [MDN：Using CSS custom properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascading_variables/Using_custom_properties)。

### 5.2 `var()` fallback 不是值型別檢查器

```css
.notice {
  color: var(--notice-color, var(--app-brand, blue));
}
```

當 `--notice-color` 未定義或處於無效的自訂屬性值狀態時，才使用 fallback。
如果它存在但裝了不適合 `color` 的內容，不會因而自動改用 fallback：

```css
.parent { color: green; }
.child {
  --notice-color: 16px;
  color: blue;
  color: var(--notice-color, red);
}
```

套用在 `.parent` 裡的 `.child` 時，`16px` 可作為未註冊自訂屬性的值，替換進 `color` 才變成無效。
此時不會變紅，也不會回頭找上一個 `color: blue`；`color` 在計算值階段無效，按其繼承行為得到父層的綠色。
非繼承屬性則通常回到初始值。詳見 [var()](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/var)。

### 5.3 單位、作用位置與 JS 讀寫

```css
.card {
  --card-space: 8px;
  padding: calc(var(--card-space) * 2);
}
```

不要寫 `var(--size)px` 期待字串拼接；可讓變數本身帶單位，或用 `calc(var(--size) * 1px)` 把數字轉成長度。
`var()` 用在屬性值，不能拿來拼選擇器、屬性名稱，也不能直接當一般 `@media (min-width: var(--breakpoint))` 的條件值。

```js
const panel = document.querySelector('.panel')
if (panel) {
  panel.style.setProperty('--panel-gap', '20px')
  console.log(getComputedStyle(panel).getPropertyValue('--panel-gap').trim())
  panel.style.removeProperty('--panel-gap') // 移除 inline 宣告，回到 CSS 層疊
}
```

`element.style` 只反映 inline style；要讀取層疊後的值，使用 `getComputedStyle`。
大量交錯讀取計算樣式與寫入樣式可能增加同步樣式計算成本，應避免放在高頻迴圈中反覆操作。

## 6. `@property`：替自訂屬性註冊型別、繼承與初始值

```css
@property --demo-progress {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 0%;
}
```

| 描述子 | 意義 |
|---|---|
| `syntax` | 可接受的值語法，例如 `<number>`、`<length>`、`<color>`、`<angle>`、`<percentage>` |
| `inherits` | 未在本元素指定時，是否預設從父層繼承 |
| `initial-value` | 該註冊屬性的初始值，不是某個 selector 的一般宣告 |

`syntax` 與 `inherits` 是必要描述子；除 `syntax: "*"` 等規範允許的情況外，也必須提供有效的 `initial-value`。
初始值需要符合語法且能獨立計算。例如註冊 `<length>` 時，`10px` 合適，依賴該元素字型的 `3em` 不合適；不要把 `var(--other)` 當成這裡的通用初始值。
詳細限制見 [@property](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@property)。

### 6.1 註冊不等於把值寫到每個元素

```css
@property --demo-accent {
  syntax: "<color>";
  inherits: false;
  initial-value: teal;
}
.parent { --demo-accent: orange; }
.child { color: var(--demo-accent, pink); }
```

`.child` 沒有自己指定值，又不預設繼承，因此使用 teal，並非 orange 或 pink。
要用在整站主題上的 token，通常需要繼承；元件內部獨立的進度值則可能適合 `inherits: false`。
即使設為 false，仍能用明確的 `--demo-accent: inherit` 要求繼承。

對註冊屬性寫入不符合語法的值時，會依計算值無效的規則處理，常見結果是繼承值或註冊初始值；不能假設一定使用 `var()` 的 fallback，或回到前一個宣告。
規則見 [CSS Properties and Values API：計算值與繼承](https://www.w3.org/TR/css-properties-values-api-1/#computation)。

### 6.2 註冊範圍與命名

把 `@property` 放在樣式表頂層，使用有前綴的名稱，例如 `--course-progress`。
它是在文件層級註冊屬性，不會因為檔案是某個 Vue／React 元件的樣式，就變成那個元件私有的型別。
多個元件使用同名註冊可能互相影響，應集中管理名稱與定義。

## 7. 動畫：為什麼註冊後可以平滑插值？

未註冊的自訂屬性沒有可用來連續插值的型別，不能期待直接對它做一般 transition 就產生平滑變化。
註冊 `<percentage>` 後，瀏覽器知道 20% 到 80% 中間有哪些值：

```css
@property --demo-progress {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 0%;
}
.meter {
  --demo-progress: 20%;
  block-size: 16px;
  background: linear-gradient(
    to right,
    #2563eb 0% var(--demo-progress),
    #dbeafe var(--demo-progress) 100%
  );
  transition: --demo-progress 400ms ease;
}
.meter.is-complete { --demo-progress: 80%; }
@media (prefers-reduced-motion: reduce) {
  .meter { transition: none; }
}
```

這裡動畫的目標是百分比變數，漸層每次使用插值後的百分比重新計算。
不要把它誤解成「沒有 `@property` 就不能對使用變數的屬性做動畫」：例如 `color: var(--brand)` 改變後，`transition: color ...` 本來就能依 color 自己的型別過渡。
差別在於直接過渡自訂屬性本身。插值規則見 [CSS Properties and Values API：Animation Behavior](https://www.w3.org/TR/css-properties-values-api-1/#animation-behavior)。

**效能仍取決於你改了什麼：**讓變數影響 width、gap、flex-basis，可能觸發 layout；用在漸層可能需要 paint。註冊型別不代表動畫就會自動進合成執行緒，也不保證不掉幀。

## 8. 相容性、漸進增強與 JS 註冊

不支援 `@property` 的環境會忽略註冊規則，因此範例也應提供一般自訂屬性的有效值。
功能要能在「值直接切換、沒有平滑過渡」時仍然使用；不能只靠註冊型別驗證使用者輸入。

另一種註冊方式是 JavaScript：

```js
// 本例是 @property 的替代方式，應在應用啟動時集中執行一次。
if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') {
  CSS.registerProperty({
    name: '--js-demo-angle',
    syntax: '<angle>',
    inherits: false,
    initialValue: '0deg',
  })
}
```

注意 JS 使用 `initialValue`；CSS 使用 `initial-value`。重複以 JS 註冊同名屬性會拋錯，不要在每次元件 render／掛載時無條件執行。
`@supports (--x: 0)` 只測一般自訂屬性宣告，不能證明瀏覽器支援 `@property` 型別註冊。
部署前確認目標瀏覽器相容性；介面與例外見 [CSS.registerProperty](https://developer.mozilla.org/en-US/docs/Web/API/CSS/registerProperty_static)。

## 9. 完整實戰：可換主題、可捲動的學習面板

把下面整段存成 HTML 後開啟。這份範例把固定側欄、可縮小標題、內部捲動、換行卡片、主題 token 與註冊進度動畫放在一起，無需框架或外部資源。

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flex 與 CSS 變數實驗</title>
  <style>
    @property --course-progress {
      syntax: "<percentage>";
      inherits: false;
      initial-value: 0%;
    }
    * { box-sizing: border-box; }
    :root {
      --surface: #ffffff;
      --page: #eef2f7;
      --text: #172033;
      --border: #cbd5e1;
      --brand: #2563eb;
      --track: #dbeafe;
      --space: 16px;
    }
    :root[data-theme="dark"] {
      --surface: #172033;
      --page: #0b1220;
      --text: #f8fafc;
      --border: #475569;
      --brand: #60a5fa;
      --track: #334155;
    }
    body {
      margin: 0;
      padding: var(--space);
      background: var(--page);
      color: var(--text);
      font-family: system-ui, sans-serif;
    }
    button { font: inherit; cursor: pointer; }
    .app {
      display: flex;
      flex-direction: column;
      max-inline-size: 1000px;
      block-size: 36rem;
      margin-inline: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: var(--space);
      padding: var(--space);
      flex: none;
      border-block-end: 1px solid var(--border);
    }
    .title {
      flex: 1 1 0;
      min-inline-size: 0;
      margin: 0;
      font-size: 1.1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toolbar button { flex: none; }
    .workspace { display: flex; flex: 1 1 0; min-block-size: 0; }
    .sidebar {
      flex: 0 0 12rem;
      min-inline-size: 0;
      padding: var(--space);
      border-inline-end: 1px solid var(--border);
    }
    .content {
      display: flex;
      flex-direction: column;
      flex: 1 1 0;
      min-inline-size: 0;
      min-block-size: 0;
    }
    .controls { padding: var(--space); flex: none; }
    .controls label { display: block; margin-block-end: 8px; }
    input[type="range"] { inline-size: 100%; }
    .meter {
      --course-progress: 35%;
      block-size: 16px;
      border-radius: 999px;
      background: linear-gradient(to right,
        var(--brand) 0% var(--course-progress),
        var(--track) var(--course-progress) 100%);
      transition: --course-progress 350ms ease;
    }
    .list {
      flex: 1 1 0;
      min-block-size: 0;
      overflow: auto;
      padding: var(--space);
      border-block-start: 1px solid var(--border);
    }
    .cards { display: flex; flex-wrap: wrap; gap: var(--space); }
    .card {
      flex: 1 1 13rem;
      min-inline-size: 0;
      padding: var(--space);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow-wrap: anywhere;
    }
    .card h2 { margin-block-start: 0; font-size: 1rem; }
    @media (max-width: 42rem) {
      .workspace { flex-direction: column; }
      .sidebar {
        flex: none;
        border-inline-end: 0;
        border-block-end: 1px solid var(--border);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .meter { transition: none; }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="toolbar">
      <h1 class="title">非常長的學習計畫標題：Flex、CSS 變數與 property 實驗</h1>
      <button id="theme" type="button" aria-pressed="false">深色模式</button>
    </header>
    <div class="workspace">
      <aside class="sidebar">學習清單：先排版，再調整主題與進度。</aside>
      <section class="content" aria-label="課程內容">
        <div class="controls">
          <label for="progress">完成進度：<output id="value" for="progress">35%</output></label>
          <input id="progress" type="range" min="0" max="100" value="35">
          <div id="meter" class="meter" role="progressbar" aria-label="課程完成進度"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="35"></div>
        </div>
        <div class="list" tabindex="0" aria-label="可捲動的課程清單">
          <div id="cards" class="cards"></div>
        </div>
      </section>
    </div>
  </main>
  <script type="module">
    const cards = document.querySelector('#cards');
    for (let index = 1; index <= 12; index++) {
      const card = document.createElement('article');
      card.className = 'card';
      const heading = document.createElement('h2');
      heading.textContent = `練習 ${index}`;
      const text = document.createElement('p');
      text.textContent = '觀察卡片換行、內部捲動與容器尺寸限制，並切換深淺主題。';
      card.append(heading, text);
      cards.append(card);
    }
    const progress = document.querySelector('#progress');
    const meter = document.querySelector('#meter');
    const value = document.querySelector('#value');
    progress.addEventListener('input', () => {
      const percent = Math.min(100, Math.max(0, Number(progress.value)));
      meter.style.setProperty('--course-progress', `${percent}%`);
      meter.setAttribute('aria-valuenow', String(percent));
      value.textContent = `${percent}%`;
    });
    document.querySelector('#theme').addEventListener('click', (event) => {
      const dark = document.documentElement.dataset.theme !== 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      event.currentTarget.setAttribute('aria-pressed', String(dark));
    });
  </script>
</body>
</html>
```

觀察重點：

1. 縮窄視窗：標題縮短而按鈕保持完整；小螢幕時側欄改為上方區塊。
2. 只有清單區捲動：`.workspace`、`.content`、`.list` 的尺寸限制形成完整鏈條。
3. 切換主題：背景、文字與進度顏色從根元素繼承；不需逐一修改每張卡片。
4. 拖動進度：`--course-progress` 在 meter 本身指定，與 `inherits: false` 配合；支援註冊時能平滑過渡。
5. 不支援註冊時：一般自訂屬性仍提供百分比，進度可直接切換，基本操作不依賴動畫。

## 10. 排錯順序與練習

| 現象 | 優先檢查 |
|---|---|
| `justify-content` 看起來沒效果 | 主軸方向、容器尺寸、grow 或 auto margin 是否已吃完空間 |
| 長標題撐破排版 | 直接 flex item 與祖先的 min-size、文字換行規則 |
| 內容區不捲動 | 父層是否有高度邊界、column 中是否允許縮小 |
| 最後一張卡片變超寬 | 各行獨立 grow；是否應調整 grow 或改用 Grid |
| var fallback 沒生效 | 變數真的缺失，還是替換後才不符合目的屬性的語法？ |
| 註冊後拿不到父層值 | `inherits` 是否設為 false，或子層有自己的宣告？ |
| 自訂屬性沒有動畫 | 註冊是否有效、syntax 是否匹配、transition 是否指定正確屬性 |

練習：

1. 手算 §2 的案例，再改 basis、grow、shrink，使用 DevTools 比對實際尺寸。
2. 在整合範例移除 `.content` 的 `min-inline-size: 0`，加入不可斷行的長字串，觀察最小尺寸如何影響版面。
3. 將 `.card` 改成 `flex: 0 1 13rem`，比較最後一行與原版的差異。
4. 建立一個不註冊的顏色變數與一個註冊 `<color>` 的變數，分別指定 `16px`，查看 Computed 結果。
5. 先移除 meter 自己在 CSS 與 inline style 中的進度宣告，將進度只設在父層，再切換 `inherits: false/true`，解釋 meter 為何取得不同值。

需要以 JS 監看容器尺寸時，可接著閱讀 [瀏覽器原生 API：ResizeObserver](./browser-native-apis.md)。
