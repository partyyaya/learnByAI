# 第 11 章:Capstone——手寫一個 mini-Figma 白板

> **學習目標**:把前面所有章節的零件組裝成一個**真正能用的白板編輯器**:新增/選取/拖曳/縮放圖形、可平移縮放的相機、Undo/Redo、存檔載入。你會親手把第 00 章承諾的「造一台渲染引擎」變成現實。
> **預計時數**:5~8 小時(分階段做)
> 這一章沒有新觀念——它把 00~10 章的每一塊拼起來。當你做完,你不只「會用 Canvas」,你**理解了 Figma、Excalidraw、白板類產品底層的架構**,並且能自己造一個。

---

## 11.1 我們要做什麼:規格

一個單頁白板,功能:

- **工具列**:選取、矩形、圓形、文字四種工具。
- **新增**:選工具後在畫布拖曳出圖形;文字則點一下放置、雙擊編輯。
- **選取**:點擊選中、顯示選取框與縮放手把(handles),滑到手把上游標會變。
- **拖曳**:拖動圖形移動;拖動手把縮放;方向鍵微移。
- **相機**:空白處拖曳平移、滾輪以游標為中心縮放(第 03 章)。
- **刪除**:Delete / Backspace 刪除選中物件。
- **Undo / Redo**:Ctrl+Z / Ctrl+Shift+Z(或 Ctrl+Y)(第 08 章)。
- **存檔 / 載入**:序列化到 localStorage(第 08 章)。
- **效能與清晰度**:分層 canvas + 按需渲染(第 09 章)、視窗大小與 DPR 改變時重設畫布(第 01 章)。

> 這就是 mini-Figma 的核心迴圈。做完後,加更多圖形類型只是延伸;多人協作則是另一個量級的工程(見 11.10)。

---

## 11.2 架構總覽:每一塊來自哪一章

```
┌──────────────────────────────────────────────────────┐
│  Editor(總控)                                          │
│   ├─ Scene 場景圖:Shape 物件陣列            ← 第 08 章  │
│   ├─ Camera 相機:x / y / zoom              ← 第 03 章  │
│   ├─ Tools 工具:select / rect / circle…    ← 第 07 章  │
│   ├─ Input 輸入:pointer 事件 → 世界座標     ← 第 03/07 章│
│   ├─ HitTest 命中:選誰、拖誰、抓哪個手把     ← 第 07 章  │
│   ├─ History 歷史:Undo / Redo              ← 第 08 章  │
│   ├─ Persistence 存檔:serialize ↔ JSON     ← 第 08 章  │
│   └─ Renderer 渲染:分層 canvas + dirty flag ← 第 01/09 章│
└──────────────────────────────────────────────────────┘
```

> **學習策略**:**分階段做,每階段都能跑**。順序:① 場景圖 + 渲染 →② 新增圖形 →③ 選取/拖曳 →④ 相機 →⑤ 縮放手把 →⑥ Undo/存檔。每完成一階段就測試,不要一次寫完才跑。

---

## 11.3 資料模型(第 08 章)

```js
// 所有圖形的基底
class Shape {
  constructor(props) {
    Object.assign(this, { id: uid(), x: 0, y: 0, w: 100, h: 80, fill: '#cfe3ff', ...props });
  }
  // 包圍盒(世界座標)——選取框、命中都用它
  getBounds() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
  containsPoint(p) {
    return p.x >= this.x && p.x <= this.x + this.w &&
           p.y >= this.y && p.y <= this.y + this.h;
  }
  draw(ctx) {}
  toJSON() {   // 只輸出資料欄位(白名單),暫態狀態(例如拖曳起點)不會混進存檔
    return { type: this.constructor.type, id: this.id, x: this.x, y: this.y,
             w: this.w, h: this.h, fill: this.fill,
             ...(this.text !== undefined ? { text: this.text, fontSize: this.fontSize } : {}) };
  }
}

class RectShape extends Shape {
  static type = 'rect';
  draw(ctx) {
    ctx.fillStyle = this.fill;
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;   // 描邊是圖形內容:世界單位,跟著相機縮放(和 Figma 一樣)
    ctx.fillRect(this.x, this.y, this.w, this.h);
    ctx.strokeRect(this.x, this.y, this.w, this.h);
  }
}

class CircleShape extends Shape {
  static type = 'circle';
  draw(ctx) {
    ctx.fillStyle = this.fill;
    ctx.beginPath();   // 路徑三部曲:beginPath() 開新路徑 → ellipse() 描述形狀 → fill() 填滿
    // 以包圍盒為基準畫橢圓,讓圓也能用統一的 bounds/handles 邏輯
    ctx.ellipse(this.x + this.w/2, this.y + this.h/2, this.w/2, this.h/2, 0, 0, Math.PI*2);   // ellipse(中心x, 中心y, 半徑x, 半徑y, 旋轉, 起始角, 結束角) → 0~2π 畫整個橢圓
    ctx.fill();
  }
  containsPoint(p) {
    const cx = this.x + this.w/2, cy = this.y + this.h/2;
    const dx = (p.x - cx) / (this.w/2 || 1), dy = (p.y - cy) / (this.h/2 || 1);   // || 1 防新建時 w=0 除零
    return dx*dx + dy*dy <= 1;   // 橢圓內判斷(歸一化後當單位圓)
  }
}

const measureCtx = document.createElement('canvas').getContext('2d');   // 專門量字的離屏 context

class TextShape extends Shape {
  static type = 'text';
  constructor(props) { super({ text: '雙擊編輯', fontSize: 24, fill: '#222', ...props }); this.layout(); }
  // 量測文字更新包圍盒(命中、選取框要用)— 第 04 章。只在 text / fontSize 改變時呼叫(理由見 11.7)
  layout() {
    measureCtx.font = `${this.fontSize}px sans-serif`;
    this.w = measureCtx.measureText(this.text).width;
    this.h = this.fontSize * 1.2;
  }
  draw(ctx) {   // 只讀不寫
    ctx.fillStyle = this.fill;
    ctx.font = `${this.fontSize}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(this.text, this.x, this.y);
  }
}

