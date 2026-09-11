# 第 00 章：課程地圖、認證與授權的分界

> 前面八站，你把一個訂單服務從無到有蓋完了：
> 03 站定了 API 契約、04 站處理 Web 層、05 站切好交易邊界、
> 06 站設計了埠與轉接器、07 站建好 schema 與索引、08 站把資料層換成 JPA 與 MyBatis。
>
> **這個服務現在有一個問題：任何人都可以呼叫它的任何一支 API。**
>
> 這一站要補的就是那件事。而它難學的原因，用一句話講完是：
>
> > **Spring Security 不是幾個註解，是一整條 Servlet Filter 鏈。**
> > **你寫的每一行設定，最後都變成「這條鏈上有哪些 Filter、順序是什麼」。**
>
> ⚠️ 但這一章開場要講的，不是 Filter 鏈（那是 01 章）。
> 而是兩件在寫任何設定之前就必須先分清楚的事：
>
> **一、「你是誰」跟「你可以做什麼」是兩個問題，兩個時機，兩個狀態碼。**
> **二、Spring Security 只要加進來就已經幫你擋了一堆東西——而它沒幫你擋的那些，才是會出事的。**
>
> 這一章有**六個實測事故**——登入做完了還是讀得到別人的訂單、
> 一句 `permitAll()` 把後台開給全世界、MD5 密碼在 0.3 毫秒內被還原、
> 兩個一模一樣的登入失敗回應差了 22873 倍的時間、
> Filter 裡拋的例外讓前端只看到一個空的 401、
> 登入回應說成功但下一個請求說沒登入——
> **六個事故的 Java 程式碼全部「看起來是對的」，六個都不會讓任何一個測試變紅。**
>
> 📌 所以這一章的順序是刻意的：
> **先把「安全這件事到底在防什麼」講完，再開始教 Spring Security 的任何一個 API。**
> 因為 Spring Security 的設定寫得再熟，你也只是在調整一個「你不知道它在防什麼」的東西。

---

## 0.1 學習目標

完成本章後，你應該可以：

- 用**兩個問題、兩個時機、兩個狀態碼**說清楚認證（authentication）與授權（authorization）的分界，
  並指出實務上最常被漏掉的**第三個問題**（0.4.3：這筆資料是不是你的）。
- 實測分辨 `401` 與 `403`，並說明為什麼「沒帶憑證」跟「憑證錯誤」都是 401
  （0.4.2 實測：四種請求打同一支端點，拿到 `401 / 403 / 200 / 401`）。
- 說出只加一個 `spring-boot-starter-security` 之後，**預設發生了 16 件事**，
  並逐一說明那 16 個 Filter 各自在防什麼（0.5.2）。
- 讀懂預設回應裡的每一個安全標頭，並說明 `X-XSS-Protection: 0` 為什麼是 `0` 而不是 `1`（0.5.3）。
- 實測 session fixation 的防護：**登入前後的 `JSESSIONID` 會換掉，而舊的那個立刻失效**（0.5.4）。
- 說出 Spring Security **預設沒有**幫你擋的六件事，並指出它們分別在本站哪一章補。
- 用**資產 / 入口 / 攻擊者**三欄畫出一個訂單 API 的威脅模型，
  並把 OWASP API Security Top 10 對到本站的章節（0.6）。
- 說明為什麼密碼不能用 MD5 或 SHA-256 存，並用**實測數字**支持這個結論——
  而不是只會講「不安全」（0.7.2：1000 萬筆反查表建好只要 5.4 秒，反查三個帳號 307 µs）。
- 說出 BCrypt / Argon2id / SCrypt 的實測耗時，並用一個明確的判準決定 `cost` 要設多少（0.7.4）。
- 解釋 `{bcrypt}$2a$10$...` 那個前綴是什麼、為什麼它讓你**換演算法不用叫使用者改密碼**（0.7.5、0.7.7）。
- 說出 BCrypt 的 **72 位元組上限**，並解釋為什麼「密碼加長就更安全」在 BCrypt 上有一個上限（0.7.6）。
- 建好本站的基準專案：`pom.xml`、三個帳號三張訂單的固定裝置，
  以及**一個把 Filter Chain 印出來的工具**——它會在接下來九章一直被用到。

---

## 0.2 這一站在整條路線的位置

```
           01-java-core     語言 + JVM + 建置 + 測試（已完成）
                ↓
           02-spring-boot   IoC / DI / 自動組態 / AOP / 設定 / 部署（已完成）
                ↓
           03-rest-api      介面契約設計（已完成，orders-api.yaml）
                ↓
           04-controller    Web 層：接請求、驗參數、回錯誤（已完成）
                ↓
           05-service       商業邏輯層：交易、不變量、快取、非同步（已完成）
                ↓
           06-repository    資料存取層：埠與轉接器、契約測試（已完成）
                ↓
           07-mysql         資料庫本體：建模、索引、鎖、調校、遷移（已完成）
                ↓
           08-jpa-mybatis   兩種存取實作：ORM vs SQL Mapper（已完成）
                ↓
[你在這裡] 09-spring-security ★ 認證與授權：誰在打這支 API、他可以做什麼
                ↓
           10-redis         快取、分散式鎖、限流、Token 撤銷
                ↓
           11-messaging     RabbitMQ 與 Kafka
                ↓
           12-capstone      整合成一個可上線的服務
```

⚠️ **注意這一站的位置**：它在 04（Web 層）與 05（商業邏輯層）**之後**，
而不是「一開始就把 Security 裝好」。

這個順序是刻意的，而且它決定了這一站的教法：

> **你已經有一個會動的服務了。這一站不是「從零開始蓋一個有登入的系統」，**
> **而是「把一個沒有身分概念的服務，改成有身分概念的服務」——**
> **並且在改的過程中，看清楚哪些原本正確的程式碼會因為多了身分而變成漏洞。**

📌 **如果你是跳著讀的**：這一章可以獨立看。
0.3 的六個事故裡有三個會引用前面站台留下的程式碼，看不懂那些引用不影響理解事故本身。

### 0.2.1 前面八站留下的「等 09 站」

前面每一站都在某個地方停下來說「這個要等 09 站」。攤開來看：

| 前面留下的問題 | 它真正在問什麼 | 本站哪一章 |
|---|---|---|
| `@PreAuthorize` 被 `this.` 內部呼叫繞過，「這不是 bug，是**漏洞**」（**02 站** 04 章） | **方法層權限是靠代理實作的，代理有邊界** | 03 |
| `actor()` 先回傳固定字串 `"system"`，「09 站會換成 `SecurityContextHolder`」（**02 站** 04 章 1933 行） | **「現在是誰在操作」這個問題，答案存在哪裡** | **00（0.4）**、01 |
| `@Async` 的執行緒拿不到身分，要用 `DelegatingSecurityContextAsyncTaskExecutor`（**02 站** 06 章） | **身分是綁在執行緒上的** | **01（1.9）** |
| Actuator 端點「第 09 站會詳談」怎麼保護（**02 站** 05 章） | **多條 Filter Chain 怎麼分工** | **01（1.7）** |
| 「找不到使用者時不會做 bcrypt 驗算，回應明顯更快」（**03 站** 02 章 2.8） | **登入失敗的回應要一致到什麼程度** | **00（0.3.4）**、07 |
| 錯誤格式「Spring Security 的 401/403 也要一致」（**04 站** 03 章 3.10.2） | **Filter 產生的錯誤為什麼進不了 `@RestControllerAdvice`** | **00（0.3.5）**、**01（1.8）** |
| CORS：「Security 在 DispatcherServlet 之前，所以 401/403 沒有 CORS 標頭」（**04 站** 06 章） | **Filter 鏈的順序決定了什麼東西看得到什麼** | **01（1.6）**、07 |
| 授權矩陣測試「83 個端點 × 5 種角色 = 415 個組合」（**04 站** 07 章 7.9） | **角色從哪來、規則寫在哪、怎麼驗** | 03、08 |
| 「資源層級授權（IDOR）**不能**用授權矩陣涵蓋」（**04 站** 07 章） | **第三個問題：這筆資料是不是你的** | **00（0.4.3）**、03 |
| 34 個「尚未有任何拋出點」的錯誤碼，屬於認證授權（**05 站** 04 章） | **認證授權的錯誤該長什麼樣** | **00（0.4.4）**、01 |
| 「授權在**進 Service 之前**就做完」（**05 站** 04 章 3607 行） | **授權該放哪一層** | **00（0.4.3）**、03 |

⚠️ **注意這張表的分布**：十一處裡有**五處落在這一章**，
而且五處全部都不是「Spring Security 的語法」——
**全部都是「身分這個東西一旦進入系統，原本的假設就不成立了」**。

> 📌 **這說明了一件事**：
> 加上 Spring Security，**真正會咬你的不是設定寫不出來**，
> 而是「**你原本寫的程式碼裡，有一堆地方預設了『呼叫我的人有權限』**」——
> 那些地方在沒有登入機制的時候是對的，有了登入機制之後全部變成待補的洞。
>
> **這一章的六個事故，全部都是這一句話的實例。**

### 0.2.2 這一站的產出

```
第 00 章  課程地圖：認證 vs 授權、預設擋了什麼、威脅模型、密碼雜湊   ← 你在這裡
第 01 章  架構與 Filter Chain（核心章）：16 個 Filter、多條 chain、SecurityContextHolder
第 02 章  認證機制：UserDetailsService、AuthenticationProvider、表單與 Basic、自訂登入
第 03 章  授權與權限模型：URL 規則、hasRole vs hasAuthority、方法層註解、RBAC 資料表
第 04 章  Session 與無狀態：session 機制、固定攻擊、CSRF 原理與何時可關
第 05 章  JWT 認證（核心章）：結構與簽章、驗證過濾器、refresh、撤銷與黑名單
第 06 章  OAuth2 / OIDC：授權碼流程、第三方登入、Resource Server、帳號綁定
第 07 章  跨來源與常見漏洞：CORS 與 Security 的互動、帳號列舉、暴力破解、安全標頭
第 08 章  稽核與測試：登入 / 權限事件、@WithMockUser、上線前安全檢查清單
```

**結束時你會有**：

```
✅ 一份帶帳號 / 角色 / 權限體系的 shop-service —— 資料表、Entity、UserDetailsService
✅ 一組 JWT 登入與續期的完整實作 —— 含撤銷、含 refresh token 輪替
✅ 一份「端點 × 角色」的授權矩陣，以及讓它變成測試的方法
✅ 一組資源層級授權（這筆訂單是不是你的）的實作與測試 —— 授權矩陣蓋不到的那一半
✅ 一份稽核日誌 —— 誰在什麼時候登入成功、登入失敗、被擋下來
✅ 一份上線前的安全檢查清單，以及一組會在 CI 就紅掉的安全測試
```

### 0.2.3 這一站**不**處理的六件事

⚠️ 這六件事很容易在這裡被順手講掉，但它們各自屬於別的地方：

| 不在這一站 | 在哪裡 | 為什麼分開 |
|---|---|---|
| **攻擊怎麼做**（SQL injection、XSS 的 payload 怎麼寫） | [../../security-course/](../../security-course/) | 那是攻擊者視角；本站是防守方視角，兩者可對照讀 |
| **TLS / HTTPS 憑證怎麼設** | [../../nginx/](../../nginx/) | 傳輸層的事；本站假設 TLS 已經由反向代理處理 |
| **Token 撤銷清單存 Redis** | 10-redis | 本站 05 章講「撤銷需要什麼」，存哪裡是 10 站的事 |
| **限流與暴力破解的分散式實作** | 10-redis 05 章 | 本站 07 章講「為什麼要鎖定」，跨機器的計數在 10 站 |
| **API Gateway 層的認證** | 13-distributed-systems 08 章 | 那是「認證放在哪一層」的架構問題，前提是你已經有多個服務 |
| **Keycloak / Auth0 等 IdP 的建置與維運** | 不在本課 | 本站 06 章教「怎麼當 OAuth2 的 client 與 resource server」，不教怎麼當 IdP |

> ⚠️ **一個要先講清楚的定位**：
>
> **這一站教的是「Spring Security 這個框架」，不是「資訊安全」。**
>
> 兩者的差別在於：資訊安全的範圍包含網路、主機、供應鏈、人；
> 而這一站只處理**一個 Spring Boot 應用程式在收到 HTTP 請求之後，
> 怎麼決定要不要處理它、以及能處理到什麼程度**。
>
> 這個範圍很窄，但它是後端工程師**唯一完全負責**的那一段——
> 防火牆有人管、WAF 有人管、TLS 有人管，
> **「alice 能不能看 bob 的訂單」只有你的程式碼管。**

---

## 0.3 先看見痛：六個「程式碼看起來完全正確」的事故

這六個事故有一個共同點，而且這個共同點就是這一站存在的理由：

> **六段程式碼都通過了 review，都通過了測試，都上線了。**
> **六個問題全部是「有人用了一個你沒想到的方式呼叫它」才出現的。**

📌 六個事故都可以在你自己的機器上跑出來。0.8 有完整的專案設定。

### 0.3.0 六個事故共用的場景

一個訂單服務，三張訂單、三個帳號：

```java
package com.example.lab09.shop;

import java.math.BigDecimal;

public record Order(String id, String ownerUsername, BigDecimal amount, String status) {}
```

```java
package com.example.lab09.shop;

import org.springframework.stereotype.Repository;
import java.math.BigDecimal;
import java.util.*;

@Repository
public class OrderRepo {
    private final Map<String, Order> data = new LinkedHashMap<>();

    public OrderRepo() {
        data.put("1001", new Order("1001", "alice", new BigDecimal("1280.00"),  "PAID"));
        data.put("1002", new Order("1002", "bob",   new BigDecimal("99000.00"), "PAID"));
        data.put("1003", new Order("1003", "bob",   new BigDecimal("350.00"),   "SHIPPED"));
    }

    public Optional<Order> findById(String id) { return Optional.ofNullable(data.get(id)); }
    public List<Order> findAll() { return List.copyOf(data.values()); }
    public List<Order> findByOwner(String owner) {
        return data.values().stream().filter(o -> o.ownerUsername().equals(owner)).toList();
    }
    public void delete(String id) { data.remove(id); }
}
```

> 📌 這裡用一個 `Map` 當資料來源，是為了讓事故的成因只剩下「權限」一個變數。
> 08 站已經教過怎麼把它換成 JPA 或 MyBatis，那不是這一章的重點。

Controller 是這樣寫的——**注意它完全正確**，
每一行都符合 04 站教的 Web 層職責（接請求、回資源、不放商業邏輯）：

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/orders")
@Profile("!own")                     // ← 0.4.3 的 OwnershipAwareController 是這一支的修好版，兩者同路徑
public class OrderController {

    private final OrderRepo repo;
    public OrderController(OrderRepo repo) { this.repo = repo; }

    @GetMapping("/{id}")
    public ResponseEntity<Order> get(@PathVariable String id) {
        return repo.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<Order> list() { return repo.findAll(); }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        repo.delete(id);
        return ResponseEntity.noContent().build();
    }
}
```

還有一支管理端的營收查詢：

```java
package com.example.lab09.shop;

import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
    @GetMapping("/revenue")
    public Map<String, Object> revenue() { return Map.of("total", 100630.00, "orders", 3); }
}
```

三個帳號：

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.*;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;

@Configuration
public class Users {

    @Bean
    PasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(); }

    /** ⚠️ 方法名不能叫 `users` —— 那會跟 @Configuration 類別自己的 bean 名（`users`）撞到，
     *  啟動時直接 BeanDefinitionOverrideException。 */
    @Bean
    UserDetailsService inMemoryUsers(PasswordEncoder enc) {
        return new InMemoryUserDetailsManager(
            User.withUsername("alice").password(enc.encode("pw")).roles("USER").build(),
            User.withUsername("bob").password(enc.encode("pw")).roles("USER").build(),
            User.withUsername("admin").password(enc.encode("pw")).roles("ADMIN").build());
    }
}
```

