# 第 01 章：Key 設計、TTL 與過期機制

> Redis 沒有 schema、沒有 table、沒有查詢優化器。你唯一能拿到資料的方式，就是**知道那個 key 叫什麼**。
> 所以 key 設計在 Redis 裡的地位，等同於關聯式資料庫的表結構設計加索引設計——但因為它不需要 `CREATE TABLE`，幾乎沒人認真設計它，結果就是三個月後沒人知道 `u:1001:c` 是什麼，記憶體漲了也不知道是誰漲的。
> 這章處理三件被嚴重低估的事：key 怎麼命名、TTL 到底何時生效、以及為什麼你絕對不能在生產環境打 `KEYS *`。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 設計一套可讀、可歸類、可排查的 key 命名規範。
- 說明 key 數量與長度對記憶體的實際影響。
- 完整掌握 `SET` 的所有選項，並知道哪些選項會意外清掉 TTL。
- 說明 Redis 的 key 過期是「惰性刪除 + 週期刪除」的組合，而不是準時觸發。
- 解釋為什麼過期的 key 可能還佔著記憶體，以及從節點的過期行為為何不同。
- 用 `SCAN` 安全地遍歷 key，並說明它提供與不提供什麼保證。
- 知道 `DEL` 和 `UNLINK` 的差別，以及什麼時候必須用後者。

---

## 1.2 為什麼 key 設計是 Redis 的第一課

先看一個真實會發生的場景。你接手一個專案，`redis-cli --bigkeys` 跑出來看到這些 key：

```text
u:1001
u:1001:c
sess_1001
cache_user_1001
temp
lock1
list
data:v2:user:1001:profile
```

你能回答這些問題嗎：

- `u:1001` 和 `cache_user_1001` 是同一份資料嗎？誰在寫？
- `temp` 是哪個功能的暫存？可以刪嗎？
- `data:v2:user:1001:profile` 的 `v2` 是什麼版本？`v1` 還有人在用嗎？
- 記憶體漲了 3GB，是哪個業務造成的？

答不出來的原因不是你不熟悉專案，而是**這些 key 從命名上就不帶任何可追溯資訊**。

在關聯式資料庫裡，你有 `information_schema` 可以查有哪些表、每張表多大。Redis 沒有這種東西——它只有一個扁平的 key 空間。所以 key 名稱本身，就是你唯一的元資料。

心智模型：

```text
關聯式資料庫：schema 是寫在資料庫裡的，你可以查
Redis：      schema 是寫在 key 名稱裡的，而且只存在於你的腦袋和文件裡

=> key 命名規範不是「風格偏好」，是唯一的自我描述機制
```

---

## 1.3 命名規範：用冒號分層

業界慣例是用冒號 `:` 分隔層級，模擬一個命名空間。推薦的結構是：

```text
<業務域>:<物件>:<識別碼>[:<屬性>]
```

實際例子：

```bash
# 商品快取
product:detail:1001
product:stock:1001

# 使用者
user:profile:1001
user:session:abc123def456
user:permission:1001

# 訂單
order:detail:8888
order:status:8888

# 排行榜（帶時間維度）
rank:sales:daily:2026-08-13
rank:sales:weekly:2026-W33

# 計數器
counter:article:views:2024
counter:api:calls:user:1001

# 鎖（用途要一眼看出）
lock:order:pay:8888
lock:job:daily-report

# 限流
ratelimit:ip:1.2.3.4:minute
```

這樣命名的好處很具體：

**可以用 pattern 歸類統計。** 想知道商品快取佔多少記憶體，`SCAN` 配 `MATCH product:*` 就能掃出來（第 1.9 節會說怎麼安全地做）。如果命名混亂，你連「哪些 key 屬於這個功能」都無法界定。

**RedisInsight 會自動用冒號做樹狀分組。** `product:detail:1001` 會被折疊在 `product` → `detail` 底下，瀏覽時直觀很多。

**出事時能快速定位責任。** 記憶體突然漲了，看 key 前綴就知道是哪個業務。

### 幾個實務上的細節

**環境前綴：靠設定，不要靠 key。** 有人會寫成 `prod:user:1001`、`dev:user:1001` 來隔離環境。不建議——這會讓所有 key 變長，而且一旦有人漏加前綴就會污染正式資料。正確做法是**用不同的 Redis 實例**，退一步至少用不同的 db 編號（見第 1.10 節）。

**多服務共用一個 Redis 時，前綴要帶服務名。** 例如 `svc-order:...`、`svc-user:...`。否則兩個團隊都用 `user:1001` 存不同結構，就會互相覆蓋。

**要改資料結構時，用版本號做灰度。** 例如快取格式從 JSON 換成 MessagePack：

```bash
user:profile:1001      # 舊格式，還在服役
user:profile:v2:1001   # 新格式，新版程式讀寫這個
```

