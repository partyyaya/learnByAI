# 第 02 章：自動組態原理

> 這一章要回答一個所有人都想過、但很少人真的查清楚的問題：
> **我只是在 `pom.xml` 加了一行 `spring-boot-starter-web`，為什麼就多出了一台 Tomcat、一個 JSON 序列化器、一個錯誤頁面？**
>
> 答案不是魔法，是三件很具體的事：
> 1. classpath 上多了一批 jar。
> 2. 其中一個 jar 裡有一份**清單檔**，列出「有哪些組態類別可以考慮」。
> 3. 每個組態類別身上掛著**條件**，Spring 啟動時逐一評估，成立才生效。
>
> 看懂這三步，你就能解釋「為什麼我的 Bean 沒生效」，也能自己寫一個 starter，
> 讓公司內部的共用元件變成「加一行依賴就能用」。

---

## 2.1 學習目標

完成本章後，你應該可以：

- 解釋「加一行 starter 依賴」到底發生了什麼事，並用實驗驗證。
- 說明 starter 的本質（一個沒有程式碼的 pom），以及 `xxx-starter` 與 `xxx-autoconfigure` 的分工。
- 追蹤 `@SpringBootApplication` → `@EnableAutoConfiguration` → `AutoConfigurationImportSelector` 的完整路徑。
- 說出 Boot 3 的 `AutoConfiguration.imports` 檔案與 Boot 2 的 `spring.factories` 的差別。
- 熟練 `@Conditional` 家族，並知道每個條件的**評估時機**（這比記註解名稱重要）。
- 逐行讀懂一個真實的自動組態原始碼。
- 說明「為什麼我自己定義的 Bean 一定會贏過自動組態」，以及這件事什麼時候會失效。
- 用 `--debug` 與 `/actuator/conditions` 讀懂條件評估報告，診斷「為什麼這個自動組態沒生效」。
- 用四種方式覆寫或關閉自動組態。
- **從零寫出一個公司內部用的 starter**：含 properties、條件、預設實作、設定提示與測試。
- 用 `ApplicationContextRunner` 為自動組態寫測試。

---

## 2.2 先做一個實驗：starter 到底帶來什麼

### 實驗 A：空專案

`pom.xml` 只有最小依賴：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter</artifactId>
</dependency>
```

```java
package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}
```

執行結果：

```
2026-08-18T11:02:11.882+08:00  INFO --- Starting DemoApplication using Java 21.0.5
2026-08-18T11:02:12.031+08:00  INFO --- Started DemoApplication in 0.331 seconds

Process finished with exit code 0        ← 跑完就結束了
```

**沒有 Tomcat，程式跑完直接結束。**

### 實驗 B：加上 `spring-boot-starter-web`

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
</dependency>
```

**Java 程式碼一個字都沒改**，重新啟動：

```
2026-08-18T11:03:44.101+08:00  INFO --- Tomcat initialized with port 8080 (http)
2026-08-18T11:03:44.822+08:00  INFO --- Tomcat started on port 8080 (http) with context path '/'
2026-08-18T11:03:44.835+08:00  INFO --- Started DemoApplication in 1.412 seconds
                                        ← 程式沒有結束，它在監聽 8080
```

而且你馬上就有：

```bash
$ curl -s localhost:8080/nonexistent | jq
{
  "timestamp": "2026-08-18T03:03:52.418+00:00",
  "status": 404,
  "error": "Not Found",
  "path": "/nonexistent"
}
```

**一個沒寫過的錯誤處理器**。還有 JSON 序列化、靜態資源處理、字元編碼過濾器、
`multipart` 上傳解析……全部都在。

### 到底加了幾個 Bean？

```java
package com.example.demo;

import org.springframework.boot.CommandLineRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

@Component
public class BeanCounter implements CommandLineRunner {
    private final ApplicationContext context;
    public BeanCounter(ApplicationContext context) { this.context = context; }

    @Override
    public void run(String... args) {
        System.out.println("Bean 總數：" + context.getBeanDefinitionCount());
    }
}
```

```
只有 spring-boot-starter：      Bean 總數：36
加上 spring-boot-starter-web：  Bean 總數：118
```

**多了 82 個 Bean，而你一行程式都沒寫。** 這一章就是要解釋這 82 個是怎麼來的。

---

## 2.3 starter 的真身：一個沒有程式碼的 pom

打開 `spring-boot-starter-web` 的 jar 看看：

```bash
$ ./mvnw dependency:copy -Dartifact=org.springframework.boot:spring-boot-starter-web:3.5.0 \
    -DoutputDirectory=/tmp/starter
$ unzip -l /tmp/starter/spring-boot-starter-web-3.5.0.jar
Archive:  spring-boot-starter-web-3.5.0.jar
  Length      Date    Time    Name
---------  ---------- -----   ----
        0  2026-05-22 08:00   META-INF/
      xxx  2026-05-22 08:00   META-INF/MANIFEST.MF
      xxx  2026-05-22 08:00   META-INF/maven/.../pom.xml
      xxx  2026-05-22 08:00   META-INF/maven/.../pom.properties
---------                     -------
```

**一個 `.class` 檔都沒有。** starter 的全部內容就是它的 `pom.xml`：

```xml
<!-- spring-boot-starter-web 的 pom.xml（節錄） -->
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-json</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-tomcat</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework</groupId>
        <artifactId>spring-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework</groupId>
        <artifactId>spring-webmvc</artifactId>
    </dependency>
</dependencies>
```

> **所以：starter 只做一件事 —— 把一組經過相容性測試的依賴打包成一個座標。**
> 它本身沒有任何「自動設定」的邏輯。真正做事的是 `spring-boot-autoconfigure`（由 `spring-boot-starter` 傳遞帶入）。

### `spring-boot-starter` 又是什麼

```xml
<!-- spring-boot-starter 的 pom.xml（節錄） -->
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-autoconfigure</artifactId>   <!-- ★ 自動組態的實作在這裡 ★ -->
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-logging</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework</groupId>
        <artifactId>spring-core</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework</groupId>
        <artifactId>spring-context</artifactId>
    </dependency>
    <!-- ... -->
</dependencies>
```

### `spring-boot-autoconfigure` 裡面有什麼

```bash
$ unzip -l /tmp/autoconfigure/spring-boot-autoconfigure-3.5.0.jar | grep AutoConfiguration.class | head -20
org/springframework/boot/autoconfigure/web/servlet/DispatcherServletAutoConfiguration.class
org/springframework/boot/autoconfigure/web/servlet/ServletWebServerFactoryAutoConfiguration.class
org/springframework/boot/autoconfigure/web/servlet/WebMvcAutoConfiguration.class
org/springframework/boot/autoconfigure/web/servlet/error/ErrorMvcAutoConfiguration.class
org/springframework/boot/autoconfigure/jackson/JacksonAutoConfiguration.class
org/springframework/boot/autoconfigure/jdbc/DataSourceAutoConfiguration.class
org/springframework/boot/autoconfigure/orm/jpa/HibernateJpaAutoConfiguration.class
org/springframework/boot/autoconfigure/data/redis/RedisAutoConfiguration.class
...

$ unzip -l /tmp/autoconfigure/spring-boot-autoconfigure-3.5.0.jar | grep -c AutoConfiguration.class
160
```

**160 個自動組態類別，全部都在 classpath 上，但只有少數會生效。** 這就是條件機制存在的意義。

### 三個模組的分工

```
┌───────────────────────────────┐
│ xxx-spring-boot-starter        │  只有 pom，宣告依賴
│  （使用者加這一個）              │
└───────────────┬───────────────┘
                │ 依賴
                ▼
┌───────────────────────────────┐
│ xxx-spring-boot-autoconfigure  │  自動組態類別 + Properties + imports 清單
└───────────────┬───────────────┘
                │ 依賴
                ▼
┌───────────────────────────────┐
│ xxx-core / 第三方函式庫         │  真正做事的程式碼
└───────────────────────────────┘
```

> **命名慣例（很重要，別搞反）**：
> - 官方 starter：`spring-boot-starter-xxx`（`spring-boot-starter` 開頭）
> - **第三方 starter：`xxx-spring-boot-starter`**（自己的名字開頭）
>
> 例如 MyBatis 的是 `mybatis-spring-boot-starter`，不是 `spring-boot-starter-mybatis`。
> 這是為了讓命名空間歸屬清楚——`spring-boot-starter-` 這個前綴是 Spring 團隊保留的。

---

## 2.4 追蹤程式碼：從註解到條件評估

### 第一步：`@SpringBootApplication` → `@EnableAutoConfiguration`

```java
@SpringBootConfiguration
@EnableAutoConfiguration          // ← 就是這個
@ComponentScan(...)
public @interface SpringBootApplication { }
```

### 第二步：`@EnableAutoConfiguration` → `@Import`

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Inherited
@AutoConfigurationPackage                            // ① 記住主類別的套件（給 JPA 掃 Entity 用）
@Import(AutoConfigurationImportSelector.class)       // ② ★ 真正的入口 ★
public @interface EnableAutoConfiguration {

    String ENABLED_OVERRIDE_PROPERTY = "spring.boot.enableautoconfiguration";

    Class<?>[] exclude() default {};
    String[] excludeName() default {};
}
```

> **① `@AutoConfigurationPackage` 常被忽略但很重要**：它把「主類別所在的套件」註冊成一個 Bean。
> Spring Data JPA 的 `EntityScan`、Spring Data MongoDB 等都靠它決定「要從哪裡開始找 Entity」。
> 這也是為什麼主類別位置放錯時，連 Entity 都掃不到。

### 第三步：`AutoConfigurationImportSelector` 做了什麼

```java
// 簡化後的核心流程
public class AutoConfigurationImportSelector implements DeferredImportSelector {

