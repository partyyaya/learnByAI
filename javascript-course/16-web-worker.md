# 16 — Web Worker：把吃力的運算移到背景執行緒

> `async/await` 解決的是「等待」，Worker 解決的是「計算」。自己在燒 CPU 時，只有另一條執行緒能讓畫面不卡。

[第 10 章](10-event-loop.md)說過，瀏覽器的主執行緒同時負責執行 JavaScript、處理使用者互動、計算版面與繪製畫面。這一章處理第 10 章留下的問題：一段計算本身就要跑好幾秒時，怎麼讓頁面在這段時間裡仍然能點、能捲、能動。

前置：[第 11 章](11-promise-and-async-await.md)的 Promise，本章會把 Worker 的訊息往返包成 Promise；[第 9 章](09-modules.md)的 ES Modules。範例要透過本機伺服器開啟（[0.4 節](00-course-map-and-runtime.md#04-範例怎麼執行)），直接開 `file://` 的頁面無法建立 Worker。

## 16.1 為什麼需要 Web Worker

在主執行緒跑一段很耗時的運算（解析 50MB 的 CSV、加密一張大圖、跑一個重量級迴圈），這段時間主執行緒被佔滿，沒辦法回應點擊，也沒辦法重繪畫面，整個頁面就凍結了。

```text
只有主執行緒（會卡）
  主執行緒：[───── 跑 3 秒的大運算 ─────] 處理點擊  重繪
            ↑ 這 3 秒內，點擊沒反應、畫面凍結

主執行緒 + Web Worker（不卡）
  主執行緒：處理點擊  重繪  處理點擊  重繪  接收結果
  Worker  ：        [───── 跑 3 秒的大運算 ─────]
            ↑ 大運算在另一條執行緒跑，UI 全程順暢
```

Web Worker 開一條**獨立的背景執行緒**來跑耗時運算，主執行緒專心處理 UI。

## 16.2 三種 Worker

「Web Worker」其實是一個家族，瀏覽器提供三種：

| 種類 | 用途 | 生命週期 | 本章 |
|------|------|----------|------|
| **Dedicated Worker**（專用） | 把耗時運算丟到背景，只服務建立它的那個頁面 | 跟著建立它的頁面 | 主角 |
| **Shared Worker**（共享） | 多個分頁、iframe 共用同一個 Worker | 所有連線的分頁都關閉才結束 | 16.9 節簡述 |
| **Service Worker** | 攔截網路請求、離線快取、推播 | 獨立於頁面，可被事件喚醒 | 不涵蓋，屬於 PWA 主題 |

三者都跑在背景執行緒，但目的完全不同。本章講的是最常用、用來分擔運算的 Dedicated Worker。

## 16.3 什麼情境該用

判斷準則：**這段程式會不會佔住主執行緒，久到讓畫面卡頓？** 會，就考慮放進 Worker。

### 適合的情境

- **大量資料解析與轉換**：解析超大 JSON／CSV／XML，對幾十萬筆資料做欄位轉換、排序、篩選。
- **影像與影音處理**：濾鏡、縮圖、像素級運算、影像加解密、QR Code 產生與辨識。
- **加解密與雜湊**：大檔案的 AES 加密、SHA 雜湊、壓縮與解壓縮。
- **複雜數值運算**：物理模擬、3D 幾何、地圖路徑計算、部分機器學習推論。
- **WebAssembly 重運算**：把 WASM 模組放進 Worker 跑，避免阻塞 UI。

### 不適合的情境

- **要操作 DOM**：Worker 碰不到 DOM，沒有 `window`、`document`，畫面更新只能回主執行緒做。
- **運算很輕**：幾毫秒就跑完的工作，放進 Worker 反而被「建立 Worker、傳資料」的成本拖累。
- **超高頻、超小的訊息往返**：每秒上千次 `postMessage` 傳小資料，複製與排程的成本會吃掉好處。
- **只是想要非同步**：`setTimeout`、Promise、`async/await` 能讓程式不阻塞地**排程**，但仍在主執行緒上跑。

### `async/await` 不等於多執行緒

```text
async/await／Promise（同一條執行緒）
  把工作排到稍後做，但還是主執行緒在做。
  → 適合等待 I/O（API、檔案），等待時主執行緒可以做別的事。
  → 純 CPU 大運算包成 async 一樣會卡，因為運算本身還在主執行緒。

Web Worker（另一條執行緒）
  工作真的搬到另一條執行緒同時進行。
  → 適合純 CPU 大運算，主執行緒不受影響。
```

一句話分辨：**等待網路、檔案用 `async/await`；自己在燒 CPU 用 Web Worker。** [10.6 節](10-event-loop.md#106-長任務會卡住畫面)的實驗可以親眼看到這個差別。

## 16.4 Worker 的限制與通訊方式

### Worker 裡有什麼、沒什麼

Worker 跑在一個獨立的全域環境，全域物件是 `self`，不是 `window`。

| 可以用 | 不能用 |
|--------|--------|
| `self`、`postMessage`、`onmessage` | `window`、`document`、`parent` |
| `fetch`、`XMLHttpRequest`、`WebSocket` | 任何 DOM 操作（`document.querySelector`……） |
| `setTimeout`／`setInterval` | `alert`、`confirm` |
| `IndexedDB`、Cache API | `localStorage`、`sessionStorage` |
| `importScripts()`、`import`（module worker） | 直接更新畫面 |
| `WebAssembly`、`crypto.subtle` | |

Worker 不能直接改畫面。流程一定是：主執行緒把資料送給 Worker → Worker 算完 → 把結果 `postMessage` 回主執行緒 → **主執行緒**更新 DOM。

### 通訊：`postMessage`／`onmessage` 與結構化複製

主執行緒和 Worker 預設**不共享記憶體**，靠互相傳訊息溝通：

```text
主執行緒  ──  worker.postMessage(資料)   ──▶  Worker（onmessage 收到）
主執行緒  ◀──  self.postMessage(結果)     ──   Worker
```

傳遞的資料會經過**結構化複製**（structured clone）：做一份深拷貝送過去，兩邊各有一份、互不影響。這和 [4.6 節](04-objects-and-arrays.md#46-複製淺拷貝與-structuredclone)的 `structuredClone()` 是同一套演算法。

- 可以傳：物件、陣列、字串、數字、`Date`、`Map`、`Set`、`ArrayBuffer`、`Blob`、`File`、`ImageData`……
- 不能傳：函式、DOM 節點。class 實例傳得過去，但到了另一邊只剩一般物件，原型上的方法都不見了。

大物件深拷貝有成本。傳幾 MB 的 `ArrayBuffer` 用複製會很慢，這時改用 Transferable。

### Transferable：轉移所有權，不複製

`ArrayBuffer`、`MessagePort`、`ImageBitmap`、`OffscreenCanvas` 這類物件可以用**轉移**取代複製：把記憶體的所有權直接交給對方，不複製，幾乎瞬間完成。代價是交出去之後，原本那一邊就不能再用了。

```js
const buffer = new ArrayBuffer(64 * 1024 * 1024); // 64MB

// 第二個參數列出要轉移的物件
worker.postMessage({ buffer }, [buffer]);

console.log(buffer.byteLength); // 0，已經轉移，這邊只剩空殼
```

傳大的二進位資料（影像、檔案、音訊）時用 Transferable，差距可以到「毫秒對數百毫秒」的等級。

## 16.5 原生寫法

不需要框架，也不需要打包工具，瀏覽器原生就支援。

### 最小可運作範例

**`worker.js`**（背景執行緒的程式）：

```js
// 跑在背景執行緒，這裡碰不到 DOM
self.onmessage = (e) => {
  const n = e.data; // 收到主執行緒傳來的資料
  let sum = 0;
  for (let i = 0; i < n; i++) sum += i; // 很重的運算
  self.postMessage(sum); // 把結果送回主執行緒
};
```

**`main.js`**（主執行緒）：

```js
// 1. 建立 Worker（路徑相對於「頁面」的位置）
const worker = new Worker("worker.js");

// 2. 監聽 Worker 回傳的結果
worker.onmessage = (e) => {
  console.log("運算結果：", e.data);
  document.getElementById("result").textContent = e.data; // 更新 DOM 在主執行緒做
};

// 3. 把任務丟給 Worker，主執行緒不會卡住
worker.postMessage(1_000_000_000);

console.log("這行先印出來，因為運算在背景跑");
```

原生 `new Worker("worker.js")` 的路徑是**相對於 HTML 頁面**，不是相對於 JS 檔。這是常見的錯誤來源，所以打包工具改用 `new URL(...)` 寫法（見 16.6 節）。

### 雙向通訊：用任務 id 對應結果

真實情境會送很多任務，回應是非同步的，而且不一定照送出的順序回來。要靠 **id 把請求和回應對起來**，並包成 Promise：

**`worker.js`**

```js
self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  let result;
  switch (type) {
    case "sum":
      result = payload.reduce((a, b) => a + b, 0);
      break;
    case "sort":
      result = [...payload].sort((a, b) => a - b);
      break;
    default:
      // 錯誤也帶著 id 回去
      return self.postMessage({ id, error: `未知任務：${type}` });
  }
  self.postMessage({ id, result });
};
```

**`main.js`**：包一個 `runTask()`，呼叫起來像普通的 async 函式。

```js
const worker = new Worker("worker.js");
const pending = new Map(); // id → { resolve, reject }
let seq = 0;

worker.onmessage = (e) => {
  const { id, result, error } = e.data;
  const job = pending.get(id);
  if (!job) return;
  pending.delete(id);
  error ? job.reject(new Error(error)) : job.resolve(result);
};

function runTask(type, payload) {
  const id = ++seq;
  const { promise, resolve, reject } = Promise.withResolvers();
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, payload });
  return promise;
}

// 用起來就像呼叫一般 async 函式
const total = await runTask("sum", [1, 2, 3, 4, 5]); // 15
const sorted = await runTask("sort", [3, 1, 2]); // [1, 2, 3]
```

`Promise.withResolvers()`（[11.6 節](11-promise-and-async-await.md#116-把-callback-api-包成-promisedelay)）讓 `resolve`、`reject` 可以存進 `pending`，等訊息回來時再呼叫。最後兩行用了 top-level await，`main.js` 要用 `<script type="module">` 載入。

### 錯誤處理與終止

```js
// 監聽 Worker 內沒有接住的錯誤
worker.onerror = (e) => {
  console.error(`Worker 錯誤：${e.message}（${e.filename}:${e.lineno}）`);
};

// 用完要關掉，釋放執行緒資源
worker.terminate(); // 由主執行緒強制終止

// 或在 Worker 內部自行結束
// self.close();
```

頁面還開著時，Worker 不會自動結束。單頁應用裡元件反覆建立 Worker 卻不關，執行緒和記憶體會一直累積。用完（或元件卸載時）記得 `terminate()`。

`terminate()` 之後，`pending` 裡還在等的 Promise 永遠不會完成。如果呼叫端可能還在等，終止前先把它們逐一 `reject`。

### Module Worker：在 Worker 裡用 `import`

預設的 classic worker 要載入其他檔案得用 `importScripts()`。現代瀏覽器支援 **module worker**，可以直接用 ES Modules 的 `import`：

```js
// 建立時加上 type: "module"
const worker = new Worker("worker.js", { type: "module" });
```

```js
// worker.js：現在可以用 import 了
import { heavyCalc } from "./math-utils.js";

self.onmessage = (e) => {
  self.postMessage(heavyCalc(e.data));
};
```

使用 Vite、webpack 這類打包工具時，幾乎一律用 `type: "module"`，打包工具才能把 Worker 的依賴一起處理。

## 16.6 在 Vue 3 + Vite 中使用

Vite 內建支援 Web Worker，不用額外設定。重點是讓 Vite 正確打包並載入 Worker 檔。

### Vite 載入 Worker 的兩種寫法

**寫法 A（建議，跨打包工具通用）**：用 `new URL(..., import.meta.url)`。

```js
const worker = new Worker(
  new URL("./heavy.worker.js", import.meta.url),
  { type: "module" },
);
```

`import.meta.url` 是目前模組的網址，`new URL("./heavy.worker.js", import.meta.url)` 算出的是**相對於這個 JS 檔**的路徑，解決了原生寫法相對於頁面的問題。打包工具看到這個寫法，也會把 Worker 檔一起打包、改寫成正確的網址。

**寫法 B（Vite 專屬）**：用 `?worker` 查詢字串，import 進來的是一個建構式。

```js
import HeavyWorker from "./heavy.worker.js?worker";
const worker = new HeavyWorker();

// 想內聯成 base64（不額外發請求）用 ?worker&inline
// import HeavyWorker from "./heavy.worker.js?worker&inline";
```

兩種都可以。寫法 A 在 Vite 和 webpack 5 都能用，可攜性最好，本章統一用它。檔名習慣取 `xxx.worker.js`，方便辨識。

### 封裝成 composable：`useHeavyWorker`

把「建立、通訊、Promise 化、卸載時清理」包成一個可重用的 composable。

**`src/workers/heavy.worker.js`**

```js
// 純運算，完全不碰 Vue 或 DOM
self.onmessage = (e) => {
  const { id, n } = e.data;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sqrt(i);
  self.postMessage({ id, result: sum });
};
```

**`src/composables/useHeavyWorker.js`**

```js
import { onUnmounted } from "vue";

export function useHeavyWorker() {
  const worker = new Worker(
    new URL("../workers/heavy.worker.js", import.meta.url),
    { type: "module" },
  );

  const pending = new Map();
  let seq = 0;

  worker.onmessage = (e) => {
    const { id, result, error } = e.data;
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    error ? job.reject(new Error(error)) : job.resolve(result);
  };

  function compute(n) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, n });
    });
  }

  // 元件卸載時關掉 Worker，避免洩漏
  onUnmounted(() => worker.terminate());

  return { compute };
}
```

**元件 `HeavyDemo.vue`**

```vue
<script setup>
import { ref } from "vue";
import { useHeavyWorker } from "@/composables/useHeavyWorker";

const { compute } = useHeavyWorker();
const result = ref(null);
const loading = ref(false);

async function run() {
  loading.value = true;
  // 運算再重，這行也不會卡住畫面，按鈕、輸入都正常
  result.value = await compute(1_000_000_000);
  loading.value = false;
}
</script>

<template>
  <button :disabled="loading" @click="run">
    {{ loading ? "計算中…（畫面依然順暢）" : "開始大運算" }}
  </button>
  <p v-if="result !== null">結果：{{ result.toFixed(2) }}</p>
</template>
```

把 `compute()` 換成在主執行緒直接跑同樣的迴圈，按鈕在運算期間會完全點不動。用 Worker 後，loading 文字、輸入框全程正常，這就是差別。

### 在 Worker 裡引入第三方套件

module worker 的依賴由 Vite 打包，直接 `import` 即可：

```js
// heavy.worker.js
import { compress } from "some-compression-lib";

self.onmessage = (e) => {
  self.postMessage({ id: e.data.id, result: compress(e.data.payload) });
};
```

## 16.7 在 React 中使用

React 沒有內建 Worker 工具，用 custom hook 封裝最自然。Vite 和 webpack 5 都支援 `new URL(..., import.meta.url)` 寫法。

### 自訂 hook：`useHeavyWorker`

**`src/workers/heavy.worker.js`**：和 16.6 節相同，純運算。

**`src/hooks/useHeavyWorker.js`**

```js
import { useEffect, useRef, useCallback } from "react";

export function useHeavyWorker() {
  const workerRef = useRef(null);
  const pendingRef = useRef(new Map());
  const seqRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/heavy.worker.js", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const job = pendingRef.current.get(id);
      if (!job) return;
      pendingRef.current.delete(id);
      error ? job.reject(new Error(error)) : job.resolve(result);
    };
    workerRef.current = worker;

    // 元件卸載時清理
    return () => worker.terminate();
  }, []);

  const compute = useCallback((n) => {
    const id = ++seqRef.current;
    return new Promise((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      workerRef.current.postMessage({ id, n });
    });
  }, []);

  return { compute };
}
```

### 元件使用

```jsx
import { useState } from "react";
import { useHeavyWorker } from "./hooks/useHeavyWorker";

export default function HeavyDemo() {
  const { compute } = useHeavyWorker();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    // 運算期間，輸入框、其他 state 更新、動畫都照常運作
    const r = await compute(1_000_000_000);
    setResult(r);
    setLoading(false);
  }

  return (
    <div>
      <button disabled={loading} onClick={run}>
        {loading ? "計算中…（畫面依然順暢）" : "開始大運算"}
      </button>
      {result !== null && <p>結果：{result.toFixed(2)}</p>}
    </div>
  );
}
```

React 的嚴格模式（StrictMode）在開發環境會故意 mount → unmount → 再 mount 一次，用來抓出沒有清理的副作用。上面 `useEffect` 的 cleanup（`worker.terminate()`）是必要的，否則開發時會殘留一個 Worker。

## 16.8 用 Comlink 把通訊變成函式呼叫

手寫 `postMessage` 加 id 對應很繁瑣。[Comlink](https://github.com/GoogleChromeLabs/comlink) 用 Proxy 把 Worker 包裝成「像呼叫本地 async 函式一樣」，程式碼乾淨很多。

**`api.worker.js`**

```js
import * as Comlink from "comlink";

const api = {
  sum(arr) {
    return arr.reduce((a, b) => a + b, 0);
  },
  async heavy(n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.sqrt(i);
    return s;
  },
};

Comlink.expose(api);
```

**主執行緒**

```js
import * as Comlink from "comlink";

const worker = new Worker(new URL("./api.worker.js", import.meta.url), { type: "module" });
const api = Comlink.wrap(worker);

// 直接呼叫 Worker 裡的方法，回傳 Promise
const total = await api.sum([1, 2, 3]); // 6
const r = await api.heavy(1_000_000_000); // 在背景算，UI 不卡
```

Comlink 背後做的事和 16.5 節的 `runTask()` 一樣：替每次呼叫配 id、用 `postMessage` 傳過去、把回應對回對應的 Promise。任務種類多、通訊邏輯複雜時，它能省掉這些樣板程式碼。

## 16.9 Shared Worker：多分頁共用

需要多個分頁共用同一份狀態、同一條後端連線（例如多開的後台共用一條 WebSocket）時，用 SharedWorker：

```js
// 主執行緒：透過 port 通訊
const sw = new SharedWorker(new URL("./shared.worker.js", import.meta.url), { type: "module" });
sw.port.start();
sw.port.postMessage("hello");
sw.port.onmessage = (e) => console.log(e.data);
```

```js
// shared.worker.js：每個分頁連進來都會觸發 onconnect
const ports = [];
self.onconnect = (e) => {
  const port = e.ports[0];
  ports.push(port);
  port.onmessage = (ev) => {
    // 廣播給所有連線的分頁
    ports.forEach((p) => p.postMessage(ev.data));
  };
};
```

SharedWorker 的支援度不如 Dedicated Worker：Android 版 Chrome 長期不支援，iOS Safari 從 16 版才支援。採用前先查 [MDN 的相容性表](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker#browser_compatibility)，一般情境用 Dedicated Worker。

## 16.10 常見問題

**Web Worker 和 Service Worker 一樣嗎？**
不一樣。Dedicated Worker 用來分擔 CPU 運算、避免 UI 卡頓；Service Worker 攔截網路請求，做離線快取與推播。兩者都跑在背景，但目的完全不同。

**Worker 裡可以操作 DOM 嗎？**
不行。Worker 沒有 `window` 和 `document`，任何畫面更新都要把結果 `postMessage` 回主執行緒。例外是 `OffscreenCanvas`：可以把一個 canvas 的繪製工作轉移到 Worker。

**傳資料給 Worker 是共享還是複製？**
預設是複製（結構化複製，深拷貝），兩邊各一份。要避免大資料的複製成本，用 Transferable 轉移所有權；或用 `SharedArrayBuffer` 真正共享記憶體，但頁面必須設定 COOP 與 COEP 標頭（跨來源隔離）才能使用。

**開幾個 Worker 比較好？**
不是越多越好。每個 Worker 都是一條真的執行緒，會佔記憶體。常見做法是建一個 Worker Pool，數量參考 `navigator.hardwareConcurrency`（邏輯 CPU 核心數），把任務分配給池子裡的 Worker。

**Worker 載入路徑老是 404？**
原生 `new Worker("worker.js")` 的路徑相對於 HTML 頁面，部署後常因路徑改變而失敗。使用打包工具時，一律寫 `new Worker(new URL("./x.worker.js", import.meta.url), { type: "module" })`，讓打包工具處理路徑。

**Worker 裡能不能發 API 請求？**
可以。`fetch`、`XMLHttpRequest`、`WebSocket` 在 Worker 裡都能用。把「下載大檔 + 解析」整包放進 Worker 是常見的用法。

## 16.11 本章小結

```text
問題    → JavaScript 單執行緒，主執行緒被大運算佔住 → UI 凍結
解法    → 開一條背景執行緒（Dedicated Worker）專跑耗時運算
限制    → 碰不到 DOM，沒有 window／document／localStorage；只能靠訊息溝通
通訊    → postMessage／onmessage（預設深拷貝），大資料用 Transferable 轉移
載入    → 打包環境一律 new Worker(new URL("./x.worker.js", import.meta.url), { type: "module" })
封裝    → 用 id 對應請求與回應並包成 Promise；Vue 用 composable、React 用 custom hook
清理    → 卸載時 terminate()，並處理還在等的 Promise
進階    → 通訊複雜用 Comlink；多分頁共享用 SharedWorker；池化參考 hardwareConcurrency
```

1. **Worker 解決的是 CPU 卡住 UI**：純運算很重才用它，等待 I/O 用 `async/await` 就好。
2. **Worker 碰不到 DOM**：算完一定要把結果送回主執行緒才能更新畫面。
3. **通訊預設是深拷貝**：大資料記得用 Transferable，別讓複製吃掉效能。
4. **用完要關**：框架裡務必在元件卸載時 `terminate()`，否則執行緒與記憶體會累積。

即時通訊放進 Worker 的做法，可以接著看 [WebSocket 即時通訊實戰](../common/websocket.md) 與 [SSE 伺服器推送實戰](../common/sse.md)：長連線的訊息解析也能移到背景執行緒。

下一章：[17 — 記憶體與效能除錯](17-memory-and-performance.md)，用 DevTools 找出畫面卡頓與記憶體持續增加的原因。

---

[上一章：瀏覽器原生 API](15-browser-native-apis.md) · [返回課程總覽](README.md) · [下一章：記憶體與效能除錯](17-memory-and-performance.md)