新舊並存一段時間，等舊 key 因 TTL 自然消失，再清掉相關程式碼。**千萬不要直接改寫同一個 key 的格式**——部署期間新舊程式同時在跑，會互相讀到對方看不懂的資料。

### 要避免的命名

| 反例 | 問題 |
|------|------|
| `u:1001`、`p:1` | 為省幾個 byte 犧牲可讀性，省下的記憶體遠小於維護成本 |
| `temp`、`data`、`list`、`cache` | 完全沒有資訊，也極容易和別人撞名 |
| `user-profile-1001` | 用連字號無法被工具做層級分組 |
| `user:profile:張小明` | 用可變的中文名當識別碼，改名就找不到，且編碼容易出錯 |
| `user:1001:profile:2026:08:13:14:30:00:detail` | 過度分層，key 太長，也難以用 pattern 匹配 |
| 帶空格或換行的 key | 技術上合法，但在 CLI 和腳本裡處理起來很痛苦 |

一句原則：**key 應該讓一個沒寫過這段程式的同事，看名字就能猜出它是什麼。**

---

## 1.4 key 的數量與長度，代價是多少

Redis 允許 key 最長 512MB（value 也是），但這不代表你該用長 key。

**每個 key 的固定開銷。** 除了 key 字串本身，Redis 還要為每個 key 存 dict entry、`robj` 物件頭、以及過期字典的 entry（如果設了 TTL）。實務上每個 key 的額外開銷大約在數十到上百 bytes 之間，取決於版本與編碼。

這意味著：

```text
存 1000 萬個 key，即使每個 value 只有 10 bytes
=> value 本身約 100MB
=> 但實際記憶體佔用可能是 1GB 以上

key 的「數量」比「單個大小」更值得注意
```

**key 長度的影響是線性的但不劇烈。** 把 `user:profile:1001`（17 bytes）縮成 `u:p:1001`（8 bytes），單個省 9 bytes；一千萬個 key 省 90MB。聽起來不少，但代價是整套 key 完全不可讀。

實務建議：

- **不要為了省記憶體犧牲可讀性**，除非你的 key 數量真的在千萬級以上，且已經確認 key 名稱是記憶體瓶頸。
- **真正該優化的是 key 的數量**，方法通常是「把多個小 key 合併成一個 Hash」。例如一千萬個 `user:name:{id}`、`user:age:{id}`、`user:city:{id}`，改成一千萬個 `user:{id}` 的 Hash（三個 field），key 數量直接少三分之二，而且小 Hash 用 listpack 編碼還特別省記憶體。第 05 章會實測這個差異。

用 `MEMORY USAGE` 可以看單個 key 的實際佔用：

```bash
SET user:profile:1001 "{\"name\":\"Alice\"}"
MEMORY USAGE user:profile:1001
# (integer) 72   <- 包含 key、value、物件頭的總開銷
```

注意這個數字比你的 value 長度大很多，這就是固定開銷。

---

## 1.5 `SET` 的完整語意：比你想的複雜

大部分人只用 `SET key value`，但 `SET` 有一組選項，用對可以少寫很多程式。

```bash
SET key value [NX | XX] [GET] [EX s | PX ms | EXAT ts | PXAT ts | KEEPTTL]
```

### `NX` 與 `XX`：存在性條件

```bash
SET lock:order:8888 "worker-3" NX     # 只在 key 不存在時設定 -> 分散式鎖的基礎
SET user:session:abc "..." XX          # 只在 key 已存在時設定 -> 「續期但不新建」
```

`NX` 成功回 `OK`，失敗回 `(nil)`。這個原子性是分散式鎖能成立的根本（第 10 章）。

### `EX` / `PX` / `EXAT` / `PXAT`：過期時間

```bash
SET product:1001 "..." EX 300      # 300 秒後過期
SET product:1001 "..." PX 300000   # 300000 毫秒後過期（等價）
SET product:1001 "..." EXAT 1786000000  # 在指定 Unix 秒級時間戳過期
```

`EXAT` / `PXAT`（6.2+）在「所有 key 要同時失效」的場景很有用，例如活動結束時間固定。

**強烈建議用 `SET key value EX n`，而不是 `SET` 之後再 `EXPIRE`。** 原因是後者是兩個命令：

```bash
# 危險寫法
SET user:session:abc "..."
EXPIRE user:session:abc 1800
# 如果程式在兩行之間崩潰、或網路斷開，你就留下一個永不過期的 key
```

這種「漏設 TTL」累積起來就是記憶體洩漏，而且極難排查——因為它只在異常路徑才發生。

### `KEEPTTL`：最容易踩的坑

**預設情況下，`SET` 一個已存在的 key 會清掉它原有的 TTL。**

