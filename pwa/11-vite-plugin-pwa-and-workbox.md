# 第十一章：vite-plugin-pwa 與 Workbox

## 11.1 為什麼需要建置工具？

前幾章手寫的 `sw.js` 把原理講清楚了，但專案變大後會卡在三件事：

- **不知道檔名**：打包後的檔名帶 hash（例如 `index-D24lm4Fd.js`），寫 `sw.js` 時還不知道，沒辦法在 `install` 預快取，只能等第一次載入時順手存（第一章的做法）。使用者沒完整用過一次，就沒辦法離線。
- **手動升版**：每次發版都要記得改 cache 名稱，忘了改就會拿到舊檔。
- **細節很多**：快取上限、過期清理、opaque 回應、導覽 fallback 都要自己寫。

Workbox 是 Google 維護的 Service Worker 函式庫。vite-plugin-pwa 在 `vite build` 時呼叫 Workbox，依打包結果產生**預快取清單**：每個檔案附上 revision，下次發版只重新下載內容有變的檔案，舊檔案也會自動清掉。

## 11.2 安裝與基本設定

```bash
npm install -D vite-plugin-pwa
```

`vite.config.js`：

```js
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'prompt',
      manifest: {
        id: '/',
        name: 'PWA Demo Shop',
        short_name: 'DemoShop',
        lang: 'zh-Hant',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 要放進預快取的檔案
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
      },
    }),
  ],
})
```

`npm run build` 後，`dist/` 會多出：

- `sw.js` 與 `workbox-xxxx.js`：產生的 Service Worker
- `manifest.webmanifest`：由 `manifest` 設定產生，`index.html` 也會自動加上 `<link rel="manifest">`

build log 會列出預快取了幾個檔案：

```
PWA v1.2.0
mode      generateSW
precache  15 entries (249.77 KiB)
```

> 改用外掛後，刪掉前幾章手寫的 `public/sw.js`、`public/manifest.webmanifest` 與 `index.html` 裡手寫的 manifest 連結，否則會和外掛產生的檔案衝突。

## 11.3 註冊與更新提示（`virtual:pwa-register`）

外掛提供一個虛擬模組，幫你註冊 SW 並把更新事件轉成 callback：

```js
import { registerSW } from 'virtual:pwa-register'

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // 新版已在等待：顯示「稍後 / 立即更新」
  },
  onOfflineReady() {
    // 第一次安裝完成、預快取就緒：可以提示「離線可用」
  },
  onRegisteredSW(swUrl, registration) {
    // 長時間開著的頁面，定期檢查新版
    if (!registration) return
    setInterval(() => {
      registration.update().catch(() => {})
    }, 60 * 60 * 1000)
  },
})

// 使用者按下「立即更新」
document.getElementById('update-btn')?.addEventListener('click', () => updateSW())
```

TypeScript 專案要在 `tsconfig.json` 的 `compilerOptions.types` 加上 `"vite-plugin-pwa/client"`，才認得這個虛擬模組。

對照第六章手寫的流程：

| 第六章要自己處理的事 | vite-plugin-pwa（prompt 模式） |
|------|------|
| SW 端接收 `SKIP_WAITING` | 產生的 `sw.js` 已內建 |
| 載入時新版已在等待 | 一樣會呼叫 `onNeedRefresh` |
| 首次接管時不要重新整理 | 只有更新時才重新整理 |
| 定期檢查新版 | 要自己寫在 `onRegisteredSW` 裡 |
| 其他分頁不要被強制刷新 | 不處理：顯示過更新提示的分頁都會跟著重新整理 |

`registerType: 'autoUpdate'` 則是新版裝好就直接接管並重新整理頁面，不跳提示。適合純內容網站；有表單輸入的 App 用 `prompt` 比較安全。

## 11.4 執行期快取（`runtimeCaching`）

預快取只涵蓋打包出來的檔案。API、跨網域圖片這類執行時才知道網址的請求，用 `runtimeCaching` 套第四章的策略：

```js
workbox: {
  globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
  // 導覽到這些路徑時不要回 index.html（後端處理的頁面、檔案下載）
  navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
  runtimeCaching: [
    {
      urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/'),
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api',
        networkTimeoutSeconds: 5,
        expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
      },
    },
    {
      urlPattern: ({ request }) => request.destination === 'image',
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'images',
        expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
        // 允許存跨網域 CDN 的 opaque 回應（status 為 0）
        cacheableResponse: { statuses: [0, 200] },
      },
    },
  ],
},
```

- `handler`：`CacheFirst`、`NetworkFirst`、`StaleWhileRevalidate` 對應第四章的三種策略
- `expiration`：第四章情境二提到的筆數與時間上限，Workbox 會自動清掉超過的項目
- `networkTimeoutSeconds`：和第四章一樣，有快取時才會在逾時後改回快取

## 11.5 改用 `injectManifest`：自己寫 SW

`generateSW`（預設）由外掛產生整支 SW，只能用設定調整。需要推播（第八章）、Background Sync 與 IndexedDB 佇列（第五章）時，改用 `injectManifest`：SW 由你來寫，外掛只負責把預快取清單注入進去。

