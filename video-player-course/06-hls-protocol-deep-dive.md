# 第 06 章：HLS 協定深入解析

> **學習目標**：看得懂 m3u8 每一行、能徒手解析播放清單、會用 hls.js 與 debug 串流問題。
> **預計時數**：150 分鐘
> **先備知識**：[[05-http-range-and-cdn]]、[[01-video-codec-and-container-basics]]

---

## 1 HLS 是什麼

**HTTP Live Streaming**，Apple 在 2009 年提出（RFC 8216）。
核心思想：把影片切成幾秒一段的小檔，搭配一個索引清單（`.m3u8`）。

```text
傳統下載：
[ movie.mp4 (50 MB) ]   ← 一個大檔

HLS：
master.m3u8 ──→ 720p.m3u8 ──→ seg_001.ts, seg_002.ts, seg_003.ts, ...
            ↓
            └→ 480p.m3u8 ──→ seg_001.ts, seg_002.ts, seg_003.ts, ...
```

### 為什麼 HLS 風靡全球？

1. **走 HTTP**：穿透防火牆、能用 CDN
2. **自動切換解析度**：弱網切低、強網切高
3. **點播直播通用**：同一套協定
4. **Apple 加持**：iOS 原生支援，且要上 App Store 必須用 HLS

---

## 2 m3u8 文字格式

`.m3u8` 是 UTF-8 純文字，**自己用記事本就能寫**。

### 2.1 最小範例（VOD）

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD

#EXTINF:4.000,
segment_000.ts
#EXTINF:4.000,
segment_001.ts
#EXTINF:3.520,
segment_002.ts

#EXT-X-ENDLIST
```

逐行解讀：

| 標籤 | 意義 |
|------|------|
| `#EXTM3U` | 開頭魔術字串，必填 |
| `#EXT-X-VERSION:3` | 用到 v3 規格特性 |
| `#EXT-X-TARGETDURATION:4` | 每段最長 4 秒（取整數） |
| `#EXT-X-MEDIA-SEQUENCE:0` | 第一段的序號 |
| `#EXT-X-PLAYLIST-TYPE:VOD` | 點播（VOD）/ 事件直播（EVENT） |
| `#EXTINF:4.000,` | 下一個切片時長 4 秒 |
| `segment_000.ts` | 切片檔名 |
| `#EXT-X-ENDLIST` | 清單結束（直播不寫） |

### 2.2 主清單（Master Playlist）

包含多個解析度的 entry：

```m3u8
#EXTM3U
#EXT-X-VERSION:6

#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"
720p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1128000,RESOLUTION=854x480,CODECS="avc1.4D401F,mp4a.40.2"
480p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=628000,RESOLUTION=640x360,CODECS="avc1.42E01E,mp4a.40.2"
360p/playlist.m3u8
```

| 屬性 | 意義 |
|------|------|
| `BANDWIDTH` | 該軌平均位元率（bits/sec），ABR 用它選擇 |
| `RESOLUTION` | 解析度 |
| `CODECS` | 編碼資訊（瀏覽器用 `MediaSource.isTypeSupported` 判斷支援度） |
| `FRAME-RATE` | 幀率（v5+） |
| `AUDIO`/`VIDEO`/`SUBTITLES` | 對應的 Media Group ID |

### 2.3 多語言音軌與字幕

```m3u8
#EXTM3U
#EXT-X-VERSION:6

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",LANGUAGE="zh",DEFAULT=YES,URI="audio_zh.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="audio_en.m3u8"

#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文",LANGUAGE="zh",DEFAULT=YES,URI="sub_zh.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720,CODECS="avc1.640028",AUDIO="audio",SUBTITLES="subs"
video_720p.m3u8
```

> 高級播放器（YouTube/Netflix）的多軌切換就是這樣做的。

---

## 3 直播 m3u8（Live）

直播跟點播主要差異：
- **沒有** `#EXT-X-ENDLIST`
- 每隔幾秒**重新整理** m3u8（client 輪詢）
- `#EXT-X-MEDIA-SEQUENCE` 會增加（舊切片被丟棄）

範例：

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:1000

#EXTINF:4.000,
seg_1000.ts
#EXTINF:4.000,
seg_1001.ts
#EXTINF:4.000,
seg_1002.ts
```

3 秒後再抓一次同個 URL：

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:1001

#EXTINF:4.000,
seg_1001.ts
#EXTINF:4.000,
seg_1002.ts
#EXTINF:4.000,
seg_1003.ts
```

> seg_1000 已從清單消失（一般只保留最新 3-6 段），所以「**遲到的觀眾看不到開頭**」。

---

## 4 切片檔（.ts vs .m4s/fMP4）

兩種主流的切片格式：

| 格式 | 容器 | 副檔名 | 特性 |
|------|------|--------|------|
| MPEG-TS | TS | `.ts` | HLS 原生、相容性最好、有 30% 額外 overhead |
| fMP4 | fragmented MP4 | `.m4s` 或 `.mp4` | 更省、與 DASH 共用、需 HLS v6+ |

