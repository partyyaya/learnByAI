# 第 06 章：連線與序列化——把 Redis 接進 Spring

> **第二部分從這裡開始。**
>
> 前六章你都站在 `redis-cli` 那一側看 Redis。從這一章起，你站在 Java 這一側，
> 而這一側最先要面對的是一個很簡單的問題：
>
> > **`redisTemplate.opsForValue().set("product:1001", product)` 這一行，到底把什麼送到 Redis 上？**
>
> 00 章 0.3.3 已經給過答案的一半——`\xac\xed\x00\x05`、493 bytes、
> 改個套件名整批快取讀不回來。這一章把另一半補完，並且把它旁邊的兩件事一起處理掉：
>
> | 這一章的三個問題 | 一句話的答案 |
> |---|---|
> | **存進去的到底是什麼** | 由**四個**序列化器決定，而預設的那一個是最糟的 |
> | **連線是怎麼用的** | 40 個執行緒、8 萬次命令，Lettuce 只用了 **1 條連線**——比連線池**快 1.9 倍** |
> | **Redis 不回話時你等多久** | 預設 **60 秒**。而且有三層逾時，你多半只設了一層 |
>
> 這一章的實測數字先列在這裡，後面每一個都有可重跑的程式碼：
>
> | 實測 | 數字 |
> |---|---|
> | JDK 序列化 vs JSON，同一個物件 | **493 bytes vs 46 bytes（10.7 倍）** |
> | 加一個欄位、`serialVersionUID` 寫死成 1L | **不報錯，新欄位安靜地變成 `null`** |
> | 加一個欄位、沒寫 `serialVersionUID` | `InvalidClassException`，**整批舊快取全部讀不回來** |
> | 40 執行緒 × 2000 次 GET，Lettuce 共用連線 | **57,636 ops/s，connected_clients = 4** |
> | 同一份工作量，連線池 40 條 | **35,922 ops/s，connected_clients = 52**（更慢） |
> | 同一份工作量，Jedis pool 40 條 | **45,070 ops/s，50 條連線** |
> | `docker pause` 之後一次 `GET`（逾時 500 ms） | **503 ms 拋 `RedisCommandTimeoutException`** |
> | `docker stop` 之後一次 `GET`（預設行為） | **507 ms 才失敗**——連線都沒了還是等滿逾時 |
> | 同上，改成 `REJECT_COMMANDS` | **1 ms 就失敗** |
>
> ⚠️ **本章會 `docker pause` / `docker stop` 你的 `redis-lab` 容器。**
> 測試結尾會自己 `unpause` / `start` 回來，但請不要在做別的事的時候跑。

---

## 6.1 學習目標

完成本章後，你應該可以：

- 說出 `spring-boot-starter-data-redis` 自動幫你建了哪些 bean，以及**沒有**幫你設什麼（6.2）。
- 畫出一次 `opsForHash().put(k, hk, hv)` 會用到**哪三個**序列化器，並說出第四個在哪裡（6.3）。
- 解釋 00 章那串 `\xac\xed\x00\x05` 是誰寫的，以及為什麼**連 key 都變成二進位**（6.3、6.4）。
- 說出 JDK 序列化的三個坑，並分辨「寫了 `serialVersionUID`」與「沒寫」哪一個更危險（6.4）。
- 分辨 `Jackson2JsonRedisSerializer` 與 `GenericJackson2JsonRedisSerializer`，
  並說出 `@class` 解決什麼、又帶來什麼（6.5）。
- 指出「把自己的 `ObjectMapper` 傳進 `GenericJackson2JsonRedisSerializer`」會**安靜地關掉型別資訊**（6.5.6）。
- 寫出一份自己的 `RedisConfig`，並說明每一行的理由（6.6）。
- 解釋 Lettuce 的**多工**連線模型，說出 `shareNativeConnection` 在共用什麼、
  以及什麼情況下 Lettuce 會自己另開一條連線（6.7）。
- 說出為什麼「`commons-pool2` 沒進 classpath，你的 `lettuce.pool.*` 會安靜地不生效」（6.7.3）。
- 說出**三層逾時**分別擋哪一種故障，並指出「只設命令逾時」擋不住什麼（6.8）。
- 說出 Redis 斷線時命令堆在哪裡，以及 `requestQueueSize` 的預設值是多少（6.8.5）。

---

## 6.2 自動設定給了你什麼

### 6.2.1 一個 starter，四個東西

`pom.xml` 裡那一行 `spring-boot-starter-data-redis`（00 章 0.7.1）帶來的是：

| 你拿到的 | 來自 | 說明 |
|---|---|---|
| `LettuceConnectionFactory` | `LettuceConnectionConfiguration` | 真正跟 Redis 講話的東西。**Lettuce 是預設客戶端**，Jedis 要自己換（6.7.5） |
| `RedisTemplate<Object, Object>` | `RedisAutoConfiguration` | 通用版。⚠️ **它的序列化器是 JDK**（6.3.2） |
| `StringRedisTemplate` | `RedisAutoConfiguration` | key 與 value 都當字串 |
| `RedisProperties` | `spring.data.redis.*` | 設定檔綁進來的地方 |

兩個 template 上面都掛著 `@ConditionalOnMissingBean`：

```java
@Bean
@ConditionalOnMissingBean(name = "redisTemplate")     // ← 注意是「name」
@ConditionalOnSingleCandidate(RedisConnectionFactory.class)
public RedisTemplate<Object, Object> redisTemplate(RedisConnectionFactory factory) { ... }
```

> 📌 **`@ConditionalOnMissingBean(name = "redisTemplate")` 是按「bean 名稱」判斷的。**
> 你自己定義一個叫 `redisTemplate` 的 bean，自動設定的那個就退開；
> 但如果你把方法名取成 `myRedisTemplate`，**兩個都會存在**，
> 而 `@Autowired RedisTemplate<String, Object>` 會因為有兩個候選人而啟動失敗，
> 或者更糟——**注入到你沒預期的那一個**（型別對得上的話）。

### 6.2.2 什麼都不設的時候，你拿到的是什麼

00 章的 `application.yml` 只寫了 host 跟 port（刻意的）。把其他欄位印出來：

```java
package com.example.lab10.ch06;

import io.lettuce.core.RedisURI;
import io.lettuce.core.SocketOptions;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.data.redis.RedisProperties;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;

@SpringBootTest
class C0DefaultsTest {

    @Autowired RedisProperties props;
    @Autowired LettuceConnectionFactory factory;

    @Test
    void printDefaults() {
        System.out.println("═══ 6.2.2 什麼都不設的時候，你拿到的是什麼 ═══");
        System.out.println("timeout（命令逾時）        = " + props.getTimeout());
        System.out.println("connect-timeout            = " + props.getConnectTimeout());
        System.out.println("lettuce.shutdown-timeout   = " + props.getLettuce().getShutdownTimeout());
        RedisProperties.Pool p = props.getLettuce().getPool();
        System.out.println("  max-active  = " + p.getMaxActive());
        System.out.println("  max-wait    = " + p.getMaxWait());
        System.out.println("實際命令逾時 commandTimeout = " + factory.getClientConfiguration().getCommandTimeout());
        System.out.println("Lettuce 的 RedisURI 預設逾時   = " + RedisURI.DEFAULT_TIMEOUT_DURATION);
        System.out.println("Lettuce 的 socket 連線逾時預設 = " + SocketOptions.DEFAULT_CONNECT_TIMEOUT_DURATION);
        System.out.println("shareNativeConnection       = " + factory.getShareNativeConnection());
        System.out.println("ClientConfiguration 實作     = "
                + factory.getClientConfiguration().getClass().getSimpleName());
    }
}
```

**輸出**：

```
═══ 6.2.2 什麼都不設的時候，你拿到的是什麼 ═══
host                       = localhost
port                       = 16379
database                   = 0
client-name                = null
client-type                = null
timeout（命令逾時）        = null
connect-timeout            = null
lettuce.shutdown-timeout   = PT0.1S
lettuce.pool               =
  enabled     = null
  max-active  = 8
  max-idle    = 8
  min-idle    = 0
  max-wait    = PT-0.001S

--- 沒設的欄位，最後變成 Lettuce 的哪個值 ---
實際命令逾時 commandTimeout = PT1M
Lettuce 的 RedisURI 預設逾時   = PT1M
Lettuce 的 socket 連線逾時預設 = PT10S
shareNativeConnection       = true
ClientConfiguration 實作     = DefaultLettucePoolingClientConfiguration
```

四個要記住的數字：

| 設定 | Spring Boot | 最後生效的值 | 意義 |
|---|---|---|---|
| `timeout` | **`null`** | **60 秒**（Lettuce 的 `RedisURI.DEFAULT_TIMEOUT`） | 03 章 3.7.2 那個「安靜地等 5 秒」就是它 |
| `connect-timeout` | **`null`** | **10 秒**（Lettuce 的 `SocketOptions` 預設） | 連不上的時候每次等 10 秒 |
| `pool.max-wait` | **`-1 ms`** | **無限等** | 池子借不到連線時**永遠不放棄** |
| `client-name` | **`null`** | 沒有名字 | `CLIENT LIST` 上看不出是誰（03 章 3.6 提過） |

> ⚠️ **「Spring Boot 有合理的預設值」在 Redis 這一塊只對了一半。**
> 它確實有預設值，但那些預設值是**給「Redis 一定會回應」的世界用的**。
> 三層逾時全部在 6.8 重設一次。

### 6.2.3 ⚠️ 一個容易踩的順序問題

`RedisProperties` 是 `@ConfigurationProperties`，所以 `spring.data.redis.timeout` 這種**在 yml 裡的**設定會生效。
但如果你自己定義了 `LettuceConnectionFactory`：

```java
@Bean
LettuceConnectionFactory redisConnectionFactory() {          // ← 自己接管
    return new LettuceConnectionFactory(new RedisStandaloneConfiguration("localhost", 16379));
}
```

**yml 裡的 `timeout`、`connect-timeout`、`pool.*`、`client-name` 全部失效**——
因為那些值是 `LettuceConnectionConfiguration` 在建 factory 的時候讀進去的，你把那一段整個換掉了。

> 📌 **要客製又要留住 yml，用 `LettuceClientConfigurationBuilderCustomizer`**（6.9 有完整寫法），
> 不要自己 `new` 一個 factory。這是本章第一條規約。

---

## 6.3 四個序列化器

### 6.3.1 為什麼是四個

Redis 只認位元組。`RedisTemplate` 上有四個位置需要「Java 物件 ↔ 位元組」的轉換：

```
                     ┌─────────────────── keySerializer
                     │            ┌────── valueSerializer
                     ▼            ▼
    SET      product:1001      {...}

                     ┌─────────────────── keySerializer
                     │        ┌────────── hashKeySerializer
                     │        │      ┌─── hashValueSerializer
                     ▼        ▼      ▼
    HSET     user:8842      name    小明
```

| 序列化器 | 負責 | 什麼時候用到 |
|---|---|---|
| `keySerializer` | **key 本身** | 所有命令 |
| `valueSerializer` | String / List / Set / ZSet 的值 | `opsForValue`、`opsForList`… |
| `hashKeySerializer` | **hash 的欄位名** | `opsForHash` |
| `hashValueSerializer` | **hash 的欄位值** | `opsForHash` |
| （第五個）`stringSerializer` | `execute` 時把字串參數轉位元組 | Lua 腳本的 `KEYS`/`ARGV`、部分內部呼叫 |

