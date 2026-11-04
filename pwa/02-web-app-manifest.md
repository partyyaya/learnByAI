# 第二章：Web App Manifest 完整設定

## 2.1 Manifest 的角色

`manifest.webmanifest` 是 PWA 的「App 身分證」，用來描述：

- App 的身分（`id`）
- App 名稱與短名稱
- 啟動網址與 scope
- 顯示模式（是否隱藏瀏覽器 UI）
- 圖示與主題色

沒有正確的 Manifest，通常就算有 Service Worker，也很難達到可安裝體驗。

## 2.2 基本範例

在 `public/manifest.webmanifest` 建立：

```json
{
  "id": "/",
  "name": "PWA Demo Shop",
  "short_name": "DemoShop",
  "description": "一個可離線瀏覽與安裝的示範商店",
  "lang": "zh-Hant",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#0f172a",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512-maskable.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

在 `index.html` 引用：

```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0f172a" />
```

## 2.3 欄位選擇重點

### `display: "standalone"`

- **用途**：決定安裝後開啟時的視覺模式。`standalone` 會隱藏一般瀏覽器網址列與分頁列，體驗接近原生 App。
- **常見值差異**：
  - `browser`：一般網頁模式（幾乎不算 App 體驗）
  - `standalone`：最常用，建議預設
  - `fullscreen`：全螢幕，適合遊戲或沉浸式內容
  - `minimal-ui`：保留少量瀏覽器 UI（支援度較不一致）
- **建議**：大部分商務/內容型產品使用 `standalone` 最穩定；若使用 `fullscreen`，要自行處理返回與導覽 UX。

### `scope`

- **用途**：限制「哪些路徑算 App 內頁」。導覽到 `scope` 以外的網址時，瀏覽器會在 App 視窗上方顯示網址列（Android 多半改用 Custom Tab 開啟），提醒使用者已經離開 App。
- **規則重點**：
  - 沒寫 `scope` 時，預設是 `start_url` 所在的目錄。
  - `start_url` 必須落在 `scope` 內，否則瀏覽器會忽略你寫的 `scope`，改用預設值。
  - 部署在子路徑時要一致，例如網站在 `/shop/`，就設定 `scope: "/shop/"`。
  - 保留尾端斜線：`scope` 是用字串前綴比對，寫成 `/shop` 連 `/shopping` 也會算進去。
- **常見錯誤**：`scope` 設太小（例如 `/shop/app/`），使用者點一般功能頁時突然冒出網址列，看起來像跳回瀏覽器。

### `start_url`

- **用途**：使用者從主畫面點開 App 時，第一個進入的網址。
- **設定建議**：
  - 根路徑部署：`start_url: "/"`。
  - 子路徑部署：`start_url: "/shop/"`（必須與實際部署路徑一致）。
  - 可加追蹤參數（例如 `/?source=pwa`），但 SW 快取的 key 是 `/`：導覽請求比對快取時要加 `ignoreSearch: true`，或把這個網址也預快取，否則離線時開不起來。
- **常見錯誤**：部署在子路徑但仍寫 `/`，結果安裝後直接打到錯誤入口或 404。

### `id`

- **用途**：App 的唯一身分，瀏覽器用它判斷「這是不是同一個已安裝的 App」。
- **沒寫的後果**：瀏覽器拿 `start_url` 當身分，之後只要改了 `start_url`（例如加上追蹤參數），就會被當成另一個 App，已安裝的使用者收不到 manifest 更新。
- **設定建議**：第一次上線就設好，之後不要再改，例如 `"id": "/"`（以 `start_url` 的網域為基準解析）。

### `icons`

- **用途**：決定 App 圖示、啟動畫面、系統任務切換縮圖等視覺資產。
- **最低建議**：
  - `192x192` 與 `512x512`：Chrome 的安裝條件要求兩種都要有
  - `purpose: "maskable"`：Android 會把圖示裁成圓形、圓角方形等形狀；沒有 maskable 圖示時，系統會把一般圖示縮小放進白色底板
- **格式建議**：
  - 使用 PNG，`sizes` 要和實際尺寸一致
  - maskable 圖示另外做一張，不要直接沿用一般圖示：背景不透明，重要內容放在中央直徑 80% 的圓內（等於四周至少留 10%，方形 Logo 要留得更多）
  - 可用 [maskable.app](https://maskable.app/) 預覽各種裁切形狀
- **常見錯誤**：尺寸標錯（`sizes` 與實際檔案不一致）或路徑 404，會直接影響可安裝性判定。

### 其他常用欄位

| 欄位 | 用途 |
|------|------|
| `lang` | 名稱與描述的語言，例如 `"zh-Hant"` |
| `screenshots` | 安裝對話框裡的截圖；有截圖和 `description` 時，Android 與桌面版 Chrome 會改用較完整的安裝畫面 |
| `shortcuts` | 長按 App 圖示（桌面版為右鍵）出現的快捷選單 |
| `display_override` | 依序嘗試的顯示模式，都不支援時才用 `display`，例如 `["window-controls-overlay", "standalone"]` |
| `orientation` | 鎖定方向，例如 `"portrait"` |

```json
{
  "screenshots": [
    { "src": "/screenshots/home-wide.png", "sizes": "1280x720", "type": "image/png", "form_factor": "wide" },
    { "src": "/screenshots/home-narrow.png", "sizes": "720x1280", "type": "image/png", "form_factor": "narrow" }
  ],
  "shortcuts": [
    { "name": "我的訂單", "url": "/orders", "icons": [{ "src": "/icons/orders-96.png", "sizes": "96x96" }] }
  ]
}
```

`form_factor: "wide"` 的截圖給桌面版，`"narrow"` 給手機。

## 2.4 實際運行情境與解決方法

### 情境一：安裝選項一直出不來

**原因**：Manifest 缺必要欄位、圖示不符合條件，或使用者互動還不夠。  
**解法**：對照 Chrome 的安裝條件逐項檢查：

- 有 `name` 或 `short_name`，以及 `start_url`
- `display` 是 `standalone`、`fullscreen`、`minimal-ui` 或 `window-controls-overlay`
- `icons` 同時有 `192x192` 與 `512x512`
- 沒有把 `prefer_related_applications` 設成 `true`
- 使用者在頁面上至少點過一次、累計停留超過 30 秒（影響 `beforeinstallprompt`，見第七章）
- 到 `Application -> Manifest` 的 Installability 區塊確認沒有錯誤訊息

### 情境二：安裝後圖示被切掉，或縮成白底上的小圖

**原因**：

- 沒有 `maskable` 圖示：Android 把一般圖示縮小放進白色底板
- `maskable` 圖示內容太靠邊：系統依形狀裁切時切到重要內容

**解法**：

- 另外提供一張 `purpose: "maskable"` 圖示，背景不透明
- 重要內容放在中央直徑 80% 的圓內，用 maskable.app 檢查各種形狀

### 情境三：安裝後打開是錯頁或 404

**原因**：`start_url` 與部署路徑不一致。  
**解法**：

- 部署在子路徑如 `/shop/` 時，設定 `start_url: "/shop/"` 與 `scope: "/shop/"`
- 搭配伺服器 `try_files`，確保 SPA deep link 不會 404

### 情境四：Manifest 改了但裝置不更新

**常見現象**：

- 你已經改了 `name`、`short_name`、`icons`，但手機桌面圖示和名稱都還是舊的
- Chrome DevTools 看到新 manifest 內容，但已安裝 App 仍顯示舊資訊
- 不同使用者更新速度不一致，有些人立刻更新、有些人好幾天都沒變

**原因拆解**：

- **HTTP 快取**：`manifest.webmanifest` 被瀏覽器/CDN 長時間快取，裝置拿不到最新版
- **更新有節流**：已安裝的 App 不會每次開啟都重抓 manifest。Chrome 在 App 啟動時檢查，距離上次檢查超過 24 小時（或瀏覽器重開過）才會重新比對
- **套用有時機**：桌面版等所有 App 視窗關閉後才套用；Android 要等 App 關閉、裝置充電且連上 Wi-Fi 才更新，通常一兩天內生效
- **身分對不上**：沒設 `id` 又改了 `start_url`，瀏覽器會當成另一個 App，舊的那個不會再更新

**排查步驟**：

1. 在 DevTools `Application -> Manifest` 確認目前實際讀到的欄位值是不是新版本
2. 用 `Network` 面板查看 `manifest.webmanifest` 回應標頭（`Cache-Control`、`ETag`）
3. 檢查 CDN 是否有額外快取規則（例如 edge cache 1 天）
4. 桌面版 Chrome 開 `chrome://web-app-internals`，查看已安裝 App 記錄的 manifest 內容
5. 想立刻觸發檢查，可用 `--disable-manifest-update-throttle` 參數啟動 Chrome

