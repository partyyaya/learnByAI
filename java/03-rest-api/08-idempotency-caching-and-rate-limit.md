# 第 08 章：冪等、快取與限流

> 前面七章反覆提到三個 header：`Idempotency-Key`、`ETag`、`Retry-After`。
> 這一章把它們收攏成完整的實作。
>
> 這三個機制的共同點是：**它們都在處理「同一個請求被送了多次」這件事**。
> 冪等鍵處理「重複的寫入」，快取處理「重複的讀取」，限流處理「太多的請求」。
> 而它們有一個共同的性質：**做對了沒人會注意到，做錯了會出大事**
> —— 重複扣款、個資外洩、自己的前端被自己擋掉。

---

## 8.1 學習目標

完成本章後，你應該可以：

- 完整實作冪等鍵：儲存設計、狀態機、併發處理、請求指紋比對、回放語意。
- 說出「冪等鍵的三個競態條件」，並用 Redis 的原子操作解決。
- 精確使用 `Cache-Control` 的每一個指令，並說出 `no-cache` 和 `no-store` 的差別。
- 設計 `ETag` 的產生策略，並知道 `ShallowEtagHeaderFilter` 的真實成本。
- 列出 `Vary` 的完整清單，並解釋「快取污染導致個資外洩」的完整機制。
- 比較五種限流演算法，並實作 Redis + Lua 的原子令牌桶。
- 設計多維度、多桶的限流策略，並說出「按操作成本分級」為什麼有效。
- 說明 `RateLimit` header 的標準狀態，並設計正確的 `429` 回應。
- 處理三者的交互作用：重試被限流、快取與授權、冪等鍵與快取。
- 完成 shop-service 的冪等、快取、限流完整規格。

---

## 8.2 冪等鍵完整實作

### 8.2.1 為什麼需要（複習 + 深化）

第 02 章 2.2.4 的時間軸：`POST /orders` 成功但回應丟失 → App 自動重試 → 重複下單 + 重複扣款。

**這一節要處理的是「實作它時會遇到的所有細節」，而那些細節比概念難得多。**

**先明確定義我們要的語意**：

```
相同的 Idempotency-Key + 相同的請求內容
  → 只執行一次
  → 後續的請求回傳「首次執行的結果」（包含當時的狀態碼、body、Location）

相同的 Idempotency-Key + 不同的請求內容
  → 拒絕（409），因為客戶端顯然搞錯了

不同的 Idempotency-Key
  → 各自獨立執行
```

### 8.2.2 契約設計

```http
POST /v1/orders
Idempotency-Key: 8f14e45f-ea36-4a1b-9c2e-77e8f1a3b0c1
Content-Type: application/json

{ "items": [...], "shippingAddressId": "addr_1" }
```

| 項目 | 決定 | 理由 |
|---|---|---|
| Header 名稱 | `Idempotency-Key` | Stripe 的事實標準；IETF draft 也用這個名字 |
| 格式 | 建議 UUIDv4；接受 16～128 字元的 `[A-Za-z0-9_-]` | 不強制 UUID（有些客戶端用自己的 ID 格式） |
| 誰產生 | **客戶端** | 只有客戶端知道「這是重試還是新請求」 |
| 有效期 | **24 小時** | 夠長（涵蓋所有合理的重試）；夠短（不會無限累積） |
| 作用範圍 | **每個 API key / 使用者 + 端點** | 避免不同使用者的 key 互相干擾 |
| 必填？ | **關鍵操作必填**（沒帶回 `400`） | 見下 |
| 重播的狀態碼 | **`200`** + `Idempotent-Replay: true` | 見 8.2.7 |

**「必填」的清單**（第 02 章 2.2.4 的完整版）：

| 端點 | 必填？ | 理由 |
|---|---|---|
| `POST /orders` | ✅ 必填 | 重複 = 多一張訂單 |
| `POST /orders/{id}/payments` | ✅ 必填 | 🔴 重複 = 多扣一次錢 |
| `POST /payments/{id}/refunds` | ✅ 必填 | 🔴 重複 = 多退一次錢 |
| `POST /orders/{id}/cancellations` | ✅ 必填 | 重複 = 可能多退款 |
| `POST /orders/{id}/shipments` | ✅ 必填 | 重複 = 多一張物流單 + 多付運費 |
| `POST /products/{id}/inventory-adjustments` | ✅ 必填 | 重複 = 庫存多扣 |
| `POST /order-exports` | ⚠️ 選填 | 重複 = 浪費資源但無業務傷害 |
| `POST /orders/{id}/notifications` | ❌ 不需要 | 「再寄一次」本來就是預期行為 |
| `POST /carts/current/items` | ❌ 不需要 | 金額低、可修正；且同商品累加是可接受的 |
| `POST /products/{id}/reviews` | ❌ 不需要 | 業務規則已擋（一人一則） |
| `PUT` / `DELETE` | ❌ 不需要 | 天生冪等 |
| `PATCH`（絕對值） | ❌ 不需要 | 已設計成冪等（第 02 章 2.5.5） |

**沒帶必填冪等鍵的回應**：

```jsonc
{
  "type": "https://api.shop.example/problems/idempotency-key-required",
  "title": "缺少冪等鍵",
  "status": 400,
  "detail": "This endpoint requires an Idempotency-Key header to make retries safe.",
  "code": "IDEMPOTENCY_KEY_REQUIRED",
  "userMessage": "系統錯誤，請聯絡客服。",
  "hint": "請產生一個 UUID v4 作為 Idempotency-Key。重試時使用相同的 key；修改請求內容後請產生新的 key。",
  "retryable": false,
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**⚠️ 注意 `userMessage` 是「系統錯誤」而不是「請帶冪等鍵」** ——
因為這是客戶端的程式問題，終端使用者看不懂「冪等鍵」。
技術細節放 `detail` 和 `hint`（第 04 章 4.7）。

### 8.2.3 儲存設計

**需要儲存什麼**：

```java
public record IdempotencyRecord(
    String key,                  // Idempotency-Key
    String scope,                // "{consumerId}:{method}:{pathTemplate}"
    String requestFingerprint,   // ★ 請求內容的雜湊（見 8.2.5）
    Status status,               // IN_PROGRESS / COMPLETED
    Integer responseStatus,      // 首次的 HTTP 狀態碼
    String responseHeaders,      // 首次的關鍵 header（Location、ETag）JSON
    String responseBody,         // 首次的回應 body
    String traceId,              // 首次執行的 traceId（除錯用）
    Instant createdAt,
    Instant completedAt,
    Instant expiresAt
) {
    public enum Status { IN_PROGRESS, COMPLETED }
}
```

**兩種儲存的取捨**：

| | Redis | MySQL |
|---|---|---|
| 原子操作 | ★ `SET NX` / Lua | `INSERT ... ON DUPLICATE KEY` |
| TTL | ★ 原生（`EX`） | 要排程清理 |
| 效能 | ★ 極快 | 慢（每次寫入多一次 DB round trip） |
| **持久性** | ⚠️ 可能丟失（RDB/AOF 有窗口） | ★ 可靠 |
| **與業務交易的一致性** | 🔴 **無法同交易** | ★ **可以同交易** |
| 適合 | 大多數情況 | 金流等絕對不能出錯的操作 |

**「與業務交易的一致性」是關鍵的取捨點**：

```
Redis 版本的風險：
T1  Redis 記錄 key = IN_PROGRESS
T2  執行業務邏輯（DB 交易提交，訂單建立成功）
T3  💥 應用程式在更新 Redis 為 COMPLETED 之前 crash
T4  客戶端重試 → Redis 上的記錄還是 IN_PROGRESS
    → 回 409「處理中，請稍後查詢」
    → 但實際上已經成功了
    → ⚠️ 客戶端困惑，但至少沒有重複執行 ✅

MySQL 版本（同交易）：
T1  同一個交易內：INSERT idempotency_record(status=COMPLETED) + 建立訂單
T2  一起提交或一起 rollback
    → ✅ 絕對一致
```

**shop-service 的決定**：

| 端點 | 儲存 |
|---|---|
| `POST /orders/{id}/payments`、`POST /payments/{id}/refunds` | **MySQL**（與業務同交易） |
| 其他 | **Redis**（效能優先，並接受 T3 的邊界情況） |

**MySQL 的 schema**：

```sql
CREATE TABLE idempotency_records (
    id                   BIGINT       NOT NULL AUTO_INCREMENT,
    idem_key             VARCHAR(128) NOT NULL,
    scope                VARCHAR(255) NOT NULL,
    request_fingerprint  CHAR(64)     NOT NULL COMMENT 'SHA-256 hex',
    status               VARCHAR(16)  NOT NULL COMMENT 'IN_PROGRESS / COMPLETED',
    response_status      SMALLINT     NULL,
    response_headers     JSON         NULL,
    response_body        MEDIUMTEXT   NULL,
    trace_id             VARCHAR(64)  NULL,
    created_at           DATETIME(3)  NOT NULL,
    completed_at         DATETIME(3)  NULL,
    expires_at           DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_idem (scope, idem_key),        -- ★ 唯一約束是原子性的基礎
    KEY idx_expires (expires_at)                  -- 清理用
) ENGINE=InnoDB;
```

**`UNIQUE KEY (scope, idem_key)` 是整個機制的核心** ——
它讓「同一個 key 只能有一筆記錄」由**資料庫保證**，而不是靠應用程式的 if。

**清理排程**：

```java
@Scheduled(cron = "0 15 * * * *")     // 每小時
void purgeExpired() {
    int total = 0;
    while (true) {
        int deleted = jdbc.update(
                "DELETE FROM idempotency_records WHERE expires_at < ? LIMIT 5000",
                Instant.now());
        total += deleted;
        if (deleted < 5000) break;
        sleep(50);                     // ★ 分批 + 讓其他查詢有機會
    }
    log.info("清理過期冪等記錄 count={}", total);
}
```

**⚠️ 不要一次 `DELETE` 全部** —— 24 小時累積可能有幾十萬筆，
一次刪會長交易 + 大量 undo log + 鎖競爭（第 06 章 6.10.3 的同一個原則）。

### 8.2.4 狀態機與三個競態條件

```
（不存在）
    │  客戶端首次請求
    ▼
IN_PROGRESS ──────► COMPLETED
    │                   │
    │ 執行失敗           │ 24 小時後
    ▼                   ▼
（刪除，允許重試）    （清理）
```

**競態條件 1：兩個請求同時抵達（同一個 key）**

```
T1  請求 A：查詢 key → 不存在
T2  請求 B：查詢 key → 不存在      ← 🔴 兩者都以為自己是第一個
T3  請求 A：建立訂單
T4  請求 B：建立訂單               ← 重複執行！
```

**解法：用「原子的插入」而不是「查詢後插入」。**

```java
// ❌ 有競態
if (repo.findByKey(key).isEmpty()) {
    repo.insert(new IdempotencyRecord(key, IN_PROGRESS, ...));
    execute();
}

// ✅ 原子插入（靠 UNIQUE 約束）
try {
    repo.insertInProgress(scope, key, fingerprint);     // INSERT，撞 UNIQUE 就拋例外
} catch (DuplicateKeyException e) {
    return handleExisting(scope, key, fingerprint);      // 已經有人在做了
}
execute();
```

**Redis 版本**：

```java
// SET key value NX EX 86400  → 只在不存在時設定，原子操作
Boolean acquired = redis.opsForValue()
        .setIfAbsent(redisKey, inProgressPayload, Duration.ofHours(24));
if (!Boolean.TRUE.equals(acquired)) {
    return handleExisting(...);
}
```

**競態條件 2：第一個還在執行中，第二個來了**

```
T1  請求 A：插入 IN_PROGRESS，開始執行（要 3 秒）
T2  請求 B：插入失敗（已存在），讀到 IN_PROGRESS
    → 該回什麼？
```

**三種選擇**：

| 選擇 | 回應 | 評價 |
|---|---|---|
| **A. 回 `409`「處理中」** | `409` + `code: IDEMPOTENT_REQUEST_IN_PROGRESS` + `Retry-After: 1` | ★ **推薦**（Stripe 的做法） |
| **B. 等待第一個完成** | 輪詢或用 Redis pub/sub 等待，然後回相同結果 | ⚠️ 佔住執行緒；可能超時 |
| **C. 直接執行**（忽略） | — | 🔴 完全失去冪等保護 |

**shop-service 選 A**：

```jsonc
{
  "type": "https://api.shop.example/problems/idempotent-request-in-progress",
  "title": "相同的請求正在處理中",
  "status": 409,
  "detail": "A request with this Idempotency-Key is currently being processed.",
  "code": "IDEMPOTENT_REQUEST_IN_PROGRESS",
  "userMessage": "您的請求正在處理中，請稍候。",
  "retryable": true,
  "retryStrategy": "BACKOFF_AND_RETRY",
  "retryAfterSeconds": 1,
  "originalTraceId": "4f2c8a1e9b7d3f60",
  "traceId": "9a3f1c7e2b8d4506"
}
```

```http
HTTP/1.1 409 Conflict
Retry-After: 1
```

**`originalTraceId` 是很實用的細節**：
它讓你能查到「第一個請求現在在做什麼」（是不是卡住了）。

**⚠️ `IN_PROGRESS` 必須有較短的 TTL 或超時清理**：

```
如果應用程式在執行中 crash，記錄會永遠停在 IN_PROGRESS
→ 客戶端永遠拿到 409
→ 這筆訂單永遠無法建立
```

**解法：`IN_PROGRESS` 的記錄視為「有效期 60 秒」**：

```java
private Response handleExisting(String scope, String key, String fingerprint) {
    IdempotencyRecord rec = repo.findByScopeAndKey(scope, key).orElseThrow();

    if (rec.status() == IN_PROGRESS) {
        // ★ 超過 60 秒仍在 IN_PROGRESS → 視為前一個執行失敗，允許接手
        if (rec.createdAt().isBefore(Instant.now().minusSeconds(60))) {
            boolean claimed = repo.reclaimStale(scope, key, rec.createdAt());  // CAS
            if (claimed) {
                log.warn("接手逾時的冪等記錄 key={} originalTraceId={}", key, rec.traceId());
                return null;                      // null = 繼續執行
            }
        }
        throw new IdempotentRequestInProgressException(rec.traceId());
    }
    // COMPLETED → 見 8.2.5 的指紋比對與 8.2.7 的回放
    ...
}
```

```sql
-- reclaimStale 的 CAS（比較並交換）
UPDATE idempotency_records
SET created_at = ?, trace_id = ?
WHERE scope = ? AND idem_key = ?
  AND status = 'IN_PROGRESS'
  AND created_at = ?          -- ★ 只有「還是我讀到的那個舊值」才更新
