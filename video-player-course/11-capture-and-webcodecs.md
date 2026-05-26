# 第 11 章：採集 API 與 WebCodecs

> **學習目標**：能在瀏覽器內錄影、用 WebCodecs 做極低延遲編解碼、混合彈幕到影片畫面。
> **預計時數**：150 分鐘
> **先備知識**：[[10-webrtc-deep-dive]]

---

## 1 從採集到輸出的完整鏈路

```text
[ 採集 ]              [ 處理 ]              [ 編碼 ]            [ 輸出 ]
getUserMedia          Canvas / WebGL        WebCodecs          MediaRecorder
getDisplayMedia       MediaStreamTrack       VideoEncoder      WebRTC
                     Processor             AudioEncoder        WHIP push
                                                              下載成 mp4
```

---

## 2 進階：MediaStreamTrack 處理

### 2.1 動態調整解析度與幀率

```js
const track = stream.getVideoTracks()[0];
await track.applyConstraints({
  width: 1920,
  height: 1080,
  frameRate: 30,
});

// 查詢能力
const capabilities = track.getCapabilities();
console.log(capabilities);
// {
//   width: { max: 4096 },
//   frameRate: { max: 60 },
//   facingMode: ['user', 'environment'],
//   ...
// }
```

### 2.2 從 Canvas 產生 MediaStream

把任意 Canvas 內容當成攝影機輸入：

```js
const canvas = document.createElement('canvas');
canvas.width = 1280; canvas.height = 720;
const ctx = canvas.getContext('2d');

// 持續繪製
function draw() {
  ctx.fillStyle = `hsl(${Date.now() / 10 % 360}, 80%, 50%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = '60px sans-serif';
  ctx.fillText(new Date().toLocaleTimeString(), 100, 100);
  requestAnimationFrame(draw);
}
draw();

// 轉成 MediaStream（30fps）
const stream = canvas.captureStream(30);

// 可以直接送到 video / WebRTC
document.querySelector('video').srcObject = stream;
```

### 2.3 把彈幕疊到攝影機畫面（直播主必用）

```js
async function startMixedStream() {
  const cam = await navigator.mediaDevices.getUserMedia({ video: true });
  const camVideo = document.createElement('video');
  camVideo.srcObject = cam;
  camVideo.muted = true;
  await camVideo.play();

  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');

  const danmakus = [
    { text: '666', x: 1280, y: 100, speed: 3 },
    { text: '好可愛', x: 1280, y: 300, speed: 4 },
  ];

  function draw() {
    ctx.drawImage(camVideo, 0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#fff';
    ctx.font = '28px sans-serif';
    danmakus.forEach((d) => {
      d.x -= d.speed;
      if (d.x < -200) d.x = canvas.width;
      ctx.fillText(d.text, d.x, d.y);
    });

    requestAnimationFrame(draw);
  }
  draw();

  return canvas.captureStream(30);
}

const mixedStream = await startMixedStream();
// 推到 WebRTC / 錄影都行
```

---

## 3 MediaRecorder：瀏覽器內錄影

不用後端就能在瀏覽器內錄影：

```js
async function record() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

  // 檢查 codec 支援
  const types = [
    'video/webm; codecs="vp9,opus"',
    'video/webm; codecs="vp8,opus"',
    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',  // Safari
  ];
  const mimeType = types.find(t => MediaRecorder.isTypeSupported(t));

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 128_000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);

    // 預覽
    const v = document.createElement('video');
    v.src = url; v.controls = true;
    document.body.appendChild(v);

    // 下載
    const a = document.createElement('a');
    a.href = url; a.download = 'recording.webm';
    a.click();
  };

  recorder.start(1000);   // 每 1 秒觸發一次 dataavailable

  // 30 秒後停止
  setTimeout(() => recorder.stop(), 30_000);
}
```

### 注意事項

- `start(timeslice)` 參數決定每隔多久產出一個 chunk
- Safari 只支援 mp4，不支援 webm
- 錄到的影片時間戳可能不準，需要後處理

---

## 4 WebCodecs：瀏覽器原生編解碼器

2022 年才穩定的新 API，**直接存取 H.264/VP9/AV1 編解碼器**。
等於把 ffmpeg 一部分搬進了瀏覽器。

### 為什麼需要 WebCodecs？

| 場景 | 傳統方案 | WebCodecs |
|------|----------|-----------|
| 低延遲直播 | MSE 至少 200ms 緩衝 | < 50ms |
| 自定義渲染 | 只能用 `<video>` | 直接 ImageBitmap |
| 雲遊戲 | 受 MSE 限制 | 完全可控 |
| 自定義協定 | 必須轉成 fMP4 | 直接餵 codec |

### 4.1 VideoDecoder 範例

```js
const decoder = new VideoDecoder({
  output: (frame) => {
    // 解碼出一幀，是 VideoFrame
    // 可以畫到 canvas、傳給 WebGL、ImageBitmap
    ctx.drawImage(frame, 0, 0);
    frame.close();   // ★ 一定要 close，否則洩漏記憶體
  },
  error: (err) => console.error(err),
});

