# 實戰專案：本機記事本（Notepad）

一個**完全離線、資料只存在本機**的桌面記事本。左側是記事清單、右側是撰寫區，內容可以直接貼上文字與圖片。

這個專案把課程 01～09 章學到的東西組成一個能用的小產品：三進程架構、IPC 白名單、preload 橋接、`userData` 檔案儲存、自訂協定、CSP 與內容淨化。

---

## 功能

| 位置 | 功能 |
|------|------|
| 左側上方 | **＋ 新增記事** 按鈕：清空右側撰寫區，回到「撰寫模式」 |
| 左側中間 | 記事清單（新到舊），點任一筆即可在右側**查看**該篇記事 |
| 左側下方 | 🌐 **語言**（中文／English）；◐ **外觀樣式**（白／黑）；🗀 **記事資料**（匯出／匯入／開啟位置）；⌨ **鍵盤快捷鍵** |
| 右側上方 | **標題**輸入框；留空時自動以**當天日期時間**作為標題（例如 `2026/07/30 14:05`） |
| 右側中間 | **內容**編輯區，可貼上純文字，也可直接 `Cmd/Ctrl + V` 貼上圖片 |
| 右側下方 | **新增**按鈕：**只有按下它才會真的存檔**，在此之前都只是草稿 |
| 檢視模式 | 顯示該篇記事的標題、時間與內容，右下角可**開始編輯**或**刪除這篇** |
| 編輯模式 | 按「開始編輯」把該篇載回撰寫區，按鈕變成**儲存修改**，旁邊多一顆**取消編輯** |

所有資料（記事 JSON + 圖片檔）都寫在作業系統的 `userData` 目錄，不連任何伺服器。

> 「刪除」不在原始需求裡，但沒有它就只能一直累積記事，因此一併做進來；不需要的話刪掉 [src/renderer/index.html](./src/renderer/index.html) 的 `deleteBtn` 與 [src/renderer/app.js](./src/renderer/app.js) 對應的事件即可。

---

## 畫面結構

```text
┌────────────────┬─────────────────────────────────────────┐
│  ＋ 新增記事    │  標題（留空自動用日期時間）                │
├────────────────┤─────────────────────────────────────────┤
│  2026/07/30 …  │                                         │
│  會議筆記       │   內容編輯區                              │
│  待辦清單       │   （可貼上文字與圖片）                     │
│  …             │                                         │
│                ├─────────────────────────────────────────┤
│ 🌐 ◐ 🗀 ⌨       │         [ 取消編輯 ] [ 新增／儲存修改 ] │
└────────────────┴─────────────────────────────────────────┘
   sidebar                       撰寫區 / 檢視區
```

檢視區的右下角則是 `[ 刪除這篇 ] [ 開始編輯 ]`。撰寫區與編輯區是**同一塊畫面**，差別只有底部按鈕的文字，以及有沒有「取消編輯」。左下角四個圖示分別是語言、外觀樣式、記事資料、快捷鍵說明。

---

## 語言（i18n）

支援**中文（繁體）**與**英文**，第一次開啟時依系統偏好自動選；點左下角的 🌐 圖示可以自己改，選過就記住。

語言判斷在 [settings.store.js](./src/main/store/settings.store.js)：

```javascript
// getPreferredSystemLanguages() 會依偏好順序回傳，例如 ["zh-Hant-TW", "en-US"]
function detectLanguage(preferred = app.getPreferredSystemLanguages()) {
  for (const tag of preferred) {
    const lower = String(tag).toLowerCase();
    if (lower.startsWith("zh")) return "zh-Hant"; // 中文只做繁體一種
    if (lower.startsWith("en")) return "en";
  }
  return "en"; // 日文、德文…都退回英文
}

// 使用者自己選過就以設定為準，沒選過才看系統
function resolveLanguage() {
  return readSettings().language ?? detectLanguage();
}
```

用 `getPreferredSystemLanguages()` 而不是 `app.getLocale()`：前者是「使用者在系統設定裡排出來的語言順序」，後者只是目前的地區設定，拿來判斷「主要使用的語言」前者比較準（而且 `getLocale()` 必須等 app ready）。

字典在 [src/renderer/i18n.js](./src/renderer/i18n.js)，`t("compose.addFailed", { message })` 這樣取用。四個設計上的取捨：

- **HTML 不寫死字串**：標籤上掛 `data-i18n="key"`（或 `data-i18n-placeholder` / `-aria-label` / `-title`），`applyStaticTranslations()` 統一套用。HTML 裡留的中文只是套用前的預設值。
- **切語言不重新載入頁面**：`refreshTexts()` 把會變的地方重跑一次（靜態文字、快捷鍵清單、底部按鈕、日期格式、檢視區的「編輯於 …」），編輯到一半的內容不會被清掉。
- **日期跟著語言**：`toLocaleString()` 的地區設定由 `getDateLocale()` 提供（`zh-TW` / `en-US`），所以中文是 `2026/07/30 16:26`、英文是 `07/30/2026, 16:26`。
- **語言選項不翻譯**：選單裡固定寫「中文」與「English」——英文介面下也要看得懂中文那一項。

