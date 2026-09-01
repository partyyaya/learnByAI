# 第 09 章：Spring Boot 3 與常見雷點

> 這一章有兩個身分。
>
> **前半是遷移手冊**：如果你手上有 Spring Boot 2 的專案要升到 3，這裡是完整的步驟與雷點清單。
> 遷移最痛的不是「改 import」（那個 IDE 幫你做），而是那些**編譯通過、啟動成功、但行為變了**的地方——
> 例如 `/orders/` 這個網址突然變成 404、`@RequestParam` 突然報「參數名稱找不到」、
> MySQL 突然多出一張 `hibernate_sequence` 表。
>
> **後半是除錯手冊**：四份可以直接照著跑的 SOP——
> 「Bean 找不到」「啟動變慢」「註解沒生效」「升版後行為改變」。
> 這四類問題佔了 Spring Boot 專案除錯時間的八成，而它們的答案都在前面八章。
> 這一章把它們整理成**決策樹**，讓你不用每次都從頭想。
>
> 這也是這一站的最後一章。結尾會回顧整站，並接到下一站。

---

## 9.1 學習目標

完成本章後，你應該可以：

- 說明為什麼要升到 Spring Boot 3，以及「不升」的實際風險。
- 規劃一次安全的遷移：**正確的順序、每一步的驗證方式、可以回頭的檢查點**。
- 完成 `javax.*` → `jakarta.*` 的命名空間遷移，並知道**哪些 `javax` 不用改**。
- 檢查第三方函式庫的相容性，並處理「還沒支援 Jakarta」的依賴。
- 用 `spring-boot-properties-migrator` 找出所有更名的設定屬性。
- 完成 Spring Security 6 的設定重寫（`WebSecurityConfigurerAdapter` 已移除）。
- 處理 Spring MVC 的三個靜默行為改變：**尾斜線、路徑匹配、參數名稱**。
- 處理 Hibernate 6 的三個雷點：**ID 生成策略、`@Type` 移除、HQL 語法收緊**。
- 更新 Actuator 端點與可觀測性設定（Sleuth → Micrometer Tracing）。
- 遷移自訂 starter（`spring.factories` → `AutoConfiguration.imports`）。
- 用 OpenRewrite 自動化 70% 的機械性修改。
- **執行四份除錯 SOP**：Bean 找不到、啟動變慢、註解沒生效、升版後行為改變。
- 說出 Boot 3.1～3.4 各版本值得知道的新功能與雷點。

---

## 9.2 為什麼要升，不升的風險是什麼

### Spring Boot 2.7 已經沒有支援了

```
2022-05  Spring Boot 2.7 發布
2023-11  ★ OSS 免費支援結束 ★  → 之後不再有免費的安全性修補
2025-08  商業支援（Enterprise Subscription）也已到期
2026-08  今天 —— 2.x 已經完全沒有官方修補管道
```

**「沒有支援」的具體意思：**

| 情況 | 有支援時 | 沒有支援時 |
|---|---|---|
| Spring Framework 出現 RCE 漏洞 | 官方在幾天內發布修補版 | **你得自己 fork 或自己 patch** |
| 依賴的 Jackson / Netty 有漏洞 | Boot 的 BOM 會升上去 | 自己一個一個試相容性 |
| 資安稽核 / 客戶檢查 | 通過 | ❌ 被列為高風險項目 |
| Log4Shell 等級的事件再來一次 | 幾小時內有解 | **幾天到幾週** |

> **真實案例**：某金融相關客戶在 2024 年的資安稽核中，
> 因為使用「已終止支援的框架版本」被列為必須改善項目，
> 給了三個月期限。那個團隊在三個月內硬升了六個服務——
> **在時間壓力下升版，比從容規劃升版痛苦十倍。**
>
> **不要等到被逼。**

### 升上去換到什麼

| 項目 | 說明 |
|---|---|
| 持續的安全性修補 | 最重要的理由 |
| Java 17 / 21 的語言特性 | `record`、`sealed`、pattern matching（01-java-core 第 12 章） |
| **虛擬執行緒** | Boot 3.2+，一行設定（第 06 章 6.7） |
| **可觀測性統一** | Micrometer Observation API，指標與追蹤一次埋（第 05 章） |
| **GraalVM native image** | 官方支援，啟動 90 毫秒（第 08 章 8.5） |
| `RestClient` / `JdbcClient` | 更好用的 API |
| Testcontainers 整合 | `@ServiceConnection`（第 07 章 7.8） |
| 結構化日誌 | Boot 3.4 內建（第 05 章 5.8） |
| CDS 支援 | Boot 3.3+，啟動快 30%（第 08 章） |

---

## 9.3 遷移的正確順序

**最重要的原則：不要一次跳到 3.x。**

```
❌ 錯誤做法（我看過很多次）
   pom.xml 的 2.5.3 直接改成 3.5.0
   → 編譯錯誤 800 個
   → 完全不知道從哪裡下手
   → 修了三天，越修越亂
   → 放棄，git reset --hard

✅ 正確做法
   階段 0：建立安全網（測試 + 基準）
   階段 1：升到 2.7.x 最新版（同一大版本，變動小）
   階段 2：升 JDK 到 17（或 21）
   階段 3：清掉所有 deprecation 警告
   階段 4：升到 3.0.x（★ 這一步最大，做完就過了大半 ★）
   階段 5：逐步升到 3.1 → 3.2 → 3.3 → 3.4 → 3.5
```

**每個階段結束時都要：**

```
□ 編譯通過
□ 所有測試綠燈
□ 本機啟動成功，且啟動日誌沒有新的 WARN
□ 主要 API 手動驗證一次（或跑一次 E2E）
□ commit（讓你隨時可以回到上一個可運作的狀態）
```

### 階段 0：建立安全網（不要跳過）

**如果專案沒有測試，先寫測試再升版。** 否則你不會知道自己弄壞了什麼。

**最低限度的安全網：**

```java
// ① 冒煙測試：容器能不能起來（第 00 章 0.9 提過）
@SpringBootTest
class ApplicationSmokeTest {
    @Test
    void contextLoads() { }
}
```

```java
// ② 每支主要 API 至少一個測試（第 07 章 7.7）
@WebMvcTest(OrderController.class)
class OrderControllerContractTest {

    @Autowired MockMvc mockMvc;
    @MockBean OrderService orderService;      // 遷移完成後再換成 @MockitoBean

    @Test
    void 查詢訂單的回應格式不應改變() throws Exception {
        given(orderService.findById(1L)).willReturn(sampleOrder());

        mockMvc.perform(get("/orders/1"))
               .andExpect(status().isOk())
               .andExpect(content().json("""
                       {
                         "id": 1,
                         "customerName": "王小明",
                         "amount": 1280.00,
                         "status": "PAID",
                         "createdAt": "2026-08-18T00:00:00Z"
                       }
                       """, false));       // false = 容許多餘欄位
    }

    @Test
    void 尾斜線的網址也要能通() throws Exception {
        // ★ 這個測試會在階段 4 抓到「尾斜線行為改變」（見 9.9）★
        given(orderService.findById(1L)).willReturn(sampleOrder());
        mockMvc.perform(get("/orders/1/")).andExpect(status().isOk());
    }
}
```

```bash
# ③ 記錄基準（升完之後要比對）
$ ./mvnw dependency:tree > /tmp/deps-before.txt
$ ./mvnw test 2>&1 | tail -20 > /tmp/tests-before.txt
$ curl -s localhost:8080/actuator/beans | jq -r '.contexts.application.beans | keys[]' | sort > /tmp/beans-before.txt
$ curl -s localhost:8080/actuator/env | jq '.propertySources' > /tmp/env-before.json
$ curl -s localhost:8080/actuator/mappings | jq -r \
    '.contexts.application.mappings.dispatcherServlets.dispatcherServlet[].details.requestMappingConditions.patterns[]?' \
    | sort -u > /tmp/mappings-before.txt
```

> **`mappings-before.txt` 這一份特別有價值**：
> 升版後再抓一次做 `diff`，可以立刻看出「有沒有 API 路徑消失」。
> 這比手動點測所有 API 快多了。

### 階段 1：升到 2.7 最新版

```xml
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>2.7.18</version>          <!-- 2.7 的最後一版 -->
</parent>
```

**為什麼要先做這一步：**

- 2.7.x 之間的變動很小，風險低。
- **2.7 已經支援 Boot 3 的部分新寫法**（例如 `AutoConfiguration.imports`），
  可以在 2.7 就先改好，降低階段 4 的工作量。
- 2.7 會對「Boot 3 已移除的東西」發出 deprecation 警告——這是免費的遷移清單。

```bash
# 把所有 deprecation 警告列出來，這就是你的待辦清單
./mvnw clean compile -Dmaven.compiler.showDeprecation=true 2>&1 | grep -E 'deprecat|已過時' | sort -u
```

### 階段 2：升 JDK

```xml
<properties>
    <java.version>21</java.version>
</properties>
```

```bash
sdk install java 21.0.5-tem
sdk use java 21.0.5-tem
./mvnw clean verify
```

**這一步常見的問題：**

| 問題 | 原因 | 解法 |
|---|---|---|
| `InaccessibleObjectException` | JDK 17 的強封裝（JEP 403） | 加 `--add-opens`，或升級那個函式庫 |
| Lombok 編譯失敗 | 舊版 Lombok 不支援 JDK 17+ | 升到 1.18.30+ |
| Mockito 無法 mock final | 舊版限制 | 升到 5.x（Boot 3 的 BOM 已含） |
| 反射相關的 `IllegalAccessError` | 同 JEP 403 | 找出是哪個函式庫，升版 |
| `NoClassDefFoundError: javax/xml/bind/...` | JAXB 在 JDK 11 就被移除了 | 加 `jakarta.xml.bind-api` 依賴 |

> **`--add-opens` 是最後手段**。它只是把封裝打開，問題還在。
> 正確做法是升級那個用了內部 API 的函式庫。

### 階段 3：清掉 deprecation

**在 2.7 就把所有 deprecated 的用法改掉。** 這一步做得越乾淨，階段 4 越輕鬆。

常見的（依出現頻率）：

```java
// ① WebSecurityConfigurerAdapter（2.7 已 deprecated，3.0 移除）
// ② @EnableGlobalMethodSecurity → @EnableMethodSecurity
// ③ WebMvcConfigurer 的舊方法
// ④ spring.factories 的自動組態 → AutoConfiguration.imports
// ⑤ @ConstructorBinding 在類別層級 → 建構子層級
// ⑥ RestTemplate 的部分建構方式
```

### 階段 4：升到 3.0

```xml
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.0.13</version>          <!-- 先到 3.0 的最後一版，不要直接跳 3.5 -->
</parent>
```

**這一步會產生大量編譯錯誤，這是正常的。** 9.5～9.13 逐項處理。

### 階段 5：逐步升到最新

```
3.0.13 → 3.1.x → 3.2.x → 3.3.x → 3.4.x → 3.5.x
```

**每一小版都是獨立的 commit，每次都跑完整測試。**
3.x 之間的變動比 2 → 3 小很多，但仍有雷點（9.20 列出）。

---

## 9.4 ★ Jakarta 命名空間遷移 ★

### 為什麼會有這件事

```
2018  Oracle 把 Java EE 捐給 Eclipse Foundation
      → 但「不准用 javax 這個命名空間」（商標問題）
2019  更名為 Jakarta EE
2020  Jakarta EE 9：★ 所有 javax.* API 套件改名為 jakarta.* ★
      （純改名，API 內容不變）
2022  Spring Framework 6 / Boot 3 全面採用 Jakarta EE 9+
```

**這是純粹的「改名」，不是功能變更。** 但因為牽涉到每一個 import，工作量很大。

### 要改的（Jakarta EE 規範的一部分）

| Boot 2（`javax.*`） | Boot 3（`jakarta.*`） | 常見於 |
|---|---|---|
| `javax.servlet.*` | `jakarta.servlet.*` | Filter、HttpServletRequest |
| `javax.persistence.*` | `jakarta.persistence.*` | **JPA Entity（最大量）** |
| `javax.validation.*` | `jakarta.validation.*` | `@NotNull`、`@Valid` |
| `javax.annotation.*` | `jakarta.annotation.*` | `@PostConstruct`、`@PreDestroy`、`@Resource` |
| `javax.transaction.*` | `jakarta.transaction.*` | `@Transactional`（JTA 版） |
| `javax.mail.*` | `jakarta.mail.*` | 寄信 |
| `javax.jms.*` | `jakarta.jms.*` | JMS |
| `javax.websocket.*` | `jakarta.websocket.*` | WebSocket |
| `javax.xml.bind.*` | `jakarta.xml.bind.*` | JAXB |
| `javax.ws.rs.*` | `jakarta.ws.rs.*` | JAX-RS |
| `javax.el.*` | `jakarta.el.*` | Expression Language |
| `javax.inject.*` | `jakarta.inject.*` | `@Inject`、`@Named` |

### ★ 不要改的（Java SE 的一部分）★

**這是最容易搞錯的地方。** 有人用 sed 全域替換 `javax` → `jakarta`，結果把這些也改了：

```java
import javax.sql.DataSource;                 // ✅ 不改（JDBC 是 Java SE）
import javax.sql.XADataSource;               // ✅ 不改
import javax.crypto.Cipher;                  // ✅ 不改（JCE）
import javax.crypto.spec.SecretKeySpec;      // ✅ 不改
import javax.net.ssl.SSLContext;             // ✅ 不改（JSSE）
import javax.naming.Context;                 // ✅ 不改（JNDI）
import javax.management.MBeanServer;         // ✅ 不改（JMX）
import javax.security.auth.Subject;          // ✅ 不改（JAAS）
import javax.imageio.ImageIO;                // ✅ 不改
import javax.swing.JFrame;                   // ✅ 不改
import javax.script.ScriptEngine;            // ✅ 不改
import javax.tools.JavaCompiler;             // ✅ 不改
import javax.xml.parsers.DocumentBuilder;    // ✅ 不改（JAXP）
import javax.xml.xpath.XPath;                // ✅ 不改
```

> **判斷準則：這個套件是不是隨 JDK 一起附的？**
> 是 → 不改（Java SE）。
> 需要額外加依賴才有 → 改（Jakarta EE）。
>
> **最快的判斷方式**：改完之後編譯，如果報 `package jakarta.sql does not exist`
> 就是改錯了。

### 實際的改法

#### 方式 A：IDE 的全域取代（推薦，可控）

IntelliJ IDEA：`Edit → Find → Replace in Files`（`Cmd+Shift+R`），
勾選 **Regex**，逐個處理（**不要一次全改**）：

```
搜尋：import javax\.persistence\.
取代：import jakarta.persistence.

搜尋：import javax\.validation\.
取代：import jakarta.validation.

搜尋：import javax\.servlet\.
取代：import jakarta.servlet.

搜尋：import javax\.annotation\.(PostConstruct|PreDestroy|Resource|Nonnull|Nullable)
取代：import jakarta.annotation.$1
```