    protected AutoConfigurationEntry getAutoConfigurationEntry(AnnotationMetadata metadata) {

        // ① 檢查有沒有被關掉（spring.boot.enableautoconfiguration=false）
        if (!isEnabled(metadata)) {
            return EMPTY_ENTRY;
        }

        // ② 讀出所有候選的自動組態類別名稱（從 imports 檔案）
        List<String> configurations = getCandidateConfigurations(metadata, attributes);

        // ③ 去重
        configurations = removeDuplicates(configurations);

        // ④ 移除被排除的（@SpringBootApplication(exclude=...)、spring.autoconfigure.exclude）
        Set<String> exclusions = getExclusions(metadata, attributes);
        configurations.removeAll(exclusions);

        // ⑤ ★ 過濾：套用 OnClassCondition / OnBeanCondition / OnWebApplicationCondition ★
        //    這一步會把「classpath 上沒有對應類別」的自動組態直接刷掉，非常快
        configurations = getConfigurationClassFilter().filter(configurations);

        // ⑥ 發出事件（給 ConditionEvaluationReport 記錄用）
        fireAutoConfigurationImportEvents(configurations, exclusions);

        return new AutoConfigurationEntry(configurations, exclusions);
    }
}
```

**注意 `DeferredImportSelector` 這個介面**——它的意思是「**延後處理**」。
所有 `@Configuration`、`@Component` 都處理完之後，才輪到自動組態。

> **這一點是整個機制的關鍵**：因為使用者的 Bean 先註冊，
> 自動組態的 `@ConditionalOnMissingBean` 才能正確判斷「使用者有沒有自己定義」。
> 順序反過來的話，「使用者的設定會贏」這個保證就不成立了。

### 第四步：候選清單從哪來

```java
protected List<String> getCandidateConfigurations(AnnotationMetadata metadata,
                                                  AnnotationAttributes attributes) {
    // Boot 3.x
    List<String> configurations = ImportCandidates
            .load(AutoConfiguration.class, getBeanClassLoader())
            .getCandidates();
    Assert.notEmpty(configurations, "No auto configuration classes found in "
            + "META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports.");
    return configurations;
}
```

它讀的檔案是：

```
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

打開來看（就是一個純文字檔，一行一個類別全名）：

```
org.springframework.boot.autoconfigure.admin.SpringApplicationAdminJmxAutoConfiguration
org.springframework.boot.autoconfigure.aop.AopAutoConfiguration
org.springframework.boot.autoconfigure.amqp.RabbitAutoConfiguration
org.springframework.boot.autoconfigure.batch.BatchAutoConfiguration
org.springframework.boot.autoconfigure.cache.CacheAutoConfiguration
org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration
org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration
... （共 160 行）
```

自己驗證一次：

```bash
$ unzip -p ~/.m2/repository/org/springframework/boot/spring-boot-autoconfigure/3.5.0/spring-boot-autoconfigure-3.5.0.jar \
    META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports | head -20
```

### Boot 2 vs Boot 3 的差別

| | Spring Boot 2.x | Spring Boot 3.x |
|---|---|---|
| 檔案位置 | `META-INF/spring.factories` | `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` |
| 格式 | properties（key=value，逗號分隔 + 反斜線換行） | 純文字，一行一個類別 |
| 用途 | 一個檔案裝所有 SPI（initializer、listener、failure analyzer…） | **只裝自動組態**，其他 SPI 仍用 `spring.factories` |
| 相容性 | — | 2.7 起支援新格式，3.0 起**不再讀 `spring.factories` 裡的自動組態** |

Boot 2 的 `spring.factories` 長這樣（醜多了）：

```properties
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
org.springframework.boot.autoconfigure.admin.SpringApplicationAdminJmxAutoConfiguration,\
org.springframework.boot.autoconfigure.aop.AopAutoConfiguration,\
org.springframework.boot.autoconfigure.amqp.RabbitAutoConfiguration
```

> ⚠️ **Boot 2 → 3 遷移最常見的「自訂 starter 突然失效」就是這個**：
> 舊 starter 只有 `spring.factories`，升到 Boot 3 之後自動組態靜靜地不生效，
> **沒有任何錯誤訊息**，只有「Bean 找不到」。第 09 章會再提醒一次。

### 完整流程圖

```
啟動
 │
 ├─ ConfigurationClassPostProcessor 開始解析 @Configuration
 │    │
 │    ├─ 解析 @ComponentScan → 註冊「你的」Bean 定義
 │    ├─ 解析 @Import        → 一般的 ImportSelector 立即處理
 │    └─ 收集 DeferredImportSelector（AutoConfigurationImportSelector 在此排隊）
 │
 ├─ ★ 所有一般組態處理完後，才處理 DeferredImportSelector ★
 │    │
 │    ├─ ① 讀 AutoConfiguration.imports（所有 jar 的都讀）→ 得到 ~160 個候選
 │    │
 │    ├─ ② 套用 exclude（註解 + 設定檔）
 │    │
 │    ├─ ③ AutoConfigurationImportFilter 快速過濾
 │    │      OnClassCondition：classpath 沒有那個類別 → 直接刷掉
 │    │      （用 spring-autoconfigure-metadata.properties 加速，不用真的載入類別）
 │    │      160 個 → 剩下 ~30 個
 │    │
 │    ├─ ④ 依 @AutoConfiguration(before/after) 與 @AutoConfigureOrder 排序
 │    │
 │    └─ ⑤ 逐一處理每個自動組態類別：
 │           評估類別層級 @Conditional → 不成立就整個跳過
 │           評估每個 @Bean 方法的 @Conditional → 不成立就不註冊該 Bean
 │
 └─ 實例化所有 Bean
```

> **③ 那一步的效能設計很值得學**：`spring-autoconfigure-metadata.properties` 是編譯期產生的索引，
> 記錄每個自動組態類別的 `@ConditionalOnClass` 要求。Spring 可以先讀這份索引做字串比對，
> **不需要真的用反射載入 160 個類別**。這是 Spring Boot 啟動速度的重要最佳化之一。

---

## 2.5 `@Conditional` 家族

這是自動組態的核心。所有條件註解都建立在同一個基礎上：

```java
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
public @interface Conditional {
    Class<? extends Condition>[] value();
}

public interface Condition {
    boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata);
}
```

### 完整清單

#### 類別相關

```java
@ConditionalOnClass(DataSource.class)              // classpath 上有這個類別
@ConditionalOnClass(name = "com.mysql.cj.jdbc.Driver")   // 用字串，類別不在編譯期依賴時用
@ConditionalOnMissingClass("org.h2.Driver")        // classpath 上沒有
```

> **為什麼 `@ConditionalOnClass(DataSource.class)` 不會 `NoClassDefFoundError`？**
> 因為註解的值在 class 檔裡是以**常數池的字串**形式存在的，
> Spring 用 ASM 讀 bytecode 取得類別名稱，**不需要載入那個類別**。
> 這是很聰明的設計，但也表示：**`@ConditionalOnClass` 只能寫在自動組態類別上，
> 不能寫在你自己會被正常載入的類別上**（因為那時 JVM 會真的載入方法簽章裡的型別）。

#### Bean 相關（最常用）

```java
@ConditionalOnBean(DataSource.class)               // 容器裡已有這個 Bean
@ConditionalOnMissingBean                          // 容器裡沒有「同型別」的 Bean（依方法回傳型別判斷）
@ConditionalOnMissingBean(name = "myCache")        // 依名稱
@ConditionalOnMissingBean(type = "com.x.Y")        // 依型別全名（類別可能不在 classpath）
@ConditionalOnSingleCandidate(DataSource.class)    // 只有一個候選，或有 @Primary
```

#### 設定相關

```java
@ConditionalOnProperty(name = "shop.audit.enabled", havingValue = "true")
@ConditionalOnProperty(prefix = "shop.audit", name = "enabled", matchIfMissing = true)
@ConditionalOnExpression("${shop.audit.enabled:true} and '${spring.profiles.active}' != 'test'")
```

#### 環境相關

```java
@ConditionalOnWebApplication(type = Type.SERVLET)  // Servlet Web 應用
@ConditionalOnWebApplication(type = Type.REACTIVE) // WebFlux
@ConditionalOnNotWebApplication                    // 非 Web（批次程式）
@ConditionalOnCloudPlatform(CloudPlatform.KUBERNETES)
@Profile("prod")                                   // 嚴格來說不是 @ConditionalOnXxx，但同機制
```

#### 資源相關

```java
@ConditionalOnResource(resources = "classpath:custom-config.xml")
@ConditionalOnJava(JavaVersion.SEVENTEEN)          // JDK 版本
@ConditionalOnJndi("java:comp/env/jdbc/DS")
```

### 評估時機：`@ConditionalOnBean` 的大坑

**這是自訂 starter 最常出錯的地方，一定要理解。**

```java
@Configuration
public class MyConfig {

    @Bean
    @ConditionalOnBean(DataSource.class)      // ⚠️ 「現在」容器裡有沒有 DataSource？
    public AuditRepository auditRepository(DataSource ds) {
        return new JdbcAuditRepository(ds);
    }
}
```

問題：**條件是在「評估這個組態類別的當下」判斷的**。
如果 `DataSource` 還沒被註冊（因為 `DataSourceAutoConfiguration` 排在後面），這個條件就是 `false`。

**規則**：

> `@ConditionalOnBean` / `@ConditionalOnMissingBean` **只能可靠地用在自動組態類別上**，
> 而且必須配合 `@AutoConfiguration(after = ...)` 確保順序。
>
> **不要**在你自己專案的一般 `@Configuration` 上用 `@ConditionalOnBean`——
> 因為一般 `@Configuration` 在自動組態**之前**處理，那時候幾乎什麼都還沒註冊。

正確寫法：

```java
@AutoConfiguration(after = DataSourceAutoConfiguration.class)   // ★ 明確宣告順序 ★
@ConditionalOnClass(DataSource.class)
public class AuditAutoConfiguration {

    @Bean
    @ConditionalOnBean(DataSource.class)
    @ConditionalOnMissingBean
    public AuditRepository auditRepository(DataSource ds) {
        return new JdbcAuditRepository(ds);
    }
}
```

### `@ConditionalOnMissingBean` 的判斷依據

```java
@Bean
@ConditionalOnMissingBean                    // ← 沒寫參數時，看什麼？
public Notifier notifier() {
    return new EmailNotifier();
}
```

**看的是「方法的回傳型別」**，也就是 `Notifier`。
所以只要容器裡有任何 `Notifier` 型別的 Bean，這個方法就不執行。

常見錯誤：

```java
@Bean
@ConditionalOnMissingBean
public EmailNotifier notifier() {         // ⚠️ 回傳型別是具體類別！
    return new EmailNotifier();
}
// 使用者定義了 SmsNotifier implements Notifier
// → 條件檢查的是「有沒有 EmailNotifier」→ 沒有 → 自動組態照樣建立
// → 容器裡出現兩個 Notifier → 使用者注入時爆「required a single bean, but 2 were found」
```

> **規則：`@Bean` 方法的回傳型別，寫「你希望使用者用來注入的那個型別」**，
> 通常是介面而不是實作類別。

---

## 2.6 逐行讀懂一個真實的自動組態

### 案例 1：`JacksonAutoConfiguration`（簡化）