### main process 不產生給人看的文字

`notes.store.js` 以前會丟 `throw new Error("標題長度不可超過 200 字")`，那樣英文介面就會冒出中文錯誤。現在改成丟**錯誤代碼**，由 renderer 決定顯示哪一句：

```javascript
// main：只講「發生什麼事」
throw new Error("TITLE_TOO_LONG");

// renderer：決定「怎麼說」
const ERROR_MESSAGE_KEYS = { TITLE_TOO_LONG: "error.titleTooLong", /* … */ };

function describeError(error) {
  const message = String(error?.message ?? "");
  for (const [code, key] of Object.entries(ERROR_MESSAGE_KEYS)) {
    if (message.includes(code)) return t(key);
  }
  return message; // 對不到就原樣顯示
}
```

用 `includes` 比對是因為錯誤穿過 IPC 時會被包成 `Error invoking remote method 'notes:create': Error: TITLE_TOO_LONG`，而且自訂的 `error.code` 屬性不會跟著過來，只有 message 會。

### 為什麼不能用 `window.confirm()`

原生對話框的「OK / Cancel」是**作業系統**給的：介面明明是中文，按鈕卻是英文，而且吃不到主題顏色。所以改成自己用 `<dialog>` 做一個，包成回傳 `Promise<boolean>` 的 `askConfirm()`：

```html
<!-- <form method="dialog"> 的按鈕會把 value 帶進 dialog.returnValue -->
<form method="dialog" class="dialog__footer">
  <button id="confirmCancelBtn" class="btn btn--ghost" value="cancel"></button>
  <button id="confirmOkBtn" class="btn btn--danger" value="ok"></button>
</form>
```

```javascript
confirmDialog.addEventListener("close", () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(confirmDialog.returnValue === "ok"); // Esc 與點 backdrop 都會走到這裡＝取消
});
```

連帶影響：`canLeaveEdit()` 從同步變成 `async`，所有會離開編輯狀態的地方（新增記事、點其他記事、取消編輯）都要 `await`。

---

## 外觀樣式

點左下角的 ◐ 圖示，可以在兩套樣式之間切換，選好會立刻套用並記住：

| 樣式 | 主要顏色 | 列表選中 |
|------|----------|----------|
| 白 | `#fcfcfc` | `#eeeeee` |
| 黑 | `#0d1117` | `#212830` |

顏色只寫在 [src/renderer/styles.css](./src/renderer/styles.css) 最上面的 CSS 變數裡，元件一律讀變數；要加第三套樣式就是再多一組 `:root[data-theme="…"]`。

---

## App 圖示

圖示是一隻**橘白肥貓捧著一支筆**，用手寫的 SVG 畫的（[build/icon.svg](./build/icon.svg)），沒有外部素材。

```bash
npm run icon    # build/icon.svg → build/icon.png（1024×1024）
```

[scripts/make-icon.js](./scripts/make-icon.js) 直接用 Electron 算圖：開一個隱藏的離屏視窗載入 SVG，再 `capturePage()` 存成 PNG，所以不用裝 sharp 或 ImageMagick——Chromium 本來就是很好的 SVG 算圖器。想調整貓的樣子就改 SVG 再跑一次。

> **圖案不要畫滿整張畫布。** macOS 的 App 圖示有固定留白：1024×1024 的畫布裡，圓角方塊只佔中間的 **824×824**（四邊各留 100，圓角半徑 185）。畫滿的話放到 dock 上會明顯比旁邊的 App 大一圈。`icon.svg` 裡是先畫在 0..1024 的座標系，再整組 `translate(100 100) scale(0.8047)` 縮進那塊方塊裡。

圖示掛在三個地方：

| 位置 | 做法 |
|------|------|
| Windows / Linux 視窗與工作列 | `new BrowserWindow({ icon })` |
| macOS 開發時的 dock | `app.dock.setIcon()`（`BrowserWindow` 的 `icon` 在 macOS 沒有作用） |
| 打包後的 App | 由 `electron-builder` 從 `build/icon.png` 產生 `.icns` / `.ico`（第八章） |

---

## App 名稱（dock 上為什麼是「Electron」）

滑鼠移到 dock 圖示上顯示的名字、選單列左上角的名字，都是 **LaunchServices 從 app bundle 的 `Info.plist` 讀來的**，`app.setName()` 改不到——它只會改 `app.getName()`。開發時跑的其實是 `node_modules/electron/dist/Electron.app`，所以那裡顯示的一直是 Electron。

[scripts/rename-dev-app.js](./scripts/rename-dev-app.js) 由 `npm run dev` 自動執行，做兩件事：

