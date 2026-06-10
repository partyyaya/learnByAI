# SSE（Server-Sent Events）伺服器推送實戰

> 從原理到實作，完整搞懂 SSE：與 HTTP / WebSocket 的差異、`text/event-stream` 格式、前後端整合、自動重連與斷點續傳、身分驗證，以及上線前一定要避開的坑。

---

## 0 開始之前：SSE 是什麼？

**SSE（Server-Sent Events，伺服器推送事件）**是一種讓**伺服器單向、持續地把資料推送給前端**的技術。它建立在**純 HTTP** 之上：前端開一條連線，後端就「不關閉這條回應」，源源不絕地把事件寫進去。

```
傳統 HTTP（問完就斷）
  前端：給我資料  →  後端：這是資料，掰掰（連線關閉）

SSE（開一條長連線，持續推）
  前端：訂閱事件流  →  後端：事件1… 事件2… 事件3…（連線一直開著，持續推）
```

最適合 SSE 的場景，共同點都是「**只要伺服器主動推，前端不需要透過同通道回傳**」：

- 即時通知、站內訊息
- 股價 / 加密貨幣即時報價、儀表板數據更新
- 進度條（檔案處理、匯出、AI 模型生成中的逐字輸出）
- 動態消息（feed）、系統公告
- LLM 串流回應（ChatGPT 那種一個字一個字吐出來的效果，背後常是 SSE）

> 💡 **SSE 的核心價值**：用最簡單的方式（純 HTTP、瀏覽器內建 API）做到「伺服器主動推」，而且**自動重連、斷點續傳都內建**，不必像 WebSocket 那樣自己造輪子。

---

## 1 SSE vs HTTP vs WebSocket

| 比較項 | 一般 HTTP | SSE | WebSocket |
|--------|-----------|-----|-----------|
| 通訊方向 | 單向（前端問才答） | **單向（伺服器→前端）** | 全雙工（雙方皆可主動） |
| 底層協定 | HTTP | **HTTP**（純文字串流） | 獨立協定（`ws://`/`wss://`），借 HTTP 握手 |
| 連線 | 每次請求建立又關閉 | 一條長連線持續推 | 一次握手，長連線維持 |
| 自動重連 | — | ✅ **瀏覽器內建** | ❌ 要自己寫 |
| 斷點續傳 | — | ✅ **內建 `Last-Event-ID`** | ❌ 要自己設計 |
| 傳輸資料 | 任意 | **僅 UTF-8 文字**（二進位要 base64） | 文字 + 二進位 |
| 瀏覽器 API | `fetch` / `XHR` | `EventSource` | `WebSocket` |
| 前端能否主動送 | 每次另發請求 | ❌ 不能（要另開一般 API） | ✅ 可 |

> ⚠️ **怎麼選？** 一句話：
> - 只要「**伺服器單向推**」→ 用 **SSE**（更簡單、走純 HTTP、自動重連）。
> - 需要「**雙向高頻互動**」（聊天、遊戲、協作）→ 用 **WebSocket**。
>
> 別反射性地都用 WebSocket。很多「即時通知」「進度條」「LLM 串流」其實 SSE 就夠，還省掉重連 / 心跳一堆苦工。詳見 [WebSocket 即時通訊實戰](./websocket.md)。

---

## 2 `text/event-stream`：SSE 的資料格式

SSE 的本質就是一個**永不結束的 HTTP 回應**，`Content-Type` 是 `text/event-stream`，內容是一行一行的純文字事件。

### 2.1 後端回應的長相

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: 第一則訊息

data: 第二則訊息
data: （同一則的第二行）

event: price
id: 1001
data: {"symbol":"BTC","price":68000}

retry: 5000

