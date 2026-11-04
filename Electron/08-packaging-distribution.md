# 第八章：打包、安裝檔產生與跨平台發佈

## 8.1 為什麼要打包？

開發中的 `npm run dev` 只適合本機測試。  
要交付給使用者，需要產出可安裝的執行檔（例如 `.dmg`、`.exe`、`.AppImage`）。

---

## 8.2 安裝打包工具

```bash
# 安裝 electron-builder，負責把原始碼打包為各平台安裝檔
npm install --save-dev electron-builder
```

---

## 8.3 設定 package.json 打包腳本

`package.json` 範例：

```json
{
  "name": "electron-course-app",
  "version": "1.0.0",
  "description": "Electron 課程示範 App",
  "author": "LearnByAI <team@example.com>",
  "main": "src/main/main.js",
  "scripts": {
    "dev": "electron .",
    "pack": "electron-builder --dir",
    "dist": "electron-builder",
    "dist:mac": "electron-builder --mac",
    "dist:win": "electron-builder --win",
    "dist:linux": "electron-builder --linux"
  },
  "build": {
    "appId": "com.learnbyai.electroncourse",
    "productName": "LearnByAI Electron Course",
    "directories": {
      "output": "release"
    },
    "files": [
      "src/**/*",
      "assets/**/*",
      "package.json"
    ],
    "protocols": [
      {
        "name": "Learn Electron",
        "schemes": ["myapp"]
      }
    ],
    "mac": {
      "target": [
        {
          "target": "dmg",
          "arch": ["universal"]
        },
        {
          "target": "zip",
          "arch": ["universal"]
        }
      ],
      "category": "public.app-category.developer-tools"
    },
    "win": {
      "target": ["nsis"]
    },
    "linux": {
      "target": ["AppImage"]
    }
  }
}
```

`devDependencies` 的實際版本號建議以 `npm install` 產生結果為主。

設定重點：

- `directories.output` 統一輸出到 `release/`：第九章（上傳 GitHub Release）與第十一章（Steam 上傳）都沿用這個路徑，請勿任意更名
- mac 的 target 除了 `dmg` 外還有 `zip`：這是第九章 `electron-updater` 在 macOS 上做自動更新的**必要格式**，缺少 zip 會導致更新檢查失敗
- mac 的 `arch` 不要省略：electron-builder 若沒有指定架構，會依目前打包機器的架構輸出。例如在 Apple Silicon 上只會得到 arm64，Intel Mac 使用者裝不起來。上面用 `universal` 產出 Intel + Apple Silicon 都能跑的包；若你的 App 有原生模組，也可以在 CI 裡分別建 `x64` / `arm64`，但要確認第九章的更新檔不會互相覆蓋。
- `description` 與 `author` 建議一開始就寫：electron-builder 會檢查這些欄位，Linux 的 deb / rpm 類 target 對 maintainer 資訊也更嚴格；`author` 最好包含 email。
- `files` 除了 `src/**/*` 外**務必列入 `assets/**/*`**：第五章的系統匣圖示放在專案根目錄的 `assets/`（`assets/trayTemplate.png`），它既不在 `src/` 下、也不是 node_modules。`files` 是「白名單」——沒被列到的目錄不會打進 `app.asar`。少了這行，`npm run dev` 一切正常，但 `npm run dist` 後啟動就會**載入不到圖示**，重演第五章 5.2 警告過的「隱形系統匣」問題。
  - 反之，production 相依套件（第六章 `electron-store`、第九章 `electron-updater`）與 `package.json` 由 electron-builder 依 `dependencies` 自動含入，不必列在 `files`；`build/` 底下的 icon 也會自動偵測。真正需要你手動補的是這類「非程式碼的資源目錄」。
- `protocols` 宣告第七章 7.7 的 `myapp://` 深層連結。macOS 只會把協定交給 Info.plist 有宣告的 App，執行期呼叫 `setAsDefaultProtocolClient` 補不上，所以要在這裡宣告，由 electron-builder 寫進 Info.plist。
- `electron` 必須留在 `devDependencies`：打包時 electron-builder 會另外放入對應版本的 Electron 執行檔，`electron` 套件本身不該進 App。若把它放進 `dependencies`，electron-builder 會直接報錯，要求你移回 `devDependencies`。同理，只在開發時用的套件（打包工具、測試框架）都別放進 `dependencies`，否則會被打包進去、讓安裝檔變大。

---

## 8.4 打包前檢查

```bash
# 先安裝所有相依套件，避免打包時缺少模組
npm install

# 先在開發模式啟動，確認目前程式可正常運作
npm run dev
```

---

## 8.5 產生安裝檔

```bash
# 只打包成可執行資料夾，不產生安裝程式（適合快速驗證）
npm run pack

# 依目前系統平台產生正式發佈檔（例如 mac 會產生 dmg + zip）
npm run dist

# 只打包 mac 版本（通常需在 macOS 環境執行）
npm run dist:mac

# 只打包 Windows 版本（可用 Windows 主機或 CI cross-build）
npm run dist:win

# 只打包 Linux 版本
npm run dist:linux
```

打包完成後，輸出通常在 `release/`。

---

## 8.6 打包後的檔案結構：asar 與路徑

`files` 列到的內容會被打包成一個 `app.asar` 封存檔（macOS 在 `你的App.app/Contents/Resources/`，Windows / Linux 在安裝目錄的 `resources/`）。Electron 會把它當成唯讀資料夾，`require`、`fs.readFile`、`loadFile` 都能照常讀，所以前幾章 `path.join(__dirname, ...)` 的寫法打包後仍然有效。要注意三件事：

