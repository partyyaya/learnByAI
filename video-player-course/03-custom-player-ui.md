# 第 03 章：自定義播放器 UI 與互動

> **學習目標**：手刻一個產品級可商用的播放器 UI（含進度預覽、音量條、字幕、設定面板）。
> **預計時數**：150 分鐘
> **先備知識**：[[02-html5-media-api]]

---

## 1 為什麼要自定義 UI？

原生 `controls` 在三個地方滿足不了 production：

1. **品牌一致性**：UI 風格要跟產品設計系統一致
2. **跨平台一致性**：Chrome / Safari / Firefox 原生 UI 完全不同
3. **進階功能**：進度條預覽縮圖、彈幕、章節、設定面板……原生都做不到

---

## 2 UI 元件清單與優先級

一個完整播放器至少要這些：

| 元件 | 優先級 | 說明 |
|------|--------|------|
| 播放/暫停按鈕 | ★★★ | 中央大按鈕 + 控制列小按鈕 |
| 進度條 | ★★★ | 已播、緩衝、可拖曳、hover 預覽 |
| 時間顯示 | ★★★ | 當前 / 總長 |
| 音量條 | ★★ | 靜音切換 + 滑桿 |
| 全螢幕 | ★★★ | 雙擊影片也要進全螢幕 |
| 倍速 | ★★ | 0.5 / 1.0 / 1.25 / 1.5 / 2.0 |
| 解析度切換 | ★★ | 接 HLS 後才有意義 |
| 字幕切換 | ★ | |
| 畫中畫 | ★ | |
| 設定齒輪 | ★ | 收納倍速、字幕、解析度 |
| Loading 動畫 | ★★★ | `waiting` 時顯示 |
| 錯誤 UI | ★★★ | `error` 時顯示重試按鈕 |

---

## 3 樣式設計重點

### 3.1 控制列自動隱藏

```css
.player {
  position: relative;
  user-select: none;
}

.controls {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 12px 16px;
  background: linear-gradient(to top, rgba(0,0,0,.7), transparent);
  opacity: 1;
  transition: opacity .3s;
}

.player.idle .controls {
  opacity: 0;
}

.player.idle {
  cursor: none;
}
```

JS 配合：

```js
let idleTimer;
const player = document.querySelector('.player');

function showControls() {
  player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused) player.classList.add('idle');
  }, 3000);
}

player.addEventListener('mousemove', showControls);
player.addEventListener('touchstart', showControls);
video.addEventListener('pause', () => player.classList.remove('idle'));
```

### 3.2 使用 CSS variables 統一主題

```css
.player {
  --player-accent: #ff4444;
  --player-bg: rgba(0, 0, 0, .8);
  --player-text: #fff;
  --player-progress-height: 4px;
  --player-progress-hover-height: 8px;
}

.progress-played { background: var(--player-accent); }
```

換主題只要改 CSS variables，不必碰 JS。

---

## 4 進度條：產品級實作

進度條是播放器的靈魂，要做好五件事：
1. 顯示已播進度（紅色）
2. 顯示緩衝進度（灰色）
3. 滑鼠 hover 預覽時間
4. 滑鼠 hover 顯示縮圖（雪碧圖）
5. 拖曳 Seek

### 4.1 結構

```html
<div class="progress-container">
  <div class="progress-bar" id="progress">
    <div class="progress-buffered" id="buffered"></div>
    <div class="progress-played" id="played"></div>
    <div class="progress-hover" id="hover"></div>
    <div class="progress-thumb" id="thumb"></div>
  </div>
  <div class="tooltip" id="tooltip">
    <img id="thumbnail" />
    <div id="tooltip-time">00:00</div>
  </div>
</div>
```

### 4.2 CSS

