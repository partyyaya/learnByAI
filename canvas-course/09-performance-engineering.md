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
  requestAnimationFrame(frame);
}
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

> **心智模型**:**60 FPS = 每幀只有 ~16.6ms 預算**(120Hz 只有 8.3ms)。這 16.6ms 要塞進「你的 update + render + 瀏覽器合成」。超過就掉幀。優化的目標永遠是「把單幀塞回 16.6ms」,所以你得先知道是哪一段超支——是 update 算太久?是 render 畫太多?還是 `getImageData` 在偷時間?

---

## 9.2 瓶頸在哪?破除直覺(呼應第 00 章)

第 00 章破除過「Canvas 2D 純 CPU 所以慢」的迷思。真實的瓶頸通常是這幾個,按常見度排:

| 瓶頸 | 症狀 | 對應優化 |
|------|------|----------|
| **每幀全畫 + 畫太多** | 物件多時線性變慢 | 分層、按需渲染、髒區(9.3) |
| **像素回讀** `getImageData` | 用了濾鏡就卡 | 改 `ctx.filter`、`willReadFrequently`(第 05 章) |
| **狀態切換頻繁** | 大量不同樣式的小圖形 | 批次同樣式(9.3) |
| **昂貴效果**:陰影、blur、漸層 | 開了陰影就掉幀 | 預先快取、少用(9.3) |
| **overdraw**:同一像素畫很多次 | 大量重疊半透明 | 減少重疊層數 |
| **主執行緒被佔住** | 繪圖時 UI 卡住、無法捲動 | OffscreenCanvas + Worker(9.4) |

> **重點**:不同瓶頸,優化方向完全相反。「每幀全畫」要靠減少重畫;「主執行緒卡住」要靠搬到 Worker;「像素回讀」要靠避免 `getImageData`。**先用 9.1 量出是哪一種,再選對應的招**,否則白忙。

---

## 9.3 核心優化技巧

### 技巧一:分層 canvas(最實用,優先做這個)

把畫面拆成**多個疊在一起的 `<canvas>`**,各畫不同更新頻率的內容。「不變的」那層畫一次就好,只重畫「會動的」那層。

```html
<!-- 用 CSS 疊起來:position absolute,同一位置 -->
<div style="position: relative">
  <canvas id="bg"   style="position:absolute"></canvas>  <!-- 靜態背景/格線:幾乎不重畫 -->
  <canvas id="main" style="position:absolute"></canvas>  <!-- 動態圖形:常重畫 -->
  <canvas id="ui"   style="position:absolute"></canvas>  <!-- 選取框/游標:互動時才重畫 -->
</div>
```

```
傳統:每幀重畫【背景 + 1000 個圖形 + UI】← 全部
分層:背景畫一次;每幀只重畫【動的那幾個圖形】+【UI】← 大幅減少
```

> **心智模型**:分層 = 「**把更新頻率不同的東西分開**」。背景格線一小時不變,憑什麼每秒陪著重畫 60 次?分層讓每一層按自己的節奏更新。這是白板、遊戲(背景層/角色層/UI 層)、圖表(座標軸層/資料層)最常用、CP 值最高的優化,通常比第 08 章的髒矩形更好寫、更有效。

### 技巧二:離屏快取(把複雜不變的東西畫一次,之後當圖貼)

如果某個物件畫起來很貴(很多路徑、陰影、文字),但內容不常變,就**先畫到一張離屏 canvas,之後每幀用 `drawImage` 貼上去**(第 04 章:canvas 可當 drawImage 來源):

```js
// 預先把複雜圖示畫到離屏 canvas（只做一次）
function makeSpriteCache(drawFn, w, h) {
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  drawFn(off.getContext('2d'));   // 把昂貴的繪圖在這裡做一次
  return off;
}
const cached = makeSpriteCache(drawComplexIcon, 64, 64);

// 每幀只要貼上去（drawImage 很快）
function render() {
  ctx.drawImage(cached, x, y);    // 比每幀重畫複雜路徑快很多
}
```

> **心智模型**:離屏快取 = 「**算一次,用很多次**」(memoization 的視覺版)。重點是判斷「這東西內容變不變」:不變→快取;每幀都變→快取沒意義(還多一次拷貝)。

### 技巧三:減少狀態切換,批次同樣式繪圖

每次改 `fillStyle`、`font`、`setLineDash` 等狀態,底層可能要重設管線。大量小圖形時,**把同樣式的排在一起畫**,減少切換:

```js
// ❌ 每個都切換顏色
shapes.forEach(s => { ctx.fillStyle = s.color; ctx.fillRect(...); });

// ✅ 依顏色分組,同色一次畫完再換
const byColor = groupBy(shapes, s => s.color);
for (const [color, group] of byColor) {
  ctx.fillStyle = color;                 // 一種顏色只設一次
  for (const s of group) ctx.fillRect(s.x, s.y, s.w, s.h);
}
```

### 技巧四:避免昂貴效果與 overdraw

- **陰影(`shadowBlur`)、`filter: blur`** 很貴 → 動態物件少用,或把帶陰影的版本離屏快取。
- **overdraw**(同一塊像素被畫很多次,例如一堆重疊的半透明)→ 減少層數、別畫被完全遮住的物件。
- **整數座標**:在非變換的情境,把繪圖座標 `Math.round` 對齊整數像素,可避免反鋸齒的額外計算(也順帶避免第 02 章的半像素模糊)。

### 技巧五:按需渲染(第 06 章的 dirty flag)

最有效的優化是「**不畫**」。靜止時(沒動畫、使用者沒操作)根本不該重畫:

```js
let dirty = true;
function invalidate() { dirty = true; }   // 任何改變狀態處呼叫
function frame() {
  if (dirty) { render(); dirty = false; }  // 只在 dirty 時畫
  requestAnimationFrame(frame);
}
```

> 白板、編輯器、圖表這類「大部分時間靜止」的應用,按需渲染能把待機 CPU/GPU 降到接近 0。**「每秒 60 幀」是動畫才需要,靜態介面別這樣燒電。**

---

## 9.4 OffscreenCanvas + Web Worker:把繪圖搬離主執行緒

前面的優化都在減少工作量。但有時工作量就是大(複雜視覺化、即時影像處理),在主執行緒做會**卡住 UI**(捲動、點擊都頓)。解法:**把繪圖整個搬到 Web Worker 的背景執行緒**,主執行緒保持流暢。

關鍵 API 是 `OffscreenCanvas` + `transferControlToOffscreen`:

```js
// ── 主執行緒 ──
const canvas = document.querySelector('#stage');
const offscreen = canvas.transferControlToOffscreen();   // 把畫布控制權交出去
const worker = new Worker('render-worker.js');
worker.postMessage({ canvas: offscreen }, [offscreen]);  // transfer(零拷貝)給 Worker
// 主執行緒現在完全不碰繪圖,UI 永遠流暢
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
  ctx.clearRect(0, 0, 800, 600);   // clearRect(x, y, 寬, 高) → 清掉 (0,0) 起、800×600 的區域(這裡等於整張畫布)
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

> ⚠️ **Worker 繪圖的三個必踩細節**:
> ① **相容性**:`transferControlToOffscreen` 與 Worker 內的 `OffscreenCanvas` 較新(Safari 支援得晚),用前要 feature detection,並備好「降級回主執行緒畫」的路徑。
> ② **Worker 讀不到 `devicePixelRatio`,也讀不到 `getBoundingClientRect`**——DPR 與顯示尺寸都得由主執行緒 `postMessage` 傳進去(上面 Worker 裡 `clearRect(0, 0, 800, 600)` 之所以寫死,正是因為它拿不到 DOM 資訊;實務上這些值要傳入,否則 HiDPI 會糊,呼應第 01 章)。
> ③ **resize**:畫布控制權 transfer 出去後,主執行緒不能再設它的尺寸,resize 要改用 `postMessage` 通知 Worker 重設。

---

## 9.5 記憶體:canvas 比你想的吃記憶體

每張 canvas 吃的記憶體 ≈ **緩衝區實體像素數 × 4 bytes**(RGBA 各 1 byte)。換算時注意**別重複乘 dpr**:要嘛用「實體尺寸 × 4」、要嘛用「CSS 尺寸 × 4 × dpr²」,兩者等價、擇一。例:一張顯示 1920×1080 的畫布,在 dpr=2 的螢幕上,實體緩衝區是 3840×2160,`3840 × 2160 × 4 ≈ 33MB`(若誤用「實體尺寸 ×4×dpr²」會算成四倍的 ~133MB,那就是重複乘了)。大量離屏 canvas(離屏快取、隱藏命中緩衝)會迅速吃光記憶體。

- 不再用的離屏 canvas,把寬高設為 0(`c.width = c.height = 0`)幫助回收。
- 行動裝置對 canvas 總面積有上限,超過會直接失效或崩潰——別開超大或超多畫布。

---

## 9.6 何時撞到 Canvas 2D 的天花板?

當你把上述優化都做完,還是達不到 60fps,通常是因為**圖元數量級超過了 Canvas 2D 的設計範圍**:

- 數萬以上的獨立圖元每幀都在動。
- 大量複雜特效(發光、混合、即時變形)。
- 需要 3D。

這時候,問題不在「優化 Canvas 2D」,而是「**換引擎**」——上 WebGL / WebGPU,讓 GPU 平行處理數十萬圖元。

> **務實決策**:**先把 2D 優化做滿(分層、快取、按需渲染、Worker),撐不住再上 GPU**。GPU 的開發成本高得多(第 10 章你會看到),別一開始就為了「聽起來比較快」跳進去。很多人以為要用 WebGL,其實分層 + 按需渲染就解決了。

---

## 9.7 綜合:把「每幀全畫」優化成「分層 + 按需」

一個典型重構,把第 08 章的場景圖加上效能架構:

```js
// 三層:背景(靜態格線)、內容(圖形)、覆蓋(選取框/hover)
const bgCtx = bg.getContext('2d');
const contentCtx = content.getContext('2d');
const overlayCtx = overlay.getContext('2d');