```bash
SET product:1001 "old" EX 300
TTL product:1001
# (integer) 297

SET product:1001 "new"          # 沒帶 EX
TTL product:1001
# (integer) -1    <- TTL 不見了！這個 key 現在永不過期
```

這是實務上非常常見的記憶體洩漏來源：快取更新的程式碼忘記帶 TTL，於是每次更新都把一個「會自動清理的 key」變成「永久 key」。

兩種正確做法：

```bash
SET product:1001 "new" EX 300      # 更新時重設 TTL（多數快取場景該這樣）
SET product:1001 "new" KEEPTTL     # 保留原有 TTL（6.0+，適合「不想延長壽命」的情境）
```

`TTL` 的回傳值要記住三種：

| 回傳 | 意義 |
|------|------|
| 正整數 | 剩餘秒數 |
| `-1` | key 存在，但沒有設過期時間 |
| `-2` | key 不存在（或已過期） |

`-1` 和 `-2` 很容易在程式裡被誤判，寫邏輯時要明確區分。

### `GET`：取舊值並設新值

6.2+ 支援，回傳舊值，讓「更新並取得前一個值」變成一個原子操作：

```bash
SET config:mode "maintenance" GET
# "normal"    <- 回傳舊值
```

這取代了舊的 `GETSET` 命令（已被標記為 deprecated）。

### 順帶說一下 `SETNX` 與 `SETEX`

```bash
SETNX lock:x "1"          # 等價於 SET lock:x "1" NX，但不能同時設 TTL
SETEX cache:x 300 "1"     # 等價於 SET cache:x "1" EX 300
```

`SETNX` 的問題在於**它無法原子地同時設定過期時間**。如果你這樣寫鎖：

```bash
SETNX lock:order:8888 "worker-3"
EXPIRE lock:order:8888 30
```

行程在兩行之間崩潰，這個鎖就永遠不會釋放，整條業務卡死。這是經典的死鎖 bug。所以：

**現在一律用 `SET key value NX EX 30`，不要用 `SETNX` + `EXPIRE`。**

---

## 1.6 TTL 命令族

除了在 `SET` 時帶上，也可以單獨管理過期時間：

```bash
EXPIRE key 300           # 300 秒後過期
PEXPIRE key 300000       # 毫秒版
EXPIREAT key 1786000000  # 指定時間戳（秒）
PEXPIREAT key 1786000000000

TTL key                  # 剩餘秒數
PTTL key                 # 剩餘毫秒
EXPIRETIME key           # 過期的絕對時間戳（7.0+）

PERSIST key              # 移除過期時間，變成永久 key
```

Redis 7.0 為 `EXPIRE` 加了四個條件選項，很實用：

```bash
EXPIRE key 300 NX    # 只在「原本沒有 TTL」時設定
EXPIRE key 300 XX    # 只在「原本已有 TTL」時設定
EXPIRE key 300 GT    # 只在「新 TTL 大於現有 TTL」時設定（只延長，不縮短）
EXPIRE key 300 LT    # 只在「新 TTL 小於現有 TTL」時設定（只縮短，不延長）
```

`GT` 特別有用。想像 Session 續期：多個請求併發進來，你只想讓過期時間往後延，不希望某個延遲的請求把它改短。

```bash
EXPIRE user:session:abc 1800 GT   # 保證只會延長
```

沒有 `GT` 的話你得先 `TTL` 讀出來、比較、再 `EXPIRE`，這是三步且有競爭風險。

### Hash 的 field 級 TTL（7.4+）

長期以來 TTL 只能設在整個 key 上，不能設在 Hash 的單一 field。Redis 7.4 補上了這個能力：

```bash
HSET user:cart:1001 item:A 2 item:B 1
HEXPIRE user:cart:1001 3600 FIELDS 1 item:A    # 只讓 item:A 一小時後消失
HTTL user:cart:1001 FIELDS 1 item:A
```

這解決了「購物車每個商品有各自保留時限」這類需求。但要注意版本：如果你的環境是 7.2 或雲端託管的舊版本，這組命令不存在，得回到「每個項目一個 key」或在應用層記時間戳自行清理。

---

## 1.7 過期不是準時刪除：兩種刪除機制

這是面試高頻題，也是理解記憶體行為的關鍵。

**一個 key 的 TTL 到了，Redis 並不會在那一瞬間把它從記憶體移除。**

如果要做到「準時刪除」，Redis 得為每個 key 開一個定時器，一千萬個 key 就是一千萬個定時器——CPU 開銷完全不可接受。所以 Redis 用了兩種機制互補：

### 機制 1：惰性刪除（Lazy Expiration）

有人來存取這個 key 時，才檢查它過期了沒。過期了就刪掉，並回傳「不存在」。

```text
GET product:1001
  -> 檢查 TTL 是否已過
  -> 已過期：刪除 key，回傳 nil（對客戶端來說就是不存在）
  -> 未過期：回傳 value
```