```

### 2.2 欄位規則（很重要，格式錯了前端就收不到）

| 欄位 | 作用 |
|------|------|
| `data:` | 訊息內容。可多行，瀏覽器會用 `\n` 把多行 `data:` 接起來 |
| `event:` | 自訂事件名稱。前端用 `addEventListener("price", ...)` 接這種事件；不寫則是預設的 `message` 事件 |
| `id:` | 這則事件的 ID。瀏覽器會記住，斷線重連時自動帶 `Last-Event-ID` 回來（斷點續傳的關鍵） |
| `retry:` | 告訴瀏覽器斷線後等幾毫秒再重連（覆蓋預設值） |
| `:`（冒號開頭） | 註解行，瀏覽器會忽略。常用來當「保活心跳」 |

> ⚠️ **格式鐵則**：
> 1. 每個欄位是 `欄位: 值` 一行，**結尾一定要 `\n`**。
> 2. **一則事件用「空行」（兩個 `\n\n`）作結**——少了這個空行，前端會一直等、永遠不觸發。這是新手最常踩的坑。
> 3. `data` 的值若含換行，要拆成多個 `data:` 行，或先 `JSON.stringify` 成單行。

---

## 3 前端實作：原生 `EventSource` API

瀏覽器內建 `EventSource`，不需任何套件，連自動重連都幫你處理好了。

```js
// 建立連線（GET 請求；withCredentials 讓跨網域也帶上 cookie）
const es = new EventSource("/api/stream", { withCredentials: true });

// 連線成功
es.onopen = () => {
  console.log("SSE 已連線");
};

// 收到「預設」事件（後端沒寫 event: 的那種）
es.onmessage = (event) => {
  console.log("收到：", event.data);          // event.data 一定是字串
  const data = JSON.parse(event.data);          // 通常後端傳 JSON 字串
  console.log(data);
};

// 收到「自訂」事件（後端寫了 event: price）
es.addEventListener("price", (event) => {
  const price = JSON.parse(event.data);
  console.log("最新報價：", price);
});

// 發生錯誤（斷線時也會觸發，瀏覽器會自動嘗試重連）
es.onerror = (err) => {
  console.error("SSE 錯誤 / 斷線", err);
  // 注意：這裡「不用」自己重連，EventSource 會自動重試
  // 若想徹底停止，才呼叫 es.close()
};

// 主動關閉
function disconnect() {
  es.close();
}
```

### 3.1 `readyState` 的三種狀態

| 常數 | 值 | 意義 |
|------|----|------|
| `EventSource.CONNECTING` | 0 | 連線中（含斷線後重連中） |
| `EventSource.OPEN` | 1 | 已連線 |
| `EventSource.CLOSED` | 2 | 已關閉（呼叫 `close()` 或無法重連） |

> 💡 **EventSource 最大的甜頭**：斷線會**自動重連**，且會自動把上次收到的 `id` 透過 `Last-Event-ID` header 帶回後端。你幾乎不用寫重連邏輯——這正是它比 WebSocket 省事的地方。

> ⚠️ **`EventSource` 的硬限制**：
> 1. **只能發 `GET`，不能自訂 request header**（連 `Authorization` 都不行）。要帶 token 只能用 query string 或 cookie（見 §6）。
> 2. 想用 POST / 自訂 header，得放棄 `EventSource`，改用 `fetch` + `ReadableStream` 自己解析（見 §7）。

---

## 4 後端實作（Node.js）

SSE 不需要特殊套件，純 HTTP 就能做。重點在**設對 header**、**保持連線不關**、**按格式寫資料**。

### 4.1 原生 Node.js（看清楚每個細節）

```js
import http from "http";

http.createServer((req, res) => {
  if (req.url === "/api/stream") {
    // 1) SSE 必備的三個 header
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // 2) 立刻送一個註解行，把 header 沖出去、確認連線建立
    res.write(": connected\n\n");

    // 3) 定期推資料
    let id = 0;
    const timer = setInterval(() => {
      id++;
      res.write(`id: ${id}\n`);
      res.write(`event: tick\n`);
      res.write(`data: ${JSON.stringify({ time: id })}\n\n`); // 結尾兩個 \n！
    }, 1000);

    // 4) 前端關掉分頁 / 離開時，一定要清理計時器，否則記憶體洩漏
    req.on("close", () => {
      clearInterval(timer);
      console.log("client 離線，已清理");
    });
  } else {
    res.writeHead(404).end();
  }
}).listen(3000, () => console.log("http://localhost:3000"));
```

### 4.2 Express 版本

```js
import express from "express";
const app = express();

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // 立刻把 header 送出去

  const send = (event, data, id) => {
    if (id) res.write(`id: ${id}\n`);
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("welcome", { msg: "已連線" });

  const timer = setInterval(() => send("ping", { t: Date.now() }), 5000);

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
});

