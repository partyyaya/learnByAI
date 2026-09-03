# 第 05 章：效能調校

> 04 章結尾留了三個問題：
>
> > **「這些鎖等待，在慢查詢日誌裡長什麼樣子？」**
> > **「buffer pool 不夠大的時候，索引還有用嗎？」**（03 章也問過同一件事）
> > **「hash join 和 nested loop 的交叉點在哪裡？」**
>
> 這一章要回答它們。而在回答之前，先看一組**你在自己的機器上永遠量不到**的數字。
>
> 同一句 SQL、同一份資料（100 萬列訂單）、同一台機器。
> 唯一的差別是 buffer pool 從 8 MB 調到 256 MB：
>
> ```
> buffer pool = 8 MB     2000 次隨機查詢   1546 ms   實體讀 95,765 次   命中率 82.68%
> buffer pool = 256 MB   2000 次隨機查詢   1310 ms   實體讀      59 次   命中率 99.98%
> ```
>
> 🔴 **實體讀取次數差了 1,623 倍，牆鐘時間只差 1.18 倍。**
>
> **為什麼？** 因為這台機器的「磁碟」是 NVMe SSD + 作業系統的檔案快取。
> 那 95,765 次「實體讀取」，其實大部分只是從記憶體的另一個地方搬過來。
>
> ⚠️ **而正式環境的資料庫，磁碟通常是**：
>
> ```
> 雲端網路磁碟（EBS / Persistent Disk）  →  單次隨機讀 0.5 ～ 2 ms
> 機械硬碟                               →  單次隨機讀 5 ～ 10 ms
>
> 95,765 次 × 0.5 ms  =  48 秒
> 95,765 次 × 5   ms  =  8 分鐘
> ```
>
> **同一段程式碼，在你的筆電上 1.5 秒，在正式環境可能是 8 分鐘。**
>
> ⚠️ **這一章與前四章有一個關鍵差別**：
>
> ```
> 01 章的錯 → 資料是錯的            → 一插進去就看得到
> 02 章的錯 → 答案是錯的            → 對一次資料就看得到
> 03 章的錯 → 答案對，只是慢        → 資料長大才看得到
> 04 章的錯 → 只有兩個人同時做才存在 → 併發測試才看得到
> 05 章的錯 → 【在你的機器上根本不存在】
> ```
>
> 前四章的問題，你至少「有辦法在本機重現」。
> 這一章的問題，本質上是**環境差異** ——
> 資料量、記憶體、磁碟速度、連線數、併發量，每一項都跟正式環境差一到三個數量級。
>
> 📌 **所以這一章的主軸不是「怎麼調參數」，而是**：
>
> > **怎麼在本機的環境裡，量出「正式環境會不會慢」的訊號。**
>
> 而那個訊號**不是時間**。是**掃描的列數、實體讀取的次數、命中率、暫存表落地的次數**——
> 這些數字跟你的硬碟有多快**無關**，跟正式環境**一模一樣**。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說明為什麼「在我機器上測起來很快」是**沒有意義的結論**，並說出四個**與硬體無關**的替代指標。
- 估算一張表的**熱資料集**，判斷它放不放得進 buffer pool，並用實測說明命中率從 **82.68% 掉到 99.98%** 時實體讀取差 **1,623 倍**。
- 用實測說明**覆蓋索引對 buffer pool 壓力免疫**，而回表的查詢不是（邏輯讀 22,562 vs 371,676，**16.5 倍**）。
- 量化**冷啟動**的代價（實測點查詢 **4.5 ～ 5.7 倍**），並說明 buffer pool 預熱該怎麼做。
- 開啟並讀懂**慢查詢日誌**，逐欄解釋 `log_slow_extra` 的 20 個欄位。
- 回答 04 章的問題：**鎖等待在慢查詢日誌裡長什麼樣子**（實測 `Lock_time: 1.920609 / Query_time: 1.926924`）。
- 說出 `log_slow_admin_statements` 與 `log_queries_not_using_indexes` 兩個**預設關閉／預設會害你**的開關。
- 用 `performance_schema.events_statements_summary_by_digest` **不開日誌**就找出最貴的查詢。
- 把批次寫入從 **8,607 筆/秒調到 194,850 筆/秒（22.6 倍）**，並說出 `rewriteBatchedStatements` 的三個副作用。
- 選出正確的**批次大小**（實測拐點在 500）與**交易邊界**（實測 autocommit 逐筆只有 **1,113 筆/秒**）。
- 說出 **nested loop 與 hash join 的交叉點**（實測：左表 1% 時索引 nested loop 快 **91 倍**，75% 時**打平**）。
- 說明 `eq_range_index_dive_limit` 為什麼讓 `IN (200 個值)` 的估計**突然變爛**（實測誤差從 **0.0% 跳到 18.8%**）。
- 說出 `max_allowed_packet` 與佔位符上限的真實行為（實測：驅動會**靜默退回**用戶端預備語句）。
- 讀懂 `Sort_merge_passes` 與 `Created_tmp_disk_tables`，並找出 **TempTable 退回磁碟的觸發條件**（實測 `tmp_table_size` 4 MB → 128 MB，**5.9 倍**）。
- 用實測選出深分頁的正確解法（**seek 法快 335 倍**；而**延遲關聯在二級索引排序時快 37 倍**、在主鍵排序時只快 2.1 倍）。
- 說出 JDBC 三種 fetch 模式的差別（實測堆積用量 **185 MB vs 47 MB**）。
- 正確地**分批 DELETE**（實測比一次刪快 **2.6 倍**），並說明為什麼刪完之後**檔案不會變小**（348 MB → 348 MB → `OPTIMIZE` 後 128 MB）。
- 畫出**連線數 vs 吞吐量**曲線，並指出拐點（實測 8 核心機器：QPS 在 64 連線飽和，延遲從 0.16 ms 漲到 **8.14 ms**）。
- 說明為什麼**缺索引的代價會隨 buffer pool 縮小而放大**（04 章量到 10.8 倍，本章在 30 萬列 + 8 MB 的環境量到 **187 ～ 350 倍**）。
- 說出**熱點寫入的吞吐上限**（實測 ≈ 1,000 TPS）為什麼**與連線數、核心數、buffer pool 全部無關**，以及突破它的四種做法。
- 說明 `JSON` 欄位的真實成本（實測：碰到它，頁面請求從「每頁一次」變成「**每列一次**」，多 58 倍），以及生成欄位 + 索引為什麼**必須連查詢一起改寫**。
- 認出 Java 端的**八個效能反模式**，每一個都有實測倍數（N+1 **15 倍**、`COUNT(*)` 當存在性判斷 **190 倍**、Java 端過濾 **95 倍**）。
- 交出 shop-service 的效能基線與一份可以照著跑的**排查 SOP**。

---

## 5.2 效能的地基：buffer pool 與熱資料集

### 5.2.1 本章的實驗環境

⚠️ **這一章需要一個【可以調 buffer pool】的 MySQL**，
而 buffer pool 只能以 `innodb_buffer_pool_chunk_size × instances` 為單位調整。
預設的 chunk 是 128 MB，所以你**沒辦法**把它調到 8 MB —— 除非啟動時就把 chunk 調小：

```bash
docker run -d --name mysql-bp -e MYSQL_ROOT_PASSWORD=root -p 3330:3306 mysql:8.0 \
  --innodb-buffer-pool-chunk-size=8M \
  --innodb-buffer-pool-instances=1 \
  --innodb-buffer-pool-size=128M \
  --slow-query-log=ON --long-query-time=0.5 --log-slow-extra=ON \
  --slow-query-log-file=/var/lib/mysql/slow.log \
  --log-bin=binlog
```

```sql
-- 之後就可以線上調整（必須是 8M 的倍數）
SET GLOBAL innodb_buffer_pool_size = 32 * 1024 * 1024;
```

**實驗資料**（跟 03 章同一份，方便對照）：

```sql
CREATE TABLE ord (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_no     VARCHAR(32)   NOT NULL,
  customer_id  INT           NOT NULL,
  status       VARCHAR(16)   NOT NULL,
  channel      VARCHAR(8)    NOT NULL,
  total_amount DECIMAL(19,4) NOT NULL,
  placed_at    DATETIME(3)   NOT NULL,
  remark       VARCHAR(200)  NULL,
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_cust_placed (customer_id, placed_at),
  KEY idx_status_placed (status, placed_at),
  KEY idx_placed (placed_at)
) ENGINE=InnoDB CHARSET=utf8mb4;
```

```
100 萬列，狀態刻意偏斜（DELIVERED 74.99% / REFUNDED 1.02%），
20% 的訂單集中在前 100 個客戶

資料 76.6 MB  +  索引 117.3 MB  =  193.9 MB
```

📌 **注意「索引比資料還大」** —— 這是 03 章 3.3.4 量過的事。
**它在這一章有新的意義：你的 buffer pool 要裝的不只是資料，還有索引。**

### 5.2.2 buffer pool 是什麼，以及它為什麼是地基

```
                應用程式
                    │  SELECT ...
                    ▼
        ┌───────────────────────────┐
        │      InnoDB Buffer Pool   │  ← 純記憶體，預設 128 MB
        │  ┌────┬────┬────┬────┐    │
        │  │頁面│頁面│頁面│頁面│... │  ← 每頁 16 KB
        │  └────┴────┴────┴────┘    │
        └───────────┬───────────────┘
                    │ 找不到 → 【實體讀取】
                    ▼
        ┌───────────────────────────┐
        │   磁碟（.ibd 檔案）        │
        └───────────────────────────┘
```

**兩個關鍵計數器**：

```sql
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';
```

| 計數器 | 意思 |
|---|---|
| `Innodb_buffer_pool_read_requests` | **邏輯讀**：InnoDB 一共要了幾個頁面 |
| `Innodb_buffer_pool_reads` | **實體讀**：其中幾個在 buffer pool 裡沒找到，得去磁碟拿 |

```
命中率 = 1 - 實體讀 / 邏輯讀
```

⚠️ **這兩個都是【累計值】，從伺服器啟動算起。**
要量單一查詢，必須**跑之前取一次、跑之後取一次、相減**。
直接看 `SHOW GLOBAL STATUS` 的絕對值毫無意義 ——
一台跑了三個月的伺服器，命中率永遠是 99.9%。

### 5.2.3 實測：buffer pool 從 8 MB 到 256 MB ★★

**實驗**：2000 次隨機點查詢（`customer_id` 隨機取 1～20000），
分成「覆蓋索引」與「要回表」兩種。

```sql
-- 覆蓋索引：idx_cust_placed(customer_id, placed_at) 就夠了，不用回表
SELECT COUNT(*) FROM ord WHERE customer_id = ?;

-- 要回表：total_amount 不在索引裡
SELECT SUM(total_amount) FROM ord WHERE customer_id = ?;
```

```
buffer pool       覆蓋索引                                要回表
             QPS    邏輯讀   實體讀   命中率        QPS     邏輯讀    實體讀   命中率
   8 MB     4917    23836     1608   93.25%      1294     553054    95765   82.68%
  16 MB     5234    23531     1349   94.27%      1952     489367    84087   82.82%
  32 MB     5252    23116      898   96.12%      1951     498519    79260   84.10%
  64 MB     5358    22759      519   97.72%      1994     515794    52739   89.78%
 128 MB     5333    22562      377   98.33%      1623     371676      450   99.88%
 256 MB     5339    22253       42   99.81%      1527     390003       59   99.98%
```

📌 **這張表要看三件事**：

**① 覆蓋索引對 buffer pool 壓力幾乎免疫。**

```
8 MB  →  4917 QPS
256 MB → 5339 QPS      只差 8.6%
```

因為 `idx_cust_placed` 只有幾十 MB，而且**每次查詢只碰 11 個頁面**（23836 / 2000）。

**② 回表的查詢不是。**

```
邏輯讀：覆蓋索引 22,562  vs  回表 371,676      →  16.5 倍
實體讀：8 MB 時 95,765   vs  256 MB 時 59      →  1,623 倍
命中率：82.68%           →  99.98%
```

**③ 🔴 而牆鐘時間只差 1.18 倍（1546 ms → 1310 ms）。**

⚠️ **第 ③ 點就是本章開場那個警告**：

> **在 NVMe SSD + 作業系統檔案快取上，「實體讀取」的成本被隱藏了。**
> 你量到的時間**不能外推**到正式環境。
> **邏輯讀、實體讀、命中率這三個數字才能。**

📌 **所以本章之後的每一個實測，我都會同時給你「時間」和「與硬體無關的計數」。**
**看到兩者不成比例的時候，相信計數。**

### 5.2.4 冷啟動：重啟之後的第一分鐘

buffer pool 是記憶體，重啟就空了。實測（每次都重啟容器再跑）：

```
查詢                        冷（第 1 次）   熱（第 2 次）   熱（第 3 次）   倍數
點查詢（覆蓋索引）              2.1 ms        0.5 ms        0.5 ms      4.5x
點查詢（要回表）               13.3 ms        3.7 ms        2.4 ms      5.7x
範圍掃描 10 萬列               14.4 ms       12.3 ms       11.1 ms      1.3x
全表掃描                     105.4 ms       92.4 ms       93.1 ms      1.1x
```

📌 **兩個觀察**：

```
① 點查詢的冷熱差距最大（4.5 ～ 5.7 倍）
     因為它只讀幾個頁面，「找不找得到」是全有全無的

② 全表掃描的冷熱差距最小（1.1 倍）
     因為它本來就要把整張表讀一遍，buffer pool 幫不上忙
     🔴 而且它會【把別人的熱資料擠出去】—— 5.2.6 會回來處理
```

⚠️ **實務上的意義**：**重啟資料庫之後不要馬上把流量切回去。**

```sql
-- MySQL 8 預設會在關機時把 buffer pool 的「頁面清單」存檔，開機時重新載入
SELECT @@innodb_buffer_pool_dump_at_shutdown,     -- 預設 ON
       @@innodb_buffer_pool_load_at_startup,      -- 預設 ON
       @@innodb_buffer_pool_dump_pct;             -- 預設 25（只存最熱的 25%）

-- 手動預熱
SET GLOBAL innodb_buffer_pool_dump_now = ON;      -- 立刻存檔
SET GLOBAL innodb_buffer_pool_load_now = ON;      -- 立刻載入

-- 看載入進度
SHOW STATUS LIKE 'Innodb_buffer_pool_load_status';
```

⚠️ **`innodb_buffer_pool_dump_pct = 25` 意味著只有最熱的 1/4 會被還原。**
資料庫「起來了」不等於「暖了」。監控上要看的是**命中率回到穩態**，不是行程有沒有在跑。

### 5.2.5 怎麼估「熱資料集」

01 章 1.8.3 留了這句話：

> **「在我的機器上測起來沒差」這句話，在資料庫的世界裡幾乎沒有意義。**
> **因為你的測試資料量通常小於 buffer pool，而正式環境的資料量通常大於 buffer pool。**

現在把它變成一個可以事先算的規則。

**步驟 ①：算出每張表的總大小（資料 + 索引）**

```sql
SELECT TABLE_NAME,
       TABLE_ROWS,
       ROUND(DATA_LENGTH  / 1024 / 1024, 1) AS data_mb,
       ROUND(INDEX_LENGTH / 1024 / 1024, 1) AS index_mb,
       ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 1) AS total_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY DATA_LENGTH + INDEX_LENGTH DESC;
```

⚠️ **`TABLE_ROWS` 是估計值**（03 章 3.2.1 實測誤差 0.4%），
而且 `information_schema` 的統計預設**快取一天**：

```sql
SET SESSION information_schema_stats_expiry = 0;   -- 這一節都要先下這句
```

**步驟 ②：算出「熱」的那一部分**

```
熱資料集 ≈ Σ (每張表會被線上查詢碰到的部分)
```

**怎麼判斷「會被碰到的部分」**：

| 表的型態 | 熱的部分 | 估法 |
|---|---|---|
| 設定 / 字典表（`product`、`city`） | **全部** | 總大小 |
| 有時間軸的表（`orders`、`order_item`） | **最近 N 天** | 總大小 × (N 天 / 資料總天數) |
| 只靠主鍵查的表（`user` by id） | **被查到的那些列** | 活躍使用者數 × 單列大小 × 1.5（頁面填充率） |
| 只有批次會掃的表（`audit_log`） | **0** | 但要記得它會**污染** buffer pool（5.2.6） |

**步驟 ③：對照**

```
熱資料集  <  buffer pool × 0.8   →  ✅ 命中率會穩在 99%+
熱資料集  ≈  buffer pool         →  🟡 邊緣，任何一次大掃描都會把它打掉
熱資料集  >  buffer pool × 2     →  🔴 命中率會掉到 80~90%，
                                     而【那個掉下來的部分，全部是磁碟隨機讀】
```

**用本章的實驗資料算一次**：

```
ord 表：資料 76.6 MB + 索引 117.3 MB = 193.9 MB

情境 A：只用 idx_cust_placed 做覆蓋查詢
        熱資料集 ≈ 那一個索引 ≈ 30 MB          →  8 MB 的 pool 就有 93% 命中
情境 B：要回表拿 total_amount
        熱資料集 ≈ 索引 30 MB + 整張表 76.6 MB  →  需要 ≥ 128 MB
                                                  實測 128 MB 時命中率 99.88% ✅
                                                       64 MB 時掉到 89.78% 🔴
```

📌 **這就是 03 章「覆蓋索引快 6.9 倍」的第二層意義**：

> **覆蓋索引不只省一次回表的 I/O，
> 它還讓這個查詢的【熱資料集】小一個數量級 ——
> 於是它在 buffer pool 不夠的環境裡，退化得比別人慢得多。**

### 5.2.6 buffer pool 汙染：一個報表打掉整個線上服務

```
線上流量：熱資料集 100 MB，穩穩地待在 128 MB 的 buffer pool 裡，命中率 99.9%
                    ↓
有人跑了一句 SELECT ... FROM order_item（200 MB 的表）做月報
                    ↓
200 MB 的冷資料被讀進 buffer pool
                    ↓
🔴 原本的 100 MB 熱資料【全部被擠出去】
                    ↓
線上查詢的命中率掉到 60%，全站延遲上升 10 倍
                    ↓
報表跑完了，但要幾分鐘～幾十分鐘才會重新暖回來
```

📌 **InnoDB 對這件事有一個內建的防護：LRU 的「中點插入」策略。**

```
        ┌──────────── young（前 5/8）────────────┬──── old（後 3/8）────┐
        │  熱資料，最近被存取過                    │  新讀進來的頁面      │
        └────────────────────────────────────────┴──────────────────────┘
                                                  ▲
                          新頁面【插在這裡】，不是插在最前面
```

```sql
SELECT @@innodb_old_blocks_pct,   -- 預設 37（old 區佔 37%）
       @@innodb_old_blocks_time;  -- 預設 1000 毫秒
```

**規則**：新讀進來的頁面先放在 old 區。
只有在**它進來超過 `innodb_old_blocks_time` 毫秒之後又被存取**，才會升到 young 區。