const REGISTRY = { rect: RectShape, circle: CircleShape, text: TextShape };
// 時間 + 隨機:重新整理、載入舊檔後也不會跟既有 id 撞號(正式協作用 crypto.randomUUID())
function uid() { return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
```

> **重點**:讓圓也用「包圍盒 + w/h」描述(畫成橢圓),選取框、縮放手把、序列化就能用**一套統一邏輯**處理所有圖形,不用每種形狀寫一套手把。這是讓 Capstone 不爆炸的關鍵設計取捨。
>
> 矩形描邊用世界單位(`lineWidth = 1`,放大就變粗),11.6 的選取框卻用 `1 / camera.zoom`(永遠 1px):**畫的是內容還是 UI,決定它該不該跟著縮放**。`draw()` 因此不依賴相機,匯出時(11.10)才會畫得和存檔一模一樣。

---

## 11.4 相機與座標換算(第 03 章)

```js
const camera = { x: 0, y: 0, zoom: 1 };

function applyCamera(ctx) {
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);
}

function screenToWorld(sx, sy) {
  return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
}

function eventToWorld(e) {   // canvas = 事件綁定的那層(11.5 宣告)
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
}
```

滾輪以游標為中心縮放,數學就是第 03.7 章那四步(記錄焦點世界座標 → 縮放 → 移回原位),這裡換成本章的函式簽名。先寫成具名函式,11.6 再跟 pointer 事件一起綁上去(這時 `canvas` 還沒宣告):

```js
function onWheel(e) {
  e.preventDefault();                                        // 攔下頁面捲動與瀏覽器縮放
  if (e.deltaY === 0) return;                                // 純水平捲動(Shift+滾輪、觸控板橫滑)不縮放
  if (endTextEdit) endTextEdit(true);                        // 文字編輯框(11.6)跟不上相機:先收尾
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const before = screenToWorld(sx, sy);                      // 1. 縮放前,游標指著的世界座標
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;   // deltaMode 1 = 以「行」為單位,約略換成像素
  const factor = Math.exp(-dy * 0.002);                      // 連續倍率:觸控板的小 delta 只縮一點,滑鼠一格約 ×1.2
  camera.zoom = Math.max(0.1, Math.min(camera.zoom * factor, 20));   // 2. 縮放(限制範圍)
  const after = screenToWorld(sx, sy);                       // 3. 同一個螢幕點,現在指著的世界座標
  camera.x += before.x - after.x; camera.y += before.y - after.y;   // 4. 把差值補回去,焦點回到游標下
  invalidate();                                              // 不直接呼叫 render():11.5 的 render 會自己排下一幀,再呼叫就多一條迴圈
}
```

> Figma 式的另一種約定是「無修飾鍵滾動 = 平移、Ctrl/⌘+滾輪(觸控板捏合也會送 `ctrlKey: true` 的 wheel)= 縮放」,想改成那樣,只要在 `onWheel` 開頭依 `e.ctrlKey || e.metaKey` 分流。

---

## 11.5 渲染:分層 + 按需(第 01、09 章)

兩層:`content`(圖形)、`overlay`(選取框/手把/拖曳預覽)。用 dirty flag 按需重畫。

```js
// 畫布與場景:兩個 <canvas> 疊在一起(HTML 見 11.8),資料只有一份 scene
const content = document.getElementById('content');   // 圖形層
const canvas  = document.getElementById('overlay');   // 選取框層,疊最上面(事件也綁這層,見 11.6)
const contentCtx = content.getContext('2d');
const overlayCtx = canvas.getContext('2d');
const scene = [];   // 所有圖形(第 08 章:資料是唯一真相)

// 互動狀態:11.6 的事件處理會更新它們,render 只負責讀
let selected = null;             // 目前選中的圖形
let creating = null;             // 拖曳新增中、尚未提交進 scene 的圖形
let editing = null;              // 正在編輯的 TextShape(11.6):改由 DOM input 顯示,render 跳過它
let drawSelection = () => {};    // 畫「選取框+手把」,先放空殼,11.6 填入實作

let contentDirty = true, overlayDirty = true;
const invalidate = () => { contentDirty = overlayDirty = true; };
const invalidateOverlay = () => { overlayDirty = true; };

// 第 01 章 1.4:緩衝區 = CSS 尺寸 × DPR(取整);視窗大小或 DPR 一變就重設
let W = 0, H = 0, dpr = 1;
function resize() {
  W = innerWidth; H = innerHeight; dpr = devicePixelRatio || 1;
  for (const c of [content, canvas]) {
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    c.style.width = W + 'px'; c.style.height = H + 'px';
  }
  invalidate();   // 重設 width 會清空畫布:兩層都要重畫
}
function watchDpr() {   // 拖到另一個螢幕、瀏覽器縮放:DPR 變了就重設,並用新值重新註冊
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
}
resize(); watchDpr(); addEventListener('resize', resize);

