# 第 01 章:環境、第一個渲染迴圈與 HiDPI 模糊

> **學習目標**:把 Canvas 真正跑起來。理解座標系、`width/height` 屬性與 CSS 尺寸的致命差異,**徹底解決 Retina 螢幕一片糊的問題**,並寫出第一個會動的渲染迴圈。
> **預計時數**:90 分鐘
> 上一章我們建立了「畫完即忘」的心智模型。這一章開始動手——但我們不急著畫炫炮的東西,而是先把**所有初學者都會踩、卻幾乎沒人講清楚的兩個坑**(尺寸 / HiDPI 模糊)在第一天就解決掉。把地基打穩,後面才不會莫名其妙。

---

## 1.1 取得畫布與繪圖環境(context)

Canvas 的一切都從這兩行開始:

```js
const canvas = document.querySelector('#stage');   // 拿到 <canvas> 元素
const ctx = canvas.getContext('2d');               // 拿到「2D 繪圖環境」
```

注意:**`<canvas>` 元素本身不會畫圖,真正畫圖的是 `context`**。`getContext` 的參數決定你拿到哪一種引擎:

| 參數 | 你拿到的東西 | 用途 |
|------|--------------|------|
| `'2d'` | `CanvasRenderingContext2D` | 2D 繪圖(這門課 00~09 章) |
| `'webgl'` / `'webgl2'` | `WebGLRenderingContext` | GPU 3D / 高效能 2D(第 10 章) |
| `'webgpu'` | `GPUCanvasContext` | 新一代 GPU API(第 10 章) |
| `'bitmaprenderer'` | `ImageBitmapRenderingContext` | 把 ImageBitmap 直接貼上去(第 09 章 OffscreenCanvas 會用到) |

> **心智模型**:`<canvas>` 是一塊**畫框**,`getContext('2d')` 是你向它要一支「2D 畫筆組」。同一塊畫布,**一旦要過 `'2d'`,就不能再要 `'webgl'`**(會回傳 `null`)——一塊畫布一生只能綁定一種 context 類型。

```js
// 防呆:舊瀏覽器或 context 被佔用時 getContext 會回傳 null
if (!ctx) {
  throw new Error('這個瀏覽器/畫布拿不到 2D context');
}
```

> **進階選項**(用得到再開,一般用預設即可):
`getContext('2d', { alpha: false })` 宣告畫布不透明,省一層合成、背景純色時更快;
`{ desynchronized: true }` 降低繪圖延遲,適合畫筆/遊戲;
`{ willReadFrequently: true }` 用於頻繁 `getImageData`(第 05 章)。

---

## 1.2 Canvas 的座標系:跟你數學課學的不一樣

```
   (0,0) ●──────────────────→ x 軸(往右變大)
         │
         │      ● (120, 80)
         │
         │
         ▼
         y 軸(往下變大)
```

三件事一定要記住:

1. **原點 `(0,0)` 在左上角**,不是中間,也不是左下角。
2. **x 往右increases、y 往下increases**。注意 **y 軸是往下的**——這跟你國中數學課本的座標系(y 往上)**剛好相反**。這是電腦繪圖的慣例(因為螢幕掃描是從上往下)。
3. **單位是「CSS 像素」**(稍後 1.4 會發現這件事沒這麼單純)。

> **白話翻譯**:想像你在讀一本書,從左上角開始、一行一行往右往下讀。Canvas 的座標就是這個方向。**畫東西時,「y 越大越靠下」**——很多人第一次畫圖形位置上下顛倒,就是把 y 軸想成往上了。

---

## 1.3 最致命的坑:`width/height` 屬性 ≠ CSS 尺寸

這是 Canvas **第一名**的初學者陷阱,99% 的人都踩過。先看現象:

```html
<!-- ❌ 錯誤示範:只用 CSS 設尺寸 -->
<canvas id="stage" style="width: 800px; height: 400px;"></canvas>
```

```js
const canvas = document.querySelector('#stage');
const ctx = canvas.getContext('2d');
ctx.fillRect(0, 0, 800, 400);   // fillRect(x, y, 寬, 高) → 想從 (0,0) 填一塊 800×400(結果見下,並沒填滿)
// 結果:只填了左上一小塊,而且圖形被「拉伸變形」了
```