app.listen(3000);
```

> ⚠️ **後端三大鐵則**：
> 1. **絕不能 `res.end()` 太早**——SSE 靠「回應不結束」維持連線，提早結束等於斷線。
> 2. **一定要監聽 `req.on("close")` 清理資源**（計時器、訂閱、DB 連線），不然每個離線的 client 都留一個殭屍計時器，併發一高就爆。
> 3. **小心壓縮中介層**：`compression` / gzip 會緩衝資料、害事件卡住不送。要對 SSE 路由關閉壓縮，或在後端呼叫 flush。

---

## 5 ⭐ 自動重連與斷點續傳（SSE 的殺手鐗）

這是 SSE 比 WebSocket 漂亮的地方：**重連與補資料幾乎免費**。

### 5.1 運作原理

1. 後端每則事件都帶 `id:`。
2. 瀏覽器記住「最後收到的 id」。
3. 連線斷掉 → 瀏覽器**自動重連**（預設約 3 秒後，可用 `retry:` 調整）。
4. 重連時，瀏覽器自動在 request header 帶上 `Last-Event-ID: 最後的id`。
5. 後端讀這個 header，從那個 id **之後**開始補送，使用者就不會漏訊息。

### 5.2 後端做斷點續傳

```js
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  // 1) 重連時，瀏覽器會自動帶上次的 id
  const lastId = Number(req.headers["last-event-id"] || 0);

  // 2) 把斷線期間錯過的事件補送（events 是你的事件來源，例如 DB / 快取）
  const missed = getEventsAfter(lastId);
  for (const ev of missed) {
    res.write(`id: ${ev.id}\n`);
    res.write(`data: ${JSON.stringify(ev.payload)}\n\n`);
  }

  // 3) 之後的新事件照常推
  const onNewEvent = (ev) => {
    res.write(`id: ${ev.id}\n`);
    res.write(`data: ${JSON.stringify(ev.payload)}\n\n`);
  };
  eventBus.on("event", onNewEvent);

  // 4) 建議用 retry 控制重連間隔
  res.write("retry: 3000\n\n");

  req.on("close", () => eventBus.off("event", onNewEvent));
});
```

> 💡 **前端完全不用寫程式**：`Last-Event-ID` 的帶入、重連都是瀏覽器自動做的。你只要在後端「認得這個 header 並補資料」就行。

> ⚠️ 要做到「不漏訊息」，後端必須**保留近期事件**（存記憶體環形緩衝、Redis Stream、或 DB），否則重連時無從補起。若業務允許漏一些（如「目前線上人數」這種只看最新值的），就不必補。

---

## 6 ⭐ 身分驗證（Authentication）

SSE 沒有內建驗證，且 `EventSource` **不能自訂 header**，所以不能直接帶 `Authorization: Bearer xxx`。常見三種做法：

| 做法 | 說明 | 評價 |
|------|------|------|
| Cookie（httpOnly） | SSE 是純 HTTP 請求，會自動帶 cookie | ✅ 同網域最安全、最推薦 |
| Query string 帶 token | `/api/stream?token=xxx` | ⚠️ token 會進伺服器 log、瀏覽器歷史，**不建議放長效敏感 token** |
| 改用 `fetch` 串流 | 用 `fetch` 就能自訂 `Authorization` header | ✅ 想用 Bearer token 時的正解（見 §7） |

### 6.1 Cookie 驗證（搭配跨網域）

```js
// 前端：withCredentials 讓跨網域請求帶上 cookie
const es = new EventSource("https://api.example.com/stream", {
  withCredentials: true,
});
```

```js
// 後端（Express）：跨網域要明確允許來源 + 帶 credentials
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://example.com"); // 不能用 *
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});