```

**`AND created_at = ?` 是關鍵** —— 它防止兩個請求同時「接手」。

**競態條件 3：業務執行成功但記錄更新失敗**

```
T1  記錄 IN_PROGRESS
T2  建立訂單成功（DB 交易提交）
T3  💥 更新記錄為 COMPLETED 時 crash
```

| 儲存方式 | 後果 |
|---|---|
| MySQL（同交易） | ✅ 不可能發生（記錄和訂單一起提交） |
| Redis | ⚠️ 記錄停在 IN_PROGRESS → 60 秒後被「接手」→ **可能重複建立訂單** 🔴 |

**Redis 版本的補救：業務層的二次防護**

```java
// 建立訂單時，把 Idempotency-Key 也存進訂單表
CREATE TABLE orders (
    ...,
    idempotency_key VARCHAR(128) NULL,
    UNIQUE KEY uk_orders_idem (customer_id, idempotency_key)   -- ★ 業務層的唯一約束
);
```

**這樣即使冪等記錄丟失，資料庫的唯一約束仍然會擋住重複建立。**

```java
try {
    order = orderRepo.save(newOrder);          // 帶著 idempotencyKey
} catch (DuplicateKeyException e) {
    // ★ 冪等記錄丟了，但訂單已存在 → 找回來回傳
    order = orderRepo.findByCustomerIdAndIdempotencyKey(customerId, key).orElseThrow();
    log.warn("冪等記錄遺失但訂單已存在，從業務層恢復 key={}", key);
}
```

**這是「兩層防護」的設計**（和第 03 章練習 3 的三層防護同一個思路）：

```
第 1 層：冪等記錄（快、通用）
第 2 層：業務表的唯一約束（慢、可靠、只在關鍵表上加）
```

### 8.2.5 請求指紋：偵測「相同 key 不同內容」

```java
static String fingerprint(String method, String path, String body, String consumerId) {
    // ★ 要包含哪些東西，是一個設計決定
    String canonical = String.join("\n",
            method,
            path,                                       // 含路徑參數的實際值
            consumerId,                                 // 不同使用者的 key 不互通
            canonicalizeJson(body));                    // 見下
    return DigestUtils.sha256Hex(canonical);
}
```

**⚠️ `canonicalizeJson` 是最容易出錯的地方**：

```jsonc
// 這兩個是「相同的請求」，但字串不同
{"items":[{"productId":"P-1","quantity":2}],"couponCode":"SUMMER20"}
{"couponCode":"SUMMER20","items":[{"quantity":2,"productId":"P-1"}]}
//  ↑ 欄位順序不同、空白不同
```

**如果直接對原始字串做雜湊，客戶端只要序列化順序不同就會被判定為「不同的請求」→ `409`。**

**這在真實情況會發生**：
- 不同版本的 JSON 函式庫的欄位順序不同。
- Android 的 Gson 和 iOS 的 `JSONEncoder` 的順序不同。
- 客戶端重試時重新序列化一次（`Map` 的迭代順序可能不同）。

**正規化的做法**：

```java
static String canonicalizeJson(String raw) {
    if (raw == null || raw.isBlank()) return "";
    try {
        JsonNode node = MAPPER.readTree(raw);
        return MAPPER.writer()                        // ★ 遞迴排序所有物件的 key
                     .with(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
                     .writeValueAsString(sortKeys(node));
    } catch (JsonProcessingException e) {
        return DigestUtils.sha256Hex(raw);            // 不是合法 JSON → 用原始字串
    }
}

private static JsonNode sortKeys(JsonNode node) {
    if (node.isObject()) {
        ObjectNode sorted = MAPPER.createObjectNode();
        node.properties().stream()
            .sorted(Map.Entry.comparingByKey())
            .forEach(e -> sorted.set(e.getKey(), sortKeys(e.getValue())));
        return sorted;
    }
    if (node.isArray()) {
        ArrayNode arr = MAPPER.createArrayNode();
        node.forEach(child -> arr.add(sortKeys(child)));
        return arr;                                    // ⚠️ 陣列順序「不」排序（見下）
    }
    return node;
}
```

**⚠️ 陣列順序要不要正規化？**

```jsonc
// 這兩個是「相同的請求」嗎？
{"items":[{"productId":"P-1"},{"productId":"P-2"}]}
{"items":[{"productId":"P-2"},{"productId":"P-1"}]}
```

| 選擇 | 說明 |
|---|---|
| **不排序（視為不同）** | ★ **推薦**。陣列順序可能有語意（優先序、顯示順序） |
| 排序（視為相同） | ⚠️ 可能誤判；而且「怎麼排序」需要定義（用哪個欄位？） |

**shop-service 的決定：物件的 key 排序，陣列的順序保留。**
並在文件裡說明：

```markdown
## 請求指紋的計算

我們用 `SHA-256(method + path + consumerId + canonicalJson(body))` 判斷
「相同的 key 是否搭配相同的請求」。

正規化規則：
- ✅ 物件的欄位順序**不影響**指紋（我們會排序）
- ✅ 空白與縮排**不影響**指紋
- ⚠️ **陣列的元素順序會影響指紋**（因為順序可能有語意）
- ⚠️ 數值的表示方式會影響指紋（`1.0` ≠ `1`）→ 請保持一致的序列化
```

**最後一項的坑**：

```jsonc
{"quantity": 2}      → 指紋 A
{"quantity": 2.0}    → 指紋 B    ← 不同！
```

Jackson 的 `readTree` 會把 `2` 讀成 `IntNode`，`2.0` 讀成 `DoubleNode` —— 序列化回去不同。

**如果這在實務上造成問題**，可以在正規化時把數值標準化：

```java
if (node.isNumber()) {
    // 整數值統一用整數表示（2.0 → 2）
    if (node.canConvertToExactIntegral()) {
        return MAPPER.getNodeFactory().numberNode(node.bigIntegerValue());
    }
    return MAPPER.getNodeFactory().numberNode(node.decimalValue().stripTrailingZeros());
}
```

**指紋不符的回應**：

```jsonc
{
  "type": "https://api.shop.example/problems/idempotency-key-reused",
  "title": "冪等鍵已用於不同的請求",
  "status": 409,
  "detail": "The Idempotency-Key '8f14e45f...' was previously used with a different request body.",
  "code": "IDEMPOTENCY_KEY_REUSED",
  "userMessage": "請求內容已變更，請重新送出。",
  "hint": "修改請求內容後請產生新的 Idempotency-Key（例如 crypto.randomUUID()）。",
  "originalRequestAt": "2026-08-19T06:12:44Z",
  "originalTraceId": "4f2c8a1e9b7d3f60",
  "retryable": false,
  "traceId": "9a3f1c7e2b8d4506"
}
```

**⚠️ 絕對不要回傳「原始請求的內容」** —— 那可能包含敏感資料，
而且送這個請求的人可能和原始的不是同一個（雖然 scope 有包含 consumerId）。

### 8.2.6 完整實作（Interceptor + Redis）

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 100)      // ★ 在 TraceIdFilter 之後
public class IdempotencyFilter extends OncePerRequestFilter {

    private static final String HEADER = "Idempotency-Key";
    private static final Pattern KEY_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{16,128}$");
    private static final Duration TTL = Duration.ofHours(24);
    private static final Duration IN_PROGRESS_TIMEOUT = Duration.ofSeconds(60);

    private final IdempotencyStore store;
    private final IdempotencyPolicy policy;       // 哪些端點必填
    private final ObjectMapper mapper;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {

        if (!policy.applies(req)) {                       // GET/PUT/DELETE 等直接放行
            chain.doFilter(req, res);
            return;
        }

        String key = req.getHeader(HEADER);

        if (key == null || key.isBlank()) {
            if (policy.isRequired(req)) {
                writeProblem(res, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
                return;
            }
            chain.doFilter(req, res);                      // 選填且沒帶 → 直接執行
            return;
        }
        if (!KEY_PATTERN.matcher(key).matches()) {
            writeProblem(res, ErrorCode.INVALID_IDEMPOTENCY_KEY);
            return;
        }

        // ★ 必須快取 body（因為要算指紋，而且下游還要讀）
        ContentCachingRequestWrapper wrappedReq = new ContentCachingRequestWrapper(req);
        String body = readBody(wrappedReq);                // 見下方的注意事項
        String scope = policy.scopeOf(req);
        String fingerprint = Fingerprint.of(req.getMethod(), req.getRequestURI(),
                                            currentConsumerId(), body);

        // ── 嘗試取得執行權（原子）────────────────────
        IdempotencyStore.Acquisition acq = store.tryAcquire(scope, key, fingerprint, TTL);

        switch (acq.outcome()) {
            case ACQUIRED -> executeAndRecord(wrappedReq, res, chain, scope, key, fingerprint);
            case COMPLETED -> replay(res, acq.record());
            case IN_PROGRESS -> {
                if (acq.record().createdAt().isBefore(Instant.now().minus(IN_PROGRESS_TIMEOUT))
                        && store.reclaimStale(scope, key, acq.record())) {
                    log.warn("接手逾時的冪等記錄 key={} originalTraceId={}",
                             key, acq.record().traceId());
                    executeAndRecord(wrappedReq, res, chain, scope, key, fingerprint);
                } else {
                    writeProblem(res, ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
                                 Map.of("originalTraceId", acq.record().traceId()),
                                 Map.of("Retry-After", "1"));
                }
            }
            case FINGERPRINT_MISMATCH -> writeProblem(res, ErrorCode.IDEMPOTENCY_KEY_REUSED,
                    Map.of("originalRequestAt", acq.record().createdAt(),
                           "originalTraceId", acq.record().traceId()));
        }
    }

    private void executeAndRecord(ContentCachingRequestWrapper req, HttpServletResponse res,
                                  FilterChain chain, String scope, String key, String fingerprint)
            throws ServletException, IOException {

        ContentCachingResponseWrapper wrappedRes = new ContentCachingResponseWrapper(res);
        boolean shouldRecord = false;
        try {
            chain.doFilter(req, wrappedRes);
            // ★ 只記錄「確定的結果」—— 見下方的討論
            shouldRecord = isDeterministicOutcome(wrappedRes.getStatus());
        } finally {
            if (shouldRecord) {
                store.complete(scope, key,
                        wrappedRes.getStatus(),
                        captureHeaders(wrappedRes),
                        wrappedRes.getContentAsByteArray(),
                        MDC.get("traceId"));
            } else {
                store.release(scope, key);          // ★ 刪除記錄，允許重試
            }
            wrappedRes.copyBodyToResponse();
        }
    }

    /**
     * 哪些結果該被記錄（後續重試會拿到相同回應）？
     *
     * ✅ 2xx        —— 成功，一定要記錄
     * ✅ 4xx        —— 客戶端的錯，重送同樣的請求還是會錯 → 記錄可省下一次執行
     * ❌ 5xx        —— 我們的錯，可能是暫時的 → 不記錄，讓客戶端能重試
     * ❌ 408 / 429  —— 暫時性的 → 不記錄
     */
    private static boolean isDeterministicOutcome(int status) {
        if (status >= 500) return false;
        if (status == 408 || status == 429) return false;
        return true;
    }

    /** 只保留客戶端需要的 header */
    private static Map<String, String> captureHeaders(HttpServletResponse res) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String h : List.of("Location", "ETag", "Content-Type")) {
            String v = res.getHeader(h);
            if (v != null) out.put(h, v);
        }
        return out;
    }
}
```

**`isDeterministicOutcome` 這個判斷很重要，而且容易做錯**：

| 狀態碼 | 記錄？ | 理由 |
|---|---|---|
| `201` / `200` / `202` | ✅ | 成功了，重試必須拿到同一個結果 |
| `400` / `422` | ✅ | 內容錯，重送同樣的內容還是錯 → 記錄可以省下一次驗證 |
| `409`（庫存不足） | ⚠️ **有爭議** | 補貨後重試「應該」成功 —— 但客戶端用的是同一個 key… 見下 |
| `500` | ❌ | 可能是暫時的 bug／DB 閃斷 → 必須讓客戶端能重試 |
| `503` / `504` | ❌ | 暫時性 |
| `429` | ❌ | 限流是暫時的 |

**`409` 的爭議值得展開**：

```
POST /orders（key=K1）→ 409 庫存不足
補貨後，客戶端用 K1 重試 → ?
  選項 A：回放 409          → 客戶端永遠買不到（要換 key）
  選項 B：重新執行           → 但這違反「相同 key 只執行一次」的承諾
```

**shop-service 的決定：記錄 `409`（選項 A），並在錯誤訊息中明示**：

```jsonc
{
  "code": "INSUFFICIENT_STOCK",
  "userMessage": "「無線降噪耳機 Pro」僅剩 3 件，請調整數量後再結帳。",
  "retryable": false,
  "retryStrategy": "MODIFY_REQUEST",
  "hint": "修改數量後請使用新的 Idempotency-Key。",
  ...
}
```

**理由**：`retryStrategy: MODIFY_REQUEST` 已經告訴客戶端「要改內容」——
而改了內容就必須換 key（否則會撞到 `IDEMPOTENCY_KEY_REUSED`）。**語意是一致的。**

**⚠️ `ContentCachingRequestWrapper` 的三個坑**：

| 坑 | 說明 | 解法 |
|---|---|---|
| `getContentAsByteArray()` 在 `doFilter` **之前**是空的 | 它只快取「已經被讀過」的內容 | 在算指紋前先主動讀完 `getInputStream()` |
| 大 body 會全部進記憶體 | 上傳 10MB 檔案 → 佔 10MB | 對 `multipart` 端點跳過冪等檢查，或限制 body 大小 |
| 讀了 body 之後下游可能讀不到 | 需要 wrapper 正確實作 `getInputStream()` | `ContentCachingRequestWrapper` 已處理；但要確保傳給 `chain.doFilter` 的是 wrapper |

```java
private static String readBody(ContentCachingRequestWrapper req) throws IOException {
    // ★ 主動讀完，讓 wrapper 快取住
    try (InputStream in = req.getInputStream()) {
        byte[] bytes = in.readAllBytes();
        if (bytes.length > MAX_FINGERPRINT_BODY) {
            // 太大就只用雜湊（避免記憶體壓力）
            return DigestUtils.sha256Hex(bytes);
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
```

**Redis 的原子取得（Lua）**：

```lua
-- idempotency-acquire.lua
-- KEYS[1] = idempotency key
-- ARGV[1] = fingerprint, ARGV[2] = traceId, ARGV[3] = ttl 秒, ARGV[4] = now(ms)
local existing = redis.call('GET', KEYS[1])
if not existing then
    local rec = cjson.encode({
        status = 'IN_PROGRESS', fp = ARGV[1], traceId = ARGV[2], createdAt = tonumber(ARGV[4])
    })
    redis.call('SET', KEYS[1], rec, 'EX', tonumber(ARGV[3]))
    return cjson.encode({ outcome = 'ACQUIRED' })
end

local rec = cjson.decode(existing)
if rec.fp ~= ARGV[1] then
    return cjson.encode({ outcome = 'FINGERPRINT_MISMATCH', record = rec })
end
if rec.status == 'IN_PROGRESS' then
    return cjson.encode({ outcome = 'IN_PROGRESS', record = rec })
end
return cjson.encode({ outcome = 'COMPLETED', record = rec })
```

**用 Lua 的理由**：`GET` + 判斷 + `SET` 三個操作必須是**原子的**。
分開做就有 8.2.4 競態條件 1 的問題。

### 8.2.7 回放的語意

```http
# 首次
POST /v1/orders
Idempotency-Key: 8f14e45f-...

→ 201 Created
  Location: /v1/orders/ord_01J5GK...
  ETag: "v1"
  { "orderId": "ord_01J5GK...", ... }

# 重試（相同 key + 相同內容）
POST /v1/orders
Idempotency-Key: 8f14e45f-...

→ 200 OK                                    ← ★ 不是 201
  Idempotent-Replay: true                    ← ★ 明確標示
  Location: /v1/orders/ord_01J5GK...
  ETag: "v1"
  { "orderId": "ord_01J5GK...", ... }        ← 和首次完全相同的 body
```

**為什麼回 `200` 而不是原始的 `201`？**

| 選擇 | 說明 |
|---|---|
| **回 `200`** | ★ 語意正確：這次請求「沒有建立」任何東西。而且客戶端可以區分「真的建立了」和「重播」 |
| 回原始的 `201` | ⚠️ Stripe 的做法（完全透明）。優點是客戶端不用處理兩種狀態碼 |

**兩種都合理，關鍵是「文件要寫清楚並保持一致」。**

**shop-service 選 `200` + `Idempotent-Replay: true`**，理由：

```typescript
// 客戶端可以避免重複播放「訂單建立成功」的動畫／通知
const res = await createOrder(cart);
if (res.status === 201) {
  showSuccessAnimation();          // 只有真的建立時才播
  trackEvent('order_created');     // ★ 避免重複計數
}
router.push(`/orders/${res.data.orderId}`);
```

**`trackEvent` 那一行是實際的價值** ——
如果回放也回 `201`，你的「訂單建立」事件會被重複計數，
分析數據會膨脹（而且只在網路不穩的使用者身上膨脹 → 數據偏差）。

**⚠️ 別忘了 CORS**：

```
Access-Control-Expose-Headers: Location, ETag, Idempotent-Replay
```

沒有這個，前端讀不到 `Idempotent-Replay`（第 02 章 2.7.2）。

### 8.2.8 客戶端該怎麼產生與管理 key

**寫進文件（這決定了機制有沒有用）**：

```markdown
## 冪等鍵的產生與管理

### 產生
```javascript
const idempotencyKey = crypto.randomUUID();
```

### 生命週期規則

| 情況 | 是否換 key |
|---|---|
| 網路超時、連線中斷、收到 5xx → 重試 | ❌ **用同一個 key** |
| 收到 `409 IDEMPOTENT_REQUEST_IN_PROGRESS` → 稍後重試 | ❌ **用同一個 key** |
| 收到 4xx，**修改了請求內容**後重送 | ✅ **產生新 key** |
| 使用者按了「重新送出」按鈕（內容沒變） | ❌ 用同一個 key（這正是冪等鍵要防的） |
| 使用者離開頁面後回來，重新結帳 | ✅ 產生新 key |

### 建議做法：key 綁在「使用者的意圖」上

```typescript
// ✅ 在進入結帳流程時產生，整個流程共用
function startCheckout(cart: Cart) {
  return { ...cart, idempotencyKey: crypto.randomUUID() };
}

// 內容變更時換新的
function updateCartQuantity(session: CheckoutSession, ...) {
  return { ...session, /* 改動 */, idempotencyKey: crypto.randomUUID() };
}
```

### 持久化（重要）

若使用者可能在請求進行中關閉 App／重新整理頁面，
請把 key 存進 `localStorage` / `sessionStorage`，重開後沿用：

```typescript
function getOrCreateCheckoutKey(cartVersion: string): string {
  const stored = sessionStorage.getItem(`checkout-key-${cartVersion}`);
  if (stored) return stored;
  const key = crypto.randomUUID();
  sessionStorage.setItem(`checkout-key-${cartVersion}`, key);
  return key;
}
```

⚠️ **不持久化的話，使用者重新整理後會用新 key → 冪等保護失效 → 可能重複下單。**
```

**最後那個警告是實際會發生的情況**：

```
使用者按「結帳」→ 網路慢 → 使用者不耐煩按 F5 → 重新結帳
→ 如果 key 沒持久化 → 新 key → 兩張訂單
```

**這是冪等鍵最常見的「實作了但沒生效」的原因。**

### 8.2.9 冪等鍵的監控

```java
// 指標（低基數標籤，第 04 章 4.12.5）
Counter.builder("idempotency.requests")
       .tag("outcome", outcome.name())          // ACQUIRED / COMPLETED / IN_PROGRESS / FINGERPRINT_MISMATCH
       .tag("endpoint", normalizedPath)
       .tag("consumer", consumerId)
       .register(registry).increment();
```

**要看的四個指標**：

| 指標 | 正常範圍 | 異常代表什麼 |
|---|---|---|
| `COMPLETED`（回放）的比例 | 0.1% ~ 2% | **暴增** → 客戶端在大量重試 → 可能是你的服務變慢或客戶端有 bug |
| `IN_PROGRESS` 的比例 | < 0.1% | **暴增** → 請求處理太慢，或客戶端重試間隔太短 |
| `FINGERPRINT_MISMATCH` 的比例 | ~0% | **任何非零值都值得查** → 客戶端沒有正確管理 key |
| 「接手逾時記錄」的次數 | 0 | **非零** → 有請求 crash 了，要查為什麼 |

**第三個特別重要**：`FINGERPRINT_MISMATCH` 表示某個 consumer
「用同一個 key 送了不同的內容」—— 這幾乎一定是它的 bug，值得主動聯絡。

---

## 8.3 HTTP 快取完整指南

### 8.3.1 兩種機制：新鮮度與驗證

```
新鮮度（freshness）：「這份資料在 X 秒內都算新的，不用問我」
    → Cache-Control: max-age=300
    → 完全不發請求（零延遲、零頻寬）

驗證（validation）：「你手上那份還有效嗎？」
    → If-None-Match: "a3f5c9e1"  →  304 Not Modified
    → 發請求但不傳 body（省頻寬，不省延遲）
```

**兩者可以（也應該）併用**：

```http
Cache-Control: public, max-age=300
ETag: "a3f5c9e1"
```

```
0 ~ 300 秒：   完全不發請求（用新鮮度）
300 秒後：     發請求 + If-None-Match → 304（用驗證）
資料真的變了： 200 + 新內容 + 新 ETag
```

### 8.3.2 `Cache-Control` 指令完整表

**回應方向（你設定的）**：

| 指令 | 意義 | 何時用 |
|---|---|---|
| `public` | 任何快取（含 CDN、共享代理）都可以存 | 公開資料（商品、分類） |
| `private` | **只有終端使用者的瀏覽器**可以存，CDN 不可以 | 🔴 任何和登入者有關的資料 |
| `no-cache` | ⚠️ **可以存，但每次使用前必須驗證** | 「要最新的，但願意用 `304` 省頻寬」 |
| `no-store` | **完全不可儲存**（記憶體、磁碟都不行） | 極敏感資料（付款頁、token） |
| `max-age=<秒>` | 新鮮期（對所有快取） | 一般設定 |
| `s-maxage=<秒>` | 新鮮期（**只對共享快取**，覆寫 `max-age`） | 「CDN 存 5 分鐘，瀏覽器存 30 秒」 |
| `must-revalidate` | 過期後**必須**驗證，不可用過期資料 | 金額、庫存等不能給舊值的資料 |
| `proxy-revalidate` | 同上，但只對共享快取 | 少用 |
| `no-transform` | 中介不可修改內容（例如壓縮圖片） | 需要位元組精確的內容 |
| `immutable` | 這個 URL 的內容**永不改變** | 帶雜湊的靜態資源（`app.a3f5c9.js`） |
| `stale-while-revalidate=<秒>` | 過期後可先回舊的，同時背景更新 | ★ 提升感知效能 |
| `stale-if-error=<秒>` | 源站掛掉時可用過期資料 | ★ 提升可用性 |

**⚠️ `no-cache` 和 `no-store` 是最常被搞混的一組**：

```
no-cache  = 「可以存，但用之前要問我」   → 會有 304，省頻寬
no-store  = 「不准存」                  → 每次都完整傳輸
```

**很多人寫 `no-cache` 以為是「不要快取」** —— 實際上它允許儲存。
如果你的意圖是「絕對不要留在任何地方」，要用 `no-store`。

**判準**：

| 意圖 | 寫法 |
|---|---|
| 「不要留下任何副本」（付款資訊、token） | `no-store` |
| 「可以留，但一定要拿最新的」（訂單狀態） | `no-cache` + `ETag`（會有 `304`） |
| 「私人資料，CDN 不要碰」 | `private, no-cache` 或 `private, max-age=0` |
| 「公開資料，快取 5 分鐘」 | `public, max-age=300` |

### 8.3.3 `no-store` 的常見誤用

```http
# ❌ 過度保守（浪費）
GET /products?categoryId=cat_1
→ Cache-Control: no-store
```

商品列表是公開資料，每天改幾次 —— `no-store` 讓每個請求都打到你的資料庫。

```http
# ✅
→ Cache-Control: public, max-age=300, stale-while-revalidate=60
   ETag: "..."
   Vary: Accept, Accept-Language
```

```http
# 🔴 危險（個資外洩，第 00 章 0.4.2 約束 3）
GET /me
→ Cache-Control: public, max-age=300
```

**這是真實的事故類型**：CDN 存了 A 使用者的 `/me`，B 使用者拿到 A 的個資。

**shop-service 的保命規則**：

```java
// 全域預設：任何需要認證的端點一律 private
@Component
public class CacheControlAdvice implements ResponseBodyAdvice<Object> {
    @Override
    public Object beforeBodyWrite(Object body, MethodParameter param, ...) {
        HttpHeaders h = res.getHeaders();
        if (h.getCacheControl() != null) return body;      // 端點已明確設定 → 尊重它

        // ★ 沒明確設定的一律保守處理
        boolean authenticated = currentAuthentication() != null
                && !(currentAuthentication() instanceof AnonymousAuthenticationToken);
        h.setCacheControl(authenticated
                ? "private, no-store"
                : "no-store");
        return body;
    }
}
```

**「預設 `no-store`，需要快取的端點明確覆寫」是唯一安全的方向。**
反過來（預設 `public`，敏感端點記得改）遲早會漏。

### 8.3.4 `ETag` 的產生策略

| 來源 | 例子 | 優點 | 缺點 |
|---|---|---|---|
| **版本號**（JPA `@Version`） | `"v7"` | ★ 便宜；同時是資料庫層的樂觀鎖 | 需要欄位；聚合多個實體時要組合 |
| `updatedAt` 時間戳 | `"1755583964123"` | 不用新欄位 | ⚠️ 同一毫秒的兩次更新無法區分 |
| **內容雜湊** | `"a3f5c9e1"` | 最精確（內容一樣就一樣） | 要序列化完才能算 → 佔記憶體 |
| 複合 | `"v7-zh_TW-full"` | 可以納入語言、展開參數 | 較複雜 |

**shop-service 的策略**：

```java
public record ETagSource(long version, String locale, Set<String> expands) {
    public String toETag() {
        // ★ 納入所有影響回應內容的因素
        String raw = version + "|" + locale + "|" + String.join(",", new TreeSet<>(expands));
        return "\"" + DigestUtils.sha256Hex(raw).substring(0, 16) + "\"";
    }
}
```

**⚠️ 為什麼要納入 `locale` 和 `expands`？**

```
GET /orders/ord_1                     Accept-Language: zh-TW  → ETag "v7"
GET /orders/ord_1                     Accept-Language: en     → ETag "v7"   ← 🔴 相同！
GET /orders/ord_1?expand=items        Accept-Language: zh-TW  → ETag "v7"   ← 🔴 相同！

→ 客戶端帶 If-None-Match: "v7" 查英文版 → 304 → 拿到快取的中文版
```

**規則：`ETag` 必須涵蓋「所有會影響回應 body 的因素」。**

**這也解釋了為什麼 `Vary` 是必要的**（8.3.6）——
但 `Vary` 只告訴快取「要按哪些 header 分開存」，
`ETag` 才是「這一份內容的指紋」。**兩者都要對。**

### 8.3.5 條件請求的四個 header

| Header | 搭配 | 用途 | 成功 | 失敗 |
|---|---|---|---|---|
| `If-None-Match` | `ETag` | 快取驗證（**讀**） | 沒變 → `304` | 有變 → `200` + 內容 |
| `If-Modified-Since` | `Last-Modified` | 同上（較弱） | 沒變 → `304` | 有變 → `200` |
| `If-Match` | `ETag` | 樂觀鎖（**寫**） | 相符 → 執行 | 不符 → `412` |
| `If-Unmodified-Since` | `Last-Modified` | 同上（較弱） | 沒變 → 執行 | 有變 → `412` |

**`ETag` vs `Last-Modified` 的取捨**：

| | `ETag` | `Last-Modified` |
|---|---|---|
| 精度 | ★ 任意（可以是內容雜湊） | 秒級（同一秒的兩次更新無法區分） |
| 語意 | 「內容的指紋」 | 「最後修改時間」 |
| 成本 | 要產生（版本號很便宜，雜湊較貴） | 通常已經有 `updatedAt` |
| 用於樂觀鎖 | ★ 可以（`If-Match`） | ⚠️ 秒級精度不夠可靠 |

**建議：`ETag` 為主，`Last-Modified` 可以順手加上**（有些老客戶端只認得它）。

**Spring 的實作**：

```java
@GetMapping("/orders/{orderId}")
public ResponseEntity<OrderDetail> get(@PathVariable String orderId,
                                       Locale locale,
                                       @RequestParam(required = false) Set<String> expand,
                                       WebRequest webRequest) {

    // ★ 先只查「版本」，不查完整資料
    OrderVersion v = repo.findVersionByIdAndCustomerId(orderId, currentCustomerId())
            .orElseThrow(() -> new ResourceNotFoundException("order", orderId));

    String etag = new ETagSource(v.version(), locale.toLanguageTag(),
                                 expand == null ? Set.of() : expand).toETag();

    // ★ 這一行同時處理 If-None-Match 與 If-Modified-Since，
    //    符合就直接回 304 並回傳 true
    if (webRequest.checkNotModified(etag, v.updatedAt().toEpochMilli())) {
        return null;                              // Spring 已寫好 304
    }

    // 只有真的需要時才查完整資料
    OrderDetail detail = service.findDetail(orderId, expand, locale);
    return ResponseEntity.ok()
            .eTag(etag)
            .lastModified(v.updatedAt())
            .cacheControl(CacheControl.noCache().cachePrivate())
            .body(detail);
}
```

**「先查版本，再決定要不要查完整資料」是效能關鍵**：

```
不做這個最佳化：
  查完整訂單（含 items、payments、shipments，4 個查詢）→ 算 ETag → 回 304
  → 省了網路頻寬，但資料庫的工作全做了

做這個最佳化：
  查一個版本號（1 個查詢，走覆蓋索引）→ 算 ETag → 回 304
  → 資料庫也省了
```

**這是 `ETag` 真正省成本的地方 —— 但需要「輕量的版本查詢」。**

```sql
-- 覆蓋索引，只讀索引不回表
CREATE INDEX idx_orders_version ON orders (id, customer_id, version, updated_at);

SELECT version, updated_at FROM orders WHERE id = ? AND customer_id = ?;
```

### 8.3.6 `ShallowEtagHeaderFilter` 的真實成本

Spring 提供一個「自動加 ETag」的 filter：

```java
@Bean
FilterRegistrationBean<ShallowEtagHeaderFilter> shallowEtag() {
    var reg = new FilterRegistrationBean<>(new ShallowEtagHeaderFilter());
    reg.addUrlPatterns("/v1/products/*");
    return reg;
}
```

**它做什麼**：把整個回應 body 緩衝在記憶體 → 算 MD5 → 當作 `ETag` → 若客戶端的相符則回 `304`。

**⚠️ 它的三個成本**：

| 成本 | 說明 |
|---|---|
| **不省後端運算** | 業務邏輯與資料庫查詢**全部執行完**才算 ETag |
| **佔記憶體** | 整個回應 body 要在記憶體裡（100 筆商品的 JSON 可能 500KB） |
| **不能和串流併用** | 需要完整的 body 才能算雜湊 |

**它只省了「網路傳輸」。**

| 情境 | 適合用 `ShallowEtagHeaderFilter`？ |
|---|---|
| 回應很大、後端運算便宜、客戶端頻繁輪詢 | ✅ 值得（省大量頻寬） |
| 回應小、後端運算貴 | ❌ 不值得（用 8.3.5 的版本號做法） |
| 高流量端點 | ⚠️ 記憶體壓力要評估 |

**shop-service 的決定**：

| 端點 | ETag 策略 |
|---|---|
| `GET /orders/{id}`、`GET /orders` | 手動（版本號，8.3.5）—— 因為要省資料庫 |
| `GET /categories`（分類樹，資料小、變動少） | `ShallowEtagHeaderFilter` + `max-age=3600` |
| `GET /order-exports/{id}`（輪詢端點，8.4.6） | 手動（工作狀態的版本號） |

### 8.3.7 `Vary`：快取污染的完整機制

**`Vary` 告訴快取「這個回應的內容取決於哪些請求 header」。**

```http
GET /products?categoryId=cat_1
Accept-Language: zh-TW

→ 200 OK
  Cache-Control: public, max-age=300
  Vary: Accept, Accept-Language
```

**沒有 `Vary` 會發生什麼**：

```
T1  使用者 A（Accept-Language: zh-TW）→ CDN 沒有快取 → 打源站 → 存進 CDN
T2  使用者 B（Accept-Language: en）   → CDN 有快取 → 🔴 拿到中文版
```

**完整的 `Vary` 清單**（第 03 章 3.12.3 的完整版）：

| 你用了什麼 | 必須 `Vary` |
|---|---|
| `Accept`（多格式：JSON / PDF / CSV） | `Accept` |
| `Accept-Language`（i18n：`statusLabel`） | `Accept-Language` |
| `Accept-Encoding`（gzip / br） | `Accept-Encoding`（⚠️ 通常由伺服器自動加） |
| `Authorization`（不同使用者不同資料） | 🔴 **`Authorization`，或直接 `Cache-Control: private`** |
| `Origin`（CORS） | `Origin` |
| `X-Api-Version`（Header 版本，第 06 章 6.5.2） | `X-Api-Version` |
| `X-Client-Id`（依 client 降級，第 03 章練習 4） | `X-Client-Id` |
| `Prefer`（mock 的範例選擇） | `Prefer` |
| 任何影響回應內容的自訂 header | 該 header |

**⚠️ `Vary: Authorization` 是一個陷阱**：

```
它「技術上」正確，但實際上很危險：
  每個 token 都是不同的快取項目 → 快取命中率接近 0
  而且 token 過期換新後又是新的快取項目
  → 快取空間被無用的項目佔滿

而且如果 CDN 的實作有 bug（或設定漏了），就是個資外洩。
```

**規則：需要認證的端點一律 `Cache-Control: private`（不要依賴 `Vary: Authorization`）。**

**`Vary: *` 的意思**：「這個回應不可被共享快取重用」。
等同於 `Cache-Control: private` 但更絕對。少用。

**⚠️ `Vary` 過多的問題**：

```http
Vary: Accept, Accept-Language, Accept-Encoding, Origin, X-Api-Version, X-Client-Id
```

**快取項目數 = 各 header 值的組合數。**

```
Accept: 2 種 × Accept-Language: 3 種 × Accept-Encoding: 3 種
× Origin: 5 種 × X-Api-Version: 2 種 × X-Client-Id: 10 種
= 1800 個快取項目（對同一個 URL！）
→ 命中率大幅下降
```

**降低 `Vary` 基數的三個手法**：

| 手法 | 說明 |
|---|---|
| **正規化 header** | CDN 層把 `Accept-Language: zh-TW,zh;q=0.9,en;q=0.8` 正規化成 `zh-TW` |
| **把變體放進 URL** | `?lang=zh-TW` 而不是 `Accept-Language` → 不需要 `Vary` |
| **移除不必要的 `Vary`** | `X-Client-Id` 只影響少數端點 → 只在那些端點加 |

**shop-service 的決定**：

```
公開端點（/products、/categories）：
  Vary: Accept-Language                    ← 只保留真正影響內容的
  並在 CDN 正規化 Accept-Language 為 zh-TW / en 兩種

需要認證的端點：
  Cache-Control: private, no-store         ← 不快取，所以不需要 Vary
```

### 8.3.8 `stale-while-revalidate` 與 `stale-if-error`

```http
Cache-Control: public, max-age=300, stale-while-revalidate=60, stale-if-error=86400
```

| 指令 | 行為 |
|---|---|
| `max-age=300` | 0～300 秒：直接用快取 |
| `stale-while-revalidate=60` | 300～360 秒：**先回舊的**，同時背景更新 → 使用者感覺零延遲 |
| `stale-if-error=86400` | 源站回 5xx 或無法連線時：**用最多 24 小時內的舊資料** |

**`stale-if-error` 的價值**：它讓你的商品頁在後端掛掉時**還能顯示**（用舊資料）。

```
14:02  後端全掛（第 05 章 5.2.1 的事故）
14:02  CDN 收到請求 → 源站 503 → stale-if-error 生效 → 回 13:58 的快取
       → ✅ 使用者仍能瀏覽商品（雖然庫存數字可能不準）
14:18  後端恢復
```

**⚠️ 適用範圍要小心**：

| 資料 | `stale-if-error` |
|---|---|
| 商品列表、分類樹、文章 | ✅ 可以（舊資料比錯誤頁好） |
| 庫存數量 | ⚠️ 小心（可能顯示「有貨」但實際沒了 → 下單失敗） |
| 價格 | 🔴 **不要**（顯示舊價格會有法律／客訴問題） |
| 訂單狀態、餘額 | 🔴 **不要** |

**shop-service 的決定**：

```
/categories        → stale-if-error=86400   （分類幾乎不變）
/products（列表）  → stale-if-error=300     （5 分鐘內的舊資料可接受）
/products/{id}     → stale-if-error=60      （較短，因為含價格與庫存）
/orders*           → 不快取
```

### 8.3.9 shop-service 的快取矩陣

| 端點 | `Cache-Control` | `ETag` | `Vary` |
|---|---|---|---|
| `GET /categories` | `public, max-age=3600, stale-while-revalidate=600, stale-if-error=86400` | ✅ Shallow | `Accept-Language` |
| `GET /products` | `public, max-age=300, stale-while-revalidate=60, stale-if-error=300` | ✅ Shallow | `Accept-Language` |
| `GET /products/{id}` | `public, max-age=60, stale-while-revalidate=30, stale-if-error=60` | ✅ 版本號 | `Accept-Language` |
| `GET /products?q=` | `public, max-age=60` | ❌ | `Accept-Language` |
| `GET /products/{id}/inventory` | `public, max-age=10` | ❌ | — |
| `GET /orders` | `private, no-store` | ❌ | — |
| `GET /orders/{id}` | `private, no-cache` | ✅ 版本號 | — |
| `GET /orders/{id}/items` | `private, no-cache` | ✅ 版本號 | — |
| `GET /me` | `private, no-store` | ❌ | — |
| `GET /carts/current` | `private, no-store` | ❌ | — |
| `GET /order-exports/{id}`（輪詢） | `private, no-cache` | ✅ 狀態版本 | — |
| `GET /v1/deprecations` | `private, max-age=300` | ✅ | — |
| `GET /openapi.yaml` | `public, max-age=600` | ✅ Shallow | — |
| 所有 4xx / 5xx | `no-store` | ❌ | — |

**注意三件事**：

| 觀察 | 說明 |
|---|---|
| `GET /orders/{id}` 用 `no-cache` 而不是 `no-store` | 「可以存，但每次驗證」→ 有 `304` 省頻寬（訂單詳情的 body 不小） |
| `GET /orders` 用 `no-store` | 列表的 `ETag` 命中率低（任一筆訂單變更就失效）→ 不值得 |
| **錯誤回應一律 `no-store`** | 🔴 否則 `409 庫存不足` 可能被快取，補貨後客戶端還是拿到錯誤 |

**最後一項是很容易漏掉的**：

```java
// 在錯誤處理的統一出口設定（第 04 章 4.10.1）
return ResponseEntity.status(code.status())
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .cacheControl(CacheControl.noStore())          // ★ 一定要
        .body(problem);
```

---

## 8.4 限流

### 8.4.1 為什麼要限流（三個不同的目的）

**很多人以為限流只是「防攻擊」。實際上它有三個不同的目的，而且需要不同的設計。**

| 目的 | 保護誰 | 典型設定 | 超過時該回什麼 |
|---|---|---|---|
| **① 保護系統** | 你自己（避免過載） | 全域的總量上限 | `503`（是**你**撐不住，第 02 章 2.9.6） |
| **② 公平使用** | 其他使用者（避免一個人吃光資源） | 每使用者 / 每 API key 的配額 | `429`（是**他**超量） |
| **③ 商業配額** | 你的營收（分級收費） | 依方案的配額（免費 100/日，付費 10000/日） | `429` + 升級方案的提示 |
| **④ 防濫用** | 業務邏輯（防刷、防爬） | 特定操作的嚴格限制（登入、簡訊） | `429`（並考慮加驗證碼） |

**混用這四個目的是常見的設計錯誤**：

```
❌ 用一組「每分鐘 300 次」處理全部四個目的
   → 過載時回 429（錯，應該 503）
   → 爬蟲和正常使用者用同一個配額（不公平）
   → 登入端點和查詢端點同配額（登入應該嚴格得多）
```

### 8.4.2 五種演算法

#### 演算法 1：固定窗口（Fixed Window）

```
每分鐘 100 次：
  12:00:00 ~ 12:00:59  計數器 A
  12:01:00 ~ 12:01:59  計數器 B（重置）
```

```lua
-- Redis：INCR + EXPIRE
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
```

**優點**：最簡單、記憶體最小（一個計數器）。

**🔴 缺點：邊界爆發（burst at boundary）**

```
12:00:59  發 100 次   ← 用完窗口 A 的配額
12:01:00  發 100 次   ← 窗口 B 重置了
────────────────────────
在 1 秒內發了 200 次 —— 是設定值的 2 倍
```

**這在真實情況會發生**：客戶端的排程如果對齊分鐘（`0 * * * *`），
所有客戶端會在同一秒湧入。

#### 演算法 2：滑動窗口日誌（Sliding Window Log）

```
記錄每一次請求的時間戳，計算「最近 60 秒內有幾次」
```

```lua
-- Redis Sorted Set
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)   -- 移除過期的
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
    return {0, count}                                       -- 拒絕
end
redis.call('ZADD', KEYS[1], now, now .. ':' .. ARGV[4])     -- ARGV[4] = 唯一後綴
redis.call('EXPIRE', KEYS[1], window)
return {1, count + 1}
```

**優點**：**完全精確**，沒有邊界問題。

**🔴 缺點：記憶體**

```
限制 1000 次/分鐘 × 10 萬個使用者
= 每個使用者最多 1000 個時間戳
= 最壞情況 1 億個 sorted set 成員
→ Redis 記憶體爆炸
```

**適合**：低配額的敏感操作（登入每分鐘 5 次 → 每人最多 5 個成員）。

#### 演算法 3：滑動窗口計數（Sliding Window Counter）

**固定窗口的改良：用前一個窗口的計數做加權估算。**

```
限制 100 次/分鐘
12:01:30 時：
  窗口 A（12:00:00-12:00:59）用了 80 次
  窗口 B（12:01:00-12:01:59）用了 30 次
  估算值 = 30 + 80 × (剩餘 50% 的窗口 A 權重) = 30 + 40 = 70
  → 還可以用 30 次
```

**優點**：記憶體小（兩個計數器）、大幅減輕邊界問題。
**缺點**：是**估算值**，可能誤判（假設流量在窗口內均勻分布）。

#### 演算法 4：令牌桶（Token Bucket）★ 最常用

```
桶子容量 = 100（可以爆發 100 次）
補充速率 = 100 / 60 秒（每 0.6 秒補 1 個）

請求來 → 拿一個令牌 → 有就通過，沒有就拒絕
```

**優點**：

| 優點 | 說明 |
|---|---|
| ★ **允許可控的爆發** | 桶滿時可以連續發 100 次 —— 這符合真實的使用模式（使用者開啟 App 時會連續發幾個請求） |
| 記憶體小 | 兩個值（`tokens`、`lastRefillAt`） |
| 參數直觀 | 容量 = 爆發量，速率 = 長期平均 |
| 可以「透支」的變體 | 允許短期超額，之後補回 |

**Redis + Lua 的原子實作**：

```lua
-- token-bucket.lua
-- KEYS[1] = bucket key
-- ARGV[1] = capacity（桶容量）
-- ARGV[2] = refillPerSecond（每秒補充量）
-- ARGV[3] = nowMillis
-- ARGV[4] = requested（本次要幾個令牌，通常 1；貴的操作可以要更多）
-- ARGV[5] = ttlSeconds

local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local lastTs = tonumber(data[2])

if tokens == nil then
    tokens = capacity                                    -- 首次：桶是滿的
    lastTs = now
else
    -- ★ 依經過的時間補充令牌
    local elapsed = math.max(0, now - lastTs) / 1000.0
    tokens = math.min(capacity, tokens + elapsed * refillRate)
    lastTs = now
end

local allowed = 0
local retryAfterMs = 0

if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
else
    -- 還要等多久才有足夠的令牌
    retryAfterMs = math.ceil(((requested - tokens) / refillRate) * 1000)
end

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', lastTs)
redis.call('EXPIRE', KEYS[1], ttl)

-- 回傳：是否允許、剩餘令牌（向下取整）、建議等待毫秒、桶容量
return { allowed, math.floor(tokens), retryAfterMs, capacity }
```

**Java 端**：

```java
@Component
public class TokenBucketRateLimiter {

    private final StringRedisTemplate redis;
    private final RedisScript<List> script;      // 載入上面的 Lua

    public RateLimitResult tryConsume(String bucketKey, RateLimitPolicy policy, int cost) {
        List<Long> r = redis.execute(script,
                List.of("rl:" + bucketKey),
                String.valueOf(policy.capacity()),
                String.valueOf(policy.refillPerSecond()),
                String.valueOf(System.currentTimeMillis()),
                String.valueOf(cost),
                String.valueOf(policy.ttlSeconds()));

        return new RateLimitResult(
                r.get(0) == 1L,                          // allowed
                r.get(1).intValue(),                     // remaining
                Duration.ofMillis(r.get(2)),             // retryAfter
                r.get(3).intValue(),                     // limit
                policy);
    }
}
```

**⚠️ `cost` 參數是很實用的設計**（8.4.4 會用到）：
貴的操作扣多個令牌。

#### 演算法 5：漏桶（Leaky Bucket）/ GCRA

```
請求進入佇列，以固定速率「漏出」處理
佇列滿了就拒絕
```

**和令牌桶的差別**：

| | 令牌桶 | 漏桶 |
|---|---|---|
| 爆發 | ✅ 允許（桶滿時） | ❌ 不允許（固定速率） |
| 輸出速率 | 可變 | ★ 恆定 |
| 適合 | API 限流（爆發是正常的） | 保護下游（下游只能承受固定速率） |

**GCRA（Generic Cell Rate Algorithm）** 是漏桶的一種高效實作
（Redis 的 `redis-cell` 模組用它），記憶體只需要一個時間戳。

#### 演算法比較表

| 演算法 | 記憶體 | 精確度 | 允許爆發 | 實作複雜度 | 適合 |
|---|---|---|---|---|---|
| 固定窗口 | ★ 最小 | ⚠️ 邊界 2 倍 | ⚠️ 不可控 | ★ 最簡單 | 粗略的保護 |
| 滑動窗口日誌 | 🔴 大 | ★ 完全精確 | ❌ | 中 | 低配額的敏感操作 |
| 滑動窗口計數 | ★ 小 | ⚠️ 估算 | ⚠️ | 中 | 一般用途 |
| **令牌桶** | ★ 小 | ✅ 精確 | ★ 可控 | 中 | ★ **API 限流的預設選擇** |
| 漏桶 / GCRA | ★ 最小 | ✅ 精確 | ❌ | 中高 | 保護速率敏感的下游 |

**shop-service 的選擇**：

| 用途 | 演算法 |
|---|---|
| 一般 API 限流 | **令牌桶**（允許爆發，符合真實使用模式） |
| 登入、簡訊、密碼重設 | **滑動窗口日誌**（配額低，需要完全精確） |
| 對金流商的呼叫（保護下游） | **漏桶**（金流商要求固定速率） |

### 8.4.3 限流的維度

**「每分鐘 100 次」—— 每什麼的每分鐘？**

| 維度 | key | 用途 | 問題 |
|---|---|---|---|
| **IP** | `ip:1.2.3.4` | 未認證的端點（登入、註冊） | 🔴 NAT／企業出口共用 IP → 誤殺整間公司 |
| **使用者** | `user:cus_01J5GK` | 已認證的端點 | ★ 最公平 |
| **API key** | `key:vendor-a` | 廠商對接 | ★ 可依合約分級 |
| **端點** | `user:cus_1:GET:/orders` | 針對特定端點 | 配額管理較複雜 |
| **租戶** | `tenant:t_abc` | SaaS（第 01 章 1.10） | 一個租戶內的使用者互相影響 |
| **全域** | `global` | ① 保護系統 | 超過時回 `503` 不是 `429` |

**⚠️ IP 限流的三個坑**：

| 坑 | 說明 | 解法 |
|---|---|---|
| **拿到的是 LB 的 IP** | `request.getRemoteAddr()` 回的是負載平衡器 | 讀 `X-Forwarded-For` 的**第一個**（但見下） |
| 🔴 **`X-Forwarded-For` 可被偽造** | 客戶端自己送 `X-Forwarded-For: 1.1.1.1` → 繞過限流 | 只信任「你的 LB 附加的那一段」 |
| NAT 共用 | 一間公司 500 人共用一個出口 IP → 誤殺 | 對已認證的請求用「使用者」維度；IP 只用於未認證端點 |

```java
// ✅ 正確處理 X-Forwarded-For
@Bean
ForwardedHeaderFilter forwardedHeaderFilter() {
    return new ForwardedHeaderFilter();
}
```

```yaml
server:
  forward-headers-strategy: framework    # ★ 讓 Spring 正確處理 X-Forwarded-*
  tomcat:
    remoteip:
      # ★ 只信任這些來源送來的 X-Forwarded-For（你的 LB 網段）
      internal-proxies: "10\\.0\\.\\d{1,3}\\.\\d{1,3}|172\\.16\\.\\d{1,3}\\.\\d{1,3}"
```

**⚠️ `internal-proxies` 沒設對就等於「IP 限流可以被繞過」。**

### 8.4.4 多桶設計：按操作成本分級 ★

**單一配額的問題**：

```
「每分鐘 300 次」
→ 一個便宜的 GET /orders/{id}（6ms）和一個貴的
  GET /orders?include=totalCount（3 秒）算同一個配額
→ 使用者用 30 次貴的操作就把資料庫拖垮，但只用掉 10% 配額
```

**解法一：多個獨立的桶（GitHub 的 `x-ratelimit-resource`，第 02 章 2.16 練習 5）**

```java
public enum RateLimitBucket {
    // 桶名        容量   每秒補充   說明
    READ          (300,  5.0),     // 一般讀取
    WRITE         ( 60,  1.0),     // 寫入
    SEARCH        ( 30,  0.5),     // 搜尋（貴）
    EXPENSIVE     ( 10,  0.166),   // include=totalCount、aggregates
    EXPORT        (  3,  0.0083),  // 匯出工作（每 2 分鐘 1 個）
    AUTH          (  5,  0.0166),  // 登入（每分鐘 1 次，容量 5）
    NOTIFICATION  (  3,  0.0083),  // 重寄通知
    WEBHOOK_TEST  ( 10,  0.166);

    private final int capacity;
    private final double refillPerSecond;
}
```

**解法二：加權扣費（同一個桶，貴的操作扣多個令牌）**

```java
public int costOf(HttpServletRequest req) {
    int cost = 1;
    if (hasParam(req, "include", "totalCount"))  cost += 10;   // 精確 count 很貴
    if (hasParam(req, "include", "aggregates"))  cost += 10;
    if (hasParam(req, "q"))                       cost += 3;    // 搜尋
    if (hasParam(req, "expand"))                  cost += countExpands(req) * 2;
    int size = intParam(req, "size", 20);
    if (size > 50)                                cost += 2;
    return cost;
}
```

**兩種解法的取捨**：

| | 多桶 | 加權扣費 |
|---|---|---|
| 概念清楚度 | ★ 清楚（「搜尋額度用完了但一般查詢還可以」） | ⚠️ 較抽象 |
| 客戶端可理解 | ★ 好（`RateLimit-Policy` 可以列出各桶） | ⚠️ 難（「為什麼我只發了 30 次就被限流？」） |
| 靈活度 | 中 | ★ 高（可以精細調整） |
| 實作 | 多次 Redis 呼叫（或一次 Lua 處理多個 key） | 一次 |

**shop-service 的決定：多桶為主 + 桶內加權**。

```
GET /orders                          → READ 桶，cost 1
GET /orders?include=totalCount       → EXPENSIVE 桶，cost 1
GET /orders?q=王小明                  → SEARCH 桶，cost 1
GET /orders?expand=items&size=100    → READ 桶，cost 1 + 2(expand) + 2(size>50) = 5
POST /orders                         → WRITE 桶，cost 1
POST /order-exports                  → EXPORT 桶，cost 1
POST /auth/tokens                    → AUTH 桶（IP 維度），cost 1
```

**「按操作成本分級」的實際效益**：

```
單一配額：使用者用貴的操作 → 便宜的操作也被限流 → 整個 App 卡住
多桶：    搜尋額度用完 → 搜尋功能暫時不可用，但瀏覽訂單正常
          → ★ 降級而不是全掛
```

### 8.4.5 `429` 回應與 header

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
RateLimit-Limit: 30
RateLimit-Remaining: 0
RateLimit-Reset: 42
RateLimit-Policy: 30;w=60;name="search", 300;w=60;name="read"
X-RateLimit-Bucket: search
Content-Type: application/problem+json
Cache-Control: no-store
Access-Control-Expose-Headers: Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Policy, X-RateLimit-Bucket
```

```jsonc
{
  "type": "https://api.shop.example/problems/rate-limit-exceeded",
  "title": "請求過於頻繁",
  "status": 429,
  "detail": "Rate limit of 30 requests per 60s for bucket 'search' exceeded.",
  "instance": "/v1/orders",
  "code": "RATE_LIMIT_EXCEEDED",
  "userMessage": "搜尋過於頻繁，請 42 秒後再試。",
  "bucket": "search",
  "limit": 30,
  "windowSeconds": 60,
  "remaining": 0,
  "resetAt": "2026-08-19T06:13:26Z",
  "retryAfterSeconds": 42,
  "retryable": true,
  "retryStrategy": "BACKOFF_AND_RETRY",
  "otherBuckets": [
    { "name": "read", "limit": 300, "remaining": 287 },
    { "name": "write", "limit": 60, "remaining": 60 }
  ],
  "hint": "此端點使用 'search' 配額桶。若只需列表（不搜尋），請移除 q 參數以使用較寬鬆的 'read' 配額。",
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**`otherBuckets` 與 `hint` 是很有價值的設計**：
它們告訴客戶端「你還有別的額度可以用」以及「怎麼改用便宜的方式」。

#### `RateLimit` header 的標準狀態（要誠實）

| Header | 狀態 |
|---|---|
| `Retry-After` | ✅ **RFC 9110**（正式標準） |
| `RateLimit-Limit` / `-Remaining` / `-Reset` | ⚠️ **IETF draft**（`draft-ietf-httpapi-ratelimit-headers`，早期版本） |
| `RateLimit` / `RateLimit-Policy`（結構化欄位） | ⚠️ **同一份 draft 的較新版本** |
| `X-RateLimit-*` | ⚠️ 業界慣例（GitHub、Twitter 用小寫 `x-ratelimit-*`） |

**因為 draft 還在演進，實務建議**：

```
必須有：Retry-After（正式標準，且客戶端函式庫／Envoy／Istio 都認得）
建議有：RateLimit-Limit / -Remaining / -Reset（draft，但廣泛使用）
可以有：X-RateLimit-*（相容既有工具）
body：  完整資訊（不受 header 標準演進影響）
```

**⚠️ 一個常見的錯誤：`RateLimit-Reset` 的單位**

```
GitHub 用：x-ratelimit-reset: 1755587564      ← Unix 秒數（絕對時間）
IETF draft：RateLimit-Reset: 42                ← 剩餘秒數（相對時間）
```

**兩種都有人用，所以文件必須寫清楚。**

**shop-service 的決定**：
- header 用 **相對秒數**（和 `Retry-After` 一致，客戶端不用處理時鐘偏差）。
- body 的 `resetAt` 用 **絕對時間**（給 UI 顯示「06:13 後恢復」）。
- 在文件明確標示。

#### 未超限時也要回 header

```http
GET /v1/orders?q=王小明
→ 200 OK
  RateLimit-Limit: 30
  RateLimit-Remaining: 27
  RateLimit-Reset: 51
  RateLimit-Policy: 30;w=60;name="search", 300;w=60;name="read"
```

**這讓客戶端能「主動節流」而不是「撞牆後重試」**：

```typescript
const res = await api.GET('/orders', { params: { query: { q } } });
const remaining = Number(res.response.headers.get('RateLimit-Remaining') ?? '999');

if (remaining < 5) {
  // ★ 主動降速，避免撞到 429
  searchDebounceMs = 2000;
} else {
  searchDebounceMs = 300;
}
```

**⚠️ 但回 header 有成本**：每個請求都要讀限流狀態（即使沒超限）。
令牌桶的 Lua 已經會回傳 `remaining`，所以成本是零 —— **這是選令牌桶的另一個好處**。

### 8.4.6 分散式限流的三個問題

**問題 1：時鐘偏差**

```
Pod A 的時鐘：12:00:00.000
Pod B 的時鐘：12:00:00.350    ← 差 350ms
→ 令牌桶的「經過時間」計算不一致 → 補充量不準
```

**解法**：**用 Redis 的時間，不用應用程式的時間**。

```lua
-- ★ 用 Redis 自己的時鐘（所有 Pod 看到同一個時間）
local t = redis.call('TIME')                 -- { 秒, 微秒 }
local now = t[1] * 1000 + math.floor(t[2] / 1000)
```

**⚠️ 注意**：`redis.call('TIME')` 在**舊版 Redis** 中被視為「非確定性指令」，
在 replication 時可能有問題。Redis 5+ 的 effect replication 已解決。
**Redis 7+ 完全安全。**

**問題 2：Redis 掛掉**

```
Redis 不可用 → 限流器無法工作 → 怎麼辦？
```

| 策略 | 說明 | 適合 |
|---|---|---|
| **Fail-open**（放行） | 限流器壞了就不限流 | ★ 一般 API（可用性優先） |
| **Fail-closed**（拒絕） | 限流器壞了就全部拒絕 | 🔴 太激進（Redis 抖一下全站掛） |
| **Fail-open + 本機備援** | Redis 掛了改用本機（單 Pod）的限流器 | ★★ **推薦** |

```java
public RateLimitResult tryConsume(String key, RateLimitPolicy policy, int cost) {
    try {
        return redisLimiter.tryConsume(key, policy, cost);
    } catch (RedisConnectionFailureException | QueryTimeoutException e) {
        limiterFallbackCounter.increment();
        log.warn("Redis 限流器不可用，降級為本機限流 key={}", key);
        // ★ 本機的 Caffeine + Bucket4j，配額除以 Pod 數（保守估計）
        return localLimiter.tryConsume(key, policy.dividedBy(expectedPodCount()), cost);
    }
}
```

**「配額除以 Pod 數」是保守的近似**：3 個 Pod，每個放行 1/3 的配額 →
總量大致正確（假設負載平衡均勻）。

**⚠️ 一定要有指標與告警**：`limiterFallbackCounter` 非零表示 Redis 有問題。

**問題 3：熱鍵（hot key）**

```
一個大廠商的 API key 每秒 5000 次請求
→ 全部打到 Redis 的同一個 key
→ 該 key 所在的 slot 成為熱點
→ 🔴 Redis Cluster 中該節點的 CPU 飆高
```

**三種解法**：

| 解法 | 說明 |
|---|---|
| **本機預先扣減（local pre-consume）** | 每個 Pod 先向 Redis「批發」100 個令牌，本機消耗完再去拿 → Redis 請求量降 100 倍 |
| **分片 key** | `rl:vendor-a:{0..9}`，隨機挑一個，每個配額是 1/10 |
| **分層限流** | 全域用 Redis（粗），每 Pod 用本機（細） |

**「本機預先扣減」的實作概念**：

```java
public class BatchedRateLimiter {
    private final Map<String, LocalLease> leases = new ConcurrentHashMap<>();

    record LocalLease(AtomicInteger remaining, Instant expiresAt) {}

    public boolean tryConsume(String key, RateLimitPolicy policy) {
        LocalLease lease = leases.get(key);
        if (lease != null && lease.expiresAt().isAfter(Instant.now())
                && lease.remaining().decrementAndGet() >= 0) {
            return true;                                   // ★ 本機命中，不打 Redis
        }
        // 向 Redis 批發一批（例如 50 個令牌，有效 5 秒）
        RateLimitResult r = redisLimiter.tryConsume(key, policy, BATCH_SIZE);
        if (!r.allowed()) return false;
        leases.put(key, new LocalLease(new AtomicInteger(BATCH_SIZE - 1),
                                       Instant.now().plusSeconds(5)));
        return true;
    }
}
```

**⚠️ 代價：精確度下降。**

```
3 個 Pod × 各批發 50 個令牌 = 可能瞬間放行 150 次（超過設定值）
而且 Pod 關閉時未用完的令牌就浪費了
```

**判準：只對「超高流量的 key」啟用批發，一般 key 走精確路徑。**

### 8.4.7 Spring 的實作選擇

| 方案 | 說明 | 適合 |
|---|---|---|
| **自己寫 Filter + Redis Lua** | 8.4.2 的做法 | ★ 完全掌控，多桶與加權容易做 |
| **Bucket4j** | 成熟的令牌桶庫，支援 Redis / Hazelcast 後端 | ★ 不想自己寫 Lua |
| **Resilience4j RateLimiter** | ⚠️ **單機**（不是分散式） | 保護對下游的呼叫 |
| **Spring Cloud Gateway** `RequestRateLimiter` | 在閘道層做（Redis 令牌桶） | 微服務架構、有閘道 |
| **Nginx** `limit_req` | 在反向代理層做 | 粗略的 IP 保護 |
| **API Gateway**（Kong / AWS API Gateway） | 基礎設施層 | 有現成閘道時 |

**Bucket4j 的範例**：

```java
@Bean
ProxyManager<String> bucket4jProxyManager(RedisClient redisClient) {
    return LettuceBasedProxyManager.builderFor(redisClient)
            .withExpirationStrategy(
                    ExpirationAfterWriteStrategy.basedOnTimeForRefillingBucketUpToMax(
                            Duration.ofMinutes(10)))
            .build();
}

public boolean tryConsume(String key, RateLimitBucket b, int cost) {
    BucketConfiguration cfg = BucketConfiguration.builder()
            .addLimit(l -> l.capacity(b.capacity())
                            .refillGreedy(b.refillPerPeriod(), b.period()))
            .build();
    return proxyManager.builder().build(key, () -> cfg).tryConsume(cost);
}
```

**⚠️ Bucket4j 的一個限制**：
取得「剩餘量」需要額外呼叫（`tryConsumeAndReturnRemaining`），
而自己寫的 Lua 可以一次回傳全部資訊（8.4.2）。

**shop-service 的決定**：

```
應用層：自己寫 Filter + Redis Lua（多桶 + 加權 + 一次回傳完整資訊）
Nginx： 粗略的 IP 保護（每 IP 每秒 50 次）—— 擋掉明顯的攻擊，不進 JVM
```

**兩層的分工**：

| 層 | 目的 | 設定 |
|---|---|---|
| Nginx | 擋掉「明顯的攻擊」（不消耗 JVM 資源） | 每 IP 每秒 50 次，`burst=100` |
| 應用層 | 精細的業務配額（多桶、按使用者） | 8.4.4 的多桶設定 |

### 8.4.8 真實案例：限流把自己的前端擋掉了

```
背景：新上線「訂單列表」頁面，有一個「即時搜尋」功能（使用者打字就搜）
限流：每使用者每分鐘 60 次

事故時間軸：
14:02  使用者在搜尋框打「無線降噪耳機」（8 個字）
       → 前端沒有 debounce → 每打一個字發一次請求 → 8 次
14:02  使用者改主意，刪掉重打 → 又 8 次
14:03  使用者瀏覽了 5 個分頁 → 5 次
14:03  第 61 次請求 → 429
14:03  🔴 前端的錯誤處理是「顯示紅色 toast」→ 使用者看到「請求過於頻繁」
14:03  使用者不知道發生什麼，重新整理頁面 → 又發 6 個請求（列表 + 統計 + 使用者資訊...）
14:03  持續 429
14:05  客服接到「網站壞了」的投訴
15:20  查出原因
```

**這個事故有五個獨立的錯誤**：

| # | 錯誤 | 修正 |
|---|---|---|
| 1 | 前端沒有 debounce | 搜尋加 300ms debounce（打字時只發最後一次） |
| 2 | 搜尋和一般查詢用同一個配額 | 多桶（8.4.4）：搜尋 30/分，讀取 300/分 |
| 3 | 前端沒有讀 `RateLimit-Remaining` | 剩餘 < 5 時主動降速（8.4.5） |
| 4 | 前端把 `429` 當一般錯誤顯示 | `429` 應該「靜默等待 + 自動重試」，不是顯示紅色錯誤 |
| 5 | 沒有監控「429 的來源」 | 加指標：`429` 按 `consumer` + `bucket` 分組 |

**第 4 點的正確處理**：

```typescript
// ❌ 事故時的程式碼
catch (err) {
  toast.error(err.problem.userMessage);        // 429 也顯示紅色 toast
}

// ✅ 修正後
catch (err) {
  const p = err.problem;
  if (p.status === 429) {
    // 靜默處理：顯示 loading 而不是 error
    setSearchState({ status: 'throttled', retryInSeconds: p.retryAfterSeconds });
    setTimeout(() => retry(), p.retryAfterSeconds * 1000);
    return;
  }
  toast.error(p.userMessage);
}
```

**第 5 點的監控（事後補上）**：

```java
Counter.builder("api.rate_limit.rejected")
       .tag("bucket", bucket.name())
       .tag("consumer", consumerId)
       .tag("endpoint", normalizedPath)
       .register(registry).increment();
```

```yaml
# ★ 這條告警會讓你在使用者投訴前就知道
- alert: OwnFrontendBeingRateLimited
  expr: |
    sum by (consumer, bucket) (rate(api_rate_limit_rejected_total{consumer=~"shop-web|shop-ios|shop-android"}[5m])) > 1
  for: 5m
  labels: { severity: critical }
  annotations:
    summary: "🔴 自家前端 {{ $labels.consumer }} 正被限流（桶：{{ $labels.bucket }}）"
    description: "這幾乎一定是配額設定錯誤或前端沒有節流，不是攻擊。"
```

**「自家前端被限流」和「外部攻擊被限流」是完全不同的事件，必須分開告警。**

**這一節的核心教訓**：

> **限流的第一個受害者通常是你自己的前端。**
>
> 上線新的限流規則前，一定要：
> 1. 先用 **dry-run 模式**跑一週（只記錄不拒絕）
> 2. 看實際的用量分布（P50 / P95 / P99 / max）
> 3. 把配額設在 **P99.9 以上**
> 4. 分「自家 consumer」和「外部 consumer」的告警

**dry-run 模式的實作**：

```java
RateLimitResult r = limiter.tryConsume(key, policy, cost);

if (!r.allowed()) {
    limitRejectedCounter(bucket, consumerId).increment();

    if (properties.isDryRun()) {                        // ★ 設定檔開關
        log.warn("[限流 DRY-RUN] 若非 dry-run 此請求會被拒絕 " +
                 "consumer={} bucket={} endpoint={} cost={}",
                 consumerId, bucket, path, cost);
        // 繼續執行，不拒絕
    } else {
        writeRateLimitProblem(res, r);
        return;
    }
}
```

---

## 8.5 三者的交互作用

**這一節處理「單獨看都對，合起來會出事」的情況。**

### 8.5.1 重試 + 限流：重試風暴

```
14:02  資料庫慢查詢 → 大量請求超時 → 回 503
14:02  1000 個客戶端收到 503（retryable: true, retryAfterSeconds: 5）
14:02:05  1000 個客戶端同時重試      ← 🔴 二次打擊
14:02:05  更多 503
14:02:10  又 1000 個重試             ← 🔴 三次打擊
→ 「重試風暴」，比原本的問題更嚴重
```

**四道防線**：

| 防線 | 說明 |
|---|---|
| **① `Retry-After` + 抖動** | 客戶端必須加 ±50% 抖動（第 04 章 4.9.3）。**要寫進 Consumer Contract** |
| **② 重試也算配額** | 重試消耗令牌 → 重試風暴會被限流擋住 |
| **③ 伺服器端的 `Retry-After` 加抖動** | 你回的 `Retry-After` 本身就可以隨機化 |
| **④ 熔斷器** | 錯誤率過高時直接快速失敗，不讓請求打到已經掛掉的下游 |

**防線 ③ 的實作（很簡單但很有效）**：

```java
// ❌ 所有客戶端都被告知「5 秒後重試」→ 5 秒後同時湧入
.header("Retry-After", "5")

// ✅ 伺服器端就加抖動 → 重試自然分散在 4~8 秒
int base = 5;
int jittered = base + ThreadLocalRandom.current().nextInt(0, base + 1);
.header("Retry-After", String.valueOf(jittered))
```

**防線 ② 的一個爭議**：重試該不該算配額？

| 選擇 | 說明 |
|---|---|
| **算**（推薦） | ✅ 防重試風暴。⚠️ 但「因為我們掛了而重試」卻扣使用者的配額，有點不公平 |
| 不算 | 🔴 重試風暴無法被限流擋住 |
| 折衷 | 5xx 造成的重試**半價**（cost 減半），4xx 造成的重試全價 |

**shop-service 選「算，但 5xx 之後的重試 cost = 0.5」**（用加權扣費，8.4.4）。

### 8.5.2 快取 + 授權：最危險的組合

**這是本章最需要小心的一節，因為它的失敗模式是「個資外洩」。**

**風險 1：`public` 快取了私有資料**（8.3.3 已述）

**風險 2:「快取在授權檢查之前」**

```
❌ 錯誤的順序
CDN / 反向代理快取
    ↓（命中就直接回，不打源站）
應用程式的授權檢查         ← 🔴 被跳過了
```

```
情境：
T1  使用者 A（有權限）GET /orders/ord_1  → 200 + 存進 CDN
T2  使用者 B（無權限）GET /orders/ord_1  → CDN 命中 → 🔴 拿到 A 的訂單
    → 授權檢查完全沒執行
```

**這就是為什麼 `Cache-Control: private` 對需要授權的端點是強制的** ——
`private` 讓 CDN 不會儲存，所以每個請求都會到源站做授權檢查。

**風險 3：應用程式內快取漏了授權維度**

```java
// 🔴 快取鍵漏了使用者
@Cacheable(value = "orderDetail", key = "#orderId")
public OrderDetail findDetail(String orderId) {
    return repo.findByIdAndCustomerId(orderId, currentCustomerId())    // 授權在這裡
               .map(mapper::toDetail)
               .orElseThrow();
}
// → A 使用者查了 ord_1 → 快取
// → B 使用者查 ord_1 → 快取命中 → 🔴 直接回 A 的資料，授權檢查沒執行
```

```java
// ✅ 快取鍵含授權維度
@Cacheable(value = "orderDetail", key = "#orderId + ':' + @authFacade.currentCustomerId()")
```

**更好的做法：把授權移到快取之外**：

```java
public OrderDetail findDetail(String orderId) {
    // ★ 授權檢查永遠執行（不被快取）
    orderGuard.assertCanRead(orderId, currentPrincipal());
    // 快取的是「資料」，不是「授權結果」
    return cachedFindDetail(orderId);
}

@Cacheable(value = "orderDetail", key = "#orderId")
protected OrderDetail cachedFindDetail(String orderId) { ... }
```

⚠️ 注意這裡有第 02 章 2.5 提過的**自呼叫問題**（02-spring-boot 第 04 章）：
`cachedFindDetail` 是同類別內部呼叫 → **`@Cacheable` 不會生效**。
要拆成另一個 bean，或注入自己。

**風險 4：`ETag` 不含授權維度**

```
使用者 A：GET /orders/ord_1 → ETag "v7"（含 internalNotes，因為 A 是客服）
使用者 B：GET /orders/ord_1 + If-None-Match: "v7" → 304
          → 🔴 B 用了 A 的快取（含客服才能看的欄位）
```

**這需要 `ETag` 涵蓋「呈現的版本」而不只是「資料的版本」**（8.3.4）：

```java
String etag = new ETagSource(
        version,
        locale.toLanguageTag(),
        expands,
        viewerRole                    // ★ 加入角色
).toETag();
```

**快取 + 授權的檢查清單**：

```
□ 需要認證的端點一律 Cache-Control: private（或 no-store）
□ 應用程式內快取的鍵包含「使用者／角色／租戶」
□ 或者：授權檢查在快取之外（且注意自呼叫問題）
□ ETag 包含所有影響回應內容的因素（含角色、語言、expand）
□ 錯誤回應一律 no-store（8.3.9）
□ CDN 設定 review 過（確認 private 真的被尊重）
□ 有測試驗證「不同使用者不會拿到彼此的快取」（第 09 章 9.4）
```

**最後一項的測試**：

```java
@Test
void 不同使用者不會共用快取() throws Exception {
    // A 查詢
    String etagA = mockMvc.perform(get("/v1/orders/ord_shared_id")
                    .header("Authorization", "Bearer " + TOKEN_SUPPORT))
            .andExpect(status().isOk())
            .andReturn().getResponse().getHeader("ETag");

    // B 帶 A 的 ETag 查同一筆
    mockMvc.perform(get("/v1/orders/ord_shared_id")
                    .header("Authorization", "Bearer " + TOKEN_CUSTOMER_B)
                    .header("If-None-Match", etagA))
            .andExpect(status().isNotFound());       // ★ 不是 304！B 無權存取

    // 而且回應一定是 private
    mockMvc.perform(get("/v1/orders/ord_own")
                    .header("Authorization", "Bearer " + TOKEN_CUSTOMER_A))
            .andExpect(header().string("Cache-Control",
                    containsString("private")));
}
```

### 8.5.3 冪等鍵 + 快取

```
POST 請求不該被快取（RFC 9111 允許但需要明確的 Cache-Control）
→ 冪等鍵的「回放」是應用層的機制，不是 HTTP 快取
→ 兩者不衝突
```

**但有一個要注意的點**：

```http
POST /v1/orders
Idempotency-Key: 8f14e45f-...
→ 200 OK
  Idempotent-Replay: true
```

**這個回應必須 `Cache-Control: no-store`**：

```
若 CDN 快取了這個 200 回應
→ 另一個帶不同 Idempotency-Key 的 POST 可能命中快取
→ 🔴 拿到別人的訂單
```

**實務上 CDN 通常不快取 `POST`，但不要依賴「通常」。** 明確設定。

### 8.5.4 冪等鍵 + 限流

```
客戶端重試（相同 Idempotency-Key）→ 該不該扣配額？
```

| 選擇 | 說明 |
|---|---|
| **扣**（推薦） | 回放仍然消耗資源（讀 Redis、序列化回應）。而且防止客戶端無限重試 |
| 不扣 | ⚠️ 客戶端可以用同一個 key 無限重試而不消耗配額 → 可以當成 DoS 手法 |

**但回放的 cost 可以較低**（8.4.4 的加權）：

```java
if (idempotentReplay) cost = 1;      // 回放：只讀 Redis
else                  cost = 3;      // 實際執行：完整的業務邏輯
```

### 8.5.5 三者與可觀測性

**三個機制都必須可觀測，否則你不知道它們有沒有在工作。**

| 機制 | 關鍵指標 | 異常代表什麼 |
|---|---|---|
| 冪等鍵 | 回放比例、指紋不符次數、接手逾時次數 | 8.2.9 |
| 快取 | `304` 比例、CDN 命中率、`ETag` 命中率 | `304` 比例接近 0 → ETag 策略無效（可能是 8.3.4 的問題） |
| 限流 | 各桶的拒絕率（按 consumer 分組） | 自家 consumer 被拒 → 🔴 設定錯誤（8.4.8） |

**一個綜合的儀表板**：

```
┌─ 冪等 ──────────────────────────────────────────┐
│ 回放比例          0.8%   ← 正常（0.1~2%）        │
│ 指紋不符          0      ← 正常（任何非零都要查） │
│ 接手逾時          0      ← 正常                  │
├─ 快取 ──────────────────────────────────────────┤
│ CDN 命中率        78%    ← /products             │
│ 304 比例          12%    ← /orders/{id}          │
│ private 洩漏檢查  ✅     ← 自動掃描回應 header    │
├─ 限流 ──────────────────────────────────────────┤
│ read   拒絕率     0.02%  ← 正常                  │
│ search 拒絕率     1.4%   ← 偏高，考慮放寬        │
│ export 拒絕率     8%     ← 正常（刻意嚴格）      │
│ 自家 consumer 被拒 0     ← 🔴 非零就是設定錯誤    │
│ Redis 降級次數    0      ← 非零表示 Redis 有問題  │
└──────────────────────────────────────────────────┘
```

**「private 洩漏檢查」是一個很實用的自動化**：

```java
// 在測試或 staging 的 filter 中掃描
@Component
@Profile({"test", "staging"})
public class CacheHeaderAuditFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(...) throws ... {
        chain.doFilter(req, res);

        boolean authenticated = isAuthenticated(req);
        String cc = res.getHeader("Cache-Control");

        if (authenticated && (cc == null || (!cc.contains("private") && !cc.contains("no-store")))) {
            String msg = "🔴 需要認證的端點未設定 private/no-store: %s %s → Cache-Control: %s"
                    .formatted(req.getMethod(), req.getRequestURI(), cc);
            log.error(msg);
            meterRegistry.counter("cache.private_leak").increment();
            if (failFast) throw new IllegalStateException(msg);   // 測試環境直接失敗
        }
    }
}
```

**這個 filter 在 CI 跑一次完整的 API 測試，就能掃出所有漏設 `private` 的端點。**

---

## 8.6 熔斷與降級（簡述）

**限流保護「你被打」，熔斷保護「你打別人」。**

```
你的服務 → 金流商 API
           ↓ 金流商掛了（回應 30 秒超時）
你的服務的執行緒被佔滿 → 🔴 連不需要金流的請求也掛了
```

**熔斷器的三個狀態**：

```
CLOSED（正常）
   │ 錯誤率 > 50%（在最近 20 次呼叫中）
   ▼
OPEN（快速失敗，不打下游）
   │ 等待 30 秒
   ▼
HALF_OPEN（試探性放行幾次）
   ├─ 成功 → CLOSED
   └─ 失敗 → OPEN
```

```java
// Resilience4j
@CircuitBreaker(name = "paymentGateway", fallbackMethod = "paymentUnavailable")
@TimeLimiter(name = "paymentGateway")
@Bulkhead(name = "paymentGateway", type = Bulkhead.Type.SEMAPHORE)
public PaymentResult charge(ChargeRequest req) {
    return gatewayClient.charge(req);
}

private PaymentResult paymentUnavailable(ChargeRequest req, Throwable t) {
    if (t instanceof CallNotPermittedException) {
        // 熔斷器打開 → 明確告知使用者，並給替代方案
        throw new PaymentGatewayUnavailableException(
                Duration.ofSeconds(30), List.of("ATM_TRANSFER", "CONVENIENCE_STORE"));
    }
    throw new PaymentGatewayTimeoutException();
}
```

```jsonc
// 熔斷器打開時的回應（第 04 章 4.13.4）
{
  "type": "https://api.shop.example/problems/payment-gateway-unavailable",
  "title": "付款服務暫時無法使用",
  "status": 503,
  "code": "PAYMENT_GATEWAY_UNAVAILABLE",
  "userMessage": "信用卡付款暫時無法使用，請改用 ATM 轉帳或超商繳費。您的訂單已保留。",
  "retryable": true,
  "retryAfterSeconds": 30,
  "alternativeAction": {
    "code": "CHANGE_PAYMENT_METHOD",
    "label": "改用其他付款方式",
    "supportedMethods": ["ATM_TRANSFER", "CONVENIENCE_STORE", "LINE_PAY"]
  },
  "traceId": "4f2c8a1e9b7d3f60"
}
```

**`Bulkhead`（艙壁）也很重要**：限制「同時對下游的呼叫數」，
避免一個慢的下游佔滿所有執行緒。

（完整的熔斷、重試、艙壁設定在 05-service 會詳談。）

---

## 8.7 shop-service 完整規格

### 8.7.1 冪等鍵

```yaml
idempotency:
  header: Idempotency-Key
  key-pattern: "^[A-Za-z0-9_-]{16,128}$"
  ttl: PT24H
  in-progress-timeout: PT60S
  max-fingerprint-body-bytes: 65536
  replay-status: 200                      # 回放時的狀態碼
  replay-header: Idempotent-Replay
  fingerprint:
    canonicalize-json: true               # 物件 key 排序
    canonicalize-arrays: false            # 陣列順序保留
    normalize-numbers: true               # 2.0 → 2
  # 記錄哪些結果（後續重試會拿到相同回應）
  record-outcomes: "2xx,4xx"              # 5xx / 408 / 429 不記錄
  storage:
    default: redis
    transactional-endpoints:               # 這些用 MySQL（與業務同交易）
      - "POST /v1/orders/{orderId}/payments"
      - "POST /v1/payments/{paymentId}/refunds"
  required-endpoints:
    - "POST /v1/orders"
    - "POST /v1/orders/{orderId}/payments"
    - "POST /v1/orders/{orderId}/cancellations"
    - "POST /v1/orders/{orderId}/shipments"
    - "POST /v1/orders/{orderId}/returns"
    - "POST /v1/payments/{paymentId}/refunds"
    - "POST /v1/products/{productId}/inventory-adjustments"
  optional-endpoints:
    - "POST /v1/order-exports"
    - "POST /v1/order-import-jobs"
  # 業務層的二次防護（8.2.4 競態條件 3）
  business-level-unique-constraints:
    - "orders(customer_id, idempotency_key)"
    - "payments(order_id, idempotency_key)"
    - "refunds(payment_id, idempotency_key)"
```

### 8.7.2 快取

見 8.3.9 的矩陣。全域規則：

```
□ 需要認證的端點：預設 private, no-store（由 CacheControlAdvice 強制）
□ 公開端點：明確設定 public + max-age + stale-while-revalidate
□ 所有 4xx / 5xx：no-store
□ ETag 必須涵蓋：資料版本 + locale + expand + viewerRole
□ Vary 只列真正影響內容的 header（並在 CDN 正規化）
□ 應用程式內快取的鍵必須含授權維度
□ CI 有 CacheHeaderAuditFilter 掃描漏設 private 的端點
```

### 8.7.3 限流

```yaml
rate-limit:
  enabled: true
  dry-run: false                          # ★ 新規則上線前先設 true 跑一週
  fallback: local                          # Redis 掛掉時降級為本機
  expected-pod-count: 3                    # 降級時的配額除數

  buckets:
    read:          { capacity: 300, refill-per-minute: 300, dimension: user }
    write:         { capacity:  60, refill-per-minute:  60, dimension: user }
    search:        { capacity:  30, refill-per-minute:  30, dimension: user }
    expensive:     { capacity:  10, refill-per-minute:  10, dimension: user }
    export:        { capacity:   3, refill-per-minute: 0.5, dimension: user }
    notification:  { capacity:   3, refill-per-minute: 0.5, dimension: user }
    auth:          { capacity:   5, refill-per-minute:   1, dimension: ip,
                     algorithm: sliding-window-log }        # 需要完全精確
    webhook-test:  { capacity:  10, refill-per-minute:  10, dimension: user }

  # 廠商的專屬配額（依合約）
  consumer-overrides:
    vendor-a: { read: 3000, write: 600, export: 20 }
    vendor-b: { read: 1000, write: 200, export: 10 }
    vendor-c: { read:  500, write: 100, export:  5 }
    # ★ 自家前端給寬鬆的配額（8.4.8 的教訓）
    shop-web:     { read: 1000, write: 200, search: 200 }
    shop-ios:     { read: 1000, write: 200, search: 200 }
    shop-android: { read: 1000, write: 200, search: 200 }

  # 端點 → 桶的對映
  endpoint-buckets:
    "GET /v1/orders":                       read
    "GET /v1/orders?include=totalCount":    expensive
    "GET /v1/orders?q=*":                   search
    "GET /v1/products?q=*":                 search
    "POST /v1/orders":                      write
    "POST /v1/order-exports":               export
    "POST /v1/orders/*/notifications":      notification
    "POST /v1/auth/tokens":                 auth
    default:                                read

  # 加權扣費
  cost-modifiers:
    include-total-count: +10
    include-aggregates:  +10
    has-query:            +3
    per-expand:           +2
    size-over-50:         +2
    idempotent-replay:    -0.5              # 回放較便宜
    retry-after-5xx:      -0.5              # 我們的錯造成的重試半價

  headers:
    retry-after: true                       # RFC 9110（必須）
    ratelimit-standard: true                # RateLimit-Limit / -Remaining / -Reset（draft）
    ratelimit-policy: true                  # RateLimit-Policy（draft）
    x-ratelimit-legacy: true                # X-RateLimit-*（相容既有工具）
    reset-unit: relative-seconds            # ★ 文件必須明示
    expose-in-cors: true
```

### 8.7.4 本章用到的錯誤碼

**真正新增的只有 2 個**（其餘 4 個第 04 章 4.13 已經登記過，這裡只是把擴充欄位補完）：

| `code` | 狀態碼 | `title` | 擴充欄位 |
|---|---|---|---|
| `INVALID_IDEMPOTENCY_KEY` | 400 | 冪等鍵格式無效 | `pattern` |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` | 409 | 相同的請求正在處理中 | `originalTraceId`, `retryAfterSeconds` |

**第 04 章已有、本章補上擴充欄位的**：

| `code` | 狀態碼 | `title` | 擴充欄位 |
|---|---|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | 缺少冪等鍵 | `hint` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 冪等鍵已用於不同的請求 | `originalRequestAt`, `originalTraceId` |
| `RATE_LIMIT_EXCEEDED` | 429 | 請求過於頻繁 | `bucket`, `limit`, `windowSeconds`, `remaining`, `resetAt`, `retryAfterSeconds`, `otherBuckets[]`, `hint` |
| `PAYMENT_GATEWAY_UNAVAILABLE` | 503 | 付款服務暫時無法使用 | `retryAfterSeconds`, `alternativeAction` |

> 📌 **這件事本身就是錯誤目錄的價值**：如果沒有 4.13 那張註冊表，
> 你很可能會為「冪等鍵已被用過」再發明一個新碼，最後同一個問題有兩個碼（第 04 章 4.5.5 的問題）。

---

## 8.8 常見誤區

**誤區 1：「冪等鍵就是把 key 存進 Redis，有就跳過」**
8.2.4：這會遇到三個競態條件。必須用**原子插入**（`SET NX` 或 `UNIQUE` 約束），
而且要處理 `IN_PROGRESS` 逾時與「執行成功但記錄失敗」。

**誤區 2：「請求指紋就是對 body 做雜湊」**
8.2.5：JSON 的欄位順序、空白、數值表示方式不同會產生不同的雜湊 →
客戶端重試時被誤判為「不同的請求」。**必須正規化。**

**誤區 3：「冪等鍵要記錄所有結果」**
8.2.6：`5xx` **不能**記錄 —— 否則暫時性的錯誤會被永久回放，客戶端無法重試。

**誤區 4：「客戶端會正確管理冪等鍵」**
8.2.8：最常見的失效原因是「key 沒持久化」——
使用者按 F5 就產生新 key → 冪等保護消失。要寫進文件並提供程式碼範例。

**誤區 5：「`no-cache` 就是不要快取」**
8.3.2：`no-cache` 是「可以存，但用前要驗證」。
「不要存」是 `no-store`。這是最常被搞混的一組。

**誤區 6：「`ETag` 就是資料的版本號」**
8.3.4：`ETag` 必須涵蓋**所有影響回應 body 的因素** ——
包含 `locale`、`expand`、**viewer 的角色**。漏了會讓不同語言／不同角色互相拿到彼此的內容。

**誤區 7：「`ShallowEtagHeaderFilter` 是免費的效能提升」**
8.3.6：它**不省後端運算**（業務邏輯全跑完才算 ETag），只省網路傳輸，
而且整個 body 要進記憶體。

**誤區 8：「加了 `Vary: Authorization` 就安全了」**
8.3.7：技術上正確但實際危險（快取命中率接近 0，而且 CDN 實作有 bug 就是個資外洩）。
需要認證的端點一律 `private`。

**誤區 9：「錯誤回應不用管 `Cache-Control`」**
8.3.9：`409 庫存不足` 若被快取，補貨後客戶端還是拿到錯誤。**錯誤一律 `no-store`。**

**誤區 10：「固定窗口限流夠用了」**
8.4.2：邊界爆發可以達到設定值的 2 倍，而且客戶端的排程若對齊分鐘會集體湧入。

**誤區 11：「一組配額處理所有端點」**
8.4.4：便宜的 `GET` 和貴的 `include=totalCount` 算同一個配額 →
使用者用 30 次貴的操作就能拖垮資料庫但只用掉 10% 配額。

**誤區 12：「IP 限流可以防攻擊」**
8.4.3：`X-Forwarded-For` 可被偽造（要設 `internal-proxies`），
而且 NAT 共用會誤殺整間公司。IP 限流只適合未認證的端點。

**誤區 13：「Redis 掛了就 fail-closed 比較安全」**
8.4.6：Redis 抖一下就全站掛。應該 **fail-open + 本機備援**，並且要有告警。

**誤區 14：「限流上線就直接開啟」**
8.4.8：第一個受害者通常是自家前端。要先 **dry-run 一週**，
看實際用量分布，把配額設在 P99.9 以上。

**誤區 15：「`429` 就是顯示錯誤訊息給使用者」**
8.4.8 第 4 點：`429` 應該「靜默等待 + 自動重試」，
顯示紅色錯誤會讓使用者重新整理 → 更多請求 → 更嚴重。

**誤區 16：「應用程式內快取的鍵用資源 ID 就好」**
8.5.2 風險 3：漏了使用者維度 → 授權檢查被跳過 → 個資外洩。
而且「把授權移到快取外」要注意自呼叫問題。

**誤區 17：「`Retry-After` 給一個固定值就好」**
8.5.1：所有客戶端在同一秒重試 → 重試風暴。**伺服器端就要加抖動。**

---

## 8.9 本章練習

### 練習 1：找出冪等鍵實作的問題

```java
@RestController
public class OrderController {

    private final StringRedisTemplate redis;
    private final OrderService service;

    @PostMapping("/v1/orders")
    public ResponseEntity<OrderDetail> create(
            @RequestHeader(value = "Idempotency-Key", required = false) String key,
            @Valid @RequestBody CreateOrderRequest req) {

        if (key != null) {
            String cached = redis.opsForValue().get("idem:" + key);
            if (cached != null) {
                return ResponseEntity.ok(fromJson(cached, OrderDetail.class));
            }
        }

        OrderDetail order = service.create(req);

        if (key != null) {
            redis.opsForValue().set("idem:" + key, toJson(order), Duration.ofHours(1));
        }

        return ResponseEntity.status(201).body(order);
    }
}
```

<details>
<summary>參考解答</summary>

**🔴 嚴重（會造成重複扣款／資料錯亂）**

| # | 問題 | 說明 |
|---|---|---|
| 1 | 🔴 **「查詢後寫入」有競態** | 8.2.4 競態 1：兩個請求同時抵達，都查不到 → **都執行** → 兩張訂單。<br>必須用 `setIfAbsent`（`SET NX`）原子操作 |
| 2 | 🔴 **沒有 `IN_PROGRESS` 狀態** | 第一個還在執行（3 秒），第二個進來查不到快取 → 也執行 → 兩張訂單 |
| 3 | 🔴 **沒有請求指紋比對** | 同一個 key 送不同內容 → 回放舊訂單 → **客戶端以為新訂單建立了，實際上拿到舊的**。<br>應該回 `409 IDEMPOTENCY_KEY_REUSED`（8.2.5） |
| 4 | 🔴 **key 沒有 scope** | `idem:8f14...` 全域共用 → **使用者 A 的 key 可以被使用者 B 撞到** → A 的訂單資料洩漏給 B。<br>應該是 `idem:{consumerId}:{method}:{path}:{key}`（8.2.3） |
| 5 | 🔴 **`Idempotency-Key` 是選填的** | 這是 `POST /orders`，8.2.2 列為必填。沒帶就完全沒有保護 |
| 6 | 🔴 **執行成功但寫 Redis 失敗時沒有補救** | 8.2.4 競態 3。而且**沒有業務層的唯一約束**當第二道防線 |

**🟠 中等**

| # | 問題 | 說明 |
|---|---|---|
| 7 | **回放時遺失 `Location` 與 `ETag`** | 只存了 body。客戶端拿不到資源 URI（第 02 章 2.4.2） |
| 8 | **回放時沒有 `Idempotent-Replay` header** | 客戶端無法區分「真的建立」與「回放」→ 8.2.7 的重複計數問題 |
| 9 | **回放的狀態碼是 `200`，首次是 `201`** | ⚠️ 這個「碰巧」符合 8.2.7 的建議，但**是意外而非設計**——<br>因為它沒有記錄首次的狀態碼，所以如果首次是 `409`，回放也會變 `200` 🔴 |
| 10 | **只記錄成功的結果** | `service.create()` 拋例外時完全不記錄 → 8.2.6 的 `record-outcomes` 沒實作。<br>`400`/`422` 應該記錄（省下重複驗證） |
| 11 | **TTL 只有 1 小時** | 太短。客戶端的離線重試可能超過 1 小時（8.2.2 建議 24 小時） |
| 12 | **沒有驗證 key 的格式** | 客戶端可以送 10MB 的 key → Redis 記憶體壓力 |
| 13 | **沒有 `traceId`** | 出問題時無法追查「首次執行發生了什麼」 |
| 14 | **冪等邏輯寫在 Controller** | 每個需要冪等的端點都要複製一次 → 應該用 Filter（8.2.6） |
| 15 | **回放的回應沒有 `Cache-Control: no-store`** | 8.5.3 |

**🟡 較小**

| # | 問題 |
|---|---|
| 16 | 沒有指標（8.2.9）—— 不知道回放比例、指紋不符次數 |
| 17 | `fromJson` / `toJson` 用的 ObjectMapper 若和 Spring 的不同，序列化格式會不一致 |
| 18 | Redis 掛掉時整個端點會 500（應該 fail-open 或明確回 503） |

**總計 18 個問題，其中 6 個會造成重複扣款或資料洩漏。**

**修正後的架構**

```java
// ① 冪等邏輯移到 Filter（8.2.6），Controller 完全不用管
@PostMapping("/v1/orders")
public ResponseEntity<OrderDetail> create(@Valid @RequestBody CreateOrderRequest req) {
    OrderDetail order = service.create(req);
    return ResponseEntity.created(URI.create("/v1/orders/" + order.orderId()))
            .eTag("\"v1\"")
            .cacheControl(CacheControl.noStore())
            .body(order);
}
```

```java
// ② Filter 處理全部（節錄 8.2.6 的關鍵部分）
public class IdempotencyFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        if (!policy.applies(req)) { chain.doFilter(req, res); return; }

        String key = req.getHeader("Idempotency-Key");

        // ★ 修正 5：必填檢查
        if (isBlank(key)) {
            if (policy.isRequired(req)) {
                writeProblem(res, IDEMPOTENCY_KEY_REQUIRED); return;
            }
            chain.doFilter(req, res); return;
        }
        // ★ 修正 12：格式驗證
        if (!KEY_PATTERN.matcher(key).matches()) {
            writeProblem(res, INVALID_IDEMPOTENCY_KEY); return;
        }

        var wrapped = new ContentCachingRequestWrapper(req);
        String body = readBody(wrapped);
        // ★ 修正 4：scope 含 consumer + method + path
        String scope = currentConsumerId() + ":" + req.getMethod() + ":" + pathTemplate(req);
        // ★ 修正 3：指紋（含正規化）
        String fp = Fingerprint.of(req.getMethod(), req.getRequestURI(), currentConsumerId(), body);

        // ★ 修正 1、2：原子取得 + IN_PROGRESS 狀態
        var acq = store.tryAcquire(scope, key, fp, Duration.ofHours(24));   // ★ 修正 11：24h

        switch (acq.outcome()) {
            case ACQUIRED -> executeAndRecord(wrapped, res, chain, scope, key, fp);
            case COMPLETED -> replay(res, acq.record());                    // ★ 修正 7、8、9
            case IN_PROGRESS -> handleInProgress(res, scope, key, fp, acq, wrapped, chain);
            case FINGERPRINT_MISMATCH -> writeProblem(res, IDEMPOTENCY_KEY_REUSED,
                    Map.of("originalRequestAt", acq.record().createdAt(),
                           "originalTraceId", acq.record().traceId()));      // ★ 修正 13
        }
    }

    // ★ 修正 7、8、9、15：完整回放
    private void replay(HttpServletResponse res, IdempotencyRecord rec) throws IOException {
        res.setStatus(200);                                  // 8.2.7 的決定
        res.setHeader("Idempotent-Replay", "true");
        res.setHeader("Cache-Control", "no-store");
        rec.responseHeaders().forEach(res::setHeader);        // Location、ETag、Content-Type
        res.getOutputStream().write(rec.responseBody());
        replayCounter.increment();                            // ★ 修正 16
    }

    // ★ 修正 10：依狀態碼決定是否記錄
    private void executeAndRecord(...) throws ... {
        var wrappedRes = new ContentCachingResponseWrapper(res);
        boolean record = false;
        try {
            chain.doFilter(wrappedReq, wrappedRes);
            record = isDeterministicOutcome(wrappedRes.getStatus());   // 2xx/4xx 記錄，5xx 不記錄
        } finally {
            if (record) store.complete(scope, key, wrappedRes.getStatus(),
                                       captureHeaders(wrappedRes),
                                       wrappedRes.getContentAsByteArray(),
                                       MDC.get("traceId"));
            else        store.release(scope, key);
            wrappedRes.copyBodyToResponse();
        }
    }
}
```

```sql
-- ★ 修正 6：業務層的第二道防線（8.2.4 競態 3）
ALTER TABLE orders
  ADD COLUMN idempotency_key VARCHAR(128) NULL,
  ADD UNIQUE KEY uk_orders_idem (customer_id, idempotency_key);
