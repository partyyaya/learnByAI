# 第 07 章:互動與命中測定(Hit Testing)

> **學習目標**:兌現第 00 章最核心的推論——**Canvas 沒有 per-shape 事件,點到誰要自己算**。掌握「滑鼠座標 → 世界座標 → 判斷命中哪個物件」的完整鏈路:幾何數學命中、`isPointInPath`/`Path2D`、z-order 取最上層、**隱藏色彩緩衝**神技、空間索引,最後做出可 hover、可選取、可拖曳的互動。
> **預計時數**:130 分鐘
> 這是把 Canvas 從「會動的圖」變成「可互動的應用」的關鍵一章,也是這門課最能體現「自己造引擎」精神的一章——你要親手補上 DOM 免費送你的整套事件系統。

---

## 7.1 為什麼 Canvas「沒有 click 事件」?

回顧第 00 章:DOM 是 retained mode,瀏覽器記得每個元素,所以你點下去,它知道「你點的是那個按鈕」,自動派發 `click` 給它。

Canvas 是 immediate mode,**畫面上沒有物件,只有像素**。你點了畫布,瀏覽器只能告訴你:

```js
canvas.addEventListener('click', (e) => {
  // 它只知道:「canvas 這塊元素被點了,座標是 (e.clientX, e.clientY)」
  // 它完全不知道那個座標上有沒有圖形、是哪一個 —— 因為對它來說圖形不存在
});
```

**「那個座標上是哪個圖形?」這個問題,只能你自己回答。** 這就是命中測定(hit testing)。

> **心智模型**:DOM 的事件系統幫你做了兩件事——① 知道滑鼠在哪;② 知道那裡有哪個物件,把事件送給它。Canvas 只給你 ①,**② 整個是你的工作**。這一章就是手工打造 ②。

---

## 7.2 第一步永遠是:把事件座標轉成「世界座標」

在判斷命中之前,有一個必經步驟,90% 的 bug 出在這裡沒做對。瀏覽器給的 `e.clientX/Y` 是「視窗座標」,而你的物件存的是「世界座標」(第 03 章)。中間隔了兩層:canvas 在頁面的位置、以及相機變換。

```js
function eventToWorld(canvas, camera, e) {
  // ① 視窗座標 → 畫布內 CSS 座標(減掉 canvas 在頁面的位置)
  const rect = canvas.getBoundingClientRect();
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;

  // ② 畫布座標 → 世界座標(套用相機逆變換,第 03 章 screenToWorld)
  return {
    x: cssX / camera.zoom + camera.x,
    y: cssY / camera.zoom + camera.y,
  };
}
```

> ⚠️ 三個常見錯誤:① 直接拿 `e.offsetX` 在有 CSS 縮放/邊框時會錯,用 `getBoundingClientRect` 最穩;② 忘了套相機逆變換,平移縮放後命中全亂;③ HiDPI 處理不一致(第 01 章我們在 context 上 `scale(dpr)`,所以這裡用 CSS 座標即可,不用乘 dpr——但要跟你的繪圖座標系**保持一致**)。

**之後所有命中判斷,都用這個 world point 跟物件的世界座標比。** 把它做對,後面才有意義。

---

## 7.3 幾何數學命中:點在不在圖形內?

最基本、最快的方法:用數學直接算。每種形狀有自己的判斷式。

### 點在矩形內

```js
function pointInRect(p, rect) {
  return p.x >= rect.x && p.x <= rect.x + rect.w &&
         p.y >= rect.y && p.y <= rect.y + rect.h;
}
```

### 點在圓內(算距離)

```js
function pointInCircle(p, circle) {
  const dx = p.x - circle.cx;
  const dy = p.y - circle.cy;
  return dx * dx + dy * dy <= circle.r * circle.r;   // 比平方,省一次開根號
}
```

> **小優化**:比較距離時用「平方」(`dx²+dy² <= r²`)而不是 `Math.sqrt(...) <= r`,省掉開根號。命中測定常常每幀對很多物件跑,這種小優化會累積。

### 點在多邊形內(射線法 ray casting)

任意多邊形用「**從該點射一條水平射線,數它穿過多邊形邊幾次:奇數=在內,偶數=在外**」:

```js
function pointInPolygon(p, points) {   // points: [{x,y}, ...]
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;   // 每穿過一條邊就翻轉
  }
  return inside;
}
```

### 點在「線段附近」(線/連接線的命中)

線沒有面積,要判斷「點離線段夠不夠近」(算點到線段的最短距離 < 容差):

```js
function pointNearSegment(p, a, b, tolerance = 5) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));              // 夾在線段範圍內
  const cx = a.x + t * dx, cy = a.y + t * dy;   // 線段上最近的點
  const ddx = p.x - cx, ddy = p.y - cy;
  return ddx * ddx + ddy * ddy <= tolerance * tolerance;
}
```

