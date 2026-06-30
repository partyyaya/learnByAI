# Canvas 互動圖形渲染原理課程

> 這不是一門「Canvas API 教學」,而是「**互動圖形渲染原理**」。
> 我們不會花時間背 `fillRect` 有幾個參數——那種東西 MDN 查得到。
> 我們要回答的是:當你用 Canvas,你其實是在**親手補上 DOM 平常免費送你的那台渲染引擎**。
> 從一塊只會聽繪圖指令的像素佈出發,一路造出座標系統、動畫迴圈、命中測定、場景圖、效能優化,
> 最後手寫一個 mini-Figma 白板,把所有原理串起來。重點是建立可遷移的心智模型,而不是背 API。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-and-rendering-model.md](./00-course-map-and-rendering-model.md) | 課程地圖與渲染模型心法 |
| 01 | [01-canvas-setup-render-loop-hidpi.md](./01-canvas-setup-render-loop-hidpi.md) | 環境、第一個渲染迴圈與 HiDPI 模糊 |
| 02 | [02-drawing-commands-and-state-machine.md](./02-drawing-commands-and-state-machine.md) | 繪圖基本指令與「狀態機」 |
| 03 | [03-transforms-and-matrix.md](./03-transforms-and-matrix.md) | 座標變換與矩陣:做一台可平移縮放的相機 |
| 04 | [04-text-images-and-assets.md](./04-text-images-and-assets.md) | 文字、圖片與資源處理 |
| 05 | [05-pixel-manipulation-and-image-processing.md](./05-pixel-manipulation-and-image-processing.md) | 像素級操作與影像處理 |
| 06 | [06-animation-architecture-and-timing.md](./06-animation-architecture-and-timing.md) | 動畫架構與時間管理 |
| 07 | [07-interaction-and-hit-testing.md](./07-interaction-and-hit-testing.md) | 互動與命中測定(Hit Testing) |
| 08 | [08-scene-graph-and-architecture.md](./08-scene-graph-and-architecture.md) | 場景圖與架構:在 immediate mode 上蓋一層 retained |
| 09 | [09-performance-engineering.md](./09-performance-engineering.md) | 效能工程:分層、OffscreenCanvas、Worker |
| 10 | [10-bridging-to-gpu-webgl-webgpu.md](./10-bridging-to-gpu-webgl-webgpu.md) | 跨越到 GPU:WebGL / WebGPU 的心智轉換 |
| 11 | [11-capstone-mini-figma-whiteboard.md](./11-capstone-mini-figma-whiteboard.md) | Capstone:手寫一個 mini-Figma 白板 |

---

## 課程特色

- **原理優先**:每個功能先問「為什麼 Canvas 要這樣設計」,再講「怎麼用」。
- **一條主軸貫穿**:整門課只講一件事——Canvas 是 **immediate mode(畫完即忘)**,所以你得自己補上場景、事件、動畫、髒區。每個難點都從這一句話推導出來。
- **對比學習**:處處跟 DOM / SVG / WebGL 對比,讓你看清 Canvas 的取捨,而不是把它當魔法。
- **逐段解釋**:程式碼附逐行註解,每個觀念都有「白話翻譯」與「心智模型」。
- **可動手**:從第 01 章就能跑起來,最後一章親手實作 mini-Figma 白板。

## 適合對象

- 會寫 HTML/CSS/JS,但一碰到 Canvas 就「畫得出來卻不知道為什麼,稍微一複雜就掉幀」的前端工程師。
- 想做資料視覺化、白板/流程圖編輯器、小遊戲、影像處理、簽名板,卻不知道架構該怎麼搭的人。
- 用過 Chart.js / Konva / Fabric / PixiJS,想搞懂「這些庫底層到底做了什麼」的人。
- 想理解「為什麼 Canvas 沒有 click 事件」「為什麼 Retina 螢幕上一片糊」的人。

## 前置知識

- 基本的 JavaScript(函式、物件、`requestAnimationFrame` 沒看過沒關係,本課會教)。
- 知道 DOM 大致怎麼運作(本課會大量拿它來對比)。
- 一點點國中程度的座標與三角函數(第 03 章會用到,屆時會帶你複習)。
- 搭配閱讀:本倉庫的 [影像加密課第 07 章](../image-encryption-course/07-canvas-rendering-and-hardening.md)、[影音播放器課](../video-player-course/README.md)、[Browser AI 課](../browserAI/README.md) 會更有感——它們都站在 Canvas 這塊地基上。

## 學習路線建議

```
原理篇(必修)
  00 渲染模型心法 → 01 渲染迴圈 + HiDPI → 02 狀態機

座標與資源篇(核心)
  03 變換與相機 → 04 文字圖片 → 05 像素操作

互動與架構篇(進階能力)
  06 動畫架構 → 07 命中測定 → 08 場景圖

工程篇(深入)
  09 效能工程 → 10 跨越到 GPU

實戰篇(收尾)
  11 Capstone:手寫 mini-Figma 白板
```

> 建議第一次學習就照「原理篇 → 座標與資源篇」走,先把「畫完即忘」這個心智模型建立起來,後面的命中測定與場景圖會非常順。如果你只是想做資料視覺化、不碰互動,讀到第 06 章就很夠用了。

## 預設工具與函式庫

| 用途 | 主推 | 備選 |
|------|------|------|
| 開發語言 | 原生 JS(範例為求清晰以 JS 呈現,觀念可直接搬到 TS) | TypeScript |
| 開發環境 | 任何能開 `.html` 的瀏覽器 + 一個 dev server | Vite(見本倉庫 [Vite 課](../vite-course/README.md)) |
| 2D 場景庫(對照用) | Konva / Fabric.js | PixiJS(WebGL) |
| 圖表庫(對照用) | 自己手刻 | Chart.js / ECharts |

> 本課**刻意不依賴任何框架或庫**。所有東西都用原生 Canvas API 手刻,因為這門課的目的就是讓你看懂那些庫底層在做什麼。
