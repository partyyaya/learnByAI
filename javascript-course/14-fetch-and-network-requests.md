# 14 — fetch 與網路請求

> `fetch` 只在連不上伺服器時失敗；伺服器回 404、500，對 `fetch` 來說都是成功。檢查狀態碼、處理取消與逾時、防止舊回應蓋掉新結果，是每個請求都要做的事。

`fetch` 在瀏覽器和 Node 18 以上都內建，介面相同。這一章從 `fetch` 的基本行為開始，接著處理實務上一定會遇到的問題：錯誤判斷、組網址、送出資料、取消、競態、串流、CORS，最後把它們組成一個小型的 API 客戶端。

本章範例大多可以直接用 Node 24 執行（自己起一個本機伺服器，或打公開的測試 API）；14.6 與 14.8 節是瀏覽器的情境。HTTP 本身（方法、狀態碼、標頭）的介紹見 [HTTP 與 HTTPS](../common/http-https.md)。

## 14.1 fetch 的兩個階段

```js
const response = await fetch("https://api.example.com/products/1");
const product = await response.json();
```

`fetch` 分兩步完成，兩步都要 `await`：

1. **`fetch()`**：收到回應的狀態碼與標頭時就完成，得到 `Response` 物件。這時 body 可能還在傳輸中。
2. **讀取 body**：用下列其中一個方法，等 body 全部收到並解析完成。

| 方法 | 得到 |
|------|------|
| `response.json()` | 解析後的 JSON |
| `response.text()` | 字串 |
| `response.blob()` | `Blob`，用於圖片、檔案下載 |
| `response.arrayBuffer()` | 二進位資料 |
| `response.formData()` | `FormData` |

`Response` 上的其他資訊：

```js
response.ok;          // 狀態碼在 200～299 之間時為 true
response.status;      // 404
response.statusText;  // "Not Found"
response.headers.get("content-type"); // "application/json"
response.url;         // 經過重新導向後的最終網址
```

### body 只能讀一次

```js
const r = await fetch(url);
await r.json();
await r.text(); // TypeError: Body is unusable: Body has already been read
```

body 是一條串流，讀完就沒了。需要讀兩次（例如先記錄原始內容再解析）時，讀之前先 `response.clone()`。

### 和 axios 的差別

很多專案用 axios 發請求。兩者最大的差別：axios 遇到 4xx、5xx 會直接丟錯、自動解析 JSON；`fetch` 兩件事都要自己做。14.2 節的 `request()` 就是在補這兩件事。理解 `fetch` 的行為，換到任何 HTTP 函式庫都能很快上手。

## 14.2 HTTP 錯誤不會 reject

```js
const res = await fetch(`${base}/orders/999`); // 伺服器回 404
res.ok;     // false
res.status; // 404
// 沒有丟出任何錯誤
```

`fetch` 的 Promise 只在**無法取得回應**時失敗：網路斷線、DNS 查不到、連線被拒、CORS 被擋、請求被取消。這時丟出的是 `TypeError`，訊息在瀏覽器是 `Failed to fetch`、在 Node 是 `fetch failed`，看不出具體原因（詳細原因在 DevTools 的 Network 和 Console 分頁）。

伺服器有回應，不管是 404 還是 500，`fetch` 都算成功。如果只寫 `await res.json()`，404 的錯誤訊息會被當成正常資料往下傳。每個請求都要檢查 `res.ok`。

### 包一個 `request()`

把檢查狀態碼、解析 body 集中在一個函式裡：

```js
class HttpError extends Error {
  constructor(response, body) {
    super(`HTTP ${response.status} ${response.statusText}`);
    this.name = "HttpError";
    this.status = response.status;
    this.body = body; // 伺服器回傳的錯誤內容，通常有錯誤訊息
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });

  const text = await response.text();
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson && text ? JSON.parse(text) : text || null;

  if (!response.ok) throw new HttpError(response, body);
  return body;
}
```

```js
await request(`${base}/products/1`); // { id: 1, name: "pen" }

try {
  await request(`${base}/orders/999`);
} catch (err) {
  if (err instanceof HttpError && err.status === 404) {
    showMessage(err.body?.message ?? "找不到資料");
  } else {
    throw err;
  }
}
```

為什麼先讀 `text()` 再自己解析，而不是直接 `json()`：