```css
.progress-container { position: relative; padding: 8px 0; cursor: pointer; }
.progress-bar { position: relative; height: 4px; background: rgba(255,255,255,.2); transition: height .15s; }
.progress-container:hover .progress-bar { height: 8px; }

.progress-buffered, .progress-played, .progress-hover {
  position: absolute; left: 0; top: 0; bottom: 0;
  pointer-events: none;
}
.progress-buffered { background: rgba(255,255,255,.4); }
.progress-played   { background: var(--player-accent); }
.progress-hover    { background: rgba(255,255,255,.2); }

.progress-thumb {
  position: absolute;
  top: 50%; transform: translate(-50%, -50%);
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--player-accent);
  opacity: 0;
  transition: opacity .15s;
}
.progress-container:hover .progress-thumb { opacity: 1; }

.tooltip {
  position: absolute; bottom: 100%;
  padding: 4px;
  background: rgba(0,0,0,.9);
  color: #fff; font-size: 12px;
  pointer-events: none;
  display: none;
  transform: translateX(-50%);
}
.tooltip img { display: block; width: 160px; height: 90px; }
```

### 4.3 JS

```js
class ProgressBar {
  constructor(video, container) {
    this.video = video;
    this.container = container;
    this.bar = container.querySelector('.progress-bar');
    this.bufferedEl = container.querySelector('.progress-buffered');
    this.playedEl = container.querySelector('.progress-played');
    this.hoverEl = container.querySelector('.progress-hover');
    this.thumbEl = container.querySelector('.progress-thumb');
    this.tooltip = container.querySelector('.tooltip');
    this.tooltipTime = container.querySelector('#tooltip-time');
    this.thumbnail = container.querySelector('#thumbnail');

    this.dragging = false;
    this.bind();
  }

  bind() {
    this.video.addEventListener('timeupdate', () => this.updatePlayed());
    this.video.addEventListener('progress', () => this.updateBuffered());

    this.container.addEventListener('mousemove', (e) => this.onHover(e));
    this.container.addEventListener('mouseleave', () => {
      this.tooltip.style.display = 'none';
      this.hoverEl.style.width = '0';
    });

    this.container.addEventListener('mousedown', (e) => this.startDrag(e));
    window.addEventListener('mousemove', (e) => this.onDrag(e));
    window.addEventListener('mouseup', () => this.endDrag());
  }

  ratio(clientX) {
    const rect = this.bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  updatePlayed() {
    if (this.dragging) return;
    const pct = (this.video.currentTime / this.video.duration) * 100;
    this.playedEl.style.width = pct + '%';
    this.thumbEl.style.left = pct + '%';
  }

  updateBuffered() {
    const b = this.video.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    this.bufferedEl.style.width = (end / this.video.duration * 100) + '%';
  }

  onHover(e) {
    const r = this.ratio(e.clientX);
    const time = r * this.video.duration;

    this.hoverEl.style.width = (r * 100) + '%';

    this.tooltip.style.display = 'block';
    this.tooltip.style.left = (r * this.bar.offsetWidth) + 'px';
    this.tooltipTime.textContent = this.formatTime(time);

    // 縮圖預覽（如果有 sprite）
    this.updateThumbnail(time);
  }

  updateThumbnail(time) {
    // 假設縮圖雪碧圖：每秒一張，10x10 排列，每張 160x90
    if (!this.thumbnail.src) {
      this.thumbnail.src = '/thumbs/sprite.jpg';
    }
    const idx = Math.floor(time);
    const cols = 10, w = 160, h = 90;
    const x = (idx % cols) * w;
    const y = Math.floor(idx / cols) * h;
    this.thumbnail.style.objectPosition = `-${x}px -${y}px`;
  }

  startDrag(e) {
    this.dragging = true;
    this.onDrag(e);
  }
  onDrag(e) {
    if (!this.dragging) return;
    const r = this.ratio(e.clientX);
    this.video.currentTime = r * this.video.duration;
    this.playedEl.style.width = (r * 100) + '%';
    this.thumbEl.style.left = (r * 100) + '%';
  }
  endDrag() {
    this.dragging = false;
  }

  formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }
}
```

