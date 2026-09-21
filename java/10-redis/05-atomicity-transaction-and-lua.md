# 第 05 章：原子性——交易、Lua 與 pipeline

> 這是第一部分的最後一章，也是**整站的樞紐**。
>
> 前面出現過兩次一模一樣的事故，只是換了外衣：
>
> - **00 章 0.3.4**：200 個人搶 100 件庫存，賣出 **200 件**，而庫存顯示還剩 98。
> - **02 章 2.4.4**：200 個人各加 1 點，12500 應該變成 12700，實際是 **12502**——**掉了 198 次更新**。
>
> 兩個都是同一句話：
>
> > **「讀出來、改、寫回去」中間有一道縫。**
>
> 這一章把 Redis 能封住這道縫的**四個工具**放在一起量：
>
> | 工具 | 200 個人搶 100 件的結果 | 代價 |
> |---|---|---|
> | pipeline | ❌ **完全沒幫助**（它只是打包） | —— |
> | `MULTI` / `EXEC` | ❌ **也沒幫助**（它不能「讀了再決定」） | —— |
> | `WATCH` + `MULTI` | ✅ 正確 | **總共重試了 5,440 次** |
> | **Lua** | ✅ 正確 | **0 次重試** |
>
> 而 Lua 還能做到前三者都做不到的事：**「我要買 3 件，庫存不足就整筆不賣」**。
>
> ⚠️ 但 Lua 有三個會讓你在正式環境出事的坑，這一章會一個一個實測：
> **一段跑 7 秒的腳本讓其他人收到 `BUSY` 錯誤**、
> **`SCRIPT KILL` 殺不掉已經寫過資料的腳本**（只能重啟整台）、
> 以及**腳本中途出錯時，前面改掉的東西一樣不回滾**。
>
> 📌 **後面九章的分散式鎖（09）、限流（10）、預扣庫存（12），全部建立在這一章上。**

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說出「原子性」在 Redis 上**精確**的意思，以及它跟資料庫交易的差別（5.2）。
- 說出 pipeline、`MULTI`、`WATCH`、Lua 四者各自保證什麼、不保證什麼（5.9 的對照表）。
- 說明 `MULTI` 的兩種錯誤——**入隊時發現的**與**執行時才發現的**——結局完全不同（5.4.2）。
- 用一句話解釋「**Redis 的交易不回滾**」，並說出為什麼作者認為這是對的（5.4.3）。
- 用 `WATCH` 寫出一個正確的 CAS 迴圈，並說出它在高競爭下的代價（5.5）。
- 寫出一段 Lua 腳本，正確使用 `KEYS` 與 `ARGV`，並說明為什麼**不能**把 key 寫死在腳本裡（5.6.2）。
- 說出 `EVAL` 與 `EVALSHA` 的差別，以及 `NOSCRIPT` 錯誤該怎麼處理（5.6.5）。
- 分辨 `redis.call` 與 `redis.pcall`，並說出腳本出錯時**已經執行的部分會怎樣**（5.6.6）。
- 說出 `busy-reply-threshold` 的作用，以及 `SCRIPT KILL` **什麼時候會失敗**（5.8）。
- 在 Spring 這一側用 `DefaultRedisScript` 與 `SessionCallback` 正確地寫這四種東西，
  並指出**直接呼叫 `redisTemplate.multi()` 為什麼是錯的**（5.7）。

---

## 5.2 先定義：Redis 的「原子」是什麼

03 章 3.2.4 已經給了答案，這裡把它說完整：

> **Redis 用一個執行緒執行命令，一條執行完才換下一條。**
> **所以「一條命令」就是原子的——中間不可能有別人插進來。**

| | |
|---|---|
| `INCR n` | ✅ 原子（一條命令） |
| `DECRBY stock 3` | ✅ 原子 |
| `HINCRBY user points 1` | ✅ 原子 |
| `SET k v NX EX 30` | ✅ 原子（**一條**命令做了三件事） |
| `GET stock` 然後 `SET stock 99` | ❌ **兩條命令，中間有縫** |
| `SETNX lock 1` 然後 `EXPIRE lock 30` | ❌ 兩條。**09 章第一個要拆掉的錯誤寫法** |

⚠️ **注意 Redis 的「原子」跟資料庫交易的「原子」不是同一件事**：

| | 資料庫交易（ACID 的 A） | Redis |
|---|---|---|
| 「全部成功或全部失敗」 | ✅ 有 rollback | ❌ **沒有回滾**（5.4.3） |
| 「中間別人看不到中間狀態」 | ✅ 有隔離級別 | ✅ 有（單執行緒） |

> 📌 **所以本章說的「原子」只有一個意思：**
> **這一組操作執行的時候，別人插不進來。**
> **它不代表「出錯了會復原」。** 這個分界是這一章最重要的觀念。

---

## 5.3 pipeline：它在這一章沒有位置

03 章 3.8.3 已經證明過，這裡只做一次總結，因為它常被誤當成交易：

```
兩個 pipeline（各 3 條 APPEND）交錯的結果: ABBBAA
（如果 pipeline 是原子的，只會看到 AAABBB 或 BBBAAA）
```

| pipeline | |
|---|---|
| 少幾次網路往返 | ✅ **這是它唯一的目的**（快 25～126 倍） |
| 中間不會插進別人的命令 | ❌ |
| 一條失敗其他條回滾 | ❌ |

**pipeline 是網路優化，不是一致性工具。** 這一章剩下的部分不再提它。

---

## 5.4 `MULTI` / `EXEC`：一組命令，中間插不進來

### 5.4.1 基本樣子

```
127.0.0.1:6379> SET balance 100
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> DECRBY balance 30
QUEUED                              ← 注意：不是執行，是「排進去了」
127.0.0.1:6379> INCRBY other 30
QUEUED
127.0.0.1:6379> GET balance
QUEUED
127.0.0.1:6379> EXEC
1) (integer) 70                     ← 三條命令的結果一次回來
2) (integer) 30
3) "70"
```

**三個重點**：

| | |
|---|---|
| `MULTI` 之後的命令回 **`QUEUED`** | 它們**還沒執行**，只是排進這個連線的佇列 |
| `EXEC` 才真的執行 | **一次執行完整組，中間不會有別人的命令插進來** |
| 回傳是一個陣列 | 每個元素對應一條命令的結果 |

📌 **還有兩條相關命令**：`DISCARD`（放棄整組，清空佇列）、
`UNWATCH`（取消所有 `WATCH`，5.5 會用到）。