**逐個處理的好處**：每改一組就編譯一次，錯了馬上知道是哪一組。

> ⚠️ 注意 `javax.annotation` 的陷阱：
> - `javax.annotation.PostConstruct` → `jakarta.annotation.PostConstruct` ✅ 要改
> - `javax.annotation.processing.Processor` → **不改**（Java SE 的註解處理器 API）
> - `javax.annotation.Nullable`（JSR-305，來自 `com.google.code.findbugs`）→ **不改**
>   （這個不是 Jakarta EE，Boot 3 也沒有對應的 jakarta 版本）

#### 方式 B：命令列（大專案，先備份）

```bash
# ① 先 commit，確保可以回頭
git add -A && git commit -m "chore: 遷移前的檢查點"

# ② 逐個套件替換（★ 不要用 javax→jakarta 全域替換 ★）
for pkg in persistence validation servlet transaction mail jms websocket el inject; do
  echo "處理 javax.$pkg ..."
  find src -name '*.java' -exec \
    sed -i '' "s/import javax\.$pkg\./import jakarta.$pkg./g" {} +
done

# ③ javax.annotation 只改特定幾個類別
find src -name '*.java' -exec sed -i '' \
  -e 's/import javax\.annotation\.PostConstruct;/import jakarta.annotation.PostConstruct;/g' \
  -e 's/import javax\.annotation\.PreDestroy;/import jakarta.annotation.PreDestroy;/g' \
  -e 's/import javax\.annotation\.Resource;/import jakarta.annotation.Resource;/g' \
  {} +

# ④ 檢查有沒有漏掉的（在字串、註解、XML 裡的）
grep -rn 'javax\.' src/ --include='*.java' --include='*.xml' --include='*.yml' --include='*.properties' \
  | grep -vE 'javax\.(sql|crypto|net|naming|management|security|imageio|swing|script|tools|xml\.(parsers|xpath|transform|stream|namespace|datatype)|annotation\.processing|lang\.model)'
```

#### 方式 C：OpenRewrite（最省力，見 9.13）

### 容易漏掉的地方

```
□ src/test/ 底下的測試程式碼
□ XML 檔案裡的類別全名（persistence.xml、web.xml、Spring XML 設定）
□ 字串常值裡的類別名稱（反射用 Class.forName("javax.persistence.Entity")）
□ application.yml 裡的類別名稱
□ Logback / Log4j2 設定檔
□ 註解裡的 @SuppressWarnings、Javadoc 的 @link
□ ★ 自訂註解的 meta-annotation ★
□ ★ 產生程式碼的樣板（MapStruct、QueryDSL 的設定）★
```

```bash
# 檢查 XML 與設定檔
grep -rn 'javax\.\(persistence\|validation\|servlet\|transaction\)' \
  src/main/resources/ src/test/resources/
```

### 對應的依賴也要換

```xml
<!-- ❌ Boot 2 -->
<dependency>
    <groupId>javax.validation</groupId>
    <artifactId>validation-api</artifactId>
</dependency>
<dependency>
    <groupId>javax.servlet</groupId>
    <artifactId>javax.servlet-api</artifactId>
</dependency>
<dependency>
    <groupId>javax.xml.bind</groupId>
    <artifactId>jaxb-api</artifactId>
</dependency>

<!-- ✅ Boot 3（通常由 starter 帶進來，不用自己宣告） -->
<dependency>
    <groupId>jakarta.validation</groupId>
    <artifactId>jakarta.validation-api</artifactId>
</dependency>
<dependency>
    <groupId>jakarta.servlet</groupId>
    <artifactId>jakarta.servlet-api</artifactId>
    <scope>provided</scope>
</dependency>
<dependency>
    <groupId>jakarta.xml.bind</groupId>
    <artifactId>jakarta.xml.bind-api</artifactId>
</dependency>
```

> **建議：先把所有 `javax.*` 的依賴宣告刪掉，編譯看少了什麼再補。**
> 大部分會由 starter 自動帶進來（第 02 章）。

---

## 9.5 第三方函式庫的相容性

### 檢查清單

```bash
# ① 列出所有直接依賴（不含 Spring 管理的）
./mvnw dependency:tree -Dscope=compile | grep -v 'org.springframework'

# ② 找出還在用 javax 的 jar（★ 最重要的檢查 ★）
./mvnw dependency:copy-dependencies -DoutputDirectory=/tmp/jars -q
for jar in /tmp/jars/*.jar; do
  if unzip -l "$jar" 2>/dev/null | grep -q 'javax/\(servlet\|persistence\|validation\)/'; then
    echo "⚠️  $(basename $jar) 仍使用 javax"
  fi
done
```

### 常見函式庫的最低版本

| 函式庫 | Jakarta 支援起始版本 | 備註 |
|---|---|---|
| Hibernate | 6.1+ | Boot 3 用 6.x，有大量行為變更（9.9） |
| Hibernate Validator | 7.0+ | |
| Jackson | 2.14+ | Boot 3 的 BOM 已處理 |
| MyBatis Spring Boot Starter | 3.0+ | ⚠️ 2.x 完全不相容 |
| Springdoc OpenAPI | **2.0+** | ⚠️ 1.x 完全不相容，而且 artifactId 改了 |
| MapStruct | 1.5.3+ | |
| QueryDSL | 5.0+ 且要用 `jakarta` classifier | ⚠️ 見下方 |
| Flyway | 9.x+ | |
| Liquibase | 4.20+ | |
| Lombok | 1.18.30+ | 主要是 JDK 21 支援 |
| Testcontainers | 1.19+ | |
| WireMock | 3.x | ⚠️ 2.x 用 Jetty 9（javax） |
| POI / EasyExcel | 依版本 | 要個別確認 |
| Shiro | 2.0+ | 或改用 Spring Security |
| Swagger（springfox） | ❌ **完全不支援** | 必須換成 springdoc |

### 三個最痛的案例

#### ① Springfox → Springdoc

```xml
<!-- ❌ Boot 2 常見用法，Springfox 已停止維護且不支援 Boot 3 -->
<dependency>
    <groupId>io.springfox</groupId>
    <artifactId>springfox-boot-starter</artifactId>
    <version>3.0.0</version>
</dependency>

<!-- ✅ 換成 springdoc（artifactId 注意有 -api 與 -ui 之分） -->
<dependency>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
    <version>2.6.0</version>
</dependency>
```

```java
// 註解也要換
// ❌ Springfox / Swagger 2
@Api(tags = "訂單")
@ApiOperation(value = "查詢訂單")
@ApiParam(value = "訂單 ID")
@ApiModelProperty(value = "金額")

// ✅ OpenAPI 3（springdoc 用的是標準的 swagger-annotations v3）
@Tag(name = "訂單")
@Operation(summary = "查詢訂單")
@Parameter(description = "訂單 ID")
@Schema(description = "金額")
```

```yaml
# 設定也不一樣
springdoc:
  api-docs:
    path: /v3/api-docs
  swagger-ui:
    path: /swagger-ui.html
    operations-sorter: method
  packages-to-scan: com.example.shop.web
```

> **這通常是整個遷移中最花時間的一項**（如果專案有大量 Swagger 註解）。
> 好消息是 OpenRewrite 有對應的 recipe（9.13）。

#### ② QueryDSL 的 classifier

```xml
<!-- ❌ Boot 2 -->
<dependency>
    <groupId>com.querydsl</groupId>
    <artifactId>querydsl-jpa</artifactId>
</dependency>

<!-- ✅ Boot 3：★ 一定要加 jakarta classifier ★ -->
<dependency>
    <groupId>com.querydsl</groupId>
    <artifactId>querydsl-jpa</artifactId>
    <classifier>jakarta</classifier>
</dependency>
<dependency>
    <groupId>com.querydsl</groupId>
    <artifactId>querydsl-apt</artifactId>
    <classifier>jakarta</classifier>
    <scope>provided</scope>
</dependency>
```

```xml
<!-- annotation processor 的設定也要改 -->
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <configuration>
        <annotationProcessorPaths>
            <path>
                <groupId>com.querydsl</groupId>
                <artifactId>querydsl-apt</artifactId>
                <version>${querydsl.version}</version>
                <classifier>jakarta</classifier>
            </path>
            <path>
                <groupId>jakarta.persistence</groupId>
                <artifactId>jakarta.persistence-api</artifactId>
            </path>
            <path>
                <groupId>org.projectlombok</groupId>
                <artifactId>lombok</artifactId>
                <version>${lombok.version}</version>
            </path>
        </annotationProcessorPaths>
    </configuration>
</plugin>
```

> **忘了 classifier 的症狀**：編譯時報
> `cannot find symbol: class EntityPath`，或 `Q` 類別（`QOrder`）根本沒產生。
> 而且錯誤訊息完全沒提到 classifier，很難聯想到。

#### ③ 依賴根本還沒支援 Jakarta

三種處理方式（由好到將就）：

```
① 找替代品
   例：Springfox → Springdoc
       Shiro → Spring Security

② 用 Eclipse Transformer 自己轉換 jar
   java -jar org.eclipse.transformer.cli.jar \
     -o old-lib.jar new-lib-jakarta.jar
   ⚠️ 能動但不保證正確，而且之後每次升版都要自己轉

③ 把那個功能隔離成獨立服務
   讓它繼續跑在 Boot 2（暫時），主服務先升級
   ⚠️ 增加架構複雜度，但有時是唯一選擇
```

---

## 9.6 設定屬性變更

### 用 `properties-migrator` 找出全部

```xml
<!-- ★ 遷移期間暫時加入，完成後一定要移除 ★ -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-properties-migrator</artifactId>
    <scope>runtime</scope>
</dependency>
```

啟動後日誌會出現：

```
WARN 40 --- [main] o.s.b.c.p.m.PropertiesMigrationListener :

The use of configuration keys that have been renamed was found in the environment:

Property source 'Config resource [application.yml]':
	Key: spring.redis.host
		Line: 12
		Replacement: spring.data.redis.host
	Key: spring.redis.port
		Line: 13
		Replacement: spring.data.redis.port
	Key: management.metrics.export.prometheus.enabled
		Line: 45
		Replacement: management.prometheus.metrics.export.enabled

Each configuration key has been temporarily mapped to its replacement for your
convenience. To silence this warning, please update your configuration to use
the new keys.


The use of configuration keys that are no longer supported was found:

Property source 'Config resource [application.yml]':
	Key: spring.jpa.hibernate.use-new-id-generator-mappings
		Line: 30
		Reason: Hibernate 6 no longer supports this option.
```

> **這個工具會「暫時幫你映射」舊的 key，所以服務照樣能跑**——
> 讓你可以先升版跑起來，再慢慢清理設定檔。
>
> ⚠️ **但一定要記得移除這個依賴**。它有效能開銷，
> 而且會讓「設定打錯字」的問題被掩蓋。

### 主要的更名清單

| Boot 2 | Boot 3 |
|---|---|
| `spring.redis.*` | **`spring.data.redis.*`** |
| `spring.data.cassandra.*` | `spring.cassandra.*` |
| `spring.data.elasticsearch.client.reactive.*` | `spring.elasticsearch.*` |
| `management.metrics.export.prometheus.*` | **`management.prometheus.metrics.export.*`** |
| `management.metrics.export.datadog.*` | `management.datadog.metrics.export.*` |
| `management.metrics.distribution.*` | `management.metrics.distribution.*`（不變） |
| `spring.datasource.initialization-mode` | `spring.sql.init.mode`（2.5 就改了） |
| `spring.datasource.schema` / `data` | `spring.sql.init.schema-locations` / `data-locations` |
| `logging.pattern.rolling-file-name` | `logging.logback.rollingpolicy.file-name-pattern` |
| `logging.file.max-size` | `logging.logback.rollingpolicy.max-file-size` |
| `logging.file.max-history` | `logging.logback.rollingpolicy.max-history` |
| `server.max-http-header-size` | `server.max-http-request-header-size` |
| `spring.mvc.pathmatch.matching-strategy` | 仍存在，但預設值變了（見 9.8） |
| `spring.sleuth.*` | ❌ 移除 → `management.tracing.*` |
| `spring.jpa.hibernate.use-new-id-generator-mappings` | ❌ 移除（Hibernate 6 不支援） |
| `spring.mvc.async.request-timeout` | 不變 |
| `spring.session.store-type` | 不變 |

---

## 9.7 Spring Security 6

**這是遷移中改動量第二大的部分**（第一大是 Jakarta import）。

### `WebSecurityConfigurerAdapter` 已移除

```java
// ══════════ ❌ Boot 2 / Security 5 的寫法 ══════════
@Configuration
@EnableWebSecurity
public class SecurityConfig extends WebSecurityConfigurerAdapter {

    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http
            .csrf().disable()
            .authorizeRequests()
                .antMatchers("/public/**", "/actuator/health").permitAll()
                .antMatchers("/admin/**").hasRole("ADMIN")
                .antMatchers(HttpMethod.POST, "/orders").hasAnyRole("BUYER", "ADMIN")
                .anyRequest().authenticated()
            .and()
            .formLogin()
                .loginPage("/login")
                .permitAll()
            .and()
            .logout()
                .logoutSuccessUrl("/")
            .and()
            .sessionManagement()
                .sessionCreationPolicy(SessionCreationPolicy.STATELESS);
    }

    @Override
    protected void configure(AuthenticationManagerBuilder auth) throws Exception {
        auth.userDetailsService(userDetailsService).passwordEncoder(passwordEncoder());
    }

    @Override
    public void configure(WebSecurity web) {
        web.ignoring().antMatchers("/css/**", "/js/**");
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

```java
// ══════════ ✅ Boot 3 / Security 6 的寫法 ══════════
package com.example.shop.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;

@Configuration
@EnableWebSecurity
public class SecurityConfig {                          // ① 不再繼承任何類別

    // ② 用 SecurityFilterChain Bean 取代 configure(HttpSecurity)
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            // ③ 一律用 lambda DSL，不再用 .and() 串接
            .csrf(AbstractHttpConfigurer::disable)
            // ④ authorizeRequests → authorizeHttpRequests
            .authorizeHttpRequests(auth -> auth
                    // ⑤ antMatchers → requestMatchers
                    .requestMatchers("/public/**", "/actuator/health").permitAll()
                    .requestMatchers("/admin/**").hasRole("ADMIN")
                    .requestMatchers(HttpMethod.POST, "/orders").hasAnyRole("BUYER", "ADMIN")
                    .anyRequest().authenticated())
            .formLogin(form -> form
                    .loginPage("/login")
                    .permitAll())
            .logout(logout -> logout
                    .logoutSuccessUrl("/"))
            .sessionManagement(session -> session
                    .sessionCreationPolicy(SessionCreationPolicy.STATELESS));

