# 第 12 章：效能優化與 QoS 監控

> **學習目標**：能定義並量測影音體驗的所有關鍵指標，會優化秒開、降低卡頓、做跨端適配。
> **預計時數**：120 分鐘
> **先備知識**：[[02-html5-media-api]]、[[06-hls-protocol-deep-dive]]

---

## 1 影音的核心 QoS / QoE 指標

| 指標 | 定義 | 業界水準 |
|------|------|----------|
| **首幀時間 (Time To First Frame)** | 從點擊播放到第一幀畫面顯示 | < 1s 為佳 |
| **首次緩衝時間 (TTFB - Time To First Buffer)** | 開始接收第一個 byte 的時間 | < 300ms |
| **起播失敗率** | 點擊後完全沒能播放的比例 | < 0.5% |
| **卡頓率 (Buffering Ratio)** | 卡頓總時長 / 播放總時長 | < 1% |
| **卡頓次數 (Stall Count / 分鐘)** | 平均每分鐘卡幾次 | < 0.2 |
| **平均碼率 (Average Bitrate)** | 觀看時的實際碼率 | 越接近頂格越好 |
| **解析度切換次數** | 30 分鐘內 ABR 切換次數 | < 3 |
| **掉幀率 (Dropped Frame Rate)** | 解碼/渲染掉的幀比例 | < 1% |
| **平均直播延遲** | 直播專屬：端到端延遲 | 看協定 |

> QoS = Quality of Service（技術指標）
> QoE = Quality of Experience（使用者感受，含主觀打分）

---

## 2 量測：首幀時間

```js
class FirstFrameTimer {
  constructor(video) {
    this.video = video;
    this.startAt = 0;
    this.firstFrameAt = 0;
  }

  start() {
    this.startAt = performance.now();
    // 監聽多個事件，取最早觸發的
    const events = ['loadeddata', 'playing'];
    const onFirstFrame = () => {
      if (!this.firstFrameAt) {
        this.firstFrameAt = performance.now();
        const ttff = this.firstFrameAt - this.startAt;
        console.log('首幀時間', ttff.toFixed(0), 'ms');
        events.forEach(e => this.video.removeEventListener(e, onFirstFrame));
      }
    };
    events.forEach(e => this.video.addEventListener(e, onFirstFrame));
  }
}

const timer = new FirstFrameTimer(video);
timer.start();
video.src = '...';
video.play();
```

更精準的版本：用 `requestVideoFrameCallback`：

```js
video.requestVideoFrameCallback((now, metadata) => {
  console.log('真正畫到螢幕的時間', metadata.presentationTime);
  console.log('幀號', metadata.presentedFrames);
});
```

這個 API 才是真正「畫面顯示在使用者眼前」的時間，準確度比 `playing` 事件高很多。

---

## 3 量測：卡頓率

```js
class StallMonitor {
  constructor(video) {
    this.video = video;
    this.totalPlayMs = 0;
    this.totalStallMs = 0;
    this.stallCount = 0;
    this.stallStart = 0;
    this.lastPlayingAt = 0;
    this.bind();
  }

  bind() {
    this.video.addEventListener('playing', () => {
      this.lastPlayingAt = performance.now();
      if (this.stallStart) {
        this.totalStallMs += performance.now() - this.stallStart;
        this.stallStart = 0;
      }
    });

    this.video.addEventListener('waiting', () => {
      if (this.lastPlayingAt) {
        this.totalPlayMs += performance.now() - this.lastPlayingAt;
      }
      this.stallStart = performance.now();
      this.stallCount++;
    });

    this.video.addEventListener('pause', () => {
      if (this.lastPlayingAt) {
        this.totalPlayMs += performance.now() - this.lastPlayingAt;
        this.lastPlayingAt = 0;
      }
    });
  }

  getStats() {
    const total = this.totalPlayMs + this.totalStallMs;
    return {
      stallCount: this.stallCount,
      stallTotalMs: this.totalStallMs,
      playTotalMs: this.totalPlayMs,
      stallRatio: total > 0 ? this.totalStallMs / total : 0,
    };
  }
}
```

---

## 4 量測：掉幀

