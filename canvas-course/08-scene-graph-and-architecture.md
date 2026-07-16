# 第 08 章:場景圖與架構——在 immediate mode 上蓋一層 retained

> **學習目標**:把散落的繪圖程式碼,正式組織成**場景圖(scene graph)**——也就是在 immediate mode 之上親手蓋出一層 retained mode。你會重建 Konva/Fabric 的核心,並解鎖三個 immediate mode 一直缺的能力:**階層/群組、Undo/Redo(兌現第 02 章伏筆)、序列化存檔**。
> **預計時數**:130 分鐘
> 第 00 章我們說「用 Canvas 就是親手造一台渲染引擎」。這一章,引擎正式成形——這是整門課的架構樞紐,前七章的零件在這裡組裝成系統。

---

## 8.1 痛點盤點:命令式繪圖撐不住複雜應用

到目前為止,我們的繪圖大多是「一條一條命令散著寫」:

```js
function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'red';   ctx.fillRect(10, 10, 50, 50);   // fillRect(x, y, 寬, 高) → 在 (10,10) 畫 50×50 方塊
  ctx.fillStyle = 'blue';  ctx.beginPath(); ctx.arc(200, 100, 30, 0, 7); ctx.fill();   // arc(圓心x, 圓心y, 半徑, 起始角, 結束角);7≈2π 表整圓
  // ... 物件一多,這裡變成幾百行無法維護的繪圖指令
}
```

問題全是 immediate mode 的後遺症:**沒有「物件」的概念,所以無法「個別管理」**——你不能問「第 3 個圖形在哪」、不能「只移動那個圓」、不能「刪掉它」、不能「存檔」。命中測定(第 07 章)也得另外維護一份物件資料才能做。

**這些痛苦的根源是同一個:資料(有哪些圖形)和繪圖(怎麼畫)混在一起了。** 解法就是把它們分開。

---

## 8.2 核心動作:把「畫面上的東西」變成物件陣列

場景圖的核心思想極簡單:**用一個陣列存「所有圖形物件」,每個物件知道怎麼畫自己、怎麼判斷命中**。render 變成「遍歷陣列,叫每個物件畫自己」。

```js
// ── 基底類別:所有圖形的共同介面 ──
class Shape {
  constructor(props) {
    Object.assign(this, { x: 0, y: 0, rotation: 0, ...props });
  }
  draw(ctx) {}                    // 子類實作:怎麼畫自己
  containsPoint(p) { return false; }  // 子類實作:命中測定(第 07 章)
  getBounds() {}                  // 子類實作:回傳包圍盒(選取框、髒區用)
}

// ── 具體圖形 ──
class RectShape extends Shape {
  constructor(props) { super({ w: 100, h: 60, fill: '#888', ...props }); }
  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);    // 第 03 章:以自己為原點畫
    ctx.rotate(this.rotation);
    ctx.fillStyle = this.fill;
    ctx.fillRect(-this.w / 2, -this.h / 2, this.w, this.h);
    ctx.restore();                    // 第 02 章紀律:自掃門前雪
  }
  containsPoint(p) {                  // 第 07 章:轉回本地座標再判斷(支援旋轉)
    const local = rotatePoint(p.x - this.x, p.y - this.y, -this.rotation);
    return Math.abs(local.x) <= this.w/2 && Math.abs(local.y) <= this.h/2;
  }
}

class CircleShape extends Shape {
  constructor(props) { super({ r: 40, fill: '#888', ...props }); }
  draw(ctx) {
    ctx.save();
    ctx.fillStyle = this.fill;
    ctx.beginPath();                  // 開一條新路徑(清掉上一條),再用 arc 描出圓、fill() 填滿
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  containsPoint(p) {
    const dx = p.x - this.x, dy = p.y - this.y;
    return dx*dx + dy*dy <= this.r*this.r;
  }
}
```

