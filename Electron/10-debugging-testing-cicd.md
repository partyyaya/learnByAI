# 第十章：除錯、測試與 CI/CD 發佈流程

## 10.1 章節目標

本章讓專案從「可運作」走向「可長期維護」：

- 建立除錯流程
- 加入自動化測試
- 用 CI/CD 自動建置與發佈

---

## 10.2 常用除錯指令

```bash
# 開發模式啟動應用，搭配 DevTools 進行前端除錯
npm run dev

# 啟用 Electron 詳細日誌，排查主程序啟動與事件問題
ELECTRON_ENABLE_LOGGING=true npm run dev

# 印出 Electron 版本，確認團隊成員環境一致
npx electron --version
```

### 對 Main process 下中斷點

DevTools 只看得到 renderer。Main process 的程式（IPC handler、選單、自動更新）要另外接除錯器：

```bash
# 以 inspector 模式啟動，Main process 會在 9229 埠等待除錯器連線
npx electron --inspect=9229 .
```

接著在 Chrome 打開 `chrome://inspect`，在 Remote Target 找到 Electron 的項目按 inspect，就能對 `src/main/` 的程式下中斷點。要從第一行就停住（例如排查啟動流程），改用 `--inspect-brk=9229`。

VS Code 使用者可以建立 `.vscode/launch.json`，按 F5 直接啟動並在 main.js 設中斷點：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Main Process",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "windows": {
        "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron.cmd"
      },
      "args": ["."],
      "outputCapture": "std"
    }
  ]
}
```

> 如果 `npm run dev` 一啟動就出現 `TypeError: Cannot read properties of undefined (reading 'whenReady')`，先檢查環境變數 `ELECTRON_RUN_AS_NODE`。它被設成 `1` 時，Electron 會以純 Node.js 模式執行，`require("electron")` 拿到的只是一個路徑字串，`app` 自然是 `undefined`。某些編輯器或其擴充套件開出來的終端機會帶著這個變數，執行 `unset ELECTRON_RUN_AS_NODE`（Windows PowerShell：`Remove-Item Env:ELECTRON_RUN_AS_NODE`）後再啟動即可。admin-dashboard 實戰專案的 `scripts/dev.mjs` 會自動移除它。

---

## 10.3 日誌與當機回報

`console.log` 在開發時很好用，但**打包後的 App 沒有終端機**——使用者端出錯時，你什麼都看不到。正式產品需要把日誌寫進檔案、把當機記錄下來，才有辦法遠端排查。

### 持久化日誌（electron-log）

```bash
# 安裝 electron-log，自動把 log 寫進檔案並輪替
npm install electron-log
```

`src/main/logger.js`：

```javascript
const log = require("electron-log/main");

// 讓 renderer 也能使用 electron-log；spyRendererConsole 會把 renderer 的 console.* 一併寫進 log 檔
log.initialize({ spyRendererConsole: true });

// 檔案只記 info 以上的層級，避免 debug 訊息把 log 塞滿
log.transports.file.level = "info";

// 接住 main process 沒被 catch 的例外與 Promise rejection，寫進 log 檔
log.errorHandler.startCatching();

module.exports = log;
```

在 `main.js` 最上方引入，之後用 `log.info` / `log.error` 取代 `console`：

```javascript
const log = require("./logger");

log.info("應用啟動", { version: app.getVersion() });
```

log 檔預設位置（依平台）：

- macOS：`~/Library/Logs/<appName>/main.log`
- Windows：`%USERPROFILE%\AppData\Roaming\<appName>\logs\main.log`
- Linux：`~/.config/<appName>/logs/main.log`

請使用者回報問題時，直接請他們附上這個檔案，就能看到完整脈絡。

### 捕捉當機事件

main process 裡沒被 catch 的 JavaScript 例外，上面的 `errorHandler.startCatching()` 已經會寫進 log。但 renderer 或 GPU 程序整個掛掉時不會丟出例外，要另外監聽兩個當機事件：

```javascript
// renderer 程序當掉（例如頁面 OOM、崩潰）
app.on("render-process-gone", (_event, _webContents, details) => {
  log.error("renderer 當掉：", details.reason);
});

// GPU 或其他子程序當掉
app.on("child-process-gone", (_event, details) => {
  log.error("子程序當掉：", details.type, details.reason);
});
```

> 若要把當機自動上傳到伺服器集中分析，可用 Electron 內建的 `crashReporter.start({ submitURL })`（需自架或使用第三方接收端），或直接接 [Sentry](https://docs.sentry.io/platforms/javascript/guides/electron/) 這類託管服務——它同時涵蓋 main 與 renderer 的例外與當機，適合正式產品。本課程先以 electron-log 建立最基本的可觀測性即可。

---

## 10.4 建立程式碼品質檢查

```bash
# 安裝 ESLint（JavaScript 靜態分析）與 Prettier（格式化工具）
npm install --save-dev eslint @eslint/js globals prettier eslint-config-prettier

