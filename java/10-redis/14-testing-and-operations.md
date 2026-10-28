# 第 14 章：測試與維運

> 前面十四章，每一章都有一堆 ⚠️。
> **這一章只問一個問題：那些 ⚠️，怎麼讓它在上線之前就變成一個紅色的測試？**
>
> 先看四個實測，它們都是「測試是綠的，但什麼都沒測到」：
>
> | | 現象 | 節 |
> |---|---|---|
> | ① `@DataRedisTest` ＋ `@Cacheable` | 呼叫 3 次，**查了 3 次資料庫**——快取完全沒生效，測試通過 | 14.4.2 |
> | ② 測試方法上加 `@Transactional` | **20 個子執行緒全部失敗**，測試執行緒看到 `orders = 0`，測試通過 | 14.5.3 |
> | ③ 執行緒池只有 4 條 | 同一個超賣 bug，量到 **137 件**；正確的 harness 量到 **175 件** | 14.5.2 |
> | ④ 共用容器沒有清資料 | 測試二讀到測試一寫的 `cart:u1 = 3`，**而它以為自己面對的是空的 Redis** | 14.5.4 |
>
> 然後是好消息。**13 章那一整章的東西，在 CI 裡跑起來只要這麼久：**
>
> | | 耗時 |
> |---|---|
> | 起一組三節點 **Redis Cluster**，驗證 16384 個槽 ＋ 四個 `CROSSSLOT` 測試 | **3.9 秒** |
> | 起一組 **Sentinel**（1 主 1 從 3 哨兵），`kill -9` master，驗證客戶端 4 秒內恢復 | **7.9 秒** |
> | 這一章全部 **36 個測試** | **32.9 秒** |
>
> 📌 **「測 Redis 很麻煩」在 2017 年是真的，現在不是了。**

---

## 14.1 學習目標

完成本章後，你應該可以：

- 用 Testcontainers 起一台真的 Redis，並說出 `@ServiceConnection` 省掉了什麼（14.2.2）。
- ⚠️ 說出 `@Container` 少一個 `static` 的代價（實測 **2.4 倍**），以及單例容器解決什麼（14.2.3、14.2.4）。
- ⚠️ 診斷「Testcontainers 說找不到 Docker」——含 Docker Engine 29 的那個 400（14.2.5）。
- 說出 embedded Redis 為什麼不推薦，並拿得出證據（14.3）。
- ⚠️ 說出 `@DataRedisTest` 載入了什麼、**沒有**載入什麼，以及它為什麼會讓快取測試變成假的（14.4）。
- 寫出一個**真的測得出超賣**的併發 harness，並說出三種寫法量到的數字為什麼不一樣（14.5.2）。
- ⚠️ 說出為什麼併發測試上面絕對不能加 `@Transactional`（14.5.3）。
- 把 13 章的 Cluster 與 Sentinel 演練寫成 CI 裡的測試，包含**「要求它失敗」**的測試（14.6）。
- 接上 Lettuce 的延遲指標，並分辨 `firstresponse` 與 `completion` 的差（14.7.1）。
- ⚠️ 認得連線池耗盡的那一行例外（14.7.2）。
- 在 Java 端量出 big key 的三個症狀，並寫一支找出 big key 的巡檢（14.8）。
- 逐條走完上線檢查清單，每一條都對得上前面某一節的實測（14.9）。

---

## 14.2 Testcontainers：讓測試真的跑一台 Redis

### 14.2.1 三行程式

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-testcontainers</artifactId>
  <scope>test</scope>
</dependency>
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>junit-jupiter</artifactId>
  <scope>test</scope>
</dependency>
```

最傳統的寫法（Boot 3.1 之前只能這樣）：

```java
@SpringBootTest
@Testcontainers
class A1_DynamicPropertyTest {

    @Container
    static final GenericContainer<?> REDIS =
            new GenericContainer<>(DockerImageName.parse("redis:7.2")).withExposedPorts(6379);

    @DynamicPropertySource                       // ← 把容器的隨機 port 塞回 Spring
    static void redisProps(DynamicPropertyRegistry r) {
        r.add("spring.data.redis.host", REDIS::getHost);
        r.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
    }

    @Autowired StringRedisTemplate redis;

    @Test
    void 真的連到那台容器() {
        redis.opsForValue().set("a1", "hello");
        assertThat(redis.opsForValue().get("a1")).isEqualTo("hello");
    }
}
```

```
[A1] 容器 = redis:7.2  對外 port = 51226
[A1] redis_version = 7.2.16
Tests run: 1, Failures: 0, Errors: 0, Time elapsed: 4.385 s
```

📌 **注意 `redis_version = 7.2.16`。** 這是這一站從 00 章開始用的同一個版本——
**你的測試跑的是正式環境的那個 Redis，不是一個「像 Redis 的東西」。**
這一句話就是 14.3 整節的內容。

⚠️ **`getMappedPort()` 是隨機的**（這次是 51226）。這是刻意的設計：
**CI 上會有十幾個 job 同時跑，固定 port 一定會撞。**
14.6.2 會講到「有些東西不得不固定 port」，以及那時候要付什麼代價。

### 14.2.2 `@ServiceConnection`：Boot 3.1 之後不用再寫 `@DynamicPropertySource`

```java
@SpringBootTest
@Testcontainers
class A2_ServiceConnectionTest {

    @Container
    @ServiceConnection                  // ← 這一行取代上面整個 @DynamicPropertySource
    static final GenericContainer<?> REDIS =
            new GenericContainer<>(DockerImageName.parse("redis:7.2")).withExposedPorts(6379);

    @Autowired StringRedisTemplate redis;

    @Test
    void 不用寫任何_property_也連得上() {
        redis.opsForValue().set("a2", "hello");
        assertThat(redis.opsForValue().get("a2")).isEqualTo("hello");
    }
}
```

**它怎麼知道這是 Redis？** 靠 image 名稱。Boot 內建一張對照表
（`RedisContainerConnectionDetailsFactory` 認得 `redis`、`redis/redis-stack`、`redis/redis-stack-server`）。

⚠️ **如果你的 image 名字不是這些**（例如公司的私有 registry `harbor.corp/infra/redis:7.2`），
`@ServiceConnection` **認不出來**，要明著告訴它：

```java
@Container
@ServiceConnection(name = "redis")      // ← 明著說「請當成 redis」
static final GenericContainer<?> REDIS =
        new GenericContainer<>(DockerImageName.parse("harbor.corp/infra/redis:7.2")
                .asCompatibleSubstituteFor("redis"))       // ← 這一行也常常要加
                .withExposedPorts(6379);
```

📌 **`@ServiceConnection` 的好處不只是少寫幾行**：它產生的是
`RedisConnectionDetails` bean，**優先權高於 `spring.data.redis.*`**。
所以就算你的 `application.yml` 裡寫死了正式環境的位址，測試也不會連過去。
**`@DynamicPropertySource` 做不到這件事**——它只是覆寫 property，
碰到 `@TestPropertySource` 或 profile 裡更高優先權的設定就會被蓋掉。

### 14.2.3 ⚠️ 少一個 `static`，測試慢 2.4 倍

這是 Testcontainers 最常見的一個錯誤，而且它不會報錯：

```java
@Testcontainers
class A3_PerMethodContainerTest {

    @Container                                   // ⚠️ 少了 static
    GenericContainer<?> redis = new GenericContainer<>(DockerImageName.parse("redis:7.2"))
            .withExposedPorts(6379);

    @Test void 測試一() { report(); }
    @Test void 測試二() { report(); }
    // … 共 5 個測試
}
```

```
═══ 14.2.3 @Container 有沒有 static，差多少 ═══

  ⚠️ 沒有 static（每個 @Test 一台）           ✅ 有 static（整個類別一台）
  第 1 個測試  容器 a1076719  累計   761 ms    第 1 個測試  容器 cbcf00bf  累計 727 ms
  第 2 個測試  容器 ac338907  累計 1,129 ms    第 2 個測試  容器 cbcf00bf  累計 731 ms
  第 3 個測試  容器 4b43467f  累計 1,488 ms    第 3 個測試  容器 cbcf00bf  累計 733 ms
  第 4 個測試  容器 bfc72acd  累計 1,814 ms    第 4 個測試  容器 cbcf00bf  累計 734 ms
  第 5 個測試  容器 bbbf3ea7  累計 2,155 ms    第 5 個測試  容器 cbcf00bf  累計 735 ms
  ───────────────────────────────────────    ───────────────────────────────────────
  類別總耗時 2,318 ms                          類別總耗時   956 ms      ← 快 2.4 倍
  每個測試多 ~350 ms                           每個測試多 ~2 ms
```

📌 **規則很簡單：**

| | 生命週期 |
|---|---|
| `@Container` **有** `static` | 整個測試類別一台（`@BeforeAll` 起、`@AfterAll` 關） |
| `@Container` **沒有** `static` | ⚠️ **每一個 `@Test` 一台**（`@BeforeEach` 起、`@AfterEach` 關） |

⚠️ **「每個測試多 350 毫秒」在 5 個測試時看不出來。**
一個真實專案有 300 個 Redis 相關的測試——**那是多出來的 105 秒**，
而且它會被歸因成「Testcontainers 很慢」。

### 14.2.4 單例容器：連 Spring context 一起共用

`static` 只解決了「同一個類別」。**不同的測試類別之間呢？**

```java
// ⚠️ A5a：每個測試類別自己宣告一個容器
@SpringBootTest @Testcontainers
class A5a_Own1Test {
    @Container @ServiceConnection
    static GenericContainer<?> redis = new GenericContainer<>(...);
}
```

```
[A5a-Own1] container=8ef6b793  context=2629d5dc
[A5a-Own2] container=2d6eb8c1  context=6da640fe     ⚠️ 兩個容器、兩個 Spring context
兩個測試類別總耗時 6.565 s
```

⚠️ **請注意「兩個 Spring context」比「兩個容器」貴得多。**
Spring 的 `TestContext` 框架會依「context 設定的組合」快取 ApplicationContext；
**容器 port 不一樣 → property 不一樣 → context 快取 miss → 整個 Spring Boot 重新啟動一次。**

✅ **單例容器（singleton container pattern）**：

```java
public abstract class AbstractRedisIT {

    protected static final GenericContainer<?> REDIS =
            new GenericContainer<>(DockerImageName.parse("redis:7.2")).withExposedPorts(6379);

    static {                       // ⚠️ 手動 start()，不要用 @Container
        REDIS.start();             //    JUnit 不會關它，JVM 結束時由 Ryuk 收掉
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.data.redis.host", REDIS::getHost);
        r.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
    }
}

@SpringBootTest
class A5b_Shared1Test extends AbstractRedisIT { … }

@SpringBootTest
class A5b_Shared2Test extends AbstractRedisIT { … }
```

```
[A5b-Shared2] container=4842a22b  context=7af3874e
[A5b-Shared1] container=4842a22b  context=7af3874e     ✅ 同一個容器、同一個 context
兩個測試類別總耗時 4.990 s
```

| | 容器 | Spring context | 兩個類別總耗時 |
|---|---|---|---|
| 各自宣告 | 2 個 | ⚠️ **2 個** | 6,565 ms |
| 單例容器 | 1 個 | ✅ **1 個** | **4,990 ms** |

📌 **只有兩個類別就差 1.5 秒，而它是線性成長的。**

⚠️ **代價是：所有測試共用同一台 Redis 的資料。** 14.5.4 會處理這件事。

> 📌 **為什麼 `static {}` 區塊裡 `start()` 之後不用 `stop()`？**
> Testcontainers 會起一個叫 **Ryuk** 的 sidecar 容器，它盯著你的 JVM；
> JVM 一結束，Ryuk 就把這次測試起的所有容器收掉。
> ⚠️ **某些 CI 環境（特權容器受限、或 rootless Docker）Ryuk 起不來**，
> 這時要設 `TESTCONTAINERS_RYUK_DISABLED=true`，並自己負責清理。

### 14.2.5 ⚠️ 「Could not find a valid Docker environment」

這是 Testcontainers 最常見的求助訊息，而且它的原因每次都不一樣。
**下面是其中一種**，值得完整記下來：

```
ERROR org.testcontainers.dockerclient.DockerClientProviderStrategy
  -- Could not find a valid Docker environment. Please check configuration.
     Attempted configurations were:
     UnixSocketClientProviderStrategy: failed with exception
        BadRequestException (Status 400: {"ID":"","Containers":0, … })
     DockerDesktopClientProviderStrategy: failed with exception
        BadRequestException (Status 400: … )
