# 第 05 章：交易邊界與批次操作

> 04 章全部在**讀**。這一章回到**寫**，而問題換一個形狀。
>
> **先看兩段幾乎一樣的程式碼**：
>
> ```java
> // ① 一個交易包住兩個寫入
> tx.executeWithoutResult(s -> {
>     repo.save(orderA);
>     repo.save(orderB);
>     throw new IllegalStateException("第三步失敗了");
> });
>
> // ② 兩個各自的交易
> tx.executeWithoutResult(s -> repo.save(orderA));
> tx.executeWithoutResult(s -> repo.save(orderB));
> throw new IllegalStateException("第三步失敗了");
> ```
>
> ```
> === T1-A ✅ 一個交易包住兩個寫入：失敗時兩個都不見 ===
>   orders 表裡有幾張 O-A%：0 張 → ✅ 兩個都回滾了
>
> === T1-B 🔴 兩個【各自】的交易：失敗時第一個留下來了 ===
>   orders 表裡有幾張 O-B%：2 張 → 🔴 兩個都留下來了 —— 沒有任何辦法回滾
> ```
>
> **兩段程式碼長得幾乎一樣，只差交易的括號畫在哪裡。**
>
> ---
>
> **再看一個數字**。同樣的 20 筆 `INSERT`，只改主鍵的產生策略：
>
> ```
> === T5-C JDBC 層的 round trip（20 筆） ===
>   自己給 id + Persistable，batch_size = 20  → addBatch=20, executeBatch=1  → round trip ≈  1
>   ★ IDENTITY 主鍵，          batch_size = 20  → addBatch= 0, executeUpdate=20 → round trip ≈ 20
> ```
>
> 🔴 **`hibernate.jdbc.batch_size=20` 設了，`@GeneratedValue(strategy = IDENTITY)` 讓它【完全沒有效果】。**
> **不是效果變差，是 `addBatch` 一次都沒有被呼叫。**
> **而 Hibernate 不會警告你。**
>
> ---
>
> **這一章要回答七個問題**：
>
> | # | 問題 | 哪一節 |
> |---|---|---|
> | 1 | 交易邊界為什麼在 Service 而不是 Repository | 5.2 |
> | 2 | `readOnly = true` 到底做了什麼（它不只是一個提示） | 5.3 |
> | 3 | flush 什麼時候發生 —— 「我還沒 `save()` 為什麼查得到」 | 5.4 |
> | 4 | ★ 例外一拋出來，交易就一定會 rollback 嗎 | **5.5** |
> | 5 | ★★ **`saveAll()` 為什麼不是批次，以及主鍵策略怎麼決定答案** | **5.7、5.8** |
> | 6 | ★ 批次寫入的記憶體：為什麼一定要 `flush()` **加** `clear()` | **5.9** |
> | 7 | ★★ **20 萬筆的串流讀取：`Stream` 真的是串流嗎** | **5.11** |
>
> 📌 **第 4 題的答案是「不一定」**，而預設行為和大部分人的直覺相反：
> **`checked Exception` 拋出來，Spring 會【提交】**（5.5.1 實測）。
>
> 📌 **第 7 題的答案是「不是」**：
> `Stream<T>` 讀 20 萬筆，**持久化情境裡累積了 200,000 個受管實體** ——
> 和 `findAll()` 一模一樣（5.11.2 實測）。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 用一個實測說明「交易邊界畫在哪裡」如何決定失敗時的資料狀態，
  並解釋 `Propagation.MANDATORY` 在這件事上扮演什麼角色。
- 說出 `readOnly = true` **實際改變的三件事**，以及**它沒有改變的那一件**
  （提示：它擋不住 `save()`）。
- 列出 flush 的**四個觸發點**，並說明為什麼「刪一列再插入同一個唯一鍵」在 JPA 裡不安全。
- 說出 Spring 的**預設回滾規則**，以及 `UnexpectedRollbackException` 出現的**確切條件**。
- 讓 `saveAll()` 真的變成批次，並說出**四個會讓批次靜默失效的原因**
  （其中一個是主鍵策略）。
- 為 1 萬筆的批次寫入選出 `batch_size`，並解釋為什麼 `flush()` 不夠、還要 `clear()`。
- 為 20 萬筆的讀取選出做法，並用「持久化情境裡有幾個受管實體」而不是「感覺」來論證。
- 判斷一個交易該多大，並說出長交易的**四個代價**。

---

## 5.2 交易邊界為什麼在 Service

00 章 0.9 立了一條規則：**Repository 不開交易，只參加交易。**
這一節把它證明完整。

### 5.2.1 兩段幾乎一樣的程式碼

引言那兩段的完整實測：

```java
static Order anOrder(String id) {
    return Order.place(id, "C-1",
            List.of(new OrderLine("P-1", 1, Money.twd(100)),
                    new OrderLine("P-2", 2, Money.twd(140))),
            Money.twd(380), Seed.T0);
}
```

```
=== T1-A ✅ 一個交易包住兩個寫入：失敗時兩個都不見 ===
  拋出：第三步失敗了
  orders 表裡有幾張 O-A%：0 張 → ✅ 兩個都回滾了

=== T1-B 🔴 兩個【各自】的交易：失敗時第一個留下來了 ===
  拋出：第三步失敗了
  orders 表裡有幾張 O-B%：2 張 → 🔴 兩個都留下來了 —— 沒有任何辦法回滾
  ★ 兩段程式碼【長得幾乎一樣】，只差交易的括號畫在哪裡
```

**T1-B 的問題不是「回滾失敗了」，是「已經沒有東西可以回滾」**：
那兩個交易**已經提交**了。資料庫層面它們是兩件已經完成的事實。

要修只能寫**補償邏輯**（把 A 與 B 刪掉），而補償邏輯本身也可能失敗，
於是你需要補償的補償 —— 這條路沒有底。

### 5.2.2 如果 Repository 自己加 `@Transactional`

```java
// 🔴 錯的
@Repository
@Transactional                            // ← 預設是 REQUIRED，看起來很無害
public class JdbcOrderRepository implements OrderRepository { … }
```

`REQUIRED` 的語意是「有交易就參加，沒有就開一個」。
所以它**不會**在有交易時多開一個 —— 那為什麼還是錯的？

**因為它讓「沒有交易」變成一個合法狀態。**

```java
// Service 忘了加 @Transactional（或者加了但因為自我呼叫而失效 —— 05-service 02 章 2.7）
public void payOrder(String orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();  // 交易 1
    order.markPaid();
    orderRepository.save(order);                                    // 交易 2
    stockPort.decrease(order);                                      // 交易 3
}
```

**這段程式碼會跑、會通過測試、而且是 T1-B。**
`@Transactional(REQUIRED)` 在 Repository 上**把一個嚴重的設計錯誤變成了「看起來正常」**。

### 5.2.3 `MANDATORY` 讓它變成一個啟動不了的錯誤

```java
@Repository
@Transactional(propagation = Propagation.MANDATORY)     // ★
public class JdbcOrderRepository implements OrderRepository { … }
```

**實測**：

```
=== T1-C 沒有交易就呼叫 Repository ===
  ✅ IllegalTransactionStateException
    No existing transaction found for transaction marked with propagation 'mandatory'

=== T1-D 唯讀方法也一樣被守著 ===
  ✅ IllegalTransactionStateException: No existing transaction found for
     transaction marked with propagation 'mandatory'

=== T1-E 但 nextId() 不需要交易（03 章 3.10.4 修過） ===
  nextId() = O-8a6203acbe2740f6bb7f ✅ 沒有交易也能呼叫
```

**三件事**：

1. **寫入方法沒有交易 → 立刻爆**，而且訊息說得清楚（`propagation 'mandatory'`）。
2. **讀取方法也一樣被守著** —— 這是刻意的：
   一個 use case 裡的兩次讀取，應該看到**同一個**資料庫快照。
3. **`nextId()` 例外** —— 它不碰資料庫。
   03 章 3.10.4 把它標成 `SUPPORTS`，因為 class 上的 `MANDATORY`
   會逼呼叫端「為了產生一個 id 而開一個交易」。

```java
/**
 * ★ 這個方法【不碰資料庫】，所以不需要交易。
 *
 * <p>class 上的 MANDATORY 會套到每一個 public 方法 —— 包含這一個。
 * 而那會逼呼叫端「為了產生一個 id 而開一個交易」，
 * 與「id 在 INSERT 之前就存在，聚合可以在交易外被完整建立」這個設計直接牴觸。
 */
@Override
@Transactional(propagation = Propagation.SUPPORTS)
public String nextId() {
    return "O-" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
}
```

⚠️ **`MANDATORY` 的代價要說清楚**：

| 代價 | 說明 | 怎麼處理 |
|---|---|---|
| 測試變麻煩 | 每一個 Repository 測試都要自己開交易 | 測試基底類別提供 `tx()` / `inTx()`（本章 lab 就是這樣做的） |
| 「純查詢」的小工具也要交易 | 一支只想 `count()` 的排程也要包 `@Transactional` | ✅ **這是對的** —— 那支排程也應該有明確的邊界 |
| 不碰資料庫的方法要單獨標 | `nextId()`、純轉換的 helper | 用 `SUPPORTS`，並在註解裡寫清楚理由 |

### 5.2.4 那邊界該畫在哪

**畫在「一個 use case」的邊界上**，也就是 Service 的公開方法：

```java
@Service
public class PayOrderService {

    @Transactional                                    // ★ 邊界在這裡，只有這裡
    public void payOrder(String orderId, long version) {
        Order order = orderRepository.findById(orderId).orElseThrow(OrderNotFound::new);
        order.markPaid();
        orderRepository.save(order);
        stockPort.decrease(order);
    }
}
```

**判準（三條）**：

| 判準 | 說明 |
|---|---|
| **一個 use case 一個交易** | 「使用者按了一次按鈕」對應「資料庫看到一個原子的變化」 |
| **交易裡只放資料庫的事** | 外部 API、寄信、發訊息**都不要**放進去（5.12.1 有實測） |
| **交易邊界不可以在 Controller** | Controller 會做序列化、驗證、格式轉換 —— 那些不該佔著連線 |

⚠️ **最後一條的反面也成立**：不要用 Open Session In View 把交易拉長到 view 渲染
（5.6 會處理它）。

---

## 5.3 `readOnly = true` 到底做了什麼

04 章 4.11.3 的 `SpecOrderSearchAdapter` 上有這個註解：

```java
@Transactional(propagation = Propagation.MANDATORY, readOnly = true)
```

`readOnly` 常被當成「一個給資料庫的提示」。**它做的事比那個多，也比那個少。**

### 5.3.1 它改變的第一件事：`FlushMode`

```
=== T2-A ① FlushMode：讀寫交易 vs 唯讀交易 ===
  讀寫交易：FlushMode = AUTO
  唯讀交易：FlushMode = COMMIT ★
```

`AUTO` 的意思是「**查詢前也會 flush**」（5.4.2 會看到它的效果）。
`COMMIT` 的意思是「**只在提交前 flush**」。

而唯讀交易**不會提交任何變更**，所以 `COMMIT` 實際上等於「永遠不 flush」。

### 5.3.2 它改變的第二件事：dirty checking 不再寫回

03 章 3.9.2 有一個嚇人的實測：**改了 entity 但不呼叫 `save()`，變更還是被寫回去了。**

那個實測是在**讀寫**交易裡做的。換成唯讀交易：

```java
// 讀寫交易
write.executeWithoutResult(s -> {
    OrderEntity e = repo.findById("O-0001").orElseThrow();
    e.setStatus(OrderStatus.CANCELLED);          // 只改記憶體，沒有 save()
});

// 唯讀交易（同一段程式碼）
read.executeWithoutResult(s -> {
    OrderEntity e = repo.findById("O-0002").orElseThrow();
    e.setStatus(OrderStatus.CANCELLED);
});
```

```
=== T2-C ★★ ③ dirty checking：改了不 save，會不會被寫回 ===
  讀寫交易：發了 1 句 UPDATE，資料庫現在是 CANCELLED 🔴 被寫回了
  唯讀交易：發了 0 句 UPDATE，資料庫現在是 SHIPPED ✅ 沒有被寫回
```

📌 **這是 `readOnly = true` 最實際的價值**：
**它讓「查詢用的方法」不可能意外寫入。**

⚠️ 而它也是一個很好的**理由**去問「為什麼這段查詢程式碼會改 entity」——
如果加上 `readOnly = true` 之後功能壞了，那說明**那段「查詢」其實有在寫東西**。

### 5.3.3 它【沒有】改變的那一件：它擋不住 `save()`

```java
read.executeWithoutResult(s -> {
    OrderEntity e = repo.findById("O-0003").orElseThrow();
    e.setStatus(OrderStatus.CANCELLED);
    repo.save(e);
    repo.flush();                              // 強迫它送出去
});
```

```
=== T2-D 在唯讀交易裡明確呼叫 save() 會怎樣 ===
  沒有拋例外；資料庫現在是 CANCELLED 🔴 寫進去了
  ★ readOnly 不是一道【禁止寫入】的牆，是一組【預設不寫】的設定
```

🔴 **沒有例外、沒有警告，資料被改了。**

📌 **所以 `readOnly = true` 的正確理解是**：

> **它把「不寫」變成預設，但它不是權限控制。**
> 一個明確呼叫 `save()` + `flush()` 的程式碼**照樣寫得進去**。

### 5.3.4 那個「JDBC 連線也會變唯讀」的說法

很多文章說 `readOnly = true` 會把 JDBC 連線設成唯讀。**實測**：

```
=== T2-B ② JDBC 連線的 readOnly 旗標 ===
  讀寫交易：connection.isReadOnly() = false
  唯讀交易：connection.isReadOnly() = false ★
```

🔴 **兩個都是 `false`。**

**因為那是 `DataSourceTransactionManager` 的功能，不是 `JpaTransactionManager` 的。**
而且要**額外開啟**：

```java
DataSourceTransactionManager tm = new DataSourceTransactionManager(ds);
tm.setEnforceReadOnly(true);          // ★ 預設是 false
```

**開了之後**：

```
=== T2-B2 換成 DataSourceTransactionManager + setEnforceReadOnly(true) ===
  🔴 交易【開不起來】：CannotCreateTransactionException
     根因：JdbcSQLSyntaxErrorException
     Syntax error in SQL statement "SET TRANSACTION [*]READ ONLY";
     expected "ISOLATION"; SQL statement: SET TRANSACTION READ ONLY [42001-224]
  ★ setEnforceReadOnly(true) 會送出 `SET TRANSACTION READ ONLY`
    MySQL 8 與 PostgreSQL 支援它，【H2 2.2.224 不支援】
    → 這個設定在 H2 上測不出來，而在正式環境上是有效的
```

⚠️ **這是一個「H2 會騙你」的反向例子**：
不是「H2 通過了正式環境會失敗的東西」，是
**「H2 讓一個在正式環境有效的設定完全無法測試」**。

📌 **`enforceReadOnly` 值得開嗎**？

| 好處 | 代價 |
|---|---|
| 資料庫層面真的拒絕寫入（連 5.3.3 那個 `save()` 也擋得住） | 每一個唯讀交易多送一句 `SET TRANSACTION READ ONLY`（一次 round trip） |
| 讀寫分離架構下，讓「唯讀交易誤連到主庫寫入」直接失敗 | **H2 上完全無法測試** —— 本機與 CI 都跑不起來 |

**建議**：在**讀寫分離**的系統上值得開（那裡的風險最大），
並用 profile 讓 H2 環境關掉它。單一資料庫的系統，`readOnly = true` 已經夠。

### 5.3.5 隔離級別是另一件事

```
=== T2-E 隔離級別與 readOnly 是兩件事 ===
  TransactionDefinition.ISOLATION_DEFAULT = -1
  唯讀交易的隔離級別 = 2（H2 預設 READ_COMMITTED=2）
```

`readOnly` **不改變**隔離級別。
「唯讀交易裡兩次查詢會不會看到同一份資料」由**隔離級別**決定，不是 `readOnly`。

⚠️ 在 `READ_COMMITTED` 下，**同一個唯讀交易裡的兩次查詢可以看到不同的資料**
（別人在中間提交了）。要保證一致就要 `REPEATABLE_READ`
（MySQL InnoDB 的預設就是它 —— 07-mysql 站 04 章會處理）。

### 5.3.6 三件事的總結表

