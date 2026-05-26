# 第 00 章：課程地圖與影音工程心法

> **學習目標**：建立影音工程的整體心智模型，知道每章在解決什麼問題。
> **預計時數**：60 分鐘

---

## 1 為什麼影音這麼複雜？

一段「使用者點擊播放按鈕」到「螢幕看到畫面」的過程，背後其實是這樣：

```text
[ 原始影片檔 ]
   ↓ 編碼（H.264 / AV1）
[ 壓縮後的 bitstream ]
   ↓ 封裝（MP4 / TS / fMP4）
[ 容器檔案 ]
   ↓ 切片 + 索引（HLS / DASH）
[ CDN 邊緣節點 ]
   ↓ HTTP / HTTPS / WebSocket
[ 瀏覽器 ]
   ↓ MSE / WebCodecs
[ <video> 元素 ]
   ↓ GPU 解碼 + 合成
[ 你看到的畫面 ]
```

任何一個環節壞掉，使用者都會看到「轉圈圈」、「黑畫面」、「破圖」或「卡頓」。
影音工程師要做的，就是**在每一層提供可觀測性與可恢復性**。

---

## 2 三個維度認識影音

我建議用三個軸來理解每個技術：

### 軸一：時間特性

| 類型 | 延遲要求 | 典型協定 |
|------|----------|----------|
| 點播 (VOD) | 不在意延遲，只在意畫質與秒開 | HLS、DASH、漸進下載 |
| 直播（一般） | 5–30 秒可接受 | HLS、HTTP-FLV |
| 低延遲直播 | 1–3 秒（電商、體育） | LL-HLS、LL-DASH |
| 即時互動 | < 500ms（連麥、視訊會議） | WebRTC |

### 軸二：傳輸層

| 傳輸 | 特性 | 場景 |
|------|------|------|
| HTTP / HTTPS | 防火牆友好、CDN 成熟 | 點播、HLS、DASH |
| WebSocket | 雙向、長連線 | 彈幕、FLV-over-WS |
| WebRTC (UDP) | 低延遲、抗弱網 | 即時互動 |

### 軸三：解碼端

| 方案 | 控制度 | 場景 |
|------|--------|------|
| `<video>` 原生 | 低（瀏覽器自管） | Safari 上的 HLS |
| MSE | 中（自己餵 chunk） | hls.js / dash.js |
| WebCodecs | 高（自己解碼每一幀） | 自定義渲染、低延遲 |

---

## 3 影音工程師最常用的 Debug 工具

學會這幾個工具，你的問題排查效率會翻倍：

```bash
# 1. ffprobe：看影片內部結構（容器、編碼、幀率）
ffprobe -v error -show_format -show_streams sample.mp4

# 2. ffmpeg：轉碼、切片、產生測試素材
ffmpeg -i input.mp4 -c:v libx264 -b:v 1000k -hls_time 4 out.m3u8

# 3. mediainfo：更人類可讀的影片資訊
mediainfo sample.mp4

# 4. wireshark：抓 RTMP / WebRTC 封包
# 5. Chrome DevTools → Network → Media 篩選器
# 6. chrome://media-internals/：看瀏覽器解碼狀態
```

> **小技巧**：開發時把 `chrome://media-internals/` 開著，任何播放器錯誤都會在這裡留下完整 log。

---

## 4 心法五則

這幾條會在後續每一章不斷出現，先記住：

### 心法 1：影音問題 90% 是網路問題

「卡頓」幾乎都不是播放器寫得差，而是：
- CDN 邊緣節點抓不到
- TCP / TLS 連線太慢
- 頻寬不足 ABR 沒切換到低碼率

**先看 Network panel，再看播放器 log。**

### 心法 2：別重造輪子，但要看得懂輪子

不要自己實作 HLS / DASH 解析器，直接用 `hls.js`、`shaka-player`。
但你必須看得懂它們的事件、配置與原始碼，否則出問題會卡住。

### 心法 3：所有播放器都是一台狀態機

`idle → loading → playing ⇌ buffering → ended / error`

UI、事件、外掛全部圍繞這台狀態機運作。設計時先畫狀態圖，再寫程式碼。

### 心法 4：直播是「容忍延遲換流暢度」的權衡

低延遲（WebRTC）= 不穩、容易掉幀
高延遲（HLS）= 順暢、起播慢

**沒有「最好」的協定，只有「最合適」的協定。**

### 心法 5：相容性永遠是第一公民

- iOS Safari 不能用 MSE 播 HLS（會用原生）
- 自動播放幾乎都會被瀏覽器擋（需要 muted）
- WebRTC 在某些 Android WebView 上會炸

寫 production 程式碼一定要做 capability detection。

---

## 5 跑一遍 Hello World

開始正式上課前，先確認你的環境能跑：

```html
<!DOCTYPE html>
<html>
<body>
  <video id="player" controls width="640" muted autoplay></video>
  <script>
    const video = document.getElementById('player');
    // 公開測試素材（Mux 提供）
    video.src = 'https://stream.mux.com/VZtzUzGRv02OhRnZCxcNg49OilvolTqdnFLEqBsTwaxU/medium.mp4';

    video.addEventListener('loadedmetadata', () => {
      console.log('時長', video.duration, '秒');
      console.log('原始解析度', video.videoWidth, 'x', video.videoHeight);
    });
  </script>
</body>
</html>
```

開瀏覽器、打開 DevTools，你應該看到：
- Network 面板裡有大量 `Range: bytes=...` 請求（漸進下載）
- Console 印出影片時長與解析度
- 影片自動靜音播放

如果你能想像出**為什麼是 Range 請求而不是一次下載完**——很好，這就是 [第 05 章](./05-http-range-and-cdn.md) 要講的。

---

## 6 本章重點回顧

- 影音播放是「編碼 → 封裝 → 傳輸 → 解碼 → 渲染」的多層管線。
- 點播、直播、低延遲、即時互動是四個完全不同的工程問題。
- 90% 影音問題其實是網路問題。
- 播放器本質上是狀態機，狀態機畫好程式才不會亂。

---

**下一章**：[01-video-codec-and-container-basics.md](./01-video-codec-and-container-basics.md) — 容器、編碼、位元率與關鍵幀
