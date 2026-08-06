# 實戰專案：React 後台管理系統（Admin Dashboard）

一個用 **Electron + React** 做的後台管理介面。開場是登入頁，登入後左邊側邊欄、上面導航欄（含跑馬燈、使用者下拉選單與登出按鈕）、右邊是內容區。

跟 [notepad-app](../notepad-app/) 最大的差別是**資料來源**：記事本的資料存在本機檔案，這裡則有一個**跑在 main process 裡的模擬後端**——有路由表、有 token、有延遲、有隨機失敗、有 401/403/404/429，行為刻意做得跟真的 HTTP API 一樣。所以這個專案除了 Electron，也在練「前端怎麼跟後端相處」。

---

## 功能

| 位置 | 功能 |
|------|------|
| 登入頁 | 帳號密碼登入、錯誤提示、連續失敗鎖定、三組測試帳號一鍵填入 |
| 側邊欄 | 儀表板／使用者管理／訂單管理／系統設定，**有子選單的群組可以展開收起**，整條也可收合成只剩圖示 |
| 導航欄 | 目前頁面標題、**公告跑馬燈**（滑鼠移上去暫停）、**使用者下拉選單**、**登出按鈕** |
| 儀表板 | 四張 KPI 卡、14 日營收長條圖（可切換成表格）、訂單狀態分布、最近動態 |
| 使用者管理 → 使用者列表 | 關鍵字搜尋（debounce）、角色／狀態篩選、分頁、改角色、啟用停用、刪除（含確認視窗） |
| 使用者管理 → 角色與權限 | 三個角色 × 三個權限的對照表，附各角色的帳號數 |
| 訂單管理 | 關鍵字搜尋、狀態／通路篩選、分頁、每頁筆數、篩選後的營收小結 |
| 系統設定 → 介面外觀 | 深淺色主題 |
| 系統設定 → 模擬後端 | **調整模擬後端的延遲／失敗率／斷線** |
| 系統設定 → 連線測試 | 手動打 API 觀察成功與失敗時前端怎麼反應 |
| 個人資料 | 從下拉選單進入，顯示帳號、session 起訖時間與這個角色的權限 |

三組測試帳號（登入頁上點一下就會填入）：

| 帳號 / 密碼 | 角色 | 能做什麼 |
|-------------|------|----------|
| `admin` / `admin123` | 系統管理員 | 全部功能 |
| `editor` / `editor123` | 編輯者 | 可修改，但刪除會被擋（403） |
| `viewer` / `viewer123` | 唯讀訪客 | 只能看，所有寫入操作都會被擋 |

---

## 畫面結構

```text
┌───────────────────────────────────────────────────────────────────────┐
│ ● ● ●                       後台管理                                   │
├──────────────┬────────────────────────────────────────────────────────┤
│  LearnByAI   │ ▤ 儀表板   ((( 公告跑馬燈 )))      [👤 gary ▾] [ 登出 ] │
│  後台管理系統 ├────────────────────────────────────────────────────────┤
├──────────────┤                                                        │
│ ▦ 儀表板      │   ┌────────┐┌────────┐┌────────┐┌────────┐            │
│ ◍ 使用者管理 ▾│   │今日營收││今日訂單││啟用帳號││近14日  │            │
│ ▤ 訂單管理    │   └────────┘└────────┘└────────┘└────────┘            │
│ ⚙ 系統設定  ▴ │   ┌───────────────────────┐┌──────────────┐          │
│    介面外觀  │   │  每日營收（長條圖）      ││ 訂單狀態分布  │          │
│    模擬後端  │   └───────────────────────┘└──────────────┘          │
│    連線測試  │   ┌──────────────────────────────────────┐            │
│ ● 模擬後端    │   │  最近動態                              │            │
└──────────────┴────────────────────────────────────────────────────────┘
   titlebar（自己畫的）
   sidebar                            navbar + content
```

最上面那一條標題列是**頁面自己畫的**，不是系統的——系統標題列的底色改不動，深色後台配淺色標題列會脫節，所以把原生的藏起來、自己補一條同色的（見第 9 節）。

側邊欄有兩層：「使用者管理」與「系統設定」是**群組**，點一下展開子項（見第 7 節）；按導航欄左上角的按鈕可以把整條收成 68px（只剩圖示）。使用者下拉選單裡有個人資料、系統設定與主題切換；**登出是獨立的按鈕**，不藏在選單裡——後台最常用的兩個動作（看自己是誰、登出）都放在一眼看得到的位置。

---

## 快速開始

> 需要 **Node.js 20.19 以上**（Vite 8 的要求）。本機預設的 `node` 可能是舊版，請先 `nvm use 20.19.5` 再操作。

```bash
cd Electron/projects/admin-dashboard
npm install
npm run dev
```

| 指令 | 做什麼 |
|------|--------|
| `npm run dev` | 開 Vite dev server（有 HMR）+ 啟動 Electron |
| `npm run build` | 只建置 renderer → `dist-renderer/` |
| `npm run preview` | 建置後用 Electron 載入靜態檔，驗「打包後的樣子」 |
| `npm run pack` | 產生 App 本體（不做安裝檔） |
| `npm run dist` | 產生安裝檔（`.dmg` / `.exe` / `.AppImage`） |

> **VS Code 內建終端機不用特別處理。** VS Code 會塞 `ELECTRON_RUN_AS_NODE=1` 給子行程，讓 Electron 以純 Node 模式啟動（症狀是 `Cannot read properties of undefined (reading 'whenReady')`）。[scripts/dev.mjs](./scripts/dev.mjs) 已經在 spawn 之前把這個變數拔掉了。

---

## 專案結構

