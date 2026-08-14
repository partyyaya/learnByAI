# 第 03 章：Bitmap、HyperLogLog、GEO 與 Bloom Filter

> 上一章的五大結構能解決八成問題。但有一類需求，用它們做會在記憶體上付出誇張的代價。
> 「統計一億使用者今天有誰上線過」用 Set 存要幾 GB，用 Bitmap 是 12MB。
> 「統計每天的不重複訪客數」用 Set 存一億個 ID 要好幾 GB，用 HyperLogLog 是固定 12KB。
> 這章講的四個結構，共同特徵是**用某個代價換取記憶體上的數量級優勢**——而那個代價是什麼、能不能接受，就是本章要教你判斷的事。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 用 Bitmap 實作簽到、連續登入天數與活躍使用者統計，並算出記憶體用量。
- 說明 Bitmap 在 ID 稀疏時反而更浪費記憶體，以及該怎麼處理。
- 用 HyperLogLog 做大規模 UV 統計，並說清楚它的誤差與三個「做不到的事」。
- 用 GEO 實作「附近的店」，並知道它底層就是 Sorted Set。
- 用 Bloom Filter 解決快取穿透，並說明誤判率、不可刪除等限制。
- 面對統計類需求時，能算出「精確方案」與「近似方案」的記憶體差距，做出取捨。

---

## 3.2 開場：同一個需求，記憶體差一千倍

需求：**統計一個一億使用者的 App，某天有哪些人登入過，並回答「今天有幾人登入」和「使用者 X 今天登入了嗎」。**

假設當天有 2000 萬人登入。

### 方案 A：Set 存 userId

```bash
SADD login:20260813 1001 1002 1003 ...
SCARD login:20260813              # 幾人登入
SISMEMBER login:20260813 1001     # X 登入了嗎
```

功能完全滿足。記憶體呢？Set 存 2000 萬個整數，即使用 intset 編碼（實際上超過 `set-max-intset-entries` 就會轉 hashtable），每個元素連同 hashtable 開銷大約幾十 bytes。**實測量級在 1GB 以上。**

### 方案 B：Bitmap，用 userId 當位元位移

```bash
SETBIT login:20260813 1001 1      # 使用者 1001 登入
GETBIT login:20260813 1001        # X 登入了嗎
BITCOUNT login:20260813           # 幾人登入
```

功能同樣滿足。記憶體是多少？

```text
最大 userId = 1 億
需要的位元數 = 1 億 bits
= 100,000,000 / 8 bytes
= 12,500,000 bytes
≈ 12MB
```

**注意這個 12MB 和「當天有幾人登入」無關**——不管當天登入 100 人還是 1 億人，只要最大 userId 是 1 億，就是 12MB。

**1GB vs 12MB，差了約 80 倍，而且功能完全一樣。**

### 方案 C：HyperLogLog

如果你**只需要「幾人登入」，不需要「X 登入了嗎」**：

```bash
PFADD login:hll:20260813 1001 1002 1003
PFCOUNT login:hll:20260813       # 約幾人登入（有誤差）
```

記憶體：**固定 12KB**，不管你放一萬個還是一億個元素。

代價是兩個：數字有約 0.81% 的誤差，而且**你完全無法查詢單個元素是否存在**——它根本不儲存成員。

### 三個方案的取捨

| | Set | Bitmap | HyperLogLog |
|---|---|---|---|
| 記憶體（1 億使用者規模） | ~1GB+ | ~12MB | 12KB |
| 精確計數 | 是 | 是 | 否（約 0.81% 誤差） |
| 查單個成員是否存在 | 是 | 是 | **否** |
| 列出所有成員 | 是 | 否（只能掃位元） | 否 |
| 成員必須是連續整數 | 否 | **是** | 否 |

**這章的核心思路：先問清楚「你真的需要什麼」，再選結構。** 很多人用 Set 存幾千萬個 ID，其實他只需要一個數字。

---

## 3.3 Bitmap：把 String 當位元陣列

Bitmap 不是獨立型別，它就是 String——只是用位元操作命令來存取。所以它的上限也是 512MB，也就是 2^32 個位元（約 42.9 億）。

### 核心命令

```bash
SETBIT key offset 0|1        # 設定第 offset 個位元，回傳原本的值
GETBIT key offset            # 讀取第 offset 個位元
BITCOUNT key [start end [BYTE|BIT]]   # 數有幾個 1
BITPOS key 0|1 [start [end [BYTE|BIT]]]  # 找第一個 0 或 1 的位置
BITOP AND|OR|XOR|NOT destkey key [key ...]   # 位元運算
BITFIELD key ...             # 把位元陣列當多個整數欄位操作
STRLEN key                   # 佔用幾 bytes
```

`BYTE|BIT` 選項是 7.0 加的，讓 `BITCOUNT` / `BITPOS` 的範圍可以按位元而不只按位元組指定，做「某個位元區間」的統計時方便很多。

### 用法 1：每月簽到日曆

一個使用者一個月最多 31 天，所以用 31 個位元就夠：

```bash
# 使用者 1001 在 2026 年 8 月，第 13 日簽到（用 day - 1 當 offset）
SETBIT signin:1001:202608 12 1

# 這個月簽到幾天
BITCOUNT signin:1001:202608
# (integer) 1

# 8 月 13 日簽到了嗎
GETBIT signin:1001:202608 12
# (integer) 1

# 佔多少空間
STRLEN signin:1001:202608
# (integer) 2      <- 只要 2 bytes（13 個位元需要 2 bytes）
```

**一千萬使用者的月簽到資料，總共約 4 bytes × 1000 萬 = 40MB。** 用關聯式資料庫存「使用者 × 日期」一筆一列，一千萬使用者 × 30 天 = 3 億筆記錄，這是完全不同量級的成本。

### 用法 2：連續簽到天數

`BITPOS` 可以找出第一個 0 的位置，這正好是「連續簽到中斷的地方」：

