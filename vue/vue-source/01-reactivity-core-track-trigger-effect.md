# 第 01 章：Reactivity 核心（`track` / `trigger` / `effect`）

> 目標版本：**Vue 3.5.x**。本章會先用「教學簡化版」建立心智模型，再帶你看 **3.4 reactivity 重寫後**的真實結構——兩者差很多，追原始碼前一定要知道差在哪。

## 1.1 本章目標

這章要把 Vue 響應式的「最小閉環」吃透：

1. 讀取資料時如何收集依賴（`track`）
2. 寫入資料時如何通知更新（`trigger`）
3. effect 如何被建立、執行、排程（`effect`）

完成後你應該能回答：

- 為什麼 `state.count++` 會讓畫面更新？
- 為什麼某些情況 effect 會重複觸發，某些情況不會？
- scheduler 介入時，effect 為何不是立刻重跑？
- 3.4 之後 dep 為什麼從 `Set` 變成「雙向鏈結 + 版本號」？這解決了什麼問題？

---

## 1.2 先建立心智模型

可以把響應式理解成「訂閱-通知系統」：

- **讀取（get）**：把目前正在執行的 effect 訂閱到依賴集合
- **寫入（set）**：通知這個 key 的所有訂閱者重跑

```text
讀取 state.count
  -> track(target=state, key="count")
  -> 把「目前作用中的訂閱者」登記到 count 的 dep

修改 state.count
  -> trigger(target=state, key="count")
  -> 通知 count 的 dep 底下所有訂閱者（立即或交給 scheduler）
```

這個「讀取時收集、寫入時通知」的骨架，從 Vue 3.0 到 3.5 都沒變。變的是**「dep 底下怎麼存訂閱者」的資料結構**——這正是 3.4 重寫的重點。

---

## 1.3 依賴圖的心智模型：`targetMap`

最外層的依賴圖，各版本都一樣：

```ts
// packages/reactivity/src/dep.ts
targetMap: WeakMap<object, Map<PropertyKey, Dep>>
```

可視化：

```text
targetMap (WeakMap)
└─ stateObject -> depsMap (Map)
   ├─ "count" -> dep
   └─ "name"  -> dep
```

### 為什麼最外層用 `WeakMap`？

- key 是目標物件（`reactive` 包起來的原始物件）
- 物件若不再被引用，GC 可以回收，避免依賴圖造成記憶體洩漏

**差異就在最裡層那個 `Dep`**：3.4 之前它實質是一個 `Set<ReactiveEffect>`；3.4 之後它是一個帶版本號、用雙向鏈結串起訂閱者的物件。下一節先講重寫後的真實樣貌，之後的 mini 版再用簡化的 `Set` 幫你建立直覺。

---

## 1.3.1 Vue 3.4 reactivity 重寫：從 `Set` 到 `Link` 雙向鏈結

> 這是全章最重要的一節。你在網路上看到的舊教學（含本課早期版本）大多停在 `dep = Set<effect>` 的模型，那是 **3.4 之前**的實作。3.4 把整個 reactivity 重寫（受 Preact signals 啟發），追原始碼會看到完全不同的東西。

### 三個核心角色

| 角色 | 是什麼 | 關鍵欄位 | 原始碼 |
|------|--------|----------|--------|
| `Dep` | 一個響應式來源（某個 key、或一個 ref/computed） | `version`、`subs`（訂閱者鏈結的尾端）、`activeLink` | `dep.ts` |
| `Subscriber` | 訂閱者（effect 或 computed 都算） | `deps`/`depsTail`（依賴鏈結的頭尾）、`flags`（位元旗標） | `effect.ts` |
| `Link` | dep 與 subscriber 之間「一條連線」 | `dep`、`sub`、`version`、`nextDep/prevDep`、`nextSub/prevSub` | `dep.ts` |

關鍵在 `Link`：**它同時掛在兩條鏈結上**——

- 沿著 `nextSub`/`prevSub`，它是「某個 dep 的所有訂閱者」串列的一環；
- 沿著 `nextDep`/`prevDep`，它是「某個 subscriber 的所有依賴」串列的一環。

```text
dep(count).subs ──prevSub──> Link ──prevSub──> Link
                              │                  │
                          (同一個 Link)      (同一個 Link)
                              │                  │
effectA.deps ──nextDep──────>┘                  │
effectB.deps ──nextDep─────────────────────────>┘
```

