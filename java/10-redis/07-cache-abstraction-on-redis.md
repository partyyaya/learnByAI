# 第 07 章：快取抽象接上 Redis

> 06 章解決了「存進去的是什麼」。這一章解決「誰去存、什麼時候存、什麼時候清掉」。
>
> 表面上它很簡單——在方法上加一個 `@Cacheable`，換一個 `CacheManager`，完成。
> 而這一章要證明的是：**那五行設定底下藏著六個會讓你加班的問題**，
> 每一個都有可重跑的實測。
>
> | 這一章會親手做出來的六個結果 | 數字 |
> |---|---|
> | 同一個 bean 裡自己呼叫自己 | 快取**完全沒作用**，資料庫被打 3 次 |
> | 方法回傳 `.toList()` 的結果 | **寫得進去、讀不回來**——第二個請求開始每一個都 500 |
> | 改個套件名 | 那一筆快取**每一次被查到都 500**，持續 30 分鐘 |
> | 讀到一半資料被別人改掉 | 快取 `100`、資料庫 `9999`，**維持 1800 秒** |
> | 熱 key 過期，100 個請求撲上來 | 資料庫被打 **100 次**；`sync=true` 只打 1 次，**但慢 9 倍** |
> | 1000 筆快取同時到期 | 一個 250 毫秒的視窗裡**過期 500 筆**；加了抖動之後尖峰是 **62 筆** |
>
> 📌 **這一章的核心不是「怎麼開快取」，是「快取跟資料庫不一致的那幾種方式」。**
> 而其中最重要的一個——`@CacheEvict` 與交易的競態——
> **在單執行緒的測試裡永遠測不出來**（7.7）。

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說出 Spring Cache 抽象的三個角色，以及「它跟 Redis 沒有關係」是什麼意思（7.2）。
- 說出 `@Cacheable` 為什麼在同一個 bean 內部呼叫時完全沒作用（7.2.3）。
- 讀懂 Redis 裡那些 `cacheName::key` 的 key，包含多參數時的 `SimpleKey [0, 3]`（7.3.2）。
- 說出 `@Cacheable`、`@CachePut`、`@CacheEvict` 三者的執行時機差異（7.3.3）。
- 設定 `RedisCacheManager`：前綴、per-cache TTL、序列化器，並說出 `spring.cache.redis.*` 什麼時候會被忽略（7.4）。
- 說出「快取 null」解決什麼、又帶來什麼，以及為什麼 null 一定要有**更短的** TTL（7.5）。
- 指出「快取資料的格式會比程式碼活得久」，並寫出兩種讓改版活下來的做法（7.6）。
- **重現**「清了快取、交易還沒提交、別人把舊值寫回去」的競態，並說出三種收斂方式（7.7）。
- 分辨**穿透、擊穿、雪崩**，各自給出一個實測過的對策（7.8）。
- 說出 `sync = true` 的鎖是**per-cache 而不是 per-key**，以及它的代價（7.8.2）。

---

## 7.2 Spring Cache 抽象：它跟 Redis 沒有關係

### 7.2.1 三個角色

```
   @Cacheable            CacheInterceptor          CacheManager        Cache
   （你寫的註解）  ──→  （AOP 攔截器，Spring 的）──→ （挑一個 cache）──→（真的存東西的地方）
```

| 角色 | 介面 | Redis 的實作 |
|---|---|---|
| 一個具名的快取 | `org.springframework.cache.Cache` | `RedisCache` |
| 管理所有快取 | `CacheManager` | `RedisCacheManager` |
| 攔截方法呼叫 | `CacheInterceptor` | **沒有 Redis 的版本——這一層完全通用** |

`Cache` 介面本身小得驚人：

```java
public interface Cache {
    String getName();
    Object getNativeCache();
    ValueWrapper get(Object key);
    <T> T get(Object key, Callable<T> valueLoader);      // sync = true 走這一條
    void put(Object key, Object value);
    void evict(Object key);
    void clear();
}
```

> 📌 **注意 `get` 回傳的是 `ValueWrapper` 而不是值本身。**
> 因為要分辨兩件事：
> - `get()` 回 **`null`** ＝ **這個快取裡沒有這一筆**（去資料庫拿）
> - `get()` 回一個 **wrapper，裡面是 `null`** ＝ **快取記得「這筆就是不存在」**（不用去資料庫）
>
> 這個區別就是 7.5「快取 null」的全部基礎。

### 7.2.2 換掉 `CacheManager` 就換掉了整個後端

只加 `@EnableCaching`、不設定任何 `CacheManager` 時，Spring Boot 給你
`ConcurrentMapCacheManager`——一個 `ConcurrentHashMap`：

| | `ConcurrentMapCacheManager` | `RedisCacheManager` |
|---|---|---|
| 存在哪 | **這個 JVM 的 heap** | Redis |
| 多實例共用 | ❌ 每台各存各的 | ✅ |
| TTL | **❌ 沒有**（永遠不過期） | ✅ |
| 重啟 | 全沒了 | 還在 |
| 快取穿透打到誰 | 自己的 heap（很快） | Redis（一次網路往返） |
| 速度 | **比 Redis 快 5,619 倍**（00 章 0.2.3） | —— |

> 📌 **00 章 0.2.3 的那個數字在這裡才有意義**：
> 行程內快取比 Redis 快好幾千倍，你還是選 Redis——
> **因為你要的不是快，是「四台機器看到同一份資料」。**
>
> 而這也說明了為什麼**多級快取**（本地 + Redis）是一個真的有意義的設計：
> 本章 7.8.3 會再提到它。

### 7.2.3 ⚠️ 它是 AOP 代理，所以自己呼叫自己沒用

```java
@Service
public class ProductService {

    @Cacheable(cacheNames = "products", key = "#id")
    public Product findById(Long id) {
        dbHits.incrementAndGet();
        return repo.findById(id).orElse(null);
    }

    /** 同一個 bean 內部呼叫自己 */
    public Product findByIdViaSelfCall(Long id) {
        return findById(id);            // ← 這一行
    }
}
```

```
═══ 7.2.3 同一個 bean 裡自己呼叫自己 ═══
透過 findByIdViaSelfCall() 呼叫 3 次，資料庫被打了 3 次
Redis 裡有 products 的 key 嗎：[]
直接呼叫 findById() 3 次，資料庫被打了 1 次
service 的實際型別 : com.example.lab10.shop.ProductService$$SpringCGLIB$$0
```

**`3 次` vs `1 次`，而且 Redis 裡連一個 key 都沒有。**

原因在最後一行：你拿到的 `service` 是一個 **CGLIB 代理**。
代理攔得住「從外面打進來的呼叫」，攔不住「物件內部的 `this.findById(...)`」——
那一行連代理都沒經過。

| 解法 | 寫法 | 評價 |
|---|---|---|
| **把方法拆到另一個 bean** | `ProductQueryService.findById()` | ✅ **建議**。而且通常代表原本的設計本來就該拆 |
| 注入自己 | `@Autowired @Lazy ProductService self;` 然後 `self.findById(id)` | ⚠️ 能動，但讀的人會困惑 |
| `AopContext.currentProxy()` | 需要 `@EnableAspectJAutoProxy(exposeProxy = true)` | ⚠️ 更隱晦 |
| 改用 AspectJ 編織 | —— | ❌ 為了這件事不值得 |

> 📌 **`@Transactional` 完全是同一個問題**，因為它們是同一套機制。
> **一個 bean 裡看到「自己呼叫自己、而被呼叫的那個方法上有註解」，就是一個 bug。**

---

## 7.3 三個註解的精確行為

### 7.3.1 `@Cacheable`：第一次打資料庫，第二次不打

```java
@Cacheable(cacheNames = "products", key = "#id")
public Product findById(Long id) {
    dbHits.incrementAndGet();
    slowQuery();                      // 固定睡 30 毫秒，模擬資料庫
    return repo.findById(id).orElse(null);
}
```

```
═══ 7.3.1 第一次打資料庫，第二次不打 ═══
第 1 次  33 ms，第 2 次  14 ms，第 3 次   1 ms —— 資料庫被打了 1 次
Redis 裡多了什麼：
    lab10:cache:products::1001    TTL=1800   {"@class":"com.example.lab10.shop.Product","id":1001,...}
```

⚠️ **注意第 2 次是 14 毫秒，不是 1 毫秒。** 那是 Lettuce 第一次真的去建連線、
Jackson 第一次替 `Product` 建反序列化器的成本。**第 3 次才是穩態。**
量快取效益時**永遠要丟掉前兩次**——這是壓測最常見的誤讀。

### 7.3.2 key 長什麼樣子

三種方法簽章：

```java
@Cacheable(cacheNames = "products", key = "#id")  public Product findById(Long id)
@Cacheable(cacheNames = "productPage")            public List<Product> findPage(int page, int size)
@Cacheable(cacheNames = "productCount")           public long count()
```

```
═══ 7.3.2 三種方法簽章，三種 key ═══
    lab10:cache:productCount::SimpleKey []       TTL=10     10
    lab10:cache:productPage::SimpleKey [0, 3]    TTL=60     [{"@class":"...Product","id":1001,...}]
    lab10:cache:products::1001                   TTL=1800   {"@class":"...Product","id":1001,...}
```

**key 的組成**：`<前綴><cacheName>::<key>`
（`::` 是 `RedisCacheConfiguration` 的預設分隔，`prefixCacheNameWith` 決定前面那段）。