```
全表掃描：每一頁讀進來 → 立刻用掉 → 再也不碰
          → 不會滿足「1 秒後再被存取」→ ✅ 留在 old 區，很快被淘汰
線上查詢：同一頁反覆被碰
          → ✅ 升到 young 區，受保護
```

⚠️ **但這個保護不是萬能的**：

```
🔴 報表如果反覆掃同一張大表（例如 JOIN 的內層），頁面會被重複存取 → 照樣升上去
🔴 old 區也是 buffer pool 的一部分（37%）→ 大掃描仍然吃掉了 1/3 的空間
```

✅ **正確的解法是「不要在同一個實例上跑」**：

```
線上 OLTP  ──┐
             ├─→ 主庫（buffer pool 只服務熱資料）
批次 / 報表 ─┴─→ 🔴 不要
                 ✅ 走【專用的唯讀副本】（07 章）
```

**怎麼監控汙染**：

```sql
-- 命中率（要自己相減，見 5.2.2）
SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status
WHERE VARIABLE_NAME IN ('Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads');

-- young/old 區的搬移速率：這兩個數字暴增就是有人在掃大表
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_pages_made_young';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_pages_made_not_young';

-- 每張表各佔了 buffer pool 多少頁（找出誰在污染）
SELECT TABLE_NAME, INDEX_NAME, COUNT(*) AS pages,
       ROUND(COUNT(*) * 16 / 1024, 1) AS mb
FROM information_schema.INNODB_BUFFER_PAGE
WHERE TABLE_NAME IS NOT NULL
GROUP BY TABLE_NAME, INDEX_NAME
ORDER BY pages DESC
LIMIT 20;
```

⚠️ **最後那一句在大 buffer pool 上很貴**（它要掃描整個 buffer pool 的中繼資料，
期間會拿住內部的 mutex）。**不要放進監控排程，只在排查時手動跑一次。**

### 5.2.7 buffer pool 該設多大

```
單機專用的資料庫伺服器  →  實體記憶體的 50 ～ 70%
                          （其餘留給：連線的執行緒緩衝、暫存表、作業系統）

和應用程式共用的機器    →  🔴 別這樣。真的要的話，最多 25%

容器 / 雲端託管         →  先看有沒有記憶體上限（cgroup limit）
                          🔴 buffer pool 超過容器上限 → OOM Killer 直接砍掉行程
```

📌 **一個常被忽略的部分：連線也要記憶體。**

```
每條連線的私有緩衝 ≈ sort_buffer_size + join_buffer_size + read_buffer_size + ...
                    （預設約 256 KB × 好幾個，最壞情況每條連線 1 ～ 4 MB）

500 條連線 × 2 MB = 1 GB   ← 這 1 GB 不在 buffer pool 裡，但也要從實體記憶體出
```

⚠️ **這就是「把 `sort_buffer_size` 調到 256 MB」為什麼是災難**（5.7.1 會實測它的實際收益）：
它是**每條連線、每次排序**各配一份的。


### 5.2.8 buffer pool 不足時，缺索引的代價會被放大 ★（回答 04 章）

04 章 4.5.6 量過「沒有索引的 `UPDATE` 會鎖全表」，
在 20,000 列的表上，併發吞吐量差 **10.8 倍**。
04 章 4.12 留了一筆帳：**buffer pool 不足時，這個差距會變成多少？**

**實驗**：`seat` 表 **300,000 列（60 MB）**，8 個執行緒各做 40 次單列更新
（各自更新不同的列，理論上互不衝突）。
`seat_no` 有唯一索引，`code` 內容完全相同但**沒有索引**。

```
buffer pool     有索引（WHERE seat_no=?）     無索引（WHERE code=?）     倍數
    8 MB          214 ms   1,498 TPS         39,917 ms      8 TPS      187x
   32 MB           92 ms   3,496 TPS         33,523 ms     10 TPS      350x
  128 MB           89 ms   3,614 TPS         25,933 ms     12 TPS      301x
```

🔴 **差距從 04 章的 10.8 倍變成 187 ～ 350 倍。**

📌 **兩個放大因素疊在一起**：

```
① 表變大（20,000 → 300,000 列）
     鎖全表 = 鎖 300,000 列，而不是 20,000 列
     → 序列化的程度是 15 倍

② buffer pool 變小（8 MB 對 60 MB 的表）
     每一次全表掃描都有大量頁面要從磁碟讀
     → 而且是【持有鎖的時候】在等 I/O
     → 8 MB 時 8 TPS，128 MB 時 12 TPS
```

⚠️ **注意「有索引」那一欄在 8 MB 時也掉了（3,614 → 1,498 TPS）**，
但它掉的是 2.4 倍，**無索引那一欄掉的是整個數量級**。

> **索引不只是「查得快」，它是「在記憶體不夠的時候還活得下去」的那個條件。**
> 04 章說「鎖的數量 = 掃描的列數」；
> 這一章補上：**「而掃描的成本，取決於它們在不在記憶體裡」。**

📌 **這也解釋了一個常見的線上現象**：

```
平常好好的 →  某天資料長到超過 buffer pool  →  某一句沒索引的 UPDATE
          →  🔴 不是「慢一點」，是【突然掉一個數量級】
          →  連線池瞬間耗盡 → 全站 503
```

**這種故障的曲線不是斜坡，是懸崖。**

---
## 5.3 慢查詢：怎麼抓、怎麼讀

### 5.3.1 開啟慢查詢日誌

```sql
-- 這些都可以線上改，不用重啟
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.5;            -- 🔴 預設 10 秒 = 等於沒開
SET GLOBAL log_slow_extra = ON;              -- 🔥 MySQL 8.0.14+，多 15 個欄位
SET GLOBAL log_slow_admin_statements = ON;   -- 🔴 預設 OFF，ALTER / OPTIMIZE 不會被記
SET GLOBAL slow_query_log_file = '/var/lib/mysql/slow.log';
SET GLOBAL min_examined_row_limit = 0;       -- 掃描列數少於這個就不記
```

⚠️ **`long_query_time` 的預設值是 10 秒。**
一個 Web 請求跑 10 秒，使用者早就走了、瀏覽器也逾時了。
**預設值等於「這個功能是關的」。**

📌 **怎麼選 `long_query_time`**：

```
第一次接手一個系統  →  1 秒（先看看有多糟）
穩定之後            →  0.3 ～ 0.5 秒
已經很乾淨的系統    →  0.1 秒（但要注意日誌量）
🔴 永遠不要設成 0    →  每一句都記，日誌會爆，而且 I/O 本身變成瓶頸
```

⚠️ **`SET GLOBAL` 不影響【已經連上】的 session。**
連線池裡的連線是重複使用的 —— 改完之後可能要等連線輪替，或是直接改設定檔重啟。
**要永久生效一定要寫進 `my.cnf`。**

### 5.3.2 一筆慢查詢長什麼樣子

```
# Time: 2026-09-03T02:53:07.119113Z
# User@Host: root[root] @ localhost []  Id:    10
# Query_time: 1.502241  Lock_time: 0.000001  Rows_sent: 7  Rows_examined: 1000007
  Thread_id: 10  Errno: 0  Killed: 0  Bytes_received: 90  Bytes_sent: 399
  Read_first: 1  Read_last: 0  Read_key: 1  Read_next: 1000000  Read_prev: 0
  Read_rnd: 0  Read_rnd_next: 0
  Sort_merge_passes: 0  Sort_range_count: 0  Sort_rows: 7  Sort_scan_count: 1
  Created_tmp_disk_tables: 0  Created_tmp_tables: 0
  Start: 2026-09-03T02:53:05.616872Z  End: 2026-09-03T02:53:07.119113Z
SET timestamp=1788403985;
SELECT status, COUNT(*), SUM(total_amount) FROM ord GROUP BY status ORDER BY 2 DESC;
```

**逐欄解讀**（★ 是最重要的四個）：

| 欄位 | 意思 | 怎麼用 |
|---|---|---|
| `Query_time` | 總耗時（秒） | 排序用 |
| ★ `Lock_time` | **等鎖**的時間 | 佔 `Query_time` 大半 → **不是查詢慢，是被擋住**（5.3.3） |
| `Rows_sent` | 回傳幾列 | |
| ★ `Rows_examined` | **掃描**幾列 | 🔥 `Rows_examined / Rows_sent` 就是**放大倍率** |
| `Errno` / `Killed` | 錯誤碼 / 是否被 kill | 非 0 → 這句根本沒跑完 |
| `Bytes_sent` | 回傳的位元組 | 很大 → 網路傳輸也是成本（5.8.3） |
| `Read_first` / `Read_key` | 索引第一筆 / 索引查找 次數 | |
| ★ `Read_next` | **沿著索引往下讀**幾次 | 很大 → 索引範圍掃得太寬 |
| `Read_prev` | 往回讀（`ORDER BY DESC`） | 對應 03 章的 `Backward index scan` |
| ★ `Read_rnd_next` | **在資料檔裡順序讀下一列**幾次 | 🔥 **這個很大 = 全表掃描** |
| `Read_rnd` | 依位置隨機讀（排序後回表） | |
| `Sort_merge_passes` | 排序的**歸併輪數** | > 0 → `sort_buffer_size` 不夠（5.7.1） |
| `Sort_rows` | 實際排序幾列 | 對照 `Rows_sent` 看有沒有用優先佇列（5.7.2） |
| `Created_tmp_tables` | 建了幾個暫存表 | |
| ★ `Created_tmp_disk_tables` | 其中幾個**落到磁碟** | 🔥 > 0 就要處理（5.7.3） |

📌 **看慢查詢日誌的順序**（不是從上往下讀，是按這四個欄位挑）：

```
①  Rows_examined / Rows_sent  很大   →  索引問題        →  回 03 章
②  Lock_time / Query_time     很大   →  併發問題        →  回 04 章
③  Created_tmp_disk_tables    > 0    →  暫存表落地      →  5.7
④  Read_rnd_next              很大   →  全表掃描        →  03 章 3.7
```

**用上面那筆實際的日誌套一次**：

```
Rows_examined 1000007 / Rows_sent 7  =  放大 142,858 倍   → ① 命中
Read_next 1000000                                        → ④ 也命中：掃了整個索引
Lock_time 0.000001                                       → ② 沒事
Created_tmp_disk_tables 0                                → ③ 沒事

診斷：GROUP BY status 掃了整個 idx_status_placed 索引。
      100 萬列裡只有 7 個 status → 這是「用索引掃描代替暫存表」的分組，
      對這句話來說是【正確】的計畫，慢是因為資料量本來就大。
修法：如果這是報表，改成預先彙總（物化）；如果是即時的，就別做全表的 GROUP BY。
```

### 5.3.3 鎖等待在慢查詢日誌裡長什麼樣子 ★（回答 04 章）

**實驗**：session A 鎖住一列不放 3 秒，session B 去改同一列。

```sql
-- A
BEGIN; UPDATE lockt SET v = v + 1 WHERE id = 1; SELECT SLEEP(3); COMMIT;
-- B（1 秒後）
UPDATE lockt SET v = v + 1 WHERE id = 1;
```

**B 在慢查詢日誌裡**：

```
# Query_time: 1.926924  Lock_time: 1.920609  Rows_sent: 0  Rows_examined: 1
  Read_key: 1  Read_next: 0  Read_rnd_next: 0  Sort_rows: 0
  Created_tmp_disk_tables: 0  Created_tmp_tables: 0
UPDATE lockt SET v=v+1 WHERE id=1;
```

📌 **特徵非常好認**：

```
Lock_time / Query_time  =  1.920609 / 1.926924  =  99.7%
Rows_examined           =  1                     ← 🔴 只碰一列
```

> **「掃描 1 列卻跑了 1.9 秒」——
> 這句 SQL 沒有任何效能問題，它只是在排隊。**

⚠️ **這裡有一個版本差異，很多舊文章寫錯**：

```
MySQL 5.7 / 8.0.28 以前 →  Lock_time 只算【表級鎖 / MDL】的等待，
                            InnoDB 行鎖的等待【不算在裡面】
MySQL 8.0.28 以後       →  ✅ Lock_time 包含行鎖等待（本章 8.0.46 實測 1.920609）
```

📌 **如果你的 MySQL 比較舊，行鎖等待會被藏在 `Query_time` 裡而 `Lock_time` 是 0** ——
那時候的判斷特徵是「`Rows_examined` 很小但 `Query_time` 很大」。
**這個特徵在新舊版本都成立，比 `Lock_time` 可靠。**

**接到這種慢查詢之後怎麼往下查**（04 章 4.6.6）：

```sql
-- 誰擋住了誰（要在事發當下跑）
SELECT r.trx_mysql_thread_id AS waiting_conn, LEFT(r.trx_query, 60) AS waiting_query,
       b.trx_mysql_thread_id AS blocking_conn, LEFT(b.trx_query, 60) AS blocking_query,
       TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS wait_sec
FROM performance_schema.data_lock_waits w
JOIN information_schema.innodb_trx r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
JOIN information_schema.innodb_trx b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID;
```

⚠️ **「事發當下」是關鍵。** 鎖等待是瞬間的，事後查什麼都看不到。
**要嘛開一個每秒抓一次 `data_lock_waits` 的取樣任務，要嘛用 `innodb_print_all_deadlocks`（04 章）。**

### 5.3.4 `log_slow_admin_statements`：DDL 不會被記錄 🔴

延續 04 章 4.5.4 那個「一個 `ALTER` 把整站打掛」的場景。
**同一個 `ALTER` 等了 1.9 秒的 MDL，在預設設定下慢查詢日誌裡【一個字都沒有】**：

```
（log_slow_admin_statements = OFF，預設值）
# 慢查詢日誌裡只有：
SELECT SLEEP(3);            ← 那個忘了 commit 的無辜查詢
                            🔴 ALTER TABLE 完全沒出現
```

```sql
SET GLOBAL log_slow_admin_statements = ON;
```

```
# Query_time: 1.926 ...
ALTER TABLE lockt ADD COLUMN tmp INT NULL;     ✅ 出現了
```

📌 **會被這個開關擋掉的語句**：
`ALTER TABLE` / `CREATE INDEX` / `DROP INDEX` / `ANALYZE TABLE` / `OPTIMIZE TABLE` /
`CHECK TABLE` / `REPAIR TABLE`。

⚠️ **這些正好是「跑很久而且會擋住別人」的那一類。建議一律打開。**

### 5.3.5 `log_queries_not_using_indexes`：一個會害你的開關 ⚠️

```sql
SET GLOBAL log_queries_not_using_indexes = ON;
```

聽起來很棒：「把所有沒走索引的查詢都記下來」。**實務上它幾乎總是壞主意。**

```
🔴 它【不看 long_query_time】—— 0.001 秒的查詢也記
🔴 小表的全表掃描是【正確】的計畫（03 章 3.7.1 的反例），但它照記不誤
🔴 高流量系統開這個，日誌一分鐘漲幾 GB，磁碟寫爆
```

**實測**（開啟後跑五句話）：

```
SELECT * FROM customer   WHERE id = 1;    ← 走主鍵     未記錄 ✅
SELECT * FROM cust_noidx WHERE id = 1;    ← 全表掃描   🔴 被記錄（Rows_examined: 20000）
SELECT 1;                                             未記錄
SELECT COUNT(*) FROM lockt;               ← 2 列的表   未記錄
SELECT NOW();                                         未記錄
```

✅ **如果一定要開，配一個防爆閥**：

```sql
SET GLOBAL min_examined_row_limit = 1000;   -- 掃描不到 1000 列的就別記了
SET GLOBAL log_throttle_queries_not_using_indexes = 10;  -- 每分鐘最多記 10 筆（預設 0 = 不限制）
```

📌 **更好的替代方案是下一節的 digest 表** —— 它不寫日誌、不吃磁碟、而且可以直接排序。

### 5.3.6 不開日誌也能找出最貴的查詢：digest 表 ★★

`performance_schema` 預設就在收集**每一種查詢形狀**的統計，你只要去查它：

```sql
SELECT LEFT(DIGEST_TEXT, 60)                        AS query_shape,
       COUNT_STAR                                   AS calls,
       ROUND(SUM_TIMER_WAIT / 1e12, 2)              AS total_sec,
       ROUND(AVG_TIMER_WAIT / 1e9,  2)              AS avg_ms,
       ROUND(MAX_TIMER_WAIT / 1e9,  2)              AS max_ms,
       SUM_ROWS_EXAMINED                            AS examined,
       SUM_ROWS_SENT                                AS sent,
       SUM_NO_INDEX_USED                            AS no_index,
       SUM_CREATED_TMP_DISK_TABLES                  AS tmp_disk,
       SUM_SORT_MERGE_PASSES                        AS merge_passes
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = DATABASE()
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;
```

**實際輸出**：

```
query_shape                                      calls  total_s  avg_ms   examined    sent  no_index tmp_disk
SELECT `SLEEP` (?)                                   3     9.00 3001.33          3       3         0        0
ALTER TABLE `lockt` ADD COLUMN `tmp` INTEGER NULL    2     3.85 1926.83          0       0         0        0
UPDATE `lockt` SET `v` = `v` + ? WHERE `id` = ?      2     1.93  963.59          2       0         0        0
SELECT STATUS , COUNT ( * ) , SUM ( `total_amount`   1     1.50 1502.28    1000007       7         0        0
SELECT COUNT ( * ) FROM `ord` WHERE `remark` IS NO   4     0.38   93.96    4000000       4         4        0
SELECT * FROM `ord` ORDER BY `total_amount` DESC L   1     0.25  254.68    1000020      20         1        0
```

📌 **三個 digest 表獨有的優勢**：

```
① 它把「同一種形狀」的查詢合併（常數變成 ?）
     → 一句跑 1 萬次、每次 5 ms 的查詢（總共 50 秒）
       在慢查詢日誌裡【一筆都不會出現】，在這裡排第一
       🔥 這才是真正的效能殺手：不是最慢的那一句，是最貴的那一種

② SUM_NO_INDEX_USED / SUM_CREATED_TMP_DISK_TABLES 直接告訴你「有沒有問題」
     不用去讀 EXPLAIN

③ 不寫磁碟、不用開日誌、對效能的影響可以忽略
```

⚠️ **兩個要注意的地方**：

```
🔴 它是【累計值】，從上次 TRUNCATE 或重啟算起
     排查前先 TRUNCATE performance_schema.events_statements_summary_by_digest;
     跑一段流量，再看

🔴 digest 表有大小上限（performance_schema_digests_size，本機實測 10000）
     超過之後，新的形狀會被歸到一筆 DIGEST 為 NULL 的列
     → 如果你看到一筆 DIGEST_TEXT 是 NULL 而且 COUNT_STAR 很大，代表滿了
```

**排序的三種角度，會得到三種不同的答案**：

```sql
ORDER BY SUM_TIMER_WAIT DESC     -- 總耗時：最該優化的（時間都花在這）
ORDER BY AVG_TIMER_WAIT DESC     -- 平均耗時：最慢的單一查詢
ORDER BY SUM_ROWS_EXAMINED DESC  -- 總掃描量：最吃 I/O 與 buffer pool 的
```

📌 **正式環境優先看第一個。**
「一句 3 秒的月報」和「一句 3 毫秒但跑了 100 萬次的查詢」，後者的總成本是前者的 100 倍。

