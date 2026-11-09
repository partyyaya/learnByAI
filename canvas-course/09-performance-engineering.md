# 第 09 章:效能工程——分層、OffscreenCanvas、Worker

> **學習目標**:先學會**測量**(別瞎猜瓶頸),再掌握最實用的優化:**分層 canvas**、離屏快取、減少狀態切換、按需渲染、整數對齊;以及把繪圖搬到背景執行緒的 **OffscreenCanvas + Web Worker**。最後判斷「何時撞到 Canvas 2D 天花板,該上 GPU」。
> **預計時數**:120 分鐘
> 第 08 章我們把引擎組裝好了,但複雜場景「每幀全畫」會掉幀。這一章教你如何讓它跑得順——而且**順著一條鐵律:先測量,再優化**。

---

## 9.1 第一鐵律:先測量,別憑直覺優化

效能優化最大的浪費,是「優化了根本不是瓶頸的地方」。動手前,先量。

### 看 FPS:有沒有掉幀?

```js
let frames = 0, lastFpsTime = performance.now();
function frame(now) {
  frames++;
  if (now - lastFpsTime >= 1000) {
    console.log('FPS:', frames);   // 穩定 60 才順;掉到 30、跳動就是有問題
    frames = 0; lastFpsTime = now;
  }
  render();
  requestAnimationFrame(frame);   // 排下一幀:讓迴圈自我延續
}
requestAnimationFrame(frame);     // ★ 起手式:先踢一次,迴圈才會跑起來(少了這行 frame 永遠不會被呼叫)
```

更好的是用瀏覽器內建:Chrome DevTools 的 **Rendering → Frame Rendering Stats**(即時 FPS 浮層),以及 **Performance 面板**錄一段,看每幀時間花在哪。

### 抓瓶頸:標記繪製耗時

```js
performance.mark('render-start');
render();
performance.mark('render-end');
performance.measure('render', 'render-start', 'render-end');
// 在 DevTools Performance 的 Timings 軌道看每段耗時
```

> ⚠️ **兩個量測盲點**:
> ① `performance.measure` 量到的只是「**錄下繪圖指令**」的 JS 時間。Chromium 的 2D canvas 先把指令錄起來,幀尾才交給 GPU 行程光柵化——實測一段含 `ctx.filter` 模糊加 `shadowBlur` 的 `render()`,measure 只有 0.1ms,昂貴的部分根本不在這段裡。真正的成本要看 Performance 面板的 **GPU 軌道**與 **Frames 軌道**(掉幀、部分呈現的幀)。
> ② FPS 是會「飽和」的指標:60 fps 看不出你用掉 2ms 還是 15ms。改記每幀耗時的分布(例如 p95),並在 Performance 面板開 **CPU throttling(4×、6×)** 模擬中低階手機——在高階筆電上順,不代表手機上順。

> **心智模型**:**60 FPS = 每幀只有 ~16.6ms 預算**(120Hz 只有 8.3ms)。這 16.6ms 要塞進「你的 update + render + 瀏覽器合成」。超過就掉幀。優化的目標永遠是「把單幀塞回 16.6ms」,所以你得先知道是哪一段超支——是 update 算太久?是 render 畫太多?還是 `getImageData` 在偷時間?

---

## 9.2 瓶頸在哪?破除直覺(呼應第 00 章)

第 00 章破除過「Canvas 2D 純 CPU 所以慢」的迷思。真實的瓶頸常見的有這幾種:

| 瓶頸 | 症狀 | 對應優化 |
|------|------|----------|
| **每幀全畫 + 畫太多** | 物件多時線性變慢 | 分層、按需渲染、視口剔除、髒區(9.3) |
| **像素回讀** `getImageData` | 用了濾鏡就卡;讀過幾次像素後整張畫布變慢 | 效果改用 `ctx.filter`;要讀像素就另開一張專用畫布 + `willReadFrequently`(第 05 章) |
| **狀態切換頻繁** | 大量不同樣式的小圖形 | 批次同樣式(9.3) |
| **昂貴效果**:陰影、blur、漸層 | 開了陰影就掉幀 | 預先快取、少用(9.3) |
| **overdraw**:同一像素畫很多次 | 大量重疊半透明 | 減少重疊層數 |
| **主執行緒被佔住** | 繪圖時 UI 卡住、無法捲動 | OffscreenCanvas + Worker(9.4) |