```

⚠️ **注意它說的是 `Status 400`，不是「連不上」。** 連得上，只是**講不通**。
直接打 Docker 的 API 就看得出來：

```bash
$ curl -s --unix-socket ~/.docker/run/docker.sock http://localhost/version
{"Platform":{"Name":"Docker Desktop 4.56.0"},"Version":"29.1.3",
 "ApiVersion":"1.52","MinAPIVersion":"1.44", … }
                     ↑                ↑
              伺服器支援到 1.52    ⚠️ 但它最低只接受 1.44

$ curl -s --unix-socket ~/.docker/run/docker.sock http://localhost/v1.43/info -o /dev/null -w '%{http_code}\n'
400                              ← Testcontainers 用的就是這種舊版本
$ curl -s --unix-socket ~/.docker/run/docker.sock http://localhost/v1.44/info -o /dev/null -w '%{http_code}\n'
200
```

📌 **根因：Docker Engine 29 把 `MinAPIVersion` 拉到 1.44，
而 Testcontainers 1.19.x / 1.20.x 底下的 docker-java 預設協商到更舊的版本。**

**解法（實測過三種，只有一種有效）：**

```bash
# ❌ 無效：docker CLI 的環境變數，docker-java 不讀它
DOCKER_API_VERSION=1.44 mvn test

# ❌ 無效：升級 Testcontainers 1.19.7 → 1.20.6 也一樣
<testcontainers.version>1.20.6</testcontainers.version>

# ✅ 有效：docker-java 讀的是 JVM system property `api.version`
mvn test -DargLine="-Dapi.version=1.44"
```

固定寫進 `pom.xml`：

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration>
    <!-- ⚠️ Docker Engine 29+ 的 MinAPIVersion 是 1.44，docker-java 預設協商到更舊的版本 -->
    <argLine>-Dapi.version=1.44</argLine>
  </configuration>
</plugin>
```

**其他常見原因的對照表：**

| 症狀 | 原因 | 處理 |
|---|---|---|
| `Status 400` + 一堆空欄位的 JSON | ⚠️ **API 版本協商失敗**（上面那個） | `-Dapi.version=1.44` |
| `Connection refused` | Docker Desktop 沒開 | —— |
| socket 路徑找不到 | macOS 上是 `~/.docker/run/docker.sock`，不是 `/var/run/docker.sock` | `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` |
| CI 上 `permission denied` | runner 使用者不在 `docker` group | —— |
| Ryuk 起不來 | 特權容器受限 / rootless | `TESTCONTAINERS_RYUK_DISABLED=true` |
| 抓不到 image | 離線 / 私有 registry | 先 `docker pull`，或設 `imagePullPolicy` |

📌 **這一節的重點不是那個 400，是「診斷順序」：**

```
   ① 先確認 docker CLI 能用            docker ps
   ② 再確認 socket 位置                docker context ls
   ③ 再直接打 API 看版本                curl --unix-socket … /version
   ④ 最後才去看 Testcontainers 的設定
```

**因為 Testcontainers 的錯誤訊息永遠是「找不到 Docker」，
而真正的原因有六種。**

### 14.2.6 容器重用：省的是啟動時間，付的是乾淨

```java
new GenericContainer<>(DockerImageName.parse("redis:7.2"))
        .withExposedPorts(6379)
        .withReuse(true);                    // ← 測試結束後不關掉，下次直接接上
```

⚠️ **這個設定預設是「被忽略」的。** 要真的生效，開發者還得在自己的
`~/.testcontainers.properties` 裡加一行：

```properties
testcontainers.reuse.enable=true
```

**這個「兩段式開關」是刻意的設計：**

| | 本機開發 | CI |
|---|---|---|
| `withReuse(true)` | ✅ 建議開。一天跑 50 次測試，省下 50 次啟動 | ❌ **不要開** |
| 為什麼 CI 不要 | | 每次 build 都必須從乾淨狀態開始；重用會讓「上一次 build 的資料」洩漏到這一次 |

📌 **所以：`withReuse(true)` 寫在程式裡沒關係，CI 上不設那個 property 就不會生效。**
⚠️ **但重用的容器不會自動清資料**——14.5.4 的資料污染問題會從「同一次測試之內」
放大到「不同天的測試之間」。

---

## 14.3 ⚠️ embedded Redis：直接跑一次看看

「不想依賴 Docker」的替代方案是 embedded Redis。最多人用的是
`it.ozimov:embedded-redis`。在 2026 年的 Mac 上跑一次：

```java
@Test
void 試著起一台_embedded_redis() {
    RedisServer server = RedisServer.builder().port(16399).setting("maxmemory 64M").build();
    server.start();
    // …
}
```

```
[C1] ❌ 起不來：java.lang.RuntimeException
[C1]    Can't start redis server. Check logs for details. Redis process log:
```

**為什麼？打開那個 jar 看就知道了：**

```bash
$ unzip -l embedded-redis-0.7.3.jar | grep redis-server
   806944  06-11-2020   redis-server-2.8.19.app      ← macOS
  3335218  06-11-2020   redis-server-2.8.19-32       ← Linux 32-bit
  1392640  06-11-2020   redis-server-2.8.19.exe      ← Windows
  4236300  06-11-2020   redis-server-2.8.19          ← Linux 64-bit

$ file redis-server-2.8.19.app
redis-server-2.8.19.app: Mach-O 64-bit executable x86_64        ← ⚠️ Intel，不是 ARM
```

⚠️ **兩個問題，每一個都是致命的：**

**① 它是 Redis 2.8.19（2014 年 12 月）。** 這一站教的東西，一半它沒有：

| 你在哪一章學的 | 需要的版本 | 2.8 有嗎 |
|---|---|---|
| `UNLINK`（01 章 1.3.2） | 4.0 | ❌ |
| `MEMORY USAGE`（02 章、14.8） | 4.0 | ❌ |
| LFU 淘汰策略（04 章 4.3） | 4.0 | ❌ |
| listpack 編碼與轉換門檻（02 章 2.8） | 7.0 | ❌ |
| Streams | 5.0 | ❌ |
| ACL、`CLIENT NO-EVICT` | 6.0 | ❌ |
| Cluster 的大部分行為（13 章） | —— | ❌ 幾乎不能用 |

**② macOS 的那個二進位檔是 x86_64。** Apple Silicon 上它需要 Rosetta，
而 `RedisServer.start()` 只會告訴你 `Can't start redis server`。

📌 **這一節的結論不是「embedded Redis 是爛東西」**——它在 2016 年是個好主意。
**結論是：你的測試環境跟正式環境的 Redis 版本不一樣，
就等於你的測試沒有測到「版本相關的行為」，而 Redis 的版本相關行為非常多。**

| | Testcontainers | embedded Redis |
|---|---|---|
| Redis 版本 | ✅ **跟正式環境一模一樣**（你自己指定） | ⚠️ 2.8.19，動不了 |
| 起一台要多久 | 0.7～1 秒（image 已在本機） | ~0.2 秒 |
| Cluster / Sentinel | ✅ 可以（14.6） | ❌ |
| Apple Silicon | ✅ | ❌ |
| 需要 Docker | ⚠️ 是 | 否 |

⚠️ **唯一還值得考慮 embedded 的場景**：CI 環境真的給不了 Docker
（某些受管制的內網 build agent）。**那種情況下，正確的做法是
「單元測試用 mock，整合測試在另一個有 Docker 的環境跑」，
而不是用一台 2014 年的 Redis 假裝有測過。**

---

## 14.4 `@DataRedisTest` 的限制

### 14.4.1 它載入了什麼

`@DataRedisTest` 是 Boot 的「切片測試」（slice test）之一：只載入 Redis 相關的自動設定，
啟動比 `@SpringBootTest` 快很多。實際量一下它給了你什麼：

```java
@DataRedisTest
class B1_DataRedisTestScopeTest {
    static final GenericContainer<?> REDIS = new GenericContainer<>(DockerImageName.parse("redis:7.2"))
            .withExposedPorts(6379);
    static { REDIS.start(); }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) { … }

    @Autowired StringRedisTemplate redis;
    @Autowired ApplicationContext ctx;
    // …
}
```

```
[B1] bean 總數 = 60                             ← @SpringBootTest 通常是好幾百個
[B1] stringRedisTemplate           → true
[B1] redisTemplate                 → true
[B1] redisConnectionFactory        → true
[B1] ProductCacheService           → ❌ 沒有      ← ⚠️ @Service 不會被掃進來
[B1] StockService                  → ❌ 沒有
[B1] CacheManager                  → ✅ 有        ← ⚠️ 但它是什麼，見 14.4.2
[B1] EntityManagerFactory          → ❌ 沒有      ← JPA 不在這個切片裡
```

📌 **`@DataRedisTest` 適合測的東西只有一類：**

```
  ✅ 自訂的 RedisSerializer（06 章 6.5）—— 寫進去、讀回來、換個版本再讀一次
  ✅ 自訂的 Repository（Spring Data Redis 的 @RedisHash）
  ✅ 一段 Lua 腳本的行為（05、09、10、12 章）
  ✅ key 的命名規則
  ⚠️ 其他全部都不適合，因為你的 @Service 不在裡面
```

### 14.4.2 ⚠️ `@Cacheable` 完全沒生效，而且測試是綠的

「那我把 `@Service` 用 `@Import` 補進來不就好了？」——試試看：

```java
@DataRedisTest
@Import(ProductCacheService.class)          // ← 把那個 @Cacheable 的 service 補進來
class B2_CacheableNotWorkingTest {
    @Autowired ProductCacheService svc;

    @Test
    void 呼叫三次_看資料庫被打幾次() {
        svc.resetHits();
        svc.loadName(1L); svc.loadName(1L); svc.loadName(1L);
        System.out.println("實際查資料庫 " + svc.dbHits() + " 次");
    }
}
```

```
[B2] bean 實際型別 = lab14.ProductCacheService$$SpringCGLIB$$0      ← ⚠️ 它「有」被代理
[B2] CacheManager  = org.springframework.cache.support.NoOpCacheManager   ← ⚠️ 但是……
[B2] 呼叫 3 次同一個 @Cacheable 方法，實際查資料庫 3 次
[B2] ⚠️ 快取完全沒有生效
```

⚠️ **看懂這三行，就懂了切片測試最危險的地方：**

```
   ① bean 被 CGLIB 代理了       → 看起來「快取的 AOP 有裝上去」
   ② CacheManager 存在          → 看起來「快取管理器有」
   ③ 但它是 NoOpCacheManager    → ⚠️ 一個「什麼都不做」的實作

   為什麼會這樣？
     你的 @SpringBootApplication 上有 @EnableCaching        → 所以 AOP 代理裝上去了
     但 @DataRedisTest 不含 CacheAutoConfiguration          → 所以沒有真的 CacheManager
     Spring 的 @EnableCaching 找不到 CacheManager 時
     會 fallback 到 NoOpCacheManager                        → ⚠️ 不報錯，只是什麼都不做
```