**還有兩張很有用的姊妹表**：

```sql
-- 每張表被讀寫了多少（找出熱點表）
SELECT OBJECT_SCHEMA, OBJECT_NAME, COUNT_READ, COUNT_WRITE,
       ROUND(SUM_TIMER_READ/1e12, 2) AS read_sec,
       ROUND(SUM_TIMER_WRITE/1e12, 2) AS write_sec
FROM performance_schema.table_io_waits_summary_by_table
WHERE OBJECT_SCHEMA = DATABASE()
ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;

-- 每個索引被用了幾次（03 章 3.8.5 找冗餘索引用過）
SELECT OBJECT_NAME, INDEX_NAME, COUNT_STAR
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE OBJECT_SCHEMA = DATABASE() AND INDEX_NAME IS NOT NULL
ORDER BY COUNT_STAR DESC;
```

### 5.3.7 `pt-query-digest`：把日誌變成報告

慢查詢日誌檔案人工讀很痛苦。Percona Toolkit 的 `pt-query-digest` 幫你彙總：

```bash
pt-query-digest /var/lib/mysql/slow.log > report.txt
```

輸出的重點是這張排行榜：

```
# Rank Query ID          Response time   Calls  R/Call  Item
# ==== ================= =============== ====== ======= ==============================
#    1 0x7C2E3F...        45.2831 62.1%     312  0.1451 SELECT ord
#    2 0x9A1B4D...        18.9012 25.9%      12  1.5751 SELECT ord customer
#    3 0x3F8E2A...         4.1120  5.6%    8842  0.0005 SELECT product
```

📌 **`Response time` 那一欄的百分比，就是「優化這一句能省下多少」。**
上面這份報告裡，優化第 1 名可以省掉 62% 的資料庫時間；優化第 3 名（雖然被呼叫 8842 次）只能省 5.6%。

**MySQL 內建的簡易版**（不用裝東西）：

```bash
mysqldumpslow -s t -t 10 /var/lib/mysql/slow.log     # 依總時間排序，取前 10
mysqldumpslow -s c -t 10 /var/lib/mysql/slow.log     # 依呼叫次數排序
```

⚠️ **`mysqldumpslow` 的彙總比 `pt-query-digest` 粗糙很多**
（它只做簡單的字串替換，不理解 SQL 語法）。
**能裝 Percona Toolkit 就裝；不能的話，用 5.3.6 的 digest 表。**

---
## 5.4 批次寫入

00 章 0.7.4 量過 `rewriteBatchedStatements`，並留了這句話：

> **05 章 5.4 會用同一組實驗，加上「批次大小怎麼選」與「和交易邊界的關係」。**

這一節把它補完。

### 5.4.1 五種寫法，22.6 倍

**實驗**：往一張 `(id INT PRIMARY KEY, pad CHAR(200))` 的表寫入，**全部包在一個交易裡**。

```
① 逐筆 Statement（字串拼接）                   20,000 筆   2469 ms     8,100 筆/秒
② 逐筆 PreparedStatement                      20,000 筆   2372 ms     8,432 筆/秒
③ addBatch（未開 rewriteBatchedStatements）  100,000 筆  11619 ms     8,607 筆/秒
④ addBatch + rewriteBatchedStatements=true   100,000 筆    662 ms   151,025 筆/秒  ← 17.5x
⑤ 手寫多值 INSERT（1000 列一句）              100,000 筆    513 ms   194,850 筆/秒  ← 22.6x
```

📌 **① ② ③ 幾乎一樣快 —— 這是最重要的一個發現。**

```
「我用了 PreparedStatement」        →  對 INSERT 的吞吐量【沒有幫助】
「我用了 addBatch / executeBatch」  →  🔴 沒開 rewriteBatchedStatements 的話，
                                        驅動只是【幫你在迴圈裡一句一句送】
```

**為什麼？** 因為瓶頸是**網路往返**（round trip），不是 SQL 解析：

```
③ 沒有改寫：
   Java ──INSERT──► MySQL ──OK──► Java ──INSERT──► MySQL ──OK──► ...
        10 萬次往返，每次約 0.1 ms  =  10 秒

④ 有改寫：驅動把 1000 句合併成一句
   INSERT INTO t VALUES (...),(...),(...), ... 1000 組 ...
        100 次往返  =  0.1 秒
```

```java
// ✅ 一定要加這個參數，它不是預設值
jdbc:mysql://host:3306/db?rewriteBatchedStatements=true
```

```properties
# Spring Boot
spring.datasource.url=jdbc:mysql://localhost:3306/shop?rewriteBatchedStatements=true
```

⚠️ **`rewriteBatchedStatements=true` 的三個副作用**（00 章 0.7.4 列過，這裡補上後果）：

```
① executeBatch() 的回傳值變成 Statement.SUCCESS_NO_INFO（-2）
     🔴 如果你在檢查「每一列各影響幾列」，程式碼會壞掉
     ✅ 改成檢查「有沒有丟例外」

② 只對 INSERT 有效（8.x 起也支援部分 REPLACE）
     🔴 UPDATE / DELETE 不會被改寫 → 大量 UPDATE 要自己想辦法（5.4.5）

③ 改寫後的單句 SQL 受 max_allowed_packet 限制（5.6.3）
     驅動會自動分段，但如果單列很大（含 TEXT / BLOB）要注意
```

### 5.4.2 批次大小怎麼選

**實驗**：10 萬筆，`rewriteBatchedStatements=true`，一個交易，只改 `batchSize`。

```
batchSize =      1   22591 ms     4,427 筆/秒
batchSize =     10    2819 ms    35,468 筆/秒
batchSize =     50    1208 ms    82,787 筆/秒
batchSize =    100    1027 ms    97,334 筆/秒
batchSize =    500     672 ms   148,762 筆/秒   ← 🔥 拐點
batchSize =   1000     711 ms   140,559 筆/秒
batchSize =   5000     637 ms   156,971 筆/秒
batchSize =  10000     656 ms   152,424 筆/秒
batchSize =  50000     687 ms   145,531 筆/秒
batchSize = 100000     711 ms   140,599 筆/秒
```

📌 **曲線的形狀比數字重要**：

```
1 → 500      提升 33 倍       ← 這段是真的有用
500 → 5000   提升 5%          ← 已經是雜訊
5000 → 100000 反而略降        ← 開始付出記憶體與 packet 的代價
```

✅ **選 500 ～ 1000。** 理由：

```
① 收益的 95% 在 500 以前就拿到了
② 批次越大，一次失敗要重做的量越大
③ 批次越大，改寫出來的 SQL 越長 → 越接近 max_allowed_packet
④ 批次越大，Java 端 addBatch 累積的物件越多 → GC 壓力
```

⚠️ **`batchSize = 1` 仍然有 4,427 筆/秒，而 5.4.3 的 autocommit 逐筆只有 1,113 筆/秒。**
**這 4 倍的差距完全來自「有沒有交易」，跟批次無關。**

### 5.4.3 交易邊界：138 倍在這裡

```
每  1,000 筆 commit 一次    798 ms   125,349 筆/秒
每  5,000 筆 commit 一次    685 ms   145,991 筆/秒
每 10,000 筆 commit 一次    773 ms   129,423 筆/秒
每 50,000 筆 commit 一次    695 ms   143,873 筆/秒
每 100,000 筆 commit 一次   650 ms   153,833 筆/秒

對照：autocommit（每一句一個交易）   17971 ms    1,113 筆/秒   🔴 慢 138 倍
```

📌 **兩個結論**：

```
① autocommit 逐筆寫入是【災難】—— 慢 138 倍
     每一次 commit 都要 fsync 兩次（04 章 4.2.5）

② 但交易多大其實沒差多少（1000 → 100000 只快 23%）
     🔥 所以【不要】為了那 23% 把交易開大
```

✅ **正確的交易大小由 04 章決定，不是由效能決定**：

```
04 章 4.2.8：每個交易 500 ～ 5000 筆
    ├─ 交易越大 → undo log 越大 → 別人的查詢越慢（04 章 4.3.8：20 倍）
    ├─ 交易越大 → 鎖持有越久 → 別人卡越久
    ├─ 交易越大 → 回滾越久（比寫入還久）
    └─ 交易越大 → binlog 單一事件越大 → 從庫延遲（07 章）

本章的實測補上第五條：
    └─ 而且交易變大【幾乎沒有效能好處】
```

**建議的組合**：

```java
// batchSize = 1000，每 5 個批次（5000 筆）commit 一次
try (PreparedStatement p = conn.prepareStatement(SQL)) {
    conn.setAutoCommit(false);
    int n = 0;
    for (Row row : rows) {
        bind(p, row);
        p.addBatch();
        if (++n % 1000 == 0) p.executeBatch();      // 送出批次
        if (n % 5000 == 0) { conn.commit(); }       // 結束交易
    }
    p.executeBatch();
    conn.commit();
}
```

⚠️ **`executeBatch()` 和 `commit()` 是兩件不同的事，很多人混在一起。**

```
executeBatch()  →  把累積的 SQL 送出去（網路層）
commit()        →  結束交易（持久化層）

沒有 executeBatch 就 commit → 累積的東西根本還沒送出去
沒有 commit 就一直 executeBatch → 交易越開越大
```

### 5.4.4 `LOAD DATA`：真的很大就用它

如果要匯入的是**檔案**（CSV / TSV），`LOAD DATA` 比任何 `INSERT` 都快一個數量級：

```sql
LOAD DATA LOCAL INFILE '/path/orders.csv'
INTO TABLE ord
FIELDS TERMINATED BY ',' ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 LINES
(order_no, customer_id, status, channel, total_amount, @placed)
SET placed_at = STR_TO_DATE(@placed, '%Y-%m-%d %H:%i:%s');
```

⚠️ **`LOCAL` 這個關鍵字有安全與設定的坑**：

```
伺服器端：  SET GLOBAL local_infile = 1;        （預設 OFF）
JDBC 端：   ?allowLoadLocalInfile=true          （8.0 起預設 false）

🔴 開 local_infile 等於「伺服器可以叫用戶端上傳任意檔案」——
   只在受控的匯入作業上開，用完關掉。
```

📌 **三種匯入方式的適用場景**：

| 方式 | 速度 | 適用 |
|---|---|---|
| `addBatch` + `rewriteBatchedStatements` | ~150k 筆/秒 | **應用程式內**產生的資料 |
| 手寫多值 `INSERT` | ~195k 筆/秒 | 同上，但要自己處理跳脫字元 🔴 |
| `LOAD DATA` | 更快（10 倍量級） | 資料**已經是檔案**、一次性遷移 |

⚠️ **「手寫多值 `INSERT`」比 `rewriteBatchedStatements` 快 29%，但我不建議。**
理由：你得自己處理字串跳脫（SQL injection 的溫床）、`NULL`、日期格式、二進位資料。
**29% 換一個 injection 漏洞，不划算。**

### 5.4.5 大量 `UPDATE` 怎麼辦

`rewriteBatchedStatements` 對 `UPDATE` 無效。三種做法：

**① `INSERT ... ON DUPLICATE KEY UPDATE`（可以被改寫）**

```sql
INSERT INTO stock (product_id, qty) VALUES (1,10),(2,20),(3,30)
ON DUPLICATE KEY UPDATE qty = VALUES(qty);
```

⚠️ **MySQL 8.0.20 起 `VALUES()` 已棄用**，新寫法：

```sql
INSERT INTO stock (product_id, qty) VALUES (1,10),(2,20) AS new
ON DUPLICATE KEY UPDATE qty = new.qty;
```

**② `CASE WHEN` 合併成一句**

```sql
UPDATE ord
SET status = CASE id WHEN 1 THEN 'PAID' WHEN 2 THEN 'SHIPPED' WHEN 3 THEN 'PACKED' END
WHERE id IN (1, 2, 3);
```

🔴 **注意 `WHERE id IN (...)` 一定要有** —— 沒有的話，其他所有列的 `status` 會被設成 `NULL`。
而且這個列表不能太長（5.6）。

**③ 建臨時表 + `JOIN UPDATE`（列數很多時最好）**

```sql
CREATE TEMPORARY TABLE tmp_upd (id BIGINT PRIMARY KEY, new_status VARCHAR(16));
-- 用 addBatch + rewriteBatchedStatements 灌進去（快）
UPDATE ord o JOIN tmp_upd t ON t.id = o.id SET o.status = t.new_status;
```

📌 **這一招的價值在於：把「一個慢的 UPDATE」換成「一個快的 INSERT + 一個走索引的 JOIN」。**

---

## 5.5 JOIN 的執行策略：nested loop、hash join、MRR

02 章 2.10 與 03 章 3.14 都欠了這一筆：**hash join 和 nested loop 的交叉點在哪裡。**

### 5.5.1 三種演算法

```
【索引 nested loop】—— 右表在 JOIN 欄位上【有索引】
    for 左表的每一列 r:
        用索引在右表查 r.key            ← O(log n) 一次
    成本 ≈ 左表列數 × 索引查找成本

【hash join】—— MySQL 8.0.18+，右表【沒有】可用索引
    ① 掃描較小的一側，建一張雜湊表放進 join_buffer
    ② 掃描另一側，逐列去雜湊表裡探測
    成本 ≈ 左表列數 + 右表列數          ← 兩邊各掃一次

【（舊）block nested loop】—— MySQL 8.0.20 之前，沒有索引時的做法
    for 左表的每一批（塞滿 join_buffer）:
        掃描右表一次
    成本 ≈ 左表列數 / 批次大小 × 右表列數    🔴 乘法
```

📌 **MySQL 8.0.20 之後 `block nested loop` 已經被移除**，
沒有索引的等值 JOIN 一律走 hash join。這是 MySQL 8 最大的單一效能改進。

**實測那個差距**（左表 10,193 列 × 右表 20,000 列）：

```
hash join                                        19 ms
nested loop（用 /*+ NO_BNL */ 強制，且無索引）  32,764 ms    🔴 1,682 倍
```

### 5.5.2 交叉點：75% ★

**實驗**：`ord JOIN customer ON c.id = o.customer_id WHERE o.status = ?`

- **索引 nested loop**：右表用有主鍵的 `customer`
- **hash join**：右表用完全沒有索引的 `cust_noidx`（內容完全相同）

改變 `status` 就改變左表的列數：

```
status      佔比     左表列數  |  索引 nested loop    hash join     差距
REFUNDED    1.0%      10,193  |          17 ms       1509 ms    91.37x
PENDING     2.0%      19,970  |          32 ms       1512 ms    47.09x
PAID        5.0%      49,804  |          78 ms       1544 ms    19.77x
SHIPPED     8.0%      80,008  |         129 ms       1536 ms    11.93x
DELIVERED  75.0%     749,917  |        1588 ms       1580 ms     1.00x   ← 🔥 交叉點
```

📌 **這張表是本節的核心，它說了三件事**：

**① hash join 的耗時幾乎是常數（1509 ～ 1580 ms）。**
因為它的成本是「掃兩張表各一次」，跟你選出多少列無關。

**② 索引 nested loop 的耗時是線性的。**
10,193 列 → 17 ms；749,917 列 → 1588 ms。**幾乎精準的 73.5 倍對 73.6 倍。**

**③ 交叉點落在左表 ≈ 75% 的地方。**

```
              耗時
                │
       1580ms   ├─────────────────────────●  hash join（幾乎水平）
                │                        ╱
                │                      ╱
                │                    ╱  索引 nested loop（線性）
                │                  ╱
            17ms├───────────────●╱
                └────────────────────────────► 左表列數
                 1%                    75%
```

⚠️ **實務上的意義**：

> **「這句 JOIN 沒有走索引，一定要加索引」—— 不一定。**
> 如果它每次都要處理表裡 75% 以上的資料（典型的報表 / 對帳），
> **hash join 已經跟索引一樣快了，加索引只會拖慢寫入。**

📌 **反過來說，只要選擇率好於 75%，索引就是壓倒性的**（1% 時快 91 倍）。
而**線上交易系統的查詢，選擇率幾乎總是遠好於 75%** ——
所以 03 章那句「每一句上線的查詢都要走索引」仍然成立。

### 5.5.3 `join_buffer_size`：實測沒有影響

hash join 用 `join_buffer_size` 放雜湊表。網路上很多文章說「調大它可以加速 JOIN」。

**實測**（DELIVERED 75%，749,917 × 20,000）：

```
join_buffer_size =     64 KB  →  1586 ms
join_buffer_size =    256 KB  →  1583 ms
join_buffer_size =   1024 KB  →  1540 ms
join_buffer_size =   8192 KB  →  1563 ms
join_buffer_size =  65536 KB  →  1591 ms
```

🔴 **從 64 KB 到 64 MB，差距在雜訊範圍內（3%）。**

📌 **為什麼？** 因為建雜湊表的那一側（`cust_noidx`，20000 列約 1.5 MB）
就算放不下也只是**多分幾個批次**，而每個批次的探測都是順序掃描 ——
在資料已經在 buffer pool 裡的時候，多掃幾次幾乎不花錢。

⚠️ **這是一個典型的「參數調校迷思」**：

> **`join_buffer_size` 是【每條連線、每個 JOIN】各配一份的。**
> 把它從 256 KB 調到 64 MB，在 200 條連線 × 每查詢 3 個 JOIN 的情況下，
> **最壞會多吃 38 GB 記憶體** —— 換來 3% 的雜訊。

### 5.5.4 MRR：實測沒有效果（老實說）

03 章 3.4.4 提過 `Using MRR`，並欠了一句「它的實際效果」。

**MRR（Multi-Range Read）在做什麼**：

```
沒有 MRR：              有 MRR：
用二級索引找到主鍵      用二級索引找到一批主鍵
    ↓ 立刻回表              ↓ 先【按主鍵排序】放進 read_rnd_buffer
    ↓ 主鍵是亂序的          ↓ 再照順序回表
    🔴 隨機 I/O             ✅ 接近順序 I/O
```

**實測**（`WHERE placed_at BETWEEN ... `，掃 188,610 列，需要回表）：

```
optimizer_switch = 'mrr=off'                    99 ms
optimizer_switch = 'mrr=on,mrr_cost_based=on'   99 ms     ← 預設，優化器決定不用
optimizer_switch = 'mrr=on,mrr_cost_based=off'  96 ms     ← 強制用，Extra 出現 Using MRR
```

🔴 **強制開啟 MRR 只快了 3%，在雜訊範圍內。**

📌 **為什麼？** 回到 5.2.3 那個發現：

```
MRR 優化的是「隨機 I/O 變順序 I/O」
    ↓
但這台機器上，資料【已經在 buffer pool 裡】
    ↓
「隨機讀記憶體」和「順序讀記憶體」的成本差不多
    ↓
🔴 MRR 沒有東西可以優化
```

⚠️ **這不代表 MRR 沒用，而是代表**：

> **MRR 是給「資料放不進 buffer pool 而且磁碟很慢」的環境用的。**
> 在 SSD + 資料全在記憶體的環境，優化器的預設判斷（`mrr_cost_based=on` 時不用它）是對的。
> **不要因為看到 `Extra` 沒有 `Using MRR` 就去強制開它。**