```text
admin-dashboard/
├─ package.json
├─ vite.config.mjs             # React plugin + 開發/打包兩套 CSP + base: "./"
├─ index.html                  # Vite 的進入 HTML（<!--CSP--> 會在建置時被換掉）
├─ scripts/
│  └─ dev.mjs                  # 先起 dev server，確定 listen 成功才 spawn Electron
├─ electron/                   # main process：不經過打包，直接跑 CommonJS
│  ├─ main.js                  # 建視窗、藏起原生標題列、兩種載入方式、導航白名單
│  ├─ preload.js               # contextBridge：只開放 2 個方法 + 3 個唯讀字串
│  └─ mock/
│     ├─ db.js                 # 假資料（固定種子亂數，每次啟動都一樣）
│     ├─ server.js             # 路由表、session、延遲、隨機失敗、狀態碼
│     └─ api.ipc.js            # 唯一的 IPC 通道 api:request
└─ src/                        # renderer：React，由 Vite 建置
   ├─ main.jsx                 # createRoot
   ├─ App.jsx                  # Provider 疊法 + HashRouter 路由表 + RequireAuth
   ├─ navigation.js            # 兩層選單的定義 + 反查頁面（Sidebar / Navbar / 路由共用）
   ├─ api/client.js            # api.get/post/patch/del → IPC，401 集中處理
   ├─ hooks/
   │  ├─ useApi.js             # loading / data / error + 競態處理 + useMutation
   │  └─ useDebouncedValue.js  # 搜尋框用
   ├─ context/
   │  ├─ AuthContext.jsx       # 登入狀態、權限、401 自動登出
   │  ├─ ThemeContext.jsx      # 深淺色主題（localStorage）
   │  └─ ToastContext.jsx      # 右下角浮動提示
   ├─ components/              # 版面與共用元件（含自己畫的 Titlebar）
   ├─ pages/                   # 九個頁面（含側邊欄兩個群組底下的五個子頁）
   ├─ utils/format.js          # 日期／金額格式化 + 狀態字典
   └─ styles/global.css        # 兩套主題的 CSS 變數 + 全部樣式
```

資料流永遠是同一條：

```text
頁面元件 → api.get("/users", …) → window.adminApi.request()
        → IPC「api:request」→ mock/server.js 路由表 → 假資料
```

renderer 完全沒有 Node.js 權限（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`），也**完全不發網路請求**——打包後的 CSP 就寫著 `connect-src 'none'`。

---

## 1. 為什麼 renderer 要建置，main 不用？

`.jsx` 瀏覽器看不懂，所以 renderer 一定要有建置步驟；但 main process 是 Node 環境，`require` 本來就能用，**沒有非建置不可的理由**。所以這個專案刻意只建置 `src/`：

| | 開發（`npm run dev`） | 打包後 |
|--|----------------------|--------|
| renderer | Vite dev server（`http://localhost:5173`，有 HMR） | `dist-renderer/index.html`（`loadFile`） |
| main / preload | 直接跑 `electron/*.js` | 直接跑 `electron/*.js` |

好處是 main process 改一行就重啟看結果，不用等打包；壞處是 main 不能用 `import` 語法（要寫 CommonJS），也不能用 TypeScript。這個取捨對「學習用專案」很划算——少一層建置就少一層要理解的黑盒子。

`main.js` 判斷的方式是看環境變數有沒有被設：

```javascript
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = Boolean(DEV_SERVER_URL);

if (IS_DEV) {
  mainWindow.loadURL(DEV_SERVER_URL);
} else {
  mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
}
```

### 為什麼不用 concurrently 同時跑兩條指令？

因為那樣有競爭條件：Electron 常常比 dev server 早 ready，一載入就吃到 `ERR_CONNECTION_REFUSED`。[scripts/dev.mjs](./scripts/dev.mjs) 改用 Vite 的 JS API，**確定 listen 成功之後才 spawn**：

```javascript
const server = await createServer({ mode: "development" });
await server.listen();

const env = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0] };
delete env.ELECTRON_RUN_AS_NODE;      // VS Code 內建終端機會塞這個，會讓 Electron 變成純 Node

const electron = spawn(electronPath, ["."], { stdio: "inherit", env });
electron.on("close", async (code) => {
  await server.close();               // 關掉 App 就把 dev server 一起收掉
  process.exit(code ?? 0);
});
```

順便解決兩件事：port 只寫在一個地方（`vite.config.mjs`），以及關掉 App 不會留一個孤兒 dev server 佔著 5173。

### `base: "./"` 少了會怎樣

打包後是用 `file://` 載入 `index.html`。Vite 預設的 `base: "/"` 會產生 `/assets/index-xxx.js` 這種絕對路徑，在 `file://` 下等於「從磁碟根目錄找」，一定 404，畫面全白。改成 `"./"` 才會是相對路徑。

### 開發與打包用兩套 CSP

開發時 Vite 需要 inline script（React Fast Refresh 的 preamble）與 WebSocket（HMR），打包後這兩個都不需要。與其為了讓 dev server 跑起來而永久放寬安全性，這裡在 `index.html` 留一個 `<!--CSP-->` 註解，由 Vite 的 `transformIndexHtml` 依情境換掉：

```javascript
function injectCsp() {
  return {
    name: "inject-csp",
    transformIndexHtml(html, ctx) {
      // ctx.server 只有 dev server 在跑時才有值
      return html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${ctx.server ? DEV_CSP : PROD_CSP}" />`);
    }
  };
}
```

打包後實際產生的是：

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'
```

`style-src` 還是留著 `'unsafe-inline'`，因為 React 的 `style={{ width: … }}`（長條圖的高度、進度條的寬度）算 inline style。要拿掉就得把所有動態尺寸改成 CSS 變數 + `<style>` 標籤，代價高於收益。

---

## 2. 模擬後端：像一個真的 HTTP API

整個假後端在 [electron/mock/](./electron/mock/)，三個檔案分工是「資料 / 邏輯 / 傳輸」：

| 檔案 | 負責 |
|------|------|
| [db.js](./electron/mock/db.js) | 假資料。用**固定種子**的亂數生成，每次啟動看到的 47 個使用者、136 筆訂單都一樣 |
| [server.js](./electron/mock/server.js) | 路由表、session、權限、延遲、隨機失敗、狀態碼 |
| [api.ipc.js](./electron/mock/api.ipc.js) | 唯一的 IPC 通道，負責把 renderer 傳來的東西當成不可信輸入檢查一遍 |

### 路由表

```javascript
const routes = [
  { method: "POST",   path: "/auth/login",  auth: false, handler },
  { method: "GET",    path: "/users",                    handler },
  { method: "PATCH",  path: "/users/:id",   roles: ["admin", "editor"], handler },
  { method: "DELETE", path: "/users/:id",   roles: ["admin"],           handler },
  // …
];
```

`:id` 會被編譯成正則（`/^\/users\/([^/]+)$/`）並把捕獲到的值放進 `pathParams`。路徑對得上但 method 不對時回 **405**，跟真的伺服器一樣，而不是含糊地回 404。

