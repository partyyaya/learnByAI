# 第 04 章：分頁、排序與動態查詢

> 03 章的查詢都是**固定形狀**的：條件寫死在方法名或 JPQL 裡。
> 這一章要處理兩件「在測試機好好的、上線才痛」的事。
>
> **第一件**：條件是動態的 —— 使用者填了哪幾格，你事先不知道。
>
> ```java
> public PageResult<OrderSummaryView> search(String customerId,   // 可能沒填
>                                            OrderStatus status,  // 可能沒填
>                                            Instant from,        // 可能沒填
>                                            Instant to,          // 可能沒填
>                                            PageSpec spec) { … }
> ```
>
> **第二件**：這一句在第 1 頁是 26 µs，在第 5,000 頁是 2,491 µs。
>
> ```sql
> SELECT id, created_at FROM orders ORDER BY created_at, id
>  OFFSET 99980 ROWS FETCH FIRST 20 ROWS ONLY;
> ```
>
> ---
>
> ⚠️ **但這一章真正想讓你記住的，不是「深分頁很慢」——那件事你大概已經聽過了。**
> **是下面這個結果**：
>
> ```
> === P3-A 排序鍵不唯一：一個人單機、沒有併發、把三頁翻完 ===
>      第 0 頁 → [O-07, O-10, O-09, O-12, O-11]
>      第 1 頁 → [O-11, O-01, O-02, O-06, O-04]
>      第 2 頁 → [O-05, O-03]
>      三頁共 12 筆，去重後 11 筆 → 🔴 有重複或遺漏
> ```
>
> 🔴 **12 筆資料，一個人、單機、沒有任何併發、把三頁翻完 ——
> `O-11` 出現了兩次，`O-08` 一次都沒出現。**
>
> **而每一頁單獨看都是對的。**
> 每一頁的筆數對、排序對、`ORDER BY created_at` 也確實被遵守了。
> **只有把三頁「合起來看」的時候，才會發現少了一張訂單。**
>
> 📌 **這是本章的形狀**：分頁的每一個 bug 都長這樣 ——
> **單頁正確、單次正確、測試綠燈，錯誤只出現在「合起來」與「量變大」之後。**
>
> ---
>
> **這一章要回答六個問題**：
>
> | # | 問題 | 哪一節 |
> |---|---|---|
> | 1 | `List` / `Slice` / `Page` 該回哪一個？那句 `COUNT` 值多少錢？ | 4.2、4.9 |
> | 2 | ★ 上面那個「12 筆看到 11 筆」到底怎麼發生的？ | **4.4** |
> | 3 | 排序欄位來自 HTTP 查詢參數 —— 它安全嗎？ | **4.5** |
> | 4 | 動態條件：`Specification`、QueryDSL、還是自己拼 SQL？ | **4.6** |
> | 5 | 深分頁為什麼慢，keyset 分頁怎麼寫，Spring Data 內建的能用嗎？ | **4.7** |
> | 6 | `JOIN FETCH` + 分頁為什麼會在記憶體裡分頁，而且只印一行警告？ | **4.8** |
>
> 📌 **第 5 題的答案有一個意外**：
> Spring Data 3.1 內建了 keyset 分頁（`ScrollPosition.keyset()`），
> 結果**完全正確、不重不漏** ——
> **而它產生的 SQL 在 10 萬筆的深位置上掃了 100,001 列，
> 手寫的那一句只掃 21 列。**（4.7.6 實測）

---

## 4.1 學習目標

完成本章後，你應該可以：

- 說出 `List<T>` / `Slice<T>` / `Page<T>` 三種回傳型別**各送出幾句 SQL、各知道什麼**，
  並說明 `Page` 在**哪兩種情況下不會發那句 `COUNT`**。
- 用一個**沒有併發**的實測，說明「排序鍵不唯一」為什麼會讓翻頁**重複與遺漏**，
  並寫出兩種修法（tie-breaker 與 keyset）。
- 說出 `?sort=` 這個 HTTP 參數會走過哪幾道檢查 ——
  以及**哪一條路上完全沒有檢查**（答案是原生 SQL + `Pageable`）。
- 在 `Specification`、QueryDSL、手寫 SQL 三者之間做選擇，並說出每一種**買到什麼、賣掉什麼**。
- 解釋為什麼「join 到明細的 `Specification` + 分頁」會讓**5 張訂單只看到 2 張**，
  並用三種修法各修一次。
- 說明 `OFFSET` 深分頁為什麼慢（用「掃過幾列」而不是「感覺很慢」來說明），
  寫出 keyset 分頁的**三種寫法**，並說出**哪兩種走得到索引**。
- 判斷 `JOIN FETCH` / `@EntityGraph` / `@BatchSize` / 兩階段查詢在**有分頁**時各適合什麼場合。
- 設計一組**不外流 Spring Data 型別**的分頁介面，並用 ArchUnit 把它守起來。

---

## 4.2 ★ 三種回傳型別：`List` / `Slice` / `Page`

同一個查詢、同一個 `Pageable`，只改**回傳型別**：

```java
public interface OrderPageRepository extends JpaRepository<OrderEntity, String> {

    List<OrderEntity>  findListByStatus(OrderStatus status, Pageable pageable);
    Slice<OrderEntity> findSliceByStatus(OrderStatus status, Pageable pageable);
    Page<OrderEntity>  findPageByStatus(OrderStatus status, Pageable pageable);
}
```

**三個方法的名字只差一個詞，行為差很多。**

### 4.2.1 實測：各送出幾句 SQL、各知道什麼

**實驗 P1**（40 張訂單，其中 10 張 `PENDING_PAYMENT`，每頁 3 筆）：

```
=== P1-A List<T>：只要那一頁，什麼都不多問 ===
  List → 1 句 SQL
      [1] select oe1_0.id,oe1_0.created_at,… from orders oe1_0
          where oe1_0.status=? order by oe1_0.created_at
          offset ? rows fetch first ? rows only
  拿到 3 筆；還有沒有下一頁？→ 不知道

=== P1-B Slice<T>：多抓一筆，用來判斷「有沒有下一頁」 ===
  Slice → 1 句 SQL
      [1] select … offset ? rows fetch first ? rows only
  拿到 3 筆；hasNext=true；總筆數？→ 沒有這個方法

=== P1-C Page<T>：多送一句 COUNT ===
  Page → 2 句 SQL
      [1] select … offset ? rows fetch first ? rows only
      [2] select count(oe1_0.id) from orders oe1_0 where oe1_0.status=?
  拿到 3 筆；totalElements=10；totalPages=4；hasNext=true
```

**三件事**：

| 回傳型別 | SQL 句數 | 抓幾筆 | 你能問它什麼 |
|---|---|---|---|
| `List<T>` | **1** | 剛好 `size` | 只有內容 |
| `Slice<T>` | **1** | **`size + 1`** | 內容、`hasNext()` |
| `Page<T>` | **2** | 剛好 `size` | 內容、`hasNext()`、`getTotalElements()`、`getTotalPages()` |

⚠️ **`Slice` 那個「`size + 1`」是關鍵**：
它抓 4 筆、只給你 3 筆，**用第 4 筆的存在來回答「有沒有下一頁」**。
所以它知道 `hasNext`，卻**永遠不知道總數** —— 這是一筆很划算的交易。

### 4.2.2 ★ `Page` 在最後一頁不發 `COUNT`

`Page` 一定多一句 `COUNT` 嗎？**不是。**

**實驗 P1-D**（10 筆 `PENDING_PAYMENT`，每頁 3 筆，走完 4 頁）：

```
=== P1-D ★ Page 在【最後一頁】會不會發 COUNT ===
  第 0 頁：拿到 3 筆，共 2 句 SQL（COUNT 1 句），total=10
  第 1 頁：拿到 3 筆，共 2 句 SQL（COUNT 1 句），total=10
  第 2 頁：拿到 3 筆，共 2 句 SQL（COUNT 1 句），total=10
  第 3 頁：拿到 1 筆，共 1 句 SQL（COUNT 0 句），total=10
```

**第 3 頁只有 1 句 SQL，而 `total` 還是 10 —— 它是算出來的。**

負責這件事的是 `PageableExecutionUtils`：

```java
// 概念上做的事（Spring Data Commons）
if (content.size() < pageable.getPageSize()) {
    // 這一頁沒滿 → 它就是最後一頁 → total = offset + content.size()
    total = pageable.getOffset() + content.size();       // 9 + 1 = 10
} else {
    total = countSupplier.get();                          // 才真的發 COUNT
}
```

同一個機制也會在**空結果**上省掉 `COUNT`：

```
=== P1-E 空結果的 Page 與 Slice ===
  Page（沒有任何 REFUNDED） → 1 句 SQL
      [1] select … from orders oe1_0 where oe1_0.status=?
          offset ? rows fetch first ? rows only
  content=0, total=0, totalPages=0, isEmpty=true
```

📌 **所以「`Page` 一定會多一句 `COUNT`」是錯的，正確的說法是**：

> **只有「這一頁滿了」的時候才發 `COUNT`。**
> 而那正是**大部分**的請求 —— 第 1 頁通常都是滿的。

### 4.2.3 那句 `COUNT` 值多少錢

**實驗 P5-D**（10 萬筆，H2 2.2.224，`QUERY_CACHE_SIZE=0`）：

```
=== P5-D Page<T> 那一句 COUNT 的成本（10 萬筆） ===
  SELECT count(*) FROM orders                        →    42 µs  掃過（H2 沒報 scanCount）
  SELECT count(*) FROM orders WHERE status = 'PAID'  → 3,985 µs  掃過 100001
  SELECT count(*) FROM orders WHERE created_at > …   → 5,172 µs  掃過 100001
  ★ 沒有條件的 count(*)：H2 直接讀統計值。有條件的 count：一列都躲不掉
```

**差 95 倍**，而且差別不在「快或慢」，在**掃描的列數會不會隨資料成長**：

| 查詢 | 掃過幾列 | 資料變 10 倍時 |
|---|---|---|
| `count(*)` 沒有條件 | 讀統計值 | **不變** |
| `count(*)` **有** `WHERE` | 100,001 | **變 10 倍** |

⚠️ **而分頁的 `COUNT` 幾乎一定有 `WHERE`** —— 使用者就是在搜尋。

📌 **所以 `Page<T>` 的真正代價不是「多一句 SQL」，是**：

> **每一次搜尋，都要把符合條件的每一列數過一遍 ——
> 只為了在畫面右上角印一個「共 132,847 筆」。**

### 4.2.4 決策表

| 情境 | 選什麼 | 為什麼 |
|---|---|---|
| App 無限往下滑 | **keyset**（4.7） | 連 `OFFSET` 都不要 |
| 「上一頁 / 下一頁」按鈕 | **`Slice`** | 1 句 SQL 就知道 `hasNext` |
| 後台要「跳到第 37 頁」 | **`Page`** | 沒有總數就畫不出頁碼列 |
| 匯出、批次處理 | **keyset 或串流**（05 章） | 不該有「頁」的概念 |
| 內部呼叫、資料量確定很小 | **`List`** | 最省 |

⚠️ **最常見的錯誤是「反正 `Page` 資訊最多，就一律用 `Page`」** ——
等於為了那個沒人看的總筆數，讓每一次搜尋都掃全表一遍。

---

## 4.3 `Pageable` 的真面目

### 4.3.1 三個欄位與 `offset` 的算法

`Pageable` 只帶三件事：**第幾頁、每頁幾筆、怎麼排**。

**實驗 P2-A**：

```
=== P2-A PageRequest 的三個欄位與 offset ===
  PageRequest.of(0, 20) → pageNumber=0, pageSize=20, offset=0
  PageRequest.of(1, 20) → pageNumber=1, pageSize=20, offset=20
  PageRequest.of(2, 20) → pageNumber=2, pageSize=20, offset=40
  PageRequest.of(5000, 20) → pageNumber=5000, pageSize=20, offset=100000
  ★ pageNumber 是【第幾頁，從 0 算】，不是 offset。前端傳 1 當第一頁 → 直接跳過第一頁
```

`offset = pageNumber × pageSize`，就這一行。

⚠️ **「從 0 算」是一個真實的錯誤來源**：
大部分前端函式庫的第一頁是 `1`。
前端傳 `page=1` 想要第一頁，後端給的是**第二頁** ——
使用者看到列表少了最前面 20 筆，而且**不會有任何錯誤**。

4.3.4 會講怎麼在 Web 層一次解決它。

### 4.3.2 不合法的參數在哪裡爆（以及哪些不爆）

**實驗 P2-B**：

```
=== P2-B 不合法的參數在哪裡爆 ===
  of(-1, 20) → IllegalArgumentException: Page index must not be less than zero
  of(0, 0) → IllegalArgumentException: Page size must not be less than one
  of(0, -5) → IllegalArgumentException: Page size must not be less than one
  of(0, 2_000_000) → pageSize=2000000（★ 沒有上限，Pageable 自己不管這件事）
```

📌 **`PageRequest` 擋掉了「負數」與「零」，但【沒有上限】。**

`PageRequest.of(0, 2_000_000)` 是完全合法的 —— 它會產生

```sql
… OFFSET 0 ROWS FETCH FIRST 2000000 ROWS ONLY
```

**兩百萬列進記憶體。** 這件事 `Pageable` 不管，
所以**必須有人管** —— 4.5.6 會說明那個「人」該是哪一層。

### 4.3.3 `Sort` 變成 `ORDER BY` 的哪一段

**實驗 P2-C**（同一個 JPQL，只換 `Sort`）：

```java
@Query("SELECT o FROM OrderEntity o WHERE o.customerId = :cid")
List<OrderEntity> jpqlWithSort(@Param("cid") String customerId, Sort sort);
```

```
=== P2-C 同一個查詢，七種 Sort 產生的 ORDER BY ===
  Sort.by("createdAt")                   → order by oe1_0.created_at
  Sort.by("createdAt").descending()      → order by oe1_0.created_at desc
  兩個鍵：createdAt DESC, id ASC          → order by oe1_0.created_at desc,oe1_0.id
  nullsLast()                            → order by oe1_0.created_at desc
  nullsFirst()                           → order by oe1_0.created_at
  ignoreCase()                           → order by lower(oe1_0.customer_id)
  Sort.unsorted()                        → （SQL 裡沒有 ORDER BY）
```

四件事：

1. **屬性名會被翻成欄位名**（`createdAt` → `created_at`）—— 所以你寫的是**屬性**，不是欄位。
2. **`ignoreCase()` 變成 `lower(...)`** —— ⚠️ 這一句話會讓索引失效（除非你有函數索引）。
3. **`unsorted()` 就真的沒有 `ORDER BY`** —— 而那是 4.4 那個 bug 的溫床。
4. 🔴 **`nullsLast()` 與 `nullsFirst()` 產生的 SQL 完全一樣，而且都沒有 `nulls` 字樣。**

第 4 點值得單獨一節。

### 4.3.4 ★ `nullsLast()` 被靜默忽略了

上面那組實驗的排序鍵是 `createdAt`，而它是 `nullable = false` ——
會不會是 Hibernate「聰明地」發現這個欄位不可能是 `NULL`，所以把 `NULLS LAST` 優化掉了？

**那就換一個真的可以是 `NULL` 的欄位來測。**

```java
@Entity
@Table(name = "shipment")
public class ShipmentEntity {
    @Id private String id;
    @Column(name = "order_id", nullable = false) private String orderId;
    @Column(name = "shipped_at") private Instant shippedAt;   // ★ 可以是 NULL：還沒出貨
    // …
}

public interface ShipmentRepository extends JpaRepository<ShipmentEntity, String> {
    List<ShipmentEntity> findByOrderId(String orderId, Sort sort);
}
```

三筆資料：`S-1`（已出貨）、`S-2`（**還沒出貨，`shipped_at` 是 `NULL`**）、`S-3`（已出貨，較晚）。

**實驗 P2-C2**：

```
=== P2-C2 ★ 同一組 nullsLast()，換成【真的可以是 NULL】的欄位 ===
  Sort.by("shippedAt")（不指定 NULL 位置）        → order by se1_0.shipped_at
                                                 結果順序：[S-2, S-1, S-3]
  Sort.Order.asc("shippedAt").nullsLast()      → order by se1_0.shipped_at
                                                 結果順序：[S-2, S-1, S-3]
  Sort.Order.asc("shippedAt").nullsFirst()     → order by se1_0.shipped_at
                                                 結果順序：[S-2, S-1, S-3]
```

🔴 **三種寫法產生【完全相同】的 SQL，結果也【完全相同】。**
`nullsLast()` 什麼都沒做。

**為什麼**：`Sort.NullHandling` 是 Spring Data **Commons** 的概念，
而 **Spring Data JPA 模組沒有實作它**（JPQL 標準本身也沒有 `NULLS FIRST/LAST`）。
它不會報錯、不會警告，就是**靜默忽略**。

那 `NULL` 到底排在哪裡？**看資料庫**。

**實驗 P2-E**（純 SQL，H2 2.2.224）：

```
=== P2-E NULL 排在哪一邊（H2 2.2.224 的預設） ===
  ORDER BY shipped_at ASC  → [2, 4, 1, 3]      ← id 2、4 是 NULL：排在最前面
  ORDER BY shipped_at DESC → [3, 1, 2, 4]      ← NULL 排在最後面
  ORDER BY shipped_at ASC NULLS LAST  → [1, 3, 2, 4]
  ★ 這是【方言】：不寫 NULLS FIRST/LAST，換一個資料庫答案就可能不一樣
```

| 資料庫 | `ORDER BY x ASC` 時 `NULL` 在哪 |
|---|---|
| **H2 2.2.224** | 最前面（實測） |
| **MySQL 8** | 最前面（🔴 本章沒驗證，07-mysql 站補） |
| **PostgreSQL** | 最後面（🔴 本章沒驗證） |
| **Oracle** | 最後面（🔴 本章沒驗證） |

📌 **結論（三條）**：

1. **可以是 `NULL` 的欄位，不要交給 `Sort` 排。**
2. 真的要排，就**自己在 JPQL / SQL 裡寫 `NULLS LAST`**，或者
   **排一個「排序用的替身」**（例如 `COALESCE(shipped_at, '9999-12-31')`，
   或直接在表上多一個 `is_shipped` 欄位並建索引）。
3. ⚠️ **這一條是本章第一個「靜默失效」**。
   本章後面還有三個，形狀都一樣：
   **你寫了一個修正，它編譯過、測試綠、而它什麼都沒做。**

### 4.3.5 `unpaged()` 與 `Limit`

```
=== P2-D Pageable.unpaged() 與 Sort 一起用 ===
  unpaged() → 1 句 SQL
      [1] select … from orders oe1_0 where oe1_0.status=?
  unpaged(Sort) → 1 句 SQL
      [1] select … from orders oe1_0 where oe1_0.status=? order by oe1_0.created_at desc
```

`Pageable.unpaged()` = **沒有 `LIMIT`**，整組撈回來。
`Pageable.unpaged(Sort)`（Spring Data 3.2 新增）可以只要排序、不要分頁。

⚠️ **`unpaged()` 出現在正式環境的程式碼裡，幾乎都是一個未爆彈**：
它今天回 200 筆，明年回 200 萬筆，而**程式碼一行都沒改**。

只要排序、不要總數、要限筆數，用 **`Limit`**（03 章 3.4 用過）：

```java
List<OrderEntity> findByStatusOrderByCreatedAtAsc(OrderStatus status, Limit limit);
```

---

## 4.4 ★★ 排序鍵不唯一：一個沒有併發的資料遺失

這一節只有 12 筆資料、一個執行緒、一台機器。

### 4.4.1 實測：12 筆資料，翻三頁只看到 11 筆

**資料**：12 張訂單，**`created_at` 全部相同**（同一秒下的單 —— 促銷開賣時很常見）。

**查詢**：`ORDER BY created_at`，每頁 5 筆，翻三頁。

```java
private List<String> page(JdbcTemplate jdbc, String orderBy, int offset, int size) {
    return jdbc.queryForList("SELECT id FROM orders ORDER BY " + orderBy
            + " OFFSET " + offset + " ROWS FETCH FIRST " + size + " ROWS ONLY", String.class);
}
```

先確認**同一頁是穩定的**：

```
=== P3-A0 同一句查詢、同一份資料，連跑三次 ===
  SQL：SELECT id FROM orders ORDER BY created_at OFFSET 0 ROWS FETCH FIRST 5 ROWS ONLY
  計畫：SELECT "ID" FROM "PUBLIC"."ORDERS" /* PUBLIC.ORDERS.tableScan */ ORDER BY "CREATED_AT"
    第 1 次 → [O-07, O-10, O-09, O-12, O-11]
    第 2 次 → [O-07, O-10, O-09, O-12, O-11]
    第 3 次 → [O-07, O-10, O-09, O-12, O-11]
  ★ 12 筆資料的 created_at 完全相同，所以【任何 5 筆】都符合 ORDER BY created_at
```

**同一頁跑三次，三次一樣。** 看起來很穩。

現在把三頁翻完：

```
=== P3-A 排序鍵不唯一：一個人單機、沒有併發、把三頁翻完 ===
     第 0 頁 → [O-07, O-10, O-09, O-12, O-11]
     第 1 頁 → [O-11, O-01, O-02, O-06, O-04]
     第 2 頁 → [O-05, O-03]
     三頁共 12 筆，去重後 11 筆 → 🔴 有重複或遺漏
```

🔴 **`O-11` 出現在第 0 頁的最後，也出現在第 1 頁的第一個。**
🔴 **而 `O-08` 三頁都沒有出現。**

**使用者看到的是**：往下滑的時候有一筆重複了（大概只會覺得「怪怪的」），
而有一張訂單**在列表裡根本不存在** —— 他會打電話進來說「我的訂單不見了」。

⚠️ **這組數字每次執行都不一樣**（換一次 JVM 就換一組），
所以它也**不會穩定地出現在測試裡** —— 你的 CI 有 95% 的機率是綠的。

### 4.4.2 為什麼：SQL 的承諾只到這裡

`ORDER BY created_at` 是一句**承諾**，而它的內容比大部分人以為的**弱得多**：

> **「回傳的列，`created_at` 會是遞增的。」**

**就這樣。** 它**沒有**承諾：

- ❌ `created_at` 相同的列之間，順序是什麼
- ❌ 這個順序在兩次查詢之間會一樣
- ❌ 這個順序和「第 0 頁 + 第 1 頁」拼起來是一致的

而 `OFFSET 5 FETCH FIRST 5` 的意思是：

> **「把符合條件的列按 `ORDER BY` 排好，丟掉前 5 筆，給我接下來 5 筆。」**

