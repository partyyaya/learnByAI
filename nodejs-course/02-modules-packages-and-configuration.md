# 02 — 模組、套件入口與環境設定

> 檔案存在不代表可以用任何路徑匯入；環境變數存在也不代表它是合法設定。

上一章建立了 TypeScript 建置與測試流程。本章解釋其中的模組設定，再加入一個啟動邊界：**先讀取並驗證設定，全部通過後才執行業務**。

完成本章後，你應能：

- 區分 CommonJS 與 ESM 的匯入、匯出方式。
- 根據副檔名與最近一層 `package.json`，判斷 Node 如何解讀檔案。
- 分清相對路徑、Node 內建模組與套件名稱，理解 `main`／`exports` 的用途。
- 解釋 TypeScript 能找到來源檔，為什麼不代表 Node 執行時一定找得到。
- 載入 `.env`，把字串設定轉為有型別的組態，拒絕缺漏與非法值。
- 測試設定失敗時的訊息、結束狀態，以及業務是否尚未執行。

前置：完成 [01 章](01-runtime-tooling-and-project-setup.md)。本章沿用 Node 24.22.1、npm 11.19.1、TypeScript 5.9.3 與 Jest 30.2.0，主程式仍使用 NodeNext＋CommonJS 建置。ESM 以獨立小實驗呈現，讓每次設定變更都能看出影響。

## 02.1 先看兩個常見的失敗

第一種失敗：你看得到檔案，卻不能匯入它。

```js
import { formatTitle } from './format';
```

假設這是原生 ESM，而檔名其實叫 `format.mjs`，Node 不會像某些前端打包工具一樣替你補齊副檔名。需要寫成 `./format.mjs`。

第二種失敗：設定看起來是 `false`，程式卻把功能打開。

```js
const enabled = Boolean('false');
console.log(enabled); // true
```

因為 `'false'` 是非空字串。讀取環境變數後，還需要按照規格驗證與轉型。

這兩種問題都發生在程式與外部規則接合的地方。本章先把「Node 如何載入程式」說清楚，再把「程式如何取得設定」整理成可測試的函式。

## 02.2 先執行本章範例

完整專案在 [examples/02](examples/02/README.md)，是獨立快照，不會修改第 01 章。從倉庫根目錄執行：

```bash
cd nodejs-course/examples/02
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
```

`check` 依序完成型別檢查、Jest 測試、建置、模組實驗與啟動驗證，不需要建立自己的 `.env`。

要執行主程式，第一次先建立本機設定檔：

```bash
cp .env.example .env
docker compose run --rm tools npm run start:local
```

如果已有 `.env`，請直接檢查內容，不要再複製覆蓋。成功輸出：

```text
設定已驗證：article-course；模式 development；預定連接埠 3000
稽核開關：false（本章只驗證設定，尚未實作稽核寫入）
文章 [published] a_1001；版本 2
本章沒有啟動 HTTP 服務或寫入資料庫。
```

本機 Node 路線使用同版 Node／npm，將上面的 `docker compose run --rm tools npm ...` 改成 `npm ...` 即可。後續只列 `node` 或 `npm` 時，Docker 路線在前面加上 `docker compose run --rm tools`；所有指令都在本章範例目錄執行。

### 新增的檔案各負責什麼？

| 位置 | 責任 |
|------|------|
| [modules/](examples/02/modules/check.mjs) | 用原生 JavaScript 觀察模組規則，排除 TypeScript 編譯的干擾 |
| [packages/article-label/](examples/02/packages/article-label/package.json) | 本地示範套件，提供公開入口並保留內部檔案 |
| [src/config.ts](examples/02/src/config.ts) | 讀取傳入的設定資料，驗證、轉型並回傳組態 |
| [src/main.ts](examples/02/src/main.ts) | 程序入口，決定何時讀設定、何時開始業務 |
| [test/config.test.ts](examples/02/test/config.test.ts) | 測試缺漏、邊界、字串轉型與錯誤訊息 |
| [scripts/check-startup.cjs](examples/02/scripts/check-startup.cjs) | 啟動獨立 Node 程序，驗證環境載入與非零結束 |
| [.env.example](examples/02/.env.example) | 可提交的設定範本，不包含真實憑證 |

