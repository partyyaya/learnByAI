# 第 01 章：IoC 容器與依賴注入

> 這是整個 Spring 的地基。後面所有的「魔法」——`@Transactional`、`@Cacheable`、`@PreAuthorize`——
> 都建立在一件事上：**你的物件不是你 `new` 出來的，是容器建立、組裝、包裝後交給你的。**
> 只要你手上拿的不是「原始物件」而是「容器給你的東西」，框架就有機會在中間動手腳。
>
> 這一章要回答三個問題：
> 1. 為什麼「不要自己 `new`」不是潔癖，而是**能不能寫測試**的問題。
> 2. 容器怎麼知道要建立哪些物件、怎麼決定注入誰。
> 3. 一個 Bean 從無到有經過哪些階段——你可以在哪些點插手。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 用一段真實的重構，說明「自己 `new` 依賴」如何讓程式無法測試、無法擴充。
- 精確區分 IoC（控制反轉）、DI（依賴注入）、DIP（依賴反轉原則）三個名詞。
- 說明 `BeanFactory` 與 `ApplicationContext` 的差別，以及為什麼實務上都用後者。
- 用三種方式註冊 Bean（`@Component` 家族、`@Bean` 方法、程式化註冊），並知道各自的適用場景。
- 說出元件掃描的規則與四個常見陷阱。
- 說明為什麼**建構子注入**是唯一該用的注入方式，並能舉出欄位注入造成的三個實際問題。
- 處理「同型別多個 Bean」：`@Primary`、`@Qualifier`、名稱匹配、注入 `List` / `Map`（策略模式）。
- 說出五種 Bean 作用域，並解釋「單例注入原型」的坑與三種解法。
- 畫出 Bean 生命週期完整流程，說出 `BeanPostProcessor` 在哪一步、AOP 代理在哪一步產生。
- 診斷循環依賴，說明 Spring Boot 2.6 之後為什麼預設禁止，以及正確的解法。
- 說明 `@Configuration` 的 `proxyBeanMethods` 是什麼，什麼時候會咬到你。
- 用 `/actuator/beans` 與 `ApplicationContext` API 除錯「Bean 到底有沒有進容器」。

---

## 1.2 從一次真實的重構開始

需求：**訂單成立後，要寄一封確認信給客戶。**

### 版本 0：全部自己 `new`

```java
package com.example.shop.service;

import java.math.BigDecimal;

public class OrderService {

    // ① 依賴寫死在欄位初始化
    private final OrderRepository repository = new JdbcOrderRepository();
    private final EmailNotifier notifier = new EmailNotifier();

    public Order placeOrder(String customerName, BigDecimal amount) {
        Order order = new Order(null, customerName, amount, "CREATED");
        Order saved = repository.save(order);
        notifier.send(customerName, "您的訂單 " + saved.id() + " 已成立");
        return saved;
    }
}
```

配合這些類別：

```java
package com.example.shop.service;

import java.math.BigDecimal;

public record Order(Long id, String customerName, BigDecimal amount, String status) { }
```

```java
package com.example.shop.service;

public class JdbcOrderRepository {
    public Order save(Order order) {
        // 真的寫進 MySQL
        throw new UnsupportedOperationException("實際會執行 INSERT");
    }
}
```

```java
package com.example.shop.service;

public class EmailNotifier {
    public void send(String to, String message) {
        // 真的透過 SMTP 寄信
        throw new UnsupportedOperationException("實際會呼叫 SMTP 伺服器");
    }
}
```

**現在試著寫一個測試**，驗證「金額為負數時要拒絕下單」：

```java
@Test
void 金額為負數時應拒絕() {
    OrderService service = new OrderService();   // ← 這一行就爆了
    // 因為 new OrderService() 會連帶 new JdbcOrderRepository()
    // → 需要一台真的 MySQL
    // 還會 new EmailNotifier() → 需要一台真的 SMTP
}
```

**這才是「不要自己 new」的真正理由**：不是設計潔癖，是`new OrderService()` 這一行會把整個世界拖進來。

再看擴充性：

| 需求 | 這個設計要怎麼改 |
|---|---|
| 測試時不要真的寄信 | 改 `OrderService` 的原始碼 |
| 改用簡訊通知 | 改 `OrderService` 的原始碼 |
| 同時寄信 **和** 發簡訊 | 改 `OrderService` 的原始碼 |
| 從 MySQL 換成 PostgreSQL | 改 `OrderService` 的原始碼 |
| 開發環境用記憶體儲存 | 改 `OrderService` 的原始碼 |

**每一個變化都要改一個「跟商業邏輯無關」的類別。** 這就是耦合。

### 版本 1：抽介面 + 建構子注入（手動）

```java
package com.example.shop.service;

public interface OrderRepository {
    Order save(Order order);
}
```

```java
package com.example.shop.service;

public interface Notifier {
    void send(String to, String message);
}
```

```java
package com.example.shop.service;

import java.math.BigDecimal;

public class OrderService {

    private final OrderRepository repository;
    private final Notifier notifier;

    // ① 依賴從外面傳進來，這個類別不再決定「用哪個實作」
    public OrderService(OrderRepository repository, Notifier notifier) {
        this.repository = repository;
        this.notifier = notifier;
    }

    public Order placeOrder(String customerName, BigDecimal amount) {
        if (amount.signum() <= 0) {
            throw new IllegalArgumentException("金額必須大於 0");
        }
        Order order = new Order(null, customerName, amount, "CREATED");
        Order saved = repository.save(order);
        notifier.send(customerName, "您的訂單 " + saved.id() + " 已成立");
        return saved;
    }
}
```

現在測試變成這樣（用手寫的假實作，不需要 Mockito）：

```java
package com.example.shop.service;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class OrderServiceTest {

    // 假的 Repository：記在記憶體裡，還會自動編號
    static class FakeOrderRepository implements OrderRepository {
        private final List<Order> saved = new ArrayList<>();
        @Override
        public Order save(Order order) {
            Order withId = new Order((long) saved.size() + 1,
                    order.customerName(), order.amount(), order.status());
            saved.add(withId);
            return withId;
        }
    }

    // 假的 Notifier：只記錄「有沒有被呼叫、內容是什麼」
    static class RecordingNotifier implements Notifier {
        record Sent(String to, String message) { }
        private final List<Sent> messages = new ArrayList<>();
        @Override
        public void send(String to, String message) {
            messages.add(new Sent(to, message));
        }
    }

    @Test
    void 下單成功時應寄出通知() {
        FakeOrderRepository repo = new FakeOrderRepository();
        RecordingNotifier notifier = new RecordingNotifier();
        OrderService service = new OrderService(repo, notifier);   // ← 一行就組好，不碰 DB 也不寄信

        Order order = service.placeOrder("王小明", new BigDecimal("1280"));

        assertThat(order.id()).isEqualTo(1L);
        assertThat(notifier.messages).hasSize(1);
        assertThat(notifier.messages.get(0).message()).contains("訂單 1 已成立");
    }

    @Test
    void 金額為負數時應拒絕() {
        OrderService service = new OrderService(new FakeOrderRepository(), new RecordingNotifier());

        assertThatThrownBy(() -> service.placeOrder("王小明", new BigDecimal("-1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("金額必須大於 0");
    }
}
```

**這個測試 3 毫秒跑完，不需要 MySQL、不需要 SMTP、不會誤寄信給真客戶。**

> 這個設計在 01-java-core 第 03 章已經出現過（抽出介面、手動組裝依賴）。
> 當時我說「這是 DI 的原型」，現在正式接上。

### 版本 1 的問題：組裝程式碼會爆炸

```java
public static void main(String[] args) {
    DataSource dataSource = new HikariDataSource(hikariConfig());
    OrderRepository repository = new JdbcOrderRepository(dataSource);
    JavaMailSender mailSender = new JavaMailSenderImpl(/* host, port, 帳密... */);
    Notifier notifier = new EmailNotifier(mailSender, templateEngine);
    PaymentGateway gateway = new StripeGateway(httpClient, apiKey);
    InventoryService inventory = new InventoryService(repository, lockManager);
    OrderService orderService = new OrderService(repository, notifier);
    OrderController controller = new OrderController(orderService, inventory, gateway);
    // ... 一個中型專案這裡會有 200 行
}
```

問題不只是長：

- 順序不能錯（`dataSource` 一定要在 `repository` 前面）。
- 加一個依賴，要改好幾個地方。
- 「只在正式環境用真的金流，開發環境用假的」要寫 `if`。

**IoC 容器就是把這 200 行自動化的東西。**

### 版本 2：交給 Spring 容器

```java
package com.example.shop.service;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;

@Service                                   // ① 「我是一個 Bean，請掃描我」
public class OrderService {

    private final OrderRepository repository;
    private final Notifier notifier;

    // ② 只有一個建構子時，Spring 自動用它注入（不需要 @Autowired）
    public OrderService(OrderRepository repository, Notifier notifier) {
        this.repository = repository;
        this.notifier = notifier;
    }

    public Order placeOrder(String customerName, BigDecimal amount) {
        if (amount.signum() <= 0) {
            throw new IllegalArgumentException("金額必須大於 0");
        }
        Order order = new Order(null, customerName, amount, "CREATED");
        Order saved = repository.save(order);
        notifier.send(customerName, "您的訂單 " + saved.id() + " 已成立");
        return saved;
    }
}
```

```java
package com.example.shop.service;

import org.springframework.stereotype.Repository;

@Repository
public class JdbcOrderRepository implements OrderRepository {
    @Override
    public Order save(Order order) {
        // 先假裝存起來，第 06 站才接真的 JdbcTemplate
        return new Order(1001L, order.customerName(), order.amount(), order.status());
    }
}
```

```java
package com.example.shop.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class EmailNotifier implements Notifier {
    private static final Logger log = LoggerFactory.getLogger(EmailNotifier.class);

    @Override
    public void send(String to, String message) {
        log.info("[EMAIL] to={} message={}", to, message);
    }
}
```

**沒有任何組裝程式碼。** 容器啟動時：

```
① 掃描 com.example.shop 及子套件
② 找到 @Service OrderService、@Repository JdbcOrderRepository、@Component EmailNotifier
③ 分析 OrderService 的建構子，發現它要 OrderRepository 與 Notifier
④ 在容器裡找型別符合的：JdbcOrderRepository ✅、EmailNotifier ✅
⑤ 先建好那兩個，再用它們建立 OrderService
```

**重點：測試性完全沒有損失。** 上面那份 `OrderServiceTest` 一個字都不用改——
因為 `new OrderService(fakeRepo, fakeNotifier)` 依然合法。這就是建構子注入的價值。

---

## 1.3 三個名詞的精確定義

這三個詞常被混用，但意思不一樣。

### 控制反轉（IoC, Inversion of Control）

**一種設計原則**：把「流程控制權」從你的程式碼交給框架。

```
傳統程式：   你的程式 → 呼叫 → 函式庫        （你控制流程）
IoC：       框架 → 呼叫 → 你的程式          （框架控制流程，你填空）
```

這也叫「好萊塢原則」：*Don't call us, we'll call you.*

**DI 只是 IoC 的一種實作方式**。其他 IoC 的例子：

- 你寫 `@GetMapping` 的方法，是 Spring MVC 決定何時呼叫它。
- 你寫 JUnit 的 `@Test` 方法，是 JUnit 決定何時呼叫它。
- 你寫 `onClick` 回呼，是 UI 框架決定何時呼叫它。

### 依賴注入（DI, Dependency Injection）

**IoC 的具體手法**：物件不自己建立依賴，而是由外部傳入。

三種注入點：建構子、setter、欄位（反射）。

### 依賴反轉原則（DIP, Dependency Inversion Principle）

**SOLID 的 D**，講的是**依賴的方向**：

```
❌ 沒有 DIP：
   OrderService  ──依賴──▶  JdbcOrderRepository（具體實作）
   高層模組依賴低層模組

✅ 有 DIP：
   OrderService  ──依賴──▶  OrderRepository（介面）
                                   ▲
                                   │實作
                          JdbcOrderRepository
   兩者都依賴抽象，而且「介面屬於高層模組」
```