```java
package org.springframework.boot.autoconfigure.jackson;

@AutoConfiguration
@ConditionalOnClass(ObjectMapper.class)                    // ① classpath 有 Jackson 才生效
public class JacksonAutoConfiguration {

    @Configuration(proxyBeanMethods = false)               // ② lite 模式，啟動快
    @ConditionalOnClass(Jackson2ObjectMapperBuilder.class)
    static class JacksonObjectMapperConfiguration {

        @Bean
        @Primary                                           // ③ 標成主要的，使用者注入時優先拿到
        @ConditionalOnMissingBean                          // ④ ★ 你自己定義了就用你的 ★
        ObjectMapper jacksonObjectMapper(Jackson2ObjectMapperBuilder builder) {
            return builder.createXmlMapper(false).build();
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class Jackson2ObjectMapperBuilderCustomizerConfiguration {

        @Bean
        StandardJackson2ObjectMapperBuilderCustomizer standardJacksonObjectMapperBuilderCustomizer(
                JacksonProperties jacksonProperties) {     // ⑤ 讀 spring.jackson.* 設定
            return new StandardJackson2ObjectMapperBuilderCustomizer(jacksonProperties);
        }
    }
}
```

**這段程式碼的翻譯：**

> ① 如果 classpath 上有 Jackson，
> ④ 而且你沒有自己定義 `ObjectMapper`，
> ⑤ 就依照 `spring.jackson.*` 的設定幫你建一個。

所以你在 `application.yml` 寫：

```yaml
spring:
  jackson:
    default-property-inclusion: non_null      # null 欄位不輸出
    serialization:
      write-dates-as-timestamps: false        # 日期輸出 ISO-8601 而不是數字
    time-zone: Asia/Taipei
```

就會影響全域的 JSON 序列化——因為那個 `ObjectMapper` 是自動組態依你的設定建的。

**如果你要完全自己控制**：

```java
@Configuration
public class JacksonConfig {

    @Bean
    public ObjectMapper objectMapper() {          // 定義了就贏，自動組態退開
        ObjectMapper mapper = new ObjectMapper();
        mapper.registerModule(new JavaTimeModule());
        mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        mapper.setSerializationInclusion(JsonInclude.Include.NON_NULL);
        return mapper;
    }
}
```

> ⚠️ **但這通常不是好主意**。自己 `new ObjectMapper()` 會失去 Spring Boot 幫你註冊的一堆
> module（`Jdk8Module`、`JavaTimeModule`、`ParameterNamesModule`），
> 結果就是「`Optional` 序列化變成 `{present: true}`」「建構子綁定失效」這類問題。
>
> **更好的做法是「客製化」而不是「取代」**：
>
> ```java
> @Bean
> public Jackson2ObjectMapperBuilderCustomizer jacksonCustomizer() {
>     return builder -> builder
>             .serializationInclusion(JsonInclude.Include.NON_NULL)
>             .timeZone(TimeZone.getTimeZone("Asia/Taipei"))
>             .modulesToInstall(new MoneyModule());
> }
> ```
>
> **「Customizer 模式」是 Spring Boot 的重要慣例**：
> 幾乎每個自動組態都提供一個 `XxxCustomizer` 介面，讓你在「不接管整個 Bean」的前提下調整細節。
> 常見的有 `WebServerFactoryCustomizer`、`RestClientCustomizer`、`SpringDataWebSettings`…

### 案例 2：`DataSourceAutoConfiguration`（簡化）

```java
@AutoConfiguration(before = SqlInitializationAutoConfiguration.class)
@ConditionalOnClass({ DataSource.class, EmbeddedDatabaseType.class })   // ① 有 JDBC
@ConditionalOnMissingBean(type = "io.r2dbc.spi.ConnectionFactory")      // ② 不是響應式資料庫
@EnableConfigurationProperties(DataSourceProperties.class)              // ③ 綁定 spring.datasource.*
@Import({ DataSourcePoolMetadataProvidersConfiguration.class, ... })
public class DataSourceAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @Conditional(EmbeddedDatabaseCondition.class)          // ④ 沒設 url 且有 H2/HSQL → 用內嵌資料庫
    @ConditionalOnMissingBean({ DataSource.class, XADataSource.class })
    @Import(EmbeddedDataSourceConfiguration.class)
    protected static class EmbeddedDatabaseConfiguration { }

    @Configuration(proxyBeanMethods = false)
    @Conditional(PooledDataSourceCondition.class)          // ⑤ 有設 url 或有指定連線池
    @ConditionalOnMissingBean({ DataSource.class, XADataSource.class })
    @Import({ DataSourceConfiguration.Hikari.class,        // ⑥ ★ 順序就是優先序 ★
              DataSourceConfiguration.Tomcat.class,
              DataSourceConfiguration.Dbcp2.class,
              DataSourceConfiguration.OracleUcp.class,
              DataSourceConfiguration.Generic.class })
    protected static class PooledDataSourceConfiguration { }
}
```

從 ⑥ 可以直接看出**為什麼 Spring Boot 預設用 HikariCP**：因為它排第一。

而 `DataSourceConfiguration.Hikari` 是：

```java
@Configuration(proxyBeanMethods = false)
@ConditionalOnClass(HikariDataSource.class)                // classpath 有 Hikari
@ConditionalOnMissingBean(DataSource.class)
@ConditionalOnProperty(name = "spring.datasource.type",
        havingValue = "com.zaxxer.hikari.HikariDataSource",
        matchIfMissing = true)                             // 沒指定 type 就用它
static class Hikari {
    @Bean
    @ConfigurationProperties(prefix = "spring.datasource.hikari")   // ★ 這行 ★
    HikariDataSource dataSource(DataSourceProperties properties) {
        HikariDataSource ds = createDataSource(properties, HikariDataSource.class);
        if (StringUtils.hasText(properties.getName())) {
            ds.setPoolName(properties.getName());
        }
        return ds;
    }
}
```

那個 `@ConfigurationProperties(prefix = "spring.datasource.hikari")` 加在 `@Bean` 方法上，
意思是「**把 `spring.datasource.hikari.*` 的所有設定綁到這個回傳物件的 setter 上**」。

所以你可以寫：

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop
    username: root
    password: root
    hikari:
      maximum-pool-size: 20          # → HikariDataSource.setMaximumPoolSize(20)
      minimum-idle: 5                # → setMinimumIdle(5)
      connection-timeout: 3000       # → setConnectionTimeout(3000)
      pool-name: shop-pool           # → setPoolName("shop-pool")
```

**這些屬性名稱不是 Spring 定義的，是 HikariCP 的 setter 名稱。**
所以查得到什麼可以設，就是去看 `HikariConfig` 有哪些 setter。

> **這是本節最有價值的一句話**：當你想知道「某個屬性能不能設」時，
> 先找對應的自動組態類別，看它綁到哪個 `Properties` 或哪個物件的 setter 上。
> 比在 Google 上瞎猜關鍵字快十倍。

---

## 2.7 為什麼「你的 Bean 一定贏」

這個保證來自兩件事的組合：

```
① 自動組態是 DeferredImportSelector → 最後才處理
   → 處理時，使用者的 Bean 定義都已經註冊好了

② 自動組態的 @Bean 方法都掛 @ConditionalOnMissingBean
   → 發現已經有同型別的，就不註冊
```

驗證一下：

```java
package com.example.shop.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Component;

@Configuration
class MyJacksonConfig {
    @Bean
    ObjectMapper objectMapper() {
        System.out.println(">>> 使用我自己的 ObjectMapper");
        return new ObjectMapper();
    }
}

@Component
class MapperChecker implements CommandLineRunner {
    private final ObjectMapper mapper;
    MapperChecker(ObjectMapper mapper) { this.mapper = mapper; }

    @Override public void run(String... args) {
        System.out.println("注入到的 ObjectMapper：" + System.identityHashCode(mapper));
    }
}
```

啟動後你會看到「使用我自己的 ObjectMapper」，而且 `/actuator/conditions` 裡
`JacksonAutoConfiguration#jacksonObjectMapper` 會出現在 `negativeMatches`。

### 這個保證什麼時候會失效

**情況 A：型別對不上**

```java
@Bean
public HikariDataSource myDataSource() {     // 回傳具體類別
    return new HikariDataSource();
}
```

`DataSourceAutoConfiguration` 檢查的是 `@ConditionalOnMissingBean(DataSource.class)`，
`HikariDataSource` **是** `DataSource` 的實作，所以這個沒問題。
但反過來——如果自動組態檢查的是具體類別而你定義的是介面，就會出現兩個 Bean。

**情況 B：你的 Bean 定義比自動組態「更晚」註冊**

最典型的例子是**你自己也寫了一個自動組態**：

```java
// 你的自訂 starter
@AutoConfiguration
public class MyAutoConfiguration {
    @Bean
    public ObjectMapper objectMapper() { ... }
}
```

兩個自動組態的執行順序不確定 → `@ConditionalOnMissingBean` 的結果就不確定。
**解法：明確宣告順序。**

```java
@AutoConfiguration(before = JacksonAutoConfiguration.class)
public class MyAutoConfiguration { }
```

**情況 C：`@Import` 進來的 `@Configuration`**

`@Import` 是**立即處理**的，所以它的 Bean 會比自動組態早註冊——這個沒問題。
但如果你在 `@Import` 的類別上用 `@ConditionalOnBean`，就會踩到 2.5 講的評估時機問題。

---

## 2.8 條件評估報告：排查「為什麼沒生效」

這是本章**最實用**的工具。

### 方式 1：`--debug` 啟動

```bash
java -jar shop-service.jar --debug
# 或
./mvnw spring-boot:run -Dspring-boot.run.arguments=--debug
```

> 注意：`--debug` **不是**開啟 DEBUG 等級的日誌（那是 `logging.level.root=DEBUG`）。
> 它專門開啟「條件評估報告」。

輸出（節錄）：

```
============================
CONDITIONS EVALUATION REPORT
============================


Positive matches:                        ← 生效了的
-----------------

   AopAutoConfiguration matched:
      - @ConditionalOnProperty (spring.aop.auto=true) matched (OnPropertyCondition)

   DataSourceAutoConfiguration matched:
      - @ConditionalOnClass found required classes 'javax.sql.DataSource',
        'org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType' (OnClassCondition)

   DataSourceAutoConfiguration.PooledDataSourceConfiguration matched:
      - AnyNestedCondition 1 matched 2 did not; NestedCondition on
        DataSourceAutoConfiguration.PooledDataSourceCondition.PooledDataSourceAvailable
        PooledDataSource found supported DataSource (DataSourceAutoConfiguration.PooledDataSourceCondition)
      - @ConditionalOnMissingBean (types: javax.sql.DataSource,javax.sql.XADataSource;
        SearchStrategy: all) did not find any beans (OnBeanCondition)


Negative matches:                        ← 沒生效的（★ 排查時看這裡 ★）
-----------------

   RedisAutoConfiguration:
      Did not match:
         - @ConditionalOnClass did not find required class
           'org.springframework.data.redis.core.RedisOperations' (OnClassCondition)

   JmsAutoConfiguration:
      Did not match:
         - @ConditionalOnClass did not find required class 'jakarta.jms.ConnectionFactory'
           (OnClassCondition)

   JacksonAutoConfiguration#jacksonObjectMapper:
      Did not match:
         - @ConditionalOnMissingBean (types: com.fasterxml.jackson.databind.ObjectMapper;
           SearchStrategy: all) found beans of type 'com.fasterxml.jackson.databind.ObjectMapper'
           objectMapper (OnBeanCondition)


Exclusions:                              ← 被明確排除的
-----------

    org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration


Unconditional classes:                   ← 無條件生效的
----------------------

    org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration
```