📌 **於是你寫的所有快取測試都會通過，包括那些本來該失敗的。**
07 章講的每一件事——TTL、key 前綴、null 值、`transactionAware`——
**在 `@DataRedisTest` 裡一件都測不到。**

### 14.4.3 ✅ 快取的正確測法：斷言 Redis 裡真的有那個 key

```java
@SpringBootTest                               // ← 不是 @DataRedisTest
@TestPropertySource(properties = {
        "spring.cache.type=redis",            // ⚠️ 明著指定，不要讓它去猜
        "spring.cache.redis.time-to-live=2s",
        "spring.cache.redis.key-prefix=lab14:v1:",
        "spring.cache.redis.use-key-prefix=true"
})
class B3_CacheIntegrationTest extends AbstractRedisIT {

    @Autowired ProductCacheService svc;
    @Autowired StringRedisTemplate redis;
    @Autowired CacheManager cacheManager;

    @BeforeEach
    void clean() {
        redis.getConnectionFactory().getConnection().serverCommands().flushAll();
        svc.resetHits();
    }

    @Test
    void 快取真的有生效_而且_key_長成你以為的樣子() {
        svc.loadName(1L); svc.loadName(1L); svc.loadName(1L);

        assertThat(svc.dbHits()).isEqualTo(1);                         // ① 真的只查了一次
        assertThat(redis.keys("*")).containsExactly("lab14:v1:product::1");  // ② key 長這樣
        assertThat(redis.getExpire("lab14:v1:product::1")).isBetween(1L, 2L);// ③ TTL 真的設上去了
    }

    @Test
    void TTL_到了之後會再查一次資料庫() throws Exception {
        svc.loadName(2L);
        assertThat(svc.dbHits()).isEqualTo(1);
        Thread.sleep(2200);                                             // ⚠️ 真的等它過期
        svc.loadName(2L);
        assertThat(svc.dbHits()).isEqualTo(2);
    }
}
```

```
[B3] CacheManager = RedisCacheManager                    ← ✅ 這次是真的
[B3] 呼叫 3 次，實際查資料庫 1 次
[B3] Redis 裡的 key = [lab14:v1:product::1]
[B3] TTL = 2 秒
[B3] TTL 過期後再呼叫，累計查資料庫 2 次
```

📌 **三個斷言，缺一不可，而且第二、三個最重要：**

| 斷言 | 沒有它會漏掉什麼 |
|---|---|
| ① `dbHits == 1` | 只有這一個的話，`NoOpCacheManager`（14.4.2）也可能剛好通過（如果你的方法有別的快取） |
| ② **key 的完整字串** | ⚠️ **07 章 7.4.2 那個 `product::1` 的雙冒號**、key 前綴改了沒生效、`SimpleKey` 變成 `SimpleKey []` |
| ③ **TTL** | ⚠️ **`spring.cache.redis.time-to-live` 被忽略**（07 章 7.4.5：你自訂了 `RedisCacheManager` bean 之後它就不生效了） |

⚠️ **② 那個 `lab14:v1:product::1` 的 `v1`，就是 07 章 7.6.3 的版本化前綴。**
**把它寫進斷言，就等於把「改版之後舊快取要能共存」這件事釘住了**——
有人把前綴拿掉時，這個測試會紅。

> 📌 **`Thread.sleep(2200)` 可以用 Awaitility 換掉，但這裡不建議。**
> 等 TTL 過期本來就是「等一段確定的時間」，`Awaitility.await().atMost(...)`
> 在這裡只會讓測試更難讀。**Awaitility 該用在「等一件不確定何時發生的事」**——
> 例如等 keyspace 事件送達（13.7.8）、等 Sentinel 切換完成（14.6.4）。

---

## 14.5 併發測試：測得出超賣的寫法

12 章那張「六種防超賣方案」的對照表，價值不在表格本身，
**在於那個 harness——它讓你可以對任何一個新的實作問「這個會不會超賣」。**
這一節把它寫對。

### 14.5.1 先決定「超賣」怎麼量

```java
int orders    = (int) stock.orderCount();     // 賣出去幾張
int remaining = stock.stockOf(1L);            // 資料庫裡還剩幾件
int oversold  = orders - (STOCK - remaining); // ⚠️ 超賣 ＝ 賣掉的 − 真正扣掉的
```

⚠️ **不要用 `assertThat(orders).isEqualTo(100)`。** 實測顯示：

```
  pool=4    → 訂單 200 張，剩餘庫存 50    超賣 150
  pool=200  → 訂單 200 張，剩餘庫存 80    超賣 180
```

**訂單數永遠是 200**（每個請求都成功了），差別藏在「庫存到底被扣掉幾次」。
只斷言訂單數，你會以為這兩種情況一樣糟——**其實第二種糟一倍。**

📌 **這就是 12 章 12.2.3 那個「200 張訂單，庫存剩 79，超賣 179 件」的算法。**

### 14.5.2 三種 harness，量到的數字不一樣

```java
int run(int poolSize, boolean barrier, long gap, BiFunction<Long, String, Boolean> buy)
        throws Exception {
    stock.reset(1L, STOCK);
    ExecutorService pool = Executors.newFixedThreadPool(poolSize);
    CountDownLatch ready = new CountDownLatch(REQUESTS);   // 大家都就位了嗎
    CountDownLatch start = new CountDownLatch(1);          // 起跑槍
    CountDownLatch done  = new CountDownLatch(REQUESTS);   // 都跑完了嗎
    for (int i = 0; i < REQUESTS; i++) {
        final int n = i;
        pool.submit(() -> {
            try {
                if (barrier) { ready.countDown(); start.await(); }   // ← 卡在起跑線
                buy.apply(1L, "u" + n);
            } catch (Exception ignored) {
            } finally { done.countDown(); }
        });
    }
    if (barrier) { ready.await(10, TimeUnit.SECONDS); start.countDown(); }   // 砰
    done.await(60, TimeUnit.SECONDS);                       // ⚠️ 一定要等完
    pool.shutdown();
    // …算超賣
}
```

```
═══ 14.5.2 200 個請求搶 100 件，臨界區 0 毫秒（buyNoGuard）═══
  寫法                          | 訂單 | 剩餘庫存 | 超賣
  ------------------------------+------+----------+------
  ⚠️ ① 池子只有 4 條執行緒         |  200 |       37 |  137
  ⚠️ ② 池子 200，沒有起跑線        |  200 |       30 |  130
  ✅ ③ 池子 200 ＋ 起跑線          |  200 |       68 |  168
  ------------------------------+------+----------+------
  ⚠️ ① 池子只有 4 條執行緒         |  200 |       38 |  138
  ⚠️ ② 池子 200，沒有起跑線        |  200 |       53 |  153
  ✅ ③ 池子 200 ＋ 起跑線          |  200 |       69 |  169
  ------------------------------+------+----------+------
  ⚠️ ① 池子只有 4 條執行緒         |  200 |       39 |  139
  ⚠️ ② 池子 200，沒有起跑線        |  200 |       53 |  153
  ✅ ③ 池子 200 ＋ 起跑線          |  200 |       75 |  175
```

**三件事：**

**① 池子太小的話，你量到的是池子的大小，不是系統的併發度。**
4 條執行緒 → 137～139 件，非常穩定——**穩定地錯。**
⚠️ **常見寫法 `Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors())`
在這裡是錯的**：你要的不是「用滿 CPU」，是「模擬 200 個同時打進來的請求」。

**② 沒有起跑線的結果會跳（130 → 153 → 153）。**
因為 `newFixedThreadPool` 是**延遲建立執行緒**的：submit 第 1 個 task 才建第 1 條，
所以第 1 條已經跑完了，第 200 條才剛被建出來。
⚠️ **這就是「同一個測試，有時過有時不過」的來源。**

**③ 有起跑線的版本量到的超賣最多（168～175）**，因為它真的做到了「同時」。

對照組——同一個 harness 跑 12 章 12.2.6 那個**正確**的實作：

```
═══ 對照：buyConditional（UPDATE … WHERE stock > 0）═══
  ✅ ③ 池子 200 ＋ 起跑線          |  100 |        0 |    0
```

📌 **訂單剛好 100、庫存剛好 0、超賣 0。**
**這個對照組是必要的**——它證明你的 harness 不會誤報。

**再看一次窄窗口的競態**（09 章 9.3.1 那把 `if (get == null) set(...)` 的鎖，
臨界區只有一次網路往返）：

```
═══ 14.5.2b 跑 100 輪，有幾輪抓得到「兩個人同時持鎖」═══
  併發數 | ✅ 有起跑線 | ⚠️ 沒有起跑線 | 對照：正確的 SET NX PX
  -------+-------------+---------------+------------------------
       2 |        100% |          100% |                      0%
       5 |        100% |          100% |                      0%
      20 |        100% |          100% |                      0%
```

📌 **好消息：只要有起跑線，連「兩行程式之間」那種窄窗口都是 100% 重現。**
⚠️ **但不要把這個結論推廣。** 13 章 13.5.6 那個「主從切換時鎖被兩個人持有」
的實驗，**同樣的機器跑六次只重現一次**——
因為那個競態要求的不只是「同時」，還要求「複製剛好沒追上」。

**規則：**

| 競態的形狀 | 測試策略 |
|---|---|
| 兩行程式之間（check-then-act） | ✅ 起跑線 ＋ 跑一次就夠 |
| 需要特定的外部狀態（複製延遲、GC、網路） | ⚠️ **要主動製造那個狀態**（13 章用 `kill -STOP`），而不是「多跑幾次碰運氣」 |
| 跟時間有關（TTL 邊界、watchdog） | ⚠️ 把時間參數調到測試friendly 的值（TTL 2 秒而不是 30 分鐘） |

### 14.5.3 ⚠️ 測試方法上的 `@Transactional`：20 個執行緒全部失敗，測試是綠的

```java
@Test
@Transactional                       // ⚠️ 很多人為了「測完自動回滾」而加的這一行
void 有_Transactional_的併發測試() throws Exception {
    stock.reset(1L, 100);            // ← 這一筆還在「測試的交易」裡，沒有提交
    // …20 個子執行緒去 buyNoGuard…
}
```

```
[D2-有交易] 20 個子執行緒，失敗 20 個                    ⚠️
[D2-有交易] 測試執行緒看到的 orders = 0
[D2-有交易] ⚠️ 子執行緒是另一個交易，它們看不到上面那一行 reset

[D2-無交易] 20 個子執行緒，失敗 0 個
[D2-無交易] orders = 20  stock = 98                     ← lost update 看得見了

Tests run: 2, Failures: 0, Errors: 0        ← ⚠️ 兩個都「通過」
```

⚠️ **20 個子執行緒全部丟例外，而測試是綠的。**

原因很簡單，但每個人都會踩：

```
   @Test @Transactional 開了一個交易 T0
        │
        ├─ stock.reset(1L, 100)        → 寫在 T0 裡，⚠️ 沒有提交
        │
        ├─ 子執行緒 1 … 20              → 它們是**別的執行緒**，
        │                                 Spring 的交易是綁在 ThreadLocal 上的，
        │                                 ⚠️ 它們開的是各自的新交易，看不到 T0 的未提交資料
        │
        └─ 測試結束 → T0 回滾            → 什麼都沒留下
```

📌 **規則：併發測試上面永遠不要加 `@Transactional`。**
**清資料用 `@BeforeEach` 手動做**（像 `StockService.reset()` 那樣，
讓它自己是一個會提交的交易）。