沒指定 `key` 時走 `SimpleKeyGenerator`：

| 參數個數 | 產生的 key | `toString()` |
|---|---|---|
| 0 個 | `SimpleKey.EMPTY` | `SimpleKey []` |
| 1 個 | **參數本身** | `1001` |
| 2 個以上 | `new SimpleKey(params)` | `SimpleKey [0, 3]` |

> ⚠️ **`SimpleKey` 有三個問題**：
> ① **key 裡有空白跟方括號**，`redis-cli` 上要引號才敲得出來，維運腳本也難處理。
> ② **它只用 `toString()`**——兩個不同的物件只要 `toString()` 一樣就會撞 key。
> ③ **參數如果是你自己的 DTO 而且沒覆寫 `toString()`**，key 會變成
> `SimpleKey [com.example.Query@6d06d69c]`——**物件的 hashCode 每次重啟都不一樣，快取永遠不命中。**
>
> 📌 **規約：一律明寫 `key`。** 用 SpEL 組一個看得懂的字串：
>
> ```java
> @Cacheable(cacheNames = "productPage", key = "'p' + #page + ':s' + #size")
> // → lab10:cache:productPage::p0:s3
> ```

### 7.3.3 `@CachePut` 與 `@CacheEvict`

```
═══ 7.3.3 @CachePut 與 @CacheEvict ═══
快取裡           : {"@class":"...Product","id":1004,"name":"商品-1004",...}
@CacheEvict 之後 : null
再查一次         : Product[1004, 商品-1004, 8888.00, stock=100]
@CachePut 之後（沒有先查過 1005）: {"@class":"...Product","id":1005,"name":"被 @CachePut 改過",...}
```

| | 方法本體會執行嗎 | 對快取做什麼 | 什麼時候 |
|---|---|---|---|
| `@Cacheable` | **命中就不執行** | 沒命中才寫入 | 方法回傳後 |
| `@CachePut` | **一定執行** | **一定寫入** | 方法回傳後 |
| `@CacheEvict` | 一定執行 | 刪除 | **方法回傳後**（預設） |
| `@CacheEvict(beforeInvocation = true)` | 一定執行 | 刪除 | **方法執行前** |

三個容易錯的地方：

**① `@Cacheable` 與 `@CachePut` 放在同一個方法上**——
`@Cacheable` 可能讓方法不執行，`@CachePut` 要求一定執行，**語意互相矛盾**。Spring 不會報錯，行為難以預測。

**② `@CacheEvict(allEntries = true)` 在 Redis 上不是 `FLUSHDB`。**
它是 `RedisCache.clear()`，實作是「**用 `SCAN` 掃出這個前綴的所有 key 再刪掉**」。

> ⚠️ **回到 01 章 1.5**：`SCAN` 會分批、會重複、而且在 key 很多的時候要掃很久。
> 一個有 50 萬筆的 cache 做一次 `allEntries = true`，
> 就是一輪 50 萬筆的掃描 + 刪除——**03 章 3.4 那些 O(N) 的代價全部在這裡。**
> 而且它**不是原子的**：掃到一半有人寫進新的 key，那一筆會留下來。

**③ `beforeInvocation` 的取捨**：

| | `false`（預設） | `true` |
|---|---|---|
| 方法拋例外時 | **不清快取** | **已經清掉了** |
| 適合 | 「清掉」這件事必須跟著成功才做 | 清掉比較安全（例如刪除資料） |
| 風險 | 方法成功了但清快取失敗 → 髒資料留著 | 交易回滾了，快取白清一次（**只是多一次 miss，不會錯**） |

### 7.3.4 `condition` / `unless` / `sync`

```java
@Cacheable(cacheNames = "products",
           key       = "#id",
           condition = "#id > 0",             // 方法執行「前」判斷：要不要走快取
           unless    = "#result == null")     // 方法執行「後」判斷：要不要存結果
```

| | 什麼時候算 | 拿得到 `#result` 嗎 | 典型用途 |
|---|---|---|---|
| `condition` | **呼叫前** | ❌ | 參數不合理時整個跳過快取 |
| `unless` | **回傳後** | ✅ | **不要快取 null**、不要快取空集合 |
| `sync` | —— | —— | 只讓一個執行緒去載入（7.8.2） |

⚠️ **`unless = "#result == null"` 看起來很合理，而它正是 7.8.1 快取穿透的成因。**

### 7.3.5 ⚠️ 方法回傳 `.toList()` 的那一刻

```java
@Cacheable(cacheNames = "productPage")
public List<Product> findPage(int page, int size) {
    return repo.findAll().stream().skip((long) page * size).limit(size).toList();   // ← Java 16+
}
```

```
--- 再讀一次 findPage(0, 3)，這次應該命中快取 ---
讀回來 : MismatchedInputException
  → Unexpected token (START_OBJECT), expected VALUE_STRING:
    need String, Number of Boolean value that contains type id (for subtype of java.lang.Object)
```

**這就是 06 章 6.5.3 那個坑，只是換到了 `@Cacheable` 上。**
`Stream.toList()` 回傳不可變的 `ListN`，是 **final** 類別，
`GenericJackson2JsonRedisSerializer` 的 `NON_FINAL` 型別策略不替它寫型別資訊。

**症狀的形狀特別惡劣**：

```
第 1 個請求  → 沒命中 → 查資料庫 → 回傳正確結果 → 寫進快取   ✅ 成功
第 2 個請求  → 命中   → 反序列化失敗 → 500
第 3 個請求  → 命中   → 反序列化失敗 → 500
...直到 TTL 到期，然後又成功一次
```

> ⚠️ **第一個請求一定會成功**，所以本機點一下、看起來完全正常。
> 而正式環境是「**一分鐘裡成功一次、失敗幾千次**」。
>
> 📌 **修法**（三選一）：
> ① `return new ArrayList<>(...)`（06 章規約 12）。
> ② 這個 cache 改用 `Jackson2JsonRedisSerializer` 搭配明確的 `List<Product>` 型別（7.4.6）。
> ③ **加上 7.6.4 的 fail-soft**：讀不回來就當作沒命中——它不能修好這個 bug，
> 但可以讓它從「每個請求 500」降級成「快取沒生效」。

---

## 7.4 `RedisCacheManager`

### 7.4.1 一份 `RedisCacheConfiguration` 決定五件事

```java
@Bean
public RedisCacheConfiguration defaultCacheConfiguration(ObjectMapper redisObjectMapper) {
    return RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(10))                        // ① TTL
            .prefixCacheNameWith("lab10:cache:")                     // ② key 前綴
            .serializeKeysWith(SerializationPair
                    .fromSerializer(new StringRedisSerializer()))    // ③ key 序列化
            .serializeValuesWith(SerializationPair
                    .fromSerializer(new GenericJackson2JsonRedisSerializer(redisObjectMapper)));  // ④ 值序列化
            // ⑤ .disableCachingNullValues()  ← 預設是「允許」，見 7.5
}
```

**`defaultCacheConfig()` 自己的預設值值得單獨看一次**：

| 項目 | 預設 | 問題 |
|---|---|---|
| TTL | **永不過期** | ⚠️ 快取會一直長，直到 `maxmemory` 開始驅逐（04 章），而**被驅逐的是誰你控制不了** |
| key 前綴 | `<cacheName>::` | 多環境共用一台 Redis 時會撞（7.4.2） |
| key 序列化 | `StringRedisSerializer` | ✅ 這個預設是對的 |
| **值序列化** | **`JdkSerializationRedisSerializer`** | ⚠️ **06 章整章在講的那個** |
| 快取 null | **允許** | 見 7.5 |

> ⚠️ **「值序列化預設是 JDK」這件事要特別記住**：
> 你在 06 章辛苦設定的 `RedisTemplate` **完全不影響 `@Cacheable`**。
> 它們是兩套獨立的設定，**各自有一份序列化器**。
> 只改了 `RedisTemplate` 就以為快取也跟著好了，是很常見的誤會。

### 7.4.2 key 前綴：多環境共用一台 Redis

01 章 1.2.4 講過「不要用 16 個 db 來隔離環境」。正確的做法是**前綴**：

```java
@Value("${lab10.cache.prefix:lab10:v1:}")
private String prefix;
...
.prefixCacheNameWith(prefix)     // → lab10:v1:products::1001
```

前綴裡建議放兩段資訊：

```
lab10 : v1 : products :: 1001
  │      │       │        └── key
  │      │       └── cacheName
  │      └── 快取結構的版本（7.6.3 會用它來做改版）
  └── 環境／應用
```

這樣三件事就同時成立：`SCAN lab10:v1:*` 找得到全部、
`SCAN lab10:v1:products::*` 找得到某一個 cache、
**改版時把 `v1` 換成 `v2` 就等於整批繞過**。

### 7.4.3 per-cache TTL

一份預設 + 幾個例外：

```java
RedisCacheManager.builder(factory)
        .cacheDefaults(defaultCacheConfiguration)
        .withInitialCacheConfigurations(Map.of(
                "products",     defaultCacheConfiguration.entryTtl(Duration.ofMinutes(30)),
                "productPage",  defaultCacheConfiguration.entryTtl(Duration.ofSeconds(60)),
                "productCount", defaultCacheConfiguration.entryTtl(Duration.ofSeconds(10))))
        .build();
```

