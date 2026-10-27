# 01 — Node 版本、npm、TypeScript 建置與專案入口

> 讓同一份程式能在另一台電腦安裝、建置、執行與測試，是專案開發的第一步。

上一章用單一 `.mjs` 檔觀察 Node 環境。本章將建立一個有明確版本、依賴、原始碼與測試的 TypeScript 專案，沿用「草稿可以發佈，封存文章不能再發佈」的規則。

本章完成後，你應能：

- 確認目前使用哪個 Node 與 npm，並切換到專案指定版本。
- 分清 `package.json`、`package-lock.json` 與 `node_modules`。
- 解釋 `.ts` 原始碼如何成為 Node 執行的 `.js`。
- 用固定指令完成型別檢查、建置、執行與 Jest 測試。
- 讓型別錯誤與業務錯誤分別被檢查出來，並在原始碼設定斷點。

前置：讀完 [00 章](00-course-map-and-project-contract.md)，理解基本物件、函式、`import` 與 TypeScript 型別。本章提供 Docker 路線，不要求先在主機安裝 Node。範例仍是一次執行就結束的程式；05 章才建立 HTTP 服務。

## 01.1 為什麼只交一份 `.ts` 檔還不夠？

假設 Alice 寫好程式，傳給 Bob，Bob 卻無法執行：

| 問題 | 可能原因 | 本章用什麼解決 |
|------|----------|----------------|
| Alice 能跑，Bob 卻遇到語法或工具錯誤 | Node 或工具版本不同 | Node 版本檔、套件版本與 Docker 映像 |
| 找不到 TypeScript 或 Jest | Alice 只在自己的電腦全域安裝工具 | 專案內的 `devDependencies` 與 npm scripts |
| 同樣安裝指令，卻裝到不同套件組合 | 只有版本範圍，沒有鎖定實際依賴樹 | `package-lock.json` 與 `npm ci` |
| 改了程式，執行結果卻沒變 | 執行的是舊的建置檔 | 明確區分建置與執行指令 |
| 程式能跑，但封存文章竟然也能發佈 | 沒有檢查業務行為 | Jest 測試成功與失敗路徑 |

我們要交付的是一個可以重現操作的專案。版本、設定與指令和原始碼一樣，都需要保留在版本控制裡。

## 01.2 先看懂三段流程

本章會分別執行三件事，不需要一次記住所有工具設定：

```text
安裝工具：package.json + package-lock.json
                         │ npm ci
                         ▼
                    node_modules/

建置程式：src/*.ts ── TypeScript 編譯器 ──> dist/*.js
                                              │ Node 執行
                                              ▼
                                         終端機輸出

驗證行為：src/*.ts + test/*.ts ── 編譯 ──> .test-dist/
                                              │ Jest 執行測試
                                              ▼
                                         通過或失敗
```

`node_modules` 是下載的依賴，`dist` 是自己的程式建置結果，`.test-dist` 則是包含測試的建置結果。三個目錄可以從原始碼、設定與 lockfile 重建，不提交到 Git。