```javascript
// 1. 改開發用 Electron.app 的 Info.plist
for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  plistBuddy("-c", `Set :${key} 記事本`);
}

// 2. 只改檔案沒用，LaunchServices 會用快取的舊名字；
//    而且只跑 `lsregister -f` 也叫不動它，一定要先 `-u` 把舊紀錄踢掉
execFileSync(LSREGISTER, ["-u", appBundle]);
execFileSync(LSREGISTER, ["-f", "-R", appBundle]);
```

已經改過就直接跳出，不重複寫檔；`npm install` 重裝之後會變回 Electron，下次 `npm run dev` 再改一次。**打包後的 App 不需要這一步**，`electron-builder` 會用 `package.json` 的 `productName` 直接產生正確的 bundle。

> **`productName` 會連帶改到資料夾。** `app.getName()` 會優先用 `productName`，而 `userData` 預設是 `<appData>/<app 名稱>`——加了 `productName: "記事本"` 之後，資料會跑到 `Application Support/記事本/`，已經存在的記事看起來就像整批消失。所以 [main.js](./src/main/main.js) 在 ready 之前把路徑釘死：
>
> ```javascript
> app.setPath("userData", path.join(app.getPath("appData"), "electron-notepad"));
> ```

---

## 鍵盤快捷鍵

| macOS | Windows / Linux | 作用 |
|-------|-----------------|------|
| `⌘` + `N` | `Ctrl` + `N` | 新增記事（回到撰寫區） |
| `⌘` + `S` | `Ctrl` + `S` | 儲存：新增或儲存修改（只在撰寫區有效） |
| `⌘` + `E` | `Ctrl` + `E` | 編輯目前檢視的記事（只在檢視區有效） |
| `⌘` + `/` | `Ctrl` + `/` | 打開快捷鍵說明彈窗 |
| `Esc` | `Esc` | 取消編輯／關閉彈窗 |
| `⌘` + `V` | `Ctrl` + `V` | 在內容區貼上文字或圖片 |

同一份清單同時餵給說明彈窗與鍵盤事件，不會出現「說明寫了但其實沒作用」的情況。

**修飾鍵會依作業系統自動切換**：macOS 認 `⌘`（`event.metaKey`），Windows / Linux 認 `Ctrl`（`event.ctrlKey`）；彈窗標題、每一顆按鍵標籤、左下角圖示的 tooltip、編輯區的貼上提示，全部跟著換。彈窗標題會直接寫出判斷結果（例如「鍵盤快捷鍵（Windows）」），一眼就知道目前吃哪一套。

---

## 快速開始

> 需要 **Node.js 20 LTS 以上**。本機預設的 `node` 可能是舊版（v12），請先 `nvm use 20.19.5` 再操作。

```bash
# 進入專案
cd Electron/projects/notepad-app

# 安裝依賴（只有 electron 與 electron-builder 兩個 devDependency，沒有任何 runtime 依賴）
npm install

# 啟動
npm run dev
```

> 圖示（`build/icon.png`）已經產生好了，改了 `build/icon.svg` 才需要重跑 `npm run icon`。

四個指令：

| 指令 | 做什麼 |
|------|--------|
| `npm run dev` | 開發模式啟動 |
| `npm run icon` | `build/icon.svg` → `build/icon.png` |
| `npm run pack` | 只產生 App 本體（不做安裝檔），驗打包結果最快 |
| `npm run dist` | 產生安裝檔（macOS `.dmg` / Windows `.exe` / Linux `.AppImage`） |

> **在 VS Code 內建終端機啟動會失敗？** VS Code 會把 `ELECTRON_RUN_AS_NODE=1` 傳給子行程，導致 Electron 以純 Node 模式啟動，`require("electron")` 會拿到一個字串路徑而不是 API，出現 `Cannot read properties of undefined (reading 'whenReady')`。改用系統終端機，或這樣啟動：
>
> ```bash
> env -u ELECTRON_RUN_AS_NODE npm run dev
> ```

---

## 專案結構

```text
notepad-app/
├─ package.json
├─ build/
│  ├─ icon.svg                   # App 圖示的原始檔（橘白肥貓捧著一支筆）
│  └─ icon.png                   # 1024×1024，由 icon.svg 產生
├─ scripts/
│  ├─ make-icon.js               # npm run icon：用 Chromium 把 SVG 畫成 PNG
│  └─ rename-dev-app.js          # npm run dev 前置：把 dock 上的「Electron」改成「記事本」
└─ src/
   ├─ main/                      # 主程序：所有檔案存取都在這裡
   │  ├─ main.js                 # 進入點：建視窗、註冊協定與 IPC
   │  ├─ image-protocol.js       # 自訂協定 note-image://
   │  ├─ ipc/
   │  │  ├─ notes.ipc.js         # 記事的 IPC 白名單通道
   │  │  ├─ settings.ipc.js      # 外觀樣式與語言的 IPC 通道
   │  │  └─ backup.ipc.js        # 匯出／匯入（含系統存檔、開檔對話框）
   │  └─ store/
   │     ├─ notes.store.js       # 記事與圖片的本機儲存
   │     ├─ settings.store.js    # settings.json（外觀樣式、語言）＋ 系統語言判斷
   │     └─ backup.store.js      # 備份檔的組裝與還原（含匯入驗證）
   ├─ preload/
   │  └─ preload.js              # contextBridge：11 個方法 + 3 個唯讀字串，其餘一概不開放
   └─ renderer/
      ├─ index.html              # 版面 + CSP（文字都掛 data-i18n，不寫死）
      ├─ styles.css              # 版面 + 兩套樣式的 CSS 變數
      ├─ i18n.js                 # 中英文字典 + t()，在 app.js 之前載入
      └─ app.js                  # 清單、模式切換、編輯、快捷鍵、樣式、語言、貼上、HTML 淨化
```

