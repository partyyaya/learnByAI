# 15 — 瀏覽器原生 API：Observer、排程、儲存與頁面互動

> 很多需求不必裝套件：元素進入畫面、容器尺寸改變、使用者偏好深色模式、跨分頁同步設定，瀏覽器都有原生 API。每個 API 都要回答同一組問題：什麼情境該用、callback 何時執行、不用時怎麼清理。

[第 13 章](13-dom-and-events.md)處理 DOM 與事件，[第 14 章](14-fetch-and-network-requests.md)處理網路請求。這一章整理其他常用的瀏覽器 API，從「什麼情境該用」開始，說明機制、範例與資源清理。以原生 JavaScript 為主，最後示範在 Vue、React 的生命週期裡怎麼建立與清理。

HTML 範例存成 `.html`，透過本機伺服器開啟（[0.4 節](00-course-map-and-runtime.md#04-範例怎麼執行)）；其他範例放在 `<script type="module">` 或前端專案中。各節範例獨立執行，不要把所有同名變數合併成一份 script。

| 你要解決的問題 | 優先考慮 | 章節 |
|---|---|---|
| DOM 子節點、屬性或文字被改了 | `MutationObserver` | 15.2 |
| 元素進入視窗、接近捲動容器邊界 | `IntersectionObserver` | 15.3 |
| 元素本身尺寸改變 | `ResizeObserver` | 15.4 |
| 收集效能時間紀錄 | `PerformanceObserver` | 15.5 |
| 配合畫面更新、延後低優先工作 | `requestAnimationFrame`／`requestIdleCallback` | 15.6 |
| 監聽螢幕條件、分頁隱藏狀態 | `matchMedia`／Page Visibility | 15.7 |
| 保存少量設定、通知其他分頁 | Web Storage／`BroadcastChannel` | 15.8 |
| 預覽使用者選的檔案 | `File` + Object URL | 15.9 |
| 複製文字 | Clipboard API | 15.10 |
| 取消請求、避免舊搜尋覆蓋新結果 | `fetch` + `AbortController` | [14.6](14-fetch-and-network-requests.md#146-避免競態只讓最新的結果寫回) |
| 解析或建立查詢參數 | `URL`／`URLSearchParams` | [14.3](14-fetch-and-network-requests.md#143-組網址url-與-urlsearchparams) |

**SSR 注意事項**：Next.js、Nuxt 這類框架會在伺服器上執行元件程式碼，那裡沒有 `window`、`document`。不要在模組載入時直接操作它們；需要 DOM 的工作放在元件掛載後執行。

功能支援程度依瀏覽器與版本而異，採用前檢查功能是否存在，並查看 MDN 的相容性表。

## 15.1 共通觀念：訂閱、通知、清理

Observer 讓瀏覽器替你追蹤特定變化，再一次送來一批紀錄。callback 仍在主執行緒執行，裡面放大量同步運算一樣會卡住畫面。

| API | 觀察什麼 | 不等於什麼 |
|---|---|---|
| `MutationObserver` | DOM 樹與屬性的變更紀錄 | Vue／React state 監聽、元素大小監聽 |
| `IntersectionObserver` | 元素與指定範圍的交集變化 | 使用者一定看見、每次捲動的精確座標 |
| `ResizeObserver` | 元素盒模型尺寸變化 | 元素位置、DOM 結構變化 |
| `PerformanceObserver` | 指定類型的效能紀錄 | 自動找出所有效能問題 |

生命週期通常是：

```text
建立 observer → observe(target) → 接收通知 → 不再需要時停止
```

`IntersectionObserver`、`ResizeObserver` 可以用 `unobserve(target)` 停止單一目標，或用 `disconnect()` 停止全部目標。`MutationObserver` 沒有 `unobserve()`；`PerformanceObserver.observe()` 傳的是觀測設定，而不是 DOM 元素。

事件監聽也需要清理。可以保存同一個 callback 交給 `removeEventListener`，或用 signal 一次解除多個監聽（[13.5 節](13-dom-and-events.md#135-事件監聽)）：

```js
function listenForScroll(onScroll) {
  const controller = new AbortController();
  window.addEventListener("scroll", onScroll, {
    passive: true,
    signal: controller.signal,
  });
  return () => controller.abort();
}
```

`passive: true` 表示 callback 不會呼叫 `preventDefault()`，不代表自動節流；在 passive listener 裡呼叫 `preventDefault()` 也無法阻止預設行為。signal 不會自動停止 Observer，Observer 仍要呼叫各自的清理方法。

本章的 helper 都回傳一個「停止」函式。呼叫端只要記得在不需要時呼叫它，不必知道底層用的是哪一種清理方法；15.11 節會把這個慣例接到框架的生命週期上。

## 15.2 MutationObserver：監看 DOM 被誰改了

### 適用情境與原理

適合觀察第三方編輯器、舊系統外掛、外部 script 插入的節點，或無法從資料來源取得通知的 DOM 變更。瀏覽器把符合設定的變更收集成 `MutationRecord`，在 microtask 時一次通知（[10.4 節](10-event-loop.md#104-microtaskpromise-的-callback-插隊)），不是每改一次 DOM 就同步呼叫 callback。

| 設定 | 用途 |
|---|---|
| `childList` | 觀察直接子節點新增／移除 |
| `attributes` | 觀察 attribute 改變，例如 `class`、`data-status` |
| `characterData` | 觀察文字節點內容改變 |
| `subtree` | 將觀察範圍擴展到後代節點 |
| `attributeFilter` | 只監看列出的 attribute |
| `attributeOldValue`／`characterDataOldValue` | 保留對應變更前的值 |

選項必須形成有效的觀察組合，至少要啟用 `childList`、`attributes`、`characterData` 其中之一。詳細設定見 [MutationObserver.observe](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)。

### 範例：觀察外掛區塊

```html
<!doctype html>
<meta charset="utf-8" />
<title>MutationObserver 實驗</title>
<section id="widget" data-status="idle"><p>外掛內容</p></section>
<button id="change">模擬外掛更新</button>
<button id="stop">停止觀察</button>
<pre id="output"></pre>

<script type="module">
  const widget = document.querySelector("#widget");
  const output = document.querySelector("#output");
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      output.textContent += `${record.type}: ${record.attributeName ?? "子節點"}\n`;
    }
  });

  observer.observe(widget, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-status"],
    attributeOldValue: true,
  });

  document.querySelector("#change").addEventListener("click", () => {
    widget.dataset.status = "ready";
    const item = document.createElement("p");
    item.textContent = "新增內容";
    widget.append(item);
    console.log("同步程式先結束，稍後才收到觀察紀錄");
  });
  document.querySelector("#stop").addEventListener("click", () => {
    observer.disconnect();
  });
</script>
```

輸出區放在 `widget` 外面，避免記錄日誌時又改到被觀察的區域。同一次通知可能包含多筆紀錄；`record.target` 是節點的參考，讀它的 attribute 得到的是**讀取當下**的值，不是每一筆紀錄各自的新值快照。

### 容易踩到的問題

- 不要預設觀察整個 `document.body` 的所有屬性；縮小 root 並設定 `attributeFilter`，能減少無關的通知。
- 在 callback 裡修改自己觀察的 DOM，可能反覆觸發通知；修改要有條件、能停止。
- `element.textContent = ...` 通常會替換子節點，要觀察 `childList`；直接改文字節點的 `.data` 才對應 `characterData`。
- `input.value = "x"` 改的是 DOM property，不是 HTML attribute（[13.3 節](13-dom-and-events.md#133-讀寫內容與屬性)）；表單輸入用 `input`／`change` 事件。
- `disconnect()` 會丟棄還沒送出的紀錄。需要它們時，先用 `takeRecords()` 取出處理，再停止。
- 在 Vue、React 裡，框架自己控制的狀態應該走框架的資料流；不要靠監看 DOM 反推 state。

## 15.3 IntersectionObserver：元素何時進入觀察範圍

### 幾何交集與通知門檻

瀏覽器計算目標元素與 root 範圍的交集，在初次觀察、以及交集比例跨過設定門檻時，非同步通知。可用於進場效果、延後載入圖表，以及捲動接近底部時預先取資料。

| 選項／欄位 | 意義 |
|---|---|
| `root: null` | 以視窗為觀察範圍；也能指定包含目標的捲動容器 |
| `rootMargin` | 擴大或縮小觀察邊界；正值可以提早觸發 |
| `threshold` | 交集比例門檻，`0.5` 表示跨越 50%；也可以傳多個門檻 |
| `entry.isIntersecting` | 是否與觀察範圍相交 |
| `entry.intersectionRatio` | 交集面積占目標面積的比例 |

初次 callback 不保證目標已經進入畫面。即使設了 `threshold: 0.5`，也要在 callback 裡檢查需要的比例，因為初次通知或交集狀態變化時仍可能送來其他比例。它只反映幾何交集，不能證明元素沒被其他內容蓋住、或使用者真的在看它。

### 範例：接近視窗時只初始化一次

```js
function observeOnceNearViewport(element, initialize) {
  if (!("IntersectionObserver" in window)) {
    initialize(element); // 不支援時降級為立即初始化
    return () => {};
  }

  let initialized = false;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (initialized || !entry.isIntersecting) continue;
        initialized = true;
        observer.unobserve(entry.target);
        initialize(entry.target);
      }
    },
    {
      root: null,
      rootMargin: "0px 0px 200px 0px", // 距離視窗底部 200px 時就觸發
      threshold: 0,
    },
  );
  observer.observe(element);
  return () => observer.disconnect();
}

// element 是已掛載的圖表容器
const stop = observeOnceNearViewport(element, (el) => {
  el.textContent = "圖表可以開始初始化了";
});
// 元件卸載時呼叫 stop()
```

這個 helper 的 `initialize` 是同步介面。要載入模組或請求資料時，還需要自行處理錯誤、取消，以及卸載後不再寫 DOM。一般圖片的延遲載入直接用 `<img loading="lazy">`，不必自己寫 Observer。

### 無限捲動不能只寫「看見底部就 fetch」

通常在列表底部放一個有尺寸的 sentinel 元素，觀察它是否接近視窗。實作時還要處理：

1. 用 `loading` 防止重複發出請求，用 `hasMore` 表示是否還有資料。
2. 請求失敗後提供重試入口，不要讓 Observer 自動無限重試。
3. 切換篩選條件與卸載時取消舊請求，避免舊資料寫回（[14.6 節](14-fetch-and-network-requests.md#146-避免競態只讓最新的結果寫回)）。
4. sentinel 一直待在範圍內時，追加資料後不一定會再次跨過門檻，也就不會再通知。保留「載入更多」按鈕，或在追加後明確檢查是否需要再補一頁。
5. 不要把 `threshold: 1` 用在比 root 還高的目標上，它可能永遠達不到完整交集。

## 15.4 ResizeObserver：容器變大或變小了

視窗大小沒變，但側欄展開、字型載入完成、父容器配置改變，都可能讓元素的尺寸改變。這是 `window` 的 `resize` 事件無法涵蓋的情況；圖表與 canvas 常需要依容器尺寸重算。

```js
function observeContentSize(element, onSize) {
  if (!("ResizeObserver" in window)) {
    throw new Error("此功能需要 ResizeObserver，請提供降級版版面或相容處理");
  }
  let previousWidth = -1;
  let previousHeight = -1;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width === previousWidth && height === previousHeight) continue;
      previousWidth = width;
      previousHeight = height;
      onSize({ width, height });
    }
  });
  observer.observe(element, { box: "content-box" });
  return () => observer.disconnect();
}
```

這個範例回報 content box，不包含 padding 與 border。`borderBoxSize` 提供 border box 的尺寸；它的 `inlineSize`、`blockSize` 是依書寫方向的邏輯尺寸，直書時不等於寬和高。選用哪種 box，要和圖表或 canvas 的尺寸定義一致。

通知在瀏覽器繪製前的渲染流程中送出。如果 callback 又把被觀察的元素加寬，下一次通知再加寬，就會形成 resize loop。上例只排除「尺寸沒變」的重複處理；如果每次都改出新的尺寸，仍然會循環。要比較目標尺寸，避免觀察到的值和寫入的值互相推動。把修改包進 rAF 只改變時機，修不好「永遠變大」的邏輯。

純粹的版面斷點優先用 CSS 的 media query 或 container query；需要 JavaScript 知道尺寸時才用 Observer。

## 15.5 PerformanceObserver：取得效能紀錄

適合監看自訂的 measure、資源載入時間，或瀏覽器支援的其他效能項目。不同瀏覽器支援的 entry type 不同，要先檢查 `supportedEntryTypes`。

```js
function observeMeasures(onMeasure) {
  if (
    !("PerformanceObserver" in window) ||
    !PerformanceObserver.supportedEntryTypes?.includes("measure")
  ) {
    return () => {};
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      onMeasure({ name: entry.name, duration: entry.duration });
    }
  });
  observer.observe({ type: "measure", buffered: true });
  return () => observer.disconnect();
}

const stop = observeMeasures(console.log);
performance.mark("sort:start");
// 執行想量測的工作
performance.mark("sort:end");
performance.measure("sort", "sort:start", "sort:end");
```

`buffered: true` 會收到這一類型仍留在緩衝區的紀錄，不代表無限制保留所有歷史。`disconnect()` 只停止通知，不會清掉效能時間軸；不需要時用 `performance.clearMarks()`、`clearMeasures()` 清除。單一次的耗時也不等於完整的使用者體驗，要搭配 DevTools 與實際互動分析（[17.4 節](17-memory-and-performance.md#174-效能先量再改)）。

## 15.6 排程：rAF、idle callback 與 microtask 怎麼選

這一節的機制在[第 10 章](10-event-loop.md)的事件迴圈裡都有各自的位置，這裡從「要用哪一個」的角度整理。

### `requestAnimationFrame`：合併一幀內的視覺寫入

```js
function createFrameWriter(write) {
  let frameId = null;
  let latestValue;
  let stopped = false;

  return {
    update(value) {
      if (stopped) return;
      latestValue = value;
      if (frameId !== null) return; // 這一幀已經排過了，只更新值
      frameId = requestAnimationFrame(() => {
        frameId = null;
        write(latestValue);
      });
    },
    stop() {
      stopped = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
    },
  };
}
```

把多次 `pointermove` 的最新座標交給 `update`，同一幀之前的多次寫入會合併成一次。rAF 不保證觸發次數比 scroll 事件少，也不會讓 callback 裡昂貴的計算變快。

動畫要用 callback 收到的時間戳記計算進度，不要假設每次間隔都是 16ms：螢幕更新率不同，背景分頁也可能暫停 rAF。rAF 在**下一次繪製之前**執行，不是「已經繪製完成」的通知（[10.5 節](10-event-loop.md#105-渲染時機與-requestanimationframe)）。

### `requestIdleCallback`：低優先、可拆小的工作

適合非必要的預先處理，不適合登入、立即回饋或必須準時完成的工作。不是每個目標瀏覽器都支援，要準備替代方案：

```js
function scheduleSmallBackgroundTask(work) {
  if ("requestIdleCallback" in window) {
    const id = window.requestIdleCallback(() => work(), { timeout: 1000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(work, 50);
  return () => clearTimeout(id);
}
```

這個 helper 只接受很短的工作。大量項目應根據 `deadline.timeRemaining()` 分段，做不完再排下一次；`timeout` 到期時可能完全沒有空閒時間，更不能一次做完全部。`setTimeout` 的替代方案只是延後執行，沒有真正的空閒判斷；`timeout` 也不是硬性的完成期限。

### 選擇對照

| 機制 | 適用工作 | 限制 |
|---|---|---|
| Promise callback／`queueMicrotask` | 同步工作結束後的短小整理 | microtask 持續加入會拖延繪製 |
| `requestAnimationFrame` | 下一幀之前的視覺更新 | callback 本身仍可能阻塞繪製 |
| `requestIdleCallback` | 可延後、可拆分的短工作 | 可能等很久，需處理相容性 |
| `setTimeout` | 延後安排一般 task | 時間是最短延遲，不保證準時 |
| Web Worker | CPU 密集運算 | 無法直接操作 DOM，需要傳遞資料 |

Observer 的 callback 並非都走同一種排程，不要假設 Mutation、Intersection、Resize 三者有固定的先後順序。計算本身太重時，排程救不了，要移到 [Web Worker](16-web-worker.md)。

## 15.7 matchMedia 與 Page Visibility：環境變了嗎

### `matchMedia`：監聽使用者偏好或斷點

```js
function watchReducedMotion(onChange) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  const handleChange = () => onChange(query.matches);
  handleChange(); // change 事件不會代替初次讀取
  query.addEventListener("change", handleChange);
  return () => query.removeEventListener("change", handleChange);
}
```

常用的條件還有 `(prefers-color-scheme: dark)`、`(min-width: 768px)`。純樣式直接寫在 CSS；需要改變 JavaScript 的動畫或圖表設定時才監聽。它只在「條件是否符合」改變時通知，不是每次視窗尺寸變化都通知。

### Page Visibility：分頁是否被隱藏

```js
function watchPageVisibility(onChange) {
  const handleChange = () => onChange(document.visibilityState === "visible");
  handleChange();
  document.addEventListener("visibilitychange", handleChange);
  return () => document.removeEventListener("visibilitychange", handleChange);
}
```

可以用來暫停輪詢或動畫，回到前景時刷新資料。輪詢請求已經發出時，要自行決定是否 abort；只停止計時器不會取消已發送的請求。

`visible` 不代表使用者正專心看著這個視窗；分頁被切走也不等於應用程式正常結束。不能依賴「關閉頁面時一定有機會完成非同步工作」，重要資料要在使用者操作當下就送出或保存。

## 15.8 保存與同步：Storage、BroadcastChannel

### localStorage 與 sessionStorage

| API | 適合的資料 | 範圍與生命週期 |
|---|---|---|
| `localStorage` | 少量使用者偏好 | 依 origin 區隔，跨分頁共用、關閉瀏覽器後保留，但可能被清除 |
| `sessionStorage` | 分頁內的暫存草稿 | 依 origin 與頂層分頁區隔，通常隨分頁關閉而結束 |
| IndexedDB | 大量結構化資料、離線快取 | 非同步資料庫，需要另外設計版本與交易 |

```js
function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem("preferences") ?? "{}");
    return { theme: value?.theme === "dark" ? "dark" : "light" };
  } catch {
    return { theme: "light" };
  }
}

function savePreferences(preferences) {
  try {
    localStorage.setItem("preferences", JSON.stringify(preferences));
    return true;
  } catch {
    return false; // 容量不足、隱私設定等原因可能讓寫入失敗
  }
}
```

`readPreferences` 不直接信任讀到的內容：JSON 可能損壞（`JSON.parse` 丟錯），欄位也可能是舊版本或被手動改過的值，所以只接受已知的值，其他一律用預設值。

Web Storage 是同步執行、只存字串，不適合頻繁寫入大型 JSON，也不是存放敏感資料（例如 token）的安全位置：頁面上任何 JavaScript 都讀得到它。`localStorage` 的 `storage` 事件會通知共用這個儲存區的**其他**頁面，發起寫入的頁面自己不會收到。`sessionStorage` 的事件不會跨到其他獨立分頁。

### BroadcastChannel：同來源分頁互傳訊息

```js
function createPreferencesChannel(onRemoteChange) {
  if (!("BroadcastChannel" in window)) return null;
  const channel = new BroadcastChannel("preferences-v1");
  channel.addEventListener("message", ({ data }) => {
    if (data?.type === "theme" && ["light", "dark"].includes(data.value)) {
      onRemoteChange(data.value);
    }
  });
  return {
    publishTheme(theme) {
      channel.postMessage({ type: "theme", value: theme });
    },
    close() {
      channel.close();
    },
  };
}
```

發送端要自己更新自己的畫面，發送訊息的 channel 物件不會收到自己的訊息。收到訊息後不要原樣再廣播一次，以免形成訊息迴圈。

訊息用結構化複製傳遞（[4.6 節](04-objects-and-arrays.md#46-複製淺拷貝與-structuredclone)），不會自動保存，也不會補送給之後才開啟的分頁；需要持久化時再搭配 Storage。通訊範圍限於同一個來源，不能用來跨網域傳訊。

## 15.9 File 與 Object URL：本機圖片預覽

Object URL 讓 `<img>` 等元素直接使用瀏覽器記憶體中的 Blob 或 File，不需要先上傳到伺服器。

```js
function attachImagePreview(input, image, onError = console.error) {
  let objectUrl = null;

  function clearPreview() {
    image.removeAttribute("src");
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  function handleChange() {
    clearPreview();
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
      onError("請選擇 5MB 以下的圖片");
      return;
    }
    objectUrl = URL.createObjectURL(file);
    image.src = objectUrl;
  }

  input.addEventListener("change", handleChange);
  return () => {
    input.removeEventListener("change", handleChange);
    clearPreview();
  };
}
```

搭配 `<input type="file" accept="image/*">` 與 `<img alt="預覽">` 使用。

每個 Object URL 都讓瀏覽器把對應的檔案留在記憶體裡，直到呼叫 `revokeObjectURL`。更換檔案或卸載時要 revoke；但不要設定 `src` 後立刻 revoke，要等這個網址不再被使用。Object URL 只在目前的頁面有效，不是可以分享的下載網址。`accept`、MIME 類型與大小檢查只是改善前端體驗，正式上傳時伺服器仍要再驗證一次。

## 15.10 Clipboard：使用者按下按鈕時複製

```js
async function copyText(text) {
  if (!window.isSecureContext || !navigator.clipboard?.writeText) {
    return { ok: false, message: "請選取文字後手動複製" };
  }
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, message: "已複製" };
  } catch {
    return { ok: false, message: "無法存取剪貼簿，請手動複製" };
  }
}

copyButton.addEventListener("click", async () => {
  const result = await copyText(codeBlock.textContent);
  status.textContent = result.message;
});
```

Clipboard API 需要安全環境（HTTPS；`localhost` 開發時也算）。權限與「使用者剛操作過」的要求依瀏覽器而異，所以要在使用者的操作（例如 click）裡直接呼叫，並處理被拒絕的情況。不要先 `await` 一個耗時的 API 再複製，等待太久會失去「使用者剛操作過」的狀態；先準備好文字，再讓使用者按按鈕。

`copyText` 回傳結果物件而不是丟出錯誤：複製失敗是預期中的情況，呼叫端只需要把訊息顯示出來（[8.8 節](08-error-handling.md#88-預期的失敗不一定要丟例外)）。

## 15.11 在 Vue 與 React 中：建立與清理要成對

以 15.4 節的 `observeContentSize` 為例，把它存成 `observeContentSize.js` 並加上 `export`。範例容器的寬度由外部版面決定，顯示尺寸的文字放在容器之外，避免自己的內容影響觀察到的尺寸。

### Vue 3

```vue
<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import { observeContentSize } from "./observeContentSize.js";

const panel = ref(null);
const width = ref(0);
let stop = () => {};

onMounted(() => {
  if (!panel.value) return;
  stop = observeContentSize(panel.value, (size) => {
    width.value = size.width;
  });
});
onBeforeUnmount(() => stop());
</script>

<template>
  <div ref="panel" style="width: 100%; height: 120px; background: #eee"></div>
  <p>容器內容寬度：{{ width }}px</p>
</template>
```

### React

```jsx
import { useEffect, useRef, useState } from "react";
import { observeContentSize } from "./observeContentSize.js";

export default function SizePanel() {
  const panel = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!panel.current) return;
    return observeContentSize(panel.current, (size) => setWidth(size.width));
  }, []);

  return (
    <>
      <div ref={panel} style={{ width: "100%", height: 120, background: "#eee" }} />
      <p>容器內容寬度：{width}px</p>
    </>
  );
}
```

因為 helper 回傳的就是停止函式，React 的 `useEffect` 可以直接把它當 cleanup 回傳。

這兩個範例的目標節點一直存在。如果條件渲染替換了節點，要停止舊的觀察、重新綁定新節點；只確認 ref 有值是不夠的。React 開發模式的 StrictMode 會刻意執行一次 setup → cleanup → setup，清理正確時就能重新建立觀察。兩個範例都只用了不會變的 setter 與 ref；callback 若另外讀取會變的 props，就要處理依賴或閉包抓到舊值的問題（[3.4 節](03-scope-closures-and-hoisting.md#34-閉包抓到的是變數不是值)）。

| 建立了什麼 | 不再使用時 |
|---|---|
| Observer | `disconnect()`，必要時對單一目標 `unobserve()` |
| 事件監聽 | `removeEventListener()` 或 abort 對應的 signal |
| fetch 請求 | `abort()`，並確保結果不再寫回 |
| rAF、idle callback、計時器 | 對應的 cancel／clear 方法 |
| Object URL | `URL.revokeObjectURL()` |
| BroadcastChannel | `close()` |
| Worker | `terminate()`（[第 16 章](16-web-worker.md)） |

## 15.12 本章小結

- DOM 結構變了用 `MutationObserver`，進入範圍用 `IntersectionObserver`，尺寸變了用 `ResizeObserver`，效能紀錄用 `PerformanceObserver`。
- Observer 的 callback 仍在主執行緒執行，裡面的重運算一樣會卡住畫面。
- 視覺更新交給 rAF 合併；可延後的小工作交給 idle callback，並準備替代方案；計算太重就移到 Worker。
- `matchMedia` 先讀一次再監聽；分頁隱藏時暫停輪詢，但不能依賴關閉頁面時還有機會做事。
- Storage 讀出的內容不要直接信任；BroadcastChannel 不會通知自己、不會保存訊息。
- 每個 helper 回傳停止函式；Observer、監聽器、請求、計時器、Object URL、channel 都要在不用時清理。
- 功能不支援或操作失敗時，要讓使用者仍然能完成工作，例如手動複製、按鈕載入更多。

即時通訊可以接著看 [WebSocket 即時通訊實戰](../common/websocket.md) 與 [SSE 伺服器推送實戰](../common/sse.md)。

下一章：[16 — Web Worker](16-web-worker.md)，把排程救不了的重運算移到另一條執行緒。

---

[上一章：fetch 與網路請求](14-fetch-and-network-requests.md) · [返回課程總覽](README.md) · [下一章：Web Worker](16-web-worker.md)
