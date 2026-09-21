# 第 08 章：WebSocket 與 STOMP

> 05 章的 5.11 用 `SseEmitter` 解決了「伺服器主動推」。
> 那一章的選型表留了一列沒有落地：**「客服的即時聊天 → WebSocket，真的需要雙向」**。
> 這一章就是那一列。
>
> 但這一章真正的內容不是「怎麼開一條 WebSocket」——
> 那件事 Spring 只要三個註解，二十分鐘就能跑起來，而且在你的筆電上**完全正常**。
>
> **這一章的每一節都在回答同一個問題：**
> 當「一條連線要活著好幾個小時、而且兩邊都能隨時說話」時，
> 前七章建立的所有機制——例外處理、Filter、認證、CORS、測試——**哪些還在？**
>
> 答案會讓你不太舒服：**幾乎都不在了。**

---

## 8.1 學習目標

完成本章後，你應該可以：

- 說出 WebSocket 握手在 wire 上長什麼樣，以及 `101 Switching Protocols` 之後**那條 TCP 連線上還有沒有 HTTP**。
- 說明 `Sec-WebSocket-Key` / `Sec-WebSocket-Accept` 的真正用途——**它不是安全機制**，而且知道這件事會直接改變你的防護設計。
- 說出 close code 的四個區段，以及 `1006` 為什麼**永遠不會出現在網路上**。
- 判斷一個需求該用 SSE 還是 WebSocket，並說出**三個決定性的判準**（不是「要不要雙向」）。
- 說明為什麼原生 `WebSocketHandler` 寫到第三個功能時，你會**自己長出一個半成品的 STOMP**。
- 寫出 `@EnableWebSocketMessageBroker` 的完整設定，並解釋四個 destination 前綴各自由誰處理。
- **說明 `/user/**` 的路由機制**——它是怎麼在多實例下把訊息送到正確那一台的（以及它為什麼預設辦不到）。
- **說出 `WebSocketSession` 不是執行緒安全的**，以及兩條執行緒同時 `sendMessage()` 的具體後果。
- 說明為什麼瀏覽器的 `new WebSocket()` **不能帶 `Authorization` header**，並在四種替代做法中做出有理由的選擇。
- **說出為什麼把 JWT 放在 WebSocket 的 URL query string 裡是一個會寫進 access log 的洩漏**。
- 說明為什麼 **WebSocket 不受同源政策保護**，以及 `Origin` 檢查為什麼從「建議」變成「必要」。
- 說出三層心跳（TCP keepalive / WebSocket ping-pong / STOMP heartbeat）各自偵測什麼，以及**為什麼前者救不了你**。
- **說明半開連線（half-open connection）的成因**，以及為什麼「連線數只增不減」是它的第一個症狀。
- **解釋多實例部署下訊息為什麼會消失**，並在 sticky session / Redis pub/sub / 外部 broker 三者間做出選擇。
- 說出 Redis pub/sub 做扇出時**不保證送達**的三個時機，以及什麼情況下這是可接受的。
- 寫出讓 WebSocket 能穿過 Nginx 的設定，並說明 `proxy_read_timeout` 對長連線的實際意義。
- 為 WebSocket 端點寫出測試——包含**不需要真的開一條連線**的那種。

---

## 8.2 先看見痛：四次真實事故

### 8.2.1 事故一：上線第一天，一半的訊息不見了

**背景**：客服聊天功能，開發與測試環境都是單一實例，跑了三週完全正常。
正式環境是 **3 個 pod**。

**現象**：上線當天，客服回報「客人說沒收到我的訊息」，但**不是每一次**。
客服自己重新整理頁面之後，訊息又突然出現了。

QA 反覆測試後給出的描述是：

```
成功率大約三分之一。
```

這個數字就是答案。

```
客人 A 的瀏覽器  ──WebSocket──→  pod-1   （連線活在 pod-1 的記憶體裡）
客服 B 的瀏覽器  ──WebSocket──→  pod-3   （連線活在 pod-3 的記憶體裡）

客服 B 送出「您好，請問訂單編號？」
  → 打到 pod-3
  → pod-3 執行 simpMessagingTemplate.convertAndSendToUser("A", ...)
  → pod-3 查自己的 session registry：「A 不在我這裡」
  → 🔴 訊息被安靜地丟掉，沒有例外、沒有日誌、沒有指標
```

3 個 pod，客人與客服**剛好落在同一台**的機率是 1/3。

⚠️ **這個事故最可怕的地方不是「會掉訊息」，是「它不報錯」。**
`convertAndSendToUser()` 找不到使用者時的行為是 **no-op**——
沒有回傳值、沒有例外、沒有警告日誌。
在 05 章 5.11.6 的 SSE 那裡，這個問題至少還有一個 `SseEmitterRegistry` 讓你看得到連線數；
STOMP 的 `SimpUserRegistry` 預設是**本機的**，而它看起來完全正常（只是少了三分之二的人）。

> **對照 05 章**：5.11.6 講的是同一件事的 SSE 版本，結論也一樣。
> 差別在 SSE 是「單向、事件由伺服器產生」，你至少知道事件的來源在哪一台；
> WebSocket 是「雙向、事件由另一個使用者產生」，**兩端都可能在錯的機器上**。
> 8.10 會處理這件事。

### 8.2.2 事故二：`Principal` 是 null，而 Security 設定完全正確

**現象**：`@MessageMapping` 的方法裡，`Principal` 永遠是 `null`。

```java
@MessageMapping("/chat.send")
public void send(ChatMessage msg, Principal principal) {
    log.info("使用者 {} 送出訊息", principal.getName());   // 🔴 NullPointerException
}
```

開發者的第一反應是「Security 設定錯了」，於是花了兩天檢查 `SecurityFilterChain`、
確認 `/ws/**` 有沒有被 `permitAll()`、加了 `@EnableWebSocketSecurity`……全部沒用。

**真正的原因在前端**：

```javascript
// 前端這樣寫，看起來完全合理
const socket = new WebSocket("wss://shop.example/ws");
```

瀏覽器的 `WebSocket` 建構子**只接受兩個參數**（`url` 與 `protocols`）。
**它沒有地方放 header。**

```
前端 fetch：
  fetch(url, { headers: { Authorization: "Bearer eyJ..." } })   ✅ 可以

前端 WebSocket：
  new WebSocket(url, { headers: ... })                          🔴 第二個參數是 subprotocol，不是 options
```

所以那個握手請求**根本沒有帶 token**。
Spring Security 的 filter chain 確實跑過了（`/ws/**` 是 `permitAll()`），
它正確地判斷「這是一個匿名請求」，於是 `Principal` 是 `null`——
**每一層都正確地執行了自己的職責，而結果是錯的。**

⚠️ 這個事故的真正代價是**那兩天的方向錯誤**。
症狀（`Principal` 是 null）指向後端，原因在前端的協定限制。
8.8 會把四種做法攤開，包含它們各自會把 token 洩漏到哪裡。

### 8.2.3 事故三：連線數只增不減，直到 pod 被 OOMKilled

**監控圖**：`websocket.sessions.active` 這條線從上線後**單調遞增**，
三天後到達 8,000，pod 開始被 Kubernetes `OOMKilled`，重啟後歸零，再一次單調遞增。

當時的疑問很合理：

```
我們的 DAU 只有 1,200 人。
為什麼會有 8,000 條「活著的」連線？
```

**因為它們不是活著的。**

```
使用者的手機從 Wi-Fi 切換到 4G
  → 手機端的 TCP 連線直接消失（換了 IP，沒有機會送 FIN）
  → 🔴 伺服器這端完全不知道
  → 伺服器的 WebSocketSession 仍然在 registry 裡
  → 仍然佔著一個 Tomcat connection slot
  → 仍然佔著記憶體裡的訂閱狀態
  → 永遠不會被清掉
```

這叫**半開連線（half-open connection）**。

「那 TCP keepalive 呢？」——Linux 的預設值是：

```
net.ipv4.tcp_keepalive_time   = 7200   # 閒置 2 小時後才送第一個探測
net.ipv4.tcp_keepalive_intvl  = 75     # 每 75 秒重試一次
net.ipv4.tcp_keepalive_probes = 9      # 重試 9 次才放棄
```

**2 小時 + 75 × 9 秒 ≈ 2 小時 11 分鐘。**
而且 Java 預設**根本沒開** `SO_KEEPALIVE`。

⚠️ 這就是為什麼 **WebSocket 的心跳不是可選項**。
05 章 5.11.4 已經對 SSE 講過一次「心跳不能省」，理由是「中間層會回收閒置連線」；
WebSocket 多了一個更嚴重的理由：**你需要它來知道對方還在不在**。8.9 會拆三層來看。

### 8.2.4 事故四：本機完全正常，測試環境 `400 Bad Request`

```
WebSocket connection to 'wss://staging.shop.example/ws' failed:
Error during WebSocket handshake: Unexpected response code: 400
```

後端日誌**一行都沒有**。請求根本沒進到應用程式。

Nginx 的設定長這樣（一個非常標準、看起來沒有問題的反向代理設定）：

```nginx
location / {
    proxy_pass http://shop_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

**問題在於 `proxy_set_header` 沒有出現的兩個 header**：

```http
Upgrade: websocket
Connection: Upgrade
```

Nginx 與後端之間預設是 **HTTP/1.0**，而 `Upgrade` 是一個 **hop-by-hop header**——
依照 RFC 7230，代理**必須**把它拿掉，不能原樣轉發。
於是到達 Tomcat 的是一個沒有 `Upgrade` 的普通 GET 請求，
Tomcat 看到 `/ws` 這條路徑被註冊成 WebSocket 端點、卻收到非升級請求，回 `400`。

> **這和 05 章 5.2.4 的 SSE 事故是同一個家族**：
> 「本機沒有 Nginx」。差別在 SSE 的症狀是**安靜的**（連線建立了，但事件被 buffer 攢住），
> WebSocket 的症狀是**大聲的**（直接 400）。
> 大聲的錯誤其實比較幸運。8.11 會給完整設定。

### 8.2.5 這四個痛的共同點

| 事故 | 表面症狀 | 真正的機制 | 在哪一節解決 |
|---|---|---|---|
| 訊息掉三分之二 | 「有時候收不到」 | **狀態在單一 pod 的記憶體裡**，而連線分散在多台 | 8.10 |
| `Principal` 是 null | 以為是 Security 設定 | **瀏覽器的 WebSocket API 不能帶 header** | 8.8 |
| 連線數只增不減 | OOMKilled | **TCP 不會告訴你對方消失了** | 8.9 |
| 握手 400 | 本機正常 | **`Upgrade` 是 hop-by-hop header** | 8.11 |

它們指向同一件事：

> **WebSocket 把「請求」換成了「連線」，而你前七章建立的每一個機制都是為「請求」設計的。**

一個請求是**無狀態、短命、被 filter chain 包住、有明確的開始與結束**的。
一條 WebSocket 連線是**有狀態、長命、只在第一個瞬間經過 filter chain、而且沒有人會告訴你它什麼時候結束**的。

這一章剩下的部分，就是把這四件事一件一件補回來。

---

## 8.3 從 SSE 到 WebSocket：什麼時候該換

### 8.3.1 「要不要雙向」是一個會騙你的判準

05 章 5.11.1 那張表的最後一欄是 WebSocket，而選型理由寫的是「真的需要雙向」。
那是入門的講法。**實際上它會讓你做錯決定**，因為：

```
前端要送資料給後端 —— 本來就可以，用 POST 就好。
```

「雙向」從來不是問題。你已經有 HTTP 了。

**真正的判準是這三個**：

| # | 判準 | 為什麼它才是關鍵 |
|---|---|---|
| **1** | **上行訊息的頻率**高到 POST 的成本無法忍受 | 每個 POST 要 TCP（連線重用的話省了）、TLS、完整 header、Security filter chain、可能還有一次 DB 查 session。**一則聊天訊息 800 bytes 的 header 配 30 bytes 的內容**。WebSocket frame 的 header 是 **2～14 bytes** |
| **2** | **上行需要低延遲**，且延遲的來源是「建立連線」而不是「處理」 | 遊戲、協作編輯的游標位置、即時白板。⚠️ 如果你的瓶頸是後端處理要 200ms，那省下的 10ms 沒有意義 |
| **3** | **伺服器要對「這個特定連線」回話**，而不是對「這個使用者」 | 多分頁、多裝置時的差別。SSE + POST 的組合裡，後端不知道這個 POST 來自哪一條 SSE 連線 |

**如果三個都不成立，用 SSE + POST。** 它幾乎總是正確答案，理由在 5.11.1 那張表裡已經列完了
（瀏覽器自動重連、`Last-Event-ID` 斷線續傳、普通 HTTP 所以 Security / CORS / 例外處理全部照舊）。

### 8.3.2 決策流程

```
需要伺服器主動推資料嗎？
  │
  ├─ 否 → 用一般的 REST（別想太多）
  │
  └─ 是
      │
      ├─ 推送頻率 < 每分鐘幾次，且能接受 5～30 秒延遲？
      │     → 輪詢（5.10）。⚠️ 認真的：這常常是正解，而且沒有長連線的任何問題
      │
      ├─ 只有伺服器→前端，前端的動作用一般 API 就夠？
      │     → SSE（5.11）★ 預設選這個
      │
      └─ 上行頻率高 / 需要低延遲 / 要對特定連線回話？
            │
            ├─ 訊息有明確的「主題」與「訂閱」概念？
            │     → WebSocket + STOMP（8.7）★
            │
            └─ 只有一種訊息、或協定已經被別人定死（如既有的交易所 API）？
                  → 原生 WebSocketHandler（8.6）
```

### 8.3.3 shop-service 的決定

沿用 05 章 5.11.1 的那張表，把最後一列補完：

| 需求 | 選擇 | 理由 |
|---|---|---|
| 訂單狀態即時更新（顧客端） | **SSE** + HTTP/2 | 單向推送，瀏覽器自動重連是巨大的優勢（5.11） |
| 匯出工作進度 | **輪詢**（5.10） | 輪詢 6 次就完成，不值得開一條長連線 |
| 倉庫掃描槍的即時看板 | **SSE** | 單向，而且掃描槍的瀏覽器很舊 |
| **客服的即時聊天** | **WebSocket + STOMP** ★ | 判準 1（上行頻率）與判準 3（要對特定連線回話：客服同時開五個對話視窗）**同時成立** |

⚠️ **注意 shop-service 只有一個功能用 WebSocket。**
這不是巧合，是這一章想傳達的第一件事：
**WebSocket 是一個你應該用得很少的工具**，因為它的每一個運維問題都比 HTTP 貴一個數量級。

---

## 8.4 協定機制

### 8.4.1 握手：一個會變身的 HTTP 請求

WebSocket 連線的**第一個**封包是一個完全合法的 HTTP GET：

```http
GET /ws HTTP/1.1
Host: shop.example
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: v10.stomp
Origin: https://shop.example
Cookie: SESSION=8f2a1c94...
```

伺服器同意的回應：

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
Sec-WebSocket-Protocol: v10.stomp
```

**`101` 之後，那條 TCP 連線上就再也沒有 HTTP 了。**

這句話要真的理解，因為它決定了這一章後面所有的麻煩：

| 你以為還在的東西 | 實際上 |
|---|---|
| `Filter` chain | 🔴 只在**握手那一個**請求跑過一次。之後的每一則訊息都不經過 |
| `@ControllerAdvice` | 🔴 完全不適用。它掛在 `HandlerExceptionResolver` 上，而那是 MVC 的東西 |
| HTTP 狀態碼 | 🔴 沒有了。錯誤要用 close code（8.4.4）或應用層的錯誤訊息 |
| `Cookie` | ⚠️ **只有握手那一次**會送。之後的 frame 不帶任何 header |
| CORS | 🔴 **不適用**。瀏覽器不對 WebSocket 做同源檢查（8.8.6，這是一個安全問題） |
| `Content-Type` / 內容協商 | 🔴 沒有了。只有「文字 frame」與「二進位 frame」兩種 |
| Spring Security 的授權規則 | ⚠️ 只保護握手。訊息層要另外設（8.8.5） |

> **這是本章最重要的一張表。** 04 章花了 7,269 行講請求生命週期、
> 03 章花了 7,217 行講全域例外處理——**在 `101` 之後，那兩章的東西全部下線。**
> 8.8 與 8.12 要把其中該補的部分一個一個接回來。

### 8.4.2 `Sec-WebSocket-Key` 不是安全機制 ★

這是最常見的誤解，而且它會直接導致錯誤的防護設計。

`Sec-WebSocket-Accept` 的算法是**完全公開、沒有任何秘密**的：

```
accept = base64( sha1( Sec-WebSocket-Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11" ) )
```

那串 GUID 寫在 RFC 6455 裡。任何人都可以算。

**那它為什麼存在？** 為了防止**快取污染攻擊**：

```
假設沒有這個機制：

攻擊者讓受害者的瀏覽器對一個「看起來像 WebSocket 升級」的 URL 發請求
  → 中間有一個不懂 WebSocket 的舊代理
  → 代理把它當成普通 GET，把回應「快取」起來
  → 🔴 攻擊者事先安排的內容被當成該 URL 的合法回應，快取給所有人

有了 Sec-WebSocket-Key / Accept：
  → 代理無法產生正確的 Accept（因為 Key 是隨機的）
  → 握手失敗，連線不會建立
```

⚠️ **所以它證明的是「對方真的是一個 WebSocket 伺服器」，不是「對方是誰」。**
它**不提供**任何：

