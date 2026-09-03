# 第 03 章：索引與執行計畫

> 02 章結尾留了兩個問題：
>
> > **為什麼 `type: ref` 比 `type: index` 好一個數量級？**
> > **那個 `Covering index skip scan for grouping` 到底做了什麼，讓一句查詢只讀 2021 列而不是 10 萬列？**
>
> 這一章要回答它們。而在回答之前，先看一個數字。
>
> 兩句功能完全相同的 SQL，差別只有一個 `COLLATE`：
>
> ```sql
> SELECT COUNT(o.id) FROM ord o JOIN ord_legacy l ON l.order_no = o.order_no;
> SELECT COUNT(o.id) FROM ord o JOIN ord_legacy l ON l.order_no = o.order_no COLLATE utf8mb4_general_ci;
> ```
>
> ```
> 1.03 ms
> 2009 ms      ← 🔴 慢 1,950 倍
> ```
>
> **兩句都正確、兩句都回傳同一個答案、兩句都沒有警告。**
> 第二句只是把一個 100 萬列的表變成了驅動表。
>
> ⚠️ **這一章與前兩章有一個關鍵差別**：
>
> ```
> 01 章的錯 → 資料是錯的（型別、約束）
> 02 章的錯 → 答案是錯的（JOIN、NULL、聚合）
> 03 章的錯 → 答案是【對的】，只是慢了三個數量級
> ```
>
> **而「慢」這件事，在測試機上幾乎不存在。**
> 它在資料長到某個大小、在促銷的那一分鐘、在某個索引被人「順手清掉」之後才出現。
>
> 📌 **所以這一章的主軸不是「怎麼建索引」，而是**：
>
> > **怎麼在寫完 SQL 的當下，就知道它上線後會不會慢。**
>
> 而那個工具叫 `EXPLAIN`。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 畫出 InnoDB 的 B+Tree 結構，並用實測數字說明「100 萬列的表，查一列只要走 **3 層**」。
- 說出**聚簇索引**與**二級索引**的差別，以及「二級索引的葉節點存的是主鍵」造成的三個後果。
- 解釋**回表**是什麼，並用實測說明它的成本（同樣 2062 列：**0.55 ms vs 3.8 ms，慢 6.9 倍**）。
- 讀懂 `EXPLAIN` 的**十二個欄位**，尤其是 `type`（九種）、`key_len`（算術）、`Extra`（十四種）。
- 用 `key_len` **算出**一個複合索引實際被用到了幾個欄位。
- 說明 `rows` 與 `filtered` 是**估計值**，並用實測展示它的誤差範圍（**−34% ～ +112%**）。
- 分辨 `EXPLAIN` / `EXPLAIN FORMAT=TREE` / `EXPLAIN ANALYZE` / `optimizer_trace` 四種工具，並知道各自該用在哪。
- 說明**最左前綴**規則，以及 MySQL 8 的 **skip scan** 為什麼讓這條規則不再絕對（但也不該依賴）。
- 判斷一個 `ORDER BY` 能不能**消除排序**，並解釋 `Backward index scan` 與 `Using filesort` 的差別。
- 設計**覆蓋索引**，並說出「把欄位塞進索引」的兩個代價。
- 認出**索引失效的八種情境**，每一種都有 `EXPLAIN` 對照與修法 ——
  以及三個「修法不管用」的反例。
- 在**複合索引**與**多個單欄索引**之間做出有理由的選擇（實測：`AND` 查詢差 **68 倍**，`OR` 查詢反過來）。
- 用**前綴索引**、**函式索引**、**不可見索引**解決三類具體問題。
- 找出**冗餘索引**，並用一句 SQL 自動偵測它們。
- 說明**深分頁**為什麼越翻越慢，並用實測展示 seek 法快 **319 倍**。
- 用**直方圖**改善非索引欄位的估計（實測：`filtered` 從 33.33% 修正到 **20.20%**，實際是 20.12%）。
- 交出 shop-service 的完整索引設計，每一個索引都對應 02 章 2.9 的一句查詢。

---

## 3.2 B+Tree：為什麼查一列只要三次 I/O

### 3.2.1 先算成本

**本章的實驗表**：100 萬列訂單，狀態分布刻意做成真實的偏斜。

```sql
CREATE TABLE ord (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_no     VARCHAR(32)   NOT NULL,
  customer_id  INT           NOT NULL,
  status       VARCHAR(16)   NOT NULL,
  channel      VARCHAR(8)    NOT NULL,
  total_amount DECIMAL(19,4) NOT NULL,
  placed_at    DATETIME(3)   NOT NULL,
  remark       VARCHAR(200)  NULL
) ENGINE=InnoDB CHARSET=utf8mb4;
```

```
插入 1000000 列，9.6 秒
TABLE_ROWS≈996311  資料 79.6 MB  索引 0.0 MB

狀態分布：
  DELIVERED    749685  74.97%       ← 刻意偏斜：真實系統就是這樣
  SHIPPED       79800   7.98%
  CANCELLED     60513   6.05%
  PAID          49977   5.00%
  PACKED        29987   3.00%
  PENDING       20182   2.02%
  REFUNDED       9856   0.99%
```

⚠️ **`TABLE_ROWS` 是 996311 而不是 1000000** ——
`information_schema.TABLES` 的列數是**估計值**（3.4.5 會回來處理這件事）。

**然後建三個「基礎索引」** —— 本章從 3.2.3 到 3.9 一直在用它們：

```sql
ALTER TABLE ord
  ADD UNIQUE KEY uk_order_no       (order_no),
  ADD KEY        idx_cust_placed   (customer_id, placed_at),
  ADD KEY        idx_status_placed (status, placed_at);
ANALYZE TABLE ord;                 -- ★ 讓 mysql.innodb_index_stats 是新的（3.9.1）
```

📌 **除了這三個之外，本章每一個實驗要用的索引都在用到的那一節現場建**：

```
idx_cover        (customer_id, placed_at, status, total_amount)   3.3.3
idx_abc          (status, channel, customer_id)                   3.4.3
idx_placed       (placed_at)                                      3.5.5（3.7.7 拿掉再加回、3.8.4 拿它示範 INVISIBLE）
idx_cp_desc      (customer_id ASC, placed_at DESC)                3.5.5（量完就刪）
idx_placed_date  ((CAST(placed_at AS DATE)))                      3.7.1
idx_cust_status  (customer_id, status)                            3.9.3
```

⚠️ **它們是【累加】的，不會自動消失** ——
所以 3.9.3 的 `EXPLAIN` 看到的是「三個基礎索引 + 上面這些」的狀態。
**如果你跳著做某一節，`EXPLAIN` 的 `key` 欄位就會跟課程不一樣**
（優化器是拿「現有的索引」在比成本）。

**問題**：在這 100 萬列裡找 `id = 500000` 那一列。三種做法的成本：

| 做法 | 要讀多少 | 為什麼不行 |
|---|---|---|
| 從頭掃到尾 | 平均 50 萬列（79.6 MB / 2） | 🔴 O(n) |
| 排序 + 二分搜尋 | log₂(1,000,000) ≈ **20 次** | 🟡 每次都是一次**磁碟**讀取 —— 20 次隨機 I/O |
| **B+Tree** | **3 次** | ✅ 而且其中兩次幾乎一定在記憶體裡 |

📌 **關鍵在於「一次讀取的單位」**：

```
二分搜尋的思路：一次讀一【列】
B+Tree 的思路：一次讀一【頁】（InnoDB 預設 16 KB）
                ↓
                一頁裝得下幾百列或幾百個索引項
                ↓
                每一層就能分出幾百個岔路，而不是 2 個
```

```sql
SELECT @@innodb_page_size;
```

```
16384
```

### 3.2.2 結構

```
                        ┌─────────────────────────────┐
   第 3 層（根）         │  [1|→] [3862|→] ... [→]     │  1 頁
                        └───┬─────────┬───────────────┘
                            │         │
           ┌────────────────┘         └────────────────┐
           ▼                                           ▼
   ┌───────────────────┐                     ┌───────────────────┐
   │ [1|→][197|→]...   │  第 2 層（內部節點） │ [3862|→]...       │   26 頁
   └───┬───────────────┘                     └───────────────────┘
       │
       ▼
   ┌──────────────────────────────────────────────────────────┐
   │  第 1 層（葉節點）：真正的資料列，而且【橫向串成雙向鏈結】  │  5069 頁
   │  [id=1 完整一列][id=2 完整一列]...[id=196]  ⇄  [id=197]... │
   └──────────────────────────────────────────────────────────┘
```

**三個必須記住的性質**：

```
① 只有【葉節點】存資料，內部節點只存「鍵 + 頁號」
   → 內部節點很小 → 一頁能塞很多岔路 → 樹很矮

② 葉節點【橫向串成雙向鏈結】
   → 範圍查詢（BETWEEN、>、ORDER BY）可以順著鏈走，不用回頭走樹
   → ★ 這是 B+Tree 勝過 B-Tree 與雜湊表的關鍵

③ 所有葉節點在【同一層】
   → 查任何一列的成本都一樣（沒有「運氣好查得快」）
```

### 3.2.3 實測：這棵樹有幾層、一頁裝幾列

```sql
SELECT index_name, stat_name, stat_value FROM mysql.innodb_index_stats
WHERE database_name='shop3' AND table_name='ord' AND stat_name IN ('size','n_leaf_pages');
```

```
index_name           stat_name       stat_value
PRIMARY              n_leaf_pages    5069
PRIMARY              size            5096
idx_cust_placed      n_leaf_pages    1509
idx_cust_placed      size            1764
idx_status_placed    n_leaf_pages    1846
idx_status_placed    size            2149
uk_order_no          n_leaf_pages    1695
uk_order_no          size            1957
```

**推導樹高**：

```
PRIMARY：
    size 5096 − n_leaf_pages 5069 = 27 個【非葉】頁
        ↓
    27 個非葉頁 = 1 個根 + 26 個第 2 層
        ↓
    樹高 = 3 層
        ↓
    ★ 查任何一列：讀根 + 讀第 2 層 + 讀葉 = 3 次頁讀取
      而根與第 2 層一共只有 27 頁 = 432 KB，永遠在 buffer pool 裡
        ↓
    ★ 實際的磁碟 I/O：1 次
```

**一頁裝幾列**：

```sql
SELECT 993777/5069 AS 主鍵每頁幾列,
       993777/1509 AS idx_cust每頁幾項,
       993777/1695 AS uk_order_no每頁幾項;
```

```
主鍵每頁幾列    idx_cust每頁幾項    uk_order_no每頁幾項
196.05          658.57              586.30
```

📌 **這三個數字解釋了很多事**：

```
主鍵（聚簇索引）每頁 196 列
    → 16384 / 196.05 ≈ 84 bytes/列
    → 因為葉節點存【整列】，而「一列」比你宣告的欄位還多三樣東西：

       固定寬度的部分            8（id BIGINT）+ 4（customer_id INT）
                              + 9（DECIMAL(19,4)）+ 7（DATETIME(3)）      = 28
       ★ InnoDB 的隱藏欄位      6（DB_TRX_ID）+ 7（DB_ROLL_PTR）           = 13
       ★ 記錄頭 + 變長長度陣列 + NULL 位元圖                              ≈ 8
       四個變長欄位的【實際內容】order_no / status / channel / remark      ≈ 35
       ───────────────────────────────────────────────────────────────────────
                                                                       ≈ 84 ✅

    ⚠️ 注意 `remark VARCHAR(200)` 佔的是「實際存了幾個位元組」，
       不是 200 —— 這就是 01 章 1.4.2「宣告長度不佔空間」的另一面。

idx_cust_placed 每頁 659 項
    → 因為它只存 (customer_id, placed_at, id) = 4+7+8 = 19 bytes + 開銷
    → 16384 / 25 ≈ 655 ✅

∴ 二級索引比聚簇索引【小很多】
   → 同樣的 buffer pool 裝得下更多索引頁
   → 這是 3.6 覆蓋索引為什麼有效的物理原因
```

⚠️ **一個實務上的提醒**：MySQL 8.0.46 的 `information_schema.INNODB_BUFFER_PAGE`
**已經沒有 `PAGE_LEVEL` 欄位**了（舊版有），所以沒辦法直接查樹高。
上面的「size − n_leaf_pages」推導是目前最實用的方法。

### 3.2.4 為什麼不是雜湊表

雜湊表的查找是 **O(1)**，比 B+Tree 的 O(log n) 好。**為什麼 InnoDB 不用它當主索引？**

| | 雜湊索引 | B+Tree |
|---|---|---|
| 等值查詢 `= ?` | ✅ O(1) | O(log n)，實測 3 層 |
| **範圍查詢** `BETWEEN` / `>` | 🔴 **完全不行**（雜湊打散了順序） | ✅ 順著葉節點鏈走 |
| **排序** `ORDER BY` | 🔴 不行 | ✅ 索引本身就是排序好的 |
| **最左前綴** | 🔴 不行（雜湊整個鍵） | ✅ 3.5 |
| **`LIKE 'abc%'`** | 🔴 不行 | ✅ 3.7 ④ |
| 記憶體 vs 磁碟 | 適合記憶體 | 為**分頁的磁碟**設計 |

📌 **一句話：資料庫的查詢裡「範圍」與「排序」太多了，而雜湊索引一個都不支援。**

⚠️ **InnoDB 確實有一個雜湊索引**，叫**自適應雜湊索引**（Adaptive Hash Index）——
它是引擎自己在記憶體裡對「很常被等值查詢的頁」建的快取，
**你不能建、不能控制、也不用管它**。

**其他資料結構**：

```
二元搜尋樹 / AVL / 紅黑樹
    → 每個節點只有 2 個岔路 → 100 萬列要 20 層 → 20 次磁碟 I/O 🔴
    → 它們是為【記憶體】設計的

跳表（Skip List）
    → LevelDB / RocksDB 用它，Redis 的 ZSET 也用
    → 適合寫多讀少、適合 LSM-Tree 架構
    → 但範圍查詢的區域性（locality）不如 B+Tree
```

---

## 3.3 聚簇索引與二級索引

### 3.3.1 表就是索引

01 章 1.8.1 講過這句話。這裡把它畫出來。

```
   聚簇索引（Clustered Index）= 主鍵索引 = 【表本身】
   ┌──────────────────────────────────────────────────────────┐
   │ 葉節點：id → 這一列的【全部欄位】                          │
   │  [1 | SO-...0001 | 42 | PAID | WEB | 1980.00 | ... | NULL] │
   │  [2 | SO-...0002 | 87 | ...                              ] │
   └──────────────────────────────────────────────────────────┘

   二級索引（Secondary Index）
   ┌──────────────────────────────────────────────────────────┐
   │ 葉節點：索引欄位 → 【主鍵值】                              │
   │  idx_cust_placed:  [42 | 2026-08-01 10:15 | id=1 ]        │
   │                    [42 | 2026-08-15 14:00 | id=57]        │
   └──────────────────────────────────────────────────────────┘
                                            ↑
                            ★ 不是「指向那一列的實體位址」，是【主鍵值】
```

📌 **「存主鍵值而不是實體位址」是一個刻意的設計**：

```
好處：資料列在頁裡搬動（頁分裂、頁合併）時，二級索引【不需要更新】
代價：查完二級索引之後，要再走一次聚簇索引才能拿到其他欄位  ← 這就是【回表】
```

### 3.3.2 二級索引隱含以主鍵結尾

**這是一個很少被明說、但推論很多的事實**：

```
你宣告的：      KEY idx_cust_placed (customer_id, placed_at)
實際的索引項是： (customer_id, placed_at, id)
                                          ↑ 主鍵被自動附在最後
```

**三個推論**：

```
① 主鍵越大，每一個二級索引都越大
   → 01 章 1.8.2 的實測：主鍵換成 UUIDv4 CHAR(36) 之後，
     【索引】從 9.5 MB 變 17.6 MB（1.85 倍）、合計空間 2.22 倍

② ORDER BY customer_id, placed_at, id 【不需要排序】
   → 3.5.5 會實測

③ 二級索引裡已經有主鍵 → 只查主鍵時不需要回表
   → SELECT id FROM ord WHERE customer_id = 42 是【覆蓋】查詢
```

### 3.3.3 實測：回表的成本 ★★

**兩句查詢，差別只在多要一個不在索引裡的欄位。**

```sql
ALTER TABLE ord ADD KEY idx_cover (customer_id, placed_at, status, total_amount);
```

```sql
-- ① 只要索引裡有的欄位 → 覆蓋
EXPLAIN ANALYZE SELECT SUM(total_amount) FROM ord WHERE customer_id = 42;
```

```
-> Aggregate: sum(ord.total_amount)  (cost=437 rows=1) (actual time=0.647..0.647 rows=1 loops=1)
    -> Covering index lookup on ord using idx_cover (customer_id=42)
       (cost=231 rows=2062) (actual time=0.0386..0.467 rows=2062 loops=1)
       ^^^^^^^^^^^^^^^^^^^^
```

```sql
-- ② 多要一個 remark（不在任何索引裡）→ 回表
EXPLAIN ANALYZE SELECT SUM(total_amount), MAX(remark) FROM ord WHERE customer_id = 42;
```

```
-> Aggregate: sum(ord.total_amount), max(ord.remark)  (cost=928 rows=1) (actual time=4.42..4.42 rows=1 loops=1)
    -> Index lookup on ord using idx_cust_placed (customer_id=42)
       (cost=722 rows=2062) (actual time=0.413..4.22 rows=2062 loops=1)
       ^^^^^^^^^^^^ 沒有 "Covering"
```

**耗時（重複三輪）**：

```
① 覆蓋      0.84 / 0.66 / 0.55 ms
② 回表      8.63 / 4.04 / 3.77 ms       ← 🔴 慢 6.9 倍（穩定後）
```

**換一個更大的範圍（40,509 列）**：

```
① 覆蓋      6.86 / 5.51 ms
② 回表     80.03 / 150.68 ms            ← 🔴 慢 12～27 倍
```

📌 **為什麼列數越多差越大**：

```
覆蓋：  走一次 B+Tree 到葉節點，然後【順著雙向鏈】讀 40509 個索引項
        → 1 次樹搜尋 + 順序讀

回表：  同上，但每一個索引項都要【再走一次聚簇索引】拿 remark
        → 1 次樹搜尋 + 順序讀 + 【40509 次樹搜尋】
        → 而那 40509 次是【隨機】的（按 customer_id 排的順序去查 id）
```

⚠️ **一個要注意的量測陷阱**：`Handler_read_*` 計數器**看不出回表**：

```sql
FLUSH STATUS;
SELECT SUM(total_amount) FROM ord WHERE customer_id = 42;
SHOW SESSION STATUS LIKE 'Handler_read%';
```

```
-- ① 覆蓋
Handler_read_key       1
Handler_read_next      2062
Handler_read_rnd_next  0

-- ② 回表
Handler_read_key       1
Handler_read_next      2062        ← 🔴 完全一樣
Handler_read_rnd_next  0
```

**兩句的 handler 計數器一模一樣，而耗時差 6.9 倍。**

📌 **所以要看回表，用 `EXPLAIN ANALYZE`（看有沒有 `Covering`）或 `EXPLAIN` 的
`Extra: Using index`** —— 不要看 handler 計數器。

### 3.3.4 索引比資料還大

```sql
SELECT TABLE_ROWS, DATA_LENGTH/1048576 d, INDEX_LENGTH/1048576 i
FROM information_schema.TABLES WHERE TABLE_SCHEMA='shop3' AND TABLE_NAME='ord';
```

```
TABLE_ROWS   d(資料 MB)   i(索引 MB)
993777       79.6         91.7          ← 🔴 三個索引就比資料大了
```

📌 **這兩個數字可以從 3.2.3 的頁數直接對上**（每頁 16 KB）：

```
資料 = PRIMARY 的 size            5096 頁 × 16 KB = 79.6 MB  ✅
索引 = 三個二級索引的 size 之和
       idx_cust_placed  1764
       idx_status_placed 2149
       uk_order_no      1957
       ─────────────────────
                        5870 頁 × 16 KB = 91.7 MB            ✅
```

⚠️ **這裡的「三個」是 3.2.1 建的那三個基礎索引** ——
本章後面還會為了實驗再加 `idx_cover`、`idx_abc`、`idx_cp_desc`、
`idx_placed`、`idx_placed_date`（最多到 8 個），那時候索引會比這裡更大。

⚠️ **這在真實系統很常見，而它有一個具體後果**：