```bash
npm install -D workbox-precaching workbox-routing
```

```js
// vite.config.js
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.js',
  registerType: 'prompt',
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
  },
  manifest: { /* 同 11.2 */ },
})
```

```js
// src/sw.js
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

// 建置時會被換成這次打包的檔案清單（含 revision）
precacheAndRoute(self.__WB_MANIFEST)
// 清掉舊版 Workbox 留下的預快取
cleanupOutdatedCaches()
// SPA：導覽請求一律回預快取的 index.html
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

// prompt 模式要自己處理「立即更新」
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

// 接著寫第八章的 push / notificationclick、第五章的 sync 事件
```

`src/sw.js` 會經過 Vite 打包，所以可以 `import` npm 套件。第五章 SW 端用原生 API 寫的 IndexedDB 佇列，這時可以改成和頁面共用 `src/outbox.ts` 與 `idb`。

## 11.6 開發模式

預設只有 `npm run build` 才會產生 SW。設定 `devOptions: { enabled: true }` 後，`npm run dev` 也會註冊一支開發用的 SW（產生在 `dev-dist/`，記得加進 `.gitignore`），方便檢查 manifest 與註冊流程。

開發用的 SW 和正式版不同，離線與更新流程仍以 `npm run build` + `npm run preview` 驗證為準；不需要時就關掉，避免第九章提到的 HMR 與快取互相干擾。

## 11.7 範例專案 qr-pwa-app 導讀

[qr-pwa-app](./qr-pwa-app/README.md) 是一個 Vue 3 的離線 QR 掃碼 App，用的就是 `generateSW` + `prompt` 模式。

| 檔案 | 內容 |
|------|------|
| `vite.config.js` | `VitePWA` 設定：manifest（含 `id` 與另外做的 maskable 圖示）、`registerType: 'prompt'`、預快取的副檔名 |
| `src/main.js` | `registerSW()`：把 `onNeedRefresh`、`onOfflineReady` 轉成 `pwaState` 給畫面使用，並每小時檢查新版 |
| `src/App.vue` | 更新彈窗、iOS／Android 安裝提示、`appinstalled` 處理、掃碼流程 |
| `public/icons/` | 一般圖示與 maskable 圖示 |
| `index.html` | `apple-touch-icon`、iOS 狀態列樣式與 `viewport-fit=cover` |

```bash
cd qr-pwa-app
nvm use
npm install
npm run build
npm run preview
```

開啟 `http://localhost:4173`，等畫面出現「離線模式已就緒」後，在 DevTools 切成 Offline 再重新整理，掃碼頁仍要能開啟並使用相機。相機和 SW 一樣需要安全環境，手機測試方式見範例專案的 README。

## 11.8 實際運行情境與解決方法

### 情境一：正式版 Console 出現大量 workbox 訊息

**原因**：設定了 `mode: 'development'`，正式建置也用開發版的 Workbox，檔案大很多又會印 log。  
**解法**：

- 拿掉 `mode`，預設會跟著 `NODE_ENV`
- `npm run build` 後檢查 `dist/workbox-*.js`，正式版只有十幾 KB

### 情境二：`npm run build` 失敗，訊息提到 `maximumFileSizeToCacheInBytes`

**原因**：預設只預快取 2 MiB 以內的檔案，有檔案超過時外掛會讓建置失敗。  
**解法**：

- 先確認是不是不該預快取的大檔（影片、大型 WASM），用 `workbox.globIgnores` 排除，改用執行期快取
- 確定要預快取，再調高 `workbox.maximumFileSizeToCacheInBytes`

### 情境三：新加的字型、JSON 離線時讀不到

**原因**：`globPatterns` 沒包含這些副檔名，沒有進預快取。  
**解法**：

- 補上副檔名，例如 `'**/*.{js,css,html,ico,png,svg,webmanifest,woff2,json}'`
- 用 build log 的 `precache N entries` 確認數量有增加

### 情境四：登入回呼、檔案下載等後端網址被回成 `index.html`

**原因**：`generateSW` 預設對所有導覽請求回傳預快取的 `index.html`。  
**解法**：

- 把這些路徑加進 `navigateFallbackDenylist`（11.4）

### 情境五：按下「立即更新」後，其他分頁也被重新整理

**原因**：prompt 模式下，顯示過更新提示的分頁在新 SW 接管時都會重新整理。  
**解法**：

- 有表單輸入的頁面在 `onNeedRefresh` 時先暫存草稿
- 需要第六章那種「只刷新按下更新的分頁」的行為，就不使用 `virtual:pwa-register`，並設定 `injectRegister: false`（否則外掛會自己插入註冊腳本），再用第六章的寫法自行註冊

## 11.9 本章小結

- 預快取清單交給建置工具產生，就不必手動管理 hash 檔名與 cache 名稱
- 簡單情境用 `generateSW` + `runtimeCaching`；需要推播、背景同步、IndexedDB 時改用 `injectManifest`
- `registerType: 'prompt'` 對應第六章的更新提示流程，但定期檢查新版與多分頁的行為仍要自己留意

---

> 上一章：[部署上線與實際情境排查](./10-deployment-and-real-world.md)