當 12 筆的 `created_at` 全部相同時，**「按 `ORDER BY` 排好」有 12! 種合法的答案**。
資料庫每一次查詢都可以（合法地）選不同的一種。

上面的計畫顯示兩次查詢都是 `tableScan` —— **執行計畫甚至沒有變**。
變的是 H2 為了 `OFFSET + FETCH FIRST` 做的**部分排序（top-N sort）**：
它只需要把「前 offset+size 筆」排出來，剩下的不管。
`offset` 不同 → 部分排序的範圍不同 → **tie 的落點不同**。

📌 **一句話**：
**分頁需要一個「全序」，而 `ORDER BY created_at` 只給你一個「偏序」。**

### 4.4.3 修法：補一個唯一的 tie-breaker

```
=== P3-B ★ 加上唯一的 tie-breaker 之後（其他都不變） ===
     第 0 頁 → [O-01, O-02, O-03, O-04, O-05]
     第 1 頁 → [O-06, O-07, O-08, O-09, O-10]
     第 2 頁 → [O-11, O-12]
     三頁共 12 筆，去重後 12 筆 → ✅ 每一筆剛好出現一次
  同一頁連跑三次：
    第 1 次 → [O-01, O-02, O-03, O-04, O-05]
    第 2 次 → [O-01, O-02, O-03, O-04, O-05]
    第 3 次 → [O-01, O-02, O-03, O-04, O-05]
```

**只加了 `, id`**：`ORDER BY created_at, id`。

因為 `id` 是主鍵（唯一），`(created_at, id)` 就是一個**全序** ——
12! 種合法答案變成 **1 種**。

**規則**：

> 🔴 **任何要分頁的查詢，`ORDER BY` 的最後一個鍵必須是唯一的。**
> 通常就是主鍵。

⚠️ **注意這條規則沒有例外**：
「`created_at` 是 `TIMESTAMP(6)`，不可能重複啦」——
促銷開賣那一秒不是不可能，是**必然**；
而且批次匯入的資料常常整批同一個時間戳。

### 4.4.4 第二種位移：翻頁期間有新資料

補了 tie-breaker 之後，`OFFSET` 分頁還有**第二個**問題，而它**修不掉**。

**實驗 P3-C**（10 張訂單，`ORDER BY created_at DESC, id DESC` —— 最新的在最前面，
而且**已經有 tie-breaker**）：

```
=== P3-C OFFSET 分頁：使用者看第 1 頁的時候，有人下了一張新單 ===
  第 0 頁（最新 5 筆）→ [O-10, O-09, O-08, O-07, O-06]
  ↑ 使用者按「下一頁」之前，插入了一張更新的 O-NEW
  第 1 頁          → [O-06, O-05, O-04, O-03, O-02]
  使用者看到的 10 筆：[O-10, O-09, O-08, O-07, O-06, O-06, O-05, O-04, O-03, O-02]
  🔴 重複出現的：[O-06]（因為所有資料往後位移了一格）
  🔴 而 O-NEW 使用者【永遠看不到】，除非他回到第 0 頁
```

**`O-06` 又出現了兩次** —— 這次不是因為排序不穩，是因為
**`OFFSET 5` 指的是「現在這一刻的第 5 筆」，而那一刻已經不是剛才那一刻了。**

```
使用者看第 0 頁時的順序：  O-10 O-09 O-08 O-07 O-06 | O-05 O-04 …
                          └────── 第 0 頁 ──────┘   └─ OFFSET 5 從這裡開始

O-NEW 插入之後的順序：    O-NEW O-10 O-09 O-08 O-07 | O-06 O-05 …
                                                      └─ OFFSET 5 現在指這裡
```

📌 **`OFFSET` 是「位置」，而位置會被前面的插入刪除推著跑。**
**這是 `OFFSET` 分頁的本質缺陷，加任何 tie-breaker 都修不掉。**
唯一的修法是**不要用位置** —— 用「上一頁最後一筆是誰」，也就是 4.7 的 keyset 分頁。

### 4.4.5 三條規則

| # | 規則 | 防哪一種事故 |
|---|---|---|
| 1 | 分頁查詢的 `ORDER BY` **最後一個鍵必須唯一**（通常是主鍵） | 4.4.1 的重複與遺漏 |
| 2 | **沒有 `ORDER BY` 的分頁查詢等於沒有分頁** —— 拒絕它 | 同上，只是更嚴重 |
| 3 | 「順序必須跨頁一致」的場合（匯出、對帳、無限滑動）**用 keyset，不用 `OFFSET`** | 4.4.4 的位移 |

規則 1 與 2 可以直接寫成程式碼（4.11.2 的 `PageSpec` 會做這件事）：

```java
private static Sort toSort(PageSpec spec) {
    if (spec.sort().isEmpty()) {
        return Sort.by("createdAt").descending().and(Sort.by("id").descending());
    }
    // ★ 4.4：一定補上唯一的 tie-breaker，否則翻頁會重複或遺漏
    return Sort.by(spec.sort().stream()
                    .map(k -> new Sort.Order(Sort.Direction.ASC, k.property())).toList())
            .and(Sort.by("id"));
}
```

**`.and(Sort.by("id"))` 這一行不是「防禦性程式碼」，是 4.4.1 那個 bug 的修正。**

---

## 4.5 ★ 排序欄位是使用者輸入

02 章 2.3.4 的結論是：**`?` 只能放在「值」的位置，欄位名與 `ORDER BY` 不能參數化。**
2.3.5 的解法是**白名單**。

現在同一個問題換成 Spring Data 的版本，而它多了一層麻煩：
**`Sort` 看起來像一個「有型別的物件」，所以感覺很安全。**

### 4.5.1 HTTP 參數怎麼變成 `Sort`

```java
@GetMapping("/api/orders")
public Page<OrderEntity> list(Pageable pageable) { … }   // ⚠️ 這一行有三個問題
```

`Pageable` 是怎麼從 HTTP 生出來的？靠 `PageableHandlerMethodArgumentResolver`。

**實驗 P9-A**（Spring Boot 3.2.5 的預設值）：

```
=== P9-A Spring Data Web 的預設值（Boot 3.2.5） ===
  spring.data.web.pageable.default-page-size = 20
  spring.data.web.pageable.max-page-size     = 2000 ★
  spring.data.web.pageable.one-indexed-parameters = false
  spring.data.web.pageable.page-parameter    = page
  spring.data.web.pageable.size-parameter    = size
```

**實驗 P9-B**（各種 query string 解析成什麼）：

```
=== P9-B 各種 query string 解析成什麼 ===
  ?（沒有任何參數）                    → page=0 size=20 offset=0 sort=[UNSORTED]
  ?page=0&size=20                   → page=0 size=20 offset=0 sort=[UNSORTED]
  ?page=1                           → page=1 size=20 offset=20 sort=[UNSORTED]
  ?size=5000                        → page=0 size=2000 offset=0 sort=[UNSORTED]
  ?size=2000000                     → page=0 size=2000 offset=0 sort=[UNSORTED]
  ?page=-1&size=20                  → page=0 size=20 offset=0 sort=[UNSORTED]
  ?size=0                           → page=0 size=20 offset=0 sort=[UNSORTED]
  ?page=abc&size=xyz                → page=0 size=20 offset=0 sort=[UNSORTED]
  ?sort=createdAt,desc              → page=0 size=20 offset=0 sort=[createdAt: DESC]
  ?sort=createdAt,desc&sort=id,asc  → page=0 size=20 offset=0 sort=[createdAt: DESC,id: ASC]
  ?sort=password                    → page=0 size=20 offset=0 sort=[password: ASC]
  ?sort=(SELECT 1)                  → page=0 size=20 offset=0 sort=[(SELECT 1): ASC]
  ★ size=2000000 被 clamp 成 2000 —— 這是【框架的預設上限】，不是你設的
  🔴 而 sort=password / sort=(SELECT 1) 在這一層【完全沒有被檢查】
```

**四個發現**：

| 發現 | 意思 |
|---|---|
| `size=2000000` → **2000** | 有上限，但是 **2000** —— 一次兩千筆進記憶體 |
| `page=-1`、`size=0`、`page=abc` → **靜默變成預設值** | 🔴 **不會 400，不會有任何訊息** |
| `?sort=` 沒帶 → **`UNSORTED`** | 🔴 直接踩進 4.4 的坑 |
| `?sort=password`、`?sort=(SELECT 1)` → **原樣放進 `Sort`** | 🔴 這一層一個字都沒有檢查 |

⚠️ **第二點特別討厭**：
前端傳了 `size=abc`（例如某個未初始化的變數），後端**不報錯**，
回一頁 20 筆 —— 前端以為自己要到了 100 筆，於是列表少了 80 筆，**而沒有人會發現**。

### 4.5.2 JPQL + `Sort`：打錯名字什麼時候發現

`?sort=password` 已經進到 `Sort` 裡了。它會怎樣？

**實驗 P4-A**（容器**已經啟動成功**，所以下面每一個錯誤都是**執行期**才發現的）：

```
=== P4-A JPQL + Sort：屬性名由使用者決定 ===
  ★ 容器已經啟動成功了 —— 所以下面每一個錯誤都是【執行期】才發現的
  Sort.by("createdAt")  → ✅ 2 筆；order by oe1_0.created_at
  Sort.by("customerId") → ✅ 2 筆；order by oe1_0.customer_id
  Sort.by("total_minor") → 🔴 PathElementException:
        Could not resolve attribute 'total_minor' of '…OrderEntity'
  Sort.by("password")   → 🔴 PathElementException:
        Could not resolve attribute 'password' of '…OrderEntity'
  Sort.by("lines.productId") → 🔴 PathException:
        Plural path '…OrderEntity(o).lines' refers to a collection and so
        element attribute 'productId' may not be referenced …
  Sort.by("id; DROP TABLE orders") → 🔴 InvalidDataAccessApiUsageException:
        Sort expression 'id; DROP TABLE orders: ASC' must only contain property
        references or aliases used in the select clause; If you really want to use
        something other than that …
  Sort.by("1")          → 🔴 SyntaxException: At 1:64 and token '.1',
        mismatched input '.1', expecting one of the following tokens: <EOF>, ',',
        ASC, DESC, FETCH, LIMIT, NULLS, OFFSET …
  Sort.by("(SELECT 1)") → 🔴 InvalidDataAccessApiUsageException:
        Sort expression '(SELECT 1): ASC' must only contain property references …
```

**好消息與壞消息各一個**。

**好消息**：Spring Data 有一道檢查（`QueryUtils.checkSortExpression`），
它擋掉了含有空白、分號、括號的表達式：

```
Sort expression 'id; DROP TABLE orders: ASC' must only contain property
references or aliases used in the select clause
```

**所以走 JPQL 這條路，`Sort` 不能拿來做 SQL Injection。**
⚠️ 注意這是**框架幫你擋的**，不是你的設計擋的 —— 4.5.4 會看到框架不擋的那條路。

**壞消息**：`Sort.by("total_minor")` 也是紅的。
使用者（或前端工程師）傳了**欄位名**而不是**屬性名**，
得到的是一個 **500 錯誤**，而不是 400。

⚠️ 而 `Sort.by("password")` 這個錯誤訊息本身就是資訊洩漏：

```
Could not resolve attribute 'password' of 'example.shop.order.infrastructure.jpa.OrderEntity'
```

**它把 entity 的完整類名告訴了攻擊者**，而且「有沒有這個屬性」的答案
可以用來**枚舉整個 entity 的欄位**（回 500 = 沒有，回 200 = 有）。

📌 **這就是為什麼「框架會擋 injection」不等於「可以直接把使用者輸入丟給 `Sort`」。**

### 4.5.3 原生 SQL + `Sort`：啟動就被擋

那如果查詢是**原生 SQL** 呢？

```java
public interface BadNativeSortRepository extends JpaRepository<OrderEntity, String> {

    @Query(value = "SELECT * FROM orders WHERE customer_id = :cid", nativeQuery = true)
    List<OrderEntity> nativeWithSort(@Param("cid") String customerId, Sort sort);
}
```

**這個介面會讓應用程式啟動失敗。**

**實驗 P4-B**：

```
=== P4-B 原生 SQL + Sort 參數：Spring Data 直接【不讓你啟動】 ===
  org.springframework.data.jpa.repository.query.InvalidJpaQueryMethodException
    Cannot use native queries with dynamic sorting in method
    public abstract java.util.List
    example.shop.order.infrastructure.jpa.bad.BadNativeSortRepository.nativeWithSort(
        java.lang.String, org.springframework.data.domain.Sort)
```

**這是本章少數幾個「框架做對了」的地方**，而且做得很徹底：

- 錯誤發生在**啟動時**，不是執行時（對照 03 章 3.4.3：原生 SQL 的其他錯誤都是執行期才爆）
- 訊息直接說出**是哪一個方法**
- 沒有任何開關可以「先讓它跑起來」

**理由**：原生 SQL 是一個字串，Spring Data 無法知道 `ORDER BY` 該接在哪裡、
也無法把屬性名翻成欄位名，**只能字串拼接** —— 所以它乾脆禁止。

### 4.5.4 ★★ 原生 SQL + `Pageable`：沒人擋

**但 `Pageable` 裡面【也有】一個 `Sort`。**

而原生 SQL **可以**接 `Pageable`（只要提供 `countQuery`）：

```java
@Query(value = "SELECT * FROM orders WHERE customer_id = :cid",
       countQuery = "SELECT count(*) FROM orders WHERE customer_id = :cid",
       nativeQuery = true)
Page<OrderEntity> nativeWithPageable(@Param("cid") String customerId, Pageable pageable);
```

**這個介面啟動成功。** 那 `Pageable` 裡的 `Sort` 去哪了？

**實驗 P4-C**：

```
=== P4-C ★★ 原生 SQL + Pageable（Pageable 裡面【也有】一個 Sort） ===
  created_at: ASC                        → ✅ 2 筆
      SELECT * FROM orders WHERE customer_id = ?
      order by created_at asc fetch first ? rows only

  no_such_column: ASC                    → 🔴 JdbcSQLSyntaxErrorException:
      Column "NO_SUCH_COLUMN" not found; SQL statement:
      SELECT * FROM orders WHERE customer_id = ? order by no_such_column asc …

  total_minor DESC: ASC                  → 🔴 InvalidDataAccessApiUsageException:
      Sort expression 'total_minor DESC: ASC' must only contain property references …

  LENGTH(customer_id): ASC               → ✅ 2 筆
      SELECT * FROM orders WHERE customer_id = ?
      order by LENGTH(customer_id) asc fetch first ? rows only

  (SELECT count(*) FROM order_line): ASC → ✅ 2 筆
      SELECT * FROM orders WHERE customer_id = ?
      order by (SELECT count(*) FROM order_line) asc fetch first ? rows only
```

**逐條讀**：

| 輸入 | 結果 | 意思 |
|---|---|---|
| `Sort.by("created_at")` | ✅ | **欄位名被原樣拼進 `ORDER BY`** —— 這裡要的是欄位名，不是屬性名 |
| `Sort.by("no_such_column")` | 🔴 SQL 語法錯誤 | 🔴 **可以用來枚舉欄位名**（回 500 = 沒有，回 200 = 有） |
| `Sort.by("total_minor DESC")` | 🔴 被 `checkSortExpression` 擋下 | 有空白 → 擋掉 |
| **`JpaSort.unsafe("LENGTH(customer_id)")`** | ✅ **執行了** | 🔴 函數呼叫被拼進 SQL |
| **`JpaSort.unsafe("(SELECT count(*) FROM order_line)")`** | ✅ **執行了** | 🔴 **子查詢**被拼進 SQL |

🔴 **最後兩行是這一節的重點**：
`JpaSort.unsafe(...)` 的名字裡就寫著 `unsafe`，而它做的事是
**把字串原樣拼進 `ORDER BY`，完全跳過 `checkSortExpression`**。

**它能做到什麼**：

`ORDER BY` 只能放一個表達式，所以不能塞 `DROP TABLE`。但可以：

1. **DoS**：`ORDER BY (SELECT count(*) FROM order_line)` ——
   每一列都跑一次全表 `count`。表大一點，一個請求就能打掛資料庫。
2. **盲注（blind injection）**：
   `ORDER BY CASE WHEN (SELECT password FROM users WHERE id=1) LIKE 'a%' THEN id ELSE customer_id END`
   —— **用「回傳的順序」當成一個 bit**，一次問一個字元。
   回應碼是 200、資料看起來正常，**日誌裡什麼異常都沒有**。
3. **洩漏 schema**：靠「哪些欄位名不會報錯」把表結構問出來。

📌 **所以四條路的安全性排名**：

| 路徑 | 誰在擋 | 擋得住什麼 | 你需要做什麼 |
|---|---|---|---|
| JPQL / 派生查詢 + `Sort` | Spring Data 的 `checkSortExpression` | injection ✅、亂打的屬性名 ❌ | **白名單**（避免 500 與資訊洩漏） |
| 原生 SQL + `Sort` 參數 | Spring Data（**啟動就失敗**） | 全部 ✅ | 什麼都不用 —— 它不讓你寫 |
| **原生 SQL + `Pageable`** | 只有 `checkSortExpression` | injection 大致 ✅、欄位枚舉 ❌ | **白名單（必須）** |
| **`JpaSort.unsafe(...)`** | 🔴 **沒有人** | 什麼都擋不住 | **白名單（絕對必須）** |

⚠️ **`JpaSort.unsafe` 不是不能用** —— 「按明細數排序」這種需求真的需要它。
但它的參數**只能是常數**，永遠不能來自請求。

### 4.5.5 白名單：唯一的正解

上面四條路的結論是同一個：**排序欄位必須經過一個 enum。**

```java
/** 允許被排序的欄位 —— 白名單。不在裡面的一律拒絕。 */
public enum SortKey {
    CREATED_AT("createdAt", "created_at"),
    TOTAL("totalMinor", "total_minor"),
    STATUS("status", "status"),
    ID("id", "id");

    private final String property;   // JPA / QueryDSL 用的屬性名
    private final String column;     // 原生 SQL 用的欄位名

    SortKey(String property, String column) { this.property = property; this.column = column; }

    public String property() { return property; }
    public String column() { return column; }

    /** ⚠️ 唯一的入口：外面傳進來的字串只能經過這裡。 */
    public static SortKey parse(String raw) {
        for (SortKey k : values()) if (k.name().equalsIgnoreCase(raw)) return k;
        throw new IllegalArgumentException("不支援的排序欄位：" + raw
                + "（可用：" + java.util.Arrays.toString(values()) + "）");
    }
}
```

**實驗 P11-A**：

```
=== P11-A 白名單：合法與不合法的排序欄位 ===
  parse("CREATED_AT") → ✅ CREATED_AT（property=createdAt, column=created_at）
  parse("created_at") → ✅ CREATED_AT（property=createdAt, column=created_at）
  parse("TOTAL")      → ✅ TOTAL（property=totalMinor, column=total_minor）
  parse("password")   → 🔴 不支援的排序欄位：password（可用：[CREATED_AT, TOTAL, STATUS, ID]）
  parse("id; DROP TABLE orders") → 🔴 不支援的排序欄位：id; DROP TABLE orders（可用：…）
  parse("(SELECT 1)") → 🔴 不支援的排序欄位：(SELECT 1)（可用：…）
```

**這個 enum 一次解決五件事**：

1. **injection**：只有四個字串能通過，都是常數。
2. **資訊洩漏**：錯誤訊息說的是「可用的排序欄位」，**不是 entity 的類名與屬性**。
3. **`IllegalArgumentException`**：這是一個**參數錯誤**，Controller 可以回 **400**（04-controller 06 章的做法），而不是 500。
4. **API 穩定性**：`CREATED_AT` 是**你的 API 名字**。
   哪天欄位改名叫 `placed_at`、屬性改名叫 `placedAt`，
   **只改 enum 裡那一行**，API 不變。
5. **兩種實作共用**：`property()` 給 JPA，`column()` 給原生 SQL ——
   同一份白名單，兩個實作都吃（4.11.3 的三個實作都用它）。

⚠️ **最後一點值得強調**：
白名單不是「額外加一層防護」，是**把「哪些欄位可以排序」變成一個明確的設計決定**。
現在有人想加「按客戶名稱排序」，他必須**改這個 enum** ——
於是那個「客戶名稱在另一張表、需要 join、而且沒有索引」的問題會在 code review 時被看到，
而不是在上線後被看到。

### 4.5.6 `size` 的上限該由哪一層管

4.3.2 的結論是 `PageRequest` 沒有上限；
4.5.1 的結論是 Web 層的預設上限是 **2000**。

**兩千筆夠不夠糟？** 算一下：
一張訂單的 `OrderSummaryView` 大約 200 bytes，2000 筆 = 400 KB。
一秒 50 個這樣的請求 = **20 MB/s 的物件配置**，
而且每一個請求都在資料庫上掃 2000 列 + 一次 `COUNT`。

**設在哪一層？** 三個選項：

| 設在哪 | 寫法 | 問題 |
|---|---|---|
| Web 層 | `spring.data.web.pageable.max-page-size=200` | 只擋 HTTP 進來的；內部呼叫、排程、測試都繞過它 |
| Repository | 在每個方法裡檢查 | 每一個方法都要寫一次，漏一個就破功 |
| **application 層的型別** | **`PageSpec` 的建構子** | ✅ **任何人拿到 `PageSpec` 就代表已經過關** |

**選第三個**：

```java
public record PageSpec(int page, int size, List<SortKey> sort, boolean needTotal) {

    public static final int MAX_SIZE = 200;

    public PageSpec {
        if (page < 0) throw new IllegalArgumentException("page 不能小於 0：" + page);
        if (size < 1) throw new IllegalArgumentException("size 不能小於 1：" + size);
        if (size > MAX_SIZE)
            throw new IllegalArgumentException("size 上限是 " + MAX_SIZE + "，收到 " + size);
        sort = List.copyOf(sort);
    }
}
```

**實驗 P11-B**：

```
=== P11-B size 的上限（PageSpec.MAX_SIZE = 200） ===
  size=1         → ✅ 通過
  size=200       → ✅ 通過
  size=201       → 🔴 size 上限是 200，收到 201
  size=2000      → 🔴 size 上限是 200，收到 2000
  size=2000000   → 🔴 size 上限是 200，收到 2000000
```

📌 **這是 05-service 01 章「不變量要放在型別上」的同一個手法**：
**`PageSpec` 這個型別的存在本身，就是「這個分頁請求是合法的」的證明。**
Repository 不需要再檢查一次，因為**不合法的 `PageSpec` 造不出來**。

⚠️ 同時 Web 層那一道也要設（縮到 200），理由是**兩道防線的職責不同**：
Web 層擋的是「別讓一個惡意請求走到 application 層」，
`PageSpec` 擋的是「別讓任何程式碼路徑產生超大分頁」。

