# 第 03 章：Spring Data 抽象

> 02 章的 `JdbcOrderRepository` 有 **190 行**，每一句 SQL 都是你自己寫的。
> 這一章的第二個實作，核心部分長這樣：
>
> ```java
> public interface SpringDataOrderRepository extends JpaRepository<OrderEntity, String> {
>
>     Optional<OrderEntity> findByIdAndCustomerId(String id, String customerId);
>
>     long countByCustomerId(String customerId);
>
>     List<OrderEntity> findByStatusAndCreatedAtLessThanOrderByCreatedAtAscIdAsc(
>             OrderStatus status, Instant deadline, Limit limit);
> }
> ```
>
> **這個介面沒有任何實作，而它會動。**
>
> ⚠️ **一段會動、但你不知道它為什麼會動的程式碼，是一個負債。**
> 所以這一章的順序是**先拆開它**（3.2 會印出那個代理物件、它背後的目標類別、
> 以及套在上面的**七層攔截器**），再談怎麼用。
>
> **這一章要回答四個問題**：
>
> 1. 這個介面**憑什麼**會動？（3.2）
> 2. 方法名字的規則有幾條？打錯了**什麼時候**會發現？（3.4）
> 3. 明細「全刪重插 vs 逐筆 diff」—— 02 章欠的那個比較（3.7）
> 4. ★ **同一組 14 條契約測試跑在它身上，會綠嗎？**（3.10）
>
> 📌 **第 4 個問題的答案是「12 綠 2 紅」，而其中一條紅燈的病因，
> 和 02 章 2.8.3 那個 `MERGE` 讓樂觀鎖失效的病因是同一個。**
> **只是這一次，它躲在 ORM 後面。**

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說出「一個沒有實作的介面被注入進來時，你手上拿到的到底是什麼」——
  包含**它的真實類別、它背後的目標物件、以及套在中間的七層攔截器各做什麼**。
- 在 `Repository` / `CrudRepository` / `ListCrudRepository` / `JpaRepository` 之間做選擇，
  並說出**為什麼 shop-service 不讓 application 層看到其中任何一個**。
- 讀懂方法命名查詢的文法，並說出**打錯屬性名、寫壞 JPQL、寫壞原生 SQL
  這三種錯誤各自在什麼時候被發現**（答案不一樣，而且差很多）。
- 解釋為什麼 `@Entity` **不能**直接加在領域的 `Order` 上，
  並用一個 `LazyInitializationException` 的實測說明 entity 外流的後果。
- 比較「全刪重插」與「逐筆 diff」在**四種修改情境**下各送出幾句 SQL，
  並說出 JPA 在這件事上**幫你做掉了什麼**。
- 用三種投影（介面、DTO、動態）只查需要的欄位，並看懂它們產生的 SQL。
- 說出三個**契約測試看不到、但一定會咬你**的 JPA 行為：
  `save()` 那次多餘的 `SELECT`、dirty checking、`@Modifying` 繞過持久化情境。
- 判斷一個查詢該用 JdbcTemplate 還是 Spring Data。
- 在一條守門規則擋住了一個**正確**的設計決定時，寫出一個**具名的、有理由的**例外，
  並說出它與「把例外寫成條件」的差別。

---

## 3.2 ★ 沒有實作的介面是怎麼跑起來的

### 3.2.1 先問：你拿到的到底是什麼

與其讀文件，不如**把它印出來**。

**實驗 H1-A**：

```java
SpringDataOrderRepository repo = ctx.getBean(SpringDataOrderRepository.class);

Lab.line("宣告型別      ：%s", SpringDataOrderRepository.class.getName());
Lab.line("實際 class    ：%s", repo.getClass().getName());
Lab.line("是 JDK 動態代理嗎：%s", Proxy.isProxyClass(repo.getClass()));
Lab.line("是 Spring AOP 代理嗎：%s", AopUtils.isAopProxy(repo));

if (repo instanceof Advised advised) {
    Lab.line("代理背後的目標物件：%s", advised.getTargetSource().getTargetClass().getName());
    Arrays.stream(advised.getAdvisors()).forEach(a ->
            Lab.line("    %s", a.getAdvice().getClass().getName()));
}
```

```
=== H1-A 那個介面被注入進來的是什麼 ===
  宣告型別      ：example.shop.order.infrastructure.jpa.SpringDataOrderRepository
  實際 class    ：jdk.proxy2.$Proxy80
  是 JDK 動態代理嗎：true
  是 Spring AOP 代理嗎：true
  代理實作了哪些介面：
      example.shop.order.infrastructure.jpa.SpringDataOrderRepository
      org.springframework.data.repository.Repository
      org.springframework.transaction.interceptor.TransactionalProxy
      org.springframework.aop.framework.Advised
      org.springframework.core.DecoratingProxy
  代理背後的目標物件：org.springframework.data.jpa.repository.support.SimpleJpaRepository
  套了幾層 advice   ：7
      org.springframework.aop.interceptor.ExposeInvocationInterceptor
      org.springframework.data.jpa.repository.support.CrudMethodMetadataPostProcessor$…
      org.springframework.dao.support.PersistenceExceptionTranslationInterceptor
      org.springframework.transaction.interceptor.TransactionInterceptor
      org.springframework.data.projection.DefaultMethodInvokingMethodInterceptor
      org.springframework.data.repository.core.support.QueryExecutorMethodInterceptor
      org.springframework.data.repository.core.support.RepositoryFactorySupport$…
```

**三個結論**：

| 發現 | 意思 |
|---|---|
| 它是 **`jdk.proxy2.$Proxy80`** | 一個 **JDK 動態代理** —— 執行期產生的類別，實作了你那個介面 |
| 背後的目標是 **`SimpleJpaRepository`** | `findById`、`save`、`count` 這些**現成的方法真的有實作**，就在這個類別裡 |
| 中間套了 **7 層攔截器** | 你的每一次呼叫都會穿過它們 |

### 3.2.2 那七層各做什麼

```
你的呼叫：repo.findByCustomerId("C-1")
   │
   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ① ExposeInvocationInterceptor                                        │
│    把「目前這次呼叫」放進 ThreadLocal，讓後面的攔截器拿得到           │
├──────────────────────────────────────────────────────────────────────┤
│ ② CrudMethodMetadataPopulatingMethodInterceptor                       │
│    收集這個方法上的中繼資料（@Lock、@QueryHints、@EntityGraph…）      │
├──────────────────────────────────────────────────────────────────────┤
│ ③ PersistenceExceptionTranslationInterceptor       ★ 02 章 2.12      │
│    把 JPA 的例外翻譯成 org.springframework.dao.* 家族                 │
│    → 這就是為什麼 JPA 實作也會拋 OptimisticLockingFailureException    │
├──────────────────────────────────────────────────────────────────────┤
│ ④ TransactionInterceptor                            ★ 00 章 0.9      │
│    處理 @Transactional。SimpleJpaRepository 上有 @Transactional，      │
│    所以【即使你沒開交易，save() 也會自己開一個】——見 3.2.4 的警告     │
├──────────────────────────────────────────────────────────────────────┤
│ ⑤ DefaultMethodInvokingMethodInterceptor                              │
│    處理介面上的 default 方法（讓你可以在介面裡寫預設實作）             │
├──────────────────────────────────────────────────────────────────────┤
│ ⑥ QueryExecutorMethodInterceptor                    ★★ 核心          │
│    ┌────────────────────────────────────────────────────────────┐    │
│    │ 這個方法在「查詢註冊表」裡嗎？                              │    │
│    │   有 → 執行那個【啟動時就準備好】的查詢，回傳結果 ← 到此為止 │    │
│    │   沒有 → 往下傳給 ⑦                                        │    │
│    └────────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────────┤
│ ⑦ ImplementationMethodExecutionInterceptor                            │
│    自訂實作（XxxRepositoryImpl）的方法走這裡                          │
└──────────────────────────────────────────────────────────────────────┘
   │
   ▼
 SimpleJpaRepository（findById / save / count / delete… 的真實實作）
```

⚠️ **關鍵是第 ⑥ 層**：

> `findByCustomerId` **不是**在被呼叫的時候才「解析名字」的。
> **它在容器啟動時就已經被解析、驗證、並編譯成一個查詢物件了。**
> 呼叫的時候只是**從一張 Map 裡把它撈出來執行**。
>
> 📌 **這一點直接解釋了 3.4.3 的實測結果**：
> **方法名打錯，容器【啟動就失敗】，而不是等到有人呼叫它。**

### 3.2.3 啟動時到底發生了什麼

```
① @EnableJpaRepositories 掃描指定套件，找出所有繼承 Repository 的介面
        ↓
② 對每個介面，註冊一個 JpaRepositoryFactoryBean
        ↓
③ 工廠取得 RepositoryMetadata：領域型別 = OrderEntity、id 型別 = String
        ↓
④ 建立目標物件 SimpleJpaRepository<OrderEntity, String>（現成方法的實作）
        ↓
⑤ ★ 走訪介面上【每一個】方法，決定它的查詢從哪裡來：
        有 @Query      → 解析那段 JPQL（native 的話跳過解析，見 3.6.3）
        沒有           → 用 PartTree 解析方法名（3.4）
        兩者都不是     → 找 XxxRepositoryImpl 裡的同名方法
        ↓                 都找不到 → 🔴 啟動失敗
⑥ 把 ④ 與 ⑤ 包成 ProxyFactory，套上七層攔截器
        ↓
⑦ 產生 JDK 動態代理，放進容器
```

**實驗 H3 量到的啟動時間**：這個只有一個介面的最小容器，**啟動花了 1,119 ms**。

⚠️ **這是「Spring Data 的啟動成本」在實務上的樣子** ——
它與 repository 的**數量**、以及每個介面的**方法數**成正比。
一個有 200 個 repository 的專案，光是第 ⑤ 步就要跑幾千次。

> 📌 **這也是 `spring.data.jpa.repositories.bootstrap-mode=deferred/lazy` 存在的理由。**
> 🔴 **【本章未驗證】那兩個模式的實際效果**（本機只有一個 repository，量不出差別）。

### 3.2.4 這對你有三個實際影響

| 影響 | 說明 |
|---|---|
| **堆疊會很深** | 出錯時的 stack trace 中間有一大段 `$Proxy80` / `ReflectiveMethodInvocation`。**要往下找到 `SimpleJpaRepository` 或你的 SQL 那一層** |
| ⚠️ **`SimpleJpaRepository` 上有 `@Transactional`** | 所以 `repo.save(x)` **就算外面沒有交易，也會自己開一個**。🔴 **這與 00 章 0.9.3 的 `MANDATORY` 原則牴觸** —— 見下方 |
| **`this.` 呼叫不經過代理** | 在自訂實作裡呼叫自己的方法，攔截器全部不生效（02 章 2.15.3 的同一條） |

🔴 **第二列是這一章最重要的一個「架構級」提醒**：

> `SimpleJpaRepository.save()` 的宣告是 `@Transactional`（**不是** `MANDATORY`）。
> **這代表：**
>
> ```java
> // 沒有任何外層交易
> springDataRepo.save(entity);      // ⚠️ 它【自己開一個交易】然後 commit
> springDataRepo.save(another);     // ⚠️ 另一個交易
> // → 兩次寫入不是原子的，而且【沒有任何警告】
> ```
>
> **這正是 00 章 0.9.2 描述的那個事故。**
>
> ✅ **shop-service 的防法**：
> **application 層【看不到】`SpringDataOrderRepository`。**
> 它只看得到 `OrderRepository` 這個埠，而埠的實作
> `JpaOrderRepository` 上掛的是 `@Transactional(propagation = MANDATORY)`。
> **3.5 與 3.10.7 會把這件事變成一條會紅的守門規則。**

---

## 3.3 `Repository` 家族該選哪一個

### 3.3.1 階層與方法數

**實驗 H1-B**：

```
=== H1-B Repository 家族：各層帶進來幾個方法 ===
  Repository（標記介面）       自己宣告 0 個方法，加上繼承共 0 個
  CrudRepository              自己宣告 12 個方法，加上繼承共 12 個
  ListCrudRepository          自己宣告 6 個方法，加上繼承共 15 個
  PagingAndSortingRepository  自己宣告 2 個方法，加上繼承共 2 個
  JpaRepository               自己宣告 14 個方法，加上繼承共 37 個
```

```
Repository<T, ID>                        0 個方法（純標記介面）
   │
   ├── CrudRepository                     12 個：save saveAll findById existsById
   │      │                                     findAll findAllById count delete
   │      │                                     deleteById deleteAll deleteAllById
   │      └── ListCrudRepository          +3 實質：把 Iterable 換成 List
   │
   ├── PagingAndSortingRepository          2 個：findAll(Sort) findAll(Pageable)
   │
   └── JpaRepository                      37 個（含繼承）
          ★ 額外的 14 個都是【JPA 專屬】的：
            flush、saveAndFlush、saveAllAndFlush、
            deleteAllInBatch、deleteAllByIdInBatch、deleteInBatch、
            getReferenceById、getOne（已棄用）、getById（已棄用）…
```

### 3.3.2 判準：介面上多一個方法，就是多一個承諾

⚠️ **選 `JpaRepository` 等於一次公開 37 個方法**，其中包括：

| 方法 | 為什麼危險 |
|---|---|
| `findAll()` | 🔴 **一次撈全部** —— 00 章 0.11.7 的那條「不該做」，而它就大剌剌地擺在那裡 |
| `deleteAll()` | 🔴 **清空整張表**，而且是一個**沒有參數**的方法 |
| `deleteAllInBatch()` | 🔴 同上，而且**繞過**所有 JPA 的生命週期回呼與樂觀鎖 |
| `flush()` | **實作細節外流** —— 呼叫端不該知道「flush」這個概念 |
| `getReferenceById()` | 回傳一個**惰性代理**，離開交易碰它就 `LazyInitializationException`（3.5.2） |

> 📌 **00 章 0.6 判準 6 說的就是這件事**：
> **「這個方法會不會【邀請】別人寫出錯的程式碼？」**
>
> `findAll()` 就是一個邀請。它在 IDE 的自動完成清單裡，就在 `findById` 旁邊。

### 3.3.3 shop-service 的選擇

**兩層防線**：

```java
// ① infrastructure 內部：用 JpaRepository 沒關係，因為它不會外流
public interface SpringDataOrderRepository extends JpaRepository<OrderEntity, String> {
    Optional<OrderEntity> findByIdAndCustomerId(String id, String customerId);
    long countByCustomerId(String customerId);
    …
}

// ② application 看到的是【自己定義的埠】—— 只有七個方法（00 章 0.12.2）
public interface OrderRepository {
    String nextId();
    void save(Order order);
    void saveAll(Collection<Order> orders);
    Optional<Order> findById(String orderId);
    Optional<Order> findByIdVisibleTo(String orderId, Actor actor);
    List<Order> findExpiredPendingPayment(Instant now, int limit);
    long countByCustomerId(String customerId);
}
```