```
═══ 7.4.3 每個 cache 各自的 TTL ═══
    lab10:cache:productCount::SimpleKey []       TTL = 10 秒
    lab10:cache:productPage::SimpleKey [0, 3]    TTL = 60 秒
    lab10:cache:products::1001                   TTL = 1800 秒
```

📌 `RedisCacheConfiguration` 是**不可變**的——`entryTtl(...)` 回傳一份新的，
所以上面那樣從 `defaultCacheConfiguration` 衍生出三份是安全的。

**TTL 怎麼抓**，一張可以直接用的表：

| 資料 | 建議 TTL | 理由 |
|---|---|---|
| 幾乎不變（分類、設定、地區清單） | 數小時～一天 | 變更時主動 `@CacheEvict` |
| 會變但不急（商品資料） | **10～30 分鐘** | 加上主動失效就夠了 |
| 列表、分頁、搜尋結果 | **30～120 秒** | ⚠️ 它們**很難精準失效**（改一個商品要清哪幾頁？）→ **靠短 TTL** |
| 計數、統計 | 10～60 秒 | 一致性要求低 |
| **快取起來的 `null`** | **30～60 秒** | **7.5.4，一定要比正常值短** |
| 使用者維度（購物車、個人化） | 看業務 | ⚠️ 11 章的 Session 有另一套 |

> 📌 **「列表用短 TTL」是一條很實用的經驗**：
> 單筆資料的失效很好寫（`@CacheEvict(key = "#id")`），
> **列表的失效幾乎寫不對**——改一個商品的價格，要清掉哪些分頁、哪些排序、哪些篩選條件的結果？
> **不要試著算清楚，用 60 秒的 TTL 換掉這個問題。**

### 7.4.4 ⚠️ TTL 不會因為「被讀到」而續期

```
t=0     第一次查 → 寫入快取，TTL = 1800
t=1799  被讀了一萬次 → TTL 還是剩 1 秒
t=1800  過期
t=1800  一萬個請求同時發現沒命中 → 全部打到資料庫     ← 7.8.2 的擊穿
```

Redis 沒有「讀取時續期」這種東西（01 章 1.4：只有 `GETEX` 那種**明確要求**才會動 TTL）。
所以**越熱門的 key，越會定期出現一次擊穿**。

如果你確實需要「最近有人用就續期」，只有兩條路：
① 讀到之後自己 `EXPIRE` 一次（多一次往返，而且要小心 01 章 1.4.3 的 TTL 被洗掉）。
② **不要續期，改成處理擊穿**（7.8.2）——**建議這一條。**

### 7.4.5 ⚠️ `spring.cache.redis.*` 什麼時候生效

```yaml
spring:
  cache:
    type: redis
    redis:
      time-to-live: 10m
      key-prefix: "lab10:"
      use-key-prefix: true
      cache-null-values: true
```

**這些設定只有在「你沒有自己定義 `CacheManager` bean」的時候才生效。**
Boot 的 `RedisCacheConfiguration` 自動設定類別上掛的是：

```java
@ConditionalOnMissingBean(CacheManager.class)
```

> ⚠️ **這一章（以及大部分真實專案）都會自己定義 `CacheManager`**——
> 因為 yml 管不到「per-cache TTL」「序列化器」「TTL 抖動」「fail-soft」。
> **一旦你定義了，yml 裡那幾行就是裝飾品**，而且不會有任何警告。
>
> 📌 **兩種做法，選一種**：
> ① 全部在 yml（簡單專案）——那就**不要**定義 `CacheManager` bean。
> ② 全部在 Java（本站）——那就**把 yml 裡的 `spring.cache.redis.*` 刪掉**，
> 不要留著誤導下一個人。

### 7.4.6 每個 cache 可以有自己的序列化器

`withInitialCacheConfigurations` 換的不只是 TTL，**序列化器也可以各換各的**：

```java
Map.of(
    // 這個 cache 只放 Product → 用不帶 @class 的版本，省 71 bytes / 筆，
    // 而且改套件名也不會壞（06 章 6.5.7 的那張表）
    "products", base.serializeValuesWith(SerializationPair.fromSerializer(
            new Jackson2JsonRedisSerializer<>(redisObjectMapper, Product.class))),

    // 這個 cache 放 List<Product> → 明確指定泛型，順便解掉 7.3.5 的 .toList() 問題
    "productPage", base.serializeValuesWith(SerializationPair.fromSerializer(
            new Jackson2JsonRedisSerializer<>(redisObjectMapper,
                    TypeFactory.defaultInstance().constructCollectionType(List.class, Product.class)))))
```

| | `GenericJackson2Json`（帶 `@class`） | `Jackson2Json<T>`（不帶） |
|---|---|---|
| 一個 cache 放多種型別 | ✅ | ❌ |
| 體積 | +71 bytes / 筆 | 最小 |
| 改套件名 | **❌ 整批壞掉**（7.6.1） | ✅ 不受影響 |
| 別的語言讀得懂 | ⚠️ 要忽略 `@class` | ✅ |
| 設定成本 | 一份就通吃 | **每個 cache 都要寫一行** |

> 📌 **建議**：**預設用 `GenericJackson2Json`，流量最大的那兩三個 cache 改用型別明確的版本。**
> 這是一個「花五分鐘，換掉一整類改版事故」的交易。

---

## 7.5 快取 `null`

### 7.5.1 為什麼要快取 null

```java
Product p = service.findById(999999L);      // 這個商品不存在
```

沒有快取 null 的話，這個 id **每一次查詢都會打到資料庫**——
因為「沒有結果」不會被寫進快取，下一次還是沒命中。7.8.1 會量這件事。

### 7.5.2 實測：Redis 裡存的到底是什麼

```java
Cache cache = manager(...).getCache("np");
cache.put("missing", null);
cache.put("exists", new Product(1L, "耳機", new BigDecimal("2490"), 10, null));
```

```
═══ 7.5.2 快取一個 null，Redis 裡實際存的是什麼 ═══
有值的那筆 : {"@class":"com.example.lab10.shop.Product","id":1,"name":"耳機",...}
null 那一筆 : \xac\xed\x00\x05sr\x00+org.springframework.cache.support.NullValue
              \x00\x00\x00\x00\x00\x00\x00\x01\x02\x00\x00xp  （64 bytes）
  ↑ 是 JDK 序列化，不是你設定的 GenericJackson2JsonRedisSerializer

cache.get("missing")      : ValueWrapper for [null]，wrapper.get() = null
cache.get("neverStored")  : null
  ↑ 兩者必須分得出來：前者是「快取記得它不存在」，後者是「快取沒這筆」
```

**又是 `\xac\xed`。** 而且這一次**不是你設錯**——`RedisCache` 的原始碼裡寫死了：

```java
private static final byte[] BINARY_NULL_VALUE = RedisSerializer.java().serialize(NullValue.INSTANCE);

protected byte[] serializeCacheValue(Object value) {
    if (isAllowNullValues() && value instanceof NullValue) {
        return BINARY_NULL_VALUE;                 // ← 不走你設定的序列化器
    }
    return ByteUtils.getBytes(getCacheConfiguration().getValueSerializationPair().write(value));
}
```

> 📌 **這解釋了 06 章 6.5.5 留下的疑問**：
> 「傳自己的 `ObjectMapper` 會關掉 `NullValueSerializer`」——
> **在 `@Cacheable` 上剛好不會出事，因為 `RedisCache` 根本沒用你的序列化器來處理 null。**
> 但如果你是**直接用 `RedisTemplate`** 存 `NullValue`，它就會炸。
>
> 順帶一提：那 64 bytes 表示**一個「不存在」的快取條目要花 64 bytes + key 的長度**。
> 7.8.1 會看到有人拿這件事當攻擊面。

### 7.5.3 `disableCachingNullValues()`

```
═══ 7.5.3 disableCachingNullValues() ═══
存 null  : IllegalArgumentException
  → Cache 'np' does not allow 'null' values; Avoid storing null via
    '@Cacheable(unless="#result == null")' or configure RedisCache to allow 'null'
    via RedisCacheConfiguration
```

⚠️ **它不是「安靜地不存」，是「拋例外」。** 所以關掉它的話，
**每一個回傳 null 的方法都要自己加 `unless = "#result == null"`**，漏一個就是 500。

| 做法 | 穿透防護 | 記憶體 | 漏寫的後果 |
|---|---|---|---|
| **允許快取 null（預設）+ 短 TTL** | ✅ | 每筆 64 bytes | —— |
| `disableCachingNullValues()` + `unless` | ❌ | 省 | **漏一個 `unless` = 那個方法每次都 500** |

**本站選第一種。**

### 7.5.4 ⚠️ null 一定要有比較短的 TTL

**這是「快取 null」唯一真正的代價**：

```
10:00  商品 1001 還沒上架 → 有人查 → 快取存了 null，TTL = 30 分鐘
10:05  營運上架了商品 1001
10:05  使用者查 → 命中快取的 null → 「查無此商品」
...
10:30  TTL 到期，終於查得到
```

**營運會說「我明明上架了」，而你在資料庫裡看得到那筆資料。**

Spring Data Redis 3.2 起，`entryTtl` 可以吃一個函式：

```java
.entryTtl((RedisCacheWriter.TtlFunction) (key, value) ->
        value == null ? Duration.ofSeconds(30) : Duration.ofMinutes(30))
```

```
═══ 7.5.4 讓 null 用比較短的 TTL ═══
有值的那筆 TTL : 1800 秒
null 那一筆 TTL : 30 秒
```

