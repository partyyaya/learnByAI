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
    "build:steam:win": "electron-builder --win dir --x64 -c.publish=never",
    "build:steam:linux": "electron-builder --linux dir -c.publish=never",
    "build:steam:mac": "electron-builder --mac dir -c.publish=never"
  }
}
```

說明：

- `--win dir`：輸出可執行目錄（不是安裝器），適合 SteamPipe 上傳
- `-c.publish=never`：避免 electron-builder 嘗試用其他 provider 自動發佈

---

## 11.5 Steam 版程式行為調整（建議）

若你原本有 `electron-updater`，建議 Steam 版停用：

```javascript
// main process 範例（概念）
const isSteamBuild = process.env.DISTRIBUTION_CHANNEL === "steam";

if (!isSteamBuild) {
  // 非 Steam 版本才檢查自動更新
  // checkForUpdates();
}
```

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
}
```

---

## 11.9 首次上傳流程（完整命令）

```bash
# 1) 打包 Steam 用的 Windows 內容（輸出到 dist/win-unpacked）
npm run build:steam:win

# 2) 清空舊版上傳內容，避免舊檔殘留
rm -rf steam/content/windows

# 3) 重建內容資料夾
mkdir -p steam/content/windows

# 4) 複製本次 build 到 Steam content root
cp -R dist/win-unpacked/. steam/content/windows/

# 5) 確認執行檔是否存在（避免上傳後無法啟動）
ls -la steam/content/windows

# 6) 進入 steamcmd 執行目錄（若你的 steamcmd 在其他路徑請調整）
cd steam

# 7) 第一次先互動式登入，完成 Steam Guard 驗證
steamcmd +login "$STEAM_USERNAME" +quit

# 8) 執行 App build 上傳（讀取 app_build_123456.vdf）
steamcmd +login "$STEAM_USERNAME" +run_app_build "scripts/app_build_123456.vdf" +quit
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
cp -R dist/win-unpacked/. steam/content/windows/

# 4) 重新上傳到 Steam（建議先上 beta 分支）
steamcmd +login "$STEAM_USERNAME" +run_app_build "steam/scripts/app_build_123456.vdf" +quit
```

建議迭代策略：

- 開發中版本都先 `SetLive: beta`
- QA 驗證通過後，再切到 `default`（正式分支）
- 每次上傳前更新 `Desc`（例如 `v1.0.3 hotfix login`），方便後台追蹤

---

## 11.11 測試流程（本機 + Steam 分支）

### A. 本機 Smoke Test（打包後先測）

```bash
# 檢查打包輸出內容是否完整（資源、exe、dll）
ls -la dist/win-unpacked

# 建立 steam_appid.txt（讓本機啟動時可取得 AppID 上下文）
echo "123456" > dist/win-unpacked/steam_appid.txt
```

> 接著在 Windows 上直接執行 `dist/win-unpacked/<你的程式>.exe` 做基礎冒煙測試。

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
steamcmd +login "$STEAM_USERNAME" +run_app_build "steam/scripts/app_build_123456.vdf" +quit
```

### 問題二：上傳成功但 Steam 啟動失敗

```bash
# 檢查內容目錄是否真的有主執行檔
ls -la steam/content/windows

# 檢查 VDF 是否指向正確 Depot（快速搜尋 DepotID）
rg "DepotID|AppID|ContentRoot|SetLive" "steam/scripts"
```

排查方向：

- Steamworks 後台 Launch Options 指向檔名是否正確
- `.exe` 是否在 Depot root 或你設定的子路徑

### 問題三：更新包過大（每次都像全量）

修復建議：

- 避免每次重打大量無關大檔
- 將變動頻繁與低頻資源拆分目錄
- 盡量讓檔案內容穩定，減少無意義重打包

### 問題四：Steam 版與 App 內更新打架

```bash
# 檢查目前是否用 Steam 發行通道啟動（範例環境變數）
echo "$DISTRIBUTION_CHANNEL"
```

修復建議：

- Steam 版停用 `electron-updater`
- 只保留 SteamPipe 作為更新來源

---

## 11.13 建議的自動化腳本（選配）

你可以新增 `scripts/steam-release.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

# 檢查必要環境變數，避免上傳到錯誤帳號
: "${STEAM_USERNAME:?STEAM_USERNAME is required}"

# 打包 Steam 版
npm run build:steam:win

# 準備上傳內容
rm -rf steam/content/windows
mkdir -p steam/content/windows
cp -R dist/win-unpacked/. steam/content/windows/

# 執行上傳
steamcmd +login "$STEAM_USERNAME" +run_app_build "steam/scripts/app_build_123456.vdf" +quit
```

執行方式：

```bash
# 給腳本可執行權限
chmod +x scripts/steam-release.sh

# 執行 Steam 上傳腳本
./scripts/steam-release.sh
```

---

## 11.14 本章小結

- 你已完成 Electron 專案到 Steam 的完整發行路徑
- 你已建立可重複的上傳與迭代流程
- 你掌握了 Steam 分支測試與常見問題排查方法

---

> 建議下一步：把 `AppID`、`DepotID`、分支名稱改為 `.env` + 模板化腳本，讓團隊成員一鍵發版且不暴露敏感資訊。
