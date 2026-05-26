# 第 08 章：ABR 自適應碼率與 DRM

> **學習目標**：理解播放器如何自動切換解析度、會用 EME 串接 Widevine/FairPlay 版權保護。
> **預計時數**：120 分鐘
> **先備知識**：[[07-mse-and-dash]]

---

## 1 ABR 是什麼

**Adaptive Bitrate**（自適應碼率）：根據當前網路狀況**自動切換**到合適的解析度。

```text
時間 →
頻寬 5 Mbps  : 播 1080p
頻寬 1 Mbps  : 切到 480p ────→ 切回 1080p（頻寬回升）
頻寬 200 kbps: 切到 240p
```

沒有 ABR 的世界：
- 強網的人看 480p（浪費頻寬）
- 弱網的人看 1080p（卡爆）

ABR 把這個權衡自動化。

---

## 2 ABR 演算法的兩大流派

### 2.1 Throughput-based（基於頻寬）

```text
1. 量測最近 N 個 chunk 的下載速度
2. 估計當前頻寬 = 例如 移動平均 / EWMA
3. 選一條 bandwidth < 估計頻寬 × safety_factor 的軌
```

**優點**：簡單、響應快
**缺點**：剛開始播沒歷史資料、突然斷流會誤判

### 2.2 Buffer-based（基於緩衝）

```text
1. 持續監看 buffer 還剩幾秒
2. buffer 越多 → 越敢切高
3. buffer 越少 → 越要切低保命
```

**優點**：不需要準確估頻寬
**缺點**：起播階段 buffer 為 0 沒用

### 2.3 Hybrid（混合）

