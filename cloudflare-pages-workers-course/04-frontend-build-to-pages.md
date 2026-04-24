# 04｜前端打包與部署到 Pages

> 這章會把「前端程式碼 -> 打包產物 -> Cloudflare Pages 上線」跑完一次，並建立可重複迭代的部署基線。

## 學習目標

- 能把 Vite/React 打包結果部署到 Cloudflare Pages。
- 理解 CLI 快速部署與 Git 自動部署的差異與使用時機。
- 能完成 SPA 路由、環境變數、版本回溯等基本設定。

## 前置條件

- 已完成 `00`~`03` 章，並可使用 `wrangler`。
- 你有一個可正常執行 `npm run build` 的前端專案。
- 專案已放在 GitHub/GitLab（建議，方便後續 CI/CD）。

## 成功標準（完成本章後你應該做到）

1. 首次部署成功，取得一個 Pages 網址。
2. 修改前端程式後可再部署，且版本可追蹤。
3. 知道如何處理 SPA 重新整理的 `404` 問題。

## 核心觀念

- **Pages 的本質是靜態資產交付**
  - 你部署的是 `dist/`（或 `.output/public`）等 build 產物，不是原始碼本身。
- **兩條部署路線**
  - CLI：快、適合本機驗證或教學演練。
  - Git 連線：穩、適合團隊長期迭代。
- **環境分離**
  - Preview 與 Production 要有不同變數，避免測試資料污染正式環境。

## 實作步驟 A：用 CLI 完成首次部署

### 1) 建立或準備前端專案

```bash
# 若你已經有專案可跳過
npm create vite@latest frontend -- --template react
cd frontend
npm install
```

### 2) 本機先確認 build 成功

```bash
npm run build
npm run preview
```

檢查重點：

- `dist/` 已產生
- 本機 preview 可正常載入首頁與關鍵路由

### 3) 建立 Pages 專案

你可以用 Dashboard 建立，或嘗試 CLI：

```bash
# 先看現有專案
npx wrangler pages project list

# 若版本支援，可用 CLI 建立
npx wrangler pages project create your-pages-project --production-branch main
```

> 若你的 `wrangler` 版本不支援 `project create`，直接到 Dashboard 建立即可。

### 4) 手動部署打包產物

```bash
npx wrangler pages deploy dist --project-name your-pages-project
```

部署成功後會得到一個網址（例如 `https://<hash>.your-pages-project.pages.dev`）。

### 5) 驗證與紀錄

- 開啟部署網址，確認首頁渲染正常。
- 測試至少 1 條非首頁路由（如 `/about`）。
- 在筆記中記錄：部署時間、commit、部署網址。

## 實作步驟 B：改成 Git 自動部署（推薦團隊使用）

1. 到 Cloudflare Pages 專案設定連接 Git repository。
2. 指定：
   - Build command：`npm run build`
   - Build output directory：`dist`
   - Node 版本（建議與本地一致，如 Node 20 LTS）
3. 設定 Production branch（通常 `main`）。
4. 推送一個 commit，確認自動觸發部署。

## SPA 路由必做設定（避免重新整理 404）

若你是 React Router SPA，請建立 `public/_redirects`（或最終進到輸出目錄）：

```txt
/* /index.html 200
```

這代表所有未知路由都回到 `index.html` 交給前端路由處理。

## 環境變數建議

### 命名方式

- `VITE_API_BASE_URL`
- `VITE_APP_ENV`

### 環境切分

- Preview：指向 staging API
- Production：指向 production API

不要把機密（token、private key）放進前端可讀變數。

## 迭代節奏建議（本章先建立習慣）

1. 本地開發 -> `npm run build` 檢查。
2. 推分支 -> 觀察 Preview 部署結果。
3. 驗證完成 -> merge 到 `main` -> Production 部署。

## 常見錯誤與排查

- **部署成功但開啟白畫面**
  - 常見原因：`base` 路徑設定錯誤或資產路徑錯誤。
- **深層路由 404**
  - 沒有設定 `/* /index.html 200`。
- **Build 在雲端失敗、本機成功**
  - 多半是 Node 版本或 lockfile 差異，請在 CI 與本機統一版本。
- **環境變數未生效**
  - 變數加在錯誤環境（Preview/Production）或沒有重新部署。

## 章末練習

- 必做：用 CLI 完成首次部署，提交部署網址與截圖。
- 必做：改一段 UI 文案，重新部署，證明可迭代。
- 選做：改成 Git 自動部署並比較 CLI 與 Git 流程差異。

## 章節重點回顧

- Pages 部署的關鍵是「正確 build 產物 + 正確環境設定」。
- CLI 適合快速驗證，Git 整合適合持續交付。
- SPA 專案務必補上 fallback，避免深層路由錯誤。