> **重點**:不同瓶頸,優化方向完全相反。**先用 9.1 量出是哪一種,再選對應的招**,否則白忙。
>「每幀全畫」要靠減少重畫;
>「主執行緒卡住」要靠搬到 Worker;
>「像素回讀」要靠避免 `getImageData`。

> ⚠️ `willReadFrequently: true` 會讓**整張** canvas 改走 CPU 光柵化;沒設它時,Chromium 發現同一張畫布被 `getImageData` 讀了幾次,也會自動把它降級成 CPU(主控台會出現 "Multiple readback operations using getImageData…" 的警告)。實測同一段 `filter` + 陰影的繪製,GPU 畫布 55 fps,降級後不到 2 fps。所以**別對顯示用的主畫布讀像素**:取色、隱藏命中緩衝(第 07 章 7.6)這類要讀的,放在另一張專用畫布上。

---

## 9.3 核心優化技巧

每一招的效果都會隨瀏覽器、裝置與規模而變。文中的數字是一台機器(Chromium、Apple M2)上的實測例子,不是定律——請用 9.1 的方法自己量。

### 技巧一:分層 canvas(最實用,優先做這個)

把畫面拆成**多個疊在一起的 `<canvas>`**,各畫不同更新頻率的內容。「不變的」那層畫一次就好,只重畫「會動的」那層。

```html
<!-- 用 CSS 疊起來:容器給定尺寸,三張 canvas 用 absolute + inset:0 疊在同一位置 -->
<div style="position: relative; width: 800px; height: 600px">
  <canvas id="bg"   style="position:absolute; inset:0"></canvas>  <!-- 靜態背景/格線:幾乎不重畫 -->
  <canvas id="main" style="position:absolute; inset:0"></canvas>  <!-- 圖形:有東西變才重畫 -->
  <canvas id="ui"   style="position:absolute; inset:0"></canvas>  <!-- 選取框/游標:互動時才重畫;pointer 事件都落在這張 -->
</div>
```

```
傳統:每幀重畫【背景 + 1000 個圖形 + UI】← 全部
分層:背景畫一次;只重畫【有變動的那一層】+【UI】← 圖形層一變,仍是整層 1000 個重畫
```

> **心智模型**:分層 = 「**把更新頻率不同的東西分開**」。背景格線一小時不變,憑什麼每秒陪著重畫 60 次?分層讓每一層按自己的節奏更新。這是白板、遊戲(背景層/角色層/UI 層)、圖表(座標軸層/資料層)最常用、CP 值最高的優化,通常比第 08 章的髒矩形更好寫,兩者也能並用。

實作細節:容器沒給尺寸時,absolute 的子元素撐不開它,高度會是 0;pointer 事件只會落在最上層那張,監聽器要掛在最上層或容器上;每層都是一張完整尺寸的緩衝區,記憶體乘上層數(9.5),也都要各自做第 01 章的 HiDPI 設定;最底層若不透明,可用 `getContext('2d', { alpha: false })` 讓瀏覽器省掉混色。拖曳時把被拖的物件暫時移到獨立的「拖曳層」,圖形層就不必每幀整層重畫(Konva 的效能建議也是這樣做)。

### 技巧二:離屏快取(把複雜不變的東西畫一次,之後當圖貼)

如果某個物件畫起來很貴(很多路徑、陰影、文字),但內容不常變,就**先畫到一張離屏 canvas,之後每幀用 `drawImage` 貼上去**(第 04 章:canvas 可當 drawImage 來源):

```js
// 預先把複雜圖示畫到離屏 canvas(只做一次)
function makeSpriteCache(drawFn, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const off = document.createElement('canvas');
  off.width = Math.ceil(w * dpr); off.height = Math.ceil(h * dpr);   // 緩衝區也乘 dpr,否則貼到 HiDPI 主畫布會糊(第 01 章)
  const octx = off.getContext('2d');
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之後用 CSS 像素畫
  drawFn(octx);                   // 把昂貴的繪圖在這裡做一次
  return off;
}
const cached = makeSpriteCache(drawComplexIcon, 64, 64);

// 每幀只要貼上去
function render() {
  ctx.drawImage(cached, x, y, 64, 64);   // drawImage(圖, x, y, 寬, 高) → 指定 CSS 尺寸,dpr 倍的快取剛好縮回 1:1
}
```

