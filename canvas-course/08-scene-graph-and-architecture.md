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
// ── 小工具:把點 (x,y) 繞原點旋轉 angle 弧度(第 03 章旋轉公式:x'=cosθ·x−sinθ·y, y'=sinθ·x+cosθ·y)──
function rotatePoint(x, y, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

// ── 基底類別:所有圖形的共同介面 ──
class Shape {
  constructor(props) {
    Object.assign(this, { x: 0, y: 0, rotation: 0, ...props });
  }
  draw(ctx) {}                    // 子類實作:怎麼畫自己
  containsPoint(p) { return false; }  // 子類實作:命中測定(第 07 章)
  getBounds() {}                  // 子類實作:回傳世界座標的包圍盒 {x,y,w,h}(選取框、髒區用)
}

// ── 具體圖形 ──
class RectShape extends Shape {
  static type = 'rect';               // 型別標記(序列化用,見 8.8)
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
  getBounds() {                       // 旋轉後的 AABB:把半寬、半高投影到 x、y 軸(rotation=0 時就是 w×h)
    const c = Math.abs(Math.cos(this.rotation)), s = Math.abs(Math.sin(this.rotation));
    const hw = (this.w * c + this.h * s) / 2, hh = (this.w * s + this.h * c) / 2;
    return { x: this.x - hw, y: this.y - hh, w: hw * 2, h: hh * 2 };
  }
}

class CircleShape extends Shape {
  static type = 'circle';
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
  getBounds() { return { x: this.x - this.r, y: this.y - this.r, w: this.r * 2, h: this.r * 2 }; }
}
```

```js
// ── 場景:就是一個物件陣列(用 let:8.8 載入存檔時會整個換掉) ──
let scene = [
  new RectShape({ x: 100, y: 100, fill: '#e63946' }),
  new CircleShape({ x: 300, y: 150, fill: '#457b9d' }),
];

// ── 相機(第 03 章):畫所有物件之前,先套用的一個變換 ──
const camera = { x: 0, y: 0, zoom: 1 };
function applyCamera(ctx, camera) {
  ctx.scale(camera.zoom, camera.zoom);   // 先縮放
  ctx.translate(-camera.x, -camera.y);   // 再平移(相機往右看 = 世界往左移)
}

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

### 階層裡的命中:世界矩陣

繪製時 ctx 幫你一層層累積變換;命中測定時沒有 ctx,得自己算出節點的**世界矩陣**(本地座標 → 世界座標)= **父的世界矩陣 × 自己的本地矩陣**,再用逆矩陣把滑鼠座標轉回本地(第 03 章 3.6)。在 `Node` 裡再加兩個方法:

```js
class Node {
  // ...上面的 constructor / add / draw...
  getWorldMatrix() {
    const local = new DOMMatrix()            // 本地矩陣:跟 draw() 一樣 translate → rotate → scale
      .translateSelf(this.x, this.y)
      .rotateSelf(this.rotation * 180 / Math.PI)   // DOMMatrix 的 rotate 吃「度」
      .scaleSelf(this.scale, this.scale);
    return this.parent ? this.parent.getWorldMatrix().multiply(local) : local;   // 父 × 本地(反過來乘就錯)
  }
  hitTest(p) {                               // 命中順序 = 繪製順序反過來
    for (let i = this.children.length - 1; i >= 0; i--) {   // 子節點畫在自己之上 → 先反向測子節點
      const hit = this.children[i].hitTest(p);
      if (hit) return hit;
    }
    const q = this.getWorldMatrix().inverse().transformPoint(new DOMPoint(p.x, p.y));   // 世界 → 本地
    return this.containsLocal(q) ? this : null;   // containsLocal:子類用本地座標判斷,例如 |x| ≤ w/2
  }
  containsLocal(q) { return false; }
}
```

節點一多,每次從根乘下來太浪費:實務上把世界矩陣**快取**起來,節點的變換一改,就遞迴把自己和所有子孫標成 dirty,下次用到才重算。有了快取,繪製也能改用 `ctx.setTransform(...)` 一次設好(記得先乘上 dpr),不必層層 save/restore;群組的包圍盒 = 子節點的四個角經世界矩陣轉換後取聯集。

---

## 8.5 z-order:誰蓋在誰上面

物件的「上下層級」由**繪製順序**決定(後畫的蓋在上面,第 07 章提過)。在場景圖裡,z-order 就是陣列順序 / `children` 順序。常見操作:

```js
function bringToFront(scene, shape) {
  const i = scene.indexOf(shape);
  if (i < 0) return;        // 不在這個陣列裡:splice(-1, 1) 會誤刪最後一個元素
  scene.splice(i, 1);       // 從原位置移除
  scene.push(shape);        // 放到陣列尾端 = 最後畫 = 最上層
}
function sendToBack(scene, shape) {
  const i = scene.indexOf(shape);
  if (i < 0) return;
  scene.splice(i, 1);
  scene.unshift(shape);     // 放到開頭 = 最先畫 = 最底層
}
```

> 命中測定要記得跟 z-order 一致:**畫由下往上(正向遍歷),命中由上往下(反向遍歷)**(第 07 章 7.5 節)。兩者用同一個 `scene` 陣列,順序天然對齊。在 8.4 的樹裡,z-order 只在同一層兄弟之間有意義:調整子節點的層級要操作 `shape.parent.children`。

---

## 8.6 髒矩形:只重畫變動的區域

到目前我們每幀都「清空 + 全部重畫」。物件不多時沒問題,但複雜場景中,**移動一個小圖形卻重畫整個畫面**很浪費。優化叫**髒矩形(dirty rectangle)**:只清除並重畫「有變動的那塊區域」。

```js
// 兩個包圍盒 {x,y,w,h} 有沒有重疊(標準 AABB 矩形相交測試,第 07 章)
function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// 世界座標的髒區 → 螢幕座標(CSS 像素),外擴到「裝置像素」的整數格,再多留 1px 給抗鋸齒
function snapToScreen(r, camera, dpr) {
  const x0 = Math.floor((r.x - camera.x) * camera.zoom * dpr) - 1;
  const y0 = Math.floor((r.y - camera.y) * camera.zoom * dpr) - 1;
  const x1 = Math.ceil((r.x + r.w - camera.x) * camera.zoom * dpr) + 1;
  const y1 = Math.ceil((r.y + r.h - camera.y) * camera.zoom * dpr) + 1;
  return { x: x0 / dpr, y: y0 / dpr, w: (x1 - x0) / dpr, h: (y1 - y0) / dpr };
}

function renderDirty(ctx, scene, dirtyRect) {               // dirtyRect:世界座標
  const s = snapToScreen(dirtyRect, camera, window.devicePixelRatio || 1);
  const area = { x: s.x / camera.zoom + camera.x, y: s.y / camera.zoom + camera.y,
                 w: s.w / camera.zoom, h: s.h / camera.zoom };   // 實際清掉的範圍,換回世界座標
  ctx.save();
  ctx.clearRect(s.x, s.y, s.w, s.h);       // 只清除髒區域(此時 ctx 只有 dpr 縮放,單位是 CSS 像素)
  // 把裁切設成髒區域:之後的繪圖只會落在這塊(第 02 章 clip)
  ctx.beginPath();
  ctx.rect(s.x, s.y, s.w, s.h);
  ctx.clip();
  applyCamera(ctx, camera);                // 跟 render() 一樣套相機,物件才畫在對的位置
  // 只重畫「包圍盒跟清除範圍相交」的物件:用 area 而非 dirtyRect,外擴那圈裡的鄰居也被清掉了
  for (const shape of scene) {
    if (intersects(shape.getBounds(), area)) shape.draw(ctx);
  }
  ctx.restore();
}
```

三個漏掉任何一個就會畫錯或留殘影的細節:

- **對齊像素**:髒區邊緣落在小數座標時,`clearRect` 和 `clip` 都會做抗鋸齒,邊緣像素只被「擦掉一部分」,一幀幀累積成拖尾。所以要外擴到裝置像素的整數格,再多留 1px。
- **換算相機**:`getBounds()` 是世界座標,清除和裁切卻發生在螢幕上,中間要套 8.2 的相機。
- **包圍盒要包全**:旋轉過的矩形要用 8.2 `RectShape.getBounds()` 的投影公式——150×52、旋轉 0.3 rad 的矩形,真正的包圍盒是 158.7×94,直接回傳 w×h 會上下各漏掉約 21px。有描邊再外擴 `lineWidth / 2`,有陰影再外擴 `shadowBlur` 加偏移量(陰影以緩衝區像素計、不吃變換,見第 03 章 3.4 的總表;換回世界座標要除以 dpr × zoom)。

當一個物件移動,髒區域 = 「**一塊同時把舊位置和新位置都框進去的矩形**」——因為你要把舊位置擦乾淨、又要在新位置畫上,兩塊都算「有變動」,所以取一個能把兩者都涵蓋的範圍。

但一幀裡有好幾塊髒區時(多個物件在動、物件瞬移),別全部取聯集:兩塊 40×40 的髒區分在畫面兩角,聯集面積是分開算的近 100 倍。常見做法是收集一份髒區清單,只合併「合併後不會多浪費太多面積」的:

```js
function addDirty(list, r) {               // 每幀把髒區一塊塊加進 list,繪製時逐塊 renderDirty
  for (let i = 0; i < list.length; i++) {
    const a = list[i], x = Math.min(a.x, r.x), y = Math.min(a.y, r.y);
    const u = { x, y, w: Math.max(a.x + a.w, r.x + r.w) - x, h: Math.max(a.y + a.h, r.y + r.h) - y };
    if (u.w * u.h <= 1.5 * (a.w * a.h + r.w * r.h)) {   // 合併後不超過兩塊總和的 1.5 倍才合併
      list.splice(i, 1);
      return addDirty(list, u);            // 合併後變大了,可能又能跟別塊合併
    }
  }
  list.push(r);   // 塊數太多(例如超過 8 塊)或總面積超過畫面一半時,乾脆整張重畫
}
```

> **務實提醒**:髒矩形省下的主要是「**少畫幾個物件**」,不只是「面積變小」:`clip` 只省掉填像素的工作,凡是和髒區相交的物件,建路徑、下指令的固定開銷照付,而在 GPU 加速的 canvas 上這些固定開銷常比填像素還貴。物件一多,連「逐一檢查 `getBounds()`」都是 O(n),要配合第 07 章 7.7 的空間索引,用髒區去查有哪些物件。它不好寫對,所以**實務上更常用、更簡單的是「分層 canvas」**(把靜態背景和動態前景拆成不同 canvas,只重畫動的那層)——這留到第 09 章,兩者也能並用。

---

## 8.7 Undo / Redo:兌現第 02 章的伏筆

第 02 章我們說「`restore()` 不是 Undo,Canvas 沒有內建撤銷」。現在資料和渲染分離了,**Undo/Redo 變得理所當然**——因為要撤銷的是「資料的改變」,不是「畫布的像素」。兩種主流做法:

### 做法 A:快照(snapshot)——簡單暴力

每次操作後,把整個場景**深拷貝**存進歷史堆疊。Undo 就是還原上一個快照。

```js
// 先把場景轉成「純資料」:每次都產生全新的物件,本身就是深拷貝(這個函式 8.8 序列化會細講)
function serialize(scene) {
  return scene.map(s => ({
    type: s.constructor.type,   // 'rect' / 'circle'(類別上的 static type,見 8.8)
    x: s.x, y: s.y, rotation: s.rotation,
    ...(s.w !== undefined ? { w: s.w, h: s.h } : { r: s.r }),
    fill: s.fill,
  }));
}

class History {
  constructor() { this.past = []; this.future = []; }
  commit(scene) {
    this.past.push(serialize(scene));                    // 存當前狀態的快照
    this.future = [];                                    // 新操作清空 redo
  }
  undo(applyState) {
    if (this.past.length < 2) return;                    // past[0] 是初始狀態,守住不彈出
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

const history = new History();
history.commit(scene);                                   // 先存初始狀態,第一個操作才撤銷得掉
function applyState(data) { scene = deserialize(data); render(); }   // 快照 → 重建實例(8.8)→ 重新投影
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

實作命令模式有三個常踩的坑:

- **拖曳只產生一個命令**:拖曳中直接改資料做即時預覽,放開時才推入**一個**帶總位移的 `MoveCommand`——推入時別再執行一次 `do()`,否則物件會移動兩次。
- **記 id,不記實例**:命令和「目前選取」都該記物件的穩定 `id`,再從場景查實例。快照式還原會重建所有實例,舊參照全部失效(作業裡 undo 之後要清掉 `selected`,就是這個原因)。
- **新命令清空 redo**:推入新命令時把 redo 堆疊清空,否則 redo 會跳回一條已經分岔的時間線。

> **心智模型**:Undo/Redo 的本質是「**狀態的時間旅行**」——而時間旅行的前提是「狀態是資料、可被保存/還原」。這正是 8.3 資料/渲染分離帶來的紅利。小專案用快照、大專案用命令模式。第 11 章白板會實作一個。

---

## 8.8 序列化:存檔、載入、複製貼上

同樣因為「場景是純資料」,把它存成 JSON 就能存檔/載入/分享/複製貼上:

```js
function serialize(scene) {
  return scene.map(s => ({
    type: s.constructor.type,   // 'rect' / 'circle'
    x: s.x, y: s.y, rotation: s.rotation,
    ...(s.w !== undefined ? { w: s.w, h: s.h } : { r: s.r }),
    fill: s.fill,
  }));
}

function deserialize(data) {
  const registry = { rect: RectShape, circle: CircleShape };   // 型別標記 → 類別
  return data.filter(d => registry[d.type])                   // 認不得的型別直接略過(舊檔、被改過的資料)
             .map(d => new registry[d.type](d));
}

// 存檔
localStorage.setItem('myCanvas', JSON.stringify(serialize(scene)));
// 載入(沒存過檔時 getItem 回傳 null,要先擋掉)
const raw = localStorage.getItem('myCanvas');
if (raw) scene = deserialize(JSON.parse(raw));
```

> ⚠️ **序列化要存「資料」,不要存「函式/類別實例」**。`JSON.stringify` 一個含方法的物件,方法會丟失。標準做法是存「純資料 + 型別標記」,載入時用一個「型別註冊表(registry)」重建實例。這也是為什麼資料和行為要分離。協作編輯(多人即時)傳的也是這份資料(或它的差異),不是像素。
>
> 型別標記要自己寫死(`static type = 'rect'`),**別用 `constructor.name`**:打包工具壓縮時(terser、esbuild 的預設)會把類別改名成 `a`、`b`,存出來的檔換一版 build 就載不回來。存檔外層也建議包一層版本號 `{ version: 1, shapes: [...] }`,日後格式改版才能遷移舊檔。

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
- **階層/群組**:節點樹 + 相對變換,遞迴繪製、`save/restore` 隔離每層;移動父節點,子節點自動跟動。命中時用「父 × 本地」的世界矩陣,反轉回本地座標判斷。
- **z-order**:繪製順序即層級;命中反向、繪製正向,共用同一陣列(樹裡是先子後己)。
- **髒矩形**:省的主要是「少畫物件」;要對齊像素、換算相機、包圍盒包全、多塊髒區有節制地合併。實務常用分層 canvas,兩者可並用(第 09 章)。
- **Undo/Redo**:狀態的時間旅行——快照(簡單)或命令模式(專業),兌現第 02 章伏筆。
- **序列化**:存純資料 + 自訂的型別標記(不靠 `constructor.name`),用註冊表重建;存檔、載入、協作都靠它。

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
        return { type: this.constructor.type, x: this.x, y: this.y, fill: this.fill };   // type:子類的 static type
      }
    }

    class RectShape extends Shape {
      static type = 'rect';               // 型別標記寫死,不靠 constructor.name(壓縮後會被改名,8.8)
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
      static type = 'circle';
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
      static type = 'text';
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
    const SHAPE_REGISTRY = { rect: RectShape, circle: CircleShape, text: TextShape };   // 型別標記 → 類別
    function serialize(scene) { return scene.map(s => s.toJSON()); }    // 每次都回傳全新純資料,天然就是深拷貝
    function deserialize(data) {                                        // 認不得的型別直接略過(舊檔、被改過的資料)
      return data.filter(d => SHAPE_REGISTRY[d.type]).map(d => new SHAPE_REGISTRY[d.type](d));
    }

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