### 方式 2：Actuator（推薦，可以用 jq 過濾）

```yaml
management:
  endpoints:
    web:
      exposure:
        include: conditions
```

```bash
# 找出某個自動組態為什麼沒生效
$ curl -s localhost:8080/actuator/conditions \
  | jq '.contexts.application.negativeMatches | to_entries[]
        | select(.key | test("Redis"))
        | {name: .key, reasons: [.value.notMatched[].message]}'
{
  "name": "RedisAutoConfiguration",
  "reasons": [
    "@ConditionalOnClass did not find required class 'org.springframework.data.redis.core.RedisOperations'"
  ]
}

# 列出所有生效的自動組態
$ curl -s localhost:8080/actuator/conditions \
  | jq -r '.contexts.application.positiveMatches | keys[]' | grep -v '#' | sort
```

### 排查流程（實務 SOP）

```
症狀：「我加了依賴，但那個功能沒有生效」
  │
  ├─ ① 那個自動組態出現在 negativeMatches 嗎？
  │      └─ 是 → 看 notMatched 的原因（99% 在這裡就找到答案）
  │             ├─ "did not find required class"  → 依賴沒加對，或 scope 錯（provided/test）
  │             ├─ "found beans of type"          → 你自己定義了同型別的 Bean（正常，這是你贏了）
  │             ├─ "did not find property"        → 設定檔少了某個屬性
  │             └─ "did not match required prop"  → 屬性值不對
  │
  ├─ ② 出現在 Exclusions 嗎？
  │      └─ 是 → 查 @SpringBootApplication(exclude=...) 與 spring.autoconfigure.exclude
  │
  ├─ ③ 完全沒出現在報告裡？
  │      └─ 那個類別不在候選清單裡
  │            ├─ jar 沒進 classpath（mvn dependency:tree 確認）
  │            └─ 自訂 starter 的 imports 檔案路徑/檔名錯（見 2.11 的檢查清單）
  │
  └─ ④ 在 positiveMatches 但功能還是沒生效？
         └─ 那就不是自動組態的問題，去查 Bean 有沒有被正確注入（/actuator/beans）
```

> **真實案例**：某團隊加了 `spring-boot-starter-data-redis`，但 `@Cacheable` 完全沒作用。
> 查 `/actuator/conditions` 發現 `RedisCacheConfiguration` 在 negativeMatches，原因是
> `@ConditionalOnBean(CacheAspectSupport.class) did not find any beans`。
>
> 真正的原因是**忘了加 `@EnableCaching`**。
> 條件報告直接指出了「快取機制本身沒開」，而不是 Redis 的問題——省下了半天的瞎猜。

---

## 2.9 覆寫、關閉、調整自動組態

### 手段 1：定義自己的 Bean（最常用）

```java
@Bean
public ObjectMapper objectMapper() { ... }   // 自動組態自動退開
```

### 手段 2：改設定（優先於手段 1）

大部分需求其實只要改 `application.yml`：

```yaml
server:
  port: 9090
  servlet:
    context-path: /api
  tomcat:
    threads:
      max: 200
      min-spare: 10
    max-connections: 8192
    connection-timeout: 20s
spring:
  jackson:
    default-property-inclusion: non_null
  datasource:
    hikari:
      maximum-pool-size: 20
```

> **順序原則：先找設定，找不到才寫 Bean。** 寫 Bean 就等於接管整塊，
> 之後 Spring Boot 版本升級帶來的改良你就享受不到了。

### 手段 3：用 Customizer（介於兩者之間）

```java
package com.example.shop.config;

import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class TomcatConfig {

    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> tomcatCustomizer() {
        return factory -> factory.addConnectorCustomizers(connector -> {
            connector.setProperty("relaxedQueryChars", "[]{}|");   // 允許某些特殊字元
            connector.setMaxPostSize(10 * 1024 * 1024);
        });
    }
}
```

**這個模式的價值**：你只改想改的部分，其他仍由自動組態負責。

### 手段 4：排除自動組態

```java
// 方式 A：註解
@SpringBootApplication(exclude = {
        DataSourceAutoConfiguration.class,
        SecurityAutoConfiguration.class })
public class ShopServiceApplication { }

// 方式 B：用字串（類別不在編譯期 classpath 時）
@SpringBootApplication(excludeName = "org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration")
```

```yaml
# 方式 C：設定檔（更好——不同環境可以排除不同的東西）
spring:
  autoconfigure:
    exclude:
      - org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
      - org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration
```

> **最常見的使用場景**：專案加了 `spring-boot-starter-data-jpa`（因為某個模組需要），
> 但這個服務本身不連資料庫，啟動時就報：
>
> ```
> Failed to configure a DataSource: 'url' attribute is not specified and no embedded
> datasource could be configured.
> ```
>
> 解法就是排除 `DataSourceAutoConfiguration`。
> 但**更好的解法是「不要加那個依賴」**——排除自動組態通常是在治標。

### 手段 5：全部關掉（幾乎不會用）

```properties
spring.boot.enableautoconfiguration=false
```

---

## 2.10 動手寫一個 starter

現在把觀念變成產出。

### 需求（來自真實場景）

公司有六個 Spring Boot 服務，每個都需要**操作稽核**：
「誰、在什麼時候、對哪個資源、做了什麼動作、結果如何」。

現況是每個團隊各寫一份，格式都不一樣，出事時要對六種 log 格式。

目標：做一個 `audit-spring-boot-starter`，讓各服務**加一行依賴 + 幾行設定**就有一致的稽核能力，
而且可以選擇輸出到 log 或資料庫。

### 專案結構

```
audit-spring-boot/                        父專案（pom packaging）
├── pom.xml
├── audit-core/                           核心 API 與實作（沒有 Spring 依賴）
│   ├── pom.xml
│   └── src/main/java/com/example/audit/
│       ├── AuditEvent.java
│       ├── AuditRecorder.java            介面
│       ├── LoggingAuditRecorder.java     實作 1
│       └── JdbcAuditRecorder.java        實作 2
├── audit-spring-boot-autoconfigure/      自動組態
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/example/audit/autoconfigure/
│       │   ├── AuditProperties.java
│       │   └── AuditAutoConfiguration.java
│       └── resources/META-INF/spring/
│           └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
└── audit-spring-boot-starter/            只有 pom
    └── pom.xml
```

> **為什麼要拆三個模組？**
> - `audit-core`：純業務邏輯，**不依賴 Spring**。別人用 Quarkus / 純 Java 也能用。
> - `autoconfigure`：Spring 整合層。
> - `starter`：使用者的入口，只宣告依賴。
>
> 小專案可以合併成兩個（`autoconfigure` + `starter`），但**不要合併成一個**——
> 因為那樣使用者就無法「只要 core 不要自動組態」。