📌 **本節的三個實測（hash join 交叉點、`join_buffer_size`、MRR）有一個共同的教訓**：

> **參數調校的收益，幾乎總是遠小於「改寫 SQL」和「加對索引」。**
> 而且參數是**全域**的、記憶體是**每條連線**的 ——
> 調錯一個參數的風險，比一句慢查詢大得多。

---
## 5.6 `IN` 過長與參數上限

02 章 2.5.3 與 03 章 3.5.3 都指向這一節：

> **`WHERE id IN (?, ?, ?, ... )` —— 一萬個問號會發生什麼事。**

### 5.6.1 `eq_range_index_dive_limit`：200 這個數字 ★★

MySQL 估計 `IN` 列表會命中多少列，有兩種方法：

```
【索引探查（index dive）】—— 精確
    對 IN 裡的【每一個值】，真的去 B+Tree 裡走一趟，數出它有幾列
    成本：O(值的個數 × 樹高)          → 值多的時候很貴

【取樣統計（rec_per_key）】—— 便宜但粗糙
    用 ANALYZE TABLE 收集的「這個索引平均每個值有幾列」乘上去
    成本：O(1)                       → 但完全忽略資料分布不均
```

**切換點就是 `eq_range_index_dive_limit`，預設 200**：

```sql
SELECT @@eq_range_index_dive_limit;    -- 200
```

```
IN 的值 <  200  →  索引探查（精確）
IN 的值 >= 200  →  🔴 取樣統計（可能很不準）
```

**實測**（`customer_id IN (...)`，`ord` 表 100 萬列，客戶分布刻意偏斜）：

```
 IN 個數   EXPLAIN rows        實際列數      誤差      耗時
     10            441             441      0.0%      1 ms
     50          1,992           1,992      0.0%      1 ms
    100          3,983           3,983      0.0%      1 ms
    199         12,011          12,011      0.0%      2 ms     ← 🔥 完全精確
    200          9,400           7,912     18.8%      2 ms     ← 🔴 換方法了
    201          9,447          10,054     -6.0%      2 ms
    500         23,500          30,122    -22.0%      4 ms
   1000         47,000          60,053    -21.7%      9 ms
   5000        235,000         243,658     -3.6%     38 ms
  10000        470,000         494,898     -5.0%     71 ms
```

📌 **199 到 200 之間，估計從【完全精確】變成【誤差 18.8%】。**

**注意 200 之後的 `rows` 有個規律**：

```
200 個值 → 9,400     =  200 × 47
500 個值 → 23,500    =  500 × 47
1000 個值 → 47,000   = 1000 × 47
```

🔴 **它就是「值的個數 × 47」** —— 47 是 `ANALYZE TABLE` 算出來的
「`idx_cust_placed` 平均每個 `customer_id` 有 47 列」。
**優化器對每一個值都用同一個平均值，完全忽略「有些客戶有 2000 筆、有些只有 3 筆」。**

⚠️ **後果**（回到 03 章 3.9 的主題）：

```
估計偏低 → 優化器以為只要讀一點點 → 選了索引 → 實際上要回表幾十萬次 → 慢
估計偏高 → 優化器以為要讀很多     → 改選全表掃描 → 但其實只有幾百列 → 慢
```

**要不要調大 `eq_range_index_dive_limit`？**

```sql
SET SESSION eq_range_index_dive_limit = 1024;
```

```
✅ 好處：估計變準
🔴 代價：每一個值都要走一次 B+Tree
         1024 個值 × 樹高 3 = 3072 次頁面查找，【在【每一次 EXPLAIN / 查詢規劃時】都要做
         → 高頻查詢會把時間花在「規劃」而不是「執行」
```

📌 **我的建議：不要調這個參數，改成不要送那麼長的 `IN`。** 5.6.4 給做法。

### 5.6.2 長 `IN` 的實際成本

從上面的實測抽出耗時那一欄：

```
   10 個值    1 ms
  200 個值    2 ms
 1000 個值    9 ms
 5000 個值   38 ms
10000 個值   71 ms
```

📌 **成本大致是線性的**，看起來還好？**但這只是「查詢執行」的部分。** 完整的成本鏈是：

```
① Java 端組字串 / 綁 10000 個參數        （記憶體 + CPU）
② 網路傳輸這句 SQL                        （10000 個 8 位數的 id ≈ 90 KB）
③ MySQL 解析 10000 個常數                 （語法樹上 10000 個節點）
④ 優化器估計（5.6.1）
⑤ 執行
⑥ 🔴 每一種【不同長度】的 IN 都是一個【不同的】查詢
       → 預備語句快取全部失效
       → performance_schema 的 digest 表被灌爆（5.3.6 的 10000 上限）
```

⚠️ **第 ⑥ 點最容易被忽略。** `IN (?)`、`IN (?,?)`、`IN (?,?,?)` … 在 MySQL 眼裡是
**幾千種不同的語句**。你的 digest 表會被它們塞滿，真正的問題查詢反而找不到。

### 5.6.3 `max_allowed_packet` 與佔位符上限

**① `max_allowed_packet`：單一封包的上限**

```sql
SELECT @@max_allowed_packet / 1024 / 1024;    -- 預設 64 MB（MySQL 8）
```

**實測**（把它調成 4 MB，然後送一句 6 MB 的多值 `INSERT`）：

```
6000 列 × 1 KB 的單句 INSERT（約 6 MB）
🔴 Packet for query is too large (6,058,923 > 4,194,304).
   You can change this value on the server by setting the 'max_allowed_packet' variable.
   (errorCode = 0)
```

📌 **注意 `errorCode = 0`** —— 這是 **JDBC 驅動在用戶端擋下來的**，
封包根本沒送出去。所以你在 MySQL 的錯誤日誌裡**找不到任何紀錄**。

⚠️ **`max_allowed_packet` 同時管三件事**：

```
① 一句 SQL 的最大長度            → 長 IN / 多值 INSERT 會撞到
② 一列結果的最大長度              → TEXT / BLOB 欄位會撞到
③ 主從複製的單一 binlog 事件      → 🔴 主庫設 64 MB、從庫設 16 MB → 複製直接斷掉（07 章）
```

**② 佔位符（`?`）的數量上限：實測沒有硬限制**

伺服器端預備語句的協定用 2 bytes 表示參數個數，理論上限是 **65,535**。實測：

```
useServerPrepStmts=true

 60000 個 ?   ✅ 成功  183 ms
 65535 個 ?   ✅ 成功  151 ms
 65536 個 ?   ✅ 成功  143 ms      ← 🔴 沒有報錯
 70000 個 ?   ✅ 成功  133 ms      ← 🔴 也沒有報錯
```

📌 **為什麼沒報錯？** 因為 **mysql-connector-j 會靜默地退回用戶端預備語句**
（把參數直接拼進 SQL 字串再送出去）。

⚠️ **這是一個「靜默降級」**，和 03 章 3.9.3 的索引提示、04 章的 `WITH CONSISTENT SNAPSHOT`
是同一類問題：

```
你以為：用了伺服器端預備語句，SQL 只解析一次
實際上：超過上限之後，每一次呼叫都是一句全新的 SQL，要重新解析
        → 效能悄悄變差，但沒有任何錯誤訊息
```

**怎麼確認你的語句到底是哪一種**：

```sql
SHOW GLOBAL STATUS LIKE 'Com_stmt_prepare';    -- 伺服器端預備了幾次
SHOW GLOBAL STATUS LIKE 'Com_stmt_execute';    -- 執行了幾次
-- 健康的比例：execute 遠大於 prepare
```

### 5.6.4 長 `IN` 的四種改寫

**① 分批（最簡單，先做這個）**

```java
private static final int CHUNK = 500;    // 對齊 eq_range_index_dive_limit 的 200 以下更好

public List<Order> findByIds(List<Long> ids) {
    List<Order> result = new ArrayList<>(ids.size());
    for (int i = 0; i < ids.size(); i += CHUNK) {
        List<Long> chunk = ids.subList(i, Math.min(i + CHUNK, ids.size()));
        result.addAll(jdbc.query(
            "SELECT * FROM ord WHERE id IN (" + placeholders(chunk.size()) + ")",
            rowMapper, chunk.toArray()));
    }
    return result;
}
```

⚠️ **分批會讓「一個交易」變成「多次查詢」** —— 如果你需要一致的快照，
記得整段包在同一個 `@Transactional(readOnly = true)` 裡（04 章 4.3.4）。

**② 改成 `JOIN` 一張臨時表（列數很多時最好）**

```sql
CREATE TEMPORARY TABLE tmp_ids (id BIGINT PRIMARY KEY);
-- 用 addBatch + rewriteBatchedStatements 灌進去（5.4.1：15 萬筆/秒）
INSERT INTO tmp_ids VALUES (?),(?),(?)...;

SELECT o.* FROM ord o JOIN tmp_ids t ON t.id = o.id;
```

📌 **好處**：
```
✅ SQL 是固定的一句 → 預備語句快取有效、digest 表乾淨
✅ 優化器可以用真實的統計（臨時表也會被 ANALYZE）
✅ 沒有 max_allowed_packet 問題
🔴 代價：多一次建表 + 灌資料的往返
```

**③ 用 `JSON_TABLE` 把陣列變成表（MySQL 8）**

```sql
SELECT o.*
FROM JSON_TABLE(?, '$[*]' COLUMNS (id BIGINT PATH '$')) AS j
JOIN ord o ON o.id = j.id;
-- 參數是一個 JSON 陣列字串：[1,2,3,...]
```

📌 **只送一個參數，SQL 形狀永遠固定。**
🔴 **但優化器對 `JSON_TABLE` 的列數估計是寫死的**（通常猜一個很小的值），
**JOIN 的順序可能會選錯 —— 一定要 `EXPLAIN` 確認。**

**④ 重新想一下：你真的需要那一萬個 id 嗎？**

```java
// 🔴 典型的反模式：先撈 id，再用 id 去撈內容
List<Long> ids = jdbc.queryForList("SELECT id FROM ord WHERE status='PENDING'", Long.class);
List<Order> orders = findByIds(ids);        // 一萬個 IN

// ✅ 一句話搞定
List<Order> orders = jdbc.query("SELECT * FROM ord WHERE status='PENDING'", rowMapper);
```

⚠️ **這個反模式常常是 ORM 造成的**（先查 id 再 `findAllById`），08 章會再處理一次。

---

## 5.7 排序與暫存表

### 5.7.1 `sort_buffer_size`：merge passes 掉 91 倍，時間只快 13%

**實驗**：`SELECT id FROM ord ORDER BY total_amount LIMIT 500000`
（`total_amount` 沒有索引，必須 filesort）。

```
sort_buffer_size    耗時      Sort_merge_passes   Sort_rows
        64 KB     474 ms              91           500,000
       256 KB     429 ms              24           500,000
     1,024 KB     420 ms               6           500,000
     4,096 KB     413 ms               1           500,000
    16,384 KB     403 ms               1           500,000
```

📌 **`Sort_merge_passes` 從 91 降到 1（91 倍），耗時只從 474 ms 降到 403 ms（13%）。**

**為什麼？** MySQL 的外部排序：

```
① 把資料讀進 sort_buffer，排序，寫成一個「有序的區塊」到暫存檔
② 重複 ①，直到讀完
③ 把所有區塊【歸併】成一個有序的結果         ← Sort_merge_passes 記的是這個
```

`sort_buffer` 越大 → 區塊越少 → 歸併越少。
**但歸併本身是順序 I/O，在 SSD / 檔案快取上很便宜。**

⚠️ **這是本章第三個「參數調校收益很低」的實測**（前兩個是 `join_buffer_size` 和 MRR）。

✅ **`Sort_merge_passes > 0` 真正的意義不是「調大 buffer」，而是**：

> **「這句查詢正在對一大堆資料做記憶體外排序」——
> 該做的是加一個能消除排序的索引（03 章 3.5.5），不是加記憶體。**

```sql
-- 這句的正解
ALTER TABLE ord ADD INDEX idx_amount (total_amount);
-- 之後 EXPLAIN 的 Extra 不再有 Using filesort，Sort_merge_passes = 0
```

📌 **`sort_buffer_size` 的預設值 256 KB 在絕大多數情況下是對的。**
它是**每條連線、每次排序**各配一份的 —— 調到 256 MB 而有 200 條連線，
最壞情況要 50 GB。

### 5.7.2 `ORDER BY ... LIMIT` 小：優先佇列

```
ORDER BY total_amount LIMIT     20    145 ms   Sort_rows =     20   merge_passes = 0
ORDER BY total_amount LIMIT 100000    310 ms   Sort_rows = 100,000  merge_passes = 24
```

📌 **`LIMIT 20` 的 `Sort_rows` 是 20，不是 100 萬。**
MySQL 用**優先佇列**（大小為 `LIMIT` 的堆積）：掃過每一列，只保留目前最小的 20 個。

```
記憶體用量 = LIMIT × 列寬        ← 跟表的大小無關
```

⚠️ **但它仍然要【掃過】100 萬列**（145 ms 就是掃描的成本）。
優先佇列省的是「排序」，不是「掃描」。

📌 **這解釋了 03 章 3.4.4 的那個觀察**：
`ORDER BY ... LIMIT 100` 的 `Sort_rows` 只有 100。
**而它也解釋了為什麼深分頁那麼慘（5.8）**：
`LIMIT 500000, 20` 的優先佇列大小是 **500,020**，優先佇列的好處完全消失。

### 5.7.3 暫存表落到磁碟：觸發條件 ★

01 章 1.14 欠了一句「`TempTable` 退回磁碟的觸發條件」。這一節補上。

**MySQL 8 的內部暫存表有三層**：

```sql
SELECT @@internal_tmp_mem_storage_engine,   -- TempTable（8.0 起的預設，取代 MEMORY）
       @@temptable_max_ram / 1024 / 1024,   -- 1024 MB：【所有連線共用】的記憶體池
       @@tmp_table_size    / 1024 / 1024,   -- 16 MB：【單一查詢】的暫存表上限
       @@max_heap_table_size / 1024 / 1024; -- 16 MB：同上，取兩者較小值
```

```
查詢需要暫存表
    ↓
大小 <= min(tmp_table_size, max_heap_table_size)  →  ✅ TempTable，在記憶體
    ↓ 超過
🔴 轉成【磁碟上的 InnoDB 暫存表】→ Created_tmp_disk_tables + 1
```

**實測**（`SELECT COUNT(*) FROM (SELECT channel, remark, COUNT(*) FROM ord GROUP BY channel, remark) t`，
產生 10 萬個分組）：

```
tmp_table_size    耗時       Created_tmp_tables   Created_tmp_disk_tables
      4 MB      2459 ms              2                    2          🔴
     16 MB      2162 ms              2                    1          🔴
     32 MB      1811 ms              2                    1          🔴
     64 MB      1093 ms              2                    1          🔴
    128 MB       416 ms              2                    0          ✅
```

📌 **4 MB → 128 MB，耗時 2459 → 416 ms，快 5.9 倍。**
**這是本章唯一一個「調參數真的有很大效果」的例子** ——
因為它改變的不是快取大小，而是**演算法**（記憶體 vs 磁碟）。

⚠️ **但注意預設值 16 MB 的意義**：

```
tmp_table_size = 16 MB  →  暫存表超過 16 MB 就落地
                           而 16 MB 大概只裝得下【十萬列左右的小結果】
```

✅ **正確的處理順序**：

```
① 先問：這個暫存表【能不能不要】？
     → GROUP BY / DISTINCT / UNION / 派生表 都可能產生暫存表
     → 加一個讓 GROUP BY 走索引順序的索引 → 暫存表消失（03 章 3.5.5）
② 不能消除的話，問：結果集【能不能變小】？
     → 加 WHERE、加 LIMIT、先聚合再 JOIN（02 章 2.3.4）
③ 都不行，才調 tmp_table_size
     → 而且要同時調 max_heap_table_size（取兩者較小值）
     → 🔴 它也是【每個查詢】各配一份的
```

📌 **`temptable_max_ram`（預設 1 GB）是所有連線共用的總量**，
超過之後 TempTable 會改用**記憶體對映檔**（`temptable_use_mmap`）。
實測顯示把它從 1 MB 調到 64 MB 對本例**沒有影響** ——
**真正決定「要不要落地」的是 `tmp_table_size`。**

**怎麼監控**：

```sql
SHOW GLOBAL STATUS LIKE 'Created_tmp%';
-- Created_tmp_tables       建了幾個暫存表
-- Created_tmp_disk_tables  其中幾個落到磁碟
-- 健康標準：disk / tables < 5%
```

```sql
-- 找出哪些查詢在製造磁碟暫存表（比看全域計數器有用得多）
SELECT LEFT(DIGEST_TEXT, 70) AS q, COUNT_STAR,
       SUM_CREATED_TMP_DISK_TABLES AS tmp_disk,
       SUM_CREATED_TMP_TABLES AS tmp_all
FROM performance_schema.events_statements_summary_by_digest
WHERE SUM_CREATED_TMP_DISK_TABLES > 0
ORDER BY SUM_CREATED_TMP_DISK_TABLES DESC LIMIT 10;
```

---
## 5.8 深分頁與大結果集

03 章 3.8.6 量過深分頁，結論是「seek 法快 319 倍、延遲關聯只快 1.8 倍」。
這一節要說明**為什麼延遲關聯有時候只快 1.8 倍、有時候快 37 倍** ——
以及大結果集在 Java 端會炸掉什麼。

### 5.8.1 深分頁：三種寫法（按主鍵排序）

```sql
-- ① 直接 OFFSET
SELECT * FROM ord ORDER BY id LIMIT 900000, 20;

-- ② 延遲關聯（先在索引上分頁，再回表 20 次）
SELECT o.* FROM ord o
JOIN (SELECT id FROM ord ORDER BY id LIMIT 900000, 20) x USING (id);

-- ③ seek 法 / 游標分頁（記住上一頁的最後一個 id）
SELECT * FROM ord WHERE id > 900000 ORDER BY id LIMIT 20;
```

```
    OFFSET  |  ① LIMIT o,20   ② 延遲關聯   ③ seek 法
         0  |       0.8 ms       0.6 ms      0.5 ms
    10,000  |       2.4 ms       1.3 ms      0.5 ms
   100,000  |      19.6 ms       9.5 ms      0.4 ms
   500,000  |      95.5 ms      45.3 ms      0.6 ms
   900,000  |     167.6 ms      79.0 ms      0.5 ms
```

📌 **seek 法是唯一一個【常數時間】的做法（0.4 ～ 0.6 ms），比 ① 快 335 倍。**
**而延遲關聯只快 2.1 倍** —— 跟 03 章的 1.8 倍一致。

**為什麼延遲關聯在這裡幫不上忙？**

```
排序欄位就是【主鍵】
    ↓
「先在索引上分頁」和「直接分頁」走的是【同一個】聚簇索引
    ↓
兩者都要掃過前 900,000 個索引項
    ↓
🔴 只省下了「把 900,000 列的完整資料組出來」，沒省掉掃描
```

### 5.8.2 同一個技巧，換成二級索引排序：快 37 倍 ★