優點是 CPU 開銷極低，只在必要時做。缺點很明顯：**如果一個過期的 key 再也沒人存取，它會一直佔著記憶體**。

### 機制 2：週期刪除（Active Expiration）

Redis 的背景任務 `serverCron` 會定期主動抽樣清理。大致流程是：

```text
每秒執行 hz 次（預設 hz = 10，即每 100ms 一輪）：
  對每個 db：
    從「設有 TTL 的 key」集合中隨機抽 20 個
    刪掉其中已過期的
    如果過期比例超過 25%，立刻再抽一輪
    否則結束，等下一次
```

這是一個**機率式**的清理策略：過期 key 多的時候清得積極，少的時候幾乎不花成本。設計上刻意限制了單輪的執行時間，避免這個背景任務本身變成阻塞源（記得第 00 章說的：Redis 是單執行緒，任何長時間操作都會卡住所有人）。

### 兩個重要推論

**推論 1：`INFO` 的 `used_memory` 可能包含已過期但還沒被刪的 key。**

所以你會看到「明明資料都設了 TTL，記憶體卻沒降下來」。這通常不是 bug，而是那些 key 剛好沒人存取、也還沒被抽樣到。如果這個量大到有影響，可以調高 `hz`（代價是背景任務更頻繁，CPU 略升）。

**推論 2：`DBSIZE` 的數字可能大於實際有效 key 數。**

因為它算的是 keyspace 裡的 key，包含尚未被清理的過期 key。

### 從節點（Replica）的過期行為

這點很容易搞錯，但在讀寫分離架構下會直接造成 bug。

**從節點不會自己刪除過期的 key。** 它等主節點在 key 過期時發送 `DEL` 命令過來，才執行刪除。這是為了保證主從資料的一致性——如果從節點各自判斷過期，主從就會出現不一致的狀態。

那從節點上讀一個已過期但主節點還沒發 `DEL` 的 key，會怎樣？

Redis 的處理是：**從節點在讀取時會邏輯判斷 TTL，發現過期就回傳 nil，但不實際刪除資料。** 所以客戶端看到的行為是正確的（讀不到），但記憶體還沒釋放。

實務影響：

- 你在從節點上執行 `DBSIZE`，可能比主節點大。
- 版本很舊的 Redis（3.2 以前）在這裡的行為有已知問題，可能讀到過期資料。現代版本不用擔心，但如果你維護的是老系統，值得確認。

心智模型：

```text
過期時間的權威在主節點
從節點只是「照著執行」+ 「讀取時裝作看不到」
```

---

## 1.8 `KEYS` 是禁令，`SCAN` 才是正解

### 為什麼 `KEYS *` 會出事

```bash
KEYS user:*      # 千萬不要在生產環境執行
```

三個原因疊加：

1. **它是 O(N)**，N 是整個 keyspace 的 key 總數。不是符合 pattern 的數量，是**全部** key——它得逐一遍歷並比對。
2. **它是阻塞的。** 單執行緒，這期間所有其他請求都在排隊。一千萬個 key 可能卡住幾秒，對線上服務就是一次事故。
3. **回傳結果可能極大。** 一次回傳幾百萬個 key，會撐爆客戶端輸出緩衝區，甚至導致連線被斷開（第 05 章會講 client output buffer）。

真實事故長這樣：某人為了排查問題在生產環境跑了 `KEYS *`，服務超時率瞬間飆高，上游熔斷，整條鏈路雪崩。

**建議直接在生產環境用 `rename-command` 或 ACL 把 `KEYS` 封鎖掉**（第 13 章會實作），從機制上避免有人手滑。

### `SCAN`：游標式漸進遍歷

```bash
SCAN cursor [MATCH pattern] [COUNT count] [TYPE type]
```

用法是「拿著游標一批批取，直到游標回到 0」：

```bash
SCAN 0 MATCH "product:*" COUNT 100
# 1) "17408"                      <- 下一次要用的游標
# 2) 1) "product:detail:1001"
#    2) "product:detail:1002"
#    ...

SCAN 17408 MATCH "product:*" COUNT 100
# 1) "8192"
# 2) ...

# 一直做下去，直到回傳的游標是 "0"，代表遍歷完成
```

在 shell 裡，`redis-cli` 提供了更方便的封裝：

```bash
redis-cli --scan --pattern "product:*"        # 自動幫你跑完整個游標循環
redis-cli --scan --pattern "product:*" | wc -l  # 數一數有幾個
```

### `SCAN` 提供什麼保證、不提供什麼保證

這部分很多人沒搞清楚，導致寫出有 bug 的清理腳本。

**提供的保證：**

- 從開始到結束都存在的 key，**一定至少會被回傳一次**。這是「完整遍歷保證」。

