# 第 05 章：keyed diff 與 LIS 優化

## 5.1 本章目標

這章只做一件大事：把 `patchKeyedChildren` 看懂。  
它是 Vue 更新性能的核心熱區，也是最常被問到的源碼題。

你要掌握：

1. 為什麼要 key
2. Vue 如何分段處理 children diff
3. LIS（最長遞增子序列）在這裡扮演什麼角色
4. 哪些情況會觸發移動、插入、刪除

---

## 5.2 沒有 key 會發生什麼事

若 children 缺 key，框架很難穩定判斷節點身份，容易出現：

- 本來想「移動」卻被當成「覆蓋」
- 元件內部狀態錯位
- 非預期重建與性能波動

一句話：  
`key` 是 diff 階段識別「同一個節點」的最重要資訊之一。

---

## 5.3 `patchChildren` 分流（先看全貌）

children 更新通常先進入 `patchChildren`，再視情況分支：

- text -> text：改文字
- array -> text：卸載舊 children，設文字
- text -> array：清文字，掛載新 children
- array -> array：可能進入 `patchKeyedChildren`

你這章聚焦最後一條。

---

## 5.4 `patchKeyedChildren` 的 5 個分支（整章核心）

> 以下對應 Vue 3.5.x。

Vue 不是暴力雙迴圈比對，而是用 4 個游標——`i`（頭指標）、`e1`（舊尾）、`e2`（新尾）——把問題切成 **5 個分支**依序處理。以下用一組例子貫穿：

```text
old: [a, b, c, d, e, f, g]
new: [a, b, e, c, d, h, g]   // 頭尾各有不動、中段重排 + 增刪
```

### 分支①：頭部同步（`i` 從前往後）

`i` 從 0 開始，只要 `old[i]` 與 `new[i]` 是同一節點（`type + key` 相同）就 `patch` 更新、`i++`；一遇到不同就停。
→ 上例同步掉 `a, b`，停在 `i = 2`。

### 分支②：尾部同步（`e1` / `e2` 從後往前）

`e1` 指舊尾、`e2` 指新尾，只要 `old[e1]` 與 `new[e2]` 同節點就 `patch`，兩者一起往前。
→ 上例同步掉 `g`，`e1`、`e2` 各自停在剩餘尾端。

### 分支③：新的比舊的多 → 掛載新增（`i > e1 && i <= e2`）

頭尾同步後若**舊的已用完、新的還有剩**，中間這段全是新增節點，直接 `patch(null, ...)` 掛載（以 `new[e2 + 1]` 節點為 anchor）。

### 分支④：舊的比新的多 → 卸載多餘（`i > e2 && i <= e1`）

反過來，若**新的已用完、舊的還有剩**，中間這段是被刪掉的節點，逐一 `unmount`。

### 分支⑤：亂序區間（`i..e1` 與 `i..e2` 都還有剩）

這是最難也最關鍵的一段——中間既有重排、又可能夾雜增刪。做法：

1. 建 **`keyToNewIndexMap`**：新區間 `key -> newIndex`，讓「用 key 找對應」是 O(1)。
2. 建 **`newIndexToOldIndexMap`**（長度＝新區間長度，初始全 0）：走訪舊區間，用 key map 找到它在新區間的位置，記下「新位置 ← 舊索引 + 1」（**存 0 代表這個新位置沒有對應舊節點，是全新的**）；舊節點若在新區間找不到位置，直接 `unmount`。過程用 `maxNewIndexSoFar` 偵測是否出現逆序，決定要不要 `move`（`moved` 旗標）。
3. 若需要移動，對 `newIndexToOldIndexMap` 算 **最長遞增子序列（LIS，`getSequence`）**：落在 LIS 上的節點「相對順序已正確、可不動」，其餘才需要 `move`；值為 0 的位置則 `mount` 新建。並**倒序**走訪新區間（方便拿到穩定 anchor，見 5.8）。

> 記憶法：**頭 → 尾 → 多退少補 → 亂序才動用 LIS**。多數真實更新只落在 ①②③④，只有真正亂序重排才會進 ⑤。

---

## 5.5 中段處理的資料結構

常見關鍵結構：

