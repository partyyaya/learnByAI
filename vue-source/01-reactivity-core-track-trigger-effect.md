# 第 01 章：Reactivity 核心（`track` / `trigger` / `effect`）

## 1.1 本章目標

這章要把 Vue 響應式的「最小閉環」吃透：

1. 讀取資料時如何收集依賴（`track`）
2. 寫入資料時如何通知更新（`trigger`）
3. effect 如何被建立、執行、排程（`effect`）

完成後你應該能回答：

- 為什麼 `state.count++` 會讓畫面更新？
- 為什麼某些情況 effect 會重複觸發，某些情況不會？
- scheduler 介入時，effect 為何不是立刻重跑？

---

## 1.2 先建立心智模型

可以把響應式理解成「訂閱-通知系統」：

- **讀取（get）**：把目前正在執行的 effect 訂閱到依賴集合
- **寫入（set）**：通知這個 key 的所有訂閱者重跑

```text
讀取 state.count
  -> track(target=state, key="count")
  -> dep.add(activeEffect)

修改 state.count
  -> trigger(target=state, key="count")
  -> 逐個執行 dep 裡的 effect（或交給 scheduler）
```

---

## 1.3 最關鍵資料結構：`targetMap`

Vue 的核心依賴圖可以抽象成：

```ts
WeakMap<object, Map<PropertyKey, Set<ReactiveEffect>>>
```

可視化：

```text
targetMap (WeakMap)
└─ stateObject -> depsMap (Map)
   ├─ "count" -> dep (Set<effectA, effectB>)
   └─ "name"  -> dep (Set<effectC>)
```

### 為什麼最外層用 `WeakMap`？

- key 是目標物件（`reactive` 包起來的原始物件）
- 物件若不再被引用，GC 可以回收，避免依賴圖造成記憶體洩漏

---

## 1.4 `effect`：反應式執行單位

`effect(fn)` 可以理解為：

- 先把 `fn` 包成 `ReactiveEffect`
- 執行 `fn` 時，把它設成 `activeEffect`
- `fn` 內所有 reactive 讀取都會把這個 effect 收集進 dep

### 最小概念版本

```ts
let activeEffect: ReactiveEffect | undefined;

class ReactiveEffect {
  constructor(public fn: () => any, public scheduler?: () => void) {}

  run() {
    activeEffect = this;
    try {
      return this.fn();
    } finally {
      activeEffect = undefined;
    }
  }
}

function effect(fn: () => any, scheduler?: () => void) {
  const _effect = new ReactiveEffect(fn, scheduler);
  _effect.run();
  return _effect;
}
```

---

## 1.5 `track`：在讀取時收集依賴

當 proxy `get` 被觸發時，會走 `track(target, key)`。

關鍵流程：

1. 沒有 `activeEffect` 就不追蹤（例如一般函式讀取）
2. 取得 `target -> key -> dep` 的那個 Set
3. 把 `activeEffect` 加入 dep

```ts
const targetMap = new WeakMap<object, Map<PropertyKey, Set<ReactiveEffect>>>();

function track(target: object, key: PropertyKey) {
  if (!activeEffect) return;

  let depsMap = targetMap.get(target);
  if (!depsMap) {
    depsMap = new Map();
    targetMap.set(target, depsMap);
  }

  let dep = depsMap.get(key);
  if (!dep) {
    dep = new Set();
    depsMap.set(key, dep);
  }

  dep.add(activeEffect);
}
```

---

## 1.6 `trigger`：在寫入時觸發依賴

當 proxy `set` 被觸發時，會走 `trigger(target, key)`。

關鍵流程：

1. 找出 `targetMap` 中該 key 的 dep
2. 將 dep 複製一份再迭代（避免邊跑邊改集合）
3. 每個 effect：
   - 有 scheduler 就交給 scheduler
   - 沒 scheduler 就直接 `run()`

```ts
function trigger(target: object, key: PropertyKey) {
  const depsMap = targetMap.get(target);
  if (!depsMap) return;

  const dep = depsMap.get(key);
  if (!dep) return;

  const effectsToRun = new Set(dep);
  effectsToRun.forEach((effect) => {
    if (effect.scheduler) {
      effect.scheduler();
    } else {
      effect.run();
    }
  });
}
```

---

## 1.7 `reactive` 與 `ref` 的差異

| 項目 | `reactive` | `ref` |
|---|---|---|
| 適用資料 | 物件/陣列 | 基本型別與單值包裝 |
| 存取方式 | `state.count` | `count.value` |
| 實作核心 | `Proxy` | 帶 getter/setter 的 Ref 物件 |
| 解包規則 | template / 特定場景自動解包 | script 中一般需 `.value` |

### 一句話理解

- `reactive`：攔截整個物件屬性存取
- `ref`：攔截單一 `value` 屬性存取

---

## 1.8 你要特別注意的兩個機制

### A. effect 嵌套與 effect stack

當 effect 中又執行了另一個 effect，`activeEffect` 不能被覆蓋錯亂。  
Vue 實作上會用 stack 管理當前作用中的 effect，回到上一層時要正確恢復。

### B. cleanup（避免過期依賴）

如果 effect 每次執行的分支不同，舊分支依賴要清掉，不然會殘留無效訂閱。  
這點在 `watchEffect` 與條件分支中非常重要。

---

## 1.9 Mini 版練習（建議你真的手寫）

### 需求

- 支援 `reactive`
- 支援 `effect`
- 能在 `get` 時 `track`、在 `set` 時 `trigger`
- 加一個最小 scheduler 參數（先不做 queue）

### 驗證案例

```ts
const state = reactive({ count: 0 });

effect(() => {
  console.log("effect run:", state.count);
});

state.count++; // 預期重新印出
state.count++; // 預期再次印出
```

---

## 1.10 常見誤區

### 誤區一：以為 `track` 在 `set` 時做

錯，`track` 是在 **讀取** 時做，因為你只有在被讀時才知道誰依賴它。

### 誤區二：忽略 scheduler，直接同步重跑

同步重跑在真實 UI 更新會產生大量重複運算。  
scheduler 的目的就是「合併與控制時機」，第 02 章會完整處理。

### 誤區三：不清理舊依賴

動態分支 effect 若不 cleanup，會導致「沒有讀到的 key 也會觸發」。

---

## 1.11 本章作業

### 必做

- 手寫 mini-reactivity（`reactive + effect + track + trigger`）
- 做一個分支案例驗證 cleanup 的必要性
- 繪製一張 `get/set` -> `track/trigger` -> `effect` 的時序圖

### 驗收標準

- 能正確解釋 `activeEffect` 的作用
- 能說明 `targetMap` 為何是三層結構
- 能展示一個 scheduler 鉤子被呼叫但 effect 未立即執行的案例

---

## 1.12 下一章預告

下一章會在本章基礎上延伸到：

- `computed`：如何 lazy 計算 + dirty cache
- `watch`：如何精準監聽來源並處理 cleanup
- scheduler：如何用 job queue 控制 flush 順序與時機