```yaml
spring:
  data:
    web:
      pageable:
        default-page-size: 20
        max-page-size: 200          # ★ 和 PageSpec.MAX_SIZE 一致
        one-indexed-parameters: true # ★ 4.3.1 的 off-by-one：讓 page=1 是第一頁
```

**實驗 P9-C**（把上限改成 200、打開 one-indexed）：

```
=== P9-C 把上限改小（正式環境該做的事） ===
  ?（沒有參數）      → page=0 size=20 offset=0 sort=[createdAt: DESC]
  ?size=5000       → page=0 size=200 offset=0 sort=[createdAt: DESC]
  ?page=1          → page=0 size=20 offset=0 sort=[createdAt: DESC]
  ?page=0          → page=0 size=20 offset=0 sort=[createdAt: DESC]
  ★ one-indexed 打開之後，page=1 才是第一頁，而 page=0 也被當成第一頁
```

⚠️ **`one-indexed-parameters` 是一個「一旦開了就不能關」的決定** ——
它改變了 API 的語意。要開就在**第一天**開，並寫進 API 文件。
而 `setFallbackPageable(...)` 讓「沒帶參數」也有一個帶排序的預設值，
順手解決了 4.5.1 那個 `UNSORTED` 的問題。

---

## 4.6 ★ 動態查詢：使用者填了哪幾格你事先不知道

需求：後台的訂單搜尋畫面有五個欄位，使用者可以填任意組合。

```java
public record OrderSearchQuery(String customerId,
                               OrderStatus status,
                               Instant createdFrom,
                               Instant createdTo,
                               Long minTotalMinor) { }
```

**5 個欄位 = 32 種組合。** 不可能寫 32 個方法。

### 4.6.1 先看兩個錯的做法

**錯法一：字串拼接**

```java
// 🔴 這是 02 章 2.3 花了一整節在講的事
String sql = "SELECT * FROM orders WHERE 1=1";
if (customerId != null) sql += " AND customer_id = '" + customerId + "'";
if (status != null)     sql += " AND status = '" + status + "'";
```

02 章 2.3.2 實測過這種寫法**一次「查詢」把整張表刪掉**。不再重複。

**錯法二：`WHERE 1=1` + 參數**

```java
// 值有參數化了，但還是有兩個問題
String sql = "SELECT * FROM orders WHERE 1=1";
if (customerId != null) sql += " AND customer_id = :customerId";
```

值安全了，但：

1. `WHERE 1=1` 會出現在**每一句** SQL 裡 —— 慢查詢日誌與 SQL 指紋統計都被汙染。
2. **沒有任何東西保證 `sql +=` 的那一段是安全的** ——
   下一個同事很自然地寫出 `sql += " ORDER BY " + sortField`，
   而 code review 看不出這一行和上面幾行有什麼本質差別。

**錯法三：Query By Example（QBE）**

```java
Example<OrderEntity> example = Example.of(probe);   // 只有 = 比較
repo.findAll(example);
```

QBE 看起來剛好符合需求，但它**只能做等值比較（與字串的 like）**，
做不到 `createdAt >= ?`、`totalMinor >= ?` —— 五個欄位裡有三個它處理不了。
**它適合的場合非常窄**，本章不採用。

### 4.6.2 做法一：`Specification`

`Specification<T>` 就是「一段 `WHERE` 條件」的物件化：

```java
@FunctionalInterface
public interface Specification<T> {
    Predicate toPredicate(Root<T> root, CriteriaQuery<?> query, CriteriaBuilder cb);
}
```

**一格一個方法，最後組起來**：

```java
public final class OrderSpecs {

    public static Specification<OrderEntity> matching(OrderSearchQuery q) {
        List<Specification<OrderEntity>> parts = new ArrayList<>();
        if (q.customerId() != null)    parts.add(customerIs(q.customerId()));
        if (q.status() != null)        parts.add(statusIs(q.status()));
        if (q.createdFrom() != null)   parts.add(createdFrom(q.createdFrom()));
        if (q.createdTo() != null)     parts.add(createdBefore(q.createdTo()));
        if (q.minTotalMinor() != null) parts.add(totalAtLeast(q.minTotalMinor()));
        // ★ 空條件回傳 null（不是 conjunction）：SQL 裡就不會出現 WHERE 1=1
        return parts.isEmpty() ? null : Specification.allOf(parts);
    }

    static Specification<OrderEntity> customerIs(String customerId) {
        return (root, query, cb) -> cb.equal(root.get("customerId"), customerId);
    }

    static Specification<OrderEntity> statusIs(OrderStatus status) {
        return (root, query, cb) -> cb.equal(root.get("status"), status);
    }

    static Specification<OrderEntity> createdFrom(Instant from) {
        return (root, query, cb) -> cb.greaterThanOrEqualTo(root.get("createdAt"), from);
    }

    static Specification<OrderEntity> createdBefore(Instant to) {
        return (root, query, cb) -> cb.lessThan(root.get("createdAt"), to);
    }

    static Specification<OrderEntity> totalAtLeast(long minor) {
        return (root, query, cb) -> cb.greaterThanOrEqualTo(root.get("totalMinor"), minor);
    }
}
```

⚠️ **`parts.isEmpty() ? null : …` 這一行很重要**：
`Specification.where(null)` 或回傳 `null` 的 `Specification` 會被 Spring Data 當成「沒有條件」，
產生的 SQL **完全沒有 `WHERE`**。
如果改成 `cb.conjunction()`，SQL 裡會多一個 `1=1`。

Repository 只要多繼承一個介面：

```java
public interface OrderPageRepository
        extends JpaRepository<OrderEntity, String>, JpaSpecificationExecutor<OrderEntity> { }
```

`JpaSpecificationExecutor` 給你這些方法（用 `javap` 確認過）：

```java
Optional<T> findOne(Specification<T>);
List<T>     findAll(Specification<T>);
Page<T>     findAll(Specification<T>, Pageable);        // ★ 只有 Page，沒有 Slice
List<T>     findAll(Specification<T>, Sort);
long        count(Specification<T>);
boolean     exists(Specification<T>);
long        delete(Specification<T>);
<S, R> R    findBy(Specification<T>, Function<FetchableFluentQuery<S>, R>);   // ★ 3.0+ 的 fluent API
```

⚠️ **注意第三行**：**它給 `Page`，不給 `Slice`。**
所以「用 `Specification` 又不想要那句 `COUNT`」必須走 `findBy(...)` 那條路（4.9.3 會用到）。

### 4.6.3 三種做法的 `WHERE` 對照（實測）

**實驗 P8-A/B/C**（同一組五種填法，三個實作）：

```
=== P8-A Specification 產生的 WHERE ===
  0 格（什麼都沒填）   → 5 筆｜（沒有 WHERE）
  1 格（只填客戶）    → 5 筆｜customer_id=?
  2 格（客戶 + 狀態）  → 3 筆｜customer_id=? and status=?
  3 格（＋時間下界）   → 3 筆｜customer_id=? and status=? and created_at>=?
  5 格（全填）       → 2 筆｜customer_id=? and status=? and created_at>=?
                            and created_at<? and total_minor>=?

=== P8-B QueryDSL 產生的 WHERE ===
  0 格（什麼都沒填）   → 5 筆｜（沒有 WHERE）
  1 格（只填客戶）    → 5 筆｜customer_id=?
  2 格（客戶 + 狀態）  → 3 筆｜customer_id=? and status=?
  3 格（＋時間下界）   → 3 筆｜customer_id=? and status=? and created_at>=?
  5 格（全填）       → 2 筆｜customer_id=? and status=? and created_at>=?
                            and created_at<? and total_minor>=?

=== P8-C 自己拼 SQL（白名單） 產生的 WHERE ===
  0 格（什麼都沒填）   → 5 筆｜（沒有 WHERE）
  1 格（只填客戶）    → 5 筆｜customer_id = ?
  2 格（客戶 + 狀態）  → 3 筆｜customer_id = ? AND status = ?
  3 格（＋時間下界）   → 3 筆｜customer_id = ? AND status = ? AND created_at >= ?
  5 格（全填）       → 2 筆｜customer_id = ? AND status = ? AND created_at >= ?
                            AND created_at < ? AND total_minor >= ?
```

📌 **三個實作產生的 SQL 幾乎一模一樣**（只差空白），
**筆數完全一樣**（5 / 5 / 3 / 3 / 2），**而且沒有一個有 `WHERE 1=1`**。

⚠️ **所以「選哪一種」不是效能問題** —— 產生的 SQL 一樣。
是**別的東西**的問題，下面三節逐一交代。

### 4.6.4 做法二：QueryDSL

`Specification` 的問題是 **`root.get("customerId")` 是一個字串**。
4.5.2 已經看過：打錯字要**執行期**才發現。

QueryDSL 用一個註解處理器，從 entity 產生一組**有型別的**查詢類別：

```xml
<!-- pom.xml -->
<dependency>
  <groupId>com.querydsl</groupId>
  <artifactId>querydsl-jpa</artifactId>
  <version>5.0.0</version>
  <classifier>jakarta</classifier>          <!-- ★ Boot 3 = jakarta，不是 javax -->
</dependency>
```

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-compiler-plugin</artifactId>
  <configuration>
    <annotationProcessorPaths>
      <path>
        <groupId>com.querydsl</groupId>
        <artifactId>querydsl-apt</artifactId>
        <version>5.0.0</version>
        <classifier>jakarta</classifier>
      </path>
      <path>
        <groupId>jakarta.persistence</groupId>
        <artifactId>jakarta.persistence-api</artifactId>
        <version>3.1.0</version>
      </path>
    </annotationProcessorPaths>
    <annotationProcessors>
      <annotationProcessor>com.querydsl.apt.jpa.JPAAnnotationProcessor</annotationProcessor>
    </annotationProcessors>
  </configuration>
</plugin>
```

`mvn compile` 之後：

```
target/generated-sources/annotations/example/shop/order/infrastructure/jpa/QOrderEntity.java
target/generated-sources/annotations/example/shop/order/infrastructure/jpa/QOrderLineEntity.java
target/generated-sources/annotations/example/shop/order/infrastructure/jpa/QAuditEntity.java
```

於是查詢長這樣：

```java
public class QuerydslOrderSearchAdapter implements OrderSearchPort {

    private static final QOrderEntity O = QOrderEntity.orderEntity;

    private final JPAQueryFactory factory;

    public QuerydslOrderSearchAdapter(EntityManager em) { this.factory = new JPAQueryFactory(em); }

    /** ★ 動態條件：一格一個 and，不填的那一格傳 null，QueryDSL 會自己略過。 */
    private static BooleanBuilder predicate(OrderSearchQuery q) {
        BooleanBuilder b = new BooleanBuilder();
        b.and(q.customerId() == null ? null : O.customerId.eq(q.customerId()));
        if (q.status() != null)        b.and(O.status.eq(q.status()));
        if (q.createdFrom() != null)   b.and(O.createdAt.goe(q.createdFrom()));
        if (q.createdTo() != null)     b.and(O.createdAt.lt(q.createdTo()));
        if (q.minTotalMinor() != null) b.and(O.totalMinor.goe(q.minTotalMinor()));
        return b;
    }

    @Override
    public PageResult<OrderSummaryView> search(OrderSearchQuery query, PageSpec spec) {
        BooleanBuilder where = predicate(query);
        List<OrderSummaryView> rows = factory
                .select(Projections.constructor(OrderSummaryView.class,
                        O.id, O.customerId, O.status, O.totalMinor, O.currency, O.createdAt))
                .from(O)
                .where(where)
                .orderBy(orderBy(spec))
                .offset(spec.offset())
                .limit(spec.size() + 1L)          // ★ 多抓一筆判斷 hasNext
                .fetch();

        boolean hasNext = rows.size() > spec.size();
        List<OrderSummaryView> content = rows.stream().limit(spec.size()).toList();
        if (!spec.needTotal()) return PageResult.of(content, spec.page(), spec.size(), hasNext);

        // ★ 需要總數才發 COUNT —— 而且是【自己】決定要不要發，不是被框架決定
        Long total = factory.select(O.id.count()).from(O).where(where).fetchOne();
        return PageResult.withTotal(content, spec.page(), spec.size(), total == null ? 0 : total);
    }
    // …
}
```

**QueryDSL 買到三個東西**：

| 買到什麼 | 對照 `Specification` |
|---|---|
| **打錯屬性名是編譯錯誤** | `root.get("custmerId")` 要執行期才爆（4.5.2） |
| **`.offset()` 與 `.limit()` 是分開的** | `Pageable` 的 offset 必須是 size 的倍數（4.9.3 要自訂 `Pageable`） |
| **`COUNT` 完全由你決定** | `findAll(spec, Pageable)` 回 `Page`，`COUNT` 由框架決定 |

**賣掉三個東西**：

| 賣掉什麼 | 代價 |
|---|---|
| **一個註解處理器 + 一組產生的類別** | IDE 要設定 generated-sources；`mvn clean` 之後第一次編譯前 IDE 會滿江紅 |
| **一個額外的依賴** | QueryDSL 5.0.0 的維護節奏比 Spring Data 慢，Jakarta 遷移時等了很久 |
| **`BooleanBuilder` 的 `null` 語意** | `b.and(null)` 是「略過」，很方便，也很容易寫出「條件被靜默吃掉」的 bug |

### 4.6.5 做法三：自己拼 SQL（結構是拼的，值是綁的）

02 章說「不准字串拼接 SQL」。這裡要拼，**但拼的是結構，不是值**：

```java
/**
 * ⚠️ 02 章 2.3 說過「不准字串拼接 SQL」。這裡拼的是【結構】（哪幾段 WHERE、
 * ORDER BY 用哪個欄位），【值一律走參數】，而且欄位名只能來自 PageSpec.SortKey
 * 這個 enum —— 白名單。這兩件事都做到，才叫「動態 SQL」；少任何一件都叫 SQL Injection。
 */
public class JdbcOrderSearchAdapter implements OrderSearchPort {

    private static List<String> whereParts(OrderSearchQuery q, MapSqlParameterSource params) {
        List<String> parts = new ArrayList<>();
        if (q.customerId() != null) {
            parts.add("customer_id = :customerId");            // ← 結構
            params.addValue("customerId", q.customerId());     // ← 值
        }
        if (q.status() != null) {
            parts.add("status = :status");
            params.addValue("status", q.status().name());
        }
        if (q.createdFrom() != null) {
            parts.add("created_at >= :createdFrom");
            params.addValue("createdFrom", Timestamp.from(q.createdFrom()));
        }
        if (q.createdTo() != null) {
            parts.add("created_at < :createdTo");
            params.addValue("createdTo", Timestamp.from(q.createdTo()));
        }
        if (q.minTotalMinor() != null) {
            parts.add("total_minor >= :minTotal");
            params.addValue("minTotal", q.minTotalMinor());
        }
        return parts;
    }

    /** ★ 欄位名只能來自 enum —— 使用者的字串永遠碰不到這裡。 */
    private static String orderByClause(PageSpec spec) {
        if (spec.sort().isEmpty()) return "created_at DESC, id DESC";
        List<String> cols = new ArrayList<>();
        for (PageSpec.SortKey k : spec.sort()) cols.add(k.column() + " ASC");
        cols.add("id ASC");                        // 一定要有唯一的 tie-breaker（4.4）
        return String.join(", ", cols);
    }
}
```

**這個做法的三個判準**（三個都要成立才安全）：

1. ✅ **每一段 `parts.add(...)` 的字串都是常數** —— 沒有任何一段來自輸入。
2. ✅ **每一個值都經過 `params.addValue(...)`** —— 沒有任何值進到 SQL 字串裡。
3. ✅ **`ORDER BY` 的欄位名來自 `SortKey` enum** —— 白名單。

⚠️ **這三條是可以被機器檢查的**（02 章 2.3.8 那條「不准拼接」的掃描規則
要改成「不准把非常數拼進 SQL」），4.11.6 會給規則。

**它買到什麼**（前面兩種做法都做不到的）：

```java
// ★★ row-value 比較 —— 這是 JPA 那條路做不到的一句（4.7.4）
parts.add("(created_at, id) > (:__ts, :__id)");
```

📌 **這一句在 4.7.6 會證明它在 H2 上比 JPA 產生的版本【少掃 4,762 倍的列】。**
⚠️ **但 4.7.4b 會證明在 MySQL 8 上結果相反** ——
手寫 SQL 真正的價值不是「row value 比較快」，是
**「你可以自由選擇適合【你那個資料庫】的寫法」**，而 JPA 那條路沒有這個選擇。

### 4.6.6 ★★ join 之後的重複：5 張訂單只看到 2 張

現在加一個很自然的需求：**「找出買過 P-1 或 P-2 的訂單」**。

```java
public static Specification<OrderEntity> boughtAnyOf(List<String> productIds) {
    return (root, query, cb) -> root.join("lines").get("productId").in(productIds);
}
```

**資料**：5 張訂單，每張都有 `P-1` 與 `P-2` 兩筆明細
→ **join 之後 SQL 會回 10 列**（每張訂單 2 列）。

先看不分頁的情況：

```
=== P8-D ★ 「買過 P-1 或 P-2 的訂單」—— 5 張訂單，回來幾筆 ===
  ① join（沒有 distinct）  → 5 筆：[O-0001, O-0002, O-0003, O-0004, O-0005]
      [1] select oe1_0.id,… from orders oe1_0
          join order_line l1_0 on oe1_0.id=l1_0.order_id
          where l1_0.product_id in (?,?)
```

**咦，5 筆？不是 10 筆？**

**對** —— Hibernate 6 在回傳 entity 時會**按主鍵去重**（同一個 id 在同一個持久化情境裡
只有一個物件，03 章 3.9.2 講過的一級快取）。
SQL 回 10 列，Hibernate 給你 5 個物件。

**看起來沒事。所以問題被隱藏了。**

現在加上分頁：**每頁 4 筆，走完所有頁。**

```
=== P8-G ★★ join 的 Specification + 分頁：每頁到底幾筆 ===
  5 張訂單、每張 2 筆明細，兩筆都符合條件 → SQL 會回 10 列
  要求每頁 4 筆，走完所有頁：
  ① join 沒 distinct   每頁筆數 2         共看到 2 筆、去重 2 筆 🔴 少了 3 張
  ② join + distinct    每頁筆數 4 / 1     共看到 5 筆、去重 5 筆 ✅ 不重不漏
  ③ EXISTS             每頁筆數 4 / 1     共看到 5 筆、去重 5 筆 ✅ 不重不漏
```

🔴 **5 張訂單，走完所有頁只看到 2 張。**

**而且 `hasNext()` 說 `false`** —— 程式**完全不知道**漏了 3 張。

**為什麼**：

```
SQL 層：  FETCH FIRST 4 ROWS ONLY  →  拿到 4 【列】
          O-0001(P-1) O-0001(P-2) O-0002(P-1) O-0002(P-2)
                              ↓ Hibernate 按主鍵去重
Java 層：  [O-0001, O-0002]  →  2 個【物件】

Page 的判斷：content.size()=2 < pageSize=4  →  「這一頁沒滿，所以是最後一頁」
                                            →  total=2，hasNext=false
```

📌 **`LIMIT` 算的是「列」，你要的是「聚合」——
一旦 join 讓一個聚合佔了多列，這兩個數字就不再是同一個數字。**

而 4.2.2 那個「最後一頁不發 `COUNT`」的優化，
在這裡把錯誤**放大成了「提早結束」**：因為那一頁沒滿，`Page` 認定沒有下一頁了。

⚠️ **這個 bug 的每一個特徵都指向「上線才會發現」**：

- 不分頁時**完全正常**（5 筆）
- 每張訂單只有 1 筆符合明細時**完全正常**（1 列 = 1 聚合）
- 測試資料通常「每張訂單只買一種商品」→ **測試全綠**
- 上線後某個客戶一張單買了兩種促銷品 → **他的訂單開始從列表裡消失**

### 4.6.7 三種修法，以及 `COUNT` 的正確性

**修法① `query.distinct(true)`**

```java
public static Specification<OrderEntity> boughtAnyOfDistinct(List<String> productIds) {
    return (root, query, cb) -> {
        query.distinct(true);                                  // ★ 這一行
        return root.join("lines").get("productId").in(productIds);
    };
}
```

**修法② `EXISTS` 子查詢（根本不 join）**

```java
/** ✅ 用 EXISTS 子查詢，根本不 join —— 沒有重複，也不用 distinct。 */
public static Specification<OrderEntity> boughtAnyOfExists(List<String> productIds) {
    return (root, query, cb) -> {
        var sub = query.subquery(Integer.class);
        var line = sub.from(OrderLineEntity.class);
        sub.select(cb.literal(1)).where(
                cb.equal(line.get("order").get("id"), root.get("id")),
                line.get("productId").in(productIds));
        return cb.exists(sub);
    };
}
```

**兩者產生的 SQL**：

```
  ② join + query.distinct(true) → 5 筆
      [1] select distinct oe1_0.id,… from orders oe1_0
          join order_line l1_0 on oe1_0.id=l1_0.order_id
          where l1_0.product_id in (?,?)

  ③ EXISTS 子查詢（不 join）  → 5 筆
      [1] select oe1_0.id,… from orders oe1_0
          where exists(select 1 from order_line ole1_0
                       where ole1_0.order_id=oe1_0.id and ole1_0.product_id in (?,?))
```

**那句 `COUNT` 呢？** 這是最容易錯的地方：

```
=== P8-E ★★ 把它們拿去分頁：那句 COUNT 會變成什麼、total 對不對 ===
  ① join 沒 distinct  content=2，total=2 🔴（正確答案是 5）
      COUNT：（沒有 COUNT）

  ② join + distinct   content=3，total=5 ✅（正確答案是 5）
      COUNT：select distinct count(distinct oe1_0.id) from orders oe1_0
             join order_line l1_0 on oe1_0.id=l1_0.order_id
             where l1_0.product_id in (?,?)

  ③ EXISTS            content=3，total=5 ✅（正確答案是 5）
      COUNT：select count(oe1_0.id) from orders oe1_0
             where exists(select 1 from order_line ole1_0
                          where ole1_0.order_id=oe1_0.id and ole1_0.product_id in (?,?))