```sql
-- ① 直接
SELECT * FROM ord ORDER BY placed_at LIMIT 100000, 20;
-- ② 延遲關聯
SELECT o.* FROM ord o JOIN (SELECT id FROM ord ORDER BY placed_at LIMIT 100000, 20) x USING (id);
```

```
    OFFSET  |     ① 直接      ② 延遲關聯     差距
         0  |     0.5 ms       0.5 ms      1.0x
   100,000  |   342.9 ms       9.3 ms     36.9x    🔥
   500,000  |   376.7 ms      43.5 ms      8.7x
```

📌 **同一個技巧，效果從 2.1 倍變成 36.9 倍。差別在哪？**

```
按【主鍵】排序：
    掃 900,000 個索引項  →  資料就在索引葉節點上  →  不用回表
    延遲關聯省不到東西

按【二級索引】排序：
    掃 100,000 個索引項  →  🔴 每一個都要【回表】拿完整的列（03 章 3.3.3）
    延遲關聯把「回表 100,000 次」變成「回表 20 次」
    ✅ 省掉 99.98% 的回表
```

> **延遲關聯優化的是【回表】，不是【掃描】。
> 所以它只在「排序欄位是二級索引 + SELECT 需要回表」的時候有效。**

⚠️ **這也解釋了為什麼 OFFSET 500,000 時它只快 8.7 倍** ——
掃描的成本開始佔大頭，能省的回表比例相對變小。

📌 **決策表**：

| 情況 | 用什麼 |
|---|---|
| 可以改 API（不需要「跳到第 N 頁」） | ✅ **seek 法**，常數時間 |
| 必須支援跳頁，且按**二級索引**排序 | ✅ **延遲關聯**（8.7 ～ 37 倍） |
| 必須支援跳頁，且按**主鍵**排序 | 🟡 延遲關聯只有 2 倍；考慮限制最大頁數 |
| 需要「總共幾頁」 | 🔴 `COUNT(*)` 本身就要掃全表 —— 改成「還有更多」的無限捲動 |

**seek 法的正確寫法**（03 章 3.8.6 的 `key_len` 陷阱，這裡重申）：

```sql
-- 🔴 簡潔但只用到索引的第一欄（key_len = 4）
SELECT * FROM ord WHERE (placed_at, id) < (?, ?) ORDER BY placed_at DESC, id DESC LIMIT 20;

-- ✅ 展開成 OR 形式，三欄全用（key_len = 19）
SELECT * FROM ord
WHERE placed_at < ?
   OR (placed_at = ? AND id < ?)
ORDER BY placed_at DESC, id DESC
LIMIT 20;
```

⚠️ **兩句語意一模一樣，只有 `key_len` 看得出差別。**

### 5.8.3 一次撈 100 萬列：JDBC 的三種 fetch 模式

```java
// ① 預設：驅動把【整個結果集】讀進 Java 堆積再回傳
Statement s = conn.createStatement();
ResultSet rs = s.executeQuery("SELECT id, order_no, total_amount FROM ord");

// ② useCursorFetch=true + setFetchSize(n)：伺服器端游標，一次抓 n 列
//    URL 要加 ?useCursorFetch=true
s.setFetchSize(1000);

// ③ 串流：一列一列讀，驅動完全不快取
Statement s = conn.createStatement(ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY);
s.setFetchSize(Integer.MIN_VALUE);
```

**實測**（100 萬列，3 個欄位，`-Xmx2g`）：

```
① 預設（全部載入）           1,000,000 列   520 ms   堆積用量 185.1 MB
② useCursorFetch=true       1,000,000 列   900 ms   堆積用量  28.7 MB
③ setFetchSize(MIN_VALUE)   1,000,000 列   241 ms   堆積用量  47.1 MB   ← 🏆
```

📌 **三者的取捨**：

| 模式 | 記憶體 | 速度 | 代價 |
|---|---|---|---|
| ① 預設 | 🔴 **O(結果集)** | 中 | 結果集大 → **OOM** |
| ② `useCursorFetch` | ✅ O(fetchSize) | 🔴 最慢（每批一次往返） | 伺服器端要建**暫存表**放結果 |
| ③ 串流 | ✅ O(1) | ✅ 最快 | 🔴 **這條連線在讀完之前不能做別的事** |

⚠️ **串流模式（③）的三個陷阱**：

```
🔴 讀到一半不能執行別的 SQL（同一條連線）
     → 典型錯誤：一邊串流讀，一邊在迴圈裡 UPDATE  → 驅動丟例外
     → 要改的話，開【第二條連線】

🔴 ResultSet 沒讀完就 close()，驅動要把剩下的資料全部讀掉才能釋放連線
     → 大結果集提前 break 會卡住

🔴 這條連線一直被佔著 → 連線池被吃掉一格（04 章 4.7.6）
```

✅ **最實用的建議：不要撈那麼多。**

```java
// 🔴 撈全部再自己分頁
List<Order> all = jdbc.query("SELECT * FROM ord", mapper);
return all.subList(offset, offset + 20);

// ✅ 讓資料庫分頁
return jdbc.query("SELECT * FROM ord WHERE id > ? ORDER BY id LIMIT 20", mapper, lastId);
```

📌 **真的需要處理整張表的場景（匯出、遷移、重算）**：
用**串流 + 分批 commit**，或用 5.9 的分批游標。

---

## 5.9 分批 `DELETE` / `UPDATE`

02 章 2.7.7 與 2.10 指向這一節：

> **不要用在會選出幾百萬列的子查詢上（05 章 5.9 會給分批的做法）。**

### 5.9.1 一次刪 38 萬列 vs 分批刪

```sql
-- ① 一句話刪完
DELETE FROM del_t WHERE placed_at < '2025-05-15';

-- ② 分批，每次 5000 列
DELETE FROM del_t WHERE placed_at < '2025-05-15' ORDER BY placed_at LIMIT 5000;
-- 重複執行直到影響列數 = 0
```

**實測**（100 萬列的表，刪掉 385,919 列）：

```
① 一句 DELETE     385,919 列   9702 ms   history_len =  14
② 分批 5000/次    385,919 列   3777 ms   78 輪   最大 history_len = 103
                              ↑ 🔥 分批【比較快】，快 2.6 倍
```

📌 **「分批比較慢，因為要跑 78 次」是一個很直覺但錯誤的想法。**

**為什麼分批反而快？**

```
一句 DELETE 38 萬列：
    ├─ 一個 undo log 要記 38 萬列的舊值        → undo 段一路長大
    ├─ 一個交易持有 38 萬個行鎖                 → 鎖結構的記憶體與管理成本
    ├─ redo log 一次寫入大量資料                → 可能觸發同步刷髒頁
    └─ 🔴 中途失敗要回滾 38 萬列（比刪還久）

分批 5000 列 × 78 次：
    ├─ 每個交易的 undo 只有 5000 列 → commit 後就能被 purge
    ├─ 每次只鎖 5000 列，別人有機會插隊         ← 這才是分批的【主要目的】
    └─ 失敗只損失最後一批
```

⚠️ **`history_len` 那一欄要注意**：分批的最大值（103）**比一次刪（14）還高**。
因為分批產生了 78 個交易，purge 執行緒要追。
**這不是問題（它會被追上），但代表「分批不是無代價的」。**

📌 **分批真正的好處不是速度，是【不要卡住別人】**（04 章 4.5.6）：

```
一句 DELETE 38 萬列 → 這 9.7 秒裡，那 38 萬列全部被鎖住
分批 5000 列        → 每一批只鎖 30 ～ 50 ms，中間別人可以進來
```

### 5.9.2 刪完之後，檔案不會變小 🔴

```
① 剛建好（100 萬列）          DATA_LENGTH = 284.0 MB   實體檔案 348.0 MB
② 刪掉 38.6 萬列之後           DATA_LENGTH = 284.0 MB   實體檔案 348.0 MB   🔴 完全沒變
③ OPTIMIZE TABLE 之後         DATA_LENGTH = 104.6 MB   實體檔案 128.0 MB   ✅ 縮小 63%
```

📌 **`DELETE` 只是把列標記成刪除**，空間留在資料檔裡給未來的 `INSERT` 用。
**磁碟不會還給你。**

⚠️ **這在三個地方會咬人**：

```
① 監控上：「我刪了一半資料，磁碟用量沒變」→ 以為刪除沒生效
② 備份上：mysqldump / xtrabackup 的大小不會變小
③ 效能上：🔴 全表掃描仍然要走過那些【空洞】的頁面
```

**`OPTIMIZE TABLE` 做了什麼**：

```
shop5t.del_t  optimize  note    Table does not support optimize, doing recreate + analyze instead
shop5t.del_t  optimize  status  OK
```

📌 **對 InnoDB 來說 `OPTIMIZE TABLE` = `ALTER TABLE ... FORCE` + `ANALYZE TABLE`**
—— 也就是**重建整張表**。

```
✅ MySQL 5.6+ 是 ONLINE 的（其他人可以繼續讀寫）
🔴 但需要【和原表一樣大的臨時空間】
🔴 而且最後的 rename 階段要拿 MDL 排他鎖（04 章 4.5.4）
     → 有長交易在跑的時候，它會卡住，然後卡住所有人
🔴 大表要跑很久（本例 277 MB 跑了 3.2 秒；100 GB 的表要以小時計）
```

✅ **正式環境的做法**：

```
① 定期刪除的表 → 用【分區表】，直接 DROP PARTITION（瞬間，而且空間立刻回收）
② 大表 → 用 gh-ost / pt-online-schema-change（06 章）
③ 小表 / 離峰時段 → OPTIMIZE TABLE 可以接受
🔴 永遠不要在尖峰時間對大表跑 OPTIMIZE
```

### 5.9.3 分批的正確寫法與三個陷阱

```java
/** 分批刪除：每批 5000 列，批間 sleep 讓出資源 */
public int purgeOldOrders(LocalDateTime before) {
    int total = 0, batch;
    do {
        batch = jdbc.update("""
                DELETE FROM ord
                 WHERE placed_at < ?
                 ORDER BY placed_at
                 LIMIT 5000
                """, before);
        total += batch;
        if (batch > 0) sleepQuietly(50);      // 讓出 CPU 與 I/O，別把從庫拖爆
    } while (batch > 0);
    return total;
}
```

⚠️ **三個陷阱**：

**① `ORDER BY` 不能省**

```sql
-- 🔴 沒有 ORDER BY：每一批 MySQL 都從頭掃描找符合的列
DELETE FROM ord WHERE placed_at < ? LIMIT 5000;

-- ✅ 有 ORDER BY placed_at：走 idx_placed，每批從上次結束的地方繼續
DELETE FROM ord WHERE placed_at < ? ORDER BY placed_at LIMIT 5000;
```

📌 **而且 `ORDER BY` 的欄位要有索引**，不然你會得到 04 章 4.5.6 的「鎖全表」。

**② 每一批都是獨立交易 —— 這是刻意的，不要包在一個 `@Transactional` 裡**

```java
// 🔴 錯：整個迴圈在一個交易裡 → 等於沒有分批
@Transactional
public int purge() { do { ... } while (batch > 0); }

// ✅ 對：不標 @Transactional（每個 jdbc.update 自己 autocommit），
//        或把單批抽成一個 @Transactional 方法（注意 04 章 4.7.1 P4 的自我呼叫）
```

**③ 要有「跑不完」的出口**

```java
long deadline = System.currentTimeMillis() + Duration.ofMinutes(30).toMillis();
do {
    batch = deleteOneBatch(before);
    total += batch;
    if (System.currentTimeMillis() > deadline) {
        log.warn("清理逾時，已刪 {} 列，剩下的下次再處理", total);
        break;                       // ✅ 下次排程接著跑
    }
} while (batch > 0);
```

📌 **同樣的三個原則適用於分批 `UPDATE`**：

```sql
UPDATE ord SET status = 'ARCHIVED'
 WHERE status = 'DELIVERED' AND placed_at < ?
 ORDER BY placed_at
 LIMIT 5000;
```

**如果要刪的是「整張表」**：

```sql
TRUNCATE TABLE t;    -- ✅ 幾乎瞬間，而且【空間立刻回收】
DELETE FROM t;       -- 🔴 一列一列刪，寫滿 undo，空間不回收
```

⚠️ **但 `TRUNCATE` 是 DDL —— 它會隱式提交交易、不能回滾**（04 章 4.2.7）。

---

## 5.10 連線、逾時與資源上限

### 5.10.1 連線數 vs 吞吐量：拐點在核心數 ★

**實驗**：8 核心的容器，全部命中 buffer pool 的點查詢，每個連線一個執行緒全力打 3 秒。

```
連線數      總查詢數        QPS      平均延遲
    1        18,907       6,289      0.16 ms
    2        38,075      12,664      0.16 ms
    4        60,266      20,030      0.20 ms
    8        73,495      24,406      0.33 ms     ← 核心數
   16        82,454      27,323      0.59 ms
   32        94,121      31,031      1.03 ms
   64       100,973      33,022      1.94 ms     ← QPS 飽和
  128       105,897      33,943      3.77 ms
  256       101,592      31,436      8.14 ms     🔴 QPS 開始【下降】
```

📌 **這條曲線有三段，每一段的含意完全不同**：

```
1 → 8 連線（≈ 核心數）
    QPS 幾乎線性成長（6,289 → 24,406，3.9 倍）
    延遲幾乎不變（0.16 → 0.33 ms）
    ✅ 這一段是「免費」的併發

8 → 64 連線
    QPS 只成長 35%（24,406 → 33,022）
    🔴 延遲成長 5.9 倍（0.33 → 1.94 ms）
    🟡 你在用延遲換吞吐量

64 → 256 連線
    QPS 【下降】（33,943 → 31,436）
    🔴 延遲再成長 4.2 倍（1.94 → 8.14 ms）
    🔴 純虧：更多連線 = 更慢 + 更少
```

⚠️ **這條曲線解釋了 04 章 4.7.8 那個「連線池不是越大越好」的結論**：

> **超過核心數之後，多出來的連線不會讓資料庫做更多事，
> 只會讓每一個請求【排更久的隊】。**
> 而排隊排在連線池裡（可見、可控）遠比排在資料庫裡（不可見、拖垮所有人）好。

📌 **HikariCP 的建議公式**：

```
連線數 ≈ (核心數 × 2) + 有效磁碟數
8 核 + SSD  →  17 ～ 20
```

**本次實測的最佳點**（QPS 高且延遲還可接受）：

```
延遲優先（P99 < 1 ms）   →  16 條  （27,323 QPS，0.59 ms）
平衡                     →  32 條  （31,031 QPS，1.03 ms）
吞吐優先（不在乎延遲）    →  64 條  （33,022 QPS，1.94 ms）
🔴 128 以上             →  沒有任何好處
```

### 5.10.2 逾時的七個層次

一個請求從瀏覽器到 InnoDB，中間有**七個**可以逾時的地方。
**任何一層設錯，都會讓上面的層次白等。**

📌 **設定原則：由外而內【遞減】。** 下面每一層的值就是本節推薦的一組
（每層留一點餘裕給重試與網路），**注意它是一路變小的**：

```
① 瀏覽器 / 前端            fetch timeout                        30 秒
② 反向代理 / 閘道          proxy_read_timeout                   25 秒
③ 應用伺服器               server.tomcat...                     20 秒
④ JDBC：Socket 讀取        socketTimeout                        15 秒
⑤ JDBC / SQL：語句         queryTimeout / MAX_EXECUTION_TIME    10 秒
⑥ MySQL：行鎖等待          innodb_lock_wait_timeout              5 秒（預設 50！）
   MySQL：中繼資料鎖        lock_wait_timeout                     5 秒（預設 31536000！）
───────────────────────────────────────────────────────────────────────
⑦ 連線池：拿連線           hikari.connection-timeout             3 秒
   ★ 這一層【不在遞減鏈上】—— 它量的是「等一條連線」，不是「等一個結果」，
     所以它要【很短】：拿不到連線就該立刻失敗（04 章 4.7.8）。
```

🔴 **最常見的錯法是把它排成【遞增】**：

```
🔴 反例：瀏覽器 10s  >  閘道 15s ?
        閘道比瀏覽器久 → 使用者已經斷線，後端還在跑
        → 使用者按了重試 → 兩份工作同時在跑 → 雪崩

🔴 反例：queryTimeout 5s  <  innodb_lock_wait_timeout 50s（MySQL 的預設值）
        鎖等待比語句逾時久 → 永遠是 queryTimeout 先觸發，
        而 Connector/J 的 queryTimeout 是「另開一條連線送 KILL QUERY」，
        你拿到的是 Statement cancelled due to timeout or client request
        → 🔴 你【永遠看不到】Lock wait timeout exceeded 這個訊息，
          於是「這句查詢是在等鎖」這個唯一的線索被自己的設定蓋掉了。
```

**具體怎麼設**：

```properties
# Spring Boot / HikariCP
spring.datasource.url=jdbc:mysql://host:3306/shop\
  ?rewriteBatchedStatements=true\
  &connectTimeout=3000\
  &socketTimeout=15000
spring.datasource.hikari.connection-timeout=3000
spring.datasource.hikari.validation-timeout=2000
spring.datasource.hikari.max-lifetime=1740000
spring.datasource.hikari.connection-init-sql=SET SESSION innodb_lock_wait_timeout=5
```

```java
// 單一查詢的逾時（Spring）
@Transactional(timeout = 10)        // 秒；整個交易
public void doWork() { ... }

// JdbcTemplate 層級
jdbcTemplate.setQueryTimeout(10);
```

```sql
-- MySQL 8 也可以在 SQL 裡直接寫（只對 SELECT 有效，單位是毫秒）
SELECT /*+ MAX_EXECUTION_TIME(3000) */ * FROM ord WHERE ...;
-- 超時的話：ERROR 3024 (HY000): Query execution was interrupted,
--          maximum statement execution time exceeded

-- 或設成 session 預設
SET SESSION max_execution_time = 3000;
```

📌 **`MAX_EXECUTION_TIME` 是 MySQL 端唯一能【主動砍掉】跑太久的 SELECT 的機制。**
`queryTimeout`（JDBC 端）只是關掉連線，**MySQL 那邊的查詢還在跑** ——
除非驅動另外送一個 `KILL QUERY`（mysql-connector-j 會，但要多一次往返）。

⚠️ **`max_lifetime` 一定要小於 MySQL 的 `wait_timeout`**：

```sql
SELECT @@wait_timeout, @@interactive_timeout;    -- 預設 28800 秒 = 8 小時
```

```
連線池以為連線還活著，MySQL 那邊已經關掉了
    ↓
🔴 CommunicationsException: The last packet successfully received from the server was ...
```

**建議**：`max-lifetime` = `wait_timeout` − 60 秒，或直接設成 29 分鐘（1740000 ms）。

### 5.10.3 `max_connections` 與連線的成本

```sql
SELECT @@max_connections,               -- 預設 151
       @@thread_cache_size,             -- 執行緒快取
       @@table_open_cache;
SHOW GLOBAL STATUS LIKE 'Threads_connected';   -- 目前連著幾條
SHOW GLOBAL STATUS LIKE 'Max_used_connections'; -- 歷史最高
SHOW GLOBAL STATUS LIKE 'Threads_created';      -- 一共建過幾條（跟 cache 命中有關）
SHOW GLOBAL STATUS LIKE 'Connection_errors_max_connections';  -- 被拒絕過幾次
```