```
buffer pool 128 MB
資料 79.6 MB + 索引 91.7 MB = 171.3 MB
        ↓
    放不進去
        ↓
    每多一個索引，就少一點空間給資料
        ↓
    ★ 01 章 1.8.3 那個「10.35 倍」就是這樣來的
```

📌 **這是 3.8 索引設計的核心約束**：**索引不是免費的，而它的代價不只是磁碟空間，
是「buffer pool 裡的位置」** —— 那是所有查詢共用的資源。

---

## 3.4 讀懂 `EXPLAIN` ★★

### 3.4.1 十二個欄位

```sql
EXPLAIN SELECT * FROM ord WHERE customer_id = 42\G
```

```
           id: 1                       ← 查詢區塊的編號
  select_type: SIMPLE                  ← 這個區塊的角色
        table: ord                     ← 這一行在存取哪張表
   partitions: NULL                    ← 分區（本課不用分區）
         type: ref                     ← ★★ 存取方式（最重要）
possible_keys: idx_cust_placed          ← 【可以】用的索引
          key: idx_cust_placed          ← ★★ 【實際】用的索引
      key_len: 4                       ← ★ 用了索引的前幾個位元組
          ref: const                   ← 索引的比較對象
         rows: 2062                    ← ★ 【估計】要讀幾列
     filtered: 100.00                  ← ★ 【估計】讀完之後剩幾 %
        Extra: NULL                    ← ★★ 其他關鍵資訊
```

**按重要性排序的閱讀順序**：

```
① type      —— 存取方式。ALL / index 就是警訊
② key       —— 有沒有用索引？用了哪一個？（跟 possible_keys 比對）
③ Extra     —— Using filesort / Using temporary 就是警訊
④ rows      —— 量級對不對？（記住它是估計值）
⑤ key_len   —— 複合索引用到第幾欄？
⑥ filtered  —— rows × filtered / 100 = 交給下一步的列數
```

**`select_type` 的六種值**：

| 值 | 意思 |
|---|---|
| `SIMPLE` | 沒有子查詢也沒有 `UNION` |
| `PRIMARY` | 最外層的查詢 |
| `SUBQUERY` | 子查詢裡的第一個 `SELECT` |
| `DERIVED` | 衍生表 / CTE（02 章 2.5.5） |
| `UNION` / `UNION RESULT` | `UNION` 的第二個之後的分支 / 合併結果 |
| `MATERIALIZED` | 被物化的子查詢 |

### 3.4.2 `type` 的階梯（實測九種）

**從最好到最壞**。以下每一個都是本章實驗表上的真實輸出：

```sql
-- ① const —— 用主鍵或唯一索引 + 常數，最多回傳一列
EXPLAIN SELECT * FROM ord WHERE id = 500000;
```

```
type: const   key: PRIMARY       key_len: 8     ref: const   rows: 1
```

```sql
EXPLAIN SELECT * FROM ord WHERE order_no = 'SO-0000500000';
```

```
type: const   key: uk_order_no   key_len: 130   ref: const   rows: 1
```

📌 **`const` 是最好的** —— MySQL 在**優化階段**就把那一列讀出來、當成常數用。

```sql
-- ② eq_ref —— JOIN 時，對驅動表的每一列，在被驅動表用主鍵/唯一索引查到【剛好一列】
EXPLAIN SELECT * FROM ord a JOIN ord b ON b.id = a.id WHERE a.id < 10;
```

```
table: a   type: range    key: PRIMARY   rows: 9    Extra: Using where
table: b   type: eq_ref   key: PRIMARY   rows: 1    ref: shop3.a.id
```

```sql
-- ③ ref —— 用非唯一索引做等值查詢，可能回傳多列
EXPLAIN SELECT * FROM ord WHERE customer_id = 42;
```

```
type: ref   key: idx_cust_placed   key_len: 4   ref: const   rows: 2062
```

```sql
-- ④ range —— 索引的一段範圍
EXPLAIN SELECT * FROM ord WHERE id BETWEEN 1 AND 100;
```

```
type: range   key: PRIMARY   key_len: 8   rows: 100   Extra: Using where
```

```sql
-- ⑤ index_merge —— 同時用兩個索引，再合併結果
EXPLAIN SELECT * FROM ord WHERE customer_id = 42 OR order_no = 'SO-0000000001';
```

```
type: index_merge   key: idx_cust_placed,uk_order_no   key_len: 4,130   rows: 2063
Extra: Using sort_union(idx_cust_placed,uk_order_no); Using where
```

```sql
-- ⑥ index —— 掃【整個索引】（比 ALL 好一點，因為索引比表小）
EXPLAIN SELECT customer_id FROM ord;
```

```
type: index   key: idx_cust_placed   key_len: 11   rows: 993777   Extra: Using index
```

```sql
-- ⑦ ALL —— 全表掃描
EXPLAIN SELECT * FROM ord WHERE remark = 'x';
```

```
type: ALL   key: NULL   rows: 993777   filtered: 10.00   Extra: Using where
```

**完整的階梯**：

| type | 意思 | 好壞 |
|---|---|---|
| `system` | 只有一列的系統表 | ✅✅ |
| `const` | 主鍵/唯一索引 + 常數，最多一列 | ✅✅ |
| `eq_ref` | JOIN 時用主鍵/唯一索引，剛好一列 | ✅✅ |
| `ref` | 非唯一索引等值查詢 | ✅ |
| `fulltext` | 全文索引 | — |
| `ref_or_null` | `ref` + `IS NULL` | ✅ |
| `index_merge` | 多索引合併 | 🟡 通常代表「該建複合索引」（3.8.2） |
| `unique_subquery` | `IN (子查詢)` 且子查詢回傳唯一值 | ✅ |
| `index_subquery` | 同上但非唯一 | 🟡 |
| `range` | 索引的一段範圍 | ✅（看 `rows` 多少） |
| `index` | 掃整個索引 | 🔴 |
| `ALL` | 全表掃描 | 🔴🔴 |

⚠️ **`ALL` 不一定是壞事，`range` 不一定是好事**：

```
小表（幾百列）的 ALL      →  完全沒問題，全表掃描比走索引還快
range 掃了 80% 的列       →  比 ALL 更糟（多了回表的隨機 I/O）
```

📌 **判準是 `rows`（相對於表的總列數），不是 `type` 本身。**
`type` 只是告訴你「用了什麼手段」。

**一個 `ref_or_null` 的實測小插曲**：

```sql
EXPLAIN SELECT * FROM ord WHERE customer_id = 42 OR customer_id IS NULL;
```

```
type: ref   key: idx_cust_placed   rows: 2062
```

**它是 `ref` 而不是 `ref_or_null`** —— 因為 `customer_id` 是 `NOT NULL`，
優化器直接把 `OR customer_id IS NULL` 這個永假的條件**刪掉了**。

### 3.4.3 `key_len`：算出複合索引用了幾個欄位 ★★

**這是 `EXPLAIN` 裡最被忽略、也最有用的一個欄位。**

**算法**：

```
每個欄位的 key_len 貢獻 =
      該欄位的最大位元組數
    + （可為 NULL 時）1 個 NULL 標記位元組
    + （變長型別時）2 個長度前綴位元組
```

| 型別 | 位元組 |
|---|---|
| `TINYINT` / `SMALLINT` / `INT` / `BIGINT` | 1 / 2 / 4 / 8 |
| `DATE` / `TIME` / `DATETIME(0)` / `DATETIME(3)` | 3 / 3 / 5 / **7** |
| `TIMESTAMP(0)` / `TIMESTAMP(3)` | 4 / 6 |
| `DECIMAL(19,4)` | 9 |
| `CHAR(n)` utf8mb4 | `n × 4` |
| `VARCHAR(n)` utf8mb4 | `n × 4 + 2` |
| 可為 NULL | **+1** |

**實驗：一個三欄複合索引**

```sql
ALTER TABLE ord ADD KEY idx_abc (status, channel, customer_id);
```

```
status      VARCHAR(16) utf8mb4 NOT NULL  →  16 × 4 + 2 = 66
channel     VARCHAR(8)  utf8mb4 NOT NULL  →   8 × 4 + 2 = 34
customer_id INT                 NOT NULL  →              4
                                              合計 = 104
```

**八種查詢，看 `key_len` 說什麼**：

| # | `WHERE` | `key` | `key_len` | 用了幾欄 | `rows` |
|---|---|---|---|---|---|
| ① | `status='PAID'` | `idx_status_placed` | **66** | 1 | 93,958 |
| ② | `status='PAID' AND channel='WEB'` | `idx_abc` | **100** | **2** | 46,424 |
| ③ | `status='PAID' AND channel='WEB' AND customer_id=42` | `idx_abc` | **104** | **3** | 47 |
| ④ | `channel='WEB'`（跳過 status） | `idx_abc` | 100 | 2 | 248,887 |
| ⑤ | `status='PAID' AND customer_id=42`（跳過 channel） | `idx_abc` | 104 | 3 | 727 |
| ⑥ | `status>'PACKED' AND channel='WEB'` | `idx_abc` | **66** | **1** 🔴 | 353,722 |
| ⑦ | `status='PAID' AND channel>'POS' AND customer_id=42` | `idx_cust_placed` | 4 | — | 2,062 |
| ⑧ | `status IN ('PAID','SHIPPED') AND channel='WEB'` | `idx_abc` | 100 | 2 | 118,808 |

📌 **`key_len` 讓你**「看見」**索引被用到哪裡**：

```
66  = status                          → 只用了第 1 欄
100 = status + channel                → 用了前 2 欄
104 = status + channel + customer_id  → 三欄全用
```

⚠️ **⑥ 是最重要的一列**：`status` 用了**範圍條件**（`>`），
於是 `key_len` 只有 **66** —— **`channel='WEB'` 完全沒有用到索引**。
3.5.3 會展開這件事。

⚠️ **④ 與 ⑤ 更有趣**：它們**跳過了索引的欄位，卻仍然用了 `idx_abc`**。
`Extra` 說明了原因：

```
④ Extra: Using where; Using index for skip scan
⑤ Extra: Using where; Using index for skip scan
```

**這是 MySQL 8 的 skip scan** —— 3.5.4 會處理它。

### 3.4.4 `Extra`：十四種值

**這一欄是 `EXPLAIN` 裡資訊密度最高的地方。**

**✅ 好消息**

| 值 | 意思 |
|---|---|
| `Using index` | **覆蓋索引** —— 不需要回表（3.6） |
| `Using index condition` | **索引條件下推（ICP）** —— 在索引層就過濾掉不符的，減少回表次數 |
| `Backward index scan` | 反向掃索引 —— `ORDER BY ... DESC` 也不用排序（MySQL 8） |
| `Using index for skip scan` | 跳掃 —— 領頭欄位沒給也用到了索引（3.5.4） |
| `Using index for group-by` | **鬆散索引掃描** —— 02 章 2.6.8 那個快 15 倍的原因 |

**🔴 警訊**

| 值 | 意思 | 怎麼修 |
|---|---|---|
| `Using filesort` | **要額外排序**（不一定用磁碟，名字誤導） | 3.5.5：讓 `ORDER BY` 走索引順序 |
| `Using temporary` | **要建暫存表**（`GROUP BY` / `DISTINCT` / `UNION`） | 讓分組欄位走索引 |
| `Using where` | 讀出來之後還要在**伺服器層**過濾 | 看情況；配 `ALL` 就是警訊 |
| `Using join buffer (hash join)` | JOIN 的欄位沒索引 → 走 hash join | 建索引（或者這就是對的，見下） |
| `Range checked for each record` | 每一列都重新決定要不要用索引 | 幾乎總是缺索引 |
| `Impossible WHERE` | 條件恆假 | 通常是寫錯了 |
| `Select tables optimized away` | 不用讀表就有答案（`MAX()` 走索引） | ✅ 這其實是好事 |
| `No tables used` | 沒有 `FROM` | — |
| `Using MRR` | 多範圍讀取，把回表的隨機 I/O 排序 | ✅ |

⚠️ **`Using where` 最常被誤解。** 它**不代表**有問題：

```
type: ref     + Using where  →  用索引查到之後再過濾，正常
type: range   + Using where  →  正常
type: ALL     + Using where  →  🔴 全表掃描 + 逐列過濾
type: ref     + 沒有 Using where → 更好（索引已經完全表達了條件）
```

⚠️ **`Using filesort` 的名字騙人**：它**不一定用檔案**。
MySQL 先試 `sort_buffer_size`（預設 256 KB）的記憶體排序，放不下才用磁碟。

**怎麼知道有沒有用到磁碟**：

```sql
FLUSH STATUS;
SELECT id FROM ord ORDER BY total_amount LIMIT 100;
SHOW SESSION STATUS WHERE Variable_name IN
  ('Sort_merge_passes','Sort_rows','Sort_scan','Created_tmp_disk_tables');
```

```
Created_tmp_disk_tables   0
Sort_merge_passes         0        ← ★ > 0 就代表用了磁碟的多路合併
Sort_rows                 100      ← ★ 只排序了 100 列，不是 100 萬列
Sort_scan                 1
```

📌 **`Sort_rows = 100` 而不是 1,000,000** ——
因為 `ORDER BY ... LIMIT 100` 會走**優先佇列**（priority queue）：
只維護一個 100 個元素的堆，掃過每一列時比較一下。
**這是 `ORDER BY ... LIMIT n` 在 n 很小時不可怕的原因。**

**`Using temporary` 的實測**：

```sql
EXPLAIN SELECT status, COUNT(*) FROM ord GROUP BY status;
```

```
type: index   key: idx_status_placed   Extra: Using index
                                              ★ 沒有 Using temporary
```

```sql
EXPLAIN SELECT channel, COUNT(*) FROM ord GROUP BY channel;
```

```
type: index   key: idx_abc   Extra: Using index; Using temporary
                                                 ^^^^^^^^^^^^^^^
```

**差別**：`status` 是 `idx_status_placed` 的**領頭欄位** → 索引已經按它排好 → 可以邊掃邊聚合。
`channel` 是 `idx_abc` 的**第二欄** → 索引順序沒有幫助 → 要建暫存表。

```sql
EXPLAIN SELECT customer_id, COUNT(*) FROM ord GROUP BY customer_id ORDER BY COUNT(*) DESC;
```

```
Extra: Using index; Using temporary; Using filesort
                    ^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^
                    分組要暫存表      再按聚合值排序
```

📌 **`ORDER BY` 一個聚合值時，`Using filesort` 是無法避免的** ——
因為那個值要等聚合完才算得出來。**這不是 bug，是物理限制。**

### 3.4.5 `rows` 與 `filtered` 是估計值 ★★

**這是本節最重要的一段。**

**實測：對七種狀態各跑一次 `EXPLAIN`，跟真實列數對照**：

```
狀態         EXPLAIN rows    實際列數     誤差
DELIVERED    497,015         749,685      -33.7%
SHIPPED      158,432          79,800      +98.5%
CANCELLED    128,038          60,513     +111.6%     ← 🔴
PAID          93,958          49,977      +88.0%
PACKED        57,960          29,987      +93.3%
PENDING       38,620          20,182      +91.4%
REFUNDED      18,546           9,856      +88.2%
```

⚠️ **七個裡沒有一個誤差在 30% 以內，最大誤差 +112%。**

**為什麼**：`rows` 來自 InnoDB 的**索引取樣統計**。
`ANALYZE TABLE` 預設只取樣 **20 個頁**（`innodb_stats_persistent_sample_pages`），
然後外推到整張表。

**看得出取樣誤差**：

```sql
SELECT index_name, stat_name, stat_value FROM mysql.innodb_index_stats
WHERE database_name='shop3' AND table_name='ord' AND stat_name='n_diff_pfx01';
```

```
index_name           stat_value
idx_status_placed    6              ← 🔴 status 明明有【7】種值
uk_order_no          998355         ← 實際 1,000,000
PRIMARY              993777         ← 實際 1,000,000
```

📌 **`status` 的基數被估成 6 而實際是 7。**
`REFUNDED` 只佔 0.99%，20 個取樣頁裡剛好沒抽到它。

**`filtered` 是第二層估計**：

```
rows × filtered / 100 = 交給【下一步】（JOIN 的下一張表、或 GROUP BY）的列數
```

```sql
EXPLAIN SELECT id FROM ord WHERE total_amount > 4000;
```

```
type: index   key: idx_cover   rows: 994030   filtered: 33.33
                                              ^^^^^^^^^^^^^^
```

```sql
SELECT COUNT(*) FROM ord WHERE total_amount > 4000;      -- 200,022 → 20.12%
```

🔴 **`filtered: 33.33` 是一個【寫死的猜測】** ——
MySQL 對沒有統計資訊的 `>` 條件一律猜 1/3。實際是 20.12%，誤差 **66%**。

**3.9.2 會用直方圖把這個數字修到 20.20%。**

> ⚠️ **這一節的結論，是本章最重要的一句話**：
>
> ```
> EXPLAIN 告訴你【優化器打算怎麼做，以及它為什麼這樣決定】
> 它【不】告訴你實際會讀幾列、實際會花多久
> ```
>
> 📌 **所以 `EXPLAIN` 的正確用法是**：
>
> ```
> ✅ 看 type / key / Extra    —— 這些是【決策】，是確定的
> 🟡 看 rows 的【量級】        —— 1000 vs 100 萬有意義，2062 vs 2500 沒意義
> 🔴 不要用 rows 當效能指標    —— 要量實際，用 EXPLAIN ANALYZE（3.4.7）
> ```

### 3.4.6 `EXPLAIN FORMAT=TREE`

```sql
EXPLAIN FORMAT=TREE
SELECT COUNT(*) FROM ord o JOIN (SELECT customer_id, MAX(placed_at) mx FROM ord GROUP BY customer_id) m
  ON m.customer_id = o.customer_id AND m.mx = o.placed_at\G
```

```
-> Aggregate: count(0)  (cost=...)
    -> Nested loop inner join  (cost=...)
        -> Table scan on m  (cost=...)
            -> Materialize  (cost=...)
                -> Covering index skip scan for grouping on ord using idx_cust_placed  (rows=2021)
        -> Covering index lookup on o using idx_cust_placed (customer_id=..., placed_at=...)
```

**它比表格式好的三件事**：

```
① 執行【順序】與【嵌套關係】看得出來（表格式只是一堆平行的列）
② 節點名稱是白話：「Covering index lookup」比「type: ref + Extra: Using index」清楚
③ 它會顯示表格式看不到的東西：Materialize、Stream results、
   以及 02 章 2.6.8 那個 Covering index skip scan for grouping
```

📌 **這就是 02 章 2.6.8 那個「快 15 倍」的答案**：
`Covering index skip scan for grouping`（也叫**鬆散索引掃描**）——
`GROUP BY customer_id` + `MAX(placed_at)` 在 `(customer_id, placed_at)` 索引上，
**只需要跳到每個 `customer_id` 區段的最後一項**，
2000 次跳躍取代 10 萬次讀取。

### 3.4.7 `EXPLAIN ANALYZE`：真的跑一次 ★★

**MySQL 8.0.18+。它會真的執行查詢，然後告訴你每個節點的實際數字。**

```sql
EXPLAIN ANALYZE
SELECT customer_id, COUNT(*) c FROM ord
WHERE status='REFUNDED' AND channel='LINE'
GROUP BY customer_id ORDER BY c DESC LIMIT 5\G
```

```
-> Limit: 5 row(s)  (actual time=0.254..0.254 rows=5 loops=1)
    -> Sort: c DESC, limit input to 5 row(s) per chunk  (actual time=0.254..0.254 rows=5 loops=1)
        -> Stream results  (cost=99.8 rows=463) (actual time=0.0365..0.215 rows=423 loops=1)
            -> Group aggregate: count(0)  (cost=99.8 rows=463) (actual time=0.0242..0.169 rows=423 loops=1)
                -> Covering index lookup on c using idx_abc (status='REFUNDED', channel='LINE')
                   (cost=53.5 rows=463) (actual time=0.0204..0.124 rows=463 loops=1)
                                                                        ^^^^^^^^^
                                                     估計 463，實際 463 —— 這次估得很準
```

**四個數字的意思**：

```
actual time=0.0204..0.124
             ^^^^^^  ^^^^^
             取得【第一列】的時間 .. 取得【最後一列】的時間（毫秒）

rows=463      實際回傳的列數（對照前面的 cost=... rows=463 是估計）
loops=1       這個節點被執行了幾次
              ★ 在 nested loop join 裡，內層的 loops 會是外層的列數
              ★ 實際總時間 = actual time 的第二個數字 × loops
```

⚠️ **`loops` 是找 N+1 與列數膨脹的關鍵。實測**：