- 身分驗證 → 要自己做（8.8）
- 完整性保護 → 靠 TLS（`wss://`）
- 重放保護 → 要自己做
- 來源驗證 → 靠 `Origin` 檢查，而**那要你自己開**（8.8.6）

同理，frame 的 **masking** 也不是加密：

> 客戶端送出的每個 frame 都要用一個 4 bytes 的隨機 key 對 payload 做 XOR。
> 這是為了**防止惡意 JavaScript 構造出「看起來像 HTTP 請求」的 frame 去污染中間代理的快取**，
> 而不是為了機密性。**key 就明文寫在 frame 標頭裡。**
> 機密性 100% 來自 TLS。

### 8.4.3 frame 的成本：為什麼它比 HTTP 省

```
WebSocket frame（文字，30 bytes payload，客戶端送）
┌────────┬────────┬──────────────┬───────────────┐
│ 1 byte │ 1 byte │   4 bytes    │   30 bytes    │
│ FIN+op │ mask+len│  mask key   │  masked data  │
└────────┴────────┴──────────────┴───────────────┘
總共 36 bytes

同樣 30 bytes 內容的 POST
  POST /chat/messages HTTP/1.1          → 30
  Host: shop.example                     → 20
  Content-Type: application/json         → 32
  Content-Length: 30                     → 20
  Cookie: SESSION=...                    → 60
  User-Agent: Mozilla/5.0 (...)          → 120
  Accept / Accept-Encoding / ...         → 100+
  Authorization: Bearer eyJhbGci...      → 400+（JWT 很大）
  ────────────────────────────────────────────
  header 約 800 bytes + 30 bytes 內容
```

**約 22 倍。** 這就是 8.3.1 判準 1 的具體數字。

⚠️ 但請注意：**HTTP/2 的 HPACK 標頭壓縮會把重複的 header 壓到幾個 byte。**
如果你已經在用 HTTP/2，這個差距會小非常多（大約 3～5 倍而不是 22 倍）。
**「WebSocket 省頻寬」這個理由在 HTTP/2 之後弱化了不少**——
判準 2 與 3 通常才是真正的決定因素。

### 8.4.4 close code：唯一還能傳遞「為什麼」的機制 ★

`101` 之後沒有狀態碼了。關閉連線時能帶的只有一個 **2 bytes 的 close code** 與一段 reason 文字。

| 區段 | 用途 | 常見值 |
|---|---|---|
| `1000`～`2999` | **協定保留**，由 RFC 定義 | `1000` 正常關閉、`1001` 端點離開（分頁關掉）、`1008` 政策違反、`1011` 伺服器內部錯誤 |
| `3000`～`3999` | 註冊給函式庫 / 框架 | 較少用 |
| **`4000`～`4999`** | **應用程式自訂** ★ | **你自己的錯誤碼放這裡** |

**三個一定要知道的值**：

| code | 意義 | ⚠️ 陷阱 |
|---|---|---|
| `1006` | 「異常關閉」 | **它永遠不會在網路上傳輸。** 這是瀏覽器在「連線斷了但沒收到 close frame」時自己填的。看到 `1006` = 沒有完成關閉握手 = 通常是網路斷了、中間層砍了連線、或伺服器直接 `kill -9` |
| `1001` | 端點離開 | 使用者關分頁 / 重新整理時瀏覽器送的。**這是正常的**，不要記成 error 等級 |
| `1009` | 訊息太大 | 對方送了超過你設定上限的 frame。⚠️ 預設上限通常只有 **64 KB**（8.12.2 會設定） |

**shop-service 的自訂 code**：

```
4001  token 過期        → 前端應該刷新 token 後重連
4002  token 無效        → 前端應該導向登入頁，不要重連
4003  被踢下線（同帳號在別處登入）→ 不要重連
4008  訊息頻率過高      → 前端應該退避後重連
4029  伺服器連線數已滿  → 前端應該長退避後重連
```

⚠️ **「要不要重連」必須由 close code 決定，不能一律重連。**
`4002`（token 無效）如果前端無腦重連，就會變成一個**每 3 秒打一次握手的無限迴圈**，
而每一次握手都要跑完整的 Security filter chain 與一次 DB 查詢。
這是 05 章 5.11.9「SSE 的 `complete()` 造成每 3 秒重連」的同款事故，
差別在 WebSocket 至少給了你一個能表達意圖的欄位——**用它**。

---

## 8.5 Spring 的兩層 API：原生 vs STOMP

### 8.5.1 兩層的位置

```
┌─────────────────────────────────────────────────────────┐
│  @MessageMapping / @SendTo / SimpMessagingTemplate       │  ← STOMP 層
│  （destination、訂閱、使用者路由、訊息轉換器）              │     8.7
├─────────────────────────────────────────────────────────┤
│  WebSocketHandler                                        │  ← 原生層
│  （handleTextMessage / afterConnectionEstablished）       │     8.6
├─────────────────────────────────────────────────────────┤
│  RFC 6455 frame（FIN、opcode、mask、payload）             │  ← 協定層 8.4
└─────────────────────────────────────────────────────────┘
```

需要的相依只有一個，兩層都在裡面：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-websocket</artifactId>
</dependency>
```

### 8.5.2 為什麼原生 API 寫到第三個功能就會長出半個 STOMP ★

這一節的目的不是勸退，是讓你**看見 STOMP 解決的到底是什麼問題**。

假設你用原生 `WebSocketHandler` 做聊天，需求一個一個加：

**需求 1：使用者送訊息，廣播給所有人。**

```java
public void handleTextMessage(WebSocketSession session, TextMessage message) {
    for (WebSocketSession s : sessions) {
        s.sendMessage(message);
    }
}
```

很簡單。到這裡原生 API 完全夠用。

**需求 2：加上「正在輸入中…」的提示。**

現在一條連線上有兩種訊息了，你必須能分辨。於是你在 payload 裡加一個欄位：

```json
{ "type": "CHAT",   "text": "您好" }
{ "type": "TYPING", "user": "A"  }
```

> 你剛剛發明了 **frame 型別**。

**需求 3：客服同時處理五個對話，訊息不能互相竄。**

```json
{ "type": "CHAT", "room": "conv-8812", "text": "您好" }
```

> 你剛剛發明了 **destination**。

**需求 4：客服不想收到全部五個對話的訊息，只想收目前開著的那一個。**

於是你要讓前端能說「我要訂這個、退訂那個」：

```json
{ "type": "SUBSCRIBE",   "room": "conv-8812" }
{ "type": "UNSUBSCRIBE", "room": "conv-8813" }
```

而後端要維護一份 `Map<room, Set<session>>`。

> 你剛剛發明了 **訂閱機制**。

**需求 5：前端送出訊息後要知道「伺服器收到了」（打勾的 UI）。**

```json
{ "type": "CHAT", "room": "...", "receipt": "r-42", "text": "..." }
{ "type": "ACK",  "receipt": "r-42" }
```

> 你剛剛發明了 **receipt**。

**需求 6：心跳。**（8.9）

> 你剛剛發明了 **heartbeat 協商**。

---

**這六個東西加起來，就是 STOMP。**

| 你自己長出來的 | STOMP 的對應 |
|---|---|
| `type` 欄位 | STOMP command（`SEND` / `SUBSCRIBE` / `MESSAGE` / `RECEIPT`…） |
| `room` 欄位 | `destination` header |
| 自己維護的 `Map<room, Set<session>>` | broker 的訂閱表 |
| `SUBSCRIBE` / `UNSUBSCRIBE` | 同名的 STOMP frame |
| `receipt` | `receipt` / `RECEIPT` |
| 自己寫的 ping/pong | `heart-beat` header 協商 |

⚠️ **差別在於**：你自己那份是**只有你們團隊懂**的、沒有規格文件的、沒有現成前端函式庫的、
沒有人幫你想過邊界情況的協定。STOMP 是一份公開規格，前端有 `@stomp/stompjs`，
而且——**這是最重要的一點**——你之後想換成 RabbitMQ / ActiveMQ 當 broker 時（8.10.2），
它們原生就講 STOMP。

### 8.5.3 那什麼時候不要用 STOMP

| 情況 | 用原生 | 理由 |
|---|---|---|
| 只有**一種**訊息，且永遠不會有第二種 | ✅ | 例如一個純粹的即時股價推送。STOMP 的每個 frame 多 30～80 bytes 的文字 header |
| 協定**已經被別人定死** | ✅ | 串接交易所、IoT 裝置、遊戲引擎的既有協定 |
| 傳**二進位**且對每 byte 錙銖必較 | ✅ | STOMP 是文字導向的（雖然支援 binary body） |
| 需要訂閱 / 多主題 / 多人 | 🔴 用 STOMP | 否則你會重寫 8.5.2 |
| 以後可能要接外部 broker | 🔴 用 STOMP | 見 8.10.2 |

**shop-service 的客服聊天用 STOMP**（多對話 = 多 destination，需求 3、4 直接成立）。
但 8.6 還是要講原生層，因為**STOMP 跑在它上面**，而 8.6.2 那個執行緒安全的陷阱**兩層都會中**。

---

## 8.6 原生 WebSocket：最小實作與兩個陷阱

### 8.6.1 `TextWebSocketHandler`

```java
package example.shop.chat.web.ws;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * 原生 WebSocket handler —— 這裡只作為理解 STOMP 底層的範例，
 * shop-service 的聊天功能實際上用 8.7 的 STOMP。
 *
 * <p>★ 四個回呼對應連線的完整生命週期，而它們<b>都不在請求執行緒上</b>：
 * <ul>
 *   <li>{@code afterConnectionEstablished} —— 握手完成，可以開始送訊息</li>
 *   <li>{@code handleTextMessage} —— 收到一個文字 frame</li>
 *   <li>{@code handleTransportError} —— 傳輸層出錯（此時連線通常已經不能用了）</li>
 *   <li>{@code afterConnectionClosed} —— 連線結束，<b>清理一定要寫在這裡</b></li>
 * </ul>
 *
 * <p>⚠️ {@code afterConnectionClosed} <b>不保證被呼叫</b>：
 * 行程被 {@code kill -9}、或半開連線（8.2.3）的情況下它永遠不會來。
 * 所以清理邏輯不能是「唯一的」資源回收路徑 —— 必須搭配心跳（8.9）。
 */
public class EchoWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(EchoWebSocketHandler.class);

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        // ⚠️ session.getPrincipal() 在這裡可能是 null —— 見 8.2.2 與 8.8
        log.info("連線建立 id={} principal={}", session.getId(), session.getPrincipal());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
            throws Exception {
        // ⚠️ 這裡拋出的例外【不會】進到 @ControllerAdvice（8.4.1 那張表）
        session.sendMessage(new TextMessage("echo: " + message.getPayload()));
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("傳輸錯誤 id={}", session.getId(), exception);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        // ★ status.getCode() == 1006 表示沒有完成關閉握手（8.4.4）
        log.info("連線關閉 id={} code={} reason={}",
                session.getId(), status.getCode(), status.getReason());
    }
}
```

註冊：

```java
package example.shop.chat.web.ws;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class RawWebSocketConfig implements WebSocketConfigurer {

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(new EchoWebSocketHandler(), "/ws/echo")
                // ⚠️⚠️ 這行【必須】設定，而且【不可以】是 "*"（8.8.6 會解釋為什麼）
                .setAllowedOrigins("https://shop.example");
    }
}
```

### 8.6.2 陷阱一：`WebSocketSession` 不是執行緒安全的 ★★

這是原生 WebSocket 最常見、也最難查的 bug。

```java
// 🔴 這段程式碼在壓測時會炸
public void broadcast(String text) {
    for (WebSocketSession s : sessions) {
        s.sendMessage(new TextMessage(text));    // 可能有多條執行緒同時對同一個 session 呼叫
    }
}
```

**具體後果**：

```
java.lang.IllegalStateException: The remote endpoint was in state [TEXT_PARTIAL_WRITING]
which is an invalid state for called method
	at org.apache.tomcat.websocket.WsRemoteEndpointImplBase.checkState(...)
	at org.apache.tomcat.websocket.WsRemoteEndpointImplBase.sendString(...)
```

**為什麼**：一個 WebSocket 訊息如果大於底層緩衝區，會被切成**多個 frame**送出
（第一個 frame 的 FIN 位元是 0，最後一個才是 1）。

```
執行緒 A 送「訊息一」：  [frame 1/2 of 訊息一] ... 還沒送完
執行緒 B 送「訊息二」：                        [frame 1/1 of 訊息二]   ← 插進來了
執行緒 A 繼續：                                                     [frame 2/2 of 訊息一]

→ 對方收到的位元組流是交錯的 → 協定被破壞
→ Tomcat 為了避免這件事，在 checkState() 直接丟 IllegalStateException
```

⚠️ **這個 bug 在本機測不出來**，因為訊息小、併發低時永遠不會分片。
它會在**正式環境、訊息變長、人變多**的時候才出現——而且錯誤訊息完全看不出跟併發有關。

### 8.6.3 解法：`ConcurrentWebSocketSessionDecorator`

Spring 內建了包裝器，**註冊 session 時就要包好，不要等到出事**：

```java
package example.shop.chat.web.ws;

import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

public final class SafeSessions {

    /** 送出訊息前最多等 5 秒（超過視為對方太慢）。 */
    private static final int SEND_TIME_LIMIT_MS = 5_000;

    /** 每條連線最多堆積 512 KB 未送出的訊息。 */
    private static final int BUFFER_SIZE_LIMIT_BYTES = 512 * 1024;

    private SafeSessions() {
    }

    /**
     * 把 session 包成執行緒安全的版本。
     *
     * <p>★ 它做的事：內部有一把鎖與一個佇列。
     * 當 A 正在送的時候，B 的訊息會進佇列而不是硬插進去。
     *
     * <p>★★ 兩個上限【比執行緒安全更重要】—— 它們是背壓（back-pressure）：
     * <ul>
     *   <li>{@code sendTimeLimit} —— 單一則訊息送出的時間上限</li>
     *   <li>{@code bufferSizeLimit} —— 佇列的位元組上限</li>
     * </ul>
     *
     * <p>⚠️ <b>沒有上限會怎樣</b>：一個手機在地鐵裡的使用者，TCP 視窗滿了、收得極慢。
     * 你每秒推 10 則訊息給他，全部堆在這個佇列裡 —— 堆到 heap 滿為止。
     * <b>一個慢的客戶端可以拖垮整台伺服器</b>，這叫 slow consumer 問題。
     *
     * <p>超過任一上限時，decorator 會直接關閉該連線（這是正確行為：
     * 與其為了一個連不上的人 OOM，不如讓他重連）。
     */
    public static WebSocketSession concurrent(WebSocketSession raw) {
        return new ConcurrentWebSocketSessionDecorator(
                raw, SEND_TIME_LIMIT_MS, BUFFER_SIZE_LIMIT_BYTES);
    }
}
```

> **STOMP 使用者請注意**：8.7 的 STOMP 層**已經幫你做了這件事**
> （`WebSocketMessageBrokerConfigurer` 的 `configureWebSocketTransport` 可以設定同樣的兩個上限，8.12.2 會設）。
> 但 slow consumer 的問題**不會因為用了 STOMP 就消失**——你只是換了設定的地方。

### 8.6.4 陷阱二：回呼不在請求執行緒上

```java
@Override
protected void handleTextMessage(WebSocketSession session, TextMessage message) {
    // 🔴 全部是 null / 空的
    String user = SecurityContextHolder.getContext().getAuthentication().getName();
    String traceId = MDC.get("traceId");
    Order order = orderRepository.findById(id).get();
    order.getItems().size();     // 🔴 LazyInitializationException
}
```

| 東西 | 為什麼不在 | 怎麼辦 |
|---|---|---|
| `SecurityContextHolder` | `SecurityContextPersistenceFilter` 在**握手**那次請求結束時就清掉了 | 握手時把 `Principal` 放進 session attributes（8.8.3），或用 `ChannelInterceptor`（8.8.4） |
| MDC 的 `traceId` | 04 章 4.5 的 `MdcFilter` 在請求結束時 `MDC.clear()` | 8.12.4 會寫一個 `ChannelInterceptor` 版本 |
| `@Transactional` / lazy 關聯 | 沒有交易、沒有 `EntityManager` | 呼叫 Service 層方法（讓交易在那裡開始），**不要在 handler 裡碰 entity** |

> **這和 05 章 5.9.3 是同一個問題**：`StreamingResponseBody` 跑在 async executor 上，
> 所以 `SecurityContext`、MDC、交易、lazy 關聯全部不可用。
> **凡是「離開請求執行緒」的機制，都會踩這一組。**

---

## 8.7 STOMP 實作

### 8.7.1 STOMP frame 長什麼樣

STOMP 是文字導向的，一個 frame 的結構和 HTTP 很像（command + headers + 空行 + body）：

```
SEND
destination:/app/chat.send
content-type:application/json
content-length:52

{"conversationId":"conv-8812","text":"您好，請問訂單編號"}^@
```

最後那個 `^@` 是 `NULL` 位元組（`\0`），它是 frame 的結束標記。

伺服器推回來的：

```
MESSAGE
destination:/topic/conversations/conv-8812
subscription:sub-0
message-id:msg-9f2a1c94-1
content-type:application/json