### 5.4.2 ⚠️ 兩種錯誤，兩種完全不同的結局

**錯誤一：入隊時就被發現（例如命令不存在、參數個數錯）**

```
127.0.0.1:6379> SET x 1
127.0.0.1:6379> MULTI
127.0.0.1:6379> SET y 2
QUEUED
127.0.0.1:6379> NOSUCHCOMMAND a b
(error) ERR unknown command 'NOSUCHCOMMAND', with args beginning with: 'a' 'b'
127.0.0.1:6379> INCR x
QUEUED
127.0.0.1:6379> EXEC
(error) EXECABORT Transaction discarded because of previous errors.
127.0.0.1:6379> GET x
"1"                    ← 沒變
127.0.0.1:6379> GET y
(nil)                  ← 也沒執行
```

**整組被取消，一條都沒執行。** 這是 Redis 唯一會「全部不做」的情況。

**錯誤二：執行時才發現（例如 `WRONGTYPE`）**

```
127.0.0.1:6379> SET str hello
127.0.0.1:6379> SET n 1
127.0.0.1:6379> MULTI
127.0.0.1:6379> INCR n
QUEUED
127.0.0.1:6379> LPUSH str world        ← str 是 string，不能 LPUSH
QUEUED                                  ← ⚠️ 入隊時看不出來
127.0.0.1:6379> INCR n
QUEUED
127.0.0.1:6379> EXEC
1) (integer) 2
2) (error) WRONGTYPE Operation against a key holding the wrong kind of value
3) (integer) 3                          ← ⚠️ 第三條照樣執行了
127.0.0.1:6379> GET n
"3"                                     ← INCR 執行了兩次
127.0.0.1:6379> GET str
"hello"                                 ← 只有出錯的那條沒生效
```

> ⚠️ **這是本節最重要的輸出。**
> 第二條命令失敗了，**第一條和第三條照樣生效**——`n` 從 1 變成 3。
> **錯誤只是回傳陣列裡的一個元素，它不會中斷後面的命令，也不會回滾前面的。**

### 5.4.3 「Redis 的交易不回滾」——而且作者認為這是對的

Redis 官方文件對這件事的立場很明確，理由是：

> **執行期的錯誤（`WRONGTYPE`、`INCR` 一個非數字）幾乎都是「程式寫錯了」，不是「執行期的意外」。**
> 這種錯誤應該在開發與測試階段就被發現，而不是靠正式環境的回滾機制去掩蓋。
> **為了支援回滾而讓所有交易都變慢、讓實作變複雜，不划算。**

你可以不同意這個立場，但你**必須**知道它的後果：

```java
// ❌ 這段程式碼的假設是錯的
try {
    // ...MULTI / EXEC...
} catch (Exception e) {
    log.warn("交易失敗，等一下重試");
    retry();                 // ⚠️ 但有些命令已經生效了，重試 = 執行兩次
}
```

**這跟 03 章 3.8.3 的 `RedisPipelineException` 是同一個陷阱**：
**拋例外 ≠ 沒生效。**

### 5.4.4 `MULTI` 的真正限制：它不能「讀了再決定」

回到超賣問題。用 `MULTI` 能解決嗎？

```
MULTI
GET stock          ← QUEUED，現在拿不到結果
DECR stock         ← 我要在「知道 stock 是多少」之後才決定要不要扣，但我拿不到
EXEC
```

**做不到。** 因為 `MULTI` 裡的命令**在 `EXEC` 之前都不執行，所以你拿不到任何中間結果**。

> 📌 **`MULTI` 只適合「一組固定的、不需要判斷的操作」**：
> 「同時寫三個 key」「刪一個 key 的同時把它加進另一個集合」。
>
> **只要你的邏輯裡有 `if`，`MULTI` 就不夠用。** 於是有了 `WATCH` 與 Lua。

---

## 5.5 `WATCH`：樂觀鎖

### 5.5.1 它怎麼運作

`WATCH` 的語意是：**「盯住這個 key。如果在我 `EXEC` 之前有人改了它，整個交易就作廢。」**

```
--- 情境一：沒有人動它 ---
127.0.0.1:6379> SET stock 10
127.0.0.1:6379> WATCH stock
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379> DECR stock
QUEUED
127.0.0.1:6379> EXEC
1) (integer) 9                 ← 成功
```

```
--- 情境二：WATCH 之後、EXEC 之前，別人改了它 ---
（A 連線）WATCH stock
（B 連線）SET stock 999         ← 別人插隊
（A 連線）MULTI
（A 連線）DECR stock
（A 連線）EXEC
(nil)                          ← ⚠️ 回 nil，整個交易沒有執行
127.0.0.1:6379> GET stock
"999"                          ← B 的值還在，A 什麼都沒做
```

> 📌 **`EXEC` 回 `(nil)` 就是「你被插隊了」的訊號。**
> 這時候正確的做法是**重新讀一次、重新判斷、重新提交**——也就是重試。

### 5.5.2 標準的 CAS 迴圈

```
     WATCH key
     value = GET key              ← 讀（這時候已經在盯著了）
     if (不滿足條件) { UNWATCH; 放棄 }
     MULTI
     ...根據 value 決定要做什麼...
     result = EXEC
     if (result == nil) 回到第一行重來
```

⚠️ **三個容易寫錯的地方**：

| 錯誤 | 後果 |
|---|---|
| `WATCH` 寫在 `GET` **後面** | 那道縫還在——你讀完之後、`WATCH` 之前別人就改了 |
| 決定放棄時沒有 `UNWATCH` | 這個連線還盯著那個 key，**影響它下一次的交易** |
| 重試沒有上限 | 高競爭時無限迴圈 |

### 5.5.3 實測：它對，但代價很高

用 `WATCH` 解 200 個人搶 100 件（完整程式碼在 5.7.3）：

```
═══ 5.7.3 WATCH 做樂觀鎖：200 個人搶 100 件 ═══
  賣出 100 件（庫存顯示 0）
  重試次數 5440，放棄 100 人
  → 正確，但 200 個人總共重試了 5440 次（Lua 版是 0 次）
```

**結果是對的：正好賣出 100 件。**

但代價是 **5,440 次重試**——每一次重試都是
`WATCH` + `GET` + `MULTI` + `DECR` + `EXEC` **五次網路往返**。

