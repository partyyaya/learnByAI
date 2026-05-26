# 第 13 章：畢業專題 — 點播 + 直播 + 彈幕平台

> **學習目標**：把前 12 章所學整合，做出一個可上線、可商用、可擴充的影音平台。
> **預計時數**：3-5 天完整投入
> **先備知識**：前 12 章全部

---

## 1 專題目標

做一個「**MiniTube + MiniTwitch**」：

```text
功能列表：
  □ 使用者上傳 MP4 → 後端轉 HLS（多解析度）
  □ 點播頁面：自定義播放器、ABR、字幕、倍速、彈幕
  □ 主播端：瀏覽器內推流（WebRTC）
  □ 直播間：低延遲拉流（FLV / HLS 降級）
  □ 直播聊天室與飛行彈幕
  □ QoS 上報儀表板
  □ 簡單後台：上傳管理、直播管理
```

---

## 2 技術選型

| 層級 | 技術 |
|------|------|
| 前端 | Vue 3 / React 18 + TypeScript + Vite |
| 播放器 | 自寫 PlayerCore（第 04 章）+ hls.js + mpegts.js |
| 直播主端 | getUserMedia + WHIP（第 10 章）|
| 後端 | Node.js (Fastify / Express) |
| 媒體伺服器 | SRS / mediasoup |
| 轉碼 | ffmpeg-static |
| 儲存 | S3 / R2 / 本地 + Nginx |
| 即時通訊 | WebSocket |
| 資料庫 | PostgreSQL + Redis |
| 監控 | ClickHouse + Grafana |

---

## 3 系統架構圖

```text
┌────────────────────────────────────────────────────────────────┐
│                       前端 (Vite + Vue/React)                   │
│   ┌──────────────┐ ┌────────────┐ ┌─────────────┐ ┌─────────┐ │
│   │ Upload Page  │ │ VOD Player │ │ Live Studio │ │ Live Page│ │
│   └──────┬───────┘ └─────┬──────┘ └──────┬──────┘ └─────┬───┘ │
└──────────┼───────────────┼───────────────┼──────────────┼─────┘
           │ HTTP          │ HTTP          │ WHIP/WS      │ HTTP/WS
           ▼               ▼               ▼              ▼
┌──────────────────────────────────────────────────────────────┐
│                       後端 Gateway                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ Upload   │ │ Video    │ │ Live     │ │ Chat     │         │
│  │ Service  │ │ Service  │ │ Service  │ │ Service  │         │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘         │
└───────┼────────────┼────────────┼────────────┼───────────────┘
        ▼            ▼            ▼            ▼
    ┌────────┐  ┌────────┐  ┌────────┐   ┌────────┐
    │ S3/R2  │  │ Postgres│ │  SRS   │   │ Redis  │
    │ Storage│  │   DB    │ │ Server │   │ Pub/Sub│
    └────────┘  └────────┘  └────────┘   └────────┘
                                ▲
                                │ ffmpeg 轉碼 worker
                                │
                            ┌───┴───┐
                            │ Queue │
                            └───────┘
```

---

## 4 階段拆解

把專案切成 5 個 milestone，依序完成。

### Milestone 1：點播基礎（2 天）

```text
✓ 上傳 mp4 表單
✓ 後端接收，呼叫 ffmpeg 轉成 HLS 多解析度
✓ 把轉碼後的檔案放到 storage
✓ DB 記錄影片 meta
✓ 列表頁、詳情頁
✓ 播放器使用 hls.js
```

### Milestone 2：自定義播放器整合（1 天）

```text
✓ 把第 03、04 章的 PlayerCore 整合進來
✓ 支援字幕、倍速、解析度切換、設定面板
✓ 鍵盤快捷鍵
✓ 全螢幕、PiP
```

### Milestone 3：直播推流（2 天）

```text
✓ 直播間 schema
✓ 主播端：getUserMedia 預覽 → WHIP 推到 SRS
✓ 觀眾端：HTTP-FLV 拉流（用 mpegts.js）
✓ HLS 備援
✓ 直播狀態同步：在播 / 已下播
```

### Milestone 4：聊天室 + 彈幕（1 天）

```text
✓ WebSocket 聊天室
✓ Redis Pub/Sub 多實例廣播
✓ 第 04 章 danmaku plugin 接入
✓ 禁言、管理員指令
```

