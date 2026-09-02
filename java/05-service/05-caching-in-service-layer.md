# 第 05 章：服務層快取

> 04 章把「失敗」這件事做完了。這一章處理**成功的路徑**。
>
> `OrderQueryService.search()` 每次都打資料庫。
> 一個熱門商品頁一分鐘 8,000 次查詢，而那 8,000 次拿到的是**同一份資料**。
>
> **加 `@Cacheable` 是三行設定。**
> 而這一章的 6,000 行是在講那三行之後會發生什麼 ——
> 因為快取的失敗方式**不是「變慢」，是「回錯的資料」**。

---

## 5.0 先看見痛：三個真實事故

### 事故 1：一個 rollback 之後，快取裡有一個不存在的價格

**現場**（2026-07-14 11:20，行銷部門）：

```
行銷：我改了「無線降噪耳機 Pro」的價格，從 1,500 改成 1,200 做午間特賣。
     系統說「更新失敗，請稍後再試」，所以我沒改成功。
     可是前台現在顯示 1,200，而後台顯示 1,500。
     ⚠️ 而且已經賣出 47 筆了。
```

**程式碼**（簡化）：

```java
@Service
public class ProductService {

    @Cacheable("products")
    public ProductView findById(String id) {
        return productRepository.findById(id).map(ProductView::from).orElseThrow();
    }

    @Transactional
    public void changePrice(String id, Money newPrice, Actor actor) {
        Product product = productRepository.findById(id).orElseThrow();
        product.changePrice(newPrice, actor);
        productRepository.save(product);

        // ★ 改完價格要通知搜尋引擎重建索引
        searchIndexer.reindex(id);            // 🔴 這裡拋例外（搜尋服務當機）

        auditLog.record(...);
    }
}
```

**發生了什麼**（逐步）：

| 步驟 | 事件 |
|---|---|
| 1 | `changePrice` 開始交易，`UPDATE products SET price = 1200` |
| 2 | ⚠️ **另一個請求**（前台的商品頁）在這個瞬間打 `findById("P-1001")` |
| 3 | 而它**在同一個交易裡**（`open-in-view` 已關，但這個請求走的是**另一條**路徑，見下） |
| 4 | 🔴 它讀到 **1,200**（未提交的值），並且**把它放進快取** |
| 5 | `searchIndexer.reindex()` 拋例外 → 交易 rollback → 資料庫回到 **1,500** |
| 6 | 🔴🔴 **快取裡留著 1,200，而它從來沒有在資料庫裡存在過** |
| 7 | 快取的 TTL 是 **10 分鐘**，於是接下來 10 分鐘所有人看到 1,200 |

⚠️ **第 3、4 步值得展開**，因為「未提交的值進了快取」聽起來需要很巧的時機。
**實際上它有一條非常普通的路徑**：

```java
@Transactional
public void changePrice(String id, Money newPrice, Actor actor) {
    Product product = productRepository.findById(id).orElseThrow();
    product.changePrice(newPrice, actor);
    productRepository.save(product);

    // ★★ 這一行 —— 為了組稽核紀錄，它呼叫了自己的查詢方法
    ProductView after = self.findById(id);     // ← @Cacheable，而我們在交易裡
    auditLog.record(actor, "PRICE_CHANGED", before, after);

    searchIndexer.reindex(id);                  // 🔴 拋例外
}
```

**「在交易裡呼叫一個 `@Cacheable` 方法」不需要併發。**
它只需要**同一個方法裡先寫再讀**。

> 📌 **這個事故的一句話版本**：
> **`@Cacheable` 不知道交易的存在。**
> 它看到方法回傳一個值，就把它存起來 —— **無論那個值會不會被 rollback。**

**5.3 會把這個事故完整重現一次**（有可執行的實驗與實測輸出）。

### 事故 2：兩個方法共用一個快取項目

**現場**（2026-05-02，客服工單）：

```
客戶 A：我的訂單詳情顯示的是【別人的】收件地址和電話。
```

**程式碼**：

```java
@Service
public class OrderQueryService {

    /** 客戶端用：只有客戶自己看得到的欄位 */
    @Cacheable("orders")
    public OrderDetailView detail(String orderId) { ... }

    /** 客服端用：多了 internalNote 與 staffNote */
    @Cacheable("orders")
    public OrderDetailForSupportView detailForSupport(String orderId) { ... }
}
```

⚠️⚠️ **兩個方法、同一個 cache 名稱、同一個參數 → 同一個 key。**

**實測**（5.4.1 有完整的實驗）：

```
[key] 相同參數不同方法是否同 key: true
```

**於是**：

| 誰先呼叫 | 快取裡放的是 | 另一個方法拿到什麼 |
|---|---|---|
| 客服先查 | `OrderDetailForSupportView` | 🔴 客戶拿到**含 `staffNote` 的物件** |
| 客戶先查 | `OrderDetailView` | 🔴 客服拿到**沒有 `internalNote` 的物件** |

⚠️ **而「客戶拿到客服的物件」在型別上是不可能的**（兩個不同的 record）——
所以它會拋 `ClassCastException` 嗎？

**不會。** `@Cacheable` 的回傳值是 `Object`，
而 CGLIB 產生的橋接方法**沒有做型別檢查**
（它在 `checkcast` 之前就把值回傳了 —— 見 5.4.2 的位元碼分析）。

**於是**：`OrderDetailForSupportView` 被當成 `OrderDetailView` 回傳，
而 Web 層的 mapper 存取 `view.customerNote()` 時 ——
`OrderDetailForSupportView` **也有這個方法**（03 章 3.7.3），
所以它**正常執行**，只是回傳了**另一張訂單的資料**……

⚠️⚠️ **等一下，這個推論有一個錯誤。** 完整的分析在 5.4.2，
而結論是：**真正的後果依 Java 版本與呼叫路徑而異**，
最常見的是 `ClassCastException`（500），
**而那反而是幸運的** —— 500 會被發現，
而「欄位剛好都存在」才是真的災難。

**事故 2 的實際 root cause 更平凡**：
兩個方法**都回傳 `OrderDetailView`**（客服版只是多填了幾個欄位），
於是**沒有任何型別錯誤**，客戶就看到了客服版的資料。

> 📌 **這個事故的一句話版本**：
> **cache 名稱 + key 才是快取項目的身分，而「哪個方法」不在裡面。**

### 事故 3：一個 `@CacheEvict` 清掉了 40 萬個項目

**現場**（2026-03-08 促銷日 00:01，SRE 值班）：

```
警報：資料庫 CPU 100%，連線池耗盡，API p99 從 80ms 變成 12,000ms
```

**查 log**：促銷開始的那一秒，有人跑了一個批次更新：

```java
@Transactional
@CacheEvict(cacheNames = "products", allEntries = true)     // ★ 這一行
public void applyPromotionPrices(List<PromotionItem> items) {
    for (var item : items) {
        productRepository.updatePrice(item.productId(), item.promoPrice());
    }
}
```

**`allEntries = true` 清掉了整個 `products` 快取 —— 40 萬個項目。**

**接下來的 30 秒**：

```
00:01:00  快取清空
00:01:00  8,000 個併發請求同時打商品頁
00:01:00  🔴 8,000 個請求【全部】miss → 8,000 個 SELECT 同時打資料庫
00:01:01  連線池（20 條）耗盡 → 其餘請求等待
00:01:03  等待逾時 → 500
00:01:30  資料庫 CPU 100%，慢查詢堆積
```

⚠️ **這是三個不同問題疊在一起**，而它們有三個不同的名字：

| 名字 | 這個事故裡的表現 |
|---|---|
| **雪崩**（avalanche） | 40 萬個項目**同時**失效 |
| **擊穿**（stampede / dog-pile） | 同一個熱門商品被 8,000 個執行緒**同時**回填 |
| **穿透**（penetration） | ⚠️ 這個事故裡**沒有**發生（見 5.7.3） |

**實測（5.7.1）**：50 個執行緒同時查同一個 key，
`@Cacheable` 預設會執行 **50 次**載入：

```
[實驗7] sync=false → 實際載入次數 = 50 / 50 個執行緒
[實驗7] sync=true  → 實際載入次數 =  1 / 50 個執行緒
```

**一個參數（`sync = true`）把 50 次變成 1 次。**
而 5.7.1 會說明**為什麼它不是萬靈丹**（它只在單一 JVM 內有效）。

> 📌 **這三個事故的共同結構**：
>
> | 事故 | 表面問題 | 真正的問題 |
> |---|---|---|
> | 1 | 價格顯示錯誤 | **`@Cacheable` 不知道交易存在** |
> | 2 | 看到別人的資料 | **key 不含「哪個方法」** |
> | 3 | 資料庫被打掛 | **失效的「範圍」與「時機」沒有被設計** |
>
> **三個都不是「快取沒設 TTL」。**
> 三個都是**「快取的語意」與「我們以為的語意」不一致**。

---

## 5.1 學習目標

讀完這一章，你可以：

- 說明 `@Cacheable` 的代理機制，以及它與 `@Transactional` **共用哪些失效情境、又在哪一點不同**。
- 解釋為什麼「在交易裡呼叫 `@Cacheable` 方法」會讓**未提交的值永久留在快取裡**，並說出三種解法的取捨。
- 說出 `@CacheEvict` 的 `beforeInvocation` 對 rollback 的影響，以及**為什麼 `true` 反而更安全**。
- 設計 cache key，並說出「兩個方法共用一個 key」「參數是物件」「key 太長」三個陷阱。
- 判斷該用本地快取（Caffeine）、分散式（Redis）還是兩層，以及兩層的**一致性代價**。
- 說出「擊穿、雪崩、穿透」三者的差別，以及各自的解法（含實測數字）。
- 選擇 Redis 的序列化器，並說出 `JdkSerializationRedisSerializer` 與
  `GenericJackson2JsonRedisSerializer` 各自的**具體地雷**（含實測的位元組數）。
- 說明快取的可觀測性：**命中率多少才算好**，以及為什麼「命中率 99%」可能是壞消息。
- 列出**不該**快取的東西，並說出判準。
- 寫出「能證明第二次沒打資料庫」的測試。

## 前置知識

| 需要 | 用在哪 |
|---|---|
| **02-spring-boot 04 章**（AOP 與代理） | 5.2 整節 —— `@Cacheable` 與 `@Transactional` 是同一套機制 |
| **本站 02 章 2.7**（五種交易失效情境） | 5.2.3 —— 快取有**四種**對應的失效情境 |
| **本站 02 章 2.12**（`@TransactionalEventListener`） | 5.3.4 —— `AFTER_COMMIT` 是快取失效的正確時機 |
| 本站 03 章 3.3（三種轉換策略） | 5.10 —— 「快取 Entity 還是 View」 |
| 本站 03 章 3.8.4（金額型別掃描測試） | 5.8.3 —— `Money` 的序列化 |
| 本站 04 章 4.4.1（誰能修好它） | 5.9.3 —— 快取失敗該回什麼 |

⚠️ **這一章與 02 章的關係比看起來更緊密。**
`@Cacheable` 與 `@Transactional` 用**同一個** `ProxyFactory`、
**同一套**代理型別選擇、**同一個**自呼叫陷阱 ——
而 5.2.3 會實測「它們在一個關鍵細節上不同」。

---

## 5.2 `@Cacheable` 到底做了什麼 ★★

### 5.2.1 三行設定背後的六個步驟

```java
@Cacheable("products")
public ProductView findById(String id) { ... }
```

**呼叫 `productService.findById("P-1")` 時實際發生的事**：

```
① 呼叫打在 CGLIB 代理上（不是你的類別）
      ProductService$$SpringCGLIB$$0.findById("P-1")

② 代理走 advisor 鏈 → CacheInterceptor.invoke()

③ CacheInterceptor 問 CacheOperationSource：
      「這個方法有快取操作嗎？」
      → AnnotationCacheOperationSource 讀 @Cacheable → 回一個 CacheableOperation

④ 產生 key：
      KeyGenerator.generate(target, method, args)
      → 預設是 SimpleKeyGenerator → 一個參數時【直接用那個參數】（5.4.1）

⑤ 查 Cache：
      CacheManager.getCache("products").get(key)
      → 命中 → 【直接回傳，你的方法完全沒被呼叫】
      → 未命中 → ⑥

⑥ 呼叫真正的方法 → 拿到回傳值 → cache.put(key, value) → 回傳
```

⚠️ **第 ⑤ 步的「你的方法完全沒被呼叫」是一切問題的來源。**
它代表：

| 你以為方法會做的事 | 命中時實際上 |
|---|---|
| 查資料庫 | ❌ 沒查 |
| 檢查權限 | 🔴 **沒檢查** |
| 記稽核 log | ❌ 沒記 |
| 更新「最後查詢時間」 | ❌ 沒更新 |

> 📌 **「快取一個有副作用的方法」是本章最常見的錯誤**（5.10.2）。

### 5.2.2 它與 `@Transactional` 共用的東西

**兩者的組態類別是對稱的**：

| | 交易 | 快取 |
|---|---|---|
| 啟用 | `@EnableTransactionManagement`（Boot 自動） | `@EnableCaching`（**要自己加**） |
| 組態 | `ProxyTransactionManagementConfiguration` | `ProxyCachingConfiguration` |
| 中介器 | `TransactionInterceptor` | `CacheInterceptor` |
| 屬性來源 | `AnnotationTransactionAttributeSource` | `AnnotationCacheOperationSource` |
| Advisor 的 order | `Ordered.LOWEST_PRECEDENCE` | `Ordered.LOWEST_PRECEDENCE` |

⚠️⚠️ **最後一列是一個真實的問題**（實測）：

```
[實驗6] Ordered.LOWEST_PRECEDENCE = 2147483647
[實驗6] 快取與交易的 advisor order 相同 → 順序【未定義】
```

**「順序未定義」的具體後果**：

| 如果快取在外層 | 如果交易在外層 |
|---|---|
| 命中時**不開交易** ✅ 好（省一條連線） | 命中時**也開交易** 🔴 浪費 |
| 未命中時：先開快取 → 再開交易 | 未命中時：先開交易 → 再查快取 |

⚠️ **而 Spring 有一個明確的預設**：兩者都用 `LOWEST_PRECEDENCE`，
而在 order 相同時，**advisor 的排序退回「註冊順序」** ——
`@EnableCaching` 與 `@EnableTransactionManagement` 誰先被處理是**不保證的**。

✅ **正確做法：明確設定 order**：

```java
@Configuration
// ★★ 讓快取在【外層】—— 命中時完全不碰交易與連線
@EnableCaching(order = Ordered.HIGHEST_PRECEDENCE + 100)
@EnableTransactionManagement(order = Ordered.HIGHEST_PRECEDENCE + 200)
public class CacheAndTxConfig { }
```

⚠️ **`order` 的數字越小越外層**（Spring AOP 的慣例）。
於是 `快取(100) < 交易(200)` = **快取在外**。

**為什麼要快取在外**（三個理由）：

| 理由 | 說明 |
|---|---|
| 1 | **命中時不佔連線** —— 這是快取最主要的價值（02 章 2.9.3：交易長度 × 連線池 = TPS 上限） |
| 2 | 命中時不開交易 → 少一次 `BEGIN` / `COMMIT` 往返 |
| 3 | ⚠️ **它與 5.3 的事故 1 沒有關係** —— 那個事故的成因是「交易裡呼叫 `@Cacheable`」，而順序不影響它 |

### 5.2.3 四種失效情境（三個與交易相同，一個不同）★★

02 章 2.7 列了交易的五種失效情境。**快取有對應的四種。**

#### 情境一：自呼叫 —— 完全相同

```java
@Service
public class ProductService {

    @Cacheable("products")
    public ProductView findById(String id) { ... }

    public List<ProductView> findAll(List<String> ids) {
        // 🔴 this.findById(...) —— 繞過代理
        return ids.stream().map(this::findById).toList();
    }
}
```

**實測**（同一個 key 呼叫三次）：

```
[實驗2] 自呼叫三次，dbHits = 3（1 = 快取生效；3 = 代理被繞過）
[實驗2] 快取裡有值嗎 = false
```

⚠️ **注意「快取裡有值嗎 = false」** —— 它不只是「沒讀快取」，
**它連寫都沒寫**。於是**後續從外部的呼叫也會 miss 一次**。

**解法與 02 章 2.7.1 完全相同**（六種）。而快取的情況下最常用的是**第七種**：

```java
/**
 * ★ 批次查詢自己做「先查快取、缺的才查資料庫」。
 *
 * <p>⚠️ 這不是「解決自呼叫」—— 是<b>不要自呼叫</b>。
 * 而它順便解決了一個更嚴重的問題：
 * <b>{@code ids.stream().map(this::findById)} 是 N 次查詢</b>（N+1 的變體）。
 */
public List<ProductView> findAll(List<String> ids) {
    Cache cache = cacheManager.getCache("products");
    var found = new LinkedHashMap<String, ProductView>();
    var missing = new ArrayList<String>();

    for (String id : ids) {
        var wrapper = cache.get(id);
        if (wrapper != null) { found.put(id, (ProductView) wrapper.get()); }
        else { missing.add(id); }
    }
    if (!missing.isEmpty()) {
        // ★ 一次查完所有 miss 的
        productRepository.findAllById(missing).forEach(p -> {
            var view = ProductView.from(p);
            cache.put(p.id(), view);            // ★ 手動回填
            found.put(p.id(), view);
        });
    }
    return ids.stream().map(found::get).filter(Objects::nonNull).toList();
}
```

⚠️ **注意 `(ProductView) wrapper.get()` 那個轉型** ——
它是 5.4.2 那個 `ClassCastException` 的來源，
而**手動操作 `Cache` 時它是必要的**（`Cache.ValueWrapper.get()` 回 `Object`）。

#### 情境二：`private` / `static` —— 相同

`private` 與 `static` 方法上的 `@Cacheable` **完全無效**，
因為 CGLIB 無法覆寫它們。

⚠️ **而 `private` 有一個額外的性質**：它**只能**被自呼叫，
所以它同時踩到情境一。

#### 情境三：不是 Spring 管理的物件 —— 相同

```java
ProductService service = new ProductService(repo);    // 🔴 沒有代理
service.findById("P-1");                               // 快取完全沒有作用
```

#### 🔴 情境四：**`package-private` —— 這裡與 02 章不同** ★★

**02 章 2.7.2 說**：

> `publicMethodsOnly` 預設 `true` → **非 `public` 方法同樣靜默失效**

⚠️⚠️ **這個說法在 Spring Framework 6.1 上是錯的。實測**：

```
[實驗3] package-private 方法兩次，dbHits = 1（1 = 快取生效；2 = 靜默失效）
[實驗3] 快取裡有 P-1 嗎 = true
[實驗3] proxy class = ...ProductService$$SpringCGLIB$$0
```

**`package-private` 的 `@Cacheable` 生效了。**

**而更重要的是：`@Transactional` 也一樣。實測**：

```
[tx] 容器裡的 TransactionAttributeSource publicMethodsOnly = false
[tx] public 方法在交易裡嗎          = true
[tx] package-private 方法在交易裡嗎 = true
[tx] public 失敗後的列數          = 0（0 = 有 rollback）
[tx] package-private 失敗後的列數 = 0（0 = 有 rollback；1 = 靜默失效）
```

**為什麼**：`publicMethodsOnly` 的**預設值**確實是 `true`
（`new AnnotationTransactionAttributeSource()` → `true`，實測確認），
⚠️ **但 Spring 的組態類別不用預設建構子**。

**位元碼**（`javap -c`，Spring 6.1.6）：

```
// ProxyCachingConfiguration.cacheOperationSource()
0: new     AnnotationCacheOperationSource
4: iconst_0                                  ← ★ 傳 false
5: invokespecial <init>:(Z)V

// ProxyTransactionManagementConfiguration.transactionAttributeSource()
0: new     AnnotationTransactionAttributeSource
4: iconst_0                                  ← ★ 也傳 false
5: invokespecial <init>:(Z)V
```

**兩個組態類別都明確傳 `false`。**

**那 02 章 2.7.2 什麼時候是對的？** 三種情況：

| 情況 | `package-private` 會失效嗎 |
|---|---|
| **JDK 動態代理**（介面代理） | ✅ **會** —— 非 `public` 方法根本不在介面上 |
| **自己建構 `AnnotationTransactionAttributeSource()`**（無參數） | ✅ 會（預設 `true`） |
| Spring Boot 預設（CGLIB + 自動組態） | 🔴 **不會** |

⚠️ **而 shop-service 用的是哪一種？**
02 章 2.5.1 已經定案：`spring.aop.proxy-target-class=true`（CGLIB）。
**所以 02 章 2.7.2 那一段對 shop-service 是錯的。**

**完整的實測結果表**：

| 修飾詞 | `@Transactional` | `@Cacheable` | 為什麼 |
|---|---|---|---|
| `public` | ✅ | ✅ | — |
| **`package-private`**（外部呼叫） | ✅ **生效** | ✅ **生效** | `publicMethodsOnly = false`；CGLIB 可覆寫同套件的 package-private |
| `protected`（內部呼叫） | 🔴 | 🔴 | ⚠️ 那是**自呼叫**，不是修飾詞的問題 |
| `private` | 🔴 | 🔴 | CGLIB 無法覆寫；且只能自呼叫 |
| `static` | 🔴 | 🔴 | CGLIB 無法覆寫 |
| `final` 方法 | 🔴 | 🔴 | CGLIB 無法覆寫（00 章 0.11.2 有守門規則） |

> 📌📌 **這是本章第一個對前面章節的實質修正**（5.13 ①）。
>
> ⚠️ **而它有一個重要的推論，比「哪個說法對」更有價值**：
>
> **`package-private` 的 `@Transactional` 生效**，
> 代表 02 章 2.6.4 那條 ArchUnit 規則
> （「`@Transactional` 方法不可宣告 checked exception」）
> **必須也涵蓋 `package-private` 方法** ——
> 而 `methods().that().areAnnotatedWith(Transactional.class)`
> ✅ **本來就涵蓋**（ArchUnit 不分可見性）。
>
> **所以那條規則是對的，而它「為什麼對」的理由變了。**

### 5.2.4 `@Cacheable` 的全部參數

```java
@Cacheable(
    cacheNames = "products",          // ★ 快取名稱（可多個）
    key = "#id",                       // key 的 SpEL（5.4）
    keyGenerator = "myKeyGen",         // ⚠️ 與 key 互斥
    cacheManager = "redisCacheManager",// 多個 CacheManager 時指定
    cacheResolver = "myResolver",      // ⚠️ 與 cacheManager 互斥
    condition = "#id != null",         // ★ 呼叫【前】判斷（拿不到 result）
    unless = "#result == null",        // ★ 呼叫【後】判斷（拿得到 result）
    sync = true                        // ★★ 5.7.1
)
```

**`condition` 與 `unless` 的差別是這一節唯一需要記的**：

| | `condition` | `unless` |
|---|---|---|
| 何時求值 | **方法執行前** | **方法執行後** |
| 拿得到 `#result` | 🔴 **不行** | ✅ 可以 |
| `true` 代表 | **要**快取 | **不要**快取（注意是反的） |
| 它會阻止**讀**快取嗎 | ✅ **會**（`false` → 連查都不查） | 🔴 **不會**（讀還是照讀） |

⚠️ **最後一列是最容易錯的。**

```java
// 🔴 想「下架的商品不要快取」
@Cacheable(cacheNames = "products", unless = "#result.discontinued()")
public ProductView findById(String id) { ... }
```

**問題**：`unless` 只阻止**寫入**。
如果一個商品**先被快取，然後才下架**，
`unless` **永遠不會被求值**（因為方法根本沒被呼叫）——
於是那個項目留在快取裡直到 TTL。

✅ **正確做法**：下架時**主動失效**（5.6）。

### 5.2.5 `@CachePut` 與 `@Caching`

**`@CachePut`：一律執行方法，然後把結果寫進快取。**

```java
@CachePut(cacheNames = "products", key = "#result.id()")
public ProductView updateAndReturn(String id, ChangePriceCommand cmd) { ... }
```

⚠️ **它看起來是「更新快取」的正確工具，而它有一個致命問題**：

```
交易還沒 commit，@CachePut 已經寫進快取了
→ 交易 rollback → 🔴 快取裡是未提交的值
```

