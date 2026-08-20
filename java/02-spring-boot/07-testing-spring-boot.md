# 第 07 章：Spring Boot 測試策略

> 大部分團隊的 Spring Boot 測試都有同一個問題：**每個測試類別都掛 `@SpringBootTest`**。
>
> 症狀是這樣演進的：
> - 專案小的時候：測試跑 40 秒，沒人在意。
> - 半年後：測試跑 6 分鐘，開始有人在本機跳過測試。
> - 一年後：測試跑 22 分鐘，CI 排隊排到下班，`-DskipTests` 變成慣例。
> - 一年半後：測試因為長期沒人修而全紅，直接從 CI 移除。
>
> **測試被放棄不是因為「大家不想寫測試」，是因為它太慢。**
>
> 這一章的核心不是教你 `assertThat` 怎麼寫（01-java-core 第 11 章已經講完了），
> 而是教你**選對測試的層級**——什麼該用純單元測試、什麼該用切片測試、什麼才真的需要啟動整個應用程式。
> 以及一個大多數人不知道但威力極大的機制：**測試 context 快取**。

---

## 7.1 學習目標

完成本章後，你應該可以：

- 說出 Spring Boot 專案的測試分層，並判斷一個需求該寫在哪一層。
- 說明 `spring-boot-starter-test` 帶進了哪些函式庫，各自負責什麼。
- **解釋測試 context 快取的機制**，說出哪些行為會造成快取失效。
- 用 `@SpringBootTest` 的四種 `webEnvironment`，並知道各自的適用場景。
- 熟練六種切片測試（`@WebMvcTest`、`@DataJpaTest`、`@JdbcTest`、`@JsonTest`、`@RestClientTest`、`@DataRedisTest`）。
- 正確使用 `@MockitoBean` / `@MockitoSpyBean`（以及它們取代的 `@MockBean` / `@SpyBean`）。
- 用 MockMvc 與 `MockMvcTester` 測 Web 層，並知道它「不經過真實伺服器」的意義。
- 說明為什麼「用 H2 測試會騙你」，並用 Testcontainers + `@ServiceConnection` 跑真實資料庫。
- 讓 Testcontainers 在本機開發時能重複使用容器，把測試時間從分鐘降到秒。
- 測試設定、事件、非同步、排程、AOP 這些「基礎設施」程式碼。
- 建立測試分流策略（快測試 vs 慢測試），讓 CI 與本機開發都能維持快速回饋。
- 診斷「測試很慢」「測試偶發失敗」「測試互相影響」三類問題。

---

## 7.2 先看見痛：一個 22 分鐘的測試套件

### 現場

```
$ ./mvnw test
...
[INFO] Tests run: 412, Failures: 0, Errors: 0, Skipped: 0
[INFO] Total time:  22:37 min
```

用 `--debug` 觀察，會看到這樣的訊息重複出現：

```
o.s.t.c.support.DefaultTestContextBootstrapper : Neither @ContextConfiguration nor ...
o.s.b.t.c.SpringBootTestContextBootstrapper    : Found @SpringBootConfiguration ...
o.s.w.c.s.GenericWebApplicationContext         : Root WebApplicationContext: initialization completed in 3211 ms
o.s.w.c.s.GenericWebApplicationContext         : Root WebApplicationContext: initialization completed in 3184 ms
o.s.w.c.s.GenericWebApplicationContext         : Root WebApplicationContext: initialization completed in 3297 ms
...  ← 出現了 47 次
```

**Spring context 被建立了 47 次，每次 3 秒 = 141 秒只在啟動容器。**
再加上每次都跑 Flyway 遷移、每次都建連線池、每次都掃描 JPA Entity。

### 為什麼會這樣

```java
// OrderServiceTest.java
@SpringBootTest
class OrderServiceTest { }

// PaymentServiceTest.java
@SpringBootTest
@ActiveProfiles("test")                    // ★ 不同的 profile → 不同的 context ★
class PaymentServiceTest { }

// OrderControllerTest.java
@SpringBootTest
@AutoConfigureMockMvc                      // ★ 不同的設定 → 又一個 context ★
class OrderControllerTest { }

// InventoryServiceTest.java
@SpringBootTest
@MockBean(PaymentGateway.class)            // ★ 有 mock → 又一個 context ★
class InventoryServiceTest { }

// SettlementTest.java
@SpringBootTest
@TestPropertySource(properties = "shop.batch.enabled=true")   // ★ 又一個 ★
class SettlementTest { }

// CacheTest.java
@SpringBootTest
@DirtiesContext                            // ★★ 直接毀掉快取 ★★
class CacheTest { }
```

**每一個「不同的設定組合」都會產生一個新的 context。**
而且 `@DirtiesContext` 會把那個 context 從快取中移除，導致後面的測試又要重建。

### 目標

同一個專案，重新設計測試策略之後：

```
$ ./mvnw test
[INFO] Tests run: 587, Failures: 0, Errors: 0, Skipped: 0     ← 測試更多了
[INFO] Total time:  1:48 min                                   ← 快了 12 倍
```

怎麼做到的：

| 措施 | 效果 |
|---|---|
| 商業邏輯改用純單元測試（不啟動 Spring） | 300+ 個測試從 3 秒變 3 毫秒 |
| Web 層改用 `@WebMvcTest` 切片 | context 小很多，啟動 0.8 秒 |
| 統一 `@SpringBootTest` 的設定組合 | 47 個 context 降到 3 個 |
| 移除所有非必要的 `@DirtiesContext` | 快取真正生效 |
| Testcontainers 容器重複使用 | 資料庫容器啟動一次而不是三次 |

---

## 7.3 測試分層

```
                    ▲  慢、貴、脆弱、覆蓋範圍大
                   ╱ ╲
                  ╱   ╲    E2E / 系統測試（5%）
                 ╱─────╲   @SpringBootTest(RANDOM_PORT) + Testcontainers
                ╱       ╲  真的起伺服器、真的連資料庫
               ╱─────────╲
              ╱           ╲ 整合 / 切片測試（20%）
             ╱             ╲ @WebMvcTest / @DataJpaTest / ApplicationContextRunner
            ╱───────────────╲ 只載入需要的那一層
           ╱                 ╲
          ╱                   ╲ 單元測試（75%）
         ╱                     ╲ 純 JUnit，完全不碰 Spring
        ╱_______________________╲ new 出來就測
                    快、便宜、穩定、覆蓋範圍小
```

### 判斷準則：這個測試該寫在哪一層

| 你要驗證什麼 | 測試層級 | 工具 |
|---|---|---|
| 金額計算、狀態機轉換、驗證規則 | **單元** | 純 JUnit + AssertJ |
| DTO ↔ Entity 轉換 | **單元** | 純 JUnit |
| Service 的業務流程（用假的 Repository） | **單元** | JUnit + 手寫 fake 或 Mockito |
| HTTP 路由、參數綁定、驗證、錯誤格式 | **切片** | `@WebMvcTest` |
| JPA 映射、關聯、查詢方法 | **切片** | `@DataJpaTest` + Testcontainers |
| JSON 序列化格式 | **切片** | `@JsonTest` |
| 外部 API 用戶端 | **切片** | `@RestClientTest` |
| 自動組態、條件式 Bean | **切片** | `ApplicationContextRunner`（第 02 章） |
| 交易邊界、事件、AOP 生效 | **整合** | `@SpringBootTest`（最小設定） |
| 完整的下單流程（含 HTTP + DB） | **E2E** | `@SpringBootTest(RANDOM_PORT)` |

> **最重要的一句話：能不啟動 Spring 就不要啟動。**
>
> 「這段程式碼需要 Spring 才能測」通常代表**設計有問題**——
> 依賴沒有從外面注入、邏輯與框架綁太緊。
> 回頭看第 01 章 1.2 那個重構：建構子注入 + 介面抽象，
> 讓 `OrderService` 完全可以 `new` 出來測。

---

## 7.4 `spring-boot-starter-test` 裡有什麼

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-test</artifactId>
    <scope>test</scope>
</dependency>
```

一行帶進來：

| 函式庫 | 用途 |
|---|---|
| **JUnit 5**（Jupiter） | 測試框架 |
| **AssertJ** | 流暢的斷言（`assertThat(x).isEqualTo(y)`） |
| **Mockito** | mock 框架（含 `mockito-junit-jupiter`） |
| **Hamcrest** | 匹配器（MockMvc 的 `jsonPath` 會用到） |
| **JSONassert** | JSON 比對（容許欄位順序不同） |
| **JsonPath** | 從 JSON 取值 |
| **XMLUnit** | XML 比對 |
| **spring-test** | Spring 的測試支援（`TestContext` 框架） |
| **spring-boot-test** | Boot 的測試支援（`@SpringBootTest` 等） |
| **spring-boot-test-autoconfigure** | 切片測試的自動組態 |
| **awaitility** | 非同步等待（Boot 3.x 起納入） |

> 01-java-core 第 11 章已經完整介紹 JUnit 5、AssertJ、Mockito 的用法。
> **這一章只講「與 Spring 相關」的部分**，不重複語法。

### 額外常用的（要自己加）

```xml
<!-- Testcontainers（7.10） -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-testcontainers</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>mysql</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
</dependency>

<!-- WireMock：模擬外部 HTTP 服務 -->
<dependency>
    <groupId>org.wiremock</groupId>
    <artifactId>wiremock-standalone</artifactId>
    <version>3.9.1</version>
    <scope>test</scope>
</dependency>

<!-- ArchUnit：架構規則測試（第 04 章用過） -->
<dependency>
    <groupId>com.tngtech.archunit</groupId>
    <artifactId>archunit-junit5</artifactId>
    <version>1.3.0</version>
    <scope>test</scope>
</dependency>
```

---

## 7.5 ★★ 測試 Context 快取 ★★

**這是本章最重要的一節。理解它，你的測試就能快 10 倍。**

### 機制

Spring 的 `TestContext` 框架會**快取已建立的 `ApplicationContext`**，
在同一次測試執行（JVM）中重複使用。

**快取的 key 是由這些東西組合出來的：**

```
① locations / classes          @ContextConfiguration 指定的設定
② contextInitializerClasses    ApplicationContextInitializer
③ activeProfiles               @ActiveProfiles
④ propertySourceDescriptors    @TestPropertySource 的檔案
⑤ propertySourceProperties     @TestPropertySource / @SpringBootTest 的 properties
⑥ contextCustomizers           ★ 這一項最容易被忽略 ★
   ├─ MockitoBean / MockitoSpyBean 的定義
   ├─ webEnvironment 設定
   ├─ @DynamicPropertySource
   └─ 各種 @AutoConfigureXxx
⑦ parent                       父 context
⑧ contextLoader                載入器類別
```

**只要其中任何一項不同，就是一個新的 context。**

### 用實驗看清楚

```java
package com.example.shop.cache;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class ContextCacheATest {

    @Autowired ApplicationContext context;

    @Test
    void printContextId() {
        System.out.println("A 的 context：" + System.identityHashCode(context));
    }
}
```

```java
@SpringBootTest
class ContextCacheBTest {

    @Autowired ApplicationContext context;

    @Test
    void printContextId() {
        System.out.println("B 的 context：" + System.identityHashCode(context));
    }
}
```

```java
@SpringBootTest
@org.springframework.test.context.ActiveProfiles("test")     // ★ 只多了這一行 ★
class ContextCacheCTest {

    @Autowired ApplicationContext context;

    @Test
    void printContextId() {
        System.out.println("C 的 context：" + System.identityHashCode(context));
    }
}
```

執行結果：

```
A 的 context：1234567          ← 建立
B 的 context：1234567          ← ★ 重複使用（相同設定）★
C 的 context：7654321          ← ★ 新建立（profile 不同）★
```

日誌裡也看得出來：

```
Root WebApplicationContext: initialization completed in 3211 ms    ← A 建立
（B 沒有這行，直接用快取）
Root WebApplicationContext: initialization completed in 3184 ms    ← C 建立
```

### 查看快取統計

```yaml
# src/test/resources/logback-test.xml 或用 application.properties
logging:
  level:
    org.springframework.test.context.cache: DEBUG