⚠️ **同一個陷阱的另外三個版本：**

| 寫法 | 症狀 |
|---|---|
| `@Transactional` ＋ `@Async` | 非同步方法看不到測試裡寫的資料 |
| `@Transactional` ＋ `TestEntityManager` | ⚠️ 忘了 `flush()`，SQL 根本還沒送出去 |
| `@Transactional` ＋ 07 章的 `transactionAware` 快取 | ⚠️ `@CacheEvict` 在測試交易提交時才執行——而它永遠不提交，**所以永遠不執行** |

### 14.5.4 ⚠️ 共用容器 ＝ 測試之間看得到彼此的資料

14.2.4 的單例容器省了很多時間，代價在這裡：

```java
@SpringBootTest
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class D3_DataPollutionTest extends AbstractRedisIT {

    @Test @Order(1) void 測試一_寫了一個_key() { redis.opsForValue().set("cart:u1", "3"); }
    @Test @Order(2) void 測試二_以為自己面對的是乾淨的_Redis() { … }
}
```

```
[D3] 測試一寫入 cart:u1 = 3
[D3] 測試二讀到 cart:u1 = 3  ⚠️ 上一個測試留下來的
[D3] DBSIZE = 1
[D3] flushAll 之後 DBSIZE = 0
```

**三種清法，各有各的問題：**

```java
// ① 最簡單，但最粗暴
@BeforeEach void clean() {
    redis.getConnectionFactory().getConnection().serverCommands().flushAll();
}
// ⚠️ 平行執行測試（junit.jupiter.execution.parallel.enabled=true）時，
//    它會清掉「正在跑的別的測試」的資料 —— 而那會變成 14.5.2 ② 那種隨機失敗

// ② 每個測試類別用自己的 key 前綴
String k(String key) { return getClass().getSimpleName() + ":" + key; }
// ✅ 可以平行跑；⚠️ 但你的 production 程式裡的 key 不會加這個前綴

// ③ 每個測試類別用自己的 database（0～15）
@DynamicPropertySource
static void props(DynamicPropertyRegistry r) { r.add("spring.data.redis.database", () -> 3); }
// ✅ 完全隔離；⚠️ 只有 16 個；⚠️ 13.6.5：Cluster 上沒有這個東西
```

📌 **本站的建議：**

| | 做法 |
|---|---|
| **測試不平行跑**（預設） | ✅ `@BeforeEach` 裡 `flushAll()`。簡單、可靠 |
| **測試要平行跑** | ✅ 用 ③ 分 database；⚠️ 並且接受「Cluster 的測試不能平行跑」 |
| **無論哪一種** | ⚠️ **不要依賴測試的執行順序**。`@Order` 只該用在「示範順序問題」這種地方，不該用在正式的測試裡 |

⚠️ **14.6.1 的 Cluster 測試就是一個例子**：如果
`你的每一段_Lua_都要在這裡跑一次()` 依賴前一個測試寫進去的 `{order:1}:stock`，
**JUnit 換一個執行順序它就紅了**。修法是每個測試自己準備資料：

```java
@Test
void 你的每一段_Lua_都要在這裡跑一次() {
    cmd.set("{order:1}:stock", "100");        // ← 自己準備，不依賴別的測試
    // …
}
```

---

## 14.6 把 13 章搬進 CI

13 章的每一個結論——`CROSSSLOT`、topology refresh、failover 恢復時間——
**都是在一個手工架起來的 Docker 環境裡量出來的。**
如果它們不進 CI，三個月後有人改了設定，你不會知道。

### 14.6.1 Cluster 容器：3.9 秒

```java
class F1_ClusterContainerTest {

    static final int[] PORTS = {7101, 7102, 7103};

    static final GenericContainer<?> CLUSTER = new GenericContainer<>(DockerImageName.parse("redis:7.2"))
            .withCreateContainerCmdModifier(cmd -> {                 // ⚠️ 見 14.6.2
                List<PortBinding> bindings = new ArrayList<>();
                for (int p : PORTS) {
                    bindings.add(new PortBinding(Ports.Binding.bindPort(p), new ExposedPort(p)));
                    bindings.add(new PortBinding(Ports.Binding.bindPort(10000 + p), new ExposedPort(10000 + p)));
                }
                Objects.requireNonNull(cmd.getHostConfig()).withPortBindings(bindings);
            })
            .withCommand("sh", "-c", """
                    for p in 7101 7102 7103; do
                      mkdir -p /d/$p
                      redis-server --port $p --dir /d/$p --cluster-enabled yes \\
                        --cluster-config-file nodes.conf --cluster-node-timeout 5000 \\
                        --cluster-announce-ip 127.0.0.1 --cluster-announce-port $p \\
                        --cluster-announce-bus-port 1$p --daemonize yes --save ''
                    done
                    sleep 1
                    yes yes | redis-cli --cluster create 127.0.0.1:7101 127.0.0.1:7102 127.0.0.1:7103
                    echo CLUSTER-READY
                    tail -f /dev/null
                    """)
            .waitingFor(Wait.forLogMessage(".*CLUSTER-READY.*", 1)
                    .withStartupTimeout(Duration.ofSeconds(60)));
    // …
}
```

```
[F1] Cluster 容器啟動耗時 3,694 ms
[F1] 節點數 = 3，覆蓋的槽 = 16384
Tests run: 4, Failures: 0, Errors: 0, Time elapsed: 4.698 s
```

📌 **三個重點：**

**① 一個容器跑三個節點**（13.2.1 用的同一招）。比起六個容器，
它省掉了容器間網路與 `announce-ip` 的一整類問題。

**② `Wait.forLogMessage` 比 `Wait.forListeningPort` 可靠得多。**
Cluster 的 port 在 `redis-server` 起來時就開了，但那時候**槽還沒分配**——
用 port 等，你會在 `cluster_state:fail` 的狀態下開始跑測試。
**自己 `echo` 一個 ready 訊號，等那個。**

**③ `--save ''` 關掉 RDB。** 測試容器不需要持久化，也不需要 04 章那個 `fork` 尖峰。

### 14.6.2 ⚠️ 固定 port 的代價

```java
.withCreateContainerCmdModifier(cmd -> cmd.getHostConfig().withPortBindings(
        new PortBinding(Ports.Binding.bindPort(7101), new ExposedPort(7101)), …))
```

**Cluster 與 Sentinel 不得不固定 port**，因為它們會把自己的位址廣播給客戶端
（13.5.5、13.6.1），而 Testcontainers 的隨機映射會讓客戶端拿到連不到的位址。

⚠️ **但固定 port 違反了 Testcontainers 的核心設計，代價要知道：**

| 問題 | 處理 |
|---|---|
| ⚠️ **同一台 CI runner 上兩個 job 同時跑 → port 撞** | 每個專案用不同的 port 段（本站：7101-7103、6480-6481、26479-26481），或 CI 上限制這類測試不平行 |
| ⚠️ 本機開發時撞到你自己開的 Redis | 刻意選冷門的 port（**不要用 6379、7001**） |
| ⚠️ 上一次測試沒關乾淨，port 被佔住 | Ryuk 會收，但 `TESTCONTAINERS_RYUK_DISABLED=true` 時要自己收 |

📌 **所以這類測試要跟一般測試分開**（14.6.5）。

### 14.6.3 「要求它失敗」的測試

這是 13 章最該進 CI 的一類測試，**而且它長得跟一般測試相反**：

```java
@Test
void 多_key_的_Lua_跨槽時必須失敗() {
    // ⚠️ 13.7.3：這是一個「要求它失敗」的測試
    //    ——防止有人日後偷偷加回一段多 key 的 Lua，然後在正式環境才發現
    assertThatThrownBy(() -> cmd.eval(
            "return redis.call('get', KEYS[1]) .. redis.call('get', KEYS[2])",
            ScriptOutputType.VALUE, new String[]{"stock:1", "user:1"}))
            .hasMessageContaining("CROSSSLOT");
}

@Test
void 同一個_hash_tag_的_Lua_必須成功() {
    cmd.mset(Map.of("{order:1}:stock", "100", "{order:1}:lock", "A"));
    Object r = cmd.eval("return redis.call('get',KEYS[1])..'/'..redis.call('get',KEYS[2])",
            ScriptOutputType.VALUE, new String[]{"{order:1}:stock", "{order:1}:lock"});
    assertThat(r).isEqualTo("100/A");
}

@Test
void 你的每一段_Lua_都要在這裡跑一次() {
    cmd.set("{order:1}:stock", "100");        // ⚠️ 自己準備資料（14.5.4）
    Object deduct = cmd.eval("""
            local left = tonumber(redis.call('get', KEYS[1]))
            if left == nil then return -1 end
            if left < tonumber(ARGV[1]) then return 0 end
            return redis.call('decrby', KEYS[1], ARGV[1])
            """, ScriptOutputType.INTEGER, new String[]{"{order:1}:stock"}, "3");
    assertThat(deduct).isEqualTo(97L);        // 12 章 12.4.1 的 deduct-stock.lua
}
```

```
[F1] ✅ 跨槽 Lua 如預期丟出 CROSSSLOT
[F1] hash tag Lua → 100/A
[F1] 12 章 deduct-stock.lua → 97
[F1] 節點數 = 3，覆蓋的槽 = 16384
```

📌 **最後那一個測試是這一節的重點：把你專案裡的每一段 Lua 都列進去。**
13.7.6 那張表是「上 Cluster 前的檢查清單」，
**這個測試是「上 Cluster 後不會退化的保險」。**

⚠️ **它也擋得住 13.7.3 那個最難查的問題**（Lua 碰到沒宣告在 `KEYS` 的 key，
「有時候成功有時候失敗」）：在 Cluster 上跑，**不合規的 Lua 一定會炸**。

### 14.6.4 Sentinel failover 演練：7.9 秒

13 章最重要的數字（「客戶端多久才恢復」）也可以進 CI：

```java
@Tag("slow")
class F2_SentinelFailoverTest {

    static final GenericContainer<?> HA = new GenericContainer<>(DockerImageName.parse("redis:7.2"))
            .withCreateContainerCmdModifier(/* 固定 6480/6481/26479-26481 */)
            .withCommand("sh", "-c", """
                    redis-server --port 6480 --dir /d --daemonize yes --save ''
                    redis-server --port 6481 --dir /d --daemonize yes --save '' --replicaof 127.0.0.1 6480
                    sleep 1
                    for p in 26479 26480 26481; do
                      printf 'port %s\\ndir /d\\nsentinel monitor mymaster 127.0.0.1 6480 2\\n\\
                              sentinel down-after-milliseconds mymaster 2000\\n\\
                              sentinel failover-timeout mymaster 6000\\n' $p > /d/s$p.conf
                      redis-server /d/s$p.conf --sentinel --daemonize yes
                    done
                    sleep 2
                    echo HA-READY
                    tail -f /dev/null
                    """)
            .waitingFor(Wait.forLogMessage(".*HA-READY.*", 1).withStartupTimeout(Duration.ofSeconds(60)));

    @Test
    void 客戶端必須在_down_after_加三秒之內恢復() throws Exception {
        RedisURI uri = RedisURI.Builder.sentinel("127.0.0.1", 26479, "mymaster")
                .withSentinel("127.0.0.1", 26480).withSentinel("127.0.0.1", 26481)
                .withTimeout(Duration.ofMillis(500)).build();
        ClientResources res = ClientResources.builder()
                .reconnectDelay(Delay.exponential(50, 1000, TimeUnit.MILLISECONDS, 2))   // 13.5.4
                .build();
        RedisCommands<String, String> cmd = RedisClient.create(res, uri).connect().sync();
        cmd.set("hb", "0");

        HA.execInContainer("sh", "-c",                       // ← 在容器裡殺掉 master
                "kill -9 $(redis-cli -p 6480 info server | grep process_id | tr -d 'process_id:\\r')");
        long t0 = System.currentTimeMillis();

        long recovered = -1;
        for (int i = 0; i < 300; i++) {
            try { cmd.incr("hb"); recovered = System.currentTimeMillis() - t0; break; }
            catch (Exception ignored) { Thread.sleep(100); }
        }
        assertThat(recovered).isGreaterThan(0).isLessThan(2000 + 3000);   // down-after 2s ＋ 3 秒緩衝
    }
}
```

