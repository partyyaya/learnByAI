'use strict';
/*
 * mini-figma 白板 —— 第 11 章 Capstone 的完整可運行實作。
 * 用到的章節:場景圖(08)、相機與座標(03)、命中與拖曳(07)、
 *            分層渲染 + 按需渲染(01/09)、快照式 Undo/Redo + 序列化(08)。
 * 這支檔案刻意不依賴任何庫,全部原生 Canvas API。
 */
(function () {
  // ─────────────────────────── 工具函式 ───────────────────────────
  let _idCounter = 0;
  function uid() { return 'id-' + (++_idCounter); }

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
    // 序列化只輸出資料欄位(白名單),不含 id 以外的暫態欄位
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
      ctx.lineWidth = 1 / camera.zoom;
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
    constructor(props) { super(Object.assign({ text: '雙擊編輯', fontSize: 24, fill: '#222', w: 120, h: 28 }, props)); }
    draw(ctx) {
      ctx.fillStyle = this.fill;
      ctx.font = this.fontSize + 'px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(this.text, this.x, this.y);
      this.w = ctx.measureText(this.text).width;   // 第 04 章:量測更新包圍盒
      this.h = this.fontSize * 1.2;
    }
  }

  const REGISTRY = { rect: RectShape, circle: CircleShape, text: TextShape };

  // ─────────────────────────── DOM 與畫布(第 01 章) ───────────────────────────
  const W = window.innerWidth, H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const content = document.getElementById('content');
  const overlay = document.getElementById('overlay');
  const stage = document.getElementById('stage');   // 定位參考:文字編輯的 DOM input 疊在這裡面
  const canvas = overlay;                 // 事件綁在最上層
  const contentCtx = content.getContext('2d');
  const overlayCtx = overlay.getContext('2d');

  function setup(c) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    c.style.width = W + 'px';
    c.style.height = H + 'px';
  }
  setup(content);
  setup(overlay);

  // ─────────────────────────── 狀態 ───────────────────────────
  const scene = [];
  const camera = { x: 0, y: 0, zoom: 1 };
  let tool = 'select';                    // 'select' | 'rect' | 'circle' | 'text'
  let selected = null;
  let editing = null;                     // 正在雙擊編輯的 TextShape(此時改用 DOM input 顯示)
  let mode = 'idle';                      // idle | creating | dragging | resizing | panning
  let dragOffset = null, resizeHandle = null, resizeAnchor = null, creating = null, createOrigin = null, panStart = null;
  let contentDirty = true, overlayDirty = true;

  const invalidate = () => { contentDirty = true; overlayDirty = true; };
  const invalidateOverlay = () => { overlayDirty = true; };

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

  // ─────────────────────────── 選取框與手把(第 07 章) ───────────────────────────
  const HANDLE = 8;   // 螢幕像素
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
    ctx.lineWidth = 1 / camera.zoom;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    if (shape instanceof TextShape) return;   // 文字大小由 fontSize 決定,不給框縮放手把(否則手把蓋滿小字、一拖就變 resize),只留外框可拖曳移動
    const r = HANDLE / camera.zoom / 2;
    ctx.fillStyle = '#fff';
    for (const p of Object.values(getHandles(shape))) {
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
    }
  }

  // ─────────────────────────── 命中測定(第 07 章) ───────────────────────────
  function hitHandle(shape, wp) {
    const r = HANDLE / camera.zoom;
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
    // 以「固定對邊」為錨點重算 bounds;用 min/abs 自然支援拖過對邊時的翻轉
    if (a.ax !== null) { s.x = Math.min(a.ax, wp.x); s.w = Math.max(4, Math.abs(wp.x - a.ax)); }
    else { s.x = a.ox; s.w = a.ow; }
    if (a.ay !== null) { s.y = Math.min(a.ay, wp.y); s.h = Math.max(4, Math.abs(wp.y - a.ay)); }
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
      scene.length = 0;                     // 就地清空,維持同一個陣列參考
      for (const d of JSON.parse(json)) scene.push(new REGISTRY[d.type](d));
      selected = null;
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
    const wp = eventToWorld(e);
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);

    if (tool === 'select') {
      if (selected && !(selected instanceof TextShape)) {   // 文字不做框縮放,直接當可拖曳物件處理
        const handle = hitHandle(selected, wp);
        if (handle) {
          mode = 'resizing'; resizeHandle = handle;
          const b = selected.getBounds();          // 記下「固定不動的對邊」當錨點 → 支援翻轉
          resizeAnchor = {
            ax: handle.includes('w') ? b.x + b.w : (handle.includes('e') ? b.x : null),
            ay: handle.includes('n') ? b.y + b.h : (handle.includes('s') ? b.y : null),
            ox: b.x, ow: b.w, oy: b.y, oh: b.h,
          };
          return;
        }
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
      // 文字:點擊即放置(寬高由 measureText 在 draw 時決定,不適合用拖曳框)
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
    if (canvas.releasePointerCapture) canvas.releasePointerCapture(e.pointerId);
    if (mode === 'creating' && creating && creating.w > 2 && creating.h > 2) {
      scene.push(creating);
      selected = creating;
      history.commit();
      tool = 'select'; syncToolbar();   // 畫完自動切回選取(Figma 行為)
    }
    if (mode === 'dragging' || mode === 'resizing') history.commit();
    creating = null; createOrigin = null; mode = 'idle';
    invalidate();
  });

  // 滾輪以游標為中心縮放(第 03.7 章)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const before = screenToWorld(screen.x, screen.y);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    camera.zoom = Math.max(0.1, Math.min(camera.zoom * factor, 20));
    const after = screenToWorld(screen.x, screen.y);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    invalidate();
  }, { passive: false });

  // ─────────────────────────── 文字雙擊編輯:疊一個 DOM input 在世界座標上(第 03 座標換算 + 第 04 文字) ───────────────────────────
  canvas.addEventListener('dblclick', (e) => {
    if (tool !== 'select') return;
    const hit = hitShape(eventToWorld(e));
    if (hit instanceof TextShape) { selected = hit; invalidate(); startTextEdit(hit); }
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
      contentCtx.font = fs + 'px sans-serif';
      input.style.width = (contentCtx.measureText(input.value).width + 4) + 'px';
    };
    fitWidth();
    input.addEventListener('input', fitWidth);

    function finish(commit) {
      if (editing !== shape) return;                  // 已結束過(例如 Escape 先跑了)就不重複
      editing = null;
      if (commit) {
        const v = input.value.trim();
        if (v === '') {                               // 清空 = 視為刪除這個文字
          const i = scene.indexOf(shape);
          if (i >= 0) scene.splice(i, 1);
          if (selected === shape) selected = null;
        } else {
          shape.text = v;
        }
        history.commit();                             // 進 Undo/Redo(第 08 章)
      }
      input.remove();
      invalidate();
    }

    input.addEventListener('blur', () => finish(true));         // 點別處 = 完成並存檔
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                                     // 別讓全域快捷鍵處理這次按鍵
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }                                   // Enter = 完成
      else if (ev.key === 'Escape') { ev.preventDefault(); editing = null; input.remove(); invalidate(); }   // Esc = 取消(不寫回)
    });

    input.focus();
    input.select();
  }

  // ─────────────────────────── 鍵盤:Undo/Redo/Delete(第 08 章) ───────────────────────────
  window.addEventListener('keydown', (e) => {
    // 焦點在輸入框 / 正在組字(IME)時不攔截,避免日後文字編輯延伸功能誤觸刪除/復原
    const t = e.target;
    if (e.isComposing || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); }
    else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); history.redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      scene.splice(scene.indexOf(selected), 1);
      selected = null;
      history.commit();
      invalidate();
    }
  });

  // ─────────────────────────── 工具列與存檔 ───────────────────────────
  function syncToolbar() {
    const btns = document.querySelectorAll('[data-tool]');
    btns.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  }
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => { tool = btn.dataset.tool; selected = null; invalidate(); syncToolbar(); });
  });
  const saveBtn = document.getElementById('saveBtn');
  const loadBtn = document.getElementById('loadBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => localStorage.setItem('board', history.snapshot()));
  if (loadBtn) loadBtn.addEventListener('click', () => {
    const j = localStorage.getItem('board');
    if (j) { history.restore(j); history.present = j; history.past = []; history.future = []; }
  });

  // ─────────────────────────── 測試掛鉤(瀏覽器中無害) ───────────────────────────
  window.__wbDebug = {
    scene, camera, history, REGISTRY,
    setTool: (t) => { tool = t; },
    getTool: () => tool,
    getSelected: () => selected,
    fireDown: (h) => canvas.__fire('pointerdown', h),
    fireMove: (h) => canvas.__fire('pointermove', h),
    fireUp: (h) => canvas.__fire('pointerup', h),
  };
})();