**為什麼?因為 `<canvas>` 有兩個完全不同的「尺寸」:**

| 尺寸 | 設定方式 | 意義 |
|------|----------|------|
| **繪圖緩衝區尺寸(drawing buffer)** | HTML 屬性 `width` / `height`,或 JS `canvas.width` | 畫布內部「真正有多少像素格子」。座標就是相對這個算的。 |
| **顯示尺寸(display size)** | CSS `width` / `height` | 這塊畫布在頁面上「被拉伸到多大」來顯示。 |

如果你只設 CSS,繪圖緩衝區會用**預設值 300×150**。於是發生的事是:

```
你的繪圖命令畫在 300×150 的緩衝區上
   → 瀏覽器再把這張 300×150 的圖「拉伸」成 CSS 的 800×400 來顯示
   → 就像把一張小照片硬撐大:模糊 + 變形
```

> **心智模型**:把 canvas 想成一張**實體相片**。
> - `width`/`height` 屬性 = 這張相片**沖洗出來有多少像素**(解析度)。
> - CSS `width`/`height` = 你把這張相片**放進多大的相框**展示。
> 相片小、相框大 → 照片被撐大、糊掉。**兩者必須匹配,圖才清晰。**

### 正解:用 JS 同時設定兩者

```js
const canvas = document.querySelector('#stage');

// 設定繪圖緩衝區尺寸(內部像素數)—— 這決定座標範圍
canvas.width = 800;
canvas.height = 400;

// (可選)用 CSS 設定顯示尺寸。不設的話顯示尺寸 = 緩衝區尺寸
canvas.style.width = '800px';
canvas.style.height = '400px';
```

⚠️ **重要副作用**:**設定 `canvas.width` 或 `canvas.height`(即使設成跟原本一樣的值)會把整塊畫布清空、並重置所有 context 狀態**。這個特性後面 1.6 清空畫布、以及 resize 時會再遇到。

---

## 1.4 終極坑:為什麼 Retina 螢幕上一片糊?(HiDPI / devicePixelRatio)

你照 1.3 把尺寸設對了,在你的 Mac / 高階手機上一看——**文字和線條還是有點糊**。歡迎來到第二大坑:**HiDPI(高像素密度螢幕)**。

### 問題根源:1 個 CSS 像素 ≠ 1 個物理像素

在普通螢幕上,1 個 CSS 像素對應螢幕上 1 個物理像素。但在 Retina / 高 DPI 螢幕上,為了讓畫面更細緻,**1 個 CSS 像素其實是由 2×2(甚至 3×3)個物理像素組成的**。

這個比值,瀏覽器透過 `window.devicePixelRatio`(簡稱 **DPR**)告訴你:

```js
console.log(window.devicePixelRatio);
// 一般螢幕:1
// Mac Retina / 多數高階手機:2
// 部分高階 Android:3
```

現在問題來了。假設 DPR = 2,你的畫布是這樣:

```
你設 canvas.width = 800(緩衝區 800 個像素格)
你設 CSS width = 800px(顯示寬度 800 CSS 像素)

但 800 CSS 像素,在 DPR=2 的螢幕上,實際佔了 1600 個物理像素!
   → 瀏覽器要把你那 800 格的圖,撐到 1600 個物理像素去顯示
   → 每一格被放大成 2 格 → 糊掉
```

> **白話翻譯**:你畫了一張 800 像素的圖,螢幕卻有 1600 個格子要填。瀏覽器只好把每個像素拉成兩個——線條邊緣就「暈開」了。**這跟 1.3 的拉伸是同一回事,只是這次拉伸是 DPR 造成的,看不見摸不著,所以更難 debug。**

### 解法:緩衝區放大 DPR 倍,顯示尺寸維持不變,再縮放 context

三步驟:

1. **繪圖緩衝區**(`canvas.width`)設成 `CSS 尺寸 × DPR` → 讓畫布有足夠的物理像素格。
2. **CSS 顯示尺寸**維持原本的邏輯尺寸(例如 800px)→ 視覺大小不變。
3. **`ctx.scale(dpr, dpr)`** → 這樣你寫程式時還是用「邏輯座標」(畫到 800,400),context 會自動幫你乘上 DPR 對應到物理像素。