```

```java
// ★ 修正 18：Redis 掛掉的處理
public Acquisition tryAcquire(String scope, String key, String fp, Duration ttl) {
    try {
        return redisStore.tryAcquire(scope, key, fp, ttl);
    } catch (RedisConnectionFailureException e) {
        idempotencyFallbackCounter.increment();
        log.error("冪等儲存不可用 scope={} key={}", scope, key, e);
        // ⚠️ 這裡的選擇：
        //   fail-open  → 失去冪等保護（但業務層的 UNIQUE 還在擋）
        //   fail-closed → 回 503，客戶端稍後重試
        // shop-service 選 fail-closed（因為業務層的 UNIQUE 只在部分表上有）
        throw new IdempotencyStoreUnavailableException();      // → 503 + Retry-After
    }
}
```

**這一題的核心教訓**：

> **「查詢 → 判斷 → 寫入」這個模式在併發環境下永遠是錯的。**
>
> 原始程式碼的 6 個嚴重問題，有 3 個（競態 1、2、3）都是這個模式造成的。
> 正確的做法一律是「**原子的插入或取得**」（`SET NX` / `INSERT` + `UNIQUE`），
> 讓資料庫或 Redis 幫你保證互斥。

</details>

### 練習 2：設計快取策略

為以下端點設計 `Cache-Control`、`ETag`、`Vary`。說明每個決定。

```
1.  GET /v1/products?categoryId=cat_1&page=0&size=20      公開，每天更新幾次
2.  GET /v1/products/{id}                                 公開，含價格與庫存
3.  GET /v1/products/{id}/inventory                       公開，庫存數量（秒級變動）
4.  GET /v1/categories                                    公開，分類樹，一個月改一次
5.  GET /v1/orders/{id}                                   私有，客服與顧客看到不同欄位
6.  GET /v1/me                                            私有，含 email/phone
7.  GET /v1/order-exports/{id}                            私有，輪詢端點（每 5 秒）
8.  GET /v1/openapi.yaml                                  公開，發版時更新
9.  GET /v1/deprecations                                  私有（含 yourUsage）
10. GET /v1/products/{id}/images/{imageId}                公開，圖片，內容不變
```

<details>
<summary>參考解答</summary>

| # | `Cache-Control` | `ETag` | `Vary` | 理由 |
|---|---|---|---|---|
| 1 | `public, max-age=300, stale-while-revalidate=60, stale-if-error=300` | ✅ Shallow | `Accept-Language` | 公開、變動不頻繁。`swr` 讓過期後仍瞬間回應。`stale-if-error` 讓後端掛掉時還能瀏覽 |
| 2 | `public, max-age=60, stale-while-revalidate=30, stale-if-error=60` | ✅ 版本號 | `Accept-Language` | ⚠️ **含價格與庫存 → TTL 要短**。`stale-if-error` 只給 60 秒（顯示舊價格有風險） |
| 3 | `public, max-age=5, must-revalidate` | ❌ | — | 庫存秒級變動。`max-age=5` 是「防雷擊」（同一秒的大量請求收斂成一次）。<br>`must-revalidate` 確保過期後不用舊值 |
| 4 | `public, max-age=3600, stale-while-revalidate=600, stale-if-error=86400` | ✅ Shallow | `Accept-Language` | 幾乎不變 → 長 TTL。`stale-if-error=1天`（分類樹的舊資料完全可接受） |
| 5 | `private, no-cache` | ✅ **版本 + locale + expand + viewerRole** | — | 🔴 `private` 必須（8.5.2）。<br>`no-cache` 而非 `no-store` → 可以有 `304` 省頻寬（訂單詳情 body 不小）。<br>⚠️ **`ETag` 必須含 `viewerRole`**，否則客服與顧客會互相拿到彼此的快取 |
| 6 | `private, no-store` | ❌ | — | 🔴 含 email/phone → 最保守。`no-store` 讓瀏覽器也不留磁碟副本 |
| 7 | `private, no-cache` | ✅ 工作狀態版本 | — | 輪詢端點 → `ETag` 價值最高（狀態沒變時回 `304`，body 0 bytes）。<br>⚠️ **不能 `max-age`**（會讓輪詢拿到舊狀態） |
| 8 | `public, max-age=600, stale-while-revalidate=300` | ✅ Shallow | — | 契約檔案。10 分鐘 TTL 讓 CI 頻繁拉取時不打源站 |
| 9 | `private, max-age=60` | ✅ | — | 含 `yourUsage`（私有）。60 秒足夠（用量統計不需要即時） |
| 10 | `public, max-age=31536000, immutable` | ✅（弱） | — | ★ 圖片 URL 含 `imageId`（內容不變）→ **一年 + `immutable`**。<br>`immutable` 讓瀏覽器連「重新整理時的驗證請求」都省掉 |

---

**十個決定的詳細說明**

**① 為什麼用 `stale-while-revalidate`**

```
沒有 swr：
  T=300s  快取過期 → 使用者等 200ms 拿新資料