⚠️ **如果你的專案【不做】這個轉接（很多專案不做），那就要往上收斂**：

| 你的情況 | 繼承哪一個 |
|---|---|
| 有轉接器（shop-service） | `JpaRepository` 都可以，因為它被關在 infrastructure 裡 |
| **沒有轉接器，直接給 Service 用** | ✅ **繼承 `Repository<T, ID>`（空的標記介面），然後【一個一個】把需要的方法宣告上去** |
| 折衷 | `ListCrudRepository`（15 個），至少避開 `flush` 與 `deleteAllInBatch` |

```java
// 沒有轉接器時的推薦寫法：從零開始，要什麼加什麼
public interface OrderRepository extends Repository<OrderEntity, String> {
    Optional<OrderEntity> findById(String id);
    OrderEntity save(OrderEntity entity);
    // ★ 沒有 findAll()、沒有 deleteAll() —— 它們【不存在】，所以沒人叫得到
}
```

---

## 3.4 ★ 方法命名查詢

### 3.4.1 名字的文法

Spring Data 用 `PartTree` 解析方法名。**實驗 H2-A 把解析結果印出來**：

```java
PartTree tree = new PartTree("findTop3ByCustomerIdOrderByCreatedAtDesc", OrderEntity.class);
```

```
=== H2-A PartTree 把方法名解析成什麼 ===
  findByCustomerId
        動作=SELECT  limit=null  distinct=false  sort=UNSORTED
        條件=customerId SIMPLE_PROPERTY

  findByStatusAndCreatedAtLessThanOrderByCreatedAtAscIdAsc
        動作=SELECT  limit=null  distinct=false  sort=createdAt: ASC,id: ASC
        條件=status SIMPLE_PROPERTY; createdAt LESS_THAN

  findTop3ByCustomerIdOrderByCreatedAtDesc
        動作=SELECT  limit=3  distinct=false  sort=createdAt: DESC
        條件=customerId SIMPLE_PROPERTY

  findDistinctByStatusIn
        動作=SELECT  limit=null  distinct=true  sort=UNSORTED
        條件=status IN

  countByCustomerId    → 動作=COUNT
  existsByCustomerId   → 動作=EXISTS
  deleteByStatus       → 動作=DELETE
  findByTotalMinorBetween → 條件=totalMinor BETWEEN（吃 2 個參數）
```

**文法的結構**：

```
find | read | get | query | search | stream | count | exists | delete | remove
  └─ Distinct?
      └─ Top<N> | First<N>?
          └─ By
              └─ <屬性><運算子>? ( And | Or <屬性><運算子>? )*
                  └─ OrderBy <屬性> Asc|Desc ( , <屬性> Asc|Desc )*
```

⚠️ **`findByTotalMinorBetween` 吃 2 個參數**（上界與下界）——
**運算子決定了方法要幾個參數，而編譯器不會幫你檢查這件事。**

### 3.4.2 常用運算子

| 關鍵字 | 產生的條件 | 參數個數 |
|---|---|---|
| （省略）/ `Is` / `Equals` | `x = ?` | 1 |
| `Not` | `x <> ?` | 1 |
| `LessThan` / `LessThanEqual` | `x < ?` / `x <= ?` | 1 |
| `GreaterThan` / `GreaterThanEqual` | `x > ?` / `x >= ?` | 1 |
| **`Between`** | `x BETWEEN ? AND ?` | **2** ⚠️ |
| `In` / `NotIn` | `x IN (?, ?, …)` | 1（集合）⚠️ **空集合的問題見 02 章 2.6.3** |
| `IsNull` / `IsNotNull` | `x IS NULL` | **0** ⚠️ |
| `Like` / `NotLike` | `x LIKE ?` | 1 ⚠️ **`%` 要自己放，而且不會跳脫（02 章 2.3.6）** |
| `StartingWith` / `EndingWith` / `Containing` | `LIKE ?%` / `%?` / `%?%` | 1 |
| `True` / `False` | `x = TRUE` | **0** |
| `IgnoreCase` | `UPPER(x) = UPPER(?)` | 1 ⚠️ **索引可能失效** |
| `After` / `Before` | 時間的 `>` / `<` | 1 |

⚠️ **`Containing` 有一個 02 章 2.3.6 的完整重演**：
它產生 `LIKE '%?%'`，而**使用者輸入的 `%` 不會被跳脫**。
🔴 **【本章未驗證】Spring Data 對 `Containing` 的跳脫行為**
（需要一組專門的實驗；02 章 2.3.6 已經證明了原生 JDBC 這一側不跳脫）。
**在確認之前，搜尋框的輸入請自己清理。**

### 3.4.3 ★ 打錯了什麼時候會發現

這是本節**最實用**的一個結果，而三種錯誤的答案**不一樣**。

**實驗 H2-B**（只解析、不啟動容器）：

```
=== H2-B 打錯名字：PartTree 當場就解析不出來 ===
  findByCustmerId          → 🔴 PropertyReferenceException
        No property 'custmerId' found for type 'OrderEntity'; Did you mean 'customerId'
  findByCustomer_Id        → 🔴 PropertyReferenceException
        No property 'customer' found for type 'OrderEntity'; Did you mean 'customerId'
  findByStatusCode         → 🔴 PropertyReferenceException
        No property 'code' found for type 'OrderStatus'; Traversed path: OrderEntity.status
  findByCustomerIdAndNope  → 🔴 PropertyReferenceException
        No property 'nope' found for type 'OrderEntity'
```

✅ **訊息品質很好**：它會說「你是不是要寫 `customerId`」，
`findByStatusCode` 那一列還印出了**它走過的路徑**（`OrderEntity.status` → 再找 `code`）。

**實驗 H3**：把三種錯誤各放進一個容器，看它們**什麼時候**爆炸。

```java
interface BadNameRepository extends JpaRepository<OrderEntity, String> {
    List<OrderEntity> findByCustmerId(String customerId);          // 🔴 少一個 o
}

interface BadJpqlRepository extends JpaRepository<OrderEntity, String> {
    @Query("SELECT o FROM OrderEntity o WHERE o.nosuchfield = :x")  // 🔴 屬性不存在
    List<OrderEntity> broken(String x);
}

interface BadNativeRepository extends JpaRepository<OrderEntity, String> {
    @Query(value = "SELECT * FROM no_such_table WHERE x = :x", nativeQuery = true)   // 🔴 表不存在
    List<OrderEntity> broken(String x);
}
```

```
=== H3 三種錯誤各在什麼時候被發現 ===
  ① 方法名打錯（findByCustmerId）
      ✅ 啟動就失敗：PropertyReferenceException
         —— No property 'custmerId' found for type 'OrderEntity'; Did you mean 'customerId'
  ② @Query 的 JPQL 屬性不存在
      ✅ 啟動就失敗：PathElementException
         —— Could not resolve attribute 'nosuchfield' of '…OrderEntity'
  ③ @Query 的原生 SQL 表不存在
      ⚠️ 啟動【成功】，錯誤要等到【呼叫時】才出現：JdbcSQLSyntaxErrorException
```

🔴 **第三列是這一章最該記住的一件事之一**：

| 寫法 | 什麼時候發現錯誤 | 意義 |
|---|---|---|
| **派生查詢**（方法名） | ✅ **啟動時** | 部署就會失敗 —— 錯誤絕對進不了正式環境 |
| **`@Query` JPQL** | ✅ **啟動時** | 同上（因為 JPQL 認得 entity 的屬性） |
| 🔴 **`@Query` 原生 SQL** | ⚠️ **第一次被呼叫時** | **可能是上線三天後、某個冷門功能被點到的時候** |

> 📌 **這是 3.6.3「原生 SQL 的代價」的實測依據**：
> 原生 SQL 買到了資料庫的全部能力，**賣掉的是啟動時驗證**。
>
> ⚠️ **而 02 章的 `JdbcOrderRepository` 是【全部】原生 SQL** ——
> 所以它一條也沒有啟動驗證。
> **02 章補償這件事的方式是「14 條契約測試」**（2.15.2）——
> **測試覆蓋到的 SQL 才有保障，沒被測到的那些和這裡的第三列一樣危險。**

### 3.4.4 屬性路徑的歧義

**實驗 H2-C**：

```
=== H2-C 「CustomerId」到底是一個屬性還是兩個 ===
  customerId     → customerId（型別 String）
  totalMinor     → totalMinor（型別 long）
  createdAt      → createdAt（型別 Instant）
  status         → status（型別 OrderStatus）
```

⚠️ **`findByCustomerId` 有兩種可能的解讀**：

```
① OrderEntity.customerId          （一個叫 customerId 的屬性）
② OrderEntity.customer.id         （一個叫 customer 的關聯，取它的 id）
```

**Spring Data 的規則是「先試最長的、貪婪比對」**：先找 `customerId`，找不到才拆。

🔴 **危險的情況**：如果你**後來**加了一個叫 `customer` 的關聯欄位，
`findByCustomerId` 的意思**不會**改變（`customerId` 仍然存在、仍然優先），
**但如果你把 `customerId` 改名或刪掉，它會【靜默地】改成走 `customer.id`** ——
查詢從「比對一個字串欄位」變成「JOIN 一張表」。

> 📌 **要明確表達「走關聯」，用底線**：`findByCustomer_Id`。
> **實驗 H2-B 的第二列證明了底線寫法是被解析的**
> （它報的錯是「找不到 `customer` 這個屬性」，而不是「語法錯誤」）。

### 3.4.5 什麼時候「名字」就不夠了

| 症狀 | 該換什麼 |
|---|---|
| 方法名超過 **60 個字元** | `@Query`（3.6） |
| 條件是**動態的**（有些欄位可能沒填） | `Specification` / `Criteria`（04 章） |
| 需要 `JOIN FETCH`、子查詢、`GROUP BY` | `@Query` |
| 需要資料庫專屬語法（`JSON_EXTRACT`、CTE、視窗函數） | **原生 SQL 或 JdbcTemplate**（3.11） |
| 只要幾個欄位 | 投影（3.8） |

⚠️ **一個實務上的界線**：
`findByStatusAndCreatedAtLessThanOrderByCreatedAtAscIdAsc` 已經 **54 個字元**了，
**而它只有兩個條件**。
📌 **shop-service 的規定：超過三個條件就改用 `@Query`**，
因為名字到那個長度之後，**讀名字比讀 SQL 還慢**。

---

## 3.5 ★ Entity 不是領域模型

### 3.5.1 為什麼不能把 `@Entity` 加在 `Order` 上

**最省事的做法顯然是這樣**：

```java
// 🔴 誘惑：省掉一整層轉換
@Entity
@Table(name = "orders")
public final class Order {          // ← 領域的聚合根，直接變成 entity
    @Id private String id;
    …
}
```

**它會撞到五面牆**：

| # | 牆 | 說明 |
|---|---|---|
| 1 | **`final` 不行** | Hibernate 要產生子類別做惰性代理。`Order` 是 `final` 的（00 章 0.12.2） |
| 2 | **需要無參數建構子** | 而 `Order` 刻意只給 `place()` 與 `rehydrate()` 兩個入口，就是為了**不讓任何人建出一個不合法的訂單** |
| 3 | **欄位不能是 `final`** | `Order` 的 `id`、`customerId`、`total`、`createdAt` 全是 `final` |
| 4 | **值物件要拆開** | `Money` 是 `record`，要變成 `@Embeddable`；而 `record` 不能當 `@Embeddable`（它是 final 且沒有無參數建構子） |
| 5 | 🔴 **ArchUnit 規則 1 直接擋下** | 00 章 0.12.5：`..order.domain..` 不可以依賴 `jakarta.persistence..` |

> 📌 **前四點是技術限制，第五點是【設計決定】** ——
> 而第五點才是真正的理由：
>
> **領域模型要能在「沒有資料庫、沒有 ORM、沒有 Spring」的情況下被建立與測試。**
> 一旦 `Order` 上有 `@Entity`，它就再也不是一個純粹的物件了 ——
> 它的生命週期由 `EntityManager` 決定、它的欄位改動會被自動寫回（3.9.2）、
> 它離開交易之後有一半的方法會炸（3.5.2）。

### 3.5.2 實測：entity 離開交易之後

**實驗 H11**：

```java
// 在交易裡查出來，然後把它帶出交易
OrderEntity escaped = tx.execute(s -> repo.findById("O-1").orElseThrow());

// 交易已經結束了
escaped.getCustomerId();       // ①
escaped.getLines().size();     // ②
```

```
=== H11 把 entity 帶出交易，再碰它的 LAZY 集合 ===
  交易已經結束。現在讀 escaped.getCustomerId() → C-1（✅ 一般欄位沒問題）
  讀 escaped.getLines().size() → 🔴 LazyInitializationException：
      failed to lazily initialize a collection of role:
      example.shop.order.infrastructure.jpa.OrderEntity.lines: could not initialize proxy - no Session

  對照：領域埠回傳的 Order，交易外讀 lines() → 1 筆（✅ 它就是普通的 List）
```

⚠️⚠️ **注意 ① 是好的、② 才炸** —— 這正是它難抓的原因：

> **同一個物件，一半的方法可以用、一半會爆炸。**
> 而爆炸的位置**不在資料層**，通常是在：
>
> - **Controller 序列化回應的時候**（Jackson 走訪 `getLines()`）
> - **模板引擎渲染的時候**
> - **記 log 的時候**（`toString()` 碰到了那個集合）
>
> 🔴 **也就是說：錯誤的堆疊指向 Jackson，而真正的原因在三層之外。**

📌 **很多專案的處理方式是打開 Open Session In View（Spring Boot 預設就是開的）**，
讓 session 撐到回應寫完為止。
⚠️ **那只是把問題推遲**：它會讓**序列化過程觸發資料庫查詢**（N+1，3.9.4），
而且**連線會被佔用到回應結束**（01 章 1.8 的「佔用時間」）。

> 🔴 **【本章未驗證】OSIV 開/關的實際差異**（需要一個完整的 web 環境）——
> **04 章會處理它。**

### 3.5.3 轉接器的三個職責

```java
package example.shop.order.infrastructure.jpa;

/**
 * 用 Spring Data JPA 實作同一個埠（03 章）。
 *
 * <p>它是一個<b>轉接器</b>：把 {@link OrderEntity} 換成領域的 {@link Order}，
 * 讓 application 層完全看不到 JPA。
 */
@Repository
@Transactional(propagation = Propagation.MANDATORY)   // ★ 3.2.4：蓋掉 SimpleJpaRepository 的預設
public class JpaOrderRepository implements OrderRepository {

    private final SpringDataOrderRepository repo;

    public JpaOrderRepository(SpringDataOrderRepository repo) { this.repo = repo; }

    @Override
    public Optional<Order> findById(String orderId) {
        return repo.findById(orderId).map(JpaOrderRepository::toDomain);
    }

    /** ★ 在交易【內】就轉成領域物件 —— 之後再也不會有 LazyInitializationException。 */
    static Order toDomain(OrderEntity e) {
        List<OrderLine> lines = e.getLines().stream()
                .map(l -> new OrderLine(l.getProductId(), l.getQuantity(),
                        Money.ofMinorUnits(l.getUnitPriceMinor(), l.getCurrency())))
                .toList();
        return Order.rehydrate(e.getId(), e.getCustomerId(), e.getStatus(), lines,
                Money.ofMinorUnits(e.getTotalMinor(), e.getCurrency()),
                e.getCreatedAt(), e.getVersion());
    }
    …
}
```

