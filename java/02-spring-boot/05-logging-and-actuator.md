# 第 05 章：日誌與可觀測性

> 半夜三點，手機響了：「訂單服務有使用者反應付款後訂單沒建立。」
>
> 你打開日誌平台，搜尋「error」，跳出 12 萬筆。
> 你不知道是哪個使用者、不知道哪個請求、不知道那筆請求走過哪些方法。
> 你只能一行一行看，然後在四十分鐘後放棄，回覆「查不到，請客戶重試」。
>
> **這一章要讓你不再有這種夜晚。**
>
> 可觀測性不是「上線後有空再補」的東西。它是**在寫程式的當下就決定好的**：
> 你有沒有記錄追蹤 ID、有沒有把關鍵欄位寫進去、有沒有暴露正確的指標。
> 事故發生時才想補，就來不及了。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說明 SLF4J、Logback、Log4j2、JUL 的關係，以及「橋接器」在做什麼。
- 寫出正確的日誌敘述：參數化、選對等級、不要吞例外、不要記敏感資料。
- 設計一套團隊能遵守的**日誌等級規範**，並說明每一層該記什麼。
- 用 `application.yml` 完成八成的日誌設定，知道什麼時候才需要 `logback-spring.xml`。
- 寫出完整的 `logback-spring.xml`：Appender、Pattern、滾動策略、`<springProfile>`、非同步。
- 說明**結構化日誌**的價值，並用兩種方式產出 JSON 日誌。
- 用 MDC 實作追蹤 ID，並解決「跨執行緒遺失」與「執行緒池污染」兩個問題。
- 說明 Micrometer Tracing 與 traceId / spanId 的關係。
- 設計敏感資料遮蔽機制，避免個資與金鑰進入日誌。
- 熟練 Actuator 的核心端點，並知道每一個在什麼情境用得上。
- 寫自訂 `HealthIndicator`，並正確設定 K8s 的 liveness / readiness 探針。
- 用 Micrometer 埋業務指標（Counter / Timer / Gauge），並避開**標籤基數爆炸**這個大坑。
- 把服務接上 Prometheus + Grafana，並寫出有意義的告警規則。
- 正確保護 Actuator：獨立 port、白名單、Security。

---

## 5.2 先看見痛：一次查不到東西的事故

### 事故現場的日誌長這樣

```
2026-08-18 03:12:44.102  INFO 1 --- [nio-8080-exec-3] c.e.shop.order.OrderService : 開始建立訂單
2026-08-18 03:12:44.118  INFO 1 --- [nio-8080-exec-7] c.e.shop.order.OrderService : 開始建立訂單
2026-08-18 03:12:44.121 ERROR 1 --- [nio-8080-exec-3] c.e.shop.payment.PaymentService : 付款失敗
2026-08-18 03:12:44.133  INFO 1 --- [nio-8080-exec-9] c.e.shop.order.OrderService : 開始建立訂單
2026-08-18 03:12:44.140  INFO 1 --- [nio-8080-exec-7] c.e.shop.order.OrderService : 訂單建立成功
2026-08-18 03:12:44.155 ERROR 1 --- [nio-8080-exec-9] c.e.shop.payment.PaymentService : 付款失敗
```

**你能從這段日誌回答下列問題嗎？**

| 問題 | 能不能回答 |
|---|---|
| 哪個使用者的訂單失敗了？ | ❌ 沒有使用者資訊 |
| 失敗的是哪張訂單？ | ❌ 沒有訂單 ID |
| 為什麼付款失敗？ | ❌ 只有「付款失敗」四個字，沒有原因、沒有堆疊 |
| `exec-3` 這個請求完整走過哪些方法？ | ⚠️ 只能靠執行緒名稱猜，而且執行緒會被重複使用 |
| 這是第幾次重試？ | ❌ 完全看不出來 |
| 從進 API 到失敗總共花多久？ | ❌ 只能自己算時間戳 |

**這份日誌的資訊量約等於零。** 它只證明「有事情發生過」。

### 同一段程式，加上可觀測性之後

```json
{"timestamp":"2026-08-18T03:12:44.102Z","level":"INFO","logger":"c.e.shop.order.OrderService","message":"開始建立訂單","traceId":"a3f8c21b9d4e5f60","spanId":"1a2b3c4d","userId":"u-88214","orderId":null,"amount":1280.00,"paymentMethod":"CREDIT_CARD","service":"shop-service","env":"prod","version":"1.4.2"}
{"timestamp":"2026-08-18T03:12:44.121Z","level":"ERROR","logger":"c.e.shop.payment.PaymentService","message":"付款失敗","traceId":"a3f8c21b9d4e5f60","spanId":"5e6f7a8b","userId":"u-88214","orderId":1001,"gateway":"stripe","errorCode":"card_declined","attempt":1,"latencyMs":312,"stack_trace":"com.example.shop.payment.PaymentException: card_declined\n\tat ..."}
```

現在你可以：

```
搜尋 traceId:"a3f8c21b9d4e5f60"   → 這次請求的所有日誌，依序排好
搜尋 userId:"u-88214"            → 這個使用者今天做過什麼
搜尋 errorCode:"card_declined"    → 今天有幾筆是卡片被拒
搜尋 gateway:"stripe" AND level:ERROR AND latencyMs:>1000  → Stripe 是不是變慢了
```

**同一份日誌從「無法查詢的文字」變成「可以查詢的資料」。** 這就是這一章要做的事。

### 可觀測性的三根支柱

```
┌──────────────┬──────────────┬──────────────┐
│  Logs 日誌    │ Metrics 指標  │ Traces 追蹤   │
│              │              │              │
│ 「發生了什麼」  │ 「數字是多少」  │ 「經過了哪裡」  │
│              │              │              │
│ 單一事件的細節 │ 聚合後的趨勢   │ 一次請求的路徑 │
│              │              │              │
│ 高基數        │ 低基數        │ 高基數        │
│ 成本高        │ 成本低        │ 通常抽樣      │
│              │              │              │
│ 用途：        │ 用途：        │ 用途：        │
│ 找出根因      │ 發現異常、告警  │ 找出慢在哪裡   │
└──────────────┴──────────────┴──────────────┘
        ↑              ↑              ↑
   Logback +      Micrometer +    Micrometer
   結構化日誌      Prometheus      Tracing
```

**三者由 `traceId` 串在一起**——這是本章最重要的一條線。

---

## 5.3 日誌門面與實作

### 為什麼會有這麼多日誌函式庫

```
2001  Log4j 1.x          第一個廣泛使用的日誌函式庫
2002  JUL (java.util.logging)   JDK 1.4 內建，但功能貧弱
2002  Commons Logging    第一個「門面」，但 ClassLoader 問題多
2006  SLF4J              Log4j 作者重新設計的門面 ★ 現在的標準 ★
2006  Logback            同一位作者的 Log4j 繼任者，SLF4J 的原生實作
2014  Log4j 2            Log4j 1.x 的重寫版，效能更好
```

### 門面與實作的分工

```
                你的程式碼
                     │
                     │ import org.slf4j.Logger;
                     ▼
        ┌────────────────────────────┐
        │  SLF4J API（門面）           │  ← 只有介面，不做事
        │  Logger / LoggerFactory     │
        └────────────┬───────────────┘
                     │ 執行期綁定
        ┌────────────┴───────────────┐
        │                            │
        ▼                            ▼
┌───────────────┐          ┌───────────────┐
│   Logback     │          │   Log4j 2     │
│（Spring Boot   │          │（要自己換）    │
│  預設）        │          │               │
└───────────────┘          └───────────────┘
```

**為什麼要門面？** 因為你用的函式庫也在寫日誌：

```
你的程式         → SLF4J
Spring Framework → 用的是 Commons Logging（spring-jcl 已重導向到 SLF4J）
Hibernate        → 用 JBoss Logging
Tomcat           → 用 JUL
某個舊函式庫      → 用 Log4j 1.x
```

**如果沒有統一，你的日誌檔會有五種格式、五個設定檔、五種輸出位置。**

### 橋接器：把別人的日誌抓過來

```
   Log4j 1.x 的呼叫  ──▶  log4j-over-slf4j     ──┐
   JUL 的呼叫        ──▶  jul-to-slf4j         ──┼──▶  SLF4J  ──▶  Logback
   Commons Logging   ──▶  jcl-over-slf4j       ──┘
```

Spring Boot 的 `spring-boot-starter-logging` **預設就幫你裝好這三個橋接器**：

```bash
$ ./mvnw dependency:tree -Dincludes=org.slf4j,ch.qos.logback
[INFO] +- org.springframework.boot:spring-boot-starter-logging:jar:3.5.0
[INFO] |  +- ch.qos.logback:logback-classic:jar:1.5.x
[INFO] |  |  \- ch.qos.logback:logback-core:jar:1.5.x
[INFO] |  +- org.apache.logging.log4j:log4j-to-slf4j:jar:2.24.x   ← Log4j2 → SLF4J
[INFO] |  \- org.slf4j:jul-to-slf4j:jar:2.0.x                     ← JUL → SLF4J
```

> ⚠️ **橋接器與實作不能同時存在同一個系統**。
> 例如同時有 `log4j-over-slf4j`（Log4j → SLF4J）和 `slf4j-log4j12`（SLF4J → Log4j），
> 會造成**無限迴圈 → StackOverflowError**。
> 出現 `SLF4J: Class path contains multiple SLF4J bindings` 警告時一定要處理。

### 換成 Log4j 2

Logback 對絕大多數專案都夠用。真的要換（例如需要 Log4j2 的非同步效能）：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
    <exclusions>
        <exclusion>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-logging</artifactId>
        </exclusion>
    </exclusions>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-log4j2</artifactId>
</dependency>
```

> **本課用 Logback**（Spring Boot 預設），因為它與 `<springProfile>` 整合最好。

---

## 5.4 正確的日誌寫法

### 規則 1：用參數化，不要字串拼接

```java
// ❌ 字串拼接
log.debug("處理訂單 " + orderId + "，金額 " + amount);
```

**問題**：即使日誌等級是 INFO（這行不會輸出），**字串拼接還是執行了**。
高頻方法裡這是實際的效能損失（產生大量短命字串，增加 GC 壓力）。

```java
// ✅ 參數化
log.debug("處理訂單 {}，金額 {}", orderId, amount);
```

SLF4J 只有在確定要輸出時才做字串組裝。

```java
// ✅ 參數計算本身很貴時，加上等級判斷
if (log.isDebugEnabled()) {
    log.debug("訂單明細：{}", objectMapper.writeValueAsString(order));   // 序列化很貴
}
```

### 規則 2：例外一定要放在最後一個參數（不要放進 `{}`）

```java
// ❌ 只印出訊息，堆疊完全遺失
log.error("付款失敗：{}", e.getMessage());

// ❌ 例外被當成參數填進 {}，堆疊還是遺失
log.error("付款失敗：{}", e);

// ✅ 例外當最後一個參數（不對應任何 {}），SLF4J 會印出完整堆疊
log.error("訂單 {} 付款失敗", orderId, e);
```

> **這是最常見的日誌錯誤，而且傷害最大**：
> 出事時你只看到「付款失敗：null」，完全不知道發生在哪一行。
> `e.getMessage()` 在 NPE 的情況下常常就是 `null`。

### 規則 3：不要吞掉例外

```java
// ❌ 最糟的三種寫法
try { ... } catch (Exception e) { }                          // 完全消失
try { ... } catch (Exception e) { e.printStackTrace(); }     // 印到 stderr，不受日誌設定管理
try { ... } catch (Exception e) { log.error("出錯"); }        // 沒有堆疊
```

```java
// ✅ 記錄後重拋，或包成有意義的例外
try {
    paymentGateway.charge(orderId, amount);
} catch (PaymentGatewayException e) {
    log.error("訂單 {} 呼叫金流失敗 gateway={} amount={}", orderId, gateway, amount, e);
    throw new PaymentFailedException("付款失敗，請稍後再試", e);
}
```

### 規則 4：記錄「足以重現問題」的上下文

```java
// ❌ 沒有上下文
log.error("庫存不足", e);