**這與事故 1 完全相同**，而 `@CachePut` **讓它變得更容易發生**
（`@Cacheable` 至少需要「先寫再讀」，`@CachePut` 一步就到）。

✅ **shop-service 的政策：不用 `@CachePut`。**
理由與解法在 5.6.3。

**`@Caching`：組合多個操作。**

```java
@Caching(
    evict = {
        @CacheEvict(cacheNames = "products", key = "#id"),
        @CacheEvict(cacheNames = "productLists", allEntries = true)   // ⚠️ 事故 3
    }
)
public void changePrice(String id, Money price) { ... }
```

⚠️ **它常常是「快取設計有問題」的訊號**：
一個操作要清四個快取 = **那四個快取的邊界畫錯了**（5.6.4）。

---

## 5.3 快取與交易的互動 ★★

**這是全章最重要的一節。** 它的核心是一句話：

> **`@Cacheable` 與 `@CacheEvict` 對交易一無所知。**
> 它們在**方法邊界**做事，而交易在**交易邊界**做事 ——
> 而那兩個邊界不重合。

### 5.3.1 一個可執行的實驗

**先把 5.0 事故 1 完整重現。**

```java
package example.shop.cache;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.cache.concurrent.ConcurrentMapCacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * ★★ 快取與交易的四個實驗。
 *
 * <p>⚠️ 它用真的資料庫（H2 in-memory）與真的交易管理器 ——
 * 而那是必要的：{@code TransactionSynchronizationManager} 的行為
 * 無法用 mock 模擬（02 章 2.2.5 的同一個理由）。
 */
@SpringBootTest(classes = CacheTransactionExperimentTest.App.class)
class CacheTransactionExperimentTest {

    @SpringBootApplication
    @EnableCaching
    static class App {
        @Bean CacheManager cacheManager() { return new ConcurrentMapCacheManager("products"); }
        @Bean Reader reader(JdbcTemplate j) { return new Reader(j); }
        @Bean Writer writer(JdbcTemplate j, Reader r) { return new Writer(j, r); }
    }

    static class Reader {
        // ⚠️⚠️ static 而不是實例欄位 —— 見 5.3.2 的說明
        static final AtomicInteger HITS = new AtomicInteger();
        private final JdbcTemplate jdbc;
        Reader(JdbcTemplate j) { this.jdbc = j; }

        @Cacheable("products")
        public String nameOf(String id) {
            HITS.incrementAndGet();
            return jdbc.queryForObject("select name from products where id=?", String.class, id);
        }
    }

    static class Writer {
        private final JdbcTemplate jdbc;
        private final Reader reader;
        Writer(JdbcTemplate j, Reader r) { this.jdbc = j; this.reader = r; }

        /** ★★ 實驗 4（事故 1）：交易裡寫入 → 讀（進快取）→ rollback */
        @Transactional
        public void renameAndReadThenFail(String id, String newName) {
            jdbc.update("update products set name=? where id=?", newName, id);
            String seen = reader.nameOf(id);          // ★ 未提交的值進了快取
            System.out.println("[實驗4] 交易內讀到 = " + seen);
            throw new IllegalStateException("boom");
        }

        /** ★ 實驗 5：beforeInvocation = true 的 evict + rollback */
        @Transactional
        @CacheEvict(cacheNames = "products", key = "#id", beforeInvocation = true)
        public void evictBeforeThenFail(String id, String newName) {
            jdbc.update("update products set name=? where id=?", newName, id);
            throw new IllegalStateException("boom");
        }

        /** ★ 實驗 1：beforeInvocation = false（預設）的 evict + rollback */
        @Transactional
        @CacheEvict(cacheNames = "products", key = "#id")
        public void evictAfterThenFail(String id, String newName) {
            jdbc.update("update products set name=? where id=?", newName, id);
            throw new IllegalStateException("boom");
        }
    }
    // …（setUp 與斷言略，完整版在 5.11.4）
}
```

### 5.3.2 ⚠️ 一個必須先說的陷阱：計數器不能是實例欄位

**寫這個實驗的第一版用了實例欄位**：

```java
static class Reader {
    final AtomicInteger hits = new AtomicInteger();     // 🔴
    ...
}
```

**測試爆了**：

```
NullPointer Cannot invoke "AtomicInteger.set(int)" because "this.reader.hits" is null
```

**為什麼**：`reader` 是一個 **CGLIB 代理**，
而 CGLIB 代理是**目標類別的子類別** ——
它有**自己的一組欄位**，而那些欄位**從來沒有被初始化**
（代理的建構子不跑目標類別的欄位初始化，它把呼叫委派給目標實例）。

```
reader（代理）      .hits = null       ← 你讀到的
reader（目標實例）  .hits = AtomicInteger  ← 真正有值的
```

⚠️⚠️ **這是一個一般性的陷阱，而它比「快取失效」更難查**：

| 存取方式 | 拿到什麼 |
|---|---|
| `reader.someMethod()` | ✅ 委派給目標 → 正確 |
| **`reader.someField`** | 🔴 **代理自己的欄位 → `null` 或 `0`** |

> 📌 **一般規則**：
> **永遠不要從外部讀一個 Spring bean 的欄位。**
> `public` 欄位、`package-private` 欄位、測試裡的 `@Autowired` 之後直接讀 ——
> **在 CGLIB 代理下全部拿到 `null`。**
>
> ⚠️ **而它在「沒有代理」時是正常的** ——
> 於是「加了 `@Cacheable` 之後測試開始 NPE」是一個很常見的困惑。

✅ **實驗裡改用 `static` 欄位**（它在類別上，代理與目標共用）。
**而正式碼裡的正確做法是「注入一個計數器 bean」**（5.9.1 的 `MeterRegistry`）。

### 5.3.3 實驗結果 🔴

#### 實驗 4（事故 1）：交易裡讀取讓未提交的值進快取

```
[實驗4] 交易內讀到 = 髒名稱
[實驗4] rollback 後 —— 快取 = 髒名稱
[實驗4] rollback 後 —— DB   = 原始名稱
[實驗4] 客戶端下次查到 = 髒名稱（DB hits = 1）
```

🔴🔴 **快取裡有一個「從來沒有在資料庫裡存在過」的值，而下一次查詢命中它。**

⚠️ **注意最後一行的 `DB hits = 1`** ——
它證明第二次查詢**根本沒有碰資料庫**，
所以「等一下再查就好了」是無效的：**它會一直錯到 TTL 到期。**

#### 實驗 1：`beforeInvocation = false`（預設）的 evict + rollback

```
[實驗1] rollback 之後，快取裡的值 = 原始名稱
[實驗1] DB 裡的值 = 原始名稱
[實驗1] 再查一次 nameOf = 原始名稱，dbHits = 1
```

✅ **一致** —— 而它是**因為 evict 根本沒發生**：

> `@CacheEvict` 的 `beforeInvocation` 預設是 `false`，
> 代表「**方法正常回傳之後**才清」。
> 方法拋了例外 → **不清** → 快取保留舊值 → 而 DB 也 rollback 回舊值 → 一致。

#### 實驗 5：`beforeInvocation = true` 的 evict + rollback

```
[實驗5] 預熱後快取 = 原始名稱
[實驗5] rollback 後 —— 快取 = (空)
[實驗5] rollback 後 —— DB   = 原始名稱
```

✅ **也一致** —— 快取空了，下一次查詢會從 DB 讀到正確的舊值。

### 5.3.4 一張「四種組合」的對照表 ★★

**把「evict 的時機」與「交易的結果」交叉起來**：

| | 交易 **commit** | 交易 **rollback** |
|---|---|---|
| **`beforeInvocation = false`**（預設） | ✅ 方法成功 → 清快取 → 一致 | ✅ 不清 → 快取是舊值 = DB 是舊值 → 一致 |
| **`beforeInvocation = true`** | ⚠️ 先清 → 然後 commit → **中間有一個窗口** | ✅ 清了 → 下次從 DB 讀舊值 → 一致 |

⚠️⚠️ **兩個都「一致」，那為什麼還要選？** 因為表格漏了兩個格子：

| 情境 | `beforeInvocation = false` | `beforeInvocation = true` |
|---|---|---|
| **方法成功但交易之後才 rollback**（外層交易 rollback） | 🔴 **已經清了，然後 DB 回到舊值** → 下次讀 DB 拿舊值 → ✅ 其實一致 | ✅ 一致 |
| **⚠️ 方法成功、交易 commit 之間有併發讀** | 🔴🔴 **清了之後、commit 之前，另一個請求 miss → 讀到舊值 → 把舊值放回快取** → **永久錯誤** | 🔴 **同樣的問題** |

🔴 **最後一格是真正的問題，而兩個選項都有。**

**時序圖**：

```
T1（寫）                          T2（讀）
────────────────────────────────────────────────
BEGIN
UPDATE price = 1200
                                  ← 這裡還沒事
清快取（evict）
                                  MISS → SELECT price → 1500（T1 未提交）
                                  cache.put(1500)      ← 🔴 舊值回填
COMMIT（DB 變成 1200）
                                  
結果：DB = 1200，快取 = 1500，而快取【比 DB 舊】
```

⚠️ **這是快取失效的經典難題**，而它**不能**用 `beforeInvocation` 解決 ——
**因為問題不在「清的時機」，在「清了之後有一個可以被回填的窗口」**。

### 5.3.5 三種解法與取捨 ★★

**解法 A：在 `AFTER_COMMIT` 清快取**

```java
/**
 * ★★ 用領域事件把「清快取」推到 commit 之後（02 章 2.12.1）。
 */
@Transactional
public void changePrice(String id, Money newPrice, Actor actor) {
    Product product = products.findById(id).orElseThrow();
    product.changePrice(newPrice, actor);
    products.save(product);
    // ★ 只發事件，不清快取
    events.publishEvent(new ProductPriceChangedEvent(id, newPrice));
}

@Component
public class ProductCacheInvalidator {

    private final CacheManager caches;

    /**
     * ★★ AFTER_COMMIT：交易已經 commit，DB 是新值。
     *
     * <p>⚠️ 三個必須知道的細節（02 章 2.12.2 的三個陷阱）：
     * <ol>
     *   <li>這裡<b>沒有交易</b> —— 不可以寫資料庫（要寫就 {@code REQUIRES_NEW}）。</li>
     *   <li>這裡拋例外<b>不會 rollback</b>（交易已經結束）——
     *       但它會冒到呼叫端 → 04 章 4.10.3 的問題。</li>
     *   <li>它是<b>同步</b>的（預設）—— 清快取的延遲會加到請求上。</li>
     * </ol>
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onPriceChanged(ProductPriceChangedEvent event) {
        try {
            caches.getCache("products").evict(event.productId());
        } catch (RuntimeException e) {
            // ★ 04 章 4.10.3 規則 2：listener 一律 catch
            //   ⚠️ 而規則 3 說「失敗要進 outbox」——
            //      清快取失敗的補償見 5.6.6
            log.error("清快取失敗 productId={}", event.productId(), e);
            cacheEvictFailures.increment();          // ★ 5.9.1 的指標
        }
    }
}
```

**它解決了什麼**：

```
T1（寫）                          T2（讀）
────────────────────────────────────────────────
BEGIN
UPDATE price = 1200
                                  MISS → SELECT → 1500 → put(1500)
COMMIT（DB = 1200）
清快取（AFTER_COMMIT）             ← ★ 把 T2 回填的舊值清掉
                                  
結果：快取空，DB = 1200 → 下次讀拿到 1200 ✅
```

⚠️ **而它沒有解決什麼**：

```
COMMIT
                                  MISS → SELECT → 1200 → 開始組 View（慢，50ms）
清快取（evict）                     
                                  put(1200)        ← 這個順序是對的，沒問題
```

**但如果 SELECT 早於 COMMIT 而 put 晚於 evict**：

```
BEGIN
UPDATE price = 1200
                                  MISS → SELECT → 1500（未提交前的值）
                                                → 組 View（50ms）
COMMIT
清快取（evict）— 快取本來就是空的，清了也沒事
                                  put(1500)       ← 🔴 舊值在 evict【之後】才寫進去
結果：DB = 1200，快取 = 1500 → 永久錯誤
```

🔴 **窗口變小了（從「整個交易」變成「evict 到 put 之間」），但沒有消失。**

**解法 B：延遲雙刪**

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onPriceChanged(ProductPriceChangedEvent event) {
    caches.getCache("products").evict(event.productId());        // 第一次
    // ★ 延遲一段時間再清一次，涵蓋「舊值在 evict 之後才寫入」的窗口
    delayedEvictScheduler.schedule(
            () -> caches.getCache("products").evict(event.productId()),
            Duration.ofMillis(500));
}
```

| | |
|---|---|
| ✅ | 大幅縮小窗口（500ms 通常遠大於「SELECT + 組 View」的時間） |
| 🔴 | **不是保證** —— 一個 GC pause 或慢查詢就能超過 500ms |
| 🔴 | 需要一個排程器，而**它跨不過 JVM 重啟** |
| 🔴 | 「500ms」是猜的 |

**解法 C：不要在寫入路徑清快取 —— 讓快取短命** ✅

```java
@Bean
CacheManager cacheManager() {
    var manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
            // ★★ 30 秒。而不是 10 分鐘
            .expireAfterWrite(Duration.ofSeconds(30))
            .maximumSize(50_000)
            .recordStats());
    return manager;
}
```

**它的論證是**：

> **「快取一致性」是一個不可能完全解決的問題**（它是分散式系統的核心難題）。
> 於是問題從「怎麼保證一致」變成
> **「不一致的窗口能有多短，以及那個長度可以接受嗎」。**

| TTL | 最壞的不一致時間 | 快取效益（假設 8,000 QPS，1 萬個商品） |
|---|---|---|
| 10 分鐘 | 🔴 **10 分鐘** | 命中率 ~99.98% |
| **30 秒** | ✅ **30 秒** | 命中率 ~99.3% |
| 5 秒 | 5 秒 | 命中率 ~96% |
| 不快取 | 0 | 0% |

⚠️ **關鍵的觀察**：從 10 分鐘縮到 30 秒，**命中率只掉 0.68%**，
而**不一致的窗口縮短了 20 倍**。

**原因**：命中率取決於「TTL 內有幾次請求」，
而 8,000 QPS ÷ 1 萬個商品 = 每個商品每秒 0.8 次 →
**30 秒內平均有 24 次請求** → 1 次 miss + 23 次 hit = 95.8%……

⚠️⚠️ **上面那個算法是錯的**，而錯誤值得指出來：
熱門商品與冷門商品的分佈**極度不均**（通常是 Zipf 分佈）。
**真實的命中率必須量測，不能推算**（5.9.2）。

✅ **shop-service 的決定：C + A**。

| 機制 | 負責什麼 |
|---|---|
| **短 TTL（30 秒）** | **兜底** —— 保證任何不一致最多 30 秒 |
| **`AFTER_COMMIT` 清快取** | **加速** —— 大部分情況下 1 秒內就一致了 |

**而 B（延遲雙刪）不採用**，理由：

> **它增加一個排程器與一個猜出來的數字，換到的是「窗口從 30 秒縮到 30 秒」** ——
> 因為 TTL 已經是 30 秒了，延遲雙刪的 500ms 在它面前沒有意義。
>
> 📌 **一般規則**：
> **兩個機制解決同一個問題時，只留成本低的那一個。**

⚠️ **而「30 秒 TTL」有一個代價要說清楚**：

```
行銷改了價格 → 前台最多 30 秒後才更新
```

**這個代價可以接受嗎？** 取決於業務：

| 資料 | 30 秒的不一致可接受嗎 |
|---|---|
| 商品名稱、描述、圖片 | ✅ 完全可以 |
| **價格** | ⚠️ **看情況** —— 而 5.10.1 會論證「價格不該只靠快取的 TTL」 |
| 庫存數量 | 🔴 **不行**（5.10.1） |
| 訂單狀態 | 🔴 不行 |

### 5.3.6 那 `@Cacheable` 在交易裡到底該怎麼辦

**5.3.3 實驗 4 的根本問題是「在交易裡呼叫 `@Cacheable` 方法」。**

**四個選項**：

| 選項 | 做法 | 取捨 |
|---|---|---|
| ① **禁止它** | ArchUnit：`@Transactional` 方法不可呼叫 `@Cacheable` 方法 | ✅ 徹底。⚠️ 見下 |
| ② 讓 `@Cacheable` 在交易裡「只讀不寫」 | 需要自訂 `CacheInterceptor` | 🔴 覆寫框架行為，升級會壞 |
| ③ 用 `condition` 排除交易中的呼叫 | `condition = "!T(...TransactionSynchronizationManager).isActualTransactionActive()"` | ⚠️ 見下 |
| ④ 接受它，靠短 TTL 兜底 | 零成本 | 🔴 30 秒的錯誤資料 |

⚠️ **③ 值得看一下，因為它出乎意料地簡潔**：

```java
@Cacheable(cacheNames = "products",
           // ★ 交易中不使用快取（不讀、不寫）
           condition = "!T(org.springframework.transaction.support"
                     + ".TransactionSynchronizationManager).isActualTransactionActive()")
public ProductView findById(String id) { ... }
```

**`condition = false` 時 `@Cacheable` 完全不作用**（5.2.4 那張表：
`condition` 會阻止**讀也阻止寫**）——
於是「交易裡的呼叫」變成一次普通的方法呼叫。

| | |
|---|---|
| ✅ | 徹底解決事故 1；不需要改呼叫端 |
| ✅ | 一行；而且它的語意寫在註解裡 |
| 🔴 | **SpEL 字串很長且容易打錯**（打錯的話 `condition` 求值失敗 → 見下） |
| 🔴 | **所有寫入路徑的查詢都變成 DB 查詢** —— 而那可能是很多 |
| 🔴🔴 | ⚠️ **它讓「查詢類的 `@Transactional(readOnly = true)` 方法」也不快取** |

⚠️⚠️ **最後一列是致命的。** 01 章 1.9.2 的 `OrderQueryService`
**整個類別**都是 `@Transactional(readOnly = true)` ——
於是選項 ③ 會讓**所有查詢都不快取**。

✅ **shop-service 的決定：① + ④。**

```java
/**
 * ★★ 寫入交易裡不可以呼叫 @Cacheable 方法（5.3.6）。
 *
 * <p>它抓的是事故 1：未提交的值進了快取，然後 rollback，
 * 而那個值<b>永久留在快取裡</b>。
 *
 * <p>⚠️ 規則只針對<b>寫入</b>交易 ——
 * {@code readOnly = true} 的方法不在範圍內（它不會 rollback 出問題）。
 *
 * <p>⚠️⚠️ 而 ArchUnit <b>看不到 readOnly 的值</b>
 * （它是註解的屬性，而 ArchUnit 的 model 能讀註解屬性 —— 見下面的實作）。
 */
@ArchTest
static final ArchRule 寫入交易不可呼叫Cacheable方法 =
        methods().that(new DescribedPredicate<JavaMethod>("是寫入交易") {
            @Override
            public boolean test(JavaMethod m) {
                return m.tryGetAnnotationOfType(Transactional.class)
                        .map(t -> !t.readOnly())
                        .orElse(false);
            }
        }).should(new ArchCondition<JavaMethod>("不呼叫 @Cacheable 方法") {
            @Override
            public void check(JavaMethod m, ConditionEvents events) {
                m.getMethodCallsFromSelf().stream()
                 .filter(call -> call.getTarget().resolveMember()
                         .map(t -> t.isAnnotatedWith(Cacheable.class)).orElse(false))
                 .forEach(call -> events.add(SimpleConditionEvent.violated(m, """
                         %s 在寫入交易裡呼叫了 @Cacheable 方法 %s。
                         未提交的值會進快取，而 rollback 之後它【永久留著】（5.3.3 實驗 4）。
                         修法：把查詢移到交易外，或改用 repository 的非快取方法。
                         """.formatted(m.getFullName(), call.getTarget().getName()))));
            }
        });
```

⚠️ **`m.getMethodCallsFromSelf()` 只看得到「直接呼叫」** ——
`a() → b() → cacheable()` 這條路徑抓不到。
**這是一個已知的不完備**（5.16 的缺口清單）。

**而 ④（短 TTL）是那個不完備的兜底。**

> 📌 **這一節的一般規則**：
> **快取一致性沒有「解決」，只有「把窗口縮到可接受」。**
> 而工程上的做法是**兩層**：
> 一個**主要機制**（`AFTER_COMMIT` 清快取）讓它通常很快，
> 一個**兜底機制**（短 TTL）讓最壞情況有上限。
>
> ⚠️ **只有主要機制的系統，會在主要機制失敗的那天才發現問題。**

---

## 5.4 key 設計 ★

### 5.4.1 預設的 `SimpleKeyGenerator` 做了什麼（實測）

**不寫 `key` 時用的是 `SimpleKeyGenerator`。實測它的行為**：

```java
static Object key(Object... params) {
    return SimpleKeyGenerator.generateKey(params);
}
```

```
[key] 0 個參數  -> SimpleKey []       class=SimpleKey
[key] 1 個參數  -> P-1                class=String        ★ 注意
[key] 2 個參數  -> SimpleKey [P-1, 3] class=SimpleKey
[key] null 參數 -> SimpleKey [null]
```

⚠️ **「1 個參數時直接用那個參數本身」是一個重要的細節**：

| 參數個數 | key 的型別 | 後果 |
|---|---|---|
| 0 | `SimpleKey.EMPTY` | 整個方法只有**一個**快取項目 |
| **1** | **參數本身** | ✅ Redis 的 key 好讀（`products::P-1`） |
| 2+ | `SimpleKey` | ⚠️ Redis 的 key 是 `products::SimpleKey [P-1, 3]` —— **可讀但很醜** |

⚠️⚠️ **而 `SimpleKey` 用在 Redis 上有一個更嚴重的問題**：

```
key = "products::SimpleKey [P-1, 3]"
```

`SimpleKey.toString()` 的格式是**實作細節**，
而它會進入 Redis 的 key 空間 → **升級 Spring 時如果那個格式變了，全部的快取失效**。

✅ **所以多參數的方法一律明確寫 `key`**：

```java
@Cacheable(cacheNames = "orderPages", key = "#customerId + ':' + #page + ':' + #size")
public PageResponse<OrderSummaryView> search(String customerId, int page, int size) { ... }
```

### 5.4.2 🔴 陷阱 1：兩個方法共用一個 key（事故 2）

**實測**：

```
[key] 相同參數不同方法是否同 key: true
```

**`SimpleKeyGenerator.generateKey(params)` 只看參數** ——
它**不看** `method`，也不看 `target`。

⚠️ **看它的簽章就知道了**：

```java
// KeyGenerator 的介面
Object generate(Object target, Method method, Object... params);

// SimpleKeyGenerator 的實作
@Override
public Object generate(Object target, Method method, Object... params) {
    return generateKey(params);        // ★ target 與 method 被丟掉
}
```

**於是事故 2 的條件很寬鬆**：

```
同一個 cacheNames + 同樣的參數 → 同一個項目
```

**三個修法**：

| 修法 | 做法 |
|---|---|
| ① ✅ **不同的 cache 名稱** | `@Cacheable("orders")` / `@Cacheable("ordersForSupport")` |
| ② 明確的 key 前綴 | `key = "'support:' + #orderId"` |
| ③ 自訂 `KeyGenerator` 把方法名放進 key | ⚠️ 見下 |

✅ **選 ①**，理由：

| | ① 不同 cache 名 | ② key 前綴 | ③ 自訂 generator |
|---|---|---|---|
| 可以分別設 TTL | ✅ | 🔴 | 🔴 |
| 可以分別看命中率（5.9.2） | ✅ | 🔴 | 🔴 |
| 可以**分別清空** | ✅ | 🔴 `allEntries` 會清掉兩者 | 🔴 |
| 忘記寫會怎樣 | ⚠️ 兩個方法用同一個名字 → 事故 2 | 忘記前綴 → 事故 2 | ✅ 自動 |

⚠️ **③ 唯一的優勢是「不會忘記」，而它有一個大代價**：

```java
// 🔴 自訂 generator 把方法名放進 key
public class MethodAwareKeyGenerator implements KeyGenerator {
    @Override
    public Object generate(Object target, Method method, Object... params) {
        return method.getDeclaringClass().getSimpleName() + "#"
             + method.getName() + ":" + SimpleKeyGenerator.generateKey(params);
    }
}
```

**key 變成 `OrderQueryService#detail:ORD-1`** ——
於是**改方法名 = 全部的快取失效**。
而「改方法名」是一個**重構**，不該有這種後果。