ZSet 的 **score 不經過序列化器**（它在協定上就是 `double`），
`opsForValue().increment()` 的回傳值也不經過（是 Redis 回的整數）。

### 6.3.2 實測：三個 template 的四個位置

```java
package com.example.lab10.ch06;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializer;

@SpringBootTest
class S1SerializerLocationTest {

    @Autowired RedisConnectionFactory factory;
    @Autowired StringRedisTemplate srt;
    // ⚠️ 只有在「你還沒有自己定義一個叫 redisTemplate 的 bean」時才存在（6.2.1）
    @Autowired ObjectProvider<RedisTemplate<Object, Object>> autoConfigured;

    private RedisTemplate<String, Object> plain() {
        RedisTemplate<String, Object> t = new RedisTemplate<>();
        t.setConnectionFactory(factory);
        t.afterPropertiesSet();
        return t;
    }

    @Test
    void fourSlots() {
        System.out.println("═══ 6.3.2 四個序列化器分別在哪裡 ═══");
        row("new RedisTemplate<>()", plain());
        row("Boot 自動設定的 RedisTemplate<Object,Object>", autoConfigured.getIfAvailable());
        row("StringRedisTemplate", srt);
    }

    private void row(String title, RedisTemplate<?, ?> t) {
        System.out.println(title);
        System.out.printf("    keySerializer       = %s%n", name(t.getKeySerializer()));
        System.out.printf("    valueSerializer     = %s%n", name(t.getValueSerializer()));
        System.out.printf("    hashKeySerializer   = %s%n", name(t.getHashKeySerializer()));
        System.out.printf("    hashValueSerializer = %s%n", name(t.getHashValueSerializer()));
        System.out.printf("    stringSerializer    = %s%n", name(t.getStringSerializer()));
    }

    private static String name(RedisSerializer<?> s) {
        return s == null ? "null" : s.getClass().getSimpleName();
    }
}
```

**輸出**：

```
═══ 6.3.2 四個序列化器分別在哪裡 ═══
new RedisTemplate<>()
    keySerializer       = JdkSerializationRedisSerializer
    valueSerializer     = JdkSerializationRedisSerializer
    hashKeySerializer   = JdkSerializationRedisSerializer
    hashValueSerializer = JdkSerializationRedisSerializer
    stringSerializer    = StringRedisSerializer
Boot 自動設定的 RedisTemplate<Object,Object>
    keySerializer       = JdkSerializationRedisSerializer
    valueSerializer     = JdkSerializationRedisSerializer
    hashKeySerializer   = JdkSerializationRedisSerializer
    hashValueSerializer = JdkSerializationRedisSerializer
    stringSerializer    = StringRedisSerializer
StringRedisTemplate
    keySerializer       = StringRedisSerializer
    valueSerializer     = StringRedisSerializer
    hashKeySerializer   = StringRedisSerializer
    hashValueSerializer = StringRedisSerializer
    stringSerializer    = StringRedisSerializer
```

> 📌 **兩件事要一起看**：
> ① **`new RedisTemplate<>()` 跟 Spring Boot 自動設定的那一個，序列化器完全一樣**——
> 都是四個 `JdkSerializationRedisSerializer`。
> **00 章 0.3.3 那段「教科書上最常見的設定」不是寫壞了，它就是預設值。**
> ② **`StringRedisTemplate` 不是「另一種 template」，它就是四個位置都換成 `StringRedisSerializer` 的 `RedisTemplate`。**
> 原始碼只有幾行：
>
> ```java
> public class StringRedisTemplate extends RedisTemplate<String, String> {
>     public StringRedisTemplate() {
>         setKeySerializer(RedisSerializer.string());
>         setValueSerializer(RedisSerializer.string());
>         setHashKeySerializer(RedisSerializer.string());
>         setHashValueSerializer(RedisSerializer.string());
>     }
> }
> ```

⚠️ **這個實驗要在「加上 6.6.2 的 `RedisConfig` 之前」跑。**
一旦你定義了自己的 `redisTemplate` bean，自動設定那一個就不會被建立（6.2.1），
`autoConfigured.getIfAvailable()` 會回 `null`——**這正好也是驗證「自動設定確實退開了」的方法。**

### 6.3.3 實測：哪一個欄位走哪一個序列化器

```java
    @Test
    void whichSlotIsUsedForWhat() {
        System.out.println("═══ 6.3.3 哪一個欄位走哪一個序列化器 ═══");
        RedisTemplate<String, Object> t = plain();
        t.opsForValue().set("slot:string", new Product(1L, "耳機", new BigDecimal("2490")));
        t.opsForHash().putAll("slot:demo", Map.of("f1", new Product(2L, "鍵盤", new BigDecimal("990"))));

        byte[] k1 = ser(t.getKeySerializer(), "slot:string");
        System.out.println("① key            → keySerializer       : " + escape(k1));
        System.out.println("② value          → valueSerializer     : " + len(t, k1) + " bytes");
        System.out.println("③ hash 的欄位名  → hashKeySerializer   : " + escape(ser(t.getHashKeySerializer(), "f1")));

        srt.opsForValue().set("slot:string2", "純字串");
        System.out.println("同一組操作，改用 StringRedisTemplate：");
        System.out.println("① key            → keySerializer       : "
                + escape(ser(srt.getKeySerializer(), "slot:string2")));
    }
```

**輸出**：

```
═══ 6.3.3 哪一個欄位走哪一個序列化器 ═══
① key            → keySerializer       : \xac\xed\x00\x05t\x00\x0bslot:string
② value          → valueSerializer     : 487 bytes
③ hash 的欄位名  → hashKeySerializer   : \xac\xed\x00\x05t\x00\x02f1

同一組操作，改用 StringRedisTemplate 看到的 key：
① key            → keySerializer       : slot:string2
```

**看那個 key**：`\xac\xed\x00\x05t\x00\x0bslot:string`。

| 位元組 | 意思 |
|---|---|
| `\xac\xed` | **Java 序列化的魔數**（`STREAM_MAGIC`）。看到它就知道是 JDK 序列化 |
| `\x00\x05` | 序列化協定版本 5 |
| `t` | `TC_STRING`，接下來是一個字串 |
| `\x00\x0b` | 字串長度 11 |
| `slot:string` | 你真正想要的 key |

> ⚠️ **前面那 5 個位元組是災難的來源**：
> - `redis-cli` 上敲不出這個 key（裡面有 `\x00`）。
> - `SCAN cart:*` 找不到任何東西——**真正的 key 前面多了 5 個位元組**。
> - 01 章 1.2.3 那套命名慣例、1.5 那套 `SCAN` 掃描，**全部作廢**。
> - 一千萬個 key，每個多 5 bytes = **多 47 MB**，純粹是格式開銷。

### 6.3.4 回到 02 章 2.4.6：為什麼是 `rawHashValue` 那一行爆掉

02 章留過一個問題：`StringRedisTemplate` 存 hash 時放進一個 `Integer`，
錯誤停在 `AbstractOperations.rawHashValue`。現在你有答案了：

```java
// AbstractOperations 裡面（簡化）
byte[] rawHashValue(Object value) {
    if (hashValueSerializer() == null && value instanceof byte[] bytes) return bytes;
    return hashValueSerializer().serialize(value);      // ← 這裡
}
```

`StringRedisTemplate` 的 `hashValueSerializer` 是 `StringRedisSerializer`，它的第一行是：

```java
public byte[] serialize(@Nullable String value) { ... }      // 參數型別是 String
```

而 `opsForHash()` 的宣告是 `HashOperations<String, Object, Object>`——**編譯期是 `Object`，執行期要 `String`**。

> 📌 **這個形狀在 Spring Data Redis 裡會一再出現**：
> **泛型參數與實際的序列化器是兩套獨立的東西，編譯器不會幫你對齊。**
> 你看到 `ClassCastException` 停在 `AbstractOperations` 的某一行時，
> 第一件事永遠是去看**那個位置的序列化器是誰**。

### 6.3.5 序列化器介面只有兩個方法

```java
public interface RedisSerializer<T> {
    byte[] serialize(@Nullable T t) throws SerializationException;
    T deserialize(@Nullable byte[] bytes) throws SerializationException;
}
```

Spring Data Redis 內建五個實作：

| 實作 | 存進 Redis 的樣子 | 讀得回原本的型別嗎 |
|---|---|---|
| `JdkSerializationRedisSerializer`（**預設**） | `\xac\xed...`（二進位） | ✅（但版本要對得上，6.4） |
| `StringRedisSerializer` | 原字串（UTF-8） | 只有 `String` |
| `Jackson2JsonRedisSerializer<T>` | 乾淨 JSON | 只有建構時指定的那一種 |
| `GenericJackson2JsonRedisSerializer` | JSON + `@class` | ✅ |
| `GenericToStringSerializer<T>` | `toString()` 的結果 | 需要能從字串轉回來的型別 |

接下來兩節把前四個一個一個打開來看。

---

## 6.4 JDK 序列化的三個坑

這一節的實驗**不需要 Redis**——坑在序列化格式本身。

兩組對照類別，模擬「上線三個月後加了一個欄位」：

```java
// 套件 ch06.va —— 上線時的版本（有 serialVersionUID）
public class Product implements Serializable {
    private static final long serialVersionUID = 1L;
    private Long id; private String name; private BigDecimal price;
}

// 套件 ch06.vb —— 三個月後（多了 stock，serialVersionUID 沒動）
public class Product implements Serializable {
    private static final long serialVersionUID = 1L;
    private Long id; private String name; private BigDecimal price; private Integer stock;
}

// 套件 ch06.wa / ch06.wb —— 同樣的兩個版本，但都「沒寫」serialVersionUID
```

> 📌 `va` / `vb`（與 `wa` / `wb`）**套件名長度刻意一樣**，
> 這樣就能像 00 章 0.3.3 那樣，直接把串流裡的類名換掉，
> 效果等同「同一個類別改版後重新部署，然後去讀舊快取」。

### 6.4.1 坑一：體積，以及裡面裝了什麼

```java
@Test
void pitfall1_size() throws Exception {
    var p = new com.example.lab10.ch06.va.Product(1001L, "無線耳機", new BigDecimal("2490"));
    byte[] jdkBytes = new JdkSerializationRedisSerializer().serialize(p);
    byte[] jsonBytes = new ObjectMapper().writeValueAsBytes(p);
    System.out.printf("JDK 序列化  : %,4d bytes%n", jdkBytes.length);
    System.out.printf("JSON        : %,4d bytes   %s%n", jsonBytes.length, new String(jsonBytes, UTF_8));
    System.out.printf("倍數        : %.1f 倍%n", 1.0 * jdkBytes.length / jsonBytes.length);
    System.out.println("JDK 那 " + jdkBytes.length + " bytes 裡有什麼（可列印的部分）：");
    System.out.println("  " + printableRuns(jdkBytes));       // 抓出連續 3 個以上的可列印字元
}
```

**輸出**：

```
═══ 6.4.1 坑一：體積 ═══
JDK 序列化  :  493 bytes
JSON        :   46 bytes   {"id":1001,"name":"無線耳機","price":2490}
倍數        : 10.7 倍

JDK 那 493 bytes 裡有什麼（可列印的部分）：
  [!com.example.lab10.ch06.va.Product] [idt] [Ljava/lang/Long;L] [namet] [Ljava/lang/String;L]
  [pricet] [Ljava/math/BigDecimal;xpsr] [java.lang.Long;] [valuexr] [java.lang.Number]
  [java.math.BigDecimalT] [scaleL] [intValt] [Ljava/math/BigInteger;xq] [java.math.BigInteger]
  [bitCountI] [bitLengthI] [firstNonzeroByteNumI] [lowestSetBitI] [signum[] [magnitudet] [[Bxq]
```