```
[F2] Sentinel 環境啟動耗時 3,681 ms
[F2] 從 kill -9 到第一次成功：4,029 ms
Tests run: 1, Failures: 0, Errors: 0, Time elapsed: 8.710 s
```

📌 **`down-after-milliseconds` 在測試裡設 2000，不是正式環境的 5000**（13.4.3）。
這是「把時間參數調到測試 friendly 的值」——
**但斷言要用 `down-after + 緩衝`，而不是寫死 5000**，
這樣改了 `down-after` 時測試還是對的。

⚠️ **這個測試真正在守的是什麼：**

```
   assertThat(recovered).isLessThan(2000 + 3000)
                                           ↑
   它守的不是 Sentinel（Sentinel 不會壞），
   守的是 13.5.3 那個 reconnectDelay ——
   ⚠️ 有人把 ClientResources 那個 bean 刪掉，這個測試會紅（會變成 9 秒那一組）。
```

### 14.6.5 測試分層：`@Tag` 與 CI 的兩條路

```java
@Tag("slow")                    // 起 Sentinel / Cluster、跑 failover、等 TTL
class F2_SentinelFailoverTest { … }
```

```bash
$ mvn test -DexcludedGroups=slow      # 每次 push 都跑
Tests run: 37, Failures: 0, Errors: 0
Total time:  27.244 s

$ mvn test -Dgroups=slow              # 每晚 / merge 到 main 之前跑
Tests run: 1, Failures: 0, Errors: 0
Total time:  8.955 s
```

📌 **本站建議的三層：**

| 層 | 內容 | 什麼時候跑 | 目標耗時 |
|---|---|---|---|
| **單元測試** | 序列化器、key 命名、Lua 的純邏輯、限流演算法的數學 | 每次存檔 | < 5 秒 |
| **整合測試**（單例容器） | 快取、鎖、限流、冪等、預扣庫存（07～12 章） | **每次 push** | < 60 秒 |
| ⚠️ **`@Tag("slow")`** | Cluster、Sentinel failover、降級演練、TTL 邊界（08、13 章） | 每晚 ＋ merge 前 | 幾分鐘 |

⚠️ **不要把第三層省掉，改成「上線前手動跑一次」。**
手動跑一次的意思是「不會跑」。

---

## 14.7 指標：上線之後怎麼知道設定對不對

測試守的是「程式行為」。**設定對不對，只有正式環境會告訴你。**

### 14.7.1 Lettuce 的兩個延遲指標

⚠️ **Lettuce 的命令延遲指標預設是關的**，而且 Spring Boot 不會自動幫你開：

```java
@Configuration
public class MetricsConfig {

    @Bean(destroyMethod = "shutdown")
    ClientResources lettuceClientResources(MeterRegistry registry) {
        MicrometerOptions options = MicrometerOptions.builder()
                .histogram(true)              // ⚠️ 開了才有 P95 / P99（預設只有 count / mean / max）
                .localDistinction(true)
                .build();
        return ClientResources.builder()
                .commandLatencyRecorder(new MicrometerCommandLatencyRecorder(registry, options))
                .reconnectDelay(Delay.exponential(50, 1000, TimeUnit.MILLISECONDS, 2))   // 13.5.4
                .build();
    }
}
```

打 500 次 `SET` ＋ 500 次 `GET` 之後：

```
═══ 14.7.1 lettuce.* 指標 ═══
  lettuce.command.completion      GET/localhost    count=500   mean=0.190 ms  max=0.670 ms
  lettuce.command.completion      SET/localhost    count=500   mean=0.191 ms  max=0.882 ms
  lettuce.command.completion      HSET/localhost   count=1     mean=0.239 ms  max=0.239 ms
  lettuce.command.firstresponse   GET/localhost    count=500   mean=0.182 ms  max=0.660 ms
  lettuce.command.firstresponse   SET/localhost    count=500   mean=0.186 ms  max=0.872 ms

=== GET 的分位數（histogram(true) 才有）===
  P50.0  = 0.164 ms
  P90.0  = 0.254 ms
  P95.0  = 0.303 ms
  P99.0  = 0.401 ms
  P99.9  = 0.680 ms
```

📌 **兩個指標的差，是這一節最重要的東西：**

| 指標 | 量的是 | 大的時候代表 |
|---|---|---|
| `lettuce.command.firstresponse` | 命令送出 → **收到第一個位元組** | 網路 ＋ **Redis 主執行緒**（03 章：慢命令、big key、Lua） |
| `lettuce.command.completion` | 命令送出 → **完全處理完** | 上面那些 ＋ **你這一側**（回應很大、解碼慢、事件迴圈塞住） |

```
   completion − firstresponse ＝ 客戶端這一側的成本

   本站實測：GET 0.190 − 0.182 = 0.008 ms      ← 健康
   ⚠️ 如果這個差開始變大（例如 > 1 ms），問題不在 Redis：
      ① 回應太大（big key，14.8）
      ② netty 的 event loop 執行緒被你的業務程式佔住了
         （⚠️ 在 Lettuce 的 callback 裡做阻塞操作）
      ③ GC
```

⚠️ **很多「Redis 變慢了」的工單，`firstresponse` 是平的。**
那代表 Redis 沒事，是你的應用。

⚠️ **`localDistinction(true)` 會用 local socket 位址當標籤**——
連線多的時候標籤數量會變多。**標籤數量會爆的環境請設 `false`。**

### 14.7.2 ⚠️ 連線池滿了長什麼樣

06 章 6.7 講過 Lettuce 的連線池只在「需要專屬連線」時才會用到
（`MULTI`、`SCAN`、pipeline、阻塞命令）。**它滿了的時候，錯誤訊息跟 Redis 一點關係都沒有：**

```java
@TestPropertySource(properties = {
        "spring.data.redis.lettuce.pool.max-active=2",
        "spring.data.redis.lettuce.pool.max-wait=100ms"
})
// 20 個執行緒，每個借一條專屬連線佔用 200 毫秒
```

```
[E2] max-active=2, max-wait=100ms，20 個執行緒各佔用連線 200 ms
[E2] 成功 1，失敗 19
[E2]   19 × NoSuchElementException: Timeout waiting for idle object, borrowMaxWaitDuration=PT0.1S
```

⚠️ **`NoSuchElementException: Timeout waiting for idle object`** ——
記住這一行。它是 commons-pool2 丟的，訊息裡**沒有「Redis」兩個字**，
所以它常常被誤判成程式 bug。

📌 **它的三種成因與處理：**

| 成因 | 怎麼確認 | 處理 |
|---|---|---|
| `max-active` 太小 | 借用數 ≈ `max-active` | 調大；或問「為什麼這麼多命令需要專屬連線」 |
| ⚠️ **有人忘了還** | 借用數只增不減 | 找出沒有 try-with-resources 的 `getConnection()` |
| ⚠️ **Redis 變慢，連線被佔住** | `lettuce.command.firstresponse` 同時上升 | **這是症狀不是原因**（08 章 8.4.1 的 Little's Law） |

⚠️ **最後一列最重要：連線池耗盡常常是「Redis 慢」的下游症狀。**
把 `max-active` 調大只會讓更多執行緒一起卡住。

> 📌 **`max-wait` 一定要設**（06 章 6.7.4）。預設 `-1` 是無限等——
> 那時候你連上面這個例外都看不到，只會看到執行緒無聲地堆積。

### 14.7.3 該接哪些告警：07～13 章的彙整

| 指標 | 來源 | 告警條件 | 對應章節 |
|---|---|---|---|
| 快取命中率 | `keyspace_hits / (hits+misses)` | 突然掉 > 20% | 08 章 8.5.1 |
| `lettuce.command.firstresponse` P99 | Micrometer | > 你的逾時的一半 | 14.7.1 |
| **`completion − firstresponse`** | Micrometer | 持續 > 1 ms | **14.7.1（問題在你這一側）** |
| 命令逾時次數 | `RedisCommandTimeoutException` 計數 | > 0 持續出現 | 06 章 6.8.3 |
| 熔斷器跳閘 | 應用端 | 跳閘就告警 | 08 章 8.4 |
| ⚠️ `evict` 失敗 | 應用端 | **> 0 就告警** | 08 章 8.3.1（唯一會造成資料錯誤的） |
| `evicted_keys` | `INFO stats` | > 0 | 04 章 4.3、11 章 11.6.4 |
| `blocked_clients` / `instantaneous_ops_per_sec` | `INFO` | —— | 03 章 |
| `slowlog` 長度 | `SLOWLOG LEN` | 增加 | 03 章 3.5 |
| **複製落後量** | `master_repl_offset − slaveN.offset` | > 幾 MB | **13 章 13.2.1** |
| **`+switch-master`** | Sentinel pub/sub | **發生就告警** | **13 章 13.10.4** |
| **`cluster_state`** | `CLUSTER INFO` | `!= ok` | **13 章 13.6.1** |
| 連線池借用等待 | `NoSuchElementException` 計數 | > 0 | 14.7.2 |
| **單一 key 模板佔比** | 應用端埋點 | > 30% | **12 章 12.8.6、14.8.3** |

---

## 14.8 Java 端看到的 big key 與 hot key

### 14.8.1 big key 的三個症狀

02、03 章在 `redis-cli` 裡量過 big key。**在 Java 這一側它長這樣：**

```java
Map<String, String> big = new HashMap<>();
for (int i = 0; i < 100_000; i++) big.put("f" + i, "v" + i);
redis.opsForHash().putAll("cart:big", big);
redis.opsForValue().set("normal", "v");           // 一個無辜的小 key
```

```
═══ 14.8.1 一個 10 萬欄位的 Hash ═══
  MEMORY USAGE cart:big = 5,048,688 bytes                    ← 4.8 MB

  ① HGET     平均    340 μs
     HGETALL       99,143 μs（100,000 個欄位）  ← ⚠️ 慢 292 倍

  ② DEL cart:big 花了 17,295 μs
  ③ 同時間旁邊那個 GET normal：P50 = 591 μs，最慢 = 15,983 μs
                                                  ↑
                             ⚠️ 它什麼壞事都沒做，只是排在 DEL 後面
```

📌 **③ 就是 03 章那句「單執行緒」在 Java 端的樣子**：
一個跟你完全無關的請求，因為別人 `DEL` 了一個 big key，**延遲從 0.6 毫秒變成 16 毫秒**。

⚠️ **而它在監控上看起來會像「Redis 偶爾抖一下」**——
因為受害的是 `GET normal`，不是 `DEL cart:big`。
**你去看 `SLOWLOG`（03 章 3.5）才會看到真凶。**

> 📌 **`UNLINK` 可以解決 ② 和 ③**（01 章 1.3.2：它把釋放記憶體丟給背景執行緒）。
> **但解決不了 ①**——`HGETALL` 一個 10 萬欄位的 Hash，那 99 毫秒是主執行緒實打實的工作。

### 14.8.2 怎麼在 Java 端找出 big key