```

**Spring Data 做對了一件事**：`query.distinct(true)` 會讓 `COUNT` 變成
**`count(distinct oe1_0.id)`** —— 所以 `total=5` 是對的，不是 10。

⚠️ **但 `count(distinct …)` 有成本**：它要建一個去重的雜湊表或做一次排序。
在大表上，`count(distinct id)` 可以比 `count(*)` 慢好幾倍。

**三種修法的對照**：

| 修法 | 筆數對嗎 | `total` 對嗎 | SQL 的形狀 | 代價 |
|---|---|---|---|---|
| ① 什麼都不做 | 🔴 **少 3 張** | 🔴 **2** | `join` | —— |
| ② `distinct(true)` | ✅ | ✅ **5** | `select distinct` + `count(distinct id)` | 去重的成本；`SELECT` 的所有欄位都要參與去重 |
| ③ **`EXISTS` 子查詢** | ✅ | ✅ **5** | 單表查詢 + 相關子查詢 | 通常最好：**沒有 join、沒有 distinct、`LIMIT` 算的就是聚合** |

📌 **判準**：

> **「條件在子表上，但結果只要主表」→ 用 `EXISTS`，不要用 `join`。**
>
> `join` 是「把兩張表的列組合起來」，而你要的不是組合，是**篩選**。
> 用 `join` 做篩選，就必須再用 `distinct` 把 join 造成的重複收回來 ——
> **兩個操作互相抵消，而分頁夾在中間。**

⚠️ **同樣的道理適用於 JPQL 與手寫 SQL**：
`SELECT DISTINCT o FROM OrderEntity o JOIN o.lines l WHERE l.productId IN :ids`
有一樣的問題（4.8 會看到 `DISTINCT` + `JOIN FETCH` + 分頁的版本更糟）。

### 4.6.8 四種做法怎麼選

| 判準 | `Specification` | QueryDSL | 手寫 SQL | QBE |
|---|---|---|---|---|
| 屬性名打錯何時發現 | 執行期 🔴 | **編譯期** ✅ | 執行期 🔴 | 編譯期 ✅ |
| 額外依賴 / 建置設定 | **沒有** ✅ | APT + 產生的類別 | **沒有** ✅ | 沒有 |
| 可讀性（5 個條件） | 中 | **好** ✅ | 好 | 好 |
| `offset` / `limit` 自由度 | 受 `Pageable` 限制 | **完全自由** ✅ | **完全自由** ✅ | 受限 |
| `COUNT` 發不發由誰決定 | 框架（除非用 `findBy`） | **你** ✅ | **你** ✅ | 框架 |
| 能用 row-value 比較（4.7.4） | 🔴 不能 | 🔴 不能 | ✅ **能** | 不能 |
| 能用資料庫特有語法 | 🔴 | 🔴 | ✅ | 🔴 |
| 比 `=` 更複雜的條件 | ✅ | ✅ | ✅ | 🔴 **只能 `=`** |

**shop-service 的選擇**（三個都實作了，跑同一組契約，見 4.11）：

| 場合 | 選什麼 | 理由 |
|---|---|---|
| **一般的後台搜尋**（等值 + 範圍） | **`Specification`** | 不用多一個依賴，`JpaSpecificationExecutor` 現成 |
| **條件很多、很常改的搜尋** | **QueryDSL** | 編譯期檢查在「條件超過五六個」之後價值很高 |
| **列表 / 報表 / keyset 分頁** | **手寫 SQL** | 要投影、要 row-value、要控制 `COUNT` |
| **寫入路徑** | 都不用 | 那是 `OrderRepository` 的事（03 章） |

⚠️ **不要「全部都用同一種」**：
`Specification` 適合條件組合，**不適合**寫報表（投影很難寫、`GROUP BY` 更難）；
手寫 SQL 適合報表，**不適合**32 種條件組合（結構拼接的程式碼會失控）。
**同一個專案裡兩種並存是正常的**，只要它們都躲在 infrastructure 層後面。

---

## 4.7 ★★ 深分頁

### 4.7.0 先講一件量測方法上的事

這一節要比較「快」與「慢」，所以先確認**量得準**。

**實驗 P12**（10 萬筆，同一句 `count`，量 20 次）：

```
  QUERY_CACHE_SIZE = 8
  SELECT count(*) FROM orders                     = 100000  第2次 82 µs；20 次最小 17 µs / 平均 20 µs
  SELECT count(*) FROM orders WHERE status='PAID'  = 25000   第2次 98 µs；20 次最小 16 µs / 平均 23 µs
```

**17 µs 掃 10 萬列 = 每列 0.17 奈秒。** 這不可能。

原因是 **H2 預設 `QUERY_CACHE_SIZE=8`** ——
它把最近 8 句「沒有參數的」查詢的**整份結果**快取起來。
第二次之後量到的是一次 `HashMap` 查表。

`SET QUERY_CACHE_SIZE 0` 不是合法的 H2 語法，要寫在 JDBC URL 裡：

```java
cfg.setJdbcUrl("jdbc:h2:mem:" + name + ";DB_CLOSE_DELAY=-1;QUERY_CACHE_SIZE=0");
```

關掉之後同一組數字：

```
  QUERY_CACHE_SIZE = 0
  SELECT count(*) FROM orders                     = 100000  20 次最小    23 µs
  SELECT count(*) FROM orders WHERE status='PAID'  = 25000   20 次最小 4,462 µs
```

**從 16 µs 變成 4,462 µs —— 差 279 倍。**

📌 **這一段值得記住的不是那個設定值，是那個習慣**：
**任何「我量到它很快」的結論，先問「我到底量到了什麼」。**
（06 章 6.4 會把「H2 會騙你」整理成一張清單，這是第一項。）

⚠️ **本節之後所有的 µs 都是在 `QUERY_CACHE_SIZE=0` 之下量的**，
而且都取 15 次的最小值。

### 4.7.1 實測：第 0 頁 26 µs，第 4,999 頁 2,491 µs

**資料**：10 萬筆訂單，`(created_at, id)` 有複合索引，每頁 20 筆。

```sql
SELECT id, created_at FROM orders ORDER BY created_at, id
 OFFSET ? ROWS FETCH FIRST 20 ROWS ONLY
```

**實驗 P5-B**：

```
=== P5-B OFFSET 分頁：100,000 筆資料，每頁 20 筆（有 (created_at, id) 索引） ===
  頁碼        OFFSET   耗時        掃過的列數   走哪條路
  第 0 頁      0        26 µs      20          ✅ PUBLIC.IDX_ORDERS_CREATED_ID
  第 10 頁     200      51 µs      220         ✅ PUBLIC.IDX_ORDERS_CREATED_ID
  第 100 頁    2000     88 µs      2020        ✅ PUBLIC.IDX_ORDERS_CREATED_ID
  第 1000 頁   20000    606 µs     20020       ✅ PUBLIC.IDX_ORDERS_CREATED_ID
  第 4999 頁   99980    2,491 µs   100000      ✅ PUBLIC.IDX_ORDERS_CREATED_ID
```

**看「掃過的列數」那一欄，不要看時間**：

```
20 → 220 → 2,020 → 20,020 → 100,000
```

**掃描列數 = `offset + size`。**

**因為 `OFFSET 99980` 的意思字面上就是**：

> 「把符合條件的列一列一列讀出來，**數到 99,980 筆，全部丟掉**，
> 然後給我接下來的 20 筆。」

⚠️ **它沒有「跳過」的能力** ——
B-tree 索引可以「找到某個值的位置」（`WHERE` 做的事），
但**不能「找到第 99,980 個項目的位置」**（那需要索引每個節點都存「我底下有幾筆」，
而一般的 B-tree 不存這個）。

**所以 `OFFSET N` 一定要真的讀過 N 列。**

⚠️ **時間那一欄要打一個很大的折**：
26 µs → 2,491 µs 是 **96 倍**，而掃描列數是 **5,000 倍**。
兩個數字差這麼多，是因為 H2 是**記憶體**資料庫 —— 每一列的成本極低。

**在真的 MySQL 上，這 5,000 倍會有兩個放大器**：

| 放大器 | 在 H2 上 | 在 MySQL + InnoDB 上 |
|---|---|---|
| **磁碟 / buffer pool** | 不存在 | 索引頁不在記憶體裡就要讀磁碟 |
| **二級索引回表** | 不存在 | `SELECT *` 時每一列都要用主鍵**再查一次 clustered index** |

🔴 **本章沒有在 MySQL 上驗證這一段**（本機沒有 Docker 與 MySQL）。
**07-mysql 站會用 `EXPLAIN ANALYZE` 與 `Handler_read_*` 補上真實的數字。**
但**「掃描列數 = offset + size」這個結論不需要驗證** ——
它是 `OFFSET` 的定義，和資料庫無關。

### 4.7.2 沒有索引的話，第 0 頁也一樣慢

**實驗 P5-A**（同一份資料，**把索引拿掉**）：

```
=== P5-A OFFSET 分頁：100,000 筆資料，每頁 20 筆（沒有索引） ===
  頁碼        OFFSET   耗時        掃過的列數   走哪條路
  第 0 頁      0        6,323 µs   100001      🔴 tableScan
  第 10 頁     200      6,063 µs   100001      🔴 tableScan
  第 100 頁    2000     5,603 µs   100001      🔴 tableScan
  第 1000 頁   20000    6,588 µs   100001      🔴 tableScan
  第 4999 頁   99980    5,583 µs   100001      🔴 tableScan
```

📌 **每一頁都掃 100,001 列，包含第 0 頁。**

**因為要排序**：沒有索引提供順序，資料庫必須把**全部**符合條件的列讀出來排一次，
才知道「前 20 筆」是哪 20 筆。

**兩個結論**：

1. **「第 1 頁很快」是有前提的** —— 前提是 `ORDER BY` 的欄位有索引。
   ⚠️ 而 4.5 的排序白名單有四個欄位 ——
   **每一個都要有能支撐 `ORDER BY` 的索引**，否則「按金額排序」這個功能
   就是一個「每次點都掃全表」的按鈕。
2. **`OFFSET` 深分頁的問題，和「排序有沒有索引」是兩個獨立的問題**，
   而且會疊加：沒有索引 + 深分頁 = 掃全表 + 排序全部。

**索引該長什麼樣**：`ORDER BY created_at, id` 需要 `(created_at, id)`；
加上 `WHERE status = ?` 之後需要 **`(status, created_at, id)`** ——
**篩選欄位在前，排序欄位在後**。（索引設計是 07-mysql 站 03 章的主題。）

### 4.7.3 keyset（seek）分頁：不要用位置，用「上一頁最後一筆是誰」

`OFFSET` 的兩個問題（4.4.4 的位移、4.7.1 的掃描量）**病因是同一個**：

> **它用「第幾筆」來表示位置，而「第幾筆」需要從頭數，也會被前面的變動推著跑。**

**改成用「值」**：

```sql
-- OFFSET 分頁：把前 99,980 筆數過去
SELECT … FROM orders ORDER BY created_at, id
 OFFSET 99980 ROWS FETCH FIRST 20 ROWS ONLY;

-- keyset 分頁：直接跳到「上一頁最後一筆」的後面
SELECT … FROM orders
 WHERE (created_at, id) > (:lastCreatedAt, :lastId)
 ORDER BY created_at, id
 FETCH FIRST 20 ROWS ONLY;
```

**`WHERE (created_at, id) > (?, ?)` 是索引【找得到】的事** —— 它就是一次 index seek。

⚠️ **keyset 分頁有一個硬前提**：
**`ORDER BY` 的欄位組合必須唯一**（也就是 4.4.3 那條規則），
否則「上一頁最後一筆」指不出一個唯一的位置。
**4.4 的 tie-breaker 從「建議」變成「必要條件」。**

### 4.7.4 ★ 三種寫法，只有兩種走得到索引

`(created_at, id) > (?, ?)` 這種**列值比較（row value constructor）**是標準 SQL，
但不是所有資料庫都支援、也不是所有 API 都寫得出來。

所以實務上有三種寫法。**它們邏輯上完全等價。**

```sql
-- ① OR 寫法（教科書最常見，Criteria / QueryDSL 只能寫這種）
WHERE created_at > :ts OR (created_at = :ts AND id > :id)

-- ② row value 寫法（標準 SQL）
WHERE (created_at, id) > (:ts, :id)

-- ③ 加一個「多餘」的下界（給最佳化器看的）
WHERE created_at >= :ts AND (created_at > :ts OR id > :id)
```

**實驗 P5-E**（10 萬筆，`(created_at, id)` 索引，跳到第 4,999 頁的位置）：

```
=== P5-E keyset 分頁：第 4999 頁（100,000 筆資料，有 (created_at, id) 索引） ===
  ① OR 寫法（教科書最常見）           → 17,914 µs  掃過 100000  ✅ PUBLIC.IDX_ORDERS_CREATED_ID
                                      拿到 20 筆
  ② row value 寫法（標準 SQL）        →    104 µs  掃過 21      ✅ PUBLIC.IDX_ORDERS_CREATED_ID
                                      拿到 20 筆
  ③ 加一個「多餘」的下界（給最佳化器看的） →     92 µs  掃過 21      ✅ PUBLIC.IDX_ORDERS_CREATED_ID
                                      拿到 20 筆
```

🔴 **三句 SQL 的結果完全一樣（都是那 20 筆）。**
🔴 **① 掃 100,000 列，②③ 掃 21 列 —— 4,762 倍。**
🔴 **而三句都「用到了索引」**（`EXPLAIN` 都顯示 `IDX_ORDERS_CREATED_ID`）。

**這是本章最需要小心的一個實測結論**：

> **`EXPLAIN` 說「用到索引了」，不代表它用索引做了 seek。**
> ① 用索引來**提供順序**（避免排序），但條件裡的 `OR` 讓它**無法界定範圍**，
> 所以它從索引的**開頭**開始，一列一列套用條件 —— 也就是一次**索引全掃**。

**為什麼 `OR` 會這樣**：

索引 seek 需要一個**連續的範圍**（「從這裡開始往後」）。
`A > x OR (A = x AND B > y)` 對最佳化器來說是**兩個範圍的聯集**，
而它（在 H2 上）沒有把這個聯集**證明成一個連續範圍**，只能退化成掃描 + 過濾。

寫法 ③ 就是**手動把那個證明餵給它**：多寫一個 `created_at >= :ts`，
最佳化器立刻看到「下界是 `:ts`」，於是 seek 到 `:ts` 再往後。
**多寫一個邏輯上多餘的條件，掃描量從 100,000 變 21。**

### 4.7.4b 🔴 ★★ 而在真的 MySQL 8 上，答案【完全相反】

⚠️ **上面那組數字是在 H2 上量的。06 章用真的 MySQL 8.0.46 重跑了同一組**，
結果是這樣：

```
=== ★ MySQL 8（真的） —— 深分頁與 keyset（10 萬筆） ===
  keyset ① OR 寫法（第 4999 頁位置）                 513 µs
  keyset ② row value（第 4999 頁位置）            13,235 µs

  ★ 兩種 keyset 寫法的執行計畫：
    ① OR        ：key=idx_probe_created_id, rows=2,  type=range   ← ✅ 索引範圍掃描
    ② row value：key=idx_probe_created_id, rows=20, type=index   ← 🔴 全索引掃描
```

**對照 H2**（⚠️ 下表兩欄都是 **06 章那組 probe 表**上量的，
資料形狀與 4.7.4 的 P5-E 不同 —— **要比的是「哪一邊快」，不是絕對數字**）：

| 寫法 | **H2 2.2.224** | **MySQL 8.0.46** |
|---|---|---|
| ① `A > x OR (A = x AND B > y)` | 🔴 **4,802 µs**（掃全索引） | ✅ **513 µs**（`type=range`） |
| ② `(A, B) > (x, y)` | ✅ **113 µs**（掃 21 列） | 🔴 **13,235 µs**（`type=index`） |

> ⚠️ **本章 4.7.4 的 P5-E（在 `orders` 表上）是 17,914 µs vs 104 µs。**
> **絕對數字和上表差好幾倍，而【方向】完全一致** ——
> 這正是為什麼這一節的結論用的是「快慢對調」而不是「差幾倍」。

🔴 **同一組 SQL、同一個索引、同樣的資料量，兩個資料庫的快慢【完全對調】。**

**MySQL 的 `EXPLAIN` 把原因說得很清楚**：

- `type=range` = **索引範圍掃描**（找到起點，往後讀）—— 這是我們要的。
- `type=index` = **全索引掃描**（從索引頭讀到尾，逐列套條件）—— 這是我們要避免的。

**MySQL 8 的最佳化器【不會】把列值比較 `(A,B) > (x,y)` 轉成索引範圍存取**，
但它**很擅長**把 `A > x OR (A = x AND B > y)` 這個形式轉成 range。
**H2 剛好相反。**

📌 **決策（修正版）**：

| 你的資料庫 | 用哪一種 | 為什麼 |
|---|---|---|
| **MySQL 8** | **①（OR 形式）** | 實測 `type=range`；row value 反而是全索引掃描 |
| **H2**（測試用） | ②（row value） | 實測掃 21 列 |
| **PostgreSQL** | ②（row value） | 🔴 **本課沒有驗證**；文件上它支援 row value 的索引存取 |
| **任何情況** | ✅ **③（補下界）** | **兩個資料庫上都是好的**（H2 掃 21 列；MySQL 的下界明寫，同樣走 range） |

⚠️ **所以本章原本的結論「不要用 ①」是【錯的】—— 它只在 H2 上成立。**

**唯一在兩邊都安全的寫法是 ③**：

```sql
-- ③ 補一個邏輯上多餘的下界 —— 兩個資料庫上都走 range
WHERE created_at >= :ts AND (created_at > :ts OR (created_at = :ts AND id > :id))
```

📌 **而這一節真正該記住的，不是「哪一種寫法比較快」**：

> **「同一句 SQL 在兩個資料庫上差 100 倍，而且方向相反」——
> 這件事本身就是「不能只用 H2 測資料層」最強的證據。**

**06 章 6.4 會把這類差異整理成一張完整的對照表**，本節只是其中一列。

---

⚠️ 🔴 **本節的原始量測（4.7.4 那三行）只在 H2 上成立。**
**每一個 keyset 分頁上線前，都必須在【正式環境用的那個資料庫】上跑一次 `EXPLAIN`**，
確認 `type` 是 `range` 而不是 `index` 或 `ALL`。

### 4.7.5 每一頁都是定量的工作

**實驗 P5-F**（用寫法 ②，走五個位置）：

```
=== P5-F 用第 ② 種寫法，走完 5 頁：成本會不會隨頁碼變 ===
  相當於第幾頁     上一頁最後一筆        耗時       掃過的列數
  第 0 頁         O-0000001          86 µs     21
  第 10 頁        O-0000200          84 µs     21
  第 100 頁       O-0002000          83 µs     21
  第 1000 頁      O-0020000          81 µs     21
  第 4999 頁      O-0099980          73 µs     21
  ★ 每一頁都是【定量】的工作，和頁碼完全無關
```

**掃過的列數：21、21、21、21、21。**

📌 **和 4.7.1 那一欄放在一起看，這就是整節的重點**：

```
OFFSET： 20 → 220 → 2,020 → 20,020 → 100,000      （= offset + size）
keyset： 21 →  21 →    21 →     21 →      21      （= size + 1）
```

**`OFFSET` 的成本是 O(offset)，keyset 的成本是 O(size)。**

### 4.7.6 ★★ Spring Data 內建的 keyset 分頁：`ScrollPosition`

好消息：**Spring Data 3.1 內建了 keyset 分頁**，不用自己寫。

```java
Window<OrderEntity> window = repo.findBy(spec,
        q -> q.sortBy(Sort.by("createdAt")).limit(20).scroll(ScrollPosition.keyset()));
```

`FetchableFluentQuery` 上那個 `scroll(ScrollPosition)` 方法就是它，
回傳一個 `Window<T>`（有 `hasNext()`、`positionAt(int)`）。

**先確認它對不對**（**實驗 P7-C**，12 筆、每批 5 筆）：

```
=== P7-C 走完 12 筆，每批 5 筆 ===
  第 1 批 → [O-0001, O-0002, O-0003, O-0004, O-0005]（hasNext=true）
  第 2 批 → [O-0006, O-0007, O-0008, O-0009, O-0010]（hasNext=true）
  第 3 批 → [O-0011, O-0012]（hasNext=false）
  共 12 筆，去重 12 筆 → ✅ 不重不漏
```

✅ **完全正確。** 而且它還幫你做了一件好事：

```
=== 探測：sortBy(createdAt: ASC) ===
  第 1 批 ORDER BY：order by oe1_0.created_at,oe1_0.created_at,oe1_0.id fetch first ? rows only
  position=KeysetScrollPosition [FORWARD, {id=O-0003, createdAt=2026-03-01T00:00:03Z}]
```

📌 **我只寫了 `Sort.by("createdAt")`，它自動把主鍵 `id` 接在排序尾巴。**
**也就是說 Scroll API 自動修好了 4.4 那個 tie-breaker 問題。**
（代價是 `ORDER BY` 裡出現重複的欄位 `created_at, created_at, id` —— 無害，但很醜。）

**現在看它產生的 `WHERE`**（**實驗 P7-B**）：

```
=== P7-B ★ ScrollPosition.keyset()：內建的 keyset 分頁 ===
  ★ 它產生的 WHERE 條件（完整、未截斷）：
      where oe1_0.currency=?
        and (oe1_0.created_at>?
             or oe1_0.created_at=? and oe1_0.id>?
             or oe1_0.created_at=? and oe1_0.id=? and oe1_0.created_at>?
             or oe1_0.created_at=? and oe1_0.id=? and oe1_0.created_at=? and oe1_0.id>?)
  ★ ORDER BY：order by oe1_0.created_at,oe1_0.id,oe1_0.created_at,oe1_0.id
              fetch first ? rows only
```

🔴 **它是 4.7.4 的第 ① 種寫法。** 而且因為排序鍵被重複接了一次，
`OR` 從 2 個分支展開成 **4 個分支**。

**那它在 10 萬筆的深位置上會怎樣？**

**實驗 P7-D**（10 萬筆、`(created_at, id)` 索引、跳到第 4,999 頁的位置）：

```
=== P7-D ★★ 內建 keyset 在 10 萬筆的深位置上，實際掃過幾列 ===
  拿到 20 筆：[O-0099981, O-0099982, O-0099983] …
  Spring Data 產生的（OR 形式）→ 掃過 100001 列
  手寫 row value 形式          → 掃過 21 列
  ★ 兩句的【結果一樣】，工作量差幾千倍 —— 而 Spring Data 沒有讓你選