> 📌 **這是「樂觀鎖」的本質**：
> **它假設衝突很少。衝突愈多，它愈糟。**
>
> | 場景 | `WATCH` 適合嗎 |
> |---|---|
> | 每個使用者改自己的購物車（幾乎不衝突） | ✅ 很適合 |
> | 200 個人搶同一個庫存 key（每次都衝突） | ❌ **重試風暴** |
>
> **搶購這種「所有人擠同一個 key」的場景，樂觀鎖是最差的選擇。**

---

## 5.6 Lua：唯一真正的原子

### 5.6.1 為什麼它是原子的

> **Redis 把整段 Lua 腳本當成「一條命令」來執行。**
> 腳本跑完之前，**任何其他客戶端的任何命令都不會被執行**。

這一句話同時是它的**優點**（真原子）與**缺點**（5.8：腳本跑太久會卡住所有人）。

### 5.6.2 第一段腳本：`KEYS` 與 `ARGV`

```
127.0.0.1:6379> EVAL "return {KEYS[1], KEYS[2], ARGV[1], ARGV[2]}" 2 key1 key2 arg1 arg2
1) "key1"
2) "key2"
3) "arg1"
4) "arg2"
```

語法是：`EVAL <腳本> <有幾個 key> <key1> <key2> ... <arg1> <arg2> ...`

**那個「有幾個 key」的數字是必要的**，它把參數切成兩半：
前面 N 個進 `KEYS`，其餘進 `ARGV`。

> ⚠️ **為什麼一定要把 key 放進 `KEYS`，而不是寫死在腳本裡或塞進 `ARGV`？**
>
> ```lua
> -- ❌ 錯：key 寫死在腳本裡
> return redis.call('GET', 'stock:1001')
>
> -- ❌ 也錯：key 藏在 ARGV 裡
> return redis.call('GET', ARGV[1])
>
> -- ✅ 對
> return redis.call('GET', KEYS[1])
> ```
>
> **因為 Cluster 需要知道這段腳本會碰哪些 key**，才能決定要送到哪個節點
> （而且會檢查它們是不是在同一個 slot）。
> 寫死或塞進 `ARGV` 的 key，Cluster 看不到——**單機跑得好好的腳本，上 Cluster 就會出錯**（13 章）。
>
> **這是一個「現在不遵守，以後一定要重寫」的規則。**

### 5.6.3 用 Lua 解超賣

```lua
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then return -2 end          -- key 不存在
local want = tonumber(ARGV[1])
if stock < want then return -1 end          -- 庫存不足
return redis.call('DECRBY', KEYS[1], want)  -- 扣掉，回傳剩餘
```

```
127.0.0.1:6379> SET stock 10
127.0.0.1:6379> EVAL "<上面那段>" 1 stock 3
(integer) 7                       ← 扣完剩 7
127.0.0.1:6379> GET stock
"7"
127.0.0.1:6379> EVAL "<上面那段>" 1 stock 999
(integer) -1                      ← 庫存不足，一件都沒扣
127.0.0.1:6379> GET stock
"7"
127.0.0.1:6379> EVAL "<上面那段>" 1 沒有這個key 1
(integer) -2                      ← key 不存在（12 章 12.4.2 會說明為什麼要跟「庫存 0」分開）
```

**200 個執行緒的實測**（完整程式碼在 5.7.4）：

```
═══ 5.6.3 200 個人搶 100 件：Lua 版 ═══
先查再扣（00 章）: 賣出 200 件，庫存顯示 98
Lua 腳本        : 賣出 100 件，擋下 100 件，庫存顯示 0
一次買 3 件      : 33 個人買到，共 99 件，庫存顯示 1
```

**三行要一起看**：

| | 結果 | |
|---|---|---|
| 先查再扣（00 章 0.3.4） | 賣出 **200** 件，庫存顯示 98 | ❌ 超賣 100 件 |
| Lua | 賣出 **100** 件，擋下 100 件 | ✅ 正好 |
| **一次買 3 件** | **33 個人各買 3 件 = 99 件，剩 1 件** | ✅ **第 34 個人要 3 件但只剩 1 件，整筆被拒絕** |

> ⭐ **第三行是 Lua 不可取代的理由。**
>
> `DECRBY stock 3` 也是原子的，但它**會扣成負數**——你得事後補回去（00 章 0.3.4 的寫法 B）。
> 而「**先檢查，不夠就一件都不賣**」這個邏輯，
> **只有把判斷跟扣減放進同一個原子單位才做得到。**
>
> **這就是 Lua 在這一站的定位：它讓「帶條件的操作」變成一條命令。**
> 09 章的鎖釋放、10 章的限流、12 章的預扣庫存，全部是這個形狀。

### 5.6.4 能用什麼、不能用什麼

| 可以 | 說明 |
|---|---|
| `redis.call(...)` / `redis.pcall(...)` | 呼叫任何 Redis 命令 |
| Lua 5.1 的標準功能 | `tonumber`、`tostring`、`string.*`、`table.*`、`math.*`、`cjson`、迴圈、條件 |
| `cjson.encode` / `cjson.decode` | 處理 JSON（**內建，不用引入**） |
| `redis.status_reply` / `redis.error_reply` | 自訂回傳 |
| `redis.breakpoint` / `redis.debug` | 配合 `redis-cli --ldb` 除錯 |

| **不可以** | 為什麼 |
|---|---|
| 存取檔案、網路、系統 | 沙箱擋掉了：`return type(io)` 會得到 `ERR ... Script attempted to access nonexistent global variable 'io'` |
| 指望**阻塞命令真的阻塞**（`BLPOP`、`BRPOP`…） | 它們**不會阻塞，直接當成逾時回 `nil`**——⚠️ 不報錯，所以很容易寫出「在腳本裡等訊息」這種永遠等不到的程式碼 |
| 用 `math.random` 期待每次都一樣 | Redis 會把亂數種子固定住（為了複製的一致性） |
| **寫超過幾毫秒的邏輯** | 5.8 |

**兩個實測**：

```
  空 list 上 BLPOP     -> (nil)，0 秒就回來（沒有阻塞）
  cjson.encode         -> {"name":"alice","age":30}
  cjson.decode         -> 可以，t.name = alice
```

⚠️ **回傳值的型別轉換有一些反直覺的規則**（全部實測）：