app.get("/api/stream", authMiddleware, (req, res) => {
  // authMiddleware 驗證 cookie 裡的 session / JWT，沒過就 401
  // ...開始推送
});
```

> ⚠️ 跨網域帶 cookie 時，`Access-Control-Allow-Origin` **不能用萬用字元 `*`**，必須回明確網域，且要搭配 `Access-Control-Allow-Credentials: true`。SSE 身分驗證常用 JWT，延伸閱讀見 [JWT 登入實戰](./jwt-auth-frontend-backend.md)。

---

## 7 進階：用 `fetch` + `ReadableStream` 取代 `EventSource`

當你需要 **POST、自訂 header（如 `Authorization`）、傳 request body**（例如送一段 prompt 給 LLM 再串流回應），原生 `EventSource` 辦不到，就改用 `fetch` 讀串流並自己解析 SSE 格式。

```js
async function streamWithFetch(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`, // EventSource 做不到，這裡可以
    },
    body: JSON.stringify(body),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 以空行（\n\n）切出一則完整事件
    const events = buffer.split("\n\n");
    buffer = events.pop(); // 最後一段可能不完整，留到下一輪

    for (const chunk of events) {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;          // 常見的結束標記
          console.log("收到：", JSON.parse(data));
        }
      }
    }
  }
}
```

> ⚠️ 用 `fetch` 自己解析就**失去 `EventSource` 的自動重連與 `Last-Event-ID`**，這些要自己補。所以：能用 `EventSource` 就用，只有非得 POST / 自訂 header 時才走 `fetch`。
>
> 💡 也可用成熟套件如 [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source)，它在 `fetch` 之上補回了重連與錯誤處理。

---

## 8 完整實戰範例：即時通知系統

把前面觀念整合：驗證 + 自訂事件 + 斷點續傳 + 保活 + 資源清理。

### 8.1 後端（`server.js`，Express）

```js
import express from "express";
const app = express();

// 簡單的事件來源：記憶體環形緩衝（正式環境建議用 Redis Stream）
const recent = [];
let seq = 0;
function publish(type, payload) {
  const ev = { id: ++seq, type, payload };
  recent.push(ev);
  if (recent.length > 1000) recent.shift(); // 只留最近 1000 筆
  subscribers.forEach((res) => writeEvent(res, ev));
}
function writeEvent(res, ev) {
  res.write(`id: ${ev.id}\n`);
  res.write(`event: ${ev.type}\n`);
  res.write(`data: ${JSON.stringify(ev.payload)}\n\n`);
}

const subscribers = new Set();

app.get("/api/notifications", authMiddleware, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write("retry: 3000\n\n");

  // 1) 斷點續傳：補送錯過的事件
  const lastId = Number(req.headers["last-event-id"] || 0);
  recent.filter((ev) => ev.id > lastId).forEach((ev) => writeEvent(res, ev));

  // 2) 加入訂閱者
  subscribers.add(res);

  // 3) 保活心跳：每 15 秒送一個註解行，避免代理因閒置切斷
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);

  // 4) 清理
  req.on("close", () => {
    clearInterval(keepAlive);
    subscribers.delete(res);
  });
});

// 模擬：別處觸發通知
setInterval(() => publish("notice", { text: "你有一則新訊息", at: Date.now() }), 8000);

app.listen(3000, () => console.log("SSE 伺服器啟動於 http://localhost:3000"));
```

### 8.2 前端

```js
const es = new EventSource("/api/notifications", { withCredentials: true });

es.addEventListener("notice", (event) => {
  const { text } = JSON.parse(event.data);
  showToast(text); // 跳出通知
});

es.onerror = () => {
  // 不用自己重連，EventSource 會自動重試
  console.warn("連線中斷，等待自動重連…");
};

// 離開頁面時關閉（可選，瀏覽器關分頁也會自動斷）
window.addEventListener("beforeunload", () => es.close());
```

---

## 9 上線部署注意事項

| 議題 | 說明與解法 |
|------|-----------|
| **Nginx 緩衝** | Nginx 預設會**緩衝**回應，導致事件卡住不即時送達。要對 SSE 路由加 `proxy_buffering off;` 並關閉壓縮 |
| **代理逾時** | Nginx `proxy_read_timeout` 預設 60 秒，閒置連線會被切。要調大，或靠保活心跳（每 15 秒送 `: \n\n`） |
| **gzip / 壓縮** | 壓縮中介層會緩衝資料破壞即時性，要對 `text/event-stream` 關閉壓縮 |
| **HTTP/1.1 連線數上限** | 同一網域 HTTP/1.1 瀏覽器最多 **6 條**並發連線，多開幾個 SSE 分頁就卡死。**改用 HTTP/2** 可多工解決（也省連線） |
| **水平擴展** | 多台伺服器時，A 機觸發的事件，連在 B 機的使用者收不到。要用 **Redis Pub/Sub** 把事件廣播到所有機器再各自推 |
| **負載平衡黏性** | SSE 是長連線，LB 要設 sticky session 讓連線固定走同一台 |

### 9.1 Nginx 設定範例（逐行說明）

```nginx
location /api/stream {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";   # 清掉 Connection，維持 keep-alive 到後端
    proxy_buffering off;              # 關緩衝：事件即時送出，不卡住
    proxy_cache off;                  # 關快取：SSE 是動態串流
    proxy_read_timeout 3600s;         # 拉長閒置逾時，避免被誤砍
    gzip off;                         # 關壓縮：壓縮會緩衝、破壞即時性
}
```

| 行 | 意思 | 不寫會怎樣 |
|----|------|-----------|
| `proxy_buffering off;` | 後端寫一則就立刻轉發給前端，不囤在 Nginx | 事件被緩衝，前端要等緩衝滿才收到，失去即時性（**SSE 最常見的坑**） |
| `proxy_cache off;` | 不快取串流回應 | 可能回放舊內容或卡住 |
| `proxy_read_timeout 3600s;` | 後端多久沒送資料才視為逾時 | 預設 60 秒，閒置時連線被切（要靠心跳或調大） |
| `gzip off;` | 不對串流壓縮 | 壓縮層緩衝資料，事件延遲送達 |

> 💡 SSE 部署最常見的災難就是「本機跑得好好的，上線就不即時了」——九成是 **Nginx `proxy_buffering` 沒關**或壓縮中介層在搞鬼。

### 9.2 多機擴展（Redis Pub/Sub）

```js
import { createClient } from "redis";

const pub = createClient(); const sub = createClient();
await pub.connect(); await sub.connect();

// 任何一台機器觸發事件 → 發到 Redis
function publish(type, payload) {
  pub.publish("events", JSON.stringify({ type, payload }));
}

// 每台機器都訂閱，收到就推給自己這台連著的 client
await sub.subscribe("events", (raw) => {
  const ev = JSON.parse(raw);
  subscribers.forEach((res) => writeEvent(res, ev));
});
```

---

## 10 安全注意事項（務必檢查）

- ✅ **永遠用 HTTPS**：SSE 走 HTTP，未加密內容（含 token）會裸奔。
- ✅ **一定要做身分驗證**：別假設「能連上的都是好人」，用 cookie 或 token 驗證每一條連線。
- ✅ **驗證每則事件的權限**：使用者只能收到自己有權限看的事件，後端逐條過濾，別把別人的資料推錯人。
- ✅ **跨網域時嚴格設 CORS**：`Access-Control-Allow-Origin` 回明確網域，不要用 `*`（尤其帶 cookie 時根本不允許 `*`）。
- ✅ **限制單一使用者的連線數**：防止有人狂開連線吃光伺服器資源（fd / 記憶體）。
- ✅ **絕不信任前端傳來的身分欄位**：使用者身分一律從後端驗證過的 cookie / token 取得。

> ⚠️ SSE 跟 WebSocket 一樣，瀏覽器發起時會自動帶 cookie，光靠 cookie 不夠安全。同源政策 + 嚴格 CORS + token 驗證一起上，才能擋住跨站濫用。

---

## 11 常見問題 FAQ

**Q1：SSE 和 WebSocket 到底怎麼選？**
只要「**伺服器單向推、前端不需透過同通道回傳**」就用 SSE——更簡單、走純 HTTP、自動重連內建。需要「**雙向高頻互動**」（聊天、遊戲、協作編輯）才用 WebSocket。常見誤區是「即時都用 WebSocket」，其實通知、進度條、LLM 串流用 SSE 更省事。

**Q2：SSE 能傳二進位資料（圖片、檔案）嗎？**
不行。SSE 只能傳 **UTF-8 文字**。真要傳二進位得先 base64 編碼（體積膨脹約 1/3，不划算）。要傳二進位請用 WebSocket。

**Q3：前端能透過 SSE 連線送東西給後端嗎？**
不能。SSE 是**單向**的。前端要送資料就**另外發一般的 HTTP API**（POST/PUT），SSE 那條只負責接收伺服器推來的事件。

**Q4：連線會自動斷嗎？要不要寫心跳？**
協定本身沒時間上限，但中間的代理 / 防火牆會因「閒置」切斷。建議後端**定期送註解行**（`: keep-alive\n\n`，例如每 15 秒）保活。重連倒是不用煩惱——`EventSource` 會自動重連。

**Q5：為什麼本機正常，上線後事件就延遲 / 收不到？**
九成是反向代理在緩衝。檢查 Nginx 的 `proxy_buffering off;`、關閉 gzip 壓縮、確認沒有 CDN 快取住串流。見 §9。

**Q6：一個瀏覽器能開幾條 SSE？**
HTTP/1.1 下，**同一網域最多 6 條**並發連線（這是瀏覽器對 HTTP 的硬限制，多開分頁會互相卡死）。解法是**改用 HTTP/2**（多工，不受 6 條限制），或一個 App 只開一條 SSE 用 `event:` 分流不同類型事件。

**Q7：訊息保證不漏嗎？**
SSE 有 `Last-Event-ID` 斷點續傳機制，但**前提是後端要保留近期事件**（記憶體緩衝 / Redis Stream / DB）。後端沒存就無從補起。需要可靠送達就要自己設計補發邏輯（見 §5）。

---

## 12 總結

```
SSE 的完整圖像：

  本質    → 一個永不結束的 HTTP 回應（Content-Type: text/event-stream）
  方向    → 單向，伺服器→前端；前端要送資料另發一般 API
  格式    → data: / event: / id: / retry:，每則事件用空行 \n\n 作結
  前端    → 原生 EventSource，自動重連、自動帶 Last-Event-ID（幾乎免寫）
  韌性    → 後端認 Last-Event-ID 補送錯過的事件 → 斷點續傳
  保活    → 定期送註解行（: keep-alive）避免代理閒置切斷
  安全    → HTTPS + 身分驗證 + 嚴格 CORS + 逐則檢查權限
  部署    → 關 Nginx 緩衝與壓縮、拉長逾時、多機用 Redis 同步、優先 HTTP/2
```

記住幾個核心觀念，就不會踩大坑：

1. **單向就選 SSE** — 通知、進度、串流別反射性用 WebSocket，SSE 更簡單。
2. **自動重連是內建的** — `EventSource` 幫你重連 + 帶 `Last-Event-ID`，你只要在後端補資料。
3. **格式錯一個空行就收不到** — 每則事件結尾一定要 `\n\n`。
4. **上線不即時九成是代理緩衝** — 關 `proxy_buffering` 與壓縮是部署第一檢查項。
5. **多機要靠 Redis** — 一旦多台伺服器，就得用 Pub/Sub 把事件廣播到所有機器。

---

> 延伸閱讀：
> - [WebSocket 即時通訊實戰](./websocket.md) — 需要雙向互動時的選擇，與 SSE 互為補充
> - [第一章：HTTP 與 HTTPS 必備知識](./01-http-https.md) — SSE 完全建立在 HTTP 之上
> - [第二章：SSL 憑證](./02-ssl-certificates.md) — SSE 也應走 HTTPS，憑證設定同 HTTPS
> - [前後端 JWT 登入實戰](./jwt-auth-frontend-backend.md) — SSE 身分驗證最常用 JWT
> - [Promise、async/await](./promise-async-await-then.md) — `fetch` 串流解析是非同步流程