> **這裡有個很容易寫錯的地方。** 405 的判斷不能在「找到第一個路徑相符的路由」時就下結論：
>
> ```javascript
> // 錯的寫法：同一個路徑有多個 method 時，後面的永遠找不到
> if (route.method !== method) return { methodMismatch: true };
> ```
>
> `/users/:id` 同時有 `PATCH` 與 `DELETE`，而 `PATCH` 寫在前面——照上面那樣寫，`DELETE /users/x` 會先撞到 `PATCH` 那筆、直接回 405，刪除功能整條是壞的。正確做法是**走完整張表**，只有確定沒有相符的 method 才是 405：
>
> ```javascript
> let pathMatched = false;
> for (const route of compiledRoutes) {
>   if (!route.regexp.test(path)) continue;
>   pathMatched = true;
>   if (route.method !== method) continue;   // 繼續往下找
>   return { route, pathParams: … };
> }
> return { methodMismatch: pathMatched };    // 路徑有、method 沒有＝405；都沒有＝404
> ```

### 一支 API 只有一個 IPC 通道

常見的做法是每支 API 開一個通道（`users:list`、`users:update`、`orders:list`…），但那樣 preload 的白名單會跟著後端一起長，加一支 API 要改三個檔案。這裡改成 **一個通道 + 路由字串**：

```javascript
// preload.js 全部就這樣
contextBridge.exposeInMainWorld("adminApi", {
  request({ method, path, params, body, token }) {
    return ipcRenderer.invoke("api:request", { method, path, params, body, token });
  }
});
```

代價是這個通道變成通用入口，所以 [api.ipc.js](./electron/mock/api.ipc.js) 要把進來的東西全部當成不可信：

```javascript
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PATH_PATTERN = /^\/[A-Za-z0-9\-_./]*$/;

if (!ALLOWED_METHODS.has(method) || !PATH_PATTERN.test(path) || path.includes("..")) {
  return { ok: false, status: 400, code: "BAD_REQUEST", … };
}
```

query 也只收字串／數字／布林（`sanitizeParams()`），避免有人塞進巨大的物件。真正決定「這個路徑存不存在、能不能呼叫」的仍然是路由表——**renderer 傳什麼都不會變成檔案讀寫**。

### 不 throw，回信封

```javascript
{ ok: false, status: 403, code: "FORBIDDEN", message: "權限不足，無法執行這個操作", data: null }
```

在 `ipcMain.handle` 裡 throw 的話，錯誤穿過 IPC 會被包成 `Error invoking remote method 'api:request': Error: FORBIDDEN`，訊息變髒、自訂欄位（`status`、`code`）也會整個掉光。所以 main 端一律回信封，**要不要 throw 是前端的策略**，寫在 [src/api/client.js](./src/api/client.js)：

```javascript
const response = await window.adminApi.request({ method, path, params, body, token: authToken });
if (response.ok) return response.data;
throw new ApiError(response);        // status / code 都還在
```

### 延遲、隨機失敗、斷線

三個參數放在 `mockConfig`，可以在「系統設定 → 模擬後端」那一頁即時調整：

```javascript
const mockConfig = {
  minLatencyMs: 180,
  maxLatencyMs: 520,
  failureRate: 0,     // 0~1，每次請求隨機噴 500 的機率
  offline: false,      // true = 所有請求回 status 0
  sessionTtlMinutes: 30
};
```

順序很重要：**斷線與延遲都發生在路由比對之前**，因為真實世界的網路問題不會等伺服器想好要回什麼。

```javascript
const exempt = isControlPath(path);

if (mockConfig.offline && !exempt) {
  await sleep(randomBetween(200, 600));
  return envelope({ status: 0, code: "NETWORK_OFFLINE" });   // status 0 = 連不到，跟 fetch 一樣沒有狀態碼
}

await sleep(randomBetween(mockConfig.minLatencyMs, mockConfig.maxLatencyMs));

if (mockConfig.failureRate > 0 && !exempt && Math.random() < mockConfig.failureRate) {
  return envelope({ status: 500, code: "SERVER_BUSY" });
}
```

### 控制面板不能參與模擬

那個 `isControlPath()` 是被逼出來的：

```javascript
function isControlPath(path) {
  return path === "/auth/login" || path.startsWith("/system/");
}
```

- **`/auth/login` 要放行**，不然把失敗率調高之後連登入頁都過不了。
- **`/system/*` 要放行**，不然「模擬斷線」與「失敗率 100%」會變成**單向門**：連那支負責把它關掉的 `PUT /system/mock-config` 都會失敗，只能重啟 App 才救得回來。

也就是說，開了「模擬斷線」之後，訂單頁會顯示「連不到伺服器」，但**「模擬後端」那一頁仍然能用**，把開關關掉就恢復。延遲不在豁免範圍內——慢一點不會把自己鎖死，而且那一頁本來就該一起變慢，這樣才看得出「按下套用之後要等多久」。

有了這三個開關，「載入中該長什麼樣」、「失敗要不要能重試」、「斷線時畫面會不會壞掉」就不用等真的出事才發現。把延遲拉到 2000ms 逛一圈，很多平常看不到的問題會立刻現形。

### 終端機就是 Network 分頁

每次呼叫都會印一行，含狀態碼與實際耗時：

```text
[api] POST /auth/login → 200 (321ms)
[api] GET /announcements → 200 (298ms)
[api] GET /dashboard/summary → 200 (487ms)
[api] DELETE /users/u-012 → 403 (214ms)
```

> 開發模式下這些 log 常常是**成對**出現的。那是 React `StrictMode` 刻意把每個 effect 跑兩次（掛載 → 卸載 → 再掛載）來抓「沒寫清理函式」的問題，不是 bug；打包後只會跑一次。

---

## 3. 前端怎麼呼叫 API

### 介面長得像 axios

```javascript
await api.get("/users", { page: 2, keyword: "陳", role: "admin" });
await api.patch(`/users/${id}`, { status: "disabled" });
await api.del(`/users/${id}`);
```

底下走的是 IPC 而不是 HTTP，但頁面元件不需要知道。**將來真的要接後端，只有 `client.js` 裡的 `transport()` 要改成 `fetch`**，其他地方一行都不用動——這是把傳輸層獨立出來的整個目的。

### token 為什麼不放 localStorage

