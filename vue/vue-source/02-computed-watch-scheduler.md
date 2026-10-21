# 第 02 章：`computed` / `watch` / scheduler

> 目標版本：**Vue 3.5.x**。本章沿用第 01 章的 3.5 reactivity 模型（`Dep`/`Link`/`version`/`globalVersion`、`activeSub`）。若還沒讀 [01 章的 1.3.1](./01-reactivity-core-track-trigger-effect.md)，先補——特別是那張「3.4 與 3.5 各重構過一次」的版本地圖。

## 2.1 本章目標

這章要把「響應式系統的上層控制」打通：

- `computed`：為什麼它是 lazy、為什麼有快取、3.5 起怎麼用「版本號」判斷要不要重算
- `watch`：為什麼 callback 不一定立刻執行、如何做 cleanup、3.4 / 3.5 各新增了什麼
- scheduler：同一個 tick 內多次變更，為什麼常只更新一次

學完你應該能回答：

- 為什麼 `computed` 沒被讀取就不會重算？
- 為什麼「computed 重算後值沒變，下游 effect 不會被觸發」？（3.4 行為）
- `watch` 的 `flush: "pre" | "post" | "sync"` 差在哪裡？
- Vue 如何避免重複排程與無限重入？

---

## 2.2 `computed`：lazy + cache 的關鍵機制

`computed` 本質是「帶快取策略、且自己也是一個依賴來源的 effect」：

1. 建立一個 lazy 計算（預設不立即執行 getter）
2. 讀 `.value` 時：過期就執行 getter 並快取；沒過期就直接回傳快取值
3. getter 的依賴被 `trigger` 時，不立刻重算，只把自己標記為可能過期，並通知**它自己的**下游

### 最小概念版（教學簡化，真實 3.5 見 2.2.1）

```ts
// ⚠️ 教學簡化版：用 _dirty 布林幫你建立「標髒 / 重算」的直覺（這是 3.3 以前的模型）
class ComputedRefImpl<T> {
  private _value!: T;
  private _dirty = true;
  private _effect: ReactiveEffect;

  constructor(getter: () => T) {
    this._effect = new ReactiveEffect(getter, () => {
      // 依賴變更時只標髒，不立刻重算
      if (!this._dirty) {
        this._dirty = true;
        trigger(this, "value");
      }
    });
  }

  get value(): T {
    track(this, "value");
    if (this._dirty) {
      this._dirty = false;
      this._value = this._effect.run();
    }
    return this._value;
  }
}
```

### 一句話總結

`computed` 的效能來自「**改變時標髒，讀取時重算**」，不是「每次改變都重算」。

---

## 2.2.1 從 `_dirty` 布林到「版本化髒判定」：3.4 改行為、3.5 改機制

> 這一節最容易被搞混，先把兩次改動分開講（呼應 [01 章 1.3.1](./01-reactivity-core-track-trigger-effect.md) 的版本地圖）：
>
> | 版本 | 改了什麼 |
> |------|----------|
> | **3.4** | 改的是**行為**：computed 重算後若值沒變，**不再觸發下游**。當時的實作是 `_dirtyLevel` + `_trackId`，還沒有版本號。 |
> | **3.5** | 改的是**機制**：`_dirtyLevel` 整套換成 `dep.version` / `globalVersion` 版本比對，讀 `.value` 走 `refreshComputed()`。行為維持 3.4 的結果，但判定更便宜。 |
>
> 下面描述的 `refreshComputed`、`globalVersion`、link version 比對**都是 3.5 的實作**；`_dirty` 布林則是 3.3 以前。追原始碼（`packages/reactivity/src/computed.ts`）務必對準你手上的版本。

3.5 重寫後 `ComputedRefImpl` 有兩個關鍵改變：

**改變一：computed 同時是 `Subscriber` 也是 `Dep`。**
它訂閱自己 getter 用到的那些 dep（所以有 `deps`/`depsTail`），同時它自己也是一個 `Dep`（所以讀它 `.value` 的 effect 會訂閱它）。它不再內含一個獨立的 `ReactiveEffect`。

**改變二：髒判定改用版本比對，不是單一布林（3.5）。**
讀 `.value` 會走 `refreshComputed(cRef)`，流程大致是：