### Milestone 5：QoS 儀表板（1 天）

```text
✓ 第 12 章 QoS plugin 接入
✓ 後端接收事件寫 ClickHouse
✓ Grafana 顯示首幀、卡頓、解析度分布
```

---

## 5 關鍵實作：上傳 + 轉碼 pipeline

### Frontend：分塊上傳

```ts
async function uploadVideo(file: File) {
  const CHUNK = 5 * 1024 * 1024;   // 5MB

  // 1. 建立上傳 session
  const { uploadId, key } = await fetch('/api/upload/start', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, size: file.size }),
  }).then(r => r.json());

  // 2. 分塊上傳
  const parts = [];
  for (let i = 0; i < file.size; i += CHUNK) {
    const blob = file.slice(i, i + CHUNK);
    const res = await fetch(`/api/upload/part?uploadId=${uploadId}&partNumber=${parts.length + 1}`, {
      method: 'PUT',
      body: blob,
    });
    parts.push({ ETag: res.headers.get('ETag'), PartNumber: parts.length + 1 });
    onProgress(i / file.size);
  }

  // 3. 完成上傳
  await fetch('/api/upload/complete', {
    method: 'POST',
    body: JSON.stringify({ uploadId, key, parts }),
  });

  // 4. 通知開始轉碼
  await fetch('/api/video/transcode', {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
}
```

### Backend：ffmpeg 轉碼 worker

```js
import { spawn } from 'node:child_process';
import { Worker } from 'bullmq';

const transcodeWorker = new Worker('transcode', async (job) => {
  const { input, output } = job.data;

  // 多解析度 HLS（沿用第 01 章的命令）
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-i', input,
      '-filter_complex',
      '[0:v]split=3[v1][v2][v3];' +
      '[v1]scale=w=1280:h=720[v1out];' +
      '[v2]scale=w=854:h=480[v2out];' +
      '[v3]scale=w=640:h=360[v3out]',
      '-map', '[v1out]', '-c:v:0', 'libx264', '-b:v:0', '2500k',
      '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '1000k',
      '-map', '[v3out]', '-c:v:2', 'libx264', '-b:v:2', '600k',
      '-map', 'a:0', '-map', 'a:0', '-map', 'a:0',
      '-c:a', 'aac', '-b:a', '128k',
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-hls_time', '4',
      '-hls_playlist_type', 'vod',
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2',
      `${output}/v%v/playlist.m3u8`,
    ]);
    ff.on('exit', code => code === 0 ? resolve() : reject());
    ff.stderr.on('data', d => console.log(d.toString()));
  });

  // 產生縮圖雪碧圖（第 03 章）
  await generateThumbnails(input, output);

  // 寫 DB
  await db.video.update({
    where: { id: job.data.videoId },
    data: { status: 'ready', hlsUrl: `${output}/master.m3u8` },
  });
});
```

---

## 6 關鍵實作：直播推流（WHIP）

### Studio 頁面（主播）

```vue
<template>
  <div class="studio">
    <video ref="previewRef" autoplay muted playsinline></video>

    <div class="controls">
      <button @click="startStreaming" :disabled="streaming">開播</button>
      <button @click="stopStreaming" :disabled="!streaming">下播</button>
      <span v-if="streaming">已開播 {{ uptime }}</span>
    </div>

    <div class="stats">
      <span>位元率: {{ stats.bitrate }} kbps</span>
      <span>FPS: {{ stats.fps }}</span>
      <span>RTT: {{ stats.rtt }} ms</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue';

const previewRef = ref(null);
const streaming = ref(false);
const stats = ref({ bitrate: 0, fps: 0, rtt: 0 });
let pc, statsTimer, sessionUrl;

async function startStreaming() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, frameRate: 30 },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  previewRef.value.srcObject = stream;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  const token = await getStreamToken();
  const res = await fetch(`/whip/${room}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      'Authorization': `Bearer ${token}`,
    },
    body: pc.localDescription.sdp,
  });
  sessionUrl = res.headers.get('Location');

  const answer = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  streaming.value = true;
  startStatsLoop();
}

async function stopStreaming() {
  if (sessionUrl) await fetch(sessionUrl, { method: 'DELETE' });
  pc?.close();
  streaming.value = false;
  clearInterval(statsTimer);
}

