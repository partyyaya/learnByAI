'use strict';
/*
 * mini-figma 白板 —— 第 11 章 Capstone 的完整可運行實作。
 * 用到的章節:場景圖(08)、相機與座標(03)、命中與拖曳(07)、
 *            分層渲染 + 按需渲染(01/09)、快照式 Undo/Redo + 序列化(08)。
 * 這支檔案刻意不依賴任何庫,全部原生 Canvas API。
 */
(function () {
  // ─────────────────────────── 工具函式 ───────────────────────────
  // 時間 + 隨機:重新整理、載入舊檔後也不會跟既有 id 撞號(正式協作用 crypto.randomUUID())
  function uid() { return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // 專門量字的離屏 context:量測不借用畫面上的 context,也不在 draw() 裡做
  const measureCtx = document.createElement('canvas').getContext('2d');

  // ─────────────────────────── 圖形模型(第 08 章) ───────────────────────────
  class Shape {
    constructor(props) {
      Object.assign(this, { id: uid(), x: 0, y: 0, w: 100, h: 80, fill: '#cfe3ff' }, props);
    }
    getBounds() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
    containsPoint(p) {
      return p.x >= this.x && p.x <= this.x + this.w &&
             p.y >= this.y && p.y <= this.y + this.h;
    }
    draw(ctx) {}
    // 序列化只輸出資料欄位(白名單),暫態狀態不會混進存檔
    toJSON() {
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
      ctx.lineWidth = 1;   // 描邊是圖形內容:世界單位,跟著相機縮放(和 Figma 一樣);選取框才是要抵消縮放的 UI
      ctx.fillRect(this.x, this.y, this.w, this.h);
      ctx.strokeRect(this.x, this.y, this.w, this.h);
    }
  }

  class CircleShape extends Shape {
    static type = 'circle';
    draw(ctx) {
      ctx.fillStyle = this.fill;
      ctx.beginPath();
      ctx.ellipse(this.x + this.w / 2, this.y + this.h / 2, this.w / 2, this.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    containsPoint(p) {
      const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
      const dx = (p.x - cx) / (this.w / 2 || 1), dy = (p.y - cy) / (this.h / 2 || 1);
      return dx * dx + dy * dy <= 1;
    }
  }

  class TextShape extends Shape {
    static type = 'text';
    constructor(props) { super({ text: '雙擊編輯', fontSize: 24, fill: '#222', ...props }); this.layout(); }
    // 第 04 章:量測更新包圍盒。只在 text / fontSize 改變時呼叫(建構、編輯完成),
    // draw() 只讀不寫 —— 否則快照記到的 w/h 會和畫面上的不一致
    layout() {
      measureCtx.font = this.fontSize + 'px sans-serif';
      this.w = measureCtx.measureText(this.text).width;
      this.h = this.fontSize * 1.2;
    }
    draw(ctx) {
      ctx.fillStyle = this.fill;
      ctx.font = this.fontSize + 'px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(this.text, this.x, this.y);
    }
  }

  const REGISTRY = { rect: RectShape, circle: CircleShape, text: TextShape };

  // ─────────────────────────── 狀態 ───────────────────────────
  const scene = [];
  const camera = { x: 0, y: 0, zoom: 1 };
  let tool = 'select';                    // 'select' | 'rect' | 'circle' | 'text'
  let selected = null;
  let editing = null;                     // 正在雙擊編輯的 TextShape(此時改用 DOM input 顯示)
  let endTextEdit = null;                 // 編輯中 = 收尾函式;相機要動之前先呼叫它
  let mode = 'idle';                      // idle | creating | dragging | resizing | panning
  let activePointer = null;               // 目前手勢的 pointerId(第 07 章 7.8:一次只認一根指標)
  let dragOffset = null, resizeAnchor = null, creating = null, createOrigin = null, panStart = null;
  let contentDirty = true, overlayDirty = true;

  const invalidate = () => { contentDirty = true; overlayDirty = true; };
  const invalidateOverlay = () => { overlayDirty = true; };

  // ─────────────────────────── DOM 與畫布(第 01 章) ───────────────────────────
  const content = document.getElementById('content');
  const overlay = document.getElementById('overlay');
  const stage = document.getElementById('stage');   // 定位參考:文字編輯的 DOM input 疊在這裡面
  const canvas = overlay;                 // 事件綁在最上層
  const contentCtx = content.getContext('2d');
  const overlayCtx = overlay.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  // 第 01 章 1.4:緩衝區 = CSS 尺寸 × DPR(取整);視窗大小或 DPR 一變就重設
  function resize() {
    W = window.innerWidth; H = window.innerHeight; dpr = window.devicePixelRatio || 1;
    for (const c of [content, overlay]) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      c.style.width = W + 'px'; c.style.height = H + 'px';
    }
    invalidate();                         // 重設 width 會清空畫布:兩層都要重畫
  }
  function watchDpr() {                   // 拖到另一個螢幕、瀏覽器縮放:DPR 變了就重設,並用新值重新註冊
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
  }
  resize(); watchDpr();
  window.addEventListener('resize', resize);

  // ─────────────────────────── 相機與座標(第 03 章) ───────────────────────────
  function applyCamera(ctx) {
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
  }
  function screenToWorld(sx, sy) {
    return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
  }
  function worldToScreen(wx, wy) {   // screenToWorld 的反運算:世界座標 → 螢幕像素
    return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
  }
  function eventToWorld(e) {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  // 滾輪以游標為中心縮放(第 03.7 章的四步);事件在下方互動區跟 pointer 事件一起綁
  function onWheel(e) {
    e.preventDefault();                                        // 攔下頁面捲動與瀏覽器縮放
    if (e.deltaY === 0) return;                                // 純水平捲動(Shift+滾輪、觸控板橫滑)不縮放
    if (endTextEdit) endTextEdit(true);                        // 編輯框是螢幕座標的 DOM,相機一動就對不上:先收尾
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);                      // 1. 縮放前,游標指著的世界座標
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;   // deltaMode 1 = 以「行」為單位,約略換成像素
    const factor = Math.exp(-dy * 0.002);                      // 連續倍率:觸控板的小 delta 只縮一點,滑鼠一格約 ×1.2
    camera.zoom = Math.max(0.1, Math.min(camera.zoom * factor, 20));   // 2. 縮放(限制範圍)
    const after = screenToWorld(sx, sy);                       // 3. 同一個螢幕點,現在指著的世界座標
    camera.x += before.x - after.x; camera.y += before.y - after.y;   // 4. 把差值補回去,焦點回到游標下
    invalidate();                                             // 不直接呼叫 render():它會自己排下一幀
  }

  // ─────────────────────────── 選取框與手把(第 07 章) ───────────────────────────
  const HANDLE = 8;   // 手把螢幕邊長(px)
  const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
                          n: 'ns-resize', s: 'ns-resize', w_: 'ew-resize', e: 'ew-resize' };
  function getHandles(shape) {
    const { x, y, w, h } = shape.getBounds();
    return {
      nw: { x, y },          n: { x: x + w / 2, y },      ne: { x: x + w, y },
      w_: { x, y: y + h / 2 },                            e: { x: x + w, y: y + h / 2 },
      sw: { x, y: y + h },   s: { x: x + w / 2, y: y + h }, se: { x: x + w, y: y + h },
    };
  }
  function drawSelection(ctx, shape) {
    const b = shape.getBounds();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1 / camera.zoom;      // 選取框是 UI:抵消縮放,永遠 1px
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    if (shape instanceof TextShape) return;   // 文字大小由 fontSize 決定,不給框縮放手把,只留外框可拖曳移動
    const r = HANDLE / camera.zoom / 2;
    ctx.fillStyle = '#fff';
    for (const p of Object.values(getHandles(shape))) {
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
    }
  }

  // ─────────────────────────── 命中測定(第 07 章) ───────────────────────────
  function hitHandle(shape, wp) {
    if (shape instanceof TextShape) return null;          // 文字不做框縮放
    // 圖形在螢幕上太小時,8 個手把會蓋滿本體:這時點在本體內一律算拖曳,手把只能從外圍抓
    if (Math.min(shape.w, shape.h) * camera.zoom < HANDLE * 3 && shape.containsPoint(wp)) return null;
    const r = HANDLE / camera.zoom;                        // 命中容差比畫出來的手把大一圈,好抓
    for (const [name, p] of Object.entries(getHandles(shape))) {
      if (Math.abs(wp.x - p.x) <= r && Math.abs(wp.y - p.y) <= r) return name;
    }
    return null;
  }
  function hitShape(wp) {
    for (let i = scene.length - 1; i >= 0; i--) {   // 反向 → 取最上層
      if (scene[i].containsPoint(wp)) return scene[i];
    }
    return null;
  }
  function applyResize(s, wp) {
    const a = resizeAnchor;
    const px = wp.x - a.gx, py = wp.y - a.gy;   // 扣掉按下時「游標離手把中心」的偏移,邊才不會一動就跳
    // 以「固定對邊」為錨點重算 bounds;用 min/abs 自然支援拖過對邊時的翻轉
    if (a.ax !== null) { s.x = Math.min(a.ax, px); s.w = Math.max(1, Math.abs(px - a.ax)); }
    else { s.x = a.ox; s.w = a.ow; }
    if (a.ay !== null) { s.y = Math.min(a.ay, py); s.h = Math.max(1, Math.abs(py - a.ay)); }
    else { s.y = a.oy; s.h = a.oh; }
  }

  // ─────────────────────────── 歷史:present 基準的快照式 Undo/Redo(第 08 章) ───────────────────────────
  const history = {
    past: [], future: [], present: '[]',
    snapshot() { return JSON.stringify(scene.map(s => s.toJSON())); },
    init() { this.present = this.snapshot(); },
    commit() {
      const now = this.snapshot();
      if (now === this.present) return;     // 沒變化不記錄
      this.past.push(this.present);
      this.present = now;
      this.future = [];
    },
    restore(json) {
      const keepId = selected && selected.id;   // 還原會重建所有物件:選取改用 id 找回
      scene.length = 0;                     // 就地清空,維持同一個陣列參考
      for (const d of JSON.parse(json)) scene.push(new REGISTRY[d.type](d));
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

  // ─────────────────────────── 渲染:分層 + 按需(第 01/09 章) ───────────────────────────
  function render() {
    if (contentDirty) {
      contentCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      contentCtx.clearRect(0, 0, W, H);
      contentCtx.save(); applyCamera(contentCtx);
      for (const s of scene) { if (s === editing) continue; s.draw(contentCtx); }   // 編輯中的文字改由 DOM input 顯示
      contentCtx.restore();
      contentDirty = false;
    }
    if (overlayDirty) {
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayCtx.clearRect(0, 0, W, H);
      overlayCtx.save(); applyCamera(overlayCtx);
      if (creating) creating.draw(overlayCtx);
      if (selected && selected !== editing) drawSelection(overlayCtx, selected);   // 編輯中的文字不畫選取框(input 自帶外框)
      overlayCtx.restore();
      overlayDirty = false;
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // ─────────────────────────── 互動狀態機(第 07 章) ───────────────────────────
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || activePointer !== null) return;   // 第 07 章 7.8:只認主鍵、第二根手指不插隊
    if (endTextEdit) endTextEdit(true);                      // 點到畫布 = 先把文字編輯收尾
    activePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const wp = eventToWorld(e);

    if (tool === 'select') {
      const handle = selected && hitHandle(selected, wp);
      if (handle) {
        mode = 'resizing';
        const b = selected.getBounds();          // 記下「固定不動的對邊」當錨點 → 支援翻轉
        const hp = getHandles(selected)[handle];
        resizeAnchor = {
          ax: handle.includes('w') ? b.x + b.w : (handle.includes('e') ? b.x : null),
          ay: handle.includes('n') ? b.y + b.h : (handle.includes('s') ? b.y : null),
          ox: b.x, ow: b.w, oy: b.y, oh: b.h,
          gx: wp.x - hp.x, gy: wp.y - hp.y,      // 抓的位置離手把中心多遠(同 dragOffset 的道理)
        };
        return;
      }
      const hit = hitShape(wp);
      if (hit) {
        selected = hit; mode = 'dragging';
        dragOffset = { x: wp.x - hit.x, y: wp.y - hit.y };
      } else {
        selected = null; mode = 'panning';
        panStart = { x: e.clientX, y: e.clientY };
      }
      invalidate();
    } else if (tool === 'text') {
      // 文字:點擊即放置(寬高由 layout() 量測決定,不適合用拖曳框)
      const t = new TextShape({ x: wp.x, y: wp.y });
      scene.push(t); selected = t; history.commit();
      tool = 'select'; syncToolbar(); invalidate();
    } else {
      mode = 'creating';
      const Cls = REGISTRY[tool];
      createOrigin = { x: wp.x, y: wp.y };
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
        applyResize(selected, wp);
        invalidate(); break;
      case 'creating': {
        const o = createOrigin;
        creating.x = Math.min(o.x, wp.x);
        creating.y = Math.min(o.y, wp.y);
        creating.w = Math.abs(wp.x - o.x);
        creating.h = Math.abs(wp.y - o.y);
        invalidateOverlay(); break;
      }
      case 'panning':
        camera.x -= (e.clientX - panStart.x) / camera.zoom;
        camera.y -= (e.clientY - panStart.y) / camera.zoom;
        panStart = { x: e.clientX, y: e.clientY };
        invalidate(); break;
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerId !== activePointer) return;
    // 「太小就當誤點」的門檻是螢幕上的 2px:世界寬高乘回 zoom 再比,放大縮小時手感才一致
    if (mode === 'creating' && creating.w * camera.zoom > 2 && creating.h * camera.zoom > 2) {
      scene.push(creating);
      selected = creating;
      history.commit();
      tool = 'select'; syncToolbar();   // 畫完自動切回選取(Figma 行為)
    }
    if (mode === 'dragging' || mode === 'resizing') history.commit();
    endGesture();
  });

  // 系統手勢、手掌誤觸等讓瀏覽器取消這根指標:放棄這次手勢,回到最後提交的狀態
  canvas.addEventListener('pointercancel', (e) => { if (e.pointerId === activePointer) cancelGesture(); });
  canvas.addEventListener('wheel', onWheel, { passive: false });   // passive:false 才能 preventDefault

  function cancelGesture() {
    if (mode === 'dragging' || mode === 'resizing') history.restore(history.present);
    endGesture();
  }
  function endGesture() { creating = createOrigin = null; mode = 'idle'; activePointer = null; invalidate(); }

  // hover 回饋(第 07 章):滑到手把 → 對應方向的縮放游標,滑到圖形 → move
  function updateCursor(e) {
    const wp = eventToWorld(e), h = tool === 'select' && selected && hitHandle(selected, wp);
    const c = tool !== 'select' ? 'crosshair' : h ? HANDLE_CURSOR[h] : hitShape(wp) ? 'move' : 'default';
    if (canvas.style.cursor !== c) canvas.style.cursor = c;   // 沒變就不寫,免得每次 move 都動 style
  }

  // ─────────────────────────── 文字雙擊編輯:疊一個 DOM input 在世界座標上(第 03 座標換算 + 第 04 文字) ───────────────────────────
  canvas.addEventListener('dblclick', (e) => {
    if (tool !== 'select') return;
    const hit = hitShape(eventToWorld(e));
    if (hit instanceof TextShape) { selected = hit; startTextEdit(hit); }
  });

  function startTextEdit(shape) {
    editing = shape;
    invalidate();                                     // 讓 canvas 這格文字先別畫,改由 input 顯示

    const fs = shape.fontSize * camera.zoom;          // 螢幕上的字級(隨相機縮放)
    const p = worldToScreen(shape.x, shape.y);        // 螢幕座標(相對 #stage 左上,恰好等於視窗左上)
    const input = document.createElement('input');
    input.type = 'text';
    input.value = shape.text;
    input.style.cssText =
      'position:absolute;margin:0;padding:0 1px;border:0;' +
      'outline:1px solid #3b82f6;background:rgba(255,255,255,.92);' +
      'left:' + p.x + 'px;top:' + p.y + 'px;' +
      'font:' + fs + 'px sans-serif;line-height:1.2;height:' + (fs * 1.2) + 'px;' +
      'color:' + shape.fill + ';';
    stage.appendChild(input);

    const fitWidth = () => {                           // 隨輸入內容變寬(measureText,第 04 章)
      measureCtx.font = fs + 'px sans-serif';
      input.style.width = (measureCtx.measureText(input.value).width + 4) + 'px';
    };
    fitWidth();
    input.addEventListener('input', fitWidth);

    function finish(commit) {
      if (editing !== shape) return;                  // 已結束過(例如 Escape 後 remove 又觸發 blur)就不重複
      editing = null; endTextEdit = null;
      if (commit) {
        const v = input.value.trim();
        if (v) { shape.text = v; shape.layout(); }    // 文字變了 → 重新量包圍盒
        else {                                        // 清空 = 刪除這個文字,選取一起清(別指著已刪的物件)
          const i = scene.indexOf(shape);
          if (i >= 0) scene.splice(i, 1);
          if (selected === shape) selected = null;
        }
        history.commit();                             // 進 Undo/Redo(第 08 章)
      }
      input.remove();
      invalidate();
    }
    endTextEdit = finish;

    input.addEventListener('blur', () => finish(true));         // 點別處 = 完成並存檔
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                                     // 別讓全域快捷鍵處理這次按鍵
      if (ev.isComposing || ev.keyCode === 229) return;         // 注音/拼音選字中的 Enter、Esc 是給輸入法的
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }          // Enter = 完成
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }   // Esc = 取消(不寫回)
    });

    input.focus();
    input.select();
  }

  // ─────────────────────────── 鍵盤:Undo/Redo/Delete/方向鍵(第 08 章) ───────────────────────────
  // 焦點在輸入框 / 正在組字(IME)時不攔截,打字時才不會誤刪圖形、誤觸 undo
  function isTyping(e) {
    const t = e.target;
    return e.isComposing || !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
  }
  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  window.addEventListener('keydown', (e) => {
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
  window.addEventListener('keyup', (e) => { if (!isTyping(e) && NUDGE[e.key]) history.commit(); });

  // ─────────────────────────── 工具列與存檔 ───────────────────────────
  function syncToolbar() {
    const btns = document.querySelectorAll('[data-tool]');
    btns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  }
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => { tool = btn.dataset.tool; selected = null; invalidate(); syncToolbar(); });
  });
  // 存檔格式帶版本號(和第 08 章一致):日後格式改了,載入時才認得出舊檔、做遷移
  const saveBtn = document.getElementById('saveBtn');
  const loadBtn = document.getElementById('loadBtn');
  if (saveBtn) saveBtn.addEventListener('click', () =>
    localStorage.setItem('board', JSON.stringify({ version: 1, shapes: scene.map(s => s.toJSON()) })));
  if (loadBtn) loadBtn.addEventListener('click', () => {
    const data = JSON.parse(localStorage.getItem('board') || 'null');
    if (!data || data.version !== 1) return;     // 沒存過或不認得的格式
    selected = null; history.restore(JSON.stringify(data.shapes));
    history.present = history.snapshot(); history.past = []; history.future = [];   // 載入 = 新的初始狀態
  });

  // ─────────────────────────── 給 DevTools console 觀察用 ───────────────────────────
  window.__wbDebug = {
    scene, camera, history,
    getSelected: () => selected,
    setTool: (t) => { tool = t; syncToolbar(); },
  };
})();
