# 第二章：Web App Manifest 完整設定

## 2.1 Manifest 的角色

`manifest.webmanifest` 是 PWA 的「App 身分證」，用來描述：

- App 名稱與短名稱
- 啟動網址與 scope
- 顯示模式（是否隱藏瀏覽器 UI）
- 圖示與主題色

沒有正確的 Manifest，通常就算有 Service Worker，也很難達到可安裝體驗。

## 2.2 基本範例

在 `public/manifest.webmanifest` 建立：

```json
{
  "name": "PWA Demo Shop",
  "short_name": "DemoShop",
  "description": "一個可離線瀏覽與安裝的示範商店",
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

- **用途**：限制「哪些路徑算 App 內頁」。超出 `scope` 的連結會回到一般瀏覽器頁籤開啟。
- **規則重點**：
  - `start_url` 需落在 `scope` 內，否則安裝後導覽行為會不一致。
  - 部署在子路徑時要一致，例如網站在 `/shop/`，就設定 `scope: "/shop/"`。
  - 建議保留尾端斜線，減少路徑比對誤判。
- **常見錯誤**：`scope` 設太小（例如 `/shop/app/`），導致使用者點一般功能頁時突然跳回瀏覽器。

### `start_url`

- **用途**：使用者從主畫面點開 App 時，第一個進入的網址。
- **設定建議**：
  - 根路徑部署：`start_url: "/"`。
  - 子路徑部署：`start_url: "/shop/"`（必須與實際部署路徑一致）。
  - 可加追蹤參數（例如 `/?source=pwa`），但要確保此 URL 能被正常渲染且可離線處理。
- **常見錯誤**：部署在子路徑但仍寫 `/`，結果安裝後直接打到錯誤入口或 404。

### `icons`

- **用途**：決定 App 圖示、啟動畫面、系統任務切換縮圖等視覺資產。
- **最低建議**：
  - `192x192`（安裝需求常用尺寸）
  - `512x512`（高解析度與商店/系統場景）
  - `purpose: "maskable"`（避免 Android 桌面圖示被裁切變形）
- **格式建議**：使用 PNG、背景不透明、主體置中並預留安全邊距（約 10% 以上）。
- **常見錯誤**：尺寸標錯（`sizes` 與實際檔案不一致）或路徑 404，會直接影響可安裝性判定。

## 2.4 實際運行情境與解決方法

### 情境一：安裝選項一直出不來

**原因**：Manifest 缺必要欄位或圖示尺寸不符合條件。  
**解法**：

- 至少提供 `name`/`short_name`、`start_url`、`display`
- 加入 `192x192` 與 `512x512` icon
- 確認 `Application -> Manifest` 沒有錯誤訊息

### 情境二：安裝後圖示被裁切變醜

**原因**：沒有 `maskable` icon，系統套用自動裁切。  
**解法**：

- 提供 `purpose: "maskable"` 圖示
- 重要內容置中，周圍保留安全邊距（建議 10% 以上）

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
- **安裝快照延遲**：系統對已安裝 App 的圖示與名稱更新不是即時套用，通常有同步延遲
- **路徑未變更**：manifest URL 固定不變，快取命中率高，導致新內容不容易被重新抓取

**排查步驟**：

1. 在 DevTools `Application -> Manifest` 確認目前實際讀到的欄位值是不是新版本
2. 用 `Network` 面板查看 `manifest.webmanifest` 回應標頭（`Cache-Control`、`ETag`）
3. 檢查 CDN 是否有額外快取規則（例如 edge cache 1 天）
4. 若是已安裝 App，移除安裝再重裝，確認是否可拿到新資訊

**解法**：

- 對 `manifest.webmanifest` 使用短快取，例如 `max-age=300`，避免長時間卡舊版本
- 發版時可加版本參數，強制讓瀏覽器抓新檔案：
  - `<link rel="manifest" href="/manifest.webmanifest?v=20260223" />`
- 若有 CDN，發版後同步 purge manifest 路徑
- 驗證流程建議：更新 manifest -> 重新載入頁面 -> 重新安裝 -> 檢查名稱/圖示是否生效

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
- 同步設定 manifest 與 HTML meta：
  - `manifest.theme_color = "#0f172a"`
  - `<meta name="theme-color" content="#0f172a">`
- 若有深色模式，路由切換或主題切換時動態更新 meta：

```ts
const metaTheme = document.querySelector('meta[name="theme-color"]');
if (metaTheme) {
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  metaTheme.setAttribute("content", isDark ? "#0f172a" : "#ffffff");
}
```

**補充建議**：

- 若是 SSR/多頁網站，確保每個模板都引用同一組主題設定
- 針對 Android 實機檢查「啟動畫面」與「瀏覽器工具列」是否都符合預期

## 2.5 本章小結

- Manifest 決定 PWA 是否「像一個 App」
- `start_url`、`scope`、`icons` 是最常踩雷的三個欄位
- 實機測試必做：Android、Desktop、iOS Safari 行為不同

---

> 上一章：[PWA 基礎觀念與開發環境](./01-introduction.md) | 下一章：[Service Worker 生命週期與攔截流程](./03-service-worker-basics.md)