### 父 pom

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>audit-spring-boot</artifactId>
    <version>1.0.0</version>
    <packaging>pom</packaging>

    <modules>
        <module>audit-core</module>
        <module>audit-spring-boot-autoconfigure</module>
        <module>audit-spring-boot-starter</module>
    </modules>

    <properties>
        <java.version>21</java.version>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <spring-boot.version>3.5.0</spring-boot.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <!-- 用 BOM 而不是 parent：starter 專案不該繼承 Spring Boot 的 parent，
                 因為 parent 帶有 repackage 等「應用程式專用」的設定 -->
            <dependency>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-dependencies</artifactId>
                <version>${spring-boot.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>
</project>
```

### `audit-core`

```xml
<!-- audit-core/pom.xml -->
<project xmlns="http://maven.apache.org/POM/4.0.0" ...>
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>com.example</groupId>
        <artifactId>audit-spring-boot</artifactId>
        <version>1.0.0</version>
    </parent>
    <artifactId>audit-core</artifactId>

    <dependencies>
        <!-- 只依賴日誌門面與 JDBC API，不依賴 Spring -->
        <dependency>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-api</artifactId>
        </dependency>
    </dependencies>
</project>
```

```java
package com.example.audit;

import java.time.Instant;
import java.util.Map;

/**
 * 一筆稽核事件。用 record 表示不可變值物件。
 *
 * @param timestamp 發生時間
 * @param actor     操作者（使用者帳號 / 系統名稱）
 * @param action    動作（CREATE_ORDER / CANCEL_ORDER / LOGIN ...）
 * @param resource  被操作的資源（order:1001 / user:42）
 * @param outcome   結果
 * @param details   額外資訊（金額、IP、原因）
 */
public record AuditEvent(Instant timestamp,
                         String actor,
                         String action,
                         String resource,
                         Outcome outcome,
                         Map<String, Object> details) {

    public enum Outcome { SUCCESS, FAILURE, DENIED }

    public AuditEvent {
        if (action == null || action.isBlank()) {
            throw new IllegalArgumentException("action 不可為空");
        }
        details = details == null ? Map.of() : Map.copyOf(details);   // 防禦性拷貝
    }

    public static AuditEvent success(String actor, String action, String resource) {
        return new AuditEvent(Instant.now(), actor, action, resource, Outcome.SUCCESS, Map.of());
    }

    public static AuditEvent failure(String actor, String action, String resource, String reason) {
        return new AuditEvent(Instant.now(), actor, action, resource, Outcome.FAILURE,
                Map.of("reason", reason));
    }
}
```

```java
package com.example.audit;

/** 稽核紀錄的輸出目的地。 */
public interface AuditRecorder {
    void record(AuditEvent event);
}
```

```java
package com.example.audit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.stream.Collectors;

/** 輸出到日誌。預設實作，不需要任何外部相依。 */
public class LoggingAuditRecorder implements AuditRecorder {

    private final Logger log;

    public LoggingAuditRecorder(String loggerName) {
        this.log = LoggerFactory.getLogger(loggerName);
    }

    @Override
    public void record(AuditEvent event) {
        String details = event.details().entrySet().stream()
                .map(e -> e.getKey() + "=" + e.getValue())
                .collect(Collectors.joining(" "));

        log.info("AUDIT ts={} actor={} action={} resource={} outcome={} {}",
                event.timestamp(), event.actor(), event.action(),
                event.resource(), event.outcome(), details);
    }
}
```

```java
package com.example.audit;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;

/** 輸出到資料庫。需要一張 audit_log 表。 */
public class JdbcAuditRecorder implements AuditRecorder {

    private static final String INSERT_SQL = """
            INSERT INTO audit_log (occurred_at, actor, action, resource, outcome, details)
            VALUES (?, ?, ?, ?, ?, ?)
            """;

    private final DataSource dataSource;

    public JdbcAuditRecorder(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Override
    public void record(AuditEvent event) {
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(INSERT_SQL)) {

            ps.setTimestamp(1, Timestamp.from(event.timestamp()));
            ps.setString(2, event.actor());
            ps.setString(3, event.action());
            ps.setString(4, event.resource());
            ps.setString(5, event.outcome().name());
            ps.setString(6, event.details().toString());
            ps.executeUpdate();

        } catch (SQLException e) {
            // 稽核失敗不應該讓業務流程失敗 —— 這是重要的設計決定
            throw new AuditException("寫入稽核紀錄失敗", e);
        }
    }

    public static class AuditException extends RuntimeException {
        public AuditException(String message, Throwable cause) { super(message, cause); }
    }
}
```

### `audit-spring-boot-autoconfigure`

```xml
<!-- audit-spring-boot-autoconfigure/pom.xml -->
<project ...>
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>com.example</groupId>
        <artifactId>audit-spring-boot</artifactId>
        <version>1.0.0</version>
    </parent>
    <artifactId>audit-spring-boot-autoconfigure</artifactId>

    <dependencies>
        <dependency>
            <groupId>com.example</groupId>
            <artifactId>audit-core</artifactId>
            <version>${project.version}</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-autoconfigure</artifactId>
        </dependency>

        <!-- ★ 產生 spring-configuration-metadata.json，讓 IDE 有設定自動完成 ★ -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-configuration-processor</artifactId>
            <optional>true</optional>
        </dependency>

        <!-- optional：使用者「可能」會有 JDBC，但不強制 -->
        <dependency>
            <groupId>org.springframework</groupId>
            <artifactId>spring-jdbc</artifactId>
            <optional>true</optional>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>com.h2database</groupId>
            <artifactId>h2</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>
</project>
```

> **`<optional>true</optional>` 是 starter 開發的關鍵技巧**：
> 它讓 `spring-jdbc` 出現在**編譯期**（讓你可以寫 `@ConditionalOnClass(DataSource.class)`），
> 但**不會傳遞給使用者**。使用者如果沒有 JDBC，`@ConditionalOnClass` 就不成立，那段組態不生效。
>
> 如果不加 `optional`，使用者只要加你的 starter 就被迫拉進 JDBC——這就是「重依賴 starter」的來源。

```java
package com.example.audit.autoconfigure;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 稽核設定。對應 application.yml 的 shop.audit.*
 */
@ConfigurationProperties(prefix = "shop.audit")
public class AuditProperties {

    /** 是否啟用稽核。 */
    private boolean enabled = true;

    /** 輸出目的地。 */
    private Target target = Target.LOG;

    /** 使用 LOG 目的地時的 logger 名稱。 */
    private String loggerName = "AUDIT";

    /** 不需要稽核的動作（例如健康檢查）。 */
    private java.util.Set<String> excludedActions = java.util.Set.of();

    public enum Target {
        /** 寫到日誌 */
        LOG,
        /** 寫到資料庫的 audit_log 表 */
        JDBC
    }

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public Target getTarget() { return target; }
    public void setTarget(Target target) { this.target = target; }

    public String getLoggerName() { return loggerName; }
    public void setLoggerName(String loggerName) { this.loggerName = loggerName; }

    public java.util.Set<String> getExcludedActions() { return excludedActions; }
    public void setExcludedActions(java.util.Set<String> excludedActions) {
        this.excludedActions = excludedActions;
    }
}
```

> **注意每個欄位上方的 Javadoc 註解**——`spring-boot-configuration-processor`
> 會把它抓進 `spring-configuration-metadata.json`，變成 IDE 裡的**設定說明提示**。
> 這是免費的文件，一定要寫。

```java
package com.example.audit.autoconfigure;

import com.example.audit.AuditRecorder;
import com.example.audit.JdbcAuditRecorder;
import com.example.audit.LoggingAuditRecorder;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

@AutoConfiguration(after = DataSourceAutoConfiguration.class)   // ① 確保 DataSource 已註冊
@ConditionalOnProperty(prefix = "shop.audit", name = "enabled",
        havingValue = "true", matchIfMissing = true)            // ② 預設啟用，可關掉
@EnableConfigurationProperties(AuditProperties.class)           // ③ 綁定設定
public class AuditAutoConfiguration {

    @Configuration(proxyBeanMethods = false)                    // ④ lite 模式
    @ConditionalOnProperty(prefix = "shop.audit", name = "target",
            havingValue = "LOG", matchIfMissing = true)
    static class LoggingRecorderConfiguration {

        @Bean
        @ConditionalOnMissingBean(AuditRecorder.class)          // ⑤ 使用者自己定義就退開
        AuditRecorder loggingAuditRecorder(AuditProperties properties) {
            return new LoggingAuditRecorder(properties.getLoggerName());
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(DataSource.class)                       // ⑥ 有 JDBC 才可能
    @ConditionalOnProperty(prefix = "shop.audit", name = "target", havingValue = "JDBC")
    static class JdbcRecorderConfiguration {

        @Bean
        @ConditionalOnBean(DataSource.class)                    // ⑦ 真的有 DataSource Bean
        @ConditionalOnMissingBean(AuditRecorder.class)
        AuditRecorder jdbcAuditRecorder(DataSource dataSource) {
            return new JdbcAuditRecorder(dataSource);
        }
    }
}
```

**逐點說明：**

| # | 為什麼要這樣寫 |
|---|---|
| ① | `@ConditionalOnBean(DataSource.class)`（⑦）要成立，`DataSource` 必須先註冊。不宣告 `after` 就是碰運氣 |
| ② | 讓使用者可以一鍵關閉整組功能（`shop.audit.enabled=false`）。`matchIfMissing=true` 表示預設開啟 |
| ③ | 這一行才會讓 `AuditProperties` 進容器並完成綁定 |
| ④ | 自動組態一律用 lite 模式，避免產生 CGLIB 代理拖慢啟動 |
| ⑤ | **starter 的黃金規則**：所有 `@Bean` 都要有 `@ConditionalOnMissingBean`，使用者永遠能覆寫 |
| ⑥ | `@ConditionalOnClass` 用來擋「classpath 根本沒有 JDBC」的情況，這一步很快（讀 metadata 索引） |
| ⑦ | `@ConditionalOnBean` 擋「有 JDBC 類別但沒設定 DataSource」的情況 |

> **⑥ 和 ⑦ 為什麼都要？**
> - 沒有 ⑥：使用者沒有 JDBC 時，`JdbcAuditRecorder` 這個類別的方法簽章裡有 `DataSource`，
>   載入這個組態類別時會 `NoClassDefFoundError`。
> - 沒有 ⑦：使用者有 JDBC jar 但沒設定資料庫，`@Bean` 方法需要注入 `DataSource` 會失敗。
>
> **兩層防護：先擋類別，再擋 Bean。** 這是 Spring Boot 官方自動組態的標準寫法。

### 註冊清單（最容易寫錯的檔案）

`audit-spring-boot-autoconfigure/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`

```
com.example.audit.autoconfigure.AuditAutoConfiguration
```

**這個檔名超級長，而且錯一個字元就完全不會生效、也不會報錯。** 檢查清單：

```
✅ 路徑是 META-INF/spring/       （不是 META-INF/ 也不是 META-INF/springframework/）
✅ 檔名是 org.springframework.boot.autoconfigure.AutoConfiguration.imports
✅ 放在 src/main/resources/ 底下（不是 src/main/java/）
✅ 內容是類別的「全名」，一行一個
✅ 沒有多餘的空白或 BOM
```

驗證方法（打包後直接看 jar）：

```bash
$ ./mvnw clean package -pl audit-spring-boot-autoconfigure
$ unzip -l audit-spring-boot-autoconfigure/target/audit-spring-boot-autoconfigure-1.0.0.jar \
    | grep imports
      52  2026-08-18 11:30   META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports

$ unzip -p audit-spring-boot-autoconfigure/target/audit-spring-boot-autoconfigure-1.0.0.jar \
    META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.audit.autoconfigure.AuditAutoConfiguration
```

### `audit-spring-boot-starter`（只有 pom）

```xml
<project ...>
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>com.example</groupId>
        <artifactId>audit-spring-boot</artifactId>
        <version>1.0.0</version>
    </parent>
    <artifactId>audit-spring-boot-starter</artifactId>
    <packaging>jar</packaging>

    <dependencies>
        <dependency>
            <groupId>com.example</groupId>
            <artifactId>audit-spring-boot-autoconfigure</artifactId>
            <version>${project.version}</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
        </dependency>
    </dependencies>
</project>
```

### 使用方（一個普通的 Spring Boot 服務）

```xml
<dependency>
    <groupId>com.example</groupId>
    <artifactId>audit-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

```yaml
# application.yml — 什麼都不寫也能用（預設輸出到 log）
shop:
  audit:
    target: JDBC              # 想改成寫資料庫就加這行
    excluded-actions:
      - HEALTH_CHECK
```

```java
package com.example.shop.order;

import com.example.audit.AuditEvent;
import com.example.audit.AuditRecorder;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

@Service
public class OrderService {

    private final AuditRecorder auditRecorder;     // ← 直接注入，不用寫任何設定

    public OrderService(AuditRecorder auditRecorder) {
        this.auditRecorder = auditRecorder;
    }

    public void cancelOrder(long orderId, String operator, String reason) {
        // ... 取消訂單的業務邏輯 ...

        auditRecorder.record(new AuditEvent(
                java.time.Instant.now(),
                operator,
                "CANCEL_ORDER",
                "order:" + orderId,
                AuditEvent.Outcome.SUCCESS,
                java.util.Map.of("reason", reason)));
    }
}
```

輸出：

```
2026-08-18T11:45:22.104+08:00  INFO --- [http-nio-8080-exec-1] AUDIT :
  AUDIT ts=2026-08-18T03:45:22.101Z actor=admin@example.com action=CANCEL_ORDER
  resource=order:1001 outcome=SUCCESS reason=客戶要求
```

**六個服務的稽核格式從此一致，而且各團隊只要加一行依賴。**

---

## 2.11 給 starter 加上設定提示

使用者在 `application.yml` 打 `shop.audit.` 時，IDE 應該要跳出自動完成。這需要 metadata。

### 自動產生（靠 annotation processor）

前面的 pom 已經加了：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-configuration-processor</artifactId>
    <optional>true</optional>
</dependency>
```

編譯後會產生 `target/classes/META-INF/spring-configuration-metadata.json`：

```json
{
  "groups": [
    {
      "name": "shop.audit",
      "type": "com.example.audit.autoconfigure.AuditProperties",
      "sourceType": "com.example.audit.autoconfigure.AuditProperties"
    }
  ],
  "properties": [
    {
      "name": "shop.audit.enabled",
      "type": "java.lang.Boolean",
      "description": "是否啟用稽核。",
      "sourceType": "com.example.audit.autoconfigure.AuditProperties",
      "defaultValue": true
    },
    {
      "name": "shop.audit.target",
      "type": "com.example.audit.autoconfigure.AuditProperties$Target",
      "description": "輸出目的地。",
      "sourceType": "com.example.audit.autoconfigure.AuditProperties"
    },
    {
      "name": "shop.audit.logger-name",
      "type": "java.lang.String",
      "description": "使用 LOG 目的地時的 logger 名稱。",
      "sourceType": "com.example.audit.autoconfigure.AuditProperties",
      "defaultValue": "AUDIT"
    }
  ],
  "hints": []
}
```

> ⚠️ **IntelliJ 常見問題**：加了 processor 但 IDE 沒有提示。
> 檢查 `Settings → Build → Compiler → Annotation Processors → Enable annotation processing` 有沒有勾。
> 另外 Lombok 與 configuration-processor 併用時，順序有時會出問題，
> 這時要在 `maven-compiler-plugin` 明確指定 `annotationProcessorPaths`。

### 手動補充提示（`additional-spring-configuration-metadata.json`）

有些提示 processor 產不出來（例如「這個字串欄位的合法值有哪些」）。
放在 `src/main/resources/META-INF/additional-spring-configuration-metadata.json`：

```json
{
  "hints": [
    {
      "name": "shop.audit.target",
      "values": [
        { "value": "LOG",  "description": "輸出到應用程式日誌，不需額外基礎設施。" },
        { "value": "JDBC", "description": "寫入資料庫 audit_log 表，需要先建表與設定 DataSource。" }
      ]
    },
    {
      "name": "shop.audit.excluded-actions",
      "values": [
        { "value": "HEALTH_CHECK" },
        { "value": "METRICS_SCRAPE" }
      ],
      "providers": [ { "name": "any" } ]
    }
  ],
  "properties": [
    {
      "name": "shop.audit.legacy-format",
      "type": "java.lang.Boolean",
      "description": "使用 1.0 版的舊格式輸出。",
      "deprecation": {
        "level": "warning",
        "reason": "舊格式無法結構化查詢。",
        "replacement": "shop.audit.target"
      }
    }
  ]
}
```

**`deprecation` 特別有用**：使用者用到廢棄屬性時，IDE 會劃刪除線，啟動時也會有警告。
這讓 starter 的演進不會直接打斷使用方。

---

## 2.12 測試自動組態：`ApplicationContextRunner`

自動組態的測試很特別——你要驗證的是「**在不同 classpath 與設定組合下，Bean 有沒有正確出現**」。
用 `@SpringBootTest` 做不到（它只能測一種組合）。

Spring Boot 提供了 `ApplicationContextRunner`：

```java
package com.example.audit.autoconfigure;

import com.example.audit.AuditRecorder;
import com.example.audit.JdbcAuditRecorder;
import com.example.audit.LoggingAuditRecorder;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

import static org.assertj.core.api.Assertions.assertThat;

class AuditAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AuditAutoConfiguration.class));

    @Test
    void 預設應建立日誌版稽核器() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(AuditRecorder.class);
            assertThat(context.getBean(AuditRecorder.class))
                    .isInstanceOf(LoggingAuditRecorder.class);
        });
    }

    @Test
    void 停用時不應建立任何稽核器() {
        runner.withPropertyValues("shop.audit.enabled=false")
              .run(context -> assertThat(context).doesNotHaveBean(AuditRecorder.class));
    }

    @Test
    void 指定JDBC目的地且有DataSource時應建立JDBC版() {
        runner.withConfiguration(AutoConfigurations.of(DataSourceAutoConfiguration.class))
              .withPropertyValues(
                      "shop.audit.target=JDBC",
                      "spring.datasource.url=jdbc:h2:mem:audit-test",
                      "spring.datasource.driver-class-name=org.h2.Driver")
              .run(context -> {
                  assertThat(context).hasSingleBean(AuditRecorder.class);
                  assertThat(context.getBean(AuditRecorder.class))
                          .isInstanceOf(JdbcAuditRecorder.class);
              });
    }

    @Test
    void 指定JDBC但沒有DataSource時不應建立稽核器() {
        runner.withPropertyValues("shop.audit.target=JDBC")
              .run(context -> {
                  // JdbcRecorderConfiguration 的 @ConditionalOnBean(DataSource) 不成立
                  // LoggingRecorderConfiguration 的 target=LOG 條件也不成立
                  assertThat(context).doesNotHaveBean(AuditRecorder.class);
              });
    }

    @Test
    void classpath沒有DataSource類別時應正常啟動() {
        // ★ FilteredClassLoader 模擬「使用者專案沒有 spring-jdbc」的情境 ★
        runner.withClassLoader(new FilteredClassLoader(DataSource.class))
              .withPropertyValues("shop.audit.target=JDBC")
              .run(context -> {
                  assertThat(context).hasNotFailed();     // 不能因為缺少類別就啟動失敗
                  assertThat(context).doesNotHaveBean(AuditRecorder.class);
              });
    }

    @Test
    void 使用者自訂的稽核器應覆寫自動組態() {
        runner.withUserConfiguration(CustomRecorderConfig.class)
              .run(context -> {
                  assertThat(context).hasSingleBean(AuditRecorder.class);
                  assertThat(context.getBean(AuditRecorder.class))
                          .isInstanceOf(CustomRecorder.class);
              });
    }

    @Test
    void 應正確綁定設定屬性() {
        runner.withPropertyValues(
                      "shop.audit.logger-name=MY_AUDIT",
                      "shop.audit.excluded-actions=HEALTH_CHECK,PING")
              .run(context -> {
                  AuditProperties props = context.getBean(AuditProperties.class);
                  assertThat(props.getLoggerName()).isEqualTo("MY_AUDIT");
                  assertThat(props.getExcludedActions()).containsExactlyInAnyOrder("HEALTH_CHECK", "PING");
              });
    }

    // ── 測試用的自訂實作 ──
    static class CustomRecorder implements AuditRecorder {
        @Override public void record(com.example.audit.AuditEvent event) { }
    }

    @Configuration(proxyBeanMethods = false)
    static class CustomRecorderConfig {
        @Bean
        AuditRecorder customRecorder() { return new CustomRecorder(); }
    }
}
```

**`ApplicationContextRunner` 的關鍵能力：**

| 方法 | 用途 |
|---|---|
| `withConfiguration(AutoConfigurations.of(...))` | 載入指定的自動組態 |
| `withUserConfiguration(...)` | 模擬「使用者自己定義的 Bean」 |
| `withPropertyValues(...)` | 設定屬性 |
| `withClassLoader(new FilteredClassLoader(X.class))` | **模擬 classpath 上沒有 X**，測 `@ConditionalOnClass` |
| `withBean(...)` | 直接放一個 Bean 進去 |
| `run(context -> {...})` | 執行並斷言 |

斷言用的 `assertThat(context)` 有專屬方法：

```java
assertThat(context).hasSingleBean(X.class);
assertThat(context).doesNotHaveBean(X.class);
assertThat(context).hasBean("beanName");
assertThat(context).hasNotFailed();
assertThat(context).hasFailed();
assertThat(context).getFailure().hasMessageContaining("...");
```

> **這種測試跑得極快**（每個 case 幾十毫秒），因為它只建立一個最小的 context。
> **寫 starter 一定要寫這種測試**——特別是 `FilteredClassLoader` 那一種，
> 因為「使用者的 classpath 跟你的不一樣」正是 starter 最容易出事的地方。

Web 應用的自動組態要用對應的 runner：

```java
new WebApplicationContextRunner()          // Servlet
new ReactiveWebApplicationContextRunner()  // WebFlux
```

---

## 2.13 常見錯誤

### ① 自動組態完全沒生效，也沒有錯誤訊息

**最常見的原因（依機率排序）：**

1. `AutoConfiguration.imports` 檔案的路徑或檔名錯了。
2. 檔案放在 `src/main/java/` 而不是 `src/main/resources/`。
3. Boot 2 遷移到 Boot 3，只有舊的 `spring.factories`。
4. 自動組態類別本身被 `@ComponentScan` 掃到了（見下方 ②）。

```bash
# 驗證：打包後直接檢查 jar
unzip -p your-autoconfigure.jar META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