```bash
# 假設今天是 15 日，使用者 8-14 日都簽到了，15 日還沒
SETBIT signin:1001:202608 7 1     # 8 日
SETBIT signin:1001:202608 8 1     # 9 日
SETBIT signin:1001:202608 9 1     # 10 日
SETBIT signin:1001:202608 10 1
SETBIT signin:1001:202608 11 1
SETBIT signin:1001:202608 12 1
SETBIT signin:1001:202608 13 1    # 14 日

BITCOUNT signin:1001:202608       # (integer) 7  這個月共簽 7 天
```

要算「到今天為止的連續天數」，實務上有兩種做法：

**做法一：用 `BITFIELD` 一次取出整個月的位元，在應用層算。**

```bash
# 取出前 31 個位元當成一個無號整數（u31）
BITFIELD signin:1001:202608 GET u31 0
# (integer) 4064256     <- 二進位形式就是簽到記錄
```

拿到整數後在應用層用位元運算從今天往回數，這是 O(31) 的迴圈，非常快。

**做法二：單獨維護一個「連續天數」計數器。**

```bash
# 簽到時：檢查昨天是否簽到，決定是累加還是重置
GETBIT signin:1001:202608 11      # 昨天（12 日）
# 是 1 -> INCR streak:1001
# 是 0 -> SET streak:1001 1
```

做法二讀取更快（O(1)），但需要在簽到邏輯裡維護狀態，且跨月時要處理邊界。實務上做法一更不容易出錯，因為狀態只有一份。

### 用法 3：活躍使用者的集合運算

`BITOP` 讓你能對多天的 Bitmap 做位元運算，這是 Bitmap 最有價值的能力：

```bash
# 三天的登入記錄
SETBIT login:20260811 1001 1
SETBIT login:20260811 1002 1
SETBIT login:20260812 1001 1
SETBIT login:20260813 1001 1
SETBIT login:20260813 1003 1

# 連續三天都登入的人（AND）
BITOP AND active:3days login:20260811 login:20260812 login:20260813
BITCOUNT active:3days
# (integer) 1      <- 只有 user 1001

# 三天內有登入過的人（OR）= 三日活躍
BITOP OR active:any login:20260811 login:20260812 login:20260813
BITCOUNT active:any
# (integer) 3

# 昨天登入但今天沒登入的（流失預警）
BITOP NOT not_today login:20260813
BITOP AND churn login:20260812 not_today
BITCOUNT churn
```

用 SQL 做同樣的「連續 30 天活躍使用者」查詢，你需要 30 次 JOIN 或一個複雜的 `GROUP BY HAVING`，在億級資料上會跑很久。`BITOP` 是在記憶體裡做位元運算，速度是另一個層次。

**但要注意 `BITOP` 的複雜度是 O(N)**，N 是最長 Bitmap 的位元組數。對 12MB 的 Bitmap 做 30 個 key 的 AND，這是實實在在的重活，會阻塞單執行緒。所以：

```text
BITOP 適合放在離線 / 定時任務，不要放在線上請求路徑
運算結果存到一個 key，線上請求只讀結果
```

### 用法 4：`BITFIELD` 把位元當多個小整數

`BITFIELD` 讓你在一個 String 裡塞多個任意寬度的整數欄位，適合存「量很大但每個值範圍很小」的資料：

```bash
# 在一個 key 裡存多個使用者的「等級」，每人用 4 個位元（0-15 級）
BITFIELD user:levels SET u4 0 5 SET u4 4 12 SET u4 8 3
BITFIELD user:levels GET u4 0 GET u4 4 GET u4 8
# 1) (integer) 5
# 2) (integer) 12
# 3) (integer) 3

# 也支援原子增減，並可指定溢出行為
BITFIELD user:levels OVERFLOW SAT INCRBY u4 0 20
# SAT = 飽和（超過上限就停在 15），還有 WRAP（環繞）和 FAIL（失敗回 nil）
```

`OVERFLOW SAT` 很實用——例如「經驗值最多累到 255 就不再增加」，不需要在應用層判斷。

實務上 `BITFIELD` 用得不多，但在「數億個小數值」的場景（例如每個使用者的一個狀態碼）能省下大量記憶體。

### Bitmap 的關鍵陷阱：ID 稀疏

**Bitmap 的記憶體只取決於最大的 offset，和實際有幾個 1 完全無關。**

```bash
SETBIT sparse 1000000000 1     # 只設一個位元，但 offset 是 10 億
STRLEN sparse
# (integer) 125000000          <- 125MB！只為了存一個位元
```

所以以下情況**不要用 Bitmap**：

- **ID 是雪花 ID 或 UUID**：offset 會是天文數字，直接超過 2^32 上限。
- **ID 是自增但起始值很大**（例如從 10 億開始）：前面的位元全是浪費。
- **使用者數少但 ID 分布極廣**：例如只有 1000 個使用者，但 ID 從 1 到 10 億隨機分布——用 Set 存 1000 個 ID 只要幾十 KB，Bitmap 要 125MB。

判斷準則：

```text
Bitmap 的效率 ≈ 實際元素數 / 最大 ID

比例接近 1（ID 密集）      -> Bitmap 大勝
比例低於 1%（ID 稀疏）     -> Set 更省，Bitmap 反而是災難
```

**如果 ID 稀疏但你又想用 Bitmap，標準做法是「建立一層 ID 映射」**：維護一個「業務 ID → 連續序號」的對照表（放在資料庫或 Redis Hash），Bitmap 用連續序號當 offset。這增加了一次查詢，但換來記憶體上的優勢。這是資料倉儲裡常見的做法。

---

## 3.4 HyperLogLog：用 12KB 數一億

HyperLogLog（HLL）解決一個很特定的問題：**估算一個集合有多少個不重複元素（基數），但不需要知道那些元素是什麼。**

### 核心命令

只有三個：

```bash
PFADD key element [element ...]     # 加入元素，回傳 1 表示內部估算值有變化
PFCOUNT key [key ...]               # 估算基數（多個 key 會算聯集）
PFMERGE dest source [source ...]    # 合併多個 HLL 到 dest
```

用起來非常簡單：

