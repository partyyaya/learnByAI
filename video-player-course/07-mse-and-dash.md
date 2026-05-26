# 第 07 章：MSE 與 DASH 實戰

> **學習目標**：理解 hls.js / dash.js 怎麼運作的底層原理，能直接用 MSE 餵 chunk 給 `<video>`。
> **預計時數**：150 分鐘
> **先備知識**：[[06-hls-protocol-deep-dive]]

---

## 1 為什麼需要 MSE？

`<video src="movie.mp4">` 只能播一個固定來源。要做以下事情得換工具：

- 動態切換解析度（不打斷播放）
- 邊抓邊餵，自己控制下載策略
- 播放任意串流（HLS、DASH、自訂協定）
- 對影片內容加密 / 解密

**Media Source Extensions (MSE)** 就是答案：讓 JS 直接餵編碼後的 chunk 給 `<video>`。

```text
傳統：
  <video src="movie.mp4"> ←──── HTTP ←─── server

MSE：
  <video> ←── SourceBuffer ←── JS（fetch chunk, append）
                 ↑
            你完全控制每一個 byte
```

---

## 2 MSE API 結構

```text
MediaSource
  ├── readyState: "closed" / "open" / "ended"
  ├── sourceBuffers: SourceBufferList
  ├── addSourceBuffer(mimeType)
  └── endOfStream()

SourceBuffer
  ├── updating: boolean
  ├── buffered: TimeRanges
  ├── timestampOffset: number
  ├── appendBuffer(ArrayBuffer)
  ├── remove(start, end)
  └── 'updateend' event
```

---

## 3 最小 MSE 範例

把這段存成 HTML 跑起來：

```html
<!DOCTYPE html>
<html><body>
<video id="v" controls width="640"></video>
<script>
const video = document.getElementById('v');
const mediaSource = new MediaSource();
video.src = URL.createObjectURL(mediaSource);

mediaSource.addEventListener('sourceopen', async () => {
  // 必須宣告精確的 mimeType + codecs
  const mime = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

  if (!MediaSource.isTypeSupported(mime)) {
    console.error('瀏覽器不支援這個 codec');
    return;
  }

  const sb = mediaSource.addSourceBuffer(mime);

  // 把整個 MP4 載下來分批餵（示範用，實際應該分段）
  const res = await fetch('https://test-streams.mux.dev/test_001/stream.mp4');
  const buf = await res.arrayBuffer();

  sb.appendBuffer(buf);
  sb.addEventListener('updateend', () => {
    if (!sb.updating) mediaSource.endOfStream();
  });
});
</script>
</body></html>
```

> 注意：要分段 MSE 必須用 fMP4，不能用普通 MP4 隨意切。

---

## 4 用 MSE 實作簡易 HLS Player

把一個 m3u8 解析後一段一段餵給 SourceBuffer：

```js
class MiniHlsPlayer {
  constructor(video, src) {
    this.video = video;
    this.src = src;
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener('sourceopen', () => this.start());
  }

  async start() {
    // 1. 抓主清單
    const masterText = await fetch(this.src).then(r => r.text());
    const master = parseM3U8(masterText);          // 用 06 章的 parser
    const stream = master.streams[0];               // 選第一條

    // 2. 抓子清單
    const subUrl = new URL(stream.uri, this.src).href;
    const subText = await fetch(subUrl).then(r => r.text());
    const sub = parseM3U8(subText);

    // 3. 建立 SourceBuffer（注意 TS 不能直接餵 MSE，要先 demux）
    // 為簡化，這裡假設來源是 fMP4
    const mime = `video/mp4; codecs="${stream.codecs}"`;
    this.sb = this.mediaSource.addSourceBuffer(mime);

    // 4. 依序載入切片
    for (const seg of sub.segments) {
      const segUrl = new URL(seg.uri, subUrl).href;
      const buf = await fetch(segUrl).then(r => r.arrayBuffer());
      await this.append(buf);
    }

    this.mediaSource.endOfStream();
  }

  append(buf) {
    return new Promise((resolve) => {
      this.sb.appendBuffer(buf);
      this.sb.addEventListener('updateend', resolve, { once: true });
    });
  }
}
```

