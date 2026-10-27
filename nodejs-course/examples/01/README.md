# 01 章可執行範例

對應教材：[Node 版本、npm、TypeScript 建置與專案入口](../../01-runtime-tooling-and-project-setup.md)。本範例只執行文章發佈規則，沒有 HTTP 服務或資料庫。

## Docker 執行

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/01
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
```

Compose 固定 Node 24.22.1／npm 11.19.1 的映像內容，依賴保存於本章專用 volume；原始碼與建置產物放在目前目錄。

## 本機執行

在此目錄使用 `.nvmrc` 指定的 Node，確認 npm 為 11.19.1，再執行：

```bash
npm ci
npm run check
npm start
```

`check` 執行型別檢查、4 個 Jest 測試與建置。單獨 `npm start` 只執行既有建置檔，修改後要先 `npm run build`。

## 除錯

用 VS Code 開啟此目錄後，可使用 `.vscode/launch.json`。本機模式需先建置；Docker 模式先執行：

```bash
docker compose run --rm tools npm run build
docker compose run --rm -p 127.0.0.1:9229:9229 tools \
  node --enable-source-maps --inspect-brk=0.0.0.0:9229 dist/main.js
```

選擇「01：連接 Docker 除錯程序」，在 `src/article.ts` 設斷點後繼續執行。完整操作、失敗實驗與排錯見教材。