```
帳號     角色         擁有的訂單
alice   ROLE_USER    1001（1,280 元）
bob     ROLE_USER    1002（99,000 元）、1003（350 元）
admin   ROLE_ADMIN   ——
```

### 0.3.0.1 全站的程式碼命名慣例

本站的程式碼分成兩類，用套件名分開：

```
com.example.lab09.chNN    ← 第 NN 章的【實驗變體】：同一件事的好幾種設定，
                             而且有些是【刻意寫壞的】（例如本章的 S1、S3）
com.example.lab09.shop    ← shop-service 的【成品】：從 02 章開始長，08 章結束
```

⚠️ **不要把 `chNN` 的類別當成建議寫法**——
它們存在的目的是「讓兩種設定的差別變成一個看得到的回應」。
**每一章最後那個「shop-service 落地」小節，才是本站建議的樣子。**

⚠️ **`chNN` 裡的每一個情境都要有自己的 `@Profile`**——這是全站的第二個慣例：

```
@Configuration @Profile("s2")        ← 每一個實驗變體都標一個
class S2_Roles { @Bean SecurityFilterChain chain(...) { … } }
```

**為什麼非標不可**——三種都會讓**整個專案起不來**，而且都不是編譯錯誤：

```
① 同名的 @Bean          chain / passwordEncoder / authenticationManager
                        → BeanDefinitionOverrideException
② 同路徑的 @RestController  同一支端點的「壞版本」與「修好版本」
                        → Ambiguous mapping
③ 沒隔離的 @RestControllerAdvice  @ExceptionHandler(Exception.class) 會蓋掉【整個專案】
                        → 別章的 404 / 403 全變成 500（03 章 3.5.8 就是在講這件事）
```

測試用 `@ActiveProfiles("s2")` 指定要跑哪一個變體
（01 章 1.4.3 的 `f1`～`f4`、02 章 2.1.1 有完整的 profile 對照表）。

📌 **你自己的專案只有一組設定，不需要這樣做。**

還有一個貫穿全站的體例：

**實測輸出的標頭就是節號。** 每一段實測輸出都會印一行 `═══ 節號 標題 ═══`，
所以你看到的輸出可以直接對回課文的哪一節。

### 0.3.1 事故一：登入做完了，alice 還是讀得到 bob 的訂單 ★★

**一個 sprint 的故事。**

PM 說「這個系統要加登入」。你花了半天讀文件，寫出這一段：

```java
package com.example.lab09.ch00;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@Profile("s1")                       // ← 實驗專案要隔離（0.3.0.1）
public class S1_AuthenticatedOnly {

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                   .httpBasic(Customizer.withDefaults())
                   .csrf(c -> c.disable())
                   .build();
    }
}
```

**這段設定做的事，用中文講是：「每一支 API 都要登入才能打。」**
你測了：沒帶帳密 → 401。帶了帳密 → 200。**收工，上線。**

📌 **這段設定沒有任何一行是錯的。** 它做到了它字面上承諾的事。

**實測**（`Http` 工具的完整原始碼在 0.8.3）：

```
═══ 0.3.1 規則只有 anyRequest().authenticated() ═══
  匿名 GET /api/orders/1002                        → 401
  alice GET /api/orders/1001（自己的）                → 200  {"id":"1001","ownerUsername":"alice","amount":1280.00,"status":"PAID"}
  alice GET /api/orders/1002（bob 的）              → 200  {"id":"1002","ownerUsername":"bob","amount":99000.00,"status":"PAID"}
  alice GET /api/orders（全部）                      → 200  [{"id":"1001",…},{"id":"1002",…},{"id":"1003",…}]
  alice DELETE /api/orders/1002（bob 的）           → 204
  alice GET /api/admin/revenue                   → 200  {"orders":3,"total":100630.0}
```

**看第一行跟第二行：完全符合預期。**
**然後看第三行開始。**

```
alice 讀到了 bob 的 99,000 元訂單                     ← 越權讀取
alice 讀到了全公司的訂單清單                            ← 越權列舉
alice 刪掉了 bob 的訂單，回 204 No Content            ← 越權寫入
alice 打開了管理端的營收報表                            ← 越權提權
```

**四件事都成功了，而且伺服器沒有任何一行錯誤日誌。**
從系統的角度看，**這四個請求跟正常請求長得一模一樣**：
帳密正確、身分有效、端點存在、參數合法。

⚠️ **這就是 OWASP API Security Top 10 排名第一的 `API1: Broken Object Level Authorization`**，
俗稱 **IDOR**（Insecure Direct Object Reference）。
它常年排第一的原因，正是因為它**長得不像漏洞**——
沒有 payload、沒有注入、沒有異常流量，只是有人把網址列的 `1001` 改成 `1002`。

**問題出在哪？** 出在這一句設定的中文翻譯：

```java
.anyRequest().authenticated()
```

> **它說的是「要登入」（authenticated），不是「要有權限」（authorized）。**
> **而你以為的「加登入」，PM 以為的「加登入」，其實是「加權限」。**

**這兩件事在 Spring Security 裡是兩個 API、兩個時機、兩個狀態碼**——
那正是 0.4 整節要處理的事。

📌 **而修這個洞需要的東西，比你想的多**：

```
① 「這支端點要什麼角色」        → URL 層規則        → 03 章 3.3
② 「這個方法要什麼權限」        → 方法層註解        → 03 章 3.5
③ 「這筆資料是不是你的」        → 資源層授權        → 03 章 3.8（★ 最難的一層）
```

⚠️ **③ 是授權矩陣測試蓋不到的那一層**（04 站 07 章已經指出過這件事）。
因為授權矩陣問的是「這個角色能不能打這支端點」，
而 IDOR 的答案是「**能打，但只能打屬於他的那幾筆**」——
**角色是對的，資料是錯的。**

### 0.3.2 事故二：「先讓它跑起來」的 `permitAll()`

**這個事故的起點通常是一句話：「開發環境一直要輸入密碼很煩。」**

於是有人寫了：

```java
package com.example.lab09.ch00;

import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@Profile("s3")                       // ← 實驗專案要隔離（0.3.0.1）
public class S3_PermitAll {

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        // TODO: 上線前記得改回來
        return http.authorizeHttpRequests(a -> a.anyRequest().permitAll())
                   .csrf(c -> c.disable())
                   .build();
    }
}
```

**實測**：

```
═══ 0.3.2 anyRequest().permitAll() ═══
  匿名 GET /api/orders                             → 200  [{"id":"1001",…},{"id":"1002",…},{"id":"1003",…}]
  匿名 GET /api/admin/revenue                      → 200  {"orders":3,"total":100630.0}
  匿名 DELETE /api/orders/1001                     → 204
  安全標頭還在嗎: X-Frame-Options=DENY / X-Content-Type-Options=nosniff
```

**注意最後一行。** 這是這個事故最陰險的地方：

> **`permitAll()` 之後，Spring Security 看起來還「在」——**
> **安全標頭照樣送、Filter Chain 照樣跑、`/login` 頁面照樣在。**
> **只有「授權」這一件事被關掉了，而那一件事不會出現在任何回應裡。**

📌 **所以這個 TODO 為什麼會活過上線？**
因為**沒有任何訊號**。啟動日誌不會警告、健康檢查是綠的、
測試不會紅（測試打的是 200，而它確實回 200）、
甚至連手動測試都會「通過」——因為測試的人本來就有權限，他看不出差別。

⚠️ **這一站會給你三個訊號**，讓這件事下次會被抓到：

```
① 啟動時把整條 Filter Chain 印出來（0.8.4）—— permitAll 的 chain 長得不一樣
② 授權矩陣測試（03 章、08 章）—— 「匿名應該拿到 401」是一條會紅的斷言
③ 上線前檢查清單（08 章）—— 用 grep 掃 permitAll / disable 的白名單
```

> **順帶一提**：`permitAll()` 跟 `web.ignoring()` 不一樣，
> 而那個差別會在 01 章 1.7.4 用實測講清楚——**其中一個會讓安全標頭也一起消失。**

### 0.3.3 事故三：密碼用 MD5 存，外洩後 0.3 毫秒全部還原 ★★

**這個事故不需要程式碼，只需要一張表。**

假設你的 `users` 表外洩了（SQL injection、備份檔放錯 bucket、離職員工帶走——
**外洩的原因不重要，重要的是外洩之後會怎樣**）。

表裡的密碼是這樣存的：

```java
package com.example.lab09.ch00;

import java.security.MessageDigest;
import java.util.HexFormat;

public class Md5 {
    public static String md5(String s) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(s.getBytes()));
    }
}
```

三個使用者，三個「符合密碼政策」的密碼：

```
alice | 123456          （弱密碼，但真實世界最常見）
bob   | a1234567        （8 碼、有英文有數字 —— 符合大多數公司的密碼政策）
carol | Taipei2026!     （大小寫 + 數字 + 符號 —— 符合嚴格的密碼政策）
```

**實測**（完整程式碼在 0.7.2）：

```
═══ 0.3.3 外洩的資料表長這樣 ═══
  alice | e10adc3949ba59abbe56e057f20f883e
  bob   | 5690dddfa28ae085d23518a035707282
  carol | d5cfe02a04cd78ea42e7d57339ae83e1

建一張 1000 萬筆的反查表花了: 5443 ms（10000007 筆）

═══ 0.3.3 反查結果 ═══
  alice → 123456
  bob   → a1234567
  carol → Taipei2026!
反查三個帳號花了: 307 µs
```

**三個密碼全部還原。花了 5.4 秒建表、0.3 毫秒查完。**
在一台 MacBook 上，用一段三十行的 Java。

⚠️ 三個數字要看清楚：

| 觀察 | 為什麼致命 |
|---|---|
| **`e10adc3949ba59abbe56e057f20f883e`** | 這是 `123456` 的 MD5。**你可以直接 Google 這個字串**——它在無數個公開的反查表裡 |
| **`carol` 也被還原了** | 她的密碼**完全符合嚴格的密碼政策**。密碼政策防的是「猜」，不防「反查」 |
| **307 µs** | 反查的成本跟密碼強度**無關**，只跟「這個密碼在不在攻擊者的字典裡」有關 |

📌 **為什麼 MD5 這麼快就被反查？**

```
MD5 的設計目標是「快」          → 0.565 µs 一次（實測，0.7.3）
                              → 一秒可以試 176 萬次
同一個密碼永遠雜湊出同一個值      → 可以事先算好，攻擊時只要查表
```

**而 SHA-256 沒有比較好。** 實測（0.7.3）：SHA-256 是 **0.486 µs**，
在 Apple M2 上**比 MD5 還快**（有硬體加速）。
**「MD5 不安全所以改用 SHA-256」是一個常見但沒有解決問題的修法。**

> ⚠️ **這裡有一個很容易搞混的地方**：
> MD5 的問題不只是「碰撞」（collision）。
> 碰撞是「找到兩個不同輸入雜湊出同一個值」，那是簽章的問題；
> **密碼儲存的問題是「快」與「無鹽」**——
> 即使是一個沒有已知碰撞的雜湊，只要它快、而且沒有加鹽，就一樣會被反查。

**正確答案是慢雜湊**（BCrypt / Argon2id / SCrypt），
而且它的效果可以量：同一個 `123456`，用 BCrypt 存，攻擊者每試一個候選要 **69 毫秒**（0.7.2）。

⚠️ **但注意一件事**：`123456` 一定在字典的**前幾個**。
**慢雜湊買到的是時間，不是免死金牌**——
它讓「把整張表都還原」變得不可行，但擋不住「把最弱的那幾個帳號還原」。
**所以密碼政策與慢雜湊是兩件事，兩個都要做。**

📌 完整的密碼儲存討論在 0.7，包含：
四種存法的層次、五種演算法的實測耗時、`cost` 怎麼決定、
以及「換演算法要不要叫使用者改密碼」（0.7.7：不用）。

### 0.3.4 事故四：兩個一模一樣的回應，差了 22873 倍 ★★

03 站 02 章講錯誤設計的時候留了一句話：

> 正確做法：一律回同一個錯誤，且**回應時間也要一致**
> （否則可以用時間差判斷 —— 找不到使用者時不會做 bcrypt 驗算，回應明顯更快）。

**這一節把那個「明顯更快」變成一個數字。**

先看**回應**有沒有洩漏。用 Spring Security 的預設表單登入，
故意打錯密碼、以及故意打一個不存在的帳號：

```
═══ 0.3.4 密碼錯誤 ═══
狀態碼: 302 → http://localhost:57532/login?error
═══ 0.3.4 帳號不存在 ═══
狀態碼: 302 → http://localhost:57532/login?error
```

**一模一樣。** 狀態碼一樣、轉址目標一樣、頁面上的錯誤訊息也一樣。
**從回應內容上完全看不出「這個帳號存不存在」。**

**現在換一個角度：量時間。**

很多人自己寫的登入服務長這樣——**它的邏輯是對的**：

```java
package com.example.lab09.ch00;

import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;

public class NaiveLoginService {

    private static final PasswordEncoder ENC = new BCryptPasswordEncoder();

    private final UserDetailsService uds = new InMemoryUserDetailsManager(
        User.withUsername("alice").password(ENC.encode("pw")).roles("USER").build());

    public boolean login(String username, String rawPassword) {
        UserDetails u;
        try {
            u = uds.loadUserByUsername(username);
        } catch (UsernameNotFoundException e) {
            return false;                                  // ← 查不到人，直接回
        }
        return ENC.matches(rawPassword, u.getPassword());   // ← 只有找得到人才走到這
    }
}
```

**兩條路徑都回 `false`。回傳值一模一樣。**
**但是走過的程式碼不一樣**——一條做了 BCrypt 比對，一條沒有。

**實測**（取 25 次的中位數）：

```
═══ 0.3.4 自己寫的登入服務（兩者都回 false）═══
  帳號【存在】、密碼錯:   68,619 µs
  帳號【不存在】      :        3 µs
  差距                : 22873 倍
```

**68 毫秒 vs 3 微秒。**

⚠️ **這個差距不需要精密儀器就量得到。**
68 毫秒的差距**在網際網路上跨越幾個路由器之後依然清晰可見**——
你不需要 side-channel 專家，用 `curl -w '%{time_total}'` 跑兩次就看得出來。

**攻擊者拿這個做什麼？**

```
拿一份 100 萬筆的 email 清單
對每一筆送出一次「密碼隨便打」的登入請求
回應快的（3 µs 那一類）  → 這個 email 沒有註冊
回應慢的（68 ms 那一類） → ★ 這個 email 有註冊
```

**得到的東西**：一份「確定在你的系統上有帳號」的名單。
這份名單值錢，因為它是後續**撞庫**（credential stuffing）與**釣魚**的輸入。

📌 **現在看 Spring Security 怎麼處理同一件事**：

```java
package com.example.lab09.ch00;

import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;

public class SpringWay {

    private static final PasswordEncoder ENC = new BCryptPasswordEncoder();

    public static DaoAuthenticationProvider provider() {
        UserDetailsService uds = new InMemoryUserDetailsManager(
            User.withUsername("alice").password(ENC.encode("pw")).roles("USER").build());

        DaoAuthenticationProvider p = new DaoAuthenticationProvider();
        p.setUserDetailsService(uds);
        p.setPasswordEncoder(ENC);
        return p;
    }
}
```