```js
// ── 場景:就是一個物件陣列 ──
const scene = [
  new RectShape({ x: 100, y: 100, fill: '#e63946' }),
  new CircleShape({ x: 300, y: 150, fill: '#457b9d' }),
];

// ── render 變成:遍歷,叫每個物件畫自己 ──
function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.save(); applyCamera(ctx, camera);   // 第 03 章相機
  for (const shape of scene) shape.draw(ctx);
  ctx.restore();
}
```

> **心智模型**:你剛剛做的事,就是**在 immediate mode 上重新發明 retained mode**。`scene` 陣列 = 瀏覽器幫 DOM 維護的那棵樹;`shape.draw()` = 瀏覽器的繪製引擎;第 07 章的 `containsPoint` = 瀏覽器的命中測定。**Konva、Fabric.js、PixiJS 的本質,就是這個 `Shape` 類別 + `scene` 陣列做到極致。** 你現在看得懂它們的原始碼了。

---

## 8.3 資料與渲染分離:這才是真正的解鎖

8.2 最重要的不是「程式碼變整潔」,而是一個架構轉變:**現在「場景」是純資料,「渲染」是把資料畫出來的函式。** 一旦資料和渲染分離,一連串原本不可能的能力突然全部變得可能:

```
        場景資料(scene = [...])  ← 唯一的真相來源(single source of truth)
              │
   ┌──────────┼──────────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼          ▼
 render()  命中測定    Undo/Redo   序列化      協作同步
 畫出來    (第07章)   (8.6)      存檔(8.7)   (傳資料)
```

> **心智模型**:這正是第 06 章 update/render 分離的放大版,也是 React「UI = f(state)」的同一個哲學——**畫面只是資料的投影**。你改資料、重新投影,而不是直接戳畫面。掌握這個,你寫的就不只是「Canvas 程式」,而是「有架構的應用」。

---

## 8.4 階層與群組:節點樹與相對變換

真實編輯器需要「**群組**」——把幾個圖形組起來,一起移動、旋轉、縮放(像 Figma 的 group)。這要把扁平陣列升級成**樹**:每個節點有 `children`,且子節點的座標是**相對父節點**的。

```js
class Node {
  constructor(props) {
    Object.assign(this, { x: 0, y: 0, rotation: 0, scale: 1, ...props });
    this.children = [];
  }
  add(child) { this.children.push(child); child.parent = this; }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);     // 套用「自己相對父層」的變換
    ctx.rotate(this.rotation);
    ctx.scale(this.scale, this.scale);
    this.drawSelf(ctx);                // 畫自己
    for (const child of this.children) child.draw(ctx);  // 遞迴畫子節點
    ctx.restore();                     // 還原 → 變換不洩漏給兄弟節點
  }
  drawSelf(ctx) {}
}
```

關鍵在於變換的**累積**(第 03 章):父節點 `translate` 後,子節點在它的基礎上再 `translate`,所以**移動父節點,所有子節點自動跟著動**——而你完全不用改子節點的座標。

> **心智模型**:這就是 DOM 的「子元素座標相對父元素」、SVG 的 `<g>` 群組、遊戲引擎的「場景樹」——全部都是「**節點樹 + 相對變換,遞迴繪製,用 save/restore 隔離每層**」。第 03 章學的變換累積,在這裡開花結果:階層變換就是一路 `save → 套用本層變換 → 畫 → 遞迴子節點 → restore`。

---

## 8.5 z-order:誰蓋在誰上面

物件的「上下層級」由**繪製順序**決定(後畫的蓋在上面,第 07 章提過)。在場景圖裡,z-order 就是陣列順序 / `children` 順序。常見操作:

```js
function bringToFront(scene, shape) {
  const i = scene.indexOf(shape);
  scene.splice(i, 1);       // 從原位置移除
  scene.push(shape);        // 放到陣列尾端 = 最後畫 = 最上層
}
function sendToBack(scene, shape) {
  const i = scene.indexOf(shape);
  scene.splice(i, 1);
  scene.unshift(shape);     // 放到開頭 = 最先畫 = 最底層
}
```