```java
/** MEMORY USAGE：Spring Data Redis 沒有包，走 Lettuce 原生 API（00 章 0.7.3 的 RedisProbe 同一招）。 */
Long memoryUsage(String key) {
    return redis.execute((RedisCallback<Long>) c -> {
        @SuppressWarnings("unchecked")
        var cmd = (RedisAsyncCommands<byte[], byte[]>) c.getNativeConnection();
        try { return cmd.memoryUsage(key.getBytes()).get(); }
        catch (Exception e) { throw new IllegalStateException(e); }
    });
}

@Test
void 怎麼在_Java_端找出_big_key() {
    // ⚠️ 不要用 KEYS（01 章 1.5）——用 SCAN
    redis.execute((RedisCallback<Object>) c -> {
        var opts = ScanOptions.scanOptions().count(100).build();
        try (var cursor = c.keyCommands().scan(opts)) {
            while (cursor.hasNext()) {
                byte[] k = cursor.next();
                Long usage = memoryUsage(new String(k));
                // …收集前 N 大
            }
        }
        return null;
    });
}
```

```
[E3] 依記憶體排序的前 3 大 key：
[E3]    2,097,200 bytes  huge
[E3]          168 bytes  small:3
```

⚠️ **三個注意事項：**

| | |
|---|---|
| **`MEMORY USAGE` 是 O(N) 的抽樣** | 對 Hash / ZSet 它預設抽 5 個欄位再推估。要精確值用 `MEMORY USAGE key SAMPLES 0`，⚠️ **但那會掃全部，別在正式環境對 big key 這樣做** |
| **一定要 `SCAN` 不要 `KEYS`** | 01 章 1.5 |
| ⚠️ **這支巡檢本身會製造負載** | 每個 key 一次 `MEMORY USAGE`。**排在離峰、加 `Thread.sleep`、或只掃取樣的一部分** |

📌 **更好的做法：`redis-cli --memkeys`（或 `--bigkeys`）**，它在 Redis 那一側跑，
用 `SCAN` ＋ 取樣，不用你自己寫。
**自己寫的價值在於「可以接進你的告警系統」**——每天跑一次，超過門檻就發通知。

### 14.8.3 hot key：`--hotkeys` 分不出來，所以要在應用端埋點

12.8.6 實測過 `redis-cli --hotkeys` **完全分不出熱點**（LFU 計數器是對數的、會衰減、上限 255）。
應用端的做法要分兩層：

```java
@Component
public class HotKeyDetector {

    private static final int CAPACITY = 1_000;      // ⚠️ 一定要有上界

    private final Map<String, Counter> templates = new ConcurrentHashMap<>();  // ① 進 Micrometer
    private final Map<String, LongAdder> exact   = new ConcurrentHashMap<>();  // ② 不進 Micrometer

    public void record(String key) {
        total.increment();
        // ① 模板層：標籤數量可控，可以安全地送進 Micrometer
        templates.computeIfAbsent(template(key),
                t -> Counter.builder("redis.ops").tag("template", t).register(registry)).increment();
        // ② 精確 key：⚠️ 絕對不能送進 Micrometer（標籤爆炸），只留記憶體而且要有上界
        exact.computeIfAbsent(key, k -> new LongAdder()).increment();
        if (exact.size() > CAPACITY) evictColdHalf();
    }

    /** Space-Saving 的窮人版：滿了就砍掉後半段。冷 key 被淘汰，熱 key 活得下來。 */
    private synchronized void evictColdHalf() {
        long median = exact.values().stream().mapToLong(LongAdder::sum).sorted()
                .skip(exact.size() / 2).findFirst().orElse(1);
        exact.entrySet().removeIf(e -> e.getValue().sum() <= median);
    }

    /** ⚠️ 只替換「整段都是數字」或 UUID 的片段，不要用 \\d+ 全域取代（lab14 會變成 lab*）。 */
    static String template(String key) {
        String[] parts = key.split(":", -1);
        // …逐段判斷是不是變數
    }
}
```

實測（10,000 次請求，其中 90% 打在 `product:8888`，外加 500 個隨機 session）：

```
=== ① 模板層：哪一類 key 佔了流量 ===
  product:*              10,000 次   95.2%  ⚠️ 這一類佔了大部分流量
  session:*                 500 次    4.8%

=== ② top-K 層：哪一個 key 是熱的 ===
  product:8888            8,994 次   85.7%  ⚠️ hot key
  product:47399               2 次    0.0%
  product:68591               2 次    0.0%

=== 模板收斂的效果 ===
  product:12345                                  → product:*
  session:89316b3a-6aa8-4f12-8f62-b3464616e2b2   → session:*
  stock:1:b7                                     → stock:*:*
  lab14:v1:product::42                           → lab14:v1:product::*
```

📌 **兩層各自回答不同的問題，缺一不可：**

```
   只有 ① 模板層 → 你會知道「product 這一類佔 95%」，
                    ⚠️ 但那是廢話（本來就是商品服務），找不出是哪一個商品

   只有 ② top-K  → 你會知道 product:8888 很熱，
                    ⚠️ 但它是有界近似的，不能當成準確的統計

   ①＋② 一起    → 「product 這一類佔 95%，其中 product:8888 一個就佔 85.7%」
                    ✅ 這句話可以直接拿去做 12.8.7 的本地快取決策
```

⚠️ **`template()` 那個函式是這段程式最容易寫錯的地方。**
如果用 `\d+` 全域取代，`lab14:v1:product::42` 會變成 `lab*:v*:product::*`——
**連命名空間都被吃掉了。** 要逐段判斷：整段都是數字才換。

⚠️ **絕對不要把完整的 key 當成 Micrometer 的標籤。**
那等於把 hot key 問題從 Redis 搬到監控系統——
`product:12345`、`product:12346`…… 十萬個標籤，Prometheus 會先倒。

---

## 14.9 上線檢查清單

**這一節是整站的收斂。每一條後面的節號，就是「為什麼要這一條」的實測。**

### 14.9.1 Redis 本體（00～05 章）

- [ ] `maxmemory` 有設，而且淘汰策略是刻意選的，不是 `noeviction` 忘了改（04 章 4.2、4.3）
- [ ] ⚠️ 正式環境的 `KEYS` 已經全部改成 `SCAN`（01 章 1.5）
- [ ] 每一個會長大的 key 都有 TTL；⚠️ **而且 `SET` 覆寫不會把它洗掉**（01 章 1.4.3）
- [ ] 刪大 key 用 `UNLINK` 不是 `DEL`（01 章 1.3.2、14.8.1）
- [ ] 沒有「一個 key 塞十萬個元素」的設計（02 章 2.10、14.8.1）
- [ ] `slowlog-log-slower-than` 有設，而且有人在看（03 章 3.5）
- [ ] 持久化策略（RDB / AOF）符合你的資料容忍度，**而且你知道 `fork` 的延遲尖峰有多大**（04 章 4.5.3、4.6）
- [ ] ⚠️ 沒有任何地方把 `MULTI/EXEC` 當成「會回滾的交易」（05 章 5.4）
- [ ] 每一段 Lua 都很短，⚠️ **沒有迴圈掃描大量資料**（05 章 5.8.3）

### 14.9.2 連線與序列化（06 章）

- [ ] `timeout` 有設（⚠️ **預設 60 秒**）、`connect-timeout` 比它長（6.8、6.9.1）
- [ ] 序列化器是刻意選的；⚠️ **沒有用 JDK 序列化**（6.4）
- [ ] 換成 Jackson 的話，⚠️ **自訂 `ObjectMapper` 沒有把型別資訊關掉**（6.5.5）
- [ ] 有「舊資料 ／ 新版本程式」的相容性測試（6.4.2 ＋ 14.4.3）
- [ ] `lettuce.pool.enabled` 明著寫；`commons-pool2` 真的在 classpath 上（6.7.3）
- [ ] ⚠️ **`max-wait` 有設**（預設 `-1` ＝ 無限等）（6.7.4、14.7.2）
- [ ] `client-name` 有設，`CLIENT LIST` 上認得出是誰（03 章 3.5.2、3.9）

### 14.9.3 快取（07 章）

- [ ] 每一個 cache 都有 TTL，而且是 per-cache 設的（7.4.3）
- [ ] ⚠️ 快取 `null` 的 TTL **比正常值短**（7.5.4）
- [ ] key 有**版本化前綴**，改版後舊資料讀得回來或讀不到都不會 500（7.6.3、7.6.4）
- [ ] ⚠️ `transactionAware` 有開，`@CacheEvict` 不會在交易提交前就放行（7.7.4）
- [ ] 沒有任何地方靠 `@Cacheable` 的自呼叫（7.2.3）
- [ ] 穿透／擊穿／雪崩三種都有對策（7.8）

### 14.9.4 降級（08 章）

- [ ] `CacheErrorHandler` 有裝，⚠️ **而且 `evict` 失敗不是靜默吞掉**（8.3.1）
- [ ] 熔斷器有裝，⚠️ **跳閘時丟例外而不是回 `null`**（8.4.3）
- [ ] ⚠️ **readiness 探針裡沒有 Redis**（8.6.3）
- [ ] 有本地快取兜底，而且知道它救不了哪一種（8.5.5）
- [ ] **做過一次「把 Redis 拔掉 60 秒」的演練，而且有報告**（8.10）
- [ ] 知道恢復的第二波（快取空了、連線風暴）會發生什麼（8.7）

### 14.9.5 鎖、限流、冪等（09、10 章）

- [ ] 鎖是 `SET NX PX` ＋ **Lua 比對 token 釋放**，不是 `DEL`（9.3.4、9.4.4）
- [ ] ⚠️ **鎖在交易外面**（`@Transactional` 在內、加鎖在外）（9.8）
- [ ] 鎖的 TTL 是量出來的，不是猜的；長業務有 watchdog（9.5.5、9.6）
- [ ] ⚠️ **鎖不能降級**：Redis 掛掉時該失敗，不是「跳過鎖繼續做」（9.11）
- [ ] 限流的 `INCR` 與 `EXPIRE` 在**同一段 Lua** 裡（10.2.2）
- [ ] `429` 有回 `Retry-After` / `RateLimit-*`（10.7）
- [ ] 冪等鍵有三個狀態、有回應重放、⚠️ **在交易外面**（10.9.3、10.9.5、10.9.9）
- [ ] ⚠️ **限流可以 fail-open，冪等不行**（10.11.1）

### 14.9.6 Session 與庫存（11、12 章）

- [ ] Session 有 TTL，⚠️ **而且 `maxmemory` 不會把它驅逐掉**（11.6.1、11.6.4）
- [ ] Session 的序列化不含密碼、體積量過（11.5.4、11.6.3）
- [ ] JWT 有 `jti` 黑名單或短 TTL ＋ refresh rotation（11.10）
- [ ] ⚠️ **`UPDATE … WHERE stock > 0` 還在**（12.2.6、12.9.3 第 33 條）
- [ ] Redis 預扣的 Lua 分得出「庫存 0」與「key 不存在」（12.4.2）
- [ ] 有回補 ＋ 對帳任務，兩個方向分開處理（12.5）

### 14.9.7 高可用（13 章）

- [ ] Sentinel 至少 3 台，在 **3 個故障域**（13.4.4）
- [ ] `down-after-milliseconds` 是算出來的，而且寫進了 SLA（13.4.3）
- [ ] ⚠️ **客戶端走 Sentinel / Cluster，不是寫死位址**（13.5.1）
- [ ] ⚠️ **`reconnectDelay` 有調**（13.5.3、13.5.4）
- [ ] ⚠️ **Cluster 的 `lettuce.cluster.refresh.adaptive: true` 有開**（13.8.3）
- [ ] 節點宣告的位址是「應用程式連得到」的（13.5.5、13.6.1）
- [ ] Sentinel / Redis 的設定檔可寫，不是唯讀 ConfigMap（13.4.5）
- [ ] 13.7.6 那張表逐列走過一次（13.7）
- [ ] ⚠️ **沒有任何邏輯依賴 keyspace 事件一定送達**（13.7.8）