```text
refreshComputed(c):
  1. 若 c 沒被標記可能過期，且 c.globalVersion === 全域 globalVersion
       → 什麼都沒變過，直接用快取（最便宜的短路）
  2. 更新 c.globalVersion = globalVersion
  3. 走訪 c 的依賴 link，比對每條 link.version 與 dep.version
       → 都沒變 → 用快取
       → 有變 → 真的重算 getter（prepareDeps / cleanupDeps 修剪依賴）
  4. 重算後：只有新值 hasChanged 才 c.dep.version++
```

**改變三（最容易被考）：重算後值沒變，就不 bump `dep.version`，下游不會被觸發。**（這個**行為**從 3.4 就有了，3.5 只是換成用版本號實作。）

```ts
const n = ref(1);
const isEven = computed(() => n.value % 2 === 0);

watchEffect(() => console.log("isEven:", isEven.value));
// 印出 isEven: false

n.value = 3; // n 變了 → isEven 會重算，但結果還是 false（值沒變）
// → isEven.dep.version 不 bump → watchEffect 不會再跑
```

3.3 以前的 `_dirty` 布林模型做不到這件事（依賴一變就標髒、下游就重跑）。這是 3.4 很實際的效能改善，3.5 再把它的實作換成版本比對。

> 對照：若你看到 computed 的 `_dirty` / `_cacheable`（3.3 以前）或 `_dirtyLevel`（3.4），那都是舊欄位名；3.5 起以版本比對為準。

---

## 2.3 `watch` 與 `watchEffect` 的差異

| 項目 | `watch` | `watchEffect` |
|---|---|---|
| 依賴來源 | 明確指定（ref/reactive/getter/array） | 執行時自動收集 |
| callback 參數 | `newValue`, `oldValue`, `onCleanup` | `onCleanup` |
| 首次執行 | 預設不執行（除非 `immediate: true`） | 會立即執行一次 |
| 典型用途 | 精準觀察某個來源 | 副作用自動依賴追蹤 |

### 3.4 / 3.5 新增的能力（追原始碼會遇到）

| 能力 | 版本 | 說明 |
|------|------|------|
| `once: true` | 3.4 | callback 只跑一次後自動停止 |
| `deep: number` | 3.5 | `deep` 除了 `true`（無限深）外可給**數字**限制遞迴深度，避免大物件深層遍歷過貴 |
| 回傳 `WatchHandle` | 3.5 | `watch()` 回傳值除了可當函式呼叫來 stop，還帶 `.pause()` / `.resume()` / `.stop()` |
| `getCurrentWatcher()` | 3.5 | 在 watcher 執行期間拿到當前 watcher 實例 |
| `onWatcherCleanup(fn)` | 3.5 | 可直接 `import { onWatcherCleanup } from 'vue'`，在 watcher callback 內**同步**呼叫註冊清理，不必再從參數拿 `onCleanup` |

```ts
import { watch, onWatcherCleanup } from "vue";

const handle = watch(id, async (newId) => {
  const controller = new AbortController();
  onWatcherCleanup(() => controller.abort()); // 下次觸發或停止前，先中止上一個請求
  const data = await fetch(`/api/item/${newId}`, { signal: controller.signal });
  // ...
}, { once: false, deep: 1 });

handle.pause();  // 暫停
handle.resume(); // 恢復
handle.stop();   // 停止
```

---

## 2.4 `watch` 的核心流程（簡化）

1. 將 source 轉成 getter
2. 建立 lazy effect（runner）
3. effect 觸發時執行 scheduler job（依 `flush` 決定何時跑）
4. job 內比較新舊值，必要時執行 callback
5. callback 執行前先跑上一次註冊的 cleanup

```ts
function doWatch(source, cb, options) {
  let getter = normalizeSourceToGetter(source);
  let oldValue: unknown;
  let cleanup: (() => void) | undefined;

  const onCleanup = (fn: () => void) => {
    cleanup = fn;
  };

  const job = () => {
    const newValue = runner.run();
    cleanup?.();            // 下一次 callback 前，先跑上次的清理
    cb(newValue, oldValue, onCleanup);
    oldValue = newValue;
  };

  const runner = new ReactiveEffect(getter, () => queueByFlushOption(job, options.flush));

  if (options.immediate) {
    job();
  } else {
    oldValue = runner.run();
  }
}
```

> **入口變了（3.5 重要）**：以上是概念版。3.5 起 `watch` 的核心實作已抽到 **`@vue/reactivity`** 的 `watch.ts`（`baseWatch`），`runtime-core/src/apiWatch.ts` 只是**包裝**（補上元件實例綁定、`flush: 'pre'/'post'` 對接元件排程、SSR 行為等）。所以你要追 watch 的核心邏輯（source 正規化、`onWatcherCleanup`、`WatchHandle`）要去 reactivity 包，不是只看 runtime-core——00 / 10 章的入口地圖也照這個更新。