decoder.configure({
  codec: 'avc1.42E01E',
  codedWidth: 1280,
  codedHeight: 720,
  description: avcCParams,    // ← SPS/PPS（從 fMP4 init 解出）
});

// 餵 chunk
function decodeChunk(data, isKey, timestamp) {
  const chunk = new EncodedVideoChunk({
    type: isKey ? 'key' : 'delta',
    timestamp,           // 微秒
    data,                // ArrayBuffer (一個 NAL unit)
  });
  decoder.decode(chunk);
}
```

### 4.2 VideoEncoder 範例

```js
const encoder = new VideoEncoder({
  output: (chunk, metadata) => {
    // 取得編碼後 H.264 / VP9 chunk
    if (chunk.type === 'key' && metadata.decoderConfig) {
      // 第一個 key frame 通常會帶 description
      console.log('Init:', metadata.decoderConfig.description);
    }
    sendOverNetwork(chunk);
  },
  error: (err) => console.error(err),
});

encoder.configure({
  codec: 'avc1.42E01E',
  width: 1280,
  height: 720,
  bitrate: 2_000_000,
  framerate: 30,
  latencyMode: 'realtime',     // 即時 / quality
  hardwareAcceleration: 'prefer-hardware',
});

// 從 MediaStreamTrack 抓 frames
const track = stream.getVideoTracks()[0];
const processor = new MediaStreamTrackProcessor({ track });
const reader = processor.readable.getReader();

async function pump() {
  while (true) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    encoder.encode(frame);
    frame.close();
  }
}
pump();
```

---

## 5 用 WebCodecs 寫超低延遲直播

把 WebSocket-based 直播延遲壓到 100ms 內：

### 5.1 推流端（攝影機 → WebSocket）

```js
const ws = new WebSocket('wss://live.example.com/push');

const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } });

const encoder = new VideoEncoder({
  output: (chunk, metadata) => {
    if (metadata.decoderConfig?.description) {
      // 先傳一個 init 包
      ws.send(JSON.stringify({
        type: 'init',
        config: {
          codec: metadata.decoderConfig.codec,
          codedWidth: metadata.decoderConfig.codedWidth,
          codedHeight: metadata.decoderConfig.codedHeight,
          description: Array.from(new Uint8Array(metadata.decoderConfig.description)),
        },
      }));
    }
    const data = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(data);
    ws.send(data);   // 二進位 chunk
  },
  error: console.error,
});

encoder.configure({
  codec: 'avc1.42E01E',
  width: 1280, height: 720,
  bitrate: 2_000_000,
  framerate: 30,
  latencyMode: 'realtime',
});

const processor = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] });
const reader = processor.readable.getReader();
let frameCount = 0;
while (true) {
  const { value: frame, done } = await reader.read();
  if (done) break;
  encoder.encode(frame, { keyFrame: frameCount++ % 60 === 0 });
  frame.close();
}
```

### 5.2 拉流端（WebSocket → Canvas）

```js
const ws = new WebSocket('wss://live.example.com/pull');
ws.binaryType = 'arraybuffer';

const canvas = document.querySelector('#out');
const ctx = canvas.getContext('2d');

let decoder;

ws.onmessage = async (e) => {
  if (typeof e.data === 'string') {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      decoder = new VideoDecoder({
        output: (frame) => {
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
        },
        error: console.error,
      });
      decoder.configure({
        codec: msg.config.codec,
        codedWidth: msg.config.codedWidth,
        codedHeight: msg.config.codedHeight,
        description: new Uint8Array(msg.config.description),
      });
    }
  } else {
    // 假設首個 byte 標記 key/delta（自定協定）
    const view = new Uint8Array(e.data);
    const isKey = view[0] === 1;
    const chunk = new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: performance.now() * 1000,
      data: e.data.slice(1),
    });
    decoder.decode(chunk);
  }
};
```

> 這套架構業界叫 **WebTransport + WebCodecs**，是 Twitch、Cloudflare Stream 在研究的方向。

---

## 6 截圖：從 video 抓畫面

### 6.1 用 Canvas

```js
function captureFrame(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.9);
}

const dataUrl = captureFrame(document.querySelector('video'));
```

⚠️ 影片必須有 CORS header 才能 drawImage，否則 Canvas 變「tainted」無法讀取像素。

### 6.2 用 captureStream

```js
const stream = video.captureStream();
const recorder = new MediaRecorder(stream);
// 從 video 元素產生 stream，再餵給 recorder → 等於把播放中的影片錄下來
```

### 6.3 用 ImageCapture API（新）

```js
const track = stream.getVideoTracks()[0];
const imageCapture = new ImageCapture(track);

const blob = await imageCapture.takePhoto();
const bitmap = await imageCapture.grabFrame();   // ImageBitmap
```

---

## 7 即時影像處理（AI 濾鏡 / 背景去除）

把 video 透過 Canvas → WebGL/MediaPipe → 重新輸出：

```js
import * as bodyPix from '@tensorflow-models/body-pix';