```bash
PFADD uv:20260813 "user:1001" "user:1002" "user:1003"
PFADD uv:20260813 "user:1001"      # 重複加入不會增加計數
PFCOUNT uv:20260813
# (integer) 3

# 算一週的 UV（聯集，不是七天相加）
PFCOUNT uv:20260807 uv:20260808 uv:20260809 uv:20260810 uv:20260811 uv:20260812 uv:20260813

# 或先合併起來存著
PFMERGE uv:week:2026-W33 uv:20260807 uv:20260808 uv:20260809
PFCOUNT uv:week:2026-W33
```

`PFCOUNT` 支援多 key 這件事很關鍵。**「一週 UV」不等於「七天 UV 相加」**——同一個人週一週二都來，相加會算兩次。HLL 的聯集運算正確處理了去重，這是它相對「每天存一個數字」的巨大優勢。

### 它為什麼能只用 12KB

不需要懂完整的數學，但直覺值得建立。

核心想法來自一個機率觀察：**把元素 hash 成隨機的位元串，觀察「開頭連續有幾個 0」。**

```text
如果 hash 值是隨機的：
  開頭有 1 個 0 的機率是 1/2
  開頭有 2 個 0 的機率是 1/4
  開頭有 k 個 0 的機率是 1/2^k

反過來推論：
  如果你觀察到「最多有 10 個開頭連續 0」
  那大概看過 2^10 ≈ 1024 個不同元素
```

所以只要記住「目前見過的最大前導零數量」，就能反推大概有多少個不同元素——而這只需要幾個位元的空間。

單一個觀察值的誤差會很大，所以 HLL 把 hash 空間分成 16384 個桶（bucket），每個桶獨立記錄自己的最大前導零數，最後用調和平均綜合。

```text
16384 個桶 × 每桶 6 bits = 98304 bits = 12288 bytes ≈ 12KB
```

這就是 12KB 的來源，也是為什麼標準誤差固定在 **0.81%** 左右。

補充一個實作細節：元素很少的時候，Redis 用一種「稀疏編碼」，實際佔用遠小於 12KB；等基數增長到一定程度才切換成 12KB 的稠密編碼。所以你的 HLL 一開始可能只有幾十 bytes。

### 誤差到底能不能接受

0.81% 的標準誤差意味著：

```text
真實 UV 100 萬     -> 估算可能落在 99.2 萬 ~ 100.8 萬
真實 UV 1 億       -> 估算可能落在 9919 萬 ~ 10081 萬
```

判斷方式：**這個數字是給人看的趨勢，還是要拿去算錢的？**

| 場景 | HLL 適合嗎 |
|------|-----------|
| 網站 UV 儀表板 | 適合。看趨勢，差 0.8% 沒人在意 |
| 文章不重複瀏覽數 | 適合 |
| 廣告曝光去重計費 | **不適合**。要算錢，客戶會逐筆對帳 |
| 「達成 100 萬 UV 發獎金」 | **不適合**。邊界值的誤差會有爭議 |
| 活躍使用者趨勢分析 | 適合 |

### HLL 的三個「做不到」

這是最常被誤解的部分，寫程式前一定要清楚：

**做不到 1：無法判斷單個元素是否存在。**

沒有 `PFEXISTS` 這種命令，因為 HLL **根本不儲存元素**——它只保留了 16384 個桶的統計值。原始資料進去之後就消失了。

所以「這個使用者今天來過嗎」用 HLL 是無解的。需要這個功能就用 Set 或 Bitmap。

**做不到 2：無法列出成員。**

同上，資料不在裡面。

**做不到 3：無法做交集。**

`PFMERGE` 只有聯集，沒有交集。想知道「週一和週二都來過的人數」，HLL 沒有直接的辦法。

理論上可以用容斥原理繞（`|A∩B| = |A| + |B| - |A∪B|`），但**兩個估算值相減會讓誤差放大**，特別是交集很小的時候，結果可能完全不可信甚至變成負數。**不建議這樣用。**

需要交集就用 Bitmap 的 `BITOP AND`，或 Set 的 `SINTERCARD`。

### 實務組合技

常見的做法是**分層使用**：

```bash
# 精確層：今天的活躍使用者（Bitmap，可查單人、可做交集）
SETBIT active:20260813 1001 1

# 估算層：長期趨勢（HLL，成本極低，可存好幾年）
PFADD uv:20260813 "user:1001"
```

Bitmap 只保留最近 30 天（過期就刪），HLL 每天 12KB 可以存十年也才 44MB。這樣既有精確的近期資料，也有便宜的長期趨勢。

---

## 3.5 GEO：地理位置查詢

GEO 解決「找出某個座標附近的東西」這類需求。

### 它其實就是 Sorted Set

這點知道了會少踩很多坑。GEO 的實作方式是：把經緯度用 **geohash** 演算法編碼成一個 52 位元的整數，當成 Sorted Set 的 score。

```bash
GEOADD stores 121.5654 25.0330 "taipei-101"
TYPE stores
# zset          <- 它就是個 Sorted Set

ZSCORE stores "taipei-101"
# "3886757024470337"    <- 這是 geohash 編碼後的整數
```

推論：**所有 Sorted Set 的命令都可以用在 GEO key 上。** 例如用 `ZREM` 刪除一個地點、用 `ZCARD` 數有幾個地點——官方也是這樣建議的（GEO 沒有 `GEODEL` 命令，就是因為用 `ZREM` 即可）。

### 核心命令

```bash
GEOADD key [NX|XX] [CH] longitude latitude member [...]
GEOPOS key member [member ...]        # 查座標
GEODIST key m1 m2 [M|KM|FT|MI]        # 兩點距離
GEOHASH key member                     # 取標準 geohash 字串（可用於 geohash.org）

# 6.2+ 的統一搜尋命令，建議用這個
GEOSEARCH key <FROMMEMBER member | FROMLONLAT lon lat>
          <BYRADIUS r unit | BYBOX w h unit>
          [ASC|DESC] [COUNT n [ANY]] [WITHCOORD] [WITHDIST] [WITHHASH]

GEOSEARCHSTORE dst src ...            # 結果存到另一個 key
```