業界主流，例如 [BOLA](https://arxiv.org/abs/1601.06748) 與 hls.js 的 ABR：

```text
if (起播階段) → 用 throughput
elif (buffer 充足) → 用 buffer-based
else → 兩者加權
```

---

## 3 從零實作一個簡易 ABR

```js
class SimpleABR {
  constructor(levels) {
    // levels = [{ bitrate: 600000, height: 360 }, { bitrate: 2500000, height: 720 }, ...]
    this.levels = [...levels].sort((a, b) => a.bitrate - b.bitrate);
    this.history = [];      // 最近的下載樣本
    this.currentLevel = 0;  // 從最低開始
  }

  // 每次切片下載完呼叫
  sample(bytes, durationMs) {
    const bps = (bytes * 8) / (durationMs / 1000);
    this.history.push(bps);
    if (this.history.length > 5) this.history.shift();
  }

  estimate() {
    if (this.history.length === 0) return 0;
    // 取最近 5 次的中位數作為估計
    const sorted = [...this.history].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  decide(video) {
    const bandwidth = this.estimate();
    const buffer = this.getBuffer(video);

    // Buffer-based：buffer < 5 秒就降級
    if (buffer < 5 && this.currentLevel > 0) {
      return this.currentLevel - 1;
    }

    // Throughput-based：選最高的、且 bitrate × 1.15 < 估計頻寬
    let target = 0;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (this.levels[i].bitrate * 1.15 < bandwidth) {
        target = i;
        break;
      }
    }

    // 防止頻繁切換：和當前差距 ≤ 1 不切
    if (Math.abs(target - this.currentLevel) <= 1 && buffer > 10) {
      return this.currentLevel;
    }

    return target;
  }

  getBuffer(video) {
    const b = video.buffered;
    if (!b.length) return 0;
    return b.end(b.length - 1) - video.currentTime;
  }
}
```

### 整合使用

```js
const abr = new SimpleABR(hls.levels);

setInterval(() => {
  const next = abr.decide(video);
  if (next !== abr.currentLevel) {
    console.log(`切換 ${abr.currentLevel} → ${next}`);
    abr.currentLevel = next;
    hls.currentLevel = next;   // hls.js
  }
}, 2000);
```

---

## 4 進階：EWMA 與 hls.js 內部

hls.js 的 ABR controller 用 **Exponential Weighted Moving Average**：

```js
class EWMA {
  constructor(halfLife) {
    this.alpha = halfLife > 0 ? Math.exp(Math.log(0.5) / halfLife) : 0;
    this.estimate = 0;
    this.totalWeight = 0;
  }

  sample(weight, value) {
    const adjAlpha = Math.pow(this.alpha, weight);
    this.estimate = value * (1 - adjAlpha) + adjAlpha * this.estimate;
    this.totalWeight += weight;
  }

  getEstimate() {
    if (this.totalWeight === 0) return 0;
    const zeroFactor = 1 - Math.pow(this.alpha, this.totalWeight);
    return this.estimate / zeroFactor;
  }
}

// hls.js 同時跑兩個 EWMA：快速（半衰期 3 樣本）與慢速（半衰期 10 樣本）
// 最終估計 = min(fast, slow)，這樣突然降速時能立刻反應
```

---

## 5 起播策略（Startup Bitrate）

第一段切片要選哪個解析度？三種做法：

```text
A. 最低 → 起播快但畫質差
B. 最高 → 畫質好但起播慢且容易卡
C. 探測 → 抓一段小檔測網速再決定
```

業界做法是 **A + 後台升軌**：
1. 第一段切 240p 立刻開播
2. 同時下載 240p 第二段
3. 等到 buffer > 8s 才考慮升軌
4. 第二段是 720p 就上 720p

### 並行下載多軌探測

```js
// 同時抓最低、中、最高軌的第一個切片
async function probeStartup(streams) {
  const start = performance.now();
  const results = await Promise.all(streams.map(async (s) => {
    const t0 = performance.now();
    const res = await fetch(s.firstSegmentUrl);
    const buf = await res.arrayBuffer();
    return {
      stream: s,
      bps: (buf.byteLength * 8) / ((performance.now() - t0) / 1000)
    };
  }));
  // 取結果中位數當頻寬估計
  results.sort((a, b) => a.bps - b.bps);
  return results[Math.floor(results.length / 2)].bps;
}
```

---

## 6 切換時機的工程細節

### 不要在 GOP 中間切

只能在 I-frame 切換，否則畫面會破。
HLS 切片本身就以 I-frame 開始，所以一次切換以「下一段」為粒度。

### 切換等待 buffer 用完還是立刻丟棄？

```text
策略 A：等當前 buffer 播完再切
  優：流量浪費少
  缺：使用者選了 1080p 等 20 秒才生效

策略 B：立刻 remove 後面的 buffer，重新抓
  優：使用者體驗好
  缺：剛抓的 buffer 浪費了
```

業界一般折衷：使用者**手動**切換用 B，**自動** ABR 用 A。

```js
function manualSwitch(quality) {
  // 立刻清掉 currentTime + 2 之後的 buffer
  sb.remove(video.currentTime + 2, video.duration);
  // 切換 codec / 重新抓
}
```

---

## 7 DRM 是什麼

**Digital Rights Management**：影片版權保護。
HLS 內建 AES-128 只能擋住「直接下載」，但解密 key 可以從清單抓到。
**DRM 解決的是：key 永遠不出現在 JS 層、只在硬體解密器處理**。

### 三大 DRM 系統

| 系統 | 廠商 | 支援平台 |
|------|------|----------|
| **Widevine** | Google | Chrome、Android、Edge、Firefox |
| **PlayReady** | Microsoft | Edge、Xbox、Smart TV |
| **FairPlay** | Apple | Safari、iOS、tvOS |

**沒有任何 DRM 能跨所有平台**，所以 production 至少要包兩套（Widevine + FairPlay）。

---

## 8 EME API

**Encrypted Media Extensions** 是瀏覽器標準 API，串接背後的 DRM 模組（CDM）。

### 8.1 流程

```text
1. JS 監聽 video.addEventListener('encrypted', ...)
2. 取得 initData（從加密的 fMP4 解出）
3. JS 呼叫 navigator.requestMediaKeySystemAccess('com.widevine.alpha', config)
4. 建立 MediaKeys 並 attach 到 video
5. 建立 MediaKeySession，generateRequest(initData)
6. CDM 產生 License Request
7. JS 把 request 送去 License Server（你的後端）
8. License Server 回 License
9. JS 把 License 餵給 session.update()
10. CDM 解密影片，硬體渲染（JS 永遠看不到原始畫面）
```

### 8.2 程式碼

```js
async function setupDRM(video, licenseUrl) {
  const config = [{
    initDataTypes: ['cenc'],
    videoCapabilities: [
      { contentType: 'video/mp4; codecs="avc1.42E01E"' }
    ],
    audioCapabilities: [
      { contentType: 'audio/mp4; codecs="mp4a.40.2"' }
    ],
  }];

  const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', config);
  const mediaKeys = await access.createMediaKeys();
  await video.setMediaKeys(mediaKeys);

  video.addEventListener('encrypted', async (event) => {
    const session = mediaKeys.createSession();

    session.addEventListener('message', async (msgEvent) => {
      // 把 license request 送給 license server
      const response = await fetch(licenseUrl, {
        method: 'POST',
        body: msgEvent.message,
        headers: {
          'Authorization': 'Bearer USER_TOKEN',   // 認證
        },
      });
      const license = await response.arrayBuffer();
      await session.update(license);
    });

    await session.generateRequest(event.initDataType, event.initData);
  });
}
```

### 8.3 各 DRM 的 keySystem ID

```js
const KEY_SYSTEMS = {
  widevine:  'com.widevine.alpha',
  playready: 'com.microsoft.playready',
  fairplay:  'com.apple.fps.1_0',
};
```

### 8.4 用 shaka-player 處理 DRM（推薦）

shaka-player 把 DRM 細節包好：

```js
const player = new shaka.Player(video);

player.configure({
  drm: {
    servers: {
      'com.widevine.alpha': 'https://license.example.com/widevine',
      'com.apple.fps.1_0': 'https://license.example.com/fairplay',
    },
    advanced: {
      'com.apple.fps.1_0': {
        serverCertificateUri: 'https://license.example.com/fairplay/cert',
      },
    },
  },
});

// 在 license request 時加 Authorization header
player.getNetworkingEngine().registerRequestFilter((type, request) => {
  if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
    request.headers['Authorization'] = 'Bearer ' + getUserToken();
  }
});

await player.load('https://example.com/stream.mpd');
```

---

## 9 FairPlay 的特別之處

FairPlay 在 Safari 上跟其他 DRM 完全不同流程：

```text
Widevine：JS → license server (任意格式)
FairPlay：JS → 取得 certificate（一次性） → SPC → license server → CKC
```

```js
async function setupFairPlay(video) {
  // 1. 取得伺服器 certificate
  const cert = await fetch('https://example.com/fairplay/cert')
    .then(r => r.arrayBuffer());

  const access = await navigator.requestMediaKeySystemAccess('com.apple.fps.1_0', [{
    initDataTypes: ['skd'],
    videoCapabilities: [{ contentType: 'video/mp4' }],
  }]);
  const mediaKeys = await access.createMediaKeys();
  await mediaKeys.setServerCertificate(cert);
  await video.setMediaKeys(mediaKeys);

  video.addEventListener('encrypted', async (e) => {
    const session = mediaKeys.createSession();
    session.addEventListener('message', async (msgEvent) => {
      const spc = msgEvent.message;
      const ckc = await fetch('https://example.com/fairplay/license', {
        method: 'POST',
        body: spc,
      }).then(r => r.arrayBuffer());
      await session.update(ckc);
    });
    await session.generateRequest('skd', e.initData);
  });
}
```

---

## 10 License Server 後端

License Server 負責：
1. 驗證使用者身份
2. 查使用者有沒有付費
3. 設定 license 規則（過期時間、可不可以離線、可不可以 HDCP、能不能截圖）
4. 用 DRM SDK 簽發 license

```text
你不會自己實作 license server，會用：
- Google Widevine：自己跑 https://github.com/google/shaka-packager
- Apple FairPlay：必須申請 FPS deployment package
- 廠商方案：BuyDRM、PallyCon、ExpressPlay、AWS Elemental MediaPackage
```

簡化的 Node.js 範例（用商業 SDK）：

```js
app.post('/license/widevine', async (req, res) => {
  // 1. 驗證 token
  const user = await verifyToken(req.headers.authorization);
  if (!user.subscription.active) return res.sendStatus(403);

  // 2. 呼叫 DRM SDK
  const licenseRequest = req.body;
  const license = await widevineSDK.generateLicense({
    contentId: req.query.contentId,
    licenseRequest,
    policy: {
      canPersist: true,
      licenseDurationSeconds: 3600,
      hdcpEnforcement: 'HDCP_V1',
    },
  });

  res.send(Buffer.from(license));
});
```

---

## 11 Output Protection 與 HDCP

DRM 不只防破解，還規定**怎麼輸出畫面**：

| 等級 | 要求 |
|------|------|
| L3 | 軟體保護，瀏覽器最常用 |
| L1 | 必須走 TEE（Trusted Execution Environment） |
| HDCP 1.x | 4K 通常要 HDCP 2.2 以上 |

Netflix 4K 在桌面只支援 Safari + Edge，就是因為 Chrome 沒過 Widevine L1 認證。

---

## 12 整合：完整加密 HLS 播放

```html
<video id="v" controls></video>
<script src="https://cdn.jsdelivr.net/npm/shaka-player@latest/dist/shaka-player.compiled.js"></script>
<script>
async function play() {
  shaka.polyfill.installAll();
  const player = new shaka.Player(document.getElementById('v'));

  player.configure({
    abr: { enabled: true, defaultBandwidthEstimate: 1_000_000 },
    drm: {
      servers: {
        'com.widevine.alpha': 'https://drm.example.com/widevine',
        'com.apple.fps.1_0':  'https://drm.example.com/fairplay',
      },
    },
  });

  player.getNetworkingEngine().registerRequestFilter((type, req) => {
    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
      req.headers['Authorization'] = 'Bearer ' + localStorage.token;
    }
  });

  player.addEventListener('error', (e) => console.error('Shaka error:', e.detail));
  player.addEventListener('adaptation', () => {
    console.log('ABR 切換到', player.getVariantTracks().find(t => t.active));
  });

  await player.load('https://example.com/encrypted/master.m3u8');
}
play();
</script>
```

---

## 13 本章重點回顧

- ABR 是「在頻寬與緩衝之間找平衡」的演算法，核心是估頻寬與監控 buffer。
- 起播優先低碼率，後台逐步升軌，使用者手動切換則立即生效。
- DRM 三大系統（Widevine / PlayReady / FairPlay）跨平台都得包。
- EME 是瀏覽器標準 API，但實作流程很複雜，**用 shaka-player 不要自己寫**。
- License Server 要付費或自架，這層擋住「破解」與「未付費觀看」。

---

## 14 課後練習

1. 把第 06 章手刻的 mini HLS player 加上一個簡易 ABR：每抓完切片量測下載速度，決定下一段抓哪個解析度。
2. 用 shaka-player + [Widevine demo content](https://shaka-player-demo.appspot.com/) 跑一段加密影片，觀察 EME 事件。
3. 思考：為什麼 Netflix 在 Chrome 上只能 1080p？查資料寫下原因。

---

**上一章**：[[07-mse-and-dash]] ｜ **下一章**：[09-live-streaming-overview-and-flv.md](./09-live-streaming-overview-and-flv.md)