**實測**：

```
═══ 0.3.4 Spring Security 的 DaoAuthenticationProvider ═══
  帳號【存在】、密碼錯:   68,649 µs
  帳號【不存在】      :   68,477 µs
  差距                : 1.00 倍
  密碼錯 → BadCredentialsException: 憑證錯誤
  帳號不存在 → BadCredentialsException: 憑證錯誤
  把 hideUserNotFoundExceptions 關掉 → UsernameNotFoundException: nobody
```

**1.00 倍。**

它怎麼做到的？看 `DaoAuthenticationProvider` 的原始碼，關鍵是兩件事：

```
① 找不到使用者時，仍然對一個假的雜湊做一次 BCrypt 比對（dummy password check）
   → 讓兩條路徑的 CPU 工作量一致
② hideUserNotFoundExceptions 預設是 true
   → UsernameNotFoundException 被【換成】 BadCredentialsException 才往外拋
   → 所以你的 @ExceptionHandler 收到的永遠是同一種例外
```

> 📌 **這一節真正的教訓不是「時間差攻擊」**，而是：
>
> **「我自己寫一個登入邏輯，反正就是查一下密碼對不對」——**
> **這句話裡藏了至少三個你不知道自己要處理的問題**
> （時間一致、例外一致、以及 02 章會講的帳號狀態檢查）。
>
> **Spring Security 的價值有很大一部分不在「它幫你做了什麼」，**
> **而在「它幫你避開了你不知道存在的坑」。**

⚠️ 最後一行也很重要：`hideUserNotFoundExceptions` **可以關掉**。
關掉之後例外訊息直接把不存在的帳號名印出來——
而**很多教學為了「除錯方便」會叫你關掉它**。07 章 7.4 會完整處理帳號列舉。

### 0.3.5 事故五：Filter 裡拋例外，前端只看到一個空的 401 ★★

04 站 03 章做了一整章的全域例外處理，最後留了一張表，
其中一列是「Spring Security 的認證／授權失敗，由 `ExceptionTranslationFilter` 處理，**也在外面**」。

**這一節要處理的是「在外面」到底有多外面。**

假設你寫了一個解析 token 的 Filter（**05 章的 JWT filter 就是這個形狀**）：

```java
package com.example.lab09.ch00;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import org.springframework.security.authentication.CredentialsExpiredException;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

public class TokenFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String t = req.getHeader("X-Token");
        if ("boom".equals(t))    throw new IllegalStateException("token 壞掉了");
        if ("expired".equals(t)) throw new CredentialsExpiredException("token 過期");
        chain.doFilter(req, res);
    }
}
```

而你的專案裡有一個全域例外處理（04 站 03 章教的那個）：

```java
package com.example.lab09.ch00;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestControllerAdvice
@Profile("ex")                       // ← 實驗專案要隔離（0.3.0.1）
public class Advice {

    /** ⚠️ 接 Exception 的 advice 會【蓋掉整個專案】的錯誤處理 ——
     *  不隔離的話，03 章資源層那些 404 會全部被它變成 500（03 章 3.5.8 就是在講這件事）。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> any(Exception e) {
        return ResponseEntity.status(500).body(Map.of(
                "handledBy", "@RestControllerAdvice",
                "type",      e.getClass().getSimpleName(),
                "message",   String.valueOf(e.getMessage())));
    }
}
```

**實測**：

```
═══ 0.3.5 Filter 裡拋例外，誰接得到 ═══
  Controller 拋例外                             → 500  {"type":"IllegalStateException","handledBy":"@RestControllerAdvice","message":"controller 壞掉了"}
  Filter 拋 IllegalStateException             → 401
  Filter 拋 CredentialsExpiredException       → 401
```

**Controller 拋的例外，`@RestControllerAdvice` 接到了。**
**Filter 拋的例外，前端收到一個 401，而且 body 是空的。**

⚠️ **這個 401 是哪來的？** 不是任何人寫的。它的來歷是這樣：

```
① TokenFilter 拋例外
② 例外一路往外拋，穿過整條 Security Filter Chain（沒有人接）
③ 穿過 DispatcherServlet（沒進去過，所以 @RestControllerAdvice 沒機會）
④ 到達 Servlet 容器（Tomcat）
⑤ Tomcat 發起一次【ERROR dispatch】，目標是 /error
⑥ /error 這個路徑【也要經過 Security Filter Chain】
⑦ 而你的設定寫的是 anyRequest().authenticated()
⑧ 這次 dispatch 是匿名的 → 401
```

**所以那個 401 的意思其實是「你沒有權限看錯誤頁面」。**
而前端工程師看到的是「打這支 API 有時候會回 401」，
**然後去查 token 為什麼失效——查錯方向，因為根本不是認證的問題。**

**把 `/error` 也放行之後再測一次**：

```java
.requestMatchers("/ex/**", "/error").permitAll()
```

```
═══ 0.3.5 同樣的 filter 例外，但這次 /error 也 permitAll ═══
  Filter 拋 IllegalStateException             → 500  {"timestamp":"…","status":500,"error":"Internal Server Error","path":"/ex/ok"}
  Filter 拋 CredentialsExpiredException       → 500  {"timestamp":"…","status":500,"error":"Internal Server Error","path":"/ex/ok"}
```

**500 了，但注意 body**：那是 **Spring Boot 預設的 `/error` 格式**，
**不是 `@RestControllerAdvice` 產的**（沒有 `handledBy` 欄位）。

> 📌 **結論一**：**Filter 拋的例外永遠不會進 `@RestControllerAdvice`。**
> 不管你把 `/error` 放不放行，那個 advice 都沒有機會執行。
> 原因是它掛在 `DispatcherServlet` 上，而 Filter 在 `DispatcherServlet` 外面。

**第三個變體**：把同一個 Filter 移到 `ExceptionTranslationFilter` **之後**
（也就是讓 `ExceptionTranslationFilter` 包住它）：

```java
.addFilterBefore(new TokenFilter(), AuthorizationFilter.class)   // 原本是 BasicAuthenticationFilter.class
```

```
═══ 0.3.5 把自訂 filter 移到 ExceptionTranslationFilter【之後】═══
  Filter 拋 IllegalStateException             → 500  {"…","status":500,"error":"Internal Server Error","path":"/ex/ok"}
  Filter 拋 CredentialsExpiredException       → 401  {"…","status":401,"error":"Unauthorized","path":"/ex/ok"}
```

**同一個 Filter，同一段程式碼，只是換了位置——`CredentialsExpiredException` 從 500 變成 401。**

> 📌 **結論二**：`ExceptionTranslationFilter` 只接**它下游**丟上來的例外，
> 而且只接兩種：`AuthenticationException` 與 `AccessDeniedException`。
> **你的自訂 Filter 放在它上游，它就看不到。**

⚠️ **這三個變體就是 01 章存在的理由**：

```
同一段程式碼 × 三個位置 = 三種行為
而「位置」這件事，在你的設定檔裡只是一個方法名（addFilterBefore 的參數）
```

**看不懂 Filter Chain 的順序，就沒辦法預測自己的程式碼會發生什麼。**
01 章會把那 16 個 Filter 一個一個攤開。

### 0.3.6 事故六：登入回應說成功，下一個請求說沒登入

**這個事故只在 Spring Security 6 上發生，而且它是升級 Boot 3 的常客。**

一段從 Spring Security 5 帶過來的手寫登入端點：

```java
package com.example.lab09.ch00;

import org.springframework.context.annotation.Profile;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.*;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@Profile("sc5")                      // ← 實驗專案要隔離（0.3.0.1）
public class ManualLoginV5 {

    private final AuthenticationManager am;
    public ManualLoginV5(AuthenticationManager am) { this.am = am; }

    @PostMapping("/sc/login")
    public Map<String, Object> login(@RequestParam String username, @RequestParam String password) {
        Authentication auth = am.authenticate(
                new UsernamePasswordAuthenticationToken(username, password));

        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(auth);
        SecurityContextHolder.setContext(ctx);

        return Map.of("loggedInAs", auth.getName());
    }
}
```

**這段程式碼在 Spring Security 5 上是對的。** 在 6 上，實測：

```
═══ 0.3.6 只設 SecurityContextHolder（Spring Security 5 的寫法）═══
  POST /sc/login                     → 200  {"loggedInAs":"alice"}
  拿到的 cookie: null
  帶著 cookie GET /sc/whoami           → 200  {"authentication":"anonymousUser / AnonymousAuthenticationToken"}
  帶著 cookie GET /sc/secret           → 401
```

**登入回 200，說「loggedInAs: alice」。**
**然後 `Set-Cookie` 是 `null`——根本沒有建立 session。**
**下一個請求的身分是 `anonymousUser`。**

⚠️ **這個事故的症狀特別難查，因為登入端點回的是 200。**
前端工程師會說「登入成功了啊，你看回應」，
後端工程師會說「你沒帶 cookie」，
**而真相是後端根本沒有發 cookie。**

**Spring Security 6 改了什麼？**

```
5.x：SecurityContextPersistenceFilter
     → 請求結束時【自動】把 SecurityContextHolder 裡的東西存回 session

6.x：SecurityContextHolderFilter
     → 只負責【載入】，不負責存
     → 要存必須自己呼叫 SecurityContextRepository.saveContext(...)
```

**這個改動是刻意的**（官方稱為 "explicit save"），
理由是舊行為會在每個請求結束時都去讀寫 session，
即使那個請求根本沒有改過身分——對無狀態 API 來說是純粹的浪費。

**修法是多一行**：

```java
package com.example.lab09.ch00;

import jakarta.servlet.http.*;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.*;
import org.springframework.context.annotation.Profile;
import org.springframework.security.web.context.*;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@Profile("sc6")                      // ← 跟 V5 是【同一個路徑】，兩者不能同時在（0.3.0.1）
public class ManualLoginV6 {

    private final AuthenticationManager am;
    private final SecurityContextRepository repo = new HttpSessionSecurityContextRepository();

    public ManualLoginV6(AuthenticationManager am) { this.am = am; }

    @PostMapping("/sc/login")
    public Map<String, Object> login(@RequestParam String username, @RequestParam String password,
                                     HttpServletRequest req, HttpServletResponse res) {
        Authentication auth = am.authenticate(
                new UsernamePasswordAuthenticationToken(username, password));

        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(auth);
        SecurityContextHolder.setContext(ctx);
        repo.saveContext(ctx, req, res);        // ★ 6.x 少了這一行就不會記住

        return Map.of("loggedInAs", auth.getName());
    }
}
```

```
═══ 0.3.6 多呼叫一次 repo.saveContext(...) ═══
  POST /sc/login                     → 200  {"loggedInAs":"alice"}
  拿到的 cookie: JSESSIONID=807E311F57D1B857A045B1EA0A02E8E4
  帶著 cookie GET /sc/whoami           → 200  {"authentication":"alice / UsernamePasswordAuthenticationToken"}
  帶著 cookie GET /sc/secret           → 200  {"secret":42}
```

> 📌 **順帶一提，這段程式碼還踩到第二個 6.x 的改動**：
> `AuthenticationManager` **不再自動註冊成 bean**。
> 直接 `@Autowired` 會拿到：
>
> ```
> Parameter 0 of constructor in ...ManualLoginV6 required a bean of type
> 'org.springframework.security.authentication.AuthenticationManager' that could not be found.
> ```
>
> 要自己拿出來——**上面兩個 `ManualLogin*` 少了這個類別就起不來**：
>
> ```java
> package com.example.lab09.ch00;
>
> import org.springframework.context.annotation.*;
> import org.springframework.security.authentication.AuthenticationManager;
> import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
>
> @Configuration
> @Profile("sc5 | sc6")
> public class ManualLoginAuthManager {
>
>     @Bean
>     AuthenticationManager authenticationManager(AuthenticationConfiguration cfg) throws Exception {
>         return cfg.getAuthenticationManager();
>     }
> }
> ```
>
> 02 章 2.6 會解釋為什麼它預設不是 bean。

### 0.3.7 六個事故的共同形狀

把六個攤在一起：

| # | 事故 | 程式碼哪裡錯了 | 真正的成因 |
|---|---|---|---|
| 1 | alice 讀得到 bob 的訂單 | **沒有錯** | 「登入」與「授權」是兩件事（0.4） |
| 2 | `permitAll()` 活到上線 | 一個 TODO | **關掉授權沒有任何訊號**（0.8.4 補訊號） |
| 3 | MD5 密碼 0.3 ms 被還原 | 用了「一個雜湊函式」 | 密碼要的是**慢**，不是**雜湊**（0.7） |
| 4 | 登入回應一致但時間差 22873 倍 | **邏輯完全正確** | 安全性不只看回傳值，還看**執行路徑**（0.3.4） |
| 5 | Filter 例外變成空的 401 | 位置放錯 | Filter Chain 的**順序**決定行為（01 章） |
| 6 | 登入成功但沒建立 session | 是 5.x 的正確寫法 | 6.x 把隱式行為改成**顯式**（01 章 1.5） |

**六個事故裡，只有一個（#3）是「知識點錯了」。**
**其他五個都是「你以為框架會幫你做某件事，而它沒有」或者「你以為它不會，而它會」。**

> 📌 **這就是這一站的核心方法**：
>
> **不要問「Spring Security 這個 API 怎麼用」，要問「一個請求進來之後，發生了哪些事」。**
> **前者是查文件就有的，後者是這一站要教的。**
>
> 而「發生了哪些事」在 Spring Security 裡有一個非常具體的答案：
> **那條 Filter Chain 上的每一個 Filter，依序做了什麼。**
> **那就是 01 章。**

---

## 0.4 認證 vs 授權：兩個問題，兩個時機，兩個狀態碼 ★★

### 0.4.1 一句話定位

```
認證 Authentication   「你是誰？」        → 驗證身分       → 失敗回 401
授權 Authorization    「你可以做什麼？」   → 檢查權限       → 失敗回 403
```

**英文縮寫常寫成 AuthN 與 AuthZ**（最後一個字母不一樣），
中文常常兩個都叫「權限」，那正是混淆的來源。

用一個生活化的對照：

| | 認證 | 授權 |
|---|---|---|
| 現實世界 | 出示身分證 | 這張票能不能進 VIP 區 |
| 問的問題 | 你是誰 | 你能做什麼 |
| 需要的東西 | 憑證（密碼 / token / 憑證） | 規則（角色 / 權限 / 擁有關係） |
| 誰負責 | `AuthenticationManager` | `AuthorizationManager` |
| 在 Filter Chain 的位置 | 前面（`BasicAuthenticationFilter` 等） | **最後一個**（`AuthorizationFilter`） |
| 失敗的處理者 | `AuthenticationEntryPoint` | `AccessDeniedHandler` |
| HTTP 狀態碼 | **401 Unauthorized** | **403 Forbidden** |
| 一句話 | 沒登入 / 登入失敗 | 登入了，但不夠格 |

⚠️ **HTTP 規格的命名是反直覺的**：

```
401 Unauthorized  ← 名字寫「未授權」，意思其實是「未【認證】」
403 Forbidden     ← 這個才是「已認證但未授權」
```

**RFC 9110 自己承認了這件事**：401 的定義是
"the request has not been applied because it lacks valid authentication credentials"——
**缺的是「認證憑證」**。名字是 HTTP/1.0 留下來的歷史包袱。

📌 **記法**：`401` 的伴隨標頭是 `WWW-Authenticate`（0.5 有實測），
那個標頭在說「請提供憑證」——**所以 401 = 缺憑證**。

### 0.4.2 實測：401 與 403 的分界