**它做了三件事，每一件都對應一個實測**：

| 職責 | 對應的實測 |
|---|---|
| **型別轉換**（`OrderEntity` ⇄ `Order`） | — |
| **在交易內就把 LAZY 集合讀完** | H11：轉出來的 `Order.lines()` 在交易外可以正常讀 |
| ★ **把 dirty checking 關在門外** | H6-C：改了領域物件但沒 `save()`，**不會**被寫進資料庫 |

**實驗 H6-C**：

```
=== H6-C 透過【領域埠】的話呢 ===
  交易結束後的狀態：PENDING_PAYMENT
  ✅ 沒有被寫進去 —— 因為 findById 回傳的是【轉換出來的領域物件】，
     它不是 JPA 管理的 entity，dirty checking 看不到它。
  ★ 所以「轉接器」不只是為了乾淨，它同時把 dirty checking 關在門外。
```

> 📌 **這是一個「意外的好處」，但它非常重要**：
> 有了轉接器，**JPA 實作與 JdbcTemplate 實作的行為就一致了**
> —— 兩者都是「不呼叫 `save()` 就什麼都不會發生」。
> **3.9.2 會展示沒有轉接器時的情況。**

### 3.5.4 代價要說清楚

⚠️ **這一層不是免費的**：

| 代價 | 實際的樣子 |
|---|---|
| **多一組型別** | `OrderEntity` + `OrderLineEntity` + 兩個方向的轉換函式 |
| **多一次物件配置** | 每筆查詢都多建一組物件（**通常不重要，但大量讀取時要量**） |
| ⚠️ **失去 dirty checking** | 你**必須**明確呼叫 `save()`。有人會覺得這是缺點，但 3.9.2 會說明為什麼它是優點 |
| ⚠️ **失去部分 diff 能力** | 3.7 會量它 —— **而結果和直覺不一樣** |

> 📌 **什麼時候【不要】做這一層？**
> **當你的「領域模型」其實就是資料表的形狀時**（CRUD 為主的後台、報表、設定管理）。
> **那種情況下多一層轉換只是打字，沒有換到任何東西。**

---

## 3.6 `@Query`：JPQL 與原生 SQL

### 3.6.1 派生查詢與 `@Query` 產生一樣的 SQL

**實驗 H4-A**：同一個查詢的兩種寫法。

```java
// ① 派生查詢
List<OrderEntity> findByStatusAndCreatedAtLessThanOrderByCreatedAtAscIdAsc(
        OrderStatus status, Instant deadline, Limit limit);

// ② @Query
@Query("""
        SELECT o FROM OrderEntity o
         WHERE o.status = :status AND o.createdAt < :deadline
         ORDER BY o.createdAt ASC, o.id ASC
        """)
List<OrderEntity> findExpired(@Param("status") OrderStatus status,
                              @Param("deadline") Instant deadline,
                              Limit limit);
```

```
=== H4-A 派生查詢 vs @Query：產生的 SQL ===
  派生查詢 findByStatusAndCreatedAtLessThanOrderBy… → 共 1 句 SQL
      [1] select oe1_0.id,oe1_0.created_at,oe1_0.currency,oe1_0.customer_id,
              oe1_0.status,oe1_0.total_minor,oe1_0.version from orders oe1_0 where oe1_0.status=? and o…
  @Query 版本 findExpired → 共 1 句 SQL
      [1] select oe1_0.id,oe1_0.created_at,oe1_0.currency,oe1_0.customer_id,
              oe1_0.status,oe1_0.total_minor,oe1_0.version from orders oe1_0 where oe1_0.status=? and o…
  countByCustomerId → 共 1 句 SQL
      [1] select count(oe1_0.id) from orders oe1_0 where oe1_0.customer_id=?
```

✅ **完全相同的 SQL。** 所以在這兩者之間選擇，**考量的是可讀性與驗證時機，不是效能**。

⚠️ **注意 `SELECT` 出來的是【七個欄位全部】** ——
即使你只需要 id 與狀態。**這是 3.8 投影要解決的事。**

### 3.6.2 三種寫法的取捨

| | 派生查詢 | `@Query` JPQL | `@Query` 原生 SQL |
|---|---|---|---|
| **啟動時驗證** | ✅ 有（H3 ①） | ✅ 有（H3 ②） | 🔴 **沒有**（H3 ③） |
| 換資料庫 | ✅ 不用改 | ✅ 不用改 | 🔴 要改 |
| 表達力 | 低（單表、簡單條件） | 中（JOIN、子查詢、聚合） | **高（資料庫的全部能力）** |
| 可讀性 | 短的時候很好，**長的時候最差** | ✅ 好 | ✅ 好（就是 SQL） |
| 重構（改欄位名） | ✅ IDE 幫你改屬性名 | ✅ 大多數 IDE 認得 JPQL | 🔴 **純字串** |

### 3.6.3 ★ 原生 SQL 買到什麼、賣掉什麼

```java
// 🔴 這個介面可以正常啟動，錯誤要等到有人呼叫它
@Query(value = "SELECT * FROM no_such_table WHERE x = :x", nativeQuery = true)
List<OrderEntity> broken(String x);
```

```
③ @Query 的原生 SQL 表不存在
    ⚠️ 啟動【成功】，錯誤要等到【呼叫時】才出現：JdbcSQLSyntaxErrorException
```

> 📌 **判準**：
> **用原生 SQL 的每一個方法，都必須有一條測試真的呼叫過它。**
>
> 因為對這些方法來說，**測試是你【唯一】的驗證機制** ——
> 派生查詢與 JPQL 有「啟動失敗」這道免費的防線，原生 SQL 沒有。
>
> ⚠️ **而這條規則也適用於 02 章整個 `JdbcOrderRepository`**：
> 它 100% 是原生 SQL，**所以那 14 條契約測試不是「加分項」，是它的唯一防線。**

### 3.6.4 具名參數與兩個常見錯誤

```java
// ✅ 具名參數（02 章 2.6 的同一個理由：不怕順序錯位）
@Query("SELECT o FROM OrderEntity o WHERE o.status = :status AND o.createdAt < :deadline")
List<OrderEntity> findExpired(@Param("status") OrderStatus status,
                              @Param("deadline") Instant deadline);
```

| 🔴 錯誤 | 症狀 |
|---|---|
| `@Query("… FROM orders o …")` 用**表名**而不是 **entity 名** | JPQL 認的是 `OrderEntity`，不是 `orders`。**啟動失敗**（好事） |
| **忘了 `@Param`** 而且沒開 `-parameters` 編譯選項 | 執行期找不到參數名。⚠️ **Spring Boot 的 Maven 外掛預設有開，所以本機正常、換個建置環境就壞** |

---

## 3.7 ★ 明細：全刪重插 vs 逐筆 diff

**02 章 2.8.4 欠了這個比較**，這一節還它。

### 3.7.1 四種情境的實測

**實驗 H9-A**：一張 **20 筆明細**的訂單，用 JPA 分別做四件事。
注意轉接器的程式碼**每次都重建整組明細**（看起來就是「全刪重插」）：

```java
// JpaOrderRepository.save() 裡的寫法 —— 每次都重建整組
entity.replaceLines(toLineEntities(order));

// OrderEntity 裡：
public void replaceLines(List<OrderLineEntity> newLines) {
    lines.clear();                       // orphanRemoval = true
    for (OrderLineEntity l : newLines) { l.setOrder(this); lines.add(l); }
}
```

```
=== H9-A JPA：一張 20 筆明細的訂單 ===
  ① 改一筆的數量      → SELECT 2｜UPDATE 1｜DELETE 0｜INSERT 0
  ② 刪掉最後一筆      → SELECT 2｜UPDATE 0｜DELETE 1｜INSERT 0
  ③ 加一筆            → SELECT 3｜UPDATE 0｜DELETE 0｜INSERT 1
  ④ 什麼都沒改        → SELECT 2｜UPDATE 0｜DELETE 0｜INSERT 0
```

⚠️⚠️ **這個結果和「程式碼看起來在做什麼」完全不一樣**：

> 程式碼是 `clear()` 然後塞 20 個**全新的**物件進去。
> **直覺上應該是 20 個 DELETE + 20 個 INSERT。**
>
> ✅ **實際上：改一筆就只有 1 句 `UPDATE`，什麼都沒改就【一句寫入都沒有】。**
>
> 📌 **原因**：`OrderLineEntity` 的主鍵是 `(order_id, line_no)`（00 章 0.12.3 的決定）。
> Hibernate 在 flush 時是**按主鍵比對**的 ——
> 新塞進去的物件和資料庫裡的那一列**主鍵相同**，於是它被認成「同一列」，
> Hibernate 再逐欄比對，**只對真的變了的那一欄下 `UPDATE`**。

### 3.7.2 對照組：JdbcTemplate 做同一件事

**實驗 H9-B**：同樣的訂單、同樣「改第 5 筆的數量」，跑 02 章 2.15.1 的 `JdbcOrderRepository`。
（用一個計數用的 `DataSource` 代理攔住 `prepareStatement`。）

```
=== H9-B JdbcTemplate（02 章 2.15.1 的實作）：同樣一張 20 筆的訂單 ===
  ① 改一筆的數量  → SELECT 2｜UPDATE 1｜DELETE 1｜INSERT 1（共 5 句 prepareStatement）
        SELECT id, customer_id, status, … FROM orders WHERE id = ?
        SELECT order_id, product_id, quantity, … FROM order_line WHERE order_id IN (?) ORDER BY …
        UPDATE orders SET status = ?, total_minor = ?, currency = ?, version = version + 1 WHERE …
        DELETE FROM order_line WHERE order_id = ?
        INSERT INTO order_line (order_id, line_no, product_id, …) VALUES (?, ?, ?, …)
  ⚠️ 注意 batchUpdate 在這裡算【1 句 prepareStatement、20 次 addBatch】
```

**兩相對照**：

| 情境（20 筆明細的訂單） | JdbcTemplate（全刪重插） | JPA |
|---|---|---|
| ① 改一筆的數量 | `DELETE` 全部 + **重插 20 列** | ✅ **1 句 `UPDATE`** |
| ② 刪掉一筆 | `DELETE` 全部 + 重插 19 列 | ✅ **1 句 `DELETE`** |
| ③ 加一筆 | `DELETE` 全部 + 重插 21 列 | ✅ **1 句 `INSERT`** |
| ④ **什麼都沒改** | 🔴 `DELETE` 全部 + **重插 20 列** | ✅ **零句寫入** |

> 📌 **這是本章對 JPA 最有力的一個論據**，而且它回答了 02 章 2.8.4 那張「四個代價」的表：
>
> | 02 章列的代價 | JPA 還有嗎 |
> |---|---|
> | **寫入放大** | ✅ **沒有了** —— 只寫變動的那一列 |
> | **鎖的範圍變大** | ✅ 小很多（只鎖變動的列） |
> | **外鍵/稽核的連鎖** | ✅ 沒有整批 `DELETE`，就沒有連鎖 |
> | **失去「哪一筆變了」的資訊** | ✅ **反而知道得更清楚**（SQL 就指名了那一列） |
>
> ⚠️ **四個代價，JPA 全部消掉了。**
> **這不是「ORM 比較高級」，是「diff 這件事本來就該由框架做」** ——
> 它需要記住「載入時的樣子」，而那正是持久化情境（persistence context）的工作。

### 3.7.3 ⚠️ 但有三個前提

| 前提 | 不滿足的話 |
|---|---|
| **明細必須有穩定的主鍵** | 如果 `line_no` 會重排（在中間插一筆就重編號），主鍵對不上 → **真的變成全刪重插** |
| **必須在同一個交易裡先載入** | `save()` 一個 detached 的物件時，Hibernate 要先 `SELECT`（3.9.1） |
| **不能用 `@Modifying` 繞過** | 3.9.3 |

🔴 **第一個前提最容易被打破，而代價比想像中大。**

`line_no` 用「陣列索引 + 1」產生（02 章與本章的做法都是），
所以**刪掉第一筆時，後面 19 筆的 `line_no` 全部往前移一格**。

**實驗 H14**：同樣是「刪掉一筆明細」，只差在刪哪一筆。

```
=== H14 一張 20 筆明細的訂單，刪掉【第一筆】 ===
  A 刪【最後】一筆（line_no 不動）    → SELECT 2｜UPDATE 0｜DELETE 1｜INSERT 0（寫入共 1 句）
  B 刪【第一】筆（line_no 全部重編）  → SELECT 2｜UPDATE 19｜DELETE 1｜INSERT 0（寫入共 20 句）
```

🔴 **1 句 vs 20 句。** 同一個業務操作（刪一筆明細），只因為刪的位置不同。

> **原因**：Hibernate 按主鍵 `(order_id, line_no)` 比對。
> 重編之後，**`line_no = 1` 這一列的 `product_id` 從 `P-1` 變成 `P-2`**、
> `line_no = 2` 從 `P-2` 變成 `P-3`⋯⋯**每一列的內容都變了，所以每一列都要 `UPDATE`。**
>
> 📌 **要真正穩定，`order_line` 需要一個「與位置無關」的鍵** ——
> 例如 `product_id`（如果同一張訂單裡商品不重複），或一個獨立的 `line_id`。
> **練習 3 會請你評估這個改動。**

⚠️ **注意這個退化【不會被契約測試抓到】** —— 資料是對的，只是寫了 20 次。
**這是 3.10.6「綠燈不代表行為一樣」的又一個實例。**

### 3.7.4 判準

| 你的情況 | 做法 |
|---|---|
| 用 JPA + **穩定的明細主鍵** | ✅ 讓 JPA 自己 diff（什麼都不用做） |
| 用 JdbcTemplate，明細 **< 50 筆**，沒有別的表參照 | 全刪重插（02 章 2.8.4） |
| 用 JdbcTemplate，明細很多 **或**有別的表參照 | 手寫 diff：算出新增/修改/刪除三組 |
| 明細會被**別的表參照**（出貨明細指向 `order_line`） | 🔴 **絕對不能全刪重插** —— 外鍵會擋，或者更糟：`ON DELETE CASCADE` 把別人的資料也刪了 |

---

## 3.8 投影：只查需要的欄位

3.6.1 的實測裡，每一個查詢都 `SELECT` 了**七個欄位**。
訂單列表頁只需要 id、客戶、金額三欄 —— 剩下四欄是白傳的。

### 3.8.1 三種寫法