1. **App 目錄是唯讀的**：不要把資料寫到 `__dirname` 底下。asar 不能寫入，安裝目錄通常也沒有寫入權限，開發時正常、打包後才失敗。使用者資料一律寫到 `app.getPath("userData")`（第六章）。
2. **外部程式讀不到 asar 裡的檔案**：asar 格式只有 Electron 自己看得懂。若要用 `child_process` 執行你附帶的二進位檔（例如 ffmpeg），必須用 `asarUnpack` 把它解到旁邊的 `app.asar.unpacked/` 目錄。原生模組的 `.node` 檔 electron-builder 會自動處理，不必自己列。

   ```json
   {
     "build": {
       "asarUnpack": ["bin/**/*"]
     }
   }
   ```

3. **很少變動的大型資源**（影片、模型檔）可以不打進 asar，改用 `extraResources` 複製到 `resources/` 目錄，程式裡用 `process.resourcesPath` 取得位置：

   ```json
   {
     "build": {
       "extraResources": [{ "from": "media", "to": "media" }]
     }
   }
   ```

   ```javascript
   // 開發時直接讀專案裡的 media/，打包後讀 resources/media/
   const mediaDir = app.isPackaged
     ? path.join(process.resourcesPath, "media")
     : path.join(__dirname, "../../media");
   ```

打包後想確認到底打進了哪些檔案，用 `@electron/asar` 列出來：

```bash
# macOS universal 版的位置；Windows 是 release/win-unpacked/resources/app.asar
npx @electron/asar list "release/mac-universal/LearnByAI Electron Course.app/Contents/Resources/app.asar"
```

若看到 `node_modules` 裡出現測試框架、打包工具，代表它們被誤放進 `dependencies`；若少了 `assets/` 之類的資源，就回頭檢查 `files`。

---

## 8.7 原生模組（Native Modules）

`better-sqlite3`、`sharp` 這類含 C/C++ 程式碼的套件，編譯出來的 `.node` 檔綁定特定 Node.js 版本的 ABI。Electron 內建的 Node.js 和你電腦上的 Node.js 版本不同，所以 `npm install` 裝好的原生模組，在 Electron 裡 `require` 常會出現：

```text
Error: The module '.../build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION <數字 A>. This version of Node.js requires
NODE_MODULE_VERSION <數字 B>.
```

解法是針對 Electron 重新編譯：

- **打包時**：electron-builder 預設會針對目標 Electron 版本自動重編（`npmRebuild: true`），並把 `.node` 檔解出 asar。
- **開發時**：要自己重編。最簡單的做法是讓每次 `npm install` 之後自動處理：

```json
{
  "scripts": {
    "postinstall": "electron-builder install-app-deps"
  }
}
```

原生模組也是跨平台打包的主要障礙：它通常要在目標平台上才編得出來（除非套件有提供預編譯檔），這也是第十章 CI 建議各平台用各自 runner 打包的原因之一。若只是需要保存本機資料，先評估第六章那種不需要編譯的方案。

---

## 8.8 常見打包問題

### 問題一：缺少 icon 導致包體警告

```bash
# 建立 build 目錄，放置各平台 icon（icns / ico / png）
mkdir -p build
```

建議放入：

- `build/icon.icns`（mac）
- `build/icon.ico`（Windows，至少 256×256）
- `build/icon.png`（Linux）

也可以只放一張至少 512×512（建議 1024×1024）的 `build/icon.png`，electron-builder 會自動轉成各平台需要的格式，notepad-app 實戰專案就是這樣做的。圖太小時，macOS 的 Dock 與 Finder 圖示會模糊，甚至直接打包失敗。

### 問題二：打包很慢或卡在下載

第一次打包時，electron-builder 要下載目標平台的 Electron 執行檔與打包工具（NSIS、dmg 相關工具），網路不穩時會卡很久甚至逾時。下載過的檔案會存在系統快取，之後就不必重抓：

| 平台 | Electron 執行檔 | electron-builder 工具 |
|------|-----------------|-----------------------|
| macOS | `~/Library/Caches/electron` | `~/Library/Caches/electron-builder` |
| Windows | `%LOCALAPPDATA%\electron\Cache` | `%LOCALAPPDATA%\electron-builder\Cache` |
| Linux | `~/.cache/electron` | `~/.cache/electron-builder` |

- 下載慢：和第一章一樣設定 `ELECTRON_MIRROR`；electron-builder 自己的工具改用 `ELECTRON_BUILDER_BINARIES_MIRROR` 指定鏡像。
- 打包本身慢：`universal` 要處理兩個架構，時間大約是單一架構的兩倍。本機驗證時先用 `npm run pack` 只產生目錄即可。
- 只有在快取檔損毀（解壓縮失敗、checksum 不符）時才需要刪掉上面的快取目錄重新下載；平常刪掉只會讓下一次打包更慢。

---

## 8.9 本章小結

- 你學會用 `electron-builder` 產生跨平台安裝檔
- 你知道 `pack`（測試）與 `dist`（正式發佈）的差異
- 你可將輸出目錄標準化，方便後續 CI/CD 接手
- 你知道打包後的檔案放在 `app.asar`、App 目錄唯讀，以及 `asarUnpack` / `extraResources` 的用途
- 你知道原生模組要針對 Electron 重新編譯

---

> 下一章：[安全最佳實踐與自動更新](./09-security-auto-update.md)