`HTMLMediaElement` 沒提供標準掉幀數，但 Chrome / Firefox 都有自家屬性：

```js
function getDroppedFrames(video) {
  // Chrome / Edge
  if ('getVideoPlaybackQuality' in video) {
    const q = video.getVideoPlaybackQuality();
    return {
      total: q.totalVideoFrames,
      dropped: q.droppedVideoFrames,
      corrupted: q.corruptedVideoFrames,
    };
  }
  // Safari
  if ('webkitDecodedFrameCount' in video) {
    return {
      total: video.webkitDecodedFrameCount,
      dropped: video.webkitDroppedFrameCount,
    };
  }
  return null;
}

setInterval(() => console.log(getDroppedFrames(video)), 5000);
```

---

## 5 秒開優化（首幀時間 < 1s）

### 5.1 服務端優化

```text
A. CDN 邊緣節點
   - 預熱熱門內容
   - HTTP/2、HTTP/3
B. 影片優化
   - MP4 用 -movflags +faststart
   - 第一段切片時長 ≤ 2s（HLS）
   - 第一段 I-frame 在前 100ms 內
C. 起播低碼率
   - 第一段切 240p，後台再升軌
```

### 5.2 Client 端優化

```js
// preconnect 提前建立連線
const link = document.createElement('link');
link.rel = 'preconnect';
link.href = 'https://cdn.example.com';
document.head.appendChild(link);

// 使用者 hover 時就 preload
playButton.addEventListener('mouseenter', () => {
  video.preload = 'auto';
});

// HLS 起播指定低碼率
const hls = new Hls({
  startLevel: 0,           // 從最低碼率開始
  abrEwmaDefaultEstimate: 500_000,
});

// HLS 預載片段數
hls.config.maxStarvationDelay = 4;
hls.config.maxLoadingDelay = 4;
```

### 5.3 用 `preload="metadata"` 提前準備

列表頁先 `preload="metadata"` 拿到 codec 與時長，使用者點才開始下載真正內容。

---

## 6 降低卡頓

### 6.1 緩衝策略

```js
// hls.js 配置
const hls = new Hls({
  maxBufferLength: 30,          // 期望緩衝 30 秒
  maxMaxBufferLength: 60,       // 最多 60 秒
  maxBufferSize: 60 * 1000 * 1000,  // 60MB
  maxBufferHole: 0.5,           // 跳過 0.5s 內的小空洞
});
```

### 6.2 預載下一個影片（短影音場景）

YouTube Shorts、TikTok 都會預載下一個：

```js
function preloadNextVideo(nextUrl) {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.src = nextUrl;
  video.muted = true;
  // 不要 append 到 DOM，瀏覽器仍會下載
  // 等使用者真的滑到下一個，把 src 賦值給主 video
}
```

### 6.3 ABR 調優

降低門檻、減少切換：

```js
new Hls({
  abrEwmaFastLive: 3.0,          // 直播：快速 EWMA 半衰期 3 秒
  abrEwmaSlowLive: 9.0,
  abrBandWidthFactor: 0.95,       // 估到頻寬 1Mbps，視為 950kbps（保守）
  abrBandWidthUpFactor: 0.7,      // 升軌更謹慎
});
```

---

## 7 跨端適配

### 7.1 iOS Safari 特殊處理

```js
const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isiOSSafari = isiOS && !window.MSStream;

if (isiOSSafari) {
  // 必須有 playsinline
  video.setAttribute('playsinline', '');

  // MSE 不支援，用原生 HLS
  if (src.endsWith('.m3u8')) {
    video.src = src;
  }

  // autoplay 必須 muted
  video.muted = true;

  // 沒有原生 PiP，要用 webkitSetPresentationMode
  if (video.webkitSetPresentationMode) {
    video.webkitSetPresentationMode('picture-in-picture');
  }
}
```

### 7.2 Android WebView

```js
const isAndroidWebView = /Android.*Version\/[\d.]+(?:.*Chrome|$)/.test(navigator.userAgent);

if (isAndroidWebView) {
  // 部分舊版 WebView 不支援 MSE
  if (!window.MediaSource) {
    // Fallback 到 progressive MP4
  }

  // 部分 WebView autoplay 完全被擋
  showPlayButtonOverlay();
}
```