有 swr=60：
  T=300s  快取過期 → 立刻回舊資料（0ms）+ 背景更新
  T=300s+ 下一個使用者拿到新資料
  → ★ 感知延遲從 200ms 變 0ms，代價是「可能看到 60 秒內的舊資料」
```

**② 為什麼 `/products/{id}` 的 TTL 比列表短**

```
列表：只顯示名稱、縮圖、價格區間 → 5 分鐘的舊資料可接受
詳情：顯示精確價格、庫存狀態、規格 → 舊價格會有客訴／法律問題
     → 1 分鐘
```

**③ `max-age=5` 對「秒級變動」的資料為什麼還有意義**

```
雙 11 的熱門商品：每秒 500 個請求查庫存
沒有快取：500 QPS 打到資料庫
max-age=5：CDN 每 5 秒打一次源站 → 0.2 QPS
→ ★ 減少 2500 倍，代價是「庫存數字可能舊 5 秒」

⚠️ 但下單時必須重新檢查庫存（不能信任快取的數字）
   → 這就是為什麼 POST /orders 會回 409 INSUFFICIENT_STOCK（第 04 章 4.13.3）
```

**④ `stale-if-error=86400` 對分類樹的價值**

```
後端全掛（第 05 章 5.2.1 的事故）
→ 分類樹用 24 小時內的舊資料
→ ★ 使用者仍能瀏覽網站（雖然無法下單）
→ 比「整站白畫面」好得多
```

**⑤ `viewerRole` 在 `ETag` 裡的必要性（★ 這題的重點）**

```java
// 🔴 錯誤：ETag 只用資料版本
String etag = "\"v" + order.getVersion() + "\"";