> **心智模型**:離屏快取 = 「**算一次,用很多次**」(memoization 的視覺版)。重點是判斷「這東西內容變不變」:不變→快取;每幀都變→快取沒意義(還多一次拷貝)。收益和「原本畫一次有多貴」成正比:陰影、濾鏡、大量路徑、文字很划算;單一個小圓反而可能更慢——在 Chromium 實測,1 萬個 3px 圓改用 `drawImage` 貼,JS 時間是直接 `arc` + `fill` 的約 5 倍。快取尺寸要預留陰影、描邊的外擴空間;快取裡有陰影時,`shadowBlur` 不吃 `setTransform` 的縮放(第 03 章 3.4 的總表),要自己乘 dpr;相機放大後快取也會糊,得依縮放等級重建。

### 技巧三:減少狀態切換,批次同樣式繪圖

每次改 `fillStyle`、`font`、`setLineDash` 等狀態都有成本:`fillStyle` 主要是 CPU 端解析色彩字串,`font` 還要解析、查找字型,通常更貴。大量小圖形時,**把同樣式的排在一起畫**,減少切換:

```js
// ❌ 每個都切換顏色
shapes.forEach(s => { ctx.fillStyle = s.color; ctx.fillRect(s.x, s.y, s.w, s.h); });

// ✅ 依顏色分組,同色一次畫完再換
const byColor = Map.groupBy(shapes, s => s.color);   // Map.groupBy(陣列, 分組函式) → Map{ 顏色 → 該色的圖形陣列 }
for (const [color, group] of byColor) {
  ctx.fillStyle = color;                 // 一種顏色只設一次
  for (const s of group) ctx.fillRect(s.x, s.y, s.w, s.h);
}
```

> ⚠️ **重排繪製順序會改變 z-order**(第 08 章 8.5):圖形互相重疊時,依顏色分組會讓原本在上面的被畫到下面。只有不重疊、或順序無所謂(例如粒子)時才能這樣排。

再進一步,可以把同色的圖形合成**一條路徑、一次 `fill()`**,連繪圖呼叫的次數都省掉:

```js
ctx.beginPath();
for (const p of group) {
  ctx.moveTo(p.x + r, p.y);              // 先移到這個圓的起點,否則會和上一個圓連出一條線
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
}
ctx.fill();                               // 整組只 fill 一次
```

兩招的效果差很多、也看規模:Chromium 實測 1 萬顆粒子,只分組 `fillStyle` 省下約 1/4 的 JS 時間、FPS 不變;合成一條路徑在 1 萬顆時沒有更快,到 20 萬顆才從 18 fps 提升到 25 fps。

### 技巧四:避免昂貴效果與 overdraw

- **陰影(`shadowBlur`)、`filter: blur`** 很貴 → 動態物件少用,或把帶陰影的版本離屏快取。
- **overdraw**(同一塊像素被畫很多次,例如一堆重疊的半透明)→ 減少層數、別畫被完全遮住的物件。
- **整數座標**:填色和 `drawImage` 的座標對齊到裝置像素(`Math.round(x * dpr) / dpr`),邊緣比較清晰,`drawImage` 也不必做次像素插值;**奇數線寬的描邊則要對齊到 .5**——第 02 章的半像素模糊,正是 1px 線落在整數座標造成的。這主要是清晰度問題,效能差異要量了才知道。

### 技巧五:按需渲染(第 06 章的 `invalidate()`)

最有效的優化是「**不畫**」。靜止時(沒動畫、使用者沒操作)根本不該重畫——直接用第 06 章「需要時才排 rAF」的 `invalidate()`:

```js
let scheduled = false;
function invalidate() {                  // 任何改變狀態處呼叫;同一幀改幾次都只排一次
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });   // 動畫還在播,就在 render 裡再 invalidate()
}
```

> 白板、編輯器、圖表這類「大部分時間靜止」的應用,這樣寫靜止時連 rAF 都不排,待機 CPU/GPU 接近 0。若寫成「rAF 一直轉、只在 dirty 時才畫」,省下的只是繪製,迴圈仍每秒被喚醒 60~120 次。**「每秒 60 幀」是動畫才需要,靜態介面別這樣燒電。**

### 技巧六:視口剔除(只畫看得到的)