**那 493 bytes 裡，真正的資料（`1001`、`無線耳機`、`2490`）不到 20 bytes。** 其餘的是：

- 你的類名與**每一個欄位的名稱與型別簽章**。
- `BigDecimal` 的內部結構（`scale`、`intVal`），以及 `BigInteger` 的內部結構
  （`bitCount`、`bitLength`、`firstNonzeroByteNum`、`lowestSetBit`、`signum`、`magnitude`）。

> ⚠️ **你存的不是「一個商品」，是「一個 Java 物件在這個 JVM 裡的記憶體佈局描述」。**
> `BigDecimal` 換一個 JDK 版本、內部欄位改了，這包東西就讀不回來——
> 而它是 JDK 的類別，不是你的。

回頭看 04 章：同樣一千萬筆商品快取，JDK 版比 JSON 版**多吃十倍記憶體**，
而記憶體決定什麼時候開始驅逐（04 章 4.3）。**序列化器的選擇是一個記憶體決策。**

### 6.4.2 坑二：寫了 `serialVersionUID = 1L`，於是它安靜地錯

網路上的建議是「一定要顯式宣告 `serialVersionUID`，不然改版會出事」。
那就照做——兩個版本都寫 `1L`：

```java
@Test
void pitfall2_silentFieldDrift() {
    System.out.println("va.Product  欄位 = id, name, price          serialVersionUID = "
            + ObjectStreamClass.lookup(va.Product.class).getSerialVersionUID());
    System.out.println("vb.Product  欄位 = id, name, price, stock   serialVersionUID = "
            + ObjectStreamClass.lookup(vb.Product.class).getSerialVersionUID());

    byte[] old = jdk.serialize(new va.Product(1001L, "無線耳機", new BigDecimal("2490")));
    byte[] patched = rename(old, "ch06.va.Product", "ch06.vb.Product");   // 模擬改版後重新部署

    Object back = jdk.deserialize(patched);
    System.out.println("新版程式讀舊快取 : " + back);
}
```

**輸出**：

```
═══ 6.4.2 坑二：寫了 serialVersionUID = 1L，於是它安靜地錯 ═══
va.Product  欄位 = id, name, price          serialVersionUID = 1
vb.Product  欄位 = id, name, price, stock   serialVersionUID = 1
新版程式讀舊快取 : Product[1001, 無線耳機, 2490, stock=null]
  → 沒有例外。stock 是 null，而不是你以為的 0，也不是資料庫裡的值。
```

**沒有任何錯誤。** 舊資料成功地反序列化成新版的類別，新欄位拿到**型別的預設值**：

| 新欄位型別 | 舊資料裡沒有它時，你會拿到 |
|---|---|
| `Integer` / `Long` / 任何物件 | **`null`** |
| `int` / `long` | `0` |
| `boolean` | `false` |

> ⚠️ **這比直接爆掉危險得多。**
> 想像 `stock` 是庫存、`enabled` 是「這個商品上不上架」、`discount` 是折扣率：
>
> - `stock = null` → 下一行 `product.getStock() > 0` 直接 `NullPointerException`，
>   而且**只有那些「快取是改版前寫進去的」商品會炸**——重新整理一次可能就好了，你重現不出來。
> - `enabled = false` → 所有舊快取的商品**全部從架上消失**，而且沒有任何錯誤日誌。
> - `discount = 0.0` → 更慘的方向：全部打零折。
>
> **顯式寫死 `serialVersionUID` 不是「解決了版本問題」，是「關掉了版本檢查」。**

### 6.4.3 坑三：沒寫 `serialVersionUID`，於是它大聲地炸

```
═══ 6.4.3 坑三：沒寫 serialVersionUID，於是它大聲地炸 ═══
wa.Product  欄位 = id, name, price          serialVersionUID = 1074461951386439630
wb.Product  欄位 = id, name, price, stock   serialVersionUID = -5675602673547362830
  → 只多了一個欄位，這個數字就完全變了。

新版程式讀舊快取 : 炸了
  SerializationException
  → java.io.InvalidClassException
     com.example.lab10.ch06.wb.Product; local class incompatible:
     stream classdesc serialVersionUID = 1074461951386439630,
     local class serialVersionUID = -5675602673547362830
```

沒寫的時候，JVM 會**從類別的結構算一個雜湊**當作 UID：類名、介面、欄位、方法簽章、
甚至 `static` 初始化區塊存不存在，都算在裡面。

> ⚠️ **「只加一個 private 欄位、不動任何邏輯」也會讓這個數字完全改變。**
> 於是部署的那一瞬間：
>
> ```
> 舊快取（幾十萬筆）  ←  新版程式
>          每一筆都 InvalidClassException
> ```
>
> 而 `@Cacheable` 預設**不會**把這種錯誤吞掉（07 章 7.6 會實測），
> 所以它不是「快取沒命中、去資料庫拿」，是**每一個請求都 500**。

### 6.4.4 兩個坑之間沒有安全的選項

| | 寫 `serialVersionUID = 1L` | 不寫 |
|---|---|---|
| 加一個欄位 | ✅ 不報錯，新欄位 = `null` / `0` | ❌ `InvalidClassException` |
| 刪一個欄位 | ✅ 不報錯，舊資料的那個值被丟掉 | ❌ `InvalidClassException` |
| 改欄位型別（`Integer`→`Long`） | ❌ `ClassCastException`（在讀出來之後） | ❌ `InvalidClassException` |
| 改套件名 | ❌ `ClassNotFoundException`（00 章 0.3.3） | ❌ `ClassNotFoundException` |
| 你會在什麼時候知道 | **可能永遠不知道** | **部署後三秒** |

> 📌 **這張表沒有「✅ 全部安全」那一列，這就是這一節的結論。**
> 問題不在你有沒有寫 `serialVersionUID`，在於
> **JDK 序列化把「類別的形狀」當成資料格式的一部分**，
> 而快取裡的資料比你的程式碼活得久。

### 6.4.5 還有第四件事：反序列化是一個執行點

`ObjectInputStream.readObject()` 會**呼叫類別的程式碼**（`readObject`、`readResolve`、
`readExternal`，以及各種 `AbstractTableModel$ReadObjectCallback` 之類的東西）。
所以「能決定 Redis 裡的位元組的人」＝「能在你的 JVM 裡觸發程式碼執行的人」。

這是一整類的安全問題（`ysoserial` 那一族），而它跟 Redis 的關係很直接：
**Redis 預設沒有密碼、也沒有 TLS**（00 章 0.4.5 提過那是實驗機）。

> 📌 **JDK 序列化在快取上唯一真正的優點是「不用改程式碼」。**
> 這一章剩下的部分都在講怎麼放棄它。

---

## 6.5 Jackson：四種寫法，四種結局

這一節的主角換成一個**普通的 POJO**——注意它沒有 `implements Serializable`：

```java
package com.example.lab10.ch06.dto;

public class Product {
    private Long id;
    private String name;
    private BigDecimal price;
    private LocalDateTime shelfAt;
    // 無參數建構子 + getter/setter（Jackson 需要）
}
```

共用的 template 工廠（key 固定用 `StringRedisSerializer`，只換 value）：

```java
private RedisTemplate<String, Object> withValueSerializer(RedisSerializer<?> valueSer) {
    RedisTemplate<String, Object> t = new RedisTemplate<>();
    t.setConnectionFactory(factory);
    t.setKeySerializer(new StringRedisSerializer());        // ← key 一定要先救回來
    t.setHashKeySerializer(new StringRedisSerializer());
    t.setValueSerializer(valueSer);
    t.setHashValueSerializer(valueSer);
    t.afterPropertiesSet();
    return t;
}
```

每個實驗都用注入的 `StringRedisTemplate` 再讀一次同一個 key，
**這樣印出來的就是 `redis-cli` 上會看到的東西**。

### 6.5.1 寫法一：`Jackson2JsonRedisSerializer<Object>`

```java
RedisTemplate<String, Object> t = withValueSerializer(new Jackson2JsonRedisSerializer<>(Object.class));
t.opsForValue().set("p:1", new Product(1001L, "無線耳機", new BigDecimal("2490")));
```

```
═══ 6.5.1 Jackson2JsonRedisSerializer：JSON 很乾淨，型別不見了 ═══
redis-cli 看到的 : {"id":1001,"name":"無線耳機","price":2490,"shelfAt":null}
讀回來的型別     : java.util.LinkedHashMap
讀回來的內容     : {id=1001, name=無線耳機, price=2490, shelfAt=null}
  ↑ get() 沒有拋例外。例外在下一行才發生 ——
拿來用           : ClassCastException
  → class java.util.LinkedHashMap cannot be cast to class com.example.lab10.ch06.dto.Product
```

**JSON 很漂亮，46 bytes，`redis-cli` 上一眼就看得懂。** 但型別資訊沒有了，
Jackson 只能給你一個 `LinkedHashMap`。

⚠️ **注意錯誤發生的位置**：`get()` **成功了**。爆炸在下一行的型別轉換。

```java
Object o = redis.opsForValue().get(key);     // ✅ 沒事
Product p = (Product) o;                     // ❌ ClassCastException
```

> 📌 **這代表泛型幫不了你**。下面這段可以編譯，而且 `get()` 那行不會爆：
>
> ```java
> RedisTemplate<String, Product> typed = ...;
> Product p = typed.opsForValue().get("p:1");   // 這一行才爆（編譯器插入的轉型）
> ```
>
> **更糟的版本**是把它放進集合：`List<Product> list` 裡面塞滿 `LinkedHashMap`，
> 一路傳到三層之外的某個 `for` 迴圈裡才炸——**堆疊追蹤指的地方跟原因隔了很遠**。

### 6.5.2 寫法二：`Jackson2JsonRedisSerializer<Product>`

```java
RedisTemplate<String, Object> t = withValueSerializer(new Jackson2JsonRedisSerializer<>(Product.class));
```

```
═══ 6.5.2 Jackson2JsonRedisSerializer<Product>：型別對了，但只能有一種 ═══
redis-cli 看到的 : {"id":1002,"name":"機械鍵盤","price":3290,"shelfAt":null}
讀回來的型別     : Product ✅

但同一個 template 存別的型別：
讀回來           : MismatchedInputException
  → Cannot construct instance of `com.example.lab10.ch06.dto.Product`
    (although at least one Creator exists): no String-argument constructor/factory method
    to deserialize from String value ('一個普通字串')
```

**型別正確、JSON 乾淨、體積最小。代價是：這個 template 只能存這一種型別。**

實務上這代表你要嘛替每一種型別開一個 template bean，
要嘛在每次呼叫時自己指定型別——後者要走 `RedisSerializer` 之外的路（例如自己序列化成字串再用 `StringRedisTemplate` 存）。

> 📌 **它其實是很好的選擇，但只在一個地方**：
> **`@Cacheable` 的快取**。因為每一個 cache 的內容型別通常是固定的
> （`products` 這個 cache 只放 `Product`），而 `RedisCacheManager`
> 允許**每個 cache 各自指定序列化器**——07 章 7.4 會這樣做。

