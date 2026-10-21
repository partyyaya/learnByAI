# 瀏覽器原生 API 實戰：Observer、排程、請求與頁面互動

> 從「什麼情境該用」開始，理解常用 Web API 的機制、範例與資源清理。以原生 JavaScript 為主，最後示範 Vue／React 的生命週期整合。

## 0. 怎麼閱讀與執行範例

本篇預設你已了解 DOM、事件與 Promise。非同步觀念可先看 [Promise 與 async/await](./promise-async-await-then.md)。
HTML 範例可存成 `.html`，透過本機開發伺服器開啟；其他 JS 範例請放在 `<script type="module">` 或前端專案中。
各節範例獨立執行，不要將所有同名變數合併成一份 script。呼叫 helper 前，應先取得它需要的 DOM 元素。

| 你要解決的問題 | 優先考慮 | 本文 |
|---|---|---|
| DOM 子節點、屬性或文字被改了 | `MutationObserver` | §2 |
| 元素進入視窗、接近捲動容器邊界 | `IntersectionObserver` | §3 |
| 元素本身尺寸改變 | `ResizeObserver` | §4 |
| 收集效能時間紀錄 | `PerformanceObserver` | §5 |
| 配合畫面更新、延後低優先工作 | `requestAnimationFrame`／`requestIdleCallback` | §6 |
| 取消請求、避免舊搜尋覆蓋新結果 | `fetch` + `AbortController` | §7 |
| 監聽螢幕條件、分頁隱藏狀態 | `matchMedia`／Page Visibility | §8 |
| 解析或建立查詢參數 | `URL`／`URLSearchParams` | §9 |
| 保存少量設定、通知其他分頁 | Web Storage／`BroadcastChannel` | §10 |
| 預覽使用者選的檔案 | `File` + Object URL | §11 |
| 複製文字 | Clipboard API | §12 |

**SSR 注意事項：**不要在伺服器端或模組載入時直接操作 `window`、`document`；需要 DOM 的工作放在掛載後執行。
功能支援程度依瀏覽器與版本而異，採用前檢查功能是否存在，並查看各節的 MDN 相容性表。

## 1. 共通觀念：訂閱、通知、清理

Observer 讓瀏覽器替你追蹤特定變化，再傳送一批紀錄；callback 仍在主執行緒執行，放入大量同步運算一樣可能卡住畫面。

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

`IntersectionObserver`／`ResizeObserver` 可用 `unobserve(target)` 停止單一目標，或 `disconnect()` 停止全部目標。
`MutationObserver` 沒有 `unobserve()`；`PerformanceObserver.observe()` 則傳觀測設定，而不是 DOM 元素。

事件監聽也需要清理。可以保存同一個 callback 交給 `removeEventListener`，或用 signal 一次解除多個監聽：

```js
function listenForScroll(onScroll) {
  const controller = new AbortController()
  window.addEventListener('scroll', onScroll, {
    passive: true,
    signal: controller.signal,
  })
  return () => controller.abort()
}
```

`passive: true` 表示 callback 不會呼叫 `preventDefault()`，不代表自動節流；在 passive listener 中呼叫它也無法阻止預設行為。
signal 不會自動停止 Observer，仍要呼叫各自的清理方法。參考 [addEventListener](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener)。

## 2. MutationObserver：監看 DOM 被誰改了

### 2.1 適用情境與原理

適合觀察第三方編輯器、舊系統外掛、外部 script 插入的節點，或無法從資料來源取得通知的 DOM 變更。
瀏覽器會將符合設定的變更收集成 `MutationRecord`，在微任務檢查點通知；不是每改一次 DOM 就同步呼叫 callback。

| 設定 | 用途 |
|---|---|
| `childList` | 觀察直接子節點新增／移除 |
| `attributes` | 觀察 attribute 改變，例如 `class`、`data-status` |
| `characterData` | 觀察文字節點內容改變 |
| `subtree` | 將觀察範圍擴展到後代節點 |
| `attributeFilter` | 只監看列出的 attribute |
| `attributeOldValue`／`characterDataOldValue` | 保留對應變更前的值 |

選項必須形成有效的觀察組合，例如至少啟用 `childList`、`attributes`、`characterData` 之一。
詳細設定見 [MutationObserver.observe](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)。

### 2.2 完整範例：觀察外掛區塊

