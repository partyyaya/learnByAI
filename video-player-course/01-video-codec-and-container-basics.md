# 第 01 章：容器、編碼、位元率與關鍵幀

> **學習目標**：分清楚「容器」與「編碼」是兩件事，看得懂影片檔的後設資訊。
> **預計時數**：90 分鐘
> **先備知識**：[[00-course-map-and-mindset]]

---

## 1 容器 (Container) vs 編碼 (Codec)

這是 99% 新手第一個搞混的概念：

```text
影片檔 = 容器（外盒）+ 視訊編碼（畫面壓縮）+ 音訊編碼（聲音壓縮）+ 字幕/章節/縮圖
```

| 比喻 | 對應 |
|------|------|
| 紙箱 | 容器 (MP4 / WebM / MKV / TS) |
| 紙箱裡的書 | 視訊編碼 (H.264 / H.265 / VP9 / AV1) |
| 紙箱裡的 CD | 音訊編碼 (AAC / Opus / MP3) |
| 標籤紙 | metadata（時長、章節、字幕軌） |

> 同一個 `.mp4` 副檔名，**裡面可能是 H.264 也可能是 H.265**，不能用副檔名判斷支援度。

---

## 2 常見容器格式

| 容器 | 副檔名 | 特點 | 適用場景 |
|------|--------|------|----------|
| MP4 | `.mp4` `.m4v` | 相容性最佳，metadata 在檔尾（需 `faststart` 移到檔頭） | 點播主流 |
| fMP4 | `.m4s` `.mp4` | Fragmented MP4，切成小片段 | DASH、LL-HLS |
| MPEG-TS | `.ts` | 直播原生格式，可隨機插入 | 傳統 HLS |
| WebM | `.webm` | Google 推，搭配 VP8/VP9/AV1 | YouTube、開放生態 |
| Matroska | `.mkv` | 容器之王，啥都能裝 | 桌面播放器，瀏覽器不支援 |
| FLV | `.flv` | Flash 時代產物，但 RTMP/HTTP-FLV 仍在用 | 直播推流 |

### 用 ffprobe 看容器內容

```bash
$ ffprobe -v error -show_format -show_streams sample.mp4

[STREAM]
index=0
codec_name=h264          # ← 視訊編碼
codec_type=video
width=1920
height=1080
r_frame_rate=30/1        # ← 幀率
bit_rate=4500000         # ← 4.5 Mbps
[/STREAM]

[STREAM]
index=1
codec_name=aac           # ← 音訊編碼
codec_type=audio
sample_rate=48000        # ← 48kHz
channels=2
[/STREAM]

[FORMAT]
format_name=mov,mp4,m4a,3gp,3g2,mj2
duration=125.234         # ← 時長（秒）
size=70000000
[/FORMAT]
```

---

## 3 視訊編碼三大主流

### 3.1 H.264 / AVC（最相容）

- 2003 年標準，目前**所有瀏覽器、所有裝置**都支援硬體解碼。
- 在瀏覽器播放器選型時，**沒有特殊需求就用 H.264**。
- 缺點：壓縮率比新編碼差約 30–50%。

### 3.2 H.265 / HEVC（節省頻寬，但有專利地雷）

- 比 H.264 省 ~50% 頻寬。
- Safari、iOS 支援；**Chrome 在 2023 年才開始支援，Firefox 仍受限**。
- 專利費高，CDN 使用要付費，所以開放生態圈不愛。

### 3.3 AV1（未來主流）

- 開放、免權利金，壓縮率比 H.265 再省 30%。
- YouTube、Netflix、Twitch 都在推。
- 缺點：編碼非常慢，舊裝置沒有硬解（軟解吃 CPU）。

### 3.4 編碼選擇決策表

```text
你要做什麼？
├─ 一般網站點播 → H.264（baseline 相容性無敵）
├─ 高畫質 4K 點播 → H.265 / AV1 + fallback H.264
├─ 直播 → H.264（推流端硬編最快）
└─ 短影片 / 行動端 → AV1（省頻寬，新手機都有硬解）
```