| `readOnly = true` | 有沒有做 | 證據 |
|---|---|---|
| `FlushMode` → `COMMIT` | ✅ **有** | T2-A |
| dirty checking 不寫回 | ✅ **有**（0 句 `UPDATE`） | T2-C |
| Hibernate 的 entity 標記為唯讀（省掉快照） | ✅ 有（間接效果：記憶體與 CPU） | 本章沒有直接量測 🔴 |
| JDBC 連線 `setReadOnly(true)` | 🔴 **沒有**（要 `DataSourceTransactionManager` + `enforceReadOnly`） | T2-B |
| 擋住明確的 `save()` | 🔴 **沒有** | T2-D |
| 改變隔離級別 | 🔴 **沒有** | T2-E |
| 把查詢導向唯讀副本 | 🔴 **沒有** —— 那要自己寫 `AbstractRoutingDataSource`（01 章 1.11 的分池） | —— |

---

## 5.4 flush 什麼時候發生

### 5.4.1 `save()` 之後，SQL 還沒送出去

```java
tx.executeWithoutResult(s -> {
    OrderEntity e = new OrderEntity("O-NEW1", "C-9", OrderStatus.PENDING_PAYMENT,
            999, "TWD", Seed.T0);
    e.replaceLines(List.of(new OrderLineEntity(1, "P-9", 1, 999, "TWD")));
    repo.save(e);
    Lab.line("save() 回來了，此刻已送出 %d 句 SQL", SqlSpy.capturedNow().size());
});
```

```
=== T3-A save() 之後，SQL 送出去了嗎 ===
  save() 回來了，此刻已送出 2 句 SQL
    [select … from orders oe1_0 left join order_line l1_0 … where oe1_0.id=? …,
     select ole1_0.line_no,… from order_line ole1_0 where (ole1_0.line_no,ole1_0.order_id) in ((?,?))]
  交易結束後總共 → 4 句 SQL
      [1] select … from orders oe1_0 left join order_line …
      [2] select ole1_0.line_no,… from order_line ole1_0 where (…) in ((?,?))
      [3] insert into orders (created_at,currency,customer_id,status,total_minor,version,id) values (?,?,?,?,?,?,?)
      [4] insert into order_line (currency,product_id,quantity,unit_price_minor,line_no,order_id) values (?,?,?,?,?,?)
  ★ INSERT 是在【交易提交前的 flush】才送出去的
```

**`save()` 回來的時候，兩句 `INSERT` 一句都還沒送出去。**
送出的那兩句是 `SELECT`（03 章 3.9.1 那個 `isNew()` 造成的白跑查詢）。

📌 **這是 JPA 最重要的一個心智模型**：

> **`save()` 不是「寫入資料庫」，是「把這個物件登記到持久化情境裡」。**
> 真正的 `INSERT` / `UPDATE` 發生在 **flush** 的時候。

⚠️ **它的直接後果**：`save()` **不會**拋出約束違反的例外 ——
那個例外會在**交易提交時**才出現，
而那時候你的 try-catch 已經離開了（05-service 06 章的例外分層要處理這件事）。

### 5.4.2 ★ 一個 JPQL 查詢會強迫先 flush

```java
tx.executeWithoutResult(s -> {
    OrderEntity e = repo.findById("O-0001").orElseThrow();
    e.setStatus(OrderStatus.CANCELLED);        // 只改記憶體
    Lab.line("改完之後，送出了 %d 句（沒有 UPDATE）", SqlSpy.capturedNow().size());

    long n = repo.countByCustomerId("C-2");    // ← 一個 JPQL 查詢
    Lab.line("跑了一個 count 查詢之後，送出了 %d 句", SqlSpy.capturedNow().size());
});
```

```
=== T3-B ★ 一個 JPQL 查詢會【強迫先 flush】 ===
  改完之後，送出了 1 句（沒有 UPDATE）
  跑了一個 count 查詢之後，送出了 3 句
    [select … from orders oe1_0 …,
     update orders set created_at=?,currency=?,customer_id=?,status=?,total_minor=?,version=? w…,
     select count(oe1_0.id) from orders oe1_0 where oe1_0.customer_id=?]
  ★ Hibernate 怕那個查詢讀到過期的資料，所以先把待寫的變更 flush 出去
```

**`UPDATE` 被插在 `count` 前面送出去了。**

**理由是對的**：那個 `count` 要在資料庫上執行，
而資料庫還不知道 `O-0001` 已經變成 `CANCELLED` —— 如果不先 flush，`count` 可能算錯。

⚠️ **但它有一個很不直覺的後果**：

```java
// 「這一段只是在查東西」—— 而它送出了一句 UPDATE
Order order = repo.findById(id).orElseThrow();
order.applySomeDefault();               // 一個看起來無害的欄位預設值
long count = repo.countByCustomerId(order.customerId());   // ← 這裡 UPDATE 了
```

📌 **這解釋了一類很難查的現象**：
「我在日誌裡看到一句 `UPDATE`，但那個時間點的程式碼裡沒有任何 `save()`。」

### 5.4.3 `findById()` 不會觸發 flush

```
=== T3-C findById() 【不會】觸發 flush ===
  findById 之後：1 → 2 句（沒有變 → 沒有 flush）
  ★ findById 走的是「按主鍵取」，Hibernate 知道它不受待寫變更影響
```

**因為按主鍵取有兩種可能**：
物件已經在持久化情境裡（**直接回傳，連 SQL 都不發** —— 03 章 3.9.2 的一級快取），
或者不在（發一句 `SELECT ... WHERE id = ?`，而那一句的結果不受待寫變更影響）。

**flush 的四個觸發點**：

| # | 觸發點 | 會 flush 嗎 |
|---|---|---|
| 1 | 交易**提交前** | ✅ 一定會（除非 `FlushMode.MANUAL`） |
| 2 | 執行一個 **JPQL / Criteria / 原生查詢** | ✅ 會（`FlushMode.AUTO`） |
| 3 | `findById()` / `em.find()` | 🔴 **不會** |
| 4 | 明確呼叫 `em.flush()` / `repo.flush()` / `saveAndFlush()` | ✅ 會 |

⚠️ **第 2 點對原生查詢有一個坑**：
Hibernate 只能保守地「全部 flush」——它看不懂你的原生 SQL 碰哪張表。
所以**一句無關的原生查詢也會把所有待寫變更 flush 出去**。

### 5.4.4 ★★ flush 的順序是寫死的，而且不是你寫的順序

**這一節是本章最容易在正式環境咬人的一段。**

先看一個「看起來一定會成功」的操作：**把一張訂單的明細整組換掉**。

```java
tx.executeWithoutResult(s -> {
    OrderEntity e = repo.findById("O-0001").orElseThrow();
    // 先刪一筆明細（clear），再加一筆【同樣 line_no】的明細
    e.replaceLines(List.of(new OrderLineEntity(1, "P-CHANGED", 5, 111, "TWD")));
});
```

`replaceLines` 的實作（03 章寫的）：

```java
public void replaceLines(List<OrderLineEntity> newLines) {
    lines.clear();                       // orphanRemoval = true → 舊的會被 DELETE
    for (OrderLineEntity l : newLines) { l.setOrder(this); lines.add(l); }
}
```

**實測**：

```
=== T3-D ★★ 換掉整組明細：有沒有呼叫 save() 差很多 ===
  ① 只改集合，【不】呼叫 save()：
     🔴 DuplicateKeyException
     A different object with the same identifier value was already associated with
     the session : [example.shop.order.infrastructure.jpa.OrderLineEntity#…$Key@a29154e3]
     ★ clear() 之後 new 一個【同樣主鍵】的物件 → 情境裡出現兩個同 id 的實例
```

🔴 **它爆了**，而訊息完全沒有提到「明細」或「line_no」：

```
A different object with the same identifier value was already associated with the session
```

**病因**：`lines.clear()` 把舊的 `OrderLineEntity(line_no=1)` 標記為要刪除，
**但它還在持久化情境裡**（要等 flush 才真的刪）。
然後你 `new OrderLineEntity(1, ...)` —— 一個**主鍵完全相同**的新物件。
Hibernate 的持久化情境不允許「同一個主鍵有兩個實例」。

**加上 `save()` 就好了**：

```java
tx.executeWithoutResult(s -> {
    OrderEntity e = repo.findById("O-0002").orElseThrow();
    e.replaceLines(List.of(new OrderLineEntity(1, "P-CHANGED", 5, 111, "TWD")));
    repo.save(e);                     // ★ SimpleJpaRepository.save → em.merge()
});
```

```
  ② 同一段程式碼，最後加上 repo.save(e)：
     ✅ 成功。實際送出的順序：
       [1] select … from orders oe1_0 …
       [2] select l1_0.order_id,l1_0.line_no,… from order_line l1_0 …
       [3] update order_line set currency=?,product_id=?,quantity=?,unit_price_minor=?
           where line_no=? and orde…
       [4] delete from order_line where line_no=? and order_id=?
     ★ merge() 把新物件的狀態【蓋到已受管的那個實例上】，所以沒有衝突
```

📌 **兩件事同時被證明了**：

1. **`merge()` 解決了主鍵衝突** —— 它不是「多插入一個物件」，是「把狀態蓋上去」。
2. **實際 SQL 是 1 句 `UPDATE` + 1 句 `DELETE`**，不是「2 句 `DELETE` + 1 句 `INSERT`」。
   這就是 03 章 3.7 那個「按主鍵 diff」的機制 —— 程式碼寫 `clear()` 並不代表真的 `DELETE`。

**而順序是寫死的**：

```
★ Hibernate 的 flush 順序是寫死的（AbstractFlushingEventListener）：
  ① 實體 INSERT → ② 實體 UPDATE → ③ 集合的 DELETE
  → ④ 集合的 UPDATE/INSERT → ⑤ 實體 DELETE
  ⚠️ 所以「刪掉一列、再插入一列相同唯一鍵」在 JPA 裡【不保證安全】
```

⚠️ **這個順序造成一個真實的坑**：

```java
// 目標：把使用者的「預設收貨地址」從 A 換成 B
//       表上有一個唯一索引 UNIQUE (user_id, is_default)
addressRepo.delete(oldDefault);        // 想先刪掉舊的
addressRepo.save(newDefault);          // 再插入新的
```

**flush 順序是「INSERT 在 DELETE 之前」** →
`INSERT` 先送出去 → 撞到唯一索引 → **`DataIntegrityViolationException`**。

**三個修法**：

| 修法 | 寫法 | 適用 |
|---|---|---|
| **明確 flush** | `delete(old); em.flush(); save(new);` | 最直接，但多一次 round trip |
| **改成 `UPDATE`** | 把舊的 `is_default` 設成 `false`，再把新的設成 `true` | ✅ 通常最好 —— 本來就不該刪 |
| **延後約束** | `DEFERRABLE INITIALLY DEFERRED`（PostgreSQL 有，**MySQL 沒有**） | 可攜性差 |

📌 **判準**：
**如果一段程式碼的正確性依賴「我寫的順序」，而它跑在 JPA 上，那它是壞的。**
JPA 的順序由 Hibernate 決定，不由你決定。

### 5.4.5 `FlushMode` 的四個值

```
=== T3-E FlushMode 的三種值 ===
  預設（讀寫交易）      ：AUTO
  Hibernate 的 FlushMode ：AUTO
    MANUAL   → 只有你手動呼叫 flush() 才寫（唯讀交易的極致）
    COMMIT   → 只在提交前 flush（★ readOnly=true 的值）
    AUTO     → 查詢前也會 flush（預設）
    ALWAYS   → 每一個查詢前都 flush（連 findById 也算）
```

⚠️ **不要為了「效能」把 `AUTO` 改成 `COMMIT`**：
你會換到一個「查詢讀到過期資料」的 bug，而它**不會報錯**。

**唯一合理的使用場合**是明確的**批次寫入**（5.9）：
那裡你自己控制 flush 的節奏，而且中間不做查詢。

---

## 5.5 ★ 例外一拋出來，交易就一定會 rollback 嗎

**答案是「不一定」，而預設行為和大部分人的直覺相反。**

### 5.5.1 checked Exception 預設【會提交】

```java
static class BusinessException extends Exception { }          // ★ checked

@Transactional
public void doSomething() throws BusinessException {
    repo.save(new PersistableRow(2L, "p"));
    throw new BusinessException("業務規則不符");
}
```

**實測**：

```
=== T4-A RuntimeException vs checked Exception ===
  ① RuntimeException      → 表裡 0 列 ✅ 回滾了
  ② checked Exception     → 表裡 1 列 🔴 【提交了】—— 這是 Spring 的預設行為
  ★ 預設規則：只有 RuntimeException 與 Error 會回滾，checked Exception 【會提交】
    要改：@Transactional(rollbackFor = Exception.class)
```

🔴 **拋出了例外，而那一列被寫進資料庫了。**

**這是 Spring 的預設規則，而且是刻意的**（沿襲 EJB 的慣例）：

> **`RuntimeException` 與 `Error` → 回滾。**
> **`checked Exception` → 提交。**

**理由（Spring 的立場）**：checked exception 是「預期內的、呼叫端應該處理的」，
所以它更像一個「回傳值」而不是「災難」。

⚠️ **而這個理由在實務上幾乎不成立**：
沒有人會在「庫存不足」這種 checked exception 之後，還希望前面寫的東西留在資料庫裡。

**三個處理方式**：

| 做法 | 寫法 | 評價 |
|---|---|---|
| **① 全域改掉** | `@Transactional(rollbackFor = Exception.class)` | ⚠️ 每一處都要寫，漏一個就破功 |
| **② 用 meta annotation** | 自訂 `@UseCase` 註解封裝設定 | ✅ **推薦** —— 一次寫對，到處套用 |
| **③ 業務例外一律用 `RuntimeException`** | 領域例外繼承 `RuntimeException` | ✅ **推薦** —— 05-service 06 章就是這樣做的 |

**② 的寫法**：

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Transactional(rollbackFor = Exception.class)     // ★ 一次寫對
public @interface UseCase { }
```

```java
@Service
public class PayOrderService {
    @UseCase                                       // ← 不用再想 rollbackFor
    public void payOrder(String orderId) { … }
}
```

📌 **②③ 一起用最好**：
領域例外用 `RuntimeException`（③），而 `@UseCase`（②）處理那些
你控制不了的第三方 checked exception（`IOException`、`TimeoutException`…）。

### 5.5.2 ★★ 內層失敗 + 外層 catch 住 = `UnexpectedRollbackException`

這是實務上最難懂的一個現象：**方法看起來成功了，卻拋出一個例外。**

```java
outer.executeWithoutResult(s -> {
    repo.save(new PersistableRow(1L, "外層寫的"));
    try {
        inner.executeWithoutResult(s2 -> {          // ★ PROPAGATION_REQUIRED
            repo.save(new PersistableRow(2L, "內層寫的"));
            throw new IllegalStateException("內層失敗");
        });
    } catch (IllegalStateException e) {
        Lab.line("外層 catch 住了內層的例外，繼續往下走…");   // ← 「我處理過了」
    }
    Lab.line("外層跑到最後，準備提交");
});
```

**實測**：

```
=== T4-B ★★ 內層 REQUIRED 失敗 + 外層 catch 住 → UnexpectedRollbackException ===
  外層 catch 住了內層的例外，繼續往下走…
  外層跑到最後，準備提交
  🔴 UnexpectedRollbackException
     Transaction silently rolled back because it has been marked as rollback-only
  表裡 0 列 → 外層寫的那一筆也不見了
  ★ 因為 REQUIRED 的內層【參加】外層的交易，它把交易標成 rollback-only；
    外層 catch 掉例外沒有用 —— 那個標記在【交易】上，不在例外上
```

**逐步拆解**：

```
① 外層開一個交易 T
② 外層 save(1)                          → T 裡有一筆待寫
③ 內層是 REQUIRED → 【參加】T，不開新的
④ 內層 save(2)                          → T 裡有兩筆待寫
⑤ 內層拋 RuntimeException
   → 內層的交易攔截器發現「我不是最外層」
   → 它不能 rollback（那是外層的交易），所以【把 T 標成 rollback-only】
⑥ 外層 catch 住例外 —— 但那個標記在【T 上】，catch 一個 Java 物件不會清掉它
⑦ 外層跑完，交易攔截器嘗試 commit(T)
   → 發現 T 是 rollback-only → 【rollback】，並拋 UnexpectedRollbackException
