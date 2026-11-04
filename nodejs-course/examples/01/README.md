# 01 章可執行範例

對應教材：[Node 版本、npm、TypeScript 建置與專案入口](../../01-runtime-tooling-and-project-setup.md)。本範例只執行文章發佈規則，沒有 HTTP 服務或資料庫。

## 使用 nvm 安裝指定 Node 版本

先依[教材安裝 nvm](../../00-course-map-and-project-contract.md#004-用-nvm-安裝-node-並執行第一個練習)，再從倉庫根目錄執行：

```bash
cd nodejs-course/examples/01
command -v nvm
nvm install
nvm use
node --version
npm --version
```

nvm 讀取本章 .nvmrc，安裝或重用 Node 24.22.1，然後切換目前 shell。npm 應為 11.19.1；若 nvm 尚未載入或 npm 版本不同，依[教材的準備步驟](../../01-runtime-tooling-and-project-setup.md#014-先用-nvm-安裝指定版本再用-docker-執行)處理。

## 專案操作維持 Docker

保持在本章目錄，啟動 Docker 引擎後執行：

```bash
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
```

Compose 固定 Node 24.22.1／npm 11.19.1 的映像內容，依賴保存於本章專用 volume；原始碼與建置產物放在目前目錄。nvm 不會改變容器版本；後續套件、測試、API 與資料庫繼續使用各章 Docker 指令。

`check` 執行型別檢查、4 個 Jest 測試與建置。單獨 `npm start` 只執行既有建置檔，修改後要先 `npm run build`。

audit 摘要可能隨 advisory 資料更新而改變，固定 lockfile 不代表提示數量永遠相同。範例維持固定版本，未執行 audit fix --force。

## 除錯

用 VS Code 開啟此目錄後，可使用 `.vscode/launch.json`。本機模式需先建置；Docker 模式先執行：

```bash
docker compose run --rm tools npm run build
docker compose run --rm -p 127.0.0.1:9229:9229 tools \
  node --enable-source-maps --inspect-brk=0.0.0.0:9229 dist/main.js
```

選擇「01：連接 Docker 除錯程序」，在 `src/article.ts` 設斷點後繼續執行。完整操作、失敗實驗與排錯見教材。
