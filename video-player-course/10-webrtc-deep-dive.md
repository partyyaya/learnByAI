# 第 10 章：WebRTC 深入與 SFU 架構

> **學習目標**：理解 WebRTC 完整流程（ICE/SDP/DTLS/SRTP），會寫一對一視訊與一對多 SFU 客戶端。
> **預計時數**：180 分鐘
> **先備知識**：[[09-live-streaming-overview-and-flv]]

---

## 1 WebRTC 是什麼

**Web Real-Time Communication**：瀏覽器原生的點對點（P2P）音視訊 + 資料通道。

```text
HLS / FLV：
  推流端 → 媒體源 → CDN → 播放端
  延遲：1-30 秒

WebRTC：
  瀏覽器 A ←──── UDP ────→ 瀏覽器 B
  延遲：< 500ms
```

主要應用：
- 視訊會議（Google Meet、Zoom Web）
- 連麥直播（互動低延遲）
- 雲遊戲、雲桌面
- 即時監控

---

## 2 三大核心 API

```text
1. MediaStream    - 採集音視訊
2. RTCPeerConnection - 建立 P2P 連線
3. RTCDataChannel - 任意資料傳輸
```

---

## 3 連線建立四大步驟

```text
1. 媒體採集 (getUserMedia)
   ↓
2. 信令交換 (SDP Offer/Answer)
   ↓
3. 網路打洞 (ICE: STUN/TURN)
   ↓
4. 媒體加密傳輸 (DTLS-SRTP)
```

下面逐一展開。

---

## 4 媒體採集

```js
const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: 'user',   // 前鏡頭 / environment
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,
  },
});

// 預覽
document.querySelector('#localVideo').srcObject = stream;
```

### 螢幕分享

```js
const screen = await navigator.mediaDevices.getDisplayMedia({
  video: { cursor: 'always' },
  audio: true,    // 部分瀏覽器支援採集系統聲音
});
```

### 列舉裝置

```js
const devices = await navigator.mediaDevices.enumerateDevices();
const cameras = devices.filter(d => d.kind === 'videoinput');
const mics    = devices.filter(d => d.kind === 'audioinput');
```

### 切換鏡頭

```js
async function switchCamera(deviceId) {
  // 停掉舊 track
  stream.getVideoTracks().forEach(t => t.stop());
  // 開新的
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } }
  });
  // 在 PeerConnection 上替換
  const sender = pc.getSenders().find(s => s.track.kind === 'video');
  await sender.replaceTrack(newStream.getVideoTracks()[0]);
}
```

---

## 5 SDP：兩個瀏覽器怎麼描述自己

**Session Description Protocol**：純文字描述「我支援什麼 codec、哪個 IP、port、加密參數」。

範例 SDP（簡化）：

```text
v=0
o=- 4611516687451516440 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=rtpmap:96 VP8/90000
a=fingerprint:sha-256 12:34:56:78:...
a=setup:actpass
a=mid:0
a=sendrecv
a=ice-ufrag:xxxx
a=ice-pwd:yyyy
a=candidate:1 1 udp 2113937151 192.168.1.5 56789 typ host
```

關鍵欄位：
- `m=video` ：媒體類型
- `a=rtpmap:96 VP8/90000` ：用 VP8，時間基準 90kHz
- `a=fingerprint` ：DTLS 證書指紋
- `a=candidate` ：候選網路位址

---

## 6 Offer / Answer 流程

```text
[ A (caller) ]                                 [ B (callee) ]
     │                                                │
     │ 1. createOffer() → SDP_A                       │
     │ 2. setLocalDescription(SDP_A)                  │
     │                                                │
     │ ──────── (透過信令伺服器) SDP_A ──────→        │
     │                                                │
     │                       3. setRemoteDescription(SDP_A)
     │                       4. createAnswer() → SDP_B
     │                       5. setLocalDescription(SDP_B)
     │                                                │
     │ ←────── (透過信令伺服器) SDP_B ───────         │
     │                                                │
     │ 6. setRemoteDescription(SDP_B)                 │
```

