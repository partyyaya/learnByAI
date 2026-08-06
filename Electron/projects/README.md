# Electron 實戰專案

這個資料夾收錄**可直接執行**的完整 Electron 小專案，把課程各章的片段組成一個能用的產品。章節教「單一觀念怎麼寫」，這裡則是「全部串起來之後，一個真實的小 App 長什麼樣」。

| 專案 | 說明 | 主要涵蓋章節 |
|------|------|--------------|
| [notepad-app](./notepad-app/) | 本機記事本：左側清單 + 右側撰寫區，內容可貼上文字與圖片，全部離線儲存 | 03 架構、04 IPC、06 資料儲存、09 安全 |
| [admin-dashboard](./admin-dashboard/) | React 後台管理：登入頁 → 側邊欄 + 導航欄（跑馬燈、使用者選單、登出），資料來自跑在 main process 的模擬後端 | 03 架構、04 IPC、08 打包、09 安全 |

兩個專案的分工：**notepad-app 是「原生 App 該有的樣子」**（零 runtime 依賴、純 JS、資料存本機檔案）；**admin-dashboard 是「前端框架怎麼放進 Electron」**（React + Vite 建置、模擬 HTTP API、登入與權限）。

共同的執行方式（需要 Node.js 20 LTS 以上；admin-dashboard 需要 20.19+）：

```bash
cd notepad-app        # 或 admin-dashboard
npm install
npm run dev
```