### ② 自動組態類別放在使用者的掃描範圍內

```
com.example.shop                  ← 使用者的主類別
├── audit
│   └── AuditAutoConfiguration    ← ❌ 會被 @ComponentScan 掃到！
```

**後果**：它會被當成一般的 `@Configuration` **提早**處理，
於是 `@ConditionalOnMissingBean` 在「使用者的 Bean 還沒註冊」時就評估了 → 結果不可預期。

Spring Boot 其實有防護（`@SpringBootApplication` 的 `AutoConfigurationExcludeFilter` 會排除
「同時是 `@Configuration` 又出現在 imports 清單裡」的類別），但**依賴這個防護不是好習慣**。

> **規則：自動組態類別的套件，永遠不要跟使用者的程式碼重疊。**
> 用獨立的 groupId / 套件（如 `com.example.audit.autoconfigure`）。

### ③ 忘了 `@ConditionalOnMissingBean`

```java
@Bean
public AuditRecorder auditRecorder() {     // ❌ 使用者無法覆寫
    return new LoggingAuditRecorder("AUDIT");
}
```

使用者定義自己的 `AuditRecorder` 時會變成「兩個 Bean」，注入直接爆炸。
**starter 的每一個 `@Bean` 都要能被覆寫。**

### ④ `@ConditionalOnBean` 用在一般 `@Configuration` 上

```java
@Configuration                              // ❌ 不是 @AutoConfiguration
public class MyConfig {
    @Bean
    @ConditionalOnBean(DataSource.class)    // 評估時 DataSource 還沒註冊 → 永遠是 false
    public MyRepo myRepo(DataSource ds) { return new MyRepo(ds); }
}
```

### ⑤ starter 把依賴全部塞成必要依賴

```xml
<!-- ❌ 使用者只想要 log 版，卻被迫拉進 JDBC、Redis、Kafka -->
<dependency>
    <groupId>org.springframework</groupId>
    <artifactId>spring-jdbc</artifactId>
</dependency>
```

**加 `<optional>true</optional>`**，讓使用者自己決定要不要。

### ⑥ 命名不符慣例