> 注意：WebRTC **規範本身沒有規定信令怎麼傳**。WebSocket、HTTP、Socket.io 都可以。

---

## 7 ICE：穿越 NAT 與防火牆

兩個瀏覽器幾乎都在 NAT 後面（家用 router），怎麼直連？

```text
類型 1：HOST
  「我在區網 192.168.1.5:56789」
  → 對方在同一個區網才連得到

類型 2：SRFLX (Server Reflexive)
  「STUN 伺服器告訴我，我的公網位址是 1.2.3.4:5678」
  → 大多數場景能成功

類型 3：RELAY
  「直連不行，走 TURN 伺服器轉送」
  → 100% 能成功但要花伺服器頻寬
```

### 配置 ICE Servers

```js
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.example.com:3478',
      username: 'user',
      credential: 'pass',
    },
  ],
});
```

### 監聽 candidate

```js
pc.addEventListener('icecandidate', (event) => {
  if (event.candidate) {
    // 把 candidate 透過信令傳給對方
    signaling.send({ type: 'candidate', candidate: event.candidate });
  }
});

// 收到對方的 candidate
signaling.on('candidate', (data) => {
  pc.addIceCandidate(new RTCIceCandidate(data.candidate));
});
```

---

## 8 完整一對一視訊範例

### Client A（發起方）

```js
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});

// 1. 採集本地媒體
const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
document.querySelector('#local').srcObject = localStream;

// 2. 收到遠端媒體
pc.addEventListener('track', (event) => {
  document.querySelector('#remote').srcObject = event.streams[0];
});

// 3. ICE candidate
pc.addEventListener('icecandidate', (e) => {
  if (e.candidate) signaling.send({ type: 'candidate', candidate: e.candidate });
});

// 4. 建立 offer
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
signaling.send({ type: 'offer', sdp: offer.sdp });

// 5. 收到 answer
signaling.on('answer', async (data) => {
  await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
});

// 6. 收到 candidate
signaling.on('candidate', async (data) => {
  await pc.addIceCandidate(data.candidate);
});
```

### Client B（接收方）

```js
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});

const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

pc.addEventListener('track', (event) => {
  document.querySelector('#remote').srcObject = event.streams[0];
});

pc.addEventListener('icecandidate', (e) => {
  if (e.candidate) signaling.send({ type: 'candidate', candidate: e.candidate });
});

// 收到 offer
signaling.on('offer', async (data) => {
  await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ type: 'answer', sdp: answer.sdp });
});

signaling.on('candidate', async (data) => {
  await pc.addIceCandidate(data.candidate);
});
```

### 信令伺服器（Node.js）

```js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 3000 });

const rooms = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'join') {
      const room = rooms.get(msg.room) || new Set();
      room.add(ws);
      rooms.set(msg.room, room);
      ws.room = msg.room;
    } else {
      // 廣播到房間其他人
      const room = rooms.get(ws.room);
      room?.forEach(peer => {
        if (peer !== ws && peer.readyState === 1) peer.send(raw);
      });
    }
  });
});
```

---

## 9 一對多：SFU vs MCU vs P2P

### 9.1 P2P Mesh（不推薦多人）

```text
A ↔ B
A ↔ C
A ↔ D
B ↔ C
B ↔ D
C ↔ D
```

4 人需要 6 條連線，每人上行 3 路。**5 人以上一定卡爆**。

### 9.2 MCU (Multipoint Conferencing Unit)

```text
A ──→ MCU ──→ A: (B+C+D 合成的一路畫面)
B ──→ MCU ──→ B: (A+C+D 合成的一路畫面)
```

MCU 在伺服器端把所有人合成一張畫面。
- ✅ Client 簡單，看一路畫面
- ❌ 伺服器負載極高（要轉碼）
- ❌ 沒法分別調整每個人的清晰度

### 9.3 SFU (Selective Forwarding Unit)

```text
A ──→ SFU ──→ A: B、C、D 三路原始流
B ──→ SFU ──→ B: A、C、D 三路原始流
```