# 初始化 ESLint 設定（互動式）
npx eslint --init
```

> ESLint 9 起預設使用 **flat config**：`eslint --init` 會轉呼叫 `npm init @eslint/config`，產出的是 `eslint.config.js`（不再是 `.eslintrc.*`）。Electron 專案有兩種執行環境混在一起，記得在設定裡分開宣告 globals，否則會滿江紅：
>
> ```javascript
> // eslint.config.js
> const js = require("@eslint/js");
> const globals = require("globals");
>
> module.exports = [
>   // flat config 預設一條規則都不開，要明確加入官方推薦規則（no-unused-vars、no-undef 等）
>   js.configs.recommended,
>   {
>     // main / preload：Node.js 環境
>     files: ["src/main/**/*.js", "src/preload/**/*.js"],
>     languageOptions: { globals: { ...globals.node }, sourceType: "commonjs" }
>   },
>   {
>     // renderer：瀏覽器環境
>     files: ["src/renderer/**/*.js"],
>     languageOptions: { globals: { ...globals.browser } }
>   },
>   // 放最後：關掉所有跟 Prettier 打架的格式規則
>   require("eslint-config-prettier")
> ];
> ```

`package.json` 可新增：

```json
{
  "scripts": {
    "lint": "eslint \"src/**/*.{js,mjs,cjs}\"",
    "format": "prettier --write \"src/**/*.{js,json,md,css,html}\""
  }
}
```

```bash
# 執行靜態分析，提早發現未使用變數或可疑語法
npm run lint

# 自動格式化程式碼，維持團隊一致風格
npm run format
```

---

## 10.5 加入單元測試（Vitest 範例）

```bash
# 安裝 Vitest，建立快速的單元測試流程
npm install --save-dev vitest

# 建立單元測試目錄（與 10.6 的 E2E 測試分開放）
mkdir -p tests/unit
```

單元測試聚焦在「不依賴 Electron 執行環境的純邏輯」。以第七章抽出的 `isSafeExternalUrl` 為例，建立第一個測試檔。

`tests/unit/url-guard.test.js`：

```javascript
import { describe, it, expect } from "vitest";
import { isSafeExternalUrl } from "../../src/main/utils/url-guard";