無限畫布、地圖、大型圖表裡,畫面外的物件畫了也看不到,但 `fill`、`drawImage` 的成本照付。每幀先算出相機的視口(世界座標),只畫包圍盒和視口相交的物件:

```js
// 相機看到的世界範圍(第 03 章:世界 = 螢幕 / zoom + 相機位置)
const view = { x: camera.x, y: camera.y, w: W / camera.zoom, h: H / camera.zoom };
for (const s of scene) {                 // 在 render() 裡、applyCamera 之後
  if (intersects(s.getBounds(), view)) s.draw(ctx);   // intersects、getBounds 見第 08 章 8.6、8.2
}
```

這仍是 O(n):每幀把所有物件的包圍盒掃一遍。物件上萬時,改用第 07 章 7.7 的空間索引(均勻網格、四叉樹)直接查「視口裡有哪些」,只碰得到看得見的那些。

---

## 9.4 OffscreenCanvas + Web Worker:把繪圖搬離主執行緒

前面的優化都在減少工作量。但有時工作量就是大(複雜視覺化、即時影像處理),在主執行緒做會**卡住 UI**(捲動、點擊都頓)。解法:**把繪圖整個搬到 Web Worker 的背景執行緒**,主執行緒保持流暢。

關鍵 API 是 `OffscreenCanvas` + `transferControlToOffscreen`:

```js
// ── 主執行緒 ──
const canvas = document.querySelector('#stage');   // 這張畫布之前不能 getContext 過(見下方 ⚠️ ①)
const offscreen = canvas.transferControlToOffscreen();   // 把畫布控制權交出去
const worker = new Worker('render-worker.js');
worker.postMessage({ canvas: offscreen }, [offscreen]);  // transfer(零拷貝)給 Worker
// 主執行緒不再負責繪圖:Worker 再忙,也不會拖慢捲動與點擊
```

```js
// ── render-worker.js(背景執行緒)──
let ctx;
self.onmessage = (e) => {
  if (e.data.canvas) {
    ctx = e.data.canvas.getContext('2d');   // 在 Worker 裡拿 context
    loop();
  }
};
function loop() {
  // requestAnimationFrame 在 Worker 裡也能用
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);   // clearRect(x, y, 寬, 高) → 清掉整張;OffscreenCanvas 知道自己的緩衝區寬高
  // ...繁重的繪圖,完全不影響主執行緒...
  requestAnimationFrame(loop);
}
```

| 場景 | 適合搬 Worker 嗎 |
|------|------------------|
| 繁重的離線渲染、即時影像處理、大規模視覺化 | ✅ 很適合,主執行緒解放 |
| 需要密集讀 DOM、頻繁跟 UI 互動 | ⚠️ Worker 不能碰 DOM,通訊成本可能蓋過好處 |
| 簡單動畫、物件不多 | ❌ 沒必要,徒增複雜度 |

> **心智模型**:`transferControlToOffscreen` 是把畫布的「遙控器」交給 Worker——交出後主執行緒就不能再直接畫它了,但也因此 Worker 怎麼忙都不卡 UI。配合 `createImageBitmap`(第 04 章)可零拷貝把圖片資料丟給 Worker。這是 Canvas 效能的「大絕招」,但**先把 9.3 的招用完、確認瓶頸真的是主執行緒被佔住,再上這個**(它有通訊與架構複雜度)。

> ⚠️ **Worker 繪圖的四個必踩細節**:
> ① **相容性與轉移規則**:Chrome 69、Firefox 105、Safari 16.4(2023 年)起都支援 2D 的 `OffscreenCanvas` 與 `transferControlToOffscreen`(WebGL 版要 Safari 17);要支援更舊的 iOS,才需要 feature detection 與「降級回主執行緒畫」的路徑。**轉移前不能對它呼叫過 `getContext`**,轉移也只能一次,否則丟 `InvalidStateError`——第 01 章的 HiDPI 設定函式會先 `getContext`,要轉移的畫布不能先跑它。
> ② **Worker 讀不到 `devicePixelRatio`,也讀不到 `getBoundingClientRect`**:Worker 只知道緩衝區的寬高(`ctx.canvas.width/height`),DPR 與 CSS 顯示尺寸都得由主執行緒 `postMessage` 傳進去,否則 HiDPI 會糊(第 01 章)。
> ③ **resize**:轉移後主執行緒設 `canvas.width` 會丟錯,只能設 CSS 尺寸;緩衝區尺寸要 `postMessage` 通知 Worker 改 `offscreen.width/height`。
> ④ **資源與事件**:Worker 裡沒有 `Image`,圖片用 `fetch` + `createImageBitmap(blob)` 載入,用完 `bitmap.close()` 立即釋放;主文件載入的 web font 不會自動帶進 Worker,要在 Worker 裡 `new FontFace(...)` 載入後加進 `self.fonts`;pointer 事件仍只發生在主執行緒,要轉送給 Worker(每幀合併一次),會多約一幀的延遲。