```

📌 **關鍵那一句**：

> **`rollback-only` 的標記在【交易】上，不在【例外】上。**
> **`catch` 一個 Java 例外物件，不會取消一個資料庫交易的狀態。**

⚠️ **這個現象的三個特徵讓它特別難查**：

1. **例外的堆疊指向「提交的那一刻」**，完全看不出是哪一段程式碼標記的。
2. **訊息裡有 `silently`** —— 那是它自己在說「我沒有告訴過你」。
3. **外層那筆也不見了** —— 但外層的程式碼「明明成功跑完了」。

### 5.5.3 三個修法

**修法① 不要 catch（最常見的正解）**

```java
outer.executeWithoutResult(s -> {
    repo.save(a);
    inner(...);            // 讓它拋出去
});
```

**如果內層失敗代表整件事失敗，那本來就不該 catch。**

**修法② 內層改成 `REQUIRES_NEW`**

```java
independent.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
```

```
=== T4-C ✅ 用 REQUIRES_NEW 讓內層真的獨立 ===
  外層 catch 住了內層的例外，繼續往下走…
  表裡 1 列 → ✅ 只有外層那一筆，內層真的獨立回滾了
  ⚠️ 代價：REQUIRES_NEW 會【多借一條連線】—— 見 T9-B
```

**這是「內層失敗不影響外層」的正確表達方式** ——
例如「寫稽核日誌失敗不該讓訂單失敗」。

⚠️ **代價很大，5.12.2 有實測**：`REQUIRES_NEW` 會**同時持有兩條連線**。

**修法③ 內層不要拋例外，回傳一個結果**

```java
// 內層改成回傳 Result 而不是拋例外
Result<Void> r = auditService.tryWrite(...);
if (r.isFailure()) log.warn("稽核寫入失敗：{}", r.error());
```

**如果一件事「失敗了也沒關係」，那它就不該用例外表達。**

### 5.5.4 決策表

| 你要的語意 | 怎麼寫 | ⚠️ |
|---|---|---|
| 內層失敗 = 整件事失敗 | 不要 catch | 最常見，也最簡單 |
| 內層失敗**不影響**外層 | `REQUIRES_NEW` | 多一條連線（5.12.2） |
| 內層失敗**不影響**外層，而且很輕 | 不要用例外，回傳結果 | ✅ 通常最好 |
| checked exception 也要回滾 | `rollbackFor = Exception.class` 或自訂 `@UseCase` | 別一處一處寫 |
| 「部分成功」是合法的 | **不要放在同一個交易裡** | 見 5.10.3 的分批取捨 |

---

## 5.6 Open Session In View

04 章練習 1 ①、03 章 3.5.2 都提到了它。這裡交代清楚。

### 5.6.1 它是什麼

Spring Boot **預設開啟** `spring.jpa.open-in-view=true`。它做的事是：

> **在 Web 請求的最開始開啟一個 `EntityManager`，在請求結束（回應寫完）才關掉。**

**它解決的問題**：Controller 回傳 entity 時，Jackson 序列化會碰 LAZY 關聯，
而那時候交易已經結束了 → `LazyInitializationException`（03 章 3.5.2 實測過）。

**OSIV 讓它不會爆** —— 因為 `EntityManager` 還開著。

### 5.6.2 它的四個代價

| 代價 | 說明 |
|---|---|
| **① 連線持有時間變長** | ⚠️ 精確地說：Boot 的 OSIV **不會**整個請求持有連線，只在真的查詢時借。但 `EntityManager` 開著代表**持久化情境開著** |
| **② N+1 被藏起來** | 序列化時觸發的 LAZY 載入**不在任何一段業務程式碼裡**，日誌上看不出來源 |
| **③ 序列化過程中發 SQL** | 如果那時資料庫變慢，**回應已經寫到一半了** —— 你送不出一個乾淨的錯誤 |
| **④ 它讓「entity 外流」變得沒有痛感** | 03 章的 ArchUnit 規則 9 存在的理由就是這個 |

⚠️ **第 4 點是最根本的**：
OSIV 是一個**止痛藥**。真正的病是「entity 跑到了 Controller」。

📌 **shop-service 的做法（03 章就決定了）**：

```yaml
spring:
  jpa:
    open-in-view: false          # ★ 關掉
```

**關掉之後，03 章 3.5.2 那個 `LazyInitializationException` 會在測試裡就出現** ——
而那正是你要的：它逼你在 Repository 裡就把資料準備好（投影、`JOIN FETCH`、兩階段查詢）。

⚠️ 🔴 **本章沒有實測 OSIV 開/關的差異**（lab 沒有 Web 層的完整請求流程）。
上面的第 ① 點特別容易被講錯 —— **Boot 的 OSIV 不等於「整個請求佔住一條連線」**，
Hikari 的連線是用完就還的。列在 5.14 的「沒有驗證到的」。

---

## 5.7 `saveAll()` 為什麼不是批次

### 5.7.1 先看它做了什麼

`SimpleJpaRepository.saveAll()` 的實作就是一個迴圈：

```java
public <S extends T> List<S> saveAll(Iterable<S> entities) {
    List<S> result = new ArrayList<>();
    for (S entity : entities) result.add(save(entity));   // ★ 就這樣
    return result;
}
```

**JDBC 實作也一樣**（02 章寫的）：

```java
@Override
public void saveAll(Collection<Order> orders) {
    orders.forEach(this::save);   // ⚠️ 05 章 5.8 會換成真的批次
}
```

📌 **所以 `saveAll()` 這個名字只承諾「存全部」，沒有承諾「一次存」。**

### 5.7.2 那 `hibernate.jdbc.batch_size` 呢

Hibernate 有一個真的批次機制，但**它預設是關的**：

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50          # ★ 預設沒有值 = 不批次
        order_inserts: true
        order_updates: true
```

⚠️ **開了它，`saveAll()` 也不一定會變成批次。** 下一節就是在講這件事。

---

## 5.8 ★★ 四件會讓批次靜默失效的事

### 5.8.1 實驗設計

三個 entity，**只差主鍵產生策略**：

```java
@Entity @Table(name = "identity_row")
public class IdentityRow {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    // …
}

@Entity @Table(name = "sequence_row")
public class SequenceRow {
    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "seq_gen")
    @SequenceGenerator(name = "seq_gen", sequenceName = "row_seq", allocationSize = 50)
    private Long id;
    // …
}

@Entity @Table(name = "assigned_row")
public class AssignedRow {
    @Id
    private Long id;                              // ★ 自己給
    // …
}
```

⚠️ **量測工具很重要**：`SqlSpy`（Hibernate 的 `StatementInspector`）
只看得到「**準備了幾句 SQL**」，看不到「**送出去幾次**」——
而批次的重點正是後者。所以這一節多加一個 JDBC 層的代理：

```java
/**
 * 05 章：數出 JDBC 層真正發生了幾次 addBatch / executeBatch / executeUpdate。
 *
 * <p>SqlSpy（Hibernate 的 StatementInspector）只看得到「準備了幾句 SQL」，
 * 看不到「送出去幾次」—— 而批次的重點正是後者。
 */
public class BatchCountingDataSource implements DataSource {
    // … 用動態代理包住 Connection 與 PreparedStatement
    private PreparedStatement wrapStatement(PreparedStatement real) {
        return (PreparedStatement) Proxy.newProxyInstance(…, (proxy, method, args) -> {
            switch (method.getName()) {
                case "addBatch"      -> ADD_BATCH.incrementAndGet();
                case "executeBatch", "executeLargeBatch" -> EXEC_BATCH.incrementAndGet();
                case "executeUpdate", "executeLargeUpdate" -> EXEC_UPDATE.incrementAndGet();
                default -> { }
            }
            return invoke(method, real, args);
        });
    }
}
```

### 5.8.2 第一件：`batch_size` 沒設

**實測（20 筆）**：

```
=== T5-A batch_size 沒設（預設） ===
  ① IDENTITY     → 共 20 句（0 SELECT / 20 INSERT / 0 取序號）
  ② SEQUENCE     → 共 22 句（2 SELECT / 20 INSERT / 2 取序號）
  ③ 自己給 id     → 共 40 句（20 SELECT / 20 INSERT / 0 取序號）
  ④ +Persistable → 共 20 句（0 SELECT / 20 INSERT / 0 取序號）
```

**沒設 `batch_size` 時，三種策略都是 20 句 `INSERT`。** 意料之中。

⚠️ **注意 ③「自己給 id」多了 20 句 `SELECT`** —— 那是 03 章 3.9.1 那個 `isNew()`：
`SimpleJpaRepository.save()` 用「id 是不是 `null`」判斷新舊，
自己給 id → 不是 `null` → 一律走 `merge()` → **先 `SELECT` 一次確認在不在**。

**④ 加上 `Persistable` 就消失了**（03 章 3.9.1 的修法，H16 驗證過）：

```java
@Entity @Table(name = "persistable_row")
public class PersistableRow implements Persistable<Long> {

    @Id private Long id;
    @Column(nullable = false) private String payload;

    /** ★ 不落庫的旗標：只在「這個物件是程式碼剛 new 出來的」時為 true。 */
    @Transient private boolean isNew = true;

    @Override public Long getId() { return id; }
    @Override public boolean isNew() { return isNew; }

    /** ★ 從資料庫載入之後（或寫入之後），就不再是新的了。 */
    @PostLoad @PrePersist
    void markNotNew() { this.isNew = false; }
}
```

### 5.8.3 ★★ 第二件：`IDENTITY` 主鍵讓批次完全失效

**打開 `batch_size=20` 再跑一次同樣四組**：

```
=== T5-B batch_size=20 ===
  ① IDENTITY     → 共 20 句（0 SELECT / 20 INSERT / 0 取序號）      ← 一點都沒變
  ② SEQUENCE     → 共  3 句（2 SELECT /  1 INSERT / 2 取序號）
  ③ 自己給 id     → 共 21 句（20 SELECT /  1 INSERT / 0 取序號）
  ④ +Persistable → 共  1 句（ 0 SELECT /  1 INSERT / 0 取序號）
```

**再看 JDBC 層真正送出幾次**：

```
=== T5-C JDBC 層的 round trip（20 筆） ===
  自己給 id + Persistable，batch_size 沒設   → prepareStatement=20, addBatch= 0,
                                              executeBatch=0, executeUpdate=20 → round trip ≈ 20
  ★ IDENTITY 主鍵，        batch_size 沒設   → prepareStatement=20, addBatch= 0,
                                              executeBatch=0, executeUpdate=20 → round trip ≈ 20
  自己給 id + Persistable，batch_size = 20  → prepareStatement= 1, addBatch=20,
                                              executeBatch=1, executeUpdate= 0 → round trip ≈  1
  ★ IDENTITY 主鍵，        batch_size = 20  → prepareStatement=20, addBatch= 0,
                                              executeBatch=0, executeUpdate=20 → round trip ≈ 20
```

🔴 **`IDENTITY` 那兩行【一模一樣】。`addBatch` 一次都沒有被呼叫。**

**整理成一張表**：

| 主鍵策略 | `batch_size` 沒設 | `batch_size=20` | JDBC round trip |
|---|---|---|---|
| **`IDENTITY`** | 20 句 | **20 句** | **20 → 20（完全沒變）** 🔴 |
| `SEQUENCE`（`allocationSize=50`） | 22 句 | **3 句** | —— |
| 自己給 id | 40 句 | 21 句 | —— |
| **自己給 id + `Persistable`** | 20 句 | **1 句** | **20 → 1** ✅ |

**為什麼 `IDENTITY` 不能批次**：

```
JPA 規定：persist() 回來之後，entity 的 id 必須已經有值
          （因為它要放進持久化情境，而情境是按 id 索引的）

IDENTITY 的 id 從哪來？→ 資料庫在 INSERT 的時候產生的

→ 所以每一次 persist() 都【必須立刻】送出那一句 INSERT，才能把 id 拿回來
→ 沒有東西可以累積 → 沒有批次
```

📌 **這是一個「JPA 規格」與「資料庫功能」的硬衝突，不是 Hibernate 的 bug。**
Hibernate 甚至有一行 debug 日誌說明它停用了批次，
**但預設的日誌等級看不到，而且沒有任何警告或例外。**

⚠️ **而 `IDENTITY` 是 MySQL 專案最常見的預設寫法**：

```java
@Id
@GeneratedValue(strategy = GenerationType.IDENTITY)     // 🔴 MySQL 的「標準寫法」
private Long id;
```

**所以「我設了 `batch_size` 但沒有變快」在 MySQL + JPA 的專案裡幾乎是常態。**

### 5.8.4 那 MySQL 該用什麼主鍵策略

MySQL **沒有** sequence。三個選項：

| 選項 | 批次 | 其他代價 |
|---|---|---|
| **`IDENTITY`**（`AUTO_INCREMENT`） | 🔴 **完全不能批次** | id 連續好看；⚠️ 高併發時 `AUTO_INCREMENT` 鎖是熱點 |
| **`TABLE` 產生器** | ✅ 可以 | ⚠️ 需要一張序號表 + 額外的鎖，效能通常比 `IDENTITY` 差 |
| **應用層產生 id（UUID / ULID / snowflake）** | ✅ **可以，而且最乾淨** | ⚠️ id 較大（16 bytes）；隨機 UUID 會讓 InnoDB 主鍵插入變成隨機寫 |

📌 **shop-service 選第三個**（00 章 0.12 就決定了）：

```java
@Override
@Transactional(propagation = Propagation.SUPPORTS)
public String nextId() {
    return "O-" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
}
```

**它同時買到四件事**：

1. **可以批次**（本節）。
2. **id 在 `INSERT` 之前就存在** → 聚合可以在交易外被完整建立（03 章 3.10.4）。
3. **不需要「先存再拿 id」** → Service 的程式碼不用為了拿 id 而切開交易。
4. **測試不需要資料庫** —— 記憶體假實作也產生得出 id。

⚠️ **代價要說清楚**：
**隨機的 UUID 當 InnoDB 主鍵會讓每一次插入落在索引的隨機位置**，
造成頁分裂與更差的寫入吞吐。
**用 ULID / UUIDv7 這種「帶時間序」的 id 可以避免**（本課選 ULID 就是為了這個）。
🔴 **本章沒有在 MySQL 上量測這個差異** —— 07-mysql 站 02 章會補。

### 5.8.5 第三件：`SEQUENCE` 的 `allocationSize`

上面 `SEQUENCE` 那一行有一個細節：**20 筆只取了 2 次序號**。

```
② SEQUENCE → 共 3 句（2 SELECT / 1 INSERT / 2 取序號）
```

因為 `allocationSize = 50`：Hibernate 一次跟資料庫要 50 個號碼，在記憶體裡分配。

⚠️ **預設的 `allocationSize` 是 50，但很多人會寫成 1**：

```java
@SequenceGenerator(name = "seq_gen", sequenceName = "row_seq", allocationSize = 1)  // 🔴
```

**`allocationSize = 1` → 每一筆都要跟資料庫要一次號碼 → 20 筆就是 20 次額外 round trip。**
批次的 `INSERT` 是 1 次，取號碼卻是 20 次 —— **批次的好處被抵消掉大半**。

📌 **`allocationSize` 要和資料庫序列的 `INCREMENT BY` 一致**：

```sql
CREATE SEQUENCE row_seq START WITH 1 INCREMENT BY 50;    -- ★ 要和 allocationSize 一樣
```

**不一致會發生什麼**：Hibernate 以為它拿到了 50 個號碼（`n` 到 `n+49`），
而資料庫只前進了 1 → **兩個應用程式實例會產生重複的 id**。

### 5.8.6 第四件：`order_inserts` 沒開

批次要成立，**連續的語句必須是同一句 SQL**。

```java
// 交錯的寫入
for (Order o : orders) {
    orderRepo.save(o);        // INSERT INTO orders
    lineRepo.saveAll(...);    // INSERT INTO order_line
}
```

**Hibernate 的批次是「同一個 `PreparedStatement` 累積」** ——
語句一換，前一批就要先送出去。
上面那個迴圈會產生 `orders / order_line / orders / order_line …`，
**每一批只有一筆**。

```yaml
hibernate:
  order_inserts: true      # ★ flush 時把同表的 INSERT 排在一起
  order_updates: true      # ★ UPDATE 也一樣
```

⚠️ **`order_inserts` 只在 flush 的時候重排**，
所以它**不能**解決「你自己在迴圈裡交錯呼叫 `flush()`」的情況。

### 5.8.7 shop-service 的 `saveAll()`：真的批次版