新一代 HLS 都改用 fMP4，YouTube、Mux、HLS Live Streaming 服務都已轉換。

### 用 fMP4 的 m3u8

```m3u8
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"     ← 初始化片段（含 codec 配置）

#EXTINF:4.000,
seg_001.m4s
#EXTINF:4.000,
seg_002.m4s
```

`init.mp4` 包含 ftyp、moov（解碼器配置），每個 `.m4s` 是純 moof + mdat。

---

## 5 加密：AES-128 與 SAMPLE-AES

HLS 內建簡單的 AES-128 切片加密：

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4

#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1234567890abcdef1234567890abcdef

#EXTINF:4.000,
encrypted_001.ts
#EXTINF:4.000,
encrypted_002.ts
```

播放器流程：
1. 拿到 `URI="key.bin"`，去抓 key（這時可以加 Token 驗證）
2. 用 key + IV 解密 `.ts`
3. 解密後餵給 video

```bash
# ffmpeg 產生加密 HLS
openssl rand 16 > enc.key
echo "https://example.com/key.bin" > enc.keyinfo
echo "enc.key" >> enc.keyinfo

ffmpeg -i input.mp4 \
  -c:v libx264 -c:a aac \
  -hls_time 4 \
  -hls_key_info_file enc.keyinfo \
  output.m3u8
```

**進階保護**：用 DRM（FairPlay）+ SAMPLE-AES，這放到 [第 08 章](./08-abr-and-drm.md)。

---

## 6 低延遲 HLS（LL-HLS）

傳統 HLS 直播延遲 15-30 秒（清單刷新間隔 × 切片數）。
**LL-HLS** 在 2020 年由 Apple 推出，目標 2-5 秒延遲。

### 核心技術

1. **Partial Segments**：切片再切小（200ms 一個 part）
2. **Blocking Playlist Reload**：client 用 `_HLS_msn` query 阻塞請求新清單
3. **Preload Hints**：清單預告下一個 part 的 URL

### LL-HLS m3u8 範例

```m3u8
#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:4
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0
#EXT-X-PART-INF:PART-TARGET=0.33334

#EXT-X-MEDIA-SEQUENCE:266
#EXTINF:4.0,
segment266.m4s
#EXT-X-PART:DURATION=0.33334,URI="seg267_0.m4s"
#EXT-X-PART:DURATION=0.33334,URI="seg267_1.m4s"
#EXT-X-PART:DURATION=0.33334,URI="seg267_2.m4s"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg267_3.m4s"
```

各家直播平台都已支援：Twitch、YouTube Live、阿里雲、騰訊雲。

---

## 7 用 hls.js 播放

hls.js 是社群維護的 MSE-based HLS 播放器。Safari 原生支援不需要 hls.js，其他瀏覽器都要。

### 7.1 基本用法

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<video id="video" controls></video>

<script>
const video = document.getElementById('video');
const src = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

if (video.canPlayType('application/vnd.apple.mpegurl')) {
  // Safari 原生
  video.src = src;
} else if (Hls.isSupported()) {
  // 其他瀏覽器
  const hls = new Hls({
    debug: false,
    enableWorker: true,
    lowLatencyMode: true,
    backBufferLength: 90,
  });
  hls.loadSource(src);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    console.log('清單解析完成', hls.levels);
    video.play();
  });
}
</script>
```

### 7.2 重要事件

```js
hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
  console.log('可用解析度', data.levels);
  // [{ height: 720, bitrate: 2628000 }, { height: 480, bitrate: 1128000 }, ...]
});

hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
  console.log('切換到解析度', hls.levels[data.level]);
});

hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
  console.log('切片下載完成',
    data.frag.sn,         // 序號
    data.frag.duration,   // 時長
    data.stats.total      // 大小
  );
});

hls.on(Hls.Events.ERROR, (event, data) => {
  console.error('HLS 錯誤', data);
  if (data.fatal) {
    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        hls.startLoad();   // 嘗試恢復
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        hls.recoverMediaError();
        break;
      default:
        hls.destroy();
    }
  }
});
```

### 7.3 手動控制解析度

```js
hls.currentLevel = -1;  // -1 表示自動
hls.currentLevel = 0;   // 鎖定第一條軌

// 取得當前頻寬估計
console.log('當前估計頻寬', hls.bandwidthEstimate);

// 取得當前緩衝
console.log('已緩衝',
  video.buffered.length > 0
    ? video.buffered.end(0) - video.currentTime
    : 0,
  '秒'
);
```

### 7.4 低延遲模式

```js
const hls = new Hls({
  lowLatencyMode: true,        // 啟用 LL-HLS
  liveSyncDuration: 2,         // 跟上直播延遲 2 秒
  liveMaxLatencyDuration: 5,   // 超過 5 秒則跳到最新
  liveDurationInfinity: true,
});

hls.on(Hls.Events.LEVEL_LOADED, () => {
  console.log('直播延遲', hls.latency);
});
```

---

## 8 自己手刻：解析 m3u8

不依賴函式庫，徒手寫一個基本 parser：

