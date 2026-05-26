# 第 09 章：直播協定總覽與 HTTP-FLV 實戰

> **學習目標**：搞清楚 RTMP / HLS / FLV / WebRTC 各自的用途與權衡，能用 mpegts.js 播低延遲直播。
> **預計時數**：100 分鐘
> **先備知識**：[[06-hls-protocol-deep-dive]]

---

## 1 直播的核心矛盾：延遲 vs 流暢度

直播的所有技術選擇都圍繞這個權衡：

```text
        延遲                            流暢度
低延遲 ──────────────────────────────→ 高延遲
WebRTC   FLV  LL-HLS   HLS    傳統 HLS
< 1s     2-3s  2-5s    5-10s   15-30s
易掉幀                              幾乎不掉幀
```

選哪個取決於業務：

| 場景 | 推薦 | 為什麼 |
|------|------|--------|
| 視訊會議 | WebRTC | 延遲 < 500ms 是必須 |
| 電商直播帶貨 | LL-HLS / FLV | 主播與觀眾要互動，1-3s 可接受 |
| 體育賽事 | LL-HLS | 不能比朋友手機慢，3-5s |
| 大型賽事轉播 | HLS | 數百萬同時觀看，CDN 友好 > 延遲 |
| 監控錄影 | RTMP / FLV | 內網推流穩定 |

---

## 2 直播完整鏈路

```text
[ 推流端 ]                [ 邊緣節點 ]              [ 觀眾端 ]
攝影機/OBS               CDN / 自建                瀏覽器/App
  │                         │                         │
  │  RTMP / SRT / WebRTC    │   HLS / FLV / WebRTC    │
  └────────────────────────→│←────────────────────────┘
                            │
                            │ 內部轉碼/轉封裝
                            ▼
                    [ 媒體源伺服器 ]
                    SRS / Nginx-RTMP / Wowza
```

關鍵概念：**推流協定 ≠ 拉流協定**。中間的媒體伺服器負責協定轉換。

---

## 3 推流端（Ingest）協定

### 3.1 RTMP

- 1997 年 Adobe 發明，TCP-based
- **業界推流的事實標準**：OBS、抖音、YouTube 都接受 RTMP 推流
- 延遲：1-3 秒
- 缺點：基於 TCP，重傳會放大延遲

```text
推流 URL 格式：
rtmp://server-ip/app-name/stream-key
範例：
rtmp://live.twitch.tv/live/live_xxx_yyy
```

### 3.2 SRT (Secure Reliable Transport)

- 2017 年 Haivision 推出
- UDP-based，類似 WebRTC 但更穩定
- **廣電業界、跨國轉播**新寵
- 延遲：< 1 秒（同等網路下）

### 3.3 WebRTC

- 也能當推流協定（WHIP）
- 用於「瀏覽器直接開播」的場景（沒有 OBS）

### 3.4 RTMPS

RTMP 加 TLS，跟 RTMP 一樣，差別只是加密。

---

## 4 拉流端（Playback）協定

| 協定 | 延遲 | 瀏覽器支援 |
|------|------|-----------|
| **HLS** | 15-30s | 全平台（Safari 原生 / 其他用 hls.js） |
| **LL-HLS** | 2-5s | 同上 |
| **HTTP-FLV** | 1-3s | mpegts.js（Chrome）/ Safari 不支援 |
| **WebSocket-FLV** | 1-3s | 同上 |
| **WebRTC** | < 1s | 全瀏覽器原生 |

---

## 5 HTTP-FLV 是什麼

把 FLV（Flash 時代的容器格式）**透過 HTTP chunked transfer encoding 不斷推送**。

```text
傳統 FLV：
  GET /stream.flv → 整檔下載

HTTP-FLV：
  GET /live/stream.flv
  ← HTTP/1.1 200
  ← Transfer-Encoding: chunked
  ← [FLV header] (一次性)
  ← [tag 1] [tag 2] [tag 3] ...   ← 持續推送
```

優點：
- 用 HTTP，CDN 友好
- 延遲低（1-3 秒）
- 不用切片，伺服器邏輯簡單

缺點：
- 只能順序播，無法 seek
- 沒有 ABR（一個 stream 一個碼率）

> **中國直播平台幾乎都是 HTTP-FLV**：嗶哩嗶哩、虎牙、抖音 web 端。

---

## 6 FLV 容器格式

學一下基本結構，後面用得到：