> 命中測定要記得跟 z-order 一致:**畫由下往上(正向遍歷),命中由上往下(反向遍歷)**(第 07.5 章)。兩者用同一個 `scene` 陣列,順序天然對齊。

---

## 8.6 髒矩形:只重畫變動的區域

到目前我們每幀都「清空 + 全部重畫」。物件不多時沒問題,但複雜場景中,**移動一個小圖形卻重畫整個畫面**很浪費。優化叫**髒矩形(dirty rectangle)**:只清除並重畫「有變動的那塊區域」。

```js
function renderDirty(ctx, scene, dirtyRect) {
  ctx.save();
  // 只清除髒區域
  ctx.clearRect(dirtyRect.x, dirtyRect.y, dirtyRect.w, dirtyRect.h);
  // 把裁切設成髒區域:之後的繪圖只會落在這塊(第 02 章 clip)
  ctx.beginPath();
  ctx.rect(dirtyRect.x, dirtyRect.y, dirtyRect.w, dirtyRect.h);
  ctx.clip();
  // 只重畫「包圍盒跟髒區域相交」的物件
  for (const shape of scene) {
    if (intersects(shape.getBounds(), dirtyRect)) shape.draw(ctx);
  }
  ctx.restore();
}
```

當一個物件移動,髒區域 = 「**它移動前的包圍盒 ∪ 移動後的包圍盒**」(要把舊位置擦掉、新位置畫上)。

> 這裡假設每個 `Shape` 都實作了 `getBounds()`(回傳**世界座標的包圍盒** `{x,y,w,h}`)——8.2 的基底 `Shape` 只留了空的 `getBounds()`,實務上每種形狀要各自 override(矩形回傳自身範圍、圓形回傳 `{x-r, y-r, 2r, 2r}`)。第 11 章 capstone 有完整實作。

> **務實提醒**:髒矩形邏輯不好寫對(重疊、半透明、陰影都會讓「受影響區域」變大),容易出殘影 bug。**實務上,更常用、更簡單的優化是「分層 canvas」**(把靜態背景和動態前景拆成不同 canvas,只重畫動的那層)——這留到第 09 章。本節讓你理解原理即可:**重繪成本 ∝ 重畫面積,縮小重畫面積就是優化**。

---

## 8.7 Undo / Redo:兌現第 02 章的伏筆

第 02 章我們說「`restore()` 不是 Undo,Canvas 沒有內建撤銷」。現在資料和渲染分離了,**Undo/Redo 變得理所當然**——因為要撤銷的是「資料的改變」,不是「畫布的像素」。兩種主流做法:

### 做法 A:快照(snapshot)——簡單暴力

每次操作後,把整個場景**深拷貝**存進歷史堆疊。Undo 就是還原上一個快照。

```js
// 先把場景轉成「純資料」,快照才能安全拷貝(這個函式 8.8 序列化會細講)
function serialize(scene) {
  return scene.map(s => ({
    type: s.constructor.name,   // 'RectShape' / 'CircleShape'
    x: s.x, y: s.y, rotation: s.rotation,
    ...(s.w !== undefined ? { w: s.w, h: s.h } : { r: s.r }),
    fill: s.fill,
  }));
}

class History {
  constructor() { this.past = []; this.future = []; }
  commit(scene) {
    this.past.push(structuredClone(serialize(scene)));   // 存當前狀態的拷貝(先轉純資料,深拷貝才有效)
    this.future = [];                                    // 新操作清空 redo
  }
  undo(applyState) {
    if (this.past.length < 2) return;
    this.future.push(this.past.pop());                   // 當前狀態移到 future
    applyState(this.past[this.past.length - 1]);         // 還原到上一個
  }
  redo(applyState) {
    if (!this.future.length) return;
    const state = this.future.pop();
    this.past.push(state);
    applyState(state);
  }
}
```