> ⚠️ **兩個容易寫錯的地方**：
> ① **`TtlFunction` 的參數順序是 `(key, value)`**，不是 `(value, key)`。
> ② **第二個參數拿到的是原始的 `null`，不是 `NullValue.INSTANCE`**，
> 所以條件要寫 `value == null`，寫成 `value instanceof NullValue` **永遠不會成立**
> （而且不會報錯，只是安靜地用了 30 分鐘）。
>
> 📌 **另一條路**：上架時主動 `@CacheEvict`。
> **兩條都要做**——主動失效會漏（批次匯入、直接改資料庫、另一個服務改的），
> **短 TTL 是那個兜底的。**

---

## 7.6 改版之後讀不回來

### 7.6.1 實測：每一個請求都 500

06 章練習一留下的那個例外，現在把它放到 `@Cacheable` 上：

```java
/** 把快取裡的 @class 換成一個不存在的類名 —— 等同「套件改名後重新部署」 */
private void simulateRename() {
    String json = srt.opsForValue().get(KEY);
    srt.opsForValue().set(KEY, json.replace("com.example.lab10.shop.Product",
                                            "com.example.lab10.catalog.Product"));
}
```

```
═══ 7.6.1 改個套件名，之後每一個請求都 500 ═══
快取裡現在寫的類名 : com.example.lab10.catalog.Product
第 1 次查詢 : SerializationException → IllegalArgumentException:
              Failed to parse type 'com.example.lab10.catalog.Product' (remaining: ''):
              Cannot locate class 'com.example.lab10.catalog.Product'
第 2 次查詢 : （同上）
第 3 次查詢 : （同上）
資料庫被打了 1 次（第一次填快取那一次）
  ↑ 它不會「當成沒命中、去資料庫拿」。壞掉的那一筆會一直壞到 TTL 到期（30 分鐘）
```

> ⚠️ **這是這一章最需要被記住的一句話**：
> **`@Cacheable` 不把「讀不回來」當成「沒命中」。**
>
> 直覺會說「快取壞了就去資料庫拿嘛」——**它不會**。
> 例外會一路往上丟到你的 controller，變成 500。
>
> 而且注意 `資料庫被打了 1 次`：**資料庫壓力完全沒有上升**，
> 監控上看不到任何異常，只有錯誤率從 0 跳到 100%。

### 7.6.2 加／刪欄位反而是安全的

```
═══ 7.6.2 加一個欄位 vs 少一個欄位 ═══
舊快取多了一個新版沒有的欄位 colour：
  讀回來 : Product[3001, 改版測試, 500.00, stock=10]  ✅（FAIL_ON_UNKNOWN_PROPERTIES 關著）
舊快取少了一個新版才有的欄位 stock：
  讀回來 : Product[3001, 改版測試, 500.00, stock=null]  ← stock 變成 null，不會報錯
```

跟 06 章 6.4 的 JDK 版對照：

| 改版動作 | JDK 序列化 | Jackson（`FAIL_ON_UNKNOWN_PROPERTIES` 關） |
|---|---|---|
| 加一個欄位 | ⚠️ 安靜地 null／❌ 直接爆（看有沒有寫 UID） | ✅ 舊資料讀得回來，新欄位 = `null` |
| 刪一個欄位 | 同上 | ✅ 多出來的欄位被忽略 |
| 改欄位型別 | ❌ | ⚠️ 看型別，`String`→`Integer` 會爆 |
| **改套件名／類名** | ❌ | **❌**（`@class` 對不上，7.6.1） |
| 改 `cacheName` 或前綴 | —— | ✅ **等於整批繞過**（7.6.3） |

**注意「新欄位 = `null`」也是一種錯**（06 章 6.4.2 那一整段仍然適用），
只是 Jackson 至少不會讓整批快取一起死。

> 📌 **`FAIL_ON_UNKNOWN_PROPERTIES` 必須關掉**（06 章 6.6.2 已經關了）。
> 開著的話，「加一個欄位」就會變成「舊快取全部讀不回來」——
> **而加欄位是所有改版裡最常見的一種。**

### 7.6.3 解法一：前綴帶版本

```
═══ 7.6.3 解法一：key 前綴帶版本 ═══
舊版寫的 key : [v1:app:v1:products::3001]
新版讀同一個 id : null  ← 沒命中，去資料庫拿，自然重建
新版寫的 key : [v1:app:v2:products::3001]
  ⚠️ 代價：舊的那一批 key 還在，要靠 TTL 自己消失（所以 TTL 不能設太長）
```

```yaml
lab10:
  cache:
    prefix: "lab10:v2:"      # 改版時動這一行
```

| 優點 | 缺點 |
|---|---|
| **改一行設定，零風險** | 部署後快取是**空的** → 資料庫瞬間承受完整流量（04 章 4.8.2 的**冷啟動雪崩**） |
| 可以隨時回滾（改回 `v1`，舊資料還在） | 兩份資料同時佔記憶體，直到舊的 TTL 到期 |
| 灰度部署期間新舊版本各讀各的，**不會互相污染** | 要記得改（忘了改就是 7.6.1） |

> ⚠️ **「部署後快取是空的」不是小事。**
> 一個平常命中率 95% 的服務，清空快取那一瞬間資料庫的 QPS 會變成 **20 倍**。
> 所以版本化改版要搭配：**離峰時段 + 預熱 + 7.8.2 的擊穿保護。**

### 7.6.4 解法二：讀不回來就當作沒命中

版本化需要「你記得改」。這一招是**兜底**——

```java
public class FailSoftRedisCacheManager extends RedisCacheManager {

    private final RedisCacheWriter writer;

    public FailSoftRedisCacheManager(RedisCacheWriter writer,
                                     RedisCacheConfiguration defaultConfig,
                                     Map<String, RedisCacheConfiguration> initialConfigs) {
        super(writer, defaultConfig, initialConfigs);
        this.writer = writer;
    }

    @Override
    protected RedisCache createRedisCache(String name, RedisCacheConfiguration cfg) {
        return new FailSoftRedisCache(name, writer,
                cfg != null ? cfg : RedisCacheConfiguration.defaultCacheConfig());
    }

    static class FailSoftRedisCache extends RedisCache {

        FailSoftRedisCache(String name, RedisCacheWriter writer, RedisCacheConfiguration cfg) {
            super(name, writer, cfg);
        }

        @Override
        public ValueWrapper get(Object key) {
            try {
                return super.get(key);
            } catch (SerializationException e) {
                evict(key);          // ← 順手把壞掉的那一筆刪掉
                return null;         // ← null = 沒命中 → 呼叫端會去資料庫拿，並寫一份新格式的回來
            }
        }
    }
}
```

```
═══ 7.6.4 解法二：讀不回來就當作沒命中 ═══
正常讀     : Product[3001, 正常資料, 500, stock=10]
把 @class 改壞之後：
    [FailSoftRedisCache] products::3001 讀不回來（SerializationException），刪掉並當作沒命中
  cache.get() : null  ← null 代表「沒命中」，呼叫端會去資料庫拿
  那一筆壞資料還在嗎 : 已經被刪掉了 ✅
```

**它把「每個請求 500」降級成「這一筆快取沒生效」。**

⚠️ **兩個注意事項**：

- **`evict(key)` 很重要**。不刪的話，每一個請求都要「讀 Redis → 反序列化失敗 → 打資料庫」，
  等於**又慢又沒有快取**，而且一直持續到 TTL 到期。
- **它會把真正的問題藏起來。** 所以**一定要記日誌並接告警**——
  「反序列化失敗次數」應該是一個**平常為 0** 的指標，一旦跳起來就代表有人改了格式。

### 7.6.5 三個做法的分工

| | 處理什麼 | 什麼時候做 |
|---|---|---|
| `FAIL_ON_UNKNOWN_PROPERTIES = false`（06 章 6.6.2） | **加欄位、刪欄位** | 一次設好，永遠有效 |
| **前綴版本化**（7.6.3） | **改類名、改套件、改結構** | **每次這類改版時，主動改一行** |
| **fail-soft**（7.6.4） | **你忘了做上面那件事** | 一次設好，當保險絲 |

> 📌 **三個都要做，它們處理的是不同的東西。**
> 而最重要的心態是這一句：
> **「快取裡的資料，是一份你不會 code review 的、由三個月前的程式碼寫下的資料。」**

---

## 7.7 ⚠️ 快取與交易

這一節是整章最重要的一節。前面所有問題都有明確的錯誤訊息，
**這一節的問題完全沒有錯誤訊息**——它只是讓快取跟資料庫對不上，然後一直對不上。

### 7.7.1 實測：`@CacheEvict` 在交易的哪一刻發生

```java
@CacheEvict(cacheNames = "products", key = "#id")
@Transactional
public void changePriceSlow(Long id, BigDecimal price, long holdMillis, Runnable afterCommit) {
    Product p = repo.findById(id).orElseThrow();
    p.setPrice(price);
    repo.saveAndFlush(p);
    // 註冊一個「交易提交完成那一刻」的回呼，用來確認順序
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override public void afterCommit() { afterCommit.run(); }
    });
    Thread.sleep(holdMillis);       // 交易還要跑 600 毫秒才提交
}
```