```java
public interface SpringDataOrderRepository extends JpaRepository<OrderEntity, String> {

    /** ① 介面投影：宣告你要的 getter，Spring Data 產生一個代理 */
    interface OrderSummary {
        String getId();
        String getCustomerId();
        long getTotalMinor();
    }
    List<OrderSummary> findSummaryByCustomerId(String customerId);

    /** ② DTO 投影：用 JPQL 的建構子表示式 */
    @Query("""
            SELECT new example.shop.order.infrastructure.jpa.OrderSummaryDto(
                       o.id, o.customerId, o.totalMinor)
              FROM OrderEntity o WHERE o.customerId = :cid
            """)
    List<OrderSummaryDto> findDtoByCustomerId(@Param("cid") String customerId);

    /** ③ 動態投影：同一個方法，呼叫端決定回傳什麼形狀 */
    <T> List<T> findByCustomerId(String customerId, Class<T> type);
}
```

```java
public record OrderSummaryDto(String id, String customerId, long totalMinor) { }
```

### 3.8.2 它們真的只查三個欄位嗎

**實驗 H4-B**：

```
=== H4-B 投影：三種寫法各查幾個欄位 ===
  ① 整個 entity（findAll） → 共 1 句 SQL
      [1] select oe1_0.id,oe1_0.created_at,oe1_0.currency,oe1_0.customer_id,
              oe1_0.status,oe1_0.total_minor,oe1_0.version from orders oe1_0

  ② 介面投影 findSummaryByCustomerId → 共 1 句 SQL
      [1] select oe1_0.id,oe1_0.customer_id,oe1_0.total_minor from orders oe1_0 where oe1_0.customer_id=?
      回傳型別：jdk.proxy2.$Proxy86
      內容：id=O-1 customerId=C-1 totalMinor=38000

  ③ DTO 投影 findDtoByCustomerId → 共 1 句 SQL
      [1] select oe1_0.id,oe1_0.customer_id,oe1_0.total_minor from orders oe1_0 where oe1_0.customer_id=?
      內容：OrderSummaryDto[id=O-1, customerId=C-1, totalMinor=38000]

  ④ 動態投影 findByCustomerId(cid, OrderSummaryDto.class) → 共 1 句 SQL
      [1] select oe1_0.id,oe1_0.customer_id,oe1_0.total_minor from orders oe1_0 where oe1_0.customer_id=?
```

✅ **三種投影產生的 SQL 完全相同，而且真的只有三個欄位**（七欄 → 三欄）。

⚠️ **注意 ② 的回傳型別是 `jdk.proxy2.$Proxy86`** ——
介面投影拿到的**不是**一個普通物件，而是**另一個動態代理**（3.2 的同一個機制）。

> 📌 **這有一個實際後果**：
> **介面投影的物件不能直接丟給 Jackson 序列化嗎？可以** ——
> Jackson 認得 getter。
> **但它的 `toString()` / `equals()` / `hashCode()` 是代理的預設實作** ——
> 🔴 **拿它們去比對或當 Map 的 key 會出乎意料。**

### 3.8.3 三種怎麼選

| | 介面投影 | DTO（record） | 動態投影 |
|---|---|---|---|
| 要寫的東西 | 一個 `interface` | 一個 `record` | 一個 `record` + 泛型方法 |
| 回傳的物件 | ⚠️ 動態代理 | ✅ **真的 record** | ✅ 真的 record |
| 派生查詢可用 | ✅ | 🔴 **需要 `@Query` 建構子表示式** | ✅ |
| **巢狀投影** | ✅ 支援（`getCustomer().getName()`） | 要自己組 | ✅ |
| **可以離開 infrastructure 嗎** | 🔴 不行（它綁著 entity 的屬性名） | 🔴 也不建議 | 🔴 同左 |

> 📌 **shop-service 的選擇：DTO（`record`）**，理由是 3.8.4。
>
> ⚠️ **而 `@Query` 的建構子表示式要寫【完整套件名】** ——
> 那是一個字串，**打錯了會在啟動時失敗**（好事，H3 ②）。

### 3.8.4 ⚠️ 投影的型別不可以外流

**這是 00 章 0.11.3 的同一條規則，在 03 章的樣子**：

```java
// 🔴 不要：查詢埠回傳 infrastructure 的型別
public interface OrderQueryDao {
    List<SpringDataOrderRepository.OrderSummary> search(...);   // ← application 認識了 JPA 的內部型別
}

// ✅ 要：查詢埠有自己的回傳型別
public interface OrderQueryDao {
    List<OrderSummaryView> search(OrderSearchCriteria criteria);   // ← application 自己的 record
}
```

📌 **這條由 3.10.7 的守門規則 8 擋著**：
`..order.application..` 不可以依賴 `..infrastructure..`。

---

## 3.9 三件契約測試看不到、但一定會咬你的事

⚠️ **3.10 會證明 14 條契約有 12 條是綠的。**
**這一節先說清楚：綠燈【不代表】兩個實作的行為一樣。**

### 3.9.1 `save()` 一張新訂單，送出了四句 SQL

**實驗 H5-A**：

```java
OrderEntity e = new OrderEntity("O-1", "C-1", PENDING_PAYMENT, 38000, "TWD", T0);
e.replaceLines(List.of(new OrderLineEntity(1, "P-1", 1, 38000, "TWD")));
repo.save(e);           // ← 一張【全新】的訂單
```

```
=== H5-A save() 一張【全新】的訂單（id 是我方指定的 String） ===
  repo.save(新的 entity) → 共 4 句 SQL
      [1] select oe1_0.id,…,l1_0.order_id,l1_0.line_no,… from orders … （查訂單 + 明細）
      [2] select ole1_0.line_no,ole1_0.order_id,… from order_line ole1_0 where …
      [3] insert into orders (created_at,currency,customer_id,status,total_minor,version,id) values (?,?,?,?,?,?,?)
      [4] insert into order_line (currency,product_id,quantity,unit_price_minor,line_no,order_id) values (?,?,?,?,?,?)
```

🔴 **兩句 `SELECT` 是白跑的** —— 這張訂單根本還不存在。

**原因**：

> `CrudRepository.save()` 的實作是：
>
> ```java
> // SimpleJpaRepository（簡化）
> public <S> S save(S entity) {
>     if (entityInformation.isNew(entity)) { em.persist(entity); return entity; }
>     else                                 { return em.merge(entity); }   // ← 我們走這裡
> }
> ```
>
> **而 `isNew()` 的預設判斷是「id 是不是 null」。**
>
> ⚠️ **shop-service 的 id 是自己產生的字串**（00 章 0.6.2 ⑯、02 章 2.10），
> **永遠不是 null** → 它一律被當成「舊的」→ 走 `merge()` → **`merge()` 必須先查現況**。

**規模化之後很可觀。實驗 H5-C**：

```
=== H5-C saveAll(10 筆) 送出幾句 SQL ===
  共 40 句：SELECT 20 句、INSERT 20 句
  ★ saveAll 只是「跑一個迴圈呼叫 save」——它【不是】JDBC 的 batch
    10 筆新訂單 = 20 次 SELECT（每一筆都先問「你在不在」）
```

⚠️ **兩個獨立的問題**：

1. **20 次白跑的 `SELECT`**（每筆訂單 2 次：頭 + 明細）。
2. **`saveAll` 不是批次** —— 它就是一個 `for` 迴圈。

**解法**：讓 `isNew()` 說實話 —— 實作 `Persistable`：

```java
@Entity
@Table(name = "orders")
public class OrderEntity implements Persistable<String> {

    @Id private String id;

    /** ★ 不落庫的旗標：只在「這個物件是程式碼剛 new 出來的」時為 true。 */
    @Transient
    private boolean isNew = true;

    @Override public String getId() { return id; }
    @Override public boolean isNew() { return isNew; }

    /** ★ 從資料庫載入之後，Hibernate 會呼叫它 —— 此時就不是新的了。 */
    @PostLoad @PrePersist
    void markNotNew() { this.isNew = false; }
}
```

**實驗 H16**：用一個獨立的小 entity 驗證這個寫法（避免和 3.7 的 diff 行為混在一起）。

```
=== H16 實作 Persistable 之後，save() 一筆新資料 ===
  共 1 句：SELECT 0 句
      insert into audit_row (message,id) values (?,?)

  ★ 對照 H5-A（沒有 Persistable 的 OrderEntity）：一張新訂單 4 句，其中 2 句 SELECT
  更新路徑：2 句（✅ 有 UPDATE）
  最後的內容：改過了
```

✅ **`SELECT` 完全消失了，而更新路徑仍然正常**
（`@PostLoad` 把載入回來的物件標記成「不是新的」，所以它走 `merge()`）。

> ⚠️ **shop-service 的 `OrderEntity` 本章【沒有】加上它**，理由是：
> 加了之後 3.7 的 diff 行為會一起改變（新物件不再被 `merge` 比對），
> **兩個變因混在一起，那一節就量不出東西了。**
> **05 章 5.8 會在批次寫入的脈絡裡把它加回來。**
>
> 📌 **現在就該知道的是**：
> **「`save()` 一張新訂單要幾句 SQL」這個問題，JPA 的答案取決於一個你可能沒設過的介面** ——
> **而它的預設值（看 id 是不是 null）對「自己產生 id」的專案剛好是錯的。**

### 3.9.2 一級快取與 dirty checking

**先看一個更基本的差異。實驗 H6-A**：同一個交易裡 `findById` 兩次。

```java
boolean same = tx.execute(s -> {
    OrderEntity a = repo.findById("O-1").orElseThrow();
    OrderEntity b = repo.findById("O-1").orElseThrow();
    return a == b;
});
```

```
=== H6-A 同一個交易裡 findById 兩次 ===
  a == b（同一個物件參考）：true
  送出的 SQL 句數：1 ← ★ 第二次沒有查資料庫（一級快取）
  ⚠️ 對照 02 章的 JdbcTemplate：每次 findById 都是一次新查詢、一個新物件
```

> 📌 **這就是 00 章 0.10.3 那張表的第一列**（「兩次查回來是不是同一個物件」）：
> **JPA 是同一個，JdbcTemplate 是兩個。**

⚠️ **而契約的第 13 條正是在測這件事**（02 章 2.15.2 的清單）：

```java
@Test
void 兩次查詢回傳不同的物件實例() {
    inTx(() -> {
        Order a = repo.findById("O-1").orElseThrow();
        Order b = repo.findById("O-1").orElseThrow();
        assertThat(a).isNotSameAs(b);
        return null;
    });
}
```

**它在 JPA 實作上是【綠】的** —— 而那是**轉接器換來的**：

| 層次 | 兩次查詢是同一個物件嗎 |
|---|---|
| `OrderEntity`（JPA 管理的） | ✅ **是**（上面的 H6-A） |
| `Order`（轉接器轉出來的） | ❌ **不是** —— `toDomain()` 每次都 new 一個 |

> 🔴 **如果沒有轉接器、直接把 `OrderEntity` 當領域物件用，這條契約會紅。**
> **而它紅的意義是：呼叫端「改了 a 就等於改了 b」** ——
> 這與 JdbcTemplate 實作的行為完全不同，
> 也就代表**呼叫端的程式碼不能在兩種實作之間搬移**（00 章 0.10.3）。

**而一級快取的存在，直接導致下一個差異。實驗 H6-B** —— 直接操作 entity（**沒有**經過轉接器）：

```java
tx.executeWithoutResult(s -> {
    OrderEntity e = repo.findById("O-1").orElseThrow();
    e.setStatus(OrderStatus.CANCELLED);      // 只改物件，【沒有】呼叫 save()
});
```

```
=== H6-B ★ 直接用 entity：改了但【沒有】呼叫 save() ===
  findById → 改狀態 → （不 save）交易結束 → 共 2 句 SQL
      [1] select oe1_0.id,… from orders oe1_0 where oe1_0.id=?
      [2] update orders set created_at=?,currency=?,customer_id=?,status=?,total_minor=?,version=?
              where id=? and version=?

  交易結束後資料庫裡的狀態：CANCELLED
  🔴 沒有呼叫 save()，改動還是被寫進去了 —— 這叫 dirty checking
```

**這是 JPA 與 JdbcTemplate 最大的一個行為差異**：

| | JdbcTemplate（02 章） | JPA（直接用 entity） |
|---|---|---|
| 改了物件、沒呼叫 `save()` | ✅ **什麼都不會發生** | 🔴 **交易結束時自動寫回** |
| 「哪些欄位會被寫」 | 你 SQL 裡寫的那些 | Hibernate 比對出來的那些 |
| **看程式碼能不能知道有沒有寫入** | ✅ 能（有 `save()` 就是有） | 🔴 **不能** |

⚠️ **兩個方向的意外**：

> 🔴 **意外一：不想存的東西被存了。**
> 一段「只是查出來看看、順手改個欄位算個數」的程式碼，把改動寫進了資料庫。
>
> 🔴 **意外二：想存的東西沒被存。**
> 物件是 **detached** 的（來自快取、來自上一個交易、來自反序列化），
> 改了它、也呼叫了 `save()`，但因為它不在持久化情境裡，
> `merge()` 回傳的是**另一個**物件，而你繼續用的是**原來那個**。

✅ **shop-service 兩個都不會遇到**，因為轉接器讓 application 層拿到的
**永遠是轉換出來的領域物件**（實驗 H6-C）。
**這是 3.5.3 說「轉接器把 dirty checking 關在門外」的意思。**

### 3.9.3 `@Modifying` 的批次更新繞過持久化情境

```java
@Modifying
@Query("UPDATE OrderEntity o SET o.status = :to WHERE o.status = :from")
int bulkChangeStatus(@Param("from") OrderStatus from, @Param("to") OrderStatus to);
```

**實驗 H10**：

```java
tx.executeWithoutResult(s -> {
    OrderEntity before = repo.findById("O-1").orElseThrow();     // 進入持久化情境
    repo.bulkChangeStatus(PENDING_PAYMENT, CANCELLED);           // 批次更新
    OrderEntity after = repo.findById("O-1").orElseThrow();      // 同一交易裡再查
});
```

```
=== H10 @Modifying 的批次 UPDATE ===
  批次更新前，記憶體裡的狀態：PENDING_PAYMENT
  批次更新影響 2 列
  批次更新後，同一交易再 findById：PENDING_PAYMENT      ← 🔴 還是舊的
  換一個交易查資料庫：CANCELLED                          ← 資料庫其實改了
```

🔴 **同一個交易裡，`findById` 回傳的還是舊值。**

> **原因**：`@Modifying` 的 `UPDATE` 直接下到資料庫，
> 而**一級快取（持久化情境）不知道它發生過** ——
> 第二次 `findById` 命中快取，回傳的是它記得的那個舊物件（3.9.2 的 H6-A 證明了快取的存在）。
>
> 🔴 **後果**：批次更新之後，同一個交易裡的任何讀取都可能拿到**過期的資料**，
> 而如果那個舊物件被改到、觸發 dirty checking，
> **它會用舊值把你剛剛的批次更新蓋回去。**

**兩個解法**：