資料流永遠是同一條：**renderer → preload（`window.notesApi` / `window.settingsApi`）→ IPC → main → 檔案系統**。renderer 完全沒有 Node.js 權限（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`）。

---

## 資料存在哪裡？

程式只用 `app.getPath("userData")` 底下的一個資料夾：

```text
<userData>/notepad/
├─ notes.json          # 所有記事
├─ settings.json       # { "theme": "light" | "dark", "language": "zh-Hant" | "en" | null }
└─ images/             # 貼上的圖片，檔名是隨機十六進位字串
   └─ 8347756c….png
```

左下角的 🗀 圖示會打開「記事資料」彈窗，裡面有三個動作：**匯出備份**、**匯入備份**、**開啟儲存位置**，下方直接顯示目前的完整路徑。

### 匯出 / 匯入

備份檔是**一個 JSON**，內容是設定 + 全部記事 + 全部圖片（base64）：

```json
{
  "format": "notepad-backup",
  "version": 1,
  "exportedAt": "2026-07-30T09:03:11.284Z",
  "settings": { "theme": "dark", "language": "en" },
  "notes": [ /* 跟 notes.json 一樣 */ ],
  "images": { "8347756c….png": "iVBORw0KGgoAAA…" }
}
```

為什麼是 base64 而不是 zip：這個專案刻意維持零 runtime 依賴，Node 內建沒有 zip。平常存檔堅持不用 base64（會讓 `notes.json` 爆炸，見上面第 1 點），但備份是「一次性、要一個檔案帶著走」的情境，用體積換簡單划算——想省空間的話 `node:zlib` 的 `gzipSync()` 也是內建的。

**匯入是整包取代**，所以有三層保護：

- 按下去先跳確認彈窗，講明會覆蓋現有內容。
- 真的動手前把現有的 `notes.json` 複製成 `notes.json.pre-import.bak`。
- 備份檔是**完全不可信的輸入**，[backup.store.js](./src/main/store/backup.store.js) 逐筆檢查後才寫進去，有一筆壞掉就整個拒絕（不會匯入一半）：

```javascript
// 圖片檔名沿用 image-protocol.js 那套白名單，順便擋掉 ../ 路徑穿越
const IMAGE_NAME_PATTERN = /^[a-f0-9]+\.(png|jpg|gif|webp)$/;

function sanitizeNote(note) {
  // …型別與長度都檢查過…
  // 只留認得的欄位重新組一個物件，備份檔裡多塞的東西不會流進 notes.json
  const clean = { id, title, contentHtml, createdAt };
  if (typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt))) {
    clean.updatedAt = updatedAt;
  }
  return clean;
}
```

寫完記事與圖片後再跑一次 `cleanupOrphanImages()`，沒被新記事引用的舊圖片就一併清掉，達成「整包取代」而不是「疊上去」。

檔案要存到哪、要讀哪一個，一律由使用者在系統的 `dialog.showSaveDialog()` / `showOpenDialog()` 裡挑；renderer 只傳「對話框上要顯示的字」（標題、檔案類型名稱）過去，拿不到也指定不了路徑。

### 開啟儲存位置

做法是 main 端的 `shell.openPath()`：

```javascript
ipcMain.handle("notes:open-data-dir", async () => {
  notesStore.ensureDataDirs(); // 資料夾被手動刪掉時先補回來，不然一定打不開

  // 路徑是 main 自己算出來的（app.getPath("userData") 底下），
  // 絕對不能拿 renderer 傳來的字串去 openPath——那等於開放它開啟任何檔案。
  const failure = await shell.openPath(notesStore.dataDir());
  if (failure) {
    console.error("打開記事資料夾失敗：", failure);
    throw new Error("OPEN_FOLDER_FAILED");
  }
  return { opened: true };
});
```

`shell.openPath()` 失敗時不會 throw，而是**回傳錯誤字串**（成功時是空字串），很容易寫成「永遠成功」，要記得檢查回傳值。

`<userData>` 的實際位置（在 [main.js](./src/main/main.js) 用 `app.setPath()` 釘死成 `electron-notepad`，不跟著 `productName` 改）：

- macOS：`~/Library/Application Support/electron-notepad/`
- Windows：`%APPDATA%\electron-notepad\`
- Linux：`~/.config/electron-notepad/`

`notes.json` 的格式：

```json
{
  "notes": [
    {
      "id": "3f0c…",
      "title": "2026/07/30 14:05",
      "contentHtml": "會議重點<div>下週追蹤<img src=\"note-image://images/8347756c….png\"></div>",
      "createdAt": "2026-07-30T06:05:12.345Z",
      "updatedAt": "2026-07-30T08:41:03.912Z"
    }
  ]
}
```

`updatedAt` 只有編輯過的記事才有；`id` 與 `createdAt` 一旦建立就不會再變，列表排序也一直以 `createdAt` 為準（編輯不會把記事往上推）。

---

## 九個實作重點

### 1. 圖片為什麼要用自訂協定，而不是 base64？

貼上的圖片如果直接轉成 `data:image/png;base64,…` 塞進內容，`notes.json` 會迅速膨脹到幾十 MB，每次開 App 都要整包讀進記憶體。

這裡改成：**圖片存成獨立檔案，內容裡只留一段短網址**。但 renderer 不能直接讀 `file://`（`webSecurity` 會擋，也等於把整個檔案系統開給頁面），所以自己註冊一個唯讀的協定，只服務 `images/` 目錄底下、檔名符合格式的檔案（[src/main/image-protocol.js](./src/main/image-protocol.js)）：