```
═══ 7.7.1 @CacheEvict 到底在交易的哪一刻發生 ═══
      1 ms  起點（快取已填，價=100）          快取價=100.00       資料庫價=100.00
    156 ms  交易中（已改 DB，還沒提交）        快取價=100.00       資料庫價=100.00
    463 ms  交易中                         快取價=100.00       資料庫價=100.00
    614 ms  → 交易「提交完成」的那一刻         快取還在嗎 = 還在（尚未清）
    616 ms  交易結束後                      快取價=（沒有快取）   資料庫價=8888.00

  資料庫提交（別人看得到新值）發生在 : 614 ms
  快取被清掉發生在                   : 615 ms
  順序 : 提交 → 清快取（快取攔截器在交易外層）
```

> 📌 **`afterCommit` 那一行是決定性的證據**：交易已經提交完成了，快取**還在**。
> **所以 Spring 的快取攔截器在交易攔截器的外層**：
>
> ```
> CacheInterceptor        ← 外層：@CacheEvict 在這裡執行
>   └─ TransactionInterceptor   ← 內層：交易在這裡開始與提交
>        └─ 你的方法
> ```
>
> **這個順序是對的**（清快取在提交之後，不會清了又被舊值覆蓋回去），
> 但它留下一個**一毫秒的窗口**：`614 ms` 提交、`615 ms` 才清掉。
> 那一毫秒裡讀到快取的人拿到的是舊值。
>
> ⚠️ **這一毫秒平常不重要。7.7.4 會看到它變成 700 毫秒的版本。**

### 7.7.2 交易回滾了，快取呢

```
═══ 7.7.2 交易回滾了，快取呢 ═══
      1 ms  起點                    快取價=100.00       資料庫價=100.00
           交易拋了 IllegalStateException → 回滾
      5 ms  回滾之後                 快取價=100.00       資料庫價=100.00
      8 ms  下一個請求查過之後         快取價=100.00       資料庫價=100.00
```

**快取沒被清，而且這是對的**——因為 `@CacheEvict` 預設 `beforeInvocation = false`，
**方法拋例外時不會清快取**。交易回滾了、資料庫還是 100，快取也還是 100，**兩邊一致**。

反過來，如果你寫了 `beforeInvocation = true`：

```
清快取 → 方法拋例外 → 交易回滾 → 快取空了，資料庫沒變
```

**結果是「多一次 miss」，不是錯誤。** 所以：

| | 交易成功 | 交易回滾 |
|---|---|---|
| `beforeInvocation = false`（預設） | ✅ 清掉 | ✅ 不清（一致） |
| `beforeInvocation = true` | ✅ 清掉 | ⚠️ 白清一次（**只是多一次 miss**） |

> 📌 **兩個都不會造成不一致，預設值就可以。**
> 真正會造成不一致的是下一節。

### 7.7.3 ⚠️ 實測：讀到一半被人改掉——快取停在舊值

這是 Cache-Aside 模式**與生俱來**的競態，**跟 `@CacheEvict` 放在哪裡無關**：

```java
// 讀者：這次查詢要 800 毫秒（慢查詢、GC、網路抖動都會造成）
Thread reader = new Thread(() -> service.findByIdSlow(ID, 800));
reader.start();
Thread.sleep(200);
// 寫者：在讀者「已經讀到舊值、還沒寫進快取」的那段空隙裡改掉資料
service.changePrice(ID, new BigDecimal("9999"));
```

```
═══ 7.7.3 讀到一半被人改掉：快取會停在舊值 ═══
      1 ms  起點（快取是空的）                       快取價=（沒有快取）  資料庫價=100.00
    212 ms  讀者已經從 DB 撈到 100，還沒寫進快取        快取價=（沒有快取）  資料庫價=100.00
    225 ms  寫者改成 9999 並清了快取                  快取價=（沒有快取）  資料庫價=9999.00
    818 ms  讀者把它 200 毫秒前讀到的值寫進快取          快取價=100.00      資料庫價=9999.00

  接下來每一個請求看到的價格 : 100.00
  資料庫裡真正的價格         : 9999.00
  這個狀態會維持到 TTL 到期   : 1800 秒
```

**時序圖**：

```
讀者   ──讀 DB(100)───────────[空隙 600 ms]──────────寫快取(100) ──→
寫者                 ──改 DB(9999)+清快取(空的)──→
                                                     ↑
                                   清快取發生在「讀者寫回去」之前，所以清了個寂寞
```

> ⚠️ **這裡沒有任何錯誤、沒有任何例外、沒有任何日誌。**
> 快取就是 100，資料庫就是 9999，而且**會維持 1800 秒**。
>
> 客服會收到「網頁上顯示的價格跟結帳金額不一樣」，
> 而你去資料庫查會發現資料是對的，重啟一次服務問題就「好了」（因為快取沒了）。
> **這是最難查的一類 bug。**
>
> 📌 **它的成因只有一句話**：
> **`@Cacheable` 的「讀資料庫」與「寫快取」不是原子的**——
> 這正是 **05 章 5.2** 那個「讀出來、改、寫回去中間有一道縫」，只是換了一個舞台。

**發生機率**取決於那道空隙有多寬：

| 空隙的來源 | 典型寬度 |
|---|---|
| 一般查詢 | 1～5 毫秒（**機率很低，但流量夠大就會發生**） |
| 慢查詢、沒有索引的 join | 100 毫秒～數秒 |
| Full GC | 數百毫秒 |
| **`findAll()` 之後在 Java 裡組裝資料** | 看你寫了什麼 |

### 7.7.4 ⚠️ 外層交易讓那道縫變成 700 毫秒

上面那個是「讀者慢」。真實系統裡更常見的是「**寫者的交易很長**」：

```java
@Service
public class OrderService {

    @Transactional
    public void adjustPriceInsideLongTransaction(Long id, BigDecimal price, long holdMillis) {
        products.changePrice(id, price);      // 內層：@CacheEvict + @Transactional（加入外層交易）
        Thread.sleep(holdMillis);             // 訂單流程剩下的部分還要跑 800 毫秒
    }
}
```

**內層的 `@CacheEvict` 會立刻執行**（它的交易只是加入外層，沒有提交），
但**外層交易還要 800 毫秒才提交**。

```
═══ 7.7.4 外層交易 + @CacheEvict（transactionAware = false）═══
  先把快取填起來：價 = 100.00
   305 ms  外層交易進行中：快取 = 已經被清掉
   356 ms  這時有人來查，他看到 100.00（資料庫其實已經改成 9999，只是還沒提交）
  1018 ms  交易提交之後：快取 = 還在（值 = 100.00）
  最終：快取價 = 100.00，資料庫價 = 9999.00
```

**又是 stale forever**，而且這次的縫寬 = **整個外層交易的長度**。

**修法：讓 `CacheManager` 感知交易。**

```java
manager.setTransactionAware(true);     // 或 RedisCacheManager.builder(...).transactionAware()
```

它做的事：**把 `evict` / `put` 延後到交易提交之後才執行**
（底層是 `TransactionSynchronizationManager.registerSynchronization`，交易回滾就不做）。

```
═══ 7.7.4 外層交易 + @CacheEvict（transactionAware = true）═══
  先把快取填起來：價 = 100.00
   305 ms  外層交易進行中：快取 = 還在
   351 ms  這時有人來查，他看到 100.00（資料庫其實已經改成 9999，只是還沒提交）
  1025 ms  交易提交之後：快取 = 已經被清掉
  最終：快取價 = 9999.00，資料庫價 = 9999.00
```

| | `transactionAware = false` | `transactionAware = true` |
|---|---|---|
| 交易進行中，別人讀到 | 舊值 `100` | 舊值 `100`（**一樣**） |
| 交易提交之後 | **舊值 `100`，永遠** | **新值 `9999`** ✅ |
| 交易回滾時 | 快取已經被清掉了（多一次 miss） | 不清 ✅ |

> 📌 **看清楚它解決了什麼、沒解決什麼**：
> - ✅ **它讓狀態收斂**——交易期間仍然讀得到舊值（這是交易隔離的必然），
>   但**提交之後一定會清掉**。
> - ❌ **它不能消除 7.7.3 那個競態**。
>   讀者「讀完 DB、還沒寫快取」的空隙照樣存在，
>   只是把窗口從「整個交易」縮短到「提交那一瞬間」。
>
> ⚠️ **另外注意**：`transactionAware` 只在**有交易的時候**才延後。
> 沒有 `@Transactional` 的方法，它的行為完全沒變。

### 7.7.5 所以順序該怎麼排

四種寫法，只有兩種可以用：

| 寫法 | 問題 |
|---|---|
| ① **先清快取，再更新資料庫** | ❌ **最糟**。清完到更新完之間，任何讀者都會把**舊值**寫回快取（7.7.3 的加強版） |
| ② **先更新資料庫，再清快取** | ✅ **標準做法**。剩下的競態就是 7.7.3，窗口很窄 |
| ③ **先更新資料庫，再更新快取**（`@CachePut`） | ⚠️ 兩個寫者並行時，**快取的順序可能跟資料庫相反**（A 先寫 DB、B 後寫 DB，但 B 先寫快取） |
| ④ **②＋延遲雙刪** | ✅ 收窄 7.7.3 的窗口（見下） |

**延遲雙刪**：

```java
@Transactional
public void changePrice(Long id, BigDecimal price) {
    cache.evict(id);                   // 第一次刪（可選，主要是為了讓交易期間的讀者少一次髒讀）
    repo.updatePrice(id, price);
}
// 交易提交之後，延遲一小段時間再刪一次
TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
    @Override public void afterCommit() {
        scheduler.schedule(() -> cache.evict(id), 500, TimeUnit.MILLISECONDS);   // 第二次刪
    }
});
```