---

## 9.5 記憶體:canvas 比你想的吃記憶體

每張 canvas 吃的記憶體 ≈ **緩衝區實體像素數 × 4 bytes**(RGBA 各 1 byte;這是下限,GPU 端的額外緩衝、讀回時的 CPU 副本都可能讓實際用量翻倍)。換算時注意**別重複乘 dpr**:要嘛用「實體尺寸 × 4」、要嘛用「CSS 尺寸 × 4 × dpr²」,兩者等價、擇一。例:
一張顯示 1920×1080 的畫布,在 dpr=2 的螢幕上,實體緩衝區是 3840×2160,`3840 × 2160 × 4 ≈ 33MB`(若誤用「實體尺寸 ×4×dpr²」會算成四倍的 ~133MB,那就是重複乘了)。大量離屏 canvas(離屏快取、隱藏命中緩衝)會迅速吃光記憶體。

- 不再用的離屏 canvas,把寬高設為 0(`c.width = c.height = 0`)幫助回收;`ImageBitmap` 用完呼叫 `close()`。
- 單張畫布有面積上限,超過時通常不會丟錯,只是畫不出來(或 `getContext` 回傳 `null`)。iOS Safari 約為 16,777,216 像素(4096²),而且以緩衝區像素計:dpr=3 的手機上,一張 1400×1400 CSS 像素的快取畫布(4200×4200)就超過了。Safari 另有整頁 canvas 總記憶體的上限——別開超大或超多畫布。

---

## 9.6 何時撞到 Canvas 2D 的天花板?

當你把上述優化都做完,還是達不到 60fps,通常是因為**圖元數量級超過了 Canvas 2D 的設計範圍**:

- 數萬以上的獨立圖元每幀都在動。
- 大量複雜特效(發光、混合、即時變形)。
- 需要 3D。

這時候,問題不在「優化 Canvas 2D」,而是「**換引擎**」——上 WebGL / WebGPU,讓 GPU 平行處理數十萬圖元。

> **務實決策**:**先把 2D 優化做滿(分層、快取、按需渲染、視口剔除、Worker),撐不住再上 GPU**。GPU 的開發成本高得多(第 10 章你會看到),別一開始就為了「聽起來比較快」跳進去。很多人以為要用 WebGL,其實分層 + 按需渲染就解決了。

---

## 9.7 綜合:把「每幀全畫」優化成「分層 + 按需」

一個典型重構,把第 08 章的場景圖加上效能架構:

```js
// 三層:背景(靜態格線)、內容(圖形)、覆蓋(選取框/hover)
const bgCtx = bg.getContext('2d');
const contentCtx = content.getContext('2d');
const overlayCtx = overlay.getContext('2d');

let bgDirty = true, contentDirty = true, overlayDirty = true, scheduled = false;
function schedule() {                       // 技巧五:需要時才排 rAF
  if (!scheduled) { scheduled = true; requestAnimationFrame(frame); }
}
function invalidateContent() { contentDirty = true; schedule(); }
function invalidateOverlay() { overlayDirty = true; schedule(); }
function invalidateCamera() { bgDirty = contentDirty = overlayDirty = true; schedule(); }   // 平移縮放:三層都要重畫

function frame() {
  scheduled = false;
  if (bgDirty) { drawGrid(bgCtx, camera); bgDirty = false; }   // 背景:只在啟動與平移縮放時重畫
  if (contentDirty) {                       // 只在圖形變動時重畫內容層
    contentCtx.clearRect(0, 0, W, H);
    contentCtx.save(); applyCamera(contentCtx, camera);
    for (const s of scene) s.draw(contentCtx);
    contentCtx.restore();
    contentDirty = false;
  }
  if (overlayDirty) {                        // hover/選取變動時才重畫覆蓋層
    overlayCtx.clearRect(0, 0, W, H);
    overlayCtx.save(); applyCamera(overlayCtx, camera);   // 選取框也在世界座標,要套同一個相機
    if (selected) drawSelectionBox(overlayCtx, selected);
    overlayCtx.restore();
    overlayDirty = false;
  }
}
schedule();                                  // 啟動時畫第一次
```