// ✅ 有上下文
log.error("庫存不足 sku={} 需求={} 現有={} orderId={}", sku, required, available, orderId);
```

**判斷標準**：看到這行日誌，你能不能在不查資料庫的情況下理解發生什麼事？

### 規則 5：不要記錄敏感資料

```java
// ❌ 這些絕對不能進日誌
log.info("使用者登入 帳號={} 密碼={}", username, password);
log.debug("請求內容：{}", requestBody);          // 可能含信用卡號、身分證
log.info("回應：{}", response);                  // 可能含 token
log.debug("設定：{}", properties);               // 可能含 API key（第 03 章的教訓）
```

5.11 會給出遮蔽方案。

### 規則 6：一次操作只記一次

```java
// ❌ 每一層都記一次，同一件事在日誌裡出現四次
Controller: log.info("收到建立訂單請求");
Service:    log.info("開始建立訂單");
Repository: log.info("寫入訂單");
Aspect:     log.info("執行 placeOrder");
```

日誌量爆炸，而且真正重要的訊息被淹沒。

**建議的分層原則：**

| 層 | 記什麼 |
|---|---|
| Filter / Interceptor | 每個請求一行「進」+ 一行「出」（含狀態碼、耗時） |
| Controller | **通常不記**（上一層已經記了） |
| Service | 只記**業務決策點**（訂單狀態轉換、風控判定、外部呼叫） |
| Repository | **不記**（SQL 由 `logging.level.org.hibernate.SQL` 控制） |
| 例外處理器 | 統一記錄所有未預期的錯誤 |

---

## 5.5 日誌等級策略

### 五個等級的定義

| 等級 | 語意 | 誰會看 | 範例 |
|---|---|---|---|
| **ERROR** | **需要人介入處理** | 值班工程師（可能半夜被叫醒） | 資料庫連不上、外部服務全掛、資料不一致 |
| **WARN** | 不正常但系統能繼續 | 隔天上班看 | 重試成功、降級啟動、設定用了預設值、快取失效 |
| **INFO** | 重要的業務事件 | 查問題時看 | 訂單成立、使用者登入、服務啟動、排程執行 |
| **DEBUG** | 開發除錯用 | 開發者 | 方法參數、中間計算結果、SQL |
| **TRACE** | 極細節 | 極少用 | 迴圈內每一次的狀態 |

### ERROR 的濫用是最大的問題

```java
// ❌ 這些不該是 ERROR
log.error("使用者輸入的 email 格式不正確");        // → 這是正常的使用者行為，用 DEBUG
log.error("查無此訂單");                        // → 正常的 404，用 INFO 或不記
log.error("餘額不足");                          // → 正常的業務結果，用 INFO
log.error("JWT 過期");                          // → 正常的過期，用 DEBUG
```

> **判斷標準：這行 ERROR 出現時，你希望有人被叫醒嗎？**
>
> 不希望 → 就不是 ERROR。
>
> **後果很實際**：某團隊把所有 4xx 都記成 ERROR，
> 告警規則設成「ERROR 每分鐘超過 10 次就通知」。
> 結果值班手機每天響三十次，兩週後所有人都把通知靜音了。
> 真正的資料庫故障發生時，沒有人看到。**這叫告警疲勞（alert fatigue）。**

### 各環境的建議設定

```yaml
# application.yml（共用）
logging:
  level:
    root: INFO
    com.example.shop: INFO

# application-local.yml
logging:
  level:
    com.example.shop: DEBUG
    org.springframework.web: DEBUG
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE      # 看到 SQL 的實際參數值

# application-prod.yml
logging:
  level:
    root: WARN                              # 框架的雜訊全部關掉
    com.example.shop: INFO                  # 自己的程式碼保留 INFO
    com.example.shop.internal.batch: WARN   # 特別吵的模組個別調
```

### 執行期動態調整（救火用）

```bash
# 查目前等級
curl -s localhost:8081/actuator/loggers/com.example.shop | jq
{ "configuredLevel": "INFO", "effectiveLevel": "INFO" }

# 臨時開 DEBUG（不用重啟！）
curl -X POST localhost:8081/actuator/loggers/com.example.shop.payment \
  -H 'Content-Type: application/json' \
  -d '{"configuredLevel":"DEBUG"}'

# 查完問題記得關掉
curl -X POST localhost:8081/actuator/loggers/com.example.shop.payment \
  -H 'Content-Type: application/json' \
  -d '{"configuredLevel":null}'      # null = 回到繼承的等級
```

> **這是本章最實用的一招**。正式環境出問題時，
> 你可以只對「有問題的那個套件」開 DEBUG 五分鐘，抓到需要的資訊後關掉，
> 不需要重新部署，也不會讓整個服務的日誌量爆炸。
>
> ⚠️ 但這個端點威力很大（可以讓日誌量瞬間暴增拖垮服務），
> **一定要放在管理 port 並加上認證**（5.18）。

---

## 5.6 用 `application.yml` 做日誌設定

八成的需求不需要寫 XML。

```yaml
logging:
  # ── 等級 ──
  level:
    root: INFO
    com.example.shop: DEBUG
    org.springframework.web: INFO
    org.hibernate.SQL: DEBUG

  # ── 輸出到檔案 ──
  file:
    name: /var/log/shop-service/application.log
    # 或只指定目錄，檔名固定為 spring.log
    # path: /var/log/shop-service

  # ── 滾動策略 ──
  logback:
    rollingpolicy:
      file-name-pattern: /var/log/shop-service/application-%d{yyyy-MM-dd}.%i.log.gz
      max-file-size: 100MB          # 單檔上限
      max-history: 30               # 保留 30 天
      total-size-cap: 5GB           # 總量上限（★ 一定要設，否則磁碟會被寫爆 ★）
      clean-history-on-start: false

  # ── 輸出格式 ──
  pattern:
    console: "%d{yyyy-MM-dd HH:mm:ss.SSS} %highlight(%-5level) [%thread] %cyan(%logger{36}) - %msg%n"
    file: "%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger{36} - %msg%n"
    dateformat: "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"

  # ── 分組（一次調整多個 logger）──
  group:
    database: org.hibernate,org.springframework.jdbc,com.zaxxer.hikari
    web: org.springframework.web,org.apache.tomcat
```

```yaml
# 用分組調整
logging:
  level:
    database: DEBUG        # 一次把三個套件都設成 DEBUG
    web: WARN
```

Spring Boot 內建兩個分組：`web` 與 `sql`。

```yaml
logging:
  level:
    sql: DEBUG    # = org.springframework.jdbc.core + org.hibernate.SQL + ...
```

### `total-size-cap` 為什麼一定要設

> **真實案例**：某服務因為一個外部 API 一直逾時，
> 每次重試都記一行 WARN。一晚上寫了 180 GB 日誌，把磁碟寫滿。
> **磁碟滿了之後，資料庫也寫不進去了**，整台機器上的所有服務一起掛掉。
>
> 一行 `total-size-cap: 5GB` 就能避免這件事。

---

## 5.7 `logback-spring.xml` 完整解剖

需要更複雜的設定（多個 appender、不同 profile 不同行為、自訂 encoder）時，才寫 XML。

### 檔名很重要

| 檔名 | Spring 擴充功能 | 建議 |
|---|---|---|
| `logback.xml` | ❌ 不支援 `<springProfile>` / `<springProperty>` | 不要用 |
| **`logback-spring.xml`** | ✅ 完整支援 | **一律用這個** |

**原因**：`logback.xml` 會被 Logback **在 Spring 啟動之前**就讀取，那時 Environment 還不存在。

### 完整範例

`src/main/resources/logback-spring.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration scan="false">

    <!-- ① 引入 Spring Boot 的預設設定（顏色、預設 pattern 變數） -->
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <!-- ② 從 Spring Environment 取值 -->
    <springProperty scope="context" name="appName"
                    source="spring.application.name" defaultValue="unknown"/>
    <springProperty scope="context" name="appVersion"
                    source="info.app.version" defaultValue="dev"/>
    <springProperty scope="context" name="logPath"
                    source="logging.file.path" defaultValue="./logs"/>

    <!-- ③ 一般變數 -->
    <property name="CONSOLE_PATTERN"
              value="%d{yyyy-MM-dd HH:mm:ss.SSS} %highlight(%-5level) [%15.15thread] [%X{traceId:-}] %cyan(%-40.40logger{39}) : %msg%n%wEx"/>
    <property name="FILE_PATTERN"
              value="%d{yyyy-MM-dd'T'HH:mm:ss.SSSXXX} %-5level [%thread] [%X{traceId:-}] [%X{userId:-}] %logger{40} : %msg%n%wEx"/>

    <!-- ④ Appender：主控台 -->
    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>${CONSOLE_PATTERN}</pattern>
            <charset>UTF-8</charset>
        </encoder>
    </appender>

    <!-- ⑤ Appender：一般檔案（滾動） -->
    <appender name="FILE" class="ch.qos.logback.core.rolling.RollingFileAppender">
        <file>${logPath}/${appName}.log</file>
        <rollingPolicy class="ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy">
            <fileNamePattern>${logPath}/${appName}-%d{yyyy-MM-dd}.%i.log.gz</fileNamePattern>
            <maxFileSize>100MB</maxFileSize>
            <maxHistory>30</maxHistory>
            <totalSizeCap>5GB</totalSizeCap>
        </rollingPolicy>
        <encoder>
            <pattern>${FILE_PATTERN}</pattern>
            <charset>UTF-8</charset>
        </encoder>
    </appender>

    <!-- ⑥ Appender：只收 ERROR，方便快速定位 -->
    <appender name="ERROR_FILE" class="ch.qos.logback.core.rolling.RollingFileAppender">
        <file>${logPath}/${appName}-error.log</file>
        <filter class="ch.qos.logback.classic.filter.LevelFilter">
            <level>ERROR</level>
            <onMatch>ACCEPT</onMatch>
            <onMismatch>DENY</onMismatch>
        </filter>
        <rollingPolicy class="ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy">
            <fileNamePattern>${logPath}/${appName}-error-%d{yyyy-MM-dd}.%i.log.gz</fileNamePattern>
            <maxFileSize>50MB</maxFileSize>
            <maxHistory>90</maxHistory>
            <totalSizeCap>2GB</totalSizeCap>
        </rollingPolicy>
        <encoder>
            <pattern>${FILE_PATTERN}</pattern>
            <charset>UTF-8</charset>
        </encoder>
    </appender>

    <!-- ⑦ Appender：稽核日誌獨立一份（保留久一點） -->
    <appender name="AUDIT_FILE" class="ch.qos.logback.core.rolling.RollingFileAppender">
        <file>${logPath}/${appName}-audit.log</file>
        <rollingPolicy class="ch.qos.logback.core.rolling.TimeBasedRollingPolicy">
            <fileNamePattern>${logPath}/${appName}-audit-%d{yyyy-MM-dd}.log.gz</fileNamePattern>
            <maxHistory>365</maxHistory>       <!-- 稽核紀錄通常有法遵要求 -->
        </rollingPolicy>
        <encoder>
            <pattern>%d{yyyy-MM-dd'T'HH:mm:ss.SSSXXX} [%X{traceId:-}] %msg%n</pattern>
            <charset>UTF-8</charset>
        </encoder>
    </appender>

    <!-- ⑧ 非同步包裝：避免日誌 IO 阻塞業務執行緒 -->
    <appender name="ASYNC_FILE" class="ch.qos.logback.classic.AsyncAppender">
        <appender-ref ref="FILE"/>
        <queueSize>4096</queueSize>
        <discardingThreshold>0</discardingThreshold>   <!-- 0 = 佇列滿時也不丟棄 INFO -->
        <neverBlock>false</neverBlock>                 <!-- false = 佇列滿時阻塞（不遺失日誌） -->
        <includeCallerData>false</includeCallerData>   <!-- ★ true 會非常慢，不要開 ★ -->
    </appender>

    <!-- ⑨ 稽核 logger：不往上傳遞，只寫自己的檔案 -->
    <logger name="AUDIT" level="INFO" additivity="false">
        <appender-ref ref="AUDIT_FILE"/>
    </logger>

    <!-- ⑩ 依 Profile 決定輸出目的地 -->
    <springProfile name="local | dev">
        <root level="INFO">
            <appender-ref ref="CONSOLE"/>
        </root>
        <logger name="com.example.shop" level="DEBUG"/>
        <logger name="org.hibernate.SQL" level="DEBUG"/>
    </springProfile>

    <springProfile name="staging | prod">
        <root level="WARN">
            <appender-ref ref="CONSOLE"/>          <!-- 容器環境：stdout 由平台收集 -->
            <appender-ref ref="ASYNC_FILE"/>
            <appender-ref ref="ERROR_FILE"/>
        </root>
        <logger name="com.example.shop" level="INFO"/>
    </springProfile>

</configuration>
```

### Pattern 常用轉換符

| 符號 | 意義 | 備註 |
|---|---|---|
| `%d{...}` | 時間 | 建議用 ISO-8601 含時區 |
| `%level` / `%-5level` | 等級 | `-5` 是左對齊補到 5 字元 |
| `%thread` / `%15.15thread` | 執行緒名 | `15.15` 是最少最多 15 字元 |
| `%logger{36}` | logger 名稱 | 數字是縮寫後的最大長度 |
| `%msg` / `%m` | 訊息 | |
| `%n` | 換行 | |
| `%X{traceId}` | **MDC 的值** | `%X{traceId:-}` 表示沒有時輸出空字串 |
| `%ex` / `%wEx` | 例外堆疊 | `%wEx` 是 Spring Boot 加的「有顏色的」版本 |
| `%highlight(...)` | 依等級上色 | 只對主控台有意義 |
| `%method` / `%line` | 方法名 / 行號 | ⚠️ **極慢**（要抓堆疊），正式環境不要用 |

> ⚠️ **`%method`、`%line`、`%class`、`%file` 都要透過建立 exception 抓堆疊來取得，
> 成本是一般輸出的 10～100 倍。** 高流量服務絕對不要用。
> 需要定位程式碼位置時，用 `%logger` 加上有意義的訊息就夠了。

### `additivity` 的意義

```xml
<logger name="AUDIT" level="INFO" additivity="false">
    <appender-ref ref="AUDIT_FILE"/>