```java
// ① 讓 Spring Data 幫你 flush 與 clear
@Modifying(flushAutomatically = true, clearAutomatically = true)
@Query("UPDATE OrderEntity o SET o.status = :to WHERE o.status = :from")
int bulkChangeStatus(@Param("from") OrderStatus from, @Param("to") OrderStatus to);
```

⚠️ **`clearAutomatically = true` 的代價**：它清掉**整個**持久化情境 ——
**同一個交易裡所有已載入的物件全部變成 detached**，之後對它們的修改不再被追蹤。

```java
// ② 更單純：批次更新走【自己的交易/自己的方法】，不與其他讀寫混在一起
```

> 📌 **shop-service 的規定**：
> **批次更新只出現在排程與維運腳本裡，而且那個方法【不做別的事】。**
> 這樣就不會有「同一個交易裡又批次又逐筆」的情況。

### 3.9.4 N+1

**實驗 H7-A**：讀 10 張訂單，然後碰它們的明細。

```java
List<OrderEntity> all = repo.findAll();
int c = 0;
for (OrderEntity o : all) c += o.getLines().size();   // ← 這一行觸發 LAZY 載入
```

```
=== H7-A 讀 10 張訂單 + 碰它們的明細 ===
  明細共 20 筆
  送出 11 句 SQL：1 句查訂單 + 10 句查明細
  🔴 這就是 N+1：10 張訂單 = 1 + 10 句
  ⚠️ 而且它【不會報錯】——只是慢，而且是隨資料量線性變慢
```

**實驗 H7-B**：改用 `JOIN FETCH`。

```java
@Query("SELECT DISTINCT o FROM OrderEntity o LEFT JOIN FETCH o.lines")
List<OrderEntity> findAllWithLines();
```

```
=== H7-B 同一件事，用 JOIN FETCH ===
  明細共 20 筆
  送出 1 句 SQL ← ✅ 一句解決
  ⚠️ 代價：訂單的欄位在結果集裡被【重複 N 次】（02 章 2.5.6 的策略 A）
```

⚠️ **N+1 最危險的地方是它的「發現時機」**：

| 什麼時候 | 症狀 |
|---|---|
| 開發時（3 筆測試資料） | 4 句 SQL —— **完全感覺不到** |
| 測試環境（100 筆） | 101 句 —— 有點慢，但沒人注意 |
| 正式環境（10,000 筆） | 🔴 **10,001 句** —— 一個請求佔住連線好幾秒（01 章 1.8） |

> 📌 **所以 N+1 要用【測試】抓，不能靠「感覺慢不慢」**：
>
> ```java
> @Test
> void 列表查詢不可以有N加1() {
>     seed(50);                                   // ★ 資料量要足以放大問題
>     SqlSpy.start();
>     tx.executeWithoutResult(s -> service.listOrders());
>     assertThat(SqlSpy.stop())
>             .describedAs("列表查詢的 SQL 句數不可以隨資料量增加")
>             .hasSizeLessThanOrEqualTo(3);
> }
> ```
>
> ⚠️ **關鍵是「句數不隨資料量變」**，不是「句數小於某個數字」。
> **更嚴謹的寫法是跑兩次（50 筆與 100 筆），斷言句數【相同】。**
> **04 章會把這條做成 shop-service 的守門測試。**

**實驗 H13：用兩個資料量各跑一次，看句數會不會跟著長**

```
=== H13 10 張訂單 + 碰明細：各種做法的 SQL 句數 ===
  ① 什麼都不做（LAZY）        → 11 句
  ② JOIN FETCH                → 1 句
  ③ @EntityGraph              → 1 句

=== H13 20 張訂單 + 碰明細：各種做法的 SQL 句數 ===
  ① 什麼都不做（LAZY）        → 21 句      ← 🔴 跟著資料量長
  ② JOIN FETCH                → 1 句       ← ✅ 不動
  ③ @EntityGraph              → 1 句       ← ✅ 不動
```

`@EntityGraph` 的寫法**不用碰 JPQL**：

```java
@EntityGraph(attributePaths = "lines")
List<OrderEntity> findByStatus(OrderStatus status);
```

**四種解法**：

| 解法 | 適用 | 本章驗證 |
|---|---|---|
| `JOIN FETCH`（H7-B） | 知道「這個查詢一定要明細」時 | ✅ 實測 1 句 |
| **`@EntityGraph`** | 同上，但**不用改 JPQL**（派生查詢也能用） | ✅ 實測 1 句 |
| `@BatchSize(size = 50)` | 明細**不一定要**，但要的時候希望 N 句變成 N/50 句 | 🔴 **【本章未驗證】** |
| **兩次查詢自己拼**（02 章 2.5.6 策略 B） | 分頁的時候 —— 因為 `JOIN FETCH` + 分頁會出問題（04 章） | 02 章已驗證 |

---

## 3.10 ★★ 契約測試跑在第四個實作上

### 3.10.1 什麼都不用改，只加一個子類別

02 章 2.15.2 的 14 條契約測試是**抽象類別**，換實作只要加一個子類別：

```java
/** 契約測試 × Spring Data JPA 實作。 */
class JpaOrderRepositoryContractTest extends OrderRepositoryContract {

    private AnnotationConfigApplicationContext ctx;
    private OrderRepository repo;
    private TransactionTemplate txTemplate;

    @BeforeEach
    void setUp() {
        ctx = new AnnotationConfigApplicationContext(JpaConfig.class);
        repo = ctx.getBean(OrderRepository.class);          // ★ 拿到的是【埠】，不是 SpringDataOrderRepository
        txTemplate = new TransactionTemplate(ctx.getBean(PlatformTransactionManager.class));
    }

    @AfterEach
    void tearDown() { if (ctx != null) ctx.close(); }

    @Override protected OrderRepository repository() { return repo; }
    @Override protected void tx(Runnable work) { txTemplate.executeWithoutResult(s -> work.run()); }
    @Override protected <T> T inTx(Supplier<T> work) { return txTemplate.execute(s -> work.get()); }
}
```

**第一次執行的結果**：

```
[ERROR] Tests run: 14, Failures: 1, Errors: 1 -- in lab.JpaOrderRepositoryContractTest
[ERROR]   OrderRepositoryContract.拿著過期的version存回去會失敗:114
[ERROR]   OrderRepositoryContract.nextId每次都不同:206 » IllegalTransactionState
              No existing transaction found for transaction marked with propagation 'mandatory'
```

**12 綠 2 紅。**

⚠️ **兩條紅燈的性質完全不同**：

| 紅的契約 | 病因 | 屬於哪一類 |
|---|---|---|
| `拿著過期的version存回去會失敗` | **轉接器的邏輯錯誤**（3.10.2、3.10.3） | 🔴 真正的 bug，會靜默毀資料 |
| `nextId每次都不同` | **`@Transactional` 套到了不該套的方法**（3.10.4） | ⚠️ 設計瑕疵，會逼呼叫端多開交易 |

**而第二條之所以只在這裡爆炸，本身就是一個教訓** ——
02 章的三個契約測試都是 `new JdbcOrderRepository(…)` **直接建**的，
**沒有代理，`@Transactional` 根本不生效**（02 章 2.15.3）。
**只有 JPA 這一組用了真的 Spring 容器**，於是它成了第一個踩到的人。

> 📌 **這正是 02 章 2.15.3 那句話的代價**：
> 「契約測試裡的 `tx()` 用 `TransactionTemplate` 明確開交易，
> 而守門測試才是真正在驗證 `MANDATORY`」——
> **兩者測的東西不同，而中間有一個縫。**

### 3.10.2 為什麼第一條是紅的

**紅的那條契約**：

```java
@Test
void 拿著過期的version存回去會失敗() {
    OrderRepository repo = repository();
    tx(() -> repo.save(anOrder("O-1", "C-1", T0)));

    Order stale = inTx(() -> repo.findById("O-1")).orElseThrow();   // version = 0
    tx(() -> {                                                      // 別人先改了 → version 變 1
        Order o = repo.findById("O-1").orElseThrow();
        o.markPaid();
        repo.save(o);
    });

    assertThatThrownBy(() -> tx(() -> { stale.cancel(); repo.save(stale); }))
            .isInstanceOf(OptimisticLockingFailureException.class);
}
```

**而 `OrderEntity` 上明明有 `@Version`**：

```java
@Version
@Column(nullable = false)
private long version;
```

⚠️ **實驗 H5-B 甚至證明了樂觀鎖確實在運作** ——
Hibernate 產生的 `UPDATE` 尾巴真的帶了 `version` 條件：

```
=== H5-B 對照：先存一次，再存第二次（已存在） ===
  findById → 改狀態 → save → 共 2 句 SQL
      [1] select oe1_0.id,… from orders oe1_0 where oe1_0.id=?
      [2] update orders set created_at=?,…,version=? where id=? and version=?
                                                              ↑↑↑↑↑↑↑↑↑↑ 樂觀鎖在這裡
```

**那為什麼契約還是紅的？看轉接器的 `save()`**：

```java
@Override
public void save(Order order) {
    OrderEntity entity = repo.findById(order.id()).orElse(null);   // ① 載入【現況】(version=1)
    if (entity == null) {
        entity = new OrderEntity(…);
    } else {
        entity.setStatus(order.status());                          // ② 把欄位蓋上去
        entity.setTotalMinor(order.total().minorUnits());
        entity.setCurrency(order.total().currency().getCurrencyCode());
    }
    entity.replaceLines(toLineEntities(order));
    repo.save(entity);                                             // ③ UPDATE … WHERE version = 1 ✅ 成功
}
```

🔴 **`order.version()`（呼叫端手上那個過期的 0）從頭到尾【沒有被用到】。**

> **`@Version` 保護的是「從 `findById` 載入，到交易 flush」這段期間。**
> 而我們在 ① 就把**最新的**版本載進來了 ——
> 從 Hibernate 的角度看，**沒有任何衝突**：它讀到 version=1，寫回 version=2，一切正常。
>
> **真正過期的是【領域物件】手上那個 version，而 Hibernate 根本沒看過它。**

⚠️⚠️ **這與 02 章 2.8.3 的 `MERGE` 是【同一個 bug】**：

| | 02 章的 `MERGE` | 03 章的轉接器 |
|---|---|---|
| 寫法 | `MERGE INTO … KEY (id) VALUES (…)` | `findById()` → 覆寫欄位 → `save()` |
| 為什麼失效 | upsert 的語意是「不管現況一律寫入」 | **先把現況載進來，就等於承認了現況** |
| 症狀 | **靜默覆蓋**，沒有例外 | **靜默覆蓋**，沒有例外 |
| 單執行緒測試抓得到嗎 | ✅ 抓得到（2.8.3 的實驗） | ✅ 抓得到（這條契約） |

> 📌 **「load-then-copy」是 DDD 轉接器最常見的寫法，也是最常見的樂觀鎖破口。**
> **而它之所以危險，是因為 `@Version` 就在那裡，看起來一切都有保護。**

### 3.10.3 第一條紅燈的修法

```java
} else {
    // ★★ 這一段是【必要】的，不是防禦性程式碼。
    //
    // JPA 的 @Version 只保護「載入之後到 flush 之前」這段期間；
    // 而我們是先 findById 把【現況】載進來，再把領域物件的欄位蓋上去 ——
    // 呼叫端手上那個過期的 version 從頭到尾沒有被比對過。
    // 少了這三行，「拿著過期的 version 存回去」會【靜默覆蓋】。
    if (entity.getVersion() != order.version()) {
        throw new OptimisticLockingFailureException(
                "訂單 " + order.id() + " 已被其他交易修改（本次帶的 version="
                        + order.version() + "，資料庫是 " + entity.getVersion() + "）");
    }
    entity.setStatus(order.status());
    …
}
```

**修好之後**：

```
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.InMemoryOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JdbcClientOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JpaOrderRepositoryContractTest
[INFO] Tests run: 56, Failures: 0, Errors: 0
```

✅ **四個實作、56 個測試、全綠**：

| 實作 | 技術 | 章節 |
|---|---|---|
| `InMemoryOrderRepository` | 記憶體 `Map` | 00 章 |
| `JdbcOrderRepository` | `NamedParameterJdbcTemplate` | 02 章 |
| `JdbcClientOrderRepository` | `JdbcClient` | 02 章練習 4 |
| **`JpaOrderRepository`** | **Spring Data JPA** | **本章** |

> 📌 **這就是 00 章 0.10.2 花那麼多篇幅建立契約測試的回報**：
> **第四次換實作，測試一行都沒有改。**
>
> ⚠️ **而且它真的抓到了東西** —— 一個 `@Version` 就在旁邊、
> 看起來絕對不會有問題的樂觀鎖破口。

### 3.10.4 第二條紅燈：`nextId()` 不該需要交易

```
OrderRepositoryContract.nextId每次都不同 » IllegalTransactionState
    No existing transaction found for transaction marked with propagation 'mandatory'
```

**`nextId()` 只是產生一個 UUID —— 它一行 SQL 都沒有下。**

```java
@Repository
@Transactional(propagation = Propagation.MANDATORY)   // ← class 層級，套到【每一個】public 方法
public class JpaOrderRepository implements OrderRepository {

    @Override
    public String nextId() {
        return "O-" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
    }
    …
}
```

🔴 **而它與 02 章 2.10 的設計理由直接牴觸**：

> 02 章 2.10 說「自己產生 id」的第一個好處是：
> **「id 在 `INSERT` 之前就存在 → 聚合可以在【交易外】被完整建立、也能先送事件」。**
>
> **但 `MANDATORY` 讓 `nextId()` 在交易外呼叫就直接拋例外** ——
> 那個好處被自己的註解取消了。

**修法**：

```java
/**
 * ★ 這個方法【不碰資料庫】，所以不需要交易。
 *
 * <p>class 上的 {@code MANDATORY} 會套到每一個 public 方法 —— 包含這一個。
 * 而那會逼呼叫端「為了產生一個 id 而開一個交易」，
 * 與「id 在 INSERT 之前就存在，聚合可以在交易外被完整建立」這個設計直接牴觸。
 */
@Override
@Transactional(propagation = Propagation.SUPPORTS)
public String nextId() {
    return "O-" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
}
```

⚠️ **這個修正要套到【全部四個實作】** —— 三個 JDBC 版本雖然目前不會紅
（它們在測試裡是 `new` 出來的，沒有代理），
**但一旦被當成真的 Spring bean 注入，它們會踩到完全一樣的問題。**

> 📌 **一般化的規則**：
> **class 層級的 `@Transactional` 是一個「預設值」，不是一個「保證」。**
> 每加一個 public 方法，都要問一次：**這個方法真的需要交易嗎？**
>
> | 方法的性質 | 該用什麼 |
> |---|---|
> | 寫入（`save`、`saveAll`） | `MANDATORY` —— 一定是某個業務動作的一部分 |
> | 讀取（`findById`、`count`） | `MANDATORY` + `readOnly = true` |
> | **不碰資料庫**（`nextId`） | **`SUPPORTS`**（有交易就參與，沒有也無所謂） |