**不提供的保證：**

- **可能重複回傳同一個 key。** 所以你的處理邏輯必須是幂等的，或自己去重。
- **遍歷期間新增的 key，可能回傳也可能不回傳。**
- **遍歷期間刪除的 key，可能回傳也可能不回傳。**
- **`COUNT` 不是精確數量，只是提示。** 每批實際回傳可能多於或少於（甚至是 0 個）這個數字。

最後這點特別容易寫錯：

```javascript
// 錯誤：以為回傳空陣列就代表結束
let cursor = '0';
do {
  const [next, keys] = await redis.scan(cursor, 'MATCH', 'temp:*', 'COUNT', 100);
  if (keys.length === 0) break;   // BUG！某批可能是空的，但還沒遍歷完
  cursor = next;
} while (cursor !== '0');

// 正確：唯一的結束條件是游標回到 '0'
let cursor = '0';
do {
  const [next, keys] = await redis.scan(cursor, 'MATCH', 'temp:*', 'COUNT', 100);
  if (keys.length > 0) {
    await redis.unlink(...keys);
  }
  cursor = next;
} while (cursor !== '0');
```

### `COUNT` 該設多少

`COUNT` 是每批大約掃多少個 key（注意是「掃」不是「回傳」）：

- 太小（如 10）：往返次數多，整體遍歷慢。
- 太大（如 100000）：單批就變成一個慢命令，又回到阻塞問題。

實務上 **100 到 1000** 是合理範圍。要特別注意：如果 `MATCH` 的命中率很低（例如一千萬個 key 裡只有 100 個符合），`COUNT 100` 會讓大部分批次回傳空結果，遍歷要跑很久。這時可以把 `COUNT` 調大一些，或者——**更好的做法是一開始就把這類 key 設計成可以被獨立管理**（例如放在不同 db、或維護一個 Set 記錄它們）。

### 同系列命令

集合類型也有對應的漸進遍歷命令，用來安全地處理大集合：

```bash
HSCAN user:1001 0 COUNT 100      # 取代 HGETALL
SSCAN tags:hot 0 COUNT 100       # 取代 SMEMBERS
ZSCAN rank:daily 0 COUNT 100     # 取代 ZRANGE key 0 -1
```

規則一樣：**只要集合可能變大，就不要用一次全取的命令。**

---

## 1.9 db 編號：能用，但別依賴

Redis 單機預設有 16 個邏輯資料庫（0-15），用 `SELECT` 切換：

```bash
SELECT 1
SET foo bar
SELECT 0
GET foo        # (nil) — 不同 db 的 key 空間是隔離的
```

看起來很適合做隔離，但實務上**不建議用 db 做業務隔離**，理由有幾個：

**Cluster 模式只支援 db 0。** 你今天用 db 1-15 做隔離，未來要升級到 Cluster 就得全部重構。

**它不是真正的隔離。** 所有 db 共用同一個行程、同一份記憶體、同一個單執行緒。db 1 有人跑了慢命令，db 0 一樣被卡住。所以它給不了資源隔離，只給了命名隔離——而命名隔離用 key 前綴就能做到。

**維運工具支援不佳。** 很多客戶端連線池、監控工具、遷移工具預設只處理 db 0。

**`FLUSHALL` 會清掉所有 db。** 隔離感是假的。

合理的用途只有兩個：本機開發時區隔測試資料，以及測試環境跑整合測試前 `FLUSHDB` 清乾淨。

生產環境的正確隔離方式：**不同業務用不同 Redis 實例。** 這同時給你資源隔離、獨立的記憶體上限、獨立的故障域——db 編號一項都給不了。

---

## 1.10 其他必知的通用命令

```bash
EXISTS key [key ...]     # 存在幾個（可傳多個，回傳計數）
TYPE key                 # string / list / set / zset / hash / stream
RANDOMKEY                # 隨機回一個 key（抽樣看資料時偶爾有用）

RENAME old new           # 改名（會覆蓋 new）
RENAMENX old new         # 只在 new 不存在時改名
COPY src dst [DB n] [REPLACE]   # 複製（6.2+）

OBJECT ENCODING key      # 看內部編碼（第 05 章的主角）
MEMORY USAGE key         # 看這個 key 佔多少 bytes

DEL key [key ...]        # 刪除
UNLINK key [key ...]     # 非阻塞刪除（4.0+）
```

### `DEL` 與 `UNLINK`：一定要分清楚

```bash
DEL big:hash       # 同步釋放記憶體。如果這個 key 有 50 萬個元素，這行會阻塞整個 Redis
UNLINK big:hash    # 立刻把 key 從 keyspace 移除，記憶體回收交給背景執行緒
```