        return http.build();
    }

    // ⑥ configure(AuthenticationManagerBuilder) → 提供 AuthenticationProvider Bean
    @Bean
    public AuthenticationProvider authenticationProvider(UserDetailsService userDetailsService,
                                                         PasswordEncoder passwordEncoder) {
        DaoAuthenticationProvider provider = new DaoAuthenticationProvider();
        provider.setUserDetailsService(userDetailsService);
        provider.setPasswordEncoder(passwordEncoder);
        return provider;
    }

    // ⑦ configure(WebSecurity) → 在 filter chain 裡用 permitAll
    //    （或用 WebSecurityCustomizer，但那會完全跳過 Security，通常不是你想要的）
    @Bean
    public org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer
            webSecurityCustomizer() {
        return web -> web.ignoring().requestMatchers("/css/**", "/js/**");
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

### 對照表

| Security 5 | Security 6 |
|---|---|
| `extends WebSecurityConfigurerAdapter` | ❌ 移除 → 提供 `SecurityFilterChain` Bean |
| `authorizeRequests()` | `authorizeHttpRequests()` |
| `antMatchers()` | `requestMatchers()` |
| `mvcMatchers()` | `requestMatchers()` |
| `regexMatchers()` | `requestMatchers(RegexRequestMatcher.regexMatcher(...))` |
| `.and()` 串接 | lambda DSL |
| `configure(AuthenticationManagerBuilder)` | `AuthenticationProvider` / `UserDetailsService` Bean |
| `configure(WebSecurity)` | `WebSecurityCustomizer` Bean |
| `@EnableGlobalMethodSecurity(prePostEnabled = true)` | `@EnableMethodSecurity`（`prePostEnabled` 預設就是 true） |
| `access("hasRole('X') and hasIpAddress('...')")` | `access(AuthorizationManager)` |
| `NoOpPasswordEncoder` | ❌ 移除（本來就不該用） |
| `WebSecurityConfigurerAdapter` 的多個實作 | 多個 `SecurityFilterChain` Bean + `@Order` |

### 多條 Filter Chain（很常見）

```java
@Configuration
@EnableWebSecurity
public class MultiChainSecurityConfig {

    /** ① API 用：無狀態 + JWT */
    @Bean
    @org.springframework.core.annotation.Order(1)
    public SecurityFilterChain apiFilterChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/api/**")                    // ★ 只處理 /api/** ★
            .csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                    .requestMatchers("/api/public/**").permitAll()
                    .anyRequest().authenticated())
            .oauth2ResourceServer(oauth -> oauth.jwt(jwt -> { }));
        return http.build();
    }

    /** ② Actuator 用（第 05 章 5.16） */
    @Bean
    @org.springframework.core.annotation.Order(2)
    public SecurityFilterChain actuatorFilterChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher(org.springframework.boot.actuate.autoconfigure.security.servlet
                    .EndpointRequest.toAnyEndpoint())
            .authorizeHttpRequests(auth -> auth
                    .requestMatchers(org.springframework.boot.actuate.autoconfigure.security.servlet
                            .EndpointRequest.to("health", "info")).permitAll()
                    .anyRequest().hasRole("ACTUATOR_ADMIN"))
            .httpBasic(basic -> { })
            .csrf(AbstractHttpConfigurer::disable);
        return http.build();
    }

    /** ③ 其他（網頁表單登入） */
    @Bean
    @org.springframework.core.annotation.Order(3)
    public SecurityFilterChain webFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
            .formLogin(form -> form.loginPage("/login").permitAll());
        return http.build();
    }
}
```

> ⚠️ **`@Order` 的順序很重要**：Security 會用**第一條符合 `securityMatcher` 的 chain**，
> 而且**不會再往下**。所以「最具體的放前面，最寬鬆的放最後」。
>
> 忘記加 `securityMatcher` 的 chain 會匹配所有請求——如果它排在前面，
> 後面的 chain 就永遠不會被用到。這是最常見的多 chain bug。

### `@PreAuthorize` 的變更

```java
// Boot 2
@EnableGlobalMethodSecurity(prePostEnabled = true, securedEnabled = true)

// Boot 3
@EnableMethodSecurity(securedEnabled = true)     // prePostEnabled 預設 true，不用寫
```

> 完整的 Spring Security 內容在 09-spring-security 那一站，這裡只處理「遷移」相關的部分。

---

## 9.8 Spring MVC 的三個靜默行為改變

**這一節最危險**——因為它們**編譯通過、啟動成功、測試可能也過**，只有實際流量進來才會發現。

### ★ 雷點 1：尾斜線不再匹配 ★

```java
@GetMapping("/orders")
public List<Order> list() { }
```

```
Boot 2：GET /orders   → 200 ✅
        GET /orders/  → 200 ✅（自動匹配）

Boot 3：GET /orders   → 200 ✅
        GET /orders/  → ★ 404 ★
```

**為什麼**：Spring Framework 6 把 `setUseTrailingSlashMatch` 的預設值改成 `false`
（而且該方法已 deprecated）。這是刻意的——「同一個資源有兩個 URL」違反 REST 原則，
也對 SEO 與快取不利。

> **真實案例**：某公司的行動 App 有一支 API 呼叫寫成 `/api/v1/orders/`（尾巴有斜線）。
> 升版後所有舊版 App 的訂單列表都拿到 404。
> 因為 App 已經發布到商店，無法立刻修，只能在後端緊急補一個相容層。

**三種解法：**

```java
// ══════════ 解法 A：明確接受兩種（不推薦，等於承認兩個 URL）══════════
@GetMapping({"/orders", "/orders/"})
public List<Order> list() { }
```

```java
// ══════════ 解法 B：恢復舊行為（過渡期用，但方法已 deprecated）══════════
@Configuration
public class LegacyPathConfig implements WebMvcConfigurer {

    @Override
    @SuppressWarnings("deprecation")
    public void configurePathMatch(PathMatchConfigurer configurer) {
        // ⚠️ Spring Framework 6.0 起已 deprecated，未來會移除
        configurer.setUseTrailingSlashMatch(true);
    }
}
```

```java
// ══════════ 解法 C：用 Filter 做 301 轉址（★ 推薦 ★）══════════
package com.example.shop.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 把尾斜線的請求 301 轉到沒有尾斜線的正規網址。
 *
 * <p>為什麼用 301 而不是恢復舊行為：
 * ① 一個資源只有一個正規 URL（對快取與 SEO 都好）
 * ② 有日誌可以追蹤「還有哪些用戶端在用舊格式」，方便決定何時移除
 * ③ 不依賴已 deprecated 的 API
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class TrailingSlashRedirectFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(TrailingSlashRedirectFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        String uri = request.getRequestURI();

        if (uri.length() > 1 && uri.endsWith("/") && !uri.startsWith("/actuator")) {
            String target = uri.substring(0, uri.length() - 1);
            String query = request.getQueryString();
            if (query != null) {
                target = target + "?" + query;
            }

            // ★ 記錄下來，才知道還有誰在用舊格式 ★
            log.info("尾斜線轉址 {} -> {} userAgent={}",
                    uri, target, request.getHeader("User-Agent"));

            response.setStatus(HttpServletResponse.SC_MOVED_PERMANENTLY);
            response.setHeader("Location", target);
            return;
        }
        chain.doFilter(request, response);
    }
}
```

> ⚠️ **301 對 POST 有陷阱**：某些用戶端在收到 301 後會把 POST 改成 GET。
> 如果有 POST 的尾斜線需求，要用 **308 Permanent Redirect**（保留方法與 body）：
> ```java
> response.setStatus(308);
> ```

**怎麼確認自己有沒有中招：**

```bash
# 升版前後比對路由表
$ curl -s localhost:8080/actuator/mappings | jq -r \
    '.contexts.application.mappings.dispatcherServlets.dispatcherServlet[].details.requestMappingConditions.patterns[]?' \
    | sort -u > /tmp/mappings-after.txt
$ diff /tmp/mappings-before.txt /tmp/mappings-after.txt

# 分析既有的存取日誌，找出有多少請求帶尾斜線
$ grep -oE '"(GET|POST|PUT|DELETE) [^"]*/ ' access.log | sort | uniq -c | sort -rn
```

### ★ 雷點 2：`@RequestParam` 報「參數名稱找不到」★

```java
@GetMapping("/orders")
public List<Order> list(@RequestParam String status) {      // 沒寫 value
    return service.findByStatus(status);
}
```

**Boot 3.2 之後可能出現：**

```
java.lang.IllegalArgumentException: Name for argument of type [java.lang.String]
not specified, and parameter name information not available via reflection.
Ensure that the compiler uses the '-parameters' flag.
```

**為什麼**：Spring Framework 6.1 移除了 `LocalVariableTableParameterNameDiscoverer`
（它靠讀 class 檔的 debug 資訊猜參數名稱）。現在只支援**編譯時加了 `-parameters` 旗標**的情況。

**Spring Boot 的 parent POM 有幫你加 `-parameters`**，但如果：

- 你的專案沒有繼承 `spring-boot-starter-parent`（用 BOM，第 00 章 0.9）
- 或公司的父 POM 覆寫了 `maven-compiler-plugin` 設定
- 或用 Gradle 但沒設定

就會中招。

**解法 A：加上編譯旗標**

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <configuration>
        <parameters>true</parameters>        <!-- ★ 這一行 ★ -->
        <compilerArgs>
            <arg>-parameters</arg>
        </compilerArgs>
    </configuration>
</plugin>
```

```gradle
// Gradle
tasks.withType(JavaCompile).configureEach {
    options.compilerArgs << '-parameters'
}
```

**解法 B：明確寫出名稱（★ 更保險 ★）**

```java
@GetMapping("/orders")
public List<Order> list(@RequestParam("status") String status,
                        @RequestParam(value = "page", defaultValue = "0") int page) {
    return service.findByStatus(status, page);
}
```

> **建議做法：兩個都做。**
> 加 `-parameters` 讓現有程式碼能動，
> 同時養成「一律明確寫參數名稱」的習慣——因為那樣連重構改參數名都不會壞。
>
> 這個問題也影響 `@PathVariable`、`@RequestHeader`、`@ConfigurationProperties`
> 的建構子綁定（第 03 章 3.6）。

### 雷點 3：路徑匹配策略

```yaml
# Boot 2.6 之前預設 ANT_PATH_MATCHER，2.6 起預設 PATH_PATTERN_PARSER
spring:
  mvc:
    pathmatch:
      matching-strategy: PATH_PATTERN_PARSER    # Boot 3 的預設值
```

**`PathPatternParser` 的差異：**

| 樣式 | AntPathMatcher | PathPatternParser |
|---|---|---|
| `/orders/**` | ✅ | ✅ |
| `/orders/**/items` | ✅ | ❌ **不支援**（`**` 只能在最後） |
| `/**/orders` | ✅ | ❌ 不支援 |
| `/orders/{id:[0-9]+}` | ✅ | ✅ |
| `/orders/*.json` | ✅ | ⚠️ 行為不同 |
| 效能 | 慢 | **快 6～8 倍** |

**症狀**：啟動時報

```
java.lang.IllegalStateException: Failed to parse pattern "/api/**/orders":
No more pattern data allowed after '**' pattern element
```

**解法**：改掉樣式。

```java
// ❌ PathPatternParser 不支援
@GetMapping("/api/**/orders")

// ✅ 改寫
@GetMapping("/api/{version}/orders")
```

> **不建議退回 `ANT_PATH_MATCHER`**：它已經是 legacy 模式，
> 而且 Spring Security 6 的 `requestMatchers` 也預設用 `PathPatternParser`，
> 兩邊策略不一致會造成「Security 規則對不上實際路由」的安全漏洞。

### 其他較小的 Web 變更

```java
// ① @RequestBody 的 required 行為在某些邊界情況不同，建議明確寫
@PostMapping("/orders")
public Order create(@RequestBody(required = true) @Valid CreateOrderRequest request) { }

// ② HttpMethod 從 enum 變成 class（Spring Framework 6）
// ❌ Boot 2：switch (method) { case GET: ... }
// ✅ Boot 3：
if (HttpMethod.GET.equals(method)) { }

// ③ 錯誤回應預設改用 ProblemDetail（RFC 9457），但要明確開啟
```

```yaml
spring:
  mvc:
    problemdetails:
      enabled: true       # 開啟後預設錯誤回應變成 RFC 9457 格式
```

```json
// 開啟後的錯誤格式（與 Boot 2 完全不同！）
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Invalid request content.",
  "instance": "/orders"
}
```

> ⚠️ **如果前端依賴舊的錯誤格式，開這個開關會打破相容性。**
> 03-rest-api 第 04 章會完整處理錯誤格式設計。**遷移期間建議先不要開。**

---

## 9.9 Hibernate 6 的三個雷點

Boot 3 用 Hibernate 6.x，這是一次**大改版**（不只是 Jakarta 改名）。

### ★ 雷點 1：`@GeneratedValue(strategy = AUTO)` 的行為變了 ★

```java
@Entity
public class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)      // ⚠️ 危險
    private Long id;
}
```

```
Hibernate 5（Boot 2）：
  MySQL → 使用 IDENTITY（AUTO_INCREMENT）

Hibernate 6（Boot 3）：
  MySQL → 使用 SequenceStyleGenerator
       → MySQL 沒有 sequence，所以用一張表模擬
       → ★ 自動建立一張 hibernate_sequence 表 ★
       → 每次 INSERT 前要先查那張表拿號碼（多一次查詢）
       → 而且與既有資料的 AUTO_INCREMENT 值不同步！
```

> **真實案例**：某團隊升版後測試環境正常（因為 `ddl-auto: update` 幫他們建了
> `hibernate_sequence` 表，且資料是新的）。上線到正式環境後：
> - 正式環境 `ddl-auto: validate`，找不到 `hibernate_sequence` 表 → 啟動失敗（還好）
> - 有人手動建了那張表，初始值是 1
> - → 新訂單的 ID 從 1 開始，與既有的 380 萬筆訂單主鍵衝突
> - → `DuplicateKeyException` 大爆發

**解法：一律明確指定 `IDENTITY`（MySQL）**

```java
@Entity
public class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)    // ★ 明確 ★
    private Long id;
}
```

```bash
# ★ 遷移前務必掃一遍所有 Entity ★
grep -rn 'GenerationType.AUTO' src/main/java/
grep -rn '@GeneratedValue' src/main/java/ | grep -v 'IDENTITY\|SEQUENCE\|TABLE\|UUID'
```

> **檢查方式**：升版後在測試環境開 `spring.jpa.show-sql=true`，
> 觀察 INSERT 前有沒有多出 `select next_val from hibernate_sequence` 之類的查詢。
> 有 → 就是中招了。

### ★ 雷點 2：`@Type` 已移除 ★

```java
// ❌ Hibernate 5 的寫法，Hibernate 6 完全移除
@Type(type = "org.hibernate.type.NumericBooleanType")
private boolean active;

@Type(type = "json")
private Map<String, Object> metadata;

@Type(type = "com.example.MyCustomType")
private CustomValue value;
```

**Hibernate 6 的替代方案：**

```java
package com.example.shop.order;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Convert;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.util.Map;

@Entity
public class Order {

    @Id
    private Long id;