```

```
Spring test ApplicationContext cache statistics:
  [DefaultContextCache@1a2b3c size = 3, maxSize = 32, parentContextCount = 0,
   hitCount = 44, missCount = 3]
```

| 欄位 | 意義 |
|---|---|
| `size` | 目前快取了幾個 context |
| `maxSize` | 上限（預設 32，可用 `spring.test.context.cache.maxSize` 調整） |
| `hitCount` | 命中次數（越高越好） |
| `missCount` | **建立次數（越低越好）** |

> **健康的比例**：`missCount` 應該是**個位數**。
> 如果 `missCount` 超過 10，就要去找「哪些測試的設定組合不一樣」。

### ⚠️ 超過 `maxSize` 會發生什麼

快取用 **LRU** 淘汰。超過 32 個之後，最少使用的會被關閉。
如果測試執行順序讓它被淘汰又需要重建，就會出現「同一個 context 被建立好幾次」。

```properties
# src/test/resources/spring.properties
spring.test.context.cache.maxSize=64
```

> **但這是治標**。正確做法是減少 context 的種類。

### 破壞快取的六個行為

#### ① `@DirtiesContext`

```java
@SpringBootTest
@DirtiesContext                     // ⚠️ 測試結束後把這個 context 從快取移除
class BadTest { }

@SpringBootTest
class AnotherTest { }               // ← 被迫重建 context
```

**`@DirtiesContext` 幾乎總是錯的解法。** 它通常被用來解決「測試互相影響」的問題，
但真正該做的是**讓測試自己清理狀態**。

```java
// ❌ 用 @DirtiesContext 掩蓋問題
@SpringBootTest
@DirtiesContext
class CacheTest {
    @Test void test1() { cache.put("key", "value"); }
}

// ✅ 自己清理
@SpringBootTest
class CacheTest {
    @Autowired CacheManager cacheManager;

    @AfterEach
    void clearCaches() {
        cacheManager.getCacheNames()
                .forEach(name -> cacheManager.getCache(name).clear());
    }

    @Test void test1() { cache.put("key", "value"); }
}
```

**唯一合理的使用時機**：測試真的改變了 context 本身
（例如關閉了 `ApplicationContext`、改變了 Bean 定義），這種情況極少。

#### ② 每個測試類別用不同的 `properties`

```java
@SpringBootTest(properties = "shop.limits.max-amount=100")     // context 1
class TestA { }

@SpringBootTest(properties = "shop.limits.max-amount=200")     // context 2
class TestB { }

@SpringBootTest(properties = "shop.limits.max-amount=300")     // context 3
class TestC { }
```

**改進：把這種「需要特定設定」的測試改用 `ApplicationContextRunner`**（第 02 章 2.12）：

```java
class LimitPropertiesTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(LimitConfig.class);

    @Test
    void 應接受不同的上限設定() {
        runner.withPropertyValues("shop.limits.max-amount=100")
              .run(context -> assertThat(context.getBean(LimitProperties.class).maxAmount())
                      .isEqualByComparingTo("100"));
    }
    // ↑ 每個 case 幾十毫秒，而且不佔用測試 context 快取
}
```

#### ③ `@MockitoBean` 的組合不同

```java
@SpringBootTest
@MockitoBean(types = PaymentGateway.class)                  // context 1
class TestA { }

@SpringBootTest
@MockitoBean(types = {PaymentGateway.class, MailSender.class})  // context 2
class TestB { }
```

**改進：把常用的 mock 組合抽成一個共用的基底類別或 `@interface`**（7.13 會給範例）。

#### ④ `webEnvironment` 不同

```java
@SpringBootTest(webEnvironment = WebEnvironment.MOCK)          // context 1（預設）
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)   // context 2
@SpringBootTest(webEnvironment = WebEnvironment.NONE)          // context 3
```

#### ⑤ `@DynamicPropertySource` 每次值都不同

```java
@DynamicPropertySource
static void props(DynamicPropertyRegistry registry) {
    registry.add("shop.random", () -> UUID.randomUUID().toString());   // ⚠️ 每次都不一樣
}
```

#### ⑥ 巢狀的 `@TestConfiguration`

```java
@SpringBootTest
class TestA {
    @TestConfiguration
    static class Config { @Bean Foo foo() { return new Foo(); } }     // context 1
}

@SpringBootTest
class TestB {
    @TestConfiguration
    static class Config { @Bean Bar bar() { return new Bar(); } }     // context 2
}
```

### 實務策略：把設定組合收斂成「幾種」

```java
package com.example.shop.support;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.lang.annotation.ElementType;
import java.lang.annotation.Inherited;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 標準整合測試設定。
 *
 * <p>★ 全專案的整合測試都用這個註解，保證只有「一個」context ★
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Inherited
@SpringBootTest
@ActiveProfiles("test")
public @interface IntegrationTest { }
```

```java
@IntegrationTest
class OrderServiceIntegrationTest { }      // 共用同一個 context

@IntegrationTest
class PaymentServiceIntegrationTest { }    // 共用同一個 context

@IntegrationTest
class SettlementIntegrationTest { }        // 共用同一個 context
```

**收斂之後：47 個 context → 3 個。啟動時間從 141 秒降到 9 秒。**

---

## 7.6 `@SpringBootTest` 詳解

### 四種 `webEnvironment`

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
// 預設值。建立 mock 的 web 環境（沒有真的伺服器、沒有 port）
// 搭配 MockMvc 使用

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// 啟動真的伺服器，用隨機 port（避免 CI 上 port 衝突）
// 搭配 TestRestTemplate / WebTestClient

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT)
// 啟動真的伺服器，用 server.port 設定的 port
// ⚠️ CI 上平行執行會衝突，盡量不要用

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
// 完全不建立 web 環境（最快）
// 測 Service / Repository 層時用這個
```

### `MOCK` vs `RANDOM_PORT`：差別比你想的大

| | MOCK + MockMvc | RANDOM_PORT + TestRestTemplate |
|---|---|---|
| 真的有伺服器 | ❌ | ✅ |
| 走完整的 HTTP 協定 | ❌ | ✅ |
| 經過 Servlet 容器（Tomcat） | ❌ | ✅ |
| 經過 `Filter` | ✅（要註冊） | ✅ |
| 經過 `DispatcherServlet` | ✅（模擬的） | ✅ |
| 測到 HTTP 標頭、狀態碼 | ✅ | ✅ |
| 測到 gzip 壓縮、chunked 編碼 | ❌ | ✅ |
| 測到連線逾時、Keep-Alive | ❌ | ✅ |
| 測試中的交易可以 rollback | ✅ | ❌（不同執行緒） |
| 速度 | 快 | 慢（要啟動 Tomcat） |

> **關鍵差異：`RANDOM_PORT` 的請求在「Tomcat 的執行緒」上執行，
> 與測試方法不是同一個執行緒。所以：**
>
> ```java
> @SpringBootTest(webEnvironment = RANDOM_PORT)
> @Transactional                        // ⚠️ 這個交易只在測試執行緒上
> class BadTest {
>     @Test
>     void test() {
>         restTemplate.postForEntity("/orders", request, Order.class);
>         // ↑ 這個請求在 Tomcat 執行緒，開的是「另一個」交易，而且會真的 commit
>         // 測試結束時 rollback 的是「測試執行緒的交易」，資料庫裡的訂單留下來了
>     }
> }
> ```
>
> **所以 `RANDOM_PORT` 的測試要自己清資料。**

### 常用的組合寫法

```java
package com.example.shop.order;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class OrderEndToEndTest {

    @LocalServerPort
    private int port;              // 取得隨機分配到的 port

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private OrderRepository orderRepository;

    @org.junit.jupiter.api.AfterEach
    void cleanUp() {
        orderRepository.deleteAll();     // ★ RANDOM_PORT 不會自動 rollback ★
    }

    @Test
    void 完整下單流程() {
        var request = new CreateOrderRequest("王小明", new BigDecimal("1280"), "LINE_PAY");

        ResponseEntity<OrderResponse> response =
                restTemplate.postForEntity("/orders", request, OrderResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().status()).isEqualTo("PAID");
        assertThat(response.getHeaders().getFirst("X-Trace-Id")).isNotBlank();   // 第 05 章的 Filter

        // 驗證真的寫進資料庫
        assertThat(orderRepository.findById(response.getBody().id())).isPresent();
    }

    @Test
    void 金額為零應回400() {
        var request = new CreateOrderRequest("王小明", BigDecimal.ZERO, "LINE_PAY");

        ResponseEntity<String> response =
                restTemplate.postForEntity("/orders", request, String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }
}
```

> **`TestRestTemplate` 與 `RestTemplate` 的差別**：
> `TestRestTemplate` **不會**對 4xx / 5xx 拋例外，而是把狀態碼放進 `ResponseEntity`。
> 這正是測試需要的行為（要能斷言錯誤狀態碼）。

---

## 7.7 切片測試：`@WebMvcTest`

### 它載入什麼、不載入什麼

```
@WebMvcTest 載入：
  ✅ @Controller / @RestController
  ✅ @ControllerAdvice / @RestControllerAdvice
  ✅ @JsonComponent
  ✅ Converter / GenericConverter
  ✅ Filter（要有 @Component 且是 Servlet Filter）
  ✅ WebMvcConfigurer
  ✅ HandlerMethodArgumentResolver
  ✅ Jackson 的 ObjectMapper 設定

@WebMvcTest 不載入：
  ❌ @Service
  ❌ @Repository
  ❌ @Component（一般的）
  ❌ DataSource / JPA
  ❌ 排程、非同步的設定
```

**所以 Service 一定要用 mock 提供。**

### 完整範例

```java
package com.example.shop.order;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.BDDMockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.time.Instant;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(OrderController.class)         // ★ 只載入這一個 Controller，更快 ★
class OrderControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;     // 用專案真實的 Jackson 設定

    @MockitoBean                            // ★ Spring Framework 6.2+ / Boot 3.4+ ★
    private OrderService orderService;

    @Test
    void 查詢訂單應回200與正確JSON() throws Exception {
        BDDMockito.given(orderService.findById(1001L))
                .willReturn(new Order(1001L, "王小明", new BigDecimal("1280.00"),
                        "LINE_PAY", "PAID", Instant.parse("2026-08-18T00:00:00Z")));

        mockMvc.perform(get("/orders/1001"))
               .andExpect(status().isOk())
               .andExpect(content().contentTypeCompatibleWith("application/json"))
               .andExpect(jsonPath("$.id").value(1001))
               .andExpect(jsonPath("$.customerName").value("王小明"))
               .andExpect(jsonPath("$.amount").value(1280.00))
               .andExpect(jsonPath("$.status").value("PAID"))
               // ★ 驗證「沒有」洩漏不該有的欄位，這種負向斷言很重要 ★
               .andExpect(jsonPath("$.internalNote").doesNotExist());
    }

    @Test
    void 訂單不存在應回404() throws Exception {
        BDDMockito.given(orderService.findById(anyLong()))
                .willThrow(new OrderNotFoundException(9999L));

        mockMvc.perform(get("/orders/9999"))
               .andExpect(status().isNotFound())
               .andExpect(jsonPath("$.code").value("ORDER_NOT_FOUND"));
    }

    @Test
    void id不是數字應回400() throws Exception {
        mockMvc.perform(get("/orders/abc"))
               .andExpect(status().isBadRequest());
    }

    @Test
    void 建立訂單應回201與Location標頭() throws Exception {
        var request = new CreateOrderRequest("王小明", new BigDecimal("1280"), "LINE_PAY");

        BDDMockito.given(orderService.placeOrder(any(), any(), any()))
                .willReturn(new Order(1001L, "王小明", new BigDecimal("1280"),
                        "LINE_PAY", "PAID", Instant.now()));

        mockMvc.perform(post("/orders")
                        .contentType("application/json")
                        .content(objectMapper.writeValueAsString(request)))
               .andExpect(status().isCreated())
               .andExpect(header().string("Location", "/orders/1001"));
    }

    @Test
    void 金額為負應回400且不呼叫Service() throws Exception {
        var request = new CreateOrderRequest("王小明", new BigDecimal("-1"), "LINE_PAY");

        mockMvc.perform(post("/orders")
                        .contentType("application/json")
                        .content(objectMapper.writeValueAsString(request)))
               .andExpect(status().isBadRequest())
               .andExpect(jsonPath("$.errors[0].field").value("amount"));

        // ★ 驗證「Service 完全沒被呼叫」——驗證失敗應該在 Controller 層就擋下來 ★
        BDDMockito.then(orderService).shouldHaveNoInteractions();
    }

    @Test
    void 缺少必填欄位應回400() throws Exception {
        mockMvc.perform(post("/orders")
                        .contentType("application/json")
                        .content("{\"amount\":100}"))       // 缺 customerName
               .andExpect(status().isBadRequest());
    }
}
```