---

## 4 位元率 (Bitrate)、解析度、幀率

### 三者關係

```text
畫質 ≈ f(解析度, 幀率, 位元率, 編碼效率)
```

| 解析度 | 一般點播建議碼率 (H.264) |
|--------|--------------------------|
| 360p (640x360) | 600 kbps |
| 480p (854x480) | 1000 kbps |
| 720p (1280x720) | 2500 kbps |
| 1080p (1920x1080) | 4500 kbps |
| 1440p (2560x1440) | 8000 kbps |
| 4K (3840x2160) | 16000 kbps |

> 直播會比點播再加 20–30%，因為直播編碼器沒時間做 multi-pass 優化。

### CBR vs VBR

```text
CBR (Constant Bit Rate)：每秒位元數固定
  優：頻寬可預測，直播推流首選
  缺：靜止畫面浪費頻寬，動作畫面畫質差

VBR (Variable Bit Rate)：根據內容動態調整
  優：畫質均勻，點播必用
  缺：頻寬不可預測
```

### 用 ffmpeg 實作

```bash
# CBR 編碼（直播）
ffmpeg -i input.mp4 -c:v libx264 \
  -b:v 2500k -maxrate 2500k -minrate 2500k \
  -bufsize 5000k -preset veryfast \
  -g 60 -keyint_min 60 \
  output_cbr.mp4

# VBR 編碼（點播，CRF 模式更省事）
ffmpeg -i input.mp4 -c:v libx264 \
  -crf 23 -preset slow \
  output_vbr.mp4
```

CRF（Constant Rate Factor）數字越小畫質越好：
- 18 = 視覺無損
- 23 = 預設，肉眼難辨
- 28 = 明顯壓縮

---

## 5 關鍵幀 (Keyframe) 與 GOP

這是**直播延遲、Seek 速度、ABR 切換**全部的關鍵。

### 三種幀類型

| 幀類型 | 全名 | 說明 |
|--------|------|------|
| I-frame | Intra-frame | 自己就是一張完整圖（關鍵幀） |
| P-frame | Predictive | 參考前一幀的差異 |
| B-frame | Bi-directional | 參考前後幀的差異（壓縮率最高） |

### GOP 結構

```text
GOP（Group of Pictures）:
[I] [P] [B] [B] [P] [B] [B] [P] [I] [P] [B] ...
 ↑                                  ↑
 關鍵幀                              下一個關鍵幀
 |←──────── 一個 GOP ───────────────→|
```

**關鍵性質**：影片必須從 I-frame 開始解碼，不能從中間進入。

### 為什麼 GOP 長度很重要？

```text
GOP = 2 秒：
  ✅ Seek 精細、ABR 切換快、直播延遲低
  ❌ 檔案大 30%（I-frame 多）

GOP = 10 秒：
  ✅ 檔案小
  ❌ 點擊進度條會有「跳到關鍵幀」的偏差
  ❌ 直播延遲至少 10 秒
```

**典型配置**：
- 點播：4 秒（與 HLS segment 長度對齊）
- 直播：2 秒（降低延遲）
- 低延遲直播：1 秒

### 在 ffmpeg 設定 GOP

```bash
# -g 60 表示每 60 幀一個 I-frame（30fps → 2 秒）
# -keyint_min 60 強制最小 GOP
# -sc_threshold 0 關閉場景切換時的額外 I-frame
ffmpeg -i input.mp4 \
  -c:v libx264 \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -force_key_frames "expr:gte(t,n_forced*2)" \
  output.mp4
```

`-force_key_frames` 用表達式強制每 2 秒一個 I-frame，**HLS 切片必加**。

---

## 6 音訊編碼簡述

| 編碼 | 特性 | 場景 |
|------|------|------|
| AAC | 最相容、品質好 | 預設選擇 |
| Opus | 低延遲、開源 | WebRTC、即時通訊 |
| MP3 | 老古董 | 純音樂、相容性極限 |