### 7.3 低階裝置降級

```js
function detectLowEndDevice() {
  // 記憶體 < 2GB
  if (navigator.deviceMemory && navigator.deviceMemory < 2) return true;
  // CPU < 4 核
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) return true;
  return false;
}

if (detectLowEndDevice()) {
  // 鎖定 480p
  hls.autoLevelCapping = levelIndexFor480p;
}
```

---

## 8 完整 QoS 上報外掛

接到第 04 章的 PlayerCore：

```js
function qosPlugin(player, options = {}) {
  const session = {
    sessionId: crypto.randomUUID(),
    startAt: Date.now(),
    src: '',
    firstFrameMs: null,
    loadStartAt: null,

    playMs: 0,
    stallMs: 0,
    stallCount: 0,
    seekCount: 0,
    levelSwitchCount: 0,

    droppedFrames: 0,
    totalFrames: 0,

    errors: [],
    levels: [],
  };

  let lastPlayingAt = 0;
  let stallStart = 0;

  player.on('loadstart', () => {
    session.loadStartAt = performance.now();
    session.src = player.video.src;
  });

  player.video.requestVideoFrameCallback?.(() => {
    if (!session.firstFrameMs) {
      session.firstFrameMs = performance.now() - session.loadStartAt;
    }
  });

  player.on('playing', () => {
    lastPlayingAt = performance.now();
    if (stallStart) {
      session.stallMs += performance.now() - stallStart;
      stallStart = 0;
    }
  });

  player.on('waiting', () => {
    if (lastPlayingAt) session.playMs += performance.now() - lastPlayingAt;
    stallStart = performance.now();
    session.stallCount++;
  });

  player.on('seeking', () => session.seekCount++);
  player.on('error', () => {
    session.errors.push({
      code: player.video.error?.code,
      ts: Date.now(),
    });
  });

  // 解析度切換（接 hls 事件）
  options.hls?.on('hlsLevelSwitched', () => session.levelSwitchCount++);

  // 每 30 秒上報一次
  const timer = setInterval(() => {
    const q = player.video.getVideoPlaybackQuality?.();
    if (q) {
      session.droppedFrames = q.droppedVideoFrames;
      session.totalFrames = q.totalVideoFrames;
    }
    send({ type: 'heartbeat', ...session });
  }, 30_000);

  // 離開頁面時上報
  window.addEventListener('beforeunload', () => {
    send({ type: 'final', ...session });
  });
  // 切到背景也上報（手機 beforeunload 不一定觸發）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      send({ type: 'hidden', ...session });
    }
  });

  function send(payload) {
    navigator.sendBeacon(
      options.endpoint || '/api/qos',
      JSON.stringify(payload)
    );
  }

  return { session };
}
qosPlugin.pluginName = 'qos';
```

### 後端聚合

```text
事件流：每個 session 的 heartbeat → Kafka / Kinesis
       ↓
聚合計算：5 分鐘 window 統計
       ↓
時序 DB：InfluxDB / ClickHouse / TimescaleDB
       ↓
Dashboard：Grafana
```

關鍵 SQL 範例（ClickHouse）：

```sql
SELECT
  toStartOfMinute(ts) AS minute,
  AVG(stall_ms / NULLIF(stall_ms + play_ms, 0)) * 100 AS stall_ratio,
  quantile(0.95)(first_frame_ms) AS p95_ttff,
  COUNT(DISTINCT session_id) AS sessions,
  countIf(errors > 0) / COUNT(*) AS error_rate
FROM video_qos
WHERE ts > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute;
```

---

## 9 記憶體洩漏排查

長時間直播最容易發生。常見原因：

```text
1. SourceBuffer 沒清舊資料
2. PeerConnection 沒 close
3. addEventListener 沒移除
4. setInterval 沒 clearInterval
5. VideoFrame.close() 漏掉
6. URL.createObjectURL 沒 revoke
```

### 9.1 偵測

開 Chrome DevTools → Memory → 拍 Heap snapshot
找：
- 一直增加的 `Detached HTMLVideoElement`
- 越來越多的 `MediaSource`
- 沒清的 `ArrayBuffer`