**第二次刪的目的**：把 7.7.3 那個「讀者在空隙裡寫回舊值」的結果**擦掉**。
延遲時間要**大於「一次查詢的耗時」**（p99，不是平均）。

> ⚠️ **延遲雙刪不是保證，是機率工程。**
> 讀者比你的延遲更慢，它一樣會把舊值寫回去。
> **要真正的保證，只有三條路**：
> ① 資料變更走**變更日誌**（binlog / CDC）去失效快取——順序由資料庫保證。
> ② **加分散式鎖**（09 章）：讀與寫互斥。代價是讀也要拿鎖。
> ③ **不要求強一致**，用**短 TTL** 讓它自己收斂——**大部分業務選這一條**。

### 7.7.6 一張決策表

| 你的資料 | 建議 |
|---|---|
| 商品描述、分類、文章內容 | ② 先更新 DB 再清快取 + `transactionAware` + 10～30 分鐘 TTL。**不一致幾秒鐘沒關係** |
| 價格、庫存顯示 | ② + **延遲雙刪** + **短 TTL（1～5 分鐘）** |
| **扣庫存、餘額、對帳** | **❌ 不要用 `@Cacheable`。** 這是 09、12 章的題目（鎖與原子操作） |
| 使用者權限、黑名單 | ② + **主動失效必須成功**（失敗要重試／告警）+ 短 TTL |
| 列表、搜尋結果 | **不要試著精準失效**，用 30～120 秒 TTL（7.4.3） |

> 📌 **這張表的分界線是**：
> **`@Cacheable` 是一個「讀多寫少、而且可以短暫不一致」的工具。**
> 需要「絕對正確」的資料不該進快取——**它們需要的是鎖，不是快取。**

---

## 7.8 三種災難

| | 一句話 | 打到誰 | 對策 |
|---|---|---|---|
| **穿透** | 查一個**根本不存在**的東西 | 資料庫（每次都打） | 快取 null + 存在性過濾器 |
| **擊穿** | 一個**熱門 key 剛好過期** | 資料庫（瞬間一大批） | `sync` / 分散式鎖 / 邏輯過期 |
| **雪崩** | **一大批 key 同時過期**，或 Redis 整台掛 | 資料庫（全部） | TTL 抖動 / 多級快取 / 降級（08 章） |

### 7.8.1 穿透

**① 同一個不存在的 id 被查 1000 次**

```
═══ 7.8.1 ① 同一個不存在的 id 被查 1000 次 ═══
不快取 null（unless="#result == null"）: 資料庫被打了 1,000 次
快取 null（預設行為）                    : 資料庫被打了     1 次
Redis 裡那一筆 : ....sr.+org.springframework.cache.support.NullValue...........xp
```

**1000 → 1。** 這就是為什麼本站選擇「允許快取 null」（7.5.3）。

**② 每次換一個不存在的 id——這才是真正的穿透攻擊**

```
═══ 7.8.1 ② 每次換一個不存在的 id（這才是真正的穿透攻擊）═══
快取 null 也救不了 : 資料庫被打了 1,000 次
而且 Redis 裡多了 1,000 個垃圾 key
  ↑ 攻擊者只要一直換 id，就能同時打爆資料庫「並且」把你的 Redis 塞滿（04 章的驅逐）
```

> ⚠️ **快取 null 擋得住「熱門的不存在」，擋不住「隨機的不存在」。**
> 而且它讓情況變成**兩個**問題：
> ① 資料庫照樣被打滿；
> ② **Redis 被灌進大量垃圾 key** → 記憶體到上限 → **開始驅逐你真正有用的資料**
> （04 章 4.3、以及 00 章 0.3.2 那個「購物車自己不見了」的事故）。

**③ 用 Bitmap 當存在性過濾器**（02 章 2.9.1 那個省 242 倍的東西）

```java
// 啟動時（或資料變更時）把所有存在的 id 打進一個 bitmap
for (Product p : repo.findAll()) srt.opsForValue().setBit("shop:product:exists", p.getId(), true);

// 查詢前先問一句
if (Boolean.FALSE.equals(srt.opsForValue().getBit("shop:product:exists", id))) {
    return null;       // 一定不存在，連快取都不用查
}
```

```
═══ 7.8.1 ③ 用 Bitmap 當存在性過濾器（02 章 2.9.1）═══
bitmap 佔用 : 127 bytes（涵蓋 id 0～1015）
1000 次隨機不存在的查詢 : 擋下 1,000 次，資料庫被打了 0 次，Redis 多了 0 個 key
真實存在的 id 照樣查得到 : Product[1010, 商品-1010, 100.00, stock=100]，資料庫被打了 10 次
```

**0 次資料庫查詢、0 個垃圾 key。**

| 方案 | 適用 | 記憶體 | 限制 |
|---|---|---|---|
| **Bitmap**（id 是連續整數時） | 商品、訂單、使用者 id | **1000 萬個 id = 1.25 MB** | ⚠️ id 稀疏時會很浪費（02 章 2.9.2）；**刪除要記得 `SETBIT ... 0`** |
| **布隆過濾器**（id 不是整數時） | UUID、帳號、手機號 | 1000 萬筆、1% 誤判 ≈ 11 MB | ⚠️ **會誤判「存在」**（放行少量穿透，可接受）；**不支援刪除** |
| 快取 null | 熱門的不存在 | 64 bytes / 筆 | ⚠️ 擋不住隨機 id |

> 📌 **三者是疊加的，不是二選一**：
> **過濾器擋掉「一定不存在」→ 快取 null 擋掉「查得很頻繁的不存在」→ 剩下的才進資料庫。**
> Redis 沒有內建布隆過濾器（要 RedisBloom 模組），
> 但 id 是自增整數的話 Bitmap 就夠用了，而且它是原生的。

### 7.8.2 擊穿：一個熱 key 過期，100 個請求同時撲上來

```
═══ 7.8.2 一個熱 key 剛好過期，100 個請求同時撲上來 ═══
（每次資料庫查詢固定 30 毫秒）
預設 @Cacheable（100 執行緒 / 1 個 key）    耗時    89 ms，資料庫被打了 100 次
sync = true   （100 執行緒 / 1 個 key）    耗時   104 ms，資料庫被打了   1 次

換成 10 個不同的 key（更像真實流量）：
預設 @Cacheable（100 執行緒 / 10 個 key）   耗時    47 ms，資料庫被打了 100 次
sync = true   （100 執行緒 / 10 個 key）   耗時   415 ms，資料庫被打了  10 次
```

**看第一組**：`sync = true` 把資料庫查詢從 100 次降到 1 次，代價幾乎是零。

**⚠️ 但看第二組**：**47 ms → 415 ms，慢了 8.8 倍。**

原因在 `RedisCache` 的原始碼：

```java
private final Lock lock = new ReentrantLock();       // ← 一個 cache 一把鎖

private <T> T getSynchronized(Object key, Callable<T> valueLoader) {
    lock.lock();
    try { ... } finally { lock.unlock(); }
}
```

> ⚠️ **那把鎖是 per-cache，不是 per-key。**
> 10 個不同的 key × 30 毫秒的查詢，被**排成一列**執行 = 300 毫秒起跳。
>
> **所以 `sync = true` 只適合「這個 cache 裡的 key 很少、但每一個都很熱」的情況**
> （例如首頁設定、全站公告、熱門商品 Top 10）。
> 一個放幾十萬個商品的 cache 開 `sync = true`，**你會把整台機器的查詢序列化。**

**而且 `sync = true` 還有兩個限制**：

| 限制 | 說明 |
|---|---|
| **只在一個 JVM 內有效** | 它是 `ReentrantLock`。**四台機器 = 四次資料庫查詢**。要跨機器就要**分散式鎖**（09 章） |
| 不能跟 `unless` 一起用 | Spring 會直接拒絕啟動：`@Cacheable(sync=true) does not support unless attribute` |

**三種擊穿對策**：

| 做法 | 資料庫查詢次數（4 台機器） | 代價 |
|---|---|---|
| 什麼都不做 | 每台 N 次 | —— |
| `sync = true` | **每台 1 次 = 4 次** | 同一個 cache 的載入被序列化 |
| **分散式鎖**（09 章） | **全站 1 次** | 多一次 Redis 往返；鎖本身要處理好（09 章整章） |
| **邏輯過期** | **0 次等待**（永遠回舊值，背景更新） | 一定會讀到舊資料；實作複雜 |

**邏輯過期**是這樣：value 裡存一個 `expireAt` 欄位、Redis 的 TTL 設成很長（或不設）。
讀到的時候如果 `expireAt` 過了，**照樣回傳舊值**，同時丟一個背景任務去更新。
**沒有任何請求需要等待**，代價是「過期後短時間內拿到的是舊值」。

> 📌 **選法**：
> 「熱門商品詳情頁」這種**可以短暫看到舊資料**的 → 邏輯過期。
> 「使用者權限」這種**不能拿舊的** → 分散式鎖。
> 「key 很少的全站設定」→ `sync = true` 就夠了。

### 7.8.3 雪崩：一千筆快取同時到期

```java
// ① 全部 TTL = 5 秒
cache("fixed",  (k, v) -> Duration.ofSeconds(5));
// ② TTL = 5 秒 + 隨機 0～5 秒
cache("jitter", (k, v) -> Duration.ofSeconds(5).plusMillis(ThreadLocalRandom.current().nextInt(5000)));
```