- `keyToNewIndexMap`：新 children 的 key -> index
- `newIndexToOldIndexMap`：新索引對應到舊索引（0 常表示新建）
- `moved`：是否偵測到需要移動
- `maxNewIndexSoFar`：判斷是否出現逆序

這些結構一起決定：

- 哪些節點可重用
- 哪些要刪除
- 哪些要插入
- 哪些要移動

---

## 5.6 LIS 在這裡到底做什麼

關鍵目標不是「找全部順序」，而是：

- 在需要 move 的節點中，找出「已經相對遞增」的一組
- 這組可以不動
- 其餘節點才需要移動

所以 LIS 幫的是：**最小化 DOM move 次數**。

---

## 5.7 一個手算案例（建議你自己再算一次）

假設中段經映射後得到：

```text
newIndexToOldIndexMap = [5, 3, 4, 0]
```

含義（簡化）：

- 新位置 0 對應舊索引 5
- 新位置 1 對應舊索引 3
- 新位置 2 對應舊索引 4
- 新位置 3 是新節點（0）

對非 0 部分做 LIS：

- 序列 5,3,4 的 LIS 可能是 3,4（長度 2）
- 代表對應節點可保持不動
- 其餘節點需要 move，0 則需要 insert

---

## 5.8 為什麼 Vue 會倒序遍歷插入/移動

在實作中常看到從尾到頭處理中段，原因是：

- 容易拿到穩定 anchor（下一個已存在節點）
- 可以在不破壞尚未處理節點參考的前提下完成 insert/move

這是實作細節但很關鍵，常直接影響你讀程式時是否看得懂。

---

## 5.9 `patchFlag` 與 diff 的關係

編譯器會提供 patch flag 協助 runtime 走更快路徑，例如：

- 只更新 text
- 只更新 class/style/部分 props
- dynamic children 已知，可跳過某些全量比較

所以 diff 表現不只取決於 runtime 演算法，還受編譯輸出品質影響。

---

## 5.10 常見錯誤案例

### 錯誤一：用 index 當 key

在 reorder 場景會造成狀態錯位。  
列表可插刪改排序時，請使用穩定且唯一的資料 ID。

### 錯誤二：key 重複

會破壞映射唯一性，導致不可預期 patch 行為與警告。

### 錯誤三：誤認「有 key 就一定最省」

key 是必要條件之一，但節點結構頻繁改變、過度重建或不合理模板仍會拖慢更新。

---

## 5.11 本章源碼閱讀建議路徑

建議函式順序：

1. `patchChildren`
2. `patchKeyedChildren`
3. `unmount` / `mountChildren`
4. `getSequence`（LIS）
5. 與移動相關的 host insert / move 操作呼叫點

讀的時候只做兩件事：

- 追 index 變數（`i`, `e1`, `e2`, `s1`, `s2`）含義
- 追每個分支是「patch / remove / insert / move」哪一種

---

## 5.12 練習題（強烈建議手算）

請手算下列 old/new，寫出每步操作：

### 題目 A

```text
old: [a, b, c, d]
new: [b, a, d, c]
```

### 題目 B

```text
old: [a, b, c, d, e]
new: [a, c, b, e, f]
```

要求：

- 標出頭尾同步區
- 中段建立 key map
- 列出 remove / insert / move
- 若有 LIS，標出保留不動節點

> 提示：每一步都先問自己「落在 5.4 的哪個分支」——①頭部同步 ②尾部同步 ③新增（掛載）④卸載 ⑤亂序（key map + `newIndexToOldIndexMap` + LIS）。兩題應該都能對得上這 5 個分支。

---

## 5.13 本章作業

### 必做

- 用圖解方式講解一次 `patchKeyedChildren` 的 5 個分支流程（見 5.4）
- 自己寫一個簡化版 keyed diff（不一定要完整 LIS）
- 對同一組資料比較「有 key vs 無 key」更新差異

### 加分

- 補上簡化 LIS 函式並輸出 move 數量
- 在 demo 中記錄真實 DOM 操作次數

### 驗收標準

- 能解釋 LIS 為何能減少移動次數
- 能辨識中段哪些節點是重用、哪些是新建/刪除
- 能說出為何倒序處理更好插入

---

## 5.14 下一章預告

下一章會切到編譯器：  
你會看到 template 如何經過 `parse -> transform -> codegen` 變成 render function。
