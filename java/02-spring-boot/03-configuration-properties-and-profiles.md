# 第 03 章：設定檔與多環境

> 這一章講的東西，出事時的殺傷力比前兩章加起來還大。
>
> **前兩章的錯誤會讓服務啟動失敗** —— 難看，但沒有真的損失。
> **這一章的錯誤會讓服務「成功啟動」，然後連到錯的資料庫、用錯的金流帳號、把密碼印在日誌裡。**
>
> 我看過的三個真實事故：
> - 測試環境的 `application.yml` 忘了改，壓測直接打進正式資料庫，寫進 12 萬筆假訂單。
> - `application.yml` 裡的資料庫密碼被 commit 進 Git，專案轉 public 之後被掃到。
> - 環境變數名稱少一個底線，`SPRING_PROFILES_ACTIVE` 沒生效，正式環境跑了三週的 dev 設定。
>
> 這三件事都不是「不會寫程式」，而是**不知道設定是怎麼被讀取、被覆寫、被曝露的**。

---

## 3.1 學習目標

完成本章後，你應該可以：

- 說明為什麼設定要外部化（12-Factor App 的 config 原則），以及「什麼該外部化、什麼不該」。
- 熟練 YAML 語法，並避開縮排、型別推斷、特殊字元三類陷阱。
- **背出屬性來源的優先順序**，並用實驗驗證誰蓋過誰。
- 分辨 `@Value` 與 `@ConfigurationProperties` 的適用場景，知道為什麼後者才是主力。
- 用 `record` 做建構子綁定，讓設定物件不可變。
- 為設定加上 Bean Validation，讓錯誤的設定在**啟動時**就爆。
- 說明 relaxed binding 的命名規則，以及環境變數該怎麼寫。
- 使用 `Duration`、`DataSize`、`Enum`、`List`、`Map` 等型別，並寫自訂 `Converter`。
- 設計 dev / test / staging / prod 四環境的設定拆法，說明每一層放什麼。
- 用命令列、環境變數、外部檔案、`spring.config.import` 四種方式做外部化設定。
- 說明四種密鑰管理方案的取捨，並知道「絕對不能做的事」。
- 用 Actuator 檢視設定，並確認敏感值有被遮蔽。

---

## 3.2 為什麼設定要外部化

### 反面教材

```java
@Service
public class PaymentService {
    private static final String API_KEY = "sk_live_51H8xK2LmN9pQrS7tU3vW";   // 💥
    private static final String ENDPOINT = "https://api.stripe.com/v1/charges";
    private static final int TIMEOUT_MS = 5000;
}
```

三個問題，一個比一個嚴重：

1. **改一個逾時值要重新編譯、重新部署。**
2. **開發、測試、正式環境的值不一樣，要靠 `if` 或改程式碼。**
3. **金鑰進了版控。** 就算之後 commit 刪掉，Git 歷史裡永遠都在。

> **關於第 3 點的殘酷事實**：GitHub 上有機器人專門掃描新 push 的 commit 找 AWS / Stripe / OpenAI 金鑰，
> 從 push 到被盜用**通常不到五分鐘**。
> 而且「刪掉那一行再 commit」完全沒用——歷史裡還在。要用 `git filter-repo` 重寫歷史，
> 而且**必須同時去服務商後台把金鑰作廢**。

### 12-Factor App 的原則

> **把設定嚴格地與程式碼分離。**
> 判斷標準：**你能不能把這份程式碼開源，而不洩漏任何憑證？**

```
✅ 該外部化（會隨環境變動）
   資料庫連線資訊、外部 API 端點與金鑰、快取伺服器位址
   執行緒池大小、逾時時間、重試次數、功能開關、日誌等級

❌ 不該外部化（跟環境無關的業務常數）
   訂單狀態的列舉值、稅率計算公式、URL 路由
   —— 這些放進設定檔只會讓程式更難懂
```

> **常見的過度設計**：把「訂單最多可以有幾個品項」做成設定。
> 結果三年後沒人記得這個設定存在，正式環境的值和文件不一致，
> 每次出事都要先花十分鐘確認「現在到底設多少」。
>
> **判斷準則：這個值在不同環境會不會不一樣？** 不會 → 就是常數，寫在程式碼裡。

---

## 3.3 properties vs YAML

Spring Boot 兩種都支援。**本課用 YAML**，理由在下面。

### 同一份設定的兩種寫法

```properties
# application.properties
server.port=8080
server.servlet.context-path=/api
spring.datasource.url=jdbc:mysql://localhost:3306/shop
spring.datasource.username=root
spring.datasource.hikari.maximum-pool-size=20
spring.datasource.hikari.connection-timeout=3000
shop.notification.channels[0]=EMAIL
shop.notification.channels[1]=SMS
shop.limits.order.max-amount=1000000
shop.limits.order.max-items=99
```

```yaml
# application.yml
server:
  port: 8080
  servlet:
    context-path: /api

spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop
    username: root
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000

shop:
  notification:
    channels:
      - EMAIL
      - SMS
  limits:
    order:
      max-amount: 1000000
      max-items: 99
```

YAML 的優點：階層清楚、不用一直重複前綴、陣列與巢狀物件好寫。
properties 的優點：沒有縮排問題、`grep` 好找、工具支援簡單。

> **兩個都存在時，`.properties` 優先**（後載入的蓋前面的，properties 後載入）。
> **不要兩個都放** —— 這是很容易搞混的來源。

### YAML 陷阱 ①：縮排必須用空白，不能用 Tab

```yaml
server:
	port: 8080          # ❌ 用了 Tab，啟動時報 YAML 解析錯誤
```

錯誤訊息通常很難懂：

```
while scanning for the next token
found character '\t(TAB)' that cannot start any token.
```

**IDE 設定：把 YAML 的 Tab 自動轉成 2 個空白。**

### YAML 陷阱 ②：型別自動推斷

```yaml
shop:
  version: 1.20              # → Double 1.2（尾端的 0 消失了！）
  version-str: "1.20"        # → String "1.20" ✅

  enabled: yes               # YAML 1.1 → Boolean true（SnakeYAML 的行為）
  enabled-str: "yes"         # → String "yes"

  country: NO                # → Boolean false！（挪威的國碼被當成 no）
  country-str: "NO"          # → String "NO" ✅

  zipcode: 08001             # → Integer 8001（前導 0 被吃掉）
  zipcode-str: "08001"       # → String "08001" ✅

  password: 12345678         # → Integer（如果目標型別是 String 會轉回來，但中間可能出事）
  password-str: "12345678"   # ✅
```

> **真實案例（`NO` 問題）**：某跨境電商的國家設定寫成
> ```yaml
> shop:
>   supported-countries: [TW, JP, US, NO, SE]
> ```
> 綁定成 `List<String>` 時，`NO` 變成了字串 `"false"`。
> 挪威的訂單全部被判定為「不支援的國家」，查了兩天才發現是 YAML 的鍋。

**規則：字串型的設定值，一律加引號。** 尤其是版本號、郵遞區號、國碼、密碼、電話號碼。

### YAML 陷阱 ③：特殊字元

```yaml
shop:
  password: p@ssw0rd!            # ⚠️ 開頭不是特殊字元就 OK，但很危險
  password2: "@secret"           # ✅ @ 開頭一定要引號（YAML 保留字元）
  password3: '*star'             # ✅ * 是 YAML 的錨點參照
  message: "Hello: World"        # ✅ 值裡有冒號+空白一定要引號
  path: C:\Users\dev             # ⚠️ 反斜線在雙引號內是跳脫字元
  path2: 'C:\Users\dev'          # ✅ 單引號內反斜線是字面值
  path3: "C:\\Users\\dev"        # ✅ 雙引號要跳脫
```

**單引號 vs 雙引號**：

| | 單引號 `'...'` | 雙引號 `"..."` |
|---|---|---|
| 跳脫字元 | 不處理（`\n` 就是兩個字元） | 處理（`\n` 是換行） |
| 內含引號 | 用 `''` 表示 `'` | 用 `\"` 表示 `"` |
| 建議 | **密碼、路徑用這個** | 需要換行等跳脫時用 |

### YAML 陷阱 ④：多行字串

```yaml
shop:
  # | 保留換行
  banner: |
    第一行
    第二行
    第三行
  # → "第一行\n第二行\n第三行\n"

  # |- 保留換行但去掉結尾換行
  banner2: |-
    第一行
    第二行
  # → "第一行\n第二行"

  # > 折疊成一行（換行變空白）
  description: >
    這是一段很長的說明，
    寫成多行方便閱讀，
    實際會變成一行。
  # → "這是一段很長的說明， 寫成多行方便閱讀， 實際會變成一行。\n"

  # 私鑰之類的多行內容一定要用 |
  private-key: |
    -----BEGIN PRIVATE KEY-----
    MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...
    -----END PRIVATE KEY-----
```

### YAML 陣列與 Map 的兩種寫法

```yaml
shop:
  # 陣列：區塊寫法
  channels:
    - EMAIL
    - SMS
    - LINE
  # 陣列：流式寫法
  channels2: [EMAIL, SMS, LINE]

  # 物件陣列
  gateways:
    - name: stripe
      endpoint: https://api.stripe.com
      timeout: 5s
    - name: linepay
      endpoint: https://api.line.me
      timeout: 3s

  # Map
  rate-limits:
    default: 100
    premium: 1000
    internal: 10000
```

---

## 3.4 屬性來源與優先順序

**這一節是本章最重要的部分。** 搞不清楚優先順序，你就無法解釋「為什麼我改了設定沒有生效」。

### 完整優先順序（由高到低）

Spring Boot 3 的順序（節錄常用的）：

```
高 ┌─ ①  Devtools 的全域設定（~/.config/spring-boot/）— 僅開發模式
   │  ②  測試的 @TestPropertySource
   │  ③  測試的 @SpringBootTest(properties = {...})
   │  ④  ★ 命令列參數（--server.port=9090）
   │  ⑤  SPRING_APPLICATION_JSON（環境變數或系統屬性中的 JSON）
   │  ⑥  ServletConfig / ServletContext 參數
   │  ⑦  JNDI 屬性
   │  ⑧  ★ Java 系統屬性（-Dserver.port=9090）
   │  ⑨  ★ 作業系統環境變數（SERVER_PORT=9090）
   │  ⑩  RandomValuePropertySource（${random.int}）
   │  ⑪  ★ jar 外部的 application-{profile}.yml
   │  ⑫  ★ jar 內部的 application-{profile}.yml
   │  ⑬  ★ jar 外部的 application.yml
   │  ⑭  ★ jar 內部的 application.yml
   │  ⑮  @PropertySource
低 └─ ⑯  SpringApplication.setDefaultProperties()
```

**實務上只要記住這五條（★）的相對順序：**

```
命令列參數  >  系統屬性(-D)  >  環境變數  >  外部設定檔  >  jar 內設定檔

而且：application-{profile}.yml  永遠贏過  application.yml
      jar 外部的                永遠贏過  jar 內部的
```

### 用實驗驗證

`src/main/resources/application.yml`：

```yaml
server:
  port: 8080
shop:
  greeting: "來自 application.yml"
```

`src/main/resources/application-dev.yml`：

```yaml
shop:
  greeting: "來自 application-dev.yml"
```

```java
package com.example.shop.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class ConfigProbeController {

    private final Environment env;

    @Value("${shop.greeting}")
    private String greeting;

    public ConfigProbeController(Environment env) {
        this.env = env;
    }

    @GetMapping("/probe")
    public Map<String, Object> probe() {
        return Map.of(
                "greeting", greeting,
                "port", env.getProperty("server.port", "未設定"),
                "activeProfiles", env.getActiveProfiles());
    }
}
```