---

## 2.5 `flush` 時機：`pre` / `post` / `sync`

`watch` 常見困惑都在 flush 時機。先記這張：

| flush | 觸發時機 | 常見用途 |
|---|---|---|
| `pre`（預設） | 元件更新前 | 想在 render 前同步衍生狀態 |
| `post` | DOM patch 後 | 需要讀取最新 DOM（尺寸、位置） |
| `sync` | 依賴變更時立即執行 | 極少數低延遲需求（要小心抖動） |

### 實務建議

- 預設先用 `pre`
- 需要碰 DOM 狀態才用 `post`
- `sync` 謹慎使用，容易造成連鎖更新與效能問題

---

## 2.6 scheduler：Vue 如何做「合併更新」

核心思想是把 job 放進佇列，等 microtask 統一 flush：

```text
set state 多次
  -> queueJob(componentUpdate)
  -> 掛在 currentFlushPromise 上（Promise.then(flushJobs)）
  -> 同一輪只跑一次去重後的 job
```

### scheduler 的真實重點（`packages/runtime-core/src/scheduler.ts`）

1. **去重靠位元旗標，不是 `queue.includes(job)`**。每個 job 是帶 `id`/`flags` 的函式，`SchedulerJobFlags` 有 `QUEUED` / `PRE` / `ALLOW_RECURSE` / `DISPOSED`。`queueJob` 先看 `job.flags & QUEUED`，沒排過才插入並標記 `QUEUED`；flush 後清掉旗標。用 bit 判斷比 `includes` 掃陣列快得多。

2. **依 `id` 插入排序，維持父→子順序**。`queue` 依 `job.id` 由小到大（元件的 id 就是 `instance.uid`，父元件先建立所以 id 較小 → 先更新）。符合條件時直接加到隊尾，否則用二分搜尋找插入位置。

3. **pre 與 post 的真實分區**：pre-flush job（帶 `PRE` 旗標，例如 `flush: 'pre'` 的 watcher）**併在同一個主 `queue`**、依 id 排序，flush 時排在對應元件更新之前跑；真正獨立的另一個佇列是 **`pendingPostFlushCbs`**（`flush: 'post'` 的 watcher、`onMounted` 相關等），在主 queue 跑完後才 `flushPostFlushCbs()`（會先去重 + 依 id 排序）。所以「pre / component / post 三區」的正確理解是「**主佇列（pre + component，依 id 混排）＋ post 佇列**」。

4. **遞迴保護**：dev 下 `checkRecursiveUpdates` 會統計同一輪 flush 中某 job 執行幾次，超過 `RECURSION_LIMIT`（100）就丟 **`Maximum recursive updates exceeded`**——這通常代表你在 watcher/render 裡改了自己依賴的狀態造成無窮迴圈。