| Lua | 轉成 Redis | |
|---|---|---|
| `return 1.5` | **`(integer) 1`** | ⚠️ **小數被截掉，不是四捨五入** |
| `return 1.9` | **`(integer) 1`** | 同上 |
| `return tostring(1.5)` | `"1.5"` | ✅ 要小數就回字串 |
| `return true` | `(integer) 1` | |
| **`return false`** | **`(nil)`** | ⚠️ `false` 跟 `nil` 在 Redis 這一側**分不出來** |
| `return {1,2,3}` | `1) 1  2) 2  3) 3` | |
| **`return {1,nil,3}`** | **`1) 1`** | ⚠️ **遇到 `nil` 就截斷，後面的都不見了** |
| `return {err='my error'}` | `(error) my error` | 自訂錯誤 |
| `return {ok='fine'}` | `fine`（狀態回覆） | 等同 `redis.status_reply('fine')` |

> ⚠️ **「要回傳小數就回傳字串」**：`return tostring(1.5)`。
> 這個坑在計算金額或比率的腳本裡很常見。

### 5.6.5 `EVAL` vs `EVALSHA`：不要每次都送整段腳本

```
127.0.0.1:6379> SCRIPT LOAD "return redis.call('INCR', KEYS[1])"
"61636018f4e6b5817b89791bbed242f93fa089e3"
127.0.0.1:6379> EVALSHA 61636018f4e6b5817b89791bbed242f93fa089e3 1 counter
(integer) 1
127.0.0.1:6379> EVALSHA 0000000000000000000000000000000000000000 0
(error) NOSCRIPT No matching script. Please use EVAL.
```

**為什麼要這樣做**：一段 2 KB 的腳本，每秒呼叫一萬次就是每秒 20 MB 的頻寬——
`EVALSHA` 只送 40 個字元。

⚠️ **但 `NOSCRIPT` 是一定會發生的**：Redis 重啟、`SCRIPT FLUSH`、故障轉移到另一台，
腳本快取就空了。**正確的做法是「先試 `EVALSHA`，收到 `NOSCRIPT` 就 `EVAL` 一次」**——

📌 **好消息：Spring Data Redis 已經幫你做了這件事**（5.7.4）。

### 5.6.6 `redis.call` vs `redis.pcall`，以及「腳本也不回滾」

```
  redis.call（錯誤會中斷整個腳本）：
    (error) ERR value is not an integer or out of range script: 4c4a651f...

  redis.pcall（錯誤變成回傳值）：
    "caught: ERR value is not an integer or out of range"
```

| | 行為 |
|---|---|
| `redis.call` | 出錯 → **整個腳本立刻中止**，錯誤傳回客戶端 |
| `redis.pcall` | 出錯 → 回傳一個帶 `err` 欄位的 table，**腳本繼續跑**，你自己決定怎麼辦 |

**但最重要的是這個**：

```
127.0.0.1:6379> SET n 0
127.0.0.1:6379> SET str hello
127.0.0.1:6379> EVAL "redis.call('INCR', KEYS[1]) redis.call('LPUSH', KEYS[2], 'x') return 1" 2 n str
(error) WRONGTYPE Operation against a key holding the wrong kind of value script: 5007baab...
127.0.0.1:6379> GET n
"1"                      ← ⚠️ 腳本炸了，但 INCR 已經生效
```

> ⚠️ **Lua 腳本也不回滾。**
>
> 「原子」= 中間沒有別人插進來。**不等於「全部成功或全部失敗」。**
> 這跟 5.4.3 的 `MULTI` 是同一件事。
>
> **所以寫腳本的規則是：把所有檢查放在最前面，通過之後才開始寫入。**
>
> ```lua
> -- ✅ 正確的形狀
> local stock = tonumber(redis.call('GET', KEYS[1]))     -- 讀
> if stock == nil or stock < tonumber(ARGV[1]) then      -- 檢查
>     return -1                                           -- 還沒寫任何東西就返回
> end
> redis.call('DECRBY', KEYS[1], ARGV[1])                 -- 寫（此後不再有可能失敗的檢查）
> redis.call('HINCRBY', KEYS[2], ARGV[2], ARGV[1])
> return 1
> ```

### 5.6.7 寫 Lua 的六條規則

| | 規則 | 理由 |
|---|---|---|
| 1 | **所有 key 都走 `KEYS`** | Cluster（5.6.2） |
| 2 | **檢查全部放前面，寫入全部放後面** | 不回滾（5.6.6） |
| 3 | **腳本要短**——目標是**幾毫秒以內** | 它卡住整台 Redis（5.8） |
| 4 | **不要在腳本裡寫迴圈掃大量資料** | 同上。`for i=1,1000000` 是事故 |
| 5 | **回傳值用整數或字串，不要用浮點數** | 型別轉換會截斷（5.6.4） |
| 6 | **腳本要能重複執行**（冪等） | 客戶端逾時重送時，你不知道上一次到底有沒有跑完 |

⚠️ **第 6 條最容易被忽略**：`EVALSHA` 送出去之後客戶端逾時了——
**腳本可能已經執行完了，只是回應沒回來。** 這時候重試就是執行兩次。
10 章的冪等設計會處理這件事。

---

## 5.7 Java 這一側

### 5.7.1 ⚠️ 直接呼叫 `redisTemplate.multi()` 是錯的

`StringRedisTemplate` 上有 `multi()` 與 `exec()`，看起來可以直接用：

```java
@Test
void multiWithoutSessionCallback() {
    redis.opsForValue().set("n", "0");
    try {
        redis.multi();
        redis.opsForValue().increment("n");
        redis.opsForValue().increment("n");
        List<Object> r = redis.exec();
        System.out.println("  exec() 回傳 = " + r);
    } catch (Exception e) {
        Throwable root = e; while (root.getCause() != null) root = root.getCause();
        System.out.println("  " + e.getClass().getSimpleName() + ": " + e.getMessage());
        System.out.println("  root cause: " + root.getClass().getSimpleName() + ": " + root.getMessage());
    }
    System.out.println("  n = " + redis.opsForValue().get("n"));
}
```

```
═══ 5.7.1 直接呼叫 multi() 會怎樣 ═══
  RedisSystemException: Error in execution
  root cause: RedisCommandExecutionException: ERR EXEC without MULTI
  n = 2
```

**兩個現象一起看**：

| 現象 | 原因 |
|---|---|
| `ERR EXEC without MULTI` | `MULTI` 送到一條連線上，`EXEC` 送到另一條——**那條連線沒開過交易** |
| **`n = 2`** | ⚠️ **那兩個 `INCR` 根本沒有被排隊，它們直接執行了** |