function render() {
  if (contentDirty) {
    contentCtx.setTransform(dpr, 0, 0, dpr, 0, 0);   // setTransform(a,b,c,d,e,f):(a,b)=x 軸、(c,d)=y 軸、(e,f)=原點(第 03 章);這裡 = 每單位 dpr 個實體像素、原點在左上
    contentCtx.clearRect(0, 0, W, H);
    contentCtx.save(); applyCamera(contentCtx);     // save():先存一份目前繪圖狀態,套相機變換,畫完由下面 restore() 還原(免得污染下一層)
    for (const s of scene) if (s !== editing) s.draw(contentCtx);   // 第 08 章:遍歷畫;編輯中的文字交給 input
    contentCtx.restore();
    contentDirty = false;
  }
  if (overlayDirty) {
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, W, H);
    overlayCtx.save(); applyCamera(overlayCtx);
    if (creating) creating.draw(overlayCtx);             // 新增中的預覽
    if (selected && selected !== editing) drawSelection(overlayCtx, selected);   // 選取框畫最上面(編輯中的文字由 input 自帶外框)
    overlayCtx.restore();
    overlayDirty = false;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
```

---

## 11.6 互動核心:選取、拖曳、縮放手把(第 07 章)

選取框畫 8 個手把(四角 + 四邊中點)。手把的命中要用「螢幕固定大小」(不隨 zoom 變大變小),所以判斷時把容差除以 zoom。

```js
const HANDLE = 8;   // 手把螢幕邊長(px)

function getHandles(shape) {
  const { x, y, w, h } = shape.getBounds();
  return {
    nw: {x, y}, n: {x:x+w/2, y}, ne: {x:x+w, y},
    w_: {x, y:y+h/2},            e: {x:x+w, y:y+h/2},
    sw: {x, y:y+h}, s: {x:x+w/2, y:y+h}, se: {x:x+w, y:y+h},
  };
}

drawSelection = (ctx, shape) => {   // 填入 11.5 預留的空殼
  const b = shape.getBounds();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1 / camera.zoom;            // 選取框是 UI:線寬抵消縮放,維持 1px 觀感
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  if (shape instanceof TextShape) return;     // 文字只框選、不畫縮放手把(大小由 fontSize 決定)
  const r = HANDLE / camera.zoom / 2;         // 手把大小抵消縮放
  ctx.fillStyle = '#fff';
  for (const p of Object.values(getHandles(shape))) {
    ctx.fillRect(p.x - r, p.y - r, r*2, r*2);
    ctx.strokeRect(p.x - r, p.y - r, r*2, r*2);
  }
};

// 命中:先測手把(優先),再測圖形本體
function hitHandle(shape, wp) {
  if (shape instanceof TextShape) return null;       // 文字不做框縮放(見下方說明)
  // 圖形在螢幕上太小時,8 個手把會蓋滿本體:這時點在本體內一律算拖曳,手把只能從外圍抓
  if (Math.min(shape.w, shape.h) * camera.zoom < HANDLE * 3 && shape.containsPoint(wp)) return null;
  const r = HANDLE / camera.zoom;                    // 命中容差比畫出來的手把大一圈,好抓
  for (const [name, p] of Object.entries(getHandles(shape))) {
    if (Math.abs(wp.x - p.x) <= r && Math.abs(wp.y - p.y) <= r) return name;
  }
  return null;
}
function hitShape(wp) {
  for (let i = scene.length - 1; i >= 0; i--)   // 第 07 章:反向取最上層
    if (scene[i].containsPoint(wp)) return scene[i];
  return null;
}
```

> **文字為什麼是例外**:文字的大小由 `fontSize` 決定,不走「拉框縮放」,所以**不畫手把、也不進 `resizing`**。若照樣畫,一行小字會被 8 個手把幾乎蓋滿——你想拖曳移動時十之八九先碰到手把、變成 resize;偏偏文字的 `w/h` 是 `layout()` 依字量出來的,拉了下次一量又彈回,體感就會「怪怪的」。把文字排除在框縮放之外,整個包圍盒就成了乾淨的拖曳區(要改大小去調 `fontSize`)。矩形、圓在**螢幕上**很小時(例如縮小視圖看全景)也有同樣的問題,所以 `hitHandle` 對它們改成「本體優先」。

### 互動狀態機

互動的本質是一台小狀態機(呼應你 [影音課](../video-player-course/README.md) 的「播放器是狀態機」心法):`idle → 依工具與命中結果進入 creating / dragging / resizing / panning → up(或被取消)回到 idle`。

pointer 事件的健壯性細節——`touch-action: none`、只認主鍵、只認一個 `pointerId`、處理 `pointercancel`——原理見第 07 章 7.8,這裡照用。白板多一條:手勢被中斷時用 `history.restore(history.present)` 回到最後提交的狀態,快照歷史順手就給了「取消」。

```js
let tool = 'select';      // 'select' | 'rect' | 'circle' | 'text'
let mode = 'idle';        // 'idle' | 'creating' | 'dragging' | 'resizing' | 'panning'
let activePointer = null; // 目前手勢的 pointerId:一次只認一根指標
let dragOffset = null, resizeAnchor = null, createOrigin = null, panStart = null;
// (selected、creating、editing 在 11.5 已宣告)

// 後面小節才實作的依賴,先放可運作的空殼,這節的程式碼就能直接跑:
let history = { commit() {}, restore() {} };   // 11.7 換成真正的快照式 undo 歷史
let syncToolbar = () => {};      // 11.8 換成「同步工具列按鈕高亮」
let endTextEdit = null;          // 文字編輯中 = 收尾函式(本節後半填入);相機要動之前先呼叫

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || activePointer !== null) return;   // 只認主鍵、第二根手指不插隊
  if (endTextEdit) endTextEdit(true);                      // 點到畫布 = 先把文字編輯收尾
  activePointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  const wp = eventToWorld(e);

  if (tool === 'select') {
    // 先看是否抓到選中物件的手把 → 縮放
    const handle = selected && hitHandle(selected, wp);
    if (handle) {
      mode = 'resizing';
      const b = selected.getBounds();           // 記下固定不動的對邊當錨點 → 支援翻轉
      const hp = getHandles(selected)[handle];
      resizeAnchor = {
        ax: handle.includes('w') ? b.x + b.w : (handle.includes('e') ? b.x : null),
        ay: handle.includes('n') ? b.y + b.h : (handle.includes('s') ? b.y : null),
        ox: b.x, ow: b.w, oy: b.y, oh: b.h,
        gx: wp.x - hp.x, gy: wp.y - hp.y,       // 抓的位置離手把中心多遠(同 dragOffset 的道理)
      };
      return;
    }
    // 否則看點到哪個圖形 → 選取 + 拖曳
    const hit = hitShape(wp);
    if (hit) {
      selected = hit; mode = 'dragging';
      dragOffset = { x: wp.x - hit.x, y: wp.y - hit.y };   // 第 07 章:避免跳動
    } else {
      selected = null; mode = 'panning';                   // 空白處 → 平移相機
      panStart = { x: e.clientX, y: e.clientY };
    }
    invalidate();
  } else if (tool === 'text') {
    // 文字:點擊即放置(寬高由 layout() 量出來,拖曳框對文字沒意義)
    const t = new TextShape({ x: wp.x, y: wp.y });
    scene.push(t); selected = t; history.commit();
    tool = 'select'; syncToolbar(); invalidate();
  } else {
    // 矩形 / 圓形:拖出一個新圖形
    mode = 'creating';
    const Cls = REGISTRY[tool];
    createOrigin = { x: wp.x, y: wp.y };   // 起點存獨立變數,不掛在 shape 上(避免污染序列化)
    creating = new Cls({ x: wp.x, y: wp.y, w: 0, h: 0 });
    invalidateOverlay();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (activePointer === null) { updateCursor(e); return; }   // 沒有手勢:只做 hover 游標回饋
  if (e.pointerId !== activePointer) return;
  if (e.buttons === 0) { cancelGesture(); return; }         // 放開的事件被吃掉了(例如 Mac 的 Ctrl+點擊叫出選單)
  const wp = eventToWorld(e);
  switch (mode) {
    case 'dragging':
      selected.x = wp.x - dragOffset.x;
      selected.y = wp.y - dragOffset.y;
      invalidate(); break;
    case 'resizing':
      applyResize(selected, wp);   // 依錨點更新 x/y/w/h(見下方函式)
      invalidate(); break;
    case 'creating': {
      const o = createOrigin;                    // 支援往任意方向拖
      creating.x = Math.min(o.x, wp.x);
      creating.y = Math.min(o.y, wp.y);
      creating.w = Math.abs(wp.x - o.x);
      creating.h = Math.abs(wp.y - o.y);
      invalidateOverlay(); break;
    }
    case 'panning':
      camera.x -= (e.clientX - panStart.x) / camera.zoom;   // 第 03 章
      camera.y -= (e.clientY - panStart.y) / camera.zoom;
      panStart = { x: e.clientX, y: e.clientY };
      invalidate(); break;
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== activePointer) return;
  // 「太小就當誤點」的門檻是螢幕上的 2px:世界寬高乘回 zoom 再比,放大縮小時手感才一致
  if (mode === 'creating' && creating.w * camera.zoom > 2 && creating.h * camera.zoom > 2) {
    scene.push(creating);          // 提交新圖形
    selected = creating;
    history.commit();              // 記一筆歷史
    tool = 'select';               // 畫完自動切回選取(Figma 行為)
    syncToolbar();
  }
  if (mode === 'dragging' || mode === 'resizing') history.commit();
  endGesture();
});