### 6.5.3 寫法三：`GenericJackson2JsonRedisSerializer`

```java
RedisTemplate<String, Object> t = withValueSerializer(new GenericJackson2JsonRedisSerializer());
```

```
═══ 6.5.3 GenericJackson2JsonRedisSerializer：把類名寫進 JSON ═══
redis-cli 看到的 : {"@class":"com.example.lab10.ch06.dto.Product","id":1003,"name":"無線滑鼠",
                   "price":["java.math.BigDecimal",790],"shelfAt":null}
讀回來的型別     : Product ✅
```

它在 JSON 裡多寫一個 `@class` 欄位，反序列化時照著它 `new`。

**非物件的值也處理得很自然**：

```
存一個字串、一個數字：
字串 redis-cli   : "一個普通字串"   → 讀回 String
數字 redis-cli   : 42              → 讀回 Integer
```

**⚠️ 但集合有一個非常容易踩的坑**：

```java
List<Product> items = List.of(new Product(1L, "A", ...), new Product(2L, "B", ...));
t.opsForValue().set("p:list1", items);

List<Product> arrayList = new ArrayList<>(items);
t.opsForValue().set("p:list2", arrayList);
```

```
--- 存一個 List<Product>，兩種建法 ---
① List.of(...)  存進去的型別 : java.util.ImmutableCollections$List12
   redis-cli 看到的 : [{"@class":"...dto.Product","id":1,...},{"@class":"...dto.Product","id":2,...}]
   讀回來 : MismatchedInputException
     → Unexpected token (START_OBJECT), expected VALUE_STRING:
       need String, Number of Boolean value that contains type id (for subtype of java.lang.Object)

② new ArrayList<>(...) 存進去的型別 : java.util.ArrayList
   redis-cli 看到的 : ["java.util.ArrayList",[{"@class":"...dto.Product","id":1,...},{...}]]
   讀回來 : java.util.ArrayList，元素是 Product ✅
```

**兩者的 JSON 不一樣**：`ArrayList` 版外面包了一層 `["java.util.ArrayList", [...]]`，
`List.of(...)` 版沒有。

**原因**：`GenericJackson2JsonRedisSerializer` 用的是
`activateDefaultTyping(..., DefaultTyping.NON_FINAL, ...)`——
**只替「非 final 的型別」寫型別資訊**。
`List.of(...)` 回傳的 `ImmutableCollections$List12` 是 **final** 的，所以沒寫；
沒寫就讀不回來。

> ⚠️ **這個坑的形狀值得記住**：
> **寫進去完全成功，`redis-cli` 上看起來完全正常，只有讀的時候會失敗。**
> 而 `List.of(...)`、`Map.of(...)`、`Collections.unmodifiableList(...)`、
> `Stream.toList()`（Java 16+ 回傳不可變 list）全部是同一個問題——
> **這些正好都是現在大家最愛寫的寫法。**
>
> 📌 **規約**：**要放進 Redis 的集合，一律轉成 `ArrayList` / `HashMap` / `HashSet`**。

### 6.5.4 體積

```
═══ 6.5.4 三種序列化器的體積 ═══
JdkSerialization        : 存不進去 —— DefaultSerializer requires a Serializable payload
                          but received an object of type [com.example.lab10.ch06.dto.Product]
                          （dto.Product 沒有 implements Serializable）
Jackson2Json            :   61 bytes
GenericJackson2Json     :  132 bytes   （多的是 @class 那一段）
```

順帶證明了一件事：**換成 Jackson 之後，你的 DTO 不用再 `implements Serializable`**。
反過來說，**只要你還在用 JDK 序列化，每一個進得了快取的類別（以及它引用到的每一個類別）都必須是 `Serializable`**——
這個限制會一路擴散到你的領域模型上。

`@class` 的成本是 **71 bytes / 筆**。一千萬筆 = **多 677 MB**。

> 📌 **所以 `@class` 不是免費的**，而且它寫進去的是**你的類名**——
> 這正是 6.5.6 與 07 章 7.6 的問題來源。

### 6.5.5 寫法四：⚠️ 換上自己的 `ObjectMapper`（最常見的坑）

上面三種都存不了 `LocalDateTime`：

```
═══ 6.5.5 ① 預設的 GenericJackson2JsonRedisSerializer 存不了 LocalDateTime ═══
存的時候 : InvalidDefinitionException
  → Java 8 date/time type `java.time.LocalDateTime` not supported by default:
    add Module "com.fasterxml.jackson.datatype:jackson-datatype-jsr310" to enable handling
    (through reference chain: com.example.lab10.ch06.dto.Product["shelfAt"])
```

於是所有人都會做同一件事——自己組一顆 `ObjectMapper` 傳進去：

```java
ObjectMapper m = new ObjectMapper();
m.setVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.ANY);
m.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
m.registerModule(new JavaTimeModule());                      // ← 解決上面那個錯
RedisTemplate<String, Object> t = with(new GenericJackson2JsonRedisSerializer(m));
```

**時間確實存進去了。但是**：

```
═══ 6.5.5 ② 換上自己的 ObjectMapper —— 時間能存了，@class 卻不見了 ═══
redis-cli : {"id":1001,"name":"無線耳機","price":2490,"shelfAt":[2026,9,17,10,30]}
讀回來    : java.util.LinkedHashMap
            {id=1001, name=無線耳機, price=2490, shelfAt=[2026, 9, 17, 10, 30]}
  ↑ 兩個問題：① 沒有 @class，型別掉回 LinkedHashMap（6.5.1 那個 ClassCastException 又回來了）
              ② 日期被寫成數字陣列，別的語言看不懂
```

**`@class` 不見了。** 原因在 Spring Data Redis 的原始碼裡：

```java
// 無參數建構子：它替你做了兩件事
public GenericJackson2JsonRedisSerializer() {
    this((String) null);
    // → registerNullValueSerializer(mapper, null);
    // → mapper.activateDefaultTyping(mapper.getPolymorphicTypeValidator(),
    //                                DefaultTyping.NON_FINAL, As.PROPERTY);
}

// 傳 ObjectMapper 的建構子：它「完全照你給的」用
public GenericJackson2JsonRedisSerializer(ObjectMapper objectMapper) {
    this(objectMapper, JacksonObjectReader.create(), JacksonObjectWriter.create());
}
```

> ⚠️ **傳自己的 `ObjectMapper` 進去，等於同時關掉兩件事**：
> ① **default typing**（`@class` 不見了 → `LinkedHashMap`）。
> ② **`NullValueSerializer`**（Spring Cache 用來表示「這一筆就是 null」的標記型別）。
>
> 而它們**都不會報錯**。你只會在某個 `ClassCastException` 裡看到後果。
>
> 📌 ②**在 `@Cacheable` 上剛好不會出事**——`RedisCache` 對 `NullValue` 有一條硬寫死的捷徑，
> 根本不走你設定的序列化器（07 章 7.5.2 會把那 64 bytes 挖出來看）。
> 但只要你是**直接用 `RedisTemplate`** 存這個型別，它就會炸。

補回來之後才是對的：

```java
ObjectMapper m = new ObjectMapper();
m.setVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.ANY);
m.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
m.registerModule(new JavaTimeModule());
m.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);       // ← 日期寫成 ISO 字串
m.activateDefaultTyping(m.getPolymorphicTypeValidator(),         // ← 把 @class 補回來
        ObjectMapper.DefaultTyping.NON_FINAL, JsonTypeInfo.As.PROPERTY);
```

```
═══ 6.5.5 ③ 補回 default typing，並把日期寫成 ISO ═══
redis-cli : {"@class":"com.example.lab10.ch06.dto.Product","id":1001,"name":"無線耳機",
             "price":["java.math.BigDecimal",2490],"shelfAt":"2026-09-17T10:30:00"}
讀回來    : Product → Product[1001, 無線耳機, 2490, 2026-09-17T10:30] ✅
```

對照一下 `shelfAt` 的兩種樣子：

| 設定 | 存進去的樣子 | 問題 |
|---|---|---|
| 預設（`WRITE_DATES_AS_TIMESTAMPS` 開） | `[2026,9,17,10,30]` | Java 以外的程式看不懂；**秒數是 0 時那一格會消失**，陣列長度會變 |
| `disable(...)` | `"2026-09-17T10:30:00"` | ✅ |

### 6.5.6 ⚠️ `@class` 的另一面：資料決定你 `new` 出什麼

`@class` 的意思是：**Redis 裡的那個字串，決定你的 JVM 要實體化哪一個類別。**

```java
// 用 StringRedisTemplate 手工寫一段 JSON 進去，模擬「有人改得動 Redis」
srt.opsForValue().set("p:evil", "[\"java.io.File\",\"/etc/passwd\"]");
Object back = looseTemplate.opsForValue().get("p:evil");
```

```
═══ 6.5.6 @class 是「Redis 裡的資料決定你 new 出什麼物件」 ═══
用預設 mapper 讀 : java.io.File → /etc/passwd
  ↑ 你的程式碼從頭到尾沒提過 java.io.File，是 Redis 裡的字串決定的
```

`java.io.File` 本身無害，重點是這個機制：**能寫進 Redis 的人，就能指定你要建立哪一個類別**。
classpath 上有沒有「建構過程會做事」的類別，決定了它有多嚴重。

**怎麼辦：給 default typing 一個白名單。**

```java
PolymorphicTypeValidator ptv = BasicPolymorphicTypeValidator.builder()
        .allowIfSubType("com.example.lab10.")     // 你自己的型別
        .allowIfSubType("java.util.")             // 集合
        .allowIfSubType("java.math.")             // BigDecimal / BigInteger
        .allowIfSubType("java.time.")             // 日期時間
        .build();
mapper.activateDefaultTyping(ptv, DefaultTyping.NON_FINAL, JsonTypeInfo.As.PROPERTY);
```

```
換成有白名單的 mapper：
讀回來 : InvalidTypeIdException
  → Could not resolve type id 'java.io.File' as a subtype of `java.lang.Object`:
    Configured `PolymorphicTypeValidator` denied resolution
自己的型別照樣過 :
  Product ✅
```

> 📌 **注意 `mapper.getPolymorphicTypeValidator()` 的預設值是 `LaissezFaireSubTypeValidator`
> ——「什麼都放行」。** 6.5.5 ③ 那段程式碼為了聚焦在 `@class` 上用了它；
> **正式環境請用上面的白名單版本**，6.6 的完整設定也是這樣寫的。

### 6.5.7 五種序列化器的對照表

| | `Jdk` | `String` | `Jackson2Json<T>` | `GenericJackson2Json` | `GenericToString` |
|---|---|---|---|---|---|
| `redis-cli` 上讀得懂 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 體積（同一個 Product） | 493 | —— | **61** | 132 | —— |
| 保留型別 | ✅ | ❌ | 只有一種 | ✅ | ❌ |
| 需要 `Serializable` | **✅ 需要** | —— | ❌ | ❌ | ❌ |
| 跨語言 | ❌ | ✅ | ✅ | ⚠️（`@class` 別人用不到） | ✅ |
| 改欄位 | ⚠️ 見 6.4.4 | —— | ✅ 忽略未知欄位 | ✅ | —— |
| 改套件名 | ❌ 爆 | —— | ✅ 不受影響 | ❌ 爆（07 章 7.6） | —— |
| 適合當 | **不要用** | key、簡單值 | **每個 cache 一種型別** | 通用 template | 數字、列舉 |