`src/article.ts` 與文章測試沿用上一章，讓本章聚焦在模組與設定。

## 02.3 先分清模組與套件

**模組**是可被載入的程式單位，本章多半是一個檔案。它可以把函式或資料匯出，供另一個檔案使用。

**套件**則以 `package.json` 描述名稱、版本、入口與依賴，可以包含多個模組。套件可以來自 npm，也可以是本機目錄；不必發布到 npm 才能練習套件規則。

```text
應用程式 src/main.ts
    ├─ 使用自己的模組：./article.js
    ├─ 使用自己的模組：./config.js
    └─ 使用套件公開入口：@course/article-label
                           └─ 套件內部再使用 internal.cjs
```

箭頭表示「誰載入誰」。應用只需要知道套件提供的函式，不必依賴它內部如何拆檔；套件作者之後才有空間調整實作。

## 02.4 同一個功能，兩種模組格式

### CommonJS：`require` 與 `module.exports`

[modules/cjs/format.cjs](examples/02/modules/cjs/format.cjs)：

```js
function formatTitle(title) {
  return `文章：${title}`;
}

module.exports = { formatTitle };
```

[modules/cjs/main.cjs](examples/02/modules/cjs/main.cjs)：

```js
const { formatTitle } = require('./format.cjs');
console.log(formatTitle('模組練習'));
```

執行 `node modules/cjs/main.cjs`，預期輸出 `文章：模組練習`。`require` 載入模組，這裡取得的是 `module.exports` 指向的物件，再從中取出函式。

