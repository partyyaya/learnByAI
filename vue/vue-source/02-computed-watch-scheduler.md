# 第 02 章：`computed` / `watch` / scheduler

## 2.1 本章目標

這章要把「反應式系統的上層控制」打通：

- `computed`：為什麼它是 lazy、為什麼有快取
- `watch`：為什麼 callback 不一定立刻執行、如何做 cleanup
- scheduler：同一個 tick 內多次變更，為什麼常只更新一次

學完你應該能回答：

- 為什麼 `computed` 沒被讀取就不會重算？
- `watch` 的 `flush: "pre" | "post" | "sync"` 差在哪裡？
- Vue 如何避免重複排程與無限重入？

---

## 2.2 `computed`：lazy + cache 的關鍵機制

`computed` 本質是「帶快取策略的 effect」：

1. 建立一個 lazy effect（預設不立即執行 getter）
2. 用 `dirty` 標記快取是否過期
3. 讀 `.value` 時：
   - 若 `dirty = true`，執行 getter 並快取
   - 若 `dirty = false`，直接回傳快取值
4. getter 依賴被 `trigger` 時，不立刻重算，只把 `dirty` 標回 `true`

### 最小概念版

```ts
class ComputedRefImpl<T> {
  private _value!: T;
  private _dirty = true;
  private _effect: ReactiveEffect;

  constructor(getter: () => T) {
    this._effect = new ReactiveEffect(
      getter,
      () => {
        // 依賴變更時只標髒，不立刻重算
        if (!this._dirty) {
          this._dirty = true;
          trigger(this, "value");
        }
      }
    );
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

## 2.3 `watch` 與 `watchEffect` 的差異

| 項目 | `watch` | `watchEffect` |
|---|---|---|
| 依賴來源 | 明確指定（ref/reactive/getter/array） | 執行時自動收集 |
| callback 參數 | `newValue`, `oldValue`, `onCleanup` | `onCleanup` |
| 首次執行 | 預設不執行（除非 `immediate: true`） | 會立即執行一次 |
| 典型用途 | 精準觀察某個來源 | 副作用自動依賴追蹤 |

---

## 2.4 `watch` 的核心流程（簡化）

1. 將 source 轉成 getter
2. 建立 lazy effect（runner）
3. effect 觸發時執行 scheduler job
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
    cleanup?.();
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
  -> queueJob(updateComponent)
  -> Promise.then(flushJobs)
  -> 同一輪只跑一次去重後的 job
```

### scheduler 的三個重點

1. **去重（dedupe）**：同一個 job 不重複入列
2. **排序（通常按 id）**：維持父子組件更新順序可預期
3. **分區執行**：pre-flush、component jobs、post-flush

---

## 2.7 `nextTick` 與 microtask

`nextTick` 可以理解為「等這一輪排程 flush 完再執行」。

最小概念：

```ts
const p = Promise.resolve();

function nextTick(fn?: () => void) {
  return fn ? p.then(fn) : p;
}
```

因此你常看到：

```ts
state.count++;
await nextTick(); // 等待 DOM 與排程任務完成
```

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

1. render job 只會入列一次（去重）
2. `post` watch callback 也只排一次（依實作去重）
3. flush 階段先做 component update，再做 post callbacks
4. callback 看到的值是本輪最終值

---

## 2.9 Mini 實作作業（本章核心）

### 作業 A：mini-computed

- 支援 lazy 計算
- 支援 dirty 快取
- 依賴改變時只標髒，不立即重算

### 作業 B：mini-watch

- 支援 `immediate`
- 支援 `onCleanup`
- 支援 `flush: "sync"` 與簡化版 `pre/post`（可先用兩個 queue 模擬）

### 作業 C：mini-scheduler

- `queueJob(job)` 去重
- 用 microtask flush
- 提供 `nextTick()`

---

## 2.10 常見錯誤與排查

### 錯誤一：`computed` 在依賴改變時立刻重算

若你這樣實作，會失去快取優勢。  
正確做法是先 `dirty = true`，等 `.value` 被讀時再重算。

### 錯誤二：`watch` cleanup 時機錯誤

cleanup 不是最後跑，而是「**下一次 callback 前**」先跑，避免舊副作用殘留。

### 錯誤三：scheduler 沒去重

同 tick 連續三次 set 就跑三次更新，通常代表 queue 去重機制失效。

---

## 2.11 本章驗收標準

- 能清楚說出 `computed` 的 dirty/cached 機制
- 能解釋 `watch` 三種 flush 的行為差異
- 能示範 scheduler 去重：同 tick 多次 set 只執行一次主 job
- 能用 `nextTick` 正確等待 flush 完成

---

## 2.12 下一章預告

第 03 章會進入 renderer 主線：  
從 VNode 建立到 `patch` 更新，理解「資料改變 -> 畫面更新」在執行期到底發生了什麼。