```js
/**
 * 設定一塊高清晰度、不糊的畫布。
 * @param canvas  <canvas> 元素
 * @param cssWidth   邏輯寬度(你寫程式時用的座標範圍)
 * @param cssHeight  邏輯高度
 * @returns 已縮放好的 2d context
 */
function setupHiDPICanvas(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;

  // 1. 繪圖緩衝區 = 邏輯尺寸 × DPR(讓它有足夠的物理像素格)
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  // 2. CSS 顯示尺寸維持邏輯尺寸(視覺大小不變)
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  // 3. 把座標系縮放 DPR 倍:之後你用邏輯座標畫圖,會自動對應到物理像素
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  return ctx;
}

// 使用:之後你只管用邏輯座標(800×400)畫圖,不用再想 DPR
const ctx = setupHiDPICanvas(canvas, 800, 400);
ctx.fillStyle = '#333';
ctx.fillRect(0, 0, 800, 400);   // fillRect(x, y, 寬, 高):填滿整塊,而且在 Retina 上清晰銳利
```

> **心智模型**:DPR 處理就像「**幕後放大,台前不變**」。緩衝區偷偷變成 2 倍細(1600 格),`scale(2,2)` 讓你的程式碼活在原本的 800 座標世界裡,完全無感。**你寫程式照舊,清晰度免費翻倍。**
>
> ⚠️ 注意 `ctx.scale` 的效果會被「重設 canvas.width」清掉(見 1.3 的副作用),所以**每次 resize 重設緩衝區後,都要重新 `scale` 一次**——這就是為什麼要把它包成一個函式。

### 響應式:視窗變大時重新設定

畫布若要跟著容器大小變,用 `ResizeObserver` 監聽容器,變動時重跑上面的設定(注意重設尺寸會清空畫布,所以設定完要立刻重畫一次):

```js
const ro = new ResizeObserver((entries) => {
  const { width, height } = entries[0].contentRect;
  setupHiDPICanvas(canvas, width, height);
  render();   // render = 你的重畫函式(1.5 會寫出完整例子);緩衝區被重設清空了,馬上重畫一次
});
ro.observe(canvas.parentElement);
```

> **這就是「畫完即忘」的第一次實戰**:resize 一次,畫布就空了,你必須主動重畫。retained mode 的 DOM 不會有這個問題——又一個你要自己補的洞。

> ⚠️ **`devicePixelRatio` 不是常數**:把視窗從一般螢幕拖到 Retina 螢幕、或調整瀏覽器縮放,DPR 都會變。正式版要監聽它的變化、重設畫布:`matchMedia(\`(resolution: ${dpr}dppx)\`).addEventListener('change', resetCanvas)`(或每次 resize 都重讀 `devicePixelRatio`)。寫死一次 DPR 的話,跨螢幕拖動就會變糊。

---

## 1.5 第一個渲染迴圈:`requestAnimationFrame`

第 00 章說過:Canvas 上的東西不是物件,**要讓它動,就得「清掉 → 重畫」每秒 60 次**。負責「每秒 60 次」這件事的,就是 `requestAnimationFrame`(簡稱 **rAF**)。

### 為什麼不用 `setInterval(draw, 1000/60)`?

| | `setInterval` | `requestAnimationFrame` |
|---|---------------|--------------------------|
| 跟螢幕刷新同步 | ❌ 不同步,會撕裂/抖動 | ✅ 跟螢幕的 vsync 對齊 |
| 分頁切到背景 | ❌ 照跑,浪費電、發熱 | ✅ 自動暫停,省電 |
| 刷新率適配 | ❌ 寫死 60,在 120Hz 螢幕不對 | ✅ 自動跟著螢幕(60/90/120Hz) |
| 掉幀行為 | 累積、越拖越糟 | 跳過、自然恢復 |

**結論:Canvas 動畫永遠用 `requestAnimationFrame`,不要用 `setInterval`。**

### rAF 的運作方式

```js
function frame(timestamp) {
  // timestamp:瀏覽器自動傳入的「當前時間」(毫秒,高精度)
  //           下一章不太用,但第 06 章做 delta-time 動畫時是主角

  // ... 在這裡畫一幀 ...

  requestAnimationFrame(frame);   // 預約「下一幀」再呼叫我一次
}

requestAnimationFrame(frame);     // 啟動:預約第一幀
```

