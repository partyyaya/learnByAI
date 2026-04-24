# 07｜本地整合開發與測試

> 這章重點是把「前端 + Workers + 資料層」在本地串起來，並建立最小整合測試，確保你不是只測到 happy path。

## 學習目標

- 能同時啟動前端與 Workers 本地環境。
- 能驗證 local/preview/prod 的行為差異並快速定位問題。
- 能建立最小 smoke test 並納入 CI。

## 前置條件

- 已完成第 `06` 章，前端可呼叫 Workers API。
- 專案已具備基本測試工具（建議 Vitest 或 Playwright）。

## 成功標準

1. 一條指令可啟動本地整合開發（frontend + worker）。
2. 至少有 3 條 smoke test（健康檢查、成功案例、錯誤案例）。
3. CI 會自動執行 smoke test，避免壞版本進 production。

## 核心觀念

- **整合測試的目的不是測 UI 漂亮，而是測資料流完整**
  - 是否請得到資料、錯誤是否正確、超時如何處理。
- **盡量貼近真實環境**
  - 本地環境要儘量模擬真實 API 協議與 headers。
- **小而關鍵的 smoke test 比大量脆弱測試更有價值**
  - 先覆蓋最關鍵流程，再逐步擴增。

## 推薦本地開發流程

### 1) 啟動 Workers 本地服務

```bash
cd worker-api
npx wrangler dev --port 8787
```

### 2) 啟動前端服務並指向本地 API

```bash
cd frontend
echo 'VITE_API_BASE_URL=http://127.0.0.1:8787' > .env.local
npm run dev
```

### 3) 驗證最小串接

- 前端開頁面可看到 API 回傳資料。
- Workers log 有對應請求紀錄。
- 修改 Workers 回傳格式後，前端可立即看到變更。

## 一鍵啟動（建議）

可在 repo root 使用 `concurrently` 統一啟動：

```bash
npm install -D concurrently
```

`package.json`：

```json
{
  "scripts": {
    "dev:frontend": "npm --prefix frontend run dev",
    "dev:worker": "npm --prefix worker-api run dev",
    "dev:all": "concurrently \"npm run dev:frontend\" \"npm run dev:worker\""
  }
}
```

## 建立最小 smoke test（Vitest 範例）

`tests/smoke/api.smoke.test.js`：

```js
import { describe, it, expect } from "vitest";

const BASE_URL = process.env.SMOKE_API_BASE_URL ?? "http://127.0.0.1:8787";

describe("workers smoke tests", () => {
  it("GET /api/health returns ok", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("missing route returns 404", async () => {
    const res = await fetch(`${BASE_URL}/api/not-found`);
    expect(res.status).toBe(404);
  });
});
```

執行：

```bash
npx vitest run tests/smoke/api.smoke.test.js
```

## 建議測試組合（先小後大）

1. **健康檢查**：`/api/health` 可回應 200。
2. **核心讀取**：例如 `GET /api/profile` 正常。
3. **錯誤路徑**：404 或 401 格式正確。
4. **延伸（選做）**：模擬 timeout 與重試。

## 線上差異管理

### 環境設定表（建議）

| 環境 | 前端 URL | API URL | 資料來源 |
|---|---|---|---|
| local | `http://localhost:5173` | `http://127.0.0.1:8787` | 本地或測試資料 |
| preview | `https://<branch>.pages.dev` | `https://api-staging.example.com` | staging |
| production | `https://app.example.com` | `https://api.example.com` | production |

把這張表寫進 repo 的 `docs/`，新人上手會快很多。

## 常見錯誤與排查

- **本地前端打不到 API**
  - 優先檢查 `.env.local` 與 CORS 白名單。
- **測試在本地過，CI 失敗**
  - 通常是啟動順序問題，需在 CI 中等待 worker ready。
- **測試過度依賴真實資料**
  - 建議建立固定種子資料或可重現 mock。
- **只有 happy path**
  - 一定要補 4xx/5xx，否則上線風險高。

## 章末練習

- 必做：建立 3 條 smoke test（200/404/401 或 500）。
- 必做：加入 `dev:all` 一鍵啟動指令。
- 選做：把 smoke test 加進 PR CI，要求綠燈才可合併。

## 章節重點回顧

- 本地整合開發要重視「資料流與錯誤流」。
- 小而關鍵的 smoke test 能有效攔截回歸。
- 一鍵啟動與環境對照表會大幅降低團隊溝通成本。