```javascript
let authToken = "";                       // 模組變數，只活在記憶體
export function setAuthToken(token) { authToken = token ?? ""; }
```

後台的登入憑證放進 `localStorage` 之後，只要頁面上有任何一處 XSS 就能整個讀走，而且重開 App 會自動登入（對後台反而是缺點）。代價是**重新載入頁面就要重新登入**（開發時存檔觸發 HMR reload 也會），所以另外把「上次用的帳號」記起來，密碼還是要重打：

```javascript
localStorage.setItem("admin.lastAccount", account);   // 只記帳號
```

### 401 只寫一次

每支 API 都寫一遍「如果是登入逾期就導回登入頁」很快就會漏掉一支。這裡在 client 統一攔：

```javascript
// client.js
if (error.isUnauthorized && path !== "/auth/login") {
  unauthorizedHandler?.(error);       // 由 AuthProvider 註冊
}
```

```javascript
// AuthContext.jsx
setUnauthorizedHandler((error) => {
  clearSession(error.message);        // user 變成 null
  toast.error(error.message);
});
```

`user` 一變 null，`RequireAuth` 就會 render `<Navigate to="/login">`，人自然被送回登入頁，登入頁還會顯示「登入已逾期，請重新登入」。**沒有任何頁面需要處理 401。**

`path !== "/auth/login"` 那個條件不能省：登入本身失敗也是 401，少了它，打錯密碼會觸發「登入逾期」的流程。

想看這條路徑：到「系統設定 → 連線測試」按**「讓登入立刻逾期」**。

### useApi 處理的兩件事

```javascript
const { data, error, loading, reload } = useApi(
  () => api.get("/users", { page, pageSize, keyword: debouncedKeyword, role, status }),
  [page, pageSize, debouncedKeyword, role, status]
);
```

1. **競態**：連續打字時 `keyword` 會變好幾次，先送出的請求不一定先回來。用一個遞增的 `requestId` 當「只有最後一次算數」的門檻——不然使用者會看到上一個關鍵字的結果。effect 的清理函式順便讓「元件已經卸載才回來」的回應作廢。

   ```javascript
   const id = requestId.current + 1;
   requestId.current = id;

   fetcherRef.current()
     .then((data) => { if (requestId.current === id) setState({ data, error: null, loading: false }); })
     .catch((error) => { if (requestId.current === id) setState({ data: null, error, loading: false }); });

   return () => { if (requestId.current === id) requestId.current += 1; };
   ```

2. **`fetcher` 不能進 deps**：它每次 render 都是新的匿名函式，放進 deps 會無限迴圈。用 `ref` 拿最新的那一個，真正決定何時重跑的是呼叫端給的 deps。

另外，重新載入時**刻意保留舊的 `data`**（只把 `loading` 打開），所以換頁或改篩選條件時表格不會先變空白再冒出來——`.table-wrap.is-refreshing` 只是把整塊調淡。

### 分頁的兩個坑

```javascript
// 換篩選條件要回第一頁。停在第 5 頁然後搜尋一個只有 3 筆結果的關鍵字，
// 畫面會是空的——使用者只會覺得「搜不到」。
useEffect(() => { setPage(1); }, [debouncedKeyword, role, status, pageSize]);

// 刪到某一頁一筆都不剩時，伺服器會把頁碼往回夾（server.js 的 paginate），
// 這裡要同步過去，否則下次請求又會送出那個不存在的頁碼。
useEffect(() => { if (serverPage && serverPage !== page) setPage(serverPage); }, [serverPage, page]);
```

---

## 4. 登入與權限

### 權限前後端都要有

```javascript
// 前端（AuthContext.jsx）：決定「要不要給使用者看到這顆按鈕」
// export 出來是給「使用者管理 ／ 角色與權限」那一頁直接畫成對照表用的——
// 那一頁若自己抄一份，改了權限之後它就會開始說謊
export const PERMISSIONS = {
  admin: ["users.write", "users.delete", "system.write"],
  editor: ["users.write", "system.write"],
  viewer: []
};
```

```javascript
// 後端（server.js）：決定「這個請求能不能執行」
{ method: "DELETE", path: "/users/:id", roles: ["admin"], handler }
```

前端那一份是 UX（不要給人按了一定失敗的按鈕），後端那一份才是安全性。**只擋前端等於沒擋**——renderer 只要改一行就能繞過。用 `viewer` 登入，使用者管理的按鈕會是 disabled；真的想試的話從「系統設定 → 連線測試」直接打 API，會拿到 403。

整張表在「使用者管理 → 角色與權限」那一頁看得到（三個角色 × 三個權限，附各角色的帳號數）。

### 登入頁不用 useEffect 導頁

```javascript
if (isAuthenticated) {
  return <Navigate to={location.state?.from ?? "/dashboard"} replace />;
}
```

用 `useEffect` + `navigate()` 會先閃一下登入畫面才跳走。`location.state.from` 是 `RequireAuth` 存下來的「原本想去的頁面」，所以 session 逾期被踢出去、重新登入之後會回到同一頁。

### 其他跟真後端一樣的行為

- **連續失敗 5 次鎖 20 秒**，回 **429** 並附上 `retryAfterSeconds`。
- **不能刪除自己的帳號**，回 **409**（業務規則錯誤，不是權限問題）。
- **錯誤只回代碼**，訊息在 `CODE_MESSAGES` 對照表裡集中管理，資料層不決定 UI 文字。
- **回應永遠不含 `password`**（`publicProfile()` 把它剝掉）。

---

## 5. 跑馬燈

無縫循環的做法是**把同一份清單印兩次，然後把整條軌道平移 -50%**：

```jsx
<div className="marquee__track" style={{ animationDuration: `${duration}s` }}>
  {[0, 1].map((copy) => (
    <div className="marquee__group" key={copy} aria-hidden={copy === 1 ? "true" : undefined}>
      {items.map((item) => <span className="marquee__item" key={item.id}>…</span>)}
    </div>
  ))}
</div>
```

```css
.marquee__track { display: flex; width: max-content; animation: marquee-scroll linear infinite; }
.marquee__group { display: flex; gap: 42px; padding-right: 42px; }

@keyframes marquee-scroll {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
```

動畫跑完那一刻，第二份剛好移到第一份原本的位置，看不出接縫。只印一份的話，跑到尾端會出現一段空白再跳回開頭。