// 系統手勢、手掌誤觸等讓瀏覽器取消這根指標:放棄這次手勢,回到最後提交的狀態
canvas.addEventListener('pointercancel', (e) => { if (e.pointerId === activePointer) cancelGesture(); });
canvas.addEventListener('wheel', onWheel, { passive: false });   // 11.4;passive:false 才能 preventDefault

function cancelGesture() {
  if (mode === 'dragging' || mode === 'resizing') history.restore(history.present);
  endGesture();
}
function endGesture() { creating = createOrigin = null; mode = 'idle'; activePointer = null; invalidate(); }
```

```js
// 縮放:以「固定不動的對邊」為錨點重算 bounds,用 min/abs 自然支援「拖過對邊翻轉」。
// 錨點在上面 pointerdown 抓到手把那一刻就算好存進 resizeAnchor。
function applyResize(s, wp) {
  const a = resizeAnchor;
  const px = wp.x - a.gx, py = wp.y - a.gy;   // 扣掉按下時「游標離手把中心」的偏移,邊才不會一動就跳
  if (a.ax !== null) { s.x = Math.min(a.ax, px); s.w = Math.max(1, Math.abs(px - a.ax)); }
  else { s.x = a.ox; s.w = a.ow; }
  if (a.ay !== null) { s.y = Math.min(a.ay, py); s.h = Math.max(1, Math.abs(py - a.ay)); }
  else { s.y = a.oy; s.h = a.oh; }
}