### 14.9.8 測試與觀測（14 章）

- [ ] 整合測試用 **Testcontainers ＋ 跟正式環境同版本的 Redis**（14.2、14.3）
- [ ] ⚠️ 快取測試是 `@SpringBootTest`，**不是 `@DataRedisTest`**（14.4.2）
- [ ] 快取測試斷言了 **key 的完整字串與 TTL**（14.4.3）
- [ ] 併發測試有**起跑線**、**沒有 `@Transactional`**、**有正確實作的對照組**（14.5）
- [ ] Cluster 的 `CROSSSLOT` 有「要求它失敗」的測試（14.6.3）
- [ ] Sentinel failover 有 CI 測試，⚠️ **而且它守著 `reconnectDelay`**（14.6.4）
- [ ] `lettuce.command.*` 指標有接，**`histogram(true)` 有開**（14.7.1）
- [ ] 14.7.3 那張告警表逐列確認過
- [ ] 有 big key 巡檢與 hot key 埋點（14.8）

### 14.9.9 一份可以照抄的 `redis.conf`（03 章 3.9 那句話的回收）

前面十四章的每一個 `CONFIG SET` 都只改到記憶體裡，**重啟就沒了**（03 章 3.9）。
這一節把它們收斂成一份設定檔。⚠️ **每一行後面的節號就是「為什麼要這一行」。**

```conf
################################ 網路與安全 ################################
bind 0.0.0.0                       # ⚠️ 依你的網段收斂，不要真的對公網開
protected-mode yes
port 6379
tcp-keepalive 300
maxclients 10000                   # 連線數上限（06 章 6.7：算一次「實例數 × 連線池」）

# ⚠️ 00 章 0.4.5：實驗機才開 DEBUG，正式環境**不要有這一行**
# enable-debug-command yes

################################ 記憶體與淘汰（04 章） ################################
maxmemory 6gb                      # 實體記憶體的 60～70%，留給 fork 與碎片（4.2.1、4.5.3）
maxmemory-policy allkeys-lru       # ⚠️ 快取那台用這個；狀態那台見下方（4.9.1）
maxmemory-samples 5                # 5 已經 99% 準確，最多調到 10（4.3.4）

################################ 延遲防線（03 章） ################################
slowlog-log-slower-than 5000       # 5 毫秒（3.5.1）
slowlog-max-len 512
latency-monitor-threshold 100      # ⚠️ 預設 0 ＝ 關閉（3.6.3）
lazyfree-lazy-user-del yes         # 所有 DEL 自動變 UNLINK（3.4.2 ④、01 章 1.3.2）
lazyfree-lazy-user-flush yes
lazyfree-lazy-expire yes
lazyfree-lazy-eviction yes
lazyfree-lazy-server-del yes
replica-lazy-flush yes             # 全量同步時清空舊資料也交給背景（13 章 13.2.8）
io-threads 1                       # ⚠️ 確認瓶頸真的在 I/O 之前不要開（3.2.3）

################################ 腳本（05 章） ################################
busy-reply-threshold 5000          # 腳本跑超過 5 秒才開始對別人回 BUSY（5.8.1）

################################ 編碼門檻（02 章 2.8.4） ################################
hash-max-listpack-entries 512      # ⚠️ 網路文章常寫 128，那是 ziplist 時代的值
hash-max-listpack-value 64
list-max-listpack-size -2          # 負數 ＝ 每個節點 8 KB
set-max-intset-entries 512
set-max-listpack-entries 128
set-max-listpack-value 64
zset-max-listpack-entries 128
zset-max-listpack-value 64

################################ 複製（13 章） ################################
replica-read-only yes              # 13.2.2：永遠不要改成 no
repl-backlog-size 64mb             # ⚠️ 預設 1mb ＝ 只能容忍 0.2 秒的斷線（13.2.8）
repl-backlog-ttl 3600
repl-diskless-sync yes
client-output-buffer-limit replica 512mb 128mb 60   # 13.2.8：寫入量大時要調
min-replicas-to-write 0            # ⚠️ 設 1 之前先處理 NOREPLICAS（13.2.6）
min-replicas-max-lag 10

################################ 事件通知 ################################
notify-keyspace-events ""          # ⚠️ 11 章的 indexed session 需要 Egx；
                                   #    但 13.7.8：Cluster 上只收得到 1/N，不要拿它做「一定要發生」的事
```

**兩種角色的差異**（04 章 4.9.1 那張表的設定檔版本）：

```conf
############ ① 快取那台：掉了可以重算，但不要讓資料庫被冷啟動打爆（4.8.2） ############
maxmemory-policy allkeys-lru
save 300 10000                     # 只開 RDB，而且設得寬鬆
appendonly no

############ ② 狀態那台：Session、冪等鍵、限流計數、預扣庫存 ############
maxmemory-policy noeviction        # ⚠️ 不是 allkeys-lru（11 章 11.6.4：被驅逐的是別人的購物車）
save ""                            # RDB 交給 AOF 的 base 檔（4.6.1）
appendonly yes
appendfsync everysec               # 斷電最多掉 1 秒（4.6.2、4.7）
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
stop-writes-on-bgsave-error yes    # ⚠️ 它會讓寫入全部失敗——但你要的就是被通知（4.9.3）
```

**危險命令：用 ACL，不要用 `rename-command`**（後者在 Redis 7 已經不建議）：

```conf
# 給應用程式用的帳號：能做業務，不能做維運
user app on >「你的密碼」 ~* &* +@all -flushall -flushdb -keys -debug -shutdown -replicaof -acl
# 預設帳號關掉
user default off
```

> ⚠️ **不要偷懶寫 `-@dangerous`。**
> `@dangerous` 這個分類裡面有 **`info`、`config|get`、`slowlog|get`、`latency|*`**——
> 一關下去，**03 章那四個觀測工具與你的監控採集會全部沒有權限**，
> 而症狀是「監控圖表突然全空」。**要擋就一條一條列出來。**
>
> 用 `ACL CAT dangerous` 可以自己看一次那份清單。

⚠️ **最後三件事，每一件都出過事：**

| | |
|---|---|
| **設定檔必須可寫** | Sentinel 會把 `replicaof` 寫回 `redis.conf`、把 `myid` 寫回 `sentinel.conf`，Cluster 會寫 `nodes.conf`。⚠️ **掛成唯讀的 ConfigMap 就等著切換失敗**（13 章 13.4.5、13.6.1） |
| **`CONFIG SET` 之後要 `CONFIG REWRITE`** | 否則下一次重啟，你在事故當下調的那些值全部消失（03 章 3.9） |
| **上線前把這份檔案跟 `CONFIG GET` 對一次** | 映像的預設值、雲端託管服務的強制值，都可能跟你以為的不一樣（14.9.11） |

### 14.9.10 三條規約（接續 13 章 13.10.3 的第 41 條）

42. ⚠️ **任何「Redis 相關」的 bug 修好之後，必須先有一個會紅的測試，才准提交修法。**
    這一站的每一個 ⚠️ 都是別人用事故換來的；**沒有測試釘住的修法，三個月後會被改回去。**
43. **併發測試一律用 14.5.2 的 harness**（起跑線 ＋ 正確實作的對照組），
    ⚠️ **不接受「我跑了幾次都沒事」**。
44. ⚠️ **`@Tag("slow")` 那一層（Cluster、Sentinel、降級演練）必須在 CI 裡自動跑**，
    不可以是「上線前手動跑一次」。

### 14.9.11 升級路徑：7.2 之後有什麼（00 章 0.6.3 那句話的回收）

本站從頭到尾釘在 **Redis 7.2**，理由是 00 章 0.6.3 說的：多數團隊的正式環境就在這個版本附近。
但你遲早要回答「要不要升」，所以把分岔講清楚：

| 版本 | 跟這一站有關的改變 | 要不要為它升級 |
|---|---|---|
| **7.4** | **Hash 的欄位級 TTL**（`HEXPIRE` / `HPEXPIRE` / `HTTL` / `HPERSIST`）——02 章 2.4.7 那個「整個 hash 只能有一個 TTL」的限制終於沒了 | ⚠️ 只有「購物車／Session 想讓單一欄位自己過期」這類需求才值得 |
| **8.x** | 把原本 Redis Stack 的資料型別（JSON、時間序列、查詢）併進核心；效能改善 | 本站不用那些型別（00 章 0.6.3），**升級的理由通常是效能與支援週期，不是功能** |
| **Valkey**（Redis 7.2.4 的分支，Linux Foundation） | 命令與行為跟 7.2 相容；8.x 之後在 I/O 執行緒與記憶體上做了不少改善 | 多半是**授權**決策，不是技術決策 |

📌 **對這一站的影響：幾乎沒有。**
00～13 章教的命令、資料結構、原子性、複製與 Cluster 行為，**在上面三條路上都一樣**。

⚠️ **但升級前一定要做三件事，而它們正好就是前面幾章的內容：**

1. **把預設值重新確認一次**——本站警告過的每一個「預設值地雷」
   （`maxmemory-policy`、`appendfsync`、`repl-backlog-size`、`cluster-require-full-coverage`）
   都可能在新版本有不同的預設。**用 `CONFIG GET` 對一次，不要假設。**
2. **客戶端要跟著升**——Lettuce / Redisson 對新版本的 `RESP3`、Cluster 拓樸、
   錯誤訊息格式都可能有差（13 章那幾個「錯誤訊息長什麼樣」的實測會變）。
3. ⚠️ **在測試環境跑一次 14.6 的那組測試**——Cluster 的 `CROSSSLOT`、
   Sentinel 的 failover 時間，就是為了這種時候而寫的。

> 📌 **一句話**：**升級 Redis 不是「換一個更快的 Redis」，是「換一組預設值」。**
> 而這一站每一章的 ⚠️，有一半都是預設值造成的。

---

## 14.10 常見誤區

**① 「測 Redis 太麻煩，用 mock 就好」**

14.2：Testcontainers 起一台 7.2 只要 0.7 秒，整章 36 個測試 32.9 秒。
⚠️ **而 mock 測不出這一站的任何一個 ⚠️**——序列化、TTL、原子性、`CROSSSLOT` 全都是真 Redis 才有的行為。

**② 「用 embedded Redis 比較快也比較乾淨」**

14.3：它是 **Redis 2.8.19（2014 年）**，macOS 的二進位檔是 x86_64，
在 Apple Silicon 上**根本起不來**，而且 `UNLINK`、`MEMORY USAGE`、LFU、listpack 全都沒有。

**③ 「`@Container` 加不加 `static` 沒差」**

14.2.3 實測：**差 2.4 倍**，而且是每個測試多 350 毫秒的線性成本。

**④ 「Testcontainers 說找不到 Docker，一定是 Docker 沒開」**

14.2.5：原因可能是 **Docker Engine 29 的 `MinAPIVersion=1.44`**，
`docker ps` 完全正常。**診斷要從 `curl --unix-socket … /version` 開始。**

**⑤ 「`@DataRedisTest` 比 `@SpringBootTest` 好，因為快」**

14.4.2：它給你一個 `NoOpCacheManager`，**你的快取測試全部是假的，而且全部通過。**

**⑥ 「快取測試斷言回傳值就夠了」**

14.4.3：要斷言 **Redis 裡真的有那個 key、key 長什麼樣、TTL 是多少**。
⚠️ 只斷言回傳值的話，`spring.cache.redis.time-to-live` 被忽略你也不會知道。