```
❌ spring-boot-starter-audit      （占用 Spring 官方命名空間）
✅ audit-spring-boot-starter
```

### ⑦ 沒有處理「使用者只想要部分功能」

好的 starter 應該讓每個功能都可以獨立開關：

```yaml
shop:
  audit:
    enabled: true
    target: LOG
    # 未來加新功能時，也各給一個開關
```

---

## 2.14 本章練習

### 練習 1：條件註解判讀

以下自動組態，在四種情境下分別會註冊哪些 Bean？

```java
@AutoConfiguration
@ConditionalOnClass(RedisTemplate.class)
@EnableConfigurationProperties(CacheProperties.class)
public class MyCacheAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public CacheManager cacheManager(CacheProperties props) {
        return new SimpleCacheManager();
    }

    @Bean
    @ConditionalOnProperty(name = "shop.cache.stats", havingValue = "true")
    public CacheStatsCollector statsCollector() {
        return new CacheStatsCollector();
    }

    @Bean
    @ConditionalOnBean(CacheManager.class)
    @ConditionalOnMissingBean
    public CacheWarmer cacheWarmer(CacheManager manager) {
        return new CacheWarmer(manager);
    }
}
```

情境：
- **A**：classpath 沒有 Redis，沒有任何設定。
- **B**：有 Redis，沒有設定。
- **C**：有 Redis，`shop.cache.stats=true`。
- **D**：有 Redis，使用者自己定義了 `@Bean CacheManager myCacheManager()`。

<details>
<summary>參考解答</summary>

| 情境 | `cacheManager` | `statsCollector` | `cacheWarmer` | 說明 |
|---|---|---|---|---|
| **A** | ❌ | ❌ | ❌ | 類別層級的 `@ConditionalOnClass(RedisTemplate)` 不成立 → **整個組態類別跳過**，裡面的 `@Bean` 完全不評估 |
| **B** | ✅ | ❌ | ✅ | `statsCollector` 少了 `shop.cache.stats=true`（沒有 `matchIfMissing`，預設 false） |
| **C** | ✅ | ✅ | ✅ | 三個都成立 |
| **D** | ❌ | ❌ | ✅ | `cacheManager` 被使用者的 Bean 擋下；`cacheWarmer` 的 `@ConditionalOnBean(CacheManager)` **仍然成立**（使用者的 `myCacheManager` 就是一個 `CacheManager`），且沒有現成的 `CacheWarmer`，所以照樣建立，並注入使用者的 CacheManager |

**兩個重點：**

1. **類別層級的條件不成立 → 整組跳過**，這是最快的短路，也是 `@ConditionalOnClass`
   放在類別上而不是每個方法上的原因。
2. **情境 D 展示了 `@ConditionalOnBean` 的正確用途**：它問的是「容器裡有沒有這個型別」，
   不管那個 Bean 是自動組態建的還是使用者建的。這正是 `cacheWarmer` 想要的行為——
   有快取管理員就預熱，不管是誰提供的。

**但情境 D 也有隱藏風險**：`cacheWarmer` 的 `@ConditionalOnBean` 能不能成立，
取決於使用者的 `myCacheManager` 有沒有在這個自動組態評估**之前**註冊。
因為使用者的 `@Configuration` 一定比自動組態早處理，所以這裡是安全的。
但如果使用者的 `CacheManager` 也是來自另一個自動組態，就要靠 `@AutoConfiguration(after=...)` 保證。

</details>

### 練習 2：修正一個壞掉的 starter

以下 starter 有五個問題，找出來並修正。

```java
// 檔案：src/main/java/com/example/shop/notify/NotifyAutoConfiguration.java
package com.example.shop.notify;

@Configuration
@ConditionalOnBean(RestTemplate.class)
public class NotifyAutoConfiguration {

    @Bean
    public NotifyProperties notifyProperties() {
        return new NotifyProperties();
    }

    @Bean
    public SmsNotifier notifier(RestTemplate restTemplate, NotifyProperties props) {
        return new SmsNotifier(restTemplate, props.getApiKey());
    }
}
```

```
// 檔案：src/main/resources/META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
com.example.shop.notify.NotifyAutoConfiguration
```

<details>
<summary>參考解答</summary>

**五個問題：**

| # | 問題 | 後果 |
|---|---|---|
| 1 | 用 `spring.factories` 註冊自動組態 | **Boot 3 完全不讀**，自動組態靜靜失效 |
| 2 | 用 `@Configuration` 而不是 `@AutoConfiguration` | 沒有 `before/after` 排序能力，語意也不對 |
| 3 | 類別層級用 `@ConditionalOnBean` | 評估時機太早，`RestTemplate` 通常還沒註冊 → 永遠 false |
| 4 | 手動 `@Bean NotifyProperties` | 沒有 relaxed binding、沒有驗證、沒有 metadata。應該用 `@EnableConfigurationProperties` |
| 5 | `@Bean` 沒有 `@ConditionalOnMissingBean`，且回傳具體類別 `SmsNotifier` | 使用者無法覆寫；且如果使用者定義了 `Notifier` 介面的其他實作，會變成兩個 Bean |

**另外還有一個結構問題**：套件 `com.example.shop.notify` 跟使用者的應用程式套件重疊，
很可能被 `@ComponentScan` 掃到（見 2.13 ②）。

**修正版：**

```java
// 檔案：src/main/java/com/example/notify/autoconfigure/NotifyProperties.java
package com.example.notify.autoconfigure;         // ← 獨立套件

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

@ConfigurationProperties(prefix = "shop.notify")
public class NotifyProperties {

    /** 是否啟用簡訊通知。 */
    private boolean enabled = true;

    /** 簡訊供應商 API 金鑰。 */
    private String apiKey;

    /** 呼叫供應商 API 的逾時時間。 */
    private Duration timeout = Duration.ofSeconds(5);

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }
    public Duration getTimeout() { return timeout; }
    public void setTimeout(Duration timeout) { this.timeout = timeout; }
}
```

```java
// 檔案：src/main/java/com/example/notify/autoconfigure/NotifyAutoConfiguration.java
package com.example.notify.autoconfigure;

import com.example.notify.Notifier;
import com.example.notify.SmsNotifier;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.web.client.RestTemplateAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.web.client.RestTemplate;

@AutoConfiguration(after = RestTemplateAutoConfiguration.class)   // ② + ③ 修正
@ConditionalOnClass(RestTemplate.class)                           // ③ 改成 OnClass
@ConditionalOnProperty(prefix = "shop.notify", name = "enabled",
        havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(NotifyProperties.class)            // ④ 修正
public class NotifyAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean                                     // ⑤ 修正
    public Notifier smsNotifier(RestTemplateBuilder builder,      // 回傳介面型別
                                NotifyProperties props) {
        RestTemplate restTemplate = builder
                .connectTimeout(props.getTimeout())
                .readTimeout(props.getTimeout())
                .build();
        return new SmsNotifier(restTemplate, props.getApiKey());
    }
}
```

```
// 檔案：src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.notify.autoconfigure.NotifyAutoConfiguration
```

**注意修正 ③ 的思路轉換**：原本想表達的是「有 `RestTemplate` 才啟用」，
但用 `@ConditionalOnBean` 是錯的工具。正確做法有兩種：

- **`@ConditionalOnClass(RestTemplate.class)`**：classpath 有 spring-web 就啟用（上面的做法）。
- 用 `RestTemplateBuilder` 自己建一個，而不是要求使用者提供 `RestTemplate` Bean。
  **這其實是更好的設計**——因為你可以設定自己需要的逾時，不會受使用者的全域設定影響。

</details>

### 練習 3：讀條件報告

服務啟動後 `@Cacheable` 沒作用。`/actuator/conditions` 的 negativeMatches 有這些：

```json
{
  "CacheAutoConfiguration": {
    "notMatched": [
      { "condition": "OnBeanCondition",
        "message": "@ConditionalOnBean (types: org.springframework.cache.interceptor.CacheAspectSupport; SearchStrategy: all) did not find any beans of type org.springframework.cache.interceptor.CacheAspectSupport" }
      ],
    "matched": [
      { "condition": "OnClassCondition",
        "message": "@ConditionalOnClass found required class 'org.springframework.cache.CacheManager'" }
      ]
  },
  "RedisAutoConfiguration#redisTemplate": {
    "notMatched": [
      { "condition": "OnBeanCondition",
        "message": "@ConditionalOnMissingBean (types: org.springframework.data.redis.core.RedisTemplate; SearchStrategy: all) found beans of type 'org.springframework.data.redis.core.RedisTemplate' myRedisTemplate" }
    ]
  }
}
```

診斷這兩筆分別代表什麼，哪一筆是問題所在。

<details>
<summary>參考解答</summary>

**第一筆是問題，第二筆是正常的。**

**第一筆：`CacheAutoConfiguration` 沒生效**

- `OnClassCondition` **成立**（有 `CacheManager` 類別，代表 spring-context-support 之類的依賴有進來）。
- `OnBeanCondition` **不成立**：找不到 `CacheAspectSupport` 型別的 Bean。

`CacheAspectSupport` 是「快取切面」的基礎類別，它由 **`@EnableCaching`** 註冊。
所以真正的原因是：**主類別上忘了加 `@EnableCaching`**。

```java
@SpringBootApplication
@EnableCaching                    // ← 少了這一行
public class ShopServiceApplication { }
```

**第二筆：`RedisAutoConfiguration#redisTemplate` 沒生效**

訊息是 `@ConditionalOnMissingBean ... found beans of type RedisTemplate 'myRedisTemplate'`。

翻譯：**「因為你自己定義了一個叫 `myRedisTemplate` 的 `RedisTemplate`，所以我不建了。」**

**這是正確且預期的行為**（回頭看 2.7：你的 Bean 一定贏），不是問題。

---

**這題想傳達的判讀技巧：**

看到 negativeMatches 不要一律當成錯誤。分成兩類：

| 訊息型態 | 意義 |
|---|---|
| `found beans of type X` | ✅ 正常——你自己提供了，框架讓位 |
| `did not find required class` | ⚠️ 依賴問題——jar 沒進 classpath |
| `did not find any beans of type X` | ⚠️ 通常是「某個 `@EnableXxx` 忘了加」或順序問題 |
| `did not find property` / `did not match` | ⚠️ 設定檔問題 |

**`did not find any beans of type XxxAspectSupport` 這種訊息，八成是忘了 `@EnableXxx`。**
常見的有：`@EnableCaching`、`@EnableAsync`、`@EnableScheduling`、`@EnableTransactionManagement`
（最後這個 Spring Boot 已自動開啟，不用手動加）。

</details>

### 練習 4：動手寫 starter

寫一個 `ratelimit-spring-boot-starter`，需求：

