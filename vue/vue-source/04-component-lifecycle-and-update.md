# 第 04 章：組件生命週期與更新流程

## 4.1 本章目標

這章要把「組件為什麼會在特定時機做特定事情」說清楚：

1. component instance 是怎麼被建立的
2. `setup` 回傳值如何進入 render 上下文
3. render effect 如何驅動首次掛載與後續更新
4. 生命週期 hook 的註冊點與執行順序

你要做到的不只是背 `onMounted`，而是能畫出完整時序。

---

## 4.2 component mount 主線（高頻面試點）

簡化流程：

```text
mountComponent
  -> createComponentInstance
  -> setupComponent
     -> initProps
     -> initSlots
     -> setupStatefulComponent
        -> setup()
        -> handleSetupResult
        -> finishComponentSetup
  -> setupRenderEffect
     -> 首次 render + patch
```

---

## 4.3 instance 到底裝了什麼

component instance 可以想成「單個組件執行期狀態容器」，常見內容：

- `vnode` / `next`：當前與下一個 vnode
- `type`：組件定義
- `props` / `attrs` / `slots`
- `setupState`：`setup()` 回傳物件
- `proxy`：template/render 讀取上下文代理
- `isMounted`：是否已掛載
- `subTree`：render 回傳的 vnode 樹
- `update`：render effect runner

---

## 4.4 `setup()` 的關鍵路徑

`setup` 的核心是把使用者邏輯接進框架：

1. 建立 `setupContext`（含 `attrs/slots/emit/expose`）
2. 執行 `setup(props, context)`
3. 處理回傳：
   - 回傳 function -> 視為 render function
   - 回傳 object -> 存到 `setupState`
4. `finishComponentSetup` 補齊最終 render（可能來自編譯後 template）

### 常見追蹤點

- 為什麼 `setup` 內可呼叫 `onMounted`：  
  因為當前 instance 在 setup 階段被設為 active instance，hook 會註冊到該 instance。

---

## 4.5 `setupRenderEffect`：生命週期的交會點

`setupRenderEffect` 是 component 更新主引擎。它做的事只有一件：把「render + patch」包成一個 **render effect**，讓響應式資料一變就能自動重跑。

- 首次執行：走 mount 分支
- 後續執行：走 update 分支

> 以下對應 Vue 3.5.x。舊教學常寫成 `effect(fn, scheduler)`，那**不是**現在的真實實作，別再照那個簽名追碼。

真實實作大致是這樣：

```ts
// 1) 要跑的內容：首掛走 mount、之後走 update
const componentUpdateFn = () => {
  if (!instance.isMounted) {
    // beforeMount hooks
    const subTree = (instance.subTree = renderComponentRoot(instance));
    patch(null, subTree, container, anchor, instance, parentSuspense, namespace);
    instance.isMounted = true;
    // mounted hooks
  } else {
    // beforeUpdate hooks
    const nextTree = renderComponentRoot(instance);
    const prevTree = instance.subTree;
    instance.subTree = nextTree;
    patch(prevTree, nextTree, container, anchor, instance, parentSuspense, namespace);
    // updated hooks
  }
};

// 2) 用底層類別 ReactiveEffect（見 01 章），並在 instance.scope 內建立
instance.scope.on();
const effect = (instance.effect = new ReactiveEffect(componentUpdateFn));
instance.scope.off();

// 3) 兩個 runner：update 強制跑、job 只在 dirty 時才跑
const update = (instance.update = effect.run.bind(effect));
const job = (instance.job = effect.runIfDirty.bind(effect)); // runIfDirty：dirty 才重跑
job.i = instance;   // 3.5：把 instance 掛在 job 上，方便 scheduler 排序/找父子
job.id = instance.uid;

// 4) 資料變動不是同步 patch，而是把 job 丟進 queue（見 3.8 scheduler）
effect.scheduler = () => queueJob(job);
```

幾個關鍵點：