// hover 回饋(第 07 章):滑到手把 → 對應方向的縮放游標,滑到圖形 → move
const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
                        n: 'ns-resize', s: 'ns-resize', w_: 'ew-resize', e: 'ew-resize' };
function updateCursor(e) {
  const wp = eventToWorld(e), h = tool === 'select' && selected && hitHandle(selected, wp);
  const c = tool !== 'select' ? 'crosshair' : h ? HANDLE_CURSOR[h] : hitShape(wp) ? 'move' : 'default';
  if (canvas.style.cursor !== c) canvas.style.cursor = c;   // 沒變就不寫,免得每次 move 都動 style
}
```

### 文字雙擊編輯:把 DOM `<input>` 疊在世界座標上(第 03、04 章)

`TextShape` 的預設字是「雙擊編輯」——現在來兌現它。Canvas **畫不出可輸入的文字**(第 04 章:它只會把字「畫成像素」),所以標準做法是:**雙擊時在文字的螢幕位置疊一個真的 `<input>` 給使用者打字,打完把字寫回 shape、再畫回 canvas**。這需要「世界座標 → 螢幕座標」的換算,正是 11.4 `screenToWorld` 的反運算:

```js
function worldToScreen(wx, wy) {   // screenToWorld 的反運算:世界座標 → 螢幕像素
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}
```

```js
const stage = document.getElementById('stage');   // #stage 是 position:relative 的定位容器(見 11.8)

canvas.addEventListener('dblclick', (e) => {
  if (tool !== 'select') return;
  const hit = hitShape(eventToWorld(e));
  if (hit instanceof TextShape) { selected = hit; startTextEdit(hit); }
});

function startTextEdit(shape) {
  editing = shape; invalidate();                       // 11.5 的 render 會跳過它

  const fs = shape.fontSize * camera.zoom;             // 螢幕上的字級 = 世界字級 × zoom
  const p = worldToScreen(shape.x, shape.y);           // input 要擺的螢幕位置
  const input = document.createElement('input');
  input.type = 'text';
  input.value = shape.text;
  input.style.cssText =
    `position:absolute;left:${p.x}px;top:${p.y}px;margin:0;padding:0 1px;border:0;` +
    `font:${fs}px sans-serif;line-height:1.2;height:${fs * 1.2}px;color:${shape.fill};` +   // 行高對齊 layout() 的 1.2 倍
    `outline:1px solid #3b82f6;background:rgba(255,255,255,.92);`;
  stage.appendChild(input);
  const fitWidth = () => {                             // 隨輸入內容變寬(measureText,第 04 章)
    measureCtx.font = `${fs}px sans-serif`;
    input.style.width = (measureCtx.measureText(input.value).width + 4) + 'px';
  };
  fitWidth(); input.addEventListener('input', fitWidth);

  function finish(commit) {
    if (editing !== shape) return;                     // 已收尾過(remove 可能再觸發一次 blur)就不重複
    editing = null; endTextEdit = null;
    if (commit) {
      const v = input.value.trim();
      if (v) { shape.text = v; shape.layout(); }       // 文字變了 → 重新量包圍盒
      else {                                           // 清空 = 刪除這個文字,選取一起清(別指著已刪的物件)
        const i = scene.indexOf(shape);
        if (i >= 0) scene.splice(i, 1);
        if (selected === shape) selected = null;
      }
      history.commit();                                // 收尾進 Undo/Redo(第 08 章)
    }
    input.remove(); invalidate();
  }
  endTextEdit = finish;                                // 點畫布、平移、縮放前會先呼叫它
  input.addEventListener('blur', () => finish(true));                        // 點別處 = 完成並存檔
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();                                                    // 別讓 11.7 的全域快捷鍵處理這次按鍵
    if (ev.isComposing || ev.keyCode === 229) return;                        // 注音/拼音選字中的 Enter、Esc 是給輸入法的
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }           // Enter = 完成
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }    // Esc = 取消(不寫回)
  });
  input.focus(); input.select();
}
```

四個關鍵細節(漏了就會出 bug):

① **位置和字級都要乘 `camera.zoom`**——`<input>` 是螢幕上的 DOM,不吃相機變換,所以世界座標與字級都得自己換算成螢幕像素。它也不會跟著相機動,所以點畫布、平移、縮放之前都先呼叫 `endTextEdit(true)` 收尾。
② **編輯中要讓 canvas 跳過這個 shape**——11.5 的 render 已經用 `editing` 濾掉(content 層不畫字、overlay 層不畫選取框),否則畫布上的靜態字會和 input 疊字。
③ **IME 選字**——用注音、拼音打字時,按 Enter 是在「選字」,這時 keydown 的 `isComposing` 為 true(Safari 則是送 `keyCode` 229);不先放行,一選字就結束編輯了。
④ **收尾要 `history.commit()`**,清空刪除時連 `selected` 一起清。11.7 的全域快捷鍵會再加一道「焦點在 `<input>`/IME 組字時不攔截」的防呆,兩層一起保證打字時按 Delete、Ctrl+Z 不會動到圖形。

> **心智模型**:Canvas 畫不了可編輯文字,但你有整個 DOM 可用。**「平常用 canvas 畫靜態、要編輯時借一個 DOM 元件疊上去、編輯完再畫回 canvas」是所有 canvas 編輯器(Figma、Excalidraw、tldraw)的通用套路**——把兩個世界黏起來的膠水,就是第 03 章的世界↔螢幕座標換算。

---

## 11.7 Undo/Redo 與序列化(第 08 章)

用快照式歷史(簡單、正確)。核心是維護一個 `present`(目前已提交的狀態快照);每個操作結束只要呼叫 `commit()`,它會跟 `present` 比對,有變化才推入歷史。**不需要 `begin()`——這樣連「新增圖形」都天然可被復原**(這是初版設計常踩的坑:若只在拖曳時記起點,新增就無法 undo)。它也是第 08 章 8.7「做法 A:快照」的改良版——用單一 `present` 取代「`past` 堆疊裡含現值」的約定,語意更清楚:

```js
history = {   // 填入 11.6 預留的空殼,換成真正的快照歷史
  past: [], future: [], present: '[]',
  snapshot() { return JSON.stringify(scene.map(s => s.toJSON())); },
  init() { this.present = this.snapshot(); },     // 啟動時記下初始(空)狀態
  commit() {
    const now = this.snapshot();
    if (now === this.present) return;             // 沒變化不記錄
    this.past.push(this.present);                 // 把「上一個已提交狀態」存進過去
    this.present = now;
    this.future = [];                             // 新操作清空 redo
  },
  restore(json) {
    const keepId = selected && selected.id;       // 物件會整批重建:選取改用 id 找回
    scene.length = 0;                             // 就地清空,維持同一陣列參考
    for (const d of JSON.parse(json))
      scene.push(new REGISTRY[d.type](d));        // 用註冊表重建
    selected = scene.find(s => s.id === keepId) || null;
    invalidate();
  },
  undo() {
    if (!this.past.length) return;
    this.future.push(this.present);
    this.present = this.past.pop();
    this.restore(this.present);
  },
  redo() {
    if (!this.future.length) return;
    this.past.push(this.present);
    this.present = this.future.pop();
    this.restore(this.present);
  },
};
history.init();