📌 **`max_connections` 該設多少**：

```
所有應用實例的連線池上限總和 × 1.2 + 10（留給維運）

例：5 個 Pod × 每個 20 條 = 100  →  max_connections = 130
```

⚠️ **它不是「越大越安全」**：

```
max_connections = 1000
    ↓
真的來了 1000 條 → 每條吃 1~4 MB 私有緩衝 → 1~4 GB 記憶體
    ↓ 加上 buffer pool
    🔴 OOM
    ↓ 就算沒 OOM
    🔴 5.10.1 的曲線告訴你：QPS 反而下降
```

✅ **正確做法是「在應用端排隊，不要在資料庫端排隊」**：
連線池滿了 → `connection-timeout` 快速失敗 → 上層降級 / 重試。
這比「1000 條連線一起把資料庫拖垮」好得多。


### 5.10.4 寫入熱點：連線再多也沒用 ★（回答 04 章）

5.10.1 那條曲線是**唯讀**的。04 章 4.12 欠了另一條：
**如果所有請求都在搶同一列，曲線長什麼樣子？**

**實驗**：同一張 `seat` 表，所有執行緒都 `UPDATE ... WHERE seat_no = 'S-000001'`
（**同一列**），每個執行緒 20 次。

```
連線數       耗時        TPS      對照：5.10.1 的唯讀 QPS
     1      169 ms      119                    6,289
     2       55 ms      734                   12,664
     4       99 ms      812                   20,030
     8      169 ms      948                   24,406
    16      329 ms      974                   27,323
    32      620 ms    1,032                   31,031
    64    1,271 ms    1,007                   33,022
   128    2,568 ms      997                   33,943
   256    3,950 ms    1,296                   31,436
```

📌 **TPS 從 8 連線起就完全飽和在 ≈ 1,000，加再多連線一點用都沒有。**

```
唯讀查詢：8 → 64 連線，QPS 從 24,406 漲到 33,022（+35%）
熱點寫入：8 → 64 連線，TPS 從    948 漲到  1,007（+6%，雜訊）
```

**為什麼？** 因為所有更新都在**同一列的行鎖**上排隊（04 章 4.5.5 的 L1）：

```
熱點寫入的吞吐量上限  =  1 / 單次持鎖時間
                      =  1 / 1 ms
                      ≈  1,000 TPS

🔴 這個上限跟【連線數】、【核心數】、【buffer pool】全部無關
```

⚠️ **這是容量規劃時最容易算錯的一件事**：

```
「我的機器可以跑 33,000 QPS」
    ↓
🔴 那是【每個請求碰不同列】的數字
    ↓
只要有一個熱點（爆款商品的庫存、某個大客戶的帳戶餘額、一個全域計數器）
    ↓
那條路徑的上限就是【1,000 TPS】，不管你加幾台應用機器
```

✅ **突破這個上限的四種做法**（沒有一種是「加連線」）：

```
① 縮短持鎖時間        →  04 章 4.7.6：交易裡不要有外部呼叫
                         1 ms → 0.2 ms 就等於 TPS ×5

② 把熱點【拆開】      →  一個庫存拆成 10 個分片（qty 各 100），
                         隨機挑一個扣；不夠時才合併
                         → 上限 ×10

③ 把熱點【移出 DB】   →  Redis 扣減 + 非同步落庫（10 章）
                         → 上限 ×100

④ 把熱點【變成排隊】  →  訊息佇列串行處理（11 章）
                         → 上限不變，但延遲可控、不會拖垮別人
```

📌 **注意 ① 是唯一一個不用改架構的** —— 而且它常常就夠了。
先把交易縮短到只剩 SQL，量一次，再決定要不要做 ② ③ ④。

---
## 5.11 Java 端的效能反模式

前面十節講的是資料庫。這一節講**你的程式碼怎麼把一個健康的資料庫用垮**。
每一個反模式都有實測倍數。

### 5.11.1 N+1：15 倍

```java
// 🔴 500 個客戶，500 次查詢
for (Customer c : customers) {
    long n = jdbc.queryForObject("SELECT COUNT(*) FROM ord WHERE customer_id=?", Long.class, c.getId());
    c.setOrderCount(n);
}

// ✅ 一次查完
Map<Integer, Long> counts = jdbc.query(
    "SELECT customer_id, COUNT(*) FROM ord WHERE customer_id IN (...) GROUP BY customer_id",
    rs -> { ... });
```

```
① N+1（500 次查詢）              135 ms   合計 52,218 列
② 一次 IN + GROUP BY（1 次）       9 ms   合計 52,218 列    ← 🔥 15 倍
```

📌 **注意 135 ms 除以 500 = 0.27 ms/次 —— 每一次查詢本身都很快。**
**N+1 的成本不在 SQL，在【往返】。**

⚠️ **而 15 倍是**本機、同一台機器、`localhost`**的數字。**

```
本機              每次往返 ≈ 0.2 ms   →  500 次 = 100 ms
同機房            每次往返 ≈ 0.5 ms   →  500 次 = 250 ms
跨可用區          每次往返 ≈ 2 ms     →  500 次 = 1 秒
跨區域            每次往返 ≈ 30 ms    →  500 次 = 🔴 15 秒
```

📌 **N+1 是本章「本機量不到」原則最典型的例子** ——
在你的筆電上它是 135 ms，在正式環境可能是 15 秒。

**怎麼發現 N+1**：

```sql
-- digest 表裡「呼叫次數異常高、單次很快」的那些
SELECT LEFT(DIGEST_TEXT, 60) AS q, COUNT_STAR,
       ROUND(AVG_TIMER_WAIT/1e9, 3) AS avg_ms,
       ROUND(SUM_TIMER_WAIT/1e12, 2) AS total_s
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = DATABASE()
ORDER BY COUNT_STAR DESC LIMIT 10;
```

⚠️ **08 章（JPA / MyBatis）會處理 ORM 造成的 N+1**（`@OneToMany` 的延遲載入、
`JOIN FETCH`、`@BatchSize`、MyBatis 的巢狀查詢）。**這裡先建立判斷方法。**

### 5.11.2 用 `COUNT(*)` 做存在性判斷：190 倍

```
SELECT COUNT(*) FROM ord WHERE status='DELIVERED'      95.0 ms
SELECT 1 FROM ord WHERE status='DELIVERED' LIMIT 1      0.9 ms
SELECT EXISTS(SELECT 1 FROM ord WHERE status='DELIVERED')  0.5 ms   ← 🔥 190 倍
```

```java
// 🔴 為了知道「有沒有」，把 75 萬列全部數了一遍
if (jdbc.queryForObject("SELECT COUNT(*) FROM ord WHERE status=?", Integer.class, s) > 0) { ... }

// ✅
if (Boolean.TRUE.equals(jdbc.queryForObject(
        "SELECT EXISTS(SELECT 1 FROM ord WHERE status=?)", Boolean.class, s))) { ... }
```

📌 **`EXISTS` 找到第一列就停。`COUNT(*)` 一定要數完。**

⚠️ **JPA 的 `repository.count() > 0` 是同一個問題** ——
用 `existsBy...` 或 `@Query("SELECT COUNT(x) > 0 ...")`。

### 5.11.3 撈全部再在 Java 過濾：95 倍

```
Java 端過濾（撈 100 萬列回來自己 if）    380 ms   結果 10,193 列
DB 端過濾（WHERE status='REFUNDED'）      4 ms   結果 10,193 列   ← 🔥 95 倍
```

```java
// 🔴
List<Order> all = jdbc.query("SELECT * FROM ord", mapper);
List<Order> refunded = all.stream().filter(o -> o.getStatus().equals("REFUNDED")).toList();

// ✅
List<Order> refunded = jdbc.query("SELECT * FROM ord WHERE status=?", mapper, "REFUNDED");
```

📌 **這一條看起來太蠢不會有人犯，但它有三個很常見的偽裝**：

```
🔴 偽裝一：先撈回來做「複雜的」商業邏輯過濾
        → 先用 SQL 濾掉九成，剩下的再用 Java 處理

🔴 偽裝二：Spring Data 的 findAll() 之後 stream().filter()
        → 用 Specification / 自訂 @Query

🔴 偽裝三：分頁在 Java 端做（5.8.3）
        → List.subList(offset, offset+20)
```

### 5.11.4 `SELECT *`

```
SELECT *                     4.2 ms
SELECT id, total_amount      2.7 ms      ← 1.6 倍
SELECT COUNT(*)（覆蓋索引）    0.5 ms      ← 8.4 倍
```

（`customer_id = 42`，約 2000 列）

📌 **`SELECT *` 的四個代價**：

```
① 網路傳輸更多位元組
② Java 端要建更多物件 → GC 壓力
③ 🔥 讓【覆蓋索引失效】（03 章 3.6）→ 從「不用回表」變成「每列都回表」
④ 🔥 schema 一改（加一個 TEXT 欄位），這句查詢的成本【無聲地】翻倍
```

⚠️ **第 ③ 點是最重要的。** 本節那個 8.4 倍幾乎全部來自「要不要回表」，
而不是「傳輸幾個欄位」。

### 5.11.5 在迴圈裡開交易 / 開連線

```java
// 🔴 每一筆都拿一次連線、開一次交易
for (Order o : orders) {
    orderService.saveOne(o);      // @Transactional
}
```

```
autocommit 逐筆     1,113 筆/秒
批次 + 交易       153,833 筆/秒     ← 5.4.3 實測，138 倍
```

⚠️ **而且它同時是 04 章 4.7.6 的問題**：每一次 `@Transactional` 都要
從連線池借一條連線、還回去 —— 高併發下連線池會變成瓶頸。

✅ **正確的形狀**：

```java
@Transactional
public void saveAll(List<Order> orders) {     // 一個交易
    jdbcTemplate.batchUpdate(SQL, orders, 1000, (ps, o) -> bind(ps, o));
}
```

### 5.11.6 沒有 `LIMIT` 的查詢

```java
// 🔴 今天回 100 列，明年回 100 萬列
List<Order> orders = jdbc.query("SELECT * FROM ord WHERE customer_id=?", mapper, id);
```

📌 **任何「回傳列表」的查詢都應該有上限。**

```java
// ✅ 明確的上限 + 告訴呼叫者被截斷了
List<Order> orders = jdbc.query(
    "SELECT * FROM ord WHERE customer_id=? ORDER BY placed_at DESC LIMIT 201", mapper, id);
boolean truncated = orders.size() > 200;
if (truncated) orders = orders.subList(0, 200);
```

⚠️ **`LIMIT 201` 這個小技巧**：多撈一列就知道「還有沒有下一頁」，
不用另外跑一次 `COUNT(*)`（那要掃全表）。

**還可以加一道全域防線**：

```properties
# 任何 SELECT 超過 3 秒就被 MySQL 砍掉（5.10.2）
spring.datasource.hikari.connection-init-sql=SET SESSION max_execution_time=3000, innodb_lock_wait_timeout=5
```

### 5.11.7 `COUNT(*)` vs `COUNT(1)` vs `COUNT(欄位)`

順便破除一個流傳很廣的說法。

```
SELECT COUNT(*)      FROM ord     72 ms
SELECT COUNT(1)      FROM ord     70 ms
SELECT COUNT(id)     FROM ord     79 ms
SELECT COUNT(remark) FROM ord    119 ms      ← 🔴 慢 1.7 倍
```

📌 **`COUNT(*)`、`COUNT(1)`、`COUNT(主鍵)` 完全一樣快**（誤差在雜訊內）——
「`COUNT(1)` 比 `COUNT(*)` 快」是假的，優化器對它們的處理是一樣的。

⚠️ **但 `COUNT(欄位)` 不一樣**：

```
COUNT(*)      →  數列數，可以走【最小的索引】
COUNT(remark) →  🔴 要排除 NULL，而 remark 不在任何索引裡 → 必須回表讀每一列
```

📌 **`COUNT(欄位)` 和 `COUNT(*)` 語意也不同**（前者不算 `NULL`）——
**先確定你要的是哪一個，再談效能。**


### 5.11.8 JSON 欄位：碰一下就多 58 倍的頁面請求 ★（回答 01 章）

01 章 1.12 留了一個問題：

> **`outbox_message` 的 `payload JSON` 會不會讓那張表變成掃描地獄？**

**實驗**：`outbox` 表 196,940 列，`payload JSON` 平均 155 bytes
（每筆 5 個鍵、含一個 2 元素陣列），資料 48.6 MB + 索引 4.5 MB。

```
查詢                                          耗時      邏輯讀      對照
a 一般欄位過濾（不碰 payload）               20.7 ms     3,479      基準
b 碰 payload 但不解析 LENGTH(payload)      125.8 ms   203,073     🔴 58 倍
c 解析 JSON  payload->>'$.customerId'       57.2 ms   203,073     🔴 58 倍
d 解析 JSON  JSON_EXTRACT(payload, ...)     52.0 ms   203,073     🔴 58 倍
```

📌 **關鍵在「邏輯讀」那一欄**：

```
不碰 payload  →   3,479 次頁面請求  ≈ 這張表的【頁面數】
碰了 payload  → 203,073 次頁面請求  ≈ 這張表的【列數】（196,940）
```

> **只要 `SELECT` 或 `WHERE` 碰到那個 JSON 欄位，
> 頁面請求就從「每頁一次」變成「每列一次」。**

⚠️ **注意 b 這一組**：`LENGTH(payload)` **完全沒有解析 JSON**，
卻是最慢的（125.8 ms）—— 因為 `LENGTH()` 會把二進位 JSON **序列化成文字**再算長度。
`->>` 和 `JSON_EXTRACT` 反而快一倍，它們直接在二進位格式上尋址。

📌 **所以「JSON 慢」不是慢在解析，是慢在【取值】。**

**✅ 正解：生成欄位 + 索引**

```sql
ALTER TABLE outbox
  ADD COLUMN cust_id INT GENERATED ALWAYS AS (payload->>'$.customerId') VIRTUAL,
  ADD INDEX k_cust (cust_id);
```

```
f 用生成欄位  WHERE cust_id = 42                   0.5 ms        16 邏輯讀   ← 🔥
g 用原寫法    WHERE payload->>'$.customerId'='42'  58.2 ms   203,073 邏輯讀
```

🔴 **注意 g：索引建好了，但用原本的 JSON 寫法【完全用不到它】**
（`EXPLAIN` 的 `possible_keys` 是 `NULL`）。

⚠️ **這一點和 03 章 3.7.1 的函式索引【不一樣】**：

```
03 章 H12：建了 KEY ((CAST(placed_at AS DATE)))
           → 寫 DATE(placed_at) = ? 【也用得到】（MySQL 認得兩者同義）

本章：     建了 GENERATED ... AS (payload->>'$.customerId') + 索引
           → 🔴 寫 payload->>'$.customerId' = ? 【用不到】
              必須把查詢改寫成 WHERE cust_id = ?
```

📌 **虛擬生成欄位是 `VIRTUAL` 的（不佔資料空間），
但它的索引是實體存在的** —— 你付的是索引的寫入成本，不是欄位的儲存成本。

**`outbox` 這張表的正確設計**（11 章會完整處理）：

```sql
CREATE TABLE outbox_message (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  aggregate_type VARCHAR(32) NOT NULL,
  aggregate_id   BINARY(16)  NOT NULL,     -- ✅ 拉成獨立欄位，不要埋在 JSON 裡
  event_type     VARCHAR(32) NOT NULL,     -- ✅ 同上
  status         VARCHAR(16) NOT NULL,
  payload        JSON        NOT NULL,     -- 只放「投遞時才需要」的內容
  created_at     DATETIME(3) NOT NULL,
  KEY k_pending (status, id)               -- ✅ worker 只掃這個索引
) ENGINE=InnoDB;
```

```sql
-- ✅ worker 的查詢：完全走覆蓋索引，不碰 payload（實測 1.4 ms / 11 次邏輯讀）
SELECT id FROM outbox_message
 WHERE status = 'PENDING' ORDER BY id LIMIT 100
   FOR UPDATE SKIP LOCKED;                          -- 04 章 4.5.13

-- 拿到 id 之後才去讀 payload（只有 100 列，實測 0.9 ms）
SELECT id, payload FROM outbox_message WHERE id IN (...);
```

📌 **三條規則**：

```
① 任何會出現在 WHERE / ORDER BY / GROUP BY 的欄位，
   🔴 不要埋在 JSON 裡 —— 拉出來當一般欄位
② 真的要查 JSON 內部 → 生成欄位 + 索引，
   而且【查詢也要改寫成用那個生成欄位】
③ 掃描型的查詢（worker 撈任務、報表）→ 讓它走覆蓋索引，
   🔴 不要 SELECT payload
```

---

## 5.12 shop-service 的效能基線與排查 SOP

### 5.12.1 先建立基線，再談優化

⚠️ **沒有基線的優化是猜測。** 上線前要留下這五個數字：

```sql
-- ① 每張表的大小與熱資料集估算（5.2.5）
SET SESSION information_schema_stats_expiry = 0;
SELECT TABLE_NAME, TABLE_ROWS,
       ROUND((DATA_LENGTH + INDEX_LENGTH)/1024/1024, 1) AS total_mb
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
ORDER BY DATA_LENGTH + INDEX_LENGTH DESC;

-- ② buffer pool 命中率（連續取兩次相減，5.2.2）
-- ③ 每一種查詢的成本排行（5.3.6）
-- ④ 磁碟暫存表比率（5.7.3）
-- ⑤ 連線數與飽和點（5.10.1）
```

**一份基線文件應該長這樣**：

```
【shop-service 效能基線】2026-09-03

資料規模
  orders       100 萬列   136.8 MB + 195.7 MB 索引 = 332.5 MB
  order_item   200 萬列   255.9 MB + 222.7 MB 索引 = 478.6 MB
  customer      2 萬列      2.5 MB +   4.5 MB       =   7.0 MB
  合計 818 MB，年成長率估計 3 倍

熱資料集估算
  orders   最近 90 天 ≈ 332.5 × (90/365) = 82 MB
  order_item 最近 90 天 ≈ 118 MB
  customer 全部 ≈ 7 MB
  → 熱資料集 ≈ 207 MB
  → buffer pool 至少要 256 MB，建議 512 MB（留成長空間）

查詢成本排行（尖峰 1 小時）
  1. SELECT ord ... WHERE customer_id=? ORDER BY placed_at DESC LIMIT 20   62.1%
  2. SELECT ord ... 報表                                                    25.9%
  3. SELECT product WHERE id=?                                               5.6%

守門線
  P99 查詢延遲          < 50 ms
  buffer pool 命中率    > 99%
  磁碟暫存表比率        < 1%
  慢查詢（> 0.5 秒）    < 10 筆/小時
  最長交易              < 5 秒
```

### 5.12.2 排查 SOP：從「變慢了」到「找到那一句」