> 📌 **一般規則**：
> **cache key 不該包含「會被重構改動的東西」**（方法名、類別名、套件名）。
> 這與 04 章 4.2.5 規則 2（`code` 不含會變的東西）是同一條原則。

#### 那 `ClassCastException` 到底會不會發生

**5.0 事故 2 提到一個推論然後說它是錯的。這裡把它做完。**

```java
@Cacheable("orders")
public OrderDetailView detail(String orderId) { ... }

@Cacheable("orders")
public OrderDetailForSupportView detailForSupport(String orderId) { ... }
```

**如果客服先查，然後客戶查 `detail("ORD-1")`**：

```
CacheInterceptor 拿到 cache.get("ORD-1") → 一個 OrderDetailForSupportView
→ 它把這個 Object 從 invoke() 回傳
→ CGLIB 產生的橋接方法宣告回傳 OrderDetailView
→ ⚠️ 位元碼裡有一個 checkcast
→ 🔴 ClassCastException
```

✅ **會拋 `ClassCastException`。實測**：

```
[shared] 客服查到 = SupportView[orderId=ORD-1, customerNote=客戶備註, staffNote=★客服內部評語★]
[shared] 快取裡的型別 = SupportView
[shared] 客戶查時拋 = java.lang.ClassCastException:
    class SharedCacheNameTest$SupportView cannot be cast to
    class SharedCacheNameTest$CustomerView
```

⚠️⚠️ **而一個追加的實驗回答了「那我用 `Object` 接住呢」**：

```java
Object o = svc.detail("ORD-1");        // 不宣告成 CustomerView
```

```
[shared] Object 接住也拋 = ClassCastException
```

**`checkcast` 不在呼叫端，在 CGLIB 產生的方法裡。**

**原因**：CGLIB 產生的覆寫方法簽章是
`public CustomerView detail(String)` —— 它必須符合父類別的簽章。
於是 `MethodInterceptor.intercept()` 回傳的 `Object`
在**那個方法的 return 之前**就要被轉型。

> 📌 **這個細節有一個實用價值**：
> **你無法用「小心的呼叫端寫法」規避這個 bug。**
> 它在代理裡，而代理是框架產生的。

⚠️⚠️ **而 500 反而是幸運的。** 真正的災難是兩個方法**回傳同一個型別**：

```java
@Cacheable("orders")
public OrderDetailView detail(String orderId) { ... }

@Cacheable("orders")
public OrderDetailView detailForSupport(String orderId) { ... }   // ★ 同型別，多填幾個欄位
```

**沒有任何錯誤，而客戶看到 `staffNote`** —— 03 章事故 1 的完全重現。

> 📌 **這對照出一個一般的現象**：
> **「型別不同」是一個意外的安全網。**
> 而 03 章 3.7.2 那個「三種防護都要做」的論證在這裡有第四個實例：
> **不要依賴型別剛好不同。**

✅ **一條守門測試**（5.11.5 有完整版）：

```java
/**
 * ★★ 同一個 cacheNames 不可以被兩個方法使用。
 *
 * <p>它抓事故 2，而且抓得到「兩個方法回傳同型別」那個沒有型別錯誤的版本。
 */
@Test
void 每個cache名稱只被一個方法使用() {
    var byCacheName = new java.util.TreeMap<String, java.util.List<String>>();

    MAIN.stream()
        .flatMap(c -> c.getMethods().stream())
        .forEach(m -> m.tryGetAnnotationOfType(Cacheable.class).ifPresent(ann -> {
            for (String name : names(ann)) {
                byCacheName.computeIfAbsent(name, k -> new java.util.ArrayList<>())
                           .add(m.getFullName());
            }
        }));

    var shared = byCacheName.entrySet().stream()
            .filter(e -> e.getValue().size() > 1)
            .map(e -> "%s 被 %d 個方法使用：%s".formatted(
                    e.getKey(), e.getValue().size(), e.getValue()))
            .toList();

    assertThat(shared)
            .as("""
                同一個 cacheNames 被多個方法使用 → 它們共用快取項目（5.4.2 事故 2）。
                ⚠️ SimpleKeyGenerator 不把「哪個方法」放進 key。
                修法：給每個方法自己的 cache 名稱。
                """)
            .isEmpty();

    // ★★ 下限斷言（04 章 4.12.1 的教訓）
    assertThat(byCacheName).as("掃到 0 個 @Cacheable —— 檢查掃描範圍").isNotEmpty();
}

/** ⚠️ cacheNames 與 value 是別名，兩個都要看。 */
private static java.util.List<String> names(Cacheable ann) {
    return ann.cacheNames().length > 0
            ? java.util.List.of(ann.cacheNames())
            : java.util.List.of(ann.value());
}
```

⚠️ **`names()` 那個輔助方法是必要的**：
`@Cacheable("products")` 填的是 `value`，
`@Cacheable(cacheNames = "products")` 填的是 `cacheNames` ——
**只讀一個會漏掉一半的宣告**。

### 5.4.3 陷阱 2：參數是物件

**實測**：

```
[key] 兩個相等的 record 參數同 key: true
[key] displayName 不同 → 同 key 嗎: false  ⚠️ false = 快取會被 displayName 切碎
```

**具體的情況**：

```java
// 🔴 把 Actor 當參數
@Cacheable("orderLists")
public List<OrderSummaryView> listFor(Actor actor, OrderStatus status) { ... }
```

**`Actor` 是 `record Actor(ActorType type, String id, String displayName)`** ——
於是 key 包含 `displayName`。

| 後果 | 說明 |
|---|---|
| 使用者改了顯示名稱 → **全部的快取項目失效** | 而那與查詢結果無關 |
| ⚠️ **同一個人有兩個快取項目** | 如果 `displayName` 從 JWT 來，而 JWT 裡的名字更新了 |
| key 變長 | Redis 的 key 含中文名字 |

✅ **修法：只傳「真正影響結果的東西」**：

```java
@Cacheable(cacheNames = "orderLists", key = "#actor.id() + ':' + #status")
public List<OrderSummaryView> listFor(Actor actor, OrderStatus status) { ... }
```

⚠️⚠️ **而這個修法引入一個新的 bug**：

```
客戶 cus_1 查 → key = "cus_1:PAID" → 快取
⚠️ 客服（也是 cus_1？不會）…
```

**真正的問題是別的**：`listFor` 的結果**取決於 `actor.type()`**
（客服看得到 `internalNote`、看得到別人的訂單）——
而新的 key **只有 `actor.id()`**。

✅ **正確的 key**：

```java
key = "#actor.type() + ':' + #actor.id() + ':' + #status"
```

> 📌📌 **這是 key 設計的核心判準**：
>
> **key 必須包含「所有會改變結果的輸入」，且不包含其他任何東西。**
>
> | 少了一個 | 🔴 **不同的輸入拿到同一個結果**（事故 2 的一般形式） |
> | 多了一個 | ⚠️ 快取被切碎（命中率下降，但**正確**） |
>
> ⚠️ **兩種錯誤的嚴重程度差很多**：少一個是**正確性**問題，多一個是**效能**問題。
> **不確定的時候，多放。**

### 5.4.4 陷阱 3：把「權限」放進 key（或忘記放）

**5.4.3 的結論引出一個更難的問題**：

```java
// 客服可以看到別人的訂單。那 key 要放什麼？
@Cacheable(cacheNames = "orderDetails", key = "???")
public OrderDetailView detail(String orderId, Actor actor) { ... }
```

**三個候選**：

| key | 問題 |
|---|---|
| `#orderId` | 🔴🔴 **客服查過的訂單，客戶也會拿到客服版** |
| `#orderId + ':' + #actor.id()` | ✅ 正確。🔴 **快取被切碎到幾乎沒用**（每個訂單 × 每個查過它的人） |
| **`#orderId + ':' + #actor.type()`** | ✅ 正確且不切碎（只有 6 個 `ActorType`） |

⚠️ **第三個看起來完美，而它有一個前提**：

> **同一個 `ActorType` 的所有人看到的內容必須完全相同。**

**檢查 03 章 3.7.3 的欄位 × 角色表**：

| 欄位 | 依賴什麼 |
|---|---|
`internalNote` | `ActorType`（內部人員看得到） |
`staffNote` | `ActorType` |
`customerNote` | ✅ 所有人 |
| ⚠️ **「這是不是我的訂單」** | **`actor.id()`** ← 🔴 |

**於是第三個候選是錯的**：

```
客戶 A 查自己的訂單 ORD-1 → key = "ORD-1:CUSTOMER" → 快取
客戶 B 查 ORD-1（不是他的）→ key 相同 → 🔴 命中 → 【他看到了 A 的訂單】
```

⚠️⚠️ **而這個 bug 不會被 `findByIdVisibleTo` 擋住** ——
因為 `@Cacheable` 命中時**方法根本沒被呼叫**（5.2.1 第 ⑤ 步）。

✅ **正確答案：不要快取這個方法。**

**理由**：

> **「授權」與「快取」在同一個方法上是不相容的。**
> 快取的價值是「跳過方法」，而授權的前提是「方法一定要跑」。

✅ **正確的拆法**：

```java
/**
 * ★★ 授權在外，快取在內。
 *
 * <p>⚠️ 這個方法<b>不快取</b> —— 它做授權。
 */
public OrderDetailView detail(String orderId, Actor actor) {
    // ① 授權：一定會跑（沒有快取）
    //    ⚠️ 而它只查一個「這張訂單屬於誰」—— 那是可以快取的（見 ②）
    String ownerId = orderOwnership.ownerOf(orderId);
    if (!actor.isPrivileged() && !ownerId.equals(actor.id())) {
        throw new ResourceNotFoundException("Order", orderId);   // 01 章 1.8.3
    }
    // ② 內容：可以快取（它不含權限判斷）
    return orderContent.detailOf(orderId, actor.isPrivileged());
}

@Service
public class OrderContentService {
    /**
     * ★ key 包含「是不是內部人員」，而<b>不</b>包含「是誰」。
     *
     * <p>它成立的前提：這個方法<b>不做授權</b>（授權在呼叫端做完了）。
     * ⚠️ 而那個前提要寫在 javadoc 裡，因為<b>沒有機制可以守它</b>。
     */
    @Cacheable(cacheNames = "orderContents", key = "#orderId + ':' + #privileged")
    public OrderDetailView detailOf(String orderId, boolean privileged) { ... }
}

@Service
public class OrderOwnershipService {
    /**
     * ★★ 只快取「訂單 → 擁有者」這個極小的映射。
     *
     * <p>它是理想的快取對象：
     * <ul>
     *   <li><b>幾乎不變</b> —— 訂單的擁有者永遠不變（TTL 可以很長）。</li>
     *   <li><b>極小</b> —— 一個 String。40 萬張訂單 ≈ 20 MB。</li>
     *   <li><b>命中率極高</b> —— 每一次查詢詳情都會用到它。</li>
     * </ul>
     */
    @Cacheable(cacheNames = "orderOwners", key = "#orderId")
    public String ownerOf(String orderId) {
        return orderRepository.findOwnerId(orderId)
                .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));
    }
}
```

> 📌📌 **這一節的結論比 key 的語法重要得多**：
>
> **「這個方法能不能快取」常常不是「要不要」的問題，
> 而是「這個方法的職責混在一起了」的訊號。**
>
> `detail(orderId, actor)` 同時做**授權**與**取內容** ——
> 而那兩件事的快取性質**完全相反**：
>
> | | 授權 | 取內容 |
> |---|---|---|
> | 依賴 `actor.id()` | ✅ | 🔴 |
> | 一定要跑 | ✅ | 🔴 |
> | 可以快取 | 🔴 | ✅ |
>
> **拆開之後，兩邊各自都好處理。**

---

## 5.5 本地、分散式，還是兩層

### 5.5.1 三個選項的具體差別

| | **本地**（Caffeine） | **分散式**（Redis） | **兩層** |
|---|---|---|---|
| 讀取延遲 | **14 ns**（實測） | ~500 µs（含網路 + 反序列化） | 命中 L1 時 14 ns |
| 容量 | 受 JVM heap 限制 | 受 Redis 記憶體限制 | — |
| **多個實例間一致嗎** | 🔴 **不一致**（各自一份） | ✅ 一致 | 🔴 L1 不一致 |
| 清快取要做什麼 | 🔴 **要通知所有實例** | ✅ 一次 | 🔴 同本地 |
| 序列化成本 | ✅ **零**（存物件參考） | ⚠️ 每次讀寫都要 | 部分 |
| 重啟後 | 🔴 全空（冷啟動） | ✅ 保留 | L2 保留 |
| 多一個要維運的東西 | ✅ 沒有 | 🔴 Redis 叢集 | 🔴 |
| GC 壓力 | ⚠️ **有**（物件在 heap） | ✅ 沒有 | ⚠️ 有 |

⚠️ **「50 ns vs 500 µs」是一萬倍，而它常常不重要。**

**為什麼**：對照的基準不是彼此，而是**沒有快取**：

| | 延遲 | 相對於「查資料庫」 |
|---|---|---|
| **本地快取（Caffeine）** | **14 ns**（實測） | **1/200,000** |
| Redis | ~500 µs（典型值，本機無 Redis 未實測） | **1/6** |
| 資料庫查詢（含連線池等待） | ~3 ms | 1 |

⚠️ **`14 ns` 是實測值**（Caffeine 1 萬個項目、5,000 萬次讀取、
key 預先放在陣列裡）。而它有一個有趣的細節：

```
[latency] Caffeine get（key 已存在陣列）  = 14 ns/op
[latency] Caffeine get（含 "K" + i 串接） = 28 ns/op
```

🔴 **「組 key 這個字串」花掉的時間與「查快取」一樣多。**

> 📌 **這對 5.6.2「手動組 key」有一個具體的意義**：
> `orderId + ":" + privileged` 這個串接在**本地快取**上是可觀的成本（~14 ns），
> 而在 **Redis** 上完全是雜訊（500,000 ns 裡的 14 ns）。
> ⚠️ 而 14 ns × 8,000 QPS = **0.1 ms/秒** —— **它仍然是雜訊。**
>
> **這是一個「量到了但不重要」的例子，而知道它不重要本身有價值** ——
> 它讓「為了省字串串接而把 key 設計弄複雜」這個選項被排除。

**Redis 只快 6 倍，本地快 20 萬倍** ——
✅ **而 6 倍通常已經足夠**（3ms → 0.5ms），
而**它省下的資料庫連線是真正的價值**（02 章 2.9.3）。

### 5.5.2 「多個實例間不一致」有多嚴重

**這是選本地快取最主要的代價，值得量化。**

**情境**：3 個應用實例，本地快取 TTL 10 分鐘，行銷改了價格。

```
T=0     實例 A 收到「改價格」請求 → 改 DB → 清【自己的】本地快取
T=0     實例 B 的本地快取還是舊價格
T=0     實例 C 的本地快取還是舊價格
T=0~600 🔴 客戶依 LB 的分配，【三分之二的機率】看到舊價格
```

**四個處理方式**：

| 方式 | 做法 | 取捨 |
|---|---|---|
| ① **短 TTL** | 30 秒（5.3.5 解法 C） | ✅ 簡單。不一致上限 = TTL |
| ② **廣播失效** | Redis pub/sub 通知所有實例清 | ⚠️ 見下 |
| ③ **只用 Redis** | 沒有本地快取 | ✅ 一致。🔴 每次讀都走網路 |
| ④ **兩層 + 廣播** | L1 本地 + L2 Redis + pub/sub 清 L1 | 🔴 最複雜 |

⚠️ **② 值得展開，因為它看起來是「正確」的答案**：

```java
/**
 * ★ 透過 Redis pub/sub 廣播「清這個 key」。
 *
 * <p>⚠️ 三個它解決不了的問題：
 * <ol>
 *   <li><b>訊息可能遺失</b> —— Redis pub/sub 是 fire-and-forget，
 *       訂閱端斷線期間的訊息<b>不會補送</b>。</li>
 *   <li><b>新啟動的實例收不到之前的訊息</b> ——
 *       而它的快取是空的，所以其實沒問題；
 *       ⚠️ 但如果它從 L2 預熱過，那就有問題。</li>
 *   <li><b>延遲仍然存在</b> —— 網路往返 + 訂閱端處理，通常 1～50ms。</li>
 * </ol>
 *
 * <p>👉 <b>所以它仍然需要短 TTL 兜底</b> ——
 * 而如果 TTL 已經夠短，它的邊際價值就很小（5.3.5 的同一個論證）。
 */
@Component
public class CacheInvalidationBroadcaster {

    private static final String CHANNEL = "cache-invalidate";

    private final StringRedisTemplate redis;
    private final CacheManager caches;
    private final String instanceId;      // ★ 為了忽略自己發的訊息

    public void broadcast(String cacheName, String key) {
        redis.convertAndSend(CHANNEL, instanceId + "|" + cacheName + "|" + key);
    }

    /** ⚠️ 收到自己發的訊息要忽略（否則清兩次 —— 無害但浪費）。 */
    public void onMessage(String payload) {
        String[] parts = payload.split("\\|", 3);
        if (parts.length != 3 || instanceId.equals(parts[0])) { return; }
        var cache = caches.getCache(parts[1]);
        if (cache != null) { cache.evict(parts[2]); }
    }
}
```

### 5.5.3 shop-service 的決定

**依「資料的性質」分成三組**：

| 快取 | 存什麼 | 選擇 | TTL | 理由 |
|---|---|---|---|---|
| `orderOwners` | 訂單 → 擁有者（`String`） | **本地** | **1 小時** | ✅ **永遠不變** → 不一致不可能發生；極小 |
| `productSummaries` | 商品摘要（名稱、圖片） | **本地** | **5 分鐘** | 改動極少；5 分鐘的不一致可接受 |
| **`productPrices`** | 商品價格 | **Redis** | **30 秒** | ⚠️ **價格必須一致**（5.10.1） |
| `orderContents` | 訂單詳情 View | **本地** | **30 秒** | 只有訂單自己的變動會影響它，而那時會發事件清快取 |
| `couponDefinitions` | 券的定義 | **本地** | 5 分鐘 | 券的定義幾乎不變 |
| 🔴 `couponUsage` | 券的已用次數 | **不快取** | — | 5.10.1（它是計數器，必須即時） |
| 🔴 `stockLevels` | 庫存數量 | **不快取** | — | 5.10.1 |

⚠️ **`orderOwners` 用 1 小時的 TTL 而其他都是 30 秒～5 分鐘**，
而那個差別的理由是**唯一真正的判準**：

> **「這份資料會不會變？」**
>
> | 會變 | TTL = 「可接受的不一致時間」 |
> | **不會變** | TTL = 「記憶體允許的最長時間」 |

**訂單的擁有者永遠不變** → 它的 TTL 只受記憶體限制。

### 5.5.4 兩層快取為什麼通常不值得

**「L1 本地 + L2 Redis」聽起來是兩者的優點相加。實際上**：

| 想要的 | 實際得到 |
|---|---|
| L1 命中 → 50 ns | ✅ 真的 |
| L1 miss → L2 命中 → 500 µs | ✅ 真的 |
| 兩者都 miss → DB | ✅ 真的 |
| **一致性 = Redis 的一致性** | 🔴🔴 **不對** —— L1 是本地的，所以一致性 = **L1 的一致性** |

🔴 **兩層快取的一致性等於最弱的那一層。**

**而它的複雜度是相加的**：

```
要處理：L1 的失效、L2 的失效、L1 與 L2 之間的不一致、
        L2 掛掉時 L1 要不要繼續用、L1 預熱要不要從 L2 讀、
        兩層的 TTL 關係（L1 < L2 才有意義）…
```

✅ **shop-service 不用兩層**，而如果要用，**唯一合理的形狀是**：

```
L1 的 TTL 極短（1～5 秒）→ 它只吸收「同一個請求內的重複查詢」與「瞬間的熱點」
L2 的 TTL 正常（30 秒～5 分鐘）→ 它是真正的快取
```

⚠️ **「L1 的 TTL 是 1 秒」讓一致性問題幾乎消失** ——
而那也讓「L1 是不是必要」變成一個真的問題。

> 📌 **一般規則**：
> **兩層快取值得的條件是「L2 的延遲成為瓶頸」。**
> 而 500 µs 成為瓶頸的前提是**每個請求要查很多次** ——
> 如果是那樣，先問「為什麼一個請求要查 50 次快取」（那通常是 N+1）。

---

## 5.6 失效策略 ★★

### 5.6.1 `@CacheEvict` 為什麼幾乎總是不夠

```java
@CacheEvict(cacheNames = "products", key = "#id")
public void changePrice(String id, Money price) { ... }
```

**它假設一件事**：**「改了商品 X」只影響「商品 X 的快取項目」。**

⚠️ **而那幾乎從來不成立。** 改一個商品的價格會影響：

| 受影響的快取 | 為什麼 |
|---|---|
| `products::P-1001` | ✅ 明顯 |
| `productPrices::P-1001` | ✅ 明顯 |
| **`productLists::category:3C:page:0`** | 🔴 列表頁含這個商品的價格 |
| **`productLists::sort:price_asc:page:0`** | 🔴🔴 **改價格會改變排序** → 這個商品可能換頁 |
| **`searchResults::降噪耳機`** | 🔴 搜尋結果含價格 |
| **`homepage::hot-deals`** | 🔴 首頁的特價區 |
| ⚠️ **`carts::*`**（購物車的小計） | 🔴🔴 **每一個含這個商品的購物車** |

**於是 `@CacheEvict` 變成**：

```java
@Caching(evict = {
    @CacheEvict(cacheNames = "products", key = "#id"),
    @CacheEvict(cacheNames = "productPrices", key = "#id"),
    @CacheEvict(cacheNames = "productLists", allEntries = true),      // 🔴 事故 3
    @CacheEvict(cacheNames = "searchResults", allEntries = true),     // 🔴
    @CacheEvict(cacheNames = "homepage", allEntries = true),          // 🔴
    // ⚠️ carts 怎麼辦？沒有辦法只清「含這個商品的購物車」
})
public void changePrice(String id, Money price) { ... }
```

🔴 **三個 `allEntries = true`** —— 而那就是事故 3。

### 5.6.2 三個處理方式

**方式 A：不要快取「衍生的東西」**

| 快取 | 是不是衍生的 |
|---|---|
| `products::P-1001` | ✅ 原始（一個 row 對一個項目） |
| `productLists::...` | 🔴 **衍生**（多個 row 組成） |
| `carts::...` | 🔴🔴 **衍生且跨聚合** |

✅ **只快取「原始的、一對一的」東西**：

```java
// 🔴 快取整個列表
@Cacheable("productLists")
public List<ProductView> listByCategory(String category, int page) { ... }

// ✅ 快取「id 清單」（很少變）+ 逐個從 products 快取取內容
public List<ProductView> listByCategory(String category, int page) {
    List<String> ids = productIndex.idsByCategory(category, page);   // ★ 這個可以快取
    return products.findAllById(ids);                                 // ★ 走 products 快取
}

@Cacheable(cacheNames = "categoryIndex", key = "#category + ':' + #page")
public List<String> idsByCategory(String category, int page) { ... }
```

⚠️ **它把「改價格要清 6 個快取」變成「改價格只要清 1 個」**：

| 操作 | 要清什麼 |
|---|---|
| 改價格 | ✅ **只清 `products::P-1001`** —— 列表的 id 清單沒變 |
| 改分類 | 清 `categoryIndex`（兩個分類） |
| 上下架 | 清 `categoryIndex` |

**而「依價格排序」呢**：

```java
// 🔴 categoryIndex::sort:price_asc 會因為改價格而改變
```

✅ **兩個選項**：

| 選項 | |
|---|---|
| ① 排序類的索引**不快取**（每次查 DB，靠 index 加速） | ✅ 簡單、正確 |
| ② 改價格時清掉該分類的排序索引 | ⚠️ 要知道商品屬於哪些分類 → 一次額外查詢 |

**方式 B：靠 TTL，不主動清**（5.3.5 解法 C 的延伸）

**方式 C：版本化的 key** ★