```javascript
const FILE_NAME_PATTERN = /^[a-f0-9]+\.(png|jpg|gif|webp)$/;

protocol.handle(SCHEME, (request) => {
  const { pathname } = new URL(request.url);
  const fileName = path.basename(decodeURIComponent(pathname));

  if (!FILE_NAME_PATTERN.test(fileName)) {
    return new Response("Invalid image name", { status: 400 });
  }
  return net.fetch(pathToFileURL(path.join(imagesDir, fileName)).toString());
});
```

兩個容易踩的坑：

- `protocol.registerSchemesAsPrivileged()` 必須在 **`app.whenReady()` 之前**呼叫，`protocol.handle()` 則要在**之後**。
- 檔名是 main process 自己用 `crypto.randomBytes()` 產生的，不採用 renderer 傳來的名稱，`path.basename()` + 白名單正則再擋一層路徑穿越。

### 2. 貼上圖片的完整路徑

renderer 只負責把二進位丟給 main（[src/renderer/app.js](./src/renderer/app.js)）：

```javascript
editor.addEventListener("paste", (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  // getAsFile() 與 getData() 都必須在事件處理器裡同步取得，await 之後剪貼簿就讀不到了
  const imageItem = [...clipboard.items].find(
    (item) => item.kind === "file" && item.type.startsWith("image/")
  );

  event.preventDefault(); // 一律接手貼上行為，避免外部 HTML 直接進到編輯器

  if (imageItem) {
    const file = imageItem.getAsFile();
    if (file) insertImageFile(file, currentRangeInEditor());
    return;
  }

  document.execCommand("insertText", false, clipboard.getData("text/plain"));
  syncEditorPlaceholder();
});
```

`ArrayBuffer` 可以直接穿過 `contextBridge` 與 IPC（結構化複製），不需要先轉 base64。main 端收到後才決定副檔名、檢查大小上限並寫檔。

貼純文字時刻意 `preventDefault()` 再自己 `insertText`，是為了**只取 `text/plain`**——否則從網頁複製過來的 HTML（含 `<script>`、`onclick`、外部圖片）會整包進到 `contenteditable` 裡。

### 3. 存檔前與顯示時都要淨化

記事內容存的是 HTML 字串，所以兩個方向都要過濾，用的是同一個 `sanitizeInto()`：

- **存檔前**：把編輯區的 DOM 重建成只含白名單標籤的 HTML，`<img>` 只接受 `note-image://images/` 開頭的 src。
- **顯示時**：先用 `DOMParser` 解析成 inert document（不會載入資源、不會執行腳本），過濾完才掛上畫面。

清單標題則一律用 `textContent`，不碰 `innerHTML`。

### 4. 寫檔要原子化，讀檔要能救回來

[src/main/store/notes.store.js](./src/main/store/notes.store.js) 寫入時先寫 `.tmp` 再 `rename`，避免寫到一半斷電留下半殘 JSON：

```javascript
function writeNotesFile(notes) {
  const target = notesFile();
  const temp = `${target}.tmp`;

  fs.writeFileSync(temp, JSON.stringify({ notes }, null, 2), "utf8");
  fs.renameSync(temp, target);
}
```

讀取時若 JSON 壞掉，改名成 `notes.json.bak` 後回傳空陣列——**壞資料不該讓整個 App 開不起來**。

### 5. 孤兒圖片清理

