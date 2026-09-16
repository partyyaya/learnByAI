# 第 01 章：key、TTL 與過期機制

> 這一章講兩件聽起來最沒有深度的東西：**key 怎麼取名**，跟 **TTL 怎麼設**。
>
> 它們沒有深度，但它們有**四個會讓你在正式環境加班的細節**：
>
> - **`SET` 會把 TTL 清掉。** 你設了 30 分鐘過期的購物車，使用者多加一件商品，
>   那個 key 就變成**永不過期**——而且沒有任何錯誤、任何警告。
>   （這是 00 章 0.3.2 事故的另一半：那些永不過期的 key 最後把記憶體塞爆，
>   於是 LRU 開始踢人。）
> - **key 過期了不代表它消失了。** 實測：關掉主動過期之後，
>   一個過期 900 毫秒的 key **還在 `DBSIZE` 裡面**，直到有人去讀它。
> - **100 萬個 key 同時到期，Redis 要花 3 秒才清完**，
>   期間其他人的延遲從 0.15 毫秒跳到 26 毫秒。
> - **`SCAN` 會吐出重複的 key。** 這是它文件上寫明的、唯一不保證的事。
>   實測跑七次有兩次出現——**正因為它很罕見，所以它很危險**。
>
> 📌 這一章大部分在 `redis-cli` 裡進行，最後 1.7 回到 Java 這一側。
> 為什麼這樣安排：這四件事在 `redis.opsForValue().set(k, v)` 這行 Java 程式碼上**完全看不出來**。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 說出一個 key 的記憶體成本，並用實測數字證明「key 名稱取長一點沒關係」是錯的
  （1.2.2：10 萬個 key，長名比短名多用 **55% 的記憶體**）。
- 設計一套 key 命名慣例，並說出為什麼**不該**用 Redis 的 16 個 db 來隔離環境（1.2.4）。
- 說出 `DEL` 與 `UNLINK` 的差別，並用實測數字說明什麼時候必須用後者
  （1.3.2：刪一個 500 萬欄位的 hash，`DEL` 讓所有人等 **0.81 秒**，`UNLINK` 是 **5 毫秒**）。
- 列出六種設定過期時間的寫法，並指出哪一種有「中間有縫」的問題（1.4.1）。
- 解釋 `TTL` 回傳 `-1` 與 `-2` 的差別，以及 `TTL` 回傳 `0` **不代表**沒有過期時間（1.4.2）。
- 說出哪些命令會清掉 TTL、哪些會保留，並用 `KEEPTTL` 或 `GETEX` 寫出正確的更新（1.4.4、1.4.5）。
- 說明 `SCAN` 的游標是什麼、它保證什麼、**唯一不保證的是什麼**，並重現一次重複（1.5.3、1.5.4）。
- 說出 Redis 刪除過期 key 的兩套機制，並用 `DEBUG SET-ACTIVE-EXPIRE 0` 實際看到惰性刪除（1.6.1、1.6.2）。
- 解釋「過期事件通知」為什麼不能當計時器用（1.6.4：實測事件晚了 41 毫秒；關掉主動過期後**永遠不會來**）。
- 說明過期在主從之間是怎麼運作的，以及為什麼從庫上的 `DBSIZE` 會比主庫大（1.6.5）。
- 在 Java 這一側正確地讀寫 TTL，並用三種方法之一避免「TTL 被洗掉」（1.7）。

---

## 1.2 key：它比你想的貴，也比你想的自由

### 1.2.1 key 可以是任何位元組

Redis 的 key **不是字串，是位元組陣列**。這代表：

```
127.0.0.1:6379> SET "key with space" v
OK
127.0.0.1:6379> SET "中文key" v
OK
127.0.0.1:6379> EXISTS "中文key"
(integer) 1
```

空白、中文、換行、甚至一整張 JPEG 圖片的位元組，都可以當 key。
上限是 **512 MB**（跟 String 值的上限一樣）。

**但「可以」不等於「應該」。** 00 章 0.3.3 那個 `\xac\xed\x00\x05t\x00\x0cproduct:1001`
就是「可以」的極端案例——它是合法的 key，但你連在 `redis-cli` 上都打不出來。

> 📌 **實務上的規則很簡單**：
> **key 只用可見的 ASCII 字元**（英數字、冒號、底線、連字號）。
> 中文、空白、二進位一律不要——不是 Redis 不支援，是**你的維運腳本、監控系統、同事的眼睛**不支援。

### 1.2.2 實測：一個 key 要多少記憶體

`MEMORY USAGE` 告訴你單一 key 佔多少位元組（含 key 名、值、以及 Redis 的內部結構）：

```bash
docker exec -it redis-lab redis-cli
```

```
127.0.0.1:6379> SET a ""
127.0.0.1:6379> MEMORY USAGE a
(integer) 56

127.0.0.1:6379> SET user:1 ""
127.0.0.1:6379> MEMORY USAGE user:1
(integer) 56

127.0.0.1:6379> SET session:user:profile:10001 ""
127.0.0.1:6379> MEMORY USAGE session:user:profile:10001
(integer) 80
```

**一個「什麼都沒存」的 key 就要 56 bytes。** 那 56 bytes 是：
dict 的項目結構、指向 key 字串的指標、`redisObject` 的標頭、記憶體配置器的對齊。
**你存的值是 0 bytes，管理它的成本是 56 bytes。**

值的長度怎麼影響它：

```
值長  10 bytes  OBJECT ENCODING=embstr   MEMORY USAGE=64
值長  44 bytes  OBJECT ENCODING=embstr   MEMORY USAGE=96
值長  45 bytes  OBJECT ENCODING=raw      MEMORY USAGE=104
值長 100 bytes  OBJECT ENCODING=raw      MEMORY USAGE=160
```

⚠️ **注意 44 → 45 那一行的編碼變了**：`embstr` 變成 `raw`。
44 bytes 以下，Redis 把物件標頭跟字串內容配置在**同一塊記憶體**（一次配置、對快取友善）；
超過就分成兩塊。這個門檻在 02 章還會出現好幾次——
**Redis 對「小東西」有一整套特別的省法**。

數字更省：

```
值 '12345'   ENCODING=int      MEMORY USAGE=48
值 '12345x'  ENCODING=embstr   MEMORY USAGE=64
```

`12345` 被認出是整數，**直接存在指標欄位裡，連字串都不用配置**。
（所以 10 章的限流計數、12 章的庫存，記憶體成本比你想的低很多。）

**現在看 key 名稱的成本。** 10 萬個 key，值都是一個字元，只差在 key 取多長：

```bash
# 短名：u:1 ... u:100000
docker exec redis-lab bash -c \
  'for i in $(seq 1 100000); do echo "SET u:$i v"; done | redis-cli --pipe'

# 長名：production:shop:user:session:profile:cache:1 ...
docker exec redis-lab bash -c \
  'for i in $(seq 1 100000); do echo "SET production:shop:user:session:profile:cache:$i v"; done | redis-cli --pipe'
```

| key 樣式 | 長度 | 單個 `MEMORY USAGE` | **10 萬個共用掉** |
|---|---|---|---|
| `u:1` | 3～8 字元 | 56 bytes | **7.02 MB** |
| `production:shop:user:session:profile:cache:1` | 44～49 字元 | 96 bytes | **10.91 MB** |

**同樣的資料，多用 55% 的記憶體，差別只在 key 取太長。**

📌 **這個差距要放在規模裡看才有意義**：
1000 萬個 session，短名約 560 MB，長名約 960 MB——**400 MB 的差距，只因為前綴寫得太完整**。
但反過來說：**key 取得太短、看不懂，維運時的代價更高**。
下一節給一個平衡點。

### 1.2.3 命名慣例：冒號、前綴，以及一條界線

業界的慣例是**用冒號分層**：

```
物件類型:識別碼:欄位
```

| 例子 | 讀法 |
|---|---|
| `product:1001` | 商品 1001 的資料 |
| `product:1001:stock` | 商品 1001 的庫存 |
| `cart:u:8842` | 使用者 8842 的購物車 |
| `lock:order:20260916-0001` | 訂單 20260916-0001 的鎖 |
| `rate:ip:1.2.3.4:202609161430` | 這個 IP 在這一分鐘的計數 |

**為什麼是冒號**：`redis-cli` 的 `--scan --pattern 'product:*'` 可以按前綴掃，
RedisInsight 之類的 GUI 工具會把冒號當成資料夾的分隔符號自動摺疊，
而且它在 URL、JSON、log 裡都不需要跳脫。

**四條實務規則**：

| 規則 | 為什麼 |
|---|---|
| **前綴要能反推「這是哪個功能寫的」** | 半夜看到一台 Redis 用了 40 GB，你要能靠 key 前綴找出是誰 |
| **同一個功能的 key 前綴要一致** | 才能整批 `SCAN`、整批清理、整批統計 |
| **不要把會變的東西放進前綴**（版本號除外） | `cache:v2:product:1001` 可以（換版本＝換一批 key，是刻意的）；`cache:20260916:product:1001` 通常不行（每天長一批新的，舊的沒人清） |
| **長度控制在 30 字元以內** | 1.2.2 的實測 |

