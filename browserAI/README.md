# Browser AI 完整教學課程（12 週）

> 從 WebGPU 基礎一路走到 Browser LLM 與產品部署，採「每週一主題 + 每週一個可驗收作業」的實作導向課程。

---

## 課程目錄

| 週次 | 檔案 | 主題 | 重點 | 作業 | 狀態 |
|------|------|------|------|------|------|
| 01 | [01-js-ts-math-foundations.md](./01-js-ts-math-foundations.md) | 先修：JS/TS 與數學基礎 | TypedArray、ArrayBuffer、矩陣乘法、向量化概念 | 用 JS 寫 CPU 版 matrix multiply | ✅ 已完成 |
| 02 | [02-webgpu-rendering-pipeline.md](./02-webgpu-rendering-pipeline.md) | WebGPU 入門與渲染管線 | adapter/device、pipeline、command encoder | Hello Triangle + 基本互動 | ✅ 已完成 |
| 03 | [03-wgsl-shader-basics.md](./03-wgsl-shader-basics.md) | WGSL Shader 基礎 | vertex/fragment、資料傳遞、座標系 | 可調顏色與形狀的 shader demo | ✅ 已完成 |
| 04 | [04-buffer-texture-memory.md](./04-buffer-texture-memory.md) | Buffer / Texture / Memory 管理 | uniform/storage buffer、texture upload | 圖片濾鏡（灰階/模糊） | ✅ 已完成 |
| 05 | [05-compute-shader-gpgpu.md](./05-compute-shader-gpgpu.md) | Compute Shader 與 GPGPU | workgroup、dispatch、平行運算思維 | GPU 版 matrix multiply，和 CPU 比速度 | ✅ 已完成 |
| 06 | [06-webgpu-performance-optimization.md](./06-webgpu-performance-optimization.md) | WebGPU 效能分析與最佳化 | GPU timing、batching、記憶體拷貝成本 | 優化前後 benchmark 報告 | ✅ 已完成 |
| 07 | [07-browser-ai-foundations-tfjs-onnx.md](./07-browser-ai-foundations-tfjs-onnx.md) | Browser AI 入門（TensorFlow.js / ONNX 概念） | 模型格式、前後處理、推論流程 | 在瀏覽器跑簡單分類模型 | ✅ 已完成 |
| 08 | [08-onnx-runtime-web-webgpu-ep.md](./08-onnx-runtime-web-webgpu-ep.md) | ONNX Runtime Web + WebGPU EP | 模型載入、session、execution provider | 影像分類頁（上傳圖→預測結果） | ✅ 已完成 |
| 09 | [09-transformers-js-applications.md](./09-transformers-js-applications.md) | Transformers.js 應用 | 文本 embedding、分類、生成任務 | 情緒分析或摘要工具 | ✅ 已完成 |
| 10 | [10-browser-llm-webllm-local-inference.md](./10-browser-llm-webllm-local-inference.md) | Browser LLM：WebLLM / 本地推論 | 量化、token 流式輸出、記憶體限制 | 本地聊天 demo（可離線） | ✅ 已完成 |
| 11 | [11-multimedia-ai-realtime-stack.md](./11-multimedia-ai-realtime-stack.md) | 多媒體 AI：WebRTC/WebAudio/WebCodecs 整合 | 即時串流 + AI 推論 | 即時語音/影像分析 prototype | ✅ 已完成 |
| 12 | [12-productization-and-deployment.md](./12-productization-and-deployment.md) | 產品化與部署 | PWA、Service Worker 快取、錯誤回退策略 | 可部署的 Browser AI 小產品 | ✅ 已完成 |

---

## 學習路線建議

```text
第 1-2 週：基礎打底
  JS 記憶體模型 + WebGPU 渲染與命令流程

第 3-6 週：GPU 工程化
  WGSL → 資源管理 → Compute → 效能最佳化

第 7-10 週：Browser AI 核心
  TFJS/ONNX → ORT WebGPU → Transformers.js → Browser LLM

第 11-12 週：產品落地
  即時多媒體 AI → PWA 與部署維運
```

## 環境需求

- Node.js：20+（建議 LTS）
- 瀏覽器：Chrome / Edge 最新版（建議）
- 作業系統：macOS / Linux / Windows
- 建議工具：Cursor / VS Code、Chrome DevTools

---

> 開始學習：[第一課：先修 JS/TS 與數學基礎](./01-js-ts-math-foundations.md)