</logger>
```

`additivity="false"` 表示**不要再往上層 logger 傳遞**。
沒設的話，稽核日誌會**同時**寫進 `AUDIT_FILE` 和 root 的所有 appender（重複三份）。

### 非同步 Appender 的取捨

```xml
<discardingThreshold>0</discardingThreshold>
<neverBlock>false</neverBlock>
```

| 設定組合 | 行為 | 適用 |
|---|---|---|
| `discardingThreshold=20`（預設）、`neverBlock=false` | 佇列剩 20% 時開始丟棄 TRACE/DEBUG/INFO | 一般情況 |
| `discardingThreshold=0`、`neverBlock=false` | 不丟棄，佇列滿時**阻塞業務執行緒** | 日誌不可遺失（稽核、金流） |
| `discardingThreshold=0`、`neverBlock=true` | 不丟棄，佇列滿時直接丟掉新的（不阻塞） | 效能優先，可接受遺失 |

> **這個取捨要想清楚**：`neverBlock=false` 在極端情況下，
> **日誌系統的問題會變成業務系統的問題**（磁碟慢 → 佇列滿 → 業務執行緒被卡住）。
> 一般業務日誌建議 `neverBlock=true`，稽核日誌才用 `false`。

---

## 5.8 結構化日誌

### 為什麼要 JSON

傳統文字日誌：

```
2026-08-18 03:12:44.121 ERROR [nio-8080-exec-3] c.e.s.p.PaymentService : 訂單 1001 付款失敗 gateway=stripe code=card_declined
```

要在 Elasticsearch / Loki / CloudWatch 裡查詢「所有 `card_declined` 的錯誤」，
你得寫 grok / regex 去**解析**這行字。解析規則跟日誌格式綁死，改一個字就壞掉。

JSON 日誌：

```json
{"timestamp":"2026-08-18T03:12:44.121Z","level":"ERROR","logger":"com.example.shop.payment.PaymentService","message":"付款失敗","traceId":"a3f8c21b9d4e5f60","orderId":1001,"gateway":"stripe","errorCode":"card_declined"}
```

**每個欄位天生就是可查詢、可聚合的欄位**。不需要解析規則。

### 方式 1：Spring Boot 內建結構化日誌【Boot 3.4+】

Spring Boot 3.4 起原生支援，**不需要額外依賴**：

```yaml
logging:
  structured:
    format:
      console: ecs          # ecs（Elastic Common Schema）/ logstash / gelf
      file: ecs
  file:
    name: /var/log/shop-service/application.json
```

輸出（ECS 格式）：

```json
{"@timestamp":"2026-08-18T03:12:44.121Z","log.level":"ERROR","process.pid":1,"process.thread.name":"http-nio-8080-exec-3","service.name":"shop-service","log.logger":"com.example.shop.payment.PaymentService","message":"付款失敗","orderId":"1001","gateway":"stripe","ecs.version":"8.11"}
```

加上固定欄位：

```yaml
logging:
  structured:
    ecs:
      service:
        name: shop-service
        version: 1.4.2
        environment: production
        node-name: ${HOSTNAME:unknown}
```

### 方式 2：`logstash-logback-encoder`（Boot 3.4 之前，或需要更多控制）

```xml
<dependency>
    <groupId>net.logstash.logback</groupId>
    <artifactId>logstash-logback-encoder</artifactId>
    <version>8.0</version>
</dependency>
```

```xml
<appender name="JSON_CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder">
        <providers>
            <timestamp>
                <timeZone>UTC</timeZone>
                <pattern>yyyy-MM-dd'T'HH:mm:ss.SSS'Z'</pattern>
            </timestamp>
            <logLevel/>
            <loggerName>
                <shortenedLoggerNameLength>40</shortenedLoggerNameLength>
            </loggerName>
            <threadName/>
            <message/>
            <mdc/>                          <!-- ★ 把 MDC 全部展開成 JSON 欄位 ★ -->
            <arguments/>                    <!-- 支援 StructuredArguments -->
            <stackTrace>
                <throwableConverter class="net.logstash.logback.stacktrace.ShortenedThrowableConverter">
                    <maxDepthPerThrowable>30</maxDepthPerThrowable>
                    <maxLength>4096</maxLength>
                    <shortenedClassNameLength>30</shortenedClassNameLength>
                    <exclude>^sun\.reflect\..*\.invoke</exclude>
                    <exclude>^net\.sf\.cglib\.proxy\.MethodProxy\.invoke</exclude>
                    <exclude>^org\.springframework\.aop\..*</exclude>    <!-- 過濾 AOP 雜訊 -->
                    <rootCauseFirst>true</rootCauseFirst>
                </throwableConverter>
            </stackTrace>
            <pattern>
                <pattern>
                    {
                      "service": "${appName:-unknown}",
                      "version": "${appVersion:-dev}",
                      "env": "${ENV:-unknown}",
                      "host": "${HOSTNAME:-unknown}"
                    }
                </pattern>
            </pattern>
        </providers>
    </encoder>
</appender>
```

> **`rootCauseFirst=true` 這個設定很值得開**：
> 一般的堆疊是「最外層例外在上、根因在最下面」，
> 但你真正想看的是根因。開了之後根因會排在最前面，省下往下捲的時間。
>
> `<exclude>` 過濾掉 Spring AOP 的框架堆疊，也能讓輸出短很多（回顧第 04 章 4.16 那段堆疊）。

### 結構化參數：`StructuredArguments`

```java
import static net.logstash.logback.argument.StructuredArguments.kv;
import static net.logstash.logback.argument.StructuredArguments.value;

log.info("訂單建立成功 {} {}", kv("orderId", 1001), kv("amount", new BigDecimal("1280")));
// 訊息：訂單建立成功 orderId=1001 amount=1280
// JSON：{..., "message":"訂單建立成功 orderId=1001 amount=1280", "orderId":1001, "amount":1280}

log.info("訂單 {} 建立成功", value("orderId", 1001));
// 訊息：訂單 1001 建立成功
// JSON：{..., "message":"訂單 1001 建立成功", "orderId":1001}
```

**這個機制很棒**：訊息仍然是人類可讀的，同時每個值也是獨立的 JSON 欄位。

### 什麼環境該用 JSON

| 環境 | 建議 |
|---|---|
| 本機開發 | **文字**（人眼要讀，JSON 很難看） |
| dev / staging / prod | **JSON**（送進日誌平台） |

```xml
<springProfile name="local">
    <root level="INFO"><appender-ref ref="CONSOLE"/></root>
</springProfile>

<springProfile name="dev | staging | prod">
    <root level="INFO"><appender-ref ref="JSON_CONSOLE"/></root>
</springProfile>
```

> **容器環境的原則：寫到 stdout 就好，不要寫檔案。**
> Docker / K8s 會收集 stdout，檔案反而會佔用容器的可寫層，
> 而且容器重建後日誌就沒了。

---

## 5.9 MDC 與追蹤 ID

**這是本章最重要的一節。**

### MDC 是什麼

MDC（Mapped Diagnostic Context）是 SLF4J 提供的 **`ThreadLocal<Map<String, String>>`**。
放進去的值會自動出現在同一個執行緒後續的所有日誌裡。

```java
MDC.put("traceId", "a3f8c21b9d4e5f60");
log.info("開始處理");        // 這行的 %X{traceId} 就有值
log.info("處理完成");        // 這行也有
MDC.remove("traceId");
```

### 用 Filter 產生追蹤 ID

```java
package com.example.shop.observability;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * 為每個 HTTP 請求建立追蹤上下文。
 *
 * <p>Order 設成最高，確保後續所有 Filter / Interceptor / Controller 的日誌都帶得到 traceId。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(TraceIdFilter.class);

    public static final String TRACE_ID = "traceId";
    public static final String TRACE_ID_HEADER = "X-Trace-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        // ① 優先沿用上游傳來的 traceId（微服務串接時很重要）
        String traceId = request.getHeader(TRACE_ID_HEADER);
        if (traceId == null || traceId.isBlank() || traceId.length() > 64) {
            traceId = newTraceId();
        }

        MDC.put(TRACE_ID, traceId);
        MDC.put("method", request.getMethod());
        MDC.put("path", request.getRequestURI());
        MDC.put("clientIp", clientIp(request));

        // ② 回傳給呼叫端，方便使用者回報問題時附上
        response.setHeader(TRACE_ID_HEADER, traceId);

        long start = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;
            MDC.put("status", String.valueOf(response.getStatus()));
            MDC.put("latencyMs", String.valueOf(ms));

            // ③ 每個請求一行「出」的日誌，這是最有價值的一行
            if (response.getStatus() >= 500) {
                log.error("{} {} -> {} ({} ms)",
                        request.getMethod(), request.getRequestURI(), response.getStatus(), ms);
            } else if (ms > 1000) {
                log.warn("{} {} -> {} ({} ms) 慢請求",
                        request.getMethod(), request.getRequestURI(), response.getStatus(), ms);
            } else {
                log.info("{} {} -> {} ({} ms)",
                        request.getMethod(), request.getRequestURI(), response.getStatus(), ms);
            }

            MDC.clear();     // ★★ 一定要清乾淨，否則會污染執行緒池的下一個請求 ★★
        }
    }

    /** 不要用完整 UUID（36 字元太長），16 字元夠用且對齊 OpenTelemetry 的 spanId 長度 */
    private String newTraceId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();       // 取第一個（最原始的客戶端）
        }
        return request.getRemoteAddr();
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return path.startsWith("/actuator");    // 健康檢查不需要 traceId，省下噪音
    }
}
```

### ★ 陷阱 1：忘記 `MDC.clear()` 造成執行緒池污染

```
Tomcat 執行緒池只有 200 條執行緒，會被重複使用：

請求 A → 執行緒 exec-3 → MDC.put("userId", "u-001") → 忘記清除
請求 B → 執行緒 exec-3 → 沒有登入的訪客
       → 日誌裡卻顯示 userId=u-001  ★ 資料錯亂 ★
```

> **真實案例**：某系統的稽核日誌就是這樣壞掉的。
> 客服查「使用者 A 到底做了什麼」，查出一堆其實是別人做的操作。
> 更糟的是這份稽核日誌被用來處理客訴爭議——**錯誤的資料被當成證據**。
>
> **規則：`MDC.put` 一定要配 `finally { MDC.clear(); }` 或 `MDC.remove(key)`。**

### ★ 陷阱 2：`@Async` / 執行緒池會遺失 MDC

```java
@Service
public class NotificationService {

    @Async
    public void sendAsync(String to, String message) {
        log.info("寄送通知給 {}", to);      // ❌ 沒有 traceId！MDC 是 ThreadLocal
    }
}
```

**解法：用 `TaskDecorator` 複製 MDC 到新執行緒。**

```java
package com.example.shop.observability;

import org.slf4j.MDC;
import org.springframework.core.task.TaskDecorator;

import java.util.Map;

/**
 * 把提交任務時的 MDC 複製到執行任務的執行緒。
 */
public class MdcTaskDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable runnable) {
        // ① 在「提交任務的執行緒」上抓取 MDC 快照
        Map<String, String> contextMap = MDC.getCopyOfContextMap();

        return () -> {
            // ② 在「執行任務的執行緒」上還原
            Map<String, String> previous = MDC.getCopyOfContextMap();
            if (contextMap != null) {
                MDC.setContextMap(contextMap);
            } else {
                MDC.clear();
            }
            try {
                runnable.run();
            } finally {
                // ③ 還原成原本的狀態（執行緒池會重複使用，不能留下殘渣）
                if (previous != null) {
                    MDC.setContextMap(previous);
                } else {
                    MDC.clear();
                }
            }
        };
    }
}
```

```java
package com.example.shop.config;

import com.example.shop.observability.MdcTaskDecorator;
import org.springframework.boot.task.ThreadPoolTaskExecutorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.time.Duration;

@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean("taskExecutor")
    public ThreadPoolTaskExecutor taskExecutor(ThreadPoolTaskExecutorBuilder builder) {
        return builder
                .corePoolSize(8)
                .maxPoolSize(32)
                .queueCapacity(200)
                .threadNamePrefix("shop-async-")
                .awaitTermination(true)
                .awaitTerminationPeriod(Duration.ofSeconds(30))   // 優雅關閉
                .taskDecorator(new MdcTaskDecorator())            // ★ 關鍵 ★
                .build();
    }
}
```

> 第 06 章會完整處理 `@Async` 與執行緒池設定，這裡先解決 MDC 傳遞的問題。

### 陷阱 3：`CompletableFuture` 也一樣

```java
// ❌ 遺失 MDC
CompletableFuture.supplyAsync(() -> queryOrders(userId));