```js
function parseM3U8(text) {
  const lines = text.split(/\r?\n/);
  const result = {
    version: null,
    targetDuration: null,
    mediaSequence: 0,
    isLive: true,
    segments: [],
    streams: [],   // master playlist 的多解析度
  };

  let currentSegment = null;
  let currentStream = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-VERSION:')) {
      result.version = +line.split(':')[1];
    }
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      result.targetDuration = +line.split(':')[1];
    }
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      result.mediaSequence = +line.split(':')[1];
    }
    else if (line === '#EXT-X-ENDLIST') {
      result.isLive = false;
    }
    else if (line.startsWith('#EXTINF:')) {
      const [duration, title] = line.slice(8).split(',');
      currentSegment = { duration: +duration, title: title || '' };
    }
    else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttrs(line.slice(18));
      currentStream = {
        bandwidth: +attrs.BANDWIDTH,
        resolution: attrs.RESOLUTION,
        codecs: attrs.CODECS,
      };
    }
    else if (!line.startsWith('#')) {
      if (currentStream) {
        currentStream.uri = line;
        result.streams.push(currentStream);
        currentStream = null;
      } else if (currentSegment) {
        currentSegment.uri = line;
        result.segments.push(currentSegment);
        currentSegment = null;
      }
    }
  }
  return result;
}

function parseAttrs(str) {
  const result = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    result[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return result;
}

// 使用
const text = await fetch('master.m3u8').then(r => r.text());
const parsed = parseM3U8(text);
console.log(parsed);
```

---

## 9 用 Wireshark / DevTools Debug HLS

### 觀察 DevTools

打開 Network → 篩 `m3u8`，你會看到：

```text
master.m3u8       Status: 200    Time: 80ms      ← 主清單
720p.m3u8         Status: 200    Time: 60ms      ← 子清單
init.mp4          Status: 200    Time: 100ms     ← 初始化片段
seg_001.m4s       Status: 200    Time: 200ms     ← 第 1 片
seg_002.m4s       Status: 200    Time: 180ms
...
```

啟用 hls.js 的 debug：

```js
const hls = new Hls({ debug: true });
```

Console 會印出滿滿的內部運作 log，**強烈推薦在開發環境永遠開著**。

### 6 大常見錯誤類型

| 錯誤 | 原因 | 解法 |
|------|------|------|
| `manifestLoadError` | m3u8 404 / CORS | 檢查 URL 與 CORS header |
| `manifestParsingError` | m3u8 格式錯 | 用 [hlsanalyzer.com](https://hls-analyzer.com) 驗證 |
| `levelLoadError` | 子清單抓不到 | CDN 路徑問題 |
| `fragLoadError` | 切片抓不到 | 切片產生中斷？防盜鏈失效？ |
| `bufferAppendError` | MSE 餵錯資料 | codec 不一致？init 缺失？ |
| `bufferStalledError` | 緩衝餓死 | 頻寬不足或 ABR 沒切換 |

---

## 10 自架 HLS 伺服器

### 用 Nginx 服務點播 HLS

```nginx
server {
  listen 80;

  location /hls/ {
    root /var/www;
    add_header Cache-Control "public, max-age=86400";
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Expose-Headers "Content-Length,Content-Range";

    types {
      application/vnd.apple.mpegurl m3u8;
      video/mp2t ts;
      video/iso.segment m4s;
      video/mp4 mp4;
    }
  }

  # 直播 m3u8 不快取
  location ~ \.m3u8$ {
    root /var/www;
    add_header Cache-Control "no-cache";
    add_header Access-Control-Allow-Origin *;
  }
}
```

### 直播：用 nginx-rtmp 推流 + 自動轉 HLS

```nginx
rtmp {
  server {
    listen 1935;
    application live {
      live on;
      hls on;
      hls_path /var/www/hls;
      hls_fragment 2s;
      hls_playlist_length 12s;
    }
  }
}
```

OBS 推流到 `rtmp://your-server/live/stream-key`，網頁透過 `http://your-server/hls/stream-key.m3u8` 播放。

---

## 11 本章重點回顧

- HLS = 一份文字清單 + 一堆小切片，走 HTTP，極度 CDN 友好。
- 主清單列舉多解析度，子清單列舉切片。
- 直播版本要持續輪詢清單，沒有 `#EXT-X-ENDLIST`。
- LL-HLS 用 partial segments 把延遲壓到 2-5 秒。
- hls.js 是 Chrome 等瀏覽器播 HLS 的標配，永遠開 debug。
- HLS 內建加密用 `#EXT-X-KEY`，正式版權保護用 FairPlay DRM。

---

## 12 課後練習

1. 用瀏覽器 Network panel 打開 [test-streams.mux.dev](https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8)，截圖記錄主清單、子清單、切片的請求順序。
2. 把第 01 章 ffmpeg 產出的 HLS 用 nginx 服務，並用 hls.js 在 Chrome 播放。
3. 寫一段 JS 用本章的 parser 解析 master.m3u8，列出所有解析度，並算出總頻寬範圍。

---

**上一章**：[[05-http-range-and-cdn]] ｜ **下一章**：[07-mse-and-dash.md](./07-mse-and-dash.md)