```html
<!doctype html>
<meta charset="utf-8">
<title>MutationObserver 實驗</title>
<section id="widget" data-status="idle"><p>外掛內容</p></section>
<button id="change">模擬外掛更新</button>
<button id="stop">停止觀察</button>
<pre id="output"></pre>

<script type="module">
  const widget = document.querySelector('#widget')
  const output = document.querySelector('#output')
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      output.textContent += `${record.type}: ${record.attributeName ?? '子節點'}\n`
    }
  })

  observer.observe(widget, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-status'],
    attributeOldValue: true,
  })

  document.querySelector('#change').addEventListener('click', () => {
    widget.dataset.status = 'ready'
    const item = document.createElement('p')
    item.textContent = '新增內容'
    widget.append(item)
    console.log('同步程式先結束，稍後才收到觀察紀錄')
  })
  document.querySelector('#stop').addEventListener('click', () => {
    observer.disconnect()
  })
</script>
```

輸出區放在 `widget` 外面，避免記錄日誌時又改到被觀察區域。
同一次通知可能包含多筆紀錄；`record.target` 是節點引用，讀它的 attribute 得到的是讀取當下的值，不是每一筆紀錄各自的「新值快照」。

### 2.3 容易踩到的問題

- 不要預設觀察整個 `document.body` 的所有屬性；縮小 root 與 `attributeFilter` 能減少無關通知。
- 在 callback 裡修改自己觀察的 DOM，可能形成反覆通知；應讓修改有條件且能停止。
- `element.textContent = ...` 常會替換子節點，要觀察 `childList`；直接改文字節點的 `.data` 才對應 `characterData`。
- `input.value = 'x'` 改的是 DOM property，不一定改 HTML attribute；表單輸入優先用 `input`／`change` 事件。
- `disconnect()` 會丟棄尚未送出的紀錄。若需要它們，先用 `takeRecords()` 取出並自行處理，再停止。
- 在 Vue／React 中，自己控制的狀態應使用框架資料流；不要靠監看 DOM 反推 state。

介面與清理方式見 [MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)。

## 3. IntersectionObserver：元素何時進入觀察範圍

### 3.1 幾何交集與通知門檻

瀏覽器計算目標元素與 root 範圍的交集，在初次觀察及跨過設定門檻等情況下非同步通知。
可用於進場效果、延後載入圖表，以及捲動接近底部時預先取資料。

| 選項／欄位 | 意義 |
|---|---|
| `root: null` | 以視窗為觀察根範圍；也能指定包含目標的捲動容器 |
| `rootMargin` | 擴大／縮小觀察邊界；正值可提早觸發 |
| `threshold` | 交集比例門檻，`0.5` 表示跨越 50%；也可傳多個門檻 |
| `entry.isIntersecting` | 是否與觀察範圍相交 |
| `entry.intersectionRatio` | 交集面積占目標面積的比例 |

初次 callback 不保證目標已進入畫面。即使設了 `threshold: 0.5`，也要在 callback 檢查所需比例，因為初次通知或交集狀態變化仍可能送來其他比例。
預設只反映幾何交集，不能證明元素沒被其他內容蓋住，或使用者正在看它。見 [Intersection Observer API](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API)。

### 3.2 範例：接近視窗時，只初始化一次

```js
function observeOnceNearViewport(element, initialize) {
  if (!('IntersectionObserver' in window)) {
    initialize(element) // 降級為立即初始化
    return () => {}
  }

  let initialized = false
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (initialized || !entry.isIntersecting) continue
      initialized = true
      observer.unobserve(entry.target)
      initialize(entry.target)
    }
  }, {
    root: null,
    rootMargin: '0px 0px 200px 0px',
    threshold: 0,
  })
  observer.observe(element)
  return () => observer.disconnect()
}

// element 是已掛載的圖表容器；示範初始化內容
// const stop = observeOnceNearViewport(element, el => {
//   el.textContent = '圖表可以開始初始化了'
// })
// 元件卸載時呼叫 stop()
```

這個 helper 的 `initialize` 是同步介面。若要載入模組或請求資料，還需要自行處理錯誤、取消與卸載後不再寫 DOM。
普通圖片懶載入可先用 `<img loading="lazy" ...>`，不必每次自行寫 Observer。

### 3.3 無限捲動不能只寫「看見底部就 fetch」