- **204 No Content** 沒有 body，`response.json()` 會丟出 `SyntaxError: Unexpected end of JSON input`。
- **錯誤時不一定是 JSON**。閘道器（Nginx、負載平衡器）回的 502 通常是一段 HTML，直接 `json()` 會丟出 `Unexpected token '<'`，真正的錯誤（502）反而被蓋掉了。

`HttpError` 用了 [8.4 節](08-error-handling.md#84-自訂錯誤類別)的自訂錯誤類別寫法，呼叫端可以依 `status` 決定怎麼處理。

## 14.3 組網址：URL 與 URLSearchParams

不要手工拼接查詢字串：

```js
// 錯誤：& 會被當成參數的分隔符號，伺服器收到的 q 是 "Vue "
fetch(`/api/search?q=${keyword}`);
```

用 `URL` 與 `URLSearchParams`，編碼交給它們處理：

```js
const url = new URL("/api/courses", location.origin); // Node 裡用實際的網址
url.searchParams.set("q", "Vue & React");
url.searchParams.set("page", String(2));
url.searchParams.append("tag", "frontend");
url.searchParams.append("tag", "javascript");

url.searchParams.get("q");      // "Vue & React"
url.searchParams.getAll("tag"); // ["frontend", "javascript"]
url.search;                     // "?q=Vue+%26+React&page=2&tag=frontend&tag=javascript"

await fetch(url); // fetch 可以直接接受 URL 物件
```

- `set` 會取代同名參數，`append` 會保留多個同名的值。
- 不要先 `encodeURIComponent` 再交給 `set`，否則會重複編碼：`"a b"` 會變成 `a%2520b`。
- 解析完整網址時先用 `new URL(...)`，再讀 `url.searchParams`。把完整網址直接交給 `new URLSearchParams(...)`，它會把整串當成查詢字串解析，得到錯誤的結果。
- 讀到的參數一律是字串。頁碼這類數字要轉型並檢查範圍：網址列上的值使用者可以隨意修改。

## 14.4 送出資料

### JSON

```js
await request(`${base}/orders`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ productId: 1, qty: 2 }),
});
```

`body` 要自己 `JSON.stringify`，`Content-Type` 也要自己設定，否則伺服器不知道收到的是 JSON。

### 表單與檔案

```js
const data = new FormData(form); // 直接從 <form> 收集（13.9 節）
data.set("avatar", fileInput.files[0]);

await fetch("/api/profile", { method: "POST", body: data });
```

傳 `FormData` 時**不要自己設定 `Content-Type`**。瀏覽器會自動設成 `multipart/form-data`，並加上各欄位之間的分隔字串（boundary）；手動設定會缺少 boundary，伺服器無法解析。

`body` 也可以是 `URLSearchParams`（送出 `application/x-www-form-urlencoded`）、字串、`Blob` 或 `ArrayBuffer`。

### Cookie 與憑證

同源的請求預設會帶 cookie。跨來源的請求要帶 cookie，必須設定 `credentials: "include"`，伺服器也要允許（14.8 節）：

```js
await fetch("https://api.example.com/me", { credentials: "include" });
```

## 14.5 取消請求：AbortController

```js
const controller = new AbortController();

const promise = fetch(`${base}/slow`, { signal: controller.signal });
cancelButton.onclick = () => controller.abort();

try {
  const res = await promise;
} catch (err) {
  if (err.name === "AbortError") {
    // 使用者取消的，不算錯誤，不需要顯示錯誤訊息
  } else {
    throw err;
  }
}
```

`abort()` 之後，`fetch` 的 Promise 以 `AbortError`（一個 `DOMException`）失敗；如果已經在讀 body，讀取也會中止。

### 逾時

```js
try {
  await fetch(url, { signal: AbortSignal.timeout(5000) });
} catch (err) {
  if (err.name === "TimeoutError") {
    showMessage("伺服器回應太慢，請稍後再試");
  }
}
```

`AbortSignal.timeout(ms)` 在時間到時自動取消，錯誤名稱是 `TimeoutError`，可以和使用者主動取消（`AbortError`）分開處理。和 [11.8 節](11-promise-and-async-await.md#118-逾時)的 `withTimeout` 不同，這裡的請求是**真的被取消了**，不只是不再等它。

同時需要「使用者可以取消」和「逾時」時，用 `AbortSignal.any` 合併：

```js
const userCancel = new AbortController();
const signal = AbortSignal.any([userCancel.signal, AbortSignal.timeout(5000)]);
await fetch(url, { signal });
```

### 注意事項

- **一個 controller 只能 abort 一次**。signal 一旦被取消，就不能重設；每個請求建立新的 controller。
- **取消不會撤銷伺服器上已經完成的動作**。「送出訂單」的請求在伺服器處理完之後才被取消，訂單仍然成立。取消只代表「瀏覽器不再等這個回應」。
- `abort(reason)` 可以傳入自訂的原因，`fetch` 會用這個原因 reject，而不是 `AbortError`。檢查錯誤種類時要考慮到這一點。
- `signal` 也可以傳給自己寫的非同步函式，用 `signal.aborted` 檢查、或監聽 `abort` 事件，讓整條流程都能取消。

## 14.6 避免競態：只讓最新的結果寫回

搜尋框每輸入一個字就發一次請求。如果第一次的請求比第二次慢，畫面會先顯示第二次的結果，再被第一次的舊結果蓋掉。這是因為 `await` 期間其他程式碼可以執行（[10.1 節](10-event-loop.md#101-單執行緒與執行到完成)），回應回來的順序不一定和送出的順序相同。

下面的 helper 假設 `/api/search?q=...` 回傳 JSON，可以接在搜尋框的事件處理器上：

```js
function createLatestSearch(onData, onError = console.error) {
  let current = null;
  let version = 0;
  let disposed = false;

  return {
    async search(keyword) {
      if (disposed) return;
      const myVersion = ++version;
      current?.abort(); // 取消上一個還在進行的請求
      const controller = new AbortController();
      current = controller;

      try {
        const url = new URL("/api/search", location.origin);
        url.searchParams.set("q", keyword);
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!disposed && !controller.signal.aborted && myVersion === version) {
          onData(data);
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted && myVersion === version) {
          onError(error);
        }
      } finally {
        if (myVersion === version) current = null;
      }
    },
    dispose() {
      disposed = true;
      version++;
      current?.abort();
      current = null;
    },
  };
}
```

```js
const latestSearch = createLatestSearch(renderResults, showError);
input.addEventListener("input", debounce(() => latestSearch.search(input.value), 300));
// 頁面或元件卸載時
latestSearch.dispose();
```

兩道保護各有用途：

- **取消舊請求**省下頻寬與伺服器資源，也讓舊請求的 `fetch` 以 `AbortError` 結束。
- **版本檢查**（`myVersion === version`）保證只有最後一次搜尋的結果會寫回。即使舊請求來不及取消（回應已經在讀取中），也不會蓋掉新結果。UI 有 loading 狀態時，清除 loading 前也要確認自己仍是最新的那次請求。

取消和 debounce 解決的是不同問題：取消處理「已經送出的請求」，debounce（[3.5 節](03-scope-closures-and-hoisting.md#35-閉包的應用)）減少「送出的請求數」。搜尋框通常兩者都要。

## 14.7 串流讀取回應

`response.body` 是一個 `ReadableStream`。不想等整個回應收完才處理（大型檔案、伺服器逐段產生的內容、AI 逐字輸出的回答），可以一段一段讀：

```js
const res = await fetch(`${base}/stream`);
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  output.textContent += value; // 每收到一段就更新畫面
}
```

`TextDecoderStream` 把位元組轉成文字。直接用 `TextDecoder` 自己解碼時要傳 `{ stream: true }`，否則一個中文字的位元組剛好被切在兩段之間時，會解出亂碼。

Node 和較新的瀏覽器裡，`ReadableStream` 也可以用 `for await...of` 走訪（[7.7 節](07-collections-iterators-and-generators.md#77-非同步迭代)）：

```js
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  process.stdout.write(decoder.decode(chunk, { stream: true }));
}
```

### 下載進度

回應有 `Content-Length` 標頭時，可以邊讀邊計算進度：

```js
const total = Number(res.headers.get("content-length"));
let received = 0;
const reader = res.body.getReader();
const chunks = [];

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  chunks.push(value);
  received += value.length;
  if (total) progress.value = received / total;
}

const blob = new Blob(chunks);
```

伺服器用壓縮傳輸時，`Content-Length` 是壓縮後的大小，和讀到的位元組數不一致；沒有這個標頭時只能顯示已下載的量。`fetch` 目前不提供**上傳**進度，需要上傳進度條時仍要用 `XMLHttpRequest` 的 `upload.onprogress`。

伺服器主動、持續推送事件的情境，另見 [SSE 伺服器推送實戰](../common/sse.md)。

## 14.8 跨來源請求（CORS）

瀏覽器的**同源政策**規定：頁面上的 JavaScript 預設只能讀取同一個來源（協定、網域、埠號都相同）的回應。`http://localhost:5173` 的頁面請求 `http://localhost:3000/api`，埠號不同，就是跨來源。

跨來源請求能不能讀到回應，由**伺服器**決定：伺服器在回應中加上 `Access-Control-Allow-Origin` 等標頭，表示允許哪些來源讀取。

```text
瀏覽器                                        API 伺服器
  │ ── OPTIONS /api/orders（預檢）──────────▶ │  某些請求會先問一次
  │ ◀─ Access-Control-Allow-Origin: ... ──── │
  │ ── POST /api/orders ───────────────────▶ │
  │ ◀─ 200 + Access-Control-Allow-Origin ─── │  標頭允許，JavaScript 才讀得到
```

- 使用 `Content-Type: application/json`、自訂標頭（例如 `Authorization`），或 `PUT`、`DELETE` 這類方法時，瀏覽器會先送一個 `OPTIONS` **預檢請求**，確認伺服器允許後才送出真正的請求。
- 跨來源帶 cookie（`credentials: "include"`）時，伺服器必須回 `Access-Control-Allow-Credentials: true`，而且 `Access-Control-Allow-Origin` 不能是 `*`，要寫明確的來源。
- 被 CORS 擋下時，`fetch` 丟出的是 `TypeError: Failed to fetch`，程式拿不到任何細節。原因要看 DevTools 的 Console。

CORS 是**瀏覽器**執行的保護，前端程式無法繞過，只能在伺服器設定。`mode: "no-cors"` 不能讓你讀到資料，只會得到一個看不到內容的回應。開發時常用的做法是讓開發伺服器代理 API（例如 Vite 的 `server.proxy`），讓瀏覽器以為是同源請求；正式環境則由伺服器設定 CORS，或用反向代理讓前端與 API 同源。

Node 裡的 `fetch` 沒有同源政策，所以同一段程式在 Node 能跑、在瀏覽器被擋，通常就是 CORS 的問題。

## 14.9 組成一個 API 客戶端

把本章的元件組起來：統一的基礎網址、JSON 處理、錯誤、預設逾時、可取消：

```js
export function createApiClient(baseUrl, { timeoutMs = 10_000 } = {}) {
  async function call(method, path, { query, body, signal } = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    return request(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  return {
    get: (path, options) => call("GET", path, options),
    post: (path, body, options) => call("POST", path, { ...options, body }),
    put: (path, body, options) => call("PUT", path, { ...options, body }),
    delete: (path, options) => call("DELETE", path, options),
  };
}
```

```js
const api = createApiClient("https://api.example.com");

const products = await api.get("/products", { query: { page: 2, q: "pen" } });
const order = await api.post("/orders", { productId: 1, qty: 2 });
```

`request()` 是 14.2 節的函式。要加上重試時，只對**可以安全重試**的請求加（GET，或伺服器支援冪等鍵的寫入），並且只重試網路錯誤、逾時和 5xx（[11.10 節](11-promise-and-async-await.md#1110-重試與退避)）。

## 14.10 本章小結

- `fetch` 分兩步：先拿到 `Response`，再讀 body；body 只能讀一次。
- `fetch` 只在拿不到回應時失敗；4xx、5xx 要自己檢查 `res.ok`。把檢查與解析包進 `request()`，並處理 204 與非 JSON 的錯誤頁。
- 用 `URL` 與 `URLSearchParams` 組網址，不要手工拼接，也不要重複編碼。
- 送 JSON 要自己 `stringify` 並設定 `Content-Type`；送 `FormData` 不要設定 `Content-Type`。
- 用 `AbortController` 取消、`AbortSignal.timeout` 逾時、`AbortSignal.any` 合併；取消不會撤銷伺服器已完成的動作。
- 搜尋這類連續請求，要取消舊請求並檢查版本，避免舊結果蓋掉新結果。
- `response.body` 可以串流讀取，用來逐段顯示與計算下載進度。
- CORS 由伺服器決定，前端無法繞過；被擋時錯誤訊息看不出原因，要看 Console。

下一章：[15 — 瀏覽器原生 API](15-browser-native-apis.md)，Observer、排程、儲存與其他頁面互動。

---

[上一章：DOM 與事件](13-dom-and-events.md) · [返回課程總覽](README.md) · [下一章：瀏覽器原生 API](15-browser-native-apis.md)