async function backgroundRemoval(stream) {
  const net = await bodyPix.load();
  const video = document.createElement('video');
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  async function tick() {
    const segmentation = await net.segmentPerson(video);

    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = imageData.data;
    for (let i = 0; i < segmentation.data.length; i++) {
      if (!segmentation.data[i]) {
        // 不是人 → 透明
        px[i * 4 + 3] = 0;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    requestAnimationFrame(tick);
  }
  tick();

  return canvas.captureStream(30);
}

const cleanStream = await backgroundRemoval(await navigator.mediaDevices.getUserMedia({ video: true }));
```

---

## 8 在 Worker 內跑 WebCodecs（強烈推薦）

Main thread 跑解碼會卡 UI，正式產品都用 Worker：

```js
// main.js
const worker = new Worker('decoder-worker.js');

const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);

ws.onmessage = (e) => {
  worker.postMessage({ type: 'chunk', data: e.data }, [e.data]);
};
```

```js
// decoder-worker.js
let decoder, ctx;

onmessage = (e) => {
  if (e.data.type === 'init') {
    ctx = e.data.canvas.getContext('2d');
    decoder = new VideoDecoder({
      output: (frame) => {
        ctx.drawImage(frame, 0, 0);
        frame.close();
      },
      error: console.error,
    });
    decoder.configure({ /* ... */ });
  } else if (e.data.type === 'chunk') {
    decoder.decode(new EncodedVideoChunk({ /* ... */ }));
  }
};
```

`OffscreenCanvas` + Worker = 主執行緒永不卡頓。

---

## 9 把錄影 / 串流轉成 mp4

MediaRecorder 預設給 webm，要 mp4 有兩條路：

### 路線 A：用 mp4-muxer / mp4box.js

```js
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const muxer = new Muxer({
  target: new ArrayBufferTarget(),
  video: { codec: 'avc', width: 1280, height: 720 },
  audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 },
  fastStart: 'in-memory',
});

// 把 WebCodecs 編碼結果丟進去
encoder.output = (chunk, meta) => {
  muxer.addVideoChunk(chunk, meta);
};

// 結束
muxer.finalize();
const buffer = muxer.target.buffer;
const blob = new Blob([buffer], { type: 'video/mp4' });
```

### 路線 B：ffmpeg.wasm

```js
import { FFmpeg } from '@ffmpeg/ffmpeg';

const ffmpeg = new FFmpeg();
await ffmpeg.load();

await ffmpeg.writeFile('in.webm', await fetchFile(webmBlob));
await ffmpeg.exec(['-i', 'in.webm', '-c', 'copy', 'out.mp4']);
const data = await ffmpeg.readFile('out.mp4');
```

ffmpeg.wasm 強大但容量大（30MB+），看需求選。

---

## 10 WebTransport：未來的 WebSocket 替代

WebSocket 的問題：基於 TCP，丟封包會 head-of-line blocking。
**WebTransport** 基於 QUIC，無 HOL、有 datagram、有多 stream，**為低延遲直播設計**。

```js
const transport = new WebTransport('https://live.example.com');
await transport.ready;

// 雙向 stream
const stream = await transport.createBidirectionalStream();
const writer = stream.writable.getWriter();
await writer.write(new TextEncoder().encode('hello'));

// Datagram（不保證送達但極低延遲）
const writer2 = transport.datagrams.writable.getWriter();
writer2.write(new Uint8Array([1, 2, 3]));

// 接收
const reader = transport.datagrams.readable.getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  console.log(value);
}
```

> WebTransport + WebCodecs 是目前**唯一能在瀏覽器做到 < 100ms 直播**的方案。

---

## 11 本章重點回顧

- `getUserMedia` / `getDisplayMedia` 是採集入口。
- Canvas + `captureStream` 是「把任意畫面變成 MediaStream」的萬能工具。
- MediaRecorder 是最簡單的瀏覽器內錄影。
- WebCodecs 把編解碼器搬進 JS，是低延遲直播與雲遊戲的關鍵。
- 解碼必須在 Worker 跑、`VideoFrame` 必須 `.close()` 否則記憶體爆。
- WebTransport 是未來，配 WebCodecs 能做到 < 100ms 延遲。

---

## 12 課後練習

1. 寫一個「美顏 / 濾鏡」工具：getUserMedia 拿到視訊 → Canvas 套濾鏡 → captureStream 推給 WebRTC。
2. 用 MediaRecorder 寫一個「30 秒短影音錄製器」，輸出 mp4 / webm 並可預覽。
3. 把第 09 章的直播改用 WebCodecs + WebSocket 推流，與 mpegts.js 版本對比首幀時間。

---

**上一章**：[[10-webrtc-deep-dive]] ｜ **下一章**：[12-performance-and-monitoring.md](./12-performance-and-monitoring.md)