// ✅ 用有 decorator 的 executor
CompletableFuture.supplyAsync(() -> queryOrders(userId), taskExecutor);
```

### 該放什麼進 MDC

| 欄位 | 說明 | 必要性 |
|---|---|---|
| `traceId` | 一次請求的唯一識別 | ⭐⭐⭐⭐⭐ |
| `spanId` | 一次請求內某一段的識別 | ⭐⭐⭐⭐ |
| `userId` | 誰發起的 | ⭐⭐⭐⭐ |
| `path` / `method` | 哪支 API | ⭐⭐⭐ |
| `clientIp` | 來源 IP | ⭐⭐⭐ |
| `tenantId` | 多租戶系統必備 | 視情況 |
| ~~`requestBody`~~ | ❌ **不要**，可能含敏感資料且量太大 | — |

---

## 5.10 分散式追蹤：Micrometer Tracing

單體服務用自己的 `TraceIdFilter` 就夠了。
一旦有多個服務互相呼叫，就需要標準化的追蹤。

> **Spring Boot 3 用 Micrometer Tracing**（Spring Cloud Sleuth 已在 Boot 3 停止維護並併入 Micrometer）。

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
```

```yaml
management:
  tracing:
    sampling:
      probability: 0.1          # ★ 只取樣 10%，正式環境不要設 1.0 ★
  otlp:
    tracing:
      endpoint: http://otel-collector:4318/v1/traces

logging:
  pattern:
    # Spring Boot 內建的 traceId/spanId 佔位符
    level: "%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-}]"
```

加上之後，`RestClient`、`WebClient`、`RestTemplate`、`@Scheduled`、
訊息佇列的呼叫都會**自動傳遞 traceId**：

```
服務 A                     服務 B                    服務 C
traceId=abc123            traceId=abc123           traceId=abc123
spanId=001                spanId=002               spanId=003
   │                         │                        │
   ├── HTTP ────────────────▶│                        │
   │   traceparent header    ├── HTTP ───────────────▶│
   │                         │                        │
```

在 Jaeger / Zipkin / Grafana Tempo 裡可以看到完整的呼叫瀑布圖，
一眼找出「這 2 秒是花在哪個服務的哪個方法」。

> **取樣率的取捨**：`probability: 1.0` 會產生大量資料（成本高、儲存壓力大）。
> 常見策略是「一般請求 1～10%，錯誤請求 100%」（需要 tail-based sampling，
> 由 OpenTelemetry Collector 負責）。

---

## 5.11 敏感資料遮蔽

### 三個洩漏管道

```
① 直接記錄        log.info("密碼：{}", password)
② 物件的 toString  log.info("請求：{}", request)   ← request 裡有身分證
③ 例外訊息        SQLException 的訊息可能含完整 SQL 與參數值
```

### 防線 1：DTO 覆寫 `toString()`

```java
package com.example.shop.web;

import java.math.BigDecimal;

public record CreateOrderRequest(
        String customerName,
        String idNumber,          // 身分證
        String phone,
        String creditCardNumber,
        BigDecimal amount) {

    @Override
    public String toString() {
        return "CreateOrderRequest[customerName=%s, idNumber=%s, phone=%s, creditCardNumber=%s, amount=%s]"
                .formatted(mask(customerName, 1),
                           mask(idNumber, 3),
                           mask(phone, 4),
                           maskCard(creditCardNumber),
                           amount);
    }

    /** 保留前 keep 個字元，其餘用 * 取代 */
    private static String mask(String value, int keep) {
        if (value == null || value.length() <= keep) {
            return "***";
        }
        return value.substring(0, keep) + "*".repeat(value.length() - keep);
    }

    /** 信用卡：只留末四碼（PCI DSS 的要求） */
    private static String maskCard(String card) {
        if (card == null || card.length() < 4) {
            return "****";
        }
        return "*".repeat(card.length() - 4) + card.substring(card.length() - 4);
    }
}
```

### 防線 2：Logback 的 pattern 遮蔽（最後一道網）

```xml
<appender name="MASKED_CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
    <encoder>
        <pattern>%d %-5level [%X{traceId:-}] %logger{36} : %replace(%msg){'(\d{4})\d{8,10}(\d{4})', '$1********$2'}%n</pattern>
    </encoder>
</appender>
```

或用自訂 converter（更彈性）：

```java
package com.example.shop.observability;

import ch.qos.logback.classic.pattern.ClassicConverter;
import ch.qos.logback.classic.spi.ILoggingEvent;

import java.util.List;
import java.util.regex.Pattern;

/**
 * 遮蔽日誌訊息中的敏感樣式。
 *
 * <p>⚠️ 這是「最後一道防線」，不是主要手段。
 * 正則遮蔽有效能成本，而且一定會有漏網之魚。
 * 主要手段應該是「一開始就不要把敏感資料放進日誌」。
 */
public class MaskingMessageConverter extends ClassicConverter {

    private record Rule(Pattern pattern, String replacement) { }

    private static final List<Rule> RULES = List.of(
            // 信用卡號（13～19 位數字，可含分隔符）
            new Rule(Pattern.compile("\\b(\\d{4})[- ]?\\d{4,11}[- ]?(\\d{4})\\b"), "$1********$2"),
            // 台灣身分證
            new Rule(Pattern.compile("\\b([A-Z])\\d{8}\\b"), "$1********"),
            // Email
            new Rule(Pattern.compile("\\b([\\w.+-]{1,3})[\\w.+-]*@([\\w.-]+)\\b"), "$1***@$2"),
            // JWT
            new Rule(Pattern.compile("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"), "<JWT>"),
            // 常見金鑰前綴
            new Rule(Pattern.compile("\\b(sk_live_|sk_test_|AKIA)[A-Za-z0-9]+"), "$1****")
    );

    @Override
    public String convert(ILoggingEvent event) {
        String message = event.getFormattedMessage();
        if (message == null || message.isEmpty()) {
            return "";
        }
        for (Rule rule : RULES) {
            message = rule.pattern().matcher(message).replaceAll(rule.replacement());
        }
        return message;
    }
}
```

```xml
<configuration>
    <conversionRule conversionWord="maskedMsg"
                    class="com.example.shop.observability.MaskingMessageConverter"/>

    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d %-5level [%X{traceId:-}] %logger{36} : %maskedMsg%n</pattern>
        </encoder>
    </appender>
</configuration>
```

> ⚠️ **正則遮蔽有效能成本**（每一行日誌跑 5 個正則）。
> 高流量服務要實測影響。**它是保險，不是主要手段。**

### 防線 3：Code Review 檢查清單

```
□ log 敘述裡有沒有直接印出整個 request / response 物件？
□ 有沒有把 Exception 的完整訊息回給前端？
□ DTO 有沒有覆寫 toString()？
□ 有沒有 log.debug 印出 SQL 參數？（正式環境雖然關 DEBUG，但仍是風險）
```

---

## 5.12 Actuator 端點總覽

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

### 核心端點

| 端點 | 用途 | 正式環境 |
|---|---|---|
| `/health` | 健康檢查 | ✅ 必開（K8s 探針） |
| `/info` | 應用程式資訊（版本、Git commit） | ✅ 建議開 |
| `/prometheus` | Prometheus 指標 | ✅ 開（限內網） |
| `/metrics` | 指標（JSON 格式，人工查詢用） | ⚠️ 限內網 |
| `/loggers` | 查詢與**動態調整**日誌等級 | ⚠️ 限內網 + 認證 |
| `/env` | 所有設定屬性 | ❌ **不要開** |
| `/configprops` | 所有 `@ConfigurationProperties` | ❌ **不要開** |
| `/beans` | 所有 Bean | ❌ 不要開 |
| `/conditions` | 自動組態條件報告 | ❌ 不要開 |
| `/mappings` | 所有 URL 對應 | ❌ 不要開 |
| `/threaddump` | 執行緒堆疊 | ⚠️ 限內網 + 認證 |
| `/heapdump` | **下載整個記憶體映像** | ❌❌ **絕對不要開** |
| `/shutdown` | 關閉應用程式 | ❌❌ 預設關閉，不要開 |
| `/httpexchanges` | 最近的 HTTP 請求紀錄 | ⚠️ 需自行提供 Repository Bean |
| `/startup` | 啟動階段耗時分析 | 開發用 |
| `/scheduledtasks` | 排程任務清單 | ⚠️ 限內網 |
| `/caches` | 快取狀態與清除 | ⚠️ 限內網 |

### 基本設定

```yaml
management:
  endpoints:
    web:
      base-path: /actuator          # 預設值
      exposure:
        include: health,info,prometheus,loggers,metrics
        exclude: env,beans,configprops
  endpoint:
    health:
      show-details: when-authorized
      probes:
        enabled: true
  server:
    port: 8081                      # ★ 獨立 port ★
    address: 127.0.0.1              # 只監聽本機（配合 sidecar 或反向代理）
```

---

## 5.13 健康檢查

### 內建的 HealthIndicator

Spring Boot 會依 classpath 自動註冊（回顧第 02 章的自動組態）：

```bash
$ curl -s localhost:8081/actuator/health | jq
{
  "status": "UP",
  "components": {
    "db": {
      "status": "UP",
      "details": { "database": "MySQL", "validationQuery": "isValid()" }
    },
    "diskSpace": {
      "status": "UP",
      "details": { "total": 494384795648, "free": 82301566976, "threshold": 10485760 }
    },
    "ping": { "status": "UP" },
    "redis": {
      "status": "UP",
      "details": { "version": "7.2.4" }
    }
  }
}
```

**整體 status 的計算規則**：任何一個 component 是 `DOWN`，整體就是 `DOWN`（回 503）。

### 自訂 HealthIndicator

```java
package com.example.shop.health;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.time.Instant;

/**
 * 金流服務健康檢查。
 *
 * <p>Bean 名稱去掉 "HealthIndicator" 後綴就是 component 名稱，
 * 所以這個會出現在 /health 的 "paymentGateway" 底下。
 */
@Component
public class PaymentGatewayHealthIndicator implements HealthIndicator {

    private final RestClient restClient;

    public PaymentGatewayHealthIndicator(RestClient.Builder builder) {
        this.restClient = builder.baseUrl("https://api.payment.example.com").build();
    }

    @Override
    public Health health() {
        Instant start = Instant.now();
        try {
            restClient.get().uri("/health").retrieve().toBodilessEntity();
            Duration latency = Duration.between(start, Instant.now());

            if (latency.toMillis() > 2000) {
                // ★ 慢但還活著 → DEGRADED，不要直接判 DOWN ★
                return Health.status("DEGRADED")
                        .withDetail("latencyMs", latency.toMillis())
                        .withDetail("threshold", 2000)
                        .build();
            }
            return Health.up()
                    .withDetail("latencyMs", latency.toMillis())
                    .build();

        } catch (Exception e) {
            return Health.down()
                    .withDetail("error", e.getClass().getSimpleName())
                    .withDetail("message", e.getMessage())
                    .build();
        }
    }
}
```

> ⚠️ **健康檢查的三個原則：**
>
> 1. **要快**（< 1 秒）。K8s 的探針有 timeout，檢查太慢會被判定失敗然後重啟 Pod。
> 2. **不要檢查「非必要的外部依賴」**。金流掛掉時，你的服務仍然可以提供查詢功能——
>    如果健康檢查回 DOWN，K8s 會把你的 Pod 從負載均衡拿掉，**變成自己把自己弄掛**。
> 3. **不要在健康檢查裡做寫入操作**。它會被高頻呼叫（每 10 秒一次）。

### 自訂狀態要註冊對應的 HTTP 狀態碼

```yaml
management:
  endpoint:
    health:
      status:
        order:                       # 從嚴重到不嚴重
          - DOWN
          - OUT_OF_SERVICE
          - DEGRADED
          - UP
          - UNKNOWN
        http-mapping:
          DEGRADED: 200              # 降級仍然回 200（不要被踢出負載均衡）
          OUT_OF_SERVICE: 503
          DOWN: 503
```

### Liveness 與 Readiness：K8s 探針的正確用法

**這兩個的差別是實務上最常搞錯的地方：**

| | Liveness（存活） | Readiness（就緒） |
|---|---|---|
| 問題 | 「這個程序還活著嗎？」 | 「現在可以接流量嗎？」 |
| 失敗時 K8s 做什麼 | **重啟容器** | **從 Service 移除，不重啟** |
| 該檢查什麼 | 只檢查程序本身（死鎖、OOM） | 資料庫、必要依賴、暖機完成 |
| **不該檢查什麼** | **外部依賴** | — |

> **最常見的災難**：把資料庫檢查放進 liveness。
> 資料庫短暫抖動 → 所有 Pod 的 liveness 失敗 → K8s 同時重啟所有 Pod
> → 重啟後一起連資料庫 → 資料庫被連線風暴打垮 → 無限重啟迴圈。
>
> **資料庫檢查永遠放 readiness，不要放 liveness。**

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true                # 開啟 /health/liveness 與 /health/readiness
      group:
        liveness:
          include: livenessState     # ★ 只有程序狀態，不含任何外部依賴 ★
        readiness:
          include: readinessState,db,redis
          additional-path: "server:/readyz"   # 也在主 port 上開一個（給 LB 用）
```

```yaml
# k8s deployment.yaml
livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8081
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8081
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 2

