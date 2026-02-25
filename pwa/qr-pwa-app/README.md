# QR 離線掃碼 PWA（Vue3 SPA / JavaScript）

這是一個 **Vue 3 SPA（純 JavaScript）** 的 PWA 範例，目標是讓手機在離線狀態下仍可掃描 QR Code。

## 功能流程

1. 打開 App 後直接進入掃碼畫面
2. 掃碼成功後切換到結果頁（黑底白字）
3. 結果頁提供：
   - 返回重新掃碼
   - 複製內容
   - 打開連結（若掃碼內容為可開啟網址）

另外已內建：

- 版本更新彈窗（發現新版本時提示「稍後 / 立即更新」）
- 安裝引導提示（iOS：分享 -> 加入主畫面；Android：Chrome 選單 -> 加到主畫面）

## 技術重點

- Vue 3 + Vite（SPA）
- `jsqr` 做即時畫面解碼
- `vite-plugin-pwa` 產生 Service Worker 與快取
- `virtual:pwa-register` 監聽更新並顯示更新彈窗

## 開發環境

- Node.js 20+（專案附 `.nvmrc`）
- npm 10+

### 使用 nvm

```bash
nvm use
```

若尚未安裝對應版本，可先執行：

```bash
nvm install 20.19.5
nvm use 20.19.5
```

## 本機啟動

```bash
npm install
npm run dev
```

## 建置與預覽（建議用這個驗證 PWA）

```bash
npm run build
npm run preview
```

## 離線驗證方式

1. 先在線上開一次 App，等待畫面出現「離線模式已就緒」提示
2. 用 Chrome DevTools -> Network 切成 `Offline`
3. 重新開啟/重新整理 App
4. 測試是否仍可進入掃碼頁並掃描 QR Code

## 版本迭代重點（請看這裡）

以下是你每次發版時最常需要調整的檔案與欄位：

1. **專案版號**
   - 檔案：`package.json`
   - 欄位：`version`
   - 用途：目前 UI 會顯示版本號（由 `vite.config.js` 注入）

2. **PWA Manifest / 安裝資訊**
   - 檔案：`vite.config.js`
   - 區塊：`VitePWA({ manifest: ... })`
   - 可調整：`name`、`short_name`、`theme_color`、`icons`

3. **版本更新彈窗行為**
   - 檔案：`src/main.js`
   - 區塊：`registerSW({ onNeedRefresh, onOfflineReady })`
   - 可調整：彈窗觸發時機、提示文案、更新後處理

4. **更新彈窗 UI 與按鈕文案**
   - 檔案：`src/App.vue`
   - 關鍵：`pwaState.needRefresh` 區塊（「稍後 / 立即更新」）

5. **iOS 溫馨提示文案**
   - 檔案：`src/App.vue`
   - 關鍵：`showIosTip` 區塊與 `dismissIosTip()`

6. **掃碼流程與結果頁操作**
   - 檔案：`src/App.vue`
   - 可調整：掃碼邏輯、結果頁顯示、複製與開連結行為

## 重要注意事項

- 相機權限需要 HTTPS（或 `localhost`）
- iOS Safari 對 `beforeinstallprompt` 不支援，故採用引導提示
- Android Chrome 可透過選單「加到主畫面」安裝 PWA
- 若掃碼內容不是網址，「打開連結」按鈕會自動禁用