    /** ① 布林 → 數字：用 @Convert 或 @JdbcTypeCode */
    @JdbcTypeCode(SqlTypes.INTEGER)
    private boolean active;

    /** ② JSON 欄位：Hibernate 6 原生支援！不用第三方函式庫了 */
    @JdbcTypeCode(SqlTypes.JSON)
    private Map<String, Object> metadata;

    /** ③ 自訂型別：用 AttributeConverter（JPA 標準，不綁 Hibernate） */
    @Convert(converter = MoneyConverter.class)
    private Money amount;

    /** AttributeConverter 是 JPA 標準，換 ORM 也能用 */
    @Converter
    public static class MoneyConverter implements AttributeConverter<Money, String> {
        @Override
        public String convertToDatabaseColumn(Money money) {
            return money == null ? null : money.toString();
        }
        @Override
        public Money convertToEntityAttribute(String text) {
            return text == null ? null : Money.parse(text);
        }
    }
}
```

**`@JdbcTypeCode(SqlTypes.JSON)` 是 Hibernate 6 的一大改善**——
以前要靠 `hibernate-types` 這類第三方函式庫，現在原生支援：

```java
@Entity
public class Product {
    @Id private Long id;

    @JdbcTypeCode(SqlTypes.JSON)
    private ProductSpec spec;                    // 直接映射成 JSON 欄位

    @JdbcTypeCode(SqlTypes.JSON)
    private List<String> tags;

    public record ProductSpec(String color, String size, int weight) { }
}
```

### ★ 雷點 3：HQL / JPQL 語法收緊 ★

```java
// ❌ Hibernate 5 容許，Hibernate 6 拒絕
@Query("SELECT o FROM Order o WHERE o.status = ?")           // 匿名位置參數
@Query("SELECT o FROM Order o WHERE o.customer.name LIKE ?1 AND o.status = ?")  // 混用

// ✅ Hibernate 6：位置參數必須編號
@Query("SELECT o FROM Order o WHERE o.status = ?1")

// ✅ 更好：用具名參數
@Query("SELECT o FROM Order o WHERE o.status = :status")
List<Order> findByStatus(@Param("status") String status);
```

**其他 HQL 變更：**

```java
// ① 隱式 JOIN 的行為更嚴格
// ❌ 可能報錯
@Query("SELECT o FROM Order o WHERE o.customer.address.city = :city")
// ✅ 明確 JOIN
@Query("SELECT o FROM Order o JOIN o.customer c JOIN c.address a WHERE a.city = :city")

// ② 型別推斷更嚴格
// ❌ 回傳型別對不上會在啟動時就報錯（Hibernate 5 是執行時）
@Query("SELECT o.id, o.amount FROM Order o")
List<Order> badQuery();                       // 查的是兩個欄位，卻宣告回傳 Order

// ✅ 用 DTO 投影
@Query("SELECT new com.example.shop.order.OrderSummary(o.id, o.amount) FROM Order o")
List<OrderSummary> findSummaries();

// ③ Session.save() → persist()
// ❌ deprecated
session.save(order);
// ✅
session.persist(order);

// ④ @Where → @SQLRestriction（Hibernate 6.3+）
// ❌
@Where(clause = "deleted = false")
// ✅
@SQLRestriction("deleted = false")
```

> **好消息：型別推斷變嚴格是好事**——很多以前「執行到才爆」的查詢錯誤，
> 現在在**啟動時**就會被抓到（fail fast，第 01 章 1.4 的哲學）。
>
> 所以升版後如果啟動時報一堆查詢錯誤，那是 Hibernate 在幫你找出既有的 bug。

### 檢查清單

```bash
# ① AUTO 生成策略
grep -rn 'GenerationType.AUTO' src/main/java/

# ② @Type
grep -rn '@Type(' src/main/java/

# ③ 匿名位置參數
grep -rn '@Query' src/main/java/ | grep -E '= *\?[^0-9]'

# ④ 已移除的設定
grep -rn 'use-new-id-generator-mappings\|hibernate.id.new_generator' src/main/resources/

# ⑤ 舊的 Hibernate 註解
grep -rn '@Where\|@WhereJoinTable\|session.save(' src/main/java/
```

---

## 9.10 Actuator 與可觀測性

### 端點更名

| Boot 2 | Boot 3 |
|---|---|
| `/actuator/httptrace` | **`/actuator/httpexchanges`** |
| `/actuator/metrics` | 不變 |
| `/actuator/health` | 不變 |
| （無） | `/actuator/sbom`（3.3+，第 08 章） |
| （無） | `/actuator/startup`（2.4+ 就有） |

```java
// httpexchanges 需要自己提供 Repository Bean（預設沒有）
@Configuration
public class ActuatorConfig {

    @Bean
    public org.springframework.boot.actuate.web.exchanges.HttpExchangeRepository httpExchangeRepository() {
        var repo = new org.springframework.boot.actuate.web.exchanges
                .InMemoryHttpExchangeRepository();
        repo.setCapacity(100);
        return repo;
    }
}
```

> ⚠️ **`httpexchanges` 會把請求記在記憶體裡（含標頭）**，
> 正式環境不建議開（記憶體開銷 + 可能記到敏感標頭如 `Authorization`）。

### Sleuth → Micrometer Tracing

```xml
<!-- ❌ Boot 2 -->
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-sleuth</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-sleuth-zipkin</artifactId>
</dependency>

<!-- ✅ Boot 3（第 05 章 5.10）-->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-brave</artifactId>
</dependency>
<dependency>
    <groupId>io.zipkin.reporter2</groupId>
    <artifactId>zipkin-reporter-brave</artifactId>
</dependency>
<!-- 或用 OpenTelemetry -->
<!--
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
-->
```

```yaml
# ❌ Boot 2
spring:
  sleuth:
    sampler:
      probability: 0.1
  zipkin:
    base-url: http://zipkin:9411

# ✅ Boot 3
management:
  tracing:
    sampling:
      probability: 0.1
  zipkin:
    tracing:
      endpoint: http://zipkin:9411/api/v2/spans
```

```java
// 註解也換了套件
// ❌ org.springframework.cloud.sleuth.annotation.NewSpan
// ✅ io.micrometer.tracing.annotation.NewSpan
```

### 日誌樣式的 traceId 佔位符

```yaml
# ❌ Boot 2（Sleuth）
logging:
  pattern:
    level: "%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-}]"

# ✅ Boot 3 一樣可以用 %X{traceId}，因為 Micrometer Tracing 也會寫進 MDC
# 但 Boot 3 提供了內建的佔位符：
logging:
  pattern:
    correlation: "[${spring.application.name:},%X{traceId:-},%X{spanId:-}] "
```

### 指標名稱的變化

| Boot 2 | Boot 3 |
|---|---|
| `http.server.requests` | 不變（但預設 tag 略有調整） |
| `spring.data.repository.invocations` | 不變 |
| `hikaricp.connections.*` | 不變 |
| `management.metrics.export.prometheus.enabled` | `management.prometheus.metrics.export.enabled` |

> **建議：升版後把所有 Grafana 儀表板與 Prometheus 告警規則跑一次**，
> 確認查詢還有資料。「監控壞了但沒人發現」是最危險的狀態（第 05 章）。

---

## 9.11 自訂 starter 與測試相關

### `spring.factories` → `AutoConfiguration.imports`

第 02 章 2.4 已詳述。這裡強調**遷移時的靜默失敗**：

```
❌ Boot 3 完全不讀 spring.factories 裡的 EnableAutoConfiguration
→ 你的自訂 starter 靜靜地不生效
→ 沒有任何錯誤訊息
→ 症狀是「Bean 找不到」，但你想不到是 starter 的問題
```

```bash
# 檢查所有自訂 starter
find . -name 'spring.factories' -exec grep -l 'EnableAutoConfiguration' {} \;
```

```
# 舊：src/main/resources/META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
com.example.audit.autoconfigure.AuditAutoConfiguration

# 新：src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.audit.autoconfigure.AuditAutoConfiguration
```

> ⚠️ **`spring.factories` 沒有完全廢除**——
> 其他 SPI（`ApplicationContextInitializer`、`ApplicationListener`、
> `FailureAnalyzer`、`EnvironmentPostProcessor`）**仍然用 `spring.factories`**。
> 只有「自動組態」這一項搬家了。

### `@ConstructorBinding` 的位置

第 03 章 3.6 已詳述：

```java
// ❌ Boot 2：加在類別上
@ConstructorBinding
@ConfigurationProperties(prefix = "shop")
public class ShopProperties {
    public ShopProperties(String name) { }
}

// ✅ Boot 3：只有一個建構子時完全不用寫
@ConfigurationProperties(prefix = "shop")
public record ShopProperties(String name) { }

// ✅ Boot 3：有多個建構子時，加在要用的那個建構子上
@ConfigurationProperties(prefix = "shop")
public class ShopProperties {
    @ConstructorBinding
    public ShopProperties(String name) { }
    public ShopProperties() { }
}
```

### `@MockBean` → `@MockitoBean`（Boot 3.4）

第 07 章 7.7 已詳述：

```java
// ❌ Boot 3.4 起 deprecated
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.mock.mockito.SpyBean;

// ✅
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
```

```bash
# 全域替換（行為相同，可以直接換）
find src/test -name '*.java' -exec sed -i '' \
  -e 's/org\.springframework\.boot\.test\.mock\.mockito\.MockBean/org.springframework.test.context.bean.override.mockito.MockitoBean/g' \
  -e 's/org\.springframework\.boot\.test\.mock\.mockito\.SpyBean/org.springframework.test.context.bean.override.mockito.MockitoSpyBean/g' \
  -e 's/@MockBean/@MockitoBean/g' \
  -e 's/@SpyBean/@MockitoSpyBean/g' \
  {} +
```

### 部署相關（第 08 章）

```dockerfile
# ❌ Boot 3.1 及之前
ENTRYPOINT ["java", "org.springframework.boot.loader.JarLauncher"]

# ✅ Boot 3.2+
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
```

```bash
# ❌ Boot 3.2 及之前
java -Djarmode=layertools -jar app.jar extract

# ✅ Boot 3.3+
java -Djarmode=tools -jar app.jar extract --layers
```

---

## 9.12 用 OpenRewrite 自動化

**OpenRewrite 可以自動處理約 70% 的機械性修改**（import 改名、註解替換、設定更名）。

```bash
# 一行指令，不用改 pom.xml
./mvnw -U org.openrewrite.maven:rewrite-maven-plugin:run \
  -Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:RELEASE \
  -Drewrite.activeRecipes=org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0
```

或寫進 `pom.xml`（可重複執行，方便 code review）：

```xml
<plugin>
    <groupId>org.openrewrite.maven</groupId>
    <artifactId>rewrite-maven-plugin</artifactId>
    <version>5.42.0</version>
    <configuration>
        <exportDatatables>true</exportDatatables>
        <activeRecipes>
            <recipe>org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0</recipe>
        </activeRecipes>
    </configuration>
    <dependencies>
        <dependency>
            <groupId>org.openrewrite.recipe</groupId>
            <artifactId>rewrite-spring</artifactId>
            <version>5.x.x</version>
        </dependency>
    </dependencies>
</plugin>
```

```bash
# ① 先 dry-run，看它「打算」改什麼（★ 一定要先看 ★）
./mvnw rewrite:dryRun
# 產出：target/rewrite/rewrite.patch

# ② 檢查 patch
less target/rewrite/rewrite.patch

# ③ 確認沒問題再實際套用
./mvnw rewrite:run

# ④ ★ 一定要人工 review diff ★
git diff --stat
git diff
```

### 常用的 recipe

```
org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0    2.7 → 3.0（最大的一步）
org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_1
org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_2
org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_3
org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_4
org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5

org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta   只做 Jakarta 改名
org.openrewrite.java.migrate.UpgradeToJava21                   JDK 升級
org.openrewrite.java.spring.boot2.SpringBootProperties_2_7     設定屬性更名
org.openrewrite.java.testing.junit5.JUnit4to5Migration         JUnit 4 → 5
```

### OpenRewrite 能做與不能做

| 能自動處理 | 需要人工 |
|---|---|
| `javax.*` → `jakarta.*` import | 業務邏輯調整 |
| `WebSecurityConfigurerAdapter` 基本重寫 | 複雜的 Security 設定 |
| `antMatchers` → `requestMatchers` | 多條 filter chain 的順序設計 |
| 設定屬性更名 | Hibernate 的 ID 生成策略決策 |
| `@MockBean` → `@MockitoBean` | 尾斜線的相容策略 |
| 依賴版本升級 | 第三方函式庫換掉（Springfox → Springdoc） |
| `pom.xml` 的 parent 版本 | 資料庫 schema 相關的變更 |

> **一定要人工 review。** OpenRewrite 偶爾會過度改寫
> （例如把 `javax.sql.DataSource` 也改掉，雖然新版已修正這個問題）。
>
> **建議流程**：
> 1. `git checkout -b migrate/boot3`
> 2. `./mvnw rewrite:dryRun` → 看 patch
> 3. `./mvnw rewrite:run` → **單獨 commit**（`chore: OpenRewrite 自動遷移`）
> 4. 人工修剩下的 → 另外 commit
>
> 分開 commit 的價值：出問題時可以快速判斷是「自動改的」還是「人工改的」。

---

## 9.13 遷移實戰：一個真實專案的完整流程

### 專案背景

```
Spring Boot 2.5.14 / JDK 11
120 個 Java 類別，38 個 Entity，24 支 Controller
測試：87 個（覆蓋率 43%）
第三方依賴：Springfox 3.0、QueryDSL 4.4、MyBatis 2.2、Shiro 1.9
```

### 實際執行的時間軸

```
Day 1（4 小時）階段 0：建立安全網
  ├─ 補寫 12 個 API 的契約測試（第 07 章的 @WebMvcTest）
  ├─ 記錄基準：deps / beans / mappings / env
  └─ commit：chore: 遷移前基準

Day 1（1 小時）階段 1：2.5.14 → 2.7.18
  ├─ 改 parent 版本
  ├─ 修 3 個 deprecation
  ├─ 測試全綠
  └─ commit：chore: 升級到 Spring Boot 2.7.18

Day 2（3 小時）階段 2：JDK 11 → 21
  ├─ Lombok 1.18.22 → 1.18.34（★ 花了 1 小時查為什麼編譯失敗 ★）
  ├─ 加 jakarta.xml.bind-api（JAXB 在 JDK 11 已移除）
  ├─ 修 2 處 InaccessibleObjectException
  └─ commit：chore: 升級到 JDK 21

Day 2（2 小時）階段 3：清 deprecation
  ├─ WebSecurityConfigurerAdapter 先改成 SecurityFilterChain（2.7 就支援）
  ├─ spring.factories → AutoConfiguration.imports（自訂 starter 一個）
  └─ commit：refactor: 清除 deprecated 用法

Day 3（1 小時）OpenRewrite
  ├─ dryRun → review patch（480 個檔案變更）
  ├─ 發現它把 javax.sql.DataSource 也改了 → 手動還原 3 處
  ├─ run
  └─ commit：chore: OpenRewrite 自動遷移到 Boot 3.0