用鏈結取代 `Set` 的好處：**新增/移除訂閱是 O(1) 指標操作、可重用節點、不需要每次重建集合**，這是 3.4 效能提升的主因之一。

### 版本號：`dep.version` 與 `globalVersion`

3.4 引入兩個版本計數：

- 每個 `Dep` 有 `version`，**只有值真的變（`hasChanged`）才 `version++`**；
- 模組級 `globalVersion`，任何 trigger 都會 `globalVersion++`。

版本號是 computed 能「便宜地判斷要不要重算」的關鍵（第 02 章詳述）：computed 記住自己上次算完時看到的各 dep version 與 globalVersion，下次被讀時先比對版本，沒變就直接回快取，連依賴都不用逐一走訪。

### `track`：建立 / 重用 Link

讀取時走 `dep.track()`：若有 `activeSub` 且正在追蹤，就在這個 dep 與 activeSub 之間**建立或重用**一條 `Link`（把 `link.version` 設為 `dep.version`），並掛進兩條鏈結。

### `trigger`：bump 版本 + 批次通知

寫入時走 `dep.trigger()`：

```text
dep.trigger()
  -> dep.version++；globalVersion++
  -> dep.notify()  // 走訪 subs 鏈結，對每個 subscriber 設 flags(DIRTY/NOTIFIED)、排入批次
```

注意這裡**不是**「複製 Set 然後逐一 `run()`」。3.4 改用**批次（batch）**：`startBatch()` / `endBatch()` 包住整段通知，subscriber 先被標記並排進 `batchedSub` 串列，等 `endBatch()` 時才統一觸發（run 或交給 scheduler）。這樣一次寫入引發的多個通知能被合併、也避免重入問題。

### 重跑 effect 時如何清掉過期依賴：`prepareDeps` / `cleanupDeps`

3.4 之前用 dep 上的 `w`/`n` bitmask 做「本輪有沒有被再次讀到」的標記；3.4 改成更直接的版本標記：

```text
effect.run()：
  1. prepareDeps：把自己現有每條 link 的 version 標成 -1（假設都過期）
  2. 執行 fn：這輪真的被讀到的 dep，track 時會把對應 link.version 更新回 dep.version
  3. cleanupDeps：掃一遍 link，version 仍是 -1 的（這輪沒讀到）就從兩條鏈結移除
```

這就是「動態分支 effect 為何不會殘留過期依賴」的機制。

### 術語對照（追原始碼必看）

| 舊教學 / 3.4 前 | 3.4+ 原始碼 | 說明 |
|------|------|------|
| `activeEffect` | **`activeSub`** | 型別是 `Subscriber`，同時涵蓋 effect 與 computed |
| `dep = Set<ReactiveEffect>` | `Dep` + `Link` 雙向鏈結 | 見上 |
| effect stack | 區域變數存/還原 `activeSub`（+`link.prevActiveLink`） | 見 1.9 |
| `_dirty` 布林 | `dep.version` / `globalVersion` 版本比對 | 見第 02 章 |

> 你 grep 原始碼時，找 `activeEffect` 會找不到——要找 `activeSub`、`class Dep`、`class Link`、`class ReactiveEffect`（都在 `packages/reactivity/src/`）。

---

## 1.4 `effect`：響應式執行單位（教學簡化版）

> ⚠️ 下面到 1.6 的 mini 版刻意用 `Set` + `activeEffect`，是為了讓你先抓到「track/trigger 的骨架」。真實 3.4+ 結構請對照 1.3.1。

`effect(fn)` 可以理解為：

- 先把 `fn` 包成 `ReactiveEffect`
- 執行 `fn` 時，把它設成當前作用中的訂閱者
- `fn` 內所有 reactive 讀取都會把這個 effect 收集進 dep