// 焦點在輸入框 / IME 組字時不攔截:11.6 的文字編輯打字時才不會誤刪圖形、誤觸 undo
function isTyping(e) {
  const t = e.target;
  return e.isComposing || !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
}
const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
addEventListener('keydown', (e) => {
  if (isTyping(e) || mode !== 'idle') return;   // 拖曳/縮放中不吃快捷鍵:undo 會換掉 selected,手勢就斷了
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();                // Shift 或 Caps Lock 會讓 key 變成大寫 'Z'
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); }
  else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); history.redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault(); const i = scene.indexOf(selected);
    if (i >= 0) scene.splice(i, 1);             // indexOf 找不到是 -1,splice(-1, 1) 會刪掉最後一個
    selected = null; history.commit(); invalidate();
  } else if (selected && NUDGE[e.key]) {        // 方向鍵微移(Shift = 10 倍),也是非滑鼠的操作路徑
    e.preventDefault();
    const [dx, dy] = NUDGE[e.key], step = e.shiftKey ? 10 : 1;
    selected.x += dx * step; selected.y += dy * step;
    invalidate();                               // 按住會連發 keydown:這裡只移動,放開才記一筆
  }
});
addEventListener('keyup', (e) => { if (!isTyping(e) && NUDGE[e.key]) history.commit(); });

// 存檔 / 載入(第 08 章序列化):格式帶版本號,日後改格式時才認得出舊檔、做遷移
const save = () =>
  localStorage.setItem('board', JSON.stringify({ version: 1, shapes: scene.map(s => s.toJSON()) }));
const load = () => {
  const data = JSON.parse(localStorage.getItem('board') || 'null');
  if (!data || data.version !== 1) return;     // 沒存過或不認得的格式
  selected = null; history.restore(JSON.stringify(data.shapes));
  history.present = history.snapshot(); history.past = []; history.future = [];   // 載入視為新初始狀態,清空歷史
};
```

> ⚠️ **兩個序列化設計重點**:
> ① `toJSON` 用**白名單**(明列要存的欄位)而非 `...this`——否則暫態欄位會被寫進存檔。對應地,新增圖形的拖曳起點存在獨立變數 `createOrigin`,而不是掛在 shape 上。**資料欄位與暫態狀態分清楚,序列化才乾淨。**
> ② **載入(load)要視為「新的初始狀態」並清空 history**(`present`/`past`/`future` 一起重設)。否則在 present 基準設計下,`present` 會停在載入前的舊狀態,接著一 `commit` 就把「載入」記成一筆怪異歷史,`undo` 還會跳回載入前。`present` 取 `snapshot()` 而不是讀進來的字串,是為了守住下面那條前提。

> **快照式 undo 的兩個前提**:
> ① **渲染不能改模型**。`commit()` 靠「`present` 永遠等於當下 scene 的快照」判斷有沒有變化;要是 `draw()` 偷改資料(例如邊畫邊用 `measureText` 寫回文字的 w/h),快照和畫面就差一截——點一下沒動的圖形也會多出一筆歷史,undo 之後再點一下,甚至會把 redo 堆疊清掉。所以 11.3 把量測放進 `layout()`,只在文字改變時呼叫,`draw()` 只讀不寫。
> ② **還原會打斷物件身分**。`restore()` 建出的是全新物件,任何拿著舊物件參考的變數都會指向已不在 scene 裡的東西——所以 `restore()` 用 id 找回選取,快捷鍵也在手勢進行中一律不處理。需要長期指向某個圖形時(選取、連接線端點、協作者的游標),存 id,不存物件參考。

---

## 11.8 完整檔案結構與 HTML 骨架

把上面組裝成單一 `index.html`(各模組依 11.3~11.7 填入)。

> 📁 **完整可運行版本**:本章程式碼已組裝成一個能直接打開的 demo,放在 [`capstone-demo/`](./capstone-demo/)([index.html](./capstone-demo/index.html) + [whiteboard.js](./capstone-demo/whiteboard.js))。用任意 dev server 開啟即可操作(直接 `file://` 開也行)。下面是 HTML 骨架:
>
> ⚠️ demo 裡的格線是 `#stage` 的 **CSS 背景**(固定在螢幕、不隨相機動,縮放時格線間距也不變)。這只是裝飾;真要做「格線跟著世界一起平移縮放」(像 Figma),得把格線**畫進一張 bg canvas 並套用 `applyCamera`**。

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>mini-figma</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  #toolbar { position: fixed; top: 12px; left: 12px; z-index: 10; display: flex; gap: 6px; }
  #toolbar button { padding: 8px 12px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  #toolbar button.active { background: #3b82f6; color: #fff; }
  .layer { position: absolute; top: 0; left: 0; }
  #overlay { touch-action: none; }   /* 讓 pointer 事件不被瀏覽器手勢吃掉 */