> **最後那句是關鍵，也最常被忽略**：`OrderRepository` 這個介面應該放在 **service 層**（由使用方定義），
> 而不是 repository 層（由實作方定義）。因為介面是「Service 需要什麼」，不是「Repository 能提供什麼」。
>
> 實務上大家常常把介面放在 `repository` 套件裡——這在中小型專案沒什麼問題，
> 但當你要做六角架構 / Clean Architecture 時，這個方向就很重要了。

### 一句話總結三者

> **DIP 說「該依賴抽象」，DI 說「依賴從外面傳進來」，IoC 容器說「我來負責傳」。**

---

## 1.4 Spring 容器：`BeanFactory` 與 `ApplicationContext`

```
BeanFactory（介面）
   最基本的容器：getBean()、containsBean()、isSingleton()
   延遲載入：呼叫 getBean() 時才建立
        ▲
        │ 繼承並擴充
        │
ApplicationContext（介面）
   BeanFactory 全部功能，再加上：
   ├─ MessageSource        國際化訊息
   ├─ ApplicationEventPublisher  事件發布（第 06 章）
   ├─ ResourcePatternResolver    資源載入（classpath*:、file:）
   ├─ Environment          設定與 Profile（第 03 章）
   └─ 預設「立即初始化」所有單例 Bean
        ▲
        │
   常見實作：
   ├─ AnnotationConfigApplicationContext              純 Java 應用
   ├─ AnnotationConfigServletWebServerApplicationContext   Spring Boot Web（內嵌 Tomcat）
   └─ AnnotationConfigReactiveWebServerApplicationContext  WebFlux
```

**你在 Spring Boot 裡拿到的一定是 `ApplicationContext`。** `BeanFactory` 是內部細節。

### 一個關鍵設計決定：立即初始化

`ApplicationContext` **預設在啟動時就把所有單例 Bean 建好**，而不是等到第一次用。

這看起來像是「啟動變慢」的缺點，但它換到一個非常重要的好處：

> **設定錯誤在啟動時就爆，而不是在半夜三點使用者按下按鈕時才爆。**

```
延遲初始化（BeanFactory 預設）：
  啟動成功 → 上線 → 使用者觸發某個很少用的功能 → 才發現 Bean 建不起來 → 500

立即初始化（ApplicationContext 預設）：
  啟動時就發現 Bean 建不起來 → 服務起不來 → 部署失敗 → 沒有流量進來
```

**這叫 fail fast，是 Spring 一個很重要的設計哲學。**
所以「加 `spring.main.lazy-initialization=true` 讓啟動變快」這件事，
在開發環境很好用，**正式環境要非常小心**。

### 拿到容器本身

```java
package com.example.shop;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

import java.util.Arrays;

@Component
public class ContextInspector {

    private final ApplicationContext context;   // 容器本身也是一個 Bean，可以注入

    public ContextInspector(ApplicationContext context) {
        this.context = context;
    }

    public void printBeans() {
        Arrays.stream(context.getBeanDefinitionNames())
              .filter(name -> name.startsWith("order"))
              .forEach(name -> System.out.println(
                      name + " -> " + context.getBean(name).getClass().getName()));
    }
}
```

> ⚠️ **注入 `ApplicationContext` 然後到處 `getBean()` 是反模式**（叫 Service Locator）。
> 它把「我需要什麼」藏在方法內部，測試時要 mock 整個容器。
> **只在除錯、框架整合、動態決定實作**時才這樣用。

---

## 1.5 註冊 Bean 的三條路

### 路徑 A：`@Component` 家族 + 元件掃描

```java
@Component      // 通用
@Service        // 商業邏輯層
@Repository     // 資料存取層（額外有：例外轉譯，見下方）
@Controller     // Web 層（回樣板）
@RestController // Web 層（回 JSON）= @Controller + @ResponseBody
@Configuration  // 組態類別
```

翻開原始碼會發現，`@Service` 就是這樣：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Component                       // ← 就是加了這個
public @interface Service {
    @AliasFor(annotation = Component.class)
    String value() default "";
}
```

**所以它們對容器來說幾乎沒有差別**，價值在於**表達意圖**——看到 `@Service` 就知道這是業務邏輯層。

**唯一有實際功能差異的是 `@Repository`**：它會啟動**持久層例外轉譯**（`PersistenceExceptionTranslationPostProcessor`），
把各家資料庫的原生例外翻譯成 Spring 的 `DataAccessException` 階層：

```java
// 沒有 @Repository：
//   MySQL 主鍵重複 → SQLIntegrityConstraintViolationException（errorCode 1062）
//   PostgreSQL 同樣狀況 → PSQLException（SQLState 23505）
//   → 你的 catch 要針對不同資料庫寫不同邏輯

// 有 @Repository：
//   兩者都變成 org.springframework.dao.DuplicateKeyException
@Repository
public class JdbcOrderRepository implements OrderRepository {
    // ...
}
```

#### Bean 的預設名稱

```java
@Service
public class OrderService { }          // Bean 名稱：orderService（首字母小寫）

@Service("myOrderService")
public class OrderService { }          // Bean 名稱：myOrderService

@Service
public class URLParser { }             // Bean 名稱：URLParser（⚠️ 前兩個字母都大寫時，保持原樣）
```

最後那個規則來自 `java.beans.Introspector.decapitalize()`：
**如果前兩個字元都是大寫，就不做首字母轉小寫**。所以 `URLParser` 的 Bean 名稱是 `URLParser` 不是 `uRLParser`。
這在用名稱注入（`@Qualifier("...")`）時會咬人。

### 路徑 B：`@Bean` 方法（第三方類別必用）

```java
package com.example.shop.config;

import com.zaxxer.hikari.HikariDataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

import javax.sql.DataSource;
import java.time.Duration;

@Configuration
public class InfrastructureConfig {

    // ① 第三方類別無法加 @Component（原始碼不是你的）
    @Bean
    public RestClient paymentRestClient() {
        return RestClient.builder()
                .baseUrl("https://api.payment.example.com")
                .build();
    }

    // ② 需要複雜建構邏輯
    @Bean(destroyMethod = "close")
    public DataSource dataSource() {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:mysql://localhost:3306/shop");
        ds.setUsername("root");
        ds.setPassword("root");
        ds.setMaximumPoolSize(10);
        ds.setConnectionTimeout(Duration.ofSeconds(3).toMillis());
        return ds;
    }

    // ③ @Bean 方法的參數，也會被容器自動注入
    @Bean
    public OrderReportService orderReportService(DataSource dataSource) {
        return new OrderReportService(dataSource);
    }
}
```

**`@Bean` 方法的名稱就是 Bean 名稱**（上面分別是 `paymentRestClient`、`dataSource`、`orderReportService`）。

| 特性 | `@Component` 掃描 | `@Bean` 方法 |
|---|---|---|
| 適用 | 你自己寫的類別 | 第三方類別、需要邏輯的建構 |
| 控制程度 | 低（容器決定怎麼建） | 高（你自己 `new`） |
| 一個類別可以有幾個 Bean | 1 個 | 多個（不同方法回傳同型別） |
| 條件式建立 | `@Conditional` 系列 | 同上，或直接在方法裡寫 `if` |

### 路徑 C：程式化註冊（框架整合才會用）

```java
package com.example.shop.config;

import org.springframework.beans.factory.support.BeanDefinitionBuilder;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.core.type.AnnotationMetadata;

public class FeatureFlagRegistrar implements ImportBeanDefinitionRegistrar {

    @Override
    public void registerBeanDefinitions(AnnotationMetadata metadata,
                                        BeanDefinitionRegistry registry) {
        // 動態決定要註冊哪些 Bean（例如掃描到什麼就註冊什麼）
        registry.registerBeanDefinition("featureFlags",
                BeanDefinitionBuilder.genericBeanDefinition(FeatureFlags.class)
                        .addConstructorArgValue("orders,payments")
                        .getBeanDefinition());
    }
}
```

**這是 Spring Data JPA 的做法**：你只宣告 `interface OrderRepository extends JpaRepository<...>`，
沒有任何實作類別，是 `RepositoryBeanDefinitionRegistrarSupport` 在啟動時掃描到介面，
動態產生代理實作再註冊進容器。Mybatis 的 `@MapperScan` 同理。

**日常開發用不到，但看懂它，你就知道「為什麼一個介面可以被注入」。**

---

## 1.6 元件掃描的規則與陷阱

### 預設規則

`@SpringBootApplication` 隱含 `@ComponentScan`，**基準套件是主類別所在的套件**。

```
com.example.shop                 ← ShopServiceApplication
├── web/         ✅
├── service/     ✅
├── repository/  ✅
└── config/      ✅

com.example.common               ❌ 掃不到
```

### 陷阱 ①：主類別放錯位置（第 00 章講過，這裡補救法）

```java
// 需要額外掃描時
@SpringBootApplication(scanBasePackages = {"com.example.shop", "com.example.common"})

// 或用類別當標記（重構改套件名時不會漏掉，比字串安全）
@SpringBootApplication(scanBasePackageClasses = {ShopServiceApplication.class, CommonMarker.class})
```

### 陷阱 ②：掃描範圍過寬

```java
@ComponentScan("com.example")     // ⚠️ 或更慘的 @ComponentScan("com")
```

後果：

- 啟動變慢（要掃描所有 jar 裡的 `com.**`）。
- **意外把第三方函式庫的 `@Component` 註冊進來**，造成莫名其妙的 Bean。
- 測試時載入了不該載入的東西。

### 陷阱 ③：`@Configuration` 類別被掃到的時機

```java
@Configuration
public class AppConfig {
    @Bean
    public Foo foo() { return new Foo(); }
}
```

`@Configuration` 本身是 `@Component`，所以它**也要在掃描範圍內**才會生效。
「我明明寫了 `@Bean` 為什麼沒有這個 Bean」——先確認這個 `@Configuration` 類別的套件位置。

### 陷阱 ④：過濾器用錯

```java
@ComponentScan(
    basePackages = "com.example.shop",
    excludeFilters = @ComponentScan.Filter(
        type = FilterType.ASSIGNABLE_TYPE,
        classes = LegacyOrderService.class))
public class AppConfig { }
```

四種常用的 `FilterType`：

| type | 用途 | 範例 |
|---|---|---|
| `ANNOTATION` | 依註解 | 排除所有 `@Deprecated` |
| `ASSIGNABLE_TYPE` | 依型別 | 排除特定類別 |
| `ASPECTJ` | AspectJ 運算式 | `com.example..*Legacy*` |
| `REGEX` | 正規表示式 | `.*\.legacy\..*` |

> ⚠️ 常見誤解：`excludeFilters` **只影響掃描**。
> 如果那個 Bean 是被 `@Bean` 方法或自動組態註冊的，過濾器不會有任何作用。

### 診斷工具：Bean 到底有沒有進去

```bash
# 方法 1：Actuator
curl -s localhost:8080/actuator/beans | jq -r \
  '.contexts.application.beans | to_entries[] | select(.key|test("order";"i")) | "\(.key)\t\(.value.type)"'

# 方法 2：程式裡列出來
```

```java
package com.example.shop;

import org.springframework.boot.CommandLineRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

import java.util.Arrays;

@Component
public class BeanPrinter implements CommandLineRunner {

    private final ApplicationContext context;

    public BeanPrinter(ApplicationContext context) {
        this.context = context;
    }

    @Override
    public void run(String... args) {
        String[] names = context.getBeanDefinitionNames();
        Arrays.sort(names);
        System.out.println("容器內共有 " + names.length + " 個 Bean：");
        Arrays.stream(names)
              .filter(n -> !n.startsWith("org.springframework"))   // 濾掉框架自己的
              .forEach(n -> System.out.printf("  %-45s %s%n",
                      n, context.getType(n) == null ? "?" : context.getType(n).getSimpleName()));
    }
}
```

---

## 1.7 三種注入方式，以及為什麼只該用建構子

### 三種寫法對照

```java
package com.example.shop.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