> 📌 **根因**：`RedisTemplate` 的每一個方法呼叫，**預設都是「借一條連線、用完還回去」**。
> `MULTI` 是**連線層級的狀態**——它必須跟後面的命令走同一條連線。
>
> **這跟 01 章 1.5.6 的 `Cursor` 是同一類問題**：
> **有狀態的操作，必須綁在同一條連線上。**

### 5.7.2 正確寫法：`SessionCallback`

```java
List<Object> results = redis.execute(new SessionCallback<List<Object>>() {
    @Override
    @SuppressWarnings("unchecked")
    public List<Object> execute(RedisOperations operations) {
        operations.multi();
        operations.opsForValue().increment("n");
        operations.opsForValue().increment("n");
        operations.opsForValue().set("other", "x");
        return operations.exec();
    }
});
```

```
═══ 5.7.2 正確寫法：SessionCallback ═══
  exec() 回傳 = [1, 2, true]
  n = 2，other = x
```

**`SessionCallback` 保證裡面所有操作走同一條連線。** `WATCH` 也一樣需要它。

⚠️ **另一個選項是 `redisTemplate.setEnableTransactionSupport(true)`**，
它讓 `RedisTemplate` 把連線綁到 Spring 的交易（`@Transactional`）上。
**但它有一個很反直覺的副作用**，實測：

```java
@Test
@Transactional
void readsReturnNullWithTransactionSupport() {
    plain.opsForValue().set("k", "hello");

    StringRedisTemplate tx = new StringRedisTemplate(factory);
    tx.setEnableTransactionSupport(true);
    tx.afterPropertiesSet();

    System.out.println("  一般的 template  get(\"k\") = " + plain.opsForValue().get("k"));
    System.out.println("  開了交易支援的     get(\"k\") = " + tx.opsForValue().get("k"));
}
```

```
  一般的 template  get("k") = hello
  開了交易支援的     get("k") = null   ← 值明明在，卻讀不到
  交易中 set("k2") 之後，從外面讀 k2 = null（還沒提交）
```

**因為在 `@Transactional` 範圍內，所有命令（包含讀取）都被排進交易佇列，
要等到提交時才真的執行**——而 `get()` 當下只能回傳 `null`。

> ⚠️ **這是一個非常容易誤判的行為**：程式碼看起來正常、Redis 裡資料也在，
> **但讀出來是 `null`**，於是你的快取「永遠沒命中」、你的鎖「永遠拿不到」。
>
> **這一站不使用它**，需要交易就用 `SessionCallback`。

### 5.7.3 `WATCH` 的完整 CAS 迴圈

```java
@Test
void watchAsOptimisticLock() throws Exception {
    System.out.println("═══ 5.7.3 WATCH 做樂觀鎖：200 個人搶 100 件 ═══");
    probe.flushAll();
    redis.opsForValue().set("stock", "100");
    AtomicInteger sold = new AtomicInteger(), retried = new AtomicInteger(), gaveUp = new AtomicInteger();

    CountDownLatch start = new CountDownLatch(1);
    for (int i = 0; i < 200; i++) {
        new Thread(() -> {
            try { start.await(); } catch (InterruptedException ignored) {}
            for (int attempt = 0; attempt < 50; attempt++) {
                List<Object> r = redis.execute(new SessionCallback<List<Object>>() {
                    @Override
                    @SuppressWarnings("unchecked")
                    public List<Object> execute(RedisOperations ops) {
                        ops.watch("stock");                                    // ① 盯住它
                        String s = (String) ops.opsForValue().get("stock");    // ② 讀
                        int stock = Integer.parseInt(s);
                        if (stock <= 0) { ops.unwatch(); return List.of(); }   // ③ 放棄要 UNWATCH
                        ops.multi();                                           // ④ 開交易
                        ops.opsForValue().decrement("stock");
                        return ops.exec();                                     // ⑤ 被插隊就回 null/空
                    }
                });
                if (r == null || r.isEmpty()) { retried.incrementAndGet(); continue; }
                sold.incrementAndGet();
                return;
            }
            gaveUp.incrementAndGet();
        }).start();
    }
    start.countDown();
    Thread.sleep(6000);
    System.out.printf("  賣出 %d 件（庫存顯示 %s）%n", sold.get(), redis.opsForValue().get("stock"));
    System.out.printf("  重試次數 %d，放棄 %d 人%n", retried.get(), gaveUp.get());
}
```

```
═══ 5.7.3 WATCH 做樂觀鎖：200 個人搶 100 件 ═══
  賣出 100 件（庫存顯示 0）
  重試次數 5440，放棄 100 人
  → 正確，但 200 個人總共重試了 5440 次（Lua 版是 0 次）
```

📌 **「放棄 100 人」是正確的**——庫存只有 100 件，另外 100 個人本來就買不到。

⚠️ **但要看清楚他們是怎麼「放棄」的**：上面那段程式在第 ③ 步（`stock <= 0`）
回的是一個**空的 list**，而外層的 `if (r == null || r.isEmpty())` 把它當成「被插隊了」，
於是這 100 個人**各自空轉滿 50 次才放棄**——
5,440 次重試裡有 5,000 次是他們貢獻的。

📌 **這本身就是一個值得記住的 bug 形狀**：
「交易被插隊」與「條件不成立」都用「空的回傳值」表示，呼叫端就分不出來。
**正確的寫法要讓這兩件事有不同的回傳值**（Lua 版天生就分得開，5.6.3 的 `-1` / `-2`）。

### 5.7.4 Lua：`DefaultRedisScript`

