# 第 07 章：備份、複製與上線維運

> 06 章結尾留了兩個問題：
>
> > **06 章 6.5.1 那句 `Please restore backups and roll back database and code!` ——
> > 你的備份真的還原得回來嗎？**
> > **6.7.7 的 `pt-osc --max-lag 2` ——「從庫延遲」到底是什麼？**
>
> 這一章要回答它們。而在回答之前，先看兩組數字。
>
> ---
>
> **第一組：一次「成功」的備份。**
>
> ```
> mysqldump --single-transaction shop ord > backup.sql
>
> 3,000,200 列（資料 195.7 MB + 索引 231.6 MB）
>
>   備份    1,615 ms      檔案 194 MB
>   gzip    2,521 ms      檔案  25 MB
>   🔴 還原  26,921 ms
> ```
>
> 🔴 **備份 1.6 秒，還原 27 秒 —— 慢 16.7 倍。**
>
> 而這是 300 萬列。正式環境的 3 億列會是**多久**？
> 如果你的災難復原計畫寫著「每天備份一次」，
> 那份文件其實**沒有回答任何問題** ——
> 因為「備份要多久」跟「出事之後多久才能開門營業」是兩個不同的數字，
> 而後者才是你老闆在問的那一個。
>
> ---
>
> **第二組：一個非常平凡的讀寫分離。**
>
> 一主一從，同一台機器上的兩個容器（網路延遲接近零）。
> 從庫延遲的量測值是 **1 毫秒**。
> 然後做 200 次「寫主庫，然後立刻讀從庫」—— 就像「下單成功後跳轉到訂單頁」：
>
> ```
> 寫主庫後立刻讀從庫 200 次：
>   ✅ 讀到了      0 次（0.0%）
>   🔴 讀不到    200 次（100.0%）
>   讀不到的那些：平均 1 ms 後出現，最久 12 ms
> ```
>
> 🔴 **100%。不是「偶爾」，不是「高併發時」——  是每一次。**
>
> **為什麼？** 因為「1 毫秒的延遲」和「讀取發生在寫入後的 0 毫秒」放在一起，
> 結果就是 100% 失敗。
> **延遲很小不代表機率很低 —— 它只代表【視窗很短】，而你的讀取就在那個視窗裡。**
>
> ---
>
> ⚠️ **這一章與前六章有一個關鍵差別**：
>
> ```
> 01 ~ 03 章的錯 → 寫錯了      → 改對就好
> 04 章的錯      → 併發才錯    → 加鎖就好
> 05 章的錯      → 量錯了      → 改量計數就好
> 06 章的錯      → 已經發生了  → 資料庫的狀態改不回去
> 07 章的錯      → 【你以為你有準備】
> ```
>
> 這一章的每一個主題，都有一個「以為有、其實沒有」的版本：
>
> ```
> 以為有備份    → 實測：一句併發的 DDL 讓 mysqldump 中止，
>                 而它留下一個【194 MB、看起來很完整】的檔案（7.2.4）
> 以為從庫唯讀  → 實測：read_only = 1 的從庫，root 的 INSERT 【成功了】（7.3.7）
> 以為延遲是 0  → 實測：主庫的大交易還沒提交時，
>                 Seconds_Behind_Source 讀到 0，提交後才跳到 12（7.3.5）
> 以為 binlog 有記 → 實測：binlog_format = STATEMENT 時主從資料【真的分岔】（7.3.1）
> ```
>
> 📌 **所以這一章的主軸不是「怎麼設定」，而是**：
>
> > **怎麼證明你的準備是有效的。**
>
> 而「證明」只有一種方法：**真的做一次**。
> 真的還原一次備份、真的切換一次主從、真的殺掉一台機器。
> **沒有演練過的災難復原計畫，跟沒有計畫的差別只在於「你比較晚才知道」。**

---

## 7.1 學習目標

完成本章後，你應該可以：

- 用實測說明「備份時間」與「還原時間」是**兩個數字**（實測 1,615 ms vs **26,921 ms，16.7 倍**），
  並算出你自己專案的 **RTO**。
- 說出 `mysqldump` **四種鎖模式**的差別，並用實測證明只有 `--single-transaction`
  同時做到「一致」與「不擋寫入」（實測：預設模式讓線上寫入停頓 **994 ms**，
  `--skip-lock-tables` 的備份**還原後帳目差 1,500 元**）。
- 🔴 說明 `--single-transaction` **擋不住 DDL**（實測 `Error in field count for table` 中止），
  以及它為什麼會留下一個**看起來很完整的壞檔案**。
- 寫出一個**會檢查自己有沒有成功**的備份腳本（六個檢查）。
- 用 `mysqlbinlog` 做 **PITR**，並且只**跳過那一個誤刪的交易**
  （實測 `--exclude-gtids`：6 列全部救回，`DELETE` 沒有被重放）。
- 說出 MySQL 官方 Docker 映像**沒有 `mysqlbinlog`**，以及三種替代做法。
- 用實測說明 `binlog_format = STATEMENT` 為什麼**必須禁用**
  （實測：同一句 `UPDATE t SET v = UUID()` 讓主從的資料 MD5 **不一樣**）。
- 從零建起一組 **GTID 複製**（可以照著貼的完整指令）。
- 🔴 說明 `Seconds_Behind_Source` 為什麼**不能當監控指標**
  （實測：主庫的 8 秒大交易期間它一直是 **0**，之後才跳到 **12**；
  而且從庫會一邊回報「已讀完 relay log」一邊落後 15 秒）。
- 用**心跳表**量出連續、毫秒級的真實延遲（實測：閒置時 58 ～ 315 ms，
  大交易時平滑爬到 **6,129 ms**）。
- 🔴 說明 `read_only` 與 `super_read_only` 的差別
  （實測：`read_only = 1` 的從庫上，**`root` 的 `INSERT` 成功了**，
  並讓從庫的 GTID 集合**永久分岔**）。
- 用實測說明**讀己之寫**是「100% 失敗」而不是「偶爾失敗」，
  並用 `WAIT_FOR_EXECUTED_GTID_SET` 把它修成 **0%**（成本：平均 **1.12 ms**）。
- 交出一組**編譯過的** Spring 讀寫分離程式碼（`AbstractRoutingDataSource` + 切面 + 延遲監控 + 自動退回主庫）。
- 說出**六種讀取不能走從庫**，以及為什麼路由要做成「明確選擇加入」而不是「自動」。
- 說出 `ThreadLocal` 路由的**三個坑**（換執行緒、忘了清、巢狀呼叫）。
- 列出正式環境該監控的**四類指標**，以及每一個的告警門檻怎麼定。
- 設計一組**最小權限**的資料庫帳號（應用 / 遷移 / 複製 / 巡檢 / 備份）。

---

## 7.2 備份：你的備份真的還原得回來嗎（回答 06 章）

### 7.2.1 三種備份方式

```
① 邏輯備份（logical）—— 匯出成 SQL 或 CSV
     工具：mysqldump、mysqlpump、mysqlsh 的 util.dumpInstance、mydumper
     產物：文字（可讀、可 grep、可只還原一張表）
     ✅ 跨版本、跨平台、可以只還原一部分
     🔴 還原【非常慢】（要重新解析 SQL、重建索引）—— 7.2.3 實測 16.7 倍

② 實體備份（physical）—— 複製資料檔
     工具：Percona XtraBackup、MySQL Enterprise Backup
     產物：資料檔的副本 + redo log
     ✅ 還原快（就是把檔案放回去）
     ✅ 可以做增量備份
     🔴 綁版本、綁平台、不能「只還原一張表」（8.0 有 transportable tablespace，但很麻煩）

③ 快照（snapshot）—— 檔案系統 / 雲端磁碟層級
     工具：LVM、ZFS、EBS snapshot、Cloud SQL 的自動備份
     ✅ 幾乎瞬間完成，對資料庫的影響最小
     🔴 【必須是崩潰一致（crash-consistent）的】——
        也就是還原後 InnoDB 要跑一次 redo 恢復
     🔴 而如果你的資料檔跨多個磁碟，快照【不一定】是同一個時間點
```

📌 **實務上這三種是【一起用】的，不是選一個**：

```
每小時   ：雲端磁碟快照（RTO 最短，用來救「整台機器掛了」）
每天一次 ：XtraBackup 全量（用來救「資料檔壞了」）
每天一次 ：mysqldump（用來救「某一張表被誤刪」—— 只有邏輯備份能只還原一張表）
持續     ：🔴 binlog 歸檔（用來救「某一句 SQL 下錯了」—— 7.2.7）
```

⚠️ **注意最後一項。** 前三種都只能還原到「備份的那一刻」，
而事故通常發生在備份之後。**沒有 binlog，你就只能接受「丟掉自上次備份以來的全部資料」。**

**本章的實測用 `mysqldump`**，理由有兩個：
它是唯一「每個 MySQL 環境都有」的工具，
而且它的行為細節（鎖、一致性、退出碼）**是最多人搞錯的**。

---

### 7.2.2 `mysqldump` 的四種鎖模式：一致性 vs 阻塞 ★★

先看一個實驗設計。**用一個「不變量」來檢驗備份是否一致**：

```sql
-- 兩張各 400,000 列的表，每一列餘額 1000
CREATE TABLE acct_a (id INT PRIMARY KEY, bal BIGINT NOT NULL, pad VARCHAR(200)) ENGINE=InnoDB;
CREATE TABLE acct_b (id INT PRIMARY KEY, bal BIGINT NOT NULL, pad VARCHAR(200)) ENGINE=InnoDB;

-- 🔴 不變量：acct_a + acct_b 的餘額總和永遠 = 800,000,000
```

```java
/** 持續轉帳，並記錄【最長單次停頓】—— 用來看備份有沒有堵住寫入。 */
public class Transfer2 {
    public static void main(String[] a) throws Exception {
        String url = "jdbc:mysql://127.0.0.1:3350/bank?user=root&password=root";
        long end = System.currentTimeMillis() + Integer.parseInt(a[0]) * 1000L;
        int n = 0, fail = 0; long maxMs = 0;
        try (Connection c = DriverManager.getConnection(url)) {
            c.setAutoCommit(false);
            var d = c.prepareStatement("UPDATE acct_a SET bal = bal - 10 WHERE id = ?");
            var i = c.prepareStatement("UPDATE acct_b SET bal = bal + 10 WHERE id = ?");
            var rnd = new java.util.Random(42);
            while (System.currentTimeMillis() < end) {
                int id = 1 + rnd.nextInt(400000);
                long s = System.nanoTime();
                try {
                    d.setInt(1, id); d.executeUpdate();
                    i.setInt(1, id); i.executeUpdate();
                    c.commit();          // 每一筆轉帳都是一個完整交易 → 不變量始終成立
                    n++;
                } catch (SQLException e) { fail++; c.rollback(); }
                long ms = (System.nanoTime() - s) / 1_000_000;
                if (ms > maxMs) maxMs = ms;
            }
        }
        System.out.printf("%d 筆轉帳、%d 筆失敗、最長單次停頓 %d ms", n, fail, maxMs);
    }
}
```

**然後一邊轉帳、一邊用四種模式備份，把備份還原到另一個 schema 再檢查總額。**

| 模式 | dump 耗時 | 🔴 **線上寫入最長停頓** | 還原後的總額 | 一致？ |
|---|---|---|---|---|
| **（預設，什麼都不加）** | 1,085 ms | 🔴 **994 ms** | 800,000,000 | ✅ |
| `--skip-lock-tables` | 1,696 ms | ✅ 122 ms | 🔴 **800,001,500** | 🔴 **差 1,500 元** |
| **`--single-transaction`** | 1,637 ms | ✅ **90 ms** | 800,000,000 | ✅ |
| `--lock-all-tables` | 1,190 ms | 🔴 **1,094 ms** | 800,000,000 | ✅ |

📌 **四個結論**：

**① 「什麼都不加」的預設值不是「沒有保護」—— 它是 `--lock-tables`。**
`mysqldump` 預設會對**同一個資料庫的所有表**下 `LOCK TABLES ... READ LOCAL`。
所以它**是一致的**，代價是：

```
🔴 線上寫入停頓 994 ms ≈ dump 的全部時間（1,085 ms）
   → 300 GB 的資料庫用預設值備份，等於【停機備份】
```

⚠️ **而且 `--lock-tables` 的一致性只涵蓋「同一個資料庫」** ——
如果你 `mysqldump --databases a b`，它會**分別**鎖 `a` 再鎖 `b`，
所以跨資料庫的交易在備份裡可能是斷開的。

**② `--skip-lock-tables` 是唯一真的會壞掉的那一個。**

```
🔴 還原後總額 800,001,500 —— 多了 1,500 元
```

**這 1,500 元是怎麼來的？** `mysqldump` 先讀完 `acct_a`、再讀 `acct_b`。
在這兩件事之間，有 150 筆轉帳從 `acct_a` 扣了錢：

```
讀 acct_a 的時候：這 150 筆還沒扣款   → 備份裡 acct_a 的餘額【偏高】
讀 acct_b 的時候：這 150 筆已經入帳   → 備份裡 acct_b 的餘額【也偏高】
                                       → 總額多了 150 × 10 = 1,500
```

🔴 **注意這個備份的 `mysqldump` 退出碼是 0、檔案完整、還原也成功。**
**它只是「內容是錯的」。** 而如果你的資料是訂單與付款、而不是兩個帳戶餘額，
你會在還原之後**永遠不知道**哪幾筆訂單的狀態是錯的。

📌 順帶一提，`mysqldump` 自己會警告你：

```
In order to ensure a consistent backup of the database,
pass --single-transaction or --lock-all-tables or --master-data.
```

⚠️ **這行警告是印到 stderr 的。** 如果你的 cron 是
`mysqldump ... > backup.sql 2>/dev/null`，你永遠看不到它。

**③ `--single-transaction` 是唯一同時做到兩件事的選項。**

```
✅ 一致（還原後總額正確）
✅ 不擋寫入（停頓 90 ms，是四種模式裡【最低】的）
```

它的原理是 InnoDB 的 MVCC（04 章）：

**實測**：開 `general_log` 看 `mysqldump --single-transaction` 到底送了哪幾句：

```sql
-- ① 只有 --single-transaction（不取 binlog 座標）
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */;   -- 建立 ReadView
UNLOCK TABLES;              -- ⚠️ 這句是「以防萬一」的無條件釋放，不是配對的解鎖
-- 🔴 沒有 LOCK TABLES、也沒有 FLUSH TABLES WITH READ LOCK
-- 之後所有的 SELECT 都看到【同一個 ReadView】—— 04 章 4.3 的一致性讀
```

```sql
-- ② 加上 --source-data=2（PITR 需要 binlog 座標，見 7.2.7）才會出現全域鎖
FLUSH TABLES WITH READ LOCK;                              -- 🔴 極短暫，但確實停寫
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */;
SHOW MASTER STATUS;                                       -- ← 就為了這一句要鎖
UNLOCK TABLES;                                            -- 立刻放掉
```

📌 **所以 `--single-transaction` 的一致性是「免費」的** ——
它靠的是 InnoDB 本來就在做的 MVCC，而不是鎖。

⚠️ **但「取 binlog 座標」不是免費的。**
`--source-data` 為了讓「快照」與「座標」對得起來，必須用 `FLUSH TABLES WITH READ LOCK`
把整台機器停寫幾毫秒。生產環境的備份腳本幾乎一定要 `--source-data`（7.2.7），
所以**你的備份實際上是有一個極短的全域停寫的** —— 平常無感，
但如果同時有一個長查詢還沒結束，`FTWRL` 會等它，而在等的期間**所有寫入都排在後面**。

🔴 **但它有三個前置條件**：

```
🔴 只對 InnoDB 有效。表裡有 MyISAM → 那張表【不在快照裡】，一致性不成立
🔴 它會開一個【長交易】—— 04 章 4.3.8 量過長交易的代價（別人的查詢慢 20 倍）
     → 備份 3 小時 = 一個 3 小時的交易 = 3 小時的 undo 累積
🔴 它擋不住 DDL —— 這是下一節
```

**④ `--lock-all-tables` 的用途很窄。**
它下的是 `FLUSH TABLES WITH READ LOCK`（全域），
所以它是**跨資料庫一致**的，但代價是**整台機器停寫**（實測停頓 1,094 ms）。

```
✅ 唯一適合的場景：表裡有 MyISAM，而你需要一致性
✅ 或者：你要在備份的同一刻取得 binlog 座標，而 --single-transaction 不夠
🔴 除此之外，用 --single-transaction
```

---

### 7.2.3 備份 1.6 秒、還原 27 秒（16.7 倍）★★

這是本章開場那組數字的完整版。

**環境**：`shop.ord` **3,000,200 列**，資料 **195.7 MB** + 索引 **231.6 MB**。

```bash
# ① 備份
mysqldump -uroot -p --single-transaction --set-gtid-purged=OFF \
          --skip-comments shop ord > /tmp/shop_ord.sql
# ② 壓縮
gzip -c /tmp/shop_ord.sql > /tmp/shop_ord.sql.gz
# ③ 還原
mysql -uroot -p shop_r < /tmp/shop_ord.sql
```

```
① mysqldump（純文字）      1,615 ms    檔案 194 MB
② gzip 壓縮                2,521 ms    檔案  25 MB（壓縮比 7.8:1）
③ 🔴 還原                 26,921 ms
```

📌 **三個觀察**：

**① 還原比備份慢 16.7 倍。** 原因是兩邊做的事完全不對稱：

```
備份：SELECT 掃過表 → 格式化成文字 → 寫檔
      （順序讀、幾乎沒有寫入放大）

還原：解析 SQL → 逐批 INSERT → 🔴 重建【所有索引】
                              → 🔴 寫 redo log
                              → 🔴 寫 binlog（如果開著）
                              → 🔴 更新 buffer pool、刷髒頁
```

⚠️ **注意「重建所有索引」這一項**：這張表的索引（231.6 MB）**比資料（195.7 MB）還大**
—— 這是 03 章 3.3.4 量過的事，而它在這裡的意義是：
**還原的工作量有一半以上是在重建索引。**

**② 壓縮比備份本身還慢（2,521 ms vs 1,615 ms）。**
但 194 MB → 25 MB 的 7.8:1 壓縮比通常很值得（傳輸與儲存成本）。
✅ 實務上用管線省掉中間檔案：

```bash
mysqldump ... | gzip -c > backup.sql.gz
```

🔴 **但管線有一個陷阱**：`$?` 拿到的是**管線最後一個指令**（`gzip`）的退出碼，
`mysqldump` 失敗了你也看不到。必須這樣寫：

```bash
set -o pipefail          # 🔴 沒有這一行，mysqldump 的失敗會被 gzip 的成功蓋掉
mysqldump ... | gzip -c > backup.sql.gz
```

**③ 這 27 秒是【300 萬列】的數字。**

```
300 萬列    →  27 秒
3,000 萬列  →  約 4.5 分鐘（若大致線性）
3 億列      →  約 45 分鐘
```

⚠️ **而且「大致線性」在真實環境通常不成立** ——
索引重建是 O(n log n)，而且當資料量超過 buffer pool 之後
（05 章 5.2 的全部內容）還原會**再慢一個數量級**。

📌 **這就是「RTO」（Recovery Time Objective）這個詞的實際意義**：

```
RPO（Recovery Point Objective）「可以丟掉多少資料？」
    = 上次備份到事故之間的時間
    ✅ 有 binlog 歸檔 → RPO 接近 0（7.2.7）
    🔴 只有每日備份  → RPO 最壞 24 小時

RTO（Recovery Time Objective）「多久之後可以開門營業？」
    = 發現 + 決策 + 取得備份 + 還原 + 重放 binlog + 驗證 + 切流量
    🔴 而「還原」這一項就是上面那 27 秒 / 45 分鐘
```

🔴 **絕大多數團隊的 RTO 文件只寫了「還原」那一項，而且用的是【備份的時間】。**

✅ **算你自己的 RTO，唯一的方法是做一次演練**（7.2.8）。

---

### 7.2.4 `--single-transaction` 擋不住 DDL：備份靜默失敗 ★★

`--single-transaction` 靠 MVCC 拿到一致的**資料**快照。
但 **DDL 改的是中介資料，而中介資料不在 MVCC 的保護範圍裡**。

**實驗**：一邊 `mysqldump --single-transaction`（整個 `shop` 資料庫），
一邊對一張**還沒被讀到**的小表下 DDL。

```bash
# 背景：dump 整個 shop（會先讀 ord 這張大表，最後才讀 t_late）
mysqldump -uroot -p --single-transaction shop > /tmp/stx_ddl.sql &
sleep 1
# dump 進行中，對還沒被讀到的 t_late 下 DDL
mysql -uroot -p shop -e "ALTER TABLE t_late ADD COLUMN extra INT NULL, ALGORITHM=INSTANT;"
```

```
DUMP_EXIT=3
mysqldump: Error in field count for table: `t_late` !  Aborting.
```

🔴 **備份中止了。**

**對照組**：對它**已經讀過（或正在讀）**的那張大表下同一種 DDL：

```
DUMP_EXIT=0        ← ✅ 成功（快照已經固定住那張表的定義）
```

📌 **所以規則是**：

> **`--single-transaction` 保護「它已經讀過的表」，
> 但對「它還沒讀到的表」，DDL 會讓它中止。**

---

⚠️ **而真正危險的不是「中止」，是【中止之後留下的東西】**：

```bash
ls -l /tmp/stx_ddl.sql
```
```
203806451 bytes        ← 🔴 194 MB，一個看起來非常正常的備份檔
```

```bash
grep -c 'CREATE TABLE' /tmp/stx_ddl.sql    # → 3
grep -c 'CREATE TABLE' /tmp/success.sql    # → 3      🔴 一樣！
```

**唯一的差別在最後兩行**：

```
失敗的檔案結尾：
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  /*!40101 SET character_set_client = @saved_cs_client */;
                          ↑ 🔴 停在一張表的定義後面，資料沒了

成功的檔案結尾：
  /*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
  /*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;
                          ↑ ✅ 完整的收尾
```

🔴 **一個 194 MB、有正確表數量、可以正常還原的檔案 —— 而它少了一張表的資料。**

**這就是「以為有備份」最常見的樣子。**
而它會在什麼時候被發現？**在你需要用它的那一天。**

---

### 7.2.5 備份腳本的六個檢查

從 7.2.2 ～ 7.2.4 推出來的一份腳本。**每一個檢查都對應一個實測過的失敗**：