```

🔴 **內建的 keyset 分頁，在深位置上掃了 100,001 列 —— 和 `OFFSET` 一樣多。**

**也就是說**：

> **你為了避開深分頁而改用 keyset，
> 結果換到一個「掃描量和深分頁一樣」的實作，
> 而所有測試都是綠的（結果完全正確）。**

⚠️ 這是本章第二個「靜默失效」（第一個是 4.3.4 的 `nullsLast()`），
形狀完全一樣：**你做了一個正確的修正，它編譯過、測試綠、而它沒有解決那個問題。**

**該怎麼辦**（三個選項，依情況）：

| 選項 | 做法 | 什麼時候選 |
|---|---|---|
| **A** | 直接用 `ScrollPosition.keyset()` | 資料量不大（幾萬筆以內），或者**你已經 `EXPLAIN` 過確認最佳化器處理得掉** |
| **B** | 手寫 SQL，用 row value 或補下界（4.6.5 的 `JdbcOrderSearchAdapter`） | ✅ **列表 / 無限滑動 / 匯出的主路徑** |
| **C** | 用 `ScrollPosition.keyset()`，但**排序鍵只有一個欄位而它剛好唯一** | `ORDER BY id` 這種情況 —— `OR` 只有一個分支，退化成 `id > ?`，最佳化器處理得掉 |

⚠️ **注意 4.7.4b**：上表的「掃 100,001 列」是 **H2** 的數字。
**在 MySQL 8 上，Spring Data 產生的 OR 形式反而是走 `type=range` 的**（4.7.4b 實測），
所以 **`ScrollPosition.keyset()` 在 MySQL 上比在 H2 上好得多**。
📌 **這讓選項 A 在 MySQL 專案裡比本節原本評估的更可行** ——
但仍然要自己 `EXPLAIN` 一次確認。

📌 **選項 C 值得注意**：如果你的列表可以接受「按 id 排序」
（例如 id 是 ULID / snowflake，本身帶時間序 —— 00 章 0.12 選 ULID 就是為了這個），
那 `ORDER BY id` + keyset 就是**一個欄位、一個 `>`、一次 seek**，
內建的 Scroll API 完全沒問題。

**「排序鍵越簡單，keyset 越便宜」** —— 這是設計 id 時就該想的事。

### 4.7.7 游標要是不透明的

keyset 分頁需要把「上一頁最後一筆是誰」傳給前端。**不要傳原始欄位。**

```java
/**
 * keyset 分頁的游標 —— 「上一頁的最後一筆是誰」。
 *
 * <p>對外一定是一個【不透明字串】：它是實作細節，不是 API 契約。
 * 今天是 (createdAt, id)，明天加了排序欄位就會變 ——
 * 如果前端把它拆開來用，你就再也改不動了。
 */
public record Cursor(Instant createdAt, String id) {

    public String encode() {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString((createdAt.toEpochMilli() + "|" + id).getBytes());
    }

