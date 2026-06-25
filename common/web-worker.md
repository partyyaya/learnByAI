# Web Worker 實戰：把吃力的運算丟到背景執行緒

> 從原理到實作，完整搞懂 Web Worker：為什麼 JS 會卡住、Worker 解決什麼問題、什麼情境該用（與不該用）、通訊與限制，以及在原生 JS、Vue 3 + Vite、React 三種環境下的完整實戰寫法。

---

## 0 開始之前:為什麼需要 Web Worker?

JavaScript 在瀏覽器裡是**單執行緒(single-thread)**的:同一時間只有一條「主執行緒(main thread)」在跑。而這條執行緒**同時負責**:

- 執行你的 JS 邏輯
- 處理使用者互動(點擊、輸入、捲動)
- 計算版面、繪製畫面(渲染)

問題來了:如果你在主執行緒跑一段**很耗時的運算**(例如解析 50MB 的 CSV、加密一張大圖、跑一個重量級迴圈),這段時間裡主執行緒**被佔滿**,沒辦法回應點擊、也沒辦法重繪畫面——**整個頁面就卡死(凍結)**,使用者點什麼都沒反應,滑鼠還可能轉圈圈。

```
只有主執行緒(會卡)
  主執行緒: [───── 跑 3 秒的大運算 ─────] 處理點擊  重繪
            ↑ 這 3 秒內,點擊沒反應、畫面凍結 ❌

主執行緒 + Web Worker(不卡)
  主執行緒: 處理點擊  重繪  處理點擊  重繪  接收結果 ✅
  Worker  :         [───── 跑 3 秒的大運算 ─────]
            ↑ 大運算在背景另一條執行緒跑,UI 全程順暢
```

> 💡 **Web Worker 的核心價值**:開一條**獨立的背景執行緒**來跑耗時運算,讓主執行緒專心處理 UI。運算再重,畫面也不會卡。

---

## 1 Web Worker 是什麼?三種 Worker 一次搞懂

「Web Worker」其實是一個家族,瀏覽器提供三種:

| 種類 | 用途 | 生命週期 | 本篇是否涵蓋 |
|------|------|----------|--------------|
| **Dedicated Worker**(專用) | 把耗時運算丟到背景,**只服務開它的那個分頁** | 跟著建立它的頁面 | ✅ 主角 |
| **Shared Worker**(共享) | 多個分頁 / iframe **共用同一個 Worker**(共享狀態) | 所有連線分頁都關閉才結束 | 🔸 §8 簡述 |
| **Service Worker** | 攔截網路請求、離線快取、推播(PWA 核心) | 獨立於頁面,可被喚醒 | ❌ 屬於 PWA 主題 |

> ⚠️ 三者都跑在背景執行緒,但**目的完全不同**。本篇講的是最常用、用來「分擔運算」的 **Dedicated Worker**。Service Worker 是做離線 / 快取 / 推播的,別搞混。

---

## 2 什麼情境下該用 Web Worker?

判斷準則很簡單:**「這段程式會不會佔住主執行緒久到讓畫面卡頓?」** 會,就考慮丟進 Worker。

### 2.1 ✅ 適合用的情境

- **大量資料解析 / 轉換**:解析超大 JSON / CSV / XML、欄位轉換、排序篩選幾十萬筆資料。
- **影像 / 影音處理**:濾鏡、縮圖、像素級運算、影像加解密、QR Code 產生與辨識。
- **加解密 / 雜湊**:大檔案的 AES 加密、SHA 雜湊、壓縮 / 解壓縮(gzip、zip)。
- **複雜數值運算**:物理模擬、3D 幾何、地圖路徑演算、機器學習推論(部分)。
- **WASM 重運算**:把 WebAssembly 模組放進 Worker 跑,避免阻塞 UI。
- **持續性的背景輪詢 / 計算**:例如一直在背景算進度、跑計時器而不受主執行緒節流影響。

### 2.2 ❌ 不適合用的情境

- **要操作 DOM**:Worker **碰不到 DOM**(沒有 `window`、`document`),畫面更新只能回主執行緒做。
- **運算很輕**:幾毫秒就跑完的東西,丟 Worker 反而被「建立 + 傳資料」的成本拖累,得不償失。
- **超高頻、超小的訊息往返**:每秒上千次 `postMessage` 傳小資料,序列化成本會吃掉好處。
- **只是為了「非同步」**:`setTimeout`、`Promise`、`async/await` 已經能讓程式非阻塞地**排程**,但它們**仍在主執行緒上跑**。Worker 才是真正的「**另一條執行緒平行跑**」。兩者解決的問題不同(見下方對照)。