「貼了圖但最後沒按新增」會留下沒人引用的圖片檔。做法是掃一次所有記事內容裡的 `note-image://images/xxx`，不在集合裡的檔案就刪除；啟動時與刪除記事後各跑一次。

### 6. 預設標題放在 main，不是 renderer

「標題留空 → 用當天日期時間」的規則寫在 `createNote()` 裡，renderer 只管把使用者輸入的字串送出去：

```javascript
const note = {
  id: crypto.randomUUID(),
  title: title.trim() || defaultTitle(now),
  contentHtml,
  createdAt: now.toISOString()
};
```

規則放在資料寫入的那一層，之後不管是選單、快捷鍵還是其他視窗來新增記事，行為都一致。

### 7. 編輯沿用同一塊撰寫區

「編輯」沒有再做一個新畫面，而是把記事載回原本的撰寫區，只用一個 `editingId` 區分現在是新增還是編輯（[src/renderer/app.js](./src/renderer/app.js)）：

```javascript
function fillCompose(note) {
  editingId = note?.id ?? null;
  selectedId = editingId;

  titleInput.value = note?.title ?? "";
  editor.replaceChildren();
  if (note) editor.append(parseStoredHtml(note.contentHtml));

  // 用「過濾後」的內容當比較基準，才不會一進編輯就被判定成有修改
  editSnapshot = note ? { title: titleInput.value, contentHtml: serializeEditor() } : null;

  addBtn.textContent = note ? "儲存修改" : "新增";
  cancelEditBtn.classList.toggle("is-hidden", !note);
}
```

三個值得注意的地方：

- **載入內容一樣要過淨化**：`parseStoredHtml()` 是顯示用的那一套，編輯時同樣走一次，存回去的內容才不會愈存愈髒。
- **快照要在淨化之後取**：`parseStoredHtml()` → `serializeEditor()` 之後的 HTML 未必等於檔案裡的原字串（例如標籤順序、屬性寫法），所以基準必須是「剛載入完的編輯區序列化結果」，否則一進編輯就會被判定成「有未儲存的修改」。
- **切走前先問**：點左側其他記事、按「新增記事」、按「取消編輯」都會先跑 `canLeaveEdit()`，內容真的變了才跳確認。

main 端的 `updateNote()` 則刻意只換掉 `title` / `contentHtml`：

```javascript
const updated = {
  ...original,
  // 編輯時把標題清空＝回到「用建立時間當標題」，與新增時的規則一致
  title: title.trim() || defaultTitle(new Date(original.createdAt)),
  contentHtml,
  updatedAt: new Date().toISOString() // id 與 createdAt 一律沿用原本的
};
```

`id` 不變，圖片網址才不會失效；`createdAt` 不變，列表順序才不會因為改個錯字就跳到最上面。寫檔後再跑一次 `cleanupOrphanImages()`，把編輯時刪掉的圖片一併清乾淨。

### 8. 快捷鍵與說明彈窗共用同一份定義

快捷鍵最容易壞的地方是「說明裡寫了，但程式其實沒接」。這裡把它們放在同一個陣列裡，彈窗是渲染它、鍵盤事件是查它：

```javascript
const SHORTCUTS = [
  { keys: [MOD_LABEL, "N"], key: "n", description: "新增記事", run: () => newNoteBtn.click() },
  { keys: [MOD_LABEL, "S"], key: "s", description: "儲存（新增／儲存修改）",
    enabled: isComposing, run: () => addBtn.click() },
  { keys: [MOD_LABEL, "E"], key: "e", description: "編輯目前這篇記事",
    enabled: () => !isComposing(), run: () => editBtn.click() },
  ...
];

document.addEventListener("keydown", (event) => {
  if (shortcutDialog.open) return; // 彈窗開著就交給 <dialog> 自己處理 Esc
  ...
  const shortcut = SHORTCUTS.find((item) => item.key === event.key.toLowerCase());
  if (!shortcut) return;

  event.preventDefault(); // 認得的組合一律吃掉，例如 ⌘S 的「儲存網頁」
  if (!shortcut.enabled || shortcut.enabled()) shortcut.run();
});
```

四個細節：

- **`run` 一律走 `.click()`**：邏輯只寫在按鈕的事件處理器裡，快捷鍵不另外複製一份（也順便沿用按鈕 `disabled` 時不觸發的行為）。
- **`enabled` 不能省**：對 `display: none` 的按鈕呼叫 `.click()` **仍然會**觸發它的事件處理器。少了這層，在檢視模式按 `⌘S` 會拿撰寫區的舊內容再存一篇出來。
- **彈窗用原生 `<dialog>` + `showModal()`**：backdrop、Esc 關閉、焦點鎖定都是瀏覽器內建的，不用自己做遮罩。清單一樣用 `createElement` + `textContent` 組出來，不碰 `innerHTML`。
- **平台判斷集中在三個常數**：

  ```javascript
  // renderer 沒有 process，平台字串由 preload 從 process.platform 傳過來
  const PLATFORM = window.appInfo?.platform ?? "win32";
  const IS_MAC = PLATFORM === "darwin";
  const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

  // 兩邊都要把另一顆排除掉：mac 上按 Ctrl+S、Windows 上按 Win+S 都不該觸發
  function isModPressed(event) {
    return IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }
  ```

  顯示用的字串（按鍵標籤、tooltip、編輯區提示）全部從 `MOD_LABEL` 產生，HTML 裡不寫死「Cmd/Ctrl」，不然只要有一處忘了改就會跟實際行為對不上。