### 3.10.5 ★ 而這個修正讓 00 章的 ArchUnit 規則 5 紅了

**改完上面那一行，去跑 `DataAccessArchitectureTest` —— 它會紅**：

```
[ERROR] DataAccessArchitectureTest.規則5_Repository實作的每個public方法都要求外層交易
Architecture Violation … was violated (1 times):
  example.shop.order.infrastructure.jpa.JpaOrderRepository.nextId() 用了 SUPPORTS，
  會自己開一個交易（0.9.3）
```

**因為 00 章 0.12.5 的規則 5 寫的是**：

```java
Transactional onMethod = m.reflect().getAnnotation(Transactional.class);
if (onMethod != null && onMethod.propagation() != Propagation.MANDATORY) {
    events.add(SimpleConditionEvent.violated(m, …));   // ← nextId() 撞在這裡
}
```

⚠️⚠️ **00 章 0.9.4 早就預告了這一刻**，只是它以為會發生在 05 章：

> 「一旦 05 章把查詢方法改成 `SUPPORTS`，那條規則就會紅。
> **等真的需要放寬時，再在規則裡開一個【具名的、寫了理由的】例外。**」

**現在就是那一刻，而且它比預期的早了兩章。**

🔴 **不可以做的三件事**（00 章 0.9.4 已經點名）：

```java
// 🔴 ① 把規則刪掉
// 🔴 ② allowEmptyShould(true)
// 🔴 ③ 把 nextId() 上的註解拿掉，讓它回去用 MANDATORY
//      —— 那等於用「守門規則」否決了一個【正確】的設計決定
```

✅ **正解：在規則裡開一個具名的例外，而且理由寫在程式碼裡。**

```java
/**
 * ★ 規則 5 的具名例外清單（03 章 3.10.5）。
 *
 * <p>⚠️ 加一個名字進來，等於宣告「這個方法【不碰資料庫】」。
 * 加之前先問：它真的一行 SQL 都沒有嗎？
 *
 * <p>⚠️ 這個清單<b>只能</b>用方法名比對，不能用「有沒有標 SUPPORTS」比對 ——
 * 否則任何人只要標一個 SUPPORTS 就能繞過整條規則。
 */
private static final Map<String, String> TX_FREE_METHODS = Map.of(
        "nextId", "只產生一個 UUID，不碰資料庫（03 章 3.10.4）——"
                + "強制 MANDATORY 會逼呼叫端為了拿一個 id 而開交易，"
                + "與『id 在 INSERT 之前就存在』的設計牴觸（02 章 2.10）");

@Test
void 規則5_Repository實作的每個public方法都要求外層交易() {
    classes().that().resideInAPackage("..infrastructure.persistence..")
            .or().resideInAPackage("..infrastructure.jpa..")
            .and().haveSimpleNameEndingWith("Repository")
            .should(new ArchCondition<>("標 @Transactional(propagation = MANDATORY)") {
                @Override
                public void check(JavaClass item, ConditionEvents events) {
                    Transactional onClass = item.reflect().getAnnotation(Transactional.class);
                    if (onClass == null || onClass.propagation() != Propagation.MANDATORY) {
                        events.add(SimpleConditionEvent.violated(item,
                                item.getName() + " 沒有 @Transactional(propagation = MANDATORY)"));
                        return;
                    }
                    for (JavaMethod m : item.getMethods()) {
                        if (!m.getModifiers().contains(JavaModifier.PUBLIC)) continue;

                        // ★★ 具名例外：清單裡的方法可以是 SUPPORTS，而且理由查得到
                        String why = TX_FREE_METHODS.get(m.getName());
                        Transactional onMethod = m.reflect().getAnnotation(Transactional.class);
                        if (why != null) {
                            if (onMethod == null || onMethod.propagation() != Propagation.SUPPORTS) {
                                events.add(SimpleConditionEvent.violated(m,
                                        m.getFullName() + " 在 TX_FREE_METHODS 清單裡，"
                                                + "就必須明確標 @Transactional(SUPPORTS)。理由：" + why));
                            }
                            continue;                      // ← 通過
                        }
                        if (onMethod != null && onMethod.propagation() != Propagation.MANDATORY) {
                            events.add(SimpleConditionEvent.violated(m,
                                    m.getFullName() + " 用了 " + onMethod.propagation()
                                            + "，會自己開一個交易（00 章 0.9.3）。"
                                            + "如果它真的不碰資料庫，請加進 TX_FREE_METHODS 並寫下理由。"));
                        }
                    }
                }
            })
            .because("交易邊界屬於 Service；Repository 只能參加別人開好的交易")
            .check(classes);
}
```

**這個例外的四個性質，每一個都對應 00 章 0.9.4 的要求**：

| 要求 | 這個寫法怎麼做到 |
|---|---|
| **具名** | `TX_FREE_METHODS` 是一份明確的清單，不是一個開關 |
| **有理由** | 理由是 `Map` 的值，**會出現在違規訊息裡** |
| **搜尋得到** | `grep TX_FREE_METHODS` 就找得到「哪些方法被放行、為什麼」 |
| **不會擴散** | ⚠️ **例外是「白名單」不是「條件」** —— 不在清單裡的方法標 `SUPPORTS` 照樣紅 |

⚠️ **最後一列是關鍵**。一個很自然、但**錯**的寫法是這樣：

```java
// 🔴 看起來一樣，實際上等於把規則關掉
if (onMethod != null && onMethod.propagation() == Propagation.SUPPORTS) continue;
```

**那條規則從此只擋 `REQUIRED` 與 `REQUIRES_NEW`** ——
而任何人只要順手標一個 `SUPPORTS`，就能讓 Repository 在沒有交易的情況下被呼叫。
**「例外要具名」的意思就是這個：例外的單位是【那一個方法】，不是【那一種寫法】。**

**改完之後（本章實測）**：

```
[INFO] Tests run: 6, Failures: 0, Errors: 0 -- in DataAccessArchitectureTest
```

**而把 `nextId()` 上的 `@Transactional(SUPPORTS)` 拿掉再跑一次**：

```
[ERROR] 規則5 … nextId() 在 TX_FREE_METHODS 清單裡，就必須明確標 @Transactional(SUPPORTS)。
        理由：只產生一個 UUID，不碰資料庫（03 章 3.10.4）…
```

✅ **兩個方向都會紅** —— 清單裡的方法沒標會紅，清單外的方法亂標也會紅。

> 📌 **順帶一提，上面的規則 5 多了一行 `.or().resideInAPackage("..infrastructure.jpa..")`。**
> 00 章寫規則時還沒有 `jpa` 這個套件，所以 `JpaOrderRepository` **一直沒有被規則 5 檢查過**。
> ⚠️ **這是守門規則最常見的失效方式**：不是規則寫錯，是**新的套件沒有被納入**。
> **加一個套件的時候，回去看一次每一條 ArchUnit 規則的範圍。**

### 3.10.6 ⚠️ 12 條綠燈**不代表**行為一樣

**這是本章最重要的一個提醒。**

3.9 那三件事 —— **每一件都是真實的行為差異，而 14 條契約【全部看不到】**：

| 差異 | 契約看得到嗎 | 為什麼看不到 |
|---|---|---|
| 一級快取（同交易兩次查詢是同一個物件） | ❌ | 契約只斷言「**值**對不對」，沒有斷言物件身分 |
| `save()` 一張新訂單送 4 句 SQL（2 句白跑） | ❌ | 契約不數 SQL 句數 |
| dirty checking | ❌ **在有轉接器時真的沒差別** | 但**拿掉轉接器就有** |
| `@Modifying` 繞過持久化情境 | ❌ | 契約裡沒有批次更新 |
| N+1 | ❌ | 契約的資料量是 1～3 筆 |

> 📌 **契約測試保證的是「**行為契約**」，不是「**實作等價**」。**
>
> **它的正確用法是**：
> - ✅ 「換實作之後，**呼叫端**不用改」—— 這它保證得了。
> - 🔴 「換實作之後，**效能與副作用**一樣」—— 這它**完全**保證不了。
>
> ⚠️ **所以搬遷到新實作時，契約全綠只是【第一關】。**
> 第二關是**數 SQL 句數**（3.9.4 的守門測試），
> 第三關是**在有真實資料量的環境上量**（06 章）。

### 3.10.7 三條新的守門規則

00 章有六組 ArchUnit 規則，02 章加了 SQL 拼接掃描，
3.10.5 剛剛**修訂了規則 5**（加上具名例外）。**本章再加三條新的**：

```java
package example.shop.architecture;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

class JpaArchitectureTest {

    static JavaClasses classes;

    @BeforeAll
    static void importClasses() {
        classes = new ClassFileImporter()
                .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
                .importPackages("example.shop");
    }

    @Test
    void 規則7_domain不可認識jpa() {
        noClasses().that().resideInAPackage("..order.domain..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "jakarta.persistence..", "org.hibernate..", "org.springframework.data..")
                .because("領域物件要能在沒有 ORM 的情況下被測試（00 章 0.12.5 規則 1 的延伸）")
                .check(classes);
    }

    @Test
    void 規則8_application不可認識jpa() {
        noClasses().that().resideInAPackage("..order.application..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "jakarta.persistence..", "org.hibernate..",
                        "org.springframework.data.jpa..", "..infrastructure..")
                .because("application 只認識埠（OrderRepository），不認識任何實作")
                .check(classes);
    }

    @Test
    void 規則9_entity不可以離開jpa套件() {
        noClasses().that().resideOutsideOfPackage("..infrastructure.jpa..")
                .should().dependOnClassesThat().haveSimpleNameEndingWith("Entity")
                .because("Entity 是持久化模型，外流就會出現 LazyInitializationException（3.5.2）")
                .check(classes);
    }
}
```

**實驗 H12：這三條真的會紅嗎？** 放一個違規的 class 進去：

```java
package example.shop.order.application.bad;

import example.shop.order.infrastructure.jpa.OrderEntity;

/** 故意違規：application 直接認識 Entity。 */
public class LeakyService {
    public List<OrderEntity> all() { return List.of(); }
}
```

```
[ERROR] Tests run: 3, Failures: 2, Errors: 0 -- in lab.H12_GuardTest
  規則8_application不可認識jpa … was violated (1 times)
  規則9_entity不可以離開jpa套件 … was violated (1 times)
```

✅ **一個違規的檔案同時觸發兩條規則**（它既在 application 裡認識了 infrastructure，
又讓 `Entity` 離開了 jpa 套件）。移除之後三條回綠。

> 📌 **規則 8 就是 3.2.4 那個警告的執行版本**：
> 它讓「application 直接注入 `SpringDataOrderRepository`」
> —— 那個會繞過 `MANDATORY`、讓每次 `save()` 各開一個交易的寫法 ——
> **在 CI 就失敗，而不是等到某天對帳對不起來。**

---

## 3.11 JdbcTemplate 還是 Spring Data？

**兩章寫了同一個埠的四個實作，現在可以公平比較了。**

### 3.11.1 逐項對照

| | JdbcTemplate（02 章） | Spring Data JPA（本章） |
|---|---|---|
| **程式碼量**（同一個埠） | 約 190 行 | 約 110 行 + 兩個 entity 約 130 行 |
| **SQL 在哪裡** | ✅ 你寫的、看得到 | ⚠️ 產生的（要開 `show_sql` 或攔截器才看得到） |
| **啟動時驗證** | 🔴 完全沒有 | ✅ 派生查詢與 JPQL 有（H3） |
| **改一筆明細的寫入量**（20 筆的訂單） | 🔴 `DELETE` + 重插 20 列 | ✅ **1 句 `UPDATE`**（H9） |
| **什麼都沒改時** | 🔴 一樣重寫 20 列 | ✅ **零句寫入** |
| **`save()` 一張新訂單** | 3 次來回（2 章 2.8.1 ②） | ⚠️ **4 句 SQL，其中 2 句白跑**（H5-A，可用 `Persistable` 改善） |
| **N+1 的風險** | ✅ 幾乎沒有（你自己控制查詢） | 🔴 **預設就會發生**（H7-A） |
| **意外寫入的風險** | ✅ 沒有 | 🔴 dirty checking（H6-B，轉接器可擋） |
| **複雜報表 / 資料庫專屬語法** | ✅ 直接寫 | ⚠️ 要 `nativeQuery`，而且失去啟動驗證 |
| **debug 的難度** | ✅ 低（SQL 就在眼前） | ⚠️ 高（要理解持久化情境） |

### 3.11.2 判準

> 📌 **不是二選一。shop-service 的規則是**：
>
> | 用途 | 用什麼 |
> |---|---|
> | **聚合的讀寫**（`OrderRepository`：`save`、`findById`） | **Spring Data JPA** —— 3.7 的 diff 與樂觀鎖是真的好用 |
> | **列表、搜尋、報表**（`OrderQueryDao`） | **JdbcTemplate / JdbcClient** —— 要投影、要控制 SQL、要分頁（04 章） |
> | **批次寫入**（匯入、排程） | **JdbcTemplate 的 `batchUpdate`**（05 章） |
> | **原子 UPDATE**（庫存、計數） | **JdbcTemplate**（02 章 2.11）—— JPA 表達不了 `SET qty = qty - ?` 的併發語意 |
>
> ⚠️ **這正是 00 章 0.7 把「命令埠」與「查詢埠」拆開的收成**：
> **兩個埠本來就可以用不同的技術實作，而呼叫端不知道也不需要知道。**

⚠️ **一個要避免的組合**：
🔴 **同一個聚合，一半用 JPA 寫、一半用 JdbcTemplate 寫。**
JPA 的持久化情境不知道 JdbcTemplate 寫了什麼，
**於是一級快取裡是舊資料、flush 時又用舊值蓋回去**（3.9.3 的 `@Modifying` 是同一個病）。

> 📌 **要混用的話，界線要落在【聚合】上，不是落在【方法】上。**
> 讀取可以混（查詢埠走 JDBC 不影響寫入路徑），
> **但同一張表的寫入路徑只能有一個技術。**

---

## 3.12 常見誤區