把 0.3.1 那份設定加上角色規則：

```java
package com.example.lab09.ch00;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@Profile("s2")                       // ← 實驗專案要隔離（0.3.0.1）
public class S2_Roles {

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .requestMatchers("/api/hello").permitAll()
                    .anyRequest().authenticated())
                   .httpBasic(Customizer.withDefaults())
                   .csrf(c -> c.disable())
                   .build();
    }
}
```

**實測**（帳號來自 0.3.0：alice 是 `ROLE_USER`、admin 是 `ROLE_ADMIN`）：

```
═══ 0.4.2 /api/admin/** 要 ROLE_ADMIN ═══
  匿名 GET /api/admin/revenue                      → 401
  alice(USER) GET /api/admin/revenue             → 403  {"timestamp":"…","status":403,"error":"Forbidden","path":"/api/admin/revenue"}
  admin(ADMIN) GET /api/admin/revenue            → 200  {"orders":3,"total":100630.0}
  密碼打錯 GET /api/admin/revenue                    → 401
  匿名 GET /api/hello（permitAll）                   → 200  {"msg":"hello"}
  匿名 GET /api/orders/1001                        → 401
```

**六行輸出，把兩個概念的分界完整畫出來了**：

| 請求 | 結果 | 為什麼 |
|---|---|---|
| 匿名打 admin 端點 | **401** | 連你是誰都不知道 → 認證失敗 |
| alice 打 admin 端點 | **403** | 知道你是 alice，但 alice 不是 ADMIN → 授權失敗 |
| admin 打 admin 端點 | 200 | 兩關都過 |
| **密碼打錯**打 admin 端點 | **401** | ⚠️ 不是 403 —— 憑證錯誤是**認證**失敗 |
| 匿名打 `permitAll` 端點 | 200 | 授權規則說「不需要任何條件」 |
| 匿名打一般端點 | 401 | 認證失敗 |

⚠️ **第四行是最常被搞錯的**：

> **「帳號存在但密碼打錯」是 401，不是 403。**
>
> 因為系統**沒有成功建立你的身分**——它不知道打這支請求的是不是 admin 本人。
> 403 的前提是「我確定你是誰，而那個人不夠格」。

📌 **注意 401 與 403 的 body 不一樣**：

```
401 → body 是【空的】（content-length: 0）
403 → body 是 Boot 的預設錯誤 JSON
```

這個不一致是有原因的，而且 01 章 1.8 會解釋：
**它們走的是兩條不同的路**——401 由 `AuthenticationEntryPoint` **直接寫回應**，
403 由 `AccessDeniedHandler` 交給容器做 ERROR dispatch 到 `/error`。

**要讓兩者格式一致**（04 站 03 章要求的事），要自己接管兩個介面：

```java
package com.example.lab09.ch00;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.*;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.SecurityFilterChain;

import java.io.IOException;
import java.time.Instant;
import java.util.Map;

@Configuration
@Profile("s2e")                      // ← 實驗專案要隔離（0.3.0.1）
public class UnifiedErrorFormat {

    private static final ObjectMapper OM = new ObjectMapper();

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .anyRequest().authenticated())
                   .csrf(c -> c.disable())
                   .httpBasic(Customizer.withDefaults())
                   .exceptionHandling(e -> e
                        .authenticationEntryPoint(UnifiedErrorFormat::write401)
                        .accessDeniedHandler(UnifiedErrorFormat::write403))
                   .build();
    }

    static void write401(HttpServletRequest req, HttpServletResponse res,
                         AuthenticationException ex) throws IOException {
        body(res, 401, "UNAUTHENTICATED", "請先登入", req);
    }

    static void write403(HttpServletRequest req, HttpServletResponse res,
                         AccessDeniedException ex) throws IOException {
        body(res, 403, "FORBIDDEN", "你的角色不能做這件事", req);
    }

    static void body(HttpServletResponse res, int status, String code, String msg,
                     HttpServletRequest req) throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        res.setCharacterEncoding("UTF-8");
        OM.writeValue(res.getOutputStream(), Map.of(
                "timestamp", Instant.now().toString(),
                "status",    status,
                "code",      code,
                "message",   msg,
                "path",      req.getRequestURI()));
    }
}
```

```
═══ 0.4.2 換成自訂的 entryPoint / accessDeniedHandler ═══
  匿名打要登入的端點      → 401  {"path":"/api/orders/1001","status":401,"code":"UNAUTHENTICATED","message":"請先登入","timestamp":"2026-09-10T03:44:07.198707Z"}
  alice 打 admin 端點    → 403  {"path":"/api/admin/revenue","status":403,"code":"FORBIDDEN","message":"你的角色不能做這件事","timestamp":"2026-09-10T03:44:07.346497Z"}
```

⚠️ **注意這兩個介面都是函式介面（可以用 lambda / method reference）**，
而且它們拿到的是**原始的 `HttpServletResponse`**——
**不是 `ResponseEntity`，沒有 Jackson 的自動序列化，沒有 `@RestControllerAdvice`。**
你在 04 站建的那一整套錯誤格式基礎設施，**在這裡一個都用不到**。

📌 完整的「讓 Filter 層與 Controller 層的錯誤格式一致」在 01 章 1.8.5。

### 0.4.3 第三個問題：這筆資料是不是你的

0.3.1 那個事故，用 0.4.2 的做法**修不好**。

**為什麼？** 因為授權規則寫的是「路徑 → 角色」：

```java
.requestMatchers("/api/admin/**").hasRole("ADMIN")
.anyRequest().authenticated()
```

而 alice 與 bob 的角色**一模一樣**（都是 `ROLE_USER`），
路徑也**一模一樣**（`/api/orders/{id}`）。
**規則層面沒有任何資訊可以區分「這是 alice 的訂單」還是「bob 的訂單」。**

> 📌 **所以授權其實有三層，而不是兩層**：

```
① URL 層     「這個【路徑】要什麼角色」          .requestMatchers(...).hasRole(...)
                → 在 Filter Chain 裡做，Controller 還沒被呼叫
                → 03 章 3.3

② 方法層     「這個【方法】要什麼權限」          @PreAuthorize("hasAuthority('ORDER_READ')")
                → 在 Service / Controller 的方法上做，靠 AOP 代理
                → 03 章 3.5

③ 資源層     「這【筆資料】是不是你的」          order.ownerUsername().equals(currentUser)
                → 必須把資料撈出來才知道
                → 03 章 3.8   ★ 最難的一層
```

⚠️ **③ 難在三個地方**：

| 難點 | 為什麼 |
|---|---|
| **它需要資料** | 前兩層看請求就能判斷，第三層必須先查資料庫 |
| **它藏在商業邏輯裡** | 「訂單的擁有者」是領域概念，不是 Web 概念 |
| **它不能用矩陣測** | 授權矩陣是「端點 × 角色」，而這一層是「同一個角色的不同使用者」 |

📌 **05 站 04 章曾經寫過一行註解**：

```java
// ★ 授權在【進 Service 之前】就做完（09-spring-security 的 @PreAuthorize）
```

**那句話對①②成立，對③不成立。**
第三層的檢查點通常在 Service **裡面**（撈完資料之後、回傳之前），
或者用 `@PostAuthorize` 在方法回傳後檢查——
而 `@PostAuthorize` 有一個代價（方法已經執行完了），
03 章 3.8 會用實測比較四種做法。

**先給一個能用的形狀**（03 章會展開）：

```java
package com.example.lab09.ch00;

import org.springframework.context.annotation.Profile;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

import com.example.lab09.shop.Order;
import com.example.lab09.shop.OrderRepo;

@RestController
@RequestMapping("/api/orders")
@Profile("own")                      // ← 它跟 0.3.0 那支 OrderController 是【同一個路徑】的兩個版本（0.3.0.1）
public class OwnershipAwareController {

    private final OrderRepo repo;
    public OwnershipAwareController(OrderRepo repo) { this.repo = repo; }

    @GetMapping("/{id}")
    public Order get(@PathVariable String id) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String me = auth.getName();

        Order order = repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));

        boolean admin = auth.getAuthorities().stream()
                .anyMatch(g -> g.getAuthority().equals("ROLE_ADMIN"));

        if (!admin && !order.ownerUsername().equals(me)) {
            // ⚠️ 回 404 而不是 403 —— 理由見下面
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return order;
    }
}
```

⚠️ **注意最後那個 404**。這是資源層授權的一個經典取捨：

```
回 403「你沒有權限看這筆訂單」  → 洩漏了「訂單 1002 存在」這件事
回 404「找不到這筆訂單」        → 不洩漏，但錯誤訊息對合法使用者比較不友善
```

**訂單 id 通常是可枚舉的**（`1001`、`1002`、`1003`），
所以回 403 等於送給攻擊者一份「哪些 id 有資料」的地圖。
07 站 01 章那個 **UUIDv7 主鍵**在這裡多了一個好處：**id 猜不到**。

📌 **本課的規則**（03 章 3.8.4 會給完整判準）：

```
資源【存在與否】本身是機密        → 回 404
資源存在是公開事實、只是內容受限   → 回 403
```

### 0.4.4 一張對照表：什麼情況回什麼

| 情境 | 狀態碼 | 誰產生的 | 常見誤用 |
|---|---|---|---|
| 沒帶任何憑證 | `401` | `AuthenticationEntryPoint` | ❌ 回 403 |
| 帳號不存在 | `401` | 同上（訊息要跟密碼錯誤一致，0.3.4） | ❌ 回 404「查無此帳號」 |
| 密碼錯誤 | `401` | 同上 | ❌ 回 403 |
| Token 過期 | `401` + `code: TOKEN_EXPIRED` | 同上 | ❌ 回 403（前端無法判斷該不該續期） |
| Token 簽章錯 | `401` | 同上 | ❌ 回 400 |
| 帳號被鎖定 / 停用 | `401` + 明確 code | 同上 | ⚠️ 取捨：明確 code 會洩漏帳號存在（07 章 7.4） |
| 登入了，角色不夠 | `403` | `AccessDeniedHandler` | ❌ 回 401（前端會誤以為要重新登入 → 無限跳登入頁） |
| 登入了，但這筆資料不是你的 | `404` 或 `403` | **你的程式碼**（0.4.3） | ❌ 回 200 ← 這就是 0.3.1 |
| CSRF token 缺失 / 錯誤 | `403`（已登入）/ `401`（未登入） | `CsrfFilter` → `ExceptionTranslationFilter` | ⚠️ 未登入時是 401，見下 |
| 請求格式錯誤 | `400` | `@RestControllerAdvice`（04 站） | ❌ 回 403 |

⚠️ **倒數第二列是一個實測得到的意外**：

```
POST /login 【不帶】CSRF token: 401
```

**CSRF 檢查失敗，拿到的卻是 401 而不是 403。**

**為什麼？** 因為 `CsrfFilter` 丟出的是 `AccessDeniedException`，
而 `ExceptionTranslationFilter` 接到 `AccessDeniedException` 之後，
**會先看目前的身分是不是匿名**：

```
目前是匿名 → 「你可能只是還沒登入」→ 交給 AuthenticationEntryPoint → 401
已經登入   → 「你真的沒權限」      → 交給 AccessDeniedHandler      → 403
```

📌 **這個「先看是不是匿名」的邏輯，是 401/403 分界的真正實作**，
它在 `ExceptionTranslationFilter` 的一個方法裡，01 章 1.8.2 會看那段原始碼。

> ⚠️ **前端最痛的一個誤用，值得單獨標出來**：
>
> **把「角色不夠」回成 401**，會讓前端的攔截器判斷「token 失效 → 跳登入頁」，
> 使用者登入之後又被導回同一頁，再拿到 401，再跳登入頁——**無限迴圈**。
> 這個 bug 的表徵是「登入之後一直被登出」，而根因在後端的狀態碼。

---

## 0.5 Spring Security 預設幫你擋了什麼 ★★

### 0.5.1 只加一個 starter，發生了什麼

在一個原本沒有 Security 的 Spring Boot 專案裡，加這一段：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-security</artifactId>
</dependency>
```

**不寫任何一行 Java**，重新啟動。日誌多了一段：

```
2026-09-10T11:28:25.298+08:00  WARN 90780 --- [main] .s.s.UserDetailsServiceAutoConfiguration :

Using generated security password: a5df12b8-39d2-4c69-b5e8-ad1412fe2c98

This generated password is for development use only. Your security configuration must be updated before running your application in production.
```

**然後所有 API 都變成 401 了。**

📌 **這是 Spring Boot 的自動組態做的**，具體是兩個類別：

| 類別 | 它做了什麼 | 什麼時候退讓 |
|---|---|---|
| `SpringBootWebSecurityConfiguration` | 註冊一條 `SecurityFilterChain`：`anyRequest().authenticated()` + 表單登入 + HTTP Basic | **容器裡出現任何一個 `SecurityFilterChain` bean 就完全退讓** |
| `UserDetailsServiceAutoConfiguration` | 註冊一個帳號 `user`，密碼隨機產生並印在日誌 | 容器裡出現 `UserDetailsService` / `AuthenticationProvider` / `AuthenticationManager` 就退讓 |

**「退讓」的意思是它整條不生效**——不是合併，是**取代**。
這是 02 站 02 章講過的 `@ConditionalOnMissingBean` 模式，
但在 Security 上它有一個特別容易踩的後果：

> ⚠️ **你一旦自己寫了一個 `SecurityFilterChain` bean，**
> **Boot 那條預設的 chain 就【整條消失】——包含它幫你開的表單登入、HTTP Basic、CSRF。**
>
> 所以「我只是想加一條規則」的直覺寫法：
>
> ```java
> @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
>     return http.authorizeHttpRequests(a -> a
>                 .requestMatchers("/public/**").permitAll()
>                 .anyRequest().authenticated())
>                .build();          // ← 沒有 formLogin()、沒有 httpBasic()
> }
> ```
>
> **結果是「所有請求都 401，而且沒有任何方式可以登入」**——
> 因為 chain 上沒有任何一個認證用的 Filter。

**可以用固定帳密取代隨機密碼**（只適合本機）：

```yaml
spring:
  security:
    user:
      name: alice
      password: pw123456
      roles: USER
```

### 0.5.2 實測：預設的 16 個 Filter

把 `FilterChainProxy` 注進來印出來（工具的完整程式碼在 0.8.4）：

```java
package com.example.lab09;

import jakarta.servlet.Filter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;

import java.util.List;

@SpringBootTest
class FilterChainDumpTest {

    @Autowired FilterChainProxy proxy;

    @Test
    void dump() {
        List<SecurityFilterChain> chains = proxy.getFilterChains();
        System.out.println("═══ 0.5.2 chain 數量: " + chains.size() + " ═══");
        int c = 0;
        for (SecurityFilterChain chain : chains) {
            List<Filter> filters = chain.getFilters();
            System.out.println("--- chain[" + (c++) + "] filter 數量: " + filters.size() + " ---");
            int i = 0;
            for (Filter f : filters) {
                System.out.printf("    %2d. %s%n", ++i, f.getClass().getSimpleName());
            }
        }
    }
}
```

**Spring Boot 3.2.5 / Spring Security 6.2.4 的預設輸出**：

```
═══ 0.5.2 chain 數量: 1 ═══
--- chain[0] filter 數量: 16 ---
     1. DisableEncodeUrlFilter
     2. WebAsyncManagerIntegrationFilter
     3. SecurityContextHolderFilter
     4. HeaderWriterFilter
     5. CorsFilter
     6. CsrfFilter
     7. LogoutFilter
     8. UsernamePasswordAuthenticationFilter
     9. DefaultLoginPageGeneratingFilter
    10. DefaultLogoutPageGeneratingFilter
    11. BasicAuthenticationFilter
    12. RequestCacheAwareFilter
    13. SecurityContextHolderAwareRequestFilter
    14. AnonymousAuthenticationFilter
    15. ExceptionTranslationFilter
    16. AuthorizationFilter
