# WebSocket 即時通訊實戰

> 從原理到實作，完整搞懂 WebSocket：與 HTTP 的差異、握手升級流程、前後端整合、心跳與斷線重連、身分驗證，以及上線前一定要避開的坑。

---

## 0 開始之前：為什麼需要 WebSocket？

傳統 HTTP 是**請求—回應（request-response）**模型：一定要前端先開口問，後端才能答。但很多場景需要「**伺服器主動推資料給前端**」：

- 聊天室、即時訊息
- 股價、加密貨幣即時報價
- 多人協作（共同編輯、白板）
- 即時通知、線上人數
- 遊戲狀態同步

在 WebSocket 出現前，大家用各種「假即時」的方式硬撐：

| 做法 | 原理 | 問題 |
|------|------|------|
| 短輪詢 Polling | 前端每隔幾秒發一次請求問「有沒有新資料」 | 大量無效請求、延遲高、浪費頻寬 |
| 長輪詢 Long Polling | 請求 hold 住直到有資料才回應，回應後馬上再發 | 連線反覆建立、伺服器負擔重 |
| SSE（Server-Sent Events） | 伺服器單向持續推送 | **只能伺服器→前端**，前端不能透過同一條通道回傳 |

> 💡 **WebSocket 的核心價值**：建立一條**全雙工（full-duplex）**、**長連線**的通道，雙方都能隨時主動送資料，且不必每次都帶 HTTP header，延遲極低。

---

## 1 WebSocket vs HTTP

```
HTTP（請求-回應）
  前端：請問有新訊息嗎？  →  後端：沒有
  前端：請問有新訊息嗎？  →  後端：沒有
  前端：請問有新訊息嗎？  →  後端：有一筆！
  （前端不問，後端永遠不會主動講）

WebSocket（全雙工長連線）
  前端 ⇄ 後端  握手一次，通道建立
  後端：有新訊息囉（主動推）
  前端：我要送一句話（主動送）
  （誰想講就講，不必先問）
```

| 比較項 | HTTP | WebSocket |
|--------|------|-----------|
| 通訊方向 | 單向（前端發起） | 全雙工（雙方皆可主動） |
| 連線 | 每次請求建立又關閉 | 一次握手，長連線維持 |
| 標頭開銷 | 每次都帶完整 header | 握手後僅少量 frame 標頭 |
| 協定 | `http://` / `https://` | `ws://` / `wss://` |
| 適用場景 | 一般 API、頁面載入 | 即時、雙向、高頻互動 |

> ⚠️ WebSocket **不是用來取代 HTTP** 的。讀取一次性資料、RESTful CRUD，HTTP 仍然更簡單合適。只有「需要即時雙向」時才用 WebSocket。

---

## 2 連線是怎麼建立的？握手（Handshake）

WebSocket 連線**借用 HTTP 來開場**，再「升級（Upgrade）」成 WebSocket 協定。

### 2.1 前端發出的升級請求

```http
GET /chat HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

### 2.2 伺服器同意升級

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

- 回應碼是 **101 Switching Protocols**（不是 200）。
- 握手成功後，這條 TCP 連線就不再講 HTTP，改用 WebSocket frame 通訊。
- `Sec-WebSocket-Accept` 是伺服器用前端送的 `Sec-WebSocket-Key` 加上一段固定字串做 SHA-1 算出來的，用來證明對方真的支援 WebSocket。

> 💡 因為握手是走 HTTP，所以 WebSocket 可以共用既有的 80 / 443 連接埠，**穿越大多數防火牆與代理伺服器**，不需要另開特殊 port。

---

## 3 `ws://` vs `wss://`（一定要用 wss）

| 協定 | 對應 | 加密 |
|------|------|------|
| `ws://` | 類比 `http://` | ❌ 明文傳輸 |
| `wss://` | 類比 `https://` | ✅ TLS 加密 |

> ⚠️ **生產環境永遠用 `wss://`**。理由：
> 1. `ws://` 內容明文可被竊聽，Token、訊息全都裸奔。
> 2. 在 HTTPS 頁面下，瀏覽器會**直接封鎖** `ws://` 連線（Mixed Content），根本連不上。

---

## 4 前端實作：原生 WebSocket API

瀏覽器內建 `WebSocket`，不需任何套件。