00 章的表裡欠著這一項，現在補上：

```java
/**
 * ★★ 05 章 5.8：真的批次版本。
 *
 * <p>{@code orders.forEach(this::save)} 對 N 張訂單會送出 <b>3N ~ 4N 次</b> round trip
 * （每張：1 UPDATE + 1 COUNT + 1 INSERT + 1 批次的明細）。
 * 這一版把同類型的語句合併成 <b>固定幾次</b>。
 *
 * <p>⚠️ 代價寫在下面：它<b>放棄了「逐筆回報是哪一張訂單失敗」</b>。
 */
@Override
public void saveAll(Collection<Order> orders) {
    if (orders.isEmpty()) return;
    List<Order> list = List.copyOf(orders);

    // ① 一次批次 UPDATE，逐筆看更新了幾列
    int[] updated = jdbc.batchUpdate(UPDATE_HEAD,
            list.stream().map(JdbcOrderRepository::headParams).toArray(SqlParameterSource[]::new));

    List<Order> existing = new ArrayList<>();
    List<Order> maybeNew = new ArrayList<>();
    for (int i = 0; i < list.size(); i++) {
        (updated[i] == 1 ? existing : maybeNew).add(list.get(i));
    }

    // ② 更新了 0 列的那些：一次查出「哪些 id 真的已經存在」
    if (!maybeNew.isEmpty()) {
        List<String> ids = maybeNew.stream().map(Order::id).toList();
        List<String> present = jdbc.queryForList(
                "SELECT id FROM orders WHERE id IN (:ids)",
                new MapSqlParameterSource("ids", ids), String.class);
        if (!present.isEmpty()) {
            // ★ 已經存在卻更新了 0 列 → version 對不上
            throw new OptimisticLockingFailureException("這些訂單已被其他交易修改：" + present);
        }
        jdbc.batchUpdate(INSERT_HEAD, maybeNew.stream()
                .map(JdbcOrderRepository::headParams).toArray(SqlParameterSource[]::new));
    }

    // ③ 舊單的明細全刪（一次批次），然後所有訂單的明細一次批次插入
    if (!existing.isEmpty()) {
        jdbc.batchUpdate("DELETE FROM order_line WHERE order_id = :id",
                existing.stream()
                        .map(o -> (SqlParameterSource) new MapSqlParameterSource("id", o.id()))
                        .toArray(SqlParameterSource[]::new));
    }
    List<SqlParameterSource> allLines = new ArrayList<>();
    for (Order order : list) allLines.addAll(lineParams(order));
    jdbc.batchUpdate(INSERT_LINE, allLines.toArray(SqlParameterSource[]::new));
}
```

**round trip 從 `3N ~ 4N` 變成固定 4 次**（`UPDATE` / `SELECT IN` / `INSERT` / 明細）。

⚠️ **這一版有三個必須說清楚的代價**：

| 代價 | 說明 |
|---|---|
| **① 錯誤訊息變差** | 樂觀鎖失敗時說的是「這些訂單」，不是「哪一張的哪一個欄位」 |
| **② `updated[i]` 的可信度依驅動而異** | JDBC 允許回傳 `SUCCESS_NO_INFO`（-2）；🔴 **本章只在 H2 上驗證** |
| **③ 「先 `UPDATE` 全部再判斷」對「全部都是新單」的情況多跑一次批次** | 匯入場景（全新資料）可以走一個專門的 `insertAll()` |

### 5.8.7b 🔴 ★★ 這段程式碼在 MySQL 上會壞掉（06 章驗證的結果）

上表第 ② 項寫著「`updated[i]` 的可信度依驅動而異，本章只在 H2 上驗證」。
**06 章用真的 MySQL 8.0.46 跑了一次，結果是最壞的那一種**：

```
=== ★ MySQL 8（真的） —— 05 章欠的五根探針 ===
  [17] rewriteBatchedStatements=true   [-2, -2, -2, -2, -2] 🔴 變成 SUCCESS_NO_INFO(-2)
                                       —— 05 章 5.8.7 的判斷會壞掉
```

**對照沒有開 `rewriteBatchedStatements` 時**：

```
  [15] executeBatch 的回傳陣列內容      [1, 1, 1] ✅ 都是實際列數      ← MySQL
  [15] executeBatch 的回傳陣列內容      [1, 1, 1] ✅ 都是實際列數      ← H2
```

🔴 **所以 5.8.7 那段程式碼會在【同時滿足兩個條件】時靜默失效**：

1. 資料庫是 MySQL，而且
2. JDBC URL 有 `rewriteBatchedStatements=true`（**而 5.8.9 正是叫你加上它**）

**失效的方式**：`updated[i]` 全部是 `-2`，永遠不等於 `1`
→ **每一張訂單都被判定成「新單」** → 全部走 `INSERT`
→ **舊訂單撞主鍵，整批爆掉**（如果幸運），或者
→ **樂觀鎖的檢查完全沒有執行**（如果那些 id 剛好都不存在）。

⚠️ **這是本課至今最尖銳的一個例子**：
**5.8.9 建議的那個效能設定，會讓 5.8.7 的正確性設計失效** ——
而兩節相隔不到兩頁，都是本章寫的。

**修法（三選一）**：

| 修法 | 寫法 | 取捨 |
|---|---|---|
| **① 不要在同一批裡混新舊** | 呼叫端明確分成 `insertAll()` 與 `updateAll()` | ✅ **最好** —— 順便讓語意變清楚 |
| **② 不靠 `updated[i]`，先查一次** | 先 `SELECT id, version FROM orders WHERE id IN (...)` 決定新舊 | 多一次 round trip，但完全可攜 |
| **③ 那一段不開 `rewriteBatchedStatements`** | 用兩個 `DataSource`（一個給批次、一個給一般） | ⚠️ 複雜，而且很容易被下一個人「整理」掉 |

📌 **shop-service 選 ①**，並在 `saveAll()` 上加一條斷言：

```java
for (int i = 0; i < list.size(); i++) {
    if (updated[i] == Statement.SUCCESS_NO_INFO) {
        throw new IllegalStateException(
                "這個 JDBC 驅動不回傳實際更新列數（SUCCESS_NO_INFO）——"
              + "saveAll() 無法判斷新舊。請改用 insertAll() / updateAll()，"
              + "或關掉 rewriteBatchedStatements（05 章 5.8.7b）");
    }
    (updated[i] == 1 ? existing : maybeNew).add(list.get(i));
}
```

⚠️ **「壞掉的時候大聲失敗」比「靜默走錯分支」好太多** ——
而這一行 `if` 是**只有在真的 MySQL 上跑過才寫得出來的**。

### 5.8.8 一萬筆的實測：`batch_size` 該設多少

```
=== T6-A 1 萬筆 INSERT：batch_size 從 0 到 1000 ===
  batch_size     耗時         JDBC round trip  addBatch 次數
  沒設            337 ms      10000            0
  1              176 ms      10000            0
  20             117 ms      500              10000
  50              79 ms      200              10000
  100             68 ms      100              10000
  500             66 ms      20               10000
  1000            48 ms      10               10000
```

**三個觀察**：

1. 🔴 **`batch_size = 1` 等於沒開**（`addBatch = 0`）——
   Hibernate 對 `<= 1` 直接停用批次。**「先設 1 試試看」是無效的實驗。**
2. **邊際效益很快遞減**：20 → 50 省 38 ms，500 → 1000 只省 18 ms。
3. **round trip 從 10,000 降到 10** —— 而時間只快了 7 倍。

⚠️ **第 3 點在 H2 上被嚴重低估了**：H2 在同一個 JVM 裡，一次 round trip 幾乎免費。
**在真的 MySQL 上，一次 round trip 是一次網路來回**（同機房約 0.2～0.5 ms）。

```
10,000 次 round trip × 0.3 ms = 3 秒
    10 次 round trip × 0.3 ms = 3 毫秒
```

🔴 **這個推算沒有在 MySQL 上驗證** —— 列在 5.14。
**但它是「批次為什麼重要」的真正理由**，而那個理由在 H2 上量不出來。

📌 **`batch_size` 的建議值：50 ~ 100。** 理由：

- 邊際效益在 100 之後就很小。
- **批次越大，那一次失敗要重做的越多**（5.10.3）。
- **批次越大，記憶體裡累積的參數越多**（MySQL 的 `max_allowed_packet` 是實際上限）。

### 5.8.9 ⚠️ MySQL 還需要一個 JDBC 參數

**Hibernate 開了批次，MySQL 驅動預設還是會一句一句送。**

```
jdbc:mysql://host:3306/db?rewriteBatchedStatements=true
```

沒有它，`addBatch` + `executeBatch` 只是「在 driver 裡排隊，然後一句一句送」——
**你會看到 `executeBatch` 被呼叫 1 次，而網路上仍然是 N 次來回**。

有了它，driver 會把 N 句 `INSERT` **改寫成一句多值的 `INSERT`**：

```sql
-- 原本
INSERT INTO t (a,b) VALUES (1,2);
INSERT INTO t (a,b) VALUES (3,4);
-- 改寫成
INSERT INTO t (a,b) VALUES (1,2),(3,4);
```

⚠️ **它有兩個副作用**：

1. **`getGeneratedKeys()` 的行為會變**（多值 `INSERT` 只回第一個 id）。
2. **`executeBatch()` 的回傳陣列可能變成 `SUCCESS_NO_INFO`（-2）** ——
   5.8.7 那個 `updated[i] == 1` 的判斷**會壞掉**（🔴 **已證實，見 5.8.7b**）。
3. 🔴 **批次失敗時「哪些寫進去了」也會變**（部分寫入 → 全有全無）——
   **見 5.10.1b**。

🔴 **本章沒有 MySQL，這三點都沒有驗證；06 章補上了，而三點【全部】成立。**
📌 **但它們共同指向一個結論**：
**「批次 + 逐筆判斷更新結果」這個組合在 MySQL 上要特別小心** ——
5.8.7 那段程式碼上線前必須在真的 MySQL 上驗證一次。

---

## 5.9 ★ 批次寫入的記憶體：`flush()` 不夠，還要 `clear()`

### 5.9.1 持久化情境會一直長大

`batch_size` 解決了「送出去幾次」，**沒有解決「記憶體裡有幾個物件」**。

```java
tx.executeWithoutResult(s -> {
    for (int i = 1; i <= 10_000; i++) {
        repo.save(new PersistableRow((long) i, "payload-" + i));
    }
});
```

**每一個 `save()` 都把物件放進持久化情境，而它在交易結束前不會放掉。**

**實測**（1 萬筆，`batch_size=50`）：

```
=== T6-B ★ 持久化情境的大小：flush() + clear() 有沒有差 ===
  ① 不 clear：情境裡有 10,000 個受管實體，記憶體 +3 MB
  ② 每 500 筆 flush+clear：情境裡有 0 個受管實體，記憶體 +2 MB
  ③ 只 flush 不 clear：情境裡有 10,000 個受管實體
  ★ flush() 把 SQL 送出去，clear() 才把物件從記憶體放掉 —— 兩個是不同的事
```

🔴 **③ 是重點：只 `flush()` 不 `clear()`，情境裡還是 10,000 個。**

**兩個方法做的是兩件事**：

| 方法 | 做什麼 | 不做什麼 |
|---|---|---|
| `flush()` | 把待寫的變更**送出 SQL** | 🔴 **不會**把物件從情境裡移除 |
| `clear()` | 把**所有**受管實體從情境裡移除 | 🔴 **不會**送出任何 SQL（沒 flush 的變更**直接遺失**） |

⚠️ **順序不能反**：`clear()` 之前一定要 `flush()`，否則待寫的變更會被丟掉，
**而且不會有任何錯誤**。

### 5.9.2 正確的寫法

```java
tx.executeWithoutResult(s -> {
    EntityManager em = EntityManagerFactoryUtils.getTransactionalEntityManager(emf);
    for (int i = 1; i <= N; i++) {
        repo.save(new PersistableRow((long) i, "payload-" + i));
        if (i % 500 == 0) { em.flush(); em.clear(); }    // ★ 兩個都要
    }
});
```

📌 **`flush + clear` 的間隔通常設成和 `batch_size` 同一個數量級**
（`batch_size=50`，每 500 或 1000 筆 clear 一次）。

⚠️ **`clear()` 之後，你手上的 entity 全部變成 detached** ——
再碰它們的 LAZY 關聯會爆 `LazyInitializationException`。
所以 `clear()` 只能用在「寫完就不再碰」的批次流程裡。

### 5.9.3 記憶體那一欄為什麼看起來沒差

上面的實測裡，記憶體只差 1 MB。**因為 `PersistableRow` 只有兩個欄位，而且 H2 在記憶體裡。**

📌 **這一節唯一可信的數字是「情境裡有幾個受管實體」：10,000 vs 0。**

**在真實專案裡把它換算一下**：

```
一個 OrderEntity + 2 個 OrderLineEntity ≈ 1 KB
（entity 本身 + Hibernate 為 dirty checking 保存的【快照】，快照幾乎等於再一份）

50 萬筆 × 1 KB × 2（含快照）= 【約 1 GB】
```

⚠️ **那個「快照」是最容易被忽略的一半**：
Hibernate 為了 dirty checking（03 章 3.9.2），
會為每一個受管實體保存一份**載入時的狀態複本**。
**所以持久化情境的記憶體成本大約是 entity 大小的兩倍。**

🔴 **本章沒有量測「快照」的實際大小** —— 列在 5.14。

### 5.9.4 純 JDBC 的對照組

```
=== T6-C 對照組：純 JdbcTemplate 的 batchUpdate（1 萬筆） ===
  每批 1      筆 → 119 ms   round trip 10000 （Hibernate 完全沒有參與）
  每批 500    筆 →  19 ms   round trip 20
  每批 10000  筆 →  15 ms   round trip 1
  最終筆數：10,000
```

**19 ms vs Hibernate 最好的 48 ms —— 快 2.5 倍，而且完全沒有記憶體問題**
（`JdbcTemplate.batchUpdate` 不建立任何持久化情境）。

📌 **判準**：

> **純寫入的批次（匯入、遷移、對帳檔載入）不要走 JPA。**
> 那裡沒有領域行為、沒有不變量要維護、沒有關聯要導航 ——
> 用 `JdbcTemplate.batchUpdate` 或資料庫原生的匯入工具。

⚠️ **注意 02 章 2.13.2 說過的話仍然成立**：`batchUpdate` **不是**交易。下一節就是。

---

## 5.10 ★ 批次不等於交易

### 5.10.1 沒有交易時，批次裡壞掉一筆會怎樣

**情境**：批次插入 10 筆，其中第 5 筆的主鍵已經存在。

```
=== T7-A 沒有交易的 batchUpdate：第 5 筆重複主鍵 ===
  拋出 DuplicateKeyException
    BatchUpdateException.getUpdateCounts() = [1, 1, 1, 1, -3, 1, 1, 1, 1, 1]
    ★ 這個陣列告訴你【前幾筆成功了】
  結果表裡有 10 列：[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  🔴 沒有交易 → 失敗【前後】的都留下來了。批次不是原子的
  ★ 注意 updateCounts 裡的 -3（Statement.EXECUTE_FAILED）只有一個 ——
    H2 遇到第 5 筆失敗之後【繼續執行了剩下的 5 筆】
    ⚠️ JDBC 規範【允許】兩種行為（停下來 / 繼續），所以這件事【依驅動而異】
```

**兩個發現**：

1. **10 筆裡 9 筆成功了**（`1,2,3,4,6,7,8,9,10`），只有第 5 筆失敗（`-3` = `EXECUTE_FAILED`）。
2. 🔴 **H2 沒有在失敗處停下來，它繼續跑完了。**

⚠️ **第 2 點是 JDBC 規範明說「隨實作」的**：

> `executeBatch()` 遇到錯誤時，driver **可以**停下來、也**可以**繼續。

**MySQL 的行為與 H2 是不是一樣**（🔴 本章沒有驗證，**06 章補上了，而答案比預期複雜** ——
見下一小節），所以**任何依賴「失敗之後就停了 / 沒停」的程式碼都是不可攜的**。

### 5.10.1b 🔴 ★★ 而在 MySQL 上，答案取決於 5.8.9 那個參數

⚠️ **06 章 6.4.2 探針 ⑭ 用真的 MySQL 8.0.46 跑了同一件事，
而它的答案取決於一個【本章自己建議你打開】的 URL 參數。**

