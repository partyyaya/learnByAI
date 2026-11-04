# 第十一章：Steam 發行實戰（上傳、迭代、測試、排錯）

## 11.1 章節目標

本章會帶你把 Electron 專案做成可在 Steam 發行的版本，完整涵蓋：

- 打包成 Steam 適用格式
- 透過 SteamPipe 上傳版本
- 建立可重複的版本迭代流程
- 進行本機與分支測試
- 常見問題排錯（上傳失敗、啟動失敗、更新異常）

---

## 11.2 Steam 發行與一般桌面發行的差異

重點先記住兩件事：

1. Steam 會接管安裝與更新，所以 **Steam 版通常不使用 NSIS 安裝器**。  
2. Steam 會做內容差異更新，所以你應提供 **可直接執行的 unpacked 內容目錄**。

---

## 11.3 前置準備（帳號與權限）

你需要先具備：

- Steamworks Partner 帳號
- 已建立的 App（拿到 `AppID`）
- 至少一個 Depot（例如 Windows Depot，拿到 `DepotID`）
- 可上傳 build 的權限帳號

> 這四項從哪裡取得？
>
> - `Steamworks Partner 帳號`
>   - 到 [Steamworks Partner](https://partner.steamgames.com/) 註冊。
>   - 依流程完成必要資訊（例如開發者資料、付款/稅務資料）後，才可建立與管理 App。
> - `AppID`
>   - 在 Steamworks 後台建立新 App 後會自動產生。
>   - 可在 App 清單或該 App 的管理頁看到；管理頁網址通常也會帶 `appid` 參數。
> - `DepotID`
>   - 進入該 App 的 SteamPipe/Depots 設定頁建立或查詢。
>   - 常見做法是依平台拆分 Depot（例如 Windows、macOS、Linux 各一個）。
> - `可上傳 build 的權限帳號`
>   - 在 Steamworks 的 Users & Permissions 建立/指派成員帳號。
>   - 需對目標 App 具備上傳建置所需權限；若要把版本直接 `SetLive` 到分支，通常還需要發佈相關權限。
>   - 建議另建「CI 上傳專用帳號」，避免用個人主帳號做自動化上傳。

---

## 11.4 建立 Steam 專用打包腳本

### `package.json` 建議腳本

```json
{
  "scripts": {
    "build:steam:win": "electron-builder --win dir --x64 -c.publish=never -c.extraMetadata.distributionChannel=steam",
    "build:steam:linux": "electron-builder --linux dir -c.publish=never -c.extraMetadata.distributionChannel=steam",
    "build:steam:mac": "electron-builder --mac dir -c.publish=never -c.extraMetadata.distributionChannel=steam"
  }
}
```

說明：

- `--win dir`：輸出可執行目錄（不是安裝器），適合 SteamPipe 上傳
- `-c.publish=never`：避免 electron-builder 嘗試用其他 provider 自動發佈
- `-c.extraMetadata.distributionChannel=steam`：在打包進 App 的那份 `package.json` 多寫一個 `distributionChannel` 欄位，讓程式在執行時知道自己是 Steam 版（見 11.5）

---

## 11.5 Steam 版程式行為調整：停用自動更新

若你原本有 `electron-updater`，Steam 版一定要停用：Steam 自己會更新檔案，兩套更新機制會互相覆蓋；而且 `dir` 目標不會產生 `app-update.yml`，electron-updater 一啟動就會報錯（第九章 9.9）。

`src/main/main.js`（改寫第九章 9.8 的更新檢查）：

```javascript
// build:steam:* 腳本打包時寫進 package.json 的欄位；一般版本沒有這個欄位
const { distributionChannel } = require("../../package.json");
const isSteamBuild = distributionChannel === "steam";

app.whenReady().then(() => {
  // ...前幾章既有的 IPC 註冊與視窗建立

  // 非 Steam 的打包版本才檢查自動更新
  if (app.isPackaged && !isSteamBuild) {
    setupAutoUpdate();
    checkForUpdates();
  }
});
```

判斷依據一定要在**打包時**寫進 App。用執行期的環境變數（例如 `process.env.DISTRIBUTION_CHANNEL`）判斷是行不通的：玩家從 Steam 啟動 App 時不會帶著你自訂的變數，那個判斷在玩家電腦上永遠是 false。

---

## 11.6 安裝 SteamCMD（上傳工具）

以下以 Ubuntu/Debian 為例：

```bash
# 啟用 multiverse 套件來源（steamcmd 常在此來源）
sudo add-apt-repository multiverse

# 啟用 32-bit 架構支援（steamcmd 相關相依可能需要）
sudo dpkg --add-architecture i386

# 更新套件索引
sudo apt update

# 安裝 steamcmd
sudo apt install steamcmd -y
```

> macOS / Windows 也可使用 Steamworks SDK 裡附帶的 `steamcmd`。

---

## 11.7 建立 SteamPipe 目錄

在專案根目錄建立結構：

```bash
# 建立 Steam 發行工作目錄（腳本、內容、輸出日誌分開）
mkdir -p steam/scripts steam/content/windows steam/output

# 建立 App build 設定檔（控制 AppID、分支、Depots）
touch steam/scripts/app_build_123456.vdf

# 建立 Windows Depot 設定檔（控制實際要上傳哪些檔案）
touch steam/scripts/depot_build_123456_windows.vdf
```

---

## 11.8 撰寫 VDF（上傳設定）

`steam/scripts/app_build_123456.vdf`（請改成你的實際 ID）：

```text
"AppBuild"
{
  "AppID" "123456"
  "Desc" "Electron build v1.0.0"
  "BuildOutput" "../output"
  "ContentRoot" "../content"
  "SetLive" "beta"
  "Depots"
  {
    "1234561" "depot_build_123456_windows.vdf"
  }
}
```

`steam/scripts/depot_build_123456_windows.vdf`：

```text
"DepotBuildConfig"
{
  "DepotID" "1234561"
  "ContentRoot" "../content/windows"
  "FileMapping"
  {
    "LocalPath" "*"
    "DepotPath" "."
    "recursive" "1"
  }
  "FileExclusion" "*.pdb"
  "FileExclusion" "steam_appid.txt"
}
```

`FileExclusion` 可以寫多行；排除 `steam_appid.txt` 是為了避免 11.11 本機測試時建立的檔案被一起上傳。

上面 VDF 內的 `../content`、`../output` 是**相對於 VDF 檔案位置**（`steam/scripts/`）來解析；而執行 `steamcmd +run_app_build` 時，建議傳入 App build VDF 的絕對路徑，避免 steamcmd 安裝目錄、目前 shell 工作目錄與專案根目錄混在一起。

---

## 11.9 首次上傳流程（完整命令）

```bash
# 以下命令都從專案根目錄執行，不需要 cd steam

# 1) 打包 Steam 用的 Windows 內容（輸出到 release/win-unpacked，沿用第八章 directories.output 設定）
npm run build:steam:win

# 2) 清空舊版上傳內容，避免舊檔殘留
rm -rf steam/content/windows

# 3) 重建內容資料夾
mkdir -p steam/content/windows

# 4) 複製本次 build 到 Steam content root
cp -R release/win-unpacked/. steam/content/windows/

# 5) 確認執行檔是否存在（避免上傳後無法啟動）
ls -la steam/content/windows

# 6) 建立 App build VDF 的絕對路徑
APP_BUILD_SCRIPT="$(pwd)/steam/scripts/app_build_123456.vdf"

# 7) 第一次先互動式登入，完成 Steam Guard 驗證
steamcmd +login "$STEAM_USERNAME" +quit

# 8) 執行 App build 上傳（讀取 app_build_123456.vdf）
steamcmd +login "$STEAM_USERNAME" +run_app_build "$APP_BUILD_SCRIPT" +quit
```

> 建議：不要把密碼直接寫在命令列，避免 shell history 外洩。

---

## 11.10 版本迭代流程（每次發新版照做）

```bash
# 1) 更新專案版號（僅更新 package.json，不自動打 git tag）
npm version patch --no-git-tag-version

# 2) 重新打 Steam build
npm run build:steam:win

# 3) 同步最新檔案到 Steam content 目錄
rm -rf steam/content/windows
mkdir -p steam/content/windows
cp -R release/win-unpacked/. steam/content/windows/

# 4) 重新上傳到 Steam（建議先上 beta 分支）
APP_BUILD_SCRIPT="$(pwd)/steam/scripts/app_build_123456.vdf"
steamcmd +login "$STEAM_USERNAME" +run_app_build "$APP_BUILD_SCRIPT" +quit
```

建議迭代策略：

- 開發中版本都先 `SetLive: beta`
- QA 驗證通過後，到 Steamworks App Admin 的 Builds 頁面手動把該 build 設為 `default`（正式分支）。`SetLive` 可以自動切到 beta 這類非預設分支，但 `SetLive "default"` 不會讓正式分支自動上線。
- 每次上傳前更新 `Desc`（例如 `v1.0.3 hotfix login`），方便後台追蹤

---

## 11.11 測試流程（本機 + Steam 分支）

### A. 本機 Smoke Test（打包後先測）

```bash
# 檢查打包輸出內容是否完整（資源、exe、dll）
ls -la release/win-unpacked

# 建立 steam_appid.txt（讓本機啟動時可取得 AppID 上下文）
echo "123456" > release/win-unpacked/steam_appid.txt
```

> `steam_appid.txt` 只有在 App 有整合 Steamworks API（成就、雲端存檔、好友清單等，例如透過 [steamworks.js](https://github.com/ceifa/steamworks.js)）時才有意義：在 Steam 客戶端之外直接執行 exe 時，SDK 靠這個檔案得知 AppID。若你的 App 完全沒呼叫 Steam API，可跳過這一步。另外注意**不要把這個檔案上傳到 Steam Depot**，它只供本機測試使用；11.8 的 depot VDF 已用 `FileExclusion` 把它排除。
>
> 接著在 Windows 上直接執行 `release/win-unpacked/<你的程式>.exe` 做基礎冒煙測試。

### B. Steam Beta 分支測試

```bash
# 查詢 App 資訊（確認新版 manifest 是否可見，需有權限帳號）
steamcmd +login "$STEAM_USERNAME" +app_info_print 123456 +quit
```

建議測試清單：

- 是否可正常啟動（冷啟動 / 重啟）
- 更新後設定檔與本機資料是否保留
- Steam 啟動參數與權限行為是否正常
- 若使用 Steam API（成就/雲端）是否可成功初始化

---

## 11.12 常見排錯與修復步驟

### 問題一：上傳失敗或卡在舊快取

```bash
# 清空 SteamPipe 上傳輸出快取（避免殘留導致 chunk 問題）
rm -rf steam/output/*

# 重新上傳
APP_BUILD_SCRIPT="$(pwd)/steam/scripts/app_build_123456.vdf"
steamcmd +login "$STEAM_USERNAME" +run_app_build "$APP_BUILD_SCRIPT" +quit
```

### 問題二：上傳成功但 Steam 啟動失敗

```bash
# 檢查內容目錄是否真的有主執行檔
ls -la steam/content/windows

# 檢查 VDF 是否指向正確 Depot（快速搜尋 DepotID）
grep -nE "DepotID|AppID|ContentRoot|SetLive" steam/scripts/*.vdf
```

排查方向：

- Steamworks 後台 Launch Options 指向檔名是否正確
- `.exe` 是否在 Depot root 或你設定的子路徑

### 問題三：更新包過大（每次都像全量）

Electron 版最常見的原因是 `app.asar`：它是把所有程式碼與資源包在一起的單一大檔。SteamPipe 以約 1MB 的區塊比對差異，asar 前段的檔案只要大小一變，後面的內容就整段位移，差異會遠大於實際修改的量。

修復建議：

- 圖片、音效、影片這類很少變動的大型資源不要打進 asar，改用第八章 8.6 的 `extraResources` 放成獨立檔案，沒改的檔案就不會重傳
- Electron 執行檔本身（上百 MB）只在升級 Electron 版本時才會變動，不要每個小版本都順手升級 Electron
- 盡量讓檔案內容穩定，減少無意義重打包

### 問題四：Steam 版與 App 內更新打架

```bash
# 解開 Steam 版的 app.asar，確認 package.json 有寫入 distributionChannel
npx @electron/asar extract release/win-unpacked/resources/app.asar .steam-check
grep distributionChannel .steam-check/package.json

# 檢查完刪掉暫存資料夾
rm -rf .steam-check
```

修復建議：

- 確認 Steam 版是用 `build:steam:*` 腳本打包的，而不是一般的 `npm run dist`
- Steam 版停用 `electron-updater`（11.5），只保留 SteamPipe 作為更新來源

### 問題五：Linux 版在玩家電腦上啟動失敗（sandbox）

Linux 上的 Electron 預設要用 `chrome-sandbox` 這個 helper 建立沙箱，而它需要「root 擁有 + SUID」權限（4755）。透過 Steam 安裝的檔案都屬於玩家自己，不可能有這種權限，Electron 只能改用 Linux 的 user namespace 建立沙箱；如果玩家的發行版限制了 user namespace（例如 Ubuntu 24.04 起的 AppArmor 設定），啟動時就會出現：

```text
The SUID sandbox helper binary was found, but is not configured correctly.
```

Linux depot 上線前，請在目標發行版上實際從 Steam 安裝並啟動測試。若遇到這個錯誤，常見的處理方式是讓 App 帶 `--no-sandbox` 參數啟動，但這會關掉 renderer 沙箱、降低安全性，只適合確定不載入任何遠端內容的 App。

---

## 11.13 建議的自動化腳本（選配）

你可以新增 `scripts/steam-release.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

# 檢查必要環境變數，避免上傳到錯誤帳號
: "${STEAM_USERNAME:?STEAM_USERNAME is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_BUILD_SCRIPT="$PROJECT_ROOT/steam/scripts/app_build_123456.vdf"

cd "$PROJECT_ROOT"

# 打包 Steam 版
npm run build:steam:win

# 準備上傳內容
rm -rf steam/content/windows
mkdir -p steam/content/windows
cp -R release/win-unpacked/. steam/content/windows/

# 執行上傳
steamcmd +login "$STEAM_USERNAME" +run_app_build "$APP_BUILD_SCRIPT" +quit
```

執行方式：

```bash
# 給腳本可執行權限
chmod +x scripts/steam-release.sh

# 執行 Steam 上傳腳本
./scripts/steam-release.sh
```

### 在 CI 上傳：處理 Steam Guard

把這支腳本搬到 CI 時，最常卡在 Steam Guard：每次在新機器登入都要輸入驗證碼，而 CI 每次都是新機器。常見作法是：

1. 先在自己的電腦用 CI 專用帳號，跑一次 11.9 第 7 步的互動式登入並完成驗證。
2. steamcmd 會把登入憑證存在它安裝目錄下的 `config/config.vdf`。把這個檔案轉成 base64，存成 CI 的 secret。
3. CI 執行 steamcmd 之前，把 secret 還原成同一個位置的 `config/config.vdf`，之後的 `+login` 就不會再要求驗證碼。

這份憑證過一段時間會失效，到時重新互動式登入一次、更新 secret 即可。它等同帳號的登入權限，只能放在 CI 的 secret 裡，不要 commit 進 repo。

---

## 11.14 本章小結

- 你已完成 Electron 專案到 Steam 的完整發行路徑
- 你已建立可重複的上傳與迭代流程
- 你掌握了 Steam 分支測試與常見問題排查方法

---

> 建議下一步：把 `AppID`、`DepotID`、分支名稱改為 `.env` + 模板化腳本，讓團隊成員一鍵發版且不暴露敏感資訊。