```bash
#!/bin/bash
# ops/backup-mysql.sh
set -euo pipefail                  # 🔴 檢查 ①：任何一步失敗就停
set -o pipefail                    # 🔴 檢查 ②：管線中間的失敗不會被吃掉（7.2.3）

DB=shop
HOST=${DB_HOST:?}
USER=${BACKUP_USER:?}
OUT_DIR=/var/backups/mysql
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
BASE="$OUT_DIR/${DB}-${STAMP}"
LOG="$BASE.log"

mkdir -p "$OUT_DIR"

# ── 備份 ────────────────────────────────────────────────────────────
# --single-transaction  一致且不擋寫入（7.2.2 實測）
# --source-data=2       把 binlog 座標寫進註解，PITR 要用（7.2.7）
# --routines --events --triggers   🔴 這三個【不是預設】，漏了就少了預存程序
# --hex-blob            二進位欄位（01 章的 BINARY(16) 主鍵）用十六進位，避免編碼問題
# ⚠️ 這裡故意【不寫】--skip-lock-tables。
#    直覺會覺得要加（預設是 --lock-tables，不關掉就會鎖表），但實測不是這樣：
#    --single-transaction 會自動關掉 --lock-tables。開 general_log 驗證過，
#    連 --single-transaction --lock-tables 一起下，送出去的也只有
#    START TRANSACTION WITH CONSISTENT SNAPSHOT + UNLOCK TABLES，沒有 LOCK TABLES。
#    → 加了無害，但它是一個「看起來必要、其實無效」的參數。多寫一個沒作用的旗標，
#      下一個人會以為它在防什麼，然後不敢動它。
mysqldump \
    --host="$HOST" --user="$USER" \
    --single-transaction \
    --source-data=2 \
    --routines --events --triggers \
    --hex-blob \
    --set-gtid-purged=ON \
    --databases "$DB" \
  2> "$LOG" \
  | gzip -c > "$BASE.sql.gz"

# ── 檢查 ③：mysqldump 的 stderr 有沒有東西（警告也算） ─────────────
if [ -s "$LOG" ] && grep -viE 'Using a password on the command line' "$LOG" | grep -q '[^[:space:]]'; then
  echo "🔴 mysqldump 有輸出到 stderr："
  cat "$LOG"
  exit 1
fi

# ── 檢查 ④：gzip 檔案本身完整嗎 ─────────────────────────────────────
gzip -t "$BASE.sql.gz" || { echo "🔴 gzip 檔案損壞"; exit 1; }

# ── 檢查 ⑤：🔴 結尾有 mysqldump 的收尾標記嗎（7.2.4 的靜默失敗）─────
if ! gzip -dc "$BASE.sql.gz" | tail -5 | grep -q 'SET SQL_NOTES=@OLD_SQL_NOTES'; then
  echo "🔴 備份檔沒有正確的收尾標記 —— mysqldump 中途中止了（見 7.2.4）"
  exit 1
fi

# ── 檢查 ⑥：檔案大小跟前一天差太多嗎 ───────────────────────────────
SIZE=$(stat -c '%s' "$BASE.sql.gz" 2>/dev/null || stat -f '%z' "$BASE.sql.gz")
PREV=$(ls -t "$OUT_DIR/${DB}"-*.sql.gz 2>/dev/null | sed -n 2p)
if [ -n "$PREV" ]; then
  PREV_SIZE=$(stat -c '%s' "$PREV" 2>/dev/null || stat -f '%z' "$PREV")
  RATIO=$(( SIZE * 100 / (PREV_SIZE > 0 ? PREV_SIZE : 1) ))
  if [ "$RATIO" -lt 70 ] || [ "$RATIO" -gt 200 ]; then
    echo "🔴 備份大小是前一次的 ${RATIO}% —— 太不尋常，請人工確認"
    exit 1
  fi
fi

# ── 記錄 binlog 座標（PITR 的起點）─────────────────────────────────
gzip -dc "$BASE.sql.gz" | grep -m1 -iE 'CHANGE (MASTER|REPLICATION SOURCE)' \
  > "$BASE.binlog-position.txt" || true

echo "✅ 備份完成：$BASE.sql.gz（$((SIZE / 1024 / 1024)) MB）"
cat "$BASE.binlog-position.txt"
```

📌 **檢查 ⑤ 是這份腳本的核心。**
它是唯一能抓到 7.2.4 那個「194 MB 的壞檔案」的檢查 ——
而它只需要 `tail -5 | grep`。

⚠️ **`--source-data=2` 與 `--master-data=2`**：
MySQL 8.0.26 起 `--master-data` 被 `--source-data` 取代（舊名還能用但會警告）。
`=2` 的意思是「把座標寫成**註解**」，`=1` 是「寫成可執行的 `CHANGE MASTER TO`」——
**備份用 `=2`**，不然還原的時候會不小心改掉複製設定。

**實測 `--source-data=2` 產生的那一行**：

```sql
-- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000004', MASTER_LOG_POS=63179228;
```

📌 **這一行就是 7.2.7 做 PITR 的起點。沒有它，PITR 只能靠猜時間。**

---

### 7.2.6 一個實務障礙：官方映像沒有 `mysqlbinlog`

做 PITR 需要 `mysqlbinlog`。而它**不在 MySQL 官方 Docker 映像裡**：

```bash
docker exec mysql-m1 sh -c "ls /usr/bin/mysql*"
```
```
/usr/bin/mysql
/usr/bin/mysql-secret-store-login-path
/usr/bin/mysql_config
/usr/bin/mysql_migrate_keyring
/usr/bin/mysql_ssl_rsa_setup
/usr/bin/mysql_tzinfo_to_sql
/usr/bin/mysql_upgrade
/usr/bin/mysqladmin
/usr/bin/mysqldump
/usr/bin/mysqlpump
/usr/bin/mysqlsh
                       ← 🔴 沒有 mysqlbinlog
```

⚠️ **這是一個「災難當天才會發現」的問題。**

📌 **三種替代做法**：

**① 用 `SHOW BINLOG EVENTS`（純 SQL，任何環境都有）**

```sql
SHOW BINLOG EVENTS IN 'binlog.000004' FROM 63179228 LIMIT 40;
```

**實測輸出**（下一節那個事故的現場）：

```
Log_name       Pos        Event_type    Info
binlog.000004  63179228   Gtid          SET @@SESSION.GTID_NEXT= '...:87679'
binlog.000004  63179307   Query         BEGIN
binlog.000004  63179394   Table_map     table_id: 355 (pitr.ord)
binlog.000004  63179456   Write_rows    table_id: 355 flags: STMT_END_F
binlog.000004  63179521   Xid           COMMIT /* xid=262044 */
...
binlog.000004  63180228   Gtid          SET @@SESSION.GTID_NEXT= '...:87682'
binlog.000004  63180307   Query         BEGIN
binlog.000004  63180382   Table_map     table_id: 355 (pitr.ord)
binlog.000004  63180444   Delete_rows   table_id: 355 flags: STMT_END_F      ← 🔴 事故
binlog.000004  63180629   Xid           COMMIT /* xid=262054 */
binlog.000004  63180660   Gtid          SET @@SESSION.GTID_NEXT= '...:87683'
```

✅ **這一句就足以「找出事故那個 GTID」** —— 上面那個是 `...:87682`。
🔴 但它**不能**產生重放用的 SQL，所以只夠診斷，不夠復原。

**② 用一個有 `mysqlbinlog` 的容器**

```bash
# percona/percona-server:8.0 有 /usr/bin/mysqlbinlog
docker run --rm --network <你的網路> --user root percona/percona-server:8.0 \
  mysqlbinlog --no-defaults \
    --read-from-remote-server --host=mysql-m1 --port=3306 \
    --user=root --password=... \
    --start-position=63179228 \
    binlog.000004
```

📌 **用 `--read-from-remote-server` 而不是讀檔案**，兩個好處：

```
✅ 不用處理容器之間的檔案權限（實測直接掛 volume 會 Permission denied）
✅ 正式環境通常也不讓你 SSH 到資料庫主機
```

**③ 事前就把 `mysqlbinlog` 準備好**

```dockerfile
# ops/Dockerfile.dbtools —— 一個「災難工具箱」映像
FROM percona/percona-server:8.0
USER root
# mysqlbinlog / mysqldump / mysql 都在，再加上 percona-toolkit
RUN yum install -y percona-toolkit || microdnf install -y percona-toolkit || true
```

✅ **把它推到你的 registry，並且【在演練裡用過一次】**（7.2.8）。

---

### 7.2.7 PITR：把誤刪的那一個交易單獨跳過 ★★

這是本章最重要的一節，也是 06 章 6.5.1 那句 `Please restore backups` 的完整答案。

**而答案比「還原備份」好得多**：
**你可以還原到事故前，並且把事故之後的正常交易也一起救回來。**

---

**事故的完整時間軸**（實測）：

```sql
-- 09:00 現況：3 列
CREATE TABLE ord (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_no VARCHAR(32) NOT NULL,
                  amount DECIMAL(19,4) NOT NULL,
                  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3));
INSERT INTO ord (order_no, amount) VALUES ('D001',100),('D002',200),('D003',300);
```

```bash
# ① 09:00 備份（記下 binlog 座標）
mysqldump --single-transaction --source-data=2 --set-gtid-purged=OFF pitr > /tmp/pitr_backup.sql
```
```
-- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000004', MASTER_LOG_POS=63179228;
```

```sql
-- ② 備份之後的正常交易
INSERT INTO ord (order_no, amount) VALUES ('D004',400);        -- GTID 87679
INSERT INTO ord (order_no, amount) VALUES ('D005',500);        -- GTID 87680
UPDATE ord SET amount = 999 WHERE order_no = 'D001';           -- GTID 87681

-- ③ 🔴 09:03 有人下了一句忘了 WHERE 的 DELETE
DELETE FROM ord;                                               -- GTID 87682  ← 事故

-- ④ 事故之後又有新交易進來（這些【不能】跟著一起丟掉）
INSERT INTO ord (order_no, amount) VALUES ('D006',600);        -- GTID 87683
```

```sql
SELECT * FROM ord;
```
```
id  order_no  amount     created_at
6   D006      600.0000   2026-09-03 07:25:16.871
                                       ← 🔴 只剩事故後那一列
```

---

**復原：三個步驟。注意第一步在動資料庫【之前】。**

```bash
# ═══ 步驟 1：先把 binlog 撈出來存好 ═══════════════════════════════
#     🔴 這一步必須在還原之前做。理由：
#        還原本身也會寫 binlog，而 binlog 可能會被輪替 / 過期清掉。
UUID=f569bde7-a766-11f1-b95c-66696dea34ab

docker run --rm --network mysqlrepl --user root percona/percona-server:8.0 \
  mysqlbinlog --no-defaults \
    --read-from-remote-server --host=mysql-m1 --port=3306 --user=root --password=root \
    --start-position=63179228 \        `# 備份時的座標（--source-data=2 給的）` \
    --stop-position=63180984 \         `# 事故發現時的座標` \
    --exclude-gtids="$UUID:87682" \    `# 🔴 只排除【事故那一個交易】` \
    --skip-gtids \                     `# 重放時不要沿用原本的 GTID` \
    --database=pitr \                  `# 只要這個資料庫的事件` \
    binlog.000004 > /tmp/pitr_replay.sql
```

```
重放腳本 112 行，4 個交易
       ↑ 原本是 5 個交易（87679 ~ 87683），排除了 87682 之後剩 4 個
```

**先檢查重放腳本裡有什麼**（🔴 這一步不要省）：

```bash
mysqlbinlog ... --base64-output=DECODE-ROWS --verbose ... | grep -E '^### (INSERT|UPDATE|DELETE)'
```
```
### INSERT INTO `pitr`.`ord`      @1=4  @2='D004'  @3=400.0000
### INSERT INTO `pitr`.`ord`      @1=5  @2='D005'  @3=500.0000
### UPDATE `pitr`.`ord`           @1=1  @2='D001'  @3=100.0000
                                  @1=1  @2='D001'  @3=999.0000
### INSERT INTO `pitr`.`ord`      @1=6  @2='D006'  @3=600.0000
                                  ← 🔴 沒有 DELETE。排除成功。
```

```bash
# ═══ 步驟 2：還原備份 ═══════════════════════════════════════════════
mysql -uroot -p -e "DROP DATABASE IF EXISTS pitr; CREATE DATABASE pitr;"
mysql -uroot -p pitr < /tmp/pitr_backup.sql
```
```
  還原備份後: 3 列        ← D001、D002、D003
```

```bash
# ═══ 步驟 3：重放 binlog ═══════════════════════════════════════════
mysql -uroot -p pitr < /tmp/pitr_replay.sql
```

**最終結果**：

```
id  order_no  amount
1   D001      999.0000     ← ✅ 備份裡是 100，UPDATE（87681）被重放了
2   D002      200.0000     ← ✅ 備份裡的
3   D003      300.0000     ← ✅ 備份裡的
4   D004      400.0000     ← ✅ 備份【之後】的交易，救回來了
5   D005      500.0000     ← ✅
6   D006      600.0000     ← ✅ 【事故之後】的交易，也救回來了
```

🔴 **六列全部正確，而那句 `DELETE FROM ord` 沒有被重放。**

---

📌 **`--exclude-gtids` 是這整套做法的關鍵，而它需要 GTID 模式**：

| | 檔案位置模式 | **GTID 模式** |
|---|---|---|
| 跳過中間某一個交易 | 🔴 要算出「停在哪、從哪繼續」兩個位置，容易差幾個 byte | ✅ **`--exclude-gtids=UUID:87682`** |
| 跳過分散的多個交易 | 🔴 幾乎做不到（要切成 N 段） | ✅ `--exclude-gtids=UUID:87682:87690-87695` |
| 只要某一段 | `--start-position` / `--stop-position` | `--include-gtids` |
| 換主庫之後 binlog 座標會變 | 🔴 全部重算 | ✅ GTID 是全域唯一的，不受影響 |

🔴 **這就是「為什麼要開 GTID」最實際的一個理由** ——
不是為了複製方便，是為了**災難當天你能只跳過那一句**。

---

⚠️ **PITR 的五個實務注意事項**：

```
① 🔴 先撈 binlog，再動資料庫（步驟 1 的順序不能顛倒）
     還原會寫 binlog；binlog 也可能被 binlog_expire_logs_seconds 清掉

② 🔴 --skip-gtids 幾乎總是要加
     不加的話重放的事件會沿用原本的 GTID，
     而那些 GTID 在 gtid_executed 裡已經存在 → 全部被【當成已執行而跳過】
     （症狀：重放腳本跑完，資料一列都沒變）

③ 🔴 --set-gtid-purged=OFF 在「還原到同一台機器」時要加
     不加的話備份檔開頭有 SET @@GLOBAL.GTID_PURGED，
     會報 ERROR 3546: @@GLOBAL.GTID_PURGED cannot be changed:
          the added gtid set must not overlap with @@GLOBAL.GTID_EXECUTED

④ 先在【另一個 schema 或另一台機器】上重放，比對之後再切流量
     —— 不要在正式庫上「邊救邊試」

⑤ 🔴 事故發生後【立刻把應用停掉或切唯讀】
     不然事故後的新交易會越來越多，而你要重放的範圍越來越複雜
```

📌 **② 是最容易踩的一個，因為它的症狀是「什麼都沒發生」而不是報錯。**

---

### 7.2.8 還原演練：唯一能證明備份有效的方法

📌 **一份「備份成功」的監控告警，證明的是「`mysqldump` 的退出碼是 0」。**
它**不證明**：

```
🔴 檔案沒有被截斷（7.2.4）
🔴 內容是一致的（7.2.2 的 --skip-lock-tables）
🔴 還原得回來（字元集、定序、DEFINER、SQL 模式都對）
🔴 還原要多久（7.2.3 的 RTO）
🔴 你的團隊【知道怎麼還原】
```

**最後一項最重要。** 災難當天最花時間的往往不是還原本身，
而是「找出備份在哪、找出 binlog 在哪、想起參數怎麼下、找到有權限的人」。

✅ **一份可以自動化的演練腳本**（建議每月跑一次，並把耗時記錄下來）：

```bash
#!/bin/bash
# ops/restore-drill.sh —— 每月一次的還原演練。🔴 這個腳本自己就是文件。
set -euo pipefail
set -o pipefail

BACKUP=${1:?用法: restore-drill.sh <backup.sql.gz>}
CONTAINER=restore-drill-$$
REPORT=/tmp/restore-drill-$(date -u '+%Y%m%dT%H%M%SZ').txt

t() { date -u '+%s'; }
log() { echo "$*" | tee -a "$REPORT"; }

trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

log "還原演練開始：$(date -u)"
log "備份檔：$BACKUP（$(du -h "$BACKUP" | cut -f1)）"

# ── ① 起一個【跟正式環境同版本】的空 MySQL ──────────────────────────
T0=$(t)
docker run -d --name "$CONTAINER" -e MYSQL_ROOT_PASSWORD=drill \
  mysql:8.0.46 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
  --default-time-zone=+00:00 >/dev/null
until docker exec "$CONTAINER" mysqladmin -uroot -pdrill ping --silent 2>/dev/null; do sleep 1; done
log "① 起容器：$(( $(t) - T0 )) 秒"

# ── ② 還原（🔴 這是 RTO 的主要成分）───────────────────────────────
T0=$(t)
gzip -dc "$BACKUP" | docker exec -i "$CONTAINER" mysql -uroot -pdrill
log "② 還原：$(( $(t) - T0 )) 秒"

# ── ③ 驗證：不是「有沒有錯誤」，是【資料對不對】──────────────────
T0=$(t)
docker exec "$CONTAINER" mysql -uroot -pdrill -N -e "
  SELECT CONCAT('   表數量        = ', COUNT(*))
  FROM information_schema.tables WHERE table_schema = 'shop';
  SELECT CONCAT('   orders 列數   = ', COUNT(*)) FROM shop.orders;
  SELECT CONCAT('   最新一筆訂單  = ', COALESCE(MAX(placed_at),'（無）')) FROM shop.orders;
  SELECT CONCAT('   預存程序數量  = ', COUNT(*))
  FROM information_schema.routines WHERE routine_schema = 'shop';
  SELECT CONCAT('   視圖數量      = ', COUNT(*))
  FROM information_schema.views WHERE table_schema = 'shop';
  SELECT CONCAT('   Flyway 版本   = ', COALESCE(MAX(version),'（無）'))
  FROM shop.flyway_schema_history WHERE success = 1;
" | tee -a "$REPORT"

# 🔴 業務不變量檢查 —— 這是「還原成功」與「資料正確」的差別（7.2.2）
docker exec "$CONTAINER" mysql -uroot -pdrill -N -e "
  SELECT CONCAT('   🔴 明細總額與訂單總額不符的筆數 = ', COUNT(*))
  FROM shop.orders o
  JOIN (SELECT order_id, SUM(line_amount) s FROM shop.order_item GROUP BY order_id) i
       ON i.order_id = o.id
  WHERE i.s <> o.total_amount;
" | tee -a "$REPORT"

# 🔴 schema 與版控一致嗎（接上 06 章 6.9.3 的黃金 schema）
docker exec "$CONTAINER" mysqldump -uroot -pdrill --no-data --skip-comments \
    --skip-add-drop-table --skip-set-charset --routines --triggers shop \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//' | grep -v '^/\*!' \
  | grep -v 'flyway_schema_history' > /tmp/drill-schema.sql
if diff -q src/main/resources/db/golden-schema.sql /tmp/drill-schema.sql >/dev/null 2>&1; then
  log "   ✅ schema 與 golden-schema.sql 一致"
else
  log "   🔴 schema 與 golden-schema.sql 不一致"
fi
log "③ 驗證：$(( $(t) - T0 )) 秒"

log ""
log "🔴 把上面的「② 還原」秒數填進 RTO 文件。"
log "報告：$REPORT"
```

📌 **演練要記錄的四個數字**：

```
① 還原耗時（RTO 的主要成分）
② 備份檔的大小與成長率（用來推估「三個月後還原要多久」）
③ 🔴 從「開始演練」到「驗證通過」的【總時間】—— 這才是真正的 RTO
④ 🔴 演練過程中有幾個步驟是「查了文件才知道怎麼做」的
       —— 那些就是災難當天會多花的時間，把它們寫進腳本
```

⚠️ **④ 是演練真正的價值。** 第一次演練通常會發現：

```
🔴 備份檔在 S3 上，但沒有人有下載權限
🔴 mysqlbinlog 不在任何一台可用的機器上（7.2.6）
🔴 備份裡的視圖有 DEFINER=`root`@`10.0.1.5`，新環境沒有這個帳號 → 還原失敗
🔴 還原完之後沒有人知道「怎麼確認資料是對的」
```

---

### 7.2.9 保留策略

```
3-2-1 原則
     3 份副本（1 份正式 + 2 份備份）
     2 種媒介 / 位置（本地磁碟 + 物件儲存）
     1 份【異地】（不同的可用區，最好是不同的雲端帳號）
```

⚠️ **「不同的雲端帳號」不是偏執。**
勒索軟體與誤刪的共同特徵是「攻擊者/操作者用的是你的憑證」——
而同一個帳號下的備份，跟正式資料一樣可以被刪掉。

📌 **一組實務的保留期**：

```
binlog                  保留 7 天（要 ≥ 全量備份的間隔 × 2）
每小時的磁碟快照        保留 48 小時
每日的全量備份          保留 14 天
每週的全量備份          保留 8 週
每月的全量備份          保留 12 個月     ← 通常是法規要求
```

🔴 **`binlog_expire_logs_seconds` 一定要比「備份間隔」長，而且要留餘裕**：

```sql
SELECT @@binlog_expire_logs_seconds;      -- 預設 2592000（30 天）
```

```
如果 binlog 只留 1 天，而備份是每日一次 ——
     備份在 02:00 完成，binlog 在 02:00 過期
     → 🔴 你有備份，但【沒有從備份走到現在的路】
     → PITR 完全做不到（7.2.7 的步驟 1 沒有東西可撈）