```text
[FLV Header 9 bytes]
[Previous Tag Size: 0]
┌─────────────────────────┐
│ Tag 1                   │
│  ├ Type (1 byte)        │  8=audio, 9=video, 18=script
│  ├ DataSize (3 bytes)   │
│  ├ Timestamp (4 bytes)  │
│  ├ StreamID (3 bytes)   │
│  └ Body                 │
├─────────────────────────┤
│ Previous Tag Size       │
├─────────────────────────┤
│ Tag 2                   │
...
```

每個 Tag 都有 timestamp（毫秒），這就是播放器的時間軸。

---

## 7 用 mpegts.js 播 HTTP-FLV

mpegts.js（前身 flv.js）是 bilibili 開源的：

```html
<script src="https://cdn.jsdelivr.net/npm/mpegts.js@latest/dist/mpegts.js"></script>
<video id="v" controls autoplay muted></video>

<script>
if (mpegts.getFeatureList().mseLivePlayback) {
  const player = mpegts.createPlayer({
    type: 'flv',           // 或 'mse'
    isLive: true,
    url: 'https://live.example.com/live/stream-key.flv',
  }, {
    enableWorker: true,
    enableStashBuffer: false,    // ← 關鍵：直播必關 stash
    stashInitialSize: 128,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 3,
    autoCleanupMinBackwardDuration: 2,
    liveBufferLatencyChasing: true,    // 自動追上直播時間
    liveBufferLatencyMaxLatency: 3,
    liveBufferLatencyMinRemain: 0.5,
  });

  player.attachMediaElement(document.getElementById('v'));
  player.load();
  player.play();

  // 事件監聽
  player.on(mpegts.Events.STATISTICS_INFO, (stat) => {
    console.log('速度', stat.speed, 'KB/s');
  });

  player.on(mpegts.Events.LOADING_COMPLETE, () => {
    console.log('連線中斷');
  });

  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    console.error(type, detail, info);
  });
}
</script>
```

### 重要參數解讀

| 參數 | 直播建議 | 說明 |
|------|----------|------|
| `enableStashBuffer` | `false` | 預載 buffer 會增加延遲 |
| `liveBufferLatencyChasing` | `true` | 落後太多自動跳到最新 |
| `liveBufferLatencyMaxLatency` | `3` | 超過 3 秒延遲就追 |
| `autoCleanupSourceBuffer` | `true` | 防止 SourceBuffer 爆 |

---

## 8 WebSocket-FLV

用 WebSocket 代替 HTTP 傳輸 FLV tags，更適合穿越某些代理：

```js
const player = mpegts.createPlayer({
  type: 'flv',
  isLive: true,
  url: 'wss://live.example.com/live/stream',   // ← ws 或 wss
});
```

伺服器端範例（Node.js）：

```js
const WebSocket = require('ws');
const fs = require('fs');

const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  // 從 SRS / 自家媒體源拉 FLV，轉發到 WebSocket
  const flvStream = fetchFLVFromOrigin();   // 你的實作
  flvStream.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
});
```

---

## 9 自己架直播伺服器（SRS）

