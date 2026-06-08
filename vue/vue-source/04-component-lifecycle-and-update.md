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

`setupRenderEffect` 是 component 更新主引擎，通常會建立一個 effect：

- 首次執行：走 mount 分支
- 後續執行：走 update 分支

概念上像：

```ts
instance.update = effect(function componentEffect() {
  if (!instance.isMounted) {
    // beforeMount hooks
    const subTree = renderComponentRoot(instance);
    patch(null, subTree, container, anchor, instance, parentSuspense);
    instance.subTree = subTree;
    instance.isMounted = true;
    // mounted hooks
  } else {
    // beforeUpdate hooks
    const nextTree = renderComponentRoot(instance);
    patch(instance.subTree, nextTree, container, anchor, instance, parentSuspense);
    instance.subTree = nextTree;
    // updated hooks
  }
}, scheduler);
```

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

## 4.10 本章源碼閱讀建議路徑

先看這條主線：

1. `createComponentInstance`
2. `setupComponent`
3. `setupStatefulComponent`
4. `finishComponentSetup`
5. `setupRenderEffect`
6. `updateComponent` / `updateComponentPreRender`
7. hook 註冊與調用相關函式（`injectHook` / `invokeArrayFns` 等）

---

## 4.11 常見誤區

### 誤區一：以為 `setup` 每次更新都會重跑

`setup` 是建立期邏輯，不會在每次渲染重跑。  
每次更新重跑的是 render effect 內部 render。

### 誤區二：把生命周期當成固定時間點

實際上是綁在 patch 流程的特定階段，並受 parent/child、suspense、scheduler 影響。

### 誤區三：忽略 `subTree`

component update 的核心其實是「新舊 `subTree` patch」，  
若不理解 `subTree`，你會看不懂為什麼組件本身沒有直接操作 DOM。

---

## 4.12 本章作業

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

## 4.13 下一章預告

下一章會深挖最核心效能熱點：`patchKeyedChildren`。  
你會學到 Vue 如何用 head/tail sync + key map + LIS 降低 DOM 移動成本。