```sql
EXPLAIN ANALYZE SELECT COUNT(*) FROM ord a JOIN ord b ON b.customer_id = a.customer_id
WHERE a.id < 500\G
```

```
-> Aggregate: count(0)  (cost=5457 rows=1) (actual time=54..54 rows=1 loops=1)
    -> Nested loop inner join  (cost=3056 rows=24010) (actual time=1.09..47.8 rows=238745 loops=1)
                                          ^^^^^^^^^^                    ^^^^^^^^^^^
                                          估計 24,010                    實際 238,745 🔴 差 10 倍
        -> Filter: (a.id < 500)  (cost=102 rows=499) (actual rows=499 loops=1)
            -> Index range scan on a using PRIMARY over (id < 500)  (actual rows=499 loops=1)
        -> Covering index lookup on b using idx_cust_placed (customer_id=a.customer_id)
           (cost=1.12 rows=48.1) (actual time=0.0182..0.0745 rows=478 loops=499)
                                                                       ^^^^^^^^^^^^
                                                     ★ 內層跑了 499 次，每次 478 列
```

📌 **三個數字要一起讀**：

```
loops=499                  外層有 499 列 → 內層被執行 499 次
rows=478（每次）           每次拿回 478 列
499 × 478 = 238,522 ≈ 238,745      ← ★ 這就是 02 章 2.3.3 的【列數膨脹】

而 EXPLAIN 的估計是 24,010 —— 少估了 10 倍
    ↑ 因為它用「每個 customer_id 平均 48.1 列」來算（rows=48.1），
      而 a.id < 500 那 499 列剛好都是【下單很多的大客戶】（本章的資料刻意做了偏斜）
```

⚠️ **這是 `EXPLAIN` 估計失準最典型的一種：資料偏斜。**
優化器用「平均值」推理，而真實資料很少是平均分布的。

📌 **`EXPLAIN ANALYZE` 的三個注意事項**：

```
① 它【真的執行】查詢 —— 不要對 UPDATE / DELETE 用（會真的改資料）
   （MySQL 8.0.18 起只支援 SELECT，但仍要小心 SELECT ... FOR UPDATE）
② 它會執行【完整】的查詢，即使你只想看計畫
   → 一句要跑 10 分鐘的查詢，EXPLAIN ANALYZE 也要跑 10 分鐘
③ 量測本身有開銷（每個節點都要計時），所以絕對時間會比實際稍慢
   → 看【比例】與【loops】，不要看絕對值
```

### 3.4.8 `optimizer_trace`：問優化器「你為什麼選它」

**當 `EXPLAIN` 顯示的索引不是你預期的那一個，用這個。**

```sql
SET optimizer_trace='enabled=on';
SELECT COUNT(*) FROM ord WHERE status='PAID' AND channel='WEB';
SELECT JSON_PRETTY(JSON_EXTRACT(TRACE,'$**.range_scan_alternatives'))
FROM information_schema.OPTIMIZER_TRACE\G
```

```json
[[
  {
    "cost": 103341,
    "rows": 93958,
    "index": "idx_status_placed",
    "chosen": true,
    "ranges": ["status = 'PAID'"],
    "index_only": false                    ← 要回表
  },
  {
    "cost": 5270.75,                       ← ★ 便宜 20 倍
    "rows": 46424,
    "index": "idx_abc",
    "chosen": true,
    "ranges": ["status = 'PAID' AND channel = 'WEB'"],
    "index_only": true                     ← ★ 覆蓋索引
  }
]]
```

📌 **`cost` 103341 vs 5270.75** —— 優化器選了 `idx_abc`，理由清清楚楚：
它能用到兩個欄位（46424 vs 93958 列），而且是**覆蓋索引**（`index_only: true`）。

⚠️ **記得關掉**：

```sql
SET optimizer_trace='enabled=off';
```

它會為每一句查詢產生幾百 KB 的 JSON，**不要在正式環境開著**。

### 3.4.9 四種工具怎麼選

| 工具 | 會執行查詢 | 給你什麼 | 什麼時候用 |
|---|---|---|---|
| `EXPLAIN` | ❌ | 表格：`type` / `key` / `key_len` / `rows` | **預設用這個**。快速檢查「有沒有走索引」 |
| `EXPLAIN FORMAT=TREE` | ❌ | 樹狀：執行順序與嵌套 | 查詢有 JOIN / 子查詢 / 聚合時 |
| `EXPLAIN ANALYZE` | ✅ | 樹狀 + **實際** rows / time / loops | 「計畫看起來對，但還是慢」時 |
| `optimizer_trace` | ✅ | JSON：**每一個被考慮過的選項與它的 cost** | 「為什麼不用我建的那個索引」時 |

> 📌 **一個實用的排查順序**：
>
> ```
> ① EXPLAIN            → type 是 ALL / index？Extra 有 filesort / temporary？
>                          → 有就先修這個
> ② EXPLAIN ANALYZE    → 哪一個節點的 actual time × loops 最大？
>                          → 那就是瓶頸，不要憑猜
> ③ optimizer_trace    → 為什麼沒用我以為會用的索引？
>                          → 看 cost 與 index_only
> ```

---

## 3.5 複合索引與最左前綴 ★★

### 3.5.1 索引就是一本按欄位順序排的目錄

```
KEY idx_abc (status, channel, customer_id)

索引裡的項目長這樣（按這個順序排好）：
    ('CANCELLED', 'APP',  17,   id=...)
    ('CANCELLED', 'APP',  42,   id=...)
    ('CANCELLED', 'LINE',  8,   id=...)
    ('CANCELLED', 'POS',  91,   id=...)
    ('CANCELLED', 'WEB',   3,   id=...)
    ('DELIVERED', 'APP',   1,   id=...)
    ...
```

**把它想成一本電話簿，按「縣市 → 區 → 姓名」排序**：

```
✅ 「台北市的所有人」                   → 直接翻到台北市那一段
✅ 「台北市大安區的所有人」              → 台北市 → 大安區
✅ 「台北市大安區姓王的人」              → 三層都能用
🔴 「所有大安區的人」（不說縣市）         → 每個縣市都要翻一遍
🔴 「所有姓王的人」                      → 整本翻
✅ 「台北市，區在『大』到『信』之間，姓王」→ 縣市能用、區能用【範圍】、
                                            但姓名【不能】用，因為「大安區的王」與
                                            「信義區的王」在書裡不連續
```

**最後那一條就是最左前綴規則的全部內容**：

> 📌 **索引的欄位，從左到右，一路用到「第一個範圍條件」為止。**
> **範圍條件本身可以用索引，但它右邊的欄位不行。**

### 3.5.2 實測：`key_len` 說了什麼

3.4.3 那張表的重點重列一次：

```
索引：idx_abc (status, channel, customer_id)     總 key_len = 66 + 34 + 4 = 104
```

| `WHERE` | `key_len` | 用到 | 說明 |
|---|---|---|---|
| `status='PAID'` | 66 | ①  | 只有第一欄 |
| `status='PAID' AND channel='WEB'` | 100 | ①② | 兩欄 |
| `status='PAID' AND channel='WEB' AND customer_id=42` | **104** | ①②③ | ✅ 全部 |
| `status='PAID' AND channel='WEB'`（順序寫反）| 100 | ①② | **`WHERE` 的順序不重要**，優化器會重排 |
| `status>'PACKED' AND channel='WEB'` | **66** | ① | 🔴 `channel` 白給了 |
| `status IN ('PAID','SHIPPED') AND channel='WEB'` | 100 | ①② | `IN` 不會擋住後面 |

⚠️ **`WHERE` 子句裡的順序完全不重要。** 這兩句的 `EXPLAIN` 一模一樣：

```sql
WHERE status='PAID' AND channel='WEB'
WHERE channel='WEB' AND status='PAID'
```

**重要的是【索引定義】裡的順序**，不是 `WHERE` 裡的順序。

### 3.5.3 範圍條件之後就停了 ★

```sql
EXPLAIN SELECT id FROM ord WHERE status > 'PACKED' AND channel = 'WEB';
```

```
type: range   key: idx_abc   key_len: 66   rows: 353722   Extra: Using where; Using index
                                     ^^
                                     🔴 只有 66 = status 一欄
```

**為什麼**：索引裡的項目按 `(status, channel, ...)` 排序，
所以 `status > 'PACKED'` 那一段裡，`channel` 的值是**這樣分布的**：

```
('PAID',      'APP',  ...)
('PAID',      'LINE', ...)
('PAID',      'POS',  ...)
('PAID',      'WEB',  ...)     ← WEB 在這裡
('PENDING',   'APP',  ...)
('PENDING',   'LINE', ...)
...
('PENDING',   'WEB',  ...)     ← WEB 也在這裡
('REFUNDED',  'APP',  ...)
...
('SHIPPED',   'WEB',  ...)     ← WEB 又在這裡
                                  ↑ 🔴 不連續 → 沒辦法用索引「跳到」它們
```

**`channel='WEB'` 只能在讀出來之後逐項過濾**（`Extra: Using where`）。

⚠️ **哪些算「範圍條件」**：

```
🔴 會擋住右邊的：  >  <  >=  <=  BETWEEN  LIKE 'abc%'  <>  IS NOT NULL
✅ 不會擋住的：    =  IN (...)  IS NULL
```

📌 **`IN` 不會擋住**，因為 MySQL 把它展開成多個等值查詢（多個 range）：

```sql
EXPLAIN SELECT id FROM ord WHERE status IN ('PAID','SHIPPED') AND channel='WEB';
```

```
type: range   key: idx_abc   key_len: 100   rows: 118808
                                     ^^^
                                     ✅ 兩欄都用到了
```

⚠️ **但 `IN` 的列表不能太長** —— 超過 `eq_range_index_dive_limit`（預設 200）時，
優化器會改用取樣統計而不是實際探查，估計就會失準（05 章 5.6）。

> 📌 **這條規則決定了複合索引的欄位順序**：
> **等值條件的欄位放前面，範圍條件的欄位放最後。**
>
> ```sql
> -- 需求：WHERE customer_id = ? AND placed_at >= ? AND placed_at < ?
>
> ✅ KEY (customer_id, placed_at)      -- 等值在前，範圍在後 → 兩欄都用得到
> 🔴 KEY (placed_at, customer_id)      -- 範圍在前 → customer_id 用不到
> ```

### 3.5.4 skip scan：MySQL 8 讓規則不再絕對（但別依賴）

**3.4.3 的 ④ 與 ⑤ 跳過了索引的欄位，卻仍然用了 `idx_abc`**：

```sql
EXPLAIN SELECT id FROM ord WHERE channel='WEB';         -- 跳過了 status
```

```
type: range   key: idx_abc   key_len: 100   rows: 248887
Extra: Using where; Using index for skip scan
                    ^^^^^^^^^^^^^^^^^^^^^^^^^
```

**skip scan 的做法**：

```
status 只有 7 種值（低基數）
        ↓
優化器把一句「channel='WEB'」拆成 7 句：
    (status='CANCELLED' AND channel='WEB')
    (status='DELIVERED' AND channel='WEB')
    (status='PACKED'    AND channel='WEB')
    ...
        ↓
每一句都是完整的最左前綴 → 各自走一次索引 → 合併結果
```

**關掉它看差別**：

```sql
SET SESSION optimizer_switch='skip_scan=off';
EXPLAIN SELECT id FROM ord WHERE channel='WEB';
```

```
type: index   key: idx_abc   key_len: 104   rows: 995551   Extra: Using where; Using index
      ^^^^^                                       ^^^^^^^
      掃整個索引                                   100 萬列
```

⚠️ **但實測顯示：這個場景下 skip scan 幾乎沒有幫助**：

```
skip_scan=on   0.112 / 0.098 秒
skip_scan=off  0.103 / 0.096 秒        ← 差不多
```

**為什麼**：`channel='WEB'` 命中 449,958 列（45%）——
不管怎麼走索引，都得讀將近一半的資料。**skip scan 省不掉那些讀取。**

**那 skip scan 什麼時候有用？** 實測一個「後面很選擇性」的例子：

```sql
EXPLAIN SELECT status, channel, customer_id FROM ord WHERE channel='LINE' AND customer_id=42;
```

```
type: ref   key: idx_cust_placed   key_len: 4   rows: 2062   Extra: Using where
                 ^^^^^^^^^^^^^^^
                 🔴 優化器根本沒選 idx_abc
```

**優化器選了另一個索引。強迫它用 `idx_abc`**：

```sql
EXPLAIN SELECT /*+ INDEX(ord idx_abc) */ status, channel, customer_id FROM ord
WHERE channel='LINE' AND customer_id=42;
```

```
type: range   key: idx_abc   rows: 248887   Extra: Using where; Using index for skip scan
                                   ^^^^^^^
                        🔴 估計要讀 248,887 列，而實際結果只有 86 列
```

> 📌 **skip scan 的定位**：
>
> ```
> ✅ 它是一個【安全網】：當你沒有完美的索引時，它讓 MySQL 還能用上手邊的索引
> 🔴 它【不是】「欄位順序不重要了」的理由：
>      - 只在領頭欄位【基數很低】時才會觸發
>      - 它的估計很粗（248,887 vs 實際 86）
>      - 有更好的索引時優化器會直接忽略它
> ```
>
> ⚠️ **所以 3.5.3 那條「等值在前、範圍在後」的規則仍然完全有效。**
> skip scan 只是讓「規則沒遵守時」的後果不那麼災難。

### 3.5.5 `ORDER BY` 的排序消除 ★

**索引本身是排序好的** → 如果 `ORDER BY` 的順序跟索引一致，**排序可以完全省掉**。

**實測（索引 `idx_cust_placed (customer_id, placed_at)`；
最後兩列還需要一個單欄索引，先建起來）**：

```sql
ALTER TABLE ord ADD KEY idx_placed (placed_at);     -- ★ 3.7.7 與 3.8.4 也會用到它
```

| `ORDER BY` | `Extra` | 判定 |
|---|---|---|
| `WHERE customer_id=42 ORDER BY placed_at` | `NULL` | ✅ **不排序** |
| `WHERE customer_id=42 ORDER BY placed_at DESC` | `Backward index scan` | ✅ **反向掃，不排序** |
| `WHERE customer_id=42 ORDER BY placed_at, id` | `NULL` | ✅ **不排序**（見下） |
| `WHERE customer_id=42 ORDER BY total_amount` | `Using filesort` | 🔴 要排序 |
| `ORDER BY placed_at LIMIT 10`（無 WHERE，走 `idx_placed`） | `NULL`，`rows: 10` | ✅ |
| `ORDER BY total_amount LIMIT 10`（無索引） | `type: ALL` + `Using filesort` | 🔴 |

📌 **第三列值得單獨講**：

```sql
ORDER BY placed_at, id      -- 加了一個決勝欄位（02 章 2.6.4）
```

**它沒有造成排序**，因為 3.3.2 說過：
`idx_cust_placed` 的索引項實際上是 `(customer_id, placed_at, id)` ——
**主鍵已經在最後了**。

⚠️ **這是一個很划算的發現**：
02 章 2.6.4 要你在每個 `ORDER BY ... LIMIT` 加決勝欄位以保證順序穩定，
而**如果那個決勝欄位是主鍵，它是免費的**。

**`Backward index scan` 是 MySQL 8 的新功能**：

```
MySQL 5.7：ORDER BY ... DESC 要 filesort（或建一個降序索引）
MySQL 8.0：可以反向掃葉節點的雙向鏈結（3.2.2 的性質 ②）→ 不用排序
```

⚠️ **但混合方向仍然需要降序索引**：

```sql
ORDER BY customer_id ASC, placed_at DESC     -- 🔴 一升一降，正掃反掃都不行
```

```sql
-- ✅ MySQL 8 支援降序索引
ALTER TABLE ord ADD KEY idx_cp_desc (customer_id ASC, placed_at DESC);
```

**實測：它真的有效，但優化器不一定會選它**

```sql
-- 等值 + 混合方向：優化器【自己】就用了降序索引
EXPLAIN SELECT id FROM ord WHERE customer_id=42 ORDER BY customer_id ASC, placed_at DESC;
```

```
key: idx_cp_desc   Extra: Using index                      ← ✅ 沒有 filesort
```

```sql
-- 範圍 + 混合方向：優化器【沒有】選它
EXPLAIN SELECT id FROM ord WHERE customer_id BETWEEN 1 AND 5 ORDER BY customer_id ASC, placed_at DESC;
```

```
key: idx_cust_placed   Extra: Using where; Using index; Using filesort    ← 🔴
```

```sql
-- 用 hint 強迫它用
EXPLAIN SELECT /*+ INDEX(ord idx_cp_desc) */ id FROM ord
WHERE customer_id BETWEEN 1 AND 5 ORDER BY customer_id ASC, placed_at DESC;
```

```
key: idx_cp_desc   Extra: Using where; Using index                        ← ✅ filesort 消失了
```

⚠️ **降序索引是有效的，但優化器對「範圍 + 混合方向」的成本估計會傾向 filesort。**
要確認它有沒有生效，**每次都要看 `EXPLAIN`，不能假設「我建了索引就會用」**。

📌 **另外兩個關於降序索引的實測結論**：

```
① 對【視窗函式】完全沒用（02 章 2.6.8）—— 那個 Sort 不會消失
② 單一方向的 DESC 不需要它 —— MySQL 8 的 Backward index scan 就夠了
   實測：ORDER BY placed_at DESC → Extra: Backward index scan; Using index
∴ 降序索引只在【混合方向】的 ORDER BY 才值得建
```

### 3.5.6 欄位順序怎麼決定

**四條規則，依序套用**：

```
① 等值條件的欄位 → 放前面
② 範圍條件的欄位 → 放最後一個（3.5.3）
③ 等值條件之間，【選擇性高】的放前面
   （選擇性 = COUNT(DISTINCT col) / COUNT(*)，越接近 1 越好）
④ 如果有 ORDER BY，它的欄位要接在等值條件後面、且順序一致（3.5.5）
```

⚠️ **③ 有一個常見的反對意見：「不是應該把最常用的欄位放前面嗎？」**

**兩者其實是同一件事的兩面**：

```
一個索引 (a, b) 能服務的查詢：
    WHERE a = ?                  ✅
    WHERE a = ? AND b = ?        ✅
    WHERE b = ?                  🔴（除了 skip scan）

∴ 放在前面的欄位，能服務【更多種】查詢
∴ 「最常單獨出現在 WHERE 裡的欄位」應該放前面
```

📌 **當 ③ 與這個原則衝突時（選擇性高的欄位很少單獨查），
以「能服務更多查詢」為優先** —— 因為那決定了你需要幾個索引，
而索引的數量比單一查詢的效率更重要（3.3.4）。

**實測本章表的選擇性**：

```sql
SELECT COUNT(*) 總列數,
       COUNT(DISTINCT order_no)    order_no,
       COUNT(DISTINCT customer_id) customer_id,
       COUNT(DISTINCT placed_at)   placed_at,
       COUNT(DISTINCT status)      status,
       COUNT(DISTINCT channel)     channel
FROM ord;
```

| 欄位 | 不同值 | 選擇性 | 適合當領頭欄位嗎 |
|---|---|---|---|
| `order_no` | 1,000,000 | 1.000 | ✅ 但它是唯一索引，通常單獨用 |
| `placed_at` | ~1,000,000 | ~1.000 | 🟡 它幾乎總是**範圍**條件 → 該放最後 |
| `customer_id` | 20,000 | 0.020 | ✅ 常做等值條件 |
| `status` | 7 | 0.000007 | 🔴 選擇性極低，但常跟其他欄位一起用 |
| `channel` | 4 | 0.000004 | 🔴 同上 |

📌 **`status` 這種低基數欄位的正確用法**：

```sql
🔴 KEY (status)                    -- 單欄索引，幾乎沒用（DELIVERED 佔 75%）
✅ KEY (status, placed_at)         -- 複合：status 篩掉一部分，placed_at 給範圍與排序
✅ KEY (customer_id, status)       -- 複合：先用高選擇性的篩，再用 status 細分
```

⚠️ **「低基數欄位不該建索引」是一個常見但過度簡化的說法。**
`status = 'REFUNDED'`（0.99%）走索引是划算的；
`status = 'DELIVERED'`（75%）走索引不划算 ——
**而這兩句用的是同一個索引，優化器會各自判斷**（3.9.2 的直方圖就是在幫它判斷）。

---

## 3.6 覆蓋索引

### 3.6.1 `Using index` 的意義

