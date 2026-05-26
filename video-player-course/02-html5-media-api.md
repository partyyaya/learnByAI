# 第 02 章：HTML5 Media API 全面解析

> **學習目標**：熟悉 `<video>` / `<audio>` 所有重要屬性、方法、事件，能徒手操控原生播放器。
> **預計時數**：120 分鐘
> **先備知識**：[[01-video-codec-and-container-basics]]

---

## 1 為什麼要從原生 API 開始？

無論你用什麼播放器函式庫（video.js、Plyr、hls.js……），底層都還是包著一個 `<video>` 元素。
**搞不懂原生 API，永遠是在用魔法。**

---

## 2 `<video>` 標籤的所有屬性

```html
<video
  src="video.mp4"
  poster="cover.jpg"
  controls
  autoplay
  muted
  loop
  playsinline
  preload="metadata"
  crossorigin="anonymous"
  width="640"
  height="360"
  disablepictureinpicture
  disableremoteplayback
>
  <source src="video.mp4" type="video/mp4; codecs=avc1.42E01E,mp4a.40.2">
  <source src="video.webm" type="video/webm; codecs=vp9,opus">
  <track kind="subtitles" src="zh.vtt" srclang="zh" label="中文" default>
</video>
```

### 重要屬性逐一解讀

| 屬性 | 說明 | 常見坑 |
|------|------|--------|
| `src` | 影片來源 | 動態切換 src 必須呼叫 `load()` |
| `poster` | 載入前的封面圖 | iOS 上 autoplay 時不顯示 |
| `controls` | 顯示原生控制列 | 自定義 UI 時要拿掉 |
| `autoplay` | 自動播放 | **必須搭配 `muted` 否則被擋** |
| `muted` | 靜音 | 自動播放唯一通行證 |
| `playsinline` | iOS 不要全螢幕 | **手機網頁播放器一定要加** |
| `preload` | `none` / `metadata` / `auto` | 列表頁建議 `none` 省頻寬 |
| `crossorigin` | CORS 模式 | 要用 Canvas 截圖、字幕跨域必加 |
| `disablepictureinpicture` | 禁用畫中畫 | 部分平台禁畫中畫法律考量 |

### `preload` 三種行為

```text
preload="none"      → 完全不下載，使用者點才下載
preload="metadata"  → 只下載 metadata（時長、解析度），約幾 KB
preload="auto"      → 瀏覽器自行決定，通常會下載前幾秒
```

> 在影片列表頁（多個 `<video>`）一定要用 `none` 或 `metadata`，否則同時下載會塞爆頻寬。

---

## 3 `<source>` 的 codecs 字串

這個冷知識但超重要：

```html
<source src="video.mp4" type='video/mp4; codecs="avc1.42E01E,mp4a.40.2"'>
```

| codec 字串 | 含義 |
|-----------|------|
| `avc1.42E01E` | H.264 Baseline @ Level 3.0 |
| `avc1.4D401F` | H.264 Main @ Level 3.1 |
| `avc1.640028` | H.264 High @ Level 4.0 |
| `hvc1.1.6.L93.B0` | H.265 |
| `vp09.00.10.08` | VP9 |
| `av01.0.05M.08` | AV1 |
| `mp4a.40.2` | AAC-LC |
| `opus` | Opus |

### 用 `canPlayType` 偵測支援度

```js
const video = document.createElement('video');

// 回傳值：'' (不支援) / 'maybe' / 'probably'
console.log(video.canPlayType('video/mp4; codecs="avc1.42E01E"'));
// → "probably"

console.log(video.canPlayType('video/webm; codecs="vp9,opus"'));
// → "probably" (Chrome) / "" (Safari)

console.log(video.canPlayType('application/vnd.apple.mpegurl'));
// → "probably" (Safari) / "" (Chrome)
```

新的 API（更精確）：

```js
const config = {
  type: 'media-source',
  video: {
    contentType: 'video/mp4; codecs="avc1.42E01E"',
    width: 1920,
    height: 1080,
    bitrate: 5000000,
    framerate: 30,
  },
};

const result = await navigator.mediaCapabilities.decodingInfo(config);
console.log(result);
// {
//   supported: true,
//   smooth: true,      ← 可流暢解碼
//   powerEfficient: true ← 硬體加速
// }
```

> 列表頁載入前先 `decodingInfo` 一次，決定要餵 H.265 還是 H.264。

---

## 4 MediaElement 的所有屬性

寫個範例打開 DevTools 慢慢看：

