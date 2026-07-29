# Vue 3 源碼解析課程（11 週）

> 這門課不是背 API，而是建立「看得懂、追得動、改得準」的源碼能力。  
> 你會從 `reactivity` 走到 `runtime-core`、再到 `compiler-core`，最後能用調試與最小實作驗證理解。

---

## 課程目錄

| 章節 | 檔案 | 主題 | 重點 | 作業 | 狀態 |
|------|------|------|------|------|------|
| 00 | [00-course-map-and-debug-setup.md](./00-course-map-and-debug-setup.md) | 課程地圖與源碼調試準備 | monorepo 結構、建置與 debug 流程、閱讀策略 | 建好可追蹤 Vue 核心流程的調試環境 | ✅ 已完成 |
| 01 | [01-reactivity-core-track-trigger-effect.md](./01-reactivity-core-track-trigger-effect.md) | Reactivity 核心：`track` / `trigger` / `effect` | 依賴收集、觸發更新、effect stack、`ref` vs `reactive` | 手寫 mini-reactivity（可跑基本案例） | ✅ 已完成 |
| 02 | [02-computed-watch-scheduler.md](./02-computed-watch-scheduler.md) | `computed` / `watch` / scheduler | lazy 計算、dirty 快取、watch flush 時機、job queue | 實作 mini-computed + mini-watch + 排程器 | ✅ 已完成 |
| 03 | [03-renderer-vnode-patch.md](./03-renderer-vnode-patch.md) | Renderer 主線：VNode 到 patch | 掛載、更新、核心 diff 心智模型 | 追 `mount` 與 `patch` 的主要呼叫鏈 | ✅ 已完成 |
| 04 | [04-component-lifecycle-and-update.md](./04-component-lifecycle-and-update.md) | 組件生命週期與更新流程 | `setup`、render effect、生命周期 hook、更新時機 | 製作生命周期執行時序圖 | ✅ 已完成 |
| 05 | [05-diff-keyed-children.md](./05-diff-keyed-children.md) | keyed diff 與 LIS 優化 | 最長遞增子序列、最小移動策略、patch flags 影響 | 手動畫出一個 keyed diff 範例 | ✅ 已完成 |
| 06 | [06-compiler-parse-transform-codegen.md](./06-compiler-parse-transform-codegen.md) | 編譯器：parse/transform/codegen | AST、節點轉換、輸出 render function | 寫一個簡化 transform pass | ✅ 已完成 |
| 07 | [07-compile-optimization-hoist-patchflags.md](./07-compile-optimization-hoist-patchflags.md) | 編譯最佳化 | static hoist、block tree、patch flags | 比較優化前後 render code 差異 | ✅ 已完成 |
| 08 | [08-advanced-builtins-teleport-keepalive-suspense.md](./08-advanced-builtins-teleport-keepalive-suspense.md) | 進階內建機制 | Teleport、KeepAlive、Suspense | 做一份三者適用場景對照表 | ✅ 已完成 |
| 09 | [09-sfc-and-vite-integration.md](./09-sfc-and-vite-integration.md) | SFC 與 Vite 整合鏈路 | `<script setup>` 編譯、plugin pipeline | 追一次 `.vue` 到瀏覽器執行的路徑 | ✅ 已完成 |
| 10 | [10-practical-source-reading-workflow.md](./10-practical-source-reading-workflow.md) | 真實專案的源碼閱讀工作流 | issue 重現、定位、修補、驗證 | 完成一份源碼分析與修正提案 | ✅ 已完成 |
| 11 | [11-real-world-performance-optimization.md](./11-real-world-performance-optimization.md) | 真實專案的效能優化實戰 | 響應式/渲染/載入三層成本、使用方式改寫對照、Review checklist | 用 checklist 找出 5 個優化點並做 before/after 量測 | ✅ 已完成 |

---

## 建議學習節奏

```text
第一階段（00-02）：響應式基礎與調度心智模型
  建立 track/trigger/effect + computed/watch/scheduler 的主鏈理解

第二階段（03-05）：渲染與更新
  從 VNode 建立到 patch 更新，掌握組件與 diff 的核心路徑

第三階段（06-07）：編譯器與優化
  理解 template 如何變成 render function，及其最佳化策略

第四階段（08-11）：高階能力與實務落地
  深入內建能力、SFC 編譯整合，做真實問題分析，最後落地效能優化實戰
```

## 先備知識

- JavaScript（閉包、原型、Promise / microtask）
- TypeScript（基本型別與泛型即可）
- 熟悉 Vue 使用層（至少寫過 composition API）

## 閱讀原則

- 先跑通主鏈，再看分支：先理解 70% 主流程，比細節全讀更有效
- 每章至少做一次「斷點追蹤 + 時序圖整理」
- 每學一個機制，都做 mini 版本驗證（避免停留在概念）

---

> 建議從 [00：課程地圖與源碼調試準備](./00-course-map-and-debug-setup.md) 開始，再進入 [01：Reactivity 核心](./01-reactivity-core-track-trigger-effect.md)。

---

> **前瞻（非本課範圍，一句話帶過）**：Vue 正在發展 **Vapor mode**（`runtime-vapor` / `compiler-vapor`，把模板編成直接操作 DOM、免虛擬 DOM 的模式），響應式核心也在 3.6 往 **signals**（採 alien-signals 演算法）演進；本課仍以 **Vue 3.5.x + 虛擬 DOM** 為主，上述屬未來方向、細節可能變動。