// 情境：
// 客服 A GET /orders/ord_1 → ETag "v7"（回應含 internalNotes、margin、fraudCheck）
// 顧客 B GET /orders/ord_1 + If-None-Match: "v7" → 304
//        → 🔴 B 的瀏覽器用了 A 的快取（含客服專屬欄位）

// ✅ 正確
String etag = new ETagSource(
        order.getVersion(),
        locale.toLanguageTag(),
        expands,
        viewerRole                 // ★ CUSTOMER / SUPPORT / SUPPORT_MANAGER
).toETag();
```

**⚠️ 但要注意：`private` 已經讓 CDN 不快取了，所以這個風險只存在於**：
- 同一個瀏覽器先後用不同角色登入（客服在自己電腦上登入自己的帳號測試）。
- 共用電腦。
- 應用程式內快取（8.5.2 風險 3）。

**機率不高，但後果是個資洩漏 → 值得付這個成本。**

**⑥ `/me` 為什麼是 `no-store` 而不是 `no-cache`**

```
no-cache：允許瀏覽器存在磁碟上（只是用前要驗證）
no-store：完全不存

/me 含 email、phone、地址 → 共用電腦上不該留在磁碟
→ no-store
```

**⚠️ 代價**：每次都完整傳輸（無法用 `304`）。
但 `/me` 的 body 很小（< 1KB）且呼叫頻率低 → 代價可接受。

**⑦ 輪詢端點的 `ETag` 是最高價值的應用**

```
匯出工作跑 3 分鐘，客戶端每 5 秒輪詢 → 36 次請求