{"from":"agent-17","text":"您好，我看一下","at":"2026-09-16T04:12:33Z"}^@
```

| STOMP command | 方向 | 意義 |
|---|---|---|
| `CONNECT` / `STOMP` | 客戶端→伺服器 | 開始 STOMP 工作階段。★ **認證放這裡**（8.8.4） |
| `CONNECTED` | 伺服器→客戶端 | 接受，並回覆心跳協商結果 |
| `SUBSCRIBE` / `UNSUBSCRIBE` | 客戶端→伺服器 | 訂閱 / 退訂一個 destination |
| `SEND` | 客戶端→伺服器 | 送一則訊息到某個 destination |
| `MESSAGE` | 伺服器→客戶端 | 推送 |
| `RECEIPT` | 伺服器→客戶端 | 「我收到你那則 `SEND` 了」 |
| `ERROR` | 伺服器→客戶端 | ⚠️ **送出 `ERROR` 後連線一定會被關閉**（8.7.6） |
| `DISCONNECT` | 客戶端→伺服器 | 正常結束 |

### 8.7.2 設定：逐行說明 ★

```java
package example.shop.chat.web.ws;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;

import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration
@EnableWebSocketMessageBroker
public class StompConfig implements WebSocketMessageBrokerConfigurer {

    private final StompAuthChannelInterceptor authInterceptor;     // 8.8.4
    private final StompMdcChannelInterceptor mdcInterceptor;       // 8.12.4
    private final ChatProperties properties;                       // 8.12.3

    public StompConfig(StompAuthChannelInterceptor authInterceptor,
                       StompMdcChannelInterceptor mdcInterceptor,
                       ChatProperties properties) {
        this.authInterceptor = authInterceptor;
        this.mdcInterceptor = mdcInterceptor;
        this.properties = properties;
    }

    /**
     * 註冊「客戶端要連到哪個 URL」。
     */
    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                // ⚠️⚠️ 絕對不能用 setAllowedOrigins("*")（8.8.6）
                // WebSocket 不受同源政策保護，這一行是唯一的來源防線
                .setAllowedOrigins(properties.allowedOrigins().toArray(String[]::new))
                // ★ 交出一個 HandshakeHandler 來決定 Principal 從哪來（8.8.3）
                .setHandshakeHandler(new PrincipalHandshakeHandler());
        // ⚠️ 刻意【不】啟用 SockJS：
        //    .withSockJS() 會多出 /info 端點與 xhr-streaming 等後備傳輸，
        //    在需要支援 IE / 極舊瀏覽器時才有意義。它會讓 8.11 的代理設定變複雜一倍。
        //    shop-service 的客服後台是內部系統，瀏覽器版本可控。
    }

    /**
     * 設定 broker 與 destination 前綴 —— 這是整份設定最容易搞混的地方（8.7.3）。
     */
    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {

        // ① 【伺服器→客戶端】這些前綴的 destination 交給 broker 處理
        registry.enableSimpleBroker("/topic", "/queue")
                // ★ 心跳協商（8.9.3）。兩個值分別是
                //   [0] 伺服器多久送一次心跳、[1] 伺服器期望客戶端多久送一次（毫秒）
                .setHeartbeatValue(new long[]{10_000, 10_000})
                // ⚠️ setHeartbeatValue 沒有搭配 taskScheduler 的話【完全不會生效】
                //    Spring 會安靜地忽略它 —— 這是一個沒有任何警告的設定陷阱
                .setTaskScheduler(heartbeatScheduler());

        // ② 【客戶端→伺服器】這個前綴的 destination 交給 @MessageMapping 處理
        registry.setApplicationDestinationPrefixes("/app");

        // ③ 【使用者專屬】convertAndSendToUser() 用的前綴（8.7.5）
        registry.setUserDestinationPrefix("/user");
    }

    /**
     * 傳輸層上限 —— 8.6.3 那兩個背壓參數的 STOMP 版本。
     */
    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registration) {
        registration
                // 單一訊息的大小上限。⚠️ 預設 64 KB
                .setMessageSizeLimit(64 * 1024)
                // 單一連線的待送佇列上限 —— slow consumer 的防線（8.6.3）
                .setSendBufferSizeLimit(512 * 1024)
                // 單則訊息送出的時間上限
                .setSendTimeLimit(5_000);
    }

    /**
     * 【入站】訊息通道 —— 客戶端送來的每一個 frame 都會經過這裡。
     *
     * <p>★★ 這是 WebSocket 世界的「Filter chain」（對照 04 章 4.4）。
     * 8.4.1 說過 Servlet Filter 只在握手時跑一次；
     * {@code ChannelInterceptor} 才是每則訊息都會跑的那一層。
     *
     * <p>⚠️ 順序有意義：認證必須在 MDC 之前（MDC 要記 userId）。
     */
    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(authInterceptor, mdcInterceptor);
    }

    private ThreadPoolTaskScheduler heartbeatScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("ws-heartbeat-");
        scheduler.initialize();
        return scheduler;
    }
}
```

### 8.7.3 四個前綴：誰處理誰 ★

這是 STOMP 初學者最常搞混的一件事，因為**前綴的意義完全由設定決定，而不是由名字**。

```
客戶端 SEND 到 /app/chat.send
   │
   │  setApplicationDestinationPrefixes("/app")
   ↓
@MessageMapping("/chat.send") 的方法  ← 你的程式碼
   │
   │  方法內呼叫 template.convertAndSend("/topic/...")
   ↓
enableSimpleBroker("/topic", "/queue")
   │
   ↓
所有 SUBSCRIBE 了 /topic/... 的連線
```

| 前綴 | 誰處理 | 客戶端能對它做什麼 |
|---|---|---|
| `/app/**` | **你的 `@MessageMapping` 方法** | `SEND`（訂閱它沒有意義） |
| `/topic/**` | broker（一對多廣播） | `SUBSCRIBE` |
| `/queue/**` | broker（慣例上是一對一） | `SUBSCRIBE` |
| `/user/**` | `UserDestinationMessageHandler` 改寫後轉給 broker（8.7.5） | `SUBSCRIBE` |

⚠️ **`/topic` 與 `/queue` 對 simple broker 來說沒有任何行為差異。**
它們只是慣例（來自 JMS 的 topic/queue 語意）。
真正有差別是在換成 RabbitMQ / ActiveMQ 之後（8.10.2）——
那時 `/queue` 才真的是點對點、`/topic` 才真的是 fanout。

### 8.7.4 `@MessageMapping`：接收與回應

```java
package example.shop.chat.web.ws;

import example.shop.chat.service.ChatService;
import example.shop.chat.service.command.PostMessageCommand;
import example.shop.chat.web.dto.ChatMessageRequest;
import example.shop.chat.web.dto.ChatMessageResponse;
import jakarta.validation.Valid;
import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

import java.security.Principal;

/**
 * 客服聊天的 STOMP 端點。
 *
 * <p>★ 為什麼是 {@code @Controller} 而不是 {@code @RestController}：
 * {@code @RestController} = {@code @Controller} + {@code @ResponseBody}，
 * 而 {@code @ResponseBody} 是 MVC 的東西，在訊息層沒有意義
 * （這裡用 {@code @SendTo} 或 {@code SimpMessagingTemplate} 決定去向）。
 *
 * <p>⚠️⚠️ 這個類別裡拋出的例外<b>不會</b>進 03 章的 {@code @RestControllerAdvice}。
 * 訊息層的例外處理要用 {@code @MessageExceptionHandler}（8.7.6）。
 */
@Controller
public class ChatStompController {

    private final ChatService chatService;
    private final SimpMessagingTemplate template;

    public ChatStompController(ChatService chatService, SimpMessagingTemplate template) {
        this.chatService = chatService;
        this.template = template;
    }

    /**
     * 客戶端 SEND 到 {@code /app/conversations/{id}/messages}。
     *
     * <p>★ {@code @Valid} 在訊息層【有效】—— 02 章的 Bean Validation 是少數
     * 在 WebSocket 世界還活著的機制之一（因為它掛在 argument resolver 上，不是 filter）。
     * 驗證失敗會丟 {@code MethodArgumentNotValidException}，接到 8.7.6 的 handler。
     *
     * <p>⚠️ {@code principal} 不會是 null —— 前提是 8.8.4 的 ChannelInterceptor
     * 已經在 CONNECT 時把它設好了。<b>沒有那一段的話這裡就是 8.2.2 的事故。</b>
     */
    @MessageMapping("/conversations/{conversationId}/messages")
    public void postMessage(@DestinationVariable String conversationId,
                            @Payload @Valid ChatMessageRequest request,
                            Principal principal) {

        ChatMessageResponse saved = chatService.post(new PostMessageCommand(
                conversationId, principal.getName(), request.text()));

        // ★ 為什麼用 template 而不是 @SendTo：
        //   @SendTo 的 destination 是【編譯期常數】，無法帶 conversationId。
        //   需要動態 destination 時一律用 SimpMessagingTemplate。
        template.convertAndSend("/topic/conversations/" + conversationId, saved);
    }

    /**
     * 「正在輸入中…」—— 8.5.2 需求 2 的 STOMP 版本。
     *
     * <p>★ 注意它<b>不經過 Service 層、不寫資料庫</b>。
     * 這是 WebSocket 少數真正發揮價值的地方：一個高頻、可丟失、無副作用的訊號。
     * 用 POST 做這件事會在每次按鍵時打一次完整的 HTTP 請求（8.3.1 判準 1）。
     */
    @MessageMapping("/conversations/{conversationId}/typing")
    public void typing(@DestinationVariable String conversationId, Principal principal) {
        template.convertAndSend(
                "/topic/conversations/" + conversationId + "/typing",
                new TypingEvent(principal.getName()));
    }

    public record TypingEvent(String userId) {
    }
}
```

**`@SendTo` 的簡寫形式**（destination 固定時才能用）：

```java
@MessageMapping("/announcements")
@SendTo("/topic/announcements")           // ← 回傳值自動送到這裡
public Announcement announce(@Payload @Valid AnnouncementRequest request) {
    return announcementService.publish(request);
}
```

| 寫法 | destination | 適用 |
|---|---|---|
| `@SendTo("/topic/x")` | 編譯期固定 | 全站廣播 |
| `@SendToUser("/queue/x")` | 固定，但只送給發送者自己 | 「你的操作結果」 |
| `template.convertAndSend(dest, payload)` | **執行期決定** ★ | 帶 ID 的 destination |
| `template.convertAndSendToUser(user, dest, payload)` | 執行期決定，指定使用者 | 私訊（8.7.5） |

### 8.7.5 `/user/**`：使用者專屬 destination 的真正機制 ★★

這是 STOMP 裡最有用、也最容易誤解的功能。

**客戶端的寫法看起來很單純**：

```javascript
stompClient.subscribe('/user/queue/notifications', (msg) => { ... });
```

**但 `/user/queue/notifications` 這個 destination 並不存在。**

實際發生的事：

```
客戶端 SUBSCRIBE /user/queue/notifications
   │
   │  UserDestinationMessageHandler 攔截，把它改寫成：
   ↓
   /queue/notifications-user8f2a1c94        ← 附上這條【連線】的 session id
   │
   ↓
broker 實際註冊的是上面那個唯一的 destination


伺服器呼叫 template.convertAndSendToUser("agent-17", "/queue/notifications", payload)
   │
   │  查 SimpUserRegistry：「agent-17 目前有哪些 session？」
   │  → [user8f2a1c94, user3d7b02e1]   （他開了兩個分頁）
   ↓
   送到 /queue/notifications-user8f2a1c94
   送到 /queue/notifications-user3d7b02e1
```

**三個必須知道的後果**：

| # | 後果 | 說明 |
|---|---|---|
| 1 | 同一個使用者的**多個分頁 / 裝置都會收到** | 這通常是你要的。⚠️ 但如果訊息代表「一次性動作」（如「你的匯出檔可以下載了」），使用者會看到三次通知 |
| 2 | **使用者不在線上時，訊息安靜地消失** | `convertAndSendToUser()` 找不到 session 就是 no-op。**沒有例外、沒有回傳值、沒有日誌**（這就是 8.2.1 事故的直接成因） |
| 3 | 🔴 **`SimpUserRegistry` 預設只知道本機的連線** | 3 個 pod 就只看得到 1/3 的人。8.10 要解決的就是這件事 |

⚠️ **後果 2 的意思是：WebSocket 不能是通知的唯一通道。**
這和 05 章 5.11.5 的結論一字不差——「**快照 + 增量**」才是正確架構：

```
使用者開啟聊天視窗
  ① GET /conversations/{id}/messages?since=...   ← 快照（HTTP，可靠）
  ② SUBSCRIBE /topic/conversations/{id}          ← 增量（WebSocket，盡力而為）

重連時重跑 ①，而不是期待 WebSocket 幫你補送。
```

**「`Principal` 的 name 是什麼」決定了一切**：

```java
// convertAndSendToUser 的第一個參數，必須等於 Principal.getName()
template.convertAndSendToUser(
        "agent-17",                    // ← 這要對得上 8.8.4 設定的 principal name
        "/queue/notifications",
        payload);
```

⚠️ 如果你的 `Principal.getName()` 回傳的是 email、而呼叫端傳的是 userId，
**訊息會安靜地消失**，而且你 debug 時會發現「連線明明在啊」。
8.8.4 會把這件事釘死成一個明確的約定。

### 8.7.6 訊息層的例外處理（03 章那套完全不適用）★

```java
package example.shop.chat.web.ws;

import example.shop.common.web.ProblemDetailFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.handler.annotation.MessageExceptionHandler;
import org.springframework.messaging.handler.annotation.SendToUser;
import org.springframework.messaging.handler.annotation.support.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ControllerAdvice;

import java.security.Principal;

/**
 * 訊息層的全域例外處理 —— 03 章 {@code @RestControllerAdvice} 的 WebSocket 對應物。
 *
 * <p>★★ 為什麼不能沿用 03 章那一套：
 * {@code @ExceptionHandler} 由 {@code HandlerExceptionResolver} 觸發，那是 Spring MVC 的元件，
 * 只在「處理 HTTP 請求」的路徑上。STOMP 訊息走的是 {@code SimpAnnotationMethodMessageHandler}，
 * 兩條路完全不相交（8.4.1）。
 *
 * <p>★ {@code @SendToUser} 把錯誤送回<b>發生錯誤的那一個人</b>，而不是廣播。
 * {@code broadcast = false} 是必要的 —— 預設 true 會送到該使用者的<b>所有</b>連線，
 * 包含沒有發出這則訊息的那些分頁。
 *
 * <p>⚠️ <b>為什麼不直接讓例外冒出去</b>：STOMP 的 {@code ERROR} frame 有一個殘酷的規定 ——
 * 依照規格，伺服器送出 {@code ERROR} 之後<b>必須關閉連線</b>。
 * 也就是說一個「訊息文字太長」的驗證錯誤會把使用者整條連線踢掉，
 * 前端接著重連、重新訂閱、重拉歷史訊息。<b>用一個正常的訊息回報錯誤，不要用 ERROR frame。</b>
 */
@ControllerAdvice(assignableTypes = ChatStompController.class)
public class ChatStompExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ChatStompExceptionHandler.class);

    /** 沿用 03 章的 Problem 格式，讓前端只需要一套錯誤解析邏輯。 */
    private final ProblemDetailFactory problems;

    public ChatStompExceptionHandler(ProblemDetailFactory problems) {
        this.problems = problems;
    }

    @MessageExceptionHandler(MethodArgumentNotValidException.class)
    @SendToUser(destinations = "/queue/errors", broadcast = false)
    public Object onValidation(MethodArgumentNotValidException ex) {
        // 02 章的 BindingResult → 03 章的 Problem，兩章的成果在這裡重用
        return problems.validationFailed(ex.getBindingResult());
    }

    @MessageExceptionHandler(ChatAccessDeniedException.class)
    @SendToUser(destinations = "/queue/errors", broadcast = false)
    public Object onAccessDenied(ChatAccessDeniedException ex, Principal principal) {
        log.warn("使用者 {} 嘗試存取無權限的對話 {}", principal.getName(), ex.getConversationId());
        return problems.forbidden("你沒有這個對話的存取權限");
    }

    /**
     * ⚠️ 沒有這個 fallback 的話，未預期的例外只會在伺服器留一行日誌，
     * <b>客戶端完全不知道發生了什麼</b> —— UI 上就是「送出後永遠沒反應」。
     */
    @MessageExceptionHandler(Exception.class)
    @SendToUser(destinations = "/queue/errors", broadcast = false)
    public Object onUnexpected(Exception ex) {
        log.error("訊息處理失敗", ex);
        return problems.internalError();
    }
}
```

---

## 8.8 認證與授權 ★★

> 這一節是事故 8.2.2 的解法，也是這一章唯一**會直接造成資安漏洞**的部分。
> 它會用到 09-spring-security 的概念（filter chain、JWT），但**不依賴那一站**——
> 需要的部分這裡會自足地講完。

### 8.8.1 問題的根源：瀏覽器的 WebSocket API 不能帶 header

```javascript
// 瀏覽器的 WebSocket 建構子只有兩個參數
new WebSocket(url)
new WebSocket(url, protocols)     // protocols 是 subprotocol 名稱，不是 options
```

**沒有第三個參數。沒有 headers。** 這是規格寫死的，不是瀏覽器的缺陷。

⚠️ 注意**伺服器端**的 WebSocket 客戶端（Node.js 的 `ws`、Java 的 `StandardWebSocketClient`）
**可以**帶任意 header。所以「用 Postman 測都正常」完全不能證明瀏覽器會正常——
這是 8.2.2 那兩天方向錯誤的第二個原因。

### 8.8.2 四種做法與各自的洩漏面 ★

| # | 做法 | token 會出現在哪 | 評價 |
|---|---|---|---|
| 1 | **URL query string**<br>`wss://host/ws?token=eyJ...` | 🔴 Nginx `access_log`<br>🔴 瀏覽器歷史紀錄<br>🔴 `Referer`（若頁面有外連）<br>🔴 APM / 追蹤系統的 span 名稱 | ❌ **不要用**。一個長效 JWT 會永久留在你的日誌歸檔裡 |
| 2 | **Cookie**（握手會自動帶） | ✅ 不進 log | ⚠️ 可用，但**必須**處理 CSRF（8.8.6）。因為 WebSocket 不受同源政策保護，任何網站都能對你的 endpoint 發起帶 cookie 的握手 |
| 3 | **`Sec-WebSocket-Protocol` 夾帶** | ⚠️ 少數代理會記 | ⚠️ 一個廣為流傳的 hack。可行但很醜，且 subprotocol 名稱有字元限制（token 要先處理） |
| 4 | **STOMP `CONNECT` frame 的 header** ★ | ✅ 不進 HTTP log<br>✅ 不在 URL | ✅ **推薦**。token 在 `101` 之後才送，走的是已建立的 TLS 通道 |