### `@MockitoBean` 取代 `@MockBean`

| 舊（Boot 3.3 及之前） | 新（Spring Framework 6.2 / Boot 3.4+） |
|---|---|
| `@MockBean` | **`@MockitoBean`** |
| `@SpyBean` | **`@MockitoSpyBean`** |

```java
// ❌ 已棄用（仍可用，但會有 deprecation 警告）
import org.springframework.boot.test.mock.mockito.MockBean;
@MockBean private OrderService orderService;

// ✅ 新寫法
import org.springframework.test.context.bean.override.mockito.MockitoBean;
@MockitoBean private OrderService orderService;
```

**為什麼要換**：新的 `@MockitoBean` 建立在 Spring Framework 的
**Bean Override** 通用機制上（`@TestBean`、`@MockitoBean`、`@MockitoSpyBean` 同一套），
而且不再是 Spring Boot 專屬——純 Spring 專案也能用。

> **遷移注意**：`@MockitoBean` 的 `reset` 預設值與 `@MockBean` 相同（`AFTER` 每個測試方法後重置），
> 所以行為一致，可以直接替換。第 09 章會列進遷移清單。

### `MockMvcTester`：AssertJ 風格【Boot 3.4+】

```java
package com.example.shop.order;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.assertj.MockMvcTester;

import java.math.BigDecimal;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.BDDMockito.given;

@WebMvcTest(OrderController.class)
class OrderControllerTesterTest {

    @Autowired
    private MockMvcTester mvc;             // ★ Spring Framework 6.2+ ★

    @MockitoBean
    private OrderService orderService;

    @Test
    void 查詢訂單() {
        given(orderService.findById(1001L)).willReturn(
                new Order(1001L, "王小明", new BigDecimal("1280.00"),
                        "LINE_PAY", "PAID", Instant.now()));

        // ★ AssertJ 風格，不用 throws Exception，錯誤訊息也更清楚 ★
        assertThat(mvc.get().uri("/orders/1001"))
                .hasStatusOk()
                .bodyJson()
                .hasPathSatisfying("$.customerName", v -> assertThat(v).isEqualTo("王小明"))
                .hasPathSatisfying("$.amount", v -> assertThat(v).isEqualTo(1280.00));
    }

    @Test
    void 直接比對整份JSON() {
        given(orderService.findById(1001L)).willReturn(
                new Order(1001L, "王小明", new BigDecimal("1280.00"),
                        "LINE_PAY", "PAID", Instant.parse("2026-08-18T00:00:00Z")));

        assertThat(mvc.get().uri("/orders/1001"))
                .hasStatusOk()
                .bodyJson()
                .isLenientlyEqualTo("""
                        {
                          "id": 1001,
                          "customerName": "王小明",
                          "amount": 1280.00,
                          "status": "PAID"
                        }
                        """);    // isLenientlyEqualTo：容許多餘欄位、不管順序
    }

    @Test
    void 例外的斷言也更直接() {
        given(orderService.findById(9999L)).willThrow(new OrderNotFoundException(9999L));

        assertThat(mvc.get().uri("/orders/9999"))
                .hasStatus(org.springframework.http.HttpStatus.NOT_FOUND);
    }
}
```

> **`MockMvcTester` 的最大好處是錯誤訊息**。
> MockMvc 的 `jsonPath` 失敗時訊息很難讀；`MockMvcTester` 用 AssertJ，
> 失敗訊息會直接告訴你「期望 X 實際 Y」，還會印出完整的回應。

### 加上 Security 時的注意事項

```java
@WebMvcTest(OrderController.class)
class SecuredControllerTest {

    @Autowired MockMvc mockMvc;
    @MockitoBean OrderService orderService;

    @Test
    void 未登入應回401() throws Exception {
        mockMvc.perform(get("/orders/1001"))
               .andExpect(status().isUnauthorized());
    }

    @Test
    @org.springframework.security.test.context.support.WithMockUser(roles = "BUYER")
    void 買家可以查自己的訂單() throws Exception {
        mockMvc.perform(get("/orders/1001"))
               .andExpect(status().isOk());
    }
}
```

> ⚠️ **`@WebMvcTest` 會載入你的 `SecurityFilterChain`**，
> 所以「沒帶身分的請求」會被擋。這常讓人困惑（明明只想測路由卻回 401）。
>
> 想暫時關掉 Security：
> ```java
> @WebMvcTest(controllers = OrderController.class,
>             excludeAutoConfiguration = SecurityAutoConfiguration.class)
> ```
> 但**更好的做法是連 Security 一起測**——因為「權限沒設對」是真實會發生的 bug。
> 09-spring-security 第 08 章會完整處理。

### 其他切片測試

```java
// JSON 序列化
@JsonTest
class OrderJsonTest {
    @Autowired private JacksonTester<Order> json;

    @Test
    void 金額應序列化為數字而非字串() throws Exception {
        Order order = new Order(1L, "王小明", new BigDecimal("1280.50"), "LINE_PAY", "PAID", Instant.parse("2026-08-18T00:00:00Z"));

        assertThat(json.write(order)).extractingJsonPathNumberValue("$.amount")
                .isEqualTo(1280.50);
        assertThat(json.write(order)).extractingJsonPathStringValue("$.createdAt")
                .isEqualTo("2026-08-18T00:00:00Z");     // 驗證日期格式（第 02 章 Jackson 設定）
    }

    @Test
    void 反序列化應忽略未知欄位() throws Exception {
        String content = """
                {"id":1,"customerName":"王小明","amount":100,"unknownField":"x"}
                """;
        assertThat(json.parse(content).getObject().customerName()).isEqualTo("王小明");
    }
}
```

```java
// 外部 API 用戶端
@RestClientTest(PaymentGatewayClient.class)
class PaymentGatewayClientTest {

    @Autowired private PaymentGatewayClient client;
    @Autowired private MockRestServiceServer server;

    @Test
    void 成功付款() {
        server.expect(requestTo("/v1/charges"))
              .andExpect(method(HttpMethod.POST))
              .andExpect(jsonPath("$.amount").value(1280))
              .andRespond(withSuccess("""
                      {"id":"ch_123","status":"succeeded"}
                      """, MediaType.APPLICATION_JSON));

        ChargeResult result = client.charge("order-1", new BigDecimal("1280"));

        assertThat(result.chargeId()).isEqualTo("ch_123");
        server.verify();
    }

    @Test
    void 對方回500應轉成自訂例外() {
        server.expect(requestTo("/v1/charges"))
              .andRespond(withServerError());

        assertThatThrownBy(() -> client.charge("order-1", new BigDecimal("1280")))
                .isInstanceOf(PaymentGatewayException.class);
    }
}
```

---

## 7.8 `@DataJpaTest` 與資料層測試

### 基本用法

```java
package com.example.shop.order;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;

import java.math.BigDecimal;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@DataJpaTest
class OrderRepositoryTest {

    @Autowired
    private OrderRepository repository;

    @Autowired
    private TestEntityManager entityManager;     // 直接操作 EntityManager，繞過 Repository

    @Test
    void 應能依客戶查詢訂單() {
        entityManager.persist(new OrderEntity("c-001", new BigDecimal("100"), "PAID"));
        entityManager.persist(new OrderEntity("c-001", new BigDecimal("200"), "PAID"));
        entityManager.persist(new OrderEntity("c-002", new BigDecimal("300"), "PAID"));
        entityManager.flush();                   // ★ 強制寫入，否則查詢可能只讀到一級快取 ★
        entityManager.clear();                   // ★ 清掉一級快取，模擬「真的從資料庫讀」 ★

        var orders = repository.findByCustomerId("c-001");

        assertThat(orders).hasSize(2)
                .extracting(OrderEntity::getAmount)
                .containsExactlyInAnyOrder(new BigDecimal("100.00"), new BigDecimal("200.00"));
    }
}
```

> **`entityManager.flush()` + `clear()` 這兩行極重要。**
> 沒有它們，你測到的是 Hibernate 的**一級快取**（持久化情境），
> 不是真的資料庫查詢。這會讓「SQL 寫錯」「欄位映射錯」的 bug 完全測不出來。
>
> 08-jpa-mybatis 第 03 章會完整解釋持久化情境。

### `@DataJpaTest` 的預設行為

```
✅ 只載入 JPA 相關的 Bean（Entity、Repository、EntityManager、DataSource）
✅ 自動套用 @Transactional，測試結束後 rollback
✅ 自動用內嵌資料庫（如果 classpath 上有 H2 / HSQLDB / Derby）
✅ 開啟 SQL 日誌（spring.jpa.show-sql=true）
❌ 不載入 @Service / @Component / @Controller
```

### ★ 為什麼「用 H2 測試會騙你」★

`@DataJpaTest` 預設會找內嵌資料庫。如果你的 classpath 上有 H2，它就用 H2。
**但正式環境是 MySQL。**

| 差異 | H2 | MySQL 8 | 後果 |
|---|---|---|---|
| 字串比較大小寫 | 預設**區分**大小寫 | `utf8mb4_general_ci` **不區分** | H2 測試過，上線發現 `WHERE email = 'A@B.com'` 查不到 |
| `ORDER BY` 的預設排序 | 不同的 collation | 不同 | 分頁結果順序不同 |
| 函式 | 沒有 `JSON_EXTRACT`、`GROUP_CONCAT` 行為不同 | 有 | 原生 SQL 直接語法錯誤 |
| 保留字 | 不同 | `rank`、`groups`、`lead` 是保留字 | H2 過，MySQL 語法錯誤 |
| 空字串 vs NULL | 不同處理 | 不同 | 驗證邏輯不一致 |
| `AUTO_INCREMENT` 行為 | 不同 | rollback 後不歸還號碼 | 測試的 ID 假設失效 |
| 索引與執行計畫 | 完全不同 | — | 效能問題測不出來 |
| 交易隔離級別 | 預設 READ_COMMITTED | 預設 REPEATABLE_READ | 併發行為完全不同 |
| 鎖的行為 | 簡化的 | 行鎖、間隙鎖 | 死鎖問題測不出來 |

> **真實案例**：某團隊全部用 H2 測試，覆蓋率 85%，所有測試都綠。
> 上線後遇到三個問題：
> 1. `WHERE product_name = ?` 大小寫不符查不到（MySQL ci vs H2 cs）。
> 2. 一支報表 SQL 用了 `rank` 當欄位別名，MySQL 8 直接語法錯誤（保留字）。
> 3. 併發下單測試在 H2 完全正常，MySQL 上出現死鎖。
>
> **這三個問題有一個共同點：測試全部通過。**