沒有 ETag：36 × 完整 body（每次約 800 bytes）= 28.8 KB
有 ETag：  35 × 304（0 bytes）+ 1 × 800 bytes = 800 bytes
→ ★ 省 97%
```

**而且 GitHub 的做法值得抄：`304` 不計入限流配額**（第 02 章 2.16 練習 5）。
這讓「正確使用快取」和「拿到更多額度」綁在一起。

**⑧ 為什麼 `openapi.yaml` 需要快取**

```
CI 上每個 PR 都會拉契約（lint、diff、mock-smoke、SDK 產生檢查）
一天 50 個 PR × 4 次拉取 = 200 次
→ max-age=600 讓 CDN 擋掉大部分
```

**⑨ `/deprecations` 為什麼是 `private`**

```
回應含 yourUsage（這個 consumer 的用量統計）
→ 不同 consumer 看到不同內容
→ 必須 private
```

**⑩ `immutable` 的價值（最容易被忽略的一個）**

```
沒有 immutable：
  使用者按 F5 → 瀏覽器對所有資源發「驗證請求」（If-None-Match）
  → 100 張圖片 = 100 個 304 請求 → 仍有延遲

有 immutable：
  使用者按 F5 → 瀏覽器「完全不發請求」
  → ★ 0 個請求