五個細節：

- **`-50%` 成立的前提是兩份完全一樣寬**，所以間距用 `gap` + `padding-right` 讓每一組自己帶右邊距，而不是只在中間加空隙。
- **第二份掛 `aria-hidden`**，讀螢幕的人不會聽到兩次。
- **速度跟著文字長度算**（約每秒 11 個字，最少 24 秒），不然公告一多就變成飛快閃過。
- **`.marquee` 要 `min-width: 0`**。flex 項目預設 `min-width: auto`，內容超長時不會縮，跑馬燈會把導航欄的左右兩邊擠出畫面。
- **兩端用 `mask-image` 淡出**，文字不會像被切斷一樣硬生生消失。

`prefers-reduced-motion` 下要特別處理：跑馬燈是持續移動的元素，對前庭功能敏感的人最不友善。但**不能只是把動畫關掉**，那樣後面的公告永遠看不到：

```css
@media (prefers-reduced-motion: reduce) {
  .marquee__track { animation: none !important; width: auto; }
  .marquee__viewport { overflow-x: auto; mask-image: none; }
  .marquee__group + .marquee__group { display: none; }   /* 停下來之後第二份只會讓人以為公告重複 */
}
```

公告本身也是打 API 拿的（`GET /announcements`），載不到就安靜地顯示「目前沒有系統公告」——導航欄上的裝飾性資訊不該跳錯誤視窗。

### 跑馬燈把整個版面撐爆的那個 bug

跑馬燈的軌道是 `width: max-content`（三千多 px），這件事會從意想不到的地方外洩。外框的骨架長這樣：

```css
.app-shell { display: grid; grid-template-columns: var(--sidebar-w) 1fr; }
.app-body  { display: grid; grid-template-rows: var(--navbar-h) 1fr; min-width: 0; }
```

看起來沒問題，實際上整個版面會變成 4257px 寬、底下多一條橫向捲軸。兩個原因**都要修**：

1. **`1fr` 不等於「剩下的空間」。** 它是 `minmax(auto, 1fr)`，那個 `auto` 讓欄至少跟內容的 min-content 一樣寬。要真的「剩下多少就多少」必須寫 `minmax(0, 1fr)`。
2. **只寫 `grid-template-rows` 的 grid 仍然有欄。** 那個隱含欄的大小是 `auto`，會撐到內容的 **max-content**——也就是跑馬燈軌道那三千多 px。必須明確給 `grid-template-columns: minmax(0, 1fr)`。

```css
.app-shell { grid-template-columns: var(--sidebar-w) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.app-body  { grid-template-columns: minmax(0, 1fr); }
```

`min-width: 0` 救不了第 2 點：它管的是「這個 grid／flex 項目能不能被壓縮」，而這裡的問題是**欄本身被算得太寬**，項目乖乖填滿一個過寬的欄而已。

`.app-shell` 那個 `grid-template-rows` 是**同一個坑的縱向版本**：只寫了欄，那個隱含的「列」也是 `auto`，會被儀表板的卡片撐到 1000 多 px。`.app-shell` 自己有 `height`，所以視窗高度沒變，但內容比它高——捲軸就跑到最外層去了，連上面那條標題列都會被捲出畫面（見第 9 節）。列也明寫 `minmax(0, 1fr)` 之後，`.app-content` 才會拿到確定的高度，捲軸留在該捲的地方。

這個坑不只影響跑馬燈——寬表格（訂單頁八欄）也會從同一個地方外洩。修好之後表格改成在 `.table-wrap` 裡面自己橫向捲動，版面不動。

---

## 6. 使用者下拉選單

三個容易漏的地方：

```javascript
useEffect(() => {
  if (!open) return undefined;      // 關著的時候不留任何監聽器

  // 用 pointerdown 而不是 click：click 要等按鍵放開才觸發，
  // 拖曳選字之類的操作會讓選單延遲關閉，感覺很鈍
  const handlePointerDown = (event) => {
    if (!rootRef.current?.contains(event.target)) setOpen(false);
  };
  const handleKeyDown = (event) => { if (event.key === "Escape") setOpen(false); };

  document.addEventListener("pointerdown", handlePointerDown);
  document.addEventListener("keydown", handleKeyDown);
  return () => { /* 兩個都要移除 */ };
}, [open]);
```

`aria-expanded` / `aria-haspopup` / `aria-controls` 也要掛上，否則輔助技術只會看到一顆普通按鈕。頭像沒有圖檔，用姓名的第一個字——中文名字這樣做比英文縮寫好認。

---

## 7. 側邊欄的兩層選單

選單、麵包屑、路由三件事只有一份定義（[navigation.js](./src/navigation.js)）。有 `children` 的那一項是**群組**：

```javascript
export const NAV_ITEMS = [
  { to: "/dashboard", label: "儀表板", description: "營運概況與最近動態", icon: IconDashboard },
  {
    // 群組要有自己的 key：React 的 key、aria-controls 的 id、以及「哪些群組是
    // 展開的」那個 Set 都用它（中文的 label 不適合當 DOM id）
    key: "users",
    label: "使用者管理",
    icon: IconUsers,
    children: [
      { to: "/users", label: "使用者列表", description: "帳號、角色與啟用狀態" },
      { to: "/users/roles", label: "角色與權限", description: "三個角色各自能做什麼" }
    ]
  },
  { to: "/orders", label: "訂單管理", description: "訂單查詢與狀態追蹤", icon: IconOrders },
  {
    key: "settings",
    label: "系統設定",
    icon: IconSettings,
    children: [
      { to: "/settings", label: "介面外觀", description: "主題偏好，存在這台電腦" },
      { to: "/settings/mock", label: "模擬後端", description: "延遲、失敗率與斷線" },
      { to: "/settings/probe", label: "連線測試", description: "手動打 API，看前端怎麼反應" }
    ]
  }
];
```

**群組沒有 `to`——它不是一個頁面。** 給了 `to` 就得回答「點父層跟點第一個子項有什麼不同」，多數後台的答案是「沒有不同」，那就別給，少一個沒人按得懂的目標。所以群組的標題是 `<button>` 而不是 `<a>`。

### 反查目前在哪一頁：不能用第一個 startsWith