**做法 4 的前端寫法**：

```javascript
const client = new StompJs.Client({
  brokerURL: 'wss://shop.example/ws',
  connectHeaders: {
    Authorization: 'Bearer ' + accessToken,      // ← 這會進 CONNECT frame，不是 HTTP header
  },
  reconnectDelay: 0,        // ⚠️ 關掉函式庫的自動重連，自己控制（8.9.4）
});
```

⚠️ **做法 4 有一個必須處理的縫**：
握手（HTTP）本身是 `permitAll()` 的，所以**任何人都能建立一條未認證的 WebSocket 連線**。
它會佔一個 connection slot，直到 `CONNECT` 被拒絕為止。
必須設定「**連上之後 N 秒內沒有成功 `CONNECT` 就踢掉**」——8.12.4 有實作。

### 8.8.3 做法 2 的實作：`HandshakeHandler` 取出 Principal

如果你用 cookie / session（shop-service 的客服後台是內部系統，走 session）：

```java
package example.shop.chat.web.ws;

import org.springframework.http.server.ServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

import java.security.Principal;
import java.util.Map;

/**
 * 決定這條連線的 {@link Principal} 是誰。
 *
 * <p>★ 為什麼預設行為就夠用（大多數情況）：
 * {@code DefaultHandshakeHandler.determineUser()} 直接回傳
 * {@code request.getPrincipal()}，而那在握手請求經過 Spring Security 的
 * filter chain 之後<b>已經被填好了</b>（因為握手是一個貨真價實的 HTTP 請求）。
 *
 * <p>★★ 所以「cookie / session 認證」幾乎不用寫程式 —— 只要
 * {@code SecurityFilterChain} 有保護 {@code /ws/**} 就好：
 * <pre>
 * http.authorizeHttpRequests(r -> r.requestMatchers("/ws/**").authenticated())
 * </pre>
 * 未登入者會在<b>握手階段</b>就拿到 401，連線根本建立不起來。
 *
 * <p>⚠️ 這個覆寫存在的唯一理由是 <b>8.7.5 的約定</b>：
 * {@code Principal.getName()} 必須回傳 <b>userId</b>，
 * 因為 {@code convertAndSendToUser()} 的第一個參數就是拿它來比對的。
 * 預設的 {@code UsernamePasswordAuthenticationToken.getName()} 回傳的是<b>登入帳號</b>
 * （在 shop-service 是 email）—— 如果不統一，訊息會安靜地送不到（8.7.5 後果 2）。
 */
public class PrincipalHandshakeHandler extends DefaultHandshakeHandler {

    @Override
    protected Principal determineUser(ServerHttpRequest request,
                                      WebSocketHandler wsHandler,
                                      Map<String, Object> attributes) {

        Principal principal = super.determineUser(request, wsHandler, attributes);
        if (principal == null) {
            return null;    // 交給 8.8.4 的 CONNECT 認證，或直接被 Security 擋在外面
        }
        // ★ 把 Principal 的 name 正規化成 userId
        return new ChatPrincipal(CurrentUser.idOf(principal), principal);
    }
}
```

### 8.8.4 做法 4 的實作：`ChannelInterceptor` 在 CONNECT frame 驗證 ★★

**這是 shop-service 顧客端採用的做法**（顧客端是 SPA，用 JWT）。

```java
package example.shop.chat.web.ws;

import example.shop.security.JwtVerifier;
import example.shop.security.VerifiedToken;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.stereotype.Component;

/**
 * 在 STOMP {@code CONNECT} frame 上做認證。
 *
 * <p>★★ 為什麼是 {@code ChannelInterceptor} 而不是 Servlet {@code Filter}：
 * 8.4.1 說過 filter chain 只在握手那一個 HTTP 請求跑過。
 * 而 token 是在 {@code 101} <b>之後</b>才透過 CONNECT frame 送來的 ——
 * 那時 filter chain 早就結束了。{@code ChannelInterceptor} 是唯一看得到 STOMP frame 的地方。
 *
 * <p>★ <b>為什麼只在 CONNECT 驗證，不是每則訊息都驗</b>：
 * 一條 WebSocket 連線的身分在建立時就固定了，中途不可能換人
 * （不像 HTTP 每個請求都可能來自不同人）。
 * 每則訊息都驗 JWT 簽章是純粹的 CPU 浪費 —— 聊天的訊息頻率很高。
 *
 * <p>⚠️⚠️ <b>這個決定的代價：token 過期後連線仍然有效。</b>
 * 一條連線可能活 8 小時，而 access token 只有 15 分鐘。
 * 處理方式見下面的 {@code expiresAt} 與 8.12.4 的 {@code TokenExpiryReaper} ——
 * <b>絕對不能就這樣算了</b>，否則登出 / 停權的使用者可以繼續收訊息到連線斷掉為止。
 */
@Component
public class StompAuthChannelInterceptor implements ChannelInterceptor {

    private static final Logger log = LoggerFactory.getLogger(StompAuthChannelInterceptor.class);

    private final JwtVerifier jwtVerifier;

    public StompAuthChannelInterceptor(JwtVerifier jwtVerifier) {
        this.jwtVerifier = jwtVerifier;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {

        StompHeaderAccessor accessor =
                MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);

        if (accessor == null || !StompCommand.CONNECT.equals(accessor.getCommand())) {
            return message;     // 只處理 CONNECT，其他 frame 直接放行
        }

        // ★ getFirstNativeHeader 讀的是 STOMP frame 的 header，不是 HTTP header
        String authorization = accessor.getFirstNativeHeader("Authorization");

        if (authorization == null || !authorization.startsWith("Bearer ")) {
            // ⚠️ 這裡【必須】丟例外。回傳 null 會讓訊息被安靜丟棄，
            //    而客戶端會一直等 CONNECTED frame 等到逾時 —— 症狀是「轉圈圈」。
            throw new StompAuthenticationException(4002, "缺少認證資訊");
        }

        VerifiedToken token;
        try {
            token = jwtVerifier.verify(authorization.substring("Bearer ".length()));
        } catch (TokenExpiredException ex) {
            // ★ 4001 與 4002 分開（8.4.4）：前端對「過期」要刷新後重連，
            //   對「無效」要導向登入頁【不要】重連。
            throw new StompAuthenticationException(4001, "token 已過期");
        } catch (Exception ex) {
            log.warn("STOMP CONNECT 的 token 驗證失敗", ex);
            throw new StompAuthenticationException(4002, "token 無效");
        }

        // ★★ setUser() 設定的 Principal 會跟著【整條連線】，
        //    之後每個 @MessageMapping 方法的 Principal 參數都從這裡來。
        //    name 必須是 userId —— 8.7.5 的約定。
        accessor.setUser(new ChatPrincipal(token.userId(), token.authorities()));

        // ⚠️ 把過期時間放進 session attributes，讓 TokenExpiryReaper 能掃（8.12.4）
        accessor.getSessionAttributes().put("tokenExpiresAt", token.expiresAt());

        log.debug("STOMP CONNECT 認證成功 userId={} sessionId={}",
                token.userId(), accessor.getSessionId());
        return message;
    }
}
```

### 8.8.5 授權：訂閱別人的對話怎麼辦 ★

**認證解決了「你是誰」，但沒有解決「你能訂閱什麼」。**

```javascript
// 攻擊者已登入（有合法 token），然後：
stompClient.subscribe('/topic/conversations/conv-9999', (msg) => {
    console.log('偷看別人的客服對話', msg.body);
});
```

⚠️ **預設情況下這會成功。** simple broker **不做任何授權檢查**——
`SUBSCRIBE` 到任何 `/topic/**` 都會被接受。

這是 WebSocket 版本的 **IDOR**（對照 05 章 5.8.5 的下載授權）。

**兩層防線**：

**第一層：`@MessageMapping` 的方法層權限**（只擋 `SEND`，不擋 `SUBSCRIBE`）

```java
@PreAuthorize("@conversationGuard.canAccess(#conversationId, principal)")
@MessageMapping("/conversations/{conversationId}/messages")
public void postMessage(@DestinationVariable String conversationId, ...) { ... }
```

⚠️ 要讓 `@PreAuthorize` 在訊息層生效，需要 `@EnableWebSocketSecurity`
（Spring Security 6）或 `AbstractSecurityWebSocketMessageBrokerConfigurer`（舊版）。
**光有 `@EnableMethodSecurity` 是不夠的**——那只掛在 MVC 的 AOP 上。

**第二層：攔截 `SUBSCRIBE` frame** ★（這才是真正擋住偷看的那一層）

```java
package example.shop.chat.web.ws;

import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.stereotype.Component;

import java.security.Principal;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 檢查訂閱權限 —— WebSocket 版本的 IDOR 防線。
 *
 * <p>★★ 為什麼不能只靠 {@code @PreAuthorize}：
 * {@code SUBSCRIBE} frame <b>不會</b>走到任何 {@code @MessageMapping} 方法
 * （它是給 broker 的，不是給你的 controller 的）。
 * 也就是說方法層權限完全看不到它 —— 必須在 channel 這一層攔。
 *
 * <p>⚠️ 這個 interceptor 每次 SUBSCRIBE 都會查一次資料庫。
 * 訂閱是低頻動作（一個對話視窗開啟一次），所以可以接受；
 * 但<b>不要</b>把同樣的邏輯放到 SEND 上（那是高頻的）——
 * SEND 用 {@code @PreAuthorize} + 快取，或乾脆信任「已訂閱」這件事。
 */
@Component
public class SubscriptionAuthorizationInterceptor implements ChannelInterceptor {

    private static final Pattern CONVERSATION_TOPIC =
            Pattern.compile("^/topic/conversations/([A-Za-z0-9_-]{1,64})(/typing)?$");

    private final ConversationGuard guard;

    public SubscriptionAuthorizationInterceptor(ConversationGuard guard) {
        this.guard = guard;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {

        StompHeaderAccessor accessor =
                MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);

        if (accessor == null || !StompCommand.SUBSCRIBE.equals(accessor.getCommand())) {
            return message;
        }

        String destination = accessor.getDestination();
        if (destination == null) {
            throw new ChatAccessDeniedException(null, "SUBSCRIBE 缺少 destination");
        }

        // ★ /user/** 由 Spring 改寫成只屬於這條 session 的 destination（8.7.5），
        //   它天生就不可能被別人訂到 —— 直接放行。
        if (destination.startsWith("/user/")) {
            return message;
        }

        Matcher matcher = CONVERSATION_TOPIC.matcher(destination);
        if (!matcher.matches()) {
            // ⚠️ 白名單而不是黑名單：不認得的 destination 一律拒絕。
            //    否則哪天有人加了 /topic/admin/** 就直接開放給全世界。
            throw new ChatAccessDeniedException(destination, "不允許的 destination");
        }

        String conversationId = matcher.group(1);
        Principal principal = accessor.getUser();

        if (principal == null || !guard.canAccess(conversationId, principal.getName())) {
            throw new ChatAccessDeniedException(conversationId, "沒有這個對話的存取權限");
        }
        return message;
    }
}
```

### 8.8.6 `Origin` 檢查：WebSocket 不受同源政策保護 ★★

**這是這一章最重要的安全結論，而且它違反大多數人的直覺。**

```
一般的跨來源 fetch：
  evil.example 的 JS 對 shop.example 發 fetch
    → 瀏覽器【送出】請求（帶 cookie）
    → 回應回來
    → 🛡️ 瀏覽器檢查 CORS header，不通過就【不讓 JS 讀】

WebSocket：
  evil.example 的 JS 對 shop.example 開 WebSocket
    → 瀏覽器【送出】握手（帶 cookie！）
    → 🔴 沒有 CORS 檢查。完全沒有。
    → 連線建立，evil.example 的 JS 可以讀寫這條連線
```

⚠️ **瀏覽器對 WebSocket 不執行同源政策。** 它只做一件事：
在握手請求裡**誠實地填上 `Origin` header**。

**要不要擋，完全是伺服器的責任。**

這個攻擊叫 **Cross-Site WebSocket Hijacking（CSWSH）**：

```
① 受害者已登入 shop.example（瀏覽器有 SESSION cookie）
② 受害者被誘導開啟 evil.example
③ evil.example 的 JS 執行：
      const ws = new WebSocket('wss://shop.example/ws');
   → 瀏覽器【自動帶上】shop.example 的 cookie
   → 🔴 握手成功，而且是以受害者的身分
④ 攻擊者訂閱受害者的所有通知、送出以受害者名義的訊息
```

**三道防線**：

| 防線 | 做法 | 強度 |
|---|---|---|
| **① `Origin` 白名單** ★ | `setAllowedOrigins("https://shop.example")` | **必要**。Spring 預設會擋（只允許同源），⚠️ 但很多人為了解決「本機連不上」而改成 `"*"` —— 那等於自己拆掉唯一的鎖 |
| **② 不用 cookie，用 8.8.4 的 CONNECT token** ★ | token 存在 `localStorage`，`evil.example` 讀不到（同源限制對 storage 是有效的） | **最強**。攻擊者能建立連線，但 `CONNECT` 過不了 |
| ③ CSRF token | 握手 URL 帶一個一次性 token | 可行但麻煩，通常 ①+② 就夠 |

```java
// 🔴 絕對不要
registry.addEndpoint("/ws").setAllowedOrigins("*");

// 🔴 也不要（allowedOriginPatterns 的萬用字元一樣危險）
registry.addEndpoint("/ws").setAllowedOriginPatterns("*");

// ✅ 明確列出，從設定檔讀（8.12.3）
registry.addEndpoint("/ws")
        .setAllowedOrigins("https://shop.example", "https://admin.shop.example");
```

> **對照 06 章的 CORS**：06 章講「為什麼 `*` 不能和 `credentials: true` 併用」——
> 那時瀏覽器**會幫你擋**（它拒絕這個組合）。
> WebSocket 這裡**瀏覽器不會幫你擋任何東西**。
> 06 章的直覺搬過來會害你，這是 8.4.1 那張表「CORS 不適用」那一列的真正代價。

---

## 8.9 心跳與連線生命週期

> 這一節是事故 8.2.3（連線數只增不減）的解法。

### 8.9.1 三層心跳，各自偵測什麼 ★

初學者常以為「心跳」是一件事。實際上有**三層**，它們偵測的東西完全不同：

| 層 | 機制 | 偵測什麼 | 預設 | 能不能救你 |
|---|---|---|---|---|
| **TCP** | `SO_KEEPALIVE` | 對方的**主機**還在不在 | ⚠️ Java **預設關閉**；開了也要 2 小時才動 | 🔴 **不能**（8.2.3 算過：2 小時 11 分） |
| **WebSocket** | Ping/Pong frame（opcode `0x9`/`0xA`） | 對方的**TCP 連線**還通不通 | ⚠️ Spring 預設**不主動送** | ✅ 可以，但要自己排程 |
| **STOMP** | `heart-beat` header 協商 | 對方的**應用程式**還活著沒有 | ✅ 設定後生效（8.7.2） | ✅ **推薦** |

**為什麼要分三層**——因為失敗的位置不同：

```
使用者的手機關機
  → TCP 層偵測得到（但要 2 小時）

使用者從 Wi-Fi 切到 4G
  → TCP 層【偵測不到】（舊連線的封包直接進黑洞，沒有 RST）
  → WebSocket Ping 送出後收不到 Pong ✅

伺服器的應用程式 deadlock 了，但 TCP stack 還在回應
  → TCP 正常、WebSocket Pong 正常（由容器回應）
  → 🔴 只有 STOMP 層的心跳測得出來（因為它要應用執行緒去送）
```

⚠️ **這就是為什麼 STOMP 心跳比 WebSocket Ping 更有價值**：
Ping/Pong 由 Tomcat 在 I/O 層自動回應，**應用程式卡死時它照樣回**。

### 8.9.2 STOMP 心跳的協商機制

心跳是**雙方協商**出來的，不是單方面設定的：

```
客戶端 CONNECT：
    heart-beat:10000,10000
              └──┬──┘ └──┬──┘
                 │        └── 我希望你每 10000ms 送一次給我
                 └── 我可以每 10000ms 送一次給你

伺服器 CONNECTED：
    heart-beat:10000,10000

協商結果（取兩邊的 max）：
    伺服器 → 客戶端：每 10s
    客戶端 → 伺服器：每 10s
```

**任一邊填 `0` 就代表「這個方向不要心跳」**：

```
客戶端送 heart-beat:0,0   → 完全沒有心跳 → 8.2.3 的事故
```

⚠️ **這是一個很容易漏掉的失敗模式**：你的伺服器設定完全正確，
但**前端函式庫的預設值是 `0,0`**（`@stomp/stompjs` 舊版本就是），
於是心跳完全沒有生效，而你的設定看起來沒有任何問題。

