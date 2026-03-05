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
      "package.json"
    ],
    "mac": {
      "target": ["dmg"],
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

# 依目前系統平台產生正式發佈檔（例如 mac 會產生 dmg）
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

## 8.6 常見打包問題

### 問題一：缺少 icon 導致包體警告

```bash
# 建立 build 目錄，放置各平台 icon（icns / ico / png）
mkdir -p build
```

建議放入：

- `build/icon.icns`（mac）
- `build/icon.ico`（Windows）
- `build/icon.png`（Linux）

### 問題二：打包過慢

```bash
# 清除舊的打包快取，避免壞掉的 cache 影響建置
rm -rf node_modules/.cache/electron-builder
```

---

## 8.7 本章小結

- 你學會用 `electron-builder` 產生跨平台安裝檔
- 你知道 `pack`（測試）與 `dist`（正式發佈）的差異
- 你可將輸出目錄標準化，方便後續 CI/CD 接手

---

> 下一章：[安全最佳實踐與自動更新](./09-security-auto-update.md)