```
Extra: Using index          →  ✅ 覆蓋索引：查詢要的欄位【全部】在索引裡，不用回表
Extra: Using index condition →  🟡 ICP：條件在索引層過濾，但還是要回表拿其他欄位
Extra: （沒有這兩個）        →  要回表
```

⚠️ **不要跟 `type: index` 搞混**：

```
type: index          →  🔴 「掃了整個索引」（存取方式）
Extra: Using index   →  ✅ 「不用回表」（是否覆蓋）

它們可以同時出現：type: index + Using index
    = 掃了整個索引，但至少不用回表
    = 比 type: ALL 好，但仍然讀了每一項
```

### 3.6.2 實測：加一個欄位讓查詢快 6.9 倍

3.3.3 已經量過。**這裡看它在 `EXPLAIN` 上的樣子**：

```sql
-- idx_cover (customer_id, placed_at, status, total_amount)
EXPLAIN SELECT SUM(total_amount) FROM ord WHERE customer_id = 42;
```

```
type: ref   key: idx_cover   key_len: 4   rows: 2062   Extra: Using index      ← ✅
```

```sql
EXPLAIN SELECT SUM(total_amount), MAX(remark) FROM ord WHERE customer_id = 42;
```

```
type: ref   key: idx_cust_placed   key_len: 4   rows: 2062   Extra: NULL       ← 🔴 要回表
```

📌 **注意 `key` 也變了**：第二句連 `idx_cover` 都不用了 ——
既然一定要回表，用哪一個索引都得回表，**優化器就選了比較小的那一個**
（`idx_cust_placed` 1509 頁 vs `idx_cover` 2649 頁）。

### 3.6.3 該不該把欄位塞進索引：兩個代價

**覆蓋索引的誘惑很大** —— 加一個欄位就快 6.9 倍。**但它有兩個代價**：

**代價一：索引變大，吃掉 buffer pool**

```sql
SELECT index_name, stat_value AS leaf_pages FROM mysql.innodb_index_stats
WHERE database_name='shop3' AND table_name='ord' AND stat_name='n_leaf_pages';
```

```
index_name           leaf_pages
PRIMARY              5069
idx_cust_placed      1509        ← (customer_id, placed_at)
idx_cover            2649        ← (customer_id, placed_at, status, total_amount)
                     ^^^^
                     多兩個欄位 → 大 75%
```

**代價二：寫入變慢**

01 章 1.9.2 量過：6 個二級索引讓插入慢 **1.6 倍**。
而覆蓋索引是「更寬的索引」，每次 `UPDATE` 到索引裡的任何一個欄位都要維護它。

⚠️ **一個特別要注意的**：

```sql
KEY idx_cover (customer_id, placed_at, status, total_amount)
                                       ^^^^^^
                                       status 是會被 UPDATE 的欄位！
```

**訂單狀態每改一次（PENDING → PAID → SHIPPED → DELIVERED，一張訂單至少四次），
這個索引就要被更新一次** —— 而它是索引的第三欄，更新意味著索引項要**刪掉再插入**
（位置變了）。

> 📌 **判準（三個問題都要「是」才加）**：
>
> ```
> ① 這個查詢是【高頻】的嗎？（每秒幾十次以上，或是首頁的必經之路）
> ② 加進去的欄位是【很少變動】的嗎？
> ③ 加進去之後索引還是【明顯小於】聚簇索引嗎？
> ```
>
> **本章的 `idx_cover` 其實違反了 ②** —— 它是為了實驗方便才這樣建的。
> 3.10 的正式設計會把 `status` 拿掉。

📌 **一個折衷做法：用主鍵回表，但只回一次**

```sql
-- 🔴 一句查詢，2062 次回表
SELECT id, order_no, customer_id, status, total_amount, placed_at, remark
FROM ord WHERE customer_id = 42 ORDER BY placed_at DESC LIMIT 20;

-- ✅ 先用覆蓋索引把 20 個 id 撈出來，再回表 20 次
SELECT o.* FROM ord o
JOIN (SELECT id FROM ord WHERE customer_id = 42 ORDER BY placed_at DESC LIMIT 20) t
  ON t.id = o.id
ORDER BY o.placed_at DESC;
```

**實測（各跑三次）**：

```
① 直接查（回表 20 次）     0.79 / 0.39 / 0.37 ms
② 延遲關聯                 0.35 / 0.35 / 0.35 ms
                            ★ 熱快取之後幾乎沒有差別
```

⚠️ **在這個例子裡它沒有用** —— 因為 `LIMIT 20` 加上索引順序，
MySQL 本來就只會回表 20 次，20 次的成本可以忽略。

📌 **注意 ① 的第一次是 0.79 ms（其他兩次 0.37）** ——
那是冷快取。**如果你只量一次，會得出「延遲關聯快 2.3 倍」的錯誤結論。**
量測至少要跑三次，取穩定之後的值。

> ✅ **這個技巧真正的用途是「深分頁」**（3.8.6）——
> 那裡回表的次數是 `OFFSET + LIMIT`，而不是 `LIMIT`。

---

## 3.7 索引失效的八種情境 ★★

**每一種都有實測的 `EXPLAIN` 對照。而其中三種的「標準修法」不管用** ——
那三個反例比八種情境本身更重要。

**基準線**（可以用索引的樣子）：

```sql
EXPLAIN SELECT * FROM ord WHERE customer_id = 42;
```

```
type: ref   key: idx_cust_placed   key_len: 4   rows: 2062   Extra: NULL      ← ✅
```

### 3.7.1 情境 ①：函式包住欄位

```sql
EXPLAIN SELECT * FROM ord WHERE DATE(placed_at) = '2026-08-01';
```

```
type: ALL   key: NULL   rows: 994030   Extra: Using where      ← 🔴 全表掃描
```

**為什麼**：索引裡存的是 `placed_at` 的值（`2026-08-01 10:15:00.000`），
不是 `DATE(placed_at)` 的值。MySQL **沒有辦法**用一棵按 `placed_at` 排序的樹，
去找「`DATE()` 之後等於某個值」的項目。

**修法：把函式從欄位上拿掉**

```sql
EXPLAIN SELECT * FROM ord WHERE placed_at >= '2026-08-01' AND placed_at < '2026-08-02';
```

```
type: range   key: idx_placed   key_len: 7   rows: 1051   Extra: Using index condition   ← ✅
```

⚠️ **反例一：修法沒用的情況**

```sql
EXPLAIN SELECT * FROM ord WHERE YEAR(placed_at) = 2026;                              -- 🔴 ALL
EXPLAIN SELECT * FROM ord WHERE placed_at >= '2026-01-01' AND placed_at < '2027-01-01';
```

```
type: ALL   key: NULL   rows: 994030   Extra: Using where      ← 🔴 改成區間之後【還是】全表掃描
```

**為什麼**：本章的資料橫跨 2024-01 到 2026-09（32 個月），
2026 年那 8 個月佔了約 **25%** 的資料。
**優化器算出「讀 25% 的資料 + 25 萬次回表」比「全表掃描」更貴，所以選了全表掃描。**

📌 **這是對的決定。** 而它教會我們一件事：

> **「改寫成區間」只在區間【選擇性夠高】時才有用。**
> 一天的資料（0.1%）→ 有用；一年的資料（25%）→ 沒用，而且沒用是**合理的**。

**修法二：函式索引（MySQL 8.0.13+）**

```sql
ALTER TABLE ord ADD KEY idx_placed_date ((CAST(placed_at AS DATE)));
```

```sql
EXPLAIN SELECT id FROM ord WHERE CAST(placed_at AS DATE) = '2026-08-01';
```

```
type: ref   key: idx_placed_date   key_len: 4   rows: 1051   Extra: NULL      ← ✅
```

⚠️ **一個很有用的驚喜：`DATE()` 也會用到這個索引**

```sql
EXPLAIN SELECT id FROM ord WHERE DATE(placed_at) = '2026-08-01';
```

```
type: ref   key: idx_placed_date   key_len: 4   rows: 1051   Extra: NULL      ← ✅ 也用到了！
```

**MySQL 認得 `DATE(x)` 與 `CAST(x AS DATE)` 是同義的**，
所以建一個函式索引可以救掉那些**已經寫在程式碼裡、不方便改的** `DATE()` 查詢。

> 📌 **函式索引的三個代價**：
> ```
> ① 它是一個實實在在的索引，要空間、要維護（3.6.3）
> ② 只有【完全相同】的運算式才用得到
>    → 建了 CAST(placed_at AS DATE)，寫 DATE_FORMAT(placed_at,'%Y-%m-%d') 就用不到
> ③ 它掩蓋了問題 —— 正確的做法通常是改查詢，而不是為爛查詢建索引
> ```

### 3.7.2 情境 ②：欄位上有運算

```sql
EXPLAIN SELECT * FROM ord WHERE customer_id + 0 = 42;
```

```
type: ALL   key: NULL   rows: 994030      ← 🔴
```

```sql
EXPLAIN SELECT * FROM ord WHERE customer_id = 42 + 0;
```

```
type: ref   key: idx_cust_placed   key_len: 4   rows: 2062      ← ✅
```

📌 **「常數側」的運算完全沒問題** —— MySQL 在優化階段就算掉了。
**只有「欄位側」的運算會殺掉索引。**

**實務上這個錯誤的樣子**：

```sql
-- 🔴 「找出金額打完 9 折後超過 1000 的訂單」
WHERE total_amount * 0.9 > 1000

-- ✅ 把運算移到常數側
WHERE total_amount > 1000 / 0.9
```

```sql
-- 🔴 「找出建立超過 30 天的訂單」
WHERE DATEDIFF(NOW(), placed_at) > 30

-- ✅
WHERE placed_at < NOW() - INTERVAL 30 DAY
```

### 3.7.3 情境 ③：隱式轉型

02 章 2.8 整節在講這件事。**這裡看它在 100 萬列上的樣子**：

```sql
EXPLAIN SELECT * FROM ord WHERE order_no = 'SO-0000500000';
```

```
type: const   key: uk_order_no   key_len: 130   rows: 1      ← ✅
```

```sql
EXPLAIN SELECT id FROM ord WHERE order_no = 500000;
```

```
type: index   key: uk_order_no   key_len: 130   rows: 994030   Extra: Using where; Using index
      ^^^^^                                          ^^^^^^^
      🔴 從 rows: 1 變成 rows: 994030
```

📌 **注意它「用了」`uk_order_no`** —— `key` 欄位有值，
所以**只看 `key` 會以為沒問題**。要看 `type`（`const` → `index`）與 `rows`（1 → 994030）。

⚠️ **這是「只看有沒有走索引」這個習慣最大的盲點**：
`type: index` 是「掃了整個索引」，它和「用索引查找」是完全不同的兩件事。

**方向很重要**（02 章 2.8.3）：

```
字串欄位 = 數字常數   →  🔴 整欄被轉成數字，索引失效
數字欄位 = 字串常數   →  ✅ 只轉常數，索引還在
```

### 3.7.4 情境 ④：前置 `%` 的 `LIKE`

```sql
EXPLAIN SELECT * FROM ord WHERE order_no LIKE 'SO-00005%';
```

```
type: range   key: uk_order_no   key_len: 130   rows: 207950   Extra: Using index condition   ← ✅
```

```sql
EXPLAIN SELECT * FROM ord WHERE order_no LIKE '%00005000';
```

```
type: ALL   key: NULL   rows: 994030      ← 🔴
```

**為什麼**：索引按字串的**開頭**排序。
`'SO-00005%'` 是一個連續的區間；`'%00005000'` 分散在整棵樹裡。

📌 **三種處理方式**：

```
① 只有前綴需求 → LIKE 'abc%' 就好，這是可以走索引的
② 真的要「包含」→ 全文索引（FULLTEXT）或搜尋引擎（Elasticsearch）
③ 「後綴」需求 → 存一個【反轉的欄位】並建索引
```

**③ 的實測**（10 萬列）：

```sql
ALTER TABLE revt
  ADD COLUMN order_no_rev VARCHAR(32) GENERATED ALWAYS AS (REVERSE(order_no)) VIRTUAL,
  ADD KEY idx_rev (order_no_rev);

EXPLAIN SELECT id FROM revt WHERE order_no_rev LIKE CONCAT(REVERSE('0005000'), '%');
```

```
type: range   key: idx_rev   rows: 1   Extra: Using where; Using index      ← ✅
```

```
id      order_no
5000    SO-0000005000
```

⚠️ **注意是 `CONCAT(REVERSE(x), '%')` 而不是 `REVERSE(x) || '%'`** ——
MySQL 的 `||` 預設是**邏輯 OR** 不是字串串接（除非開了 `PIPES_AS_CONCAT` 這個 `sql_mode`）。
**這是從 Oracle / PostgreSQL 轉過來的人最常踩的一個。**

### 3.7.5 情境 ⑤：`OR` 連接了沒有索引的欄位

```sql
EXPLAIN SELECT * FROM ord WHERE customer_id = 42 OR remark = 'x';
```

```
type: ALL   key: NULL   rows: 994030      ← 🔴
```

**為什麼**：`OR` 的意思是「兩邊任一成立」。
`customer_id = 42` 可以走索引，但 `remark = 'x'` 沒有索引 →
**必須掃全表才能確定沒有漏掉 `remark = 'x'` 的列**。

⚠️ **反例二：`UNION ALL` 這個「標準修法」也沒用**

```sql
EXPLAIN SELECT * FROM ord WHERE customer_id = 42
UNION ALL
SELECT * FROM ord WHERE remark = 'x';
```

```
select_type: PRIMARY   type: ref   key: idx_cust_placed   rows: 2062       ← ✅ 第一段好了
select_type: UNION     type: ALL   key: NULL   rows: 994030                ← 🔴 第二段還是全表
```

📌 **`UNION ALL` 把一次全表掃描變成「一次索引查找 + 一次全表掃描」——
總成本沒有變好，甚至多了合併的開銷。**

> ✅ **真正的修法只有兩個**：
> ```
> ① 給 remark 建索引 → 然後 EXPLAIN 會變成 index_merge（3.4.2 ⑤）
> ② 問清楚業務：真的需要 OR 嗎？
>    「客戶 42 的訂單」與「備註是 x 的訂單」通常是【兩個不同的功能】，
>    硬塞在一句 SQL 裡是介面設計的問題（06 站 0.6 判準 6）
> ```
>
> ⚠️ **`UNION ALL` 只在「兩邊都有索引，但優化器不肯用 index_merge」時才有意義。**

### 3.7.6 情境 ⑥：`<>` / `NOT IN` / `NOT LIKE`

```sql
EXPLAIN SELECT * FROM ord WHERE status <> 'DELIVERED';
```

```
type: ALL   key: NULL   rows: 994030      ← 🔴
```

```sql
EXPLAIN SELECT * FROM ord WHERE status = 'REFUNDED';
```

```
type: ref   key: idx_abc   key_len: 66   rows: 18240      ← ✅
```

⚠️ **反例三：「把 `<>` 改成列出所有要的值」也不一定有用**

```sql
EXPLAIN SELECT id FROM ord
WHERE status IN ('PENDING','PAID','PACKED','SHIPPED','CANCELLED','REFUNDED');
```

```
type: range   key: idx_status_placed   key_len: 66   rows: 497264   Extra: Using where; Using index
                                                          ^^^^^^^^
                                                          🔴 還是 50 萬列
```

📌 **因為 `<> 'DELIVERED'` 本來就命中 25% 的資料**（`DELIVERED` 佔 75%）。
**改寫成 `IN` 讓 `type` 從 `ALL` 變成 `range`、讓它變成覆蓋索引 ——
但要讀的資料量沒有變，因為那就是答案的大小。**

**再看一個 `<>` 的實測，這次它【用了】索引**：

```sql
EXPLAIN SELECT id FROM ord WHERE status <> 'REFUNDED';       -- REFUNDED 只佔 0.99%
```

```
type: range   key: idx_status_placed   rows: 654687   Extra: Using where; Using index   ← ✅ 用了
```

```sql
SELECT COUNT(*) FROM ord WHERE status <> 'REFUNDED';         -- 990,144（99%）
```

⚠️ **它命中 99% 的資料，卻用了索引** ——
因為 `SELECT id` 是**覆蓋查詢**（`Using index`），
掃 `idx_status_placed`（1846 頁）比掃聚簇索引（5069 頁）便宜。

**而同一個運算子在 `status <> 'DELIVERED'` 上是 `type: ALL`** ——
因為那一句是 `SELECT *`，一定要回表。

> 📌 **這一節的真正教訓**：
>
> ```
> 🔴 「<> 用不到索引」——  這句話是【錯的】
> ✅ 真正的判準有兩個，而且都跟運算子無關：
>      ① 要回傳幾列？（相對於全表）
>      ② 是不是覆蓋查詢？（要不要回表）
> ```
>
> **判準永遠是「要回傳幾列」，不是「用了什麼運算子」。**
> `status <> 'REFUNDED'`（99%）與 `status <> 'DELIVERED'`（25%）
> 用的是同一個運算子，而優化器對它們的判斷應該不同 ——
> **3.9.2 的直方圖就是為了讓它判斷得更準。**

### 3.7.7 情境 ⑦：最左前綴斷了

```sql
-- 索引：idx_cust_placed (customer_id, placed_at)
EXPLAIN SELECT * FROM ord WHERE placed_at >= '2026-08-01';
```

**先把 3.5.5 建的 `idx_placed` 拿掉，才看得到「沒有它」的樣子**：

```sql
ALTER TABLE ord DROP KEY idx_placed;
EXPLAIN SELECT * FROM ord WHERE placed_at >= '2026-08-01';
```

```
type: ALL   key: NULL   rows: 994030      ← 🔴 領頭欄位 customer_id 沒給
```

**把 `idx_placed (placed_at)` 加回來**：

```sql
ALTER TABLE ord ADD KEY idx_placed (placed_at);
EXPLAIN SELECT * FROM ord WHERE placed_at >= '2026-08-01';
```

```
type: range   key: idx_placed   key_len: 7   rows: 1051      ← ✅
```

📌 **3.5.4 的 skip scan 在這裡幫不上忙**，因為 `customer_id` 有 20,000 個不同值 ——
skip scan 要把查詢拆成 20,000 次索引查找，比全表掃描還貴。

> ⚠️ **skip scan 只在領頭欄位【基數很低】（幾個到幾十個值）時才會被選用。**

### 3.7.8 情境 ⑧：定序不同 —— 本章開場那個 1,950 倍 ★★

**這是 00 章 0.5.10 那個 `ERROR 1267` 的另一面：不報錯，但慢 2000 倍。**

```sql
-- 一張從舊系統來的表，定序是 utf8mb4_general_ci（00 章 0.5.6）
CREATE TABLE ord_legacy (order_no VARCHAR(32) NOT NULL PRIMARY KEY, note VARCHAR(50))
  CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
INSERT INTO ord_legacy SELECT order_no, 'x' FROM ord LIMIT 1000;      -- 只有 1000 列
```

**直接 JOIN 會 `ERROR 1267`，所以有人加了 `COLLATE` 硬轉**：

```sql
EXPLAIN SELECT o.id FROM ord o JOIN ord_legacy l
  ON l.order_no = o.order_no COLLATE utf8mb4_general_ci;
```

```
table: o   type: index    key: uk_order_no   rows: 994030   Extra: Using index
       ^                                          ^^^^^^^^
       🔴 100 萬列的表變成【驅動表】，而且掃了整個索引
table: l   type: eq_ref   key: PRIMARY       rows: 1        Extra: Using where; Using index
```

**正確的做法：把小表的定序改對，不要在查詢裡硬轉**

```sql
ALTER TABLE ord_legacy CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
EXPLAIN SELECT o.id FROM ord o JOIN ord_legacy l ON l.order_no = o.order_no;
```

```
table: l   type: index    key: PRIMARY       rows: 1000     Extra: Using index
       ^                                          ^^^^
       ✅ 1000 列的小表當驅動表
table: o   type: eq_ref   key: uk_order_no   rows: 1        Extra: Using index
```

**耗時（各跑兩次）**：

```
✅ 定序一致          1.55 / 1.03 ms
🔴 查詢裡 COLLATE   2035 / 2009 ms          ← 慢 1,950 倍
```

📌 **為什麼是「1950 倍」而不是「1000 倍」**：

```
定序一致：
    掃 1000 列的小表 → 每列在 uk_order_no 上做一次 eq_ref 查找
    = 1000 次索引查找

COLLATE 硬轉：
    o.order_no 被函式（定序轉換）包住 → uk_order_no 不能用來【查找】
    → 優化器只能反過來：掃【100 萬列】的 uk_order_no
    → 每一列都轉一次定序，再去小表查
    = 1,000,000 次定序轉換 + 1,000,000 次索引查找
```