Day 3～4（9 小時）★ 手動處理剩下的 ★
  ├─ Springfox → Springdoc（★ 4 小時，最花時間 ★）
  │    ├─ 依賴替換
  │    ├─ 138 個 @Api* 註解改成 OpenAPI 3 註解
  │    └─ 自訂的 Docket 設定重寫
  ├─ QueryDSL 加 jakarta classifier（30 分鐘，但卡了很久才想到）
  ├─ MyBatis starter 2.2 → 3.0（30 分鐘）
  ├─ Shiro → Spring Security（★ 3 小時，架構調整 ★）
  ├─ Hibernate：38 個 Entity 的 GenerationType.AUTO → IDENTITY（1 小時）
  └─ 修 11 個 @Type 註解

Day 5（4 小時）測試與驗證
  ├─ 修 23 個測試（多數是 import 與 mock 行為）
  ├─ ★ 契約測試抓到「尾斜線 404」★ → 加 TrailingSlashRedirectFilter
  ├─ 比對 mappings diff → 確認沒有 API 消失
  ├─ 比對 beans diff → 發現少了 2 個（自訂 starter 的 imports 檔名打錯）
  └─ commit

Day 6（3 小時）階段 5：3.0 → 3.5
  ├─ 3.0.13 → 3.1.12（30 分）
  ├─ 3.1 → 3.2.12（1 小時，★ @RequestParam 參數名稱問題 ★）
  ├─ 3.2 → 3.3.x（30 分，Dockerfile 的 jarmode 改成 tools）
  ├─ 3.3 → 3.4.x（30 分，@MockBean → @MockitoBean）
  └─ 3.4 → 3.5.x（30 分）

Day 7（3 小時）部署驗證
  ├─ Dockerfile 更新（JarLauncher 套件、分層 jarmode）
  ├─ staging 部署 + 冒煙測試
  ├─ 零停機部署驗證（第 08 章 8.7 的腳本）
  └─ Grafana 儀表板檢查（★ 發現 3 個 panel 沒資料，指標名稱改了 ★)

總計：約 30 小時（一個人，一週）
```

### 事後回顧：哪些是意外，哪些可以預防

| 意外 | 花了多久 | 可以預防嗎 |
|---|---|---|
| Springfox 完全不支援 Boot 3 | 4 小時 | ✅ 事前查相容性清單（9.5）就知道 |
| QueryDSL 缺 classifier | 40 分鐘（大半在查） | ✅ 同上 |
| Shiro 要換掉 | 3 小時 | ✅ 同上 |
| 尾斜線 404 | 30 分鐘 | ✅ **契約測試抓到的**（階段 0 的價值） |
| `@RequestParam` 參數名稱 | 40 分鐘 | ✅ 讀過 9.8 就知道 |
| 自訂 starter 的 imports 檔名打錯 | 50 分鐘 | ✅ **beans diff 抓到的** |
| Grafana panel 沒資料 | 30 分鐘 | ✅ 升版後就該檢查監控 |
| Lombok 版本 | 1 小時 | ⚠️ 錯誤訊息很難懂，經驗問題 |

> **最大的教訓：階段 0（建立安全網）花的 4 小時，救回了至少 8 小時。**
> 「尾斜線 404」和「Bean 少了兩個」這兩個問題，
> 如果沒有契約測試與 beans 基準，很可能會**帶到正式環境才發現**。

---

## 9.14 ★ 除錯 SOP 之一：Bean 找不到 ★

```
Parameter 0 of constructor in com.example.shop.order.OrderService required a bean
of type 'com.example.shop.order.OrderRepository' that could not be found.
```

### 決策樹

```
「Bean 找不到」
   │
   ├─ ① 這個 Bean 應該由「誰」提供？
   │     ├─ 我自己寫的類別         → 走 A
   │     ├─ Spring 的自動組態      → 走 B
   │     └─ 第三方 starter        → 走 C
   │
   ├─ A. 我自己寫的類別
   │     │
   │     ├─ A1. 類別上有 stereotype 註解嗎？
   │     │      （@Component / @Service / @Repository / @Configuration）
   │     │      沒有 → 加上去
   │     │
   │     ├─ A2. 它在 @ComponentScan 範圍內嗎？（★ 最常見 ★ 第 01 章 1.6）
   │     │      檢查：這個類別的套件是不是主類別套件的子套件？
   │     │      不是 → 移動類別，或用 scanBasePackages，或寫自動組態
   │     │
   │     ├─ A3. 是介面嗎？有實作類別嗎？實作類別有註解嗎？
   │     │
   │     ├─ A4. 有 @Conditional 嗎？條件成立嗎？
   │     │      檢查：curl /actuator/conditions（第 02 章 2.8）
   │     │
   │     ├─ A5. 有 @Profile 嗎？目前的 profile 對嗎？
   │     │      檢查：curl /actuator/env | jq '.activeProfiles'
   │     │
   │     └─ A6. 是 @Bean 方法嗎？它所在的 @Configuration 有被掃到嗎？
   │
   ├─ B. Spring 的自動組態
   │     │
   │     ├─ B1. 對應的 starter 有加嗎？
   │     │      檢查：./mvnw dependency:tree | grep xxx
   │     │
   │     ├─ B2. scope 對嗎？（provided / test 在執行期看不到）
   │     │
   │     ├─ B3. 自動組態的條件成立嗎？（★ 這裡最有用 ★）
   │     │      curl -s :8081/actuator/conditions | jq \
   │     │        '.contexts.application.negativeMatches | to_entries[]
   │     │         | select(.key|test("Xxx"))'
   │     │      看 notMatched 的訊息：
   │     │        "did not find required class"   → 依賴問題
   │     │        "found beans of type"           → 你自己定義了（正常）
   │     │        "did not find property"         → 設定檔缺屬性
   │     │        "did not find any beans of type XxxAspectSupport"
   │     │                                        → 忘了 @EnableXxx
   │     │
   │     └─ B4. 被 exclude 了嗎？
   │            檢查 @SpringBootApplication(exclude=...) 與
   │                 spring.autoconfigure.exclude
   │
   └─ C. 第三方 / 自訂 starter
         │
         ├─ C1. jar 在 classpath 上嗎？
         │
         ├─ C2. ★ AutoConfiguration.imports 檔案存在且路徑正確嗎？★
         │      unzip -p the-starter.jar \
         │        META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
         │      → 空的或找不到 = 這就是原因（第 02 章 2.13）
         │
         ├─ C3. 這個 starter 支援 Boot 3 嗎？（還在用 spring.factories？）
         │
         └─ C4. 條件成立嗎？（同 B3）
```

### 三個必用的診斷指令

```bash
# ① 這個 Bean 到底在不在容器裡
curl -s localhost:8081/actuator/beans \
  | jq -r '.contexts.application.beans | to_entries[]
           | select(.key|test("order";"i")) | "\(.key)\t\(.value.type)"'

# ② 這個自動組態為什麼沒生效（★ 最有用 ★）
curl -s localhost:8081/actuator/conditions \
  | jq '.contexts.application.negativeMatches | to_entries[]
        | select(.key|test("DataSource"))
        | {name: .key, reasons: [.value.notMatched[].message]}'

# ③ 完整的條件評估報告
java -jar app.jar --debug 2>&1 | sed -n '/CONDITIONS EVALUATION REPORT/,/^$/p'
```

### 用程式列出所有 Bean（沒有 Actuator 時）

```java
package com.example.shop.debug;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

import java.util.Arrays;

/**
 * 除錯用：啟動時列出所有 Bean。
 *
 * <p>用 --shop.debug.print-beans=true 啟動才會執行，
 * 所以可以安全地留在程式碼裡。
 */
@Component
@ConditionalOnProperty(name = "shop.debug.print-beans", havingValue = "true")
public class BeanDumper implements CommandLineRunner {

    private final ApplicationContext context;

    public BeanDumper(ApplicationContext context) {
        this.context = context;
    }

    @Override
    public void run(String... args) {
        String[] names = context.getBeanDefinitionNames();
        Arrays.sort(names);

        System.out.println("═══ 容器內共有 " + names.length + " 個 Bean ═══");
        Arrays.stream(names)
              .filter(n -> !n.startsWith("org.springframework"))
              .forEach(n -> {
                  Class<?> type = context.getType(n);
                  System.out.printf("  %-50s %s%n", n,
                          type == null ? "?" : type.getName());
              });
    }
}
```

---

## 9.15 ★ 除錯 SOP 之二：啟動變慢 ★

### 第一步：分清楚是 JVM 慢還是 Spring 慢

```
Started ShopServiceApplication in 8.221 seconds (process running for 11.503)
                                  ↑                              ↑
                              Spring 啟動時間                 含 JVM 啟動
```

```
差距（11.503 - 8.221 = 3.28 秒）很大（> 2 秒）
  → 問題在 JVM 層：類別載入慢、磁碟慢、沒開 CDS、映像太大
  → 解法：CDS（第 08 章 8.5）、減少依賴、換更快的儲存

Spring 啟動時間（8.221 秒）很大
  → 問題在 Spring 層 → 繼續往下查
```

### 第二步：用 `/actuator/startup` 找出兇手

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.metrics.buffering.BufferingApplicationStartup;

@SpringBootApplication
public class ShopServiceApplication {

    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(ShopServiceApplication.class);
        // ★ 記錄啟動階段的耗時（只在需要診斷時開，有記憶體開銷）★
        app.setApplicationStartup(new BufferingApplicationStartup(8192));
        app.run(args);
    }
}
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: startup
```

```bash
# ⚠️ 是 POST，而且資料只能取一次（取完就清空）
curl -s -X POST localhost:8081/actuator/startup \
  | jq -r '[.timeline.events[]
            | {name: .startupStep.name,
               tags: (.startupStep.tags // [] | map(.value) | join(",")),
               ms: (.duration | ltrimstr("PT") | rtrimstr("S") | tonumber * 1000 | floor)}]
           | sort_by(-.ms) | .[0:20]
           | .[] | "\(.ms)ms\t\(.name)\t\(.tags)"'
```

典型輸出：

```
3412ms  spring.beans.instantiate                  dataSource
1877ms  spring.beans.instantiate                  entityManagerFactory
 892ms  spring.boot.application.starting
 641ms  spring.context.component-scan               com.example
 388ms  spring.beans.instantiate                  flywayInitializer
 211ms  spring.beans.instantiate                  redisConnectionFactory
```

**從這份輸出可以直接讀出：`dataSource` 花了 3.4 秒。**

### 第三步：依症狀對照解法

| 症狀（startup 端點顯示） | 原因 | 解法 |
|---|---|---|
| `dataSource` 很慢 | 資料庫連線慢、DNS 解析慢、`minimum-idle` 太大 | 檢查網路；降低 `minimum-idle`；設 `connection-timeout` |
| `entityManagerFactory` 很慢 | Entity 太多、掃描範圍太寬 | `spring.data.jpa.repositories.bootstrap-mode=deferred` |
| `flywayInitializer` 很慢 | 遷移腳本太多或有慢的 DDL | 合併舊的遷移腳本（baseline） |
| `component-scan` 很慢 | 掃描範圍過寬（第 01 章 1.6） | 縮小 `scanBasePackages` |
| 很多 `spring.beans.instantiate` | Bean 太多 | 移除沒用到的 starter |
| 卡在某個 `@PostConstruct` | 在裡面呼叫外部 API（第 01 章 1.11） | 改用 `ApplicationReadyEvent` |
| `redisConnectionFactory` 慢 | Redis 連不上（在等逾時） | 檢查連線設定 |

### 第四步：其他常見原因

```bash
# ① 掃描範圍過寬
grep -rn 'scanBasePackages\|@ComponentScan' src/main/java/

# ② 有沒有多餘的 starter（★ 常見 ★）
./mvnw dependency:tree | grep 'spring-boot-starter' | sort -u
# 檢查每一個：這個服務真的用到嗎？

# ③ 自動組態生效了幾個
curl -s localhost:8081/actuator/conditions \
  | jq '.contexts.application.positiveMatches | keys | map(select(test("#")|not)) | length'
# 一般服務約 25～45 個；超過 60 個代表載入了很多不需要的東西

# ④ Bean 總數
curl -s localhost:8081/actuator/beans \
  | jq '.contexts.application.beans | keys | length'
# 一般服務 150～400 個
```

### 第五步：如果都查不出來

```bash
# 開啟 Spring 的 TRACE 日誌，看它在做什麼（輸出量很大）
java -jar app.jar \
  --logging.level.org.springframework.boot.autoconfigure=DEBUG \
  --logging.level.org.springframework.context=DEBUG \
  2>&1 | ts -i '%.s' | sort -rn | head -30
# ts 來自 moreutils（brew install moreutils），會在每行前面加上「距上一行的秒數」
```

### 開發環境的加速手段（不要用在正式環境）

```yaml
# application-local.yml（第 03 章 3.10）
spring:
  main:
    lazy-initialization: true        # ⚠️ 只在本機用（第 01 章 1.15）
  jpa:
    hibernate:
      ddl-auto: none
  flyway:
    enabled: false
  data:
    jpa:
      repositories:
        bootstrap-mode: deferred
```

---

## 9.16 除錯 SOP 之三：註解沒生效

**這是第 04 章 4.15 的整理版。** 涵蓋 `@Transactional`、`@Async`、
`@Cacheable`、`@Scheduled`、`@PreAuthorize`、自訂切面。

```
「加了註解但沒作用」
   │
   ├─ ① 有沒有對應的 @EnableXxx？（★ 先查這個，最便宜 ★）
   │     @Transactional  → Spring Boot 自動開啟，不用加
   │     @Async          → @EnableAsync         ← 常忘
   │     @Scheduled      → @EnableScheduling    ← 常忘
   │     @Cacheable      → @EnableCaching       ← 常忘
   │     @PreAuthorize   → @EnableMethodSecurity ← 常忘
   │     @Retryable      → @EnableRetry
   │     自訂切面         → spring-boot-starter-aop + @Aspect + @Component
   │
   │     檢查方式：curl /actuator/conditions | grep AspectSupport
   │              看到 "did not find any beans of type XxxAspectSupport"
   │              → 就是忘了 @EnableXxx（第 05 章練習 3）
   │
   ├─ ② 這個物件是 Spring Bean 嗎？
   │     不是（自己 new 的）→ 註解完全無效
   │
   ├─ ③ 這個 Bean 被代理了嗎？
   │     驗證：AopUtils.isAopProxy(bean)  → false 就是沒被代理
   │           bean.getClass().getName()  → 沒有 $$SpringCGLIB$$ 就是沒被代理
   │
   ├─ ④ 方法的修飾詞對嗎？（第 04 章 4.15）
   │     private   → ❌ CGLIB 無法覆寫
   │     protected → ❌ 同上（且無法從外部呼叫）
   │     final     → ❌ 無法覆寫（★ 而且不會報錯，靜靜失效 ★）
   │     static    → ❌ 不參與多型
   │     public 且非 final → ✅
   │
   ├─ ⑤ 類別是 final 嗎？
   │     是 → 啟動就會報 "Cannot subclass final class"
   │
   ├─ ⑥ ★ 是自呼叫嗎？（this.method()）★  ← 最常見
   │     是 → 代理完全沒機會插手（第 04 章 4.14）
   │     解法：拆到另一個 Bean（首選）
   │
   ├─ ⑦ 有跨執行緒嗎？
   │     @Async / parallelStream / new Thread / CompletableFuture
   │     → 交易、MDC、SecurityContext 全部不會傳遞（第 06 章）
   │
   ├─ ⑧ （@Transactional 專屬）例外處理對嗎？
   │     catch 掉沒重拋           → 交易照常 commit
   │     拋 checked exception     → 預設不 rollback，要 rollbackFor
   │
   ├─ ⑨ 啟動日誌有這行警告嗎？
   │     "not eligible for getting processed by all BeanPostProcessors"
   │     → 那個 Bean 被提早建立，錯過了 AOP 加工（第 01 章 1.12）
   │
   └─ ⑩ （@TransactionalEventListener 專屬）
         發布事件的方法有 @Transactional 嗎？
         沒有 → 監聽者完全不執行，且無錯誤訊息（第 06 章 6.9）
```