原本的 `findPage` 是「第一個 `pathname.startsWith(item.to)` 就算」。多了子頁之後這條規則會壞掉——`/settings` 是 `/settings/mock` 的前綴，三個設定子頁的標題會全部變成「介面外觀」：

```javascript
export function findPage(pathname) {
  // 先找完全相同的
  const exact = PAGES.find((page) => page.to === pathname);
  if (exact) return exact;

  // 再退回「最長的前綴」。前綴這條規則還是要留：以後多一個 /users/42 這種
  // 細節頁時，它仍然應該算在「使用者列表」底下
  const prefixed = PAGES.filter((page) => pathname.startsWith(`${page.to}/`)).sort(
    (a, b) => b.to.length - a.to.length
  );
  return prefixed[0] ?? PAGES[0];
}

/** 麵包屑：子頁回 [群組, 頁面]，頂層頁面回 [頁面] */
export function findTrail(pathname) {
  const page = findPage(pathname);
  return page.parent ? [page.parent, page] : [page];
}
```

`PAGES` 是把樹攤平、只留「真的對應一個路由」的節點，並把上一層記在 `parent` 上。群組不進這份清單——它沒有 `to`，反查頁面標題時不該被找到。導航欄拿 `findTrail` 畫「系統設定 ／ 模擬後端」，側邊欄拿 `findPage(pathname).parent?.key` 決定要自動展開哪一個群組。

同一個前綴問題也會咬到 `NavLink`：**子項一定要加 `end`**，否則在「角色與權限」頁時，`/users` 與 `/users/roles` 兩個子項會同時亮起來。

### 展開狀態放哪裡

```jsx
const activeGroupKey = findPage(pathname).parent?.key ?? null;

// 用 Set 而不是「一次只能開一個」的手風琴：後台的人常常在兩個群組之間來回，
// 每次都被自動收起來很煩
const [openKeys, setOpenKeys] = useState(() => new Set(activeGroupKey ? [activeGroupKey] : []));

// 換頁時把「目前這一頁所在的群組」打開——直接輸入網址、或從別的地方跳進子頁時，
// 選單不能還是收著的。這裡只加不減，使用者手動展開的那些會留著。
useEffect(() => {
  if (!activeGroupKey) return;
  setOpenKeys((prev) => (prev.has(activeGroupKey) ? prev : new Set(prev).add(activeGroupKey)));
}, [activeGroupKey]);
```

展開狀態是純 UI 狀態，所以留在 `Sidebar` 自己身上，不進 Context 也不寫 localStorage。它不需要跨元件共用（沒有第二個地方要知道選單開著沒），也不值得記住——「上次把某一組收起來」對下一次開 App 沒有意義，反而會讓人以為選單少了幾項。

### 三個容易漏的細節

- **收起來的子選單不能只是「看不見」。** 高度收成 0 之後那些連結還在 tab 順序裡，鍵盤操作會跳進一個看不到的地方。這裡用 `inert`（React 19 支援布林值），收起來時整塊不吃鍵盤也不吃滑鼠。
- **過場動畫用 `grid-template-rows: 0fr → 1fr`。** `height: auto` 不能過場；`max-height` 要猜一個夠大的值，猜小了子項被切掉、猜大了動畫有一段空轉。0fr → 1fr 是唯一不必事先知道實際高度的寫法——但要記得內層加 `overflow: hidden`，因為 0fr 只是把格線壓平，內容本身還是原本那麼高。
- **側邊欄收起來時（68px）沒有地方畫子選單**，`.sidebar` 又是 `overflow: hidden`，硬塞會被切掉。所以收起狀態下點群組是「先把整條側邊欄展開」，而不是切換展開狀態：

```jsx
function toggleGroup(key) {
  if (collapsed) {
    onExpand();                                   // AppLayout 的 setCollapsed(false)
    setOpenKeys((prev) => new Set(prev).add(key));
    return;
  }
  setOpenKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}
```

只剩圖示的時候，「人在哪一區」就只能靠父層的圖示變色（`.is-active-group`）——這也是為什麼群組的 active 狀態要跟子項分開算。

另外 `.sidebar__nav` 要加 `min-height: 0; overflow-y: auto`：子選單全開時可能比視窗高，不加的話會把底下的版號擠出畫面（跟第 5 節那個隱含 grid 軌道是同一類問題）。

---

## 8. 主題

兩套主題只差 [global.css](./src/styles/global.css) 最上面那兩組變數，元件一律讀變數：

| | 深色 | 淺色 |
|--|------|------|
| 底色 / 卡片 | `#0d1117` / `#161b22` | `#f4f6fa` / `#ffffff` |
| 主要文字 | `#e6edf3` | `#16202c` |
| 強調色 | `#3987e5` | `#2a78d6` |

要注意「同一個語意色在兩套主題不能用同一個值」。例如警告色 `#fab219` 在深色底上對比 9.5:1，在白底上只有 1.79:1，當文字根本看不清楚——所以淺色主題的 `--warn` 換成深一階的 `#8a5a00`。深淺色不是把顏色反過來就好，每個值都要對著自己的底色重新挑。

主題存在 renderer 的 `localStorage`，而不是像 notepad-app 那樣寫到 main 的 `userData`：它純粹是 UI 偏好，讀不到就退回預設值，沒必要為它多開一條 IPC。取捨是開窗那一刻 main 讀不到 `localStorage`，`BrowserWindow` 的 `backgroundColor` 與 `titleBarOverlay` 只能寫死深色那一組，淺色主題下開場那一瞬間會偏暗。

主題也不是全部都在 CSS 變數裡就結束了——視窗最上面那一條，以及 Windows 的原生控制鈕，得多做一點事，見下一節。

**讀取要在第一次繪製之前**，所以那段程式碼放在模組層，而不是 `useEffect` 裡：

```javascript
const initialTheme = readStoredTheme();
document.documentElement.dataset.theme = initialTheme;   // React render 之前就跑完
```

`color-scheme: dark` 也別忘了寫——沒寫的話深色底上會出現亮白色的原生捲軸與表單元件。

---

## 9. 最上面那一條：自己畫的標題列

原生標題列的底色是作業系統給的，App 改不動。深色的後台上面頂一條淺色的系統標題列，最上面那一段就會跟整個介面脫節——那不是 CSS 沒寫好，而是**那塊根本不屬於頁面**。

解法是把原生標題列藏起來，那一條改由頁面自己畫：