### 2.3 ⭐ 常見誤解:`async/await` 不等於多執行緒

```
async/await / Promise(同一條執行緒)
  把工作「排到稍後」做,但還是主執行緒在做。
  → 適合等待 I/O(API、檔案),等待時主執行緒可以做別的事。
  → 但若是「純 CPU 大運算」,包成 async 一樣會卡!因為運算本身還在主執行緒。

Web Worker(另一條執行緒)
  工作真的搬到別條執行緒「同時」做。
  → 適合純 CPU 大運算,主執行緒完全不受影響。
```

> 💡 **一句話分辨**:等待網路 / 檔案 → 用 `async/await`;**自己在燒 CPU** → 用 Web Worker。

---

## 3 核心觀念:Worker 的限制與通訊方式

### 3.1 Worker 裡「有什麼、沒什麼」

Worker 跑在一個獨立的全域環境(`self`),**不是** `window`。

| 可以用 ✅ | 不能用 ❌ |
|-----------|-----------|
| `self`、`postMessage`、`onmessage` | `window`、`document`、`parent` |
| `fetch`、`XMLHttpRequest`、`WebSocket` | **任何 DOM 操作**(`document.querySelector`…) |
| `setTimeout` / `setInterval` | `alert`、`localStorage`(部分瀏覽器禁) |
| `IndexedDB`、`Cache API` | 直接更新畫面 |
| `importScripts()`、`import`(module worker) | |
| `WebAssembly`、`crypto`(SubtleCrypto) | |

> ⚠️ Worker **不能直接改畫面**。流程一定是:主執行緒把資料丟給 Worker → Worker 算完 → 把結果 `postMessage` 回主執行緒 → **主執行緒**負責更新 DOM。

### 3.2 通訊:`postMessage` / `onmessage` 與「結構化複製」

主執行緒和 Worker **不共享記憶體**(預設情況),靠互相發訊息溝通:

```
主執行緒  ──  worker.postMessage(資料)   ──▶  Worker (onmessage 收到)
主執行緒  ◀──  self.postMessage(結果)     ──   Worker
```

傳遞的資料會經過 **結構化複製演算法(Structured Clone)**——也就是做一份**深拷貝**送過去,兩邊各有一份、互不影響。

可以傳:物件、陣列、字串、數字、`Date`、`Map`、`Set`、`ArrayBuffer`、`Blob`、`File`、`ImageData`…
**不能傳**:函式、DOM 節點、有原型方法的 class 實例(方法會掉)。

> ⚠️ 大物件深拷貝有成本。傳幾 MB 的 `ArrayBuffer` 用「複製」會很慢——這時要用下面的 **Transferable**。

### 3.3 Transferable Objects:零拷貝「交出所有權」

對 `ArrayBuffer`、`MessagePort`、`ImageBitmap`、`OffscreenCanvas` 這類物件,可以用 **轉移(transfer)** 取代複製:把記憶體的**所有權直接交給對方**,不複製,瞬間完成。代價是:**交出去後,原本那邊就不能再用了**。

```js
const buffer = new ArrayBuffer(64 * 1024 * 1024); // 64MB

// 第二個參數列出要「轉移」的物件
worker.postMessage({ buffer }, [buffer]);

console.log(buffer.byteLength); // 0 ← 已被轉移,這邊變空殼!
```

> 💡 傳大的二進位資料(影像、檔案、音訊)時用 Transferable,效能差異是「毫秒 vs 數百毫秒」等級。

---

## 4 一般使用方式(原生 Vanilla JS)

不用任何框架、不用打包工具,瀏覽器原生就支援。

### 4.1 最小可運作範例

**`worker.js`**(背景執行緒的程式):

```js
// worker.js — 跑在背景執行緒,這裡碰不到 DOM
self.onmessage = (e) => {
  const n = e.data;            // 收到主執行緒傳來的資料
  let sum = 0;
  for (let i = 0; i < n; i++) sum += i;   // 假裝是很重的運算
  self.postMessage(sum);       // 把結果送回主執行緒
};
```

**`main.js`**(主執行緒,頁面用的):

