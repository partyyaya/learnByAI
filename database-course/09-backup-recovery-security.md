# 第 09 章：備份、恢復、安全與權限

> 前面幾章教你把資料庫設計得又快又能擴展。這章要問一個更根本的問題：**出事的時候，你救得回來嗎？**
> 誤刪一張表、硬碟壞掉、被 SQL Injection 拖走整個 users 表——這些不是「會不會發生」，而是「什麼時候發生」。
> 沒有經過演練的備份等於沒有備份。這章講備份、恢復、權限與資料安全。

---

## 9.1 學習目標

完成本章後，你應該可以：

- 分辨備份與複製的差別，說明為什麼兩者都要。
- 說明全量備份、增量備份、邏輯備份與物理備份。
- 理解 PITR（時間點恢復）的原理與價值。
- 設計最小權限的資料庫帳號。
- 防範 SQL Injection，理解參數化查詢為什麼有效。
- 對敏感資料做加密與去識別化，並建立審計日誌。

---

## 9.2 備份 ≠ 複製（再強調一次）

第 08 章結尾講過，這裡正式定義，因為太重要：

| | 複製（Replication） | 備份（Backup） |
|--|--------------------|----------------|
| 目的 | 高可用、分擔讀取 | 災難恢復、可回溯 |
| 時效 | 即時同步 | 定期快照 + 日誌 |
| 防硬體故障 | ✅ | ✅ |
| 防誤刪/誤改/攻擊 | ❌（錯誤會即時同步過去） | ✅（可回到出錯前） |
| 能回到過去某時間點 | ❌ | ✅（PITR） |

一句話：**複製防「機器壞」，備份防「人做錯事、資料被寫壞」。**

真實案例模式：工程師在正式環境跑 `DELETE FROM orders`（漏了 `WHERE`），複製讓所有從庫瞬間一起清空——這時只有備份能救你。

---

## 9.3 備份的類型

### 全量備份 vs 增量備份

- **全量備份（Full）**：備份整個資料庫。恢復簡單，但佔空間、耗時。
- **增量備份（Incremental）**：只備份「自上次備份以來變更的部分」。省空間，但恢復要「全量 + 一連串增量」依序套用。

常見策略是組合：

```text
每週日：一次全量備份
每天：  一次增量備份
持續：  保存交易日誌（WAL/binlog）
```

### 邏輯備份 vs 物理備份

- **邏輯備份**：匯出成 SQL 語句或資料檔（如 `pg_dump`、`mysqldump`）。可讀、可跨版本、可選部分表，但大資料庫慢。
- **物理備份**：直接複製資料檔案（如 `pg_basebackup`、Percona XtraBackup）。快、適合大資料庫，但綁定版本與環境。

### 範例：PostgreSQL

邏輯備份與還原：

```bash
# 備份單一資料庫
pg_dump -U course -d course_db -F c -f course_db_20260703.dump

# 還原
pg_restore -U course -d course_db_restored course_db_20260703.dump
```

### 範例：MySQL

```bash
mysqldump -u root -p --single-transaction course_db > course_db_20260703.sql

mysql -u root -p course_db_restored < course_db_20260703.sql
```

`--single-transaction` 讓匯出在一個一致的快照下進行，不長時間鎖表。

---

## 9.4 PITR：時間點恢復（Point-In-Time Recovery）

只有「每天一次的全量備份」還不夠。如果誤刪發生在下午 3 點，而備份是凌晨 2 點，你會遺失 13 小時的資料。

PITR 讓你恢復到**任意一個時間點**，原理是：

```text
全量備份（基準點）  +  之後的交易日誌（WAL/binlog）
   凌晨 2:00              2:00 ~ 誤刪前一刻的每一筆變更
        │                          │
        └──── 還原基準 ────────────┤
                    重放日誌到 14:59:59（誤刪前）
```

- PostgreSQL 靠 **WAL（Write-Ahead Log）**：先持續歸檔 WAL，恢復時還原基準備份再重放 WAL 到指定時間。
- MySQL 靠 **binlog**：還原全量備份後，用 `mysqlbinlog` 重放到指定時間點。

MySQL PITR 概念範例：

```bash
# 1. 先還原最近一次全量備份
mysql -u root -p course_db < full_backup.sql

# 2. 重放 binlog 到誤刪前一刻（--stop-datetime）
mysqlbinlog --stop-datetime="2026-07-03 14:59:59" \
  mysql-bin.000042 | mysql -u root -p course_db
```

**心智模型**：全量備份是「存檔點」，交易日誌是「存檔之後的每一步操作」。PITR = 讀存檔 + 重走到你要的那一刻。

---

## 9.5 3-2-1 備份原則與「演練」

業界通用的 **3-2-1 原則**：