### 4.4 縮圖預覽：背後的雪碧圖怎麼來？

```bash
# 用 ffmpeg 每秒抓一張縮圖
ffmpeg -i input.mp4 -vf "fps=1,scale=160:90" thumbs/thumb_%04d.jpg

# 拼成 10x10 雪碧圖（用 montage 或 ffmpeg tile）
ffmpeg -i thumbs/thumb_%04d.jpg \
  -vf "tile=10x10" sprite.jpg
```

並產生一個 `.vtt` 檔讓播放器知道縮圖座標：

```vtt
WEBVTT

00:00:00.000 --> 00:00:01.000
sprite.jpg#xywh=0,0,160,90

00:00:01.000 --> 00:00:02.000
sprite.jpg#xywh=160,0,160,90
```

實務上會直接讀這個 VTT 算座標（這也是 video.js 的做法）。

---

## 5 音量條

```html
<div class="volume">
  <button id="mute">🔊</button>
  <div class="volume-slider" id="volSlider">
    <div class="volume-fill" id="volFill"></div>
  </div>
</div>
```

```css
.volume { display: flex; align-items: center; gap: 6px; }
.volume-slider {
  width: 0; overflow: hidden;
  height: 4px; background: rgba(255,255,255,.2);
  transition: width .2s;
}
.volume:hover .volume-slider { width: 80px; }
.volume-fill { height: 100%; background: #fff; }
```

```js
class VolumeControl {
  constructor(video, container) {
    this.video = video;
    this.muteBtn = container.querySelector('#mute');
    this.slider = container.querySelector('#volSlider');
    this.fill = container.querySelector('#volFill');

    this.lastVolume = video.volume;
    this.bind();
    this.render();
  }

  bind() {
    this.muteBtn.addEventListener('click', () => {
      if (this.video.muted || this.video.volume === 0) {
        this.video.muted = false;
        this.video.volume = this.lastVolume || 0.5;
      } else {
        this.lastVolume = this.video.volume;
        this.video.muted = true;
      }
    });

    this.slider.addEventListener('mousedown', (e) => this.startDrag(e));
    window.addEventListener('mousemove', (e) => this.onDrag(e));
    window.addEventListener('mouseup', () => this.dragging = false);

    this.video.addEventListener('volumechange', () => this.render());
  }

  startDrag(e) { this.dragging = true; this.onDrag(e); }
  onDrag(e) {
    if (!this.dragging) return;
    const rect = this.slider.getBoundingClientRect();
    const r = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this.video.muted = false;
    this.video.volume = r;
  }

  render() {
    const v = this.video.muted ? 0 : this.video.volume;
    this.fill.style.width = (v * 100) + '%';
    this.muteBtn.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
  }
}
```

---

## 6 設定面板（齒輪選單）

```html
<div class="settings">
  <button id="settingsBtn">⚙</button>
  <div class="settings-menu hidden" id="settingsMenu">
    <div class="settings-item" data-key="speed">
      倍速 <span id="speedLabel">1x</span>
    </div>
    <div class="settings-item" data-key="quality">
      畫質 <span id="qualityLabel">Auto</span>
    </div>
    <div class="settings-item" data-key="subtitle">
      字幕 <span id="subtitleLabel">關閉</span>
    </div>
  </div>
</div>
```

```js
class SettingsMenu {
  constructor(video, container) {
    this.video = video;
    this.menu = container.querySelector('#settingsMenu');
    this.btn = container.querySelector('#settingsBtn');

    this.btn.addEventListener('click', () => {
      this.menu.classList.toggle('hidden');
    });

    container.querySelector('[data-key="speed"]')
      .addEventListener('click', () => this.toggleSpeed());

    document.addEventListener('click', (e) => {
      if (!this.menu.contains(e.target) && e.target !== this.btn) {
        this.menu.classList.add('hidden');
      }
    });
  }

  toggleSpeed() {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(this.video.playbackRate);
    const next = speeds[(idx + 1) % speeds.length];
    this.video.playbackRate = next;
    document.getElementById('speedLabel').textContent = next + 'x';
  }
}
```