> ⚠️ **最重要的一條：一個 key 一旦寫進正式環境，它就是一份合約。**
> 舊版程式寫 `cart:8842`、新版程式讀 `cart:u:8842`——
> 部署的那一刻，所有人的購物車**同時消失**。
> 07 章 7.6 會講快取的版本化，這裡先記住：**改 key 名等於清空那批資料。**

### 1.2.4 ⚠️ 不要用 16 個 db 來隔離環境

Redis 預設有 16 個編號的資料庫，用 `SELECT n` 切換：

```
127.0.0.1:6379> SELECT 0
OK
127.0.0.1:6379> SET samename "db0 的值"
127.0.0.1:6379> SELECT 3
OK
127.0.0.1:6379> SET samename "db3 的值"
127.0.0.1:6379> GET samename
"db3 的值"
127.0.0.1:6379> SELECT 0
127.0.0.1:6379> GET samename
"db0 的值"
```

看起來很適合「db0 給正式、db1 給測試」，**但不要這樣做**，理由有四個：

| 理由 | 說明 |
|---|---|
| **它們共用同一個行程、同一條主執行緒** | db1 上一個 `KEYS *` 會把 db0 一起卡死（00 章 0.3.1）。**這不是隔離，只是分資料夾** |
| **它們共用同一份 `maxmemory`** | db1 的測試資料把記憶體塞爆，被淘汰的是 db0 的正式資料 |
| **Cluster 模式只有 db0** | 哪天要上 Cluster（13 章），所有用到 `SELECT` 的程式碼都要改 |
| **連線池會出錯** | Lettuce 的連線是共用的，`SELECT` 是**連線層級的狀態**——用連線池時很難保證你拿到的連線在哪個 db 上 |

> 📌 **正確作法**：
> 環境隔離用**不同的 Redis 實例**（不同埠、不同容器）；
> 應用隔離用 **key 前綴**（`shop:` / `blog:`）。
> 本站從頭到尾只用 **db0**。

---

## 1.3 基本命令與它們的回傳值

### 1.3.1 `SET` 的完整參數

`SET` 不只是「寫一個值」，它有六個參數，**而且這六個參數是後面好幾章的基礎**：

```
SET key value [EX 秒 | PX 毫秒 | EXAT 時間戳 | PXAT 毫秒時間戳 | KEEPTTL] [NX | XX] [GET]
```

| 參數 | 意思 | 哪一章會用到 |
|---|---|---|
| `EX` / `PX` | 設定相對過期時間（秒 / 毫秒） | 全部 |
| `EXAT` / `PXAT` | 設定**絕對**過期時間（Unix 時間戳） | 10 章（限流窗口對齊整分鐘） |
| `KEEPTTL` | 保留原本的 TTL（1.4.5） | 11 章 |
| `NX` | **只在 key 不存在時才寫**——寫成功回 `OK`，失敗回 `nil` | **09 章：分散式鎖的根基** |
| `XX` | 只在 key 已存在時才寫 | 07 章 |
| `GET` | 回傳舊值（Redis 6.2+） | 12 章 |

`NX` 值得現在就看一次，因為它是整站最重要的一個參數：

```
127.0.0.1:6379> SET lock:order:1 "token-abc" EX 30 NX
OK                                    ← 搶到了

127.0.0.1:6379> SET lock:order:1 "token-xyz" EX 30 NX
(nil)                                 ← 沒搶到，而且「沒搶到」是 nil 不是錯誤

127.0.0.1:6379> GET lock:order:1
"token-abc"                           ← 第一個人的值還在，沒有被蓋掉

127.0.0.1:6379> TTL lock:order:1
(integer) 30
```

> 📌 **「只有一個人會拿到 OK」**——這一行就是分散式鎖的全部原理（09 章會告訴你，
> 剩下的 95% 難度都在「怎麼安全地把它放掉」）。
>
> ⚠️ 注意 `EX 30` 跟 `NX` 是**同一條命令**的參數。
> 寫成兩條（`SETNX` 再 `EXPIRE`）就是 09 章第一個要拆掉的錯誤寫法。

### 1.3.2 `DEL` 與 `UNLINK`：刪除也會卡住整台 Redis

刪一個 key 需要多久？**看它多大。**

造一個 500 萬個欄位的 hash（約 363 MB）：

```bash
docker exec redis-lab bash -c \
  'for i in $(seq 1 5000000); do echo "HSET bigkey f$i v$i"; done | redis-cli --pipe'
```

```
errors: 0, replies: 5000000
```

```
127.0.0.1:6379> HLEN bigkey
(integer) 5000000
127.0.0.1:6379> MEMORY USAGE bigkey
(integer) 380663400            ← 363 MB
```

**現在刪掉它，同時用另一個連線量延遲**：

```bash
# 一邊：持續 PING 量延遲
docker exec redis-lab redis-cli --latency -i 4 &
# 另一邊：刪
docker exec redis-lab redis-cli DEL bigkey
```

| 用 `DEL` | 結果 |
|---|---|
| 其他客戶端的延遲（min / max / avg，毫秒） | `0  800  3.39` |
| `SLOWLOG` 記錄的伺服器端耗時 | **810,351 µs = 0.81 秒** |

**同一件事，改用 `UNLINK`**：

| 用 `UNLINK` | 結果 |
|---|---|
| 其他客戶端的延遲 | `0  5  0.13` |
| `SLOWLOG` | **沒有記錄**（沒超過 10 毫秒的門檻） |

差了 160 倍。`UNLINK` 回來的那一瞬間去看：

```
DBSIZE = 0                              ← key 已經不見了
used_memory_human = 264.47M             ← 但記憶體還沒還回來
lazyfree_pending_objects = 1            ← 有 1 個物件排隊等背景執行緒回收

（1 秒後）
used_memory_human = 1.60M
lazyfree_pending_objects = 0
```

**`UNLINK` 做的事**：把 key 從字典裡摘掉（O(1)，很快），
然後**把「真正釋放那 500 萬個欄位的記憶體」丟給背景執行緒**。
主執行緒立刻回去服務其他人。

> 📌 **規則**：
> **不確定 key 多大的時候，一律用 `UNLINK`。**
> Redis 4.0 以後它就在了，代價幾乎是零。
>
> 📌 **Java 這一側**：`redisTemplate.delete(key)` 送的是 `DEL`，**不是** `UNLINK`。
> Spring Data Redis 有 `unlink(...)`（`RedisTemplate#unlink`），要自己換。
> 14 章的上線檢查清單裡有這一條。

⚠️ **這一節其實是 00 章 0.3.1 的同一個故事**：
`KEYS`、`DEL` 一個 big key、`FLUSHALL`、`SMEMBERS` 一個百萬成員的 set——
**它們的共同點是「這條命令要做的工作量跟資料量成正比，而 Redis 一次只做一件事」**。
03 章會把這一類命令整理成一張完整的清單。

**怎麼確認 Spring 到底送了哪一條命令**——開著 `MONITOR` 跑一次就知道：

```java
@SpringBootTest
class DelVsUnlinkTest {
    @Autowired StringRedisTemplate redis;

    @Test
    void which() {
        redis.opsForValue().set("d1", "v");
        redis.opsForValue().set("d2", "v");
        System.out.println("delete() = " + redis.delete("d1"));
        System.out.println("unlink() = " + redis.unlink("d2"));
    }
}
```

```bash
docker exec redis-lab redis-cli MONITOR
```

```
1789542690.636541 [0 192.168.65.1:61795] "DEL" "d1"
1789542690.637308 [0 192.168.65.1:61795] "UNLINK" "d2"
```

> 📌 **這個技巧整站都會用到**：
> 當你不確定「Spring 的這個方法到底送了什麼」，**不要猜，開 `MONITOR` 看**。
> （記得 00 章 0.4.3 的警告：只在本機實驗機上開。）

---

## 1.4 TTL：六種設法與一個陷阱

### 1.4.1 六種設定過期時間的寫法

```
127.0.0.1:6379> SET a v EX 100
OK                                    TTL = 100    秒

127.0.0.1:6379> SET b v PX 100000
OK                                    TTL = 100    毫秒

127.0.0.1:6379> SET c v EXAT 1789543000
OK                                    TTL = 100    絕對時間（Unix 秒）

127.0.0.1:6379> SETEX d 100 v
OK                                    TTL = 100    舊寫法，等同 SET + EX

127.0.0.1:6379> SET e v
127.0.0.1:6379> EXPIRE e 100
(integer) 1                           TTL = 100    ⚠️ 兩條命令

127.0.0.1:6379> PEXPIREAT f 1789543000000
(integer) 1                           TTL = 99     絕對時間（Unix 毫秒）
```

⚠️ **第五種（`SET` 然後 `EXPIRE`）是一個常見的 bug 來源**：

```
    SET e v            ← 成功
    （程式在這裡當掉／網路斷了／這台機器被重啟）
    EXPIRE e 100       ← 沒送出去
```