`GEORADIUS`、`GEORADIUSBYMEMBER` 在 6.2 之後被 `GEOSEARCH` 取代，已 deprecated。舊命令還有個坑：它會修改 key（因為支援 `STORE` 選項），所以在舊版被歸類為寫命令，**無法在從節點上執行**。`GEOSEARCH` 是純讀命令，可以走從節點。

### 實作「附近的店」

```bash
GEOADD stores 121.5654 25.0330 "taipei-101"
GEOADD stores 121.5170 25.0478 "taipei-main-station"
GEOADD stores 121.5482 25.0339 "daan-park"
GEOADD stores 120.6839 24.1377 "taichung-station"

# 找出以某座標為中心、3 公里內的店，按距離排序，最多 10 個
GEOSEARCH stores FROMLONLAT 121.5654 25.0330 BYRADIUS 3 KM ASC COUNT 10 WITHDIST
# 1) 1) "taipei-101"
#    2) "0.0000"
# 2) 1) "daan-park"
#    2) "1.7XXX"

# 以某個既有成員為中心找附近
GEOSEARCH stores FROMMEMBER "taipei-101" BYRADIUS 5 KM ASC WITHDIST WITHCOORD

# 兩點距離
GEODIST stores "taipei-101" "taichung-station" KM
# "130.XXXX"

# 矩形範圍搜尋（適合地圖視窗）
GEOSEARCH stores FROMLONLAT 121.5 25.0 BYBOX 10 10 KM ASC
```

`BYBOX` 對應「地圖上可見範圍內的所有店」這種需求，比圓形範圍更貼合 UI。

### 三個實務注意事項

**注意 1：緯度有範圍限制。** geohash 的實作只支援緯度 -85.05112878 到 85.05112878。極地附近的座標會被拒絕。一般業務用不到，但如果你在做全球性的服務要知道。

**注意 2：精度有極限。** geohash 編碼會有誤差，官方文件說明誤差在 0.5 公尺以下。對「找附近的店」完全夠用，但不要拿它做需要公分級精度的事。

**注意 3：`COUNT` 的效能意義。** 沒有 `COUNT` 時，`GEOSEARCH` 會找出範圍內的所有成員；範圍很大時這是一個慢命令。加上 `COUNT n` 能限制回傳量，再加 `ANY` 選項可以「找到 n 個就立刻返回」（不保證是最近的 n 個，但快很多）。

```bash
GEOSEARCH stores FROMLONLAT 121.5 25.0 BYRADIUS 50 KM COUNT 10 ANY
```

**什麼時候不該用 Redis GEO：** 如果你的需求包含「附近 + 多條件篩選 + 複雜排序」（例如「3 公里內、評分 4 星以上、目前營業中、按綜合分排序」），Redis GEO 只能給你第一個條件，剩下的要在應用層過濾——當範圍內有幾千家店時效率很差。這種需求該用 PostGIS 或 Elasticsearch 的 geo 查詢。

---

## 3.6 Bloom Filter：用機率換記憶體

Bloom Filter 回答一個問題：**這個元素「可能存在」還是「絕對不存在」？**

注意這個不對稱：

```text
回答「不存在」 -> 一定正確（不會有 false negative）
回答「存在」   -> 可能是誤判（有 false positive）
```

這個特性正好用來解決快取穿透：查詢一個不存在的 ID 時，Bloom Filter 能直接告訴你「這個 ID 絕對不在資料庫裡」，於是請求根本不用碰資料庫。

### 原理直覺

一個位元陣列 + k 個 hash 函式：

```text
加入元素 X：
  用 k 個 hash 函式算出 k 個位置，把這些位置設為 1

查詢元素 Y：
  算出 k 個位置，檢查是否都是 1
  有任何一個是 0 -> Y 絕對沒被加入過（因為加入時一定會把它們設 1）
  全部都是 1     -> Y 可能被加入過，也可能是其他元素恰好把這些位置都設成 1 了
```

「其他元素恰好湊出來的」就是誤判。誤判率取決於位元陣列大小、元素數量與 hash 函式數量——這三者可以調。

**也因為多個元素共用位元，Bloom Filter 無法刪除元素**：把某個元素的位元清成 0，可能會誤傷其他元素。

### 它不在 Redis 核心裡

Bloom Filter 由 **RedisBloom 模組**提供，標準 `redis:7.2` 鏡像沒有。要用它得換鏡像：

```yaml
services:
  redis:
    image: redis/redis-stack:latest      # 含 RedisBloom、RedisJSON、RediSearch、TimeSeries
    ports:
      - "6379:6379"
      - "8001:8001"                       # RedisInsight 的 Web UI
```

```bash
docker compose up -d
docker compose exec redis redis-cli
```

補充一個生態變化：**Redis 8.0 開始把這些模組能力併入核心發行版**（查詢引擎、JSON、TimeSeries、Bloom）。所以如果你用的是 Redis 8+，可能不需要額外的 stack 鏡像。但雲端託管服務的支援狀況差異很大——**設計架構前一定要先確認你的目標環境有沒有這些模組**，不要寫完才發現線上跑不動。

### 核心命令

```bash
# 建立：誤判率 1%，預期容量 100 萬
BF.RESERVE bloom:products 0.01 1000000

BF.ADD bloom:products "product:1001"       # 加入，回 1 表示是新元素
BF.MADD bloom:products "p1" "p2" "p3"      # 批次加入
BF.EXISTS bloom:products "product:1001"    # 1 = 可能存在，0 = 絕對不存在
BF.MEXISTS bloom:products "p1" "p9999"     # 批次查詢
BF.INFO bloom:products                      # 看容量、大小、已插入數量

# 也可以不預先 RESERVE，直接 BF.ADD 讓它用預設參數建立
# 但預設容量小，超出後會自動擴容並犧牲效能，建議明確 RESERVE
```

### 誤判率與記憶體的關係

`BF.RESERVE` 的兩個參數是取捨旋鈕：