```js
// 1. 建立 Worker(路徑相對於「頁面」的位置)
const worker = new Worker('worker.js');

// 2. 監聽 Worker 回傳的結果
worker.onmessage = (e) => {
  console.log('運算結果:', e.data);
  document.getElementById('result').textContent = e.data; // 更新 DOM 在主執行緒做
};

// 3. 把任務丟給 Worker(此時主執行緒完全不卡)
worker.postMessage(1_000_000_000);

console.log('我先印出來了,因為運算在背景跑!');
```

> 💡 原生 `new Worker('worker.js')` 的路徑是**相對於 HTML 頁面**,不是相對於 JS 檔。這常踩雷,所以打包工具(Vite/webpack)改用 `new URL(...)` 寫法(見 §5)。

### 4.2 雙向通訊 + 用任務 id 對應結果(Promise 化)

真實情境會送很多任務,回傳是非同步的,要靠 **id 把「請求」和「回應」對起來**,並包成 Promise 方便用:

**`worker.js`**

```js
self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  let result;
  switch (type) {
    case 'sum':
      result = payload.reduce((a, b) => a + b, 0);
      break;
    case 'sort':
      result = [...payload].sort((a, b) => a - b);
      break;
    default:
      // 把錯誤也帶 id 回去
      return self.postMessage({ id, error: `未知任務:${type}` });
  }
  self.postMessage({ id, result });
};
```

**`main.js`** — 包一個 `runTask()`,呼叫起來像普通的 async 函式:

```js
const worker = new Worker('worker.js');
const pending = new Map();   // id → { resolve, reject }
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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

// 用起來就像呼叫一般 async 函式
const total = await runTask('sum', [1, 2, 3, 4, 5]);   // 15
const sorted = await runTask('sort', [3, 1, 2]);        // [1, 2, 3]
```

### 4.3 錯誤處理與終止 Worker

```js
// 監聽 Worker 內未捕捉的錯誤
worker.onerror = (e) => {
  console.error(`Worker 錯誤:${e.message}(${e.filename}:${e.lineno})`);
};

// 用完要關掉,釋放執行緒資源
worker.terminate();          // 主執行緒這邊強制終止

// 或在 Worker 內部自我了結
// self.close();
```

> ⚠️ Worker **不會自動消失**。一個頁面開太多 Worker 沒關,會吃掉記憶體與執行緒。用完(或元件卸載時)記得 `terminate()`。

### 4.4 Module Worker:在 Worker 裡用 `import`

預設的「classic worker」要載入別的檔案得用 `importScripts()`。現代瀏覽器支援 **module worker**,可以直接用 ESM 的 `import`:

```js
// 建立時加上 type: 'module'
const worker = new Worker('worker.js', { type: 'module' });
```

```js
// worker.js — 現在可以用 import 了
import { heavyCalc } from './math-utils.js';

self.onmessage = (e) => {
  self.postMessage(heavyCalc(e.data));
};
```

> 💡 用打包工具(Vite/webpack)時,幾乎一律用 `type: 'module'`,才能把 Worker 的依賴一起打包進去。

---

## 5 實戰範例:Vue 3 + Vite

Vite 對 Web Worker 有**一級支援**,不用額外設定。重點是「**怎麼讓 Vite 正確打包並載入 Worker 檔**」。

### 5.1 Vite 載入 Worker 的兩種寫法

**寫法 A(推薦,跨打包工具通用)**——用 `new URL(..., import.meta.url)`:

```js
const worker = new Worker(
  new URL('./heavy.worker.js', import.meta.url),
  { type: 'module' }
);
```

**寫法 B(Vite 專屬)**——用 `?worker` 查詢字串,import 進來是一個建構式:

```js
import HeavyWorker from './heavy.worker.js?worker';
const worker = new HeavyWorker();

// 想內聯成 base64(不額外發請求)用 ?worker&inline
// import HeavyWorker from './heavy.worker.js?worker&inline';
```

> 💡 兩種都可以。**寫法 A** 在 webpack 5 / Vite 都能用,可攜性最好,本篇統一用它。檔名習慣取 `xxx.worker.js` 方便辨識。

### 5.2 封裝成 Composable:`useWorker`

把「建立 / 通訊 / Promise 化 / 卸載時清理」包成一個可重用的 composable。

**`src/workers/heavy.worker.js`**

```js
// 純運算,完全不碰 Vue / DOM
self.onmessage = (e) => {
  const { id, n } = e.data;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sqrt(i);
  self.postMessage({ id, result: sum });
};
```

**`src/composables/useHeavyWorker.js`**