```js
// 建立連線
const ws = new WebSocket("wss://example.com/chat");

// 連線成功
ws.onopen = () => {
  console.log("已連線");
  ws.send(JSON.stringify({ type: "join", room: "general" }));
};

// 收到訊息
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("收到：", data);
};

// 連線關閉
ws.onclose = (event) => {
  console.log("已斷線", event.code, event.reason);
};

// 發生錯誤
ws.onerror = (err) => {
  console.error("錯誤：", err);
};

// 主動送資料（一定要在 onopen 之後才送）
function sendMessage(text) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "message", text }));
  }
}
```

### 4.1 `readyState` 的四種狀態

| 常數 | 值 | 意義 |
|------|----|------|
| `WebSocket.CONNECTING` | 0 | 連線中，還不能送資料 |
| `WebSocket.OPEN` | 1 | 已連線，可以收送 |
| `WebSocket.CLOSING` | 2 | 關閉中 |
| `WebSocket.CLOSED` | 3 | 已關閉 |

> ⚠️ **常見錯誤**：在 `onopen` 還沒觸發前就呼叫 `ws.send()`，會直接拋錯（`InvalidStateError`）。送資料前務必檢查 `readyState === WebSocket.OPEN`。

---

## 5 後端實作（Node.js + `ws`）