// ────────────── ① 欄位注入（Field Injection）──────────────
@Service
public class FieldInjectionService {
    @Autowired private OrderRepository repository;    // ⚠️ 不要用
    @Autowired private Notifier notifier;
}

// ────────────── ② Setter 注入 ──────────────
@Service
public class SetterInjectionService {
    private OrderRepository repository;

    @Autowired
    public void setRepository(OrderRepository repository) {
        this.repository = repository;
    }
}

// ────────────── ③ 建構子注入（Constructor Injection）✅ ──────────────
@Service
public class ConstructorInjectionService {
    private final OrderRepository repository;   // 可以是 final
    private final Notifier notifier;

    // Spring 4.3+：只有一個建構子時，@Autowired 可以省略
    public ConstructorInjectionService(OrderRepository repository, Notifier notifier) {
        this.repository = repository;
        this.notifier = notifier;
    }
}
```

### 為什麼建構子注入贏

#### 理由 1：可以用 `final`，物件建好就不可變

```java
private final OrderRepository repository;    // 建構子注入 ✅
@Autowired private OrderRepository repository;  // 欄位注入 ❌ 不能 final
```

`final` 保證：物件一旦建立，這個依賴永遠不會變成 `null`，也不會被別人偷換掉。
在多執行緒環境下，`final` 欄位還有記憶體可見性保證（安全發布）。

#### 理由 2：測試不需要框架

```java
// 建構子注入：一行就組好
OrderService service = new OrderService(fakeRepo, fakeNotifier);

// 欄位注入：只能靠反射或啟動整個 Spring
OrderService service = new OrderService();
ReflectionTestUtils.setField(service, "repository", fakeRepo);       // 😩 用字串指定欄位名
ReflectionTestUtils.setField(service, "notifier", fakeNotifier);     // 改欄位名，測試不會編譯錯，會執行期錯
// 或
@SpringBootTest   // 😩 一個單元測試要啟動整個應用程式
```

#### 理由 3：依賴過多會「痛」，而痛是好事

```java
// 建構子注入：一眼就看出這個類別做太多事
public OrderService(OrderRepository orderRepository,
                    InventoryRepository inventoryRepository,
                    CouponRepository couponRepository,
                    PaymentGateway paymentGateway,
                    ShippingService shippingService,
                    Notifier notifier,
                    AuditLogger auditLogger,
                    CacheManager cacheManager) {       // ← 8 個依賴，這個類別該拆了
    // ...
}

// 欄位注入：8 個 @Autowired 散落在類別各處，你不會注意到問題
```

> **這叫「設計壓力」**：好的設計應該讓壞味道**看起來就不舒服**。
> 欄位注入把這個訊號藏起來了。

#### 理由 4：循環依賴在啟動時就爆

建構子注入無法建立循環依賴（A 要 B、B 要 A，誰先建？），Spring 直接啟動失敗。
欄位注入則會**成功啟動**，然後在某個時間點出現難以解釋的行為（見 1.13）。

#### 理由 5：不會有 `NullPointerException` 的驚喜

```java
@Service
public class BadService {
    @Autowired private OrderRepository repository;

    public BadService() {
        repository.findAll();     // 💥 NPE：建構子執行時，欄位注入還沒發生
    }
}
```

欄位注入的順序是「先呼叫無參數建構子 → 再用反射塞欄位」。所以建構子裡拿不到依賴。

### Lombok 讓建構子注入不囉唆

```java
package com.example.shop.service;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor    // 為所有 final 欄位產生一個建構子
public class OrderService {
    private final OrderRepository repository;
    private final Notifier notifier;
    // 不用手寫建構子了
}
```

> **取捨**：`@RequiredArgsConstructor` 很方便，但它也讓「依賴變多」變得無痛——
> 加一個 `private final` 欄位就好，你不會感覺到痛。這削弱了理由 3。
> 我的建議：**用它，但定期檢查每個 Service 的欄位數量**（超過 5 個就該檢討）。

### 例外情況：什麼時候 setter 注入才合理

只有兩種：

1. **真正可選的依賴**（有沒有都能運作）：

```java
@Service
public class OrderService {
    private final OrderRepository repository;
    private MetricsCollector metrics = MetricsCollector.NOOP;   // 有預設值

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    @Autowired(required = false)
    public void setMetrics(MetricsCollector metrics) {
        this.metrics = metrics;
    }
}
```

2. **必須支援重新設定**（極少見，通常是框架整合）。

> 更好的「可選依賴」寫法是用 `ObjectProvider`（見 1.10）或 `Optional`：
>
> ```java
> public OrderService(OrderRepository repository, Optional<MetricsCollector> metrics) {
>     this.repository = repository;
>     this.metrics = metrics.orElse(MetricsCollector.NOOP);
> }
> ```

---

## 1.8 同型別有多個 Bean 怎麼辦

這是實務上最常遇到的狀況。用一個真實需求來講：**系統要支援多種付款方式**。

```java
package com.example.shop.payment;

import java.math.BigDecimal;

public interface PaymentProcessor {
    /** 這個處理器支援哪種付款方式 */
    String method();
    void charge(String orderId, BigDecimal amount);
}
```

```java
package com.example.shop.payment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;

@Component
public class CreditCardProcessor implements PaymentProcessor {
    private static final Logger log = LoggerFactory.getLogger(CreditCardProcessor.class);

    @Override public String method() { return "CREDIT_CARD"; }

    @Override public void charge(String orderId, BigDecimal amount) {
        log.info("刷卡 {} 元，訂單 {}", amount, orderId);
    }
}
```

```java
package com.example.shop.payment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;

@Component
public class LinePayProcessor implements PaymentProcessor {
    private static final Logger log = LoggerFactory.getLogger(LinePayProcessor.class);

    @Override public String method() { return "LINE_PAY"; }

    @Override public void charge(String orderId, BigDecimal amount) {
        log.info("LINE Pay 扣款 {} 元，訂單 {}", amount, orderId);
    }
}
```

```java
package com.example.shop.payment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;

@Component
public class BankTransferProcessor implements PaymentProcessor {
    private static final Logger log = LoggerFactory.getLogger(BankTransferProcessor.class);

    @Override public String method() { return "BANK_TRANSFER"; }

    @Override public void charge(String orderId, BigDecimal amount) {
        log.info("產生轉帳虛擬帳號，金額 {}，訂單 {}", amount, orderId);
    }
}
```

現在直接注入會炸：

```java
@Service
public class PaymentService {
    private final PaymentProcessor processor;   // 💥 有三個候選

    public PaymentService(PaymentProcessor processor) {
        this.processor = processor;
    }
}
```

```
Parameter 0 of constructor in com.example.shop.payment.PaymentService required a
single bean, but 3 were found:
	- bankTransferProcessor: defined in file [.../BankTransferProcessor.class]
	- creditCardProcessor: defined in file [.../CreditCardProcessor.class]
	- linePayProcessor: defined in file [.../LinePayProcessor.class]

Action:
Consider marking one of the beans as @Primary, updating the consumer to accept
multiple beans, or using @Qualifier to identify the bean that should be consumed
```

### 解法 ①：`@Primary` — 指定預設

```java
@Component
@Primary                     // 「沒特別指定時就用我」
public class CreditCardProcessor implements PaymentProcessor { /* ... */ }
```

適用：**有明顯的「主要實作」，其他是特例**。

### 解法 ②：`@Qualifier` — 明確指名

```java
@Service
public class PaymentService {
    private final PaymentProcessor processor;

    public PaymentService(@Qualifier("linePayProcessor") PaymentProcessor processor) {
        this.processor = processor;
    }
}
```

**用字串指名的缺點**：改類別名字時，字串不會跟著改，而且拼錯只有執行期才知道。

**更好的做法：自訂 qualifier 註解**，讓編譯器幫你檢查。

```java
package com.example.shop.payment;

import org.springframework.beans.factory.annotation.Qualifier;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Qualifier
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.FIELD, ElementType.METHOD, ElementType.PARAMETER, ElementType.TYPE})
public @interface LinePay { }
```

```java
@Component
@LinePay                                 // 標記實作
public class LinePayProcessor implements PaymentProcessor { /* ... */ }
```

```java
@Service
public class PaymentService {
    private final PaymentProcessor processor;

    public PaymentService(@LinePay PaymentProcessor processor) {   // 型別安全，改名有 IDE 支援
        this.processor = processor;
    }
}
```

### 解法 ③：靠參數名稱匹配（隱藏規則，別依賴它）

```java
@Service
public class PaymentService {
    // 參數名稱 linePayProcessor 剛好等於 Bean 名稱 → 匹配成功
    public PaymentService(PaymentProcessor linePayProcessor) {
        // ...
    }
}
```

**能動，但很脆弱**：

- 依賴編譯時保留參數名稱（Spring Boot 的 parent POM 有開 `-parameters`，但別的建置設定不一定有）。
- 重構改參數名，程式就壞了，而且沒有任何編譯錯誤。

> **實務規則：不要依賴參數名稱匹配。** 要指名就用 `@Qualifier` 或自訂註解。

### 解法 ④（最重要）：注入 `Map` / `List` — 策略模式

**這才是「多實作」情境的正解**。因為需求通常不是「選一個」，而是「依訂單的付款方式動態決定」。

```java
package com.example.shop.payment;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
public class PaymentService {

    /** key = 付款方式代碼，value = 對應的處理器 */
    private final Map<String, PaymentProcessor> processors;

    // ① 注入 List<PaymentProcessor>：Spring 把「所有」實作都給你
    public PaymentService(List<PaymentProcessor> processorList) {
        this.processors = processorList.stream()
                .collect(Collectors.toMap(PaymentProcessor::method, Function.identity()));
    }

    public void pay(String orderId, String method, BigDecimal amount) {
        PaymentProcessor processor = processors.get(method);
        if (processor == null) {
            throw new IllegalArgumentException(
                    "不支援的付款方式：" + method + "，可用：" + processors.keySet());
        }
        processor.charge(orderId, amount);
    }
}
```

**這個設計的價值**：新增「街口支付」時，只要新增一個類別，**`PaymentService` 一個字都不用改**。

```java
package com.example.shop.payment;

import org.springframework.stereotype.Component;

import java.math.BigDecimal;

@Component                                       // 加上這個就自動被納入
public class JkoPayProcessor implements PaymentProcessor {
    @Override public String method() { return "JKO_PAY"; }
    @Override public void charge(String orderId, BigDecimal amount) { /* ... */ }
}
```

> **這是開放封閉原則（OCP）的教科書級實例**：對擴充開放（加新類別），對修改封閉（舊程式不動）。
> 而且它不是靠什麼奇技淫巧，就是「注入 `List<介面>`」而已。

#### 直接注入 `Map<String, T>` 也可以，但要小心 key

```java
@Service
public class PaymentService {
    private final Map<String, PaymentProcessor> processors;

    // Spring 直接給你 Map，key = Bean 名稱
    public PaymentService(Map<String, PaymentProcessor> processors) {
        this.processors = processors;
    }
    // 此時 key 是 "creditCardProcessor"、"linePayProcessor"、"bankTransferProcessor"
    // ⚠️ 不是 "CREDIT_CARD" / "LINE_PAY"！
}
```

**key 是 Bean 名稱，不是你的業務代碼。** 改個類別名就壞了。
所以我建議用上面「注入 `List` 再自己建 Map」的寫法——**key 由介面方法決定，跟類別名無關**。

#### 控制順序：`@Order`

```java
@Component
@Order(1)         // 數字越小越前面
public class ValidationInterceptor implements OrderInterceptor { }

@Component
@Order(2)
public class AuditInterceptor implements OrderInterceptor { }
```

注入 `List<OrderInterceptor>` 時會**依 `@Order` 排序**。這對「責任鏈」型的設計很重要。
不加 `@Order` 的順序**不保證**（實務上大致是掃描順序，但別依賴）。

### 四種解法的選擇表

| 情境 | 用什麼 |
|---|---|
| 有一個明確的預設實作 | `@Primary` |
| 少數幾個地方要指定特定實作 | 自訂 `@Qualifier` 註解 |
| **要依執行期資料動態選擇** | **注入 `List` 建 Map（策略模式）** |
| 要全部依序執行（責任鏈、驗證器） | 注入 `List` + `@Order` |
| 依環境決定用哪一個 | `@Profile` / `@ConditionalOnProperty`（見 1.9） |

---

## 1.9 條件式 Bean：依環境決定要不要建立

### `@Profile`

```java
package com.example.shop.payment;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