**驗證方法**——看 `CONNECTED` frame 的實際內容：

```javascript
client.debug = (str) => console.log(str);
// 連上時應該看到：
// <<< CONNECTED
// version:1.2
// heart-beat:10000,10000      ← 不是 0,0 才算成功
```

### 8.9.3 伺服器端的設定（8.7.2 那兩行的完整理由）

```java
registry.enableSimpleBroker("/topic", "/queue")
        .setHeartbeatValue(new long[]{10_000, 10_000})
        .setTaskScheduler(heartbeatScheduler());     // ⚠️ 沒這行，上一行完全無效
```

**怎麼選這個數字**：

```
心跳間隔必須 <  最短的中間層閒置逾時 / 2

shop-service 的路徑：瀏覽器 → CloudFront → ALB → Nginx → Tomcat
  ALB idle timeout        = 60s
  Nginx proxy_read_timeout = 60s（預設，8.11.1 會改）
  最短 = 60s
  → 心跳要 < 30s

選 10s 的理由：偵測半開連線的延遲是「2～3 個心跳週期」= 20～30 秒。
使用者可以接受「30 秒後才發現對方離線」，但不能接受 2 分鐘。
```

⚠️ **不要把心跳設得太密**。10,000 條連線 × 每 5 秒一次 = **每秒 2,000 個 frame**，
純粹只為了確認大家還活著。這在 8.9.5 會算成本。

### 8.9.4 前端重連：退避與 close code 分流 ★

**05 章 5.11 的 SSE 有瀏覽器內建的自動重連。WebSocket 沒有——每一行都要自己寫。**

```javascript
/**
 * 依 close code 決定要不要重連，以及等多久。
 * ⚠️ 無腦重連 = 8.4.4 說的無限迴圈（每 3 秒一次完整握手 + DB 查詢）
 */
const NO_RETRY_CODES = new Set([
  1000,   // 正常關閉（是我們自己呼叫 close 的）
  4002,   // token 無效 → 導向登入頁
  4003,   // 被踢下線（同帳號在別處登入）→ 顯示提示，不要搶連線
]);

let attempt = 0;

function scheduleReconnect(closeEvent) {
  if (NO_RETRY_CODES.has(closeEvent.code)) {
    handleTerminal(closeEvent.code);
    return;
  }

  if (closeEvent.code === 4001) {         // token 過期
    await refreshAccessToken();           // ★ 先換 token 再重連，否則一定再被踢一次
    attempt = 0;
  }

  // 指數退避 + jitter
  // ⚠️ jitter 不是可選的：沒有它，一次 pod 重啟會讓 8,000 個客戶端
  //    在【同一秒】重連 —— 剛起來的 pod 直接被打掛（thundering herd）
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  const delay = base * (0.5 + Math.random() * 0.5);
  attempt += 1;

  setTimeout(connect, delay);
}
```

| 事件 | 正確反應 |
|---|---|
| `1000` 正常關閉 | 不重連 |
| `1001` 端點離開 | 不重連（是使用者自己關分頁） |
| `1006` 異常關閉 | **重連**（最常見的情況：網路斷了） |
| `1011` 伺服器錯誤 | 重連，但退避要長 |
| `4001` token 過期 | **先刷新 token**，再重連 |
| `4002` token 無效 | **不重連**，導向登入 |
| `4029` 連線數已滿 | 重連，退避 30 秒起跳 |

**重連成功之後，一定要重跑「快照」**（8.7.5）：

```javascript
client.onConnect = () => {
  client.subscribe(`/topic/conversations/${id}`, onMessage);
  fetchMessagesSince(lastSeenMessageId);   // ★ 斷線期間的訊息從 HTTP 補，不是從 WebSocket
};
```

### 8.9.5 連線的成本：一條連線到底佔什麼

對照 05 章 5.11.8 的 SSE 版本，WebSocket 多了一項（雙向讀取緩衝）：

| 資源 | 每條連線 | 上限由什麼決定 |
|---|---|---|
| Tomcat connection slot | 1 | `server.tomcat.max-connections`（預設 **8192**） |
| File descriptor | 1 | `ulimit -n`（容器裡常常是 1024 🔴） |
| Socket 讀寫緩衝 | 約 **4～64 KB**（核心） | `net.ipv4.tcp_rmem` / `tcp_wmem` |
| `WebSocketSession` 物件 + 訂閱狀態 | 約 2～10 KB | heap |
| STOMP 訂閱表項目 | 每個訂閱約 200 bytes | heap |
| **工作執行緒** | **0** ★ | —— |

★ **最後一列是關鍵**：WebSocket 是非阻塞的，一條連線**不佔一條執行緒**。
這和 05 章 5.11.8 對 SSE 的結論一致。所以「連線很多」不會耗盡 `server.tomcat.threads.max`，
會先撞到的是 **`max-connections`** 與 **file descriptor**。

```
10,000 條連線的估算：
  核心緩衝  10,000 × 8 KB    =  80 MB     ← 不在 heap，但算在容器記憶體
  heap 物件 10,000 × 6 KB    =  60 MB
  心跳流量  10,000 × 2 frame / 10s × 6 bytes ≈ 12 KB/s   ← 可以忽略
  ────────────────────────────────────────
  記憶體 ≈ 140 MB，而且 max-connections 8192 【已經不夠了】
```

⚠️ 所以 10,000 條連線需要**至少 2 個 pod**，而那就直接進入 8.10 的問題。

---

## 8.10 多實例：訊息到底去哪了 ★★

> 這一節是事故 8.2.1 的解法，也是整章最重要的一節。

### 8.10.1 問題的精確描述

```java
template.convertAndSendToUser("agent-17", "/queue/notifications", payload);
```

這一行在做的事：

```
① 查 SimpUserRegistry：agent-17 有哪些 session？
② 對每個 session，把訊息寫進它的 WebSocketSession
```

**①  的 `SimpUserRegistry` 是 `DefaultSimpUserRegistry`，它是一個 `ConcurrentHashMap`。**
在**這個 JVM 的記憶體裡**。

```
pod-1 的 registry: { customer-A: [sess-1] }
pod-2 的 registry: { }
pod-3 的 registry: { agent-17: [sess-9] }

pod-3 收到「送給 customer-A」
  → 查自己的 map → 沒有
  → 🔴 return（no-op，不報錯）
```

⚠️ **同樣的問題也發生在 `convertAndSend("/topic/...")`**：
simple broker 的訂閱表一樣是本機的。

> **這就是 05 章 5.11.6 的 `SseEmitterRegistry` 那一節在講的同一件事。**
> 如果你讀過那一節，這裡的結論會很熟悉；差別在 WebSocket 多了一個
> **「發送者也在某一台上」**的維度——SSE 的事件來自伺服器內部（例如訂單狀態變更），
> 你至少知道它從哪裡發出；聊天的事件來自**另一個使用者的連線**，
> 於是**兩端都是隨機分佈的**。

### 8.10.2 三個解法 ★

| 解法 | 怎麼做 | 優點 | 🔴 缺點 |
|---|---|---|---|
| **① Sticky session** | LB 用 cookie / IP hash 把同一個人固定到同一台 | 設定簡單 | **完全解決不了這個問題**。它讓「同一個人」固定，但聊天是**兩個人**之間的事，A 和 B 還是可能在不同台。⚠️ 常被誤當成解法 |
| **② Redis pub/sub 扇出** ★ | 每台 pod 訂閱同一個 Redis channel，收到就往自己的本機連線送 | 改動小、延遲低（<1ms）、Redis 通常已經有了 | 不保證送達（8.10.4）；訂閱關係仍然分散在各 pod |
| **③ 外部 STOMP broker** | 把 `enableSimpleBroker` 換成 `enableStompBrokerRelay`，接 RabbitMQ / ActiveMQ | **訂閱表集中管理**，broker 原生講 STOMP，支援持久化訂閱 | 多一個要維運的元件；RabbitMQ 要開 STOMP plugin |

**怎麼選**：

```
連線數 < 5,000，且訊息可以丟失（聊天、通知）
  → ② Redis pub/sub ★ shop-service 選這個

連線數很大，或訊息【不可以】丟失，或已經有 RabbitMQ
  → ③ 外部 broker

任何情況
  → ① 不要單獨用。它可以搭配 ② 減少扇出量，但不能取代
```

### 8.10.3 Redis pub/sub 扇出的實作

```java
package example.shop.chat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import example.shop.chat.web.dto.ChatEnvelope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * 把一則訊息廣播到<b>所有</b> pod。
 *
 * <p>★★ 這是 8.2.1 事故的修法。使用規則很簡單但必須嚴格遵守：
 * <b>任何要送到 WebSocket 的訊息，都經過這個類別，不要直接呼叫 SimpMessagingTemplate。</b>
 * 只要有一處漏掉，那一處就會退化成「三分之一機率送達」。
 *
 * <p>★ 為什麼不直接用 {@code @EventListener} + Spring 的事件：
 * Spring 的應用事件是<b>行程內</b>的，跨不了 pod —— 那正是這個事故的成因。
 */
@Component
public class ChatBroadcaster {

    private static final Logger log = LoggerFactory.getLogger(ChatBroadcaster.class);

    /** ★ 所有 pod 都訂閱這一個 channel。 */
    public static final String CHANNEL = "shop:chat:fanout";

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public ChatBroadcaster(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        // ⚠️ 注入容器的 ObjectMapper，不要 new 一個（06 章 6.6 的結論）
        this.objectMapper = objectMapper;
    }

    /** 廣播到一個 topic（所有訂閱者）。 */
    public void toTopic(String destination, Object payload) {
        publish(ChatEnvelope.toTopic(destination, payload));
    }

    /** 送給特定使用者的所有連線（不論在哪一台）。 */
    public void toUser(String userId, String destination, Object payload) {
        publish(ChatEnvelope.toUser(userId, destination, payload));
    }

    private void publish(ChatEnvelope envelope) {
        try {
            redis.convertAndSend(CHANNEL, objectMapper.writeValueAsString(envelope));
        } catch (Exception ex) {
            // ⚠️ 這裡【不要】把例外往上丟：
            //    訊息已經寫進資料庫了（那是可靠的來源），推播失敗不該讓 API 回 500。
            //    使用者重新整理時會從 HTTP 快照拿到（8.7.5 的「快照 + 增量」）。
            log.error("chat 扇出失敗 destination={}", envelope.destination(), ex);
        }
    }
}
```

**訂閱端**：

```java
package example.shop.chat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import example.shop.chat.web.dto.ChatEnvelope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;

/**
 * 收到 Redis 廣播後，送給<b>本機</b>的連線。
 *
 * <p>★ 每一台 pod 都會收到每一則訊息，然後各自判斷「我這裡有沒有人要收」。
 * 沒有人要收的那幾台就自然變成 no-op —— 這正是原本的 bug，
 * 但現在它<b>只是浪費一點 CPU</b>，而不是遺失訊息。
 *
 * <p>⚠️ 這個 listener 跑在 Redis 的訂閱執行緒上，<b>不是</b>請求執行緒
 * （8.6.4 的那一組限制全部適用：沒有 SecurityContext、沒有交易、沒有 MDC）。
 * 所以這裡<b>只做轉發，不做任何業務邏輯</b>。
 */
@Component
public class ChatFanoutListener implements MessageListener {

    private static final Logger log = LoggerFactory.getLogger(ChatFanoutListener.class);

    private final SimpMessagingTemplate template;
    private final ObjectMapper objectMapper;

    public ChatFanoutListener(SimpMessagingTemplate template, ObjectMapper objectMapper) {
        this.template = template;
        this.objectMapper = objectMapper;
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        try {
            ChatEnvelope envelope = objectMapper.readValue(
                    new String(message.getBody(), StandardCharsets.UTF_8), ChatEnvelope.class);

            if (envelope.userId() == null) {
                template.convertAndSend(envelope.destination(), envelope.payload());
            } else {
                template.convertAndSendToUser(
                        envelope.userId(), envelope.destination(), envelope.payload());
            }
        } catch (Exception ex) {
            // ⚠️ 絕對不能讓例外冒出去 —— 它會讓整個 Redis 訂閱容器停掉，
            //    而症狀是「從某個時間點開始，所有 pod 都收不到廣播了」。
            log.error("處理 chat 扇出訊息失敗", ex);
        }
    }
}
```

**註冊**：

```java
@Bean
RedisMessageListenerContainer chatFanoutContainer(RedisConnectionFactory factory,
                                                  ChatFanoutListener listener) {
    RedisMessageListenerContainer container = new RedisMessageListenerContainer();
    container.setConnectionFactory(factory);
    container.addMessageListener(listener, new ChannelTopic(ChatBroadcaster.CHANNEL));
    return container;
}
```

**改用扇出之後，8.7.4 的 controller 只改一行**：

```java
-   template.convertAndSend("/topic/conversations/" + conversationId, saved);
+   broadcaster.toTopic("/topic/conversations/" + conversationId, saved);
```

### 8.10.4 Redis pub/sub 不保證送達的三個時機 ★

**這是選擇方案 ② 時必須明確接受的代價。** Redis pub/sub 是**射後不理（fire-and-forget）**：

| 時機 | 發生什麼 |
|---|---|
| **pod 正在重啟** | 那 3～10 秒內發佈的訊息，這台 pod 完全收不到，**不會補送** |
| **Redis 連線短暫斷線** | 重連期間的訊息全部消失。⚠️ Lettuce 會自動重連，但**不會**補訂閱期間的訊息 |
| **訂閱者處理不及** | Redis 的 client output buffer 滿了會**直接斷開該訂閱者** |

> 10-redis 的 01 章對 keyspace notification 講過同一句話：**「Pub/Sub 是射後不理」**。
> 這裡是同一個性質的第二次出現。

⚠️ **這為什麼可以接受**——因為 8.7.5 已經定下「快照 + 增量」的架構：

```
訊息的可靠來源是【資料庫】，不是 WebSocket。
WebSocket 只負責「讓使用者不用按 F5」。

掉了一則 → 使用者切換對話 / 重連 / 按 F5 時，從 GET /conversations/{id}/messages 拿到
```

**如果你的需求不能接受這件事**（例如訊息本身就是最終憑證），
那就不該用 Redis pub/sub，應該用 ③ 外部 broker，或者乾脆**不要用 WebSocket 當傳輸層**——
用 11-messaging 的 MQ 把訊息可靠地投遞到一個收件匣，WebSocket 只發「你有新訊息」的通知。

---

## 8.11 部署：讓它穿過代理

> 這一節是事故 8.2.4 的解法。

### 8.11.1 Nginx 設定逐行 ★

```nginx
# ① 把客戶端的 Upgrade 值對應成 Connection 的值
#    ★ 為什麼要這個 map，而不是直接寫死 "Connection: upgrade"：
#      同一個 location 可能同時服務一般 HTTP 與 WebSocket。
#      寫死的話，一般請求也會被加上 Connection: upgrade —— 某些後端會拒絕。
#      這個 map 的效果是「客戶端有要求升級才轉發，否則送 close」。
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream shop_backend {
    server 10.0.1.11:8080;
    server 10.0.1.12:8080;
    server 10.0.1.13:8080;

    # ⚠️ 長連線【不要】用 least_conn 之外的花招，也不要用 ip_hash 當作
    #    多實例的解法 —— 8.10.2 解法① 說過那解決不了問題。
    least_conn;

    keepalive 64;
}

server {
    listen 443 ssl;
    http2 on;
    server_name shop.example;

    location /ws {
        proxy_pass http://shop_backend;

        # ② ★★ 這三行是事故 8.2.4 的核心
        #    Upgrade 是 hop-by-hop header，代理【必須】明確轉發才會過去
        proxy_http_version 1.1;              # ⚠️ 預設是 1.0，1.0 不支援 Upgrade
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ③ ★ Origin 必須原樣轉發 —— 8.8.6 的白名單靠它判斷
        #    ⚠️ 有些「安全加固」的設定範本會把 Origin 清掉或改寫成後端網域，
        #      那會讓你的 setAllowedOrigins 永遠通過 —— 等於關掉 CSWSH 防線
        proxy_set_header Origin $http_origin;

        # ④ ★★ 逾時：這是長連線最重要的一組設定
        #    預設 proxy_read_timeout 是 60s —— 代表「60 秒沒有資料就砍連線」。
        #    有心跳（8.9，每 10s）的話 60s 其實夠用，
        #    但設長一點可以在心跳偶爾延遲時多一層容錯。
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;

        # ⑤ ⚠️ 不要設 proxy_buffering off
        #    SSE 需要它（05 章 5.11.7），WebSocket 【不需要】——
        #    升級成功後 Nginx 走的是 tunnel 模式，buffering 設定不影響。
        #    寫在這裡是為了避免你從 SSE 那章複製過來時困惑。
    }
}
```

**驗證腳本**（對照 05 章 5.11.7 的 SSE 版本）：

```bash
#!/usr/bin/env bash
# ⚠️ 一定要打【經過所有代理】的網址，不是 localhost:8080
#    「本機正常」在這一章一次都證明不了什麼（8.2.4）
URL="wss://staging.shop.example/ws"

# ① 握手能不能過（最基本，事故 8.2.4 就卡在這裡）
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)" \
  -H "Origin: https://shop.example" \
  "https://staging.shop.example/ws"
# 期望：HTTP/1.1 101 Switching Protocols
# 🔴 400 → Nginx 的 Upgrade 標頭沒轉發（②）
# 🔴 403 → Origin 白名單沒過（8.8.6 / ③）

# ② Origin 白名單真的有在擋嗎（這一步常常被跳過，然後上線才發現是 "*"）
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)" \
  -H "Origin: https://evil.example" \
  "https://staging.shop.example/ws"
# 期望：403。若是 101 → 🔴 CSWSH 漏洞

# ③ 連線能撐過 idle timeout 嗎（要真的等，沒有捷徑）
websocat -v "$URL" &
sleep 120
# 期望：連線仍然活著（心跳有效）
# 🔴 斷在 60s → proxy_read_timeout 或 ALB idle timeout 沒處理（④）
```