---

## 6.6 所以你的 `RedisConfig` 該長什麼樣子

### 6.6.1 三個問題決定你的選擇

```
① 這個 key 的值是不是單純的字串／數字？
     是 → 用 StringRedisTemplate，結束。不要再想了。
     否 ↓
② 讀的人只有這一個 Java 服務嗎？
     不是（有 Python 腳本、Go 服務、要在 redis-cli 上看）
          → Jackson2JsonRedisSerializer<T>（不要 @class），型別由呼叫端決定
     是 ↓
③ 這個 template 會存很多種型別嗎？
     不會（例如一個 cache 只放 Product）→ Jackson2JsonRedisSerializer<Product>
     會                                  → GenericJackson2JsonRedisSerializer（含白名單）
```

**沒有任何一條路會走到 `JdkSerializationRedisSerializer`。**

### 6.6.2 本站建議的設定

```java
package com.example.lab10.shop.config;

import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.jsontype.BasicPolymorphicTypeValidator;
import com.fasterxml.jackson.databind.jsontype.PolymorphicTypeValidator;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;

@Configuration
public class RedisConfig {

    /**
     * 整站共用的 ObjectMapper（Redis 專用，不要跟 Web 層那顆混用）。
     * Web 層那顆是給「外部看的 JSON」用的，這一顆是給「自己存自己讀」用的，
     * 兩邊的需求相反：Web 不該吐 @class，這裡需要。
     */
    @Bean
    public ObjectMapper redisObjectMapper() {
        PolymorphicTypeValidator ptv = BasicPolymorphicTypeValidator.builder()
                .allowIfSubType("com.example.lab10.")
                .allowIfSubType("java.util.")
                .allowIfSubType("java.math.")
                .allowIfSubType("java.time.")
                .build();

        ObjectMapper m = new ObjectMapper();
        // 不靠 getter/setter，直接看欄位 —— DTO 可以不寫 setter
        m.setVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.ANY);
        // ⚠️ 關鍵：舊快取裡有新版沒有的欄位時，忽略它而不是拋例外（07 章 7.6）
        m.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
        m.registerModule(new JavaTimeModule());
        m.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        // @class：白名單版，不要用預設的 LaissezFaire
        m.activateDefaultTyping(ptv, ObjectMapper.DefaultTyping.NON_FINAL, JsonTypeInfo.As.PROPERTY);
        return m;
    }

    @Bean
    public RedisSerializer<Object> redisValueSerializer(ObjectMapper redisObjectMapper) {
        return new GenericJackson2JsonRedisSerializer(redisObjectMapper);
    }

    /**
     * ⚠️ bean 名稱必須是 redisTemplate —— 自動設定是用「名稱」判斷要不要退開的（6.2.1）。
     */
    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory,
                                                       RedisSerializer<Object> redisValueSerializer) {
        RedisTemplate<String, Object> t = new RedisTemplate<>();
        t.setConnectionFactory(factory);
        t.setKeySerializer(new StringRedisSerializer());        // ① key
        t.setValueSerializer(redisValueSerializer);             // ② value
        t.setHashKeySerializer(new StringRedisSerializer());    // ③ hash 欄位名
        t.setHashValueSerializer(redisValueSerializer);         // ④ hash 欄位值
        t.afterPropertiesSet();
        return t;
    }
}
```

**四個位置一個都不能漏。** 少設 `hashKeySerializer` 是最常見的遺漏——
`opsForValue()` 看起來都正常，直到某天有人用了 `opsForHash()`，
`redis-cli` 裡就出現一個欄位名是 `\xac\xed...` 的 hash。

### 6.6.3 ⚠️ 但真正的建議是：能用 `StringRedisTemplate` 就用它

上面那顆 `RedisTemplate<String, Object>` 存在的意義，是給「要存物件」的地方用的。
而本站後面九章裡，**真正需要它的地方非常少**：

| 用途 | 章 | 用什麼 |
|---|---|---|
| 分散式鎖（`SET NX PX` + Lua） | 09 | **`StringRedisTemplate`** |
| 限流計數（Lua） | 10 | **`StringRedisTemplate`** |
| 預扣庫存（Lua） | 12 | **`StringRedisTemplate`** |
| 冪等鍵 | 10 | **`StringRedisTemplate`** |
| 排行榜（ZSet） | 12 | **`StringRedisTemplate`** |
| 商品／使用者的物件快取 | 07 | `@Cacheable` + `RedisCacheManager`（07 章自己一套序列化設定） |

> 📌 **看出來了嗎**：需要「存 Java 物件」的地方幾乎只有**物件快取**，
> 而物件快取有 `@Cacheable` 那一整套（07 章），它的序列化是**分開設定**的。
>
> **所以 `RedisTemplate<String, Object>` 在一個設計良好的專案裡是少數派。**
> 這也是為什麼 00 章 0.3.3 那個事故值得記住：
> **大部分人第一次用 Redis 就從最難的那條路開始走。**

---

## 6.7 Lettuce 的連線模型

01 章 1.5.6 留下過一個奇怪的對照：**同一段忘了關 `Cursor` 的程式碼**，
在預設設定下完全沒事，換成連線池就炸。這一節把原因講清楚。

### 6.7.1 先看一個違反直覺的實測

40 個執行緒、每個做 2000 次 `GET`，共 8 萬次。三種連線設定：

```java
private LettuceConnectionFactory factory(boolean share, int maxActive) {
    GenericObjectPoolConfig<Object> pool = new GenericObjectPoolConfig<>();
    pool.setMaxTotal(maxActive);
    pool.setMaxIdle(maxActive);
    pool.setMaxWait(Duration.ofSeconds(3));
    LettuceClientConfiguration cfg = LettucePoolingClientConfiguration.builder()
            .poolConfig(pool).commandTimeout(Duration.ofSeconds(5)).build();
    LettuceConnectionFactory f = new LettuceConnectionFactory(
            new RedisStandaloneConfiguration("localhost", 16379), cfg);
    f.setShareNativeConnection(share);        // ← 這一章的主角
    f.afterPropertiesSet();
    return f;
}
```

旁邊另開一條連線，每 20 毫秒抓一次 `connected_clients`（`RedisProbe`，00 章 0.7.3）。

**輸出**：

```
═══ 6.7.1 40 個執行緒、8 萬次 GET，用掉幾條連線 ═══
（基準：這個 JVM 本來就有的連線數 = 3）
shareNativeConnection=true（Spring Boot 預設）    80,000 次 / 1,388 ms = 57,636 ops/s   最高連線數 = 4
shareNativeConnection=false, pool max-active=8   80,000 次 / 3,455 ms = 23,154 ops/s   最高連線數 = 12
shareNativeConnection=false, pool max-active=40  80,000 次 / 2,227 ms = 35,922 ops/s   最高連線數 = 52
```

| | 連線數 | 吞吐 | 相對 |
|---|---|---|---|
| **共用一條連線（預設）** | **+1** | **57,636 ops/s** | **1.00×** |
| 連線池 8 條 | +9 | 23,154 ops/s | 0.40× |
| 連線池 40 條 | +49 | 35,922 ops/s | 0.62× |

> 📌 **40 個執行緒共用 1 條連線，比 40 條連線快 1.6 倍。**
>
> 如果你的直覺是「連線越多越快」，那個直覺來自 **JDBC**：
> 一條資料庫連線一次只能跑一個查詢，所以要開池子。
>
> **Lettuce 不是這樣。** 它建在 Netty 上，一條 TCP 連線可以**同時**有很多命令在路上：
>
> ```
> 客戶端 ──→ GET a │ GET b │ GET c │ GET d ──→  Redis
> 客戶端 ←──        │ a=1 │ b=2 │ c=3 │ d=4 ←──
> ```
>
> 這正是 03 章 3.8 的 pipeline 概念，只是由 Netty 自動做掉了。
> **而 Redis 本來就是單執行緒**（03 章）——你開 40 條連線，那 40 條命令還是排隊一條一條執行。
> 多開的連線沒有增加任何平行度，只增加了：連線的記憶體、`epoll` 要照顧的 fd 數、
> 以及**每次借還連線的同步成本**。

### 6.7.2 `shareNativeConnection` 到底在共用什麼

`LettuceConnectionFactory.getConnection()` 的行為：

| `shareNativeConnection` | 一般命令 | 需要「獨佔」的命令 |
|---|---|---|
| `true`（**預設**） | **全部共用同一條** native 連線 | **另外拿一條專屬連線** |
| `false` | 每次從池子借一條（沒設池子就每次新建） | 同左 |

**哪些命令算「需要獨佔」？**

| 命令 | 為什麼 |
|---|---|
| `MULTI` / `EXEC` / `WATCH`（05 章） | 交易狀態綁在連線上 |
| `SUBSCRIBE` / `PSUBSCRIBE` | 訂閱後這條連線就進入訂閱模式 |
| `BLPOP` / `BRPOP` / `BLMOVE` 等阻塞命令 | 它會讓連線停在那裡 |
| **`SCAN` 開出來的 `Cursor`**（01 章 1.5.6） | 游標要一路用同一條連線走完 |
| pipeline（`executePipelined`） | 要獨佔一段回應序列 |

實測——`BLPOP` 卡 3 秒的同時，其他 `GET` 有沒有被卡住：

```
═══ 6.7.2 共用連線時，一個 BLPOP 會不會卡住所有人 ═══
開始前 connected_clients = 4
BLPOP 進行中 connected_clients = 5   ← 多了一條「專屬連線」
BLPOP 卡住的同時，另外 1000 次 GET 花了 274.5 ms —— 沒有被卡住
BLPOP 結束後 connected_clients = 5
```

> 📌 **兩個結論**：
> ① **共用連線不會被阻塞命令卡死**，Lettuce 會自己另開一條。
> ② **但那條連線是從「連線來源」拿的**：
> `shareNativeConnection=true` 時它直接新建；
> `shareNativeConnection=false` 時它**從池子借**——
> **借了不還（忘了 `close()` 的 `Cursor`），池子就會見底。**
>
> **這就是 01 章 1.5.6 那個對照的全部原因**：
> 同一段有 bug 的程式碼，在「不用池子」的預設設定下看不出來，在有池子時第 4 次就爆。

### 6.7.3 ⚠️ 實測：`commons-pool2` 不在，你的 pool 設定會安靜地不生效

`application-poolprops.yml`：

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 16379
      timeout: 500ms
      lettuce:
        pool:
          max-active: 4
          max-idle: 4
          min-idle: 1
          max-wait: 2s
```

```java
@SpringBootTest
@ActiveProfiles("poolprops")
class C2PoolPresenceTest {

    @Autowired LettuceConnectionFactory factory;

    @Test
    void isThePoolActuallyOn() {
        boolean pool2OnClasspath = ClassUtils.isPresent(
                "org.apache.commons.pool2.impl.GenericObjectPool", getClass().getClassLoader());
        Object cfg = factory.getClientConfiguration();
        System.out.println("commons-pool2 在 classpath 上嗎  : " + pool2OnClasspath);
        System.out.println("實際拿到的 ClientConfiguration   : " + cfg.getClass().getSimpleName());
        System.out.println("連線池有沒有啟用                 : "
                + (cfg instanceof LettucePoolingClientConfiguration ? "✅ 有" : "❌ 沒有"));
        System.out.println("命令逾時（這個有生效）           : " + factory.getClientConfiguration().getCommandTimeout());
    }
}
```

跑兩次，一次有 `commons-pool2`、一次沒有（把它從 classpath 拿掉）：

```bash
mvn -q -Dtest=C2PoolPresenceTest test              # 有 commons-pool2
mvn -q -Pnopool -Dtest=C2PoolPresenceTest test     # 沒有 commons-pool2
```

```
--- 有 commons-pool2 ---
commons-pool2 在 classpath 上嗎  : true
實際拿到的 ClientConfiguration   : DefaultLettucePoolingClientConfiguration
連線池有沒有啟用                 : ✅ 有
命令逾時（這個有生效）           : PT0.5S

