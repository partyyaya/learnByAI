# 第 05 章：HTTP Range、CDN 與漸進下載

> **學習目標**：搞懂影片在 HTTP 層是怎麼傳輸的，能 debug 任何 Network 相關的播放問題。
> **預計時數**：120 分鐘
> **先備知識**：[[02-html5-media-api]]、HTTP 基本概念

---

## 1 影片不是「下載完才播」

打開 DevTools Network，看一個 `<video src="movie.mp4">` 載入時：

```text
movie.mp4   Status: 206  Range: bytes=0-524287
movie.mp4   Status: 206  Range: bytes=0-           (head sniff)
movie.mp4   Status: 206  Range: bytes=524288-1048575
movie.mp4   Status: 206  Range: bytes=1048576-...
...
```

每個都是 `206 Partial Content`，這就是 **HTTP Range Request**。

> 原理：瀏覽器先抓檔頭看 metadata，再按需求 chunk by chunk 抓內容，使用者 seek 時直接跳到對應位元組區間。

---

## 2 HTTP Range Request 完整協定

### 2.1 Client 端

```http
GET /movie.mp4 HTTP/1.1
Host: cdn.example.com
Range: bytes=1048576-2097151
```

`Range: bytes=START-END`（包含 END，從 0 開始）

| 寫法 | 意義 |
|------|------|
| `bytes=0-499` | 第 1–500 byte |
| `bytes=500-` | 第 501 byte 到結尾 |
| `bytes=-500` | 最後 500 byte |
| `bytes=0-499,1000-1499` | 多段（很少用） |

### 2.2 Server 回應

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 1048576-2097151/52428800
Content-Length: 1048576
Content-Type: video/mp4
Accept-Ranges: bytes
ETag: "abc123"
Cache-Control: public, max-age=31536000
```

關鍵 header：
- `Accept-Ranges: bytes` ← 告訴 client「我支援 Range」
- `Content-Range: bytes START-END/TOTAL` ← 這次給的範圍 + 檔案總大小

### 2.3 如果伺服器不支援？

回 `200 OK` 整檔，瀏覽器就只能整檔下載完才播。
這也是為什麼**自架影片伺服器一定要支援 Range**。

### 2.4 用 curl 測試

```bash
# 先看伺服器支不支援
$ curl -I https://example.com/movie.mp4
HTTP/1.1 200 OK
Accept-Ranges: bytes        ← 有支援
Content-Length: 52428800

# 抓部分內容
$ curl -r 0-1023 https://example.com/movie.mp4 -o head.bin
$ curl -r 1024-2047 https://example.com/movie.mp4 -o chunk.bin
```

---

## 3 為什麼 MP4 要 `faststart`？

回顧 [第 01 章](./01-video-codec-and-container-basics.md)：MP4 的 `moov box`（metadata）預設在檔尾。

```text
不 faststart 的 MP4：
[ ftyp ][ mdat (影片資料) ][ moov ]
                              ↑ 在最後

瀏覽器流程：
  1. GET bytes=0-N        → 找不到 moov
  2. GET bytes=END-N-END  → 找到 moov
  3. 解析 moov 得知 sample 表
  4. 真正開始抓影片
```

需要兩次 Round Trip，**啟動延遲 +200ms 以上**。

faststart 後：

```text
[ ftyp ][ moov ][ mdat ]
          ↑ 在前面
```

一次抓 moov 就能播。

```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

---

## 4 CDN 的角色

```text
原站（Origin）   ←──── CDN 邊緣節點 ────→  使用者瀏覽器
   單一機房          全球幾百個 PoP          台北、東京、雪梨...
```

CDN 做三件事：
1. **就近服務**：把影片快取到離使用者最近的節點
2. **頻寬卸載**：原站只跑一次傳輸給 CDN
3. **抗 DDoS**：邊緣節點吸收流量

### 4.1 CDN 快取的關鍵 Header

```http
Cache-Control: public, max-age=31536000, immutable
ETag: "hash-of-content"
Last-Modified: Mon, 01 Jan 2025 00:00:00 GMT
```

| Header | 影音場景常用值 |
|--------|----------------|
| `Cache-Control` | `public, max-age=31536000`（影片內容不變，快取一年） |
| `ETag` / `Last-Modified` | 用 If-None-Match 做 304 |
| `Vary` | `Origin, Accept-Encoding` |

### 4.2 直播的快取策略不一樣

```http
# 主清單 (master.m3u8) - 短期快取
Cache-Control: public, max-age=10

# 子清單 (live.m3u8) - 幾乎不快取
Cache-Control: public, max-age=2

# 切片 (.ts / .m4s) - 長期快取（內容不變）
Cache-Control: public, max-age=86400
```