### 一段可以直接貼上用的診斷程式碼

```java
package com.example.shop.debug;

import org.springframework.aop.framework.AopProxyUtils;
import org.springframework.aop.support.AopUtils;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Arrays;

/**
 * 診斷「AOP 註解為什麼沒生效」。
 *
 * <p>用 --shop.debug.check-proxies=true 啟動。
 */
@Component
@ConditionalOnProperty(name = "shop.debug.check-proxies", havingValue = "true")
public class ProxyDiagnostics implements CommandLineRunner {

    private final ApplicationContext context;

    public ProxyDiagnostics(ApplicationContext context) {
        this.context = context;
    }

    @Override
    public void run(String... args) {
        System.out.println("═══ AOP 代理診斷 ═══");

        for (String name : context.getBeanDefinitionNames()) {
            Class<?> type;
            Object bean;
            try {
                bean = context.getBean(name);
                type = AopProxyUtils.ultimateTargetClass(bean);
            } catch (Exception e) {
                continue;
            }
            if (type == null || !type.getName().startsWith("com.example.shop")) {
                continue;
            }

            boolean hasAopAnnotation = hasAopAnnotation(type);
            boolean isProxied = AopUtils.isAopProxy(bean);

            // ① 有註解但沒被代理 → 一定有問題
            if (hasAopAnnotation && !isProxied) {
                System.out.printf("❌ %s 有 AOP 註解但「沒有」被代理%n", type.getName());
            }

            // ② 檢查方法修飾詞
            for (Method m : type.getDeclaredMethods()) {
                if (!hasAopAnnotation(m)) {
                    continue;
                }
                int mod = m.getModifiers();
                if (Modifier.isPrivate(mod)) {
                    System.out.printf("❌ %s.%s 是 private，AOP 註解不會生效%n",
                            type.getSimpleName(), m.getName());
                } else if (Modifier.isFinal(mod)) {
                    System.out.printf("❌ %s.%s 是 final，AOP 註解不會生效（且不會報錯）%n",
                            type.getSimpleName(), m.getName());
                } else if (Modifier.isStatic(mod)) {
                    System.out.printf("❌ %s.%s 是 static，AOP 註解不會生效%n",
                            type.getSimpleName(), m.getName());
                } else if (!Modifier.isPublic(mod)) {
                    System.out.printf("⚠️  %s.%s 不是 public，AOP 註解可能不生效%n",
                            type.getSimpleName(), m.getName());
                }
            }

            if (Modifier.isFinal(type.getModifiers()) && hasAopAnnotation) {
                System.out.printf("❌ %s 是 final 類別，無法被 CGLIB 代理%n", type.getName());
            }
        }
        System.out.println("═══ 診斷結束 ═══");
    }

    private static final Class<?>[] AOP_ANNOTATIONS = {
            Transactional.class,
            org.springframework.scheduling.annotation.Async.class,
            org.springframework.scheduling.annotation.Scheduled.class,
            org.springframework.cache.annotation.Cacheable.class,
            org.springframework.cache.annotation.CacheEvict.class,
    };

    private boolean hasAopAnnotation(Class<?> type) {
        return Arrays.stream(AOP_ANNOTATIONS)
                .anyMatch(a -> type.isAnnotationPresent((Class) a))
                || Arrays.stream(type.getDeclaredMethods()).anyMatch(this::hasAopAnnotation);
    }

    private boolean hasAopAnnotation(Method method) {
        return Arrays.stream(AOP_ANNOTATIONS)
                .anyMatch(a -> method.isAnnotationPresent((Class) a));
    }
}
```

> **更好的做法：把這些檢查變成 ArchUnit 測試**（第 04 章 4.18、第 07 章 7.9），
> 讓 CI 在 PR 階段就攔下來，而不是等到執行期靠診斷工具發現。

---

## 9.17 除錯 SOP 之四：升版後行為改變

**症狀：編譯通過、啟動成功、測試也過，但線上行為變了。** 這類最難查。

### 系統性的比對方法

```bash
# ═══ 升版前先錄下基準（階段 0 就要做）═══
BASE=/tmp/boot2
mkdir -p $BASE
curl -s localhost:8080/actuator/beans | jq -r '.contexts.application.beans|keys[]' | sort > $BASE/beans.txt
curl -s localhost:8080/actuator/mappings | jq -r \
  '.contexts.application.mappings.dispatcherServlets.dispatcherServlet[].details.requestMappingConditions.patterns[]?' \
  | sort -u > $BASE/mappings.txt
curl -s localhost:8080/actuator/configprops | jq -S . > $BASE/configprops.json
curl -s localhost:8080/actuator/env | jq -r '.propertySources[].name' > $BASE/propsources.txt
curl -s localhost:8080/actuator/conditions | jq -r '.contexts.application.positiveMatches|keys[]' | sort > $BASE/autoconfig.txt
./mvnw dependency:tree > $BASE/deps.txt

# ═══ 升版後再錄一次並比對 ═══
NEW=/tmp/boot3
# ... 同樣的指令 ...

echo "── Bean 差異 ──"       && diff $BASE/beans.txt      $NEW/beans.txt
echo "── 路由差異 ──"        && diff $BASE/mappings.txt   $NEW/mappings.txt
echo "── 自動組態差異 ──"     && diff $BASE/autoconfig.txt $NEW/autoconfig.txt
echo "── 設定值差異 ──"       && diff <(jq -S . $BASE/configprops.json) <(jq -S . $NEW/configprops.json)
```

**`diff` 的解讀：**

| 差異 | 意義 |
|---|---|
| Bean 少了 | 自動組態沒生效 / starter 沒遷移 / 條件不成立 |
| Bean 多了 | 新的自動組態（通常無害，但要確認不是重複的） |
| 路由少了 | ⚠️ **API 消失了**（Controller 沒被掃到 / 路徑樣式不支援） |
| 自動組態少了 | 檢查 `/actuator/conditions` 的 negativeMatches |
| 設定值變了 | 預設值改變（★ 最容易造成靜默行為改變 ★） |

### Boot 2 → 3 已知的預設值變更

| 設定 | Boot 2 預設 | Boot 3 預設 | 影響 |
|---|---|---|---|
| MVC 尾斜線匹配 | `true` | **`false`** | `/orders/` → 404（9.8） |
| `spring.mvc.pathmatch.matching-strategy` | `ANT_PATH_MATCHER`（2.6 前） | `PATH_PATTERN_PARSER` | `/**/x` 樣式報錯 |
| Hibernate `AUTO` ID 策略 | IDENTITY（MySQL） | **SequenceStyle** | 主鍵衝突（9.9） |
| `spring.jpa.open-in-view` | `true`（有警告） | `true`（仍有警告） | 建議設 `false` |
| `spring.main.allow-circular-references` | `true`（2.6 前） | **`false`** | 循環依賴啟動失敗（第 01 章 1.13） |
| `server.error.include-message` | `always`（2.3 前） | `never` | 錯誤訊息不再回給前端 |
| `spring.jackson.default-property-inclusion` | 無 | 無 | 不變 |
| `management.endpoints.web.exposure.include` | `health,info` | `health` | ⚠️ **`/info` 預設不再開放** |
| Spring Security 密碼編碼 | — | 更嚴格 | `NoOpPasswordEncoder` 已移除 |

> **`management.endpoints.web.exposure.include` 那一項要特別注意**：
> Boot 3 起 `/actuator/info` 預設**不再暴露**。
> 如果你的部署腳本靠 `/actuator/info` 驗證版本（第 08 章 8.10），會失敗。
>
> ```yaml
> management:
>   endpoints:
>     web:
>       exposure:
>         include: health,info,prometheus    # 明確列出
> ```

### 行為變更的驗證清單

```
□ 所有 API 路徑都還在（mappings diff）
□ 尾斜線的請求（分析既有 access log 找出有多少）
□ 錯誤回應格式（前端有沒有依賴 message 欄位）
□ JSON 序列化格式（日期格式、null 欄位、BigDecimal）
□ 資料庫主鍵生成（有沒有出現 hibernate_sequence）
□ 排程任務有沒有全部註冊（/actuator/scheduledtasks，第 06 章）
□ 快取有沒有生效（/actuator/caches）
□ Actuator 端點清單（部署腳本可能依賴某個端點）
□ 指標名稱（Grafana / 告警規則）
□ 日誌格式（日誌平台的解析規則）
□ Security 規則（用整合測試驗證每個角色的權限）
```

### JSON 格式的比對（很常被忽略）

```java
package com.example.shop.contract;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.json.JsonTest;

import java.math.BigDecimal;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * JSON 契約測試：確保升版後序列化格式不變。
 *
 * <p>這種測試在遷移時價值極高——Jackson 的預設行為
 * （日期格式、BigDecimal 精度、null 處理）在版本間可能改變，
 * 而這些改變會直接打破前端。
 */
@JsonTest
class OrderJsonContractTest {

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void 訂單JSON格式不應改變() throws Exception {
        Order order = new Order(1001L, "王小明", new BigDecimal("1280.00"),
                "LINE_PAY", "PAID", Instant.parse("2026-08-18T00:00:00Z"));

        String json = objectMapper.writeValueAsString(order);

        assertThat(json).isEqualTo("""
                {"id":1001,"customerName":"王小明","amount":1280.00,\
                "paymentMethod":"LINE_PAY","status":"PAID",\
                "createdAt":"2026-08-18T00:00:00Z"}""");
        //             ↑ 不是 1755475200.000（timestamp 格式）
        //             ↑ amount 保留兩位小數，不是 1280
    }

    @Test
    void null欄位的處理不應改變() throws Exception {
        Order order = new Order(null, "王小明", null, null, "CREATED", null);
        String json = objectMapper.writeValueAsString(order);

        // 依專案設定（第 02 章的 spring.jackson.default-property-inclusion）
        assertThat(json).doesNotContain("null");
    }
}
```

---

## 9.18 Boot 3.x 各版本的重點

### 3.1

| 新功能 | 說明 |
|---|---|
| **`@ServiceConnection`** | Testcontainers 自動設定連線（第 07 章 7.8） |
| **Docker Compose 支援** | `spring-boot-docker-compose`，開發時自動起容器（第 07 章） |
| SSL Bundle | 統一管理憑證（`spring.ssl.bundle.*`） |
| Micrometer Observation 改良 | |

### 3.2

| 新功能 / 變更 | 說明 |
|---|---|
| **虛擬執行緒** | `spring.threads.virtual.enabled=true`（第 06 章 6.7） |
| **`RestClient`** | 同步的流暢 HTTP 用戶端（取代 `RestTemplate`） |
| **`JdbcClient`** | 流暢的 JDBC API（06-repository 會用到） |
| ⚠️ **`JarLauncher` 套件搬家** | `boot.loader` → `boot.loader.launch`（第 08 章） |
| ⚠️ **`-parameters` 成為必要** | Spring Framework 6.1 移除舊的參數名稱推斷（9.8） |
| SBOM 支援起步 | |

### 3.3

| 新功能 / 變更 | 說明 |
|---|---|
| **`-Djarmode=tools`** | 取代 `layertools`（第 08 章 8.2） |
| **CDS 支援** | `spring.context.exit=onRefresh` + `ArchiveClassesAtExit`（第 08 章 8.5） |
| **`/actuator/sbom`** | SBOM 端點（第 08 章 8.9） |
| 虛擬執行緒改良 | |
| Micrometer 1.13 | |

### 3.4

| 新功能 / 變更 | 說明 |
|---|---|
| **結構化日誌** | `logging.structured.format.console=ecs\|logstash\|gelf`（第 05 章 5.8） |
| **`@MockitoBean` / `@MockitoSpyBean`** | 取代 `@MockBean` / `@SpyBean`（第 07 章 7.7） |
| **`MockMvcTester`** | AssertJ 風格的 MockMvc（第 07 章 7.7） |
| `RestClient` / `RestTemplate` 自動組態調整 | 檢查自訂的 `RestTemplateBuilder` 設定 |
| Bean override 機制（`@TestBean`） | |

### 3.5 及之後

Boot 3.5 延續 3.4 的方向（結構化日誌、可觀測性、native image 支援的完善）。

> **升版建議**：3.x 之間逐版升，每版都跑完整測試。
> 每一版的官方 Release Notes 都有「Upgrading」章節，值得花 15 分鐘讀完。

### 展望：Spring Boot 4 / Spring Framework 7

Spring Boot 4 已經發布。主要方向：

```
□ 模組重構（spring-boot-* 拆得更細，減少不必要的依賴）
□ JSpecify null-safety 標註（編譯期的 null 檢查）
□ 內建宣告式 HTTP 用戶端（@HttpExchange 介面）
□ Spring MVC 的 API 版本控管支援
□ Jackson 3
```

> **實務建議：現在（2026 年）的重點是「把 3.x 做穩」。**
>
> 企業專案絕大多數仍在 3.x，而且 3.x 的支援期還很長。
> Boot 4 的觀念與 3.x 高度延續——這一站學的每一件事
> （IoC、自動組態、AOP、可觀測性、部署）都可以平移。
>
> **等你的專案已經在 3.5 且穩定運行，再評估 4.x。**
> 遷移的原則與這一章完全一樣：逐版升、先建安全網、比對基準。

---

## 9.19 常見錯誤

### ① 直接從 2.5 跳到 3.5

800 個編譯錯誤，無從下手。**逐階段升。**

### ② 用 `sed 's/javax/jakarta/g'` 全域替換

把 `javax.sql.DataSource`、`javax.crypto` 也改掉。**逐套件替換。**

### ③ 沒有測試就開始遷移

不知道自己弄壞了什麼。**先建安全網。**

### ④ 忘了移除 `spring-boot-properties-migrator`

有效能開銷，且掩蓋設定錯誤。