```javascript
// electron/main.js
const IS_MAC = process.platform === "darwin";

// 這個值 CSS 那邊也要有一份（global.css 的 --titlebar-h）：
// 控制鈕的位置是 main 決定的，版面留白是 renderer 決定的
const TITLEBAR_HEIGHT = 32;

// 跟 global.css 兩套主題的 --surface / --text 同一組值
const TITLEBAR_THEMES = {
  dark: { color: "#161b22", symbolColor: "#e6edf3" },
  light: { color: "#ffffff", symbolColor: "#16202c" }
};

mainWindow = new BrowserWindow({
  width: 1360,
  height: 860,
  backgroundColor: "#0d1117",
  show: false,
  titleBarStyle: IS_MAC ? "hiddenInset" : "hidden",
  titleBarOverlay: { height: TITLEBAR_HEIGHT, ...TITLEBAR_THEMES.dark },
  webPreferences: { /* preload、contextIsolation… */ }
});
```

| | macOS | Windows / Linux |
|--|-------|-----------------|
| `titleBarStyle` | `hiddenInset`：紅綠燈留著，只是往內縮一點 | `hidden`：整條標題列消失 |
| 系統控制鈕 | 紅綠燈疊在頁面左上角 | `titleBarOverlay` 把三顆鈕疊在頁面右上角 |
| `color` / `symbolColor` | 無效，紅綠燈的顏色是系統的 | 有效，而且只有 main 改得動 |

兩個平台都給 `titleBarOverlay`：有它，CSS 才拿得到 `env(titlebar-area-*)`。

頁面這邊多一層外框，第一列就是那條標題列：

```jsx
// src/App.jsx（標題列放在路由外面：登入頁與後台都要有它）
<div className="app-frame">
  <Titlebar />
  <HashRouter>{/* …路由表… */}</HashRouter>
</div>
```

```css
:root { --titlebar-h: 32px; }   /* 要跟 main.js 的 TITLEBAR_HEIGHT 一樣 */

.app-frame {
  display: grid;
  grid-template-rows: var(--titlebar-h) minmax(0, 1fr);
  height: 100vh;
}

.titlebar {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 紅綠燈佔掉的寬度，拿不到就退回 78px */
  padding: 0 env(titlebar-area-x, 78px);
  background: var(--surface);        /* 跟側邊欄、導航欄同一個變數，這才是「同色調」的重點 */
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}
.titlebar button { -webkit-app-region: no-drag; }

.app-shell { height: 100%; }        /* 原本是 100vh */
.login     { min-height: 100%; overflow-y: auto; }
```

三件容易漏的事：

- **視窗會變得不能拖。** 原生標題列不見了，就沒有地方可以按住移動視窗，所以 `.titlebar` 一定要 `-webkit-app-region: drag`。反過來，標題列裡的按鈕要個別 `no-drag`，不然按下去只會拖到視窗。
- **控制鈕會壓在內容上面。** 要留的寬度不用寫死：有 `titleBarOverlay` 的時候 CSS 拿得到 `env(titlebar-area-x)`（macOS + `hiddenInset` 實測是 `78px`，可用寬度 `env(titlebar-area-width)` 是 `1282px`）；Windows 上這個值是 0、控制鈕在右邊。`78px` 那個退路只在拿不到值時生效。
- **底下的高度要重算。** `.app-shell` 原本是 `height: 100vh`，上面多了 32px 之後就會多出一條捲軸——改成 `height: 100%`（`.app-frame` 分給第二列的高度）。同理，別讓隱含的 grid 列把內容撐高，見第 5 節末段。

主題切換時，頁面自己畫的那一條跟著 `var(--surface)` 換色就好；但 Windows 那三顆原生控制鈕只有 main 改得動，所以 renderer 要通知一聲：

```javascript
// electron/preload.js
contextBridge.exposeInMainWorld("appWindow", {
  setTitleBarTheme(theme) {
    ipcRenderer.send("titlebar:theme", theme);   // 通知而已，不需要回覆，所以用 send 不用 invoke
  }
});
```

```javascript
// electron/main.js
ipcMain.on("titlebar:theme", (event, theme) => {
  const overlay = TITLEBAR_THEMES[theme];
  const win = BrowserWindow.fromWebContents(event.sender);
  // macOS 的紅綠燈顏色改不動；setTitleBarOverlay 也只有 Windows 有
  if (!overlay || !win || IS_MAC || typeof win.setTitleBarOverlay !== "function") return;
  win.setTitleBarOverlay({ height: TITLEBAR_HEIGHT, ...overlay });
});
```

```javascript
// src/context/ThemeContext.jsx
useEffect(() => {
  document.documentElement.dataset.theme = theme;
  window.appWindow?.setTitleBarTheme(theme);   // 在瀏覽器裡跑（沒有 preload）時是 undefined
  localStorage.setItem(STORAGE_KEY, theme);
}, [theme]);
```

要不要自己畫標題列是個取捨：換來的是「整個視窗都是自己的畫布」，付出的是拖曳、控制鈕留白、雙擊放大這些**原本免費的行為都得自己顧**。只想讓開場不閃白，`backgroundColor` 就夠了；要的是「連最上面那一條都同色調」，才值得走這一步。

---

## 10. 圖表：一組數列就只用一個顏色

儀表板上的長條圖只有一組數列（每日營收），所以**每一根都是同一個藍色**。常見的錯誤是做成「愈高愈深」的漸層，那會把「長度」重複編碼成「顏色」——白白浪費一個可以拿來表達其他資訊的通道，而且深淺不一的一排藍色其實比同色更難比較。

另外三個決定：

- **只標最高的那一根**。每根都標數字會變成一片雜訊，其他值交給 hover 與表格。
- **長條是 `<button>`**，所以 hover 與鍵盤 Tab 顯示的是同一個提示。圖表不該只有滑鼠使用者讀得到。
- **提供「表格」檢視**。圖表不該是取得數字的唯一途徑，切過去就是同一份資料的無障礙版本（也方便複製貼上）。

KPI 卡的漲跌用**顏色 + 箭頭 + 百分比**三重表示。紅綠在色盲模擬下距離非常近（用 OKLab 量出來只有 4 左右，一般要求 8 以上），只靠顏色等於沒講——箭頭與數字才是真正傳達訊息的部分。