### 9.2 SourceBuffer 清理範本

```js
function maintainBuffer(video, sb) {
  setInterval(() => {
    if (!sb.buffered.length) return;
    const start = sb.buffered.start(0);
    const cutoff = video.currentTime - 30;   // 留 30 秒
    if (cutoff > start && !sb.updating) {
      sb.remove(start, cutoff);
    }
  }, 10_000);
}
```

### 9.3 銷毀範本

```js
class PlayerLifecycle {
  constructor(video) {
    this.video = video;
    this.subs = [];
    this.timers = [];
    this.urls = [];
  }
  on(el, evt, fn) {
    el.addEventListener(evt, fn);
    this.subs.push(() => el.removeEventListener(evt, fn));
  }
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this.timers.push(id);
    return id;
  }
  createUrl(blob) {
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    return url;
  }
  destroy() {
    this.subs.forEach(off => off());
    this.timers.forEach(clearInterval);
    this.urls.forEach(URL.revokeObjectURL);
    this.video.removeAttribute('src');
    this.video.load();   // 強制釋放
  }
}
```

---

## 10 硬體解碼狀態

開 `chrome://media-internals/`，每個影片元素都會有：

```text
Player ID: ...
properties:
  is_platform_video_decoder: true     ← 用了硬解
  video_decoder: "VAAPIVideoDecoder"  ← 解碼器名
  has_audio: true
  has_video: true
  video_codec: H264
  video_dpb_size: 7
```

如果 `is_platform_video_decoder: false`，表示軟解（CPU 使用率會飆）。

軟解原因：
- 編碼設定瀏覽器不支援硬解（如 H.265 在某些 Chrome 版本）
- 解析度 > 硬解上限（如 8K H.264 部分機器不支援）
- 用了不常見的 profile

---

## 11 觀察其他大廠的指標體系

看看他們在意什麼：

| 平台 | 公開的指標 |
|------|------------|
| Netflix | First Byte Latency、Rebuffer Rate、Play Delay |
| YouTube | Time to First Frame、Mean Time Between Failures |
| Mux | 自家 SDK 量 17 個指標（[mux.com/blog](https://mux.com)） |
| Twitch | Stream Latency、Buffer Empty Events |

業界共識的「健康度」：
- 起播 < 1s：A
- 卡頓率 < 1%：A
- 起播失敗率 < 0.5%：A

---

## 12 A/B 測試影音改動

任何影音改動上線前都要 A/B：

```text
Hypothesis: "預設 ABR 起播從 240p 改 480p 能提升首幀後留存"

實驗組: startLevel = level_480p
對照組: startLevel = level_240p

量測指標:
  - TTFF (預期變慢)
  - 5 秒內留存率 (預期變高)
  - 30 秒內卡頓率 (預期變高)

判定: 留存提升 > 5%，TTFF 上升 < 200ms，卡頓上升 < 0.2pp
```

只有同時用第 8 節的 QoS 上報 + A/B 平台才能做到。

---

## 13 本章重點回顧

- 影音的 QoS 指標核心是「首幀時間、卡頓率、起播失敗率」，背下來。
- `requestVideoFrameCallback` 才是真正測量首幀的方式。
- 秒開靠：preconnect + 低起播碼率 + faststart MP4。
- 降卡頓靠：ABR 調保守、預載相鄰內容、合理 buffer 大小。
- 記憶體洩漏的 6 大兇手要逐一檢查並釋放。
- 業界沒有人不做 QoS 上報，這是影音工程師的基本盤。

---

## 14 課後練習

1. 把第 04 章的 PlayerCore 套上本章 qosPlugin，console.log 印出每 30 秒的 session 摘要。
2. 用 Chrome DevTools 開 Memory，跑 5 分鐘直播後拍 snapshot，看有沒有洩漏。
3. 設計一個 dashboard 草圖：要顯示哪幾個圖表才能在 30 秒內判斷「現在有沒有大量使用者在卡」。

---

**上一章**：[[11-capture-and-webcodecs]] ｜ **下一章**：[13-capstone-project.md](./13-capstone-project.md)