依序執行，觀察結果：

```bash
# 實驗 1：什麼都不加
$ java -jar shop.jar
$ curl -s localhost:8080/probe | jq
{ "greeting": "來自 application.yml", "port": "8080", "activeProfiles": [] }

# 實驗 2：啟用 dev profile（⑫ 勝過 ⑭）
$ java -jar shop.jar --spring.profiles.active=dev
$ curl -s localhost:8080/probe | jq
{ "greeting": "來自 application-dev.yml", "port": "8080", "activeProfiles": ["dev"] }

# 實驗 3：環境變數（⑨ 勝過 ⑫）
$ SHOP_GREETING="來自環境變數" java -jar shop.jar --spring.profiles.active=dev
{ "greeting": "來自環境變數", ... }

# 實驗 4：系統屬性（⑧ 勝過 ⑨）
$ SHOP_GREETING="來自環境變數" java -Dshop.greeting="來自 -D" -jar shop.jar --spring.profiles.active=dev
{ "greeting": "來自 -D", ... }

# 實驗 5：命令列參數（④ 勝過全部）
$ SHOP_GREETING="來自環境變數" java -Dshop.greeting="來自 -D" -jar shop.jar \
    --spring.profiles.active=dev --shop.greeting="來自命令列"
{ "greeting": "來自命令列", ... }

# 實驗 6：jar 外部的 application.yml（⑬ 勝過 ⑭，也勝過 jar 內的 dev profile ⑫）
$ echo 'shop:
  greeting: "來自 jar 外部檔案"' > application.yml
$ java -jar shop.jar --spring.profiles.active=dev
{ "greeting": "來自 jar 外部檔案", ... }
```

> **實驗 6 特別重要**：很多人以為「profile 專屬檔案一定最優先」，
> 但 **jar 外部的 `application.yml` 會蓋過 jar 內部的 `application-dev.yml`**。
> 這在 Docker 部署時常造成困惑——`/app` 目錄下不小心留了一份 `application.yml`，
> 你在映像檔裡改的 profile 設定完全沒生效。

### jar 外部設定檔的搜尋位置

Spring Boot 會依序搜尋這四個位置（**後面的優先**）：

```
1. classpath:/                          （jar 內的 resources 根目錄）
2. classpath:/config/                   （jar 內的 resources/config/）
3. file:./                              （執行目錄）
4. file:./config/                       （執行目錄的 config/）
5. file:./config/*/                     （config 底下的子目錄，Boot 2.3+）
```

```
部署目錄
├── shop-service.jar
├── application.yml              ← 位置 3
└── config/
    ├── application.yml          ← 位置 4（贏過位置 3）
    └── shop/
        └── application.yml      ← 位置 5
```

自訂位置：

```bash
# 只從指定位置找（會取代預設位置）
java -jar shop.jar --spring.config.location=file:/etc/shop/

# 在預設位置之外「額外」增加（推薦，不會意外關掉預設行為）
java -jar shop.jar --spring.config.additional-location=file:/etc/shop/

# 改檔名（不叫 application）
java -jar shop.jar --spring.config.name=shop-service
```

### 環境變數的命名轉換

這是**上線時最常出錯的地方**。

```
屬性名稱                             環境變數名稱
─────────────────────────────────────────────────────────────
server.port                    →    SERVER_PORT
spring.datasource.url          →    SPRING_DATASOURCE_URL
spring.profiles.active         →    SPRING_PROFILES_ACTIVE
shop.notification.email-from   →    SHOP_NOTIFICATION_EMAILFROM
                                    （連字號直接刪掉！）
                               或   SHOP_NOTIFICATION_EMAIL_FROM
                                    （底線也可以，relaxed binding 兩者都認）
shop.gateways[0].name          →    SHOP_GATEWAYS_0_NAME
```

**轉換規則**：

```
1. 點（.）→ 底線（_）
2. 連字號（-）→ 刪除，或轉底線
3. 全部大寫
4. 陣列索引 [0] → _0_
```

> **真實案例**：K8s 的 deployment.yaml 裡寫了
> ```yaml
> env:
>   - name: SPRING_PROFILE_ACTIVE      # ❌ 少了一個 S（PROFILES）
>     value: prod
> ```
> 服務照常啟動，日誌裡有一行 `No active profile set, falling back to "default"`，
> 但沒人注意到。跑了三週的開發設定（日誌 DEBUG 等級、快取關閉、假金流），
> 直到有人問「為什麼正式環境的日誌這麼大」才發現。
>
> **防禦做法**：在 `ApplicationReadyEvent` 加一個檢查，正式環境沒有 profile 就直接讓服務失敗。
> 3.10 節會給出程式碼。

### `SPRING_APPLICATION_JSON`：一次設一整包

```bash
# 適合 K8s / CI 這種「只能給幾個環境變數」的場景
SPRING_APPLICATION_JSON='{"shop":{"notification":{"email-from":"noreply@shop.com"},"limits":{"max-amount":500000}}}' \
  java -jar shop.jar

# 也可以用系統屬性
java -Dspring.application.json='{"server":{"port":9090}}' -jar shop.jar
```

---

## 3.5 `@Value`：能用，但不是主力

```java
package com.example.shop.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class NotificationService {

    @Value("${shop.notification.email-from}")
    private String emailFrom;

    @Value("${shop.notification.retry-count:3}")            // 冒號後面是預設值
    private int retryCount;

    @Value("${shop.notification.channels}")                 // 逗號分隔的字串會自動轉 List
    private List<String> channels;

    @Value("${SHOP_API_KEY}")                               // 直接讀環境變數
    private String apiKey;

    @Value("#{systemProperties['user.timezone']}")          // SpEL
    private String timezone;

    @Value("#{${shop.notification.retry-count:3} * 1000}")  // SpEL 運算
    private int retryDelayMs;
}
```

### 建構子注入版本（比欄位注入好）

```java
@Service
public class NotificationService {

    private final String emailFrom;
    private final int retryCount;

    public NotificationService(
            @Value("${shop.notification.email-from}") String emailFrom,
            @Value("${shop.notification.retry-count:3}") int retryCount) {
        this.emailFrom = emailFrom;
        this.retryCount = retryCount;
    }
}
```

### `@Value` 的五個問題

| # | 問題 | 說明 |
|---|---|---|
| 1 | **設定分散** | 十個地方用到 `shop.notification.*`，你要 grep 才知道有哪些設定 |
| 2 | **沒有型別安全的整體** | 每個欄位獨立，無法「把一組設定當成一個物件傳遞」 |
| 3 | **無法做 Bean Validation** | 不能用 `@NotBlank`、`@Min` 驗證 |
| 4 | **打錯字只有執行期才知道** | `${shop.notifcation.xxx}` 少一個 i，啟動時才報 `Could not resolve placeholder` |
| 5 | **沒有 IDE 支援** | 不會出現在 `spring-configuration-metadata.json`，寫 yml 時沒有自動完成 |

> **實務規則**：
> - **一兩個獨立的值**（例如 `@Value("${spring.application.name}")`）→ 用 `@Value` 沒問題。
> - **一組相關的設定**（三個以上，或有巢狀）→ 一律用 `@ConfigurationProperties`。

### 常見錯誤：`@Value` 用在 `static` 欄位

```java
@Component
public class Constants {
    @Value("${shop.api-key}")
    public static String API_KEY;      // ❌ 永遠是 null
}
```

Spring 用**實例欄位**的反射注入，靜態欄位不會被處理。

```java
// 如果真的需要（通常代表設計有問題），用 setter 繞
@Component
public class Constants {
    public static String API_KEY;

    @Value("${shop.api-key}")
    public void setApiKey(String apiKey) {
        Constants.API_KEY = apiKey;
    }
}
```

---

## 3.6 `@ConfigurationProperties`：主力

### 基本用法

```yaml
shop:
  notification:
    enabled: true
    email-from: noreply@shop.example.com
    retry-count: 3
    timeout: 5s
    channels:
      - EMAIL
      - SMS
    templates:
      order-created: "您的訂單 {orderId} 已成立"
      order-shipped: "您的訂單 {orderId} 已出貨"
```

```java
package com.example.shop.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;
import java.util.List;
import java.util.Map;

@ConfigurationProperties(prefix = "shop.notification")
public class NotificationProperties {

    /** 是否啟用通知功能。 */
    private boolean enabled = true;

    /** 寄件者地址。 */
    private String emailFrom;

    /** 失敗重試次數。 */
    private int retryCount = 3;

    /** 單次呼叫逾時。 */
    private Duration timeout = Duration.ofSeconds(5);

    /** 啟用的通知管道。 */
    private List<Channel> channels = List.of(Channel.EMAIL);

    /** 訊息樣板，key 是事件代碼。 */
    private Map<String, String> templates = Map.of();

    public enum Channel { EMAIL, SMS, LINE, IN_APP }

    // getter / setter（省略以節省篇幅，實際要全部寫）
    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public String getEmailFrom() { return emailFrom; }
    public void setEmailFrom(String emailFrom) { this.emailFrom = emailFrom; }
    public int getRetryCount() { return retryCount; }
    public void setRetryCount(int retryCount) { this.retryCount = retryCount; }
    public Duration getTimeout() { return timeout; }
    public void setTimeout(Duration timeout) { this.timeout = timeout; }
    public List<Channel> getChannels() { return channels; }
    public void setChannels(List<Channel> channels) { this.channels = channels; }
    public Map<String, String> getTemplates() { return templates; }
    public void setTemplates(Map<String, String> templates) { this.templates = templates; }
}
```

### 三種註冊方式

```java
// 方式 A：@EnableConfigurationProperties（推薦，明確）
@Configuration
@EnableConfigurationProperties(NotificationProperties.class)
public class NotificationConfig { }

// 方式 B：@ConfigurationPropertiesScan（掃描整個套件）
@SpringBootApplication
@ConfigurationPropertiesScan("com.example.shop.config")
public class ShopServiceApplication { }

// 方式 C：直接加 @Component（不推薦，混淆職責）
@Component
@ConfigurationProperties(prefix = "shop.notification")
public class NotificationProperties { }
```

> **建議用方式 A 或 B**。方式 A 更明確（一眼看出這個模組用到哪些設定），
> 方式 B 在設定類別很多時比較省事。**寫 starter 時一定要用方式 A**——
> 因為使用者的 `@ComponentScan` 掃不到你的套件。

### 使用

```java
package com.example.shop.notification;

import com.example.shop.config.NotificationProperties;
import org.springframework.stereotype.Service;

@Service
public class NotificationService {

    private final NotificationProperties properties;    // 整組設定當一個物件注入

    public NotificationService(NotificationProperties properties) {
        this.properties = properties;
    }

    public void notifyOrderCreated(String to, long orderId) {
        if (!properties.isEnabled()) {
            return;
        }
        String template = properties.getTemplates()
                .getOrDefault("order-created", "訂單 {orderId} 已成立");
        String message = template.replace("{orderId}", String.valueOf(orderId));

        for (NotificationProperties.Channel channel : properties.getChannels()) {
            // ... 依管道發送 ...
        }
    }
}
```

### 建構子綁定：用 `record` 做不可變設定

**這是 Spring Boot 3 最推薦的寫法。**