效果:滑鼠 hover 時只重畫**最輕的 overlay 層**;圖形沒動時 content 層完全不重畫;背景格線除非平移縮放否則永不重畫。**從「每幀全畫」變成「只畫真正變的最小部分」。**

---

## 9.8 本章小結與下一步

- **先測量**:用 FPS 計數、DevTools Performance/Frame Stats、`performance.mark` 找出真正的瓶頸;每幀預算 16.6ms。`performance.mark` 只量到錄指令的時間、FPS 會飽和,要看 GPU 軌道與每幀耗時。
- **瓶頸有很多種**:每幀全畫、像素回讀、狀態切換、昂貴效果、overdraw、主執行緒被佔——**對症下藥**;別對顯示用的主畫布讀像素。
- **最實用的優化**:**分層 canvas**(按更新頻率分開)、離屏快取(貴的才划算)、批次同樣式(注意 z-order)、避免陰影/overdraw、**按需渲染**(需要時才排 rAF)、**視口剔除**(只畫看得到的)。
- **OffscreenCanvas + Worker**:把繁重繪圖搬到背景執行緒,主執行緒不卡;但先確認瓶頸真在主執行緒,且轉移前不能 `getContext`。
- **記憶體**:canvas 吃「實體寬 × 高 × 4」(= CSS 寬 × 高 × 4 × dpr²);單張有面積上限(iOS 約 4096²),離屏畫布要回收。
- **天花板**:2D 優化做滿仍不夠(數萬動態圖元/3D),才換 GPU。

**下一章(10)**,我們走到 Canvas 2D 的邊界之外:**WebGL / WebGPU**。重點不是教你寫 shader,而是完成一次**心智轉換**——從「下繪圖命令」(你說畫什麼)到「定義管線 + 丟資料給 GPU 平行處理」(你給 GPU 程式和資料,它自己算)。你會理解 draw call 成本、為什麼大家用 PixiJS/three.js,以及 WebGPU 跟你 [Browser AI 課](../browserAI/README.md) 的關係。

> 💡 **動手作業**:做一個「10000 個移動粒子」的壓力測試。先用「每幀全畫單層」實作,用 9.1 的 FPS 計數量出幀率;再依序加上優化(離屏快取粒子貼圖、批次、若靜止則按需渲染),記錄每一步的 FPS 變化。**親手量出「哪個優化最有效」,比讀十遍更有體感**——你會發現答案常常出乎意料,這正是「先測量」的意義。

### 動手作業參考實作