> **心智模型**:幾何命中是「**用座標和半徑/邊界算數學**」。快、精確、不佔記憶體,適合形狀規則(矩形、圓、多邊形)的場景。缺點是每種形狀要寫一套,且旋轉/縮放過的形狀要先把點轉回形狀的本地座標系(用第 03 章的逆變換)再判斷。

---

## 7.4 用 Canvas 內建:`isPointInPath` 與 `Path2D`

當形狀很不規則(複雜路徑、貝茲曲線),自己寫數學太難。Canvas 提供 `isPointInPath`:**重建那條路徑,問 context「這個點在不在路徑裡」**。

```js
ctx.beginPath();
ctx.arc(100, 100, 40, 0, Math.PI * 2);
if (ctx.isPointInPath(mouseX, mouseY)) {  // 注意:用「畫布座標」,且受當前變換影響
  console.log('命中圓');
}
ctx.isPointInStroke(mouseX, mouseY);      // 是否在「描邊線」上(命中細線好用)
```

問題:每次判斷都要重建路徑,而且座標系要對。更好的做法是用 **`Path2D` 物件把路徑存起來**,重複使用:

```js
// 建立時就把每個物件的路徑存成 Path2D
const circlePath = new Path2D();
circlePath.arc(100, 100, 40, 0, Math.PI * 2);

// 畫的時候直接用
ctx.fill(circlePath);

// 命中判斷:傳入 Path2D,不用重建
if (ctx.isPointInPath(circlePath, mouseX, mouseY)) { /* 命中 */ }
```

> **取捨**:`isPointInPath` 的好處是「畫什麼形狀就能命中什麼形狀」,不用為每種形狀寫數學;壞處是它受 context 當前變換影響(座標要對齊),且大量物件時逐一呼叫不夠快。**規則形狀用 7.3 的數學、不規則形狀用 `Path2D` + `isPointInPath`** 是常見搭配。

---

## 7.5 多個物件:從上到下測,取最上層

畫面上有很多物件且會重疊。使用者點下去,應該命中「**最上面那個**」(視覺上蓋住別人的那個)。

繪製順序是「先畫的在下、後畫的在上」(z-order)。所以命中測定要**反向遍歷**(從最後畫的、也就是最上層開始),命中第一個就回傳:

```js
function hitTest(worldPoint, scene) {
  // 反向:從最上層(陣列尾端)往下找
  for (let i = scene.length - 1; i >= 0; i--) {
    if (scene[i].containsPoint(worldPoint)) {
      return scene[i];   // 命中最上層的就回傳,不再往下
    }
  }
  return null;           // 點到空白
}
```

> **心智模型**:畫畫是「由下往上疊」,命中是「由上往下找」——跟你伸手去拿一疊紙最上面那張的直覺一致。這個「反向遍歷取第一個命中」是所有編輯器選取邏輯的核心。

---

## 7.6 神技:隱藏色彩緩衝(Color Picking / Hidden Hit Canvas)

當形狀極度不規則(複雜路徑、半透明、甚至是逐像素的圖),數學命中寫不出來、`isPointInPath` 又太慢。有一個漂亮的招數:**用顏色當 ID**。

做法:

1. 開一張**離屏 canvas**(跟主畫布一樣大,但不顯示)。
2. 把每個物件用一個**獨一無二的純色**(當作它的 ID)畫到這張離屏 canvas 上(形狀跟主畫布完全一樣)。
3. 命中時,讀離屏 canvas 上**滑鼠螢幕位置那一點的顏色**(`getImageData` 1×1),把顏色換算回物件 ID。

```js
// 把 index 編碼成顏色(支援 ~1670 萬個物件)
function idToColor(id) {
  return `rgb(${(id >> 16) & 255}, ${(id >> 8) & 255}, ${id & 255})`;
}
function colorToId(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

// hit canvas 用「1:1 邏輯尺寸」(不做 dpr 縮放——命中不需要高解析度,還更省),
// 但要套用「跟主畫布相同的相機」,讓每個形狀落在相同的螢幕位置。
function renderHitCanvas(hitCtx, scene) {
  hitCtx.setTransform(1, 0, 0, 1, 0, 0);
  hitCtx.clearRect(0, 0, W, H);               // 清成透明 → RGB 讀回 0 = 空白(見下方注)
  hitCtx.imageSmoothingEnabled = false;       // 關平滑!否則邊緣混色,ID 算錯
  hitCtx.save();
  applyCamera(hitCtx);                        // ★ 跟主畫布同一個相機,座標才對得上
  scene.forEach((shape, i) => {
    hitCtx.fillStyle = idToColor(i + 1);      // i+1:留 0 當「空白」
    shape.drawShapeOnly(hitCtx);              // 用純色畫同樣形狀(不畫漸層/紋理)
  });
  hitCtx.restore();
}

// 注意:傳入的是「螢幕座標(CSS 像素)」,不是世界座標——
// 因為 hit canvas 已套相機,形狀就畫在螢幕位置上。
function hitTestByColor(hitCtx, cssX, cssY, scene) {
  const [r, g, b] = hitCtx.getImageData(cssX, cssY, 1, 1).data;
  const id = colorToId(r, g, b);
  return id === 0 ? null : scene[id - 1];
}
```