```

⚠️ **另一個方向的風險**：binlog 留太久會**吃滿磁碟**，而磁碟滿了 MySQL 會**停止寫入**。
✅ 所以要同時監控：

🔴 **這裡有一個很多人踩過的坑：`SHOW BINARY LOGS` 的結果拿不到 SQL 裡。**

```sql
-- 🔴 這句跑不起來
SELECT COUNT(*), SUM(File_size) FROM (SHOW BINARY LOGS) x;
```
```
ERROR 1064 (42000): You have an error in your SQL syntax; ...
near 'SHOW BINARY LOGS) x' at line 1
```

`SHOW` 語句**不能當衍生表**，而 MySQL 8 也**沒有**任何 `information_schema` 視圖列出
binlog 檔案清單（`information_schema` 裡只有 `binary_log_transaction_compression_stats`，
那是壓縮統計；`performance_schema.log_status` 只給**當前**的檔名與位置，不給歷史檔案的大小）。

✅ **所以只能在 shell 側算**：

```bash
mysql -N -B -e 'SHOW BINARY LOGS' \
  | awk '{f++; b+=$2} END {printf "files=%d total_gb=%.2f\n", f, b/1024/1024/1024}'
```
```
files=4 total_gb=1.19
```

📌 **這個「監控資料只存在於 SHOW 裡」的模式在 MySQL 很常見**
（`SHOW BINARY LOGS`、`SHOW REPLICA STATUS`、`SHOW ENGINE INNODB STATUS` 都是），
而它的實務後果是：**這些指標沒辦法用純 SQL 的 exporter 抓** ——
Prometheus 的 mysqld_exporter 就是為此才需要專門的 collector，而不是一份 SQL 清單。

📌 **實務上 binlog 應該【歸檔到物件儲存】而不是留在資料庫主機上**：

```bash
# 每 5 分鐘：把已經寫完（不是當前）的 binlog 傳到 S3
mysql -N -e "SHOW BINARY LOGS" | awk '{print $1}' | head -n -1 | while read f; do
  aws s3 cp "/var/lib/mysql/$f" "s3://my-backups/binlog/$(hostname)/$f" --no-progress
done
```

✅ **這樣 `binlog_expire_logs_seconds` 可以設短（3 天），而 PITR 的能力來自 S3。**

---

## 7.3 主從複製

### 7.3.1 `binlog_format`：`STATEMENT` 會讓主從資料分岔 ★★

複製的整個機制建立在 binlog 上，所以先看 binlog 記的是什麼。

```
STATEMENT  記【SQL 文字】          —— 從庫重新執行那句 SQL
ROW        記【改了哪幾列、改成什麼】—— 從庫直接套用那些變更
MIXED      預設用 STATEMENT，遇到「不安全」的語句自動切 ROW
```

**實驗**：同一句 `UPDATE`，兩種格式各跑一次，看 binlog 裡是什麼。

```sql
CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(200), ts DATETIME(6));
INSERT INTO t (v, ts) VALUES ('a', NOW(6)),('b',NOW(6)),('c',NOW(6));

-- 🔴 注意這句用了兩個【不確定函式】：UUID() 與 NOW(6)
UPDATE t SET v = UUID(), ts = NOW(6) WHERE id <= 3;
```

```
=== binlog_format = ROW ===
   Gtid            SET @@SESSION.GTID_NEXT= '...:88120'
   Query           BEGIN
   Table_map       table_id: 390 (bl.t)
   Update_rows     table_id: 390 flags: STMT_END_F      ← 記的是【結果的每一列】
   Xid             COMMIT /* xid=263090 */

=== binlog_format = STATEMENT ===
   Gtid            SET @@SESSION.GTID_NEXT= '...:88121'
   Query           BEGIN
   Query           use `bl`; UPDATE t SET v = UUID(), ts = NOW(6) WHERE id <= 3
                                                      ← 🔴 記的是【SQL 文字】
   Xid             COMMIT /* xid=263102 */
```

**然後比對主從的資料**：

```sql
SELECT MD5(GROUP_CONCAT(v ORDER BY id)) FROM t;
```
```
主庫：408ed80e7d79c3a7f8a36f57d48fd443
從庫：3edc4d31038102fc78d63c7a53f55ca3
      ↑ 🔴 不一樣。主從資料【真的分岔了】。
```

📌 **為什麼？** 因為 `STATEMENT` 格式下，從庫是**重新執行** `UPDATE t SET v = UUID()` ——
而 `UUID()` 在從庫上會產生**不同的值**。

🔴 **而且 MySQL 沒有阻止你。** 它只是在錯誤日誌裡寫一行
`Statement is not safe to log in statement format` 的警告 ——
而**資料已經分岔了**。

⚠️ **會踩到這個坑的不只 `UUID()`**：

```
🔴 UUID()、RAND()、SYSDATE()、CONNECTION_ID()、USER()、LOAD_FILE()
🔴 UPDATE ... LIMIT n（沒有 ORDER BY —— 從庫可能改到不同的列）
🔴 INSERT ... ON DUPLICATE KEY UPDATE，表上有多個唯一索引時
🔴 使用了 AUTO_INCREMENT 的並行 INSERT（innodb_autoinc_lock_mode=2 時）
🔴 觸發器與預存程序裡的任何上述東西
```

✅ **結論非常明確**：

```sql
-- my.cnf —— 這三行沒有討論空間
binlog_format     = ROW
binlog_row_image  = FULL      -- 記完整的前後值（PITR 與 CDC 都需要）
gtid_mode         = ON
enforce_gtid_consistency = ON
```

⚠️ **`binlog_row_image` 的三個選項**：

| 值 | 記什麼 | 用途 |
|---|---|---|
| **`FULL`**（預設） | 前後**所有欄位** | ✅ PITR（7.2.7 的 `--verbose` 才看得懂）、CDC、對帳 |
| `MINIMAL` | 前值只記主鍵，後值只記改過的欄位 | binlog 小很多；🔴 但 PITR 的 `DECODE-ROWS` 看不到全貌 |
| `NOBLOB` | 除了沒改的 BLOB/TEXT 之外都記 | 折衷 |

📌 **`MINIMAL` 能省很多空間**（尤其表很寬時），
🔴 **但它讓 7.2.7 那種「人工檢查重放腳本」變得幾乎不可能** ——
你會看到 `@1=4` 而不知道其他欄位是什麼。
**除非 binlog 的量真的是問題，用 `FULL`。**

---

### 7.3.2 建一組 GTID 複製（可以照著貼）

這是本章所有複製實驗用的環境。**完整、可重現**：

```bash
# ── 主庫 ────────────────────────────────────────────────────────────
docker network create mysqlrepl

docker run -d --name mysql-m1 --network mysqlrepl \
  -e MYSQL_ROOT_PASSWORD=root -p 3350:3306 mysql:8.0 \
  --server-id=1 \
  --log-bin=binlog --binlog-format=ROW --binlog-row-image=FULL \
  --gtid-mode=ON --enforce-gtid-consistency=ON \
  --log-replica-updates=ON \
  --binlog-expire-logs-seconds=604800 \
  --innodb-buffer-pool-size=256M

# ── 從庫 ────────────────────────────────────────────────────────────
docker run -d --name mysql-m2 --network mysqlrepl \
  -e MYSQL_ROOT_PASSWORD=root -p 3351:3306 mysql:8.0 \
  --server-id=2 \
  --log-bin=binlog --binlog-format=ROW --binlog-row-image=FULL \
  --gtid-mode=ON --enforce-gtid-consistency=ON \
  --log-replica-updates=ON \
  --read-only=ON \
  --innodb-buffer-pool-size=256M
```

📌 **四個參數值得解釋**：

```
--server-id            🔴 必須全叢集唯一。撞號的症狀是複製反覆斷線重連
--log-replica-updates  從庫把「套用的變更」也寫進自己的 binlog
                       ✅ 為什麼要開：① 從庫可以再當別人的主庫（串聯）
                                     ② 🔴 從庫可以【被備份】—— 而這是實務上
                                        備份的正確位置（不打擾主庫）
--read-only=ON         擋住一般帳號的寫入 —— 🔴 但擋不住 root，見 7.3.7
--gtid-mode=ON         7.2.7 論證過：這是為了災難當天
```

```sql
-- ── 主庫：建複製帳號 ────────────────────────────────────────────
CREATE USER 'repl'@'%' IDENTIFIED WITH caching_sha2_password BY 'replpass';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%';
-- 🔴 只給 REPLICATION SLAVE。不要給 SELECT、不要給 ALL（7.7）
```

```sql
-- ── 從庫：接上主庫 ──────────────────────────────────────────────
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='mysql-m1',
  SOURCE_PORT=3306,
  SOURCE_USER='repl',
  SOURCE_PASSWORD='replpass',
  SOURCE_AUTO_POSITION=1,        -- 🔴 GTID 自動定位：不用算檔名與位置
  GET_SOURCE_PUBLIC_KEY=1;       -- caching_sha2_password 需要（00 章 0.7）

START REPLICA;
```

**確認**：

```sql
SHOW REPLICA STATUS\G
```
```
                  Source_Host: mysql-m1
           Replica_IO_Running: Yes          ← ✅ 兩個都要 Yes
          Replica_SQL_Running: Yes          ← ✅
                   Last_Error:
        Seconds_Behind_Source: 0
                Last_IO_Error:
               Last_SQL_Error:
    Replica_SQL_Running_State: Replica has read all relay log; waiting for more updates
           Retrieved_Gtid_Set: f569bde7-a766-11f1-b95c-66696dea34ab:1-10
            Executed_Gtid_Set: f569bde7-a766-11f1-b95c-66696dea34ab:1-10
                Auto_Position: 1            ← ✅
```

⚠️ **`SOURCE_AUTO_POSITION=1` 的行為值得注意**：
上面的實驗裡，從庫是在**主庫已經有資料之後**才接上的，
而它**自己把 GTID 1-10 全部補完了**（包含 `CREATE DATABASE`、`CREATE TABLE`、`INSERT`）。

```
✅ 這在「主庫剛建好、binlog 還沒被清掉」時很方便
🔴 但正式環境【不能靠這個】——
   主庫的 binlog 只留 7 天，而它的資料是三年前開始累積的
   → 從庫必須先用【備份還原】墊底，再從備份的 GTID 位置接上
```

**正式環境建從庫的正確流程**：

```bash
# ① 從主庫（或另一個從庫）備份，並帶上 GTID 資訊
mysqldump -h primary -u backup -p \
    --single-transaction --skip-lock-tables \
    --set-gtid-purged=ON \          `# 🔴 這裡要 ON（跟 7.2.5 的備份不同）` \
    --routines --events --triggers \
    --all-databases > /tmp/seed.sql

# ② 在新從庫上還原（備份檔開頭的 SET @@GLOBAL.GTID_PURGED 會告訴它「我已經有這些了」）
mysql -h new-replica -u root -p < /tmp/seed.sql

# ③ 接上主庫 —— AUTO_POSITION 會從 GTID_PURGED 之後開始
```

```sql
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='primary', SOURCE_USER='repl', SOURCE_PASSWORD='...',
  SOURCE_AUTO_POSITION=1;
START REPLICA;
```

📌 **`--set-gtid-purged` 的兩種用法別搞混**：

```
建從庫的種子備份    → ON   （要讓從庫知道「這些 GTID 已經包含在資料裡了」）
一般的災難備份      → OFF  （7.2.7：不然還原到同一台機器會報 ERROR 3546）
```

---

### 7.3.3 複製的三個執行緒與兩份日誌

```
        主庫 mysql-m1                          從庫 mysql-m2
   ┌──────────────────────┐            ┌──────────────────────────┐
   │  使用者的交易        │            │                          │
   │        ↓             │            │                          │
   │  寫 binlog           │            │                          │
   │        ↓             │            │                          │
   │  ① Binlog Dump 執行緒 │──── TCP ──→│  ② I/O 執行緒            │
   │    （每個從庫一個）   │            │        ↓                 │
   │                      │            │    寫 relay log          │
   │                      │            │        ↓                 │
   │                      │            │  ③ SQL / Applier 執行緒  │
   │                      │            │    （可以多個 —— 平行複製）│
   │                      │            │        ↓                 │
   │                      │            │    套用到資料 + 寫自己的  │
   │                      │            │    binlog（log-replica-  │
   │                      │            │    updates=ON 時）        │
   └──────────────────────┘            └──────────────────────────┘
```

📌 **拆成 ② ③ 兩段是關鍵設計** ——
I/O 執行緒只負責「把 binlog 抄過來」（很快，通常不會落後），
SQL 執行緒負責「真的執行」（慢，這才是延遲的來源）。

⚠️ **所以「從庫落後」有兩種完全不同的原因**：

```
① I/O 執行緒落後  → 網路頻寬不夠 / 主庫寫入量超過網路
     徵兆：Retrieved_Gtid_Set 遠落後於主庫的 gtid_executed
② SQL 執行緒落後  → 從庫的套用速度跟不上（單執行緒瓶頸、從庫硬體較差、
                     從庫上有大查詢在搶資源、缺索引）
     徵兆：Retrieved_Gtid_Set 追得上，但 Executed_Gtid_Set 落後
     🔴 這是【絕大多數】的情況
```

**分辨它們的一句查詢**：

```sql
SELECT
  (SELECT SUM(GTID_SUBTRACT(Retrieved_Gtid_Set, Executed_Gtid_Set) IS NOT NULL)) AS x
FROM (SELECT 1) t;
-- 上面那句只是示意；實務上直接看 SHOW REPLICA STATUS 的兩個 Gtid_Set 欄位
```

```sql
-- 更好的做法：直接問 performance_schema
SELECT
  (SELECT COUNT(*) FROM performance_schema.replication_connection_status
   WHERE SERVICE_STATE = 'ON')                                AS io_thread_on,
  (SELECT COUNT(*) FROM performance_schema.replication_applier_status_by_worker
   WHERE SERVICE_STATE = 'ON')                                AS applier_workers_on,
  (SELECT LAST_QUEUED_TRANSACTION FROM performance_schema.replication_connection_status)
                                                              AS io_last_queued,
  (SELECT LAST_APPLIED_TRANSACTION
   FROM performance_schema.replication_applier_status_by_worker
   ORDER BY LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP DESC LIMIT 1)
                                                              AS applier_last_applied;
-- 🔴 io_last_queued 與 applier_last_applied 差很多 → 是 ② SQL 執行緒落後
```

✅ **平行複製（多個 applier）是 ② 的主要解法**：

```sql
-- MySQL 8.0 的預設就是 LOGICAL_CLOCK + 4 個 worker
SELECT @@replica_parallel_type, @@replica_parallel_workers,
       @@replica_preserve_commit_order;
```
```
LOGICAL_CLOCK    4    1
```

```
replica_parallel_type = LOGICAL_CLOCK
     用主庫上「哪些交易是同時提交的」來判斷可以平行套用
     🔴 所以主庫的併發度決定了從庫能平行多少 ——
        主庫是單執行緒批次作業的話，從庫也只能單執行緒套用

replica_parallel_workers = 4
     ✅ 可以調高（8 ~ 16），但收益取決於上面那一點

replica_preserve_commit_order = 1
     從庫的提交順序跟主庫一樣
     🔴 一定要保持 ON，否則從庫會出現「主庫上不可能存在的中間狀態」
```

📌 **上面實驗裡的 `replication_applier_status_by_worker` 有 4 列**（4 個 worker），
而其中**只有一列有資料** —— 因為那個實驗的寫入是單執行緒的。

---

### 7.3.4 GTID vs 檔案位置

| | 檔案位置（`binlog.000004:63179228`） | **GTID**（`UUID:87682`） |
|---|---|---|
| 換主庫之後 | 🔴 每台機器的檔名與位置都不同，要人工換算 | ✅ 全域唯一，直接接上 |
| 建從庫 | 要精確記下座標 | ✅ `SOURCE_AUTO_POSITION=1` |
| 跳過一個壞交易 | 🔴 算位置，容易差幾個 byte | ✅ `SET GTID_NEXT` + 空交易 |
| PITR 排除某一句 | 🔴 幾乎做不到（7.2.7） | ✅ `--exclude-gtids` |
| 判斷「兩台機器一不一致」 | 🔴 沒有直接的辦法 | ✅ `GTID_SUBTRACT()` |

```sql
-- 從庫還缺哪些交易？（在從庫上執行，主庫的 gtid_executed 從主庫抓來）
SELECT GTID_SUBTRACT(
  'f569bde7-a766-11f1-b95c-66696dea34ab:1-88121',   -- 主庫的 gtid_executed
  @@GLOBAL.gtid_executed                             -- 從庫自己的
) AS missing_gtids;
-- 空字串 = 完全追上；有內容 = 還缺這些
```

📌 **這一句是「主從一致嗎」最直接的答案**，比 `Seconds_Behind_Source` 可靠得多。

🔴 **`enforce_gtid_consistency=ON` 會禁止三種語句**（值得知道，因為會踩到）：

```
🔴 CREATE TABLE ... SELECT
     → 拆成 CREATE TABLE + INSERT SELECT 兩句（06 章 6.6.3 也建議這樣）
🔴 在交易裡建立 / 刪除【暫存表】（CREATE TEMPORARY TABLE）
     → 把它移到交易外面，或改用衍生表 / CTE（02 章）
🔴 一個交易裡同時更新【交易性表】與【非交易性表】（MyISAM）
     → 不要用 MyISAM
```

---

### 7.3.5 🔴 `Seconds_Behind_Source` 為什麼不能當監控指標 ★★

這是 06 章 6.7.7 那個 `pt-osc --max-lag 2` 的完整答案。

**實驗**：主庫跑一個「插 100 萬列」的**單一交易**，
同時每 1 秒記錄從庫的三個數字。

```sql
-- 主庫（一個交易，實測 7,883 ms）
INSERT INTO ord (order_no, amount, status, placed_at)
SELECT CONCAT('BULK', LPAD(a.n*1000+b.n,10,'0')), 1, 'PAID', NOW(3)
FROM seq a CROSS JOIN seq b;
```

```
時間      從庫 ord 列數   Seconds_Behind   Replica_SQL_Running_State
15:16:38  1,000,200       0                Replica has read all relay log; waiting...
15:16:39  1,000,200       0                Replica has read all relay log; waiting...
15:16:41  1,000,200       0                Replica has read all relay log; waiting...
15:16:43  1,000,200       0                Replica has read all relay log; waiting...
15:16:46  1,000,200       0                Replica has read all relay log; waiting...
15:16:47  1,000,200       0                Replica has read all relay log; waiting...
          ↑ 🔴 主庫已經寫了 9 秒，從庫回報【零延遲】
15:16:48  1,000,200       7                Reading event from the relay log
15:16:50  1,000,200       9                Reading event from the relay log
15:16:52  1,000,200      10                Reading event from the relay log
15:16:55  1,000,200      12                Replica has read all relay log; waiting...
          ↑ 🔴 一邊說「已讀完 relay log」，一邊落後 12 秒
15:16:56  2,000,200       0                Replica has read all relay log; waiting...
          ↑ 列數一次跳 100 萬，延遲瞬間歸零
```

🔴 **三個問題，每一個都足以讓這個指標不能用**：

**問題 1：主庫的交易還沒提交時，`Seconds_Behind_Source` 是 0。**

```
主庫寫了 9 秒（交易還沒 commit）
     → binlog 裡什麼都沒有（binlog 是在 commit 時才寫的）
     → 從庫沒有東西可以落後
     → 🔴 回報 0
```

⚠️ **這代表：`Seconds_Behind_Source = 0` 的意思是
「我把我拿到的都做完了」，不是「我跟主庫一樣」。**
一個正在跑 10 分鐘大交易的主庫，會讓從庫**整整 10 分鐘回報零延遲**，
然後在提交的那一刻突然落後 10 分鐘。

**問題 2：它的定義是「當前套用的事件在主庫上的時間戳，距現在多久」。**

```
所以一個「主庫花 8 秒完成」的交易，
從庫套用它的時候，Seconds_Behind 至少是 8 —— 【就算從庫的套用是瞬間的】
     → 🔴 這個數字混合了「主庫的交易多久」與「從庫落後多久」兩件事
```

**問題 3：它的解析度是【秒】，而且是整數。**

```
真實延遲 900 ms → 回報 0
真實延遲 1.9 秒 → 回報 1
     → 🔴 完全不足以支撐「讀寫分離要不要走從庫」這種毫秒級的決策（7.4）
```

⚠️ **而 `Replica_SQL_Running_State` 說「已讀完 relay log」的同時落後 12 秒，
是因為那兩件事真的都成立** ——
relay log 裡的**事件**都讀完了，但當前正在**套用**的那一個交易還沒做完。

---

**那 MySQL 8.0 的 `performance_schema` 呢？** 它好一些，但也有陷阱。

```sql
SELECT
  TIMESTAMPDIFF(MICROSECOND,
                LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP,
                LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP) / 1000 AS last_txn_e2e_ms,
  TIMESTAMPDIFF(MICROSECOND,
                LAST_APPLIED_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP, NOW(6)) / 1000
                                                                     AS since_last_applied_ms
FROM performance_schema.replication_applier_status_by_worker;
```

```
last_txn_e2e_ms   since_last_applied_ms
8052.1070         57223.2740
      ↑ ✅ 那個大交易「從主庫提交到從庫套用完」的端到端時間 = 8,052 ms（很誠實）
                        ↑ 🔴 57 秒 —— 但那只是因為【之後沒有新交易】
```

📌 **`LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP` 減
`..._ORIGINAL_COMMIT_TIMESTAMP` 是一個很好的指標** ——
它就是「這個交易的複製延遲」，而且是微秒解析度。

🔴 **但 `NOW() - ORIGINAL_COMMIT_TIMESTAMP` 不是延遲指標** ——
實測它在從庫追上之後**一路爬到 32 秒**，因為主庫閒著、沒有新交易可以更新它。

⚠️ **所以 `performance_schema` 的指標回答的是「上一個交易的延遲是多少」，
而不是「現在的延遲是多少」。** 主庫閒置時，這兩個問題的答案不一樣。

---

### 7.3.6 心跳表：唯一可靠的延遲指標 ★

📌 **既然「主庫閒置時量不到延遲」，那就**讓主庫不要閒著****。

```sql
-- 主庫：一張只有一列的心跳表
CREATE DATABASE IF NOT EXISTS ops;
CREATE TABLE ops.heartbeat (
  id     TINYINT     NOT NULL PRIMARY KEY,
  ts     DATETIME(6) NOT NULL,
  src_id INT         NOT NULL
) ENGINE=InnoDB;

INSERT INTO ops.heartbeat (id, ts, src_id) VALUES (1, NOW(6), @@server_id)
  ON DUPLICATE KEY UPDATE ts = NOW(6);
```

```bash
# 主庫上一個常駐的 200 ms 迴圈（或用 pt-heartbeat）
while true; do
  mysql -h primary -u ops -p... -e "UPDATE ops.heartbeat SET ts = NOW(6) WHERE id = 1;"
  sleep 0.2