⚠️ **這個 bug 的形狀特別惡劣**：

```
① 它是為了「修好 ERROR 1267」而加上去的 —— 加的人以為自己在修 bug
② 它在測試資料上跑得很快（小表 JOIN 小表）
③ 它會隨著【大表】長大而變慢，而大表長大是必然的
④ EXPLAIN 上看不出「有問題」—— type 是 index 與 eq_ref，看起來都用了索引
   ★ 唯一的線索是【JOIN 的順序反了】：小表應該當驅動表
```

> ✅ **診斷技巧：在 JOIN 的 `EXPLAIN` 裡，第一行（驅動表）應該是【最小的那張表】。**
> 如果它是大表，就去找是什麼阻止了優化器用小表當驅動 ——
> 通常就是定序、隱式轉型，或欄位上的函式。

### 3.7.9 八種情境總表

| # | 情境 | 例子 | 修法 | 修法一定有用嗎 |
|---|---|---|---|---|
| ① | 函式包住欄位 | `DATE(placed_at) = ?` | 改半開區間 / 函式索引 | 🔴 **區間不夠選擇性時沒用** |
| ② | 欄位上有運算 | `amount * 0.9 > ?` | 把運算移到常數側 | ✅ 總是有用 |
| ③ | 隱式轉型 | `varchar_col = 123` | 型別對齊（Java 側也要） | ✅ 總是有用 |
| ④ | 前置 `%` | `LIKE '%abc'` | 前綴查詢 / 全文索引 / 反轉欄位 | 🟡 要改需求 |
| ⑤ | `OR` 接無索引欄位 | `a = ? OR b = ?` | 給 `b` 建索引 | 🔴 **`UNION ALL` 沒用** |
| ⑥ | `<>` / `NOT IN` | `status <> 'X'` | 改 `IN`（列出要的） | 🔴 **命中太多列時沒用** |
| ⑦ | 最左前綴斷了 | 只給複合索引的第二欄 | 調整索引順序 / 建新索引 | ✅（skip scan 只是安全網） |
| ⑧ | 定序不同 | `ON a = b COLLATE x` | 改表的定序，不要在查詢裡轉 | ✅ 總是有用 |

📌 **三個反例（①⑤⑥）的共同點**：

> **它們不是「索引失效」，而是「這個查詢本來就要讀很多資料」。**
> 索引解決的是「從一百萬列裡找一千列」；
> 它解決不了「從一百萬列裡找二十五萬列」——
> **後者需要的是改需求（加更多篩選條件、分頁、預先聚合），不是改索引。**

---

## 3.8 索引設計方法

### 3.8.1 從查詢清單出發，不是從表出發

**錯誤的做法**（也是最常見的）：

```
建完表 → 看著每一個欄位想「這個會不會被查」→ 挨個建索引
        ↓
    十幾個單欄索引，寫入慢 1.6 倍（01 章 1.9.2），
    而真正的查詢一個都沒被服務好
```

**正確的做法**：

```
① 列出【所有】會打到這張表的查詢（02 章 2.9 就是在做這件事）
② 對每一句，寫出它的「存取模式」：
      WHERE 用了哪些欄位？等值還是範圍？
      ORDER BY 什麼？
      SELECT 哪些欄位？
③ 把存取模式相同或相容的查詢【合併】—— 一個索引可以服務多句
④ 對每一個索引候選，用 3.5.6 的四條規則排欄位順序
⑤ EXPLAIN 每一句，確認它真的用到了你設計的索引
⑥ 刪掉沒有任何查詢用到的索引（3.8.6 的不可見索引）
```

⚠️ **③ 是最能省索引的一步。** 例如：

```
Q1  WHERE customer_id = ? AND placed_at BETWEEN ? AND ?  ORDER BY placed_at DESC
Q3  WHERE customer_id = ?                                ORDER BY placed_at DESC
Q4  WHERE customer_id = ?  （+ EXISTS 子查詢）             ORDER BY placed_at DESC

    → 三句共用一個 KEY (customer_id, placed_at)
    → 而且因為主鍵隱含在最後（3.3.2），ORDER BY placed_at DESC, id DESC 也免費
```

### 3.8.2 複合索引 vs 多個單欄索引 ★

**實測**：兩張一模一樣的 100 萬列表，只差索引。

```sql
-- m2：兩個單欄索引
ALTER TABLE m2 ADD KEY k_status (status), ADD KEY k_channel (channel);
-- m3：一個複合索引
ALTER TABLE m3 ADD KEY k_sc (status, channel);
```

**`AND` 查詢**：

```sql
SELECT COUNT(*) FROM m2 WHERE status='REFUNDED' AND channel='LINE';
```

```
-- m2（兩個單欄）
type: index_merge   key: k_status,k_channel   key_len: 66,34   rows: 1854
Extra: Using intersect(k_status,k_channel); Using where; Using index

-- m3（一個複合）
type: ref   key: k_sc   key_len: 100   rows: 463   Extra: Using index
```

```
耗時：m2  11.6 / 10.2 ms
      m3   0.29 / 0.15 ms          ← ✅ 快 68 倍
索引空間：m2  71.7 MB
          m3  57.2 MB              ← ✅ 而且【更小】
```

**`OR` 查詢**：

```sql
SELECT id FROM m2 WHERE status='REFUNDED' OR channel='LINE';
```

```
-- m2（兩個單欄）
type: index_merge   key: k_status,k_channel   rows: 116602
Extra: Using union(k_status,k_channel); Using where          ← ✅

-- m3（一個複合）
type: index   key: k_sc   rows: 995044   Extra: Using where; Using index    ← 🔴 掃整個索引
```

> 📌 **結論**：
>
> | 查詢形狀 | 該建什麼 |
> |---|---|
> | `a = ? AND b = ?` | ✅ **複合索引** `(a, b)` —— 快 68 倍且更小 |
> | `a = ?` 與 `b = ?` **分別**出現在不同查詢 | 兩個單欄索引（或 `(a,b)` + `(b)`） |
> | `a = ? OR b = ?` | 兩個單欄索引（讓 `index_merge` 的 `union` 生效） |
>
> ⚠️ **看到 `Using intersect(...)` 就是一個訊號：那兩個欄位應該合成一個複合索引。**
> `intersect` 要各自掃一次索引、把主鍵集合排序、再取交集 —— 而複合索引一次就到位。

### 3.8.3 前綴索引

**用途**：欄位很長（URL、email、路徑），但前面幾個字元就有足夠的選擇性。

**先量選擇性**：

```sql
SELECT COUNT(DISTINCT order_no)             AS 全長,
       COUNT(DISTINCT LEFT(order_no, 8))    AS 前8,
       COUNT(DISTINCT LEFT(order_no, 10))   AS 前10,
       COUNT(DISTINCT LEFT(order_no, 12))   AS 前12
FROM ord;
```

```
全長        前8    前10    前12
1000000     11     1001    100001
```

📌 **這個資料的 `order_no` 格式是 `SO-` + 10 位數字**，所以：

```
前 8 個字元 = 'SO-00000' → 只有 11 種      🔴 完全沒用
前 10 個字元                → 1001 種       🔴 還是不夠
前 12 個字元                → 100001 種     🟡 10% 的選擇性
全長 13                    → 1000000       ✅
```

⚠️ **這是一個「不該用前綴索引」的例子** ——
因為變化都在**尾端**。前綴索引只適合「變化在前面」的欄位。

**適合的例子**：

```sql
-- email：變化在 @ 之前，前 12 個字元通常就夠
SELECT COUNT(DISTINCT email) / COUNT(*)              AS 全長選擇性,
       COUNT(DISTINCT LEFT(email, 12)) / COUNT(*)    AS 前12選擇性
FROM customer;
-- 目標：前 n 的選擇性達到全長的 95% 以上

ALTER TABLE customer ADD KEY idx_email_prefix (email(12));
```

**前綴索引的三個代價**：

```
🔴 ① 不能當【覆蓋索引】—— 索引裡只有前 12 個字元，MySQL 一定要回表確認
🔴 ② 不能用來 ORDER BY —— 前綴相同的項目之間沒有順序
🔴 ③ 不能用來做唯一約束 —— UNIQUE (email(12)) 會擋掉前 12 字元相同的不同 email
```

> 📌 **所以前綴索引的定位很窄**：
> **只在「欄位太長導致索引太大」而且「只做等值查詢」時用。**
> 更好的替代方案通常是 00 章 0.5.11 的**雜湊欄位**：
>
> ```sql
> ALTER TABLE links
>   ADD COLUMN url_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(url, 256))) STORED,
>   ADD INDEX idx_url_hash (url_hash);
> -- 查詢：WHERE url_hash = UNHEX(SHA2(?, 256)) AND url = ?
> ```
> **32 個位元組的固定長度、可以當覆蓋索引、可以做唯一約束。**

### 3.8.4 不可見索引：安全地「刪」索引 ★

**MySQL 8.0 的新功能，而它解決了一個很實際的恐懼**：
「這個索引好像沒人用，但我不敢刪。」

```sql
-- ① 先讓它「隱形」—— 優化器看不到它，但它還在、還在被維護
ALTER TABLE ord ALTER INDEX idx_placed INVISIBLE;
```

**實測：查詢立刻退化**

```sql
EXPLAIN SELECT id FROM ord WHERE placed_at >= '2026-08-01' AND placed_at < '2026-08-02';
```

```
-- 可見時
type: range   key: idx_placed          rows: 1051       ← ✅

-- 隱形後
type: range   key: idx_status_placed   rows: 110425     ← 🔴 退化了 105 倍
Extra: Using where; Using index for skip scan
```

```sql
SELECT INDEX_NAME, IS_VISIBLE FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA='shop3' AND TABLE_NAME='ord' GROUP BY INDEX_NAME, IS_VISIBLE;
```

```
INDEX_NAME           IS_VISIBLE
idx_abc              YES
idx_cover            YES
idx_cust_placed      YES
idx_placed           NO            ← ★
...
```

```sql
-- ② 觀察一週。有問題就一秒鐘還原（不用重建索引！）
ALTER TABLE ord ALTER INDEX idx_placed VISIBLE;

-- ③ 一週都沒事 → 真的刪掉
ALTER TABLE ord DROP KEY idx_placed;
```

> ⚠️ **③ 這一句是在示範流程，本章的實驗環境【沒有真的執行它】** ——
> `idx_placed` 後面還要用（3.9 的統計與 3.14 的索引清單都算它）。
> 你自己跑的時候如果刪了，記得先 `ALTER TABLE ord ADD KEY idx_placed (placed_at);` 再往下。

> 📌 **這個流程解決的問題**：
> ```
> 直接 DROP INDEX：
>     出事了 → CREATE INDEX 要重建整個索引
>     → 100 萬列大概幾秒；一億列可能要幾十分鐘
>     → 而且那幾十分鐘裡查詢一直是慢的
>
> INVISIBLE → 觀察 → DROP：
>     出事了 → ALTER INDEX VISIBLE，【毫秒級】，因為索引一直都在
> ```
>
> ⚠️ **兩個注意事項**：
> ```
> ① 隱形的索引【仍然要維護】—— 寫入成本沒有省下來，空間也沒省
>    → 它是「觀察期」，不是「省成本」
> ② 主鍵不能設成隱形
> ```

### 3.8.5 找出冗餘索引

**一個索引 `(a)` 如果被 `(a, b)` 涵蓋，它就是冗餘的** ——
因為任何能用 `(a)` 的查詢都能用 `(a, b)` 的最左前綴。

**一句 SQL 自動偵測**：

```sql
SELECT a.INDEX_NAME AS 冗餘的, b.INDEX_NAME AS 被誰涵蓋,
       a.cols AS 冗餘的欄位, b.cols AS 涵蓋者的欄位
FROM (SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ord'
      GROUP BY INDEX_NAME) a
JOIN (SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ord'
      GROUP BY INDEX_NAME) b
  ON a.INDEX_NAME <> b.INDEX_NAME
 AND b.cols LIKE CONCAT(a.cols, ',%');
```

**在本章的實驗表上跑出來**：

```
冗餘的              被誰涵蓋       冗餘的欄位                    涵蓋者的欄位
idx_cust_placed     idx_cover      customer_id,placed_at        customer_id,placed_at,status,total_amount
```

📌 **它抓到了**：`idx_cust_placed (customer_id, placed_at)` 是
`idx_cover (customer_id, placed_at, status, total_amount)` 的前綴。

⚠️ **但「冗餘」不代表「一定要刪」**：

```
idx_cust_placed  1509 葉頁
idx_cover        2649 葉頁

如果有很多查詢只需要 (customer_id, placed_at)，
留著小的那一個可以讓它們掃更少的頁（3.6.2 的實測就是這樣：
優化器在「反正要回表」的時候刻意選了小的 idx_cust_placed）
```

> 📌 **判準**：
> ```
> 刪：唯一索引與普通索引重複（UNIQUE (a) 與 KEY (a)）→ 一定刪普通的
> 刪：完全相同的兩個索引（不同名字，同樣欄位）→ 一定刪
> 考慮：(a) 被 (a,b) 涵蓋 → 如果 (a) 明顯小很多且有高頻查詢只用 a，可以留
> 不刪：(a,b) 與 (b,a) → 它們服務不同的查詢，兩個都不是冗餘
> ```
>
> ⚠️ **最後一條特別重要**：`(a,b)` 與 `(b,a)` **不是**重複索引。
> 3.5.1 的電話簿比喻：「按縣市→區排序」與「按區→縣市排序」是兩本不同的書。

**另外一句：找出從來沒被用過的索引**

```sql
-- 需要 performance_schema（預設開啟）
SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE INDEX_NAME IS NOT NULL
  AND INDEX_NAME <> 'PRIMARY'
  AND COUNT_STAR = 0
  AND OBJECT_SCHEMA NOT IN ('mysql','performance_schema','sys')
ORDER BY OBJECT_SCHEMA, OBJECT_NAME;
```

⚠️ **這一句的統計是從【MySQL 上次啟動】開始累積的。**
所以：

```
🔴 剛重啟就跑 → 所有索引都「沒被用過」
✅ 至少要跑過一個完整的業務週期（含月結、對帳、報表這些低頻但重要的作業）
   → 實務上建議至少觀察【一個月】
```

📌 **正確的流程是把兩者串起來**：

```
① performance_schema 找出候選（COUNT_STAR = 0，觀察一個月以上）
② 對每一個候選 ALTER INDEX ... INVISIBLE
③ 再觀察一週
④ DROP
```

### 3.8.6 深分頁：越翻越慢 ★

**實測（100 萬列）**：

```sql
SELECT id, order_no FROM ord ORDER BY id LIMIT 20 OFFSET ?;
```

| `OFFSET` | `EXPLAIN` 的 `rows` | 實測耗時 |
|---|---|---|
| 0 | 20 | **0.24 ms** |
| 500,000 | 500,020 | **58.2 ms**（慢 243 倍） |
| 900,000 | 900,020 | **106.1 ms**（慢 443 倍） |

**為什麼**：`LIMIT 20 OFFSET 900000` 的語意是
**「讀 900,020 列，丟掉前 900,000 列」** ——
MySQL 沒有辦法「跳到第 900,001 列」，它必須一列一列數過去。

**修法：seek 法（也叫 keyset pagination / cursor pagination）**

```sql
-- 🔴 offset 法
SELECT id, order_no FROM ord ORDER BY id LIMIT 20 OFFSET 900000;

-- ✅ seek 法：記住上一頁的最後一個 id
SELECT id, order_no FROM ord WHERE id > 900000 ORDER BY id LIMIT 20;
```

```
offset 法   106.1 ms
seek 法       0.33 ms          ← ✅ 快 319 倍
```

⚠️ **seek 法的三個限制**：

```
🔴 ① 不能「跳到第 N 頁」—— 只能上一頁 / 下一頁
     → 前端的分頁 UI 要改成「載入更多」或「無限滾動」
🔴 ② 排序欄位必須【唯一】（或加一個唯一的決勝欄位）
     → 02 章 2.6.4 講的同一件事
🔴 ③ 排序欄位不是主鍵時，游標要帶【兩個值】
```

**③ 的正確寫法**（按 `placed_at DESC` 排序，用 `id` 決勝）：

```sql
-- 第一頁
SELECT id, order_no, placed_at FROM ord
WHERE customer_id = ?
ORDER BY placed_at DESC, id DESC LIMIT 20;

-- 下一頁：帶上一頁最後一列的 (placed_at, id)
SELECT id, order_no, placed_at FROM ord
WHERE customer_id = ?
  AND (placed_at < ? OR (placed_at = ? AND id < ?))     -- ★ 複合游標
ORDER BY placed_at DESC, id DESC LIMIT 20;
```

📌 **更簡潔的等價寫法**（MySQL 支援列比較）：

```sql
  AND (placed_at, id) < (?, ?)
```

⚠️ **但要小心**：`(a, b) < (x, y)` 的語意是「字典序小於」，
**它與 `a < x OR (a = x AND b < y)` 等價，但優化器對它的索引使用可能不同** ——
**用哪一種都要 `EXPLAIN` 確認。**

**如果真的必須支援「跳到第 N 頁」**：

```
① 限制最大頁數（例如只給到第 100 頁）—— 實務上最常見，也最誠實
   ★ 因為沒有使用者會真的翻到第 45000 頁
② 延遲關聯（3.6.3 的技巧）：先用覆蓋索引撈 id，再回表
③ 預先算好每一頁的邊界（適合資料不常變的報表）
```

**② 的實測**（`OFFSET 900000`，`SELECT *`）：

```sql
-- 🔴 直接查
SELECT * FROM ord ORDER BY id LIMIT 20 OFFSET 900000;

-- 🟡 延遲關聯
SELECT o.* FROM ord o
JOIN (SELECT id FROM ord ORDER BY id LIMIT 20 OFFSET 900000) t ON t.id = o.id;
```

```
直接查      215 / 198 ms
延遲關聯    109 / 109 ms          ← 快 1.8 倍
seek 法       0.33 ms             ← ✅ 快 600 倍
```

📌 **延遲關聯只快 1.8 倍，而 seek 法快 600 倍** ——
因為延遲關聯仍然要**數過 900,020 個索引項**，它只省掉了 900,000 次回表。

> ⚠️ **所以延遲關聯是「不得不支援跳頁時」的緩解手段，不是解法。**
> **真正的解法是改 API**（06 站 04 章 4.7 的 `Slice`）。

📌 **06 站 04 章 4.7「列表翻到後面越來越慢，第 1 頁卻很快」的答案就在這裡** ——
而那一章給的是 Java 這一側的 API 設計（`Slice` 而不是 `Page`），
**這一章給的是它為什麼必須這樣設計的物理原因。**

---

## 3.9 統計資訊與優化器

### 3.9.1 `ANALYZE TABLE`

**優化器的所有決定都建立在統計資訊上**（3.4.5 已經看到它有多不準）。

```sql
ANALYZE TABLE ord;
```

**它做什麼**：重新取樣索引頁，更新 `mysql.innodb_index_stats`。

**取樣多少**：

```sql
SELECT @@innodb_stats_persistent, @@innodb_stats_persistent_sample_pages,
       @@innodb_stats_auto_recalc;
```

```
innodb_stats_persistent                 ON      ← 統計存在磁碟上，重啟不會沒有
innodb_stats_persistent_sample_pages    20      ← 🔴 只取樣 20 頁
innodb_stats_auto_recalc                ON      ← 資料變動超過 10% 時自動重算
```

⚠️ **20 頁對一個 5069 頁的索引來說是 0.4%** ——
這就是 3.4.5 那個「`status` 基數被估成 6 而實際是 7」的原因。

**調高它**：

```sql
-- 對單一表（推薦）
ALTER TABLE ord STATS_SAMPLE_PAGES = 200;
ANALYZE TABLE ord;

-- 全域（要謹慎，ANALYZE 會變慢）
SET GLOBAL innodb_stats_persistent_sample_pages = 100;
```

📌 **什麼時候要手動 `ANALYZE TABLE`**：

```
① 大量匯入 / 刪除之後（自動重算的門檻是 10%，一次匯入 5% 不會觸發）
② 剛建完索引（`ALTER TABLE ... ADD KEY` 之後統計是新的，但相關的其他索引可能不是）
③ 執行計畫突然變差，而 SQL 與資料都沒改 —— 這是頭號嫌疑
④ 升級 MySQL 之後
```