```java
package com.example.lab10.ch05;

import com.example.lab10.RedisProbe;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

@SpringBootTest
class LuaAtomicTest {

    @Autowired StringRedisTemplate redis;
    @Autowired RedisProbe probe;

    /** 一條腳本：檢查庫存 → 夠就扣 → 回傳剩餘（不夠回 -1） */
    private static final RedisScript<Long> DEDUCT = new DefaultRedisScript<>("""
            local stock = tonumber(redis.call('GET', KEYS[1]))
            if stock == nil then return -2 end
            local want = tonumber(ARGV[1])
            if stock < want then return -1 end
            return redis.call('DECRBY', KEYS[1], want)
            """, Long.class);

    private void rush(Runnable buyer, int buyers) throws Exception {
        CountDownLatch start = new CountDownLatch(1), done = new CountDownLatch(buyers);
        for (int i = 0; i < buyers; i++) {
            new Thread(() -> {
                try { start.await(); buyer.run(); } catch (InterruptedException ignored) {}
                finally { done.countDown(); }
            }).start();
        }
        start.countDown();
        done.await();
    }

    @Test
    void luaIsAtomic() throws Exception {
        System.out.println("═══ 5.6.3 200 個人搶 100 件：Lua 版 ═══");
        probe.flushAll();

        redis.opsForValue().set("stock:B", "100");
        AtomicInteger soldB = new AtomicInteger(), rejectedB = new AtomicInteger();
        rush(() -> {
            Long left = redis.execute(DEDUCT, List.of("stock:B"), "1");
            if (left != null && left >= 0) soldB.incrementAndGet(); else rejectedB.incrementAndGet();
        }, 200);
        System.out.printf("Lua 腳本        : 賣出 %d 件，擋下 %d 件，庫存顯示 %s%n",
                soldB.get(), rejectedB.get(), redis.opsForValue().get("stock:B"));

        // 一次買多件：DECR 做不到的事
        redis.opsForValue().set("stock:C", "100");
        AtomicInteger soldC = new AtomicInteger(), unitsC = new AtomicInteger();
        rush(() -> {
            int want = 3;
            Long left = redis.execute(DEDUCT, List.of("stock:C"), String.valueOf(want));
            if (left != null && left >= 0) { soldC.incrementAndGet(); unitsC.addAndGet(want); }
        }, 200);
        System.out.printf("一次買 3 件      : %d 個人買到，共 %d 件，庫存顯示 %s%n",
                soldC.get(), unitsC.get(), redis.opsForValue().get("stock:C"));
    }
}
```

**四個要注意的地方**：

| | |
|---|---|
| **`DefaultRedisScript` 自動處理 `EVALSHA` / `NOSCRIPT`** | 它先算好 SHA，優先送 `EVALSHA`，收到 `NOSCRIPT` 就自動退回 `EVAL` 並重送（5.6.5 的問題 Spring 已解決） |
| **`RedisScript<Long>` 的泛型是回傳型別** | 只支援 `Long`、`Boolean`、`List`、以及自訂的 `RedisSerializer`。**回傳 `Long` 最常用也最不容易出錯** |
| **腳本建議放檔案** | `new DefaultRedisScript<>(new ClassPathResource("scripts/deduct.lua"), Long.class)`——好處是有語法高亮、可以單獨測試、不用處理 Java 字串跳脫 |
| **key 要放進 `List`，其餘放 varargs** | `redis.execute(SCRIPT, List.of("stock:B"), "1")`——**前者對應 `KEYS`，後者對應 `ARGV`**（5.6.2） |

⚠️ **`DefaultRedisScript` 應該做成 `static final` 或 Spring bean。**
每次 `new` 一個都要重新算 SHA，而且會讓腳本快取失去意義。

---

## 5.8 ⚠️ Lua 的代價：它卡住整台 Redis

### 5.8.1 實測：一段跑 7 秒的腳本

```bash
docker exec redis-lab redis-cli EVAL "local x=0 for i=1,2000000000 do x=x+i end return 1" 0 &
# 同時每 2 秒用另一個連線 GET 一次
```

```
  第 2 秒左右 GET k -> BUSY Redis is busy running a script. You can only call SCRIPT KILL or...  (2997 ms)
  第 4 秒左右 GET k -> BUSY Redis is busy running a script. You can only call SCRIPT KILL or...  (2 ms)
  第 6 秒左右 GET k -> BUSY Redis is busy running a script. You can only call SCRIPT KILL or...  (3 ms)
  第 8 秒左右 GET k -> v                                                                          (8 ms)
```

**看第一行跟第二行的差別**：

| 時間點 | 結果 | 等了多久 |
|---|---|---|
| 第 2 秒 | `BUSY` 錯誤 | **等了 2,997 ms** ← 它一直被阻塞，直到第 5 秒才被拒絕 |
| 第 4 秒 | `BUSY` 錯誤 | 2 ms ← 立刻被拒絕 |

**那個 5 秒的分界就是 `busy-reply-threshold`**：

```bash
docker exec redis-lab redis-cli CONFIG GET busy-reply-threshold
```

```
busy-reply-threshold: 5000          ← 毫秒
```

> 📌 **Redis 的設計是**：
> 腳本執行的前 5 秒，**其他客戶端完全被阻塞**（連錯誤都收不到）。
> 超過 5 秒之後，Redis 開始對其他客戶端回 `BUSY` 錯誤——
> **但腳本還在跑，你的資料還是讀不到。**
>
> **這時候只有兩條命令會被接受：`SCRIPT KILL` 與 `SHUTDOWN NOSAVE`。**

### 5.8.2 `SCRIPT KILL`：它救不了你最需要的那次

```
=== SCRIPT KILL：唯讀的腳本可以殺 ===
  （腳本那一側）ERR Script killed by user with SCRIPT KILL... script: 35fdb740...
  SCRIPT KILL -> OK（3 ms）
```

**但如果那段腳本已經寫過資料**：

```
=== ⚠️ 已經寫過資料的腳本，殺不掉 ===
  SCRIPT KILL -> UNKILLABLE Sorry the script already executed write commands against the
                 dataset. You can either wait the script termination or kill the server in
                 a hard way using the SHUTDOWN NOSAVE command.
```

> ⚠️ **這是這一章最重要的一個警告。**
>
> **為什麼殺不掉**：5.6.6 說過腳本不回滾。如果 Redis 在腳本寫了一半時把它殺掉，
> **資料就停在一個「執行到一半」的狀態**——而這個狀態會被複製到從庫、寫進 AOF。
> Redis 寧可讓你等，也不願意產生這種不一致。
>
> **所以你的選擇只有兩個**：
> ① 等它跑完（不知道要多久）
> ② **`SHUTDOWN NOSAVE`——整台 Redis 重啟，而且不存檔**
>
> **一段寫錯的 Lua 腳本，可以讓你的整個 Redis 叢集只剩下「重啟」這個選項。**

**`SLOWLOG` 留下了兩段腳本的下場**（同一個迴圈，差別只在有沒有先寫一筆資料）：

```
  14,446,438 µs  EVAL redis.call("INCR", KEYS[1]) local x=0 for i=1,3000000000 do ... 1 n
   6,002,184 µs  EVAL local x=0 for i=1,3000000000 do x=x+i end return 1 0
```