```ts
// 教學簡化版：真實原始碼用 activeSub 與 flags，見 1.3.1
let activeEffect: ReactiveEffect | undefined;

class ReactiveEffect {
  constructor(public fn: () => any, public scheduler?: () => void) {}

  run() {
    const prev = activeEffect; // 用區域變數存上一層，回來時還原（見 1.9）
    activeEffect = this;
    try {
      return this.fn();
    } finally {
      activeEffect = prev;
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

## 1.5 `track`：在讀取時收集依賴（教學簡化版）

當 proxy `get` 被觸發時，會走 `track(target, key)`。

關鍵流程：

1. 沒有作用中的訂閱者就不追蹤（例如一般函式讀取）
2. 取得 `target -> key -> dep`
3. 把當前訂閱者登記進 dep

```ts
// 教學簡化版
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

> 真實 3.4+：`depsMap.get(key)` 拿到的是 `Dep` 物件，`track` 是 `dep.track()` 去建立/重用 `Link`，不是 `Set.add`。

---

## 1.6 `trigger`：在寫入時觸發依賴（教學簡化版）

當 proxy `set` 被觸發時，會走 `trigger(target, key)`。

```ts
// 教學簡化版
function trigger(target: object, key: PropertyKey) {
  const depsMap = targetMap.get(target);
  if (!depsMap) return;

  const dep = depsMap.get(key);
  if (!dep) return;

  const effectsToRun = new Set(dep); // 複製避免邊跑邊改
  effectsToRun.forEach((effect) => {
    if (effect.scheduler) {
      effect.scheduler();
    } else {
      effect.run();
    }
  });
}
```

> 真實 3.4+：是 `dep.trigger()` → `dep.version++`、`globalVersion++` → `dep.notify()`，並在 `startBatch()/endBatch()` 內批次執行；不是複製 `Set` 逐一 run。對照 1.3.1。

---

## 1.7 `reactive` 與 `ref` 的差異

| 項目 | `reactive` | `ref` |
|---|---|---|
| 適用資料 | 物件/陣列 | 基本型別與單值包裝 |
| 存取方式 | `state.count` | `count.value` |
| 實作核心 | `Proxy` | 帶 getter/setter 的 `RefImpl` |
| 收集依賴 | proxy `get` → 該 key 的 `Dep.track()` | 讀 `.value` → ref 自己那個 `Dep.track()` |
| 解包規則 | template / 特定場景自動解包 | script 中一般需 `.value` |

### 一句話理解

- `reactive`：攔截整個物件屬性存取（`Proxy`）
- `ref`：一個持有 `dep` 的物件，讀 `.value` 時 track、寫 `.value` 且值有變時 trigger

---

## 1.8 `ref` / `reactive` 家族全景

source-reading 常被追問「這些 API 差在哪、機制是什麼」。一次列清楚（都在 `packages/reactivity/src/`）：

### ref 家族（`ref.ts`）

| API | 機制 | 用途 |
|-----|------|------|
| `ref(v)` | `RefImpl`，內含一個 `Dep`；物件值會被 `toReactive` 轉成 `reactive` | 一般單值 |
| `shallowRef(v)` | 同上但**不**深層轉換，只有 `.value` 整個換掉才 trigger | 大型物件/第三方實例，避免深層代理成本 |
| `triggerRef(ref)` | 手動觸發 shallowRef 的依賴 | 你就地改了 shallowRef 內部、想強制通知 |
| `customRef(factory)` | 你自己拿到 `track`/`trigger` 手動控制何時收集/通知 | debounce ref、與外部狀態橋接 |
| `toRef(obj, key)` | 建立一個「指向 reactive 某屬性」的 ref（讀寫都轉發回原物件） | 把 reactive 的單一屬性當 ref 傳遞 |
| `toRefs(obj)` | 把 reactive 每個屬性都做成 `toRef` | 解構 reactive 又不失響應式 |
| `unref(v)` | `isRef(v) ? v.value : v` | 相容 ref 與純值 |

### reactive 家族（`reactive.ts`）

| API | 機制 | 用途 |
|-----|------|------|
| `reactive(obj)` | `Proxy` + `mutableHandlers`，結果快取在 `reactiveMap` | 深層響應式物件 |
| `shallowReactive(obj)` | 只代理第一層 | 只想追蹤頂層屬性 |
| `readonly(obj)` | `Proxy` + `readonlyHandlers`，寫入時警告、不 track | 對外暴露不可改的狀態 |
| `shallowReadonly(obj)` | 只第一層唯讀 | props 之類 |
| `toRaw(proxy)` | 讀 `ReactiveFlags.RAW` 取回原始物件 | 拿原始物件、跳過響應式 |
| `markRaw(obj)` | 打上 `ReactiveFlags.SKIP`，永不被代理 | 第三方實例、不該響應式的大物件 |
| `isReactive`/`isReadonly`/`isProxy` | 讀對應 `ReactiveFlags` | 判斷 |