function startStatsLoop() {
  statsTimer = setInterval(async () => {
    const reports = await pc.getStats();
    let bytes = 0, lastBytes = 0, ts = 0;
    reports.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        bytes = r.bytesSent;
        stats.value.fps = r.framesPerSecond;
      }
      if (r.type === 'remote-inbound-rtp') {
        stats.value.rtt = Math.round(r.roundTripTime * 1000);
      }
    });
    if (lastBytes) {
      stats.value.bitrate = Math.round((bytes - lastBytes) * 8 / 1000);
    }
    lastBytes = bytes;
  }, 1000);
}

function waitIce(pc) {
  return new Promise(r => {
    if (pc.iceGatheringState === 'complete') return r();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r();
  });
}

onUnmounted(stopStreaming);
</script>
```

### 後端 WHIP endpoint

```js
import { spawn } from 'node:child_process';

app.post('/whip/:room', async (req, res) => {
  const room = req.params.room;
  await verifyAuth(req);

  // 把 client 的 SDP 轉發到 SRS 的 WHIP
  const srsRes = await fetch(`http://srs-server:1985/rtc/v1/whip/?app=live&stream=${room}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: req.body,
  });

  const answer = await srsRes.text();
  res.set('Location', `/whip/${room}/session-${Date.now()}`);
  res.set('Content-Type', 'application/sdp');
  res.send(answer);

  // 標記房間直播中
  await redis.set(`live:${room}`, '1', 'EX', 60);
});

app.delete('/whip/:room/:session', async (req, res) => {
  await redis.del(`live:${req.params.room}`);
  res.sendStatus(204);
});
```

---

## 7 關鍵實作：觀眾端拉流降級

```js
class SmartLivePlayer {
  constructor(video, room) {
    this.video = video;
    this.room = room;
  }

  async play() {
    // 嘗試順序：WebRTC → FLV → HLS
    if (await this.tryWebRTC()) {
      console.log('使用 WebRTC');
      return;
    }
    if (await this.tryFLV()) {
      console.log('使用 HTTP-FLV');
      return;
    }
    await this.tryHLS();
    console.log('使用 HLS（最後備援）');
  }

  async tryWebRTC() {
    try {
      const pc = new RTCPeerConnection({ iceServers: [...] });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (e) => this.video.srcObject = e.streams[0];

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitIce(pc);

      const res = await fetch(`/whep/${this.room}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error('WHEP failed');

      const answer = await res.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      this.pc = pc;
      return true;
    } catch {
      return false;
    }
  }

  async tryFLV() {
    if (!window.mpegts?.getFeatureList().mseLivePlayback) return false;
    try {
      this.flvPlayer = mpegts.createPlayer({
        type: 'flv',
        isLive: true,
        url: `https://live.example.com/live/${this.room}.flv`,
      }, {
        enableStashBuffer: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3,
      });
      this.flvPlayer.attachMediaElement(this.video);
      this.flvPlayer.load();
      await this.video.play();
      return true;
    } catch {
      return false;
    }
  }

  async tryHLS() {
    const url = `https://live.example.com/live/${this.room}.m3u8`;
    if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = url;
    } else if (window.Hls?.isSupported()) {
      this.hls = new Hls({ lowLatencyMode: true });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
    }
  }

  destroy() {
    this.pc?.close();
    this.flvPlayer?.destroy();
    this.hls?.destroy();
  }

  waitIce(pc) { /* 同 Studio */ }
}
```

---

## 8 關鍵實作：彈幕系統

### Server 廣播

```js
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';

const redis = createClient();
const sub = redis.duplicate();
await Promise.all([redis.connect(), sub.connect()]);

const wss = new WebSocketServer({ port: 3001 });
const rooms = new Map();   // room → Set<WebSocket>

wss.on('connection', (ws, req) => {
  const room = new URL(req.url, 'http://x').searchParams.get('room');
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    msg.ts = Date.now();
    // 發佈到 Redis 讓所有實例同步
    await redis.publish(`chat:${room}`, JSON.stringify(msg));
  });

  ws.on('close', () => rooms.get(room).delete(ws));
});

await sub.pSubscribe('chat:*', (raw, channel) => {
  const room = channel.split(':')[1];
  const set = rooms.get(room);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(raw);
  }
});
```

### Client 連接

```js
const chatWs = new WebSocket(`wss://chat.example.com?room=${room}`);
chatWs.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  appendChat(msg);
  danmaku.add(msg.text, 0, msg.color);   // 第 04 章的 plugin
};