- **不是 `effect(fn, scheduler)`**：Vue 用的是底層類別 `ReactiveEffect`（見 01 章），`new ReactiveEffect(componentUpdateFn)` 建立後，再把 `effect.scheduler` 設成 `() => queueJob(job)`；所以資料變動時走的是「排程」而非同步重繪。
- **`instance.update` vs `instance.job`**：`update` 是 `effect.run`（強制重跑）；`job` 是 `effect.runIfDirty`——**只有 dirty 才重跑**，避免無謂 render。真正被 scheduler 入列的是 `job`。
- **3.5 的 `job.i = instance`**：把元件實例掛在 job 上，scheduler 才能依 `instance.uid` 做父子排序、去重與尋找 parent，確保「父先於子」更新。
- **綁在 `instance.scope`（EffectScope）**：effect 是在 `instance.scope.on()` / `off()` 之間建立的，也就是註冊進該元件的 `EffectScope`（見 01 章 effectScope）。元件卸載時只要 `instance.scope.stop()`，這個 render effect 連同 `setup` 裡建立的所有 `watch` / `computed` 會被**整包 stop**，不會外洩。

---

## 4.6 生命週期 hook 順序（實務常踩雷）

以父子組件首次掛載為例，常見順序：

1. parent `beforeMount`
2. child `beforeMount`
3. child `mounted`
4. parent `mounted`

更新時也有父子先後關係，通常與 scheduler 的 job id 與遞迴 patch 流程共同決定。  
你需要實測案例，不要只背固定順序。

---

## 4.7 update 流程：從 `next vnode` 到重新渲染

更新階段的核心是 `updateComponent`：

1. 透過 `shouldUpdateComponent` 判斷是否值得更新
2. 若不更新，只同步 vnode 引用（避免無效重渲染）
3. 若更新：
   - 記錄 `instance.next = n2`
   - 觸發 `instance.update`（通常透過 scheduler 入列）
   - 在 update effect 中 `updateComponentPreRender` 同步新 props/slots
   - 執行 render 並 patch `subTree`

---

## 4.8 為什麼有時候 props 變了卻沒更新？

幾個常見原因：

- `shouldUpdateComponent` 判斷為可跳過（例如 patch flag 已提示可略過）
- 父層本身沒有觸發有效更新
- 你看的資料不是 reactive / ref
- `v-memo`、`shallow` 策略或手動優化影響更新

排查建議：  
先確認依賴是否有被追蹤，再看 job 是否入列，再看 patch 是否命中分支。

---

## 4.9 hook 內做非同步副作用的建議

- 在 `watch` 或 `watchEffect` 使用 `onCleanup` 處理競態
- 在 `onUnmounted` 清理事件、計時器、外部訂閱
- 若需要等待 DOM 完成，使用 `await nextTick()`

不要把大量非同步流程直接塞在 render 或 computed 中。

---

## 4.10 錯誤處理與除錯 hooks

> 以下對應 Vue 3.5.x。

### 4.10.1 錯誤怎麼被接住：`callWithErrorHandling`

Vue 幾乎不「裸呼叫」使用者提供的函式（render、生命週期 hook、watch callback、事件處理器…），而是包一層：

- `callWithErrorHandling(fn, instance, type, args)`：同步呼叫 `fn`，`try/catch` 後把錯誤交給 `handleError`。
- `callWithAsyncErrorHandling(fn, instance, type, args)`：同上，但額外處理「回傳 Promise」的情況——`.catch` 到的 rejection 也會進 `handleError`（否則 async 錯誤會漏接）。

`type` 是 `ErrorCodes`（例如 `SETUP_FUNCTION`、`RENDER_FUNCTION`、`WATCH_CALLBACK`），警告訊息會告訴你錯在哪個階段。

### 4.10.2 錯誤怎麼冒泡：`onErrorCaptured`

`handleError` 會**沿著 `instance.parent` 往上走**，依序呼叫每一層註冊的 `onErrorCaptured(err, instance, info)`：

- 任一層的 `onErrorCaptured` 回傳 `false`，就**停止繼續往上冒泡**（視為已處理）。
- 都沒攔截（或都沒回傳 `false`），最後落到全域 `app.config.errorHandler`；再沒有就 `console.error`。