⚠️ **`ANALYZE TABLE` 在 MySQL 8 是非阻塞的**（不像 5.6 之前會鎖表），
但它會讓**所有引用這張表的執行計畫失效並重新編譯** ——
在極高 QPS 的表上，這一瞬間可能有可觀的 CPU 尖峰。

### 3.9.2 直方圖：救非索引欄位的估計 ★

**3.4.5 那個 `filtered: 33.33` 是寫死的猜測。直方圖可以修好它。**

```sql
-- 沒有直方圖時
EXPLAIN SELECT id FROM ord WHERE total_amount > 4000;
```

```
type: index   key: idx_cover   rows: 994030   filtered: 33.33
                                              ^^^^^^^^^^^^^^^
```

```sql
SELECT COUNT(*) FROM ord WHERE total_amount > 4000;    -- 200,022 → 20.12%
```

```sql
-- 建直方圖
ANALYZE TABLE ord UPDATE HISTOGRAM ON total_amount WITH 64 BUCKETS;
EXPLAIN SELECT id FROM ord WHERE total_amount > 4000;
```

```
type: index   key: idx_cover   rows: 994030   filtered: 20.20
                                              ^^^^^^^^^^^^^^^
                                              ✅ 實際是 20.12%，誤差 0.4%
```

**組合條件的效果更明顯**：

```sql
EXPLAIN SELECT id FROM ord WHERE customer_id = 42 AND total_amount > 4000;
```

```
type: ref   key: idx_cover   rows: 2062   filtered: 20.20
                                   ^^^^              ^^^^^
                             2062 × 20.20% = 416
```

```sql
SELECT COUNT(*) FROM ord WHERE customer_id = 42 AND total_amount > 4000;   -- 432
```

📌 **估計 416、實際 432 —— 誤差 3.7%**。
對照 3.4.5 那個 `+112%`，這是質的差別。

⚠️ **直方圖的四個限制**：

| 限制 | 說明 |
|---|---|
| **對有索引的欄位沒用** | 實測：`status` 建了直方圖，`EXPLAIN` 的 `rows` 完全沒變 —— 因為走索引時 MySQL 用索引統計 |
| **不會自動更新** | 🔴 `ANALYZE TABLE` **不會**更新直方圖，要明確寫 `UPDATE HISTOGRAM` |
| **資料變動後會過期** | 要排一個定期作業重建 |
| 桶數上限 1024 | 預設 100；本例用 64 就足夠 |

**查看與刪除**：

```sql
SELECT TABLE_NAME, COLUMN_NAME,
       JSON_EXTRACT(HISTOGRAM, '$."number-of-buckets-specified"') AS buckets
FROM information_schema.COLUMN_STATISTICS WHERE SCHEMA_NAME = DATABASE();

ANALYZE TABLE ord DROP HISTOGRAM ON total_amount;
```

> 📌 **什麼時候該建直方圖**：
> ```
> ✅ 這個欄位【沒有索引】，但常出現在 WHERE 裡
> ✅ 這個欄位的分布【很偏斜】（像本章的 status：DELIVERED 佔 75%）
> ✅ 這個欄位是 JOIN 條件的一部分 —— 因為 filtered 會影響 JOIN 順序
> 🔴 這個欄位是索引的領頭欄位 → 建了也沒用
> ```
>
> ⚠️ **「JOIN 順序」那一條是最有價值的用途**：
> 3.7.8 那個 1,950 倍的災難，本質上就是 **JOIN 順序選錯了** ——
> 而 JOIN 順序是靠 `rows × filtered` 決定的。

### 3.9.3 索引提示，與它的靜默失敗 ★

**兩套語法**：

```sql
-- ① 舊式（MySQL 5.x 就有）
SELECT ... FROM ord USE INDEX (idx_status_placed) WHERE ...      -- 「優先考慮這些」
SELECT ... FROM ord IGNORE INDEX (idx_abc) WHERE ...             -- 「不要用這些」
SELECT ... FROM ord FORCE INDEX (idx_cust_placed) WHERE ...      -- 「盡量用，除非完全不能用」

-- ② 新式 optimizer hints（MySQL 8 推薦）
SELECT /*+ INDEX(ord idx_status_placed) */ ... 
SELECT /*+ NO_INDEX(ord idx_abc, idx_status_placed) */ ...
```

**實測前先補一個索引** —— 下面第二句要示範「被忽略之後會退化到哪裡」，
需要一個「能覆蓋 `status` 但對 `WHERE status=?` 沒有領頭欄位」的索引：

```sql
ALTER TABLE ord ADD KEY idx_cust_status (customer_id, status);
```

📌 **此時 `ord` 上的二級索引一共 8 個**：
`uk_order_no`、`idx_cust_placed`、`idx_status_placed`、`idx_abc`、
`idx_cust_status`、`idx_cover`、`idx_placed`、`idx_placed_date`
（`idx_cp_desc` 在 3.5.5 量完就刪了。`idx_placed` 要留著 ——
3.8.4 最後那句 `DROP KEY idx_placed` 是在示範「刪索引的正確流程」，
本章的實驗環境沒有真的執行它。）

```sql
EXPLAIN SELECT id FROM ord USE INDEX (idx_status_placed) WHERE status='PAID';
```

```
type: ref   key: idx_status_placed   rows: 93958         ← ✅ 生效
```

```sql
EXPLAIN SELECT id FROM ord IGNORE INDEX (idx_abc, idx_status_placed) WHERE status='PAID';
```

```
type: index   key: idx_cust_status   rows: 996058        ← ✅ 生效（退化到另一個索引）
Extra: Using where; Using index
```

```sql
EXPLAIN SELECT id FROM ord FORCE INDEX (idx_cust_placed) WHERE status='PAID';
```

```
type: ALL   key: NULL   rows: 996058                     ← 🔴 全表掃描
```

📌 **`FORCE INDEX` 的誤解**：它**不能**強迫 MySQL 用一個「用不上」的索引。
`idx_cust_placed (customer_id, placed_at)` 對 `WHERE status='PAID'` 完全沒有幫助，
所以 `FORCE` 之後 MySQL 只剩「全表掃描」這一個選項。

⚠️ **最重要的一點：提示的語法錯誤是【警告】，不是錯誤。**

```sql
-- 空白分隔（錯的語法，應該用逗號）
EXPLAIN SELECT /*+ NO_INDEX(ord idx_abc idx_status_placed) */ id FROM ord WHERE status='PAID';
SHOW WARNINGS;
```

```
Level     Code   Message
Warning   1064   Optimizer hint syntax error near 'idx_status_placed) */ id FROM ord ...'
Note      1003   /* select#1 */ select `shop3`.`ord`.`id` ... 
                 ★ 注意重寫後的 SQL 裡【沒有】那個 hint —— 它被整個丟掉了
```

```sql
-- 索引名打錯
EXPLAIN SELECT /*+ INDEX(ord idx_不存在) */ id FROM ord WHERE status='PAID';
SHOW WARNINGS;
```

```
Warning   3128   Unresolved name `ord`@`select#1` `idx_不存在` for INDEX hint
```

🔴 **兩種情況查詢都正常執行，只是提示被無聲丟掉。**

> ✅ **驗證提示有沒有生效的唯一方法**：
> ```sql
> EXPLAIN SELECT /*+ ... */ ... ;
> SHOW WARNINGS;      -- ★ 看 Note 1003 那一行重寫後的 SQL 裡，hint 還在不在
> ```
>
> 📌 **這也是「用 hint 修效能問題」為什麼危險的原因**：
> 它是一段**寫在 SQL 字串裡、編譯器不檢查、測試通常不驗證**的設定。
> 一次改名、一次複製貼上、一次 ORM 版本升級，它就悄悄失效了。

> ⚠️ **關於索引提示的一般建議**：
>
> ```
> 🔴 不要當成常規手段。它是「優化器選錯了」的臨時繃帶
> ✅ 用它之前，先用 optimizer_trace 搞清楚優化器【為什麼】選錯
>    → 十次有八次的答案是「統計過期」或「缺直方圖」，那才是根因
> ✅ 如果真的要留 hint，在旁邊寫下：為什麼、什麼時候可以拿掉、
>    以及一條會在 hint 失效時紅燈的測試
> ```

---

## 3.10 shop-service 的索引設計

**這一節把 02 章 2.9 那九句查詢，一句一句 `EXPLAIN` 過。**

**實驗環境**：01 章 1.12 的完整 schema，灌到真實規模：

```
customer      20,000 列
product        5,000 列
stock          5,000 列
orders     1,000,000 列    資料 136.8 MB   索引 195.7 MB
order_item 2,000,000 列    資料 255.9 MB   索引 222.7 MB
```

⚠️ **注意 `orders` 的索引（195.7 MB）比資料（136.8 MB）大 43%**，
而 `order_item` 也是 —— **這就是 3.3.4 說的「索引不是免費的」在真實 schema 上的樣子。**
主鍵是 `BINARY(16)` 的 UUIDv7（01 章 1.8.8），所以每一個二級索引都要附帶 16 個位元組。

### 3.10.1 01 章的索引設計，跑起來對不對

**01 章 1.12 為 `orders` 設計了這些索引**：

```sql
PRIMARY KEY (id),
UNIQUE KEY uk_orders_order_no    (order_no),
UNIQUE KEY uk_orders_idempotency (idempotency_key),
KEY        idx_orders_customer_placed (customer_id, placed_at),
KEY        idx_orders_status_placed   (status, placed_at),
```

**`EXPLAIN` 每一句**：

```sql
-- Q1 訂單列表
SELECT o.id, o.order_no, o.status, o.total_amount, o.discount_amount, o.placed_at
FROM orders o
WHERE o.customer_id = ? AND o.placed_at >= ? AND o.placed_at < ?
ORDER BY o.placed_at DESC, o.id DESC LIMIT 20;
```

```
type: range   key: idx_orders_customer_placed   key_len: 23   rows: 68
Extra: Using index condition; Backward index scan
                                      ^^^^^^^^^^^^^^^^^^^^^
                                      ✅ 沒有 filesort
```

📌 **`key_len: 23` = `customer_id`(BINARY(16)) + `placed_at`(DATETIME(3), 7)** ——
**兩個欄位都用到了**，而且 `ORDER BY placed_at DESC, id DESC` 靠
`Backward index scan` + 主鍵隱含在索引尾端（3.3.2、3.5.5）完全免費。

```sql
-- Q4 買過某商品的訂單
SELECT o.id, o.order_no, o.total_amount, o.placed_at FROM orders o
WHERE o.customer_id = ?
  AND EXISTS (SELECT 1 FROM order_item i WHERE i.order_id = o.id AND i.product_id = ?)
ORDER BY o.placed_at DESC, o.id DESC LIMIT 20;
```

```
table: o   type: ref   key: idx_orders_customer_placed   rows: 2062
Extra: Using where; Backward index scan
table: i   type: ref   key: idx_order_item_order         rows: 1
Extra: Using where; FirstMatch(o)
                    ^^^^^^^^^^^^^^
```

📌 **`FirstMatch(o)` 是半連接優化**：對 `o` 的每一列，
在 `i` 裡**找到第一筆符合的就停**，不會像 JOIN 那樣把全部符合的都撈出來。
**這正是 02 章 2.3.3 說「用 `EXISTS` 不要 `JOIN`」的物理實現。**

**🔴 兩個查詢有問題**：

```sql
-- Q5 營運儀表板
SELECT COUNT(*), SUM(o.status='PENDING'), SUM(CASE WHEN o.status<>'CANCELLED' THEN o.total_amount END)
FROM orders o WHERE o.placed_at >= ? AND o.placed_at < ?;
```

```
type: ALL   key: NULL   rows: 990531   Extra: Using where      ← 🔴 全表掃描
```

**根因**：`placed_at` 只出現在兩個複合索引的**第二欄**（3.7.7 情境 ⑦）。
`idx_orders_customer_placed (customer_id, placed_at)` 的領頭是 `customer_id`（20,000 個值），
skip scan 幫不上忙（3.7.7 的說明）。

```sql
-- Q3 訂單列表 + 明細數
SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at, COUNT(i.id) AS item_count
FROM orders o LEFT JOIN order_item i ON i.order_id = o.id
WHERE o.customer_id = ? GROUP BY o.id ORDER BY o.placed_at DESC, o.id DESC LIMIT 20;
```

```
table: o   type: ref   key: idx_orders_customer_placed   rows: 2062
Extra: Using index condition; Using temporary; Using filesort      ← 🔴🔴
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**根因**：`GROUP BY o.id` 的順序（主鍵）與 `ORDER BY o.placed_at`（索引順序）**不一致** →
必須先建暫存表分組、再排序。

⚠️ **而且注意 `rows: 2062`** —— 它要處理**那個客戶的全部 2062 筆訂單**才能分組，
`LIMIT 20` 只在最後才生效。

### 3.10.2 修正一：補一個 `placed_at` 的索引

```sql
-- ★ 不是 KEY (placed_at)，而是把 Q5 要的欄位一起帶上（覆蓋索引，3.6）
ALTER TABLE orders ADD KEY idx_orders_placed (placed_at, status, total_amount);
```

```
type: range   key: idx_orders_placed   key_len: 7   rows: 57566
Extra: Using where; Using index
                    ^^^^^^^^^^^^
                    ✅ 覆蓋索引，不用回表
```

**耗時**：

```
有 idx_orders_placed      5.25 ms
用 NO_INDEX 提示關掉它     8.89 ms         ← 只快 1.7 倍
```

⚠️ **只快 1.7 倍，不是一個數量級。** 為什麼要老實說這件事：

```
這個查詢命中一個月的資料 ≈ 57,566 列 / 100 萬 ≈ 6%
    ↓
6% 已經足夠讓「全表掃描」與「索引掃描」的差距被壓縮
    ↓
而它【真正的價值】不在這 1.7 倍，在於：
    ① 不用回表（Using index）→ 不佔用聚簇索引的 buffer pool
    ② 併發時不會把整張表的頁全部拉進 buffer pool 擠掉別人的資料
    ③ 查一天（0.2%）而不是一個月時，差距會回到一個數量級
```

📌 **這是本章的一個反覆出現的主題**：
**單看一句查詢的耗時，常常看不出索引的價值** ——
索引真正的價值在「它讓這句查詢**不去打擾**其他查詢」。

### 3.10.3 修正二：Q3 改寫成相關子查詢 ★

**這裡有一個會讓人意外的結果。**

```sql
-- ✅ 改寫：不 JOIN，用相關子查詢算明細數
SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at,
       (SELECT COUNT(*) FROM order_item i WHERE i.order_id = o.id) AS item_count
FROM orders o WHERE o.customer_id = ?
ORDER BY o.placed_at DESC, o.id DESC LIMIT 20;
```

```
table: o   select_type: PRIMARY               type: ref   key: idx_orders_customer_placed
Extra: Using where; Backward index scan
                    ^^^^^^^^^^^^^^^^^^^^
                    ✅ Using temporary 與 Using filesort 都不見了
table: i   select_type: DEPENDENT SUBQUERY    type: ref   key: idx_order_item_order
Extra: Using index
```

**耗時（各兩次）**：

```
🔴 LEFT JOIN + GROUP BY      15.63 / 4.49 ms
✅ 相關子查詢                 0.24 / 0.24 ms          ← 快 19～65 倍
```

⚠️ **這跟 02 章 2.6.8 的結論「相關子查詢慢 135 倍」【看起來】矛盾。**

**它不矛盾。相關子查詢的成本公式是**：

```
總成本 = 外層的列數 × 每次子查詢的成本
```

| | 02 章 2.6.8 | 本節 Q3 |
|---|---|---|
| 外層列數 | **1,000,000**（沒有 `LIMIT`） | **20**（`LIMIT 20`，而且索引先給了順序） |
| 每次子查詢 | 一次索引查找 | 一次索引查找 |
| 總成本 | 100 萬次 → **732 ms** | 20 次 → **0.24 ms** |

📌 **關鍵在於「`LIMIT 20` 能不能在子查詢執行【之前】就生效」**：

```
✅ 可以（本節 Q3）：
      ORDER BY placed_at DESC 走 idx_orders_customer_placed 的索引順序
      → 不需要排序 → 讀到第 20 列就可以停 → 子查詢只跑 20 次

🔴 不可以（原本的 GROUP BY 版）：
      GROUP BY o.id 要先把 2062 列全部分組
      → LIMIT 只能在最後生效 → 2062 列的工作全都要做

🔴 不可以（02 章 2.6.8）：
      沒有 LIMIT，本來就要處理全部 100 萬列
```

> 📌 **修正版的規則**：
>
> ```
> 相關子查詢的成本 = 外層列數 × 每次成本
>
> ✅ 外層有 LIMIT n，而且 ORDER BY 走得到索引順序（不需要排序）
>       → 外層列數 = n → 相關子查詢是【最好】的選擇
> 🔴 外層要處理全部資料（沒有 LIMIT、或有 GROUP BY / filesort 擋在前面）
>       → 外層列數 = 全表 → 相關子查詢是【最差】的選擇
> ```
>
> ⚠️ **這就是為什麼「不要用相關子查詢」這種一句話規則會害人。**
> 02 章那個 135 倍與本節這個 19 倍是**同一個公式的兩端**，
> 而分辨它們的方法只有一個：**看 `EXPLAIN` 有沒有 `Using temporary` / `Using filesort`。**
> **有，就代表 `LIMIT` 沒辦法提早生效。**

### 3.10.4 最終的索引清單

```sql
-- ═══════════════════════════════════════════════════════════════
-- orders
-- ═══════════════════════════════════════════════════════════════
PRIMARY KEY (id)                                    -- 聚簇索引，UUIDv7（01 章 1.8.8）

UNIQUE KEY uk_orders_order_no (order_no)            -- 不變量 #1 + 「用編號查訂單」
UNIQUE KEY uk_orders_idempotency (idempotency_key)  -- 不變量 #9（NULL 可重複，01 章 1.7.2）

KEY idx_orders_customer_placed (customer_id, placed_at)
    -- 服務 Q1（訂單列表）、Q3（+明細數）、Q4（買過某商品）
    -- ★ 等值在前、範圍在後（3.5.3）
    -- ★ ORDER BY placed_at DESC, id DESC 免費（3.3.2 + 3.5.5）

KEY idx_orders_status_placed (status, placed_at)
    -- 服務「待出貨的訂單」、「待付款超過 30 分鐘的訂單」（排程任務）
    -- ⚠️ status 選擇性極低（7 個值，DELIVERED 佔 75%）
    --    → 只有查【少數狀態】時有用（PENDING 2%、REFUNDED 1%）
    --    → 查 DELIVERED 時優化器會（正確地）選全表掃描

KEY idx_orders_placed (placed_at, status, total_amount)     -- ★ 3.10.2 新增
    -- 服務 Q5（營運儀表板）、Q6（每日營業額）
    -- ★ 後兩欄是為了【覆蓋】（3.6），不是為了篩選

-- ═══════════════════════════════════════════════════════════════
-- order_item
-- ═══════════════════════════════════════════════════════════════
PRIMARY KEY (id)
KEY idx_order_item_order (order_id)                 -- 服務 Q2（訂單詳情）、Q3、Q4
KEY idx_order_item_product (product_id)             -- 外鍵自動建的（01 章 1.10.3）
                                                    -- 順便服務「某商品的銷售明細」

-- ═══════════════════════════════════════════════════════════════
-- customer / product / stock
-- ═══════════════════════════════════════════════════════════════
-- customer：PRIMARY + uk_customer_email(email_active) + uk_customer_username(username_active)
--           + uk_customer_phone(phone) —— 全部來自 01 章 1.10.4 的不變量
-- product： PRIMARY + uk_product_sku(sku) + idx_product_color(color 生成欄位)
-- stock：   PRIMARY (product_id) —— 只有主鍵，因為它只被主鍵查（04 章的原子 UPDATE）
```

### 3.10.5 刻意**沒有**建的索引

| 沒建 | 為什麼 |
|---|---|
| `KEY (status)` 單欄 | 3.5.6：7 個值，`DELIVERED` 佔 75%，單欄索引幾乎沒用 |
| `KEY (total_amount)` | 沒有任何查詢按金額篩選或排序；報表用 `SUM` 而不是 `WHERE` |
| `KEY (paid_at)` / `KEY (shipped_at)` | 這些欄位只被**讀取**，沒有查詢用它們當條件 |
| `KEY (customer_id, status)` | Q1～Q4 都不需要它；真的需要時 `idx_orders_customer_placed` + 逐列過濾 2062 列也夠快 |
| `KEY (customer_id, placed_at, status, total_amount)` 覆蓋版 | 3.6.3：`status` 會被 `UPDATE`（一張訂單至少四次），維護成本太高 |
| `order_item` 上的 `(order_id, product_id)` | Q4 已經有 `idx_order_item_order` + `Using where`；rows 只有 1～2 |