結果是一個**永不過期的 key**。這跟 1.4.3 的陷阱會合流，變成 00 章 0.3.2 的事故。

> 📌 **規則：能一條命令做完的，不要拆成兩條。**
> `SET k v EX 3600` 永遠優於 `SET k v` + `EXPIRE k 3600`。
> （09 章的分散式鎖有一模一樣的教訓，而那裡的後果是「鎖永遠不會釋放」。）

**`EXAT` / `PEXPIREAT` 的用途**：當你要的是「**在某個時刻**過期」而不是「**再過多久**過期」。
10 章的限流器會用它把窗口對齊整分鐘——
用 `EX 60` 的話，每個 key 的窗口從它被建立的那一刻開始算，十萬個 key 就是十萬個不同的窗口。

### 1.4.2 `TTL` 的三個回傳值，以及一個會騙你的 `0`

```
127.0.0.1:6379> TTL 沒有這個key
(integer) -2          ← key 不存在

127.0.0.1:6379> SET k v
127.0.0.1:6379> TTL k
(integer) -1          ← key 存在，但沒有過期時間

127.0.0.1:6379> EXPIRE k 100
127.0.0.1:6379> TTL k
(integer) 100         ← 還有 100 秒
```

**`-1` 跟 `-2` 是完全不同的兩件事**，而它們在 Java 這一側都是 `Long`：
`getExpire()` 回 `-1` 是「這個 key 永不過期」，回 `-2` 是「這個 key 根本不在」。
**如果你的程式碼寫 `if (ttl < 0) { 重新設定 TTL }`，那兩種情況會被混在一起處理。**

**還有一個 `0`。** `TTL` 回傳的是**四捨五入到秒**的值：

```bash
# PTTL 與 TTL 在同一條 Lua 裡讀，避免兩次 redis-cli 之間的時間差
docker exec redis-lab redis-cli EVAL \
  "redis.call('SET', KEYS[1], 'v', 'PX', ARGV[1]); return {redis.call('PTTL',KEYS[1]), redis.call('TTL',KEYS[1])}" \
  1 r 600
```

| 設定的毫秒數 | `PTTL` | `TTL` |
|---|---|---|
| 400 | 400 | **0** |
| 600 | 600 | 1 |
| 1400 | 1400 | 1 |
| 1600 | 1600 | 2 |
| 2400 | 2400 | 2 |

⚠️ **`TTL` 回傳 `0` 代表「還有不到半秒」，不代表「沒有過期時間」。**
需要精度的時候（鎖的續期、限流窗口的剩餘時間）**一律用 `PTTL`**，不要用 `TTL`。

### 1.4.3 ⚠️ `SET` 會把 TTL 清掉

這是本章最重要的一節。

```
127.0.0.1:6379> SET cart:alice "3 件商品" EX 1800
OK
127.0.0.1:6379> TTL cart:alice
(integer) 1800

127.0.0.1:6379> SET cart:alice "4 件商品"
OK
127.0.0.1:6379> TTL cart:alice
(integer) -1                           ← 永不過期了
```

**這是 Redis 的設計，不是 bug。** `SET` 的語意是「**把這個 key 換成一個全新的值**」——
一個全新的值沒有過期時間，除非你這次也指定。

**為什麼這件事很嚴重**，因為它幾乎一定會發生：

```
    使用者把耳機加入購物車   → SET cart:alice "耳機"  EX 1800     （設計者寫的）
    使用者又加了保護殼       → SET cart:alice "耳機,保護殼"        （另一個人寫的另一支方法）
                                                         ↑
                            這個 key 從此永不過期，而且沒有人會發現
```

上線三個月後，這台 Redis 上有幾百萬個「本來應該 30 分鐘就消失」的購物車。
然後 00 章 0.3.2 的事故就發生了。

📌 **怎麼發現這件事已經在你的系統裡發生了**：看 `INFO keyspace`。

```
db0:keys=1500,expires=1000,avg_ttl=3599950
```

`keys` 是總數、**`expires` 是其中有設過期時間的數量**。
**兩者的差距就是「永不過期的 key 有幾個」**——
如果你的系統設計上「所有東西都該有 TTL」，那這兩個數字應該幾乎相等。
差距愈拉愈大，就是這個陷阱正在發生。

### 1.4.4 實測：哪些命令保留 TTL、哪些清掉

不是所有寫入命令都會清掉 TTL。實測（每個都是「先 `SET k 1 EX 600`，再下這條命令」）：

| 命令 | 之後的 TTL | 保留？ |
|---|---|---|
| `INCR k` | 600 | ✅ 保留 |
| `APPEND k "x"` | 600 | ✅ 保留 |
| `SETRANGE k 0 "9"` | 600 | ✅ 保留 |
| `HSET h f2 v2`（對已存在的 hash） | 600 | ✅ 保留 |
| `RPUSH l b`（對已存在的 list） | 600 | ✅ 保留 |
| **`SET k "2"`** | **-1** | ❌ **清掉** |
| **`GETSET k "2"`** | **-1** | ❌ **清掉** |

**規律是這樣的**：

> **「修改這個 key 的內容」的命令 → 保留 TTL。**
> **「用一個新值整個取代這個 key」的命令 → 清掉 TTL。**

`INCR` 是在原本的值上加一（修改），`SET` 是換一個全新的值（取代）。
`HSET` 是往 hash 裡加一個欄位（修改），所以 hash 的 TTL 不受影響——
**這是 1.7.3 第三種修法的基礎。**

`RENAME` 跟 `COPY` 又是另一組規則：

```
127.0.0.1:6379> SET a v EX 600
127.0.0.1:6379> RENAME a b
127.0.0.1:6379> TTL b
(integer) 600          ← TTL 跟著來源走

127.0.0.1:6379> SET c v EX 600
127.0.0.1:6379> COPY c d
127.0.0.1:6379> TTL d
(integer) 600          ← COPY 也複製 TTL
```

⚠️ **但 `RENAME` 蓋掉一個已有 TTL 的目標時，目標的 TTL 被丟掉**：

```
127.0.0.1:6379> SET e v            ← 來源沒有 TTL
127.0.0.1:6379> SET f v EX 600     ← 目標有 600 秒
127.0.0.1:6379> RENAME e f
127.0.0.1:6379> TTL f
(integer) -1                       ← 目標原本的 TTL 沒了
```

**`RENAME` 是「整個 key 搬過去」**，包含它的 TTL 狀態——來源沒有 TTL，結果就沒有 TTL。

### 1.4.5 `KEEPTTL` 與 `GETEX`：兩個專門解決這件事的參數

**`KEEPTTL`（Redis 6.0+）**：更新值，但保留原本的倒數。

```
127.0.0.1:6379> SET cart:alice "3 件商品" EX 1800
127.0.0.1:6379> SET cart:alice "4 件商品" KEEPTTL
OK
127.0.0.1:6379> TTL cart:alice
(integer) 1800                     ← 倒數繼續走，沒有重設
```

**`GETEX`（Redis 6.2+）**：讀值的時候順便動 TTL。

```
127.0.0.1:6379> SET s v EX 600
127.0.0.1:6379> GETEX s
"v"                    TTL = 600   ← 不帶參數 = 只讀，不動 TTL

127.0.0.1:6379> GETEX s EX 60
"v"                    TTL = 60    ← 讀的同時把 TTL 改成 60

127.0.0.1:6379> GETEX s PERSIST
"v"                    TTL = -1    ← 讀的同時拿掉過期時間
```

> ⭐ **`GETEX key EX 1800` 就是「滑動過期」的一條命令版本**：
> **每次有人讀取，就把 30 分鐘的倒數重新開始。**
> Session 幾乎都要這個行為（使用者一直在用，就不該被登出），
> 11 章會用到它。
>
> **在 `GETEX` 出現之前**，大家寫的是 `GET` 然後 `EXPIRE`——兩條命令、兩次往返、中間有縫。

### 1.4.6 `EXPIRE` 的 `NX` / `XX` / `GT` / `LT`（Redis 7.0+）

`EXPIRE` 也有條件參數，用來表達「**只在某種情況下才改過期時間**」：

```
127.0.0.1:6379> SET k v
127.0.0.1:6379> EXPIRE k 100 NX          ← NX = 只在「目前沒有 TTL」時才設
(integer) 1                                 TTL = 100

127.0.0.1:6379> EXPIRE k 200 NX
(integer) 0                                 TTL = 100   ← 已經有 TTL 了，不動

127.0.0.1:6379> EXPIRE k 50 GT           ← GT = 只在「比現在大」時才設
(integer) 0                                 TTL = 100   ← 50 < 100，不動

127.0.0.1:6379> EXPIRE k 500 GT
(integer) 1                                 TTL = 500   ← 500 > 100，設了

127.0.0.1:6379> EXPIRE k 50 LT           ← LT = 只在「比現在小」時才設
(integer) 1                                 TTL = 50
```