startupProbe:                        # ★ 啟動慢的服務一定要設 ★
  httpGet:
    path: /actuator/health/liveness
    port: 8081
  failureThreshold: 30               # 最多等 30 × 10 = 300 秒
  periodSeconds: 10
```

> **`startupProbe` 解決一個常見問題**：服務啟動要 60 秒，
> 但 `livenessProbe` 的 `initialDelaySeconds` 只設 30 秒 → 還沒啟動完就被判死 → 重啟 → 無限迴圈。
> 有了 `startupProbe`，liveness 與 readiness 會等它成功之後才開始。

### 程式化控制 readiness

```java
package com.example.shop.health;

import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;

@Component
public class ReadinessController {

    private final ApplicationEventPublisher publisher;

    public ReadinessController(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    /** 進入維護模式：停止接受新流量，但已在處理的請求會完成 */
    public void enterMaintenance() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.REFUSING_TRAFFIC);
    }

    public void exitMaintenance() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.ACCEPTING_TRAFFIC);
    }
}
```

### `/info` 端點：帶上版本與 Git 資訊

```yaml
management:
  info:
    env:
      enabled: true
    git:
      mode: full
    build:
      enabled: true
    java:
      enabled: true
    os:
      enabled: true

info:
  app:
    name: ${spring.application.name}
    version: ${project.version:unknown}
    description: 訂單服務
```

加上 git 資訊（出事時知道跑的是哪個 commit）：

```xml
<plugin>
    <groupId>io.github.git-commit-id</groupId>
    <artifactId>git-commit-id-maven-plugin</artifactId>
    <version>9.0.1</version>
    <executions>
        <execution>
            <goals><goal>revision</goal></goals>
        </execution>
    </executions>
    <configuration>
        <generateGitPropertiesFile>true</generateGitPropertiesFile>
        <includeOnlyProperties>
            <property>^git.branch$</property>
            <property>^git.commit.id.abbrev$</property>
            <property>^git.commit.time$</property>
        </includeOnlyProperties>
    </configuration>
</plugin>
```

```bash
$ curl -s localhost:8081/actuator/info | jq
{
  "app": { "name": "shop-service", "version": "1.4.2", "description": "訂單服務" },
  "git": {
    "branch": "main",
    "commit": { "id": "a3f8c21", "time": "2026-08-17T09:22:14+08:00" }
  },
  "build": { "artifact": "shop-service", "version": "1.4.2", "time": "2026-08-17T10:05:33Z" },
  "java": { "version": "21.0.5", "vendor": { "name": "Eclipse Adoptium" } }
}
```

> **這個端點在事故處理時價值極高**：
> 「正式環境現在跑的是哪個版本？」——一個 curl 就有答案，
> 不用去翻 CI 紀錄或問人。

---

## 5.14 Micrometer：指標

### 為什麼要指標（日誌不夠嗎）

```
問題：「訂單建立的 P99 延遲是多少？」

用日誌回答：把 24 小時內所有 placeOrder 的日誌撈出來（幾百萬行），
           解析出 latencyMs，排序，取第 99 百分位 → 慢、貴、且要有完整日誌

用指標回答：一個 PromQL 查詢，毫秒級回應
           histogram_quantile(0.99, rate(order_place_seconds_bucket[5m]))
```

**指標是「預先聚合」的資料，成本比日誌低好幾個數量級。**

### Micrometer 是什麼

```
      你的程式碼
          │
          │ MeterRegistry API
          ▼
   ┌──────────────┐
   │  Micrometer  │   ← 「指標界的 SLF4J」
   └──────┬───────┘
          │
   ┌──────┴───────┬──────────┬─────────┐
   ▼              ▼          ▼         ▼
Prometheus    Datadog   CloudWatch  New Relic
```

### 四種指標型別

```java
package com.example.shop.metrics;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicInteger;

@Component
public class MetricsDemo {

    private final Counter orderCreated;
    private final Timer paymentTimer;
    private final DistributionSummary orderAmount;
    private final AtomicInteger pendingOrders = new AtomicInteger();

    public MetricsDemo(MeterRegistry registry) {

        // ① Counter：只增不減的累計值（次數）
        this.orderCreated = Counter.builder("shop.order.created")
                .description("成功建立的訂單數")
                .tag("service", "shop")
                .register(registry);

        // ② Timer：測量耗時，自動產生 count / sum / max / 百分位
        this.paymentTimer = Timer.builder("shop.payment.duration")
                .description("付款處理耗時")
                .publishPercentiles(0.5, 0.95, 0.99)
                .publishPercentileHistogram()          // 讓 Prometheus 端可以算跨實例的百分位
                .register(registry);

        // ③ DistributionSummary：測量數值分布（非時間），例如金額、批次大小
        this.orderAmount = DistributionSummary.builder("shop.order.amount")
                .description("訂單金額分布")
                .baseUnit("TWD")
                .publishPercentiles(0.5, 0.95)
                .register(registry);

        // ④ Gauge：當下的瞬時值（可增可減），例如佇列長度、連線數
        Gauge.builder("shop.order.pending", pendingOrders, AtomicInteger::get)
                .description("待處理訂單數")
                .register(registry);
    }

    public void recordOrderCreated(java.math.BigDecimal amount) {
        orderCreated.increment();
        orderAmount.record(amount.doubleValue());
        pendingOrders.incrementAndGet();
    }

    public void recordPayment(Runnable paymentAction) {
        paymentTimer.record(paymentAction);      // 自動計時
    }
}
```

| 型別 | 語意 | 常見用途 |
|---|---|---|
| **Counter** | 單調遞增 | 請求數、錯誤數、事件數 |
| **Timer** | 耗時分布 | API 延遲、外部呼叫耗時 |
| **DistributionSummary** | 非時間的數值分布 | 訂單金額、回應大小、批次筆數 |
| **Gauge** | 瞬時值 | 佇列長度、快取大小、連線池使用中數量 |

> ⚠️ **Gauge 的陷阱**：Micrometer 對 Gauge 的參照是**弱參照**。
> 如果你註冊之後沒有保留那個物件的強參照，它會被 GC 回收，指標就變成 NaN。
> 所以上面的 `pendingOrders` 一定要是欄位，不能是區域變數。

### ★★ 標籤基數爆炸：本節最重要的警告 ★★

```java
// ❌❌ 災難級錯誤
Counter.builder("shop.order.created")
        .tag("orderId", String.valueOf(orderId))     // 💥 每筆訂單一個新指標
        .tag("userId", userId)                        // 💥 每個使用者一個新指標
        .tag("timestamp", Instant.now().toString())   // 💥 每次呼叫一個新指標
        .register(registry)
        .increment();
```

**後果**：

```
指標數量 = 訂單數 × 使用者數 × 時間點數

一天 10 萬筆訂單 → 10 萬個獨立的時間序列
Prometheus 記憶體爆掉 → 監控系統掛掉 → 你連「服務是不是活著」都不知道
```

> **真實案例**：某團隊在指標上加了 `orderId` 標籤。
> 上線第三天 Prometheus 的記憶體從 2 GB 漲到 48 GB，OOM 重啟，
> **所有服務的監控資料全部遺失**。而且因為監控掛了，
> 同時發生的一個真實故障完全沒有被發現。

**標籤的規則：**

```
✅ 可以當標籤（低基數，值的種類是有限且穩定的）
   status: SUCCESS / FAILURE / TIMEOUT           （3 種）
   paymentMethod: CREDIT_CARD / LINE_PAY / ...   （< 10 種）
   httpStatus: 200 / 400 / 404 / 500             （< 20 種）
   region: tw / jp / us                          （< 10 種）

❌ 絕對不能當標籤（高基數）
   orderId、userId、email、traceId、IP、時間戳、
   URL 的完整路徑（含 ID）、SQL 語句、錯誤訊息全文
```

**判斷準則：這個標籤的可能值會不會隨著業務量成長？** 會 → 不能用。

**高基數的資訊該放哪裡？**

```
低基數、要聚合  → 指標（Metrics）
高基數、要查詢  → 日誌（Logs）或追蹤（Traces）
```

### URL 路徑的處理

```java
// ❌ 用完整路徑當標籤
registry.counter("http.requests", "path", "/orders/1001").increment();
registry.counter("http.requests", "path", "/orders/1002").increment();
// → 每筆訂單一個時間序列

// ✅ 用路徑樣板
registry.counter("http.requests", "uri", "/orders/{id}").increment();
```

**Spring Boot 內建的 `http.server.requests` 指標已經幫你做好了**（用 `@GetMapping` 的樣板）。

```bash
$ curl -s localhost:8081/actuator/metrics/http.server.requests | jq '.availableTags'
[
  { "tag": "exception", "values": ["none", "PaymentFailedException"] },
  { "tag": "method",    "values": ["GET", "POST"] },
  { "tag": "uri",       "values": ["/orders", "/orders/{id}", "/actuator/health"] },
  { "tag": "outcome",   "values": ["SUCCESS", "CLIENT_ERROR", "SERVER_ERROR"] },
  { "tag": "status",    "values": ["200", "201", "400", "500"] }
]
```

> ⚠️ 但要小心：**如果請求打到不存在的路徑，`uri` 標籤會是 `NOT_FOUND`**（Spring 有處理）。
> 但某些自訂的路由（例如用 `HandlerMapping` 動態產生的）可能沒有樣板，
> 就會用完整路徑 → 被掃描攻擊時基數瞬間爆炸。
>
> 防護：
> ```yaml
> management:
>   metrics:
>     web:
>       server:
>         max-uri-tags: 100      # 超過 100 個不同的 uri 就停止記錄新的
> ```

### `@Timed` 與 `@Counted` 註解

需要註冊切面 Bean（回顧第 04 章——這也是 AOP）：

```java
package com.example.shop.config;

import io.micrometer.core.aop.CountedAspect;
import io.micrometer.core.aop.TimedAspect;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class MetricsAspectConfig {

    @Bean
    public TimedAspect timedAspect(MeterRegistry registry) {
        return new TimedAspect(registry);
    }

    @Bean
    public CountedAspect countedAspect(MeterRegistry registry) {
        return new CountedAspect(registry);
    }
}
```

```java
@Service
public class OrderService {

    @Timed(value = "shop.order.place",
           description = "建立訂單耗時",
           percentiles = {0.5, 0.95, 0.99},
           extraTags = {"layer", "service"})
    public Order placeOrder(String customer, BigDecimal amount) { /* ... */ }

    @Counted(value = "shop.order.cancel", description = "取消訂單次數")
    public void cancelOrder(long orderId) { /* ... */ }
}
```

> ⚠️ **`@Timed` 也受第 04 章所有 AOP 限制**：自呼叫、private、final 一律失效。

---

## 5.15 Prometheus + Grafana

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
    <scope>runtime</scope>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  metrics:
    tags:
      application: ${spring.application.name}    # ★ 全域標籤，區分不同服務 ★
      env: ${ENV:unknown}
  prometheus:
    metrics:
      export:
        enabled: true
```

```bash
$ curl -s localhost:8081/actuator/prometheus | head -20
# HELP jvm_memory_used_bytes The amount of used memory
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{application="shop-service",area="heap",env="prod",id="G1 Eden Space"} 1.34217728E8
# HELP http_server_requests_seconds
# TYPE http_server_requests_seconds histogram
http_server_requests_seconds_bucket{application="shop-service",method="POST",outcome="SUCCESS",status="201",uri="/orders",le="0.1"} 8421.0
http_server_requests_seconds_count{application="shop-service",method="POST",outcome="SUCCESS",status="201",uri="/orders"} 9102.0
http_server_requests_seconds_sum{application="shop-service",method="POST",outcome="SUCCESS",status="201",uri="/orders"} 412.331
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'shop-service'
    metrics_path: '/actuator/prometheus'
    scrape_interval: 15s
    static_configs:
      - targets: ['shop-service:8081']
```

### 值得建立的四個核心告警（Google SRE 的黃金訊號）

```yaml
# alerts.yml
groups:
  - name: shop-service
    rules:

      # ① 錯誤率（Errors）
      - alert: HighErrorRate
        expr: |
          sum(rate(http_server_requests_seconds_count{application="shop-service",outcome="SERVER_ERROR"}[5m]))
          /
          sum(rate(http_server_requests_seconds_count{application="shop-service"}[5m]))
          > 0.01
        for: 3m
        labels: { severity: critical }
        annotations:
          summary: "訂單服務 5xx 錯誤率超過 1%"
          description: "目前 {{ $value | humanizePercentage }}"

      # ② 延遲（Latency）
      - alert: HighLatency
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_server_requests_seconds_bucket{application="shop-service",uri="/orders"}[5m]))
            by (le)
          ) > 2
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "建立訂單 P99 延遲超過 2 秒"

      # ③ 流量異常（Traffic）—— 突然沒流量通常代表上游掛了
      - alert: TrafficDropped
        expr: |
          sum(rate(http_server_requests_seconds_count{application="shop-service"}[5m])) < 0.1
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "訂單服務幾乎沒有流量，可能上游異常"

      # ④ 飽和度（Saturation）
      - alert: ConnectionPoolExhausted
        expr: |
          hikaricp_connections_active{application="shop-service"}
          / hikaricp_connections_max{application="shop-service"} > 0.9
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "資料庫連線池使用率超過 90%"

      - alert: HighHeapUsage
        expr: |
          sum(jvm_memory_used_bytes{application="shop-service",area="heap"})
          / sum(jvm_memory_max_bytes{application="shop-service",area="heap"}) > 0.9
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "堆積記憶體使用率超過 90%，可能有記憶體洩漏"
```