```ts
// 父元件當「錯誤邊界」
onErrorCaptured((err, instance, info) => {
  reportToServer(err, info)   // info 例如 'render function'、'setup function'
  hasError.value = true
  return false                // 攔下來，不再往上冒泡
})
```

### 4.10.3 兩個除錯 hook：`onRenderTracked` / `onRenderTriggered`

這兩個是**開發模式專用**、掛在 render effect 上的除錯鉤子：

- `onRenderTracked({ target, key, type })`：render 期間**收集到某個依賴**時觸發——回答「這次 render 讀了哪些響應式資料」。
- `onRenderTriggered({ target, key, type, oldValue, newValue })`：某個依賴**變動而觸發這次 re-render** 時觸發——回答「到底是誰害我重渲染」。

實作上它們對應到 render effect 的 `onTrack` / `onTrigger` 回呼（`ReactiveEffect` 的兩個 debug 選項），所以只有 dev build 會接。追「莫名其妙一直 re-render」時特別好用。

---

## 4.11 async setup 與 Suspense 的掛載路徑

> 以下對應 Vue 3.5.x；Suspense 目前仍是**實驗性 API**（見 08 章）。

若 `setup()` 回傳的是 **Promise**（`async setup`），這個元件就不能像同步元件一樣「setup 完馬上 render」。流程改成：

1. `setupStatefulComponent` 發現 `setup` 回傳 Promise，把它掛成 `instance.asyncDep`。
2. 這個元件必須在一個 **`<Suspense>`** 邊界底下。`mountComponent` 看到 `instance.asyncDep`，就把它**登記到最近的 Suspense**（`parentSuspense.registerDep`），並**先不建立 render effect**。
3. Suspense 這段期間顯示 **fallback 分支**（`#fallback` slot）。
4. 當 `asyncDep` resolve，Suspense 回頭對這個實例補做 `handleSetupResult` → `setupRenderEffect` 完成真正掛載；等所有 async 依賴都就緒後，Suspense 從 fallback 切到 content 分支。

一句話心智模型：**async setup 把「該元件的掛載」延後，交給上層 Suspense 統一調度**；沒有 Suspense 包著的 async setup 會直接報錯。

---

## 4.12 本章源碼閱讀建議路徑

先看這條主線：

1. `createComponentInstance`
2. `setupComponent`
3. `setupStatefulComponent`
4. `finishComponentSetup`
5. `setupRenderEffect`
6. `updateComponent` / `updateComponentPreRender`
7. hook 註冊與調用相關函式（`injectHook` / `invokeArrayFns` 等）

---

## 4.13 常見誤區

### 誤區一：以為 `setup` 每次更新都會重跑

`setup` 是建立期邏輯，不會在每次渲染重跑。  
每次更新重跑的是 render effect 內部 render。

### 誤區二：把生命周期當成固定時間點

實際上是綁在 patch 流程的特定階段，並受 parent/child、suspense、scheduler 影響。

### 誤區三：忽略 `subTree`

component update 的核心其實是「新舊 `subTree` patch」，  
若不理解 `subTree`，你會看不懂為什麼組件本身沒有直接操作 DOM。

---

## 4.14 本章作業

### 必做

- 寫一個父子組件，分別印出 `beforeMount/mounted/beforeUpdate/updated`
- 追一次 `props` 更新路徑（父改 props -> 子更新）
- 畫出 `setupRenderEffect` 的 mount/update 分支流程圖

### 加分

- 製作一個「同 tick 多次改 props」案例，觀察 scheduler 合併更新
- 加入 `watch(..., { flush: "post" })` 比對與 `updated` 的先後

### 驗收標準

- 能解釋 `setup`、render、hook 之間的先後關係
- 能指出 update 階段 `updateComponentPreRender` 的用途
- 能說出一個「props 變了但更新被跳過」的合理原因

---

## 4.15 下一章預告

下一章會深挖最核心效能熱點：`patchKeyedChildren`。  
你會學到 Vue 如何用 head/tail sync + key map + LIS 降低 DOM 移動成本。