drawGrid(bgCtx);   // 背景:啟動畫一次,平移縮放才重畫

let contentDirty = true, overlayDirty = true;
function invalidateContent() { contentDirty = true; }
function invalidateOverlay() { overlayDirty = true; }

function frame() {
  if (contentDirty) {                       // 只在圖形變動時重畫內容層
    contentCtx.clearRect(0, 0, W, H);
    contentCtx.save(); applyCamera(contentCtx, camera);
    for (const s of scene) s.draw(contentCtx);
    contentCtx.restore();
    contentDirty = false;
  }
  if (overlayDirty) {                        // hover/選取變動時才重畫覆蓋層
    overlayCtx.clearRect(0, 0, W, H);
    if (selected) drawSelectionBox(overlayCtx, selected);
    overlayDirty = false;
  }
  requestAnimationFrame(frame);
}
```

效果:滑鼠 hover 時只重畫**最輕的 overlay 層**;圖形沒動時 content 層完全不重畫;背景格線除非平移縮放否則永不重畫。**從「每幀全畫」變成「只畫真正變的最小部分」。**

---

## 9.8 本章小結與下一步

- **先測量**:用 FPS 計數、DevTools Performance/Frame Stats、`performance.mark` 找出真正的瓶頸;每幀預算 16.6ms。
- **瓶頸有很多種**:每幀全畫、像素回讀、狀態切換、昂貴效果、overdraw、主執行緒被佔——**對症下藥**。
- **最實用的優化**:**分層 canvas**(按更新頻率分開)、離屏快取(算一次用多次)、批次同樣式、避免陰影/overdraw、**按需渲染**(靜止不畫)。
- **OffscreenCanvas + Worker**:把繁重繪圖搬到背景執行緒,主執行緒不卡;但先確認瓶頸真在主執行緒。
- **記憶體**:canvas 吃 `w×h×4×dpr²`,離屏畫布要回收。
- **天花板**:2D 優化做滿仍不夠(數萬動態圖元/3D),才換 GPU。

**下一章(10)**,我們走到 Canvas 2D 的邊界之外:**WebGL / WebGPU**。重點不是教你寫 shader,而是完成一次**心智轉換**——從「下繪圖命令」(你說畫什麼)到「定義管線 + 丟資料給 GPU 平行處理」(你給 GPU 程式和資料,它自己算)。你會理解 draw call 成本、為什麼大家用 PixiJS/three.js,以及 WebGPU 跟你 [Browser AI 課](../browserAI/README.md) 的關係。

> 💡 **動手作業**:做一個「10000 個移動粒子」的壓力測試。先用「每幀全畫單層」實作,用 9.1 的 FPS 計數量出幀率;再依序加上優化(離屏快取粒子貼圖、批次、若靜止則按需渲染),記錄每一步的 FPS 變化。**親手量出「哪個優化最有效」,比讀十遍更有體感**——你會發現答案常常出乎意料,這正是「先測量」的意義。