</style></head>
<body>
  <div id="toolbar">
    <button data-tool="select" class="active">選取</button>
    <button data-tool="rect">矩形</button>
    <button data-tool="circle">圓形</button>
    <button data-tool="text">文字</button>
    <button id="saveBtn">存檔</button>
    <button id="loadBtn">載入</button>
  </div>
  <div id="stage" style="position:relative">
    <canvas id="content" class="layer"></canvas>
    <canvas id="overlay" class="layer"></canvas>   <!-- 互動事件綁在最上層 overlay -->
  </div>
  <script>
    /* … 11.3~11.7 的程式碼依序貼這裡:Shape 類、相機、渲染(畫布/場景的宣告在 11.5 開頭)、事件、history … */
    // 工具列切換
    document.querySelectorAll('[data-tool]').forEach(btn =>
      btn.onclick = () => { tool = btn.dataset.tool; selected = null; invalidate(); syncToolbar(); });
    syncToolbar = () => {   // 填入 11.6 預留的空殼:高亮目前選中的工具按鈕
      document.querySelectorAll('[data-tool]').forEach(b =>
        b.classList.toggle('active', b.dataset.tool === tool));
    };
    document.getElementById('saveBtn').onclick = save;
    document.getElementById('loadBtn').onclick = load;
  </script>
</body>
</html>
```

> **提示**:事件綁在**最上層的 `overlay`** canvas(它蓋在最上面,才收得到滑鼠);繪圖則分別畫在 `content` 與 `overlay`。`touch-action: none` 很關鍵,否則觸控裝置上手勢會搶走你的拖曳(第 07 章 7.8)。

---

## 11.9 別忘了無障礙(a11y):別讓畫布變成黑洞

第 00 章說過 Canvas 的 a11y 很差,現在你做出完整 app,得正視它:**你畫的一切,對螢幕報讀器和純鍵盤使用者來說都不存在——畫布只是一塊沒有語意的像素。** 這是 immediate mode 最後一個、也最常被忽略的洞。好消息是,第 08 章「資料是唯一真相」的架構讓補救變簡單:同一份 `scene` 資料,既能畫成像素,也能投影成一份「無障礙的 DOM 鏡像」。

四個務實做法:

### 1. UI 用真 DOM,不要畫進 canvas

工具列、按鈕、選單一律用真的 `<button>`(本章 demo 正是這樣)。**canvas 只放「畫布內容」,周邊 UI 交給 DOM**——它們天生可聚焦、可報讀、可鍵盤操作。這也呼應第 00 章「Canvas 不是用來取代 DOM」。

### 2. 給 canvas 一個語意替身

在 `<canvas>` 內放 fallback 內容,並維護一份隱藏的 DOM 鏡像來描述場景:

```html
<canvas id="overlay" tabindex="0" role="application"
        aria-label="白板畫布,可用方向鍵移動選取的圖形">
  <!-- fallback:不支援 canvas 時顯示,部分輔助技術也讀得到 -->
  <ul id="a11y-mirror"></ul>