> 快捷鍵寫在 renderer 只對「有焦點的視窗」有效，這個單視窗 App 剛好夠用。要讓它出現在系統選單、或多視窗共用，就要改用 main 的 `Menu` accelerator（第七章）；選單的 accelerator 會比 renderer 的 `keydown` 先攔到按鍵。

### 9. 主題要在「第一次繪製之前」就決定好

樣式本身只是 CSS 變數，難的是**開場不要閃一下白的再變黑**。順序是這樣安排的：

```javascript
// main.js：建視窗之前先讀設定，視窗底色與 preload 的參數都用同一個值
const { theme } = settingsStore.readSettings();

mainWindow = new BrowserWindow({
  backgroundColor: settingsStore.backgroundColor(theme), // 視窗還沒載入內容時的底色
  webPreferences: {
    ...
    additionalArguments: [`--initial-theme=${theme}`] // 塞進 renderer 的 process.argv
  }
});
```

```javascript
// preload.js：sandbox 下仍讀得到 process.argv，同步交給 renderer
contextBridge.exposeInMainWorld("appInfo", {
  platform: process.platform,
  initialTheme: initialThemeFromArgv()
});

// app.js：整支檔案的第一件事，<script> 在 </body> 前，會在第一次繪製之前跑完
applyTheme(window.appInfo?.initialTheme);
```

三段各自負責一塊，缺一個就會看到閃爍：`backgroundColor` 顧的是「視窗開了但頁面還沒載入」，`additionalArguments` 顧的是「頁面載入了但還沒問到設定」（用 IPC 讀是非同步的，一定來不及），CSS 變數顧的是之後的即時切換。

其餘三個細節：

- **切換時三邊一起更新**：renderer 換 `data-theme`，main 收到 IPC 後設 `nativeTheme.themeSource`（原生捲軸、右鍵選單、`confirm()` 跟著換）並 `setBackgroundColor()`。
- **`color-scheme` 要寫**：`:root[data-theme="dark"] { color-scheme: dark; }` 一行，就能讓捲軸與表單元件用深色版本；沒寫的話深色底上會出現亮白色捲軸。
- **樣式值一樣過白名單**：`setTheme()` 只接受 `light` / `dark`，其他值直接丟錯，不會被寫進 `settings.json`（`setLanguage()` 同理）。
- **寫設定一律先讀再合併**：`writeSettings()` 會把現有設定讀出來合併後才寫回，不然存了語言就會把樣式洗掉。

---

## 安全設定一覽

| 設定 | 位置 | 作用 |
|------|------|------|
| `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` | `main.js` | renderer 拿不到 Node.js API |
| `contextBridge` 只開放 11 個方法與 3 個唯讀字串 | `preload.js` | 不把 `ipcRenderer` 或 `process` 整包丟給頁面 |
| `shell.openPath()` 只吃 main 自己算出來的路徑 | `notes.ipc.js` | 不接受 renderer 傳路徑，否則等於開放它開啟任何檔案 |
| 讀寫哪個檔案由系統對話框決定 | `backup.ipc.js` | renderer 只傳顯示文字，指定不了路徑 |
| 匯入的備份檔逐筆驗證後才落地 | `backup.store.js` | 型別、長度、圖片檔名白名單；有一筆壞掉就整個拒絕 |
| CSP `default-src 'self'; img-src 'self' note-image:` | `index.html` | 擋掉外部腳本與外部圖片追蹤 |
| `setWindowOpenHandler` → `shell.openExternal` | `main.js` | 外部連結用系統瀏覽器開，不在 App 內開視窗 |
| `dragover` / `drop` 一律 `preventDefault()` | `app.js` | 避免把檔案拖進視窗時直接導航離開頁面 |
| main 端檢查型別、長度、MIME、檔名 | `notes.store.js` | renderer 傳來的資料一律視為不可信 |
| 樣式與語言比對白名單後才寫檔 | `settings.store.js` | 同上，白名單以外一律丟錯 |
| main 只回錯誤代碼，不回句子 | `notes.store.js` | 資料層不決定 UI 文字，也不外洩內部細節 |

---

## 打包

用 `electron-builder`（第八章），設定寫在 `package.json` 的 `build` 欄位：

```bash
npm run pack    # 只做 App 本體 → dist/mac-arm64/記事本.app
npm run dist    # 做安裝檔     → dist/記事本-1.0.0-arm64.dmg
```