```
=== ★ MySQL 8.0.46：批次 5 筆，第 3 筆違反 CHECK ===
  rewriteBatchedStatements=false
      BatchUpdateException.getUpdateCounts() = [1, 1, -3, 1, 1]
      表裡剩下 4 筆   ← 和 H2 一樣：跳過壞的那一筆，繼續跑完

  rewriteBatchedStatements=true
      BatchUpdateException.getUpdateCounts() = [-3, -3, -3, -3, -3]
      表裡剩下 0 筆   🔴 一筆都沒進去
```

**原因**：`rewriteBatchedStatements=true` 把 N 句 `INSERT` **改寫成一句多值 `INSERT`**（5.8.9）。

```sql
-- 沒開：5 句獨立的語句，第 3 句失敗，其他 4 句照樣執行
INSERT INTO b2 VALUES (1,1);  INSERT INTO b2 VALUES (2,1);
INSERT INTO b2 VALUES (3,-3); INSERT INTO b2 VALUES (4,1);  INSERT INTO b2 VALUES (5,1);

-- 開了：一句，而【一句 SQL 沒有「跑到一半」這回事】
INSERT INTO b2 VALUES (1,1),(2,1),(3,-3),(4,1),(5,1);   -- ← 整句失敗，一列都不進去
```

🔴 **所以 5.10.1 那個「批次不是原子的，失敗前後的都留下來了」的結論，
在 MySQL + `rewriteBatchedStatements=true` 下【是反的】。**

⚠️ **這不代表你可以靠它** —— 理由有三個：

| 為什麼不能靠它 | 說明 |
|---|---|
| **它只在「一批剛好被改寫成一句」時成立** | 超過 `max_allowed_packet` 時驅動會**自動切成好幾句**，於是又變回部分寫入 |
| **它只對 `INSERT` 有效** | `UPDATE` / `DELETE` 的批次不會被改寫成一句 |
| **它是一個效能參數** | 下一個人為了別的理由把它關掉，你的原子性就沒了，**而且不會有任何錯誤** |

📌 **所以 5.10.2 的規則一個字都不用改**：

> **批次一定要在交易裡。**
> **不要從「這次觀察到的部分寫入行為」推論任何原子性保證** ——
> 那個行為由驅動、由參數、甚至由這一批的大小決定。

⚠️⚠️ **而這一節與 5.8.7b 是【同一個根因的第二個受害者】**：

| | 5.8.7b | 5.10.1b（本節） |
|---|---|---|
| 被改變的東西 | `executeBatch()` 的**回傳值**（變成 `-2`） | `executeBatch()` 的**失敗語意**（部分寫入 → 全有全無） |
| 兇手 | `rewriteBatchedStatements=true` | 同一個 |
| 症狀 | 新舊判斷全部走錯分支 | 一個「示範部分寫入」的實驗量到相反的結果 |

📌 **一句話**：
**`rewriteBatchedStatements=true` 改變的不是「送幾次」，是 `executeBatch()` 這個 API 的語意。**
**把它當成一個「純效能參數」是這一章最貴的一個誤解。**

### 5.10.2 包在交易裡就對了

```
=== T7-B ✅ 同一段程式碼，包在一個交易裡 ===
  拋出 DuplicateKeyException
  結果表裡有 1 列：[5]
  ✅ 只剩那一筆原本就在的 —— 批次整組回滾了
```

Hibernate 的批次也一樣：

```
=== T7-D Hibernate 的批次：第 5 筆重複主鍵 ===
  拋出 DataIntegrityViolationException
    根因 JdbcBatchUpdateException: Unique index or primary key violation:
    "PRIMARY KEY ON PUBLIC.PERSISTABLE_ROW(ID) ( /* key:5 */ CAST(5 AS BIGINT), 'already-here')"
  表裡有 1 列 → ✅ 整組回滾（因為在一個交易裡）
  ⚠️ 但注意：批次讓錯誤訊息【變難讀】——
    它說的是「批次裡有一筆失敗」，而不是「id=5 這一筆失敗」
```

📌 **所以規則很簡單**：

> **批次一定要在交易裡。**
> **`batchUpdate` 本身只承諾「一次送出去」，不承諾「一起成功或一起失敗」。**

### 5.10.3 ⚠️ 但「分批提交」就放棄了原子性

5.9 說批次要 `flush + clear` 控制記憶體。
但如果資料量大到**一個交易裝不下**（例如 500 萬筆），
常見的做法是**分批提交**：

```java
for (int start = 1; start <= total; start += chunk) {
    tx.executeWithoutResult(s -> { ... });     // ★ 每一批一個交易
}
```

**實測（40 筆分 4 批，第 3 批裡有一筆重複）**：

```
=== T7-C ⚠️ 為了記憶體而「分批提交」，就放棄了原子性 ===
  第 3 批失敗：DuplicateKeyException
  已提交 2 批；表裡有 21 列
  🔴 前 2 批（20 筆）已經進去了，而整件事失敗了
  ★ 這不是 bug，是一個【必須明確做出的取捨】：
    「一個交易寫 40 萬筆」與「4000 個交易各寫 100 筆」
    前者原子、但長交易；後者短交易、但要自己處理【重跑】
    → 分批就必須做到【冪等】（idempotent）
```

**兩條路的對照**：

| | 一個大交易 | 分批提交 |
|---|---|---|
| 原子性 | ✅ 全有或全無 | 🔴 **會停在中間** |
| 記憶體 | ⚠️ undo log / 情境都會很大 | ✅ 每批都放掉 |
| 鎖 | 🔴 **持有到最後**（別人全部被擋住） | ✅ 每批就放 |
| 連線 | 🔴 **佔住到最後**（5.12） | ✅ 每批就還 |
| 失敗後 | 什麼都不用做 | ⚠️ **必須能重跑** |

📌 **「必須能重跑」= 冪等（idempotent）**。三個常見做法：

| 做法 | 寫法 |
|---|---|
| **記錄進度** | 一張 `import_progress` 表記「做到第幾筆 / 哪一個 id」，重跑時從那裡繼續 |
| **`INSERT ... ON DUPLICATE KEY UPDATE` / `MERGE`** | 重跑時已存在的直接覆蓋 ⚠️ 但 02 章 2.8.3 證明過它**會讓樂觀鎖失效** |
| **先寫進暫存表，最後一次原子搬移** | ✅ 大型匯入的標準做法：暫存表可以隨便重跑，最後一句 `INSERT ... SELECT` 是原子的 |

⚠️ **第三種最值得推薦**，因為它把「大量寫入」與「讓資料生效」拆成兩件事，
**只有後者需要原子性，而後者很快。**

---

## 5.11 ★★ 讀 20 萬筆：`Stream` 真的是串流嗎

### 5.11.1 五種做法

```java
// ① findAll() → List
List<PersistableRow> all = repo.findAll();
for (PersistableRow r : all) export(r);

// ② Stream（Spring Data 支援回傳 Stream）
@Query("SELECT r FROM PersistableRow r")
Stream<PersistableRow> streamAll();

try (Stream<PersistableRow> stream = repo.streamAll()) {
    stream.forEach(this::export);
}

// ③ Stream + 定期 clear
try (Stream<PersistableRow> stream = repo.streamAllWithFetchSize()) {
    stream.forEach(r -> {
        export(r);
        if (++seen % 1000 == 0) em.clear();          // ★ 關鍵那一行
    });
}

// ④ keyset 分批（04 章 4.7 的寫法用在批次上）
long lastId = 0;
while (true) {
    List<PersistableRow> chunk = tx.execute(s -> repo.chunkAfter(lastId, 1000));
    if (chunk.isEmpty()) break;
    chunk.forEach(this::export);
    lastId = chunk.get(chunk.size() - 1).getId();
}

// ⑤ 純 JDBC + RowCallbackHandler（02 章 2.5.7）
jdbc.setFetchSize(500);
jdbc.query("SELECT id, payload FROM persistable_row",
        rs -> { export(rs.getString("payload")); });
```

### 5.11.2 實測：20 萬筆

```
=== T8 讀 200,000 筆做匯出（每一筆只是算一下 payload 的長度） ===
  ① findAll() → List           435 ms｜情境裡最多 200,000 個受管實體｜迴圈中堆積  +97 MB
  ② Stream（不 clear）          489 ms｜情境裡最多 200,000 個受管實體｜迴圈中堆積  +98 MB
  ③ Stream + 每千筆 clear       119 ms｜情境裡最多   1,000 個受管實體｜迴圈中堆積  +85 MB
  ④ keyset 分批（每批 1000）    291 ms｜每批最多     1,000 個物件｜迴圈中堆積 +115 MB（200 批）
  ⑤ JDBC RowCallbackHandler      46 ms｜同時只有       1 列在記憶體｜迴圈中堆積  +12 MB
  ★ 「情境裡最多幾個受管實體」是這一節唯一重要的數字 ——
    它會不會隨資料量成長，決定了這段程式碼在 2000 萬筆時會不會 OOM
```

🔴 **② 是本節的重點**：

> **`Stream<T>` 讀 20 萬筆，持久化情境裡累積了 200,000 個受管實體 ——
> 和 `findAll()` 一模一樣。**

**它「是」串流的部分**：資料庫的 `ResultSet` 是一列一列讀進來的（沒有一次全撈）。
**它「不是」串流的部分**：每一列被轉成 entity 之後，**就永遠留在持久化情境裡了**。

📌 **所以 `Stream` 只換掉了問題的一半**，而剩下的那一半（持久化情境）
**才是 OOM 的真正來源**。

⚠️ **③ 只加了一行 `em.clear()`，就同時得到**：
- 受管實體從 200,000 降到 **1,000**
- 時間從 489 ms 降到 **119 ms（快 4 倍）**

**為什麼 `clear()` 還會變快**：持久化情境是一個以 id 為鍵的 map，
而且每一次 flush 檢查都要走過**全部**受管實體做 dirty checking。
**情境越大，每一個操作越慢** —— 這是一個 O(n²) 的形狀。

### 5.11.3 記憶體那一欄要打折看

⚠️ **「迴圈中堆積」那一欄不是「活著的物件」，是「已配置但還沒被 GC 回收的」。**
③④ 的 85/115 MB 大多是**很快就會變垃圾**的短命物件，
而 ①② 的 97/98 MB 是**一直活著、不能回收**的。

📌 **所以這一節唯一可信的比較是「情境裡最多幾個受管實體」那一欄**：

| 做法 | 受管實體上限 | 會隨資料量成長嗎 |
|---|---|---|
| ① `findAll()` | 200,000 | 🔴 **會**（= 全部） |
| ② `Stream` 不 clear | 200,000 | 🔴 **會**（= 全部） |
| ③ `Stream` + clear | **1,000** | ✅ **不會**（= clear 間隔） |
| ④ keyset 分批 | **1,000** | ✅ **不會**（= 批次大小） |
| ⑤ JDBC callback | **1** | ✅ **不會** |

**「會不會隨資料量成長」就是「這段程式碼會不會在某一天 OOM」。**

### 5.11.4 ⚠️ MySQL 的 `Stream` 還有一個坑

上面那個「`ResultSet` 是一列一列讀進來的」在 H2 上成立。
**在 MySQL 上預設不成立。**

**MySQL Connector/J 預設會把整個 `ResultSet` 讀進 driver 的記憶體。**
要真的串流，需要**三個條件同時成立**：

```java
@QueryHints(@QueryHint(name = HINT_FETCH_SIZE, value = "" + Integer.MIN_VALUE))   // ① 不是 500，是 MIN_VALUE
@Query("SELECT r FROM PersistableRow r")
Stream<PersistableRow> streamAll();
```

| 條件 | 說明 |
|---|---|
| ① `fetchSize = Integer.MIN_VALUE` | ⚠️ **MySQL 專用的魔術值**，`500` 是無效的（會被忽略） |
| ② `useCursorFetch=true`（另一種做法） | 走伺服器端游標，此時 `fetchSize` 才吃正常數值 |
| ③ 那條連線上**不能有其他查詢** | 串流期間該連線被獨佔，中途發別的 SQL 會爆 |

⚠️ **③ 特別容易踩**：
在 `stream.forEach(...)` 裡面呼叫另一個 Repository 方法 →
它想用同一條連線 → **`Streaming result set … is still active`**。

📌 **這是我推薦 ④（keyset 分批）而不是 ③ 的主要理由**：

| | ③ `Stream` + clear | ④ keyset 分批 |
|---|---|---|
| 記憶體 | ✅ 固定 | ✅ 固定 |
| 速度（H2） | ✅ 119 ms | 291 ms |
| **需要 driver 的串流設定** | 🔴 **要**（而且 MySQL 的很難搞對） | ✅ **不用** |
| **迴圈裡可以做別的查詢** | 🔴 **不行**（連線被獨佔） | ✅ **可以** |
| **可以分批提交 / 中斷後續跑** | 🔴 **不行**（在同一個交易裡） | ✅ **可以**（每批一個交易） |
| **游標移動時資料變了** | 行為依隔離級別而定，難推理 | ✅ 明確：每批看到自己那一刻的快照 |

**shop-service 的選擇**：

| 場景 | 做法 |
|---|---|
| 匯出 CSV 給使用者下載（04-controller 05 章的串流回應） | **⑤ JDBC `RowCallbackHandler`** —— 最省、不需要 entity |
| 需要領域行為的批次處理（例如「把所有過期訂單取消」） | **④ keyset 分批**，每批一個交易 |
| 一次性的資料遷移腳本 | **⑤ 或資料庫原生工具** |
| 🔴 **任何情況** | **不要 ①，也不要 ②** |

### 5.11.5 `Stream` 沒有 close 會怎樣

```java
Stream<PersistableRow> stream = repo.streamAll();     // 🔴 沒有 try-with-resources
stream.forEach(this::export);
```

`Stream` 背後是一個**開著的 `ResultSet`**。
不 close → `ResultSet` 與 `Statement` 不會關 → **在交易結束前一直佔著**。

⚠️ 而 Spring Data 的 `Stream` **必須**在交易裡使用
（否則 `EntityManager` 早就關了），
所以「忘了 close」的直接後果是**那個交易被拉長**，接上 5.12 的問題。

📌 **`Stream` 回傳型別一定要配 try-with-resources** ——
這是一條可以用靜態分析檢查的規則。

---

## 5.12 一個交易該多大

### 5.12.1 交易的長度 = 連線被佔住的長度

**情境**：一個交易裡呼叫外部服務（付款閘道、風控 API…）。

```java
tx.executeWithoutResult(s -> {
    jdbc.queryForObject("SELECT 1", Integer.class);      // ① 一句 SQL
    externalService.call();                              // ② 600 ms，完全不碰資料庫
    jdbc.queryForObject("SELECT 1", Integer.class);      // ③ 一句 SQL
});
```

**實測**（連線池只有 3 條，12 個並行請求）：

```
=== T9-A 池子 3 條連線，12 個「交易裡呼叫外部服務」的並行請求 ===
  每個交易：① 一句 UPDATE  ② 呼叫外部服務（600 ms）  ③ 一句 UPDATE
  結果：成功 12、失敗 0，總耗時 2,429 ms
  🔴 那 600 ms 完全沒有用到資料庫，卻【整段佔住】一條連線
  ★ 交易的長度 = 連線被佔住的長度，和「做了幾句 SQL」無關（01 章 1.9）
```

**把外部呼叫移到交易外面**（同樣 12 個請求、同樣 3 條連線、同樣 600 ms）：

```java
tx.executeWithoutResult(s -> jdbc.queryForObject("SELECT 1", Integer.class));
externalService.call();                                  // ★ 交易【外面】
tx.executeWithoutResult(s -> jdbc.queryForObject("SELECT 1", Integer.class));
```

```
=== T9-B ✅ 把外部呼叫移出交易 ===
  結果：成功 12、失敗 0，總耗時 606 ms
  ✅ 同樣 12 個請求、同樣 3 條連線、同樣 600 ms 的外部呼叫
  ⚠️ 代價：那兩句 SQL 不再是原子的 —— 這是【要明確承認】的取捨
```

**2,429 ms → 606 ms，快 4 倍。**
而且**資料庫做的事完全一樣**（都是 24 句 `SELECT 1`）。

📌 **這就是 01 章 1.9 那個「半夜整站停止回應，但資料庫 CPU 只有 4%」的成因**：
連線池是**限流器**，而交易的長度決定了每一個請求佔住限額多久。