- 優點:超好實作、絕對正確。
- 缺點:場景大時每次存整份很吃記憶體(可用「只存差異」或限制歷史長度緩解)。

### 做法 B:命令模式(Command Pattern)——專業做法

把每個操作封裝成一個「命令」物件,自己知道怎麼 `do` 和 `undo`:

```js
class MoveCommand {
  constructor(shape, dx, dy) { this.shape = shape; this.dx = dx; this.dy = dy; }
  do()   { this.shape.x += this.dx; this.shape.y += this.dy; }
  undo() { this.shape.x -= this.dx; this.shape.y -= this.dy; }
}
// 歷史堆疊存的是「命令」,undo 就呼叫命令的 undo()
```

- 優點:記憶體省(只存操作的差異)、語意清晰、可做「合併連續操作」。
- 缺點:每種操作要寫一個命令類別。

> **心智模型**:Undo/Redo 的本質是「**狀態的時間旅行**」——而時間旅行的前提是「狀態是資料、可被保存/還原」。這正是 8.3 資料/渲染分離帶來的紅利。小專案用快照、大專案用命令模式。第 11 章白板會實作一個。

---

## 8.8 序列化:存檔、載入、複製貼上

同樣因為「場景是純資料」,把它存成 JSON 就能存檔/載入/分享/複製貼上:

```js
function serialize(scene) {
  return scene.map(s => ({
    type: s.constructor.name,   // 'RectShape' / 'CircleShape'
    x: s.x, y: s.y, rotation: s.rotation,
    ...(s.w !== undefined ? { w: s.w, h: s.h } : { r: s.r }),
    fill: s.fill,
  }));
}

function deserialize(data) {
  const registry = { RectShape, CircleShape };   // 型別名 → 類別
  return data.map(d => new registry[d.type](d));
}

// 存檔
localStorage.setItem('myCanvas', JSON.stringify(serialize(scene)));
// 載入
const scene = deserialize(JSON.parse(localStorage.getItem('myCanvas')));
```

> ⚠️ **序列化要存「資料」,不要存「函式/類別實例」**。`JSON.stringify` 一個含方法的物件,方法會丟失。標準做法是存「純資料 + 型別標記」,載入時用一個「型別註冊表(registry)」重建實例。這也是為什麼資料和行為要分離。協作編輯(多人即時)傳的也是這份資料(或它的差異),不是像素。

---

## 8.9 整合:場景圖如何串起全課

到這裡,前七章的零件全部組裝起來了。一張表看清楚:

| 場景圖的部分 | 用到哪一章 |
|--------------|------------|
| `shape.draw(ctx)` 內的繪圖 | 02(狀態機/路徑)、04(文字圖片) |
| `save/restore` 隔離每個物件 | 02 |
| 節點的 `translate/rotate/scale`、相機 | 03 |
| `containsPoint` 命中測定、hover/拖曳 | 07 |
| render loop、dirty flag、delta-time 動畫 | 01、06 |
| 髒矩形、分層 | 08、09 |
| Undo/Redo、序列化 | 08 |

> **心智模型**:場景圖是這門課的「主機板」,前面每一章是插在上面的元件。**它把「一堆繪圖命令」升級成「一個有資料模型、可互動、可存取、可回溯的應用」**——這就是 Canvas 從玩具到產品的分界線。

---

## 8.10 本章小結與下一步