    public static Cursor decode(String token) {
        try {
            String raw = new String(Base64.getUrlDecoder().decode(token));
            int bar = raw.indexOf('|');
            return new Cursor(Instant.ofEpochMilli(Long.parseLong(raw.substring(0, bar))),
                    raw.substring(bar + 1));
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("游標格式不正確", e);
        }
    }
}
```

**兩個理由，都是 03-rest-api 06 章（版本控管）的理由**：

1. **它會改**。今天排序鍵是 `(createdAt, id)`，明天加了「按金額排序」，
   游標就要變成 `(totalMinor, id)`。
   **如果 API 長成 `?lastCreatedAt=…&lastId=…`，你就改不動了。**
2. **它是實作細節**。前端不該知道你用什麼欄位排序。

契約測試裡有一條專門守這件事：

```java
@Test
void 游標是不透明字串而且可以往返() {
    KeysetPage<OrderSummaryView> first = inTx(() ->
            port().searchAfter(OrderSearchQuery.empty(), null, 5));
    assertThat(first.hasNext()).isTrue();
    String token = first.nextCursor();
    assertThat(token).doesNotContain("O-").doesNotContain("2026");   // ★ 不可以看得出內容

    KeysetPage<OrderSummaryView> second = inTx(() ->
            port().searchAfter(OrderSearchQuery.empty(), Cursor.decode(token), 5));
    assertThat(second.content().stream().map(OrderSummaryView::id).toList())
            .containsExactly("O-0006", "O-0007", "O-0008", "O-0009", "O-0010");
}
```

⚠️ **Base64 不是加密**，只是「不方便直接讀」。
如果游標裡的值本身是敏感的（例如某種內部序號），要簽章或加密 ——
而通常更好的做法是**讓游標裡不要有敏感資訊**。

⚠️ **還要處理「壞掉的游標」**：使用者會改 URL、會用過期的書籤。

```java
@Test
void 壞掉的游標要給清楚的錯誤() {
    assertThatThrownBy(() -> Cursor.decode("!!!not-a-cursor!!!"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("游標");
}
```

`IllegalArgumentException` → Controller 回 **400**，不是 500。

### 4.7.8 keyset 給不了什麼

**keyset 不是「更好的分頁」，是「不一樣的分頁」。** 它給不了三件事：

| 給不了 | 為什麼 | 怎麼辦 |
|---|---|---|
| **跳到第 37 頁** | 它只知道「下一頁」 | 後台的頁碼列**只能**用 `OFFSET`（或改設計） |
| **總頁數** | 沒有 `COUNT`（可以另外發，但那又是全表掃） | 改成「還有更多」而不是「共 6,643 頁」 |
| **往前翻** | 需要反向的游標與反向的 `ORDER BY` | 前端保留看過的游標，或實作 `Direction.BACKWARD` |

📌 **所以真實系統通常兩種都有**：

```java
public interface OrderSearchPort {

    /** 頁碼分頁 —— 給「要跳到第 37 頁」的後台用。 */
    PageResult<OrderSummaryView> search(OrderSearchQuery query, PageSpec spec);

    /** keyset 分頁 —— 給「無限往下滑」的 App 用（4.7）。 */
    KeysetPage<OrderSummaryView> searchAfter(OrderSearchQuery query, Cursor after, int size);
}
```

⚠️ **而後台那條路要另外處理深分頁**，三個常見做法：

1. **限制最大頁碼**（例如只能翻到第 100 頁），超過就要求加條件縮小範圍。
   —— 聽起來很粗暴，但這是**大部分搜尋引擎的做法**（Google 也不讓你翻到第 1000 頁）。
2. **把「跳到某一頁」換成「跳到某個日期」** ——
   使用者真正想做的通常是「看去年 3 月的訂單」，不是「看第 4,999 頁」。
   而「跳到某個日期」就是一次 keyset seek。
3. **匯出**：真的要看全部，給他一個 CSV（用 05 章的串流），不要讓他翻 5,000 頁。

---

## 4.8 ★ `JOIN FETCH` + 分頁 = 在記憶體裡分頁

03 章 3.9.4 用 `JOIN FETCH` 解掉了 N+1，並在 3.15 預告了這個坑。現在處理它。

### 4.8.1 實測

```java
@Query("SELECT DISTINCT o FROM OrderEntity o LEFT JOIN FETCH o.lines WHERE o.status = :st")
List<OrderEntity> fetchJoinPaged(@Param("st") OrderStatus status, Pageable pageable);
```

**實驗 P6-A**（40 張訂單、其中 10 張 `PENDING_PAYMENT`，只要第 1 頁的 3 筆）：

```
=== P6-A ★ JOIN FETCH + Pageable：只要第 1 頁的 3 筆 ===
WARN  org.hibernate.orm.query -- HHH90003004: firstResult/maxResults specified with
                                 collection fetch; applying in memory
  要求 3 筆，實際拿到 3 筆 → 結果是【對的】
  SQL → 1 句 SQL
      [1] select distinct oe1_0.id,oe1_0.created_at,oe1_0.currency,oe1_0.customer_id,
          l1_0.order_id,l1_0.line_no,l1_0.currency,l1_0.product_id,l1_0.quantity,
          l1_0.unit_price_minor,oe1_0.status,oe1_0.total_minor,oe1_0.version
          from orders oe1_0 left join order_line l1_0 on …
  SQL 裡有沒有 LIMIT / OFFSET：🔴 沒有 —— 10 張全撈回來，然後在【記憶體裡】切出 3 筆
  ★ 唯一的線索是日誌裡那一行 WARN HHH90003004（上面幾行）
```

**三件事**：

1. 🔴 **SQL 裡完全沒有 `LIMIT` / `OFFSET` / `FETCH FIRST`。**
2. ✅ **回傳的結果是對的**（3 筆）—— 所以**功能正常、測試會綠**。
3. ⚠️ **唯一的線索是一行 `WARN`**：

```
HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory
```

**「applying in memory」** —— Hibernate 明明白白地告訴你它在記憶體裡分頁了。
而這一行會被埋在啟動與請求的日誌雜訊裡，**沒有人會看到**。

**為什麼 Hibernate 不能把 `LIMIT` 下去**：

```
一張訂單有 2 筆明細，JOIN 之後：

  order_id  line_no  ...
  O-0001    1        ← 這 2 列是【同一張】訂單
  O-0001    2        ←
  O-0002    1
  O-0002    2
  O-0003    1
  ...

如果送 FETCH FIRST 3 ROWS ONLY，資料庫會給前 3 【列】：
  O-0001/1、O-0001/2、O-0003/1

→ Hibernate 組出來的會是「O-0001（2 筆明細）」與「O-0003（【只有 1 筆】明細）」
→ 🔴 O-0003 的明細【被截斷了】—— 一個【錯誤的聚合】
```

📌 **這就是 4.6.6 那個問題的同一張臉**：
**`LIMIT` 算「列」，你要的是「聚合」。**

而這一次 Hibernate 選擇**保護正確性**：它寧可把整組資料撈回來、
在記憶體裡切，也不給你一個明細不完整的訂單。

⚠️ **這個選擇本身是對的**，問題是它**沒有讓你拒絕**：
你要的不是「正確但撈全表」，是「正確而且只撈一頁」。

### 4.8.2 `@EntityGraph` 也一樣

03 章 3.9.4 說 `@EntityGraph` 是「不用改 JPQL 的 `JOIN FETCH`」。
**「一樣」也包含這個坑。**

**實驗 P6-B**：

```java
@EntityGraph(attributePaths = "lines")
Page<OrderEntity> findPageByCurrency(String currency, Pageable pageable);
```

```
=== P6-B @EntityGraph + Pageable（Page<T>，所以還多一句 COUNT） ===
WARN  org.hibernate.orm.query -- HHH90003004: firstResult/maxResults specified with
                                 collection fetch; applying in memory
  要求 3 筆，實際拿到 3 筆，total=40
  SQL → 2 句 SQL
      [1] select oe1_0.id,…,l1_0.order_id,l1_0.line_no,… from orders oe1_0
          left join order_line l1_0 on oe1_0.id=…
      [2] select count(oe1_0.id) from orders oe1_0 where oe1_0.currency=?
  SQL 裡有沒有 LIMIT / OFFSET：🔴 沒有 —— @EntityGraph 也一樣
```

**一樣的 `WARN`、一樣沒有 `LIMIT`。**

⚠️ 而這一次更糟：因為回傳型別是 `Page<T>`，
**那句 `COUNT` 是對的（40），但主查詢把 40 張訂單全部載入了記憶體。**
`total=40` 這個「正確」的數字，正好證明了它讀了全部。

### 4.8.3 ✅ 兩階段查詢

**修法**：把「分頁」與「抓明細」拆成兩句 SQL。

```java
/** 4.8 的正解第一步：只查 id，分頁在這裡做（單表、可用索引）。 */
@Query("SELECT o.id FROM OrderEntity o WHERE o.status = :st ORDER BY o.createdAt ASC, o.id ASC")
List<String> findIdPage(@Param("st") OrderStatus status, Pageable pageable);

/** 4.8 的正解第二步：用那一頁的 id 一次把明細帶回來（沒有分頁，所以不會被記憶體分頁）。 */
@Query("SELECT DISTINCT o FROM OrderEntity o LEFT JOIN FETCH o.lines "
        + "WHERE o.id IN :ids ORDER BY o.createdAt ASC, o.id ASC")
List<OrderEntity> findWithLinesByIds(@Param("ids") List<String> ids);
```

```java
List<String> ids = repo.findIdPage(status, PageRequest.of(0, 3));
List<OrderEntity> page = ids.isEmpty() ? List.of() : repo.findWithLinesByIds(ids);
```

**實驗 P6-C**：

```
=== P6-C ✅ 兩階段查詢：第一階段只查 id（單表，可以分頁） ===
  拿到 3 筆；每一筆的明細數：[2, 2, 2]
  SQL → 2 句 SQL
      [1] select oe1_0.id from orders oe1_0 where oe1_0.status=?
          order by oe1_0.created_at,oe1_0.id offset ? rows fetch first ? rows only
      [2] select distinct oe1_0.id,…,l1_0.order_id,l1_0.line_no,… from orders oe1_0
          left join order_line l1_0 on …
  SQL 裡有沒有 LIMIT / OFFSET：✅ 有 → 分頁真的下到資料庫了
```

✅ **第一句有 `offset ? rows fetch first ? rows only`，而且是單表 —— 索引用得上。**
✅ **第二句沒有分頁，所以沒有 `WARN`，明細也完整（`[2, 2, 2]`）。**

**兩階段的三個細節**：

1. ⚠️ **第一句一定要有 tie-breaker**（`ORDER BY o.createdAt ASC, o.id ASC`）——
   4.4 的規則在這裡尤其重要：
   兩句 SQL 之間如果順序不一致，你會拿到「第一句選的 id」與「第二句排的順序」不一致的結果。
2. ⚠️ **第二句的 `ORDER BY` 要和第一句一樣** ——
   `IN (...)` **不保證回傳順序**，必須自己排。
3. ⚠️ **`ids.isEmpty()` 要先判斷** ——
   02 章 2.6.3 的結論：空集合會展開成 `IN ()`，H2 收，MySQL 是語法錯誤。

**四種做法的最終對照**（**實驗 P6-D**）：

```
=== P6-D 三種做法在【資料變多】時的差別（第 1 頁永遠只要 3 筆） ===
  做法                          撈回幾張訂單    SQL 有分頁嗎
  JOIN FETCH + Pageable         全部符合條件的   🔴 沒有
  @EntityGraph + Pageable       全部符合條件的   🔴 沒有
  兩階段（id 分頁 → IN 查明細）    3 張           ✅ 有
```

### 4.8.4 `@BatchSize`：第三條路

03 章 3.16 欠了 `@BatchSize` 的驗證，這裡補上。

**它的想法不是「一句 SQL」，是「把 N 句變成 N/batch 句」**：

```properties
hibernate.default_batch_fetch_size=10
```

或針對單一關聯：

```java
@OneToMany(mappedBy = "order")
@org.hibernate.annotations.BatchSize(size = 10)
private List<OrderLineEntity> lines = new ArrayList<>();
```

**實驗 P6-E**（10 張訂單，每一張都碰明細）：

```
=== P6-E @BatchSize：10 張訂單、每一張都碰明細 ===
  default_batch_fetch_size=無   → 11 句 SQL（1 + 10，這就是 N+1）
  default_batch_fetch_size=5   → 3 句 SQL
      最後一句帶 5 個 ? → select l1_0.order_id,l1_0.line_no,… from order_line l1_0
                          where l1_0.order_id in (?,?,?,?,?) order by l1_0.line_no
  default_batch_fetch_size=10  → 2 句 SQL
      最後一句帶 10 個 ? → select l1_0.order_id,… from order_line l1_0
                           where l1_0.order_id in (?,?,?,?,?,?,?,?,?,?) order by l1_0.line_no
  ★ @BatchSize 把 N+1 壓成 1+ceil(N/batch)，但【不會】變成 1 句
```

**它的三個特點**：

| 特點 | 說明 |
|---|---|
| ✅ **和分頁完全相容** | 主查詢是單表查詢，`LIMIT` 正常下到資料庫 —— **沒有 `HHH90003004`** |
| ✅ **不用改任何查詢** | 加一個設定就生效，所有 LAZY 關聯都受益 |
| ⚠️ **句數仍隨資料量增加** | 10 筆 → 2 句；100 筆 → 11 句；1000 筆 → 101 句 |

📌 **`@BatchSize` 是「N+1 的止血帶」，不是「N+1 的手術」**：

- 它把「句數 = N+1」變成「句數 = 1 + N/batch」——**係數變小，但仍是線性的**。
- 而它的最大價值是：**你不需要事先知道哪個關聯會被碰**。
  一個複雜的畫面碰了七個關聯，`JOIN FETCH` 要寫七個 `@Query`，
  `default_batch_fetch_size=25` 一行搞定七個。

⚠️ **`batch_fetch_size` 不要設太大**：
它變成 `IN (?,?,?…)` 的參數個數，而**MySQL 的 `max_allowed_packet` 與
最佳化器對超長 `IN` 的處理都有上限**。實務常見值是 **16～50**。

### 4.8.5 決策表

| 情境 | 用什麼 | 為什麼 |
|---|---|---|
| **列表 + 每筆要明細 + 有分頁** | **兩階段查詢** | 唯一能同時做到「分頁下到資料庫」與「明細完整」的 |
| **列表 + 每筆要明細 + 沒有分頁**（筆數確定很少） | `JOIN FETCH` | 1 句 SQL 最省 |
| **列表根本不需要明細** | **投影**（03 章 3.8） | 最省的是「不要撈」——`OrderSummaryView` 就是這個 |
| **一個畫面碰很多個關聯** | **`@BatchSize`** | 不用為每個關聯寫 `JOIN FETCH` |
| **`@ManyToOne`（多對一）+ 分頁** | `JOIN FETCH` **可以**用 | ⚠️ **多對一不會讓列數變多**，所以沒有這個問題 |

⚠️ **最後一列很重要**：`HHH90003004` 的觸發條件是 **collection fetch**（一對多 / 多對多）。
`JOIN FETCH o.customer`（多對一）**不會**有這個問題 ——
一張訂單只有一個客戶，join 之後還是一列。

📌 **判準**：
**「這個 `JOIN FETCH` 會讓一個聚合佔多列嗎？」**
會 → 不能和分頁一起用。不會 → 沒問題。

---

## 4.9 `COUNT`：總筆數是不是一定要

### 4.9.1 先問「誰在看那個數字」

4.2.3 量過那句 `COUNT` 的成本：**有 `WHERE` 的 `count(*)` 一列都躲不掉。**

現在問一個產品問題：**「共 132,847 筆」這個數字，誰在看、看了會做什麼？**

| 使用者 | 他真的需要總數嗎 |
|---|---|
| App 往下滑的使用者 | ❌ 他要的是「還有沒有更多」 |
| 後台想找某一張訂單的客服 | ❌ 他要的是「找到了沒」——`132,847` 只代表「條件下得不夠細」 |
| 要畫頁碼列（1 2 3 … 6643）的後台 | ✅ 需要 |
| 要知道「這個條件命中幾筆」的營運報表 | ✅ 需要，**但他不需要那一頁的內容** |

📌 **最後一列指出一個常被忽略的事**：
「要總數」與「要內容」是**兩個不同的需求**，把它們綁在同一個 `Page<T>` 裡，
就變成「每次要內容都順便算一次總數」。

### 4.9.2 三種替代

| 做法 | 給前端什麼 | 成本 |
|---|---|---|
| **`hasNext`（`Slice` / keyset）** | 「還有更多」 | **多抓一筆** |
| **上限估計** | 「超過 1,000 筆，請縮小範圍」 | **`LIMIT 1001` 的 `COUNT`**（見下） |
| **估計值** | 「約 13 萬筆」 | 讀統計值（`information_schema` / `EXPLAIN` 的 `rows`） |

**上限估計的寫法**（很實用，卻很少人用）：

```sql
-- 不要問「總共幾筆」，問「有沒有超過 1000 筆」
SELECT count(*) FROM (
    SELECT 1 FROM orders WHERE status = ? FETCH FIRST 1001 ROWS ONLY
) t;
```

**掃描量從「全部符合的列」變成「最多 1001 列」**，
而畫面顯示「1,000+ 筆」對使用者來說**資訊量幾乎一樣**。

⚠️ **這一段 4.7 的 lab 沒有實測**（本章的量測都集中在分頁本身）。
上面那句 SQL 的形狀在 H2 與 MySQL 8 都合法，但**掃描量的實際數字沒有量**。
🔴 **列在 4.16 的「沒有驗證到的」表裡。**

### 4.9.3 讓「不知道」成為一個合法的答案

`Page<T>` 的問題在型別上：**`getTotalElements()` 一定給你一個 `long`。**
「不知道」表達不出來，於是每次都得算。

**所以自己的型別要讓「不知道」合法**：

```java
/**
 * ★ 分頁結果 —— application 層自己的型別，不是 Page<T>。
 *
 * <p>注意 totalElements 是 Optional：
 * 【「不知道總筆數」是一個合法的答案】。
 * Page<T> 沒有這個選項 —— 它的 getTotalElements() 一定給你一個數字，
 * 代價是每一次查詢都多送一句 COUNT。
 */
public record PageResult<T>(List<T> content, int page, int size,
                            boolean hasNext, Long totalElements) {

    public static <T> PageResult<T> of(List<T> content, int page, int size, boolean hasNext) {
        return new PageResult<>(content, page, size, hasNext, null);
    }

    public static <T> PageResult<T> withTotal(List<T> content, int page, int size, long total) {
        return new PageResult<>(content, page, size,
                (long) page * size + content.size() < total, total);
    }

    public Optional<Long> total() { return Optional.ofNullable(totalElements); }

    public boolean knowsTotal() { return totalElements != null; }
}
```

而「要不要總數」變成**請求的一部分**（`PageSpec.needTotal()`），
由**呼叫端**決定，不是由 Repository 的回傳型別決定：

```java
PageSpec.of(0, 20)              // App 的列表：不要總數
PageSpec.of(0, 20).withTotal()  // 後台的頁碼列：要總數
```

**契約測試裡兩條**：

```java
@Test
void 不要總數的時候就真的不知道總數() {
    PageResult<OrderSummaryView> p = inTx(() ->
            port().search(OrderSearchQuery.empty(), PageSpec.of(0, 10)));
    assertThat(p.knowsTotal()).isFalse();
    assertThat(p.total()).isEmpty();
}

@Test
void 要總數的時候總數要對() {
    PageResult<OrderSummaryView> p = inTx(() ->
            port().search(OrderSearchQuery.empty(), PageSpec.of(0, 10).withTotal()));
    assertThat(p.knowsTotal()).isTrue();
    assertThat(p.total()).contains((long) N);
}
```

**實作端「不要總數」怎麼避開 `COUNT`**：

`Specification` 那條路有一個坑 —— 4.6.2 說過 **`JpaSpecificationExecutor` 只給 `Page`，
不給 `Slice`**。所以不能用 `findAll(spec, pageable)`（它一定回 `Page`）。

要走 fluent API：

```java
// ⚠️ ScrollPosition.offset(n) 就是 SQL 的 OFFSET n（不是「第 n 筆之後」）；
//    而 offset=0 要用不帶參數的 ScrollPosition.offset()（它是 isInitial() 的那一個）。
//    這個 off-by-one 是契約測試第 9、10 條抓出來的（4.11.4）。
ScrollPosition from = spec.offset() == 0
        ? ScrollPosition.offset()
        : ScrollPosition.offset(spec.offset());
Window<OrderEntity> window = repo.findBy(nonNull(where), q -> q
        .sortBy(sort).limit(spec.size() + 1).scroll(from));
List<OrderEntity> rows = window.getContent();
boolean hasNext = rows.size() > spec.size();
return PageResult.of(rows.stream().limit(spec.size())
        .map(SpecOrderSearchAdapter::toView).toList(), spec.page(), spec.size(), hasNext);
```

⚠️ **`FetchableFluentQuery` 有 `limit(int)` 但【沒有 offset】** ——
`scroll(ScrollPosition.offset(n))` 是唯一的入口，而它的語意很容易搞錯（見上面那段註解）。

**另一種寫法**：`Pageable` 是一個**介面**，可以自己實作一個支援任意 offset 的：

```java
/**
 * 4.9.3：Pageable 只認「第幾頁 × 每頁幾筆」，
 * 而「跳過 N 筆、抓 size+1 筆」這個需求它表達不出來（offset 必須是 size 的倍數）。
 *
 * <p>Pageable 是一個【介面】，所以可以自己實作一個。
 */
public record OffsetPageable(long offset, int limit, Sort sort) implements Pageable {

    public static OffsetPageable of(long offset, int limit, Sort sort) {
        return new OffsetPageable(offset, limit, sort);
    }

    @Override public boolean isPaged() { return true; }
    @Override public int getPageNumber() { return (int) (offset / limit); }
    @Override public int getPageSize() { return limit; }
    @Override public long getOffset() { return offset; }
    @Override public Sort getSort() { return sort; }
    @Override public Pageable next() { return new OffsetPageable(offset + limit, limit, sort); }
    @Override public Pageable previousOrFirst() {
        return new OffsetPageable(Math.max(0, offset - limit), limit, sort);
    }
    @Override public Pageable first() { return new OffsetPageable(0, limit, sort); }
    @Override public Pageable withPage(int pageNumber) {
        return new OffsetPageable((long) pageNumber * limit, limit, sort);
    }
    @Override public boolean hasPrevious() { return offset > 0; }
}
```

⚠️ 但注意：把 `OffsetPageable` 傳給 `findAll(spec, pageable)` **還是會回 `Page`**，
所以那句 `COUNT` 仍然會發（除非剛好命中 4.2.2 的優化）。
**`OffsetPageable` 解決的是「offset 不是 size 的倍數」，不是「不要 `COUNT`」。**

QueryDSL 與手寫 SQL 那兩條路完全沒有這個問題 ——
`.offset(n).limit(m)` 與 `OFFSET :o ROWS FETCH FIRST :l ROWS ONLY` 本來就是分開的。

📌 **這是 4.6.8 那張表裡「`offset`/`limit` 自由度」那一列的實際意義**：
不是「寫起來比較漂亮」，是**「能不能在不要總數的時候真的不發 `COUNT`」**。

---

## 4.10 `Containing` 與 `%`（03 章欠的驗證）

03 章 3.4.2 用了 `Containing` 但沒驗證它對 `%` 的處理。這裡補上 ——
而結果和我原本以為的**相反**。

02 章 2.3.6 的結論是：**參數化擋得住 injection，擋不住萬用字元**。

```java
// 02 章的實測：使用者輸入一個 %，這一句回傳全部
jdbc.query("SELECT … WHERE customer_id LIKE ?", mapper, "%" + input + "%");
```

那 Spring Data 的 `Containing` 呢？

```java
List<OrderEntity> findByCustomerIdContaining(String fragment);
```

**實驗 P10-A**（資料：`A%B`、`AXB`、`A_B`、`C-1`、`C-2`、`VIP-1`）：

```
  資料：[A%B, AXB, A_B, C-1, C-2, VIP-1]

=== P10-A findByCustomerIdContaining(輸入) ===
  輸入 「C-」  → 2 筆｜SQL：where oe1_0.customer_id like ? escape '\'
  輸入 「1」   → 2 筆｜SQL：where oe1_0.customer_id like ? escape '\'
  輸入 「%」   → 1 筆｜SQL：where oe1_0.customer_id like ? escape '\'
  輸入 「_」   → 1 筆｜SQL：where oe1_0.customer_id like ? escape '\'
  輸入 「A%B」 → 1 筆｜SQL：where oe1_0.customer_id like ? escape '\'
  輸入 「A_B」 → 1 筆｜SQL：where oe1_0.customer_id like ? escape '\'
  輸入 「%%」  → 0 筆｜SQL：where oe1_0.customer_id like ? escape '\'
  ★ 意外的好消息：輸入「%」只回 1 筆（真的有 % 的那一筆），不是全部
    SQL 是 `like ? escape '\'` —— Spring Data 【有】幫你跳脫輸入裡的 % 與 _
```

✅ **`Containing` 是安全的**：

- 輸入 `%` → **1 筆**（`A%B`，真的包含 `%` 的那一筆），不是 6 筆。
- 輸入 `_` → **1 筆**（`A_B`），不是 6 筆。
- 輸入 `%%` → **0 筆**（沒有任何客戶編號含有兩個連續的 `%`）。

**做法就寫在 SQL 裡**：`like ? escape '\'` ——
Spring Data 把使用者輸入裡的 `%`、`_`、`\` 都加上 `\` 前綴，
然後宣告 `\` 是跳脫字元。

**對照組**（**實驗 P10-A2**，同一份資料，自己寫的 `LIKE`）：

```
=== P10-A2 對照組：自己寫的 LIKE（沒有跳脫） ===
  輸入 「C-」  → 2 筆：[C-1, C-2]
  輸入 「%」   → 6 筆：[A%B, AXB, A_B, C-1, C-2, VIP-1]
  輸入 「A%B」 → 2 筆：[A%B, AXB]
  🔴 同樣輸入一個 %，這裡回傳【全部 6 筆】
```

🔴 **`A%B` 這個輸入回了 2 筆**（`A%B` 與 `AXB`）——
使用者搜尋「A%B」，卻搜到了「AXB」。這不只是效能問題，是**功能錯誤**。

📌 **所以規則是**：

| 寫法 | 有跳脫嗎 | 你要做什麼 |
|---|---|---|
| 派生查詢 `Containing` / `StartingWith` / `EndingWith` | ✅ **有** | 什麼都不用 |
| `@Query("… LIKE %:kw%")` | 🔴 **沒有** | 自己跳脫 |
| `@Query("… LIKE CONCAT('%', :kw, '%')")` | 🔴 **沒有** | 自己跳脫 |
| `JdbcTemplate` / `JdbcClient` 的 `LIKE` | 🔴 **沒有** | 自己跳脫（02 章 2.3.6） |

**自己跳脫的寫法**（**實驗 P10-B**）：

```java
String escaped = input.replace("!", "!!").replace("%", "!%").replace("_", "!_");
jdbc.queryForList("SELECT customer_id FROM orders WHERE customer_id LIKE ? ESCAPE '!'",
        String.class, "%" + escaped + "%");
```

```
=== P10-B ✅ 自己寫 LIKE 時要自己跳脫（ESCAPE 子句） ===
  輸入 「%」   → 跳脫成 「!%」    → [A%B]
  輸入 「A%B」 → 跳脫成 「A!%B」  → [A%B]
  輸入 「A_B」 → 跳脫成 「A!_B」  → [A_B]
```

⚠️ **三個細節**：

1. **跳脫字元本身要先跳脫**（`replace("!", "!!")` 必須在最前面），否則
   輸入 `!%` 會變成 `!%` → 被當成「跳脫的 %」→ 語意錯了。
2. **`ESCAPE` 子句是必要的** —— 不寫的話，MySQL 預設 `\` 是跳脫字元，
   但**H2 與 PostgreSQL 的行為不同**，而且 `\` 在 Java 字串裡還要再跳脫一次，
   非常容易寫錯。**用 `!` 或 `|` 這種不會出現在資料裡的字元最省事。**
3. ⚠️ **`LIKE '%xxx%'` 前面那個 `%` 讓索引完全用不上** ——
   跳脫解決了正確性，沒有解決效能。
   真的要做全文搜尋，用資料庫的全文索引或搜尋引擎（不在本課範圍）。

---

## 4.11 shop-service 的實作

### 4.11.1 為什麼不直接用 `Pageable` 與 `Page`

**最省事的寫法是這個**：

```java
// 🔴 application 層
public interface OrderSearchPort {
    Page<OrderSummaryView> search(OrderSearchQuery query, Pageable pageable);
}
```

**它有三個問題，而三個都在本章實測過**：

| # | 問題 | 證據 |
|---|---|---|
| 1 | `Pageable` / `Page` 是 `org.springframework.data` 的型別 —— 用了它，application 層就綁死在一個資料存取框架上 | 00 章 0.4 的規則 2 |
| 2 | **`Pageable` 沒有上限**：`PageRequest.of(0, 2_000_000)` 完全合法 | **4.3.2 實測** |
| 3 | **`Sort` 接受任何字串當屬性名**，而那個字串通常來自 HTTP 查詢參數 | **4.5.1、4.5.4 實測** |

再加上兩個：

| # | 問題 | 證據 |
|---|---|---|
| 4 | `Page` 的 `getTotalElements()` **一定**給你一個數字 → 每次都得算 | **4.2.3 實測（3,985 µs / 10 萬筆）** |
| 5 | `Page` 序列化成 JSON 有 **11 個頂層欄位**，全是 Spring Data 的內部結構 | **4.11.5 實測** |

📌 **這五條加起來就是那個判準**：

> **一個型別如果同時是「框架的型別」與「你的 API 的一部分」，
> 你就同時失去了「換框架」與「改 API」兩種自由。**

### 4.11.2 四個型別

```
example.shop.order.application.port/
├── OrderSearchPort.java      ← 埠（介面）
├── OrderSearchQuery.java     ← 進去的條件（五格，都可為 null）
├── PageSpec.java             ← 進去的分頁（含白名單 SortKey 與 MAX_SIZE）
├── PageResult.java           ← 出來的頁碼分頁結果（total 是 Optional）
├── Cursor.java               ← keyset 的游標（不透明字串）
├── KeysetPage.java           ← 出來的 keyset 結果
└── OrderSummaryView.java     ← 列表用的讀模型（不是 Order，不是 OrderEntity）
```

**埠長這樣**：

```java
/**
 * 訂單搜尋（讀）—— 和 OrderRepository（寫）分開的第二個埠。
 *
 * <p>為什麼分開？00 章 0.6 的理由：
 * 寫的那一側處理聚合與不變量，讀的這一側處理投影與分頁，
 * 兩者的變化速度完全不同，混在一個介面裡會互相拖累。
 */
public interface OrderSearchPort {

    /** 頁碼分頁 —— 給「要跳到第 37 頁」的後台用。 */
    PageResult<OrderSummaryView> search(OrderSearchQuery query, PageSpec spec);

    /** keyset 分頁 —— 給「無限往下滑」的 App 用（4.7）。 */
    KeysetPage<OrderSummaryView> searchAfter(OrderSearchQuery query, Cursor after, int size);
}
```

⚠️ **`OrderSummaryView` 不是 `Order`，也不是 `OrderEntity`**：

```java
/**
 * 列表用的讀模型 —— 它不是 Order。
 *
 * <p>列表不需要明細、不需要不變量、不需要行為，
 * 硬要走「載入完整聚合再轉 DTO」只會多撈一張表（03 章 3.8 的投影）。
 */
public record OrderSummaryView(String id, String customerId, OrderStatus status,
                               long totalMinor, String currency, Instant createdAt) { }
```

📌 **這是 03 章 3.8「投影」與 00 章 0.6「讀寫分離的介面」的合流**：
`OrderRepository.findById()` 回**完整聚合**（有明細、有不變量、可以呼叫 `cancel()`）；
`OrderSearchPort.search()` 回**扁平的讀模型**（六個欄位，沒有行為）。

**兩者不該互相轉換**：把 `Order` 轉成 `OrderSummaryView` 表示你多撈了明細。

### 4.11.3 三個實作，同一個埠

```
example.shop.order.infrastructure/
├── jpa/
│   ├── OrderPageRepository.java          ← JpaRepository + JpaSpecificationExecutor
│   ├── OrderSpecs.java                   ← Specification 的組合
│   ├── SpecOrderSearchAdapter.java        ← 實作一
│   ├── QuerydslOrderSearchAdapter.java    ← 實作二
│   └── OffsetPageable.java               ← 自訂 Pageable（4.9.3）
└── persistence/
    └── JdbcOrderSearchAdapter.java        ← 實作三
```

⚠️ **注意 `SpecOrderSearchAdapter` 上的註解**：

```java
/**
 * 實作一：Specification + JpaSpecificationExecutor（4.6.2）。
 *
 * <p>★ 這個類別是【唯一】知道 Pageable / Sort / Page /
 * ScrollPosition 存在的地方。PageSpec → Pageable 的翻譯只在這裡發生。
 */
@Transactional(propagation = Propagation.MANDATORY, readOnly = true)
public class SpecOrderSearchAdapter implements OrderSearchPort { … }
```

**`Propagation.MANDATORY`** 是 00 章 0.9 的規則：
Repository **不開交易，只參加交易** —— 交易邊界在 Service（05 章會再談一次）。

**`readOnly = true`** 對讀路徑很重要，理由留到 05 章 5.3（它不只是一個提示）。

### 4.11.4 ★★ 16 條契約 × 3 個實作

02 章有 14 條契約 × 3 個實作，03 章加到 4 個實作（12 綠 2 紅）。
這一章的搜尋埠有**自己的一組 16 條**。

**基準資料**（25 張訂單，刻意設計成「每一條斷言都算得出來」）：

```java
/**
 * 基準資料：25 張訂單，O-0001 … O-0025，
 * customerId = C-(i%3+1)、status 四種輪流、
 * createdAt = T0 + i 秒、totalMinor = 1000 * i。
 */
```

**16 條契約**：

| # | 契約 | 守的是哪一節 |
|---|---|---|
| 1 | 零條件時回傳全部的第一頁 | 4.6.2（空條件 → 沒有 `WHERE`） |
| 2 | 單一條件只回符合的 | 4.6.3 |
| 3 | **多個條件是 AND 而不是 OR** | 4.6.3 |
| 4 | **時間區間含頭不含尾** | 半開區間（04-controller 06 章的時間規則） |
| 5 | 全部條件都填也要能查 | 4.6.3（5 格） |
| 6 | **不要總數的時候就真的不知道總數** | **4.9.3** |
| 7 | 要總數的時候總數要對 | 4.9.3 |
| 8 | **走完所有頁不重不漏** | **4.4.1** |
| 9 | 最後一頁的 `hasNext` 是 `false` | 4.2.1 |
| 10 | 超出範圍的頁回空清單而不是例外 | —— |
| 11 | 預設排序是最新的在前面 | 4.4.5 規則 2 |
| 12 | 指定排序欄位 | 4.5.5 |
| 13 | **keyset 走完所有批次不重不漏** | **4.7** |
| 14 | keyset 的條件與搜尋條件可以並用 | 4.7 |
| 15 | **游標是不透明字串而且可以往返** | **4.7.7** |
| 16 | 壞掉的游標要給清楚的錯誤 | 4.7.7 |

**第 8 條長這樣**（它是 4.4.1 那個 bug 的守門測試）：

```java
@Test
void 走完所有頁不重不漏() {
    List<String> seen = new ArrayList<>();
    int page = 0;
    while (true) {
        final int p = page;
        PageResult<OrderSummaryView> r = inTx(() ->
                port().search(OrderSearchQuery.empty(), PageSpec.of(p, 7)));
        seen.addAll(r.content().stream().map(OrderSummaryView::id).toList());
        if (!r.hasNext()) break;
        page++;
        assertThat(page).isLessThan(20);            // 防無窮迴圈
    }
    assertThat(seen).hasSize(N);
    assertThat(new HashSet<>(seen)).hasSize(N);
}
```

⚠️ **`hasSize(N)` 與 `new HashSet<>(seen).hasSize(N)` 兩條都要**：
第一條抓「總數不對」（遺漏或提早結束），第二條抓「有重複」。
**只寫其中一條會漏掉 4.4.1 那種「重複一筆 + 遺漏一筆」的情況**（總數剛好對）。

**第一次執行的結果**：🔴 **不是全綠。**

```
[ERROR] Tests run: 16, Failures: 6, Errors: 0 -- in lab.SpecSearchContractTest
[ERROR] Tests run: 16, Failures: 4, Errors: 0 -- in lab.QuerydslSearchContractTest
[ERROR] Tests run: 16, Failures: 4, Errors: 0 -- in lab.JdbcSearchContractTest
```

**兩組不同的失敗**：

**① 三個實作都紅的 4 條**（第 4、11、12、15 條）—— 是**測試自己的問題**：
我沿用了另一個實驗的資料產生器，它的 id 格式是 `O-%07d`、客戶是 `C-(i%1000)`，
而契約斷言寫的是 `O-0004` 與 `C-1`。
**契約測試第一次跑通常會先抓到自己的資料假設** —— 這也算它的價值之一。

**② 只有 `Spec` 實作紅的另外 2 條**（第 8、9 條）—— 是**真的 bug**：

```
[ERROR] SpecSearchContractTest>OrderSearchContract.走完所有頁不重不漏
        Expected size: 25 but was: 26 in: …
[ERROR] SpecSearchContractTest>OrderSearchContract.最後一頁的hasNext是false
        Expected size: 5 but was: 6 in: …
```

**26 筆（多了一筆）、最後一頁 6 筆（多了一筆）** —— 一個典型的 off-by-one。

**病因**：我以為 `ScrollPosition.offset(n)` 的語意是「位置在第 n 筆，從 n+1 開始」，
所以寫了 `ScrollPosition.offset(spec.offset() - 1)`。

**實際上 `ScrollPosition.offset(n)` 就是 SQL 的 `OFFSET n`。**

```java
// 🔴 錯的
ScrollPosition from = spec.offset() == 0
        ? ScrollPosition.offset()
        : ScrollPosition.offset(spec.offset() - 1);   // ← 少跳一筆

// ✅ 對的
ScrollPosition from = spec.offset() == 0
        ? ScrollPosition.offset()
        : ScrollPosition.offset(spec.offset());
```

⚠️ **為什麼會搞錯**：因為 `Window.positionAt(i)` 的行為**看起來**是另一種語意 ——
第一批抓 3 筆，`positionAt(2)` 回的是 `OffsetScrollPosition [3]`，不是 `[2]`。
**「位置」在回傳時指「已經消費了幾筆」，在傳入時指「跳過幾筆」** ——
兩邊剛好對得上，但如果你只看其中一邊就會推錯。

📌 **這個 bug 的形狀值得記住**：

> **只有三個實作中的一個是紅的。**
>
> 如果只有 `Spec` 一個實作，這條測試也會紅 —— 但你會先懷疑**測試寫錯了**
> （畢竟「多一筆」看起來很像斷言邊界沒算好）。
> **有另外兩個實作是綠的，就直接證明了「不是契約的問題，是這個實作的問題」。**

**修好之後**：

```
[INFO] Tests run: 16, Failures: 0, Errors: 0, Time elapsed: 3.094 s -- in lab.QuerydslSearchContractTest
[INFO] Tests run: 16, Failures: 0, Errors: 0, Time elapsed: 1.082 s -- in lab.SpecSearchContractTest
[INFO] Tests run: 16, Failures: 0, Errors: 0, Time elapsed: 0.987 s -- in lab.JdbcSearchContractTest
[INFO] Tests run: 48, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
```

**48 個全綠**（16 × 3）。

⚠️ **和 03 章 3.10.6 同一個提醒：48 條綠燈不代表三個實作可以互換。**
契約測試**看不到**的差異：

| 契約看不到 | 三個實作的實際差異 |
|---|---|
| 那句 `COUNT` 發了沒 | `Spec`（`needTotal=false` 時走 `Window`，不發）／QueryDSL（自己決定）／JDBC（自己決定） |
| keyset 的 `WHERE` 形狀 | `Spec` 與 QueryDSL 只能產生 **OR 形式**；JDBC 可以選（⚠️ 而哪一種比較好**取決於資料庫**，見 4.7.4b） |
| SQL 句數 | 三個都是 1～2 句，但 `Spec` 在 `needTotal=true` 時是 2 句 |
| 打錯屬性名何時發現 | QueryDSL 編譯期；另兩個執行期 |

📌 **第二列是本章最重要的一句話**：
**同一組契約全綠的兩個實作，在 10 萬筆的深位置上，一個掃 21 列、一個掃 100,001 列。**
**契約測試保證「答案一樣」，不保證「代價一樣」。**

### 4.11.5 `Page` 不可以外流到 HTTP

**實驗 P9-D**（把 `Page<T>` 直接序列化）：

```
=== P9-D 🔴 直接把 Page<T> 丟出去：JSON 長這樣 ===
  {"content":[{"id":"O-0001","customerId":"C-1","status":"PAID","totalMinor":1000,
   "currency":"TWD","createdAt":1772323201.000000000}],
   "pageable":{"pageNumber":0,"pageSize":20,
               "sort":{"unsorted":false,"sorted":true,"empty":false},
               "offset":0,"paged":true,"unpaged":false},
   "totalPages":2,"last":false,"totalElements":25,"first":true,
   "numberOfElements":1,"size":20,"number":0,
   "sort":{"unsorted":false,"sorted":true,"empty":false},"empty":false}
  ★ 頂層有 11 個欄位：content, pageable, totalPages, last, totalElements, first,
                      numberOfElements, size, number, sort, empty
  🔴 `pageable`、`sort`、`empty`、`numberOfElements` 全都是 Spring Data 的內部結構
  🔴 升級 Spring Data 就可能改形狀 —— 而它是你的【公開 API】
```

**四個問題**：

1. **11 個頂層欄位**，其中至少 6 個對前端毫無意義（`empty`、`paged`、`unpaged`…）。
2. **`sort` 出現兩次**（頂層一個、`pageable` 裡一個），內容一樣。
3. **`pageable` 是一個巢狀物件**，而它是 Spring Data 的**內部型別** ——
   它的欄位在版本之間會變。
   （Spring Boot 3.3 之後啟動時會印一行警告，建議改用 `PagedModel` 包裝，
   🔴 本章的 3.2.5 沒有那行警告。）
4. ⚠️ **欄位順序不穩定**：上面這一份是某次執行的輸出，
   另一次執行同一段程式碼得到的順序是
   `totalPages, totalElements, last, first, …`（`last` 與 `totalElements` 換了位置）——
   因為 `PageImpl` 沒有 `@JsonPropertyOrder`，Jackson 靠反射列舉屬性。

**對照組**（**實驗 P9-E**，自己的 `PageResult`）：

```
=== P9-E ✅ 自己的 PageResult：JSON 由你決定 ===
  {"content":[…],"page":0,"size":20,"hasNext":true,"totalElements":25}
  {"content":[…],"page":0,"size":20,"hasNext":true,"totalElements":null}
```

**5 個欄位，`record` 保證順序，`totalElements` 是 `null` 就明確表示「不知道」。**

⚠️ **注意 `createdAt` 序列化成 `1772323201.000000000`** ——
那是因為實驗裡的 `ObjectMapper` 沒有關掉 `WRITE_DATES_AS_TIMESTAMPS`。
真實專案裡 Spring Boot 的預設設定會給 ISO-8601 字串
（04-controller 06 章講過這件事，那一章有實測）。

### 4.11.6 六條守門規則

**規則 10：application 層不可以認識 Spring Data 的分頁型別**

```java
@Test
void 規則10_application層不可以認識spring_data的分頁型別() {
    ArchRule rule = noClasses()
            .that().resideInAPackage("..application..")
            .should().dependOnClassesThat()
            .resideInAnyPackage("org.springframework.data.domain..",
                                "org.springframework.data.jpa..",
                                "com.querydsl..")
            .because("Pageable / Page / Sort / Specification 是資料存取框架的型別；"
                    + "application 層用了它，就換不掉實作了（4.11.1）");
    rule.check(CLASSES);
}
```

**規則 11：`Page` / `Slice` / `Window` 不可以出現在埠的簽章上**

```java
@Test
void 規則11_page的型別不可以出現在埠的簽章上() {
    ArchRule rule = noClasses()
            .that().resideInAPackage("..application.port..")
            .should().dependOnClassesThat().haveSimpleName("Page")
            .orShould().dependOnClassesThat().haveSimpleName("Slice")
            .orShould().dependOnClassesThat().haveSimpleName("Window")
            .because("回傳型別要是 PageResult / KeysetPage，"
                    + "總筆數是不是【可選的】必須由這一層決定（4.9）");
    rule.check(CLASSES);
}
```

**確認這兩條真的會紅**（放進一個故意違規的檔案）：

```java
package example.shop.order.application.bad;

public class LeakyOrderQueryService {
    public Page<OrderSummaryView> search(Pageable pageable) {
        return new PageImpl<>(List.of(), pageable, 0);
    }
    public Pageable defaultPage() { return PageRequest.of(0, 20); }
}
```

```
[ERROR] Tests run: 6, Failures: 2, Errors: 0

Architecture Violation [Priority: MEDIUM] - Rule 'no classes that reside in a package
'..application..' should depend on classes that reside in any package
['org.springframework.data.domain..', …]' was violated (7 times):
  Method <…LeakyOrderQueryService.defaultPage()> calls method
      <org.springframework.data.domain.PageRequest.of(int, int)> in (LeakyOrderQueryService.java:18)
  Method <…LeakyOrderQueryService.defaultPage()> has return type
      <org.springframework.data.domain.Pageable> in (LeakyOrderQueryService.java:0)
  Method <…LeakyOrderQueryService.search(org.springframework.data.domain.Pageable)> calls
      constructor <org.springframework.data.domain.PageImpl.<init>(…)> in (…:15)
  Method <…search(…)> has parameter of type <org.springframework.data.domain.Pageable> in (…:0)
  Method <…search(…)> has return type <org.springframework.data.domain.Page> in (…:0)

Architecture Violation [Priority: MEDIUM] - Rule 'no classes that reside in a package
'..application.port..' should depend on classes that have simple name 'Page' or …'
was violated (1 times)
```

✅ **兩條都紅**。移除違規檔案之後：

```
[INFO] Tests run: 6, Failures: 0, Errors: 0
```

⚠️ **注意 ArchUnit 抓到的是五種依賴**：呼叫方法、參數型別、回傳型別 ——
**`import` 註解掉也躲不過**，因為它讀的是 bytecode。

**規則 12：排序欄位只能來自白名單 enum**（4.5.5 的 `SortKey.parse`，實驗 P11-A）

**規則 13：`size` 的上限擋在 application 層**（4.5.6 的 `PageSpec`，實驗 P11-B）

**規則 14：列表查詢的 SQL 句數不可以隨資料量增加**

```java
@Test
void 規則14_列表查詢的sql句數不可以隨資料量增加() {
    int[] counts = new int[2];
    int i = 0;
    for (int n : new int[]{10, 40}) {
        try (AnnotationConfigApplicationContext ctx = SearchLab.context()) {
            Seed.forContract(ctx.getBean(DataSource.class), n);
            OrderSearchPort port = (OrderSearchPort) ctx.getBean("specSearch");
            TransactionTemplate tx = SearchLab.tx(ctx);
            SqlSpy.start();
            CountingDataSource.start();
            tx.executeWithoutResult(s -> port.search(OrderSearchQuery.empty(), PageSpec.of(0, 5)));
            counts[i++] = Math.max(SqlSpy.stop().size(), CountingDataSource.stop().size());
        }
    }
    assertThat(counts[0]).isEqualTo(counts[1]);
}
```

```
=== P11-C 守門測試：同一支查詢，10 筆與 40 筆各送出幾句 SQL ===
  10 筆資料 → 1 句 SQL
  40 筆資料 → 1 句 SQL
  ★ 兩個數字一樣 → 沒有 N+1。這一條要放進 CI
```

📌 **這是 03 章練習 4 那條測試的正式版**，而它的判準是本章反覆出現的那一個：
**不是「句數小不小」，是「句數會不會隨資料量長」。**

**規則 15：`JOIN FETCH` 的查詢不可以帶 `Pageable`**

這一條有一個不尋常的寫法 —— **它斷言的是「現況」**：

```java
@Test
void 規則15_join_fetch的查詢不可以帶pageable() {
    // …
    boolean paged = sqls.stream().anyMatch(q -> {
        String l = q.toLowerCase();
        return l.contains("fetch first") || l.contains("limit ") || l.contains("offset ");
    });
    assertThat(paged)
            .as("JOIN FETCH + Pageable 沒有把 LIMIT 送到資料庫 —— 4.8")
            .isFalse();     // ⚠️ 這一條【故意】斷言「就是沒有」，用來記錄現況
}
```

```
=== P11-D 守門測試：JOIN FETCH + Pageable 會在記憶體裡分頁 ===
WARN  org.hibernate.orm.query -- HHH90003004: firstResult/maxResults specified with
                                 collection fetch; applying in memory
  SQL 有沒有把分頁下到資料庫：🔴 沒有
  ★ 這條測試斷言的是「現況」：哪天 Hibernate 修好了，它會【變紅】，
    而那正是你想知道的事（可以把兩階段查詢的變通拿掉了）
```

⚠️ **這種「斷言 bug 存在」的測試（有人叫它 characterization test）有兩個用途**：

1. **記錄一個變通措施的理由**。兩階段查詢比 `JOIN FETCH` 多一句 SQL、多 20 行程式碼；
   三年後有人會問「為什麼不直接 `JOIN FETCH`」——
   **這條測試就是答案，而且是一個可執行的答案。**
2. **在框架修好的那一天通知你**。它會變紅，而那是好消息。

📌 **對照另一種常見做法**：在程式碼裡寫一行 `// Hibernate 不支援 fetch + 分頁`。
三年後那行註解可能已經是錯的，而**沒有人會知道**。

⚠️ **但這種測試要在名字或訊息裡寫清楚它斷言的是 bug**，
否則下一個人看到它變紅會「順手修好」——把斷言反過來，於是變通措施永遠留著。

**另外還有一條掃描規則要更新**：02 章 2.3.8 那條「不准把 SQL 用字串拼接」，
在有了 4.6.5 之後必須放寬成「**不准把非常數拼進 SQL**」。
（實務做法是靜態分析工具的 SQL injection 規則，或 CodeQL / SpotBugs 的
`SQL_INJECTION_JDBC` / `SQL_NONCONSTANT_STRING_PASSED_TO_EXECUTE`。
🔴 本章沒有實測這些工具，列在 4.16。）

---

## 4.12 常見誤區

| 誤區 | 實際 | 哪一節 |
|---|---|---|
| 「反正 `Page` 資訊最多，一律用 `Page`」 | 每次搜尋都多掃一遍全部符合的列（10 萬筆 = 3,985 µs） | 4.2.3 |
| 「`Page` 一定會多一句 `COUNT`」 | **最後一頁與空結果不會發** —— 但那不是大部分的請求 | 4.2.2 |
| 「`nullsLast()` 可以控制 `NULL` 排在哪」 | 🔴 **Spring Data JPA 靜默忽略它**，SQL 完全一樣 | **4.3.4** |
| 「`ORDER BY created_at` 就有排序了」 | 🔴 **12 筆翻三頁只看到 11 筆**（沒有併發） | **4.4.1** |
| 「排序鍵重複的機率很低」 | 促銷開賣那一秒與批次匯入是**必然**重複 | 4.4.3 |
| 「補了 tie-breaker 分頁就穩了」 | `OFFSET` 還會被期間的插入推著跑 —— 那個修不掉 | 4.4.4 |
| 「`Sort` 是有型別的物件，所以安全」 | 屬性名是字串；打錯 → **500 + entity 類名洩漏** | 4.5.2 |
| 「Spring Data 會擋 `Sort` 的 injection」 | JPQL 那條路會；**原生 SQL + `Pageable`** 那條路只擋一半 | **4.5.4** |
| 「`JpaSort.unsafe` 只是名字嚇人」 | 🔴 **子查詢真的被拼進 `ORDER BY` 並執行** | 4.5.4 |
| 「`?size=` 沒有上限很危險」 | 有上限，是 **2000** —— 而 `page=abc` 會**靜默**變成預設值 | 4.5.1 |
| 「動態查詢就是 `WHERE 1=1` 加 `if`」 | `Specification` 回 `null` 就不會有 `WHERE`；`1=1` 汙染 SQL 指紋 | 4.6.2 |
| 「用 `Specification` 就不會有 SQL 問題」 | 🔴 **join 到明細 + 分頁 → 5 張訂單只看到 2 張** | **4.6.6** |
| 「join 完加 `distinct` 就對了」 | 對，但 `count(distinct)` 有成本；**`EXISTS` 更好** | 4.6.7 |
| 「深分頁慢是因為資料多」 | 是因為 **`OFFSET N` 一定要真的讀過 N 列** | 4.7.1 |
| 「第 1 頁一定很快」 | 沒有索引的話，**第 0 頁也掃 100,001 列** | 4.7.2 |
| 「keyset 分頁就是加一個 `>` 條件」 | 🔴 寫法會決定走不走得到索引（H2 上差 42 倍） | **4.7.4** |
| 「row value 寫法比較好」 | 🔴 **在 MySQL 8 上它反而慢 26 倍** —— 兩個資料庫的答案相反 | **4.7.4b** |
| 「在 H2 上量過就知道哪一種快」 | 🔴 **這是本課最強的「H2 會騙你」證據** | 4.7.4b、06 章 6.4 |
| 「`EXPLAIN` 說用到索引了就沒事」 | 🔴 用索引**提供順序**和用索引**做 seek** 是兩件事 | 4.7.4 |
| 「Spring Data 內建 keyset，用它就好」 | 🔴 **它產生的是掃 100,001 列的那一種寫法** | **4.7.6** |
| 「游標就把 `lastId` 放在 query string」 | 排序鍵一改，API 就破 —— 要不透明 | 4.7.7 |
| 「keyset 可以取代 `OFFSET`」 | 它給不了「跳到第 37 頁」與「總頁數」 | 4.7.8 |
| 「`JOIN FETCH` 解掉 N+1 就沒事了」 | 🔴 **加上分頁之後它在記憶體裡分頁，只印一行 `WARN`** | **4.8.1** |
| 「`@EntityGraph` 比 `JOIN FETCH` 安全」 | 一樣的坑、一樣的 `WARN` | 4.8.2 |
| 「`@BatchSize` 可以解決 N+1」 | 它把 N+1 壓成 1+N/batch —— **仍是線性的** | 4.8.4 |
| 「`JOIN FETCH` 不能配分頁」 | ⚠️ **多對一可以** —— 觸發條件是 collection fetch | 4.8.5 |
| 「`Containing` 對 `%` 沒有跳脫」 | ✅ **它有**（`like ? escape '\'`）；自己寫的 `LIKE` 才沒有 | **4.10** |
| 「把 `Page<T>` 直接回給前端最省事」 | 11 個頂層欄位、欄位順序不穩定、內部型別外流 | 4.11.5 |
| 「契約測試全綠 = 兩個實作可以互換」 | 🔴 **一個掃 21 列、一個掃 100,001 列，契約看不到** | **4.11.4** |

---

## 4.13 本章練習

### 練習 1：找出這段搜尋 API 的八個問題

```java
@RestController
public class OrderSearchController {

    private final OrderPageRepository repo;

    @GetMapping("/api/orders")
    public Page<OrderEntity> search(
            @RequestParam(required = false) String customerId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String keyword,
            Pageable pageable) {

        Specification<OrderEntity> spec = (root, query, cb) -> {
            List<Predicate> ps = new ArrayList<>();
            ps.add(cb.conjunction());
            if (customerId != null) ps.add(cb.equal(root.get("customerId"), customerId));
            if (status != null) ps.add(cb.equal(root.get("status"), status));
            if (keyword != null) {
                var lines = root.join("lines");
                ps.add(cb.like(lines.get("productId"), "%" + keyword + "%"));
            }
            return cb.and(ps.toArray(Predicate[]::new));
        };
        return repo.findAll(spec, pageable);
    }
}
```

**先自己找，再往下看。**

---

**答案（八個）**：

**① 回傳 `Page<OrderEntity>` —— entity 外流 + Spring Data 型別外流**（4.11.1、4.11.5）

- `OrderEntity` 有 LAZY 的 `lines`，Jackson 序列化時會炸 `LazyInitializationException`
  （03 章 3.5.2 實測過），或者更糟：**Open Session In View 開著時它會偷偷 N+1**。
- `Page` 的 JSON 有 11 個頂層欄位、順序不穩定。
- **修**：回 `PageResult<OrderSummaryView>`。

**② `Pageable` 直接綁定 —— 沒有上限、沒有預設排序、`sort` 沒有白名單**（4.3.2、4.5）

- `?size=2000` 合法，`?sort=password` 直接進 `Sort` 造成 500。
- `?sort=` 不帶 → `UNSORTED` → 踩進 4.4 的坑。
- **修**：改收 `page` / `size` / `sort` 三個明確的參數，轉成 `PageSpec`（白名單 + `MAX_SIZE`）。

**③ `ps.add(cb.conjunction())` —— 每一句 SQL 都有 `1=1`**（4.6.2）

- 汙染慢查詢日誌與 SQL 指紋統計。
- **修**：`ps` 空的時候回 `null`。

**④ `cb.equal(root.get("status"), status)` —— `status` 是 `String`，欄位是 enum**

- Hibernate 會試著轉，但**轉不出來就丟一個很難讀的例外**；
  而 `?status=paid`（小寫）會**查不到任何東西而不報錯**。
- **修**：在 Controller 就把它轉成 `OrderStatus`（04-controller 06 章的 enum 綁定），
  轉不出來回 400 並列出合法值。

**⑤ `root.join("lines")` + 分頁 —— 4.6.6 那個 bug**

- 一張訂單有多筆符合的明細時，**那一頁的筆數會變少、`hasNext` 會提早變 `false`**。
- **修**：用 `EXISTS` 子查詢（4.6.7 的修法②）。

**⑥ `cb.like(…, "%" + keyword + "%")` —— 沒有跳脫**（4.10）

- 使用者輸入 `%` → 回傳全部；輸入 `A%B` → 也搜到 `AXB`。
- **修**：自己跳脫 + `ESCAPE`（4.10 的寫法）。

**⑦ 前置 `%` 的 `LIKE` —— 索引完全用不上**（4.10 的細節 3）

- `keyword` 是選填，一旦有人填，這個 API 就變成全表掃描。
- **修**：改成 `StartingWith`（前綴可以用索引），或接一個搜尋引擎，
  或至少加上「keyword 至少 3 個字」的限制。

**⑧ 沒有交易，也沒有 `readOnly`**

- Controller 直接呼叫 Repository → 每一句 SQL 各自開一個自動提交的交易。
- **修**：中間要有一個 Service（`@Transactional(readOnly = true)`），
  Repository 用 `MANDATORY`（00 章 0.9）。

⚠️ **注意這八個問題裡，只有 ①⑥ 在小資料量的測試裡會被發現。**
其他六個都是「測試綠、上線壞」。

---

### 練習 2：這條 keyset 分頁為什麼在正式環境很慢

一個同事看完 4.7 之後把列表改成 keyset 分頁，寫成這樣：

```java
@Query("""
        SELECT o FROM OrderEntity o
         WHERE o.status = :status
           AND (o.createdAt > :lastCreatedAt
                OR (o.createdAt = :lastCreatedAt AND o.id > :lastId))
         ORDER BY o.createdAt ASC, o.id ASC
        """)
List<OrderEntity> seekAfter(@Param("status") OrderStatus status,
                            @Param("lastCreatedAt") Instant lastCreatedAt,
                            @Param("lastId") String lastId,
                            Pageable pageable);
```

索引是 `(status, created_at, id)`。

測試機（5 千筆）很快。正式環境（80 萬筆）**往下滑到第 30 批之後開始明顯變慢，
而且越滑越慢**。

**問題**：
（a）為什麼？
（b）**不改 JPQL 的形狀**（因為 JPQL 沒有 row value）能怎麼修？
（c）如果可以改成原生 SQL，最好的寫法是什麼？

---

**答案**：

**（a）** 這是 4.7.4 的第 ① 種寫法。

`created_at > :ts OR (created_at = :ts AND id > :id)` 對最佳化器來說是**兩個範圍的聯集**，
它無法界定成一個連續範圍，於是退化成
**「從 `status = :status` 的索引起點開始，一列一列套用條件」**。

實測（4.7.4，10 萬筆，**H2**）：**掃 100,000 列 vs 21 列，差 4,762 倍。**

⚠️ **但如果正式環境是 MySQL 8，這一題的診斷要改**（4.7.4b）：
MySQL 對 OR 形式處理得**很好**（`type=range`），所以「越滑越慢」的原因**不會**是這個。
**那時要先 `EXPLAIN` 看 `type` 欄位**，再決定病因 ——
可能是索引不存在、或 `ORDER BY` 與索引順序不合、或根本是 N+1。

「越滑越慢」是因為它**每一批都從索引的開頭掃**，
而符合條件卻被 `OR` 濾掉的列數 = 已經看過的批次數 × 批次大小。
**這正是 `OFFSET` 的行為** —— 換成 keyset 之後**一點都沒改善**。

⚠️ **測試機看不出來**：5 千筆的全掃在記憶體裡是幾百微秒。

**（b）** 補一個邏輯上多餘的下界（4.7.4 的寫法 ③）：

```java
@Query("""
        SELECT o FROM OrderEntity o
         WHERE o.status = :status
           AND o.createdAt >= :lastCreatedAt                 -- ★ 加這一行
           AND (o.createdAt > :lastCreatedAt
                OR (o.createdAt = :lastCreatedAt AND o.id > :lastId))
         ORDER BY o.createdAt ASC, o.id ASC
        """)
List<OrderEntity> seekAfter(…);
```

實測：**掃描列數從 100,000 降到 21。**

⚠️ **並且要驗證它**：加一條測試比對 `EXPLAIN ANALYZE` 的 `scanCount`
（本章 lab 的 `scanCount(jdbc, sql)` 就是這個工具），
否則下一個人「整理」程式碼時會把那行「多餘的」條件刪掉。

**（c）** 原生 SQL 可以用 row value，寫起來最乾淨
（⚠️ **但在 MySQL 8 上要先 `EXPLAIN` 確認 `type=range`** —— 4.7.4b）：

```sql
SELECT id, customer_id, status, total_minor, currency, created_at
  FROM orders
 WHERE status = :status
   AND (created_at, id) > (:lastCreatedAt, :lastId)
 ORDER BY created_at, id
 FETCH FIRST :limit ROWS ONLY
```

⚠️ **兩個附帶條件**：

1. **`ORDER BY` 的方向要和 row value 的比較方向一致** ——
   `(a, b) > (x, y)` 配 `ORDER BY a ASC, b ASC`。
   如果要**降冪**，就是 `(a, b) < (x, y)` 配 `ORDER BY a DESC, b DESC`，
   而且索引最好是 `(status, created_at DESC, id DESC)` 或反向可掃。
2. ⚠️ **不能混方向**：`ORDER BY created_at DESC, id ASC` **無法**用 row value 表達，
   也**無法**用單一索引 seek。這是 keyset 分頁的一個真實限制 ——
   **排序方向必須全部一致。**

---

### 練習 3：讓「跳到第 4,999 頁」變成一件便宜的事 ★

後台的頁碼列需要「跳到第 N 頁」，所以不能用 keyset。
而 4.7.1 證明第 4,999 頁要掃 100,000 列。

**問題**：在不改變「使用者可以跳到任一頁」這個需求的前提下，
設計一個讓深頁也便宜的做法。

**提示**：使用者跳到第 4,999 頁的時候，他真的在意「第 4,999 頁」這個數字嗎？

---

**答案（三個層次，由淺到深）**：

**層次一：只讓 `OFFSET` 掃索引，不要回表**

```sql
-- ① 只用索引取出那一頁的主鍵（covering index，不碰資料列）
SELECT id FROM orders
 WHERE status = ?
 ORDER BY created_at, id
 OFFSET 99980 ROWS FETCH FIRST 20 ROWS ONLY;

-- ② 用 20 個主鍵取完整資料
SELECT … FROM orders WHERE id IN (…20 個…);
```

**這就是 4.8.3 的兩階段查詢，換一個理由用它。**

它**沒有**減少「掃 100,000 列」，但把那 100,000 列的成本
從「讀資料頁 + 回表」降成「讀索引頁」。
在 MySQL + InnoDB 上這個差別**很大**（🔴 本章沒有量測，07-mysql 站補），
因為 `(status, created_at, id)` 索引裡已經有 `id` 了 —— 完全不用碰 clustered index。

⚠️ 在 H2 記憶體資料庫上這個優化幾乎量不出來，所以**本章不宣稱數字**。

**層次二：把頁碼換成「錨點 + 少量 offset」**

觀察：使用者從第 1 頁跳到第 4,999 頁，通常是**拉了一下滾動條**或**點了「最後一頁」**。
而他下一個動作幾乎一定是「上一頁 / 下一頁」。

**所以**：只有「跳躍」那一次付 `OFFSET` 的錢，之後改用 keyset。

```java
public record PagePosition(Cursor anchor, int offsetFromAnchor) { }
```

- 使用者跳到第 4,999 頁 → 付一次 `OFFSET 99980` → 記下那一頁最後一筆當 `anchor`。
- 之後按「下一頁」→ `WHERE (created_at, id) > anchor FETCH FIRST 20` → **21 列**。
- 按「上一頁」→ 反向 keyset → **21 列**。

**一次昂貴的跳躍換來之後每一頁都便宜。**

**層次三：問對的問題 —— 使用者要的不是頁碼**

「跳到第 4,999 頁」這個需求幾乎一定是**代理需求**。真正的需求通常是：

| 使用者說 | 他真正要的 | 便宜的做法 |
|---|---|---|
| 「跳到最後一頁」 | 看**最舊**的訂單 | **把 `ORDER BY` 反過來，取第 1 頁** ← 21 列 |
| 「跳到中間看看」 | 看**某個時間**的訂單 | 日期選擇器 → 一次 keyset seek |
| 「我要看全部」 | 匯出 | CSV 串流（05 章 5.9） |
| 「我要知道有幾筆」 | 一個大概的數字 | 上限估計 / 估計值（4.9.2） |

📌 **「跳到最後一頁」那一列值得特別記住**：
**它是免費的**，只要把排序反過來。
而大部分系統把它實作成 `OFFSET (totalPages-1) * size` ——
**掃全表，只為了取最後 20 筆。**

⚠️ **層次三是唯一真正解決問題的做法**，但它需要改 UI ——
所以實務上通常是「層次一 + 限制最大頁碼」先上，同時推動層次三。

---

### 練習 4：寫一條抓得到 4.6.6 那個 bug 的測試

4.6.6 的 bug 特徵是：**不分頁時正常、每張訂單只有 1 筆符合明細時正常、
測試資料通常都是後者。**

**問題**：寫一條測試，讓它在「有人加了一個 join 到子表的 `Specification` 並拿去分頁」時變紅。
要求：**測試本身不可以知道有幾張訂單符合**（否則它只是一條寫死答案的測試）。

---

**答案**：

**關鍵是「不變量」而不是「期望值」**。三個不變量可以用：

```java
@Test
void 分頁走完的聯集必須等於不分頁的結果() {
    // ★ 資料一定要「一個聚合對應多列」，否則測不到
    seedOrdersEachWithTwoMatchingLines(5);
    Specification<OrderEntity> spec = OrderSpecs.boughtAnyOf(List.of("P-1", "P-2"));

    // 基準：不分頁
    List<String> expected = inTx(() -> repo.findAll(spec)).stream()
            .map(OrderEntity::getId).sorted().toList();

    // 受測：分頁走完
    List<String> seen = new ArrayList<>();
    for (int p = 0; p < 50; p++) {
        final int pp = p;
        Page<OrderEntity> page = inTx(() -> repo.findAll(spec, PageRequest.of(pp, 4,
                Sort.by("createdAt").and(Sort.by("id")))));
        seen.addAll(page.getContent().stream().map(OrderEntity::getId).toList());
        if (!page.hasNext()) break;
    }

    // 不變量 1：聯集要一樣（抓「遺漏」與「提早結束」）
    assertThat(seen.stream().sorted().toList()).isEqualTo(expected);
    // 不變量 2：不可以重複（抓 4.4.1 那種重複）
    assertThat(new HashSet<>(seen)).hasSize(seen.size());
    // 不變量 3：total 要等於基準的筆數（抓 total 算錯）
    Page<OrderEntity> first = inTx(() -> repo.findAll(spec, PageRequest.of(0, 4)));
    assertThat(first.getTotalElements()).isEqualTo(expected.size());
}
```

**為什麼這三條就夠**：

| 不變量 | 抓什麼 | 對應本章 |
|---|---|---|
| 聯集相等 | 遺漏、提早結束（`hasNext` 太早變 `false`） | 4.6.6、4.4.1 |
| 沒有重複 | 排序不穩、`OFFSET` 位移 | 4.4.1、4.4.4 |
| `total` 相等 | `COUNT` 沒有 `distinct` | 4.6.7 |

⚠️ **兩個容易寫錯的地方**：

1. **測試資料必須「一個聚合對應多列」** ——
   `seedOrdersEachWithTwoMatchingLines` 這個名字就是在提醒這件事。
   如果沿用「每張訂單買一種商品」的資料，**這條測試永遠是綠的**。
2. **`for` 迴圈要有上限**（`p < 50`）——
   `hasNext` 壞掉的另一種可能是**永遠是 `true`**，那會讓測試跑到 OOM。

📌 **這條測試最好放在一個「所有分頁查詢都要跑一遍」的參數化測試裡**：

```java
@ParameterizedTest
@MethodSource("everyPagedQueryInTheCodebase")
void 每一個分頁查詢都要滿足這三個不變量(PagedQuery query) { … }
```

**因為 4.6.6 那個 bug 不是「某一個查詢寫錯了」，是「任何 join 到子表的分頁查詢都會中」** ——
守門測試也應該掛在「所有分頁查詢」這個層級上。

---

## 4.14 驗收清單

**分頁的正確性**

- [ ] 每一個分頁查詢的 `ORDER BY` **最後一個鍵是唯一的**（通常是主鍵）。
- [ ] 沒有 `ORDER BY` 的分頁查詢**一個都沒有**（`Pageable` 沒帶 `Sort` 時有預設值）。
- [ ] 有一條測試會「走完所有頁」並斷言**聯集相等 + 沒有重複**。
- [ ] 有 join 到子表的分頁查詢，**已經改成 `EXISTS` 或加了 `distinct`**，
      而且 `total` 有被驗證過。
- [ ] `JOIN FETCH` / `@EntityGraph` **沒有和 `Pageable` 一起用**在一對多關聯上
      （或已經改成兩階段查詢）。

**排序的安全性**

- [ ] 排序欄位**只能**來自一個白名單 enum，錯的值回 **400** 而不是 500。
- [ ] `JpaSort.unsafe(...)` 的參數**全部是常數**（用 grep 確認過）。
- [ ] 原生 SQL 的查詢**沒有**接 `Pageable`，或者它的 `Sort` 已經過白名單。
- [ ] 可為 `NULL` 的欄位**沒有**交給 `Sort` 排（`nullsLast()` 不會生效）。

**分頁的成本**

- [ ] `size` 有上限，而且**擋在 application 層的型別上**（不只是 Web 設定）。
- [ ] `spring.data.web.pageable.max-page-size` 已經從 **2000** 調下來。
- [ ] 每一個 `ORDER BY` 用到的欄位都有能支撐它的索引（含 `WHERE` 欄位在前的複合索引）。
- [ ] 「要不要總筆數」是**呼叫端決定**的，不是回傳型別決定的。
- [ ] 深分頁有處理：限制最大頁碼、或兩階段查詢、或改成 keyset / 日期跳轉。

**keyset 分頁**

- [ ] `WHERE` 條件用的是**補了下界的 OR 形式**（③）——它是兩個資料庫上都安全的唯一寫法，
      而且**在【正式環境的那個資料庫】上 `EXPLAIN` 過**，`type` 是 `range` 不是 `index` / `ALL`（4.7.4b）。
- [ ] 沒有直接相信 `ScrollPosition.keyset()` 產生的 SQL 夠好（4.7.6）。
- [ ] 游標對外是**不透明字串**，壞掉的游標回 400。
- [ ] 排序方向**全部一致**（不能 `created_at DESC, id ASC`）。

**介面設計**

- [ ] application 層**沒有任何** `org.springframework.data` / `com.querydsl` 的型別
      （有 ArchUnit 規則）。
- [ ] HTTP 回應**不是** `Page<T>`，是自己的型別。
- [ ] 列表回傳的是**讀模型**（投影），不是 entity、也不是完整聚合。
- [ ] 搜尋（讀）和 `OrderRepository`（寫）是**兩個埠**。

**測試**

- [ ] 搜尋埠有**契約測試**，而且跑在**至少兩個實作**上。
- [ ] 有一條測試斷言「SQL 句數不隨資料量增加」。
- [ ] 記錄變通措施的 characterization test 在名字或訊息裡**寫清楚它斷言的是 bug**。
- [ ] 微基準的資料庫**關掉了查詢結果快取**（H2 的 `QUERY_CACHE_SIZE=0`）。

---

## 4.15 下一章預告

這一章全部在**讀**。下一章回到**寫**，而問題換一個形狀：

```java
// ① 這兩個 UPDATE 要嘛都成功，要嘛都失敗。誰負責？
orderRepository.save(order);          // 訂單改成 PAID
stockPort.decrease(productId, qty);   // 庫存扣掉

// ② 這一句在 1 萬筆時是 40 秒。為什麼？怎麼變成 0.4 秒？
orderRepository.saveAll(tenThousandOrders);

// ③ 這一句在 20 萬筆時就累積了 200,000 個受管實體。而它「看起來」是串流。
try (Stream<OrderEntity> stream = repo.findAllByStatus(PAID)) {
    stream.forEach(this::export);
}
```

| 問題 | 05 章哪一節 |
|---|---|
| 交易邊界為什麼在 Service 而不是 Repository（00 章 0.9 的完整版） | 5.2 |
| `readOnly = true` 到底做了什麼（不只是一個提示） | 5.3 |
| flush 的時機：為什麼「還沒 `save()` 就查得到」 | 5.4 |
| ★ 例外一拋出來，交易就一定會 rollback 嗎 | 5.5 |
| ★★ **`saveAll()` 為什麼不是批次，以及 `IDENTITY` 主鍵會【完全關掉】批次** | **5.7、5.8** |
| `hibernate.jdbc.batch_size` 與 `rewriteBatchedStatements` | 5.8 |
| ★ 批次寫入時的記憶體：為什麼一定要 `flush()` + `clear()` | 5.9 |
| 批次不等於交易（而 `rewriteBatchedStatements` 會改變答案） | 5.10 |
| ★★ **20 萬筆的串流讀取：`Stream` 真的是串流嗎** | **5.11** |
| 一個交易該多大：長交易的四個代價 | 5.12 |

⚠️ **05 章的第一個實測會延續本章的 4.11.4**：

02 章的 `saveAll()` 至今**仍然是 N 次來回**（README 的程式碼演進表列著）。
把它換成真的批次之後，**同一組契約測試會有一條變紅** ——
而病因和 02 章 2.8.3（`MERGE` 讓樂觀鎖失效）、
03 章 3.10.2（轉接器先載入現況）是**同一個家族的第三個成員**。

📌 **而 4.7.6 那個「內建 keyset 掃 100,001 列」的形狀，05 章會再出現一次**：
**`saveAll()` 這個方法名字說它是批次，而它送出 N 句 `INSERT`。**

---

## 4.16 本章的實驗環境與結果

**環境**（與 00～03 章相同，多了 QueryDSL 與 Web）：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5** |
| Spring Data JPA | **3.2.5** |
| Spring Data Commons | **3.2.5** |
| Hibernate | **6.4.4.Final** |
| **QueryDSL** | **5.0.0（jakarta classifier）** |
| 連線池 | **HikariCP 5.0.1** |
| 資料庫 | **H2 2.2.224**（量測用的連線加 `QUERY_CACHE_SIZE=0`） |
| ArchUnit | **1.3.0** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（12 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **P1** | `List` / `Slice` / `Page` | ✅ **1 / 1 / 2 句 SQL**；`Slice` 抓 `size+1`；🔴 **`Page` 在最後一頁與空結果不發 `COUNT`**（第 3 頁只有 1 句，`total` 仍是 10） |
| **P2** | `Pageable` 與 `Sort` 的解剖 | ✅ `offset = page × size`；`of(-1,20)`／`of(0,0)` 擲例外，**`of(0,2_000_000)` 合法**；七種 `Sort` 的 `ORDER BY`；`ignoreCase()` → `lower(...)`<br>🔴 **`nullsLast()`／`nullsFirst()` 在可為 `NULL` 的欄位上也【完全沒有效果】**（SQL 與結果三種寫法全同）<br>✅ H2 的 `ORDER BY x ASC` 把 `NULL` 排在**最前面** |
| **P3** | ★★ 不穩定排序 | 🔴 **12 筆、單執行緒、無併發，翻三頁只看到 11 筆**（`O-11` 重複、`O-08` 消失）；**同一頁跑三次一致**，跨頁不一致<br>✅ 加 `, id` 之後 12/12 不重不漏<br>🔴 **翻頁期間插入一筆 → `O-06` 出現兩次，新資料永遠看不到** |
| **P4** | ★ 排序欄位的安全性 | ✅ JPQL + `Sort`：`checkSortExpression` 擋掉 `id; DROP TABLE orders` 與 `(SELECT 1)`；🔴 但打錯屬性名是**執行期** 500，訊息**洩漏 entity 類名**<br>✅ **原生 SQL + `Sort` 參數 → 啟動就失敗**（`InvalidJpaQueryMethodException`）<br>🔴 **原生 SQL + `Pageable`：`JpaSort.unsafe("(SELECT count(*) FROM order_line)")` 被原樣拼進 `ORDER BY` 並執行成功** |
| **P5** | ★★ 深分頁 | 🔴 **有索引：第 0 頁掃 20 列（26 µs），第 4,999 頁掃 100,000 列（2,491 µs）**<br>🔴 **沒有索引：每一頁都掃 100,001 列，第 0 頁也是**（~6 ms）<br>🔴 **keyset 的 `OR` 寫法掃 100,000 列（17,914 µs）；row value 掃 21 列（104 µs）；補下界掃 21 列（92 µs）**<br>✅ row value 走完 5 個位置：**掃描列數固定 21** |
| **P6** | ★ `JOIN FETCH` + 分頁 | 🔴 **`JOIN FETCH` + `Pageable`：SQL 裡沒有 `LIMIT`，`HHH90003004` + 記憶體分頁，而結果是對的 3 筆**<br>🔴 **`@EntityGraph` + `Pageable` 完全一樣**<br>✅ **兩階段查詢：第一句有 `offset ? rows fetch first ?`，明細完整 `[2,2,2]`**<br>✅ `@BatchSize`：**11 → 3 → 2 句**（batch = 無／5／10） |
| **P7** | ★★ Scroll API | ✅ `ScrollPosition.keyset()` 走完 12 筆**不重不漏**；**自動把主鍵接到排序尾巴**（修好了 tie-breaker）<br>🔴 **產生的 `WHERE` 是 4 個 `OR` 分支**；`ORDER BY` 欄位重複<br>🔴 **10 萬筆深位置：Spring Data 掃 100,001 列，手寫 row value 掃 21 列** |
| **P8** | ★ 動態查詢 | ✅ **三個實作在 0/1/2/3/5 格下產生【幾乎相同】的 `WHERE`、筆數完全相同**，且**都沒有 `WHERE 1=1`**<br>🔴 **join 到明細 + 每頁 4 筆走完所有頁：5 張訂單只看到 2 張，`hasNext` 說 `false`**<br>✅ `distinct(true)` 與 `EXISTS` 都修好（5/5，`total=5`）；`distinct` 版的 `COUNT` 是 `count(distinct id)` |
| **P9** | Web 綁定與 JSON | ✅ 預設 `default-page-size=20`、**`max-page-size=2000`**、`one-indexed=false`<br>🔴 **`page=-1`／`size=0`／`page=abc` 全部靜默變成預設值，不報錯**<br>🔴 **`?sort=password`、`?sort=(SELECT 1)` 在 Web 層完全沒有檢查**<br>🔴 **`Page<T>` 的 JSON 有 11 個頂層欄位，而且兩次執行的欄位順序不同** |
| **P10** | `Containing` 與 `%` | ✅ **意外的好消息：`Containing` 產生 `like ? escape '\'`，輸入 `%` 只回 1 筆**<br>🔴 **自己寫的 `LIKE` 同樣輸入回全部 6 筆，而 `A%B` 也搜到 `AXB`** |
| **P11** | 六條守門規則 | ✅ 規則 10～15 全綠；**放進違規檔案後規則 10 報 7 個違規、規則 11 報 1 個**，移除後回綠<br>✅ 白名單擋掉 `password`／`id; DROP TABLE orders`／`(SELECT 1)`；`PageSpec` 擋掉 `size>200`<br>✅ 10 筆與 40 筆都是 **1 句 SQL**（沒有 N+1） |
| **P12** | H2 的查詢結果快取 | 🔴 **`QUERY_CACHE_SIZE` 預設是 8**：同一句有條件的 `count` 量到 **16 µs**；關掉之後是 **4,462 µs（279 倍）** |
| **契約** | **16 條 × 3 個實作** | 🔴 **第一次執行：`Spec` 6 紅、QueryDSL 4 紅、JDBC 4 紅**<br>其中 4 條三個實作都紅 = **測試自己的資料假設錯了**；<br>另 2 條只有 `Spec` 紅 = **真的 bug（`ScrollPosition.offset(n)` 的 off-by-one）**<br>→ 修好後 **48 個全綠** |

```
[INFO] Tests run: 16, Failures: 0, Errors: 0 -- in lab.SpecSearchContractTest
[INFO] Tests run: 16, Failures: 0, Errors: 0 -- in lab.QuerydslSearchContractTest
[INFO] Tests run: 16, Failures: 0, Errors: 0 -- in lab.JdbcSearchContractTest
[INFO] Tests run: 165, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
```

**本章的驗證專案：12 組實驗 + 48 條搜尋契約（16 × 3）+ 6 條守門規則，
連同 00～03 章的既有測試共 165 個，全綠。**

⚠️ **過程中還修掉了兩個「實驗自己的 bug」，兩個都值得記錄**：

1. **`JpaLab.contextWithBatchSize()` 用 system property 傳設定值，忘了清掉** ——
   於是 `hibernate.default_batch_fetch_size` 活到 JVM 結束，
   **讓 03 章 H7 那條「10 張訂單 = 11 句 SQL」的測試變成 1 句**。
   ⚠️ **它只在「跑全部測試」時紅，單獨跑 H7 是綠的** —— 一個典型的測試汙染。
2. **新增的 `BadNativeSortRepository` 觸發了 03 章的 ArchUnit 規則 9**
   （`Entity` 不可以離開 jpa 套件）—— 把它移到 `..infrastructure.jpa.bad`
   並在每個容器加 `excludeFilters` 才解決。
   📌 **守門規則發揮作用的樣子就是這樣**：它擋住的是**作者自己**。

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一站會補 |
|---|---|---|
| ~~MySQL 8 上 `OFFSET` 深分頁的真實成本~~ | 4.7.1 | ✅ **06 章 6.4 已補**（第 0 頁 284 µs → 第 4999 頁 7,647 µs，**27 倍**） |
| ~~MySQL 8 的最佳化器對 keyset `OR` 寫法的處理~~ | 4.7.4 | ✅ **06 章 6.4 已補**（結論與 H2 相反，見 4.7.4b） |
| ~~MySQL 8 不支援 `FETCH FIRST`~~ | 4.6.5、4.7 | ✅ **06 章 6.4 已補：MySQL 8.0.46 直接語法錯誤**，本章的原生 SQL **必須改成 `LIMIT`** |
| ~~MySQL 的 `NULL` 排序位置~~ | 4.3.4 | ✅ **06 章 6.4 已補：MySQL 8 和 H2 一樣是 NULLS FIRST**，但 **`NULLS LAST` 語法 MySQL 不支援** |
| `count(distinct id)` 在大表上與 `count(*)` 的成本差 | 4.6.7 | 07-mysql 站 |
| **上限估計（`FETCH FIRST 1001` 的子查詢）的實際掃描量** | 4.9.2 | 07-mysql 站 |
| 索引設計本身（複合索引的欄位順序、covering index） | 4.7.2、練習 3 | **07-mysql 站 03 章** |
| SQL injection 的靜態分析工具（CodeQL / SpotBugs） | 4.11.6 | —— |
| `ScrollPosition.Direction.BACKWARD`（往前翻） | 4.7.8 | —— |
| Open Session In View 開／關對列表 API 的影響 | 練習 1 ① | **05 章 5.6** |
| **真實資料量（百萬級）下的 `@BatchSize` 效果** | 4.8.4 | 06 章、07-mysql 站 |

> 📌 **最後一句話**：
>
> 這一章有**四個實測結果與直覺相反**，而它們是**同一個形狀**：
>
> **① `nullsLast()` 什麼都沒做**（4.3.4）——
> 編譯過、測試綠、產生的 SQL 一個字都沒變。
>
> **② `ORDER BY created_at` 讓一張訂單消失**（4.4.1）——
> 每一頁單獨看都對，合起來少一筆。
>
> **③ Spring Data 內建的 keyset 分頁掃了 100,001 列**（4.7.6）——
> 結果完全正確，代價和它要取代的 `OFFSET` 一樣。
>
> **④ join 到子表的 `Specification` 讓 5 張訂單只剩 2 張**（4.6.6）——
> 不分頁時正常，`hasNext` 還告訴你「沒有下一頁了」。
>
> ⚠️ **四個的共同形狀**：
> **你寫了一個正確的修正 / 一個正確的查詢，
> 而它在「單次」與「小資料量」下【完全正常】。**
>
> **02 章的錯誤會拋例外，03 章的錯誤會靜默寫錯資料，
> 而這一章的錯誤【連錯誤都算不上】—— 它只是「答案的一部分不見了」。**
>
> 📌 **所以這一章的三個工具，每一個都是在「把不可見的東西變可見」**：
>
> ```java
> // ① 把送出去的 SQL 印出來（03 章那 20 行，這一章用了 12 次）
> hibernate.session_factory.statement_inspector=lab.SqlSpy
>
> // ② 把「掃過幾列」印出來 —— 這一章最重要的一個數字
> EXPLAIN ANALYZE SELECT …          →  scanCount: 100000
>
> // ③ 把「合起來看」變成一條測試
> assertThat(seen).hasSize(N);
> assertThat(new HashSet<>(seen)).hasSize(N);
> ```
>
> **而三個裡面最便宜、最少人用的是第 ② 個。**
>
> ⚠️ **最後補一句（06 章寫完之後回頭加的）**：
> **本章每一個 `scanCount` 都是在 H2 上量的，而 4.7.4b 證明了其中一個結論在 MySQL 上是反的。**
> **「量出來的數字」比「猜的」好，但「在正式環境用的資料庫上量出來的數字」才算數。**
> **4.7.4 那個「同一個索引、同一個結果、差 4,762 倍」的發現，
> 靠讀程式碼、讀文件、量時間【都看不出來】——
> 只有 `scanCount` 那個數字會直接告訴你。**