```js
import { onUnmounted } from 'vue';

export function useHeavyWorker() {
  const worker = new Worker(
    new URL('../workers/heavy.worker.js', import.meta.url),
    { type: 'module' }
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

  // ⭐ 元件卸載時關掉 Worker,避免洩漏
  onUnmounted(() => worker.terminate());

  return { compute };
}
```

**元件 `HeavyDemo.vue`**

```vue
<script setup>
import { ref } from 'vue';
import { useHeavyWorker } from '@/composables/useHeavyWorker';

const { compute } = useHeavyWorker();
const result = ref(null);
const loading = ref(false);

async function run() {
  loading.value = true;
  // 即使運算很重,下面這行不會卡住畫面,按鈕動畫、輸入都正常
  result.value = await compute(1_000_000_000);
  loading.value = false;
}
</script>

<template>
  <button :disabled="loading" @click="run">
    {{ loading ? '計算中…(畫面依然順暢)' : '開始大運算' }}
  </button>
  <p v-if="result !== null">結果:{{ result.toFixed(2) }}</p>
</template>
```

> 💡 試著把 `compute()` 換成在主執行緒直接跑同樣的迴圈——你會發現按鈕在運算期間完全點不動。用 Worker 後,`loading` 動畫、輸入框全程順暢,這就是差別。

### 5.3 在 Worker 裡引入第三方套件

因為是 module worker,Vite 會幫你打包依賴,直接 `import` 即可:

```js
// heavy.worker.js
import { compress } from 'some-compression-lib';

self.onmessage = (e) => {
  self.postMessage({ id: e.data.id, result: compress(e.data.payload) });
};
```

---

## 6 實戰範例:React

React 沒有內建 Worker 工具,但用 **custom hook** 封裝最自然。現代腳手架(Vite、CRA 5 / webpack 5、Next.js)都支援 `new URL(..., import.meta.url)` 寫法。

### 6.1 自訂 Hook:`useWorker`

**`src/workers/heavy.worker.js`**(同 §5,純運算)

```js
self.onmessage = (e) => {
  const { id, n } = e.data;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sqrt(i);
  self.postMessage({ id, result: sum });
};
```

**`src/hooks/useHeavyWorker.js`**

```js
import { useEffect, useRef, useCallback } from 'react';

export function useHeavyWorker() {
  const workerRef = useRef(null);
  const pendingRef = useRef(new Map());
  const seqRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/heavy.worker.js', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const job = pendingRef.current.get(id);
      if (!job) return;
      pendingRef.current.delete(id);
      error ? job.reject(new Error(error)) : job.resolve(result);
    };
    workerRef.current = worker;

    // ⭐ 元件卸載時清理(React 18 嚴格模式會 mount 兩次,這裡確保正確回收)
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

### 6.2 元件使用

```jsx
import { useState } from 'react';
import { useHeavyWorker } from './hooks/useHeavyWorker';

export default function HeavyDemo() {
  const { compute } = useHeavyWorker();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    // 運算期間,輸入框、其他 state 更新、動畫全部照常運作
    const r = await compute(1_000_000_000);
    setResult(r);
    setLoading(false);
  }

  return (
    <div>
      <button disabled={loading} onClick={run}>
        {loading ? '計算中…(畫面依然順暢)' : '開始大運算'}
      </button>
      {result !== null && <p>結果:{result.toFixed(2)}</p>}
    </div>
  );
}
```

> ⚠️ **React 18 嚴格模式(StrictMode)** 在開發環境會故意 mount → unmount → 再 mount 一次來幫你抓 bug。上面 `useEffect` 的 cleanup(`worker.terminate()`)就是必要的,否則開發時會殘留一個 Worker。

---

## 7 進階:用 Comlink 把通訊變成「呼叫函式」

手寫 `postMessage` + id 對應很繁瑣。Google 的 [Comlink](https://github.com/GoogleChromeLabs/comlink) 用 Proxy 把 Worker 包裝成「**像呼叫本地非同步函式一樣**」,程式碼乾淨非常多。

**`api.worker.js`**

```js
import * as Comlink from 'comlink';