- **核心動作**:用物件陣列存圖形,每個物件會 `draw`/`containsPoint`/`getBounds`;render = 遍歷叫大家畫自己。你親手重建了 retained mode(就是 Konva/Fabric 的本質)。
- **資料/渲染分離**:場景是純資料、唯一真相來源;畫面只是它的投影(同 React 哲學)。這個分離解鎖了後面全部能力。
- **階層/群組**:節點樹 + 相對變換,遞迴繪製、`save/restore` 隔離每層;移動父節點,子節點自動跟動。
- **z-order**:繪製順序即層級;命中反向、繪製正向,共用同一陣列。
- **髒矩形**:重繪成本正比於面積;原理重要,但實務常用分層 canvas 取代(第 09 章)。
- **Undo/Redo**:狀態的時間旅行——快照(簡單)或命令模式(專業),兌現第 02 章伏筆。
- **序列化**:存純資料 + 型別標記,用註冊表重建;存檔、載入、協作都靠它。

**下一章(09)**,場景圖建好了,但「複雜場景每幀全畫」會卡。我們進入**效能工程**:先學會用 DevTools 測量(別瞎猜),再上最實用的優化——**分層 canvas**、離屏快取、減少狀態切換、按需渲染,以及把繪圖搬到背景執行緒的 **OffscreenCanvas + Web Worker**。最後談「什麼時候撞到 Canvas 2D 的天花板,該上 GPU」。

> 💡 **動手作業**:把第 07 章的圖形編輯器升級成「**有場景圖的版本**」:定義 `Shape` 基類與 `RectShape`/`CircleShape`/`TextShape` 子類,實作新增、選取、拖曳、刪除(Delete 鍵),並加上**快照式 Undo/Redo**(Ctrl+Z / Ctrl+Shift+Z)與 **localStorage 存檔/載入**。完成後你已經擁有 mini-Figma 的骨架——第 11 章 Capstone 就是把它做完整。

### 動手作業參考實作

先自己動手做,卡住或想對答案時再看(這份就是第 11 章 Capstone 的迷你前身):

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>第 08 章作業:有場景圖的圖形編輯器</title>
<style>
  body { font-family: sans-serif; }
  #toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  canvas { border: 1px solid #ccc; }