```

**前提：URL 必須真的不變**（含 `imageId` 或內容雜湊）。
如果同一個 URL 的內容會變，`immutable` 會讓使用者永遠看到舊圖。

---

**必須配套的三件事**

**1. 全域的保守預設（8.3.3）**

```java
// 沒明確設定的端點一律保守處理
if (h.getCacheControl() == null) {
    h.setCacheControl(authenticated ? "private, no-store" : "no-store");
}
```

**2. CI 的洩漏掃描（8.5.5）**

```java
// 掃描所有需要認證的端點是否都有 private/no-store
if (authenticated && !cc.contains("private") && !cc.contains("no-store")) {
    throw new IllegalStateException("🔴 " + path + " 未設定 private");
}
```

**3. 快取污染的測試（8.5.2）**

```java
@Test
void 不同角色不會共用快取() throws Exception {
    String etagSupport = get("/v1/orders/ord_1", TOKEN_SUPPORT).getHeader("ETag");
    String etagCustomer = get("/v1/orders/ord_1", TOKEN_CUSTOMER).getHeader("ETag");

    assertThat(etagSupport).isNotEqualTo(etagCustomer);   // ★ ETag 必須不同

    // 顧客帶客服的 ETag → 不能回 304
    mockMvc.perform(get("/v1/orders/ord_1")
                    .header("Authorization", "Bearer " + TOKEN_CUSTOMER)
                    .header("If-None-Match", etagSupport))
            .andExpect(status().isOk());                  // ★ 200 而非 304
}
```

**這一題的核心教訓**：

> **快取策略沒有「通用答案」——每個端點的 TTL 取決於
> 「舊資料造成的傷害」與「不快取的成本」的權衡。**
>
> 而唯一的通用規則是：**需要認證的一律 `private`，錯誤一律 `no-store`，
> 沒明確設定的一律保守。**

</details>

### 練習 3：設計限流策略

你的 API 有以下 consumer 與用量（過去 30 天的觀察）：

```
consumer        端點類型      P50/分鐘  P95/分鐘  P99/分鐘  max/分鐘
shop-web        讀取            120       380       520      1,840（活動期間）
shop-web        搜尋             18        95       140        320
shop-web        寫入              8        35        60        180
shop-ios        讀取             45       180       240        890
vendor-a-erp    讀取（同步）    500       500       500        502（每 15 分鐘批次）
vendor-a-erp    匯出              0         0         1          2（每天 1~2 次）
vendor-b-erp    讀取             80       150       180        190
未識別          讀取              5        40       120      8,400（🔴 疑似爬蟲）
```

設計完整的限流策略。說明每個配額的推導。

<details>
<summary>參考解答</summary>

**步驟 1：先分類 consumer（決定「該不該保護他」）**

| Consumer | 分類 | 策略方向 |
|---|---|---|
| `shop-web` / `shop-ios` | **自家前端** | 🔴 **絕不能擋**（8.4.8 的教訓）→ 配額設得很寬鬆 |
| `vendor-a-erp` / `vendor-b-erp` | **合約 consumer** | 依合約給配額，且要能個別調整 |
| 未識別 | **可疑** | 🔴 嚴格限制 + 要求識別 |

**步驟 2：配額推導原則**

```
自家前端：    max × 1.5      （留活動期間的餘裕）
合約 consumer：合約值 × 1.2   （或協商的值）
未識別：      P99 × 1.5       （夠一般使用，擋掉爬蟲）
```

**⚠️ 為什麼自家前端用 `max` 而不是 `P99`**：

```
shop-web 讀取的 P99 = 520，max = 1,840（活動期間）
若設 P99 × 1.5 = 780
→ 🔴 下次活動時前端被自己擋掉（8.4.8 的事故重演）

設 max × 1.5 = 2,760
→ ✅ 活動期間也不會擋到
→ ⚠️ 代價：如果 shop-web 有 bug 造成無限迴圈，要 2,760 次/分才會被擋
   → 這個代價可接受（因為前端的 bug 會被前端的監控發現）
```

**步驟 3：完整配額表**

```yaml
rate-limit:
  enabled: true
  dry-run: false
  fallback: local
  expected-pod-count: 3

  # ── 桶定義（預設值，給未列在 overrides 的 consumer）────
  buckets:
    read:
      capacity: 200            # 桶容量（允許的爆發量）
      refill-per-minute: 200
      dimension: user
      algorithm: token-bucket
    search:
      capacity: 30
      refill-per-minute: 30
      dimension: user
      algorithm: token-bucket
    write:
      capacity: 60
      refill-per-minute: 60
      dimension: user
    expensive:               # include=totalCount / aggregates
      capacity: 10
      refill-per-minute: 10
      dimension: user
    export:
      capacity: 3
      refill-per-minute: 0.5   # 每 2 分鐘 1 個
      dimension: user
    notification:
      capacity: 3
      refill-per-minute: 0.5
      dimension: user
    auth:                    # 登入
      capacity: 5
      refill-per-minute: 1
      dimension: ip
      algorithm: sliding-window-log     # ★ 需要完全精確（防暴力破解）

  # ── Consumer 專屬配額 ─────────────────────────────
  consumer-overrides:

    # 自家前端：max × 1.5，寬鬆
    shop-web:
      read:      { capacity: 2760, refill-per-minute: 2760 }    # 1840 × 1.5
      search:    { capacity:  480, refill-per-minute:  480 }    # 320 × 1.5
      write:     { capacity:  270, refill-per-minute:  270 }    # 180 × 1.5
      expensive: { capacity:   60, refill-per-minute:   60 }
    shop-ios:
      read:      { capacity: 1340, refill-per-minute: 1340 }    # 890 × 1.5
      search:    { capacity:  300, refill-per-minute:  300 }
      write:     { capacity:  270, refill-per-minute:  270 }
    shop-android:
      read:      { capacity: 1340, refill-per-minute: 1340 }
      search:    { capacity:  300, refill-per-minute:  300 }
      write:     { capacity:  270, refill-per-minute:  270 }

    # 廠商 A：批次同步，用量穩定（500/分鐘）
    vendor-a-erp:
      read:   { capacity: 700, refill-per-minute: 600 }
      #        ↑ 容量 700 允許批次爆發   ↑ 速率 600 = 500 × 1.2
      export: { capacity: 5, refill-per-minute: 0.2 }           # 每 5 分鐘 1 個
      write:  { capacity: 30, refill-per-minute: 30 }

    # 廠商 B：用量較小
    vendor-b-erp:
      read:   { capacity: 250, refill-per-minute: 230 }         # 190 × 1.2
      export: { capacity: 3, refill-per-minute: 0.1 }

  # ── 未識別的 consumer（最嚴格）─────────────────────
  unidentified:
    dimension: ip                       # 沒有 consumer id → 只能用 IP
    read:      { capacity: 180, refill-per-minute: 180 }   # P99(120) × 1.5
    search:    { capacity:  10, refill-per-minute:  10 }
    write:     { capacity:  20, refill-per-minute:  20 }
    expensive: { capacity:   0 }        # ★ 完全禁止（未識別者不能用貴的操作）
    export:    { capacity:   0 }        # ★ 完全禁止
```

**步驟 4：處理「未識別 = 8,400/分鐘」的疑似爬蟲**

**這不是限流能單獨解決的問題，需要四層處理**：

```
① Nginx 層：IP 級的粗略限流（不進 JVM）
   limit_req_zone $binary_remote_addr zone=perip:10m rate=50r/s;
   limit_req zone=perip burst=100 nodelay;
   → 擋掉每秒 > 50 次的明顯攻擊

② 應用層：未識別 consumer 的嚴格配額（上面的 unidentified）
   → 180/分鐘 → 8,400 的爬蟲會在前 180 次後被擋

③ 要求識別（第 06 章 6.8.3）
   → 回應加上 Warning header：
     Warning: 299 - "Requests without X-Client-Id will be restricted from 2026-11-01"
   → 給 90 天過渡期，之後未帶 X-Client-Id 的請求配額降到 30/分鐘

④ 調查那 8,400 次是誰
   - 用 token 反查（如果有帶 Authorization）
   - 分析 User-Agent（python-requests? Scrapy? 空的？）
   - 分析呼叫模式（是否在遍歷 /products/{id}？）
   - 若是善意的爬蟲（比價網站）→ 主動聯絡，給他們正式的 API key + 合理配額
   - 若是惡意的 → WAF 封鎖 + 考慮加 CAPTCHA
```

**⚠️ 第 ④ 步最重要**：8,400 次/分鐘的用量，如果是**比價網站**，
封鎖他們可能損失流量來源。**先調查再封鎖。**

**步驟 5：`vendor-a-erp` 的特殊處理（★ 這題的技術重點）**

```
用量特徵：每 15 分鐘一次批次，每次 500 次請求（在 1 分鐘內打完）
```

**如果用「500/分鐘」的令牌桶會怎樣？**

```
T=0:00   桶滿（500 個令牌）
T=0:00~0:50  廠商打 500 次 → 剛好用完 ✅
T=0:50~15:00 桶慢慢補回 500 個
T=15:00  下一批 500 次 → ✅
→ 剛好可以，但沒有任何餘裕
→ 若廠商某次多打 10 次（重試）→ 🔴 被擋
```

**修正：容量給 700（爆發餘裕），速率給 600**

```yaml
vendor-a-erp:
  read: { capacity: 700, refill-per-minute: 600 }
```

```
T=0:00   桶有 700 個令牌
T=0:00~0:50  打 500 次（含重試最多 550）→ ✅ 還剩 150
T=15:00  桶早就補滿 700 → ✅
→ 有 200 次的餘裕
```

**這示範了令牌桶的核心價值**：**容量（爆發）和速率（平均）可以分開設定。**

```
固定窗口／滑動窗口：只能設「每分鐘 N 次」→ 無法表達「平常慢，偶爾爆發」
令牌桶：容量 = 爆發量，速率 = 長期平均 → ★ 精確描述批次型的使用模式
```

**步驟 6：加權扣費（處理「貴的操作」）**

```yaml
cost-modifiers:
  include-total-count: +10       # 精確 count（第 05 章 5.6）
  include-aggregates:  +10
  has-query:            +3       # 搜尋（走全文索引）
  per-expand:           +2       # 每個 expand（可能觸發 batch loading）
  size-over-50:         +2
  idempotent-replay:    -0.5     # 回放較便宜
  retry-after-5xx:      -0.5     # 我們的錯造成的重試半價（8.5.1）
```

**實際效果**：

```
GET /orders?page=0&size=20                          → read 桶，cost 1
GET /orders?q=王小明                                 → search 桶，cost 1
GET /orders?include=totalCount                      → expensive 桶，cost 1
GET /orders?expand=items,payments&size=100          → read 桶，cost 1+2+2+2 = 7
```

**⚠️ 注意 `expensive` 桶的容量只有 10** ——
所以「精確 count」一分鐘最多 10 次。這是刻意的（第 05 章 5.6.3）。

**步驟 7：上線流程（★ 最重要的一步）**

```
Week 1-2  dry-run = true
          → 只記錄「若非 dry-run 會被拒絕」的請求
          → 檢查：有任何 shop-web / shop-ios / vendor-* 會被拒絕嗎？
          → 若有 → 調高配額，重跑一週

Week 3    對「未識別」的 consumer 啟用（風險最低）
          → 觀察 3 天：有沒有正常使用者被誤殺？（看客服工單）

Week 4    對廠商啟用（已事先通知，且配額有 1.2 倍餘裕）
          → 通知內容要包含：配額值、如何查詢剩餘量（RateLimit-Remaining）、
            超限的回應格式、建議的重試策略

Week 5    對自家前端啟用（配額最寬鬆，風險最低）

Week 6+   持續調整
          → 每月檢視各桶的拒絕率
          → search 拒絕率 > 2% → 考慮放寬或優化搜尋效能
```

**步驟 8：必須有的監控與告警**

```yaml
# 🔴 最重要的一條：自家前端被限流
- alert: OwnClientRateLimited
  expr: |
    sum by (consumer, bucket) (
      rate(api_rate_limit_rejected_total{consumer=~"shop-web|shop-ios|shop-android"}[5m])
    ) > 0.1
  for: 5m
  labels: { severity: critical, team: platform }
  annotations:
    summary: "🔴 自家前端 {{ $labels.consumer }} 被限流（桶 {{ $labels.bucket }}）"
    description: "這幾乎一定是配額設定錯誤或前端沒節流，不是攻擊。請立刻檢查。"
    runbook: "https://wiki/runbooks/own-client-rate-limited"

# 廠商被限流（可能是合約需要調整）
- alert: VendorRateLimited
  expr: |
    sum by (consumer) (rate(api_rate_limit_rejected_total{consumer=~"vendor-.*"}[15m])) > 0.05
  for: 30m
  labels: { severity: warning, team: partnerships }
  annotations:
    summary: "廠商 {{ $labels.consumer }} 持續被限流 —— 可能需要調整配額或協助他們優化"

# 未識別流量暴增（可能是新的爬蟲）
- alert: UnidentifiedTrafficSpike
  expr: |
    sum(rate(api_requests_total{consumer="unidentified"}[10m])) > 100
  for: 15m
  labels: { severity: warning, team: security }

# Redis 降級（限流器失效）
- alert: RateLimiterDegraded
  expr: rate(rate_limiter_fallback_total[5m]) > 0
  for: 5m
  labels: { severity: critical }
  annotations:
    summary: "限流器降級為本機模式 —— Redis 可能有問題，配額不再精確"

# 某個桶的拒絕率過高（配額可能太緊）
- alert: BucketRejectionRateHigh
  expr: |
    sum by (bucket) (rate(api_rate_limit_rejected_total[30m]))
      / sum by (bucket) (rate(api_requests_total[30m])) > 0.05
  for: 1h
  labels: { severity: info }
  annotations:
    summary: "桶 {{ $labels.bucket }} 拒絕率 > 5% —— 考慮放寬配額或優化該類操作的效能"
```

---

**這一題的四個核心教訓**

| # | 教訓 |
|---|---|
| 1 | **配額要從實際用量推導，不是憑感覺設「每分鐘 100 次」。** 沒有 30 天的用量數據，任何配額都是猜的 |
| 2 | **自家前端用 `max × 1.5`，不是 `P99`。** 活動期間的尖峰是 P99 的 3.5 倍 |
| 3 | **令牌桶的「容量 ≠ 速率」是處理批次型 consumer 的關鍵。** `vendor-a` 需要容量 700 但速率只要 600 |
| 4 | **「未識別 8,400 次」要先調查再封鎖。** 可能是比價網站（有價值的流量），封鎖會損失營收 |

**還有一個貫穿全部的原則**：

> **限流的第一個受害者是自己。** 所以流程一定是
> **dry-run → 未識別 → 廠商 → 自家前端**（風險由低到高），
> 而不是「一次全開」。

</details>

### 練習 4：診斷交互作用造成的事故

```
事故報告：
14:02  監控告警：/v1/orders 的 P99 從 80ms 升到 4.2s
14:03  429 錯誤率從 0.01% 升到 18%
14:04  客服接到「訂單頁載入很慢」與「一直說操作太頻繁」的投訴
14:05  值班工程師查看：資料庫 CPU 92%，連線池 20/20 滿載
14:08  發現大量重複的 POST /v1/orders 請求（同一個 customerId，每秒 3~5 次）
14:12  緊急封鎖該 customerId 後恢復