--- 沒有 commons-pool2 ---
commons-pool2 在 classpath 上嗎  : false
實際拿到的 ClientConfiguration   : DefaultLettuceClientConfiguration
連線池有沒有啟用                 : ❌ 沒有 —— yml 裡那四行被安靜地忽略了
命令逾時（這個有生效）           : PT0.5S
```

**原因在 Boot 的 `LettuceConnectionConfiguration`**：

```java
private boolean isPoolEnabled(Pool pool) {
    Boolean enabled = pool.getEnabled();
    return (enabled != null) ? enabled
            : COMMONS_POOL2_AVAILABLE;     // ← 沒明講的話，看 classpath 上有沒有 commons-pool2
}
```

> ⚠️ **注意這個失敗的形狀**：
> **`timeout: 500ms` 生效了，`pool.*` 沒生效，而且沒有任何警告。**
> 同一段 yml，一半有效一半無效。
>
> 📌 **想確定它生效了，就把 `enabled: true` 明著寫出來**——
> 這樣 `commons-pool2` 不在的時候會**啟動失敗**（`NoClassDefFoundError`），
> 而不是安靜地降級。**會叫的失敗比安靜的失敗好。**

### 6.7.4 所以連線池該怎麼設

| 情況 | 建議 |
|---|---|
| **一般的 Spring Boot 服務** | **維持預設：`shareNativeConnection=true`，不用特別調池子**。它已經是最快的（6.7.1） |
| 程式裡有很多 `SCAN` / 阻塞命令 / `MULTI` / pipeline | 這些會各自拿專屬連線。**設一個池子**避免無限新建，`max-active` 抓「同時可能執行這類操作的執行緒數 + 緩衝」 |
| 用了 Redisson（09 章）做鎖 | Redisson 有**自己的**連線設定，跟這裡無關 |
| **無論哪一種** | **`max-wait` 一定要設**（預設 `-1` = 無限等）。它是 03 章那個「執行緒無聲堵住」的另一個入口 |

```yaml
spring:
  data:
    redis:
      lettuce:
        pool:
          enabled: true      # 明著寫，不要靠 classpath 猜（6.7.3）
          max-active: 16
          max-idle: 16
          min-idle: 4        # 預熱，避免第一批請求現場建連線
          max-wait: 200ms    # ⚠️ 預設是 -1（無限等）
```

> 📌 **`min-idle > 0` 需要 `time-between-eviction-runs` 才會真的維持住**
> （commons-pool2 是靠背景的 evictor 執行緒補到 `min-idle` 的）。
> Boot 有 `spring.data.redis.lettuce.pool.time-between-eviction-runs`，預設**沒開**。

### 6.7.5 Jedis vs Lettuce

同樣的 40 執行緒 × 2000 次 `GET`：

```
═══ 6.7.5 同一份工作量：Lettuce vs Jedis（40 執行緒 × 2000 次 GET）═══
Lettuce（共用一條連線，多工）     80,000 次 / 1,196 ms = 66,889 ops/s   最高連線數 = 2
Jedis  pool max-total=8          80,000 次 / 2,864 ms = 27,932 ops/s   最高連線數 = 10
Jedis  pool max-total=40         80,000 次 / 1,775 ms = 45,070 ops/s   最高連線數 = 50
```

| | Lettuce | Jedis |
|---|---|---|
| 連線模型 | **Netty，多工**，一條連線多個命令在路上 | **一條連線一次一個命令**，靠池子做平行 |
| 執行緒安全 | ✅ 連線本身就是 | ❌ 一條 `Jedis` 不能給兩個執行緒用 |
| 這份工作量 | **66,889 ops/s，2 條連線** | 45,070 ops/s，**50 條連線** |
| 非同步 / 響應式 | ✅ 原生支援（`RedisFuture`、Reactive） | ❌ |
| Cluster 拓樸更新 | ✅ 自動（13 章） | 手動或重連時 |
| Spring Boot 3 | **預設** | `spring.data.redis.client-type: jedis` + 加相依 |
| 什麼時候還會選 Jedis | 既有系統已經在用；或需要某個 Lettuce 沒包到的命令 | |

> 📌 **這一站全部用 Lettuce。** 你只需要記住一件事：
> **在 Jedis 的世界裡「連線數 = 平行度」，在 Lettuce 的世界裡不是。**
> 從 Jedis 搬到 Lettuce 時照抄那份 `max-total=200`，就是 6.7.1 那張表的第三列。

---

## 6.8 三層逾時

### 6.8.1 三層分別是什麼

```
       你的程式碼
          │
          │  ① 命令逾時 commandTimeout
          │     「命令送出去之後，等回應多久」        預設 60 秒
          ▼
     Lettuce / Netty
          │
          │  ② 連線逾時 SocketOptions.connectTimeout
          │     「TCP 三向交握等多久」                預設 10 秒
          ▼
        作業系統
          │
          │  ③ socket 層：TCP keepalive / TCP_USER_TIMEOUT
          │     「對面整台不見了，多久才發現」        預設：兩小時或更久
          ▼
        網路 ────→ Redis
```

**三層擋的是三種不同的故障**：

| 故障 | 現象 | 誰擋得住 |
|---|---|---|
| Redis 還活著，但在忙（big key、慢 Lua、`fork`） | 連線正常，命令沒有回應 | **① 命令逾時** |
| Redis 行程沒了 / port 沒人聽 | TCP `RST`，連線立刻斷 | 不需要逾時，馬上就知道（但見 6.8.4） |
| Redis 那台機器整個不見了（斷網、VM 被砍） | TCP 連線**看起來還在**，封包丟進黑洞 | **③ socket 層**（① 只能擋住單一命令） |
| 服務啟動時 Redis 還沒起來 | 連不上 | **② 連線逾時** |

### 6.8.2 第二層：連線逾時（實測）

連一個不會回應的位址（`10.255.255.1`，封包丟進黑洞）：

```java
for (Duration d : new Duration[]{Duration.ofSeconds(3), Duration.ofSeconds(1)}) {
    LettuceConnectionFactory f = factory("10.255.255.1",
            /* command */ Duration.ofSeconds(10), /* connect */ d, DisconnectedBehavior.DEFAULT);
    timeOneGet("command=10s, connect=" + d.toMillis() + "ms", new StringRedisTemplate(f));
}
// 反過來：連線逾時很長、命令逾時很短
```

```
═══ 6.8.2 第二層：連線逾時（連一個不會回應的位址）═══
  command=10s, connect=3000ms    3145 ms  ConnectTimeoutException: connection timed out after 3000 ms: /10.255.255.1:16379
  command=10s, connect=1000ms    1004 ms  ConnectTimeoutException: connection timed out after 1000 ms: /10.255.255.1:16379
  command=500ms, connect=10s      609 ms  ClosedChannelException: null
```

前兩行照設定走。**第三行才是重點**：

> ⚠️ **命令逾時比連線逾時短的時候，先到的是命令逾時——
> 而你拿到的例外是 `ClosedChannelException: null`。**
>
> 沒有訊息、沒有位址、沒有「逾時」兩個字。
> 光看這個例外，你不會知道問題是「連不上 Redis」。
>
> 📌 **所以 `connect-timeout` 要設得比 `timeout` 短**，
> 這樣連線階段的失敗才會用它自己的名字報出來。
> 這是本章第二條規約。

### 6.8.3 第一層：命令逾時（`docker pause` 實測）

`docker pause` 會把容器裡的行程**凍結**（`SIGSTOP`），
TCP 連線還在、還能收封包，但沒有人會回應——**這正好模擬「Redis 在忙」**
（04 章的 `fork` 尖峰、05 章的慢 Lua、03 章的 big key `DEL`）。

```java
@Test
void layer1_commandTimeout_whenServerIsFrozen() throws Exception {
    LettuceConnectionFactory f = factory("localhost", Duration.ofMillis(500), Duration.ofSeconds(1),
            DisconnectedBehavior.DEFAULT);
    StringRedisTemplate t = new StringRedisTemplate(f);
    t.opsForValue().set("t1:k", "v");
    timeOneGet("pause 之前", t);
    docker("pause", "redis-lab");
    timeOneGet("pause 之後（第 1 次）", t);
    timeOneGet("pause 之後（第 2 次）", t);
    docker("unpause", "redis-lab");
    timeOneGet("unpause 之後", t);
}
```

```
═══ 6.8.3 第一層：命令逾時（容器被 pause，連線還在、但沒有人回話）═══
  pause 之前                    1 ms  成功
  pause 之後（第 1 次）       503 ms  RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
  pause 之後（第 2 次）       506 ms  RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
  unpause 之後                  3 ms  成功
```

**每一次呼叫都等滿 500 毫秒。** 這裡有一件很重要的事：

> ⚠️ **命令逾時是「每次呼叫」的，不是「熔斷」。**
> Redis 凍住 60 秒，就是每一個請求都等 500 毫秒，**一個都不會被提早擋下來**。
>
> 200 個 Tomcat 執行緒 × 每個請求讀 3 次快取 = 每個請求**多 1.5 秒**。
> 逾時把「無限等」變成「等 0.5 秒」，但**它沒有把流量擋住**。
>
> **要擋住它，需要的是熔斷與降級——那是 08 章。**
> 這一章的責任是：**讓失敗發生、而且有名字。**

### 6.8.4 容器整個停掉：兩種 `disconnectedBehavior`

```java
LettuceConnectionFactory queueing  = factory(..., DisconnectedBehavior.DEFAULT);
LettuceConnectionFactory rejecting = factory(..., DisconnectedBehavior.REJECT_COMMANDS);
docker("stop", "redis-lab");
```

```
═══ 6.8.4 容器整個停掉：兩種 disconnectedBehavior ═══
  停掉之前 DEFAULT                1 ms  成功
  停掉之後 DEFAULT              507 ms  RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
  停掉之後 DEFAULT（再一次）    506 ms  RedisCommandTimeoutException: Command timed out after 500 millisecond(s)
  停掉之後 REJECT_COMMANDS        1 ms  RedisException: Currently not connected. Commands are rejected.
  停掉之後 REJECT_COMMANDS        0 ms  RedisException: Currently not connected. Commands are rejected.
  重新啟動之後 DEFAULT            2 ms  成功
  重新啟動之後 REJECT             1 ms  成功