| 誤判率 | 100 萬元素約需記憶體 |
|--------|-------------------|
| 10% | ~0.6MB |
| 1% | ~1.2MB |
| 0.1% | ~1.8MB |
| 0.01% | ~2.4MB |

對照組：用 Set 存 100 萬個 `product:xxxx` 字串，大約要 60-80MB。**Bloom Filter 是 1MB 量級，差了幾十倍。**

誤判率怎麼選？回到業務影響：

```text
誤判的後果是「本來可以直接擋掉的請求，被放行去查了資料庫」
=> 誤判率 1% 意味著 1% 的無效請求會穿透到資料庫
=> 對防穿透來說完全可以接受
```

所以防穿透場景用 1% 是常見選擇，不需要追求 0.01%。

### 實作快取穿透防護

```javascript
async function getProduct(id) {
  const key = `product:${id}`;

  // 第一層：Bloom Filter 擋掉絕對不存在的 ID
  const mayExist = await redis.call('BF.EXISTS', 'bloom:products', key);
  if (mayExist === 0) {
    return null;    // 絕對不存在，直接返回，不碰快取也不碰資料庫
  }

  // 第二層：快取
  const cached = await redis.get(key);
  if (cached !== null) {
    return cached === '' ? null : JSON.parse(cached);
  }

  // 第三層：資料庫
  const product = await db.findProduct(id);
  if (!product) {
    // 誤判造成的穿透，用空值快取兜底（短 TTL）
    await redis.set(key, '', 'EX', 60);
    return null;
  }

  await redis.set(key, JSON.stringify(product), 'EX', 300);
  return product;
}
```

**兩個必須處理的工程問題：**

**問題 1：Bloom Filter 要怎麼初始化？** 它必須包含資料庫裡所有現存的 ID。做法是在服務啟動或定期任務中，掃描資料庫把所有 ID 灌進去：

```javascript
// 分批掃，不要一次全載入記憶體
let lastId = 0;
while (true) {
  const rows = await db.query(
    'SELECT id FROM products WHERE id > ? ORDER BY id LIMIT 10000', [lastId]
  );
  if (rows.length === 0) break;
  const keys = rows.map(r => `product:${r.id}`);
  await redis.call('BF.MADD', 'bloom:products', ...keys);
  lastId = rows[rows.length - 1].id;
}
```

**問題 2：無法刪除怎麼辦？** 商品下架後，它的 ID 還在 Bloom Filter 裡（因為刪不掉），於是這些請求仍會穿透到資料庫。兩種處理：

- **接受它**。下架商品通常是少數，多出來的穿透量有限，而且後面還有空值快取兜底。
- **定期重建**。每天在低峰期建一個新的 Bloom Filter，完成後用 `RENAME` 原子切換。

```bash
# 建 bloom:products:new，灌完資料後
RENAME bloom:products:new bloom:products
```

如果你的業務**真的需要刪除**，RedisBloom 還提供 **Cuckoo Filter**（`CF.ADD` / `CF.EXISTS` / `CF.DEL`），它支援刪除，代價是插入可能失敗、記憶體效率略差。

---

## 3.7 其他模組能力（簡介）

知道有這些東西，需要時再深入：

**RedisJSON**：把 JSON 當原生型別，支援用 JSONPath 存取巢狀欄位。

```bash
JSON.SET user:1001 $ '{"name":"Alice","address":{"city":"Taipei"}}'
JSON.GET user:1001 $.address.city
JSON.NUMINCRBY user:1001 $.points 50
```

解決的問題是：不需要為了改一個巢狀欄位而整份讀寫。如果你的資料是深層 JSON 且需要局部更新，這比 Hash 更合適（Hash 只有一層）。

**RediSearch（查詢引擎）**：在 Redis 上做二級索引、全文搜尋、聚合、向量搜尋。

```bash
FT.CREATE idx:products ON HASH PREFIX 1 product: SCHEMA name TEXT price NUMERIC SORTABLE
FT.SEARCH idx:products "鍵盤" FILTER price 1000 3000 SORTBY price
```

這補上了 Redis「不能按內容查詢」的最大短板。但它不能取代 Elasticsearch——中文分詞、複雜相關性排序、海量資料的支援仍有差距。

**RedisTimeSeries**：時序資料，自動降採樣與聚合，適合監控指標。

**這些模組的共同注意事項：** 依賴模組會綁定你的部署方式。自建可以裝 redis-stack，但雲端託管不一定支援，而且遷移時會變成阻礙。**用模組前先確認整條部署路徑都支援。**

---

## 3.8 記憶體對比與選型總表

假設場景是「一億使用者規模的 App」：

| 需求 | 精確方案 | 記憶體 | 近似 / 優化方案 | 記憶體 | 代價 |
|------|---------|--------|----------------|--------|------|
| 今天誰登入過 | Set 存 ID | GB 級 | Bitmap | ~12MB | ID 必須密集 |
| 今天有幾人登入（只要數字） | Set | GB 級 | HyperLogLog | 12KB | 0.81% 誤差、無法查單人 |
| 這個 ID 存不存在 | Set | GB 級 | Bloom Filter | MB 級 | 有誤判、不能刪除 |
| 連續 30 天活躍 | 30 次 SQL JOIN | — | `BITOP AND` | 12MB × 30 | 運算是 O(N)，要離線做 |
| 附近的店 | 資料庫全表算距離 | — | GEO | 同 ZSet | 只能做距離篩選 |
| 每個使用者的小狀態值 | 一億個 key | GB 級 | `BITFIELD` | MB 級 | 需自己管理位移 |

### 選型決策樹

```text
你需要「精確的成員資訊」嗎（要能查單個、要能列出）？
├─ 需要
│  ├─ ID 是密集的連續整數，且每個成員只需要 0/1 狀態
│  │   -> Bitmap
│  ├─ 每個成員需要小整數值（不只 0/1）
│  │   -> BITFIELD
│  └─ 其他
│      -> Set / Hash（第 02 章）
│
└─ 不需要，只要「大概有多少個」
   ├─ 要能做交集
   │   -> Bitmap（BITOP）或 Set（SINTERCARD）
   └─ 只要聯集與總數，量極大
       -> HyperLogLog

特殊需求：
  只要判斷「絕對不存在」來擋請求  -> Bloom Filter
  地理位置範圍查詢                -> GEO
  深層 JSON 局部更新              -> RedisJSON
  按內容查詢 / 全文搜尋            -> RediSearch，或 Elasticsearch
```