### ⑤ QueryDSL 忘了 `jakarta` classifier

`Q` 類別不產生，錯誤訊息完全不提 classifier。

### ⑥ 自訂 starter 還在用 `spring.factories`

靜默失效，症狀是「Bean 找不到」。

### ⑦ 沒發現尾斜線 404

上線後行動 App 全掛。**用契約測試涵蓋。**

### ⑧ 沒處理 `GenerationType.AUTO`

出現 `hibernate_sequence` 表，主鍵衝突。

### ⑨ 沒有比對 mappings / beans

API 消失、Bean 少了都不會有錯誤訊息。

### ⑩ 忘了檢查監控

指標名稱改了，Grafana 沒資料，「監控壞了但沒人發現」。

### ⑪ 開了 `spring.mvc.problemdetails.enabled` 卻沒通知前端

錯誤格式完全改變，前端解析失敗。

### ⑫ 忘了 `management.endpoints.web.exposure.include` 要加 `info`

Boot 3 起 `/actuator/info` 預設不開放，部署驗證腳本失敗。

### ⑬ OpenRewrite 跑完沒有人工 review

偶爾會過度改寫。**一定要看 diff。**

---

## 9.20 本章練習

### 練習 1：判斷哪些 `javax` 要改

以下 import 哪些要改成 `jakarta`？

```java
import javax.persistence.Entity;
import javax.sql.DataSource;
import javax.validation.constraints.NotNull;
import javax.crypto.Cipher;
import javax.servlet.http.HttpServletRequest;
import javax.annotation.PostConstruct;
import javax.annotation.processing.Processor;
import javax.naming.InitialContext;
import javax.transaction.Transactional;
import javax.net.ssl.SSLSocketFactory;
import javax.xml.bind.JAXBContext;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.management.MBeanServer;
import javax.inject.Inject;
```

<details>
<summary>參考解答</summary>

| import | 要改？ | 理由 |
|---|---|---|
| `javax.persistence.Entity` | ✅ **改** | JPA 是 Jakarta EE |
| `javax.sql.DataSource` | ❌ 不改 | **JDBC 是 Java SE** |
| `javax.validation.constraints.NotNull` | ✅ **改** | Bean Validation 是 Jakarta EE |
| `javax.crypto.Cipher` | ❌ 不改 | JCE 是 Java SE |
| `javax.servlet.http.HttpServletRequest` | ✅ **改** | Servlet 是 Jakarta EE |
| `javax.annotation.PostConstruct` | ✅ **改** | JSR-250，屬於 Jakarta EE |
| `javax.annotation.processing.Processor` | ❌ 不改 | **註解處理器 API 是 Java SE** |
| `javax.naming.InitialContext` | ❌ 不改 | JNDI 是 Java SE |
| `javax.transaction.Transactional` | ✅ **改** | JTA 是 Jakarta EE |
| `javax.net.ssl.SSLSocketFactory` | ❌ 不改 | JSSE 是 Java SE |
| `javax.xml.bind.JAXBContext` | ✅ **改** | JAXB 是 Jakarta EE（且 JDK 11 已從 JDK 移除） |
| `javax.xml.parsers.DocumentBuilderFactory` | ❌ 不改 | **JAXP 是 Java SE** |
| `javax.management.MBeanServer` | ❌ 不改 | JMX 是 Java SE |
| `javax.inject.Inject` | ✅ **改** | JSR-330，屬於 Jakarta |

**8 個不改，6 個要改。**

**特別注意這三組容易搞混的：**

```java
javax.annotation.PostConstruct        → jakarta.annotation.PostConstruct  ✅ 改
javax.annotation.processing.Processor → 不改
javax.annotation.Nullable (JSR-305)  → 不改（沒有 jakarta 版本）

javax.xml.bind.*      → jakarta.xml.bind.*   ✅ 改
javax.xml.parsers.*   → 不改
javax.xml.xpath.*     → 不改
javax.xml.transform.* → 不改
```

**判斷準則**：這個套件是不是隨 JDK 附的？
```bash
# 快速驗證
$ javap javax.sql.DataSource       # 找得到 → Java SE → 不改
$ javap javax.persistence.Entity   # 找不到 → 需要額外依賴 → 要改
```

</details>

### 練習 2：重寫 Security 設定

把以下 Security 5 設定改寫成 Security 6。

```java
@Configuration
@EnableWebSecurity
@EnableGlobalMethodSecurity(prePostEnabled = true)
public class SecurityConfig extends WebSecurityConfigurerAdapter {

    @Autowired
    private JwtFilter jwtFilter;

    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http
            .cors().and()
            .csrf().disable()
            .sessionManagement().sessionCreationPolicy(SessionCreationPolicy.STATELESS)
            .and()
            .authorizeRequests()
                .antMatchers("/auth/login", "/auth/refresh").permitAll()
                .antMatchers("/actuator/health", "/actuator/info").permitAll()
                .antMatchers(HttpMethod.GET, "/products/**").permitAll()
                .antMatchers("/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated()
            .and()
            .exceptionHandling()
                .authenticationEntryPoint(new Http401EntryPoint())
            .and()
            .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);
    }

    @Override
    public void configure(WebSecurity web) {
        web.ignoring().antMatchers("/static/**", "/favicon.ico");
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(12);
    }
}
```

<details>
<summary>參考解答</summary>

```java
package com.example.shop.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.builders.WebSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity                          // ① prePostEnabled 預設 true，不用寫
public class SecurityConfig {                   // ② 不再繼承 WebSecurityConfigurerAdapter

    private final JwtFilter jwtFilter;

    // ③ 改成建構子注入（第 01 章 1.7）
    public SecurityConfig(JwtFilter jwtFilter) {
        this.jwtFilter = jwtFilter;
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            // ④ 全部改成 lambda DSL，不再用 .and()
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(session -> session
                    .sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            // ⑤ authorizeRequests → authorizeHttpRequests
            .authorizeHttpRequests(auth -> auth
                    // ⑥ antMatchers → requestMatchers
                    .requestMatchers("/auth/login", "/auth/refresh").permitAll()
                    .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                    .requestMatchers(HttpMethod.GET, "/products/**").permitAll()
                    .requestMatchers("/admin/**").hasRole("ADMIN")
                    .anyRequest().authenticated())
            .exceptionHandling(ex -> ex
                    .authenticationEntryPoint(new Http401EntryPoint()))
            .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();                    // ⑦ 一定要 build()
    }

    // ⑧ configure(WebSecurity) → WebSecurityCustomizer Bean
    @Bean
    public WebSecurityCustomizer webSecurityCustomizer() {
        return (WebSecurity web) -> web.ignoring()
                .requestMatchers("/static/**", "/favicon.ico");
    }

    /** ⑨ CorsConfigurationSource 建議明確定義，不要依賴預設 */
    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("https://shop.example.com"));   // ★ 不要用 * ★
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Trace-Id"));
        config.setExposedHeaders(List.of("X-Trace-Id"));                 // 第 05 章的追蹤 ID
        config.setAllowCredentials(true);
        config.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(12);
    }
}
```

**九處修改的重點：**

| # | 修改 | 為什麼 |
|---|---|---|
| ① | `@EnableGlobalMethodSecurity(prePostEnabled=true)` → `@EnableMethodSecurity` | 舊註解已移除，新註解的 `prePostEnabled` 預設 true |
| ② | 不再繼承 | `WebSecurityConfigurerAdapter` 已移除 |
| ③ | `@Autowired` 欄位 → 建構子注入 | 順手改善（第 01 章 1.7） |
| ④ | `.and()` → lambda DSL | 舊寫法已 deprecated |
| ⑤ | `authorizeRequests` → `authorizeHttpRequests` | 底層從 `AccessDecisionManager` 改為 `AuthorizationManager` |
| ⑥ | `antMatchers` → `requestMatchers` | 統一 API |
| ⑦ | 回傳 `http.build()` | Bean 方法必須回傳 `SecurityFilterChain` |
| ⑧ | `configure(WebSecurity)` → `WebSecurityCustomizer` | |
| ⑨ | 明確定義 CORS | `.cors()` 不帶參數會找 `CorsConfigurationSource` Bean，沒有的話行為不明確 |

**額外提醒（實務上很重要）：**

`web.ignoring()` 會讓那些路徑**完全跳過 Security filter chain**——
沒有 CSRF 保護、沒有安全標頭、沒有任何檢查。
對靜態資源沒問題，但**不要用它來「開放」API 端點**。

```java
// ❌ 危險：完全跳過 Security，連安全標頭都沒有
web.ignoring().requestMatchers("/api/public/**");

// ✅ 正確：走完整的 chain，只是允許匿名存取
.authorizeHttpRequests(auth -> auth.requestMatchers("/api/public/**").permitAll())
```

</details>

### 練習 3：診斷 Bean 找不到

升版後出現：

```
Parameter 0 of constructor in com.example.shop.order.OrderService required a bean
of type 'com.example.audit.AuditRecorder' that could not be found.
```

`AuditRecorder` 來自公司內部的 `audit-spring-boot-starter`（第 02 章做的那個）。
用 9.14 的 SOP 診斷。

<details>
<summary>參考解答</summary>

**依 SOP 走「C. 第三方 / 自訂 starter」分支：**

#### C1：jar 在 classpath 上嗎

```bash
$ ./mvnw dependency:tree | grep audit
[INFO] +- com.example:audit-spring-boot-starter:jar:1.0.0:compile
[INFO] |  \- com.example:audit-spring-boot-autoconfigure:jar:1.0.0:compile
[INFO] |     \- com.example:audit-core:jar:1.0.0:compile
```
✅ 在。

#### C2：`AutoConfiguration.imports` 存在嗎（★ 最可能的原因 ★）

```bash
$ unzip -l ~/.m2/repository/com/example/audit-spring-boot-autoconfigure/1.0.0/*.jar \
    | grep -i 'imports\|spring.factories'
      112  2024-03-15 10:22   META-INF/spring.factories        ← ★ 只有舊格式！★
```

**找到原因了。** 這個 starter 是 Boot 2 時代做的，只有 `spring.factories`。
**Boot 3 完全不讀 `spring.factories` 裡的 `EnableAutoConfiguration`**，
所以 `AuditAutoConfiguration` 根本沒被載入。

#### 確認：`/actuator/conditions` 裡完全找不到它

```bash
$ curl -s localhost:8081/actuator/conditions \
    | jq -r '.contexts.application | (.positiveMatches, .negativeMatches) | keys[]' \
    | grep -i audit
（沒有輸出）
```

**「完全不在條件報告裡」= 那個類別不在候選清單裡**（第 02 章 2.8 的排查流程 ③）。
如果是「條件不成立」，它會出現在 `negativeMatches` 裡。

#### 修正（在 starter 專案裡）

```
新增檔案：
audit-spring-boot-autoconfigure/src/main/resources/
  META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports

內容：
com.example.audit.autoconfigure.AuditAutoConfiguration
```

**同時要做的其他遷移（這個 starter 也要升到 Boot 3）：**

```xml
<!-- pom.xml -->
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-dependencies</artifactId>
            <version>3.5.0</version>        <!-- 從 2.7.x 升上來 -->
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>
```

```java
// AuditProperties.java：檢查有沒有用到 javax.validation
// ❌ import javax.validation.constraints.NotBlank;
// ✅ import jakarta.validation.constraints.NotBlank;

// AuditAutoConfiguration.java：檢查 @AutoConfiguration 是否用了正確的 API
```

```java
// ★ 順便補上第 02 章 2.12 的測試，避免同樣的問題再發生 ★
class AuditAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AuditAutoConfiguration.class));

    @Test
    void 預設應建立日誌版稽核器() {
        runner.run(context -> assertThat(context).hasSingleBean(AuditRecorder.class));
    }
}
```

> ⚠️ **但注意：上面那個測試「不會」抓到這次的 bug。**
> 因為 `withConfiguration(AutoConfigurations.of(...))` 是**直接指定類別**，
> 繞過了 `AutoConfiguration.imports` 的載入機制。
>
> **要抓到「imports 檔案漏掉」這種問題，需要另一種測試：**

```java
package com.example.audit.autoconfigure;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.annotation.ImportCandidates;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 驗證自動組態「真的被註冊在 imports 清單裡」。
 *
 * <p>★ 這個測試會抓到「imports 檔案漏掉 / 路徑錯 / 類別名稱打錯」★
 */
class AutoConfigurationRegistrationTest {

    @Test
    void AuditAutoConfiguration應出現在imports清單中() {
        var candidates = ImportCandidates.load(
                org.springframework.boot.autoconfigure.AutoConfiguration.class,
                getClass().getClassLoader());

        assertThat(candidates.getCandidates())
                .as("如果失敗，檢查 META-INF/spring/"
                        + "org.springframework.boot.autoconfigure.AutoConfiguration.imports")
                .contains(AuditAutoConfiguration.class.getName());
    }
}
```

**這題的核心教訓：**

「自訂 starter 沒遷移」是 Boot 2 → 3 最容易被漏掉的一項，
因為**它完全靜默失效**——沒有錯誤、沒有警告、不在條件報告裡。
而症狀（「Bean 找不到」）會讓你往「掃描範圍」或「條件」的方向找，
完全想不到是 starter 的問題。

**預防措施：遷移前先列出所有自訂 starter，逐個檢查。**

```bash
# 找出所有可能的自訂 starter
./mvnw dependency:tree | grep -E 'starter' | grep -v 'org.springframework'
```

</details>

### 練習 4：規劃一次遷移

你負責一個服務：Boot 2.4.5 / JDK 8、45 個 Entity、
用了 Springfox 2.9、Shiro 1.5、MyBatis 2.1、Redis、Kafka。
測試 23 個（覆蓋率 12%）。有 3 個實例跑在 K8s。

寫出遷移計畫，包含時間估算與風險。

<details>
<summary>參考解答</summary>

#### 第一步：風險評估（先做，決定要不要現在動）

```
🔴 高風險（會需要重寫）
  ├─ JDK 8 → 17（跨兩個 LTS，可能有大量 API 相容問題）
  ├─ Shiro 1.5 → 必須換成 Spring Security（★ 認證架構重寫 ★）
  ├─ Springfox 2.9 → Springdoc（138+ 註解要改，而且 2.9 更舊，設定差異更大）
  └─ 測試覆蓋率 12%（★ 最大的風險：改壞了不會知道 ★）

🟡 中風險
  ├─ MyBatis 2.1 → 3.0
  ├─ 45 個 Entity 的 GenerationType 檢查
  ├─ Boot 2.4 → 2.7（跨 3 個小版本）
  └─ Kafka client 版本相容性

🟢 低風險
  ├─ Redis 設定更名（spring.redis → spring.data.redis）
  ├─ Actuator 端點與指標名稱
  └─ Dockerfile 更新
```

**結論：這是一次「大型遷移」，不是「升個版本」。**
估計 **5～7 週**（一個人，含補測試）。**不要承諾「兩週搞定」。**

#### 第二步：階段規劃