@Configuration
public class PaymentConfig {

    @Bean
    @Profile("prod")                    // 只有 prod 環境建立
    public PaymentGateway realGateway() {
        return new StripeGateway(System.getenv("STRIPE_API_KEY"));
    }

    @Bean
    @Profile("!prod")                   // prod 以外都建立（dev、test、local...）
    public PaymentGateway fakeGateway() {
        return new FakePaymentGateway();   // 一律成功，不會真的扣款
    }
}
```

> **真實案例**：某團隊沒有做這個切分，開發環境直接用測試用的金流 sandbox。
> 有一次 sandbox 掛掉三天，整個開發團隊無法測試下單流程。
> 加上 `FakePaymentGateway` 之後，開發環境完全不依賴外部服務。
>
> 更重要的是它擋掉一個風險：**新人在本機測試時，不可能誤打到正式金流**——
> 因為本機根本沒有 `prod` profile。

### `@ConditionalOnProperty`

```java
@Configuration
public class NotificationConfig {

    @Bean
    @ConditionalOnProperty(name = "shop.notification.sms.enabled", havingValue = "true")
    public Notifier smsNotifier(SmsClient client) {
        return new SmsNotifier(client);
    }

    @Bean
    @ConditionalOnProperty(
        name = "shop.notification.email.enabled",
        havingValue = "true",
        matchIfMissing = true)          // 沒設定時視為 true（預設開啟）
    public Notifier emailNotifier() {
        return new EmailNotifier();
    }
}
```

這比 `@Profile` 更細緻：**同一個環境內也可以用開關控制功能**（feature toggle）。

`@Conditional` 的完整家族是第 02 章的主題，這裡先知道有這個能力。

---

## 1.10 Bean 的作用域

| 作用域 | 說明 | 何時用 |
|---|---|---|
| `singleton` | **預設**。整個容器只有一個實例 | 99% 的情況（Service、Repository、Controller） |
| `prototype` | 每次取得都建立新的 | 有可變狀態、每次要獨立的物件 |
| `request` | 每個 HTTP 請求一個 | Web 專用，存請求範圍的資料 |
| `session` | 每個 HTTP Session 一個 | Web 專用，存使用者狀態 |
| `application` | 每個 ServletContext 一個 | 極少用 |

```java
@Service
@Scope("prototype")
public class ImportTask { }

// 或用常數，避免打錯字
@Service
@Scope(ConfigurableBeanFactory.SCOPE_PROTOTYPE)
public class ImportTask { }
```

### 最重要的一件事：單例 Bean 必須是無狀態的

```java
// ❌ 災難：單例 Bean 帶了可變狀態
@Service
public class BadOrderService {
    private Order currentOrder;     // 💥 所有請求共用這一個欄位

    public void process(Order order) {
        this.currentOrder = order;
        validate();                 // 執行緒 A 存進去
        save();                     // 執行緒 B 覆蓋掉，A 存到 B 的訂單
    }
}
```

> **真實案例**：這個 bug 我看過至少三次。症狀是「壓測時偶爾出現張三的訂單金額變成李四的」，
> 而且**在開發環境永遠測不出來**——因為開發時只有一個人在用，沒有併發。
> 上線後流量一起來就出事，而且很難重現。
>
> **規則：單例 Bean 的欄位只能放「依賴」（其他 Bean、設定值），不能放「請求資料」。**
> 請求資料一律用方法參數或區域變數傳遞。

### 陷阱：單例注入原型

```java
@Service                                    // singleton
public class ImportService {
    private final ImportTask task;          // prototype

    public ImportService(ImportTask task) {
        this.task = task;                   // ⚠️ 只在啟動時注入一次！
    }

    public void run() {
        task.execute();      // 永遠是同一個 ImportTask 實例，prototype 完全失效
    }
}
```

**原因**：注入只在「建立 `ImportService` 時」發生一次。之後 `task` 就是那個實例，不會再變。

#### 解法 A：`ObjectProvider`（推薦）

```java
package com.example.shop.service;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

@Service
public class ImportService {

    private final ObjectProvider<ImportTask> taskProvider;

    public ImportService(ObjectProvider<ImportTask> taskProvider) {
        this.taskProvider = taskProvider;
    }

    public void run() {
        ImportTask task = taskProvider.getObject();   // 每次呼叫都拿到新的 prototype 實例
        task.execute();
    }
}
```

`ObjectProvider` 還有幾個很好用的方法：

```java
taskProvider.getObject()                 // 拿一個，沒有就丟例外
taskProvider.getIfAvailable()            // 拿一個，沒有回 null
taskProvider.getIfAvailable(Task::new)   // 沒有就用這個 supplier 建
taskProvider.getIfUnique()               // 只有一個時才拿，多個回 null
taskProvider.stream()                    // 所有符合的 Bean 串流
taskProvider.orderedStream()             // 依 @Order 排序
```

> **`ObjectProvider` 也是「可選依賴」的最佳解**：
> ```java
> private final MetricsCollector metrics;
> public OrderService(ObjectProvider<MetricsCollector> provider) {
>     this.metrics = provider.getIfAvailable(() -> MetricsCollector.NOOP);
> }
> ```

#### 解法 B：`@Lookup`（較少見）

```java
@Service
public abstract class ImportService {

    public void run() {
        ImportTask task = createTask();
        task.execute();
    }

    @Lookup                                  // Spring 會用 CGLIB 產生子類別實作這個方法
    protected abstract ImportTask createTask();
}
```

#### 解法 C：scoped proxy

```java
@Service
@Scope(value = "prototype", proxyMode = ScopedProxyMode.TARGET_CLASS)
public class ImportTask { }
```

注入的其實是一個代理，每次呼叫方法時才去容器取真正的實例。
**這對 `request` / `session` 作用域特別重要**（不然單例 Bean 根本沒辦法注入請求範圍的物件）。

```java
package com.example.shop.web;

import org.springframework.context.annotation.Scope;
import org.springframework.context.annotation.ScopedProxyMode;
import org.springframework.stereotype.Component;
import org.springframework.web.context.WebApplicationContext;

@Component
@Scope(value = WebApplicationContext.SCOPE_REQUEST, proxyMode = ScopedProxyMode.TARGET_CLASS)
public class RequestContext {
    private String traceId;
    private String userId;

    public String getTraceId() { return traceId; }
    public void setTraceId(String traceId) { this.traceId = traceId; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
}
```

```java
@Service
public class OrderService {
    private final RequestContext requestContext;   // 注入的是代理

    public OrderService(RequestContext requestContext) {
        this.requestContext = requestContext;
    }

    public void placeOrder() {
        // 呼叫時，代理去 ThreadLocal 找「當前請求」的實例
        String traceId = requestContext.getTraceId();
    }
}
```

> ⚠️ **request 作用域的 Bean 不能在非請求執行緒使用**（`@Async`、`@Scheduled`、批次任務）。
> 呼叫時會丟 `No thread-bound request found`。
> 需要跨執行緒傳遞請求資訊時，要自己複製到新執行緒（第 05 章的 MDC 會處理這個問題）。

---

## 1.11 Bean 的生命週期

這張圖建議記起來——AOP、`@Transactional`、`@ConfigurationProperties` 的驗證，全部發生在其中某一步。

```
容器啟動
   │
   ├─ ① 讀取 BeanDefinition（掃描 @Component / 解析 @Bean / 自動組態）
   │
   ├─ ② BeanFactoryPostProcessor 執行
   │      可以「修改 Bean 定義」，Bean 還沒被實例化
   │      例：PropertySourcesPlaceholderConfigurer 解析 ${...}
   │
   └─ ③ 開始建立每一個單例 Bean：
         │
         ├─ 3.1 實例化（呼叫建構子）★ 建構子注入在這一步發生 ★
         │
         ├─ 3.2 屬性填充（欄位注入 / setter 注入在這一步）
         │
         ├─ 3.3 Aware 介面回呼
         │        BeanNameAware.setBeanName()
         │        BeanFactoryAware.setBeanFactory()
         │        ApplicationContextAware.setApplicationContext()
         │
         ├─ 3.4 BeanPostProcessor.postProcessBeforeInitialization()
         │        ★ @PostConstruct 就是由 CommonAnnotationBeanPostProcessor 在這裡呼叫 ★
         │
         ├─ 3.5 初始化方法
         │        ├─ @PostConstruct 標註的方法
         │        ├─ InitializingBean.afterPropertiesSet()
         │        └─ @Bean(initMethod = "...")
         │
         ├─ 3.6 BeanPostProcessor.postProcessAfterInitialization()
         │        ★★ AOP 代理在這裡產生！你的 Bean 被換成代理物件 ★★
         │
         └─ 3.7 Bean 就緒，放進單例池
   │
   ├─ ④ 所有 Bean 建好 → 發出 ContextRefreshedEvent
   ├─ ⑤ 執行 ApplicationRunner / CommandLineRunner
   ├─ ⑥ 發出 ApplicationReadyEvent
   │
   ⋮  （應用程式運行中）
   │
   └─ 關閉時：
         ├─ 發出 ContextClosedEvent
         ├─ @PreDestroy 標註的方法
         ├─ DisposableBean.destroy()
         └─ @Bean(destroyMethod = "...")
```

### 用程式印出來驗證

```java
package com.example.shop.lifecycle;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.BeanNameAware;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.stereotype.Component;

@Component
public class LifecycleDemo
        implements BeanNameAware, InitializingBean, DisposableBean {

    public LifecycleDemo() {
        System.out.println("① 建構子");
    }

    @Override
    public void setBeanName(String name) {
        System.out.println("② BeanNameAware.setBeanName: " + name);
    }

    @PostConstruct
    public void init() {
        System.out.println("③ @PostConstruct");
    }

    @Override
    public void afterPropertiesSet() {
        System.out.println("④ InitializingBean.afterPropertiesSet");
    }

    @PreDestroy
    public void cleanup() {
        System.out.println("⑤ @PreDestroy");
    }

    @Override
    public void destroy() {
        System.out.println("⑥ DisposableBean.destroy");
    }
}
```

輸出：

```
① 建構子
② BeanNameAware.setBeanName: lifecycleDemo
③ @PostConstruct
④ InitializingBean.afterPropertiesSet
（服務運行中，按 Ctrl+C 或呼叫 context.close()）
⑤ @PreDestroy
⑥ DisposableBean.destroy
```

> ⚠️ **注意**：`@PreDestroy` 只在**優雅關閉**時才會執行。
> `kill -9` 直接殺掉、容器被 OOM Killer 幹掉，都不會跑。所以**不要把重要的清理工作只放在這裡**。
> Docker 的 `docker stop` 送的是 `SIGTERM`，會觸發優雅關閉；超過 grace period 才會 `SIGKILL`。第 08 章詳談。

### 三種初始化方式該選哪個

| 方式 | 評價 |
|---|---|
| `@PostConstruct` | ✅ **推薦**。標準（JSR-250），與 Spring 解耦 |
| `InitializingBean` | ❌ 要 implement Spring 的介面，把業務類別綁死在框架上 |
| `@Bean(initMethod)` | ✅ 用於**第三方類別**（你無法在它們身上加註解） |

> Spring Boot 3（Jakarta EE 9+）的 `@PostConstruct` 在 `jakarta.annotation` 套件下：
> ```java
> import jakarta.annotation.PostConstruct;   // ✅ Boot 3
> import javax.annotation.PostConstruct;     // ❌ Boot 2 的寫法，Boot 3 會找不到
> ```
> 這是 Boot 2 → 3 遷移最常見的編譯錯誤之一（第 09 章）。

### `@PostConstruct` 常見誤用

```java
@Service
public class BadWarmupService {
    private final ExternalApiClient client;

