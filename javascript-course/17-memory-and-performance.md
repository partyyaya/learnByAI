# 17 — 記憶體與效能除錯

> 記憶體不是你釋放的，是你「不再參考」之後由引擎回收的。效能問題不是猜出來的，是量出來的。

前面各章陸續提到：閉包會讓變數一直存活（[3.7 節](03-scope-closures-and-hoisting.md#37-閉包與記憶體)）、長任務會卡住畫面（[10.6 節](10-event-loop.md#106-長任務會卡住畫面)）、讀寫版面要批次進行（[13.10 節](13-dom-and-events.md#1310-讀寫版面的成本)）。這一章把它們整理成兩個除錯流程：記憶體一直漲時怎麼找原因，畫面卡頓或程式變慢時怎麼量測。

## 17.1 垃圾回收：可達性

JavaScript 沒有 `free` 或 `delete` 物件的方法。引擎定期從一組**根**（root）出發，沿著參考找出所有還**可達**的物件，找不到的就回收。根包括：全域物件、目前呼叫堆疊上的變數、還在等待執行的 callback（計時器、事件監聽器、Promise 的後續）。

```js
let user = { name: "Ann" };
user = null; // { name: "Ann" } 不再可達，之後會被回收
```

兩個推論：

- **循環參考不會造成洩漏**。A 參考 B、B 參考 A，只要從根找不到它們，兩個都會被回收。
- **記憶體洩漏的意思是：還有東西參考著你已經不需要的物件。** 找洩漏就是找「誰還抓著它」。

`WeakMap`、`WeakSet` 的鍵不算數（[7.3 節](07-collections-iterators-and-generators.md#73-weakmap-與-weakset)）：鍵物件只被 `WeakMap` 參考時，仍會被回收。在 Node 裡實測：

```js
// node --expose-gc leak.mjs
const strong = new Map();
for (let i = 0; i < 200_000; i++) strong.set({ id: i }, new Array(10).fill(i));
gc(); // Map 持有 20 萬筆後：約 37.5 MB

const weak = new WeakMap();
for (let i = 0; i < 200_000; i++) weak.set({ id: i }, new Array(10).fill(i));
gc(); // 鍵沒有其他參考：GC 後約 0 MB
```

## 17.2 常見的記憶體洩漏

### 沒移除的事件監聽器

```js
function mountChart(el) {
  const chart = createChart(el); // 很大的物件
  window.addEventListener("resize", () => chart.resize());
}
```

元件卸載、`el` 從頁面移除後，`window` 還參考著那個箭頭函式，箭頭函式透過閉包參考著 `chart`，`chart` 又參考著 `el`。整串都回收不了，每掛載一次就多一串。

綁在**生命比元件長**的對象（`window`、`document`、全域的事件匯流排）上的監聽器，一定要在卸載時移除。最方便的做法是用 `signal`（[13.5 節](13-dom-and-events.md#135-事件監聽)）：

```js
function mountChart(el) {
  const controller = new AbortController();
  const chart = createChart(el);
  window.addEventListener("resize", () => chart.resize(), { signal: controller.signal });
  return () => {
    controller.abort();
    chart.destroy();
  };
}
```

### 沒清除的計時器

```js
setInterval(() => updateClock(el), 1000); // 沒有保存 id，永遠停不下來
```

`setInterval` 的 callback 永遠在等待執行，是一個根；它參考的東西都不會被回收。保存 id，卸載時 `clearInterval(id)`。`requestAnimationFrame` 迴圈也一樣。

### 從頁面移除、但 JavaScript 還參考著的 DOM

```js
const rows = [];
function addRow(data) {
  const tr = createRow(data);
  table.append(tr);
  rows.push(tr); // 存了一份參考
}

table.replaceChildren(); // 清空表格：元素離開頁面了，但 rows 陣列還抓著它們
```

這種元素稱為 **detached** DOM：不在頁面上，卻因為 JavaScript 的參考而留在記憶體裡。一個 detached 節點會連帶留住它的整棵子樹。清空畫面時，相關的陣列、Map 也要一起清空；或改用 `WeakMap`／`WeakRef` 存放這類參考。

### 只增不減的快取

```js
const cache = new Map();
function getUser(id) {
  if (!cache.has(id)) cache.set(id, fetchUser(id));
  return cache.get(id);
}
```

[3.5 節](03-scope-closures-and-hoisting.md#35-閉包的應用)的 `memoize` 也是這樣：鍵的種類沒有上限時，快取會一直長大。快取要有上限（只保留最近的 N 筆，即 LRU）、有過期時間，或以物件為鍵時改用 `WeakMap`。

### 其他

- **沒有 `terminate()` 的 Worker**（[16.5 節](16-web-worker.md#165-原生寫法)）、沒有 `close()` 的 `BroadcastChannel`、沒有 `revokeObjectURL` 的 Object URL（[15.11 節](15-browser-native-apis.md#1511-在-vue-與-react-中建立與清理要成對)）。
- **閉包抓住了用不到的大物件**：callback 只需要一個欄位，卻抓住了整份資料。先取出需要的值，再建立 callback。
- **`console.log` 印出的物件**：DevTools 開著時，Console 會保留印出的物件，讓它們無法回收。量測記憶體前先清空 Console，正式環境也不要留著印出大物件的 log。

## 17.3 用 DevTools 找記憶體問題

**先確認真的有洩漏**：打開 DevTools 的 Performance monitor（或 Memory 面板），重複執行同一個操作（打開再關閉對話框、切換頁面再切回來）十幾次。正常情況下 JS heap 會上下起伏，GC 之後回到差不多的水位；如果每做一次就往上爬一截、GC 後也不下降，就是有東西沒被回收。

**用 heap snapshot 找出是誰**：

1. Memory 面板選 **Heap snapshot**，先做一次操作暖身，按垃圾桶圖示強制 GC，拍第一張快照。
2. 重複可疑的操作幾次，再強制 GC，拍第二張。
3. 在第二張快照選擇 **Comparison**，比較兩張之間增加了哪些物件。數量剛好是操作次數倍數的物件，最可疑。
4. 在篩選框輸入 `Detached`，可以找出所有 detached DOM 節點。
5. 選一個可疑的物件，看下方的 **Retainers**：它列出從根到這個物件的參考路徑，路徑上的那個監聽器、陣列或閉包，就是要修的地方。

Allocation timeline（Allocations on timeline）可以看到物件是在哪個時間點、由哪段程式碼配置的，適合用來找「操作過程中配置了什麼、操作結束後還剩什麼」。

### Node

```js
process.memoryUsage();
// { rss, heapTotal, heapUsed, external, arrayBuffers }，單位是位元組
```

定期記錄 `heapUsed`，觀察長時間的趨勢。需要細看時，用 `node --inspect app.js` 啟動，在 Chrome 打開 `chrome://inspect` 連上去，就能使用同一套 Memory 面板；或用 `node --heapsnapshot-signal=SIGUSR2 app.js`，在程式執行中送出訊號產生快照，再載入 DevTools 分析。

## 17.4 效能：先量再改

憑感覺優化，通常會優化到不重要的地方。流程固定是：**重現 → 量測 → 找出最慢的部分 → 修改 → 再量一次確認。**

### Performance 面板

1. DevTools 的 Performance 面板按錄製，執行卡頓的操作，停止錄製。
2. 看 **Main** 那一列：每一個灰色長條是一個 task。右上角有紅色三角形的是**長任務**（超過 50ms）。
3. 點開長任務，下方的火焰圖由上往下是呼叫關係，寬度是花費的時間。找**最寬、而且是你自己的程式碼**的那一層。
4. **Bottom-Up** 分頁依「自身花費的時間」排序函式，直接列出最耗時的函式。
5. 紫色的 **Layout** 區塊上如果標示 **Forced reflow**，就是 [13.10 節](13-dom-and-events.md#1310-讀寫版面的成本)的讀寫交錯。

開發者的電腦通常比使用者的快很多。錄製時可以在 Performance 面板的設定裡把 CPU 調慢 4 倍或 6 倍，比較接近一般手機的情況。

### 在程式碼裡量測

```js
const t0 = performance.now();
doWork();
console.log(`doWork: ${(performance.now() - t0).toFixed(1)}ms`);

console.time("render");
render();
console.timeEnd("render"); // render: 12.3ms

performance.mark("sort:start");
sortItems();
performance.mark("sort:end");
performance.measure("sort", "sort:start", "sort:end"); // 會出現在 Performance 面板的 Timings 列
```

`performance.now()` 是精確到小數毫秒、不受系統時間調整影響的時鐘，量測經過時間時用它，不要用 `Date.now()`。用 `performance.measure` 建立的量測會出現在 Performance 面板裡，也可以用 [15.5 節](15-browser-native-apis.md#155-performanceobserver取得效能紀錄)的 `PerformanceObserver` 收集起來回報。

### 量測的陷阱

- **第一次執行比較慢**。引擎先直譯執行，發現某段程式碼常被呼叫後才最佳化。微基準測試要先跑幾次暖身，取多次的結果。
- **結果沒被使用的計算可能被省略**。只計時一個迴圈、卻不用迴圈的結果，引擎可能把整段最佳化掉，量到的時間沒有意義。
- **毫秒數只在同一台機器、同一個條件下比較才有意義**，換一台機器、開了別的分頁都會不同。看的是相對的差距，不是絕對的數字。

## 17.5 常見的效能問題與對策

| 症狀 | 常見原因 | 對策 |
|------|---------|------|
| 點擊、輸入後卡一下 | 事件處理函式裡有長任務 | 分段並讓出執行緒（[10.6 節](10-event-loop.md#106-長任務會卡住畫面)），或移到 Worker（[第 16 章](16-web-worker.md)） |
| 處理資料越多越慢，而且不是等比例變慢 | 迴圈裡用 `includes`、`find`、`indexOf` 查找，成本是兩者長度相乘 | 先轉成 `Set` 或 `Map`（[7.2 節](07-collections-iterators-and-generators.md#72-set)） |
| 捲動、拖曳不順 | 每個 `scroll`、`pointermove` 都做大量工作 | `requestAnimationFrame` 合併、throttle（[3.5 節](03-scope-closures-and-hoisting.md#35-閉包的應用)）、`passive` 監聽器 |
| 調整版面時卡頓，Performance 面板有 Forced reflow | 讀寫版面交錯 | 批次讀、批次寫（[13.10 節](13-dom-and-events.md#1310-讀寫版面的成本)） |
| 長清單操作很慢 | DOM 節點太多 | 只渲染可見範圍內的項目（虛擬捲動），用事件委派代替每個項目一個監聽器 |
| 輸入時頻繁發請求、畫面閃爍 | 每個按鍵都觸發請求與重繪 | debounce 加取消舊請求（[14.6 節](14-fetch-and-network-requests.md#146-避免競態只讓最新的結果寫回)） |
| 首次載入很慢 | 一次下載、執行太多 JavaScript | 動態 `import()` 延後載入（[9.4 節](09-modules.md#94-動態-import)），移除用不到的套件 |

大部分的效能問題來自少數幾處。先用 Performance 面板找到那幾處，比全面改寫有效得多。

## 17.6 在 Node 量測

伺服器上一樣有長任務：一個請求的處理函式做了 300ms 的同步計算，這 300ms 裡其他請求全部在排隊（[10.7 節](10-event-loop.md#107-node-的事件迴圈)）。

```bash
node --cpu-prof app.js      # 結束時產生 .cpuprofile 檔，可以拖進 DevTools 的 Performance 面板
node --heap-prof app.js     # 記錄記憶體配置
node --inspect app.js       # 用 chrome://inspect 連上，直接使用 DevTools
```

`performance.now()`、`performance.mark()`、`performance.measure()` 在 Node 裡同樣可用。

## 17.7 本章小結

- 引擎從根出發回收不可達的物件；循環參考不是問題，洩漏是「還有東西參考著不需要的物件」。
- 常見的洩漏：沒移除的監聽器、沒清除的計時器、detached DOM、只增不減的快取、沒關閉的 Worker 與 Object URL。
- 綁在生命較長對象上的資源，要在卸載時成對清理；用 `signal` 一次移除多個監聽器。
- 找洩漏：重複操作觀察 heap 是否只漲不跌，再用 heap snapshot 比較，從 Retainers 找出是誰抓著物件。
- 效能問題先量再改：Performance 面板找長任務與 Forced reflow，Bottom-Up 找最耗時的函式。
- 量測用 `performance.now()`；微基準要暖身、使用計算結果、只做相對比較。

下一章：[18 — 從單檔到專案](18-from-script-to-project.md)，用 npm、Vite、ESLint 與測試把程式組織成專案。

---

[上一章：Web Worker](16-web-worker.md) · [返回課程總覽](README.md) · [下一章：從單檔到專案](18-from-script-to-project.md)