> **`for: 3m` 這個欄位很重要**：它表示「持續 3 分鐘都滿足條件才告警」。
> 沒有它的話，一次短暫的抖動就會發告警——這又是告警疲勞的來源。

### 自動就有的指標（不用自己埋）

| 指標 | 內容 |
|---|---|
| `http_server_requests_seconds` | 所有 HTTP 端點的延遲與次數 |
| `jvm_memory_used_bytes` / `jvm_gc_*` | 記憶體與 GC |
| `jvm_threads_states_threads` | 執行緒狀態 |
| `hikaricp_connections_*` | 連線池 |
| `system_cpu_usage` / `process_cpu_usage` | CPU |
| `logback_events_total` | **各等級的日誌數量**（可以用來告警「ERROR 突增」） |
| `spring_data_repository_invocations_seconds` | Repository 方法耗時 |
| `cache_*` | 快取命中率 |
| `executor_*` | `@Async` 執行緒池狀態 |

> **`logback_events_total{level="error"}` 特別好用**：
> 它讓「ERROR 日誌突然增加」變成一個可以告警的指標，
> 不需要在日誌平台上設複雜的規則。

---

## 5.16 保護 Actuator

### 三道防線

```yaml
# ① 白名單：只開需要的
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
        # 絕對不要 include: "*"

# ② 獨立 port：業務流量與管理流量分離
  server:
    port: 8081
    address: 127.0.0.1        # 只監聽 loopback（配合 sidecar / 反向代理）

# ③ 健康檢查細節只給認證使用者
  endpoint:
    health:
      show-details: when-authorized
      show-components: when-authorized
      roles: ACTUATOR_ADMIN
```

### 用 Spring Security 保護（第 09 站會詳談）

```java
package com.example.shop.config;

import org.springframework.boot.actuate.autoconfigure.security.servlet.EndpointRequest;
import org.springframework.boot.actuate.health.HealthEndpoint;
import org.springframework.boot.actuate.info.InfoEndpoint;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class ActuatorSecurityConfig {

    @Bean
    @Order(1)                                    // 比業務的 filter chain 優先
    public SecurityFilterChain actuatorSecurity(HttpSecurity http) throws Exception {
        http
            .securityMatcher(EndpointRequest.toAnyEndpoint())
            .authorizeHttpRequests(auth -> auth
                    // health 與 info 公開（K8s 探針需要）
                    .requestMatchers(EndpointRequest.to(HealthEndpoint.class, InfoEndpoint.class))
                        .permitAll()
                    // 其他全部要認證
                    .anyRequest().hasRole("ACTUATOR_ADMIN"))
            .httpBasic(basic -> { })
            .csrf(csrf -> csrf.disable());       // 管理端點通常無狀態
        return http.build();
    }
}
```

### K8s 的網路層防護

```yaml
# service.yaml —— 只暴露 8080，8081 不對外
apiVersion: v1
kind: Service
metadata:
  name: shop-service
spec:
  ports:
    - name: http
      port: 80
      targetPort: 8080
    # 刻意不開 8081

---
# 給 Prometheus 用的獨立 Service（限 monitoring namespace）
apiVersion: v1
kind: Service
metadata:
  name: shop-service-metrics
spec:
  ports:
    - name: management
      port: 8081
      targetPort: 8081

---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: shop-service-metrics
spec:
  podSelector:
    matchLabels: { app: shop-service }
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: { name: monitoring }
      ports:
        - port: 8081
```

### 檢查清單

```
□ exposure.include 是白名單，不是 "*"
□ env / configprops / beans / heapdump / shutdown 沒有開
□ management.server.port 與業務 port 不同
□ Ingress / LB 沒有把管理 port 對外
□ health.show-details 不是 always
□ loggers 端點需要認證（它可以讓日誌量瞬間暴增）
□ /info 沒有洩漏內部主機名稱、路徑等資訊
```

---

## 5.17 實戰：訂單服務的完整可觀測性

把整章串起來。

### ① 依賴

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
    <scope>runtime</scope>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

### ② 業務指標

```java
package com.example.shop.order;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 訂單相關的業務指標。
 *
 * <p>設計原則：標籤只用「低基數」的維度（付款方式、結果），
 * 絕不使用 orderId / userId 這類會隨業務量成長的值。
 */
@Component
public class OrderMetrics {

    private final MeterRegistry registry;
    private final DistributionSummary amountSummary;
    private final AtomicInteger pendingCount = new AtomicInteger();

    /** 快取已建立的 Counter，避免每次呼叫都做一次 registry 查詢 */
    private final Map<String, Counter> counterCache = new ConcurrentHashMap<>();

    public OrderMetrics(MeterRegistry registry) {
        this.registry = registry;

        this.amountSummary = DistributionSummary.builder("shop.order.amount")
                .description("訂單金額分布")
                .baseUnit("TWD")
                .publishPercentiles(0.5, 0.9, 0.99)
                .register(registry);

        io.micrometer.core.instrument.Gauge
                .builder("shop.order.pending", pendingCount, AtomicInteger::get)
                .description("待處理訂單數")
                .register(registry);
    }

    public void orderCreated(String paymentMethod, BigDecimal amount) {
        counter("shop.order.created", "paymentMethod", paymentMethod, "outcome", "SUCCESS")
                .increment();
        amountSummary.record(amount.doubleValue());
        pendingCount.incrementAndGet();
    }

    public void orderFailed(String paymentMethod, String reason) {
        // reason 必須是「有限的錯誤碼」，不能是例外訊息全文
        counter("shop.order.created", "paymentMethod", paymentMethod,
                "outcome", "FAILURE", "reason", reason).increment();
    }

    public void orderCompleted() {
        pendingCount.decrementAndGet();
    }

    public Timer paymentTimer(String gateway) {
        return Timer.builder("shop.payment.duration")
                .tag("gateway", gateway)
                .publishPercentiles(0.5, 0.95, 0.99)
                .publishPercentileHistogram()
                .register(registry);
    }

    private Counter counter(String name, String... tags) {
        String key = name + String.join(",", tags);
        return counterCache.computeIfAbsent(key,
                k -> Counter.builder(name).tags(tags).register(registry));
    }
}
```

### ③ Service 整合

```java
package com.example.shop.order;

import com.example.shop.payment.PaymentService;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Clock;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final OrderRepository repository;
    private final PaymentService paymentService;
    private final OrderMetrics metrics;
    private final Clock clock;

    public OrderService(OrderRepository repository,
                        PaymentService paymentService,
                        OrderMetrics metrics,
                        Clock clock) {
        this.repository = repository;
        this.paymentService = paymentService;
        this.metrics = metrics;
        this.clock = clock;
    }

    @Transactional
    public Order placeOrder(String customerName, BigDecimal amount, String paymentMethod) {

        Order saved = repository.save(new Order(
                null, customerName, amount, paymentMethod, "CREATED", clock.instant()));

        // ★ 把 orderId 放進 MDC，後續所有日誌自動帶上 ★
        MDC.put("orderId", String.valueOf(saved.id()));
        try {
            log.info("訂單已建立，準備付款 amount={} method={}", amount, paymentMethod);

            Timer.Sample sample = Timer.start();
            try {
                paymentService.charge(String.valueOf(saved.id()), paymentMethod, amount);
                sample.stop(metrics.paymentTimer(paymentMethod));

            } catch (Exception e) {
                sample.stop(metrics.paymentTimer(paymentMethod));
                // ★ 錯誤碼是有限集合，可以當標籤；例外訊息全文則放日誌 ★
                metrics.orderFailed(paymentMethod, errorCode(e));
                log.error("訂單付款失敗 method={} amount={}", paymentMethod, amount, e);
                throw e;
            }

            Order paid = saved.withStatus("PAID");
            repository.save(paid);

            metrics.orderCreated(paymentMethod, amount);
            log.info("訂單成立 status=PAID");     // orderId 已在 MDC 裡，不用重複寫
            return paid;

        } finally {
            MDC.remove("orderId");                // ★ 誰放的誰清 ★
        }
    }

    /** 把例外映射成「有限的錯誤碼」，避免指標標籤基數爆炸 */
    private String errorCode(Exception e) {
        return switch (e) {
            case java.net.SocketTimeoutException ignored -> "TIMEOUT";
            case IllegalArgumentException ignored -> "INVALID_INPUT";
            default -> "UNKNOWN";
        };
    }
}
```

### ④ 完整的 `logback-spring.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <springProperty scope="context" name="appName"
                    source="spring.application.name" defaultValue="shop-service"/>

    <conversionRule conversionWord="maskedMsg"
                    class="com.example.shop.observability.MaskingMessageConverter"/>

    <!-- 本機：人類可讀 -->
    <appender name="CONSOLE_TEXT" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss.SSS} %highlight(%-5level) [%X{traceId:-........}] %cyan(%-40.40logger{39}) : %maskedMsg%n%wEx</pattern>
            <charset>UTF-8</charset>
        </encoder>
    </appender>

    <!-- 部署環境：JSON -->
    <appender name="CONSOLE_JSON" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder">
            <providers>
                <timestamp><timeZone>UTC</timeZone></timestamp>
                <logLevel/>
                <loggerName><shortenedLoggerNameLength>40</shortenedLoggerNameLength></loggerName>
                <threadName/>
                <message/>
                <mdc/>
                <arguments/>
                <stackTrace>
                    <throwableConverter class="net.logstash.logback.stacktrace.ShortenedThrowableConverter">
                        <maxDepthPerThrowable>30</maxDepthPerThrowable>
                        <maxLength>4096</maxLength>
                        <rootCauseFirst>true</rootCauseFirst>
                        <exclude>^org\.springframework\.aop\..*</exclude>
                        <exclude>^java\.base/jdk\.internal\.reflect\..*</exclude>
                    </throwableConverter>
                </stackTrace>
                <pattern>
                    <pattern>{"service":"${appName}","env":"${ENV:-unknown}","version":"${APP_VERSION:-dev}"}</pattern>
                </pattern>
            </providers>
        </encoder>
    </appender>

    <appender name="ASYNC_JSON" class="ch.qos.logback.classic.AsyncAppender">
        <appender-ref ref="CONSOLE_JSON"/>
        <queueSize>8192</queueSize>
        <discardingThreshold>0</discardingThreshold>
        <neverBlock>true</neverBlock>
        <includeCallerData>false</includeCallerData>
    </appender>

    <springProfile name="local">
        <root level="INFO"><appender-ref ref="CONSOLE_TEXT"/></root>
        <logger name="com.example.shop" level="DEBUG"/>
        <logger name="org.hibernate.SQL" level="DEBUG"/>
    </springProfile>

    <springProfile name="dev | staging | prod">
        <root level="WARN"><appender-ref ref="ASYNC_JSON"/></root>
        <logger name="com.example.shop" level="INFO"/>
    </springProfile>
</configuration>
```

### ⑤ 設定

```yaml
# application.yml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    health:
      probes:
        enabled: true
      show-details: when-authorized
      group:
        liveness:
          include: livenessState
        readiness:
          include: readinessState,db
  metrics:
    tags:
      application: ${spring.application.name}
      env: ${ENV:local}
    web:
      server:
        max-uri-tags: 100
  server:
    port: 8081

info:
  app:
    name: ${spring.application.name}
    version: ${APP_VERSION:dev}
```

### ⑥ 驗證

```bash
# 發一個請求，記下回應的 traceId
$ curl -i -X POST localhost:8080/orders \
    -H 'Content-Type: application/json' \
    -d '{"customerName":"王小明","amount":1280,"paymentMethod":"LINE_PAY"}'
HTTP/1.1 201
X-Trace-Id: a3f8c21b9d4e5f60      ← ★ 使用者回報問題時就報這個 ★

# 用 traceId 撈出這次請求的所有日誌
$ grep 'a3f8c21b9d4e5f60' logs/shop-service.log | jq -r \
    '"\(.["@timestamp"]) \(.["log.level"]) \(.["log.logger"]) \(.message)"'
2026-08-18T04:12:44.102Z INFO  c.e.shop.order.OrderService  訂單已建立，準備付款 amount=1280 method=LINE_PAY
2026-08-18T04:12:44.318Z INFO  c.e.shop.order.OrderService  訂單成立 status=PAID
2026-08-18T04:12:44.322Z INFO  c.e.s.o.TraceIdFilter        POST /orders -> 201 (223 ms)