---

## 3.9 常見錯誤

### 錯誤 1：對稀疏 ID 用 Bitmap

`SETBIT key 10000000000 1` 會配置一大塊記憶體。用 Bitmap 前先確認「最大 ID」是多少，並估算 `最大ID / 8` bytes 是否可接受。

### 錯誤 2：以為 HyperLogLog 可以查詢成員

它不存成員。需要「這個人來過嗎」就用 Bitmap 或 Set。

### 錯誤 3：把 HLL 的估算值用於計費或獎勵判定

0.81% 的誤差在邊界值會有爭議。要算錢就用精確方案。

### 錯誤 4：用容斥原理算 HLL 交集

兩個估算值相減會放大誤差，小交集時結果可能完全失真甚至為負。用 `BITOP AND`。

### 錯誤 5：把「一週 UV」寫成七天 UV 相加

會重複計算跨天的使用者。用 `PFCOUNT key1 key2 ...` 或 `PFMERGE`。

### 錯誤 6：在線上請求路徑做 `BITOP` 或大範圍 `GEOSEARCH`

都是 O(N) 的重活。改成定時任務算好存起來。

### 錯誤 7：Bloom Filter 沒有初始化就上線

空的 Bloom Filter 會回答「所有東西都不存在」，導致**所有正常請求都被擋掉**。這是很嚴重的線上事故。上線流程必須是：先灌完資料，驗證抽樣查詢都回 1，才開啟這段邏輯。

### 錯誤 8：以為 Bloom Filter 能取代空值快取

它有誤判，誤判的請求還是會穿透。兩者是搭配關係，不是替代關係。

### 錯誤 9：依賴模組但沒確認生產環境支援

`BF.ADD` 在標準 Redis 上會回 `ERR unknown command`。開發環境用 redis-stack、生產環境用託管的標準 Redis，就會在部署時炸掉。

---

## 3.10 本章練習

### 練習 1：算記憶體並選方案

一個 App 有 5000 萬使用者，userId 是從 1 開始的自增整數。以下三個需求各該用什麼結構？算出記憶體用量。

1. 「使用者 X 今天簽到了嗎」+「今天共幾人簽到」。
2. 「本月不重複活躍使用者數」，只要儀表板顯示。
3. 「連續 7 天都登入的使用者有幾人」。

<details>
<summary>參考解答</summary>

**1. 簽到查詢 + 計數 → Bitmap**

需要查單人（`GETBIT`），所以不能用 HLL。ID 是密集自增，適合 Bitmap。

```bash
SETBIT signin:20260813 1001 1
GETBIT signin:20260813 1001        # X 簽到了嗎
BITCOUNT signin:20260813           # 今天幾人
```

記憶體：`5000 萬 bits ÷ 8 = 6,250,000 bytes ≈ 6MB`（每天一個 key）。

保留 30 天 = 180MB，可接受。設 TTL 自動清理：

```bash
EXPIRE signin:20260813 2592000     # 30 天
```

對照：用 Set 存當天簽到的 ID（假設 1000 萬人簽到），大約要 500MB 以上。差了 80 倍。

**2. 本月活躍 UV（只要數字）→ HyperLogLog**

只要一個數字給儀表板看，可以接受誤差，不需要查單人。

```bash
PFADD uv:202608 "1001"
PFCOUNT uv:202608
```

記憶體：**12KB**。存十年（120 個月）也只要 1.4MB。

如果想同時支援「按日、按週、按月」，每天存一個 HLL 再用 `PFCOUNT` 多 key 聯集：

```bash
PFADD uv:20260813 "1001"
# 本月 UV = 把該月所有天的 key 一起算
PFCOUNT uv:20260801 uv:20260802 ... uv:20260813
```

每天 12KB，一年 4.4MB。這個方案更靈活，強烈推薦。

**注意：不能寫成「每天的 PFCOUNT 相加」**，那會重複計算多天都來的使用者。

**3. 連續 7 天登入 → Bitmap + `BITOP AND`**

```bash
BITOP AND active:7days login:20260807 login:20260808 login:20260809 \
  login:20260810 login:20260811 login:20260812 login:20260813
BITCOUNT active:7days
EXPIRE active:7days 86400
```

記憶體：運算結果同樣約 6MB。

**但這個 `BITOP` 是 O(N) 的重活**：7 個 6MB 的 Bitmap 做 AND，要處理約 4200 萬個位元組。這會阻塞單執行緒數十毫秒甚至更久。

所以正確的工程做法是：

```text
放在每日凌晨的定時任務執行 -> 結果存進 active:7days
線上請求只讀 BITCOUNT active:7days（O(N) 但只有一個 key，且可以再快取成一個數字）
```

更進一步，把結果直接存成一個 String：

```bash
SET stat:active7days:20260813 12345678
```

線上請求就是一次 O(1) 的 `GET`。

**這題的通用教訓：Bitmap 的集合運算能力很強，但要放在離線鏈路，把結果物化成便宜的形式供線上讀取。**

</details>

### 練習 2：Bloom Filter 上線計畫

你要為商品服務加上 Bloom Filter 防穿透。資料庫有 800 萬個商品，每天新增約 5000 個、下架約 2000 個。寫出完整的上線與維護計畫，並指出風險點。

<details>
<summary>參考解答</summary>

**第一步：建立 filter，容量要留餘裕**

```bash
# 容量設 2000 萬（不是 800 萬），為未來成長和「下架商品刪不掉」留空間
BF.RESERVE bloom:products 0.01 20000000
```

為什麼要留餘裕？RedisBloom 超過預設容量時會自動擴容（建立額外的 filter 層），但這會**增加查詢時要檢查的層數，降低效能，也提高實際誤判率**。一開始就給夠比較好。