「訂單狀態分布」同理：六列都是同一個藍色，狀態名稱與數字直接寫在旁邊，顏色不負責傳達身分。表格裡的狀態標籤才用語意色（成功／警告／危險），因為那裡的顏色是輔助，文字仍然是主體。

---

## 11. 安全設定一覽

| 設定 | 位置 | 作用 |
|------|------|------|
| `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` | `main.js` | renderer 拿不到 Node.js API |
| `contextBridge` 只開放 2 個方法 + 3 個唯讀字串 | `preload.js` | 不把 `ipcRenderer` 或 `process` 整包丟給頁面 |
| `titlebar:theme` 只認得 `dark` / `light` | `main.js` | 對照表查不到就直接 return，不把 renderer 傳的值當顏色用 |
| method 白名單 + path 正則 + query 只收純量 | `api.ipc.js` | 通用 IPC 入口的輸入一律當成不可信 |
| 路由的 `roles` 檢查 | `server.js` | 權限判斷在後端，前端那份只是 UX |
| 排序欄位用白名單對照，不直接索引物件 | `server.js` | `params.sort` 是外部輸入，不能拿去當 key |
| 回應不含 `password` | `server.js` | `publicProfile()` 剝掉敏感欄位 |
| token 只存記憶體 | `client.js` | 不放 `localStorage`，XSS 也讀不走 |
| `will-navigate` 白名單 | `main.js` | 只允許 dev server 與本機檔案，其餘丟給系統瀏覽器 |
| `setWindowOpenHandler` → `shell.openExternal` | `main.js` | 外部連結不在 App 內開視窗 |
| 打包版 CSP `connect-src 'none'` | `vite.config.mjs` | 這個 App 完全不發網路請求 |
| `handler` 例外包成 500 | `server.js` | mock 自己有 bug 也不會讓 IPC 通道爆掉 |

`will-navigate` 那一條特別容易漏。少了它，只要頁面上有一個 `<a href="https://…">` 被點到，整個 App 就變成一個沒有網址欄的瀏覽器，而且那個外部頁面**跟 preload 共用同一個 window**。

---

## 12. 打包

```bash
npm run pack    # vite build + electron-builder --dir → release/mac-arm64/後台管理.app
npm run dist    # vite build + electron-builder       → release/後台管理-1.0.0-arm64.dmg
```

`files` 只收執行時真的用到的東西——`src/`（原始碼）與 `scripts/` 都不進 asar：

```jsonc
"files": ["electron/**/*", "dist-renderer/**/*", "package.json"]
```

兩個容易忘的點：

- **打包前一定要先 `vite build`**，所以 `pack` / `dist` 兩個指令都把它串在前面了。忘了的話 `dist-renderer/` 是舊的，或者根本不存在，打出來的 App 一開就白畫面。
- **`identity: null` 是「不簽章」**。自己在本機跑沒問題，發給別人會被 Gatekeeper 擋。要散佈得申請 Apple Developer ID 憑證再加 notarize，見第八章。

> `npm install` 時 `node-abi` 會警告需要 Node 22.12+。那是 `electron-builder` 的相依套件，只在**打包**時才會用到；`npm run dev` 與 `npm run build` 在 Node 20.19 上完全正常。真的要打包再切到 Node 22 以上。

---

## 13. 對應課程章節

| 本專案的部分 | 對應章節 |
|--------------|----------|
| `main.js` 開窗、`show: false` + `ready-to-show` | [02](../../02-first-app-quick-start.md)、[05](../../05-window-menu-tray.md) |
| `titleBarStyle` / `titleBarOverlay`、`-webkit-app-region` | [05 視窗、選單與系統列](../../05-window-menu-tray.md) |
| 三進程分工、dev server 與 `loadFile` 兩種載入 | [03 主程序、渲染程序與預載腳本](../../03-main-renderer-preload.md) |
| `preload.js` + `api:request` 通道、信封式回應 | [04 IPC 通訊與安全橋接](../../04-ipc-communication.md) |
| CSP、沙箱、`will-navigate`、`setWindowOpenHandler` | [09 安全最佳實踐](../../09-security-auto-update.md) |
| `package.json` 的 `build` 欄位、`npm run dist` | [08 打包與發佈](../../08-packaging-distribution.md) |

> 課程本身沒有 React 章節——這個專案的 React 部分（Context、自訂 hook、react-router）是把「前端框架怎麼放進 Electron 的 renderer」補上，重點在**接縫**：建置流程、`base: "./"`、HashRouter、CSP，而不是 React 本身。

---

## 14. 延伸練習

1. **把 mock 換成真的 HTTP**：只改 `client.js` 的 `transport()` 成 `fetch`，其他不動——驗證這層抽象真的有用。
2. **資料落地**：現在關掉 App 資料就回到原始狀態。把 `db.js` 改成讀寫 `userData` 底下的 JSON（做法見 notepad-app 的 `notes.store.js`）。
3. **新增使用者**：目前只有改與刪。加一個 `POST /users` 與新增表單，含欄位驗證（422 的錯誤要對應到欄位上）。
4. **表頭排序**：後端的 `/users` 已經支援 `sort` 與 `order`，把表頭做成可點擊即可。
5. **記住登入狀態**：改成把 token 存進 main process 的加密儲存（`safeStorage`，第六章），重開 App 不用重新登入——順便想清楚這個決定的安全代價。
6. **自動更新 token**：加一支 `POST /auth/refresh`，在 401 時先試著換新 token、成功就自動重送原本那個請求，失敗才登出。
7. **視窗選單與快捷鍵**：用 main 的 `Menu` 加上 `⌘1`~`⌘4` 切換側邊欄的四個區塊（群組跳到它的第一個子項）、`⌘R` 重新載入目前列表（第五、七章）。
8. **收起時的飛出子選單**：側邊欄收成 68px 時，目前是「點群組先展開整條」。改成滑鼠移上去在右邊飛出一塊子選單——注意 `.sidebar` 是 `overflow: hidden`，要嘛改用 portal，要嘛把裁切改到別的層。
9. **多語言**：介面字串現在寫死在元件裡，抽成字典（做法見 notepad-app 的 `i18n.js`）。
10. **匯出 CSV**：訂單頁加「匯出目前篩選結果」，用 `dialog.showSaveDialog()` 讓使用者選存檔位置（第七章）。
11. **打包後的自動更新**：照第九章加上 `electron-updater`。