新版 Node 能執行部分 TypeScript 語法，但直接執行不等於完成型別檢查。本課刻意使用明確的編譯流程，方便接續正式建置與 NestJS 的編譯需求。[Node.js TypeScript 說明](https://nodejs.org/api/typescript.html)

## 01.3 本章的版本與檔案

完整範例位於 [examples/01](examples/01/README.md)，每一章保留自己的可執行快照，方便回頭比較。

| 工具 | 本章固定版本 | 用途 |
|------|--------------|------|
| Node.js | `24.22.1` | 執行建置後的 JavaScript |
| npm | `11.19.1` | 安裝依賴與執行 scripts |
| TypeScript | `5.9.3` | 型別檢查與編譯 |
| `@types/node` | `24.19.2` | 描述 Node API 的 TypeScript 型別 |
| Jest、`@jest/globals` | `30.2.0` | 執行測試，提供 `test`、`expect` 等工具 |

這是一組本章驗證使用的版本，不表示每個套件都是最新版本。`@types/node` 提供型別，不會安裝或替換 Node；它的修補版本不必與 Node 執行檔完全相同。

Docker 的 [compose.yaml](examples/01/compose.yaml) 使用 image digest 固定映像內容，提供表中的 Node 與 npm。日後升級時，應一起檢查映像、`.nvmrc`、`engines` 與 lockfile，再重新驗證。本章只安裝用得到的工具；Express、NestJS、Prisma 與 Supertest 會在開始使用的章節固定版本並更新對應範例的 lockfile。

```text
examples/01/
├── .nvmrc                    # 本機 Node 版本
├── .npmrc                    # npm 安裝規則
├── .gitignore                # 排除依賴與產物
├── .vscode/launch.json       # 本機與 Docker 除錯入口
├── compose.yaml              # Docker 工具環境
├── package.json              # 專案資訊、依賴、指令
├── package-lock.json         # 實際解析的依賴版本與完整性資訊
├── tsconfig.json             # 原始碼與測試的型別／編譯設定
├── tsconfig.build.json       # 只建置應用程式
├── jest.config.cjs           # Jest 執行設定
├── src/
│   ├── article.ts            # 文章資料型別與發佈規則
│   └── main.ts               # 程式入口
└── test/
    └── article.test.ts       # 發佈規則的測試
```

初次閱讀先照下一節跑通，再逐一看設定檔。不要在倉庫根目錄執行 `npm install`；本章的專案根目錄是 `nodejs-course/examples/01`。

## 01.4 先跑通一次：Docker 與本機擇一

### 路線 A：使用 Docker

從倉庫根目錄開始，以下使用 Bash／zsh：

```bash
cd nodejs-course/examples/01
docker compose run --rm tools node --version
docker compose run --rm tools npm --version
docker compose run --rm tools npm ci
docker compose run --rm tools npm run check
docker compose run --rm tools npm start
```

第一次需要下載映像與依賴。`tools` 是 Compose 的服務名稱，這裡代表裝有 Node 的工具環境；`run --rm` 建立一次性容器，指令結束後移除容器。[Docker Compose run 文件](https://docs.docker.com/reference/cli/docker/compose/run/)

本章和 00 章的掛載有兩個不同之處：

- 範例目錄掛到 `/work`，允許寫入，讓建置結果與 lockfile 能留在專案目錄。
- `/work/node_modules` 使用本章專用的 Docker volume，讓不同次執行共用依賴，也避免直接混用主機與 Linux 容器的套件檔案。

因此，容器移除後，下次仍能使用已安裝的依賴。這份 Compose 只有工具環境，不會啟動資料庫，也沒有預設開放連接埠。若在原生 Linux 使用 Docker，掛載目錄產物的擁有者取決於容器使用者；本章步驟以 Docker Desktop 驗證。

`npm run check` 應完成型別檢查、**4 個 Jest 測試**與應用建置。`npm start` 預期輸出：

```text
Node v24.22.1
文章 a_1001：draft → published
版本：1 → 2
本章只執行本機規則，尚未啟動 HTTP 服務或寫入資料庫。
```

後文只列 `npm ...` 時，Docker 路線就在前面加上 `docker compose run --rm tools`；除錯用的連接埠指令則會另外完整列出。

### 路線 B：在本機執行

如果已安裝 Node 版本管理工具，可以在同一目錄使用 `.nvmrc`。以已安裝的 nvm 為例：

```bash
cd nodejs-course/examples/01
nvm install
nvm use
node --version
npm --version
```

前面的 `cd` 同樣是從倉庫根目錄開始；若已在範例目錄，不要再重複執行。nvm 的安裝方式與支援環境見 [nvm 官方文件](https://github.com/nvm-sh/nvm)。Windows 可以使用 Docker 路線，或使用自己熟悉的版本管理工具選擇相同 Node 版本。

若切換後 npm 不是 `11.19.1`，在已選好的 Node 環境執行 `npm install --global npm@11.19.1`，再用 `npm --version` 確認。接著：

```bash
npm ci
npm run check
npm start
```

`.nvmrc` 不會自己切換版本，`package.json` 的 `engines` 也不會下載 Node。本章透過 `.npmrc` 的 `engine-strict=true`，讓不符合宣告的 Node／npm 版本在安裝時失敗；`packageManager` 欄位記錄使用的工具版本，不代表會自動安裝它。

## 01.5 npm 管的是什麼？

### 三個容易混淆的檔案與目錄

| 名稱 | 內容 | 是否提交 Git |
|------|------|--------------|
| `package.json` | 專案要哪些依賴、允許的版本與可執行指令 | 是 |
| `package-lock.json` | npm 解析後的依賴樹、實際版本與完整性資訊 | 是 |
| `node_modules/` | 依據上述設定下載的套件檔案 | 否 |

`dependencies` 放應用執行時需要的套件，例如之後的 Express。`devDependencies` 放開發、建置與測試工具；本章的 TypeScript 與 Jest 都屬於這一類。建置階段需要安裝開發依賴，不能先用 `--omit=dev` 省略它們，再期待編譯器存在。

目前應用程式只使用自己寫的規則與 Node API，因此尚未宣告第三方執行期依賴。

### `npm install` 與 `npm ci` 的使用時機

| 操作 | 使用時機 | 對 lockfile 的影響 |
|------|----------|--------------------|
| `npm install` | 建立專案依賴，或有意調整依賴 | 可能建立或更新 lockfile |
| `npm install --save-dev 套件@版本` | 有意新增／調整開發工具 | 同步更新 manifest 與 lockfile |
| `npm ci` | 取得已有 lockfile 的專案、CI 或乾淨重建 | 依 lockfile 安裝，不更新它；不一致時失敗 |

本章已附上 lockfile，讀者使用 `npm ci` 即可。它會重建目前專案的 `node_modules`，所以不要在另一個安裝程序還在進行時同時執行。[npm ci 官方文件](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

`.npmrc` 的 `save-exact=true` 讓新增套件預設記錄確切版本，省去 `^` 或 `~` 範圍。即使頂層套件已固定版本，它們依賴的其他套件仍可能使用範圍，因此還是需要 lockfile。

### 為什麼不用全域 `tsc`？

`npm run typecheck` 執行時，npm 會將專案的 `node_modules/.bin` 加進指令搜尋路徑，因此使用的是本章安裝的 TypeScript。直接在終端機輸入 `tsc`，可能找不到指令，或使用另一個專案留下的全域版本。

讀者不必先全域安裝 TypeScript、Jest 或 Nest CLI。把工具留在專案裡，版本才有明確依據。

## 01.6 看懂 TypeScript 建置設定

先從 [src/article.ts](examples/01/src/article.ts) 看最重要的一段：

```ts
export function publishArticle(article: Article): Article {
  if (article.status !== 'draft') {
    throw new Error('INVALID_ARTICLE_STATE');
  }

  return {
    ...article,
    status: 'published',
    version: article.version + 1,
  };
}
```

`Article` 介面描述 ID、作者、標題、內容、狀態與版本。這個函式回傳新物件，保留原本內容，將狀態改成 `published` 並增加版本。傳入已發佈或封存文章時，則拋出錯誤。

它只負責本章的狀態規則；沒有登入、授權、HTTP 輸入驗證，也沒有資料庫原子更新。型別能幫忙檢查本機程式怎麼呼叫它，外部輸入的信任邊界會在後續章節處理。

### 設定如何影響輸出？

| 設定 | 本章值 | 作用 |
|------|--------|------|
| `target` | `ES2022` | 決定輸出 JavaScript 的語法目標 |
| `module`／`moduleResolution` | `NodeNext` | 依 Node 的模組規則處理輸出與匯入 |
| `package.json` 的 `type` | `commonjs` | 本章一般 `.ts` 編譯成 CommonJS，Node 也以此解讀 `.js` |
| `strict` | `true` | 啟用較完整的型別檢查 |
| `lib`／`types` | `ES2022`／`node` | 使用語言標準與 Node 型別，不預設加入瀏覽器 DOM |
| `noEmitOnError` | `true` | 發現型別錯誤時，不產生這次的編譯輸出 |
| `sourceMap` | `true` | 產生對照檔，讓除錯器對回 `.ts` 原始碼 |
| `rootDir`／`outDir` | 依用途設定 | 決定輸入目錄結構與輸出位置 |

`NodeNext` 不代表一定產生 ESM；它會搭配副檔名與 `package.json` 的 `type` 判斷。本章先採 CommonJS，02 章會用對照實驗說明 ESM 與 CommonJS 的差別。[TypeScript module 文件](https://www.typescriptlang.org/tsconfig/module.html)

原始碼使用 `import { publishArticle } from './article.js'`，指的是執行時的檔名；TypeScript 在編譯時會找到對應的 `article.ts`。目前先沿用範例設定，不要只更改 `type` 就期待整個專案完成模組切換。

### 為什麼有兩份 tsconfig？

- `tsconfig.json` 包含 `src` 與 `test`。型別檢查涵蓋兩者，測試建置輸出到 `.test-dist/src` 與 `.test-dist/test`。
- `tsconfig.build.json` 繼承共用設定，但只包含 `src`。應用建置只輸出 `dist/main.js`、`dist/article.js` 及其 source map。

如此一來，正常執行入口是 `dist/main.js`，測試程式不會混進應用建置目錄。進入 NestJS 時，才會加入需要的 decorator 與 metadata 編譯設定，並用框架實際驗證。

## 01.7 每個 npm 指令要在什麼時候用？

| 指令 | 做什麼 | 什麼時候用 |
|------|--------|------------|
| `npm run typecheck` | 檢查 `src` 與 `test`，不輸出檔案 | 快速確認型別是否正確 |
| `npm run build` | 清除本章 `dist`，再編譯應用程式 | 要執行目前原始碼之前 |
| `npm start` | 用 Node 執行 `dist/main.js` | 查看應用結果；不會自動重新建置 |
| `npm run dev` | 持續監看並重新編譯 `src` | 編輯時省去手動重複建置 |
| `npm test` | 清除 `.test-dist`、編譯原始碼與測試，再跑 Jest | 驗證狀態規則 |
| `npm run check` | 依序型別檢查、測試、應用建置 | 完成修改或乾淨重建時 |
| `npm run debug` | 執行建置檔，並在起點等待除錯器 | 本機逐步觀察程式 |

指令中的 `&&` 表示前一步成功才繼續。若測試編譯失敗，就不應再執行舊的測試產物。建置指令先清除固定的輸出目錄，也能避免刪掉原始碼後卻留下舊 `.js`。

### 日常修改流程

小幅修改時，最直接的方式是：

```bash
npm run check
npm start
```

想用監看模式，可以開兩個終端機，都位於範例目錄：

```bash
# 終端機 A：保持執行，修改 src 後會重新編譯
npm run dev
```

```bash
# 終端機 B：等 A 顯示 Found 0 errors 後執行
npm start
```

`dev` 在本章只監看編譯，不會自動執行或重啟程式。若監看期間有錯誤，舊輸出可能仍在；先修正錯誤，再執行 `npm start`。需要完整檢查時，先以 `Ctrl+C` 停止監看，避免它和清除輸出目錄的指令同時工作。

Docker 路線可用同樣兩個終端機，分別執行 `docker compose run --rm tools npm run dev` 與 `docker compose run --rm tools npm start`。

## 01.8 第一個測試：不是只看程式能不能啟動

[test/article.test.ts](examples/01/test/article.test.ts) 共有四個案例：

1. 草稿可以發佈，內容不變，狀態與版本正確更新。
2. 發佈不修改呼叫端持有的原始物件。
3. 已發佈文章不能再次發佈。
4. 封存文章不能發佈。

每個測試各自建立資料，避免前一個測試修改狀態、讓下一個測試結果受執行順序影響。例如：

```ts
test('草稿發佈後保留內容、變更狀態並增加版本', () => {
  const draft = makeDraft();

  const result = publishArticle(draft);

  expect(result).toEqual({ ...draft, status: 'published', version: 4 });
});
```

測試的草稿版本刻意使用 3，預期結果是 4，確認程式確實遞增版本。測試分成準備資料、執行操作、檢查結果三段。

失敗情境使用 `expect(() => publishArticle(article)).toThrow(...)`。傳入函式是為了讓 Jest 執行它並檢查拋出的錯誤；若直接先呼叫 `publishArticle(article)`，例外會在 Jest 收到待檢查內容前發生。

Jest 在本章執行已編譯的 JavaScript，`transform: {}` 關閉額外轉譯，不需要同時配置 ts-jest 或 Babel。`--runInBand` 表示依序執行測試，先降低資源與並行行為的干擾。測試工具的基本概念見 [Jest 官方入門](https://jestjs.io/docs/getting-started)。

## 01.9 兩種失敗，讓工具真的發揮作用

請依序操作，每次練習結束都恢復原始程式。

### 實驗 A：型別錯誤

把 `src/main.ts` 的 `version: 1` 暫時改成 `version: '1'`，再執行：

```bash
npm run typecheck
```

預期看到字串不能指派給數字的錯誤，指令以非零狀態結束。這是型別不符，尚未開始執行文章規則。再執行 `npm run build`，也應失敗且沒有新的應用輸出；本章 build 會先清除原本的 `dist`。

恢復數字 `1` 後，再進行下一個實驗。

### 實驗 B：型別正確，業務行為卻錯了

把 `src/article.ts` 的 `version: article.version + 1` 暫時改成 `version: article.version`：

```bash
npm run typecheck
npm test
```

型別檢查會通過，因為兩者都是數字；測試卻應失敗，因為發佈後版本沒有增加。這就是需要行為測試的原因。

恢復 `+ 1`，最後執行 `npm run check` 確認回到通過狀態。不要把錯誤的預期值改成符合程式來「修好」測試；先確認產品規則與實作哪一邊有問題。

## 01.10 用斷點觀察一次發佈

斷點會讓程式暫停，方便查看 `draft`、`article.status` 與 `article.version`。本章提供 [VS Code 除錯設定](examples/01/.vscode/launch.json)，**請以 `nodejs-course/examples/01` 作為 VS Code 開啟的資料夾**，讓設定中的 `${workspaceFolder}` 指向本章專案。

### 本機 Node 路線

1. 在終端機執行 `npm run build`。
2. 在 `src/article.ts` 的 `if (article.status !== 'draft')` 那一行設斷點。
3. 開啟「執行與偵錯」，選擇「01：啟動本機範例」，開始除錯。
4. 暫停後查看 `article.status` 與 `article.version`，逐步執行到回傳新物件。
5. 回到 `main.ts` 後，觀察原本的 `draft` 與新的 `published`。

此設定使用主機上的 Node；若只安裝 Docker，使用下方連接方式。每次修改後都先重新建置，避免斷點對到舊輸出。

### Docker 路線

先在範例目錄建置，再執行：

```bash
docker compose run --rm tools npm run build
docker compose run --rm -p 127.0.0.1:9229:9229 tools \
  node --enable-source-maps --inspect-brk=0.0.0.0:9229 dist/main.js
```

看到 `Debugger listening ...` 後，程序會等待除錯器，不會立刻輸出文章結果。在 VS Code 設好前述斷點，選擇「01：連接 Docker 除錯程序」，開始除錯並繼續執行。

`localRoot` 對應本機範例目錄，`remoteRoot` 對應容器的 `/work`；source map 則將 `dist/article.js` 對回 `src/article.ts`。這兩層對應讓編輯器能顯示正確的原始碼位置。

容器內監聽 `0.0.0.0` 是為了讓轉發連線進得來，主機的連接埠則只綁定 `127.0.0.1`。除錯介面具有執行程式的能力，不應公開到網路；本章一般啟動不開啟它。[Node.js 除錯說明](https://nodejs.org/en/learn/getting-started/debugging)

結束時停止除錯並在終端機以 `Ctrl+C` 結束仍在等待的程序。若 `9229` 已被其他除錯程序使用，先停止那個程序，或同時修改映射與編輯器設定中的主機連接埠。

## 01.11 常見問題、練習與驗收

| 現象 | 優先檢查 |
|------|----------|
| `ENOENT`，找不到 `package.json` | 是否位於 `nodejs-course/examples/01` |
| 安裝時出現 `EBADENGINE` | `node --version`、`npm --version` 是否符合本章；切換版本後再安裝 |
| `npm ci` 說 manifest 與 lockfile 不一致 | 若是有意調整依賴，用 `npm install` 更新並檢查差異；若是誤改則恢復，不要直接刪 lockfile |
| `tsc: not found` 或找不到 Jest | 是否在同一環境執行過 `npm ci`，且沒有省略開發依賴 |
| Docker 能測，本機找不到工具 | 容器依賴在 volume；本機要另外用同版 Node／npm 安裝 |
| `Cannot find module ... dist/main.js` | 尚未成功建置；先執行 `npm run build` |
| 改了 `.ts`，輸出卻仍是舊內容 | `npm start` 不負責建置；先重新建置，或確認監看沒有錯誤 |
| 測試說沒有測試檔 | 使用 `npm test`，讓編譯先產生 `.test-dist/test`；不要只單獨呼叫 Jest |
| 斷點是灰色，或沒有停在預期位置 | 檢查開啟的專案資料夾、重新建置、source map 與 Docker 路徑對應 |
| `--inspect-brk` 啟動後沒有文章輸出 | 正在等待除錯器連線並繼續執行 |

### 練習一：判斷要提交哪些檔案

下列哪些應提交 Git：`src/main.ts`、`package-lock.json`、`node_modules`、`dist`、`tsconfig.json`、`.nvmrc`？

<details>
<summary>參考答案</summary>

提交 `src/main.ts`、`package-lock.json`、`tsconfig.json`、`.nvmrc`。依賴與建置產物由安裝／建置重建；本章 `.gitignore` 也排除測試產物與本機環境檔。

</details>

### 練習二：版本為何不能寫死？

把發佈後版本暫時改成固定的 `2`，先執行應用，再執行測試。為什麼示範輸出看似正確，測試卻會失敗？

<details>
<summary>參考答案</summary>

應用的草稿從版本 1 開始，固定回 2 剛好符合這一個例子；測試使用版本 3，正確結果是 4。單一示範結果不能證明規則對其他輸入也成立。完成後恢復 `article.version + 1`。

</details>

### 本章完成檢查

- [ ] 能確認 Node 與 npm 版本，知道版本檔不會自動切換執行環境。
- [ ] 能從 `npm ci` 開始，完成 `npm run check` 與 `npm start`。
- [ ] 知道修改依賴時為何要一起更新 `package.json` 與 lockfile。
- [ ] 能找到 `src`、`dist`、`test` 與 `.test-dist`，解釋各自用途。
- [ ] 已觀察型別錯誤與業務錯誤的不同失敗方式，並恢復所有修改。
- [ ] 能在發佈規則設斷點，查看原始文章與回傳文章。
- [ ] 知道目前通過的是純函式測試，尚未驗證 HTTP、登入或資料庫。

下一章：[02 — 模組、套件入口與環境設定](02-modules-packages-and-configuration.md)，會解釋 ESM／CommonJS、套件入口與環境設定，讓本章先用起來的設定變得可推理。

---

[上一章：課程地圖與專題契約](00-course-map-and-project-contract.md) · [返回課程總覽](README.md) · [本章範例](examples/01/README.md)