```java
package com.example.shop.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;
import java.util.List;
import java.util.Map;

@ConfigurationProperties(prefix = "shop.notification")
public record NotificationProperties(
        boolean enabled,
        String emailFrom,
        int retryCount,
        Duration timeout,
        List<Channel> channels,
        Map<String, String> templates) {

    public enum Channel { EMAIL, SMS, LINE, IN_APP }

    /** 緊湊建構子：套用預設值與驗證 */
    public NotificationProperties {
        retryCount = retryCount == 0 ? 3 : retryCount;
        timeout = timeout == null ? Duration.ofSeconds(5) : timeout;
        channels = channels == null || channels.isEmpty() ? List.of(Channel.EMAIL) : List.copyOf(channels);
        templates = templates == null ? Map.of() : Map.copyOf(templates);

        if (retryCount < 0 || retryCount > 10) {
            throw new IllegalArgumentException("retryCount 必須在 0～10 之間，目前是 " + retryCount);
        }
    }
}
```

**`record` 版本的三個好處：**

1. **不可變**——沒有 setter，執行期不可能被改掉。
2. **程式碼少一半**——不用寫 getter / setter。
3. **緊湊建構子可以做預設值與驗證**——而且**在啟動時就執行**。

> **Spring Boot 3 的規則**：`@ConfigurationProperties` 類別如果**只有一個帶參數的建構子**，
> 就自動使用建構子綁定，不需要 `@ConstructorBinding`。
> 只有在「有多個建構子」時，才需要在指定的那個建構子上加 `@ConstructorBinding`。
>
> ⚠️ Boot 2.x 的寫法是把 `@ConstructorBinding` 加在**類別**上，Boot 3 改成加在**建構子**上。
> 這是遷移時的編譯錯誤來源（第 09 章）。

**注意**：用建構子綁定時，**getter/setter 版本的預設值寫法就失效了**：

```java
// ❌ 建構子綁定時，這種欄位初始值不會生效
@ConfigurationProperties(prefix = "shop")
public class ShopProperties {
    private int retryCount = 3;      // 建構子綁定時這行沒用
    public ShopProperties(int retryCount) { this.retryCount = retryCount; }
}

// ✅ 用 @DefaultValue
@ConfigurationProperties(prefix = "shop")
public record ShopProperties(
        @DefaultValue("3") int retryCount,
        @DefaultValue("5s") Duration timeout,
        @DefaultValue("EMAIL") List<Channel> channels) { }
```

### 巢狀設定

```yaml
shop:
  limits:
    order:
      max-amount: 1000000
      max-items: 99
    upload:
      max-file-size: 10MB
      allowed-types:
        - image/jpeg
        - image/png
```

```java
package com.example.shop.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;

import java.math.BigDecimal;
import java.util.List;

@ConfigurationProperties(prefix = "shop.limits")
public record LimitProperties(
        @DefaultValue Order order,          // @DefaultValue 沒給值 = 用預設建構的巢狀物件
        @DefaultValue Upload upload) {

    public record Order(
            @DefaultValue("1000000") BigDecimal maxAmount,
            @DefaultValue("99") int maxItems) { }

    public record Upload(
            @DefaultValue("10MB") DataSize maxFileSize,
            @DefaultValue({"image/jpeg", "image/png"}) List<String> allowedTypes) { }
}
```

> **`@DefaultValue` 加在巢狀物件上很重要**：如果 yml 裡完全沒有 `shop.limits.upload` 這一段，
> 沒有 `@DefaultValue` 的話 `upload` 會是 `null`，用的時候就 NPE。

### 加上驗證：讓錯誤的設定在啟動時就爆

```java
package com.example.shop.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;
import java.util.List;

@Validated                                          // ★ 這行才會啟動驗證 ★
@ConfigurationProperties(prefix = "shop.notification")
public record NotificationProperties(

        @DefaultValue("true") boolean enabled,

        @NotBlank(message = "shop.notification.email-from 不可為空")
        @Email(message = "shop.notification.email-from 必須是合法的 email")
        String emailFrom,

        @Min(value = 0, message = "重試次數不可為負")
        @Max(value = 10, message = "重試次數不可超過 10")
        @DefaultValue("3") int retryCount,

        @DefaultValue("5s") Duration timeout,

        @NotEmpty(message = "至少要啟用一個通知管道")
        @DefaultValue("EMAIL") List<Channel> channels,

        @Valid                                      // ★ 巢狀物件要加 @Valid 才會遞迴驗證 ★
        @DefaultValue Smtp smtp) {

    public enum Channel { EMAIL, SMS, LINE, IN_APP }

    public record Smtp(
            @NotBlank @DefaultValue("localhost") String host,
            @Min(1) @Max(65535) @DefaultValue("25") int port) { }
}
```

需要 validation 依賴：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-validation</artifactId>
</dependency>
```

**設定錯誤時的啟動失敗訊息**：

```
***************************
APPLICATION FAILED TO START
***************************

Description:

Binding to target com.example.shop.config.NotificationProperties failed:

    Property: shop.notification.emailFrom
    Value: "not-an-email"
    Origin: class path resource [application.yml] - 12:17
    Reason: shop.notification.email-from 必須是合法的 email

    Property: shop.notification.retryCount
    Value: "99"
    Origin: class path resource [application.yml] - 14:18
    Reason: 重試次數不可超過 10

Action:

Update your application's configuration
```

> **注意 `Origin` 那一行**：它精確指出「`application.yml` 第 12 行第 17 個字元」。
> 這是 Spring Boot 的 Origin 追蹤功能，多環境設定疊了五層時**極度有用**——
> 你可以立刻知道這個值到底是從哪個檔案來的。

**這個機制的價值**：設定錯誤在 **CI 的啟動測試** 就會被抓到，不會帶到正式環境。
`@SpringBootTest` 的 `contextLoads()` 測試（第 00 章提過的那個空方法）
之所以不能刪，這是原因之一。

---

## 3.7 Relaxed Binding：命名規則

Spring Boot 綁定屬性時**非常寬容**。以下寫法**全部**會綁到 `emailFrom` 這個欄位：

```yaml
shop:
  notification:
    email-from: a@b.com      # kebab-case  ★ 建議用這個
    emailFrom: a@b.com       # camelCase
    email_from: a@b.com      # snake_case
    EMAIL_FROM: a@b.com      # 大寫底線
```

環境變數：

```bash
SHOP_NOTIFICATION_EMAILFROM=a@b.com     # ✅
SHOP_NOTIFICATION_EMAIL_FROM=a@b.com    # ✅
```

### 官方建議：yml 裡一律用 kebab-case

```yaml
# ✅ 推薦
shop:
  notification:
    email-from: noreply@shop.com
    retry-count: 3
    max-file-size: 10MB
```

理由：

1. YAML 社群慣例。
2. `spring-configuration-metadata.json` 用的就是這個格式。
3. **和環境變數的對應關係最直觀**。

### 例外：Map 的 key **不做** relaxed binding

```yaml
shop:
  templates:
    order-created: "訂單已成立"          # key 就是 "order-created"
    orderShipped: "訂單已出貨"           # key 就是 "orderShipped"
```

```java
properties.getTemplates().get("order-created");   // ✅
properties.getTemplates().get("orderCreated");    // ❌ null！
```

**Map 的 key 原樣保留**，因為 key 是資料不是屬性名稱。這一點常被誤解。

---

## 3.8 型別轉換

### 內建支援的特殊型別

```yaml
shop:
  # Duration —— 支援單位後綴
  short-timeout: 500ms
  timeout: 5s
  session-timeout: 30m
  token-ttl: 24h
  cleanup-interval: 7d
  plain-number: 5000          # 沒單位時，預設是毫秒（可用 @DurationUnit 改）

  # DataSize
  max-file-size: 10MB
  buffer-size: 512KB
  max-heap: 2GB

  # 列舉（大小寫不敏感，連字號也可以）
  level: high                 # → Level.HIGH
  mode: read-only             # → Mode.READ_ONLY

  # List / Set
  channels: EMAIL,SMS,LINE    # 逗號分隔也可以
  ports: [8080, 8081, 8082]

  # Map
  headers:
    X-Trace-Id: abc
    X-Source: shop
```

```java
package com.example.shop.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.boot.convert.DurationUnit;
import org.springframework.util.unit.DataSize;

import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

@ConfigurationProperties(prefix = "shop")
public record ShopProperties(
        @DefaultValue("500ms") Duration shortTimeout,
        @DefaultValue("5s") Duration timeout,

        /** 沒有單位時視為「秒」而不是毫秒 */
        @DurationUnit(ChronoUnit.SECONDS)
        @DefaultValue("30") Duration sessionTimeout,

        @DefaultValue("10MB") DataSize maxFileSize,
        @DefaultValue("HIGH") Level level,
        @DefaultValue List<String> channels,
        @DefaultValue Map<String, String> headers) {

    public enum Level { LOW, MEDIUM, HIGH }
}
```

> **不要用 `int` 存時間**。`private int timeoutSeconds = 5;` 這種寫法，
> 三個月後沒人記得單位是秒還是毫秒。**用 `Duration`，讓單位寫在設定檔裡。**

### 自訂型別轉換

需求：設定裡直接寫貨幣金額 `"TWD 1280.00"`，綁定成一個 `Money` 物件。

```java
package com.example.shop.domain;

import java.math.BigDecimal;
import java.util.Currency;

public record Money(Currency currency, BigDecimal amount) {

    public static Money parse(String text) {
        String[] parts = text.trim().split("\\s+");
        if (parts.length != 2) {
            throw new IllegalArgumentException(
                    "金額格式應為 '<幣別> <數字>'，例如 'TWD 1280.00'，收到：" + text);
        }
        return new Money(Currency.getInstance(parts[0]), new BigDecimal(parts[1]));
    }

    @Override
    public String toString() {
        return currency.getCurrencyCode() + " " + amount.toPlainString();
    }
}
```

```java
package com.example.shop.config;

import com.example.shop.domain.Money;
import org.springframework.boot.context.properties.ConfigurationPropertiesBinding;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

@Component
@ConfigurationPropertiesBinding          // ★ 這個註解才會讓 Converter 用於設定綁定 ★
public class StringToMoneyConverter implements Converter<String, Money> {

    @Override
    public Money convert(String source) {
        return Money.parse(source);
    }
}
```

```yaml
shop:
  limits:
    max-order-amount: "TWD 1000000.00"
    min-free-shipping: "TWD 990.00"
```

```java
@ConfigurationProperties(prefix = "shop.limits")
public record LimitProperties(Money maxOrderAmount, Money minFreeShipping) { }
```

> **`@ConfigurationPropertiesBinding` 不能省**。
> 沒加的話，這個 Converter 只會用在 Spring MVC 的參數綁定，不會用在設定綁定。
> 這是很常見的「明明寫了 Converter 卻沒生效」原因。

---

## 3.9 Profile：多環境的核心機制

### 啟用 Profile 的五種方式

```bash
# ① 命令列（優先序最高，臨時測試用）
java -jar shop.jar --spring.profiles.active=prod

# ② 環境變數（★ 容器部署的標準做法 ★）
SPRING_PROFILES_ACTIVE=prod java -jar shop.jar

# ③ 系統屬性
java -Dspring.profiles.active=prod -jar shop.jar

# ④ application.yml（只適合設定「預設值」）
```

```yaml
spring:
  profiles:
    active: dev              # 通常只在本機開發時這樣寫