**⑦ 「併發測試用 `newFixedThreadPool(CPU 核心數)`」**

14.5.2：**你量到的是池子的大小，不是系統的併發度**（137 vs 175）。

**⑧ 「測試加 `@Transactional` 才會自動回滾，很乾淨」**

14.5.3：**20 個子執行緒全部失敗，而測試是綠的。**

**⑨ 「併發測試跑了幾次都沒事，應該沒問題」**

14.5.2：⚠️ **沒有起跑線的 harness 本來就抓不穩**（130 → 153 → 153）。
而且 13.5.6 那種「要外部狀態配合」的競態，**跑六次只重現一次**——
**要主動製造那個狀態，不是多跑幾次。**

**⑩ 「共用容器很好，測試之間不會互相影響」**

14.5.4：測試二讀到測試一寫的 `cart:u1 = 3`。

**⑪ 「`flushAll()` 放 `@BeforeEach` 就萬無一失」**

14.5.4：⚠️ **平行執行時它會清掉正在跑的別的測試的資料**，
而那會變成「隨機失敗，重跑就好」的那種測試。

**⑫ 「Cluster / Sentinel 沒辦法在 CI 裡測」**

14.6：Cluster 3.7 秒、Sentinel failover 7.9 秒。

**⑬ 「Lettuce 的指標 Spring Boot 會自動接」**

14.7.1：⚠️ **預設是關的**，而且 `histogram(true)` 不開就沒有 P99。

**⑭ 「`NoSuchElementException` 是程式 bug」**

14.7.2：那是 **commons-pool2 的連線池耗盡**，訊息裡沒有「Redis」兩個字。
⚠️ **而且它常常是「Redis 變慢」的下游症狀，調大池子只會讓更多執行緒一起卡住。**

**⑮ 「把 key 當成 Micrometer 的標籤，就能找出 hot key」**

14.8.3：⚠️ **十萬個標籤會先把 Prometheus 打倒。**
模板進 Micrometer，精確 key 留在應用內的**有界**計數表。

---

## 14.11 本章小結

**這一章只有一句話：**

> 📌 **一個「會過」的測試沒有價值。有價值的是「在你寫壞的時候會紅」的測試。**

這一章的四個實測，全部是「會過但沒價值」的例子：

```
   ① @DataRedisTest ＋ @Cacheable   →  NoOpCacheManager，查了 3 次資料庫     測試：綠 ✅
   ② @Transactional 的併發測試       →  20 個子執行緒全部失敗                  測試：綠 ✅
   ③ 池子只有 4 條執行緒             →  量到 137 件，真實是 175 件            測試：綠 ✅
   ④ 共用容器沒清資料                →  讀到上一個測試的資料                   測試：綠 ✅
```

**而讓它們變得有價值的，都是同一件事：斷言「機制」而不是「結果」。**

| 不要斷言 | 要斷言 |
|---|---|
| `loadName(1L)` 回傳 `"product-1"` | ⚠️ **資料庫只被查了 1 次、Redis 裡有 `lab14:v1:product::1`、TTL 是 2 秒** |
| `orders == 100` | ⚠️ **`orders − (初始庫存 − 剩餘庫存) == 0`** |
| 「Cluster 上跑得起來」 | ⚠️ **跨槽的 Lua 必須丟 `CROSSSLOT`** |
| 「Sentinel 會切換」 | ⚠️ **客戶端在 `down-after + 3` 秒內恢復** |

```
   測試金字塔（這一站的版本）

      ┌──────────────────────────────────────────┐
      │  @Tag("slow")：Cluster / Sentinel /       │  每晚 ＋ merge 前
      │  降級演練 / TTL 邊界                       │  幾分鐘
      ├──────────────────────────────────────────┤
      │  整合測試（單例容器 ＋ 真 Redis 7.2）        │  每次 push
      │  快取 / 鎖 / 限流 / 冪等 / 預扣庫存          │  < 60 秒
      ├──────────────────────────────────────────┤
      │  單元測試：序列化器 / key 命名 /            │  每次存檔
      │  Lua 的純邏輯 / 演算法的數學                 │  < 5 秒
      └──────────────────────────────────────────┘

      ⚠️ 這個金字塔裡沒有 mock Redis 那一層 —— 它測不到任何一個 ⚠️。
```

### 14.11.1 驗收清單

- [ ] 用 Testcontainers 起一台 Redis，並說出 `@ServiceConnection` 比 `@DynamicPropertySource` 多做了什麼。
- [ ] ⚠️ 說得出 `@Container` 少一個 `static` 的代價，以及單例容器多省了什麼（提示：不只是容器）。
- [ ] 診斷一次「Could not find a valid Docker environment」，說得出四個診斷步驟。
- [ ] 說得出 embedded Redis 的兩個致命問題，並拿得出證據。
- [ ] ⚠️ 說得出 `@DataRedisTest` 裡的 `CacheManager` 是什麼，以及為什麼快取測試會變成假的。
- [ ] 寫出一個含**起跑線 ＋ 對照組**的併發 harness。
- [ ] 說得出「超賣」正確的計算方式，以及為什麼不能只斷言訂單數。
- [ ] ⚠️ 說得出併發測試加 `@Transactional` 會發生什麼，以及為什麼測試還是綠的。
- [ ] 寫出一個「要求它失敗」的 `CROSSSLOT` 測試。
- [ ] 說得出 `lettuce.command.completion` 與 `firstresponse` 的差代表什麼。
- [ ] ⚠️ 認得 `NoSuchElementException: Timeout waiting for idle object`，並說出它的三種成因。
- [ ] 量出 big key 對「旁邊那個無辜的 `GET`」造成多少延遲。
- [ ] 說得出 hot key 埋點為什麼要分兩層，以及為什麼精確 key 不能進 Micrometer。
- [ ] 把 14.9 的檢查清單對著自己的專案走一遍，**列出你還沒做的那幾條**。

### 14.11.2 本章練習

**練習一（20 分鐘）**：把 14.2.3 重現一次。在你自己的專案裡找一個測試類別，
把 `@Container` 的 `static` 拿掉，量總耗時。**然後算：如果全專案都這樣寫，要多花多久？**

**練習二（25 分鐘）**：把你專案裡所有 `@DataRedisTest` 找出來，
在每一個裡面印 `ctx.getBean(CacheManager.class).getClass()`。
⚠️ **有幾個是 `NoOpCacheManager`？那幾個測試在測什麼？**

**練習三（30 分鐘，核心）**：把 14.5.2 的 harness 抄進你的專案，
拿它跑你最擔心的那一段併發邏輯。**⚠️ 一定要加對照組**（一個你確定正確的實作）。

**練習四（20 分鐘）**：把練習三的測試加上 `@Transactional`，再跑一次。
**記錄子執行緒的失敗數，並確認測試仍然是綠的。**

**練習五（30 分鐘）**：實作 14.4.3 的三個斷言。
然後：① 把 `spring.cache.redis.time-to-live` 改掉，確認測試會紅；
② 把 key 前綴的 `v1` 拿掉，確認測試會紅。

**練習六（40 分鐘，核心）**：把 14.6.1 的 Cluster 容器接進你的專案，
然後把**你所有的 Lua** 都在上面跑一次。⚠️ **列出失敗的那幾段。**

**練習七（40 分鐘）**：把 14.6.4 的 Sentinel failover 測試接進 CI。
然後：① 把 `ClientResources` 那個 bean 註解掉，確認測試會紅；
② 把 `down-after-milliseconds` 從 2000 改成 5000，**調整斷言而不是放寬它**。

**練習八（30 分鐘）**：接上 14.7.1 的指標，壓一次你的服務，
畫出 `completion` 與 `firstresponse` 兩條線。⚠️ **它們的差是多少？**

**練習九（進階，60 分鐘）**：實作 14.8.3 的兩層 hot key 偵測，
接到你的 `RedisTemplate` 上（AOP 或包一層 wrapper），
**在正式環境跑一天，看前 10 名是什麼。**

**練習十（進階，90 分鐘）**：走完 14.9 的檢查清單。
⚠️ **每一條沒打勾的，開一張票，寫上對應的節號。**

---

## 14.12 全站回顧

十五章，兩個部分。**回頭看，整站其實只在回答三個問題。**

### 問題一：這份資料放 Redis 裡，是什麼形狀、多大、活多久

```
   00  起一台，看懂 INFO
   01  key、TTL ——⚠️ SET 會洗掉 TTL；過期不等於立刻消失
   02  五種結構 ——⚠️ 同一份資料，三種存法差好幾倍
   04  記憶體與淘汰 ——⚠️ 沒設 maxmemory，驅逐掉的是別人的購物車
   06  序列化 ——⚠️ 改個套件名，整個快取讀不回來
```

### 問題二：兩個人同時動同一份資料會怎樣

```
   03  單執行緒 ——「同時」在 Redis 裡是假的，⚠️ 但 big key 會卡住所有人
   05  原子性 ——⚠️ 只有 Lua 是真的原子，MULTI 失敗不回滾
   09  分散式鎖 ——⚠️ 六種寫法，五種會超賣
   10  限流與冪等 ——⚠️ 「先查有沒有做過再做」跟完全不做一樣
   12  預扣庫存 ——⚠️ 真正保證不超賣的是那條 SQL，不是 Redis
```

### 問題三：它壞掉的時候，你的服務長什麼樣子

```
   07  快取 ——⚠️ 改版後每個請求都 500
   08  降級 ——⚠️ 預設設定下，Redis 掛掉時資料庫一次都不會被查到
   11  Session ——⚠️ Redis 重開 ＝ 全站靜默登出
   13  高可用 ——⚠️ 切換丟掉 38.4% 已經回 OK 的寫入；客戶端比 Sentinel 慢 2.8 秒
   14  測試 ——⚠️ 讓上面每一個 ⚠️ 在上線前就變成紅色
```

📌 **而整站最重要的一句話，在 12 章講過一次，13 章證明了一次：**

> **Redis 是過濾器，不是帳本。**
>
> 12.3.3 說它「讓 95% 注定失敗的請求碰不到資料庫」——那是它的價值。
> 13.2.3 量出「一次切換丟掉 38.4% 已經回 OK 的寫入」——那是它的代價。
>
> **兩句話合起來就是：把 Redis 放在對的位置上。**
> **它前面擋流量，後面有一條 `UPDATE … WHERE stock > 0` 兜底。**

---

### 你現在手上有什麼

```
   一個 shop-service，它：
     ✅ 序列化設定經得起改版（06）
     ✅ 快取有 TTL、有版本前綴、清得乾淨（07）
     ✅ Redis 掛掉 60 秒，錯誤率 0%、資料庫 QPS 沒漲（08）
     ✅ 200 個人搶 100 件，賣出去剛好 100 件（09、12）
     ✅ 限流會回 Retry-After，冪等鍵不會重複扣款（10）
     ✅ 多實例 Session 共享，token 撤得掉（11）
     ✅ 主掛了 6.7 秒自己接上，Cluster 上每一段 Lua 都跑得動（13）
     ✅ 上面每一條都有一個會紅的測試（14）

   以及一份你自己跑出來的數字表 ——
   ⚠️ 課文裡的每一個數字都是在「本站的機器」上量的。
      你的機器不一樣，你的流量不一樣，你的容忍度不一樣。
      📌 真正該帶走的不是那些數字，是量它們的方法。
```

**十五章結束。**

> 📌 **最後一件事：把 14.9 那份清單存成你團隊的 `REDIS-CHECKLIST.md`。**
> 它不是給你一個人看的——**它是給三個月後接手的那個人看的。**