```java
/**
 * ★★ 把「版本」放進 key —— 於是「清快取」變成「加版本號」。
 *
 * <p>它的關鍵性質：<b>不需要知道有哪些 key</b>。
 * 版本一變，所有舊 key 自然不會再被讀到（然後被 TTL 淘汰）。
 */
@Service
public class ProductCatalogVersion {

    private final StringRedisTemplate redis;
    private static final String KEY = "catalog:version";

    /** 讀目前的版本（它自己也快取，1 秒）。 */
    @Cacheable(cacheNames = "catalogVersion", key = "'v'")
    public long current() {
        String v = redis.opsForValue().get(KEY);
        return v == null ? 0L : Long.parseLong(v);
    }

    /** ★ 「清掉所有列表快取」= 版本 +1。O(1)，不管有幾百萬個 key。 */
    public void bump() {
        redis.opsForValue().increment(KEY);
    }
}

@Service
public class ProductListService {

    private final ProductCatalogVersion version;

    @Cacheable(cacheNames = "productLists",
               key = "#root.target.version.current() + ':' + #category + ':' + #page")
    public List<ProductView> listByCategory(String category, int page) { ... }

    public ProductCatalogVersion getVersion() { return version; }   // ★ SpEL 要 getter
}
```

⚠️⚠️ **`#root.target.version.current()` 這個 SpEL 有三個問題**：

| 問題 | |
|---|---|
| 1 | **每次求值都呼叫 `current()`** —— 而它自己是 `@Cacheable`（`catalogVersion`）→ ⚠️ **但這是自呼叫嗎？** 不是（`version` 是另一個 bean）→ ✅ 沒問題 |
| 2 | ⚠️ `#root.target` 是**目標物件**（不是代理）→ **`version.current()` 走的是代理**（因為 `version` 是注入的 bean）→ ✅ 沒問題 |
| 3 | 🔴 **SpEL 字串長且無法被編譯器檢查** —— 打錯 `#root.taget` 會在**執行時**失敗 |

✅ **更清楚的寫法：不用 SpEL，自己組 key**：

```java
public List<ProductView> listByCategory(String category, int page) {
    String key = version.current() + ":" + category + ":" + page;
    return cached("productLists", key, () -> loadFromDb(category, page));
}

/**
 * ★ 一個「手動快取」的小工具。
 *
 * <p>⚠️ 它放棄了 `@Cacheable` 的宣告式簡潔，換到三件事：
 * <ol>
 *   <li>key 的組成是<b>普通的 Java</b>（編譯器檢查、可除錯、可測試）。</li>
 *   <li>沒有自呼叫問題（5.2.3 情境一）。</li>
 *   <li>沒有「交易裡的 `@Cacheable`」問題（5.3.6）。</li>
 * </ol>
 *
 * <p>⚠️⚠️ 而它<b>沒有</b> `sync = true` 的擊穿保護（5.7.1）——
 * 要自己做，見 5.7.1 的 `Cache#get(key, Callable)`。
 */
private <T> T cached(String cacheName, String key, java.util.function.Supplier<T> loader) {
    Cache cache = cacheManager.getCache(cacheName);
    if (cache == null) { return loader.get(); }       // ⚠️ 快取不存在時要能跑
    // ★ Cache#get(Object, Callable) 在 Caffeine 下是 atomic 的（= sync=true 的效果）
    return cache.get(key, loader::get);
}
```

⚠️ **最後一行是這一段的重點**，5.7.1 會展開。

### 5.6.3 為什麼不用 `@CachePut`

**5.2.5 已經給了理由（交易未 commit 就寫快取）。這裡補一個更根本的**：

```java
// 🔴 @CachePut 的假設
@CachePut(cacheNames = "products", key = "#id")
public ProductView changePrice(String id, Money price) {
    // ...改價格...
    return ProductView.from(product);      // ★ 直接把新值放進快取
}
```

**它假設「寫入路徑組出來的 View」與「查詢路徑組出來的 View」相同。**

⚠️ **而那幾乎不成立**：

| 差異 | 具體 |
|---|---|
| 查詢路徑會 `JOIN` 更多東西 | `ProductView` 含「分類名稱」、「品牌名稱」、「平均評分」 |
| 寫入路徑只載入了 `Product` | → `ProductView.from(product)` 的分類名稱是 `null` |
| 🔴 **於是快取裡是一個「欄位不全」的 View** | 而它與 DB 一致（價格對了），所以**沒有任何機制會發現** |

**這與 03 章 3.4.2「漏映射的三種形狀」是同一類問題**，
而 03 章 3.8.2 那個 `MappingCompleteness` 掃描測試**抓不到它**
（它檢查 mapper，而這裡是「View 的來源不同」）。

✅ **政策：一律 `@CacheEvict`（讓下一次查詢重新載入），不用 `@CachePut`。**

**代價**：下一次查詢會 miss 一次。
**而那個代價是 3 ms，換到「View 一定完整」。**

> 📌 **一般規則**：
> **「更新快取」比「清快取」危險，因為它需要「寫入路徑知道查詢路徑的形狀」。**
> 清快取不需要知道任何事。

### 5.6.4 一張「哪個操作清哪些快取」的總表

⚠️ **這張表的存在本身是一個訊號**：如果它有 30 列，快取的邊界畫錯了。

| 操作 | 清什麼 | 怎麼清 |
|---|---|---|
| 商品改價格 | `products::{id}` | `AFTER_COMMIT` 事件 |
| 商品改名稱／圖片 | `products::{id}`、`productSummaries::{id}` | 同上 |
| 商品上下架 | `products::{id}`、`categoryIndex`（該分類） | 同上 |
| 商品換分類 | `products::{id}`、`categoryIndex`（**兩個**分類） | 同上 |
| 訂單狀態變更 | `orderContents::{id}:*` ⚠️ 兩個項目（`true`/`false`） | `AFTER_COMMIT` |
| 訂單備註變更 | 同上 | 同上 |
| 券的定義變更 | `couponDefinitions::{code}` | 同上 |
| **訂單建立** | ✅ **什麼都不用清** | — |
| **庫存變動** | ✅ 什麼都不用清（庫存不快取） | — |

⚠️ **`orderContents::{id}:*` 那個 `*` 是一個問題** ——
key 是 `#orderId + ':' + #privileged`，所以一張訂單有**兩個**項目：

```java
// ★ 明確清兩個，不要用 allEntries
cache.evict(orderId + ":true");
cache.evict(orderId + ":false");
```

**而它可以做得更好**：

```java
/**
 * ★ 一個「清掉一張訂單的所有 privileged 變體」的小工具。
 *
 * <p>⚠️ 它寫死了「只有 true/false 兩種」——
 * 而如果 key 的組成改了（例如加上 Locale），這裡會漏。
 * 👉 <b>所以它與 key 的組成必須放在同一個類別裡</b>（5.6.5）。
 */
void evictOrderContents(String orderId) {
    Cache cache = caches.getCache("orderContents");
    for (boolean privileged : new boolean[]{true, false}) {
        cache.evict(OrderContentKeys.of(orderId, privileged));
    }
}
```

### 5.6.5 ★ key 的組成與清除必須在同一個地方

**5.6.4 那個「寫死 true/false」暴露了一個結構問題**：

```
key 的組成寫在 @Cacheable 的 SpEL 裡    ← 一個地方
清除的邏輯寫在 invalidator 裡            ← 另一個地方
```

**兩個地方 = 一定會不一致。**

✅ **把 key 的組成抽成一個類別**：

```java
/**
 * ★★ {@code orderContents} 快取的 key 規則 —— <b>唯一</b>的定義處。
 *
 * <p>它同時被三個地方使用：
 * <ol>
 *   <li>{@code OrderContentService} 產生 key。</li>
 *   <li>{@code OrderCacheInvalidator} 清除 key。</li>
 *   <li>{@code OrderContentCacheKeyTest} 驗證兩者一致（5.11.5）。</li>
 * </ol>
 *
 * <p>⚠️ 加一個維度（例如 Locale）時，{@link #allVariants} 會編譯錯誤地提醒你 ——
 * 因為它必須列舉所有維度的組合。
 */
public final class OrderContentKeys {

    private OrderContentKeys() {}

    public static final String CACHE = "orderContents";

    public static String of(String orderId, boolean privileged) {
        return orderId + ":" + privileged;
    }

    /** ★ 一張訂單的所有 key 變體 —— 清除時用它，不要用 allEntries。 */
    public static List<String> allVariants(String orderId) {
        return List.of(of(orderId, true), of(orderId, false));
    }
}
```

```java
@Service
public class OrderContentService {
    // ⚠️ SpEL 無法呼叫 static 方法而不寫全名，所以這裡用手動快取（5.6.2 方式 C）
    public OrderDetailView detailOf(String orderId, boolean privileged) {
        return cached(OrderContentKeys.CACHE,
                      OrderContentKeys.of(orderId, privileged),
                      () -> loadFromDb(orderId, privileged));
    }
}
```

```java
@Component
public class OrderCacheInvalidator {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onOrderChanged(OrderChangedEvent event) {
        Cache cache = caches.getCache(OrderContentKeys.CACHE);
        // ★ 同一個類別提供的清單 —— 不可能漏
        OrderContentKeys.allVariants(event.orderId()).forEach(cache::evict);
    }
}
```

⚠️ **`@Cacheable` 的 SpEL 可以呼叫 static 方法，只是很醜**：

```java
@Cacheable(cacheNames = "orderContents",
           key = "T(example.shop.order.cache.OrderContentKeys).of(#orderId, #privileged)")
```

| | SpEL 版 | 手動快取版 |
|---|---|---|
| key 的定義只有一份 | ✅ | ✅ |
| 編譯器檢查 | 🔴 **字串** | ✅ |
| 打錯類別名會怎樣 | 🔴 **執行時 `SpelEvaluationException`** | 編譯錯誤 |
| 簡潔 | ⚠️ 一行很長 | ⚠️ 三行 |

✅ **shop-service 的政策**：
**key 只有一個參數 → 用 `@Cacheable`；key 需要組合 → 用手動快取。**

> 📌 **這條政策的判準不是「哪個好看」**，是：
> **「這個 key 的規則會不會被第二個地方使用？」**
> 會 → 它需要一個有名字的類別 → 那時 SpEL 的字串就沒有優勢了。

### 5.6.6 清快取失敗了怎麼辦

**5.3.5 解法 A 的 listener 裡有一個 `catch`**：

```java
} catch (RuntimeException e) {
    log.error("清快取失敗 productId={}", event.productId(), e);
    cacheEvictFailures.increment();
}
```

⚠️ **這就是 04 章事故 3 的形狀**（`catch` + `log.error` + 沒有人在看）。

**而這一次「不做補償」是可以辯護的**，理由：

| | |
|---|---|
| **短 TTL 是兜底** | 清失敗 → 最多 30 秒後自然過期 |
| 清快取沒有「部分成功」 | 它是一個 `DEL` —— 要嘛成功要嘛失敗 |
| **失敗率可以監控** | `cacheEvictFailures` 是一個指標（5.9.1） |

✅ **而它需要一個告警規則**：

```yaml
# 清快取的失敗率超過 1% → 告警
# ⚠️ 理由：它代表「Redis 不穩」，而那會同時影響讀取
- alert: CacheEvictFailureRateHigh
  expr: rate(cache_evict_failures_total[5m]) / rate(cache_evict_total[5m]) > 0.01
  for: 5m
```

⚠️ **而「本地快取」的清除不會失敗**（它是一個 `ConcurrentHashMap.remove`）——
所以這個指標只對 Redis 有意義。

> 📌 **04 章 4.14 誤區 7 說「`catch` + `log.error` 之後繼續走」是錯的。**
> **這裡是一個例外，而它成立的條件很明確**：
>
> | 條件 | 這裡滿足嗎 |
> |---|---|
> | 有一個**獨立的**兜底機制 | ✅ 短 TTL |
> | 失敗**不會**留下不一致的狀態 | ✅ 清失敗 = 快取還是舊的（而它會過期） |
> | 失敗率**有指標與告警** | ✅ |
>
> ⚠️ **三個條件缺一個，它就變回誤區 7。**

---

## 5.7 擊穿、雪崩、穿透 ★★

**三個名字經常被混用**，而它們是**三個不同的問題**，有**三個不同的解法**。

| 名字 | 英文 | 一句話 | 觸發條件 |
|---|---|---|---|
| **擊穿** | cache stampede / dog-pile | **一個** 熱門 key 過期，N 個請求同時回填 | 熱點 + 過期 |
| **雪崩** | cache avalanche | **很多** key 同時過期 | 同時寫入 / `allEntries` / Redis 重啟 |
| **穿透** | cache penetration | 查一個**不存在**的東西，每次都打 DB | 惡意或錯誤的 id |

### 5.7.1 擊穿：實測與解法

**實測**（50 個執行緒同時查同一個 key，載入耗時 120ms）：

```
[實驗7] sync=false → 實際載入次數 = 50 / 50 個執行緒
[實驗7] sync=true  → 實際載入次數 =  1 / 50 個執行緒
```

**`sync = true` 把 50 次資料庫查詢變成 1 次。**

```java
@Cacheable(cacheNames = "products", sync = true)
public ProductView findById(String id) { ... }
```

⚠️⚠️ **而它有五個必須知道的限制**：

| # | 限制 | 說明 |
|---|---|---|
| 1 | 🔴 **只在單一 JVM 內有效** | 3 個實例 → 最少 3 次載入。⚠️ 而那通常**已經夠好**（3 次 vs 8,000 次） |
| 2 | 🔴🔴 **`unless` 不能用** —— 而它**在第一次呼叫時**才炸（不是啟動時） | 見下 |
| 3 | 🔴🔴 **多個 `cacheNames` 不能用** —— 同樣是第一次呼叫時才炸 | 見下 |
| 4 | ⚠️ **它是「阻塞」的** | 其他 49 個執行緒**等** 120ms（而不是各自查 120ms）→ ✅ 通常是好事 |
| 5 | ⚠️ **取決於 `CacheManager` 支援** | 見下 |

**限制 5 值得展開。** `sync = true` 的實作是呼叫
`Cache#get(Object, Callable)`，而**那個方法的原子性由實作決定**：

| `Cache` 實作 | `get(key, Callable)` 是 atomic 嗎 | 實測 |
|---|---|---|
| `CaffeineCache` | ✅ 是（底層是 `LoadingCache#get`） | **1 / 50** |
| `ConcurrentMapCache` | ✅ 是（`computeIfAbsent`） | **1 / 50** |
| `RedisCache` | ⚠️ **不是完全 atomic** —— 見下 |

⚠️ **`RedisCache#get(key, Callable)` 的實作**（Spring Data Redis 3.2）：

```java
// 簡化後的邏輯
public <T> T get(Object key, Callable<T> valueLoader) {
    ValueWrapper result = get(key);
    if (result != null) { return (T) result.get(); }
    // ⚠️ 這裡有一個 JVM 內的鎖（synchronized on a per-key lock）
    //    但那個鎖【不跨 JVM】
    return (T) getSynchronized(key, valueLoader);
}
```

**於是 Redis 上的 `sync = true` 等於「每個 JVM 一次載入」** ——
與限制 1 是同一件事。

#### 真正跨 JVM 的擊穿保護：分散式鎖

```java
/**
 * ★ 用 Redis 的 SET NX 做「只有一個實例去載入」。
 *
 * <p>⚠️⚠️ shop-service <b>不採用</b>這個做法。理由在下面。
 */
public ProductView findByIdWithLock(String id) {
    Cache cache = caches.getCache("products");
    var hit = cache.get(id);
    if (hit != null) { return (ProductView) hit.get(); }

    String lockKey = "lock:products:" + id;
    boolean acquired = Boolean.TRUE.equals(
            redis.opsForValue().setIfAbsent(lockKey, "1", Duration.ofSeconds(5)));

    if (acquired) {
        try {
            ProductView view = loadFromDb(id);
            cache.put(id, view);
            return view;
        } finally {
            redis.delete(lockKey);
        }
    }
    // ⚠️ 沒拿到鎖 → 等一下再查快取
    for (int i = 0; i < 20; i++) {
        sleep(50);
        var retry = cache.get(id);
        if (retry != null) { return (ProductView) retry.get(); }
    }
    // 🔴 等了 1 秒還沒有 → 只能自己查（否則請求就掛了）
    return loadFromDb(id);
}
```

🔴 **五個問題**：

| # | 問題 |
|---|---|
| 1 | **`sleep` 迴圈** —— 佔用 Tomcat 執行緒 1 秒（而那是有限資源） |
| 2 | **拿到鎖的實例掛掉** → 其他實例等 5 秒（鎖的 TTL） |
| 3 | **最後的 fallback 讓保護失效** —— 極端情況下還是 N 次查詢 |
| 4 | **多一個 Redis 往返**（`SET NX`）在**每一次 miss** 上 |
| 5 | 🔴🔴 **它引入了「分散式鎖」這個東西**，而正確的分散式鎖很難（Redlock 的爭議） |

✅ **shop-service 的決定：`sync = true` + 接受「每個實例一次」。**

**量化這個決定**：

| 保護 | 促銷第一秒的資料庫查詢數 |
|---|---|
| 無 | 🔴 **8,000**（事故 3） |
| `sync = true`（3 個實例） | ✅ **3** |
| 分散式鎖 | ✅ 1 |

**從 8,000 降到 3 解決了問題。從 3 降到 1 沒有價值。**

> 📌📌 **這是本章最重要的一個判斷模式**：
> **先量化「不做」的代價，再量化每一級改善的收益。**
> 大部分快取的複雜度來自「追求最後那 1%」。

#### 🔴 `sync = true` 的兩個限制在「第一次呼叫」才炸 ★★

**寫這一段時的假設是「它在啟動時失敗」** ——
因為那是 Spring 對這類組態錯誤的常見做法（02 章 2.5.1 的
`proxy-target-class=false` 就是啟動失敗）。

⚠️⚠️ **實測推翻了這個假設。**

```java
@Cacheable(cacheNames = "a", sync = true, unless = "#result == null")
public String x(String id) { return id; }
```

```
啟動：✅ 成功
第一次呼叫 x("k")：
java.lang.IllegalStateException: A sync=true operation does not support
  the unless attribute on 'Builder[public String SvcUnless.x(String)]
  caches=[a] | key='' | ... | unless='#result == null' | sync='true''
```

```java
@Cacheable(cacheNames = {"a", "b"}, sync = true)
public String x(String id) { return id; }
```

```
啟動：✅ 成功
第一次呼叫：
java.lang.IllegalStateException: A sync=true operation is restricted to
  a single cache on 'Builder[...] caches=[a, b] | ... | sync='true''
```

🔴🔴 **「啟動成功、第一次呼叫時 500」是最糟的失敗方式**：

| | 啟動失敗 | **第一次呼叫失敗** |
|---|---|---|
| 什麼時候發現 | ✅ CI / 部署時 | 🔴 **上線後，第一個打到這個端點的使用者** |
| 誰受影響 | 沒有人（部署被擋下） | 🔴 **真實的使用者，而且是 500** |
| 如果那個端點很冷門 | — | 🔴🔴 **可能好幾天後才被發現** |

⚠️ **而 `CacheOperation` 是 lazy 建立的**（第一次呼叫該方法時才解析註解），
所以這個行為是可以理解的 —— **但它讓一個組態錯誤變成執行期錯誤。**

✅ **shop-service 的處置：一條啟動時就會跑的守門測試**：

```java
/**
 * ★★ 把「sync = true 的組態錯誤」從「第一次呼叫」提前到「CI」。
 *
 * <p>⚠️ 它不是 ArchUnit —— 它讀註解的<b>屬性值</b>，
 * 而那正好是 ArchUnit 做得到的（04 章 4.12.3 的 readOnly 判斷是同一個手法）。
 */
@Test
void sync為true的Cacheable不可有unless或多個cacheNames() {
    var violations = new java.util.ArrayList<String>();

    MAIN.stream()
        .flatMap(c -> c.getMethods().stream())
        .forEach(m -> m.tryGetAnnotationOfType(Cacheable.class).ifPresent(ann -> {
            if (!ann.sync()) { return; }
            if (!ann.unless().isBlank()) {
                violations.add(m.getFullName() + "：sync = true 不支援 unless");
            }
            int nameCount = ann.cacheNames().length > 0
                    ? ann.cacheNames().length : ann.value().length;
            if (nameCount > 1) {
                violations.add(m.getFullName()
                        + "：sync = true 只能有一個 cacheNames（目前 " + nameCount + " 個）");
            }
        }));

    assertThat(violations)
            .as("""
                sync = true 的兩個限制在【第一次呼叫】才拋 IllegalStateException（5.7.1）——
                於是它會變成「上線後第一個使用者看到 500」。
                這條測試把它提前到 CI。
                """)
            .isEmpty();
}
```

> 📌📌 **這一小段是一個關於「假設」的示範**：
>
> 「Spring 會在啟動時檢查組態」是一個**合理但錯誤**的假設，
> 而它錯的方向**恰好是最危險的那一邊**。
>
> ⚠️ **如果沒有跑這個實驗，課程會寫「它是好的失敗方式」** ——
> 而讀者會因此**不寫**那條守門測試。

**那「不要快取 null」怎麼辦？** 見 5.7.3。

### 5.7.2 雪崩：三個成因與解法

| 成因 | 具體 | 解法 |
|---|---|---|
| ① **`allEntries = true`** | 事故 3 | ✅ 不要用（5.6.2 方式 A / C） |
| ② **同時寫入 → 同時過期** | 系統啟動時預熱 10 萬個項目，TTL 都是 5 分鐘 → 5 分鐘後全部同時過期 | ✅ **TTL 加隨機抖動** |
| ③ **Redis 重啟 / failover** | 所有項目消失 | ⚠️ 見下 |

#### 解法 ②：TTL 抖動

```java
/**
 * ★★ 每個項目的 TTL 加一個隨機抖動，避免「同時寫入 → 同時過期」。
 *
 * <p>⚠️ Caffeine 的 {@code expireAfterWrite(Duration)} 是<b>固定</b>的，
 * 要抖動必須用 {@code expireAfter(Expiry)}。
 */
@Bean
CacheManager cacheManager() {
    var manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
            .maximumSize(50_000)
            .recordStats()
            .expireAfter(new Expiry<Object, Object>() {
                // ★ 30 秒 ± 20%（24～36 秒）
                private static final long BASE_NANOS = Duration.ofSeconds(30).toNanos();
                private static final long JITTER_NANOS = BASE_NANOS / 5;

                private long randomTtl() {
                    // ⚠️ ThreadLocalRandom 而不是 Random —— 這個方法在熱路徑上
                    return BASE_NANOS
                            + java.util.concurrent.ThreadLocalRandom.current()
                                    .nextLong(-JITTER_NANOS, JITTER_NANOS);
                }

                @Override public long expireAfterCreate(Object k, Object v, long now) {
                    return randomTtl();
                }
                @Override public long expireAfterUpdate(Object k, Object v, long now,
                                                        long currentDuration) {
                    return randomTtl();
                }
                /** ★ 讀取不延長 TTL —— 這是刻意的（見下） */
                @Override public long expireAfterRead(Object k, Object v, long now,
                                                      long currentDuration) {
                    return currentDuration;
                }
            }));
    return manager;
}
```

⚠️ **`expireAfterRead` 回傳 `currentDuration`（不延長）是一個重要的決定**：

| | `expireAfterWrite`（不延長） | `expireAfterAccess`（每次讀都延長） |
|---|---|---|
| 熱門項目 | ⚠️ 每 30 秒重新載入一次 | ✅ 永遠不過期 |
| **一致性** | ✅ **任何項目最多舊 30 秒** | 🔴🔴 **熱門項目可能永遠是舊的** |

🔴 **`expireAfterAccess` 對「會變的資料」是錯的選擇**，
因為**最熱門的資料就是最需要正確的資料**。

✅ **`expireAfterAccess` 只適合「絕不改變」的資料**（`orderOwners`）。

#### 解法 ③：Redis 掛掉時的行為

```yaml
spring:
  cache:
    type: redis
  data:
    redis:
      # ⚠️ 沒有這個設定的話，Redis 慢 → 所有請求跟著慢
      timeout: 200ms
      connect-timeout: 200ms
```