done
```

```sql
-- 🔴 在【從庫】上量延遲 —— 一句話，微秒解析度，永遠有效
SELECT TIMESTAMPDIFF(MICROSECOND, ts, NOW(6)) / 1000 AS lag_ms
FROM ops.heartbeat WHERE id = 1;
```

**實測**（心跳間隔 200 ms）：

```
=== 主庫閒著時 ===
心跳延遲 = 296.7 ms
心跳延遲 = 184.8 ms
心跳延遲 =  76.7 ms
     ↑ 這 77 ~ 297 ms 是【心跳間隔本身】的鋸齒，不是真的延遲
       （心跳每 200 ms 才更新一次，所以讀到的值在 0 ~ 200 ms + 複製延遲之間跳）
```

```
=== 主庫跑大交易時 ===
時間      Seconds_Behind    🔴 心跳延遲
15:17:53  0                 58 ms
15:17:54  0                 82 ms
15:17:57  1                 143 ms
15:18:00  1                 315 ms
15:18:00  0                 86 ms
15:18:01  7                 428 ms      ← 開始爬
15:18:02  8                 1,076 ms
15:18:03  9                 2,323 ms
15:18:04  10                3,567 ms
15:18:05  11                4,850 ms
15:18:06  12                5,480 ms
15:18:07  13                6,129 ms
```

📌 **兩種指標的差別一目了然**：

```
Seconds_Behind ：0 → 0 → 1 → 0 → 7 → 8 → 9 ...   跳動、整數、會回報 0
心跳延遲       ：58 → 82 → 143 → 428 → 1076 → ... 平滑、毫秒、單調上升
```

✅ **心跳延遲可以直接當**：

```
① 監控告警的指標（> 1 秒告警、> 5 秒呼叫）
② 🔴 讀寫分離「這個查詢能不能走從庫」的判斷依據（7.4.3）
③ pt-osc / gh-ost 的 --max-lag 依據（06 章 6.7.7）
④ 「從庫可不可以拿來當備份來源」的判斷
```

⚠️ **心跳表的四個實務細節**：

```
🔴 心跳間隔決定了指標的解析度下限 ——
     200 ms 的心跳量不出「50 ms 的延遲」。要更細就要更密（但寫入量也上升）
🔴 心跳的 UPDATE 本身會進 binlog ——
     每秒 5 次 × 86400 = 43 萬個交易/天。binlog 會多一些，但很小（每筆幾十 bytes）
🔴 主從的【系統時鐘】必須同步（NTP）——
     時鐘差 500 ms，你的延遲指標就差 500 ms
     ✅ 用 src_id 欄位記下是哪一台寫的，可以在多主環境裡分辨
🔴 心跳表要排除在備份與 CDC 之外（不然它會污染資料）
```

📌 **`pt-heartbeat`（percona-toolkit）就是這件事的成品**：

```bash
# 主庫上：每 100 ms 打一次心跳
pt-heartbeat --host=primary --user=ops --ask-pass \
  --database=ops --table=heartbeat --update --interval=0.1 --daemonize

# 從庫上：直接印出延遲
pt-heartbeat --host=replica --user=ops --ask-pass \
  --database=ops --table=heartbeat --monitor
```

---

### 7.3.7 🔴 `read_only` 擋不住 `root` ★★

**這是「以為有、其實沒有」的最典型例子。**

```sql
-- 從庫的設定
SELECT @@read_only, @@super_read_only;
```
```
@@read_only  @@super_read_only
1            0
```

**用 `root` 在這個「唯讀」的從庫上寫一筆**：

```sql
INSERT INTO shop.ord (order_no, amount, status, placed_at)
VALUES ('ROGUE', 999, 'PAID', NOW(3));
```

```sql
SELECT id, order_no, amount FROM shop.ord;
```
```
id  order_no  amount
1   A1        100.0000
3   ROGUE     999.0000      ← 🔴 【成功了】
```

```sql
-- 主庫上有這一列嗎？
SELECT id, order_no FROM shop.ord;
```
```
id  order_no
1   A1                      ← 🔴 沒有。從庫多了一列主庫沒有的資料。
```

---

**而傷害不只是「多一列」。看 GTID**：

```sql
-- 主庫
SELECT @@GLOBAL.gtid_executed;
```
```
f569bde7-a766-11f1-b95c-66696dea34ab:1-10
```

```sql
-- 從庫
SELECT @@GLOBAL.gtid_executed;
```
```
f569bde7-a766-11f1-b95c-66696dea34ab:1-10,
f5790d4f-a766-11f1-aa5e-5e5d74183fa6:1-8
                    ↑ 🔴 從庫【自己的 UUID】—— 一組主庫永遠不會有的 GTID
```

🔴 **這叫 GTID 分岔（divergence），而它是永久的。** 後果：

```
🔴 這個從庫【不能】被提升成主庫 ——
     提升之後，其他從庫會發現主庫有一些「它們永遠拿不到」的 GTID
🔴 主庫【不能】反過來從它複製（雙主 / 切換回來）
🔴 GTID_SUBTRACT 的一致性檢查（7.3.4）永遠是「不一致」
🔴 而修法只有兩個：重建這個從庫，或用 RESET MASTER 之類的手段人工清掉
     （後者風險極高，等於「假裝那些交易不存在」）
```

---

**正確的設定是 `super_read_only`**：

```sql
SET GLOBAL super_read_only = ON;      -- 這會同時把 read_only 設成 ON
SELECT @@read_only, @@super_read_only;
```
```
1    1
```

```sql
INSERT INTO shop.ord (order_no, amount, status, placed_at) VALUES ('X2', 1, 'PAID', NOW(3));
```
```
🔴 ERROR 1290 (HY000): The MySQL server is running with the --super-read-only option
   so it cannot execute this statement
```

**對照：一個【沒有 SUPER 權限】的普通應用帳號，`read_only` 就擋得住**：

```sql
CREATE USER 'shop_app'@'%' IDENTIFIED BY 'apppass';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'shop_app'@'%';
```
```
-- 用 shop_app 在 read_only=1（super_read_only=0）的從庫上 INSERT
ERROR 1290 (HY000): The MySQL server is running with the --read-only option
so it cannot execute this statement
```

📌 **整理成一張表**：

| 帳號 | `read_only=1`<br>`super_read_only=0` | `super_read_only=1` |
|---|---|---|
| 一般帳號（無 `SUPER`／`CONNECTION_ADMIN`） | ✅ 擋住（`ERROR 1290`） | ✅ 擋住 |
| `root` / 有 `SUPER` / `CONNECTION_ADMIN` | 🔴 **寫得進去** | ✅ 擋住（`ERROR 1290`） |
| 複製的 applier 執行緒 | ✅ 照樣套用 | ✅ 照樣套用 |

⚠️ **最後一列很重要**：`super_read_only=ON` **不會**擋住複製 ——
它只擋「用戶端的寫入」。所以它是安全的預設值。

✅ **從庫的設定應該是**：

```ini
# my.cnf（從庫）
super_read_only = ON            # 🔴 不是 read_only
```

```bash
# Docker 的啟動參數
--super-read-only=ON
```

🔴 **而故障切換（failover）時要記得把它關掉** ——
這正是切換腳本最常漏掉的一行（7.5）。

📌 **順帶一提：這也是為什麼 06 章 6.10.2 堅持「應用帳號不要有多餘權限」。**
如果你的應用連的是 `root`，那麼「把從庫設成唯讀」這道防線**根本不存在**。

---

### 7.3.8 複製中斷的排查與修復

**先看症狀。三種完全不同的情況**：

```sql
SHOW REPLICA STATUS\G
```

| 症狀 | 意思 |
|---|---|
| `Replica_IO_Running: No` | 連不上主庫（網路、帳號密碼、主庫掛了、`server-id` 撞號） |
| `Replica_SQL_Running: No` + `Last_SQL_Error` 有內容 | **套用某一個事件時失敗** —— 最常見 |
| 兩個都 `Yes`，但延遲一直增加 | 套用跟不上（7.3.5 的問題 ②） |

---

**最常見的中斷：從庫套用時撞到重複鍵。**

```
Last_SQL_Error: Could not execute Write_rows event on table shop.ord;
                Duplicate entry 'A1' for key 'ord.uk_order_no',
                Error_code: 1062; handler error HA_ERR_FOUND_DUPP_KEY;
                the event's source log binlog.000004, end_log_pos 1234
```

🔴 **這幾乎總是 7.3.7 的後果** —— 有人在從庫上寫過東西。

📌 **排查的第一步永遠是「搞清楚差在哪」，不是「跳過它」**：

```sql
-- ① 卡在哪一個交易？
SELECT
  LAST_ERROR_NUMBER, LAST_ERROR_MESSAGE, LAST_ERROR_TIMESTAMP,
  APPLYING_TRANSACTION                       -- 🔴 卡住的那個 GTID
FROM performance_schema.replication_applier_status_by_worker
WHERE LAST_ERROR_NUMBER <> 0\G
```

```sql
-- ② 那個交易在主庫上做了什麼？（去主庫查）
SHOW BINLOG EVENTS IN 'binlog.000004' FROM 1000 LIMIT 20;
-- 或用 mysqlbinlog --include-gtids=<那個 GTID> --verbose --base64-output=DECODE-ROWS
```

```sql
-- ③ 從庫現在的那一列長什麼樣？跟主庫比
SELECT * FROM shop.ord WHERE order_no = 'A1';
```

---

**三種修法，風險由低到高**：

**修法 1（✅ 推薦）：重建從庫。**

```
✅ 唯一保證「之後一定一致」的做法
✅ 用 7.3.2 的種子備份流程，20 分鐘的事
🔴 大資料庫要幾小時 —— 而這正是「為什麼要有第三台從庫」的理由
```

**修法 2（🟡 有條件）：修好衝突的資料，讓它繼續。**

```sql
-- 只有在你【完全確定】從庫那一列是錯的、主庫那一列是對的時候
STOP REPLICA;
DELETE FROM shop.ord WHERE order_no = 'A1';      -- 清掉從庫多出來的
START REPLICA;
```

✅ 這個做法是「讓複製自己把正確的資料放進來」，所以結果是一致的。

**修法 3（🔴 最後手段）：跳過那個交易。**

```sql
-- GTID 模式下：用一個【空交易】佔掉那個 GTID
STOP REPLICA;
SET GTID_NEXT = 'f569bde7-a766-11f1-b95c-66696dea34ab:87682';
BEGIN; COMMIT;                       -- 空交易 —— 等於宣告「這個 GTID 我做過了」
SET GTID_NEXT = 'AUTOMATIC';
START REPLICA;
```

🔴 **這個做法的代價要說清楚**：

```
🔴 你【永久放棄】了那個交易的資料變更 —— 主從從此不一致
🔴 而且不一致的內容【沒有任何地方記錄】—— 三個月後沒有人知道
✅ 用它之前一定要：① 先把那個交易的內容存下來（mysqlbinlog --include-gtids）
                   ② 在工單裡寫下「哪個 GTID、內容是什麼、為什麼決定跳過」
                   ③ 排一次資料比對（pt-table-checksum）
```

⚠️ **舊做法 `SET GLOBAL sql_slave_skip_counter = 1` 在 GTID 模式下【不能用】** ——
會報 `ERROR 1858: sql_slave_skip_counter can not be set when @@GLOBAL.GTID_MODE = ON`。

---

**驗證主從一致：`pt-table-checksum`**

```bash
# 在【主庫】上跑；它會逐塊算 checksum 並透過複製傳到從庫比對
docker run --rm --network mysqlrepl percona/percona-toolkit \
  pt-table-checksum \
    --host=mysql-m1 --user=root --password=root \
    --databases=shop \
    --chunk-size=1000 \
    --max-load="Threads_running=40" \
    --no-check-binlog-format
```

```
TS  ERRORS  DIFFS  ROWS  DIFF_ROWS  CHUNKS  SKIPPED  TIME  TABLE
...      0      0  ...           0     ...        0   ...  shop.ord
                ↑ 🔴 DIFFS 不是 0 就代表主從不一致
```

⚠️ **本章沒有實測 `pt-table-checksum`** ——
它需要一個乾淨的、沒有 GTID 分岔的複製環境，
而本章的實驗環境在 7.3.7 的實驗之後就已經分岔了。
**上面的用法來自它的文件。**

📌 **實務上這個檢查應該每週跑一次**，而且要在低峰時段
（它會在主庫上跑很多小交易，並且靠複製傳到從庫）。

---

## 7.4 讀寫分離

### 7.4.1 🔴 讀己之寫：實測 100% 失敗 ★★

這是本章開場那第二組數字的完整版。

**環境**：一主一從，**同一台機器上的兩個 Docker 容器**（網路延遲接近零），
心跳量到的延遲是 **1 毫秒**。

**測試**：200 次「寫主庫 → 立刻讀從庫」——
也就是每一個「送出表單之後跳轉到詳細頁」的流程。

```java
public class ReadYourWrites {
    static final String M = "jdbc:mysql://127.0.0.1:3350/shop?user=root&password=root";
    static final String R = "jdbc:mysql://127.0.0.1:3351/shop?user=root&password=root";

    public static void main(String[] args) throws Exception {
        int n = Integer.parseInt(args.length > 0 ? args[0] : "200");
        int stale = 0, ok = 0;
        long maxLagMs = 0, sumLagMs = 0;

        try (Connection m = DriverManager.getConnection(M);
             Connection r = DriverManager.getConnection(R)) {

            var ins = m.prepareStatement(
                "INSERT INTO ord (order_no, amount, status, placed_at) VALUES (?,?,?,NOW(3))");
            var sel = r.prepareStatement("SELECT id FROM ord WHERE order_no = ?");

            for (int i = 0; i < n; i++) {
                String no = "RYW-" + System.nanoTime();

                // ① 寫主庫（提交）
                ins.setString(1, no);
                ins.setBigDecimal(2, new java.math.BigDecimal("10.00"));
                ins.setString(3, "PAID");
                ins.executeUpdate();
                long t0 = System.nanoTime();

                // ② 立刻讀從庫 —— 就像「下單成功後跳轉到訂單頁」
                sel.setString(1, no);
                boolean found;
                try (var rs = sel.executeQuery()) { found = rs.next(); }

                if (found) { ok++; continue; }

                // ③ 沒讀到 —— 對使用者來說就是「我的訂單不見了」
                stale++;
                while (true) {                       // 量它多久才出現
                    sel.setString(1, no);
                    try (var rs = sel.executeQuery()) { if (rs.next()) break; }
                    if ((System.nanoTime() - t0) / 1_000_000 > 5000) break;
                }
                long lag = (System.nanoTime() - t0) / 1_000_000;
                sumLagMs += lag;
                if (lag > maxLagMs) maxLagMs = lag;
            }
        }
        System.out.printf("寫主庫後立刻讀從庫 %d 次：%n", n);
        System.out.printf("  ✅ 讀到了      %d 次（%.1f%%）%n", ok, 100.0 * ok / n);
        System.out.printf("  🔴 讀不到      %d 次（%.1f%%）%n", stale, 100.0 * stale / n);
        if (stale > 0)
            System.out.printf("  讀不到的那些：平均 %d ms 後出現，最久 %d ms%n",
                    sumLagMs / stale, maxLagMs);
    }
}
```

```
寫主庫後立刻讀從庫 200 次：
  ✅ 讀到了      0 次（0.0%）
  🔴 讀不到    200 次（100.0%）
  讀不到的那些：平均 1 ms 後出現，最久 12 ms
```

🔴 **100%。**

📌 **這個結果的意義，比「100%」這個數字本身更重要**：

```
很多人的直覺是：「從庫延遲只有 1 ms，所以讀到舊資料的機率很低」
                              ↓
實際上：機率 = P(讀取發生在延遲視窗內)
              而「寫完立刻讀」的意思就是「讀取發生在 0 ms」
                              ↓
        🔴 只要延遲 > 0，這個機率就是 100%
```

⚠️ **而且「延遲小」讓問題【更難發現】，不是更少發生**：

```
延遲 1 ms  → 100% 失敗，但「重新整理一下就好了」→ 使用者不回報，你不知道
延遲 2 秒  → 100% 失敗，而且重新整理也還在 → 使用者回報，你會知道
```

📌 **所以「本機測起來沒問題」在這一章也成立**（05 章的主題）——
本機開發通常只有一個資料庫，**根本沒有從庫可以讀錯**。
這個 bug 只在有讀寫分離的環境出現，而那通常是**測試環境或正式環境**。

---

### 7.4.2 GTID 等待：100% → 0%，成本 1.12 ms ★★

MySQL 內建的解法：**在從庫上等到「包含我剛剛那個交易」的 GTID 都套用完，才讀。**

```sql
-- 在【從庫】上執行。第二個參數是逾時秒數。
-- 回傳 0 = 等到了；非 0 = 逾時（這時應該退回主庫）
SELECT WAIT_FOR_EXECUTED_GTID_SET('f569bde7-...:1-88121', 1);
```

```java
/**
 * 「讀己之寫」的 GTID 解法：
 *   ① 在主庫寫完之後，問主庫「目前的 gtid_executed 是什麼」
 *   ② 到從庫上呼叫 WAIT_FOR_EXECUTED_GTID_SET(gtid, timeout) 等它追上
 *   ③ 追上了才讀
 */
public class ReadYourWritesFixed {
    static final String M = "jdbc:mysql://127.0.0.1:3350/shop?user=root&password=root";
    static final String R = "jdbc:mysql://127.0.0.1:3351/shop?user=root&password=root";

    public static void main(String[] args) throws Exception {
        int n = Integer.parseInt(args.length > 0 ? args[0] : "200");
        int stale = 0, ok = 0, timedOut = 0;
        long sumWaitUs = 0, maxWaitUs = 0;

        try (Connection m = DriverManager.getConnection(M);
             Connection r = DriverManager.getConnection(R)) {

            var ins = m.prepareStatement(
                "INSERT INTO ord (order_no, amount, status, placed_at) VALUES (?,?,?,NOW(3))");
            // 🔴 沒有 @@SESSION.gtid_executed 這個變數（會報 "is a GLOBAL variable"）。
            //    用 @@GLOBAL.gtid_executed —— 它是「主庫目前已執行的全部 GTID」，
            //    包含別人的交易，所以等它是【比需要的更強】的保證（但正確）。
            var gtidQ = m.prepareStatement("SELECT @@GLOBAL.gtid_executed");
            var wait  = r.prepareStatement("SELECT WAIT_FOR_EXECUTED_GTID_SET(?, 1)");
            var sel   = r.prepareStatement("SELECT id FROM ord WHERE order_no = ?");

            for (int i = 0; i < n; i++) {
                String no = "RYWF-" + System.nanoTime();
                ins.setString(1, no);
                ins.setBigDecimal(2, new java.math.BigDecimal("10.00"));
                ins.setString(3, "PAID");
                ins.executeUpdate();

                // ① 拿到「包含我剛剛那個交易」的 GTID 集合
                String gtid;
                try (var rs = gtidQ.executeQuery()) { rs.next(); gtid = rs.getString(1); }

                // ② 在從庫上等它
                long t0 = System.nanoTime();
                int rc;
                wait.setString(1, gtid);
                try (var rs = wait.executeQuery()) { rs.next(); rc = rs.getInt(1); }
                long waitUs = (System.nanoTime() - t0) / 1000;
                sumWaitUs += waitUs;
                if (waitUs > maxWaitUs) maxWaitUs = waitUs;
                if (rc != 0) timedOut++;      // 非 0 = 逾時，這時應該退回主庫

                // ③ 才讀
                sel.setString(1, no);
                try (var rs = sel.executeQuery()) { if (rs.next()) ok++; else stale++; }
            }
        }
        System.out.printf("先等 GTID 再讀從庫 %d 次：%n", n);
        System.out.printf("  ✅ 讀到了  %d 次（%.1f%%）%n", ok, 100.0 * ok / n);
        System.out.printf("  🔴 讀不到  %d 次（%.1f%%）%n", stale, 100.0 * stale / n);
        System.out.printf("  等待逾時   %d 次%n", timedOut);
        System.out.printf("  等待時間：平均 %.2f ms，最久 %.2f ms%n",
                sumWaitUs / 1000.0 / n, maxWaitUs / 1000.0);
    }
}
```

**實測**：

```
先等 GTID 再讀從庫 200 次：
  ✅ 讀到了  200 次（100.0%）
  🔴 讀不到    0 次（0.0%）
  等待逾時     0 次
  等待時間：平均 1.12 ms，最久 4.69 ms
```

✅ **100% 失敗 → 0% 失敗，成本是平均 1.12 毫秒的等待。**

---

📌 **`WAIT_FOR_EXECUTED_GTID_SET` 的四個實務細節**：

**① 沒有 `@@SESSION.gtid_executed`。**

```sql
SELECT @@SESSION.gtid_executed;
```
```
🔴 ERROR: Variable 'gtid_executed' is a GLOBAL variable
```

所以要用 `@@GLOBAL.gtid_executed`。
它包含**別人的交易**，所以等它是「比需要的更嚴格」——
✅ 正確，但在高寫入量的主庫上會等久一點。

⚠️ **更精確的做法是用 `session_track_gtids = OWN_GTID`**，
讓驅動從協定的「工作階段狀態追蹤」裡拿到「只屬於這個 session 的 GTID」。
🔴 但那需要驅動層的支援（mysql-connector-j 的 `SessionStateChanges` API），
而**本章沒有實測那條路徑**。

**② 逾時參數不能省，而且要短。**

```java
"SELECT WAIT_FOR_EXECUTED_GTID_SET(?, 1)"     // 1 秒
```

🔴 **不給第二個參數 = 無限期等待** ——
從庫掛掉或落後 10 分鐘時，你的每一個請求都會卡住。
✅ 逾時後 `rc != 0`，這時要**退回主庫**，不要「再等一下」。

**③ 它只保證「我的寫入看得到」，不保證「最新」。**

```
✅ 保證：我剛剛寫的東西讀得到（read-your-writes / 讀己之寫）
🔴 不保證：別人在我等待期間寫的東西讀得到
     —— 但那本來也不是讀寫分離該保證的事（那是 linearizability）
```

**④ 它不是免費的。**

```
每一次「寫後讀」都多了：一次主庫的 SELECT @@GLOBAL.gtid_executed
                       + 一次從庫的 WAIT_FOR_EXECUTED_GTID_SET
                       ≈ 兩次網路往返 + 1.12 ms