```

```java
// ⑤ 程式碼（測試才用）
SpringApplication app = new SpringApplication(ShopServiceApplication.class);
app.setAdditionalProfiles("prod");
app.run(args);
```

### 多個 Profile

```bash
java -jar shop.jar --spring.profiles.active=prod,asia,mysql
```

**後面的蓋前面的**。所以 `application-mysql.yml` 會蓋過 `application-prod.yml`。

### 檔案拆分方式

```
src/main/resources/
├── application.yml              共用設定（所有環境都適用）
├── application-local.yml        本機（連本機 Docker）
├── application-dev.yml          開發環境
├── application-test.yml         自動化測試
├── application-staging.yml      預備環境（設定盡量接近 prod）
└── application-prod.yml         正式環境
```

### 單檔多文件：`---` 分隔

也可以把所有環境寫在同一個檔案：

```yaml
# application.yml
spring:
  application:
    name: shop-service

server:
  port: 8080

---
spring:
  config:
    activate:
      on-profile: dev            # ★ Boot 2.4+ 的寫法 ★
  datasource:
    url: jdbc:mysql://dev-db:3306/shop
logging:
  level:
    com.example.shop: DEBUG

---
spring:
  config:
    activate:
      on-profile: prod
  datasource:
    url: jdbc:mysql://prod-db:3306/shop
logging:
  level:
    com.example.shop: INFO
```

> ⚠️ **Boot 2.4 的重大變更**：
> ```yaml
> # ❌ Boot 2.3 以前的寫法，Boot 2.4+ 已不支援
> spring:
>   profiles: dev
>
> # ✅ Boot 2.4+ 的寫法
> spring:
>   config:
>     activate:
>       on-profile: dev
> ```
> 這是升版時的靜默失敗來源——**舊語法不會報錯，只是不生效**。

**建議：用獨立檔案，不要用單檔多文件。** 理由：

- 檔案短，一眼看完。
- Git diff 清楚（只改 prod 就只有 `application-prod.yml` 變動）。
- 權限可以分開管（`application-prod.yml` 可以不進 Git）。

### Profile Group：一次啟用一組

```yaml
spring:
  profiles:
    group:
      prod:
        - prod-db
        - prod-cache
        - prod-mq
        - metrics
      local:
        - local-db
        - mock-payment
```

```bash
java -jar shop.jar --spring.profiles.active=prod
# 實際啟用：prod, prod-db, prod-cache, prod-mq, metrics
```

**適用場景**：設定檔按「基礎設施」拆分，而不是按「環境」拆分。

### `@Profile` 標註 Bean

```java
package com.example.shop.payment;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

@Configuration
public class PaymentConfig {

    @Bean
    @Profile("prod")
    public PaymentGateway stripeGateway(PaymentProperties props) {
        return new StripeGateway(props.apiKey(), props.timeout());
    }

    @Bean
    @Profile({"dev", "local", "test"})               // 多個 profile
    public PaymentGateway fakeGateway() {
        return new FakePaymentGateway();
    }

    @Bean
    @Profile("!prod")                                // 非 prod
    public DataResetService dataResetService() {     // 提供「清空測試資料」的端點
        return new DataResetService();
    }

    @Bean
    @Profile("prod & metrics")                       // 表達式：且
    public DetailedMetricsExporter metricsExporter() {
        return new DetailedMetricsExporter();
    }
}
```

支援的表達式：`!prod`、`prod | staging`、`prod & metrics`、`(dev | test) & !ci`。

### `@Profile` 在整個類別上

```java
@Configuration
@Profile("prod")
public class ProductionSecurityConfig {
    // 整個類別只在 prod 生效
}
```

### 檢查目前的 profile

```java
package com.example.shop.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.util.Arrays;

@Component
public class ProfileReporter {

    private static final Logger log = LoggerFactory.getLogger(ProfileReporter.class);

    private final Environment env;