```

**十六個 Filter，你一行都沒寫。** 各自在防什麼：

| # | Filter | 它在做什麼 | 防的是 |
|---|---|---|---|
| 1 | `DisableEncodeUrlFilter` | 關掉 `response.encodeURL()` 把 session id 塞進網址的行為 | **session id 從網址列洩漏**（Referer、瀏覽歷史、日誌） |
| 2 | `WebAsyncManagerIntegrationFilter` | 讓 `Callable` 非同步請求也拿得到身分 | 非同步端點的身分遺失 |
| 3 | `SecurityContextHolderFilter` | 從 session 把 `SecurityContext` **載入**到 `ThreadLocal`，請求結束**清掉** | 身分殘留在執行緒上（01 章 1.9） |
| 4 | `HeaderWriterFilter` | 寫入六個安全標頭（0.5.3） | 點擊劫持、MIME sniffing、快取洩漏 |
| 5 | `CorsFilter` | 處理跨來源請求與 preflight | 錯誤的跨來源設定（07 章） |
| 6 | `CsrfFilter` | 驗證 CSRF token | **跨站請求偽造**（04 章） |
| 7 | `LogoutFilter` | 攔 `/logout`，清 session 與 context | 登出沒清乾淨 |
| 8 | `UsernamePasswordAuthenticationFilter` | 攔 `POST /login`，做表單登入 | —— |
| 9 | `DefaultLoginPageGeneratingFilter` | **生成**一個登入頁（你沒寫過那個頁面） | —— |
| 10 | `DefaultLogoutPageGeneratingFilter` | 生成登出確認頁 | —— |
| 11 | `BasicAuthenticationFilter` | 解析 `Authorization: Basic ...` | —— |
| 12 | `RequestCacheAwareFilter` | 登入成功後導回原本要去的頁面 | —— |
| 13 | `SecurityContextHolderAwareRequestFilter` | 讓 `request.getUserPrincipal()` 等 Servlet API 能用 | —— |
| 14 | `AnonymousAuthenticationFilter` | 沒身分的請求給一個 `anonymousUser` 身分（0.3.6 的輸出看得到它） | **`null` 判斷散落各處**（01 章 1.4） |
| 15 | `ExceptionTranslationFilter` | 把 `AuthenticationException` / `AccessDeniedException` 轉成 401 / 403 | —— |
| 16 | `AuthorizationFilter` | **執行授權規則**，不通過就丟 `AccessDeniedException` | 越權 |

⚠️ **注意 16 號在最後一個。** 這件事有一個直接後果：

> **授權檢查是整條鏈的最後一關，在它之前的 15 個 Filter 全部都會執行。**
>
> 所以「這支端點是 `permitAll`，Security 應該不會做事」是錯的——
> **`permitAll` 只是讓第 16 個 Filter 放行，前面 15 個照跑。**
> （這也是為什麼 0.3.2 那個 `permitAll()` 的回應**還有安全標頭**。）

📌 **這 16 個不是固定的**。你的設定會改變這個清單，
01 章 1.4 有一張五種設定的對照表（實測從 **5 個到 16 個**都有）。

### 0.5.3 實測：預設回應裡的每一個標頭

用最原始的方式打一支需要登入的端點（不跟隨轉址、不帶 cookie）：

```
═══ 0.5.3 匿名 GET /api/hello ═══
狀態碼: 401
  cache-control: no-cache, no-store, max-age=0, must-revalidate
  content-length: 0
  expires: 0
  pragma: no-cache
  set-cookie: JSESSIONID=32C18F45AF2A605C77CFD0D2F15A7342; Path=/; HttpOnly
  vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
  www-authenticate: Basic realm="Realm"
  x-content-type-options: nosniff
  x-frame-options: DENY
  x-xss-protection: 0
```

**一個一個看**：

| 標頭 | 值 | 防什麼 | 誰寫的 |
|---|---|---|---|
| `x-content-type-options` | `nosniff` | **MIME sniffing**：瀏覽器不准猜內容型別。防「上傳一張 `.jpg` 其實是 HTML，被當網頁執行」 | `HeaderWriterFilter` |
| `x-frame-options` | `DENY` | **點擊劫持**（clickjacking）：不准被任何網站用 `<iframe>` 嵌入 | 同上 |
| `x-xss-protection` | **`0`** | ⚠️ 見下方說明 | 同上 |
| `cache-control` | `no-cache, no-store, ...` | **快取洩漏**：不准瀏覽器 / 代理快取受保護的內容 | 同上 |
| `pragma` / `expires` | `no-cache` / `0` | 同上（給 HTTP/1.0 的老代理） | 同上 |
| `www-authenticate` | `Basic realm="Realm"` | 告訴客戶端「請提供 Basic 憑證」 | `BasicAuthenticationEntryPoint` |
| `set-cookie` | `JSESSIONID=...; HttpOnly` | `HttpOnly` 讓 JavaScript **讀不到** session id（防 XSS 竊取 cookie） | Servlet 容器 |
| `vary` | `Origin, ...` | 讓快取知道回應會因 `Origin` 而異 | `CorsFilter` |

⚠️ **`x-xss-protection: 0` 為什麼是 `0`？**

這個標頭是要求瀏覽器啟用內建的反射型 XSS 過濾器。**Spring Security 刻意把它關掉**，
理由是：那個過濾器**本身製造過漏洞**（它可以被誘導去「淨化」掉頁面上的合法內容，
反而造成資訊洩漏），而且現代瀏覽器（Chrome 78+、Edge、Firefox）**已經全部移除了它**。

```
x-xss-protection: 1; mode=block   ← 舊教學會叫你這樣設；現在是【有害無益】
x-xss-protection: 0               ← Spring Security 6 的預設：明確關閉
```

**真正防 XSS 的是 CSP**（Content-Security-Policy），而 Spring Security **預設不送 CSP**——
因為 CSP 的內容跟你的前端長什麼樣有關，框架沒辦法幫你猜。07 章 7.7 會處理。

📌 **注意這裡出現了一個 0.4.2 提過的細節**：
`content-length: 0` —— **401 的 body 是空的**。
前端如果用 `response.json()` 解析會直接拋錯，這是 04 站 06 章講過的
「前端說拿不到後端的錯誤訊息，只看到 Network Error」的成因之一。

**還有一個更容易被忽略的實測**：

```
═══ 0.5.3 GET /this-does-not-exist（根本沒有這支端點）═══
狀態碼: 401
  www-authenticate: Basic realm="Realm"
```

**一個不存在的路徑，回的是 401 不是 404。**

> 📌 **原因**：Spring Security 在 `DispatcherServlet` **之前**。
> 它不知道（也不需要知道）這個路徑有沒有對應的 Controller——
> **它只看授權規則，而規則說 `anyRequest().authenticated()`。**
>
> 這其實是**好事**：不揭露「哪些路徑存在」也是一種防守
> （攻擊者沒辦法用 404/401 的差別來掃描你的 API 表面）。

### 0.5.4 實測：同一支端點，瀏覽器拿到 302、App 拿到 401

**這是 Spring Security 一個很聰明、但也很容易讓人困惑的預設行為。**

同一支 `/api/hello`，只改 `Accept` 標頭：

```
═══ 0.5.4 ① Accept: text/html（瀏覽器）═══
狀態碼: 302
  location: http://localhost:57509/login

═══ 0.5.4 ② Accept: application/json（前端 fetch / App）═══
狀態碼: 401
  www-authenticate: Basic realm="Realm"

═══ 0.5.4 ③ Accept: */*（curl 預設）═══
狀態碼: 401
  www-authenticate: Basic realm="Realm"
```

**同一支端點、同一個匿名身分，三種不同的回應。**

📌 **這是 `DelegatingAuthenticationEntryPoint` 做的**：
Boot 的預設 chain 同時開了表單登入與 HTTP Basic，
所以它註冊了**兩個** entry point，並用 `Accept` 標頭決定用哪一個：

```
Accept 含 text/html          → LoginUrlAuthenticationEntryPoint → 302 導向 /login
其他（含 */* 與 application/json） → BasicAuthenticationEntryPoint  → 401 + WWW-Authenticate
```

⚠️ **這個行為在混合型專案上會咬人**：

```
一個同時有後台網頁（要 302 導登入頁）與 REST API（要 401）的專案
如果只有一條 chain，行為就取決於【客戶端有沒有正確設 Accept】
而很多 HTTP client 的預設 Accept 是 */*  → 拿到 401，不是 302
```

**正確做法是切成兩條 chain**（01 章 1.7 的主題）：
`/api/**` 一條（無狀態、401）、其他一條（有狀態、302 導登入頁）。

📌 **還有一個逃生門**：把 `ExceptionTranslationFilter` 的 entry point 挖出來看，
它的比對規則裡有一條**跟 `Accept` 無關**的：

```
authenticationEntryPoint = DelegatingAuthenticationEntryPoint
  defaultEntryPoint = LoginUrlAuthenticationEntryPoint
  entryPoints = {
    And [ Not [RequestHeaderRequestMatcher [X-Requested-With=XMLHttpRequest]],
          MediaTypeRequestMatcher [application/xhtml+xml, image/*, text/html, text/plain] ]
        → LoginUrlAuthenticationEntryPoint      （302 導登入頁）
    Or  [ RequestHeaderRequestMatcher [X-Requested-With=XMLHttpRequest], … ]
        → BasicAuthenticationEntryPoint          （401）
  }
```

**第一條規則的 `Not [X-Requested-With=XMLHttpRequest]`**：
只要請求帶了 `X-Requested-With: XMLHttpRequest`，
**就算 `Accept: text/html` 也會走 401 那一條**。
這是 jQuery 時代留下來的慣例，現在仍然是「我是 AJAX，請不要導向登入頁」最省事的表達方式。

### 0.5.5 實測：session fixation 防護

**session fixation 攻擊的形狀**：

```
① 攻擊者先自己去你的網站拿一個 session id：JSESSIONID=AAAA
② 誘導受害者用【這個 id】開啟你的網站（例如網址帶 ;jsessionid=AAAA 的連結）
③ 受害者在這個 session 上【登入成功】
④ 如果 session id 沒有換 → 攻擊者手上的 AAAA 現在是一個【已登入】的 session
```

**Spring Security 預設怎麼處理**：實測登入前後的 cookie。

```java
package com.example.lab09.ch00;

import java.net.http.HttpResponse;
import java.util.regex.*;

public class LoginProbe {

    public static String cookie(HttpResponse<String> r) {
        return r.headers().firstValue("set-cookie").map(s -> s.split(";")[0]).orElse(null);
    }

    /** Spring Security 生成的登入頁裡，隱藏欄位長這樣：
     *  <input name="_csrf" type="hidden" value="..." /> */
    public static String csrf(String html) {
        Matcher m = Pattern.compile("name=\"_csrf\" type=\"hidden\" value=\"([^\"]+)\"").matcher(html);
        return m.find() ? m.group(1) : null;
    }
}
```

```java
// 測試主體（Http 工具的完整原始碼在 0.8.3）
HttpResponse<String> page = http.get("/login");
String s1 = LoginProbe.cookie(page);
String token = LoginProbe.csrf(page.body());

HttpResponse<String> login = http.send("POST", "/login",
        "username=alice&password=pw123456&_csrf=" + token,
        "Content-Type", "application/x-www-form-urlencoded",
        "Cookie", s1);
String s2 = LoginProbe.cookie(login);
```

```
═══ 0.5.5 session fixation 實測 ═══
登入【前】的 session cookie : JSESSIONID=6092233C7DED1F9B1903CA83A64D8F9D
表單裡的 CSRF token        : b7RvXOwWsZs0LjD-DfvZhMs675wKyrx-5E17y9QUW70VmuMwDIFcb9lw1f4ZGlLLbtbtva4CwqU-_IRT0nRP8-AhbYkno9NT
登入回應狀態碼             : 302 → http://localhost:57532/
登入【後】的 session cookie : JSESSIONID=FDCE4D9FA3C7C72F4EAABF23D57A24BC
兩者相同嗎？               : false
用【新】cookie 打 API      : 200 {"msg":"hello"}
用【舊】cookie 打 API      : 401
```

**三件事同時被證明了**：

```
① 登入成功後，session id 【換掉了】             → fixation 攻擊失效
② 舊的 session id 【立刻失效】（401）           → 攻擊者手上那個沒用了
③ 這一切【你一行程式碼都沒寫】
```

📌 對應的設定是 `sessionManagement().sessionFixation()`，
**預設值是 `migrateSession`**（建新 session、把舊 session 的屬性搬過去）。
04 章 4.3 會比較四個選項。

### 0.5.6 實測：CSRF 預設是開的

同一個登入表單，**故意不帶 `_csrf`**：

```
═══ 0.5.6 CSRF 實測 ═══
POST /login 【不帶】CSRF token: 401
```

**被擋下來了。** （為什麼是 401 而不是 403，見 0.4.4 的最後一段。）

⚠️ **這是「加了 Security 之後所有 POST 都 403」的頭號原因**，
而網路上最常見的解法是：

```java
.csrf(c -> c.disable())     // ← 這一行是這一站最常被亂抄的一行
```

**這一行有時候是對的，有時候是重大漏洞**，判準是：

```
你的身分靠【瀏覽器自動送出的東西】攜帶（Cookie / Session / HTTP Basic）
  → CSRF 攻擊成立     → ★ 不可以關

你的身分靠【JavaScript 主動放進去的東西】攜帶（Authorization: Bearer ...）
  → 攻擊者的網站沒辦法讓瀏覽器自動帶上你的 token → 可以關