```

📌 **所以它應該只用在「真的需要讀己之寫」的路徑上**，
而不是每一個查詢都套 —— 這就是下一節路由設計的核心。

---

📌 **除了 GTID 等待，還有兩種常見解法**：

| 解法 | 做法 | 優點 | 缺點 |
|---|---|---|---|
| **GTID 等待** | 上面那樣 | ✅ 精確、不浪費 | 每次多 ~1 ms 與兩次往返 |
| **黏著主庫（sticky）** | 寫入後把這個使用者/session 的讀取「黏」到主庫 N 秒 | ✅ 實作最簡單 | 🔴 N 怎麼定？太短會漏、太長主庫壓力回來 |
| **交易內讀寫都走主庫** | `@Transactional`（非唯讀）內的讀取一律走主庫 | ✅ 幾乎零成本、涵蓋大部分情況 | 🔴 不涵蓋「交易結束之後的下一個請求」 |

✅ **實務上這三個是【疊起來用】的**：

```
① 交易內的讀取一律走主庫             ← 最便宜，涵蓋 80%
② 寫入後的同一個請求剩下的讀取走主庫 ← 涵蓋「commit 後又讀一次」
③ 需要跨請求讀己之寫的地方，用 GTID 等待  ← 涵蓋「下單後跳轉」
```

---

### 7.4.3 Spring 的實作

以下是**編譯過**的完整實作（Spring 6.1.14 / JDK 21）。
四個檔案，各自負責一件事。

**① `DbRole` / `DbRoleContext`：記著「這一次要走哪一邊」**

```java
package lab7.rw;

/** 這一次資料庫存取要走哪一邊。 */
public enum DbRole { PRIMARY, REPLICA }
```

```java
package lab7.rw;

/**
 * 用 ThreadLocal 記著「當前執行緒該走哪一邊」。
 *
 * 🔴 三個必須知道的限制：
 *   ① 換執行緒就失效 —— @Async、CompletableFuture、Reactor 都會換
 *   ② 一定要在 finally 裡還原，否則執行緒池會把值帶給下一個請求
 *   ③ 巢狀呼叫要能還原上一層的值 —— 所以 set 回傳「舊值」讓呼叫端還原
 */
public final class DbRoleContext {

    private static final ThreadLocal<DbRole> CURRENT = new ThreadLocal<>();

    private DbRoleContext() {}

    /** 設定角色，回傳原本的值（給巢狀呼叫還原用；可能是 null）。 */
    public static DbRole set(DbRole role) {
        DbRole previous = CURRENT.get();
        CURRENT.set(role);
        return previous;
    }

    /** 還原成先前的值；傳 null 代表清掉。 */
    public static void restore(DbRole previous) {
        if (previous == null) CURRENT.remove();
        else CURRENT.set(previous);
    }

    /** 沒有明確指定時，預設走主庫 —— 🔴 預設值必須是【安全的那一邊】。 */
    public static DbRole current() {
        DbRole r = CURRENT.get();
        return r == null ? DbRole.PRIMARY : r;
    }

    public static void clear() { CURRENT.remove(); }
}
```

**② `RoutingDataSource`：真正選連線的地方**

```java
package lab7.rw;

import org.springframework.jdbc.datasource.lookup.AbstractRoutingDataSource;

import javax.sql.DataSource;
import java.util.Map;

/**
 * 讀寫分離的資料源：每次 getConnection() 時依 DbRoleContext 決定要拿哪一個。
 *
 * ⚠️ AbstractRoutingDataSource 是在【取連線的那一刻】決定的 ——
 *    所以路由的決定必須在 @Transactional 進入之前就設好（見 DbRoleAspect）。
 */
public class RoutingDataSource extends AbstractRoutingDataSource {

    public RoutingDataSource(DataSource primary, DataSource replica) {
        setDefaultTargetDataSource(primary);              // 🔴 預設是主庫
        setTargetDataSources(Map.of(
                DbRole.PRIMARY, primary,
                DbRole.REPLICA, replica));
        afterPropertiesSet();
    }

    @Override
    protected Object determineCurrentLookupKey() {
        return DbRoleContext.current();
    }
}
```

**③ `ReadFromReplica` + `DbRoleAspect`：明確地選擇走從庫**

```java
package lab7.rw;

import java.lang.annotation.*;

/**
 * 標在方法上，代表「這個方法的查詢可以走從庫」。
 *
 * 🔴 刻意做成【選擇性加入（opt-in）】，而不是「@Transactional(readOnly=true) 就自動走從庫」——
 *    因為 7.4.4 列的那六種讀取【不能】走從庫，而它們也常常是 readOnly 的。
 *    預設安全、明確地選擇冒險，比反過來好。
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface ReadFromReplica {

    /** 這個查詢最多能容忍多少毫秒的從庫延遲；超過就退回主庫。0 = 不檢查。 */
    long maxLagMillis() default 1000;
}
```

```java
package lab7.rw;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Pointcut;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

/**
 * 把 @ReadFromReplica 轉成 DbRoleContext 的設定。
 *
 * 🔴 @Order 必須小於 Spring 交易攔截器的 order（預設 Ordered.LOWEST_PRECEDENCE），
 *    這個切面才會在【交易開始之前】跑 —— 否則連線已經拿了，路由就來不及了。
 */
@Aspect
@Order(Ordered.HIGHEST_PRECEDENCE)
public class DbRoleAspect {

    private static final Logger log = LoggerFactory.getLogger(DbRoleAspect.class);

    private final ReplicaLagMonitor lagMonitor;

    public DbRoleAspect(ReplicaLagMonitor lagMonitor) {
        this.lagMonitor = lagMonitor;
    }

    @Pointcut("@annotation(readFromReplica)")
    public void replicaRead(ReadFromReplica readFromReplica) {}

    @Around(value = "replicaRead(readFromReplica)", argNames = "pjp,readFromReplica")
    public Object route(ProceedingJoinPoint pjp, ReadFromReplica readFromReplica) throws Throwable {
        DbRole target = decide(readFromReplica, pjp);
        DbRole previous = DbRoleContext.set(target);
        try {
            return pjp.proceed();
        } finally {
            DbRoleContext.restore(previous);   // 🔴 一定要還原（限制 ②③）
        }
    }

    private DbRole decide(ReadFromReplica ann, ProceedingJoinPoint pjp) {
        long budget = ann.maxLagMillis();
        if (budget <= 0) return DbRole.REPLICA;

        long lag = lagMonitor.currentLagMillis();
        if (lag < 0) {                                   // 量不到延遲 → 當作不健康
            log.warn("讀不到從庫延遲，{} 退回主庫", pjp.getSignature().toShortString());
            return DbRole.PRIMARY;
        }
        if (lag > budget) {
            log.warn("從庫延遲 {} ms 超過預算 {} ms，{} 退回主庫",
                    lag, budget, pjp.getSignature().toShortString());
            return DbRole.PRIMARY;
        }
        return DbRole.REPLICA;
    }
}
```

**④ `ReplicaLagMonitor`：接上 7.3.6 的心跳表**

```java
package lab7.rw;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 用心跳表量從庫延遲（7.3.6 實測：這是唯一連續、毫秒級、且不會在閒置時亂跳的做法）。
 *
 * 🔴 不要用 SHOW REPLICA STATUS 的 Seconds_Behind_Source ——
 *    7.3.5 實測：主庫的大交易還沒提交時它讀到 0，提交後才跳到 12。
 */
public class ReplicaLagMonitor {

    private static final Logger log = LoggerFactory.getLogger(ReplicaLagMonitor.class);

    /** -1 代表「量不到」—— 呼叫端要把它當成「不健康」而不是「延遲 0」。 */
    private final AtomicLong lagMillis = new AtomicLong(-1);

    private final JdbcTemplate replicaJdbc;

    public ReplicaLagMonitor(DataSource replica) {
        this.replicaJdbc = new JdbcTemplate(replica);
    }

    public long currentLagMillis() { return lagMillis.get(); }

    /** 由排程每 200 ~ 500 ms 呼叫一次。 */
    public void refresh() {
        try {
            Long ms = replicaJdbc.queryForObject("""
                    SELECT TIMESTAMPDIFF(MICROSECOND, ts, NOW(6)) / 1000
                    FROM ops.heartbeat WHERE id = 1""", Long.class);
            lagMillis.set(ms == null ? -1L : Math.max(0L, ms));
        } catch (Exception e) {
            log.warn("量從庫延遲失敗，標記為不健康", e);
            lagMillis.set(-1L);
        }
    }
}
```

**組裝**：

```java
package lab7.rw;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.jdbc.datasource.LazyConnectionDataSourceProxy;

import javax.sql.DataSource;

@Configuration
@EnableScheduling
public class ReadWriteSplitConfig {

    private DataSource pool(String url, String user, String password, int max, boolean readOnly) {
        var cfg = new HikariConfig();
        cfg.setJdbcUrl(url);
        cfg.setUsername(user);
        cfg.setPassword(password);
        cfg.setMaximumPoolSize(max);
        cfg.setReadOnly(readOnly);
        cfg.setConnectionTimeout(3000);
        // 05 章 5.10.2 的七層逾時 + 06 章 6.7.5 的 MDL 逾時
        cfg.setConnectionInitSql(
                "SET SESSION innodb_lock_wait_timeout = 5, lock_wait_timeout = 5");
        return new HikariDataSource(cfg);
    }

    @Bean DataSource primaryDataSource(
            @Value("${db.primary.url}") String url,
            @Value("${db.primary.user}") String user,
            @Value("${db.primary.password}") String pw) {
        return pool(url, user, pw, 16, false);
    }

    @Bean DataSource replicaDataSource(
            @Value("${db.replica.url}") String url,
            @Value("${db.replica.user}") String user,
            @Value("${db.replica.password}") String pw) {
        return pool(url, user, pw, 32, true);   // 從庫的池可以大一些
    }

    @Bean ReplicaLagMonitor replicaLagMonitor(DataSource replicaDataSource) {
        return new ReplicaLagMonitor(replicaDataSource);
    }

    /** 每 200 ms 更新一次延遲讀數（跟 7.3.6 的心跳間隔一致）。 */
    @Bean LagRefresher lagRefresher(ReplicaLagMonitor m) { return new LagRefresher(m); }

    static class LagRefresher {
        private final ReplicaLagMonitor m;
        LagRefresher(ReplicaLagMonitor m) { this.m = m; }
        @Scheduled(fixedDelay = 200) void tick() { m.refresh(); }
    }

    @Bean DbRoleAspect dbRoleAspect(ReplicaLagMonitor m) { return new DbRoleAspect(m); }

    /**
     * 🔴 LazyConnectionDataSourceProxy 是關鍵的一層。
     *
     * 沒有它：Spring 的交易管理器在【開始交易時】就取連線 ——
     *        而那時候某些路由決定（例如 @Transactional(readOnly=true) 的判斷）還沒發生。
     * 有了它：連線的取得延後到【第一次真的要下 SQL】的時候，
     *        於是 RoutingDataSource.determineCurrentLookupKey() 才看得到正確的 DbRole。
     */
    @Bean @Primary
    DataSource dataSource(DataSource primaryDataSource, DataSource replicaDataSource) {
        var routing = new RoutingDataSource(primaryDataSource, replicaDataSource);
        return new LazyConnectionDataSourceProxy(routing);
    }
}
```

**用起來**：

```java
@Service
public class OrderQueryService {

    private final OrderRepository repo;

    public OrderQueryService(OrderRepository repo) { this.repo = repo; }

    /** ✅ 走從庫：報表型查詢，容忍 5 秒延遲 */
    @ReadFromReplica(maxLagMillis = 5000)
    @Transactional(readOnly = true)
    public List<DailyRevenue> monthlyReport(YearMonth month) {
        return repo.aggregateDaily(month.atDay(1), month.atEndOfMonth());
    }

    /** ✅ 走從庫：商品列表，容忍 1 秒 */
    @ReadFromReplica
    @Transactional(readOnly = true)
    public Page<OrderSummary> browse(Pageable page) {
        return repo.findAllSummaries(page);
    }

    /** 🔴 【不加】@ReadFromReplica：下單後跳轉的訂單詳細頁（7.4.1 的 100% 失敗） */
    @Transactional(readOnly = true)
    public OrderDetail detailAfterCheckout(UUID orderId) {
        return repo.findDetail(orderId);
    }
}
```

⚠️ **`@ReadFromReplica` 與 `@Transactional` 的順序**：
`DbRoleAspect` 的 `@Order(HIGHEST_PRECEDENCE)` 保證它在交易攔截器**外面**，
所以 `DbRoleContext` 在交易開始前就設好了。
✅ 加上 `LazyConnectionDataSourceProxy`，這兩層就都安全了。

---

### 7.4.4 六種讀取不能走從庫

📌 **這一節是「為什麼路由要做成明確選擇加入」的全部理由。**

**① 寫入後同一個流程裡的讀取**（7.4.1 實測 100% 失敗）

```
下單 → 跳轉訂單頁
付款 → 顯示付款結果
上傳 → 顯示上傳清單
```

**② 「檢查後寫入」的檢查那一半**

```java
// 🔴 這個檢查走從庫 = 檢查了一份過時的資料
if (!repo.existsByEmail(email)) {      // 走從庫 → 讀到「還不存在」
    repo.save(new Customer(email));    // 走主庫 → 🔴 Duplicate entry
}
```

⚠️ **而且這個 bug 的正確修法不是「改走主庫」** ——
04 章講過：**「檢查後寫入」在併發下本來就是錯的**，
正解是唯一索引 + 捕捉 `ERROR 1062`。
📌 **讀寫分離只是把這個既有的錯誤放大到「一定會發生」。**

**③ 任何交易裡的讀取（非唯讀交易）**

```java
@Transactional     // 不是 readOnly
public void ship(UUID orderId) {
    Order o = repo.findById(orderId);     // 🔴 這個讀取必須走主庫
    o.markShipped();                       //    不然你是基於過時資料做決定
    repo.save(o);
}
```

✅ **`@Transactional`（非唯讀）的讀取一律走主庫** —— 這是預設值該保護的情況。

**④ 樂觀鎖與版本號的讀取**

```java
// 01 章的 version 欄位
Order o = repo.findById(id);        // 🔴 從從庫讀到舊的 version
o.setStatus(PAID);
repo.save(o);                        // UPDATE ... WHERE version = 舊值 → 永遠 0 列
```

📌 **症狀是「樂觀鎖衝突變得非常頻繁，而且重試也沒用」** ——
因為重試又讀了一次從庫，還是舊的。

**⑤ 對帳、結算、任何要求「精確」的計算**

```
🔴 月結算跑在從庫上，而從庫落後 30 秒
     → 30 秒內的交易沒被算進去
     → 而它們【不會在下個月被補算】（因為下個月的範圍不包含它們）
```

⚠️ **這一類的正確做法不是「走主庫」，是「用明確的時間邊界 + 冪等」**：

```sql
-- ✅ 以資料的時間為界，而不是以「跑的時候」為界
WHERE placed_at >= '2026-09-01 00:00:00.000'
  AND placed_at <  '2026-10-01 00:00:00.000'
```

✅ 這樣就算延遲 30 秒也只是「跑的時候可能還沒到齊」——
**排在月初第 2 天跑，加上「有沒有漏」的檢查，就可以安全地走從庫。**

**⑥ 分散式鎖、排程搶佔、任何「誰先誰後」的判斷**

```sql
-- 🔴 這種查詢的語意本身就要求「最新」
SELECT * FROM outbox_message WHERE status = 'PENDING'
ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED;
```

📌 **`FOR UPDATE` 在從庫上根本不該執行**（`super_read_only` 會擋掉，7.3.7）——
✅ 而這正好是一個好的防護：**讓它報錯，而不是安靜地拿到過時資料。**

---

📌 **可以放心走從庫的，通常只有這四類**：

```
✅ 報表與統計（時間邊界明確、容忍幾秒延遲）
✅ 全文檢索 / 列表瀏覽（使用者不會注意到 1 秒的差異）
✅ 匯出、資料同步、餵給資料倉儲
✅ 監控與巡檢查詢（🔴 而且【應該】走從庫，不要去打擾主庫）
```

⚠️ **一個常被忽略的事實**：
**大部分服務的讀取量瓶頸不在「查詢太多」，而在「幾個很貴的查詢」**（05 章 5.3.6）。
所以讀寫分離的收益往往是「把那幾個報表查詢移走」，
而不是「把 90% 的流量移走」。

🔴 **如果你的動機是「主庫 CPU 太高」，先做 05 章的排查 SOP** ——
把一個沒有索引的查詢加上索引，收益通常比整套讀寫分離大，而風險是它的百分之一。

---

### 7.4.5 `ThreadLocal` 路由的三個坑

**坑 1：換執行緒就失效。**

```java
@ReadFromReplica
public CompletableFuture<Report> asyncReport() {
    return CompletableFuture.supplyAsync(() -> repo.heavyQuery());
    //     🔴 supplyAsync 在【另一個執行緒】上跑
    //        → DbRoleContext.current() 回傳 PRIMARY（預設值）
    //        → 這個查詢跑到主庫上了
}
```

✅ **修法：把值明確地傳過去。**

```java
@ReadFromReplica
public CompletableFuture<Report> asyncReport() {
    DbRole role = DbRoleContext.current();          // 在原執行緒上取出
    return CompletableFuture.supplyAsync(() -> {
        DbRole prev = DbRoleContext.set(role);      // 在新執行緒上設好
        try { return repo.heavyQuery(); }
        finally { DbRoleContext.restore(prev); }
    });
}
```

📌 **這也是為什麼 `DbRoleContext.current()` 的預設值必須是 `PRIMARY`** ——
**忘了傳的時候，結果是「慢一點」而不是「錯的」。**

**坑 2：忘了還原 → 污染執行緒池。**

```java
// 🔴 錯：沒有 finally
public List<X> bad() {
    DbRoleContext.set(DbRole.REPLICA);
    return repo.query();          // 如果這裡拋例外，REPLICA 就留在這條執行緒上
}
// → Tomcat 把這條執行緒給下一個請求 → 那個請求的【寫入】跑到從庫 → ERROR 1290
```

✅ **`DbRoleAspect` 的 `try/finally` 就是為了這個。**
🔴 而如果你有任何地方手動呼叫 `DbRoleContext.set()`，**一定要配 `finally`**。

✅ **再加一道保險：在請求結束時清掉。**

```java
@Component
public class DbRoleCleanupFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        try { chain.doFilter(req, res); }
        finally { DbRoleContext.clear(); }     // 🔴 最後一道防線
    }
}
```

**坑 3：巢狀呼叫。**

```java
@ReadFromReplica
public Report outer() {
    return inner();          // inner() 也有 @ReadFromReplica，或者【沒有】
}
```

```
如果 set() 只是 CURRENT.set(role) 而 finally 只是 CURRENT.remove()：
     outer 設 REPLICA → inner 設 REPLICA → inner 的 finally remove()
     → 🔴 outer 剩下的部分變成 PRIMARY
```

✅ **所以 `DbRoleContext.set()` 回傳「舊值」，`restore()` 放回去** ——
上面的實作就是這樣做的。

---

### 7.4.6 另外兩條路：驅動層與 Proxy

**① mysql-connector-j 的 replication URL**

```properties
spring.datasource.url=jdbc:mysql:replication://primary:3306,replica1:3306,replica2:3306/shop
```

```java
conn.setReadOnly(true);      // → 路由到從庫
conn.setReadOnly(false);     // → 路由到主庫
```

```
✅ 零程式碼（Spring 的 @Transactional(readOnly=true) 會呼叫 setReadOnly）
✅ 內建的從庫負載平衡與故障剔除
🔴 判斷依據只有 readOnly 這個布林 —— 7.4.4 的六種情況它【完全不知道】
🔴 不看延遲 —— 從庫落後 10 分鐘它照樣路由過去
🔴 與連線池的互動很微妙（HikariCP 會把連線的 readOnly 狀態重設）
```

📌 **適合的場景**：讀寫分離的需求很單純、而且**所有唯讀查詢都能容忍延遲**。
🔴 **本章的做法（明確選擇加入 + 延遲檢查）就是為了 7.4.4 那六種例外而存在的。**

**② ProxySQL / MaxScale**

```
應用 → ProxySQL（6033）→ 主庫 / 從庫
                ↑
        按 SQL 的規則路由（正規表示式、使用者、schema）
```

```
✅ 應用完全不用改（連線字串指向 proxy 就好）
✅ 可以做「主庫故障時自動切換」而應用不用重連
✅ ProxySQL 會自己監控從庫延遲並剔除落後的（mysql_servers.max_replication_lag）
✅ 連線多工（把 1000 條應用連線收斂成 50 條資料庫連線 —— 05 章 5.10.1）
🔴 多了一個要維運、要監控、會成為單點的元件
🔴 路由規則寫在 proxy 的設定裡，不在版控裡（除非你把它也版控）
🔴 🔴 它同樣不知道 7.4.4 的六種例外 —— 除非你為它們寫特殊規則
```

📌 **一個實務上很有效的組合**：

```
ProxySQL 負責  ：連線多工、主庫故障切換、把落後的從庫剔除
應用程式負責   ：🔴「這個查詢能不能容忍延遲」的判斷（7.4.3 的 @ReadFromReplica）
```

⚠️ **因為「能不能容忍延遲」是【業務語意】，而 proxy 只看得到 SQL 文字。**
一句 `SELECT * FROM ord WHERE id = ?` 到底是
「報表在撈資料」還是「使用者剛下完單要看訂單」——
**只有應用程式知道。**

---

## 7.5 高可用：半同步、故障切換、與「會丟多少資料」

### 7.5.1 非同步複製會丟資料

**預設的 MySQL 複製是【非同步】的**：

```
主庫：交易提交 → 寫 binlog → 🔴 【立刻回應用戶端「成功」】
                                  ↓（之後才）
從庫：拿到 binlog → 套用
```

🔴 **所以主庫在「回應成功」與「從庫拿到」之間掛掉，那筆資料就消失了。**

```
使用者看到「下單成功」
     ↓ 20 ms
主庫的機器掛了
     ↓
切換到從庫 → 🔴 那筆訂單不存在
     ↓