### 8.11.2 連線數上限：四個會先撞到的天花板

```
① 容器的 file descriptor        ulimit -n         ⚠️ 常見預設 1024 —— 最先撞到
② Tomcat 的 max-connections     預設 8192
③ 核心的 somaxconn / 埠號       net.core.somaxconn
④ heap                          8.9.5 算過
```

```yaml
# application.yml
server:
  tomcat:
    # ★ 長連線會佔滿 connection，但【不佔執行緒】（8.9.5）
    max-connections: 20000
    # ⚠️ 執行緒數不需要跟著調大 —— 跟著調反而浪費記憶體
    threads:
      max: 200
    accept-count: 200
```

```yaml
# Kubernetes：沒有這段，上面的設定全部無效
spec:
  containers:
    - name: shop-service
      # ⚠️ 光設 ulimit 不夠，要確認 base image 沒有更低的硬限制
      command: ["/bin/sh", "-c", "ulimit -n 65536 && exec java -jar /app/app.jar"]
```

### 8.11.3 優雅關機：一次部署會發生什麼 ★

**部署時 pod 被砍掉，那台上的所有 WebSocket 連線同時斷線。**

```
8,000 條連線的 pod 被 SIGTERM
  → 連線全斷（close code 1006，因為沒有完成關閉握手）
  → 8,000 個客戶端【同時】重連
  → 剩下的 2 個 pod 各接 4,000 條
  → 🔴 每一條重連都要：握手 + JWT 驗證 + 訂閱授權查詢（8.8.5）+ 歷史訊息快照
  → 資料庫瞬間 8,000 個查詢
```

**三件事一起做**：

```java
package example.shop.chat.web.ws;

import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;

/**
 * 關機時主動、分批地關閉連線。
 *
 * <p>★ 為什麼要主動關，而不是讓行程直接結束：
 * 直接結束 → 客戶端看到 close code <b>1006</b>（8.4.4），
 * 那代表「異常斷線」，前端的重連邏輯會用最短的退避立刻重試。
 * 主動送 {@code 1001}（端點離開）可以讓前端知道「這是計畫中的」，用較長的退避。
 *
 * <p>★★ 分批的理由是 thundering herd（8.9.4）：
 * 一次踢 8,000 個 = 8,000 個同時重連。
 * 每 100ms 踢 200 個 → 重連被攤平在 4 秒內。
 *
 * <p>⚠️ 這段只在「優雅關機」時有效，要搭配：
 * <pre>
 * server.shutdown: graceful
 * spring.lifecycle.timeout-per-shutdown-phase: 30s
 * </pre>
 * 以及 K8s 的 {@code terminationGracePeriodSeconds: 40}（要比上面大）。
 * ⚠️ 兩個值設反的話 K8s 會在 Spring 還在收尾時直接 SIGKILL —— 等於沒做。
 */
@Component
public class GracefulWebSocketShutdown {

    private static final int BATCH_SIZE = 200;
    private static final long BATCH_INTERVAL_MS = 100;

    private final WebSocketSessionRegistry sessions;   // 8.12.4

    public GracefulWebSocketShutdown(WebSocketSessionRegistry sessions) {
        this.sessions = sessions;
    }

    @EventListener(ContextClosedEvent.class)
    public void onShutdown() throws InterruptedException {
        // ① 先讓 readiness probe 失敗（K8s 把這台從 Service 的 endpoint 拿掉），
        //    否則踢掉的連線可能又被導回同一台
        sessions.markNotReady();
        Thread.sleep(2_000);     // 等 kube-proxy 更新 iptables

        // ② 分批送 1001 關閉
        sessions.closeAllInBatches(BATCH_SIZE, BATCH_INTERVAL_MS, CloseStatus.GOING_AWAY);
    }
}
```

> **對照 05 章 5.11.10**：SSE 的關機處理是同一個問題、同一組手法
> （先下線、再分批關、留時間給 K8s 更新路由）。
> 差別只在 SSE 送的是 `complete()`，WebSocket 送的是 close code `1001`。

---

## 8.12 shop-service 落地清單

### 8.12.1 這一章新增的檔案

```
src/main/java/example/shop/chat/
├── web/
│   ├── ws/
│   │   ├── StompConfig.java                          8.7.2  設定入口
│   │   ├── ChatStompController.java                  8.7.4  @MessageMapping
│   │   ├── ChatStompExceptionHandler.java            8.7.6  訊息層例外
│   │   ├── PrincipalHandshakeHandler.java            8.8.3  握手期 Principal
│   │   ├── StompAuthChannelInterceptor.java     ★★  8.8.4  CONNECT 認證
│   │   ├── SubscriptionAuthorizationInterceptor.java ★ 8.8.5 SUBSCRIBE 授權
│   │   ├── StompMdcChannelInterceptor.java           8.12.4 traceId
│   │   ├── WebSocketSessionRegistry.java             8.12.4 連線登錄簿 + 指標
│   │   ├── UnauthenticatedConnectionReaper.java      8.8.2  未 CONNECT 的連線
│   │   ├── TokenExpiryReaper.java               ★    8.8.4  token 過期後踢人
│   │   └── GracefulWebSocketShutdown.java            8.11.3 關機
│   └── dto/
│       ├── ChatMessageRequest.java                   02 章的 Bean Validation
│       ├── ChatMessageResponse.java
│       └── ChatEnvelope.java                         8.10.3 扇出信封
├── service/
│   ├── ChatService.java                              業務邏輯（05-service 的範疇）
│   ├── ChatBroadcaster.java                     ★★  8.10.3 發佈端
│   ├── ChatFanoutListener.java                  ★★  8.10.3 訂閱端
│   └── ConversationGuard.java                        8.8.5 授權判斷
└── ChatProperties.java                               8.12.3
```

### 8.12.2 `application.yml`（這一章相關的部分）

```yaml
server:
  tomcat:
    max-connections: 20000        # 8.11.2 ★ 長連線佔 connection 不佔執行緒
    threads:
      max: 200                    # ⚠️ 不需要跟著 max-connections 調大
    accept-count: 200
  shutdown: graceful              # 8.11.3

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s     # ⚠️ 要 < K8s terminationGracePeriodSeconds

shop:
  chat:
    # 8.8.6 ★★ 絕對不能是 "*"。這是 CSWSH 的唯一防線
    allowed-origins:
      - https://shop.example
      - https://admin.shop.example

    # 8.9.3 心跳。要 < 最短中間層 idle timeout 的一半
    heartbeat-interval: 10s

    # 8.8.2 ★ 建立連線後多久內必須完成 STOMP CONNECT，否則踢掉
    connect-timeout: 10s

    # 8.6.3 / 8.7.2 背壓 —— slow consumer 的防線
    message-size-limit: 64KB
    send-buffer-size-limit: 512KB
    send-time-limit: 5s

    # 8.9.5 ★ 每台 pod 的連線數上限（不設 = 一個惡意客戶端就能吃光 max-connections）
    max-sessions-per-node: 8000
    max-sessions-per-user: 5      # 多分頁是正常的，但 5 個以上通常是 bug 或攻擊

logging:
  level:
    # ⚠️ 開這個會印出每一個 STOMP frame —— 只在除錯時開，
    #    正式環境開著等於把所有聊天內容寫進 log（個資問題）
    org.springframework.web.socket.messaging: INFO
```

### 8.12.3 `ChatProperties`

```java
package example.shop.chat;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotEmpty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;
import java.util.List;

/**
 * ★ 為什麼這些值必須是設定而不是常數（沿用 05 章 5.11.6 的同一個理由）：
 * 本機開發要連 {@code http://localhost:5173}，正式環境絕對不能有那一筆。
 * 寫死成常數的結果就是有人為了本機能動而改成 {@code "*"} 然後忘了改回來 —— 8.8.6 的漏洞。
 */
@Validated
@ConfigurationProperties(prefix = "shop.chat")
public record ChatProperties(

        /** 8.8.6 ⚠️ 不接受 "*"，在 {@code validate()} 裡強制。 */
        @NotEmpty List<String> allowedOrigins,

        Duration heartbeatInterval,
        Duration connectTimeout,
        DataSize messageSizeLimit,
        DataSize sendBufferSizeLimit,
        Duration sendTimeLimit,

        @Min(1) int maxSessionsPerNode,
        @Min(1) int maxSessionsPerUser
) {

    public ChatProperties {
        // ★★ 在啟動時就炸掉，而不是等到被攻擊才發現。
        //    這比任何文件或 code review 都可靠。
        if (allowedOrigins.contains("*")) {
            throw new IllegalStateException(
                    "shop.chat.allowed-origins 不可以是 \"*\" —— " +
                    "WebSocket 不受同源政策保護，這會造成 CSWSH（見 08 章 8.8.6）");
        }
    }
}
```

### 8.12.4 連線登錄簿與兩個 reaper ★

```java
package example.shop.chat.web.ws;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 本機連線登錄簿 —— 對照 05 章 5.11.6 的 {@code SseEmitterRegistry}。
 *
 * <p>★★ <b>為什麼需要它，明明 Spring 已經有 {@code SimpUserRegistry}</b>：
 * {@code SimpUserRegistry} 只給你「誰在線上」，但不給你
 * (a) 這條連線什麼時候建立的、(b) token 什麼時候過期、(c) 主動關閉它的能力。
 * 8.8.2 的未認證連線、8.8.4 的 token 過期、8.11.3 的分批關機都需要那三樣。
 *
 * <p>⚠️ 一樣只知道<b>本機</b>的連線（8.10.1）。它不是 8.2.1 的解法，
 * 它是「管理本機資源」的工具。跨 pod 的事情由 {@link example.shop.chat.service.ChatBroadcaster} 負責。
 */
@Component
public class WebSocketSessionRegistry {

    private static final Logger log = LoggerFactory.getLogger(WebSocketSessionRegistry.class);

    private final Map<String, SessionEntry> sessions = new ConcurrentHashMap<>();
    private final ChatProperties properties;
    private final Clock clock;

    public WebSocketSessionRegistry(ChatProperties properties,
                                    Clock clock,
                                    MeterRegistry meterRegistry) {
        this.properties = properties;
        // ★ 注入 Clock 而不是用 Instant.now() —— 07 章 7.4.4 的結論，測試才固定得住
        this.clock = clock;

        // ★★ 這個指標是 8.2.3 事故的早期警報：
        //    「單調遞增而且從不下降」就是半開連線堆積。
        //    ⚠️ 光看它不夠，要同時看 rate(closed) —— 只增不減才是問題。
        Gauge.builder("chat.websocket.sessions.active", sessions, Map::size)
                .description("本機目前的 WebSocket 連線數")
                .register(meterRegistry);
    }

    public record SessionEntry(WebSocketSession session,
                               String userId,
                               Instant connectedAt,
                               Instant tokenExpiresAt,
                               boolean authenticated) {
    }

    /**
     * 8.8.2 ⚠️ 建立了連線但一直不送 CONNECT 的，踢掉。
     *
     * <p>沒有這個的話，攻擊者可以只做握手（那是 permitAll 的）就佔住 connection slot，
     * 用 8,000 條未認證連線把 {@code max-connections} 吃光 —— 一種很便宜的 DoS。
     */
    @Scheduled(fixedDelay = 5_000)
    public void reapUnauthenticated() {
        Instant deadline = clock.instant().minus(properties.connectTimeout());
        sessions.values().removeIf(entry -> {
            if (entry.authenticated() || entry.connectedAt().isAfter(deadline)) {
                return false;
            }
            close(entry, new CloseStatus(4002, "未完成認證"));
            return true;
        });
    }

    /**
     * 8.8.4 ★★ token 過期後把連線踢掉。
     *
     * <p><b>這是 8.8.4「只在 CONNECT 驗一次」那個決定的必要配套。</b>
     * 沒有它的話，一個已經登出 / 被停權的使用者可以繼續收訊息好幾個小時。
     *
     * <p>★ 送 4001（過期）而不是 4002（無效）—— 8.9.4 的前端會刷新 token 後重連，
     * 使用者完全無感。
     */
    @Scheduled(fixedDelay = 30_000)
    public void reapExpiredTokens() {
        Instant now = clock.instant();
        sessions.values().removeIf(entry -> {
            if (entry.tokenExpiresAt() == null || entry.tokenExpiresAt().isAfter(now)) {
                return false;
            }
            log.debug("token 過期，關閉連線 userId={}", entry.userId());
            close(entry, new CloseStatus(4001, "token 已過期"));
            return true;
        });
    }

    private void close(SessionEntry entry, CloseStatus status) {
        try {
            entry.session().close(status);
        } catch (Exception ex) {
            // ⚠️ 關閉失敗是正常的（對方可能已經不在了）。不要用 error 等級，
            //    否則半開連線會在關機時刷出幾千行 ERROR
            log.debug("關閉連線失敗 id={}", entry.session().getId(), ex);
        }
    }
}
```

**MDC 的接回**（04 章 4.5 的 `traceId` 在訊息層的版本）：

```java
package example.shop.chat.web.ws;

import org.slf4j.MDC;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * 讓每則 STOMP 訊息都有 traceId —— 04 章 4.5 的 {@code MdcFilter} 在訊息層的對應物。
 *
 * <p>★★ 為什麼非做不可：8.6.4 說過回呼不在請求執行緒上，MDC 是空的。
 * 沒有這個 interceptor 的話，聊天相關的日誌<b>完全無法和 HTTP 請求的日誌關聯</b> ——
 * 出事時你有一堆「送出失敗」但不知道是哪個使用者的哪一次操作。
 *
 * <p>⚠️ {@code afterSendCompletion} 的清理<b>不能省</b>：
 * 訊息通道用的是執行緒池，執行緒會被重用。
 * 不清的話下一則訊息會沿用上一則的 traceId ——
 * 症狀是「日誌裡兩個不相干的使用者共用同一個 traceId」，而且極難發現。
 */
@Component
public class StompMdcChannelInterceptor implements ChannelInterceptor {

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor =
                MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor != null) {
            MDC.put("traceId", UUID.randomUUID().toString().replace("-", "").substring(0, 16));
            MDC.put("wsSessionId", String.valueOf(accessor.getSessionId()));
            if (accessor.getUser() != null) {
                MDC.put("userId", accessor.getUser().getName());
            }
        }
        return message;
    }

    @Override
    public void afterSendCompletion(Message<?> message, MessageChannel channel,
                                    boolean sent, Exception ex) {
        MDC.clear();     // ⚠️ 見上面的 javadoc
    }
}
```

### 8.12.5 這一章補回了 8.4.1 那張表的哪幾列 ★

| `101` 之後失去的東西 | 這一章用什麼補回來 | 在哪一節 |
|---|---|---|
| Filter chain | `ChannelInterceptor` | 8.7.2、8.8.4 |
| `@ControllerAdvice` | `@MessageExceptionHandler` | 8.7.6 |
| HTTP 狀態碼 | close code（含 4xxx 自訂區） | 8.4.4 |
| 認證 | CONNECT frame 的 token / 握手的 session | 8.8.3、8.8.4 |
| 授權 | `SUBSCRIBE` 攔截 + `@PreAuthorize` | 8.8.5 |
| CORS | `setAllowedOrigins` 白名單 | 8.8.6 |
| `traceId` / MDC | `StompMdcChannelInterceptor` | 8.12.4 |
| 連線的「結束」 | 心跳 + 兩個 reaper | 8.9、8.12.4 |
| **跨實例** | **Redis 扇出** | **8.10.3** |

⚠️ **唯一沒有補回來、也補不回來的是「無狀態」。**
一條 WebSocket 連線就是狀態，而狀態必然帶來 8.10 的所有問題。
這是選擇 WebSocket 時真正付出的代價——**不是寫程式的成本，是運維的成本**。

---

## 8.13 測試

### 8.13.1 三層測試策略 ★

**WebSocket 測試最重要的一個判斷是：大部分的東西不需要真的開一條連線。**

| 測什麼 | 怎麼測 | 要不要真連線 | 速度 |
|---|---|---|---|
| `ChannelInterceptor` 的認證 / 授權邏輯 | 純單元測試，自己組 `Message` | ❌ **不要** | 毫秒 |
| `@MessageMapping` 的參數綁定與驗證 | 單元測試 controller + mock `SimpMessagingTemplate` | ❌ 不要 | 毫秒 |
| 扇出的 envelope 序列化 | 單元測試 | ❌ 不要 | 毫秒 |
| 端到端：握手 → CONNECT → SUBSCRIBE → 收到訊息 | `WebSocketStompClient` + `@SpringBootTest(webEnvironment = RANDOM_PORT)` | ✅ 要 | 秒 |
| `Origin` 白名單真的有擋 | 真連線 | ✅ 要 | 秒 |

> **對照 07 章 7.3.4 的測試金字塔決策流程**：結論一樣——
> **能不開連線就不要開**。一個端到端 WebSocket 測試大約 1～3 秒，
> 而且它是這一章最容易寫出 flaky 測試的地方（8.13.4）。

### 8.13.2 攔截器的單元測試（不開連線）