```java
/**
 * ★★ Redis 掛掉時，快取失敗<b>不可以</b>讓請求失敗。
 *
 * <p>04 章 4.4.1 的判準：Redis 掛掉是「我們的問題」，
 * ⚠️ 而<b>它不該變成使用者的 500</b> ——
 * 因為「不用快取直接查資料庫」是一個完全可行的降級。
 */
@Bean
CacheErrorHandler cacheErrorHandler(MeterRegistry meters) {
    return new CacheErrorHandler() {
        @Override
        public void handleCacheGetError(RuntimeException e, Cache cache, Object key) {
            // ★ 讀失敗 → 當成 miss，去查資料庫
            meters.counter("cache.errors", "op", "get", "cache", cache.getName()).increment();
            log.warn("快取讀取失敗，降級為直接查詢 cache={} key={}", cache.getName(), key);
        }
        @Override
        public void handleCachePutError(RuntimeException e, Cache cache, Object key, Object v) {
            meters.counter("cache.errors", "op", "put", "cache", cache.getName()).increment();
        }
        @Override
        public void handleCacheEvictError(RuntimeException e, Cache cache, Object key) {
            // ⚠️ 清除失敗比讀寫失敗嚴重 —— 它代表資料可能不一致（5.6.6）
            meters.counter("cache.errors", "op", "evict", "cache", cache.getName()).increment();
            log.error("清快取失敗 cache={} key={}", cache.getName(), key, e);
        }
        @Override
        public void handleCacheClearError(RuntimeException e, Cache cache) {
            meters.counter("cache.errors", "op", "clear", "cache", cache.getName()).increment();
        }
    };
}
```

⚠️⚠️ **`CacheErrorHandler` 的預設實作是 `SimpleCacheErrorHandler`，
而它把例外原封不動拋出去** —— 於是 Redis 掛掉 = **所有讀取都 500**。

**這是「加了快取讓可用性變差」的最常見原因。**

⚠️ **而「降級為直接查詢」有一個代價**：

```
Redis 掛掉 → 全部 miss → 8,000 QPS 全打資料庫 → 資料庫也掛掉
```

🔴 **快取的失敗變成資料庫的失敗。** 而那需要**限流**（04-controller 04 章）
或**熔斷**（06 章）—— 而那是**下一章的主題**。

👉 **本章的處置**：`CacheErrorHandler` 降級 + 一條告警，
**並在 5.16 明確記下「快取掛掉時資料庫會被打」這個未關閉的風險。**

### 5.7.3 穿透：實測發現它已經被處理了

**「穿透」= 查一個不存在的 id，快取永遠 miss，每次都打 DB。**

```
攻擊者用隨機 id 打 GET /api/products/{id}
→ 每一個都 miss → 每一個都查 DB → 資料庫被打
```

**經典解法是「快取 null」。而實測顯示 Spring 已經這樣做了**：

```
[實驗8] 回 null 三次 → 實際呼叫 = 1（1 = null 被快取；3 = 沒有）
[實驗8] 快取項目存在嗎 = true，值 = null
```

✅ **`@Cacheable` 預設會快取 `null`**，
而 `Cache.ValueWrapper` 不是 `null`（它包著一個 `null`）——
於是 `CacheInterceptor` 分得出「沒有這個項目」與「這個項目的值是 null」。

⚠️⚠️ **而有一個設定會把這個保護關掉**：

```java
// 🔴 很多人「順手」加的
@Cacheable(cacheNames = "products", unless = "#result == null")
```

**它的動機通常是「不要浪費記憶體存 null」，而它的後果是打開穿透。**

**兩者的取捨**：

| | 快取 `null`（預設） | `unless = "#result == null"` |
|---|---|---|
| 穿透保護 | ✅ **有** | 🔴 **沒有** |
| 記憶體 | ⚠️ 不存在的 id 也佔一個項目 | ✅ 省 |
| ⚠️ **「剛剛建立的資源」** | 🔴 **要等 TTL 才看得到** | ✅ 立刻看得到 |

🔴 **最後一列是快取 `null` 的真實代價**：

```
① 客戶端建立訂單前先查（或某個爬蟲查了）→ 404 → null 進快取
② 訂單建立
③ 客戶端查詢 → 🔴 命中快取的 null → 404
④ 30 秒後才好
```

✅ **shop-service 的處置：分開處理**：

| 快取 | 快取 null 嗎 | 理由 |
|---|---|---|
| `products` | ✅ **快取**（TTL 較短，10 秒） | 商品 id 是外部可猜的 → 需要穿透保護 |
| `orderOwners` | ✅ 快取 | 同上 |
| `orderContents` | 🔴 **不快取 null** | ⚠️ 見下 |

⚠️ **`orderContents` 不快取 null 的理由**：

```
它的 key 是 orderId，而 orderId 是【我們產生的】（02 章 2.11.4 的序號）
→ 攻擊者猜不到 → 穿透的風險低
→ 而「剛建立的訂單查不到」是一個真實且高頻的問題
```

**而「不快取 null」與 `sync = true` 衝突**（5.7.1 限制 2）：

```java
// 🔴 編譯得過，啟動時炸
@Cacheable(cacheNames = "orderContents", sync = true, unless = "#result == null")
```

✅ **解法：用「不存在時拋例外」而不是「回 null」**：

```java
/**
 * ★★ 回 {@code Optional} 或拋例外，而不是回 {@code null}。
 *
 * <p>⚠️ 這讓「不快取 null」這個需求消失了：
 * <ul>
 *   <li>拋例外 → {@code @Cacheable} <b>不會</b>快取（例外不是回傳值）。</li>
 *   <li>回 {@code Optional.empty()} → ⚠️ 那<b>是</b>一個值，會被快取。</li>
 * </ul>
 *
 * <p>👉 <b>所以「拋例外」才是「不快取不存在」的正確做法。</b>
 */
@Cacheable(cacheNames = "orderContents", sync = true)
public OrderDetailView detailOf(String orderId, boolean privileged) {
    return orderRepository.findById(orderId)
            .map(o -> toView(o, privileged))
            .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));
}
```

⚠️ **而「拋例外不被快取」代表穿透保護也沒了** ——
於是 `orderContents` 依賴「orderId 猜不到」這個前提。

⚠️ **而「orderId 猜不到」這個前提值得認真查證，因為 shop-service 有兩個識別碼**：

| 識別碼 | 格式 | 可以被猜嗎 |
|---|---|---|
| **`Order.id`** | **ULID**（`UlidIdGenerator`，00 章 0.12） | ✅ **不行** —— 80 bits 的隨機性 |
| `Order.orderNumber` | `ORD-yyyyMMdd-NNNN`（00 章 0.12、02 章 2.11.4 的遞增序號） | 🔴🔴 **可以** —— `ORD-20260827-0001` 開始數 |

✅ **前提成立 —— 但它成立的理由是「key 用的是 `orderId` 而不是 `orderNumber`」，
而那是一個很容易在重構時被改掉的細節。**

**把它寫成一條測試**：

```java
/**
 * ★★ orderContents 的 key 必須用 orderId（ULID），不可以用 orderNumber。
 *
 * <p>⚠️ 它守的是 5.7.3 的一個<b>隱含前提</b>：
 * {@code orderContents} 刻意不做穿透保護（不快取 null），
 * 而那個決定只在「key 猜不到」時才安全。
 *
 * <p>🔴 {@code orderNumber} 是遞增序號（02 章 2.11.4）——
 * 換成它就等於把穿透的大門打開。
 */
@Test
void orderContents的key不可以用orderNumber() {
    var violations = MAIN.stream()
            .flatMap(c -> c.getMethods().stream())
            .filter(m -> m.tryGetAnnotationOfType(Cacheable.class)
                    .map(a -> names(a).contains("orderContents")).orElse(false))
            .filter(m -> m.getRawParameterTypes().stream()
                    .noneMatch(t -> t.getName().equals(String.class.getName()))
                    || m.getName().toLowerCase().contains("number"))
            .map(JavaMethod::getFullName)
            .toList();

    assertThat(violations)
            .as("orderContents 的 key 必須是 orderId（ULID）—— 見 5.7.3")
            .isEmpty();
}
```

⚠️⚠️ **這條測試寫得很弱**（它只看方法名裡有沒有 `number`）——
而那是誠實的：**ArchUnit 看不到 SpEL 字串裡用了哪個參數。**

👉 **更可靠的做法是把它變成一個型別**：

```java
/** ★ ULID 的訂單技術主鍵。用型別讓「不要傳 orderNumber 進來」變成編譯期的事。 */
public record OrderId(String value) {
    public OrderId {
        if (value == null || value.length() != 26) {
            throw new IllegalArgumentException("OrderId 必須是 26 字元的 ULID：" + value);
        }
    }
}
```

**於是 `detailOf(OrderId orderId, boolean privileged)` 根本收不到 `orderNumber`。**

⚠️ **而引入 `OrderId` 是一個跨全站的改動**（00～04 章共 ~200 處用 `String orderId`），
所以本章**不做** —— 👉 記進 5.16 的缺口清單，並在 5.13 ③ 說明理由。

### 5.7.4 三個問題的解法對照表

| | 擊穿 | 雪崩 | 穿透 |
|---|---|---|---|
| **主要解法** | `sync = true` | TTL 抖動 | 快取 `null` |
| 實測效果 | **50 → 1** 次載入 | — | **3 → 1** 次查詢 |
| shop-service 用嗎 | ✅ | ✅ | ⚠️ **分快取決定** |
| 次要解法 | 分散式鎖 | 不用 `allEntries` | Bloom filter |
| 為什麼不用次要解法 | 5.7.1（8,000→3 已解決問題） | ✅ **有用，也採用** | 見下 |

⚠️ **Bloom filter 值得一句話**：

> 它的用途是「用 1% 的誤判率，換 O(1) 的『這個 id 一定不存在』判斷」。
> **而它只在「不存在的 id 極多且快取 null 塞不下」時才需要** ——
> 例如「用手機號碼查會員」（號碼空間 10^10，實際會員 10^6）。
>
> **shop-service 的商品 id 空間是 10^5，全部快取 null 只要 5 MB。**
> 👉 **不需要 Bloom filter。**

> 📌 **這一節（5.7）的方法論**：
> **每一個「經典解法」都先問「我們的規模需要它嗎」。**
> 而回答那個問題需要**兩個數字**：問題的規模，與解法的成本。

---

## 5.8 序列化：三個序列化器的實測 ★★

⚠️ **這一節只在用 Redis（或任何跨行程的快取）時有意義。**
本地快取存的是**物件參考**，沒有序列化。

### 5.8.1 三個序列化器，開箱即用時全部失敗

**被測的型別**（一個很普通的 View）：

```java
record ProductView(String id, String name, Money price, Instant updatedAt,
                   OrderStatus status, List<String> tags) {}
```

**實測**（Spring Boot 3.2.5 / Spring Data Redis 3.2）：

| 序列化器 | 結果 |
|---|---|
| `JdkSerializationRedisSerializer` | 🔴 `SerializationException: DefaultSerializer requires a Serializable payload but received an object of type [ProductView]` |
| `GenericJackson2JsonRedisSerializer`（無參數） | 🔴 `Java 8 date/time type java.time.Instant not supported by default: add Module "com.fasterxml.jackson.datatype:jackson-datatype-jsr310"` |
| `Jackson2JsonRedisSerializer<>(ProductView.class)` | 🔴 **同上** |

**三個全部失敗，而失敗的原因各不相同。**

#### 🔴 為什麼 Jackson 不認得 `Instant`

**這是最反直覺的一個**，因為 Spring Boot **有**註冊 `JavaTimeModule` ——
`spring-boot-starter-web` 的自動組態會把它加到 `ObjectMapper` 上。

⚠️ **而那個 `ObjectMapper` 不是這裡用的那一個。**

```java
new GenericJackson2JsonRedisSerializer()      // ★ 它在內部 new 一個全新的 ObjectMapper
new Jackson2JsonRedisSerializer<>(Foo.class)  // ★ 同樣
```

**「Spring Boot 設定好的 `ObjectMapper`」與「序列化器內部 new 的」是兩個物件。**

✅ **修法：把容器裡的 `ObjectMapper` 傳進去**：

```java
@Bean
RedisCacheConfiguration redisCacheConfiguration(ObjectMapper springBootObjectMapper) {
    // ⚠️ 不要直接用它 —— 見 5.8.4
    ...
}
```

> 📌 **一般規則**：
> **任何「內部 `new` 了一個 `ObjectMapper`」的元件，都不會有你設定的模組。**
> 這在 Redis 序列化器、Kafka 序列化器、`RestTemplate` 的 converter 上都會遇到。

### 5.8.2 修好之後：三者的實測大小

**用同一個設定好的 `ObjectMapper`**（含 `JavaTimeModule`）：

```
[size] Jackson2Json(指定型別)      =  137 bytes  (1.00x)
[size] GenericJackson2Json(帶型別) =  401 bytes  (2.93x)
[size] JdkSerialization            =  329 bytes  (2.40x)
```

**內容**：

```jsonc
// Jackson2JsonRedisSerializer（指定型別）—— 137 bytes
{"id":"P-1","name":"耳機","price":{"amount":1500.00,"currency":"TWD"},
 "updatedAt":"2026-08-27T08:00:00Z","status":"PAID","tags":["3C"]}

// GenericJackson2JsonRedisSerializer（帶型別）—— 401 bytes
{"@class":"...ProductView","id":"P-1","name":"耳機",
 "price":{"@class":"example.shop.common.money.Money",
          "amount":["java.math.BigDecimal",1500.00],
          "currency":["java.util.Currency","TWD"]},
 "updatedAt":["java.time.Instant","2026-08-27T08:00:00Z"],
 "status":["example.shop.order.domain.OrderStatus","PAID"],
 "tags":["java.util.ImmutableCollections$List12",["3C"]]}
```

⚠️ **`GenericJackson2Json` 大了 2.93 倍，而那個 2.93 倍換到的是「能還原成正確的型別」。**

**三者的完整對照**：

| | `Jackson2Json`（指定型別） | `GenericJackson2Json` | `JdkSerialization` |
|---|---|---|---|
| 大小 | ✅ **137** | ⚠️ 401（2.93×） | 329（2.40×） |
| 可讀（`redis-cli GET`） | ✅ | ✅ | 🔴 **二進位** |
| 需要 `Serializable` | 🔴 不需要 | 不需要 | ✅ **需要** |
| 一個 cache 存多種型別 | 🔴 **不行** | ✅ 可以 | ✅ 可以 |
| **改欄位名會怎樣** | ⚠️ 舊資料反序列化失敗 | ⚠️ 同左 | 🔴 同左 |
| **改類別名／搬套件** | ✅ **沒事** | 🔴🔴 **全部失效**（`@class` 寫死 FQCN） | 🔴🔴 同左 |
| 跨語言 | ✅ | ⚠️ 有 `@class` 雜訊 | 🔴 **不行** |

🔴 **「改類別名／搬套件」那一列是 `GenericJackson2Json` 最大的問題**：

```
把 ProductView 從 order.web.dto 搬到 order.application.view
→ 舊的快取項目 @class 指向舊路徑
→ 反序列化：ClassNotFoundException
→ ⚠️ 而 CacheErrorHandler 會把它當成 miss（5.7.2）→ ✅ 降級成查 DB
→ 但如果沒有 CacheErrorHandler → 🔴 全部 500
```

### 5.8.3 🔴 `Money` 的序列化是壞的

**實測**：

```
[money] 序列化 = {"amount":1500.00,"currency":"TWD","zero":false,"negative":false,"positive":true}
[money] 往返失敗 = UnrecognizedPropertyException: Unrecognized field "zero"
                   (class Money), not marked as ignorable (2 known properties: "amount", "currency")
```

🔴🔴 **`Money` 序列化出 5 個欄位，反序列化只認得 2 個 —— 往返直接失敗。**

**原因**：00 章 0.9.1 的 `Money` 有三個 `isXxx()` 方法：

```java
public boolean isZero()      { return amount.signum() == 0; }
public boolean isPositive()  { return amount.signum() > 0; }
public boolean isNegative()  { return amount.signum() < 0; }
```

**Jackson 把 `isXxx()` 當成 `boolean` 的 getter** →
於是 `zero` / `positive` / `negative` 變成 JSON 欄位。
而 record 的建構子只有 `(amount, currency)` → 反序列化炸。

⚠️ **為什麼 03 章沒有發現這件事**：

| 03 章的路徑 | 為什麼沒事 |
|---|---|
| API 回應 | `Money` **不會**被直接序列化 —— 03 章 3.8.4 規定「金額是 `String`」 |
| ⚠️ 而 04-controller 6.5.7 有一個 `MoneySerializer` | 它註冊在 **web 層的 `ObjectMapper`** 上 |
| **快取的 `ObjectMapper`** | 🔴 **是另一個** —— 5.8.1 的同一個問題 |

🔴 **`Money` 在 API 上是安全的，在快取上是壞的。**

**三個修法**：

| 修法 | 做法 | 取捨 |
|---|---|---|
| ① `@JsonIgnore` 標在三個方法上 | 改 `Money` | 🔴 **domain 依賴 Jackson**（00 章 0.11.2 的分層規則） |
| ② 快取的 `ObjectMapper` 關掉 `IS_GETTER` 偵測 | 只改組態 | ✅ 實測可行 |
| ③ 快取的 `ObjectMapper` 加 `FAIL_ON_UNKNOWN_PROPERTIES = false` | 只改組態 | ⚠️ 見下 |
| ④ 快取的 View 不含 `Money`（用 `String`） | 改 View | ✅ 與 03 章 3.8.4 一致 |

**實測 ② 與 ③ 都能讓往返成功**：

```
[money] A: 關 IS_GETTER 序列化 = {"amount":1500.00,"currency":"TWD"}
[money] A: 往返 = Money[amount=1500.00, currency=TWD]
[money] B: 忽略未知欄位 往返 = Money[amount=1500.00, currency=TWD]
```

⚠️ **而 ③ 有一個代價**：它讓**所有**的欄位不符都被忽略 ——
於是「View 少了一個欄位」變成靜默的 `null`
（03 章 3.4.2「漏映射的三種形狀」的第四種形狀）。

✅ **shop-service 選 ②**：

```java
.setVisibility(PropertyAccessor.IS_GETTER, JsonAutoDetect.Visibility.NONE)
```

**它的效果是「只序列化 record 的元件，不序列化衍生的述詞」** ——
而那正好是我們要的。

⚠️⚠️ **但它有一個範圍問題**：它關掉了**所有**型別的 `is-getter` 偵測。

**檢查有沒有型別真的需要 `is-getter`**：

| 型別 | 有 `isXxx()` 嗎 | 那個欄位需要進快取嗎 |
|---|---|---|
| `Money` | ✅ 三個 | 🔴 不需要（衍生的） |
| `OrderDetailView` | ⚠️ 可能有 | ⚠️ **要檢查** |
| `Actor` | `isCustomer()` / `isInternal()` / `isPrivileged()` | 🔴 不需要（衍生的） |

✅ **一條掃描測試**（5.11.5）確認「沒有任何快取的型別依賴 `is-getter`」。

> 📌 **這一節的一般規則**：
> **「衍生的述詞」（`isZero()`、`isPrivileged()`）不該進序列化。**
> 它們可以從其他欄位算出來，放進 JSON 只會：
> ① 佔空間、② 讓往返失敗、③ **在兩邊算法不同時產生矛盾的資料**。

### 5.8.4 🔴 `GenericJackson2Json` + 自訂 `ObjectMapper` 會失去型別資訊

**第一次嘗試（看起來很合理）**：

```java
var om = new ObjectMapper()
        .registerModule(new JavaTimeModule())
        .activateDefaultTyping(ptv, DefaultTyping.NON_FINAL, JsonTypeInfo.As.PROPERTY);
var serializer = new GenericJackson2JsonRedisSerializer(om);
```

**實測**：

```
[deep] 手動 typing 內容={"id":"P-1","name":"耳機","price":{"amount":["java.math.BigDecimal",1500.00],...}}
                        ↑ 🔴 根物件【沒有】@class
[deep] 手動 typing 失敗=InvalidTypeIdException: Could not resolve subtype of
                        [simple type, class java.lang.Object]: missing type id property '@class'
```

🔴 **根物件沒有型別 id，反序列化直接失敗。**

**原因**：`DefaultTyping.NON_FINAL` 的意思是
「**非 final** 的型別才加型別資訊」——
⚠️⚠️ **而 record 是 `final` 的。**

✅ **正確的是 `DefaultTyping.EVERYTHING`**：

```
[final] EVERYTHING 內容={"@class":"...ProductView","id":"P-1",...}
[final] EVERYTHING 還原型別=...ProductView
[final] EVERYTHING 還原=ProductView[id=P-1, name=耳機, price=Money[...], ...]
```

⚠️ **而「無參數的 `GenericJackson2JsonRedisSerializer()`」本來就用對了**
（實測：`{"@class":"...SimpleView","id":"P-1","name":"耳機"}` → 正確還原）。

> 📌📌 **這是一個「自己設定反而弄壞了預設行為」的典型**：
>
> ```
> 無參數建構子：✅ 型別資訊正確，🔴 沒有 JavaTimeModule
> 傳自己的 mapper：✅ 有 JavaTimeModule，🔴 型別資訊壞掉
> ```
>
> **兩個都不對，而正確的做法是「傳自己的 mapper，並且自己補上型別設定」** ——
> 那需要知道原本的設定是什麼。

### 5.8.5 shop-service 的最終組態

```java
package example.shop.common.cache;

import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.jsontype.BasicPolymorphicTypeValidator;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;

/**
 * ★★ 快取專用的 ObjectMapper。
 *
 * <p>⚠️ 它<b>刻意不重用</b> Spring Boot 設定好的那一個，理由有兩個：
 * <ol>
 *   <li>那一個是<b>對外契約</b>（API 的 JSON 形狀），
 *       而快取是<b>內部格式</b> —— 兩者不該綁在一起。
 *       改 API 的 JSON 設定不該讓所有快取失效。</li>
 *   <li>快取需要 {@code activateDefaultTyping}，而 API <b>絕對不可以</b>有它
 *       （那是一個已知的反序列化漏洞面）。</li>
 * </ol>
 *
 * <p>⚠️⚠️ 而「不重用」的代價是：<b>兩個 ObjectMapper 的設定會漂移</b>。
 * 5.11.5 有一條測試在比對兩者的關鍵設定。
 */
public final class CacheObjectMappers {

    private CacheObjectMappers() {}

    public static ObjectMapper forCache() {
        // ★ 型別白名單 —— activateDefaultTyping 沒有它是一個反序列化漏洞
        var typeValidator = BasicPolymorphicTypeValidator.builder()
                .allowIfSubType("example.shop.")
                .allowIfSubType("java.util.")
                .allowIfSubType("java.time.")
                .allowIfSubType("java.math.")
                .build();

        return new ObjectMapper()
                .registerModule(new JavaTimeModule())                        // 5.8.1
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)      // 時間用 ISO-8601
                // ★ 5.8.3：不要把 isZero() 這種衍生述詞序列化出來
                .setVisibility(PropertyAccessor.IS_GETTER, JsonAutoDetect.Visibility.NONE)
                // ★★ 5.8.4：EVERYTHING 而不是 NON_FINAL —— record 是 final 的
                .activateDefaultTyping(typeValidator,
                                       ObjectMapper.DefaultTyping.EVERYTHING,
                                       JsonTypeInfo.As.PROPERTY);
    }

    public static GenericJackson2JsonRedisSerializer serializer() {
        return new GenericJackson2JsonRedisSerializer(forCache());
    }
}
```

⚠️⚠️ **`BasicPolymorphicTypeValidator` 不是裝飾品。**

`activateDefaultTyping` 讓 Jackson **依 JSON 裡的 `@class` 決定要實例化哪個類別** ——
而如果攻擊者能寫入 Redis，他就能指定任意類別。
**那是一整類的遠端程式碼執行漏洞**（Jackson 的 CVE 大部分是這一類）。

| 沒有 validator | 有 validator |
|---|---|
| 🔴 任何 classpath 上的類別都能被實例化 | ✅ 只有白名單的四個前綴 |