describe("isSafeExternalUrl", () => {
  it("允許白名單內的 https 網址", () => {
    expect(isSafeExternalUrl("https://www.electronjs.org/docs")).toBe(true);
  });

  it("拒絕白名單外的網域", () => {
    expect(isSafeExternalUrl("https://evil.example.com")).toBe(false);
  });

  it("拒絕非 https 協定", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });

  it("拒絕無法解析的字串", () => {
    expect(isSafeExternalUrl("not-a-url")).toBe(false);
  });
});
```

> 測試檔用 ESM 的 `import` 語法即可——Vitest 內建轉譯，即使專案本身是 CommonJS、被測模組用 `module.exports` 匯出，named import 也能正常運作。

`package.json`：

```json
{
  "scripts": {
    "test": "vitest run tests/unit",
    "test:watch": "vitest tests/unit"
  }
}
```

> 腳本刻意把範圍限定在 `tests/unit`：10.6 的 Playwright 測試檔（`tests/e2e/*.spec.js`）也符合 Vitest 預設的掃描規則，不加範圍的話 Vitest 會誤把 E2E 測試當單元測試執行而報錯。

```bash
# 執行一次性測試，適合 CI 使用
npm run test

# 監看模式測試，適合本機開發邊寫邊驗證
npm run test:watch
```

---

## 10.6 E2E 測試（Playwright + Electron）

```bash
# 安裝 Playwright 測試框架，建立端到端互動測試
npm install --save-dev @playwright/test playwright

# 建立 E2E 測試目錄
mkdir -p tests/e2e
```

> Playwright 對 Electron 的支援走 `_electron` 入口，直接啟動你專案裡的 Electron 執行檔，**不需要** `npx playwright install` 下載瀏覽器（那是測試一般網頁時才需要的）。

`tests/e2e/app.spec.js`：

```javascript
const { test, expect } = require("@playwright/test");
const { _electron: electron } = require("playwright");

test("應用程式可啟動並顯示主畫面", async () => {
  // 啟動 Electron App（"." 代表以專案根目錄為入口，等同 npm run dev）
  const app = await electron.launch({ args: ["."] });

  // 取得第一個開啟的視窗
  const window = await app.firstWindow();

  // 驗證畫面標題與初始文字
  await expect(window.locator("h1")).toHaveText("我的第一個 Electron App");

  await app.close();
});
```

`package.json` 新增腳本：

```json
{
  "scripts": {
    "test:e2e": "playwright test tests/e2e"
  }
}
```

```bash
# 執行 E2E 測試，會真的啟動 Electron 視窗跑完整個流程
npm run test:e2e
```

> **跑 E2E 之前請先關掉 `npm run dev`。** 第五章 5.8 加了單一實例鎖，Playwright 的 `electron.launch()` 只是再啟動一份程序——拿不到鎖就會立刻 `app.quit()`，於是測試在第一行就失敗：
>
> ```text
> > 5 |   const app = await electron.launch({ args: ["."] });
>       |               ^
>   1 failed
> ```
>
> 錯誤訊息只會顯示一堆 websocket 斷線，完全不會提到「鎖」，很容易卡很久。CI 上因為環境乾淨不會遇到，只有本機邊開 dev 邊跑測試才會踩到。
>
> 如果你希望測試環境能與 dev 並存，可以讓單一實例鎖在測試時跳過——例如 `main.js` 改成 `const gotTheLock = process.env.E2E_TEST ? true : app.requestSingleInstanceLock();`，再於 `electron.launch({ args: ["."], env: { ...process.env, E2E_TEST: "1" } })` 傳入。

---

## 10.7 建立 CI 工作流程

建立 `.github/workflows/release.yml`：

```yaml
name: Release Electron App

on:
  push:
    tags:
      - "v*.*.*"

# 允許 workflow 內建的 GITHUB_TOKEN 建立 Release（預設只有讀取權限）
permissions:
  contents: write

jobs:
  build:
    runs-on: macos-latest
    steps:
      - name: Checkout source
        uses: actions/checkout@v5

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run lint
        run: npm run lint

      - name: Run tests
        run: npm run test

      - name: Build and publish release
        run: npm run dist -- --publish always
        env:
          # electron-builder 讀取 GH_TOKEN，把安裝檔與 latest*.yml 上傳到 GitHub Release
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # 若第九章已開啟 macOS 簽章與 notarize，這些 secrets 必須一起設定
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

流程重點：

- `--publish always`：electron-builder 打包完會直接把產物與 `latest*.yml` 上傳到 GitHub Release。第九章的自動更新讀取的正是這些檔案，這一步把「發版 → 使用者收到更新」整條鏈路接起來；少了它，建置產物會隨 CI 執行環境一起消失。
- Release 的名稱來自 `package.json` 的版本（`v` + version），不是你推上去的 tag，所以發版前一定要先更新版本號（見 10.8）。第九章 9.6 的 publish 設定加了 `releaseType: "release"`，上傳後就是正式 Release；少了它，electron-builder 預設建立 draft，electron-updater 看不到，使用者也就收不到更新。
- 這份 workflow 和第九章的 macOS 自動更新前提是一組：若 `build.mac.notarize: true`，GitHub repo 必須設定 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` secrets。若只是課程練習、還沒有 Apple Developer 憑證，先拿掉 `notarize: true`，並在 `build.mac` 加上 `"identity": null` 明確跳過簽章（notepad-app 與 admin-dashboard 實戰專案就是這樣設定的）。但未簽章的 mac 版無法自動更新（第九章 9.9），別把它發佈成正式版本。
- 此範例只在 macOS runner 上打包 mac 版。若要同時發佈 Windows / Linux 版，可用 `strategy.matrix` 在各自平台的 runner 上執行同一組步驟（electron-builder 的簽章與部分安裝檔格式無法跨平台產生）。
- 上面只跑了 lint 與單元測試。要把 10.6 的 E2E 也納入把關，加一個步驟即可——但 **Linux runner 沒有桌面環境**，`electron.launch()` 會因為開不了視窗而失敗，必須包一層虛擬顯示器：

```yaml
      # macOS / Windows runner 直接這樣寫
      - name: Run E2E tests
        run: npm run test:e2e

      # ubuntu-latest 要改成這樣（先裝 xvfb）
      # - run: sudo apt-get install -y xvfb
      # - run: xvfb-run --auto-servernum npm run test:e2e
```

---

## 10.8 發版建議流程

```bash
# 先確認工作區乾淨：這次要發版的變更都已經 commit
git status

# 更新 package.json 的版本號，並自動建立 commit 與 v1.1.0 tag
# （electron-builder 用 package.json 的版本命名 Release，自動更新也是比對這個版本；tag 只負責觸發 CI）
npm version 1.1.0 -m "release: v%s"

# 推送主分支最新程式碼到遠端
git push origin main

# 推送版本標籤，讓 CI 依 tag 觸發發版工作
git push origin v1.1.0
```

`npm version` 會一次完成「改版本號、commit、打 tag」三件事，tag 與 `package.json` 的版本就不會對不上。工作區有未 commit 的變更時它會拒絕執行，這也順便擋掉了把暫存檔打進正式版的情況。

---

## 10.9 本章小結

- 你會對 Main process 下中斷點，並建立了可重複的除錯與驗證流程
- 你用 electron-log 與當機事件建立了打包後也查得到的可觀測性
- 你導入了 Lint、單元測試與 E2E 測試基礎
- 你掌握了以 `npm version` 更新版本、Git Tag 觸發 CI/CD 發版的實務路線

---

> 下一章：[Steam 發行實戰（上傳、迭代、測試、排錯）](./11-steam-release-workflow.md)
