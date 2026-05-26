# 前端影音播放器課程（含直播、自定義播放器、網路傳輸）

> 本課程面向「會寫 HTML/CSS/JS、但對影音傳輸與播放器原理沒概念」的前端工程師。
> 學完後你能：
> - 從零手刻一個可商用的播放器（含控制列、字幕、多解析度切換）
> - 看得懂 HLS / DASH / WebRTC 協定並能 debug 串流問題
> - 用 MSE / WebCodecs / MediaRecorder 處理任意串流場景
> - 串接直播推流（RTMP / WebRTC / WHIP）與互動（彈幕、聊天）

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-and-mindset.md](./00-course-map-and-mindset.md) | 課程地圖、影音工程心法 |
| 01 | [01-video-codec-and-container-basics.md](./01-video-codec-and-container-basics.md) | 容器格式、編碼、位元率與關鍵幀 |
| 02 | [02-html5-media-api.md](./02-html5-media-api.md) | `<video>` / `<audio>` 與 MediaElement API |
| 03 | [03-custom-player-ui.md](./03-custom-player-ui.md) | 自定義播放器 UI（控制列、進度條、字幕） |
| 04 | [04-player-state-machine-and-plugins.md](./04-player-state-machine-and-plugins.md) | 狀態機、事件總線與外掛系統 |
| 05 | [05-http-range-and-cdn.md](./05-http-range-and-cdn.md) | HTTP Range、CDN、防盜鏈與漸進下載 |
| 06 | [06-hls-protocol-deep-dive.md](./06-hls-protocol-deep-dive.md) | HLS 協定原理與 m3u8 解析 |
| 07 | [07-mse-and-dash.md](./07-mse-and-dash.md) | Media Source Extensions 與 DASH |
| 08 | [08-abr-and-drm.md](./08-abr-and-drm.md) | 自適應碼率演算法與 DRM/EME |
| 09 | [09-live-streaming-overview-and-flv.md](./09-live-streaming-overview-and-flv.md) | 直播協定總覽、HTTP-FLV 實戰 |
| 10 | [10-webrtc-deep-dive.md](./10-webrtc-deep-dive.md) | WebRTC 原理、SFU 架構、WHIP/WHEP |
| 11 | [11-capture-and-webcodecs.md](./11-capture-and-webcodecs.md) | getUserMedia、MediaRecorder、WebCodecs |
| 12 | [12-performance-and-monitoring.md](./12-performance-and-monitoring.md) | 秒開、卡頓監控、QoS / QoE 指標 |
| 13 | [13-capstone-project.md](./13-capstone-project.md) | 畢業專題：點播 + 直播 + 彈幕平台 |

---

## 學習路徑建議

```
基礎篇 (00-02) ──┐
                ├─→ 應用篇 (03-04 自定義播放器)
                │
                ├─→ 串流篇 (05-08 HLS/DASH/MSE/DRM)
                │
                ├─→ 直播篇 (09-11 WebRTC/推流)
                │
                └─→ 工程篇 (12-13 效能監控與專題)
```

- **趕時間先學會做事**：00 → 02 → 03 → 06 → 09，先能做出點播+直播播放器。
- **想理解原理**：依序學完，每章都會解構協定與瀏覽器 API。
- **已是中階工程師**：可直接從 05 開始，前面當作複習。

---

## 預設工具與函式庫

| 用途 | 主推 | 備選 |
|------|------|------|
| HLS 播放 | `hls.js` | `shaka-player` |
| DASH 播放 | `shaka-player` | `dash.js` |
| FLV 播放 | `mpegts.js`（前身 flv.js） | — |
| 直播 SDK | 原生 `RTCPeerConnection` + WHIP | `mediasoup-client` |
| 開發語言 | TypeScript（章節範例為求簡潔以 JS 呈現） | — |
| 抓包工具 | Chrome DevTools、Wireshark、`mediainfo` CLI | `ffprobe` |

---

## 你將會得到

- 一份**從位元到畫面**的完整心智模型，看到一個影片不再只是「黑盒子」。
- 可直接拿去用的播放器骨架（含 HLS、DASH、低延遲直播）。
- 一套針對影音工程的 debug 流程（網路 → MSE → 解碼 → 渲染）。
- 對 YouTube / Bilibili / Twitch 等大型平台技術選型的判讀能力。

---

建議從 [00-course-map-and-mindset.md](./00-course-map-and-mindset.md) 開始。