通常在列表底部放一個有尺寸的 sentinel 元素，觀察它是否接近視窗。實作時還要處理：

1. `loading` 防止並行重複請求，`hasMore` 表示是否還有資料。
2. 請求失敗後提供重試入口，不要讓 Observer 自動無限重試。
3. 切換篩選與卸載時取消舊請求，避免舊資料寫回。
4. sentinel 若一直在範圍內，追加資料後不一定再次跨門檻，不保證自動再通知；保留「載入更多」按鈕或明確重新檢查是否需要補頁。
5. 不要把 `threshold: 1` 套在比 root 還高的目標上，可能永遠達不到完整交集。

## 4. ResizeObserver：容器變大或變小了

視窗沒變，側欄展開、字型載入、父容器配置改變，都可能讓元素尺寸改變。
這是 `window.resize` 無法完整涵蓋的場景；圖表與 canvas 常需要依容器尺寸重算。

```js
function observeContentSize(element, onSize) {
  if (!('ResizeObserver' in window)) {
    throw new Error('此功能需要 ResizeObserver，請提供降級版版面或相容處理')
  }
  let previousWidth = -1
  let previousHeight = -1
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect
      if (width === previousWidth && height === previousHeight) continue
      previousWidth = width
      previousHeight = height
      onSize({ width, height })
    }
  })
  observer.observe(element, { box: 'content-box' })
  return () => observer.disconnect()
}
```

本例回報 content box，不包含 padding／border。`borderBoxSize` 則提供 border box；其 `inlineSize`／`blockSize` 是書寫方向的邏輯尺寸，不應永遠當作實體寬／高。
選用哪種 box，應與圖表或 canvas 的尺寸定義一致。

通知通常在瀏覽器繪製前的渲染流程中送出。若 callback 又把被觀察元素加寬，下一次通知再加寬，就可能形成 resize loop。
上例只排除「尺寸沒變」的重複處理；如果你每次都改出新尺寸，仍然會循環。應比較目標尺寸、避免觀察值與寫入值互相推動。
把修改包進 rAF 只能改變時機，不能修好永遠增大的邏輯。

純版面斷點優先考慮 CSS media／container queries；需要 JS 知道尺寸時才使用 Observer。參考 [ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)。

## 5. PerformanceObserver：取得效能紀錄

適合監看自訂 measure、資源載入或瀏覽器支援的其他效能項目。不同瀏覽器支援的 entry type 不一樣，要檢查 `supportedEntryTypes`。

```js
function observeMeasures(onMeasure) {
  if (!('PerformanceObserver' in window) ||
      !PerformanceObserver.supportedEntryTypes?.includes('measure')) {
    return () => {}
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      onMeasure({ name: entry.name, duration: entry.duration })
    }
  })
  observer.observe({ type: 'measure', buffered: true })
  return () => observer.disconnect()
}

// const stop = observeMeasures(console.log)
// performance.mark('sort:start')
// 執行你想量測的排序工作
// performance.mark('sort:end')
// performance.measure('sort', 'sort:start', 'sort:end')
// 不再需要時間軸紀錄時，使用 clearMarks／clearMeasures 清除
```

`buffered: true` 可接收該類型仍保留在緩衝區中的紀錄，不代表無限制保留所有歷史。
`disconnect()` 停止通知，不等同清掉效能時間軸。一次耗時也不等於完整使用者體驗，需搭配 DevTools 與實際互動分析。參考 [PerformanceObserver](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver)。

## 6. 排程：rAF、idle callback 與微任務怎麼選

### 6.1 `requestAnimationFrame`：合併一幀內的視覺寫入

```js
function createFrameWriter(write) {
  let frameId = null
  let latestValue
  let stopped = false

  return {
    update(value) {
      if (stopped) return
      latestValue = value
      if (frameId !== null) return
      frameId = requestAnimationFrame(() => {
        frameId = null
        write(latestValue)
      })
    },
    stop() {
      stopped = true
      if (frameId !== null) cancelAnimationFrame(frameId)
      frameId = null
    },
  }
}
```

把多次 pointermove 的最新座標交給 `update`，可以合併同一幀前的寫入。rAF 不保證比 scroll 事件頻率低，也不會讓 callback 的昂貴計算變快。
動畫應使用 callback 的 timestamp 計算進度，而非假設每次都是 16ms；螢幕更新率會不同，背景分頁也可能暫停 rAF。
它在下一次重繪前執行，並不是「已繪製完成」通知。參考 [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)。