注意這個模式:**rAF 只會呼叫你的函式「一次」**。要持續動畫,你得在函式內**再預約下一次**(`requestAnimationFrame(frame)`)。這形成一個自我延續的迴圈,瀏覽器會在每次螢幕準備重繪前呼叫它(通常每秒 60 次)。

### 渲染迴圈的標準骨架

```js
function frame() {
  // 1. 清空:把上一幀的畫面擦掉(不然會殘留疊加)
  ctx.clearRect(0, 0, 800, 400);   // clearRect(x, y, 寬, 高) → 清掉整塊畫布

  // 2. 更新:更新「你自己維護的物件資料」(位置、速度…)
  update();

  // 3. 繪製:照新狀態重畫一次
  render();

  // 4. 預約下一幀
  requestAnimationFrame(frame);
}
```

> **心智模型**:渲染迴圈就是「**清 → 算 → 畫**」三拍子,每秒重複 60 次。這呼應第 00 章的推論 1:**Canvas 沒有「會動的物件」,動畫只是「靜態畫面每秒換 60 張」的錯覺**——就跟翻頁動畫書一樣。

### 完整可跑範例:一顆會反彈的球

把前面所有東西串起來。這段直接貼進 `.html` 就能跑:

```html
<canvas id="stage"></canvas>
<script>
  const canvas = document.querySelector('#stage');

  // ---- HiDPI 設定(1.4 的函式)----
  function setupHiDPICanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return ctx;
  }

  const W = 800, H = 400;
  const ctx = setupHiDPICanvas(canvas, W, H);

  // ---- 「物件」的資料:這是「你自己維護」的,Canvas 不認得它 ----
  const ball = { x: 100, y: 100, r: 20, vx: 4, vy: 3 };

  function update() {
    // 移動
    ball.x += ball.vx;
    ball.y += ball.vy;
    // 撞牆反彈(碰到邊界就把速度反向)
    if (ball.x - ball.r < 0 || ball.x + ball.r > W) ball.vx *= -1;
    if (ball.y - ball.r < 0 || ball.y + ball.r > H) ball.vy *= -1;
  }

  function render() {
    ctx.fillStyle = '#e63946';
    ctx.beginPath();   // beginPath():開一條新路徑(和上一幀畫的切開,避免相連)
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
    ctx.fill();        // fill():把 arc 規劃好的路徑填色畫出來
  }

  function frame() {
    ctx.clearRect(0, 0, W, H);   // 清
    update();                    // 算
    render();                    // 畫
    requestAnimationFrame(frame);// 預約下一幀
  }

  requestAnimationFrame(frame);
</script>
```

跑起來你會看到一顆紅球在框內彈來彈去。**仔細體會:畫面上那顆「球」其實不存在,只有 `ball` 這個 JS 物件存在;每一幀我們都把它「重新畫一次」在新位置。** 這就是第 00 章「畫完即忘」最直觀的證明。

> 💡 **試試看(埋第 06 章伏筆)**:把上面的 `vx: 4` 改大,球會變快。但這個「速度」是綁在「每一幀」上的——在 120Hz 螢幕上球會跑兩倍快!**動畫不該綁幀數,應該綁「時間」(delta-time)**。這個坑第 06 章專門解。先記著。

---

## 1.6 清空畫布的幾種方式與陷阱

「清掉上一幀」看似簡單,其實有三種方式,各有用途與陷阱:

```js
const W = 800, H = 400;   // 邏輯畫布尺寸(CSS 像素)

// 方式 1:clearRect —— 最常用,擦成「透明」
ctx.clearRect(0, 0, W, H);

// 方式 2:用顏色蓋掉 —— 擦成某個底色(順便當背景)
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, W, H);

// 方式 3:重設緩衝區尺寸 —— 連同所有 context 狀態一起重置(核彈級)
canvas.width = canvas.width;   // 故意重新賦值,觸發完整清空+狀態重置
```

| 方式 | 清掉像素 | 重置狀態(transform/樣式) | 何時用 |
|------|----------|----------------------------|--------|
| `clearRect` | ✅ 擦成透明 | ❌ 保留 | 99% 的情況,渲染迴圈每幀清 |
| 填色覆蓋 | ✅ 擦成該色 | ❌ 保留 | 需要不透明底色時 |
| `canvas.width = ...` | ✅ | ✅ **連 transform 都重置** | 想徹底重來,或 resize 時 |