⚠️ **T9-B 的代價要明確承認**：
那兩句 SQL 現在在**兩個不同的交易**裡 —— 它們不再是原子的。
**這是 T1-B 那個問題。** 你是刻意選擇了它，而不是不小心。

**怎麼刻意地做這個選擇**（三個常見手法）：

| 手法 | 說明 |
|---|---|
| **狀態機 + 補償** | 交易1 寫「處理中」→ 外部呼叫 → 交易2 寫「成功/失敗」；卡在「處理中」的由排程對帳 |
| **Outbox 模式** | 交易1 把「要呼叫外部」寫進 outbox 表（**同一個交易**）→ 另一個 worker 讀 outbox 去呼叫 |
| **先呼叫再寫入** | 如果外部呼叫是冪等的，先呼叫、成功了再開交易寫 |

📌 **Outbox 是最穩的**（05-service 08 章會展開）：
**它把「兩個系統的一致性」換成「一張表的一致性」**，而後者資料庫本來就保證。

### 5.12.2 ★ `REQUIRES_NEW` 會多借一條連線

5.5.3 的修法② 有一個代價：

```java
outer.executeWithoutResult(s -> {
    jdbc3.queryForObject("SELECT 1", Integer.class);          // 外層拿著連線 A
    inner.executeWithoutResult(s2 -> …);                      // REQUIRES_NEW → 要借連線 B
});
```

**實測（池子只有 1 條連線）**：

```
=== T9-C REQUIRES_NEW 會多借一條連線 ===
  🔴 CannotCreateTransactionException
     Could not open JDBC Connection for transaction
  ★ 池子只有 1 條連線 → 外層拿著，內層永遠等不到 → 【自我死鎖】
  ⚠️ 這就是 01 章 1.9 那個「資料庫 CPU 4% 卻整站停止回應」的成因之一
```

**這是一個真正的死鎖**：外層永遠不會放掉連線 A（它在等內層），
內層永遠拿不到連線 B（池子空了）。
**它會一直等到 `connectionTimeout` 才失敗** —— 而在那之前那個執行緒是卡住的。

⚠️ **在正式環境上它的形狀是**：

```
池子 20 條 → 20 個並行請求同時走到 REQUIRES_NEW → 20 條全被外層佔住
→ 20 個內層全部在等 → 池子空了 → 第 21 個請求也拿不到連線
→ 整個服務停止回應，而資料庫非常閒
```

📌 **所以 `REQUIRES_NEW` 的使用規則**：

1. **只在真的需要「內層獨立提交」時用**（稽核、通知、重試計數）。
2. **算一下最壞情況的連線需求**：`巢狀層數 × 並行請求數 ≤ 池子大小`。
3. **內層要短** —— 它是在別人拿著連線的時候借的第二條。

### 5.12.3 長交易的四個代價

| # | 代價 | 證據 |
|---|---|---|
| 1 | **佔住連線** | T9-A：4 倍的總耗時 |
| 2 | **持有鎖** | 寫入的列從第一句 SQL 到提交都被鎖著 → 別人排隊（07-mysql 站 04 章） |
| 3 | **undo log / MVCC 版本鏈變長** | 🔴 本章沒驗證；MySQL 的 `History list length` 會爆（07-mysql 站） |
| 4 | **失敗時要重做的變多** | 一個 5 分鐘的交易在第 4 分 59 秒失敗，那 5 分鐘全白費 |

📌 **判準（三條）**：

> **① 交易裡只放資料庫的事。**
> 外部 API、寄信、發訊息、檔案 IO、`Thread.sleep` —— 全部移出去。
>
> **② 交易的長度以「毫秒」為單位思考，不是「秒」。**
> 一個超過 100 ms 的交易值得問一句「它在做什麼」。
>
> **③ 大量寫入用分批提交，並把「能重跑」設計進去。**（5.10.3）

---

## 5.13 ★★ 契約測試：第 15～17 條，以及那一條紅燈

### 5.13.1 先確認一件事：把 `saveAll()` 換成批次之後，舊契約全綠

5.8.7 把 `JdbcOrderRepository.saveAll()` 從 `orders.forEach(this::save)`
換成了真的批次。**跑一次既有的 14 條契約 × 4 個實作**：

```
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.InMemoryOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JdbcClientOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JpaOrderRepositoryContractTest
[INFO] Tests run: 56, Failures: 0, Errors: 0, Skipped: 0
```

**56 個全綠。**

⚠️ **這不是好消息，是壞消息**：
一個「把 N 次 round trip 換成 4 次、順便改寫了樂觀鎖判斷邏輯」的改動，
**14 條契約一條都沒有動靜。**

📌 **04 章 4.11.4 的那句話又出現了**：
**契約測試保證「答案一樣」，不保證「代價一樣」——
而這一次連「答案」的一部分也沒被檢查到。**

**因為既有的 14 條契約裡，沒有一條真正測 `saveAll()` 的邊界行為。**

### 5.13.2 補上第 15～17 條

```java
@Test
void 第15條_saveAll要能同時處理新單與舊單() {
    OrderRepository repo = repository();
    tx(() -> repo.save(anOrder("O-OLD", "C-1", T0)));

    Order old = inTx(() -> repo.findById("O-OLD")).orElseThrow();
    old.cancel();
    Order fresh = anOrder("O-NEW", "C-2", T0.plusSeconds(1));

    tx(() -> repo.saveAll(List.of(old, fresh)));

    assertThat(inTx(() -> repo.findById("O-OLD")).orElseThrow().status())
            .isEqualTo(OrderStatus.CANCELLED);
    assertThat(inTx(() -> repo.findById("O-NEW"))).isPresent();
    assertThat(inTx(() -> repo.findById("O-NEW")).orElseThrow().lines()).hasSize(2);
}

@Test
void 第16條_saveAll裡有一張帶過期version時整組都不可以存進去() {
    OrderRepository repo = repository();
    tx(() -> repo.save(anOrder("O-S1", "C-1", T0)));
    // 有人先改了 O-S1（version 從 0 變 1）
    tx(() -> {
        Order o = repo.findById("O-S1").orElseThrow();
        o.cancel();
        repo.save(o);
    });

    // 我們手上這一份還是 version=0
    Order stale = Order.rehydrate("O-S1", "C-1", OrderStatus.PAID,
            List.of(new OrderLine("P-1", 1, Money.twd(100))), Money.twd(100), T0, 0L);
    Order alsoNew = anOrder("O-S2", "C-1", T0.plusSeconds(1));

    // ⚠️ 順序很重要：把【全新的】那一張放在前面，
    //    這樣「一筆一筆存」的實作就會先把它存進去，然後才失敗
    assertThatThrownBy(() -> tx(() -> repo.saveAll(List.of(alsoNew, stale))))
            .isInstanceOf(OptimisticLockingFailureException.class);

    // ★ 關鍵：那張【全新的】訂單不可以留下來
    assertThat(inTx(() -> repo.findById("O-S2")))
            .as("saveAll 失敗時，同一組裡的其他訂單也不可以被存進去")
            .isEmpty();
    // 而 O-S1 要維持別人改過的樣子
    assertThat(inTx(() -> repo.findById("O-S1")).orElseThrow().status())
            .isEqualTo(OrderStatus.CANCELLED);
}

@Test
void 第17條_saveAll空集合不可以爆() {
    OrderRepository repo = repository();
    tx(() -> repo.saveAll(List.of()));
    assertThat(inTx(() -> repo.countByCustomerId("C-1"))).isZero();
}
```

⚠️ **第 16 條裡那個「順序很重要」的註解，是這一節的關鍵。**

我第一次寫的時候把 `stale` 放在前面 —— **結果 4 個實作全綠**。
因為 `forEach(this::save)` 會**第一筆就失敗**，
根本沒機會把第二筆存進去。**測試沒有測到它想測的東西。**

把順序反過來（新的在前），才真正製造出「部分成功」的情境。

📌 **這是一類很常見的無效測試**：
**斷言寫對了，但輸入沒有讓程式碼走到那條路上。**

### 5.13.3 一條紅燈：記憶體假實作

```
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcClientOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JpaOrderRepositoryContractTest
[ERROR] Tests run: 17, Failures: 1, Errors: 0 <<< FAILURE! -- in lab.InMemoryOrderRepositoryContractTest

[ERROR] InMemoryOrderRepositoryContractTest>OrderRepositoryContract
        .第16條_saveAll裡有一張帶過期version時整組都不可以存進去:269
        [saveAll 失敗時，同一組裡的其他訂單也不可以被存進去]
Expecting an empty Optional but was containing value: example.shop.order.domain.Order@175acfb2
```

🔴 **紅的是【記憶體假實作】，三個真實實作都是綠的。**

**病因**：

```java
// 🔴 InMemoryOrderRepository
@Override
public void saveAll(Collection<Order> orders) { orders.forEach(this::save); }
```

三個真實實作也是（或曾經是）`forEach(this::save)`，**它們為什麼綠**？

📌 **因為它們有交易。** 第二筆失敗 → 交易回滾 → 第一筆也不見了。
**記憶體假實作沒有交易，所以第一筆就留在 map 裡了。**

⚠️ **這比「假實作有 bug」嚴重得多**：

> **假實作騙了你。**
> 用它寫的單元測試會讓你相信「失敗就不會有殘留」，
> **而真實環境靠的是一個假實作根本沒有的機制。**

**這是 00 章練習 3 那個「記憶體假實作全綠，換成真 SQL 才發現沒存下來」的鏡像版本** ——
這一次是**假實作比真實作更寬鬆**。

### 5.13.4 修法：讓假實作自己做原子性

```java
/**
 * ★★ 05 章 5.13：這裡本來是 orders.forEach(this::save)，而契約第 16 條抓到它。
 *
 * <p>問題：真實實作靠<b>資料庫交易</b>得到「全部成功或全部不做」，
 * 而這個假實作<b>沒有交易</b> —— 第 3 張失敗時，前 2 張已經進到 map 裡了。
 *
 * <p>⚠️ 這不是「假實作不夠好」的小瑕疵，是<b>假實作騙了你</b>：
 * 用它寫的單元測試會讓你相信「失敗就不會有殘留」，而真實環境靠的是
 * 一個假實作根本沒有的機制。
 *
 * <p>修法：自己做一次快照，失敗就整個換回去。
 */
@Override
public synchronized void saveAll(Collection<Order> orders) {
    Map<String, Order> snapshot = Map.copyOf(store);
    try {
        orders.forEach(this::save);
    } catch (RuntimeException e) {
        store.clear();
        store.putAll(snapshot);          // ★ 手工回滾
        throw e;
    }
}
```

```
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.InMemoryOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcClientOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JpaOrderRepositoryContractTest
[INFO] Tests run: 68, Failures: 0, Errors: 0, Skipped: 0
```

**68 個全綠。**

⚠️ **但這個修法只是「一個方法內的原子性」。**
如果 Service 是這樣寫的：

```java
@Transactional
public void doTwoThings() {
    orderRepo.saveAll(batchA);
    orderRepo.saveAll(batchB);      // ← 這裡失敗，batchA 不會被回滾
}
```

**記憶體假實作仍然守不住** —— 它不知道「交易」這件事。

📌 **要做到那個層級，假實作必須自己實作一個 `TransactionSynchronization`**：

```java
// 概念：在假實作裡註冊一個回呼，交易回滾時把 store 還原
TransactionSynchronizationManager.registerSynchronization(
        new TransactionSynchronization() {
            @Override public void afterCompletion(int status) {
                if (status == STATUS_ROLLED_BACK) restore(snapshot);
            }
        });
```

⚠️ **值不值得做，是一個取捨**：

| | 不做 | 做 |
|---|---|---|
| 假實作的複雜度 | 低 | ⚠️ 開始長出「迷你資料庫」 |
| 單元測試的可信度 | 🔴 **在交易語意上會騙你** | ✅ 高 |
| 契約測試能覆蓋到 | 單一方法的原子性 | 跨方法的原子性 |

📌 **本課的建議**：
**做到「單一方法的原子性」就好**（上面那個 snapshot 版本），
**跨方法的交易語意交給契約測試在真實實作上驗證**。
理由是 00 章 0.10 那句話 —— **假實作的價值在於「快」，一旦它開始模擬資料庫，兩邊都會輸。**

### 5.13.5 三條新的守門規則

**規則 16：`Stream` 回傳型別必須配 try-with-resources**

```java
@Test
void 規則16_stream查詢必須在try_with_resources裡使用() {
    // ArchUnit 檢查不到「有沒有 close」，所以這一條要靠靜態分析工具
    // （SpotBugs 的 OBL_UNSATISFIED_OBLIGATION / IDE 的 resource leak 檢查）
    // 這裡守的是「介面上有沒有 Stream 回傳型別」——有的話就要人工 review
}
```

⚠️ 🔴 **這一條本章沒有實作成可執行的規則**（ArchUnit 看不到方法內的資源管理）。
列在 5.14。**實務做法是打開編譯器的 `-Xlint:try` 與 IDE 的資源洩漏檢查。**

**規則 17：交易裡不可以有外部呼叫**

```java
ArchRule rule = noClasses()
        .that().areAnnotatedWith(Transactional.class)
        .should().dependOnClassesThat()
        .resideInAnyPackage("..infrastructure.http..", "org.springframework.web.client..")
        .because("交易的長度 = 連線被佔住的長度（5.12.1 實測：4 倍的總耗時）");
```

⚠️ **這條規則只擋得住「同一個類別裡」的呼叫** ——
`@Transactional` 的方法呼叫另一個 Service，那個 Service 再呼叫 HTTP，ArchUnit 看不出來。
**完整的做法需要呼叫圖分析**（ArchUnit 的 `SliceAssignment` 或自己寫）。

**規則 18：`saveAll()` 的 round trip 次數不可以隨筆數線性成長**

```java
@Test
void 規則18_saveAll的round_trip不隨筆數線性成長() {
    int[] trips = new int[2];
    int i = 0;
    for (int n : new int[]{10, 100}) {
        BatchCountingDataSource.reset();
        tx(() -> repo.saveAll(ordersOf(n)));
        trips[i++] = BatchCountingDataSource.roundTrips();
    }
    // 10 倍的資料量，round trip 不可以變 10 倍
    assertThat(trips[1]).isLessThan(trips[0] * 3);
}
```

📌 **這一條的形狀和 04 章規則 14 一樣**：
**判準不是「數字小不小」，是「數字會不會隨資料量長」。**

---

## 5.14 常見誤區

| 誤區 | 實際 | 哪一節 |
|---|---|---|
| 「Repository 加 `@Transactional` 比較安全」 | `REQUIRED` 讓「沒有交易」變成合法狀態 → T1-B | 5.2.2 |
| 「例外拋出來就會回滾」 | 🔴 **checked Exception 預設【提交】** | **5.5.1** |
| 「外層 catch 住內層的例外就沒事了」 | 🔴 `UnexpectedRollbackException`，**外層寫的也不見了** | **5.5.2** |
| 「`readOnly = true` 只是一個提示」 | 它改掉 `FlushMode`、關掉 dirty checking 的寫回 | 5.3.1、5.3.2 |
| 「`readOnly = true` 可以防止寫入」 | 🔴 **明確 `save()` 照樣寫進去** | 5.3.3 |
| 「`readOnly = true` 會把連線設成唯讀」 | 🔴 **不會**（那是 `DataSourceTransactionManager` 的事，而且預設關） | 5.3.4 |
| 「`save()` 就是寫入資料庫」 | `save()` 只是登記；`INSERT` 在 flush 才送出 | 5.4.1 |
| 「我這段只是在查詢，不會寫」 | 🔴 **一個 JPQL 查詢會強迫先 flush，把待寫的 `UPDATE` 送出去** | **5.4.2** |
| 「先 delete 再 save 就不會撞唯一鍵」 | 🔴 **flush 順序是 INSERT 在 DELETE 之前** | **5.4.4** |
| 「`saveAll()` 是批次」 | 它就是一個 `for` 迴圈 | 5.7.1 |
| 「設了 `batch_size` 就有批次了」 | 🔴 **`IDENTITY` 主鍵讓它完全失效，`addBatch` 一次都沒被呼叫** | **5.8.3** |
| 「`batch_size = 1` 先試試看」 | 🔴 **`<= 1` 等於沒開** | 5.8.8 |
| 「`allocationSize = 1` 比較安全」 | 每一筆都多一次取號的 round trip | 5.8.5 |
| 「Hibernate 開了批次，MySQL 就會批次」 | 🔴 **還要 `rewriteBatchedStatements=true`** | 5.8.9 |
| 「`flush()` 就會放掉記憶體」 | 🔴 **`flush()` 送 SQL，`clear()` 才放物件** | **5.9.1** |
| 「`batchUpdate` 是原子的」 | 🔴 **沒有交易時，失敗前後的都留下來了** | **5.10.1** |
| 「批次失敗會停在那一筆」 | 🔴 **H2 繼續跑完了；JDBC 規範允許兩種行為** | 5.10.1 |
| 「`rewriteBatchedStatements` 只是一個效能參數」 | 🔴 **它改變 `executeBatch()` 的【語意】**：回傳值變 `-2`、失敗從部分寫入變全有全無 | **5.8.7b、5.10.1b** |
| 「分批提交只是效能考量」 | 🔴 **它放棄了原子性，必須設計成可重跑** | 5.10.3 |
| 「`Stream<T>` 是串流，不會 OOM」 | 🔴 **20 萬筆 = 情境裡 200,000 個受管實體，和 `findAll()` 一樣** | **5.11.2** |
| 「加 `fetchSize=500` 就會串流」 | 🔴 **MySQL 要 `Integer.MIN_VALUE` 這個魔術值** | 5.11.4 |
| 「`REQUIRES_NEW` 是內層獨立的標準解」 | ⚠️ **它多借一條連線；池子不夠會自我死鎖** | **5.12.2** |
| 「交易大小看做了幾句 SQL」 | 🔴 **看的是時間長度**（4 倍的總耗時差在一句 `sleep`） | 5.12.1 |
| 「記憶體假實作測過了就沒問題」 | 🔴 **它沒有交易，所以它在原子性上會騙你** | **5.13.3** |