const api = {
  sum(arr) { return arr.reduce((a, b) => a + b, 0); },
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
import * as Comlink from 'comlink';

const worker = new Worker(new URL('./api.worker.js', import.meta.url), { type: 'module' });
const api = Comlink.wrap(worker);

// 直接「呼叫」Worker 裡的方法,回傳是 Promise
const total = await api.sum([1, 2, 3]);     // 6
const r = await api.heavy(1_000_000_000);   // 在背景算,UI 不卡
```

> 💡 任務種類多、通訊邏輯複雜時,Comlink 能省掉一大堆樣板程式碼,強烈推薦。

---

## 8 進階補充:Shared Worker(多分頁共享)

需要**多個分頁共用同一份狀態 / 同一條後端連線**(例如多開的後台共用一條 WebSocket)時,用 SharedWorker:

```js
// 主執行緒:用 .port 通訊
const sw = new SharedWorker(new URL('./shared.worker.js', import.meta.url), { type: 'module' });
sw.port.start();
sw.port.postMessage('hello');
sw.port.onmessage = (e) => console.log(e.data);
```

```js
// shared.worker.js:每個分頁連進來會觸發 onconnect
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

> ⚠️ SharedWorker 的瀏覽器支援度不如 Dedicated Worker(行動版 Safari 長期不支援)。一般情境優先用 Dedicated Worker。

---

## 9 常見問題 FAQ

**Q1:Web Worker 和 Service Worker 一樣嗎?**
不一樣。**Web(Dedicated)Worker** 是用來分擔 CPU 運算、避免 UI 卡頓;**Service Worker** 是攔截網路請求、做離線快取與推播(PWA 核心)。兩者都跑在背景,但目的完全不同。

**Q2:Worker 裡可以操作 DOM 嗎?**
不行。Worker 沒有 `window` 和 `document`。任何畫面更新都要把結果 `postMessage` 回主執行緒,由主執行緒改 DOM。(例外:`OffscreenCanvas` 可以把 canvas 的繪製轉移到 Worker。)

**Q3:傳資料給 Worker 是「共享」還是「複製」?**
預設是**複製**(結構化複製,深拷貝),兩邊各一份。要避免大資料複製成本,用 **Transferable**(轉移所有權)或 `SharedArrayBuffer`(真共享記憶體,但需要特定的 CORS / COOP / COEP 標頭才能啟用)。

**Q4:開幾個 Worker 比較好?**
不是越多越好。每個 Worker 都是一條真執行緒,佔記憶體。常見做法是建一個 **Worker Pool**,數量參考 `navigator.hardwareConcurrency`(CPU 核心數),把任務分配給池子裡的 Worker。

**Q5:Worker 載入路徑老是 404?**
原生 `new Worker('worker.js')` 路徑相對於 HTML 頁面,部署後常因路徑變動而失敗。用打包工具時,**一律用 `new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })`**,讓打包工具處理路徑與打包,最穩。

**Q6:Worker 裡能不能發 API 請求?**
可以。`fetch`、`XMLHttpRequest`、`WebSocket` 在 Worker 裡都能用。把「下載大檔 + 解析」整包丟進 Worker 是很常見的用法。

---

## 10 總結

```
Web Worker 的完整圖像:

  問題    → JS 單執行緒,主執行緒被大運算佔住 → UI 凍結
  解法    → 開一條背景執行緒(Dedicated Worker)專跑耗時運算
  限制    → 碰不到 DOM、沒有 window/document;只能靠訊息溝通
  通訊    → postMessage / onmessage(預設深拷貝),大資料用 Transferable 零拷貝
  載入    → 打包環境一律 new Worker(new URL('./x.worker.js', import.meta.url), {type:'module'})
  封裝    → Vue 用 composable、React 用 custom hook,卸載時 terminate()
  進階    → 通訊複雜用 Comlink;多分頁共享用 SharedWorker;池化用 hardwareConcurrency
```

記住幾個核心觀念,就不會用錯:

1. **Worker 解決的是「CPU 卡 UI」** — 純運算很重才用它;等待 I/O 用 `async/await` 就好。
2. **Worker 碰不到 DOM** — 算完一定要把結果送回主執行緒才能更新畫面。
3. **通訊預設是深拷貝** — 大資料記得用 Transferable,別讓序列化吃掉效能。
4. **用完要關** — 框架裡務必在元件卸載時 `terminate()`,否則執行緒與記憶體會洩漏。

---

> 延伸閱讀:
> - [Promise、async/await 與 then](./promise-async-await-then.md) — 搞懂「非同步排程」與「多執行緒平行」的差別,是用對 Worker 的前提
> - [WebSocket 即時通訊實戰](./websocket.md) — 可把長連線與訊息處理放進 Worker,避免影響主執行緒
> - [SSE 伺服器推送實戰](./sse.md) — 同理,持續接收的串流也適合在背景執行緒處理