先自己動手做,卡住或想對答案時再看:

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>第 09 章作業:10000 粒子壓力測試</title>
<style>
  body { font-family: sans-serif; }
  #panel { display: flex; gap: 14px; align-items: center; margin-bottom: 8px; }
  canvas { border: 1px solid #ccc; }
</style></head>
<body>
  <!-- 由基準開始,逐個打開優化、記下 FPS,親手量出哪個最有效 -->
  <div id="panel">
    <span>FPS:<strong id="fps">—</strong></span>
    <label><input type="checkbox" id="optSprite"> ①離屏快取貼圖</label>
    <label><input type="checkbox" id="optBatch"> ②同色批次</label>
    <label><input type="checkbox" id="optOnDemand"> ③按需渲染</label>
    <label><input type="checkbox" id="pause"> 暫停移動(配合③,靜止時整個 render 被跳過)</label>
  </div>
  <canvas id="stage" width="800" height="500"></canvas>
  <script>
    const canvas = document.querySelector('#stage');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const $ = id => document.querySelector('#' + id);

    // ---- 建 10000 顆移動粒子(作業要求的壓力測試規模) ----
    // 速度單位是「像素/秒」,配合第 06 章的 delta-time 寫法
    const COLORS = ['#e63946', '#f4a261', '#2a9d8f', '#457b9d', '#9b5de5'];
    const R = 3;                             // 半徑固定,離屏貼圖才能所有粒子共用
    const particles = [];
    for (let i = 0; i < 10000; i++) {        // 作業要求:10000 個粒子
      particles.push({
        x: R + Math.random() * (W - R * 2),
        y: R + Math.random() * (H - R * 2),
        vx: (Math.random() - 0.5) * 200,     // -100~+100 像素/秒
        vy: (Math.random() - 0.5) * 200,
        colorIndex: i % COLORS.length
      });
    }

    // ---- 優化②的前置:依顏色分組(顏色不會變,啟動時分一次就好) ----
    const byColor = COLORS.map(() => []);
    for (const p of particles) byColor[p.colorIndex].push(p);

    // ---- 優化①:離屏快取粒子貼圖(9.3 技巧二:算一次,用很多次) ----
    // 每種顏色的圓只在這裡 arc+fill 一次,之後每幀用 drawImage 貼
    function makeSprite(color) {
      const off = document.createElement('canvas');   // 離屏 canvas 可當 drawImage 來源(第 04 章)
      off.width = off.height = R * 2;
      const octx = off.getContext('2d');
      octx.fillStyle = color;
      octx.beginPath();
      octx.arc(R, R, R, 0, Math.PI * 2);
      octx.fill();
      return off;
    }
    const sprites = COLORS.map(makeSprite);

    // ---- 優化③的 dirty flag(9.3 技巧五,源自第 06 章的按需渲染) ----
    let dirty = true;
    // 開關變動也要重畫一次,否則按需渲染下畫面不會反映新狀態
    for (const id of ['optSprite', 'optBatch', 'optOnDemand', 'pause']) {
      $(id).addEventListener('change', () => { dirty = true; });
    }

    function update(dt) {
      if ($('pause').checked) return;        // 全部靜止:不移動,也就不會把 dirty 設起來
      for (const p of particles) {
        p.x += p.vx * dt;                    // 速度 × 時間 = 位移(第 06 章 delta-time)
        p.y += p.vy * dt;
        if (p.x < R || p.x > W - R) p.vx *= -1;   // 撞牆反彈
        if (p.y < R || p.y > H - R) p.vy *= -1;
      }
      dirty = true;                          // 有東西動了,才需要重畫
    }

    // ---- render:三種畫法由開關決定,方便逐項比較 FPS ----
    function render() {
      ctx.clearRect(0, 0, W, H);
      if ($('optSprite').checked) {
        // 優化①:每幀只做 drawImage(9.3 技巧二)——小圓的快取不一定比 arc+fill 快,量量看
        // 注意:①開啟時②沒有作用,因為 drawImage 不切 fillStyle 狀態
        for (const p of particles) {
          ctx.drawImage(sprites[p.colorIndex], p.x - R, p.y - R);
        }
      } else if ($('optBatch').checked) {
        // 優化②:同色排在一起畫,一種顏色 fillStyle 只設一次(9.3 技巧三:批次減少狀態切換)
        for (let c = 0; c < COLORS.length; c++) {
          ctx.fillStyle = COLORS[c];
          for (const p of byColor[c]) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        // 基準:每幀全畫單層,逐顆切狀態 + arc+fill(先量出這個當對照組)
        for (const p of particles) {
          ctx.fillStyle = COLORS[p.colorIndex];
          ctx.beginPath();
          ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ---- FPS 計數(9.1 的量法):每滿一秒統計跑了幾幀 ----
    // 顯示在 canvas 外的 DOM 上,才不會被按需渲染跳過而凍住
    let frames = 0, lastFpsTime = performance.now();
    const fpsEl = $('fps');

    let lastTime = 0;
    function frame(now) {
      const dt = Math.min((now - lastTime) / 1000, 0.1);   // dt 並 clamp 防暴衝(第 06 章 6.7)
      lastTime = now;

      frames++;                              // 作業要求:畫面顯示即時 FPS(9.1)
      if (now - lastFpsTime >= 1000) {
        fpsEl.textContent = frames;
        frames = 0; lastFpsTime = now;
      }

      update(dt);
      // 優化③:按需渲染——開啟後只在 dirty 時畫;「暫停移動」讓全部靜止,
      // 此時整個 render 被跳過,FPS 回到滿速(為了數 FPS,這裡讓 rAF 一直轉;實際應用用 9.3 技巧五的寫法,靜止時連 rAF 都不排)
      if (!$('optOnDemand').checked || dirty) {
        render();
        dirty = false;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  </script>
</body>
</html>
```