```

期間 Lettuce 的日誌：

```
ConnectionWatchdog -- Reconnecting, last destination was localhost/127.0.0.1:16379
ConnectionWatchdog -- Cannot reconnect to [localhost:16379]: Connection initialization timed out after 500 ms
...
ReconnectionHandler -- Reconnected to localhost/<unresolved>:16379
```

> 📌 **這是這一章最值得記住的一張對照**：
>
> | | `DEFAULT`（預設） | `REJECT_COMMANDS` |
> |---|---|---|
> | Redis 明明已經不在了 | **還是把命令收下來排隊**，等到逾時才失敗 | **立刻拒絕** |
> | 每個請求耗掉 | **507 ms** | **1 ms** |
> | 執行緒被佔用 | 507 ms × 每個請求的快取次數 | 幾乎沒有 |
> | Redis 回來以後 | 自動恢復 ✅ | 自動恢復 ✅ |
>
> **500 倍的差別，只差一個設定。**
>
> 預設值 `DEFAULT` 的理由是「短暫斷線時不要讓命令掉」——
> 對 0.2 秒的重連抖動來說是對的；
> 對「Redis 掛了 10 分鐘」來說，它讓你的每一個執行緒都陪跑滿逾時。
>
> ⚠️ **但 `REJECT_COMMANDS` 不是免費的**：連線抖動的那一瞬間，
> 本來會自動補上的命令現在會失敗。
> **所以它必須跟降級邏輯一起上線**（08 章）——
> 你要先有「快取失敗時怎麼辦」的答案，才適合讓它快速失敗。

### 6.8.5 命令堆在哪裡：`requestQueueSize`

上一節那些「被收下來排隊」的命令放在哪？放在 Lettuce 的 **request queue** 裡，
而它的預設大小是 **`Integer.MAX_VALUE`（21 億）**。

```java
private LettuceConnectionFactory factory(int queueSize) {
    ClientOptions.Builder opts = ClientOptions.builder();
    if (queueSize > 0) opts.requestQueueSize(queueSize);
    ...commandTimeout(Duration.ofSeconds(10))    // 刻意設長，讓命令留在佇列裡
}
// docker pause → 開 2000 個執行緒各送一次 GET → 看有幾個被擋下來
```

```
═══ 6.8.5 Redis 沒回應時，命令堆在哪裡 ═══
預設 requestQueueSize（2^31-1）   送出 2,000 次：立刻被擋掉     0 次，還卡在佇列裡 2,000 次
requestQueueSize = 200           送出 2,000 次：立刻被擋掉 1,800 次，還卡在佇列裡   200 次
```

被擋下來的那些拿到的是：

```
io.lettuce.core.RedisException: Internal stack size exceeded: 200.
Commands are not accepted until the stack size drops.
```

> ⚠️ **預設值的意思是：Redis 不回應的期間，你送多少命令它就吃多少，全部放在 heap 上。**
> 每一個排隊的命令都握著它的參數（key、value——**如果你剛好在寫入 big value，就是那整包**）
> 與一個 `CompletableFuture`。
>
> **這是一條從「Redis 變慢」通往「應用 OOM」的路。**
> 而且順序是：Redis 慢 → 命令堆積 → heap 壓力 → **GC 變頻繁 → 你的應用也變慢** → 堆積更快。
>
> 📌 **設一個有限的 `requestQueueSize`**（例如 `1000`），
> 它是**應用層的最後一道保險絲**。跟 `max-wait`、`timeout` 一樣，
> 「有上限」比「上限多少」重要。

### 6.8.6 第三層：socket 層——為什麼前兩層不夠

前兩層擋的都是「這一次呼叫」。但有一種故障它們處理不了：

> **對面那台機器整個不見了**（網路分區、VM 被砍、雲端的網卡被拔）——
> **沒有 `RST`、沒有 `FIN`，你的 TCP 連線在作業系統眼裡還是 `ESTABLISHED`。**

這種狀態下：

- 命令逾時**還是會生效**（每次呼叫等 500 毫秒後失敗）✅
- 但 Lettuce **不知道要重連**——它以為連線好好的。
- 於是 Redis 那邊就算換了一台新機器接手（13 章的 Sentinel 切換），
  **你這條連線也不會切過去**，它會一直對著一個不存在的對象送封包。
- 作業系統預設要**兩小時**（Linux 的 `tcp_keepalive_time`）才會開始探測。

所以要在 socket 層打開兩個東西：

```java
SocketOptions socket = SocketOptions.builder()
        .connectTimeout(Duration.ofSeconds(2))                    // ② 第二層
        .keepAlive(SocketOptions.KeepAliveOptions.builder()
                .enable()
                .idle(Duration.ofSeconds(30))     // 閒置 30 秒後開始探測
                .interval(Duration.ofSeconds(5))  // 每 5 秒探一次
                .count(3)                         // 連續 3 次沒回應就判定斷線
                .build())
        .build();
```

| 設定 | 作用 | 注意 |
|---|---|---|
| `keepAlive().enable()` | 打開 TCP keepalive | **Lettuce 預設是關的** |
| `.idle` / `.interval` / `.count` | 細部參數，決定「多久發現」（這裡是 30 + 5×3 = **45 秒**） | ⚠️ 這三個細項需要 **Java 11+ 的 NIO**，或 netty 的 **epoll / kqueue / io_uring** 原生傳輸。不支援時只會退回作業系統的預設值（可能是兩小時） |
| `SocketOptions.tcpUserTimeout(...)` | 「送出去的資料多久沒被確認就斷線」，比 keepalive 更直接 | ⚠️ **只有 Linux + epoll / io_uring 支援**。macOS 上設了也不會生效 |

> 📌 **判斷有沒有生效的方法**：在 Linux 上 `ss -o state established '( dport = :6379 )'`，
> 看有沒有 `timer:(keepalive,...)` 這一段。沒有就是沒開起來。
>
> ⚠️ **本機（macOS + Docker Desktop）測不出這一層。**
> 因為 `docker pause` / `docker stop` 都會讓封包有明確的去處。
> 要重現「黑洞」，需要在 Linux 上用 `iptables -A INPUT -p tcp --dport 16379 -j DROP`
> ——**這是本章練習四**。

### 6.8.7 四種故障、四道防線

| 故障 | 現象 | 擋它的設定 | 沒設的後果 |
|---|---|---|---|
| Redis 在忙（慢命令、`fork`、慢 Lua） | 連線在，不回應 | **`timeout`（命令逾時）** | 等 60 秒（03 章 3.7.2） |
| 啟動時 Redis 還沒起來 | 連不上 | **`connect-timeout`** | 每次等 10 秒；且若比 `timeout` 長，例外會變成 `ClosedChannelException: null` |
| Redis 掛了 | 連線斷、port 沒人聽 | **`disconnectedBehavior`** | 每個請求還是等滿 `timeout`（6.8.4） |
| 整台機器不見了 | 連線「看起來還在」 | **TCP keepalive / `tcpUserTimeout`** | 連線永遠不重連，Sentinel 切換後也切不過去 |
| （以上皆是） | 命令堆積 | **`requestQueueSize`** | 堆到 OOM（6.8.5） |
| （以上皆是） | 借不到連線 | **`pool.max-wait`** | 無限等（6.2.2） |

---

## 6.9 落地：shop-service 的連線與序列化設定

### 6.9.1 `application.yml`

00 章 0.7.2 刻意留了一份「什麼都沒設」的設定。現在把它補完：

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 16379
      client-name: shop-service     # CLIENT LIST 上看得出是誰（03 章 3.6）
      timeout: 500ms                # ① 命令逾時（6.8.3）
      connect-timeout: 2s           # ② 連線逾時，⚠️ 一定要比 timeout 長（6.8.2）
      lettuce:
        pool:
          enabled: true             # 明著寫，不要靠 classpath 猜（6.7.3）
          max-active: 16
          max-idle: 16
          min-idle: 4
          max-wait: 200ms           # ⚠️ 預設 -1 = 無限等
          time-between-eviction-runs: 30s   # min-idle 要靠它才維持得住
        shutdown-timeout: 200ms
  datasource:
    url: jdbc:h2:mem:lab10;DB_CLOSE_DELAY=-1
  jpa:
    hibernate.ddl-auto: update
logging:
  level:
    root: WARN
    com.example.lab10: INFO
```

⚠️ **注意 `connect-timeout: 2s` 比 `timeout: 500ms` 長。**
6.8.2 的第三行實測說反了會怎樣：你會拿到 `ClosedChannelException: null`。
這裡的取捨是——「連線建立」本來就比「一次命令」慢，
**逼它在 500 毫秒內建好連線，等於每次重連都必定失敗。**

### 6.9.2 `RedisConfig`：yml 管不到的那些

`keepalive`、`disconnectedBehavior`、`requestQueueSize` **在 yml 裡沒有對應的設定鍵**，
只能用 `LettuceClientConfigurationBuilderCustomizer`——
**而不是自己 `new` 一個 `LettuceConnectionFactory`**（6.2.3 的理由）。

```java
package com.example.lab10.shop.config;

@Configuration
public class RedisConfig {

    @Bean
    public ObjectMapper redisObjectMapper() { /* 6.6.2 那一段，原封不動 */ }

    @Bean
    public RedisSerializer<Object> redisValueSerializer(ObjectMapper redisObjectMapper) {
        return new GenericJackson2JsonRedisSerializer(redisObjectMapper);
    }

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory,
                                                       RedisSerializer<Object> redisValueSerializer) {
        /* 6.6.2 那一段，四個序列化器 */
    }

    /**
     * yml 管得到：host / port / timeout / connect-timeout / pool / client-name。
     * yml 管不到（只能在這裡設）：keepalive、disconnectedBehavior、requestQueueSize。
     */
    @Bean
    public LettuceClientConfigurationBuilderCustomizer lettuceCustomizer() {
        return builder -> {
            SocketOptions socket = SocketOptions.builder()
                    .connectTimeout(Duration.ofSeconds(2))
                    .keepAlive(SocketOptions.KeepAliveOptions.builder()
                            .enable()
                            .idle(Duration.ofSeconds(30))
                            .interval(Duration.ofSeconds(5))
                            .count(3)
                            .build())                       // 6.8.6
                    .build();
            builder.clientOptions(ClientOptions.builder()
                    .socketOptions(socket)
                    .disconnectedBehavior(ClientOptions.DisconnectedBehavior.DEFAULT)  // 08 章會改
                    .requestQueueSize(1000)                 // 6.8.5
                    .timeoutOptions(TimeoutOptions.enabled(Duration.ofMillis(500)))
                    .build());
        };
    }
}
```

⚠️ **`disconnectedBehavior` 這裡先留 `DEFAULT`**。
6.8.4 證明了 `REJECT_COMMANDS` 快 500 倍，但它要跟降級邏輯一起上線——
**08 章會把它跟 `CacheErrorHandler`、熔斷器一起改掉。**

📌 **`LettuceClientConfigurationBuilderCustomizer` 可以有多個 bean，Spring Boot 會全部套用。**
所以 03 章 3.6 那個只設 `clientName` 的 customizer 可以留著，
兩個 bean 各管各的。**但如果兩個都設同一個屬性，後套用的會蓋掉前一個**——
`clientOptions(...)` 是整包替換，特別容易互相蓋掉。

### 6.9.3 驗收

```java
@SpringBootTest
class S9ShopConfigTest {

    @Autowired RedisTemplate<String, Object> redisTemplate;
    @Autowired StringRedisTemplate srt;
    @Autowired LettuceConnectionFactory factory;

    @Test
    void theWholeThing() {
        Product p = new Product(1001L, "無線耳機", new BigDecimal("2490"),
                LocalDateTime.of(2026, 9, 17, 10, 30));
        redisTemplate.opsForValue().set("shop:product:1001", p);
        redisTemplate.opsForHash().put("shop:cart:u8842", "1001", 2);
        redisTemplate.opsForValue().set("shop:hot", new ArrayList<>(List.of(p)));
        // 用 StringRedisTemplate 再讀一次 —— 印出來的就是 redis-cli 上看到的東西
        ...
    }
}
```