⚠️ **而「攻擊者能寫入 Redis」聽起來很遠**，直到：
Redis 沒有密碼、Redis 綁在 `0.0.0.0`、
或者**同一個 Redis 被另一個服務共用而那個服務有漏洞**。

> 📌 **一般規則**：
> **`activateDefaultTyping` 一定要配 `PolymorphicTypeValidator`。**
> Jackson 2.10 之後**不加 validator 的版本已經被標為 deprecated**，
> 而它還能編譯 —— 所以要靠 code review 或一條測試守它（5.11.5）。

#### 這個組態的三個實測

```java
@Test
void 完整往返() {
    var s = CacheObjectMappers.serializer();
    var view = new ProductView("P-1", "無線降噪耳機 Pro", Money.twd("1500"),
            Instant.parse("2026-08-27T08:00:00Z"), OrderStatus.PAID, List.of("3C","熱銷"));
    byte[] b = s.serialize(view);
    assertThat(s.deserialize(b)).isEqualTo(view);       // ★ record 的 equals
}
```

```
[cfg] 長度=424
[cfg] 內容={"@class":"...ProductView","id":"P-1","name":"無線降噪耳機 Pro",
       "price":{"@class":"example.shop.common.money.Money",
                "amount":["java.math.BigDecimal",1500.00],
                "currency":["java.util.Currency","TWD"]},
       "updatedAt":["java.time.Instant","2026-08-27T08:00:00Z"],
       "status":["example.shop.order.domain.OrderStatus","PAID"],
       "tags":["java.util.ImmutableCollections$List12",["3C","熱銷"]]}
[cfg] 還原=ProductView[id=P-1, name=無線降噪耳機 Pro, price=Money[amount=1500.00, currency=TWD],
       updatedAt=2026-08-27T08:00:00Z, status=PAID, tags=[3C, 熱銷]]
```

✅ **`Money` 只有兩個欄位了**（`isZero()` 等三個衍生述詞沒有出現）。

```java
@Test
void Actor也能往返_衍生述詞不進JSON() {
    byte[] b = CacheObjectMappers.serializer().serialize(
            new Actor(Actor.ActorType.SUPPORT, "sup_1", "客服小美"));
    assertThat(new String(b)).doesNotContain("customer").doesNotContain("privileged");
}
```

```
[cfg] Actor={"@class":"example.shop.order.domain.Actor",
             "type":["example.shop.order.domain.Actor$ActorType","SUPPORT"],
             "id":"sup_1","displayName":"客服小美"}
```

✅ **`isCustomer` / `isInternal` / `isPrivileged` 三個都沒有進 JSON。**

```java
@Test
void 型別白名單擋住不在清單裡的類別() {
    var om = CacheObjectMappers.forCache();
    String evil = """{"@class":"java.lang.ProcessBuilder","command":[]}""";
    assertThatThrownBy(() -> om.readValue(evil, Object.class))
            .rootCause()
            .isInstanceOf(com.fasterxml.jackson.databind.exc.InvalidTypeIdException.class);
}
```

```
[cfg] ✅ 白名單擋住了：InvalidTypeIdException: Could not resolve type id
      'java.lang.ProcessBuilder' as a subtype of `java.lang.Object`:
      Configured `PolymorphicTypeValidator` ... denied resolution
```

> 📌 **第三個測試值得留在專案裡**，因為它是**唯一**會在
> 「有人拿掉 validator」時紅燈的東西 ——
> 而拿掉它是一個**編譯得過、測試會綠、直到被攻擊才發現**的改動。

### 5.8.6 一個誠實的限制：本章沒有真的 Redis

⚠️ **這一節（5.8）的所有實測都是「序列化器本身」的往返測試**：

```java
byte[] bytes = serializer.serialize(view);
Object back = serializer.deserialize(bytes);
```

**它們沒有經過真的 Redis。** 而以下三件事**沒有被驗證**：

| 沒驗證的 | 為什麼可能不同 |
|---|---|
| `RedisCacheManager` 的 key 前綴與 `SimpleKey` 的互動 | key 的組成有一層 `CacheKeyPrefix` |
| `RedisCache#get(key, Callable)` 的實際併發行為 | 5.7.1 的分析來自讀原始碼，不是實測 |
| TTL 的實際行為（Redis 的 `EXPIRE`） | — |

🔴 **請以你的環境實測為準。**
5.11.3 會給一組 Testcontainers 的測試 —— **而撰稿的機器上沒有 Docker，所以那組沒有跑過。**

---

## 5.9 快取的可觀測性 ★

### 5.9.1 四個必要的指標

**「加了快取」之後如果不量測，你不知道它有沒有用，也不知道它什麼時候壞了。**

| 指標 | 回答什麼問題 | 沒有它會怎樣 |
|---|---|---|
| **命中率** | 快取有用嗎 | 🔴 你不知道 TTL 該調長還是調短 |
| **項目數 / 記憶體** | 快取會不會爆 | 🔴 OOM |
| **淘汰數**（eviction） | 容量夠不夠 | ⚠️ 命中率低的原因可能是「一直被擠掉」 |
| **錯誤數** | Redis 還活著嗎 | 🔴 5.7.2 的降級是靜默的 |

**Caffeine 的接法**（三行）：

```java
@Bean
CacheManager cacheManager(MeterRegistry meters) {
    var manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
            .maximumSize(50_000)
            .expireAfterWrite(Duration.ofSeconds(30))
            .recordStats());                     // ★★ 沒有這一行，統計全部是 0
    // ⚠️ Spring Boot 的 CacheMetricsRegistrar 需要 cache 已經被建立
    //    而 CaffeineCacheManager 是 lazy 的 → 要先宣告名稱
    manager.setCacheNames(List.of("products", "orderOwners", "orderContents"));
    return manager;
}
```

⚠️⚠️ **`recordStats()` 是最容易漏的一行**，而漏了它的症狀是：

```
cache_gets_total{result="hit"}  = 0
cache_gets_total{result="miss"} = 0
```

**「全部是 0」看起來像「沒有人在用這個快取」，而實際上是「沒有在記錄」。**

✅ **一條測試**：

```java
@Test
void 每個快取都有開啟統計() {
    for (String name : cacheManager.getCacheNames()) {
        var cache = (CaffeineCache) cacheManager.getCache(name);
        assertThat(cache.getNativeCache().stats().requestCount())
                .as("%s 沒有 recordStats() —— 所有指標會是 0（5.9.1）", name)
                .isNotNegative();
        // ⚠️ 上面那個斷言其實抓不到（沒有 recordStats 時 stats() 回 disabled 的實例，
        //    而 requestCount() 是 0，不是負數）
    }
}
```

🔴 **上面那條測試沒有用**，而那是一個誠實的示範。**正確的做法**：

```java
@Test
void 每個快取都有開啟統計() {
    for (String name : cacheManager.getCacheNames()) {
        var native_ = ((CaffeineCache) cacheManager.getCache(name)).getNativeCache();
        // ★ 放一個值、讀兩次，然後檢查統計有沒有動
        native_.put("__probe__", "v");
        native_.getIfPresent("__probe__");
        native_.getIfPresent("__missing__");
        var stats = native_.stats();
        assertThat(stats.requestCount())
                .as("%s 的 stats().requestCount() 是 0 → 沒有 recordStats()（5.9.1）", name)
                .isEqualTo(2);
        native_.invalidate("__probe__");
    }
}
```

⚠️ **它有一個副作用（污染快取）**，所以只能在測試環境跑。
👉 **而那個副作用用 `__probe__` 這個不可能撞到的 key + 最後 `invalidate` 處理掉。**

### 5.9.2 命中率多少才算好

**這是最常被問、最常被答錯的問題。**

🔴 **「命中率越高越好」是錯的。**

| 命中率 | 可能的意義 |
|---|---|
| **30%** | ⚠️ 可能是「快取沒用」，也可能是「這個查詢本來就很分散」 |
| 85% | ✅ 通常很好 |
| 98% | ✅ 很好 |
| **99.99%** | 🔴🔴 **可能是壞消息** —— 見下 |

⚠️⚠️ **99.99% 為什麼可能是壞消息**：

```
命中率 99.99% = 每 10,000 次讀取才 miss 一次
            = TTL 內平均有 10,000 次請求
            = 🔴 資料可能已經舊了很久，而沒有人發現
```

**命中率要與「不一致的成本」一起看**：

| 資料 | 目標命中率 | 為什麼 |
|---|---|---|
| `orderOwners`（永不變） | **越高越好** | ✅ 沒有不一致的可能 |
| `productSummaries` | 90～98% | 平衡 |
| **`productPrices`** | ⚠️ **不看命中率，看 TTL** | 一致性優先（5.10.1） |

✅ **正確的問法不是「命中率夠高嗎」，是三個問題**：

```
① 快取讓資料庫的負載降了多少？        → 對照 miss 數 × 查詢成本
② 不一致的最長時間是多久？             → TTL（+ 清除的延遲）
③ 那個時間業務上可以接受嗎？          → 這是產品決定，不是工程決定
```

### 5.9.3 三個該告警的情況

```yaml
# ① 命中率突然掉 —— 通常代表「快取被清了」或「key 的組成變了」
- alert: CacheHitRateDropped
  expr: |
    (rate(cache_gets_total{result="hit"}[10m])
     / rate(cache_gets_total[10m])) < 0.5
  for: 10m
  annotations:
    summary: "{{ $labels.cache }} 命中率低於 50%"
    # ⚠️ 最常見的原因：有人改了 key 的組成（5.4）→ 舊的項目永遠不會被命中

# ② 淘汰率高 —— 容量不夠
- alert: CacheEvictionRateHigh
  expr: rate(cache_evictions_total[10m]) / rate(cache_puts_total[10m]) > 0.5
  for: 15m

# ③ 快取錯誤 —— Redis 有問題（5.7.2 的降級是靜默的）
- alert: CacheErrorRateHigh
  expr: rate(cache_errors_total[5m]) > 1
  for: 5m
```

⚠️ **① 的註解值得強調。「改了 key 的組成」的症狀是**：

```
部署之後：
  命中率從 95% 掉到 0%
  資料庫 QPS 從 400 變成 8,000
  ⚠️ 而【沒有任何錯誤】—— 功能完全正常，只是慢
```

**這是快取最常見的生產事故，而它只有指標抓得到。**

### 5.9.4 一個容易被忘記的指標：快取的「年齡」

**TTL 保證「最舊的資料有多舊」，而它是一個上限，不是實際值。**

```java
/**
 * ★ 記錄「被命中的項目寫入多久了」——
 * 它回答「實際上使用者看到的資料有多舊」。
 *
 * <p>⚠️ Caffeine 沒有內建這個，要自己包一層。
 * 而它的成本是「每個項目多存一個 long」——
 * 對 5 萬個項目來說是 400 KB，可以接受。
 */
record Aged<T>(T value, long writtenAtNanos) {}

<T> T getWithAge(Cache cache, String key, String cacheName,
                 java.util.function.Supplier<T> loader) {
    @SuppressWarnings("unchecked")
    Aged<T> aged = (Aged<T>) cache.get(key, () ->
            new Aged<>(loader.get(), System.nanoTime()));
    long ageMillis = (System.nanoTime() - aged.writtenAtNanos()) / 1_000_000;
    meters.timer("cache.age", "cache", cacheName)
          .record(ageMillis, java.util.concurrent.TimeUnit.MILLISECONDS);
    return aged.value();
}
```

**它讓一個問題變得可回答**：

> 「客戶抱怨看到舊價格。那個價格有多舊？」
>
> ✅ `cache_age_seconds{quantile="0.99"} = 28` → 最舊的 1% 是 28 秒
> 🔴 沒有這個指標 → 只能說「最多 30 秒，因為 TTL 是 30 秒」

---

## 5.10 什麼不該快取 ★★

### 5.10.1 四類不該快取的資料

| 類別 | 例子 | 為什麼 |
|---|---|---|
| ① **計數器與餘額** | 庫存數量、券的已用次數、帳戶餘額 | 🔴 **它們是「當前值」，而快取的定義就是「舊值」** |
| ② **正在被競爭的資料** | 促銷商品的庫存 | 🔴 02 章 2.11.2「檢查與寫入之間的縫」—— 快取讓那個縫變成 30 秒 |
| ③ **依賴呼叫者身分的** | `detail(orderId, actor)` | 🔴 5.4.4（授權與快取不相容） |
| ④ **有副作用的方法** | 「查詢並標記為已讀」 | 🔴 5.2.1（命中時方法不跑） |

⚠️ **① 值得展開，因為「庫存」是最常見的錯誤快取對象。**

```java
// 🔴🔴 這行程式碼會讓超賣變成必然
@Cacheable(cacheNames = "stock", key = "#productId")
public int availableOf(String productId) { ... }
```

**它為什麼一定會出事**：

```
促銷開始，庫存 100
T=0     快取寫入 100
T=0~30  8,000 個請求全部讀到「100」
        → 每一個都通過「庫存夠嗎」的檢查
        → 🔴 8,000 筆訂單成立，而庫存只有 100
```

⚠️⚠️ **而 00 章 0.3.2 事故 3（超賣 47 筆）的成因是「先 SELECT 再 UPDATE」** ——
**快取讓那個問題放大 100 倍**，因為它把「幾毫秒的縫」變成「30 秒的縫」。

✅ **正確做法（02 章 2.11.7）**：原子 UPDATE，**完全不讀庫存**：

```sql
UPDATE stock SET available = available - ?
WHERE product_id = ? AND available >= ?
-- ★ 影響 0 列 = 庫存不足
```

**那「商品頁上顯示的庫存數字」呢？**

| 選項 | |
|---|---|
| ① 快取它 | ✅ **可以** —— 它只是**顯示**，不是**判斷** |
| ② 不顯示精確數字 | ✅ 「剩不到 10 件」比「剩 7 件」更好（它天生容忍不一致） |

> 📌📌 **這是本節最重要的區分**：
>
> **「顯示用的庫存」可以快取，「判斷用的庫存」絕對不行。**
>
> 而讓兩者不會被混用的方法是**兩個方法、兩個名字**：
>
> ```java
> /** ★ 顯示用。可能是舊的。⚠️ 不可用於任何判斷。 */
> @Cacheable(cacheNames = "stockDisplay", key = "#productId")
> public StockDisplay displayStockOf(String productId) { ... }
>
> /** ★★ 判斷用。它【不查詢】—— 它直接嘗試扣減。 */
> public boolean tryReserve(String productId, int quantity) { ... }
> ```
>
> ⚠️ **注意 `tryReserve` 根本沒有「查詢」的版本** ——
> 那讓「先查再判斷」在 API 上不可能。

### 5.10.2 有副作用的方法

```java
// 🔴 第二次呼叫時，viewCount 不會增加
@Cacheable(cacheNames = "articles", key = "#id")
public Article readAndCount(String id) {
    Article a = repo.findById(id).orElseThrow();
    repo.incrementViewCount(id);          // ★ 副作用
    return a;
}
```

⚠️ **這個 bug 的表現是「瀏覽數不動」，而沒有任何錯誤。**

✅ **一條 ArchUnit 規則抓「`@Cacheable` 方法呼叫了寫入方法」**：

```java
/**
 * ★ @Cacheable 的方法不可以呼叫 @Transactional 的寫入方法。
 *
 * <p>⚠️ 它是一個<b>啟發式</b>：「呼叫寫入交易」是「有副作用」最常見的形狀，
 * 但不是唯一的（寫檔案、送訊息、改靜態變數都抓不到）。
 */
@ArchTest
static final ArchRule Cacheable方法不可呼叫寫入交易 =
        noMethods().that().areAnnotatedWith(Cacheable.class)
                   .should(new ArchCondition<JavaMethod>("呼叫寫入交易的方法") {
                       @Override
                       public void check(JavaMethod m, ConditionEvents events) {
                           m.getMethodCallsFromSelf().stream()
                            .map(call -> call.getTarget().resolveMember())
                            .flatMap(java.util.Optional::stream)
                            .filter(t -> t.tryGetAnnotationOfType(Transactional.class)
                                    .map(tx -> !tx.readOnly()).orElse(false))
                            .forEach(t -> events.add(SimpleConditionEvent.violated(m, """
                                    %s 是 @Cacheable，但它呼叫了寫入交易 %s。
                                    ⚠️ 快取命中時這個方法【完全不會執行】（5.2.1）——
                                    於是那個副作用會靜默消失（5.10.2）。
                                    """.formatted(m.getFullName(), t.getFullName()))));
                       }
                   });
```

### 5.10.3 一個反直覺的例子：`ResourceBundleMessageSource` 不該再加一層

**04 章 4.17 預告了這件事。**

```java
// ProblemFactory.build()
String userMessage = message(code.userMessageKey(), args, "…", locale);
//                   ↑ 每一個 4xx 都會查一次 ResourceBundle
```

**算術**：41 個例外 × 每秒 200 次 4xx = **每秒 8,200 次 bundle 查詢**。
看起來很值得加快取。

⚠️ **而 `ResourceBundleMessageSource` 本身就有快取**：

| 設定 | 預設值 | 意義 |
|---|---|---|
| `cacheMillis` | **-1** | **永久快取**（bundle 載入後不重讀） |
| `cacheSeconds` | -1 | 同上 |

✅ **所以那 8,200 次查詢是「一次 `ConcurrentHashMap` 查詢」** —— 約 20 ns。

**再加一層快取會**：

| | |
|---|---|
| 節省 | 20 ns × 8,200 = **0.16 ms/秒** |
| 付出 | 一個新的快取、一組新的 key、一個新的失效問題（**改文案要清它**） |

🔴 **明顯不值得。**

> 📌📌 **這一節的一般規則，也是全章最實用的一條**：
>
> **加快取之前先問「它下面已經有快取了嗎」。**
>
> **已經有內建快取而常被重複快取的東西**：
>
> | 元件 | 內建的快取 |
> |---|---|
> | `MessageSource` | ✅ `cacheMillis = -1`（永久） |
> | JPA 的一級快取 | ✅ 同一個交易內 `findById` 只查一次 |
> | **`@ConfigurationProperties`** | ✅ 它是一個 singleton bean，**根本沒有查詢** |
> | Spring 的 bean | ✅ singleton |
> | `Pattern.compile` 的結果 | 🔴 **沒有** —— 這個真的該自己快取（static final） |

### 5.10.4 shop-service 的「不快取」清單

| 不快取的 | 理由 | 誰守它 |
|---|---|---|
| `stock.availableOf()` | 5.10.1 ① | ✅ 它**不存在**（只有 `tryReserve`） |
| `coupon.usageCount()` | 5.10.1 ① | ✅ 同上 |
| `OrderApplicationService` 的**所有**方法 | 它們是命令，有副作用 | ✅ ArchUnit（5.10.2） |
| `detail(orderId, actor)` | 5.4.4（授權） | ⚠️ **沒有機制守** → 5.16 的缺口 |
| `MessageSource` 的查詢 | 5.10.3 | ⚠️ 沒有機制守 |

---

## 5.11 快取的測試 ★★

### 5.11.1 「證明第二次沒打資料庫」

**這是快取測試的核心斷言，而它有三種寫法。**

**寫法 A：Mockito 的 `verify(times(1))`** ★

```java
@Test
void 第二次查詢不會打資料庫() {
    when(productRepository.findById("P-1")).thenReturn(Optional.of(aProduct()));

    productService.findById("P-1");
    productService.findById("P-1");

    // ★★ 這一行就是整個測試的目的
    verify(productRepository, times(1)).findById("P-1");
}
```

| | |
|---|---|
| ✅ | 快、明確、不需要真的資料庫 |
| 🔴 | ⚠️ 需要 Spring 的 context（`@Cacheable` 要代理）→ 不是純單元測試 |

**寫法 B：計數器**（5.3.1 的實驗用的）

```java
static final AtomicInteger DB_HITS = new AtomicInteger();
```

| | |
|---|---|
| ✅ | 不需要 Mockito；在整合測試裡也能用 |
| 🔴 | ⚠️ **不可以是實例欄位**（5.3.2 的 CGLIB 陷阱） |

**寫法 C：直接檢查 `Cache`**

```java
@Test
void 查詢後快取裡有項目() {
    productService.findById("P-1");
    assertThat(cacheManager.getCache("products").get("P-1")).isNotNull();
}
```

| | |
|---|---|
| ✅ | 順便驗證了 **key 的組成**（5.4） |
| 🔴 | 🔴 **它不證明「第二次沒打資料庫」** —— 只證明「有寫進去」 |

✅ **shop-service 的做法：A + C**。

**A 證明「有讀到」，C 證明「key 是對的」** —— 而兩者都需要：

```java
@Test
void 商品查詢的快取行為() {
    when(productRepository.findById("P-1")).thenReturn(Optional.of(aProduct()));

    var first = productService.findById("P-1");
    var second = productService.findById("P-1");

    verify(productRepository, times(1)).findById("P-1");     // ★ A：只查一次
    assertThat(second).isSameAs(first);                       // ★ 本地快取回同一個實例
    assertThat(cacheManager.getCache("products").get("P-1"))  // ★ C：key 正確
            .isNotNull();
}
```

⚠️ **`isSameAs` 在本地快取上成立，在 Redis 上不成立**（反序列化產生新實例）——
**所以這條斷言把測試綁在「本地快取」上。**

👉 **處置**：改用 `isEqualTo`，並**另外**寫一條「序列化往返」的測試（5.8.5）。

### 5.11.2 ⚠️ 測試之間的快取污染

**這是快取測試最常見的問題**：

```java
@SpringBootTest
class ProductServiceCacheTest {

    @Test void 測試A() { productService.findById("P-1"); ... }

    @Test void 測試B() {
        // 🔴 P-1 已經在快取裡（測試 A 放的）
        //    → repository 的 mock 不會被呼叫 → verify 失敗
        //    ⚠️ 而它的失敗訊息是「Wanted 1 time but was 0 times」，
        //       看起來像「快取沒生效」而不是「快取太生效」
    }
}
```

✅ **一個 `@BeforeEach` 清全部**：

```java
@BeforeEach
void clearAllCaches() {
    cacheManager.getCacheNames()
            .forEach(name -> cacheManager.getCache(name).clear());
}
```

⚠️⚠️ **而 `getCacheNames()` 在 `CaffeineCacheManager` 上是 lazy 的**：

```java
// ★ 沒有呼叫過 getCache("products") 之前，getCacheNames() 是空的
//   → 這個 @BeforeEach 在第一個測試時什麼都沒清
```

✅ **修法：明確宣告快取名稱**（5.9.1 的 `setCacheNames`），
**而那同時也是 5.9.1 指標需要的**。

> 📌 **一個設定同時解決兩個問題，通常代表它本來就該設。**

### 5.11.3 用 Testcontainers 測 Redis ⚠️ 未實測

```java
/**
 * ⚠️⚠️ <b>這組測試在撰稿的機器上沒有跑過</b>（沒有 Docker）。
 * 5.8.6 已經說明本章的 Redis 部分只驗證了「序列化器本身」。
 */
@SpringBootTest
@Testcontainers
class RedisCacheIntegrationTest {

    @Container
    static final GenericContainer<?> REDIS =
            new GenericContainer<>(DockerImageName.parse("redis:7.2-alpine"))
                    .withExposedPorts(6379);

    @DynamicPropertySource
    static void redisProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", REDIS::getHost);
        registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
    }

    @Autowired ProductService products;
    @Autowired StringRedisTemplate redis;
    @MockBean ProductRepository repository;

    @Test
    void 存進Redis的key長什麼樣() {
        when(repository.findById("P-1")).thenReturn(Optional.of(aProduct()));
        products.findById("P-1");

        // ★ 這是本章最想知道但沒驗證到的事（5.8.6）
        var keys = redis.keys("*");
        System.out.println("Redis 裡的 key = " + keys);
        assertThat(keys).contains("products::P-1");
    }

    @Test
    void TTL有被設定() {
        when(repository.findById("P-1")).thenReturn(Optional.of(aProduct()));
        products.findById("P-1");
        Long ttl = redis.getExpire("products::P-1");
        assertThat(ttl).isBetween(20L, 31L);      // 30 秒 ± 抖動
    }
}
```

### 5.11.4 5.3 那組交易實驗的完整版