| 參數 | 意思 | 典型用途 |
|---|---|---|
| `NX` | 只在沒有 TTL 時設 | 「補設定」：確保這個 key 有 TTL，但不覆蓋既有的 |
| `XX` | 只在已有 TTL 時設 | 「只續已經在倒數的」 |
| `GT` | 只在新值比較大時設 | **只延長、不縮短**——09 章的鎖續期正是這個需求 |
| `LT` | 只在新值比較小時設 | 只提前、不延後 |

📌 **`GT` 解決了一個真實的競爭問題**：
兩個執行緒同時想續鎖，一個算出「再 30 秒」、一個算出「再 10 秒」（它的時鐘慢）。
沒有 `GT` 的話，後到的那個會把鎖縮短到 10 秒；有 `GT` 就只會取比較長的那個。

**其他關於過期的邊界**：

```
127.0.0.1:6379> EXPIREAT gone 1000000000       ← 一個 2001 年的時間戳
(integer) 1
127.0.0.1:6379> EXISTS gone
(integer) 0                                     ← 設一個過去的時間 = 立刻刪掉

127.0.0.1:6379> SETEX k2 0 v
(error) ERR invalid expire time in 'setex' command    ← 0 秒不合法

127.0.0.1:6379> EXPIRE 不存在的key 100
(integer) 0                                     ← 不是錯誤，只是沒做事

127.0.0.1:6379> PERSIST k
(integer) 1                                     ← 拿掉過期時間，TTL 變 -1
```

⚠️ **`SETEX k 0 v` 會回錯誤，Java 這一側也是。** 實測：

```java
for (Duration d : new Duration[]{Duration.ZERO, Duration.ofSeconds(-5), Duration.ofMillis(500)}) {
    try {
        redis.opsForValue().set("z", "v", d);
        System.out.println(d + " -> OK, TTL=" + redis.getExpire("z")
                + " PTTL=" + redis.getExpire("z", TimeUnit.MILLISECONDS));
    } catch (Exception e) {
        System.out.println(d + " -> " + e.getClass().getSimpleName() + ": " + e.getMessage());
    }
}
```

```
PT0S     -> RedisSystemException: Error in execution
PT-5S    -> RedisSystemException: Error in execution
PT0.5S   -> OK, TTL=0 PTTL=498
```

兩個重點：

- **`Duration.ZERO` 與負數會拋例外**，而且例外訊息只有 `Error in execution`，看不出原因。
  「TTL 從設定檔讀進來、而設定檔漏了那一行」——**那一行漏掉時 `@Value` 注進來的是 0**，
  於是每一次寫快取都變成一個例外。這是很常見的上線事故。
- **最後一行又踩到 1.4.2 的四捨五入**：`PT0.5S` 的 key，`getExpire()` 回 `0`。
  如果你的程式碼寫 `if (ttl <= 0) 重設`，這個還活著的 key 會被你一直重設。

---

## 1.5 掃描 keyspace：`KEYS` 與 `SCAN`

### 1.5.1 實測：`KEYS` 在 500 萬個 key 上讓所有人等 0.73 秒

00 章 0.3.1 從 Java 這一側看過這個事故，這裡從 Redis 這一側再看一次。

```bash
docker exec redis-lab redis-cli FLUSHALL
docker exec redis-lab redis-cli DEBUG POPULATE 5000000
docker exec redis-lab redis-cli DBSIZE
```

```
(integer) 5000000
```

```
127.0.0.1:6379> INFO memory
used_memory_human:439.32M
```

**一邊量延遲、一邊跑 `KEYS *`**：

```bash
docker exec redis-lab redis-cli --latency -i 3 &
docker exec redis-lab redis-cli KEYS '*' > /dev/null
```

| | min | **max** | avg | 樣本數 |
|---|---|---|---|---|
| 沒人跑慢命令時（1M keys） | 0 ms | **7 ms** | 0.15 ms | 240 |
| 有人跑 `KEYS *`（1M keys） | 0 ms | **148 ms** | 3.20 ms | 198 |
| 有人跑 `KEYS *`（**5M** keys） | 0 ms | **726 ms** | 11.08 ms | 131 |
| 有人跑 `SCAN`（5M keys，COUNT 100） | 0 ms | **1 ms** | 0.01 ms | 272 |

**看最後兩行。** 同樣是走過 500 萬個 key：
`KEYS` 讓別人最久等 **726 毫秒**，`SCAN` 讓別人最久等 **1 毫秒**。

`SLOWLOG` 記錄的伺服器端耗時：

```
   3) (integer) 683656        ← 0.68 秒
   4) 1) "KEYS"
      2) "*"
   3) (integer) 727335        ← 0.73 秒
```

### 1.5.2 `SCAN` 的游標怎麼走

`SCAN` 把「走過整個 keyspace」拆成很多次小呼叫，每次回傳**一個游標**與**一批 key**：

```
127.0.0.1:6379> SCAN 0 COUNT 10
1) "896"                       ← 下一次要帶的游標
2)  1) "user:632"
    2) "user:120"
    ...
```

**你要做的是：拿著回傳的游標再問一次，直到游標變回 `0`。**

實測（1010 個 key、`COUNT 10`）：

```
  第 1 輪  游標 0      -> 896     這一輪拿到 10 個 key
  第 2 輪  游標 896    -> 544     這一輪拿到 12 個 key
  第 3 輪  游標 544    -> 144     這一輪拿到 10 個 key
  第 4 輪  游標 144    -> 48      這一輪拿到 10 個 key
  第 5 輪  游標 48     -> 496     這一輪拿到 10 個 key
  ...（共 95 輪，游標回到 0 才算走完一圈）
```

⚠️ **注意游標不是「第幾筆」**：896 → 544 → 144 → 48 → 496，它跳來跳去。

那個數字是 Redis 內部 hash table 的**桶編號，而且是二進位反轉後遞增的**。
這個看起來很怪的走法有一個很重要的理由：
**hash table 在掃描過程中可能會擴容或縮容（rehash），而這種走法能保證
「掃描開始前就存在、掃描結束時還在」的 key 一定會被看到至少一次。**

> 📌 **你不需要看懂反轉二進位**，你只需要記住兩件事：
> **① 游標是一個不透明的值，除了「原封不動傳回去」之外不要對它做任何事。**
> **② 只有游標等於 0 才代表結束。**

### 1.5.3 `SCAN` 保證什麼、不保證什麼

| | |
|---|---|
| ✅ **保證** | 掃描**開始前就存在、結束時仍存在**的 key，**至少**被回傳一次 |
| ❌ **不保證** | 掃描期間**新增**的 key 會被看到 |
| ❌ **不保證** | 掃描期間**刪除**的 key 不會被看到 |
| ❌ **不保證** | **每個 key 只出現一次**——它可能重複 |
| ❌ **不保證** | 每一輪都回傳資料（可能回傳空陣列，但游標不是 0） |

**最後兩條是實務上真的會咬人的。** 先看第五條：

```
  第 1 輪  游標 0      -> 896     符合 order:* 的有 0 個
  第 2 輪  游標 896    -> 544     符合 order:* 的有 1 個
  第 3 輪  游標 544    -> 144     符合 order:* 的有 0 個
  共 95 輪，其中 85 輪一個都沒撈到，總共找到 10 個
```

**95 輪裡有 85 輪是空的。** 原因是 `MATCH` 是**先撈出來、再篩掉**的：
Redis 每一輪取出 `COUNT` 個 key，然後把不符合 pattern 的丟掉，**剩下的才回給你**。

⚠️ **所以這樣寫是錯的**：

```java
// ❌ 錯：第一輪就是空的，迴圈直接結束
do {
    result = scan(cursor);
} while (!result.isEmpty());
```

```java
// ✅ 對：看游標，不看有沒有資料
do {
    result = scan(cursor);
    cursor = result.getCursor();
    處理(result.getKeys());
} while (!cursor.equals("0"));
```

（用 Spring 的 `Cursor` 就不會踩到這個，見 1.5.6。）

### 1.5.4 實測：`SCAN` 真的會吐出重複的 key

「可能重複」不是理論。**在掃描中間有大量 key 被刪掉（hash table 縮表）時，它就會發生。**

```java
package com.example.lab10.ch01;

import com.example.lab10.RedisProbe;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.HashSet;
import java.util.Set;

@SpringBootTest
class ScanTest {

    @Autowired StringRedisTemplate redis;
    @Autowired RedisProbe probe;

    @Test
    void scanCanReturnDuplicates() {
        System.out.println("═══ 1.5.4 SCAN 唯一不保證的事：不重複 ═══");
        probe.flushAll();
        redis.executePipelined((RedisCallback<Object>) c -> {
            for (int i = 1; i <= 200_000; i++) c.stringCommands().set(("k:" + i).getBytes(), "v".getBytes());
            return null;
        });
        System.out.println("開始 SCAN 前：" + String.format("%,d", probe.dbSize()) + " 個 key");

        Set<String> seen = new HashSet<>();
        int total = 0, dup = 0, deletedAt = -1;
        try (Cursor<String> cursor = redis.scan(ScanOptions.scanOptions().count(10).build())) {
            while (cursor.hasNext()) {
                String k = cursor.next();
                total++;
                if (!seen.add(k)) dup++;
                // 掃到一半，有別人刪掉了大量 key（hash table 縮表 → rehash）
                if (total == 1000 && deletedAt < 0) {
                    deletedAt = total;
                    redis.executePipelined((RedisCallback<Object>) c -> {
                        for (int i = 1; i <= 190_000; i++) c.keyCommands().del(("k:" + i).getBytes());
                        return null;
                    });
                    System.out.println("掃到第 1000 個時，另一支程式刪掉了 190,000 個 key（剩 "
                            + String.format("%,d", probe.dbSize()) + " 個）");
                }
            }
        }
        System.out.printf("SCAN 總共吐出 %,d 個 key，其中 %,d 個是重複的（不重複的有 %,d 個）%n",
                total, dup, seen.size());
    }
}
```

