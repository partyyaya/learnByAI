# 第七章：可安裝性與安裝引導 UX

## 7.1 可安裝（Installability）條件

Chrome 觸發 `beforeinstallprompt` 的條件（實際以瀏覽器版本為準）：

- 網站使用 HTTPS（或 localhost）
- 尚未安裝過
- Manifest 有 `name` 或 `short_name`、`start_url`，`display` 是 `standalone`、`fullscreen`、`minimal-ui` 或 `window-controls-overlay`
- 圖示同時有 192px 與 512px
- 沒有把 `prefer_related_applications` 設成 `true`
- 使用者在頁面上至少點過一次，且累計停留超過 30 秒

Chrome 從 108 版（Android）、112 版（桌面）起，從選單安裝已不再要求 Service Worker；不過自動跳出安裝提示的判斷仍會參考是否有 `fetch` 處理器。要讓安裝後真的能離線使用，SW 還是必要的。

各瀏覽器的安裝方式：

| 平台 | 安裝方式 | `beforeinstallprompt` |
|------|----------|----------------------|
| Chrome / Edge / Samsung Internet | 網址列圖示、選單、自訂按鈕 | 有 |
| iOS / iPadOS（任何瀏覽器） | 分享選單 →「加入主畫面」 | 沒有 |
| macOS Safari | 檔案選單 →「加入 Dock」 | 沒有 |
| Firefox | 不支援這個事件 | 沒有 |

## 7.2 `beforeinstallprompt` 實作

```js
// 暫存 beforeinstallprompt 事件，等使用者點按鈕時再觸發
let deferredPrompt = null;
const installButton = document.getElementById("install-btn");

// 初始先隱藏安裝按鈕，等可安裝時再顯示
if (installButton) {
  installButton.style.display = "none";
}

// 符合可安裝條件時，瀏覽器會觸發此事件（只有 Chromium 系瀏覽器會觸發）
window.addEventListener("beforeinstallprompt", (event) => {
  // 阻止瀏覽器自動彈窗，改為由我們決定提示時機
  event.preventDefault();
  // 保存事件物件，之後才能呼叫 prompt()
  deferredPrompt = event;

  if (installButton) {
    installButton.style.display = "inline-block";
  }
});

if (installButton) {
  installButton.addEventListener("click", async () => {
    if (!deferredPrompt) return;

    // 由使用者手動觸發安裝提示
    deferredPrompt.prompt();
    // outcome 可能是 accepted 或 dismissed
    const result = await deferredPrompt.userChoice;
    console.log("install choice:", result.outcome);

    // 這個事件通常只能使用一次，使用後清空
    deferredPrompt = null;
    installButton.style.display = "none";
  });
}

// 安裝完成事件：可用來更新 UI 或送分析事件
window.addEventListener("appinstalled", () => {
  if (installButton) {
    installButton.style.display = "none";
  }
});
```

**備註解釋：**

- 這段是「頁面端」代碼，通常放在 `src/main.js`（或等效入口檔）。
- `deferredPrompt` 的用途是暫存事件，不然你無法在自訂按鈕點擊時呼叫原生安裝提示。
- `event.preventDefault()` 是關鍵，否則 Android Chrome 可能自己跳出安裝的迷你資訊列，提示時機就被瀏覽器接管。
- Safari 與 Firefox 沒有 `beforeinstallprompt`，iOS 需改用「分享 -> 加入主畫面」引導。

## 7.3 安裝 UX 設計建議

- 不要一進站就強推安裝，先在使用者完成一次核心任務後再提示
- 提示內容說明「安裝的實際好處」（更快開啟、離線可用、訊息通知）
- 提供「稍後再說」選項，避免干擾

## 7.4 iOS Safari 特別處理

iOS 沒有標準 `beforeinstallprompt`，建議：

- 偵測 iOS + 未以主畫面模式開啟（`navigator.standalone !== true`）
- 顯示教學引導：「分享按鈕 -> 加入主畫面」
- 使用圖示與一步步指示圖降低操作成本

iOS 的幾個差異：

- iOS 16.4 起，Chrome、Edge 等第三方瀏覽器的分享選單也能加入主畫面，引導不必限定 Safari
- iOS 26 起，加入主畫面的網站預設就以 Web App 開啟（使用者可在加入時關掉「以網頁 App 開啟」）
- 主畫面 App 與 Safari 的 localStorage、Cookie 是分開的：在 App 裡記下「已安裝」，Safari 裡讀不到，Safari 端的提示只能靠使用者自己關閉

## 7.5 實際運行情境與解決方法

### 情境一：永遠收不到 `beforeinstallprompt`

**原因**：尚未符合安裝條件，或該平台不支援此事件。  
**解法**：

- 先到 DevTools Manifest 檢查條件是否齊全
- 對 iOS 改用手動教學，不依賴該事件

### 情境二：使用者點了「取消」，之後再也不出現安裝提示

**原因**：瀏覽器節流安裝提示頻率。Android Chrome 的迷你資訊列被關掉後，會有一段冷卻期（目前約三個月）不再自動出現；同一個 `beforeinstallprompt` 事件也只能 `prompt()` 一次。  
**解法**：

- 改用自家 UI 按鈕引導：之後的頁面載入只要仍符合條件，還會再收到 `beforeinstallprompt`
- 不要每次訪問都馬上觸發 prompt

### 情境三：安裝後點某些頁面會冒出網址列，像跳回瀏覽器

**原因**：導覽 URL 超出 manifest `scope`，瀏覽器在 App 視窗顯示網址列（Android 多半改用 Custom Tab 開啟）。  
**解法**：

- 擴大 `scope` 或統一路由結構
- 外部連結加明確標記，避免誤解為 App 內頁

### 情境四：桌面已安裝但 UI 還顯示「安裝」按鈕

**原因**：沒有在安裝完成後更新 UI 狀態。  
**解法**：

- 監聽 `appinstalled` 事件
- 每次啟動時檢查 `display-mode: standalone`（有用 `fullscreen`、`minimal-ui` 時也要一起判斷），已安裝則隱藏按鈕

### 情境五：安裝轉換率低

**原因**：使用者不知道安裝有什麼價值。  
**解法**：

- A/B 測試不同文案（強調速度、離線、通知）
- 將安裝提示放在「完成購買 / 完成註冊」後

## 7.6 本章小結

- 可安裝性是「技術條件 + 互動時機 + 文案設計」的組合題
- iOS 需要獨立 UX 流程
- 安裝提示要服務任務完成，不該打斷流程

---

> 上一章：[版本更新流程與使用者提示](./06-update-lifecycle.md) | 下一章：[Web Push 推播通知實作](./08-push-notifications.md)