最常用的 Node.js 套件是 [`ws`](https://github.com/websockets/ws)。

```bash
npm install ws
```

### 5.1 最小可運作的伺服器

```js
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws, req) => {
  console.log("新連線來自", req.socket.remoteAddress);

  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    console.log("收到：", data);

    // 回給這個 client
    ws.send(JSON.stringify({ type: "ack", echo: data }));
  });

  ws.on("close", () => console.log("連線關閉"));
  ws.on("error", (err) => console.error("連線錯誤", err));
});
```

### 5.2 廣播給所有連線（聊天室核心）

```js
function broadcast(message, except) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    // readyState === 1 (OPEN) 才送，避免送給正在關閉的連線
    if (client.readyState === 1 && client !== except) {
      client.send(payload);
    }
  });
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    // 把訊息廣播給除了自己以外的所有人
    broadcast({ type: "message", text: data.text }, ws);
  });
});
```

---

## 6 ⭐ 心跳機制（Heartbeat）：偵測死連線

這是**最常被忽略、卻最重要**的一環。

問題：TCP 連線可能因為網路中斷、手機進隧道、NAT/防火牆閒置超時而「**悄悄斷掉**」——`onclose` 不一定會觸發，伺服器與前端都以為對方還在，但其實是「殭屍連線」。

解法：**雙方定期互相 ping/pong**，超時沒回應就主動斷線清理。

### 6.1 後端：定期 ping，沒回 pong 就終止

```js
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat); // 收到 pong 就標記為活著
});

// 每 30 秒巡一次
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate(); // 上一輪沒回 pong → 視為死連線，砍掉
    }
    ws.isAlive = false;
    ws.ping(); // 送 ping，等對方自動回 pong
  });
}, 30000);

wss.on("close", () => clearInterval(interval));
```

> 💡 `ws.ping()` / `pong` 是 WebSocket 協定層內建的控制 frame，瀏覽器會**自動回應 pong**，前端不用寫任何程式碼。但若前端是另一個 Node 服務，就要自己處理。

> ⚠️ 區分 `ws.close()` 與 `ws.terminate()`：
> - `close()` 走正常關閉流程（送 close frame、等對方確認），適合正常情況。
> - `terminate()` 直接強制斷開，適合處理死連線。

---

## 7 ⭐ 斷線自動重連（前端）

長連線一定會斷（網路波動、伺服器重啟、部署）。前端**必須**有重連機制，否則使用者一斷線就再也收不到訊息。

關鍵：用 **指數退避（exponential backoff）**，避免斷線當下所有 client 同時湧入打垮伺服器。

```js
class ReconnectingSocket {
  constructor(url, { maxRetries = Infinity } = {}) {
    this.url = url;
    this.maxRetries = maxRetries;
    this.retries = 0;
    this.shouldReconnect = true;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("已連線");
      this.retries = 0; // 連上就重置退避
    };

    this.ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      this.onMessage?.(data);
    };

    this.ws.onclose = () => {
      if (!this.shouldReconnect || this.retries >= this.maxRetries) return;

      // 指數退避：1s, 2s, 4s, 8s... 上限 30s，再加一點隨機抖動避免同時重連
      const delay = Math.min(1000 * 2 ** this.retries, 30000);
      const jitter = Math.random() * 1000;
      this.retries++;
      console.log(`${Math.round(delay + jitter)}ms 後重連（第 ${this.retries} 次）`);
      setTimeout(() => this.connect(), delay + jitter);
    };

    this.ws.onerror = () => this.ws.close();
  }

  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  close() {
    this.shouldReconnect = false; // 主動關閉時就別再重連
    this.ws.close();
  }
}

// 使用
const socket = new ReconnectingSocket("wss://example.com/chat");
socket.onMessage = (data) => console.log("收到：", data);
```

> ⚠️ **重連時要注意**：
> 1. 重連成功後通常要**重新發送身分驗證 / 重新加入房間**，否則伺服器不認得你。
> 2. 斷線期間漏掉的訊息怎麼補？常見做法是重連後帶上「最後收到的訊息 ID」，請後端補發之後的訊息。
> 3. 加上 **jitter（隨機抖動）**，避免「驚群效應」——伺服器一重啟，上萬 client 在同一毫秒同時重連。

---

## 8 ⭐ 身分驗證（Authentication）

WebSocket 沒有內建驗證機制，要自己做。**重點：WebSocket 的瀏覽器 API 不能自訂 header**，所以不能像一般 API 那樣帶 `Authorization: Bearer xxx`。

### 8.1 三種常見做法

| 做法 | 說明 | 評價 |
|------|------|------|
| Query string 帶 token | `wss://x.com/chat?token=xxx` | ⚠️ token 會被記進伺服器 log、瀏覽器歷史，**不建議放敏感 token** |
| 連線後第一則訊息送 token | 連上後立刻 `send({type:"auth", token})`，驗證過才算數 | ✅ 較安全，最常用 |
| Cookie（httpOnly） | 握手是 HTTP，會自動帶 cookie | ✅ 同網域時最安全，但跨網域要處理 CORS |

### 8.2 範例：連線後驗證 token

**前端**
```js
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "auth", token: accessToken }));
};
```

**後端**
```js
import jwt from "jsonwebtoken";

wss.on("connection", (ws) => {
  ws.authenticated = false;

  // 沒在 5 秒內驗證成功就踢掉
  const authTimer = setTimeout(() => {
    if (!ws.authenticated) ws.close(4001, "驗證逾時");
  }, 5000);

  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.type === "auth") {
      try {
        const payload = jwt.verify(data.token, process.env.JWT_SECRET);
        ws.userId = payload.sub;
        ws.authenticated = true;
        clearTimeout(authTimer);
        ws.send(JSON.stringify({ type: "auth_ok" }));
      } catch {
        ws.close(4003, "驗證失敗");
      }
      return;
    }

    // 沒驗證過的，其他訊息一律拒絕
    if (!ws.authenticated) {
      return ws.close(4001, "尚未驗證");
    }

    // ...處理已驗證使用者的訊息
  });
});
```

> ⚠️ Access Token 會過期。長連線期間若 token 過期，後端可主動斷線要求重新驗證，或設計「續期」訊息讓前端送新 token。延伸閱讀見 [JWT 登入實戰](./jwt-auth-frontend-backend.md)。

---

## 9 訊息設計：統一格式

長連線會傳各種訊息，**一開始就定好統一格式**，後面才好維護。常見用一個 `type` 欄位分流：

```json
{ "type": "message",  "payload": { "room": "general", "text": "hi" } }
{ "type": "join",     "payload": { "room": "general" } }
{ "type": "typing",   "payload": { "room": "general" } }
{ "type": "error",    "payload": { "code": "ROOM_NOT_FOUND" } }
```

後端用 type 分派：

```js
const handlers = {
  message: (ws, payload) => broadcast(payload),
  join: (ws, payload) => joinRoom(ws, payload.room),
  typing: (ws, payload) => notifyTyping(ws, payload.room),
};

ws.on("message", (raw) => {
  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return ws.send(JSON.stringify({ type: "error", payload: { code: "BAD_JSON" } }));
  }
  handlers[data.type]?.(ws, data.payload);
});
```

> 💡 二進位資料（圖片、音訊）可用 `ArrayBuffer` / `Blob` 直接傳，不必轉 base64。`ws.binaryType = "arraybuffer"` 設定接收型別。

---

## 10 完整實戰範例：即時聊天室

把前面所有觀念整合：身分驗證 + 房間 + 廣播 + 心跳。

### 10.1 後端（`server.js`）

```js
import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";

const wss = new WebSocketServer({ port: 8080 });
const rooms = new Map(); // roomName -> Set<ws>

function joinRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws.room = room;
}

function leaveRoom(ws) {
  if (ws.room && rooms.has(ws.room)) {
    rooms.get(ws.room).delete(ws);
  }
}

function broadcast(room, message, except) {
  const payload = JSON.stringify(message);
  rooms.get(room)?.forEach((client) => {
    if (client.readyState === 1 && client !== except) {
      client.send(payload);
    }
  });
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.authenticated = false;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // 1) 驗證
    if (msg.type === "auth") {
      try {
        const p = jwt.verify(msg.payload.token, process.env.JWT_SECRET);
        ws.userId = p.sub;
        ws.username = p.name;
        ws.authenticated = true;
        ws.send(JSON.stringify({ type: "auth_ok" }));
      } catch {
        ws.close(4003, "auth failed");
      }
      return;
    }

    if (!ws.authenticated) return ws.close(4001, "unauthorized");

    // 2) 業務邏輯
    switch (msg.type) {
      case "join":
        joinRoom(ws, msg.payload.room);
        broadcast(ws.room, {
          type: "system",
          payload: { text: `${ws.username} 加入了房間` },
        }, ws);
        break;
      case "message":
        broadcast(ws.room, {
          type: "message",
          payload: { from: ws.username, text: msg.payload.text },
        });
        break;
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
    if (ws.room) {
      broadcast(ws.room, {
        type: "system",
        payload: { text: `${ws.username} 離開了房間` },
      });
    }
  });
});

// 心跳
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(interval));

console.log("WebSocket 伺服器啟動於 ws://localhost:8080");
```

### 10.2 前端（搭配 §7 的 `ReconnectingSocket`）

```js
const socket = new ReconnectingSocket("wss://example.com/chat");

socket.onMessage = (data) => {
  switch (data.type) {
    case "auth_ok":
      socket.send({ type: "join", payload: { room: "general" } });
      break;
    case "message":
      appendMessage(`${data.payload.from}：${data.payload.text}`);
      break;
    case "system":
      appendSystem(data.payload.text);
      break;
  }
};

// 連上後先驗證（在 onopen 裡送）
const originalConnect = socket.connect.bind(socket);
socket.ws.onopen = () => {
  socket.send({ type: "auth", payload: { token: accessToken } });
};

// 送訊息
document.querySelector("#send").onclick = () => {
  const text = document.querySelector("#input").value;
  socket.send({ type: "message", payload: { text } });
};
```

---

## 11 上線部署注意事項

| 議題 | 說明與解法 |
|------|-----------|
| **Nginx 反向代理** | 預設不轉發 Upgrade header，WebSocket 會斷。必須加 `proxy_set_header Upgrade $http_upgrade;` 與 `proxy_set_header Connection "upgrade";` |
| **代理逾時** | Nginx 預設 `proxy_read_timeout` 60 秒，閒置連線會被切。要調大，或靠心跳保活 |
| **水平擴展** | 多台伺服器時，A 機的使用者廣播訊息，B 機的使用者收不到。需用 **Redis Pub/Sub** 或訊息佇列在多台之間同步 |
| **負載平衡黏性** | WebSocket 是長連線，LB 要設 sticky session 或用支援 WebSocket 的 LB |
| **連線數上限** | 每條連線佔記憶體與 file descriptor，要評估單機可承載連線數並做壓測 |

### 11.1 先搞懂 LB（負載平衡器）

**LB = Load Balancer（負載平衡器）**。當使用者很多、一台伺服器扛不住時，你會開**多台**後端，前面擺一台 LB 負責把進來的連線分配到後面哪一台。常見的有 Nginx、HAProxy、雲端的 ALB/ELB。

```
                  ┌─→ 伺服器 A
使用者 → [ LB ] ──┼─→ 伺服器 B
                  └─→ 伺服器 C
```

WebSocket 對 LB 特別敏感：一般 HTTP「問完就斷」，LB 每次都能自由分配；但 WebSocket 是**長連線**——握手時被分到 A 機，這條連線就要**一直黏在 A**。若 LB 中途把封包丟到 B 機，B 機不認得這條連線就斷了。

> ⚠️ 這就是「**負載平衡黏性（sticky session）**」要解決的事：設定讓同一條連線固定走同一台後端。

### 11.2 連線數上限由什麼決定？

「每條連線佔記憶體與 file descriptor」——這兩個是主要瓶頸：

| 限制 | 說明 | 相關配置 |
|------|------|---------|
| **File descriptor（fd）** | Linux 把每條 TCP 連線當成一個「檔案」，每條連線吃 1 個 fd。單一程序預設常只有 1024 個，很快就爆 | `ulimit -n`（程序層）、`/etc/security/limits.conf`、`fs.file-max`（系統層） |
| **記憶體** | 每條連線要存緩衝區與使用者狀態。假設一條吃 50KB，10 萬條就要約 5GB | 伺服器實體記憶體、程式裡每連線存多少資料 |
| **TCP 內核參數** | 大量連線時的 TCP 設定 | `net.core.somaxconn`、`net.ipv4.tcp_max_syn_backlog` |
| **應用層上限** | 框架或你自己設的「最多接受幾條連線」 | 程式碼裡的設定 |

> ⚠️ 最常見的第一個坑就是 `ulimit -n` 預設 1024——你以為機器很強，結果第 1024 條連線就連不上了。上線高併發 WebSocket 前一定要調大。

```bash
ulimit -n          # 查目前上限
ulimit -n 100000   # 暫時調大（重開 shell 會失效，永久要改 limits.conf）
```

### 11.3 Nginx 設定範例（逐行說明）

```nginx
location /chat {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # 拉長閒置逾時
}
```

| 行 | 意思 | 不寫會怎樣 |
|----|------|-----------|
| `location /chat {` | 只對網址路徑 `/chat` 套用這段設定（你的 WebSocket 端點） | — |
| `proxy_pass http://localhost:8080;` | 把這個路徑的請求**轉發**給後面真正的 WebSocket 伺服器（這裡是本機 8080 埠） | 請求沒地方去 |
| `proxy_http_version 1.1;` | 用 HTTP/1.1 跟後端溝通。**WebSocket 升級只有 HTTP/1.1 才支援**（Nginx 預設對後端用 1.0） | 升級失敗，連不上 |
| `proxy_set_header Upgrade $http_upgrade;` | 把瀏覽器送來的 `Upgrade: websocket` 標頭**原封不動轉發**給後端 | 後端收不到升級請求，當成普通 HTTP |
| `proxy_set_header Connection "upgrade";` | 告訴後端「這是一個要升級協定的連線」，和上一行搭配才完整（呼應 §2 握手） | 握手不成立 |
| `proxy_set_header Host $host;` | 把使用者原本要連的網域名稱傳給後端（否則後端看到的 Host 變成 localhost） | 後端拿到錯的 Host，虛擬主機 / 憑證可能出錯 |
| `proxy_read_timeout 3600s;` | 後端**多久沒送資料就視為逾時切斷**，預設只有 60 秒，閒置會被誤砍，故拉長 | 沒訊息時連線 60 秒後被切（要靠心跳或調這個值） |

> 💡 核心就是中間三行（`proxy_http_version` + 兩個 `proxy_set_header`）：它們讓 §2 講的「HTTP 升級握手」能穿過 Nginx 傳到後端。少了它們，瀏覽器和後端都支援 WebSocket 卻會卡在 Nginx 這關——這是部署時最常見的踩雷。

> 💡 多台伺服器的廣播同步，與其自己用 Redis 串，不如直接用成熟的即時框架（如 [Socket.IO](https://socket.io/) 搭配 `@socket.io/redis-adapter`），它已內建房間、重連、退化方案（fallback 到 long polling）與多機 adapter。

---

## 12 安全注意事項（務必檢查）

- ✅ **永遠用 `wss://`**（TLS 加密），不要用 `ws://`。
- ✅ **驗證 Origin**：握手時檢查 `req.headers.origin`，拒絕非預期來源，防止 **CSWSH（跨站 WebSocket 劫持）**。
- ✅ **一定要做身分驗證**，別假設「能連上的都是好人」。
- ✅ **驗證每一則訊息的格式與權限**：使用者只能操作自己有權限的房間 / 資源，後端逐則檢查。
- ✅ **限制訊息大小與頻率**（rate limit），防止單一連線灌爆伺服器。
- ✅ **絕不信任前端傳來的 userId**：身分一律從後端驗證過的 token 取得，不要讀前端送的欄位。

```js
// 驗證 Origin 範例
const ALLOWED_ORIGINS = ["https://example.com"];
const wss = new WebSocketServer({
  port: 8080,
  verifyClient: (info, done) => {
    if (ALLOWED_ORIGINS.includes(info.origin)) return done(true);
    done(false, 403, "Forbidden origin");
  },
});
```

> ⚠️ **CSWSH 是 WebSocket 特有的攻擊**：因為瀏覽器發 WebSocket 握手時會自動帶上 cookie，惡意網站可以誘導已登入的使用者連到你的 WebSocket 並冒用其身分。光靠 cookie 驗證不夠，務必**檢查 Origin** 或改用一次性 token。

---

## 13 常見問題 FAQ

**Q1：WebSocket 和 Socket.IO 是同一個東西嗎？**
不是。WebSocket 是**瀏覽器原生協定**；Socket.IO 是建立在 WebSocket（以及 long polling fallback）**之上的函式庫**，多了房間、自動重連、多機 adapter 等功能。原生 WebSocket 的 client 不能直接連 Socket.IO 伺服器，反之亦然。

**Q2：什麼時候該用 SSE 而不是 WebSocket？**
若只需要**伺服器單向推送**（如即時通知、股價看板），且不需要前端透過同通道回傳，SSE 更輕量、走純 HTTP、自動重連也內建。需要**雙向高頻互動**（聊天、遊戲）才用 WebSocket。

**Q3：連線可以維持多久？會自動斷嗎？**
協定本身沒有時間上限，但實務上會被中間的代理、防火牆、行動網路因「閒置」而切斷。所以**心跳機制是必備的**（見 §6）。

**Q4：一個瀏覽器分頁可以開幾條 WebSocket？**
沒有像 HTTP 那樣嚴格的「每網域 6 條」限制（瀏覽器對 WebSocket 上限通常很高，數十到數百）。但**一般建議一個 App 共用一條連線**，用訊息 type 分流，而不是每個功能各開一條。

**Q5：訊息一定會照順序到達嗎？**
同一條 WebSocket 連線基於 TCP，**單向訊息是保證順序**的。但若你斷線重連，重連後的新連線與舊連線之間就沒有順序保證，要靠訊息 ID 自行對齊。

**Q6：要怎麼知道對方真的收到訊息了？**
WebSocket 的 `send()` 只代表「丟進傳送緩衝區」，不代表對方收到。若需要可靠送達，要自己設計 **ACK 機制**：收到方回一則 `{type:"ack", id}`，送出方沒收到 ack 就重送。

---

## 14 總結

```
WebSocket 的完整圖像：

  建立    → 借 HTTP 握手（101 Switching Protocols）升級成長連線
  協定    → 生產環境一律 wss://（TLS 加密）
  通訊    → 全雙工，雙方隨時主動收送，用 type 欄位統一訊息格式
  保活    → 心跳（ping/pong）偵測死連線，超時 terminate
  韌性    → 前端指數退避 + jitter 自動重連，重連後重新驗證 / 補訊息
  安全    → 身分驗證 + 驗 Origin（防 CSWSH）+ 逐則檢查權限 + rate limit
  部署    → Nginx 轉發 Upgrade header、拉長逾時、多機用 Redis 同步
```

記住幾個核心觀念，就不會踩大坑：

1. **WebSocket 不取代 HTTP** — 只有「即時雙向」才用它，一般 API 還是 HTTP。
2. **長連線一定會斷** — 心跳偵測 + 自動重連是必備，不是加分項。
3. **沒有內建驗證與安全** — 身分驗證、Origin 檢查、權限與頻率限制全要自己做。
4. **單機會遇到擴展牆** — 一旦要多台伺服器，就得用 Redis / 訊息佇列同步廣播。

---

> 延伸閱讀：
> - [第一章：HTTP 與 HTTPS 必備知識](./01-http-https.md) — WebSocket 握手就是走 HTTP，升級概念的基礎
> - [第二章：SSL 憑證](./02-ssl-certificates.md) — `wss://` 背後就是 TLS，憑證設定同 HTTPS
> - [前後端 JWT 登入實戰](./jwt-auth-frontend-backend.md) — WebSocket 身分驗證最常用 JWT
> - [Promise、async/await](./promise-async-await-then.md) — 前端連線、重連、訊息處理都是非同步流程