---

## 7 鍵盤快捷鍵

業界默契是這套（向 YouTube 看齊）：

| 按鍵 | 行為 |
|------|------|
| Space / K | 播放/暫停 |
| ← / → | 倒退 / 快轉 5 秒 |
| ↑ / ↓ | 音量 +/- 10% |
| J / L | 倒退 / 快轉 10 秒 |
| M | 靜音切換 |
| F | 全螢幕 |
| P | 畫中畫 |
| 0–9 | 跳到 0–90% |
| < / > | 慢速 / 快速 |
| C | 字幕切換 |

```js
function bindKeyboard(player, video) {
  player.addEventListener('keydown', (e) => {
    // 避免在 input 裡按按鍵也觸發
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    switch (e.key) {
      case ' ':
      case 'k':
        video.paused ? video.play() : video.pause();
        e.preventDefault();
        break;
      case 'ArrowLeft':  video.currentTime -= 5; break;
      case 'ArrowRight': video.currentTime += 5; break;
      case 'j': video.currentTime -= 10; break;
      case 'l': video.currentTime += 10; break;
      case 'ArrowUp':   video.volume = Math.min(1, video.volume + 0.1); break;
      case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.1); break;
      case 'm': video.muted = !video.muted; break;
      case 'f':
        document.fullscreenElement
          ? document.exitFullscreen()
          : player.requestFullscreen();
        break;
      case 'p':
        document.pictureInPictureElement
          ? document.exitPictureInPicture()
          : video.requestPictureInPicture();
        break;
    }

    // 數字鍵跳轉
    if (/^[0-9]$/.test(e.key)) {
      video.currentTime = video.duration * (+e.key) / 10;
    }
  });

  // 確保 player 可以聚焦
  player.tabIndex = 0;
}
```

> 記得讓容器 `tabIndex = 0` 才能接收鍵盤事件。

---

## 8 雙擊全螢幕、單擊播放/暫停

這兩個事件會打架，需要用 timer 區分：

```js
let clickTimer = null;

video.addEventListener('click', (e) => {
  if (clickTimer) return;  // 已經在等雙擊判定
  clickTimer = setTimeout(() => {
    video.paused ? video.play() : video.pause();
    clickTimer = null;
  }, 250);
});

video.addEventListener('dblclick', () => {
  clearTimeout(clickTimer);
  clickTimer = null;
  if (document.fullscreenElement) document.exitFullscreen();
  else video.parentElement.requestFullscreen();
});
```

---

## 9 Loading 與錯誤 UI

```html
<div class="overlay-loading" id="loading">
  <div class="spinner"></div>
</div>
<div class="overlay-error hidden" id="errorOverlay">
  <p id="errorMsg">播放失敗</p>
  <button id="retryBtn">重試</button>
</div>
```

```css
.spinner {
  width: 48px; height: 48px;
  border: 4px solid rgba(255,255,255,.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.overlay-loading, .overlay-error {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5);
}
```

```js
video.addEventListener('waiting', () => loading.classList.remove('hidden'));
video.addEventListener('playing', () => loading.classList.add('hidden'));
video.addEventListener('canplay', () => loading.classList.add('hidden'));

video.addEventListener('error', () => {
  const errs = {
    1: '播放已中止',
    2: '網路錯誤',
    3: '解碼失敗',
    4: '找不到可播放的來源',
  };
  document.getElementById('errorMsg').textContent =
    errs[video.error?.code] || '未知錯誤';
  document.getElementById('errorOverlay').classList.remove('hidden');
});

document.getElementById('retryBtn').addEventListener('click', () => {
  document.getElementById('errorOverlay').classList.add('hidden');
  video.load();
  video.play();
});
```

---

## 10 無障礙（A11y）