**連跑七次的結果**：

```
SCAN 總共吐出 10,956 個 key，其中 2 個是重複的（不重複的有 10,954 個）
SCAN 總共吐出 10,954 個 key，其中 0 個是重複的（不重複的有 10,954 個）
SCAN 總共吐出 10,955 個 key，其中 1 個是重複的（不重複的有 10,954 個）
SCAN 總共吐出 10,954 個 key，其中 0 個是重複的（不重複的有 10,954 個）
SCAN 總共吐出 10,954 個 key，其中 0 個是重複的（不重複的有 10,954 個）
SCAN 總共吐出 10,954 個 key，其中 0 個是重複的（不重複的有 10,954 個）
SCAN 總共吐出 10,954 個 key，其中 0 個是重複的（不重複的有 10,954 個）
```

**七次裡只有兩次出現重複，而且只重複一兩個。**

> ⚠️ **這個「很少發生」正是它危險的地方。**
> 你的批次程式用 `SCAN` 撈出一批 key 然後**對每個 key 做一次扣款 / 發一封信 / 送一則訊息**——
> 開發、測試、上線後的頭三個月，都不會重複。
> 然後某一天有人清了一批資料，某個使用者收到兩封信。
>
> **修法**：用 `SCAN` 掃出來的 key，**一定要當成「可能重複」來處理**——
> 丟進 `Set` 去重，或讓後續動作本身是冪等的（10 章）。

### 1.5.5 `COUNT` 該設多少

`COUNT` 是「**每一輪大概掃幾個桶**」的建議值，不是「回傳幾個 key」的保證。

實測，同樣 100 萬個 key 走完一整圈：

| `COUNT` | 走完一圈的總耗時 | 輪數（1010 個 key 時） |
|---|---|---|
| 10（預設） | **3.90 秒** | 95 輪 |
| 1000 | **0.53 秒** | 少很多 |

**`COUNT` 太小的代價是往返次數**：`COUNT 10` 掃 100 萬個 key 要送幾萬次命令，
每一次都是一個網路往返——0.5 節算過，往返才是瓶頸。

**`COUNT` 太大的代價是回到 `KEYS` 的老路**：一輪掃太多桶，那一輪就會佔用主執行緒比較久。

> 📌 **實務建議：`COUNT` 設 100～1000。**
> 這個範圍的每一輪都在微秒等級（1.5.1 的實測：`COUNT 100` 時別人的最大延遲是 1 毫秒），
> 而往返次數又不會太離譜。
>
> ⚠️ **`COUNT` 在有 `MATCH` 時要設大一點**——因為篩掉的那些也算在 `COUNT` 裡面，
> `COUNT 10` + 一個很少命中的 pattern，就是 1.5.3 那個「95 輪裡 85 輪是空的」。

`SCAN` 還可以按型別篩（Redis 6.0+）：

```
127.0.0.1:6379> SCAN 0 TYPE list COUNT 2000
1) "0"
2) 1) "mylist"
```

**`redis-cli` 自己就有現成的掃描工具**，不用自己寫迴圈：

```bash
docker exec redis-lab redis-cli --scan --pattern 'order:*' --count 1000
```

### 1.5.6 Spring 這一側：`keys()` 與 `scan()`

```java
@Test
void scanInJava() {
    System.out.println("═══ 1.5.6 Spring 這一側：keys() 與 scan() ═══");
    probe.flushAll();
    redis.executePipelined((RedisCallback<Object>) c -> {
        for (int i = 1; i <= 100_000; i++) c.stringCommands().set(("user:" + i).getBytes(), "v".getBytes());
        for (int i = 1; i <= 10; i++) c.stringCommands().set(("order:" + i).getBytes(), "v".getBytes());
        return null;
    });
    System.out.println("keyspace 裡有 " + String.format("%,d", probe.dbSize()) + " 個 key，其中 10 個是 order:");

    long s = System.currentTimeMillis();
    Set<String> byKeys = redis.keys("order:*");
    System.out.printf("keys(\"order:*\")               找到 %d 個，%,d ms%n",
            byKeys.size(), System.currentTimeMillis() - s);

    s = System.currentTimeMillis();
    Set<String> byScan = new HashSet<>();
    try (Cursor<String> cursor = redis.scan(ScanOptions.scanOptions().match("order:*").count(1000).build())) {
        while (cursor.hasNext()) byScan.add(cursor.next());
    }
    System.out.printf("scan(match=order:*, count=1000) 找到 %d 個，%,d ms%n",
            byScan.size(), System.currentTimeMillis() - s);

    probe.slowlog(2);
}
```

```
═══ 1.5.6 Spring 這一側：keys() 與 scan() ═══
keyspace 裡有 100,010 個 key，其中 10 個是 order:
keys("order:*")               找到 10 個，4 ms
scan(match=order:*, count=1000) 找到 10 個，31 ms
       2,528 µs  KEYS order:*
```

⚠️ **看清楚這個結果：`keys()` 比 `scan()` 快了 8 倍。**

**這正是這個陷阱誘人的地方。** `KEYS` 一次做完、只有一次往返；
`SCAN` 要跑幾十輪、幾十次往返，**牆鐘時間當然比較長**。

但 `SLOWLOG` 顯示 `KEYS order:*` 佔用了主執行緒 **2,528 微秒**——
**這 2.5 毫秒之內，這台 Redis 沒有服務任何其他人。**
而 `SCAN` 那 31 毫秒裡，每一輪只佔用主執行緒幾十微秒，**中間別人都插得進來**。

> 📌 **這是這一章最需要內化的一個觀念**：
> **在 Redis 上，你要優化的不是「我這個操作多快做完」，是「我佔用主執行緒多久」。**
> 一個慢 8 倍但不擋人的做法，永遠優於一個快 8 倍但擋住所有人的做法。

**三條實務規則**：

| | |
|---|---|
| ❌ 正式環境的程式碼裡**不該出現** `redisTemplate.keys(...)` | 它就是 `KEYS` |
| ✅ 需要按前綴找 key，用 `redisTemplate.scan(ScanOptions...)` | 記得 `try-with-resources`，`Cursor` 要關 |
| ✅ 更好的做法：**一開始就不要需要掃描** | 要「這個使用者的所有購物車項目」，就用一個 hash 存（02 章），而不是掃 `cart:u:8842:*` |

⚠️ **`Cursor` 一定要關，但「不關會怎樣」取決於你的連線設定**——這件事值得實測一次。

`redis.scan(...)` 回傳的 `Cursor` 會**綁住一條連線**直到它被關閉。
開 6 個 cursor、每個只讀一筆就丟掉（不 `close`），看 `connected_clients`：

| 設定 | 結果 |
|---|---|
| **Spring Boot 預設**（`shareNativeConnection=true`，所有命令共用一條連線） | 6 個沒關的 cursor：`connected_clients` 從頭到尾都是 **4**，什麼事都沒發生 |
| **連線池 + `shareNativeConnection=false`**（`max-active=4`、`max-wait=2s`） | 第 1、2、3 個：`connected_clients` 4 → 5 → 6。**第 4 個：`RedisConnectionFailureException: Unable to connect to Redis`** |

```
shareNativeConnection=false，pool max-active=4
一開始 connected_clients = 3
  第 1 個沒關的 cursor：OK，connected_clients = 4
  第 2 個沒關的 cursor：OK，connected_clients = 5
  第 3 個沒關的 cursor：OK，connected_clients = 6
  第 4 個沒關的 cursor：RedisConnectionFailureException / Unable to connect to Redis
```

> 📌 **這個對照要記住的不是「哪個設定比較好」，是這件事**：
> **同一段有 bug 的程式碼，在預設設定下完全沒事，換一組連線設定就炸。**
> 你在本機測不出來、在測試環境測不出來，因為那兩邊都用預設設定。
>
> 06 章會把 Lettuce 的連線模型講清楚（`shareNativeConnection` 到底在共用什麼、
> 什麼時候必須關掉它）。現在你只要**永遠用 `try-with-resources` 包住 `Cursor`**。

---

## 1.6 過期是怎麼**真的**發生的

到目前為止我們都說「key 過期了就不見了」。**這句話是錯的。**