| 腳本 | 佔用主執行緒 | 為什麼 |
|---|---|---|
| 唯讀的那個 | **6.0 秒** | 在第 6 秒被 `SCRIPT KILL` 中斷 |
| **先寫了一筆的那個** | **14.4 秒** | ⚠️ **殺不掉，只能等它自己跑完** |

**14.4 秒之內，那台 Redis 對所有人都是不可用的。**

### 5.8.3 所以腳本要多短

| 腳本長度 | 後果 |
|---|---|
| **幾毫秒**（幾條命令、簡單判斷） | ✅ 正常使用 |
| 幾十毫秒 | ⚠️ 等於 03 章的慢命令，會拉高所有人的 p99 |
| **超過 5 秒** | ❌ 其他客戶端開始收到 `BUSY` |
| 寫過資料 + 跑很久 | ❌❌ **只能重啟整台** |

**三個具體的規則**：

| | |
|---|---|
| **不要在腳本裡寫大迴圈** | `for i=1,1000000` 是事故。要處理大量資料就分批，在應用層迴圈呼叫小腳本 |
| **不要在腳本裡用 `KEYS`、`HGETALL`、`SMEMBERS`** | 03 章 3.4.2 那些命令進了腳本，危害更大（連 `BUSY` 保護都要等 5 秒才啟動） |
| **上線前量一次**：`SLOWLOG` 裡那段 `EVALSHA` 是幾微秒 | 這是唯一可靠的驗收方式 |

---

## 5.9 四個工具，一張對照表

| | **pipeline** | **`MULTI`/`EXEC`** | **`WATCH`+`MULTI`** | **Lua** |
|---|---|---|---|---|
| 少幾次網路往返 | ✅ **這是它的目的** | ✅（順帶） | ❌（更多，要重試） | ✅ |
| 中間別人插不進來 | ❌ | ✅ | ✅ | ✅ |
| **能「讀了再決定」** | ❌ | ❌ | ✅（靠重試） | ✅ **直接可以** |
| 失敗會回滾 | ❌ | ❌ | ❌ | ❌ |
| 高競爭下的表現 | —— | —— | ❌ **5,440 次重試** | ✅ **0 次重試** |
| 邏輯寫在哪 | 應用層 | 應用層 | 應用層 | **Redis 裡（Lua）** |
| 主要風險 | 誤以為它是交易 | 誤以為它會回滾 | 重試風暴 | **腳本太慢會卡住整台** |

**決策樹**：

```
你要做的事，只是「少幾次往返」嗎？
├─ 是 → pipeline（或原生的 MGET / MSET / HMGET，03 章 3.8.2）
└─ 否，你需要「別人插不進來」
    └─ 中間需要「讀了再決定」嗎？
        ├─ 不需要（一組固定的操作） → MULTI / EXEC
        └─ 需要
            └─ 衝突頻繁嗎？
                ├─ 很少衝突（例如每個使用者改自己的資料） → WATCH + MULTI
                └─ 高度競爭（搶購、限流、鎖） → ★ Lua
```

> 📌 **這一站後面全部走 Lua 那一條路**，因為 09～12 章處理的都是「高度競爭」的場景。
> `WATCH` 會在 12 章再出現一次，當作對照組。

---

## 5.10 落地：shop-service 的三段腳本

這一章在專案裡加一個 `scripts/` 目錄。**三段腳本是後面九章的地基**：

```
src/main/resources/scripts/
├── deduct-stock.lua      ← 12 章：預扣庫存（本章 5.6.3）
├── release-lock.lua      ← 09 章：安全地釋放鎖
└── rate-limit.lua        ← 10 章：滑動窗限流
```

**`release-lock.lua`（09 章會完整解釋為什麼需要它）**：

```lua
-- KEYS[1] = 鎖的 key，ARGV[1] = 我當初寫進去的 token
-- 只有「這把鎖還是我的」時才刪掉它
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
```

⚠️ **這段腳本存在的理由就是本章的全部**：
`GET` 之後 `DEL` 之前，鎖可能已經過期、而且被別人搶走了——
**沒有 Lua 的話，你會刪掉別人的鎖。**

**載入的寫法**：

```java
@Configuration
public class RedisScriptConfig {

    @Bean
    public RedisScript<Long> deductStockScript() {
        return RedisScript.of(new ClassPathResource("scripts/deduct-stock.lua"), Long.class);
    }

    @Bean
    public RedisScript<Long> releaseLockScript() {
        return RedisScript.of(new ClassPathResource("scripts/release-lock.lua"), Long.class);
    }
}
```

**三條規約**（接續 02 章 2.12 的六條）：

7. **所有「讀了再決定」的邏輯，一律寫成 Lua 腳本放在 `scripts/` 下**——
   不要散落在 Java 程式碼裡用 `if` 拼。
8. **每段腳本上線前，用 `SLOWLOG` 量一次執行時間**，超過 1 毫秒就要有理由（5.8.3）。
9. **腳本必須是冪等的**（5.6.7 第 6 條）——客戶端逾時重送時不能重複扣款。

---

## 5.11 常見誤區

**① 「pipeline 就是交易」**

03 章 3.8.3 實測：兩個 pipeline 交錯成 `ABBBAA`。**它只是打包。**

**② 「`MULTI` 是交易，所以會回滾」**

5.4.2 實測：三條命令第二條失敗，**第一、三條照樣生效**，`INCR` 執行了兩次。

**③ 「拋了例外表示沒生效」**

5.4.3、03 章 3.8.3——**Redis 上這兩件事完全無關**。
你的重試邏輯會因為這個假設而重複執行。

**④ 「用 `MULTI` 可以解決超賣」**

`MULTI` 裡拿不到中間結果（5.4.4）。**只要邏輯裡有 `if`，`MULTI` 就不夠用。**

**⑤ 「`WATCH` 是鎖」**

它是**樂觀**鎖——不擋人，只在提交時檢查。高競爭下是重試風暴（5.5.3：5,440 次）。

**⑥ 「Lua 是原子的，所以它像資料庫交易一樣安全」**

**Lua 也不回滾**（5.6.6）。原子 = 別人插不進來，不等於「出錯會復原」。

**⑦ 「腳本裡把 key 寫死比較方便」**

Cluster 會找不到它要送去哪個節點（5.6.2）。**單機能跑，上 Cluster 就爆。**

**⑧ 「腳本跑久一點沒關係，反正是背景」**

它跑在主執行緒上。超過 5 秒其他人開始收到 `BUSY`（5.8.1）。