function send(text) {
  chatWs.send(JSON.stringify({ user, text, color: '#fff' }));
}
```

---

## 9 部署架構

```text
┌─────────────────────────────────────────────────────┐
│              Cloudflare / Nginx                     │
│             (反向代理 + TLS termination)              │
└──────┬──────────┬───────────┬─────────┬─────────────┘
       │          │           │         │
       │ /api     │ /vod      │ /live   │ /ws
       ▼          ▼           ▼         ▼
   ┌───────┐  ┌────────┐  ┌──────┐  ┌──────────┐
   │Backend│  │ S3/R2 │  │ SRS  │  │  Chat WS │
   │ API   │  │ (HLS) │  │      │  │  Service │
   └───┬───┘  └────────┘  └──────┘  └──────────┘
       │
       │ jobs
       ▼
   ┌──────────┐
   │ Worker   │ ← ffmpeg 轉碼
   └──────────┘
```

部署順序：
1. SRS 用 docker-compose 起
2. Backend + Worker 部署到 K8s / VM
3. 影片走 S3 + CloudFront / R2 + Cloudflare
4. 設定 cron 定期清理過期直播 session

---

## 10 驗收標準

最後 self-review 清單：

```text
功能完整性：
  □ 可上傳影片並自動轉成多解析度 HLS
  □ 自定義播放器有：進度條、緩衝、字幕、倍速、ABR
  □ 直播主可瀏覽器開播，觀眾可進入直播間
  □ WebRTC 失敗能自動降級到 FLV / HLS
  □ 聊天室訊息全部即時推送
  □ 彈幕飛行流暢，不卡

品質：
  □ 點播首幀時間 < 1.5s
  □ 直播 WebRTC 路徑延遲 < 1s
  □ 同房 1000 觀眾不卡頓
  □ Chrome、Safari、iOS、Android 都能用
  □ QoS 上報能在 Grafana 看到

工程：
  □ 程式碼有 TS type
  □ 後端有 Dockerfile
  □ 有 README 說明如何啟動本地開發環境
  □ 至少有一條 CI（lint + build）
```

---

## 11 進階挑戰

完成基本版後，可以挑戰：

1. **加密影片**：用 shaka-packager + 自架 Widevine license server
2. **WebTransport + WebCodecs**：自己造一個 < 100ms 直播協定
3. **聲音轉文字字幕**：用 Whisper.cpp + WebSocket 即時字幕
4. **多語言字幕翻譯**：對接 Google Translate / OpenAI
5. **離線下載**：用 Service Worker + IndexedDB 儲存 HLS 切片
6. **支援 P2P CDN**：用 WebRTC DataChannel 與鄰近觀眾共享切片

---

## 12 課程結語

完成這個專題後，你已經具備：

- 從位元到畫面的完整理解
- 點播、直播、互動三類播放器的實戰能力
- 影音工程的問題排查與監控能力
- 對 hls.js / shaka-player / mpegts.js 原始碼的閱讀能力

接下來建議的路：

```text
深入專業領域：
  - 想做極限低延遲？深入 WebRTC + SVC + 弱網優化
  - 想做大型平台？深入 CDN、分散式轉碼、ML-based ABR
  - 想做版權保護？深入 DRM、Output Protection、Watermark
  - 想做 AI 影音？深入 WebGPU、TensorFlow.js、瀏覽器內 AI 推論
```

你已經會的：點播 + 直播 + 自定義播放器 + 網路傳輸 + QoS 監控。
這些是任何影音平台的基本盤。**剩下的，去做產品然後上線使用者**。

---

## 13 推薦延伸資源

- [Mux 部落格](https://mux.com/blog) - 業界最好的影音技術文章
- [HLS RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216)
- [MPEG-DASH ISO/IEC 23009-1](https://www.iso.org/standard/79329.html)
- [WebRTC W3C Spec](https://www.w3.org/TR/webrtc/)
- [Shaka Player Source](https://github.com/shaka-project/shaka-player)
- [hls.js Source](https://github.com/video-dev/hls.js)
- [video-dev/discord](https://video-dev.org) - 影音工程社群

---

**上一章**：[[12-performance-and-monitoring]] ｜ **回到** [README](./README.md)