清單短快取讓直播延遲低，切片長快取讓 CDN 命中率高。

---

## 5 防盜鏈

不想讓人盜連你的影片到其他網站，常見三招：

### 5.1 Referer 檢查

```nginx
# Nginx 配置
location ~ \.mp4$ {
    valid_referers none blocked example.com *.example.com;
    if ($invalid_referer) {
        return 403;
    }
}
```

**缺點**：使用者直接複製 URL 還是能播，Referer 很容易偽造。

### 5.2 Token 簽名 URL（業界標準）

伺服器產生帶簽名與過期時間的 URL：

```text
https://cdn.example.com/movie.mp4?expires=1735689600&signature=abc123def
```

CDN 邊緣節點驗證簽名：

```js
// Node.js 簽名範例
const crypto = require('crypto');

function sign(path, expires, secret) {
  const data = `${path}|${expires}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${path}?expires=${expires}&signature=${sig}`;
}

const url = sign('/movie.mp4', Math.floor(Date.now()/1000) + 3600, 'mysecret');
// → /movie.mp4?expires=1735689600&signature=abc123...
```

CDN 端（Cloudflare Workers / nginx-lua）：

```js
addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const expires = parseInt(url.searchParams.get('expires'));
  const sig = url.searchParams.get('signature');

  if (Date.now() / 1000 > expires) return new Response('expired', { status: 403 });

  const expectedSig = sign(url.pathname, expires, SECRET);
  if (sig !== expectedSig) return new Response('invalid', { status: 403 });

  return fetch(event.request);
});
```

各家 CDN（Cloudflare、AWS CloudFront、Akamai）都有現成的 signed URL 機制。

### 5.3 IP 限制

簽名時把 client IP 一起編進去，CDN 收到時驗證來源 IP 是否匹配。
缺點：使用者換 WiFi 就失效。

---

## 6 CORS 與影音的奇特關係

`<video>` 的跨域行為很特別：

| 場景 | 是否需要 CORS |
|------|---------------|
| 純粹播放 | **不需要**！瀏覽器允許跨域播放 |
| `crossorigin` 屬性 | 需要 CORS header |
| 字幕（`<track>`） | **需要 CORS** |
| Canvas 截圖 | **需要 CORS + crossorigin** |
| MSE / WebCodecs | **需要 CORS** |
| 跨域 `fetch()` 載入 chunk | **需要 CORS** |

### 6.1 必要的伺服器 CORS Header

```http
Access-Control-Allow-Origin: https://yoursite.com
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges
Access-Control-Max-Age: 86400
```

> **`Access-Control-Expose-Headers` 一定要列 Content-Range**，否則 hls.js 等套件讀不到實際範圍。

### 6.2 開發時的 CORS 災難

如果你用 file:// 開 HTML 載入網路影片：

```text
Access to video at 'https://...' from origin 'null'
has been blocked by CORS policy
```

開個本地伺服器（任一個都行）：

```bash
npx serve .                    # 或
python3 -m http.server 8080    # 或
npx http-server -c-1
```

---

## 7 漸進下載策略

瀏覽器不是「一口氣下載完」也不是「需要才下載」，而是用一套自適應策略：

```text
1. 一開始下載大塊 chunk（充滿緩衝區）
2. 緩衝區到一定大小停止下載
3. 邊播邊偵測下載速度
4. 緩衝區下降時再開始下載下一塊
```

控制 buffer 大小：

```js
// 預載多少（單位：秒）
// 注意這只是「請求」，瀏覽器可以拒絕
video.preload = 'metadata';

// 動態調整下載策略：只用於高階場景（MSE 才能精細控制）
```

### 7.1 在 Network panel 觀察

打開 Chrome DevTools → Network → Media filter，你會看到：

```text
movie.mp4   Range: bytes=0-1048575       Status: 206
movie.mp4   Range: bytes=1048576-2097151 Status: 206
movie.mp4   Range: bytes=2097152-...     Status: 206
            ⏸ (緩衝充足，停止)
movie.mp4   Range: bytes=...             Status: 206  ← 緩衝下降，繼續抓
```

播放器卡頓時，看這個面板能直接判斷是**頻寬問題**還是**伺服器問題**。

---

## 8 估測網路頻寬

ABR 演算法的核心是「估測當前頻寬」。最基礎的做法：

```js
class BandwidthEstimator {
  constructor() {
    this.samples = [];   // 最近 N 次下載速度
  }

  // 每次完成一個 chunk 下載時呼叫
  sample(bytes, durationMs) {
    const bps = (bytes * 8) / (durationMs / 1000);   // bits per second
    this.samples.push(bps);
    if (this.samples.length > 10) this.samples.shift();
  }

  // 取「下四分位數」當保守估計
  estimate() {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.25)];
  }
}
```