### 6.2 `requestIdleCallback`：低優先且可拆小的工作

適合非必要的預先處理，不適合登入、立即回饋或必須準時完成的任務。不是每個目標瀏覽器都支援，因此要準備 fallback。

```js
function scheduleSmallBackgroundTask(work) {
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(() => work(), { timeout: 1000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = setTimeout(work, 50)
  return () => clearTimeout(id)
}
```

此 helper 只接受很短的工作。大量項目應根據 `deadline.timeRemaining()` 分段並再次排程；timeout 到期時可能沒有空閒預算，更不能一次執行全部。
`setTimeout` fallback 只是延後執行，沒有真正的空閒時間判斷；`timeout` 也不是硬性完成期限。參考 [requestIdleCallback](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback)。

| 機制 | 適用工作 | 限制 |
|---|---|---|
| Promise callback／`queueMicrotask` | 同步工作結束後的短小整理 | 微任務持續入列會拖延繪製 |
| `requestAnimationFrame` | 下一幀前的視覺更新 | callback 仍可能阻塞繪製 |
| `requestIdleCallback` | 可延後、可拆分的短工作 | 可能久等，需處理相容性 |
| `setTimeout` | 延後安排一般 task | 時間是排程條件，不是準時執行保證 |
| Web Worker | CPU 密集運算 | 無法直接操作 DOM，需要傳遞資料 |

Observer callback 並非都走同一種微任務排程，不要把 Mutation、Intersection、Resize 三者套成固定回呼順序。
重運算可接著讀 [Web Worker 實戰](./web-worker.md)。

## 7. fetch + AbortController：取消與避免競態

### 7.1 範例：只讓最新搜尋結果寫回

假設 `/api/search?q=...` 回傳 JSON。此 helper 可接在搜尋事件處理器上：

```js
function createLatestSearch(onData, onError = console.error) {
  let current = null
  let version = 0
  let disposed = false

  return {
    async search(keyword) {
      if (disposed) return
      const myVersion = ++version
      current?.abort()
      const controller = new AbortController()
      current = controller

      try {
        const url = new URL('/api/search', location.origin)
        url.searchParams.set('q', keyword)
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (!disposed && !controller.signal.aborted && myVersion === version) {
          onData(data)
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted && myVersion === version) {
          onError(error)
        }
      } finally {
        if (myVersion === version) current = null
      }
    },
    dispose() {
      disposed = true
      version++
      current?.abort()
      current = null
    },
  }
}
```

取消舊請求可以省資源；版本檢查則保護最後寫回的順序。如果 UI 有 loading，清掉 loading 時也應確認自己仍是最新那次請求。
每次請求建立新 controller：signal 一旦 abort，就不能重設成可用狀態。詳見 [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)。

`fetch` 收到 404／500 通常仍會完成 Promise，所以要檢查 `response.ok`。
abort 不會回滾伺服器已完成的寫入；也不會自動中斷自己的同步計算。取消與 debounce 不同，若要減少搜尋請求數，仍需另加 debounce。
跨來源請求需由伺服器正確設定 CORS，`mode: 'no-cors'` 不能讓你自由讀取 JSON。參考 [Using Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)。

## 8. matchMedia 與 Page Visibility：環境有變嗎？

### 8.1 `matchMedia`：監聽使用者偏好或斷點

```js
function watchReducedMotion(onChange) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  const handleChange = () => onChange(query.matches)
  handleChange() // change 事件不會代替初次讀取
  query.addEventListener('change', handleChange)
  return () => query.removeEventListener('change', handleChange)
}
```