    public BadWarmupService(ExternalApiClient client) {
        this.client = client;
    }

    @PostConstruct
    public void warmup() {
        // ❌ 在 @PostConstruct 裡呼叫外部 API
        // 對方掛掉 / 網路慢 → 你的服務啟動失敗或卡住
        cache.putAll(client.fetchAllProducts());
    }
}
```

**問題**：`@PostConstruct` 失敗會導致**整個應用程式啟動失敗**。
外部服務的可用性不該決定你能不能啟動。

**改用 `ApplicationReadyEvent` + 容錯**：

```java
package com.example.shop.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class WarmupService {
    private static final Logger log = LoggerFactory.getLogger(WarmupService.class);

    private final ExternalApiClient client;

    public WarmupService(ExternalApiClient client) {
        this.client = client;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void warmup() {
        try {
            log.info("開始預熱商品快取");
            // cache.putAll(client.fetchAllProducts());
            log.info("預熱完成");
        } catch (Exception e) {
            log.warn("預熱失敗，將以冷快取啟動，第一次查詢會較慢", e);
            // 不重新拋出 → 服務照樣啟動
        }
    }
}
```

---

## 1.12 擴充點：`BeanPostProcessor` 與 `BeanFactoryPostProcessor`

這兩個是 Spring 最重要的擴充機制。**你可能不會自己寫，但你必須知道它們存在**——
因為 AOP、`@Autowired`、`@Value`、`@ConfigurationProperties` 全部是靠它們實作的。

### `BeanFactoryPostProcessor`：修改 Bean 的「定義」

在 Bean **還沒被實例化**時執行，可以改 BeanDefinition。

```java
package com.example.shop.config;

import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.stereotype.Component;

@Component
public class ScopeAuditPostProcessor implements BeanFactoryPostProcessor {

    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory) {
        for (String name : beanFactory.getBeanDefinitionNames()) {
            var definition = beanFactory.getBeanDefinition(name);
            if ("prototype".equals(definition.getScope())) {
                System.out.println("⚠️ 發現 prototype Bean：" + name);
            }
        }
    }
}
```

**框架內建的重要實作**：

- `ConfigurationClassPostProcessor` — 解析 `@Configuration`、`@ComponentScan`、`@Import`。**自動組態就是它觸發的。**
- `PropertySourcesPlaceholderConfigurer` — 把 `${server.port}` 換成實際值。

### `BeanPostProcessor`：加工 Bean 的「實例」

在每個 Bean 初始化前後執行，**可以回傳「不同的物件」把原本的換掉**——這就是 AOP 的原理。

```java
package com.example.shop.config;

import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.stereotype.Component;

@Component
public class TimingBeanPostProcessor implements BeanPostProcessor {

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        if (beanName.endsWith("Service")) {
            System.out.println("即將初始化：" + beanName);
        }
        return bean;    // 回傳什麼，就是什麼
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        // ★ Spring AOP 就是在這一步把 bean 換成代理物件 ★
        // return Proxy.newProxyInstance(...);
        return bean;
    }
}
```

**框架內建的重要實作**：

| BeanPostProcessor | 做什麼 |
|---|---|
| `AutowiredAnnotationBeanPostProcessor` | 處理 `@Autowired` / `@Value` 的注入 |
| `CommonAnnotationBeanPostProcessor` | 處理 `@PostConstruct` / `@PreDestroy` / `@Resource` |
| `AnnotationAwareAspectJAutoProxyCreator` | **產生 AOP 代理**（`@Transactional`、`@Async`、`@Cacheable` 都靠它） |
| `ConfigurationPropertiesBindingPostProcessor` | 綁定 `@ConfigurationProperties` |

> **這一格就是整個 Spring 的「魔法來源」**：
> 你以為注入的是 `OrderService`，其實可能是 `OrderService$$SpringCGLIB$$0`。
> 第 04 章會把這件事講到底。
>
> 現在先驗證一次：
> ```java
> @Component
> public class ProxyChecker implements CommandLineRunner {
>     private final OrderService orderService;
>     public ProxyChecker(OrderService orderService) { this.orderService = orderService; }
>     @Override public void run(String... args) {
>         System.out.println("實際型別：" + orderService.getClass().getName());
>         // 沒有 AOP：com.example.shop.service.OrderService
>         // 有 @Transactional：com.example.shop.service.OrderService$$SpringCGLIB$$0
>     }
> }
> ```

### ⚠️ `BeanPostProcessor` 的陷阱

`BeanPostProcessor` 本身**必須比它要處理的 Bean 更早建立**。所以：

```java
@Component
public class BadPostProcessor implements BeanPostProcessor {
    // ❌ 在 BeanPostProcessor 裡注入其他 Bean，會強迫那個 Bean 提早建立
    //    → 那個 Bean 就「錯過」了所有 BeanPostProcessor 的加工（包含 AOP！）
    @Autowired private SomeService someService;
}
```

啟動時你會看到警告：

```
Bean 'someService' of type [...] is not eligible for getting processed by all
BeanPostProcessors (for example: not eligible for auto-proxying)
```

**這個警告的意思是：`someService` 上的 `@Transactional` / `@Async` 不會生效。**
很多人看到這行警告直接忽略，然後花三天查「為什麼交易沒生效」。

解法：用 `ObjectProvider` 延遲取得。

```java
@Component
public class GoodPostProcessor implements BeanPostProcessor {
    private final ObjectProvider<SomeService> provider;

    public GoodPostProcessor(ObjectProvider<SomeService> provider) {
        this.provider = provider;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        // 真的要用的時候才取
        SomeService service = provider.getObject();
        return bean;
    }
}
```

---

## 1.13 循環依賴

### 什麼是循環依賴

```java
@Service
public class OrderService {
    private final PaymentService paymentService;
    public OrderService(PaymentService paymentService) {
        this.paymentService = paymentService;
    }
}

@Service
public class PaymentService {
    private final OrderService orderService;     // 💥 互相依賴
    public PaymentService(OrderService orderService) {
        this.orderService = orderService;
    }
}
```

啟動時 Spring Boot 給的錯誤訊息其實很好：

```
***************************
APPLICATION FAILED TO START
***************************

Description:

The dependencies of some of the beans in the application context form a cycle:

┌─────┐
|  orderService defined in file [.../OrderService.class]
↑     ↓
|  paymentService defined in file [.../PaymentService.class]
└─────┘

Action:

Relying upon circular references is discouraged and they are prohibited by default.
Update your application to remove the dependency cycle between beans.
As a last resort, it may be possible to break the cycle automatically by setting
spring.main.allow-circular-references to true.
```

### 為什麼建構子注入一定失敗

```
要建 OrderService → 需要 PaymentService
要建 PaymentService → 需要 OrderService
→ 死鎖。誰都建不出來。
```

這是**邏輯上的不可能**，不是 Spring 的限制。

### 為什麼欄位/setter 注入「可以」

因為 Spring 有三級快取機制：

```
建立 OrderService：
  ① 呼叫建構子 → 得到「半成品」實例（依賴還沒填）
  ② 把半成品的 ObjectFactory 放進「三級快取」
  ③ 開始填充屬性 → 需要 PaymentService
       │
       └─ 建立 PaymentService：
            ① 呼叫建構子 → 半成品
            ② 放進三級快取
            ③ 填充屬性 → 需要 OrderService
                 └─ 從三級快取拿到 OrderService 的半成品 ✅
            ④ 初始化完成 → 放進一級快取（單例池）
  ④ 拿到完整的 PaymentService，填進 OrderService
  ⑤ 初始化完成
```

**關鍵在於「先有實例，再填屬性」這兩步是分開的**，中間有空隙可以塞半成品。
建構子注入沒有這個空隙。

### Spring Boot 2.6 之後預設禁止

```properties
# 預設值就是 false，要開才會通
spring.main.allow-circular-references=true
```

**為什麼要禁止？** 因為循環依賴會造成真實的問題：

1. **與 AOP 衝突時會出現詭異行為**。當半成品被提前曝光，AOP 代理可能還沒產生，
   結果 A 拿到的是 B 的**原始物件**而不是代理——`@Transactional` 靜靜地失效。
   （Spring 的三級快取有處理這個，但在複雜情況下仍可能出問題。）
2. **啟動順序變得不確定**：把兩個類別的宣告順序對調，行為可能就不同。
3. **它幾乎總是設計問題的症狀**。

> **實務建議：不要打開這個開關。** 打開它等於把「架構警告」關掉。

### 正確解法（由好到將就）

#### 解法 1：抽出第三個類別（最好）

循環依賴通常代表**有一塊職責被切錯了**。

```
問題：OrderService ⇄ PaymentService

分析：
  OrderService 需要 PaymentService 的什麼？→ 計算應付金額
  PaymentService 需要 OrderService 的什麼？→ 查詢訂單明細

真正的結構：兩者都需要「訂單金額計算」這件事
```

```java
package com.example.shop.service;

import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.List;

/** 純計算，沒有任何依賴 */
@Component
public class OrderAmountCalculator {