> `ReactiveFlags`（`IS_REACTIVE` / `IS_READONLY` / `RAW` / `SKIP`）是這套判斷的關鍵 enum，get handler 會先攔這些特殊 key。

`customRef` 值得手寫一次，因為它把 `track`/`trigger` 直接交到你手上，最能驗證你懂了依賴收集：

```ts
import { customRef } from "vue";

function useDebouncedRef(value, delay = 300) {
  let timer;
  return customRef((track, trigger) => ({
    get() {
      track(); // 讀時收集依賴
      return value;
    },
    set(newValue) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        value = newValue;
        trigger(); // 延遲後才通知
      }, delay);
    },
  }));
}
```

---

## 1.9 你要特別注意的兩個機制

### A. effect 嵌套：不是 stack，而是「存/還原 activeSub」

當 effect 中又執行了另一個 effect，作用中的訂閱者不能被覆蓋錯亂。

- **3.2 之前**用一個 effect stack（陣列）push/pop；
- **3.2 起移除 stack**，改用 `effect.parent` 記住上一層；
- **3.4 起**再簡化為：`run()` 時用**區域變數**存住上一個 `activeSub`（及 `shouldTrack`、`link.prevActiveLink`），`finally` 時還原。

所以「Vue 用 stack 管理 activeEffect」是過時說法——1.4 的 mini 版已改用區域變數 `prev` 還原，就是對齊這個真實做法。

### B. cleanup（避免過期依賴）

如果 effect 每次執行的分支不同，舊分支依賴要清掉，不然會殘留無效訂閱。真實機制就是 1.3.1 的 `prepareDeps`（標 version = -1）→ 執行 → `cleanupDeps`（移除沒被重新讀到的 link）。這點在 `watchEffect` 與條件分支中非常重要。

---

## 1.10 入口在哪：`baseHandlers` 與 `collectionHandlers`

前面把 `track`/`trigger` 講得很抽象，但你追原始碼時要知道「它們實際上是被誰呼叫的」——答案是 proxy handlers，不是散落各處：

### 一般物件/陣列：`baseHandlers.ts`

`reactive(obj)` 用的 `mutableHandlers` 定義了這些 trap，才是真正呼叫 track/trigger 的地方：

| trap | 動作 | 觸發 |
|------|------|------|
| `get` | 讀屬性、先攔 `ReactiveFlags`、對巢狀物件延遲代理 | `track(target, key)` |
| `set` | 寫屬性、判斷是新增(ADD)還是修改(SET) | `trigger`（值有變才觸發） |
| `deleteProperty` | 刪屬性 | `trigger`（DELETE） |
| `has` | `in` 運算 | `track` |
| `ownKeys` | `Object.keys`/迭代 | `track(target, ITERATE_KEY)` |

重點：

- **`TriggerOpTypes`**（`ADD` / `DELETE` / `SET` / `CLEAR`）決定要不要順帶觸發**迭代依賴**——例如新增/刪除一個 key 會影響 `Object.keys`、`v-for`，所以 ADD/DELETE 會 trigger `ITERATE_KEY`。
- **陣列**特別處理：`length` 有自己的 dep；`push`/`pop`/`splice` 等會改 length 的方法、以及 `includes`/`indexOf`/`lastIndexOf` 這類「依賴每個索引」的方法，都被 array instrumentation 特別包裝過（否則會漏 track 或無限迴圈）。

### Map / Set：`collectionHandlers.ts`

`Map`/`Set`/`WeakMap`/`WeakSet` 沒有一般屬性存取，是靠 `get`/`set`/`add`/`delete`/`has`/`forEach`/`size` 等**方法**運作，所以 Vue 另用 `collectionHandlers` 把這些方法換成會 track/trigger 的版本（例如讀 `size`、`forEach` 會 track `ITERATE_KEY`；`add`/`delete` 會 trigger）。

> 追響應式問題時的定位口訣：**「值怎麼被讀/寫」→ 找對應 handler（baseHandlers 或 collectionHandlers）→ 看它呼叫哪個 track/trigger**。