```
═══ 6.9.3 落地設定：驗收 ═══
① key 在 redis-cli 上的樣子   : shop:product:1001, shop:cart:u8842, shop:hot
② value                       : {"@class":"com.example.lab10.ch06.dto.Product","id":1001,
                                 "name":"無線耳機","price":["java.math.BigDecimal",2490],
                                 "shelfAt":"2026-09-17T10:30:00"}
③ hash 欄位名 / 欄位值        : {1001=2}
④ 讀回來的型別                : Product / Integer / ArrayList
--- 逾時與連線設定 ---
命令逾時（yml）               : PT0.5S
連線逾時（customizer）        : PT2S
TCP keepalive                 : true（idle=PT30S, interval=PT5S, count=3）
disconnectedBehavior          : DEFAULT
requestQueueSize              : 1000
連線池                        : DefaultLettucePoolingClientConfiguration
client-name（yml）            : shop-service
```

**跟 00 章 0.3.3 的輸出對照著看**：

| | 00 章（預設設定） | 現在 |
|---|---|---|
| key | `\xac\xed\x00\x05t\x00\x0cproduct:1001` | `shop:product:1001` |
| value | 493 bytes 的二進位 | 可讀的 JSON |
| `SCAN shop:*` | ❌ 找不到 | ✅ |
| 改套件名 | ❌ 全部讀不回來 | ⚠️ 還是會（**07 章 7.6 處理**） |
| Redis 卡住 | 等 60 秒、沒有例外 | 500 ms，`RedisCommandTimeoutException` |

### 6.9.4 本章的三條規約（接續 05 章 5.10 的第 9 條）

10. **不要自己 `new LettuceConnectionFactory`**——要客製就用 `LettuceClientConfigurationBuilderCustomizer`，
    否則 yml 裡的設定會安靜失效（6.2.3）。
11. **`connect-timeout` 必須比 `timeout` 長**，否則連線階段的失敗會變成 `ClosedChannelException: null`（6.8.2）。
12. **要放進 Redis 的集合，一律轉成 `ArrayList` / `HashMap` / `HashSet`**——
    `List.of(...)`、`Stream.toList()` 寫得進去、讀不回來（6.5.3）。

---

## 6.10 常見誤區

**① 「`RedisTemplate` 的預設設定應該是合理的」**

它的四個序列化器全是 JDK（6.3.2），而 JDK 序列化在快取上**沒有一個場景是最佳解**（6.4）。
Spring Data Redis 的文件自己也建議換掉，**但預設值為了相容性一直沒有動。**

**② 「加了 `serialVersionUID` 就解決版本問題了」**

它把「大聲炸掉」換成「安靜地錯」（6.4.2）。新欄位變成 `null`，
而你要在幾天後的一個 `NullPointerException` 裡才發現。

**③ 「Jackson 存下去就一定讀得回來」**

`Jackson2JsonRedisSerializer<Object>` 讀回 `LinkedHashMap`（6.5.1），
`List.of(...)` 根本讀不回來（6.5.3），
自己傳 `ObjectMapper` 會把 `@class` 關掉（6.5.5）。**三種都不會在寫入時報錯。**

**④ 「`@class` 只是多幾個 bytes」**

它是 71 bytes / 筆（一千萬筆 = 677 MB），
而且**它把你的 Java 類名變成了資料格式的一部分**——
改套件名就是一次資料格式變更（07 章 7.6）。

**⑤ 「default typing 開著沒關係，反正 Redis 在內網」**

6.5.6：Redis 裡的字串決定你 `new` 出哪一個類別。
**內網不是信任邊界**，而且「能寫進這台 Redis 的人」比你想的多（維運腳本、其他服務、測試環境的連線字串）。

**⑥ 「連線池開大一點比較快」**

6.7.1 實測：**共用一條連線比 40 條快 1.6 倍。** Lettuce 是多工的，
「連線數 = 平行度」是 JDBC 的世界觀。

**⑦ 「`spring.data.redis.lettuce.pool.*` 設了就會生效」**

`commons-pool2` 不在 classpath 上時**整段被忽略，而且沒有警告**（6.7.3）。

**⑧ 「設了 `timeout` 就安全了」**

那只是第一層。連不上時輪到 `connect-timeout`（預設 10 秒），
機器整個不見時輪到 TCP keepalive（預設**兩小時**），
命令堆積時輪到 `requestQueueSize`（預設 **21 億**），
借不到連線時輪到 `pool.max-wait`（預設**無限**）。

**⑨ 「Redis 掛了，命令應該會馬上失敗」**

6.8.4：預設行為是**收下來排隊等逾時**，一個請求 507 毫秒。
`REJECT_COMMANDS` 才是 1 毫秒。

**⑩ 「逾時設短了就不會被 Redis 拖垮」**

逾時是**每次呼叫**的，不是熔斷（6.8.3）。Redis 卡 60 秒，
就是接下來 60 秒裡**每一個請求**都多花 500 毫秒。要擋住流量得靠 08 章。

**⑪ 「自己 `new` 一個 `LettuceConnectionFactory` 比較好控制」**

yml 裡的 `timeout`、`pool`、`client-name` 會全部失效（6.2.3），而且不會報錯。

**⑫ 「bean 名稱無所謂」**

自動設定是用 `@ConditionalOnMissingBean(name = "redisTemplate")` **按名稱**判斷的（6.2.1）。
方法名取成 `myRedisTemplate`，你會拿到兩個 bean。

---

## 6.11 本章小結

> **Spring Data Redis 是一層很薄的抽象，而它的每一個預設值，
> 都是為了「不要破壞舊專案」而不是「適合你的專案」而存在的。**

三件事，三個預設值：

| | 預設 | 你該改成 |
|---|---|---|
| **存什麼** | 四個 `JdkSerializationRedisSerializer` | key 用 `String`，值用 Jackson（6.6） |
| **怎麼連** | 共用一條連線（**這個預設是對的**） | 大多數情況維持原樣；只把 `max-wait` 補上 |
| **等多久** | 60 秒 / 10 秒 / 兩小時 / 無限 / 21 億 | 500 ms / 2 s / 45 s / 200 ms / 1000（6.9.1） |

而三件事底下是同一句話——**00 章到 05 章反覆出現的那一句**：

> **Java 這一側看到的是一個方法呼叫，Redis 那一側看到的是完全不同的東西。**
>
> `set(key, product)` 在 Java 這一側是一行，在 Redis 那一側是
> **493 bytes 的二進位、一個敲不出來的 key、一條共用的 TCP 連線、以及一段可能等 60 秒的空白。**

### 6.11.1 驗收清單

- [ ] 說出一次 `opsForHash().put()` 用到哪三個序列化器。
- [ ] 說出 `\xac\xed\x00\x05` 這五個位元組分別是什麼，以及它讓哪些維運操作失效。
- [ ] 說出「寫了 `serialVersionUID`」與「沒寫」在加一個欄位時各會發生什麼，並說出哪個更危險。
- [ ] 說出 `Jackson2JsonRedisSerializer` 與 `GenericJackson2JsonRedisSerializer` 的差別與各自的適用場景。
- [ ] 說出為什麼 `List.of(...)` 存得進去、讀不回來。
- [ ] 說出把自己的 `ObjectMapper` 傳進 `GenericJackson2JsonRedisSerializer` 會關掉哪兩件事。
- [ ] 說出為什麼 40 個執行緒共用一條連線，比 40 條連線還快。
- [ ] 說出 `shareNativeConnection=true` 時，哪些命令仍會拿到專屬連線。
- [ ] 說出三層逾時各擋哪一種故障，以及為什麼 `connect-timeout` 要比 `timeout` 長。
- [ ] 說出 Redis 斷線時，`DEFAULT` 與 `REJECT_COMMANDS` 的差別（含數量級）。

### 6.11.2 本章練習

**練習一（15 分鐘）**：把 00 章 0.3.3 那個事故**修好**。
用 6.6.2 的 `RedisConfig` 重跑一次 `A3SerializationTest`，
確認：① `redis-cli` 上的 key 是可讀的；② `SCAN product:*` 找得到它；
③ 把 `@class` 的套件名手動改掉之後**還是會爆**——
把那個例外的型別與訊息記下來，**07 章 7.6 要用**。

**練習二（20 分鐘）**：把 6.4 的四個類別（`va`/`vb`/`wa`/`wb`）改成 JSON 版，
用 `Jackson2JsonRedisSerializer<Product>` 重跑「加一個欄位」與「刪一個欄位」。
**兩個都應該不會爆。** 接著把 `FAIL_ON_UNKNOWN_PROPERTIES` 打開再跑一次，
**「刪一個欄位」會爆**——記住這個開關的位置，它是 07 章 7.6 的主角之一。

**練習三（20 分鐘）**：重跑 6.7.1，但把執行緒數從 40 開到 **200**，
並加上第四組設定：`shareNativeConnection=false, max-active=200`。
**記錄四組的 ops/s 與 `connected_clients`**，畫成一張表。
接著用 `redis-cli INFO clients` 看 `maxclients` 是多少——
**算算看你的連線池設定在幾台應用實例之後會打爆它。**

**練習四（進階，30 分鐘，需要 Linux）**：重現 6.8.6 那個「黑洞」。
在 Linux 上跑 Redis，建好連線之後執行
`sudo iptables -A INPUT -p tcp --sport 6379 -j DROP`，
然後觀察：① 命令要多久才失敗；② `ss -o` 裡的 keepalive timer；
③ 把 `keepAlive` 關掉再做一次，**看 Lettuce 要多久才決定重連**。
把 `iptables -D INPUT ...` 記得刪掉。

**練習五（進階，30 分鐘）**：寫一個**會安靜出錯**的例子並修好它。
定義一個 `Order` 類別，裡面有 `Map<String, Object> attributes`，
用 `GenericJackson2JsonRedisSerializer` 存一筆 `attributes = Map.of("gift", true)`，
讀回來看看 `attributes` 裡面是什麼型別。
**接著把 `Map.of` 換成 `HashMap`，比較兩次的 JSON。**

---

## 6.12 下一章預告

這一章解決了「存進去的是什麼」。07 章解決「誰去存、什麼時候存、什麼時候清掉」——
也就是把 `@Cacheable` 接到 Redis 上。

而它會立刻遇到三個這一章埋下的問題：

- **改版之後讀不回來**（6.4、6.5.4）。`@Cacheable` 遇到反序列化失敗**不會當成快取沒命中**，
  它會把例外往上丟——**每一個請求都 500**。7.6 會把它變成「當作沒命中」。
- **快取 `null`**。6.5.5 提過的 `NullValueSerializer`——7.5 會把 Redis 裡那 64 bytes 挖出來，
  你會發現 `RedisCache` **根本沒用你設定的序列化器**，以及為什麼「快取 null」少設一件事就會讓新商品半小時查不到。
- **`@CacheEvict` 與 `@Transactional` 的順序**。
  7.7 會用兩個執行緒重現「清了快取、交易還沒提交、另一個人把舊值寫回去」——
  **然後那個舊值會一直留在快取裡，直到 TTL 到期。**

還有三個災難要處理：**穿透、擊穿、雪崩**——04 章 4.8.2 的冷啟動雪崩會在那裡收尾。