常用條件還有 `prefers-color-scheme: dark`、`min-width`。純樣式直接寫 CSS；需要改變 JS 動畫或圖表設定時才監聽。
它表示條件是否符合，不是每次視窗尺寸變化都通知。參考 [matchMedia](https://developer.mozilla.org/en-US/docs/Web/API/Window/matchMedia)。

### 8.2 Page Visibility：分頁是否被隱藏

```js
function watchPageVisibility(onChange) {
  const handleChange = () => onChange(document.visibilityState === 'visible')
  handleChange()
  document.addEventListener('visibilitychange', handleChange)
  return () => document.removeEventListener('visibilitychange', handleChange)
}
```

可以用來暫停輪詢或動畫，回到前景時刷新資料。若輪詢請求已在進行，還要自行決定是否 abort；只停止 timer 不會取消已發送的請求。
`visible` 不代表視窗正被使用者專注觀看；分頁離開也不等同應用程式正常卸載，不能依賴關閉頁面時一定有機會完成非同步工作。參考 [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)。

## 9. URL 與 URLSearchParams：不要手工拼查詢字串

```js
const url = new URL('/api/courses', location.origin)
url.searchParams.set('q', 'Vue & React')
url.searchParams.set('page', String(2))
url.searchParams.append('tag', 'frontend')
url.searchParams.append('tag', 'javascript')

console.log(url.searchParams.get('q'))       // Vue & React
console.log(url.searchParams.getAll('tag'))  // ['frontend', 'javascript']
console.log(url.toString())                 // 自動完成 query 編碼
```

`set` 替換同名參數，`append` 保留多個值。解析完整網址先用 `new URL(...)`；不要把完整網址直接交給 `new URLSearchParams(...)` 當 query。
取得的參數仍是字串，頁碼等數字需要轉型與範圍檢查；不要先 `encodeURIComponent` 再交給 `set`，否則會重複編碼。參考 [URLSearchParams](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams)。

## 10. 保存與同步：Storage、BroadcastChannel

### 10.1 localStorage／sessionStorage

| API | 適合資料 | 範圍與生命週期 |
|---|---|---|
| `localStorage` | 少量使用者偏好 | 依 origin 區隔，可跨一般分頁／重新開啟保留，但可能被清除 |
| `sessionStorage` | 分頁內的暫存草稿 | 依 origin 與頂層分頁區隔，通常隨分頁工作階段結束 |
| IndexedDB | 大量結構化資料、離線快取 | 非同步資料庫，需要另外設計版本與交易 |

```js
function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem('preferences') ?? '{}')
    return { theme: value?.theme === 'dark' ? 'dark' : 'light' }
  } catch {
    return { theme: 'light' }
  }
}

function savePreferences(preferences) {
  try {
    localStorage.setItem('preferences', JSON.stringify(preferences))
    return true
  } catch {
    return false // 容量、存取政策等原因可能讓寫入失敗
  }
}
```

Web Storage 同步執行，只存字串，不適合高頻寫大型 JSON，也不是敏感資料的安全保管箱。
`localStorage` 的 `storage` 事件通知共享該儲存區的其他文件，不會在發起寫入的文件自行觸發。
`sessionStorage` 的事件範圍不會跨到其他獨立分頁。參考 [Web Storage API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API)。

### 10.2 BroadcastChannel：同來源分頁傳訊息

```js
function createPreferencesChannel(onRemoteChange) {
  if (!('BroadcastChannel' in window)) return null
  const channel = new BroadcastChannel('preferences-v1')
  channel.addEventListener('message', ({ data }) => {
    if (data?.type === 'theme' && ['light', 'dark'].includes(data.value)) {
      onRemoteChange(data.value)
    }
  })
  return {
    publishTheme(theme) {
      channel.postMessage({ type: 'theme', value: theme })
    },
    close() { channel.close() },
  }
}
```

發送端仍要更新自己的 UI；發送的 channel 物件不會收到自己的訊息。接收後不要原樣再次廣播，以免形成訊息迴圈。
訊息使用 structured clone，不會自動保存，也不會補送給稍後才開啟的分頁；需要持久化時再搭配儲存層。
通訊受同來源與儲存分區限制，不能拿來跨網域傳訊。參考 [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)。

## 11. File 與 Object URL：本機圖片預覽

Object URL 讓 `<img>` 等元素使用瀏覽器記憶體中的 Blob／File，不需要先上傳到伺服器。

```js
function attachImagePreview(input, image, onError = console.error) {
  let objectUrl = null
  function clearPreview() {
    image.removeAttribute('src')
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  function handleChange() {
    clearPreview()
    const file = input.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) {
      onError('請選擇 5MB 以下的圖片')
      return
    }
    objectUrl = URL.createObjectURL(file)
    image.src = objectUrl
  }
  input.addEventListener('change', handleChange)
  return () => {
    input.removeEventListener('change', handleChange)
    clearPreview()
  }
}
```

搭配 `<input type="file" accept="image/*">` 與 `<img alt="預覽">` 使用。
更換檔案或卸載時 revoke；不要設定 `src` 後立即 revoke，應等該 URL 不再被使用。
此 URL 不是可永久分享的下載網址。`accept`、MIME 與大小檢查只改善前端體驗，正式上傳仍需伺服器驗證。
參考 [createObjectURL](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static)。

## 12. Clipboard：使用者按下按鈕時複製

```js
async function copyText(text) {
  if (!window.isSecureContext || !navigator.clipboard?.writeText) {
    return { ok: false, message: '請選取文字後手動複製' }
  }
  try {
    await navigator.clipboard.writeText(text)
    return { ok: true, message: '已複製' }
  } catch {
    return { ok: false, message: '無法存取剪貼簿，請手動複製' }
  }
}

// 在 click handler 內直接呼叫，並將回傳 message 顯示於 UI
// const result = await copyText('要複製的內容')
```

通常需要 HTTPS 等安全環境，localhost 開發環境一般也可使用。權限與使用者啟用要求依瀏覽器而異，應直接從使用者操作呼叫並處理拒絕。
不要先等待冗長 API 才嘗試複製，以免失去使用者啟用狀態；可先準備好文字再讓使用者按按鈕。
參考 [Clipboard.writeText](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)。

## 13. Vue／React 整合：建立與清理要成對

以下沿用 §4 的 `observeContentSize`，將它存為專案的 `observeContentSize.js` 並加上 `export`。
範例容器寬度由外部版面決定，顯示尺寸的文字放在容器之外，減少自身內容影響觀察尺寸的機會。

### Vue 3

```vue
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { observeContentSize } from './observeContentSize.js'

const panel = ref(null)
const width = ref(0)
let stop = () => {}

onMounted(() => {
  if (!panel.value) return
  stop = observeContentSize(panel.value, size => { width.value = size.width })
})
onBeforeUnmount(() => stop())
</script>

<template>
  <div ref="panel" style="width: 100%; height: 120px; background: #eee"></div>
  <p>容器內容寬度：{{ width }}px</p>
</template>
```

### React

```jsx
import { useEffect, useRef, useState } from 'react'
import { observeContentSize } from './observeContentSize.js'

export default function SizePanel() {
  const panel = useRef(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!panel.current) return
    return observeContentSize(panel.current, size => setWidth(size.width))
  }, [])

  return <>
    <div ref={panel} style={{ width: '100%', height: 120, background: '#eee' }} />
    <p>容器內容寬度：{width}px</p>
  </>
}
```

這兩個範例的目標節點一直存在。若條件渲染替換了節點，要停止舊觀察並重新綁定新節點；只監看 `ref` 容器是否存在還不夠。
React 開發期 StrictMode 會檢查 Effect 的 setup／cleanup，清理正確就能重新建立觀察。
兩例都使用不變的 setter／ref；如果 callback 另外讀取會變的 props，需要處理依賴或閉包舊值。

| 建立了什麼 | 不再使用時 |
|---|---|
| Observer | `disconnect()`，必要時對單一目標 `unobserve()` |
| Event listener | `removeEventListener()` 或 abort 對應 signal |
| fetch 請求 | `abort()`，並保護結果不再寫回 |
| rAF／idle callback／timer | 對應的 cancel／clear 方法 |
| Object URL | `URL.revokeObjectURL()` |
| BroadcastChannel | `close()` |

## 14. 練習與驗收

1. **DOM 實驗：**在 §2 加入文字節點 `.data` 的修改，開關 `characterData`，比較收到的 record。
2. **延後初始化：**把多個圖表容器放在長頁面，接近視窗才初始化，離開再回來不重複初始化。
3. **容器變化：**切換側欄寬度，不改視窗大小，確認 ResizeObserver 仍能通知。
4. **搜尋競態：**讓第一次搜尋比第二次慢，確認只有第二次結果寫回；離開頁面後不再顯示結果。
5. **跨分頁設定：**兩個分頁同步主題，重新開啟時從 localStorage 還原，避免廣播互相循環。

驗收時能回答：DOM 改變、尺寸改變、交集改變分別用哪個 API？callback 是否會阻塞主執行緒？哪個資源需要清理？功能不支援或請求失敗時，使用者還能否完成操作？

相關延伸：[Web Worker](./web-worker.md)、[WebSocket](./websocket.md)、[SSE](./sse.md)。