**解法**：

- 對 `manifest.webmanifest` 使用短快取，例如 `max-age=300`，避免長時間卡舊版本
- 不要改 manifest 的檔名或網址（包括加上 `?v=` 版本參數），否則瀏覽器可能無法更新已安裝的 App
- 第一次上線就設好 `id`
- 若有 CDN，發版後同步 purge manifest 路徑
- 驗證流程建議：更新 manifest -> 重新載入頁面 -> 關閉所有 App 視窗再開啟 -> 檢查名稱/圖示是否生效

**伺服器設定示例（Nginx）**：

```nginx
location = /manifest.webmanifest {
  add_header Cache-Control "public, max-age=300";
}
```

### 情境五：主題色在不同頁面不一致

**常見現象**：

- 首頁瀏覽器工具列是深色，但進到內頁變成淺色
- Android 安裝後啟動畫面顏色與瀏覽中的工具列顏色不同
- 切換深色模式後，部分頁面仍停留舊顏色

**原因拆解**：

- **兩種來源不同**：
  - `manifest.theme_color` 常用於安裝流程、啟動畫面與部分系統 UI
  - `<meta name="theme-color">` 影響目前頁面瀏覽器工具列顏色
- **多頁/多模板不一致**：不同頁面的 HTML 模板設定了不同 `theme-color`
- **SPA 路由切換未更新**：單頁應用切頁不會重新載入 HTML，若沒動態更新 meta，顏色會殘留