```

📌 **04 章 4.5 會把這個判準展開成一張決策表**，
並且處理一個常見的中間情況：**token 存在 cookie 裡**（那就又要開回來了）。

### 0.5.7 預設**沒有**幫你擋的六件事

⚠️ 這是這一節最重要的一張表。

| 預設沒擋 | 後果 | 本站哪一章 |
|---|---|---|
| **資源層授權**（這筆資料是不是你的） | 0.3.1 的 IDOR | 03 章 3.8 |
| **暴力破解 / 撞庫** | 沒有任何登入失敗次數限制，可以無限次嘗試 | 07 章 7.5 |
| **帳號列舉** | 註冊 / 忘記密碼端點會洩漏「這個 email 有沒有註冊」 | 07 章 7.4 |
| **CSP 標頭** | XSS 的實質防線沒有建立（`X-XSS-Protection: 0` 只是關掉一個壞掉的東西） | 07 章 7.7 |
| **稽核日誌** | 出事之後查不到「誰在什麼時候登入、被擋了幾次」 | 08 章 8.2 |
| **密碼強度規則** | `123456` 可以註冊 | 02 章 2.9 |

> 📌 **這張表的意義**：
>
> **「我裝了 Spring Security，所以我的系統是安全的」是這一站要拆掉的第一個誤解。**
>
> Spring Security 幫你擋掉的，是**協定層與框架層**的攻擊
> （session fixation、CSRF、點擊劫持、MIME sniffing）——
> 那些是「跟你的商業邏輯無關、每個系統都一樣」的部分，所以框架擋得住。
>
> **它擋不住的，全部都是「跟你的商業邏輯有關」的部分**——
> 誰擁有這筆訂單、幾次失敗算異常、哪些密碼算太弱。
> **那些只有你知道，所以只有你能寫。**

---

## 0.6 威脅模型：一個訂單 API 會被怎麼打 ★

**「安全」這個詞太大，大到沒辦法拿來做決策。**
威脅模型的用途就是把它縮小成一組**具體的、可以逐條回答的問題**。

### 0.6.1 三欄：資產、入口、攻擊者

先把 shop-service 攤開：

**① 資產（值錢的東西是什麼）**

```
訂單資料          金額、品項、收件地址、電話    ← 個資 + 商業機密
使用者帳號         email、密碼雜湊、手機         ← 撞庫的原料
營收報表          全公司的營業額                ← 商業機密
下單能力          可以建立、取消、退款的權力      ← 直接的金錢損失
系統可用性        服務本身                     ← 被打掛就沒有營收
```

**② 入口（攻擊者能碰到什麼）**

```
公開端點          /api/orders/**、/api/customers/**、/login
Actuator 端點     /actuator/**                 ← 02 站 05 章留下的問題
錯誤回應          堆疊、SQL、內部類名            ← 04 站 03 章處理過一部分
靜態資源          /static/**、/swagger-ui/**    ← 07 章會處理
Cookie / Token   瀏覽器裡的憑證                 ← XSS 的目標
```

**③ 攻擊者（誰、有什麼能力）**

| 攻擊者 | 有什麼 | 想要什麼 | 本站哪一章處理 |
|---|---|---|---|
| **未認證的外部人** | 只有網路連線 | 進得去就好 | 01～03（認證與授權） |
| **一般會員**（alice） | **一組合法帳密** | 看到別人的資料、拿到管理權 | **03（★ 最常被低估）** |
| **離職員工** | 舊帳號、舊 token | 資料、報復 | 05（撤銷）、08（稽核） |
| **拿到 XSS 的人** | 能在受害者瀏覽器執行 JS | 偷 cookie / 冒用身分 | 04（HttpOnly）、07（CSP） |
| **中間人** | 能看到流量 | 憑證 | 傳輸層（不在本站，見 nginx 站） |
| **拿到資料庫備份的人** | 整張 users 表 | 密碼 | **00（0.7）** |

⚠️ **第二列是這一站最重要的一列**：

> **威脅模型裡最常被漏掉的攻擊者，是「一個合法的使用者」。**
>
> 因為所有人在設計時想的都是「怎麼把外人擋在外面」，
> 而 0.3.1 那個事故的攻擊者**是通過認證的**——
> 他不需要繞過任何一道防線，他只需要把網址列的 `1001` 改成 `1002`。

### 0.6.2 STRIDE 對到本站的章節

STRIDE 是微軟提出的六類威脅分類，用它當檢查清單：

| 字母 | 威脅 | 在訂單 API 上長什麼樣 | 對策 | 章節 |
|---|---|---|---|---|
| **S**poofing | 冒充身分 | 用別人的帳號登入 / 偽造 token | 密碼雜湊、簽章驗證 | 00（0.7）、02、05 |
| **T**ampering | 竄改資料 | 改 JWT 的 payload 說自己是 admin | 簽章、不信任客戶端資料 | 05 |
| **R**epudiation | 否認做過 | 「這筆退款不是我按的」 | 稽核日誌 | 08 |
| **I**nformation disclosure | 資訊洩漏 | IDOR、錯誤訊息洩漏、帳號列舉 | 資源層授權、錯誤格式、一致回應 | **00（0.3.1、0.3.4）**、03、07 |
| **D**enial of service | 阻斷服務 | 無限次登入嘗試、大量請求 | 限流、鎖定 | 07、10 站 |
| **E**levation of privilege | 提權 | 一般會員打到管理端點 | URL / 方法 / 資源三層授權 | 03 |

### 0.6.3 OWASP API Security Top 10（2023）對照

**這張表比 STRIDE 更接近實務**，因為它是從真實事故統計出來的：

| # | 名稱 | 白話 | 本站哪一章 |
|---|---|---|---|
| **API1** | Broken Object Level Authorization | **改個 id 就看到別人的資料** | **00（0.3.1）**、03（3.8） |
| **API2** | Broken Authentication | 弱密碼、無限嘗試、token 沒過期 | 02、05、07 |
| **API3** | Broken Object Property Level Authorization | 回傳了不該回的欄位 / 讓使用者改了不該改的欄位 | 03（3.9）、05 站 03 章（DTO） |
| **API4** | Unrestricted Resource Consumption | 沒有分頁、沒有限流 | 03 站 05/08 章、10 站 |
| **API5** | Broken Function Level Authorization | **一般會員打得到管理端點** | **00（0.3.1 最後一行）**、03 |
| **API6** | Unrestricted Access to Sensitive Business Flows | 搶購、刷優惠券 | 03 站 08 章（冪等）、10 站 |
| **API7** | Server Side Request Forgery | 讓伺服器去打內網 | 05 站 06 章 |
| **API8** | Security Misconfiguration | **`permitAll()`、CORS 全開、Actuator 沒關** | **00（0.3.2）**、07、08 |
| **API9** | Improper Inventory Management | 舊版本 API 還開著、測試環境連到正式資料庫 | 03 站 06 章、08 |
| **API10** | Unsafe Consumption of APIs | 無條件信任第三方回來的資料 | 05 站 06 章、06 章（OAuth2） |

⚠️ **注意 API1 與 API5 各佔一個名次**，而且它們是**同一類**問題（授權沒做好）
的兩個面向——**這一站的 03 章要處理的就是這兩條**。

> 📌 **一個實務上的用法**：
> 把這張表當成 code review 的檢查清單。
> 每一支新端點問十個問題，其中 API1 / API3 / API5 這三條問完，
> **大部分的授權漏洞會在 review 就被抓到，而不是上線之後。**
> 08 章 8.7 有完整的清單版本。

---

## 0.7 密碼：唯一一個「你一定會存錯」的東西 ★★

### 0.7.1 四個層次

```
① 明碼                users.password = 'P@ssw0rd'
   → 外洩 = 全部帳號失守 + 使用者在【其他網站】的帳號也失守（大家會重複用密碼）

② 快雜湊（MD5/SHA）    users.password = md5('P@ssw0rd')
   → 0.3.3 實測：反查表 5.4 秒建好、0.3 ms 全部還原

③ 加鹽的快雜湊         users.password = sha256(salt + 'P@ssw0rd')
   → 反查表失效了（每個人的鹽不同，要一個一個算）
   → 但 SHA-256 一次只要 0.486 µs → 一秒可以對【一個帳號】試 205 萬次

④ 慢雜湊（自帶鹽）      users.password = bcrypt('P@ssw0rd')
   → 一次 68.9 ms → 一秒對一個帳號只能試 14 次   ★ 這才是答案
```

⚠️ **③ 是最容易停下來的地方**，因為「加鹽」聽起來已經是專業做法了。
但加鹽解決的是「**一次破解全部**」，沒有解決「**逐一破解很便宜**」。
**慢雜湊同時解決兩個**（它內建隨機鹽，而且慢）。

### 0.7.2 實測：撞庫的成本

```java
package com.example.lab09.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.security.MessageDigest;
import java.util.*;

class CrackMd5Test {

    static String md5(String s) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(s.getBytes()));
    }

    /** 模擬「外洩的使用者表」：三個真實世界常見的密碼，用 MD5 存。 */
    @Test
    void crack() throws Exception {
        Map<String, String> leaked = new LinkedHashMap<>();
        leaked.put("alice", md5("123456"));
        leaked.put("bob",   md5("a1234567"));       // 8 碼、有英文有數字，「符合公司密碼政策」
        leaked.put("carol", md5("Taipei2026!"));    // 大小寫 + 數字 + 符號

        System.out.println("═══ 0.7.2 外洩的資料表長這樣 ═══");
        leaked.forEach((u, h) -> System.out.println("  " + u + " | " + h));

        // 攻擊者手上的字典：用「8 碼以下的純數字 + 常見密碼」模擬
        long t0 = System.nanoTime();
        Map<String, String> rainbow = new HashMap<>();
        for (int i = 0; i < 10_000_000; i++) rainbow.put(md5(String.valueOf(i)), String.valueOf(i));
        String[] common = {"password", "qwerty", "abc123", "a1234567", "P@ssw0rd", "Taipei2026!", "letmein"};
        for (String c : common) rainbow.put(md5(c), c);
        long buildMs = (System.nanoTime() - t0) / 1_000_000;
        System.out.println("\n建一張 1000 萬筆的反查表花了: " + buildMs + " ms（" + rainbow.size() + " 筆）");

        System.out.println("\n═══ 0.7.2 反查結果 ═══");
        t0 = System.nanoTime();
        leaked.forEach((u, h) -> System.out.println("  " + u + " → " + rainbow.getOrDefault(h, "(沒查到)")));
        System.out.println("反查三個帳號花了: " + (System.nanoTime() - t0) / 1000 + " µs");
    }

    /** 同樣的弱密碼，改用 BCrypt 存，攻擊者要付出什麼代價 */
    @Test
    void crackBcrypt() {
        BCryptPasswordEncoder enc = new BCryptPasswordEncoder();
        String hash = enc.encode("123456");
        System.out.println("\n═══ 0.7.2 同一個弱密碼 123456，用 BCrypt 存 ═══");
        System.out.println(hash);

        long t0 = System.nanoTime();
        int tried = 0;
        for (int i = 0; i < 30; i++) { enc.matches(String.valueOf(i), hash); tried++; }
        long ns = (System.nanoTime() - t0) / tried;

        System.out.println("每試一個候選密碼要: " + ns / 1_000_000.0 + " ms");
        System.out.printf("試完 1000 萬個候選要: %.1f 天（單執行緒）%n", ns / 1e9 * 10_000_000 / 86400);
    }
}
```

```
═══ 0.7.2 外洩的資料表長這樣 ═══
  alice | e10adc3949ba59abbe56e057f20f883e
  bob   | 5690dddfa28ae085d23518a035707282
  carol | d5cfe02a04cd78ea42e7d57339ae83e1

建一張 1000 萬筆的反查表花了: 5443 ms（10000007 筆）

═══ 0.7.2 反查結果 ═══
  alice → 123456
  bob   → a1234567
  carol → Taipei2026!
反查三個帳號花了: 307 µs

═══ 0.7.2 同一個弱密碼 123456，用 BCrypt 存 ═══
$2a$10$5wZC8IL93Hs4OEr.sKh3z.8.WBjDEl6LbYx946d4DNwDOpK9AESGa
每試一個候選密碼要: 69.096536 ms
試完 1000 萬個候選要: 8.0 天（單執行緒）
```

**兩個數字並排看**：

```
MD5    ： 1000 萬個候選 → 5.4 秒     （而且這張表可以【重複用在所有受害者身上】）
BCrypt ： 1000 萬個候選 → 8.0 天     （而且【每個帳號都要重跑一次】，因為鹽不同）
```

⚠️ **8 天不是「安全」，是「貴」。** 誠實地說：

```
攻擊者有 GPU / ASIC          → 快幾百倍到幾千倍
攻擊者只針對【一個】高價值帳號  → 8 天完全可以接受
使用者的密碼是 123456         → 在字典的第一頁，8 天用不到
```

**所以慢雜湊要搭配三件事才有意義**：
密碼強度規則（02 章）、登入失敗鎖定（07 章）、以及**二階段驗證**。

### 0.7.3 實測：五種演算法的單次耗時

```java
package com.example.lab09.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.scrypt.SCryptPasswordEncoder;

import java.security.MessageDigest;
import java.util.HexFormat;

class PasswordSpeedTest {

    static String md5(String s) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(s.getBytes()));
    }
    static String sha256(String s) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes()));
    }

    @Test
    void speed() throws Exception {
        System.out.println("═══ 0.7.3 算一次要多久（越慢越好）═══");

        long t0 = System.nanoTime();
        for (int i = 0; i < 200_000; i++) md5("P@ssw0rd" + i);
        long md5Ns = (System.nanoTime() - t0) / 200_000;

        t0 = System.nanoTime();
        for (int i = 0; i < 200_000; i++) sha256("P@ssw0rd" + i);
        long shaNs = (System.nanoTime() - t0) / 200_000;

        System.out.printf("%-28s %12s %18s%n", "演算法", "單次耗時", "每秒可暴力嘗試");
        System.out.printf("%-28s %10.3f µs %15s%n", "MD5", md5Ns / 1000.0, String.format("%,d", 1_000_000_000L / md5Ns));
        System.out.printf("%-28s %10.3f µs %15s%n", "SHA-256", shaNs / 1000.0, String.format("%,d", 1_000_000_000L / shaNs));

        for (int cost : new int[]{4, 8, 10, 12, 14}) {
            BCryptPasswordEncoder e = new BCryptPasswordEncoder(cost);
            e.encode("warmup");
            int rounds = cost >= 12 ? 5 : 30;
            t0 = System.nanoTime();
            for (int i = 0; i < rounds; i++) e.encode("P@ssw0rd");
            long ns = (System.nanoTime() - t0) / rounds;
            System.out.printf("%-28s %10.3f ms %15s%n", "BCrypt(cost=" + cost + ")",
                    ns / 1_000_000.0, String.format("%,d", Math.max(1, 1_000_000_000L / ns)));
        }

        Argon2PasswordEncoder argon = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();
        argon.encode("warmup");
        t0 = System.nanoTime();
        for (int i = 0; i < 5; i++) argon.encode("P@ssw0rd");
        long argonNs = (System.nanoTime() - t0) / 5;
        System.out.printf("%-28s %10.3f ms %15s%n", "Argon2id(SS 預設)",
                argonNs / 1_000_000.0, String.format("%,d", Math.max(1, 1_000_000_000L / argonNs)));

        SCryptPasswordEncoder scrypt = SCryptPasswordEncoder.defaultsForSpringSecurity_v5_8();
        scrypt.encode("warmup");
        t0 = System.nanoTime();
        for (int i = 0; i < 5; i++) scrypt.encode("P@ssw0rd");
        long scryptNs = (System.nanoTime() - t0) / 5;
        System.out.printf("%-28s %10.3f ms %15s%n", "SCrypt(SS 預設)",
                scryptNs / 1_000_000.0, String.format("%,d", Math.max(1, 1_000_000_000L / scryptNs)));
    }
}
```

> ⚠️ **`Argon2PasswordEncoder` 與 `SCryptPasswordEncoder` 需要 BouncyCastle**，
> 否則會在執行期拋 `NoClassDefFoundError: org/bouncycastle/crypto/params/Argon2Parameters$Builder`。
> Spring Security 沒有把它列為必要相依，要自己加：
>
> ```xml
> <dependency>
>   <groupId>org.bouncycastle</groupId>
>   <artifactId>bcprov-jdk15to18</artifactId>
>   <version>1.74</version>
> </dependency>
> ```

**實測**（Apple M2 / macOS 14.2.1 / JDK 21.0.5 / 單執行緒）：

```
═══ 0.7.3 算一次要多久（越慢越好）═══
演算法                                  單次耗時            每秒可暴力嘗試
MD5                               0.565 µs       1,769,911
SHA-256                           0.486 µs       2,057,613
BCrypt(cost=4)                    1.363 ms             733
BCrypt(cost=8)                   17.361 ms              57
BCrypt(cost=10)                  68.863 ms              14
BCrypt(cost=12)                 277.526 ms               3
BCrypt(cost=14)                1098.967 ms               1
Argon2id(SS 預設)                  57.674 ms              17
SCrypt(SS 預設)                   112.914 ms               8
```

**四個要注意的觀察**：

**① SHA-256 比 MD5 還快。**
`0.486 µs` vs `0.565 µs`——因為 Apple M2 有 SHA 硬體指令。
**「MD5 不安全，改用 SHA-256」是一個沒有解決問題、甚至讓問題略微惡化的修法。**

**② BCrypt 的 cost 是指數。**
`cost = n` 表示做 `2^n` 輪。所以：

```
cost 10 → 68.9 ms
cost 12 → 277.5 ms   （4 倍，符合 2^2）
cost 14 → 1099.0 ms  （16 倍，符合 2^4）
```

**每 +1 就慢一倍**——這是它最重要的性質：**硬體變快時，你只要把數字 +1 就追上了。**

**③ 從「每秒可暴力嘗試」那一欄看防守效果**：

```
MD5             一秒 176 萬次
BCrypt cost=10  一秒 14 次        ← 慢了 12 萬倍
```

**④ Argon2id 比 BCrypt cost=10 還快（57.7 ms vs 68.9 ms）——這不代表它比較弱。**
Argon2 的防禦重點是**記憶體**——把 `Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8()`
的參數挖出來是 `memory = 16384`（KB，即 **16 MB**）、`iterations = 2`、`parallelism = 1`、`hashLength = 32`，
而 GPU 的優勢在於「很多個很笨的核心」，**記憶體才是它的瓶頸**。
**同樣的 CPU 時間，Argon2 對 GPU 攻擊的抵抗力遠高於 BCrypt。**

### 0.7.4 `cost` 要設多少：一個可以拿去說服 PM 的判準

**不要背「設 10 就對了」。用這個判準**：

```
① 決定「一次登入可以花多少時間在雜湊上」
   → 使用者感知的門檻大約是 100 ms
   → 但你的登入端點還有 DB 查詢、網路來回、序列化
   → 實務上留給雜湊的預算：50 ～ 250 ms

