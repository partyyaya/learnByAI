# 02 章可執行範例

對應教材：[模組、套件入口與環境設定](../../02-modules-packages-and-configuration.md)。沿用第 01 章的工具與文章規則，新增模組實驗、本地套件與啟動設定驗證；尚未啟動 HTTP 或資料庫。

## Docker 執行

從倉庫根目錄執行：

```bash
cd nodejs-course/examples/02
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
```

`check` 包含型別檢查、Jest 測試、建置、12 項模組實驗與 7 項啟動驗證，不需要 `.env`。

第一次執行主程式時，複製範本；已有 `.env` 時直接使用，不要覆蓋：

```bash
cp .env.example .env
docker compose run --rm tools npm run start:local
```

覆蓋連接埠設定：

```bash
docker compose run --rm -e PORT=4100 tools npm run start:local
```

這只驗證設定，不會監聽 4100。Compose 沒有自動將 `.env` 內容注入容器；`start:local` 由容器內 Node 的 `--env-file=.env` 明確載入。

## 本機與單獨驗證

使用 `.nvmrc` 的 Node 24.22.1 與 npm 11.19.1，將上述容器前綴移除即可。

```bash
npm ci
npm run check
npm run start:local
```

| 指令 | 用途 |
|------|------|
| `npm test` | 原始碼與測試編譯後執行 Jest |
| `npm run modules` | 觀察模組與套件入口，含預期失敗案例 |
| `npm run build` | 建置目前原始碼 |
| `npm run test:startup` | 測試建置後入口；使用臨時檔，不依賴自己的 `.env` |
| `npm start` | 使用既有程序環境；不自動載入 `.env` |
| `npm run start:local` | 明確載入 `.env` 後執行既有建置 |

若 Docker 路線直接 `npm start`，未傳入必要設定時應非零結束；這是教材的預期失敗情境。修改原始碼後記得重新建置。