📌 **「刻意不建」的清單，跟「建了什麼」一樣重要。**
它是 code review 時的依據 —— 下一個人想加索引時，
**要先解釋這張表上的理由為什麼不再成立。**

### 3.10.6 一組可以放進 CI 的執行計畫守門測試

```java
package com.example.shop.infra.db;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 守門：關鍵查詢的執行計畫。
 *
 * ★ 為什麼需要這一組：
 *   本章 3.7 的八種失效情境，有六種是「某天有人改了一句 SQL / 改了一個索引」造成的。
 *   它們不會讓測試變紅（答案還是對的），只會讓查詢慢三個數量級。
 *   這一組測試把「執行計畫」變成一個【契約】。
 *
 * ⚠️ 這一組必須跑在【有代表性資料量】的資料庫上。
 *    在一張只有 5 列的表上，EXPLAIN 永遠是 ALL，而那是對的（3.4.2）。
 *    → 06 章的 Flyway 遷移之後跑一個 seed 腳本，或用 Testcontainers 掛一份 dump。
 */
@SpringBootTest
class QueryPlanContractTest {

    @Autowired JdbcTemplate jdbc;

    private Map<String, Object> explain(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList("EXPLAIN " + sql, args);
        assertThat(rows).as("EXPLAIN 應該至少有一行").isNotEmpty();
        return rows.get(0);          // 第一行 = 驅動表（3.7.8 的診斷技巧）
    }

    /** Q1：訂單列表。它是最高頻的查詢，必須走 idx_orders_customer_placed 且不排序 */
    @Test
    void Q1_訂單列表走複合索引且不需要排序() {
        var plan = explain("""
                SELECT o.id, o.order_no, o.status, o.total_amount, o.placed_at
                FROM orders o
                WHERE o.customer_id = ? AND o.placed_at >= ? AND o.placed_at < ?
                ORDER BY o.placed_at DESC, o.id DESC LIMIT 20
                """, someCustomerId(), "2026-08-01", "2026-09-01");

        assertThat((String) plan.get("key"))
                .as("沒走 idx_orders_customer_placed，代表索引被改動或查詢被改寫了")
                .isEqualTo("idx_orders_customer_placed");

        assertThat((String) plan.get("type")).isIn("ref", "range");

        // ★ key_len 23 = customer_id BINARY(16) + placed_at DATETIME(3) 7
        //   只有 16 就代表 placed_at 那個範圍條件沒被用上（3.4.3）
        assertThat(plan.get("key_len")).as("兩個索引欄位都要用到").hasToString("23");

        assertThat((String) plan.getOrDefault("Extra", ""))
                .as("ORDER BY 應該靠索引順序完成（3.5.5）")
                .doesNotContain("Using filesort")
                .doesNotContain("Using temporary");
    }

    /** Q5：儀表板。它是覆蓋查詢，不該回表（3.10.2） */
    @Test
    void Q5_儀表板走覆蓋索引() {
        var plan = explain("""
                SELECT COUNT(*), SUM(o.status='PENDING'),
                       SUM(CASE WHEN o.status<>'CANCELLED' THEN o.total_amount END)
                FROM orders o WHERE o.placed_at >= ? AND o.placed_at < ?
                """, "2026-08-01", "2026-09-01");

        assertThat((String) plan.get("key")).isEqualTo("idx_orders_placed");
        assertThat((String) plan.getOrDefault("Extra", ""))
                .as("少了 Using index 就代表 idx_orders_placed 的後兩欄被刪掉了")
                .contains("Using index");
    }

    /** 一條【通用】的守門：任何關鍵查詢都不該是全表掃描 */
    @Test
    void 關鍵查詢都不是全表掃描() {
        record NamedQuery(String name, String sql, Object[] args) { }
        var queries = List.of(
                new NamedQuery("Q1 訂單列表",
                        "SELECT id FROM orders WHERE customer_id = ? ORDER BY placed_at DESC LIMIT 20",
                        new Object[]{someCustomerId()}),
                new NamedQuery("Q2 訂單詳情",
                        "SELECT id FROM orders WHERE order_no = ?",
                        new Object[]{"SO-0000500000"}),
                new NamedQuery("待出貨清單",
                        "SELECT id FROM orders WHERE status = ? ORDER BY placed_at LIMIT 100",
                        new Object[]{"PACKED"}));

        for (var q : queries) {
            var plan = explain(q.sql(), q.args());
            assertThat((String) plan.get("type"))
                    .as("%s 變成全表掃描了（本章 3.7 的八種情境之一）", q.name())
                    .isNotEqualTo("ALL");
        }
    }

    /**
     * 一條會抓到「索引被誤刪」的守門：
     * 直接檢查索引的定義，比檢查執行計畫更穩定（不受優化器版本影響）。
     */
    @Test
    void 關鍵索引都還在而且欄位順序正確() {
        var actual = jdbc.queryForList("""
                SELECT INDEX_NAME AS name,
                       GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
                GROUP BY INDEX_NAME
                """);

        var byName = actual.stream().collect(
                java.util.stream.Collectors.toMap(r -> (String) r.get("name"), r -> (String) r.get("cols")));

        assertThat(byName)
                .as("索引的【欄位順序】跟索引本身一樣重要（3.5.1）")
                .containsEntry("idx_orders_customer_placed", "customer_id,placed_at")
                .containsEntry("idx_orders_status_placed",   "status,placed_at")
                .containsEntry("idx_orders_placed",          "placed_at,status,total_amount")
                .containsEntry("uk_orders_order_no",         "order_no");
    }

    /**
     * 3.8.5：沒有冗餘索引（新加的索引不該把既有的變成前綴）。
     *
     * ⚠️ 這一句 SQL 有一個很容易寫錯的地方：兩個子查詢都要 SELECT TABLE_NAME，
     *    而且 JOIN 條件要比對 TABLE_NAME —— 否則會跨表誤判。
     *    （本章寫這段時就先踩了一次：它報出「address 的索引被 orders 的索引涵蓋」）
     */
    @Test
    void 沒有冗餘索引() {
        var redundant = jdbc.queryForList("""
                SELECT CONCAT(a.TABLE_NAME, '.', a.INDEX_NAME,
                              ' 被 ', b.INDEX_NAME, ' 涵蓋') AS msg
                FROM (SELECT TABLE_NAME, INDEX_NAME,
                             GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
                      FROM information_schema.STATISTICS
                      WHERE TABLE_SCHEMA = DATABASE()
                      GROUP BY TABLE_NAME, INDEX_NAME) a
                JOIN (SELECT TABLE_NAME, INDEX_NAME,
                             GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
                      FROM information_schema.STATISTICS
                      WHERE TABLE_SCHEMA = DATABASE()
                      GROUP BY TABLE_NAME, INDEX_NAME) b
                  ON a.TABLE_NAME = b.TABLE_NAME          -- ★ 少了這一行就會跨表誤判
                 AND a.INDEX_NAME <> b.INDEX_NAME
                 AND b.cols LIKE CONCAT(a.cols, ',%')
                """, String.class);

        assertThat(redundant)
                .as("每一個冗餘索引都要有一行註解說明【為什麼留著】（3.8.5）")
                .isEmpty();
    }

    private byte[] someCustomerId() {
        return jdbc.queryForObject("SELECT id FROM customer LIMIT 1", byte[].class);
    }
}
```

> ⚠️ **這一組測試有一個真實的缺點：它很脆。**
>
> ```
> 優化器升級 → 選了另一個（更好的）索引 → 測試紅
> 資料分布改變 → type 從 ref 變成 range → 測試紅
> ```
>
> 📌 **所以要分兩層寫**：
> ```
> 硬斷言（不容易變的）：
>     ✅ 索引存在且欄位順序正確（最後兩條測試）
>     ✅ type 不是 ALL
>     ✅ Extra 沒有 Using filesort / Using temporary
>
> 軟斷言（會變的，寫成【警告】而不是失敗）：
>     🟡 key 是哪一個具體的索引
>     🟡 rows 的量級
> ```
>
> **而「索引存在且欄位順序正確」那一條，是全部裡面最有價值的** ——
> 因為 3.7 的八種情境裡，最常發生的其實是：
> **有人在做另一件事的時候，順手刪掉或改掉了一個索引。**

---

## 3.11 常見誤區

**誤區 1：「`EXPLAIN` 的 `rows` 就是會讀幾列」**

→ 3.4.5 實測：七種狀態的估計誤差是 **−33.7% 到 +111.6%**，沒有一個在 30% 以內。
`rows` 來自只取樣 **20 個頁**的統計（3.9.1）。
**要看實際列數用 `EXPLAIN ANALYZE`。**

**誤區 2：「`key` 有值就代表走了索引，沒問題」**

→ 3.7.3 實測：`WHERE order_no = 500000`（隱式轉型）的 `key` 是 `uk_order_no`，
**但 `type` 是 `index`、`rows` 是 994030** —— 它掃了整個索引。
**要看 `type` 與 `rows`，不要只看 `key`。**

**誤區 3：「`type: index` 不錯，至少用了索引」**

→ 3.6.1：`type: index` 是「**掃了整個索引**」，`Extra: Using index` 才是「不用回表」。
兩個名字很像，意思完全不同。

**誤區 4：「`Using filesort` 代表用了磁碟」**

→ 3.4.4：它先試記憶體（`sort_buffer_size` 預設 256 KB）。
要看有沒有用磁碟，看 `Sort_merge_passes`。
而且 `ORDER BY ... LIMIT 100` 走優先佇列，實測 `Sort_rows` 只有 **100** 不是 100 萬。

**誤區 5：「最左前綴是鐵律，跳過領頭欄位一定用不到索引」**

→ 3.5.4 實測：MySQL 8 的 **skip scan** 會讓它用得上（`Using index for skip scan`）。
**但它只在領頭欄位基數很低時觸發，估計很粗（248,887 vs 實際 86），
而且有更好的索引時優化器會忽略它。** 規則本身仍然完全有效。

**誤區 6：「`WHERE` 裡條件的順序要跟索引一致」**

→ 3.5.2：**`WHERE` 的順序完全不重要**，優化器會重排。
重要的是**索引定義**裡的順序。

**誤區 7：「範圍條件放哪裡都一樣」**

→ 3.5.3 實測：`WHERE status > 'PACKED' AND channel = 'WEB'` 的 `key_len` 只有 **66**
（只用了 `status` 一欄）—— `channel` 完全白給。
**等值在前、範圍在後。**

**誤區 8：「`ORDER BY ... DESC` 一定要 filesort」**

→ 3.5.5 實測：MySQL 8 有 **`Backward index scan`**。
而 `ORDER BY placed_at, id`（加決勝欄位）**也不用排序**，
因為主鍵隱含在二級索引的尾端（3.3.2）—— **決勝欄位是免費的。**

**誤區 9：「建了降序索引，混合方向的 `ORDER BY` 就不用排序了」**

→ 3.5.5 實測：**降序索引有效，但優化器不一定會選它**。
`WHERE customer_id = 42`（等值）時它會選；`BETWEEN 1 AND 5`（範圍）時它選了 filesort。
**每次都要 `EXPLAIN` 確認。**

**誤區 10：「函式包住欄位就改寫成區間，一定會走索引」**

→ 3.7.1 實測（反例一）：`YEAR(placed_at) = 2026` 改成
`placed_at >= '2026-01-01' AND placed_at < '2027-01-01'` **仍然是全表掃描** ——
因為 2026 年佔了 25% 的資料，**優化器選全表掃描是對的**。
**「改寫成區間」只在區間夠選擇性時有用。**

**誤區 11：「`OR` 用不到索引，改成 `UNION ALL` 就好」**

→ 3.7.5 實測（反例二）：`UNION ALL` 把「一次全表掃描」變成
「一次索引查找 + 一次全表掃描」—— **總成本沒有變好**。
沒有索引的那一邊，改寫救不了它。

**誤區 12：「`<>` / `NOT IN` 用不到索引」**

→ 3.7.6 實測（反例三）：`status <> 'REFUNDED'`（命中 99%）**用了索引**
（因為是覆蓋查詢）；`status <> 'DELIVERED'`（命中 25%）沒用（因為 `SELECT *` 要回表）。
**判準是「回傳幾列」與「要不要回表」，跟運算子無關。**

**誤區 13：「加了 `COLLATE` 修好 `ERROR 1267` 就沒事了」**

→ 3.7.8 實測：**慢 1,950 倍**（1.03 ms → 2009 ms）。
`COLLATE` 是一個包住欄位的函式，它讓 100 萬列的表變成驅動表。
**正確做法是改表的定序（`ALTER TABLE ... CONVERT TO`），不是在查詢裡轉。**

**誤區 14：「JOIN 的順序由我寫的順序決定」**

→ 3.7.8：優化器自己決定驅動表。
**診斷技巧：`EXPLAIN` 的第一行應該是最小的那張表。**
如果是大表，去找是什麼阻止了它 —— 通常是定序、隱式轉型或函式。

**誤區 15：「相關子查詢一定慢，不要用」**

→ 02 章 2.6.8 說慢 135 倍，本章 3.10.3 實測**快 19～65 倍**。
**成本 = 外層列數 × 每次成本。**
有 `LIMIT n` 且 `ORDER BY` 走索引順序時，外層列數就是 `n` ——
那時相關子查詢是**最好**的選擇。
**分辨的方法：`EXPLAIN` 有沒有 `Using temporary` / `Using filesort`。**

**誤區 16：「兩個單欄索引等於一個複合索引」**

→ 3.8.2 實測：`AND` 查詢，複合索引快 **68 倍**（0.15 ms vs 10.2 ms）**而且更小**
（57 MB vs 72 MB）。
**看到 `Using intersect(...)` 就是「該合成複合索引」的訊號。**

**誤區 17：「複合索引一定比單欄索引好」**

→ 3.8.2 實測：`OR` 查詢反過來 —— 兩個單欄索引走 `Using union(...)`（116,602 列），
複合索引掃整個索引（995,044 列）。

**誤區 18：「`FORCE INDEX` 可以強迫 MySQL 用我指定的索引」**

→ 3.9.3 實測：`FORCE INDEX (idx_cust_placed)` 配 `WHERE status='PAID'` →
`type: ALL`（全表掃描）。**它只能移除其他選項，不能讓一個用不上的索引變得可用。**

**誤區 19：「我加了 optimizer hint，所以它生效了」**

→ 3.9.3 實測：語法錯誤（空白分隔而非逗號）只產生 **`Warning 1064`**，
索引名打錯只產生 **`Warning 3128`** —— **兩種情況查詢都正常執行，hint 被無聲丟掉**。
**要 `EXPLAIN` 後看 `SHOW WARNINGS` 的 `Note 1003`，確認 hint 還在重寫後的 SQL 裡。**

**誤區 20：「`ANALYZE TABLE` 會更新直方圖」**

→ 3.9.2：**不會**。直方圖要明確寫 `ANALYZE TABLE ... UPDATE HISTOGRAM ON ...`，
而且**不會自動更新**，要排定期作業。

**誤區 21：「直方圖可以改善所有欄位的估計」**

→ 3.9.2 實測：對**有索引的欄位沒有效果**（`status` 建了直方圖，`rows` 完全沒變）——
因為走索引時 MySQL 用索引統計。
**直方圖是給沒有索引、但常出現在 `WHERE` 裡的偏斜欄位用的。**

**誤區 22：「深分頁慢是因為資料多」**

→ 3.8.6 實測：`LIMIT 20 OFFSET 900000` 要 **106 ms**，
`WHERE id > 900000 LIMIT 20` 要 **0.33 ms** —— **快 319 倍**。
資料一樣多，差別是「要不要一列一列數過去」。

**誤區 23：「深分頁用延遲關聯就修好了」**

→ 3.8.6 實測：延遲關聯只快 **1.8 倍**（198 ms → 109 ms），seek 法快 **600 倍**。
延遲關聯仍然要數過 900,020 個索引項。
**真正的解法是改 API（`Slice` 而不是 `Page`）。**

**誤區 24：「游標分頁用 `(a, b) < (?, ?)` 比較簡潔」**

→ 3.8.6 實測：列比較寫法的 `key_len` 只有 **4**（只用到第一欄），
展開的 `OR` 寫法 `key_len` 是 **19**（三欄全用）。
**兩句語意相同，而簡潔的那一句比較慢。是 `key_len` 揭穿它的。**

**誤區 25：「索引只佔磁碟空間，多建幾個沒關係」**

→ 3.3.4 實測：本章的表**索引（91.7 MB）比資料（79.6 MB）大**；
shop-service 的 `orders` 表索引比資料大 43%。
**索引的真正代價是「buffer pool 裡的位置」** —— 那是所有查詢共用的資源
（01 章 1.8.3 那個 10.35 倍就是這樣來的）。

**誤區 26：「不敢刪索引，因為刪錯了要重建很久」**

→ 3.8.4：用 **`ALTER INDEX ... INVISIBLE`**。
索引還在、還在被維護，只是優化器看不到它。
出事了 `VISIBLE` 回來是**毫秒級**，不用重建。

**誤區 27：「`performance_schema` 說這個索引 `COUNT_STAR = 0`，可以刪了」**

→ 3.8.5：那個統計是從**上次 MySQL 啟動**開始累積的。
剛重啟就跑，所有索引都是 0。
**至少觀察一個完整的業務週期（含月結與對帳），實務上建議一個月。**

**誤區 28：「單看耗時就知道索引有沒有用」**

→ 3.10.2：`idx_orders_placed` 只讓 Q5 快 1.7 倍。
但它讓那句查詢**不用回表**（`Using index`）——
於是它不會把整張表的頁拉進 buffer pool 擠掉別人的資料。
**索引的價值有一部分是「它讓這句查詢不去打擾其他查詢」，而那個量不出來。**

---

## 3.12 本章練習

### 練習 1：讀執行計畫

以下是六份 `EXPLAIN` 輸出。**對每一份回答：這句查詢有問題嗎？如果有，最可能是什麼問題？
你會怎麼驗證你的猜測？**

```
(a) type: ref     key: idx_cust        key_len: 4      rows: 3        Extra: Using index

(b) type: index   key: uk_email        key_len: 1022   rows: 4823910  Extra: Using where; Using index

(c) type: range   key: idx_created     key_len: 7      rows: 2400000  Extra: Using index condition

(d) type: ref     key: idx_status      key_len: 66     rows: 1200     Extra: Using where; Using temporary; Using filesort

(e) table: big    type: index   key: uk_code   rows: 8000000   Extra: Using index
    table: small  type: eq_ref  key: PRIMARY   rows: 1          Extra: Using where

(f) type: ALL     key: NULL            key_len: NULL   rows: 47      Extra: Using where
```

**額外**：

**(g)** (b) 的 `key_len: 1022` 告訴你這個欄位是什麼型別？（提示：算術）
**(h)** (e) 有一個很明確的訊號。是什麼？三個最可能的根因是什麼？
**(i)** (f) 看起來很糟（`type: ALL`），但它其實可能完全沒問題。為什麼？
**(j)** (c) 與 (d) 哪一個比較緊急？說明你的判斷依據。

### 練習 2：設計索引

一張「使用者行為事件表」，每天 5000 萬列，保留 30 天（共 15 億列）：

```sql
CREATE TABLE user_event (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT       NOT NULL,
  event_type  VARCHAR(32)  NOT NULL,     -- 約 40 種
  page_url    VARCHAR(500) NOT NULL,
  session_id  CHAR(32)     NOT NULL,
  device      VARCHAR(16)  NOT NULL,     -- 3 種：WEB / IOS / ANDROID
  country     CHAR(2)      NOT NULL,     -- 約 60 個
  occurred_at DATETIME(3)  NOT NULL,
  payload     JSON         NULL
) ENGINE=InnoDB;
```

**已知的查詢**：

```
Q1  某個使用者最近 100 筆事件（客服查詢，每分鐘幾十次）
Q2  某個 session 的完整事件序列（除錯用，每小時幾次）
Q3  某一天、某個 event_type 的事件總數（報表，每天跑一次）
Q4  某一天、每個 country 的不同使用者數（報表，每天跑一次）
Q5  最近一小時、某個 page_url 的事件數（監控，每分鐘一次）
Q6  某個使用者在某段時間內、某個 event_type 的事件（分析，每天幾百次）
```