> **常見 bug**:有人想「順便清掉變換」就每幀用 `canvas.width = canvas.width`,結果把 1.4 設好的 `ctx.scale(dpr)` 也清掉了 → Retina 上又變糊。**記住:重設緩衝區是核彈,會清掉你所有的 context 設定(包括 HiDPI 縮放)。** 一般迴圈請老實用 `clearRect`。

---

## 1.7 「我畫不出來!」——十大除錯清單

Canvas 沒畫出東西時不會報錯(因為對它來說「你只是下了不產生可見像素的命令」),所以特別難 debug。畫不出來時,照這張表逐項檢查:

1. **canvas 緩衝區尺寸是 0 或預設 300×150?**(忘了設 `canvas.width`,或被 CSS 擠成 0)
2. **CSS 把 canvas 的顯示尺寸設成 0 / display:none?**(看得到元素但畫不出)
3. **`getContext` 拿到 `null`?**(打錯 `'2d'`、或這塊畫布已綁過別種 context)
4. **顏色沒設、或設成跟背景同色?**(`fillStyle` 預設黑色;白底畫黑字才看得到)
5. **`fill()` / `stroke()` 忘了呼叫?**(只 `arc()` 不 `fill()`,等於只「規劃路徑」沒「落筆」,見第 02 章)
6. **忘了 `beginPath()`?**(路徑會累積到上一個,畫出莫名其妙的線,第 02 章詳述)
7. **座標畫到畫布外?**(x/y 是負的或超過寬高,或被 transform 推出去了,第 03 章)
8. **被 `clearRect` 或下一幀立刻擦掉了?**(在迴圈裡畫完馬上又清)
9. **圖片還沒載入就 `drawImage`?**(要等 `img.onload`,第 04 章)
10. **`globalAlpha` 被設成 0、或 `clip()` 把區域裁沒了?**(狀態殘留,第 02 章)

> **心智模型**:Canvas 不報錯,是因為它是 immediate mode——它忠實執行你的每一道命令,只是「執行了一道不產生可見結果的命令」對它來說完全合法。**Debug Canvas,本質是 debug「你下的命令序列」,不是 debug「畫面物件」**(因為根本沒有物件)。第 02 章理解狀態機後,這類問題會少一大半。

---

## 1.8 本章小結與下一步

這一章我們把 Canvas 真正跑起來,並把兩個最惡名昭彰的坑在第一天就填平:

- **取得 context**:`<canvas>` 是畫框,`getContext('2d')` 是畫筆;一塊畫布只能綁一種 context。
- **座標系**:原點左上、x 右 y **下**(跟數學課相反)。
- **尺寸雙重性**:`width/height` 屬性(緩衝區像素)≠ CSS 尺寸(顯示大小),不匹配就拉伸糊掉。
- **HiDPI 解法**:緩衝區 ×DPR、CSS 維持邏輯尺寸、`ctx.scale(dpr)`——幕後放大、台前不變,清晰度免費翻倍。
- **渲染迴圈**:用 `requestAnimationFrame` 跑「清→算→畫」三拍子;畫面物件是錯覺,真正存在的是你維護的 JS 資料。
- **清空的三種方式**與「重設緩衝區會連 transform 一起清掉」的陷阱。

**下一章(02)**,我們深入「畫筆」本身。你會發現 `ctx` 是一台**巨大的狀態機**:你先設定畫筆狀態(顏色、線寬、變換…),之後所有繪圖都沿用這個狀態,直到你改它。我們會搞懂 `beginPath` 為什麼非用不可、`save()`/`restore()` 這對「狀態存檔/讀檔」如何防止狀態互相污染——這是寫出乾淨 Canvas 程式碼的關鍵,也是後面所有章節的基本功。

> 💡 **動手作業**:把 1.5 的彈球改成「**5 顆顏色、大小、速度都不同的球**」。提示:你需要一個 `balls` 陣列,在 `update`/`render` 裡用迴圈處理。做完你會親身感受到——**所有「物件」都是你自己在 JS 裡維護的,Canvas 只負責把它們畫成像素**。這個體感,是第 08 章「場景圖」的種子。