真相是：**Redis 沒有為每個 key 開計時器。** 它用兩套機制在「事後」清理。

### 1.6.1 兩套機制

| | **惰性刪除**（lazy） | **主動過期**（active） |
|---|---|---|
| 什麼時候發生 | **有人來讀這個 key 的時候** | Redis 的事件迴圈裡，**每秒 10 次** |
| 做什麼 | 發現它過期了 → 刪掉、對外回 `nil` | 從**有設過期時間的** key 裡隨機抽 20 個，刪掉其中過期的 |
| 為什麼需要它 | 保證「讀到的一定不是過期資料」 | 保證「沒人讀的過期 key 也會被清掉」 |
| 漏洞 | **沒人讀就永遠不刪** | 它是**抽樣**的，不是全掃 |

**主動過期的細節**（Redis 7.2 的 `activeExpireCycle`）：
每次抽 20 個，如果這 20 個裡超過 **25%** 是過期的，就立刻再抽一輪，直到低於 25% 或超過時間預算。
**時間預算預設是 CPU 時間的 25%**——這是 Redis 刻意留的煞車：
**清過期 key 不能把服務時間吃光。**

「每秒 10 次」來自 `hz` 這個設定：

```
127.0.0.1:6379> CONFIG GET hz
1) "hz"
2) "10"
127.0.0.1:6379> CONFIG GET dynamic-hz
1) "dynamic-hz"
2) "yes"
```

`hz` 是 Redis 背景工作（清過期、關閒置連線、漸進式 rehash）的**每秒執行次數**，預設 10。
`dynamic-hz` 預設開著，代表連線數多的時候 Redis 會自動把實際頻率調高。

⚠️ **不要為了「讓過期更即時」去調高 `hz`。** 它會同時提高所有背景工作的頻率，
換來的是持續的 CPU 佔用，而過期的即時性仍然沒有保證（1.6.4 會說明為什麼）。

### 1.6.2 實測：關掉主動過期，看惰性刪除

只有一個辦法能把兩套機制分開看：**把主動過期關掉**（所以 00 章要開 `--enable-debug-command`）。

```bash
docker exec redis-lab redis-cli FLUSHALL
docker exec redis-lab redis-cli DEBUG SET-ACTIVE-EXPIRE 0
docker exec redis-lab redis-cli SET ghost v PX 100    # 100 毫秒後過期
sleep 1                                               # 等它過期，而且不要碰它
```

```
127.0.0.1:6379> DBSIZE
(integer) 1                    ← 過期 900 毫秒了，它還在

127.0.0.1:6379> GET ghost
(nil)                          ← 但讀不到

127.0.0.1:6379> DBSIZE
(integer) 0                    ← 剛才那一讀，才真的把它刪掉
```

**這三個回應要一起看**：

> **「`DBSIZE` 是 1」跟「`GET` 回 `nil`」同時成立。**
>
> 那個 key **邏輯上已經死了**（任何讀取都當它不存在），
> 但**實體上還佔著記憶體**，直到有人去碰它、或主動過期抽樣抽到它。

📌 **這解釋了一個常見的困惑**：
「我明明設了 TTL，為什麼記憶體沒有降下來？」——
因為那些 key 還沒被真正刪掉。`DBSIZE` 跟 `used_memory` 都會**延遲反映**過期。

把主動過期打開，它就會自己消失：

```bash
docker exec redis-lab redis-cli DEBUG SET-ACTIVE-EXPIRE 1
```

### 1.6.3 實測：100 萬個 key 同時到期

上一節的漏洞是「抽樣」。那如果**一次有一百萬個 key 同時過期**呢？

```bash
docker exec redis-lab redis-cli FLUSHALL
docker exec redis-lab bash -c \
  'for i in $(seq 1 1000000); do echo "SET session:$i 0123456789012345678901234567890123456789 EX 8"; done | redis-cli --pipe'
```

```
errors: 0, replies: 1000000
DBSIZE = 1000000   used_memory_human:139.60M
```

一邊量延遲，一邊每 0.5 秒看一次 `DBSIZE` 與記憶體：

```
  t= 0.5s DBSIZE=1,000,000  used_memory_human:139.64M
  t= 1.0s DBSIZE=1,000,000  used_memory_human:139.62M
  ...
  t= 5.0s DBSIZE=1,000,000  used_memory_human:139.62M
  t= 5.5s DBSIZE=  999,918  used_memory_human:139.61M   ← 開始清了
  t= 6.0s DBSIZE=  940,053  used_memory_human:128.02M
  t= 6.5s DBSIZE=  739,934  used_memory_human:102.80M
  t= 7.0s DBSIZE=  497,324  used_memory_human: 72.77M
  t= 7.5s DBSIZE=  247,767  used_memory_human: 42.63M
  t= 8.0s DBSIZE=   11,785  used_memory_human: 12.12M
  t= 8.5s DBSIZE=        0  used_memory_human:  1.53M   ← 清完了
```

同一段時間，其他客戶端的延遲（`redis-cli --latency`）：

```
0 26 0.88 775          ← min 0ms, max 26ms, avg 0.88ms, 775 個樣本
```

**三個結論**：

| 觀察 | 數字 | 意義 |
|---|---|---|
| 清完 100 萬個過期 key 花了多久 | **約 3 秒**（t=5.5 → t=8.5） | **過期不是瞬間的**。它以每秒約 33 萬個的速度在清 |
| 期間其他人的最大延遲 | **26 ms**（平常是 7 ms） | 主動過期會吃掉服務時間，但有 25% 的煞車在 |
| 記憶體什麼時候降下來 | **跟著 `DBSIZE` 一起降**，不是到期那一刻 | 容量規劃不能假設「到期就釋放」 |

> ⚠️ **這件事在正式環境的形狀是這樣的**：
> 你的 Session 統一設 30 分鐘 TTL。早上 9:00 上班尖峰進來 50 萬個人，
> **9:30 那一刻，50 萬個 session 同時到期。**
> Redis 會在那幾秒鐘吃掉額外的 CPU，你的 p99 延遲跳一下。
>
> **修法是把過期時間打散**：`EX (1800 + random(0, 300))`。
> 07 章的「快取雪崩」用的是同一招——**任何「一大批東西同時到期」的設計都要加隨機抖動。**

### 1.6.4 過期事件通知：它不是計時器

Redis 可以在 key 過期時發一個事件出來（keyspace notification）。
很多人想用它做「30 分鐘後自動取消訂單」這種延遲任務。**不要這樣做**，這一節解釋為什麼。

先打開通知（預設是關的）：

```bash
docker exec redis-lab redis-cli CONFIG SET notify-keyspace-events Ex
```

`Ex` 的意思是：`E` = keyevent 類型的事件、`x` = 只要 expired 事件。

**實驗一：事件什麼時候到？**

```bash
redis-cli PSUBSCRIBE "__keyevent@0__:expired"     # 一邊訂閱
redis-cli SET a v PX 500                          # 另一邊：500 毫秒後過期
```

```
1789540936.144  SET a v PX 500   (500ms 後過期)
1789540936.685  事件到達，key = a
```

設定時間 `.144`，應該在 `.644` 過期，事件 `.685` 才到——**晚了 41 毫秒**。

**實驗二：沒有人去讀它的時候呢？**

```bash
docker exec redis-lab redis-cli DEBUG SET-ACTIVE-EXPIRE 0     # 關掉主動過期
```

```
1789540940.176  SET b v PX 500
1789540943.191  3 秒過去，沒有事件。現在有人 GET b 一下：
1789540943.195  事件到達，key = b
```

**3 秒過去，事件沒有來。** 直到有人 `GET` 它，事件才在 4 毫秒內發出。

> 📌 **結論**：
> **過期事件不是「到時間就發」，是「這個 key 真的被刪掉的那一刻才發」。**
> 而「真的被刪掉」是由 1.6.1 的兩套機制決定的——**它可以晚幾十毫秒，也可以晚到天荒地老。**

**還有兩件更嚴重的事**：

| 問題 | 後果 |
|---|---|
| **Pub/Sub 是「射後不理」** | 你的服務**在重啟**、或網路斷了 3 秒——那段時間的過期事件**永遠消失**，不會補送 |
| **每個訂閱者都收到一份** | 你有三台機器都訂閱，同一個過期事件**三台都會處理**（要自己做冪等） |

> ⚠️ **所以「用過期事件做延遲任務」是一個經典的錯誤設計。**
> 「30 分鐘未付款自動取消訂單」要用的是**排程掃描資料庫**、或**延遲佇列**，
> 不是 Redis 的過期事件。
>
> **過期事件可以用在哪**：「快取失效時順便清一下本機快取」這種**掉了也無所謂**的事。

### 1.6.5 過期在主從之間

再開一台 Redis 當從庫（這是 13 章的主題，這裡只看過期的部分）：

```bash
docker network create redis-lab-net
docker network connect redis-lab-net redis-lab
docker run -d --name redis-replica --network redis-lab-net -p 16380:6379 redis:7.2 \
  redis-server --replicaof redis-lab 6379 --enable-debug-command yes --save "" --appendonly no
```