`UNLINK` 的行為是：先讓 key 對客戶端不可見（這步很快），然後把實際的記憶體釋放工作丟給背景執行緒。對大集合來說差別是**毫秒級 vs 秒級的阻塞**。

實務建議：

- 刪小 key（String、小 Hash）：兩者沒差，`DEL` 就好。
- 刪大集合：**一律用 `UNLINK`**。
- 更保險的做法是開啟 lazy free 設定，讓 Redis 在各種刪除場景都走背景回收：

```bash
CONFIG SET lazyfree-lazy-user-del yes       # DEL 自動當成 UNLINK
CONFIG SET lazyfree-lazy-expire yes         # 過期刪除走背景
CONFIG SET lazyfree-lazy-eviction yes       # 驅逐時走背景
CONFIG SET lazyfree-lazy-server-del yes     # 內部隱式刪除走背景
```

這四個在生產環境建議都開，是很低風險的優化。第 05 章會再回到這個話題。

同理，清空整個 db 也有非阻塞版本：

```bash
FLUSHDB ASYNC
FLUSHALL ASYNC
```

（但 `FLUSHALL` 本身在生產環境就該被 ACL 封鎖。）

---

## 1.11 常見錯誤

### 錯誤 1：`SET` 更新資料時忘記帶 TTL

前面講過，這會把有期限的 key 變成永久 key，是最常見的記憶體洩漏。養成習慣：**寫快取的每一處 `SET`，都要問自己 TTL 在哪。**

### 錯誤 2：用 `SETNX` + `EXPIRE` 做鎖

兩個命令之間崩潰就是死鎖。用 `SET key val NX EX n`。

### 錯誤 3：在生產環境用 `KEYS` 排查問題

用 `SCAN` 或 `redis-cli --scan`。並且從機制上封鎖 `KEYS`。

### 錯誤 4：`SCAN` 迴圈用 `keys.length === 0` 當結束條件

唯一的結束條件是游標回到 `0`。

### 錯誤 5：用 db 編號做業務隔離

未來遷 Cluster 會很痛，而且它不提供資源隔離。用不同實例。

### 錯誤 6：對大 key 用 `DEL`

用 `UNLINK`，並開啟 lazyfree 設定。

### 錯誤 7：所有 key 都不設 TTL

「這份資料要永久保存」在 Redis 裡是個危險的想法。永久資料應該在資料庫裡；Redis 的資料原則上都該有生命週期。真的需要永久的（例如 Cluster 的路由設定），數量應該極少且可控。

### 錯誤 8：假設 TTL 到了記憶體就會立刻釋放

不會。惰性刪除 + 週期抽樣，可能延遲。做容量規劃時要留這個餘裕。

---

## 1.12 本章練習

### 練習 1：設計 key 命名

為以下需求設計 key（含結構型別與 TTL 建議），並說明理由：

1. 商品詳情快取，商品 ID 為 1001。
2. 使用者 1001 的購物車，需要存「商品 ID → 數量」。
3. 每日銷售排行榜，2026-08-13。
4. 針對 IP `1.2.3.4` 的每分鐘 API 限流。
5. 避免訂單 8888 被重複扣款的鎖。
6. 文章 2024 的瀏覽數。

<details>
<summary>參考解答</summary>

| 需求 | key | 型別 | TTL | 理由 |
|------|-----|------|-----|------|
| 1 | `product:detail:1001` | String（JSON） | 300s + 隨機抖動 | 整份讀取，不需要局部更新。TTL 加抖動避免雪崩（第 09 章） |
| 2 | `user:cart:1001` | Hash | 7d（或不設，看業務） | field 是商品 ID、value 是數量，可用 `HINCRBY` 原子增減，不必整份讀寫 |
| 3 | `rank:sales:daily:2026-08-13` | Sorted Set | 8d | 日期放進 key，天然分片且好清理。TTL 設比保留期長一點 |
| 4 | `ratelimit:ip:1.2.3.4:202608131630` | String（計數） | 60s | 把時間窗口編進 key，過期自動清，不需要額外清理邏輯 |
| 5 | `lock:order:pay:8888` | String | 30s（必須設） | 鎖一定要有 TTL 兜底，否則持有者崩潰就死鎖 |
| 6 | `counter:article:views:2024` | String | 不設，或很長 | 用 `INCR` 累加，定期批次寫回資料庫 |

第 4 題的技巧值得注意：把時間窗口（`202608131630`）編進 key 名稱，那麼「換一個窗口」就等於「換一個 key」，舊窗口的計數由 TTL 自動清理。這比在一個 key 裡自己管理窗口邊界簡單得多。

第 2 題的 TTL 是個業務決策：購物車該不該過期？電商通常會保留較久（甚至永久存資料庫，Redis 只當快取）。如果只存 Redis 且不設 TTL，就要有其他清理機制，否則離職用戶的購物車會永久佔著記憶體。