```
【第 0 步】先確認「是資料庫慢」還是「別的東西慢」
    ├─ 應用的 P99 高，但 DB 的 P99 正常  →  不是 DB（GC？外部 API？）
    ├─ CannotCreateTransactionException  →  連線池耗盡（04 章 4.7.6）
    └─ CommunicationsException           →  連線被關（5.10.2 的 max_lifetime）

【第 1 步】現在正在發生什麼（30 秒內）
    SHOW PROCESSLIST;                          -- 有沒有一堆同樣的查詢卡住
    SELECT * FROM information_schema.innodb_trx ORDER BY trx_started;   -- 有沒有長交易
    SELECT * FROM performance_schema.data_lock_waits;                   -- 有沒有鎖等待
    ├─ STATE = 'Waiting for table metadata lock'  →  04 章 4.5.4（MDL）
    ├─ trx_query IS NULL 且 age_sec 很大          →  04 章 4.3.9（忘了 commit）
    └─ 一堆相同的 SELECT 在跑                      →  下一步

【第 2 步】哪一種查詢最貴（5 分鐘內）
    TRUNCATE performance_schema.events_statements_summary_by_digest;
    -- 等 1 ～ 5 分鐘
    SELECT ... ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;      -- 5.3.6
    ├─ SUM_NO_INDEX_USED > 0            →  索引問題，跳第 3 步
    ├─ SUM_CREATED_TMP_DISK_TABLES > 0  →  暫存表落地，5.7.3
    ├─ COUNT_STAR 異常大而 AVG 很小      →  N+1，5.11.1
    └─ SUM_ROWS_EXAMINED / SUM_ROWS_SENT 很大  →  索引問題

【第 3 步】那一句到底怎麼跑的
    EXPLAIN <那句 SQL>;                    -- 03 章 3.4：type / key_len / Extra
    EXPLAIN ANALYZE <那句 SQL>;            -- 03 章 3.4.7：實際 vs 估計
    ├─ type = ALL                       →  缺索引
    ├─ key_len 比預期小                  →  複合索引沒吃滿（03 章 3.4.3）
    ├─ Extra 有 Using filesort           →  03 章 3.5.5
    ├─ Extra 有 Using temporary          →  5.7.3
    └─ 估計 vs 實際差很多                →  ANALYZE TABLE / 直方圖（03 章 3.9）

【第 4 步】是不是環境問題（不是 SQL 的錯）
    ├─ buffer pool 命中率掉了            →  5.2.3 / 5.2.6（有人在掃大表？）
    ├─ 連線數逼近上限                    →  5.10.1
    ├─ 剛重啟過                          →  5.2.4（冷啟動，等它暖）
    └─ 從庫延遲                          →  07 章
```

### 5.12.3 一組可以放進 CI 的效能守門測試

延續 03 章 3.10.6（執行計畫）與 04 章 4.8.4（併發）的做法，
這一章的守門測試盯的是**與硬體無關的計數器**。

```java
@SpringBootTest
class PerformanceGateTest {

    @Autowired JdbcTemplate jdbc;

    /** 硬斷言 ①：關鍵查詢的掃描放大倍率 —— 與硬體無關 */
    @Test
    void 首頁訂單列表的掃描放大倍率不得超過 5 倍() {
        jdbc.execute("FLUSH STATUS");
        jdbc.query("SELECT * FROM ord WHERE customer_id=? ORDER BY placed_at DESC LIMIT 20",
                   rs -> {}, 42);
        long examined = handlerReads();        // Handler_read_* 的總和
        assertThat(examined)
            .as("回傳 20 列，掃描不該超過 100 列")
            .isLessThan(100);
    }

    /** 硬斷言 ②：不得產生磁碟暫存表 */
    @Test
    void 報表查詢不得產生磁碟暫存表() {
        jdbc.execute("FLUSH STATUS");
        jdbc.query(REPORT_SQL, rs -> {});
        Long onDisk = jdbc.queryForObject(
            "SELECT VARIABLE_VALUE FROM performance_schema.session_status " +
            "WHERE VARIABLE_NAME='Created_tmp_disk_tables'", Long.class);
        assertThat(onDisk).isZero();
    }

    /** 硬斷言 ③：不得有 N+1 —— 一次業務操作的 SQL 次數上限 */
    @Test
    void 訂單詳情頁最多發出 3 句 SQL() {
        long before = questions();
        orderQueryService.getOrderDetail(orderId);     // 一次完整的業務操作
        assertThat(questions() - before).isLessThanOrEqualTo(3);
    }

    /** 硬斷言 ④：批次匯入必須開啟 rewriteBatchedStatements */
    @Test
    void 資料來源必須開啟批次改寫() {
        String url = ((HikariDataSource) dataSource).getJdbcUrl();
        assertThat(url).contains("rewriteBatchedStatements=true");
    }

    /** 軟斷言：耗時 —— 會隨機器變動，超標【記警告】 */
    @Test
    void 首頁查詢應該在 50 毫秒內() {
        long t = System.nanoTime();
        jdbc.query(HOME_SQL, rs -> {}, 42);
        double ms = (System.nanoTime() - t) / 1e6;
        if (ms > 50) System.out.printf("⚠️ 首頁查詢 %.1f ms，超過基線 50 ms%n", ms);
    }

    private long questions() {
        return jdbc.queryForObject(
            "SELECT VARIABLE_VALUE FROM performance_schema.session_status " +
            "WHERE VARIABLE_NAME='Questions'", Long.class);
    }
    private long handlerReads() {
        return jdbc.queryForObject("""
            SELECT SUM(VARIABLE_VALUE) FROM performance_schema.session_status
             WHERE VARIABLE_NAME IN ('Handler_read_next','Handler_read_rnd_next',
                                     'Handler_read_key','Handler_read_first')
            """, Long.class);
    }
}
```

📌 **硬斷言全部是【計數】，軟斷言才是【時間】。**

```
計數（Handler_read_*、Created_tmp_disk_tables、Questions）
    ✅ 跟你的機器多快無關
    ✅ 跟正式環境【完全一致】
    ✅ 資料量小也測得出來（一句沒走索引的查詢，在 100 列的測試資料上
       Handler_read_rnd_next 一樣是 100，比例一樣錯）

時間（毫秒）
    🔴 跟機器、跟其他測試、跟 CI 機器當下的負載都有關
    🔴 設成硬斷言只會讓大家習慣性 rerun
```

⚠️ **這一節和 03 / 04 章的守門測試合起來，就是「效能不退步」的三道防線**：

```
03 章：執行計畫沒有變爛（type / key_len / Extra）
04 章：併發下結果正確（不超賣、不負數、冪等）
05 章：資源用量沒有變多（掃描列數、暫存表、SQL 次數）
```

---
## 5.13 常見誤區

**誤區 1：「我在本機測過了，很快」**

→ 5.2.3 實測：buffer pool 從 8 MB 到 256 MB，**實體讀取差 1,623 倍，
牆鐘時間只差 1.18 倍**。你的 NVMe SSD + 作業系統檔案快取把問題藏起來了。
**要看的是邏輯讀、實體讀、命中率、掃描列數 —— 這四個跟硬體無關。**

**誤區 2：「buffer pool 命中率 99% 很健康」**

→ 5.2.2：這兩個計數器是**從開機累計**的。跑了三個月的伺服器，命中率永遠是 99.9%。
**要在查詢前後各取一次相減**，才知道**這一句**的命中率。

**誤區 3：「加記憶體就好了」**

→ 5.2.6：一個報表掃過 200 MB 的冷資料，就能把 100 MB 的熱資料整個擠出去。
**buffer pool 再大，也擋不住「有人在同一台機器上跑批次」。**
而 5.2.7：連線的私有緩衝**不在 buffer pool 裡** —— 500 條連線可能另外吃掉 1 GB。

**誤區 4：「慢查詢日誌開了就會抓到問題」**

→ 5.3.1：`long_query_time` 預設 **10 秒**，等於這個功能是關的。
→ 5.3.4：`log_slow_admin_statements` 預設 **OFF**，`ALTER` 卡 1.9 秒**一個字都不會記**。
→ 5.3.6：一句跑 1 萬次、每次 5 ms 的查詢（總共 50 秒）**永遠不會出現在慢查詢日誌裡** ——
而它才是真正的效能殺手。

**誤區 5：「我用了 `PreparedStatement` / `addBatch`，寫入已經很快了」**

→ 5.4.1 實測：逐筆 `Statement` 8,100 筆/秒、逐筆 `PreparedStatement` 8,432 筆/秒、
**`addBatch` 沒開 `rewriteBatchedStatements` 只有 8,607 筆/秒** —— 三者一樣慢。
開了之後 **151,025 筆/秒（17.5 倍）**。
**`rewriteBatchedStatements=true` 不是預設值，你必須自己加。**

**誤區 6：「批次越大越好、交易越大越好」**

→ 5.4.2 實測：批次大小的收益在 **500 就見頂**，之後是雜訊。
→ 5.4.3 實測：交易從 1000 筆放大到 100000 筆**只快 23%**，
而 04 章 4.3.8 的代價是「別人的查詢慢 20 倍」。

**誤區 7：「沒走索引的 JOIN 一定要加索引」**

→ 5.5.2 實測：左表佔 1% 時索引 nested loop 快 **91 倍**，
但佔 **75% 時兩者打平**。報表型的查詢（每次都要處理大半張表）
加索引只是白白拖慢寫入。

**誤區 8：「調大 `join_buffer_size` / `sort_buffer_size` 可以加速」**

→ 5.5.3 實測：`join_buffer_size` 從 64 KB 調到 64 MB，差距 **3%（雜訊）**。
→ 5.7.1 實測：`sort_buffer_size` 讓 `Sort_merge_passes` 從 91 掉到 1（**91 倍**），
**耗時只快 13%**。
⚠️ 而這兩個都是**每條連線、每次操作**各配一份的 —— 調大的風險遠高於收益。

**誤區 9：「`Extra` 沒有 `Using MRR`，我應該去開它」**

→ 5.5.4 實測：強制開啟 MRR 只快 **3%**。
MRR 優化的是「隨機磁碟 I/O」，而你的資料在 buffer pool 裡。
**優化器預設不用它，是對的判斷。**

**誤區 10：「`IN` 裡放幾百個 id 沒關係」**

→ 5.6.1 實測：**199 個值時估計完全精確（誤差 0.0%），200 個值時誤差跳到 18.8%**，
500 個值時 **−22%**。`eq_range_index_dive_limit` 這個門檻預設就是 200。
而 5.6.2：每一種不同長度的 `IN` 都是**一種不同的查詢** —— 你的 digest 表會被灌爆。

**誤區 11：「參數超過 65535 個會報錯」**

→ 5.6.3 實測：70,000 個 `?` **沒有報錯** ——
mysql-connector-j **靜默退回用戶端預備語句**。
**你以為 SQL 只解析一次，實際上每次都在重新解析。**

**誤區 12：「`Sort_merge_passes > 0` 就要調大 `sort_buffer_size`」**

→ 5.7.1：正確的解讀是「**這句查詢在做大量的記憶體外排序**」，
該做的是加一個能消除排序的索引（實測加了之後 `Extra` 變成 `Using index`，
`Sort_rows` 歸零），不是加記憶體。

**誤區 13：「延遲關聯是深分頁的萬用解」**

→ 5.8.1 實測：按**主鍵**排序時只快 **2.1 倍**；
→ 5.8.2 實測：按**二級索引**排序時快 **36.9 倍**。
**延遲關聯優化的是【回表】，不是【掃描】** ——
而 seek 法在兩種情況下都是**常數時間**（快 335 倍）。

**誤區 14：「`DELETE` 之後磁碟就會釋放」**

→ 5.9.2 實測：刪掉 38.6% 的列之後，實體檔案 **348 MB → 348 MB，完全沒變**。
要 `OPTIMIZE TABLE`（重建整張表）才會變成 128 MB。
而 `OPTIMIZE TABLE` 需要**等量的臨時空間**，而且最後會拿 **MDL 排他鎖**（04 章 4.5.4）。

**誤區 15：「分批刪比較慢，因為要跑很多次」**

→ 5.9.1 實測：分批（78 輪）**3777 ms**，一次刪 **9702 ms** —— 分批**快 2.6 倍**。
而且分批真正的價值是「每批只鎖 30 ～ 50 ms，別人可以插隊」。

**誤區 16：「連線池開大一點比較安全」**

→ 5.10.1 實測（8 核心）：QPS 在 **64 連線飽和**，
**256 連線時 QPS 反而下降**，延遲從 0.16 ms 漲到 **8.14 ms（51 倍）**。
**排隊排在連線池裡（可見、可控）遠比排在資料庫裡好。**

**誤區 17：「`queryTimeout` 設了就不會有慢查詢」**

→ 5.10.2：`queryTimeout` 是**用戶端**的逾時，它只是關掉連線 ——
**MySQL 那邊的查詢還在跑**。要真的砍掉，用 `MAX_EXECUTION_TIME` 提示
（實測會回 `ERROR 3024`）。

**誤區 18：「`COUNT(1)` 比 `COUNT(*)` 快」**

→ 5.11.7 實測：`COUNT(*)` 72 ms、`COUNT(1)` 70 ms、`COUNT(id)` 79 ms —— **一樣**。
但 `COUNT(remark)`（不在索引裡的欄位）**119 ms，慢 1.7 倍**，而且**語意也不同**。

**誤區 19：「N+1 在我這裡只慢一點點」**

→ 5.11.1 實測：本機 `localhost` 只慢 **15 倍（135 ms vs 9 ms）**。
但成本是「每次往返 × N」，**跨區域部署時同一段程式碼要 15 秒**。
**N+1 是「本機量不到」的最典型例子。**

**誤區 20：「效能測試要測時間」**

→ 5.12.3：時間跟機器、跟 CI 當下的負載都有關，設成硬斷言只會讓大家習慣性 rerun。
**要斷言的是計數**（`Handler_read_*`、`Created_tmp_disk_tables`、`Questions`）——
它們跟硬體無關，而且**在 100 列的測試資料上就測得出比例是錯的**。

---

## 5.14 本章練習

### 練習 1：量出你自己專案的「本機謊言」

拿你專案裡最重要的三句查詢，在**同一台機器**上跑兩次：

```sql
-- 準備：把 buffer pool 調到很小
SET GLOBAL innodb_buffer_pool_size = 8 * 1024 * 1024;
```

每一句都記錄四個數字（5.2.2 的方法：前後各取一次相減）：

```
耗時 / 邏輯讀 / 實體讀 / 命中率
```

然後調回正常大小再跑一次，填完這張表：

| 查詢 | 8 MB 耗時 | 8 MB 命中率 | 256 MB 耗時 | 256 MB 命中率 | 耗時差 | 實體讀差 |
|---|---|---|---|---|---|---|
| | | | | | | |

```
問題：哪一句的【耗時差】遠小於【實體讀差】？
      那一句就是「在你機器上量不到問題」的那一句。
```

### 練習 2：找出最貴的查詢形狀

```sql
TRUNCATE performance_schema.events_statements_summary_by_digest;
-- 跑一段真實流量（或壓測）5 分鐘
```

然後用**三種排序**各看一次前 10 名（5.3.6）：

```
ORDER BY SUM_TIMER_WAIT DESC       -- 總耗時
ORDER BY AVG_TIMER_WAIT DESC       -- 平均耗時
ORDER BY SUM_ROWS_EXAMINED DESC    -- 總掃描量
```

```
① 三份名單重疊嗎？
② 有沒有一句「總耗時第一名」但「平均耗時排不上榜」的？
     → 那就是被呼叫太多次的查詢（可能是 N+1，5.11.1）
③ 有沒有 SUM_NO_INDEX_USED > 0 的？
     → 用 5.5.2 的方法判斷它是不是「該用 hash join」的那一類
```

### 練習 3：把批次寫入調快 20 倍

寫一段匯入 10 萬列的程式，依序做這五個改動，每一步都量一次：

```
① 逐筆 executeUpdate + autocommit         → 基準
② 包進一個交易                             → 快幾倍？
③ 改成 addBatch(1000) + executeBatch      → 快幾倍？
④ URL 加上 rewriteBatchedStatements=true  → 快幾倍？
⑤ 批次大小改成 100 / 500 / 5000            → 拐點在哪？
```

⚠️ **第 ③ 步很多人以為會變快，實測不會。先猜再測。**

### 練習 4：找出你專案的 `IN` 有多長 ★

```bash
# 在日誌 / 程式碼裡找出所有動態組出來的 IN
grep -rn "IN (" src/main/java | grep -i "join\|placeholder\|repeat\|collect"
```

對每一個地方回答：

```
① 最壞情況會有幾個值？（不是「通常」，是「最壞」）
② 超過 200 了嗎？（5.6.1 的門檻）
③ 這一句在 digest 表裡有幾種形狀？
     SELECT COUNT(*) FROM performance_schema.events_statements_summary_by_digest
     WHERE DIGEST_TEXT LIKE 'SELECT%FROM `ord`%IN%';
④ 用 5.6.4 的哪一種改寫最合適？
```

### 練習 5：重現「刪了資料但磁碟沒變小」★

```sql
-- ① 建一張 100 萬列的表，記下實體檔案大小
-- ② 刪掉一半，再記一次       → 沒變
-- ③ OPTIMIZE TABLE，再記一次 → 變小了
```

```bash
docker exec <container> ls -l /var/lib/mysql/<db>/<table>.ibd
```

然後回答：

```
① OPTIMIZE 跑了多久？如果這張表是 100 GB，要跑多久？
② OPTIMIZE 進行中，另一個 session 可以 SELECT 嗎？可以 INSERT 嗎？
③ 🔴 如果這時候有一個開了 10 分鐘的交易沒 commit，OPTIMIZE 會怎樣？
     （提示：04 章 4.5.4）
④ 有哪一種 schema 設計可以讓「刪除舊資料」變成瞬間完成？
```

### 練習 6：畫出你自己機器的連線數曲線 ★

用 5.10.1 的方法，在你的機器上跑 1 / 2 / 4 / 8 / 16 / 32 / 64 / 128 / 256 連線，
畫出 QPS 與延遲兩條線。

```
① 你的 QPS 拐點在哪？跟核心數的關係是什麼？
② QPS 開始【下降】是在幾條連線？
③ 把查詢換成「要回表的」再畫一次 —— 曲線的形狀變了嗎？
④ 把 buffer pool 調小再畫一次 —— 拐點往哪邊移動？
```

📌 **這一題的目的是讓你知道：連線池大小不是抄來的，是量出來的。**

---

## 5.15 完成本章後，請確認你有