SFU 不轉碼，只**轉發 RTP 封包**。
- ✅ 伺服器負載低
- ✅ Client 可選擇要不要訂閱某人、訂閱什麼解析度
- ❌ Client 解碼壓力大

**業界主流是 SFU**：mediasoup、Janus、LiveKit、Pion 都是。

---

## 10 用 mediasoup 寫 SFU client

mediasoup 是 Node.js 生態最熱門的 SFU：

```js
import * as mediasoupClient from 'mediasoup-client';

class SFUClient {
  constructor(signalingUrl) {
    this.signaling = new WebSocket(signalingUrl);
    this.device = new mediasoupClient.Device();
  }

  async join(roomId) {
    // 1. 取得伺服器的 RTP capabilities
    const routerRtpCapabilities = await this.request('getRtpCapabilities');
    await this.device.load({ routerRtpCapabilities });

    // 2. 建立 transport（推流 / 拉流各一個）
    this.sendTransport = await this.createTransport('send');
    this.recvTransport = await this.createTransport('recv');

    // 3. 推自己的視訊
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    for (const track of stream.getTracks()) {
      await this.sendTransport.produce({ track });
    }

    // 4. 收聽伺服器通知有新 producer
    this.signaling.on('newProducer', async ({ producerId, peerId }) => {
      const { id, kind, rtpParameters } = await this.request('consume', { producerId });
      const consumer = await this.recvTransport.consume({ id, producerId, kind, rtpParameters });
      this.renderRemote(peerId, consumer.track);
    });
  }

  async createTransport(direction) {
    const params = await this.request('createTransport', { direction });
    const transport = direction === 'send'
      ? this.device.createSendTransport(params)
      : this.device.createRecvTransport(params);

    transport.on('connect', async ({ dtlsParameters }, cb, errCb) => {
      try {
        await this.request('connectTransport', { id: transport.id, dtlsParameters });
        cb();
      } catch (e) { errCb(e); }
    });

    if (direction === 'send') {
      transport.on('produce', async ({ kind, rtpParameters }, cb, errCb) => {
        try {
          const { id } = await this.request('produce', { transportId: transport.id, kind, rtpParameters });
          cb({ id });
        } catch (e) { errCb(e); }
      });
    }

    return transport;
  }

  renderRemote(peerId, track) {
    let video = document.getElementById(`peer-${peerId}`);
    if (!video) {
      video = document.createElement('video');
      video.id = `peer-${peerId}`;
      video.autoplay = true;
      document.querySelector('#peers').appendChild(video);
    }
    video.srcObject = new MediaStream([track]);
  }

  request(method, data = {}) {
    // 簡化版 RPC
    return new Promise((resolve) => {
      const id = Math.random();
      this.signaling.send(JSON.stringify({ id, method, data }));
      const handler = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id === id) {
          this.signaling.removeEventListener('message', handler);
          resolve(msg.result);
        }
      };
      this.signaling.addEventListener('message', handler);
    });
  }
}
```

---

## 11 WHIP / WHEP：標準化的 WebRTC 推拉流

WebRTC 推流之前沒有統一協定，每家服務都自己一套。
2022 年 IETF 標準：

| 用途 | 協定 |
|------|------|
| 推流 | **WHIP** (WebRTC-HTTP Ingest Protocol) |
| 拉流 | **WHEP** (WebRTC-HTTP Egress Protocol) |

簡單到不行：HTTP POST 一個 SDP offer，server 回一個 answer。

### WHIP 推流範例

```js
async function whipPublish(stream, endpoint) {
  const pc = new RTCPeerConnection({ iceServers: [...] });
  stream.getTracks().forEach(track => pc.addTrack(track, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // 等所有 ICE candidate 收集完
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve();
    });
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      'Authorization': 'Bearer YOUR_TOKEN',
    },
    body: pc.localDescription.sdp,
  });

  const answerSDP = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSDP });

  // 取得 location header，可用於 DELETE 結束推流
  return res.headers.get('Location');
}

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const session = await whipPublish(stream, 'https://example.com/whip/my-stream');
```

