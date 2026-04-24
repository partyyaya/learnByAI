# 00｜課程導覽與環境準備

> 這章會把學習地圖與環境一次準備好，避免你在後續章節卡在工具或權限問題。

## 學習目標

- 了解整套課程的三段式學習路徑。
- 完成 Cloudflare Pages + Workers 的開發環境準備。
- 能驗證本機與 Cloudflare 帳號已可進行部署。

## 前置條件

- 已具備 HTML/CSS/JavaScript 基礎。
- 會使用 Git 與 GitHub（至少能建立 repo、push 分支）。
- 可使用終端機執行 Node.js 與 npm/pnpm 指令。

## 你將完成什麼

1. 建立一個可部署到 Pages 的前端專案。
2. 建立一個可回應 API 的 Workers 專案。
3. 確認本機可以透過 `wrangler` 操作 Cloudflare 資源。

## 本課程三段式地圖

1. **觀念與決策（00~03）**
   - 先搞懂服務定位、方案與儲存選型，再寫程式。
2. **部署與整合（04~07）**
   - 前端上 Pages、API 上 Workers，完成本地與線上串接。
3. **自動化與上線（08~10）**
   - 導入 CI/CD、監控與上線檢查清單。

## 安裝與帳號準備

### 1) 必備工具

- Node.js：建議 18+（LTS）
- 套件管理器：`npm` / `pnpm` / `yarn` 擇一
- `wrangler`：Cloudflare 官方 CLI
- Git + GitHub 帳號

### 2) 安裝 Wrangler

```bash
npm install -g wrangler
wrangler --version
```

### 3) 登入 Cloudflare

```bash
wrangler login
```

執行後會開啟瀏覽器完成授權。若成功，後續可直接建立與部署 Workers。

## 建議的練習專案結構

```text
cloudflare-course/
  frontend/          # Vite/React 專案（部署到 Pages）
  worker-api/        # Cloudflare Workers API
  .github/workflows/ # CI/CD 流程
```

## 快速健康檢查（你應該看到什麼）

```bash
node -v
npm -v
wrangler --version
```

- `node -v` 有回傳版本號
- `wrangler --version` 正常顯示版本
- 已能使用 `wrangler login` 完成登入

## 常見卡點

- **登入失敗**：先確認瀏覽器是否阻擋跳轉，再改用無痕模式重試 `wrangler login`。
- **指令找不到**：重新開啟終端，或改用 `npx wrangler --version`。
- **權限問題**：公司網路可能限制，先在個人網路完成授權與初次部署。

## 章末練習

- 必做：建立 `frontend` 與 `worker-api` 兩個資料夾，並初始化 Git repo。
- 必做：完成 `wrangler login`，截圖或文字記錄版本與登入結果。
- 選做：嘗試 `npx wrangler init worker-api` 建立第一個 Workers 專案。

## 章節重點回顧

- 先打好環境與權限，會大幅降低後續部署摩擦。
- 課程主線是「前端 Pages + API Workers + 自動化上線」。
- 後續章節會以這個專案結構持續演進與迭代。