```
╔══════════════════════════════════════════════════════════════╗
║ 週 1～2：★ 補測試（最重要，不能跳過）★                          ║
╚══════════════════════════════════════════════════════════════╝
目標：覆蓋率 12% → 55%，重點在「契約」而不是「行為細節」

□ 冒煙測試（容器能起來）
□ 每支 Controller 至少一個 @WebMvcTest 契約測試（含 JSON 格式斷言）
□ 每支 API 的權限測試（Shiro → Security 遷移時的安全網）
□ 主要 Repository 的查詢測試（@DataJpaTest + Testcontainers）
□ JSON 序列化契約測試（9.17 的 OrderJsonContractTest）
□ 一個 E2E 測試涵蓋核心流程
□ ★ 尾斜線測試（會在週 4 抓到 404）★

為什麼要 2 週：覆蓋率 12% 意味著幾乎沒有安全網。
             花 2 週補測試，會在後面省下 3 週的除錯與線上事故。

╔══════════════════════════════════════════════════════════════╗
║ 週 3：JDK 8 → 17 + Boot 2.4 → 2.7                            ║
╚══════════════════════════════════════════════════════════════╝
□ Boot 2.4.5 → 2.5 → 2.6 → 2.7.18（逐版，各自 commit）
   ⚠️ 2.6 起循環依賴預設禁止 → 可能要重構（第 01 章 1.13）
   ⚠️ 2.6 起 pathmatch 預設改變 → 檢查路徑樣式（9.8）
□ JDK 8 → 17
   ├─ Lombok / Mockito / ByteBuddy 升版
   ├─ 加 jakarta.xml.bind-api（JAXB 在 JDK 11 移除）
   ├─ 處理 InaccessibleObjectException
   └─ 檢查有沒有用到已移除的 API（sun.misc.Unsafe 等）
□ 清掉所有 deprecation

╔══════════════════════════════════════════════════════════════╗
║ 週 4：Shiro → Spring Security（★ 獨立的一週 ★）                ║
╚══════════════════════════════════════════════════════════════╝
★ 這一步刻意「在 Boot 2.7 上完成」，不要混進 Boot 3 的遷移 ★
理由：認證是最敏感的部分，不要讓「Security 重寫」與
      「Jakarta 改名」的問題混在一起，否則出錯時無法定位。

□ 對照現有的 Shiro Realm / Filter / 權限註解，畫出等價的 Security 設計
□ 實作 UserDetailsService / AuthenticationProvider
□ 實作 SecurityFilterChain（Security 5 的寫法，週 5 再改成 6）
□ @RequiresRoles → @PreAuthorize
□ ★ 逐一驗證每個角色的每個端點權限（用週 1～2 補的權限測試）★
□ staging 部署驗證

╔══════════════════════════════════════════════════════════════╗
║ 週 5：Boot 2.7 → 3.0                                          ║
╚══════════════════════════════════════════════════════════════╝
□ OpenRewrite UpgradeSpringBoot_3_0（dryRun → review → run → 單獨 commit）
□ 人工處理：
   ├─ Jakarta import 的漏網之魚（XML、字串、測試）
   ├─ Security 5 → 6 的 API（antMatchers → requestMatchers 等）
   ├─ 45 個 Entity 的 GenerationType.AUTO → IDENTITY
   ├─ @Type → @JdbcTypeCode / @Convert
   ├─ HQL 位置參數編號
   ├─ MyBatis starter 2.1 → 3.0
   └─ 設定屬性更名（用 properties-migrator 找）
□ 尾斜線相容 Filter
□ 比對 mappings / beans / configprops diff

╔══════════════════════════════════════════════════════════════╗
║ 週 6：Springfox → Springdoc                                    ║
╚══════════════════════════════════════════════════════════════╝
★ 刻意排在最後：它不影響執行期行為，只影響 API 文件 ★
如果時間不夠，可以先上線（暫時沒有 Swagger UI），下個 Sprint 再補。

□ 依賴替換
□ 註解批次改寫（OpenRewrite 有 recipe 可用）
□ 自訂 Docket 設定 → OpenApiCustomizer
□ 驗證產出的 OpenAPI spec 與舊版一致（用 diff 比對 /v3/api-docs）

╔══════════════════════════════════════════════════════════════╗
║ 週 7：3.0 → 3.5 + 部署驗證                                     ║
╚══════════════════════════════════════════════════════════════╝
□ 3.0 → 3.1 → 3.2 → 3.3 → 3.4 → 3.5（逐版，各自跑完整測試）
   ⚠️ 3.2：-parameters 旗標、JarLauncher 套件
   ⚠️ 3.3：jarmode=tools
   ⚠️ 3.4：@MockBean → @MockitoBean
□ Dockerfile 更新（第 08 章）
□ K8s 設定檢查（探針、優雅關閉）
□ 零停機部署驗證（第 08 章 8.7）
□ Grafana / 告警規則檢查（指標名稱）
□ 日誌平台的解析規則檢查
```

#### 第三步：上線策略（★ 不要一次全換 ★）

```
① 影子部署（1 週）
   起 1 個 Boot 3 的 Pod，與 3 個 Boot 2 的 Pod 並存
   → 用 Ingress 權重把 5% 流量導到新版
   → 對照兩邊的錯誤率、延遲、業務指標

② 逐步放量
   5% → 20% → 50% → 100%（每階段觀察 24 小時）

③ 保留回滾能力
   舊版映像不要刪，K8s 的 revisionHistoryLimit 保留 5 個
   kubectl rollout undo 已驗證可用
```

#### 第四步：明確的「不做」清單

```
❌ 不順便重構架構（遷移就只做遷移）
❌ 不順便升級資料庫版本
❌ 不順便換 ORM
❌ 不順便加新功能
❌ 不開啟 spring.mvc.problemdetails（會改變錯誤格式，另案處理）
❌ 不開啟虛擬執行緒（遷移穩定後再評估）
❌ 不改 Jackson 設定（JSON 格式要保持不變）
```

> **這一條清單比計畫本身更重要。**
>
> 遷移最常失敗的原因不是技術困難，而是**範圍蔓延**：
> 「反正都要改了，順便把這個爛設計重構一下吧」
> → 兩件事的問題混在一起
> → 出錯時無法判斷是遷移造成的還是重構造成的
> → 專案拖到三個月，最後被叫停

#### 第五步：風險緩解

| 風險 | 緩解措施 |
|---|---|
| 測試覆蓋率太低 | ★ 週 1～2 先補到 55%，且以契約測試為主 |
| Shiro 遷移改壞權限 | 在 Boot 2.7 上獨立完成 + 逐角色權限測試 + staging 驗證 |
| 主鍵生成策略造成資料損毀 | 45 個 Entity 逐一檢查 + 在**正式資料的副本**上測試 |
| 尾斜線造成 App 掛掉 | 契約測試 + Filter 相容層 + 分析 access log 確認影響範圍 |
| 遷移期間有緊急修 bug 的需求 | 保留 `release/2.x` 分支，可以獨立出版 |
| 時間估計不準 | 每週回顧進度，超過 20% 就重新評估範圍（例如把 Springfox 那週延後） |
| 上線後才發現問題 | 影子部署 + 逐步放量 + 已驗證的回滾流程 |

#### 溝通要點

**跟主管報告時要說清楚三件事：**

1. **這是 5～7 週的工作，不是 2 週**（並解釋為什麼：JDK 跨兩個 LTS、
   Shiro 要換掉、測試覆蓋率只有 12%）。
2. **不做的風險更高**：2.7 已無安全支援，資安稽核會擋，
   下一個 Log4Shell 級別的漏洞我們沒有修補管道。
3. **週 1～2 補測試不是浪費時間**：它是這次遷移能不能安全完成的前提，
   而且測試會留下來，之後每次改動都受益。

</details>

---

## 9.21 驗收清單

- [ ] 我知道 Boot 2.7 已無官方支援，也能說出「不升」的具體風險。
- [ ] **我知道不能直接從 2.x 跳到最新的 3.x，並能說出正確的階段順序。**
- [ ] 我知道階段 0（建立安全網）不能跳過，也知道要記錄哪些基準。
- [ ] 我會用 `/actuator/mappings`、`beans`、`configprops` 做升版前後的 diff。
- [ ] **我能分辨哪些 `javax.*` 要改成 `jakarta.*`，哪些不能改。**
- [ ] 我知道不能用 `sed 's/javax/jakarta/g'` 全域替換。
- [ ] 我知道要檢查 XML、字串、測試程式碼裡的 `javax`。
- [ ] 我能檢查第三方函式庫的 Jakarta 相容性，並知道 Springfox 必須換掉。
- [ ] 我知道 QueryDSL 需要 `jakarta` classifier。
- [ ] 我會用 `spring-boot-properties-migrator` 找出設定屬性更名，也記得事後移除。
- [ ] 我能把 `WebSecurityConfigurerAdapter` 改寫成 `SecurityFilterChain` Bean。
- [ ] 我知道 `authorizeRequests` → `authorizeHttpRequests`、`antMatchers` → `requestMatchers`。
- [ ] 我知道多條 filter chain 需要 `securityMatcher` 與 `@Order`。
- [ ] **我知道 Boot 3 的尾斜線不再匹配，並能用 Filter 做 301/308 轉址。**
- [ ] **我知道 Spring Framework 6.1 需要 `-parameters` 編譯旗標。**
- [ ] 我知道 `PathPatternParser` 不支援 `/**/x` 這種樣式。
- [ ] **我知道 `GenerationType.AUTO` 在 Hibernate 6 會產生 `hibernate_sequence`，且可能造成主鍵衝突。**
- [ ] 我知道 `@Type` 已移除，並會用 `@JdbcTypeCode` / `@Convert` 取代。
- [ ] 我知道 Hibernate 6 的 HQL 位置參數必須編號。
- [ ] 我知道 `/actuator/httptrace` 改名為 `httpexchanges`，且需要自己提供 Repository Bean。
- [ ] 我知道 Sleuth 已被 Micrometer Tracing 取代，設定從 `spring.sleuth.*` 改成 `management.tracing.*`。
- [ ] 我知道自訂 starter 的 `spring.factories` 自動組態必須改成 `AutoConfiguration.imports`，且會靜默失效。
- [ ] 我知道 `@ConstructorBinding` 從類別層級改到建構子層級。
- [ ] 我知道 `@MockBean` → `@MockitoBean`（Boot 3.4）。
- [ ] 我知道 `JarLauncher` 套件在 3.2 搬家、`layertools` 在 3.3 被 `tools` 取代。
- [ ] 我會用 OpenRewrite 自動化機械性修改，並且一定人工 review diff。
- [ ] **我能執行「Bean 找不到」的決策樹。**
- [ ] **我能用 `/actuator/startup` 診斷啟動變慢，並分清楚是 JVM 層還是 Spring 層。**
- [ ] **我能執行「註解沒生效」的十步檢查。**
- [ ] 我能用基準 diff 找出「升版後行為改變」。
- [ ] 我知道 Boot 3 起 `/actuator/info` 預設不再暴露。
- [ ] 我知道遷移最重要的紀律是「不要範圍蔓延」。

---

## 9.22 這一站結業

### 你走過的路

```
00  課程地圖         Spring 到底解決了什麼、啟動流程做了什麼
     ↓
01  IoC 與 DI        ★ 為什麼不要自己 new，Bean 生命週期，代理在哪一步產生
     ↓
02  自動組態         ★ 「加一行依賴就會動」的完整機制，寫自己的 starter
     ↓
03  設定與多環境      ★ 屬性優先序、型別安全綁定、密鑰管理
     ↓
04  AOP 與代理       ★★ 自呼叫失效 —— 所有「註解沒生效」的根源
     ↓
05  日誌與可觀測性    ★ traceId、結構化日誌、指標、健康檢查
     ↓
06  排程/非同步/事件  ★ 三個「預設值會害你」的陷阱
     ↓
07  測試策略         ★ context 快取 —— 讓測試快 10 倍
     ↓
08  打包與部署       ★ 分層、優雅關閉、零停機
     ↓
09  遷移與除錯       ★ 四份 SOP
```

### 如果只能記住十件事

1. **容器裡的 Bean 是「代理」，不是你 `new` 的那個物件**——所有註解都建立在這件事上。
2. **一律建構子注入**——這不是潔癖，是「能不能寫測試」的分界線。
3. **`this.method()` 不經過代理**——`@Transactional`、`@Async`、`@Cacheable`、`@PreAuthorize` 全部失效。
4. **自動組態是有條件的，而且你自己定義的 Bean 一定贏**——`/actuator/conditions` 告訴你為什麼。
5. **設定的優先序：命令列 > `-D` > 環境變數 > 外部檔案 > jar 內檔案**，而且 jar 外的 `application.yml` 贏過 jar 內的 profile 檔案。
6. **密碼絕不進版控**，已外洩的金鑰要作廢而不是只改檔案。
7. **每一行日誌都要有 traceId**，指標的標籤只能是低基數的值。
8. **`@Scheduled` 預設單執行緒、`@Async` 預設佇列無上限**——兩個都要設。
9. **能不啟動 Spring 就不要啟動**，測試 context 的種類要收斂成幾個。
10. **優雅關閉要三層都對**：Spring、容器、K8s。

### 每次遇到問題，先問這五個問題

```
① 這個 Bean 在容器裡嗎？          → /actuator/beans
② 這個自動組態為什麼沒生效？        → /actuator/conditions
③ 這個設定的最終值是什麼、從哪來？   → /actuator/env/<key>
④ 這支 API 在路由表裡嗎？          → /actuator/mappings
⑤ 這個 Bean 被代理了嗎？          → AopUtils.isAopProxy(bean)
```

**這五個端點解決的問題，比讀十篇部落格文章多。**

### 下一站

```
[已完成] 02-spring-boot   框架原理
              ↓
         03-rest-api      介面契約設計（刻意不綁框架）
              ↓
         04/05/06         Controller / Service / Repository 三層實作
              ↓
         07/08            MySQL / JPA / MyBatis
              ↓
         09/10            Spring Security / 期末專題
```

**下一站 [03-rest-api](../03-rest-api/) 會切換視角**：
暫時放下 Spring，先把「一組別人看得懂、改得動、不會一改就破壞相容」的 API 契約設計清楚。
產出是一份 `orders-api.yaml`，之後 04-controller 與 10-capstone 都拿它當實作目標。

> **為什麼要先脫離框架？**
> 因為 API 設計的好壞跟用什麼框架無關。
> 先想清楚「介面該長什麼樣」，再用 Spring 把它實作出來——
> 順序反過來的話，你的 API 會長成「Spring 最容易寫的樣子」，而不是「使用者最好用的樣子」。

---

> ⚠️ 課程中的程式碼與設定已在 JDK 21 + Maven 3.9 + Spring Boot 3.5 上抽出實際編譯與執行驗證，
> 但各版本的行為仍有差異。若你的輸出與課文不符，請以你的環境與該版本的官方 Release Notes 為準。

完成後請前往 [../03-rest-api/](../03-rest-api/)。