    public ProfileReporter(Environment env) {
        this.env = env;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void report() {
        String[] active = env.getActiveProfiles();
        log.info("啟用的 Profile：{}", active.length == 0 ? "(無，使用 default)" : Arrays.toString(active));
        log.info("資料庫：{}", env.getProperty("spring.datasource.url", "(未設定)"));
        log.info("日誌等級 com.example.shop：{}",
                env.getProperty("logging.level.com.example.shop", "(繼承 root)"));
    }
}
```

---

## 3.10 實務案例：四環境的設定拆法

這是我在實際專案裡用的結構。**核心原則：`application.yml` 只放「所有環境都一樣」的東西。**

### `application.yml`（共用）

```yaml
spring:
  application:
    name: shop-service
  jackson:
    default-property-inclusion: non_null
    serialization:
      write-dates-as-timestamps: false
    time-zone: Asia/Taipei
  mvc:
    problemdetails:
      enabled: true
  threads:
    virtual:
      enabled: true                      # 【Boot 3.2+】虛擬執行緒，需 JDK 21

server:
  port: 8080
  shutdown: graceful                     # 優雅關閉（第 08 章）
  compression:
    enabled: true
    mime-types: application/json,text/html
  error:
    include-message: never               # ★ 不要把例外訊息回給前端 ★
    include-stacktrace: never
    include-binding-errors: never

management:
  endpoints:
    web:
      exposure:
        include: health,info             # 預設最小集合，各環境再加
  endpoint:
    health:
      probes:
        enabled: true                    # 提供 /health/liveness 與 /health/readiness

# 業務設定的預設值
shop:
  limits:
    order:
      max-amount: 1000000
      max-items: 99
  notification:
    enabled: true
    retry-count: 3
    timeout: 5s
```

### `application-local.yml`（本機開發）

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&serverTimezone=Asia/Taipei
    username: root
    password: root                       # 本機用 Docker 起的，密碼寫死沒關係
  jpa:
    hibernate:
      ddl-auto: update                   # 本機才可以用 update
    show-sql: true
    properties:
      hibernate:
        format_sql: true
  main:
    lazy-initialization: true            # 本機加速啟動（第 01 章 1.15）

logging:
  level:
    com.example.shop: DEBUG
    org.springframework.web: DEBUG
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE   # 看到 SQL 的實際參數值

management:
  endpoints:
    web:
      exposure:
        include: "*"                     # 本機全開，方便學習與除錯
  endpoint:
    health:
      show-details: always

shop:
  payment:
    mode: FAKE                           # 假金流
  notification:
    channels: [LOG]                      # 不真的寄信
```

### `application-dev.yml` / `application-staging.yml`

```yaml
# application-dev.yml
spring:
  datasource:
    url: ${DB_URL:jdbc:mysql://dev-mysql:3306/shop}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}             # ★ 從環境變數來，不寫在檔案裡 ★
    hikari:
      maximum-pool-size: 10
  jpa:
    hibernate:
      ddl-auto: validate                 # ★ dev 之後一律 validate，schema 由 Flyway 管 ★

logging:
  level:
    com.example.shop: DEBUG

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,env,configprops,loggers

shop:
  payment:
    mode: SANDBOX
```

```yaml
# application-staging.yml —— 盡量與 prod 一致，只有連線目標不同
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: 20
  jpa:
    hibernate:
      ddl-auto: validate

logging:
  level:
    com.example.shop: INFO

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus

shop:
  payment:
    mode: SANDBOX
```

> **staging 的存在意義是「用 prod 的設定跑一次」**。
> 如果 staging 和 prod 的設定差很多，那 staging 就沒有驗證價值。
> **兩者的差異應該只有：連線目標、外部服務的 sandbox/live、資源大小。**

### `application-prod.yml`

```yaml
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: ${DB_POOL_SIZE:20}
      minimum-idle: 5
      connection-timeout: 3000
      max-lifetime: 1800000              # 要小於資料庫的 wait_timeout
      leak-detection-threshold: 60000    # 連線借出超過 60 秒就記錄警告
  jpa:
    hibernate:
      ddl-auto: validate
    show-sql: false                      # ★ 絕對不要在 prod 開 ★
    open-in-view: false                  # ★ 關掉，避免延遲載入拖住連線（第 08 站詳談）★

logging:
  level:
    root: WARN
    com.example.shop: INFO

management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus  # ★ 最小集合 ★
  endpoint:
    health:
      show-details: when-authorized      # 未認證只看到 UP/DOWN
  server:
    port: 8081                           # ★ 管理端點用獨立 port，不對外開放 ★

shop:
  payment:
    mode: LIVE
```

### 一張表看清楚差異

| 設定 | local | dev | staging | prod |
|---|---|---|---|---|
| 資料庫密碼 | 寫在檔案 | 環境變數 | 環境變數 | 環境變數 / Secret |
| `ddl-auto` | `update` | `validate` | `validate` | `validate` |
| `show-sql` | `true` | `false` | `false` | `false` |
| 日誌等級 | DEBUG | DEBUG | INFO | INFO（root WARN） |
| Actuator | `*` | 較多 | health/metrics | 最小集合 + 獨立 port |
| 金流 | FAKE | SANDBOX | SANDBOX | LIVE |
| 連線池 | 5 | 10 | 20 | 20（可調） |
| 延遲初始化 | ✅ | ❌ | ❌ | ❌ |

### 防禦：正式環境沒設 profile 就不准啟動

回應 3.4 那個「跑了三週開發設定」的案例：

```java
package com.example.shop.config;

import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.ConfigurableEnvironment;

/**
 * 啟動守衛：在環境準備完成的當下檢查 profile。
 *
 * <p>註冊方式（不能用 @Component —— 這個事件比 Bean 建立更早發生）：
 * <pre>
 * SpringApplication app = new SpringApplication(ShopServiceApplication.class);
 * app.addListeners(new ProfileGuard());
 * app.run(args);
 * </pre>
 */
public class ProfileGuard implements ApplicationListener<ApplicationEnvironmentPreparedEvent> {

    private static final java.util.Set<String> KNOWN_PROFILES =
            java.util.Set.of("local", "dev", "test", "staging", "prod");

    @Override
    public void onApplicationEvent(ApplicationEnvironmentPreparedEvent event) {
        ConfigurableEnvironment env = event.getEnvironment();
        String[] active = env.getActiveProfiles();

        if (active.length == 0) {
            throw new IllegalStateException("""

                    ================================================================
                    啟動失敗：沒有指定 spring.profiles.active

                    請用環境變數 SPRING_PROFILES_ACTIVE 指定執行環境，例如：
                        SPRING_PROFILES_ACTIVE=prod java -jar shop-service.jar

                    可用的 profile：local / dev / test / staging / prod

                    （這個檢查是刻意的：曾經發生過正式環境誤用預設設定的事故）
                    ================================================================
                    """);
        }

        for (String profile : active) {
            if (!KNOWN_PROFILES.contains(profile)) {
                throw new IllegalStateException(
                        "未知的 profile：" + profile + "，可用的有：" + KNOWN_PROFILES
                        + "（是不是打錯字了？）");
            }
        }
    }
}
```

```java
package com.example.shop;

import com.example.shop.config.ProfileGuard;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShopServiceApplication {

    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(ShopServiceApplication.class);
        app.addListeners(new ProfileGuard());
        app.run(args);
    }
}
```

> **為什麼要用 `ApplicationEnvironmentPreparedEvent` 而不是 `@Component` + `ApplicationReadyEvent`？**
> 因為 `ApplicationReadyEvent` 發生時，Tomcat 已經在監聽 port，資料庫連線池已經連上了。
> 「用錯設定連上正式資料庫」這件事**已經發生了**。
>
> `ApplicationEnvironmentPreparedEvent` 在 `SpringApplication.run()` 的第 ③ 步發生（第 00 章 0.11），
> 那時候什麼 Bean 都還沒建立，是**最早能檢查設定的時機**。
>
> 代價是：這個 listener 不能是 Bean（那時候容器還沒建好），要手動 `addListeners()`
> 或寫進 `META-INF/spring.factories` 的 `org.springframework.context.ApplicationListener` 項。

---

## 3.11 外部化設定的四種手段

### 手段 1：環境變數（容器部署首選）

```dockerfile
FROM eclipse-temurin:21-jre
COPY target/shop-service.jar /app.jar
ENTRYPOINT ["java","-jar","/app.jar"]
```

```yaml
# docker-compose.yml
services:
  shop-service:
    image: shop-service:1.0.0
    environment:
      SPRING_PROFILES_ACTIVE: prod
      DB_URL: jdbc:mysql://mysql:3306/shop?useSSL=false&serverTimezone=Asia/Taipei
      DB_USERNAME: shop_app
      DB_PASSWORD: ${DB_PASSWORD}          # 從 .env 或 CI secret 來
      SERVER_PORT: 8080
    ports:
      - "8080:8080"
```

**優點**：12-Factor 標準做法，所有平台都支援，不會進版控。
**缺點**：`ps aux` / `docker inspect` 看得到，不適合最高機密。

### 手段 2：外部設定檔

```bash
/opt/shop-service/
├── shop-service.jar
└── config/
    ├── application.yml           # 非敏感設定
    └── application-prod.yml

$ java -jar shop-service.jar --spring.profiles.active=prod
# 自動讀取 ./config/ 底下的檔案
```

配合檔案權限：

```bash
chmod 600 config/application-prod.yml
chown shopapp:shopapp config/application-prod.yml
```

### 手段 3：`spring.config.import`（Boot 2.4+）

```yaml
# application.yml
spring:
  config:
    import:
      - optional:file:/etc/shop/secrets.yml        # optional: 檔案不存在也不報錯
      - optional:configtree:/run/secrets/          # ★ Docker / K8s secret ★
      - optional:classpath:defaults.yml
```

**`configtree:` 特別實用**——它把「一個目錄下的檔案」當成屬性讀入：

```
/run/secrets/
├── spring.datasource.password        內容：s3cr3t
└── shop.payment.api-key              內容：sk_live_xxx
```

自動變成：

```
spring.datasource.password = s3cr3t
shop.payment.api-key       = sk_live_xxx
```

這正好對應 **Docker Secret 與 Kubernetes Secret 掛載成檔案**的方式：

```yaml
# k8s deployment
spec:
  containers:
    - name: shop-service
      env:
        - name: SPRING_PROFILES_ACTIVE
          value: prod
      volumeMounts:
        - name: shop-secrets
          mountPath: /run/secrets
          readOnly: true
  volumes:
    - name: shop-secrets
      secret:
        secretName: shop-service-secrets
```

> **這是目前 K8s 環境下最乾淨的密鑰方案**：
> 密鑰不進映像、不進環境變數（不會被 `ps` 看到）、不進版控，
> 而且 Spring Boot 原生支援，不需要額外的函式庫。

### 手段 4：Spring Cloud Config（集中式設定中心）

```yaml
spring:
  config:
    import: "optional:configserver:http://config-server:8888"
```

**適合**：十幾個微服務、設定需要集中管理與版控、需要動態刷新。
**不適合**：單體服務、小團隊——多一個要維護的服務，而且它掛了所有服務都起不來。

> **判斷準則**：服務數量少於 5 個，用環境變數 + configtree 就夠了。

---

## 3.12 密鑰管理：絕對不能做的事，與四種方案

### 絕對不能做

```yaml
# ❌❌❌ 這份檔案進了 Git，就等於金鑰公開
spring:
  datasource:
    password: Pr0d_P@ssw0rd_2026
shop:
  payment:
    api-key: sk_live_51H8xK2LmN9pQrS7tU3vW
```

### 第一道防線：`.gitignore`

```gitignore
# 敏感設定檔一律不進版控
application-prod.yml
application-secret.yml
application-local.yml
*.local.yml
.env
*.pem
*.key
*.p12
*.jks
```

同時提供範本讓新人知道要設什麼：

```yaml
# application-prod.yml.example  ← 這個要 commit
spring:
  datasource:
    url: jdbc:mysql://<HOST>:3306/shop
    username: <USERNAME>
    password: <PASSWORD>          # 請向 SRE 索取，不要寫進這個檔案
shop:
  payment:
    api-key: <STRIPE_LIVE_KEY>
```

### 第二道防線：pre-commit hook

```bash
# .git/hooks/pre-commit（或用 gitleaks / detect-secrets 工具）
#!/bin/sh
if git diff --cached --name-only | grep -qE 'application-(prod|secret)\.ya?ml$'; then
    echo "❌ 偵測到敏感設定檔，已阻止 commit"
    exit 1
fi

if git diff --cached | grep -qE '(sk_live_|AKIA[0-9A-Z]{16}|-----BEGIN.*PRIVATE KEY-----)'; then
    echo "❌ 偵測到疑似金鑰內容，已阻止 commit"
    exit 1
fi
```

> **推薦用現成工具**：`gitleaks`、`detect-secrets`、`talisman`。
> 它們有維護中的規則庫，比自己寫正規表示式可靠。CI 也應該跑一次。

### 四種方案的取捨

| 方案 | 安全性 | 複雜度 | 適用 |
|---|---|---|---|
| **環境變數** | 中 | 低 | 中小型專案、Docker Compose |
| **檔案 + configtree** | 中高 | 低 | K8s（Secret 掛載）**★ 推薦 ★** |
| **Vault / AWS Secrets Manager** | 高 | 中高 | 有合規要求、需要金鑰輪替 |
| **Jasypt 加密設定檔** | 低～中 | 中 | 傳統機房部署，沒有 secret 管理基礎設施 |

#### 關於 Jasypt 的重要提醒

```yaml
spring:
  datasource:
    password: ENC(gLq3XvB2mK9pQrS7tU3vWxYz1aB2cD3e)
```

```bash
java -jar shop.jar --jasypt.encryptor.password=主密碼
```

> ⚠️ **Jasypt 只是把問題往上推一層**：現在你要保護的是「主密碼」。
> 而且主密碼常常又被寫在啟動腳本裡（然後那個腳本進了 Git）。
>
> **它唯一的真實價值**：讓設定檔在**靜態情況下**不可讀（例如備份檔外流、有人 `cat` 到）。
> **它不能取代真正的 secret 管理。**
>
> 如果你的平台有 K8s Secret 或雲端 secret manager，**直接用那個，不要用 Jasypt**。

#### Vault 整合（示意）

```yaml
spring:
  config:
    import: "vault://secret/shop-service"
  cloud:
    vault:
      uri: https://vault.example.com
      authentication: KUBERNETES
      kubernetes:
        role: shop-service
```

**價值**：金鑰可輪替、有存取稽核、可設定 TTL、應用程式不需要知道密碼。
**代價**：要維護 Vault 叢集、要處理 Vault 不可用時的降級。

### 檢查清單：上線前的設定安全

```
□ application-prod.yml 不在 Git 裡（git log --all -- application-prod.yml 應該是空的）
□ 所有密碼、API key 都來自環境變數或 secret 掛載
□ Git 歷史裡沒有殘留的金鑰（用 gitleaks detect --log-opts="--all" 掃過）
□ 曾經外洩過的金鑰已在服務商後台作廢並重新產生
□ Actuator 的 /env、/configprops 沒有對外開放
□ 日誌裡不會印出設定物件（toString() 要遮蔽敏感欄位）
□ 錯誤回應不含 stack trace（server.error.include-stacktrace=never）
```

### 別忘了：`toString()` 也會洩漏

```java
@ConfigurationProperties(prefix = "shop.payment")
public record PaymentProperties(String apiKey, String webhookSecret, Duration timeout) {

    @Override
    public String toString() {                    // ★ 覆寫掉自動產生的 toString ★
        return "PaymentProperties[apiKey=****, webhookSecret=****, timeout=" + timeout + "]";
    }
}
```

> **真實案例**：某服務在啟動時 `log.info("設定：{}", paymentProperties)`，
> record 的自動 `toString()` 把 Stripe live key 完整印進日誌。
> 那份日誌被送到集中式日誌平台，全公司三十幾個人都看得到。
>
> 這件事的可怕之處在於：**程式碼審查時看不出問題**——`log.info("設定：{}", props)` 看起來完全無害。

---

## 3.13 用 Actuator 檢視設定

### `/actuator/env`：所有屬性來源

```bash
$ curl -s localhost:8080/actuator/env | jq '.propertySources[].name'
"server.ports"
"servletContextInitParams"
"systemProperties"
"systemEnvironment"
"random"
"Config resource 'class path resource [application-prod.yml]' via location 'optional:classpath:/'"
"Config resource 'class path resource [application.yml]' via location 'optional:classpath:/'"

# 查單一屬性「從哪裡來、被誰蓋掉」★ 除錯神器 ★
$ curl -s localhost:8080/actuator/env/server.port | jq
{
  "property": { "source": "systemEnvironment", "value": "9090" },
  "activeProfiles": ["prod"],
  "propertySources": [
    { "name": "systemProperties" },
    { "name": "systemEnvironment", "property": { "value": "9090", "origin": "System Environment Property \"SERVER_PORT\"" } },
    { "name": "Config resource 'class path resource [application.yml]'",
      "property": { "value": "8080", "origin": "class path resource [application.yml] - 5:9" } }
  ]
}
```

**這個輸出直接告訴你**：`server.port` 最終是 9090，來自環境變數，
而 `application.yml` 第 5 行的 8080 被蓋掉了。

> **「為什麼我改了設定沒生效」的標準排查方式就是這個端點。**

### `/actuator/configprops`：所有 `@ConfigurationProperties`

```bash
$ curl -s localhost:8080/actuator/configprops \
  | jq '.contexts.application.beans | to_entries[] | select(.key | test("shop"))'
{
  "key": "shop.notification-com.example.shop.config.NotificationProperties",
  "value": {
    "prefix": "shop.notification",
    "properties": {
      "enabled": true,
      "emailFrom": "noreply@shop.example.com",
      "retryCount": 3,
      "timeout": "PT5S",
      "channels": ["EMAIL", "SMS"]
    }
  }
}
```

### 敏感值的遮蔽

Spring Boot 預設會遮蔽符合下列模式的屬性名稱：
`password`、`secret`、`key`、`token`、`credentials`、`vcap_services`、`sun.java.command`。

```bash
$ curl -s localhost:8080/actuator/env/spring.datasource.password | jq '.property.value'
"******"
```

自訂遮蔽規則：

```yaml
management:
  endpoint:
    env:
      show-values: when-authorized      # never / always / when-authorized
    configprops:
      show-values: when-authorized
```

> ⚠️ **但不要依賴遮蔽。** 名稱叫 `shop.payment.merchant-id` 或 `shop.smtp.user` 的東西
> **不會**被遮蔽，但它們一樣是敏感資訊。
>
> **正式環境的正確做法：`/env` 與 `/configprops` 根本不要對外開放。**
>
> ```yaml
> management:
>   endpoints:
>     web:
>       exposure:
>         include: health,info,prometheus     # 白名單，不含 env / configprops
>   server:
>     port: 8081                              # 管理端點獨立 port，防火牆只開內網
> ```
>
> 第 05 章會完整處理 Actuator 的安全設定。

---

## 3.14 設定的動態重新載入

**先說結論：大部分專案不需要這個功能。**

### 為什麼通常不需要

在容器化的世界裡，改設定的標準流程是：

```
改 ConfigMap / Secret → 重新部署（rolling update）→ 新 Pod 用新設定
```

這比「動態重新載入」更**可預測**：你確切知道每個 Pod 用的是哪一版設定，
而不是「有些 Pod 已經刷新、有些還沒」。

### 真的需要時：`@RefreshScope`

需要 `spring-cloud-context`：

```java
@RefreshScope                     // 呼叫 /actuator/refresh 後，這個 Bean 會被重建
@Service
public class FeatureToggleService {

    @Value("${shop.features.new-checkout:false}")
    private boolean newCheckoutEnabled;
}
```

```bash
curl -X POST localhost:8080/actuator/refresh
```

**限制與陷阱**：

- 只有 `@RefreshScope` 的 Bean 會重建。
- 重建時該 Bean 的**狀態會丟失**。
- 已經注入到別處的舊參考**不會更新**（除非那裡也是 `@RefreshScope`）。
- `DataSource` 這種東西重建很危險（現有連線怎麼辦）。

### 更好的替代方案：功能開關做成「資料」而不是「設定」

```java
package com.example.shop.feature;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 功能開關存在資料庫，帶 30 秒快取。
 *
 * <p>比 @RefreshScope 好的地方：
 * 不需要重建 Bean、所有實例會在快取過期後自然一致、可以做百分比灰度。
 */
@Service
public class FeatureToggleService {

    private static final Duration TTL = Duration.ofSeconds(30);

    private final JdbcTemplate jdbcTemplate;
    private final Map<String, CachedValue> cache = new ConcurrentHashMap<>();

    public FeatureToggleService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public boolean isEnabled(String feature) {
        CachedValue cached = cache.get(feature);
        if (cached != null && cached.isFresh()) {
            return cached.value();
        }
        Boolean value = jdbcTemplate.queryForObject(
                "SELECT enabled FROM feature_toggle WHERE name = ?", Boolean.class, feature);
        boolean result = Boolean.TRUE.equals(value);
        cache.put(feature, new CachedValue(result, Instant.now()));
        return result;
    }

    private record CachedValue(boolean value, Instant loadedAt) {
        boolean isFresh() { return Instant.now().isBefore(loadedAt.plus(TTL)); }
    }
}
```

> **判斷準則**：
> - **會頻繁調整、需要即時生效** → 做成資料（資料庫 / Redis / 專門的 feature flag 服務）。
> - **每次部署才改一次** → 做成設定（`application.yml` + 環境變數）。

---

## 3.15 實戰：把訂單服務設定分環境化

延續第 01 章的 `shop-service`。

### 設定類別

```java
package com.example.shop.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Positive;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;

@Validated
@ConfigurationProperties(prefix = "shop")
public record ShopProperties(

        @Valid @DefaultValue Limits limits,
        @Valid @DefaultValue Notification notification,
        @Valid @DefaultValue Payment payment) {

    // ───────────── 業務上限 ─────────────
    public record Limits(
            @Positive @DefaultValue("1000000") BigDecimal maxOrderAmount,
            @Min(1) @Max(999) @DefaultValue("99") int maxItemsPerOrder,
            @DefaultValue("30d") Duration orderRetention) { }

    // ───────────── 通知 ─────────────
    public record Notification(
            @DefaultValue("true") boolean enabled,

            @NotBlank @Email
            @DefaultValue("noreply@shop.example.com") String emailFrom,

            @NotEmpty @DefaultValue("EMAIL") List<Channel> channels,

            @Min(0) @Max(10) @DefaultValue("3") int retryCount,
            @DefaultValue("5s") Duration timeout) {

        public enum Channel { EMAIL, SMS, LINE, LOG }
    }

    // ───────────── 金流 ─────────────
    public record Payment(
            @DefaultValue("FAKE") Mode mode,
            String apiKey,
            @DefaultValue("10s") Duration timeout,
            @DefaultValue("https://api.payment.example.com") String endpoint) {

        public enum Mode {
            /** 一律成功，不呼叫外部服務 */ FAKE,
            /** 呼叫供應商測試環境 */      SANDBOX,
            /** 呼叫供應商正式環境 */      LIVE
        }

        /** 覆寫 toString 避免 apiKey 被印進日誌 */
        @Override
        public String toString() {
            return "Payment[mode=%s, apiKey=%s, timeout=%s, endpoint=%s]"
                    .formatted(mode, apiKey == null ? "null" : "****", timeout, endpoint);
        }

        /** LIVE 模式一定要有 apiKey —— 在啟動時就檢查 */
        public Payment {
            if (mode == Mode.LIVE && (apiKey == null || apiKey.isBlank())) {
                throw new IllegalStateException(
                        "shop.payment.mode=LIVE 時必須提供 shop.payment.api-key"
                        + "（請設定環境變數 SHOP_PAYMENT_APIKEY）");
            }
        }
    }
}
```

> **`Payment` 的緊湊建構子那段檢查非常值得學**：
> 「LIVE 模式沒有 API key」這種設定錯誤，如果不在啟動時檢查，
> 就會變成「服務正常啟動，但第一筆真實訂單付款時才 500」。
>
> **把「設定之間的相依關係」寫成啟動時的檢查**，是設定設計的高階技巧。

### 註冊與使用

```java
package com.example.shop;

import com.example.shop.config.ProfileGuard;
import com.example.shop.config.ShopProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(ShopProperties.class)
public class ShopServiceApplication {

    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(ShopServiceApplication.class);
        app.addListeners(new ProfileGuard());
        app.run(args);
    }
}
```

```java
package com.example.shop.payment;

import com.example.shop.config.ShopProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

@Configuration
public class PaymentGatewayConfig {

    /**
     * 依 shop.payment.mode 決定要建立哪一種實作。
     *
     * <p>比起用三個 @Profile 的 @Bean，這種寫法的好處是：
     * 「模式」與「環境」解耦 —— 你可以在 staging 環境臨時切成 FAKE 做壓測。
     */
    @Bean
    public PaymentGateway paymentGateway(ShopProperties props, RestClient.Builder builder) {
        ShopProperties.Payment payment = props.payment();

        return switch (payment.mode()) {
            case FAKE -> new FakePaymentGateway();
            case SANDBOX, LIVE -> new HttpPaymentGateway(
                    builder.baseUrl(payment.endpoint()).build(),
                    payment.apiKey(),
                    payment.timeout());
        };
    }
}
```

### 對應的設定檔

```yaml
# application.yml —— 共用預設
spring:
  application:
    name: shop-service

server:
  port: 8080
  shutdown: graceful
  error:
    include-message: never
    include-stacktrace: never

management:
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      probes:
        enabled: true

shop:
  limits:
    max-order-amount: 1000000
    max-items-per-order: 99
    order-retention: 30d
  notification:
    enabled: true
    email-from: noreply@shop.example.com
    retry-count: 3
    timeout: 5s
```

```yaml
# application-local.yml
logging:
  level:
    com.example.shop: DEBUG

management:
  endpoints:
    web:
      exposure:
        include: "*"
  endpoint:
    health:
      show-details: always

shop:
  notification:
    channels: [LOG]
  payment:
    mode: FAKE
```

```yaml
# application-prod.yml
logging:
  level:
    root: WARN
    com.example.shop: INFO

management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  server:
    port: 8081

shop:
  notification:
    channels: [EMAIL, SMS]
  payment:
    mode: LIVE
    api-key: ${SHOP_PAYMENT_API_KEY}      # ★ 必須由環境提供，沒有就啟動失敗 ★
    endpoint: https://api.payment.example.com
```

### 設定的測試

```java
package com.example.shop.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.math.BigDecimal;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

class ShopPropertiesTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(TestConfig.class);

    @EnableConfigurationProperties(ShopProperties.class)
    static class TestConfig { }

    @Test
    void 什麼都不設時應套用預設值() {
        runner.run(context -> {
            ShopProperties props = context.getBean(ShopProperties.class);
            assertThat(props.limits().maxOrderAmount()).isEqualByComparingTo(new BigDecimal("1000000"));
            assertThat(props.limits().maxItemsPerOrder()).isEqualTo(99);
            assertThat(props.notification().timeout()).isEqualTo(Duration.ofSeconds(5));
            assertThat(props.payment().mode()).isEqualTo(ShopProperties.Payment.Mode.FAKE);
        });
    }

    @Test
    void 應正確解析Duration與DataSize() {
        runner.withPropertyValues(
                      "shop.limits.order-retention=90d",
                      "shop.notification.timeout=250ms")
              .run(context -> {
                  ShopProperties props = context.getBean(ShopProperties.class);
                  assertThat(props.limits().orderRetention()).isEqualTo(Duration.ofDays(90));
                  assertThat(props.notification().timeout()).isEqualTo(Duration.ofMillis(250));
              });
    }

    @Test
    void email格式錯誤時應啟動失敗() {
        runner.withPropertyValues("shop.notification.email-from=not-an-email")
              .run(context -> {
                  assertThat(context).hasFailed();
                  // ★ 注意兩件事：
                  //   ① 要用 hasStackTraceContaining，不是 hasMessageContaining
                  //      （最外層例外只說「Could not bind properties to 'ShopProperties'」，
                  //        欄位名在巢狀的 BindValidationException 裡）
                  //   ② 字串是 camelCase 的 emailFrom，不是設定檔裡的 email-from
                  assertThat(context).getFailure()
                          .hasStackTraceContaining("emailFrom");
              });
    }

    @Test
    void 重試次數超過上限時應啟動失敗() {
        runner.withPropertyValues("shop.notification.retry-count=99")
              .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void LIVE模式沒有apiKey時應啟動失敗() {
        runner.withPropertyValues("shop.payment.mode=LIVE")
              .run(context -> {
                  assertThat(context).hasFailed();
                  assertThat(context).getFailure()
                          .hasStackTraceContaining("必須提供 shop.payment.api-key");
              });
    }

    @Test
    void LIVE模式有apiKey時應正常啟動() {
        runner.withPropertyValues(
                      "shop.payment.mode=LIVE",
                      "shop.payment.api-key=sk_test_dummy")
              .run(context -> {
                  assertThat(context).hasNotFailed();
                  assertThat(context.getBean(ShopProperties.class).payment().mode())
                          .isEqualTo(ShopProperties.Payment.Mode.LIVE);
              });
    }

    @Test
    void toString不應洩漏apiKey() {
        runner.withPropertyValues(
                      "shop.payment.mode=LIVE",
                      "shop.payment.api-key=sk_live_SUPER_SECRET")
              .run(context -> {
                  String text = context.getBean(ShopProperties.class).payment().toString();
                  assertThat(text).doesNotContain("sk_live_SUPER_SECRET");
                  assertThat(text).contains("****");
              });
    }
}
```

> **最後那個測試特別值得寫**——它把「不要洩漏金鑰」這個口頭約定變成**自動化檢查**。
> 有人不小心把 `toString()` 改回自動產生的版本時，CI 會紅。

---

## 3.16 常見錯誤

### ① `Could not resolve placeholder 'xxx'`

```
Caused by: java.lang.IllegalArgumentException:
Could not resolve placeholder 'shop.notification.email-from' in value "${shop.notification.email-from}"
```

原因：屬性不存在，而且 `@Value` 沒給預設值。

```java
@Value("${shop.notification.email-from:noreply@example.com}")   // 給預設值
// 或改用 @ConfigurationProperties（有 @DefaultValue 機制，還有驗證）
```

### ② 設定改了沒生效

排查順序：

```bash
# 1. 確認最終值與來源
curl -s localhost:8080/actuator/env/shop.notification.retry-count | jq

# 2. 確認 profile 有沒有啟用
curl -s localhost:8080/actuator/env | jq '.activeProfiles'

# 3. 確認檔案有沒有被打包進 jar
unzip -l target/shop-service.jar | grep application

# 4. 確認執行目錄有沒有殘留的 application.yml（會蓋過 jar 內的！）
ls -la ./application.yml ./config/
```

### ③ 屬性名稱拼錯，靜靜失效

```yaml
shop:
  notifcation:              # ⚠️ 少了一個 i
    enabled: false
```

**`@ConfigurationProperties` 對「多餘的屬性」預設是忽略的**——不會報錯。

開啟嚴格檢查：

```java
@ConfigurationProperties(prefix = "shop", ignoreUnknownFields = false)
```

> ⚠️ **但這個開關要小心**：它會讓「同一個 prefix 底下的任何未知屬性」都失敗，
> 包括別的模組刻意放在那裡的東西。實務上更好的防線是：
> 1. 用 `spring-boot-configuration-processor` 產生 metadata → IDE 會標紅拼錯的屬性。
> 2. 用 `@Validated` + `@NotBlank` → 少了必填屬性時啟動就失敗。

### ④ YAML 縮排錯誤導致設定被吃掉

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop
  jpa:
      hibernate:
        ddl-auto: validate        # ⚠️ 縮排多了兩格，但 YAML 仍然合法
```

上面這段其實是合法的 YAML（只要同層一致），所以**不會報錯**。
但如果縮排錯到跑去別的層級，設定就綁到錯的地方了。

**檢查方式**：`curl -s localhost:8080/actuator/configprops` 看實際綁定的結果。

### ⑤ 環境變數名稱錯

```bash
SPRING_PROFILE_ACTIVE=prod        # ❌ 少了 S
SPRING_PROFILES_ACTIVE=prod       # ✅

SPRING.PROFILES.ACTIVE=prod       # ❌ 環境變數不能有點
```

**防禦**：用 3.10 的 `ProfileGuard`。

### ⑥ Map 的 key 用了 relaxed binding

```yaml
shop:
  templates:
    orderCreated: "..."
```

```java
props.getTemplates().get("order-created");   // ❌ null，key 是 "orderCreated"
```

**規則：Map 的 key 原樣保留，自己統一格式。**

### ⑦ `@ConfigurationProperties` 沒有註冊

```java
@ConfigurationProperties(prefix = "shop")
public record ShopProperties(...) { }
// 忘了 @EnableConfigurationProperties 或 @ConfigurationPropertiesScan
```

症狀：`No qualifying bean of type 'ShopProperties'`。

### ⑧ 建構子綁定時用了欄位初始值

```java
@ConfigurationProperties(prefix = "shop")
public class ShopProperties {
    private int retryCount = 3;                   // ❌ 建構子綁定時無效
    public ShopProperties(int retryCount) { this.retryCount = retryCount; }
}
```

**建構子綁定要用 `@DefaultValue`。**

---

## 3.17 本章練習

### 練習 1：優先順序判斷

給定：

```yaml
# jar 內 application.yml
server:
  port: 8080
shop:
  timeout: 5s
```

```yaml
# jar 內 application-prod.yml
server:
  port: 8081
shop:
  timeout: 10s
```

```yaml
# 執行目錄下 ./config/application.yml
shop:
  timeout: 20s
```

啟動指令：

```bash
SHOP_TIMEOUT=30s java -Dserver.port=8082 -jar shop.jar \
    --spring.profiles.active=prod --shop.timeout=40s
```

最終的 `server.port` 與 `shop.timeout` 各是多少？

<details>
<summary>參考解答</summary>

**`server.port` = 8082**（系統屬性 `-D`）
**`shop.timeout` = 40s**（命令列參數 `--`）

**完整推導（由高到低，第一個有值的獲勝）：**

`server.port`：

| 優先序 | 來源 | 值 |
|---|---|---|
| ④ 命令列 | — | 沒設 |
| **⑧ 系統屬性 `-Dserver.port`** | **8082** | **← 獲勝** |
| ⑨ 環境變數 | — | 沒設 |
| ⑪ jar 外 `application-prod.yml` | — | 檔案不存在 |
| ⑬ jar 外 `./config/application.yml` | — | 沒設 port |
| ⑫ jar 內 `application-prod.yml` | 8081 | 被蓋 |
| ⑭ jar 內 `application.yml` | 8080 | 被蓋 |

`shop.timeout`：

| 優先序 | 來源 | 值 |
|---|---|---|
| **④ 命令列 `--shop.timeout=40s`** | **40s** | **← 獲勝** |
| ⑧ 系統屬性 | — | 沒設 |
| ⑨ 環境變數 `SHOP_TIMEOUT=30s` | 30s | 被蓋 |
| ⑬ jar 外 `./config/application.yml` | 20s | 被蓋 |
| ⑫ jar 內 `application-prod.yml` | 10s | 被蓋 |
| ⑭ jar 內 `application.yml` | 5s | 被蓋 |

**額外提醒**：`./config/application.yml`（20s）**會蓋過 jar 內的 `application-prod.yml`**（10s）。
這是最容易搞錯的一格——很多人以為 profile 檔案一定最優先。

**驗證方法**：

```bash
curl -s localhost:8082/actuator/env/shop.timeout | jq
```

</details>

### 練習 2：找出 YAML 陷阱

以下設定有五個問題，找出來。

```yaml
shop:
  version: 2.10
  countries: [TW, JP, NO]
  password: @Secret123
  api-key: sk_live_abc123
  timeout: 30
  smtp:
	host: smtp.example.com
  banner: 這是第一行
    這是第二行
```

<details>
<summary>參考解答</summary>

| # | 問題 | 後果 | 修正 |
|---|---|---|---|
| 1 | `version: 2.10` | 被推斷成 Double `2.1`，尾端的 0 消失 | `version: "2.10"` |
| 2 | `NO` 在陣列裡 | YAML 1.1 把 `NO` 當成 boolean false，挪威變成 `"false"` | `countries: ["TW", "JP", "NO"]` |
| 3 | `password: @Secret123` | `@` 是 YAML 保留字元，解析錯誤 | `password: '@Secret123'` |
| 4 | `api-key: sk_live_abc123` | **金鑰硬寫在設定檔裡**，會進版控 | `api-key: ${SHOP_API_KEY}` |
| 5 | `smtp:` 底下用了 Tab 縮排 | YAML 解析錯誤：`found character '\t' that cannot start any token` | 改用空白 |
| 6 | `timeout: 30` | 單位不明——是 30 毫秒還是 30 秒？綁到 `Duration` 時預設是**毫秒** | `timeout: 30s` |
| 7 | `banner` 多行沒有用區塊語法 | 解析錯誤或只取到第一行 | 用 `banner: \|` |

（題目說五個，實際有七個——設定檔的坑就是這麼密集。）

**修正版：**

```yaml
shop:
  version: "2.10"
  countries: ["TW", "JP", "NO"]
  password: '@Secret123'
  api-key: ${SHOP_API_KEY}            # 從環境變數來
  timeout: 30s
  smtp:
    host: smtp.example.com            # 空白縮排
  banner: |
    這是第一行
    這是第二行
```

</details>

### 練習 3：設計設定類別

需求：訂單服務要呼叫三個外部 API（金流、物流、發票）。每個都有：
端點、API key、逾時、重試次數、是否啟用。
要求：型別安全、有驗證、金鑰不進版控、`toString()` 不洩漏、能在啟動時抓出錯誤設定。

<details>
<summary>參考解答</summary>

```java
package com.example.shop.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

@Validated
@ConfigurationProperties(prefix = "shop.external")
public record ExternalApiProperties(

        @Valid @DefaultValue ApiConfig payment,
        @Valid @DefaultValue ApiConfig shipping,
        @Valid @DefaultValue ApiConfig invoice) {

    /** 三個 API 共用同一種設定結構，避免重複三次 */
    public record ApiConfig(

            @DefaultValue("true") boolean enabled,

            @NotBlank(message = "端點不可為空")
            @Pattern(regexp = "^https?://.+", message = "端點必須是 http(s) URL")
            @DefaultValue("http://localhost:9999") String endpoint,

            String apiKey,

            @DefaultValue("5s") Duration timeout,

            @Min(0) @Max(5) @DefaultValue("2") int retryCount) {

        public ApiConfig {
            // 啟用時一定要有金鑰 —— 在啟動時就檢查，不要等到第一次呼叫才 401
            if (enabled && (apiKey == null || apiKey.isBlank())) {
                throw new IllegalStateException(
                        "已啟用但缺少 api-key（endpoint=" + endpoint + "）。"
                        + "請設定對應的環境變數，或把 enabled 設為 false。");
            }
            // 逾時 × 重試次數不該超過 30 秒，否則會拖住整個請求執行緒
            if (timeout != null && timeout.multipliedBy(retryCount + 1L).getSeconds() > 30) {
                throw new IllegalStateException(
                        "timeout(%s) × (retry-count(%d)+1) 超過 30 秒，會拖垮執行緒池"
                                .formatted(timeout, retryCount));
            }
        }

        @Override
        public String toString() {
            return "ApiConfig[enabled=%s, endpoint=%s, apiKey=%s, timeout=%s, retryCount=%d]"
                    .formatted(enabled, endpoint,
                            apiKey == null ? "null" : "****", timeout, retryCount);
        }
    }

    /** 給啟動日誌用的摘要（不含敏感值） */
    public Map<String, String> summary() {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("payment", payment.toString());
        map.put("shipping", shipping.toString());
        map.put("invoice", invoice.toString());
        return map;
    }
}
```

```yaml
# application.yml（共用預設，不含金鑰）
shop:
  external:
    payment:
      endpoint: https://api.payment.example.com
      timeout: 10s
      retry-count: 2
    shipping:
      endpoint: https://api.shipping.example.com
      timeout: 5s
      retry-count: 3
    invoice:
      endpoint: https://api.invoice.example.com
      timeout: 5s
      retry-count: 1
```

```yaml
# application-local.yml —— 本機不呼叫外部服務
shop:
  external:
    payment:
      enabled: false
    shipping:
      enabled: false
    invoice:
      enabled: false
```

```yaml
# application-prod.yml —— 金鑰從環境變數來
shop:
  external:
    payment:
      api-key: ${PAYMENT_API_KEY}
    shipping:
      api-key: ${SHIPPING_API_KEY}
    invoice:
      api-key: ${INVOICE_API_KEY}
```

**四個設計重點：**

1. **共用 `ApiConfig` record**——三個 API 結構一樣，不要複製三份欄位。
   之後要加「熔斷閾值」時只改一個地方。
2. **緊湊建構子做跨欄位驗證**——`@NotBlank` 只能驗單一欄位，
   「啟用時才需要金鑰」「逾時×重試不能太久」這種規則要自己寫。
3. **`toString()` 遮蔽金鑰**——並且應該為此寫一個測試（見 3.15 最後那個測試）。
4. **`local` 環境直接 `enabled: false`**——本機開發不該依賴外部服務可用性。

**額外加分：啟動時印出設定摘要**

```java
@Component
public class ExternalApiReporter {
    private static final Logger log = LoggerFactory.getLogger(ExternalApiReporter.class);
    private final ExternalApiProperties props;