| # | 誤區 | 真相 |
|---|---|---|
| 1 | 「介面沒有實作，一定是編譯期產生程式碼」 | ❌ 是**執行期的 JDK 動態代理**，背後是 `SimpleJpaRepository`（3.2.1） |
| 2 | 「方法名是呼叫時才解析的」 | ❌ **啟動時就解析、驗證、編譯好了**（3.2.2 的第 ⑥ 層） |
| 3 | 「打錯欄位名要跑到那行才知道」 | ✅ 派生查詢與 JPQL **啟動就失敗**；🔴 **但原生 SQL 不會**（H3） |
| 4 | 「繼承 `JpaRepository` 比較方便」 | ⚠️ 它一次公開 **37 個方法**，包含 `findAll()` 與 `deleteAll()`（3.3.2） |
| 5 | 「把 `@Entity` 加在領域物件上最省事」 | 🔴 五面牆，而第五面是設計決定（3.5.1） |
| 6 | 「entity 可以回傳給 Controller」 | 🔴 `LazyInitializationException`，而且錯誤堆疊指向 Jackson（3.5.2） |
| 7 | 「JPA 的全刪重插很浪費」 | ❌ **實測只發 1 句 `UPDATE`** —— Hibernate 按主鍵 diff（3.7.1） |
| 8 | 「`save()` 一張新訂單就是一句 INSERT」 | 🔴 **4 句**，因為 `isNew()` 看 id 是不是 null（3.9.1） |
| 9 | 「`saveAll()` 是批次」 | ❌ 它是 `for` 迴圈。10 筆 = **40 句 SQL**（H5-C） |
| 10 | 「不呼叫 `save()` 就不會寫入」 | 🔴 **dirty checking 會寫**（3.9.2） |
| 11 | 「`@Modifying` 更新完，同交易讀到的是新值」 | 🔴 **是舊值** —— 它繞過一級快取（3.9.3） |
| 12 | 「有 `@Version` 就有樂觀鎖」 | 🔴 **load-then-copy 的轉接器會讓它失效**（3.10.2） |
| 13 | 「契約測試全綠 = 兩個實作可以互換」 | ❌ 契約保證**行為契約**，不保證**效能與副作用**（3.10.6） |
| 14 | 「N+1 開發時就會發現」 | ❌ 3 筆資料時是 4 句，**完全感覺不到**（3.9.4） |

---

## 3.13 本章練習

### 練習 1：這個 Repository 有幾個問題

```java
public interface ProductRepository extends JpaRepository<Product, Long> {

    List<Product> findByNameContaining(String keyword);

    @Query(value = "SELECT * FROM product WHERE JSON_EXTRACT(attrs, '$.color') = :color",
           nativeQuery = true)
    List<Product> findByColor(String color);

    List<Product> findByCategoryIdAndActiveTrueAndPriceGreaterThanEqualAndStockGreaterThanOrderByPriceAscNameAsc(
            Long categoryId, long price, int stock);
}

@Service
public class ProductService {

    @Autowired private ProductRepository repo;

    public List<Product> search(String keyword) {
        return repo.findByNameContaining(keyword);
    }

    public void deactivateAll() {
        repo.findAll().forEach(p -> p.setActive(false));
    }
}
```

<details>
<summary>參考答案</summary>

| # | 問題 | 節次 |
|---|---|---|
| 1 | **`ProductService`（application 層）直接認識 `ProductRepository`** | 3.2.4、3.10.7 規則 8 —— 它繞過 `MANDATORY`，每次 `save` 各開一個交易 |
| 2 | **繼承 `JpaRepository`，公開 37 個方法** | 3.3.2 —— `deleteAll()` 就在自動完成清單裡 |
| 3 | **`findByNameContaining` 的 `%` 不會跳脫** | 3.4.2 / 02 章 2.3.6 —— 使用者輸入 `%` 就是全表掃描 |
| 4 | **原生 SQL 的 `JSON_EXTRACT` 沒有啟動驗證** | 3.6.3 —— 打錯要等到有人呼叫才知道 |
| 5 | **`JSON_EXTRACT` 是 MySQL 專屬語法** | 3.6.2 —— 而測試如果跑 H2 就根本測不到（00 章 0.5.4） |
| 6 | **第三個方法名 100 個字元** | 3.4.5 —— 早就該換 `@Query` 或 `Specification` |
| 7 | **`deactivateAll()` 用 `findAll()` 撈全部** | 3.3.2 / 00 章 0.11.7 —— 50 萬筆商品直接 OOM |
| 8 | 🔴 **`deactivateAll()` 沒有 `save()`，但它【會生效】** | 3.9.2 dirty checking —— 而且是**一筆一句 UPDATE**，50 萬句 |
| 9 | **`@Autowired` 欄位注入** | 不能是 `final`，測試要靠反射 |
| 10 | **`Product` 是 entity，卻從 Service 回傳出去** | 3.5.2 —— 到 Controller 序列化時 `LazyInitializationException` |

**第 8 點值得展開**：

```java
public void deactivateAll() {
    repo.findAll().forEach(p -> p.setActive(false));   // 沒有 save，但改動會被寫回
}
```

> ⚠️ **這段程式碼有兩種可能，而兩種都不好**：
> - **有交易**：dirty checking 把 50 萬筆逐一 `UPDATE`（3.9.2）
> - **沒有交易**：`findAll()` 之後物件就 detached 了 → **什麼都不會發生**，
>   而且**不會報錯**（3.5.2 的同一族問題）
>
> 🔴 **同一段程式碼，加不加 `@Transactional` 的結果是「全寫」與「全不寫」。**
>
> ✅ **正解是一句批次更新**（3.9.3）：
> ```java
> @Modifying(clearAutomatically = true, flushAutomatically = true)
> @Query("UPDATE Product p SET p.active = false WHERE p.active = true")
> int deactivateAll();
> ```

</details>

---

### 練習 2：為什麼這條契約在 JPA 上是綠的

02 章新增的第 12 條契約：

```java
@Test
void 查出來的物件改了但沒save就不算數() {
    OrderRepository repo = repository();
    tx(() -> repo.save(anOrder("O-1", "C-1", T0)));

    inTx(() -> {
        Order o = repo.findById("O-1").orElseThrow();
        o.cancel();          // 改了，但【沒有】save
        return null;
    });

    Order got = inTx(() -> repo.findById("O-1")).orElseThrow();
    assertThat(got.status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
}
```

**(a)** 3.9.2 證明了 JPA 的 dirty checking 會把改動寫回去。
那為什麼這條契約在 `JpaOrderRepository` 上是**綠**的？
**(b)** 如果把 `JpaOrderRepository` 拿掉，讓 application 直接用
`SpringDataOrderRepository`，這條契約會怎樣？
**(c)** 這件事對「要不要寫轉接器」這個決定有什麼意義？

<details>
<summary>參考答案</summary>

**(a)** 因為 `findById` 回傳的**不是** entity，是**轉換出來的領域物件**：

```java
@Override
public Optional<Order> findById(String orderId) {
    return repo.findById(orderId).map(JpaOrderRepository::toDomain);
    //                             ↑ 在這裡，OrderEntity 變成了 Order
}
```

`o.cancel()` 改的是那個 `Order`，而 `Order` **不在持久化情境裡** ——
Hibernate 完全不知道它存在，flush 時自然不會寫它。

**實驗 H6-C 直接驗證了這一點**：

```
=== H6-C 透過【領域埠】的話呢 ===
  交易結束後的狀態：PENDING_PAYMENT
  ✅ 沒有被寫進去
```

⚠️ **注意 `OrderEntity` 本身仍然在持久化情境裡，也仍然會被 dirty checking 檢查** ——
只是**沒有人改過它**，所以比對出來沒有差異，不會產生 `UPDATE`。

**(b)** 🔴 **會變紅。** 實驗 H6-B 就是這個情境：

```
=== H6-B 直接用 entity：改了但【沒有】呼叫 save() ===
  交易結束後資料庫裡的狀態：CANCELLED
  🔴 沒有呼叫 save()，改動還是被寫進去了
```

**(c)** 這個決定的意義比「架構乾淨」大得多：

> 📌 **轉接器讓「四個實作的行為一致」這件事成立。**
>
> 沒有轉接器的話，JPA 版與 JdbcTemplate 版在
> **「不呼叫 `save()` 會不會寫入」**這件最基本的事情上就不一樣了 ——
> **而這代表呼叫端的程式碼【不能】在兩者之間搬移。**
>
> ⚠️ **反過來說，如果你的專案【只會用 JPA】、而且不打算換**，
> 那 dirty checking 是一個功能而不是問題，轉接器的價值就小很多（3.5.4）。
> **這是一個取捨，不是一條普世規則。**

</details>

---

### 練習 3：讓明細的 diff 不再退化 ★

3.7.3 的實驗 H14 顯示：刪掉第一筆明細會產生 **19 句 `UPDATE` + 1 句 `DELETE`**，
而刪掉最後一筆只要 **1 句 `DELETE`**。

**(a)** 為什麼位置會造成這麼大的差別？
**(b)** 提出兩種讓它不退化的改法，並各說出一個代價。
**(c)** 你選的改法需要改 `schema.sql` 嗎？需要資料遷移嗎？
**(d)** 這個問題在 02 章的 `JdbcOrderRepository` 上存在嗎？

<details>
<summary>參考答案</summary>

**(a)** 因為主鍵是 `(order_id, line_no)`，而 `line_no` 是**位置**。

```
刪掉第一筆之前              刪掉第一筆之後（重編）
line_no=1  → P-1            line_no=1  → P-2     ← 內容變了 → UPDATE
line_no=2  → P-2            line_no=2  → P-3     ← 內容變了 → UPDATE
line_no=3  → P-3            line_no=3  → P-4     ← 內容變了 → UPDATE
   …                           …
line_no=20 → P-20           （這一列不見了）      ← DELETE
```

**Hibernate 按主鍵比對**，看到的是「19 列的內容都變了 + 1 列消失」，
而不是「刪掉了 P-1」。

**(b)**

| 改法 | 做法 | 代價 |
|---|---|---|
| **① 用 `product_id` 當明細的鍵** | 主鍵改成 `(order_id, product_id)` | 🔴 **同一張訂單不能有兩筆相同商品**（不同規格、不同贈品的情境會壞） |
| **② 加一個獨立的 `line_id`** | 主鍵改成 `line_id`（ULID/UUID），`line_no` 降級成「顯示順序」的一般欄位 | 索引變大；`line_no` 重編仍然會產生 `UPDATE`，**但只更新那一欄，而且不影響主鍵比對** |

📌 **② 比較穩健**，因為它把「身分」與「順序」分開了 ——
**這正是 00 章 0.12.3 選 `(order_id, line_no)` 時沒有想到的那一面。**

⚠️ **但要注意 ② 沒有完全消除 `UPDATE`**：
刪掉第一筆之後，19 筆的 `line_no` 還是要重編，還是 19 句 `UPDATE`。
**要連這個都避免，就得接受「`line_no` 有洞」**（刪掉第 1 筆之後順序是 2,3,…,20），
把排序交給 `ORDER BY line_no` 而不是要求它連續。

> ✅ **完整的答案是「`line_id` 當主鍵 + `line_no` 允許有洞」** ——
> 這樣刪一筆就真的只是 1 句 `DELETE`。

**(c)** ✅ **兩者都要**：

```sql
-- schema.sql 的改動
CREATE TABLE order_line (
    line_id          VARCHAR(26) NOT NULL,        -- ★ 新增
    order_id         VARCHAR(26) NOT NULL,
    line_no          INT         NOT NULL,        -- 降級成一般欄位（允許有洞）
    product_id       VARCHAR(26) NOT NULL,
    quantity         INT         NOT NULL,
    unit_price_minor BIGINT      NOT NULL,
    currency         CHAR(3)     NOT NULL,
    CONSTRAINT pk_order_line PRIMARY KEY (line_id),                       -- ★ 改了
    CONSTRAINT uq_order_line_no UNIQUE (order_id, line_no),               -- ★ 保住原本的唯一性
    CONSTRAINT fk_order_line_order FOREIGN KEY (order_id) REFERENCES orders (id),
    CONSTRAINT ck_order_line_qty CHECK (quantity > 0)
);
```

**資料遷移**：要為既有的每一列產生一個 `line_id`。
⚠️ **而換主鍵是一個「不可逆」的遷移** —— 如果有別的表用 `(order_id, line_no)` 參照明細，
**那些外鍵全部要跟著改**。

> 📌 **這就是 00 章 0.8.6 說「約束的四個代價」的第四個**：
> **約束（尤其是主鍵）一旦上線，改它的成本就跳一個量級。**

**(d)** ⚠️ **不存在，但理由不是「它比較好」**：

02 章的 `JdbcOrderRepository` 是**全刪重插** —— 它**不管你改了什麼**，
一律 `DELETE` 全部再插回去。所以：

| | 刪最後一筆 | 刪第一筆 |
|---|---|---|
| JdbcTemplate（全刪重插） | `DELETE` + 插 19 列 | `DELETE` + 插 19 列 ← **一樣** |
| JPA（穩定主鍵） | 1 句 `DELETE` | 🔴 20 句 |

> 📌 **所以 JPA 的 diff 是「最好情況比 JdbcTemplate 好很多，最壞情況差不多」**。
> **而「最壞情況」是由你的主鍵設計決定的** ——
> 這正是 3.7.3 說「三個前提」的意思。

</details>

---

### 練習 4：寫一條抓得到 N+1 的守門測試

3.9.4 說「N+1 要用測試抓」，並給了一個草稿：

```java
@Test
void 列表查詢不可以有N加1() {
    seed(50);
    SqlSpy.start();
    tx.executeWithoutResult(s -> service.listOrders());
    assertThat(SqlSpy.stop()).hasSizeLessThanOrEqualTo(3);
}
```

**(a)** 這條測試有一個弱點，找出來。
**(b)** 寫一個更好的版本。
**(c)** 這條測試該放在哪一層（單元測試？整合測試？），為什麼？

<details>
<summary>參考答案</summary>

**(a)** 🔴 **`hasSizeLessThanOrEqualTo(3)` 是一個【魔術數字】。**

三個弱點：

1. **它與資料量綁死了** —— 今天 50 筆是 3 句，明天有人把 `seed(50)` 改成 `seed(2)`，
   **N+1 的實作也會通過**（2 筆時是 3 句）。
2. **它不會因為 N+1 被修好而變嚴格** —— 有人把它優化成 1 句，測試仍然是綠的，
   **然後下一個人又把它改回 N+1，只要 ≤ 3 就沒事**。
3. **上限是猜的** —— 為什麼是 3 不是 4？沒有人說得出來。

**(b)** ✅ **斷言「句數不隨資料量改變」**（H13 用的就是這個方法）：

```java
@Test
void 列表查詢的sql句數不可以隨資料量增加() {
    int small = countSqlFor(10);
    int large = countSqlFor(50);

    assertThat(large)
            .describedAs("10 筆時 %d 句、50 筆時 %d 句 —— 句數跟著資料量長，這是 N+1", small, large)
            .isEqualTo(small);
}

private int countSqlFor(int rows) {
    reset();                       // 清空資料表
    tx.executeWithoutResult(s -> seed(rows));
    SqlSpy.start();
    tx.executeWithoutResult(s -> service.listOrders());
    return SqlSpy.stop().size();
}
```

**這個版本的三個好處**：

| 好處 | 說明 |
|---|---|
| **沒有魔術數字** | 它比較的是兩次執行，不是一個猜出來的上限 |
| **訊息會說出病因** | 失敗時直接印出「10 筆 11 句、50 筆 51 句」 |
| **不會因為優化而失效** | 1 句與 1 句相等、3 句與 3 句也相等 —— **它只管「會不會長」** |

⚠️ **一個要注意的地方**：兩次都要**清空並重新塞資料**，
不然一級快取（H6-A）會讓第二次的句數偏低。
**上面的 `reset()` 就是為了這件事** —— 而更保險的做法是每次開新的容器。