```java
@Test
void 交易rollback之後快取裡不可以有髒資料() {
    setUp();

    assertThatThrownBy(() -> writer.renameAndReadThenFail("P-1", "髒名稱"))
            .isInstanceOf(IllegalStateException.class);

    // ★★ 這條斷言【現在會失敗】—— 而那正是 5.3.3 實驗 4 的結論
    assertThat(cachedValue("P-1"))
            .as("""
                快取裡有一個從來沒有在資料庫裡存在過的值（5.3.3 實驗 4）。
                本章的處置是「短 TTL + AFTER_COMMIT 清快取 + ArchUnit 禁止在寫入交易裡
                呼叫 @Cacheable」（5.3.5、5.3.6）——
                ⚠️ 而這條測試守的是「那三個機制真的有裝上」。
                """)
            .isNotEqualTo("髒名稱");
}
```

⚠️ **這條測試在「三個機制裝上之後」才會綠**：

| 機制 | 讓這條測試綠嗎 |
|---|---|
| 短 TTL | 🔴 **不會**（30 秒內它還在） |
| `AFTER_COMMIT` 清快取 | 🔴 **不會**（交易 rollback → 沒有 AFTER_COMMIT） |
| **ArchUnit 禁止交易裡呼叫 `@Cacheable`** | ✅ **會** —— 因為那個呼叫根本不該存在 |

> 📌📌 **這個對照表本身是一個重要的發現**：
>
> **5.3.5 的兩個機制（短 TTL、`AFTER_COMMIT`）都解決不了實驗 4。**
> 它們解決的是**別的**問題（併發回填舊值）。
>
> ⚠️ **實驗 4 只有一個解法：不要在寫入交易裡呼叫 `@Cacheable` 方法。**
> 而那讓 5.3.6 的 ArchUnit 規則從「一個選項」變成「唯一的解」。

### 5.11.5 五條守門測試

```java
package example.shop.cache;

/**
 * ★★ 快取的五條守門測試。
 *
 * <p>⚠️ 全部都是「掃描測試」，所以全部都需要<b>下限斷言</b>（04 章 4.12.1）。
 */
class CacheGuardTest {

    private static final JavaClasses MAIN = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
            .importPackages("example.shop");

    /** ① 每個 cache 名稱只被一個方法使用（5.4.2 事故 2）。 */
    @Test void 每個cache名稱只被一個方法使用() { /* 5.4.2 已給 */ }

    /** ② sync = true 不可有 unless 或多個 cacheNames（5.7.1）。 */
    @Test void sync為true的Cacheable不可有unless或多個cacheNames() { /* 5.7.1 已給 */ }

    /** ③ 每個 @Cacheable 的 cache 名稱都在 CacheManager 的清單裡。 */
    @Test
    void 每個Cacheable的名稱都有被宣告() {
        var declared = Set.of("products", "productSummaries", "productPrices",
                              "orderOwners", "orderContents", "couponDefinitions",
                              "categoryIndex", "catalogVersion");
        var used = new java.util.TreeSet<String>();
        MAIN.stream().flatMap(c -> c.getMethods().stream())
            .forEach(m -> m.tryGetAnnotationOfType(Cacheable.class)
                    .ifPresent(a -> used.addAll(names(a))));

        assertThat(used).as("掃到 0 個 @Cacheable —— 檢查掃描範圍").isNotEmpty();
        assertThat(declared).containsAll(used);
    }

    /**
     * ④ ★★ 沒有任何被快取的型別依賴 `is-getter`（5.8.3）。
     *
     * <p>⚠️ 5.8.5 的 ObjectMapper 關掉了 IS_GETTER 偵測 ——
     * 於是一個「只有 isXxx() 沒有欄位」的屬性會<b>靜默消失</b>。
     */
    @Test
    void 沒有快取型別依賴is_getter() {
        var om = CacheObjectMappers.forCache();
        var withIsGetter = new java.util.ArrayList<String>();

        for (Class<?> type : CACHED_TYPES) {           // 手寫清單，見下
            for (var m : type.getDeclaredMethods()) {
                if (m.getName().startsWith("is") && m.getParameterCount() == 0
                        && (m.getReturnType() == boolean.class
                            || m.getReturnType() == Boolean.class)) {
                    // ★ 只有「沒有對應的 record 元件」時才是問題
                    boolean hasComponent = type.isRecord()
                            && java.util.Arrays.stream(type.getRecordComponents())
                                    .anyMatch(rc -> rc.getName().equals(m.getName()));
                    if (!hasComponent) {
                        withIsGetter.add(type.getSimpleName() + "#" + m.getName());
                    }
                }
            }
        }
        // ★ 這一條【印出來】而不是失敗 —— 有 is-getter 不一定是問題，
        //   問題是「那個值需要被還原」，而那需要人判斷（04 章 4.2.3 的同一個手法）
        withIsGetter.forEach(s -> System.out.println("[is-getter] " + s));
    }

    /**
     * ⑤ ★★ 快取的 ObjectMapper 一定有 PolymorphicTypeValidator（5.8.5）。
     */
    @Test
    void 快取的ObjectMapper擋得住任意類別() {
        var om = CacheObjectMappers.forCache();
        String evil = "{\"@class\":\"java.lang.ProcessBuilder\",\"command\":[]}";
        assertThatThrownBy(() -> om.readValue(evil, Object.class))
                .as("""
                    activateDefaultTyping 沒有 PolymorphicTypeValidator ——
                    任何能寫入 Redis 的人都能實例化 classpath 上的任意類別（5.8.5）。
                    """)
                .rootCause()
                .isInstanceOf(InvalidTypeIdException.class);
    }
}
```

⚠️ **④ 的 `CACHED_TYPES` 是一個手寫清單**，而那有 04 章 4.12.2 的同一個問題：
**手寫會漏**。

✅ **修法：從 `@Cacheable` 方法的回傳型別自動推導**：

```java
/** ★ 所有「會被放進快取」的型別 —— 從 @Cacheable 方法的回傳型別推導。 */
private static Set<Class<?>> cachedTypes() {
    return MAIN.stream()
            .flatMap(c -> c.getMethods().stream())
            .filter(m -> m.isAnnotatedWith(Cacheable.class))
            .map(m -> m.getRawReturnType().reflect())
            .collect(java.util.stream.Collectors.toSet());
}
```

⚠️⚠️ **而它只涵蓋「頂層的回傳型別」** ——
`List<ProductView>` 會被推導成 `List`，而 `ProductView` 漏掉。
**這是一個已知的不完備**（5.16）。

---

## 5.12 shop-service 的快取總表

### 5.12.1 八個快取

⚠️ **為什麼別的地方寫「七個」**：下面這張表有 **8 列**，
而 `CacheConfig`（Caffeine）只組態 **7 個** —— 因為 `productPrices` 在 Redis。
**而這一節的結論是它應該被刪掉**（見表格下方），所以最終狀態是 **7 個本地快取**。

| 快取 | 存什麼 | 位置 | TTL | key | 誰清它 |
|---|---|---|---|---|---|
| `orderOwners` | `orderId → customerId`（`String`） | 本地 | **1 小時** | `orderId` | ✅ 不需要清（永不變） |
| `orderContents` | `OrderDetailView` | 本地 | 30 秒 | `orderId:privileged` | `AFTER_COMMIT`（`OrderChangedEvent`） |
| `products` | `ProductView` | 本地 | 30 秒 | `productId` | `AFTER_COMMIT`（`ProductChangedEvent`） |
| `productSummaries` | 名稱 + 圖片 | 本地 | 5 分鐘 | `productId` | 同上 |
| **`productPrices`** | `Money` | **Redis** | 30 秒 | `productId` | 同上 |
| `couponDefinitions` | `Coupon`（定義） | 本地 | 5 分鐘 | `code` | `AFTER_COMMIT` |
| `categoryIndex` | `List<String>`（商品 id） | 本地 | 1 分鐘 | `category:page` | 上下架 / 換分類時 |
| `catalogVersion` | `long` | 本地 | **1 秒** | 固定 | ✅ 不清（靠 1 秒 TTL） |

⚠️ **`productPrices` 是唯一放 Redis 的**，理由（5.5.3）：
**價格必須跨實例一致** —— 三個實例顯示三個價格是不可接受的。

⚠️ **而它有一個尚未解決的矛盾**：

```
productPrices 在 Redis（一致）
products 在本地（不一致）—— 而 ProductView 裡【也有價格】
```

🔴 **同一個價格有兩個快取，一個一致一個不一致。**

**三個處理方式**：

| 方式 | |
|---|---|
| ① `ProductView` 拿掉價格，前端分兩次要 | 🔴 多一個往返 |
| ② `products` 也放 Redis | ⚠️ 失去 14 ns 的本地讀取 |
| ③ ✅ **`products` 的 TTL 縮到與 `productPrices` 相同（30 秒）** | 兩者的不一致上限相同 |

✅ **選 ③**（表格已經是 30 秒），而它的意思是：
**`productPrices` 放 Redis 買到的「跨實例一致」，在 `products` 也有價格的情況下沒有實際效果。**

> 📌📌 **這是一個誠實的結論：`productPrices` 放 Redis 是多餘的。**
>
> ⚠️ 保留它的唯一理由是**「結帳時的價格」走的是另一條路徑** ——
> 而那條路徑**根本不該讀快取**（5.10.1 的判準：判斷用的資料不快取）。
>
> 👉 **真正的結論**：`productPrices` **應該被刪掉**。
> 顯示用的價格走 `products`（本地、30 秒），
> 判斷用的價格走 `productRepository`（不快取）。
> **記進 5.16 的待辦。**

### 5.12.2 組態

```yaml
spring:
  cache:
    type: caffeine
    cache-names:
      - orderOwners
      - orderContents
      - products
      - productSummaries
      - couponDefinitions
      - categoryIndex
      - catalogVersion
    caffeine:
      # ⚠️ 這一行是【所有】快取的預設值 —— 個別的 TTL 要用 Java 組態（見下）
      spec: maximumSize=50000,expireAfterWrite=30s,recordStats
```

⚠️⚠️ **`spring.cache.caffeine.spec` 只能設一組值** ——
而我們有三種 TTL（1 秒 / 30 秒 / 5 分鐘 / 1 小時）。

✅ **所以要用 Java 組態**：

```java
/**
 * ★★ 每個快取不同的 TTL。
 *
 * <p>⚠️ {@code CaffeineCacheManager} 只支援「一組共用的 Caffeine 設定」——
 * 要分開必須用 {@link SimpleCacheManager} + 手動建立每一個 Cache。
 */
@Bean
CacheManager cacheManager(MeterRegistry meters) {
    var manager = new SimpleCacheManager();
    manager.setCaches(List.of(
            caffeine("orderOwners",      Duration.ofHours(1),     200_000),
            caffeine("orderContents",    Duration.ofSeconds(30),   50_000),
            caffeine("products",         Duration.ofSeconds(30),   50_000),
            caffeine("productSummaries", Duration.ofMinutes(5),   100_000),
            caffeine("couponDefinitions",Duration.ofMinutes(5),     5_000),
            caffeine("categoryIndex",    Duration.ofMinutes(1),    10_000),
            caffeine("catalogVersion",   Duration.ofSeconds(1),         1)));
    return manager;
}

private static CaffeineCache caffeine(String name, Duration ttl, long maxSize) {
    return new CaffeineCache(name, Caffeine.newBuilder()
            .maximumSize(maxSize)
            .recordStats()                                    // ★ 5.9.1
            .expireAfter(jittered(ttl))                       // ★ 5.7.2
            .build());
}

/** ★ TTL ± 20% 的抖動（5.7.2 解法 ②）。 */
private static Expiry<Object, Object> jittered(Duration base) {
    long baseNanos = base.toNanos();
    long jitter = baseNanos / 5;
    return new Expiry<>() {
        private long ttl() {
            return baseNanos + ThreadLocalRandom.current().nextLong(-jitter, jitter);
        }
        @Override public long expireAfterCreate(Object k, Object v, long now) { return ttl(); }
        @Override public long expireAfterUpdate(Object k, Object v, long now, long cur) { return ttl(); }
        /** ★ 讀取不延長 —— 5.7.2 的說明 */
        @Override public long expireAfterRead(Object k, Object v, long now, long cur) { return cur; }
    };
}
```

⚠️ **`catalogVersion` 的 `maximumSize(1)`** —— 它只有一個項目（固定 key）。
**寫 1 而不是留預設，是為了讓「它只該有一個項目」這件事被看見。**

### 5.12.3 套件結構

```
example.shop
├── common/cache/
│   ├── CacheObjectMappers.java          ★★ 5.8.5（Redis 用；本地快取不需要）
│   ├── CacheConfig.java                  ★ 5.12.2
│   ├── CacheErrorHandlerConfig.java      ★★ 5.7.2（降級）
│   └── Cached.java                       ★ 5.6.2 的手動快取小工具
├── order/cache/
│   ├── OrderContentKeys.java             ★★ 5.6.5（key 的唯一定義處）
│   └── OrderCacheInvalidator.java        ★ AFTER_COMMIT 清快取
├── product/cache/
│   ├── ProductCacheKeys.java
│   └── ProductCacheInvalidator.java
└── coupon/cache/
    └── CouponCacheInvalidator.java
```

⚠️ **`order/cache/` 而不是 `common/cache/order/`** ——
與 04 章 4.3.7 的判準一致：**東西放在它所屬的領域裡**。

---

## 5.13 本章回頭修正前面的地方 ★★

### ① 🔴 02 章 2.7.2 的 `publicMethodsOnly` 說法是錯的

**02 章 2.7.2 說**：

> `publicMethodsOnly` 預設 `true` → **非 `public` 方法同樣靜默失效**

**實測（Spring Boot 3.2.5 / Framework 6.1.6，CGLIB 代理）**：

```
[tx] 容器裡的 TransactionAttributeSource publicMethodsOnly = false
[tx] package-private 方法在交易裡嗎 = true
[tx] package-private 失敗後的列數  = 0（有 rollback）
```

**位元碼證據**：

```
ProxyTransactionManagementConfiguration.transactionAttributeSource():
  new AnnotationTransactionAttributeSource
  iconst_0                          ← ★ publicMethodsOnly = false
  invokespecial <init>:(Z)V
```

**修正後的正確說法**：

| 修飾詞 | 有效嗎 | 為什麼 |
|---|---|---|
| `public` | ✅ | — |
| **`package-private`** | ✅ **有效** | `publicMethodsOnly = false`；CGLIB 可覆寫同套件的 package-private |
| `protected` | ⚠️ **理論上有效**，但它通常被自呼叫 | — |
| `private` | 🔴 | CGLIB 無法覆寫；且只能自呼叫 |
| `static` / `final` | 🔴 | CGLIB 無法覆寫 |

⚠️ **02 章那個說法在三種情況下是對的**：
JDK 動態代理、自己 `new AnnotationTransactionAttributeSource()`、
或 Spring 5.x 之前的某些版本。
**而 shop-service 用 CGLIB + 自動組態，所以它不適用。**

✅ **處置**：02 章 2.7.2 那一段改寫，並保留「為什麼很多人以為是 `true`」的說明
（因為**類別的預設建構子**確實是 `true`）。

⚠️ **而它對 00 章 0.11.2 的守門規則沒有影響**：

```java
// 「@Transactional 方法不可為 final」—— 仍然正確
// 「@Transactional 方法不可宣告 checked exception」—— 仍然正確
```

**兩條規則都不分可見性，所以它們本來就涵蓋 package-private。**

### ② 🔴 00 章 0.9.1 的 `Money` 無法通過 Jackson 往返

**實測**：

```
序列化 = {"amount":1500.00,"currency":"TWD","zero":false,"negative":false,"positive":true}
往返   = UnrecognizedPropertyException: Unrecognized field "zero"
```

**成因**：`isZero()` / `isPositive()` / `isNegative()` 被當成 getter。

⚠️ **它在 API 上不會出事**（03 章 3.8.4 規定金額是 `String`，
而 04-controller 6.5.7 有 `MoneySerializer`），
**但在快取上會**（另一個 `ObjectMapper`，5.8.1）。

✅ **處置：不改 `Money`**（那會讓 domain 依賴 Jackson），
改快取的 `ObjectMapper`（5.8.5 的 `IS_GETTER → NONE`）。

⚠️ **而它留下一個一般性的風險**：
**任何「把 domain 物件直接序列化」的地方都會遇到這件事** ——
Kafka 的訊息、outbox 的 payload（06 章）、稽核紀錄的 JSON。

👉 **記進 5.16，並在 06 章處理 outbox 時重新檢查。**

### ③ ⚠️ `orderId` 是 ULID，`orderNumber` 是遞增序號 —— 兩者不可混用

**5.7.3 的分析發現 `orderContents` 不做穿透保護，
而那個決定的安全性取決於「key 猜不到」。**

| | 格式 | 猜得到嗎 |
|---|---|---|
| `Order.id` | ULID（`UlidIdGenerator`，00 章 0.12） | ✅ 猜不到 |
| `Order.orderNumber` | `ORD-yyyyMMdd-NNNN`（02 章 2.11.4） | 🔴 **猜得到** |

✅ **目前是安全的**，而它靠的是一個**沒有被任何機制保護的慣例**。

**正確的長期解法是 `record OrderId(String value)`** ——
而它是一個跨 00～04 章約 200 處的改動。

👉 **本章不做**，理由與 04 章 4.6.1 的「已知命名不一致」相同：
**改動範圍遠大於它解決的風險**。
記進 5.16，並在 5.7.3 留一條（弱的）測試與一段說明。

### ④ ✅ 04 章 4.17 預告的那件事：`ProblemFactory` 不需要加快取

04 章 4.17 說：

> `ProblemFactory` 的 `messageSource.getMessage()` 每次都查 ResourceBundle。
> 41 個例外 × 每秒 200 次 4xx = 每秒 8,200 次 bundle 查詢。

✅ **不需要處理** —— `ResourceBundleMessageSource` 的 `cacheMillis` 預設是 **-1（永久）**，
所以那 8,200 次是 `ConcurrentHashMap` 查詢（~20 ns）。

**這是 5.10.3「加快取之前先問下面有沒有快取」的實例。**

### ⑤ ⚠️ 01 章 1.9.2 的 `@Transactional(readOnly = true)` 讓一個解法不可用

5.3.6 的選項 ③（用 `condition` 排除「交易中的呼叫」）在 shop-service 上不可行，
因為 `OrderQueryService` **整個類別**都是 `@Transactional(readOnly = true)` ——
於是所有查詢都會被排除掉。

✅ **這不是「01 章寫錯了」** ——
`readOnly = true` 是正確的（02 章 2.5.2 有三個非效能的理由）。

👉 **它只是讓 5.3.6 的解法從「三選一」變成「二選一」**，
而最終選的是 ①（ArchUnit 禁止）+ ④（短 TTL）。

### ⑥ 🔴 `productPrices` 這個快取應該被刪掉

**5.12.1 的分析**：`ProductView` 裡也有價格，而它在本地快取 ——
於是「`productPrices` 放 Redis 換到跨實例一致」在實務上沒有效果。

✅ **處置**：刪掉 `productPrices`。
- 顯示用的價格 → `products`（本地，30 秒）
- **判斷用的價格 → 不快取**（5.10.1）

⚠️ **而這個修正是在寫 5.12.1 的總表時才發現的** ——
**因為那張表把「哪個快取存什麼」並排放在一起了。**

> 📌 **一張總表的價值不只是「查閱」**：
> **它讓「兩個東西存了同一份資料」變得看得見。**

### ⑦ 本章新增的組態與類別（給 04-controller 與前四章）

| 新增 | 位置 |
|---|---|
| `@EnableCaching(order = ...)` 與 `@EnableTransactionManagement(order = ...)` | 5.2.2 |
| `CacheErrorHandler`（降級） | 5.7.2 |
| `CacheObjectMappers`（Redis 用的 `ObjectMapper`） | 5.8.5 |
| `OrderContentKeys`（key 的唯一定義處） | 5.6.5 |
| 三個 `CacheInvalidator`（`AFTER_COMMIT`） | 5.12.3 |
| 六條快取守門測試 | 5.11.5 + 5.3.6 + 5.10.2 |

---

## 5.14 常見誤區

**誤區 1：以為 `@Cacheable` 知道交易的存在**

🔴 **它不知道。** 交易裡讀到的未提交值會進快取，
而 rollback 之後**它永久留著**（5.3.3 實驗 4 實測）。

**誤區 2：`@CacheEvict` 就能保持一致**

⚠️ 它只清「你想到的那一個 key」。
改一個商品的價格會影響**六個**快取（5.6.1），
而三個只能用 `allEntries = true` 清 → **事故 3**。

**誤區 3：以為 `beforeInvocation` 是「rollback 的解法」**

實測顯示 `true` 與 `false` 在 rollback 時**都一致**（5.3.4）。
🔴 **真正的問題是「清了之後、commit 之前的窗口」**，而兩者都有。

**誤區 4：兩個方法共用一個 `cacheNames`**

`SimpleKeyGenerator` **不把「哪個方法」放進 key**（5.4.2 實測）。
→ `ClassCastException`（幸運），或**看到別人的資料**（不幸運）。

**誤區 5：把 `Actor` 整個當 key 的一部分**

key 會包含 `displayName` → 改名字讓全部快取失效（5.4.3）。
✅ 只放「會改變結果的東西」。

**誤區 6：快取一個需要授權的方法**

🔴 命中時方法**完全不執行** → **授權檢查被跳過**（5.4.4）。
✅ 授權在外、快取在內。

**誤區 7：以為 `sync = true` 的組態錯誤會在啟動時被發現**

🔴 **實測：它在第一次呼叫時才拋 `IllegalStateException`** ——
於是「上線後第一個使用者看到 500」（5.7.1）。

**誤區 8：加 `unless = "#result == null"` 省記憶體**

🔴 它把**穿透保護**關掉了（5.7.3 實測：預設**會**快取 `null`）。

**誤區 9：忘記 `recordStats()`**

所有指標是 0，而它看起來像「沒有人在用這個快取」（5.9.1）。

**誤區 10：以為命中率越高越好**

99.99% 可能代表「資料舊了很久而沒人發現」（5.9.2）。
✅ 命中率要與**不一致的成本**一起看。

**誤區 11：沒有 `CacheErrorHandler`**

🔴 預設的 `SimpleCacheErrorHandler` **把例外拋出去** ——
Redis 掛掉 = **所有讀取 500**（5.7.2）。

**誤區 12：`activateDefaultTyping` 沒有 `PolymorphicTypeValidator`**

🔴 任何能寫入 Redis 的人都能實例化 classpath 上的任意類別（5.8.5）。

**誤區 13：以為 `DefaultTyping.NON_FINAL` 會給 record 型別資訊**

🔴 **record 是 `final` 的** → 根物件沒有 `@class` → 反序列化失敗（5.8.4 實測）。
✅ 要用 `EVERYTHING`。

**誤區 14：從外部讀一個 Spring bean 的欄位**

🔴 CGLIB 代理有**自己的一組未初始化欄位** → 讀到 `null`（5.3.2 實測）。

**誤區 15：快取庫存**

🔴 它把「幾毫秒的縫」變成「30 秒的縫」→ **超賣是必然的**（5.10.1）。
✅ 顯示用可以快取，**判斷用絕對不行** —— 而讓它們不會混用的方法是**兩個方法名**。

**誤區 16：在已經有快取的東西上再加一層**

`MessageSource`、JPA 一級快取、`@ConfigurationProperties` 都已經有了（5.10.3）。

---

## 5.15 本章練習

### 練習 1：找出這段快取程式碼的 9 個問題

```java
@Service
public class ArticleService {

    @Cacheable(cacheNames = "articles", sync = true, unless = "#result == null")
    public Article read(String id, Actor actor) {
        Article a = repository.findById(id).orElse(null);
        if (a != null) {
            repository.incrementViewCount(id);
            if (!a.isPublic() && !actor.isInternal()) {
                throw new ResourceNotFoundException("Article", id);
            }
        }
        return a;
    }

    @Cacheable(cacheNames = "articles")
    public ArticleSummary summary(String id) { ... }

    @Transactional
    @CacheEvict(cacheNames = "articles", allEntries = true)
    public void publish(String id) {
        Article a = repository.findById(id).orElseThrow();
        a.publish();
        repository.save(a);
        Article after = read(id, Actor.SYSTEM);
        auditLog.record("PUBLISHED", after);
    }
}
```