**排查步驟**：

1. 檢查 manifest 的 `theme_color` 與 `index.html` 的 `meta theme-color` 是否一致
2. 在每個主要路由切換後檢查 `<meta name="theme-color">` 實際值
3. 測試亮色/暗色模式切換，確認是否有同步更新

**解法**：

- 先建立「單一色彩來源」，確保設計系統有統一主題色
- manifest 的 `theme_color` 只能有一個值；頁面的 meta 則可以依深淺色模式各寫一個，瀏覽器會自動挑選，系統切換深色模式時也會跟著換：

```html
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)" />
```

- 若 App 有自己的主題切換（不跟系統走），在切換時用 JS 改寫：

```ts
function setThemeColor(color: string) {
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute("content", color);
  });
}
```

**補充建議**：

- 若是 SSR/多頁網站，確保每個模板都引用同一組主題設定
- 針對 Android 實機檢查「啟動畫面」與「瀏覽器工具列」是否都符合預期

## 2.5 本章小結

- Manifest 決定 PWA 是否「像一個 App」
- `start_url`、`scope`、`icons` 是最常踩雷的三個欄位，`id` 要在第一次上線就設好
- 實機測試必做：Android、Desktop、iOS Safari 行為不同

---

> 上一章：[PWA 基礎觀念與開發環境](./01-introduction.md) | 下一章：[Service Worker 生命週期與攔截流程](./03-service-worker-basics.md)