**(c)** **整合測試**（要有真的資料庫與真的 Spring 容器）。

> 📌 **理由**：N+1 是一個**實作層的效能特性**，它只在
> 「真的 EntityManager + 真的 SQL」的組合下才會出現。
> 用 mock 的 repository 寫單元測試，**永遠測不到它**。
>
> ⚠️ **而這也代表它跑得慢**（本章的 H13 每次都開一個新容器，
> 一個容器啟動就 1.1 秒 —— 3.2.3）。
> **所以它應該放在「整合測試」那一組，不要和快速的單元測試混在一起。**
> **06 章會處理測試的分層與速度。**

**加分題：這條測試放在 02 章的 `JdbcOrderRepository` 上有意義嗎？**

> ✅ **有，而且同樣重要。**
> JdbcTemplate 不會有 JPA 那種「LAZY 觸發」的 N+1，
> **但「在迴圈裡呼叫 repository」是人寫出來的 N+1**（00 章 0.11.6）。
> **這條測試對兩種實作都有效** —— 它量的是「送出幾句 SQL」，
> 而那與用什麼技術無關。

</details>

---

## 3.14 驗收清單

讀完本章，你應該能回答：

**機制**

- [ ] 注入進來的 repository 實際上是什麼類別？它背後的目標物件是誰？
- [ ] 那七層攔截器裡，哪一層負責「執行查詢」？哪一層負責交易？
- [ ] 方法名是什麼時候被解析的？這件事造成什麼實際差別？
- [ ] `SimpleJpaRepository` 上的 `@Transactional` 為什麼是一個架構風險？

**寫法**

- [ ] `Repository` / `CrudRepository` / `JpaRepository` 各公開幾個方法？該選哪一個？
- [ ] 派生查詢、JPQL、原生 SQL 三者的錯誤各在什麼時候被發現？
- [ ] 為什麼 `@Entity` 不能加在 `Order` 上？（說得出五個理由中的三個）
- [ ] 三種投影產生的 SQL 一樣嗎？介面投影回傳的物件是什麼？

**行為**

- [ ] 改一筆明細，JPA 送幾句 SQL？JdbcTemplate 呢？什麼都沒改的時候呢？
- [ ] `line_no` 重編為什麼會讓 diff 退化？退化到什麼程度？
- [ ] `save()` 一張全新的訂單為什麼是 4 句 SQL？
- [ ] 不呼叫 `save()` 會不會寫入？有轉接器與沒有轉接器的答案一樣嗎？
- [ ] `@Modifying` 之後，同一個交易裡讀到的是新值還是舊值？

**契約**

- [ ] 14 條契約在 JPA 實作上是幾綠幾紅？兩條紅的病因有什麼不同？
- [ ] `@Version` 明明就在那裡，為什麼樂觀鎖還是失效了？
- [ ] **修好 `nextId()` 之後為什麼 ArchUnit 規則 5 會紅？「具名例外」該長什麼樣？**
- [ ] **為什麼「凡是標了 `SUPPORTS` 就放行」等於把規則 5 關掉？**
- [ ] 契約全綠代表兩個實作可以互換嗎？舉三個它看不到的差異。

**完成本章後**，請確認你的專案有：

```
✅ OrderEntity / OrderLineEntity        ★ 在 infrastructure.jpa，領域的 Order 一行都沒改
✅ SpringDataOrderRepository            ★ 只在 infrastructure 內部，不外流
✅ JpaOrderRepository（轉接器）          ★ @Transactional(MANDATORY)，蓋掉 SimpleJpaRepository 的預設
✅ save() 裡的 version 明確比對          ★ 少了它，樂觀鎖靜默失效（3.10.2）
✅ nextId() 標 @Transactional(SUPPORTS)  ★ 它不碰資料庫（3.10.4）
✅ 契約測試第四個子類別                   ★ 14 條全綠，而且修好前實測 12 綠 2 紅
✅ 規則 5 的 TX_FREE_METHODS 具名例外     ★ 3.10.5，兩個方向都實測過會紅
✅ 規則 5 的套件範圍含 ..infrastructure.jpa..  ★ 不然新套件不會被檢查
✅ 三條 ArchUnit 規則                    ★ 規則 7/8/9，實測過會紅
✅ 一條「SQL 句數不隨資料量增加」的測試     ★ 練習 4
```

---

## 3.15 下一章預告

這一章的查詢都是**固定形狀**的：條件寫死在方法名或 JPQL 裡。
下一章要處理**兩件在正式環境才會痛的事**：

```java
// ① 搜尋條件是動態的：使用者填了哪幾格，你事先不知道
public Page<OrderView> search(String customerId,      // 可能沒填
                              OrderStatus status,     // 可能沒填
                              Instant from,           // 可能沒填
                              Instant to,             // 可能沒填
                              Pageable pageable) { … }

// ② 這一句在第 1 頁是 3 ms，在第 5,000 頁是 4 秒。為什麼？
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 100000;
```

| 問題 | 04 章哪一節 |
|---|---|
| `Page` / `Slice` / `List` 該回哪一個？（`Page` 多送一句 `COUNT`） | 4.2 |
| ★ **排序欄位的白名單**（02 章 2.3.5 的 Spring Data 版本） | 4.5 |
| 動態條件：`Specification`、QueryDSL、還是自己拼 SQL？ | 4.6 |
| **深分頁為什麼慢，以及 keyset 分頁怎麼寫** | **4.7 ★** |
| `JOIN FETCH` + 分頁為什麼會**在記憶體裡分頁**（而且只印一行警告） | **4.8 ★** |
| 查詢次數的守門測試（練習 4 的完整版） | 4.11.6 規則 14 |

⚠️ **4.8 是這一站最容易「上線才發現」的一個坑，本章先驗證它存在（實驗 H15）**：

```java
@Query("SELECT DISTINCT o FROM OrderEntity o LEFT JOIN FETCH o.lines")
List<OrderEntity> findAllWithLinesPaged(Pageable pageable);

// 30 張訂單，只要第 1 頁的 5 筆
repo.findAllWithLinesPaged(PageRequest.of(0, 5));
```

```
WARN org.hibernate.orm.query -- HHH90003004: firstResult/maxResults specified with
                                collection fetch; applying in memory
=== H15 JOIN FETCH + Pageable（只要第 1 頁的 5 筆） ===
  要求 5 筆，實際拿到 5 筆
  送出 1 句 SQL：
      select distinct oe1_0.id,oe1_0.created_at,…,l1_0.order_id,l1_0.line_no,… from orders …
  SQL 裡有沒有 LIMIT / FETCH FIRST：🔴 沒有 —— 整張表撈回來再在記憶體裡分頁
```

🔴 **回傳的結果是【對的】（5 筆），所以測試會綠、功能會正常。**
**而那句 SQL 沒有 `LIMIT`** —— 30 張訂單時你不會發現，
**30 萬張時它會把整張表載進記憶體。**

⚠️ **唯一的線索是日誌裡那一行 `WARN`** ——
一行在啟動雜訊裡幾乎看不見的警告。**04 章 4.8 會處理它。**

---

## 3.16 本章的實驗環境與結果

**環境**（與 00～02 章相同，多了 JPA）：

| 項目 | 版本 |
|---|---|
| JDK | Temurin **21.0.5**（LTS） |
| Maven | **3.9.16** |
| Spring Boot | **3.2.5** |
| Spring Data JPA | **3.2.5** |
| Hibernate | **6.4.4.Final** |
| Jakarta Persistence | **3.1.0** |
| 連線池 | **HikariCP 5.0.1** |
| 資料庫 | **H2 2.2.224** |
| ArchUnit | **1.3.0** |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗（16 組）**：

| 組 | 實驗 | 結果 |
|---|---|---|
| **H1** | 代理的真面目 | ✅ 注入的是 **`jdk.proxy2.$Proxy80`**，目標是 **`SimpleJpaRepository`**，套了 **7 層 advice**（逐一列出）；家族方法數 **0 / 12 / 15 / 2 / 37** |
| **H2** | 方法名解析 | ✅ `PartTree` 拆出動作、limit、distinct、sort 與條件；打錯名字給 **「Did you mean 'customerId'」**；`findByStatusCode` 印出走過的路徑 |
| **H3** | 錯誤的發現時機 | ✅ 派生查詢打錯 → **啟動失敗**；JPQL 屬性不存在 → **啟動失敗**；🔴 **原生 SQL 表不存在 → 啟動成功，呼叫時才爆**；最小容器啟動 **1,119 ms** |
| **H4** | 產生的 SQL 與投影 | ✅ 派生查詢與 `@Query` 產生**完全相同**的 SQL；三種投影都只 `SELECT` **3 個欄位**（entity 是 7 個）；介面投影回傳 **`$Proxy86`** |
| **H5** | save 的語意 | 🔴 **一張全新訂單 = 4 句 SQL（2 句白跑的 SELECT）**，因為 `isNew()` 看 id 是否為 null；**`saveAll(10)` = 40 句（20 SELECT + 20 INSERT）**；更新路徑的 `UPDATE` 帶 `version` 條件 |
| **H6** | 身分與 dirty checking | ✅ 同交易兩次 `findById` 是**同一個物件、只有 1 句 SQL**；🔴 **改了不 save 也會被寫回（CANCELLED）**；✅ **透過領域埠則不會**（轉接器擋掉了） |
| **H7** | N+1 | 🔴 10 張訂單碰明細 = **11 句**；`JOIN FETCH` = **1 句** |
| **H8/H9** | 明細的 diff | ✅ **JPA：改一筆 → 1 `UPDATE`；刪一筆 → 1 `DELETE`；加一筆 → 1 `INSERT`；什麼都沒改 → 零句寫入**<br>對照 **JdbcTemplate：一律 `DELETE` 全部 + 重插 20 列** |
| **H10** | `@Modifying` | 🔴 批次更新後，**同交易再查得到的是舊值**（`PENDING_PAYMENT`），而資料庫已是 `CANCELLED` |
| **H11** | entity 離開交易 | 🔴 一般欄位可讀，**碰 LAZY 集合 → `LazyInitializationException`**；領域埠回傳的物件則完全正常 |
| **H12** | 守門規則 | ✅ 規則 7/8/9 全綠；**一個違規檔案同時觸發規則 8 與 9**，移除後回綠<br>🔴 **修好 `nextId()` 之後規則 5 變紅** → 改成 `TX_FREE_METHODS` 具名例外；**清單裡沒標 `SUPPORTS`、清單外亂標 `SUPPORTS`，兩個方向都實測會紅**<br>⚠️ 順帶發現規則 5 的套件範圍**沒有含 `..infrastructure.jpa..`**，`JpaOrderRepository` 一直沒被檢查過 |
| **H13** | 解 N+1 的做法 | ✅ 10 筆 → LAZY **11 句** / `JOIN FETCH` **1 句** / `@EntityGraph` **1 句**；20 筆 → **21 / 1 / 1**（句數是否隨資料量長，一眼可見） |
| **H14** | `line_no` 重編 | 🔴 **刪最後一筆 = 1 句寫入；刪第一筆 = 20 句寫入**（19 `UPDATE` + 1 `DELETE`） |
| **H16** | `Persistable` | ✅ **實作後 `save()` 新資料 = 1 句 `INSERT`（SELECT 歸零）**，更新路徑仍正常 —— 對照 H5-A 的 4 句 |
| **H15** | `JOIN FETCH` + `Pageable` | 🔴 **SQL 裡沒有 `LIMIT`**，Hibernate 印 `HHH90003004` 然後**在記憶體裡分頁**；回傳結果卻是對的 5 筆 |
| **契約** | 14 條 × 4 個實作 | 🔴 **第一次執行：12 綠 2 紅**（`拿著過期的version存回去會失敗`＝轉接器邏輯錯；`nextId每次都不同`＝`MANDATORY` 套到不碰資料庫的方法）→ 修好後 **56 個全綠** |

```
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.InMemoryOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JdbcOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JdbcClientOrderRepositoryContractTest
[INFO] Tests run: 14, Failures: 0, Errors: 0 -- in lab.JpaOrderRepositoryContractTest
[INFO] Tests run: 89, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
```

**本章的驗證專案：16 組實驗 + 56 條契約測試（14 條 × 4 個實作）+ 5 條補做的守門測試 = 89 個測試，全綠。**

🔴 **本章沒有驗證到的**：

| 沒驗證的 | 影響哪一節 | 哪一站會補 |
|---|---|---|
| `Persistable` 套用在 `OrderEntity` 上與 diff 的交互影響 | 3.9.1 | 05 章 5.8 |
| `@BatchSize` 的實際效果 | 3.9.4 | 04 章 |
| `Containing` 對 `%` 的跳脫行為 | 3.4.2 | 04 章 |
| `bootstrap-mode=deferred/lazy` 的效果 | 3.2.3 | — |
| **Open Session In View 開/關的差異** | 3.5.2 | 04 章 |
| **MySQL 上的 SQL 差異**（方言、`FETCH FIRST`、定序） | 全章 | 07-mysql 站 |
| **真實資料量下的 N+1 成本** | 3.9.4 | 06 章、07-mysql 站 |

> 📌 **最後一句話**：
>
> 這一章有**三個實測結果與直覺相反**：
>
> **① 「`clear()` 再塞 20 個新物件」不是 20 個 DELETE + 20 個 INSERT** ——
> 而是 **1 句 `UPDATE`**，什麼都沒改時甚至**一句寫入都沒有**（H9）。
> Hibernate 按主鍵 diff，程式碼看起來在做什麼並不重要。
>
> **② 但同一個機制也會反過來咬你** ——
> 刪掉第一筆明細讓 `line_no` 重編，**1 句寫入變成 20 句**（H14）。
> **同一個「聰明」的機制，好處與壞處都來自同一個前提：主鍵穩不穩定。**
>
> **③ `@Version` 就在 entity 上，樂觀鎖還是失效了**（H5-B 甚至證明了
> Hibernate 真的產生了帶 `version` 條件的 `UPDATE`）——
> 因為轉接器**先把現況載進來**，就等於承認了現況（3.10.2）。
>
> ⚠️ **三個的共同形狀**：
> **框架幫你做的事，你【不能】從程式碼的字面讀出來。**
> 02 章的 SQL 寫在眼前，看得懂就是看得懂；
> **這一章的每一個結論，都必須靠「把真正送出去的 SQL 印出來」才能確認。**
>
> 📌 **所以用 ORM 的第一件事，不是學註解，是裝一個 `StatementInspector`。**
> 本章 14 組實驗全部建立在那 20 行程式碼上：
>
> ```java
> public class SqlSpy implements StatementInspector {
>     @Override public String inspect(String sql) {
>         if (recording) CAPTURED.add(sql.replaceAll("\\s+", " ").trim());
>         return sql;
>     }
> }
> ```
> ```properties
> hibernate.session_factory.statement_inspector=com.example.SqlSpy
> ```