事後調查發現：
- 該使用者是一個 vendor 的測試腳本，在測試「訂單建立」
- 腳本沒有帶 Idempotency-Key
- 腳本收到 504 就立刻重試（沒有退避）
- 每次重試都建立了一張新訂單（14:02~14:12 共建立 2,847 張測試訂單）
- 該 vendor 的 read 配額是 500/分鐘，write 配額是 30/分鐘
- 但腳本大部分請求收到的是 504（不是 429）
```

請分析：這個事故暴露了本章三個機制的哪些設計缺陷？

<details>
<summary>參考解答</summary>

**先建立完整的因果鏈**

```
① 腳本沒帶 Idempotency-Key
   → POST /orders 沒有冪等保護（但這個端點在 8.2.2 列為「必填」！）
   ↓
② 訂單建立本身有點慢（涉及庫存檢查、價格計算、多表寫入）
   → 在資料庫已有負載時，超過某個閾值就會超時
   ↓
③ 腳本收到 504 立刻重試（無退避、無抖動）
   → 每秒 3~5 次
   ↓
④ 每次重試都真的建立了一張訂單
   → 資料庫寫入壓力累積
   ↓
⑤ 資料庫變慢 → 更多請求超時 → 更多重試
   → 🔴 正回饋迴圈（重試風暴）
   ↓
⑥ 連線池滿載 → 其他使用者的請求也拿不到連線
   → 全站變慢（P99 4.2s）
   ↓
⑦ 為什麼收到 504 而不是 429？
   → 🔴 這是關鍵問題（見缺陷 3）
```

---

**缺陷 1：`Idempotency-Key` 的「必填」沒有真的強制**

**規格說必填（8.2.2），但實際上腳本沒帶也能執行 → 規格沒被實作。**

```java
// ❌ 可能的實作（選填）
String key = req.getHeader("Idempotency-Key");
if (key != null) { /* 冪等處理 */ }
chain.doFilter(req, res);        // 沒帶就直接放行

// ✅ 應該的實作
if (isBlank(key) && policy.isRequired(req)) {
    writeProblem(res, IDEMPOTENCY_KEY_REQUIRED);      // → 400
    return;
}
```

**如果這一行有實作，整個事故不會發生** ——
腳本第一個請求就會收到 `400` + `hint`（8.2.2），開發者立刻知道要加 key。

**修正**：

| 動作 | 說明 |
|---|---|
| 實作必填檢查 | 8.2.6 |
| ⚠️ **但這是破壞性變更**（第 06 章 6.3.1） | 現有 consumer 沒帶就會壞 |
| 所以要走遷移流程 | ① dry-run（只記錄 + `Warning` header）② 通知 ③ 90 天後強制 |
| 加測試 | 「必填端點沒帶 key 時必須回 400」（第 09 章 9.4） |

**⚠️ 這裡有一個諷刺**：因為「加上必填檢查」是破壞性變更，
所以你**不能立刻修好它** —— 這正是第 06 章強調「一開始就要對」的理由。

---

**缺陷 2：`504` 的 `retryable` 標示錯誤**

```
腳本收到 504 就立刻重試 → 說明我們的 504 回應標了 retryable: true
但這個端點沒有冪等鍵 → 重試是不安全的（第 04 章 4.9.4）
```

**這是第 04 章 4.9.4 明確警告過的情況**：

```jsonc
// ❌ 事故時的回應（推測）
{
  "code": "GATEWAY_TIMEOUT",
  "status": 504,
  "retryable": true,                    // 🔴 但沒有冪等鍵，重試不安全！
  "retryAfterSeconds": 1                // 🔴 而且太短
}

// ✅ 應該的回應（沒有冪等鍵時）
{
  "type": "https://api.shop.example/problems/order-outcome-unknown",
  "code": "ORDER_OUTCOME_UNKNOWN",
  "status": 504,
  "title": "訂單建立結果未知",
  "detail": "The request timed out. The order may or may not have been created.",
  "userMessage": "訂單處理中，請查詢訂單列表確認結果。請勿重複送出。",
  "retryable": false,                   // ★ 不可重試
  "retryStrategy": "CHECK_STATUS",      // ★ 去查狀態
  "statusCheckUrl": "/v1/orders?createdFrom=2026-08-19T14:00:00Z",
  "recommendedCheckAfterSeconds": 10,
  "hint": "若要能安全重試，請在請求中帶 Idempotency-Key。",
  "traceId": "..."
}
```

**修正**：`retryable` 必須依「這個請求有沒有冪等鍵」動態決定。

```java
public ApiProblem timeoutProblem(HttpServletRequest req) {
    boolean idempotent = req.getHeader("Idempotency-Key") != null
                         || isIdempotentMethod(req.getMethod());
    return ApiProblem.builder()
            .status(504)
            .code(idempotent ? "GATEWAY_TIMEOUT" : "ORDER_OUTCOME_UNKNOWN")
            .retryable(idempotent)                            // ★ 動態
            .retryStrategy(idempotent ? BACKOFF_AND_RETRY : CHECK_STATUS)
            .retryAfterSeconds(idempotent ? jitteredBackoff() : null)
            .hint(idempotent ? null : "若要能安全重試，請帶 Idempotency-Key。")
            .build();
}
```

**這是一個很重要的洞察**：

> **`retryable` 不是端點的靜態屬性，而是「這一次請求」的屬性。**
> 同一個 `504`，帶了冪等鍵就可以重試，沒帶就不行。

---

**缺陷 3：🔴 限流的桶對映錯誤（這是最關鍵的缺陷）**

```
問題：腳本每秒 3~5 次 POST /orders
      write 配額是 30/分鐘 = 0.5/秒
      → 應該在 1 分鐘內就被 429 擋住
      → 但實際上腳本收到的是 504，不是 429
```

**為什麼 429 沒有生效？三個可能原因**：

**原因 A：限流在超時之後才檢查**

```
❌ 錯誤的 Filter 順序
Request → [業務處理（超時 30 秒）] → [限流檢查] → Response
                    ↑ 已經消耗了資源

✅ 正確的順序
Request → [限流檢查] → [業務處理] → Response
            ↑ 先擋掉
```

```java
// ★ 限流 Filter 必須在最前面
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 50)     // TraceId(100) → RateLimit(50)... 等等
public class RateLimitFilter extends OncePerRequestFilter { }
```

⚠️ 注意 Spring 的 `@Order` 是**數字小的先執行**，所以：

```
TraceIdFilter      @Order(HIGHEST_PRECEDENCE)        ← 最先（要有 traceId）
RateLimitFilter    @Order(HIGHEST_PRECEDENCE + 10)   ← 第二（盡早擋掉）
IdempotencyFilter  @Order(HIGHEST_PRECEDENCE + 100)  ← 第三
Security filters   ...
```

**⚠️ 但這裡有個兩難**：限流要按 `consumer` 分維度，
而 `consumer` 要等**認證之後**才知道 → 認證 filter 在限流之後怎麼辦？

**解法：兩段式限流**

```
第 1 段（認證前）：按 IP 的粗略限流
   → 擋掉明顯的攻擊，成本極低
第 2 段（認證後）：按 consumer 的精細限流
   → 在 Security filter chain 之後
```

**原因 B：桶對映漏了這個端點**

```yaml
endpoint-buckets:
  "GET /v1/orders":     read
  "POST /v1/orders":    write        # ← 有沒有這一行？
  default:              read         # 🔴 若漏了，POST /orders 會落到 read 桶（500/分鐘）
```

**若 `POST /orders` 落到 `read` 桶**：

```
配額 500/分鐘 = 8.3/秒
腳本每秒 3~5 次 → ✅ 在配額內 → 不會被擋
→ 🔴 這完美解釋了「為什麼收到 504 而不是 429」
```

**這幾乎確定是根因。**

**修正**：

```yaml
endpoint-buckets:
  # ★ default 改成「拒絕未對映的端點」而不是「落到 read」
  default: UNMAPPED_ENDPOINT_ERROR
```

```java
// 啟動時檢查：所有端點都必須有明確的桶對映
@EventListener(ApplicationReadyEvent.class)
void verifyAllEndpointsMapped(RequestMappingHandlerMapping mapping) {
    List<String> unmapped = mapping.getHandlerMethods().keySet().stream()
            .flatMap(info -> info.getPathPatternsCondition().getPatterns().stream())
            .map(PathPattern::getPatternString)
            .filter(p -> !rateLimitProperties.hasBucketFor(p))
            .toList();

    if (!unmapped.isEmpty()) {
        // ★ 啟動失敗，而不是靜默落到 default
        throw new IllegalStateException(
                "以下端點沒有限流桶對映，請在 rate-limit.endpoint-buckets 中設定：\n  "
                + String.join("\n  ", unmapped));
    }
}
```

**「啟動失敗」比「靜默用 default」好** ——
它讓「忘記設定」變成部署時就發現的問題，而不是事故時才發現。

**原因 C：dry-run 忘記關掉**

```yaml
rate-limit:
  dry-run: true      # 🔴 上線後忘記改成 false
```

**這是很常見的疏失。修正：加啟動檢查**

```java
@EventListener(ApplicationReadyEvent.class)
void warnIfDryRunInProduction(Environment env) {
    if (rateLimitProperties.isDryRun() && env.matchesProfiles("prod")) {
        log.error("🔴🔴 限流器處於 DRY-RUN 模式但 profile 是 prod！限流完全沒有生效！");
        // 選項：直接啟動失敗（更安全）
        throw new IllegalStateException("正式環境不可使用 rate-limit.dry-run=true");
    }
}
```

---

**缺陷 4：沒有偵測「重複建立」的業務層防護**

**即使沒有冪等鍵，2,847 張「同一個使用者、內容幾乎相同、10 分鐘內」的訂單
也應該被業務規則擋住。**

```java
// 業務層的防刷檢查（第 02 章 2.2.4 解法 C 的正確用法）
@Component
public class OrderVelocityGuard {

    public void check(String customerId, CreateOrderRequest req) {
        // ★ 這不是取代冪等鍵，是「額外的安全網」
        int recentCount = repo.countByCustomerIdAndCreatedAtAfter(
                customerId, Instant.now().minusSeconds(60));

        if (recentCount >= 10) {
            throw new OrderVelocityExceededException(recentCount, 10, Duration.ofSeconds(60));
        }
    }
}
```

```jsonc
{
  "type": "https://api.shop.example/problems/order-velocity-exceeded",
  "title": "訂單建立過於頻繁",
  "status": 429,
  "code": "ORDER_VELOCITY_EXCEEDED",
  "detail": "10 orders were created in the last 60 seconds; the limit is 10.",
  "userMessage": "訂單建立過於頻繁，請稍後再試。若您需要大量下單，請聯絡客服。",
  "recentCount": 10,
  "limit": 10,
  "windowSeconds": 60,
  "retryable": true,
  "retryAfterSeconds": 60,
  "hint": "若這是自動化整合，請確認您帶了 Idempotency-Key 並使用指數退避重試。",
  "traceId": "..."
}
```

**⚠️ 這個檢查會誤殺「真的要下 10 張單」的使用者**（企業採購）。
所以要：
- 閾值設寬鬆一點（10/分鐘對一般使用者足夠）。
- 提供白名單（企業帳號可調高）。
- `userMessage` 給出「聯絡客服」的出口。

---

**缺陷 5：連線池沒有隔離（艙壁）**

```
POST /orders 的慢查詢佔滿 20 個連線
→ GET /orders/{id} 也拿不到連線
→ 🔴 一個端點拖垮全部
```

**修正：不同類型的操作用不同的連線池（艙壁模式，8.6）**

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20            # 主池（讀取）
      connection-timeout: 2000
---
# 寫入用獨立的池
app:
  datasource:
    write:
      maximum-pool-size: 8             # ★ 寫入最多佔 8 條
      connection-timeout: 3000
    export:
      maximum-pool-size: 2             # ★ 匯出最多佔 2 條（慢查詢隔離）
      connection-timeout: 30000
```

**效果**：即使寫入全部卡住（8 條），讀取仍有 20 條可用 → **降級而不是全掛**。

---

**完整的修正清單（按優先序）**

| 優先 | 修正 | 為什麼這個順序 |
|---|---|---|
| **P0** | 修正桶對映（`POST /orders` → `write` 桶）+ 啟動檢查未對映端點 | 🔴 這是根因，而且改一行設定就好 |
| **P0** | 確認 `dry-run: false` + 加啟動檢查 | 一行設定 |
| **P0** | 限流 Filter 移到最前面（兩段式） | 讓限流在資源被消耗前生效 |
| **P1** | `504` 的 `retryable` 依冪等鍵動態決定 | 防止「不安全的重試」 |
| **P1** | 加業務層的 velocity guard | 安全網（即使冪等鍵沒帶） |
| **P1** | 連線池艙壁隔離 | 防止單一端點拖垮全站 |
| **P2** | 實作 `Idempotency-Key` 必填（走 90 天遷移流程） | 破壞性變更，需要時間 |
| **P2** | 加告警：「單一 consumer 的 write 用量暴增」 | 下次能提早發現 |
| **P2** | 清理那 2,847 張測試訂單 | 資料清理 |
| **P3** | 通知 vendor 修正腳本（加冪等鍵 + 退避） | 從源頭解決 |

---

**這一題的核心教訓**

> **這個事故的每一個機制「單獨看都有設計」，但合起來失效了：**
>
> - 冪等鍵：規格說必填，**但沒實作** → 形同不存在
> - 限流：有 write 桶 30/分鐘，**但桶對映漏了** → 落到 read 桶 500/分鐘
> - 重試語意：有 `retryable`，**但標錯了** → 鼓勵了不安全的重試
> - 三者的交互：`504` + `retryable: true` + 限流沒生效 = 重試風暴
>
> **這正是 8.5「三者的交互作用」要處理的問題：
> 每個機制都要「假設其他機制可能失效」。**
>
> 具體做法：
> - 限流失效 → 業務層有 velocity guard
> - 冪等鍵沒帶 → 業務表有 UNIQUE 約束（8.2.4）+ `retryable: false`
> - 慢查詢 → 連線池艙壁隔離
>
> **每一層都是別人的安全網。**

</details>

---

## 8.10 驗收清單

- [ ] 我能完整定義冪等鍵的語意（相同 key + 相同內容 / 相同 key + 不同內容 / 不同 key）。
- [ ] 我知道哪些端點必填冪等鍵，並能說出判準（「重複執行會不會出事」）。
- [ ] 我能說出冪等記錄要存的九個欄位，特別是 `requestFingerprint` 與 `responseStatus`。
- [ ] 我知道 Redis 與 MySQL 儲存的取捨，特別是「能否與業務交易同一個交易」。
- [ ] 我能說出冪等鍵的三個競態條件，並知道解法一律是「原子的插入或取得」。
- [ ] 我知道 `IN_PROGRESS` 必須有逾時接手機制，且接手要用 CAS（`AND created_at = ?`）。
- [ ] 我知道「執行成功但記錄失敗」要靠業務表的 UNIQUE 約束當第二道防線。
- [ ] 我知道請求指紋**必須**正規化 JSON（物件 key 排序、數值標準化），否則客戶端重試會被誤判。
- [ ] 我知道陣列順序**不該**正規化（順序可能有語意），並要在文件明說。
- [ ] 我知道 `5xx` / `408` / `429` **不能**記錄為冪等結果，否則暫時性錯誤會被永久回放。
- [ ] 我知道 `ContentCachingRequestWrapper` 的三個坑（要主動讀完、大 body 佔記憶體、要傳 wrapper 給下游）。
- [ ] 我能說出回放該回 `200` + `Idempotent-Replay` 的理由（避免客戶端重複計數事件）。
- [ ] 我知道客戶端的 key 必須持久化（`sessionStorage`），否則 F5 就失去保護。
- [ ] 我知道冪等鍵要監控四個指標，特別是「指紋不符」任何非零值都值得查。
- [ ] 我能區分快取的「新鮮度」與「驗證」兩種機制，並知道兩者該併用。
- [ ] 我能精確說出 `no-cache`（可存但要驗證）與 `no-store`（不可存）的差別。
- [ ] 我知道需要認證的端點一律 `private`，且應該用「預設保守 + 明確覆寫」的方向。
- [ ] 我知道 `ETag` 必須涵蓋資料版本 + `locale` + `expand` + **viewer 角色**。
- [ ] 我知道「先查版本再決定要不要查完整資料」才能讓 `ETag` 省下資料庫成本。
- [ ] 我知道 `ShallowEtagHeaderFilter` 不省後端運算、佔記憶體、不能串流。
- [ ] 我能列出 `Vary` 的完整清單，也知道 `Vary: Authorization` 為什麼危險。
- [ ] 我知道 `Vary` 過多會讓快取項目組合爆炸，以及三種降低基數的手法。
- [ ] 我知道 `stale-while-revalidate` 與 `stale-if-error` 的價值，也知道價格／庫存不該用後者。
- [ ] 我知道**錯誤回應一律 `no-store`**，否則 `409 庫存不足` 會被快取。
- [ ] 我能說出限流的四個不同目的，也知道混用它們是設計錯誤。
- [ ] 我能比較五種限流演算法，並說出固定窗口的邊界爆發問題。
- [ ] 我知道令牌桶的「容量 ≠ 速率」是處理批次型 consumer 的關鍵。
- [ ] 我能寫出 Redis + Lua 的原子令牌桶，並知道為什麼必須用 Lua。
- [ ] 我知道 IP 限流的三個坑，特別是 `X-Forwarded-For` 可被偽造（要設 `internal-proxies`）。
- [ ] 我能設計多桶 + 加權扣費的限流，並說出「按操作成本分級」讓系統降級而不是全掛。
- [ ] 我知道 `Retry-After` 是正式標準、`RateLimit-*` 是 draft，也知道 `Reset` 的單位有兩種慣例。
- [ ] 我知道未超限時也要回 `RateLimit-Remaining`，讓客戶端主動節流。
- [ ] 我知道分散式限流的三個問題（時鐘偏差、Redis 掛掉、熱鍵）及其解法。
- [ ] 我知道 Redis 掛掉要 **fail-open + 本機備援**，且必須有告警。
- [ ] 我知道限流上線必須先 dry-run 一週，且順序是「未識別 → 廠商 → 自家前端」。
- [ ] 我知道「自家前端被限流」和「外部攻擊被限流」必須分開告警。
- [ ] 我知道 `429` 在前端應該「靜默等待 + 自動重試」，不是顯示紅色錯誤。
- [ ] 我能說出重試風暴的四道防線，包含「伺服器端的 `Retry-After` 就加抖動」。
- [ ] 我知道快取 + 授權的四個風險，特別是「應用程式內快取的鍵漏了使用者維度」。
- [ ] 我知道「把授權移到快取外」要注意自呼叫問題。
- [ ] 我能寫出「不同角色不會共用快取」的測試。
- [ ] 我知道 `retryable` 不是端點的靜態屬性，而是「這一次請求有沒有冪等鍵」的屬性。
- [ ] 我知道限流 Filter 必須在最前面，也知道「按 consumer 限流需要認證後」造成的兩段式設計。
- [ ] 我知道桶對映要有啟動檢查（未對映的端點應該讓啟動失敗，不是靜默用 default）。
- [ ] 我完成了 shop-service 的冪等、快取、限流完整規格與 2 個新錯誤碼（另有 4 個是補完第 04 章既有碼的擴充欄位）。

---

完成後請前往 [09-api-testing-and-collaboration.md](./09-api-testing-and-collaboration.md)。
