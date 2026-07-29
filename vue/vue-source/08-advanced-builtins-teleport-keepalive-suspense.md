# 第 08 章：進階內建機制（Teleport / KeepAlive / Suspense）

## 8.1 本章目標

這章聚焦三個常用但容易誤解的內建機制：

1. `Teleport`：視覺位置與邏輯層級分離
2. `KeepAlive`：組件實例快取與狀態保留
3. `Suspense`：非同步依賴的協調與 fallback 控制

你要達到的層次是：  
不只會用，還能解釋它們在 runtime 中如何被 patch 與調度。

---

## 8.2 Teleport：節點「傳送」到其他容器

### 8.2.1 核心價值

常見於 modal、tooltip、dropdown：  
邏輯上屬於當前組件，但需要渲染到 `body` 或特定根容器，避免層級/overflow 問題。

### 8.2.2 概念模型

- VNode 仍在原組件樹中
- 真實 DOM 可被插入到目標容器
- 更新時需要同時考慮來源位置與目標位置

### 8.2.3 重要行為

- `to` 目標改變時可能觸發搬移
- `disabled` 為 true 時退回原位置渲染
- 子內容更新仍走正常 patch 流程
- **`defer`（3.5 新增）**：目標容器如果是「在同一輪渲染中、比 Teleport 更晚才被渲染出來」的元素，預設會找不到目標而報 warning。加上 `defer` 後，Teleport 會**延到當前 render 週期結束後**再解析 `to` 目標並傳送，解決「目標尚未存在」的時序問題。

```vue
<Teleport defer to="#late-container">
  <div>我會等 #late-container 這一輪渲染出來後才傳送過去</div>
</Teleport>
<!-- 同一個模板稍後才出現的目標容器 -->
<div id="late-container"></div>
```

---

## 8.3 KeepAlive：不是不卸載，而是改成快取管理

### 8.3.1 它解決的問題

在動態組件切換中，若每次都卸載重建：

- 狀態丟失
- 重建成本高
- 體驗不連續

`KeepAlive` 透過快取保留 instance 與 subtree。

### 8.3.2 核心資料結構（概念）

- `cache: Map<Key, CachedVNode>`
- `keys: Set<Key>`（維持插入順序，便於淘汰）
- `max` + LRU 策略（超過容量淘汰最舊）

### 8.3.3 activate / deactivate

KeepAlive 場景不是普通 mount/unmount，而是：

- `deactivate`：把 DOM 移到隱藏容器，保留實例
- `activate`：從隱藏容器移回展示容器，恢復作用

---

## 8.4 KeepAlive 的 include / exclude

可依組件名稱控制是否快取：

- `include`：白名單
- `exclude`：黑名單

注意：

- 名稱匹配依 component name（或推導名稱）  
- 若名稱無法識別，可能出現看似「設定了但沒生效」

---

## 8.5 Suspense：協調非同步分支

### 8.5.1 目標

當子樹有 async setup 或 async component 時，  
在「資料未就緒」期間顯示 fallback，待依賴完成再切換到內容分支。

### 8.5.2 概念流程

```text
mount pending branch
  -> 收集 async deps
  -> 若未完成顯示 fallback
  -> deps 全部 resolve 後切換到 content branch
```

### 8.5.3 你要關注的點

- pending / resolved 狀態切換
- branch 的 patch 與切換時機
- 與 parent suspense 的依賴傳遞關係

### 8.5.4 props 與事件

| 名稱 | 作用 |
|------|------|
| `timeout` | 從 pending 切到顯示 fallback 前的等待毫秒數；設 `0` 表示立即顯示 fallback |
| `suspensible` | 讓「巢狀的 Suspense」把自己的 async 依賴**上交給外層 Suspense** 協調，而不是自己各管各的（父層才顯示一個統一的 fallback） |
| `@pending` | 進入 pending 狀態時觸發 |
| `@resolve` | content branch 的所有 async 依賴 resolve、切換完成時觸發 |
| `@fallback` | 切換到顯示 fallback 時觸發 |

> ⚠️ **Suspense 至今仍是實驗性 API**（experimental）。它的 props/行為在未來版本仍可能調整，正式專案使用前要留意版本相容性。

---

## 8.6 三者共同點：都改寫了「一般 patch 行為」

這三個內建能力都不是純語法糖：

- `Teleport` 改變 DOM 實際插入位置
- `KeepAlive` 改變 unmount 語義（改為 cache/activate）
- `Suspense` 改變 async 場景下的渲染時序

所以它們都在 renderer 裡有獨立分支，不是普通 element/component 可完全覆蓋的。

---

## 8.7 實務案例對照

### 案例 A：Modal

- 建議 `Teleport` 到 `body`
- 若 modal 內有昂貴子組件，考慮配合 `KeepAlive`

### 案例 B：多頁籤表單

- 用 `KeepAlive` 保留每頁籤輸入狀態
- 設定合理 `max` 避免無上限快取

### 案例 C：首屏異步區塊

- 用 `Suspense` 提供 fallback skeleton
- 完成後切換內容，減少白屏感

---

## 8.8 追源碼建議路徑

建議分三條線各自追一次：

1. Teleport
   - 節點掛載
   - 目標容器解析
   - move/disabled 分支
2. KeepAlive
   - cache 命中/未命中
   - activate/deactivate
   - prune（淘汰）
3. Suspense
   - pending branch 建立
   - async deps 計數
   - resolve 後切換

---

## 8.9 常見誤區

### 誤區一：以為 Teleport 會改變事件冒泡邏輯

在框架層級上它仍屬於原本組件樹語義，  
但 DOM 位置改變會影響你對實際事件路徑的直覺，需特別驗證。

### 誤區二：KeepAlive = 永不釋放

錯。`max`、include/exclude 變更或手動策略都可能觸發淘汰。

### 誤區三：Suspense 一定改善性能

Suspense 改善的是體驗節奏與異步協調，不等於直接降低計算成本。

---

## 8.10 本章作業

### 必做

- 做一個 Teleport modal（含 `disabled` 切換）
- 做一個 KeepAlive tab（含 `max` 與 include/exclude）
- 做一個 Suspense async setup demo（有 fallback 與 resolve 後切換）

### 加分

- 繪製三者在 renderer 中的分支時序圖
- 比較 KeepAlive 開啟/關閉時的互動延遲差異

### 驗收標準

- 能清楚說明 Teleport/KeepAlive/Suspense 各自改寫了哪段通用流程
- 能舉出一個適用場景與一個不適用場景
- 能指出至少一個實作風險（快取爆量、目標節點不存在、fallback 切換抖動等）

---

## 8.11 下一章預告

下一章進入工程整合：  
`.vue` 檔如何經過 `compiler-sfc` 與 Vite plugin pipeline，最終進入瀏覽器執行與 HMR。