容易被忽略但 production 一定要：

```html
<button aria-label="播放" id="playBtn">▶</button>

<div role="slider"
     aria-label="播放進度"
     aria-valuemin="0"
     aria-valuemax="100"
     aria-valuenow="35"
     tabindex="0">
</div>
```

```js
// 進度條 ARIA 同步
v.addEventListener('timeupdate', () => {
  const pct = Math.round(v.currentTime / v.duration * 100);
  progress.setAttribute('aria-valuenow', pct);
});

// 按鈕狀態
v.addEventListener('play',  () => playBtn.setAttribute('aria-label', '暫停'));
v.addEventListener('pause', () => playBtn.setAttribute('aria-label', '播放'));
```

---

## 11 響應式：手機與桌面

```css
/* 桌面：橫向控制列 */
.controls { flex-direction: row; }

/* 手機：放大觸控目標 */
@media (pointer: coarse) {
  button { width: 44px; height: 44px; }      /* 蘋果建議最小 44x44 */
  .progress-bar { height: 8px; }
  .progress-container:hover .progress-bar { height: 12px; }
}

@media (max-width: 480px) {
  .volume { display: none; }   /* 手機沒人用音量滑桿 */
  .settings-menu { font-size: 16px; }
}
```

行動裝置額外注意：

```js
// iOS 必須有使用者點擊才能播放
// 不要在 page load 就 .play()，會被擋

// iOS 不要全螢幕
video.setAttribute('playsinline', '');
video.setAttribute('webkit-playsinline', '');

// 點兩下放大手勢處理
container.addEventListener('touchend', handleDoubleTap);
```

---

## 12 整合範例：把所有零件組起來

```js
class CustomPlayer {
  constructor(container, src) {
    this.container = container;
    this.video = container.querySelector('video');
    this.video.src = src;

    this.progress = new ProgressBar(this.video, container.querySelector('.progress-container'));
    this.volume   = new VolumeControl(this.video, container.querySelector('.volume'));
    this.settings = new SettingsMenu(this.video, container);

    bindKeyboard(container, this.video);
    this.bindAutoHide();
    this.bindOverlays();
  }

  bindAutoHide() { /* 見第 3.1 節 */ }
  bindOverlays() { /* 見第 9 節 */ }
}

// 使用
const player = new CustomPlayer(
  document.querySelector('.player'),
  'https://stream.mux.com/.../medium.mp4'
);
```

---

## 13 業界 OSS 對照

學到這裡可以打開以下原始碼讀，會發現你的設計跟它們很像：

| 函式庫 | 重點看什麼 |
|--------|------------|
| [video.js](https://github.com/videojs/video.js) | Component 階層、外掛系統 |
| [Plyr](https://github.com/sampotts/plyr) | 純 ESM、無依賴 |
| [Vidstack](https://github.com/vidstack/player) | 現代 Web Components 設計 |
| [Shaka Player UI](https://github.com/shaka-project/shaka-player) | Google 出品，A11y 與多語系一流 |

---

## 14 本章重點回顧

- 自定義 UI 的痛點在**進度條 + 設定面板 + 自動隱藏**，其他都是裝飾。
- 用 class 拆元件（ProgressBar、VolumeControl、SettingsMenu），不要全寫在一個函式。
- 鍵盤快捷鍵抄 YouTube 那套，使用者學習成本最低。
- A11y 與行動裝置不是 nice-to-have，是 production 標配。

---

## 15 課後練習

1. 把本章的進度條改為**雙縮圖預覽**：左邊縮圖、右邊章節標題。
2. 實作一個「A-B 循環」按鈕：選定起點與終點，循環播放這段。
3. 加入「片頭跳過」按鈕：5 秒後出現，10 秒內可點，點了 currentTime 跳到指定位置。

---

**上一章**：[[02-html5-media-api]] ｜ **下一章**：[04-player-state-machine-and-plugins.md](./04-player-state-machine-and-plugins.md)