```text
3 份資料副本
2 種不同儲存媒介
1 份異地（off-site，例如不同機房/雲區域）
```

再加現代常見的一條：**至少 1 份離線或不可變（immutable）**，防勒索軟體把備份也加密。

### 最重要的一句話：沒演練過的備份 = 沒有備份

太多團隊「每天都有備份」，真出事時才發現：

- 備份檔早就壞了/是空的。
- 沒人知道還原流程，手忙腳亂幾小時。
- 還原需要的密鑰/版本對不上。

所以要定期做**恢復演練**：拿備份到獨立環境實際還原一次，計時、記錄步驟。這也順便驗證你的 **RTO / RPO**：

- **RPO（Recovery Point Objective）**：能容忍遺失多少資料（決定備份頻率）。
- **RTO（Recovery Time Objective）**：能容忍多久恢復完成（決定備份/還原方案）。

---

## 9.6 最小權限原則（Principle of Least Privilege）

資料庫帳號權限，是安全的第一道防線。核心原則：**每個帳號只給它「完成工作所需的最小權限」。**

### 反例：整個系統用一個 root/superuser

```text
Web 應用用 root 連資料庫
→ 一旦應用被入侵或有 SQL Injection
→ 攻擊者直接擁有 DROP DATABASE、讀所有表、建新帳號的能力
```

### 正確做法：按角色分帳號

```sql
-- 應用程式帳號：只能對業務表做 CRUD，不能改結構、不能刪庫
CREATE USER app_user WITH PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;

-- 唯讀報表帳號：只能查（給 BI 工具、分析師）
CREATE USER report_user WITH PASSWORD '...';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO report_user;

-- 遷移/DDL 帳號：只在部署 migration 時使用，平時不給應用
CREATE USER migration_user WITH PASSWORD '...';
GRANT ALL PRIVILEGES ON DATABASE course_db TO migration_user;
```

延伸原則：

- 正式環境與開發環境用**不同帳號、不同密碼**。
- 應用帳號**不給** `DROP`、`GRANT`、超級使用者權限。
- 定期輪換密碼，密碼放密鑰管理系統，不要寫死在程式碼或提交進 git。
- 限制連線來源 IP（只允許應用伺服器網段）。

這正好呼應：即使前面有 SQL Injection 漏洞，最小權限能把「災難級」降為「有限損害」。

---

## 9.7 SQL Injection：最經典的資料庫攻擊

### 漏洞怎麼來的

問題根源是**把使用者輸入直接拼進 SQL 字串**：

```python
# 危險！絕對不要這樣寫
query = "SELECT * FROM users WHERE email = '" + user_input + "'"
```

如果使用者在登入框輸入：

```text
' OR '1'='1
```

拼出來的 SQL 變成：

```sql
SELECT * FROM users WHERE email = '' OR '1'='1'
```

`'1'='1'` 永遠為真，等於回傳整張 users 表，登入驗證被繞過。更嚴重的還能：

```text
'; DROP TABLE users; --
```

### 為什麼會這樣：資料與指令混在一起

SQL Injection 的本質是**信任邊界錯置**：使用者輸入（資料）被當成了 SQL（指令）來執行。這和第 06、07 章「輸入即危險」是同一個心智模型。

### 正解：參數化查詢（Prepared Statement）

```python
# 安全：用參數佔位符，讓驅動把輸入當「純資料」
cursor.execute(
    "SELECT * FROM users WHERE email = %s",
    (user_input,)
)
```

為什麼有效：參數化查詢下，SQL 的「結構」先被資料庫編譯確定，使用者輸入只會被當成一個**值**填入，永遠不可能改變 SQL 的結構。就算輸入 `' OR '1'='1`，它也只是被當成「一個很奇怪的 email 字串」去比對，而不是 SQL 邏輯。

各語言/框架都有對應寫法：

```text
Java（JDBC）：PreparedStatement + setString
Node（node-postgres）：client.query('... WHERE id = $1', [id])
Python：cursor.execute('... WHERE id = %s', (id,))
ORM（Prisma/Hibernate/SQLAlchemy）：預設就是參數化
```

### 防禦層次

1. **一律用參數化查詢**（最重要，能擋掉絕大多數）。
2. **輸入驗證**：型別、長度、白名單（例如排序欄位只允許固定清單）。
3. **最小權限**（9.6 節）：即使被打穿，限制損害範圍。
4. **關掉詳細錯誤訊息**：別把 SQL 錯誤原文回給前端，避免洩漏結構。

> 注意動態欄位名/表名不能用參數化（參數只能是值）。若排序欄位來自使用者，要用白名單比對，不能拼字串。

---

## 9.8 敏感資料的保護

### 傳輸中加密（In Transit）

應用到資料庫的連線要開 **TLS/SSL**，避免明文在網路上被竊聽。雲端託管資料庫通常預設或可強制要求。