### 解法：Testcontainers + `@ServiceConnection`

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-testcontainers</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>mysql</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
</dependency>
```

```java
package com.example.shop.support;

import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.springframework.boot.test.context.TestConfiguration;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * 共用的測試容器設定。
 *
 * <p>★ @ServiceConnection（Boot 3.1+）會自動設定 spring.datasource.*，
 * 不需要再寫 @DynamicPropertySource ★
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestcontainersConfig {

    @Bean
    @ServiceConnection
    MySQLContainer<?> mysqlContainer() {
        return new MySQLContainer<>(DockerImageName.parse("mysql:8.0"))
                .withDatabaseName("shop_test")
                .withUsername("test")
                .withPassword("test")
                // ★ 與正式環境一致的字元集與 collation ★
                .withCommand("--character-set-server=utf8mb4",
                             "--collation-server=utf8mb4_0900_ai_ci",
                             "--default-time-zone=+00:00")
                .withReuse(true);      // ★ 本機開發時重複使用容器（見下方）★
    }
}
```

```java
package com.example.shop.order;

import com.example.shop.support.TestcontainersConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;
import org.springframework.context.annotation.Import;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)  // ★ 不要換成內嵌資料庫 ★
@Import(TestcontainersConfig.class)
class OrderRepositoryMySqlTest {

    @Autowired private OrderRepository repository;
    @Autowired private TestEntityManager entityManager;

    @Test
    void 客戶名稱查詢應不分大小寫() {
        entityManager.persist(new OrderEntity("c-001", "iPhone 16 Pro", new BigDecimal("39900")));
        entityManager.flush();
        entityManager.clear();

        // ★ 這個測試在 H2 上會失敗，在 MySQL（ci collation）上會通過 ★
        assertThat(repository.findByProductName("IPHONE 16 PRO")).isNotEmpty();
    }

    @Test
    void 金額應保留兩位小數() {
        var saved = entityManager.persistFlushFind(
                new OrderEntity("c-001", "商品", new BigDecimal("1280.999")));
        entityManager.clear();

        // ★ DECIMAL(10,2) 的四捨五入行為，H2 與 MySQL 可能不同 ★
        assertThat(repository.findById(saved.getId()).orElseThrow().getAmount())
                .isEqualByComparingTo("1281.00");
    }
}
```

> **`@AutoConfigureTestDatabase(replace = NONE)` 不能忘。**
> `@DataJpaTest` 預設會「用內嵌資料庫替換掉你的 DataSource」，
> 即使你設了 Testcontainers 也會被覆蓋。

### 讓 Testcontainers 快起來：容器重複使用

**問題**：每個測試類別都啟動一個 MySQL 容器 = 每次 8～15 秒。

```java
// ❌ 每個測試類別一個容器
@DataJpaTest
class TestA {
    @Container static MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0");
}

@DataJpaTest
class TestB {
    @Container static MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0");   // 又一個
}
```

**解法 1：`static` 容器 + 共用基底類別（單一 JVM 內共用）**

```java
package com.example.shop.support;

import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;

/**
 * 資料層測試的共用基底。
 *
 * <p>★ static 容器：整個 JVM 只啟動一次，所有子類別共用 ★
 * <p>★ 刻意不用 @Testcontainers 註解（它會為每個測試類別管理生命週期），
 *    而是用 static 區塊手動啟動，讓容器活到 JVM 結束 ★
 */
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
public abstract class AbstractMySqlTest {

    protected static final MySQLContainer<?> MYSQL;

    static {
        MYSQL = new MySQLContainer<>("mysql:8.0")
                .withDatabaseName("shop_test")
                .withUsername("test")
                .withPassword("test")
                .withCommand("--character-set-server=utf8mb4",
                             "--collation-server=utf8mb4_0900_ai_ci",
                             "--default-time-zone=+00:00")
                .withReuse(true);
        MYSQL.start();
        // 刻意不呼叫 stop()：JVM 結束時 Testcontainers 的 Ryuk 會清理
    }

    @DynamicPropertySource
    static void datasourceProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", MYSQL::getJdbcUrl);
        registry.add("spring.datasource.username", MYSQL::getUsername);
        registry.add("spring.datasource.password", MYSQL::getPassword);
    }
}
```

```java
@DataJpaTest
class OrderRepositoryTest extends AbstractMySqlTest {
    // 用共用的容器
}

@DataJpaTest
class ProductRepositoryTest extends AbstractMySqlTest {
    // 同一個容器
}
```

**解法 2：`withReuse(true)` + 本機設定（跨 JVM 重複使用）**

```properties
# ~/.testcontainers.properties
testcontainers.reuse.enable=true
```

```
第一次執行測試：啟動容器（12 秒）
第二次執行測試：★ 重複使用上次的容器（0 秒）★
```

> ⚠️ **`withReuse` 的注意事項：**
> - 容器**不會**自動清理，要手動 `docker rm -f`。
> - **資料會殘留**——所以測試必須自己清理，或用 `@Transactional` rollback。
> - **CI 上不要開**（每次都該是乾淨環境）。`~/.testcontainers.properties` 是使用者層級的檔案，CI 上不會有。
>
> **這個設定是本機開發體驗的最大改善**：從「每次跑測試等 12 秒」變成「等 0 秒」。

**解法 3：`@ServiceConnection` + `@Import`（最簡潔，Boot 3.1+）**

```java
package com.example.shop.support;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;

@TestConfiguration(proxyBeanMethods = false)
public class SharedContainersConfig {

    @Bean
    @ServiceConnection
    MySQLContainer<?> mysql() {
        return new MySQLContainer<>("mysql:8.0")
                .withCommand("--character-set-server=utf8mb4",
                             "--collation-server=utf8mb4_0900_ai_ci")
                .withReuse(true);
    }

    @Bean
    @ServiceConnection(name = "redis")      // ★ Redis 也可以 ★
    GenericContainer<?> redis() {
        return new GenericContainer<>(DockerImageName.parse("redis:7-alpine"))
                .withExposedPorts(6379)
                .withReuse(true);
    }
}
```

> **`@ServiceConnection` 支援的容器**：MySQL、PostgreSQL、MongoDB、Redis、
> Kafka、RabbitMQ、Elasticsearch、Cassandra、Neo4j、Zipkin 等。
> 它會自動設定對應的 `spring.*` 屬性，**完全不用寫 `@DynamicPropertySource`**。

### 開發時也用 Testcontainers：`spring-boot-docker-compose`

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-docker-compose</artifactId>
    <optional>true</optional>
</dependency>
```

```yaml
# compose.yaml（放在專案根目錄）
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: shop
    ports:
      - "3306:3306"
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

**`./mvnw spring-boot:run` 會自動 `docker compose up`，並自動設定連線資訊。**
關閉應用程式時自動 `docker compose stop`。

```yaml
spring:
  docker:
    compose:
      lifecycle-management: start-and-stop    # start-only / none
      stop:
        command: down          # 停止時直接移除容器
```

> **這個功能對新人上手極有幫助**：clone 專案 → `./mvnw spring-boot:run` → 就能跑，
> 不需要「先自己裝 MySQL、建資料庫、改設定檔」。

### 準備測試資料：`@Sql`

```java
@DataJpaTest
@Sql("/sql/orders-seed.sql")                        // 每個測試方法前執行
@Sql(scripts = "/sql/cleanup.sql",
     executionPhase = Sql.ExecutionPhase.AFTER_TEST_METHOD)
class OrderQueryTest {

    @Test
    @Sql("/sql/orders-with-large-amounts.sql")     // 方法層級的會「額外」執行
    void 應能查出大額訂單() { }
}
```

> **取捨**：`@Sql` 適合「大量、固定的測試資料」（例如報表查詢要 500 筆）。
> 但它有兩個缺點：① SQL 與 Entity 定義容易不同步 ② 看測試程式碼看不出資料長什麼樣。
>
> **小量資料用 `TestEntityManager` 或 Object Mother 模式**（見 7.13）。

---

## 7.9 測試基礎設施程式碼

第 02～06 章寫的那些東西（自動組態、設定、AOP、事件、非同步）也要測。

### 自動組態：`ApplicationContextRunner`

第 02 章 2.12 已完整介紹。重點回顧：

```java
private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(AuditAutoConfiguration.class));

@Test
void classpath沒有DataSource時應正常啟動() {
    runner.withClassLoader(new FilteredClassLoader(DataSource.class))
          .run(context -> assertThat(context).hasNotFailed());
}
```

### 設定綁定與驗證

第 03 章 3.15 已完整介紹。重點回顧：

```java
@Test
void email格式錯誤時應啟動失敗() {
    runner.withPropertyValues("shop.notification.email-from=not-an-email")
          .run(context -> {
              assertThat(context).hasFailed();
              assertThat(context).getFailure().hasMessageContaining("email-from");
          });
}
```

### AOP 切面

第 04 章 4.18 已完整介紹。重點回顧：

```java
@Test
void 被限流時不應執行目標方法() {
    runner.run(context -> {
        limiter.allow = false;
        assertThatThrownBy(() -> service.doSomething(1L))
                .isInstanceOf(RateLimitExceededException.class);
        assertThat(service.executed).isZero();      // ★ 負向斷言 ★
    });
}
```

### 驗證 Bean 真的被代理

```java
package com.example.shop.arch;

import org.junit.jupiter.api.Test;
import org.springframework.aop.framework.AopProxyUtils;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class ProxyAssertionTest {

    @Autowired private OrderService orderService;

    @Test
    void 有Transactional的Service應被代理() {
        assertThat(AopUtils.isAopProxy(orderService))
                .as("OrderService 上的 @Transactional 需要代理才會生效")
                .isTrue();
        assertThat(AopProxyUtils.ultimateTargetClass(orderService))
                .isEqualTo(OrderService.class);
    }
}
```

### 事件

第 06 章 6.10 已完整介紹。重點回顧：

```java
@SpringBootTest
@RecordApplicationEvents
class OrderEventTest {
    @Autowired ApplicationEvents events;

    @Test
    @Transactional
    void 下單應發布事件() {
        orderService.placeOrder(order);
        assertThat(events.stream(OrderPlacedEvent.class)).hasSize(1);
    }
}
```

### 日誌輸出：`OutputCaptureExtension`

```java
package com.example.shop.observability;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

import static org.assertj.core.api.Assertions.assertThat;

@ExtendWith(OutputCaptureExtension.class)
class MaskingConverterTest {

    @Test
    void 信用卡號應被遮蔽(CapturedOutput output) {
        var log = org.slf4j.LoggerFactory.getLogger(MaskingConverterTest.class);

        log.info("處理付款 卡號=4532015112830366");

        // ★ 驗證「日誌裡沒有完整卡號」——這是第 05 章 5.11 的自動化檢查 ★
        assertThat(output).doesNotContain("4532015112830366");
        assertThat(output).contains("4532********0366");
    }
}
```

> **這種測試很值得寫**。「不要把敏感資料寫進日誌」如果只是口頭約定，
> 遲早會有人違反。變成測試之後，CI 會擋下來。

### 架構規則：ArchUnit

```java
package com.example.shop.arch;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.RestController;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.fields;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.methods;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