---

## 5.15 本章練習

### 練習 1：找出這個匯入功能的七個問題

```java
@Service
public class OrderImportService {

    private final SpringDataOrderRepository repo;
    private final NotificationClient notifier;

    @Transactional
    public void importOrders(MultipartFile csv) throws IOException {
        List<OrderEntity> all = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(csv.getInputStream()))) {
            String line;
            while ((line = r.readLine()) != null) {
                all.add(parse(line));
            }
        }
        repo.saveAll(all);
        notifier.send("匯入完成，共 " + all.size() + " 筆");
    }
}
```

`OrderEntity` 的主鍵是 `@GeneratedValue(strategy = IDENTITY)`，
`application.yml` 裡有 `hibernate.jdbc.batch_size: 50`。CSV 有 40 萬列。

**先自己找，再往下看。**

---

**答案（七個）**：

**① `IDENTITY` 主鍵讓 `batch_size: 50` 完全失效**（5.8.3）

40 萬筆 = **40 萬次 round trip**。設定檔裡那一行是安慰劑。
**修**：改成應用層產生 id，或 `TABLE` 產生器。

**② 整個 CSV 先讀進 `List`**（5.11）

40 萬個 `OrderEntity` 在 `saveAll` 之前就全在記憶體裡了。
**修**：邊讀邊處理，不要先收集。

**③ `saveAll` 之後沒有 `flush + clear`**（5.9）

即使解決了 ①②，40 萬個物件仍然會累積在持久化情境裡（**還要乘以 2，因為有快照**）。
**修**：每 500～1000 筆 `flush()` + `clear()`。

**④ 檔案 IO 在交易裡**（5.12.1）

讀一個大 CSV 可能要幾十秒，而那整段時間都佔著一條連線。
**修**：先解析（交易外），再分批寫入（交易內）。

**⑤ 外部通知在交易裡**（5.12.1）

`notifier.send()` 是網路呼叫。而且更糟：**如果交易在它之後回滾了，通知已經發出去了**
（客戶收到「匯入完成」，而資料庫裡什麼都沒有 —— 05-service 00 章 0.3.2 那個 bug）。
**修**：Outbox，或 `TransactionSynchronization.afterCommit()`。

**⑥ `throws IOException` 而沒有 `rollbackFor`**（5.5.1）

`IOException` 是 checked → **Spring 預設會提交**。
CSV 讀到一半壞掉 → 前面 parse 出來的東西**被寫進去了**。
**修**：`@Transactional(rollbackFor = Exception.class)` 或自訂 `@UseCase`。

**⑦ 一個交易寫 40 萬筆**（5.10.3、5.12.3）

即使前六個都修好，這仍然是一個持續數分鐘的交易：
佔連線、持有鎖、undo log 暴漲，而且**在第 39 萬筆失敗時，前面 39 萬筆全部白做**。
**修**：分批提交 + 冪等（進度表或暫存表）。

⚠️ **注意 ①③⑥ 都是「靜默」的**：不會報錯、不會警告，只是慢或錯。

---

### 練習 2：這段程式碼為什麼偶爾拋 `UnexpectedRollbackException` ★

```java
@Service
public class OrderService {

    @Transactional
    public void placeOrder(PlaceOrderCommand cmd) {
        Order order = Order.place(repo.nextId(), cmd.customerId(), cmd.lines(), cmd.total(), now());
        repo.save(order);

        try {
            auditService.record("ORDER_PLACED", order.id());
        } catch (Exception e) {
            log.warn("稽核寫入失敗，不影響下單", e);        // ← 刻意吞掉
        }
    }
}

@Service
public class AuditService {

    @Transactional                                        // ← 預設 REQUIRED
    public void record(String type, String refId) {
        auditRepo.save(new AuditEntity(UUID.randomUUID().toString(), type + ":" + refId));
    }
}
```

**現象**：99% 的時候正常。偶爾（大約每天兩三次）`placeOrder` 拋出
`UnexpectedRollbackException: Transaction silently rolled back because it has been
marked as rollback-only`，**而訂單沒有建立**。

**問題**：
（a）為什麼是「偶爾」？
（b）為什麼 `catch (Exception e)` 沒有救到它？
（c）三個修法各是什麼，各有什麼代價？

---

**答案**：

**（a）** `auditService.record()` 平常都成功，所以什麼事都沒有。
**偶爾失敗**的原因可能是：稽核表的唯一索引撞到、欄位長度超過、資料庫暫時性錯誤…

**一旦它失敗**：`@Transactional(REQUIRED)` 的內層**參加了外層的交易**，
內層的攔截器發現例外要回滾，但它不是最外層 → **把交易標記為 rollback-only**。

**（b）** 5.5.2 的那一句：

> **`rollback-only` 的標記在【交易】上，不在【例外】上。**

`catch` 抓到的是一個 Java 物件。**把它吞掉不會改變交易的狀態。**
外層跑完之後嘗試提交 → 發現 rollback-only → 回滾 + 拋 `UnexpectedRollbackException`。

⚠️ **最惡毒的部分**：那行 `log.warn("稽核寫入失敗，不影響下單")`
**在日誌裡明確地說了一句假話**。查這個問題的人會看到那行 log，
以為「稽核失敗被正確處理了」，然後去別的地方找原因。

**（c）三個修法**：

| 修法 | 寫法 | 代價 |
|---|---|---|
| **① `REQUIRES_NEW`** | `@Transactional(propagation = REQUIRES_NEW)` 在 `record()` 上 | ⚠️ **多借一條連線**（5.12.2）；稽核在下單**回滾時仍然留著**（可能是對的，也可能不是） |
| **② 不要用例外** | `record()` 改成回傳 `boolean` / `Result`，內部自己 catch | ✅ 最輕；但 `AuditService` 自己的 `@Transactional` 還是會標記 —— **必須連 `@Transactional` 一起拿掉**，或改用 `REQUIRES_NEW` |
| **③ 移出交易** | 用 `TransactionSynchronization.afterCommit()` 在提交後寫稽核 | ✅ 語意最清楚（「訂單成立**之後**才記錄」）；⚠️ 稽核可能遺失（提交後掛掉） |

📌 **哪一個對，取決於一個業務問題**：
**「下單成功但稽核沒寫到」與「稽核寫到但下單失敗」，哪一個比較糟？**

- 稽核是法遵要求（不能漏） → **①**，並且要監控稽核失敗
- 稽核只是方便查問題 → **③**
- 稽核根本不該用例外表達失敗 → **②**

⚠️ **無論選哪一個，那行 `log.warn` 都必須改** ——
它現在說的是「不影響下單」，而在修好之前那是假的。

---

### 練習 3：讓這個匯出不會 OOM，而且可以中斷續跑 ★★

```java
@Transactional(readOnly = true)
public void exportAll(OutputStream out) {
    List<OrderEntity> all = orderRepo.findAll();      // 🔴 300 萬筆
    for (OrderEntity o : all) {
        out.write(toCsvLine(o).getBytes());
        for (OrderLineEntity l : o.getLines()) {      // 🔴 LAZY
            out.write(toCsvLine(l).getBytes());
        }
    }
}
```

**問題**：重寫它，要求
（i）記憶體用量不隨資料量成長，
（ii）SQL 句數不隨資料量成長**得比線性更糟**，
（iii）中斷後可以從斷點續跑，
（iv）匯出期間不會佔住連線超過幾秒。

---

**答案**：

**先數一下原版的問題**：

| 問題 | 說明 |
|---|---|
| 300 萬個受管實體（+ 快照 ≈ 600 萬個物件） | 5.11.2 |
| **N+1**：300 萬次 `SELECT` 抓明細 | 03 章 3.9.4 |
| 一個交易持續數十分鐘 | 5.12.3 |
| 中斷就要全部重來 | 5.10.3 |

**重寫（keyset 分批，每批一個交易）**：

```java
public void exportAll(OutputStream out, String resumeFromId) {
    String lastId = resumeFromId == null ? "" : resumeFromId;
    while (true) {
        // ★ 每一批一個【短】交易；批次之間連線是還回去的
        List<OrderExportRow> chunk = exportPort.nextChunk(lastId, 1000);
        if (chunk.isEmpty()) break;

        for (OrderExportRow row : chunk) out.write(row.toCsv().getBytes());
        out.flush();

        lastId = chunk.get(chunk.size() - 1).orderId();
        progress.save(lastId);                    // ★ (iii) 斷點
    }
}
```

**而 `nextChunk` 用【一句】SQL 把訂單與明細一起撈出來**：

```java
@Transactional(propagation = MANDATORY, readOnly = true)
public List<OrderExportRow> nextChunk(String afterId, int size) {
    return jdbc.query("""
            SELECT o.id, o.customer_id, o.status, o.total_minor, o.created_at,
                   l.line_no, l.product_id, l.quantity, l.unit_price_minor
              FROM orders o
              JOIN order_line l ON l.order_id = o.id
             WHERE o.id > :afterId
               AND o.id <= (SELECT max(id) FROM (
                       SELECT id FROM orders WHERE id > :afterId
                        ORDER BY id FETCH FIRST :size ROWS ONLY) t)
             ORDER BY o.id, l.line_no
            """, params, ROW_MAPPER);
}
```

**逐條對照要求**：

| 要求 | 怎麼滿足 |
|---|---|
| **(i) 記憶體不隨資料量成長** | ✅ 每批 1000 筆；**而且不走 entity**（`OrderExportRow` 是投影，沒有持久化情境） |
| **(ii) SQL 句數** | ✅ **每批 1 句**（子查詢先取這一批的 id 上界，再一次 join 撈明細）→ 總句數 = 筆數 / 1000 |
| **(iii) 中斷續跑** | ✅ `progress.save(lastId)`；重跑時傳 `resumeFromId` |
| **(iv) 不長時間佔連線** | ✅ 每批一個交易，`out.write` 在交易**外面** |

⚠️ **三個容易寫錯的地方**：

1. **`ORDER BY o.id, l.line_no` 不能少** —— 04 章 4.4 的規則。
   而且 keyset 的鍵（`o.id`）必須唯一。
2. **那個「id 上界」的子查詢是必要的** ——
   如果直接寫 `WHERE o.id > :afterId ... FETCH FIRST 1000`，
   `LIMIT` 會算在 **join 之後的列數**上，
   **一張訂單的明細會被切成兩半**（04 章 4.6.6 的同一個問題）。
3. **`out.flush()` 要在交易外** —— 寫 socket 可能很慢（客戶端網路差），
   而那不該佔著連線。

📌 **還有一個更好的做法值得提**：
**如果匯出的資料量真的很大，不要讓它走應用程式。**
`SELECT ... INTO OUTFILE`（MySQL）或 `COPY TO`（PostgreSQL）
讓資料庫直接寫檔案，**快一到兩個數量級**。
⚠️ 代價是檔案在資料庫伺服器上，而且需要額外權限。

---

### 練習 4：寫一條抓得到「批次失效」的守門測試

5.8.3 那個 `IDENTITY` 讓批次失效的問題，**測試全綠、功能正常、只是慢**。

**問題**：寫一條測試，讓它在「有人把某個 entity 的主鍵策略改成 `IDENTITY`」
或「有人忘了設 `batch_size`」時變紅。
要求：**不可以寫死「應該是 1 次 round trip」**（那樣改一下批次大小測試就壞了）。

---

**答案**：

**判準是「成長率」，不是「絕對值」**（和 04 章規則 14 同一個形狀）：

```java
@Test
void 批次寫入的round_trip不可以隨筆數線性成長() {
    int[] trips = new int[2];
    int[] sizes = {20, 200};                       // ★ 10 倍
    for (int i = 0; i < 2; i++) {
        BatchCountingDataSource.reset();
        final int n = sizes[i];
        tx.executeWithoutResult(s -> repo.saveAll(rowsOf(n)));
        trips[i] = BatchCountingDataSource.roundTrips();
    }

    // 10 倍的資料量，round trip 不可以變成 10 倍
    assertThat(trips[1])
            .as("20 筆用了 %d 次 round trip，200 筆用了 %d 次 —— 批次沒有生效",
                    trips[0], trips[1])
            .isLessThan(trips[0] * 3);
}
```

**為什麼是 `* 3` 而不是 `* 1`**：

- `batch_size` 固定時，round trip **本來就會**隨筆數成長（`n / batch_size`）。
- 200 筆 / `batch_size=50` = 4 次；20 筆 = 1 次 → **4 倍**。
  ⚠️ 所以 `* 3` 太緊。**要選一個和 `batch_size` 無關的判準。**

**更好的版本**：直接檢查 `addBatch` 有沒有被呼叫。

```java
@Test
void 批次真的有生效() {
    BatchCountingDataSource.reset();
    tx.executeWithoutResult(s -> repo.saveAll(rowsOf(100)));

    assertThat(BatchCountingDataSource.addBatchCount())
            .as("addBatch 一次都沒有被呼叫 —— 批次完全沒有生效。"
              + "常見原因：① batch_size 沒設或設成 1 ② 主鍵是 IDENTITY（5.8.3）")
            .isGreaterThan(0);

    assertThat(BatchCountingDataSource.roundTrips())
            .as("100 筆的 round trip 應該遠少於 100")
            .isLessThan(20);
}
```

📌 **`addBatch` 的次數是最直接的訊號**：
**它是 0，就代表批次一次都沒有發生** —— 不管你在設定檔裡寫了什麼。

⚠️ **這條測試需要 `BatchCountingDataSource` 這種 JDBC 層的代理。**
**這是本章最重要的工具**：
`SqlSpy`（Hibernate 的 `StatementInspector`）看得到「準備了幾句 SQL」，
**看不到「送出去幾次」** —— 而批次的定義就在後者。

**更完整的版本還要加一條「架構規則」**：

```java
@Test
void 規則_entity的主鍵不可以用IDENTITY() {
    ArchRule rule = noFields()
            .that().areDeclaredInClassesThat().areAnnotatedWith(Entity.class)
            .and().areAnnotatedWith(GeneratedValue.class)
            .should(haveGenerationTypeIdentity())
            .because("IDENTITY 主鍵會讓 hibernate.jdbc.batch_size 完全失效（5.8.3 實測）");
    rule.check(CLASSES);
}
```

⚠️ 🔴 **ArchUnit 讀不到註解的屬性值**（`strategy = IDENTITY`）——
`haveGenerationTypeIdentity()` 要自己寫一個 `ArchCondition`，
從 `JavaAnnotation.get("strategy")` 取值。
**本章沒有實作這一條**，列在 5.16。

---

## 5.16 驗收清單

**交易邊界**

- [ ] 每一個 Repository 都是 `@Transactional(propagation = MANDATORY)`，
      不碰資料庫的方法標了 `SUPPORTS` 並寫明理由。