    public BigDecimal total(List<OrderLine> lines, BigDecimal discountRate) {
        BigDecimal sum = lines.stream()
                .map(l -> l.unitPrice().multiply(BigDecimal.valueOf(l.quantity())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        return sum.multiply(BigDecimal.ONE.subtract(discountRate));
    }

    public record OrderLine(String sku, BigDecimal unitPrice, int quantity) { }
}
```

```java
@Service
public class OrderService {
    private final OrderAmountCalculator calculator;      // 單向
    public OrderService(OrderAmountCalculator calculator) {
        this.calculator = calculator;
    }
}

@Service
public class PaymentService {
    private final OrderAmountCalculator calculator;      // 單向
    public PaymentService(OrderAmountCalculator calculator) {
        this.calculator = calculator;
    }
}
```

**循環消失了，而且 `OrderAmountCalculator` 沒有任何依賴，超好測試。**

#### 解法 2：用事件解耦（第 06 章詳談）

```java
@Service
public class OrderService {
    private final ApplicationEventPublisher publisher;

    public OrderService(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    public void placeOrder(Order order) {
        // ... 存訂單 ...
        publisher.publishEvent(new OrderPlacedEvent(order.id()));   // 不直接呼叫 PaymentService
    }
}

@Service
public class PaymentService {
    @EventListener
    public void onOrderPlaced(OrderPlacedEvent event) {
        // 處理付款
    }
}
```

**依賴方向從「OrderService → PaymentService」變成「兩者都依賴事件」。**

#### 解法 3：`@Lazy`（將就，能不用就不用）

```java
@Service
public class OrderService {
    private final PaymentService paymentService;

    public OrderService(@Lazy PaymentService paymentService) {
        this.paymentService = paymentService;   // 注入的是代理，第一次呼叫方法時才真的取得
    }
}
```

**能動，但它只是把問題藏起來。** 而且注入的是代理，除錯時看到 `PaymentService$$SpringCGLIB$$0` 會困惑。

#### 解法 4：改用 setter 注入（最不推薦）

只是回到 Boot 2.6 之前的行為，問題全部還在。

---

## 1.14 `@Configuration` 的 `proxyBeanMethods`

這是一個很少人講、但會咬人的細節。

```java
@Configuration
public class AppConfig {

    @Bean
    public DataSource dataSource() {
        return new HikariDataSource();
    }

    @Bean
    public OrderRepository orderRepository() {
        return new JdbcOrderRepository(dataSource());   // ← 直接呼叫另一個 @Bean 方法
    }

    @Bean
    public UserRepository userRepository() {
        return new JdbcUserRepository(dataSource());    // ← 又呼叫一次
    }
}
```

**問題：`dataSource()` 被呼叫兩次，會建立兩個連線池嗎？**

答案是 **不會**——只要類別上有 `@Configuration`。

### 原理：CGLIB 代理

`@Configuration` 類別會被 CGLIB 產生一個子類別，覆寫所有 `@Bean` 方法：

```java
// Spring 產生的（概念示意）
public class AppConfig$$SpringCGLIB$$0 extends AppConfig {

    @Override
    public DataSource dataSource() {
        // 先查容器裡有沒有這個 Bean
        if (容器裡已有 "dataSource") {
            return 容器.getBean("dataSource");    // 直接回傳既有的單例
        }
        return super.dataSource();                // 第一次才真的執行
    }
}
```

這叫 **full 模式**（`proxyBeanMethods = true`，預設值）。

### `proxyBeanMethods = false`（lite 模式）

```java
@Configuration(proxyBeanMethods = false)
public class AppConfig {

    @Bean
    public DataSource dataSource() {
        return new HikariDataSource();
    }

    @Bean
    public OrderRepository orderRepository() {
        return new JdbcOrderRepository(dataSource());   // 💥 真的又 new 了一個 HikariDataSource！
    }
}
```

**lite 模式沒有代理，`dataSource()` 就是普通的方法呼叫。**

正確的 lite 模式寫法是**用方法參數注入**：

```java
@Configuration(proxyBeanMethods = false)
public class AppConfig {

    @Bean
    public DataSource dataSource() {
        return new HikariDataSource();
    }

    @Bean
    public OrderRepository orderRepository(DataSource dataSource) {   // ✅ 參數注入
        return new JdbcOrderRepository(dataSource);
    }

    @Bean
    public UserRepository userRepository(DataSource dataSource) {     // ✅ 同一個實例
        return new JdbcUserRepository(dataSource);
    }
}
```

### 該用哪一個

| | full（預設） | lite |
|---|---|---|
| 啟動速度 | 慢一點（要產生 CGLIB 代理） | 快 |
| `@Bean` 方法互相呼叫 | ✅ 安全 | ❌ 會建立多個實例 |
| 類別限制 | 不能 `final`，方法不能 `private`/`final` | 無 |
| GraalVM native image | 需要額外處理 | 較友善 |

> **實務建議**：
> - **你自己專案的 `@Configuration`**：用預設的 full 模式，安全，那點啟動時間不重要。
> - **寫 starter / 函式庫時**：用 `proxyBeanMethods = false` 並改用參數注入。
>   Spring Boot 自己的自動組態類別**全部都是 lite 模式**——你去翻 `DataSourceAutoConfiguration`
>   就會看到 `@AutoConfiguration` 底下標的是 `@Configuration(proxyBeanMethods = false)`。
>   因為自動組態類別有一百多個，每個都產代理，啟動時間會很難看。

---

## 1.15 延遲初始化與啟動效能

```properties
# 全域延遲初始化：所有 Bean 都等到第一次用才建立
spring.main.lazy-initialization=true
```

```java
// 單一 Bean 延遲
@Service
@Lazy
public class HeavyReportService { }

// 全域延遲時，強制某個 Bean 立即建立
@Service
@Lazy(false)
public class CriticalService { }
```

**效果**：某些大型專案啟動時間可以從 20 秒降到 3 秒。

**代價**（回頭看 1.4 講的 fail fast）：

| 風險 | 說明 |
|---|---|
| 設定錯誤延後爆炸 | 資料庫密碼打錯，要等到第一次查詢才發現 |
| 第一次請求變慢 | 使用者觸發了初始化 |
| 排程任務可能不會註冊 | `@Scheduled` 的 Bean 沒被建立就不會排程 |
| 健康檢查可能誤報 UP | 相依元件根本還沒初始化 |

> **實務建議**：
> - **開發環境**：可以開，改一行程式重啟快很多。
> - **正式環境**：**不要開**。寧可啟動慢 15 秒，也不要半夜出事。
>
> 更好的做法是用 `application-dev.yml` 只在開發環境開啟（第 03 章）：
> ```yaml
> # application-dev.yml
> spring:
>   main:
>     lazy-initialization: true
> ```

### 更好的啟動加速方式

| 方法 | 效果 | 代價 |
|---|---|---|
| 縮小 `scanBasePackages` | 中 | 無，本來就該做 |
| 移除沒用到的 starter | 中 | 無 |
| `spring.data.jpa.repositories.bootstrap-mode=deferred` | 中 | Repository 在背景初始化 |
| CDS（Class Data Sharing） | 中～大 | 需要額外的建置步驟 |
| GraalVM native image | 極大（毫秒級啟動） | 建置慢、反射要設定、不是所有函式庫都支援 |

---

## 1.16 實戰：把訂單服務容器化改造

把前面的觀念全部串起來。目標結構：

```
com.example.shop
├── ShopServiceApplication.java
├── order
│   ├── Order.java                    record
│   ├── OrderRepository.java          介面
│   ├── InMemoryOrderRepository.java  @Repository
│   ├── OrderService.java             @Service
│   └── OrderController.java          @RestController
├── payment
│   ├── PaymentProcessor.java         介面
│   ├── CreditCardProcessor.java      @Component
│   ├── LinePayProcessor.java         @Component
│   └── PaymentService.java           @Service（注入 List，策略模式）
└── notification
    ├── Notifier.java                 介面
    ├── EmailNotifier.java            @Component @Primary
    └── LogNotifier.java              @Component @Profile("dev")
```

```java
package com.example.shop.order;

import java.math.BigDecimal;
import java.time.Instant;

public record Order(Long id,
                    String customerName,
                    BigDecimal amount,
                    String paymentMethod,
                    String status,
                    Instant createdAt) {

    public Order withId(Long newId) {
        return new Order(newId, customerName, amount, paymentMethod, status, createdAt);
    }

    /** 狀態轉換也用「回傳新物件」的寫法（第 05、06 章會用到） */
    public Order withStatus(String newStatus) {
        return new Order(id, customerName, amount, paymentMethod, newStatus, createdAt);
    }
}
```

> 📌 **這個 record 在後面章節會演進 —— 課程刻意標出來，不回頭改寫這一章**：
>
> | 章節 | 改了什麼 | 為什麼 |
> |---|---|---|
> | 06 章 6.8 | `customerName` → **`customerId`** | 事件要被別的模組消費，**識別碼才穩定**，顯示名稱會變 |
> | 07 章 7.12 | `String status` → **`OrderStatus` enum** + `transitionTo()` | 讓「已出貨不能取消」這種規則變成**可以用參數化測試窮舉**的東西 |
>
> 每一次演進都是「下游的需求推翻了上游的決定」，
> 而**先看見痛、再給解法**需要痛留在原處 —— 這也是 04-controller 與 05-service 兩站的做法。

```java
package com.example.shop.order;

import java.util.List;
import java.util.Optional;

public interface OrderRepository {
    Order save(Order order);
    Optional<Order> findById(long id);
    List<Order> findAll();
}
```

```java
package com.example.shop.order;

import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 記憶體版實作。第 06 站會換成真的 JDBC / JPA 實作，
 * 但 OrderService 一個字都不用改 —— 這就是介面的價值。
 */
@Repository
public class InMemoryOrderRepository implements OrderRepository {

    // 單例 Bean 的可變狀態必須是執行緒安全的
    private final Map<Long, Order> store = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong(1000);

    @Override
    public Order save(Order order) {
        Order toSave = order.id() == null
                ? order.withId(sequence.incrementAndGet())
                : order;
        store.put(toSave.id(), toSave);
        return toSave;
    }

    @Override
    public Optional<Order> findById(long id) {
        return Optional.ofNullable(store.get(id));
    }

    @Override
    public List<Order> findAll() {
        return List.copyOf(store.values());
    }
}
```

```java
package com.example.shop.payment;

import java.math.BigDecimal;

public interface PaymentProcessor {
    String method();
    void charge(String orderId, BigDecimal amount);
}
```

```java
package com.example.shop.payment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;

@Component
public class CreditCardProcessor implements PaymentProcessor {
    private static final Logger log = LoggerFactory.getLogger(CreditCardProcessor.class);

    @Override public String method() { return "CREDIT_CARD"; }

    @Override public void charge(String orderId, BigDecimal amount) {
        log.info("[信用卡] 訂單 {} 扣款 {} 元", orderId, amount);
    }
}
```

```java
package com.example.shop.payment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;

@Component
public class LinePayProcessor implements PaymentProcessor {
    private static final Logger log = LoggerFactory.getLogger(LinePayProcessor.class);

    @Override public String method() { return "LINE_PAY"; }

    @Override public void charge(String orderId, BigDecimal amount) {
        log.info("[LINE Pay] 訂單 {} 扣款 {} 元", orderId, amount);
    }
}
```

```java
package com.example.shop.payment;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
public class PaymentService {

    private final Map<String, PaymentProcessor> processors;

    public PaymentService(List<PaymentProcessor> processorList) {
        this.processors = processorList.stream()
                .collect(Collectors.toMap(PaymentProcessor::method, Function.identity()));
    }

    public void charge(String orderId, String method, BigDecimal amount) {
        PaymentProcessor processor = processors.get(method);
        if (processor == null) {
            throw new IllegalArgumentException(
                    "不支援的付款方式：" + method + "，目前支援：" + processors.keySet());
        }
        processor.charge(orderId, amount);
    }

    public java.util.Set<String> supportedMethods() {
        return processors.keySet();
    }
}
```

```java
package com.example.shop.notification;

public interface Notifier {
    void send(String to, String message);
}
```

```java
package com.example.shop.notification;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

@Component
@Primary
public class EmailNotifier implements Notifier {
    private static final Logger log = LoggerFactory.getLogger(EmailNotifier.class);

    @Override
    public void send(String to, String message) {
        log.info("[EMAIL] to={} | {}", to, message);
    }
}
```

```java
package com.example.shop.notification;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * 開發用的通知實作：只寫 log，不寄真的信。
 *
 * <p>因為有兩個 `Notifier` 實作，`EmailNotifier` 上的 `@Primary` 才有意義 ——
 * 在 dev profile 下容器裡有兩個候選，注入時會拿到 `@Primary` 的那個；
 * 想改用這一個就在注入點加 `@Qualifier("logNotifier")`。
 */
@Component
@Profile("dev")
public class LogNotifier implements Notifier {
    private static final Logger log = LoggerFactory.getLogger(LogNotifier.class);

    @Override
    public void send(String to, String message) {
        log.info("[LOG-ONLY] 假裝通知 {}：{}", to, message);
    }
}
```

```java
package com.example.shop.order;

import com.example.shop.notification.Notifier;
import com.example.shop.payment.PaymentService;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.Clock;
import java.util.List;

@Service
public class OrderService {

    private final OrderRepository repository;
    private final PaymentService paymentService;
    private final Notifier notifier;
    private final Clock clock;                  // 注入 Clock，測試才能控制時間

    public OrderService(OrderRepository repository,
                        PaymentService paymentService,
                        Notifier notifier,
                        Clock clock) {
        this.repository = repository;
        this.paymentService = paymentService;
        this.notifier = notifier;
        this.clock = clock;
    }

    public Order placeOrder(String customerName, BigDecimal amount, String paymentMethod) {
        if (customerName == null || customerName.isBlank()) {
            throw new IllegalArgumentException("客戶名稱不可為空");
        }
        if (amount == null || amount.signum() <= 0) {
            throw new IllegalArgumentException("金額必須大於 0");
        }

        Order saved = repository.save(new Order(
                null, customerName, amount, paymentMethod, "CREATED", clock.instant()));

        paymentService.charge(String.valueOf(saved.id()), paymentMethod, amount);

        Order paid = new Order(saved.id(), saved.customerName(), saved.amount(),
                saved.paymentMethod(), "PAID", saved.createdAt());
        repository.save(paid);

        notifier.send(customerName, "您的訂單 " + paid.id() + " 已成立，金額 " + amount + " 元");
        return paid;
    }

    public List<Order> listAll() {
        return repository.findAll();
    }
}
```

`Clock` 是 JDK 的類別，沒辦法加 `@Component`，所以用 `@Bean`：

```java
package com.example.shop.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Clock;

@Configuration
public class TimeConfig {

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }
}
```

```java
package com.example.shop.order;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.util.List;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    public Order create(@RequestBody CreateOrderRequest request) {
        return orderService.placeOrder(
                request.customerName(), request.amount(), request.paymentMethod());
    }

    @GetMapping
    public List<Order> list() {
        return orderService.listAll();
    }

    public record CreateOrderRequest(String customerName, BigDecimal amount, String paymentMethod) { }
}
```

驗證：

```bash
$ curl -s -X POST localhost:8080/orders \
    -H 'Content-Type: application/json' \
    -d '{"customerName":"王小明","amount":1280,"paymentMethod":"LINE_PAY"}' | jq
{
  "id": 1001,
  "customerName": "王小明",
  "amount": 1280,
  "paymentMethod": "LINE_PAY",
  "status": "PAID",
  "createdAt": "2026-08-18T02:31:07.418Z"
}

$ curl -s -X POST localhost:8080/orders \
    -H 'Content-Type: application/json' \
    -d '{"customerName":"李小華","amount":500,"paymentMethod":"BITCOIN"}'
# 500，log 顯示：不支援的付款方式：BITCOIN，目前支援：[CREDIT_CARD, LINE_PAY]
```

### 對應的單元測試（完全不啟動 Spring）

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

class OrderServiceTest {

    // ── 測試替身 ──
    static class RecordingNotifier implements Notifier {
        final List<String> messages = new ArrayList<>();
        @Override public void send(String to, String message) { messages.add(to + "|" + message); }
    }

    static class RecordingProcessor implements PaymentProcessor {
        final List<String> charges = new ArrayList<>();
        private final String method;
        RecordingProcessor(String method) { this.method = method; }
        @Override public String method() { return method; }
        @Override public void charge(String orderId, BigDecimal amount) {
            charges.add(orderId + "|" + amount);
        }
    }

    private final Clock fixedClock = Clock.fixed(Instant.parse("2026-08-18T00:00:00Z"), ZoneOffset.UTC);

    @Test
    void 下單成功時應扣款並通知() {
        InMemoryOrderRepository repository = new InMemoryOrderRepository();
        RecordingProcessor linePay = new RecordingProcessor("LINE_PAY");
        PaymentService paymentService = new PaymentService(List.of(linePay));
        RecordingNotifier notifier = new RecordingNotifier();

        OrderService service = new OrderService(repository, paymentService, notifier, fixedClock);

        Order order = service.placeOrder("王小明", new BigDecimal("1280"), "LINE_PAY");

        assertThat(order.status()).isEqualTo("PAID");
        assertThat(order.createdAt()).isEqualTo(Instant.parse("2026-08-18T00:00:00Z"));
        assertThat(linePay.charges).containsExactly(order.id() + "|1280");
        assertThat(notifier.messages).hasSize(1);
        assertThat(notifier.messages.get(0)).contains("已成立");
    }

    @Test
    void 不支援的付款方式應拒絕() {
        OrderService service = new OrderService(
                new InMemoryOrderRepository(),
                new PaymentService(List.of(new RecordingProcessor("LINE_PAY"))),
                new RecordingNotifier(),
                fixedClock);

        assertThatThrownBy(() ->
                service.placeOrder("王小明", new BigDecimal("100"), "BITCOIN"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("不支援的付款方式");
    }

    @Test
    void 金額為零時應拒絕且不扣款() {
        RecordingProcessor linePay = new RecordingProcessor("LINE_PAY");
        OrderService service = new OrderService(
                new InMemoryOrderRepository(),
                new PaymentService(List.of(linePay)),
                new RecordingNotifier(),
                fixedClock);

        assertThatThrownBy(() ->
                service.placeOrder("王小明", BigDecimal.ZERO, "LINE_PAY"))
                .isInstanceOf(IllegalArgumentException.class);

        assertThat(linePay.charges).isEmpty();     // 驗證「沒有發生」也很重要
    }
}
```

**這三個測試加起來跑不到 100 毫秒**，不啟動 Spring、不連資料庫。
這就是建構子注入 + 介面抽象換來的東西。

---

## 1.17 常見錯誤速查

| 錯誤訊息 | 原因 | 解法 |
|---|---|---|
| `No qualifying bean of type 'X' available` | 沒掃到、沒註冊、條件不成立 | 查套件位置；查 `/actuator/beans`；查 `/actuator/conditions` |
| `required a single bean, but N were found` | 同型別多個實作 | `@Primary` / `@Qualifier` / 注入 `List` |
| `Requested bean is currently in creation` | 循環依賴 | 抽第三個類別 / 用事件 |
| `The dependencies of some of the beans ... form a cycle` | 循環依賴（Boot 2.6+ 的明確訊息） | 同上 |
| `not eligible for getting processed by all BeanPostProcessors` | Bean 被提早建立，錯過 AOP | 檢查 `BeanPostProcessor` / `@Configuration` 有無過早注入 |
| `NullPointerException` 在建構子裡 | 欄位注入的依賴在建構子執行時還沒填 | 改建構子注入 |
| `@Transactional` / `@Async` 沒生效 | 自呼叫，或 Bean 沒被代理 | 第 04 章 |
| 單例 Bean 資料錯亂 | 單例帶了可變狀態 | 狀態改用方法參數 |
| prototype 只建立一次 | 被單例注入 | 用 `ObjectProvider` |
| `No thread-bound request found` | 在非請求執行緒用 request 作用域 Bean | 改傳參數，或在進入非同步前先取值 |

---

## 1.18 本章練習

### 練習 1：判斷注入方式

以下四段程式，各有什麼問題？

```java
// A
@Service
public class AService {
    @Autowired private BRepository repository;
    public AService() { repository.init(); }
}

// B
@Service
public class BService {
    @Autowired private List<Validator> validators;
    public void validate(Object o) { validators.forEach(v -> v.check(o)); }
}

// C
@Service
public class CService {
    private final ApplicationContext context;
    public CService(ApplicationContext context) { this.context = context; }
    public void run() { context.getBean(TaskExecutor.class).execute(this::work); }
    private void work() { }
}

// D
@Service
@Scope("prototype")
public class DService {
    private int counter = 0;
    public int next() { return ++counter; }
}

@Service
public class DUser {
    private final DService d;
    public DUser(DService d) { this.d = d; }
}
```

<details>
<summary>參考解答</summary>

**A：`NullPointerException`。**
欄位注入的順序是「無參數建構子 → 反射填欄位」，所以建構子執行時 `repository` 還是 `null`。

```java
// 修正
@Service
public class AService {
    private final BRepository repository;
    public AService(BRepository repository) {
        this.repository = repository;
        repository.init();      // 現在安全了
    }
}
// 更好：初始化工作放 @PostConstruct，建構子只做賦值
```

**B：能動，但有兩個問題。**
1. 欄位注入 → 測試要用反射。
2. **`validators` 的執行順序不保證**。驗證器通常有順序性（先驗格式再驗業務規則）。

```java
// 修正
@Service
public class BService {
    private final List<Validator> validators;
    public BService(List<Validator> validators) {   // 建構子注入，且會依 @Order 排序
        this.validators = validators;
    }
}
// 各個 Validator 加上 @Order(1)、@Order(2)...
```

**C：Service Locator 反模式。**
`CService` 的真實依賴（`TaskExecutor`）被藏在方法內部，從建構子完全看不出來。
測試時要 mock 整個 `ApplicationContext`。

```java
// 修正
@Service
public class CService {
    private final TaskExecutor executor;
    public CService(TaskExecutor executor) { this.executor = executor; }
    public void run() { executor.execute(this::work); }
    private void work() { }
}
```

**D：prototype 完全失效。**
`DUser` 是單例，`d` 在建立 `DUser` 時注入一次就固定了。
所有呼叫共用同一個 `DService`，`counter` 會一直累加（而且**不是執行緒安全的**）。

```java
// 修正
@Service
public class DUser {
    private final ObjectProvider<DService> provider;
    public DUser(ObjectProvider<DService> provider) { this.provider = provider; }
    public int useOnce() { return provider.getObject().next(); }   // 每次拿新的
}
```

</details>

### 練習 2：設計多實作

需求：訂單成立後要通知客戶，通知管道由**客戶的偏好設定**決定（EMAIL / SMS / LINE / 站內信）。
未來還會新增管道。此外，管理員希望「不論客戶偏好，所有訂單都要寫一筆稽核紀錄」。

設計 Bean 結構。

<details>
<summary>參考解答</summary>

關鍵是分辨兩種需求：

- **通知管道**：多選一，依執行期資料決定 → **策略模式（注入 `List` 建 Map）**
- **稽核紀錄**：一定要執行，跟管道無關 → **不要混進策略裡**，它是不同的關注點

```java
package com.example.shop.notification;

public interface Notifier {
    /** 這個實作對應哪個管道 */
    Channel channel();
    void send(String recipient, String message);

    enum Channel { EMAIL, SMS, LINE, IN_APP }
}
```

```java
package com.example.shop.notification;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class EmailNotifier implements Notifier {
    private static final Logger log = LoggerFactory.getLogger(EmailNotifier.class);
    @Override public Channel channel() { return Channel.EMAIL; }
    @Override public void send(String recipient, String message) {
        log.info("[EMAIL] {} <- {}", recipient, message);
    }
}
```

```java
package com.example.shop.notification;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class SmsNotifier implements Notifier {
    private static final Logger log = LoggerFactory.getLogger(SmsNotifier.class);
    @Override public Channel channel() { return Channel.SMS; }
    @Override public void send(String recipient, String message) {
        log.info("[SMS] {} <- {}", recipient, message);
    }
}
```

```java
package com.example.shop.notification;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

@Component
public class NotificationDispatcher {

    private static final Logger log = LoggerFactory.getLogger(NotificationDispatcher.class);

    private final Map<Notifier.Channel, Notifier> notifiers;
    private final AuditLogger auditLogger;

    public NotificationDispatcher(List<Notifier> notifierList, AuditLogger auditLogger) {
        Map<Notifier.Channel, Notifier> map = new EnumMap<>(Notifier.Channel.class);
        for (Notifier n : notifierList) {
            Notifier previous = map.put(n.channel(), n);
            if (previous != null) {
                // 啟動時就爆，不要等到執行期才發現有兩個實作搶同一個管道
                throw new IllegalStateException(
                        "管道 " + n.channel() + " 有多個實作："
                        + previous.getClass().getSimpleName() + " 與 " + n.getClass().getSimpleName());
            }
        }
        this.notifiers = map;
        this.auditLogger = auditLogger;
    }

    public void notify(Notifier.Channel channel, String recipient, String message) {
        // 稽核一定執行，與管道無關
        auditLogger.record(channel.name(), recipient, message);

        Notifier notifier = notifiers.get(channel);
        if (notifier == null) {
            log.warn("管道 {} 尚未實作，改用 EMAIL 遞送", channel);
            notifier = notifiers.get(Notifier.Channel.EMAIL);
        }
        notifier.send(recipient, message);
    }
}
```

**三個設計重點：**

1. **用 `enum` 當 key 而不是字串**——編譯期就檢查，`EnumMap` 也比 `HashMap` 快。
2. **建構子裡檢查重複並丟例外**——「同一個管道有兩個實作」是設定錯誤，
   應該在**啟動時**炸掉（fail fast），而不是執行期隨機用到其中一個。
3. **稽核不是策略的一部分**——它是「一定要做的事」。
   進階做法是用 AOP 切面（第 04 章）或事件（第 06 章）把它完全抽離。

新增 LINE 管道時，只要加一個 `@Component implements Notifier`，這個類別完全不用改。

</details>

### 練習 3：找出循環依賴並修正

```java
@Service
public class UserService {
    private final OrderService orderService;
    public UserService(OrderService orderService) { this.orderService = orderService; }

    public UserProfile getProfile(long userId) {
        return new UserProfile(userId, orderService.countByUser(userId));
    }
}

@Service
public class OrderService {
    private final UserService userService;
    public OrderService(UserService userService) { this.userService = userService; }

    public Order place(long userId, BigDecimal amount) {
        if (!userService.isActive(userId)) {
            throw new IllegalStateException("使用者未啟用");
        }
        return new Order(null, String.valueOf(userId), amount, "CREATED");
    }

    public int countByUser(long userId) { return 42; }
}
```

<details>
<summary>參考解答</summary>

**先分析「真正需要的是什麼」，而不是急著加 `@Lazy`：**

- `UserService` 需要 `OrderService` 的什麼？→ **訂單筆數**（一個查詢）
- `OrderService` 需要 `UserService` 的什麼？→ **使用者是否啟用**（一個查詢）

兩邊都只需要對方的**資料查詢**，不需要對方的**業務邏輯**。
所以正確做法是**讓兩者都依賴 Repository，而不是互相依賴 Service**。

```java
package com.example.shop.user;

public interface UserRepository {
    boolean existsActiveById(long userId);
}
```

```java
package com.example.shop.order;

public interface OrderRepository {
    int countByUserId(long userId);
}
```

```java
package com.example.shop.user;

import com.example.shop.order.OrderRepository;
import org.springframework.stereotype.Service;

@Service
public class UserService {
    private final UserRepository userRepository;
    private final OrderRepository orderRepository;     // 依賴 Repository，不是 OrderService

    public UserService(UserRepository userRepository, OrderRepository orderRepository) {
        this.userRepository = userRepository;
        this.orderRepository = orderRepository;
    }

    public UserProfile getProfile(long userId) {
        return new UserProfile(userId, orderRepository.countByUserId(userId));
    }

    public boolean isActive(long userId) {
        return userRepository.existsActiveById(userId);
    }

    public record UserProfile(long userId, int orderCount) { }
}
```

```java
package com.example.shop.order;

import com.example.shop.user.UserRepository;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final UserRepository userRepository;       // 同樣依賴 Repository

    public OrderService(OrderRepository orderRepository, UserRepository userRepository) {
        this.orderRepository = orderRepository;
        this.userRepository = userRepository;
    }

    public void place(long userId, BigDecimal amount) {
        if (!userRepository.existsActiveById(userId)) {
            throw new IllegalStateException("使用者未啟用");
        }
        // ... 建立訂單 ...
    }
}
```

**依賴圖從**

```
UserService ⇄ OrderService        （循環）
```

**變成**

```
UserService  ──┐
               ├──▶ UserRepository
OrderService ──┘
               ├──▶ OrderRepository
```

**通用原則**：Service 之間的循環依賴，八成是因為「Service A 只是想查一筆資料」。
**查資料就直接找 Repository，不要繞路呼叫另一個 Service。**
真正需要對方業務邏輯時（例如下單要觸發發票開立），才用事件解耦。

</details>

### 練習 4：`@Configuration` 陷阱

以下程式會建立幾個 `HikariDataSource` 實例？

```java
@Configuration(proxyBeanMethods = false)
public class DbConfig {
    @Bean
    public DataSource dataSource() {
        System.out.println("建立 DataSource");
        return new HikariDataSource();
    }

    @Bean
    public OrderRepository orderRepo() { return new JdbcOrderRepository(dataSource()); }

    @Bean
    public UserRepository userRepo() { return new JdbcUserRepository(dataSource()); }

    @Bean
    public AuditRepository auditRepo() { return new JdbcAuditRepository(dataSource()); }
}
```

<details>
<summary>參考解答</summary>

**4 個。** 輸出會印四次「建立 DataSource」。

因為 `proxyBeanMethods = false`（lite 模式）**沒有 CGLIB 代理**，
所以 `dataSource()` 就是一般的 Java 方法呼叫，每次都真的執行一次 `new HikariDataSource()`。

- 1 個給容器（Bean 名稱 `dataSource`）
- 3 個分別給三個 Repository（**沒有進容器，也永遠不會被關閉**）

**實際後果非常嚴重**：

- 四個連線池，每個預設 10 條連線 → 資料庫連線數變成 4 倍。
- 那三個「野生」連線池不在容器管理下，`@PreDestroy` / `destroyMethod` 不會被呼叫 → **關閉服務時連線不會釋放**。
- Actuator 的 `/actuator/health` 只會檢查容器裡那一個，其他三個掛了你不會知道。
- 監控指標（HikariCP metrics）也只有一個有數據。

**兩種修法：**

```java
// 修法 A：改用參數注入（lite 模式的正確寫法）
@Configuration(proxyBeanMethods = false)
public class DbConfig {
    @Bean
    public DataSource dataSource() { return new HikariDataSource(); }

    @Bean
    public OrderRepository orderRepo(DataSource dataSource) {
        return new JdbcOrderRepository(dataSource);
    }
    // userRepo、auditRepo 同理
}

// 修法 B：拿掉 proxyBeanMethods = false，用預設的 full 模式
@Configuration
public class DbConfig {
    // 原本的寫法就安全了，CGLIB 代理會確保只建立一次
}
```

**修法 A 更好**：不需要 CGLIB 代理、啟動更快、依賴關係從方法簽章一眼可見。
養成「`@Bean` 方法之間永遠用參數注入，不要直接呼叫」的習慣，就永遠不會踩到這個坑。

</details>

### 練習 5：實作驗證器責任鏈

需求：下單前要依序執行多個驗證（客戶存在、商品有庫存、金額合理、非黑名單），
任何一個失敗就中止並回傳錯誤原因。未來還會加新的驗證規則。

<details>
<summary>參考解答</summary>

```java
package com.example.shop.order.validation;

import java.math.BigDecimal;

public record OrderRequest(long customerId, String sku, int quantity, BigDecimal amount) { }
```

```java
package com.example.shop.order.validation;

public interface OrderValidator {
    /** 驗證失敗時丟出 OrderValidationException */
    void validate(OrderRequest request);
}
```

```java
package com.example.shop.order.validation;

public class OrderValidationException extends RuntimeException {
    private final String code;

    public OrderValidationException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String getCode() { return code; }
}
```

```java
package com.example.shop.order.validation;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Order(10)                       // 最先跑：不存在的客戶，後面都不用驗了
public class CustomerExistsValidator implements OrderValidator {

    @Override
    public void validate(OrderRequest request) {
        if (request.customerId() <= 0) {
            throw new OrderValidationException("CUSTOMER_NOT_FOUND",
                    "找不到客戶 " + request.customerId());
        }
    }
}
```

```java
package com.example.shop.order.validation;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;

@Component
@Order(20)
public class AmountValidator implements OrderValidator {

    private static final BigDecimal MAX = new BigDecimal("1000000");

    @Override
    public void validate(OrderRequest request) {
        if (request.amount() == null || request.amount().signum() <= 0) {
            throw new OrderValidationException("INVALID_AMOUNT", "金額必須大於 0");
        }
        if (request.amount().compareTo(MAX) > 0) {
            throw new OrderValidationException("AMOUNT_TOO_LARGE",
                    "單筆訂單金額不可超過 " + MAX);
        }
    }
}
```

```java
package com.example.shop.order.validation;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
@Order(30)                       // 最後跑：需要查外部服務，成本最高
public class BlacklistValidator implements OrderValidator {

    private final Set<Long> blacklist = Set.of(6666L, 8888L);

    @Override
    public void validate(OrderRequest request) {
        if (blacklist.contains(request.customerId())) {
            throw new OrderValidationException("CUSTOMER_BLACKLISTED", "此帳號已被限制下單");
        }
    }
}
```

```java
package com.example.shop.order.validation;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class OrderValidationChain {

    private static final Logger log = LoggerFactory.getLogger(OrderValidationChain.class);

    private final List<OrderValidator> validators;

    // 注入 List 時，Spring 會依 @Order 排好序
    public OrderValidationChain(List<OrderValidator> validators) {
        this.validators = validators;
        log.info("已載入 {} 個訂單驗證器：{}", validators.size(),
                validators.stream().map(v -> v.getClass().getSimpleName()).toList());
    }

    public void validate(OrderRequest request) {
        for (OrderValidator validator : validators) {
            validator.validate(request);        // 任何一個丟例外就中止
        }
    }
}
```

測試（不啟動 Spring，順序自己指定）：

```java
package com.example.shop.order.validation;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class OrderValidationChainTest {

    private final OrderValidationChain chain = new OrderValidationChain(List.of(
            new CustomerExistsValidator(),
            new AmountValidator(),
            new BlacklistValidator()));

    @Test
    void 合法訂單應通過() {
        assertThatCode(() -> chain.validate(
                new OrderRequest(1L, "SKU-1", 1, new BigDecimal("100"))))
                .doesNotThrowAnyException();
    }

    @Test
    void 黑名單客戶應被拒絕() {
        assertThatThrownBy(() -> chain.validate(
                new OrderRequest(6666L, "SKU-1", 1, new BigDecimal("100"))))
                .isInstanceOf(OrderValidationException.class)
                .hasMessageContaining("限制下單");
    }

    @Test
    void 客戶不存在時應在第一關就被擋下() {
        // 金額也是不合法的，但應該回報 CUSTOMER_NOT_FOUND 而不是 INVALID_AMOUNT
        assertThatThrownBy(() -> chain.validate(
                new OrderRequest(-1L, "SKU-1", 1, BigDecimal.ZERO)))
                .isInstanceOf(OrderValidationException.class)
                .hasFieldOrPropertyWithValue("code", "CUSTOMER_NOT_FOUND");
    }
}
```

**設計重點：**

1. **`@Order` 數字留間隔（10、20、30）**——中間要插一個新驗證器時不用改別人。
2. **昂貴的驗證放後面**——先擋掉便宜就能判斷的錯誤，省下外部呼叫。
3. **在建構子 log 出載入了哪些驗證器**——上線後可以從啟動日誌確認規則有沒有全部生效。
   這比「以為有生效」好太多了。
4. 這個設計也是 04-controller 第 02 章 Bean Validation 的補充：
   **Bean Validation 管「格式」，這條鏈管「業務規則」**（需要查資料庫的那種）。

</details>

---

## 1.19 驗收清單

- [ ] 我能說出「自己 `new` 依賴」造成的問題不只是耦合，而是**無法寫測試**。
- [ ] 我能區分 IoC、DI、DIP 三個名詞，並說出「介面應該屬於使用方」的意義。
- [ ] 我知道 `ApplicationContext` 預設立即初始化單例，而這是為了 fail fast。
- [ ] 我能用 `@Component` 家族、`@Bean` 方法兩種方式註冊 Bean，並說出各自適用場景。
- [ ] 我知道 `@Repository` 唯一的實際功能差異是**例外轉譯**。
- [ ] 我知道元件掃描的基準是主類別所在套件，也知道掃描範圍過寬的代價。
- [ ] 我一律用建構子注入，並能舉出欄位注入的至少三個具體問題。
- [ ] 我遇到同型別多個 Bean 時，能判斷該用 `@Primary`、`@Qualifier` 還是注入 `List`。
- [ ] 我能用「注入 `List` 建 Map」實作策略模式，並知道**不要**直接注入 `Map<String, T>`（key 是 Bean 名稱）。
- [ ] 我知道單例 Bean 不能有可變狀態，也知道這個 bug 在開發環境測不出來。
- [ ] 我知道單例注入 prototype 會失效，並能用 `ObjectProvider` 解決。
- [ ] 我能畫出 Bean 生命週期，並指出 **AOP 代理在 `postProcessAfterInitialization` 產生**。
- [ ] 我知道 `@PostConstruct` 失敗會讓服務啟動失敗，所以外部呼叫要放 `ApplicationReadyEvent`。
- [ ] 我看到 `not eligible for getting processed by all BeanPostProcessors` 警告時，知道它代表 AOP 可能失效。
- [ ] 我能診斷循環依賴，知道 Boot 2.6+ 預設禁止，並優先用「抽第三個類別」而不是 `@Lazy` 解決。
- [ ] 我知道 `@Configuration(proxyBeanMethods = false)` 時 `@Bean` 方法互相呼叫會建立多個實例。
- [ ] 我知道 `spring.main.lazy-initialization` 在正式環境的風險。
- [ ] 我會用 `/actuator/beans` 確認 Bean 有沒有進容器。

---

完成後請前往 [02-auto-configuration-and-starter.md](./02-auto-configuration-and-starter.md)。