使用者的信用卡已經被扣款了
```

📌 **這個視窗有多大？就是 7.3.6 量到的複製延遲** ——
本章環境是 58 ～ 315 ms，而正式環境跨可用區通常是幾百毫秒到幾秒。

---

### 7.5.2 半同步複製：實測成本與它的靜默降級 ★

**半同步（semi-synchronous）改變了提交的時機**：

```
主庫：交易提交 → 寫 binlog → 🔴 【等】至少 N 個從庫回報「我收到了」→ 才回應用戶端
```

```sql
-- ── 主庫 ────────────────────────────────────────────────────────────
INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
SET GLOBAL rpl_semi_sync_source_enabled = 1;
SET GLOBAL rpl_semi_sync_source_timeout = 1000;              -- 毫秒
SET GLOBAL rpl_semi_sync_source_wait_for_replica_count = 1;  -- 要幾個從庫確認
```

```sql
-- ── 從庫 ────────────────────────────────────────────────────────────
INSTALL PLUGIN rpl_semi_sync_replica SONAME 'semisync_replica.so';
SET GLOBAL rpl_semi_sync_replica_enabled = 1;
STOP REPLICA IO_THREAD; START REPLICA IO_THREAD;             -- 🔴 要重啟 I/O 執行緒才生效
```

**確認它真的開了**：

```sql
SHOW STATUS LIKE 'Rpl_semi_sync_source_clients';   -- 1     ← 有幾個半同步從庫連著
SHOW STATUS LIKE 'Rpl_semi_sync_source_status';    -- ON    ← 🔴 現在是不是半同步生效中
```

---

**實測成本**（2,000 次單筆 `INSERT`，同一台機器上的兩個容器）：

| 設定 | 平均 | p50 | p99 | TPS |
|---|---|---|---|---|
| 半同步 **開啟** | 2.114 ms | **2.125 ms** | 4.536 ms | 473 |
| 半同步 **關閉**（純非同步） | 1.981 ms | **1.526 ms** | 4.333 ms | 505 |

📌 **p50 從 1.526 ms 變成 2.125 ms —— 多了 0.6 ms（39%）。**

⚠️ **這 0.6 ms 是【同一台機器】上的數字，參考價值有限。**
半同步的成本 ≈ **一次主從之間的網路往返**：

```
同一台機器（本章）        →  +0.6 ms
同一個可用區              →  +0.5 ~ 1 ms
跨可用區（同一個 region） →  🔴 +1 ~ 3 ms
跨 region                 →  🔴 +30 ~ 200 ms  ← 這時半同步基本上不能用
```

🔴 **而這個成本是加在【每一次提交】上的** ——
一個要寫 10 次資料庫的 API，跨可用區半同步會多 10 ～ 30 ms。

---

**🔴 而半同步最重要的性質，是它會【靜默降級】。**

**實驗**：半同步開著，然後**把從庫停掉**：

```sql
-- 從庫
STOP REPLICA;
```

```
=== 半同步開啟，但從庫停掉 ===
  300 次單筆 INSERT：平均 1.348 ms  p50 1.066 ms  → 742 TPS
                              ↑ 🔴 反而【變快了】
```

```sql
-- 主庫
SHOW STATUS LIKE 'Rpl_semi_sync_source_status';    -- 🔴 OFF
SHOW STATUS LIKE 'Rpl_semi_sync_source_no_tx';     -- 🔴 500
```

📌 **發生了什麼**：

```
① 從庫停了 → 主庫等不到確認
② 等了 rpl_semi_sync_source_timeout（1000 ms）
③ 🔴 主庫【自己放棄半同步】，退回非同步模式
     → Rpl_semi_sync_source_status 變成 OFF
     → 之後的每一筆交易都算進 Rpl_semi_sync_source_no_tx（實測 500 筆）
④ 而寫入變快了（因為不用等了）
```

🔴 **所以半同步【不是】持久性保證，它是一個「best effort」**：

```
🔴 應用程式完全不知道降級發生了 —— 沒有錯誤、沒有警告，只有一個狀態變數
🔴 而降級之後，7.5.1 的資料遺失風險【完全回來了】
🔴 而且它變快了 —— 所以你的效能監控會顯示「一切正常，甚至更好」
```

✅ **唯一的偵測方式是監控那個狀態變數**：

```sql
-- 🔴 這一句必須進監控，而且門檻是「不等於 ON 就告警」
SHOW STATUS LIKE 'Rpl_semi_sync_source_status';

-- 以及這兩個計數器的增長
SHOW STATUS LIKE 'Rpl_semi_sync_source_yes_tx';   -- 半同步成功的交易數
SHOW STATUS LIKE 'Rpl_semi_sync_source_no_tx';    -- 🔴 降級後提交的交易數（應該永遠是 0）
```

📌 **`rpl_semi_sync_source_timeout` 的取捨很尖銳**：

```
設短（1 秒）  → 從庫一有抖動就降級 → 🔴 持久性保證形同虛設
設長（30 秒） → 從庫掛掉時主庫【卡住 30 秒】→ 🔴 主庫等於也掛了
```

⚠️ **這個取捨沒有好答案 —— 這正是「半同步只能給你【比非同步好一點】的持久性」的意思。**
真正的解法在下一節。

---

### 7.5.3 三種高可用架構

| | 非同步複製 + 人工切換 | **半同步 + 自動切換** | **Group Replication / InnoDB Cluster** |
|---|---|---|---|
| 資料遺失（RPO） | 🔴 = 複製延遲（幾百 ms ~ 幾秒） | 🟡 大部分情況 0，降級時同左 | ✅ 0（多數節點確認才提交） |
| 切換時間（RTO） | 🔴 人工，10 分鐘 ~ 1 小時 | ✅ 秒級（靠 Orchestrator / MHA） | ✅ 秒級（內建） |
| 寫入延遲成本 | ✅ 0 | 🟡 +1 次 RTT | 🔴 +1 次 RTT（且要多數節點） |
| 「腦裂」風險 | 🔴 高（人工判斷） | 🟡 靠仲裁工具 | ✅ 內建多數決 |
| 維運複雜度 | ✅ 最低 | 🟡 中（多一個切換工具） | 🔴 高（但雲端託管版本會幫你） |
| DDL / 大交易 | ✅ 沒限制 | ✅ 沒限制 | 🔴 有限制（大交易會被拒；需要主鍵） |

📌 **實務上的選擇通常很簡單**：

```
✅ 用雲端託管的 MySQL（RDS Multi-AZ / Cloud SQL HA / PolarDB）
     → 它們的 HA 就是上面第 2 或第 3 種，而且【不用你維運】
     🔴 但你還是要知道它的 RPO 是多少 —— 去看文件，不要假設是 0

🟡 自建：半同步 + Orchestrator（或 MHA）
     → 需要一個獨立的仲裁節點，不能跟資料庫放一起

🔴 「非同步 + 人工切換」只適合「可以接受丟幾秒資料、且有人 24 小時待命」的系統
```

⚠️ **本章沒有實測自動切換工具（Orchestrator / MHA / InnoDB Cluster）** ——
它們需要至少三個節點加一個仲裁層，而在單機容器上量出來的
「切換時間」對正式環境沒有參考價值。

---

### 7.5.4 手動故障切換的檢查清單

就算你用託管服務，也應該知道**手動切換要做什麼** ——
因為託管服務也有「需要你介入」的時候。

```
═══ 切換前：確認狀態 ═══════════════════════════════════════════════
□ 主庫真的掛了嗎？（不是網路分區、不是監控誤報）
    🔴 這是最容易錯的一步 —— 「主庫還活著但你以為它死了」= 腦裂
□ 從庫追上了嗎？
    SELECT GTID_SUBTRACT('<主庫的 gtid_executed>', @@GLOBAL.gtid_executed);
    → 空字串才是追上了（7.3.4）
    🔴 主庫已經連不上時，拿不到它的 gtid_executed
       → 這時要接受「可能丟資料」，並記錄下丟了哪些 GTID
□ 如果有多個從庫，哪一個最新？
    比較每一個的 @@GLOBAL.gtid_executed，選最大的那個

═══ 切換：把從庫變主庫 ═════════════════════════════════════════════
□ 停止舊主庫接受寫入（如果它還活著）
    SET GLOBAL super_read_only = ON;          -- 🔴 防腦裂的第一步
□ 讓選定的從庫追完剩下的 relay log
    STOP REPLICA IO_THREAD;                    -- 不要再拿新的
    -- 等 Replica_SQL_Running_State 變成「已讀完 relay log」
□ 解除從庫的唯讀
    SET GLOBAL super_read_only = OFF;          -- 🔴 最常漏的一行（7.3.7）
    SET GLOBAL read_only = OFF;
□ 斷開它的複製關係
    STOP REPLICA;
    RESET REPLICA ALL;
□ 把其他從庫指向新主庫
    STOP REPLICA;
    CHANGE REPLICATION SOURCE TO SOURCE_HOST='new-primary', SOURCE_AUTO_POSITION=1;
    START REPLICA;
    ✅ GTID 模式下不用算位置 —— 這就是 7.3.4 的價值
□ 切流量（改 DNS / 改 proxy 設定 / 改連線字串）

═══ 切換後：驗證 ═══════════════════════════════════════════════════
□ 新主庫真的能寫嗎？（下一句 INSERT 試試）
□ 🔴 半同步的狀態對嗎？（新主庫要裝 source 外掛並啟用，7.5.2）
□ 其他從庫的 Replica_IO_Running / Replica_SQL_Running 都是 Yes 嗎？
□ 🔴 應用的連線池有沒有還連著舊主庫？
    → HikariCP 的 maxLifetime 到了才會換 —— 通常要主動重啟或呼叫 evict
□ 心跳表還在跳嗎？（7.3.6 —— 心跳的產生者在舊主庫上！）
□ 備份任務指向新主庫了嗎？
□ 🔴 舊主庫【不要】直接接回來當從庫
    → 它可能有「已提交但沒複製出去」的交易 → GTID 分岔（7.3.7）
    → 正確做法：重建它，或用 mysqlbinlog 比對之後人工處理那些交易
```

📌 **最後一項是切換之後最常出事的地方。**
舊主庫上那些「回應了成功但沒複製出去」的交易，
在 GTID 的世界裡會變成「新主庫永遠不知道的 GTID」——
把它接回來當從庫，會讓整個叢集陷入 7.3.7 的分岔狀態。

---

## 7.6 監控：該看哪些指標

📌 **監控的第一原則：每一個指標都要能回答一個【你會採取行動】的問題。**
「CPU 使用率 70%」不是一個指標，因為你不知道要不要做事。

### 7.6.1 四類指標

**① 可用性（會不會有人被影響）**

```sql
-- 連線數：離上限多遠？（05 章 5.10.3）
SHOW GLOBAL STATUS LIKE 'Threads_connected';    -- 目前
SHOW GLOBAL STATUS LIKE 'Max_used_connections'; -- 歷史高水位
SELECT @@max_connections;
-- 🔴 告警：Threads_connected / max_connections > 0.8

-- 有幾個查詢正在跑？（05 章 5.10.1 的拐點）
SHOW GLOBAL STATUS LIKE 'Threads_running';
-- 🔴 告警：> 核心數 × 2 持續 1 分鐘（代表已經在排隊）

-- 被拒絕的連線
SHOW GLOBAL STATUS LIKE 'Aborted_connects';     -- 認證失敗 / 逾時
SHOW GLOBAL STATUS LIKE 'Connection_errors_max_connections';
-- 🔴 告警：後者只要 > 0 就是「有人連不上」
```

**② 正確性（資料會不會錯）**

```sql
-- 🔴 從庫延遲 —— 用心跳表，不要用 Seconds_Behind_Source（7.3.5、7.3.6）
SELECT TIMESTAMPDIFF(MICROSECOND, ts, NOW(6)) / 1000 AS lag_ms
FROM ops.heartbeat WHERE id = 1;
-- 🔴 告警：> 1000 ms 警告、> 5000 ms 呼叫

-- 複製有沒有斷
SELECT SERVICE_STATE FROM performance_schema.replication_connection_status;   -- 應為 ON
SELECT COUNT(*) FROM performance_schema.replication_applier_status_by_worker
WHERE LAST_ERROR_NUMBER <> 0;                                                 -- 🔴 應為 0

-- 🔴 半同步有沒有降級（7.5.2）
SHOW STATUS LIKE 'Rpl_semi_sync_source_status';   -- 🔴 不等於 ON 就告警
SHOW STATUS LIKE 'Rpl_semi_sync_source_no_tx';    -- 🔴 只要增長就告警

-- 🔴 有沒有失敗的遷移（06 章 6.3.2）
SELECT COUNT(*) FROM flyway_schema_history WHERE success = 0;                  -- 應為 0
```

**③ 效能（會不會慢）—— 05 章的指標，這裡只列告警門檻**

```sql
-- buffer pool 命中率（🔴 要取差值，不是累計值 —— 05 章 5.2.2）
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read_requests';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_reads';
-- 🔴 告警：最近 5 分鐘的命中率 < 99%

-- 磁碟暫存表比率（05 章 5.7.3）
SHOW GLOBAL STATUS LIKE 'Created_tmp_disk_tables';
SHOW GLOBAL STATUS LIKE 'Created_tmp_tables';
-- 🔴 告警：磁碟/總計 > 10%

-- 慢查詢（05 章 5.3）
SHOW GLOBAL STATUS LIKE 'Slow_queries';
-- 🔴 告警：每分鐘增長 > 10

-- 🔴 最長交易（04 章 4.3.8 / 06 章 6.7.5）
SELECT MAX(TIMESTAMPDIFF(SECOND, trx_started, NOW())) AS longest_trx_secs
FROM information_schema.innodb_trx;
-- 🔴 告警：> 60 秒

-- 鎖等待（04 章）
SELECT COUNT(*) FROM performance_schema.data_lock_waits;
-- 🔴 告警：> 0 持續 30 秒
```

**④ 容量（會不會撐不住）**

```sql
-- 資料量與成長率
SELECT table_schema,
       ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS total_gb
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
GROUP BY table_schema;
-- 🔴 告警：週成長率突然變成兩倍（通常是有人不小心開了什麼）

-- ⚠️ binlog 佔的空間【不能用 SQL 查】—— SHOW 不能當衍生表，而 MySQL 8 沒有
--    對應的 information_schema 視圖。這一項要在 shell 側算（7.2.9）：
--      mysql -N -B -e 'SHOW BINARY LOGS' | awk '{f++;b+=$2} END {print f, b}'

-- AUTO_INCREMENT 快用完了嗎（01 章：INT 的上限是 21 億）
SELECT t.table_name, c.column_type, t.auto_increment,
       ROUND(t.auto_increment / CASE c.column_type
           WHEN 'int'                THEN 2147483647
           WHEN 'int unsigned'       THEN 4294967295
           WHEN 'bigint'             THEN 9223372036854775807
           WHEN 'bigint unsigned'    THEN 18446744073709551615
           WHEN 'smallint'           THEN 32767
           WHEN 'smallint unsigned'  THEN 65535 END * 100, 2) AS pct_used
FROM information_schema.tables t
JOIN information_schema.columns c
     ON c.table_schema = t.table_schema AND c.table_name = t.table_name
    AND c.extra LIKE '%auto_increment%'
WHERE t.table_schema = 'shop' AND t.auto_increment IS NOT NULL
ORDER BY pct_used DESC;
-- 🔴 告警：pct_used > 70
```

📌 **最後那一句是一個「三年後才會炸、而炸的時候非常痛」的檢查。**
`INT` 主鍵在每天 100 萬筆的表上，**5.8 年就用完了** ——
而用完的症狀是 `ERROR 1062 Duplicate entry '2147483647' for key 'PRIMARY'`，
修法是 06 章 6.7.2 的 `INT` → `BIGINT`（只能 `COPY`，8,000 萬列要幾分鐘）。

🔴 **而 06 章 6.7.3 的 `TOTAL_ROW_VERSIONS` 也要在這一類**：

```sql
SELECT NAME, TOTAL_ROW_VERSIONS, N_COLS
FROM information_schema.INNODB_TABLES
WHERE TOTAL_ROW_VERSIONS > 40
ORDER BY TOTAL_ROW_VERSIONS DESC;
-- 🔴 告警：> 55（離 64 的上限只剩 9 次 INSTANT）
```

---

### 7.6.2 一個可以直接用的巡檢腳本

```sql
-- ops/health-check.sql —— 每分鐘跑一次，把結果丟給監控系統
SELECT 'threads_connected' AS metric, VARIABLE_VALUE AS value
FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected'
UNION ALL
SELECT 'threads_running', VARIABLE_VALUE
FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_running'
UNION ALL
SELECT 'max_connections', @@max_connections
UNION ALL
SELECT 'slow_queries', VARIABLE_VALUE
FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Slow_queries'
UNION ALL
SELECT 'created_tmp_disk_tables', VARIABLE_VALUE
FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Created_tmp_disk_tables'
UNION ALL
SELECT 'innodb_buffer_pool_reads', VARIABLE_VALUE
FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads'
UNION ALL
SELECT 'innodb_buffer_pool_read_requests', VARIABLE_VALUE
FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'
UNION ALL
SELECT 'longest_trx_secs',
       COALESCE(MAX(TIMESTAMPDIFF(SECOND, trx_started, NOW())), 0)
FROM information_schema.innodb_trx
UNION ALL
SELECT 'lock_waits', COUNT(*) FROM performance_schema.data_lock_waits
UNION ALL
SELECT 'replica_lag_ms',
       COALESCE((SELECT TIMESTAMPDIFF(MICROSECOND, ts, NOW(6)) / 1000
                 FROM ops.heartbeat WHERE id = 1), -1)
UNION ALL
SELECT 'semi_sync_on',
       COALESCE((SELECT IF(VARIABLE_VALUE = 'ON', 1, 0)
                 FROM performance_schema.global_status
                 WHERE VARIABLE_NAME = 'Rpl_semi_sync_source_status'), -1)
UNION ALL
SELECT 'failed_migrations',
       (SELECT COUNT(*) FROM shop.flyway_schema_history WHERE success = 0)
UNION ALL
SELECT 'max_row_versions',
       COALESCE((SELECT MAX(TOTAL_ROW_VERSIONS) FROM information_schema.INNODB_TABLES
                 WHERE NAME LIKE 'shop/%'), 0);
```

⚠️ **`Innodb_buffer_pool_reads` 這類計數器是【從開機累計】的**（05 章 5.2.2）——
監控系統要存的是「這一分鐘的差值」，不是絕對值。
✅ Prometheus 的 `rate()`、Datadog 的 `.as_rate()` 就是做這件事。

📌 **這個腳本應該用【巡檢專用的唯讀帳號】跑，而且【跑在從庫上】**（7.7）——
除了 `innodb_trx` 與 `data_lock_waits` 那兩項要看主庫。

---

## 7.7 權限最小化

06 章 6.10.2 分了「應用」與「遷移」兩個帳號。**加上本章的需求，一共是五個。**

```sql
-- ═══ ① 應用程式：只能動資料 ═══════════════════════════════════════
CREATE USER 'shop_app'@'10.%' IDENTIFIED BY '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'shop_app'@'10.%';
-- 🔴 沒有 CREATE / ALTER / DROP / INDEX
-- 🔴 沒有 SUPER / CONNECTION_ADMIN —— 這是 7.3.7 那道防線的前提

-- ═══ ② 遷移：可以動結構（06 章 6.10.2）═════════════════════════════
CREATE USER 'shop_migrate'@'10.%' IDENTIFIED BY '...';
GRANT SELECT, INSERT, UPDATE, DELETE,
      CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE ROUTINE, ALTER ROUTINE, EXECUTE,
      CREATE VIEW, SHOW VIEW, TRIGGER
  ON shop.* TO 'shop_migrate'@'10.%';

-- ═══ ③ 複製：只能讀 binlog（7.3.2）════════════════════════════════
CREATE USER 'repl'@'10.%' IDENTIFIED WITH caching_sha2_password BY '...';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'10.%';
-- 🔴 只有這一個權限。不要給 SELECT（複製不需要）

-- ═══ ④ 備份：能讀全部 + 鎖 + 看 binlog 座標（7.2.5）════════════════
CREATE USER 'shop_backup'@'10.%' IDENTIFIED BY '...';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON *.* TO 'shop_backup'@'10.%';
GRANT RELOAD, PROCESS, REPLICATION CLIENT ON *.* TO 'shop_backup'@'10.%';
-- RELOAD              → FLUSH TABLES WITH READ LOCK（--single-transaction 需要）
-- REPLICATION CLIENT  → SHOW MASTER STATUS（--source-data=2 需要）
-- PROCESS             → 看 processlist
-- 🔴 沒有任何寫入權限 —— 備份帳號絕對不需要寫

-- ═══ ⑤ 巡檢與監控：唯讀 + 看系統狀態（7.6）════════════════════════
CREATE USER 'shop_readonly'@'10.%' IDENTIFIED BY '...';
GRANT SELECT, SHOW VIEW ON shop.* TO 'shop_readonly'@'10.%';
GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'shop_readonly'@'10.%';
GRANT SELECT ON performance_schema.* TO 'shop_readonly'@'10.%';
-- 🔴 這個帳號是給人用的（排查）也給監控用的
```

📌 **五個細節值得說明**：

**① 主機限定用 `'10.%'` 而不是 `'%'`。**

```
'shop_app'@'%'      → 🔴 從任何 IP 都能連
'shop_app'@'10.%'   → ✅ 只有內網
```

⚠️ **在 Kubernetes 裡 Pod IP 是動態的**，所以只能限定到網段。
✅ 更好的做法是**用網路層（Security Group / NetworkPolicy）限制**，
資料庫的帳號主機限定當第二道。

**② `caching_sha2_password` 是 MySQL 8 的預設，而它需要 TLS 或 RSA 交換**（00 章 0.7）。

```sql
-- 複製帳號用它的時候，從庫要加這個
CHANGE REPLICATION SOURCE TO ..., GET_SOURCE_PUBLIC_KEY = 1;
-- 🔴 或者更好：設定 TLS（SOURCE_SSL = 1）
```

**③ 密碼輪換要能做到，所以密碼不能寫在程式碼裡。**

```
✅ Kubernetes Secret / AWS Secrets Manager / Vault
✅ MySQL 8 支援【雙密碼】—— 輪換期間新舊都能用：
     ALTER USER 'shop_app'@'10.%' IDENTIFIED BY '新密碼' RETAIN CURRENT PASSWORD;
     -- 部署完成、確認所有實例都用新密碼之後：
     ALTER USER 'shop_app'@'10.%' DISCARD OLD PASSWORD;
```

📌 **`RETAIN CURRENT PASSWORD` 讓「換資料庫密碼」不需要停機** ——
這是 MySQL 8 一個很少人知道但非常實用的功能。

**④ 定期審計「誰有什麼權限」。**

```sql
-- 🔴 有 SUPER 或 CONNECTION_ADMIN 的帳號（它們能繞過 read_only，7.3.7）
SELECT grantee, privilege_type
FROM information_schema.user_privileges
WHERE privilege_type IN ('SUPER', 'CONNECTION_ADMIN', 'SYSTEM_VARIABLES_ADMIN')
ORDER BY grantee;