---

## 1.11 `effectScope`：元件卸載為何能自動清依賴

一個常見疑問：元件裡寫了一堆 `watch`/`computed`/`watchEffect`，卸載時怎麼一次全部停掉？答案是 `EffectScope`（3.2 引入，`effectScope.ts`）。

```ts
import { effectScope, onScopeDispose, ref, watchEffect } from "vue";

const scope = effectScope();

scope.run(() => {
  const count = ref(0);
  watchEffect(() => console.log(count.value)); // 這個 effect 被收進 scope
  onScopeDispose(() => console.log("scope 被清理了")); // 清理鉤子
});

// 一次停掉 scope 內所有 effect / computed / watch
scope.stop();
```

機制：

- `EffectScope` 會收集在它 `run()` 期間建立的所有 effect（含 computed/watch）與子 scope。
- `scope.stop()` 會停掉全部並呼叫所有 `onScopeDispose` 回呼。

**與元件的關係（連到第 04 章）**：每個元件實例在 setup 前會建立 `instance.scope = new EffectScope(true)`，`setup()` 內建立的響應式副作用（包含元件的 render effect）都掛進這個 scope；元件 unmount 時呼叫 `scope.stop()`，就把整包依賴與副作用清乾淨——這就是「不用手動清 watch」的底層原因。

`getCurrentScope()` / `onScopeDispose()` 也讓你能在 composable 裡掛清理邏輯，而不必依賴元件生命週期 hook。

---

## 1.12 Mini 版練習（建議你真的手寫）

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

### 進階（對齊 3.4）

有餘力的話，把 mini 版的 `Set` 換成「dep.version + 一個 subscribers 陣列」，讓 `trigger` 改成「bump version 後通知」，體會版本號模型；再加一個 `cleanupDeps`（每次 run 前標記、run 後移除沒讀到的依賴）驗證分支清理。

---

## 1.13 常見誤區

### 誤區一：以為 `track` 在 `set` 時做

錯，`track` 是在 **讀取** 時做，因為你只有在被讀時才知道誰依賴它。

### 誤區二：忽略 scheduler，直接同步重跑

同步重跑在真實 UI 更新會產生大量重複運算。scheduler 的目的就是「合併與控制時機」，第 02 章會完整處理。

### 誤區三：不清理舊依賴

動態分支 effect 若不 cleanup，會導致「沒有讀到的 key 也會觸發」。3.4 用 `prepareDeps`/`cleanupDeps` 處理（見 1.3.1 / 1.9）。

### 誤區四：拿 3.4 前的 `Set` 模型去追 3.5 原始碼

你會找不到 `activeEffect`、找不到 `Set` 的 dep。務必用 1.3.1 的術語對照表（`activeSub`、`Dep`、`Link`、版本號）。

---

## 1.14 本章作業

### 必做

- 手寫 mini-reactivity（`reactive + effect + track + trigger`）
- 做一個分支案例驗證 cleanup 的必要性
- 繪製一張 `get/set` -> `track/trigger` -> `effect` 的時序圖

### 加分

- 用 `customRef` 實作 debounce ref（見 1.8）
- 在 vuejs/core 原始碼 grep `class Dep`、`class Link`、`activeSub`、`globalVersion`，各找到定義處並讀一遍
- 用 `effectScope` 寫一個「一次停掉多個 watch」的小範例

### 驗收標準

- 能正確解釋作用中訂閱者（`activeSub`）的作用
- 能說明 `targetMap` 為何是三層結構，最裡層 3.4 前後差在哪
- 能展示一個 scheduler 鉤子被呼叫但 effect 未立即執行的案例
- 能講出 `dep.version` / `globalVersion` 是為了解決什麼

---

## 1.15 下一章預告

下一章會在本章基礎上延伸到：

- `computed`：如何 lazy 計算 + **版本化髒判定**（3.4：用 `dep.version`/`globalVersion` 比對，且重算後值沒變不觸發下游）
- `watch`：如何精準監聽來源並處理 cleanup（含 3.5 的 `onWatcherCleanup`、`WatchHandle`，以及 watch 核心在 3.5 搬到 `@vue/reactivity`）
- scheduler：如何用 job queue 與 `SchedulerJobFlags` 控制 flush 順序與時機