記憶體估算：2000 萬元素、1% 誤判率，大約 24MB。完全可以接受。

**第二步：初始化，分批灌入**

```javascript
async function initBloom() {
  let lastId = 0;
  let total = 0;
  while (true) {
    const rows = await db.query(
      'SELECT id FROM products WHERE id > ? ORDER BY id LIMIT 5000', [lastId]
    );
    if (rows.length === 0) break;

    await redis.call('BF.MADD', 'bloom:products:building',
      ...rows.map(r => `product:${r.id}`));

    lastId = rows[rows.length - 1].id;
    total += rows.length;

    await sleep(20);   // 節流，避免灌資料本身造成負載尖峰
  }
  return total;
}
```

用 `BF.MADD` 批次加入而不是逐個 `BF.ADD`，減少往返次數。灌到一個臨時 key（`:building`）而不是正式 key。

**第三步：驗證，這步絕對不能省**

```javascript
// 抽樣驗證：已知存在的商品，必須全部回 1
const samples = await db.query('SELECT id FROM products ORDER BY RAND() LIMIT 1000');
const results = await redis.call('BF.MEXISTS', 'bloom:products:building',
  ...samples.map(r => `product:${r.id}`));

const missing = results.filter(r => r === 0).length;
if (missing > 0) {
  throw new Error(`驗證失敗：${missing} 個已知商品被判定為不存在，不可上線`);
}

// 反向抽樣：不存在的 ID 應該大部分回 0（誤判率應接近設定值）
const fakeIds = Array.from({length: 1000}, (_, i) => `product:999999${i}`);
const fpResults = await redis.call('BF.MEXISTS', 'bloom:products:building', ...fakeIds);
const fpRate = fpResults.filter(r => r === 1).length / 1000;
console.log(`實測誤判率：${(fpRate * 100).toFixed(2)}%`);   // 應該在 1% 附近
```

正向驗證（已知存在的都回 1）是**最關鍵的一步**。如果初始化中斷了或漏灌，Bloom Filter 會把正常商品判定為不存在，導致這些商品完全無法訪問——這比沒有 Bloom Filter 嚴重得多。

**第四步：原子切換並灰度開啟**

```bash
RENAME bloom:products:building bloom:products
```

程式端用開關控制，先開 1% 流量觀察，確認沒有異常的 404 才全開：

```javascript
if (featureFlag('bloom_filter_enabled', userId)) {
  const mayExist = await redis.call('BF.EXISTS', 'bloom:products', key);
  if (mayExist === 0) return null;
}
```

**第五步：維護新增商品**

在建立商品的交易成功後加入：

```javascript
async function createProduct(data) {
  const product = await db.createProduct(data);
  // 必須在資料庫成功後才加入，順序不能反
  await redis.call('BF.ADD', 'bloom:products', `product:${product.id}`);
  return product;
}
```

**這裡有個關鍵風險**：如果 `BF.ADD` 失敗（Redis 短暫不可用），這個新商品就會被 Bloom Filter 永久擋住，變成「商品明明存在卻打不開」。三個防護：

1. `BF.ADD` 失敗要記錄到告警日誌，不能靜默忽略。
2. 每天的重建任務會自然修復漏加的商品。
3. 更保險的做法：新商品建立後的一小段時間內（例如 10 分鐘）繞過 Bloom Filter 檢查。

**第六步：每日重建處理下架商品**

```text
每天凌晨 3 點：
  1. 建立 bloom:products:building
  2. 從資料庫灌入所有「上架中」的商品
  3. 抽樣驗證（同第三步）
  4. 驗證通過才 RENAME 覆蓋正式 key
  5. 驗證失敗則保留舊 filter 並告警，絕不切換
```

第 4、5 步的順序是重點：**寧可用舊的、稍微不準的 filter，也不要用一個可能有問題的新 filter。**

**風險總結**

| 風險 | 後果 | 防護 |
|------|------|------|
| 初始化不完整就上線 | 大量正常商品變成 404 | 上線前正向抽樣驗證 + 灰度 |
| 新商品的 `BF.ADD` 失敗 | 該商品永久無法訪問 | 告警 + 每日重建 + 新商品短期繞過 |
| 下架商品刪不掉 | 少量無效穿透 | 每日重建 + 空值快取兜底 |
| 容量估算不足 | 自動擴容導致效能下降、誤判率上升 | 容量給 2-3 倍餘裕 |
| 重建時 `RENAME` 前驗證失敗 | 若強行切換會造成大範圍 404 | 驗證不通過就不切換，只告警 |
| 生產環境沒有 RedisBloom 模組 | 部署後所有查詢報錯 | 上線前確認模組可用 + 程式加降級開關 |

最後一項最值得強調：**Bloom Filter 這段邏輯一定要有降級開關。** 一旦出問題，能立刻關掉回到「沒有 Bloom Filter，但功能正常」的狀態，而不是整個商品服務掛掉。

</details>

### 練習 3：實作月簽到功能

實作完整的簽到功能：簽到、查詢本月簽到日、本月簽到總天數、當前連續簽到天數。

<details>
<summary>參考解答</summary>