**回答**：

**(a)** 為每一句寫出它的存取模式（`WHERE` 欄位 + 等值/範圍 + `ORDER BY` + `SELECT` 欄位）。
**(b)** 哪些查詢可以共用同一個索引？合併之後你需要幾個索引？
**(c)** 為每一個索引決定欄位順序，並說明依據（3.5.6 的四條規則）。
**(d)** `page_url` 是 `VARCHAR(500)`。Q5 要用它篩選。你會怎麼建索引？
  （提示：3.8.3 與 00 章 0.5.11，至少有三種方案，比較它們）
**(e)** Q4 的 `COUNT(DISTINCT user_id)` 在 5000 萬列上會怎樣？你會怎麼處理？
**(f)** 這張表 15 億列。你的索引總共會佔多少空間？算給我看。
  （提示：3.2.3 的「一頁裝幾項」的算法）
**(g)** 如果空間算出來不可接受，你會犧牲哪一句查詢？為什麼？
**(h)** Q3 與 Q4 是「每天跑一次的報表」。有沒有比建索引更好的做法？

### 練習 3：找出那個 1,950 倍

你接手一個系統，某個報表頁面「有時候要跑兩分鐘」。你拿到了那句 SQL 與它的 `EXPLAIN`：

```sql
SELECT o.order_no, o.total_amount, c.company_name, r.region_name
FROM orders o
JOIN customer_ext c ON c.tax_id = o.customer_tax_id
JOIN region r       ON r.code = c.region_code COLLATE utf8mb4_general_ci
WHERE o.placed_at >= ? AND o.placed_at < ?;
```

```
table: o   type: range    key: idx_placed   rows: 120000   Extra: Using index condition
table: c   type: eq_ref   key: uk_tax_id    rows: 1        Extra: NULL
table: r   type: ALL      key: NULL         rows: 42       Extra: Using where; Using join buffer (hash join)
```

**(a)** `region` 表只有 42 列，`type: ALL` 是問題嗎？
**(b)** 這句 SQL 裡有一個本章講過的地雷。是哪一個？它現在有沒有造成問題？
**(c)** 那個地雷在什麼情況下會爆？寫出一個具體的情境（含資料量的變化）。
**(d)** 「有時候要跑兩分鐘」——「有時候」這三個字提供了什麼線索？
  列出至少三個「只在特定時候慢」的可能原因，並說明各自怎麼驗證。
**(e)** 寫出你的修正方案，並排出執行順序（哪一個先做、為什麼）。

### 練習 4：把估計修準 ★

用本章的實驗表（或你自己灌的資料）：

**(a)** 重現 3.4.5 的七種狀態估計誤差。你的數字跟課程的一樣嗎？
**(b)** 把 `innodb_stats_persistent_sample_pages` 從 20 調到 200、2000，
  各跑一次 `ANALYZE TABLE` 並記錄誤差。誤差怎麼變？`ANALYZE` 的耗時怎麼變？
**(c)** 對 `status` 建直方圖。`EXPLAIN` 的 `rows` 有變嗎？為什麼？
**(d)** 設計一個實驗，證明直方圖**確實**影響了某個查詢的執行計畫
  （不只是 `filtered` 的數字，而是 `key` 或 JOIN 順序真的變了）。
**(e)** 3.4.5 提到 `status` 的基數被估成 6 而實際是 7。
  設計一個實驗，找出「取樣多少頁才會估到 7」。

### 練習 5：索引的代價 ★

**(a)** 對本章的實驗表，量出「每加一個索引」對以下四件事的影響：
  ① 插入 10 萬列的耗時　② `UPDATE status` 10 萬次的耗時
  ③ 索引總空間　④ 一句典型查詢的耗時

**(b)** 把 buffer pool 縮到 32 MB，重跑 (a)。哪幾個數字的變化最大？為什麼？

**(c)** 3.10.5 說「刻意不建 `(customer_id, placed_at, status, total_amount)` 覆蓋索引，
  因為 `status` 會被 `UPDATE`」。**用實驗驗證這個決定**：
  建那個索引，量出「訂單狀態變更 10 萬次」的耗時差異。
  你的數字支持這個決定嗎？

**(d)** 設計一個「索引預算」的方法：給定 buffer pool 大小與資料量，
  怎麼估算「最多能有幾 MB 的索引」？寫出你的公式與假設。

---

## 3.13 完成本章後，請確認你有

```
✅ 一份索引設計文件（3.10.4 的格式）
     ├─ 每一個索引都對應【至少一句】具體的查詢
     ├─ 每一個索引的欄位順序都有理由（3.5.6 的四條規則）
     ├─ ★ 一份「刻意不建」的清單，含理由（3.10.5）
     └─ 索引總空間的估算

✅ 每一句關鍵查詢的 EXPLAIN 存檔
     ├─ type 不是 ALL（或有理由說明為什麼 ALL 是對的）
     ├─ Extra 沒有 Using filesort / Using temporary（或有理由）
     ├─ 複合索引查詢的 key_len 符合預期（3.4.3 的算術）
     └─ JOIN 查詢的第一行是最小的表（3.7.8）

✅ 一組執行計畫守門測試（3.10.6）
     ├─ 硬斷言：索引存在 + 欄位順序 + type 不是 ALL + 沒有 filesort
     ├─ 軟斷言：具體用了哪個索引（會隨版本變，寫成警告）
     └─ 一條冗餘索引偵測（3.8.5）

✅ 一份「排查 SOP」（3.4.9 的三步）
     ├─ ① EXPLAIN：type / Extra
     ├─ ② EXPLAIN ANALYZE：哪個節點的 actual time × loops 最大
     └─ ③ optimizer_trace：為什麼沒用我以為的索引

✅ 一個定期作業
     ├─ ANALYZE TABLE（大量匯入後）
     ├─ UPDATE HISTOGRAM（3.9.2：它不會自動更新）
     └─ 每月檢查 performance_schema 的 COUNT_STAR = 0 索引

✅ 你能回答這八個問題（不查資料）
     ├─ 100 萬列的表查一列要幾次頁讀取？為什麼？
     ├─ 為什麼二級索引的葉節點存主鍵而不是實體位址？
     ├─ key_len 怎麼算？它能告訴你什麼別的欄位不能？
     ├─ 為什麼 EXPLAIN 的 rows 可以錯 112%？
     ├─ 為什麼「改寫成區間」有時候沒用？
     ├─ 為什麼相關子查詢有時候快 19 倍、有時候慢 135 倍？
     ├─ 為什麼一個 COLLATE 可以讓查詢慢 1,950 倍？
     └─ 為什麼深分頁的 seek 法快 600 倍，而延遲關聯只快 1.8 倍？
```

---

## 3.14 本章的實驗環境與結果

**環境**：

| 項目 | 版本 / 規模 |
|---|---|
| 資料庫 | **MySQL 8.0.46**，buffer pool **128 MB**，`innodb_page_size` 16384 |
| 實驗表 `ord` | **100 萬列**，資料 79.6 MB（`PRIMARY` 5096 頁）<br>**三個基礎索引共 91.7 MB**（`idx_status_placed` 2149 + `uk_order_no` 1957 + `idx_cust_placed` 1764 = 5870 頁）—— 這是 3.3.4 那個「索引比資料大」的數字<br>🔴 **跑完整章之後累積到 8 個二級索引，共 247.6 MB**（`information_schema` 的 `INDEX_LENGTH` 報 275.2 MB，因為它含已配置未使用的區段）—— 資料 79.6 MB 的表，索引 **3.1 倍** |
| 真實 schema | 01 章 1.12 的七張表；`orders` 100 萬列（136.8 MB + 195.7 MB 索引）、`order_item` 200 萬列 |
| 資料分布 | 刻意偏斜：`DELIVERED` 74.97%、`REFUNDED` 0.99%；20% 的訂單來自前 100 個客戶 |
| 平台 | macOS 14.2.1 / Apple Silicon |

⚠️ **「資料分布刻意偏斜」是本章多個實測的關鍵** ——
均勻分布的測試資料會讓優化器的估計看起來很準（3.4.5 的誤差就不會出現），
而真實系統從來不是均勻的。

**跑過的實驗（33 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **H1** | B+Tree 結構 | ✅ `PRIMARY`：5069 葉頁 + 27 非葉頁 → **樹高 3**；主鍵每頁 **196 列**（84 bytes/列）、二級索引每頁 **659 項**；MySQL 8.0.46 的 `INNODB_BUFFER_PAGE` **已無 `PAGE_LEVEL` 欄位** |
| **H2** | 索引 vs 資料大小 | 🔴 `ord`：資料 79.6 MB、**索引 91.7 MB**；`orders`：136.8 MB vs **195.7 MB（+43%）** |
| **H3** | `type` 階梯 | ✅ 實測九種：`const`(rows 1) / `eq_ref` / `ref`(2062) / `range`(100) / `index_merge`(`sort_union`) / `index`(993777) / `ALL`(993777)；**`ref_or_null` 沒觸發**（欄位是 `NOT NULL`，條件被優化掉） |
| **H4** | `key_len` 算術 | ✅ `VARCHAR(16)` utf8mb4 = **66**、`VARCHAR(8)` = **34**、`INT` = 4、`BINARY(16)` = 16、`DATETIME(3)` = **7**；三欄複合索引 66/100/104 精確對應用到 1/2/3 欄 |
| **H5** | 範圍條件擋住右邊 | 🔴 `status > 'PACKED' AND channel = 'WEB'` → **`key_len` 只有 66**；`status IN (2 個) AND channel='WEB'` → **100（兩欄都用）** |
| **H6** | skip scan | ✅ 跳過領頭欄位仍用索引（`Using index for skip scan`，`key_len` 100/104）<br>🔴 但實測**沒有效能好處**（`channel='WEB'` 命中 45%：on 0.112s / off 0.103s）；用 hint 強迫時估計 **248,887 列而實際只有 86 列** |
| **H7** | 回表成本 ★ | 🔴 同樣 2062 列：覆蓋 **0.55 ms** vs 回表 **3.8 ms（6.9 倍）**；40,509 列時 **5.5 ms vs 80～151 ms（15～27 倍）**<br>⚠️ **`Handler_read_*` 計數器兩者完全相同**（都是 2062）—— 看不出回表 |
| **H8** | 覆蓋索引的 `key` 選擇 | ✅ 一旦要回表，優化器改選**較小**的索引（`idx_cust_placed` 1509 頁 vs `idx_cover` 2649 頁） |
| **H9** | 排序消除 | ✅ `ORDER BY placed_at` → 無 filesort；`DESC` → **`Backward index scan`**；**`ORDER BY placed_at, id` 也無 filesort**（主鍵隱含在尾端）；`ORDER BY total_amount` → `Using filesort` |
| **H10** | 降序索引 | ✅ 等值 + 混合方向：優化器**自己就用**（`Using index`，無 filesort）<br>🔴 範圍 + 混合方向：**優化器不選它**（`Using filesort`），用 hint 強迫才生效 |
| **H11** | 失效 ①：函式 | 🔴 `DATE(placed_at)=?` → `ALL`；改半開區間 → **`range`，rows 1051**<br>🔴 **反例：`YEAR(placed_at)=2026` 改成整年區間【仍然是 `ALL`】**（命中 25%，優化器選全表是對的） |
| **H12** | 函式索引 | ✅ `KEY ((CAST(placed_at AS DATE)))` → `ref`，rows 1051；**`DATE(placed_at)` 也用得到這個索引**（MySQL 認得兩者同義） |
| **H13** | 失效 ②：運算 | 🔴 `customer_id + 0 = 42` → `ALL`；✅ `customer_id = 42 + 0` → `ref` rows 2062 |
| **H14** | 失效 ③：隱式轉型 | 🔴 `order_no = 500000` → `type: index`、**rows 994030**（`key` 仍是 `uk_order_no`）；✅ `= '字串'` → `const` rows 1 |
| **H15** | 失效 ④：前置 `%` | ✅ `LIKE 'SO-00005%'` → `range`；🔴 `LIKE '%00005000'` → `ALL`<br>✅ 反轉生成欄位 + 索引：`range`、**rows 1**、`Using index` |
| **H16** | 失效 ⑤：`OR` | 🔴 `customer_id=42 OR remark='x'` → `ALL`<br>🔴 **反例：改 `UNION ALL` 後第二段仍是 `ALL` rows 994030** |
| **H17** | 失效 ⑥：`<>` | 🔴 `status <> 'DELIVERED'`（25%，`SELECT *`）→ `ALL`<br>🔴 **反例：改成 `IN (6 個值)` 仍要讀 497,264 列**<br>✅ **`status <> 'REFUNDED'`（99%！）卻用了索引** —— 因為 `SELECT id` 是覆蓋查詢 |
| **H18** | 失效 ⑦：前綴斷了 | 🔴 只給 `placed_at`（複合索引第二欄）→ `ALL`；加 `KEY (placed_at)` 後 → `range` rows 1051 |
| **H19** | 失效 ⑧：定序 ★★ | 🔴 **`ON a = b COLLATE ...` → 1.03 ms 變 2009 ms（1,950 倍）**；`EXPLAIN` 顯示 **100 萬列的表變成驅動表**<br>✅ `ALTER TABLE ... CONVERT TO` 之後：1000 列的小表當驅動，`eq_ref` |
| **H20** | 估計誤差 ★★ | 🔴 七種狀態：**−33.7% ～ +111.6%**，沒有一個在 30% 以內；`n_diff_pfx01` 把 `status` 的基數估成 **6**（實際 7） |
| **H21** | `filtered` 的寫死猜測 | 🔴 `total_amount > 4000` → **`filtered: 33.33`**（MySQL 對 `>` 的固定猜測），實際 **20.12%** |
| **H22** | 直方圖 ★ | ✅ 建 64 桶後 `filtered` → **20.20%**（誤差 0.4%）；組合條件 `2062 × 20.20% = 416` vs 實際 **432**（誤差 3.7%）<br>🔴 **對有索引的 `status` 建直方圖，`rows` 完全沒變** |
| **H23** | `EXPLAIN ANALYZE` 的 `loops` | ✅ 自連接：`loops=499`、每次 `rows=478` → 實際 **238,745 列**，而估計是 **24,010（差 10 倍）**——資料偏斜造成 |
| **H24** | `optimizer_trace` | ✅ 兩個候選索引的 cost **103,341 vs 5,270.75**；`index_only: true`（覆蓋）是勝出的關鍵 |
| **H25** | 複合 vs 單欄（`AND`）★ | ✅ 複合 `k_sc`：`ref` rows 463、**0.15 ms**；兩單欄：`index_merge` + `Using intersect` rows 1854、**10.2 ms（68 倍）**<br>✅ 而且複合索引**空間更小**（57.2 MB vs 71.7 MB） |
| **H26** | 複合 vs 單欄（`OR`） | ✅ 反過來：兩單欄走 `Using union` rows **116,602**；複合索引掃整個索引 rows **995,044** |
| **H27** | 前綴索引選擇性 | ✅ `order_no` 全長 1,000,000 / 前 8 = **11** / 前 10 = 1001 / 前 12 = 100,001 —— **變化在尾端的欄位不適合前綴索引** |
| **H28** | 不可見索引 | ✅ `ALTER INDEX ... INVISIBLE` 後查詢從 rows **1051 退化到 110,425（105 倍）**，`IS_VISIBLE = NO`，索引仍存在；`VISIBLE` 立即還原 |
| **H29** | 冗餘索引偵測 | ✅ 一句 SQL 抓到 `idx_cust_placed` 是 `idx_cover` 的前綴 |
| **H30** | 深分頁 ★★ | 🔴 `OFFSET 0` **0.24 ms** / `500000` **58.2 ms** / `900000` **106.1 ms**<br>✅ seek 法 `WHERE id > 900000` **0.33 ms（快 319～600 倍）**<br>🟡 延遲關聯 **109 ms（只快 1.8 倍）** |
| **H31** | 游標分頁的兩種寫法 ★ | 🔴 `(placed_at, id) < (?, ?)` → `key_len` **4**（只用一欄）<br>✅ 展開的 `OR` 形式 → `key_len` **19**（三欄全用）+ `Using index condition` |
| **H32** | 索引提示 | ✅ `USE INDEX` / `IGNORE INDEX` 生效；🔴 **`FORCE INDEX` 一個用不上的索引 → `type: ALL`**<br>🔴 **hint 語法錯誤只有 `Warning 1064`、索引名打錯只有 `Warning 3128`，查詢照跑** |
| **H33** | 真實 schema 的九句查詢 | ✅ Q1 `range`/`key_len 23`/`Backward index scan`；Q4 `FirstMatch(o)` 半連接<br>🔴 **Q5 是 `type: ALL`**（缺 `placed_at` 索引）→ 補 `(placed_at, status, total_amount)` 後 `range` + `Using index`（8.89 → 5.25 ms）<br>🔴 **Q3 有 `Using temporary; Using filesort`** → 改相關子查詢後 **4.49 ms → 0.24 ms（19 倍）** |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一章會補 |
|---|---|---|
| **超過 buffer pool 時的索引行為**（本章資料 79.6 MB < 128 MB） | 3.3.4、3.8 | 05 章（會縮小 buffer pool 重跑） |
| **索引對併發寫入的影響**（本章只量單執行緒） | 3.6.3、3.10.5 | **04 章**（鎖） |
| **`Using MRR`（多範圍讀取）的實際效果** | 3.4.4 | 05 章 |
| **hash join vs nested loop 的交叉點** | 3.4.4 | 05 章 |
| **千萬～億列規模的樹高與 I/O**（本章 100 萬列） | 3.2.3 | — |
| **`FULLTEXT` 索引** | 3.7.4 | —（不在本課範圍，建議用搜尋引擎） |
| **線上加索引對正式流量的影響** | 3.8.4 | 06 章 6.7（`gh-ost`） |
| **執行計畫守門測試在 CI 的實際成本** | 3.10.6 | 06 章 |

> 📌 **最後一句話**：
>
> 這一章有**五個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「相關子查詢一定慢」** ——
> 02 章量出 135 倍慢，本章 3.10.3 量出 **19～65 倍快**。
> 兩個都對，因為成本是 **外層列數 × 每次成本**，
> 而 `LIMIT 20` 加上索引順序可以把外層列數變成 20。
> **一句話規則在這裡是錯的，公式才是對的。**
>
> **②「函式包住欄位就改寫成區間」** ——
> H11 顯示 `YEAR(placed_at) = 2026` 改成整年區間之後**仍然是全表掃描**，
> 而那是**優化器的正確決定**（命中 25%）。
> **索引解決「從一百萬列裡找一千列」，它解決不了「找二十五萬列」。**
>
> **③「`<>` 用不到索引」** ——
> H17 顯示命中 **99%** 的 `status <> 'REFUNDED'` 用了索引，
> 而命中 25% 的 `status <> 'DELIVERED'` 沒用。
> **差別在「要不要回表」，不在運算子。**
>
> **④「游標分頁用列比較比較簡潔」** ——
> H31 顯示簡潔的那一句 `key_len` 只有 4，展開的那一句是 19。
> **兩句語意一模一樣，而只有 `key_len` 看得出差別** ——
> `type`、`key`、`rows` 全都在誤導你（`ref` 名義上還「比 `range` 好」）。
>
> **⑤「我加了 hint / 建了索引，所以它生效了」** ——
> H32 顯示 hint 的語法錯誤只是一個**警告**；
> H10 顯示降序索引**優化器可能不選**；
> H33 顯示 01 章那份看起來完整的索引設計，**有兩句查詢根本沒被服務到**。
>
> ⚠️ **這五個有一個共同點**：
>
> > **它們都是「我以為我知道」的錯誤，而不是「我不知道」的錯誤。**
> > 而唯一的解藥是同一個動作：**每一句上線的查詢，都真的跑一次 `EXPLAIN`，
> > 而且要看到 `key_len` 那一欄。**
>
> **下一章開始講鎖。** 04 章會回答一個從 05 站問到現在的問題：
> **「20 個人怎麼搶到 10 個庫存，而 `CHECK (qty >= 0)` 一次都沒觸發？」** ——
> 以及一個本章刻意迴避的問題：**這些索引，在有併發寫入的時候，
> 會鎖住的到底是「那一列」還是「那一段」？**

---

**上一章**：[02-sql-crud-join-and-aggregate.md](./02-sql-crud-join-and-aggregate.md) — SQL 核心：JOIN 與聚合
**下一章**：[04-transaction-isolation-and-lock.md](./04-transaction-isolation-and-lock.md) — 交易、隔離與鎖