</style></head>
<body>
  <!-- UI 用真 DOM button,不畫進 canvas(第 00 章:Canvas 不是用來取代 DOM) -->
  <div id="toolbar">
    <button id="add-rect">+ 矩形</button>
    <button id="add-circle">+ 圓形</button>
    <button id="add-text">+ 文字</button>
    <button id="save">存檔</button>
    <button id="load">載入</button>
    <span>點擊選取 / 拖曳移動 / Delete 刪除 / Ctrl+Z 復原 / Ctrl+Shift+Z 重做</span>
  </div>
  <canvas id="stage"></canvas>
  <script>
    const canvas = document.querySelector('#stage');

    // ---- HiDPI 設定(第 01 章):緩衝區 ×DPR,CSS 維持邏輯尺寸,再 scale ----
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
    const W = 800, H = 450;
    const ctx = setupHiDPICanvas(canvas, W, H);

    // ---- Shape 基類(8.2):每個圖形自己知道怎麼畫、怎麼判斷命中、怎麼變成純資料 ----
    class Shape {
      constructor(props) {
        Object.assign(this, { x: 0, y: 0, fill: '#888', ...props });
      }
      draw(ctx) {}                        // 子類實作:怎麼畫自己
      containsPoint(p) { return false; }  // 子類實作:命中測定(第 07 章)
      getBounds() { return { x: this.x, y: this.y, w: 0, h: 0 }; }  // 子類實作:包圍盒(畫選取框用)
      toJSON() {                          // 序列化白名單:只存純資料 + 型別標記,不存方法(8.8)
        return { type: this.constructor.name, x: this.x, y: this.y, fill: this.fill };
      }
    }

    class RectShape extends Shape {
      constructor(props) { super({ w: 120, h: 70, ...props }); }
      draw(ctx) {
        ctx.fillStyle = this.fill;
        ctx.fillRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);  // 以 (x,y) 為中心
      }
      containsPoint(p) {
        return Math.abs(p.x - this.x) <= this.w / 2 && Math.abs(p.y - this.y) <= this.h / 2;
      }
      getBounds() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
      toJSON() { return { ...super.toJSON(), w: this.w, h: this.h }; }
    }

    class CircleShape extends Shape {
      constructor(props) { super({ r: 45, ...props }); }
      draw(ctx) {
        ctx.fillStyle = this.fill;
        ctx.beginPath();                  // 開新路徑,免得和上一個圖形連在一起(第 02 章)
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fill();
      }
      containsPoint(p) {
        const dx = p.x - this.x, dy = p.y - this.y;
        return dx * dx + dy * dy <= this.r * this.r;   // 平方比較,免開根號(第 07 章)
      }
      getBounds() { return { x: this.x - this.r, y: this.y - this.r, w: this.r * 2, h: this.r * 2 }; }
      toJSON() { return { ...super.toJSON(), r: this.r }; }
    }

    class TextShape extends Shape {
      constructor(props) { super({ text: '你好 Canvas', size: 28, ...props }); }
      draw(ctx) {
        ctx.fillStyle = this.fill;
        ctx.font = this.size + 'px sans-serif';
        ctx.textAlign = 'center';         // (x,y) = 文字中心,最不會算錯(第 04 章)
        ctx.textBaseline = 'middle';
        ctx.fillText(this.text, this.x, this.y);
      }
      measureWidth() {
        ctx.font = this.size + 'px sans-serif';   // 量測前先設同一個字型,量出來才準(第 04 章)
        return ctx.measureText(this.text).width;
      }
      containsPoint(p) {                  // 文字的命中:用量出來的包圍盒近似
        return Math.abs(p.x - this.x) <= this.measureWidth() / 2 && Math.abs(p.y - this.y) <= this.size / 2;
      }
      getBounds() {
        const w = this.measureWidth();
        return { x: this.x - w / 2, y: this.y - this.size / 2, w: w, h: this.size };
      }
      toJSON() { return { ...super.toJSON(), text: this.text, size: this.size }; }
    }

    // ---- 序列化(8.8):場景 → 純資料;載入時用型別註冊表重建實例 ----
    const SHAPE_REGISTRY = { RectShape, CircleShape, TextShape };       // 型別名 → 類別
    function serialize(scene) { return scene.map(s => s.toJSON()); }    // 每次都回傳全新純資料,天然就是深拷貝
    function deserialize(data) { return data.map(d => new SHAPE_REGISTRY[d.type](d)); }

    // ---- 快照式 Undo/Redo(8.7 做法 A):歷史堆疊存整份場景的純資料快照 ----
    class History {
      constructor() { this.past = []; this.future = []; }
      commit(scene) {
        this.past.push(serialize(scene));   // 每次操作後存一份快照
        this.future = [];                   // 有新操作就清空 redo
      }
      undo(applyState) {
        if (this.past.length < 2) return;             // past[0] 是初始狀態,守住不彈出
        this.future.push(this.past.pop());            // 當前狀態移進 future
        applyState(this.past[this.past.length - 1]);  // 還原到上一個快照
      }
      redo(applyState) {
        if (!this.future.length) return;
        const state = this.future.pop();
        this.past.push(state);
        applyState(state);
      }
    }

    // ---- 編輯器狀態:場景陣列是唯一真相來源,畫面只是它的投影(8.3) ----
    let scene = [];
    let selected = null;
    let dragging = null;
    let dragOffset = { x: 0, y: 0 };   // 記住「抓在物件的哪裡」,物件才不會跳到滑鼠正中心(第 07 章)
    let dragMoved = false;
    const history = new History();
    history.commit(scene);             // 先存一份初始空場景,第一次「新增」才撤銷得掉

    function applyState(data) {
      scene = deserialize(data);       // undo/redo = 把快照重建回實例,再重新投影
      selected = null;                 // 實例全換新了,舊的選取一併清掉
      invalidate();
    }

    // ---- 渲染:遍歷場景,叫每個物件畫自己(8.2);dirty flag 按需重畫(第 06 章) ----
    let dirty = true;
    function invalidate() { dirty = true; }

    function render() {
      ctx.clearRect(0, 0, W, H);
      for (const shape of scene) shape.draw(ctx);   // 正向遍歷:後畫的蓋在上面(8.5)
      if (selected) {
        const b = selected.getBounds();             // 選中的物件外面畫一圈選取框
        ctx.strokeStyle = '#1d7fe0';
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
      }
    }
    function frame() {
      if (dirty) { render(); dirty = false; }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // ---- 命中測定與拖曳(第 07 章) ----
    function hitTest(p) {
      for (let i = scene.length - 1; i >= 0; i--) {   // 反向遍歷:最上層(最後畫的)先命中
        if (scene[i].containsPoint(p)) return scene[i];
      }
      return null;
    }
    function getPointerPos(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    canvas.addEventListener('pointerdown', (e) => {
      const p = getPointerPos(e);
      selected = hitTest(p);            // 點擊選取:點到空白處 = 取消選取
      if (selected) {
        dragging = selected;
        dragMoved = false;
        dragOffset = { x: p.x - selected.x, y: p.y - selected.y };
        canvas.setPointerCapture(e.pointerId);   // 拖出畫布外也持續收事件
      }
      invalidate();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = getPointerPos(e);
      dragging.x = p.x - dragOffset.x;  // 拖曳 = 改資料,render 自然跟上
      dragging.y = p.y - dragOffset.y;
      dragMoved = true;
      invalidate();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (dragging && dragMoved) history.commit(scene);   // 拖曳結束才存快照,不是每個 move 都存
      dragging = null;
      canvas.releasePointerCapture(e.pointerId);
    });

    // ---- 鍵盤:Delete 刪除 / Ctrl+Z 復原 / Ctrl+Shift+Z 重做 ----
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {   // Mac 的 delete 鍵送出的是 Backspace
        scene.splice(scene.indexOf(selected), 1);   // 刪除 = 從場景陣列移除,再重新投影
        selected = null;
        history.commit(scene);
        invalidate();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {     // metaKey:順便支援 Mac 的 Cmd
        e.preventDefault();                         // 攔下瀏覽器自己的 undo
        if (e.shiftKey) history.redo(applyState);   // Ctrl+Shift+Z:重做
        else history.undo(applyState);              // Ctrl+Z:復原
      }
    });

    // ---- 工具列:新增圖形(用真 DOM button,Canvas 內不用自己畫 UI) ----
    const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#9b5de5'];
    function addShape(ShapeClass) {
      const shape = new ShapeClass({
        x: 80 + Math.random() * (W - 160),   // 隨機落點,連按新增才不會全疊在同一處
        y: 80 + Math.random() * (H - 160),
        fill: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
      scene.push(shape);      // 新增 = 推到陣列尾端 = 最後畫 = 最上層(8.5)
      selected = shape;
      history.commit(scene);  // 關鍵:「新增」也 commit,Ctrl+Z 才撤銷得掉新增
      invalidate();
    }
    document.querySelector('#add-rect').addEventListener('click', () => addShape(RectShape));
    document.querySelector('#add-circle').addEventListener('click', () => addShape(CircleShape));
    document.querySelector('#add-text').addEventListener('click', () => addShape(TextShape));

    // ---- localStorage 存檔/載入(8.8):存的是純資料 JSON,不是像素 ----
    const STORAGE_KEY = 'ch08-scene';
    document.querySelector('#save').addEventListener('click', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(scene)));
    });
    document.querySelector('#load').addEventListener('click', () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      scene = deserialize(JSON.parse(raw));   // JSON → 純資料 → 用 SHAPE_REGISTRY 重建實例
      selected = null;
      history.commit(scene);                  // 載入也算一次操作,同樣進歷史、可 undo
      invalidate();
    });
  </script>
</body>
</html>
```