若使用 `exports` 簡寫，要注意 `exports.formatTitle = formatTitle` 與 `exports = { formatTitle }` 不同；後者只改變區域變數的指向，不會替換 `module.exports`。初學時先沿用完整寫法。[Node.js CommonJS 文件](https://nodejs.org/api/modules.html)

### ESM：`import` 與 `export`

[modules/esm/format.mjs](examples/02/modules/esm/format.mjs)：

```js
export function formatTitle(title) {
  return `文章：${title}`;
}
```

[modules/esm/main.mjs](examples/02/modules/esm/main.mjs)：

```js
import { formatTitle } from './format.mjs';
console.log(formatTitle('模組練習'));
```

執行 `node modules/esm/main.mjs`，會得到相同輸出。這裡採用具名匯出，所以匯入時以 `{ formatTitle }` 對應名稱；`export default` 則使用另一種匯入形式，不是替名稱加減大括號就能任意互換。

### 檔名與 `type` 如何配合？

| Node 載入的檔案 | 本章如何判斷 |
|----------------|--------------|
| `.cjs` | 明確指定 CommonJS |
| `.mjs` | 明確指定 ESM |
| `.js`，最近一層 `package.json` 有 `"type": "commonjs"` | CommonJS |
| `.js`，最近一層 `package.json` 有 `"type": "module"` | ESM |

「最近一層」是從檔案所在目錄往父目錄尋找適用的 `package.json`。例如本章根目錄雖然是 `commonjs`，`modules/esm-scope/package.json` 卻宣告 `module`，因此其中的 `main.js` 仍是 ESM。

可以分別執行：

```bash
node modules/commonjs-scope/main.js
node modules/esm-scope/main.js
```

較新的 Node 對沒有明確標記的 `.js` 還可能進行語法偵測。本課都明寫 `type` 或使用 `.cjs`／`.mjs`，讓讀者能從檔案判斷規則。[Node.js 套件格式說明](https://nodejs.org/api/packages.html)

## 02.5 Node 如何找到匯入的對象？

| 寫法 | 對象 | 解析的重點 |
|------|------|------------|
| `./article.js`、`../config.js` | 相對模組路徑 | 相對於發出匯入的模組位置 |
| `node:path`、`node:fs` | Node 內建模組 | 由 Node 提供，不需要 npm 安裝 |
| `@course/article-label` | 套件名稱 | 一般從呼叫端附近的 `node_modules` 尋找，再依套件入口載入 |

相對匯入不是相對於你開終端機的位置。相反地，`process.cwd()` 代表程序的工作目錄，讀取 `--env-file=.env` 時使用的是這一類路徑基準。把兩者混在一起，就容易出現「換個目錄執行便壞掉」的問題。

### 原生 ESM 的相對匯入寫完整副檔名

本章的 ESM 範例應寫：

```js
import { formatTitle } from './format.mjs';
```

省略成 `./format` 會失敗，也不能依賴 Node 自動把目錄匯入補成 `index.js`。這是原生 ESM 的解析規則，不能直接套用前端打包器的便利行為。[Node.js ESM 匯入規則](https://nodejs.org/api/esm.html#mandatory-file-extensions)

### TypeScript 為什麼在 `.ts` 裡寫 `.js`？

回看上一章的 `src/main.ts`：

```ts
import { publishArticle } from './article.js';
```

它會經過兩個不同階段：

1. **編譯時**：TypeScript 依 NodeNext 規則找到 `article.ts`，檢查型別，產生對應 JavaScript。
2. **執行時**：Node 從 `dist/main.js` 載入實際存在的 `dist/article.js`。

本課目前的 `.ts` 搭配 `type: commonjs`，編譯後會看到 `require('./article.js')`。所以「原始碼寫了 `import`」不代表最後一定由 ESM loader 執行。

`.mts` 通常輸出 `.mjs`，`.cts` 通常輸出 `.cjs`，也能明確指定個別 TypeScript 模組格式；本章應用先維持 `.ts`＋CommonJS。不要只改一個 `type`，就忽略測試工具、輸出副檔名與依賴的相容性。

同樣地，TypeScript 的 `paths` 可以協助編譯器理解別名，卻不會自動把輸出的路徑改成 Node 能找到的檔案。本課先使用相對路徑與套件名稱，之後有需要再引入對應的執行期方案。[TypeScript 模組解析文件](https://www.typescriptlang.org/docs/handbook/modules/reference.html)

## 02.6 套件入口：檔案存在，為什麼仍不能載入？

本章在應用的 `package.json` 加入：

```json
{
  "dependencies": {
    "@course/article-label": "file:./packages/article-label"
  }
}
```

這是 `package.json` 的節錄。`npm ci` 會依 lockfile 安裝這個本地依賴；在本章 npm 設定下，它連到專案內的套件目錄。Docker 也掛入整個範例，所以連結目標存在。

套件自己的入口設定為：

```json
{
  "main": "./index.cjs",
  "types": "./index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "default": "./index.cjs"
    }
  }
}
```

| 欄位 | 用途 |
|------|------|
| `main` | 傳統套件主要入口；本例與公開入口指向同一檔案 |
| `exports` | 定義哪些套件路徑可被匯入；支援它的 Node 優先使用這份設定 |
| `exports` 的 `.` | 套件根入口，即 `@course/article-label` |
| `types` | 提供 TypeScript 型別宣告，不是 Node 要執行的程式 |
| `default` | 本例提供給執行期的入口；不是原始碼中的 `export default` |

主程式可以使用公開函式：

```ts
import { formatArticleLabel } from '@course/article-label';
```

但是以下操作會得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`：

```bash
node -e "require('@course/article-label/internal.cjs')"
```

`internal.cjs` 確實存在，也會由套件自己以相對路徑載入；只是沒有透過套件名稱對外公開。這讓內部拆檔不必成為使用者依賴的介面。

`exports` 是介面與解析邊界，不是檔案存取的安全隔離。`private: true` 則是避免 npm 發布套件，也不代表檔案被加密或只有特定使用者能讀。[Node.js 套件入口文件](https://nodejs.org/api/packages.html#package-entry-points)

這裡拆出本地套件是為了觀察入口規則，實務上不必為每個小函式建立套件。應用內的 `article.ts`、`config.ts` 仍可直接用模組分工。

## 02.7 兩種格式可以互相使用嗎？

可以，但要確認載入方向、匯出形狀與是否需要非同步初始化。

ESM 使用本章的 CommonJS 套件時，可以先取得 `module.exports` 對應的預設匯入：

```js
import label from '@course/article-label';
console.log(label.formatArticleLabel('a_1', 'draft'));
```

部分 CommonJS 模組也能被 Node 偵測出具名匯出，但不要假設任何動態建立的 `module.exports` 都能如此使用。

反過來，CommonJS 可以用動態 `import()`，它回傳 Promise。本章的 `modules/esm/async-value.mjs` 示範最小的 top-level await：

```js
export const value = await Promise.resolve('ready');
```

這表示模組本身需要等待初始化。執行以下指令會得到 `ERR_REQUIRE_ASYNC_MODULE`：

```bash
node -e "require('./modules/esm/async-value.mjs')"
```

改用動態匯入：

```bash
node -e "import('./modules/esm/async-value.mjs').then(mod => console.log(mod.value))"
```

預期輸出 `ready`。Node 24 的 `require()` 已能載入符合條件的同步 ESM，但不能同步等待含 top-level await 的模組圖；不要把「所有 ESM 都不能 require」當成固定規則。[Node.js require 與 ESM 說明](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require)

不需要現在就做混合格式的專案。先能看懂既有依賴使用哪種格式、失敗時查哪一層規則，再決定是否需要橋接。

一次執行上述實驗與預期失敗檢查：

```bash
npm run modules
```

共有 **12 項**檢查。程式會確認預期錯誤確實出現，再印出 `PASS`；不是把錯誤一律忽略。

## 02.8 環境變數與 `.env` 是兩件事

**環境變數**是程序啟動時取得的名稱與值。在 Node 裡，讀取 `process.env.PORT` 得到的是字串或 `undefined`，不是已驗證的數字。

**`.env`** 是保存設定文字的檔案。它需要由 Node、工具或程式明確載入，單純放在旁邊不會自動進入 `process.env`。

本章範本：

```dotenv
APP_NAME=article-course
PORT=3000
NODE_ENV=development
ENABLE_AUDIT_LOG=false
```

### 本章的兩個啟動入口

| 指令 | 設定來源 |
|------|----------|
| `npm start` | 只使用程序既有的環境變數 |
| `npm run start:local` | 先由 Node 的 `--env-file=.env` 載入檔案，再執行主程式 |

`start:local` 實際執行的是：

```bash
node --env-file=.env --enable-source-maps dist/main.js
```

Node 會在載入應用模組之前讀取檔案，讓入口驗證拿到完整設定。檔案路徑相對於目前工作目錄；不存在時會失敗。既有環境變數優先於檔案中的同名值，連既有的空字串也不會自動被補上。[Node.js env-file 文件](https://nodejs.org/api/cli.html#--env-filefile)

主機 Bash／zsh 可以用一次性環境變數覆蓋檔案設定：

```bash
PORT=4100 npm run start:local
```

Docker 路線則要明確把變數傳進容器：

```bash
docker compose run --rm -e PORT=4100 tools npm run start:local
```

預期輸出中的預定連接埠變成 `4100`。本章只驗證連接埠設定，尚未呼叫 `listen()`，因此不會開出 HTTP 服務。

### Docker Compose 的 `.env` 不等於容器環境

Compose 也會讀 `.env`，主要用來替換 YAML 中的 `${變數}`。但檔案中的所有欄位不會因此自動傳進容器。

傳入容器可以使用 `environment`、`env_file` 或 `docker compose run -e`。本章的 Compose 沒有設定前兩者；`start:local` 是由**容器內的 Node**讀取掛載目錄中的 `.env`，而不是靠 Compose 自動注入。[Docker Compose 環境變數說明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

不要混淆 `docker compose --env-file ...` 與 `node --env-file=...`：前者指定 Compose 的插值來源，後者載入 Node 程序環境。

## 02.9 把文字設定轉成可信的組態

業務函式不應每次自己讀 `process.env`、自己猜預設值。先在入口集中處理：

```text
程序環境（字串或 undefined）
             │ loadConfig(process.env)
             ▼
檢查必要欄位、格式、範圍，再轉型
             ├─ 失敗：列出欄位與規則，程序非零結束
             └─ 成功：回傳 AppConfig，交給後續功能使用
```

本章規格如下；這些是專題選擇，不是 Node 自動替你驗證的規則：

| 變數 | 規則 | 轉型後 |
|------|------|--------|
| `APP_NAME` | 必填；去除首尾空白後不得為空 | `string` |
| `PORT` | 必填；只接受十進位數字字元，值在 1–65535 | `number` |
| `NODE_ENV` | 未提供時為 `development`；只接受 `development`／`test`／`production` | 三種字串之一 |
| `ENABLE_AUDIT_LOG` | 未提供時為 `false`；只接受文字 `true`／`false` | `boolean` |

`NODE_ENV` 的空字串視為非法值，並不等於未提供。其他未知環境變數可以保留，因為程序也會收到 `PATH` 等系統變數；本章只驗證自己使用的欄位。

### 不用寬鬆轉型掩蓋錯誤

單獨呼叫 `parseInt('3000abc', 10)` 會得到 `3000`，`Number('')` 會得到 `0`，`Boolean('false')` 會得到 `true`。因此 `loadConfig` 會先檢查字串格式，再檢查數字範圍；布林值則明確比較字串。

```ts
const rawPort = env.PORT ?? '';
const port = Number(rawPort);
if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  issues.push('PORT 必須是 1–65535 的十進位整數');
}
```

完整實作見 [config.ts](examples/02/src/config.ts)。`loadConfig` 接收資料作為參數，不直接依賴全域環境，因此測試可以傳入獨立物件，不必反覆修改 `process.env`。

成功時回傳 `Object.freeze(...)` 的 `AppConfig`。`readonly` 提供編譯期限制，`Object.freeze` 提供執行期的淺層凍結；本章設定都是字串、數字、布林值，沒有巢狀物件需要再處理。

### 載入模組時不偷偷啟動業務

模組載入通常會執行頂層程式，之後可能使用快取；CommonJS 的常見情況是依解析後的檔名快取。因此，把 `process.env` 讀取放在模組頂層，會讓結果綁定於載入時機，修改環境後也不代表重新匯入就會重算。

本章將 `config.ts` 保持為型別、錯誤類別與函式定義，由 `main.ts` 明確呼叫：

```ts
const config = loadConfig(process.env);
// 驗證成功後才繼續執行文章規則。
```

正式連資料庫或開始監聽連接埠時，也應沿用這個順序。避免在被匯入的模組頂層直接連線、寫資料或啟動服務，讓單純匯入函式的測試也產生副作用。[Node.js 模組快取說明](https://nodejs.org/api/modules.html#caching)

## 02.10 設定錯誤時，要能清楚停止啟動

本章入口捕捉 `ConfigError`，輸出欄位與規則，再設定 `process.exitCode = 1`。目前沒有持續運作的資源，所以程序會自然結束；未來有伺服器或資料庫連線時，仍需要 07 章的資源關閉流程。

### 實驗一：不載入檔案，也不提供必要設定

Docker 範例的工具服務沒有注入應用設定，直接執行：

```bash
docker compose run --rm tools npm start
```

即使目錄中已有 `.env`，仍應得到：

```text
設定錯誤：APP_NAME 必須是非空字串；PORT 必須是 1–65535 的十進位整數
```

程序非零結束，而且不會印出設定通過或文章發佈結果。本機執行時，若 shell 先前已設定相關環境變數，結果可能不同；自動驗證會先移除這些值，確保案例獨立。

### 實驗二：拒絕格式不合法的連接埠

確定已建立 `.env` 後，執行：

```bash
docker compose run --rm -e PORT=3000abc tools npm run start:local
```

預期只指出 `PORT` 的規則，不會悄悄截成 `3000`。錯誤訊息也不回顯原始設定值，避免將日後可能放錯欄位的憑證寫進日誌。

`.env.example` 提交到 Git，自己的 `.env` 則由本章 `.gitignore` 排除。範本只放示意值，不放真實秘密；也不要用 `console.log(process.env)` 列出整個程序環境。

### 為什麼除了函式測試，還要測啟動程序？

單元測試只能證明 `loadConfig` 對給定輸入有正確行為，不能證明入口真的有呼叫它，或 Node 的 `--env-file` 確實在正確時間載入。

[啟動驗證](examples/02/scripts/check-startup.cjs) 因此使用子程序，檢查 **7 個案例**：有效設定、必要欄位缺漏、非法值不回顯、檔案載入、既有環境覆蓋、空值覆蓋，以及指定檔案不存在。

```bash
npm run build
npm run test:startup
```

這些案例會檢查結束碼、標準輸出與錯誤輸出，並使用臨時設定檔；不讀取也不修改你的 `.env`。

## 02.11 常見錯誤、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| `require is not defined` | 檔案是否是 ESM，卻使用 CommonJS 的區域變數 |
| `Cannot use import statement outside a module` | Node 實際載入的是什麼格式；是否直接執行了與設定不符的檔案 |
| `ERR_MODULE_NOT_FOUND` | 路徑、大小寫、副檔名，以及檔案是否真的已建置 |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` | 套件 `exports` 是否公開該子路徑；不要只看磁碟上有沒有檔案 |
| `ERR_REQUIRE_ASYNC_MODULE` | 是否同步 require 含 top-level await 的 ESM；必要時改用動態 import |
| 型別檢查通過，執行時卻找不到模組 | 檢查輸出檔與執行期解析，特別是別名或本地套件目錄是否存在 |
| `.env` 存在，必要設定卻仍缺漏 | 啟動指令是否有載入它；工作目錄是否正確 |
| 改了 `.env`，讀到的值卻沒變 | 是否已有同名環境變數優先覆蓋；是否有重新啟動程序 |
| Docker 裡沒有主機設定的變數 | 是否透過 `-e`、`environment` 或 `env_file` 明確傳入 |
| 字串 `false` 被判斷成真 | 是否用了 `Boolean(...)` 或一般 truthy 判斷 |

### 練習一：判斷檔案格式

根目錄為 `type: commonjs`，子目錄 `feature` 有自己的 `package.json` 宣告 `type: module`。請判斷 `feature/a.js`、`feature/b.cjs`、根目錄的 `c.mjs` 各是什麼格式。

<details>
<summary>參考答案</summary>

依序為 ESM、CommonJS、ESM。`.js` 依最近一層套件設定；`.cjs` 與 `.mjs` 明確指定格式。

</details>

### 練習二：補一個設定邊界測試

本章 `PORT` 不允許首尾空白。請在 `test/config.test.ts` 的非法連接埠案例加入 `' 3000 '`，執行 `npm test` 確認被拒絕。不要為了讓輸入通過就自行加上 `trim()`；是否容許空白是需要明確決定的規格。

### 練習三：追蹤最終設定

`.env` 中 `PORT=3000`，但啟動容器時傳入 `-e PORT=`。程式會使用 3000、使用空值，還是停止啟動？

<details>
<summary>參考答案</summary>

既有的空環境值優先於檔案中的 3000。接著 `loadConfig` 拒絕空值，所以程序停止啟動。載入優先順序與驗證規則是兩個步驟。

</details>

### 本章完成檢查

- [ ] 能說明 `.cjs`、`.mjs`、`.js` 與 `type` 的關係。
- [ ] 能解釋相對匯入與工作目錄的差別。
- [ ] 能分清編譯期型別解析與 Node 執行期載入。
- [ ] 能使用套件公開入口，解釋未公開子路徑為什麼失敗。
- [ ] 已完成 `npm run modules` 的 12 項模組實驗。
- [ ] 能說明 `.env` 如何載入，以及同名環境變數的優先順序。
- [ ] 設定缺漏或非法時，程序會非零結束且不執行業務。
- [ ] 已通過 `npm run check`，知道本章仍沒有啟動 HTTP 或資料庫。

下一章：[03 — 事件迴圈、microtask、I/O 與併發](03-event-loop-and-concurrency.md)，會用執行順序與耗時實驗，理解事件迴圈、microtask、I/O 等待與 CPU 阻塞。

---

[上一章：專案工具與建置](01-runtime-tooling-and-project-setup.md) · [返回課程總覽](README.md) · [本章範例](examples/02/README.md)