打包只會平台自己那一份：在 macOS 上跑就出 `.dmg`，Windows 出 NSIS 安裝檔，Linux 出 `AppImage`。`dist/` 已經在 `.gitignore` 裡（一次 dmg 大約 110MB）。

```jsonc
"build": {
  "appId": "com.learnbyai.notepad",
  "directories": { "output": "dist", "buildResources": "build" },
  // 只打包執行時真的會用到的東西：scripts/ 與 build/ 都不進 asar
  "files": ["src/**/*", "package.json"],
  "mac": { "target": "dmg", "icon": "build/icon.png", "identity": null },
  "win": { "target": "nsis", "icon": "build/icon.png" },
  "linux": { "target": "AppImage", "icon": "build/icon.png" }
}
```

幾個實際打包時才會遇到的點：

- **App 名稱不用再動手改**：打包版的 `CFBundleName` 直接來自 `productName`，所以 [scripts/rename-dev-app.js](./scripts/rename-dev-app.js) 那套只在開發時需要。
- **圖示自動轉檔**：`build/icon.png`（1024×1024）會被轉成 `.icns` / `.ico`，不用自己準備多尺寸。
- **`build/` 不在 `files` 裡**，所以 [main.js](./src/main/main.js) 的 `app.dock.setIcon()` 要用 `app.isPackaged` 擋掉——打包後的 dock 圖示本來就由 bundle 的 icns 負責，再去讀那個 PNG 只會找不到檔案。
- **`identity: null` 是「不簽章」**：自己在本機跑沒問題，但**發給別人會被 Gatekeeper 擋**（顯示「已損毀，應丟到垃圾桶」）。要真的散佈得申請 Apple Developer ID 憑證再加上 notarize，這部分看第八章。
- **`ELECTRON_RUN_AS_NODE`**：在 VS Code 內建終端機裡直接執行打包好的 App 會秒退（exit 0、沒有任何訊息），因為它被當成純 Node 跑。從 Finder 點開不受影響，要在終端機測就用 `env -u ELECTRON_RUN_AS_NODE`。

---

## 對應課程章節

| 本專案的部分 | 對應章節 |
|--------------|----------|
| `main.js` 開窗與生命週期 | [02](../../02-first-app-quick-start.md)、[03](../../03-main-renderer-preload.md) |
| `preload.js` + `notes.ipc.js` | [04 IPC 通訊與安全橋接](../../04-ipc-communication.md) |
| `notes.store.js`／`settings.store.js` 本機儲存、`userData` 路徑 | [06 本機資料儲存與設定管理](../../06-data-storage-config.md) |
| 剪貼簿、`nativeTheme`、`shell.openExternal`、`shell.openPath` | [07 原生能力整合](../../07-native-features.md) |
| CSP、沙箱、視窗開啟控制 | [09 安全最佳實踐](../../09-security-auto-update.md) |
| App 圖示、`app.dock` | [07 原生能力整合](../../07-native-features.md)、[08 打包與發佈](../../08-packaging-distribution.md) |
| `package.json` 的 `build` 欄位、`npm run dist` | [08 打包與發佈](../../08-packaging-distribution.md) |

> 第六章用的是 `electron-store`；這裡改成自己用 `node:fs` 寫一層小 store，一來記事是「資料」而不是「設定」（要控制原子寫入與壞檔復原），二來讓專案維持零 runtime 依賴。兩種做法都值得會。

---

## 延伸練習

1. **快捷鍵搬到系統選單**：用 main 的 `Menu` + accelerator 重做現有的 `⌘N / ⌘S / ⌘E`，讓它們也出現在選單列。
2. **搜尋與排序**：sidebar 加搜尋框，用標題與內容純文字做過濾。
3. **自動存草稿**：把撰寫中（含編輯中）的內容定時寫進 `draft.json`，App 意外關閉也不會丟。
4. **匯出 Markdown**：目前的備份是給程式讀的 JSON，可以再加一個「匯出成 Markdown」，把單篇記事連同圖片輸出成人看的格式。
5. **改用 SQLite**：記事量大時把 `notes.json` 換成 `better-sqlite3`，`listNotes()` 以外的介面都不用動。
6. **簽章與 notarize**：目前打包出來的是未簽章版本，發給別人會被 Gatekeeper 擋；照第八章補上 Developer ID 憑證與 `afterSign` 的 notarize 流程。
7. **跟隨系統外觀**：外觀樣式多一個「自動」選項，用 `nativeTheme.shouldUseDarkColors` 與 `updated` 事件跟著系統換。
8. **自動更新**：照第九章加上 `electron-updater`，配合已經產生的 `.blockmap` 做差分更新。
9. **多一種語言**：在 `i18n.js` 加一組字典、`settings.store.js` 的 `LANGUAGES` 加一個值、`detectLanguage()` 加一條對應即可；缺翻譯的 key 會自動退回中文。