    public ExternalApiReporter(ExternalApiProperties props) { this.props = props; }

    @EventListener(ApplicationReadyEvent.class)
    public void report() {
        log.info("外部 API 設定：");
        props.summary().forEach((name, config) -> log.info("  {} = {}", name, config));
    }
}
```

上線後從日誌就能確認「這個環境到底連到哪裡、有沒有啟用」，
比登入機器 `cat` 設定檔快多了。

</details>

### 練習 4：診斷設定問題

正式環境的服務出現這些症狀，各自最可能的原因是什麼？怎麼確認？

1. 日誌檔一天長到 40 GB。
2. API 回傳的錯誤訊息裡包含完整的 SQL 語句與資料表名稱。
3. 服務連到的是 dev 資料庫。
4. `/actuator/heapdump` 可以從外網下載。
5. 改了 ConfigMap 並重啟 Pod，但設定沒有生效。

<details>
<summary>參考解答</summary>

**1. 日誌一天 40 GB**

最可能：`logging.level` 是 DEBUG，或 `spring.jpa.show-sql=true`。

```bash
curl -s localhost:8081/actuator/loggers/com.example.shop | jq
curl -s localhost:8081/actuator/env/spring.jpa.show-sql | jq
```

修正：`application-prod.yml` 設 `root: WARN`、`com.example.shop: INFO`、`show-sql: false`。

> 補充：Actuator 的 `/loggers` 端點可以**即時**調整等級（POST），
> 這是線上緊急降噪的手段——但正式環境要用認證保護它。

**2. 錯誤訊息含 SQL**

原因：`server.error.include-message` / `include-stacktrace` 沒有關掉，
或是全域例外處理直接把 `e.getMessage()` 回給前端。

```yaml
server:
  error:
    include-message: never
    include-stacktrace: never
    include-binding-errors: never
```

> **這是資訊洩漏漏洞**：資料表名稱、欄位名稱是 SQL Injection 的偵察素材。
> 04-controller 第 03 章會做「對外回錯誤碼、對內記完整堆疊」的正確版本。

**3. 連到 dev 資料庫**

依序確認：

```bash
# ① profile 有沒有啟用
curl -s localhost:8081/actuator/env | jq '.activeProfiles'
# 若是 [] → 環境變數 SPRING_PROFILES_ACTIVE 沒生效（拼字？大小寫？）

# ② 最終的 url 從哪來
curl -s localhost:8081/actuator/env/spring.datasource.url | jq

# ③ 容器裡有沒有殘留的 application.yml 蓋過設定
kubectl exec -it <pod> -- ls -la /app /app/config
```

最常見原因：環境變數名稱拼錯（`SPRING_PROFILE_ACTIVE`），或映像裡有一份
`/app/application.yml` 蓋過了 jar 內的 profile 設定。

**防禦**：3.10 的 `ProfileGuard`。

**4. `/actuator/heapdump` 可從外網下載**

原因：`management.endpoints.web.exposure.include: "*"` 而且管理端點跟業務 API 同一個 port。

**嚴重性極高**——heap dump 裡有記憶體中的**所有東西**：資料庫密碼、
session token、使用者個資、剛處理過的信用卡號。

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus   # 白名單
  server:
    port: 8081                            # 獨立 port
```

再加上：Ingress / 防火牆只對外開 8080，8081 只允許內網與監控系統。

**5. 改 ConfigMap 重啟後沒生效**

四種可能：

- **ConfigMap 掛載成檔案，但路徑不在 Spring 的搜尋範圍**
  → 用 `spring.config.additional-location` 明確指定。
- **有更高優先序的來源蓋過它**——例如 deployment 裡的 `env` 直接設了同一個屬性
  （環境變數 ⑨ 贏過外部設定檔 ⑪⑬）。
  ```bash
  curl -s localhost:8081/actuator/env/該屬性 | jq
  ```
- **Pod 沒有真的重啟**——`kubectl apply` 改 ConfigMap 不會自動重啟 Pod。
  ```bash
  kubectl rollout restart deployment/shop-service
  ```
- **映像裡有一份同名檔案**，而它的位置優先序更高。

**通用排查心法**：不要猜，直接問 `/actuator/env/<屬性名>`——
它會告訴你最終值、來源、以及被蓋掉的所有候選值。

</details>

### 練習 5：設定安全稽核

你接手一個專案，`application.yml` 長這樣。列出所有問題並給出修正方案。

```yaml
spring:
  profiles:
    active: prod
  datasource:
    url: jdbc:mysql://10.0.1.55:3306/shop
    username: root
    password: Pr0dP@ss2026
  jpa:
    hibernate:
      ddl-auto: update
    show-sql: true

server:
  port: 8080
  error:
    include-stacktrace: always

management:
  endpoints:
    web:
      exposure:
        include: "*"
  endpoint:
    health:
      show-details: always

logging:
  level:
    root: DEBUG

shop:
  payment:
    api-key: sk_live_51H8xK2LmN9pQrS7tU3vW
```

<details>
<summary>參考解答</summary>

**九個問題，依嚴重程度排序：**

| # | 問題 | 嚴重性 | 後果 |
|---|---|---|---|
| 1 | `api-key: sk_live_...` 硬寫在檔案 | 🔴 極高 | 金鑰進版控，等同公開 |
| 2 | 資料庫密碼硬寫 | 🔴 極高 | 同上 |
| 3 | `ddl-auto: update` 在正式環境 | 🔴 極高 | Hibernate 會**自動改 schema**——欄位型別被改、索引被加、資料可能損毀 |
| 4 | `exposure.include: "*"` | 🔴 極高 | `/heapdump` 可下載整個記憶體、`/env` 可看所有設定 |
| 5 | 用 `root` 帳號連資料庫 | 🟠 高 | 一旦有 SQL Injection，攻擊者可以 `DROP DATABASE` |
| 6 | `include-stacktrace: always` | 🟠 高 | 堆疊資訊洩漏內部結構與函式庫版本 |
| 7 | `spring.profiles.active: prod` 寫死在 `application.yml` | 🟠 高 | 任何環境跑起來都是 prod 設定，包括本機 |
| 8 | `root: DEBUG` | 🟡 中 | 日誌爆量、效能下降、可能記錄到敏感資料 |
| 9 | `show-sql: true` | 🟡 中 | 同上，且 SQL 可能含個資 |

**修正後的三個檔案：**

```yaml
# application.yml —— 共用，不含任何環境專屬或敏感值
spring:
  application:
    name: shop-service
  jpa:
    hibernate:
      ddl-auto: validate          # ★ 一律 validate，schema 由 Flyway 管（07-mysql 第 06 章）★
    show-sql: false
    open-in-view: false

server:
  port: 8080
  shutdown: graceful
  error:
    include-message: never
    include-stacktrace: never
    include-binding-errors: never

management:
  endpoints:
    web:
      exposure:
        include: health,info      # ★ 白名單，各環境再視需要放寬 ★
  endpoint:
    health:
      probes:
        enabled: true

logging:
  level:
    root: WARN
    com.example.shop: INFO
```

```yaml
# application-local.yml —— 本機才放寬
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop
    username: shop_dev
    password: dev                 # 本機 Docker，可接受
  jpa:
    hibernate:
      ddl-auto: update            # 本機才允許
    show-sql: true

logging:
  level:
    com.example.shop: DEBUG

management:
  endpoints:
    web:
      exposure:
        include: "*"
  endpoint:
    health:
      show-details: always
```

```yaml
# application-prod.yml
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}      # ★ 應用程式專用帳號，只有必要權限 ★
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: 20
      leak-detection-threshold: 60000

management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    health:
      show-details: when-authorized
  server:
    port: 8081                    # ★ 獨立 port，只開內網 ★

shop:
  payment:
    mode: LIVE
    api-key: ${SHOP_PAYMENT_API_KEY}
```

**額外的四件事（缺一不可）：**

1. **`.gitignore` 加上 `application-prod.yml`、`application-local.yml`。**
2. **把已外洩的金鑰全部作廢並重新產生**——Git 歷史裡的 `sk_live_...` 已經不安全了，
   改檔案沒有用。去 Stripe / 資料庫把它們換掉。
3. **清理 Git 歷史**：
   ```bash
   gitleaks detect --log-opts="--all"     # 先確認還有哪些
   git filter-repo --path application.yml --invert-paths   # 或用 BFG
   ```
   （這會改寫歷史，需要團隊協調並強制推送。）
4. **建立資料庫應用程式帳號**，只給必要權限：
   ```sql
   CREATE USER 'shop_app'@'%' IDENTIFIED BY '...';
   GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'shop_app'@'%';
   -- 刻意不給 DROP / ALTER / CREATE：schema 變更由 Flyway 用另一個帳號執行
   ```

**最後補一個 CI 檢查**，避免同樣的事再發生：

```yaml
# .github/workflows/security.yml
- name: 掃描密鑰
  run: |
    docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest \
      detect --source=/repo --log-opts="--all" --verbose
```

</details>

---

## 3.18 驗收清單

- [ ] 我能說出「什麼該外部化、什麼不該」的判斷準則。
- [ ] 我知道 YAML 的四類陷阱（Tab、型別推斷、特殊字元、多行字串），並知道字串值要加引號。
- [ ] 我知道 `NO`、`yes`、`1.20`、`08001` 這類值在 YAML 裡會被誤判成什麼。
- [ ] 我能背出核心的五層優先順序：命令列 > `-D` > 環境變數 > 外部檔案 > jar 內檔案。
- [ ] 我知道 **jar 外部的 `application.yml` 會贏過 jar 內部的 `application-prod.yml`**。
- [ ] 我知道 `./config/` 目錄會被自動搜尋，也知道它造成過什麼問題。
- [ ] 我能正確把屬性名稱轉成環境變數名稱（含連字號與陣列索引的處理）。
- [ ] 我知道 `@Value` 的五個限制，並且只在「一兩個獨立值」時使用它。
- [ ] 我能用 `record` + `@DefaultValue` 寫出不可變的設定類別。
- [ ] 我會用 `@Validated` + Bean Validation 讓錯誤設定在**啟動時**失敗。
- [ ] 我知道跨欄位的規則（如「LIVE 模式必須有 API key」）要寫在緊湊建構子裡。
- [ ] 我知道 relaxed binding 的規則，也知道 **Map 的 key 不套用 relaxed binding**。
- [ ] 我會用 `Duration` / `DataSize` 而不是 `int`，並知道 `@DurationUnit` 的用途。
- [ ] 我會寫 `Converter` + `@ConfigurationPropertiesBinding` 做自訂型別轉換。
- [ ] 我知道 Boot 2.4 之後多文件 YAML 要用 `spring.config.activate.on-profile`。
- [ ] 我能設計 local / dev / staging / prod 的設定拆法，並說出每個環境的差異。
- [ ] 我知道正式環境沒設 profile 是事故，也知道怎麼用 `ProfileGuard` 防禦。
- [ ] 我知道 `spring.config.import` 的 `configtree:` 是 K8s Secret 的最佳搭配。
- [ ] 我知道密碼絕不進版控，也知道「已外洩的金鑰必須作廢」而不是只改檔案。
- [ ] 我知道 Jasypt 只是把問題往上推一層，不是真正的 secret 管理。
- [ ] 我會覆寫設定物件的 `toString()` 遮蔽敏感值，並為此寫測試。
- [ ] 我會用 `/actuator/env/<屬性>` 診斷「設定為什麼沒生效」。
- [ ] 我知道正式環境不該開放 `/env`、`/configprops`、`/heapdump`，且管理端點應該用獨立 port。

---

完成後請前往 [04-aop-and-proxy-mechanism.md](./04-aop-and-proxy-mechanism.md)。