```js
const v = document.querySelector('video');

// ─── 來源 ───
v.src;                  // 字串：當前來源
v.currentSrc;           // 字串：實際使用的 source（如有多個 source）

// ─── 時間 ───
v.currentTime;          // 當前播放位置（秒），可寫入做 Seek
v.duration;             // 總時長，未載入前是 NaN
v.played;               // TimeRanges：已播過的區段
v.buffered;             // TimeRanges：已緩衝的區段
v.seekable;             // TimeRanges：可 Seek 的區段

// ─── 狀態 ───
v.paused;               // 是否暫停
v.ended;                // 是否播完
v.seeking;              // 是否正在 Seek
v.readyState;           // 0~4，見下表
v.networkState;         // 0~3
v.error;                // MediaError 物件（null 表沒錯）

// ─── 播放控制 ───
v.playbackRate;         // 倍速，0.5/1.0/1.25/2.0
v.defaultPlaybackRate;
v.volume;               // 0~1
v.muted;
v.loop;
v.autoplay;

// ─── 影片尺寸 ───
v.videoWidth;           // 原生寬（loadedmetadata 後才有值）
v.videoHeight;
```

### `readyState` 五個階段

| 值 | 名稱 | 意義 |
|----|------|------|
| 0 | HAVE_NOTHING | 啥都沒，連 metadata 都沒 |
| 1 | HAVE_METADATA | 知道時長、解析度 |
| 2 | HAVE_CURRENT_DATA | 當前幀可顯示 |
| 3 | HAVE_FUTURE_DATA | 可以順暢播一小段 |
| 4 | HAVE_ENOUGH_DATA | 可以一路播到底 |

### `networkState`

| 值 | 名稱 | 意義 |
|----|------|------|
| 0 | NETWORK_EMPTY | 沒設 src |
| 1 | NETWORK_IDLE | 暫時不需要網路 |
| 2 | NETWORK_LOADING | 正在下載 |
| 3 | NETWORK_NO_SOURCE | 找不到可用 source |

---

## 5 所有重要事件（必背！）

事件數量很多，但分組記就好。

### 5.1 載入階段

```js
v.addEventListener('loadstart',     () => console.log('開始下載'));
v.addEventListener('durationchange',() => console.log('時長已知:', v.duration));
v.addEventListener('loadedmetadata',() => console.log('metadata 就緒'));
v.addEventListener('loadeddata',    () => console.log('第一幀就緒'));
v.addEventListener('canplay',       () => console.log('可以播了'));
v.addEventListener('canplaythrough',() => console.log('可一路播完'));
```

順序固定：`loadstart → durationchange → loadedmetadata → loadeddata → canplay → canplaythrough`

### 5.2 播放控制

```js
v.addEventListener('play',     () => console.log('被呼叫 play'));
v.addEventListener('playing',  () => console.log('真的開始播了'));
v.addEventListener('pause',    () => console.log('暫停'));
v.addEventListener('ended',    () => console.log('播完了'));
v.addEventListener('seeking',  () => console.log('正在 seek'));
v.addEventListener('seeked',   () => console.log('seek 完成'));
v.addEventListener('ratechange', () => console.log('倍速改變:', v.playbackRate));
v.addEventListener('volumechange', () => console.log('音量改變'));
```

> 注意：`play` ≠ `playing`，前者是「使用者按了播放」，後者是「真的有畫面在動」。**統計播放開始時間要用 `playing`**。

### 5.3 進度與緩衝

```js
v.addEventListener('timeupdate', () => {
  // 大約每 250ms 觸發一次
  console.log('當前:', v.currentTime);
});

v.addEventListener('progress', () => {
  // 緩衝進度更新
  if (v.buffered.length > 0) {
    const end = v.buffered.end(v.buffered.length - 1);
    console.log('已緩衝到:', end, '秒');
  }
});

v.addEventListener('waiting', () => console.log('緩衝不夠，卡頓中'));
v.addEventListener('stalled', () => console.log('網路斷了，下載中止'));
```

> **`waiting` 是計算「卡頓率」最重要的事件**，務必埋點上報。

### 5.4 錯誤處理

```js
v.addEventListener('error', () => {
  const err = v.error;
  console.error('code:', err.code, 'message:', err.message);
});
```

| code | 常數 | 意義 |
|------|------|------|
| 1 | MEDIA_ERR_ABORTED | 使用者中止 |
| 2 | MEDIA_ERR_NETWORK | 網路下載失敗 |
| 3 | MEDIA_ERR_DECODE | 解碼失敗（檔案壞了） |
| 4 | MEDIA_ERR_SRC_NOT_SUPPORTED | 編碼不支援或 404 |

---