</details>

### 練習 2：找出 TTL 消失的原因

以下程式碼在生產環境跑了三個月後，Redis 記憶體從 2GB 漲到 18GB，且 `INFO keyspace` 顯示大量沒有 TTL 的 key。找出問題並修好。

```javascript
async function getUser(id) {
  const key = `user:profile:${id}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const user = await db.findUser(id);
  await redis.set(key, JSON.stringify(user), 'EX', 3600);
  return user;
}

async function updateUser(id, data) {
  await db.updateUser(id, data);
  const user = await db.findUser(id);
  // 更新快取，讓使用者立刻看到新資料
  await redis.set(`user:profile:${id}`, JSON.stringify(user));
}
```

<details>
<summary>參考解答</summary>

**問題在 `updateUser` 的最後一行：`SET` 沒帶 TTL。**

流程是這樣：

1. `getUser` 建立了一個 TTL 3600 秒的 key。
2. 使用者更新資料，`updateUser` 用不帶 TTL 的 `SET` 覆寫同一個 key。
3. 這個 key 的 TTL 被清除，變成 `-1`（永不過期）。
4. 三個月下來，每個曾經被更新過的使用者都留下一個永久 key。

驗證方式：

```bash
SET user:profile:1 "old" EX 3600
TTL user:profile:1     # (integer) 3597
SET user:profile:1 "new"
TTL user:profile:1     # (integer) -1   <- 重現了
```

**修法一：更新時一併重設 TTL（多數場景推薦）**

```javascript
async function updateUser(id, data) {
  await db.updateUser(id, data);
  const user = await db.findUser(id);
  await redis.set(`user:profile:${id}`, JSON.stringify(user), 'EX', 3600);
}
```

**修法二：直接刪快取，讓下次讀取自然重建（更推薦）**

```javascript
async function updateUser(id, data) {
  await db.updateUser(id, data);
  await redis.unlink(`user:profile:${id}`);
}
```

修法二更好，理由有兩個：一是不需要在兩個地方維護「快取要存什麼格式」的邏輯；二是避免「更新了快取但這筆資料其實很少被讀」造成的無效記憶體佔用。這就是 Cache Aside 模式建議「更新資料庫後刪快取，而不是改快取」的原因，第 09 章會完整討論。

**如果不想改架構，還有修法三：**

```javascript
await redis.set(key, JSON.stringify(user), 'KEEPTTL');
```

保留原有 TTL。但要注意語意差別：這不會延長壽命，key 仍會在原定時間過期。

**清理現有的髒資料：**

```bash
# 先確認規模
redis-cli --scan --pattern "user:profile:*" | wc -l
```

然後寫個腳本掃出沒有 TTL 的 key 補上：

```javascript
let cursor = '0';
do {
  const [next, keys] = await redis.scan(cursor, 'MATCH', 'user:profile:*', 'COUNT', 500);
  for (const key of keys) {
    // -1 代表存在但沒有 TTL
    if (await redis.ttl(key) === -1) {
      await redis.expire(key, 3600);
    }
  }
  cursor = next;
} while (cursor !== '0');
```

注意這裡用 `SCAN` 而不是 `KEYS`，而且結束條件是游標回到 `'0'`。實際跑的時候建議加上小段 sleep，避免這個腳本本身造成負載尖峰。

</details>

### 練習 3：驗證過期不是準時刪除

設計一個實驗，證明「key 的 TTL 到了之後，它可能還佔著記憶體」。

<details>
<summary>參考解答</summary>

進入容器：

```bash
docker compose exec redis sh
```

先關掉主動過期的干擾因素會比較好觀察，但 `hz` 不能設為 0，所以我們用另一個角度：寫入大量帶短 TTL 的 key，然後**不去存取它們**，觀察 `DBSIZE` 與記憶體的下降速度。

```sh
redis-cli -a mysecret FLUSHDB

# 寫入 10 萬個 5 秒後過期的 key，每個帶一點 payload
redis-cli -a mysecret EVAL "
for i=1,100000 do
  redis.call('SET', 'tmp:'..i, string.rep('x', 200), 'EX', 5)
end
return redis.call('DBSIZE')" 0

# 立刻看
redis-cli -a mysecret DBSIZE
redis-cli -a mysecret INFO memory | grep used_memory_human