② 在【正式環境的機器上】跑 0.7.3 那段程式碼
   → 不是你的 MacBook。雲端的 vCPU 通常比筆電慢 2～4 倍

③ 挑一個落在預算內、最大的 cost
```

⚠️ **第二步是最常被跳過的。** 同一個 cost=10：

```
Apple M2（本課實測）      68.9 ms      → 感覺很安全，想調到 12
一台 2 vCPU 的雲端主機     可能 200+ ms → cost=12 會變成 800 ms，登入慢到使用者以為壞了
```

📌 **還有一個容易忘記的成本**：**登入端點會佔用執行緒**。

```
cost=12（277 ms）+ 每秒 100 次登入
→ 100 × 0.277 = 27.7 個執行緒【永遠在算雜湊】
→ Tomcat 預設 200 個執行緒 → 吃掉 14%
→ 促銷時登入尖峰 500 QPS → 需要 139 個執行緒 → ★ 整個服務停止回應
```

**這跟 02 站 08 章那個「一變慢就整個服務停止回應」是同一類問題**，
只是這次慢的原因是你自己設的。

**本課的選擇**：

```
BCrypt cost = 10（Spring Security 的預設）
理由：① 在多數雲端機器上落在 100～250 ms
     ② 它是 DelegatingPasswordEncoder 的預設，遷移成本最低
     ③ 硬體變快時 +1 就好，而且 0.7.7 證明了升級【不需要使用者改密碼】
```

**新專案如果沒有相容包袱，Argon2id 是更好的選擇**（OWASP 現在的第一推薦）。

### 0.7.5 `{bcrypt}` 那個前綴：`DelegatingPasswordEncoder`

**Spring Security 5 開始，預設的 `PasswordEncoder` 不是 BCrypt，而是一個「分派器」。**

```java
package com.example.lab09.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

class DelegatingEncoderTest {

    @Test
    void demo() {
        System.out.println("═══ 0.7.5 DelegatingPasswordEncoder ═══");
        PasswordEncoder enc = PasswordEncoderFactories.createDelegatingPasswordEncoder();

        String stored = enc.encode("P@ssw0rd");
        System.out.println("encode 出來長這樣: " + stored);
        System.out.println("驗證: " + enc.matches("P@ssw0rd", stored));
        System.out.println("驗證舊的 {noop} 明碼: " + enc.matches("P@ssw0rd", "{noop}P@ssw0rd"));

        try {
            enc.matches("P@ssw0rd", "$2a$10$abcdefghijklmnopqrstuv");  // 沒有前綴的裸 BCrypt
        } catch (Exception e) {
            System.out.println("拿【沒有前綴】的雜湊去驗: "
                    + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }
}
```

```
═══ 0.7.5 DelegatingPasswordEncoder ═══
encode 出來長這樣: {bcrypt}$2a$10$E84Rd8PsqJfav.HMyPpYXe8zHId.FUudLdwbRH2fdFnVsYXqRPBSi
驗證: true
驗證舊的 {noop} 明碼: true
拿【沒有前綴】的雜湊去驗: IllegalArgumentException: There is no PasswordEncoder mapped for the id "null"
```

**最後一行是 Spring Security 最常被 Google 的錯誤訊息之一。**

```
There is no PasswordEncoder mapped for the id "null"
```

**它的意思是**：資料庫裡的雜湊**沒有 `{...}` 前綴**，
所以分派器不知道該用哪個演算法去驗。

📌 **前綴的設計解決了一個真實問題**：

```
2018 年：你用 BCrypt cost=10 存密碼
2022 年：你想換成 Argon2id
問題   ：資料庫裡有 50 萬筆 BCrypt 的雜湊，而【你沒有原始密碼】

沒有前綴 → 只能叫全部使用者改密碼（不可能）
有前綴   → 新的存成 {argon2}...，舊的還是 {bcrypt}...，兩種同時驗得過
```

**這就是為什麼欄位要留夠長**（`{argon2}` 的雜湊大約 96 字元）：

```sql
-- 07 站的 schema 慣例
password_hash VARCHAR(100) NOT NULL COMMENT '含 {演算法} 前綴的雜湊'
```

⚠️ **常見誤用**：`{noop}` 是明碼。
它存在的目的是**讓舊系統可以漸進遷移**，以及讓範例好寫：

```java
User.withUsername("alice").password("{noop}pw").build();   // 只能出現在測試 / 範例
```

**它出現在正式環境就是 0.7.1 的層次 ①。**

### 0.7.6 BCrypt 的 72 位元組上限

```java
package com.example.lab09.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

class Bcrypt72Test {

    @Test
    void limit() {
        System.out.println("═══ 0.7.6 BCrypt 的 72 位元組上限 ═══");
        BCryptPasswordEncoder e = new BCryptPasswordEncoder();
        String p72 = "a".repeat(72);
        String hash = e.encode(p72);

        System.out.println("用 72 個 a 當密碼，雜湊: " + hash);
        System.out.println("用 72 個 a 驗證 : " + e.matches(p72, hash));
        System.out.println("用 73 個 a 驗證 : " + e.matches("a".repeat(73), hash));
        System.out.println("用 100 個 a 驗證: " + e.matches("a".repeat(100), hash));
        System.out.println("用 71 個 a 驗證 : " + e.matches("a".repeat(71), hash));
    }
}
```

```
═══ 0.7.6 BCrypt 的 72 位元組上限 ═══
用 72 個 a 當密碼，雜湊: $2a$10$O.PqGOjqzy2amD7BgcBB2enR/sV.jb6HpkjLTKbbtzIgumbpo7f3S
用 72 個 a 驗證 : true
用 73 個 a 驗證 : true
用 100 個 a 驗證: true
用 71 個 a 驗證 : false
```

**72 個 a 的密碼，用 100 個 a 也驗得過。**

⚠️ **BCrypt 只看前 72 個位元組**，後面的直接丟掉。這有三個後果：

| 後果 | 說明 |
|---|---|
| **超長密碼沒有更安全** | 第 73 個字元之後完全沒有作用 |
| **中文密碼的上限更短** | UTF-8 的中文一個字 3 位元組 → **只有 24 個中文字** |
| **「先 SHA-256 再 BCrypt」會出事** | 很多人為了繞過 72 限制先做一次 SHA-256，若把結果轉成 hex 字串（64 字元）沒問題，但**若直接用 Base64 且沒有處理 `\0`，某些實作會截斷**——不要自己組合演算法 |

📌 **Argon2 沒有這個限制。** 這是選 Argon2 的另一個理由。

### 0.7.7 換演算法，不用叫使用者改密碼

**`PasswordEncoder` 有第三個方法，很多人不知道它存在**：

```java
public interface PasswordEncoder {
    String  encode(CharSequence rawPassword);
    boolean matches(CharSequence rawPassword, String encodedPassword);
    default boolean upgradeEncoding(String encodedPassword) { return false; }   // ★
}
```

```java
package com.example.lab09.ch00;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

class UpgradeEncodingTest {

    @Test
    void upgrade() {
        System.out.println("═══ 0.7.7 換演算法要不要叫使用者改密碼 ═══");
        PasswordEncoder enc = PasswordEncoderFactories.createDelegatingPasswordEncoder();

        String old = "{bcrypt}" + new BCryptPasswordEncoder(4).encode("P@ssw0rd");  // 三年前用 cost=4 存的
        System.out.println("三年前存的（cost=4）: " + old);
        System.out.println("今天用預設的 encoder 驗它: " + enc.matches("P@ssw0rd", old));
        System.out.println("upgradeEncoding 說要不要重存: " + enc.upgradeEncoding(old));

        String now = enc.encode("P@ssw0rd");
        System.out.println("今天存的（cost=10）  : " + now);
        System.out.println("upgradeEncoding 說要不要重存: " + enc.upgradeEncoding(now));
    }
}
```

```
═══ 0.7.7 換演算法要不要叫使用者改密碼 ═══
三年前存的（cost=4）: {bcrypt}$2a$04$/O.RR2wvEW5R7u.EPCTzrOrLcHIZq8bRSRYFwJdTG9jDLPerbRqpS
今天用預設的 encoder 驗它: true
upgradeEncoding 說要不要重存: true
今天存的（cost=10）  : {bcrypt}$2a$10$u09oVJo6MnEi8xkGY6t2g.6w0O.bjAjdxDMGLjpaR9NITD5AnFhQO
upgradeEncoding 說要不要重存: false
```

**這個方法讓「漸進升級」變成可能**：

```
使用者登入 → 密碼驗過了（這一刻，你手上【有原始密碼】）
           → 問一下 upgradeEncoding(舊雜湊)
           → 是 true 的話，用新演算法重新 encode 一次、存回去
           → 使用者完全無感
```

**一年後，活躍使用者的密碼全部升級完成**，剩下沒登入過的用舊的驗——**兩邊都能動**。

📌 **Spring Security 的 `DaoAuthenticationProvider` 內建了這個流程**，
但需要你的 `UserDetailsService` 額外實作 `UserDetailsPasswordService`。
02 章 2.8 會給完整實作。

---

## 0.8 本站的基準專案

**這一節建的東西會被接下來九章一直用到**，值得花時間做對。

### 0.8.1 `pom.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/>
  </parent>

  <groupId>com.example</groupId>
  <artifactId>lab09</artifactId>
  <version>1.0</version>
  <properties><java.version>21</java.version></properties>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-security</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
      <groupId>com.mysql</groupId>
      <artifactId>mysql-connector-j</artifactId>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <scope>runtime</scope>
    </dependency>

    <!-- Argon2 / SCrypt 需要（0.7.3）；只用 BCrypt 的話可以拿掉 -->
    <dependency>
      <groupId>org.bouncycastle</groupId>
      <artifactId>bcprov-jdk15to18</artifactId>
      <version>1.74</version>
    </dependency>

    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
    <!-- ★ @WithMockUser、SecurityMockMvcRequestPostProcessors 都在這裡（08 章） -->
    <dependency>
      <groupId>org.springframework.security</groupId>
      <artifactId>spring-security-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
```

| 相依 | 這一站用它做什麼 | 從哪一章開始 |
|---|---|---|
| `starter-security` | 本體 | 00 |
| `starter-web` | 端點與 Servlet 容器 | 00 |
| `starter-data-jpa` + `mysql-connector-j` | 帳號 / 角色 / 權限的資料表 | 02 |
| `bcprov-jdk15to18` | Argon2 / SCrypt | 00（0.7.3） |
| `spring-security-test` | `@WithMockUser`、帶身分的 MockMvc | 08 |
| **（05 章再加）** `jjwt` 或 `nimbus-jose-jwt` | JWT 簽發與驗證 | 05 |
| **（06 章再加）** `spring-boot-starter-oauth2-client` / `-resource-server` | OAuth2 | 06 |

**`application.yml`**：

```yaml
spring:
  datasource:
    url: jdbc:h2:mem:lab09;DB_CLOSE_DELAY=-1
    driver-class-name: org.h2.Driver
  jpa:
    hibernate:
      ddl-auto: none
    open-in-view: false          # 06 站 05 章的結論；不關會在啟動時警告

  # ⚠️ 只有本機實驗才這樣寫；正式環境的帳號來自資料庫（02 章）
  security:
    user:
      name: alice
      password: pw123456
      roles: USER

logging:
  level:
    root: WARN
    # ★ 這一行是這一站最有價值的一行設定，01 章 1.3 會解釋輸出怎麼讀
    # org.springframework.security: TRACE
```

> ⚠️ **`ddl-auto: none` + H2 記憶體資料庫**是為了讓 00～01 章的實驗不依賴任何資料庫。
> 02 章開始會換成真的 MySQL（07 站那個容器），
> 因為「帳號被鎖定 / 密碼過期」這類狀態需要真的持久化才測得出來。

### 0.8.2 三個帳號、三張訂單的固定裝置

**0.3.0 那組類別就是固定裝置**，這裡補上它們之間的關係：

```
Users（@Configuration）
  └─ UserDetailsService ── alice / bob（ROLE_USER）、admin（ROLE_ADMIN）
                              密碼統一是 "pw"，用 BCryptPasswordEncoder 存

OrderRepo（@Repository，記憶體 Map）
  ├─ 1001  owner=alice   1,280
  ├─ 1002  owner=bob    99,000
  └─ 1003  owner=bob       350

OrderController   GET /api/orders/{id}   GET /api/orders   DELETE /api/orders/{id}
AdminController   GET /api/admin/revenue
HelloController   GET /api/hello         POST /api/echo
```

⚠️ **這組固定裝置刻意選了「兩個同角色的使用者」（alice 與 bob）**，
因為那正是 0.3.1 那個 IDOR 事故成立的條件——
**如果只有一個一般會員，你永遠測不出資源層授權有沒有做。**

📌 **一個貫穿全站的測試習慣**：
每一支新端點都用**三個身分**各打一次（匿名 / alice / admin），
再加上一次「**alice 打 bob 的資料**」——
**第四次那一發，就是授權矩陣蓋不到的那一層。**

### 0.8.3 `Http`：一個不會替你美化回應的 HTTP 工具

**這一站的實測有一半是在看「回了什麼狀態碼、什麼標頭」，
所以工具的第一要求是「不要幫我做任何事」**：

```java
package com.example.lab09;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;

/** 不跟隨轉址、不自動帶 cookie 的裸 HTTP client，用來看 Spring Security 的原始回應。 */
public class Http {

    private final HttpClient client = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NEVER)     // ★ 關鍵
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private final int port;

    public Http(int port) { this.port = port; }

    public HttpResponse<String> send(String method, String path, String body, String... headers) {
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path));
            b.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                                          : HttpRequest.BodyPublishers.ofString(body));
            for (int i = 0; i < headers.length; i += 2) {
                if (headers[i + 1] != null) b.header(headers[i], headers[i + 1]);
            }
            return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    public HttpResponse<String> get(String path, String... headers) {
        return send("GET", path, null, headers);
    }

    public static String basic(String u, String p) {
        return "Basic " + Base64.getEncoder().encodeToString((u + ":" + p).getBytes());
    }

    public static void show(String title, HttpResponse<String> r) {
        System.out.println("\n═══ " + title + " ═══");
        System.out.println("狀態碼: " + r.statusCode());
        r.headers().map().entrySet().stream()
         .filter(e -> !e.getKey().startsWith(":"))
         .sorted(Map.Entry.comparingByKey())
         .forEach(e -> System.out.println("  " + e.getKey() + ": " + String.join(", ", e.getValue())));
        String b = r.body();
        if (b != null && b.length() > 200) b = b.substring(0, 200).replace("\n", " ") + " ...(略)";
        System.out.println("  body: " + b);
    }
}
```

⚠️ **`followRedirects(NEVER)` 這一行不是細節，它決定了你看不看得見事實。**

用 `TestRestTemplate` 打同一支端點會拿到：

```
狀態碼: 200 OK
body: <!DOCTYPE html> … <title>Please sign in</title> …
```

**「200」是假的**——`TestRestTemplate` 預設會跟隨轉址，
所以它替你走完了 `302 → /login` 這一步，然後把登入頁的 200 回給你。
**如果你在測「未登入會不會被擋」，這個 200 會讓你以為沒有被擋。**

用 `Http` 打同一支：

```
狀態碼: 302
  location: http://localhost:57509/login
