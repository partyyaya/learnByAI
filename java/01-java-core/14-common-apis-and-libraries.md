# 第 14 章：常用標準 API 與工具庫——按用途選型與實作

> 日期怎麼轉時區、金額怎麼換算、國家清單哪裡來、Excel 怎麼產生？
> 本章整理一般 Java 後端經常遇到的工具，讓你可以按需求查找，並拿範例直接實驗。

前置：第 01、05、07、10、11 章；基準為 **Java 21、Maven 3.9**。
這是本篇最後一章，可依情境查閱，不必先記住每個套件名稱。

<a id="tool-index"></a>

## 工具索引：點擊名稱查看使用方法

先按用途找工具，**點擊工具名稱即可直接跳到範例**。
「JDK」不用額外套件；「第三方」的依賴版本統一列在 [14.3 練習專案](#tool-project)。
主表皆有本章可執行範例；替代工具的比較與其他章節入口另列在表格後。

| 類別 | 工具／API（點擊看用法） | 具體用途 | 類型 |
|---|---|---|---|
| 日期時間 | [java.time、DateTimeFormatter、Clock](#tool-java-time) | 計算帳單日、UTC 轉時區、嚴格解析日期、固定測試時間 | JDK |
| 金額計算 | [BigDecimal、RoundingMode](#tool-money) | 精確算錢、分／元轉換、拒絕偷偷截斷 | JDK |
| 幣別與顯示 | [Currency、NumberFormat](#tool-money) | 查幣別小數位、依語系顯示金額 | JDK |
| 匯率換算 | [BigDecimal + 報價快照](#tool-exchange) | 明確換匯方向、保留來源、拒絕過期報價 | JDK 組合範例 |
| 多幣別金額 | [JavaMoney／Moneta](#tool-moneta) | 金額攜帶幣別，避免 USD 與 TWD 直接相加 | 第三方 |
| 國家／地區 | [Locale](#tool-locale) | ISO 國家代碼驗證、國家選單、顯示語言與繁簡標籤 | JDK |
| 國際電話 | [libphonenumber](#tool-phone) | 按地區解析電話、驗證規則、轉 E.164 | 第三方 |
| 字串處理 | [String、Commons Lang](#tool-strings) | 空白整理、null-safe 字串預設值 | JDK／第三方 |
| 文字工具 | [Commons Text](#tool-strings) | 短字串距離、HTML 文字節點轉義 | 第三方 |
| Unicode／多語訊息 | [ICU4J](#tool-icu) | emoji 可見字元計數、字形正規化、英文複數訊息 | 第三方 |
| 集合 | [Guava](#tool-guava) | 一對多 Multimap、Multiset 計數、清單切批次 | 第三方 |
| 檔案 | [Path、Files](#tool-files) | UTF-8 暫存檔讀寫、限制讀入大小 | JDK |
| 串流／BOM | [Commons IO](#tool-files) | 移除 UTF-8 BOM，避免 CSV 第一個欄名異常 | 第三方 |
| JSON | [Jackson](#tool-jackson) | DTO 序列化、BigDecimal／Instant 往返 | 第三方 |
| CSV | [Commons CSV](#tool-csv) | 正確讀寫引號、逗號、換行與欄名 | 第三方 |
| Excel | [Apache POI](#tool-poi) | 輸出／讀回 .xlsx，保留長編號與金額文字 | 第三方 |
| PDF | [Apache PDFBox](#tool-pdfbox) | 產生簡單收據、開啟 PDF 並擷取文字 | 第三方 |
| HTML | [jsoup](#tool-jsoup) | 擷取頁面內容、清理有限富文字 | 第三方 |
| HTTP | [HttpClient](#tool-http) | 呼叫查詢 API、檢查狀態、限制回應大小 | JDK |
| 本機快取 | [Caffeine](#tool-caffeine) | 限容量快取、到期與載入、可控時間測試 | 第三方 |
| 欄位驗證 | [Jakarta Validation／Hibernate Validator](#tool-validation) | 驗證 DTO 的 email、國家代碼格式、金額範圍 | 規格／第三方實作 |
| 簡單設定 | [Properties](#tool-config) | 鍵值設定與預設值 | JDK |
| YAML | [SnakeYAML](#tool-config) | 讀取設定、限制解析資源、拒絕重複鍵與未知欄位 | 第三方 |
| 日誌 | [SLF4J](#tool-slf4j) | 參數化日誌、延遲建立 debug 訊息 | 第三方 |
| 有限重試 | [Resilience4j Retry](#tool-retry) | 分類暫時錯誤、控制嘗試次數與等待時間 | 第三方 |
| ID／編碼／摘要 | [UUID、Base64、MessageDigest、SecureRandom](#tool-encoding) | 隨機 ID、token、內容指紋；區分編碼與加密 | JDK |
| 物理單位 | [Units of Measurement／Indriya](#tool-indriya) | 公尺／公里等單位換算，避免混淆長度與重量 | 規格／第三方實作 |
| DTO 映射 | [JDK record 與明確轉換方法](#tool-mapping) | 只輸出允許公開的欄位，避免洩漏秘密欄位 | JDK |
| 跨工具整合 | [跨國訂單換匯預覽](#tool-composition) | 串接國家、電話、報價、金額與 JSON | 完整組合範例 |

延伸入口：[替代工具選型比較](#tool-more)（MapStruct、Lombok、Hutool、HTTP 替代品、排程等）、
[測試工具的完整教學](./11-testing-junit-mockito.md)、[執行本章所有範例](#tool-verification)。

## 14.1 學習目標與閱讀方式

- 分清 **JDK 標準 API**、**第三方函式庫**、**需要外部資料的服務**。
- 實作日期／時區、金額／幣別、國家／語系、電話、字串／集合、檔案／JSON／CSV／Excel／PDF。
- 使用 HTTP、快取、欄位驗證、設定、日誌、有限重試與編碼工具。
- 看懂每個範例的具體用途、輸入、輸出與適用邊界。

「常用」依一般後端開發範圍整理，並不表示 Java 生態每個套件都要安裝。
下方主選工具有完整範例；同用途替代品放在 14.25，比較角色即可。
框架、資料庫存取、Redis 與訊息佇列會在後續各篇深入。

每個 Java 區塊都是獨立檔案，包含 package、import、類別與 main；註釋先寫業務用途，再解釋關鍵操作。
14.3 提供共同練習專案；14.27 提供直接擷取本文的可重跑驗證。

## 14.2 選型原則

1. **JDK 先看、第三方按需加**：日期、基本字串、HTTP、Base64 等已有標準 API。
2. **同用途避免重複工具鏈**：JSON mapper、集合輔助、日誌 provider 要有團隊約定。
3. **工具與資料來源分開**：Currency 不提供市場匯率，電話號碼規則不證明本人身分。
4. **明確配置環境與規則**：時區、語系、編碼、精度、逾時、輸入大小都要依契約設定。

<a id="tool-project"></a>

## 14.3 建立可以直接跑的練習專案

以下版本是 **2026-11-13 查核並固定的練習組合**，不是永遠最新的保證。
版本查核使用各專案文件與 Maven Central 已發布 artifact；開發中的 SNAPSHOT／alpha／CR 不直接當練習基準。
Jackson 使用有維護的 2.21 系列，沿用前面章節的 com.fasterxml.jackson API；3.x 的 package 與配置須另外遷移。
[Jackson 官方版本說明](https://github.com/FasterXML/jackson/wiki/Jackson-Release-2.21)與
[Maven Central](https://repo.maven.apache.org/maven2/)可查核發布資料。

**本章另建 toolbox-lab，不改寫第 10～13 章的多模組 Todo 專案**。
前章的 Jackson／測試版本留在原專案；若要升級既有專案，須一起跑遷移測試。
進入 Spring Boot 專案後，優先使用該 Boot 版本的 BOM，不直接把本章所有版本貼進去。

```bash
mkdir -p toolbox-lab/src/main/java/com/example/toolbox
cd toolbox-lab
```

將下面內容存成 `pom.xml`。這份 POM 為了讓所有範例共用一個實驗環境而集中依賴；
正式專案只保留實際使用的模組。Moneta 的 JSR 354 API 是 javax.money，並非 jakarta.money。

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>toolbox-lab</artifactId>
  <version>1.0-SNAPSHOT</version>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.fasterxml.jackson</groupId>
        <artifactId>jackson-bom</artifactId>
        <version>2.21.8</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.22.0</version>
    </dependency>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-text</artifactId>
      <version>1.15.0</version>
    </dependency>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-csv</artifactId>
      <version>1.14.1</version>
    </dependency>
    <dependency>
      <groupId>commons-io</groupId>
      <artifactId>commons-io</artifactId>
      <version>2.22.0</version>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.8.0-jre</version>
    </dependency>
    <dependency>
      <groupId>com.ibm.icu</groupId>
      <artifactId>icu4j</artifactId>
      <version>79.1</version>
    </dependency>
    <dependency>
      <groupId>com.googlecode.libphonenumber</groupId>
      <artifactId>libphonenumber</artifactId>
      <version>9.0.43</version>
    </dependency>
    <dependency>
      <groupId>org.javamoney.moneta</groupId>
      <artifactId>moneta-core</artifactId>
      <version>1.4.5</version>
    </dependency>
    <dependency>
      <groupId>tech.units</groupId>
      <artifactId>indriya</artifactId>
      <version>2.2.4</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.datatype</groupId>
      <artifactId>jackson-datatype-jsr310</artifactId>
    </dependency>
    <dependency>
      <groupId>org.apache.poi</groupId>
      <artifactId>poi-ooxml</artifactId>
      <version>6.0.0</version>
    </dependency>
    <dependency>
      <groupId>org.apache.pdfbox</groupId>
      <artifactId>pdfbox</artifactId>
      <version>3.0.8</version>
    </dependency>
    <dependency>
      <groupId>org.jsoup</groupId>
      <artifactId>jsoup</artifactId>
      <version>1.24.1</version>
    </dependency>
    <dependency>
      <groupId>com.github.ben-manes.caffeine</groupId>
      <artifactId>caffeine</artifactId>
      <version>3.3.1</version>
    </dependency>
    <dependency>
      <groupId>org.hibernate.validator</groupId>
      <artifactId>hibernate-validator</artifactId>
      <version>9.1.6.Final</version>
    </dependency>
    <dependency>
      <groupId>org.glassfish.expressly</groupId>
      <artifactId>expressly</artifactId>
      <version>6.0.0</version>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>org.yaml</groupId>
      <artifactId>snakeyaml</artifactId>
      <version>2.7</version>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.20</version>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-simple</artifactId>
      <version>2.0.20</version>
      <scope>runtime</scope>
    </dependency>
    <!-- POI 使用 Log4j API；轉接到同一個 SLF4J provider，避免缺少 provider 的訊息。 -->
    <dependency>
      <groupId>org.apache.logging.log4j</groupId>
      <artifactId>log4j-to-slf4j</artifactId>
      <version>2.26.1</version>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>io.github.resilience4j</groupId>
      <artifactId>resilience4j-retry</artifactId>
      <version>2.4.0</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
      </plugin>
      <plugin>
        <groupId>org.codehaus.mojo</groupId>
        <artifactId>exec-maven-plugin</artifactId>
        <version>3.5.0</version>
      </plugin>
    </plugins>
  </build>
</project>
```

把要練習的 Java 區塊存到標示路徑，再執行：

```bash
mvn compile
mvn exec:java -Dexec.mainClass=com.example.toolbox.DateTimeExamples
# 換成其他範例的類別名稱即可；第一次會下載依賴。
```

需要一次驗證本文所有範例時，直接用 repo 內的 `verification/toolbox/run.py`（14.27）。

<a id="tool-java-time"></a>

## 14.4 日期與時間：java.time

**具體用途**：訂閱帳單的日期計算、事件 UTC 時刻轉顯示時區、驗證使用者輸入日期。
一般日期需求使用 JDK；原理與 DST 邊界詳見第 07 章。
[官方 API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/package-summary.html)。

**`src/main/java/com/example/toolbox/DateTimeExamples.java`**

```java
package com.example.toolbox;

import java.time.*;
import java.time.format.*;
import java.util.Locale;

public class DateTimeExamples {
    // 用途：拒絕不存在的日期；uuuu 搭配 STRICT，避免把 2/30 調整成月底。
    public static final DateTimeFormatter DATE = DateTimeFormatter
            .ofPattern("uuuu-MM-dd", Locale.ROOT)
            .withResolverStyle(ResolverStyle.STRICT);

    public static LocalDate nextBillDate(LocalDate current) {
        // 本例契約：每次從本次帳單日加一個月，目標月沒有該日便取月底。
        // 1/31 -> 2/28；再加一個月是 3/28，不是「永遠每月最後一天」。
        return current.plusMonths(1);
    }

    public static void main(String[] args) {
        LocalDate start = LocalDate.parse("2026-01-31", DATE);
        System.out.println(nextBillDate(start)); // 2026-02-28

        // 用途：資料庫／API 保存同一個事件時刻，畫面依使用者選擇的時區顯示。
        Clock clock = Clock.fixed(Instant.parse("2026-11-13T02:00:00Z"), ZoneOffset.UTC);
        Instant occurredAt = clock.instant(); // 測試可以固定時間，不依賴執行當下。
        ZonedDateTime taipei = occurredAt.atZone(ZoneId.of("Asia/Taipei"));
        System.out.println(taipei); // 2026-11-13T10:00+08:00[Asia/Taipei]
        System.out.println(Duration.between(occurredAt, occurredAt.plusSeconds(90)).toSeconds()); // 90
    }
}
```

[↑ 回到工具索引](#tool-index)

`LocalDate` 沒有時區，`LocalDateTime` 不是唯一瞬間；事件時間通常用 Instant。
營業日、國定假日、每月最後營業日需要另有業務日曆，不能只靠 plusDays／plusMonths 推論。
國家也不一定只有一個時區，不能把國家代碼直接換成固定 UTC offset。

## 14.5 金額、幣別、分／元與匯率

<a id="tool-money"></a>

### 14.5.1 BigDecimal + Currency：算錢與顯示分工

**具體用途**：把支付介面的「最小貨幣單位整數」轉成顯示金額，再精確轉回整數。
Currency 提供 ISO 4217 幣別資訊，沒有市場匯率。
[Currency 官方 API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Currency.html)。

**`src/main/java/com/example/toolbox/MoneyExamples.java`**

```java
package com.example.toolbox;

import java.math.*;
import java.text.NumberFormat;
import java.util.*;

public class MoneyExamples {
    private static int digits(Currency currency) {
        int n = currency.getDefaultFractionDigits();
        // 特殊用途代碼可能回 -1，本例不支援，不能猜成兩位小數。
        if (n < 0) throw new IllegalArgumentException("沒有一般最小單位：" + currency);
        return n;
    }

    public static BigDecimal fromMinor(long minor, Currency currency) {
        // 用途：USD 的 12345 cents -> 123.45；JPY 的 12345 -> 12345。
        return BigDecimal.valueOf(minor, digits(currency));
    }

    public static long toMinor(BigDecimal major, Currency currency) {
        // 用途：送入支付 API。若有超出幣別的小數或 long 溢位就報錯，不偷偷截斷。
        return major.setScale(digits(currency), RoundingMode.UNNECESSARY)
                .movePointRight(digits(currency)).longValueExact();
    }

    public static String display(BigDecimal amount, Currency currency, Locale locale) {
        // NumberFormat 是可變物件，本例每次建立；不要讓多執行緒共用同一實例。
        NumberFormat fmt = NumberFormat.getCurrencyInstance(locale);
        fmt.setCurrency(currency); // 幣別明確傳入，不能只依顯示語系猜貨幣。
        fmt.setMinimumFractionDigits(digits(currency));
        fmt.setMaximumFractionDigits(digits(currency));
        fmt.setRoundingMode(RoundingMode.HALF_UP); // 本例的「顯示」捨入規則。
        return fmt.format(amount);
    }

    public static void main(String[] args) {
        Currency usd = Currency.getInstance("USD");
        BigDecimal amount = fromMinor(12345, usd);
        System.out.println(amount); // 123.45
        System.out.println(toMinor(amount, usd)); // 12345
        System.out.println(display(amount, usd, Locale.US)); // $123.45
        System.out.println(fromMinor(12345, Currency.getInstance("JPY"))); // 12345
    }
}
```

[↑ 回到工具索引](#tool-index)

支付供應商可能對某些幣別有自己的小數位規則；串接時以該 API 契約為準，不能只靠 ISO 預設值。
計算精度、帳務捨入、畫面格式是三個決定；不要把畫面字串解析回帳務金額。

<a id="tool-exchange"></a>

### 14.5.2 換匯：一定要知道「哪個幣別換哪個幣別」

**具體用途**：根據已確認的 USD/TWD 報價預覽應付金額。
下例 rate 明確定義為「1 單位來源幣 = 幾單位目標幣」，並保存報價時間、到期時間與來源。
**32.50 是虛構測試匯率，不是即時報價或財務建議**；範例不連接真實金流。

**`src/main/java/com/example/toolbox/ExchangeExamples.java`**

```java
package com.example.toolbox;

import java.math.*;
import java.time.*;
import java.util.*;

public class ExchangeExamples {
    public record Quote(Currency from, Currency to, BigDecimal rate,
                        Instant asOf, Instant validUntil, String source) {
        public Quote {
            Objects.requireNonNull(from); Objects.requireNonNull(to); Objects.requireNonNull(rate);
            Objects.requireNonNull(asOf); Objects.requireNonNull(validUntil); Objects.requireNonNull(source);
            if (rate.signum() <= 0 || !validUntil.isAfter(asOf) || source.isBlank())
                throw new IllegalArgumentException("不合法的匯率快照");
        }
    }

    public static BigDecimal convert(BigDecimal amount, Currency sourceCurrency,
                                     Quote quote, Clock clock) {
        if (!sourceCurrency.equals(quote.from())) throw new IllegalArgumentException("來源幣別不符");
        Instant now = clock.instant();
        if (now.isBefore(quote.asOf()) || !now.isBefore(quote.validUntil()))
            throw new IllegalArgumentException("報價未生效或已到期");
        int scale = quote.to().getDefaultFractionDigits();
        if (scale < 0) throw new IllegalArgumentException("不支援此目標幣別");
        // 用途：按本例契約，在「換算完成」後一次捨入；手續費、價差與帳務政策須另建模。
        return amount.multiply(quote.rate()).setScale(scale, RoundingMode.HALF_UP);
    }

    public static void main(String[] args) {
        Instant now = Instant.parse("2026-11-13T02:00:00Z");
        Quote quote = new Quote(Currency.getInstance("USD"), Currency.getInstance("TWD"),
                new BigDecimal("32.50"), now, now.plusSeconds(60), "TEST_FIXTURE");
        System.out.println(convert(new BigDecimal("10.25"), Currency.getInstance("USD"),
                quote, Clock.fixed(now, ZoneOffset.UTC))); // 333.13，採本例 HALF_UP
    }
}
```

[↑ 回到工具索引](#tool-index)

<a id="tool-moneta"></a>

### 14.5.3 Moneta：把金額與幣別綁在一起

**具體用途**：多幣別帳務的型別表達，避免直接把 USD 金額加進 TWD。
JSR 354 是 API，Moneta 是實作；它不屬於 JDK。這裡只引入 moneta-core，
不會啟動線上匯率下載。[官方專案](https://github.com/JavaMoney/jsr354-ri)。

**`src/main/java/com/example/toolbox/MonetaExamples.java`**

```java
package com.example.toolbox;

import javax.money.*;
import org.javamoney.moneta.Money;

public class MonetaExamples {
    public static void main(String[] args) {
        // 用途：每個數值都帶幣別；跨幣別必須先取得明確的換匯結果。
        MonetaryAmount subtotal = Money.of(new java.math.BigDecimal("100.25"), "USD");
        MonetaryAmount shipping = Money.of(new java.math.BigDecimal("5.00"), "USD");
        MonetaryAmount total = subtotal.add(shipping);
        System.out.println(total.getCurrency().getCurrencyCode()); // USD
        System.out.println(total.getNumber().numberValueExact(java.math.BigDecimal.class)); // 105.25
        // subtotal.add(Money.of(5, "TWD")) 會拋 MonetaryException：不能混幣相加。
        // 要先計算再按契約捨入；有幣別不代表每次運算自動採你需要的帳務規則。
    }
}
```

[↑ 回到工具索引](#tool-index)

不要把 Moneta 的預設貨幣 rounding 當作所有公司的會計政策。
匯率 provider、可用幣別、歷史報價、價差、手續費與斷線處理，都要由實際服務契約決定。

<a id="tool-locale"></a>

## 14.6 國家／地區、語言與本地化：Locale、ResourceBundle

**具體用途**：註冊表單的國家選單、儲存 TW／JP 代碼、依使用者語言顯示名稱。
Locale 表示語言／地區偏好，不是國籍、居住地、幣別或法規資格的完整模型。
[JDK Locale 官方文件](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Locale.html)。

**`src/main/java/com/example/toolbox/CountryExamples.java`**

```java
package com.example.toolbox;

import java.util.*;

public class CountryExamples {
    private static final Set<String> ISO_REGIONS = Set.of(Locale.getISOCountries());
    public record Country(String code, String name) {}

    public static Locale region(String input) {
        // 用途：表單允許 tw／TW，但持久化前正規化成 ISO alpha-2。
        // 這是「國家代碼」的契約，不可拿相同流程處理密碼／不透明冪等鍵。
        String code = Objects.requireNonNull(input).strip().toUpperCase(Locale.ROOT);
        if (!ISO_REGIONS.contains(code)) throw new IllegalArgumentException("未知 ISO 地區代碼：" + code);
        return new Locale.Builder().setRegion(code).build();
    }

    public static List<Country> countries(Locale displayLanguage) {
        // 用途：後端回傳穩定代碼 + 本地化顯示名稱；名稱不可當資料庫主鍵。
        return ISO_REGIONS.stream().sorted()
                .map(code -> new Country(code, region(code).getDisplayCountry(displayLanguage)))
                .toList();
    }

    public static void main(String[] args) {
        Locale tw = region("tw");
        Locale language = Locale.forLanguageTag("zh-Hant-TW"); // 繁體中文顯示偏好。
        System.out.println(tw.getCountry()); // TW
        System.out.println(tw.getISO3Country()); // TWN
        System.out.println(tw.getDisplayCountry(language)); // 名稱依 JDK／CLDR 資料版本。
        System.out.println(language.getLanguage()); // zh
        System.out.println(language.getScript()); // Hant，不要只靠 zh 分辨繁簡。
        System.out.println(countries(Locale.ENGLISH).stream().filter(c -> c.code().equals("JP")).toList());
        // 本地化文字可放 messages_zh_TW.properties、messages_en_US.properties，交給 ResourceBundle。
    }
}
```

[↑ 回到工具索引](#tool-index)

這份清單是 JDK 提供的 ISO 國家／地區資料，**不等於你公司的可出貨地區**。
顯示名稱可能因 JDK／CLDR 版本而變；可銷售地區、郵遞區號、地址格式、制裁限制須由業務資料另外決定。
同一國可能有多個語言／時區，不同國也可能共用幣別。ISO 代碼、BCP 47 語言標籤、電話國碼不能混用。

如果需要 ISO numeric 代碼或現成 enum，可另外評估 nv-i18n；不能為了少幾行程式就把舊資料表當最新地緣資料。
本章可執行範例以 JDK + ICU4J 為主，不另引入第二套國家清單。

<a id="tool-phone"></a>

## 14.7 國際電話：libphonenumber

**具體用途**：會員輸入本地電話時，按明確地區解析並轉為 E.164 格式，方便去重與串接簡訊 API。
號碼規則資料會改，應定期更新函式庫。[Google 官方專案與範例](https://github.com/google/libphonenumber)。

**`src/main/java/com/example/toolbox/PhoneExamples.java`**

```java
package com.example.toolbox;

import com.google.i18n.phonenumbers.*;

public class PhoneExamples {
    public static String toE164(String input, String defaultRegion) throws NumberParseException {
        PhoneNumberUtil util = PhoneNumberUtil.getInstance();
        // 用途：沒有 + 國碼時，使用使用者明確選擇的地區解析，不用伺服器預設 Locale。
        var phone = util.parse(input, defaultRegion);
        if (!util.isValidNumber(phone)) throw new IllegalArgumentException("不符合號碼規則");
        if (phone.hasExtension()) throw new IllegalArgumentException("本例會員手機不接受分機");
        return util.format(phone, PhoneNumberUtil.PhoneNumberFormat.E164);
    }

    public static void main(String[] args) throws Exception {
        // 只做格式示範，不會撥號或發送簡訊。
        System.out.println(toE164("0912 345 678", "TW")); // +886912345678
    }
}
```

[↑ 回到工具索引](#tool-index)

isValidNumber 只表示符合函式庫目前的編碼規則，**不證明已配發、仍可用、或屬於本人**。
手機限定、可接收簡訊、國際號碼與所選地區須一致等需求要額外驗證；本人驗證須實際 OTP。
電話國碼可能由多個地區共用，不能拿 +1 直接推論唯一國家。

<a id="tool-strings"></a>

## 14.8 字串：JDK、Commons Lang、Commons Text

**具體用途**：整理搜尋字串、產生一般文字輸出、計算短字串差異。
簡單判斷先用 String.isBlank／strip；Commons Lang 補 null-aware 操作，Commons Text 處理文字演算法／轉義。
[Lang](https://commons.apache.org/proper/commons-lang/)、[Text](https://commons.apache.org/proper/commons-text/)。

**`src/main/java/com/example/toolbox/StringExamples.java`**

```java
package com.example.toolbox;

import org.apache.commons.lang3.StringUtils;
import org.apache.commons.text.StringEscapeUtils;
import org.apache.commons.text.similarity.LevenshteinDistance;

public class StringExamples {
    public static void main(String[] args) {
        // 用途：搜尋欄位允許 null；畫面上統一用預設提示，而不是到處寫三元判斷。
        String nickname = StringUtils.defaultIfBlank(null, "訪客");
        System.out.println(nickname); // 訪客
        System.out.println(StringUtils.normalizeSpace("  Java   backend  ")); // Java backend

        // 用途：短商品關鍵字的拼字建議，設定最多距離 2，超出回 -1。
        int distance = new LevenshteinDistance(2).apply("java", "jvaa");
        System.out.println(distance); // 2；長輸入另限長度，避免大量 CPU 工作。

        // 用途：把不可信文字放入「HTML 文字節點」；輸出會看到文字而非新標籤。
        System.out.println(StringEscapeUtils.escapeHtml4("<b>優惠</b>"));
        // 不同 context 要不同處理；這不是 JS、URL、CSS 的通用 escape，也不是保留富文字標籤的 sanitizer。
    }
}
```

[↑ 回到工具索引](#tool-index)

模板引擎／前端框架已有自動轉義時，不要重複 escape 導致 &amp;lt;。
清理 HTML 用 14.16；不要對不可信模板開啟任意變數／腳本／網路插值。
字串 trim／大小寫轉換是特定欄位的契約，不能擅自套用到密碼、簽章原文或外部交易 ID。

<a id="tool-icu"></a>

## 14.9 Unicode 與多語訊息：ICU4J

**具體用途**：可見字元數限制、搜尋用相容字形正規化、多語系複數訊息。
ICU4J 能獨立更新 Unicode／CLDR 資料；不是所有專案都需要它。
[官方使用文件](https://unicode-org.github.io/icu/userguide/icu4j/)。

**`src/main/java/com/example/toolbox/UnicodeExamples.java`**

```java
package com.example.toolbox;

import com.ibm.icu.text.*;
import com.ibm.icu.util.ULocale;
import java.util.Map;

public class UnicodeExamples {
    public static int visibleCharacters(String input) {
        // 用途：暱稱上限按使用者看到的 grapheme cluster 算，不按 UTF-16 length 算。
        BreakIterator it = BreakIterator.getCharacterInstance(ULocale.ROOT);
        it.setText(input);
        int count = 0;
        for (int end = it.first(); (end = it.next()) != BreakIterator.DONE; ) count++;
        return count;
    }

    public static void main(String[] args) {
        System.out.println(visibleCharacters("👨‍👩‍👧‍👦")); // 1，家庭 emoji 是一個 cluster。
        // 用途：搜尋索引允許全形 ABC 對應半形；保留原輸入作展示，不覆寫外部識別碼。
        System.out.println(Normalizer2.getNFKCInstance().normalize("ＡＢＣ")); // ABC
        MessageFormat english = new MessageFormat(
                "{count, plural, one {# item} other {# items}}", ULocale.ENGLISH);
        System.out.println(english.format(Map.of("count", 2))); // 2 items
        // 文字與 plural 規則一起本地化，不直接在任意語言後面拼一個 s。
    }
}
```

[↑ 回到工具索引](#tool-index)

NFC 與 NFKC 的用途不同：NFKC 會合併相容字形，可能改變字串意義，
不是「所有輸入都應清洗」的規則。可見字元限制也應同時有位元組／總輸入大小上限。

<a id="tool-guava"></a>

## 14.10 集合工具：JDK 與 Guava

**具體用途**：商品標籤對應商品清單、計算標籤出現次數、把大清單切批次。
JDK 已有 List.of、Map.of、Stream.groupingBy；需要 Multimap／Multiset 才引入 Guava。
[Guava 官方專案](https://github.com/google/guava)。

**`src/main/java/com/example/toolbox/CollectionExamples.java`**

```java
package com.example.toolbox;

import com.google.common.collect.*;
import java.util.*;

public class CollectionExamples {
    public static void main(String[] args) {
        // 用途：一個分類對應多個商品 ID；ListMultimap 會保留重複與加入順序。
        ListMultimap<String, Long> byTag = ArrayListMultimap.create();
        byTag.put("java", 101L); byTag.put("java", 102L);
        System.out.println(byTag.get("java")); // [101, 102]
        // 不允許相同標籤／商品重複時，改用 SetMultimap。

        // 用途：統計搜尋結果中各標籤出現次數，不用手動 getOrDefault + 1。
        Multiset<String> hits = HashMultiset.create(List.of("java", "java", "spring"));
        System.out.println(hits.count("java")); // 2

        // 用途：每批最多兩筆傳給批次 API。partition 是 view，不是深複製。
        List<Long> ids = new ArrayList<>(List.of(1L, 2L, 3L));
        for (List<Long> batch : Lists.partition(ids, 2)) {
            List<Long> snapshot = List.copyOf(batch); // 排程／非同步交付前保留這一批的清單快照。
            System.out.println(snapshot); // [1, 2]、[3]
        }
        // 不可變集合不代表元素深度不可變；可變 DTO 仍可能被其他執行緒修改。
    }
}
```

[↑ 回到工具索引](#tool-index)

Guava 的集合類別多數不自帶執行緒安全；需要 shared state 時另設計同步與一致性。
不要只為建立空 List 引入整個 Guava；本機快取直接看 Caffeine，而不是再養一套 Guava Cache。

<a id="tool-files"></a>

## 14.11 檔案、串流與 BOM：Files + Commons IO

**具體用途**：讀取 Excel 匯出的 UTF-8 CSV，移除開頭 BOM，避免第一個欄名變成不可見的「BOM + name」。
基礎讀寫用 Files，Commons IO 補 BOMInputStream 等處理。[官方文件](https://commons.apache.org/proper/commons-io/)。

**`src/main/java/com/example/toolbox/FileExamples.java`**

```java
package com.example.toolbox;

import org.apache.commons.io.ByteOrderMark;
import org.apache.commons.io.input.BOMInputStream;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;

public class FileExamples {
    public static String readUtf8WithoutBom(Path path) throws IOException {
        // 用途：只接受這個小檔示範的 UTF-8；UTF-16 須另外偵測與選擇 decoder。
        try (InputStream raw = Files.newInputStream(path);
             BOMInputStream input = BOMInputStream.builder().setInputStream(raw)
                     .setByteOrderMarks(ByteOrderMark.UTF_8).setInclude(false).get()) {
            // 即使檔案在讀取時增大，仍最多讀 1 MiB + 1 byte，避免 readAllBytes 無界配置。
            int limit = 1024 * 1024;
            byte[] bytes = input.readNBytes(limit + 1);
            if (bytes.length > limit) throw new IOException("檔案超過示範上限 1 MiB");
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    public static void main(String[] args) throws Exception {
        Path file = Files.createTempFile("toolbox-", ".csv");
        try {
            Files.writeString(file, "\uFEFFname,price\nBook,100\n", StandardCharsets.UTF_8);
            System.out.println(readUtf8WithoutBom(file)); // 第一個欄位是 name，不含 BOM。
        } finally { Files.deleteIfExists(file); } // 範例只清理自己建立的暫存檔。
    }
}
```

[↑ 回到工具索引](#tool-index)

大檔改用串流逐筆處理，不把整份塞進 String。
遍歷 Files.list／walk 要關閉 Stream；資料夾大小、壓縮檔解壓與使用者路徑須另有限制，詳見第 07 章。

<a id="tool-jackson"></a>

## 14.12 JSON：Jackson

**具體用途**：API DTO 與 JSON 字串互轉，保留金額精度並正確處理 Instant。
沿用第 07 章的 Jackson 2.x 寫法，本章透過 BOM 對齊 modules。
[官方專案與版本策略](https://github.com/FasterXML/jackson)。

**`src/main/java/com/example/toolbox/JsonExamples.java`**

```java
package com.example.toolbox;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.math.BigDecimal;
import java.time.Instant;

public class JsonExamples {
    // 用途：程序啟動時設定一次，之後可共用；使用中不要再改設定。
    public static final ObjectMapper JSON = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    public record OrderView(String orderNo, BigDecimal amount, Instant createdAt) {}

    public static void main(String[] args) throws Exception {
        OrderView order = new OrderView("O-001", new BigDecimal("123.45"),
                Instant.parse("2026-11-13T02:00:00Z"));
        String text = JSON.writeValueAsString(order);
        System.out.println(text); // amount 是數值，createdAt 是 ISO-8601 字串。
        System.out.println(JSON.readValue(text, OrderView.class).amount()); // 123.45
        // DTO 指定 BigDecimal，避免用 Map<String,Object> 時把金額解成 Double。
        // JSON 成功解析不代表業務有效：非負金額、長度等另用 Validation 驗證。
    }
}
```

[↑ 回到工具索引](#tool-index)

不要為不可信 JSON 開啟任意類別的 default typing；入站請求仍須限制本文大小、巢狀深度與欄位長度。
Gson、JSON-B 是其他選擇，團隊應統一序列化契約，不因個別範例混用數套 mapper。

<a id="tool-csv"></a>

## 14.13 CSV：Commons CSV

**具體用途**：匯入含逗號、引號與換行的商品名稱，按欄名讀資料；不能用 split(",")。
[官方格式與 parser 文件](https://commons.apache.org/proper/commons-csv/apidocs/org/apache/commons/csv/CSVFormat.html)。

**`src/main/java/com/example/toolbox/CsvExamples.java`**

```java
package com.example.toolbox;

import org.apache.commons.csv.*;
import java.io.*;
import java.math.BigDecimal;
import java.util.*;

public class CsvExamples {
    public record Product(String name, BigDecimal price) {}

    public static List<Product> parse(String csv) throws IOException {
        // 用途：匯入小型商品清單，欄內逗號、引號與換行交給 CSV parser 處理。
        CSVFormat format = CSVFormat.DEFAULT.builder()
                .setHeader().setSkipHeaderRecord(true).get(); // 第一列作欄名，不當資料列。
        try (CSVParser parser = format.parse(new StringReader(csv))) {
            if (!parser.getHeaderMap().keySet().equals(Set.of("name", "price")))
                throw new IllegalArgumentException("欄位必須為 name、price");
            List<Product> result = new ArrayList<>();
            for (CSVRecord row : parser) {
                if (!row.isConsistent()) throw new IllegalArgumentException("欄位數不一致");
                BigDecimal price = new BigDecimal(row.get("price"));
                if (price.signum() < 0) throw new IllegalArgumentException("價格不可負數");
                result.add(new Product(row.get("name"), price));
            }
            return List.copyOf(result); // 此示範只處理小型、已限制大小的文字。
        }
    }

    public static void main(String[] args) throws Exception {
        String csv = "name,price\r\n\"Book, Java\",100.50\r\n";
        System.out.println(parse(csv)); // 一筆商品，name 是 Book, Java，不會被拆成兩欄。
        StringWriter output = new StringWriter();
        try (CSVPrinter printer = new CSVPrinter(output, CSVFormat.DEFAULT)) {
            printer.printRecord("name", "price");
            printer.printRecord("Book, Java", "100.50"); // 工具負責引號與跳脫，不手工串接逗號。
        }
        System.out.println(output);
    }
}
```

[↑ 回到工具索引](#tool-index)

CSVParser 解決語法，不負責資料量、重複欄名政策或業務規則；大檔用 Reader 串流與逐批提交。
若供試算表開啟，使用者文字以 =、+、-、@ 等開頭可能被當公式；
CSV 的引號處理不等於防公式注入，須另有匯出政策或以明確文字 cell 輸出 xlsx。

<a id="tool-poi"></a>

## 14.14 Excel：Apache POI

**具體用途**：輸出營運報表 .xlsx，保留訂單編號前導零與精確金額文字。
[官方 POI 文件](https://poi.apache.org/)、[安全處理說明](https://poi.apache.org/security.html)。

**`src/main/java/com/example/toolbox/ExcelExamples.java`**

```java
package com.example.toolbox;

import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import java.io.*;
import java.math.BigDecimal;

public class ExcelExamples {
    public static byte[] export() throws IOException {
        // 用途：小型報表在記憶體建立；大量資料另評估 SXSSFWorkbook 的串流輸出。
        try (Workbook book = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = book.createSheet("orders");
            Row header = sheet.createRow(0);
            header.createCell(0).setCellValue("orderNo");
            header.createCell(1).setCellValue("amount");
            Row row = sheet.createRow(1);
            row.createCell(0, CellType.STRING).setCellValue("00001234567890123456");
            // Excel 數值精度有限。帳務匯出採十進位文字，避免大額／長編號經 double 失真。
            row.createCell(1, CellType.STRING).setCellValue(new BigDecimal("1234567890123456.78").toPlainString());
            // 明確 setCellValue(String)，不把使用者文字傳給 setCellFormula。
            book.write(out);
            return out.toByteArray();
        }
    }

    public static void main(String[] args) throws Exception {
        byte[] bytes = export(); // 真實下載端點可回傳此 byte[]，搭配 xlsx MIME type。
        try (Workbook book = WorkbookFactory.create(new ByteArrayInputStream(bytes))) {
            System.out.println(book.getSheetAt(0).getRow(1).getCell(0).getStringCellValue());
            System.out.println(book.getSheetAt(0).getRow(1).getCell(1).getStringCellValue());
        }
    }
}
```

[↑ 回到工具索引](#tool-index)

若使用者需要試算公式，須先約定允許的數值範圍與精度，不能同時承諾任意精確十進位與 Excel double 計算。
上傳檔另限檔案大小、列數與解壓量；勿關掉 POI 的壓縮炸彈保護只為通過某一份檔案。

<a id="tool-pdfbox"></a>

## 14.15 PDF：Apache PDFBox

**具體用途**：產生簡單英文收據，再驗證 PDF 文字可擷取。
PDFBox 3.x 讀檔改由 Loader.loadPDF；不是舊版 PDDocument.load。
[官方 3.x 遷移說明](https://pdfbox.apache.org/3.0/migration.html)。

**`src/main/java/com/example/toolbox/PdfExamples.java`**

```java
package com.example.toolbox;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.text.PDFTextStripper;
import java.io.*;

public class PdfExamples {
    public static byte[] receipt() throws IOException {
        try (PDDocument doc = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PDPage page = new PDPage(); doc.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(doc, page)) {
                content.beginText();
                content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 12);
                content.newLineAtOffset(50, 750);
                content.showText("Receipt O-001: USD 123.45"); // 用途：固定座標的簡單英文收據。
                content.endText();
            }
            doc.save(out);
            return out.toByteArray();
        }
    }

    public static void main(String[] args) throws Exception {
        try (PDDocument doc = Loader.loadPDF(receipt())) {
            System.out.println(new PDFTextStripper().getText(doc).strip());
        }
    }
}
```

[↑ 回到工具索引](#tool-index)

內建 Helvetica 不含中文；中文須選可合法嵌入的字型，以 PDType0Font.load 載入，不能只換 Java 字串。
PDFBox 是 PDF 物件與繪製工具，不是 HTML/CSS 排版引擎，也不自帶 OCR；掃描 PDF 不能保證擷取到文字。
表格換頁、字型授權、PDF/A、數位簽章等需求須另外評估。

<a id="tool-jsoup"></a>

## 14.16 HTML：jsoup

**具體用途**：從已取得的 HTML 擷取標題，以及清理使用者提供的有限富文字。
[官方功能與 cookbook](https://jsoup.org/)。

**`src/main/java/com/example/toolbox/HtmlExamples.java`**

```java
package com.example.toolbox;

import org.jsoup.Jsoup;
import org.jsoup.safety.Safelist;

public class HtmlExamples {
    public static String cleanRichText(String input) {
        // 用途：允許基本文字標記，但移除 script、事件屬性與不允許的協定／標籤。
        // 只適用輸出到 HTML body；仍須按網站政策調整 safelist。
        return Jsoup.clean(input, Safelist.basic());
    }

    public static void main(String[] args) {
        var doc = Jsoup.parse("<html><title>商品目錄</title><body><h1>Java 書籍</h1></body></html>");
        System.out.println(doc.title()); // 商品目錄
        System.out.println(doc.selectFirst("h1").text()); // Java 書籍
        System.out.println(cleanRichText("<b>優惠</b><script>alert(1)</script>")); // <b>優惠</b>
        // 不會在 JavaScript 裡執行頁面；動態 SPA 抓取須另外評估瀏覽器工具。
    }
}
```

[↑ 回到工具索引](#tool-index)

文字節點 escape（14.8）與保留富文字的 clean 是不同需求。
如果接使用者 URL 抓網頁，仍須處理 SSRF、重新導向、大小限制、授權與站點規則；HTML parser 不會自動解決。

<a id="tool-http"></a>

## 14.17 HTTP：JDK HttpClient

**具體用途**：呼叫已設定的外部查詢 API，區分 HTTP 失敗與網路例外，並限制回應大小。
[Java 21 官方 API](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpClient.html)。

**`src/main/java/com/example/toolbox/HttpExamples.java`**

```java
package com.example.toolbox;

import java.net.URI;
import java.net.http.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

public class HttpExamples {
    public static String fetch(HttpClient client, URI endpoint) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(3)) // 設定本次請求的逾時，不只 TCP connect timeout。
                .header("Accept", "application/json").GET().build();
        HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (InputStream body = response.body()) {
            if (response.statusCode() != 200) throw new IOException("HTTP " + response.statusCode());
            int limit = 64 * 1024; // 用途：這個查詢只允許小型 JSON，不無界讀入記憶體。
            byte[] bytes = body.readNBytes(limit + 1);
            if (bytes.length > limit) throw new IOException("回應超過 64 KiB");
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.out.println("請提供已設定的測試 API URL；自動驗證會用本機 HTTP fixture。");
            return;
        }
        // 用途：這個短命 CLI 建立一個 client；長期服務應共用 client，在服務結束時關閉。
        try (HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
                .followRedirects(HttpClient.Redirect.NEVER).build()) {
            System.out.println(fetch(client, URI.create(args[0])));
        }
    }
}
```

[↑ 回到工具索引](#tool-index)

**串流本文的時間也要設計**：ofInputStream 的 send 可在標頭可讀後回傳，
後面的 readNBytes 不應被誤認為一定受 request.timeout 的完整本文 deadline 保護。
正式環境若可能遇到持續慢速本文，應用具完整 deadline／取消機制的 BodySubscriber，或選擇能設定讀取逾時的 client。
本例實測小型本機回應、HTTP 500 與超量回應，不聲稱已涵蓋所有網路逾時情境。

GET 重試與付款 POST 重試的風險不同；HTTP 非 2xx 不會自動丟例外，要自己判斷。
伺服器端 endpoint 應來自設定／allowlist，不任意接受使用者 URL；公網用 HTTPS。
OkHttp、Apache HttpClient、Spring RestClient／WebClient 是依專案需求的替代方案，不必全裝。

<a id="tool-caffeine"></a>

## 14.18 本機快取：Caffeine

**具體用途**：在同一 JVM 快取可重建的商品顯示資料，限制容量與有效期。
[官方專案](https://github.com/ben-manes/caffeine)。

**`src/main/java/com/example/toolbox/CacheExamples.java`**

```java
package com.example.toolbox;

import com.github.benmanes.caffeine.cache.*;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;

public class CacheExamples {
    public static void main(String[] args) {
        AtomicLong nanos = new AtomicLong(); // 用途：可控制測試時間，不用 Thread.sleep 猜到期。
        LoadingCache<Long, String> names = Caffeine.newBuilder()
                .maximumSize(1000).expireAfterWrite(Duration.ofSeconds(30))
                .ticker(nanos::get).recordStats()
                .build(id -> "product-" + id); // 真實 loader 可查 DB；不應回傳 null 表示正常成功。
        System.out.println(names.get(1L)); // product-1；同 key 的同步載入可合併。
        System.out.println(names.get(1L)); // 快取命中。
        nanos.addAndGet(Duration.ofSeconds(31).toNanos());
        System.out.println(names.getIfPresent(1L)); // null，已過期，不需要等背景清理。
        names.invalidate(1L); // 用途：本機收到商品修改通知後主動失效。
        // 正式環境不傳 ticker(...)，使用 Caffeine 預設的單調時間來源。
    }
}
```

[↑ 回到工具索引](#tool-index)

Caffeine 是 **每個 JVM 一份**，不會自動同步多台應用程式。
TTL 代表容忍舊值多久，不是跨 DB／快取的交易保證；金額、庫存、權限等資料須按業務設計失效與一致性。
需要共享 Redis 時見第 10 篇，不把本機 cache 當分散式鎖或冪等資料庫。

<a id="tool-validation"></a>

## 14.19 欄位驗證：Jakarta Validation + Hibernate Validator

**具體用途**：匯入／API DTO 的 email、國家代碼與金額基本格式驗證。
Validation 是規格；Hibernate Validator 是實作，**與 Hibernate ORM 是不同職責**。
[官方版本與文件](https://hibernate.org/validator/releases/9.1/)。

**`src/main/java/com/example/toolbox/ValidationExamples.java`**

```java
package com.example.toolbox;

import jakarta.validation.Validation;
import jakarta.validation.constraints.*;
import java.math.BigDecimal;

public class ValidationExamples {
    public record Signup(
            @NotBlank @Email String email,
            @NotBlank @Pattern(regexp = "[A-Z]{2}") String country,
            @NotNull @DecimalMin("0.00") @Digits(integer = 9, fraction = 2) BigDecimal amount) {}

    public static void main(String[] args) {
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            // 用途：純 Java 沒有框架代呼叫 validate；只有標註解不會自己執行。
            var validator = factory.getValidator();
            var errors = validator.validate(new Signup("bad-email", "TW", new BigDecimal("-1")));
            System.out.println(errors.size()); // 2；訊息文字可能隨語系／實作版本改變。
            // 正式服務啟動時建立並共用 ValidatorFactory／Validator，結束時關閉 factory。
        }
    }
}
```

[↑ 回到工具索引](#tool-index)

@Email 不證明信箱存在，@Pattern 的兩個大寫字母不證明真有該地區；
還要用 14.6 的 ISO 清單與業務 allowlist 驗證。多數格式註解允許 null，因此需要 @NotNull／@NotBlank。
資料庫唯一約束、餘額、庫存與權限仍在相應層保護，不能只靠 DTO 註解。

<a id="tool-config"></a>

## 14.20 設定：Properties、環境變數與 SnakeYAML

**具體用途**：讀取少量 YAML 設定，限制解析資源，再明確驗證型別與範圍。
JDK Properties 適合簡單鍵值；需 YAML 才加 parser。
[SnakeYAML 官方鏡像與來源](https://github.com/snakeyaml/snakeyaml)。

**`src/main/java/com/example/toolbox/ConfigExamples.java`**

```java
package com.example.toolbox;

import org.yaml.snakeyaml.*;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import java.util.*;

public class ConfigExamples {
    public static int timeoutSeconds(String source) {
        LoaderOptions options = new LoaderOptions();
        options.setAllowDuplicateKeys(false); // 用途：重複設定不可悄悄蓋掉前一個。
        options.setMaxAliasesForCollections(20);
        options.setNestingDepthLimit(20);
        options.setCodePointLimit(16 * 1024);
        Object loaded = new Yaml(new SafeConstructor(options)).load(source);
        // 只解析基本 Map／List／scalar，不接受 YAML tag 建立任意 Java 物件。
        if (!(loaded instanceof Map<?, ?> map) || !map.keySet().equals(Set.of("timeoutSeconds")))
            throw new IllegalArgumentException("只允許 timeoutSeconds");
        Object raw = map.get("timeoutSeconds");
        if (!(raw instanceof Integer value) || value < 1 || value > 30)
            throw new IllegalArgumentException("timeoutSeconds 必須為 1～30 整數");
        return value;
    }

    public static void main(String[] args) {
        System.out.println(timeoutSeconds("timeoutSeconds: 3\n")); // 3
        Properties defaults = new Properties(); defaults.setProperty("app.name", "toolbox");
        System.out.println(defaults.getProperty("app.name"));
        // 真實秘密可由受控環境提供：System.getenv("PAYMENT_API_KEY")；不可寫進範例或版本庫。
    }
}
```

[↑ 回到工具索引](#tool-index)

讀檔／網路進來時先限制原始位元組量，再套 parser 的限制；parser 上限不能補救上游早已無界讀入的 String。
約定清楚「環境變數、系統屬性、設定檔、預設值」的優先順序。
需要型別化設定、profile、secret store 時接後續 Spring Boot／部署篇，不自製另一套全域設定框架。

<a id="tool-slf4j"></a>

## 14.21 日誌：SLF4J + 一個 provider

**具體用途**：在訂單建立時記錄可查詢的 orderNo，並避免為關閉的 log level 先做昂貴字串組合。
本章用 slf4j-simple 方便 CLI 看見輸出；正式 Spring Boot 常由其 logging starter 統一配置。
[SLF4J 官方說明](https://www.slf4j.org/manual.html)。

**`src/main/java/com/example/toolbox/LoggingExamples.java`**

```java
package com.example.toolbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class LoggingExamples {
    private static final Logger log = LoggerFactory.getLogger(LoggingExamples.class);

    public static void main(String[] args) {
        // 用途：訂單號可搜尋，比拼出一整串無結構文字更容易追查。
        log.info("Order created orderNo={} itemCount={}", "O-001", 3);
        // SLF4J 2.x：昂貴內容用 supplier，只在 debug 真正啟用時才求值。
        log.atDebug().addArgument(() -> "expensive diagnostic snapshot").log("detail={}");
        // 不把密碼、token、卡號、完整個資寫入日誌；未信任文字需有長度與換行政策。
    }
}
```

[↑ 回到工具索引](#tool-index)

slf4j-api 是介面，只有 API 沒 provider 可能沒有可見輸出；多個 provider 又可能產生衝突。
應用程式選一個 Logback／Log4j2／Simple provider；函式庫通常只宣告 API，別替使用者強塞 provider。
本章 POM 的 Simple provider 不應再貼到已用 Spring Boot logging starter 的應用程式。
POI 使用的 Log4j API 透過 log4j-to-slf4j 轉接到同一個 provider；不另外裝反向的 log4j-slf4j2-impl，
避免路由循環。轉接與 provider 的差別見 [Log4j 官方元件說明](https://logging.apache.org/log4j/2.x/components.html)。

<a id="tool-retry"></a>

## 14.22 有限重試：Resilience4j Retry

**具體用途**：已確認可重試的查詢，遇到暫時 IOException 時最多嘗試三次。
這裡用可控的假查詢，不呼叫真實第三方。[官方 Retry 文件](https://resilience4j.readme.io/docs/retry)。

**`src/main/java/com/example/toolbox/RetryExamples.java`**

```java
package com.example.toolbox;

import io.github.resilience4j.retry.*;
import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

public class RetryExamples {
    public static void main(String[] args) throws Exception {
        RetryConfig config = RetryConfig.custom().maxAttempts(3) // 包含第一次，不是「再重試三次」。
                .waitDuration(Duration.ofMillis(20)) // 示範固定等待；實際服務可設定退避與 jitter。
                .retryExceptions(IOException.class).ignoreExceptions(IllegalArgumentException.class)
                .build();
        Retry retry = Retry.of("catalog-query", config);
        AtomicInteger calls = new AtomicInteger();
        var query = Retry.decorateCallable(retry, () -> {
            // 用途：模擬安全的讀取。前兩次網路失敗，第三次成功。
            if (calls.incrementAndGet() < 3) throw new IOException("temporary failure");
            return "product-101";
        });
        System.out.println(query.call()); // product-101
        System.out.println(calls.get()); // 3
    }
}
```

[↑ 回到工具索引](#tool-index)

不把所有 IOException／HTTP 5xx 一律視為可重試：須看操作語意與對方契約。
付款、寄信、建立訂單等副作用要有持久冪等設計；不知道前次是否成功時，重試可能重複扣款。
Retry 不是 timeout、CircuitBreaker、RateLimiter；要分別配置整體時間預算、熔斷與配額。
同步等待會佔住呼叫執行緒；虛擬執行緒也不會消除 DB／第三方容量上限。

<a id="tool-encoding"></a>

## 14.23 UUID、Base64、摘要與安全隨機數：JDK

**具體用途**：建立不含業務規則的隨機識別碼、簽發測試隨機 token、計算檔案指紋。
這些需求先用 JDK，不需要為基本功能引入整套加密工具包。

**`src/main/java/com/example/toolbox/EncodingExamples.java`**

```java
package com.example.toolbox;

import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

public class EncodingExamples {
    public static String sha256(byte[] data) throws NoSuchAlgorithmException {
        // 用途：檔案／內容指紋比對。它不提供來源認證，攻擊者可連內容與摘要一起換掉。
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
    }

    public static void main(String[] args) throws Exception {
        System.out.println(UUID.randomUUID()); // 隨機 v4 ID，不保證依建立時間排序，也不是授權機制。
        byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
        System.out.println(token.length()); // 43；只展示長度，不記錄真實 token。
        System.out.println(sha256("abc".getBytes(StandardCharsets.UTF_8)));
        // ba7816bf...f20015ad；Base64 只是編碼、可以解回，不是加密。
        // 密碼儲存不能直接 SHA-256；改用專用 Argon2／bcrypt／scrypt／PBKDF2 密碼雜湊方案。
    }
}
```

[↑ 回到工具索引](#tool-index)

訊息認證用 HMAC 等相應機制；密鑰、演算法、nonce 與輪替策略須成套設計。
加密與密碼儲存詳見安全篇，不照抄「AES + 寫死金鑰」或「MD5 + 固定 salt」的工具範例。
大型檔案的摘要應邊讀邊 update，勿先把整份載入 byte[]。
密碼雜湊與一般摘要的差別可參考 [Spring Security 官方 PasswordEncoder 說明](https://docs.spring.io/spring-security/reference/features/authentication/password-storage.html)。

<a id="tool-indriya"></a>

## 14.24 單位換算：Units of Measurement／Indriya

**具體用途**：物流資料在公尺／公里、公斤等單位之間轉換，讓單位隨數值一起傳遞。
簡單固定單位可先用清楚命名的欄位；跨多種單位才引入型別與換算模型。
[Indriya 官方專案](https://github.com/unitsofmeasurement/indriya)。

**`src/main/java/com/example/toolbox/UnitExamples.java`**

```java
package com.example.toolbox;

import javax.measure.*;
import javax.measure.quantity.Length;
import tech.units.indriya.quantity.Quantities;
import tech.units.indriya.unit.Units;

public class UnitExamples {
    public static void main(String[] args) {
        // 用途：API 明確收 1500 公尺，報表顯示公里，不靠呼叫端記得除以 1000。
        Quantity<Length> distance = Quantities.getQuantity(1500, Units.METRE);
        Quantity<Length> kilometres = distance.to(MetricPrefix.KILO(Units.METRE));
        System.out.println(kilometres.getValue()); // 1.5（數值字面格式依實作）。
        System.out.println(kilometres.getUnit()); // km
        // Length 不能直接轉成 Mass；重量與長度的契約在型別／相容性上分開。
        // 攝氏／華氏含 offset，不能把所有換算都簡化為乘一個比例。
    }
}
```

[↑ 回到工具索引](#tool-index)

物理量換算與貨幣換算不同：公尺／公里定義固定，USD／TWD 匯率會隨來源與時間改變。
測量值也有精度與誤差，單位庫不會自動補出測量品質。

<a id="tool-more"></a>

## 14.25 其他常見工具：如何與本章主選搭配

下表是查找入口，並不表示全部都要加入 14.3 的 POM。
完整可執行範例以本章前面的主選組合為準；測試工具已有第 11 章的實作。

| 工具／類別 | 具體用途 | 選擇與使用邊界 |
|---|---|---|
| [Apache Commons Collections](https://commons.apache.org/proper/commons-collections/) | 特殊集合／集合工具 | 與 JDK、Guava 功能重疊；以團隊需求選一套 |
| [Apache Commons Codec](https://commons.apache.org/proper/commons-codec/) | 多種 codec、摘要輔助 | 基本 Base64、Hex、SHA-256 已有 JDK；摘要不是密碼雜湊 |
| [Apache Commons Compress](https://commons.apache.org/proper/commons-compress/) | tar、7z 等封裝／壓縮格式 | ZIP 基本讀寫先看 java.util.zip；解壓須限制路徑、數量與總量 |
| [ThreeTen-Extra](https://www.threeten.org/threeten-extra/) | java.time 之外的 Interval、YearQuarter 等型別 | 基本日期先用 JDK；不要為新專案再引入舊 Date 工具鏈 |
| [OkHttp](https://github.com/square/okhttp)、[Apache HttpClient](https://hc.apache.org/httpcomponents-client-5.5.x/) | 更完整 HTTP 連線、攔截器／讀取逾時策略 | 根據同步／非同步、代理、timeout 需求選；不是每個 client 都同一套語意 |
| [Gson](https://github.com/google/gson)、[JSON-B](https://jakarta.ee/specifications/jsonb/) | JSON 序列化的替代方案 | 與 Jackson 的日期、命名、null、精度契約要一致；不要任意混搭 |
| [MapStruct](https://mapstruct.org/documentation/stable/reference/html/) | 編譯時產生 DTO／Entity 映射 | 第 05 篇有相關內容；需同時配置 annotation processor，不能只加 annotation API |
| [Lombok](https://projectlombok.org/features/) | getter、builder 等樣板碼 | 不是 runtime 工具函式；annotation processor／IDE／JDK 版本須相容，避免對 JPA Entity 盲加 @Data |
| [Hutool](https://github.com/chinabugotech/hutool) | 日期、字串、轉換、IO 等集合式工具包 | 覆蓋面廣，但仍要核對版本、預設時區／編碼、null／捨入語意；不是商業規則的替代品 |
| Spring StringUtils／CollectionUtils／BeanUtils | 已使用 Spring 專案的基礎輔助 | 第 02 篇起再用；不要只為一個字串方法引入 Spring。反射 copy 也不等於完整型別映射 |
| [JUnit](https://junit.org/)、[AssertJ](https://assertj.github.io/doc/)、[Mockito](https://site.mockito.org/) | 測試執行、可讀斷言、替身 | 詳第 11 章；正確性要測行為，不能只測呼叫次數 |
| [Awaitility](https://www.awaitility.org/)、[Testcontainers](https://java.testcontainers.org/) | 等待非同步條件、真實相依服務整合測試 | 不用任意 sleep 猜完成時間；容器測試仍需控制資料與生命週期 |
| [Micrometer](https://micrometer.io/docs) | 指標與觀測 | 與日誌、trace 互補；避免 userId／orderId 當高基數 metric tag |
| [Quartz](https://www.quartz-scheduler.org/) | 較複雜排程、持久 job 與 misfire 策略 | 簡單單機定時先看 ScheduledExecutorService；多台／重啟後不可漏跑才評估持久排程 |

<a id="tool-mapping"></a>

### DTO 映射先看懂手寫規則，再決定是否自動產生

**具體用途**：只把允許公開的欄位放進回應，避免反射 copy 把 passwordHash 等欄位一起帶出。
下面是可執行的 JDK 對照範例；若使用 MapStruct，再把相同規則交給 mapper 與 processor。

**`src/main/java/com/example/toolbox/MappingExamples.java`**

```java
package com.example.toolbox;

public class MappingExamples {
    record Account(long id, String email, String passwordHash) {}
    record AccountView(long id, String email) {}

    static AccountView toView(Account account) {
        // 用途：明列對外欄位，型別改動可由編譯器提醒，不做「名稱一樣就全複製」。
        return new AccountView(account.id(), account.email());
    }

    public static void main(String[] args) {
        Account account = new Account(1, "demo@example.test", "not-a-real-hash");
        System.out.println(toView(account)); // 回應模型沒有 passwordHash。
    }
}
```

[↑ 回到工具索引](#tool-index)

<a id="tool-composition"></a>

## 14.26 組合範例：跨國訂單的換匯預覽

**具體用途**：把前面的國家代碼、電話、幣別與報價快照串成一個可測的查詢結果。
它只產生預覽，**不代表扣款成功、匯率已鎖定或訂單已成立**。
先存好 CountryExamples、PhoneExamples、ExchangeExamples 與 JsonExamples，才執行此類別。

**`src/main/java/com/example/toolbox/CheckoutPreviewExamples.java`**

```java
package com.example.toolbox;

import java.math.BigDecimal;
import java.time.*;
import java.util.Currency;

public class CheckoutPreviewExamples {
    record Preview(String country, String phone, String fromCurrency, String toCurrency,
                   BigDecimal payable, String rateSource, Instant rateAsOf, Instant quoteExpiresAt) {}

    public static void main(String[] args) throws Exception {
        String country = CountryExamples.region("TW").getCountry();
        String phone = PhoneExamples.toE164("0912345678", country);
        Instant now = Instant.parse("2026-11-13T02:00:00Z");
        var quote = new ExchangeExamples.Quote(Currency.getInstance("USD"), Currency.getInstance("TWD"),
                new BigDecimal("32.50"), now, now.plusSeconds(60), "TEST_FIXTURE");
        BigDecimal payable = ExchangeExamples.convert(new BigDecimal("10.25"),
                Currency.getInstance("USD"), quote, Clock.fixed(now, ZoneOffset.UTC));
        Preview view = new Preview(country, phone, "USD", "TWD", payable,
                quote.source(), quote.asOf(), quote.validUntil());
        // 用途：前端除了顯示應付金額，也能顯示這份報價何時失效。
        System.out.println(JsonExamples.JSON.writeValueAsString(view));
    }
}
```

[↑ 回到工具索引](#tool-index)

這裡的 TW 是輸入地區，不拿它暗中決定交易幣別；電話格式、金額、時間與報價來源都明確傳入。
真正結帳須在伺服器重新驗證商品價格／庫存、報價與冪等契約，不能相信前端送回的預覽金額。

<a id="tool-verification"></a>

## 14.27 執行驗證與練習

repo 附有 `verification/toolbox/`，直接擷取**目前這份 Markdown**的 POM 與 Java 區塊，
編譯所有範例，再檢查日期、幣別、過期報價、國家／電話、Unicode、JSON、CSV、Excel、PDF、
HTML 清理、快取到期、設定與驗證的邊界；HTTP 用本機 fixture，不需要外部服務／Docker。

```bash
# 從 learnbyai 根目錄執行；第一次需要網路下載 Maven 相依套件。
python3 java/01-java-core/verification/toolbox/run.py
# 已下載後可離線重跑。
python3 java/01-java-core/verification/toolbox/run.py --offline
```

驗證說明與當次結果見 [verification/toolbox/README.md](./verification/toolbox/README.md)。
這個工具不會修改 Todo 專案，也不證明真實匯率／金流／SMTP 服務已串接成功。

練習：

1. 金額：USD 12.345 轉最小單位時要失敗；JPY 12.00 應可精確轉為 12。再加入付款商覆寫幣別位數的設定。
2. 換匯：報價到期的那一瞬間必須拒絕，輸入幣別不同也拒絕；寫測試固定 Clock。
3. 國家／電話：拒絕 ZZ 地區代碼，處理空白輸入；明確決定是否接受所選地區以外的國際號碼。
4. CSV：加入欄內雙引號與換行，讓 parser 正確讀成一筆；另訂試算表公式字串的匯出政策。
5. Excel／PDF：產生暫存檔並重新讀取，驗證值，而非只檢查檔案存在；中文 PDF 須附合適字型。
6. 快取：用可控制的 ticker 測到期；說明兩台 JVM 的 cache 為何可能不同。
7. 選型：找出只用 JDK 就能完成的三個需求，移除多餘依賴，再看 dependency:tree 是否仍有傳遞依賴。

## 14.28 常見錯誤與驗收清單

| 常見錯誤 | 為何有問題 | 正確方向 |
|---|---|---|
| 一次把所有工具庫貼進正式專案 | 重複功能、傳遞依賴與升級成本增加 | 以具體需求選模組，BOM／版本與測試一起管理 |
| 工具內部偷用預設時區／語系 | 本機與 CI／正式環境結果不同 | 明確傳 Clock、ZoneId、Locale、Charset |
| 以為 Currency／Moneta 自帶可信即時匯率 | 幣別資料不等於已成交報價 | 依來源、時間、方向與費用契約取得／保存快照 |
| 所有貨幣都乘 100 | 幣別與支付商位數可能不同 | 按契約使用最小單位，轉換須精確或明訂捨入 |
| 國家名稱當主鍵、國家推單一語言／時區 | 名稱與地區規則會變，關係不一定一對一 | 穩定代碼與顯示偏好分開建模 |
| 電話格式合法就算本人驗證成功 | 規則資料不證明持有人 | 格式驗證與 OTP 分開 |
| 用 split 解析 CSV、regex 解析任意 HTML | 引號、換行、巢狀結構出錯 | 用專門 parser，再驗證業務與輸入限制 |
| Excel 長編號／金額一律轉 double | 長編號與十進位可能失真 | 依報表契約選文字或受限數值欄位 |
| Base64 當加密、SHA-256 直接存密碼 | 編碼可還原，一般摘要不抗暴力猜測 | 使用符合需求的密碼學機制與 password encoder |
| 有 Retry 就不設 timeout／冪等 | 可能等很久或重複執行副作用 | 次數、總時間、錯誤分類與冪等一起設計 |
| MapStruct／Lombok 只加一個 dependency | processor 或 IDE 未配置就不會生成預期程式 | 依版本配置編譯器／processor，檢查產生結果 |

- [ ] 能從章首工具索引的業務情境找到對應工具，知道哪些不需要第三方依賴。
- [ ] 能解釋 Locale、Currency、ZoneId、電話國碼的差別。
- [ ] 金額、匯率、單位換算的方向、精度與到期規則都明確。
- [ ] 能執行各範例，並說出註釋中的具體用途與未涵蓋的業務規則。
- [ ] 知道 parser、Validator、Cache、Retry 各負責哪一層，不把工具當正確性的全部。
- [ ] 新依賴會查官方文件、相容版本、授權與維護情況；既有專案升級會跑測試。

## 14.29 官方文件索引

以下連結對應本章 API 與主選工具，可用來核對新版介面；範例的固定版本以 14.3 POM 為準。

| 領域 | 官方入口 |
|---|---|
| 日期、國家／語系、幣別 | [java.time](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/package-summary.html)、[Locale](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Locale.html)、[Currency](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Currency.html) |
| 金額與國際化 | [JavaMoney／Moneta](https://github.com/JavaMoney/jsr354-ri)、[ICU4J](https://unicode-org.github.io/icu/userguide/icu4j/)、[libphonenumber](https://github.com/google/libphonenumber) |
| 字串、集合與 IO | [Commons Lang](https://commons.apache.org/proper/commons-lang/)、[Commons Text](https://commons.apache.org/proper/commons-text/)、[Guava](https://github.com/google/guava)、[Commons IO](https://commons.apache.org/proper/commons-io/) |
| JSON／CSV／Excel／PDF | [Jackson](https://github.com/FasterXML/jackson)、[Commons CSV](https://commons.apache.org/proper/commons-csv/)、[POI](https://poi.apache.org/)、[PDFBox](https://pdfbox.apache.org/) |
| HTML、HTTP | [jsoup](https://jsoup.org/)、[JDK HttpClient](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpClient.html) |
| 快取、驗證、設定 | [Caffeine](https://github.com/ben-manes/caffeine)、[Hibernate Validator](https://hibernate.org/validator/)、[SnakeYAML](https://github.com/snakeyaml/snakeyaml) |
| 日誌、重試、單位 | [SLF4J](https://www.slf4j.org/manual.html)、[Resilience4j Retry](https://resilience4j.readme.io/docs/retry)、[Indriya](https://github.com/unitsofmeasurement/indriya) |

---

上一章：[13 — 反射、註解與動態代理](./13-reflection-annotations-and-proxy.md)。
完成本篇後前往 [02-spring-boot](../02-spring-boot/README.md)。

