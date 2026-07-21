/* ────────────────────────────────────────────────────────────────
   Canvas 課 · 章節即時測試場(共用引擎)
   每個章節的 HTML 只要設定 window.CH = { chapter, title, md, W, H, note, presets }
   presets: [{ id, label, code }]
   code 執行時可用的變數(環境契約):
     ctx, canvas, W, H,
     requestAnimationFrame / cancelAnimationFrame(已託管,重跑會自動停掉舊迴圈),
     sampleImage(≈220×150 彩色場景離屏 canvas,可當 drawImage 來源、可 getImageData),
     pixelArt(16×16 方塊像素離屏 canvas)
   ──────────────────────────────────────────────────────────────── */
(function () {
  const CH = window.CH || {};
  let W = CH.W || 360, H = CH.H || 240;   // 每次執行時依「畫布區」實際大小重算(見 computeSize)
  const LS_KEY = 'canvas-demo-' + (CH.chapter || 'x');

  // ── 建立離屏素材 ──────────────────────────────────────────────
  function makeSampleImage() {
    const c = document.createElement('canvas'); c.width = 220; c.height = 150;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 220, 150);
    grad.addColorStop(0, '#6a11cb'); grad.addColorStop(1, '#2575fc');
    g.fillStyle = grad; g.fillRect(0, 0, 220, 150);
    g.fillStyle = '#ffd166'; g.beginPath(); g.arc(172, 44, 26, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a9d8f'; g.beginPath();
    g.moveTo(0, 150); g.quadraticCurveTo(110, 78, 220, 150); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.95)'; g.font = 'bold 24px system-ui, sans-serif';
    g.fillText('SAMPLE', 20, 120);
    return c;
  }
  function makePixelArt() {
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const g = c.getContext('2d');
    const A = '#1d3557', B = '#e63946', C = '#f1faee', Y = '#ffd166';
    const rows = [
      '................', '.....YYYYYY.....', '...YYYYYYYYYY...', '..YYYYYYYYYYYY..',
      '..YYBBYYYYBBYY..', '..YYBBYYYYBBYY..', '..YYYYYYYYYYYY..', '..YYYYYYYYYYYY..',
      '..YYBYYYYYYBYY..', '..YYBBBBBBBBYY..', '..YYYBBBBBBYYY..', '..YYYYYYYYYYYY..',
      '...YYYYYYYYYY...', '.....YYYYYY.....', '................', '................',
    ];
    const map = { Y: Y, B: A, R: B, C: C };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const ch = rows[y][x]; if (ch === '.') continue;
      g.fillStyle = map[ch] || C; g.fillRect(x, y, 1, 1);
    }
    return c;
  }
  const sampleImage = makeSampleImage();
  const pixelArt = makePixelArt();

  // ── 託管動畫:世代守衛,重跑時自動失效舊迴圈 ──────────────────
  let gen = 0;
  function stopAnim() { gen++; }
  function makeRAF() {
    return function (cb) {
      const g = gen;
      return window.requestAnimationFrame(function (t) { if (g === gen) cb(t); });
    };
  }
  const managedCAF = function (id) { return window.cancelAnimationFrame(id); };

  // ── 建立頁面 ─────────────────────────────────────────────────
  const chLabel = (CH.chapter ? '第 ' + CH.chapter + ' 章 · ' : '') + (CH.title || '') + ' · 即時測試場';
  document.title = chLabel;

  const root = document.createElement('div');
  root.className = 'app';   // 直向 flex 容器,讓 main 能撐滿到螢幕最底(見 playground.css .app)
  root.innerHTML = `
    <header>
      <h1>🎨 ${escapeHtml(chLabel)}</h1>
      <span class="sub">選範例 → 改程式碼 → 執行看結果。
        ${CH.md ? `<a href="${CH.md}">閱讀本章</a> · ` : ''}<a href="./index.html">← 所有章節 demo</a></span>
    </header>
    <main>
      <section class="pane">
        <div class="pane-head">
          <span class="pane-title">程式碼</span>
          <select id="preset" title="選擇本章範例"></select>
          <button id="resetCode" title="還原成這個範例的原始程式碼">重設範例</button>
          <button id="run" class="primary">▶ 執行</button>
        </div>
        <textarea id="editor" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
        <div class="kbd-hint">
          可用:<span class="kbd">ctx</span> <span class="kbd">canvas</span> <span class="kbd">W</span> <span class="kbd">H</span>
          <span class="kbd">requestAnimationFrame</span> <span class="kbd">sampleImage</span> <span class="kbd">pixelArt</span>　·
          <span class="kbd">Ctrl/⌘ + Enter</span> 執行　·　<span class="kbd">Tab</span> 縮排
        </div>
        <div id="error"></div>
      </section>
      <section class="pane">
        <div class="pane-head">
          <span class="pane-title">畫布(<span id="dims"></span>,邏輯座標 1:1)</span>
          <label class="chk"><input type="checkbox" id="autoRun" checked> 邊改邊執行</label>
          <label class="chk"><input type="checkbox" id="autoClear" checked> 執行前清空</label>
          <label class="chk"><input type="checkbox" id="gridChk"> 像素格線</label>
        </div>
        <div class="stage"><canvas id="cv"></canvas></div>
        <p class="note" id="note"></p>
      </section>
    </main>`;
  document.body.appendChild(root);

  // ── DOM 參照 ─────────────────────────────────────────────────
  const editor = byId('editor'), presetSel = byId('preset'), errBox = byId('error');
  const autoRun = byId('autoRun'), autoClear = byId('autoClear'), gridChk = byId('gridChk');
  let canvasEl = byId('cv');
  byId('dims').textContent = W + '×' + H;
  byId('note').innerHTML = CH.note ||
    '<b>提示:</b>動畫/互動範例直接照書上寫 <code>requestAnimationFrame</code>、<code>canvas.addEventListener</code> 即可;重新執行會自動停掉舊迴圈、清掉舊監聽器。';

  const presets = CH.presets || [];
  presets.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = p.label; presetSel.appendChild(o);
  });

  // 依「畫布區(.stage)」實際大小算出這次的邏輯尺寸:寬佔 80%、高佔 60%。
  // 保持 backing store == CSS 尺寸(1:1),互動範例的 getBoundingClientRect 座標才對得上、畫面也不會被拉糊。
  function computeSize() {
    const stage = (canvasEl && canvasEl.parentNode) || document.querySelector('.stage');
    if (stage && stage.clientWidth > 0 && stage.clientHeight > 0) {
      const cs = getComputedStyle(stage);
      const availW = stage.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const availH = stage.clientHeight - parseFloat(cs.paddingTop)  - parseFloat(cs.paddingBottom);
      W = Math.max(240, Math.round(availW * 0.8));
      H = Math.max(180, Math.round(availH * 0.6));
    } else {
      W = CH.W || 360; H = CH.H || 240;   // 量不到就退回章節預設
    }
    byId('dims').textContent = W + '×' + H;
  }

  function freshCanvas() {
    stopAnim();
    const fresh = document.createElement('canvas');
    fresh.id = 'cv';
    fresh.width = W; fresh.height = H;
    fresh.style.width = W + 'px'; fresh.style.height = H + 'px';
    if (gridChk.checked) fresh.classList.add('grid');
    canvasEl.replaceWith(fresh);
    canvasEl = fresh;
    return fresh;
  }

  function showError(msg) { errBox.textContent = '⚠ ' + msg; errBox.classList.add('show'); }
  function clearError() { errBox.textContent = ''; errBox.classList.remove('show'); }

  // 有些範例(例如各章「動手作業」)會自己注入工具列/輸入框、或掛 window/document 監聽器。
  // 重跑或切換範例前先清乾淨:移除標了 .demo-inject 的節點,並呼叫範例登記的 window.__demoCleanup。
  function cleanupInjected() {
    if (window.__demoCleanup) { try { window.__demoCleanup(); } catch (e) {} window.__demoCleanup = null; }
    document.querySelectorAll('.demo-inject').forEach(el => el.remove());
  }

  function run() {
    clearError();
    cleanupInjected();
    // 清空 = 依畫布區大小換一張全新的 canvas(順便丟掉上一次加的事件監聽器);不清空 = 沿用同一張,可疊畫
    let cv;
    if (autoClear.checked) { computeSize(); cv = freshCanvas(); }
    else { stopAnim(); cv = canvasEl; }
    const ctx = cv.getContext('2d');
    try {
      const fn = new Function(
        'ctx', 'canvas', 'W', 'H', 'requestAnimationFrame', 'cancelAnimationFrame', 'sampleImage', 'pixelArt',
        editor.value
      );
      fn(ctx, cv, W, H, makeRAF(), managedCAF, sampleImage, pixelArt);
    } catch (e) { showError(e.message); }
  }

  function loadPreset(i) {
    const p = presets[i]; if (!p) return;
    editor.value = p.code; save(); run();
  }
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ i: presetSel.value, code: editor.value })); } catch (e) {}
  }

  // ── 事件 ─────────────────────────────────────────────────────
  presetSel.addEventListener('change', () => loadPreset(+presetSel.value));
  byId('run').addEventListener('click', run);
  byId('resetCode').addEventListener('click', () => loadPreset(+presetSel.value));
  gridChk.addEventListener('change', () => canvasEl.classList.toggle('grid', gridChk.checked));

  // 視窗大小變動 → 依新畫布區重算尺寸並重跑(debounce 避免拖曳時狂觸發)
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(run, 250); });

  let debounce;
  editor.addEventListener('input', () => {
    save();
    if (!autoRun.checked) return;
    clearTimeout(debounce); debounce = setTimeout(run, 400);
  });
  editor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editor.selectionStart, en = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
      editor.selectionStart = editor.selectionEnd = s + 2;
    }
  });

  // ── 初始化 ───────────────────────────────────────────────────
  (function init() {
    let restored = false;
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved && typeof saved.code === 'string') {
        const idx = Number(saved.i);
        presetSel.value = (idx >= 0 && idx < presets.length) ? idx : 0;
        editor.value = saved.code; restored = true;
      }
    } catch (e) {}
    if (!restored && presets.length) { presetSel.value = 0; editor.value = presets[0].code; }
    run();
  })();

  // ── utils ────────────────────────────────────────────────────
  function byId(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