# 等 6 秒（TTL 已全部到期）
sleep 6
redis-cli -a mysecret DBSIZE
redis-cli -a mysecret INFO memory | grep used_memory_human
```

你會觀察到：**6 秒後 `DBSIZE` 通常不是 0**，而是還有相當數量的 key，記憶體也沒有立刻降回去。再隔幾秒重複查，數字會逐步下降。

這就是週期刪除的機率式行為：每 100ms 抽 20 個，過期比例高就再抽一輪。十萬個 key 需要好幾秒才能清完。

再驗證惰性刪除：

```sh
# 隨便挑一個還在 DBSIZE 裡的過期 key 去讀
redis-cli -a mysecret GET tmp:50000
# (nil)  <- 客戶端看到的是「不存在」，同時這個 key 被實際刪除了
```

關鍵結論：**`DBSIZE` 和 `used_memory` 都可能包含已過期但未清理的 key，但客戶端永遠不會讀到過期資料。** 邏輯正確性有保證，記憶體釋放有延遲。

想加快清理，可以調高 `hz`：

```sh
redis-cli -a mysecret CONFIG GET hz          # 預設 10
redis-cli -a mysecret CONFIG SET hz 100      # 更積極，代價是 CPU 略升
```

生產環境調 `hz` 前建議先確認 CPU 有餘裕，一般不需要超過 100。

</details>

### 練習 4：安全地清理一批 key

線上有大量 `session:temp:*` 的殘留 key（約 200 萬個），需要清掉，但不能影響線上服務。寫出你的做法並說明每個選擇的理由。

<details>
<summary>參考解答</summary>

**不能這樣做：**

```bash
redis-cli KEYS "session:temp:*" | xargs redis-cli DEL
```

三個問題：`KEYS` 阻塞、回傳 200 萬個 key 撐爆緩衝區、`DEL` 一次刪大量 key 也是阻塞的。

**正確做法：分批 `SCAN` + `UNLINK` + 節流**

```bash
#!/bin/bash
# cleanup.sh
CURSOR=0
BATCH=0

while : ; do
  RESULT=$(redis-cli -a "$REDIS_PASS" --no-auth-warning \
    SCAN "$CURSOR" MATCH "session:temp:*" COUNT 500)

  CURSOR=$(echo "$RESULT" | head -1)
  KEYS=$(echo "$RESULT" | tail -n +2)

  if [ -n "$KEYS" ]; then
    echo "$KEYS" | xargs -r redis-cli -a "$REDIS_PASS" --no-auth-warning UNLINK
  fi

  BATCH=$((BATCH + 1))
  # 每 20 批休息 100ms，避免造成負載尖峰
  if [ $((BATCH % 20)) -eq 0 ]; then
    sleep 0.1
  fi

  # 唯一的結束條件
  [ "$CURSOR" = "0" ] && break
done

echo "done, $BATCH batches"
```

四個關鍵設計：

**用 `SCAN` 不用 `KEYS`**：漸進遍歷，每批只掃 500 個，單次都是短命令，不阻塞。

**用 `UNLINK` 不用 `DEL`**：記憶體回收交給背景執行緒。即使這些是小 key，累積起來也有差。

**主動節流**：即使每個命令都很快，200 萬個 key 的連續刪除也會產生持續負載，而且會讓 Redis 的記憶體回收與 AOF 寫入壓力上升。定期 sleep 讓系統有呼吸空間。

**結束條件是游標回到 0**：不是「這批沒東西」。

**執行時機與觀察**：建議在低峰期跑，並且開另一個終端持續監控：

```bash
redis-cli -a "$REDIS_PASS" --latency-history -i 2
```

如果延遲數字明顯上升，就把 `COUNT` 調小、sleep 拉長。

**更根本的解法**：這批 key 之所以殘留，很可能就是練習 2 那個問題——某處的 `SET` 漏了 TTL。清理完之後，一定要回頭找出製造它們的程式碼，否則三個月後你要再清一次。

</details>

---

## 1.13 驗收清單

進入下一章前，確認你可以：

- [ ] 設計一套帶業務域、物件、識別碼的冒號分層 key 命名，並說明為什麼不該用 `u:1001` 這種縮寫。
- [ ] 說明為什麼「key 的數量」比「key 的長度」更值得優化。
- [ ] 寫出 `SET key value NX EX 30` 並說明每個選項的作用。
- [ ] 解釋為什麼不能用 `SETNX` + `EXPIRE` 做鎖。
- [ ] 說出 `SET` 覆寫已有 key 時 TTL 會發生什麼事，以及 `KEEPTTL` 的用途。
- [ ] 區分 `TTL` 回傳 `-1` 和 `-2` 的意義。
- [ ] 說明惰性刪除與週期刪除如何互補，以及為什麼 Redis 不做準時刪除。
- [ ] 解釋為什麼從節點不自己刪除過期 key，以及讀取時的行為。
- [ ] 寫出一個正確的 `SCAN` 迴圈，並說出它的三個「不保證」。
- [ ] 說明 `DEL` 和 `UNLINK` 的差別，以及四個 lazyfree 設定的作用。

---

下一章進入 Redis 真正的核心競爭力：[02-core-data-structures.md](./02-core-data-structures.md)，我們會把五大資料結構的操作、複雜度與選型判斷一次講清楚。