### 靜態加密（At Rest）

資料檔、備份檔在磁碟上加密（TDE、雲端磁碟加密），防止硬碟/備份檔外流時被直接讀取。

### 欄位級處理：加密、雜湊、去識別化

不同資料用不同手段：

- **密碼**：**絕不加密**（加密可解回），要用**單向雜湊 + salt**，如 bcrypt、argon2。
  ```text
  儲存：bcrypt("使用者密碼" + salt)
  驗證：比對雜湊，而不是解密比對
  ```
- **身分證、信用卡號**：需要可還原時用**加密**（如 AES）；不需還原、只需比對時用雜湊。信用卡建議走符合 PCI-DSS 的第三方，不要自己存全卡號。
- **遮罩（Masking）**：顯示時只露部分，如 `王**`、`****-****-****-1234`。
- **去識別化（Anonymization）**：給分析/測試用的資料，抹掉可識別個資。

### 一個常見錯誤

把密碼用「可解密的加密」或直接明文存。一旦資料庫外洩，所有使用者密碼全裸。密碼永遠用不可逆雜湊。

---

## 9.9 審計日誌（Audit Log）

審計日誌回答：**誰、在什麼時候、對什麼資料、做了什麼。**

用途：

- 事後追查（資料被誰改了）。
- 合規要求（金融、醫療）。
- 偵測異常（某帳號半夜大量匯出資料）。

實作層次：

1. **資料庫層**：開啟資料庫的審計功能（如 PostgreSQL 的 `pgAudit`、MySQL Enterprise Audit）。
2. **應用層**：關鍵操作寫一張 `audit_logs` 表。

```sql
CREATE TABLE audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    BIGINT NOT NULL,          -- 誰
    action      VARCHAR(50) NOT NULL,     -- 做了什麼：UPDATE_ORDER、DELETE_USER
    target_type VARCHAR(50) NOT NULL,     -- 對什麼：order、user
    target_id   VARCHAR(64) NOT NULL,
    detail      JSONB,                    -- 前後值等細節
    ip_address  INET,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

原則：

- 審計日誌本身應**唯讀、不可竄改**（append-only），最好另存或轉出到獨立系統。
- 別把敏感資料（密碼、完整卡號）寫進日誌。

---

## 9.10 資料庫安全檢查清單

```text
連線
[ ] 應用與 DB 之間開啟 TLS
[ ] 只允許應用伺服器網段連線，不對公網開放 DB 埠

帳號權限
[ ] 應用帳號最小權限，不用 root/superuser
[ ] 讀寫、唯讀、遷移分不同帳號
[ ] 密碼存在密鑰管理系統，不寫死在程式/git
[ ] 定期輪換憑證

注入防禦
[ ] 一律參數化查詢
[ ] 動態欄位名用白名單
[ ] 關閉對外的詳細 SQL 錯誤訊息

資料保護
[ ] 密碼用 bcrypt/argon2 雜湊
[ ] 敏感欄位加密或遮罩
[ ] 靜態加密（磁碟/備份）

備份與恢復
[ ] 全量 + 增量 + 交易日誌
[ ] 3-2-1 原則，至少一份異地
[ ] 定期做恢復演練，確認 RTO/RPO

審計
[ ] 關鍵操作有審計日誌
[ ] 審計日誌不可竄改、不含敏感資料
```

---

## 9.11 常見錯誤

### 錯誤 1：只有複製，沒有備份

誤以為從庫就是備份。誤刪會即時同步到從庫，只有真正的備份 + PITR 能救。

### 錯誤 2：從沒還原過備份

備份天天跑，但從沒驗證能不能還原。真出事時才發現備份是壞的。要定期演練。

### 錯誤 3：應用直接用 superuser 連 DB

一個 SQL Injection 就能 `DROP DATABASE`。務必最小權限。

### 錯誤 4：字串拼接 SQL

「我有做輸入過濾應該還好」——過濾很難窮盡所有繞過方式。唯一可靠解是參數化查詢。

### 錯誤 5：密碼可解密儲存或明文

資料庫外洩時全部使用者密碼裸奔。密碼用不可逆雜湊，永遠不要能解回原文。

### 錯誤 6：備份檔沒加密、隨意存放

備份檔含全量資料，若沒加密又放在可公開存取的位置，等於把整個資料庫送出去。

---

## 9.12 本章練習

### 練習 1：能不能救回來

週日凌晨 2:00 有全量備份，並持續歸檔交易日誌。週一下午 3:00 工程師誤刪了 `orders` 表一半的資料。請問：

1. 只有「每天全量備份」但沒存交易日誌，最多能恢復到什麼狀態？會遺失多少資料？
2. 有全量備份 + 交易日誌，能恢復到什麼程度？

#### 參考解答

1. 只能恢復到**最近一次全量備份的時間點**，也就是週一凌晨 2:00（若週一也有跑）。從 2:00 到 15:00 誤刪前的所有新資料都會遺失（約 13 小時）。這就是為什麼光有全量備份不夠。

2. 有交易日誌就能做 **PITR**：還原最近的全量備份為基準，再重放交易日誌到「誤刪發生前一刻」（例如 14:59:59），幾乎可以零資料遺失地恢復，且不包含那個誤刪操作。

### 練習 2：修掉 SQL Injection

以下登入程式有漏洞，說明如何被攻擊，並改成安全版本：

```python
email = request.form['email']
pwd = request.form['password']
sql = "SELECT * FROM users WHERE email = '" + email + "' AND password = '" + pwd + "'"
cursor.execute(sql)
```

#### 參考解答

攻擊方式：在 email 欄輸入 `' OR '1'='1' --`，SQL 變成