@AnalyzeClasses(packages = "com.example.shop",
                importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    /** ① 分層：Controller 不可以直接碰 Repository（04-controller 的核心規則） */
    @ArchTest
    static final ArchRule controller不可直接依賴repository =
            noClasses().that().areAnnotatedWith(RestController.class)
                    .should().dependOnClassesThat().areAnnotatedWith(Repository.class)
                    .because("Controller 只該呼叫 Service，商業邏輯不該洩漏到 Web 層");

    /** ② AOP 安全：@Transactional 方法不可以是 final / private / static（第 04 章 4.18） */
    @ArchTest
    static final ArchRule transactional方法必須可被代理 =
            methods().that().areAnnotatedWith(Transactional.class)
                    .should().bePublic()
                    .andShould().notBeFinal()
                    .andShould().notBeStatic()
                    .because("Spring AOP 用 CGLIB 代理，final/private/static 方法無法攔截");

    /** ③ 注入方式：不可以用欄位注入（第 01 章 1.7） */
    @ArchTest
    static final ArchRule不可使用欄位注入 =
            fields().should().notBeAnnotatedWith(
                            org.springframework.beans.factory.annotation.Autowired.class)
                    .because("一律用建構子注入，欄位注入無法寫測試也不能用 final");

    /** ④ 不要用 System.out（第 05 章） */
    @ArchTest
    static final ArchRule不可使用System_out =
            noClasses().should().accessField(System.class, "out")
                    .orShould().accessField(System.class, "err")
                    .because("一律用 SLF4J，System.out 不受日誌設定管理");

    /** ⑤ Service 不可以依賴 Web 層的型別（避免 HttpServletRequest 洩漏進業務邏輯） */
    @ArchTest
    static final ArchRule service不可依賴web層 =
            noClasses().that().areAnnotatedWith(Service.class)
                    .should().dependOnClassesThat()
                    .resideInAnyPackage("jakarta.servlet..", "org.springframework.web..")
                    .because("Service 應該與傳輸協定無關，才能被排程、MQ 消費者重用");
}
```

> **ArchUnit 的價值**：把「code review 時會提醒的事」變成自動化規則。
> 新人第一次違反時，CI 就會告訴他為什麼不行（`because` 那段訊息會印出來）。
>
> 01-java-core 第 11 章有 ArchUnit 的完整介紹。

---

## 7.10 測試分流：讓 CI 與本機都快

### 用 JUnit 5 的 `@Tag`

```java
@Tag("unit")
class OrderAmountCalculatorTest { }         // 純單元，3 毫秒

@Tag("integration")
@IntegrationTest
class OrderServiceIntegrationTest { }       // 要啟動 Spring，2 秒

@Tag("slow")
@Tag("integration")
class OrderEndToEndTest { }                 // 要起 Tomcat + MySQL，8 秒
```

### Maven 設定

```xml
<build>
    <plugins>
        <!-- surefire：跑快的測試（mvn test） -->
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-surefire-plugin</artifactId>
            <configuration>
                <excludedGroups>slow</excludedGroups>
                <!-- ★ 平行執行，大幅縮短時間 ★ -->
                <properties>
                    <configurationParameters>
                        junit.jupiter.execution.parallel.enabled=true
                        junit.jupiter.execution.parallel.mode.default=concurrent
                        junit.jupiter.execution.parallel.mode.classes.default=concurrent
                        junit.jupiter.execution.parallel.config.strategy=dynamic
                        junit.jupiter.execution.parallel.config.dynamic.factor=2
                    </configurationParameters>
                </properties>
            </configuration>
        </plugin>

        <!-- failsafe：跑慢的測試（mvn verify） -->
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-failsafe-plugin</artifactId>
            <configuration>
                <includes>
                    <include>**/*IT.java</include>
                    <include>**/*IntegrationTest.java</include>
                    <include>**/*EndToEndTest.java</include>
                </includes>
            </configuration>
            <executions>
                <execution>
                    <goals>
                        <goal>integration-test</goal>
                        <goal>verify</goal>
                    </goals>
                </execution>
            </executions>
        </plugin>
    </plugins>
</build>
```

```bash
./mvnw test              # 只跑快的（本機開發，每次存檔都可以跑）
./mvnw verify            # 跑全部（PR 前、CI）
./mvnw test -Dgroups=unit    # 只跑單元測試
```

### ⚠️ 平行執行的注意事項

```java
// 有共用狀態的測試不能平行
@Execution(ExecutionMode.SAME_THREAD)
class SharedStateTest { }

// 或用資源鎖
@ResourceLock("database")
class DatabaseTest { }
```

**常見的平行執行問題：**

| 問題 | 原因 | 解法 |
|---|---|---|
| 資料庫測試互相干擾 | 同時讀寫同一張表 | `@ResourceLock` 或每個測試用不同的資料 |
| port 衝突 | `DEFINED_PORT` | 改用 `RANDOM_PORT` |
| 靜態狀態污染 | `static` 欄位、`ThreadLocal` | 改成實例欄位；`@AfterEach` 清理 |
| 檔案系統衝突 | 寫到同一個路徑 | 用 `@TempDir` |
| MockMvc 測試偶發失敗 | 共用 `MeterRegistry` 等單例 | `@AfterEach` 清理 |

### CI 流水線設計

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  fast-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven
      - name: 單元 + 切片測試
        run: ./mvnw -B test              # 約 2 分鐘，快速回饋

  integration-tests:
    runs-on: ubuntu-latest
    needs: fast-tests                    # ★ 快測試過了才跑慢的 ★
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven
      - name: 整合測試（Testcontainers）
        run: ./mvnw -B verify
      - name: 上傳覆蓋率報告
        uses: codecov/codecov-action@v4
        with:
          files: target/site/jacoco/jacoco.xml
```

> **`needs: fast-tests` 的價值**：語法錯誤、單元測試失敗這種問題，
> 2 分鐘就知道，不用等 15 分鐘的整合測試跑完。

---

## 7.11 診斷測試問題

### 問題 1：測試很慢

```bash
# ① 找出 context 建立了幾次
./mvnw test 2>&1 | grep -c "Root WebApplicationContext: initialization completed"

# ② 開啟快取統計
# src/test/resources/logback-test.xml 加上
#   <logger name="org.springframework.test.context.cache" level="DEBUG"/>

# ③ 找出最慢的測試（surefire 報告）
find target/surefire-reports -name '*.txt' -exec grep -H 'Time elapsed' {} \; \
  | sort -t: -k3 -rn | head -20

# ④ 找出所有 @DirtiesContext
grep -rn '@DirtiesContext' src/test/

# ⑤ 找出 @SpringBootTest 的設定組合種類
grep -rn -A3 '@SpringBootTest' src/test/ | grep -E 'properties|ActiveProfiles|webEnvironment' | sort -u
```

**改善順序：**

```
1. 移除所有非必要的 @DirtiesContext（最大效益）
2. 統一 @SpringBootTest 的設定組合（用自訂註解）
3. 把只測業務邏輯的 @SpringBootTest 改成純單元測試
4. 把測 Web 層的改成 @WebMvcTest
5. 把測設定的改成 ApplicationContextRunner
6. 開啟平行執行
7. 開啟 Testcontainers 容器重複使用
```

### 問題 2：測試偶發失敗（flaky test）

| 症狀 | 常見原因 |
|---|---|
| 單獨跑會過，一起跑會失敗 | 測試間有共用狀態（快取、靜態欄位、資料庫資料） |
| 本機會過，CI 會失敗 | 時區、locale、檔案編碼、CI 機器較慢 |
| 每次失敗的測試不同 | 平行執行的資源競爭 |
| 非同步測試偶爾失敗 | 用了 `Thread.sleep` 而不是 Awaitility（第 06 章） |
| 排序斷言偶爾失敗 | 資料庫沒有 `ORDER BY` 就斷言順序 |
| 時間相關斷言偶爾失敗 | 用 `Instant.now()` 而不是注入 `Clock` |

**時間問題的正確做法**（第 01 章實戰用過）：

```java
// ❌ 依賴真實時鐘
@Service
public class OrderService {
    public Order place(...) {
        return new Order(..., Instant.now());     // 測試無法控制
    }
}

// ✅ 注入 Clock
@Service
public class OrderService {
    private final Clock clock;
    public Order place(...) {
        return new Order(..., clock.instant());
    }
}
```

```java
@Test
void 應記錄正確的建立時間() {
    Clock fixed = Clock.fixed(Instant.parse("2026-08-18T00:00:00Z"), ZoneOffset.UTC);
    OrderService service = new OrderService(repository, fixed);

    Order order = service.place(...);

    assertThat(order.createdAt()).isEqualTo(Instant.parse("2026-08-18T00:00:00Z"));
}
```

```java
// 整合測試裡替換 Clock
@TestConfiguration
static class FixedClockConfig {
    @Bean @Primary
    Clock fixedClock() {
        return Clock.fixed(Instant.parse("2026-08-18T00:00:00Z"), ZoneOffset.UTC);
    }
}
```

### 問題 3：測試互相影響

**檢查清單：**

```
□ 有沒有 static 可變欄位？
□ 快取有沒有在 @AfterEach 清掉？
□ 資料庫測試有沒有 @Transactional（會自動 rollback）？
□ RANDOM_PORT 的測試有沒有自己清資料？
□ MeterRegistry 的指標有沒有累積？
□ MDC 有沒有清乾淨？（第 05 章）
□ 有沒有測試順序依賴（用 @TestMethodOrder 就是警訊）？
```

```java
package com.example.shop.support;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cache.CacheManager;
import org.slf4j.MDC;

/**
 * 整合測試的共用清理邏輯。
 *
 * <p>★ 用「主動清理」取代 @DirtiesContext ★
 */
public abstract class CleanStateTest {

    @Autowired(required = false) private CacheManager cacheManager;
    @Autowired(required = false) private MeterRegistry meterRegistry;

    @AfterEach
    void cleanSharedState() {
        MDC.clear();

        if (cacheManager != null) {
            cacheManager.getCacheNames().forEach(name -> {
                var cache = cacheManager.getCache(name);
                if (cache != null) cache.clear();
            });
        }
        if (meterRegistry instanceof SimpleMeterRegistry simple) {
            simple.clear();
        }
    }
}
```

---

## 7.12 實戰：訂單服務的完整測試套件

把整章串起來，展示同一個功能在四個層級各測什麼。

### 層級 1：純單元測試（不碰 Spring）

```java
package com.example.shop.order;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 金額計算：純函式，最容易也最該用單元測試。
 * 3 毫秒跑完，涵蓋所有邊界。
 */
class OrderAmountCalculatorTest {

    private final OrderAmountCalculator calculator = new OrderAmountCalculator();

    @Test
    void 應正確計算含折扣的總額() {
        var lines = List.of(
                new OrderLine("SKU-1", new BigDecimal("100.00"), 2),
                new OrderLine("SKU-2", new BigDecimal("50.50"), 3));

        BigDecimal total = calculator.total(lines, new BigDecimal("0.1"));

        // (100*2 + 50.50*3) * 0.9 = (200 + 151.50) * 0.9 = 316.35
        assertThat(total).isEqualByComparingTo("316.35");
    }

    @Test
    void 折扣為零時應等於原價() {
        var lines = List.of(new OrderLine("SKU-1", new BigDecimal("99.99"), 1));
        assertThat(calculator.total(lines, BigDecimal.ZERO)).isEqualByComparingTo("99.99");
    }

    @Test
    void 空明細應回傳零() {
        assertThat(calculator.total(List.of(), BigDecimal.ZERO)).isEqualByComparingTo("0");
    }