```javascript
// key: signin:{userId}:{YYYYMM}，offset = day - 1
function signinKey(userId, date) {
  const ym = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `signin:${userId}:${ym}`;
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// 簽到。回傳是否為今天第一次簽到
async function signin(userId, date = new Date()) {
  const key = signinKey(userId, date);
  const offset = date.getDate() - 1;

  // SETBIT 回傳「原本的值」，所以 0 代表這是今天第一次簽到
  const previous = await redis.setbit(key, offset, 1);

  // 保留 13 個月，方便查去年同期
  await redis.expire(key, 13 * 31 * 86400, 'GT');

  return previous === 0;
}

// 本月簽到總天數
async function monthlyCount(userId, date = new Date()) {
  return await redis.bitcount(signinKey(userId, date));
}

// 本月簽到的日期清單
async function signedDays(userId, date = new Date()) {
  const key = signinKey(userId, date);
  const total = daysInMonth(date);

  // 一次取出整個月的位元當成無號整數（最多 31 天，u31 夠用）
  const [bits] = await redis.bitfield(key, 'GET', `u${total}`, 0);

  const days = [];
  for (let i = 0; i < total; i++) {
    // u31 的第 0 個位元是最高位，所以要從左邊算
    if ((bits >> (total - 1 - i)) & 1) {
      days.push(i + 1);
    }
  }
  return days;
}

// 當前連續簽到天數（會跨月往前找）
async function currentStreak(userId, date = new Date()) {
  let streak = 0;
  let cursor = new Date(date);

  // 若今天還沒簽到，從昨天開始算
  const todaySigned = await redis.getbit(signinKey(userId, cursor), cursor.getDate() - 1);
  if (!todaySigned) {
    cursor.setDate(cursor.getDate() - 1);
  }

  // 逐月取出位元圖，在應用層往回數，避免逐日發命令
  while (true) {
    const key = signinKey(userId, cursor);
    const total = daysInMonth(cursor);
    const [bits] = await redis.bitfield(key, 'GET', `u${total}`, 0);

    if (bits === 0) break;    // 這個月完全沒簽到，中斷

    let day = cursor.getDate();
    let broken = false;
    while (day >= 1) {
      if ((bits >> (total - day)) & 1) {
        streak++;
        day--;
      } else {
        broken = true;
        break;
      }
    }

    if (broken) break;

    // 這個月從 1 號到 cursor 都連續，繼續往前一個月找
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 0);   // 上個月最後一天
  }

  return streak;
}
```

**五個設計要點**

**要點一：`SETBIT` 的回傳值就是「是否第一次簽到」。** 它回傳該位元原本的值，所以 `0` 代表原本沒簽到。這省掉了一次 `GETBIT`，也避免了「先查再寫」的競爭問題——如果用 `GETBIT` + `SETBIT` 兩步，併發下可能兩個請求都認為自己是第一次簽到，重複發放獎勵。

**要點二：一次取整月位元，在應用層算。** `signedDays` 和 `currentStreak` 都用 `BITFIELD GET u31 0` 一次拿完，而不是發 31 次 `GETBIT`。31 次往返在跨機房環境可能要 30ms 以上，一次是 1ms。

**要點三：連續天數要能跨月。** 8 月 1 日簽到、7 月 31 日也簽到，連續天數應該是 2 而不是 1。所以 `currentStreak` 在算完當月後會繼續往上個月找。這是實務上很常漏掉的邊界。

**要點四：位元順序要小心。** `BITFIELD GET u31 0` 把前 31 個位元當成一個整數，其中 offset 0 是**最高位**。所以判斷第 `i` 天（offset `i-1`）要用 `bits >> (total - i) & 1`。這裡極容易寫反，一定要寫測試驗證：

```javascript
// 測試：8 月的 1、2、5 日簽到
await redis.del('signin:test:202608');
await redis.setbit('signin:test:202608', 0, 1);
await redis.setbit('signin:test:202608', 1, 1);
await redis.setbit('signin:test:202608', 4, 1);
expect(await signedDays('test', new Date('2026-08-15'))).toEqual([1, 2, 5]);
```

**要點五：記憶體成本極低。** 每個使用者每月的簽到記錄是 4 bytes（31 個位元）。一千萬使用者一個月是 40MB，加上 key 本身的開銷大約 700MB——這裡反而是**key 的數量**成為主要成本（第 01 章講過的道理）。

如果一千萬使用者的規模讓你在意這個開銷，可以反過來設計：**用「日期」當 key，「userId」當 offset**：

```bash
SETBIT signin:20260813 1001 1        # 每天一個 key，userId 當位移
```

這樣 key 數量從「使用者數 × 月數」降到「天數」，一天一個 6MB 的 Bitmap（一千萬使用者）。代價是「查某人這個月簽到哪幾天」要讀 31 個 key 做 31 次 `GETBIT`。

**兩種設計的取捨：**

| | key = 使用者+月 | key = 日期 |
|---|---|---|
| 查單人本月記錄 | 1 次命令 | 31 次 `GETBIT`（可 pipeline） |
| 查今天總簽到人數 | 要掃全部使用者，不可行 | 1 次 `BITCOUNT` |
| 算連續 N 天活躍人數 | 不可行 | `BITOP AND` |
| key 數量 | 使用者數 × 月數 | 天數 |

**兩者其實可以並存**——這是實務上的常見選擇。使用者維度的 key 服務個人頁面，日期維度的 key 服務營運報表。寫入時多寫一次，換來兩邊都是最優查詢。

</details>

---

## 3.11 驗收清單

進入下一章前，確認你可以：

- [ ] 算出「N 個使用者的 Bitmap」佔多少記憶體，並和 Set 方案對比。
- [ ] 說明為什麼 Bitmap 的記憶體只取決於最大 offset，和實際元素數無關。
- [ ] 判斷什麼情況下 Bitmap 反而比 Set 浪費，以及 ID 映射的解法。
- [ ] 用 `BITOP` 算「連續 N 天活躍」，並說明為什麼要放在離線任務。
- [ ] 說出 HyperLogLog 的記憶體、誤差，以及三個「做不到的事」。
- [ ] 解釋為什麼「一週 UV」不能用七天 UV 相加。
- [ ] 說明為什麼不該用容斥原理算 HLL 的交集。
- [ ] 說明 GEO 底層就是 Sorted Set，以及這帶來什麼便利。
- [ ] 說出 Bloom Filter 的不對稱保證（「不存在」一定對，「存在」可能錯）。
- [ ] 設計一個安全的 Bloom Filter 上線流程，包含驗證與降級開關。
- [ ] 說明為什麼 Bloom Filter 不能取代空值快取。

---

前三章講的都是「用什麼」。下一章開始講「為什麼會慢」：[04-single-thread-model-and-performance.md](./04-single-thread-model-and-performance.md)，我們會拆開單執行緒模型，並學會找出 big key 與 hot key。
