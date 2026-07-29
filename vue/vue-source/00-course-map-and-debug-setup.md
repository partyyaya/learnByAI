# 第 00 章：課程地圖與源碼調試準備

## 0.1 本章目標

這一章先做三件事：

1. 建立 Vue 3 源碼的整體地圖（你知道要讀哪些包）
2. 建好可斷點追蹤的環境（你真的能跟著程式跑）
3. 學會一套可重複的閱讀方法（不是看完就忘）

如果這一章沒做好，後面 `computed`、`watch`、scheduler 通常只會停在「名詞理解」，很難形成工程能力。

---

## 0.2 Vue 3 核心包地圖（先看這張）

Vue 3 是 monorepo，核心在 `packages` 下。你先抓這些包就好：

| 套件 | 職責 | 你在哪些章節會重點讀 |
|---|---|---|
| `reactivity` | 響應式系統（`reactive` / `ref` / `effect` / `computed`；3.5 起也含 `watch` 核心） | 01, 02 |
| `runtime-core` | 平台無關的執行核心（組件、scheduler、renderer 核心、`apiWatch` 包裝） | 02, 03, 04, 05 |
| `runtime-dom` | DOM 平台實作（事件、props、平台 API） | 03, 04 |
| `compiler-core` | 模板編譯主流程（parse/transform/codegen） | 06, 07 |
| `compiler-dom` | DOM 相關編譯擴展 | 06, 07 |
| `shared` | 共用工具函式與常數 | 全章節 |
| `vue` | 打包後對外 API 匯出入口 | 入門追路徑時會用到 |

> 版本註記（Vue 3.5.x）：`watch` 的**核心實作在 3.5 已從 `runtime-core` 抽到 `@vue/reactivity`**（`packages/reactivity/src/watch.ts`，即開發期常被稱作 `baseWatch` 的那份邏輯）；`runtime-core/src/apiWatch.ts` 只剩「加上元件生命週期綁定」的包裝層（例如 `flush: 'post'` 接 scheduler、元件卸載時清理 watcher）。所以追 `watch` 別停在 `runtime-core`，真正的依賴收集與觸發邏輯要進 `reactivity`。

---

## 0.3 你要建立的調試能力

只看 markdown 不夠，這門課要求每章都能做到：

- **能定位入口**：例如 `watch()` 的入口在何處
- **能追呼叫鏈**：知道從 API 到底層做了什麼
- **能看資料流**：值怎麼被追蹤、什麼時機被更新
- **能驗證猜測**：加 log / 下斷點確認自己的理解

---

## 0.4 環境準備（建議流程）

> 你可以在本機另開一個 Vue 核心倉庫專門做追蹤，不建議直接在正式專案中亂改核心。

### 1) 取得與安裝

```bash
git clone https://github.com/vuejs/core.git
cd core
pnpm install
```

### 2) 啟動對應 playground / 測試命令

```bash
# 依你習慣選擇：跑測試或跑 playground
pnpm test reactivity
pnpm dev
```

### 3) 建立最小追蹤案例

- 一個 `ref` + `computed`
- 一個 `watch`（分別測 `flush: "pre"` 與 `flush: "post"`）
- 一個會在同一個 tick 內連續修改資料的案例（觀察 scheduler 合併）

---

## 0.5 第一次閱讀不要做的事

- 不要從頭到尾逐行看完整包
- 不要同時追太多功能（例如 `watch` + `component update` + `suspense`）
- 不要只看部落格解說，不跑實際斷點

---

## 0.6 推薦閱讀順序（到第 02 章為止）

```text
先 API 使用層（寫最小案例）
  -> 找入口函式（watch/computed/ref）
  -> 看主鏈上 3~5 個關鍵函式
  -> 只記錄會改變資料流的步驟
  -> 實作 mini 版驗證
```

你目前只要聚焦：

1. `effect` 怎麼收集依賴
2. `trigger` 怎麼通知 effect
3. `computed` 怎麼 lazy + cache
4. `watch` 怎麼透過 scheduler 控制 callback 時機

---

## 0.7 呼叫鏈筆記模板（每章都照這個交）

你可以直接複製這份模板做閱讀筆記：

```md
### 主題：watch flush post 觸發時機

#### 入口
- API:
- 呼叫位置:

#### 主鏈（只留關鍵 5~8 步）
1.
2.
3.

#### 關鍵資料
- activeEffect:
- dep:
- queue:

#### 我驗證過的現象
- [ ] 同 tick 多次 set 只執行一次 job
- [ ] post flush 在 DOM patch 後執行

#### 未理解問題
- Q1:
- Q2:
```

> 版本註記（Vue 3.5.x）：上面「關鍵資料」裡的 `activeEffect`，在 3.4+ 的響應式重構後原始碼已改稱 **`activeSub`**（Subscriber，泛指「訂閱者」，同時涵蓋 `effect` 與 `computed`）。若你照舊教學 grep `activeEffect` 找不到，改找 `activeSub`。

---

## 0.8 本章作業

### 必做

- 建好 Vue core 可執行環境
- 寫 3 個最小案例：`computed`、`watch(pre)`、`watch(post)`
- 每個案例做一次斷點追蹤，寫出「入口 + 主鏈 5 步」

### 驗收標準

- 你能說明「為什麼同一個 tick 內多次修改，watch callback 不會等量觸發」
- 你能畫出一張簡單時序圖：`set state -> queue -> flush -> callback`

---

## 0.9 下一章預告

下一章會先把基礎打穩：`track` / `trigger` / `effect`。  
你只要把第 01 章吃透，第 02 章的 `computed` / `watch` / scheduler 會順很多。