### WHEP 拉流範例

```js
async function whepSubscribe(endpoint, video) {
  const pc = new RTCPeerConnection({ iceServers: [...] });

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.addEventListener('track', (e) => {
    video.srcObject = e.streams[0];
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });

  const answer = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
}

whepSubscribe('https://example.com/whep/some-stream', document.querySelector('#v'));
```

---

## 12 DataChannel：任意資料通道

不只能傳音視訊，**任何資料**都可以：

```js
const channel = pc.createDataChannel('chat', {
  ordered: true,         // 保證順序
  maxRetransmits: 0,     // 不重傳（適合即時資料）
});

channel.addEventListener('open', () => console.log('已開啟'));
channel.addEventListener('message', (e) => console.log('收到:', e.data));

channel.send('Hello');
channel.send(new Uint8Array([1, 2, 3]).buffer);   // 二進位也行

// 收方
pc.addEventListener('datachannel', (event) => {
  const ch = event.channel;
  ch.addEventListener('message', (e) => console.log('收到:', e.data));
});
```

應用：
- 即時聊天（比 WebSocket 延遲低）
- 雲遊戲的鍵盤/滑鼠輸入
- 多人協作（共享游標、繪圖）

---

## 13 抓 WebRTC 統計

```js
async function getStats(pc) {
  const stats = await pc.getStats();
  stats.forEach(report => {
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      console.log('收到位元組', report.bytesReceived);
      console.log('丟封包', report.packetsLost);
      console.log('Jitter', report.jitter);
      console.log('幀率', report.framesPerSecond);
      console.log('解碼幀數', report.framesDecoded);
    }
    if (report.type === 'outbound-rtp' && report.kind === 'video') {
      console.log('發送位元組', report.bytesSent);
      console.log('編碼幀數', report.framesEncoded);
    }
  });
}

setInterval(() => getStats(pc), 1000);
```

開 `chrome://webrtc-internals/` 可以看到所有正在運作的 PeerConnection 完整即時統計，**WebRTC debug 必開**。

---

## 14 進階：SVC、Simulcast

### Simulcast（同播）

推流端同時推三條解析度，SFU 根據訂閱者頻寬選擇轉發哪條：

```js
const sender = pc.addTransceiver(videoTrack, {
  direction: 'sendonly',
  sendEncodings: [
    { rid: 'high', maxBitrate: 1_500_000 },
    { rid: 'mid',  maxBitrate: 500_000, scaleResolutionDownBy: 2 },
    { rid: 'low',  maxBitrate: 200_000, scaleResolutionDownBy: 4 },
  ],
});
```

### SVC（Scalable Video Coding）

一條編碼流但**可分層**：基礎層 + 增強層。SFU 可以動態剝層。

> Google Meet、Zoom 都用 SVC（VP9 SVC）。

---

## 15 本章重點回顧

- WebRTC = MediaStream + PeerConnection + DataChannel。
- 連線流程：媒體採集 → SDP 交換 → ICE → DTLS-SRTP。
- 信令協定不在規範內，自己用 WebSocket 寫。
- 多人會議用 SFU，不要用 P2P Mesh。
- WHIP/WHEP 是新標準，把 WebRTC 變成跟 RTMP 一樣簡單的 HTTP POST。
- **`chrome://webrtc-internals/` 是 debug 神器**。

---

## 16 課後練習

1. 跑完本章的一對一視訊範例，在兩個瀏覽器分頁 / 兩台機器互通。
2. 寫一個 DataChannel 聊天室外掛接到第 04 章的 PlayerCore。
3. 找一個支援 WHEP 的服務（如 [livestream.broadcast.live](https://broadcast.live)），用本章程式碼直接拉流。

---

**上一章**：[[09-live-streaming-overview-and-flv]] ｜ **下一章**：[11-capture-and-webcodecs.md](./11-capture-and-webcodecs.md)