    @Test
    void 折扣超過百分之百應拒絕() {
        var lines = List.of(new OrderLine("SKU-1", new BigDecimal("100"), 1));
        assertThatThrownBy(() -> calculator.total(lines, new BigDecimal("1.5")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("折扣率");
    }

    @Test
    void 金額應四捨五入到分() {
        var lines = List.of(new OrderLine("SKU-1", new BigDecimal("33.333"), 1));
        assertThat(calculator.total(lines, BigDecimal.ZERO)).isEqualByComparingTo("33.33");
    }
}
```

```java
package com.example.shop.order;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 訂單狀態機：用參數化測試涵蓋所有轉換組合。
 */
class OrderStatusTransitionTest {

    @ParameterizedTest
    @CsvSource({
            "CREATED, PAID,      true",
            "CREATED, CANCELLED, true",
            "PAID,    SHIPPED,   true",
            "PAID,    REFUNDED,  true",
            "SHIPPED, COMPLETED, true",
            "SHIPPED, CANCELLED, false",     // 已出貨不能取消
            "COMPLETED, PAID,    false",     // 完成後不能回頭
            "CANCELLED, PAID,    false",     // 取消後不能付款
            "REFUNDED, SHIPPED,  false"
    })
    void 狀態轉換規則(OrderStatus from, OrderStatus to, boolean allowed) {
        if (allowed) {
            assertThat(from.canTransitionTo(to)).isTrue();
        } else {
            assertThat(from.canTransitionTo(to)).isFalse();
        }
    }

    @Test
    void 非法轉換應拋出例外() {
        Order order = new Order(1L, "c-001", null, null, OrderStatus.SHIPPED, null);
        assertThatThrownBy(() -> order.transitionTo(OrderStatus.CANCELLED))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SHIPPED")
                .hasMessageContaining("CANCELLED");
    }
}
```

```java
package com.example.shop.order;

import com.example.shop.notification.Notifier;
import com.example.shop.payment.PaymentProcessor;
import com.example.shop.payment.PaymentService;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Service 的業務流程：用手寫 fake，不用 Mockito。
 *
 * <p>為什麼用 fake 而不是 mock？
 * ① 可讀性更好（fake 有真實行為，mock 要一堆 given/willReturn）
 * ② 重構友善（改方法簽章時 fake 會編譯錯，mock 的字串不會）
 * ③ 可以驗證「狀態」而不只是「互動」
 * （01-java-core 第 11 章 11.10 有五種測試替身的完整說明）
 */
class OrderServiceTest {

    private final Clock fixedClock =
            Clock.fixed(Instant.parse("2026-08-18T00:00:00Z"), ZoneOffset.UTC);

    // ── Fakes ──
    static class FakeOrderRepository implements OrderRepository {
        final List<Order> saved = new ArrayList<>();
        long nextId = 1000;

        @Override public Order save(Order order) {
            Order withId = order.id() == null ? order.withId(++nextId) : order;
            saved.removeIf(o -> o.id().equals(withId.id()));
            saved.add(withId);
            return withId;
        }
        @Override public java.util.Optional<Order> findById(long id) {
            return saved.stream().filter(o -> o.id() == id).findFirst();
        }
        @Override public List<Order> findAll() { return List.copyOf(saved); }
    }

    static class RecordingNotifier implements Notifier {
        record Sent(String to, String message) { }
        final List<Sent> sent = new ArrayList<>();
        @Override public void send(String to, String message) { sent.add(new Sent(to, message)); }
    }

    static class ControllableProcessor implements PaymentProcessor {
        final List<String> charges = new ArrayList<>();
        RuntimeException failWith;

        @Override public String method() { return "LINE_PAY"; }
        @Override public void charge(String orderId, BigDecimal amount) {
            if (failWith != null) throw failWith;
            charges.add(orderId + "|" + amount);
        }
    }

    // ── Tests ──

    @Test
    void 下單成功應扣款並通知() {
        var repo = new FakeOrderRepository();
        var notifier = new RecordingNotifier();
        var processor = new ControllableProcessor();
        var service = new OrderService(repo, new PaymentService(List.of(processor)),
                notifier, fixedClock);

        Order order = service.placeOrder("王小明", new BigDecimal("1280"), "LINE_PAY");

        assertThat(order.status()).isEqualTo("PAID");
        assertThat(order.createdAt()).isEqualTo(Instant.parse("2026-08-18T00:00:00Z"));
        assertThat(processor.charges).containsExactly(order.id() + "|1280");
        assertThat(notifier.sent).hasSize(1);
        assertThat(repo.findById(order.id())).isPresent()
                .get().extracting(Order::status).isEqualTo("PAID");     // ★ 驗證狀態 ★
    }

    @Test
    void 付款失敗時不應通知也不應標記為已付款() {
        var repo = new FakeOrderRepository();
        var notifier = new RecordingNotifier();
        var processor = new ControllableProcessor();
        processor.failWith = new RuntimeException("卡片被拒");
        var service = new OrderService(repo, new PaymentService(List.of(processor)),
                notifier, fixedClock);

        assertThatThrownBy(() -> service.placeOrder("王小明", new BigDecimal("1280"), "LINE_PAY"))
                .hasMessage("卡片被拒");

        // ★ 三個負向斷言，缺一不可 ★
        assertThat(notifier.sent).isEmpty();
        assertThat(processor.charges).isEmpty();
        assertThat(repo.saved).allSatisfy(o -> assertThat(o.status()).isNotEqualTo("PAID"));
    }

    @Test
    void 不支援的付款方式應拒絕() {
        var service = new OrderService(new FakeOrderRepository(),
                new PaymentService(List.of(new ControllableProcessor())),
                new RecordingNotifier(), fixedClock);

        assertThatThrownBy(() -> service.placeOrder("王小明", new BigDecimal("100"), "BITCOIN"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("不支援的付款方式");
    }
}
```

### 層級 2：切片測試

已在 7.7、7.8 展示。

### 層級 3：整合測試（驗證交易與事件）

```java
package com.example.shop.order;

import com.example.shop.support.IntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.Mockito.doThrow;

/**
 * 整合測試只測「純單元測不到的東西」：
 * ① 交易邊界真的有效
 * ② 事件在 commit 之後才觸發
 * ③ AOP 註解真的生效
 */
@IntegrationTest
class OrderTransactionIntegrationTest {

    @Autowired private OrderService orderService;
    @Autowired private OrderRepository orderRepository;
    @Autowired private InventoryRepository inventoryRepository;
    @Autowired private TransactionTemplate transactionTemplate;

    @MockitoBean private MailSender mailSender;        // 不要真的寄信

    @AfterEach
    void cleanUp() {
        orderRepository.deleteAll();
    }

    @Test
    void 庫存不足時整筆交易應rollback() {
        inventoryRepository.setStock("SKU-1", 1);

        assertThatThrownBy(() ->
                orderService.placeOrder("王小明", new BigDecimal("100"), "LINE_PAY", "SKU-1", 5))
                .isInstanceOf(InsufficientStockException.class);

        // ★ 這是純單元測試測不到的：交易真的 rollback 了嗎 ★
        assertThat(orderRepository.findAll()).isEmpty();
        assertThat(inventoryRepository.getStock("SKU-1")).isEqualTo(1);   // 庫存沒被扣
    }

    @Test
    void 交易rollback時不應寄出確認信() {
        inventoryRepository.setStock("SKU-1", 1);

        assertThatThrownBy(() ->
                orderService.placeOrder("王小明", new BigDecimal("100"), "LINE_PAY", "SKU-1", 5))
                .isInstanceOf(InsufficientStockException.class);

        // ★ 驗證 @TransactionalEventListener(AFTER_COMMIT) 的價值（第 06 章 6.9）★
        then(mailSender).shouldHaveNoInteractions();
    }

    @Test
    void 交易commit後應寄出確認信() {
        inventoryRepository.setStock("SKU-1", 10);

        Order order = transactionTemplate.execute(status ->
                orderService.placeOrder("王小明", new BigDecimal("100"), "LINE_PAY", "SKU-1", 2));

        // TransactionTemplate 返回時交易已 commit → AFTER_COMMIT 已觸發
        assertThat(order).isNotNull();
        then(mailSender).should().send(org.mockito.ArgumentMatchers.contains("王小明"),
                org.mockito.ArgumentMatchers.anyString());
    }
}
```

### 層級 4：E2E 測試

```java
package com.example.shop;

import com.example.shop.support.SharedContainersConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * E2E：真的起 Tomcat、真的連 MySQL、走完整 HTTP。
 * 數量要少（只測最關鍵的路徑），因為它最慢也最脆弱。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(SharedContainersConfig.class)
class OrderEndToEndTest {

    @Autowired private TestRestTemplate restTemplate;
    @Autowired private OrderRepository orderRepository;

    @org.junit.jupiter.api.AfterEach
    void cleanUp() {
        orderRepository.deleteAll();       // ★ RANDOM_PORT 不會 rollback ★
    }

    @Test
    void 使用者可以完成一次下單並查詢到訂單() {
        // ① 下單
        var createRequest = new CreateOrderRequest("王小明", new BigDecimal("1280"), "LINE_PAY");
        ResponseEntity<OrderResponse> created =
                restTemplate.postForEntity("/orders", createRequest, OrderResponse.class);

        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getHeaders().getFirst("X-Trace-Id")).isNotBlank();
        long orderId = created.getBody().id();

        // ② 查詢
        ResponseEntity<OrderResponse> fetched =
                restTemplate.getForEntity("/orders/" + orderId, OrderResponse.class);

        assertThat(fetched.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(fetched.getBody().customerName()).isEqualTo("王小明");
        assertThat(fetched.getBody().status()).isEqualTo("PAID");

        // ③ 健康檢查（第 05 章）
        ResponseEntity<String> health = restTemplate.getForEntity("/actuator/health", String.class);
        assertThat(health.getStatusCode()).isEqualTo(HttpStatus.OK);
    }
}
```

### 測試資料建構：Object Mother

```java
package com.example.shop.support;

import com.example.shop.order.Order;
import com.example.shop.order.OrderStatus;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * 測試資料建構器。
 *
 * <p>價值：新增 Order 欄位時，只改這一個檔案，
 * 不用改 200 個測試裡的 new Order(...)。
 */
public final class OrderTestData {

    private Long id = null;
    private String customerId = "c-001";
    private BigDecimal amount = new BigDecimal("1000.00");
    private String paymentMethod = "LINE_PAY";
    private OrderStatus status = OrderStatus.CREATED;
    private Instant createdAt = Instant.parse("2026-08-18T00:00:00Z");

    public static OrderTestData anOrder() { return new OrderTestData(); }

    public static OrderTestData aPaidOrder() {
        return new OrderTestData().withStatus(OrderStatus.PAID);
    }

    public static OrderTestData aLargeOrder() {
        return new OrderTestData().withAmount(new BigDecimal("999999.00"));
    }

    public OrderTestData withId(Long id) { this.id = id; return this; }
    public OrderTestData withCustomerId(String c) { this.customerId = c; return this; }
    public OrderTestData withAmount(BigDecimal a) { this.amount = a; return this; }
    public OrderTestData withAmount(String a) { this.amount = new BigDecimal(a); return this; }
    public OrderTestData withStatus(OrderStatus s) { this.status = s; return this; }
    public OrderTestData withPaymentMethod(String m) { this.paymentMethod = m; return this; }
    public OrderTestData createdAt(Instant t) { this.createdAt = t; return this; }

    public Order build() {
        return new Order(id, customerId, amount, paymentMethod, status, createdAt);
    }
}
```

```java
import static com.example.shop.support.OrderTestData.aPaidOrder;
import static com.example.shop.support.OrderTestData.anOrder;

@Test
void 測試程式碼變得極易讀() {
    Order order = anOrder().withAmount("1280").withCustomerId("c-999").build();
    Order paid = aPaidOrder().withId(1001L).build();
    // ↑ 只寫「這個測試在意的欄位」，其他用合理的預設值
}
```

---

## 7.13 常見錯誤

### ① 每個測試都用 `@SpringBootTest`

測試從 40 秒變成 22 分鐘。用測試分層。

### ② 用 `@DirtiesContext` 解決測試互相影響

破壞 context 快取。改成主動清理狀態。

### ③ 用 H2 測試然後上線爆炸

大小寫、保留字、collation、鎖行為全都不同。用 Testcontainers。

### ④ `@DataJpaTest` 忘了 `flush()` + `clear()`

測到的是 Hibernate 一級快取，不是真的資料庫查詢。

### ⑤ `@DataJpaTest` + Testcontainers 忘了 `replace = NONE`

DataSource 被換成內嵌資料庫，Testcontainers 白啟動了。

### ⑥ `RANDOM_PORT` 測試以為 `@Transactional` 會 rollback

請求在 Tomcat 執行緒，是另一個交易。要自己清資料。

### ⑦ 用 `Thread.sleep` 等非同步

flaky test。用 Awaitility（第 06 章 6.10）。

### ⑧ 測試 `@TransactionalEventListener` 加了 `@Transactional`

測試交易會 rollback，`AFTER_COMMIT` 永遠不觸發。用 `TransactionTemplate`。

### ⑨ 斷言資料庫查詢順序但 SQL 沒有 `ORDER BY`

MySQL 不保證順序。加 `ORDER BY` 或用 `containsExactlyInAnyOrder`。

### ⑩ 用 `Instant.now()` 而不是注入 `Clock`

時間相關的斷言無法穩定。

### ⑪ 平行執行但有共用狀態

用 `@ResourceLock` 或 `@Execution(SAME_THREAD)`。

### ⑫ Mock 太多，測試變成「驗證實作細節」

```java
// ❌ 這個測試在測「程式怎麼寫」而不是「程式做了什麼」
then(repository).should().findById(1L);
then(repository).should().save(any());
then(mapper).should().toDto(any());
then(validator).should().validate(any());
// → 重構（例如把兩次查詢合成一次）就會壞掉，即使行為完全正確
```

```java
// ✅ 驗證結果與可觀察的副作用
assertThat(result.status()).isEqualTo("PAID");
assertThat(repository.findById(1L)).isPresent();
assertThat(notifier.sent).hasSize(1);
```

### ⑬ 只測 happy path

```
□ null / 空字串 / 空集合
□ 邊界值（0、-1、最大值）
□ 例外路徑
□ 併發情況
□ 「不應該發生的事沒有發生」（負向斷言）
```

---

## 7.14 本章練習

### 練習 1：判斷測試層級

以下需求各該用哪個層級的測試？為什麼？

1. 訂單金額超過 100 萬要拒絕。
2. `POST /orders` 缺少 `customerName` 要回 400 且錯誤格式正確。
3. `findByCustomerIdAndStatus` 產生的 SQL 正確且能查到資料。
4. 訂單 JSON 的 `createdAt` 要是 ISO-8601 格式。
5. 庫存不足時整筆訂單要 rollback。
6. `@Cacheable` 真的有作用（第二次查詢不打資料庫）。
7. 加了 Redis 依賴但沒設定時，服務仍能啟動。
8. 使用者從下單到查詢訂單的完整流程。

<details>
<summary>參考解答</summary>

| # | 層級 | 工具 | 理由 |
|---|---|---|---|
| 1 | **單元** | 純 JUnit | 純業務規則，`new OrderService(fakes...)` 就能測。3 毫秒 |
| 2 | **切片** | `@WebMvcTest` | 要驗證 Bean Validation 與 `@RestControllerAdvice` 的整合，但不需要 Service 或資料庫 |
| 3 | **切片** | `@DataJpaTest` + Testcontainers | 要真的執行 SQL。**一定要用 MySQL 不能用 H2**（大小寫、collation） |
| 4 | **切片** | `@JsonTest` | 只需要 Jackson 設定，最輕量 |
| 5 | **整合** | `@SpringBootTest`（最小設定） | 交易邊界只有真實的交易管理員才能驗證。純單元測不到 |
| 6 | **整合** | `@SpringBootTest` + `@MockitoSpyBean` 在 Repository 上 | 快取是 AOP，需要真實的代理。用 spy 驗證「第二次沒有呼叫 Repository」 |
| 7 | **切片** | `ApplicationContextRunner` + `FilteredClassLoader` | 第 02 章 2.12 的模式，幾十毫秒，而且不佔用 context 快取 |
| 8 | **E2E** | `@SpringBootTest(RANDOM_PORT)` + Testcontainers | 需要完整 HTTP + 真實資料庫。**只寫一兩個，涵蓋最關鍵路徑** |

**第 6 題的具體寫法值得看：**

```java
@IntegrationTest
class OrderCacheTest {

    @Autowired private OrderService orderService;
    @MockitoSpyBean private OrderRepository orderRepository;   // ★ spy 而不是 mock ★
    @Autowired private CacheManager cacheManager;

    @AfterEach
    void clearCache() {
        cacheManager.getCacheNames().forEach(n -> cacheManager.getCache(n).clear());
    }

    @Test
    void 第二次查詢應命中快取() {
        orderService.findById(1001L);
        orderService.findById(1001L);

        // ★ 只呼叫一次 Repository，第二次來自快取 ★
        then(orderRepository).should(times(1)).findById(1001L);
    }
}
```

**為什麼用 `@MockitoSpyBean` 而不是 `@MockitoBean`？**
因為我們要**真的執行**第一次查詢（拿到真實資料放進快取），
只是想「順便」計算被呼叫幾次。mock 會讓真實邏輯完全不執行。

</details>

### 練習 2：找出測試慢的原因並修正

```java
// TestA.java
@SpringBootTest
class OrderAmountTest {
    @Autowired OrderAmountCalculator calculator;
    @Test void 計算總額() { /* 純計算 */ }
}

// TestB.java
@SpringBootTest
@DirtiesContext
class CacheTest {
    @Test void 快取應生效() { }
}

// TestC.java
@SpringBootTest(properties = "shop.limits.max-amount=100")
class Limit100Test { }

// TestD.java
@SpringBootTest(properties = "shop.limits.max-amount=200")
class Limit200Test { }

// TestE.java
@SpringBootTest
@AutoConfigureMockMvc
class OrderControllerTest {
    @MockBean OrderService orderService;
    @Test void 查詢訂單() { }
}
```

<details>
<summary>參考解答</summary>

**五個問題，會產生 5 個不同的 context（外加 `@DirtiesContext` 造成的重建）：**

| 測試 | 問題 | 修正 |
|---|---|---|
| A | 純計算卻啟動整個 Spring | 改成純單元測試 |
| B | `@DirtiesContext` 破壞快取 | 改成 `@AfterEach` 清快取 |
| C、D | 不同的 `properties` → 兩個 context | 改用 `ApplicationContextRunner` |
| E | `@SpringBootTest` + `@AutoConfigureMockMvc` 太重 | 改用 `@WebMvcTest`；`@MockBean` 換成 `@MockitoBean` |

**修正後：**

```java
// ① A：純單元測試（3 毫秒，不佔 context）
class OrderAmountCalculatorTest {
    private final OrderAmountCalculator calculator = new OrderAmountCalculator();

    @Test
    void 計算總額() {
        assertThat(calculator.total(List.of(new OrderLine("SKU-1", new BigDecimal("100"), 2)),
                BigDecimal.ZERO)).isEqualByComparingTo("200");
    }
}
```

```java
// ② B：主動清理取代 @DirtiesContext
@IntegrationTest
class CacheTest {
    @Autowired CacheManager cacheManager;
    @MockitoSpyBean OrderRepository repository;

    @AfterEach
    void clearCache() {
        cacheManager.getCacheNames().forEach(n -> cacheManager.getCache(n).clear());
    }

    @Test
    void 快取應生效() {
        orderService.findById(1L);
        orderService.findById(1L);
        then(repository).should(times(1)).findById(1L);
    }
}
```

```java
// ③ C + D：合併成一個 ApplicationContextRunner 測試（幾十毫秒，不佔 context）
class LimitPropertiesTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(LimitConfig.class);

    @ParameterizedTest
    @CsvSource({"100", "200", "1000000"})
    void 應接受不同的金額上限(String limit) {
        runner.withPropertyValues("shop.limits.max-amount=" + limit)
              .run(context -> assertThat(context.getBean(LimitProperties.class).maxAmount())
                      .isEqualByComparingTo(limit));
    }

    @Test
    void 上限為負數應啟動失敗() {
        runner.withPropertyValues("shop.limits.max-amount=-1")
              .run(context -> assertThat(context).hasFailed());
    }

    @EnableConfigurationProperties(LimitProperties.class)
    static class LimitConfig { }
}
```

```java
// ④ E：切片測試（0.8 秒 vs 3 秒）
@WebMvcTest(OrderController.class)
class OrderControllerTest {

    @Autowired MockMvcTester mvc;
    @MockitoBean OrderService orderService;     // ★ 新註解 ★

    @Test
    void 查詢訂單() {
        given(orderService.findById(1L)).willReturn(anOrder().withId(1L).build());

        assertThat(mvc.get().uri("/orders/1")).hasStatusOk();
    }
}
```

**效果對照：**

| | 修正前 | 修正後 |
|---|---|---|
| `@SpringBootTest` context 數量 | 5 個（+ `@DirtiesContext` 造成重建） | **1 個** |
| 總啟動時間 | 約 18 秒 | 約 4 秒 |
| 測試總時間 | 約 20 秒 | 約 5 秒 |

**額外收穫**：C + D 合併成參數化測試之後，反而更容易加測試案例
（加一行 CSV 就多一個 case）。

</details>

### 練習 3：修正一組有問題的測試

```java
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Transactional
class OrderApiTest {

    @Autowired TestRestTemplate restTemplate;
    @Autowired OrderRepository orderRepository;
    @Autowired MailSender mailSender;

    @Test
    void 下單成功() {
        var response = restTemplate.postForEntity("/orders",
                new CreateOrderRequest("王小明", new BigDecimal("1280"), "LINE_PAY"),
                OrderResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(orderRepository.count()).isEqualTo(1);

        Thread.sleep(2000);
        assertThat(mailSender.getSentCount()).isEqualTo(1);
    }

    @Test
    void 查詢所有訂單() {
        var response = restTemplate.getForEntity("/orders", OrderResponse[].class);
        assertThat(response.getBody()).hasSize(1);
    }
}
```

<details>
<summary>參考解答</summary>

**六個問題：**

| # | 問題 | 後果 |
|---|---|---|
| 1 | `@Transactional` + `RANDOM_PORT` | 請求在 Tomcat 執行緒，開的是另一個交易且會真的 commit。測試的 rollback 沒有清到那筆資料 |
| 2 | `orderRepository.count()` 斷言 | 這個查詢在測試執行緒的交易裡，**看不到** Tomcat 執行緒剛 commit 的資料（隔離級別）。可能回 0 |
| 3 | `Thread.sleep(2000)` | flaky：機器慢時 2 秒不夠、機器快時浪費 2 秒 |
| 4 | 用真實的 `MailSender` | 測試會真的寄信 |
| 5 | `查詢所有訂單` 斷言 `hasSize(1)` | **依賴前一個測試留下的資料** → 測試順序依賴。單獨執行會失敗 |
| 6 | 沒有清理資料 | 測試之間互相污染，重複執行會累積 |

**修正版：**

```java
package com.example.shop.order;

import com.example.shop.support.SharedContainersConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.math.BigDecimal;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.BDDMockito.then;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(SharedContainersConfig.class)
// ★ 修正 1：不要加 @Transactional ★
class OrderApiTest {

    @Autowired private TestRestTemplate restTemplate;
    @Autowired private OrderRepository orderRepository;

    @MockitoBean private MailSender mailSender;      // ★ 修正 4：mock 掉，不真的寄信 ★

    @AfterEach
    void cleanUp() {
        orderRepository.deleteAll();                 // ★ 修正 6：自己清理 ★
    }

    @Test
    void 下單成功應建立訂單並寄出確認信() {
        var request = new CreateOrderRequest("王小明", new BigDecimal("1280"), "LINE_PAY");

        ResponseEntity<OrderResponse> response =
                restTemplate.postForEntity("/orders", request, OrderResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getBody()).isNotNull();

        // ★ 修正 2：用 API 或明確的新交易查詢，不要依賴測試執行緒的交易 ★
        long orderId = response.getBody().id();
        ResponseEntity<OrderResponse> fetched =
                restTemplate.getForEntity("/orders/" + orderId, OrderResponse.class);
        assertThat(fetched.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(fetched.getBody().customerName()).isEqualTo("王小明");

        // ★ 修正 3：Awaitility 取代 Thread.sleep ★
        await().atMost(Duration.ofSeconds(5))
               .pollInterval(Duration.ofMillis(100))
               .untilAsserted(() -> then(mailSender).should().send(contains("王小明"), anyString()));
    }

    @Test
    void 查詢所有訂單應只回傳本測試建立的資料() {
        // ★ 修正 5：自己準備資料，不依賴其他測試 ★
        restTemplate.postForEntity("/orders",
                new CreateOrderRequest("李小華", new BigDecimal("500"), "LINE_PAY"),
                OrderResponse.class);

        ResponseEntity<OrderResponse[]> response =
                restTemplate.getForEntity("/orders", OrderResponse[].class);

        assertThat(response.getBody()).hasSize(1)
                .extracting(OrderResponse::customerName)
                .containsExactly("李小華");
    }

    @Test
    void 訂單不存在應回404() {
        ResponseEntity<String> response =
                restTemplate.getForEntity("/orders/999999", String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
```

**額外建議**：這種 E2E 測試應該**很少**。上面三個測試方法裡，
「訂單不存在回 404」用 `@WebMvcTest` 測會快十倍且更穩定。
**E2E 只保留「跨越所有層、驗證整條路徑通暢」的那一兩個測試。**

**關於問題 2 的深入說明**（這是最容易誤解的一點）：

```
測試執行緒                          Tomcat 執行緒
    │                                   │
    ├─ (若有 @Transactional) 開交易 T1   │
    │                                   │
    ├─ POST /orders ──────────────────▶ │
    │                                   ├─ 開交易 T2
    │                                   ├─ INSERT order
    │                                   └─ commit T2
    │ ◀───────────────────────────────── │
    │                                   │
    ├─ orderRepository.count()          │
    │  ↑ 在 T1 裡執行                    │
    │  ↑ MySQL 預設 REPEATABLE READ      │
    │  ↑ T1 開始時的快照裡沒有那筆資料     │
    │  → 回傳 0，不是 1 ！                │
```

這就是為什麼「`@Transactional` + `RANDOM_PORT`」是明確的錯誤組合。

</details>

### 練習 4：設計測試策略

你接手一個專案：148 個測試類別全部用 `@SpringBootTest`，測試跑 26 分鐘，
CI 常常逾時，團隊已經習慣 `-DskipTests`。設計一個可以逐步執行的改善計畫。

<details>
<summary>參考解答</summary>

**原則：不要一次重寫全部。先止血、再改善、最後建立防護。**

---

#### 階段 0：測量（第 1 天）

```bash
# ① context 建立次數
./mvnw test 2>&1 | grep -c "initialization completed"

# ② 各測試耗時排名
find target/surefire-reports -name '*.txt' \
  -exec grep -H 'Time elapsed' {} \; | sort -t: -k3 -rn | head -30

# ③ 找出破壞快取的元凶
grep -rln '@DirtiesContext' src/test/ | wc -l
grep -rn '@SpringBootTest' src/test/ -A5 \
  | grep -E 'properties|ActiveProfiles|webEnvironment|MockBean' | sort | uniq -c | sort -rn
```

**產出一份表格**：目前 context 種類、各佔多少時間、哪些測試最慢。

---

#### 階段 1：止血（第 1 週，不改測試邏輯）

**做四件事，預期時間降到 8～10 分鐘：**

```
① 移除所有 @DirtiesContext（逐個確認替換成 @AfterEach 清理）
   → 通常這一項就能省下 30～50% 的時間

② 統一 @SpringBootTest 的設定組合
   建立 @IntegrationTest 註解，把 148 個測試的註解換掉
   （用 IDE 的 Structural Search & Replace 半自動處理）

③ 開啟平行執行
   junit.jupiter.execution.parallel.enabled=true
   → 先在本機驗證有哪些測試因為共用狀態而失敗，標上 @ResourceLock

④ 開啟 Testcontainers 容器重複使用（本機）
   ~/.testcontainers.properties: testcontainers.reuse.enable=true
```

**這個階段的關鍵：完全不改測試邏輯，風險最低，效果最大。**

---

#### 階段 2：分流（第 2 週）

```
① 為所有測試打 @Tag
   - 純計算、沒有 @Autowired 的 → unit（可能有 20 個）
   - 只碰資料庫的 → integration
   - 起 Tomcat 的 → slow

② 設定 surefire / failsafe 分流
   ./mvnw test  → 排除 slow
   ./mvnw verify → 全部

③ CI 改成兩階段
   fast-tests → integration-tests（needs: fast-tests）
```

**效果**：開發者本機跑 `./mvnw test` 只要 3 分鐘，PR 的第一次回饋從 26 分鐘變 3 分鐘。

---

#### 階段 3：重寫（持續進行，每個 Sprint 挑幾個）

**優先順序：改動成本低、效益高的先做。**

```
優先級 1：純業務邏輯的測試 → 純單元測試
  判斷方式：測試裡只 @Autowired 一個 Service，而且沒有碰資料庫
  改法：把 Service 的依賴換成 fake，直接 new
  效益：3 秒 → 3 毫秒（1000 倍）

優先級 2：Controller 測試 → @WebMvcTest
  判斷方式：測試裡有 MockMvc
  改法：@SpringBootTest + @AutoConfigureMockMvc → @WebMvcTest(XxxController.class)
  效益：3 秒 → 0.8 秒

優先級 3：設定相關測試 → ApplicationContextRunner
  判斷方式：@SpringBootTest(properties = ...)
  效益：3 秒 → 0.05 秒，而且不佔 context 快取

優先級 4：Repository 測試 → @DataJpaTest + Testcontainers
  順便解決「H2 騙人」的問題
```

**規則：每個 Sprint 至少改 10 個測試類別，並在 PR 描述裡寫「本次省下 X 秒」。**
讓改善的效果可見，團隊才會持續投入。

---

#### 階段 4：建立防護（第 3 週開始，與階段 3 並行）

```java
// ① 用 ArchUnit 防止倒退
@AnalyzeClasses(packages = "com.example.shop",
                importOptions = ImportOption.OnlyIncludeTests.class)
class TestArchitectureTest {

    @ArchTest
    static final ArchRule 純計算類別的測試不該啟動Spring =
            noClasses().that().haveSimpleNameEndingWith("CalculatorTest")
                    .or().haveSimpleNameEndingWith("MapperTest")
                    .or().haveSimpleNameEndingWith("ValidatorTest")
                    .should().beAnnotatedWith(SpringBootTest.class)
                    .because("純計算邏輯應該用單元測試，啟動 Spring 是浪費");

    @ArchTest
    static final ArchRule不可再新增DirtiesContext =
            noClasses().should().beAnnotatedWith(DirtiesContext.class)
                    .because("@DirtiesContext 破壞 context 快取，改用 @AfterEach 清理狀態");
}
```

```yaml
# ② CI 加上時間上限
- name: 快測試（含時間上限）
  timeout-minutes: 5              # ★ 超過就失敗，防止慢慢惡化 ★
  run: ./mvnw -B test
```

```java
// ③ 監控 context 數量
@Test
void context種類不應超過三種() {
    // 這個測試要放在最後執行（用 @Order 或獨立的 verification 階段）
    // 讀 DefaultContextCache 的統計，斷言 missCount <= 3
}
```

---

#### 預期成果

| 階段 | 時間 | 累計投入 |
|---|---|---|
| 現況 | 26 分 | — |
| 階段 1 後 | 9 分 | 1 週 |
| 階段 2 後 | 本機 3 分 / CI 9 分 | 2 週 |
| 階段 3 進行中（3 個月） | 本機 1 分 / CI 4 分 | 每 Sprint 少量 |

---

#### 最重要的一件事：先讓團隊不再 `-DskipTests`

**技術改善再好，如果團隊已經不信任測試，就沒有意義。**

所以階段 1 要先做，而且要**公開宣布**：
「從今天起 `./mvnw test` 只要 3 分鐘，請不要再 skip。」

同時修掉所有目前紅燈的測試（就算是 `@Disabled` 也比紅燈好——
紅燈會讓大家習慣「測試紅是正常的」，這是最糟的狀態）。

</details>

---

## 7.15 驗收清單

- [ ] 我能說出測試金字塔的三層，並判斷一個需求該寫在哪一層。
- [ ] 我知道「能不啟動 Spring 就不要啟動」，也知道需要啟動通常代表設計問題。
- [ ] 我知道 `spring-boot-starter-test` 帶進了哪些函式庫。
- [ ] **我能解釋測試 context 快取的機制，並說出快取 key 由哪些項目組成。**
- [ ] 我能列出六種破壞 context 快取的行為。
- [ ] 我知道 `@DirtiesContext` 幾乎總是錯的解法，並會用 `@AfterEach` 主動清理取代。
- [ ] 我會用自訂註解（如 `@IntegrationTest`）把設定組合收斂成少數幾種。
- [ ] 我會開啟 `org.springframework.test.context.cache` 的 DEBUG 日誌檢查 `missCount`。
- [ ] 我能說出四種 `webEnvironment` 的差別。
- [ ] **我知道 `RANDOM_PORT` 的請求在 Tomcat 執行緒，`@Transactional` 不會 rollback。**
- [ ] 我知道 `TestRestTemplate` 不會對 4xx/5xx 拋例外。
- [ ] 我會用 `@WebMvcTest(XxxController.class)` 只載入需要的 Controller。
- [ ] 我知道 `@WebMvcTest` 不會載入 `@Service`，要用 `@MockitoBean` 提供。
- [ ] 我知道 `@MockitoBean` / `@MockitoSpyBean` 取代了 `@MockBean` / `@SpyBean`。
- [ ] 我會用 `MockMvcTester` 寫 AssertJ 風格的 Web 層測試。
- [ ] 我知道 `@WebMvcTest` 會載入 Security 設定，也知道這通常是好事。
- [ ] 我會用 `@JsonTest`、`@RestClientTest` 做更輕量的切片測試。
- [ ] **我能說出至少五項 H2 與 MySQL 的行為差異，以及各自造成什麼線上問題。**
- [ ] 我會用 Testcontainers + `@ServiceConnection` 跑真實資料庫。
- [ ] 我知道 `@DataJpaTest` + Testcontainers 一定要加 `@AutoConfigureTestDatabase(replace = NONE)`。
- [ ] 我知道 `@DataJpaTest` 裡要 `flush()` + `clear()` 才是真的測資料庫。
- [ ] 我會用 `static` 容器 + `withReuse(true)` 讓 Testcontainers 快起來。
- [ ] 我知道 `withReuse` 在 CI 上不該開，且資料會殘留。
- [ ] 我知道 `spring-boot-docker-compose` 可以改善新人上手體驗。
- [ ] 我會用 `ApplicationContextRunner` 測自動組態與設定綁定。
- [ ] 我會用 `@RecordApplicationEvents` 測事件、用 Awaitility 測非同步。
- [ ] 我會用 `OutputCaptureExtension` 驗證日誌沒有洩漏敏感資料。
- [ ] 我會用 ArchUnit 把架構規則變成 CI 檢查。
- [ ] 我會用 `@Tag` + surefire/failsafe 做測試分流。
- [ ] 我知道平行執行的常見問題與 `@ResourceLock` 的用法。
- [ ] 我會用注入 `Clock` 取代 `Instant.now()`，讓時間相關斷言穩定。
- [ ] 我能診斷「測試慢」「偶發失敗」「互相影響」三類問題。
- [ ] 我會用 Object Mother 模式建構測試資料。
- [ ] 我知道「mock 太多會變成測試實作細節」，並優先驗證結果與可觀察的副作用。
- [ ] 我會寫負向斷言（「不該發生的事沒有發生」）。

---

完成後請前往 [08-packaging-docker-and-deployment.md](./08-packaging-docker-and-deployment.md)。