> ⚠️ **兩個一定要對的座標細節(否則 Retina 上必踩,且會跟第 05 章打架)**:
> ① `getImageData` 永遠用**緩衝區的物理像素**座標(第 05 章 5.4 的鐵則),不受 `ctx` 變換影響。本例把 hit canvas 設成 **1:1 邏輯尺寸**(`setTransform(1,…)`、buffer = CSS 尺寸),所以能直接用 CSS 螢幕座標讀;若你比照主畫布也 `scale(dpr)`,就得改成 `getImageData(cssX * dpr, cssY * dpr, …)`。
> ② 讀的是**螢幕座標**而非世界座標——因為 hit canvas 套了同一個相機,形狀已落在螢幕位置。所以這裡只取到「CSS 螢幕座標」那一步(`e.clientX - rect.left`)即可,**不要**再做 7.2 的 `screenToWorld`。

| | 幾何數學(7.3) | 隱藏色彩緩衝(7.6) |
|---|----------------|---------------------|
| 精度 | 形狀的數學邊界 | **像素級精準**(連複雜路徑、文字邊緣都準) |
| 複雜形狀 | 難 | **免費**(畫得出來就命中得到) |
| 速度 | 視物件數 | 命中是 O(1)(只讀一個像素) |
| 成本 | 無額外記憶體 | 多一張全尺寸 canvas + 每次變動要重畫它 |
| 坑 | — | 必須關 `imageSmoothingEnabled`,否則抗鋸齒混色讓 ID 錯亂 |

> **心智模型**:用「顏色」當物件的隱形指紋。你看到的是漂亮的主畫布,背後有一張「身分證畫布」每個物件塗著自己的 ID 色;點哪裡,就看背後那點是誰的顏色。WebGL 也常用這招(叫 GPU picking)。**它把「複雜形狀命中」這個難題,轉化成「讀一個像素」這個簡單操作**——非常優雅。

---

## 7.7 大量物件:空間索引(別每次都 O(n) 掃)

7.5 的命中測定是「遍歷所有物件」,O(n)。畫面上幾十個物件沒問題,但**幾千、幾萬個**時,每次滑鼠移動都掃一遍會卡。

解法:**空間索引**——把空間切成區塊,只檢查「滑鼠所在區塊」的物件。常見兩種:

- **均勻網格(uniform grid)**:把世界切成固定大小的格子,每格記錄哪些物件在裡面。查詢時只看滑鼠那格。實作簡單,物件分布均勻時很好。
- **四叉樹(quadtree)**:遞迴把空間分成四象限,物件密的地方分得細、疏的地方分得粗。適合分布不均的場景。

```
四叉樹:只在物件密集處細分
   ┌─────┬──┬──┐
   │     ├──┼──┤    查詢點 → 只往它落入的象限遞迴
   │     ├──┼──┤    → 從「檢查 10000 個」變成「檢查附近幾個」
   ├─────┴──┴──┤
   │           │
   └───────────┘
```

> **心智模型**:空間索引就像圖書館的分類——你不會把每本書都翻過才找到要的,你直接去那一櫃。**O(n) → O(log n) 或接近 O(1)**。但別過早優化:幾百個物件用 7.5 的線性掃就夠了,**先量測再決定要不要上空間索引**(呼應第 09 章「先測量」)。碰撞偵測(粒子、遊戲)也用同一套結構。

---

## 7.8 完整互動:hover 高亮 + 點擊選取 + 拖曳

把前面串成一個真正能用的互動。我們做：滑過高亮、點擊選取、按住拖曳。