> 為什麼 hls.js 還要做 demux？因為 `.ts` 容器無法直接餵 MSE，必須先解出 H.264 NAL units 再封裝成 fMP4。這部分在 hls.js 的 [demux](https://github.com/video-dev/hls.js/tree/master/src/demux) 模組。

---

## 5 SourceBuffer 進階操作

### 5.1 移除舊資料（避免記憶體爆炸）

長時間直播會把 SourceBuffer 塞爆。要定期清理：

```js
function trimBuffer(sb, keepBefore = 30) {
  if (!sb.buffered.length) return;
  const start = sb.buffered.start(0);
  const safeRemoveEnd = video.currentTime - keepBefore;
  if (safeRemoveEnd > start) {
    sb.remove(start, safeRemoveEnd);
  }
}
setInterval(() => trimBuffer(sb), 5000);
```

### 5.2 處理 `QuotaExceededError`

```js
sb.addEventListener('error', () => console.log('SB error'));

function safeAppend(sb, buf) {
  try {
    sb.appendBuffer(buf);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      // 緊急清掉前面 30 秒
      const start = sb.buffered.start(0);
      sb.remove(start, start + 30);
      sb.addEventListener('updateend', () => sb.appendBuffer(buf), { once: true });
    }
  }
}
```

### 5.3 切換解析度（不打斷播放）

ABR 切換的關鍵動作：

```js
async function switchQuality(newStream) {
  // 1. 暫停下載
  pauseLoading = true;

  // 2. 重設 codec（若 codec 不同要 changeType）
  const newMime = `video/mp4; codecs="${newStream.codecs}"`;
  if (newMime !== currentMime) {
    sb.changeType(newMime);          // ★ HLS 跨 codec 必用
    currentMime = newMime;
  }

  // 3. 把當前 currentTime 之後的 buffer 清掉
  sb.remove(video.currentTime + 2, video.duration);
  await waitForUpdateEnd(sb);

  // 4. 開始抓新解析度的切片
  pauseLoading = false;
  loadNextSegment(newStream);
}
```

### 5.4 多 SourceBuffer：影片 + 音訊分開

```js
const videoSB = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
const audioSB = mediaSource.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');

// 各自獨立餵
videoSB.appendBuffer(videoChunk);
audioSB.appendBuffer(audioChunk);
```

YouTube、DASH 都是這種雙 SourceBuffer 架構，因為它們的影音是分開的 segment。

---

## 6 DASH 是什麼？

**Dynamic Adaptive Streaming over HTTP**（MPEG-DASH，ISO 標準）。
跟 HLS 是競爭對手，技術上更開放：

| 項目 | HLS | DASH |
|------|-----|------|
| 標準制定 | Apple | MPEG / ISO |
| 清單格式 | `.m3u8` (純文字) | `.mpd` (XML) |
| 切片格式 | TS / fMP4 | fMP4 / WebM |
| Codec 限制 | 偏向 H.264/H.265 | 任意 codec |
| iOS 原生支援 | ✅ | ❌（需 JS 庫） |
| 主要使用者 | Apple 生態、Twitch | YouTube、Netflix |

---

## 7 MPD 檔案結構

`.mpd` 是 XML，比 m3u8 複雜很多但表達能力更強：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static"
     mediaPresentationDuration="PT5M0S"
     minBufferTime="PT2S">

  <Period>

    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <Representation id="720p" bandwidth="2500000" width="1280" height="720" codecs="avc1.640028">
        <SegmentTemplate
            timescale="1000"
            duration="4000"
            initialization="video_720p_init.mp4"
            media="video_720p_$Number$.m4s"
            startNumber="1"/>
      </Representation>
      <Representation id="480p" bandwidth="1000000" width="854" height="480" codecs="avc1.4D401F">
        <SegmentTemplate
            timescale="1000"
            duration="4000"
            initialization="video_480p_init.mp4"
            media="video_480p_$Number$.m4s"
            startNumber="1"/>
      </Representation>
    </AdaptationSet>

    <AdaptationSet mimeType="audio/mp4" lang="zh">
      <Representation id="audio" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate
            initialization="audio_init.mp4"
            media="audio_$Number$.m4s"
            startNumber="1"
            duration="4000"
            timescale="1000"/>
      </Representation>
    </AdaptationSet>

  </Period>
</MPD>
```

### 關鍵概念

| 概念 | 意義 |
|------|------|
| `Period` | 一個時段（廣告與內容可分 Period） |
| `AdaptationSet` | 一組可互相切換的軌（video / audio / subtitle） |
| `Representation` | 一條具體解析度 / 碼率 |
| `SegmentTemplate` | 用 placeholder 表達切片 URL |

### 切片 URL 推導

```text
template: "video_720p_$Number$.m4s"
startNumber: 1
duration: 4000 / timescale: 1000 = 每片 4 秒

→ 第 1 片：video_720p_1.m4s   （0-4s）
→ 第 2 片：video_720p_2.m4s   （4-8s）
→ 第 3 片：video_720p_3.m4s   （8-12s）
```

DASH 直播用 `type="dynamic"`，再加 `availabilityStartTime` 與 client 時間對齊算出當前該抓哪片。

---

## 8 用 shaka-player 播 DASH

Google 出的 shaka-player 同時支援 DASH、HLS、CMAF、低延遲：

```html
<script src="https://cdn.jsdelivr.net/npm/shaka-player@latest/dist/shaka-player.compiled.js"></script>
<video id="v" controls></video>

<script>
async function init() {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    console.error('Browser not supported');
    return;
  }

  const video = document.getElementById('v');
  const player = new shaka.Player(video);

  // 監聽錯誤
  player.addEventListener('error', (e) => console.error(e.detail));

  // 載入
  await player.load('https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd');
  console.log('DASH 載入成功');

  // 取得可選解析度
  const tracks = player.getVariantTracks();
  console.log(tracks);

  // 手動指定解析度
  // player.configure({ abr: { enabled: false } });
  // player.selectVariantTrack(tracks.find(t => t.height === 720), true);
}