5. **失效工作以 `DISPOSED` 跳過**：以 Vue 3.5.13 為例，元件卸載時將待執行的 update job 標上 `DISPOSED`，`flushJobs` 遇到就跳過。不要把舊版 `invalidateJob` 移除佇列項目的說明套到這個版本；卸載端可對照 [renderer.ts](https://github.com/vuejs/core/blob/v3.5.13/packages/runtime-core/src/renderer.ts) 的 `unmountComponent`。

6. **3.5 job 旗標**：job 直接帶 `flags` 與 `i`（instance）；render job 用 `runIfDirty` 只在 dirty 時真的重跑（見第 04 章）。

---

## 2.7 `nextTick` 與 microtask

`nextTick` 等待的是呼叫當下可取得的 Vue 更新 flush Promise，並不會預先訂閱所有未來更新。
很多人以為它是固定 `Promise.resolve().then(fn)`，其實不是：

```ts
// 概念接近真實：掛在「本輪 flush 的那個 promise」後面
let currentFlushPromise: Promise<void> | null = null;
const resolvedPromise = Promise.resolve();

function nextTick(fn?: () => void) {
  const p = currentFlushPromise || resolvedPromise;
  return fn ? p.then(fn) : p;
}
```

差別在於：當有排程正在進行時，`currentFlushPromise` 是「這輪 flushJobs 完成」的 promise，所以 `await nextTick()` 會等**整輪更新（含 DOM patch）跑完**，而不只是等一個空的 microtask。這正是「`nextTick` 之後能讀到最新 DOM」的原因。

上面的程式省略泛型與 `$nextTick` callback 的 `this` 綁定。以下依 Vue 3.5.13 的
[scheduler.ts](https://github.com/vuejs/core/blob/v3.5.13/packages/runtime-core/src/scheduler.ts) 串起呼叫鏈。

### 2.7.1 `currentFlushPromise` 是誰建立、何時完成？

```text
同步階段：修改 render 用到的狀態
  → 響應式依賴通知元件 effect 的 scheduler
  → queueJob(job)：去重、插入主佇列
  → queueFlush()：沒有待處理的 flush Promise 才建立
      currentFlushPromise = resolvedPromise.then(flushJobs)
  → 呼叫 nextTick(callback)：把 callback 接在這個 Promise 後面

目前同步程式執行完，進入微任務：
  → flushJobs()：執行主佇列（pre watcher + 元件更新，依 id 排序）
      → 元件 render / patch 更新 DOM
  → flushPostFlushCbs()：執行 post watcher、相關生命週期回呼
  → 清除 currentFlushPromise；若佇列又有工作，繼續同步 flush
  → flushJobs 返回，原本的 Promise 才完成
  → 接在該 Promise 後的 nextTick callback / await 後續程式執行
```

把 `currentFlushPromise` 設回 `null` 是清除排程器的欄位，不會讓外部已取得的 Promise 提早完成。
若 post callback 同步加入了更多工作，這些工作也會在 flush 返回前繼續處理。
但 callback 若另外發起網路請求，請求完成後才加入的更新不在這個等待範圍內。

因此，重點不是「隨便等一個微任務」，而是等待與這批 Vue 更新相連的 Promise。

### 2.7.2 呼叫順序與等待範圍

```ts
state.count++;
await nextTick(); // 等待本輪排程（含 DOM 更新）完成
```

| 情境 | 行為與注意事項 |
|---|---|
| 先修改狀態，再 `await nextTick()` | 等待已排入的更新；適合讀取更新後的 DOM |
| 沒有待處理更新就呼叫 `nextTick()` | 取得已完成的 `resolvedPromise`；callback／await 後續仍透過微任務執行，但不會主動觸發 render |
| 空閒時先 `nextTick(callback)`，再修改狀態 | callback 的微任務可能排在 flush 前面，讀到舊 DOM；見 2.8 的實驗 |
| 同一批更新後呼叫多次 `nextTick()` | 共用該批 flush Promise，不代表強制產生多次畫面更新 |
| 還有尚未完成的 `fetch`、計時器或其他非同步工作 | 不會自動等待它們；先等資料，再等資料變更造成的 Vue 更新 |

特別區分：上表的提前註冊是 `nextTick(callback)`，不能把所有「先呼叫 nextTick」寫法一概而論。
例如先取得 `const p = nextTick()`、再改狀態、最後才 `await p`，微任務註冊時點不同；
要判斷具體順序，應畫出當時佇列。實務上採「先改狀態，再 await」最容易讀懂。

### 2.7.3 DOM 更新完成，不等於瀏覽器已繪製

`nextTick` 等 Vue 的 DOM patch，不保證使用者已在螢幕上看見這一幀，也不等待 CSS transition、圖片下載或字型載入完成。
讀取 `getBoundingClientRect()` 等尺寸可能讓瀏覽器進行 layout，但 layout 與 paint 是不同階段。

因此，先顯示 loading、`await nextTick()`、接著立刻跑很久的同步迴圈，仍可能看不到 loading。
瀏覽器要有機會繪製，主執行緒也不能一直被佔住。
`requestAnimationFrame` 用於配合繪製前的動畫工作，但 callback 本身是在繪製前，單次 rAF 也不是「已繪製完成」的保證。
CPU 密集工作應考慮分段或 Worker；動畫完成則使用對應的動畫事件。
瀏覽器時序可參考 MDN 的 [微任務與事件迴圈](https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide/In_depth) 與 [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)。

---

## 2.8 一個完整時序：同 tick 多次修改

假設：

- 一個組件 render effect
- 一個 `watch(count, cb, { flush: "post" })`

在同一個事件回呼中連續：

```ts
count.value++;
count.value++;
count.value++;
```

預期現象：

1. render job 只會入列一次（`QUEUED` 旗標去重）
2. `post` watch callback 也只排一次（`flushPostFlushCbs` 去重）
3. flush 階段先做主佇列（含 pre + component update，依 id），再做 post callbacks
4. callback 看到的值是本輪最終值

### 可執行實驗：提前註冊的 `nextTick` 為什麼讀到舊 DOM？

將以下內容放進 `App.vue`，待初次掛載完成後按一次按鈕。
前提是按下時沒有其他待處理的 Vue 更新，也沒有其他程式修改 `count`。

```vue
<script setup>
import { nextTick, ref, watch } from 'vue'

const count = ref(0)
const label = ref(null)

watch(count, () => {
  console.log('post', label.value.textContent)
}, { flush: 'post' })

async function run() {
  nextTick(() => {
    console.log('early', label.value.textContent)
  })

  count.value++
  count.value++
  count.value++
  console.log('sync', label.value.textContent)

  await nextTick()
  console.log('after', label.value.textContent)
}
</script>

<template>
  <p ref="label">{{ count }}</p>
  <button @click="run">觀察更新順序</button>
</template>
```

第一次點擊預期輸出：

```text
sync 0
early 0
post 3
after 3
```

`early` 先接在已完成的 Promise 後，微任務比本次狀態更新的 flush 更早入列。
同步程式先讀到舊 DOM；接著 early callback 也讀舊 DOM；flush 才更新到 3、執行 post watcher，最後執行 `await nextTick()` 後續程式。
如果把 early 那段移到三次遞增之後，它會改接到 flush Promise，這時順序是 `sync 0 → post 3 → early 3 → after 3`。

---

## 2.9 Mini 實作作業（本章核心）

### 作業 A：mini-computed

- 支援 lazy 計算與快取
- 依賴改變時只標髒，不立即重算
- 進階：改用「版本號」判定，並做到「重算後值沒變則不通知下游」（對齊 2.2.1）

### 作業 B：mini-watch

- 支援 `immediate`、`once`
- 支援 `onCleanup`（以及模擬 `onWatcherCleanup` 的同步註冊）
- 支援 `flush: "sync"` 與簡化版 `pre/post`（可先用兩個 queue 模擬）

### 作業 C：mini-scheduler

- `queueJob(job)` 用「旗標」去重（而非 `includes`）
- 依 `id` 插入排序
- 用 microtask flush、暴露 `currentFlushPromise` 給 `nextTick()`
- 加一個遞迴上限保護
- 以 2.8 的實驗驗證「先註冊 callback」與「先改狀態」的差異；加入 post callback 排新工作的案例，確認 flush 會繼續處理

---

## 2.10 常見錯誤與排查

### 錯誤一：`computed` 在依賴改變時立刻重算

若你這樣實作，會失去快取優勢。正確做法是先標記過期，等 `.value` 被讀時再重算（3.5 是靠版本比對，見 2.2.1）。

### 錯誤二：`watch` cleanup 時機錯誤

cleanup 不是最後跑，而是「**下一次 callback 前**」先跑，避免舊副作用殘留（3.5 可用 `onWatcherCleanup`）。

### 錯誤三：scheduler 沒去重

同 tick 連續三次 set 就跑三次更新，通常代表 `QUEUED` 旗標去重機制失效。

### 錯誤四：看到 `Maximum recursive updates exceeded`

代表某 job 在同一輪 flush 內反覆自我觸發超過 100 次——多半是在 watcher/render 內改了自己依賴的狀態。用 2.6 第 4 點的 `checkRecursiveUpdates` 觀念去找那個「改自己」的地方。

---

## 2.11 本章驗收標準

- 能清楚說出 `computed` 的髒判定演進：`_dirty` 布林（3.3）→ `_dirtyLevel`（3.4，帶來「值沒變不觸發下游」）→ 版本比對（3.5）
- 能解釋 `watch` 三種 flush 的行為差異，並知道 3.5 後 watch 核心在 `@vue/reactivity`
- 能示範 scheduler 用旗標去重：同 tick 多次 set 只執行一次主 job
- 能講出 `nextTick` 為何要掛在 `currentFlushPromise` 後面
- 能預測沒有待處理更新與提前註冊 callback 時的順序，並區分 DOM patch 與瀏覽器 paint

---

## 2.12 下一章預告

第 03 章會進入 renderer 主線：從 VNode 建立到 `patch` 更新，理解「資料改變 -> 畫面更新」在執行期到底發生了什麼，以及 client render 與 SSR hydration 兩條路徑的差異。
