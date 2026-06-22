# Vite 原理與內核完整課程

> 這不是一門「Vite 使用教學」,而是「現代前端建構工具原理 + Vite 內核」。
> 我們會從「為什麼需要建構工具」開始,一路拆到 Vite 的 dev server、依賴預打包、HMR 的實作機制,
> 最後親手寫一個 mini-vite 把所有原理串起來。重點是建立可遷移的心智模型,而不是背 API。

---

## 課程目錄

| 章節 | 檔案 | 主題 |
|------|------|------|
| 00 | [00-course-map-and-build-tools-history.md](./00-course-map-and-build-tools-history.md) | 課程地圖與建構工具演進史 |
| 01 | [01-setup-and-project-init.md](./01-setup-and-project-init.md) | 環境與專案初始化 |
| 02 | [02-native-esm-and-no-bundle-dev-server.md](./02-native-esm-and-no-bundle-dev-server.md) | 瀏覽器原生 ESM 與 No-bundle Dev Server |
| 03 | [03-dependency-pre-bundling.md](./03-dependency-pre-bundling.md) | 依賴預打包 Dependency Pre-bundling |
| 04 | [04-transform-pipeline-and-assets.md](./04-transform-pipeline-and-assets.md) | 模組轉換管線與資源處理 |
| 05 | [05-hmr-internals.md](./05-hmr-internals.md) | HMR 熱更新原理 |
| 06 | [06-plugin-system-rollup-hooks.md](./06-plugin-system-rollup-hooks.md) | Plugin 系統(上):Rollup 相容 hook |
| 07 | [07-plugin-system-vite-specific.md](./07-plugin-system-vite-specific.md) | Plugin 系統(下):Vite 專屬能力 |
| 08 | [08-production-build-rollup.md](./08-production-build-rollup.md) | 生產建構與 Rollup |
| 09 | [09-advanced-ssr-library-mpa.md](./09-advanced-ssr-library-mpa.md) | 進階場景:SSR / Library Mode / 多頁 / Monorepo |
| 10 | [10-engine-internals-rolldown.md](./10-engine-internals-rolldown.md) | 引擎內幕與 Rolldown 遷移 |
| 11 | [11-capstone-mini-vite.md](./11-capstone-mini-vite.md) | Capstone:手寫一個 mini-vite |

---

## 課程特色

- **原理優先**:每個功能先問「為什麼要這樣設計」,再講「怎麼用」。
- **對比學習**:處處跟 Webpack 對比,讓你看清 Vite 的取捨,而不是把它當魔法。
- **逐段解釋**:程式碼附逐行註解,每個觀念都有「白話翻譯」與「心智模型」。
- **可動手**:從第 01 章就能跑起來,最後一章親手實作 mini-vite。

## 適合對象

- 已經會用 Vite,但想搞懂「它到底在背後做了什麼」的前端工程師。
- 用過 Webpack,想理解「為什麼 Vite dev 啟動這麼快」的人。
- 想寫 Vite plugin、或排查建構問題卻看不懂報錯的人。
- 對前端工程化、建構工具設計有興趣的人。

## 前置知識

- 基本的 JavaScript / TypeScript(模組、`import`/`export`)。
- 用過任一前端框架(Vue 或 React 皆可)。
- 知道 npm / pnpm 怎麼裝套件。
- 搭配閱讀:本倉庫的 [TypeScript 課程](../typescript/README.md)、[Vue 源碼解析](../vue/vue-source) 會更有感。

## 學習路線建議

```
原理篇(必修)
  00 演進史 → 02 No-bundle Dev Server → 03 依賴預打包

日常篇(核心)
  01 初始化 → 04 轉換管線 → 05 HMR 原理

擴充篇(進階能力)
  06 Plugin 上 → 07 Plugin 下 → 08 生產建構

架構篇(深入)
  09 進階場景 → 10 引擎內幕與 Rolldown

實戰篇(收尾)
  11 Capstone:手寫 mini-vite
```

> 建議第一次學習就照「原理篇 → 日常篇」走,先把心智模型建立起來,後面的 plugin 與建構優化會非常順。