init();
</script>
```

### shaka-player 重要 API

```js
// ABR 配置
player.configure({
  abr: {
    enabled: true,
    defaultBandwidthEstimate: 500_000,   // 初始假設頻寬
    bandwidthUpgradeTarget: 0.85,
    bandwidthDowngradeTarget: 0.95,
    switchInterval: 8,                    // 切換頻率
  },
  streaming: {
    bufferingGoal: 30,                    // 目標緩衝 30 秒
    rebufferingGoal: 2,                   // 卡頓恢復閾值
    lowLatencyMode: true,
  },
});

// 取得統計
console.log(player.getStats());
// { width, height, streamBandwidth, bufferingTime, droppedFrames, ... }
```

---

## 9 CMAF：HLS 與 DASH 終於和解

**Common Media Application Format** = 同一份 fMP4 切片，配兩份清單（一份 m3u8、一份 mpd）。

```text
傳統：
  HLS  → 切一套 .ts
  DASH → 切一套 .m4s

CMAF：
  HLS .m3u8 ──┐
              ├──── 共用一套 .cmfv / .cmfa
  DASH .mpd ──┘
```

**省 50% CDN 儲存與快取**，是業界趨勢。

---

## 10 用 ffmpeg 產生 DASH 素材

```bash
ffmpeg -i input.mp4 \
  -map 0:v -map 0:v -map 0:a \
  -c:v:0 libx264 -b:v:0 2500k -s:v:0 1280x720 \
  -c:v:1 libx264 -b:v:1 1000k -s:v:1 854x480 \
  -c:a aac -b:a 128k \
  -g 48 -keyint_min 48 -sc_threshold 0 \
  -use_timeline 1 -use_template 1 \
  -seg_duration 4 -f dash \
  output.mpd
```

產出：

```text
output.mpd
init-stream0.m4s   ← 720p init
chunk-stream0-00001.m4s
chunk-stream0-00002.m4s
...
init-stream1.m4s   ← 480p init
chunk-stream1-00001.m4s
...
init-stream2.m4s   ← audio init
chunk-stream2-00001.m4s
...
```

---

## 11 MSE 常見坑與 Debug

### 坑 1：MIME type 字串錯誤

```js
// ❌ 漏寫 codecs
mediaSource.addSourceBuffer('video/mp4');     // 直接報錯