```js
let hovered = null;
let selected = null;
let dragging = null;
let dragOffset = { x: 0, y: 0 };

canvas.addEventListener('pointermove', (e) => {
  const p = eventToWorld(canvas, camera, e);   // 7.2

  if (dragging) {
    // 拖曳中:物件跟著滑鼠移動(用按下時記的偏移,避免跳動)
    dragging.x = p.x - dragOffset.x;
    dragging.y = p.y - dragOffset.y;
    invalidate();                               // 第 06 章 dirty flag
    return;
  }

  // 沒拖曳:更新 hover 狀態 + 換游標
  const hit = hitTest(p, scene);                // 7.5
  if (hit !== hovered) {
    hovered = hit;
    canvas.style.cursor = hit ? 'pointer' : 'default';
    invalidate();
  }
});

canvas.addEventListener('pointerdown', (e) => {
  const p = eventToWorld(canvas, camera, e);
  const hit = hitTest(p, scene);
  selected = hit;
  if (hit) {
    dragging = hit;
    dragOffset = { x: p.x - hit.x, y: p.y - hit.y };   // 記住「抓在物件的哪裡」
    canvas.setPointerCapture(e.pointerId);             // 拖出畫布也持續收事件
  }
  invalidate();
});

canvas.addEventListener('pointerup', (e) => {
  dragging = null;
  canvas.releasePointerCapture(e.pointerId);
});

// render 時根據 hovered/selected 畫高亮、選取框
function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.save(); applyCamera(ctx, camera);
  for (const shape of scene) {
    shape.draw(ctx);
    if (shape === hovered) shape.drawHighlight(ctx);
    if (shape === selected) shape.drawSelectionBox(ctx);
  }
  ctx.restore();
}
```

幾個讓互動「專業」的細節:

- **`dragOffset`**:記住「按下時抓在物件的哪個相對位置」,拖曳時用它,物件才不會「跳」到滑鼠正中心。
- **`setPointerCapture`**:即使滑鼠拖出畫布外,也能持續收到 `pointermove`,拖曳不中斷。
- **`pointer` 事件**(而非 `mouse`):同時支援滑鼠、觸控、觸控筆,一套搞定。
- **游標樣式**:hover 到可拖物件時 `cursor: pointer`,給使用者明確回饋。
- **配合 dirty flag**:只在狀態變化時 `invalidate()`,靜止不重畫(第 06 章)。

---

## 7.9 效能細節:事件節流

`pointermove` 觸發**非常密集**(高刷新滑鼠每秒上百次)。如果每次都做重命中 + 重繪,會卡。標準做法:**把繪製交給 rAF,事件只更新狀態**:

```js
let pendingPoint = null;
canvas.addEventListener('pointermove', (e) => {
  pendingPoint = eventToWorld(canvas, camera, e);   // 事件只記座標,不立刻處理
});

function frame() {
  if (pendingPoint) {
    handleHover(pendingPoint);   // 一幀最多處理一次,多餘的事件被「合併」
    pendingPoint = null;
  }
  if (dirty) { render(); dirty = false; }
  requestAnimationFrame(frame);
}
```

> **心智模型**:事件來得比螢幕刷新還快是浪費——一幀內來 5 個 `pointermove`,你只需要最後一個。「**事件更新狀態、rAF 負責畫**」是把高頻事件跟渲染解耦的通用模式,呼應第 06 章 update/render 分離。

---

## 7.10 本章小結與下一步

- **核心**:Canvas 沒有 per-shape 事件,「點到誰」要自己算——這是 immediate mode 最大的洞,也是本章在補的。
- **必經第一步**:事件座標 → 世界座標(`getBoundingClientRect` + 相機逆變換),做錯則全盤皆錯。
- **幾何數學命中**:矩形/圓/多邊形(射線法)/線段距離;快、精確、無記憶體;比平方省開根號。
- **`isPointInPath` + `Path2D`**:不規則形狀的內建解,把路徑存成 `Path2D` 重用。
- **多物件**:反向遍歷取最上層(由上往下找)。
- **隱藏色彩緩衝**:用顏色當 ID,把「複雜形狀命中」變成「讀一個像素」,像素級精準、O(1)——記得關平滑。
- **空間索引**:大量物件用網格/四叉樹避免 O(n);但先測量再優化。
- **完整互動**:hover/選取/拖曳要有 `dragOffset`、`setPointerCapture`、pointer 事件、dirty flag、事件節流。

**下一章(08)**,我們把目前散落的物件資料,正式組織成一個 **場景圖(scene graph)**——也就是在 immediate mode 之上,親手蓋出一層 retained mode。你會發現自己重建了 Konva / Fabric 這類庫的核心,並因此解鎖三個 immediate mode 一直缺的能力:**階層/群組、Undo/Redo(兌現第 02 章伏筆)、以及序列化存檔**。引擎即將成形。

> 💡 **動手作業**:把第 06 章的粒子作業改成「**可點選的圖形編輯器雛形**」:畫面上散佈 20 個不同顏色的圓,實作 hover 變亮、點擊選取(選中畫外框)、拖曳移動。挑戰題:再用 7.6 的隱藏色彩緩衝重做一次命中測定,對比兩種做法的程式碼複雜度與手感。