```java
package example.shop.chat.web.ws;

import org.junit.jupiter.api.Test;
import org.springframework.messaging.Message;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * ★ 這個測試類別示範了本章最有價值的測試手法：
 * 直接<b>組一個 STOMP Message 出來</b>，完全不碰網路。
 * 8.8.4 的認證邏輯、8.8.5 的授權邏輯都可以這樣測，快而且完全穩定。
 */
class StompAuthChannelInterceptorTest {

    private final JwtVerifier jwtVerifier = mock(JwtVerifier.class);
    private final StompAuthChannelInterceptor interceptor =
            new StompAuthChannelInterceptor(jwtVerifier);

    /** 自己組一個 CONNECT frame —— 這是整個手法的關鍵。 */
    private Message<byte[]> connectFrame(String authorization) {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.CONNECT);
        accessor.setSessionId("sess-1");
        accessor.setSessionAttributes(new java.util.HashMap<>());
        if (authorization != null) {
            accessor.setNativeHeader("Authorization", authorization);
        }
        return MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());
    }

    @Test
    void 有效的_token_會設定_principal_而且_name_是_userId() {
        when(jwtVerifier.verify("good"))
                .thenReturn(new VerifiedToken("agent-17", java.util.Set.of("AGENT"),
                        java.time.Instant.parse("2026-09-16T05:00:00Z")));

        Message<?> result = interceptor.preSend(connectFrame("Bearer good"), null);

        StompHeaderAccessor accessor = StompHeaderAccessor.wrap(result);
        // ★★ 這個斷言守護的是 8.7.5 的約定：
        //    name 必須是 userId，否則 convertAndSendToUser 會安靜地送不到
        assertThat(accessor.getUser()).isNotNull();
        assertThat(accessor.getUser().getName()).isEqualTo("agent-17");
    }

    @Test
    void 過期的_token_回_4001_而不是_4002() {
        when(jwtVerifier.verify("expired")).thenThrow(new TokenExpiredException());

        // ★ 為什麼要特別測 code：8.9.4 的前端靠它決定「刷新後重連」還是「導向登入」。
        //   搞錯的話使用者會被登出，或是陷入無限重連
        assertThatThrownBy(() -> interceptor.preSend(connectFrame("Bearer expired"), null))
                .isInstanceOf(StompAuthenticationException.class)
                .hasFieldOrPropertyWithValue("closeCode", 4001);
    }

    @Test
    void 沒有_Authorization_header_要拋例外而不是放行() {
        // ⚠️ 這是 8.2.2 事故的迴歸測試。
        //    「回傳 null 讓訊息被丟掉」會讓前端永遠轉圈圈，是更糟的失敗模式
        assertThatThrownBy(() -> interceptor.preSend(connectFrame(null), null))
                .isInstanceOf(StompAuthenticationException.class)
                .hasFieldOrPropertyWithValue("closeCode", 4002);
    }

    @Test
    void 非_CONNECT_的_frame_直接放行不做驗證() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SEND);
        Message<byte[]> send = MessageBuilder.createMessage(
                new byte[0], accessor.getMessageHeaders());

        // ★ 守護 8.8.4 的效能決定：每則訊息都驗 JWT 是浪費
        assertThat(interceptor.preSend(send, null)).isSameAs(send);
    }
}
```

**授權的參數化測試**（對照 07 章 7.8）：

```java
class SubscriptionAuthorizationInterceptorTest {

    @ParameterizedTest
    @CsvSource({
        // destination,                                 有權限,  應該通過
        "/topic/conversations/conv-8812,                true,   true",
        "/topic/conversations/conv-9999,                false,  false",   // IDOR
        "/topic/conversations/conv-8812/typing,         true,   true",
        "/user/queue/notifications,                     false,  true",    // /user 天生安全
        "/topic/admin/metrics,                          true,   false",   // 白名單外
        "/topic/conversations/../admin,                 true,   false",   // 路徑穿越
        "/topic/conversations/,                         true,   false",   // 空 id
    })
    void 訂閱授權(String destination, boolean hasAccess, boolean shouldPass) {
        // ★ 倒數三列是重點：它們測的是「白名單而不是黑名單」這個決定（8.8.5）。
        //   一個只擋 conv-9999 的實作會讓那三列全部通過
        ...
    }
}
```

### 8.13.3 端到端測試

```java
package example.shop.chat.web.ws;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.messaging.converter.MappingJackson2MessageConverter;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.springframework.messaging.simp.stomp.StompSession;
import org.springframework.messaging.simp.stomp.StompSessionHandlerAdapter;
import org.springframework.messaging.simp.stomp.StompFrameHandler;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

import java.lang.reflect.Type;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ChatStompIntegrationTest {

    @LocalServerPort
    int port;

    @Autowired
    ObjectMapper objectMapper;

    private WebSocketStompClient client() {
        WebSocketStompClient client = new WebSocketStompClient(new StandardWebSocketClient());
        // ⚠️ 不設 converter 的話收到的是 byte[]，斷言會很難寫
        client.setMessageConverter(new MappingJackson2MessageConverter(objectMapper));
        return client;
    }

    @Test
    void 訂閱後可以收到別人送出的訊息() throws Exception {
        // ★ 用 BlockingQueue 而不是 volatile 欄位 —— 訊息在別的執行緒到達，
        //   而 queue 的 poll(timeout) 同時解決了「等待」與「執行緒可見性」
        BlockingQueue<ChatMessageResponse> received = new LinkedBlockingQueue<>();

        StompHeaders connectHeaders = new StompHeaders();
        // ★ 8.8.4 的做法 4：token 走 CONNECT frame，不是 URL
        connectHeaders.add("Authorization", "Bearer " + TestTokens.forAgent("agent-17"));

        StompSession session = client()
                .connectAsync("ws://localhost:" + port + "/ws",
                        new WebSocketHttpHeaders(), connectHeaders,
                        new StompSessionHandlerAdapter() {})
                .get(5, TimeUnit.SECONDS);

        session.subscribe("/topic/conversations/conv-8812", new StompFrameHandler() {
            @Override
            public Type getPayloadType(StompHeaders headers) {
                return ChatMessageResponse.class;
            }
            @Override
            public void handleFrame(StompHeaders headers, Object payload) {
                received.add((ChatMessageResponse) payload);
            }
        });

        // ⚠️⚠️ 這個 sleep 是這一章最容易寫錯的地方，見 8.13.4
        awaitSubscriptionRegistered(session);

        session.send("/app/conversations/conv-8812/messages",
                new ChatMessageRequest("您好"));

        ChatMessageResponse message = received.poll(5, TimeUnit.SECONDS);
        assertThat(message).isNotNull();
        assertThat(message.text()).isEqualTo("您好");
    }

    @Test
    void 來自未授權_Origin_的握手會被拒絕() throws Exception {
        WebSocketHttpHeaders handshakeHeaders = new WebSocketHttpHeaders();
        handshakeHeaders.add("Origin", "https://evil.example");

        // ★★ 這是 8.8.6 的 CSWSH 迴歸測試 —— 它守護的是一個【資安漏洞】，
        //    而那個漏洞只要有人把 allowed-origins 改成 "*" 就會重新出現。
        //    ⚠️ 這個測試比端到端的功能測試更值得寫
        assertThatThrownBy(() -> client()
                .connectAsync("ws://localhost:" + port + "/ws",
                        handshakeHeaders, new StompSessionHandlerAdapter() {})
                .get(5, TimeUnit.SECONDS))
                .hasRootCauseInstanceOf(IOException.class);
    }
}
```

### 8.13.4 為什麼 WebSocket 的測試特別容易 flaky ★

**根源：`subscribe()` 回傳時，訂閱還沒有真的註冊完成。**

```
測試執行緒                          伺服器
   │
   ├─ session.subscribe(...)  ───────→  SUBSCRIBE frame 在路上
   │   （立刻回傳，不等確認）
   │
   ├─ session.send(...)       ───────→  SEND frame
   │                                     │
   │                                     ├─ 處理 SEND，廣播
   │                                     │   🔴 此時訂閱可能還沒註冊 → 訊息送給了空集合
   │                                     └─ 才處理 SUBSCRIBE
   │
   └─ poll(5s) → null → 測試失敗（而且是隨機失敗）
```

**三種處理方式**：

| 做法 | 評價 |
|---|---|
| `Thread.sleep(500)` | 🔴 **不要**。在 CI 上機器慢時仍然會 flaky，而且每個測試白等 500ms |
| **用 `receipt`** ★ | STOMP 的 `receipt` header 就是為此存在的（8.5.2 需求 5）。`setReceiptCallback` 確認訂閱真的到了 |
| Awaitility 輪詢 `SimpUserRegistry` | 可行，但比 receipt 間接 |

```java
/**
 * ★ 正確做法：用 STOMP 的 receipt 等待訂閱真的註冊完成。
 * ⚠️ 需要在 client 上設定 {@code setAutoReceipt(true)} 或手動給 receipt id。
 */
private void awaitSubscriptionRegistered(StompSession session, StompSession.Subscription sub)
        throws Exception {
    CountDownLatch latch = new CountDownLatch(1);
    sub.addReceiptTask(latch::countDown);
    assertThat(latch.await(5, TimeUnit.SECONDS))
            .as("訂閱未在 5 秒內完成註冊")
            .isTrue();
}
```

> **對照 07 章 7.12.8 的「用 `await()` 而不是 `sleep`」**——同一條原則的第二次出現。
> 差別在這裡連 `await()` 都不夠好，因為協定本身提供了明確的確認機制（receipt），
> **有明確信號時就不要輪詢**。

---

## 8.14 常見誤區

**誤區 1：「WebSocket 比 SSE 好，因為它是雙向的」**

8.3.1：「雙向」不是判準——前端本來就能用 POST。
真正的判準是**上行頻率、延遲來源、要不要對特定連線回話**。
三個都不成立就用 SSE，而它有瀏覽器內建重連與 `Last-Event-ID`（05 章 5.11）。

**誤區 2：「`Sec-WebSocket-Key` 提供了某種安全保障」**

8.4.2：算法完全公開（那串 GUID 寫在 RFC 裡）。
它防的是**快取污染**，不是身分。masking 也一樣——**key 就明文寫在 frame 標頭裡**。
機密性 100% 來自 TLS。

**誤區 3：「`101` 之後 Spring Security 還在保護我」**

8.4.1：filter chain 只跑**握手那一次**。
之後每一則訊息都不經過任何 filter。訊息層的授權要用 `ChannelInterceptor`（8.8.5）。

**誤區 4：「`@RestControllerAdvice` 會接到 WebSocket 的例外」**

8.7.6：它掛在 `HandlerExceptionResolver` 上，那是 MVC 的元件。
訊息層要用 `@MessageExceptionHandler`。**沒有它的話，未預期的例外只會留一行伺服器日誌，
前端的症狀是「送出後永遠沒反應」。**

**誤區 5：「直接讓例外冒出去，客戶端會收到 ERROR frame」**

8.7.6：會，但 STOMP 規格要求**送出 `ERROR` 後必須關閉連線**。
一個「訊息太長」的驗證錯誤會把整條連線踢掉，觸發重連 + 重訂閱 + 重拉歷史。
**用普通訊息回報錯誤（`@SendToUser("/queue/errors")`）。**

**誤區 6：「瀏覽器的 WebSocket 可以帶 `Authorization` header」**

8.2.2、8.8.1：`new WebSocket(url, protocols)` **沒有第三個參數**。
⚠️ 而伺服器端的 WebSocket 客戶端（Postman、Node 的 `ws`）**可以**——
所以「用 Postman 測都正常」完全不能證明瀏覽器會正常。

**誤區 7：「把 token 放 URL query string 就好了」**

8.8.2：它會進 **Nginx access log、瀏覽器歷史、`Referer`、APM 的 span 名稱**。
一個長效 JWT 會永久留在日誌歸檔裡。用 STOMP `CONNECT` frame 的 header。

**誤區 8：「在 CONNECT 驗一次 token 就夠了」**

8.8.4：夠，但**必須配一個 reaper**（8.12.4）。
否則一條活 8 小時的連線會讓已登出 / 已停權的使用者繼續收訊息。

**誤區 9：「WebSocket 受同源政策保護」**

8.8.6 ★★：**完全不受**。瀏覽器對 WebSocket 握手**不做 CORS 檢查**，
而且會**自動帶上 cookie**。任何網站都能對你的端點發起帶著受害者身分的握手（CSWSH）。
`setAllowedOrigins` 是你唯一的鎖，**而 `"*"` 等於自己把它拆掉**。

**誤區 10：「`setAllowedOrigins("*")` 只是開發方便，上線前會改」**

8.12.3：不會。所以那個檢查要寫在 `ChatProperties` 的建構子裡，**啟動時就炸掉**。
這比任何文件或 code review 都可靠。

**誤區 11：「`SUBSCRIBE` 會被 `@PreAuthorize` 擋住」**

8.8.5 ★：`SUBSCRIBE` frame **不會走到任何 `@MessageMapping` 方法**——它是給 broker 的。
方法層權限完全看不到它。不攔的話任何登入使用者都能訂閱別人的對話（WebSocket 版 IDOR）。

**誤區 12：「`WebSocketSession` 可以從多條執行緒送訊息」**

8.6.2 ★：不行。大訊息會被分片，兩條執行緒交錯寫入會破壞協定，
Tomcat 丟 `IllegalStateException: The remote endpoint was in state [TEXT_PARTIAL_WRITING]`。
⚠️ **本機測不出來**（訊息小、併發低時不會分片）。

**誤區 13：「設 `sendBufferSizeLimit` 是為了省記憶體」**

8.6.3：是為了防 **slow consumer**。
一個在地鐵裡的使用者收得極慢，你每秒推 10 則給他，全部堆在佇列裡——
**一個連不上的客戶端可以拖垮整台伺服器**。

**誤區 14：「有 TCP keepalive 就不用應用層心跳」**

8.2.3、8.9.1 ★：Linux 預設 `tcp_keepalive_time = 7200`（2 小時），
而且 **Java 預設根本沒開 `SO_KEEPALIVE`**。總偵測時間約 **2 小時 11 分**。

**誤區 15：「WebSocket 的 Ping/Pong 就是最好的心跳」**

8.9.1：Ping/Pong 由 Tomcat 在 **I/O 層自動回應**——
**應用程式 deadlock 時它照樣回 Pong**。STOMP 層的心跳才需要應用執行緒參與。

**誤區 16：「`setHeartbeatValue` 設了就會生效」**

8.7.2 ⚠️：沒有搭配 `setTaskScheduler()` 的話 Spring **會安靜地忽略它**。
沒有警告、沒有例外。

**誤區 17：「伺服器設了心跳，心跳就會動」**

8.9.2：心跳是**雙方協商**的。前端函式庫送 `heart-beat:0,0` 就等於全部關掉，
而你的設定看起來完全正常。**要看 `CONNECTED` frame 的實際值才算驗證過。**

**誤區 18：「斷線了就重連」**

8.4.4、8.9.4 ★：`4002`（token 無效）無腦重連 = **每 3 秒一次完整握手 + DB 查詢的無限迴圈**。
要依 close code 分流，而且退避**必須有 jitter**（否則一次 pod 重啟讓 8,000 個客戶端同時重連）。

**誤區 19：「看到 close code `1006` 表示伺服器回了 1006」**

8.4.4：`1006` **永遠不會在網路上傳輸**。它是瀏覽器在「連線斷了但沒收到 close frame」時自己填的。
看到它 = 沒有完成關閉握手 = 網路斷了 / 中間層砍了連線 / 伺服器被 `kill -9`。

**誤區 20：「sticky session 解決了多實例問題」**

8.10.2 ①：它讓「同一個人」固定到同一台，但聊天是**兩個人**之間的事。
A 和 B 還是可能在不同 pod 上。**它完全解決不了 8.2.1 的事故。**

**誤區 21：「`convertAndSendToUser()` 找不到人會報錯」**

8.7.5 後果 2 ★★：**no-op**。沒有回傳值、沒有例外、沒有日誌。
這正是 8.2.1 事故「掉了三分之二訊息卻完全不報錯」的直接成因。

**誤區 22：「Redis pub/sub 接上去就可靠了」**

8.10.4：它是**射後不理**。pod 重啟中、Redis 短暫斷線、訂閱者 buffer 滿——三種情況都會丟訊息。
**這可以接受的唯一前提是「快照 + 增量」架構**（訊息的可靠來源是資料庫）。

**誤區 23：「WebSocket 不佔執行緒，所以可以無限開」**

8.9.5：它不佔**工作執行緒**（這點和 SSE 一樣），但佔 **connection slot**
（`max-connections` 預設 8192）與 **file descriptor**（容器裡常常只有 1024 🔴）。

**誤區 24：「握手是 `permitAll()` 沒關係，反正 CONNECT 會擋」**

8.8.2 ⚠️：那段期間連線已經佔住一個 connection slot 了。
攻擊者用 8,000 條「只握手、不 CONNECT」的連線就能吃光 `max-connections`——很便宜的 DoS。
必須有 `connect-timeout` 與 reaper（8.12.4）。

**誤區 25：「本機能動就代表能動」**

8.2.4 ★：本機沒有 Nginx。`Upgrade` 是 **hop-by-hop header**，
代理預設**必須**把它拿掉。沒有 `proxy_http_version 1.1` + 那兩行 `proxy_set_header`，
握手直接 400，而且**後端日誌一行都沒有**。

**誤區 26：「`Thread.sleep(500)` 可以讓 WebSocket 測試穩定」**

8.13.4：`subscribe()` 回傳時訂閱還沒註冊完成。
sleep 在 CI 慢的時候一樣會 flaky。**用 STOMP 的 `receipt`**——協定本身就提供了確認機制。

**誤區 27：「每則訊息都要驗一次 token 比較安全」**