-- 🔴 有 DROP 權限的帳號
SELECT grantee, table_schema, privilege_type
FROM information_schema.schema_privileges
WHERE privilege_type = 'DROP'
ORDER BY grantee;

-- 🔴 密碼從來沒換過的帳號
SELECT user, host, password_last_changed,
       DATEDIFF(NOW(), password_last_changed) AS days_ago
FROM mysql.user
WHERE password_last_changed IS NOT NULL
ORDER BY password_last_changed;

-- 🔴 可以從任何 IP 連的帳號
SELECT user, host FROM mysql.user WHERE host = '%';
```

**⑤ 一個常被忽略的：`mysql.user` 裡的預設帳號。**

```sql
-- 檢查有沒有匿名帳號或空密碼
SELECT user, host, plugin, LENGTH(authentication_string) AS pwd_len
FROM mysql.user
WHERE user = '' OR authentication_string = '';
-- 🔴 有任何一列都要處理
```

---

## 7.8 上線檢查清單

📌 **這一節把 00 ～ 07 章收斂成一份「新服務上線前」的清單。**

```
═══ 環境（00 章）═════════════════════════════════════════════════
□ character_set_server = utf8mb4，collation_server 明確指定
□ default_time_zone 明確設定（建議 +00:00），JDBC 的 connectionTimeZone 一致
  （🔴 用 connectionTimeZone，不是 legacy 別名 serverTimezone；還要 forceConnectionTimeZoneToSession=true）
□ sql_mode 含 STRICT_TRANS_TABLES、ONLY_FULL_GROUP_BY
□ lower_case_table_names 與正式環境一致（🔴 這個【不能】事後改）
□ 三組守門測試在 CI 裡跑著

═══ Schema（01 章、06 章）════════════════════════════════════════
□ 金額用 DECIMAL，時間用 DATETIME(3)（語意 UTC）
□ 主鍵策略決定了，而且理由寫下來了
□ 🔴 AUTO_INCREMENT 的型別足夠（7.6.1 的 pct_used 檢查）
□ 遷移腳本在版控裡，黃金 schema 也在（06 章 6.9.3）
□ 遷移用獨立的 Job 執行，不跟著應用啟動（06 章 6.10.3）

═══ 索引與查詢（02、03、05 章）═══════════════════════════════════
□ 每一個已知的查詢路徑都有 EXPLAIN 過
□ rewriteBatchedStatements=true 在 JDBC URL 裡
□ 效能基線文件與守門測試（05 章 5.12）
□ 沒有 SELECT *、沒有無 LIMIT 的查詢、沒有 N+1

═══ 交易與鎖（04 章、06 章）══════════════════════════════════════
□ innodb_lock_wait_timeout 設了（不是預設 50 秒）
□ 🔴 lock_wait_timeout 設了（不是預設 365 天，06 章 6.7.5）
□ 交易邊界不包含外部呼叫
□ 最長交易的監控與告警（7.6.1）

═══ 備份（7.2）═══════════════════════════════════════════════════
□ 備份腳本用 --single-transaction --skip-lock-tables --source-data=2
□ 🔴 備份腳本檢查退出碼、stderr、gzip 完整性、【收尾標記】（7.2.5）
□ binlog 開著，binlog_format = ROW，並且【歸檔到物件儲存】
□ binlog_expire_logs_seconds > 備份間隔 × 2
□ 🔴 做過一次完整的還原演練，並把耗時填進 RTO 文件（7.2.8）
□ 🔴 演練環境裡有 mysqlbinlog（7.2.6）
□ 備份存在【不同的帳號/區域】（3-2-1）

═══ 複製（7.3）═══════════════════════════════════════════════════
□ gtid_mode = ON、enforce_gtid_consistency = ON
□ 🔴 從庫是 super_read_only = ON（不是 read_only，7.3.7）
□ server-id 全叢集唯一
□ log_replica_updates = ON（讓從庫可以被備份、可以串聯）
□ 🔴 心跳表在跳，延遲監控用它（7.3.6）
□ 複製斷線的告警（IO / SQL 兩個執行緒 + LAST_ERROR_NUMBER）
□ 每週一次 pt-table-checksum

═══ 讀寫分離（7.4）═══════════════════════════════════════════════
□ 路由是【明確選擇加入】的，預設走主庫
□ 每一個走從庫的查詢都標了容忍的延遲上限
□ 🔴 延遲超標會自動退回主庫，而且會記 log
□ 🔴 7.4.4 的六種讀取都確認過【沒有】走從庫
□ ThreadLocal 的清理有 filter 當最後防線（7.4.5）

═══ 高可用（7.5）═════════════════════════════════════════════════
□ 知道你的 RPO 是多少（非同步 = 複製延遲；託管服務去查文件）
□ 🔴 半同步的狀態變數有監控（Rpl_semi_sync_source_status / no_tx）
□ 故障切換的步驟寫成腳本，並且演練過
□ 🔴 演練裡包含「解除 super_read_only」這一步

═══ 安全（7.7）═══════════════════════════════════════════════════
□ 五個帳號分開，權限最小化
□ 密碼在 Secret 管理系統裡，不在程式碼 / 環境變數的明文裡
□ 沒有 host = '%' 的帳號、沒有空密碼、沒有匿名帳號
□ 連線用 TLS（require_secure_transport = ON）
□ 定期審計 SUPER / DROP 權限

═══ 監控（7.6）═══════════════════════════════════════════════════
□ 四類指標都有（可用性 / 正確性 / 效能 / 容量）
□ 每一個告警都對應一個【明確的處理動作】
□ 慢查詢日誌開著，long_query_time = 0.3 ~ 0.5
□ 🔴 巡檢查詢走從庫，不打擾主庫
```

---

## 7.9 常見誤區

**誤區 1：「我們每天都有備份，所以資料很安全」**

→ 7.2.3 實測：備份 1,615 ms、還原 **26,921 ms（16.7 倍）**。
「有備份」回答的是 **RPO**，而你老闆問的是 **RTO** ——
而 RTO 裡「還原」這一項用的是**還原的時間**，不是備份的時間。
🔴 而 7.2.8：**沒有演練過的備份，你連 RTO 是多少都不知道。**

**誤區 2：「`mysqldump` 不加參數也是一致的」**

→ 7.2.2 實測：**它確實是一致的** —— 因為預設是 `--lock-tables`。
🔴 **代價是線上寫入停頓 994 ms ≈ dump 的全部時間。**
300 GB 的資料庫用預設值備份，等於停機備份。
✅ 用 `--single-transaction --skip-lock-tables`：一致，而且停頓只有 90 ms。

**誤區 3：「`--single-transaction` 保證一致，所以我可以放心」**

→ 7.2.4 實測：一句對「還沒被讀到的表」下的 DDL，
讓 `mysqldump` 中止並回傳 `exit 3`。
🔴 **而它留下一個 194 MB、有正確表數量、可以正常還原的檔案 —— 只是少了一張表的資料。**
唯一的差別在最後兩行有沒有 `SET SQL_NOTES=@OLD_SQL_NOTES`。
✅ 這就是 7.2.5 檢查 ⑤ 存在的理由。

**誤區 4：「備份腳本的退出碼是 0，所以成功了」**

→ 7.2.3：`mysqldump ... | gzip > f.gz` 的 `$?` 是 **`gzip` 的**退出碼。
🔴 沒有 `set -o pipefail`，`mysqldump` 的失敗**完全看不到**。
→ 7.2.2：而 `mysqldump` 的一致性警告是印到 **stderr** 的 ——
`2>/dev/null` 會把它一起丟掉。

**誤區 5：「還原備份就是最好的災難復原」**

→ 7.2.7 實測：**你可以做得比那個好得多。**
用 `--exclude-gtids` 排除**那一個**誤刪的交易，
6 列資料全部救回（包含備份之後、以及**事故之後**的交易），
而 `DELETE FROM ord` 完全沒有被重放。
🔴 **這需要 GTID 模式 + binlog 歸檔 —— 兩個都要事前準備。**

**誤區 6：「重放 binlog 就是把它 `mysql <` 進去」**

→ 7.2.7 的注意事項 ②：**不加 `--skip-gtids` 的話，重放的事件會沿用原本的 GTID**，
而那些 GTID 在 `gtid_executed` 裡已經存在 → **全部被當成「已執行」而跳過**。
🔴 **症狀是「腳本跑完，一列資料都沒變」—— 沒有任何錯誤訊息。**

**誤區 7：「binlog 留 1 天就夠了，反正每天有備份」**

→ 7.2.9：備份在 02:00 完成、binlog 在 02:00 過期 ——
**你有備份，但沒有「從備份走到現在」的路。**
🔴 PITR 完全做不到。`binlog_expire_logs_seconds` 至少要是備份間隔的兩倍，
✅ 而更好的做法是把 binlog **歸檔到物件儲存**，讓資料庫上只留 3 天。

**誤區 8：「`binlog_format` 用哪個都可以，MIXED 最聰明」**

→ 7.3.1 實測：`STATEMENT` 下的 `UPDATE t SET v = UUID()`，
讓主從的資料 MD5 **不一樣**（`408ed80e...` vs `3edc4d31...`）——
**主從資料真的分岔了**，而 MySQL 只在錯誤日誌寫一行警告。
🔴 會踩到的不只 `UUID()`：`RAND()`、`SYSDATE()`、
`UPDATE ... LIMIT` 沒有 `ORDER BY`、多唯一索引的 `ON DUPLICATE KEY UPDATE`……
✅ **`binlog_format = ROW`，沒有討論空間。**

**誤區 9：「`Seconds_Behind_Source = 0` 代表主從一致」**

→ 7.3.5 實測：主庫跑一個 8 秒的大交易期間，從庫**整整 9 秒回報 0**
（因為交易還沒 commit，binlog 裡什麼都沒有），
提交之後才跳到 **12**。
🔴 而且它會一邊說 `Replica has read all relay log`、一邊落後 12 秒。
🔴 解析度還是**整數秒** —— 900 ms 的延遲它回報 0。
✅ 用心跳表（7.3.6）：連續、毫秒級、平滑上升（58 → 428 → 1076 → 6129 ms）。

**誤區 10：「`performance_schema` 的複製指標比較準」**

→ 7.3.5 實測：`LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP` 減
`..._ORIGINAL_COMMIT_TIMESTAMP` **很準**（那個大交易是 8,052 ms）。
🔴 但 `NOW() - ORIGINAL_COMMIT_TIMESTAMP` **不是延遲** ——
主庫閒著時它一路爬到 **32 秒**。
📌 **它回答的是「上一個交易的延遲」，不是「現在的延遲」。**

**誤區 11：「從庫設了 `read_only`，所以不會被寫到」**

→ 7.3.7 實測：`read_only = 1` 的從庫上，**`root` 的 `INSERT` 成功了**。
而那筆寫入讓從庫的 `gtid_executed` 多出**它自己的 UUID** ——
🔴 **永久的 GTID 分岔**：這個從庫不能被提升成主庫、主庫不能反過來從它複製、
一致性檢查永遠是「不一致」。
✅ 要用 `super_read_only = ON`（實測 `ERROR 1290`）。
📌 而普通應用帳號（沒有 `SUPER`）`read_only` 就擋得住 ——
**所以 06 章 6.10.2 的「應用帳號不要有多餘權限」是這道防線的前提。**

**誤區 12：「複製斷了就跳過那個交易，讓它跑起來就好」**

→ 7.3.8：`SET GTID_NEXT` + 空交易確實能讓複製繼續，
🔴 **代價是你永久放棄了那個交易的資料變更，而且沒有任何地方記錄。**
✅ 優先序是：① 重建從庫（唯一保證一致）→ ② 修好衝突的資料讓它繼續 → ③ 才是跳過。
⚠️ 順帶一提：`sql_slave_skip_counter` 在 GTID 模式下**不能用**（`ERROR 1858`）。

**誤區 13：「從庫延遲只有 1 毫秒，讀寫分離很安全」**

→ 7.4.1 實測：**200 次「寫完立刻讀從庫」，200 次都讀不到（100%）。**
🔴 機率不是「延遲多長」決定的，是「讀取有沒有落在延遲視窗裡」——
而「寫完立刻讀」的意思就是「落在視窗的第 0 毫秒」。
📌 **延遲小讓這個 bug 更難發現，不是更少發生**
（重新整理一下就好了 → 使用者不回報 → 你不知道）。

**誤區 14：「`@Transactional(readOnly = true)` 就自動走從庫，很方便」**

→ 7.4.4：**六種讀取不能走從庫**，而它們也常常是 `readOnly` 的：
寫入後同流程的讀取、「檢查後寫入」的檢查、樂觀鎖的讀取、
對帳結算、`FOR UPDATE SKIP LOCKED` 的搶佔。
✅ 所以路由要做成**明確選擇加入**（`@ReadFromReplica`），
**預設安全、明確地選擇冒險**。

**誤區 15：「用驅動的 `jdbc:mysql:replication://` 最省事」**

→ 7.4.6：它零程式碼，但**判斷依據只有 `readOnly` 這個布林**，
🔴 而且**完全不看延遲** —— 從庫落後 10 分鐘它照樣路由過去。
✅ 而「這個查詢能不能容忍延遲」是**業務語意**，
驅動與 proxy 都只看得到 SQL 文字 —— **只有應用程式知道**。

**誤區 16：「`ThreadLocal` 的路由很簡單」**

→ 7.4.5 三個坑：
🔴 `CompletableFuture.supplyAsync` 換執行緒 → 路由值不見了；
🔴 忘了 `finally` → 執行緒池把 `REPLICA` 帶給下一個請求的**寫入** → `ERROR 1290`；
🔴 巢狀呼叫用 `remove()` 而不是「還原舊值」→ 外層剩下的部分路由錯。
✅ `set()` 回傳舊值、`restore()` 放回去、加一個 filter 當最後防線。

**誤區 17：「半同步複製保證不丟資料」**

→ 7.5.2 實測：把從庫停掉，主庫等了 `rpl_semi_sync_source_timeout`（1 秒）之後
**自己退回非同步**，`Rpl_semi_sync_source_status` 變成 `OFF`，
之後 500 筆交易全部算進 `Rpl_semi_sync_source_no_tx`。
🔴 **而寫入變快了（1.348 ms vs 2.114 ms）—— 你的效能監控會顯示「一切正常，甚至更好」。**
✅ 唯一的偵測方式是監控那兩個狀態變數。

**誤區 18：「半同步的成本很高，會拖慢寫入」**

→ 7.5.2 實測（同一台機器）：p50 從 1.526 ms 變成 2.125 ms —— **多 0.6 ms**。
📌 這個成本 ≈ **一次主從網路往返**，所以：
同可用區 +0.5 ～ 1 ms（值得）、跨可用區 +1 ～ 3 ms（要評估）、
🔴 跨 region +30 ～ 200 ms（基本上不能用）。
**它是不是「高」取決於你的部署拓撲，不是取決於半同步本身。**

**誤區 19：「切換完成了，把舊主庫接回來當從庫」**

→ 7.5.4 最後一項：舊主庫上可能有「已提交但沒複製出去」的交易，
🔴 在 GTID 的世界裡那是「新主庫永遠不知道的 GTID」——
接回來會讓整個叢集陷入 7.3.7 的分岔狀態。
✅ **重建它。** 或者先用 `mysqlbinlog` 把那些交易撈出來人工處理。

**誤區 20：「切換腳本測過了」**

→ 7.5.4：最常漏的一行是 **`SET GLOBAL super_read_only = OFF`**。
🔴 症狀是「切換完成、監控全綠、但所有寫入都是 `ERROR 1290`」。
✅ 演練的驗證步驟裡要有「在新主庫下一句 `INSERT`」。

**誤區 21：「監控 CPU 和記憶體就夠了」**

→ 7.6.1：CPU 70% 不能告訴你要做什麼。
✅ 要監控的是**能對應到行動**的指標：
`Threads_running` > 核心數×2（05 章 5.10.1 的拐點）、
心跳延遲 > 1 秒、`Rpl_semi_sync_source_no_tx` 增長、
`flyway_schema_history` 有 `success = 0`（06 章）、
🔴 以及 `AUTO_INCREMENT` 的 `pct_used` > 70（`INT` 主鍵在每天 100 萬筆的表上 **5.8 年**就用完）。

**誤區 22：「累計計數器直接當指標」**

→ 7.6.2：`Innodb_buffer_pool_reads` 是**從開機累計**的（05 章 5.2.2）。
跑了三個月的伺服器，命中率永遠是 99.9%。
✅ 監控系統要存**差值**（Prometheus 的 `rate()`）。

**誤區 23：「應用連 root 比較不會有權限問題」**

→ 7.7：這句話同時廢掉了三道防線：
🔴 7.3.7 的 `read_only`（`root` 繞得過）、
🔴 06 章 6.5.7 的 `clean` 保護（`root` 有 `DROP`）、
🔴 以及「SQL 注入最多只能改資料」這個上限（`root` 可以 `DROP TABLE`）。
✅ 五個帳號分開（7.7），而且審計一次「誰有 `SUPER` / `DROP`」。

**誤區 24：「密碼輪換要停機」**

→ 7.7 細節 ③：MySQL 8 的 `ALTER USER ... IDENTIFIED BY '新密碼' RETAIN CURRENT PASSWORD`
讓新舊密碼**同時有效**，部署完成後再 `DISCARD OLD PASSWORD`。
✅ **零停機的密碼輪換**，而這個功能很少人知道。

---

## 7.10 本章練習

### 練習 1：算出你自己專案的 RTO ★★

```
① 拿你最新的一份正式環境備份（或它的副本）
② 在一台【乾淨的機器】上，用 7.2.8 的演練腳本還原它
③ 記錄五個時間：取得備份 / 起環境 / 還原 / 驗證 / 總計
```

**要回答的問題**：

```
① 「還原」花了多久？它是「備份時間」的幾倍？
② 總時間裡，有幾分鐘是花在「查文件、找權限、問人」上？
③ 你的資料量一年成長多少？照這個速度，一年後的 RTO 是多少？
④ 🔴 這個數字跟你的 SLA 相容嗎？如果不相容，你需要的是實體備份還是快照？
```

---

### 練習 2：製造一個「看起來很完整」的壞備份 ★

```
① 起一個有兩張表的資料庫，其中一張很大（讓 dump 要跑幾秒）
② 開始 mysqldump --single-transaction（整個資料庫）
③ 在它跑到一半時，對【小的那張表】下一句 ALTER TABLE
④ 檢查：退出碼、檔案大小、CREATE TABLE 的數量、最後兩行
```

**要回答的問題**：

```
① 你原本的備份腳本會抓到這個失敗嗎？
② 檔案大小的檢查抓得到嗎？（提示：不會）
③ 把 7.2.5 的檢查 ⑤ 加進你的腳本，重跑一次
```

---

### 練習 3：做一次真正的 PITR ★★

```
① 建一張表、放 3 列、備份（--source-data=2）
② 再寫幾筆
③ 🔴 下一句忘了 WHERE 的 UPDATE（不是 DELETE —— UPDATE 更難發現）
④ 再寫幾筆
⑤ 用 7.2.7 的三個步驟復原，並且【只跳過 ③】
```

**要回答的問題**：

```
① 你怎麼找出 ③ 的那個 GTID？（提示：SHOW BINLOG EVENTS 或 mysqlbinlog --verbose）
② 忘記加 --skip-gtids 會發生什麼？（試一次，看它「什麼都沒發生」）
③ 如果 ③ 不是一句 SQL 而是一個【跑了 5 分鐘的批次作業】（幾百個交易），
   你要怎麼排除它們？（提示：--exclude-gtids 接受範圍）
④ 🔴 如果你的環境沒有開 GTID，這個練習做得到嗎？要多花多少工？
```

---

### 練習 4：重現 `binlog_format = STATEMENT` 的資料分岔 ★

```
① 建一組主從（7.3.2 的指令可以直接貼）
② SET GLOBAL binlog_format = 'STATEMENT'
③ 在主庫跑 UPDATE t SET v = UUID(), ts = NOW(6) WHERE ...
④ 比對主從的 MD5(GROUP_CONCAT(v ORDER BY id))
```

**要回答的問題**：

```
① MySQL 有阻止你嗎？錯誤日誌裡有什麼？
② 換成 MIXED，同一句還會分岔嗎？（提示：不會 —— MIXED 會自動切 ROW）
③ 那 MIXED 為什麼還是不建議？（提示：想想「哪些語句 MySQL 認得是不安全的」）
④ 用 SHOW BINLOG EVENTS 比較兩種格式記了什麼
```

---

### 練習 5：畫出你自己的延遲曲線 ★★

```
① 建心跳表（7.3.6），每 200 ms 更新一次
② 同時記錄 Seconds_Behind_Source 與心跳延遲
③ 在主庫上跑一個大交易（一次插 100 萬列）
④ 把兩條線畫出來
```

**要回答的問題**：

```
① 主庫的交易【還沒提交】的那幾秒，兩個指標各是多少？
② Seconds_Behind_Source 從 0 跳到多少？跳的那一刻，從庫的資料變了嗎？
③ 心跳延遲的基線（主庫閒著時）是多少？它跟你的心跳間隔有什麼關係？
④ 🔴 如果你的讀寫分離用 Seconds_Behind_Source 判斷「能不能走從庫」，
   ① 的那幾秒會發生什麼？
```

---

### 練習 6：證明 `read_only` 擋不住你 ★★

```
① 在你的從庫（或一個測試從庫）上確認 @@read_only = 1、@@super_read_only = 0
② 用你的【應用程式帳號】INSERT 一筆 → 應該被擋
③ 用 root INSERT 一筆 → 🔴 看它成功
④ 比對主從的 @@GLOBAL.gtid_executed
⑤ 設 super_read_only = ON，再試一次 root
```

**要回答的問題**：

```
① ④ 的差異長什麼樣子？那個多出來的 UUID 是誰？
② 這個從庫現在還能被提升成主庫嗎？為什麼不行？
③ 🔴 你的正式環境從庫，現在是 read_only 還是 super_read_only？
④ 你的應用程式連的帳號有 SUPER 或 CONNECTION_ADMIN 嗎？（用 7.7 的審計查詢）
```

---

### 練習 7：量出你自己的「讀己之寫」失敗率 ★★

```
① 在有讀寫分離的環境（測試環境就好）跑 7.4.1 的程式
② 記下失敗率與「多久之後才讀到」
③ 改成 7.4.2 的 GTID 等待版本，再跑一次
④ 量 GTID 等待的成本（平均 / p99）
```