```
═══ 7.8.3 一千筆快取同時到期 ═══
① 全部 TTL = 5 秒（寫入 1000 筆）
      4.9 秒  還剩   500 筆   這 250 毫秒內過期   500 筆 █████████████████████████
      5.2 秒  還剩     0 筆   這 250 毫秒內過期   500 筆 █████████████████████████

② TTL = 5 秒 + 隨機 0～5 秒抖動（寫入 1000 筆）
      4.9 秒  還剩   999 筆   這 250 毫秒內過期     1 筆
      5.2 秒  還剩   966 筆   這 250 毫秒內過期    33 筆 █
      5.4 秒  還剩   906 筆   這 250 毫秒內過期    60 筆 ███
      5.7 秒  還剩   850 筆   這 250 毫秒內過期    56 筆 ██
      ...（中間每 250 毫秒平均 50 筆）
      9.8 秒  還剩    22 筆   這 250 毫秒內過期    59 筆 ██
     10.0 秒  還剩     0 筆   這 250 毫秒內過期    22 筆 █
```

| | 尖峰（每 250 毫秒） | 換算每秒 |
|---|---|---|
| 固定 TTL | **500 筆** | **2,000 次查詢／秒** |
| 加了抖動 | **62 筆** | 248 次查詢／秒 |

**尖峰降到 1/8，而總查詢次數完全一樣。**

```java
private static RedisCacheWriter.TtlFunction ttl(Duration base) {
    return (key, value) -> {
        if (value == null) return Duration.ofSeconds(30);         // 7.5.4
        long ms = base.toMillis();
        long jitter = ThreadLocalRandom.current().nextLong(-ms / 5, ms / 5);   // ±20%
        return Duration.ofMillis(ms + jitter);
    };
}
```

> 📌 **01 章 1.6.3（100 萬個 key 同時到期）已經從 Redis 那一側看過同一件事。**
> 這裡是從應用這一側看：**Redis 那邊是刪除尖峰，你這邊是資料庫查詢尖峰。**
>
> ⚠️ **「一大批 key 同時被寫入」是最常見的成因**：
> 服務重啟後的冷啟動（04 章 4.8.2）、批次預熱、7.6.3 的版本化改版。
> **只要是「一起寫進去的」，就會「一起過期」。**

**雪崩的另外兩種形態，以及它們的對策**：

| 形態 | 對策 | 哪一章 |
|---|---|---|
| 一批 key 同時過期 | **TTL 抖動** | 本節 |
| **Redis 整台掛掉** → 全部流量打到資料庫 | **降級 + 熔斷 + 本地快取兜底** | **08 章** |
| 冷啟動（重啟／改版後快取全空） | 預熱 + 灰度放流量 + 擊穿保護 | 04 章 4.8.2、7.8.2 |

> 📌 **「TTL 抖動」解決的是第一種，而第二種才是會讓整站掛掉的那種。**
> **08 章整章在處理它。**

### 7.8.4 三者怎麼分辨

拿到一個「資料庫突然被打爆」的現場，用這三個問題分辨：

```
① 被查的那些 key，資料庫裡有資料嗎？
     沒有 → 穿透（去看有沒有人在掃 id）
     有 ↓
② 是「同一個 key」被打爆，還是「很多 key」？
     同一個 → 擊穿（去看那個 key 的 TTL 剛好到了）
     很多   ↓
③ Redis 還活著嗎？
     活著 → 雪崩（一批 key 同時過期；去看它們的 TTL 是不是一樣）
     掛了 → 那不是快取問題，是 08 章的降級問題
```

---

## 7.9 落地：shop-service 的 `CacheConfig`

### 7.9.1 完整設定

```java
package com.example.lab10.shop.config;

@Configuration
@EnableCaching
public class CacheConfig {

    /** 前綴 = 環境 + 快取結構版本。改版只要把 v1 換成 v2，舊資料自然被繞過（7.6.3） */
    @Value("${lab10.cache.prefix:lab10:v1:}")
    private String prefix;

    @Value("${lab10.cache.transaction-aware:true}")
    private boolean transactionAware;

    @Bean
    public RedisCacheConfiguration defaultCacheConfiguration(ObjectMapper redisObjectMapper) {
        return RedisCacheConfiguration.defaultCacheConfig()
                .prefixCacheNameWith(prefix)                                   // 7.4.2
                .entryTtl(ttl(Duration.ofMinutes(30)))                         // 7.5.4 + 7.8.3
                .serializeKeysWith(SerializationPair.fromSerializer(new StringRedisSerializer()))
                .serializeValuesWith(SerializationPair.fromSerializer(
                        new GenericJackson2JsonRedisSerializer(redisObjectMapper)));   // 06 章 6.6.2
                // 刻意「不」呼叫 disableCachingNullValues()：本站要快取 null（7.5.3）
    }

    /**
     * 一個 TTL 函式包辦兩件事：
     *   ① null 用很短的 TTL —— 商品上架之後要很快查得到（7.5.4）
     *   ② 有值的那些加 ±20% 隨機抖動 —— 不要讓一大批 key 同時到期（7.8.3）
     * ⚠️ 參數順序是 (key, value)，而且 value 是原始的 null，不是 NullValue
     */
    private static RedisCacheWriter.TtlFunction ttl(Duration base) {
        return (key, value) -> {
            if (value == null) return Duration.ofSeconds(30);
            long ms = base.toMillis();
            long jitter = ThreadLocalRandom.current().nextLong(-ms / 5, ms / 5);
            return Duration.ofMillis(ms + jitter);
        };
    }

    @Bean
    public CacheManager cacheManager(RedisConnectionFactory factory,
                                     RedisCacheConfiguration defaultCacheConfiguration) {
        Map<String, RedisCacheConfiguration> perCache = Map.of(                // 7.4.3
                "products",     defaultCacheConfiguration.entryTtl(ttl(Duration.ofMinutes(30))),
                "productPage",  defaultCacheConfiguration.entryTtl(ttl(Duration.ofSeconds(60))),
                "productCount", defaultCacheConfiguration.entryTtl(ttl(Duration.ofSeconds(10))));

        FailSoftRedisCacheManager manager = new FailSoftRedisCacheManager(     // 7.6.4
                RedisCacheWriter.nonLockingRedisCacheWriter(factory),
                defaultCacheConfiguration, perCache);
        manager.setTransactionAware(transactionAware);                         // 7.7.4
        return manager;
    }
}
```

`FailSoftRedisCacheManager` 是 7.6.4 那個類別，放在同一個套件下。

⚠️ **注意 key 前綴在這一節變了**：7.3～7.6 的輸出都是 `lab10:cache:...`（7.4.1 那份設定），
從這裡開始變成 `lab10:v1:...`。**這本身就是 7.6.3 的版本化在動作**——
換掉前綴等於把之前那批快取整批繞過。重跑前面幾節的實驗時，
記得 `redis-cli` 上要找的是新的前綴。

⚠️ **`RedisCacheWriter` 有兩種**：

| | 說明 |
|---|---|
| `nonLockingRedisCacheWriter`（**預設**） | `clear()` 用 `SCAN` + 批次刪，**過程中別人照樣可以寫** |
| `lockingRedisCacheWriter` | `clear()` 期間會用一個 Redis key 當鎖，**擋住其他寫入** |

**本站用 non-locking。** locking 版的目的是讓 `allEntries = true` 的清除「乾淨一點」，
代價是清除期間所有寫入都要等——**而我們本來就不建議用 `allEntries = true`（7.3.3）。**

### 7.9.2 驗收

```
═══ 7.9.2 落地設定：驗收 ═══
① key 前綴（環境 + 版本）：
    lab10:v1:productCount::SimpleKey []     TTL =    12 秒
    lab10:v1:productPage::SimpleKey [0, 3]  TTL =    67 秒
    lab10:v1:products::5001                 TTL = 1,872 秒
    lab10:v1:products::5002                 TTL = 2,140 秒
    lab10:v1:products::5003                 TTL = 1,621 秒
    ...
    lab10:v1:products::999999               TTL =    30 秒
② TTL 抖動（10 筆 products，設定是 30 分鐘 ±20%）：
    最短 1486 秒，最長 2140 秒，差 654 秒
③ null 的 TTL : 30 秒
④ 讀不回來就當沒命中 : FailSoftRedisCacheManager 已啟用
```

五件事一起成立：**前綴帶版本、per-cache TTL、TTL 有抖動、null 的 TTL 是 30 秒、
反序列化失敗會降級成沒命中。**

### 7.9.3 本章的四條規約（接續 06 章 6.9.4 的第 12 條）

13. **`@Cacheable` 一律明寫 `key`**，不要用 `SimpleKey`（7.3.2）。
14. **`@Cacheable` 的回傳值不可以是 `List.of(...)` / `Stream.toList()`**——
    寫得進去、讀不回來（7.3.5、06 章規約 12）。
15. **`transactionAware = true`**，而且**先更新資料庫、再清快取**（7.7.4、7.7.5）。
16. **所有 TTL 都要有抖動，`null` 的 TTL 必須明顯更短**（7.5.4、7.8.3）。

### 7.9.4 三個該接告警的指標