# 看指標
$ curl -s localhost:8081/actuator/prometheus | grep shop_order
shop_order_created_total{application="shop-service",env="local",outcome="SUCCESS",paymentMethod="LINE_PAY"} 1.0
shop_order_amount_count{application="shop-service",env="local"} 1.0
shop_order_amount_sum{application="shop-service",env="local"} 1280.0
shop_order_pending{application="shop-service",env="local"} 1.0
```

---

## 5.18 常見錯誤

### ① 例外堆疊遺失

```java
log.error("失敗：{}", e.getMessage());       // ❌ 只有訊息，可能還是 null
log.error("失敗", e);                        // ✅
```

### ② 忘記 `MDC.clear()`

執行緒池污染，日誌欄位錯亂。**永遠用 `try-finally`。**

### ③ 日誌等級用錯，造成告警疲勞

正常的業務失敗（餘額不足、查無資料）記成 ERROR。

### ④ 沒設 `total-size-cap`，磁碟被寫爆

連帶把資料庫也拖垮。

### ⑤ 指標標籤基數爆炸

`orderId`、`userId` 當標籤 → Prometheus OOM。

### ⑥ 健康檢查放了外部依賴到 liveness

外部服務抖動 → 所有 Pod 一起重啟 → 雪崩。

### ⑦ `%method` / `%line` 在正式環境開啟

每行日誌都要抓堆疊，效能下降 10 倍以上。

### ⑧ `/heapdump` 對外開放

記憶體裡的密碼、token、個資全部外洩。

### ⑨ `@Async` 方法沒有 traceId

沒設 `TaskDecorator`，非同步任務的日誌完全孤立。

### ⑩ 同步 Appender 阻塞業務執行緒

磁碟慢或 NFS 掛載 → 日誌寫入變慢 → 業務執行緒卡在 `log.info()`。
**部署環境一律用 `AsyncAppender`，或直接寫 stdout 讓平台收集。**

### ⑪ 兩個 SLF4J 實作同時存在

```
SLF4J: Class path contains multiple SLF4J providers.
SLF4J: Found provider [ch.qos.logback.classic.spi.LogbackServiceProvider]
SLF4J: Found provider [org.slf4j.reload4j.Reload4jServiceProvider]
```

```bash
# 找出誰帶進來的
./mvnw dependency:tree -Dincludes=org.slf4j,ch.qos.logback,log4j
```

排除多餘的那個。

---

## 5.19 本章練習

### 練習 1：找出日誌問題

```java
@Service
public class PaymentService {
    private final Logger log = LoggerFactory.getLogger(getClass());

    public void charge(PaymentRequest request) {
        log.info("開始付款：" + request);
        try {
            gateway.charge(request);
            log.info("付款成功");
        } catch (Exception e) {
            log.error("付款失敗：" + e.getMessage());
            throw new RuntimeException(e);
        }
    }
}
```

找出所有問題。

<details>
<summary>參考解答</summary>

**六個問題：**

| # | 問題 | 後果 | 修正 |
|---|---|---|---|
| 1 | `LoggerFactory.getLogger(getClass())` | 有 AOP 代理時 logger 名稱變成 `PaymentService$$SpringCGLIB$$0`（第 04 章 4.16） | 改用 `PaymentService.class` |
| 2 | `logger` 不是 `static final` | 每個實例一份參照（雖然 SLF4J 會快取，但這是慣例問題） | `private static final Logger log` |
| 3 | 字串拼接 `"開始付款：" + request` | 即使等級不輸出也會執行拼接 | 用 `{}` 參數化 |
| 4 | **印出整個 `request` 物件** | 可能含信用卡號、身分證 | DTO 覆寫 `toString()` 遮蔽 |
| 5 | `log.error("付款失敗：" + e.getMessage())` | **堆疊完全遺失**，`getMessage()` 可能是 null | `log.error("...", e)` |
| 6 | `log.info("付款成功")` 沒有任何上下文 | 不知道是誰、哪筆、多少錢 | 加上關鍵欄位 |
| 7 | `throw new RuntimeException(e)` | 遺失語意，呼叫端無法分辨錯誤類型 | 用有意義的自訂例外 |

**修正版：**

```java
@Service
public class PaymentService {

    private static final Logger log = LoggerFactory.getLogger(PaymentService.class);

    private final PaymentGateway gateway;
    private final OrderMetrics metrics;

    public PaymentService(PaymentGateway gateway, OrderMetrics metrics) {
        this.gateway = gateway;
        this.metrics = metrics;
    }

    public void charge(PaymentRequest request) {
        MDC.put("orderId", request.orderId());
        try {
            log.info("開始付款 amount={} method={}", request.amount(), request.method());

            gateway.charge(request);

            log.info("付款成功 amount={}", request.amount());

        } catch (PaymentGatewayException e) {
            // ★ 例外當最後一個參數，堆疊才會被印出來 ★
            log.error("付款失敗 method={} amount={} errorCode={}",
                    request.method(), request.amount(), e.getCode(), e);
            throw new PaymentFailedException("付款失敗：" + e.getCode(), e);

        } finally {
            MDC.remove("orderId");
        }
    }
}
```

搭配遮蔽的 DTO：

```java
public record PaymentRequest(String orderId, String method,
                             BigDecimal amount, String cardNumber) {
    @Override
    public String toString() {
        return "PaymentRequest[orderId=%s, method=%s, amount=%s, cardNumber=%s]"
                .formatted(orderId, method, amount,
                        cardNumber == null ? "null"
                                : "*".repeat(Math.max(0, cardNumber.length() - 4))
                                  + cardNumber.substring(Math.max(0, cardNumber.length() - 4)));
    }
}
```

</details>

### 練習 2：判斷日誌等級

以下情境各該用什麼等級？

1. 使用者輸入的 email 格式不正確。
2. 訂單成功建立。
3. 呼叫金流 API 逾時，重試第 1 次。
4. 呼叫金流 API 重試 3 次後仍失敗。
5. 資料庫連線池耗盡。
6. 快取未命中，回源查詢資料庫。
7. 設定檔缺少某個屬性，使用預設值。
8. 收到不存在的 API 路徑請求（404）。
9. 使用者的 JWT 過期。
10. 偵測到同一 IP 一分鐘內嘗試登入 200 次。

<details>
<summary>參考解答</summary>

| # | 情境 | 等級 | 理由 |
|---|---|---|---|
| 1 | email 格式錯 | **DEBUG**（或不記） | 正常的使用者行為。統一由驗證機制回 400，不需要每次都寫日誌 |
| 2 | 訂單成功建立 | **INFO** | 重要的業務事件，查問題時需要 |
| 3 | 金流逾時重試第 1 次 | **WARN** | 不正常但系統在處理中。**不要用 ERROR**——重試成功的話沒有人需要介入 |
| 4 | 重試 3 次後仍失敗 | **ERROR** | 需要人介入（可能是金流商掛了） |
| 5 | 連線池耗盡 | **ERROR** | 系統性問題，需要立刻處理 |
| 6 | 快取未命中 | **TRACE**（或不記） | 這是正常運作的一部分。**用指標記錄命中率**，不要用日誌 |
| 7 | 設定用預設值 | **WARN**（啟動時記一次） | 可能是設定漏了。但**只在啟動時記一次**，不要每次用到都記 |
| 8 | 404 | **INFO**（或不記） | 統一由請求日誌記錄狀態碼即可 |
| 9 | JWT 過期 | **DEBUG** | 完全正常，前端會拿 refresh token 續期 |
| 10 | 一分鐘 200 次登入嘗試 | **WARN** + **指標** + **告警** | 疑似暴力破解。這種要同時記日誌、加指標，並設定告警規則 |

**兩個要點：**

1. **「重試中」是 WARN，「重試耗盡」才是 ERROR。**
   這個區分讓告警規則能精準地只在真的需要人介入時觸發。

2. **第 6 題示範了「日誌 vs 指標」的判斷**：
   快取命中率是一個**要看趨勢的比率**，用 Counter 記錄，
   在 Grafana 上看曲線。用日誌記錄每一次未命中，
   會產生海量無用資料，而且你還是算不出命中率。

</details>

### 練習 3：修正指標設計

```java
@Service
public class OrderService {
    private final MeterRegistry registry;

    public void placeOrder(Order order) {
        registry.counter("order.created",
                "orderId", String.valueOf(order.id()),
                "userId", order.userId(),
                "amount", order.amount().toString(),
                "createdAt", Instant.now().toString()
        ).increment();
    }

    public void handleError(Exception e) {
        registry.counter("order.error",
                "message", e.getMessage()
        ).increment();
    }
}
```

指出問題並修正。

<details>
<summary>參考解答</summary>

**問題：五個標籤全部都是高基數，這是教科書級的災難。**

| 標籤 | 可能值數量 | 後果 |
|---|---|---|
| `orderId` | = 訂單總數（無上限） | 每筆訂單一個時間序列 |
| `userId` | = 使用者總數（無上限） | 每個使用者一個時間序列 |
| `amount` | 幾乎每筆都不同 | 幾乎每筆訂單一個時間序列 |
| `createdAt` | **每次呼叫都不同** | 每次呼叫一個時間序列 |
| `message` | 例外訊息常含 ID、SQL、參數值 | 幾乎無限 |

**時間序列數量 = 這五個維度的笛卡兒積 ≈ 訂單數 × 4**。
一天 10 萬筆訂單 → 40 萬個新時間序列 → Prometheus 幾小時內 OOM。

**修正版：**

```java
package com.example.shop.order;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final MeterRegistry registry;
    private final DistributionSummary amountSummary;
    private final Map<String, Counter> counters = new ConcurrentHashMap<>();

    public OrderService(MeterRegistry registry) {
        this.registry = registry;
        // ★ 金額用 DistributionSummary 記錄「分布」，不要當標籤 ★
        this.amountSummary = DistributionSummary.builder("shop.order.amount")
                .baseUnit("TWD")
                .publishPercentiles(0.5, 0.9, 0.99)
                .register(registry);
    }

    public void placeOrder(Order order) {
        // 指標：只有低基數標籤
        counter("shop.order.created",
                "paymentMethod", order.paymentMethod(),      // < 10 種
                "channel", order.channel())                  // < 5 種
                .increment();

        amountSummary.record(order.amount().doubleValue());

        // ★ 高基數資訊放日誌（可查詢），不放指標（要聚合）★
        MDC.put("orderId", String.valueOf(order.id()));
        MDC.put("userId", order.userId());
        try {
            log.info("訂單建立 amount={} method={}", order.amount(), order.paymentMethod());
        } finally {
            MDC.remove("orderId");
            MDC.remove("userId");
        }
    }

    public void handleError(Exception e) {
        // ★ 例外訊息 → 有限的錯誤碼 ★
        counter("shop.order.error", "type", errorType(e)).increment();

        // 完整訊息與堆疊放日誌
        log.error("訂單處理失敗", e);
    }

    /** 把任意例外映射成有限的分類 */
    private String errorType(Exception e) {
        return switch (e) {
            case java.net.SocketTimeoutException ignored -> "TIMEOUT";
            case org.springframework.dao.DataAccessException ignored -> "DATABASE";
            case IllegalArgumentException ignored -> "VALIDATION";
            case SecurityException ignored -> "AUTHORIZATION";
            default -> "UNKNOWN";
        };
    }

    private Counter counter(String name, String... tags) {
        return counters.computeIfAbsent(name + String.join(",", tags),
                k -> Counter.builder(name).tags(tags).register(registry));
    }
}
```

**修正後的時間序列數量**：
`paymentMethod`（5 種）× `channel`（3 種）= **15 個**，不論訂單量多大都不會成長。

**加碼：如何在 CI 擋下這類問題**

```java
@Test
void 指標標籤數量不應超過門檻() {
    // 打一批模擬流量後檢查
    registry.getMeters().forEach(meter -> {
        long distinctTagValues = registry.getMeters().stream()
                .filter(m -> m.getId().getName().equals(meter.getId().getName()))
                .count();
        assertThat(distinctTagValues)
                .as("指標 %s 的時間序列數量過多，檢查是否用了高基數標籤",
                        meter.getId().getName())
                .isLessThan(100);
    });
}
```

</details>

### 練習 4：設計健康檢查

服務依賴：MySQL（必要）、Redis 快取（可降級）、金流 API（可降級）、
內部使用者服務（必要）。設計 liveness / readiness 分組與自訂 HealthIndicator。

<details>
<summary>參考解答</summary>

**先分類依賴：**

| 依賴 | 掛掉時服務還能用嗎 | 放哪裡 |
|---|---|---|
| MySQL | ❌ 完全不能 | **readiness** |
| 內部使用者服務 | ❌ 不能驗證身分 | **readiness** |
| Redis | ✅ 可以，只是變慢 | **只做 health detail，不影響整體狀態** |
| 金流 API | ✅ 可以，查詢功能正常 | 同上 |
| 程序本身 | — | **liveness**（只有這個） |

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true
      show-details: when-authorized
      group:
        liveness:
          include: livenessState              # ★ 只有這個 ★
        readiness:
          include: readinessState,db,userService
          show-details: always                # readiness 的細節給 K8s 看沒關係
      status:
        order: [DOWN, OUT_OF_SERVICE, DEGRADED, UP, UNKNOWN]
        http-mapping:
          DEGRADED: 200                       # 降級仍回 200，不要被踢出 LB
          DOWN: 503
  health:
    redis:
      enabled: false                          # 關掉內建的，改用自己的（不影響整體狀態）
```