## 6 TimeRanges 物件詳解

`buffered`、`played`、`seekable` 都是 `TimeRanges`，這個 API 設計得很反直覺：

```js
const ranges = v.buffered;
console.log(ranges.length);        // 區段數量，例如 2

for (let i = 0; i < ranges.length; i++) {
  console.log(`區段 ${i}: ${ranges.start(i)} ~ ${ranges.end(i)}`);
}
// 區段 0: 0 ~ 15.5     ← 開頭緩衝了 15.5 秒
// 區段 1: 60 ~ 75.2    ← 使用者 seek 到 60 秒後緩衝了 15 秒
```

### 工具函式：計算當前緩衝率

```js
function getBufferAhead(video) {
  const buffered = video.buffered;
  const current = video.currentTime;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= current && current <= buffered.end(i)) {
      return buffered.end(i) - current;
    }
  }
  return 0;
}

console.log('還能順播', getBufferAhead(v), '秒');
```

---

## 7 自動播放策略（瀏覽器之痛）

各家瀏覽器規則：

```text
Chrome / Safari / Firefox 自動播放規則：
  1. 影片必須 muted        → OK
  2. 或使用者已經與頁面互動過 → OK
  3. 否則 play() 會 reject
```

正確處理方式：

```js
async function tryAutoplay(video) {
  try {
    await video.play();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      // 自動播放被擋，降級為靜音播放
      video.muted = true;
      await video.play();
      // 顯示一個「點擊解除靜音」的按鈕
      showUnmuteButton();
    } else {
      console.error('其他錯誤:', err);
    }
  }
}
```

> `video.play()` 在現代瀏覽器**回傳 Promise**，務必 await 或 catch。

---

## 8 動態切換來源

```js
function switchSource(video, newSrc) {
  const currentTime = video.currentTime;
  const wasPlaying = !video.paused;

  video.src = newSrc;
  video.load();          // ← 必須！否則不會載新檔

  video.addEventListener('loadedmetadata', () => {
    video.currentTime = currentTime;  // 還原進度
    if (wasPlaying) video.play();
  }, { once: true });
}
```

這也是「切換解析度」的最土法做法，正式方案要用 MSE（第 07 章）。

---

## 9 字幕：WebVTT 與 TextTrack API

### WebVTT 格式

```vtt
WEBVTT

00:00:00.000 --> 00:00:03.000
歡迎來到影音播放器課程

00:00:03.500 --> 00:00:07.000 line:90%
這行字會顯示在畫面下方 90%

00:00:07.500 --> 00:00:10.000
<v Gary>這是 Gary 說的話</v>
```

### 在 HTML 引入

```html
<video controls>
  <source src="movie.mp4" type="video/mp4">
  <track kind="subtitles" src="zh.vtt" srclang="zh" label="中文" default>
  <track kind="subtitles" src="en.vtt" srclang="en" label="English">
  <track kind="captions" src="en-cc.vtt" srclang="en" label="English CC">
</video>
```

### 程式化操作 TextTrack

```js
const video = document.querySelector('video');

// 列出所有字幕軌
for (const track of video.textTracks) {
  console.log(track.label, track.language, track.mode);
}

// 切換顯示哪條字幕
video.textTracks[0].mode = 'showing';  // 顯示
video.textTracks[1].mode = 'hidden';   // 隱藏但可程式讀取
video.textTracks[2].mode = 'disabled'; // 完全不載入

// 監聽當前 cue 變化（做自定義字幕渲染）
const track = video.textTracks[0];
track.mode = 'hidden';  // 不讓瀏覽器原生渲染
track.addEventListener('cuechange', () => {
  for (const cue of track.activeCues) {
    document.getElementById('my-subtitle').textContent = cue.text;
  }
});
```

> **跨域字幕需要 `crossorigin="anonymous"` + 伺服器 CORS header**，否則 cues 永遠是空的。

---

## 10 全螢幕與畫中畫 API

### 全螢幕

```js
async function toggleFullscreen(video) {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await video.requestFullscreen();
    // iOS Safari 要用 webkitEnterFullscreen()
    if (!document.fullscreenEnabled && video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  }
}

document.addEventListener('fullscreenchange', () => {
  console.log('全螢幕狀態:', !!document.fullscreenElement);
});
```

### 畫中畫 (Picture-in-Picture)

```js
async function togglePiP(video) {
  if (!document.pictureInPictureEnabled) return;

  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
  } else {
    await video.requestPictureInPicture();
  }
}

video.addEventListener('enterpictureinpicture', () => {
  console.log('進入畫中畫');
});
video.addEventListener('leavepictureinpicture', () => {
  console.log('離開畫中畫');
});
```