```
✅ 一份效能基線文件（5.12.1）
     ├─ 每張表的大小 + 年成長率估計
     ├─ ★ 熱資料集估算，以及它和 buffer pool 的比值
     ├─ 尖峰時段的查詢成本排行（前 10 名 + 各佔幾 %）
     └─ 五條守門線（P99 延遲 / 命中率 / 磁碟暫存表比率 / 慢查詢數 / 最長交易）

✅ 慢查詢日誌是【真的開著】的
     ├─ long_query_time = 0.3 ~ 0.5（不是預設的 10）
     ├─ log_slow_extra = ON
     ├─ ★ log_slow_admin_statements = ON（預設 OFF，DDL 不會被記）
     ├─ log_queries_not_using_indexes = OFF（或配 min_examined_row_limit）
     └─ 寫進 my.cnf，不是只用 SET GLOBAL

✅ 一個「找最貴查詢」的例行動作（5.3.6）
     ├─ 每週看一次 digest 表的前 10 名（三種排序各一次）
     ├─ SUM_NO_INDEX_USED > 0 的清單
     ├─ SUM_CREATED_TMP_DISK_TABLES > 0 的清單
     └─ COUNT_STAR 異常高的清單（N+1 的訊號）

✅ JDBC / 連線池的設定檢查
     ├─ ★ rewriteBatchedStatements=true（不是預設值！）
     ├─ connectTimeout / socketTimeout 有設
     ├─ hikari.connection-timeout = 3000
     ├─ hikari.max-lifetime < MySQL 的 wait_timeout
     ├─ hikari.maximum-pool-size ≈ 核心數 × 2（量出來的，不是抄的）
     └─ connection-init-sql 設好 innodb_lock_wait_timeout 與 max_execution_time

✅ 七層逾時由外而內遞減（5.10.2）
     瀏覽器 > 閘道 > 應用 > socketTimeout > queryTimeout > 鎖等待

✅ 批次作業的規格
     ├─ batchSize = 500 ~ 1000
     ├─ 每 500 ~ 5000 筆 commit 一次
     ├─ ★ 分批 DELETE / UPDATE 要有 ORDER BY（而且那個欄位要有索引）
     ├─ 每批之間 sleep，且有「跑不完就下次繼續」的出口
     └─ 大表的空間回收計畫（分區 DROP > gh-ost > OPTIMIZE）

✅ 一組效能守門測試（5.12.3）
     ├─ 硬斷言：Handler_read_* 的掃描放大倍率
     ├─ 硬斷言：Created_tmp_disk_tables = 0
     ├─ 硬斷言：一次業務操作的 SQL 次數（抓 N+1）
     ├─ 硬斷言：URL 含 rewriteBatchedStatements=true
     └─ 🔴 時間只能是【軟斷言】

✅ 一份排查 SOP（5.12.2）
     ├─ 第 0 步：先確認是不是 DB 的問題
     ├─ 第 1 步：processlist / innodb_trx / data_lock_waits
     ├─ 第 2 步：digest 表找最貴的形狀
     ├─ 第 3 步：EXPLAIN / EXPLAIN ANALYZE
     └─ 第 4 步：環境問題（命中率 / 連線數 / 冷啟動 / 從庫延遲）

✅ 你能回答這十個問題（不查資料）
     ├─ 為什麼「本機測起來很快」沒有意義？該看哪四個數字？
     ├─ 怎麼估一張表的熱資料集？
     ├─ 一句跑一萬次、每次 5 ms 的查詢，會出現在慢查詢日誌裡嗎？
     ├─ addBatch 沒開 rewriteBatchedStatements 會發生什麼事？
     ├─ hash join 和索引 nested loop 的交叉點大概在哪？
     ├─ IN 裡放 200 個值和 199 個值，差別是什麼？
     ├─ 延遲關聯什麼時候快 2 倍、什麼時候快 37 倍？
     ├─ DELETE 之後磁碟為什麼沒變小？怎麼變小？代價是什麼？
     ├─ 連線池開到 256 條會發生什麼事？
     └─ 效能守門測試該斷言時間還是計數？為什麼？
```

---

## 5.16 本章的實驗環境與結果

**環境**：

| 項目 | 版本 / 規模 |
|---|---|
| 資料庫 | **MySQL 8.0.46**（Docker），`innodb_buffer_pool_chunk_size = 8M`、`instances = 1`（**才能把 pool 調到 8 MB**） |
| 慢查詢 | `slow_query_log = ON`、`long_query_time = 0.05 ~ 0.5`、`log_slow_extra = ON` |
| 實驗表 `ord` | **100 萬列**，資料 **76.6 MB** + 索引 **117.3 MB** = 193.9 MB；狀態偏斜（`DELIVERED` 74.99% / `REFUNDED` 1.02%），20% 訂單集中在前 100 個客戶 |
| 對照表 | `customer` 2 萬列（有主鍵）、`cust_noidx` 2 萬列（**完全沒有索引**）、`del_t` 100 萬列、`big_junk` |
| 應用程式 | **JDK 21**、mysql-connector-j **8.3.0** |
| 平台 | macOS 14.2.1 / Apple Silicon，8 核心，**NVMe SSD** |

⚠️ **「NVMe SSD」是本章多個實測的關鍵限制** ——
它讓「實體讀取」的成本被作業系統的檔案快取隱藏起來。
**本章凡是「時間差距遠小於計數差距」的地方，都是這個原因，我會明確標出來。**

**跑過的實驗（39 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **B1** | buffer pool 8→256 MB：三種查詢 | ✅ 回表查詢 8 MB **20.8 ms** → 32 MB **3.4 ms（6.1 倍）**；覆蓋索引查詢**幾乎不受影響**（1.1～1.6 ms） |
| **B2** | 隨機點查詢 × buffer pool ★★ | 🔴 回表：命中率 **82.68% → 99.98%**，實體讀 **95,765 → 59（1,623 倍）**<br>🔴 **但耗時只從 1546 → 1310 ms（1.18 倍）** —— SSD 把問題藏起來了<br>✅ 覆蓋索引：8 MB 時 4917 QPS、256 MB 時 5339 QPS（只差 8.6%） |
| **B3** | 邏輯讀放大 | 🔴 覆蓋索引 **22,562** vs 回表 **371,676** —— **16.5 倍**，與硬體無關 |
| **B4** | 冷啟動 | ✅ 點查詢（覆蓋）**4.5 倍**、點查詢（回表）**5.7 倍**、範圍掃描 1.3 倍、全表掃描 **1.1 倍** |
| **B5** | buffer pool 頁面歸屬 | ✅ `INNODB_BUFFER_PAGE`：`ord.PRIMARY` 3972 頁（62.1 MB）、`idx_cust_placed` 2100 頁（32.8 MB） |
| **S1** | `log_slow_extra` 的欄位 | ✅ 20 個欄位，關鍵四個：`Lock_time` / `Rows_examined` / `Read_rnd_next` / `Created_tmp_disk_tables` |
| **S2** | 鎖等待在慢日誌 ★（回答 04 章） | ✅ `Query_time: 1.926924` / **`Lock_time: 1.920609`（99.7%）** / `Rows_examined: 1`<br>📌 MySQL **8.0.28 起** `Lock_time` 才包含行鎖等待 |
| **S3** | `log_slow_admin_statements` | 🔴 預設 OFF 時，卡了 1.9 秒的 `ALTER TABLE` **完全沒被記錄**；打開後才出現 |
| **S4** | `log_queries_not_using_indexes` | 🔴 它**不看 `long_query_time`**；實測只有 20,000 列的全表掃描被記，2 列的小表沒被記 |
| **S5** | digest 表 | ✅ 一句話找出總耗時排行；`SUM_NO_INDEX_USED` / `SUM_CREATED_TMP_DISK_TABLES` 直接指出問題<br>📌 `performance_schema_digests_size` 實測 **10000** |
| **W1** | 批次寫入五種寫法 ★★ | 🔴 逐筆 `Statement` 8,100 / 逐筆 `PreparedStatement` 8,432 / **`addBatch` 未開改寫 8,607** —— 三者一樣慢<br>✅ 開改寫 **151,025（17.5 倍）**；手寫多值 `INSERT` **194,850（22.6 倍）** |
| **W2** | 批次大小掃描 | ✅ 1 → 4,427；**500 → 148,762（拐點）**；5000 → 156,971；100000 → 140,599（**開始下降**） |
| **W3** | 交易邊界 | 🔴 autocommit 逐筆 **1,113 筆/秒**；一個交易包 10 萬筆 153,833（**138 倍**）<br>✅ 但 1000 筆 commit 一次 vs 100000 筆 commit 一次**只差 23%** |
| **W4** | `max_allowed_packet` | 🔴 調成 4 MB 後送 6 MB 的 `INSERT` → `Packet for query is too large (6,058,923 > 4,194,304)`，**`errorCode = 0`（用戶端擋的，伺服器沒紀錄）** |
| **J1** | hash join vs 無索引 nested loop | 🔴 同一句：hash join **19 ms** vs 強制 nested loop **32,764 ms（1,682 倍）** |
| **J2** | 交叉點 ★★ | ✅ 左表 1% → 索引 NL 快 **91.37 倍**；2% → 47.09；5% → 19.77；8% → 11.93；**75% → 1.00 倍（打平）**<br>📌 hash join 幾乎是常數（1509～1580 ms），索引 NL 是線性（17→1588 ms） |
| **J3** | `join_buffer_size` | 🔴 64 KB → 64 MB（**1000 倍**），耗時 1586 → 1591 ms（**雜訊**） |
| **J4** | MRR ★（回答 03 章） | 🔴 `mrr=off` 99 ms / 預設 99 ms / **強制開啟 96 ms（3%）**<br>📌 資料在 buffer pool 裡時，MRR 沒有東西可以優化 |
| **I1** | `eq_range_index_dive_limit` ★★ | ✅ 10/50/100/**199** 個值 → 估計誤差 **0.0%**<br>🔴 **200 個值 → 誤差 18.8%**；500 → **−22.0%**；1000 → −21.7%<br>📌 200 之後的 `rows` = 值的個數 × **47**（平均值，完全忽略分布） |
| **I2** | `IN` 長度的耗時 | ✅ 10 個 1 ms / 1000 個 9 ms / 10000 個 71 ms（大致線性）<br>🔴 但每一種長度都是**一種不同的 digest** |
| **I3** | 佔位符上限 | 🔴 60000 / 65535 / **65536 / 70000 全部成功、沒有錯誤** —— 驅動**靜默退回**用戶端預備語句 |
| **T1** | `sort_buffer_size` | ✅ 64 KB → 16 MB：`Sort_merge_passes` **91 → 1（91 倍）**<br>🔴 **耗時 474 → 403 ms（只快 13%）** |
| **T2** | 優先佇列 | ✅ `LIMIT 20` → `Sort_rows = 20`（不是 100 萬）；`LIMIT 100000` → `Sort_rows = 100,000` + 24 次歸併 |
| **T3** | 暫存表落地 ★（回答 01 章） | ✅ `tmp_table_size` **4 MB → 2 個磁碟暫存表 / 2459 ms**；16～64 MB → 1 個；**128 MB → 0 個 / 416 ms（5.9 倍）**<br>🔴 `temptable_max_ram`（1→64 MB）**沒有影響** —— 決定落地的是 `tmp_table_size` |
| **T4** | 索引消除排序 | ✅ 加 `INDEX (total_amount)` 後 `Extra: Using index`，`Sort_rows = 0`、`Sort_merge_passes = 0` |
| **P1** | 深分頁（主鍵排序） | 🔴 `LIMIT 900000,20` **167.6 ms**；延遲關聯 79.0 ms（**只快 2.1 倍**）<br>✅ seek 法 **0.5 ms（335 倍）**，且**與 OFFSET 無關** |
| **P2** | 深分頁（二級索引排序）★ | 🔴 `ORDER BY placed_at LIMIT 100000,20` **342.9 ms**<br>✅ 延遲關聯 **9.3 ms（36.9 倍）** —— 同一個技巧，效果差 17 倍 |
| **P3** | JDBC fetch 模式 | ✅ 預設 520 ms / **堆積 185.1 MB**；`useCursorFetch` 900 ms / 28.7 MB；**串流 241 ms / 47.1 MB（最快且省記憶體）** |
| **D1** | 分批 DELETE ★ | 🔴 一句刪 385,919 列 **9702 ms**；分批 5000×78 輪 **3777 ms（快 2.6 倍）**<br>🟡 但分批的最大 `history_len` 是 **103**（一次刪只有 14） |
| **D2** | 刪除後的空間 ★ | 🔴 建好 348.0 MB → 刪掉 38.6% → **348.0 MB（完全沒變）**<br>✅ `OPTIMIZE TABLE`（3.2 秒）→ **128.0 MB**；訊息是 `doing recreate + analyze instead` |
| **C1** | 連線數 vs 吞吐量 ★★ | ✅ 1→8 連線 QPS **6,289 → 24,406**（近線性），延遲 0.16 → 0.33 ms<br>🟡 8→64 QPS 只 +35%，延遲 **×5.9**<br>🔴 **256 連線 QPS 下降**（33,943 → 31,436），延遲 **8.14 ms（51 倍）** |
| **A1** | `SELECT *` | ✅ `SELECT *` 4.2 ms / `SELECT id, total_amount` 2.7 ms / `COUNT(*)`（覆蓋）**0.5 ms（8.4 倍）** |
| **A2** | 存在性判斷 ★ | 🔴 `COUNT(*)` **95.0 ms** vs `EXISTS` **0.5 ms（190 倍）** |
| **A3** | Java 端過濾 | 🔴 撈 100 萬列回來自己 filter **380 ms** vs `WHERE` **4 ms（95 倍）** |
| **A4** | `COUNT` 的變體 | ✅ `COUNT(*)` 72 / `COUNT(1)` 70 / `COUNT(id)` 79 ms —— **一樣**<br>🔴 `COUNT(remark)`（不在索引裡）**119 ms（1.7 倍）** |
| **X1** | buffer pool 不足 × 缺索引 ★★（回答 04 章） | 🔴 300,000 列的表、8 執行緒：有索引 **1,498～3,614 TPS**，無索引 **8～12 TPS**<br>🔴 差距 **187 ～ 350 倍**（04 章在 20,000 列的表上只有 10.8 倍）<br>📌 有索引那一欄在 8 MB 時也掉 2.4 倍，無索引掉的是**整個數量級** |
| **X2** | 寫入熱點的連線數曲線 ★（回答 04 章） | 🔴 所有執行緒搶同一列：TPS 從 8 連線起**飽和在 ≈ 1,000**，256 連線仍是 1,296<br>📌 對照唯讀的 33,022 QPS —— **熱點寫入的上限 = 1 / 持鎖時間，與連線數無關** |
| **X3** | JSON 欄位的掃描成本 ★（回答 01 章） | 🔴 不碰 `payload` **3,479 邏輯讀**；碰了 → **203,073（58 倍）** ≈ 列數<br>🔴 `LENGTH(payload)` **125.8 ms** 比 `->>'$.x'` 的 57.2 ms **還慢一倍**（序列化成文字）<br>✅ 生成欄位 + 索引：**0.5 ms / 16 邏輯讀**<br>🔴 **但索引建好後，用原本的 JSON 寫法完全用不到它**（`possible_keys` 為 `NULL`）—— 與 03 章 H12 的函式索引不同 |
| **N1** | N+1 ★ | 🔴 500 次查詢 **135 ms** vs 一次 `IN + GROUP BY` **9 ms（15 倍）**<br>📌 每次只有 0.27 ms —— 成本全在往返，跨區域會變成 15 秒 |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一章會補 |
|---|---|---|
| **真正慢的磁碟**（機械硬碟 / 雲端網路磁碟）上的實體讀成本 | 5.2、5.5.4 | —（本章用計數器代替，並明確標示） |
| **跨機房 / 跨可用區的網路延遲**對 N+1 的放大 | 5.11.1 | 07 章 |
| **千萬～億列規模**的行為（本章 100 萬列） | 全章 | — |
| **UUIDv7 主鍵在千萬列規模的表現** | 5.2.5 | —（01 章 1.8.3 已在 300 萬列量過） |
| **`LOAD DATA` 的實測數字** | 5.4.4 | — |
| **分區表**的 `DROP PARTITION` 與查詢裁剪 | 5.9.2 | 06 章 |
| **`gh-ost` / `pt-online-schema-change`** | 5.9.2 | 06 章 6.7 |
| **從庫延遲**與讀寫分離對效能的影響 | 5.10、5.12.2 | 07 章 |
| **ORM 造成的 N+1** 與它的修法 | 5.11.1 | 08 章 |
| **Redis 快取**對熱資料集的卸載 | 5.2.5 | 10 章 |
| **`performance_schema` 本身的開銷** | 5.3.6 | — |

> 📌 **最後一句話**：
>
> 這一章有**五個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「調參數可以救效能」** ——
> J3 顯示 `join_buffer_size` 調大 1000 倍只差 3%；
> T1 顯示 `sort_buffer_size` 讓歸併次數少 91 倍、時間只快 13%；
> J4 顯示強制開 MRR 只快 3%。
> **唯一有大效果的是 T3 的 `tmp_table_size`（5.9 倍）——
> 因為它改變的是【演算法】，不是【快取大小】。**
>
> **②「沒走索引就要加索引」** ——
> J2 顯示左表佔 75% 時，hash join 已經追平索引 nested loop。
> **報表型的查詢加索引，只是白白拖慢寫入。**
> 而同一張表在 1% 選擇率下，索引快 91 倍 ——
> **「要不要索引」的答案是一條曲線，不是一個是非題。**
>
> **③「我用了 `addBatch`，寫入已經批次化了」** ——
> W1 顯示沒開 `rewriteBatchedStatements` 的 `addBatch`，
> 吞吐量跟**逐筆 `Statement` 一模一樣**（8,607 vs 8,100 筆/秒）。
> **驅動只是幫你在迴圈裡一句一句送。**
>
> **④「199 和 200 沒有差別」** ——
> I1 顯示 `IN` 放 199 個值時估計**完全精確**，
> 放 200 個值時誤差**跳到 18.8%**。
> **這是一個沒有任何警告、沒有任何日誌的懸崖。**
>
> **⑤「在我機器上測起來很快」** ——
> B2 顯示實體讀取差 1,623 倍時，牆鐘時間只差 1.18 倍。
> N1 顯示 N+1 在 `localhost` 只慢 15 倍。
> **你的 SSD 和你的 localhost，是這一章最大的敵人。**
>
> ⚠️ **這五個有一個共同點**：
>
> > **它們都不是「我不會寫 SQL」的問題，是「我量錯了東西」的問題。**
> > 前四章的錯，你至少有辦法在本機重現。
> > 這一章的錯，只有在你**停止量時間、開始量計數**之後才看得見。
>
> **所以本章唯一的方法論是這句話**：
>
> > **量掃描的列數，不要量毫秒。
> > 量邏輯讀與命中率，不要量吞吐量。
> > 量 SQL 發了幾次，不要量頁面載入了多久。**
> > **這些數字在你的筆電上和在正式環境裡，是同一個數字。**
>
> **下一章開始講 schema 的版本控管。** 06 章會回答本章欠的兩筆帳：
> **「`OPTIMIZE TABLE` 要鎖住整張表幾分鐘，那正式環境要怎麼改 schema？」**
> 以及 04 章 4.5.4 那個沒說完的故事：
> **「一個 `ALTER TABLE` 卡住全站的時候，`gh-ost` 到底做了什麼不一樣的事？」**

---

**上一章**：[04-transaction-isolation-and-lock.md](./04-transaction-isolation-and-lock.md) — 交易、隔離與鎖
**下一章**：[06-schema-migration-flyway.md](./06-schema-migration-flyway.md) — Schema 版本控管