**⑨ 「腳本卡住了就 `SCRIPT KILL`」**

**已經寫過資料的腳本殺不掉**，只能 `SHUTDOWN NOSAVE`（5.8.2）。

**⑩ 「直接用 `redisTemplate.multi()`」**

`ERR EXEC without MULTI`，而且那些命令**直接執行了**（5.7.1）。要用 `SessionCallback`。

**⑪ 「`setEnableTransactionSupport(true)` 比較方便」**

開了之後 `get()` 回 `null`（5.7.2）——**你的快取會變成永遠不命中**。

**⑫ 「Lua 回傳 1.5 會拿到 1.5」**

拿到 `(integer) 1`（5.6.4）。**要小數就回字串。**

---

## 5.12 本章小結，以及第一部分的總結

### 5.12.1 這一章

> **Redis 只提供一種原子性：「這組操作執行時，別人插不進來」。**
> **它不提供回滾。四個工具裡沒有任何一個提供回滾。**

而封住「讀改寫」那道縫的方法，按適用場景排：

| 場景 | 用什麼 |
|---|---|
| 單一計數、單一扣減 | **一條原生命令**（`INCR`、`DECRBY`、`HINCRBY`、`ZADD GT`、`SET NX`） |
| 一組固定的操作 | `MULTI` / `EXEC` |
| 低競爭的讀改寫 | `WATCH` + `MULTI` |
| **高競爭、需要判斷** | **Lua** |

### 5.12.2 第一部分（00～05）到這裡結束

六章講完了「Redis 那一側發生什麼事」：

| 章 | 一句話 |
|---|---|
| 00 | Redis 不快（比行程內快取慢 5,619 倍），它的價值是**共享** |
| 01 | key 過期不是計時器；`SET` 會洗掉 TTL；`SCAN` 會重複 |
| 02 | 選對結構，很多問題根本不會發生 |
| 03 | **一個執行緒執行所有命令**——所以「慢」是所有人的問題 |
| 04 | 記憶體滿了與重啟，是兩種「資料默默消失」的方式 |
| 05 | **原子 = 別人插不進來，不等於會回滾** |

> 📌 **這六章有一條共同的線**：
> **Java 這一側看到的是一個方法呼叫，Redis 那一側看到的是完全不同的東西。**
> 00 章的四個事故、01 章的 TTL、02 章的 `entries()`、03 章的排隊、
> 04 章的淘汰、05 章的原子性——**全部都是這個落差。**
>
> **第二部分（06～14）把這個落差搬到 Spring 專案裡，一個一個處理掉。**

### 5.12.3 驗收清單

- [ ] 說出 Redis 的「原子」跟資料庫交易的「原子」差在哪。
- [ ] 說出 `MULTI` 的兩種錯誤與它們完全不同的結局。
- [ ] 解釋為什麼「拋了例外」不代表「沒生效」（`MULTI`、pipeline、Lua 三者都適用）。
- [ ] 說出 `MULTI` 為什麼解決不了超賣。
- [ ] 寫出一個正確的 `WATCH` CAS 迴圈，包含三個容易寫錯的地方。
- [ ] 說出為什麼 Lua 的 key 一定要走 `KEYS`。
- [ ] 說出 Lua 回傳 `1.5`、`false`、`{1,nil,3}` 分別會變成什麼。
- [ ] 說出 `busy-reply-threshold` 是什麼，以及 `SCRIPT KILL` 什麼時候會失敗。
- [ ] 說出 Spring 這一側為什麼不能直接呼叫 `multi()`。

### 5.12.4 本章練習

**練習一（15 分鐘）**：把 02 章 2.4.4 那個「掉了 198 次更新」的 JSON 版，
改成用 Lua 腳本做讀改寫（`cjson.decode` → 改 → `cjson.encode` → `SET`）。
**200 個執行緒跑一次，應該一次都不掉。**
接著量它的執行時間（`SLOWLOG`）——**跟 `HINCRBY` 比，慢多少？**
這就是「用 Lua 硬撐錯誤的資料結構」的成本。

**練習二（20 分鐘）**：實作 5.10 的 `release-lock.lua`，
然後**寫一個測試證明「不用 Lua 就會刪到別人的鎖」**：
① A 拿到鎖（TTL 1 秒）→ ② A 的業務跑了 2 秒 → ③ 鎖過期，B 拿到 →
④ A 回來執行 `DEL`。**沒有 Lua 的版本會刪掉 B 的鎖。**（09 章的主線。）

**練習三（15 分鐘）**：寫一段**故意很慢**的 Lua（`for i=1,3000000000 do end`），
在它執行時開另一個終端機觀察：`GET` 何時開始收到 `BUSY`、`SCRIPT KILL` 能不能殺掉。
接著在腳本開頭加一行 `redis.call('SET', KEYS[1], '1')` **再試一次殺**——
**你應該會看到 `UNKILLABLE`。** 記住那個訊息的樣子。

**練習四（進階，30 分鐘）**：用 `WATCH` 與 Lua 各寫一版「轉帳」
（從 A 帳戶扣、加到 B 帳戶，餘額不足就整筆不做），
然後用 50 個執行緒在 10 個帳戶之間隨機轉帳 1000 次。
**驗證：總餘額不變、沒有任何帳戶是負的。**
記錄兩版的：總耗時、重試次數、`SLOWLOG` 裡的單次執行時間。
⚠️ Lua 版要注意 5.6.2 —— **兩個帳戶都要放進 `KEYS`**。

---

## 5.13 下一章預告

第二部分開始。06 章把前六章的所有東西**接到一個真的 Spring Boot 專案上**，
而它要處理的第一件事，是 00 章 0.3.3 那個 `\xac\xed\x00\x05`。

- **四個序列化器分別在哪裡**（key、value、hash key、hash value），
  以及為什麼 `StringRedisTemplate` 跟 `RedisTemplate` 的預設完全不同。
- JDK 序列化的三個坑、Jackson 的型別資訊問題（`@class` 欄位）、
  以及**快取資料怎麼跨版本存活**。
- **Lettuce 的連線模型**：01 章 1.5.6 留下的 `shareNativeConnection` 到底在共用什麼，
  什麼時候必須關掉它。
- **三層逾時**：03 章 3.7.3 只設了一層（`timeout: 500ms`），
  另外兩層是什麼、各該設多少。
- 以及一個實驗：**把 Redis 的容器直接停掉**，看你的應用要花多久才發現。