```
# 從庫
role:slave
master_link_status:up
# 主庫
role:master
connected_slaves:1
slave0:ip=172.20.0.3,port=6379,state=online,offset=449,lag=0
```

```
主庫 GET hello = world
從庫 GET hello = world                                        ← 複製過去了
從庫 SET x 1   = READONLY You can't write against a read only replica.
```

**現在看過期**（一樣先關掉主庫的主動過期，讓 key 停在「邏輯上過期但還沒被刪」的狀態）：

```
從庫 GET k2 = ''        (空 = nil，從庫知道它過期了)
從庫 TTL k2 = -2        (-2 = 它認為這個 key 不存在)
從庫 DBSIZE = 2         ← 但它還在從庫的字典裡

（主庫恢復主動過期 2 秒後）
從庫 DBSIZE = 1         ← 主庫送了 DEL 過來，這時才真的刪掉
```

**規則是這樣的**：

> **從庫不會自己刪過期的 key。** 只有主庫會刪，刪完送一條 `DEL` 給從庫。
> 但從庫**讀取時會自己判斷過期**，所以它不會回你過期的資料。

**為什麼要這樣設計**：如果從庫自己刪，主從之間就會出現「同一個 key，一邊有一邊沒有」的分歧。
讓刪除只從主庫發起，複製流就是唯一的真相來源。

⚠️ **這造成一個真實的維運困惑**：
**從庫的 `DBSIZE` 和 `used_memory` 會比主庫大**，而且主庫愈忙（主動過期被排擠），差距愈大。
看到這個不要以為是複製壞掉了。

### 1.6.6 在 `INFO` 裡看過期

```bash
docker exec redis-lab redis-cli INFO keyspace
```

```
db0:keys=1500,expires=1000,avg_ttl=3599950
```

| 欄位 | 意思 | 怎麼用 |
|---|---|---|
| `keys` | key 總數 | —— |
| `expires` | **其中有設過期時間的數量** | `keys - expires` 就是「永不過期的 key 有幾個」（1.4.3） |
| `avg_ttl` | 平均剩餘 TTL（毫秒，是估算值） | 大致看 TTL 設定是否符合預期 |

```bash
docker exec redis-lab redis-cli INFO stats | grep expired
```

```
expired_keys:1100006        ← 從啟動到現在，總共有幾個 key 因為過期被刪掉
```

📌 **這三個數字組成一個很有用的健康檢查**：

- `keys - expires` **一直變大** → 有程式在寫沒有 TTL 的 key（可能就是 1.4.3 的陷阱）。
- `expired_keys` **突然暴增** → 有一大批 key 同時到期（1.6.3 的情況），留意那一刻的延遲。
- `expired_keys` **一直是 0** 而你明明設了 TTL → 檢查是不是 TTL 被洗掉了。

---

## 1.7 Java 這一側

### 1.7.1 TTL 的 API

```java
package com.example.lab10.ch01;

import com.example.lab10.RedisProbe;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.concurrent.TimeUnit;

@SpringBootTest
class TtlInJavaTest {

    @Autowired StringRedisTemplate redis;
    @Autowired RedisProbe probe;

    @Test
    void ttlApiInSpring() {
        System.out.println("═══ 1.7.1 TTL 在 Spring 這一側長什麼樣子 ═══");
        probe.flushAll();

        redis.opsForValue().set("cart:alice", "耳機 x1", Duration.ofMinutes(30));
        System.out.println("set(k, v, Duration.ofMinutes(30))  getExpire = " + redis.getExpire("cart:alice") + " 秒");
        System.out.println("  換個單位           getExpire(k, MILLISECONDS) = "
                + redis.getExpire("cart:alice", TimeUnit.MILLISECONDS));

        redis.expire("cart:alice", Duration.ofHours(2));
        System.out.println("expire(k, 2 小時)                  getExpire = " + redis.getExpire("cart:alice") + " 秒");

        redis.persist("cart:alice");
        System.out.println("persist(k)                        getExpire = " + redis.getExpire("cart:alice") + "  ← -1");
        System.out.println("不存在的 key                       getExpire = " + redis.getExpire("根本沒有這個 key") + "  ← -2");
    }
}
```

```
═══ 1.7.1 TTL 在 Spring 這一側長什麼樣子 ═══
set(k, v, Duration.ofMinutes(30))  getExpire = 1800 秒
  換個單位           getExpire(k, MILLISECONDS) = 1799997
expire(k, 2 小時)                  getExpire = 7200 秒
persist(k)                        getExpire = -1  ← -1
不存在的 key                       getExpire = -2  ← -2
```

| Redis 命令 | Spring 的方法 |
|---|---|
| `SET k v EX 1800` | `opsForValue().set(k, v, Duration.ofMinutes(30))` |
| `EXPIRE k 7200` | `expire(k, Duration.ofHours(2))` |
| `TTL k` | `getExpire(k)` |
| `PTTL k` | `getExpire(k, TimeUnit.MILLISECONDS)` |
| `PERSIST k` | `persist(k)` |
| `DEL k` | `delete(k)` |
| `UNLINK k` | `unlink(k)` |

⚠️ **`getExpire(k)` 的 `-1` / `-2` 陷阱在 Java 這一側更容易踩**，
因為它回的是一個 `Long`，很容易被寫成：

```java
// ❌ 錯：key 不存在（-2）跟 key 永不過期（-1）被當成同一件事
if (redis.getExpire(key) < 0) {
    redis.expire(key, Duration.ofMinutes(30));   // key 不存在時，這行什麼也沒做，而且不報錯
}
```

```java
// ✅ 對
Long ttl = redis.getExpire(key);
if (ttl == null || ttl == -2) {
    // key 根本不在 —— 這是另一個問題，不是 TTL 問題
} else if (ttl == -1) {
    redis.expire(key, Duration.ofMinutes(30));   // 補上漏掉的 TTL
}
```

（`EXPIRE` 對不存在的 key 回 `0`、什麼也不做，見 1.4.6——**它不會報錯**，所以錯誤寫法會安靜地失效。）

### 1.7.2 「TTL 不見了」在 Java 這一側

1.4.3 的陷阱換成 Java 長這樣：

```java
System.out.println("═══ 1.7.2 Java 這一側的「TTL 不見了」 ═══");
redis.opsForValue().set("cart:bob", "耳機 x1", Duration.ofMinutes(30));
System.out.println("加入購物車後       TTL = " + redis.getExpire("cart:bob") + " 秒");

// 使用者多加了一件商品 —— 另一個開發者寫的另一支方法
redis.opsForValue().set("cart:bob", "耳機 x1, 保護殼 x1");
System.out.println("再加一件商品後     TTL = " + redis.getExpire("cart:bob") + "   ← 這台 Redis 從此多一個永不過期的 key");
```

```
═══ 1.7.2 Java 這一側的「TTL 不見了」 ═══
加入購物車後       TTL = 1800 秒
再加一件商品後     TTL = -1   ← 這台 Redis 從此多一個永不過期的 key
```

> ⚠️ **注意兩行程式碼的差別只有「有沒有第三個參數」。**
> 在 code review 裡，`set(key, value)` 這一行**沒有任何地方看起來是錯的**。
> 這就是為什麼這個 bug 幾乎每個團隊都有。

### 1.7.3 三種修法

```java
// 修法一：每次都重設 TTL（最常見，也最容易漏）
redis.opsForValue().set("cart:c1", "A", Duration.ofMinutes(30));
redis.opsForValue().set("cart:c1", "A,B", Duration.ofMinutes(30));

// 修法二：KEEPTTL —— Spring 沒有包在 opsForValue 上，要落到 connection 層
redis.opsForValue().set("cart:c2", "A", Duration.ofMinutes(30));
Thread.sleep(1100);
redis.execute((RedisCallback<Boolean>) conn -> conn.stringCommands().set(
        "cart:c2".getBytes(StandardCharsets.UTF_8),
        "A,B".getBytes(StandardCharsets.UTF_8),
        Expiration.keepTtl(), SetOption.upsert()));

// 修法三：改用 hash，欄位級更新不會動到 key 的 TTL
redis.opsForHash().put("cart:c3", "耳機", "1");
redis.expire("cart:c3", Duration.ofMinutes(30));
Thread.sleep(1100);
redis.opsForHash().put("cart:c3", "保護殼", "1");
```

需要的 import：

```java
import org.springframework.data.redis.connection.RedisStringCommands.SetOption;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.types.Expiration;
import java.nio.charset.StandardCharsets;
```

```
═══ 1.7.3 三種修法 ═══
修法一 每次都帶 Duration        TTL = 1800（但「30 分鐘」從頭算起了）
修法二 SET ... KEEPTTL           TTL = 1799（原本的倒數繼續走）
修法三 用 hash，改欄位不動 key   TTL = 1799
```

**看修法一與修法二的差別：1800 跟 1799。**
這一秒鐘的差距就是語意的差距：

