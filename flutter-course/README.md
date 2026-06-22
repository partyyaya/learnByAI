# Flutter 完整教學課程（含 Riverpod + go_router + Dio + Drift）

> 這不是一份「把官方文件翻成中文」的教學，而是一條「從 Hello World 到上架商店」的完整路線。
> 我們會先建立 Flutter 的心智模型（為什麼一切皆 Widget、畫面到底怎麼畫出來的），
> 再一路把現代 App 的四大支柱補齊：**狀態管理（Riverpod）、網路 API（Dio + Retrofit）、本機儲存（Drift / secure_storage）、打包上版（Play / App Store）**，
> 最後用一個可上線的 Capstone 專題把所有技術串起來。重點是建立「可遷移的心智模型」，而不是背 API。

---

## 課程目錄

| 章節 | 檔案 | 主題 | 狀態 |
|------|------|------|------|
| 00 | [00-course-map-and-why-flutter.md](./00-course-map-and-why-flutter.md) | 課程地圖與 Flutter 全貌（跨平台原理、渲染引擎） | 已完成 |
| 01 | [01-setup-and-project-init.md](./01-setup-and-project-init.md) | 開發環境與專案初始化 | 已完成 |
| 02 | [02-dart-language-core.md](./02-dart-language-core.md) | Dart 語言核心（null safety、async、Stream） | 已完成 |
| 03 | [03-widget-thinking-and-ui-basics.md](./03-widget-thinking-and-ui-basics.md) | Widget 思維與 UI 基礎（三棵樹、build 機制） | 已完成 |
| 04 | [04-layout-and-common-widgets.md](./04-layout-and-common-widgets.md) | 版面配置與常用元件（約束模型、列表） | 已完成 |
| 05 | [05-navigation-and-routing.md](./05-navigation-and-routing.md) | 導航與路由（go_router、deep link） | 已完成 |
| 06 | [06-state-management-riverpod.md](./06-state-management-riverpod.md) | 狀態管理（Riverpod，對比 Bloc / Provider） | 已完成 |
| 07 | [07-forms-input-validation.md](./07-forms-input-validation.md) | 表單、輸入與驗證 | 已完成 |
| 08 | [08-networking-dio-retrofit.md](./08-networking-dio-retrofit.md) | 網路 API 串接（Dio + Retrofit） | 已完成 |
| 09 | [09-local-storage.md](./09-local-storage.md) | 本機資料儲存（preferences / secure / Drift） | 已完成 |
| 10 | [10-app-architecture-layering.md](./10-app-architecture-layering.md) | 應用架構與分層（Repository + DI） | 已完成 |
| 11 | [11-theming-responsive-i18n.md](./11-theming-responsive-i18n.md) | 主題、響應式與多語系 | 已完成 |
| 12 | [12-native-integration-device.md](./12-native-integration-device.md) | 原生整合與裝置能力（Platform Channel、FCM） | 已完成 |
| 13 | [13-testing-and-quality.md](./13-testing-and-quality.md) | 測試與品質（unit / widget / integration） | 已完成 |
| 14 | [14-build-sign-and-publish.md](./14-build-sign-and-publish.md) | 打包與上版（Android / iOS / CI/CD） | 已完成 |
| 15 | [15-capstone-fullstack-app.md](./15-capstone-fullstack-app.md) | Capstone 實戰專題 | 已完成 |

---

## 課程特色

- **心智模型優先**：每個功能先問「Flutter 為什麼這樣設計」，再講「怎麼用」。例如先搞懂「Widget / Element / RenderObject 三棵樹」，後面看 `setState` 為什麼能省效能、`key` 為什麼重要，都會豁然開朗。
- **對比學習**：處處跟你可能熟悉的前端（React / Vue）或原生開發對照，讓你用舊知識接新概念，而不是從零硬背。
- **逐段解釋程式碼**：每段範例都附逐行/逐段註解，並搭配「白話翻譯」與「心智模型」小段，確保你不是「抄得動但看不懂」。
- **選型有理由**：狀態管理用 Riverpod、路由用 go_router、網路用 Dio + Retrofit、資料庫用 Drift——每個選擇都會說明「為什麼是它，以及替代方案的取捨」。
- **能上線**：不止教你寫畫面，最後會帶你完成 Android 簽章打包上 Play、iOS 憑證上 App Store / TestFlight，以及 CI/CD 自動發佈。

## 適合對象

- 會一種程式語言（JS / TS / Java / Kotlin / Swift / Python 皆可），想完整學會跨平台 App 開發的人。
- 前端工程師（React / Vue）想把網頁能力延伸到 iOS / Android 原生 App。
- 後端 / 原生工程師想用「一套程式碼跑雙平台」加速產品開發。
- 已經會寫一點 Flutter，但對「狀態管理該怎麼選、架構怎麼分層、怎麼上架」沒信心的人。

## 前置知識

- 任一程式語言的基本概念（變數、函式、類別、條件/迴圈）。Dart 我們會在第 02 章補齊，不用先學。
- 知道什麼是 JSON、HTTP 請求（GET / POST）。
- 用過命令列（terminal）跑指令、用過 Git。
- 不需要先會 iOS / Android 原生開發。

## 開發環境（總覽，細節見第 01 章）

- **Flutter SDK**：3.x（建議最新 stable）
- **編輯器**：VS Code（裝 Flutter / Dart 擴充）或 Android Studio
- **Android**：Android Studio + Android SDK（含模擬器）
- **iOS**（限 macOS）：Xcode + CocoaPods
- **裝置**：實體手機或模擬器擇一

## 學習路線建議

```text
基礎篇（必修，建立心智模型）
  00 全貌 → 01 環境 → 02 Dart → 03 Widget 思維 → 04 版面與元件

核心篇（互動與狀態）
  05 路由 go_router → 06 狀態管理 Riverpod → 07 表單與驗證

資料篇（跟世界連線）
  08 網路 API（Dio + Retrofit）→ 09 本機儲存（Drift）→ 10 架構分層

產品化篇（上線）
  11 主題/響應式/i18n → 12 原生整合 → 13 測試 → 14 打包上版

收尾（整合驗收）
  15 Capstone：做一個可上線 App，含 CI/CD 發佈
```

> 建議第一次學習就照「基礎篇 → 核心篇」順序走，先把 Widget 與狀態的心智模型建立起來，後面的網路、資料庫與架構會非常順。

---

> 準備好了嗎？從 [第 00 章：課程地圖與 Flutter 全貌](./00-course-map-and-why-flutter.md) 開始。