最熱門的開源直播伺服器 [SRS (Simple Realtime Server)](https://github.com/ossrs/srs)：

### 9.1 Docker 一鍵起

```bash
docker run --rm -it \
  -p 1935:1935 -p 1985:1985 -p 8080:8080 \
  ossrs/srs:5 ./objs/srs -c conf/http.flv.live.conf
```

### 9.2 用 OBS 推流

OBS 設定：
- 服務：`Custom`
- 伺服器：`rtmp://127.0.0.1/live`
- 串流金鑰：`mystream`

### 9.3 三種拉流方式同時提供

```text
RTMP  : rtmp://127.0.0.1/live/mystream
HTTP-FLV: http://127.0.0.1:8080/live/mystream.flv
HLS  : http://127.0.0.1:8080/live/mystream.m3u8
WebRTC : webrtc://127.0.0.1/live/mystream
```

同一個推流，多種協定下發，這是直播平台的基本能力。

---

## 10 直播追幀（Latency Chasing）

直播放久了 buffer 越累積越長，延遲會跑掉。要主動「追上」：

```js
function chaseLatency(video) {
  const buffered = video.buffered;
  if (!buffered.length) return;

  const end = buffered.end(buffered.length - 1);
  const latency = end - video.currentTime;

  if (latency > 3) {
    // 落後超過 3 秒，倍速追上
    video.playbackRate = 1.1;
  } else if (latency < 1) {
    video.playbackRate = 1.0;
  }
}

setInterval(() => chaseLatency(video), 1000);
```

或更激進：直接 seek 到最新：

```js
if (latency > 6) video.currentTime = end - 0.5;
```

> mpegts.js 的 `liveBufferLatencyChasing` 就是內部做這件事。

---

## 11 推流端：怎麼從零開始一場直播

```text
階段 1：採集
  - 攝影機：USB / IP camera
  - 螢幕分享：getDisplayMedia()
  - OBS：可疊圖層、轉場、字卡

階段 2：編碼
  - 軟體編碼：x264 (CPU)
  - 硬體編碼：NVENC / QuickSync / VideoToolbox

階段 3：封裝 + 推流
  - 主流：RTMP
  - 進階：SRT、WebRTC

階段 4：分發
  - CDN
  - 自建 SRS / 商業（阿里、騰訊、Mux、AWS IVS）

階段 5：拉流播放
  - 看延遲需求選協定
```

---

## 12 編碼器（推流端）參數推薦

OBS / ffmpeg 推流建議參數：

```bash
# 1080p60 直播推流到 RTMP
ffmpeg -re -i input.mp4 \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -b:v 6000k -maxrate 6000k -bufsize 12000k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 \
  -f flv \
  rtmp://server/live/stream-key
```

關鍵參數：

| 參數 | 直播優化 |
|------|----------|
| `-preset veryfast` | 編碼速度，再慢延遲就高 |
| `-tune zerolatency` | 關閉 B-frame，降低延遲 |
| `-g 60` | GOP 60 幀（60fps 是 1 秒） |
| `-keyint_min 60` | 強制固定 GOP |
| `-sc_threshold 0` | 不要場景切換時插 I-frame |
| `-maxrate ... -bufsize ...` | CBR 模式，頻寬可預測 |

---

## 13 直播 QoS 指標

production 必須監控：

```text
推流端：
  - 上行頻寬達標率
  - 編碼掉幀
  - 推流斷線次數

媒體源：
  - 入流 / 出流碼率
  - 並發連線數
  - CPU / GPU 負載

觀眾端：
  - 首幀時間（從 click 到第一幀）
  - 卡頓率（卡頓時長 / 總時長）
  - 平均延遲
  - 切換協定次數（FLV 失敗降級到 HLS）
```

每一條都要埋點上報，第 12 章會展開。

---

## 14 協定降級策略

production 播放器要會自動降級：

```js
class LivePlayer {
  async play(streamId) {
    // 1. 嘗試 WebRTC（最低延遲）
    if (await this.tryWebRTC(streamId)) return;

    // 2. 失敗降級到 HTTP-FLV
    if (await this.tryFLV(streamId)) return;

    // 3. 都不行用 HLS（相容性最好）
    await this.tryHLS(streamId);
  }

  async tryWebRTC(id) {
    try {
      // ...建立 RTCPeerConnection (第 10 章)
      return true;
    } catch (e) { return false; }
  }

  async tryFLV(id) {
    if (!mpegts.getFeatureList().mseLivePlayback) return false;
    try {
      this.player = mpegts.createPlayer({ type: 'flv', isLive: true, url: `${this.cdn}/${id}.flv` });
      this.player.attachMediaElement(this.video);
      this.player.load();
      return true;
    } catch (e) { return false; }
  }

  async tryHLS(id) {
    // ...用 hls.js 或原生
  }
}
```

---

## 15 本章重點回顧

- 直播協定選擇是「延遲 vs 流暢度」的權衡，沒有銀彈。
- **推流用 RTMP，拉流分情境**：低延遲 FLV / WebRTC，相容性 HLS。
- HTTP-FLV 在 Chrome 用 mpegts.js，是中國直播的事實標準。
- 直播必須主動「追幀」否則延遲會無限累積。
- SRS / Nginx-RTMP 自架很簡單，學習用 docker 起就好。
- production 播放器要會降級（WebRTC → FLV → HLS）。

---

## 16 課後練習

1. Docker 起 SRS，用 OBS 推流，用 mpegts.js 播放，量測端到端延遲。
2. 把 mpegts.js 包成第 04 章的 PlayerCore 外掛，叫做 `flvSource`。
3. 寫一個「追幀」插件：當 buffered 與 currentTime 落差超過閾值就切換 playbackRate。

---

**上一章**：[[08-abr-and-drm]] ｜ **下一章**：[10-webrtc-deep-dive.md](./10-webrtc-deep-dive.md)