```

📌 **這一站的所有實測都用 `Http`**，理由就是這一條。
（`MockMvc` 也不會跟隨轉址，所以它也是安全的；08 章會用它。）

### 0.8.4 把 Filter Chain 印出來：這一站最該先裝的工具

0.3.2 那個事故的根因是「**關掉授權沒有任何訊號**」。
**這個 bean 就是那個訊號**——它在每次啟動時把整條 chain 印出來：

```java
package com.example.lab09;

import jakarta.servlet.Filter;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.*;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;

import java.util.List;

@Configuration
public class SecurityChainReporter {

    @Bean
    ApplicationListener<ApplicationReadyEvent> reportChains(FilterChainProxy proxy) {
        return event -> {
            List<SecurityFilterChain> chains = proxy.getFilterChains();
            StringBuilder sb = new StringBuilder("\n════════ Security Filter Chain ════════\n");
            sb.append("共 ").append(chains.size()).append(" 條 chain\n");

            int c = 0;
            for (SecurityFilterChain chain : chains) {
                List<Filter> filters = chain.getFilters();
                String matcher = chain.toString()
                        .replaceAll(".*RequestMatcher=(.*?), Filters=.*", "$1");
                sb.append("\n  chain[").append(c++).append("]  matcher = ").append(matcher)
                  .append("   （").append(filters.size()).append(" 個 filter）\n");

                if (filters.isEmpty()) {
                    sb.append("      ⚠️ 這條 chain 沒有任何 filter —— 這是 web.ignoring() 的形狀\n");
                }
                int i = 0;
                for (Filter f : filters) {
                    sb.append(String.format("      %2d. %s%n", ++i, f.getClass().getSimpleName()));
                }
            }
            sb.append("═══════════════════════════════════════");
            System.out.println(sb);
        };
    }
}
```

**它會抓到四種常見的設定錯誤，而且是在啟動時**：

```
① chain 數量不對          → 你以為有兩條，實際只有一條（少寫 @Order）
② 某條 chain 的 filter 是 0 → web.ignoring() 把路徑整段排除了（01 章 1.7.4）
③ chain 裡少了認證 filter   → 0.5.1 那個「所有請求 401 但沒辦法登入」的形狀
④ 順序不對                → 01 章 1.7.3 那個「第二條 chain 永遠不生效」
```

⚠️ **不要把這個 bean 帶上正式環境**（它印出的資訊對攻擊者有用）。
用 profile 隔開：

```java
@Configuration
@Profile("!prod")                    // ← 加這一行
public class SecurityChainReporter { … }
```

📌 **01 章會把這個工具再擴充一次**，讓它同時印出「授權規則」與「每條 chain 的比對範圍」。

---

## 0.9 常見誤區

**誤區 1：「加了 Spring Security，系統就安全了」**

→ 0.5.7 那張表：**六件事它沒幫你擋**，而且六件全部是跟商業邏輯有關的那些。
框架擋得住的是「每個系統都一樣」的攻擊，擋不住「只有你知道」的規則。

**誤區 2：「`authenticated()` 就是有做權限控管」**

→ 0.3.1：`authenticated()` 說的是「**要登入**」。
alice 登入之後照樣讀得到 bob 的訂單、刪得掉 bob 的訂單、打得開管理端點。
**認證與授權是兩個問題**（0.4.1）。

**誤區 3：「401 跟 403 差不多，回哪個都行」**

→ 0.4.4：**前端會用它決定「要不要跳登入頁」**。
角色不足回 401，會造成「登入之後一直被登出」的無限迴圈。
而且 0.4.2 實測：**密碼打錯是 401 不是 403**。

**誤區 4：「MD5 不安全，改用 SHA-256 就好」**

→ 0.7.3 實測：**SHA-256 在 Apple M2 上比 MD5 還快**（0.486 µs vs 0.565 µs）。
密碼儲存要的性質是**慢**，不是「哪一種雜湊」。

**誤區 5：「密碼加鹽就安全了」**

→ 0.7.1 層次 ③：加鹽解決的是「一張表破解全部」，
沒有解決「針對單一帳號的暴力破解很便宜」。SHA-256 加鹽之後，
攻擊者對**一個**帳號一秒仍可試 205 萬次。

**誤區 6：「密碼政策夠嚴就不用擔心」**

→ 0.3.3：`Taipei2026!` 完全符合嚴格政策，**照樣被反查出來**。
密碼政策防的是「猜」，反查表防的是「查」——**兩者無關**。

**誤區 7：「BCrypt 的 cost 越高越好」**

→ 0.7.4：cost=12 在每秒 100 次登入下會吃掉 27.7 個執行緒，
促銷尖峰時會把整個服務拖垮。**這是安全性與可用性的取捨，不是「越高越對」。**

**誤區 8：「`csrf().disable()` 是標準寫法」**

→ 0.5.6：判準是「**身分靠什麼攜帶**」。
Cookie / Session / Basic → 不可以關；`Authorization: Bearer` → 可以關。
**很多專案是先關掉才發現能動，然後就再也不敢碰了。**

**誤區 9：「Filter 裡的例外可以用 `@RestControllerAdvice` 接」**

→ 0.3.5 實測：**接不到，一次都接不到**。
`@RestControllerAdvice` 掛在 `DispatcherServlet` 上，Filter 在它外面。
沒放行 `/error` 的話，你會拿到一個**空的 401**——而它的真正意思是
「你沒有權限看錯誤頁面」。

**誤區 10：「`permitAll()` 表示 Security 不會對這支端點做事」**

→ 0.5.2：`AuthorizationFilter` 是**第 16 個**，前面 15 個照跑。
所以 0.3.2 那個全開的設定**還是會送安全標頭**——
**「Security 看起來還在」正是那個 TODO 活過上線的原因。**

**誤區 11：「Spring Security 5 的寫法在 6 上照樣能動」**

→ 0.3.6：`SecurityContextHolder.setContext()` 在 6.x **不會存進 session**。
登入端點回 200，但沒有發 cookie，下一個請求是匿名的。
還有 `AuthenticationManager` 不再自動註冊成 bean。

**誤區 12：「登入失敗回一樣的訊息就不會洩漏帳號」**

→ 0.3.4：回應一模一樣，**時間差 22873 倍**。
一致性要做到「執行路徑一致」，不只是「回傳值一致」。

---

## 0.10 本章小結

**這一章沒有教任何一個 Spring Security 的設定技巧。** 它做的是四件事：

**一、把「安全」拆成兩個可以分別回答的問題（0.4）。**

```
你是誰？        → 認證 → AuthenticationManager → 401
你能做什麼？     → 授權 → AuthorizationManager  → 403
這筆資料是你的嗎？ → 資源層授權 → ★ 你自己的程式碼 → 404 / 403
```

**第三個問題沒有框架幫你回答**，而它是 OWASP API Top 10 的第一名。

**二、量出「預設幫你擋了什麼」（0.5）。**

```
16 個 Filter、6 個安全標頭、session fixation 防護、CSRF token
—— 全部是零設定就有的
而它【沒有】幫你擋的六件事（0.5.7），全部跟你的商業邏輯有關
```

**三、把「密碼不能用 MD5」變成數字（0.7）。**

```
MD5        1000 萬筆反查表 5.4 秒建好，反查 3 個帳號 307 µs
BCrypt-10  每個候選 69 ms，同樣 1000 萬個候選要 8 天（而且每個帳號重來一次）
差距       12 萬倍
```

**四、建好接下來九章的基礎設施（0.8）。**

```
一個不會替你美化回應的 Http 工具   → 讓 302 不會被偽裝成 200
一個啟動時印出 Filter Chain 的 bean → 讓 0.3.2 那類事故有訊號
三個帳號、三張訂單                → 其中兩個帳號【同角色】，才測得出資源層授權
```

### 0.10.1 驗收清單

讀完這一章，你應該可以不看書回答：

```
□ 401 與 403 各自在什麼情況出現？「密碼打錯」是哪一個？
□ 為什麼 CSRF 檢查失敗，未登入時拿到的是 401 而不是 403？
□ 授權有三層，第三層是什麼？為什麼授權矩陣測試蓋不到它？
□ 只加一個 starter 之後，預設有幾個 Filter？授權是第幾個？
□ 為什麼 permitAll 之後回應裡還有 X-Frame-Options？
□ x-xss-protection 為什麼是 0 而不是 1？真正防 XSS 的是什麼？
□ 同一支端點，為什麼瀏覽器拿到 302、fetch 拿到 401？
□ session fixation 是什麼？Spring Security 預設怎麼防？
□ 為什麼說「SHA-256 取代 MD5」沒有解決問題？
□ BCrypt 的 cost 每 +1 慢多少？要怎麼決定設多少？
□ {bcrypt} 這個前綴解決了什麼問題？沒有它會拿到什麼錯誤訊息？
□ BCrypt 的密碼長度上限是多少？中文密碼可以幾個字？
□ Filter 裡拋的例外，@RestControllerAdvice 接得到嗎？前端會看到什麼？
□ Spring Security 6 的「explicit save」改了什麼？什麼症狀？
```

### 0.10.2 本章練習

**練習一（動手）：重現 0.3.1 的 IDOR，並把它修好**

1. 照 0.8.1 建專案，把 0.3.0 那組類別放進去。
2. 用 0.3.1 的 `S1_AuthenticatedOnly` 設定啟動，用 `Http` 重現那六行輸出。
3. **不要用 `@PreAuthorize`**（03 章才教），只用 0.4.3 那段 `OwnershipAwareController` 的做法修好。
4. 修好之後，回答：`GET /api/orders`（列表）要怎麼修？它跟單筆查詢的修法一樣嗎？

> 提示：列表的修法有兩種，一種是「查全部再過濾」，一種是「一開始就只查自己的」。
> 兩種在資料量大的時候差別很大——**06 站 04 章那一整章的分頁討論在這裡會回來咬你**。

**練習二（動手）：量你自己機器的 BCrypt cost**

1. 跑 0.7.3 那段程式碼，記下 cost=10 / 12 / 14 的數字。
2. 如果你有雲端主機（或用 Docker 限制 CPU：`docker run --cpus=1 ...`），在上面再跑一次。
3. 用 0.7.4 的三步判準，決定你的專案該用哪個 cost，**並把理由寫成一行註解**。

**練習三（動手）：把 401 與 403 的格式統一**

1. 用 0.4.2 的 `UnifiedErrorFormat` 讓 401 / 403 都回 JSON。
2. 加上 0.3.5 的 `TokenFilter`，確認**Filter 拋的例外仍然不是那個格式**。
3. 想辦法讓它也變成同一個格式。

> 提示：有兩條路——在 Filter 裡自己 try-catch 並呼叫 `AuthenticationEntryPoint`，
> 或者把 Filter 移到 `ExceptionTranslationFilter` 之後（0.3.5 的第三個變體）。
> **兩條路各有代價**，01 章 1.8.5 會比較。

**練習四（讀原始碼）：找出 401/403 的分界點**

打開 `org.springframework.security.web.access.ExceptionTranslationFilter`，
找到 `handleAccessDeniedException` 方法，回答：

- 它怎麼判斷「目前是不是匿名」？（提示：`AuthenticationTrustResolver`）
- 「記住我」（remember-me）的身分算不算「已認證」？為什麼這件事會影響狀態碼？

**練習五（思考題）：資源不存在時該回什麼**

0.4.3 說「資源存在與否本身是機密 → 回 404」。

- 如果 alice 打 `GET /api/orders/9999`（**真的不存在**），該回什麼？
- 如果 alice 打 `GET /api/orders/1002`（**存在但不是她的**），該回什麼？
- 這兩個如果回不一樣，攻擊者能推論出什麼？
- 那如果**都回 404**，合法使用者要怎麼分辨「打錯 id」跟「沒權限」？

> 這題沒有標準答案，但你的答案應該包含「這取決於 id 猜不猜得到」這個變數。

---

## 0.11 下一章預告

**01 章：架構與 Filter Chain。**

這一章反覆出現了一句話：**「這取決於 Filter 的位置。」**

```
0.3.5  同一個 Filter 放三個位置 → 三種行為（401 / 500 / 401）
0.4.4  CSRF 失敗回 401 還是 403 → 取決於 ExceptionTranslationFilter 怎麼判斷
0.5.2  permitAll 還有安全標頭   → 因為授權是第 16 個，標頭是第 4 個
0.5.4  瀏覽器 302、App 401     → 因為 entry point 是可以分派的
```

**01 章要把這句話拆開，變成你可以預測的東西。** 它會處理：

| 01 章要回答的 | 為什麼現在還不能回答 |
|---|---|
| 那 16 個 Filter 各自做了什麼、順序為什麼是這樣 | 00 章只給了清單，沒給執行軌跡 |
| **一條 chain 到底是誰在跑**（`DelegatingFilterProxy` → `FilterChainProxy` → `VirtualFilterChain`） | 這決定了「你的 Filter 到底在誰的外面」 |
| **多條 chain 怎麼比對**——而且第一條匹配就結束 | 01 章 1.7.3 實測：順序寫反，第二條 chain **永遠不會執行** |
| `@Order` 不寫會怎樣 | 實測：**啟動不會報錯**，順序變成 bean 宣告順序 —— 比報錯更危險 |
| `SecurityContextHolder` 到底存在哪 | 實測：`@Async`、自己的執行緒池、`new Thread()` **三個都拿不到身分** |
| 自訂 Filter 標 `@Component` 又 `addFilterBefore` 一次 | 實測：**它跑了兩次**（而 `OncePerRequestFilter` 救了你一半） |
| `permitAll()` 與 `web.ignoring()` 差在哪 | 實測：其中一個讓**安全標頭整組消失** |

**還有一個 00 章刻意跳過的問題**：

```java
.addFilterBefore(myFilter, UsernamePasswordAuthenticationFilter.class)
```

**這一行裡的 `UsernamePasswordAuthenticationFilter.class` 是什麼意思？**
它是一個**位置的名字**——而 0.3.5 已經證明了，
**選錯這個名字，你的例外處理就整個失效。**

📌 **01 章結束時，你會有一張「16 個 Filter × 各自的職責 × 各自的可替換點」的地圖**，
而 00 章那六個事故裡的第五個（Filter 例外變成空的 401）**會在 1.8.5 被完整修好**。