---

## 11 實戰：手刻最小可用播放器

把這檔存成 `mini-player.html`：

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Mini Player</title>
<style>
  .player { position: relative; width: 640px; background: #000; font-family: sans-serif; }
  video { width: 100%; display: block; }
  .controls { display: flex; align-items: center; gap: 8px; padding: 8px;
              background: rgba(0,0,0,.7); color: #fff; }
  .progress { flex: 1; height: 6px; background: #444; cursor: pointer; position: relative; }
  .progress-buffered { position: absolute; left: 0; top: 0; height: 100%; background: #888; }
  .progress-played   { position: absolute; left: 0; top: 0; height: 100%; background: #f00; }
  button { background: none; border: 0; color: #fff; cursor: pointer; font-size: 20px; }
  .time { font-size: 13px; min-width: 90px; }
</style></head>
<body>

<div class="player">
  <video id="video" muted
    src="https://stream.mux.com/VZtzUzGRv02OhRnZCxcNg49OilvolTqdnFLEqBsTwaxU/medium.mp4">
  </video>
  <div class="controls">
    <button id="play">▶</button>
    <div class="progress" id="progress">
      <div class="progress-buffered" id="buffered"></div>
      <div class="progress-played" id="played"></div>
    </div>
    <span class="time" id="time">00:00 / 00:00</span>
    <button id="mute">🔊</button>
    <button id="fs">⛶</button>
  </div>
</div>

<script>
const v       = document.getElementById('video');
const playBtn = document.getElementById('play');
const muteBtn = document.getElementById('mute');
const fsBtn   = document.getElementById('fs');
const prog    = document.getElementById('progress');
const buf     = document.getElementById('buffered');
const played  = document.getElementById('played');
const timeEl  = document.getElementById('time');

const fmt = (s) => {
  if (!isFinite(s)) return '00:00';
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
};

// 播放 / 暫停
playBtn.addEventListener('click', () => v.paused ? v.play() : v.pause());
v.addEventListener('play',  () => playBtn.textContent = '⏸');
v.addEventListener('pause', () => playBtn.textContent = '▶');

// 靜音
muteBtn.addEventListener('click', () => {
  v.muted = !v.muted;
  muteBtn.textContent = v.muted ? '🔇' : '🔊';
});

// 全螢幕
fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else v.parentElement.requestFullscreen();
});

// 進度條
v.addEventListener('timeupdate', () => {
  played.style.width = (v.currentTime / v.duration * 100) + '%';
  timeEl.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
});

v.addEventListener('progress', () => {
  if (v.buffered.length > 0) {
    const end = v.buffered.end(v.buffered.length - 1);
    buf.style.width = (end / v.duration * 100) + '%';
  }
});

// 點擊進度條 Seek
prog.addEventListener('click', (e) => {
  const rect = prog.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  v.currentTime = ratio * v.duration;
});

// 卡頓監測
let waitingStart = 0;
v.addEventListener('waiting', () => {
  waitingStart = performance.now();
  console.warn('卡頓開始');
});
v.addEventListener('playing', () => {
  if (waitingStart) {
    console.log('卡頓時長', performance.now() - waitingStart, 'ms');
    waitingStart = 0;
  }
});
</script>
</body>
</html>
```

把它存檔開瀏覽器，你應該得到：
- 一個可播放/暫停的影片
- 紅色進度條 + 灰色緩衝進度
- 點進度條可以 Seek
- 卡頓時 console 會顯示卡頓時長

這就是後續章節**自定義播放器**的雛形。

---

## 12 本章重點回顧

- `<video>` 屬性多，但 `muted` + `playsinline` + `preload="metadata"` 是行動裝置三神器。
- `readyState` / `networkState` 是 debug 神器。
- **`waiting` 事件 = 卡頓統計入口**，QoS 監控必埋。
- `play()` 是 Promise，必須 catch `NotAllowedError`。
- `TimeRanges` 反人類，但學會後可以精細控制緩衝策略。

---

## 13 課後練習

1. 把上面的 mini-player 加上「倍速切換」與「音量條」。
2. 監聽 `waiting` 與 `playing`，計算 30 秒內的「卡頓率 = 卡頓總時長 / 播放總時長」。
3. 用 `mediaCapabilities.decodingInfo` 寫一個函式，判斷瀏覽器能不能流暢播 4K H.265。

---

**上一章**：[[01-video-codec-and-container-basics]] ｜ **下一章**：[03-custom-player-ui.md](./03-custom-player-ui.md)