</canvas>
<div id="a11y-live" aria-live="polite" class="sr-only"></div>   <!-- 變化播報 -->
```

```js
// 場景變動時,同步更新無障礙鏡像(同一份 scene 資料,投影成語意 DOM)
function syncA11yMirror() {
  const mirror = document.getElementById('a11y-mirror');
  mirror.replaceChildren(...scene.map((s, i) => {
    const li = document.createElement('li');
    // textContent 只當純文字:使用者打的字(或載入、協作傳來的)不會被當成 HTML 解析
    li.textContent = `${s.constructor.type} ${i + 1}${s.text ? ':' + s.text : ''},位於 ${Math.round(s.x)},${Math.round(s.y)}`;
    return li;
  }));
}
function announce(msg) { document.getElementById('a11y-live').textContent = msg; }
```

### 3. 鍵盤可操作

canvas 本身不可聚焦也不可操作,要自己補:`tabindex="0"` 讓它能被 Tab 聚焦;11.7 的 Delete 與方向鍵微移,就是「刪除/移動」的非滑鼠路徑。剩下的是把結果播報出來:

```js
addEventListener('keyup', (e) => {   // 放開方向鍵時播報一次(按住連發時不會每格都念)
  if (selected && !isTyping(e) && NUDGE[e.key])
    announce(`移動到 ${Math.round(selected.x)}, ${Math.round(selected.y)}`);
});
// 進階:Tab / Enter 在 scene 裡循環選取,並 announce 當前物件
```

### 4. 尊重使用者偏好

動畫要看 `prefers-reduced-motion`(偏好減少動態時關掉或減弱過場);別只用顏色區分狀態(色盲);選取框、hover 要有足夠對比。

> **心智模型**:**canvas 給輔助技術的是「零」**,你得主動提供一份平行的語意表示。而第 08 章「scene 是唯一真相」的架構,讓「畫像素」和「產生無障礙 DOM」變成同一份資料的兩種投影——這是資料/渲染分離的又一個紅利。完整 a11y 是大工程,但**至少做到「UI 用 DOM、canvas 可鍵盤聚焦操作、變化有 live region 播報」**,就能不把一整群使用者擋在門外。

---

## 11.10 延伸挑戰(從 mini 走向 real)

做完基本版後,挑你有興趣的延伸,每一個都會逼你回去深化某一章:

| 挑戰 | 回去深化哪章 |
|------|--------------|
| 框選多個物件 + 群組移動 | 07(矩形相交)、08(群組) |
| 物件旋轉手把 | 03(繞中心旋轉)、07(本地座標命中) |
| 對齊輔助線(snap to 其他物件邊緣) | 07(幾何) |
| 上萬個物件不卡(空間索引 + 視口剔除) | 07(quadtree)、09(只畫視口內) |
| 多人即時協作(見下方) | 08(序列化、命令模式 Undo)|
| 匯出 PNG(`canvas.toBlob`,見下方)/ 匯出 SVG | 04、05 |
| 命令模式重構 Undo(取代快照) | 08 |

**匯出別直接 `toBlob` 畫面上的 canvas**:那只會拿到「目前視口 × DPR」、還帶著相機狀態的畫面。正確做法是三步:算出所有圖形 `getBounds()` 的聯集 `(x0, y0)~(x1, y1)`(再留點邊);開一張 `(x1 − x0) × k` 寬、`(y1 − y0) × k` 高的離屏 canvas(`k` 是輸出倍率);`ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k)` 讓 x、y 軸各放大 `k` 倍、原點對到 bounds 左上,把 scene 重畫一次再 `toBlob`。這正是 11.3 讓 `draw()` 不依賴相機的回報,也是資料與渲染分離的又一個紅利。

**多人協作不是「把序列化資料丟上 WebSocket」**:至少還要 ① 全域唯一的 id(本章用時間 + 隨機,正式做法用 `crypto.randomUUID()`);② 衝突合併規則——Figma 公開的做法是伺服器仲裁、以「屬性」為單位的 last-writer-wins,也有團隊用 CRDT;③ z-order 改用分數索引(fractional index),陣列位置在並發插入時不穩定;④ **只撤銷自己的操作**——本章整份快照的 undo 一還原,就會把別人同時間的修改一起蓋掉,協作時得換成命令式(記錄每個操作的反向操作)。

---

## 11.11 結語:你造出了一台渲染引擎

回到第 00 章的承諾。我們說:**用 Canvas,就是親手把 DOM 免費送你的那台渲染引擎,一塊一塊自己造出來。** 現在回頭看你做的白板:

- 它有「物件」可以個別管理——你補上了 retained mode(第 08 章)。
- 它有事件:點得到、拖得動、滑到手把游標會變——你補上了命中測定(第 07 章)。
- 它在 Retina 螢幕上清晰、視窗一變就跟著重設——你補上了渲染迴圈與 HiDPI(第 01 章)。
- 它能平移縮放、座標換算精準——你補上了相機與變換(第 03 章)。
- 它能撤銷、能存檔、跑得順——你補上了歷史、序列化、效能架構(第 08、09 章)。

**這些,正是瀏覽器替 DOM 內建、卻不替 Canvas 內建的東西。你把它們一塊塊造了回來。** 這就是 Figma、Excalidraw、tldraw、Google Slides 畫布的底層——你現在不只看得懂它們,你能自己寫一個。

更重要的是,你帶走的不是 Canvas API,而是一套**可遷移的心智模型**:immediate vs retained、資料與渲染分離、世界與螢幕座標、命中測定、按需渲染、何時上 GPU。換到 WebGL、換到原生繪圖、換到任何「自己控制渲染」的系統,這套模型都成立。

> 🎓 **恭喜你完成這門課。** 從「一塊畫完即忘的像素布」,到「一台你親手打造的渲染引擎」。接下來,挑一個 11.10 的延伸挑戰,或去讀 Konva / Excalidraw 的原始碼——你會發現,你已經是同一個語言的人了。

---

## 全課地圖回顧

| 章 | 你補上了 DOM 免費送的哪塊 | Capstone 用在 |
|----|---------------------------|---------------|
| 00 | (心智模型:畫完即忘) | 全部 |
| 01 | 渲染迴圈、清晰度 | render loop、HiDPI |
| 02 | 畫筆狀態管理 | 每個 shape.draw |
| 03 | 座標系統 / 相機 | 平移縮放、座標換算 |
| 04 | 文字排版、圖片 | TextShape 量字、文字編輯 |
| 05 | 像素級控制 | (延伸)匯出、濾鏡 |
| 06 | 動畫、時間 | (延伸)過場、回彈 |
| 07 | 事件 / 命中測定 | 選取、拖曳、手把 |
| 08 | 物件模型、Undo、存檔 | scene、history、序列化 |
| 09 | 效能、重繪管理 | 分層、按需渲染 |
| 10 | (邊界:何時上 GPU) | 上萬物件的延伸路線 |
| 11 | (組裝成引擎) | ← 你在這 |