8.8.4：一條連線的身分在建立時就固定了，中途不可能換人（不像 HTTP）。
每則訊息驗 JWT 簽章是純 CPU 浪費，而聊天訊息頻率很高。
**正確的做法是驗一次 + reaper**（誤區 8）。

**誤區 28：「用了 STOMP 就不用管 slow consumer」**

8.6.3：你只是換了設定的地方（`configureWebSocketTransport` 而不是
`ConcurrentWebSocketSessionDecorator`）。**問題本身不會消失。**

---

## 8.15 本章練習

### 練習 1：找出這個聊天端點的 11 個問題

```java
@Configuration
@EnableWebSocketMessageBroker
public class WsConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws").setAllowedOrigins("*").withSockJS();
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic")
                .setHeartbeatValue(new long[]{10000, 10000});
        registry.setApplicationDestinationPrefixes("/app");
    }
}

@Controller
public class ChatController {

    @Autowired
    private SimpMessagingTemplate template;

    @Autowired
    private MessageRepository messageRepository;

    private final Map<String, WebSocketSession> sessions = new HashMap<>();

    @MessageMapping("/send")
    public void send(Map<String, String> payload) {
        String conversationId = payload.get("conversationId");
        String text = payload.get("text");
        String userId = payload.get("userId");

        Message message = new Message();
        message.setConversationId(conversationId);
        message.setUserId(userId);
        message.setText(text);
        messageRepository.save(message);

        template.convertAndSend("/topic/" + conversationId, message);

        log.info("使用者 {} 在對話 {} 送出：{}", userId, conversationId, text);
    }
}
```

<details>
<summary>參考答案</summary>

**安全問題（5 個）**

| # | 問題 | 在哪一節 |
|---|---|---|
| 1 | 🔴 **`setAllowedOrigins("*")`** —— CSWSH。任何網站都能以受害者身分建立連線 | 8.8.6 |
| 2 | 🔴 **`userId` 來自 payload** —— 攻擊者可以冒充任何人送訊息。必須用 `Principal`，不是客戶端說的 | 8.8.4 |
| 3 | 🔴 **沒有 `SUBSCRIBE` 授權** —— 任何人都能訂閱 `/topic/conv-9999` 偷看別人的對話（IDOR） | 8.8.5 |
| 4 | 🔴 **沒有認證** —— 沒有任何 `ChannelInterceptor`，`Principal` 永遠是 null | 8.8.4 |
| 5 | ⚠️ **把訊息內容寫進 log** —— 聊天內容是個資，不該進日誌歸檔 | 8.12.2 |

**正確性問題（3 個）**

| # | 問題 | 在哪一節 |
|---|---|---|
| 6 | 🔴 **`setHeartbeatValue` 沒有 `setTaskScheduler()`** —— 心跳被安靜忽略，半開連線永遠堆積 | 8.7.2、8.9.1 |
| 7 | 🔴 **`HashMap` 存 session** —— 不是執行緒安全的。要 `ConcurrentHashMap`，而且這個欄位根本沒被用到（死碼） | 8.6.2 |
| 8 | 🔴 **多實例下訊息掉三分之二** —— `convertAndSend` 只送本機。需要扇出 | 8.10 |

**設計問題（3 個）**

| # | 問題 | 在哪一節 |
|---|---|---|
| 9 | ⚠️ **`Map<String, String>` 當 DTO** —— 沒有型別、沒有 `@Valid`、沒有長度限制。一則 10 MB 的訊息會直接進資料庫 | 8.7.4 |
| 10 | ⚠️ **沒有 `@MessageExceptionHandler`** —— `save()` 失敗時前端永遠沒反應 | 8.7.6 |
| 11 | ⚠️ **直接回傳 entity** —— 把資料庫欄位洩漏給前端，且 lazy 關聯會炸（03-rest-api 的結論） | 8.6.4 |

**加分題**：`.withSockJS()` 不是錯誤，但它會讓 8.11 的 Nginx 設定複雜一倍
（多出 `/info` 端點與 xhr-streaming 後備傳輸）。只在需要支援極舊瀏覽器時才加。

</details>

### 練習 2：診斷

生產環境的監控出現以下組合，說出最可能的原因與驗證方法：

```
chat.websocket.sessions.active     ：單調遞增，三天到 8,000，從不下降
chat.message.sent.rate             ：正常（每秒 30 則）
chat.message.delivery.failure.rate ：0
JVM heap                           ：緩慢上升
Nginx 的 4xx/5xx                   ：正常
```

<details>
<summary>參考答案</summary>

**最可能：半開連線堆積（8.2.3）**，而且**心跳沒有生效**。

推理過程：

| 觀察 | 推論 |
|---|---|
| `sessions.active` 只增不減 | 連線從來沒有被關閉過 → `afterConnectionClosed` 沒被觸發 |
| `delivery.failure.rate` 是 0 | ⚠️ 這是**誤導性的**——`convertAndSendToUser` 找不到人是 no-op，**本來就不會計入失敗**（8.7.5 後果 2、誤區 21） |
| heap 緩慢上升 | 每條死連線的 session 物件與訂閱狀態沒被回收 |
| Nginx 沒有錯誤 | 問題不在握手，在既有連線 |

**驗證方法**（依成本排序）：

1. **看 `CONNECTED` frame 的實際心跳值**（8.9.2）——最快、最可能中。
   前端函式庫送 `heart-beat:0,0` 的話，伺服器設定再正確也沒用。
2. **檢查 `setTaskScheduler()` 有沒有設**（8.7.2、誤區 16）——沒設的話心跳被安靜忽略。
3. `ss -tn state established '( dport = :8080 )' | wc -l` 比對實際 TCP 連線數。
   如果**遠小於** `sessions.active`，就確定是半開連線。
4. 加一個 `sessions.active` 的年齡分布指標（p50 / p99 連線存活時間）。
   正常的聊天連線應該是幾十分鐘量級；出現大量「三天沒斷」的連線就是證據。

**為什麼不是「使用者真的很多」**：DAU 1,200 卻有 8,000 條連線，
而且**從不下降**——真實使用者晚上會關電腦。

</details>

### 練習 3：設計

> 需求：shop-service 要加一個「賣家後台的即時訂單看板」。
> 賣家開著頁面，有新訂單時要立刻出現在列表最上方。
> 尖峰時段一個熱門賣家每分鐘約 40 張訂單，平常每小時 2～3 張。
> 賣家後台同時在線約 3,000 人，部署是 4 個 pod。

回答以下問題，每題都要給出**理由**而不只是結論：

1. 用 SSE 還是 WebSocket？（提示：把 8.3.1 的三個判準逐一套進去）
2. 如果選 SSE，多實例的問題要怎麼解？和 8.10.3 有什麼不同？
3. 賣家開了三個分頁，要收到三份還是一份？怎麼實作？
4. 賣家的網路斷了 30 秒，期間有 5 張新訂單。重連後他應該看到什麼？
5. 這個功能該不該有心跳？如果有，間隔選多少？

<details>
<summary>參考答案（要點）</summary>

**1. SSE。** 三個判準一個都不成立：

| 判準 | 這個需求 |
|---|---|
| 上行頻率高？ | ❌ 賣家幾乎不上行（點擊訂單是一般的 `GET`） |
| 需要低延遲？ | ❌ 訂單晚 1 秒出現完全沒差 |
| 要對特定連線回話？ | ❌ 是「推給這個賣家」，不是「回覆這一條連線」 |

**選 WebSocket 是這一章最想讓你避免的錯誤**——它會為了一個純單向推送的需求，
引入 8.8～8.11 的全部運維成本。

**2.** 一樣要扇出（05 章 5.11.6 的結論），但**比 8.10.3 簡單**：
事件來源是**伺服器內部**（訂單建立），不是另一個使用者的連線。
所以可以直接接 11-messaging 的訂單事件流，
每個 pod 訂閱同一個 topic，各自推給本機連線——**不需要 Redis pub/sub 這一層**。

**3. 三份**（SSE 與 `/user/**` 都是這個行為，8.7.5 後果 1）。
而且這裡**三份是對的**——三個分頁各自有一份列表 UI 要更新。
⚠️ 如果是「桌面通知」那種一次性動作，才需要去重。

**4. 他應該看到 5 張新訂單，而且順序正確。**
但**不能靠 SSE 補送**（8.7.5、8.10.4）：

```
重連時：
  ① GET /seller/orders?since={lastSeenOrderId}   ← 快照，可靠
  ② 重新 SUBSCRIBE                                ← 增量
```

SSE 的 `Last-Event-ID`（05 章 5.11.5）**可以**做到補送，但前提是事件被持久化了。
⚠️ 而且使用者按 F5 時**不會**帶 `Last-Event-ID`——所以 ① 無論如何都要有。

**5. 要，30 秒。**
理由是 8.9.3 的公式：ALB / Nginx 的 idle timeout 是 60s，心跳要 < 30s。
⚠️ 注意這個功能「平常每小時 2～3 張訂單」——**沒有心跳的話連線會在 60 秒後被砍**，
而瀏覽器會自動重連，變成每分鐘一次的重連風暴（05 章 5.11.4 那個事故）。

**間隔選 30s 而不是 10s**：這個功能對「多快發現對方離線」不敏感
（不像聊天需要「正在輸入中」的即時性），可以省下三分之二的心跳流量。

</details>

---

## 8.16 驗收清單

**協定**

- [ ] 我知道握手是一個 HTTP GET，而 **`101` 之後那條連線上就沒有 HTTP 了**。
- [ ] 我能說出 8.4.1 那張表：filter、advice、狀態碼、cookie、CORS **全部下線**。
- [ ] 我知道 `Sec-WebSocket-Key` **不是安全機制**，它防的是快取污染。
- [ ] 我知道 masking **不是加密**，key 就明文寫在 frame 標頭裡。
- [ ] 我能說出 close code 的四個區段，以及 **`4000`～`4999` 是我自己的**。
- [ ] **我知道 `1006` 永遠不會在網路上傳輸**，看到它代表沒有完成關閉握手。

**選型**

- [ ] 我知道「要不要雙向」**不是判準**，真正的判準是上行頻率 / 延遲來源 / 要不要對特定連線回話。
- [ ] 我知道三個判準都不成立時，**SSE 幾乎總是更好的選擇**。
- [ ] 我知道 HTTP/2 的 HPACK 讓「WebSocket 省頻寬」這個理由弱化了很多。
- [ ] 我能說出原生 API 寫到第三個功能時會自己長出哪六個 STOMP 的東西。

**STOMP**

- [ ] 我知道四個前綴分別由誰處理，以及**它們的意義完全由設定決定**。
- [ ] 我知道 `/topic` 與 `/queue` 對 simple broker **沒有行為差異**。
- [ ] **我知道 `/user/**` 是被改寫成帶 session id 的 destination**，以及它的三個後果。
- [ ] 我知道 `convertAndSendToUser()` 的第一個參數**必須等於 `Principal.getName()`**。
- [ ] **我知道它找不到人時是 no-op —— 沒有例外、沒有日誌。**
- [ ] 我知道訊息層的例外要用 `@MessageExceptionHandler`，03 章那套不適用。
- [ ] **我知道送出 `ERROR` frame 之後連線必須關閉**，所以驗證錯誤不能用它回報。

**安全** ★

- [ ] 我知道瀏覽器的 `new WebSocket()` **不能帶 header**，而伺服器端的客戶端可以。
- [ ] 我知道 token 放 URL query string 會進 **access log、瀏覽器歷史、`Referer`、APM**。
- [ ] 我知道 STOMP `CONNECT` frame 的 header 是最乾淨的做法。
- [ ] **我知道 WebSocket 不受同源政策保護，而瀏覽器會自動帶 cookie（CSWSH）。**
- [ ] **我知道 `setAllowedOrigins("*")` 是一個資安漏洞**，並且把檢查寫進啟動流程。
- [ ] 我知道 `SUBSCRIBE` **不會經過 `@MessageMapping`**，所以 `@PreAuthorize` 擋不住它。
- [ ] 我知道 destination 的檢查要用**白名單**而不是黑名單。
- [ ] 我知道「只在 CONNECT 驗一次」**必須配一個 token 過期的 reaper**。
- [ ] 我知道「只握手不 CONNECT」的連線也會佔 connection slot，需要 `connect-timeout`。

**連線管理**

- [ ] **我知道 `WebSocketSession` 不是執行緒安全的**，以及分片交錯會造成什麼。
- [ ] 我知道這個 bug **在本機測不出來**。
- [ ] 我知道 `sendBufferSizeLimit` 防的是 **slow consumer**，不是省記憶體。
- [ ] 我能說出三層心跳各自偵測什麼，以及 **TCP keepalive 要 2 小時 11 分**。
- [ ] 我知道 **Ping/Pong 由 I/O 層自動回應，應用程式卡死時照樣回**。
- [ ] 我知道 **`setHeartbeatValue` 沒有 `setTaskScheduler()` 會被安靜忽略**。
- [ ] 我知道心跳是**雙方協商**的，要看 `CONNECTED` frame 才算驗證過。
- [ ] 我知道心跳間隔要 **< 最短中間層 idle timeout 的一半**。
- [ ] 我知道重連要**依 close code 分流**，而且退避**必須有 jitter**。
- [ ] 我知道一條連線佔 connection slot 與 fd，但**不佔工作執行緒**。

**多實例** ★★

- [ ] **我知道 `SimpUserRegistry` 與 simple broker 的訂閱表都只在本機記憶體裡。**
- [ ] 我知道 3 個 pod = 1/3 的送達率，而且**完全不報錯**。
- [ ] **我知道 sticky session 解決不了這個問題**（聊天是兩個人的事）。
- [ ] 我能說出 Redis pub/sub 與外部 broker 各自的適用情境。
- [ ] 我知道 Redis pub/sub **不保證送達的三個時機**。
- [ ] **我知道那可以接受的唯一前提是「快照 + 增量」架構。**
- [ ] 我知道「所有推播都要經過 broadcaster」這條規則**漏一處就退化成 1/3 送達**。

**部署與測試**

- [ ] 我知道 `Upgrade` 是 **hop-by-hop header**，代理必須明確轉發。
- [ ] 我知道要 `proxy_http_version 1.1`（預設 1.0 不支援 Upgrade）。
- [ ] 我知道 **`Origin` 必須原樣轉發**，否則 8.8.6 的白名單等於失效。
- [ ] 我有一個**經過所有代理**的驗證腳本，而且它會測「evil origin 有沒有被擋」。
- [ ] 我知道關機要**先下線、再分批關、送 `1001` 而不是讓它變成 `1006`**。
- [ ] 我知道 `terminationGracePeriodSeconds` 必須大於 `timeout-per-shutdown-phase`。
- [ ] **我知道大部分的 WebSocket 邏輯不需要真的開連線就能測。**
- [ ] 我知道 `subscribe()` 回傳時訂閱還沒註冊完成，要用 **`receipt`** 而不是 `sleep`。
- [ ] 我有一個**針對 CSWSH 的迴歸測試**（evil origin 的握手必須失敗）。

---

## 8.17 下一章預告

這一章是 04-controller 的最後一章，也是整個 Web 層的收尾。

**回頭看這一站的八章**，它們其實在回答同一個問題的八個切面：

| 章 | 「請求進來之後發生什麼」的哪一段 |
|---|---|
| 00 | 這段程式碼該放哪一層 |
| 01 | HTTP 的字串怎麼變成 Java 物件 |
| 02 | 壞資料怎麼在進 Service 之前被擋下 |
| 03 ★ | 出錯時回什麼 |
| 04 | 橫切的需求掛在哪 |
| 05 | 「不是 JSON」與「大到放不下」的東西 |
| 06 | JSON 跨越邊界時的所有問題 |
| 07 ★ | 你怎麼知道前面六章是對的 |
| **08** | **當「請求」變成「連線」時，上面七章還剩下什麼** |

**而 08 章的答案是「剩下很少」**——這是它存在的真正價值：
它讓你看見前面七章的每一個機制**依賴的前提是什麼**。
`@ControllerAdvice` 依賴 `HandlerExceptionResolver`、
Security 依賴 filter chain、CORS 依賴瀏覽器的同源政策——
這些前提在平常是隱形的，只有在它們消失時你才會發現它們存在過。

---

**接下來是 [05-service/](../05-service/)**，而這一章留了三個尾巴在那裡：

| 這一章的東西 | 在 05-service 怎麼接 |
|---|---|
| `ChatService`（8.12.1 只列了名字） | 05-service 00～02：交易邊界、不變量該放哪 |
| 8.10.4「訊息的可靠來源是資料庫」 | 05-service 06 的 `AFTER_COMMIT`：**推播必須在交易提交之後**，否則會推出一則資料庫裡不存在的訊息 |
| 8.10.2 解法③ 的外部 broker | [11-messaging/](../11-messaging/)：Outbox 與冪等消費 |

**還有兩個跨站的延伸**：

| 主題 | 去哪裡 |
|---|---|
| 8.8 的 JWT 驗證、filter chain、方法層權限的完整版 | [09-spring-security/](../09-spring-security/) |
| 8.10.3 的 Redis pub/sub、以及它為什麼是射後不理 | [10-redis/](../10-redis/) |

⚠️ **最後一句提醒**：這一章講了很多 WebSocket 的細節，
但 8.3 的結論仍然成立——**shop-service 只有一個功能用它**。
你從這一章該帶走的不是「我學會 WebSocket 了，來把所有即時功能都改成它」，
而是「我知道它的成本在哪裡，所以我知道什麼時候**不要**用它」。

---

完成後請前往 [../05-service/](../05-service/)。