// ✅ 必須完整
mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
```

`canPlayType` 跟 `isTypeSupported` 結果可能不一樣，**MSE 用 `MediaSource.isTypeSupported`**。

### 坑 2：updating 為 true 時呼叫 appendBuffer

```js
// ❌ 連續呼叫會炸
sb.appendBuffer(chunk1);
sb.appendBuffer(chunk2);   // InvalidStateError

// ✅ 排隊
const queue = [];
function enqueue(buf) {
  queue.push(buf);
  if (!sb.updating) flush();
}
sb.addEventListener('updateend', flush);
function flush() {
  if (!sb.updating && queue.length) {
    sb.appendBuffer(queue.shift());
  }
}
```

### 坑 3：時間戳不連續

如果切片時間戳跟 SourceBuffer 已有時間斷層，影片會跳。
用 `timestampOffset` 調整：

```js
sb.timestampOffset = video.currentTime - segmentStartTime;
sb.appendBuffer(buf);
```

### 坑 4：Safari MSE 行為與 Chrome 不同

- Safari 必須先 `appendBuffer` 完 init 後才能 query buffered
- Safari 對 `changeType` 支援較差
- iOS Safari 完全不支援 MSE（只能用原生 HLS）

```js
// 判斷
const supportsMSE = 'MediaSource' in window;
const isiOSSafari = /iP(hone|ad|od)/.test(navigator.userAgent);

if (isiOSSafari) {
  // 原生 HLS
  video.src = 'master.m3u8';
} else {
  // MSE 路徑
}
```

---

## 12 寫一個玩具：Custom Streaming Format

把 MSE 用到極限的範例：自己定義一個 streaming 協定。

伺服器：

```js
// Express: 把 fMP4 切成 1 秒 chunk 用 SSE 傳
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const initBuf = fs.readFileSync('./init.mp4');
  res.write(`data: ${initBuf.toString('base64')}\n\n`);

  let idx = 1;
  const timer = setInterval(() => {
    const chunk = fs.readFileSync(`./seg_${idx++}.m4s`);
    res.write(`data: ${chunk.toString('base64')}\n\n`);
    if (idx > 100) clearInterval(timer);
  }, 1000);
});
```

Client：

```js
const ms = new MediaSource();
video.src = URL.createObjectURL(ms);

ms.addEventListener('sourceopen', () => {
  const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
  const queue = [];

  const evt = new EventSource('/stream');
  evt.onmessage = (e) => {
    const buf = Uint8Array.from(atob(e.data), c => c.charCodeAt(0));
    queue.push(buf);
    if (!sb.updating) flush();
  };
  sb.addEventListener('updateend', flush);
  function flush() {
    if (!sb.updating && queue.length) sb.appendBuffer(queue.shift());
  }
});
```

> 這就是「自己造 HLS」的精神。當然 production 不會這樣做，但理解後你就懂 hls.js 在幹嘛了。

---

## 13 本章重點回顧

- MSE 讓 JS 直接控制餵給 `<video>` 的每一個 byte。
- 餵的內容必須是 fMP4（或 WebM），原始 MP4/TS 都要先處理。
- ABR 切換解析度的核心動作是 `remove + changeType + appendBuffer`。
- DASH 用 MPD（XML）描述切片，與 HLS 競爭但更開放。
- CMAF 讓兩者共用同一份切片。
- 直播必須定期 `remove` 舊資料，否則記憶體爆。

---

## 14 課後練習

1. 用 MSE 與 fMP4 切片寫一個最小播放器，把第 01 章 ffmpeg 產出的影片播出來。
2. 在 SourceBuffer 上接事件 `updateend`，每次都列印當前 `buffered.end(0) - currentTime`，觀察緩衝狀態。
3. 用 shaka-player 載入 DASH 影片，停用 ABR，手動切換解析度並觀察 Network 變化。

---

**上一章**：[[06-hls-protocol-deep-dive]] ｜ **下一章**：[08-abr-and-drm.md](./08-abr-and-drm.md)