**要回答的問題**：

```
① 你的失敗率是多少？跟本章的 100% 一樣嗎？
② GTID 等待的成本是多少毫秒？它可以接受嗎？
③ 🔴 在你的專案裡，有幾個 API 是「寫完立刻讀」的？逐一列出來
④ 那些 API 現在走的是主庫還是從庫？（去看程式碼，不要猜）
```

---

### 練習 8：演練一次故障切換 ★★

```
① 建一主兩從
② docker kill 主庫（不是 stop —— kill 更像真的當機）
③ 照 7.5.4 的清單手動切換
④ 記錄總時間，以及「哪幾步是你查了文件才知道的」
```

**要回答的問題**：

```
① 你怎麼判斷「哪一個從庫最新」？
② 🔴 你有記得解除 super_read_only 嗎？（如果沒有，症狀是什麼？）
③ 應用的連線池多久之後才連到新主庫？要不要重啟？
④ 心跳表停止跳動了嗎？（它的產生者在舊主庫上）
⑤ 把 ④ 那類「切換後才發現的東西」寫進切換腳本
```

---

### 練習 9：審計你的資料庫帳號 ★

用 7.7 的四個審計查詢跑一次你的正式環境。

**要回答的問題**：

```
① 有幾個帳號有 SUPER / CONNECTION_ADMIN？它們各是誰在用？
② 有幾個帳號的 host 是 '%'？
③ 最久沒換密碼的帳號是幾天前換的？
④ 🔴 應用程式用的那個帳號，能不能 DROP TABLE？
```

---

## 7.11 完成本章後，請確認你有

```
✅ 一份【演練過】的災難復原文件
     ├─ RPO：可以丟多少資料（非同步複製 = 複製延遲；有 binlog 歸檔 = 接近 0）
     ├─ ★ RTO：實測出來的，含「取得備份 / 起環境 / 還原 / 驗證」四段
     ├─ 每一步的指令（不是描述，是可以直接貼的指令）
     ├─ ★ 需要的權限與帳號（災難當天不要在等人開權限）
     └─ 上次演練的日期與耗時

✅ 一個【會檢查自己】的備份腳本（7.2.5）
     ├─ set -euo pipefail + set -o pipefail
     ├─ --single-transaction --skip-lock-tables --source-data=2
     ├─ --routines --events --triggers（🔴 都不是預設值）
     ├─ 檢查 stderr 有沒有東西
     ├─ 檢查 gzip -t
     ├─ ★ 🔴 檢查結尾有 SET SQL_NOTES=@OLD_SQL_NOTES（7.2.4 的靜默失敗）
     ├─ 檢查大小跟前一次差多少
     └─ 把 binlog 座標另存一份

✅ binlog 的完整配置
     ├─ binlog_format = ROW、binlog_row_image = FULL
     ├─ gtid_mode = ON、enforce_gtid_consistency = ON
     ├─ ★ 歸檔到物件儲存（而不是只留在資料庫主機上）
     ├─ binlog_expire_logs_seconds > 備份間隔 × 2
     └─ ★ 監控 binlog 佔的磁碟空間

✅ 一個能跑 mysqlbinlog 的環境（7.2.6）
     ├─ ★ 🔴 官方 MySQL 映像【沒有】mysqlbinlog
     ├─ 準備好一個「災難工具箱」映像，並在演練裡用過
     └─ 知道 SHOW BINLOG EVENTS 這個純 SQL 的替代方案

✅ 複製的正確配置（7.3）
     ├─ server-id 全叢集唯一
     ├─ ★ 🔴 從庫是 super_read_only = ON（不是 read_only）
     ├─ log_replica_updates = ON
     ├─ 複製帳號只有 REPLICATION SLAVE 權限
     └─ SOURCE_AUTO_POSITION = 1

✅ ★ 一張心跳表，以及用它做的延遲監控（7.3.6）
     ├─ 主庫每 100 ~ 500 ms 更新一次
     ├─ 從庫上一句 SQL 就能讀出毫秒級的延遲
     ├─ ★ 🔴 不要用 Seconds_Behind_Source（7.3.5 的三個問題）
     ├─ 主從的系統時鐘用 NTP 同步
     └─ 心跳表排除在備份與 CDC 之外

✅ 讀寫分離的正確設計（7.4）
     ├─ ★ 路由是【明確選擇加入】的，預設走主庫
     ├─ 每一個走從庫的查詢都宣告了容忍的延遲上限
     ├─ ★ 🔴 延遲超標或量不到 → 自動退回主庫並記 log
     ├─ ★ 7.4.4 的六種讀取都確認過【沒有】走從庫
     ├─ 需要跨請求讀己之寫的地方，用 WAIT_FOR_EXECUTED_GTID_SET（帶逾時！）
     ├─ LazyConnectionDataSourceProxy 包在 RoutingDataSource 外面
     └─ 一個 filter 在請求結束時清 ThreadLocal

✅ 高可用的取捨已經做過決定（7.5）
     ├─ 知道你的 RPO 是多少（託管服務也要去查文件，不要假設 0）
     ├─ ★ 🔴 半同步的 Rpl_semi_sync_source_status / no_tx 有監控
     ├─ 切換步驟寫成腳本（含解除 super_read_only）
     ├─ ★ 演練過至少一次，而且記錄了「查文件才知道」的步驟
     └─ 🔴 明確寫下「舊主庫不接回來，重建」

✅ 四類監控指標（7.6）
     ├─ 可用性：Threads_connected / Threads_running / Connection_errors_max_connections
     ├─ 正確性：★ 心跳延遲、複製狀態、半同步狀態、flyway success=0
     ├─ 效能：命中率、磁碟暫存表、慢查詢、★ 最長交易、鎖等待
     ├─ 容量：資料量成長、binlog 空間、★ AUTO_INCREMENT 的 pct_used、
     │        ★ TOTAL_ROW_VERSIONS（06 章 6.7.3 的 64 上限）
     └─ 🔴 累計計數器要存差值，不是絕對值

✅ 五個分開的資料庫帳號（7.7）
     ├─ shop_app      ：SELECT / INSERT / UPDATE / DELETE
     ├─ shop_migrate  ：+ CREATE / ALTER / DROP / INDEX / ROUTINE / VIEW / TRIGGER
     ├─ repl          ：只有 REPLICATION SLAVE
     ├─ shop_backup   ：SELECT / LOCK TABLES / RELOAD / REPLICATION CLIENT / PROCESS
     ├─ shop_readonly ：SELECT / SHOW VIEW / PROCESS / REPLICATION CLIENT
     ├─ ★ 沒有 host = '%'、沒有空密碼、沒有匿名帳號
     └─ ★ 密碼輪換用 RETAIN CURRENT PASSWORD（零停機）

✅ 你能回答這十個問題（不查資料）
     ├─ 你的備份還原要多久？你怎麼知道的？
     ├─ mysqldump 不加參數會發生什麼？加哪兩個參數才對？
     ├─ 一個「退出碼 0、194 MB」的備份檔，怎麼判斷它是壞的？
     ├─ 誤刪一張表的資料，而事故後又有新交易 —— 你要怎麼救？
     ├─ 為什麼 binlog_format 一定要 ROW？舉一個具體的例子
     ├─ Seconds_Behind_Source = 0 的三種可能意思是什麼？
     ├─ read_only 和 super_read_only 差在哪？誰擋不住誰？
     ├─ 「寫完立刻讀從庫」的失敗率是多少？為什麼是那個數字？
     ├─ 半同步複製在從庫掛掉時會怎樣？你怎麼知道它發生了？
     └─ 故障切換之後，最容易漏掉的一步是什麼？
```

---

## 7.12 本章的實驗環境與結果

**環境**：

| 項目 | 版本 / 規模 |
|---|---|
| 主庫 `mysql-m1` | **MySQL 8.0.46**（Docker），`server-id=1`、`log-bin`、`binlog-format=ROW`、`binlog-row-image=FULL`、`gtid-mode=ON`、`log-replica-updates=ON`、`innodb_buffer_pool_size=256M` |
| 從庫 `mysql-m2` | 同上，`server-id=2`、`read-only=ON`（7.3.7 的實驗會改動它） |
| 網路 | 兩個容器在同一個 Docker bridge 網路（**RTT 接近零** —— 見下方限制） |
| 複製 | GTID + `SOURCE_AUTO_POSITION=1`；半同步外掛 `semisync_source.so` / `semisync_replica.so` |
| 實驗表 `shop.ord` | **3,000,200 列**，資料 **195.7 MB** + 索引 **231.6 MB** |
| 實驗表 `bank.acct_a/b` | 各 **400,000 列**（`acct_a` 76.6 MB），不變量：兩表餘額總和 = **800,000,000** |
| 工具 | `percona/percona-server:8.0`（提供 `mysqlbinlog`）、`percona/percona-toolkit` |
| 應用程式 | **JDK 21**、mysql-connector-j **8.3.0**、Spring 6.1.14、HikariCP 5.1.0 |
| 平台 | macOS 14.2.1 / Apple Silicon，8 核心，NVMe SSD |

🔴 **本章有一個貫穿全章的限制，一定要先說**：

```
主從在【同一台機器】上，網路 RTT 接近零。

這讓三類數字失去絕對意義（但【比例】與【行為】仍然有效）：
     🔴 複製延遲的絕對值（本章 58 ~ 315 ms，其中大部分是心跳間隔的鋸齒）
     🔴 半同步的成本（本章 +0.6 ms；跨可用區是 +1 ~ 3 ms，跨 region 是 +30 ~ 200 ms）
     🔴 GTID 等待的成本（本章 1.12 ms）

✅ 而【行為】完全有效，因為它們由 MySQL 的實作決定而不是網路：
     ✅ 100% 的「讀己之寫」失敗率（7.4.1）—— 它跟延遲多長無關
     ✅ Seconds_Behind_Source 在未提交交易期間讀 0（7.3.5）
     ✅ read_only 擋不住 root（7.3.7）
     ✅ STATEMENT 格式讓資料分岔（7.3.1）
     ✅ 半同步逾時後靜默降級（7.5.2）
     ✅ mysqldump 的四種鎖模式行為（7.2.2）
     ✅ 所有的錯誤碼與退出碼
```

**跑過的實驗（18 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **B1** | `mysqldump` 四種鎖模式 × 併發轉帳 ★★ | ✅ 預設（`--lock-tables`）：一致，但**線上寫入停頓 994 ms**<br>🔴 `--skip-lock-tables`：停頓 122 ms，但**還原後總額 800,001,500（差 1,500 元）**<br>✅ **`--single-transaction`：一致，停頓只有 90 ms** —— 四者最低<br>🔴 `--lock-all-tables`：一致，停頓 **1,094 ms** |
| **B2** | 備份 vs 還原的耗時 ★★ | ✅ `mysqldump` **1,615 ms** / 194 MB<br>🟡 `gzip` **2,521 ms** / 25 MB（**7.8:1**，比 dump 本身還慢）<br>🔴 **還原 26,921 ms —— 16.7 倍** |
| **B3** | `--single-transaction` + 併發 DDL ★★ | 🔴 對**還沒讀到**的表下 DDL → `mysqldump: Error in field count for table` / **exit 3**<br>✅ 對**已讀過**的表下 DDL → exit 0（快照已固定住定義） |
| **B4** | 失敗的 dump 留下什麼 ★★ | 🔴 **203,806,451 bytes（194 MB）**、`CREATE TABLE` 數量**與成功的檔案相同（3）**<br>🔴 唯一差別：結尾少了 `SET SQL_NOTES=@OLD_SQL_NOTES` |
| **B5** | 官方映像有哪些工具 ★ | 🔴 `mysql:8.0` 有 `mysql` / `mysqldump` / `mysqlpump` / `mysqlsh`，**沒有 `mysqlbinlog`**<br>✅ `percona/percona-server:8.0` 有 `/usr/bin/mysqlbinlog` |
| **B6** | `--source-data=2` 的輸出 | ✅ `-- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000004', MASTER_LOG_POS=63179228;` |
| **P1** | PITR：排除單一個誤刪交易 ★★ | ✅ `SHOW BINLOG EVENTS` 找出事故是 GTID **87682**（`Delete_rows`）<br>✅ `mysqlbinlog --exclude-gtids=UUID:87682 --skip-gtids` → **112 行、4 個交易**（原本 5 個）<br>✅ 還原備份（3 列）+ 重放 → **6 列全部正確**，`D001` 的 `UPDATE` 生效（999）<br>🔴 `DELETE FROM ord` **沒有被重放** |
| **P2** | 檔案權限的坑 | 🔴 用 `--volumes-from` 掛 MySQL 的 volume 讀 binlog → `Permission denied (errno 13)`<br>✅ 改用 `--read-from-remote-server` 就好（也是正式環境該用的方式） |
| **R1** | `binlog_format`：ROW vs STATEMENT ★★ | ✅ ROW → `Table_map` + `Update_rows`（記結果的每一列）<br>🔴 STATEMENT → `Query: use bl; UPDATE t SET v = UUID(), ts = NOW(6) WHERE id <= 3`（記 SQL 文字）<br>🔴 **主庫 MD5 `408ed80e...` vs 從庫 `3edc4d31...` —— 資料真的分岔了** |
| **R2** | GTID 複製的建立 | ✅ `SOURCE_AUTO_POSITION=1` + `GET_SOURCE_PUBLIC_KEY=1` → `IO_Running: Yes` / `SQL_Running: Yes` / `Seconds_Behind_Source: 0`<br>📌 從庫自己把 GTID 1-10 全部補完（含 `CREATE DATABASE` / `CREATE TABLE` / `INSERT`） |
| **R3** | `Seconds_Behind_Source` 的三個問題 ★★ | 🔴 主庫的 8 秒大交易期間，從庫**整整 9 秒回報 0**<br>🔴 提交後跳到 **7 → 9 → 10 → 12**，然後瞬間歸零（列數一次跳 100 萬）<br>🔴 同時 `Replica_SQL_Running_State` 說「已讀完 relay log」而落後 12 秒 |
| **R4** | `performance_schema` 的複製指標 | ✅ `END_APPLY - ORIGINAL_COMMIT` = **8,052 ms**（那個大交易的端到端延遲，很誠實）<br>🔴 `NOW() - ORIGINAL_COMMIT` 在從庫追上後**一路爬到 32 秒**（主庫閒著）<br>📌 4 個 applier worker，實驗中只有 1 個有資料（主庫寫入是單執行緒） |
| **R5** | 心跳表 ★ | ✅ 閒置時 **58 ～ 315 ms**（心跳間隔 200 ms 的鋸齒）<br>✅ 大交易期間**平滑爬升**：428 → 1,076 → 2,323 → 3,567 → 4,850 → 5,480 → **6,129 ms**<br>📌 對照同時的 `Seconds_Behind_Source`：0 → 0 → 1 → 0 → 7 → 8（跳動、整數） |
| **R6** | `read_only` vs `super_read_only` ★★ | 🔴 `read_only=1, super_read_only=0` 的從庫上，**`root` 的 `INSERT` 成功**（多出 `ROGUE` 一列，主庫沒有）<br>🔴 從庫的 `gtid_executed` 多出**自己的 UUID `f5790d4f-...:1-8`** —— 永久 GTID 分岔<br>✅ 普通帳號 `shop_app` 被擋（`ERROR 1290 ... --read-only`）<br>✅ `super_read_only=ON` 後 `root` 也被擋（`ERROR 1290 ... --super-read-only`） |
| **W1** | 讀己之寫（天真做法）★★ | 🔴 200 次「寫主庫後立刻讀從庫」→ **讀到 0 次（0.0%）、讀不到 200 次（100.0%）**<br>📌 讀不到的那些：平均 **1 ms** 後出現，最久 **12 ms** |
| **W2** | 讀己之寫（GTID 等待）★★ | ✅ **讀到 200 次（100.0%）、讀不到 0 次**、等待逾時 0 次<br>✅ 成本：平均 **1.12 ms**、最久 **4.69 ms**<br>🔴 `@@SESSION.gtid_executed` 不存在（`Variable 'gtid_executed' is a GLOBAL variable`）→ 用 `@@GLOBAL.gtid_executed` |
| **S1** | 半同步複製的成本 ★ | ✅ 開啟：平均 2.114 ms / **p50 2.125 ms** / p99 4.536 ms / 473 TPS<br>✅ 關閉：平均 1.981 ms / **p50 1.526 ms** / p99 4.333 ms / 505 TPS<br>📌 **p50 多 0.6 ms（39%）** ≈ 一次主從網路往返 |
| **S2** | 半同步的靜默降級 ★★ | 🔴 從庫 `STOP REPLICA` 後，主庫等了 `timeout`（1,000 ms）就**自己退回非同步**<br>🔴 `Rpl_semi_sync_source_status` → **OFF**；`Rpl_semi_sync_source_no_tx` → **500**<br>🔴 而寫入**變快了**（p50 1.066 ms、742 TPS）—— 效能監控會顯示「一切正常」 |

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 說明 |
|---|---|---|
| **跨可用區 / 跨 region** 的真實網路延遲 | 7.3.5、7.4.2、7.5.2 | 本章主從同機。所有毫秒級的絕對值都要在你自己的拓撲重量 |
| **實體備份（XtraBackup）** 的備份與還原耗時 | 7.2.1、7.2.3 | 只做了邏輯備份。實體備份的還原快很多，但綁版本與平台 |
| **`pt-table-checksum`** 的實際執行 | 7.3.8 | 需要沒有 GTID 分岔的環境，而本章環境在 R6 之後就分岔了 |
| **自動故障切換**（Orchestrator / MHA / InnoDB Cluster） | 7.5.3、7.5.4 | 需要 ≥3 節點 + 獨立仲裁層；單機容器量出來的切換時間沒有參考價值 |
| **ProxySQL / MaxScale** | 7.4.6 | 只做特性對照 |
| **`session_track_gtids = OWN_GTID`** 的驅動層路徑 | 7.4.2 | 需要 mysql-connector-j 的 `SessionStateChanges` API；本章用 `@@GLOBAL.gtid_executed` 代替 |
| **多從庫** 的負載平衡與延遲差異 | 7.4.6 | 本章只有一個從庫 |
| **TLS 加密的複製與連線** 的成本 | 7.7 | 只給了設定，沒有量效能影響 |
| **binlog 歸檔到物件儲存** 的實際腳本 | 7.2.9 | 給了範例，沒有在真的 S3 上跑過 |
| **雲端託管服務**（RDS / Cloud SQL）的實際 RPO | 7.5.3 | 🔴 一定要去查各家的文件，不要假設 |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果，跟「大家都這樣說」不一樣**：
>
> **①「我有備份」** ——
> B2 顯示還原比備份慢 **16.7 倍**；
> B3/B4 顯示一句併發的 DDL 讓 `mysqldump` 中止，
> 而它留下一個 **194 MB、表數量正確、可以正常還原**的檔案 ——
> 唯一的破綻在最後兩行。
> 🔴 **「備份成功」證明的只有「退出碼是 0」。**
>
> **②「延遲只有 1 毫秒，讀寫分離很安全」** ——
> W1 顯示 200 次「寫完立刻讀」，**200 次全部讀不到**。
> **機率不是由「延遲多長」決定的，是由「讀取有沒有落在視窗裡」決定的** ——
> 而「寫完立刻讀」永遠落在第 0 毫秒。
> 🔴 **延遲小讓這個 bug 更難發現，不是更少發生。**
>
> **③「從庫是唯讀的」** ——
> R6 顯示 `read_only = 1` 的從庫上，**`root` 的 `INSERT` 成功了**，
> 並且讓從庫的 GTID 集合**永久分岔**（多出它自己的 UUID）。
> 🔴 **一道你以為存在的防線，實際上取決於「應用程式連的是哪個帳號」。**
>
> **④「半同步複製保證不丟資料」** ——
> S2 顯示從庫掛掉一秒後，主庫**自己退回非同步**，
> 之後 500 筆交易沒有任何確認就提交了 ——
> 🔴 **而寫入變快了（742 TPS vs 473 TPS）。**
> **你的效能儀表板會顯示「一切正常，甚至更好」。**
>
> ⚠️ **這四個有一個共同點**：
>
> > **它們都不是「我不會設定」的問題，是「我沒有驗證過」的問題。**
> > 前六章的錯，你至少有辦法在本機重現。
> > 這一章的錯，**只有在你真的做一次的時候才會出現** ——
> > 真的還原一次備份、真的殺掉一台機器、真的量一次失敗率。
>
> **所以這一章唯一的方法論是這三句話**：
>
> > **不要問「有沒有備份」，要問「上次還原花了幾分鐘」。**
> > **不要問「延遲多少」，要問「有幾個 API 是寫完立刻讀」。**
> > **不要相信任何你沒有【親手弄壞過】的防線。**
>
> ---
>
> **07-mysql 這一站到這裡結束。** 八章下來，你手上應該有：
>
> ```
> 00  一個字元集、時區、大小寫都正確的 MySQL，以及三組守門測試
> 01  一份完整的 schema，每個欄位的型別都講得出理由
> 02  讀得懂的 SQL：JOIN 的列數膨脹、GROUP BY 的函式依賴、視窗函式
> 03  讀得懂 EXPLAIN，能算 key_len，知道索引為什麼失效
> 04  能說明 MVCC、四種隔離級別、七組加鎖範圍、五種死鎖模式
> 05  一份效能基線 + 排查 SOP + 可以放進 CI 的守門測試
> 06  一套 Flyway 遷移腳本 + 黃金 schema + 線上大表變更的決策樹
> 07  一份演練過的災難復原文件 + 讀寫分離的實作 + 四類監控指標
> ```
>
> **下一站是 [08-jpa-mybatis/](../08-jpa-mybatis/)。**
> 這一站講的都是「資料庫這一側」——
> 而下一站要回答一個一直被推遲的問題：
>
> > **當你用 JPA 的時候，這八章講的每一件事還算數嗎？**
> > `findAll()` 產生的 SQL 有沒有走索引？
> > `@OneToMany` 的 N+1 為什麼在 05 章只慢 15 倍、在正式環境慢 15 秒？
> > 而 06 章那個 `@Transactional` 的邊界，在 Hibernate 的 session 裡到底在哪裡？

---

**上一章**：[06-schema-migration-flyway.md](./06-schema-migration-flyway.md) — Schema 版本控管與線上變更
**下一站**：[../08-jpa-mybatis/](../08-jpa-mybatis/) — JPA / Hibernate 與 MyBatis