```sql
SELECT * FROM users WHERE email = '' OR '1'='1' --' AND password = '...'
```

`OR '1'='1'` 恆真，`--` 把後面的密碼判斷註解掉，直接繞過登入。

安全版本（參數化 + 密碼雜湊比對）：

```python
email = request.form['email']
pwd = request.form['password']

# 參數化查詢：email 只會被當成「值」，無法改變 SQL 結構
cursor.execute("SELECT id, password_hash FROM users WHERE email = %s", (email,))
row = cursor.fetchone()

# 密碼是雜湊儲存，用雜湊函式驗證，而不是明文比對
if row and bcrypt.checkpw(pwd.encode(), row['password_hash'].encode()):
    login_ok(row['id'])
else:
    login_failed()
```

重點：

- 用參數化查詢，杜絕注入。
- 密碼用 bcrypt 雜湊，不在 SQL 裡比對明文密碼。
- 帳號或密碼錯給一樣的模糊錯誤訊息，避免洩漏「這個 email 是否存在」。

### 練習 3：設計權限帳號

一個系統有三種存取者：Web 應用（日常 CRUD）、資料分析師（用 BI 工具查數字）、CI/CD（部署時跑 migration 改表結構）。請為它們設計帳號權限。

#### 參考解答

```sql
-- Web 應用：業務表 CRUD，不能改結構、不能刪庫
CREATE USER app_user WITH PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;

-- 分析師：唯讀
CREATE USER analyst_user WITH PASSWORD '...';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analyst_user;

-- CI/CD migration：DDL 權限，僅部署時使用
CREATE USER migration_user WITH PASSWORD '...';
GRANT ALL PRIVILEGES ON SCHEMA public TO migration_user;
```

理由：

- 三者職責不同，權限按最小必要切分。
- 應用帳號被打穿時，攻擊者拿不到 `DROP TABLE`/改結構的能力。
- 分析師只讀，不可能誤改正式資料。
- migration 帳號權限最大，所以平時不給應用使用、只在受控的部署流程中用，並嚴格保管憑證。
- 最好再限制各帳號的來源 IP，並對正式/開發環境使用不同憑證。

### 練習 4：密碼與身分證該怎麼存

系統要存使用者密碼和身分證字號。這兩者的儲存方式應該一樣嗎？為什麼？

#### 參考解答

不一樣，取決於「事後需不需要還原原值」。

- **密碼**：永遠不需要還原原值（驗證時只需比對），所以用**單向雜湊 + salt**（bcrypt/argon2）。這樣即使資料庫外洩，也無法直接得到原始密碼。絕不可用可解密的加密或明文。

- **身分證字號**：業務上可能需要還原（顯示、跟政府系統核對），所以用**可逆的加密**（如 AES），金鑰放密鑰管理系統嚴格保管。若某些場景只需比對「是不是同一個人」而不需還原，也可另存一份雜湊值供比對；顯示時再做遮罩（如 `A12****789`）。

核心判斷：**要不要拿回原值** → 不要就雜湊，要就加密。

---

## 9.13 驗收清單

- [ ] 我能說清楚備份和複製的差別，知道兩者都要。
- [ ] 我了解全量/增量、邏輯/物理備份的取捨。
- [ ] 我能解釋 PITR 如何靠「全量備份 + 交易日誌」恢復到任意時間點。
- [ ] 我知道 3-2-1 原則，且理解「沒演練過的備份等於沒有備份」。
- [ ] 我會設計最小權限的資料庫帳號。
- [ ] 我能說明 SQL Injection 原理，並用參數化查詢防禦。
- [ ] 我知道密碼要雜湊、敏感資料要加密/遮罩，關鍵操作要審計。

---

完成後請前往 [10-capstone-ticketing-platform.md](./10-capstone-ticketing-platform.md)。
