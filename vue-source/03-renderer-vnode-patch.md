# 第 03 章：Renderer 主線（VNode 到 patch）

## 3.1 本章目標

這一章要打通 Vue 執行期最關鍵的一條線：

1. `render(vnode, container)` 是如何啟動更新
2. `patch()` 如何依節點類型分派流程
3. 首次掛載與更新階段各做了哪些事
4. 為什麼同一套 `patch` 能同時處理 element、component、fragment、text

學完後你應該能清楚回答：  
「`state` 改了之後，畫面是怎麼一步步被更新的？」

---

## 3.2 Renderer 在 Vue 架構中的位置

Vue 3 可以粗分成三層：

- **reactivity**：資料變化通知
- **runtime-core（renderer）**：把變化映射成 VNode 與 patch 行為
- **runtime-dom**：把抽象操作落到瀏覽器 DOM

你這章主要看 `runtime-core`，但要知道 DOM 實作來自 `runtime-dom` 注入的 host API。

---

## 3.3 先認識 VNode（Renderer 的輸入資料）

VNode 可以理解為「描述 UI 的資料結構」。  
Renderer 不直接看 template，而是看 VNode 樹。

常見關鍵欄位：

| 欄位 | 作用 |
|---|---|
| `type` | 節點類型（`div`、Component、`Text`、`Fragment`） |
| `props` | 屬性與事件 |
| `children` | 子節點（文字 / 陣列） |
| `el` | 對應的真實 DOM（掛載後） |
| `shapeFlag` | 節點形狀位元標記（element/component/children 類型） |
| `patchFlag` | 編譯期產生的更新提示（最佳化用） |
| `key` | diff 穩定識別符 |

一句話：  
`patch` 的工作就是比較 `n1`（舊 vnode）與 `n2`（新 vnode），讓真實畫面與 `n2` 對齊。

---

## 3.4 `patch` 主流程（整章核心）

你可以把 `patch` 看成一個大分派器：

```text
patch(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized)
  -> type / shapeFlag 分流
     - Text
     - Comment
     - Static
     - Fragment
     - Element
     - Component
```

### 先判斷「是不是同一節點」

若 `n1` 與 `n2` 不是同類型（`type` 或 `key` 不同），通常先卸載舊節點，再掛載新節點。

這就是為什麼改 `key` 常會觸發「整個重建」。

---

## 3.5 首次掛載：Element 路徑

以 `<div class="box">hello</div>` 為例，首次掛載大致流程：

1. `mountElement` 建立真實元素 `el`
2. 處理子節點（文字或陣列）
3. 套用 props（class/style/attrs/events）
4. 把 `el` 插入到 container（可能帶 anchor）

概念上像：

```ts
function mountElement(vnode, container, anchor) {
  const el = hostCreateElement(vnode.type);
  vnode.el = el;

  // children
  if (isTextChildren(vnode)) {
    hostSetElementText(el, vnode.children);
  } else if (isArrayChildren(vnode)) {
    mountChildren(vnode.children, el);
  }

  // props
  for (const key in vnode.props) {
    hostPatchProp(el, key, null, vnode.props[key]);
  }

  hostInsert(el, container, anchor);
}
```

---

## 3.6 更新：Element 路徑

更新時會走 `patchElement`，核心做兩件事：

1. **更新 props**
2. **更新 children**

### 3.6.1 props 更新

- 比對新舊 props 差異
- 舊有新無 -> 移除
- 新有舊無或值變更 -> 套用

### 3.6.2 children 更新

children 有三種常見形態切換：

- text -> text
- text -> array
- array -> text
- array -> array（進入 diff，下一章詳解）

---

## 3.7 Component 路徑（從 vnode 到實例）

`processComponent` 會區分掛載/更新：

- `mountComponent`
- `updateComponent`

### 掛載階段重點

1. 建立 component instance
2. 初始化 props / slots
3. 執行 `setup`
4. 建立 render effect（這個 effect 會驅動畫面更新）

### 更新階段重點

1. 判斷是否需要更新（`shouldUpdateComponent`）
2. 需要更新則把新 vnode 與新 props 掛到 instance
3. 由既有 render effect 進入重新渲染

---

## 3.8 Renderer 與 Scheduler 的連動

很多人初讀 runtime-core 時會困惑：  
為什麼 `state` 改了不是直接 `patch`？

答案是：**通常先排程（queue），再批次 flush**。

```text
state change
  -> trigger render effect
  -> scheduler(queueJob)
  -> microtask flush
  -> component update
  -> patch subtree
```

這樣能避免同一輪事件中重複更新多次。

---

## 3.9 一個具體時序：`count++` 到畫面更新

假設 template：

```vue
<template>
  <div>{{ count }}</div>
</template>
```

時序可簡化為：

1. 初次 render 收集 `count` 依賴
2. `count.value++` 觸發 `trigger`
3. render effect 被 scheduler 入列
4. flush job 時執行 component update
5. 執行 render 產生新 subtree（新 vnode）
6. `patch(oldSubTree, newSubTree)`
7. 找到文字節點差異，更新 `textContent`

---

## 3.10 讀源碼建議路徑（本章）

先追這組函式即可：

1. `render`
2. `patch`
3. `processElement` / `mountElement` / `patchElement`
4. `processComponent` / `mountComponent` / `updateComponent`
5. `patchChildren`

你不需要第一輪就把每個分支都看完。  
先把 element + component 主線走順，再回頭補 fragment、static、suspense 分支。

---

## 3.11 常見誤區

### 誤區一：把 Renderer 當成只操作 DOM 的函式集合

其實 `runtime-core` 是平台無關層；DOM 操作是 host API 注入的結果。

### 誤區二：忽略 vnode identity（`type + key`）

只看 `type` 不看 `key`，你會誤判很多「為何重建」的現象。

### 誤區三：更新邏輯只看 `patchElement`

組件更新很多時候是 `updateComponent -> render -> patch(subTree)`，  
你如果沒連到 render effect，常會看不懂更新入口。

---

## 3.12 本章作業

### 必做

- 追一次 element 首掛與更新（文字節點變更即可）
- 追一次 component 首掛與更新（props 變更）
- 畫出 `patch` 分派決策圖（至少含 text/fragment/element/component）

### 加分

- 記錄一個 `key` 改變導致重建的案例
- 嘗試比較 `optimized = true/false` 分支差異（可先概念理解）

### 驗收標準

- 能口述「`count++` 到 DOM 改變」完整 6~8 步
- 能說明為何 Vue 用單一 `patch` 函式統一處理多節點類型
- 能指出 component update 與 element patch 的關係

---

## 3.13 下一章預告

下一章聚焦 component instance 與生命週期：  
`setup` 怎麼接進 render effect？`onMounted` / `onUpdated` 實際在什麼時機觸發？