- [ ] 交易邊界在 Service 的公開方法上，**不在 Controller、不在 Repository**。
- [ ] `spring.jpa.open-in-view=false`。
- [ ] 交易裡**沒有**：HTTP 呼叫、寄信、發訊息、檔案 IO、`Thread.sleep`。
- [ ] 每一個 `REQUIRES_NEW` 都算過「巢狀層數 × 並行數 ≤ 池子大小」。

**回滾**

- [ ] checked exception 也會回滾（`rollbackFor` 或自訂 `@UseCase` 或領域例外都是 `RuntimeException`）。
- [ ] 沒有任何一處「catch 掉內層 `REQUIRED` 交易的例外然後繼續」。
- [ ] 「失敗了也沒關係」的操作**不用例外表達**（回傳 `Result`），或用 `REQUIRES_NEW`。

**批次寫入**

- [ ] `hibernate.jdbc.batch_size` 有設（50～100），`order_inserts` / `order_updates` 開了。
- [ ] **沒有 entity 用 `IDENTITY` 主鍵**（或者你已經確認那張表不需要批次）。
- [ ] MySQL 的 JDBC URL 有 `rewriteBatchedStatements=true`。
- [ ] `SEQUENCE` 的 `allocationSize` 和資料庫序列的 `INCREMENT BY` **一致**。
- [ ] 自己給 id 的 entity 實作了 `Persistable`（省掉每筆一次的 `SELECT`）。
- [ ] 大批次有 `flush()` **加** `clear()`，而且順序是先 flush。
- [ ] 有一條測試斷言 **`addBatch` 的次數 > 0**。

**批次的原子性**

- [ ] 每一個 `batchUpdate` 都在交易裡。
- [ ] 分批提交的流程**設計成可重跑**（進度表 / 暫存表 / 冪等寫入）。
- [ ] 沒有任何程式碼依賴「批次失敗後就停下來了」（那是 driver 相依的）。

**大量讀取**

- [ ] 沒有任何 `findAll()` 用在可能很大的表上。
- [ ] `Stream<T>` 的查詢都在 try-with-resources 裡，而且迴圈內有定期 `clear()`。
- [ ] 匯出 / 批次處理走的是**投影 + keyset 分批**，不是 entity。
- [ ] 有一條測試斷言「持久化情境裡的受管實體數不隨資料量成長」。

**測試**

- [ ] 契約測試涵蓋 `saveAll()` 的三個邊界（混合新舊、部分失敗、空集合）。
- [ ] 記憶體假實作的 `saveAll()` **自己做了原子性**（否則它在這件事上會騙你）。
- [ ] 微基準用的資料庫關掉了查詢結果快取（04 章 4.7.0）。

---

## 5.17 下一章預告

這一章與前面五章的每一個實測，都建立在同一個前提上：**資料庫是 H2。**

而本章已經看到 H2 騙人的兩種方式：

```
=== T2-B2 setEnforceReadOnly(true) ===
  🔴 交易【開不起來】：Syntax error in SQL statement "SET TRANSACTION [*]READ ONLY"
  → 一個在 MySQL 上【有效】的設定，在 H2 上【連跑都跑不起來】

=== T6-A 1 萬筆 INSERT ===
  沒設 batch_size → 337 ms（10,000 次 round trip）
  batch_size=1000 →  48 ms（    10 次 round trip）
  → 1000 倍的 round trip 差距，時間只差 7 倍
  → 因為 H2 在同一個 JVM 裡，一次 round trip 幾乎免費
```

**下一章要處理「怎麼測資料層」，而第一個問題就是**：

| 問題 | 06 章哪一節 |
|---|---|
| `@DataJpaTest` 到底載入了什麼、沒載入什麼 | 6.2 |
| 為什麼 `@DataJpaTest` 的測試**預設會回滾**，以及那件事的代價 | 6.3 |
| ★★ **H2 會騙你的十四件事**（本課前五章累積下來的清單，逐項實測） | **6.4** |
| Testcontainers 跑真 MySQL：怎麼設、怎麼快 | 6.5 |
| ★ **同一組測試在 H2 與 MySQL 上跑，有幾條會不一樣** | **6.6** |
| 測試資料怎麼準備（`@Sql` / builder / `TestEntityManager`） | 6.7 |
| 測試之間怎麼清乾淨（回滾 vs truncate vs 重建） | 6.8 |
| ★ CI 從 4 分鐘變 47 分鐘：Spring 的 context 快取 | 6.9 |

⚠️ **06 章的第一個實測會直接回答一個累積了五章的問題**：

00～05 章一共標了 **20 多項「本章沒有驗證到的」**，
而它們幾乎全部指向同一句話：**「因為本機沒有 MySQL」。**

**06 章會把其中可以用 Testcontainers 驗證的部分補完**，
並對每一項給出明確的答案：**H2 上的結論是對的、錯的、還是「根本測不到」。**

📌 **而 5.17 這一節本身就是一個例子**：
`setEnforceReadOnly(true)` 在 H2 上**連跑都跑不起來**，
所以本章對它的所有說明**都是根據文件寫的，不是實測的**。
**06 章在真的 MySQL 上把它跑起來了 —— 結果是「語法支援，而且真的擋住 `UPDATE`」。**

⚠️ **而 06 章也找到了一個本章【講錯】的地方**：
5.8.7 那段 `saveAll()` 的樂觀鎖判斷，
**在 MySQL + `rewriteBatchedStatements=true` 下會靜默失效**（5.8.7b 已補上修正）。
📌 **那個 bug 是「只用 H2 測」永遠找不到的** —— 這就是 06 章存在的理由。

---

## 5.18 本章的實驗環境與結果

**環境**（與 04 章相同）：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5** |
| Spring Data JPA | **3.2.5** |
| Hibernate | **6.4.4.Final** |
| QueryDSL | 5.0.0（jakarta） |
| 連線池 | **HikariCP 5.0.1** |
| 資料庫 | **H2 2.2.224**（量測用的連線加 `QUERY_CACHE_SIZE=0`） |
| ArchUnit | **1.3.0** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（9 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **T1** | 交易邊界 | ✅ **一個交易 → 失敗時 0 張留下；兩個交易 → 2 張都留下**<br>✅ `MANDATORY` 讓「沒有交易就呼叫 Repository」立刻拋 `IllegalTransactionStateException`（讀寫方法都擋）；`nextId()` 用 `SUPPORTS` 放行 |
| **T2** | `readOnly = true` | ✅ `FlushMode`：**`AUTO` → `COMMIT`**<br>✅ dirty checking：讀寫交易 **1 句 `UPDATE`**，唯讀交易 **0 句**<br>🔴 **`connection.isReadOnly()` 兩邊都是 `false`**（`JpaTransactionManager` 不設它）<br>🔴 **唯讀交易裡明確 `save()` + `flush()` 照樣寫進去**<br>🔴 **`setEnforceReadOnly(true)` 在 H2 上讓交易開不起來**（`SET TRANSACTION READ ONLY` 語法錯誤） |
| **T3** | flush 時機 | ✅ `save()` 回來時 `INSERT` **還沒送出**（送出的是 2 句白跑的 `SELECT`）<br>✅ **一個 JPQL `count` 查詢強迫先 flush**，把 `UPDATE` 插在它前面<br>✅ **`findById()` 不觸發 flush**<br>🔴 **`replaceLines()` 不呼叫 `save()` → `DuplicateKeyException`（同一主鍵兩個實例）**；加上 `save()`（`merge`）就正常，實際 SQL 是 **1 `UPDATE` + 1 `DELETE`** |
| **T4** | 回滾規則 | ✅ `RuntimeException` → 回滾（0 列）<br>🔴 **checked Exception → 【提交】（1 列）**<br>🔴 **內層 `REQUIRED` 失敗 + 外層 catch → `UnexpectedRollbackException`，外層寫的也不見了**<br>✅ 改成 `REQUIRES_NEW` → 外層那筆留下（1 列） |
| **T5** | ★★ 主鍵策略與批次 | **`batch_size` 沒設 / 設 20 的句數對照**：<br>`IDENTITY` **20 → 20（完全沒變）**；`SEQUENCE` 22 → 3；自己給 id 40 → 21；**+`Persistable` 20 → 1**<br>**JDBC 層 round trip**：`Persistable` **20 → 1**；🔴 **`IDENTITY` 20 → 20，`addBatch` 一次都沒被呼叫** |
| **T6** | 1 萬筆的批次 | `batch_size` **沒設 337 ms / 1：176 ms（`addBatch=0`）/ 20：117 ms / 50：79 ms / 100：68 ms / 500：66 ms / 1000：48 ms**<br>round trip **10,000 → 10**<br>✅ **只 `flush()` 不 `clear()` → 情境裡仍有 10,000 個受管實體**；`flush+clear` → **0**<br>對照：純 `JdbcTemplate.batchUpdate` 每批 500 → **19 ms** |
| **T7** | 批次 ≠ 交易 | 🔴 **沒有交易：10 筆裡 9 筆成功**（`updateCounts = [1,1,1,1,-3,1,1,1,1,1]`），**H2 在失敗後繼續跑完**<br>✅ 包在交易裡 → 整組回滾（只剩原本那 1 列）<br>🔴 **分批提交：第 3 批失敗，前 2 批（20 筆）已提交** |
| **T8** | ★★ 讀 20 萬筆 | **受管實體上限**：`findAll()` **200,000**／`Stream` 不 clear **200,000**／`Stream`+clear **1,000**／keyset 分批 **1,000**／JDBC callback **1**<br>**時間**：435 / 489 / **119** / 291 / **46** ms |
| **T9** | 交易大小 | 🔴 **交易裡放 600 ms 的外部呼叫：12 個請求 / 3 條連線 = 2,429 ms**<br>✅ 移出交易 → **606 ms（快 4 倍）**<br>🔴 **池子 1 條連線 + `REQUIRES_NEW` → `CannotCreateTransactionException`（自我死鎖）** |
| **契約** | **17 條 × 4 個實作** | 🔴 **第一次執行：記憶體假實作第 16 條紅**（`saveAll` 部分成功了）<br>→ 讓假實作自己做 snapshot 回滾後 **68 個全綠**<br>⚠️ 而**把 `saveAll()` 改成真批次時，舊的 14 條契約一條都沒紅** |

```
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.InMemoryOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JdbcClientOrderRepositoryContractTest
[INFO] Tests run: 17, Failures: 0, Errors: 0 -- in lab.JpaOrderRepositoryContractTest
[INFO] Tests run: 193, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
```

**本章的驗證專案：9 組實驗 + 68 條契約（17 × 4），連同 00～04 章的既有測試共 193 個，全綠。**

⚠️ **過程中修掉了三個「實驗自己的 bug」，三個都值得記錄**：

1. **JDBC 動態代理沒有拆 `InvocationTargetException`** →
   `SQLException` 被包成 `UndeclaredThrowableException`，
   **Spring 的例外翻譯完全失效**，T7 一開始報的是一個和資料庫毫無關係的例外型別。
   ```java
   } catch (java.lang.reflect.InvocationTargetException e) {
       throw e.getCause();   // ⚠️ 不拆就會變成 UndeclaredThrowableException
   }
   ```
2. **契約第 16 條一開始把「過期的那一張」放在清單前面** →
   `forEach(this::save)` 第一筆就失敗，**根本沒走到要測的路徑上，四個實作全綠**。
   把順序反過來才抓到 bug。
3. 🔴 **新增的批次 entity 放在 `..infrastructure.batch..`，觸發了 03 章的 ArchUnit 規則 9**
   （`@Entity` 這個註解的簡單名稱就是 `Entity`，所以「jpa 套件外不可以有 `*Entity`」
   連帶擋住了「jpa 套件外不可以有 `@Entity` 標記的類別」）。
   移到 `..infrastructure.jpa.batch..` 才綠。
   📌 **這是連續第二章「守門規則擋住的是作者自己」**（04 章也發生過一次）。

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一站會補 |
|---|---|---|
| ~~`rewriteBatchedStatements=true` 的副作用~~ | 5.8.9 | ✅ **06 章 6.4 已補：`executeBatch()` 回傳 `[-2,-2,-2,-2,-2]`（`SUCCESS_NO_INFO`）—— 5.8.7 那段判斷【真的會壞掉】** |
| **MySQL 上 round trip 的真實成本**（本章的 7 倍在 MySQL 上應該是幾十倍） | 5.8.8 | **06 章、07-mysql 站** |
| ~~MySQL 的 `executeBatch()` 在失敗後會不會繼續~~ | 5.10.1 | ⚠️ **06 章 6.4 已補，而答案分兩種**：沒開 `rewriteBatchedStatements` 時和 H2 一樣繼續（`[1,1,-3,1,1]`）；<br>🔴 **開了之後整批不進去**（`[-3,…]`）→ 已補 **5.10.1b** |
| ~~`SUCCESS_NO_INFO`（-2）對 5.8.7 那段判斷邏輯的影響~~ | 5.8.7 | ✅ **06 章 6.4 已補 —— 見下方的 🔴 修正** |
| ~~`setEnforceReadOnly(true)` 在 MySQL 上的行為~~ | 5.3.4 | ✅ **06 章 6.4 已補：`SET TRANSACTION READ ONLY` 語法支援，而且【真的擋住 `UPDATE`】** |
| MySQL 的 `Stream` 串流三條件 | 5.11.4 | ⚠️ **06 章 6.4 部分驗證**：`fetchSize=Integer.MIN_VALUE` 可以跑；「連線獨佔」與大資料量的記憶體行為仍未量測 |
| 持久化情境「快照」的實際記憶體大小 | 5.9.3 | —— |
| Open Session In View 開/關的完整請求流程差異 | 5.6.2 | —— |
| `IDENTITY` 的 `AUTO_INCREMENT` 鎖在高併發下的成本 | 5.8.4 | 07-mysql 站 |
| 隨機 UUID 當 InnoDB 主鍵的寫入放大 | 5.8.4 | 07-mysql 站 02 章 |
| 長交易對 undo log / `History list length` 的影響 | 5.12.3 | 07-mysql 站 04 章 |
| ArchUnit 檢查 `@GeneratedValue(strategy = ...)` 的屬性值 | 練習 4 | —— |
| `Stream` 沒有 close 的靜態分析規則 | 5.13.5 | —— |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果與直覺相反**，而它們指向同一件事：
>
> **① 拋了例外，資料被提交了**（5.5.1）——
> checked exception 的預設是 commit。
>
> **② 外層 catch 住了例外，外層自己寫的東西不見了**（5.5.2）——
> `rollback-only` 的標記在交易上，不在例外上。
>
> **③ 設了 `batch_size`，`addBatch` 一次都沒被呼叫**（5.8.3）——
> `IDENTITY` 主鍵讓批次完全失效，而且沒有任何警告。
>
> **④ 用了 `Stream`，記憶體裡還是 200,000 個物件**（5.11.2）——
> 它串流了 `ResultSet`，沒有串流持久化情境。
>
> ⚠️ **四個的共同形狀**：
> **框架的名字說了一件事，它做的是另一件事。**
>
> `@Transactional` 說「這是一個交易」——它沒說「哪些例外會回滾」。
> `batch_size` 說「批次大小」——它沒說「什麼情況下批次不會發生」。
> `saveAll` 說「存全部」——它沒說「一次存」。
> `Stream` 說「串流」——它沒說「串流的是哪一層」。
>
> 📌 **所以這一章的三個工具，每一個都是在「量框架真正做了什麼」**：
>
> ```java
> // ① 送出去幾次（不是「準備了幾句」）—— 本章最重要的一個工具
> case "addBatch"      -> ADD_BATCH.incrementAndGet();
> case "executeBatch"  -> EXEC_BATCH.incrementAndGet();
> case "executeUpdate" -> EXEC_UPDATE.incrementAndGet();
>
> // ② 持久化情境裡有幾個物件 —— 「會不會 OOM」的唯一可信指標
> ((SessionImpl) em.unwrap(Session.class))
>         .getPersistenceContextInternal().getNumberOfManagedEntities();
>
> // ③ 交易到底有沒有回滾 —— 不要問例外，去數資料庫裡的列
> jdbc.queryForObject("SELECT count(*) FROM …", Integer.class);
> ```
>
> **而三個裡面最重要的是第 ①**：
> **5.8.3 那個「`IDENTITY` 讓批次完全失效」的發現，
> 靠讀設定檔、讀 Hibernate 日誌、量時間【都看不出來】——
> 只有 `addBatch` 那個計數器會直接告訴你「它是 0」。**