| 修法 | 語意 | 什麼時候用 |
|---|---|---|
| **一：每次都帶 TTL** | **重新開始倒數**（滑動過期） | Session、「使用者還在用就不該過期」的東西 |
| **二：`KEEPTTL`** | **原本的倒數繼續走**（絕對過期） | 「這份資料最多活 30 分鐘」，不管中間改幾次 |
| **三：用 hash** | key 的 TTL 完全不受欄位更新影響 | 購物車這種「一個容器、很多欄位」的結構（02 章） |

> ⚠️ **修法二在 Spring 裡很醜，這不是你的錯。**
> `opsForValue()` 沒有提供 `KEEPTTL` 的多載，只能落到 `RedisCallback` 這一層。
> **這是 0.7.3 那個模式的第二次出現**：Spring Data Redis 是一層抽象，它蓋不住所有東西。

### 1.7.4 落地：shop-service 的 key 與 TTL 規約

把這一章的結論寫成專案裡的規約（後面每一章都會往這張表加東西）：

| 資料 | key 樣式 | TTL | 過期語意 | 為什麼 |
|---|---|---|---|---|
| 商品快取 | `shop:cache:product:{id}` | 10 分鐘 **+ 隨機 0～60 秒** | 絕對（`KEEPTTL`） | 隨機抖動避免 1.6.3 的同時到期 |
| 購物車 | `shop:cart:{userId}`（hash） | 30 天 | 欄位更新不影響（修法三） | 使用者的資料，不能被更新洗掉 TTL |
| Session | `shop:session:{sessionId}` | 30 分鐘 | **滑動**（`GETEX`） | 使用者還在用就不該登出 |
| 限流計數 | `shop:rate:{dimension}:{窗口}` | 窗口長度 + 10 秒 | 絕對（`EXAT` 對齊窗口） | 10 章 |
| 分散式鎖 | `shop:lock:{resource}` | 依業務估算 | 絕對，**只延長不縮短**（`GT`） | 09 章 |

**三條規約**：

1. **所有 key 都必須有前綴 `shop:`**——這台 Redis 未來可能被別的服務共用。
2. **所有 key 都必須有 TTL**，除非在這張表裡有明確的例外。
   上線前用 `INFO keyspace` 檢查 `keys` 與 `expires` 的差距（1.6.6）。
3. **禁止在應用程式碼裡使用 `keys()`**——用 `scan()`，或重新設計成不需要掃描。

---

## 1.8 常見誤區

**① 「`TTL` 回 0 代表沒有設過期時間」**

`-1` 才是沒有過期時間，`-2` 是 key 不存在，**`0` 是「還有不到半秒」**（1.4.2）。
需要精度就用 `PTTL` / `getExpire(k, MILLISECONDS)`。

**② 「設了 TTL 就不用管了」**

`SET` 會把它洗掉（1.4.3）。用 `INFO keyspace` 的 `keys` 與 `expires` 差距定期檢查。

**③ 「key 過期就馬上不見了」**

沒有計時器。惰性刪除 + 每秒 10 次的抽樣（1.6.1）。
沒人讀、又沒被抽到的 key，可以在記憶體裡待很久。

**④ 「用過期事件做延遲任務」**

事件會晚（實測 41 毫秒）、會不來（沒人讀且主動過期沒抽到）、**服務重啟期間的會永遠消失**（1.6.4）。

**⑤ 「`redisTemplate.keys("user:*")` 只是一個查詢」**

它是 `KEYS`。500 萬個 key 時讓所有人等 0.73 秒（1.5.1）。

**⑥ 「`SCAN` 掃出來的 key 不會重複」**

會。七次裡兩次（1.5.4）。**正因為罕見所以危險。**

**⑦ 「用 db1 放測試資料，跟正式環境隔離」**

同一條主執行緒、同一份 `maxmemory`、Cluster 不支援（1.2.4）。

**⑧ 「刪一個 key 是 O(1)，很快」**

刪一個 500 萬欄位的 hash，`DEL` 佔用主執行緒 **0.81 秒**（1.3.2）。不確定大小就用 `UNLINK`。

**⑨ 「所有 session 都設 30 分鐘，很整齊」**

尖峰進來的那批人會在 30 分鐘後**同時到期**（1.6.3）。加隨機抖動。

---

## 1.9 本章小結

**這一章只講了 key 跟 TTL，但它拆掉了四個預設的假設**：

| 你原本以為 | 實際上 |
|---|---|
| key 名稱只是個名字 | 它是記憶體成本（長名多 55%）、是維運介面、是一份合約 |
| 設了 TTL 就會準時消失 | 它會在「有人讀」或「被抽樣抽到」時才真的消失 |
| `SET` 只是換一個值 | 它會把 TTL 一起換掉（換成沒有） |
| 掃描 key 是個查詢 | `KEYS` 是一次全服務暫停；`SCAN` 是唯一的正解，而它會重複 |

### 1.9.1 驗收清單

- [ ] 說出 `TTL` 回傳 `-1`、`-2`、`0` 的三種意義。
- [ ] 說出五個會**保留** TTL 的命令、兩個會**清掉** TTL 的命令。
- [ ] 用 `KEEPTTL` 與 `GETEX` 各寫一次購物車更新，並說出兩者的語意差別。
- [ ] 說出 `SCAN` 保證什麼、不保證什麼（四條），並解釋「空的一輪」為什麼不代表結束。
- [ ] 用 `DEBUG SET-ACTIVE-EXPIRE 0` 重現一次「`DBSIZE` 是 1 但 `GET` 回 `nil`」。
- [ ] 說出為什麼從庫的 `DBSIZE` 會比主庫大。
- [ ] 說出為什麼「過期事件」不能拿來做延遲任務（三個理由）。
- [ ] 在你自己的專案裡找出一行 `keys(...)`，並說明它在正式環境的資料量下要跑多久。

### 1.9.2 本章練習

**練習一（15 分鐘）**：灌 50 萬個 `SET k:$i v EX 10` 的 key，
用 `redis-cli --latency -i 15` 量整段期間的延遲，同時每秒記錄一次 `DBSIZE`。
**畫出「key 數量隨時間下降」的曲線**，並標出延遲的尖峰落在哪裡。
接著把 TTL 改成 `EX (10 + 隨機 0~10)` 再跑一次——**兩張圖放在一起**，這就是 1.6.3 的修法。

**練習二（20 分鐘）**：寫一個「清掉所有 `shop:cache:*` 的 key」的工具方法。
要求：① 不能用 `KEYS`；② 要處理 `SCAN` 可能重複的問題；
③ 刪除要用 `UNLINK`；④ 要能回報「掃了幾輪、刪了幾個」。
寫完用 10 萬個 key 測一次，並用 `SLOWLOG` 確認**沒有任何一條命令超過 10 毫秒**。

**練習三（10 分鐘）**：把 1.7.3 的三種修法各寫成一個方法，
然後寫一個測試證明它們的語意差別：
「設定 TTL 30 秒 → 等 5 秒 → 更新一次 → 檢查 TTL」，
三種修法應該分別得到 30、25、25。

**練習四（進階，25 分鐘）**：實作一個 `TtlAuditor`：
用 `SCAN` 走過整個 keyspace，按 key 的**第一段前綴**分組，
統計每一組的「key 數量 / 有 TTL 的數量 / 平均 TTL / 總記憶體（`MEMORY USAGE` 加總）」。
這支工具在 14 章的上線檢查清單裡會用到——**它是找出「誰在漏 TTL」最快的方法。**

⚠️ 注意：`MEMORY USAGE` 對每個 key 呼叫一次，10 萬個 key 就是 10 萬次往返。
**想一想怎麼用 pipeline 把它變成幾十次**（03 章會講怎麼做，你可以先自己試）。

---

## 1.10 下一章預告

這一章把 key 當成一個「標籤」在看——但 key 指向的**值**才是重點。

下一章（02）進入 Redis 的五大資料結構：**String、Hash、List、Set、Sorted Set**。
它要回答的問題是：**同一份資料，用不同的結構存，差多少？**

- 一份 10 個欄位的使用者資料，10 萬筆：用 10 個 String 存要 **79.4 MB**、
  用 1 個 JSON String 存要 **30.7 MB**、用 1 個 Hash 存只要 **24.7 MB**。
  **而「改一個欄位」的差距更大**——200 個人同時加點數，JSON 版**掉了 198 次更新**，Hash 版一次都沒掉。
- 為什麼 Redis 對「小的集合」有一整套完全不同的內部表示（listpack），
  以及**超過門檻的那一刻會發生什麼**（提示：記憶體會跳一階）。
- 排行榜為什麼一定要用 Sorted Set，以及它的 `O(log N)` 在什麼規模下才開始有感覺。
- 「統計今天有多少不重複訪客」——100 萬個訪客，用 Set 要 **46.1 MB**，
  用 HyperLogLog 要 **14.1 KB**（**3362 倍**的差距），
  而你付出的代價是一個估計值（標準誤差 0.81%，這次實測估出 1,001,788，誤差 0.18%）。

這一章的 `MEMORY USAGE` 與 `OBJECT ENCODING` 會一路用到底。