```java
package com.example.shop.health;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.time.Instant;

/**
 * 內部使用者服務：必要依賴，掛掉就 DOWN。
 * 會被納入 readiness group。
 */
@Component("userService")
public class UserServiceHealthIndicator implements HealthIndicator {

    private final RestClient client;

    public UserServiceHealthIndicator(RestClient.Builder builder) {
        this.client = builder
                .baseUrl("http://user-service:8080")
                .build();
    }

    @Override
    public Health health() {
        Instant start = Instant.now();
        try {
            client.get().uri("/actuator/health/liveness")
                  .retrieve().toBodilessEntity();
            return Health.up()
                    .withDetail("latencyMs", Duration.between(start, Instant.now()).toMillis())
                    .build();
        } catch (Exception e) {
            return Health.down()
                    .withDetail("error", e.getClass().getSimpleName())
                    .build();
        }
    }
}
```

```java
package com.example.shop.health;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.stereotype.Component;

/**
 * Redis：可降級依賴。
 *
 * <p>★ 關鍵設計：掛掉時回 DEGRADED 而不是 DOWN ★
 * 而且這個 indicator 沒有被納入 readiness group，
 * 所以就算它 DEGRADED，K8s 也不會把 Pod 拿掉。
 * 它的價值是「讓 /health 的詳細資訊告訴值班人員快取有問題」。
 */
@Component("cache")
public class CacheHealthIndicator implements HealthIndicator {

    private final RedisConnectionFactory connectionFactory;

    public CacheHealthIndicator(RedisConnectionFactory connectionFactory) {
        this.connectionFactory = connectionFactory;
    }

    @Override
    public Health health() {
        try (var connection = connectionFactory.getConnection()) {
            connection.ping();
            return Health.up().withDetail("mode", "cache-enabled").build();
        } catch (Exception e) {
            return Health.status("DEGRADED")
                    .withDetail("error", e.getClass().getSimpleName())
                    .withDetail("impact", "快取停用，查詢會直接打資料庫，延遲上升")
                    .build();
        }
    }
}
```

```java
package com.example.shop.health;

import com.example.shop.config.ShopProperties;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 金流：可降級依賴。掛掉時只影響「新訂單付款」，查詢功能正常。
 */
@Component("paymentGateway")
public class PaymentGatewayHealthIndicator implements HealthIndicator {

    private final RestClient client;
    private final ShopProperties properties;

    public PaymentGatewayHealthIndicator(RestClient.Builder builder, ShopProperties properties) {
        this.properties = properties;
        this.client = builder.baseUrl(properties.payment().endpoint()).build();
    }

    @Override
    public Health health() {
        if (properties.payment().mode() == ShopProperties.Payment.Mode.FAKE) {
            return Health.up().withDetail("mode", "FAKE").build();     // 本機不真的檢查
        }
        try {
            client.get().uri("/health").retrieve().toBodilessEntity();
            return Health.up().withDetail("mode", properties.payment().mode()).build();
        } catch (Exception e) {
            return Health.status("DEGRADED")
                    .withDetail("error", e.getClass().getSimpleName())
                    .withDetail("impact", "無法建立新訂單，既有訂單查詢正常")
                    .build();
        }
    }
}
```

**K8s 設定：**

```yaml
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8081 }
  periodSeconds: 10
  failureThreshold: 3
  timeoutSeconds: 3

readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8081 }
  periodSeconds: 5
  failureThreshold: 2
  timeoutSeconds: 3

startupProbe:
  httpGet: { path: /actuator/health/liveness, port: 8081 }
  failureThreshold: 30
  periodSeconds: 10
```

**驗證：**

```bash
# Redis 掛掉時
$ curl -s localhost:8081/actuator/health | jq
{
  "status": "UP",                       ← ★ 整體仍是 UP ★
  "components": {
    "db": { "status": "UP" },
    "userService": { "status": "UP" },
    "cache": {
      "status": "DEGRADED",
      "details": { "impact": "快取停用，查詢會直接打資料庫，延遲上升" }
    }
  }
}

$ curl -s -o /dev/null -w '%{http_code}' localhost:8081/actuator/health/readiness
200                                     ← ★ K8s 不會把 Pod 拿掉 ★
```

**這個設計的核心思想：**

> **健康檢查不是「所有依賴都好」，而是「我現在還能不能提供服務」。**
>
> 把可降級的依賴放進 readiness，等於是「快取掛了就自殺」——
> 這會把一個「延遲上升」的小問題，放大成「整個服務不可用」的大事故。

</details>

### 練習 5：從日誌診斷問題

正式環境的訂單服務出現這些現象，用本章的工具設計排查步驟：

1. P99 延遲從 200ms 升到 3 秒，但錯誤率沒變。
2. 日誌裡有大量 `userId` 對不上的稽核紀錄。
3. Prometheus 抓不到這個服務的指標。
4. 服務每隔約 20 分鐘就被 K8s 重啟一次。

<details>
<summary>參考解答</summary>

**1. P99 延遲上升但錯誤率不變**

```bash
# ① 先確認是全部端點還是特定端點
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket{application="shop-service"}[5m])) by (le, uri))
# → 如果只有 /orders 慢，範圍就縮小了

# ② 看是不是外部依賴變慢
histogram_quantile(0.99,
  sum(rate(shop_payment_duration_seconds_bucket[5m])) by (le, gateway))

# ③ 看連線池
hikaricp_connections_pending{application="shop-service"}     # 等待連線的執行緒數
hikaricp_connections_acquire_seconds_max                     # 取得連線的耗時

# ④ 看 GC
rate(jvm_gc_pause_seconds_sum[5m])                           # 每秒花在 GC 的時間

# ⑤ 找幾個慢請求的 traceId
grep '"latencyMs":[0-9]\{4,\}' app.json | jq -r '.traceId' | head -5
# 再用 traceId 撈完整路徑，看時間花在哪一段
```

**常見根因**：連線池不足、外部 API 變慢、GC 停頓變長、資料量成長導致某個查詢沒走索引。

---

**2. `userId` 對不上的稽核紀錄**

**這是 MDC 沒清乾淨造成的執行緒池污染**（5.9 陷阱 1）。

```bash
# 驗證：同一個執行緒的連續請求，userId 有沒有異常延續
grep '"thread.name":"http-nio-8080-exec-7"' app.json \
  | jq -r '[.["@timestamp"], .traceId, .userId] | @tsv' | head -20
# 如果看到相鄰兩個不同 traceId 卻有相同 userId → 確認是污染
```

排查：

```
□ TraceIdFilter 有沒有 finally { MDC.clear(); }？
□ 業務程式碼裡有沒有 MDC.put 卻沒有對應的 remove？
□ @Async 的 TaskDecorator 有沒有在 finally 還原 MDC？
□ 有沒有攔截器在 preHandle 放 MDC 但 afterCompletion 沒清？
```

---

**3. Prometheus 抓不到指標**

```bash
# ① 端點本身通嗎（從 Pod 內部）
kubectl exec -it <pod> -- curl -s localhost:8081/actuator/prometheus | head -3

# ② 端點有沒有被 expose
kubectl exec -it <pod> -- curl -s localhost:8081/actuator | jq '._links | keys'

# ③ 網路通嗎（從 Prometheus 那邊）
kubectl exec -it -n monitoring <prometheus-pod> -- \
  curl -s http://shop-service-metrics:8081/actuator/prometheus | head -3

# ④ Prometheus 的目標狀態
# 打開 Prometheus UI → Status → Targets → 看這個 job 的 error 訊息
```

常見原因：

- `exposure.include` 沒有加 `prometheus`。
- 沒加 `micrometer-registry-prometheus` 依賴。
- 管理 port 是 8081 但 Service 只開了 8080。
- `management.server.address: 127.0.0.1` 導致外部連不進來。
- NetworkPolicy 擋住了。
- Security 設定把 `/actuator/prometheus` 也要求認證了。

---

**4. 每 20 分鐘被重啟**

**先確認是被誰殺的：**

```bash
kubectl describe pod <pod> | grep -A5 'Last State'
```

| `Reason` | 意義 | 排查方向 |
|---|---|---|
| `OOMKilled` | 容器記憶體超過 limit | 記憶體洩漏 or heap 設定太大 |
| `Error` + `Liveness probe failed` | liveness 失敗 | 探針設定 or 服務真的卡住 |
| `Completed` | 程序正常結束 | 應用程式自己退出了 |

**如果是 OOMKilled：**

```promql
# 看堆積使用趨勢——如果是持續上升不下降的鋸齒，就是洩漏
jvm_memory_used_bytes{application="shop-service",area="heap"}

# 看非堆積（Metaspace、直接記憶體）
jvm_memory_used_bytes{application="shop-service",area="nonheap"}
```

> ⚠️ **容器裡的經典陷阱**：JVM 堆積上限沒有考慮容器的 memory limit。
> 容器 limit 設 1 GB，但 JVM 的 `-Xmx` 也設 1 GB → 加上 Metaspace、
> 執行緒堆疊、直接記憶體，實際用量超過 1 GB → 被 OOMKilled。
>
> JDK 10+ 預設會偵測容器限制（`UseContainerSupport`），
> 但保險做法是明確設定：
> ```
> -XX:MaxRAMPercentage=70.0
> ```
> 而不是寫死 `-Xmx`。

**如果是 liveness 失敗：**

```
□ liveness group 裡有沒有放外部依賴？（最常見的錯誤）
□ timeoutSeconds 會不會太短？
□ 有沒有設 startupProbe？（啟動慢的服務一定要設）
□ 服務是不是真的卡住了？→ 抓 thread dump
```

```bash
curl -s localhost:8081/actuator/threaddump > dump.json
# 找 BLOCKED / WAITING 的執行緒
jq -r '.threads[] | select(.threadState=="BLOCKED") |
       "\(.threadName) blocked on \(.lockOwnerName)"' dump.json
```

01-java-core 第 09 章有完整的 OOM 與 thread dump 診斷流程，可以對照閱讀。

</details>

---

## 5.20 驗收清單

- [ ] 我能說明 SLF4J / Logback / Log4j2 / JUL 的關係，以及橋接器的作用。
- [ ] 我知道橋接器與實作同時存在會造成無限迴圈。
- [ ] 我一律用參數化 `{}`，不用字串拼接。
- [ ] **我知道例外要當最後一個參數傳給 log，不能寫成 `e.getMessage()`。**
- [ ] 我不吞例外，也不用 `e.printStackTrace()`。
- [ ] 我能設計團隊的日誌等級規範，並說明「ERROR = 需要人介入」。
- [ ] 我知道 ERROR 濫用會造成告警疲勞，也知道這造成過什麼後果。
- [ ] 我會用 `/actuator/loggers` 在不重啟的情況下動態調整等級。
- [ ] 我知道 `logging.logback.rollingpolicy.total-size-cap` 一定要設。
- [ ] 我知道要用 `logback-spring.xml` 而不是 `logback.xml`。
- [ ] 我能寫出含 Appender、滾動策略、`<springProfile>`、`AsyncAppender` 的完整設定。
- [ ] 我知道 `%method` / `%line` 極慢，正式環境不能用。
- [ ] 我知道 `additivity="false"` 的作用。
- [ ] 我能說明結構化日誌的價值，並用內建功能或 logstash-encoder 產出 JSON。
- [ ] 我知道本機用文字、部署環境用 JSON。
- [ ] **我能用 MDC 實作追蹤 ID，並知道 `MDC.clear()` 漏掉會造成執行緒池污染。**
- [ ] 我知道 `@Async` 會遺失 MDC，也會用 `TaskDecorator` 解決。
- [ ] 我知道 traceId 要沿用上游的 header，並回傳給呼叫端。
- [ ] 我知道 Spring Boot 3 用 Micrometer Tracing（不是 Sleuth）。
- [ ] 我會設計敏感資料遮蔽的三道防線。
- [ ] 我知道 Actuator 哪些端點正式環境絕對不能開。
- [ ] 我能寫自訂 `HealthIndicator`，並知道健康檢查要快、不要檢查非必要依賴。
- [ ] **我知道 liveness 不能放外部依賴，否則會造成集體重啟雪崩。**
- [ ] 我知道 `startupProbe` 解決什麼問題。
- [ ] 我能用 Counter / Timer / Gauge / DistributionSummary，並知道各自的語意。
- [ ] 我知道 Gauge 是弱參照，要保留強參照。
- [ ] **我知道標籤基數爆炸的後果，也能判斷哪些值不能當標籤。**
- [ ] 我知道「低基數要聚合的放指標、高基數要查詢的放日誌」。
- [ ] 我會把服務接上 Prometheus，並寫出四個黃金訊號的告警規則。
- [ ] 我知道告警要設 `for:` 避免抖動誤報。
- [ ] 我能用獨立 port + 白名單 + Security 三道防線保護 Actuator。

---

完成後請前往 [06-scheduling-async-and-events.md](./06-scheduling-async-and-events.md)。