<details>
<summary>答案</summary>

| # | 問題 | 後果 | 節 |
|---|---|---|---|
| 1 | 🔴🔴 **`sync = true` + `unless`** | **第一次呼叫時** `IllegalStateException` → 500 | 5.7.1 |
| 2 | 🔴🔴 **快取一個做授權的方法** | 命中時授權**完全被跳過** → 非公開文章外洩 | 5.4.4 |
| 3 | 🔴 **key 沒有包含 `actor`** | 內部人員查過之後，一般使用者也命中 | 5.4.3 |
| 4 | 🔴 **`incrementViewCount` 是副作用** | 命中時瀏覽數不增加 | 5.10.2 |
| 5 | 🔴🔴 **`read` 與 `summary` 共用 `articles`** | 同 key → `ClassCastException` 或看到錯的型別 | 5.4.2 |
| 6 | 🔴 **`allEntries = true`** | 發佈一篇文章清掉全部 → 雪崩 | 5.7.2 |
| 7 | 🔴🔴 **在 `@Transactional` 裡呼叫 `read`（`@Cacheable`）** | 未提交的值進快取；rollback 後永久留著 | 5.3.3 |
| 8 | ⚠️ **`read` 是自呼叫**（`this.read(...)`） | 🔴 **代理被繞過 → 快取完全沒作用** —— ✅ 而這意外地讓 7 不會發生 | 5.2.3 |
| 9 | ⚠️ `orElse(null)` + `unless` | 穿透保護被關掉（而 1 讓它根本跑不起來） | 5.7.3 |

⚠️⚠️ **第 8 點值得特別注意**：`read(id, Actor.SYSTEM)` 是**自呼叫**，
所以問題 7（交易裡的 `@Cacheable`）**實際上不會發生** ——
**因為快取根本沒有生效。**

> 📌 **「一個 bug 讓另一個 bug 不會發生」是最難處理的情況**：
> 修好第 8 個（改用注入自己或拆 bean）→ **第 7 個立刻出現。**
>
> ✅ **所以修的順序很重要**：先修 2、3、4、5（設計），再修 8（機制）。

**修正版**：

```java
@Service
public class ArticleService {

    private final ArticleContentService contents;      // ★ 拆出去的 bean

    /** ★ 授權在這裡，【不快取】（5.4.4）。 */
    public Article read(String id, Actor actor) {
        // ① 授權需要的最小資訊 —— 它可以快取（小、幾乎不變）
        ArticleVisibility v = contents.visibilityOf(id);
        if (!v.isPublic() && !actor.isInternal()) {
            throw new ResourceNotFoundException("Article", id);
        }
        // ② 副作用（5.10.2）—— 明確地放在快取之外
        viewCounter.increment(id);
        // ③ 內容 —— 可以快取
        return contents.contentOf(id);
    }

    @Transactional
    public void publish(String id) {
        Article a = repository.findById(id).orElseThrow();
        a.publish();
        repository.save(a);
        // ★ 稽核用【剛剛改過的聚合】，不要再查一次（5.3.6）
        auditLog.record("PUBLISHED", ArticleAuditEntry.from(a));
        // ★ 清快取推到 AFTER_COMMIT（5.3.5 解法 A）
        events.publishEvent(new ArticlePublishedEvent(id));
    }
}

@Service
public class ArticleContentService {

    /** ★ 只快取「公開與否」—— 極小、幾乎不變、命中率極高（5.4.4 的 orderOwners 模式）。 */
    @Cacheable(cacheNames = "articleVisibility", key = "#id")
    public ArticleVisibility visibilityOf(String id) { ... }

    /** ★ 內容。它不做授權，所以 key 不需要 actor。 */
    @Cacheable(cacheNames = "articleContents", key = "#id", sync = true)
    public Article contentOf(String id) {
        return repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Article", id));
    }
}
```

⚠️ **注意修正版把一個快取拆成兩個**（`articleVisibility` + `articleContents`）——
**而那正是 5.4.4 的結論**：
**「這個方法能不能快取」常常是「這個方法的職責混在一起」的訊號。**

</details>

### 練習 2：計算 TTL

**條件**：

```
商品總數        10,000
熱門商品        100 個（佔 80% 的流量）
總 QPS          8,000
可接受的不一致  ≤ 60 秒
JVM 實例        3 個（本地快取）
```

**問**：TTL 該設多少？命中率大概是多少？

<details>
<summary>答案</summary>

**TTL 的上限由「可接受的不一致」決定：60 秒。**

⚠️ **而它不是唯一的約束。** 算一下**熱門商品**的命中率：

```
熱門商品的 QPS = 8,000 × 80% = 6,400，分給 100 個商品 = 每個 64 QPS
每個實例分到     64 / 3 ≈ 21 QPS
TTL = 60 秒 → 每個 key 在每個實例上每 60 秒 miss 一次
             → 命中率 = 1 - 1/(21 × 60) = 99.92%
```

**冷門商品**：

```
冷門的 QPS = 8,000 × 20% = 1,600，分給 9,900 個商品 = 每個 0.16 QPS
每個實例    0.054 QPS → 60 秒內平均 3.2 次請求
             → 命中率 ≈ 1 - 1/3.2 = 69%
```

**加權**：`0.8 × 99.92% + 0.2 × 69% = 93.7%`

⚠️⚠️ **而「TTL 設 60 秒」是錯的答案。** 三個理由：

| 理由 | 說明 |
|---|---|
| 1 | **60 秒是「可接受的上限」，不是目標** —— 而 `AFTER_COMMIT` 清快取讓實際的不一致遠短於 TTL |
| 2 | ⚠️ **命中率從 60 秒降到 30 秒只掉多少？** 熱門：99.92% → 99.84%（**掉 0.08%**）；加權：93.7% → 92.1% |
| 3 | 🔴 **記憶體**：10,000 個商品 × 3 個實例，TTL 越長佔用越久 |

✅ **答案：30 秒**，理由是「命中率只掉 1.6%，而不一致的上限減半」。

**追問：那冷門商品的 69% 命中率要不要處理？**

🔴 **不要。** 算一下它省了什麼：

```
冷門商品的 miss 數 = 1,600 QPS × 31% = 496 QPS 打資料庫
沒有快取           = 1,600 QPS 打資料庫
→ 快取仍然擋掉了 69%
```

⚠️ **而如果為了冷門商品把 TTL 拉長到 10 分鐘**：

```
冷門命中率 69% → 94%（省下 400 QPS）
熱門的不一致上限 60 秒 → 🔴 600 秒
```

**用「熱門商品錯 10 分鐘」換「冷門商品少 400 QPS」是很差的交易。**

> 📌 **一般規則**：
> **TTL 要用「最需要正確的那份資料」來定，不是用「命中率最差的那份」。**

</details>

### 練習 3：這條測試為什麼是假綠燈

```java
@Test
void 快取有生效() {
    productService.findById("P-1");
    productService.findById("P-1");
    assertThat(cacheManager.getCache("products").get("P-1")).isNotNull();
}
```

<details>
<summary>答案</summary>

**它證明「有東西被寫進快取」，不證明「第二次沒打資料庫」。**

**它在下面三種 bug 下都會通過**：

| bug | 為什麼還是綠 |
|---|---|
| ① `@Cacheable` 被自呼叫繞過 | 🔴 **不會綠** —— 自呼叫時**連寫都不寫**（5.2.3 實測） |
| ② **key 每次都不同**（例如 key 含時間戳） | ✅ **會綠** —— `get("P-1")` 拿到的是**別的**測試留下的項目 |
| ③ **上一個測試留下的污染**（5.11.2） | ✅ **會綠** —— 這個測試甚至可以完全不呼叫 service |

⚠️ **③ 最容易發生**，而它的極端版本是：

```java
@Test
void 快取有生效() {
    // 🔴 把兩行 findById 註解掉，測試【還是綠的】
    assertThat(cacheManager.getCache("products").get("P-1")).isNotNull();
}
```

✅ **修正版**：

```java
@Test
void 第二次查詢不打資料庫() {
    // ★ ① 明確的起點（5.11.2）
    cacheManager.getCache("products").clear();
    when(productRepository.findById("P-1")).thenReturn(Optional.of(aProduct()));

    var first  = productService.findById("P-1");
    var second = productService.findById("P-1");

    // ★★ ② 這一行才是這個測試的目的
    verify(productRepository, times(1)).findById("P-1");
    // ★ ③ 順便驗證 key 的組成（5.4）
    assertThat(cacheManager.getCache("products").get("P-1")).isNotNull();
    assertThat(second).isEqualTo(first);
}
```

> 📌 **04 章 4.12.2 的那句話在這裡再一次適用**：
> **一條測試的價值 = 它失敗的能力。**
> 而檢查方式是**把被測的東西弄壞一次**——
> 這裡就是「把 `@Cacheable` 註解掉，看它紅不紅」。

</details>

### 練習 4：設計「商品列表」的快取

**需求**：

```
GET /api/products?category=3C&sort=price_asc&page=0&size=20
```

**條件**：
- 商品共 10,000 個，分類 20 個
- 商品的價格每天改動約 200 次（行銷）
- 上下架每天約 50 次
- 列表頁的 QPS 約 2,000

<details>
<summary>答案</summary>

**先分析「改一次價格會影響哪些列表」**：

| 排序方式 | 改價格影響嗎 |
|---|---|
| `sort=newest` | 🔴 **不影響順序**，但影響**內容**（列表顯示價格） |
| `sort=price_asc` | 🔴🔴 **影響順序** —— 商品可能換頁 |
| `sort=popular` | 不影響順序，影響內容 |

✅ **用 5.6.2 方式 A：把「順序」與「內容」分開**：

```java
/**
 * ★★ 只快取「id 的順序」，不快取內容。
 *
 * <p>於是「改價格」只影響 {@code sort=price_asc} 的索引，
 * 而其他排序方式的索引完全不用動。
 */
@Cacheable(cacheNames = "categoryIndex",
           key = "#category + ':' + #sort + ':' + #page + ':' + #size")
public List<String> idsOf(String category, Sort sort, int page, int size) { ... }

/** ★ 內容從 products 快取逐個取（本地，30 秒）。 */
public List<ProductView> list(String category, Sort sort, int page, int size) {
    List<String> ids = index.idsOf(category, sort, page, size);
    return products.findAllById(ids);          // ★ 5.2.3 的批次版本
}
```

**清除策略**：

| 事件 | 清什麼 | 頻率 |
|---|---|---|
| 改價格 | `products::{id}` + **只有 `price_asc` / `price_desc` 的索引** | 200/天 |
| 上下架 | `products::{id}` + **該分類的所有索引** | 50/天 |
| 換分類 | 兩個分類的所有索引 | 少 |

⚠️ **「該分類的所有索引」有幾個 key**：

```
1 個分類 × 4 種排序 × 平均 25 頁 = 100 個 key
```

**清 100 個 key 每天 50 次 = 5,000 次 evict** —— ✅ 完全沒問題。

⚠️⚠️ **而「改價格要清 price_asc 的索引」有一個問題**：

```
改一個商品的價格 → 它可能從第 3 頁移到第 7 頁
→ 🔴 第 3 到第 7 頁【全部】要清（因為每一頁的內容都往後推了一格）
→ 而如果它移到第 1 頁，那就是【全部 25 頁】
```

✅ **所以改價格要清「該分類 × price 排序的所有頁」** = 50 個 key。
**200 次/天 × 50 = 10,000 次 evict** —— 仍然沒問題。

**而更簡單的做法是 5.6.2 方式 C（版本化的 key）**：

```java
// 改價格 → catalogVersion.bump() → 所有列表索引自然失效
key = "#version + ':' + #category + ':' + #sort + ':' + #page"
```

| | 精確清除 | 版本化 |
|---|---|---|
| 實作複雜度 | ⚠️ 要知道「哪些頁受影響」 | ✅ 一個 `INCR` |
| 命中率 | ✅ 只失效受影響的 | 🔴 **全部失效**（200 次/天 → 每 7 分鐘一次全清） |
| 雪崩風險 | ✅ 低 | 🔴 **每 7 分鐘一次小雪崩** |

✅ **選精確清除**，理由：**版本化的全清在 2,000 QPS 下會造成 5.0 事故 3 的情況。**

⚠️ **而如果改價格的頻率是「每天 20,000 次」（例如動態定價），
那精確清除也沒有意義了** —— 那時的正確答案是
**列表完全不快取，靠資料庫的索引 + 讀取副本**。

> 📌 **這一題的教訓**：
> **快取策略的正確答案取決於「寫入頻率 ÷ 讀取頻率」這個比值**，
> 而那個比值必須**先量測**。

</details>

---

## 5.16 驗收清單

### 完成本章後，你的專案應該有

```
✅ common/cache/
   ├── CacheConfig.java                     ★★ 七個快取，各自的 TTL + 抖動（5.12.2）
   ├── CacheObjectMappers.java              ★★ Redis 用（5.8.5）
   │                                        ★ JavaTimeModule + IS_GETTER=NONE
   │                                        ★ EVERYTHING typing + PolymorphicTypeValidator
   ├── CacheErrorHandlerConfig.java          ★★ 降級（5.7.2）
   └── Cached.java                           ★ 手動快取的小工具（5.6.2）

✅ order/cache/
   ├── OrderContentKeys.java                 ★★ key 的唯一定義處（5.6.5）
   └── OrderCacheInvalidator.java            ★ AFTER_COMMIT（5.3.5 解法 A）
✅ product/cache/  · coupon/cache/            ★ 同上

✅ 組態
   ├── @EnableCaching(order = HIGHEST + 100)          ★★ 快取在外層（5.2.2）
   ├── @EnableTransactionManagement(order = HIGHEST + 200)
   └── recordStats() + setCacheNames(...)             ★★ 5.9.1 / 5.11.2

✅ 測試
   ├── cache/CacheTransactionExperimentTest.java  ★★ 5.3（四個實驗，用真的交易）
   ├── cache/CacheGuardTest.java                  ★★ 五條守門（5.11.5）
   ├── cache/CacheObjectMappersTest.java          ★★ 往返 + 白名單（5.8.5）
   ├── cache/CacheStampedeExperimentTest.java     ★ 擊穿 / null / TTL（5.7）
   └── architecture/CacheArchitectureTest.java    ★ 5.3.6 + 5.10.2

🔴 刪除
   └── productPrices 這個快取                       ★ 5.13 ⑥
```

### 我能回答的問題

- [ ] `@Cacheable` 命中時，方法裡的**授權檢查**還會跑嗎？（5.2.1）
- [ ] 快取與交易的 advisor **誰在外層**？怎麼決定？為什麼要決定？（5.2.2）
- [ ] `package-private` 的 `@Transactional` **會不會**生效？02 章怎麼說？實測怎麼說？（5.2.3、5.13 ①）
- [ ] 「在交易裡呼叫 `@Cacheable` 方法然後 rollback」會發生什麼？（5.3.3 實驗 4）
- [ ] `beforeInvocation = true` 與 `false` 在 rollback 時**有差別嗎**？（5.3.4）
- [ ] `AFTER_COMMIT` 清快取解決了什麼、**沒有**解決什麼？（5.3.5）
- [ ] 為什麼「短 TTL」是**必要的兜底**而不是懶惰？（5.3.5 解法 C）
- [ ] `SimpleKeyGenerator` 在 1 個參數與 2 個參數時的 key **型別**各是什麼？（5.4.1）
- [ ] 兩個方法共用一個 `cacheNames` 會怎樣？**用 `Object` 接住能避開嗎**？（5.4.2）
- [ ] 為什麼「授權」與「快取」在同一個方法上不相容？（5.4.4）
- [ ] `sync = true` 的五個限制是什麼？其中兩個**什麼時候**才炸？（5.7.1）
- [ ] 擊穿、雪崩、穿透的差別，以及各自的實測數字？（5.7）
- [ ] `@Cacheable` 預設**會不會**快取 `null`？加 `unless` 會怎樣？（5.7.3）
- [ ] 三個 Redis 序列化器開箱即用時各自為什麼失敗？（5.8.1）
- [ ] 為什麼 `DefaultTyping.NON_FINAL` 對 record 沒有用？（5.8.4）
- [ ] `Money` 為什麼無法通過 Jackson 往返？為什麼 API 上沒事？（5.8.3、5.13 ②）
- [ ] 命中率 99.99% 為什麼**可能**是壞消息？（5.9.2）
- [ ] 「顯示用的庫存」與「判斷用的庫存」差在哪？怎麼讓它們不會被混用？（5.10.1）
- [ ] 加快取之前該先問什麼？（5.10.3）
- [ ] 「快取有生效」這條測試為什麼是假綠燈？（練習 3）

### ⚠️ 已知缺口

| # | 缺口 | 為什麼不修 | 替代 |
|---|---|---|---|
| 1 | 🔴 **本章沒有真的 Redis**（沒有 Docker） | — | 5.11.3 有 Testcontainers 的測試，**但沒跑過**（5.8.6） |
| 2 | 5.3.6 的 ArchUnit 規則只看**直接呼叫** | ArchUnit 追不了呼叫鏈 | 短 TTL 兜底 |
| 3 | 5.11.5 ④ 的 `cachedTypes()` 只涵蓋**頂層回傳型別** | `List<ProductView>` 推導成 `List` | 手寫清單補充 |
| 4 | **`detail(orderId, actor)` 不可快取** 沒有機制守 | 「這個方法做授權」無法自動判斷 | javadoc + code review |
| 5 | **`OrderId` 型別** 沒有引入 | 跨 00～04 章約 200 處 | 5.13 ③ 的（弱）測試 |
| 6 | **`Money` 在其他序列化路徑上仍然是壞的**（outbox、Kafka） | 本章只處理快取 | ⏳ **06 章重新檢查** |
| 7 | 🔴 **快取掛掉時資料庫會被打** | 需要限流／熔斷 | ⏳ **06 章** |
| 8 | `productPrices` 還沒被刪 | — | 5.13 ⑥ 的待辦 |
| 9 | 5.6.5 的「key 組成與清除在同一個類別」**沒有測試守** | — | ⚠️ 加一條「`allVariants` 的每一個 key 都能被 `of(...)` 產生」 |

### ⚠️ 環境與驗證狀態

**這一章的絕大部分結論都在本機實測過**：

| 項目 | 值 |
|---|---|
| JDK | Temurin 21.0.5 |
| Maven | 3.9.16 |
| Spring Boot | 3.2.5（Framework 6.1.6、Data Redis 3.2） |
| Caffeine | 3.1.8 |
| 資料庫 | **H2 in-memory**（真的交易管理器） |
| 平台 | macOS 14.2.1 / Apple Silicon |

**跑過的實驗**：

| 實驗 | 結果 |
|---|---|
| 自呼叫（5.2.3） | ✅ 50→3 次載入，且**連寫都沒寫** |
| `package-private` 的 tx 與 cache（5.2.3、5.13 ①） | ✅ **兩者都生效** —— 推翻 02 章 2.7.2 |
| 交易 rollback + `@Cacheable`（5.3.3） | ✅ **髒值永久留在快取** |
| `beforeInvocation` 兩種值（5.3.4） | ✅ 兩者在 rollback 時都一致 |
| advisor order（5.2.2） | ✅ 快取在外層時命中不開交易 |
| `SimpleKeyGenerator`（5.4.1） | ✅ 1 個參數時 key 是參數本身 |
| 兩個方法共用 cacheName（5.4.2） | ✅ `ClassCastException`，**`Object` 接住也一樣** |
| 擊穿 `sync`（5.7.1） | ✅ **50 → 1** |
| `sync` + `unless` / 多 cacheNames（5.7.1） | ✅ **第一次呼叫**才拋 |
| `null` 被快取（5.7.3） | ✅ 預設**會**快取 |
| TTL 到期（5.7.2） | ✅ |
| 三個序列化器（5.8.1、5.8.2） | ✅ 三個都失敗；修好後 137 / 401 / 329 bytes |
| `Money` 往返（5.8.3） | ✅ **失敗**；`IS_GETTER=NONE` 修好 |
| `NON_FINAL` vs `EVERYTHING`（5.8.4） | ✅ record 需要 `EVERYTHING` |
| 最終組態的往返 + 白名單（5.8.5） | ✅ 三個測試通過 |
| `Cache#get(key, Callable)` 的原子性（5.7.1） | ✅ Caffeine 與 ConcurrentMap **都是 1/50** |
| Caffeine 讀取延遲（5.5.1） | ✅ **14 ns**（key 已存在陣列）／28 ns（含串接） |

🔴 **沒有驗證的**：

| 沒驗證的 | 影響哪一節 |
|---|---|
| **真的 Redis**（key 格式、TTL、`RedisCache` 的併發） | 5.8.6、5.11.3 |
| `CacheErrorHandler` 的降級行為 | 5.7.2 |
| pub/sub 廣播失效 | 5.5.2 |
| 5.9 的指標與告警 | 整節 |
| 5.12.2 的多 TTL 組態 | ⚠️ 程式碼經逐行檢閱但沒有啟動過 |

---

## 5.17 下一章預告

這一章反覆撞到同一堵牆：

> **快取的問題，一半是「交易邊界」的問題，一半是「跨行程」的問題。**

**而兩者在這一章都只被「縮小窗口」，沒有被解決**：

| 問題 | 本章的處置 | 真正的解法在哪 |
|---|---|---|
| 交易 rollback 後快取有髒值 | ArchUnit 禁止 + 短 TTL | ✅ 本章解決了 |
| 清快取失敗 | log + 指標 + 短 TTL 兜底 | ⏳ **06 章的 outbox** |
| **快取掛掉 → 資料庫被打** | 🔴 **沒有解決** | ⏳ **06 章的限流與熔斷** |
| 多實例的本地快取不一致 | 短 TTL | ⏳ 06 章的事件廣播 |
| `AFTER_COMMIT` 的 listener 失敗 | catch + log | ⏳ **06 章的 outbox** |

**06 章：非同步與外部呼叫。** 而它的核心問題是本章與 04 章共同留下的那一個：

> **交易 commit 之後、回應送出之前，還有一堆事情要做（寄信、清快取、通知 ERP、
> 更新搜尋索引），而它們每一個都可能失敗。**
>
> **「失敗了怎麼辦」在交易裡有答案（rollback），在交易外沒有。**

| 06 章的節 | 主題 |
|---|---|
| 6.2 | `@Async` 與執行緒池 —— 以及它與 `@Transactional` 的**四個衝突** |
| 6.3 ★★ | **交易與非同步**：`AFTER_COMMIT` + `@Async` 的組合為什麼會遺失事件 |
| 6.4 | `RestClient` / `WebClient`：逾時、連線池、重試 |
| 6.5 ★★ | **逾時的三個層次**：連線、讀取、**整體** —— 而只設一個是不夠的 |
| 6.6 ★ | 重試：什麼可以重試（04 章 4.9 的 `safeToRetryBlindly` 在這裡兌現） |
| 6.7 ★★ | **熔斷**：它與 5.7.2 的降級是同一件事的兩個層次 |
| 6.8 ★★ | **Outbox**：本章與 04 章一共留下 **4 個**「失敗只進 log」的地方 |
| 6.9 | 領域事件的可靠投遞 |
| 6.10 ★ | Saga：跨服務的「rollback」 |
| 6.11 | 測試非同步：`Awaitility` 與「怎麼證明它真的做完了」 |

⚠️ **而 06 章會回頭修正這一章的兩件事**：

| 修正 | 為什麼 |
|---|---|
| **5.3.5 解法 A 的 listener 是同步的** | 清快取的延遲（Redis 往返）會加到請求上。而改成 `@Async` 會踩到 6.3 那個「事件遺失」 |
| **5.7.2 的降級讓資料庫承受全部流量** | 缺口 7 —— 它需要的是熔斷（6.7），而不是更多快取 |

---

**完成本章後**，請確認 5.16 的清單。

⚠️ **最後一件事**：這一章有 **9 個已知缺口**，其中 **3 個**（1、7 與 Redis 相關的）
不是「沒做」，而是**需要這門課沒有的基礎設施才做得到**。

> 📌 **而那個區分很重要**：
> 「沒做」是一個**決定**，「做不到」是一個**限制**。
> 兩者都要寫下來，而**只有前者需要被辯護**。

下一章：`06-async-and-external-api-calls.md`