| 指標 | 正常值 | 不正常代表 |
|---|---|---|
| **反序列化失敗次數**（7.6.4 的 fail-soft 記的） | **0** | 有人改了資料格式卻沒改版本前綴 |
| 快取命中率（`INFO stats` 的 `keyspace_hits / (hits+misses)`） | 看業務，通常 > 80% | 突然掉下來 = 雪崩或改版；**慢慢掉** = TTL 設太短或穿透 |
| 同一秒內的資料庫查詢尖峰 | 平穩 | 尖刺 = 擊穿或雪崩（7.8.4 那三個問題） |

---

## 7.10 常見誤區

**① 「加了 `@Cacheable` 就有快取了」**

同一個 bean 內部呼叫**完全無效**（7.2.3），而且沒有任何警告。

**② 「`@Cacheable` 讀不回來會自動去資料庫拿」**

**不會。** 它把 `SerializationException` 往上丟，變成 500，
而且那一筆會持續壞到 TTL 到期（7.6.1）。

**③ 「我在 06 章設好 `RedisTemplate` 的序列化器了，快取也會跟著用」**

**不會。** `RedisCacheConfiguration` 有自己的一份，**預設仍然是 JDK 序列化**（7.4.1）。

**④ 「`spring.cache.redis.time-to-live` 設了就生效」**

只有在**你沒有自己定義 `CacheManager`** 的時候（7.4.5）。定義了就全部失效，而且沒有警告。

**⑤ 「`@CacheEvict` 會在交易回滾時一起回滾」**

預設（`beforeInvocation = false`）是「**方法拋例外就不清**」——結果剛好是對的，
但原因不是「回滾」（7.7.2）。而 `transactionAware = false` 時，
**外層交易回滾了，內層已經清掉的快取不會回來**（7.7.4）。

**⑥ 「先清快取再更新資料庫比較安全」**

**最糟的順序**（7.7.5 ①）。清完到更新完之間的任何一次讀取，都會把舊值寫回快取。

**⑦ 「單執行緒測過了，快取邏輯沒問題」**

7.7.3 那個「stale forever」**在單執行緒下永遠不會發生**。
**快取一致性的 bug 只有併發測試測得出來。**

**⑧ 「TTL 到期前被讀到就會續期」**

不會（7.4.4）。所以**越熱門的 key 越會定期擊穿**。

**⑨ 「快取 null 就不怕穿透了」**

只擋得住「熱門的不存在」。**隨機 id 的攻擊照樣打滿資料庫，還順便塞爆 Redis**（7.8.1 ②）。

**⑩ 「`sync = true` 就解決擊穿了」**

它的鎖是 **per-cache 不是 per-key**（7.8.2）——10 個 key 的載入被排成一列，慢 8.8 倍。
而且**它只在一個 JVM 內有效**，四台機器就是四次查詢。

**⑪ 「`@CacheEvict(allEntries = true)` 很快」**

它是 `SCAN` + 批次刪（7.3.3 ②）。50 萬筆的 cache 清一次，就是 01 章 1.5 的那些代價。

**⑫ 「TTL 設一樣比較好管理」**

那是雪崩的定義（7.8.3）。**尖峰差 8 倍。**

---

## 7.11 本章小結

> **`@Cacheable` 的五行設定背後，是一個「你的資料在兩個地方、而它們不會自己同步」的系統。**

這一章的所有問題都可以歸成三類：

| 類別 | 這一章的哪幾節 | 共同形狀 |
|---|---|---|
| **抽象漏出來** | 7.2.3 自呼叫、7.3.2 `SimpleKey`、7.3.5 `.toList()`、7.4.5 yml 失效 | **你以為在設定 A，實際生效的是 B**，而且沒有警告 |
| **資料活得比程式碼久** | 7.5.4 null 的 TTL、7.6 改版 | **快取裡躺著三個月前的格式** |
| **兩份資料不同步** | 7.7 交易競態、7.8 三種災難 | **「讀出來、改、寫回去」中間有一道縫**（05 章 5.2） |

而第三類的根源，跟 05 章是同一句話：

> **「讀資料庫」與「寫快取」不是原子的。**
> 05 章在 Redis 內部用 Lua 封住了這道縫；
> **在「資料庫 + 快取」這個組合上，沒有 Lua 可以用**——
> 所以只剩三條路：**短 TTL 讓它收斂、變更日誌讓它有序、或者加鎖（09 章）。**

### 7.11.1 驗收清單

- [ ] 說出 `Cache.get()` 回 `null` 與「回一個裡面是 `null` 的 wrapper」的差別。
- [ ] 說出 `@Cacheable` 在同一個 bean 內部呼叫時為什麼無效，並給出建議的解法。
- [ ] 讀懂 `lab10:v1:productPage::SimpleKey [0, 3]` 這個 key 的每一段。
- [ ] 說出 `@Cacheable` / `@CachePut` / `@CacheEvict` 各自的執行時機。
- [ ] 說出 `RedisCacheConfiguration` 的**值序列化器預設是什麼**，以及它跟 `RedisTemplate` 的關係。
- [ ] 說出 `spring.cache.redis.*` 什麼時候會被忽略。
- [ ] 說出快取 `null` 存進 Redis 的是什麼，以及為什麼它不走你設定的序列化器。
- [ ] 說出 `TtlFunction` 的參數順序，以及判斷 null 時要寫什麼。
- [ ] 說出「改套件名」之後，那一筆快取會造成什麼現象、持續多久。
- [ ] **畫出 7.7.3 的時序圖**，並說出為什麼那個狀態會維持到 TTL 到期。
- [ ] 說出 `transactionAware = true` 解決什麼、**不**解決什麼。
- [ ] 分辨穿透、擊穿、雪崩，並各給一個對策與它的代價。
- [ ] 說出 `sync = true` 的鎖是 per-cache 還是 per-key，以及它跨不跨 JVM。

### 7.11.2 本章練習

**練習一（15 分鐘）**：把 7.3.5 那個 `.toList()` 的 bug 重現出來，
然後用三種方式各修一次：① 換成 `new ArrayList<>(...)`；
② 那個 cache 改用型別明確的 `Jackson2JsonRedisSerializer`；
③ 套上 7.6.4 的 fail-soft。
**記錄三種修法之後，「第二個請求」分別發生什麼事。**

**練習二（20 分鐘）**：把 7.7.3 的競態**重現十次**，統計成功重現幾次。
接著把 `findByIdSlow` 的延遲從 800 毫秒改成 **50 毫秒**，再跑十次。
**這就是「這個 bug 在你的系統上有多容易發生」的量化方法。**

**練習三（20 分鐘）**：實作 7.7.5 的**延遲雙刪**，然後用練習二的方法量它。
延遲分別設 100 / 500 / 2000 毫秒，記錄各自的重現率。
⚠️ **你應該會發現它永遠無法降到 0**——想清楚為什麼，並寫下一句話。

**練習四（25 分鐘）**：用 7.8.2 的方法量你自己的系統。
建一個有 **1000 個 key** 的 cache，開 `sync = true`，
用 200 個執行緒隨機打 100 個不同的 key。
**跟關掉 `sync` 的版本比較「總耗時」與「資料庫查詢次數」**，
然後回答：**在什麼命中率之下，`sync = true` 是划算的？**

**練習五（進階，30 分鐘）**：實作 7.8.2 的**邏輯過期**。
value 包一層 `{"expireAt": ..., "data": {...}}`，Redis TTL 設成邏輯過期時間的 3 倍。
讀到過期的值時**立刻回傳舊值**，同時丟一個背景任務去更新。
**驗證：100 個執行緒在 key 邏輯過期的瞬間打進來，沒有任何一個需要等 30 毫秒的查詢。**

**練習六（進階，30 分鐘）**：把 7.8.1 的 Bitmap 過濾器接進 `ProductService`，
並處理兩件課文沒做的事：① **商品下架時要把那一位清成 0**；
② **id 不連續時（例如 id 從 10000000 開始）Bitmap 會佔多少記憶體**——
實測一次，然後用 02 章 2.9.2 的稀疏陷阱解釋它。

---

## 7.12 下一章預告

這一章一直在小心地避開一句話：**「如果 Redis 掛了呢？」**

- 7.6.4 的 fail-soft 只處理「讀不回來」，**不處理「讀不到」**。
- 7.8.3 的 TTL 抖動只處理「一批 key 同時過期」，**不處理「所有 key 一起消失」**。
- 06 章 6.8.4 已經量過：Redis 停掉之後，**每個請求還是會等滿 500 毫秒**才失敗。

把這三件事放在一起：

```
Redis 掛掉
  → 每個請求在快取上多花 500 ms（06 章 6.8.4）
  → 每個請求都變成快取沒命中 → 全部打到資料庫（7.8.3 的第二種雪崩）
  → 資料庫 QPS 變成平常的 20 倍 → 資料庫也掛了
  → 這時候 Redis 就算救回來，快取還是空的 → 一恢復又被打爆
```

**08 章處理這條鏈上的每一環**：

- `@Cacheable` 遇到 Redis 掛掉時**預設的行為是什麼**（會不會直接 500）。
- `CacheErrorHandler`：讓快取故障變成「沒有快取」而不是「服務失敗」。
- **熔斷**：為什麼「每個請求等 500 毫秒」還是太久，以及 06 章那個 `REJECT_COMMANDS` 該在什麼時候打開。
- **降級開關**：哪些 API 該回舊資料、哪些該直接回 503、哪些該擋住不讓它打資料庫。
- 以及一份**「把 Redis 拔掉 60 秒」的演練腳本**——
  這一站的產出清單裡那份降級報告，就是在 08 章寫出來的。