**幾乎所有 production 影片都用 AAC 48kHz stereo 128kbps**，這是業界默認。

```bash
ffmpeg -i input.mp4 -c:a aac -b:a 128k -ar 48000 -ac 2 output.mp4
```

---

## 7 實戰：產生一段 HLS 測試素材

把這段腳本存成 `make-hls.sh`，下載任意一個 MP4，跑一遍：

```bash
#!/bin/bash
# 產生三個解析度的 HLS 切片（720p / 480p / 360p）

INPUT=$1
OUT_DIR=./hls-output
mkdir -p $OUT_DIR

ffmpeg -i $INPUT \
  -filter_complex "[0:v]split=3[v1][v2][v3]; \
    [v1]scale=w=1280:h=720[v1out]; \
    [v2]scale=w=854:h=480[v2out]; \
    [v3]scale=w=640:h=360[v3out]" \
  \
  -map "[v1out]" -c:v:0 libx264 -b:v:0 2500k -maxrate:v:0 2750k \
  -map "[v2out]" -c:v:1 libx264 -b:v:1 1000k -maxrate:v:1 1100k \
  -map "[v3out]" -c:v:2 libx264 -b:v:2 600k  -maxrate:v:2 660k \
  \
  -map a:0 -map a:0 -map a:0 \
  -c:a aac -b:a 128k -ac 2 \
  \
  -g 48 -keyint_min 48 -sc_threshold 0 \
  -hls_time 4 \
  -hls_playlist_type vod \
  -hls_segment_filename "$OUT_DIR/v%v/segment_%03d.ts" \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  "$OUT_DIR/v%v/playlist.m3u8"
```

跑完後資料夾結構：

```text
hls-output/
├── master.m3u8         ← 主播放清單（含所有解析度資訊）
├── v0/                 ← 720p
│   ├── playlist.m3u8
│   ├── segment_000.ts
│   ├── segment_001.ts
│   └── ...
├── v1/                 ← 480p
└── v2/                 ← 360p
```

`master.m3u8` 內容會長這樣：

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720
v0/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1128000,RESOLUTION=854x480
v1/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=728000,RESOLUTION=640x360
v2/playlist.m3u8
```

這是我們在 [第 06 章 HLS](./06-hls-protocol-deep-dive.md) 會深入解析的格式。

---

## 8 常見坑

### 坑 1：MP4 無法邊下載邊播

預設 MP4 的 metadata（moov box）在檔尾，瀏覽器必須整檔下載才能播。

```bash
# 解法：把 moov 移到檔頭
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

### 坑 2：奇數解析度導致編碼失敗

H.264 要求寬高都是偶數：

```bash
# 強制寬高調整為偶數
ffmpeg -i input.mp4 -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" output.mp4
```

### 坑 3：iOS Safari 不支援 VP9 / Opus

iOS 上要播 WebM/VP9 會直接失敗，永遠記得：

```text
iOS Safari = H.264 + AAC + HLS（原生支援）
其他都要走 fallback。
```

---

## 9 本章重點回顧

- 容器（MP4）和編碼（H.264）是兩件事，副檔名不能代表全部。
- H.264 是相容性王者，AV1 是未來；直播優先 H.264。
- 位元率 = 畫質的最大決定因素，CBR 給直播、VBR 給點播。
- GOP 長度決定了「Seek 精度」和「直播延遲」。
- 用 `ffprobe` 看影片真實內容，不要被副檔名騙了。

---

## 10 課後練習

1. 用 `ffprobe` 分析三個你電腦裡的 mp4，記錄它們的 codec、bitrate、GOP 長度。
2. 用上面的 `make-hls.sh` 把一個影片切成 HLS，用瀏覽器原生 `<video>` 嘗試播放（iOS Safari 會直接成功，Chrome 會失敗——下一章開始解決）。
3. 用 `-movflags +faststart` 處理同一個 MP4，比較處理前後的 Network 載入行為。

---

**上一章**：[[00-course-map-and-mindset]] ｜ **下一章**：[02-html5-media-api.md](./02-html5-media-api.md)