實際用 `fetch` 量測：

```js
async function loadChunk(url) {
  const start = performance.now();
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const duration = performance.now() - start;
  estimator.sample(buf.byteLength, duration);
  return buf;
}
```

> hls.js 內部用更精細的 EWMA (指數加權移動平均)，第 08 章 ABR 會展開。

---

## 9 用 fetch 自己實作 Range 下載

實際練手：寫一個分段下載 MP4 的範例（模擬瀏覽器的行為）。

```js
async function downloadInChunks(url, chunkSize = 1024 * 1024) {
  // 先查總大小
  const headRes = await fetch(url, { method: 'HEAD' });
  const total = parseInt(headRes.headers.get('Content-Length'));
  const acceptRanges = headRes.headers.get('Accept-Ranges');

  if (acceptRanges !== 'bytes') {
    console.warn('伺服器不支援 Range');
  }

  const chunks = [];
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + chunkSize - 1, total - 1);
    const res = await fetch(url, {
      headers: { 'Range': `bytes=${offset}-${end}` }
    });

    if (res.status !== 206) {
      console.error('預期 206 但拿到', res.status);
      break;
    }

    const buf = await res.arrayBuffer();
    chunks.push(buf);
    offset += buf.byteLength;
    console.log(`已下載 ${offset} / ${total}`);
  }

  // 合併
  return new Blob(chunks, { type: 'video/mp4' });
}

// 使用
const blob = await downloadInChunks('https://.../movie.mp4');
video.src = URL.createObjectURL(blob);
```

---

## 10 影音場景的 HTTP 進階話題

### 10.1 HTTP/2 與 HTTP/3 對影音的影響

- **HTTP/2**：multiplexing 讓多個 chunk 並發下載不再卡頭
- **HTTP/3 (QUIC)**：UDP 為基底，0-RTT、抗丟包，**低延遲直播未來主流**

### 10.2 Service Worker 攔截

可以用 Service Worker 攔截影片請求做：
- 自己加密/解密
- 重新分配快取
- 加上 token

```js
// service-worker.js
self.addEventListener('fetch', (event) => {
  if (event.request.url.endsWith('.ts')) {
    event.respondWith(handleSegment(event.request));
  }
});

async function handleSegment(req) {
  const res = await fetch(req);
  const buf = await res.arrayBuffer();
  // 解密
  const decrypted = await decrypt(buf);
  return new Response(decrypted, {
    headers: { 'Content-Type': 'video/mp2t' }
  });
}
```

### 10.3 預連線優化

如果你知道接下來會請求某個域名，提前建立 TCP/TLS：

```html
<link rel="preconnect" href="https://cdn.example.com">
<link rel="dns-prefetch" href="https://cdn.example.com">
```

> 大廠如 YouTube 在使用者**滑鼠靠近播放按鈕**時就 preconnect，節省幾百 ms。

---

## 11 Network Panel Debug 工作流

播放出問題時的標準排查步驟：

```text
1. F12 → Network
   ├─ 篩選 Media / Fetch/XHR
   ├─ 看 Status：是不是 200/206？404/403？
   └─ 看 Time：哪個 chunk 慢？

2. 看 Headers：
   ├─ Range: ?
   ├─ Content-Range: ?
   ├─ Accept-Ranges: bytes 有沒有？
   └─ CORS Headers 有沒有？

3. 看 Timing：
   ├─ DNS 太久？→ preconnect
   ├─ Initial connection 太久？→ HTTP/3 / CDN
   ├─ TTFB 太久？→ 原站慢、CDN 沒命中
   └─ Content Download 太久？→ 頻寬不足

4. 看 chrome://media-internals/：
   └─ 播放器內部 log
```

---

## 12 本章重點回顧

- 影片下載是 **HTTP Range Request**，不是整檔下載。
- MP4 必須 `faststart` 否則啟動慢。
- CDN 是必備，但要正確設定 Cache-Control 與 CORS。
- 防盜鏈用 **signed URL**，不要用 Referer。
- 字幕 / Canvas / MSE 都需要 CORS Header（特別是 `Expose-Headers: Content-Range`）。
- 卡頓 90% 是網路問題，先看 Network panel。

---

## 13 課後練習

1. 用 curl 測試你 production 的影片伺服器是否支援 Range，以及 CORS 設定是否完整。
2. 寫一個簡單的 Express middleware，支援 Range Request 回應本地的 MP4。
3. 用 fetch 實作一個「並發下載」版本：把檔案切成 4 段同時下載，比較單線程速度差異。

---

**上一章**：[[04-player-state-machine-and-plugins]] ｜ **下一章**：[06-hls-protocol-deep-dive.md](./06-hls-protocol-deep-dive.md)