1. 提供 `RateLimiter` 介面：`boolean tryAcquire(String key)`。
2. 預設實作用記憶體（`ConcurrentHashMap` + 令牌桶）。
3. 設定：`shop.ratelimit.enabled`（預設 true）、`shop.ratelimit.permits-per-second`（預設 10）、
   `shop.ratelimit.burst`（預設 20）。
4. 使用者可以自己提供 `RateLimiter` 覆寫。
5. 寫 `ApplicationContextRunner` 測試，至少涵蓋：預設值、停用、覆寫、自訂速率四種情境。

<details>
<summary>參考解答</summary>

```java
// ratelimit-core/src/main/java/com/example/ratelimit/RateLimiter.java
package com.example.ratelimit;

public interface RateLimiter {
    /**
     * 嘗試取得一個許可。
     *
     * @param key 限流的維度（使用者 ID、IP、API 路徑）
     * @return true 表示允許通過，false 表示超過速率
     */
    boolean tryAcquire(String key);
}
```

```java
// ratelimit-core/src/main/java/com/example/ratelimit/InMemoryTokenBucketRateLimiter.java
package com.example.ratelimit;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 記憶體版令牌桶。
 *
 * <p>注意：這是單機版，多台實例各自計算。要做全域限流請改用 Redis 實作。
 */
public class InMemoryTokenBucketRateLimiter implements RateLimiter {

    private final double permitsPerSecond;
    private final double burst;
    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

    public InMemoryTokenBucketRateLimiter(double permitsPerSecond, double burst) {
        if (permitsPerSecond <= 0) {
            throw new IllegalArgumentException("permitsPerSecond 必須大於 0");
        }
        if (burst < permitsPerSecond) {
            throw new IllegalArgumentException("burst 不可小於 permitsPerSecond");
        }
        this.permitsPerSecond = permitsPerSecond;
        this.burst = burst;
    }

    @Override
    public boolean tryAcquire(String key) {
        Bucket bucket = buckets.computeIfAbsent(key, k -> new Bucket(burst, System.nanoTime()));
        return bucket.tryAcquire(permitsPerSecond, burst);
    }

    /** 每個 key 一個桶。方法用 synchronized 保護，桶數量多時競爭不激烈。 */
    private static final class Bucket {
        private double tokens;
        private long lastRefillNanos;

        Bucket(double initialTokens, long nowNanos) {
            this.tokens = initialTokens;
            this.lastRefillNanos = nowNanos;
        }

        synchronized boolean tryAcquire(double permitsPerSecond, double burst) {
            long now = System.nanoTime();
            double elapsedSeconds = (now - lastRefillNanos) / 1_000_000_000.0;
            tokens = Math.min(burst, tokens + elapsedSeconds * permitsPerSecond);
            lastRefillNanos = now;

            if (tokens >= 1.0) {
                tokens -= 1.0;
                return true;
            }
            return false;
        }
    }
}
```

```java
// ratelimit-spring-boot-autoconfigure/.../RateLimitProperties.java
package com.example.ratelimit.autoconfigure;

import jakarta.validation.constraints.Positive;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "shop.ratelimit")
public class RateLimitProperties {

    /** 是否啟用限流。 */
    private boolean enabled = true;

    /** 每秒允許的請求數。 */
    @Positive
    private double permitsPerSecond = 10;

    /** 突發流量上限（桶容量）。必須 >= permitsPerSecond。 */
    @Positive
    private double burst = 20;

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public double getPermitsPerSecond() { return permitsPerSecond; }
    public void setPermitsPerSecond(double permitsPerSecond) { this.permitsPerSecond = permitsPerSecond; }
    public double getBurst() { return burst; }
    public void setBurst(double burst) { this.burst = burst; }
}
```

```java
// ratelimit-spring-boot-autoconfigure/.../RateLimitAutoConfiguration.java
package com.example.ratelimit.autoconfigure;

import com.example.ratelimit.InMemoryTokenBucketRateLimiter;
import com.example.ratelimit.RateLimiter;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

@AutoConfiguration
@ConditionalOnProperty(prefix = "shop.ratelimit", name = "enabled",
        havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(RateLimitProperties.class)
public class RateLimitAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(RateLimiter.class)
    public RateLimiter rateLimiter(RateLimitProperties properties) {
        return new InMemoryTokenBucketRateLimiter(
                properties.getPermitsPerSecond(), properties.getBurst());
    }
}
```

```
// src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.ratelimit.autoconfigure.RateLimitAutoConfiguration
```

```json
// src/main/resources/META-INF/additional-spring-configuration-metadata.json
{
  "hints": [
    {
      "name": "shop.ratelimit.permits-per-second",
      "values": [
        { "value": 10,   "description": "一般 API 的建議值。" },
        { "value": 100,  "description": "內部服務之間呼叫。" }
      ]
    }
  ]
}
```

**測試：**

```java
package com.example.ratelimit.autoconfigure;

import com.example.ratelimit.InMemoryTokenBucketRateLimiter;
import com.example.ratelimit.RateLimiter;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import static org.assertj.core.api.Assertions.assertThat;

class RateLimitAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(RateLimitAutoConfiguration.class));

    @Test
    void 預設應建立記憶體版限流器() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(RateLimiter.class);
            assertThat(context.getBean(RateLimiter.class))
                    .isInstanceOf(InMemoryTokenBucketRateLimiter.class);
        });
    }

    @Test
    void 預設值應為每秒10次突發20次() {
        runner.run(context -> {
            RateLimitProperties props = context.getBean(RateLimitProperties.class);
            assertThat(props.getPermitsPerSecond()).isEqualTo(10);
            assertThat(props.getBurst()).isEqualTo(20);
        });
    }

    @Test
    void 停用時不應建立限流器() {
        runner.withPropertyValues("shop.ratelimit.enabled=false")
              .run(context -> assertThat(context).doesNotHaveBean(RateLimiter.class));
    }

    @Test
    void 使用者自訂實作應覆寫預設() {
        runner.withUserConfiguration(CustomLimiterConfig.class)
              .run(context -> {
                  assertThat(context).hasSingleBean(RateLimiter.class);
                  assertThat(context.getBean(RateLimiter.class)).isInstanceOf(AlwaysAllow.class);
              });
    }

    @Test
    void 自訂速率應生效() {
        runner.withPropertyValues(
                      "shop.ratelimit.permits-per-second=1",
                      "shop.ratelimit.burst=1")
              .run(context -> {
                  RateLimiter limiter = context.getBean(RateLimiter.class);
                  assertThat(limiter.tryAcquire("user-1")).isTrue();    // 用掉唯一的令牌
                  assertThat(limiter.tryAcquire("user-1")).isFalse();   // 立刻再來就被擋
                  assertThat(limiter.tryAcquire("user-2")).isTrue();    // 不同 key 互不影響
              });
    }

    @Test
    void burst小於速率時應啟動失敗() {
        runner.withPropertyValues(
                      "shop.ratelimit.permits-per-second=10",
                      "shop.ratelimit.burst=5")
              .run(context -> {
                  assertThat(context).hasFailed();
                  assertThat(context).getFailure()
                          .hasRootCauseInstanceOf(IllegalArgumentException.class);
              });
    }

    static class AlwaysAllow implements RateLimiter {
        @Override public boolean tryAcquire(String key) { return true; }
    }

    @Configuration(proxyBeanMethods = false)
    static class CustomLimiterConfig {
        @Bean
        RateLimiter customRateLimiter() { return new AlwaysAllow(); }
    }
}
```

**幾個設計上的取捨值得注意：**

1. **`burst < permitsPerSecond` 時在建構子丟例外**——讓錯誤設定在**啟動時**炸掉，
   而不是上線後才發現限流行為很奇怪。最後那個測試就是在驗證這件事。
2. **不同 key 用不同的桶**——限流的維度應該由呼叫方決定（依 IP、依使用者、依 API）。
3. **Javadoc 明說「這是單機版」**——避免使用者誤以為它是分散式限流。
   starter 的文件責任比一般程式碼更重，因為使用者看不到你的實作。
4. 這個 starter 只提供 `RateLimiter` Bean，**沒有自動接到 Web 層**。
   要接上去需要一個 `HandlerInterceptor` 或 `Filter`——那是 04-controller 第 04 章的內容，
   而且應該做成「可選」的（`@ConditionalOnWebApplication` + 一個獨立的開關）。

</details>

---

## 2.15 驗收清單

- [ ] 我能解釋「加一行 starter 依賴」到底發生了什麼，並用 Bean 數量的變化驗證。
- [ ] 我知道 starter 本身沒有程式碼，真正做事的是 `xxx-autoconfigure`。
- [ ] 我知道第三方 starter 的命名慣例是 `xxx-spring-boot-starter`。
- [ ] 我能追蹤 `@SpringBootApplication` → `@EnableAutoConfiguration` → `AutoConfigurationImportSelector` 的路徑。
- [ ] 我知道自動組態是 `DeferredImportSelector`，所以在使用者的 Bean **之後**才處理。
- [ ] 我能說出 Boot 3 的 `AutoConfiguration.imports` 檔案完整路徑，也知道 Boot 2 用 `spring.factories`。
- [ ] 我知道 `@ConditionalOnClass` 為什麼不會 `NoClassDefFoundError`（ASM 讀 bytecode，不載入類別）。
- [ ] 我知道 `@ConditionalOnBean` 有評估時機問題，只能用在自動組態類別上且要配合 `@AutoConfiguration(after=...)`。
- [ ] 我知道 `@ConditionalOnMissingBean` 判斷的是**方法回傳型別**，所以要回傳介面而不是實作類別。
- [ ] 我能逐行讀懂 `JacksonAutoConfiguration` / `DataSourceAutoConfiguration`，並從中找出「有哪些屬性可以設」。
- [ ] 我知道 Customizer 模式比「自己定義整個 Bean」更好，也能舉出例子。
- [ ] 我能用 `--debug` 或 `/actuator/conditions` 讀條件報告，並分辨哪些 negativeMatches 是正常的。
- [ ] 我能用四種方式（自訂 Bean、改設定、Customizer、exclude）調整自動組態，並知道優先順序。
- [ ] 我能從零建立一個三模組的 starter，並正確放置 `AutoConfiguration.imports`。
- [ ] 我知道 starter 的依賴要用 `<optional>true</optional>`，不要強迫使用者拉進整包。
- [ ] 我會用 `spring-boot-configuration-processor` 產生設定提示，並用 `additional-...metadata.json` 補充。
- [ ] 我會用 `ApplicationContextRunner` + `FilteredClassLoader` 測試自動組態在不同 classpath 下的行為。

---

完成後請前往 [03-configuration-properties-and-profiles.md](./03-configuration-properties-and-profiles.md)。
