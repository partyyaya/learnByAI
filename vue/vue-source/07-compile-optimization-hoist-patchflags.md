# 第 07 章：編譯最佳化（hoist / block tree / patch flags）

## 7.1 本章目標

這章要回答一個核心問題：  
「Vue 為什麼在更新時可以很快？」

重點在三個編譯產物：

1. static hoist（靜態提升）
2. block tree（動態子節點收斂）
3. patch flags（精準更新提示）

你要能把它們和 runtime 行為一一對上。

---

## 7.2 static hoist：把不會變的提到外面

### 問題背景

若每次 render 都重新建立相同靜態 vnode，會產生不必要配置與比較成本。

### 核心做法

編譯器把可判定為靜態的節點提到 render 外層，生成 hoisted 常量。

概念示意：

```ts
const _hoisted_1 = /*#__PURE__*/ _createElementVNode("h1", null, "Title", -1);

function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", null, [
    _hoisted_1,
    _createElementVNode("span", null, _toDisplayString(_ctx.msg), 1)
  ]))
}
```

結果：靜態節點只建立一次。

---

## 7.3 什麼節點不能 hoist

常見不能 hoist 的情況：

- 含動態綁定（`:class`、`:style`、`:prop`）
- 含事件且依賴上下文變化
- 含 `v-if` / `v-for` 等控制流
- slot 內容需依執行上下文決定

你可以把 hoist 視為「安全前提下的靜態常量提取」。

---

## 7.4 block tree：只追動態 children

Vue 3 重要優化之一是 block tree。  
目標：讓更新時不必每次全量深度走訪全部子節點。

### 核心概念

- 編譯器在動態邊界建立 block
- block 內記錄 dynamic children
- runtime 更新時優先 patch 動態集合

簡化理解：

```text
普通樹：每次更新都可能全走訪
block 樹：直接拿 dynamicChildren 做重點更新
```

---

## 7.5 patch flags：告訴 runtime「只改哪裡」

patch flag 是編譯期給 runtime 的提示位元。  
常見語義（概念層）：

| 類別 | 代表意義 |
|---|---|
| TEXT | 只有文字內容動態 |
| CLASS / STYLE | 只有 class/style 變化 |
| PROPS | 部分 props 動態 |
| FULL_PROPS | 需較完整 props 比對 |
| HYDRATE_EVENTS | 水合階段事件處理相關 |
| STABLE/KEYED/UNKEYED_FRAGMENT | fragment 更新策略提示 |

> 具體常數值可在 `shared` 常數中查，不建議硬背數字。

---

## 7.6 對照案例：沒有提示 vs 有提示

### 無 patch flag 心態

runtime 需要做較廣泛比對，保守且昂貴。

### 有 patch flag 心態

runtime 可直接走「只更新文字」或「只更新 class」等窄路徑。

這就是編譯期資訊前置的價值。

---

## 7.7 block 與 patch flag 的互補

- patch flag 解決「這個節點哪裡動」
- block tree 解決「整棵樹哪些節點需要看」

兩者結合，才是 Vue 3 更新性能的主力方案。  
只理解其中一個，你會對更新成本判斷失真。

---

## 7.8 如何在實務中驗證這些優化

你可以用下面方法自我驗證：

1. 準備同等 UI 的兩種模板（動態點多 vs 少）
2. 檢查編譯輸出中的 hoisted 節點數量與 patch flag
3. 在更新熱路徑記錄 patch 次數與耗時
4. 比較是否出現顯著差異

---

## 7.9 與手寫 render function 的關係

若你手寫 render function，理論上可自己做優化，但：

- 成本高
- 易出錯
- 失去編譯器自動優化收益

因此多數情況仍建議使用模板 + 編譯器輸出。

---

## 7.10 常見誤區

### 誤區一：以為 patch flag 越多越快

不是越多越快，而是「正確且精準」才快。  
錯誤或保守標記可能導致不必要比較。

### 誤區二：把 hoist 視為萬能

hoist 只優化靜態部分，動態密集場景仍主要靠 scheduler 與 diff。

### 誤區三：忽略 template 寫法對編譯輸出的影響

同功能不同寫法，編譯結果可能差很多，進而影響 runtime 成本。

---

## 7.11 本章源碼閱讀建議路徑

建議追這些點：

1. transform 階段的 hoist 決策
2. block 建立與 dynamicChildren 收集流程
3. patch flag 生成點（元素/fragment/指令場景）
4. runtime 中如何利用 patch flag 與 block 走快路徑

---

## 7.12 本章作業

### 必做

- 找 3 段模板，對照編譯輸出標出：
  - 哪些被 hoist
  - 哪些有 patch flag
  - 是否形成 block/dynamicChildren
- 對其中 1 段做改寫，觀察輸出差異

### 加分

- 寫一份「模板寫法優化清單」（至少 8 條）
- 製作一個小 benchmark 比較改寫前後更新成本

### 驗收標準

- 能解釋 hoist、block tree、patch flag 的分工
- 能從 render code 判斷一段模板可能的更新成本
- 能提出至少 2 條可落地的模板優化建議

---

## 7.13 下一章預告

下一章會進入進階內建能力：  
`Teleport`、`KeepAlive`、`Suspense` 的運作方式與使用邊界。
