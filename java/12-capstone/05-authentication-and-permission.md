# 第 05 章：認證與權限：登入、token、資料層級權限與稽核

> 第 04 章結束時，每一支 API 都有一行 `CurrentUser user` —— 而它背後是 3.3.4 那個「本機才打開的 `X-Debug-User-Id`」。
> **任何人都可以說自己是任何人。** 第 04 章所有的 404、403，都建立在「大家都很誠實」這個假設上。
>
> **這一章把門鎖裝上。** 身分改由真的登入產生，權限從「慣例」變成「有測試守著的規則」，而每一次越權、每一次可疑的動作，都要留下紀錄。
>
> 這一章結束時，你手上會有：
>
> - **7 支新的 API**（5.3.1）：註冊、登入、refresh、`GET /api/me`，以及管理員的授權、停權、查稽核。
> - **一條 `SecurityFilterChain`**（5.5）：0.8 的「路徑前綴 → 角色」表原封不動搬進來，表上沒有的路徑一律拒絕。
>   `X-Debug-User-Id` 刪除了，`CurrentUser` 的型別沒變 —— **第 03、04 章的 Controller 一行都沒有改**。
> - **兩個覆蓋掃描**：32 支 API 逐一檢查「匿名打得到哪些、有沒有哪一支沒有規則」（5.5.5）；11 支帶資源 id 的 API 逐一用「別人」的身分打一次（5.8.2）。
> - **驗收 Q5 變綠**（5.8.4）：`Skipped` 從 6 變成 5。
> - **稽核**（5.9）：9 種動作、三種寫法。第 04 章留下的三個「第 05 章寫進 `audit_logs`」全部兌現。
> - **登入失敗鎖定**（5.6）：0.6.3 那個「Redis 掛了要不要鎖」的取捨，寫成程式，而且真的把 Redis 停掉量過。
>
> 這一章的主題是**信任**：誰可以進門、進門之後可以碰什麼、碰了之後留下什麼。
> 安全的 bug 跟併發的 bug 有一個共同點：**功能測試全綠**。登入成功、下單成功、別人的訂單也確實是 404 —— 問題出在「攻擊者會做、正常使用者不會做」的那些事。
> 所以這一章的每一個事故，都是站在攻擊者那一邊實際做一次、量出來的：
>
> - **加上 Spring Security 的那一刻**（5.2.1）：只加依賴，readiness 還是 200；**寫下第一個 `SecurityFilterChain` 的那一刻**，readiness 變成 401 —— 負載平衡器會把每一台都摘掉。
>   同一份設定裡明明 `permitAll` 的金流回呼與登入也是 401，真正的原因（CSRF 的 403）被 `/error` 蓋掉了。
> - **403 洩漏了什麼**（5.2.2）：一個沒有任何訂單的買家，**6.5 秒猜了 20,000 個訂單編號**，從 21 個 403 估出「這家店一天約 1,050 張訂單」（實際 1,187）。
> - **登入的三個洞**（5.2.3）：
>   - 「帳號不存在」比「密碼錯誤」快了 **73.7 ms** —— 回應時間就告訴你這個 email 有沒有註冊過。
>   - 失敗 5 次就鎖定，但 MySQL 認為 `bùyer`、`ｂｕｙｅｒ` 跟 `buyer` 是同一個帳號：用 20 個變體各猜 5 次，**猜了 100 次，帳號沒有被鎖**。
>   - 50 個請求同時送出：**50 個全部通過「失敗幾次了？」的檢查**，規則是 5 次。
> - **同一個 refresh token 同時送出**（5.2.4）：10 個同時送，**換出 10 個都還活著的新 token**，50 輪全部如此。重放偵測一次都沒有觸發。
> - **稽核跟著交易走**（5.2.5）：付款回呼簽章錯誤 → 401，`audit_logs` **0 筆**；金額不符 → ERROR 日誌有、稽核 **0 筆**。
>   反過來的寫法：賣家取消一張**已出貨**的訂單，回 409 —— 稽核卻記下了一筆「賣家已取消」。
>
> ⚠️ **還有三個，是寫這一章的途中被這一章自己的測試抓到的**：
>
> - **404 一樣、時間不一樣**（5.8.3）：「存在但不是你的」比「不存在」多寫一筆稽核，**慢了 2 ms**。一次請求就有 **94～98%** 的機率分得出來 —— 404 的規則被回應時間打穿了。
> - **覆蓋掃描的第一版**（5.5.5）：把路徑變數代入 `1` 打每一支 API，結果 `POST /api/admin/users/1/suspend` 回了 200 —— **種子資料的管理員被停權了**。
> - **Redis「停掉」和「卡住」不一樣**（5.6.4）：我原本以為 Redis 掛了，每次登入都要等 500 ms 的逾時。`docker stop` 量了 5 次，4 次是立刻失敗；改用 `docker pause` 才每次都等滿逾時。
>
> 另外還有幾個比較小、但一樣是實測到的坑：
>
> - 非 Web 的 context（`OrderFlowTest`、驗收 Q6）裡沒有 `HttpSecurity`，加上 `SecurityConfig` 之後 14 個測試全部起不來（5.5.2）。
> - Spring Security 預設的 JWT 驗證器容許 **60 秒**的時鐘誤差：「15 分鐘」的 token 實際上活 16 分鐘（5.5.4）。
> - BCrypt 只看前 72 bytes：註冊時的密碼是 93 bytes，用「前 72 bytes 一樣、後面完全不同」的密碼登入 → **通過**（5.4.2）。
> - 信任 `X-Forwarded-For` 的設定下，同一台機器換 25 個 header 值登入 25 次，**IP 限流一次都沒有觸發**（5.6.4）。
> - Connector/J 預設的 `INSERT ... ON DUPLICATE KEY UPDATE` 在「什麼都沒改」時也回報 1 列（5.10）。
>
> 以及**沒達成、部分達成的**：
>
> - US-ORD-2 AC-4（金額不符）與 US-ORD-5 AC-4（越權次數）的**告警**：稽核寫進去了、偵測的 SQL 也有了，告警留給第 09 章（5.8.4、5.11.3）。US-ORD-6 AC-5 的通知在第 07 章。
> - 0.6.5 的限流只做了登入的「每 IP 每分鐘 20 次」，而且是**單機**的；全站與下單的限流在第 06 章（5.6.4）。
> - 0.6.3「登入 × Redis 掛了」：fail-open 與退避做了，「並告警」只做到一個計數器 `shop.login.lockout.degraded`（5.6.4）。
> - 兩種 404 的回應時間差沒有完全消除：一次請求猜對的機率還有 53～55%（5.8.3）。
> - US-ACC-3 AC-3（第一個管理員）只有手動的 `boot-test.sh`，自動化在第 08 章（5.10）。
> - 強制下架（`POST /api/admin/products/{id}/takedown`）沒有做，留給練習六（5.3.1）。
> - `audit_logs.trace_id` 現在寫的都是 NULL，等第 09 章把 traceId 放進 MDC（5.9.2）。

---

## 5.1 學習目標

完成本章後，你應該可以：

- 說出加上 `spring-boot-starter-security` 之後、與寫下第一個 `SecurityFilterChain` 之後，Spring Boot 的預設行為各改變了什麼（5.2.1）。
  - readiness 為什麼「只加依賴」時是 200、「寫了自己的 chain」之後變 401。
  - 為什麼 `permitAll` 的 POST 拿到 401，而真正的原因是 CSRF 的 403。
- 用 5.2.2 的數字解釋「存在但不屬於你 → 404，不是 403」這條規則在保護什麼，以及它**沒有**保護什麼（5.8.3 的時間差、ORD-5 AC-4 的告警）。
- 寫出一個不洩漏帳號是否存在的登入（5.6.1），並說出 AC-2「回應時間差 < 50 ms」是怎麼被量出來的。
- 說出登入失敗鎖定的兩個順序問題：**先佔名額再驗密碼**（5.6.2）、**鎖定的 key 跟查詢的 key 是同一個等價關係**（5.6.3）。
- 說出 0.6.3「登入 × Redis 掛了」那一格的取捨，以及「停掉」與「卡住」對延遲的不同影響（5.6.4）。
- 用 0.5.5 那條硬規則（條件式 UPDATE + 影響列數）寫出 refresh token rotation，並說出重放偵測讓「兩個分頁同時 refresh」付出什麼代價（5.7）。
- 把「別人的資源一律 404」從慣例變成一個元件、一張矩陣、一個覆蓋掃描（5.8），並讓**驗收 Q5** 變綠。
- 為每一種稽核選對寫法：跟著業務交易、獨立 commit、還是背景寫入 —— 並說出選錯時各會發生什麼事（5.2.5、5.9）。

---

## 5.2 先看見痛：安全的 bug，功能測試看不到

### 5.2.0 實驗環境

本章有八個實驗，命名接著第 04 章的 E1～E7：F1～F8。一樣標 `@Tag("experiment")`，要用 `experiments` profile 指定：

```bash
mvn test -Pexperiments -Dtest=F3LoginAttacksTest
```

| 實驗 | 放在哪裡 | 用什麼 | 量什麼 |
|---|---|---|---|
| F1 加上 Spring Security | `ch05/` + `lab/ch05/` | 啟動整個應用程式三次，**打真的 HTTP** | 同一組請求在三個階段的狀態碼、header、body |
| F2 猜訂單編號 | `ch05/` + `lab/ch05/` | 啟動整個應用程式，打真的 HTTP | 403 版與 404 版，攻擊者各拿到什麼 |
| F3 登入的三個洞 | `account/internal/` | 正式的 `LoginService` vs「照直覺寫」的版本 | 回應時間、拿受害者的雜湊比對了幾次 |
| F4 refresh 同時送 | `account/internal/` | 正式的 `LoginService.refresh()` vs 先讀再寫 | 每一輪換到幾個新 token、還活著幾個 |
| F6 兩種 404 的時間 | `ch05/` | 啟動整個應用程式，打真的 HTTP | 「存在但不是你的」vs「不存在」的回應時間 |
| F7 Redis 掛了的登入 | `account/internal/` | 正式的 `LoginService`，**真的 `docker stop` / `docker pause`** | 每一次登入的延遲與結果 |
| F8 兩個小事實 | `ch05/` | BCrypt、Connector/J | 72 bytes、`ON DUPLICATE KEY UPDATE` 的回報列數 |

（F5 不是實驗：5.2.5 的事故是用正式的回歸測試 `AuditPlacementTest` 抓到的，跟第 04 章 4.5.2、4.5.3 一樣，先寫第一版、看它紅。）

三個細節：

- **F3、F4、F7 放在 `account.internal` 套件裡**，因為它們要直接呼叫 package-private 的 `LoginService`、`Accounts`、`RefreshTokens` —— 跟 E5、E6 放在 `ordering.internal` 是同一個理由（4.2.0）。
- **F3、F7 每一次登入都帶不同的 IP**（`203.0.113.x`、`198.51.100.x`，RFC 5737 保留給文件用的位址）。正式版有一個「每 IP 每分鐘 20 次」的限流（5.6.4），這兩個實驗量的是**帳號鎖定**，不是 IP 限流。
- **「照直覺寫」的版本不放進正式程式碼**：F3、F4 的 `naive*` 方法寫在實驗類別裡，F1、F2 的對照組放在 `lab/ch05/`（`com.example.lab` 不在 `ShopApplication` 的 component scan 範圍內，2.2.0）。
- **F2、F6 需要第 02 章的種子資料**（2.8.2：2026-08-12 那一天的訂單、別人的訂單）。**F7 會真的停掉 Redis**：它從 Java 呼叫 `docker stop` / `docker pause`，跑完再 `docker start` / `docker unpause`，對象是 `shop-redis-1` —— `compose.yaml` 的 `name: shop` 加上服務名 `redis`，就是這個容器名稱。跑之前用 `docker ps` 確認名稱一樣、`docker` 在 PATH 上。**F8 的第二部分連 `shop_lab`**（2.2.0，帳密 `shop/shop`），自己建、自己刪一張 `f8_roles`。
- 每一個實驗類別（以及 `lab/ch05/` 的對照組）的完整程式碼在 5.12.1。正文只摘了跟結論有關的那一段。

### 5.2.1 事故一：加上 Spring Security 的那一刻 ★★★

第 03 章的 `CurrentUserResolver` 用一個 interceptor 檢查角色。這一章要換成 Spring Security —— 第一步是在 `pom.xml` 加一行：

```xml
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>
```

**什麼都還沒設定**，先啟動、打幾支 API。F1 把同一組請求在三個階段各打一次：

- **A**：只加依賴，沒有任何自己的 `SecurityFilterChain`（Spring Boot 的預設）。
- **B**：第一個自己寫的 `SecurityFilterChain`，「照教學寫」（下面那段 `TutorialSecurityConfig`）。
- **C**：本專題的 `SecurityConfig`（5.5）。

三個階段用同一個 `ShopApplication`。A、B 要把本專題的 `SecurityConfig` 排除在 component scan 之外 —— 用的是 `TypeExcludeFilter`，跟 `@SpringBootTest` 排除 `@TestConfiguration` 是同一個機制：

```java
SpringApplicationBuilder b = new SpringApplicationBuilder(sources.toArray(Class[]::new));
if (excludeShopSecurity) b.initializers(ctx -> ctx.getBeanFactory().registerSingleton("f1Exclude", new TypeExcludeFilter() {
    @Override
    public boolean match(MetadataReader r, MetadataReaderFactory f) {
        return r.getClassMetadata().getClassName().startsWith(SHOP_SECURITY);
    }
    // equals / hashCode：TypeExcludeFilter 要求子類別自己實作（context 快取用）
}));
```

B 階段的設定，是你在大部分 JWT 教學裡會看到的第一版：

```java
@Configuration
public class TutorialSecurityConfig {

    @Bean
    SecurityFilterChain tutorialChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/auth/**").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                        .requestMatchers("/api/payments/callback").permitAll()
                        .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults());
        return http.build();
    }
}
```

看起來沒有問題：登入、商品、金流回呼公開，其他的要登入。

```bash
mvn test -Pexperiments -Dtest=F1SecurityStarterTest
```

```
═══ A：只加 spring-boot-starter-security ═══
  GET  /actuator/health/readiness      200                                           {"status":"UP","components":{"db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}}
  GET  /api/products?size=1            401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
  GET  /api/products/1                 401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
  GET  /api/orders（沒帶身分）               401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
o.s.security.web.csrf.CsrfFilter         : Invalid CSRF token found for http://localhost:64607/api/payments/callback
o.s.s.w.access.AccessDeniedHandlerImpl   : Responding with 403 status code
  POST /api/payments/callback          401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
o.s.security.web.csrf.CsrfFilter         : Invalid CSRF token found for http://localhost:64607/api/auth/login
o.s.s.w.access.AccessDeniedHandlerImpl   : Responding with 403 status code
  POST /api/auth/login                 401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
  GET  /api/products?size=1（瀏覽器）       302  Location: /login Set-Cookie: JSESSIONID  （空）
═══ B：第一個自己寫的 SecurityFilterChain（照教學寫） ═══
  GET  /actuator/health/readiness      401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
  GET  /api/products?size=1            200                                           {"content":[{"id":6932,"name":"降噪耳罩式耳機 #6932","price":99.00,"categoryId":11}],"page":0,"size":1,"totalElements
  GET  /api/products/1                 200                                           {"id":1,"sellerId":2,"name":"濾掛咖啡 #1","description":"「濾掛咖啡 #1」的商品說明。","price":149.00,"categoryId":52,"status":
  GET  /api/orders（沒帶身分）               401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
o.s.security.web.csrf.CsrfFilter         : Invalid CSRF token found for http://localhost:64687/api/payments/callback
o.s.s.w.access.AccessDeniedHandlerImpl   : Responding with 403 status code
  POST /api/payments/callback          401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
o.s.security.web.csrf.CsrfFilter         : Invalid CSRF token found for http://localhost:64687/api/auth/login
o.s.s.w.access.AccessDeniedHandlerImpl   : Responding with 403 status code
  POST /api/auth/login                 401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID （空）
  GET  /api/products?size=1（瀏覽器）       406                                           {"type":"about:blank","title":"Not Acceptable","status":406,"detail":"Acceptable representations: [application
```

（`DEBUG` 那幾行是 F1 為了看清楚原因，把 `CsrfFilter` 與 `AccessDeniedHandlerImpl` 的日誌等級打開。日誌前面的時間戳記已省略。）

**A 階段：全站 401，除了 health**

只加依賴，Spring Boot 會自動設定一條「所有請求都要登入」的 chain，用 HTTP Basic 與表單登入，帳號是 `user`、密碼在啟動日誌裡（F1 把日誌等級調成 WARN，這段是另外用 `java -jar` 啟動時的日誌）：

```
Using generated security password: bea6e1c4-f543-4981-b64c-b8bbeea59b81

This generated password is for development use only. Your security configuration must be updated before running your application in production.
```

商品、訂單、金流回呼、登入，全部 401。瀏覽器的請求被 302 轉到一個不存在的 `/login` 頁面。每一個回應都帶 `Set-Cookie: JSESSIONID` —— 一個「無狀態」的 API 開始建 session 了（[09-spring-security/04](../09-spring-security/04-session-vs-stateless-and-csrf.md) 的 4.2.4）。

**但 readiness 是 200。** 這是我原本沒預期到的：Spring Boot 有另一個自動設定 `ManagementWebSecurityAutoConfiguration`，預設放行 health 端點（`/actuator/health` 與 `/actuator/health/**`；3.2.5 不放行 `/actuator/info`）。只加依賴的那一刻，負載平衡器還看得到你。

**B 階段：自己寫了一條 chain，readiness 變成 401**

這是這個事故最危險的地方。`ManagementWebSecurityAutoConfiguration` 的條件是「**沒有**任何自己的 `SecurityFilterChain`」—— 你寫了第一條，它就退場了。`/actuator/health/readiness` 落進 `anyRequest().authenticated()`，變成 401。

0.10.6 把 readiness 定義成「負載平衡器要不要把流量送給我」。Kubernetes 的 readiness probe 收到 401 會判定「沒有準備好」—— **每一台都一樣**，所以每一台都被摘掉。0.6.3 那一整張降級矩陣，連同 0.10.5 那個「Redis 停掉整站 503」的事故，換一個方式重演了一次：這次是**一行安全設定讓整站 503**。

而且它在本機完全看不出來：你用 `curl` 打 API、用瀏覽器點頁面，一切正常。**只有負載平衡器在打 readiness。**

**B 階段的第二個問題：`permitAll` 的 POST 是 401**

設定裡明明寫了 `.requestMatchers("/api/payments/callback").permitAll()`，回呼卻是 401；`/api/auth/**` 也 `permitAll` 了，登入一樣 401。

日誌說出了真相：`Invalid CSRF token found` → `Responding with 403 status code`。**CSRF 防護預設是開的**，任何不帶 CSRF token 的 POST 都被 `CsrfFilter` 擋下，回 403。

那為什麼客戶端看到的是 401？因為 403 是用 `response.sendError(403)` 送出的，Servlet 容器會把它轉發到 `/error` 去產生錯誤頁 —— 而 `/error` 這個路徑落進了 `anyRequest().authenticated()`。匿名的請求要進 `/error` → 沒登入 → **401**。

用一個只多一行的設定驗證（`TutorialSecurityConfigWithErrorPage`，把 `/error` 也 `permitAll`）：

```
═══ B'：同上，加一行 /error permitAll ═══
  GET  /actuator/health/readiness      401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID {"timestamp":"2026-10-01T07:21:45.297+00:00","status":401,"error":"Unauthorized","path":"/actuator/health/read
  GET  /api/products?size=1            200                                           {"content":[{"id":6932,"name":"降噪耳罩式耳機 #6932","price":99.00,"categoryId":11}],"page":0,"size":1,"totalElements
  GET  /api/products/1                 200                                           {"id":1,"sellerId":2,"name":"濾掛咖啡 #1","description":"「濾掛咖啡 #1」的商品說明。","price":149.00,"categoryId":52,"status":
  GET  /api/orders（沒帶身分）               401  WWW-Authenticate: Basic realm="Realm"  Set-Cookie: JSESSIONID {"timestamp":"2026-10-01T07:21:45.341+00:00","status":401,"error":"Unauthorized","path":"/api/orders"}
o.s.security.web.csrf.CsrfFilter         : Invalid CSRF token found for http://localhost:64771/api/payments/callback
o.s.s.w.access.AccessDeniedHandlerImpl   : Responding with 403 status code
  POST /api/payments/callback          403  Set-Cookie: JSESSIONID                   {"timestamp":"2026-10-01T07:21:45.344+00:00","status":403,"error":"Forbidden","path":"/api/payments/callback"}
o.s.security.web.csrf.CsrfFilter         : Invalid CSRF token found for http://localhost:64771/api/auth/login
o.s.s.w.access.AccessDeniedHandlerImpl   : Responding with 403 status code
  POST /api/auth/login                 403  Set-Cookie: JSESSIONID                   {"timestamp":"2026-10-01T07:21:45.346+00:00","status":403,"error":"Forbidden","path":"/api/auth/login"}
  GET  /api/products?size=1（瀏覽器）       406                                           {"type":"about:blank","title":"Not Acceptable","status":406,"detail":"Acceptable representations: [application
```

真正的 403 露出來了。**一個錯誤藏在另一個錯誤後面**：你看到 401，會去檢查 token、檢查 `permitAll` 的路徑有沒有寫錯 —— 而真正的原因是一個你沒有打開、卻預設開著的功能。

**B' 階段的第三個問題：錯誤回應不是 Problem Details**

`{"timestamp": ..., "status": 403, "error": "Forbidden", "path": ...}` 是 Spring Boot 的預設錯誤格式。第 03 章花了一整節（3.4）讓「每一個錯誤回應都是 Problem Details、`type` 來自 `ProblemType`」—— 但 `GlobalExceptionHandler` 是一個 `@RestControllerAdvice`，**它只看得到 `DispatcherServlet` 裡面丟出來的例外**。Spring Security 的 401、403 發生在 filter 裡，比 `DispatcherServlet` 還早（3.4.4 的 📌），`GlobalExceptionHandler` 根本不知道它們存在。

前端的錯誤處理是照 0.4.1 的 `type` 寫的。現在 401 與 403 沒有 `type` —— 前端會把它們當成「未知的錯誤」。

**C 階段：本專題的設定**

```
═══ C：本專題的 SecurityConfig（5.5） ═══
  GET  /actuator/health/readiness      200                                           {"status":"UP","components":{"db":{"status":"UP","details":{"database":"MySQL","validationQuery":"isValid()"}}
  GET  /api/products?size=1            200                                           {"content":[{"id":6932,"name":"降噪耳罩式耳機 #6932","price":99.00,"categoryId":11}],"page":0,"size":1,"totalElements
  GET  /api/products/1                 200                                           {"id":1,"sellerId":2,"name":"濾掛咖啡 #1","description":"「濾掛咖啡 #1」的商品說明。","price":149.00,"categoryId":52,"status":
  GET  /api/orders（沒帶身分）               401  WWW-Authenticate: Bearer                 {"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/api/orders"}
  POST /api/payments/callback          401                                           {"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"簽章不正確","instance":"/api/payments/cal
  POST /api/auth/login                 200                                           {"accessToken":"eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzaG9wIiwic3ViIjoiMTAwMSIsImV4cCI6MTc5MDg0MDIxOCwiaWF0IjoxNzkwO
  GET  /api/products?size=1（瀏覽器）       406                                           {"type":"about:blank","title":"Not Acceptable","status":406,"detail":"Acceptable representations: [application
```

readiness 回到 200；沒有任何 `Set-Cookie`；401 是 Problem Details 並帶 `WWW-Authenticate: Bearer`；回呼的 401 是**業務層**的「簽章不正確」（F1 送的簽章是 `"x"`），不是安全層擋下的 —— 請求確實走到了 `PaymentCallbackService`。

（最後一列的 406 跟安全無關：本專題的 API 只產生 JSON，瀏覽器的 `Accept: text/html` 沒有可以給的表示法。它也不是 Problem Details 的 `type` —— `HttpMediaTypeNotAcceptableException` 由 `ResponseEntityExceptionHandler` 的預設實作處理。這留給練習一。）

> 📌 **這個事故的教訓不是「記得放行 health」，而是「自動設定的退場條件」。**
> Spring Boot 的很多自動設定都是「你沒有定義某個 bean，我就幫你定義一個」。你一旦定義了自己的，**它幫你做的其他事情也一起消失**，包括你根本不知道它在做的事 —— 這裡是 health 的放行。
> 5.5.5 的 `SecurityRouteCoverageTest` 會把「每一支 API 的匿名行為」寫成測試，readiness 也在裡面（`/actuator/**` 不是 Controller，所以它由 F1 與 0.10.6 的 readiness 測試守著）。

### 5.2.2 事故二：403 洩漏了什麼 ★★

0.4.1 那段 📌 說：「存在但不屬於你」回 **404 不是 403** —— 回 403 等於告訴攻擊者「這個 id 存在」，對方就可以逐一枚舉，知道你一天有幾張訂單。

第 03 章照做了（3.6.2），但這句話一直是一個**論點**，沒有被量過。這一節把它量出來。

本專題的訂單編號是「台北日期 + 隨機 6 碼」（2.4.4），例如 `20260812-483915`。一天有 1,000,000 個可能的編號。種子資料裡，2026-08-12 那一天有 1,187 張訂單 —— 隨便猜一個編號，大約有 0.12% 的機率猜中。

F2 讓一個**沒有任何訂單的買家**（`990601`），用他自己合法的 token，猜 20,000 個 2026-08-12 的編號。對照組是一個「存在但不是你的 → 403」的版本（`lab/ch05/Lab403OrderController`，路徑放在 `/api/orders/lab403/` 底下，這樣它會套用到同一條 `hasRole("BUYER")` 的規則）：

```java
@GetMapping("/api/orders/lab403/{orderNo}")
Map<String, Object> one(CurrentUser user, @PathVariable String orderNo) {
    List<Long> buyer = jdbc.queryForList("SELECT buyer_id FROM orders WHERE order_no = ?", Long.class, orderNo);
    if (buyer.isEmpty()) throw ShopException.notFound("訂單");
    if (buyer.get(0) != user.id()) throw new ShopException(ProblemType.FORBIDDEN, "這不是你的訂單");
    return Map.of("orderNo", orderNo);
}
```

```bash
mvn test -Pexperiments -Dtest=F2OrderEnumerationTest
```

```
═══ 5.2.2 猜 20,000 個 20260812 的訂單編號（那一天實際有 1,187 張訂單；16 個並行）═══
  /api/orders/lab403/{no} 6.5 秒 │ 狀態 {403=21, 404=19979} │ body 長度（去掉編號）{403=[110], 404=[109]}
                         → 攻擊者的估計：21 / 20,000 × 1,000,000 ≈ 每天 1,050 張（實際 1,187）
  /api/orders/{no}       11.8 秒 │ 狀態 {404=20000} │ body 長度（去掉編號）{404=[102]}
  audit_logs：ACCESS_DENIED 21 筆（actor_id = 990601）；每分鐘 [{minute=07:22, n=21}]
```

（這個實驗跑了兩次，用同一個亂數種子，兩次都是同樣的 21 個編號；第一次是 6.8 秒與 14.4 秒。本專題的版本比較慢，是因為它多一句 `SELECT EXISTS`（5.8.1）—— 這裡比的不是速度。）

**403 版：6.5 秒，就知道這家店一天大約有多少訂單。**

21 個 403 = 21 張「存在、但不是我的」訂單。21 / 20,000 × 1,000,000 ≈ 1,050，跟實際的 1,187 差 12%。對競爭對手來說，這已經是一個很好的營收估計 —— 而他只需要註冊一個帳號、寫十行程式。
換一天、再猜 20,000 次，就有了每天的趨勢圖。

body 的長度也不一樣（110 vs 109 bytes）：就算你把狀態碼統一成 404，**訊息不同**一樣會洩漏。

**404 版：20,000 個一模一樣的回應。** 狀態碼一樣、去掉編號之後的 body 長度一樣（102 bytes）。攻擊者從回應裡得不到任何資訊。

**但伺服器知道。** 那 21 次「存在但不是你的」，每一次都留下了一筆 `ACCESS_DENIED`（US-ORD-5 AC-3，5.8）。**攻擊者什麼都沒得到，防守方卻知道了是誰、在什麼時候、試了哪些編號。**

> ⚠️ 注意最後一行：21 筆 `ACCESS_DENIED` 全部落在**同一分鐘**。US-ORD-5 AC-4 寫的告警門檻是「同一買家 1 分鐘內超過 20 次」—— 這次剛好多 1 次。
> 攻擊者只要把速度放慢到每分鐘 19 次，告警就不會響，而他每天還是可以猜 27,000 次。5.8.4 會回到這件事：**「每分鐘」是錯的時間窗**。

> 📌 **404 保護的是「存在與否」，不是「訂單內容」。** 訂單內容從來不會給別人看 —— 不管回 403 還是 404。
> 404 這條規則真正保護的，是那些**從「存在與否」推得出來的事**：營業量、某個時間點有沒有成交、某個客人是不是你的客戶。
> 而 5.8.3 會讓你看到：**只統一回應的內容是不夠的，回應的時間也會說話。**

### 5.2.3 事故三：登入的三個洞 ★★★

US-ACC-2 有兩條關於「攻擊者」的 AC：

- **AC-2**：密碼錯誤與帳號不存在，訊息**完全相同**、回應時間差 **< 50 ms**（防帳號列舉）。
- **AC-3**：同一帳號 15 分鐘內連續失敗 5 次 → 鎖定。

照著 AC 寫第一版，大部分人會寫出這樣的東西（F3 的 `naive*` 方法）：

```java
/** 帳號不存在 → 直接回 401（「省一次 BCrypt」） */
static Result naiveTiming(Ctx c, String email, String password) {
    Optional<String> hash = c.jdbc.queryForList("SELECT password_hash FROM users WHERE email = ?", String.class, email).stream().findFirst();
    if (hash.isEmpty()) return Result.WRONG;
    return c.encoder.matches(password, hash.get()) ? Result.OK : Result.WRONG;
}

/**
 * 先查「失敗幾次了」，沒超過才驗密碼，失敗再 +1。key 用 Java 的 toLowerCase；查使用者用 WHERE email = ?（欄位的 ai_ci 定序）。
 * @param guesses 每一次「真的拿受害者的雜湊去比對」就 +1 —— 這才是攻擊者得到的東西
 */
static Result naiveLockout(Ctx c, String email, String password, AtomicInteger guesses) {
    String key = "naive:fail:" + email.toLowerCase(Locale.ROOT);
    String n = c.redis.opsForValue().get(key);
    if (n != null && Integer.parseInt(n) >= 5) return Result.LOCKED;
    Optional<String> hash = c.jdbc.queryForList("SELECT password_hash FROM users WHERE email = ?", String.class, email).stream().findFirst();
    if (hash.isPresent()) guesses.incrementAndGet();
    if (hash.isPresent() && c.encoder.matches(password, hash.get())) return Result.OK;
    if (hash.isEmpty()) c.encoder.matches(password, "$2a$10$.Qqx4uLp33ami.WRNP./QedMLbVyOPUqXUuwqU7cbdiY9zOafkQQO");
    c.redis.opsForValue().increment(key);
    c.redis.expire(key, java.time.Duration.ofMinutes(15));
    return Result.WRONG;
}
```

兩個方法分開，是為了一次只看一個洞：`naiveTiming` 只有計時的問題；`naiveLockout` 已經補上了計時（帳號不存在時也做一次 BCrypt），只看鎖定的問題。
訊息兩者都沒問題 —— 不管哪一種失敗都回同一個 `WRONG`。

F3 拿它們跟正式的 `LoginService`（5.6）比。「攻擊者得到了什麼」用一個計數器量：**每一次真的拿受害者的密碼雜湊去比對**，就是攻擊者猜了一次。

```bash
mvn test -Pexperiments -Dtest=F3LoginAttacksTest
```

```
═══ 5.2.3 ① 登入的回應時間（各 100 次，依序；密碼都是錯的）═══
  naive  帳號不存在 p50   0.30 ms  p95   0.38 ms │ 密碼錯誤 p50  74.00 ms  p95  80.77 ms │ 差  73.70 ms
  ours   帳號不存在 p50  76.37 ms  p95 108.96 ms │ 密碼錯誤 p50  77.85 ms  p95  83.87 ms │ 差   1.48 ms
═══ 5.2.3 ② 30 個 email 變體（10 個大小寫、10 個重音、10 個全形），每個用錯的密碼登入一次 ═══
  naive  結果 {WRONG=25, LOCKED=5}         第一次被鎖在第 6   次 │ 拿受害者的雜湊比對了 25 次 │ 之後用正確密碼登入 → LOCKED
  ours   結果 {WRONG=25, LOCKED=5}         第一次被鎖在第 6   次 │ 拿受害者的雜湊比對了  5 次 │ 之後用正確密碼登入 → LOCKED
  （WHERE email = ? 對到受害者的變體數：{大小寫=10, 重音=10, 全形=10}）
── ②b 只用 20 個重音與全形的變體，每個各猜 5 次（100 次）──
  naive  結果 {WRONG=100}                  │ 拿受害者的雜湊比對了 100 次 │ 之後用正確密碼登入 → OK
  ours   結果 {WRONG=100}                  │ 拿受害者的雜湊比對了   0 次 │ 之後用正確密碼登入 → OK
═══ 5.2.3 ③ 50 個請求同時送出（同一個 email、錯的密碼、50 個不同的 IP）═══
  naive  第 1 輪 {WRONG=50}                 │ 拿受害者的雜湊比對了 50 次（規則：5 次）
  naive  第 2 輪 {WRONG=50}                 │ 拿受害者的雜湊比對了 50 次（規則：5 次）
  naive  第 3 輪 {WRONG=50}                 │ 拿受害者的雜湊比對了 50 次（規則：5 次）
  ours   第 1 輪 {WRONG=5, LOCKED=45}       │ 拿受害者的雜湊比對了  5 次（規則：5 次）
  ours   第 2 輪 {WRONG=5, LOCKED=45}       │ 拿受害者的雜湊比對了  5 次（規則：5 次）
  ours   第 3 輪 {WRONG=5, LOCKED=45}       │ 拿受害者的雜湊比對了  5 次（規則：5 次）
```

（① 跑了兩次：naive 的差是 73.86 ms、73.70 ms；正式版是 1.97 ms、1.48 ms。正式版「帳號不存在」那一欄的 p95 108.96 ms 只出現在第二次，第一次是 78.93 ms —— 那是雜訊，不是差異。）

**洞一：「省一次 BCrypt」省出了 73.7 ms 的差**

BCrypt cost 10 在這台機器上一次約 74 ms（這個數字本身就是安全設計：它讓暴力破解變慢）。帳號不存在時跳過 BCrypt，回應只要 0.3 ms。
**兩種失敗的訊息完全一樣，但一個 0.3 ms、一個 74 ms** —— 攻擊者不需要看 body，看碼表就好。拿一份外洩的 email 清單逐一試，就知道哪些人是你的客戶。

這個洞在 [09-spring-security/02](../09-spring-security/02-authentication-userdetails-password.md) 的 2.5.2、2.5.3 量過四種變形（`DaoAuthenticationProvider` 自己有一個 `mitigateAgainstTimingAttack`）。本專題的登入不經過 `DaoAuthenticationProvider`（5.6 解釋為什麼），所以要自己補上 —— 正式版的差是 1.5～2.0 ms，AC-2 的門檻是 50 ms。

**洞二：MySQL 說是同一個人，Redis 說是 30 個人**

最後一行是這個洞的根源：`WHERE email = ?` 用的是 `users.email` 欄位的定序 `utf8mb4_0900_ai_ci`。第 02 章選它，是為了讓 UNIQUE 不分大小寫（US-ACC-1 AC-2）。**但 `ai_ci` 的 `ai` 是 accent-insensitive**：不分重音。而且它是 Unicode 排序演算法（UCA）的「第一層」比較，全形字母跟半形字母也算同一個字。直接問 MySQL：

```
[BUYER00001@example.com]           → 1001
[bùyer00001@example.com]           → 1001
[ｂｕｙｅｒ00001@example.com]           → 1001
[buyer00001@example.com ]          → (no match)
[buyer00001@ëxample.com]           → 1001
[buyer00001@exämple.com]           → 1001
[bUyEr00001@EXAMPLE.COM]           → 1001
```

（`SELECT id FROM users WHERE email = ?`，代入左邊的字串。唯一沒有對到的是結尾多一個空白的那個 —— `0900` 系列的定序是 `NO PAD`，尾端空白算數。）

重跑方式：`docker exec -it shop-mysql-1 mysql --default-character-set=utf8mb4 -ushop -pshop shop`，再逐一執行 `SELECT id FROM users WHERE email = 'bùyer00001@example.com';` 這樣的查詢（加上 `--default-character-set=utf8mb4`，確保重音與全形字元原樣送到伺服器）。

（專題寫完之後，在第 05 章結束時的程式碼、一個全新的資料庫（灌了 2.8.3 的種子資料）上照這個方式重跑了一次：七個字串的結果跟上面一模一樣 —— 六個是 1001，結尾多一個空白的那個沒有對到。）

所以 30 個變體，MySQL 全部認為是同一個帳號；`naiveLockout` 的鎖定 key 用 Java 的 `toLowerCase`，**大小寫的 10 個變體合併成一個 key，重音與全形的 20 個各自是一個 key**：

- ②：前 10 個（大小寫）在第 6 次被鎖住 → 攻擊者又用 20 個重音、全形的變體各猜了一次。總共猜了 **25 次**。
- ②b：只用那 20 個變體，每個各猜 5 次 → **100 次**，每一個 key 都停在 5，**受害者的帳號從頭到尾沒有被鎖**（最後用正確密碼登入 → `OK`）。

一個 email 有多少個變體？`buyer00001` 這 10 個字元裡，`u`、`e` 各有好幾種重音寫法，每個字母都有全形版本 —— 組合起來是成千上萬個。**每多一個變體，攻擊者就多 5 次機會。**

正式版在兩個情境都只讓攻擊者猜到 5 次和 0 次。原因不是「key 改成更徹底的正規化」—— 而是**它讓「找得到這個帳號」的範圍，跟「鎖定計數」的範圍變成同一個**（5.6.3）。

**洞三：50 個人同時問「失敗幾次了？」，答案都是 0**

第 04 章的 4.2.1 ① 換了一個場景重演：`naiveLockout` 先 `GET` 計數、判斷「還沒到 5 次」、才去驗密碼（74 ms）、失敗才 `INCR`。
50 個請求同時送出，**50 個都在任何一個 `INCR` 發生之前讀到 0**。每一個都通過了檢查，每一個都拿受害者的雜湊比對了一次。三輪都是 50 次，規則是 5 次。

攻擊者只要能同時送出請求，鎖定規則就放大了 10 倍。而且 BCrypt 越慢，「讀計數」到「寫計數」之間的窗口就越大 —— **讓暴力破解變慢的那 74 ms，正好是這個洞的寬度**。

正式版是 5 次，因為它**先 `INCR`、再驗密碼**：每一個請求先佔一個名額，第 6 個起直接被拒絕，連 BCrypt 都不用做（5.6.2）。

> 📌 **三個洞有一個共同點：它們都在「查」和「做」之間。**
> 洞一：查「有沒有這個人」，決定「要不要做 BCrypt」。洞二：「查人」跟「查計數」用了兩套不同的規則。洞三：查計數跟寫計數之間隔了 74 ms。
> 這是第 04 章那句話的另一個版本：**不要相信你讀到的值** —— 這一次，攻擊者就是那個在你讀和寫之間動手的人。

### 5.2.4 事故四：同一個 refresh token 同時送出 ★★★

US-ACC-2 的 refresh token 有兩條規則：

- **AC-4 rotation**：用一次就作廢，換一個新的。
- **AC-5 重放偵測**：一個**已經用過**的 refresh token 又被用了 → 401，**並撤銷這個使用者所有的 refresh token**。代表 token 被偷了 —— 小偷跟本人至少有一個用了舊的那一個。

`refresh_tokens` 表在第 02 章就準備好了（`used_at`、`revoked_at`，資料庫只存 SHA-256）。照著 AC 寫：

```java
/** 照直覺寫：讀到「沒用過」→ 標記用過 → 發新的 */
static Result naive(JdbcTemplate jdbc, TransactionTemplate tx, RefreshTokens tokens, String raw) {
    return tx.execute(s -> {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT user_id, used_at, revoked_at, expires_at > CURRENT_TIMESTAMP(3) AS valid FROM refresh_tokens WHERE token_hash = ?",
                RefreshTokens.hash(raw));
        if (rows.isEmpty()) return Result.REJECTED;
        Map<String, Object> r = rows.get(0);
        if (r.get("used_at") != null || r.get("revoked_at") != null || ((Number) r.get("valid")).intValue() == 0) return Result.REJECTED;
        jdbc.update("UPDATE refresh_tokens SET used_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ?", RefreshTokens.hash(raw));
        tokens.issue(((Number) r.get("user_id")).longValue());
        return Result.NEW_TOKEN;
    });
}
```

（`expires_at > CURRENT_TIMESTAMP(3)` 在 SQL 裡比，是因為這個實驗的第一版把 `expires_at` 轉成 `Timestamp` —— 然後撞上 4.5.2 的 `ClassCastException: LocalDateTime cannot be cast to Timestamp`。同一個坑，這次是在實驗程式自己身上。）

一個交易、先檢查再寫入、單執行緒測起來完全正確：用過的 token 再送一次 → `REJECTED`。

F4 讓同一個 token 同時被送出 2 次（使用者開了兩個分頁、兩邊的 access token 同時過期）與 10 次（攻擊者），各 50 輪。每一輪結束時數一次：**這個使用者手上還有幾個活著的 refresh token**（`used_at IS NULL AND revoked_at IS NULL`）。

```bash
mvn test -Pexperiments -Dtest=F4ConcurrentRefreshTest
```

```
═══ 5.2.4 同一個 refresh token 同時送出（每種 50 輪）═══
  2 個同時 │ naive  │ {換到新 token  2 個、活著的 token  2 個=50}
  2 個同時 │ ours   │ {換到新 token  1 個、活著的 token  0 個=50}
  10 個同時 │ naive  │ {換到新 token 10 個、活著的 token 10 個=50}
  10 個同時 │ ours   │ {換到新 token  1 個、活著的 token  0 個=50}
```

**naive：10 個同時送，換出 10 個活著的 token。50 輪，每一輪都一樣。**

原因跟 4.2.1 的 ① 一樣：10 個交易幾乎同時 `SELECT`，在任何一個 `UPDATE` commit **之前**，10 個都讀到 `used_at IS NULL`（這跟隔離等級無關：讀的那一刻，還沒有任何人 commit）。之後的 `UPDATE ... WHERE token_hash = ?` 沒有條件，10 個依序成功，每一個都發了一個新 token。

這不只是「多發了幾個 token」。**AC-5 的重放偵測一次都沒有觸發**：它的前提是「第二個人會看到 `used_at` 已經有值」，而在這裡，沒有任何人看到。
小偷拿到 refresh token 之後，只要在本人 refresh 的同一瞬間也送一次，兩邊就各自拿到一條**獨立的、永遠不會被發現的** token 鏈。rotation 存在的唯一目的就是讓這件事不可能發生。

**正式版：只有 1 個成功，而且最後連它也活不下來。**

正式版用條件式 UPDATE（5.7.1）：只有一個交易的 `UPDATE ... WHERE used_at IS NULL` 影響 1 列，其他 9 個影響 0 列 → 用 `FOR UPDATE` 重讀，看到 `used_at` 已經有值 → **重放** → 撤銷這個使用者全部的 refresh token。

注意「活著的 token 0 個」：連贏家剛拿到的那一個也被撤銷了。這是 AC-5 字面上的意思（「撤銷該使用者**所有** refresh token」），也是「兩個分頁」那一列的代價：**一個正常使用者開了兩個分頁，就會被登出**。5.7.2 會討論這個取捨。

### 5.2.5 事故五：稽核跟著交易走 ★★★

第 04 章在三個地方留下了「第 05 章寫進 `audit_logs`」：付款回呼的簽章錯誤（US-ORD-2 AC-3）、金額不符（AC-4 的告警）、賣家取消（US-ORD-6 AC-5）。

US-AUD-1 AC-1 寫的是：「`audit_logs` 在**同一個交易**內寫入（業務動作 rollback，稽核也 rollback；但 `ACCESS_DENIED` 例外）」。照字面寫，第一版是這樣：

```java
// JdbcPaymentService.record()（第一版）：在回呼的交易裡（MANDATORY）
if (!CallbackSignature.matches(expected, cb.signature())) {
    log.warn("PAYMENT_SIGNATURE_INVALID paymentId={}", cb.paymentId());
    audit.record(AuditEntry.of(AuditAction.PAYMENT_SIGNATURE_INVALID, null, "PAYMENT_PROVIDER", "PAYMENT", cb.paymentId(),
            Map.of("providerTxnId", cb.providerTxnId())));
    throw new ShopException(ProblemType.UNAUTHENTICATED, "簽章不正確");
}
// ……金額不符的那一段一樣：audit.record(...) 然後 throw
```

`audit.record()` 是 `MANDATORY`：「必須在呼叫端的交易裡」（5.9.1）。看起來完全符合 AC-1。

賣家取消的第一版，則是「已經聽說過稽核會被 rollback」的人會寫的：用一個**獨立的交易**寫稽核（`recordRejection`，`REQUIRES_NEW`），確保它一定留下來：

```java
// OrderCommands.cancelBySeller()（第一版）
long id = sellers(sellerId, orderNo);
audit.recordRejection(AuditEntry.of(AuditAction.ORDER_CANCELLED_BY_SELLER, sellerId, Role.SELLER.name(), "ORDER", orderNo,
        Map.of("cancelReason", "SELLER_OUT_OF_STOCK")));
transitions.apply(id, OrderEvent.SELLER_CANCEL, OrderHistory.Actor.seller(sellerId), EventData.cancel("SELLER_OUT_OF_STOCK"));
```

`AuditPlacementTest`（5.9.3）的每一個情境都檢查兩件事：**回應是什麼**，以及 **`audit_logs` 裡剛好有幾筆**。用第一版跑：

```bash
mvn test -Dtest=AuditPlacementTest
```

```
AUD：簽章錯誤 → 401；PAYMENT_SIGNATURE_INVALID 0 筆
AUD：賣家取消 PAID → 成功；ORDER_CANCELLED_BY_SELLER 1 筆
AUD：賣家取消 SHIPPED → 409；ORDER_CANCELLED_BY_SELLER 1 筆（訂單狀態 SHIPPED）
AUD：別人的訂單（查詢 + 取消）→ 404；ACCESS_DENIED 2 筆；不存在的訂單 → 404；ACCESS_DENIED 0 筆
2026-10-01T15:01:42.105+08:00 ERROR 32983 --- [shop] [           main] c.e.s.p.internal.JdbcPaymentService      : PAYMENT_AMOUNT_MISMATCH paymentId=99070101 expected=100.00 actual=1.00
AUD：金額不符 → 400；PAYMENT_AMOUNT_MISMATCH 0 筆
[ERROR] Tests run: 5, Failures: 3, Errors: 0, Skipped: 0, Time elapsed: 4.449 s <<< FAILURE! -- in com.example.shop.ordering.internal.AuditPlacementTest
[ERROR] com.example.shop.ordering.internal.AuditPlacementTest.badSignature -- Time elapsed: 0.548 s <<< FAILURE!
expected: 1L
 but was: 0L
[ERROR] com.example.shop.ordering.internal.AuditPlacementTest.sellerCancelShipped -- Time elapsed: 0.090 s <<< FAILURE!
expected: 0L
 but was: 1L
[ERROR] com.example.shop.ordering.internal.AuditPlacementTest.amountMismatch -- Time elapsed: 0.057 s <<< FAILURE!
expected: 1L
 but was: 0L
```

**簽章錯誤：401，稽核 0 筆。** `audit.record()` 確實執行了、INSERT 確實送出了 —— 然後下一行 `throw`，回呼的交易 rollback，**那筆 INSERT 跟著一起消失**。
需要被稽核的，正好是**失敗**的那一次。而失敗就代表會 rollback。這一行程式碼永遠只會在「它的結果一定會被丟掉」的時候執行。

**金額不符：ERROR 日誌有，稽核 0 筆。** 輸出裡那一行 `PAYMENT_AMOUNT_MISMATCH` 的 ERROR 是第 04 章就有的。日誌在交易之外，所以它留下來了 —— 但**日誌不是稽核**（[09-spring-security/08](../09-spring-security/08-auditing-and-security-testing.md) 的 8.1.2）。日誌會輪替、會被取樣、格式隨時會改；稽核是一張有索引、可以讓管理員查詢的表（AUD-1 AC-3）。

**賣家取消一張已出貨的訂單：409，稽核卻寫著「已取消」。** 這是反過來的錯。`recordRejection()` 在狀態轉移**之前**、在**自己的交易**裡 commit 了；接著 `transitions.apply()` 查表發現 `SHIPPED` 不能取消 → 409 → 取消的交易 rollback。訂單還是 `SHIPPED`，稽核卻永遠留下一筆「賣家 2 取消了這張訂單」。
三個月後客服查這張訂單的稽核：「賣家取消了、但東西出貨了、錢也沒退」—— **稽核記下了一件沒有發生的事**。

> 📌 **AC-1 的那句話寫得不完整，但它的方向是對的。** 它說「業務 rollback，稽核也 rollback」，然後只為 `ACCESS_DENIED` 開了一個例外。
> 實際上要分的是兩種動作：
> - **成功了才算數的動作**（賣家取消、授權、改價）：稽核必須跟業務**同生共死** → 同一個交易。
> - **被拒絕的動作**（越權、簽章錯、金額不符、登入鎖定）：被拒絕就代表業務交易會 rollback → 稽核必須**在自己的交易裡**先 commit。
>
> `ACCESS_DENIED` 不是例外，它是第二類的第一個成員。5.9 會把這兩類寫成 `AuditLog` 介面上的兩個方法，0.4.9 的 AC-1 也照這個說法改寫。

---

## 5.3 本章的形狀

### 5.3.1 7 支新的 API

| 方法 | 路徑 | 角色 | 故事 | 成功時 |
|---|---|---|---|---|
| `POST` | `/api/auth/register` | 公開 | ACC-1 | **201**，回傳 `{id, email, displayName, roles}` |
| `POST` | `/api/auth/login` | 公開 | ACC-2 AC-1～3 | 200 `{accessToken, tokenType, expiresIn, refreshToken}` |
| `POST` | `/api/auth/refresh` | 公開（帶 refresh token） | ACC-2 AC-4～6 | 200，同上（兩個 token 都是新的） |
| `GET` | `/api/me` | 登入 | —— | 200，目前的使用者 |
| `POST` | `/api/admin/users/{id}/roles` | ADMIN | ACC-3 AC-1、2 | 200，回傳那個帳號 |
| `POST` | `/api/admin/users/{id}/suspend` | ADMIN | ACC-3、ACC-2 AC-6 | 200 |
| `GET` | `/api/admin/audit-logs` | ADMIN | AUD-1 AC-3 | 200，分頁 |

0.8 的 API 草案裡還有一支 `POST /api/admin/products/{id}/takedown`（強制下架），它沒有對應的使用者故事（0.8 那一列的「故事」欄是 ——），這一章沒有做，留給練習六。

兩個新的 Controller（`AuthController`、`AccountController`）與它們的請求、回應 DTO（`AuthDtos`）完整內容在 5.12.1。授權 API 的 body 是 `{"role": "SELLER"}`；登入的 IP 由 `AuthController` 從 `HttpServletRequest.getRemoteAddr()` 取出，再傳給 `LoginService.login()`（5.6.4）。

`OpenApiContractTest` 照例在第一次跑的時候紅了：

```
  △ 新增 GET /api/admin/audit-logs
  △ 新增 POST /api/admin/users/{id}/roles
  △ 新增 POST /api/admin/users/{id}/suspend
  △ 新增 POST /api/auth/login
  △ 新增 POST /api/auth/refresh
  △ 新增 POST /api/auth/register
  △ 新增 GET /api/me
  △ components（DTO 的欄位）有變動
```

**沒有任何一行「變更」**：既有的 25 支 API，契約一個字都沒動。`components` 的變動是新的 DTO，加上一個 `securitySchemes.bearer`（5.5.6）。確認之後更新快照：`mvn test -Dtest=OpenApiContractTest -Dopenapi.update=true`（`src/test/resources/openapi/shop-api.json` 不用手寫，就是這樣產生的）。

### 5.3.2 程式碼放在哪裡

```
com.example.shop
├── account/internal/            ← users、user_roles、refresh_tokens 的主人（0.3.4）
│   ├── AccountService             註冊、/api/me、授權、停權
│   ├── LoginService               登入、refresh
│   ├── LoginAttempts、IpLoginLimiter   鎖定（Redis）、IP 限流（單機）
│   ├── RefreshTokens、Accounts    兩張表的 SQL
│   ├── BootstrapAdmin             第一個管理員（5.10）
│   └── web/AuthController、AccountController
└── shared/
    ├── security/                ← 新的套件
    │   ├── AccessTokens           簽發 JWT（public：account 要用）
    │   └── SecurityConfig         驗證 JWT、路徑 → 角色、401 / 403 的格式
    ├── audit/                   ← 新的套件：audit_logs 的主人（0.3.4）
    │   ├── AuditLog、AuditEntry、AuditAction   公開的介面（每個模組都可以用）
    │   └── internal/JdbcAuditLog、AuditQuery、web/AuditLogController
    └── web/CurrentUserResolver  ← 改寫：從 JWT 產生 CurrentUser
```

兩個放置的決定：

**JWT 的簽發與驗證放在 `shared.security`，不放在 `account`。**
驗證必須在 `shared`：每一個模組的 API 都要經過它，而 1.6.2 的規則一是「`shared` 不依賴任何模組」—— filter chain 不能呼叫 `account`。
驗證本身也不需要 `account`：JWT 是自帶簽章的，驗證只需要金鑰，不需要查 `users` 表（這也是 US-ACC-2 AC-6「停權最遲 15 分鐘生效」那個妥協的來源，5.7.3）。
簽發就跟著驗證走：兩邊必須用同一把金鑰、同一個 issuer、同一個 claim 名稱。**放在同一個類別旁邊，改一邊時才不會忘了另一邊。** `account` 呼叫 `AccessTokens.issue(userId, roles)`，傳進去的只有 id 與角色 —— token 裡沒有 email、沒有顯示名稱。

**稽核的介面在 `shared.audit`，實作在 `shared.audit.internal`。**
`audit_logs` 在 0.3.4 就劃給了 `shared`。`ordering`、`payment`、`catalog`、`account` 都要寫稽核，但它們只能看到 `AuditLog` 這個介面 —— 1.6.2 的最後一條規則（「資料存取只能出現在模組的 internal 套件」）讓 `JdbcAuditLog` 必須在 `internal` 裡。

依賴表（0.3.4、1.6.2）**一條都沒有改**：所有新的依賴都是「某個模組 → `shared`」，那本來就是允許的。`ModuleBoundaryTest` 的 6 條規則、`TableOwnershipTest`、`EntityTableOwnershipTest` 在這一章結束時仍然全綠（5.12）。

這一章的程式碼區塊為了閱讀，常常省略建構子、欄位與 import。**每一個在正文裡沒有完整出現的檔案，完整內容都在 5.12.1。**

### 5.3.3 一個請求的路徑：三層檢查

```
GET /api/orders/20260812-483915
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzaG9wIiwic3ViIjoiMTAwMSIs...

① SecurityFilterChain（Servlet filter，比 DispatcherServlet 早）
   BearerTokenAuthenticationFilter → JwtDecoder：HS256？金鑰對？issuer = shop？還沒過期（± 5 秒）？
                                   → JwtAuthenticationToken（sub = 1001、ROLE_BUYER）
   AuthorizationFilter             → /api/orders/** 需要 ROLE_BUYER ✓
② DispatcherServlet
   CurrentUserResolver             → CurrentUser(1001, {BUYER})
   @Valid、@PathVariable           → 參數驗證
   OrderQueryController.one()      → user.require(Role.BUYER)（第二道，讓讀 Controller 的人看得到）
③ OrderQueryService.buyerOrder()
   OrderAccess.buyers(1001, "20260812-483915") → 這張訂單是不是 1001 的？不是 → 404 + ACCESS_DENIED
```

三層各自回答不同的問題（[09-spring-security/03](../09-spring-security/03-authorization-and-method-security.md) 的 3.2.1）：

| 層 | 回答 | 失敗時 | 在哪裡 |
|---|---|---|---|
| ① URL | 「你是誰？你的角色能進這個前綴嗎？」 | 401 / 403 | `SecurityConfig` |
| ② Controller | 同上（第二道） | 403 | `user.require(...)`，第 03 章就有 |
| ③ 資料 | 「這筆資料是你的嗎？」 | **404** | `OrderAccess`、`ProductService.owned()` |

①在參數驗證**之前**，所以 3.4.4 的「買家呼叫賣家的 API 先拿到 400」不會再發生 —— 那一節的 📌 預告過：「`SecurityFilterChain` 是 Servlet filter，天生就是這個順序」。

③ 是 0.6.5 那一列「資料層級權限在 **Service 層**檢查（不只在 Controller）」。URL 的規則**沒辦法**回答「這張訂單是不是你的」—— 路徑上的 `20260812-483915` 對 filter 來說只是一個字串。5.8 會把這一層從「每個方法各自寫一個 `WHERE buyer_id = ?`」變成一個元件。

### 5.3.4 實作順序

這一章動到的檔案很多，而且有一段時間測試會整片紅：**加上 `spring-boot-starter-security` 的那一刻**，所有需要身分的測試都會變成 401（5.2.1 的 A 階段），要等到 `SecurityConfig` 與 `TestTokens` 都到位才會回來。建議照這個順序做：

1. **依賴**（5.5.1）：`pom.xml` 加三個依賴。這時候可以先跑 F1 的 A、B 階段（5.2.1；`SecurityConfig` 還不存在時，C 階段會自動跳過）。既有的測試會大量 401 —— 這是預期的。
2. **設定**（5.5.1、5.10）：`ShopProperties.Security` 刪掉 `debugHeaders`、加上 `Login` 與 `BootstrapAdmin`；`application-local.yml` 刪掉 `debug-headers`、加上 `bootstrap-admin`；`application-prod.yml`、測試的 `application-lab.yml` 跟著改。**這一步要跟第 3 步一起做**：`debugHeaders` 一刪，舊的 `CurrentUserResolver` 就編譯不過。
3. **身分**（5.5）：`ProblemWriter`、`AccessTokens`、`SecurityConfig`（記得 `@ConditionalOnWebApplication`，5.5.2）、改寫 `CurrentUserResolver`（5.5.6）、`OpenApiConfig` 加上 bearer。
4. **測試的身分**（5.5.6）：`TestTokens`，照「既有測試的遷移清單」改舊測試；`LabShopApp` 排除 Security 的自動設定。這一步的目標是既有的測試回到全綠 —— `OpenApiContractTest` 例外，它會報 `components` 有變動，等第 8 步一起更新快照。
5. **稽核**（5.9）：`AuditAction`、`AuditEntry`、`AuditLog`、`JdbcAuditLog`、`AuditQuery`、`AuditLogController`。
6. **帳號**（5.4、5.6、5.7、5.10）：`PasswordConfig`、`Email`、`Utf8Bytes`、`Account`、`Accounts`、`AuthDtos`、`RefreshTokens`、`LoginAttempts`、`IpLoginLimiter`、`AccountService`、`LoginService`、`BootstrapAdmin`、兩個 Controller；`ProblemType` 加上 `EMAIL_UNAVAILABLE`（5.4.1）。
7. **資料層級權限與既有模組的稽核**（5.8、5.9.3）：`OrderRepository.existsByOrderNo`、`OrderAccess`、`OrderCommands`、`OrderQueryService`、`ProductService`、`JdbcPaymentService`。
8. **新的測試**（5.11.1）：`AuthApiTest`、`JwtGuardTest`、`SecurityRouteCoverageTest`、`IdorMatrixTest`、`AuditPlacementTest`、`JdbcAuditLogTest`；驗收 Q5 拿掉 `@Disabled`（5.8.4）；用 `mvn test -Dtest=OpenApiContractTest -Dopenapi.update=true` 更新 OpenAPI 快照（5.3.1）。
9. **整體驗證**（5.12、5.11.2、5.10）：`mvn clean test`、`smoke5.sh`、`boot-test.sh`；實驗 F1～F8 用 `-Pexperiments` 各自跑（5.2.0）。

每一個檔案的完整內容，不是在正文，就是在 5.12.1。

---

## 5.4 註冊與密碼

### 5.4.1 `RegisterRequest`：沒有 `role` 這個欄位

```java
public record RegisterRequest(
        @NotBlank(message = "email 必填") @Email(message = "email 格式不正確") @Size(max = 254, message = "email 最多 254 個字元") String email,
        @NotNull(message = "密碼必填") @Utf8Bytes String password,
        @NotBlank(message = "顯示名稱必填") @Size(max = 50, message = "顯示名稱最多 50 個字元") String displayName) {}
```

US-ACC-1 AC-4（「註冊請求帶了 `"role": "ADMIN"` → 忽略，仍建立 `BUYER`」）的實作，**就是這個 record 沒有 `role` 欄位**。（`RegisterRequest` 是 `AuthDtos` 裡的巢狀 record，跟登入、refresh 的請求與回應放在一起，見 5.12.1。）
Jackson 在 Spring Boot 的預設設定下會忽略不認識的欄位（`FAIL_ON_UNKNOWN_PROPERTIES = false`），所以 `{"role": "ADMIN", "roles": ["ADMIN"]}` 不會造成錯誤，也不會被綁到任何地方。角色在 Service 裡寫死：

```java
/**
 * BCrypt 在交易「外面」算（5.4.3）；交易裡只有兩句 INSERT。
 * 用 TransactionTemplate 而不是另一個 @Transactional 方法：this.insert() 不經過代理，@Transactional 會被默默忽略（4.2.2 的 ⚠️）
 */
public Me register(RegisterRequest req) {
    String email = Email.normalize(req.email());
    String name = req.displayName().strip();
    String hash = encoder.encode(req.password());
    try {
        long id = tx.execute(s -> accounts.insert(email, hash, name, Role.BUYER, null));   // AC-4：角色寫死，不從請求來
        return new Me(id, email, name, Set.of(Role.BUYER));
    } catch (DuplicateKeyException e) {
        throw new ShopException(ProblemType.EMAIL_UNAVAILABLE, "無法以此 email 註冊");      // AC-2：不說「已被使用」
    }
}
```

這是 3.2.1「Controller 直接回傳 Entity」的反方向：那一節是「回應帶出了不該出去的欄位」，這裡是「請求帶進了不該進來的欄位」。**DTO 是一份清單：上面沒有的，就不存在。**
`AuthApiTest.register` 送的 body 同時帶了 `role` 與 `roles`，檢查回應與 `user_roles` 都只有 `BUYER`（5.11）。

> ⚠️ 註解裡那個 `TransactionTemplate`，是寫這一段時差點掉進去的坑：第一個念頭是把兩句 INSERT 抽成一個 `@Transactional long insertBuyer(...)`，再從 `register()` 呼叫它。
> **同一個物件裡的 `this.insertBuyer()` 不經過 Spring 的代理**，`@Transactional` 不會生效 —— 兩句 INSERT 各自 autocommit。第二句（`user_roles`）失敗的話，`users` 裡就留下一個沒有任何角色的帳號。
> 這跟 4.2.2 那段 ⚠️「`reserve()` 沒有交易代理」是同一件事。程式碼看起來有交易，實際上沒有，而且不會有任何警告。

**email 存的是正規形**：`Email.normalize()` 去掉前後空白、轉小寫（`Locale.ROOT`）。`Alice@auth-test.example.com` 註冊，存進去的是 `alice@auth-test.example.com`。為什麼要在 Java 裡正規化，而不是交給 `ai_ci` 定序？5.6.3 會說明 —— 這跟 5.2.3 的洞二是同一件事。

**email 重複 → 409 `/problems/email-unavailable`**

這裡有一個**需求本身的矛盾**，是實作時才發現的：US-ACC-1 AC-2 寫的是「409 `/problems/validation`」，但 0.4.1 的錯誤型別表裡，`/problems/validation` 是 **400**（「欄位驗證失敗」）。第 03 章的 `ProblemType` enum 照那張表做，一個 `type` 對一個狀態碼。

兩個選擇：讓 `/problems/validation` 有時候是 400、有時候是 409（前端要同時看 `status` 與 `type` 才知道發生什麼事），或者新增一個型別。本專題選後者：

```java
EMAIL_UNAVAILABLE(HttpStatus.CONFLICT, "/problems/email-unavailable", "無法以此 email 註冊"),   // US-ACC-1 AC-2（5.4.1）
```

0.4.1 的表與 AC-2 的文字都照這個改了。**需求文件跟程式碼不一致的時候，改文件也是一個選項** —— 但要改，不能讓兩邊各說各話。

> 📌 **註冊一定會洩漏「這個 email 有沒有註冊過」。** 201 和 409 是兩個不同的答案，訊息寫得再含糊也一樣。AC-2 的「不透露」只做到了「不在訊息裡明說」。
> 真正的解法是**不在註冊當下回答**：一律回「我們寄了一封信給你」，信裡才說「你已經有帳號了，要不要重設密碼」。那需要寄信與驗證流程，在 0.7 的範圍之外。
> 這一章做得到的是兩件事：登入不洩漏（AC-2，5.6.1），以及讓「試註冊」的成本變高 —— 第 06 章的限流。

`ai_ci` 定序在這裡是**幫手**：`AuthApiTest.duplicateEmail` 先註冊 `bob@…`，再用 `BOB@…`、`bób@…`、`ｂｏｂ@…` 註冊，三個都是 409。UNIQUE 索引用的是欄位的定序，所以「看起來像同一個人」的帳號一個都建不起來 —— 這擋住了用長得像的 email 冒充別人。

### 5.4.2 72 bytes：`@Size` 數錯了東西

US-ACC-1 AC-3：密碼 8 字元以上、**72 bytes** 以內。0.4.2 那段 📌 說過理由：BCrypt 只取前 72 bytes，超過的部分**默默被忽略**。

這句話在 Spring Security 6.2.4 上還成立嗎？F8 直接試：

```bash
mvn test -Pexperiments -Dtest=F8SmallFactsTest
```

```
═══ 5.4.2 BCrypt 只看前 72 bytes（spring-security-crypto 6.2.4）═══
  註冊的密碼：「密密密…第一個人的後綴」（93 bytes）
  用「密密密…第一個人的後綴」（93 bytes）登入 → 通過
  用「密密密…完全不一樣的東西」（96 bytes）登入 → 通過
  用「密密密…」（72 bytes）登入 → 通過
  用「密密密…」（69 bytes）登入 → 失敗
```

24 個「密」剛好 72 bytes。在它後面接什麼都一樣：「第一個人的後綴」、「完全不一樣的東西」、什麼都不接 —— **全部通過**。少一個字（69 bytes）才失敗。

所以兩個前 72 bytes 相同的密碼，在 BCrypt 眼裡是**同一個密碼**。中文一個字 3 bytes，24 個中文字就到上限了；一個「好記的長句子」很容易超過。
不擋的話，使用者以為自己設了一個 31 個字的密碼，實際上只有前 24 個字算數 —— 而他不會知道。

（這個行為後來被登記為 CVE-2025-22228，之後的修補版本改成拒絕超過 72 bytes 的密碼。本專題鎖在 Spring Boot 3.2.5 帶的 6.2.4（0.9.1），所以這一層要自己擋 —— 而且就算升級了，也應該在**驗證階段**擋、回 400，而不是讓編碼器在 Service 裡丟一個例外、變成 500。）

**`@Size(max = 72)` 擋不住。** `@Size` 數的是 Java `String` 的長度 —— UTF-16 的 code unit，不是 UTF-8 的 bytes。25 個「密」是 25 個 char、75 bytes，`@Size(max = 72)` 會讓它過。所以自己寫一個約束：

```java
package com.example.shop.account.internal;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.nio.charset.StandardCharsets;

/**
 * US-ACC-1 AC-3：密碼 8 字元以上、72 bytes 以內。@Size 數的是 char，BCrypt 數的是 UTF-8 bytes（5.4.2）。
 */
@Target({ElementType.FIELD, ElementType.RECORD_COMPONENT, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = Utf8Bytes.Validator.class)
@interface Utf8Bytes {
    int minChars() default 8;
    int maxBytes() default 72;
    String message() default "密碼長度須為 8 個字元以上、72 bytes 以內（中文一個字 3 bytes）";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};

    class Validator implements ConstraintValidator<Utf8Bytes, String> {
        private int minChars, maxBytes;

        @Override
        public void initialize(Utf8Bytes a) { minChars = a.minChars(); maxBytes = a.maxBytes(); }

        @Override
        public boolean isValid(String v, ConstraintValidatorContext ctx) {
            if (v == null) return true;                                      // null 交給 @NotNull
            return v.codePointCount(0, v.length()) >= minChars && v.getBytes(StandardCharsets.UTF_8).length <= maxBytes;
        }
    }
}
```

下限用 `codePointCount`（字元數），上限用 UTF-8 bytes。兩個方向用不同的單位，是因為它們在防不同的東西：下限防「太短、太好猜」，那是人的感覺（8 個字）；上限防 BCrypt 的截斷，那是演算法的限制（72 bytes）。

> ⚠️ **`@Retention(RetentionPolicy.RUNTIME)` 一定要寫。** 少了它，註解的保留期預設是 `CLASS`：編譯會過、啟動也不會報錯，但 Hibernate Validator 在執行期**看不到**這個約束 —— 密碼長度的檢查默默不生效，`AuthApiTest.passwordLength` 的 7 個字元會拿到 201。
> `groups()`、`payload()` 也不能省：Bean Validation 規定每一個約束註解都要有這兩個成員。

`AuthApiTest.passwordLength` 檢查四個邊界：7 個字元 → 400、25 個中文字（75 bytes）→ 400、73 個英文字母 → 400、24 個中文字（72 bytes）→ 201。每一個 400 的 `errors[0].field` 都是 `password`。

> 📌 **登入的 DTO 不檢查密碼格式。** `LoginRequest` 的 `password` 只有 `@NotBlank` 與一個寬鬆的 `@Size(max = 200)`（擋掉超大的 body）。
> 理由：密碼規則會改。今天改成「至少 10 個字元」，那些用 8 個字元註冊的人**還是要能登入** —— 然後被要求換密碼。規則屬於「設定密碼」的那一刻，不屬於「使用密碼」的那一刻。

### 5.4.3 BCrypt 不在交易裡

BCrypt cost 10 一次約 74 ms（5.2.3 ①）。這個數字決定了登入與註冊的程式碼形狀：**BCrypt 一定在交易外面算**。

`LoginService` 這個類別上沒有 `@Transactional`。登入流程裡只有一個地方需要交易：寫 `refresh_tokens` 的那一句 INSERT。`register()` 也一樣：先 `encoder.encode()`，再用 `TransactionTemplate` 包住兩句 INSERT。

如果 BCrypt 在交易裡，算一下會發生什麼：連線池 20 條（0.10.4）。20 個人同時登入，每一個拿著一條連線 74 ms 做 CPU 運算、一句 SQL 都沒送 —— **連線池就滿了**。
第 21 個請求（不管是登入還是下單）要等連線，等 3 秒（`connection-timeout`）就是 4.8.2 的 503。理論上限是 20 ÷ 0.074 ≈ **270 次登入 / 秒**，而且在那個流量下，全站其他 API 都拿不到連線。

0.11.5 的第一條設計約束是「持鎖 ≤ 2 ms」；交易持有連線，跟持鎖是同一類的資源。**交易裡只放 SQL**（4.3.3 的規則一），在這裡的意思是：連 CPU 運算也不放。

---

## 5.5 JWT 與 `SecurityFilterChain`

### 5.5.1 `AccessTokens`：簽發

先決定用哪一套工具。Spring Security 有一個現成的「資源伺服器」：`spring-boot-starter-oauth2-resource-server`。它的名字聽起來像 OAuth2，但它做的事情只是「從 `Authorization: Bearer` 取出 JWT、驗證、變成一個 `Authentication`」—— 正好是這一章要的。
[09-spring-security/05](../09-spring-security/05-jwt-authentication.md) 的 5.4 自己寫過一個 `JwtAuthenticationFilter`，5.4.4 再換成 `oauth2ResourceServer`，少寫一個 filter。本專題直接用後者：

```xml
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-oauth2-resource-server</artifactId></dependency>
<!-- test -->
<dependency><groupId>org.springframework.security</groupId><artifactId>spring-security-test</artifactId><scope>test</scope></dependency>
```

它帶進來的 JWT 函式庫是 Nimbus JOSE + JWT（9.24.4，`mvn dependency:tree` 看得到）。簽發也用它：

```java
package com.example.shop.shared.security;

/**
 * 5.5.1 access token（US-ACC-2 AC-1）：HS256 的 JWT，15 分鐘。
 * 簽發在這裡、驗證在 SecurityConfig 的 JwtDecoder —— 兩邊用同一把金鑰、同一個 issuer，所以放在同一個套件。
 * account 模組呼叫 issue()；shared 不認識 account（1.6.2 規則一），所以 token 裡只有 id 與角色，沒有 email。
 */
@Component
public class AccessTokens {

    static final String ISSUER = "shop";
    static final String ROLES = "roles";

    public record Issued(String token, long expiresInSeconds) {}

    private final JwtEncoder encoder;
    private final Clock clock;
    private final Duration ttl;

    AccessTokens(ShopProperties props, Clock clock) {
        this.encoder = new NimbusJwtEncoder(new ImmutableSecret<>(key(props)));
        this.clock = clock;
        this.ttl = props.security().accessTokenTtl();
    }

    static SecretKey key(ShopProperties props) {
        return new SecretKeySpec(props.security().jwtSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
    }

    public Issued issue(long userId, Set<Role> roles) {
        Instant now = clock.instant();
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(ISSUER)
                .subject(Long.toString(userId))
                .issuedAt(now)
                .expiresAt(now.plus(ttl))
                .id(UUID.randomUUID().toString())
                .claim(ROLES, roles.stream().map(Enum::name).sorted().toList())
                .build();
        String token = encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
        return new Issued(token, ttl.toSeconds());
    }
}
```

一個真的 token 拆開來（5.11 的冒煙測試登入之後）：

```
{'alg': 'HS256'}
{'iss': 'shop', 'sub': '21017', 'exp': 1790838344, 'iat': 1790837444, 'jti': '4ed0623f-5067-4e6f-a452-355a90eec4ed', 'roles': ['BUYER']}
```

`exp - iat = 900`，15 分鐘。payload 是 Base64，不是加密 —— 任何拿到 token 的人都讀得到裡面的東西（09/05 的 5.2.1），所以裡面只有 id 與角色。

**為什麼是 HS256（對稱金鑰）？** 簽發與驗證是同一個服務、同一群機器，金鑰只需要在這群機器之間共享。RS256（非對稱）的好處是「驗證的一方不需要能簽發」—— 當驗證者是別的服務時才有意義。這是 0.6.5 定下的；等到驗證 token 的是另一個服務時，才需要重新考慮。

**`ShopProperties.Security` 長出了這一章的設定**，全部有預設值與上下限，啟動時驗證（1.7.3）：

```java
/** 0.6.5、US-ACC-2、US-ACC-3（第 05 章） */
public record Security(
        /** HS256 的金鑰至少 256 bits（0.6.5）。@Size 數的是字元；UTF-8 下 32 個字元至少 32 bytes */
        @NotBlank @Size(min = 32, message = "JWT 金鑰至少 32 bytes（256 bits，0.6.5）") String jwtSecret,
        /** US-ACC-2 AC-1：access token 15 分鐘。它也是 AC-6「停權最遲多久生效」的上限 */
        @NotNull @DefaultValue("15m") @DurationMin(minutes = 1) @DurationMax(minutes = 60, message = "access token 不可超過 60 分鐘（AC-6 的停權空窗）")
        Duration accessTokenTtl,
        /** US-ACC-2 AC-1：refresh token 7 天 */
        @NotNull @DefaultValue("7d") @DurationMin(hours = 1) @DurationMax(days = 30) Duration refreshTokenTtl,
        @Valid @NotNull @DefaultValue Login login,
        @Valid @NotNull @DefaultValue BootstrapAdmin bootstrapAdmin) {}
```

（`Login`（鎖定次數、時間窗、每 IP 每分鐘的上限）與 `BootstrapAdmin`（第一個管理員，5.10）兩個 record，以及完整的 `ShopProperties`，見 5.12.1。）

`jwtSecret` 的 `@Size(min = 32)` 在第 01 章就有了 —— 那時候還沒有人用它。`accessTokenTtl` 的上限 60 分鐘不是技術限制，是**需求**：AC-6 說停權最遲 15 分鐘生效，把它設成 24 小時，那句需求就失效了。讓設定檔改不出一個違反需求的值。

**第 03 章的 `debugHeaders` 開關刪掉了。** 如果某個環境的設定裡還留著它：

```
APPLICATION FAILED TO START

Description:

Binding to target [Bindable@24c8bc1e type = com.example.shop.shared.config.ShopProperties, value = 'none', ...] failed:

    Property: shop.security.debug-headers
    Value: "true"
    Origin: "shop.security.debug-headers" from property source "commandLineArgs"
    Reason: The elements [shop.security.debug-headers] were left unbound.
```

`@ConfigurationProperties(ignoreUnknownFields = false)`（1.7.3）在這裡多做了一件事：**一個被刪掉的開關，不會在某台機器的設定檔裡默默活下來**。你不會在半年後發現某個測試環境還能用 header 冒充任何人 —— 它根本起不來。

### 5.5.2 `SecurityConfig`：0.8 那張表

```java
package com.example.shop.shared.security;

/**
 * 5.5 本專題唯一的 SecurityFilterChain。
 *
 * 三條規則：
 *  ① 0.8 的「路徑前綴 → 角色」表原封不動搬進來（第 03 章在 interceptor，3.4.4）；表上沒有的路徑一律 denyAll（3.3.4 的 fail closed）
 *  ② 401 / 403 也是 Problem Details（5.2.1 B'）
 *  ③ 沒有 session、沒有 CSRF：身分只在 Authorization header 裡，瀏覽器不會自動帶上它（5.5.2）
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)   // 非 Web 的 context（OrderFlowTest、驗收 Q6）沒有 HttpSecurity
class SecurityConfig {

    /** 5.5.4：預設 60 秒的時鐘誤差會讓「15 分鐘」變成 16 分鐘。簽發與驗證都是同一群機器（NTP 同步），5 秒就夠 */
    static final Duration CLOCK_SKEW = Duration.ofSeconds(5);

    @Bean
    SecurityFilterChain shopSecurity(HttpSecurity http, ProblemWriter problems) throws Exception {
        AuthenticationEntryPoint unauthenticated = (req, res, ex) -> {
            boolean badToken = ex instanceof InvalidBearerTokenException;
            res.setHeader("WWW-Authenticate", badToken ? "Bearer error=\"invalid_token\"" : "Bearer");   // RFC 6750：讓客戶端知道該去 refresh
            problems.write(req, res, ProblemType.UNAUTHENTICATED, badToken ? "token 無效或已過期" : "需要登入");
        };
        AccessDeniedHandler forbidden = (req, res, ex) -> problems.write(req, res, ProblemType.FORBIDDEN, "沒有權限");

        http.csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .httpBasic(AbstractHttpConfigurer::disable)
            .formLogin(AbstractHttpConfigurer::disable)
            .logout(AbstractHttpConfigurer::disable)
            .requestCache(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(a -> a
                    // ── 公開（0.8）──
                    .requestMatchers(HttpMethod.POST, "/api/auth/register", "/api/auth/login", "/api/auth/refresh").permitAll()
                    .requestMatchers(HttpMethod.GET, "/api/products", "/api/products/**").permitAll()
                    .requestMatchers(HttpMethod.POST, "/api/payments/callback").permitAll()          // 身分 = HMAC 簽章（US-ORD-2 AC-3）
                    .requestMatchers(HttpMethod.GET, "/api/ping").permitAll()
                    .requestMatchers(HttpMethod.GET, "/actuator/health", "/actuator/health/**", "/actuator/info").permitAll()   // 5.2.1 B：readiness 401
                    .requestMatchers(HttpMethod.GET, "/v3/api-docs", "/v3/api-docs/**", "/swagger-ui.html", "/swagger-ui/**").permitAll()
                    .requestMatchers("/error").permitAll()                                           // 5.2.1 B'：不然真正的錯誤會被蓋成 401
                    // ── 依角色（0.8 的前綴；第 03 章的 interceptor 表）──
                    .requestMatchers("/api/seller/**").hasRole("SELLER")
                    .requestMatchers("/api/admin/**").hasRole("ADMIN")
                    .requestMatchers("/api/cart", "/api/cart/**", "/api/orders", "/api/orders/**").hasRole("BUYER")
                    .requestMatchers(HttpMethod.GET, "/api/me").authenticated()
                    // ── 其他：拒絕。新增一支 API 卻忘了加規則 → 403，而不是「意外公開」──
                    .anyRequest().denyAll())
            .oauth2ResourceServer(o -> o
                    .jwt(j -> j.jwtAuthenticationConverter(rolesFromClaim()))
                    .authenticationEntryPoint(unauthenticated)
                    .accessDeniedHandler(forbidden))
            .exceptionHandling(e -> e.authenticationEntryPoint(unauthenticated).accessDeniedHandler(forbidden));
        return http.build();
    }

    @Bean
    JwtDecoder jwtDecoder(ShopProperties props, Clock clock) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(AccessTokens.key(props)).macAlgorithm(MacAlgorithm.HS256).build();
        JwtTimestampValidator expiry = new JwtTimestampValidator(CLOCK_SKEW);
        expiry.setClock(clock);
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(expiry, new JwtIssuerValidator(AccessTokens.ISSUER)));
        return decoder;
    }

    /** roles: ["BUYER","SELLER"] → ROLE_BUYER、ROLE_SELLER（hasRole 會自己加 ROLE_ 前綴） */
    static JwtAuthenticationConverter rolesFromClaim() {
        JwtGrantedAuthoritiesConverter roles = new JwtGrantedAuthoritiesConverter();
        roles.setAuthoritiesClaimName(AccessTokens.ROLES);
        roles.setAuthorityPrefix("ROLE_");
        JwtAuthenticationConverter c = new JwtAuthenticationConverter();
        c.setJwtGrantedAuthoritiesConverter(roles);
        return c;
    }
}
```

逐段看。

**規則是一條 list，第一個命中就決定**（09/03 的 3.3.1）。所以順序是「公開 → 依角色 → 其他全部拒絕」。
`/api/products/**` 只放行 `GET`：賣家的商品 API 在 `/api/seller/products/**`，不會被這一行放行 —— 但如果有人哪天在 `/api/products/{id}` 加了一個 `PATCH`，它會落到最後的 `denyAll`，而不是被 `permitAll` 吃掉。**每一條 `permitAll` 都寫了 HTTP 方法**，理由一樣（09/03 的 3.3.4「規則只寫了 GET」是反過來的那個坑）。

`/api/cart` 與 `/api/cart/**` 兩個都寫了。`/api/cart/**` 在 PathPattern 底下其實也會比對到 `/api/cart`，但「其實也會」這種事不應該需要讀文件才知道 —— 5.5.5 的覆蓋掃描會實際打一次確認。

**最後一行是 `denyAll()`，不是 `authenticated()`。** 這是 3.3.4 那段 📌 的承諾：「第 05 章的 Spring Security 會把『預設拒絕』寫成 `anyRequest().denyAll()`，這是同一個原則的框架版」。
`authenticated()` 的意思是「表上沒寫的，登入了就能用」—— 一支新的管理員 API 忘了加規則，任何登入的買家都打得到。`denyAll()` 讓它對所有人都是 403，第一次手動測試就會發現。5.5.5 再讓測試在 CI 上發現。

**為什麼關掉 CSRF？** 5.2.1 的 B 階段看過了：它是預設開的。CSRF 攻擊的前提是「瀏覽器會**自動**帶上身分」—— cookie 會，`Authorization` header 不會。
攻擊者的網頁可以讓你的瀏覽器送一個 POST 到 `shop.example.com`，但它沒辦法讓那個請求帶上你的 access token：token 在前端的記憶體裡，不在 cookie 裡。[09-spring-security/04](../09-spring-security/04-session-vs-stateless-and-csrf.md) 的 4.5.1 有完整的決策表；本專題落在「無狀態、token 放在 header」那一格。

> ⚠️ 這個決定有一個前提：**token 永遠不能放進 cookie**。如果前端團隊哪天為了「重新整理頁面不用重新登入」把 access token 存進 cookie，CSRF 的前提就成立了，這一行 `csrf(disable)` 就變成漏洞。
> 這件事要寫進前端的規範裡 —— 後端的程式碼保護不了它。

**`STATELESS` 與四個 `disable`**：沒有 session、沒有 Basic、沒有表單登入、沒有登出頁、沒有「登入後跳回原頁」的 request cache。5.2.1 A 階段的 `Set-Cookie: JSESSIONID` 與 `302 /login` 就是這幾個預設功能留下的。C 階段的輸出裡，**每一個回應都沒有 `Set-Cookie`**。

**`/error` 要放行**：5.2.1 的 B' 階段。真正的錯誤（不管是 403 還是 500）被 Servlet 容器轉發到 `/error` 時，不應該再被要求登入一次。

**`@ConditionalOnWebApplication`** 是後來加的。`SecurityConfig` 的第一版沒有它，加上之後跑既有的測試：

```
Caused by: org.springframework.beans.factory.UnsatisfiedDependencyException: Error creating bean with name 'shopSecurity' defined in class path resource [com/example/shop/shared/security/SecurityConfig.class]: Unsatisfied dependency expressed through method 'shopSecurity' parameter 0: No qualifying bean of type 'org.springframework.security.config.annotation.web.builders.HttpSecurity' available: expected at least 1 bean which qualifies as autowire candidate. Dependency annotations: {}
[ERROR] Tests run: 14, Failures: 0, Errors: 14, Skipped: 0, Time elapsed: 3.240 s <<< FAILURE! -- in com.example.shop.ordering.internal.OrderFlowTest
```

`OrderFlowTest` 是 `webEnvironment = NONE`（4.9.1）—— 沒有 Servlet 容器，Spring Boot 就不會建立 `HttpSecurity`。驗收 Q6 也是用 `WebApplicationType.NONE` 啟動（2.10）。`SecurityConfig` 只在 Servlet 應用程式裡才有意義，就讓它只在那裡存在。

### 5.5.3 401 與 403 也是 Problem Details

5.2.1 B' 的第三個問題：filter 裡發生的 401、403，`GlobalExceptionHandler` 看不到。

`SecurityConfig` 裡那兩個 lambda（`unauthenticated`、`forbidden`）是 Spring Security 的兩個擴充點：`AuthenticationEntryPoint`（「你需要先登入」）與 `AccessDeniedHandler`（「你登入了，但不能進來」）。它們都交給同一個元件寫出回應：

```java
package com.example.shop.shared.web;

/**
 * 5.5.3 在 DispatcherServlet「之外」寫出 Problem Details。
 * Spring Security 的 401 / 403 發生在 filter 裡，GlobalExceptionHandler 看不到它們（5.2.1 階段 B'：回應變成 Boot 預設的 {"timestamp", "error"}）。
 * 格式跟 GlobalExceptionHandler 用同一個 problem()，前端只需要認識一種錯誤格式（0.4.1 規則三）。
 */
@Component
public class ProblemWriter {

    private final ObjectMapper json;

    ProblemWriter(ObjectMapper json) { this.json = json; }

    public void write(HttpServletRequest req, HttpServletResponse res, ProblemType type, String detail) throws IOException {
        ProblemDetail pd = GlobalExceptionHandler.problem(type, detail);
        pd.setInstance(URI.create(req.getRequestURI()));
        res.setStatus(type.status().value());
        res.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        res.setCharacterEncoding(StandardCharsets.UTF_8.name());
        json.writeValue(res.getOutputStream(), pd);
    }
}
```

它放在 `shared.web`，跟 `GlobalExceptionHandler` 同一個套件，用的是同一個 package-private 的 `problem()`。**一個錯誤格式，一個產生它的地方**：0.4.1 的表改了，兩條路徑一起改。

`ObjectMapper` 是 Spring Boot 的那一個 bean —— 它註冊了 `ProblemDetail` 的 Jackson mixin，所以 `properties` 會被攤平成頂層欄位，跟 MVC 產生的 Problem Details 長得一模一樣。

**401 的兩種 `WWW-Authenticate`**（RFC 6750）：

- 沒帶 token → `WWW-Authenticate: Bearer`，`detail` 是「需要登入」。
- 帶了、但無效或過期 → `WWW-Authenticate: Bearer error="invalid_token"`，`detail` 是「token 無效或已過期」。

前端靠這個區分「去登入頁」與「先用 refresh token 換一個新的，再重送一次」。`detail` 刻意不帶 Nimbus 的原始例外訊息（它會說出是哪一個驗證失敗、過期的時間點）—— 0.6.5 的「錯誤回應不含內部細節」對 filter 一樣適用。

### 5.5.4 `JwtDecoder` 拒絕哪些 token

[09-spring-security/05](../09-spring-security/05-jwt-authentication.md) 的 5.2 實測過三種經典攻擊（`alg:none`、金鑰太短、RS256 → HS256 混淆）。這裡不重做攻擊本身，而是確認**本專題的設定**沒有放過任何一種。`JwtGuardTest` 用 Nimbus 手工組出各種 token，全部打 `GET /api/orders`：

```bash
mvn test -Dtest=JwtGuardTest
```

```
  正常的 token                  → 200
  把 payload 的 BUYER 改成 ADMIN → 401  WWW-Authenticate: Bearer error="invalid_token"
  alg: none、沒有簽章             → 401  WWW-Authenticate: Bearer error="invalid_token"
  另一把金鑰簽的                    → 401  WWW-Authenticate: Bearer error="invalid_token"
  同一把金鑰、HS512                → 401  WWW-Authenticate: Bearer error="invalid_token"
  issuer 不是 shop             → 401  WWW-Authenticate: Bearer error="invalid_token"
  10 秒前過期                    → 401  WWW-Authenticate: Bearer error="invalid_token"
  3 秒前過期（在 5 秒的誤差內）          → 200
  沒有 roles                   → 403
  不是 JWT                     → 401  WWW-Authenticate: Bearer error="invalid_token"
  預設驗證器： 3 秒前過期的 token → 接受
  預設驗證器：10 秒前過期的 token → 接受
  預設驗證器：30 秒前過期的 token → 接受
  預設驗證器：59 秒前過期的 token → 接受
  預設驗證器：61 秒前過期的 token → 拒絕
  預設驗證器：90 秒前過期的 token → 拒絕
```

幾格值得說明：

- **「同一把金鑰、HS512」被拒絕**，是因為 `macAlgorithm(MacAlgorithm.HS256)`：解碼器只接受一種演算法。這一格的第一版其實寫錯了 —— Nimbus 的 `MACSigner` 要求 HS512 的金鑰至少 64 bytes，本機的金鑰只有 38 bytes，第一版的測試偷偷把金鑰重複了一次再簽，簽出來的是**另一把金鑰**。改成用 `javax.crypto.Mac` 以同一把 38 bytes 的金鑰直接算 HMAC-SHA512，結果一樣是 401，這一格才算真的測到了「演算法」而不是「金鑰」。
- **「沒有 roles」→ 403**，不是 401：簽章、issuer、時間都對，所以它是一個合法的身分，只是沒有任何角色。`/api/orders/**` 要 `ROLE_BUYER` → 403。
- **issuer 不是 shop → 401**。同一把金鑰在別的地方也被拿來簽 token 的話（例如另一個內部工具共用了設定），issuer 是最後一道區隔。

**最後六行是對照組**：Spring Security 預設的驗證器（`JwtValidators.createDefault()`，沒有呼叫 `setJwtValidator` 時就是它）容許 **60 秒**的時鐘誤差。59 秒前就過期的 token 還被接受。

這個預設是為了「簽發者與驗證者是不同的機器、時鐘不同步」。對 US-ACC-2 來說，它的效果是：**access token 實際上活 16 分鐘**，AC-6 的「停權最遲 15 分鐘生效」變成 16 分鐘。本專題的簽發與驗證是同一群機器，都跑 NTP；5 秒的誤差就夠了，AC-6 的上限變成「15 分鐘 + 5 秒」。

> 📌 **一個預設值改變了一條需求。** 這種事不會出現在任何錯誤訊息裡 —— token 照常驗證、照常過期，只是比你以為的晚了 60 秒。
> 唯一能發現它的方法，是把需求裡的數字（「15 分鐘」）寫成測試，然後去量邊界。

### 5.5.5 每一支 API 都要在表上：`SecurityRouteCoverageTest`

`denyAll()` 是保險，但保險不是規則。一支忘了加規則的 API，在 `denyAll()` 底下對所有人都是 403 —— 這比「意外公開」好得多，但它仍然是一個 bug，而且要等到有人手動打它才會發現。

`SecurityRouteCoverageTest` 從 Spring MVC 的 `RequestMappingHandlerMapping` 列出**實際存在**的每一支 API，各打兩次：

```java
/** 0.8 的「公開」那幾列 */
static final Set<String> PUBLIC = Set.of(
        "POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/refresh",
        "GET /api/products", "GET /api/products/{id}", "POST /api/payments/callback", "GET /api/ping");

@Test @DisplayName("匿名只碰得到 PUBLIC；三個角色都有的人，沒有任何一支 API 掉到 denyAll")
void everyRouteHasARule() throws Exception {
    String all = TestTokens.bearer(tokens, ACTOR, Role.BUYER, Role.SELLER, Role.ADMIN);
    List<String> anonymousReachable = new ArrayList<>(), denied = new ArrayList<>();
    List<String> routes = routes();
    for (String r : routes) {
        int anon = status(r, null), full = status(r, all);
        System.out.printf("  %-48s 匿名 %d │ 三個角色 %d%n", r, anon, full);
        if (anon != 401) anonymousReachable.add(r);
        if (full == 403) denied.add(r);
    }
    assertThat(anonymousReachable).as("匿名可達的 API 必須剛好是 PUBLIC").containsExactlyInAnyOrderElementsOf(PUBLIC);
    assertThat(denied).as("這些 API 沒有出現在 SecurityConfig 的表上").isEmpty();
}
```

兩個斷言的邏輯：

- **匿名**：不是 401 的，就是匿名打得到的。這個集合必須**剛好等於** `PUBLIC` —— 多一支是意外公開，少一支是公開的 API 被鎖住了。
- **三個角色都有**：一個 BUYER + SELLER + ADMIN 的 token，任何角色規則都會放行。如果還是 403，只剩一種可能：它掉到了 `denyAll()`。

這個測試不檢查業務結果：400、404 都可以，它只問「安全那一層有沒有答案」。

```
  DELETE /api/cart/items/{productId}               匿名 401 │ 三個角色 200
  GET /api/admin/audit-logs                        匿名 401 │ 三個角色 400
  GET /api/cart                                    匿名 401 │ 三個角色 200
  GET /api/me                                      匿名 401 │ 三個角色 404
  GET /api/orders                                  匿名 401 │ 三個角色 200
  GET /api/orders/{orderNo}                        匿名 401 │ 三個角色 404
  GET /api/ping                                    匿名 200 │ 三個角色 200
  GET /api/products                                匿名 200 │ 三個角色 200
  GET /api/products/{id}                           匿名 404 │ 三個角色 404
  GET /api/seller/orders                           匿名 401 │ 三個角色 200
  GET /api/seller/products                         匿名 401 │ 三個角色 200
  GET /api/seller/reports/daily-sales              匿名 401 │ 三個角色 400
  PATCH /api/cart/items/{productId}                匿名 401 │ 三個角色 400
  PATCH /api/seller/products/{id}                  匿名 401 │ 三個角色 404
  POST /api/admin/users/{id}/roles                 匿名 401 │ 三個角色 400
  POST /api/admin/users/{id}/suspend               匿名 401 │ 三個角色 404
  POST /api/auth/login                             匿名 400 │ 三個角色 400
  POST /api/auth/refresh                           匿名 400 │ 三個角色 400
  POST /api/auth/register                          匿名 400 │ 三個角色 400
  POST /api/cart/items                             匿名 401 │ 三個角色 400
  POST /api/orders                                 匿名 401 │ 三個角色 400
  POST /api/orders/{orderNo}/cancel                匿名 401 │ 三個角色 404
  POST /api/orders/{orderNo}/confirm-receipt       匿名 401 │ 三個角色 404
  POST /api/orders/{orderNo}/payments              匿名 401 │ 三個角色 404
  POST /api/payments/callback                      匿名 400 │ 三個角色 400
  POST /api/seller/orders/{orderNo}/cancel         匿名 401 │ 三個角色 404
  POST /api/seller/orders/{orderNo}/ship           匿名 401 │ 三個角色 400
  POST /api/seller/orders/{orderNo}/start-picking  匿名 401 │ 三個角色 404
  POST /api/seller/products                        匿名 401 │ 三個角色 400
  POST /api/seller/products/{id}/publish           匿名 401 │ 三個角色 404
  POST /api/seller/products/{id}/restock           匿名 401 │ 三個角色 400
  POST /api/seller/products/{id}/unpublish         匿名 401 │ 三個角色 404
  共 32 支 API；匿名可達 7 支；掉到 denyAll 0 支
```

（`GET /api/cart` 那一列確認了上一節的「`/api/cart` 也要有規則」。三個角色的 400，是因為 body 是 `{}`、或缺必要的參數 —— 那是業務層的答案，代表請求已經通過了安全層。）

**它真的抓得到嗎？** 把 `SecurityConfig` 裡 `GET /api/me` 那一行暫時拿掉，再跑一次：

```
  GET /api/me                                      匿名 401 │ 三個角色 403
  共 32 支 API；匿名可達 7 支；掉到 denyAll 1 支

java.lang.AssertionError:
[這些 API 沒有出現在 SecurityConfig 的表上]
Expecting empty but was: ["GET /api/me"]
```

這就是「新增了一支 API、忘了加規則」那一天會看到的東西。

**⚠️ 這個測試的第一版把種子資料的管理員停權了**

第一版代入路徑變數的方式是 `replaceAll("\\{[^}]+}", "1")`：所有的 `{id}`、`{productId}` 都換成 `1`。跑完之後順手查了一下 `audit_logs`：

```
action	actor_id	target_type	target_id
ACCESS_DENIED	990901	PRODUCT	1
USER_SUSPENDED	990901	USER	1
ACCESS_DENIED	990901	PRODUCT	1
ACCESS_DENIED	990901	PRODUCT	1
```

`USER_SUSPENDED`、`target_id = 1`。那一列的輸出是 `POST /api/admin/users/{id}/suspend  匿名 401 │ 三個角色 200` —— **200**。測試用一個「三個角色都有」的 token 打了 `POST /api/admin/users/1/suspend`，而 id 1 是種子資料的 `admin@example.com`。它真的被停權了。

那一次的副作用還有：對商品 1 的三次 `ACCESS_DENIED`（測試的使用者不是商品 1 的賣家 —— 至少這部分如設計運作），以及一個 `DELETE /api/cart/items/1`（測試使用者的購物車，本來就是空的）。

修正是把路徑變數一律代入**不存在**的值（`999999999`、`19990101-000000`），讓每一支 API 都停在「找不到」，不會真的改到任何東西；跑完再清掉測試使用者的購物車。修正之後的輸出就是上面那一份：`suspend` 是 404，`audit_logs` 沒有留下任何一列。（管理員的狀態用一句 `UPDATE users SET status = 'ACTIVE' WHERE id = 1` 改回來了。）

> 📌 **一個「只檢查狀態碼」的測試，也會改到資料。** 安全層之所以讓它通過，正是因為它帶著一個權限很大的 token。
> 覆蓋掃描這類「把每一支 API 都打一次」的測試，要嘛連到一個用完即丟的資料庫（第 08 章的 Testcontainers），要嘛保證每一個請求都打在不存在的資源上。這一次兩個都沒有做，第一次跑就付出了代價。

### 5.5.6 `CurrentUserResolver`：從 JWT 產生，型別不變

第 03 章的 `CurrentUserResolver` 做兩件事：從 `X-Debug-User-Id` 產生 `CurrentUser`、用 interceptor 檢查角色。第二件事搬進了 `SecurityConfig`；第一件事改成從 Spring Security 已經驗證好的 `JwtAuthenticationToken` 產生。第 03 章的建構子（含「prod 不可以打開」的檢查）、`addInterceptors()`、`requireRole()`、`identify()` 與兩個 header 常數全部刪掉；`supportsParameter()` 不變，`resolveArgument()` 改成呼叫 `current()`：

```java
package com.example.shop.shared.web;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.MethodParameter;
import org.springframework.core.ResolvableType;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 目前的使用者，從「已經驗證過的 JWT」產生（第 05 章）。
 * 第 03 章的版本從 X-Debug-User-Id header 產生 —— 那個 header 與 shop.security.debug-headers 這個開關都已經刪除。
 *
 * 這個類別仍然在每一個 profile 都存在（3.3.4）：它不在的時候，Spring 會用 query 參數組出一個 CurrentUser。
 * 角色檢查不在這裡了：搬進了 SecurityConfig 的 authorizeHttpRequests（5.5）。
 */
@Configuration
class CurrentUserResolver implements HandlerMethodArgumentResolver, WebMvcConfigurer {

    private static final Set<String> KNOWN_ROLES = Arrays.stream(Role.values()).map(Enum::name).collect(Collectors.toUnmodifiableSet());

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(this);
    }

    static Optional<CurrentUser> current() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (!(a instanceof JwtAuthenticationToken t)) return Optional.empty();
        Jwt jwt = t.getToken();
        List<String> roles = Optional.ofNullable(jwt.getClaimAsStringList("roles")).orElse(List.of());
        return Optional.of(new CurrentUser(Long.parseLong(jwt.getSubject()), roles.stream()
                .filter(KNOWN_ROLES::contains).map(Role::valueOf).collect(Collectors.toUnmodifiableSet())));
    }

    @Override
    public boolean supportsParameter(MethodParameter p) {
        return p.getParameterType() == CurrentUser.class
                || (p.getParameterType() == Optional.class
                    && ResolvableType.forMethodParameter(p).getGeneric(0).resolve() == CurrentUser.class);
    }

    @Override
    public Object resolveArgument(MethodParameter p, ModelAndViewContainer mav, NativeWebRequest req, WebDataBinderFactory f) {
        Optional<CurrentUser> user = current();
        if (p.getParameterType() == Optional.class) return user;
        return user.orElseThrow(() -> new ShopException(ProblemType.UNAUTHENTICATED, "需要登入"));
    }
}
```

`KNOWN_ROLES` 過濾掉不認識的角色名稱：token 是本專題簽的，正常情況下不會有；但如果哪天 `Role` enum 拿掉了一個值，還沒過期的舊 token 不應該讓 `Role.valueOf` 丟出一個 500。

**3.3.4 的三個設計決定，到這一章的結果**：

1. **Controller 的參數是 `CurrentUser` 這個型別** → 這一章沒有改任何一個既有的 Controller。`git diff` 列出的 Controller 只有三個新的（`AuthController`、`AccountController`、`AuditLogController`）。
2. **危險的功能用開關控制，預設是安全的那一邊** → 開關刪掉了，而且刪掉之後還設定它的環境起不來（5.5.1）。
3. **角色檢查依路徑前綴** → 那張表原封不動搬進 `authorizeHttpRequests`，3.4.4 的「驗證跑在權限前面」由 filter 的順序天生保證。

**測試的身分：`TestTokens`**

第 03、04 章的測試全部用 `X-Debug-User-Id`。它們改成帶一個真的 JWT —— 用**正式的** `AccessTokens` 簽：

```java
package com.example.shop.support;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import org.springframework.context.ApplicationContext;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 測試用的身分（第 05 章取代 X-Debug-User-Id）：用「正式的」AccessTokens 簽一個 JWT。
 * 不自己組 JWT：claim 的名字、issuer、演算法只要改了一個，自己組的 token 就會跟正式的分家，測試卻還是綠的。
 * 測試裡的使用者 id（990_001 這種）不需要存在於 users 表：JWT 驗證不查資料庫（US-ACC-2 AC-6 的妥協就是從這裡來的）。
 */
public final class TestTokens {
    private TestTokens() {}

    public static String bearer(ApplicationContext ctx, long userId, Role... roles) {
        return bearer(ctx.getBean(AccessTokens.class), userId, roles);
    }

    public static String bearer(AccessTokens tokens, long userId, Role... roles) {
        Set<Role> set = roles.length == 0 ? EnumSet.of(Role.BUYER) : EnumSet.copyOf(Arrays.asList(roles));
        return "Bearer " + tokens.issue(userId, set).token();
    }

    /** "BUYER,SELLER" → [BUYER, SELLER]（第 03 章 X-Debug-Roles 的格式） */
    public static Role[] roles(String csv) {
        return Arrays.stream(csv.split(",")).map(String::strip).map(Role::valueOf).collect(Collectors.toSet()).toArray(Role[]::new);
    }
}
```

大部分的地方是一行：`.header("X-Debug-User-Id", 1001)` → `.header("Authorization", TestTokens.bearer(tokens, 1001))`。但有幾個檔案不只一行。

**既有測試的遷移清單**

| 檔案 | 改什麼 |
|---|---|
| `OrderApiTest` | 加 `@Autowired AccessTokens tokens;`；四個 `.header("X-Debug-User-Id", 1001)` 換成 `.header("Authorization", TestTokens.bearer(tokens, 1001))` |
| `CatalogCartApiTest` | `as()` 從 `static` 改成實例方法（它要用注入的 `tokens`）；原本 `X-Debug-Roles` 的字串（`"BUYER,SELLER"`）用 `TestTokens.roles()` 轉成 `Role[]`；另外加一個 `@AfterTransaction`（5.9.3） |
| `CapstoneAcceptanceTest` | `placeOrder(port, buyer, …)` 是 `static`、手上沒有 context：`startApp()` 把 `AccessTokens` 存進一個 `static` 欄位。Q4 直接用 `TestTokens.bearer(ctx, buyer)`。Q5 不用 `TestTokens`（5.8.4） |
| `OrderFlowTest` | 不需要身分（`webEnvironment = NONE`），但 `@AfterEach` 要多清三種稽核：這一章起，付款回呼、賣家取消、越權都會寫 `audit_logs` |
| `D2ErrorMessageLeakTest` | 它也會啟動第 03 章的迷你應用程式 `LabShopApp`，那裡沒有 `AccessTokens`：用 `getBeanProvider(...).getIfAvailable()`，拿不到就不帶 header。`LabShopApp` 本身要排除四個 Security 的自動設定（5.12.1） |
| `D6LatencyTest`、`E7FlashSaleLoadTest` | 一行：`TestTokens.bearer(ctx, …)` |

`CatalogCartApiTest`：

```java
@Autowired AccessTokens tokens;

MockHttpServletRequestBuilder as(long userId, String roles, MockHttpServletRequestBuilder b) {
    return b.header("Authorization", TestTokens.bearer(tokens, userId, TestTokens.roles(roles)))
            .contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
}
```

`CapstoneAcceptanceTest`：

```java
/** 第 05 章：身分是正式的 AccessTokens 簽出來的 JWT（TestTokens）。每一題各自啟動一個應用程式，所以每次啟動都換一個 */
static AccessTokens tokens;

static ConfigurableApplicationContext startApp() {
    ConfigurableApplicationContext ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0", "--shop.order.jobs-enabled=false",
            "--spring.main.banner-mode=off", "--logging.level.root=WARN");
    tokens = ctx.getBean(AccessTokens.class);
    return ctx;
}

// placeOrder()：.header("X-Debug-User-Id", String.valueOf(buyer)) →
//              .header("Authorization", TestTokens.bearer(tokens, buyer))
```

`OrderFlowTest` 的 `cleanup()`，在 `for (long b : List.of(BUYER, OTHER_BUYER))` 迴圈的最前面：

```java
jdbc.update("DELETE a FROM audit_logs a JOIN payments p ON a.target_type = 'PAYMENT' AND a.target_id = p.id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", b);
jdbc.update("DELETE a FROM audit_logs a JOIN orders o ON a.target_type = 'ORDER' AND a.target_id = o.order_no WHERE o.buyer_id = ?", b);
jdbc.update("DELETE FROM audit_logs WHERE actor_id = ? AND action = 'ACCESS_DENIED'", b);
```

`D2ErrorMessageLeakTest.send()`：

```java
HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).header("Content-Type", "application/json");
var tokens = ctx.getBeanProvider(com.example.shop.shared.security.AccessTokens.class).getIfAvailable();   // 迷你應用程式沒有登入
if (tokens != null) b.header("Authorization", TestTokens.bearer(tokens, 2, Role.SELLER));
```

每一個檔案都要 import `com.example.shop.support.TestTokens`（用到 `AccessTokens`、`Role` 的，也一併 import）。

> 📌 **那為什麼驗收 Q5 不用 `TestTokens`？** 因為 Q5 測的就是「身分」本身：它真的呼叫 `POST /api/auth/register` 與 `POST /api/auth/login`，用登入回來的 token（5.8.4）。
> 其他的驗收題測的是交易、併發、N+1 —— 身分只是前提，用 `TestTokens` 省掉每一題各自註冊帳號。

**OpenAPI** 多了一個安全機制的宣告，Swagger UI 會出現一個「Authorize」按鈕：

```java
.components(new Components().addSecuritySchemes("bearer",
        new SecurityScheme().type(SecurityScheme.Type.HTTP).scheme("bearer").bearerFormat("JWT")))
.addSecurityItem(new SecurityRequirement().addList("bearer"));
```

它是全域的（加在最上層，不是每個 operation 上），所以 5.3.1 的 `OpenApiContractTest` 看到的是「components 有變動」，而不是 25 個 operation 都「變更」了。

---

## 5.6 登入：不洩漏、鎖得住、Redis 掛了也能用

先回答一個問題：**為什麼登入不用 Spring Security 的 `AuthenticationManager`？**

[09-spring-security/02](../09-spring-security/02-authentication-userdetails-password.md) 的整章都在講它：`UsernamePasswordAuthenticationFilter` → `ProviderManager` → `DaoAuthenticationProvider` → `UserDetailsService`。它很完整，但它解決的是「表單登入、建立 session」這個問題。本專題的登入要的是：

1. 在**驗密碼之前**做兩件事：IP 限流、帳號鎖定的「佔名額」（5.6.2）。
2. 驗密碼成功之後，**在一個交易裡**寫 refresh token，然後回傳兩個 token 的 JSON。
3. 失敗的時候，**回應的格式是 Problem Details**，訊息由 AC-2 規定。

這三件事都要在 `DaoAuthenticationProvider` 的前後各插一段。到最後，那條委派鏈裡唯一真正有用的是 `passwordEncoder.matches()` 那一行 —— 所以本專題直接寫一個 `LoginService`，`/api/auth/login` 是一個普通的 Controller，在 `SecurityConfig` 裡 `permitAll`。
代價是 `DaoAuthenticationProvider` 免費提供的計時保護（`mitigateAgainstTimingAttack`，09/02 的 2.5.2）要自己做 —— 5.6.1。

### 5.6.1 不洩漏帳號：一次一樣貴的 BCrypt

```java
/**
 * 5.6 登入（US-ACC-2 AC-1～3）與 5.7 refresh（AC-4～6）。
 *
 * 這個類別「沒有」@Transactional：BCrypt 一次約 75 ms（5.4.3），在交易裡做等於拿著一條連線什麼都不做。
 * 只有寫 refresh_tokens 的那幾句 SQL 在交易裡（TransactionTemplate）。
 */
@Service
public class LoginService {

    static final String BAD_CREDENTIALS = "email 或密碼不正確";
    // ……欄位與建構子省略……
    /** AC-2：帳號不存在時，也要做一次一樣貴的 BCrypt（5.6.1） */
    private final String dummyHash;          // 建構子裡：this.dummyHash = encoder.encode(UUID.randomUUID().toString());

    public TokenResponse login(String rawEmail, String password, String ip) {
        long ipWait = ipLimiter.tryAcquire(ip);
        if (ipWait > 0) throw new ShopException(ProblemType.RATE_LIMITED, "登入嘗試太頻繁，請稍後再試").with("retryAfter", ipWait);

        String email = Email.normalize(rawEmail);
        Attempt attempt = attempts.acquire(email);
        if (attempt.lockedForSeconds().isPresent())                                         // AC-3：即使這次密碼是對的
            throw new ShopException(ProblemType.RATE_LIMITED, "登入失敗次數過多，帳號暫時鎖定")
                    .with("retryAfter", attempt.lockedForSeconds().getAsLong());

        var account = accounts.findByEmail(email);
        boolean ok = encoder.matches(password, account.map(Account::passwordHash).orElse(dummyHash));
        if (!ok || account.isEmpty()) {
            if (attempts.failed(attempt)) {
                log.warn("LOGIN_LOCKED email={}", Email.mask(email));
                audit.recordRejection(AuditEntry.of(AuditAction.LOGIN_LOCKED, account.map(Account::id).orElse(null), null,
                        "USER", account.map(Account::id).orElse(null), Map.of("email", Email.mask(email))));
            }
            throw new ShopException(ProblemType.UNAUTHENTICATED, BAD_CREDENTIALS);         // AC-2：兩種情況一模一樣
        }
        attempts.succeeded(attempt);
        Account a = account.get();
        if (a.suspended()) throw new ShopException(ProblemType.FORBIDDEN, "帳號已停權");      // 密碼對了才說 —— 不會洩漏帳號是否存在
        String refresh = tx.execute(s -> refreshTokens.issue(a.id()));
        return tokens(a.id(), a, refresh);
    }
```

計時保護的核心是一行：**帳號不存在時，拿一個「假的」雜湊來比**。`dummyHash` 在啟動時用同一個 `BCryptPasswordEncoder`（cost 10）算好，所以它跟真的雜湊一樣貴。兩條路徑做一模一樣的事：一次查詢、一次 BCrypt、一次 `attempts.failed()`、丟同一個例外。

5.2.3 ① 的數字：正式版的差是 1.5～2.0 ms。AC-2 寫的是 < 50 ms，`AuthApiTest.noAccountEnumeration` 把它寫成計時斷言（0.12.2 那一列的「AC-2 用計時斷言」）：

```java
long[] a = new long[9], b = new long[9];
for (int i = 0; i < 9; i++) {
    if (i % 4 == 0) cleanupLock("erin" + DOMAIN);                       // 量的是比對密碼，不是鎖定
    long s = System.nanoTime(); login("erin" + DOMAIN, "wrong-" + i); a[i] = System.nanoTime() - s;
    s = System.nanoTime(); login("nobody-" + i + DOMAIN, "wrong-" + i); b[i] = System.nanoTime() - s;
}
Arrays.sort(a);
Arrays.sort(b);
double diff = Math.abs(a[4] - b[4]) / 1e6;
assertThat(diff).isLessThan(50);
```

```
ACC-2 AC-2：密碼錯誤 p50 79.8 ms、帳號不存在 p50 79.2 ms、差 0.6 ms
```

（5.12 的完整測試裡再跑了一次：75.6 ms、74.9 ms，差一樣是 0.6 ms。）

比的是中位數（9 次取第 5 個），不是平均：一次 GC 停頓就能讓平均值偏掉幾十毫秒，CI 上會變成一個時好時壞的測試。

> 📌 **「停權」的訊息為什麼可以不一樣？** 停權的檢查在**密碼驗證成功之後**。能看到「帳號已停權」的人，一定知道這個帳號的密碼 —— 他已經知道帳號存在了。
> 這條規則可以推廣：**區別對待只能發生在「你已經證明了你是誰」之後。** 在那之前，所有失敗都長得一樣。

### 5.6.2 鎖定：先佔名額，再驗密碼

5.2.3 ③ 的洞是「查計數」與「寫計數」之間隔了一次 BCrypt。修法是把順序倒過來：**先 `INCR`，再驗密碼**。

```java
/**
 * 5.6.2 US-ACC-2 AC-3：同一個帳號 15 分鐘內連續失敗 5 次 → 鎖定。計數在 Redis（多台機器共用）。
 *
 * 兩個順序上的決定：
 *  ① 先 INCR 佔一個名額、再驗密碼（5.2.3：先查再驗，50 個並行請求全部通過檢查）
 *  ② Redis 連不上時放行（0.6.3 的 fail-open），並且在 5 秒內不再嘗試（5.6.4：Redis「卡住」時，每一次碰它都要先等 500 ms 的逾時）
 */
@Component
class LoginAttempts {

    /** INCR 與第一次的 PEXPIRE 必須是同一個原子動作：行程在兩句之間死掉，這個 key 就永遠不會過期（永久鎖定） */
    static final RedisScript<List> ACQUIRE = RedisScript.of("""
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
            return {n, redis.call('PTTL', KEYS[1])}""", List.class);

    /** 鎖定中 → 剩餘秒數（Retry-After）；放行 → empty */
    record Attempt(String key, long count, OptionalLong lockedForSeconds) {
        static Attempt unchecked(String key) { return new Attempt(key, 0, OptionalLong.empty()); }
        boolean checked() { return count > 0; }
    }

    static String key(String normalizedEmail) { return "login:fail:" + normalizedEmail; }

    /** 登入「之前」：先佔一個名額。這一次也算進去 —— 第 6 次的 n = 6 > 5 */
    Attempt acquire(String normalizedEmail) {
        String key = key(normalizedEmail);
        if (clock.millis() < skipRedisUntil) { degraded.increment(); return Attempt.unchecked(key); }
        try {
            List<?> r = redis.execute(ACQUIRE, List.of(key), Long.toString(window.toMillis()));
            long n = ((Number) r.get(0)).longValue(), pttl = ((Number) r.get(1)).longValue();
            OptionalLong locked = n > maxFailures ? OptionalLong.of(Math.max(1, (pttl + 999) / 1000)) : OptionalLong.empty();
            return new Attempt(key, n, locked);
        } catch (DataAccessException e) {
            degrade(e);
            return Attempt.unchecked(key);
        }
    }

    /** 密碼錯誤。@return true = 這一次讓帳號進入鎖定（第 5 次失敗）：鎖定期從現在開始算 15 分鐘 */
    boolean failed(Attempt a) {
        if (!a.checked() || a.count() != maxFailures) return false;
        try {
            redis.expire(a.key(), window);
        } catch (DataAccessException e) {
            degrade(e);
        }
        return true;
    }

    /** 登入成功：「連續」失敗的計數歸零 */
    void succeeded(Attempt a) {
        if (!a.checked()) return;
        try {
            redis.delete(a.key());
        } catch (DataAccessException e) {
            degrade(e);
        }
    }
    // degrade()：5.6.4
}
```

**計數是「嘗試次數」，不是「失敗次數」**。每一個請求一進來就 `INCR`，不管它的密碼對不對。這讓 50 個同時到達的請求，各自拿到 1、2、3……50 的編號；**編號大於 5 的，連 BCrypt 都不做就被拒絕**。5.2.3 ③ 的正式版：每一輪剛好 5 個 `WRONG`、45 個 `LOCKED`。

成功的那一次會 `DEL`，所以「連續」兩個字成立：失敗 3 次、成功 1 次、再失敗 4 次，不會被鎖。

**鎖定的時間從第 5 次失敗開始算。** 第一次 `INCR` 設的 TTL 是「從第一次嘗試起 15 分鐘」—— 那是 AC-3 的「15 分鐘內」。第 5 次失敗時再 `EXPIRE` 一次，讓鎖定期重新算滿 15 分鐘。
`AuthApiTest.lockout` 確認第 6 次（密碼是對的）拿到 `429`，`Retry-After` 在 890～900 秒之間，`audit_logs` 有一筆 `LOGIN_LOCKED`。

**為什麼要 Lua？** `INCR` 與「第一次就設 TTL」是兩個指令。分開送的話，行程在兩句之間死掉（部署重啟、OOM），這個 key 就**沒有 TTL** —— 它永遠不會過期，這個帳號被永久鎖定。[10-redis/10](../10-redis/10-rate-limit-and-idempotency.md) 的 10.2.2「為什麼這三行一定要在 Lua 裡」是同一個理由。

> ⚠️ **鎖定本身是一個攻擊面。** 攻擊者知道你的 email，就可以每 15 分鐘故意錯 5 次，讓你永遠登入不了 —— 不需要猜中任何密碼。
> AC-3 選擇了「鎖帳號」而不是「鎖 IP」，接受了這個風險。緩解的方法（第 06 章之後可以做）：鎖定期間仍然允許「從曾經成功登入過的裝置」登入；或者改成逐步加長的延遲，而不是硬鎖。
> 這一章照需求做，但把這一段留在這裡：**需求做了一個取捨，那個取捨要被寫下來。**

### 5.6.3 鎖定的 key，跟查詢的 key，必須是同一個等價關係

5.2.3 ② 的洞，表面上是「Redis 的 key 沒有正規化好」。直覺的修法是把 key 正規化得更徹底：去重音、全形轉半形……

**這條路走不完。** MySQL 的 `utf8mb4_0900_ai_ci` 是 Unicode 排序演算法第一層的比較，它認為相等的字元組合，遠比「重音」與「全形」多。要在 Java 裡重寫一份**跟 MySQL 完全一樣**的等價關係，不可能做到，也不應該去做。

換一個方向：**讓「找得到這個帳號」的範圍變小，小到跟 Java 的正規化完全一致。**

```java
/**
 * 5.6.3：兩個條件。第一個走 uk_users_email（ai_ci，type=const）；第二個用 utf8mb4_bin 把「長得像」的排除掉。
 * 傳進來的一定是 Email.normalize() 過的值。
 */
Optional<Account> findByEmail(String normalizedEmail) {
    return one("WHERE u.email = ? AND u.email = ? COLLATE utf8mb4_bin", normalizedEmail, normalizedEmail);
}
```

```java
package com.example.shop.account.internal;

import java.util.Locale;

/**
 * 5.6.3 email 的「正規形」：去掉前後空白、轉小寫（Locale.ROOT —— 土耳其語系的 "I".toLowerCase() 不是 "i"）。
 *
 * 註冊時存的、登入時查的、鎖定計數用的 key，全部是這一個值。
 * 查詢用 COLLATE utf8mb4_bin 精確比對（Accounts.findByEmail）：users.email 的 utf8mb4_0900_ai_ci 不分大小寫，
 * 「也不分重音與全形」—— bùyer、ｂｕｙｅｒ 都會對到 buyer。那個寬鬆的比較只留給 UNIQUE（擋下長得像的帳號，US-ACC-1 AC-2）。
 */
final class Email {
    private Email() {}

    static String normalize(String raw) {
        return raw == null ? "" : raw.strip().toLowerCase(Locale.ROOT);
    }

    /** 0.6.5：日誌裡的 email 要遮罩。g***@example.com */
    static String mask(String email) {
        int at = email.indexOf('@');
        return at <= 0 ? "***" : email.charAt(0) + "***" + email.substring(at);
    }
}
```

三個地方用**同一個字串**：

| 用途 | 值 | 比較方式 |
|---|---|---|
| 註冊時存進 `users.email` | `Email.normalize(輸入)` | —— |
| 登入時找帳號 | `Email.normalize(輸入)` | `COLLATE utf8mb4_bin`：一個 byte 都不能差 |
| 鎖定計數的 Redis key | `"login:fail:" + Email.normalize(輸入)` | Redis 的 key 本來就是 byte 比較 |

所以 `bùyer00001@example.com` 會正規化成 `bùyer00001@example.com`（重音保留），**找不到任何帳號**。它有自己的鎖定計數器 —— 但那個計數器保護的是一個不存在的帳號，攻擊者在它身上猜多少次都跟 `buyer00001` 無關。5.2.3 ②b 的正式版：100 次猜測，拿受害者的雜湊比對了 **0 次**。

而大小寫的變體正規化之後都是 `buyer00001@example.com`：同一個帳號、同一個計數器。`AuthApiTest.lockout` 的最後一行，用 `FRANK@…` 登入一個被鎖住的 `frank@…`，一樣是 429。

**`ai_ci` 沒有被拿掉，它換了一個工作**：只負責 UNIQUE（5.4.1）。結果是一個不對稱、但一致的設計：

- **寬鬆的那一邊擋「建立」**：`bób@…` 不能註冊，因為它跟 `bob@…` 太像了。
- **嚴格的那一邊決定「你是誰」**：登入時，只有一模一樣的字串（正規化之後）才算數。

**效能**：多一個 `COLLATE utf8mb4_bin` 的條件，索引還用得上嗎？`EXPLAIN` 兩種寫法：

```
-- WHERE email = ? COLLATE utf8mb4_bin（只有這一個條件）
         type: range
          key: uk_users_email
         rows: 1
        Extra: Using where; Using index

-- WHERE email = ? AND email = ? COLLATE utf8mb4_bin（本專題的寫法）
         type: const
          key: uk_users_email
         rows: 1
        Extra: Using index
```

兩種都走 `uk_users_email`、都只讀 1 列。兩個條件的版本是 `const`：第一個條件用欄位自己的定序走唯一索引、最多找到一列，第二個條件只是在那一列上再比一次。

重跑方式（用上面那個 `mysql` 連線）：

```sql
EXPLAIN SELECT id FROM users WHERE email = 'buyer00001@example.com' COLLATE utf8mb4_bin\G
EXPLAIN SELECT id FROM users WHERE email = 'buyer00001@example.com' AND email = 'buyer00001@example.com' COLLATE utf8mb4_bin\G
```

（這兩句只選 `id`。`Accounts.findByEmail()` 實際的查詢還選了 `password_hash` 等不在索引裡的欄位，`Extra` 那一欄會跟上面不同。）

（專題寫完之後，在第 05 章結束時的程式碼、一個全新的資料庫（灌了 2.8.3 的種子資料）上跑了這兩句：第一句 `type: range`、`Extra: Using where; Using index`，第二句 `type: const`、`ref: const`、`Extra: Using index`，都是 `key: uk_users_email`、`rows: 1` —— 跟上面一樣。）

> 📌 **這個洞的根源在第 02 章。** 2.3 選 `utf8mb4_0900_ai_ci`，理由只有一個：讓 UNIQUE 不分大小寫（US-ACC-1 AC-2）。那時候沒有人想到「不分重音」也是它的一部分 —— 因為那時候還沒有任何東西在 Java 裡算 email 的 key。
> **一個欄位的定序，是一條沒有寫在任何程式碼裡的比較規則。** 只要有第二個地方（Redis、快取、另一個服務）也在比較同一個值，兩邊的規則就必須明確地對齊。

### 5.6.4 Redis 掛了：fail-open、退避、以及 IP 限流

0.6.3 的降級矩陣，「登入 × Redis」那一格寫的是：**200，但暫停「失敗 5 次鎖定」並告警**。理由也寫在那裡：fail-closed 的話，Redis 掛 60 秒 = 全站無法登入；fail-open 的話，這 60 秒內暴力破解不會被帳號鎖定擋下。本專題選 fail-open + 告警 + 仍保留 IP 層級的單機限流。

`LoginAttempts` 的每一個 Redis 呼叫都包在 `try/catch (DataAccessException)` 裡，失敗就當作「沒有被鎖」。剩下的問題是：**失敗要花多少時間？**

```java
static final Duration DEGRADED_BACKOFF = Duration.ofSeconds(5);

private void degrade(DataAccessException e) {
    boolean first = clock.millis() >= skipRedisUntil;
    skipRedisUntil = clock.millis() + DEGRADED_BACKOFF.toMillis();
    degraded.increment();
    if (first) log.warn("LOGIN_LOCKOUT_DEGRADED Redis 無法使用，{} 秒內暫停登入失敗鎖定（0.6.3 fail-open）：{}",
            DEGRADED_BACKOFF.toSeconds(), e.getMessage());
}
```

Redis 失敗一次之後，**5 秒內不再碰它**。告警有兩個訊號：一行 `LOGIN_LOCKOUT_DEGRADED` 的 WARN（每次進入降級只印一次），與一個計數器 `shop.login.lockout.degraded`（第 09 章接上告警）。

**這個「5 秒內不再碰它」真的需要嗎？** 我原本的想法是：Redis 的指令逾時是 500 ms（0.10.4 的 `spring.data.redis.timeout`），Redis 掛了，每一次登入都要先等 500 ms 才知道。F7 把 Redis 真的停掉來量：依序登入 12 次（前 6 次密碼錯、後 6 次密碼對），每一格是「狀態碼 延遲（ms）」：

```bash
mvn test -Pexperiments -Dtest=F7RedisDownLoginTest
```

```
═══ 5.6.4 Redis 正常：依序 12 次（前 6 次錯、後 6 次對）═══
  ours   401  106 │ 401   78 │ 401   77 │ 401  119 │ 401   98 │ 429    1 │ 429    1 │ 429    1 │ 429    1 │ 429    0 │ 429    0 │ 429    0（ms）
═══ docker stop shop-redis-1 ═══
  naive  401 1118 │ 401 1099 │ 401 1114 │ 401 1096 │ 401 1114 │ 401 1115 │ 200  760 │ 200  610 │ 200  603 │ 200  629 │ 200  614 │ 200  606（ms）
c.e.shop.account.internal.LoginAttempts  : LOGIN_LOCKOUT_DEGRADED Redis 無法使用，5 秒內暫停登入失敗鎖定（0.6.3 fail-open）：Redis command timed out
  ours   401  608 │ 401   74 │ 401   73 │ 401   75 │ 401   75 │ 401   74 │ 200  135 │ 200   91 │ 200   82 │ 200   85 │ 200   87 │ 200   88（ms）
  shop.login.lockout.degraded（累計）= 12
═══ docker pause shop-redis-1 ═══
  naive  401 1122 │ 401 1118 │ 401 1100 │ 401 1126 │ 401 1106 │ 401 1124 │ 200  589 │ 200  614 │ 200  618 │ 200  618 │ 200  608 │ 200  580（ms）
c.e.shop.account.internal.LoginAttempts  : LOGIN_LOCKOUT_DEGRADED Redis 無法使用，5 秒內暫停登入失敗鎖定（0.6.3 fail-open）：Redis command timed out
  ours   401  595 │ 401   77 │ 401   76 │ 401   76 │ 401   74 │ 401   73 │ 200  103 │ 200   87 │ 200   84 │ 200   86 │ 200   83 │ 200   87（ms）
  shop.login.lockout.degraded（累計）= 24
```

（naive 是「照直覺寫」的 fail-open：每一次都去碰 Redis，例外就當作沒有被鎖，沒有退避。）

這一次看起來完全符合預期：naive 每次失敗的登入要 1.1 秒（`GET` + `INCR` 兩個指令，各等 500 ms 的逾時，再加 BCrypt），每次成功的要 0.6 秒；ours 只有第一次付 0.6 秒，之後回到 BCrypt 的 75 ms 左右。

**但這只是其中一次。** 這個實驗一共跑了 5 次（第一次執行時還只有 `docker stop` 那一段），`docker stop` 只有上面這一次是逾時；另外 4 次長這樣（最後一次執行的輸出，其他三次幾乎相同）：

```
═══ docker stop shop-redis-1 ═══
  naive  401   83 │ 401   73 │ 401   74 │ 401   75 │ 401   77 │ 401   83 │ 200   74 │ 200   75 │ 200   74 │ 200   74 │ 200   80 │ 200   75（ms）
c.e.shop.account.internal.LoginAttempts  : LOGIN_LOCKOUT_DEGRADED Redis 無法使用，5 秒內暫停登入失敗鎖定（0.6.3 fail-open）：Redis exception
  ours   401   92 │ 401   74 │ 401   74 │ 401   75 │ 401   75 │ 401   73 │ 200  107 │ 200   86 │ 200   84 │ 200   87 │ 200   83 │ 200   81（ms）
═══ docker pause shop-redis-1 ═══
  naive  401 1122 │ 401 1112 │ 401 1121 │ 401 1101 │ 401 1126 │ 401 1092 │ 200  603 │ 200  602 │ 200  608 │ 200  599 │ 200  590 │ 200  590（ms）
c.e.shop.account.internal.LoginAttempts  : LOGIN_LOCKOUT_DEGRADED Redis 無法使用，5 秒內暫停登入失敗鎖定（0.6.3 fail-open）：Redis command timed out
  ours   401  608 │ 401   74 │ 401   76 │ 401   74 │ 401   77 │ 401   74 │ 200   90 │ 200   82 │ 200   81 │ 200   82 │ 200   81 │ 200   83（ms）
```

`docker stop` 之後，naive 也只要 75 ms：**沒有逾時**。例外訊息是 `Redis exception`，不是 `Redis command timed out`。

| `docker` 動作 | Redis 的狀態 | 5 次裡的結果 |
|---|---|---|
| `stop` | 行程結束、port 沒人在聽：連線被**拒絕**（TCP RST） | 4 次立刻失敗（`Redis exception`）、1 次逾時 |
| `pause` | 行程**凍結**：TCP 連線還在，但沒有任何回應 | 4 次都逾時（`Redis command timed out`） |

（`pause` 只有後 4 次執行有 —— 第一次執行的實驗還沒有這一段。）

「掛掉」有兩種：**停掉**的 Redis 很快就讓你知道它不在了；**卡住**的 Redis（GC 停頓、`KEYS *` 這種慢指令、網路丟包、主機當機但 TCP 還沒斷）會讓你等滿逾時，然後才知道。`stop` 那 1 次逾時，推測是 Lettuce 剛好在重新連線的過程中，指令被排進佇列、等到逾時 —— 我沒有再進一步追。

所以退避（5 秒內不碰 Redis）在「停掉」的情境下幾乎沒有作用，在「卡住」的情境下省下了 **每次 0.5～1 秒**。**後者才是退避存在的理由**，而它是比較難在本機重現的那一種 —— 只用 `docker stop` 測，你會得出「不需要退避」的結論。第 06 章的降級演練（驗收 Q8）兩種都要做。

兩種情境下，fail-open 都如設計運作：Redis 不在的時候，**第 6 次錯誤的密碼還是 401，不是 429** —— 鎖定暫停了。這就是 0.6.3 選擇的代價。

**IP 限流：Redis 掛了也還在的那一層**

0.6.3 的取捨有後半句：「**仍保留 IP 層級的單機限流**」。它不依賴 Redis，所以永遠在：

```java
/**
 * 5.6.4 0.6.3：「Redis 掛了也要保留 IP 層級的單機限流」。每台機器自己算，每個 IP 每分鐘 20 次（0.6.5）。
 * 單機的代價：N 台機器，實際上限是 20 × N。它不是主要防線（主要防線是帳號鎖定），是 Redis 掛掉時的底線。
 * 第 06 章的全站限流在 Redis 上；這一個不依賴任何東西，所以它永遠在。
 */
@Component
class IpLoginLimiter {

    record Window(long minute, AtomicInteger count) {}

    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    /** @return 0 = 放行；> 0 = 被限流，到下一分鐘還有幾秒 */
    long tryAcquire(String ip) {
        long now = clock.millis(), minute = now / 60_000;
        Window w = windows.compute(ip, (k, old) -> old == null || old.minute() != minute ? new Window(minute, new AtomicInteger()) : old);
        if (w.count().incrementAndGet() <= perMinute) {
            if (windows.size() > 100_000) windows.values().removeIf(x -> x.minute() < minute);   // 不讓 map 無限長大
            return 0;
        }
        return Math.max(1, ((minute + 1) * 60_000 - now + 999) / 1000);
    }
}
```

固定窗、單機、一個 `ConcurrentHashMap`。它有固定窗的邊界問題（[10-redis/10](../10-redis/10-rate-limit-and-idempotency.md) 的 10.2.3：邊界那一秒放進 2 倍流量），在這裡可以接受：它只是 Redis 掛掉那幾十秒裡的底線。`AuthApiTest.perIpLimit`：同一個 IP 送 20 次 → 401，第 21 次 → 429，帶 `Retry-After`。

**「IP」是誰的 IP？** `LoginService.login()` 的 IP 來自 `HttpServletRequest.getRemoteAddr()`。在正式環境，應用程式前面有一個負載平衡器，`getRemoteAddr()` 會是**負載平衡器的** IP —— 所有使用者共用一個 IP，每分鐘 20 次的限流會讓全站只能登入 20 次。

Spring Boot 的標準做法是 `server.forward-headers-strategy: native`，讓 Tomcat 的 `RemoteIpValve` 從 `X-Forwarded-For` 取出真正的客戶端 IP。但它有一個前提，用同一台機器、每次換一個 `X-Forwarded-For` 值，送 25 次登入：

```
forward-headers-strategy=none    401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 429 429 429 429 429
forward-headers-strategy=native  401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401
```

`none`（預設）：`X-Forwarded-For` 被忽略，25 次都是 127.0.0.1，第 21 次起 429。
`native`：**25 次都是 401，限流一次都沒有觸發** —— 每一次的「IP」都是 header 裡那個 `203.0.113.x`。

重跑方式（在 `shop/` 底下，先 `mvn package -DskipTests`；MySQL、Redis 要在跑。每一次登入用不同的 email，量的是 IP 限流，不是帳號鎖定）：

```bash
for strategy in none native; do
  java -jar target/shop-0.0.1-SNAPSHOT.jar --server.port=18086 --shop.order.jobs-enabled=false \
       --server.forward-headers-strategy=$strategy > xff.log 2>&1 &
  PID=$!
  until curl -s localhost:18086/actuator/health/readiness | grep -q UP; do sleep 1; done
  printf '%-33s' "forward-headers-strategy=$strategy"
  for i in $(seq 1 25); do
    curl -s -o /dev/null -w '%{http_code} ' -H 'Content-Type: application/json' -H "X-Forwarded-For: 203.0.113.$i" \
         -d "{\"email\":\"xff-$i@example.com\",\"password\":\"wrong-password\"}" localhost:18086/api/auth/login
  done; echo
  kill $PID; wait $PID 2>/dev/null
done
```

`IpLoginLimiter` 是記憶體裡的計數，每次重新啟動都歸零，所以兩種設定各啟動一次。

（專題寫完之後，在第 05 章結束時的程式碼、一個全新的資料庫（灌了 2.8.3 的種子資料）上照上面的指令原樣跑了一次，兩行輸出跟這一節開頭的一模一樣：`none` 第 21 次起 429，`native` 25 次都是 401。）

`RemoteIpValve` 只信任「從內部代理送來的」`X-Forwarded-For`，而它預設的內部代理清單包含 `127.0.0.1` 與 `10.x`、`192.168.x`、`172.16～31.x`。這次的請求從本機送出，所以被當成「從代理來的」。在正式環境，負載平衡器會在 `X-Forwarded-For` 的最後面附上它看到的真正來源，`RemoteIpValve` 從右往左取第一個不受信任的位址 —— 偽造的值在左邊，不會被採用。
**但只要應用程式也能從內部網路被直接存取**（另一個服務、一台跳板機、設定錯的安全群組），攻擊者就可以自己帶 `X-Forwarded-For`。這件事屬於部署的設定（第 09 章），但它直接決定了這一節的限流與 `audit_logs.ip` 欄位可不可信。

> 📌 **稽核的 `ip` 欄位也是同一個 `getRemoteAddr()`**（5.9.2）。本機的冒煙測試看到的是 `0:0:0:0:0:0:0:1`（curl 走 IPv6 的 localhost）。
> 上線前，`audit_logs.ip` 存的到底是使用者、還是負載平衡器的位址，要用一次真的請求確認。

---

## 5.7 refresh token：rotation 與重放偵測

### 5.7.1 `rotate()`：0.5.5 的硬規則，第三次

refresh token 是不透明的隨機字串（256 bits，Base64URL 之後 43 個字元），資料庫只存它的 SHA-256。為什麼不是 JWT，[09-spring-security/05](../09-spring-security/05-jwt-authentication.md) 的 5.6.1 講過：refresh token **一定要查資料庫**（rotation、撤銷），JWT「不用查資料庫」的好處在這裡用不到，「撤銷不了」的壞處卻全部都在。

5.2.4 的 naive 版本，錯在「先讀、判斷、再寫」。第 04 章已經兩次遇到同一個形狀：4.2.1 的扣庫存、4.6.1 的狀態轉移。修法也一樣 —— **條件寫進 UPDATE 的 WHERE，看影響列數**：

```java
/**
 * AC-4 rotation：舊的作廢、發新的。0.5.5 的同一條規則 —— 條件式 UPDATE，看影響列數（5.2.4：先讀再寫，同一個 token 換出兩張新的）。
 * 影響 0 列時用 FOR UPDATE 重讀：不管這個交易之前讀過什麼，都讀到最新提交的版本（5.7.1；4.6.2 就是「之前讀過」的那一種）。
 *
 * 不在這裡丟例外：REUSED 要撤銷這個使用者全部的 token，那個 UPDATE 必須 commit —— 丟例外會讓它 rollback。
 * 結果回傳給呼叫端，交易結束「之後」才變成 401。
 */
@Transactional(propagation = Propagation.MANDATORY)
Rotation rotate(String raw) {
    String h = hash(raw);
    Timestamp now = Timestamp.from(clock.instant());
    int n = jdbc.update("""
            UPDATE refresh_tokens SET used_at = ?
             WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?""", now, h, now);
    List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT user_id, used_at FROM refresh_tokens WHERE token_hash = ? FOR UPDATE", h);
    if (rows.isEmpty()) return Rotation.of(Outcome.UNKNOWN, null);
    long userId = ((Number) rows.get(0).get("user_id")).longValue();
    if (n == 1) return new Rotation(Outcome.ROTATED, userId, null);
    if (rows.get(0).get("used_at") != null && n == 0) {
        revokeAll(userId);                                                             // AC-5：重放 = 被偷了
        return Rotation.of(Outcome.REUSED, userId);
    }
    return Rotation.of(Outcome.EXPIRED_OR_REVOKED, userId);
}
```

四種結果：

| `UPDATE` 影響 | 重讀看到 | 結果 | 回應 |
|---|---|---|---|
| 1 列 | —— | `ROTATED`：發新的 | 200 |
| 0 列 | 沒有這一列 | `UNKNOWN`：根本不是我們發的 | 401 |
| 0 列 | `used_at` 有值 | `REUSED`：**撤銷這個使用者全部的 token** | 401 |
| 0 列 | `used_at` 是 NULL | `EXPIRED_OR_REVOKED`：過期了，或停權時被撤銷了 | 401 |

10 個請求同時送同一個 token：它們的 `UPDATE` 搶同一列的 X 鎖，**只有第一個**的 `WHERE used_at IS NULL` 成立。第一個 commit 之後，其他 9 個的 `UPDATE` 才拿到鎖 —— 這時 `UPDATE` 是 current read，看到 `used_at` 已經有值，影響 0 列。
**重讀用 `FOR UPDATE`。** 寫到這裡時，我的理由是 4.6.2 的教訓：一般的 `SELECT` 在 REPEATABLE READ 底下讀的是快照，那裡的 `used_at` 還是 NULL，9 個重放會被誤判成「過期」。
但量過之後，**在這個方法目前的寫法下，這個理由不成立**。把重讀改成一般的 `SELECT`、再跑一次 F4：

```
  2 個同時 │ ours   │ {換到新 token  1 個、活著的 token  0 個=50}
  10 個同時 │ ours   │ {換到新 token  1 個、活著的 token  0 個=50}
```

一樣正確。原因是 InnoDB 的快照（read view）在交易裡**第一次一般讀取**的時候才建立，不是在交易開始時。`rotate()` 的第一句是 `UPDATE`（current read，不建立快照），等到重讀那一句 `SELECT` 才建立快照 —— 那時贏家早就 commit 了，看得到 `used_at`。
4.6.2 會出事，是因為那個交易在 `UPDATE` **之前**已經讀過訂單。

那就再做一個實驗：在 `UPDATE` 前面加一句很自然的「先確認一下這個 token 在不在」（`SELECT COUNT(*) FROM refresh_tokens WHERE token_hash = ?`），重讀分別用一般的 `SELECT` 與 `FOR UPDATE`：

```
### 變體：UPDATE 前先 SELECT 一次 + 重讀用 plain
  2 個同時 │ ours   │ {換到新 token  1 個、活著的 token  1 個=50}
  10 個同時 │ ours   │ {換到新 token  1 個、活著的 token  1 個=50}
### 變體：UPDATE 前先 SELECT 一次 + 重讀用 forupdate
  2 個同時 │ ours   │ {換到新 token  1 個、活著的 token  0 個=50}
  10 個同時 │ ours   │ {換到新 token  1 個、活著的 token  0 個=50}
```

一般的 `SELECT`：**50 輪都沒有偵測到重放**（「活著的 token 1 個」= 贏家的 token 活了下來，沒有人撤銷全部）—— 快照在第一句 `SELECT` 時就建立了，重讀讀到的是「還沒有人用過」的那一刻。`FOR UPDATE` 不管前面讀過什麼都讀最新提交的版本，兩種寫法都正確。

所以 `FOR UPDATE` 在今天的程式碼裡**不是必要的**，它是**不依賴前提**的：它讓這段程式碼的正確性，不取決於「這個交易在 `UPDATE` 之前有沒有人讀過東西」。而那個前提，任何一個之後來改這段程式碼的人都可能在不知情的情況下打破。（兩個變體都只在實驗時改過，正式的程式碼沒有那句 `SELECT COUNT(*)`。）

**`rotate()` 不丟例外。** 重放的時候要做兩件事：撤銷全部的 token、回 401。如果在 `rotate()` 裡 `throw`，撤銷的那句 `UPDATE` 會跟著交易一起 rollback —— 5.2.5 的稽核消失，換了一張表重演。所以它**回傳結果**，呼叫端在交易結束之後才把它變成 401：

```java
public TokenResponse refresh(String raw) {
    Rotation r = tx.execute(s -> {
        Rotation rot = refreshTokens.rotate(raw);
        if (rot.outcome() == RefreshTokens.Outcome.REUSED)
            audit.record(AuditEntry.of(AuditAction.REFRESH_TOKEN_REUSED, rot.userId(), null, "USER", rot.userId(), null));
        if (rot.outcome() != RefreshTokens.Outcome.ROTATED) return rot;
        Account a = accounts.findById(rot.userId()).orElseThrow();
        if (a.suspended()) {                                                           // AC-6：refresh 立即失敗
            s.setRollbackOnly();
            return Rotation.of(RefreshTokens.Outcome.EXPIRED_OR_REVOKED, a.id());
        }
        return new Rotation(RefreshTokens.Outcome.ROTATED, a.id(), refreshTokens.issue(a.id()));
    });
    if (r.outcome() != RefreshTokens.Outcome.ROTATED) {
        if (r.outcome() == RefreshTokens.Outcome.REUSED) log.warn("REFRESH_TOKEN_REUSED userId={}（已撤銷該使用者全部的 refresh token）", r.userId());
        throw new ShopException(ProblemType.UNAUTHENTICATED, "refresh token 無效或已過期");
    }
    return tokens(r.userId(), accounts.findById(r.userId()).orElseThrow(), r.newToken());   // 角色從資料庫重讀：授權變更在這裡生效
}
```

這是 4.2.2 那句話的反面：那一節說「**讓例外穿出交易邊界，在外面決定下一步**」—— 因為例外一穿過交易代理，交易就被判了 rollback。這裡要的正是**不要** rollback，所以例外根本不進交易，在交易外面才丟。

`REFRESH_TOKEN_REUSED` 的稽核用 `audit.record()`（跟著交易）：它記的是「撤銷全部 token」這個**業務動作**，撤銷成功了它才算數（5.9.1）。

**停權的那一格反過來用了 `setRollbackOnly()`**：`rotate()` 已經把舊的 token 標成用過了，但使用者被停權，這次 refresh 不算數 —— 讓整個交易 rollback，舊 token 回到「沒用過」的狀態（它本來就已經在停權時被撤銷了，5.10）。

`AuthApiTest` 的兩個測試：

- `rotation`：refresh 一次 → 兩個 token 都換新；新的 refresh token 可以再用。
- `reuseDetection`：同一個使用者在兩台裝置登入；A 裝置 refresh 一次；**再用 A 的舊 token** → 401；接著 A 的新 token → 401、B 裝置的 token → 401；`refresh_tokens` 裡沒有任何一個 `revoked_at IS NULL` 的列；`audit_logs` 有一筆 `REFRESH_TOKEN_REUSED`。

### 5.7.2 兩個分頁同時 refresh：重放偵測的代價

回到 5.2.4 那張表的第二列：

```
  2 個同時 │ ours   │ {換到新 token  1 個、活著的 token  0 個=50}
```

一個正常的使用者開了兩個分頁。兩個分頁共用同一組 token（存在同一個 `localStorage` 裡），access token 在同一秒過期，兩邊同時送 refresh。
一個成功、一個被判定為重放 → **全部撤銷，包括剛成功的那一個**。15 分鐘後，兩個分頁都被登出。50 輪，每一輪都是這樣。

伺服器分不出「同一個人開了兩個分頁」與「本人和小偷同時用了同一個 token」—— 兩者在資料庫裡長得一模一樣。

三個選擇：

| 做法 | 兩個分頁 | 被偷的 token | 代價 |
|---|---|---|---|
| ① 嚴格（AC-5 字面，本專題） | 被登出 | 立即全部撤銷 | 使用者偶爾要重新登入 |
| ② 寬限期：用過的 token 在 N 秒內再來，回傳**同一組**新 token | 正常 | N 秒內的重放偵測不到 | 要存「這個 token 換出了哪一個」；N 秒的窗口 |
| ③ 前端保證同一時間只有一個 refresh（單一請求，其他分頁等它的結果） | 正常 | 立即全部撤銷 | 前端要做跨分頁的協調 |

本專題選 **① + ③**：後端照 AC-5 嚴格執行，並把「同一時間只送一個 refresh」寫進前端的規範（跟 5.5.2 的「token 不能放進 cookie」是同一份規範）。
② 是很多身分服務商的做法，但它在後端加了狀態與一個安全上的窗口 —— 它屬於「這個取捨要不要改」的討論，不是這一章的範圍（練習四）。

> 📌 **這個取捨在需求裡沒有寫。** AC-5 只寫了「被偷了怎麼辦」，沒有寫「兩個分頁怎麼辦」。F4 的那一列，是把一條安全規則套在一個**正常**使用情境上才看到的代價。
> 這種代價應該在需求階段就被看見 —— 但它通常要等到實作、甚至上線之後才被看見。

### 5.7.3 停權：最遲 15 分鐘，以及角色什麼時候生效

US-ACC-2 AC-6 是 0.4.2 那段 📌 說的「明確寫下的妥協」：停權之後，**已經發出去的 access token 繼續有效，最多 15 分鐘**；refresh **立即**失敗。

`AuthApiTest.suspend` 把這句話的每一個部分都寫成斷言：

```java
mvc.perform(json(post("/api/admin/users/" + userId(email) + "/suspend")).header("Authorization", admin)).andExpect(status().isOk());
refresh(t.get("refreshToken").asText()).andExpect(status().isUnauthorized());                        // refresh 立即失敗
mvc.perform(get("/api/me").header("Authorization", "Bearer " + t.get("accessToken").asText())).andExpect(status().isOk());   // access token 還能用
login(email, "correct-horse-battery").andExpect(status().isForbidden());                             // 重新登入：403 帳號已停權
```

`/api/me` 那一行（第三行）的 `isOk()` 看起來很奇怪 —— 一個被停權的人呼叫 API 成功了。**但那正是需求。** 測試把妥協寫成斷言，三個月後有人「修好」它（例如在 filter 裡查一次資料庫），這個測試會紅，然後那個人會讀到 AC-6，知道那是一個決定，不是一個 bug。

為什麼 refresh 能立即失敗？停權的那一刻撤銷了這個使用者全部的 refresh token（5.10），而 refresh 本來就要查資料庫。**access token 不查資料庫，所以它的撤銷只能等過期** —— 要即時，就要每個請求查一次黑名單（[10-redis/11](../10-redis/11-session-and-token-revocation.md)），那就回到了「每個請求都依賴 Redis」，0.6.3 的降級矩陣要重寫一列。

**角色也是同一件事。** 管理員授予 `SELLER` 之後（5.10），使用者手上的 access token 裡還是只有 `BUYER`；下一次 refresh 時，`refresh()` 從資料庫**重讀角色**（最後一行的註解），新的 token 才帶著 `SELLER`。`AuthApiTest.grantSeller`：

```java
assertThat(claims(t.get("accessToken").asText()).get("roles").toString()).isEqualTo("[\"BUYER\"]");      // 舊的 token 還是舊的角色
JsonNode refreshed = body(refresh(t.get("refreshToken").asText()).andExpect(status().isOk()));
assertThat(claims(refreshed.get("accessToken").asText()).get("roles").toString()).isEqualTo("[\"BUYER\",\"SELLER\"]");
```

這是 [09-spring-security/05](../09-spring-security/05-jwt-authentication.md) 的 5.5.2「權限是登入當下的快照」。授予角色可以晚 15 分鐘生效；**拿走**角色也一樣會晚 15 分鐘 —— 本專題的管理員不能拿走角色（5.10），停權是唯一「拿走」的方式，所以那 15 分鐘就是 AC-6 寫下的那 15 分鐘。

---

## 5.8 資料層級權限：別人的東西，一律 404

### 5.8.1 `OrderAccess`：把「是不是你的」集中到一個地方

第 03、04 章的做法是**慣例**：每一個查訂單的地方都寫 `WHERE order_no = ? AND buyer_id = ?`（`findIdByOrderNoAndBuyerId`），找不到就 404。四支買家的 API、三支賣家的 API，各自呼叫一次。

慣例的問題是：它對了 7 次，不代表第 8 次也會對。而且這一章要在「存在但不屬於你」時**多做一件事**（`ACCESS_DENIED`），7 個地方都要改。所以把它變成一個元件：

```java
/**
 * 5.8 資料層級權限：「這張訂單是不是你的」只在這裡判斷（0.6.5：在 Service 層，不只在 Controller）。
 *
 * 規則（US-ORD-5 AC-3、US-ORD-4 AC-5）：
 *  - 不存在 → 404
 *  - 存在但不屬於你 → 「一模一樣」的 404，外加一筆 ACCESS_DENIED
 *    獨立寫入（呼叫端接著會丟例外、rollback），而且在背景寫（5.8.3：同步寫的話，回應慢 2 ms，攻擊者從時間就分得出來）
 *
 * 每一支帶 {orderNo} 的 API 都必須經過這裡 —— IdorMatrixTest 會對每一支這樣的 API 用別人的身分打一次。
 */
@Component
class OrderAccess {

    private final OrderRepository orders;
    private final AuditLog audit;

    /** 只回傳 id，不載入 Entity（4.6.5：之後的 JDBC 狀態轉移不能被 persistence context 裡的舊 Entity 蓋掉） */
    long buyers(long buyerId, String orderNo) {
        return orders.findIdByOrderNoAndBuyerId(orderNo, buyerId)
                .orElseThrow(() -> denied(buyerId, Role.BUYER, orderNo, orders.existsByOrderNo(orderNo)));
    }

    long sellers(long sellerId, String orderNo) {
        return orders.findIdByOrderNoAndSellerId(orderNo, sellerId)
                .orElseThrow(() -> denied(sellerId, Role.SELLER, orderNo, orders.existsByOrderNo(orderNo)));
    }

    ShopException denied(long actorId, Role role, String orderNo, boolean exists) {
        if (exists) audit.recordRejectionLater(AuditEntry.of(AuditAction.ACCESS_DENIED, actorId, role.name(), "ORDER", orderNo, null));
        return ShopException.notFound("訂單");
    }
}
```

`OrderCommands` 原本的 `buyers()`、`sellers()` 兩個私有方法變成一行轉呼叫；`OrderQueryService.buyerOrder()` 也改成走同一條路：

```java
/**
 * US-ORD-5 AC-3：別人的訂單 → 404，跟「不存在」一模一樣，外加一筆 ACCESS_DENIED（5.8）。
 * 跟指令走同一條路（OrderAccess.buyers）：兩種 404 執行的 SQL 一模一樣，都不載入 Entity（5.8.3：時間也要一樣）
 */
@Transactional(readOnly = true)
public OrderView buyerOrder(long buyerId, String orderNo) {
    return byId(access.buyers(buyerId, orderNo));
}
```

找不到的時候多一句 `SELECT EXISTS`：「找不到」有兩種，只有其中一種要寫稽核。**這句查詢只發生在 404 的路徑上**，正常讀自己訂單的請求一句都沒有多。

`catalog` 的 `ProductService.owned()`（賣家的五支商品 API 都經過它）也做了同樣的事：存在但不是你的 → 404 + `ACCESS_DENIED`，`target_type = PRODUCT`。US-AUD-1 寫的是「**所有** `ACCESS_DENIED`」，不只訂單。改價的稽核（`PRODUCT_PRICE_CHANGED`，`detail` 帶舊價與新價）也在同一個類別：用 `compareTo` 比，`299` 與 `299.00` 不算改價。完整的 `ProductService` 見 5.12.1。

### 5.8.2 越權矩陣：`IdorMatrixTest`

`OrderAccess` 是「規則」，`IdorMatrixTest` 是「有測試守著」。它是驗收 Q5 的完整版：**每一支帶著資源 id 的 API，用別人的身分打一次**。

```java
static final List<Cell> MATRIX = List.of(
        new Cell("GET", "/api/orders/{orderNo}", null, false),
        new Cell("POST", "/api/orders/{orderNo}/cancel", null, false),
        new Cell("POST", "/api/orders/{orderNo}/confirm-receipt", null, false),
        new Cell("POST", "/api/orders/{orderNo}/payments", null, false),
        new Cell("POST", "/api/seller/orders/{orderNo}/start-picking", null, true),
        new Cell("POST", "/api/seller/orders/{orderNo}/ship", "{\"carrier\": \"黑貓\", \"trackingNo\": \"T-1\"}", true),
        new Cell("POST", "/api/seller/orders/{orderNo}/cancel", null, true),
        new Cell("PATCH", "/api/seller/products/{id}", "{\"price\": 1}", true),
        new Cell("POST", "/api/seller/products/{id}/publish", null, true),
        new Cell("POST", "/api/seller/products/{id}/unpublish", null, true),
        new Cell("POST", "/api/seller/products/{id}/restock", "{\"quantity\": 1000}", true));
```

準備：買家 `990701` 對賣家 `990711` 的商品下一張真的訂單（打 `POST /api/orders`）。攻擊者是另一個買家 `990702` 與另一個賣家 `990712`。每一格做四件事：

1. 用攻擊者的身分打**真的資源** → 必須是 404。
2. 用攻擊者的身分打**不存在的資源**（`19990101-000000`、`999999999`）→ 把兩個 body 裡的 id 換成 `{id}` 之後，**必須一模一樣**。
3. 等背景的稽核寫完（最多 2 秒）→ 攻擊者的 `ACCESS_DENIED` **剛好多 1 筆**（打不存在的那一次不算）。
4. 全部打完之後，訂單、付款、商品、庫存的狀態**跟開始前完全一樣**。

body 的請求都是「合法」的（`ship` 有物流資訊、`restock` 有數量）：如果 body 不合法，400 會在權限檢查之前發生 —— 那也不會洩漏任何東西，但就測不到 `OrderAccess` 了。

```bash
mvn test -Dtest=IdorMatrixTest
```

```
  帶路徑變數的 API 16 支：矩陣 11、豁免 5
  GET    /api/orders/{orderNo}                         別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/orders/{orderNo}/cancel                  別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/orders/{orderNo}/confirm-receipt         別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/orders/{orderNo}/payments                別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/seller/orders/{orderNo}/start-picking    別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/seller/orders/{orderNo}/ship             別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/seller/orders/{orderNo}/cancel           別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  PATCH  /api/seller/products/{id}                     別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/seller/products/{id}/publish             別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/seller/products/{id}/unpublish           別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  POST   /api/seller/products/{id}/restock             別人的 404 │ 不存在的 404 │ body 相同 true  │ ACCESS_DENIED +1
  資料：之前 {order_status=PENDING_PAYMENT, payments=0, product=100.00/ON_SALE, inventory=10/1}
        之後 {order_status=PENDING_PAYMENT, payments=0, product=100.00/ON_SALE, inventory=10/1}
```

11 格全部通過。最後兩行是第 4 件事：攻擊者試著取消、付款、出貨、改價成 1 元、補貨 1,000 件 —— 什麼都沒有發生。

**第一行是矩陣自己的覆蓋掃描**：跟 5.5.5 一樣，從 `RequestMappingHandlerMapping` 列出所有帶路徑變數的 API，必須**每一支**都在矩陣裡，或者在豁免清單裡、附上理由：

```java
/** 帶路徑變數、但「不是別人的資源」的 API */
static final Map<String, String> EXEMPT = Map.of(
        "GET /api/products/{id}", "公開；沒有擁有者的概念（下架的商品對所有人都是 404，US-PRD-3）",
        "PATCH /api/cart/items/{productId}", "productId 指的是商品，購物車本身只有自己的那一台（WHERE buyer_id = 自己）",
        "DELETE /api/cart/items/{productId}", "同上",
        "POST /api/admin/users/{id}/roles", "管理員對任何帳號都可以操作（0.3.2），不是資料層級的權限",
        "POST /api/admin/users/{id}/suspend", "同上");

@Test @DisplayName("每一支帶路徑變數的 API，不是在矩陣裡，就是在 EXEMPT 裡")
void matrixCoversEveryRoute() {
    // ……從 RequestMappingHandlerMapping 收集 withVariables……
    assertThat(withVariables).as("新增了帶 id 的 API？把它加進 MATRIX，或者在 EXEMPT 寫下理由").isEqualTo(covered);
}
```

下一個人加了一支 `GET /api/seller/orders/{orderNo}`（賣家看單張訂單，很合理的需求），這個測試會紅，訊息告訴他兩個選擇。**他不能「什麼都不做」**。

> 📌 **兩個覆蓋掃描，守著兩個不同的層。** 5.5.5 的 `SecurityRouteCoverageTest` 問「每一支 API 有沒有 URL 規則」—— 那是 5.3.3 的第 ① 層。
> `IdorMatrixTest` 問「每一支帶 id 的 API 有沒有資料層級的檢查」—— 第 ③ 層。URL 規則再完整，也回答不了「這筆資料是不是你的」。

### 5.8.3 ⚠️ 404 一樣，時間不一樣

5.8.2 證明了：兩種 404 的**內容**一模一樣。但 5.2.3 的洞一教過我們：內容一樣不代表攻擊者分不出來。

「存在但不是你的」比「不存在」**多做了一件事**：寫一筆 `ACCESS_DENIED`。`OrderAccess` 的第一版是用 `recordRejection()` 寫的 —— `REQUIRES_NEW`、在請求的執行緒上、INSERT 之後 commit（commit 要等 redo log 寫進磁碟）。

F6 把兩種 404 交錯送出，各 1,000 次，單一連線依序執行。「存在但不是你的」用種子資料裡別人的訂單，「不存在」用隨機產生、確認不存在的編號。最後一欄是：**隨機各抽一個，「存在」的那一個比較慢的機率** —— 也就是攻擊者只送**一次**請求、看時間猜「存在」，猜對的機率。50% 代表完全分不出來。

```bash
mvn test -Pexperiments -Dtest=F6DeniedTimingTest
```

**第一版**（`recordRejection()`，同步寫入）：

```
═══ 5.8.3 兩種 404 的回應時間（交錯、依序，各 1,000 次）═══
  第 1 輪 │ 存在但不是你的 p50  4.62  p90  6.29 ms │ 不存在 p50  2.22  p90  2.98 ms │ p50 差 +2.40 ms │ 「存在」比較慢的比例 98%
  第 2 輪 │ 存在但不是你的 p50  3.59  p90  5.02 ms │ 不存在 p50  1.70  p90  2.19 ms │ p50 差 +1.90 ms │ 「存在」比較慢的比例 98%
  第 3 輪 │ 存在但不是你的 p50  3.77  p90  6.60 ms │ 不存在 p50  1.70  p90  3.07 ms │ p50 差 +2.07 ms │ 「存在」比較慢的比例 94%
```

**一次請求，94～98% 的機率猜對。** 2 ms 的差距，比 p90 與 p50 之間的雜訊還大。5.2.2 的 403 讓攻擊者 6.5 秒就估出營業量 —— 換成「看時間的 404」，他只是要多花一點點時間做統計。**404 的規則被回應時間打穿了**，而 5.8.2 的矩陣每一格都是綠的。

（在網際網路上，延遲的抖動是好幾毫秒，一次請求不會分得這麼清楚。但同一個請求送 10 次、取中位數，2 ms 的差距就會浮出來。這個專題的需求沒有寫「攻擊者在多遠的地方」。）

**第二版**：把 `ACCESS_DENIED` 的寫入移出請求的執行緒（`recordRejectionLater()`，5.9.1）。回應不等它：

```
  第 1 輪 │ 存在但不是你的 p50  2.58  p90  3.80 ms │ 不存在 p50  2.39  p90  3.72 ms │ p50 差 +0.19 ms │ 「存在」比較慢的比例 60%
  第 2 輪 │ 存在但不是你的 p50  2.01  p90  3.13 ms │ 不存在 p50  1.91  p90  2.88 ms │ p50 差 +0.10 ms │ 「存在」比較慢的比例 56%
  第 3 輪 │ 存在但不是你的 p50  1.75  p90  2.78 ms │ 不存在 p50  1.63  p90  2.69 ms │ p50 差 +0.12 ms │ 「存在」比較慢的比例 56%
```

差距從 2 ms 掉到 0.1～0.2 ms，比例從 94～98% 掉到 56～60%。但還沒到 50%。

剩下的差在哪裡？`buyerOrder()` 當時還是第 03 章的寫法：`orders.findByOrderNo(orderNo).filter(x -> x.getBuyerId() == buyerId)` —— 「存在」的那一條會**載入整個 `Order` Entity**（Hibernate 要建物件、放進 persistence context），「不存在」的那一條什麼都沒載入。

**第三版**：讓 `buyerOrder()` 也走 `OrderAccess.buyers()`（5.8.1 的那段程式碼）。兩種 404 執行**完全相同的兩句 SQL**（`SELECT id ... WHERE order_no = ? AND buyer_id = ?`、`SELECT EXISTS ...`），都不載入 Entity：

```
  第 1 輪 │ 存在但不是你的 p50  2.67  p90  3.98 ms │ 不存在 p50  2.58  p90  3.87 ms │ p50 差 +0.09 ms │ 「存在」比較慢的比例 53%
  第 2 輪 │ 存在但不是你的 p50  1.88  p90  2.79 ms │ 不存在 p50  1.83  p90  2.85 ms │ p50 差 +0.05 ms │ 「存在」比較慢的比例 53%
  第 3 輪 │ 存在但不是你的 p50  1.59  p90  2.12 ms │ 不存在 p50  1.55  p90  2.21 ms │ p50 差 +0.04 ms │ 「存在」比較慢的比例 55%
```

| 版本 | p50 差 | 一次請求猜對的機率 |
|---|---|---|
| ① 同步寫稽核 | +1.90 ～ +2.40 ms | 94 ～ 98% |
| ② 稽核在背景寫 | +0.10 ～ +0.19 ms | 56 ～ 60% |
| ③ ② + 兩條路徑同樣的 SQL | +0.04 ～ +0.09 ms | 53 ～ 55% |

**53～55% 不是 50%。** 剩下的差，我推測來自背景的那一筆 INSERT 跟下一個請求搶資料庫與 CPU —— 它本質上就是「存在」才會發生的工作，只是被挪到了回應之後。要完全消除，得讓「不存在」也做一樣多的工作（例如也寫一筆稽核），那會讓每一個打錯字的請求都寫一筆資料。本專題停在 ③：一次請求的優勢只剩幾個百分點，要累積出統計上的把握需要大量請求 —— 而那正是第 06 章的限流與 5.8.4 的告警要抓的東西。

第二版的代價寫在 `AuditLog.recordRejectionLater()` 的註解裡：**行程在寫入之前死掉，那一筆就沒有了**。`ACCESS_DENIED` 可以接受這個代價（它是「偵測」用的訊號，不是帳本），付款簽章錯誤與登入鎖定不行 —— 它們沒有時間差的問題（攻擊者本來就知道自己送的簽章是錯的），所以它們繼續用同步的 `recordRejection()`。

> 📌 **安全的「一樣」有三層：狀態碼一樣、內容一樣、時間一樣。** 5.2.2 的 403 輸在第一層，body 長度不同的版本輸在第二層，這一節的第一版輸在第三層。
> 第三層最難，因為它不在任何一行程式碼裡 —— 它是「兩條路徑各做了什麼」的總和。**每加一件「只有某一條路徑才做」的事，就要重量一次。**

### 5.8.4 驗收 Q5

0.12.1 的 Q5：「買家 A 讀買家 B 的訂單：回 404（不是 403），且寫入稽核日誌」。

這一題刻意**不用** `TestTokens`：兩個買家真的註冊、真的登入，用登入回來的 token。身分是這一題要驗證的東西本身：

```java
/** 真的註冊、真的登入：這一題的身分不是 TestTokens 簽的，是 POST /api/auth/login 回來的 */
static String signUpAndLogin(int port, String email) throws Exception {
    assertThat(http(port, "POST", "/api/auth/register", null,
            "{\"email\": \"%s\", \"password\": \"q5-password-1234\", \"displayName\": \"Q5\"}".formatted(email)).statusCode()).isEqualTo(201);
    String body = http(port, "POST", "/api/auth/login", null, "{\"email\": \"%s\", \"password\": \"q5-password-1234\"}".formatted(email)).body();
    return "Bearer " + new Http(200, body, null).between("\"accessToken\":\"", "\"");
}

@Test
@DisplayName("Q5 買家 A 讀買家 B 的訂單：回 404（不是 403），且寫入稽核日誌")
void q5_idorReturns404() throws Exception {
    // ……啟動應用程式、建一個有庫存的商品……
    String tokenA = signUpAndLogin(port, a), tokenB = signUpAndLogin(port, b);
    // B 下一張真的訂單（POST /api/orders，帶 Idempotency-Key）……
    HttpResponse<String> mine = http(port, "GET", "/api/orders/" + orderNoB, tokenB, null);
    HttpResponse<String> theirs = http(port, "GET", "/api/orders/" + orderNoB, tokenA, null);
    HttpResponse<String> ghost = http(port, "GET", "/api/orders/19990101-000000", tokenA, null);
    String theirsBody = theirs.body().replace(orderNoB, "{orderNo}"), ghostBody = ghost.body().replace("19990101-000000", "{orderNo}");

    await().atMost(java.time.Duration.ofSeconds(2)).until(() ->
            jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'ACCESS_DENIED' AND actor_id = ?", Long.class, idA) == 1);
    // ……
    assertThat(mine.statusCode()).isEqualTo(200);
    assertThat(theirs.statusCode()).isEqualTo(404);
    assertThat(theirsBody).isEqualTo(ghostBody);
    assertThat(audit).containsEntry("actor_id", idA).containsEntry("actor_role", "BUYER")
            .containsEntry("target_type", "ORDER").containsEntry("target_id", orderNoB);
}
```

`await()` 是 Awaitility（`spring-boot-starter-test` 本來就帶了）：`ACCESS_DENIED` 在背景寫（5.8.3），測試要等它出現，而不是 `Thread.sleep` 一個猜出來的時間。

```bash
mvn test -Dtest='CapstoneAcceptanceTest#q5*'
```

```
Q5：B 讀自己的 → 200；A 讀 B 的 → 404；A 讀不存在的 → 404；兩個 404 的 body 相同 = true；稽核 {actor_id=21049, actor_role=BUYER, target_type=ORDER, target_id=20261001-435231, ip=127.0.0.1}
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 17.61 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
```

**Q5 綠了。** README 的原題是「買家 A 直接改網址帶入買家 B 的訂單 ID，會發生什麼事？」—— 答案：

1. 他拿到一個跟「訂單不存在」一模一樣的 404（內容一樣，時間只差 0.04～0.09 ms，5.8.3）。
2. 伺服器記下一筆 `ACCESS_DENIED`：誰（A 的 id 與角色）、試了哪一張（B 的訂單編號）、從哪裡來（IP）、什麼時候。
3. B 的訂單沒有任何改變，而且這件事對**每一支**帶訂單編號或商品 id 的 API 都成立（5.8.2 的 11 格）。

**US-ORD-5 AC-4 的告警（「同一買家 1 分鐘內觸發 AC-3 超過 20 次」）留給第 09 章**，但 5.2.2 已經給了它一個反例：F2 的 21 次剛好落在同一分鐘 —— 攻擊者每分鐘試 19 次，一天可以試 27,000 次，告警一次都不會響。
第 09 章接告警時，時間窗要用**一小時**以上，資料直接來自 `audit_logs`：

```sql
-- 過去一小時，ACCESS_DENIED 超過 50 次的使用者（idx_audit_action：action, created_at）
SELECT actor_id, COUNT(*) AS denied FROM audit_logs
 WHERE action = 'ACCESS_DENIED' AND created_at >= NOW(3) - INTERVAL 1 HOUR
 GROUP BY actor_id HAVING denied > 50;
```

正常的使用者幾乎不會觸發 `ACCESS_DENIED`（他不會去猜別人的訂單編號），所以門檻可以設得很低。這是 404 規則的另一半：**對攻擊者完全沉默，對防守方大聲說話。**

---

## 5.9 稽核：三種寫法

### 5.9.1 `AuditLog`：選錯一個，稽核就會說謊

5.2.5 的結論是：稽核要分兩類，「成功了才算數」與「被拒絕」。5.8.3 又多分出了一類：「被拒絕，而且不能讓回應等它」。三類，三個方法：

```java
package com.example.shop.shared.audit;

/**
 * US-AUD-1 稽核日誌（5.9）。三個方法，差別只在「交易」與「哪一條執行緒」—— 選錯一個，稽核就會在不該消失的時候消失、在不該出現的時候出現（5.2.5）。
 */
public interface AuditLog {

    /**
     * 業務動作的一部分（AC-1）：必須在呼叫端的交易裡（MANDATORY）。
     * 業務 rollback，這一筆也 rollback —— 稽核不會記下一件沒有發生的事。
     */
    void record(AuditEntry entry);

    /**
     * 被拒絕的動作（AC-1 的例外）：越權、簽章錯誤、金額不符、登入鎖定。
     * 接下來呼叫端會丟例外、它所在的交易會 rollback；所以這一筆在自己的交易裡（REQUIRES_NEW）立刻 commit。
     * ⚠️ 這代表它會「另外佔用一條連線」（4.8.2）。
     */
    void recordRejection(AuditEntry entry);

    /**
     * 跟 recordRejection 一樣是獨立寫入，但「不在請求的執行緒上」寫：回應不等它（5.8.3）。
     * 用在 ACCESS_DENIED —— 兩種 404 的回應時間如果不一樣，「存在但不是你的」就會從時間洩漏出去。
     * 代價：行程在寫入之前死掉，或佇列滿了，這一筆就沒有了（有計數器 shop.audit.dropped）。
     */
    void recordRejectionLater(AuditEntry entry);
}
```

9 種動作，各自用哪一個：

| 動作 | 故事 | 方法 | 理由 |
|---|---|---|---|
| `ROLE_GRANTED` | ACC-3 AC-1 | `record` | 授權失敗（例如帳號不存在）就不該有這筆 |
| `USER_SUSPENDED` | ACC-3、ACC-2 AC-6 | `record` | 同上 |
| `PRODUCT_PRICE_CHANGED` | AUD-1 | `record` | 改價 rollback 了，價格沒變 |
| `ORDER_CANCELLED_BY_SELLER` | ORD-6 AC-5 | `record` | 5.2.5：取消失敗（409），不能有「已取消」 |
| `REFRESH_TOKEN_REUSED` | ACC-2 AC-5 | `record` | 它記的是「撤銷全部 token」這個動作；那個交易會 commit（5.7.1） |
| `PAYMENT_SIGNATURE_INVALID` | ORD-2 AC-3 | `recordRejection` | 5.2.5：401 會讓回呼的交易 rollback |
| `PAYMENT_AMOUNT_MISMATCH` | ORD-2 AC-4 | `recordRejection` | 同上（400） |
| `LOGIN_LOCKED` | ACC-2 AC-3 | `recordRejection` | 登入失敗本來就沒有交易；要確定寫進去之後才回 401 |
| `ACCESS_DENIED` | ORD-5 AC-3 | `recordRejectionLater` | 5.8.3：回應時間不能透露「存在」 |

判斷的問題只有兩個：**這個動作成功了嗎？**（成功才算數 → `record`）；**接下來會不會 rollback？**（會 → 獨立寫入）。第三個問題只對一種動作有意義：**回應的時間會不會洩漏什麼？**

> 📌 `REFRESH_TOKEN_REUSED` 看起來像「被拒絕的動作」（回應是 401），但它用 `record`。差別在於：重放偵測的交易**會 commit** —— 它撤銷了全部的 token，那是一個成功的業務動作，只是結果對客戶端來說是 401。
> **看的是交易的命運，不是 HTTP 的狀態碼。**

### 5.9.2 `JdbcAuditLog`：在誰的執行緒上取 IP

```java
@Component
class JdbcAuditLog implements AuditLog, DisposableBean {

    /** AC-2：稽核內容不含密碼、token、卡號。擋在「鍵名」上：值是什麼，這一層無從判斷 */
    static final Pattern SECRET_KEY = Pattern.compile("password|passwd|token|secret|authorization|signature|card");

    /** 一條執行緒、一萬筆的佇列。滿了就丟（不要讓攻擊者用 ACCESS_DENIED 把記憶體或連線池塞爆） */
    private final ThreadPoolExecutor background = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(10_000),
            r -> { Thread t = new Thread(r, "audit-writer"); t.setDaemon(true); return t; });

    // 建構子：background.setRejectedExecutionHandler((r, ex) -> dropped.increment());

    /** 一列要寫的值。ip 與 traceId 在「呼叫端的執行緒」上取：換到背景執行緒之後，RequestContextHolder 與 MDC 都是空的 */
    record Row(Object[] args) {}

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void record(AuditEntry e) { insert(row(e)); }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordRejection(AuditEntry e) { insert(row(e)); }

    @Override
    public void recordRejectionLater(AuditEntry e) {
        Row row = row(e);
        background.execute(() -> {
            try {
                insert(row);                                               // 沒有交易：一句 INSERT，autocommit
            } catch (RuntimeException ex) {
                dropped.increment();
                log.error("AUDIT_DROPPED action={} target={}", e.action(), e.targetId(), ex);
            }
        });
    }

    /** 關機時把佇列裡的寫完（最多等 5 秒） */
    @Override
    public void destroy() throws InterruptedException {
        background.shutdown();
        if (!background.awaitTermination(5, TimeUnit.SECONDS)) log.warn("AUDIT_DROPPED 關機時還有 {} 筆沒寫", background.getQueue().size());
    }

    private Row row(AuditEntry e) {
        return new Row(new Object[]{e.actorId(), e.actorRole(), e.action().name(), e.targetType(), e.targetId(), detail(e.detail()),
                clientIp(), MDC.get("traceId")});                          // traceId：第 09 章才會有人放進 MDC，在那之前是 NULL
    }

    // insert()：一句 INSERT INTO audit_logs (...) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    // clientIp()：RequestContextHolder → HttpServletRequest.getRemoteAddr()；不在 HTTP 請求裡（排程、消費者）→ NULL
}
```

三個細節：

**`row()` 在呼叫端的執行緒上執行。** IP 從 `RequestContextHolder` 取、traceId 從 `MDC` 取 —— 兩者都是 `ThreadLocal`。如果把整個 `insert(e)` 丟進背景執行緒，那裡的 `RequestContextHolder` 是空的，**每一筆 `ACCESS_DENIED` 的 IP 都會是 NULL**。
[09-spring-security/08](../09-spring-security/08-auditing-and-security-testing.md) 的 8.4.2「換一條執行緒，auditor 就不見了」是同一件事。所以先在請求的執行緒上把所有的值取好（`Row`），只把「寫入」丟出去。

**佇列有上限，滿了就丟。** 一個每秒送 10,000 個越權請求的攻擊者，不應該能讓伺服器的記憶體無限長大，或者讓稽核把連線池吃光。單一執行緒、一萬筆的佇列，丟掉的有一個計數器（`shop.audit.dropped`）—— 那個計數器大於 0 本身就是一個告警（第 09 章）。

**`detail` 的鍵名檢查**是 US-AUD-1 AC-2 的實作（「稽核內容不含密碼、token、完整信用卡號」）。它擋在**鍵名**上：值是什麼，這一層無從判斷（一個字串看起來像不像 token？），但一個叫 `password` 的欄位不應該出現在稽核裡，不管它的值是什麼。`JdbcAuditLogTest`：

```java
for (String key : new String[]{"password", "newPassword", "refreshToken", "Authorization", "jwtSecret", "cardNumber", "revokedRefreshTokens"})
    assertThatThrownBy(() -> audit.detail(Map.of(key, "x"))).as(key).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining(key);
assertThat(audit.detail(Map.of("revokedSessions", 3, "oldPrice", 299))).contains("revokedSessions");
```

清單裡最後一個 `revokedRefreshTokens` 是**我自己的程式碼**：停權的稽核（5.10）第一版的 detail 叫 `Map.of("revokedRefreshTokens", revoked)` —— 撤銷了幾個 refresh token，一個完全無害的數字。寫完 `JdbcAuditLog` 回頭讀停權那一段時才注意到，它的鍵名含有 `token`，會被這個檢查擋下（測試的最後一個鍵就是它）：停權的交易會在寫稽核那一步丟 `IllegalArgumentException`，整個停權 rollback、回 500。改名成 `revokedSessions`。
**一個寬鬆的檢查，會有誤判**；這裡選擇誤判（擋下無害的鍵名），而不是漏判（放過一個真的 token）—— 誤判會在第一次執行時就變成 500，漏判永遠不會被發現。

### 5.9.3 修正之後

5.2.5 的三個錯，各改一行：

```java
// JdbcPaymentService.record()：簽章錯誤、金額不符 → recordRejection
if (!CallbackSignature.matches(expected, cb.signature())) {
    log.warn("PAYMENT_SIGNATURE_INVALID paymentId={}", cb.paymentId());
    // 接下來的 401 會讓回呼的交易 rollback：稽核要在自己的交易裡（5.2.5）
    audit.recordRejection(AuditEntry.of(AuditAction.PAYMENT_SIGNATURE_INVALID, null, "PAYMENT_PROVIDER", "PAYMENT", cb.paymentId(),
            Map.of("providerTxnId", cb.providerTxnId())));
    throw new ShopException(ProblemType.UNAUTHENTICATED, "簽章不正確");
}
```

金額不符那一段一樣換成 `recordRejection`，`detail` 是 `expected`、`actual`、`providerTxnId`（完整的 `JdbcPaymentService` 見 5.12.1）。鍵名要避開 5.9.2 的 `SECRET_KEY`：如果把回呼的簽章也記進去、叫它 `signature`，寫稽核那一步就會丟 `IllegalArgumentException`。

```java
/** US-ORD-6 AC-5：稽核跟取消在同一個交易 —— 取消失敗（例如已經出貨，409），稽核也跟著 rollback（5.2.5） */
@Transactional
public OrderView cancelBySeller(long sellerId, String orderNo) {
    long id = sellers(sellerId, orderNo);
    transitions.apply(id, OrderEvent.SELLER_CANCEL, OrderHistory.Actor.seller(sellerId), EventData.cancel("SELLER_OUT_OF_STOCK"));
    audit.record(AuditEntry.of(AuditAction.ORDER_CANCELLED_BY_SELLER, sellerId, Role.SELLER.name(), "ORDER", orderNo,
            Map.of("cancelReason", "SELLER_OUT_OF_STOCK")));
    return queries.byId(id);
}
```

賣家取消改了兩件事：方法換成 `record`，**位置移到 `transitions.apply()` 之後**。前者讓它跟取消同生共死；後者讓它只在「取消確實發生了」之後才被寫 —— 就算有人哪天把它改回 `recordRejection`，至少它不會在狀態轉移失敗時被寫進去。

```
AUD：簽章錯誤 → 401；PAYMENT_SIGNATURE_INVALID 1 筆
AUD：賣家取消 PAID → 成功；ORDER_CANCELLED_BY_SELLER 1 筆
AUD：賣家取消 SHIPPED → 409；ORDER_CANCELLED_BY_SELLER 0 筆（訂單狀態 SHIPPED）
AUD：別人的訂單（查詢 + 取消）→ 404；ACCESS_DENIED 2 筆；不存在的訂單 → 404；ACCESS_DENIED 0 筆
AUD：金額不符 → 400；PAYMENT_AMOUNT_MISMATCH 1 筆
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.455 s -- in com.example.shop.ordering.internal.AuditPlacementTest
```

`accessDenied` 這個測試在 5.8.3 之後多了一行 `await()`：`ACCESS_DENIED` 改成背景寫入，測試要等它出現。

**`@Transactional` 的測試收不回 REQUIRES_NEW。** `CatalogCartApiTest` 是第 03 章的 `@Transactional` MockMvc 測試（每個測試結束時 rollback，3.9.1）。它有一個「別人的商品 → 404」的測試，這一章之後會寫一筆 `ACCESS_DENIED` —— 而那筆在測試的交易**之外** commit（背景寫入更是如此），rollback 收不回來。第一次跑完全部測試，`audit_logs` 裡留下了 `ACCESS_DENIED 90002 PRODUCT …`。
修法是 `@AfterTransaction`：在測試交易結束**之後**執行的清理（寫在 `@AfterEach` 裡的 `DELETE` 會在測試交易裡執行，然後跟著一起被 rollback）：

```java
/**
 * ACCESS_DENIED 是 REQUIRES_NEW（5.9）：它在測試的交易「之外」commit，@Transactional 的 rollback 收不回來。
 * @AfterTransaction 在測試交易結束之後執行 —— 寫在 @AfterEach 裡的 DELETE 會跟著測試交易一起被 rollback 掉
 */
@AfterTransaction
void removeCommittedAudits() throws InterruptedException {
    Thread.sleep(300);                                                  // ACCESS_DENIED 在背景寫（5.8.3），等它落地再刪
    jdbc.update("DELETE FROM audit_logs WHERE actor_id IN (?, ?, ?)", SELLER, OTHER_SELLER, BUYER);
}
```

這是 4.9.1 那段「會真的下單的測試不能用 `@Transactional` 的 MockMvc」（冪等鍵的 claim 是 REQUIRES_NEW）的同一件事，換了一張表。

> ⚠️ **測試在刪稽核。** 這一章的每一個測試結束時都會 `DELETE FROM audit_logs ...` 清掉自己留下的列。但稽核的本質是「不能被改、不能被刪」—— 跟 INV-5 的 `inventory_ledger` 一樣（0.4.6）。
> 第 09 章會讓應用程式的資料庫帳號**沒有** `audit_logs` 的 `UPDATE` / `DELETE` 權限。到那時，這些測試的清理要換一個帳號，或者整個換成第 08 章的用完即丟的資料庫。這條線先記在這裡。

### 5.9.4 管理員查詢：`GET /api/admin/audit-logs`

US-AUD-1 AC-3：管理員可以依使用者、動作、時間區間篩選。

```java
@GetMapping("/api/admin/audit-logs")
PageResponse<AuditView> search(CurrentUser user,
                               @RequestParam(required = false) Long actorId,
                               @RequestParam(required = false) AuditAction action,
                               @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
                               @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
                               @RequestParam(defaultValue = "0") @Min(value = 0, message = "page 不可為負") int page,
                               @RequestParam(defaultValue = "50") @Min(value = 1, message = "size 1～200") @Max(value = 200, message = "size 1～200") int size) {
    user.require(Role.ADMIN);
    if (!from.isBefore(to) || Duration.between(from, to).compareTo(MAX_RANGE) > 0)
        throw new ShopException(ProblemType.VALIDATION, "時間區間必須是 from < to，且不超過 31 天");
    return query.search(actorId, action, from, to, page, size);
}
```

`from`、`to` 必填，區間最多 31 天：`audit_logs` 只會長大，一個沒有時間條件的查詢遲早會掃整張表。兩個索引在第 02 章就建好了：`idx_audit_actor (actor_id, created_at)` 對應「這個人做了什麼」，`idx_audit_action (action, created_at)` 對應「這段時間有哪些越權」。

`AuthApiTest.auditQuery` 用一次重放產生一筆 `REFRESH_TOKEN_REUSED`，再用 `actorId` + `action` + 時間區間查回來：`totalElements = 1`，`ip` 以 `192.0.2.` 開頭（那個測試給每個請求的 `remoteAddr`）。最後它把整張 `audit_logs` 的 `action | target_id | detail` 串成一個字串，確認裡面**沒有**這個測試用過的密碼、refresh token、access token —— AC-2 的整體檢查。

5.11 的冒煙測試結尾，管理員查「這段期間的稽核」：

```
--- 管理員查這段期間的稽核
   PAYMENT_SIGNATURE_INVALID None PAYMENT_PROVIDER PAYMENT 99070140 0:0:0:0:0:0:0:1
   ACCESS_DENIED 1002 BUYER ORDER 20261001-139463 0:0:0:0:0:0:0:1
```

一筆是冒煙腳本故意送錯簽章的回呼，一筆是買家 1002 讀了買家 1001 的訂單。

---

## 5.10 管理員：看得多、改得少

0.3.2 的角色表說管理員「**不能**以買家身分下單、**不能**改訂單狀態」—— 「管理員什麼都能做」是最常見的權限設計錯誤。這一章的管理員只做三件事：授予 `SELLER`、停權、查稽核。

**授予角色**（US-ACC-3 AC-1、AC-2）：

```java
/** US-ACC-3 AC-1：授予 SELLER。稽核跟授權在同一個交易（AUD-1 AC-1） */
@Transactional
public Me grant(long adminId, long userId, Role role) {
    if (role != Role.SELLER)
        throw new ShopException(ProblemType.VALIDATION, "只能授予 SELLER（ADMIN 由部署時的環境變數建立，0.3.2：管理員看得多、改得少）");
    if (!accounts.exists(userId)) throw ShopException.notFound("帳號");
    if (accounts.grant(userId, role, adminId))
        audit.record(AuditEntry.of(AuditAction.ROLE_GRANTED, adminId, Role.ADMIN.name(), "USER", userId, Map.of("role", role.name())));
    return me(userId);
}
```

**只能授予 `SELLER`。** 一個管理員可以把別人升級成管理員，等於一個被盜的管理員帳號可以製造更多管理員帳號 —— 而且每一個都會在稽核裡顯示「由合法的管理員授予」。ADMIN 只能由部署時的環境變數建立（下面的 `BootstrapAdmin`），那需要的是部署權限，不是一個登入的 session。

**重複授予不寫稽核**：`accounts.grant()` 回傳「這次是不是真的新增了」。它的實作是一句普通的 `INSERT`、接住 `DuplicateKeyException`，而不是更簡潔的 `INSERT ... ON DUPLICATE KEY UPDATE` —— 因為後者在 Connector/J 的預設設定下**沒辦法**告訴你有沒有新增：

```
═══ 5.10 INSERT ... ON DUPLICATE KEY UPDATE 回報的列數 ═══
  Connector/J 預設           第一次（新增）→ 1 │ 第二次（已經有了，什麼都沒改）→ 1
  useAffectedRows=true     第一次（新增）→ 1 │ 第二次（已經有了，什麼都沒改）→ 0
```

（F8 的第二部分。）Connector/J 預設 `useAffectedRows=false`，回報的是「**找到**的列數」，不是「**改變**的列數」。第二次什麼都沒改，一樣回報 1。這個專題的連線字串沒有 `useAffectedRows=true`（0.10.4），而全站其他的條件式 UPDATE 都依賴「影響列數」的語意。一般的 `UPDATE` 其實**也**受這個參數影響：預設回報的是「符合 WHERE 的列數」，不是「真的改變的列數」。條件式 UPDATE 之所以沒出事，是因為它把「已經是目標值」的列排除在 WHERE 外（例如 `SET status = 'SUSPENDED' WHERE status = 'ACTIVE'`、`SET used_at = ? WHERE used_at IS NULL`）—— 符合條件的列一定會被改變，兩種計數相同。這是 0.5.5 那條硬規則的另一個隱含前提：**WHERE 要排除「改了也不變」的列**。4.6.3 的退款用的是 `ON DUPLICATE KEY UPDATE`，但它不看回傳值。

**停權**：

```java
/** 停權：狀態改掉、refresh token 全部撤銷（AC-6：refresh 立即失敗；已經發出去的 access token 最多再活 15 分鐘） */
@Transactional
public Me suspend(long adminId, long userId) {
    if (adminId == userId) throw new ShopException(ProblemType.VALIDATION, "不能停權自己");
    if (!accounts.exists(userId)) throw ShopException.notFound("帳號");
    if (accounts.suspend(userId)) {
        int revoked = refreshTokens.revokeAll(userId);
        audit.record(AuditEntry.of(AuditAction.USER_SUSPENDED, adminId, Role.ADMIN.name(), "USER", userId,
                Map.of("revokedSessions", revoked)));
    }
    return me(userId);
}
```

三件事在同一個交易裡：`users.status = 'SUSPENDED'`（條件式：`WHERE status = 'ACTIVE'`）、撤銷全部 refresh token、寫稽核。5.7.3 的 AC-6 就是從這裡來的：refresh 立即失敗，因為 token 都被撤銷了；access token 不受影響，因為它不查資料庫。
（`revokedSessions` 就是 5.9.2 那個被改過名字的鍵。）

**第一個管理員：`BootstrapAdmin`**（US-ACC-3 AC-3：「管理員帳號由環境變數建立，不存在任何預設帳密」）

```java
/**
 * 5.10 US-ACC-3 AC-3：第一個管理員由環境變數建立，程式碼裡沒有任何預設帳密。
 * 資料庫裡已經有管理員 → 什麼都不做（環境變數之後可以拿掉）；一個都沒有、又沒給環境變數 → 啟動失敗（1.7.4：缺設定就起不來）。
 */
@Component
class BootstrapAdmin implements ApplicationRunner {

    @Override
    public void run(ApplicationArguments args) {
        if (!config.enabled() || accounts.adminCount() > 0) return;
        String email = Email.normalize(config.email()), password = config.password() == null ? "" : config.password();
        if (email.isEmpty() || password.isEmpty())
            throw new IllegalStateException("資料庫裡沒有任何管理員，而且沒有設定 SHOP_BOOTSTRAP_ADMIN_EMAIL / SHOP_BOOTSTRAP_ADMIN_PASSWORD（US-ACC-3 AC-3）");
        if (!email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+"))                          // 5.10：參數傳錯時，email 曾經變成「--shop.security...」
            throw new IllegalStateException("SHOP_BOOTSTRAP_ADMIN_EMAIL 不是一個 email：" + Email.mask(email));
        int bytes = password.getBytes(StandardCharsets.UTF_8).length;
        if (password.length() < 12 || bytes > 72)
            throw new IllegalStateException("SHOP_BOOTSTRAP_ADMIN_PASSWORD 至少 12 個字元、最多 72 bytes");
        long id = tx.execute(s -> accounts.insert(email, encoder.encode(password), "管理員", Role.ADMIN, null));
        log.warn("BOOTSTRAP_ADMIN_CREATED id={} email={}（請把 SHOP_BOOTSTRAP_ADMIN_PASSWORD 從部署設定中移除）", id, Email.mask(email));
    }
}
```

`application-prod.yml`：

```yaml
shop:
  security:
    jwt-secret: ${SHOP_JWT_SECRET}
    bootstrap-admin:               # 第一次部署時提供；之後可以拿掉（已經有管理員就不會再讀）
      email: ${SHOP_BOOTSTRAP_ADMIN_EMAIL:}
      password: ${SHOP_BOOTSTRAP_ADMIN_PASSWORD:}
```

這兩個環境變數**有空的預設值**（`:` 後面什麼都沒有），跟 1.7.4 的「沒有預設值，少一個就起不來」不一樣。理由是它們只在第一次部署時需要：之後資料庫裡已經有管理員，`BootstrapAdmin` 什麼都不做，這時候還要求部署設定裡留著一個管理員密碼，反而是在鼓勵把密碼一直放在那裡。
「起不來」的檢查移到了 `BootstrapAdmin` 裡：**一個管理員都沒有、又沒給** → 啟動失敗。

用一個空的資料庫 `shop_boot` 試四種情況（`boot-test.sh`，每一次都重建資料庫；完整內容在 5.12.1）。它的前提：先 `mvn package -DskipTests` 打好 jar；在 `shop/` 的**上一層**目錄執行（例如 `./shop/boot-test.sh`：腳本用 `shop/target/shop-0.0.1-SNAPSHOT.jar` 這個路徑，日誌寫到目前目錄的 `boot.log`）；MySQL 容器叫 `shop-mysql-1`、root 密碼是 `root`（`compose.yaml`）；每一格用 18085 port 啟動一次，最多等 60 秒：

```
### 沒有給（email、password 都是空的）
  com.example.shop.ShopApplication         : Started ShopApplication in 5.595 seconds (process running for 5.855)
  IllegalStateException: 資料庫裡沒有任何管理員，而且沒有設定 SHOP_BOOTSTRAP_ADMIN_EMAIL / SHOP_BOOTSTRAP_ADMIN_PASSWORD（US-ACC-3 AC-3）
### email 不是 email
  com.example.shop.ShopApplication         : Started ShopApplication in 5.295 seconds (process running for 5.564)
  IllegalStateException: SHOP_BOOTSTRAP_ADMIN_EMAIL 不是一個 email：***
### 密碼太短
  com.example.shop.ShopApplication         : Started ShopApplication in 5.514 seconds (process running for 5.781)
  IllegalStateException: SHOP_BOOTSTRAP_ADMIN_PASSWORD 至少 12 個字元、最多 72 bytes
### 正確
  com.example.shop.ShopApplication         : Started ShopApplication in 5.571 seconds (process running for 5.857)
  c.e.s.account.internal.BootstrapAdmin    : BOOTSTRAP_ADMIN_CREATED id=1 email=o***@example.com（請把 SHOP_BOOTSTRAP_ADMIN_PASSWORD 從部署設定中移除）
  users: 1 ops-admin@example.com ADMIN
```

**「email 不是 email」那一格是一個真的意外留下來的。** 第一次跑這個實驗時，我在 zsh 裡用一個沒有加引號的變數傳參數：`EXTRA="--...email= --...password="`，然後 `java -jar ... $EXTRA`。zsh 預設不對變數做字詞分割，兩個參數被當成**一個** —— email 的值變成了 `" --shop.security.bootstrap-admin.password="`，`strip()` 之後是 `--shop.security.bootstrap-admin.password=`。而那時的 `BootstrapAdmin` 沒有檢查 email 的格式，**應用程式啟動成功**，`shop_boot` 裡多了一個 email 是 `--shop.security.bootstrap-admin.password=` 的管理員。
那是 shell 的錯，但它說明了一件事：部署時傳錯參數是會發生的，而這段程式碼只會在「第一次部署」那一刻執行一次 —— 不會有第二次機會發現它。所以補上了格式檢查。

注意每一格的第一行都是 `Started ShopApplication`：`ApplicationRunner` 在 context 啟動**之後**才執行，所以日誌先說「啟動了」，例外才出現。它真的會讓應用程式起不來嗎？另外量一次「沒有給」的情況，同時每 50 ms 打一次 readiness：

```
exit code = 1
   1 readiness 曾經回 503
```

行程以 1 結束；那段期間 readiness 只回過 503，**一次都沒有 200**。Spring Boot 在所有的 runner 都跑完之後，才把 readiness 改成 `ACCEPTING_TRAFFIC` —— 負載平衡器不會在 runner 失敗之前就把流量送進來。

（這個量測沒有放進 repo。重跑方式，一樣在 `shop/` 的上一層目錄：

```bash
docker exec shop-mysql-1 mysql -uroot -proot -e "DROP DATABASE IF EXISTS shop_boot; CREATE DATABASE shop_boot; GRANT ALL ON shop_boot.* TO 'shop'@'%';"
java -jar shop/target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=local --server.port=18085 --shop.order.jobs-enabled=false \
     "--spring.datasource.url=jdbc:mysql://localhost:3306/shop_boot?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC" \
     --shop.security.bootstrap-admin.email= --shop.security.bootstrap-admin.password= > boot.log 2>&1 &
PID=$!
while kill -0 $PID 2>/dev/null; do curl -s -o /dev/null -w '%{http_code}\n' localhost:18085/actuator/health/readiness; sleep 0.05; done | sort | uniq -c
wait $PID; echo "exit code = $?"
```

Tomcat 還沒開始聽 port 的那段時間，`curl` 會印出 `000`。）

專題寫完之後，在第 05 章結束時的程式碼、一個全新的資料庫（灌了 2.8.3 的種子資料）上照這個指令原樣跑了一次（load average 4.5）：

```
  91 000
   1 503
exit code = 1
```

這個指令印的是「每一種回應碼出現幾次」，不是上面那一段的格式：Tomcat 開始聽 port 之前的 91 次是 `000`，之後在行程結束前打到 1 次 503，**一次 200 都沒有**，行程以 1 結束 —— 結論跟上面一樣。

**本機與驗收 Q6**：`application-local.yml` 給了一組本機用的帳密 `admin@example.com` / `local-dev-only-admin-password`（跟 `shop/shop` 的資料庫帳密一樣，只存在你的筆電上；完整內容見 5.12.1）。種子資料的 `shop` 裡已經有 `admin@example.com`，所以它不會被用到；驗收 Q6 從一個空的 `shop_q6` 啟動，它就會被用到 —— 這一章的完整測試裡，Q6 的日誌有一行 `BOOTSTRAP_ADMIN_CREATED id=1 email=a***@example.com`。**這兩行不能省**：Q6 用預設的 `local` profile 從空的 `shop_q6` 啟動，少了它們，`BootstrapAdmin` 會丟 `IllegalStateException`，Q6 就起不來。
`lab` profile（第 00～01 章的實驗，連 `shop_lab`）沒有 Flyway 管理的 `users` 表，所以 `application-lab.yml` 用 `bootstrap-admin.enabled: false` 關掉它。

---

## 5.11 流程測試、冒煙測試與追溯表

### 5.11.1 這一章新增的測試

| 測試 | 幾個 | 守什麼 |
|---|---|---|
| `AuthApiTest` | 12 | ACC-1 AC-1～4、ACC-2 AC-1～6、ACC-3 AC-1、2、AUD-1 AC-2、3、0.6.5 的登入限流 |
| `JwtGuardTest` | 2 | 10 種 token 的結果；預設驗證器的 60 秒（對照組，只印不斷言） |
| `SecurityRouteCoverageTest` | 1 | 32 支 API：匿名可達 = `PUBLIC`；沒有任何一支掉到 `denyAll` |
| `IdorMatrixTest` | 2 | 11 支帶 id 的 API × 別人的身分；帶路徑變數的 API 全部被涵蓋 |
| `AuditPlacementTest` | 5 | 9 種稽核裡會「被拒絕」與「可能失敗」的那幾種，各自剛好幾筆 |
| `JdbcAuditLogTest` | 1 | AC-2：鍵名像秘密的 detail 寫不進去 |
| 驗收 **Q5** | 1 | 從 `@Disabled` 變成綠燈 |

`AuthApiTest` 不用 `@Transactional`（登入、refresh 在自己的交易裡寫 `refresh_tokens`，稽核有 REQUIRES_NEW），而是每個測試結束時清掉 `@auth-test.example.com` 這個網域的所有帳號、token、稽核與 Redis 的鎖定計數。
它的每一個請求都帶不同的 `remoteAddr`（`192.0.2.x`）：`IpLoginLimiter` 是每 IP 每分鐘 20 次，這個測試類別一分鐘內會登入幾十次。只有 `perIpLimit` 那一個測試刻意用同一個 IP。

### 5.11.2 冒煙測試：`smoke5.sh`

第 04 章的 `smoke4.sh` 用 `X-Debug-User-Id` 當身分，這一章之後它跑不動了。`smoke5.sh` 改成從登入開始，種子資料的帳號密碼都是 `password123`（2.8.2）：

```bash
login() { curl -s "${JSON[@]}" -d "{\"email\":\"$1\",\"password\":\"password123\"}" $BASE/api/auth/login | sed -E 's/.*"accessToken":"([^"]+)".*/\1/'; }

BUYER=(-H "Authorization: Bearer $(login buyer00001@example.com)")
OTHER=(-H "Authorization: Bearer $(login buyer00002@example.com)")
SELLER=(-H "Authorization: Bearer $(login seller001@example.com)")
ADMIN=(-H "Authorization: Bearer $(login admin@example.com)")
```

```bash
mvn -o -q package -DskipTests
java -jar target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=local --shop.order.jobs-enabled=false &
./smoke5.sh
```

`smoke5.sh` 的完整內容在 5.12.1。它需要：`curl`、`uuidgen`（冪等鍵）、`openssl`（算回呼的 HMAC）、`python3`（整理稽核查詢的 JSON）、`sed`；腳本裡的 `SECRET` 必須跟 `application-local.yml` 的 `shop.payment.callback-secret` 一樣；下單的是種子資料的商品 1（單價 149）。`-o`（離線）要求依賴已經在本機的 Maven repository 裡 —— 剛加上 Security 的依賴時，先不加 `-o` 跑一次。

> ⚠️ 最後一步查稽核的 `to` 參數用了 `date -u -v+1M`，那是 **macOS（BSD）** 的 `date` 語法。在 Linux（GNU `date`）上要改成 `date -u -d '+1 min' +%Y-%m-%dT%H:%M:%SZ`，否則 `to` 是空的，查詢會失敗。

```
--- 登入（買家 1001、買家 1002、賣家 2、管理員 1）
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzaG9wI…
--- 下單
{"orderNo":"20261001-139463","status":"PENDING_PAYMENT","totalAmount":298.00,"createdAt":"…
--- 別的買家讀這張訂單
{"type":"/problems/not-found","title":"找不到資源","status":404,"detail":"訂單不存在","instance":"/api/orders/20261001-139463"} [404]
--- 別的買家讀不存在的訂單
{"type":"/problems/not-found","title":"找不到資源","status":404,"detail":"訂單不存在","instance":"/api/orders/19990101-000000"} [404]
--- 沒帶 token
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"需要登入","instance":"/api/orders/20261001-139463"} [401]
--- 買家呼叫賣家的 API
{"type":"/problems/forbidden","title":"沒有權限","status":403,"detail":"沒有權限","instance":"/api/seller/orders/20261001-139463/start-picking"} [403]
--- 建立付款
{"paymentId":99070140,"amount":298.00,"payUrl":"https://pay.example.test/simulated/99070140"} [201]
--- 簽章錯誤的回呼
{"type":"/problems/unauthenticated","title":"需要登入","status":401,"detail":"簽章不正確","instance":"/api/payments/callback"} [401]
--- 付款成功的回呼
{"status":"received"} [200]
--- 賣家開始撿貨
status=PICKING [200]
--- 出貨
status=SHIPPED [200]
--- 確認收貨
status=COMPLETED [200]
--- 管理員查這段期間的稽核
   PAYMENT_SIGNATURE_INVALID None PAYMENT_PROVIDER PAYMENT 99070140 0:0:0:0:0:0:0:1
   ACCESS_DENIED 1002 BUYER ORDER 20261001-139463 0:0:0:0:0:0:0:1
```

這一份輸出把這一章的每一層都走了一次：真的登入、401（沒帶 token）、403（角色不對，在 filter 裡擋下，Problem Details 格式）、404（別人的訂單，跟不存在的一模一樣）、業務層的 401（簽章錯）、以及管理員查得到的兩筆稽核。

（第 04 章那份 `smoke4.sh` 裡「同一個鍵再送一次」、「金額被改成 1.00」那幾步，`smoke5.sh` 拿掉了 —— 它們是第 04 章的事，`OrderFlowTest` 與驗收 Q3 一直守著。）

### 5.11.3 追溯表更新

| 需求 | 驗證方式 | 狀態 |
|---|---|---|
| ACC-1 AC-1～4 | `AuthApiTest`（`register`、`duplicateEmail`、`passwordLength`） | ✅ 05 |
| ACC-2 AC-1 | `AuthApiTest.loginIssuesTokens` | ✅ 05 |
| ACC-2 AC-2 | `AuthApiTest.noAccountEnumeration`（計時斷言，差 0.6 ms）；F3 ① | ✅ 05 |
| ACC-2 AC-3 | `AuthApiTest.lockout`；F3 ②③ | ✅ 05 |
| ACC-2 AC-4、AC-5 | `AuthApiTest.rotation`、`reuseDetection`；F4 | ✅ 05 |
| ACC-2 AC-6 | `AuthApiTest.suspend`（refresh 立即 401、access token 仍然 200） | ✅ 05 |
| ACC-3 AC-1、AC-2 | `AuthApiTest.grantSeller` | ✅ 05 |
| ACC-3 AC-3 | `boot-test.sh`（4 種情況）；驗收 Q6 的 `BOOTSTRAP_ADMIN_CREATED` | ✅ 05（手動腳本，自動化在 08） |
| ORD-2 AC-3 | 401 ✅ 04；`AuditPlacementTest.badSignature` | ✅ 05 |
| ORD-2 AC-4 | 400 ✅ 04；`AuditPlacementTest.amountMismatch`；告警在 09 | 部分 |
| ORD-5 AC-3 | 驗收 **Q5**；`IdorMatrixTest`（11 支）；`AuditPlacementTest.accessDenied` | ✅ 05 |
| ORD-5 AC-4 | 偵測的 SQL（5.8.4，時間窗改成一小時）；告警在 09 | ⏳ 09 |
| ORD-6 AC-5 | 取消與退款 ✅ 04；稽核 `AuditPlacementTest.sellerCancel*`；通知在 07 | 部分 |
| AUD-1 AC-1 | `AuditPlacementTest`（成功、失敗、被拒絕三種） | ✅ 05 |
| AUD-1 AC-2 | `JdbcAuditLogTest`；`AuthApiTest.auditQuery` 的整表檢查 | ✅ 05 |
| AUD-1 AC-3 | `AuthApiTest.auditQuery` | ✅ 05 |
| AUD-1「強制下架」 | —— | 練習六 |
| 0.6.3 登入 × Redis | F7（`stop` 與 `pause`）；計數器 `shop.login.lockout.degraded`，告警在 09 | 部分 |
| 0.6.5 Token、越權、密碼 | `JwtGuardTest`、`IdorMatrixTest`、`Utf8Bytes` + `AuthApiTest.passwordLength` | ✅ 05 |
| 0.6.5 限流：登入每 IP 每分鐘 20 次 | `AuthApiTest.perIpLimit`（單機）；全站的版本在 06 | 部分 |
| 0.8 路徑前綴 → 角色 | `SecurityRouteCoverageTest`（32 支） | ✅ 05 |
| 0.10.6 readiness 不需要登入 | F1 的 C 階段；`SecurityConfig` 的 `permitAll` | ✅ 05 |

**這一章讓 0.13.1 答應的「ACC、AUD、ORD-5 AC-3、Q5」全部有了對應的測試。** 沒有打勾的每一格都指向一個具體的章節：告警在 09、通知在 07、全站限流在 06，強制下架是練習。

---

## 5.12 本章完成後的專案

```
shop/
├── pom.xml                                                    ← + security、oauth2-resource-server、spring-security-test
├── smoke5.sh、boot-test.sh                                    ← 5.11.2、5.10
└── src/
    ├── main/
    │   ├── java/com/example/shop/
    │   │   ├── account/internal/                              ← 新增（這一章之前 account 模組只有 account/package-info.java）
    │   │   │   ├── AccountService.java、LoginService.java     ← 註冊、授權、停權；登入、refresh
    │   │   │   ├── Accounts.java、RefreshTokens.java          ← users、user_roles、refresh_tokens 的 SQL
    │   │   │   ├── LoginAttempts.java、IpLoginLimiter.java    ← 鎖定（Redis + 退避）、IP 限流（單機）
    │   │   │   ├── Email.java、Utf8Bytes.java、AuthDtos.java、Account.java、PasswordConfig.java
    │   │   │   ├── BootstrapAdmin.java                        ← 第一個管理員
    │   │   │   └── web/{AuthController,AccountController}.java
    │   │   ├── catalog/internal/ProductService.java           ← + 改價稽核、owned() 的 ACCESS_DENIED
    │   │   ├── ordering/internal/
    │   │   │   ├── OrderAccess.java                           ← 新增：資料層級權限（5.8.1）
    │   │   │   ├── OrderCommands.java、OrderQueryService.java ← 走 OrderAccess；賣家取消的稽核
    │   │   │   └── OrderRepository.java                       ← + existsByOrderNo
    │   │   ├── payment/internal/JdbcPaymentService.java       ← + 簽章錯誤、金額不符的稽核
    │   │   └── shared/
    │   │       ├── audit/{AuditLog,AuditEntry,AuditAction}.java           ← 新增
    │   │       ├── audit/internal/{JdbcAuditLog,AuditQuery}.java、web/AuditLogController.java
    │   │       ├── security/{AccessTokens,SecurityConfig}.java            ← 新增
    │   │       ├── web/CurrentUserResolver.java               ← 改寫：從 JWT 產生；X-Debug-* 刪除
    │   │       ├── web/ProblemWriter.java                     ← 新增：filter 裡的 Problem Details
    │   │       ├── web/OpenApiConfig.java                     ← + bearer 的 securityScheme
    │   │       ├── error/ProblemType.java                     ← + EMAIL_UNAVAILABLE
    │   │       └── config/ShopProperties.java                 ← Security 長出 TTL、Login、BootstrapAdmin；debugHeaders 刪除
    │   └── resources/
    │       ├── application-local.yml                          ← - debug-headers、+ bootstrap-admin（本機）
    │       └── application-prod.yml                           ← + SHOP_BOOTSTRAP_ADMIN_*
    └── test/
        ├── java/com/example/
        │   ├── lab/ch03/LabShopApp.java                       ← 排除 Security 的自動設定（迷你應用程式沒有登入）
        │   ├── lab/ch05/{TutorialSecurityConfig,TutorialSecurityConfigWithErrorPage,Lab403OrderController}.java
        │   └── shop/
        │       ├── support/TestTokens.java                    ← 新增：測試的身分
        │       ├── acceptance/CapstoneAcceptanceTest          ← Q5 變綠；Q1～Q4 改用 TestTokens
        │       ├── api/{AuthApiTest,JwtGuardTest,SecurityRouteCoverageTest,IdorMatrixTest}.java   ← 新增
        │       ├── api/{CatalogCartApiTest,OrderApiTest}.java ← 改用 TestTokens；CatalogCartApiTest 多一個 @AfterTransaction 清稽核
        │       ├── account/internal/{F3LoginAttacksTest,F4ConcurrentRefreshTest,F7RedisDownLoginTest}.java
        │       ├── ch05/{F1SecurityStarterTest,F2OrderEnumerationTest,F6DeniedTimingTest,F8SmallFactsTest}.java
        │       ├── ordering/internal/AuditPlacementTest.java  ← 新增
        │       ├── ordering/internal/OrderFlowTest.java       ← cleanup 多清 audit_logs
        │       ├── ch03/{D2ErrorMessageLeakTest,D6LatencyTest}.java、ch04/E7FlashSaleLoadTest.java ← 改用 TestTokens
        │       └── shared/audit/internal/JdbcAuditLogTest.java← 新增
        └── resources/
            ├── application-lab.yml                            ← + bootstrap-admin.enabled: false
            └── openapi/shop-api.json                          ← + 7 個 operation、bearer
```

**沒有新的 migration。** `users`、`user_roles`、`refresh_tokens`、`audit_logs` 在第 02 章就建好了（V1、V8），這一章是它們第一次被寫入。第 02 章當時多想的那幾個欄位 —— `refresh_tokens.used_at`、`revoked_at`、`idx_audit_action` —— 這一章全部用上了；`audit_logs.trace_id` 現在寫進去的是 NULL，等第 09 章把 traceId 放進 MDC。

```bash
mvn clean test
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.105 s -- in com.example.shop.shared.audit.internal.JdbcAuditLogTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.024 s -- in com.example.shop.shared.error.ShopExceptionTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.899 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.014 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.454 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.060 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.007 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.002 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.027 s -- in com.example.shop.architecture.ConfigKeyGuardTest
Q3：先後送兩次 → 201 20261001-149258、200 20261001-149258；同鍵不同內容 → 422 /problems/idempotency-key-reused
Q3：同一個鍵同時送 10 次 → {201=1, 409（Retry-After: 1）=9}；出現過的訂單編號 [20261001-100320]；資料庫裡這位買家的訂單 2 張
Q1：HTTP 409 /problems/insufficient-stock，productId=9900102；殘留：{orders=0, items=0, reservations=0, reserved_a=0, ledger_a=1/0, idem_keys=0, cart=2}（庫存帳下單前 1/0）
Q1：補貨後用同一個鍵重送 → HTTP 201 20261001-145098；購物車剩 0 項
Q5：B 讀自己的 → 200；A 讀 B 的 → 404；A 讀不存在的 → 404；兩個 404 的 body 相同 = true；稽核 {actor_id=21077, actor_role=BUYER, target_type=ORDER, target_id=20261001-991607, ip=127.0.0.1}
Q6：從空資料庫套用 11 個 migration → 20 張表（含 flyway_schema_history）、CHECK 25 / 25、具名索引 31 / 31；validate 通過
Q4：size=5   → HTTP 200，5 張訂單、15 個明細，SQL 3 句
Q4：size=20  → HTTP 200，20 張訂單、60 個明細，SQL 3 句
Q4：size=45  → HTTP 200，45 張訂單、135 個明細，SQL 3 句
Q2：{201 =1, 409 /problems/insufficient-stock=99}；available = 0
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 5, Time elapsed: 68.18 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 61, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.029 s -- in com.example.shop.ordering.internal.OrderStateMachineTest
AUD：簽章錯誤 → 401；PAYMENT_SIGNATURE_INVALID 1 筆
AUD：賣家取消 PAID → 成功；ORDER_CANCELLED_BY_SELLER 1 筆
AUD：賣家取消 SHIPPED → 409；ORDER_CANCELLED_BY_SELLER 0 筆（訂單狀態 SHIPPED）
AUD：別人的訂單（查詢 + 取消）→ 404；ACCESS_DENIED 2 筆；不存在的訂單 → 404；ACCESS_DENIED 0 筆
AUD：金額不符 → 400；PAYMENT_AMOUNT_MISMATCH 1 筆
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.001 s -- in com.example.shop.ordering.internal.AuditPlacementTest
ORD-3 AC-3：取消 60 張、歷史 60 筆、RELEASE 60 筆；INV-2 {reserved=0, held=0}
ORD-3 AC-5：{CANCELLED/RELEASED/SUCCEEDED/1=50}；例外 0；INV-2 {reserved=0, held=0}
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.482 s -- in com.example.shop.ordering.internal.OrderRaceRegressionTest
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.692 s -- in com.example.shop.ordering.internal.OrderFlowTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.730 s -- in com.example.shop.api.OrderApiTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.543 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.357 s -- in com.example.shop.api.IdorMatrixTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.041 s -- in com.example.shop.api.JwtGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.135 s -- in com.example.shop.api.SecurityRouteCoverageTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.324 s -- in com.example.shop.api.OpenApiContractTest
ACC-2 AC-2：密碼錯誤 p50 75.6 ms、帳號不存在 p50 74.9 ms、差 0.6 ms
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 7.082 s -- in com.example.shop.api.AuthApiTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.985 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.107 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 143, Failures: 0, Errors: 0, Skipped: 5
[INFO] BUILD SUCCESS
[INFO] Total time:  01:37 min
```

> 📌 **專題寫完之後重跑：`mvn clean verify`。** 上面是寫這一章時跑的 `mvn clean test`。專題寫完之後（2026-10-12），在本章結束時的程式碼上、用一套全新的 compose（空的資料庫，Flyway 從第一個 migration 開始）重跑了一次 `mvn clean verify`（load average 6.16 → 8.68）：（上面那段輸出，在參考實作的分支整理之後沒有在同一個版本上重跑過：測試數是照程式碼推算的。這一次是實跑。）

```bash
mvn clean verify
```

```
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.105 s -- in com.example.shop.shared.audit.internal.JdbcAuditLogTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.022 s -- in com.example.shop.shared.error.ShopExceptionTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.495 s -- in com.example.shop.schema.SchemaConstraintTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.014 s -- in com.example.shop.schema.EntitySchemaDriftTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.012 s -- in com.example.shop.schema.InvariantReconciliationTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.105 s -- in com.example.shop.architecture.TableOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.008 s -- in com.example.shop.architecture.MigrationOwnershipTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.001 s -- in com.example.shop.architecture.MapperXmlSafetyTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.039 s -- in com.example.shop.architecture.ConfigKeyGuardTest
[WARNING] Tests run: 11, Failures: 0, Errors: 0, Skipped: 5, Time elapsed: 68.09 s -- in com.example.shop.acceptance.CapstoneAcceptanceTest
[INFO] Tests run: 61, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.036 s -- in com.example.shop.ordering.internal.OrderStateMachineTest
[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.048 s -- in com.example.shop.ordering.internal.AuditPlacementTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.251 s -- in com.example.shop.ordering.internal.OrderRaceRegressionTest
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.566 s -- in com.example.shop.ordering.internal.OrderFlowTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.818 s -- in com.example.shop.api.OrderApiTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.540 s -- in com.example.shop.api.CatalogCartApiTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.492 s -- in com.example.shop.api.IdorMatrixTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.027 s -- in com.example.shop.api.JwtGuardTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.115 s -- in com.example.shop.api.SecurityRouteCoverageTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.312 s -- in com.example.shop.api.OpenApiContractTest
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 6.018 s -- in com.example.shop.api.AuthApiTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.907 s -- in com.example.shop.architecture.EntityTableOwnershipTest
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.107 s -- in com.example.shop.architecture.ModuleBoundaryTest
[WARNING] Tests run: 143, Failures: 0, Errors: 0, Skipped: 5
[INFO] ...
[INFO] Building jar: …/target/shop-0.0.1-SNAPSHOT.jar
[INFO] ...
[INFO] BUILD SUCCESS
[INFO] ...
[INFO] Total time:  01:35 min
```

143 個測試、跳過 5 個 —— 跟上面一樣。`verify` 比 `test` 多做的是打包 jar（`spring-boot:repackage`）；覆蓋率門檻要到第 08 章才有。

**143 個測試、`Skipped: 5`**（第 04 章是 120 個、6 個 skipped）。新增的 23 個：`AuthApiTest` 12、`AuditPlacementTest` 5、`IdorMatrixTest` 2、`JwtGuardTest` 2、`SecurityRouteCoverageTest` 1、`JdbcAuditLogTest` 1。Q5 本來就算在那 120 個裡（skipped），變成通過不影響總數，只讓 `Skipped` 少 1。

驗收測試 68 秒（第 04 章是 56 秒）：Q5 又啟動了一個完整的應用程式。第 08 章會處理這件事。

`ModuleBoundaryTest` 的 6 條規則、`TableOwnershipTest`、`EntityTableOwnershipTest`、`ConfigKeyGuardTest` 全綠 —— 依賴表沒有改（5.3.2），`application-*.yml` 裡新的設定鍵（`bootstrap-admin.*`）都在 `ShopProperties` 裡有對應。`InvariantReconciliationTest` 仍然是 0：這一章的測試與實驗沒有碰庫存。

### 5.12.1 本章其餘檔案的完整內容

正文為了閱讀，很多程式碼區塊只摘了一段。下面是正文**沒有完整給出**的每一個檔案，內容就是參考實作 `ch05` 分支上的版本。

已經在正文完整出現的，這裡不再重複：`CurrentUserResolver`、`TestTokens`（5.5.6）、`Utf8Bytes`（5.4.2）、`Email`（5.6.3）、`AuditLog`（5.9.1）、`application-prod.yml` 的那一段（5.10）。`AccessTokens`、`SecurityConfig`（5.5）、`ProblemWriter`（5.5.3）在正文只省略了 import；其中比較不容易猜到的是 `com.nimbusds.jose.jwk.source.ImmutableSecret`、`org.springframework.security.oauth2.jose.jws.MacAlgorithm`、`org.springframework.security.oauth2.server.resource.InvalidBearerTokenException`、`org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter` 與同一個套件的 `JwtGrantedAuthoritiesConverter`。
只改一兩行的也不重複：`pom.xml`（5.5.1 的三個依賴）、`ProblemType`（5.4.1 的 `EMAIL_UNAVAILABLE`）、`OrderRepository`（多一行 `boolean existsByOrderNo(String orderNo);`）、`CurrentUser`（只改註解），以及 5.5.6 遷移清單裡的那幾個舊測試。
`src/test/resources/openapi/shop-api.json` 不用手寫：用 5.3.1 的指令重新產生。

#### 設定

**`src/main/resources/application-local.yml`**

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
    username: shop
    password: shop
  data:
    redis:
      host: localhost
      port: 6379
  rabbitmq:
    host: localhost
    port: 5672
    username: shop
    password: shop

shop:
  payment:
    callback-secret: local-dev-only-payment-callback-secret-0123
  security:
    jwt-secret: local-dev-only-secret-0123456789abcdef
    bootstrap-admin:               # 只在「一個管理員都沒有」時使用（空的資料庫，例如驗收 Q6 的 shop_q6）
      email: admin@example.com
      password: local-dev-only-admin-password

management:
  endpoint:
    health:
      show-details: always
```

**`src/test/resources/application-lab.yml`**

```yaml
# 第 00～01 章的實驗用：它們會自己建、自己刪表（@Sql("/ch01-schema.sql")），
# 所以連到 shop_lab，而且不跑 Flyway、不驗證 schema —— 絕對不能碰 Flyway 管理的 shop。
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&rewriteBatchedStatements=true
  flyway:
    enabled: false
  jpa:
    hibernate:
      ddl-auto: none
shop:
  security:
    bootstrap-admin:
      enabled: false               # shop_lab 不是 Flyway 管理的，沒有 users 表（第 05 章）
```

**`src/main/java/com/example/shop/shared/config/ShopProperties.java`**

```java
package com.example.shop.shared.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.hibernate.validator.constraints.time.DurationMax;
import org.hibernate.validator.constraints.time.DurationMin;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

@Validated
@ConfigurationProperties(prefix = "shop", ignoreUnknownFields = false)
public record ShopProperties(@Valid @NotNull Order order, @Valid @NotNull Security security, @Valid @NotNull Payment payment) {

    /** US-ORD-3：付款期限 */
    public record Order(
            @NotNull @DurationMin(minutes = 1, message = "付款期限至少 1 分鐘")
            @DurationMax(minutes = 60, message = "付款期限不可超過 60 分鐘（US-ORD-3）") Duration paymentTimeout,
            @NotNull @DurationMin(seconds = 10, message = "逾時掃描間隔至少 10 秒") Duration timeoutScanInterval,
            /** 逾時取消與自動完成的排程（4.7）。實驗需要可重現的資料時關掉它 */
            @DefaultValue("true") boolean jobsEnabled) {}

    /** US-ORD-2 AC-3：金流回呼的 HMAC-SHA256 金鑰 */
    public record Payment(
            @NotBlank @Size(min = 32, message = "金流回呼金鑰至少 32 bytes") String callbackSecret) {}

    /** 0.6.5、US-ACC-2、US-ACC-3（第 05 章） */
    public record Security(
            /** HS256 的金鑰至少 256 bits（0.6.5）。@Size 數的是字元；UTF-8 下 32 個字元至少 32 bytes */
            @NotBlank @Size(min = 32, message = "JWT 金鑰至少 32 bytes（256 bits，0.6.5）") String jwtSecret,
            /** US-ACC-2 AC-1：access token 15 分鐘。它也是 AC-6「停權最遲多久生效」的上限 */
            @NotNull @DefaultValue("15m") @DurationMin(minutes = 1) @DurationMax(minutes = 60, message = "access token 不可超過 60 分鐘（AC-6 的停權空窗）")
            Duration accessTokenTtl,
            /** US-ACC-2 AC-1：refresh token 7 天 */
            @NotNull @DefaultValue("7d") @DurationMin(hours = 1) @DurationMax(days = 30) Duration refreshTokenTtl,
            @Valid @NotNull @DefaultValue Login login,
            @Valid @NotNull @DefaultValue BootstrapAdmin bootstrapAdmin) {}

    /** US-ACC-2 AC-3：15 分鐘內連續失敗 5 次 → 鎖定；0.6.5：每 IP 每分鐘 20 次 */
    public record Login(
            @DefaultValue("5") @Min(1) int maxFailures,
            @NotNull @DefaultValue("15m") @DurationMin(minutes = 1) Duration lockWindow,
            @DefaultValue("20") @Min(1) int perIpPerMinute) {}

    /**
     * US-ACC-3 AC-3：資料庫裡一個管理員都沒有時，用這組帳密建立第一個。沒有預設值 —— 正式環境由環境變數提供。
     * enabled=false 只給 lab profile 用（shop_lab 沒有 Flyway 管理的 users 表）
     */
    public record BootstrapAdmin(@DefaultValue("true") boolean enabled, String email, String password) {}
}
```

#### shared：OpenAPI 與稽核

**`src/main/java/com/example/shop/shared/web/OpenApiConfig.java`**

```java
package com.example.shop.shared.web;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.info.Info;
import org.springdoc.core.utils.SpringDocUtils;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 3.8 OpenAPI 文件由程式碼產生（0.6.8） */
@Configuration(proxyBeanMethods = false)
class OpenApiConfig {

    static {
        // CurrentUser 由 CurrentUserResolver 從 JWT 產生，不是 query 參數 —— 不要讓它出現在文件裡。
        // （只對「CurrentUser」這個型別有效；Optional<CurrentUser> 要在參數上加 @Parameter(hidden = true)）
        SpringDocUtils.getConfig().addRequestWrapperToIgnore(CurrentUser.class);
    }

    /** 5.5：需要身分的 API 帶 Authorization: Bearer <accessToken>。公開的那幾支（SecurityConfig 的 permitAll）帶了也不影響 */
    @Bean
    OpenAPI shopOpenApi() {
        return new OpenAPI().info(new Info().title("Shop API").version("v1")
                        .description("期末專題：小型電商訂單系統。錯誤回應一律是 Problem Details（type 見 ProblemType）。"))
                .components(new Components().addSecuritySchemes("bearer",
                        new SecurityScheme().type(SecurityScheme.Type.HTTP).scheme("bearer").bearerFormat("JWT")))
                .addSecurityItem(new SecurityRequirement().addList("bearer"));
    }
}
```

**`src/main/java/com/example/shop/shared/audit/AuditAction.java`**

```java
package com.example.shop.shared.audit;

/** US-AUD-1 必須寫入稽核的動作（0.4.9）。新增一種 = 在這裡加一個值 */
public enum AuditAction {
    // ── 業務動作的一部分：跟業務交易一起 commit、一起 rollback ──
    ROLE_GRANTED,                 // US-ACC-3 AC-1
    USER_SUSPENDED,               // US-ACC-3、US-ACC-2 AC-6
    PRODUCT_PRICE_CHANGED,        // 賣家改價（含舊價與新價）
    ORDER_CANCELLED_BY_SELLER,    // US-ORD-6 AC-5
    REFRESH_TOKEN_REUSED,         // US-ACC-2 AC-5：撤銷全部 refresh token 的那個交易

    // ── 被拒絕的動作：沒有會 commit 的業務交易，獨立寫入 ──
    ACCESS_DENIED,                // US-ORD-5 AC-3
    PAYMENT_SIGNATURE_INVALID,    // US-ORD-2 AC-3
    PAYMENT_AMOUNT_MISMATCH,      // US-ORD-2 AC-4
    LOGIN_LOCKED                  // US-ACC-2 AC-3
}
```

**`src/main/java/com/example/shop/shared/audit/AuditEntry.java`**

```java
package com.example.shop.shared.audit;

import java.util.Map;

/**
 * 一筆稽核：誰（actor）、做了什麼（action）、對象（target）、細節（detail）。
 * 「何時、來源 IP、traceId」由 AuditLog 自己填 —— 呼叫端不需要、也不應該自己傳（避免每個呼叫點各填各的）。
 */
public record AuditEntry(Long actorId, String actorRole, AuditAction action, String targetType, String targetId,
                         Map<String, ?> detail) {

    public static AuditEntry of(AuditAction action, Long actorId, String actorRole, String targetType, Object targetId,
                                Map<String, ?> detail) {
        return new AuditEntry(actorId, actorRole, action, targetType, targetId == null ? null : targetId.toString(), detail);
    }
}
```

**`src/main/java/com/example/shop/shared/audit/internal/JdbcAuditLog.java`**

```java
package com.example.shop.shared.audit.internal;

import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.Map;
import java.util.regex.Pattern;

@Component
class JdbcAuditLog implements AuditLog, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(JdbcAuditLog.class);

    /** AC-2：稽核內容不含密碼、token、卡號。擋在「鍵名」上：值是什麼，這一層無從判斷 */
    static final Pattern SECRET_KEY = Pattern.compile("password|passwd|token|secret|authorization|signature|card");

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final Counter dropped;
    /** 一條執行緒、一萬筆的佇列。滿了就丟（不要讓攻擊者用 ACCESS_DENIED 把記憶體或連線池塞爆） */
    private final ThreadPoolExecutor background = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(10_000),
            r -> { Thread t = new Thread(r, "audit-writer"); t.setDaemon(true); return t; });

    JdbcAuditLog(JdbcTemplate jdbc, ObjectMapper json, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.json = json;
        this.dropped = Counter.builder("shop.audit.dropped").description("沒有寫進 audit_logs 的稽核（佇列滿了或寫入失敗）").register(meters);
        background.setRejectedExecutionHandler((r, ex) -> dropped.increment());
    }

    /** 一列要寫的值。ip 與 traceId 在「呼叫端的執行緒」上取：換到背景執行緒之後，RequestContextHolder 與 MDC 都是空的 */
    record Row(Object[] args) {}

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void record(AuditEntry e) { insert(row(e)); }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordRejection(AuditEntry e) { insert(row(e)); }

    @Override
    public void recordRejectionLater(AuditEntry e) {
        Row row = row(e);
        background.execute(() -> {
            try {
                insert(row);                                               // 沒有交易：一句 INSERT，autocommit
            } catch (RuntimeException ex) {
                dropped.increment();
                log.error("AUDIT_DROPPED action={} target={}", e.action(), e.targetId(), ex);
            }
        });
    }

    /** 關機時把佇列裡的寫完（最多等 5 秒） */
    @Override
    public void destroy() throws InterruptedException {
        background.shutdown();
        if (!background.awaitTermination(5, TimeUnit.SECONDS)) log.warn("AUDIT_DROPPED 關機時還有 {} 筆沒寫", background.getQueue().size());
    }

    private Row row(AuditEntry e) {
        return new Row(new Object[]{e.actorId(), e.actorRole(), e.action().name(), e.targetType(), e.targetId(), detail(e.detail()),
                clientIp(), MDC.get("traceId")});                          // traceId：第 09 章才會有人放進 MDC，在那之前是 NULL
    }

    private void insert(Row row) {
        jdbc.update("""
                INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, detail, ip, trace_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", row.args());
    }

    String detail(Map<String, ?> detail) {
        if (detail == null || detail.isEmpty()) return null;
        for (String k : detail.keySet())
            if (SECRET_KEY.matcher(k.toLowerCase(Locale.ROOT)).find())
                throw new IllegalArgumentException("稽核的 detail 不可以有「" + k + "」這種欄位（US-AUD-1 AC-2）");
        try {
            return json.writeValueAsString(detail);
        } catch (JsonProcessingException ex) {
            throw new IllegalArgumentException("稽核的 detail 無法轉成 JSON", ex);
        }
    }

    /** 排程、訊息消費者這些「不在 HTTP 請求裡」的動作，IP 是 NULL */
    static String clientIp() {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes a) {
            HttpServletRequest req = a.getRequest();
            return req.getRemoteAddr();
        }
        return null;
    }
}
```

**`src/main/java/com/example/shop/shared/audit/internal/AuditQuery.java`**

```java
package com.example.shop.shared.audit.internal;

import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.web.PageResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** US-AUD-1 AC-3：管理員依使用者、動作、時間區間查詢。兩個索引對應前兩種篩選：idx_audit_actor、idx_audit_action */
@Component
public class AuditQuery {

    public record AuditView(long id, Long actorId, String actorRole, String action, String targetType, String targetId,
                            JsonNode detail, String ip, String traceId, Instant createdAt) {}

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    AuditQuery(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Transactional(readOnly = true)
    public PageResponse<AuditView> search(Long actorId, AuditAction action, Instant from, Instant to, int page, int size) {
        StringBuilder where = new StringBuilder(" WHERE created_at >= ? AND created_at < ?");
        List<Object> args = new ArrayList<>(List.of(Timestamp.from(from), Timestamp.from(to)));
        if (actorId != null) { where.append(" AND actor_id = ?"); args.add(actorId); }
        if (action != null) { where.append(" AND action = ?"); args.add(action.name()); }
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs" + where, Long.class, args.toArray());
        List<Object> pageArgs = new ArrayList<>(args);
        pageArgs.add(size);
        pageArgs.add((long) page * size);
        List<AuditView> rows = jdbc.query("""
                SELECT id, actor_id, actor_role, action, target_type, target_id, detail, ip, trace_id, created_at
                  FROM audit_logs""" + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                (rs, i) -> new AuditView(rs.getLong("id"), (Long) rs.getObject("actor_id", Long.class), rs.getString("actor_role"),
                        rs.getString("action"), rs.getString("target_type"), rs.getString("target_id"), parse(rs.getString("detail")),
                        rs.getString("ip"), rs.getString("trace_id"), rs.getTimestamp("created_at").toInstant()),
                pageArgs.toArray());
        return new PageResponse<>(rows, page, size, total, (int) ((total + size - 1) / size));
    }

    private JsonNode parse(String s) {
        try { return s == null ? null : json.readTree(s); } catch (Exception e) { return null; }
    }
}
```

**`src/main/java/com/example/shop/shared/audit/internal/web/AuditLogController.java`**

```java
package com.example.shop.shared.audit.internal.web;

import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.internal.AuditQuery;
import com.example.shop.shared.audit.internal.AuditQuery.AuditView;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.PageResponse;
import com.example.shop.shared.web.Role;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.Instant;

/** US-AUD-1 AC-3：GET /api/admin/audit-logs?actorId=&action=&from=&to= */
@RestController
class AuditLogController {

    static final Duration MAX_RANGE = Duration.ofDays(31);

    private final AuditQuery query;

    AuditLogController(AuditQuery query) { this.query = query; }

    @GetMapping("/api/admin/audit-logs")
    PageResponse<AuditView> search(CurrentUser user,
                                   @RequestParam(required = false) Long actorId,
                                   @RequestParam(required = false) AuditAction action,
                                   @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
                                   @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
                                   @RequestParam(defaultValue = "0") @Min(value = 0, message = "page 不可為負") int page,
                                   @RequestParam(defaultValue = "50") @Min(value = 1, message = "size 1～200") @Max(value = 200, message = "size 1～200") int size) {
        user.require(Role.ADMIN);
        if (!from.isBefore(to) || Duration.between(from, to).compareTo(MAX_RANGE) > 0)
            throw new ShopException(ProblemType.VALIDATION, "時間區間必須是 from < to，且不超過 31 天");
        return query.search(actorId, action, from, to, page, size);
    }
}
```

#### account

**`src/main/java/com/example/shop/account/internal/PasswordConfig.java`**

```java
package com.example.shop.account.internal;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

@Configuration(proxyBeanMethods = false)
class PasswordConfig {

    /** US-ACC-1 AC-1：BCrypt cost 10（0.6.5）。不用 DelegatingPasswordEncoder：資料庫裡只有一種格式，換演算法是一個 migration */
    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(10);
    }
}
```

**`src/main/java/com/example/shop/account/internal/Account.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.shared.web.Role;

import java.util.Set;

record Account(long id, String email, String passwordHash, String displayName, boolean suspended, Set<Role> roles) {}
```

**`src/main/java/com/example/shop/account/internal/Accounts.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.shared.web.Role;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Component;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.EnumSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/** users、user_roles 的存取（account 模組擁有這兩張表，0.3.4） */
@Component
class Accounts {

    private final JdbcTemplate jdbc;

    Accounts(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * 5.6.3：兩個條件。第一個走 uk_users_email（ai_ci，type=const）；第二個用 utf8mb4_bin 把「長得像」的排除掉。
     * 傳進來的一定是 Email.normalize() 過的值。
     */
    Optional<Account> findByEmail(String normalizedEmail) {
        return one("WHERE u.email = ? AND u.email = ? COLLATE utf8mb4_bin", normalizedEmail, normalizedEmail);
    }

    Optional<Account> findById(long id) {
        return one("WHERE u.id = ?", id);
    }

    private Optional<Account> one(String where, Object... args) {
        List<Object[]> rows = jdbc.query("SELECT u.id, u.email, u.password_hash, u.display_name, u.status FROM users u " + where,
                (rs, i) -> new Object[]{rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)}, args);
        if (rows.isEmpty()) return Optional.empty();
        Object[] r = rows.get(0);
        long id = (Long) r[0];
        return Optional.of(new Account(id, (String) r[1], (String) r[2], (String) r[3], "SUSPENDED".equals(r[4]), roles(id)));
    }

    Set<Role> roles(long userId) {
        Set<Role> roles = EnumSet.noneOf(Role.class);
        jdbc.queryForList("SELECT role FROM user_roles WHERE user_id = ?", String.class, userId).forEach(r -> roles.add(Role.valueOf(r)));
        return roles;
    }

    /** 撞到 uk_users_email → DuplicateKeyException（呼叫端轉成 409） */
    long insert(String normalizedEmail, String passwordHash, String displayName, Role role, Long grantedBy) {
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement("INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, normalizedEmail);
            ps.setString(2, passwordHash);
            ps.setString(3, displayName);
            return ps;
        }, key);
        long id = key.getKey().longValue();
        jdbc.update("INSERT INTO user_roles (user_id, role, granted_by) VALUES (?, ?, ?)", id, role.name(), grantedBy);
        return id;
    }

    /**
     * @return false = 本來就有這個角色。
     * 不用 ON DUPLICATE KEY UPDATE 判斷：Connector/J 預設（useAffectedRows=false）回報的是「找到的列數」，重複時一樣是 1
     */
    boolean grant(long userId, Role role, long grantedBy) {
        try {
            jdbc.update("INSERT INTO user_roles (user_id, role, granted_by) VALUES (?, ?, ?)", userId, role.name(), grantedBy);
            return true;
        } catch (org.springframework.dao.DuplicateKeyException e) {
            return false;
        }
    }

    /** @return false = 本來就是停權狀態 */
    boolean suspend(long userId) {
        return jdbc.update("""
                UPDATE users SET status = 'SUSPENDED', updated_at = CURRENT_TIMESTAMP(3), version = version + 1
                 WHERE id = ? AND status = 'ACTIVE'""", userId) == 1;
    }

    boolean exists(long userId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM users WHERE id = ?)", Boolean.class, userId));
    }

    long adminCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM user_roles WHERE role = 'ADMIN'", Long.class);
    }
}
```

**`src/main/java/com/example/shop/account/internal/AuthDtos.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.shared.web.Role;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.Set;

/** 5.4、5.6、5.7 的請求與回應。注意 RegisterRequest 沒有 role 欄位（US-ACC-1 AC-4） */
public final class AuthDtos {
    private AuthDtos() {}

    public record RegisterRequest(
            @NotBlank(message = "email 必填") @Email(message = "email 格式不正確") @Size(max = 254, message = "email 最多 254 個字元") String email,
            @NotNull(message = "密碼必填") @Utf8Bytes String password,
            @NotBlank(message = "顯示名稱必填") @Size(max = 50, message = "顯示名稱最多 50 個字元") String displayName) {}

    /** 登入不檢查密碼格式：規則改過之後，舊密碼不符合新規則的人也要能登入 */
    public record LoginRequest(@NotBlank(message = "email 必填") @Size(max = 254) String email,
                               @NotBlank(message = "密碼必填") @Size(max = 200) String password) {}

    public record RefreshRequest(@NotBlank(message = "refreshToken 必填") @Size(max = 100) String refreshToken) {}

    public record TokenResponse(String accessToken, String tokenType, long expiresIn, String refreshToken) {}

    public record Me(long id, String email, String displayName, Set<Role> roles) {}

    public record GrantRoleRequest(@NotNull(message = "role 必填") Role role) {}
}
```

**`src/main/java/com/example/shop/account/internal/RefreshTokens.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.shared.config.ShopProperties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * 5.7 refresh token（US-ACC-2 AC-1、4、5）：不透明的隨機字串，資料庫只存 SHA-256。
 * 為什麼是不透明字串而不是 JWT：見 09-spring-security/05 的 5.6.1 —— 它一定要查資料庫（rotation、撤銷），JWT 的「不用查」在這裡沒有好處。
 */
@Component
class RefreshTokens {

    private static final SecureRandom RANDOM = new SecureRandom();

    enum Outcome { ROTATED, UNKNOWN, EXPIRED_OR_REVOKED, REUSED }

    record Rotation(Outcome outcome, Long userId, String newToken) {
        static Rotation of(Outcome o, Long userId) { return new Rotation(o, userId, null); }
    }

    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final Duration ttl;

    RefreshTokens(JdbcTemplate jdbc, Clock clock, ShopProperties props) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ttl = props.security().refreshTokenTtl();
    }

    static String hash(String raw) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Transactional(propagation = Propagation.MANDATORY)
    String issue(long userId) {
        byte[] b = new byte[32];
        RANDOM.nextBytes(b);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(b);           // 256 bits，43 個字元
        jdbc.update("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
                userId, hash(raw), Timestamp.from(clock.instant().plus(ttl)));
        return raw;
    }

    /**
     * AC-4 rotation：舊的作廢、發新的。0.5.5 的同一條規則 —— 條件式 UPDATE，看影響列數（5.2.4：先讀再寫，同一個 token 換出兩張新的）。
     * 影響 0 列時用 FOR UPDATE 重讀：不管這個交易之前讀過什麼，都讀到最新提交的版本（5.7.1；4.6.2 就是「之前讀過」的那一種）。
     *
     * 不在這裡丟例外：REUSED 要撤銷這個使用者全部的 token，那個 UPDATE 必須 commit —— 丟例外會讓它 rollback。
     * 結果回傳給呼叫端，交易結束「之後」才變成 401。
     */
    @Transactional(propagation = Propagation.MANDATORY)
    Rotation rotate(String raw) {
        String h = hash(raw);
        Timestamp now = Timestamp.from(clock.instant());
        int n = jdbc.update("""
                UPDATE refresh_tokens SET used_at = ?
                 WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?""", now, h, now);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT user_id, used_at FROM refresh_tokens WHERE token_hash = ? FOR UPDATE", h);
        if (rows.isEmpty()) return Rotation.of(Outcome.UNKNOWN, null);
        long userId = ((Number) rows.get(0).get("user_id")).longValue();
        if (n == 1) return new Rotation(Outcome.ROTATED, userId, null);
        if (rows.get(0).get("used_at") != null && n == 0) {
            revokeAll(userId);                                                             // AC-5：重放 = 被偷了
            return Rotation.of(Outcome.REUSED, userId);
        }
        return Rotation.of(Outcome.EXPIRED_OR_REVOKED, userId);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    int revokeAll(long userId) {
        return jdbc.update("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                Timestamp.from(clock.instant()), userId);
    }
}
```

**`src/main/java/com/example/shop/account/internal/LoginAttempts.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.shared.config.ShopProperties;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.OptionalLong;

/**
 * 5.6.2 US-ACC-2 AC-3：同一個帳號 15 分鐘內連續失敗 5 次 → 鎖定。計數在 Redis（多台機器共用）。
 *
 * 兩個順序上的決定：
 *  ① 先 INCR 佔一個名額、再驗密碼（5.2.3：先查再驗，50 個並行請求全部通過檢查）
 *  ② Redis 連不上時放行（0.6.3 的 fail-open），並且在 5 秒內不再嘗試（5.6.4：Redis「卡住」時，每一次碰它都要先等 500 ms 的逾時）
 */
@Component
class LoginAttempts {

    private static final Logger log = LoggerFactory.getLogger(LoginAttempts.class);

    /** INCR 與第一次的 PEXPIRE 必須是同一個原子動作：行程在兩句之間死掉，這個 key 就永遠不會過期（永久鎖定） */
    static final RedisScript<List> ACQUIRE = RedisScript.of("""
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
            return {n, redis.call('PTTL', KEYS[1])}""", List.class);

    static final Duration DEGRADED_BACKOFF = Duration.ofSeconds(5);

    /** 鎖定中 → 剩餘秒數（Retry-After）；放行 → empty */
    record Attempt(String key, long count, OptionalLong lockedForSeconds) {
        static Attempt unchecked(String key) { return new Attempt(key, 0, OptionalLong.empty()); }
        boolean checked() { return count > 0; }
    }

    private final StringRedisTemplate redis;
    private final Clock clock;
    private final int maxFailures;
    private final Duration window;
    private final Counter degraded;
    private volatile long skipRedisUntil;

    LoginAttempts(StringRedisTemplate redis, Clock clock, ShopProperties props, MeterRegistry meters) {
        this.redis = redis;
        this.clock = clock;
        this.maxFailures = props.security().login().maxFailures();
        this.window = props.security().login().lockWindow();
        this.degraded = Counter.builder("shop.login.lockout.degraded")
                .description("Redis 無法使用、登入鎖定暫停的次數（0.6.3：要告警）").register(meters);
    }

    static String key(String normalizedEmail) { return "login:fail:" + normalizedEmail; }

    /** 登入「之前」：先佔一個名額。這一次也算進去 —— 第 6 次的 n = 6 > 5 */
    Attempt acquire(String normalizedEmail) {
        String key = key(normalizedEmail);
        if (clock.millis() < skipRedisUntil) { degraded.increment(); return Attempt.unchecked(key); }
        try {
            List<?> r = redis.execute(ACQUIRE, List.of(key), Long.toString(window.toMillis()));
            long n = ((Number) r.get(0)).longValue(), pttl = ((Number) r.get(1)).longValue();
            OptionalLong locked = n > maxFailures ? OptionalLong.of(Math.max(1, (pttl + 999) / 1000)) : OptionalLong.empty();
            return new Attempt(key, n, locked);
        } catch (DataAccessException e) {
            degrade(e);
            return Attempt.unchecked(key);
        }
    }

    /** 密碼錯誤。@return true = 這一次讓帳號進入鎖定（第 5 次失敗）：鎖定期從現在開始算 15 分鐘 */
    boolean failed(Attempt a) {
        if (!a.checked() || a.count() != maxFailures) return false;
        try {
            redis.expire(a.key(), window);
        } catch (DataAccessException e) {
            degrade(e);
        }
        return true;
    }

    /** 登入成功：「連續」失敗的計數歸零 */
    void succeeded(Attempt a) {
        if (!a.checked()) return;
        try {
            redis.delete(a.key());
        } catch (DataAccessException e) {
            degrade(e);
        }
    }

    private void degrade(DataAccessException e) {
        boolean first = clock.millis() >= skipRedisUntil;
        skipRedisUntil = clock.millis() + DEGRADED_BACKOFF.toMillis();
        degraded.increment();
        if (first) log.warn("LOGIN_LOCKOUT_DEGRADED Redis 無法使用，{} 秒內暫停登入失敗鎖定（0.6.3 fail-open）：{}",
                DEGRADED_BACKOFF.toSeconds(), e.getMessage());
    }
}
```

**`src/main/java/com/example/shop/account/internal/IpLoginLimiter.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.shared.config.ShopProperties;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 5.6.4 0.6.3：「Redis 掛了也要保留 IP 層級的單機限流」。每台機器自己算，每個 IP 每分鐘 20 次（0.6.5）。
 * 單機的代價：N 台機器，實際上限是 20 × N。它不是主要防線（主要防線是帳號鎖定），是 Redis 掛掉時的底線。
 * 第 06 章的全站限流在 Redis 上；這一個不依賴任何東西，所以它永遠在。
 */
@Component
class IpLoginLimiter {

    record Window(long minute, AtomicInteger count) {}

    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();
    private final Clock clock;
    private final int perMinute;

    IpLoginLimiter(Clock clock, ShopProperties props) {
        this.clock = clock;
        this.perMinute = props.security().login().perIpPerMinute();
    }

    /** @return 0 = 放行；> 0 = 被限流，到下一分鐘還有幾秒 */
    long tryAcquire(String ip) {
        long now = clock.millis(), minute = now / 60_000;
        Window w = windows.compute(ip, (k, old) -> old == null || old.minute() != minute ? new Window(minute, new AtomicInteger()) : old);
        if (w.count().incrementAndGet() <= perMinute) {
            if (windows.size() > 100_000) windows.values().removeIf(x -> x.minute() < minute);   // 不讓 map 無限長大
            return 0;
        }
        return Math.max(1, ((minute + 1) * 60_000 - now + 999) / 1000);
    }
}
```

**`src/main/java/com/example/shop/account/internal/AccountService.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.account.internal.AuthDtos.Me;
import com.example.shop.account.internal.AuthDtos.RegisterRequest;
import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.Role;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Map;
import java.util.Set;

/** 5.4 註冊（US-ACC-1）、5.10 管理員對帳號的動作（US-ACC-3） */
@Service
public class AccountService {

    private final Accounts accounts;
    private final PasswordEncoder encoder;
    private final RefreshTokens refreshTokens;
    private final AuditLog audit;
    private final TransactionTemplate tx;

    AccountService(Accounts accounts, PasswordEncoder encoder, RefreshTokens refreshTokens, AuditLog audit, TransactionTemplate tx) {
        this.accounts = accounts;
        this.encoder = encoder;
        this.refreshTokens = refreshTokens;
        this.audit = audit;
        this.tx = tx;
    }

    /**
     * BCrypt 在交易「外面」算（5.4.3）；交易裡只有兩句 INSERT。
     * 用 TransactionTemplate 而不是另一個 @Transactional 方法：this.insert() 不經過代理，@Transactional 會被默默忽略（4.2.2 的 ⚠️）
     */
    public Me register(RegisterRequest req) {
        String email = Email.normalize(req.email());
        String name = req.displayName().strip();
        String hash = encoder.encode(req.password());
        try {
            long id = tx.execute(s -> accounts.insert(email, hash, name, Role.BUYER, null));   // AC-4：角色寫死，不從請求來
            return new Me(id, email, name, Set.of(Role.BUYER));
        } catch (DuplicateKeyException e) {
            throw new ShopException(ProblemType.EMAIL_UNAVAILABLE, "無法以此 email 註冊");      // AC-2：不說「已被使用」
        }
    }

    @Transactional(readOnly = true)
    public Me me(long userId) {
        Account a = accounts.findById(userId).orElseThrow(() -> ShopException.notFound("帳號"));
        return new Me(a.id(), a.email(), a.displayName(), a.roles());
    }

    /** US-ACC-3 AC-1：授予 SELLER。稽核跟授權在同一個交易（AUD-1 AC-1） */
    @Transactional
    public Me grant(long adminId, long userId, Role role) {
        if (role != Role.SELLER)
            throw new ShopException(ProblemType.VALIDATION, "只能授予 SELLER（ADMIN 由部署時的環境變數建立，0.3.2：管理員看得多、改得少）");
        if (!accounts.exists(userId)) throw ShopException.notFound("帳號");
        if (accounts.grant(userId, role, adminId))
            audit.record(AuditEntry.of(AuditAction.ROLE_GRANTED, adminId, Role.ADMIN.name(), "USER", userId, Map.of("role", role.name())));
        return me(userId);
    }

    /** 停權：狀態改掉、refresh token 全部撤銷（AC-6：refresh 立即失敗；已經發出去的 access token 最多再活 15 分鐘） */
    @Transactional
    public Me suspend(long adminId, long userId) {
        if (adminId == userId) throw new ShopException(ProblemType.VALIDATION, "不能停權自己");
        if (!accounts.exists(userId)) throw ShopException.notFound("帳號");
        if (accounts.suspend(userId)) {
            int revoked = refreshTokens.revokeAll(userId);
            audit.record(AuditEntry.of(AuditAction.USER_SUSPENDED, adminId, Role.ADMIN.name(), "USER", userId,
                    Map.of("revokedSessions", revoked)));
        }
        return me(userId);
    }
}
```

**`src/main/java/com/example/shop/account/internal/LoginService.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.account.internal.AuthDtos.TokenResponse;
import com.example.shop.account.internal.LoginAttempts.Attempt;
import com.example.shop.account.internal.RefreshTokens.Rotation;
import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.security.AccessTokens;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Map;
import java.util.UUID;

/**
 * 5.6 登入（US-ACC-2 AC-1～3）與 5.7 refresh（AC-4～6）。
 *
 * 這個類別「沒有」@Transactional：BCrypt 一次約 75 ms（5.4.3），在交易裡做等於拿著一條連線什麼都不做。
 * 只有寫 refresh_tokens 的那幾句 SQL 在交易裡（TransactionTemplate）。
 */
@Service
public class LoginService {

    private static final Logger log = LoggerFactory.getLogger(LoginService.class);
    static final String BAD_CREDENTIALS = "email 或密碼不正確";

    private final Accounts accounts;
    private final PasswordEncoder encoder;
    private final LoginAttempts attempts;
    private final IpLoginLimiter ipLimiter;
    private final RefreshTokens refreshTokens;
    private final AccessTokens accessTokens;
    private final AuditLog audit;
    private final TransactionTemplate tx;
    /** AC-2：帳號不存在時，也要做一次一樣貴的 BCrypt（5.6.1） */
    private final String dummyHash;

    LoginService(Accounts accounts, PasswordEncoder encoder, LoginAttempts attempts, IpLoginLimiter ipLimiter,
                 RefreshTokens refreshTokens, AccessTokens accessTokens, AuditLog audit, TransactionTemplate tx) {
        this.accounts = accounts;
        this.encoder = encoder;
        this.attempts = attempts;
        this.ipLimiter = ipLimiter;
        this.refreshTokens = refreshTokens;
        this.accessTokens = accessTokens;
        this.audit = audit;
        this.tx = tx;
        this.dummyHash = encoder.encode(UUID.randomUUID().toString());
    }

    public TokenResponse login(String rawEmail, String password, String ip) {
        long ipWait = ipLimiter.tryAcquire(ip);
        if (ipWait > 0) throw new ShopException(ProblemType.RATE_LIMITED, "登入嘗試太頻繁，請稍後再試").with("retryAfter", ipWait);

        String email = Email.normalize(rawEmail);
        Attempt attempt = attempts.acquire(email);
        if (attempt.lockedForSeconds().isPresent())                                         // AC-3：即使這次密碼是對的
            throw new ShopException(ProblemType.RATE_LIMITED, "登入失敗次數過多，帳號暫時鎖定")
                    .with("retryAfter", attempt.lockedForSeconds().getAsLong());

        var account = accounts.findByEmail(email);
        boolean ok = encoder.matches(password, account.map(Account::passwordHash).orElse(dummyHash));
        if (!ok || account.isEmpty()) {
            if (attempts.failed(attempt)) {
                log.warn("LOGIN_LOCKED email={}", Email.mask(email));
                audit.recordRejection(AuditEntry.of(AuditAction.LOGIN_LOCKED, account.map(Account::id).orElse(null), null,
                        "USER", account.map(Account::id).orElse(null), Map.of("email", Email.mask(email))));
            }
            throw new ShopException(ProblemType.UNAUTHENTICATED, BAD_CREDENTIALS);         // AC-2：兩種情況一模一樣
        }
        attempts.succeeded(attempt);
        Account a = account.get();
        if (a.suspended()) throw new ShopException(ProblemType.FORBIDDEN, "帳號已停權");      // 密碼對了才說 —— 不會洩漏帳號是否存在
        String refresh = tx.execute(s -> refreshTokens.issue(a.id()));
        return tokens(a.id(), a, refresh);
    }

    public TokenResponse refresh(String raw) {
        Rotation r = tx.execute(s -> {
            Rotation rot = refreshTokens.rotate(raw);
            if (rot.outcome() == RefreshTokens.Outcome.REUSED)
                audit.record(AuditEntry.of(AuditAction.REFRESH_TOKEN_REUSED, rot.userId(), null, "USER", rot.userId(), null));
            if (rot.outcome() != RefreshTokens.Outcome.ROTATED) return rot;
            Account a = accounts.findById(rot.userId()).orElseThrow();
            if (a.suspended()) {                                                           // AC-6：refresh 立即失敗
                s.setRollbackOnly();
                return Rotation.of(RefreshTokens.Outcome.EXPIRED_OR_REVOKED, a.id());
            }
            return new Rotation(RefreshTokens.Outcome.ROTATED, a.id(), refreshTokens.issue(a.id()));
        });
        if (r.outcome() != RefreshTokens.Outcome.ROTATED) {
            if (r.outcome() == RefreshTokens.Outcome.REUSED) log.warn("REFRESH_TOKEN_REUSED userId={}（已撤銷該使用者全部的 refresh token）", r.userId());
            throw new ShopException(ProblemType.UNAUTHENTICATED, "refresh token 無效或已過期");
        }
        return tokens(r.userId(), accounts.findById(r.userId()).orElseThrow(), r.newToken());   // 角色從資料庫重讀：授權變更在這裡生效
    }

    private TokenResponse tokens(long userId, Account a, String refresh) {
        AccessTokens.Issued access = accessTokens.issue(userId, a.roles());
        return new TokenResponse(access.token(), "Bearer", access.expiresInSeconds(), refresh);
    }
}
```

**`src/main/java/com/example/shop/account/internal/BootstrapAdmin.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.web.Role;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;

/**
 * 5.10 US-ACC-3 AC-3：第一個管理員由環境變數建立，程式碼裡沒有任何預設帳密。
 * 資料庫裡已經有管理員 → 什麼都不做（環境變數之後可以拿掉）；一個都沒有、又沒給環境變數 → 啟動失敗（1.7.4：缺設定就起不來）。
 */
@Component
class BootstrapAdmin implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(BootstrapAdmin.class);

    private final Accounts accounts;
    private final PasswordEncoder encoder;
    private final TransactionTemplate tx;
    private final ShopProperties.BootstrapAdmin config;

    BootstrapAdmin(Accounts accounts, PasswordEncoder encoder, TransactionTemplate tx, ShopProperties props) {
        this.accounts = accounts;
        this.encoder = encoder;
        this.tx = tx;
        this.config = props.security().bootstrapAdmin();
    }

    @Override
    public void run(ApplicationArguments args) {
        if (!config.enabled() || accounts.adminCount() > 0) return;
        String email = Email.normalize(config.email()), password = config.password() == null ? "" : config.password();
        if (email.isEmpty() || password.isEmpty())
            throw new IllegalStateException("資料庫裡沒有任何管理員，而且沒有設定 SHOP_BOOTSTRAP_ADMIN_EMAIL / SHOP_BOOTSTRAP_ADMIN_PASSWORD（US-ACC-3 AC-3）");
        if (!email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+"))                          // 5.10：參數傳錯時，email 曾經變成「--shop.security...」
            throw new IllegalStateException("SHOP_BOOTSTRAP_ADMIN_EMAIL 不是一個 email：" + Email.mask(email));
        int bytes = password.getBytes(StandardCharsets.UTF_8).length;
        if (password.length() < 12 || bytes > 72)
            throw new IllegalStateException("SHOP_BOOTSTRAP_ADMIN_PASSWORD 至少 12 個字元、最多 72 bytes");
        long id = tx.execute(s -> accounts.insert(email, encoder.encode(password), "管理員", Role.ADMIN, null));
        log.warn("BOOTSTRAP_ADMIN_CREATED id={} email={}（請把 SHOP_BOOTSTRAP_ADMIN_PASSWORD 從部署設定中移除）", id, Email.mask(email));
    }
}
```

**`src/main/java/com/example/shop/account/internal/web/AuthController.java`**

```java
package com.example.shop.account.internal.web;

import com.example.shop.account.internal.AuthDtos.*;
import com.example.shop.account.internal.AccountService;
import com.example.shop.account.internal.LoginService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

/** US-ACC-1、US-ACC-2：三支公開的 API（SecurityConfig 裡 permitAll 的那三行） */
@RestController
@RequestMapping("/api/auth")
class AuthController {

    private final AccountService accounts;
    private final LoginService auth;

    AuthController(AccountService accounts, LoginService auth) {
        this.accounts = accounts;
        this.auth = auth;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    Me register(@Valid @RequestBody RegisterRequest req) {
        return accounts.register(req);
    }

    @PostMapping("/login")
    TokenResponse login(@Valid @RequestBody LoginRequest req, HttpServletRequest http) {
        return auth.login(req.email(), req.password(), http.getRemoteAddr());
    }

    @PostMapping("/refresh")
    TokenResponse refresh(@Valid @RequestBody RefreshRequest req) {
        return auth.refresh(req.refreshToken());
    }
}
```

**`src/main/java/com/example/shop/account/internal/web/AccountController.java`**

```java
package com.example.shop.account.internal.web;

import com.example.shop.account.internal.AuthDtos.GrantRoleRequest;
import com.example.shop.account.internal.AuthDtos.Me;
import com.example.shop.account.internal.AccountService;
import com.example.shop.shared.web.CurrentUser;
import com.example.shop.shared.web.Role;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

/** GET /api/me（0.8）；US-ACC-3 管理員的兩個動作 */
@RestController
class AccountController {

    private final AccountService accounts;

    AccountController(AccountService accounts) { this.accounts = accounts; }

    @GetMapping("/api/me")
    Me me(CurrentUser user) {
        return accounts.me(user.id());
    }

    @PostMapping("/api/admin/users/{id}/roles")
    Me grant(CurrentUser user, @PathVariable long id, @Valid @RequestBody GrantRoleRequest req) {
        return accounts.grant(user.require(Role.ADMIN).id(), id, req.role());
    }

    @PostMapping("/api/admin/users/{id}/suspend")
    Me suspend(CurrentUser user, @PathVariable long id) {
        return accounts.suspend(user.require(Role.ADMIN).id(), id);
    }
}
```

#### ordering、catalog、payment

**`src/main/java/com/example/shop/ordering/internal/OrderAccess.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.Role;
import org.springframework.stereotype.Component;

/**
 * 5.8 資料層級權限：「這張訂單是不是你的」只在這裡判斷（0.6.5：在 Service 層，不只在 Controller）。
 *
 * 規則（US-ORD-5 AC-3、US-ORD-4 AC-5）：
 *  - 不存在 → 404
 *  - 存在但不屬於你 → 「一模一樣」的 404，外加一筆 ACCESS_DENIED
 *    獨立寫入（呼叫端接著會丟例外、rollback），而且在背景寫（5.8.3：同步寫的話，回應慢 2 ms，攻擊者從時間就分得出來）
 *
 * 每一支帶 {orderNo} 的 API 都必須經過這裡 —— IdorMatrixTest 會對每一支這樣的 API 用別人的身分打一次。
 */
@Component
class OrderAccess {

    private final OrderRepository orders;
    private final AuditLog audit;

    OrderAccess(OrderRepository orders, AuditLog audit) {
        this.orders = orders;
        this.audit = audit;
    }

    /** 只回傳 id，不載入 Entity（4.6.5：之後的 JDBC 狀態轉移不能被 persistence context 裡的舊 Entity 蓋掉） */
    long buyers(long buyerId, String orderNo) {
        return orders.findIdByOrderNoAndBuyerId(orderNo, buyerId)
                .orElseThrow(() -> denied(buyerId, Role.BUYER, orderNo, orders.existsByOrderNo(orderNo)));
    }

    long sellers(long sellerId, String orderNo) {
        return orders.findIdByOrderNoAndSellerId(orderNo, sellerId)
                .orElseThrow(() -> denied(sellerId, Role.SELLER, orderNo, orders.existsByOrderNo(orderNo)));
    }

    ShopException denied(long actorId, Role role, String orderNo, boolean exists) {
        if (exists) audit.recordRejectionLater(AuditEntry.of(AuditAction.ACCESS_DENIED, actorId, role.name(), "ORDER", orderNo, null));
        return ShopException.notFound("訂單");
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderCommands.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.internal.OrderDtos.OrderView;
import com.example.shop.ordering.internal.OrderDtos.PaymentStarted;
import com.example.shop.ordering.internal.OrderTransitionService.EventData;
import com.example.shop.payment.PaymentApi;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.web.Role;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;

/** 買家與賣家對「自己的」訂單下的指令。別人的訂單一律 404（US-ORD-4 AC-5）。 */
@Service
public class OrderCommands {

    private final OrderRepository orders;
    private final OrderTransitionService transitions;
    private final OrderQueryService queries;
    private final PaymentApi payments;
    private final OrderAccess access;
    private final AuditLog audit;

    OrderCommands(OrderRepository orders, OrderTransitionService transitions, OrderQueryService queries, PaymentApi payments,
                  OrderAccess access, AuditLog audit) {
        this.orders = orders;
        this.transitions = transitions;
        this.queries = queries;
        this.payments = payments;
        this.access = access;
        this.audit = audit;
    }

    /**
     * 只查 id，不載入 Entity（4.6.5）：狀態轉移用 JDBC 的條件式 UPDATE 改資料庫，
     * 如果這裡把 Order 載進了 persistence context，之後同一個交易裡的 queries.byId() 會拿到那個「改之前」的 Entity。
     * 「是不是你的」在 OrderAccess 判斷（5.8）
     */
    private long buyers(long buyerId, String orderNo) { return access.buyers(buyerId, orderNo); }

    private long sellers(long sellerId, String orderNo) { return access.sellers(sellerId, orderNo); }

    @Transactional
    public OrderView cancelByBuyer(long buyerId, String orderNo) {                     // US-ORD-4
        long id = buyers(buyerId, orderNo);
        transitions.apply(id, OrderEvent.BUYER_CANCEL, OrderHistory.Actor.buyer(buyerId), EventData.cancel("BUYER"));
        return queries.byId(id);
    }

    @Transactional
    public OrderView confirmReceipt(long buyerId, String orderNo) {                    // US-ORD-6 AC-3
        long id = buyers(buyerId, orderNo);
        transitions.apply(id, OrderEvent.CONFIRM_RECEIPT, OrderHistory.Actor.buyer(buyerId), EventData.NONE);
        return queries.byId(id);
    }

    @Transactional
    public PaymentStarted startPayment(long buyerId, String orderNo) {                 // US-ORD-2 AC-1
        long id = buyers(buyerId, orderNo);
        Order o = orders.findById(id).orElseThrow();
        if (o.getStatus() != OrderStatus.PENDING_PAYMENT)
            throw new ShopException(ProblemType.INVALID_STATE, "這張訂單不是待付款狀態").with("orderStatus", o.getStatus());
        PaymentApi.CreatedPayment p = payments.create(id, o.getTotalAmount());
        return new PaymentStarted(p.paymentId(), p.amount(), p.payUrl());
    }

    @Transactional
    public OrderView startPicking(long sellerId, String orderNo) {                     // US-ORD-6 AC-1
        long id = sellers(sellerId, orderNo);
        transitions.apply(id, OrderEvent.START_PICKING, OrderHistory.Actor.seller(sellerId), EventData.NONE);
        return queries.byId(id);
    }

    @Transactional
    public OrderView ship(long sellerId, String orderNo, String carrier, String trackingNo) {   // US-ORD-6 AC-2
        long id = sellers(sellerId, orderNo);
        transitions.apply(id, OrderEvent.SHIP, OrderHistory.Actor.seller(sellerId), EventData.shipment(carrier, trackingNo));
        return queries.byId(id);
    }

    /** US-ORD-6 AC-5：稽核跟取消在同一個交易 —— 取消失敗（例如已經出貨，409），稽核也跟著 rollback（5.2.5） */
    @Transactional
    public OrderView cancelBySeller(long sellerId, String orderNo) {
        long id = sellers(sellerId, orderNo);
        transitions.apply(id, OrderEvent.SELLER_CANCEL, OrderHistory.Actor.seller(sellerId), EventData.cancel("SELLER_OUT_OF_STOCK"));
        audit.record(AuditEntry.of(AuditAction.ORDER_CANCELLED_BY_SELLER, sellerId, Role.SELLER.name(), "ORDER", orderNo,
                Map.of("cancelReason", "SELLER_OUT_OF_STOCK")));
        return queries.byId(id);
    }
}
```

**`src/main/java/com/example/shop/ordering/internal/OrderQueryService.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderStatus;
import com.example.shop.ordering.internal.OrderDtos.OrderLineView;
import com.example.shop.ordering.internal.OrderDtos.OrderView;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.PageResponse;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 訂單的查詢面（US-ORD-5）。寫入面（下單、狀態轉移）在第 04 章。
 * 一頁訂單固定 3 句 SQL：訂單、總數、這一頁所有訂單的明細（驗收 Q4）。
 */
@Service
public class OrderQueryService {

    static final Sort NEWEST_FIRST = Sort.by(Sort.Direction.DESC, "createdAt");

    private final OrderRepository orders;
    private final OrderItemRepository items;
    private final OrderAccess access;

    OrderQueryService(OrderRepository orders, OrderItemRepository items, OrderAccess access) {
        this.orders = orders;
        this.items = items;
        this.access = access;
    }

    @Transactional(readOnly = true)
    public PageResponse<OrderView> buyerOrders(long buyerId, OrderStatus status, int page, int size) {
        PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
        return withItems(status == null ? orders.findByBuyerId(buyerId, pr) : orders.findByBuyerIdAndStatus(buyerId, status, pr));
    }

    @Transactional(readOnly = true)
    public PageResponse<OrderView> sellerOrders(long sellerId, OrderStatus status, int page, int size) {
        PageRequest pr = PageRequest.of(page, size, NEWEST_FIRST);
        return withItems(status == null ? orders.findBySellerId(sellerId, pr) : orders.findBySellerIdAndStatus(sellerId, status, pr));
    }

    /**
     * US-ORD-5 AC-3：別人的訂單 → 404，跟「不存在」一模一樣，外加一筆 ACCESS_DENIED（5.8）。
     * 跟指令走同一條路（OrderAccess.buyers）：兩種 404 執行的 SQL 一模一樣，都不載入 Entity（5.8.3：時間也要一樣）
     */
    @Transactional(readOnly = true)
    public OrderView buyerOrder(long buyerId, String orderNo) {
        return byId(access.buyers(buyerId, orderNo));
    }

    @Transactional(readOnly = true)
    public OrderView byId(long orderId) {
        Order o = orders.findById(orderId).orElseThrow(() -> ShopException.notFound("訂單"));
        return view(o, items.findByOrderIds(List.of(o.getId())));
    }

    private PageResponse<OrderView> withItems(Page<Order> page) {
        List<Long> ids = page.getContent().stream().map(Order::getId).toList();
        Map<Long, List<OrderItem>> byOrder = ids.isEmpty() ? Map.of()
                : items.findByOrderIds(ids).stream().collect(Collectors.groupingBy(OrderItem::orderId));
        return PageResponse.of(page, page.getContent().stream()
                .map(o -> view(o, byOrder.getOrDefault(o.getId(), List.of()))).toList());
    }

    private static OrderView view(Order o, List<OrderItem> lines) {
        return new OrderView(o.getOrderNo(), o.getStatus(), o.getTotalAmount(), o.getCreatedAt(), o.getPaymentDeadline(),
                lines.stream().map(i -> new OrderLineView(i.getProductId(), i.getProductName(), i.getUnitPrice(),
                        i.getQuantity(), i.getLineAmount())).toList());
    }
}
```

**`src/main/java/com/example/shop/catalog/internal/ProductService.java`**

```java
package com.example.shop.catalog.internal;

import com.example.shop.catalog.CatalogApi;
import com.example.shop.catalog.ProductSnapshot;
import com.example.shop.catalog.ProductStatus;
import com.example.shop.catalog.internal.ProductDtos.*;
import com.example.shop.inventory.InventoryApi;
import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.PageResponse;
import com.example.shop.shared.web.Role;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Clock;
import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * catalog 模組的應用層。public 是因為 internal.web 的 Controller 要用它（1.4.3：子套件之間要 public），
 * 別的模組不能用它 —— ModuleBoundaryTest 規則二。別的模組只能用 CatalogApi。
 */
@Service
public class ProductService implements CatalogApi {

    private final ProductRepository products;
    private final CategoryRepository categories;
    private final InventoryApi inventory;
    private final Clock clock;
    private final AuditLog audit;

    ProductService(ProductRepository products, CategoryRepository categories, InventoryApi inventory, Clock clock, AuditLog audit) {
        this.products = products;
        this.categories = categories;
        this.inventory = inventory;
        this.clock = clock;
        this.audit = audit;
    }

    @Transactional
    public ProductDetail create(long sellerId, CreateProductRequest req) {
        Category category = categories.findById(req.categoryId())
                .orElseThrow(() -> new ShopException(ProblemType.VALIDATION, "分類不存在").with("field", "categoryId"));
        Product p = products.save(Product.draft(sellerId, category, req.name().strip(), req.description(), req.price(), clock.instant()));
        inventory.initialize(p.getId(), req.initialStock(), "product-created");      // 同一個交易（MANDATORY）
        return detailOf(p, req.initialStock());
    }

    @Transactional
    public ProductDetail update(long sellerId, long productId, UpdateProductRequest req) {
        Product p = owned(sellerId, productId);
        Category category = req.categoryId() == null ? null : categories.findById(req.categoryId())
                .orElseThrow(() -> new ShopException(ProblemType.VALIDATION, "分類不存在").with("field", "categoryId"));
        BigDecimal before = p.getPrice();
        p.update(req.name() == null ? null : req.name().strip(), req.description(), req.price(), category, clock.instant());
        if (p.getPrice().compareTo(before) != 0)                                      // 299 與 299.00 不算改價（3.5.2、4.2.4）
            audit.record(AuditEntry.of(AuditAction.PRODUCT_PRICE_CHANGED, sellerId, Role.SELLER.name(), "PRODUCT", productId,
                    Map.of("oldPrice", before, "newPrice", p.getPrice())));
        return detailOf(p, inventory.available(productId));
    }

    @Transactional
    public ProductDetail publish(long sellerId, long productId) {
        Product p = owned(sellerId, productId);
        p.publish(clock.instant());
        return detailOf(p, inventory.available(productId));
    }

    @Transactional
    public ProductDetail unpublish(long sellerId, long productId) {
        Product p = owned(sellerId, productId);
        if (!p.unpublish(clock.instant()))
            throw new ShopException(ProblemType.INVALID_STATE, "草稿狀態的商品不能下架").with("productStatus", p.getStatus());
        return detailOf(p, inventory.available(productId));
    }

    @Transactional
    public ProductDetail restock(long sellerId, long productId, RestockRequest req) {
        owned(sellerId, productId);
        inventory.restock(productId, req.quantity(), req.note() == null ? "seller-restock" : "seller-restock:" + req.note());
        return detailOf(products.getReferenceById(productId), inventory.available(productId));
    }

    @Transactional(readOnly = true)
    public PageResponse<ProductSummary> search(SearchCriteria c, Pageable pageable) {
        Specification<Product> spec = Specification.where(ProductSpecs.onSale())
                .and(ProductSpecs.inCategory(c.categoryId()))
                .and(ProductSpecs.priceBetween(c.minPrice(), c.maxPrice()))
                .and(ProductSpecs.nameContains(c.q()));
        Page<Product> page = products.findAll(spec, pageable);
        return PageResponse.of(page, p -> new ProductSummary(p.getId(), p.getName(), p.getPrice(), p.getCategory().getId()));
    }

    /** US-PRD-3 AC-2：非 ON_SALE 的商品，只有賣家本人看得到；其他人一律 404（跟「不存在」長得一模一樣） */
    @Transactional(readOnly = true)
    public ProductDetail detail(long productId, Long viewerId) {
        Product p = products.findById(productId).orElseThrow(() -> ShopException.notFound("商品"));
        boolean visible = p.getStatus() == ProductStatus.ON_SALE || (viewerId != null && p.ownedBy(viewerId));
        if (!visible) throw ShopException.notFound("商品");
        return detailOf(p, inventory.available(productId));
    }

    @Transactional(readOnly = true)
    public PageResponse<SellerProductView> mine(long sellerId, Pageable pageable) {
        Page<Product> page = products.findBySellerId(sellerId, pageable);
        Map<Long, Integer> available = inventory.available(page.getContent().stream().map(Product::getId).toList());
        return PageResponse.of(page, p -> new SellerProductView(p.getId(), p.getName(), p.getPrice(), p.getStatus(),
                p.getCategory().getId(), available.getOrDefault(p.getId(), 0), p.getUpdatedAt()));
    }

    @Override
    @Transactional(readOnly = true)
    public Map<Long, ProductSnapshot> snapshots(Collection<Long> productIds) {
        if (productIds.isEmpty()) return Map.of();
        return products.findAllById(productIds).stream()
                .map(p -> new ProductSnapshot(p.getId(), p.getSellerId(), p.getName(), p.getPrice(), p.getStatus(), p.isHot()))
                .collect(Collectors.toMap(ProductSnapshot::id, Function.identity()));
    }

    /** US-PRD-1 AC-4：別人的商品 → 404，不是 403；存在但不是你的 → 另外記一筆 ACCESS_DENIED（US-AUD-1，5.8） */
    private Product owned(long sellerId, long productId) {
        Optional<Product> found = products.findById(productId);
        return found.filter(p -> p.ownedBy(sellerId)).orElseThrow(() -> {
            if (found.isPresent())
                audit.recordRejectionLater(AuditEntry.of(AuditAction.ACCESS_DENIED, sellerId, Role.SELLER.name(), "PRODUCT", productId, null));
            return ShopException.notFound("商品");
        });
    }

    private static ProductDetail detailOf(Product p, int available) {
        return new ProductDetail(p.getId(), p.getSellerId(), p.getName(), p.getDescription(), p.getPrice(),
                p.getCategory().getId(), p.getStatus(), available);
    }
}
```

**`src/main/java/com/example/shop/payment/internal/JdbcPaymentService.java`**

```java
package com.example.shop.payment.internal;

import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.RefundReason;
import com.example.shop.shared.audit.AuditAction;
import com.example.shop.shared.audit.AuditEntry;
import com.example.shop.shared.audit.AuditLog;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
class JdbcPaymentService implements PaymentApi {

    private static final Logger log = LoggerFactory.getLogger(JdbcPaymentService.class);

    private final JdbcTemplate jdbc;
    private final String secret;
    private final AuditLog audit;

    JdbcPaymentService(JdbcTemplate jdbc, ShopProperties props, AuditLog audit) {
        this.jdbc = jdbc;
        this.secret = props.payment().callbackSecret();
        this.audit = audit;
    }

    @Override
    @Transactional
    public CreatedPayment create(long orderId, BigDecimal amount) {
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "INSERT INTO payments (order_id, amount, status, provider) VALUES (?, ?, 'PENDING', 'SIMULATED')",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, orderId);
            ps.setBigDecimal(2, amount);
            return ps;
        }, key);
        long id = key.getKey().longValue();
        return new CreatedPayment(id, amount, "https://pay.example.test/simulated/" + id);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public Recorded record(Callback cb) {
        String expected = CallbackSignature.sign(secret, CallbackSignature.canonical(cb.paymentId(), cb.providerTxnId(), cb.amount(), cb.succeeded()));
        if (!CallbackSignature.matches(expected, cb.signature())) {
            log.warn("PAYMENT_SIGNATURE_INVALID paymentId={}", cb.paymentId());
            // 接下來的 401 會讓回呼的交易 rollback：稽核要在自己的交易裡（5.2.5）
            audit.recordRejection(AuditEntry.of(AuditAction.PAYMENT_SIGNATURE_INVALID, null, "PAYMENT_PROVIDER", "PAYMENT", cb.paymentId(),
                    Map.of("providerTxnId", cb.providerTxnId())));
            throw new ShopException(ProblemType.UNAUTHENTICATED, "簽章不正確");
        }
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT order_id, amount, status, provider_txn_id FROM payments WHERE id = ? FOR UPDATE", cb.paymentId());
        if (rows.isEmpty()) throw ShopException.notFound("付款");
        Map<String, Object> p = rows.get(0);
        long orderId = ((Number) p.get("order_id")).longValue();
        if (((BigDecimal) p.get("amount")).compareTo(cb.amount()) != 0) {
            log.error("PAYMENT_AMOUNT_MISMATCH paymentId={} expected={} actual={}", cb.paymentId(), p.get("amount"), cb.amount());   // AC-4：告警
            audit.recordRejection(AuditEntry.of(AuditAction.PAYMENT_AMOUNT_MISMATCH, null, "PAYMENT_PROVIDER", "PAYMENT", cb.paymentId(),
                    Map.of("expected", p.get("amount"), "actual", cb.amount(), "providerTxnId", cb.providerTxnId())));
            throw new ShopException(ProblemType.VALIDATION, "金額與付款不符");
        }
        String status = (String) p.get("status");
        if ("SUCCEEDED".equals(status)) {
            if (cb.providerTxnId().equals(p.get("provider_txn_id"))) return new Recorded(cb.paymentId(), orderId, Recorded.Kind.DUPLICATE);  // AC-5
            throw new ShopException(ProblemType.VALIDATION, "這筆付款已經以另一個交易編號成功");
        }
        if (!cb.succeeded()) {
            jdbc.update("UPDATE payments SET status = 'FAILED', provider_txn_id = ?, failure_reason = 'provider', updated_at = CURRENT_TIMESTAMP(3), version = version + 1 WHERE id = ?",
                    cb.providerTxnId(), cb.paymentId());
            return new Recorded(cb.paymentId(), orderId, Recorded.Kind.FAILED);
        }
        jdbc.update("""
                UPDATE payments SET status = 'SUCCEEDED', provider_txn_id = ?, failure_reason = NULL,
                       updated_at = CURRENT_TIMESTAMP(3), version = version + 1
                 WHERE id = ?""", cb.providerTxnId(), cb.paymentId());
        return new Recorded(cb.paymentId(), orderId, Recorded.Kind.FIRST_SUCCESS);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void requestRefund(long paymentId, RefundReason reason) {
        // INSERT ... SELECT：金額與訂單從付款那一列來。uk_refunds_payment 讓重複呼叫只留下一筆：
        // 撞到這個鍵時什麼都不做（ON DUPLICATE KEY UPDATE 一個 no-op）。
        // 不用 INSERT IGNORE —— 它會把「所有」錯誤降級成警告，包括 CHECK 違反（那一列會被默默跳過）。
        jdbc.update("""
                INSERT INTO refunds (payment_id, order_id, amount, reason, status)
                SELECT id, order_id, amount, ?, 'PENDING' FROM payments WHERE id = ? AND status = 'SUCCEEDED'
                ON DUPLICATE KEY UPDATE payment_id = refunds.payment_id""",
                reason.name(), paymentId);
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<Long> succeededPaymentOf(long orderId) {
        return jdbc.queryForList("""
                SELECT p.id FROM payments p
                 WHERE p.order_id = ? AND p.status = 'SUCCEEDED'
                   AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id)
                 ORDER BY p.updated_at, p.id LIMIT 1""", Long.class, orderId).stream().findFirst();
    }
}
```

#### 測試：迷你應用程式與驗收 Q5

**`src/test/java/com/example/lab/ch03/LabShopApp.java`**

```java
package com.example.lab.ch03;

import com.fasterxml.jackson.annotation.JsonIgnore;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * 3.2.1 的實驗用迷你應用程式：「大部分教學的寫法」—— public Entity、public getter、雙向關聯、Controller 直接回傳 Entity。
 * 放在 com.example.lab 底下，不會被正式的 ShopApplication 掃到（2.2.0）。直接讀 shop 資料庫的種子資料（唯讀）。
 */
@SpringBootApplication(exclude = {                 // 第 05 章加了 Spring Security：迷你應用程式不需要（也沒有）登入
        org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration.class,
        org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration.class,
        org.springframework.boot.autoconfigure.security.oauth2.resource.servlet.OAuth2ResourceServerAutoConfiguration.class,
        org.springframework.boot.actuate.autoconfigure.security.servlet.ManagementWebSecurityAutoConfiguration.class})
public class LabShopApp {

    /** lab.ignore-back-reference=true 時，等同在 LabOrderItem.getOrder() 上加 @JsonIgnore */
    abstract static class IgnoreOrder { @JsonIgnore abstract LabOrder getOrder(); }

    @Bean
    Jackson2ObjectMapperBuilderCustomizer backReference(Environment env) {
        return b -> { if (env.getProperty("lab.ignore-back-reference", Boolean.class, false)) b.mixIn(LabOrderItem.class, IgnoreOrder.class); };
    }
}
```

**`src/test/java/com/example/shop/acceptance/CapstoneAcceptanceTest.java`**（節錄：第 05 章的 Q5。`startApp()` 的改法見 5.5.6；`Http`、`product()`、`cleanupBuyersAndProducts()` 是第 04 章就有的工具）

```java
// ───────── 第 05 章：Q5 ─────────

static HttpResponse<String> http(int port, String method, String path, String bearer, String body) throws Exception {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).header("Content-Type", "application/json")
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
    if (bearer != null) b.header("Authorization", bearer);
    return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
}

/** 真的註冊、真的登入：這一題的身分不是 TestTokens 簽的，是 POST /api/auth/login 回來的 */
static String signUpAndLogin(int port, String email) throws Exception {
    assertThat(http(port, "POST", "/api/auth/register", null,
            "{\"email\": \"%s\", \"password\": \"q5-password-1234\", \"displayName\": \"Q5\"}".formatted(email)).statusCode()).isEqualTo(201);
    String body = http(port, "POST", "/api/auth/login", null, "{\"email\": \"%s\", \"password\": \"q5-password-1234\"}".formatted(email)).body();
    return "Bearer " + new Http(200, body, null).between("\"accessToken\":\"", "\"");
}

@Test
@DisplayName("Q5 買家 A 讀買家 B 的訂單：回 404（不是 403），且寫入稽核日誌")
void q5_idorReturns404() throws Exception {
    long product = 9_900_551;
    String a = "q5-a@acceptance.example.com", b = "q5-b@acceptance.example.com";
    try (var ctx = startApp()) {
        JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
        int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
        Runnable cleanup = () -> {
            List<Long> ids = jdbc.queryForList("SELECT id FROM users WHERE email IN (?, ?)", Long.class, a, b);
            cleanupBuyersAndProducts(jdbc, ids, List.of(product));
            for (long id : ids) {
                jdbc.update("DELETE FROM audit_logs WHERE actor_id = ?", id);
                jdbc.update("DELETE FROM refresh_tokens WHERE user_id = ?", id);
                jdbc.update("DELETE FROM user_roles WHERE user_id = ?", id);
                jdbc.update("DELETE FROM users WHERE id = ?", id);
            }
        };
        cleanup.run();
        try {
            product(jdbc, product, 5);
            String tokenA = signUpAndLogin(port, a), tokenB = signUpAndLogin(port, b);
            long idA = jdbc.queryForObject("SELECT id FROM users WHERE email = ?", Long.class, a);

            HttpResponse<String> placed = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/orders"))
                    .header("Authorization", tokenB).header("Content-Type", "application/json").header("Idempotency-Key", "q5")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(product)))
                    .build(), HttpResponse.BodyHandlers.ofString());
            String orderNoB = new Http(placed.statusCode(), placed.body(), null).orderNo();
            assertThat(placed.statusCode()).isEqualTo(201);

            HttpResponse<String> mine = http(port, "GET", "/api/orders/" + orderNoB, tokenB, null);
            HttpResponse<String> theirs = http(port, "GET", "/api/orders/" + orderNoB, tokenA, null);
            HttpResponse<String> ghost = http(port, "GET", "/api/orders/19990101-000000", tokenA, null);
            String theirsBody = theirs.body().replace(orderNoB, "{orderNo}"), ghostBody = ghost.body().replace("19990101-000000", "{orderNo}");

            await().atMost(java.time.Duration.ofSeconds(2)).until(() ->
                    jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'ACCESS_DENIED' AND actor_id = ?", Long.class, idA) == 1);
            Map<String, Object> audit = jdbc.queryForMap(
                    "SELECT actor_id, actor_role, target_type, target_id, ip FROM audit_logs WHERE action = 'ACCESS_DENIED' AND actor_id = ?", idA);
            System.out.println("Q5：B 讀自己的 → " + mine.statusCode() + "；A 讀 B 的 → " + theirs.statusCode() + "；A 讀不存在的 → " + ghost.statusCode()
                    + "；兩個 404 的 body 相同 = " + theirsBody.equals(ghostBody) + "；稽核 " + audit);
            assertThat(mine.statusCode()).isEqualTo(200);
            assertThat(theirs.statusCode()).isEqualTo(404);
            assertThat(theirsBody).isEqualTo(ghostBody);
            assertThat(audit).containsEntry("actor_id", idA).containsEntry("actor_role", "BUYER")
                    .containsEntry("target_type", "ORDER").containsEntry("target_id", orderNoB);
        } finally {
            cleanup.run();
        }
    }
}
```

#### 測試：本章新增

**`src/test/java/com/example/shop/api/AuthApiTest.java`**

```java
package com.example.shop.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 0.12.2 追溯表：ACC-1（註冊）、ACC-2（登入、refresh）、ACC-3（管理員）、AUD-1。
 * 不用 @Transactional：登入、refresh 在自己的交易裡寫 refresh_tokens，稽核有 REQUIRES_NEW —— 改成每個測試結束時清掉自己的資料。
 * 每一個請求帶不同的 remoteAddr：IpLoginLimiter 是每 IP 每分鐘 20 次，這裡量的是帳號，不是 IP（IP 的那一條另外測）。
 */
@SpringBootTest(properties = "shop.order.jobs-enabled=false")
@AutoConfigureMockMvc
class AuthApiTest {

    static final String DOMAIN = "@auth-test.example.com";
    static final AtomicInteger IP = new AtomicInteger();

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired StringRedisTemplate redis;

    @BeforeEach
    @AfterEach
    void cleanup() {
        jdbc.update("DELETE a FROM audit_logs a JOIN users u ON a.actor_id = u.id OR (a.target_type = 'USER' AND a.target_id = u.id) WHERE u.email LIKE ?", "%" + DOMAIN);
        jdbc.update("DELETE FROM audit_logs WHERE action = 'LOGIN_LOCKED' AND JSON_UNQUOTE(detail->'$.email') LIKE ?", "%" + DOMAIN);
        jdbc.update("DELETE t FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE u.email LIKE ?", "%" + DOMAIN);
        jdbc.update("DELETE r FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.email LIKE ?", "%" + DOMAIN);
        jdbc.update("DELETE FROM users WHERE email LIKE ?", "%" + DOMAIN);
        Set<String> keys = redis.keys("login:fail:*" + DOMAIN);
        if (keys != null && !keys.isEmpty()) redis.delete(keys);
    }

    static MockHttpServletRequestBuilder from(MockHttpServletRequestBuilder b, String ip) {
        return b.with(r -> { r.setRemoteAddr(ip); return r; }).contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
    }

    static MockHttpServletRequestBuilder json(MockHttpServletRequestBuilder b) { return from(b, "192.0.2." + (IP.incrementAndGet() % 250)); }

    JsonNode body(ResultActions r) throws Exception {
        return json.readTree(r.andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    ResultActions register(String email, String password) throws Exception {
        return mvc.perform(json(post("/api/auth/register")).content("""
                {"email": "%s", "password": "%s", "displayName": "測試"}""".formatted(email, password)));
    }

    ResultActions login(String email, String password) throws Exception {
        return mvc.perform(json(post("/api/auth/login")).content("""
                {"email": "%s", "password": "%s"}""".formatted(email, password)));
    }

    ResultActions refresh(String token) throws Exception {
        return mvc.perform(json(post("/api/auth/refresh")).content("{\"refreshToken\": \"" + token + "\"}"));
    }

    JsonNode tokens(String email, String password) throws Exception {
        return body(login(email, password).andExpect(status().isOk()));
    }

    JsonNode claims(String jwt) throws Exception {
        return json.readTree(Base64.getUrlDecoder().decode(jwt.split("\\.")[1]));
    }

    long userId(String email) { return jdbc.queryForObject("SELECT id FROM users WHERE email = ?", Long.class, email); }

    // ───────── US-ACC-1 註冊 ─────────

    @Test @DisplayName("ACC-1 AC-1：201、角色 BUYER、BCrypt cost 10、資料庫查不到明文；AC-4：請求裡的 role 被忽略")
    void register() throws Exception {
        String email = "alice" + DOMAIN;
        JsonNode me = body(mvc.perform(json(post("/api/auth/register")).content("""
                {"email": "Alice%s", "password": "correct-horse-battery", "displayName": "Alice", "role": "ADMIN", "roles": ["ADMIN"]}""".formatted(DOMAIN)))
                .andExpect(status().isCreated()));
        assertThat(me.get("email").asText()).isEqualTo(email);                    // 存的是正規形
        assertThat(me.get("roles").toString()).isEqualTo("[\"BUYER\"]");
        String hash = jdbc.queryForObject("SELECT password_hash FROM users WHERE email = ?", String.class, email);
        assertThat(hash).startsWith("$2a$10$").doesNotContain("correct-horse-battery");
        assertThat(jdbc.queryForList("SELECT role FROM user_roles WHERE user_id = ?", String.class, userId(email))).containsExactly("BUYER");
    }

    @Test @DisplayName("ACC-1 AC-2：同一個 email（大小寫、重音、全形都算同一個）→ 409，訊息不說「已被使用」")
    void duplicateEmail() throws Exception {
        register("bob" + DOMAIN, "correct-horse-battery").andExpect(status().isCreated());
        for (String variant : List.of("BOB" + DOMAIN, "bób" + DOMAIN, "ｂｏｂ" + DOMAIN))
            register(variant, "correct-horse-battery").andExpect(status().isConflict())
                    .andExpect(jsonPath("$.type").value("/problems/email-unavailable"))
                    .andExpect(jsonPath("$.detail").value("無法以此 email 註冊"));
    }

    @Test @DisplayName("ACC-1 AC-3：密碼 7 個字元、或超過 72 bytes → 400，errors[0].field = password；24 個中文字（72 bytes）可以")
    void passwordLength() throws Exception {
        register("carol" + DOMAIN, "1234567").andExpect(status().isBadRequest()).andExpect(jsonPath("$.errors[0].field").value("password"));
        register("carol" + DOMAIN, "密".repeat(25)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.errors[0].field").value("password"));
        register("carol" + DOMAIN, "a".repeat(73)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.errors[0].field").value("password"));
        register("carol" + DOMAIN, "密".repeat(24)).andExpect(status().isCreated());
    }

    // ───────── US-ACC-2 登入 ─────────

    @Test @DisplayName("ACC-2 AC-1：access token 是 15 分鐘的 JWT；refresh token 在資料庫只存 SHA-256")
    void loginIssuesTokens() throws Exception {
        String email = "dave" + DOMAIN;
        register(email, "correct-horse-battery");
        JsonNode t = tokens("DAVE" + DOMAIN, "correct-horse-battery");             // 登入的 email 也會正規化
        JsonNode c = claims(t.get("accessToken").asText());
        assertThat(c.get("exp").asLong() - c.get("iat").asLong()).isEqualTo(900);
        assertThat(c.get("sub").asText()).isEqualTo(String.valueOf(userId(email)));
        assertThat(c.get("roles").toString()).isEqualTo("[\"BUYER\"]");
        assertThat(t.get("expiresIn").asLong()).isEqualTo(900);
        String raw = t.get("refreshToken").asText();
        List<String> stored = jdbc.queryForList("SELECT token_hash FROM refresh_tokens WHERE user_id = ?", String.class, userId(email));
        assertThat(stored).hasSize(1).doesNotContain(raw);
        assertThat(stored.get(0)).hasSize(64);
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + t.get("accessToken").asText()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.email").value(email));
    }

    @Test @DisplayName("ACC-2 AC-2：密碼錯誤與帳號不存在 → 一模一樣的 401，回應時間差 < 50 ms")
    void noAccountEnumeration() throws Exception {
        register("erin" + DOMAIN, "correct-horse-battery");
        String wrong = login("erin" + DOMAIN, "wrong-password").andExpect(status().isUnauthorized()).andReturn().getResponse().getContentAsString();
        String missing = login("nobody" + DOMAIN, "wrong-password").andExpect(status().isUnauthorized()).andReturn().getResponse().getContentAsString();
        assertThat(wrong).isEqualTo(missing);
        long[] a = new long[9], b = new long[9];
        for (int i = 0; i < 9; i++) {
            if (i % 4 == 0) cleanupLock("erin" + DOMAIN);                       // 量的是比對密碼，不是鎖定
            long s = System.nanoTime(); login("erin" + DOMAIN, "wrong-" + i); a[i] = System.nanoTime() - s;
            s = System.nanoTime(); login("nobody-" + i + DOMAIN, "wrong-" + i); b[i] = System.nanoTime() - s;
        }
        Arrays.sort(a);
        Arrays.sort(b);
        double diff = Math.abs(a[4] - b[4]) / 1e6;
        System.out.printf("ACC-2 AC-2：密碼錯誤 p50 %.1f ms、帳號不存在 p50 %.1f ms、差 %.1f ms%n", a[4] / 1e6, b[4] / 1e6, diff);
        assertThat(diff).isLessThan(50);
    }

    void cleanupLock(String email) { redis.delete("login:fail:" + email); }

    @Test @DisplayName("ACC-2 AC-3：連續失敗 5 次 → 第 6 次即使密碼正確也 429，Retry-After = 剩餘的鎖定秒數；稽核 LOGIN_LOCKED")
    void lockout() throws Exception {
        String email = "frank" + DOMAIN;
        register(email, "correct-horse-battery");
        for (int i = 0; i < 5; i++) login(email, "wrong-" + i).andExpect(status().isUnauthorized());
        String retryAfter = login(email, "correct-horse-battery").andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.type").value("/problems/rate-limited"))
                .andReturn().getResponse().getHeader("Retry-After");
        assertThat(Long.parseLong(retryAfter)).isBetween(890L, 900L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'LOGIN_LOCKED' AND actor_id = ?", Long.class, userId(email))).isEqualTo(1);
        login("FRANK" + DOMAIN, "correct-horse-battery").andExpect(status().isTooManyRequests());   // 大小寫不同，還是同一個計數器
    }

    @Test @DisplayName("0.6.5：同一個 IP 每分鐘 20 次，第 21 次 429（不管帳號是誰）")
    void perIpLimit() throws Exception {
        for (int i = 0; i < 20; i++)
            mvc.perform(from(post("/api/auth/login"), "198.51.100.77").content("{\"email\": \"ip-%d%s\", \"password\": \"x\"}".formatted(i, DOMAIN)))
                    .andExpect(status().isUnauthorized());
        mvc.perform(from(post("/api/auth/login"), "198.51.100.77").content("{\"email\": \"ip-21%s\", \"password\": \"x\"}".formatted(DOMAIN)))
                .andExpect(status().isTooManyRequests()).andExpect(header().exists("Retry-After"));
    }

    @Test @DisplayName("ACC-2 AC-4：refresh → 新的 access + refresh；舊的 refresh 立即失效")
    void rotation() throws Exception {
        register("grace" + DOMAIN, "correct-horse-battery");
        JsonNode first = tokens("grace" + DOMAIN, "correct-horse-battery");
        JsonNode second = body(refresh(first.get("refreshToken").asText()).andExpect(status().isOk()));
        assertThat(second.get("refreshToken").asText()).isNotEqualTo(first.get("refreshToken").asText());
        assertThat(second.get("accessToken").asText()).isNotEqualTo(first.get("accessToken").asText());
        body(refresh(second.get("refreshToken").asText()).andExpect(status().isOk()));        // 新的那個可以用
    }

    @Test @DisplayName("ACC-2 AC-5：用過的 refresh token 再用一次 → 401，並撤銷這個使用者全部的 refresh token；稽核 REFRESH_TOKEN_REUSED")
    void reuseDetection() throws Exception {
        String email = "heidi" + DOMAIN;
        register(email, "correct-horse-battery");
        JsonNode first = tokens(email, "correct-horse-battery");
        JsonNode other = tokens(email, "correct-horse-battery");                 // 另一台裝置
        JsonNode second = body(refresh(first.get("refreshToken").asText()).andExpect(status().isOk()));
        refresh(first.get("refreshToken").asText()).andExpect(status().isUnauthorized());     // 重放
        refresh(second.get("refreshToken").asText()).andExpect(status().isUnauthorized());    // 被撤銷了
        refresh(other.get("refreshToken").asText()).andExpect(status().isUnauthorized());     // 另一台也被撤銷
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", Long.class, userId(email))).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'REFRESH_TOKEN_REUSED' AND actor_id = ?", Long.class, userId(email))).isEqualTo(1);
    }

    // ───────── US-ACC-3 管理員 ─────────

    String adminToken() throws Exception {
        String email = "admin" + DOMAIN;
        register(email, "correct-horse-battery");
        jdbc.update("INSERT INTO user_roles (user_id, role) VALUES (?, 'ADMIN')", userId(email));          // 測試用的管理員
        return "Bearer " + tokens(email, "correct-horse-battery").get("accessToken").asText();
    }

    @Test @DisplayName("ACC-3 AC-1、AC-2：管理員授予 SELLER（稽核 ROLE_GRANTED）；非管理員 → 403；新角色在下一次 refresh 生效")
    void grantSeller() throws Exception {
        String admin = adminToken(), email = "ivan" + DOMAIN;
        register(email, "correct-horse-battery");
        JsonNode t = tokens(email, "correct-horse-battery");
        long id = userId(email);
        mvc.perform(json(post("/api/admin/users/" + id + "/roles")).header("Authorization", "Bearer " + t.get("accessToken").asText())
                .content("{\"role\": \"SELLER\"}")).andExpect(status().isForbidden()).andExpect(jsonPath("$.type").value("/problems/forbidden"));
        mvc.perform(json(post("/api/admin/users/" + id + "/roles")).header("Authorization", admin).content("{\"role\": \"SELLER\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.roles.length()").value(2));
        mvc.perform(json(post("/api/admin/users/" + id + "/roles")).header("Authorization", admin).content("{\"role\": \"ADMIN\"}"))
                .andExpect(status().isBadRequest());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'ROLE_GRANTED' AND target_id = ?", Long.class, String.valueOf(id))).isEqualTo(1);
        assertThat(claims(t.get("accessToken").asText()).get("roles").toString()).isEqualTo("[\"BUYER\"]");      // 舊的 token 還是舊的角色
        JsonNode refreshed = body(refresh(t.get("refreshToken").asText()).andExpect(status().isOk()));
        assertThat(claims(refreshed.get("accessToken").asText()).get("roles").toString()).isEqualTo("[\"BUYER\",\"SELLER\"]");
    }

    @Test @DisplayName("ACC-2 AC-6：停權 → refresh 立即 401；停權前拿到的 access token 在過期前仍然有效（明確寫下的妥協）")
    void suspend() throws Exception {
        String admin = adminToken(), email = "judy" + DOMAIN;
        register(email, "correct-horse-battery");
        JsonNode t = tokens(email, "correct-horse-battery");
        mvc.perform(json(post("/api/admin/users/" + userId(email) + "/suspend")).header("Authorization", admin)).andExpect(status().isOk());
        refresh(t.get("refreshToken").asText()).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + t.get("accessToken").asText())).andExpect(status().isOk());
        login(email, "correct-horse-battery").andExpect(status().isForbidden());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'USER_SUSPENDED' AND target_id = ?", Long.class, String.valueOf(userId(email)))).isEqualTo(1);
    }

    // ───────── US-AUD-1 ─────────

    @Test @DisplayName("AUD-1 AC-3：管理員依使用者、動作、時間區間查詢；AC-2：稽核內容不含密碼與 token")
    void auditQuery() throws Exception {
        String admin = adminToken(), email = "ken" + DOMAIN;
        register(email, "correct-horse-battery");
        Instant from = Instant.now().minusSeconds(60);
        JsonNode t = tokens(email, "correct-horse-battery");
        refresh(t.get("refreshToken").asText()).andExpect(status().isOk());
        refresh(t.get("refreshToken").asText()).andExpect(status().isUnauthorized());          // 重放 → 一筆 REFRESH_TOKEN_REUSED
        JsonNode page = body(mvc.perform(get("/api/admin/audit-logs").header("Authorization", admin)
                .param("actorId", String.valueOf(userId(email))).param("action", "REFRESH_TOKEN_REUSED")
                .param("from", from.toString()).param("to", Instant.now().plusSeconds(60).toString())).andExpect(status().isOk()));
        assertThat(page.get("totalElements").asLong()).isEqualTo(1);
        assertThat(page.get("content").get(0).get("ip").asText()).startsWith("192.0.2.");
        String all = jdbc.queryForList("SELECT CONCAT_WS('|', action, target_id, detail) FROM audit_logs", String.class).toString();
        assertThat(all).doesNotContain("correct-horse-battery").doesNotContain(t.get("refreshToken").asText()).doesNotContain(t.get("accessToken").asText());
        mvc.perform(get("/api/admin/audit-logs").header("Authorization", admin)
                .param("from", "2026-01-01T00:00:00Z").param("to", "2026-03-01T00:00:00Z")).andExpect(status().isBadRequest());   // 超過 31 天
    }
}
```

**`src/test/java/com/example/shop/api/JwtGuardTest.java`**

```java
package com.example.shop.api;

import com.example.shop.shared.config.ShopProperties;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.test.web.servlet.MockMvc;

import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 5.5.4 SecurityConfig 的 JwtDecoder 拒絕哪些 token。每一種都打 GET /api/orders，看狀態碼與 WWW-Authenticate。
 * 攻擊手法本身在 09-spring-security/05 的 5.2 實測過；這裡確認的是「本專題的設定」沒有放過其中任何一種。
 */
@SpringBootTest(properties = "shop.order.jobs-enabled=false")
@AutoConfigureMockMvc
class JwtGuardTest {

    @Autowired MockMvc mvc;
    @Autowired ShopProperties props;

    byte[] secret() { return props.security().jwtSecret().getBytes(StandardCharsets.UTF_8); }

    String sign(JWSAlgorithm alg, byte[] key, String issuer, Instant exp, List<String> roles) throws Exception {
        JWTClaimsSet.Builder c = new JWTClaimsSet.Builder().issuer(issuer).subject("1001").issueTime(Date.from(exp.minusSeconds(900)))
                .expirationTime(Date.from(exp));
        if (roles != null) c.claim("roles", roles);
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(alg).type(JOSEObjectType.JWT).build(), c.build());
        jwt.sign(new MACSigner(key));
        return jwt.serialize();
    }

    /** 同一把金鑰算 HMAC-SHA512。不用 Nimbus 的 MACSigner：它要求 HS512 的金鑰至少 64 bytes，本機的金鑰只有 38 bytes */
    String hs512SameKey(String payloadJson) throws Exception {
        String signingInput = b64("{\"alg\":\"HS512\",\"typ\":\"JWT\"}") + "." + b64(payloadJson);
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA512");
        mac.init(new SecretKeySpec(secret(), "HmacSHA512"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    String good(Instant exp) throws Exception { return sign(JWSAlgorithm.HS256, secret(), "shop", exp, List.of("BUYER")); }

    static String b64(String s) { return Base64.getUrlEncoder().withoutPadding().encodeToString(s.getBytes(StandardCharsets.UTF_8)); }

    String call(String token) throws Exception {
        var r = mvc.perform(get("/api/orders?size=1").header("Authorization", "Bearer " + token)).andReturn().getResponse();
        return r.getStatus() + (r.getHeader("WWW-Authenticate") == null ? "" : "  WWW-Authenticate: " + r.getHeader("WWW-Authenticate"));
    }

    @Test @DisplayName("只接受：HS256、本專題的金鑰、issuer = shop、還沒過期（容許 5 秒時鐘誤差）")
    void rejectsEverythingElse() throws Exception {
        Instant later = Instant.now().plusSeconds(600);
        String valid = good(later);
        String[] p = valid.split("\\.");
        String payload = new String(Base64.getUrlDecoder().decode(p[1]), StandardCharsets.UTF_8);
        Map<String, String> cases = new LinkedHashMap<>();
        cases.put("正常的 token", valid);
        cases.put("把 payload 的 BUYER 改成 ADMIN", p[0] + "." + b64(payload.replace("BUYER", "ADMIN")) + "." + p[2]);
        cases.put("alg: none、沒有簽章", b64("{\"alg\":\"none\"}") + "." + p[1] + ".");
        cases.put("另一把金鑰簽的", sign(JWSAlgorithm.HS256, "another-secret-another-secret-0123456789".getBytes(), "shop", later, List.of("BUYER")));
        cases.put("同一把金鑰、HS512", hs512SameKey(payload));
        cases.put("issuer 不是 shop", sign(JWSAlgorithm.HS256, secret(), "evil", later, List.of("BUYER")));
        cases.put("10 秒前過期", good(Instant.now().minusSeconds(10)));
        cases.put("3 秒前過期（在 5 秒的誤差內）", good(Instant.now().minusSeconds(3)));
        cases.put("沒有 roles", sign(JWSAlgorithm.HS256, secret(), "shop", later, null));
        cases.put("不是 JWT", "hello");
        Map<String, String> results = new LinkedHashMap<>();
        for (var e : cases.entrySet()) results.put(e.getKey(), call(e.getValue()));
        results.forEach((k, v) -> System.out.printf("  %-26s → %s%n", k, v));

        assertThat(results.get("正常的 token")).startsWith("200");
        assertThat(results.get("3 秒前過期（在 5 秒的誤差內）")).startsWith("200");
        assertThat(results.get("沒有 roles")).startsWith("403");
        results.entrySet().stream().filter(e -> !List.of("正常的 token", "3 秒前過期（在 5 秒的誤差內）", "沒有 roles").contains(e.getKey()))
                .forEach(e -> assertThat(e.getValue()).as(e.getKey()).isEqualTo("401  WWW-Authenticate: Bearer error=\"invalid_token\""));
    }

    @Test @DisplayName("5.5.4 對照：Spring Security 預設的驗證器（JwtValidators.createDefault）容許 60 秒的時鐘誤差")
    void defaultClockSkew() throws Exception {
        NimbusJwtDecoder defaults = NimbusJwtDecoder.withSecretKey(new SecretKeySpec(secret(), "HmacSHA256")).macAlgorithm(MacAlgorithm.HS256).build();
        for (int ago : new int[]{3, 10, 30, 59, 61, 90}) {
            String result;
            try { defaults.decode(good(Instant.now().minusSeconds(ago))); result = "接受"; }
            catch (JwtException e) { result = "拒絕"; }
            System.out.printf("  預設驗證器：%2d 秒前過期的 token → %s%n", ago, result);
        }
    }
}
```

**`src/test/java/com/example/shop/api/SecurityRouteCoverageTest.java`**

```java
package com.example.shop.api;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 5.5.5 每一支 API 都必須在 SecurityConfig 的表上（anyRequest().denyAll() 是保險，不是規則）。
 * 從 RequestMappingHandlerMapping 列出「實際存在」的每一支 API，各打兩次：
 *   ① 匿名      → 只有 PUBLIC 這張表上的可以不是 401
 *   ② 三個角色都有 → 沒有任何一支是 403（是 403 = 掉到了 denyAll：新增了 API 卻忘了加規則）
 * 這個測試不檢查業務結果（400、404 都可以），只檢查「安全那一層」有沒有答案。
 * ⚠️ 路徑變數一律代入「不存在」的值：第一版代入 1，結果 POST /api/admin/users/1/suspend 回 200 —— 種子資料的管理員被停權了。
 */
@SpringBootTest(properties = "shop.order.jobs-enabled=false")
@AutoConfigureMockMvc
class SecurityRouteCoverageTest {

    /** 0.8 的「公開」那幾列 */
    static final Set<String> PUBLIC = Set.of(
            "POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/refresh",
            "GET /api/products", "GET /api/products/{id}", "POST /api/payments/callback", "GET /api/ping");

    /** 不存在的使用者、商品 id */
    static final long NOBODY = 999_999_999L, ACTOR = 990_901;

    @Autowired MockMvc mvc;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired AccessTokens tokens;
    @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mappings;

    List<String> routes() {
        List<String> out = new ArrayList<>();
        mappings.getHandlerMethods().forEach((info, method) -> {
            if (!method.getBeanType().getPackageName().startsWith("com.example.shop")) return;     // springdoc 等等
            for (String path : info.getPatternValues())
                for (RequestMethod m : info.getMethodsCondition().getMethods()) out.add(m.name() + " " + path);
        });
        Collections.sort(out);
        return out;
    }

    int status(String route, String bearer) throws Exception {
        String[] p = route.split(" ", 2);
        String url = p[1].replace("{orderNo}", "19990101-000000").replaceAll("\\{[^}]+}", String.valueOf(NOBODY));
        var b = MockMvcRequestBuilders.request(p[0], java.net.URI.create(url)).contentType(MediaType.APPLICATION_JSON).content("{}");
        if (bearer != null) b.header("Authorization", bearer);
        return mvc.perform(b).andReturn().getResponse().getStatus();
    }

    @Test @DisplayName("匿名只碰得到 PUBLIC；三個角色都有的人，沒有任何一支 API 掉到 denyAll")
    void everyRouteHasARule() throws Exception {
        String all = TestTokens.bearer(tokens, ACTOR, Role.BUYER, Role.SELLER, Role.ADMIN);
        List<String> anonymousReachable = new ArrayList<>(), denied = new ArrayList<>();
        List<String> routes = routes();
        for (String r : routes) {
            int anon = status(r, null), full = status(r, all);
            System.out.printf("  %-48s 匿名 %d │ 三個角色 %d%n", r, anon, full);
            if (anon != 401) anonymousReachable.add(r);
            if (full == 403) denied.add(r);
        }
        System.out.printf("  共 %d 支 API；匿名可達 %d 支；掉到 denyAll %d 支%n", routes.size(), anonymousReachable.size(), denied.size());
        assertThat(anonymousReachable).as("匿名可達的 API 必須剛好是 PUBLIC").containsExactlyInAnyOrderElementsOf(PUBLIC);
        assertThat(denied).as("這些 API 沒有出現在 SecurityConfig 的表上").isEmpty();
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ?", ACTOR);
    }
}
```

**`src/test/java/com/example/shop/api/IdorMatrixTest.java`**

```java
package com.example.shop.api;

import com.example.shop.shared.security.AccessTokens;
import com.example.shop.shared.web.Role;
import com.example.shop.support.TestTokens;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * 5.8.2 越權矩陣（驗收 Q5 的完整版）：每一支「帶著資源 id」的 API，用「別人」的身分打一次。
 * 每一格都要：404、body 跟「不存在的 id」一模一樣、一筆 ACCESS_DENIED、資料沒有任何改變。
 * 最後一個測試確認：RequestMappingHandlerMapping 裡每一支帶路徑變數的 API，不是在矩陣裡，就是在 EXEMPT 裡（附理由）。
 */
@SpringBootTest(properties = "shop.order.jobs-enabled=false")
@AutoConfigureMockMvc
class IdorMatrixTest {

    static final long OWNER_BUYER = 990_701, OWNER_SELLER = 990_711, OTHER_BUYER = 990_702, OTHER_SELLER = 990_712, PRODUCT = 9_900_701;
    static final String GHOST_ORDER = "19990101-000000";
    static final long GHOST_PRODUCT = 999_999_999L;

    record Cell(String method, String path, String body, boolean seller) {}

    static final List<Cell> MATRIX = List.of(
            new Cell("GET", "/api/orders/{orderNo}", null, false),
            new Cell("POST", "/api/orders/{orderNo}/cancel", null, false),
            new Cell("POST", "/api/orders/{orderNo}/confirm-receipt", null, false),
            new Cell("POST", "/api/orders/{orderNo}/payments", null, false),
            new Cell("POST", "/api/seller/orders/{orderNo}/start-picking", null, true),
            new Cell("POST", "/api/seller/orders/{orderNo}/ship", "{\"carrier\": \"黑貓\", \"trackingNo\": \"T-1\"}", true),
            new Cell("POST", "/api/seller/orders/{orderNo}/cancel", null, true),
            new Cell("PATCH", "/api/seller/products/{id}", "{\"price\": 1}", true),
            new Cell("POST", "/api/seller/products/{id}/publish", null, true),
            new Cell("POST", "/api/seller/products/{id}/unpublish", null, true),
            new Cell("POST", "/api/seller/products/{id}/restock", "{\"quantity\": 1000}", true));

    /** 帶路徑變數、但「不是別人的資源」的 API */
    static final Map<String, String> EXEMPT = Map.of(
            "GET /api/products/{id}", "公開；沒有擁有者的概念（下架的商品對所有人都是 404，US-PRD-3）",
            "PATCH /api/cart/items/{productId}", "productId 指的是商品，購物車本身只有自己的那一台（WHERE buyer_id = 自己）",
            "DELETE /api/cart/items/{productId}", "同上",
            "POST /api/admin/users/{id}/roles", "管理員對任何帳號都可以操作（0.3.2），不是資料層級的權限",
            "POST /api/admin/users/{id}/suspend", "同上");

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired AccessTokens tokens;
    @Autowired ObjectMapper json;
    @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mappings;

    String orderNo;

    @BeforeEach
    void setUp() throws Exception {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '矩陣商品', 100.00, 'ON_SALE')", PRODUCT, OWNER_SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'idor')", PRODUCT);
        String body = mvc.perform(MockMvcRequestBuilders.post("/api/orders").header("Authorization", TestTokens.bearer(tokens, OWNER_BUYER))
                        .header("Idempotency-Key", "idor-" + System.nanoTime()).contentType(MediaType.APPLICATION_JSON)
                        .content("{\"items\": [{\"productId\": %d, \"quantity\": 1, \"unitPrice\": 100}]}".formatted(PRODUCT)))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        orderNo = json.readTree(body).get("orderNo").asText();
    }

    @AfterEach
    void cleanup() throws InterruptedException {
        Thread.sleep(200);                                                     // 背景的 ACCESS_DENIED（5.8.3）
        jdbc.update("DELETE FROM audit_logs WHERE actor_id IN (?, ?, ?, ?)", OWNER_BUYER, OWNER_SELLER, OTHER_BUYER, OTHER_SELLER);
        jdbc.update("DELETE p FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", OWNER_BUYER);
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", OWNER_BUYER);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", OWNER_BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", OWNER_BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", OWNER_BUYER);
        jdbc.update("DELETE FROM cart_items WHERE buyer_id = ?", OWNER_BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
    }

    MockHttpServletResponse call(Cell c, String id, long actor) throws Exception {
        String url = c.path().replace("{orderNo}", id).replace("{id}", id);
        var b = MockMvcRequestBuilders.request(c.method(), java.net.URI.create(url))
                .header("Authorization", TestTokens.bearer(tokens, actor, c.seller() ? Role.SELLER : Role.BUYER))
                .contentType(MediaType.APPLICATION_JSON).characterEncoding(StandardCharsets.UTF_8);
        if (c.body() != null) b.content(c.body());
        return mvc.perform(b).andReturn().getResponse();
    }

    String snapshot() {
        return jdbc.queryForMap("""
                SELECT (SELECT status FROM orders WHERE order_no = ?) AS order_status,
                       (SELECT COUNT(*) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.order_no = ?) AS payments,
                       (SELECT CONCAT(price, '/', status) FROM products WHERE id = ?) AS product,
                       (SELECT CONCAT(on_hand, '/', reserved) FROM inventory WHERE product_id = ?) AS inventory""",
                orderNo, orderNo, PRODUCT, PRODUCT).toString();
    }

    long denied(long actor) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'ACCESS_DENIED' AND actor_id = ?", Long.class, actor);
    }

    @Test @DisplayName("Q5 的完整版：11 支帶資源 id 的 API × 別人的身分 → 404（跟不存在一模一樣）+ ACCESS_DENIED，資料不變")
    void everyCellIs404AndAudited() throws Exception {
        String before = snapshot();
        for (Cell c : MATRIX) {
            long attacker = c.seller() ? OTHER_SELLER : OTHER_BUYER;
            String real = c.path().contains("{orderNo}") ? orderNo : String.valueOf(PRODUCT);
            String ghost = c.path().contains("{orderNo}") ? GHOST_ORDER : String.valueOf(GHOST_PRODUCT);
            long auditsBefore = denied(attacker);
            MockHttpServletResponse theirs = call(c, real, attacker), none = call(c, ghost, attacker);
            String a = theirs.getContentAsString(StandardCharsets.UTF_8).replace(real, "{id}"), b = none.getContentAsString(StandardCharsets.UTF_8).replace(ghost, "{id}");
            await().atMost(Duration.ofSeconds(2)).until(() -> denied(attacker) == auditsBefore + 1);
            System.out.printf("  %-6s %-45s 別人的 %d │ 不存在的 %d │ body 相同 %-5s │ ACCESS_DENIED +%d%n",
                    c.method(), c.path(), theirs.getStatus(), none.getStatus(), a.equals(b), denied(attacker) - auditsBefore);
            assertThat(theirs.getStatus()).as(c.path()).isEqualTo(404);
            assertThat(a).as(c.path() + " 的 body").isEqualTo(b);
        }
        String after = snapshot();
        System.out.println("  資料：之前 " + before + "\n        之後 " + after);
        assertThat(after).isEqualTo(before);
    }

    @Test @DisplayName("每一支帶路徑變數的 API，不是在矩陣裡，就是在 EXEMPT 裡")
    void matrixCoversEveryRoute() {
        Set<String> withVariables = new TreeSet<>();
        mappings.getHandlerMethods().forEach((info, m) -> {
            if (!m.getBeanType().getPackageName().startsWith("com.example.shop")) return;
            for (String p : info.getPatternValues())
                if (p.contains("{")) for (RequestMethod rm : info.getMethodsCondition().getMethods()) withVariables.add(rm.name() + " " + p);
        });
        Set<String> covered = new TreeSet<>(EXEMPT.keySet());
        MATRIX.forEach(c -> covered.add(c.method() + " " + c.path()));
        System.out.printf("  帶路徑變數的 API %d 支：矩陣 %d、豁免 %d%n", withVariables.size(), MATRIX.size(), EXEMPT.size());
        assertThat(withVariables).as("新增了帶 id 的 API？把它加進 MATRIX，或者在 EXEMPT 寫下理由").isEqualTo(covered);
    }
}
```

**`src/test/java/com/example/shop/ordering/internal/AuditPlacementTest.java`**

```java
package com.example.shop.ordering.internal;

import com.example.shop.ordering.OrderingApi;
import com.example.shop.payment.PaymentApi;
import com.example.shop.payment.internal.CallbackSignature;
import com.example.shop.shared.config.ShopProperties;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 5.2.5 / 5.9 US-AUD-1 AC-1：稽核跟「誰的交易」走。
 *  - 被拒絕的動作（簽章錯、金額不符、越權）：業務交易會 rollback，稽核必須留下來
 *  - 業務動作（賣家取消）：業務 rollback（例如已經出貨，409），稽核必須一起消失
 * 每一個測試都檢查兩件事：回應是什麼，以及 audit_logs 裡「剛好」有幾筆。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "shop.order.jobs-enabled=false")
class AuditPlacementTest {

    static final long BUYER = 990_501, OTHER_BUYER = 990_502, SELLER = 2, PRODUCT = 9_900_501;

    @Autowired OrderingApi ordering;
    @Autowired OrderCommands commands;
    @Autowired OrderQueryService queries;
    @Autowired PaymentCallbackService callbacks;
    @Autowired JdbcTemplate jdbc;
    @Autowired ShopProperties props;

    @BeforeEach
    void setUp() {
        cleanup();
        jdbc.update("INSERT INTO products (id, seller_id, category_id, name, price, status) VALUES (?, ?, 11, '稽核測試', 100.00, 'ON_SALE')", PRODUCT, SELLER);
        jdbc.update("INSERT INTO inventory (product_id, on_hand, reserved) VALUES (?, 10, 0)", PRODUCT);
        jdbc.update("INSERT INTO inventory_ledger (product_id, delta_on_hand, delta_reserved, reason, ref) VALUES (?, 10, 0, 'INITIAL', 'audit')", PRODUCT);
    }

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE a FROM audit_logs a JOIN payments p ON a.target_type = 'PAYMENT' AND a.target_id = p.id JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE a FROM audit_logs a JOIN orders o ON a.target_type = 'ORDER' AND a.target_id = o.order_no WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM audit_logs WHERE actor_id = ? AND action = 'ACCESS_DENIED'", OTHER_BUYER);
        jdbc.update("DELETE f FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE p FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE h FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE i FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM idempotency_keys WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM orders WHERE buyer_id = ?", BUYER);
        jdbc.update("DELETE FROM inventory_reservations WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory_ledger WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM inventory WHERE product_id = ?", PRODUCT);
        jdbc.update("DELETE FROM products WHERE id = ?", PRODUCT);
    }

    String place() {
        return ordering.placeOrder(BUYER, "audit-" + System.nanoTime(), List.of(new OrderingApi.OrderLine(PRODUCT, 1, new BigDecimal("100")))).orderNo();
    }

    void callback(long pid, String amount, boolean goodSignature) {
        BigDecimal a = new BigDecimal(amount);
        String sig = goodSignature ? CallbackSignature.sign(props.payment().callbackSecret(), CallbackSignature.canonical(pid, "txn-" + pid, a, true)) : "0".repeat(64);
        callbacks.handle(new PaymentApi.Callback(pid, "txn-" + pid, a, true, sig));
    }

    long audits(String action, String targetId) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = ? AND target_id = ?", Long.class, action, targetId);
    }

    static ProblemType typeOf(Throwable e) { return ((ShopException) e).type(); }

    @Test @DisplayName("ORD-2 AC-3：簽章錯誤 → 401，而且 audit_logs 有一筆 PAYMENT_SIGNATURE_INVALID")
    void badSignature() {
        long pid = commands.startPayment(BUYER, place()).paymentId();
        assertThatThrownBy(() -> callback(pid, "100.00", false)).satisfies(e -> assertThat(typeOf(e)).isEqualTo(ProblemType.UNAUTHENTICATED));
        long n = audits("PAYMENT_SIGNATURE_INVALID", String.valueOf(pid));
        System.out.println("AUD：簽章錯誤 → 401；PAYMENT_SIGNATURE_INVALID " + n + " 筆");
        assertThat(n).isEqualTo(1);
    }

    @Test @DisplayName("ORD-2 AC-4：金額不符 → 400，而且 audit_logs 有一筆 PAYMENT_AMOUNT_MISMATCH")
    void amountMismatch() {
        long pid = commands.startPayment(BUYER, place()).paymentId();
        assertThatThrownBy(() -> callback(pid, "1.00", true)).satisfies(e -> assertThat(typeOf(e)).isEqualTo(ProblemType.VALIDATION));
        long n = audits("PAYMENT_AMOUNT_MISMATCH", String.valueOf(pid));
        System.out.println("AUD：金額不符 → 400；PAYMENT_AMOUNT_MISMATCH " + n + " 筆");
        assertThat(n).isEqualTo(1);
    }

    @Test @DisplayName("ORD-6 AC-5：賣家取消已付款的訂單 → 成功，audit_logs 一筆")
    void sellerCancelPaid() {
        String no = place();
        callback(commands.startPayment(BUYER, no).paymentId(), "100.00", true);
        commands.cancelBySeller(SELLER, no);
        long n = audits("ORDER_CANCELLED_BY_SELLER", no);
        System.out.println("AUD：賣家取消 PAID → 成功；ORDER_CANCELLED_BY_SELLER " + n + " 筆");
        assertThat(n).isEqualTo(1);
    }

    @Test @DisplayName("賣家取消已出貨的訂單 → 409，audit_logs 不可以有「已取消」")
    void sellerCancelShipped() {
        String no = place();
        callback(commands.startPayment(BUYER, no).paymentId(), "100.00", true);
        commands.startPicking(SELLER, no);
        commands.ship(SELLER, no, "黑貓", "T-1");
        assertThatThrownBy(() -> commands.cancelBySeller(SELLER, no)).satisfies(e -> assertThat(typeOf(e)).isEqualTo(ProblemType.INVALID_STATE));
        long n = audits("ORDER_CANCELLED_BY_SELLER", no);
        System.out.println("AUD：賣家取消 SHIPPED → 409；ORDER_CANCELLED_BY_SELLER " + n + " 筆（訂單狀態 "
                + jdbc.queryForObject("SELECT status FROM orders WHERE order_no = ?", String.class, no) + "）");
        assertThat(n).isZero();
    }

    @Test @DisplayName("ORD-5 AC-3：別人的訂單 → 404 + ACCESS_DENIED；不存在的訂單 → 404，沒有稽核")
    void accessDenied() {
        String no = place();
        assertThatThrownBy(() -> queries.buyerOrder(OTHER_BUYER, no)).satisfies(e -> assertThat(typeOf(e)).isEqualTo(ProblemType.NOT_FOUND));
        assertThatThrownBy(() -> commands.cancelByBuyer(OTHER_BUYER, no)).satisfies(e -> assertThat(typeOf(e)).isEqualTo(ProblemType.NOT_FOUND));
        assertThatThrownBy(() -> queries.buyerOrder(OTHER_BUYER, "19990101-000000")).satisfies(e -> assertThat(typeOf(e)).isEqualTo(ProblemType.NOT_FOUND));
        // ACCESS_DENIED 在背景寫（recordRejectionLater，5.8.3）：等它出現，最多 2 秒
        await().atMost(Duration.ofSeconds(2)).until(() -> audits("ACCESS_DENIED", no) == 2);
        long n = audits("ACCESS_DENIED", no), ghost = audits("ACCESS_DENIED", "19990101-000000");
        System.out.println("AUD：別人的訂單（查詢 + 取消）→ 404；ACCESS_DENIED " + n + " 筆；不存在的訂單 → 404；ACCESS_DENIED " + ghost + " 筆");
        assertThat(n).isEqualTo(2);
        assertThat(ghost).isZero();
        assertThat(jdbc.queryForObject("SELECT actor_id FROM audit_logs WHERE action = 'ACCESS_DENIED' AND target_id = ? LIMIT 1", Long.class, no))
                .isEqualTo(OTHER_BUYER);
    }
}
```

**`src/test/java/com/example/shop/shared/audit/internal/JdbcAuditLogTest.java`**

```java
package com.example.shop.shared.audit.internal;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** US-AUD-1 AC-2：detail 的鍵名裡有 password、token、secret…… → 寫不進去（5.9.2） */
class JdbcAuditLogTest {

    final JdbcAuditLog audit = new JdbcAuditLog(null, new ObjectMapper(), new SimpleMeterRegistry());

    @Test @DisplayName("AUD-1 AC-2：鍵名像秘密的 detail 一律拒絕，連「撤銷了幾個 refresh token」這種無害的也一樣")
    void secretLookingKeysAreRejected() {
        for (String key : new String[]{"password", "newPassword", "refreshToken", "Authorization", "jwtSecret", "cardNumber", "revokedRefreshTokens"})
            assertThatThrownBy(() -> audit.detail(Map.of(key, "x"))).as(key).isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining(key);
        assertThat(audit.detail(Map.of("revokedSessions", 3, "oldPrice", 299))).contains("revokedSessions");
    }
}
```

#### 實驗（`-Pexperiments`，5.2.0）

**`src/test/java/com/example/lab/ch05/TutorialSecurityConfig.java`**

```java
package com.example.lab.ch05;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

/**
 * 5.2.1 「照教學寫」的第一個 SecurityFilterChain：公開的路徑 permitAll，其他 authenticated()。
 * 看起來沒有問題 —— 它少了什麼，要打真的請求才看得出來。
 */
@Configuration
public class TutorialSecurityConfig {

    @Bean
    SecurityFilterChain tutorialChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/auth/**").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                        .requestMatchers("/api/payments/callback").permitAll()
                        .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults());
        return http.build();
    }
}
```

**`src/test/java/com/example/lab/ch05/Lab403OrderController.java`**

```java
package com.example.lab.ch05;

import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import com.example.shop.shared.web.CurrentUser;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 5.2.2 對照組：「存在但不是你的 → 403」。路徑放在 /api/orders/ 底下，才會套用到同一條 hasRole(BUYER) 的規則。
 * 只在 F2 實驗裡被當成額外的 source 註冊（com.example.lab 不在 ShopApplication 的 component scan 範圍內）。
 */
@RestController
public class Lab403OrderController {

    private final JdbcTemplate jdbc;

    public Lab403OrderController(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @GetMapping("/api/orders/lab403/{orderNo}")
    Map<String, Object> one(CurrentUser user, @PathVariable String orderNo) {
        List<Long> buyer = jdbc.queryForList("SELECT buyer_id FROM orders WHERE order_no = ?", Long.class, orderNo);
        if (buyer.isEmpty()) throw ShopException.notFound("訂單");
        if (buyer.get(0) != user.id()) throw new ShopException(ProblemType.FORBIDDEN, "這不是你的訂單");
        return Map.of("orderNo", orderNo);
    }
}
```

**`src/test/java/com/example/lab/ch05/TutorialSecurityConfigWithErrorPage.java`**

```java
package com.example.lab.ch05;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

/** 5.2.1 跟 TutorialSecurityConfig 只差一行：/error 也 permitAll —— 讓藏在 401 後面的真正原因露出來 */
@Configuration
public class TutorialSecurityConfigWithErrorPage {

    @Bean
    SecurityFilterChain tutorialChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/auth/**").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                        .requestMatchers("/api/payments/callback").permitAll()
                        .requestMatchers("/error").permitAll()                       // ← 只多這一行
                        .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults());
        return http.build();
    }
}
```

**`src/test/java/com/example/shop/ch05/F1SecurityStarterTest.java`**

```java
package com.example.shop.ch05;

import com.example.lab.ch05.TutorialSecurityConfig;
import com.example.shop.ShopApplication;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.TypeExcludeFilter;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.core.type.classreading.MetadataReader;
import org.springframework.core.type.classreading.MetadataReaderFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;

/**
 * 5.2.1 加上 spring-boot-starter-security 的那一刻：同一組請求，在三個階段各打一次。
 *   A. 只加依賴，沒有任何 SecurityFilterChain（Spring Boot 的預設）
 *   B. 第一個自己寫的 SecurityFilterChain（TutorialSecurityConfig，「照教學寫」）
 *   C. 本專題的 SecurityConfig（5.5）
 * A、B 用 TypeExcludeFilter 把本專題的 SecurityConfig 排除在 component scan 之外 —— 跟 @SpringBootTest 排除 @TestConfiguration 是同一個機制。
 */
@Tag("experiment")
class F1SecurityStarterTest {

    static final String SHOP_SECURITY = "com.example.shop.shared.security.SecurityConfig";

    record Probe(String label, HttpRequest.Builder request) {}

    static List<Probe> probes(int port) {
        String base = "http://localhost:" + port;
        String callback = "{\"paymentId\":1,\"providerTxnId\":\"t\",\"amount\":1,\"result\":\"SUCCEEDED\",\"signature\":\"x\"}";
        return List.of(
                new Probe("GET  /actuator/health/readiness", HttpRequest.newBuilder(URI.create(base + "/actuator/health/readiness"))),
                new Probe("GET  /api/products?size=1", HttpRequest.newBuilder(URI.create(base + "/api/products?size=1"))),
                new Probe("GET  /api/products/1", HttpRequest.newBuilder(URI.create(base + "/api/products/1"))),
                new Probe("GET  /api/orders（沒帶身分）", HttpRequest.newBuilder(URI.create(base + "/api/orders"))),
                new Probe("POST /api/payments/callback", HttpRequest.newBuilder(URI.create(base + "/api/payments/callback"))
                        .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(callback))),
                new Probe("POST /api/auth/login", HttpRequest.newBuilder(URI.create(base + "/api/auth/login"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString("{\"email\":\"buyer00001@example.com\",\"password\":\"password123\"}"))),
                new Probe("GET  /api/products?size=1（瀏覽器）", HttpRequest.newBuilder(URI.create(base + "/api/products?size=1"))
                        .header("Accept", "text/html")));
    }

    static void stage(String title, boolean excludeShopSecurity, Class<?>... extra) throws Exception {
        List<Class<?>> sources = new ArrayList<>(List.of(ShopApplication.class));
        sources.addAll(List.of(extra));
        SpringApplicationBuilder b = new SpringApplicationBuilder(sources.toArray(Class[]::new));
        if (excludeShopSecurity) b.initializers(ctx -> ctx.getBeanFactory().registerSingleton("f1Exclude", new TypeExcludeFilter() {
            @Override
            public boolean match(MetadataReader r, MetadataReaderFactory f) {
                return r.getClassMetadata().getClassName().startsWith(SHOP_SECURITY);
            }
            @Override public boolean equals(Object o) { return o == this; }
            @Override public int hashCode() { return System.identityHashCode(this); }
        }));
        try (var ctx = b.run("--server.port=0", "--shop.order.jobs-enabled=false", "--spring.main.banner-mode=off",
                "--logging.level.root=WARN", "--logging.level.org.springframework.security.web.csrf=DEBUG",
                "--logging.level.org.springframework.security.web.access.AccessDeniedHandlerImpl=DEBUG")) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            var jdbc = ctx.getBean(org.springframework.jdbc.core.JdbcTemplate.class);
            long auditMark = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM audit_logs", Long.class);
            long tokenMark = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM refresh_tokens", Long.class);
            HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
            System.out.println("═══ " + title + " ═══");
            for (Probe p : probes(port)) {
                HttpResponse<String> r = http.send(p.request().build(), HttpResponse.BodyHandlers.ofString());
                String body = r.body().isEmpty() ? "（空）" : r.body().substring(0, Math.min(110, r.body().length())).replace('\n', ' ');
                String extraHeaders = String.join(" ", r.headers().firstValue("WWW-Authenticate").map(v -> "WWW-Authenticate: " + v).orElse(""),
                        r.headers().firstValue("Location").map(v -> "Location: " + v.replaceAll("http://localhost:\\d+", "")).orElse(""),
                        r.headers().firstValue("Set-Cookie").map(v -> "Set-Cookie: " + v.substring(0, v.indexOf('='))).orElse("")).strip();
                System.out.printf("  %-36s %d  %-40s %s%n", p.label(), r.statusCode(), extraHeaders, body);
            }
            Thread.sleep(300);                                                  // C 階段：簽章錯誤的回呼留下一筆稽核、登入留下一個 refresh token
            jdbc.update("DELETE FROM audit_logs WHERE id > ?", auditMark);
            jdbc.update("DELETE FROM refresh_tokens WHERE id > ?", tokenMark);
        }
    }

    @Test
    void threeStages() throws Exception {
        stage("A：只加 spring-boot-starter-security", true);
        stage("B：第一個自己寫的 SecurityFilterChain（照教學寫）", true, TutorialSecurityConfig.class);
        stage("B'：同上，加一行 /error permitAll", true, com.example.lab.ch05.TutorialSecurityConfigWithErrorPage.class);
        if (classExists(SHOP_SECURITY)) stage("C：本專題的 SecurityConfig（5.5）", false);
    }

    static boolean classExists(String name) {
        try { Class.forName(name); return true; } catch (ClassNotFoundException e) { return false; }
    }
}
```

**`src/test/java/com/example/shop/ch05/F2OrderEnumerationTest.java`**

```java
package com.example.shop.ch05;

import com.example.lab.ch05.Lab403OrderController;
import com.example.shop.ShopApplication;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.*;
import java.util.concurrent.*;

/**
 * 5.2.2 訂單編號是「日期 + 隨機 6 碼」（2.4.4）。一個沒有任何訂單的買家，猜 20,000 個 2026-08-12 的編號：
 *   403 版（lab）：存在但不是你的 → 403、不存在 → 404
 *   本專題    ：兩種都是 404（US-ORD-5 AC-3），存在的那些另外寫一筆 ACCESS_DENIED
 */
@Tag("experiment")
class F2OrderEnumerationTest {

    static final long ATTACKER = 990_601;
    static final String DAY = "20260812";
    static final int GUESSES = 20_000;

    @Test
    void guessTwentyThousandOrderNumbers() throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class, Lab403OrderController.class).run("--server.port=0",
                "--shop.order.jobs-enabled=false", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            jdbc.update("DELETE FROM audit_logs WHERE actor_id = ?", ATTACKER);
            long actual = jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE order_no LIKE ?", Long.class, DAY + "-%");

            Random r = new Random(42);
            Set<String> guesses = new LinkedHashSet<>();
            while (guesses.size() < GUESSES) guesses.add(DAY + "-%06d".formatted(r.nextInt(1_000_000)));
            String bearer = TestTokens.bearer(ctx, ATTACKER);
            HttpClient http = HttpClient.newBuilder().executor(Executors.newFixedThreadPool(16)).build();

            System.out.printf("═══ 5.2.2 猜 %,d 個 %s 的訂單編號（那一天實際有 %,d 張訂單；16 個並行）═══%n", GUESSES, DAY, actual);
            for (String path : List.of("/api/orders/lab403/", "/api/orders/")) {
                ExecutorService pool = Executors.newFixedThreadPool(16);
                ConcurrentHashMap<Integer, Integer> statuses = new ConcurrentHashMap<>();
                ConcurrentHashMap<Integer, Set<Integer>> bodyLengths = new ConcurrentHashMap<>();
                long start = System.nanoTime();
                List<Future<?>> fs = new ArrayList<>();
                for (String no : guesses) fs.add(pool.submit(() -> {
                    HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path + no))
                            .header("Authorization", bearer).build(), HttpResponse.BodyHandlers.ofString());
                    statuses.merge(res.statusCode(), 1, Integer::sum);
                    bodyLengths.computeIfAbsent(res.statusCode(), k -> ConcurrentHashMap.newKeySet())
                            .add(res.body().replace(no, "").length());           // 去掉 instance 裡的編號之後，body 有幾種長度
                    return null;
                }));
                for (var f : fs) f.get();
                pool.shutdown();
                double secs = (System.nanoTime() - start) / 1e9;
                int forbidden = statuses.getOrDefault(403, 0);
                System.out.printf("  %-22s %.1f 秒 │ 狀態 %s │ body 長度（去掉編號）%s%n", path + "{no}", secs, new TreeMap<>(statuses), new TreeMap<>(bodyLengths));
                if (forbidden > 0)
                    System.out.printf("  %-22s → 攻擊者的估計：%d / %,d × 1,000,000 ≈ 每天 %,.0f 張（實際 %,d）%n", "", forbidden, GUESSES,
                            forbidden * 1_000_000.0 / GUESSES, actual);
            }
            long denied = jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE actor_id = ? AND action = 'ACCESS_DENIED'", Long.class, ATTACKER);
            List<Map<String, Object>> perMinute = jdbc.queryForList("""
                    SELECT DATE_FORMAT(created_at, '%H:%i') AS minute, COUNT(*) AS n FROM audit_logs
                     WHERE actor_id = ? AND action = 'ACCESS_DENIED' GROUP BY minute ORDER BY minute""", ATTACKER);
            System.out.printf("  audit_logs：ACCESS_DENIED %d 筆（actor_id = %d）；每分鐘 %s%n", denied, ATTACKER, perMinute);
            jdbc.update("DELETE FROM audit_logs WHERE actor_id = ?", ATTACKER);
        }
    }
}
```

**`src/test/java/com/example/shop/account/internal/F3LoginAttacksTest.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.ShopApplication;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 5.2.3 登入的三個洞。每一個都拿「照直覺寫」的版本（naive*）跟正式的 LoginService 比：
 *   ① 回應時間洩漏帳號是否存在（US-ACC-2 AC-2）
 *   ② email 的「變體」各自有一個鎖定計數器（AC-3）
 *   ③ 50 個並行請求同時通過「失敗幾次了？」的檢查（AC-3）
 * 放在 account.internal：要直接呼叫 package-private 的 LoginService、Accounts（跟 E5、E6 放在 ordering.internal 同一個理由）。
 * 每一次正式版的登入都帶不同的 IP（203.0.113.x）：這裡量的是「帳號鎖定」，不是 IpLoginLimiter（每 IP 每分鐘 20 次）。
 */
@Tag("experiment")
class F3LoginAttacksTest {

    static final String VICTIM = "f3victim@example.com", PASSWORD = "the-real-password-123";

    enum Result { OK, WRONG, LOCKED }

    record Ctx(ConfigurableApplicationContext app, LoginService login, Accounts accounts, PasswordEncoder encoder,
               StringRedisTemplate redis, JdbcTemplate jdbc, AtomicInteger ip, long auditMark) {
        String nextIp() { return "203.0.113." + (ip.incrementAndGet() % 250) + "." + ip.get(); }
    }

    static Ctx start() {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=WARN", "--shop.order.jobs-enabled=false");
        JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
        Ctx c = new Ctx(app, app.getBean(LoginService.class), app.getBean(Accounts.class), app.getBean(PasswordEncoder.class),
                app.getBean(StringRedisTemplate.class), jdbc, new AtomicInteger(),
                jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM audit_logs", Long.class));
        cleanup(c);
        c.app.getBean(AccountService.class).register(new AuthDtos.RegisterRequest(VICTIM, PASSWORD, "F3 受害者"));
        return c;
    }

    static void cleanup(Ctx c) {
        c.jdbc.update("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ?)", VICTIM);
        c.jdbc.update("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ?)", VICTIM);
        c.jdbc.update("DELETE FROM audit_logs WHERE id > ? AND action = 'LOGIN_LOCKED'", c.auditMark());   // 這個實驗自己鎖出來的（含變體）
        c.jdbc.update("DELETE FROM users WHERE email = ?", VICTIM);
        resetRedis(c);
    }

    static void resetRedis(Ctx c) {
        Set<String> keys = c.redis.keys("login:fail:*");
        if (keys != null && !keys.isEmpty()) c.redis.delete(keys);
        Set<String> naive = c.redis.keys("naive:fail:*");
        if (naive != null && !naive.isEmpty()) c.redis.delete(naive);
    }

    // ───────── 「照直覺寫」的版本 ─────────

    /** 帳號不存在 → 直接回 401（「省一次 BCrypt」） */
    static Result naiveTiming(Ctx c, String email, String password) {
        Optional<String> hash = c.jdbc.queryForList("SELECT password_hash FROM users WHERE email = ?", String.class, email).stream().findFirst();
        if (hash.isEmpty()) return Result.WRONG;
        return c.encoder.matches(password, hash.get()) ? Result.OK : Result.WRONG;
    }

    /**
     * 先查「失敗幾次了」，沒超過才驗密碼，失敗再 +1。key 用 Java 的 toLowerCase；查使用者用 WHERE email = ?（欄位的 ai_ci 定序）。
     * @param guesses 每一次「真的拿受害者的雜湊去比對」就 +1 —— 這才是攻擊者得到的東西
     */
    static Result naiveLockout(Ctx c, String email, String password, AtomicInteger guesses) {
        String key = "naive:fail:" + email.toLowerCase(Locale.ROOT);
        String n = c.redis.opsForValue().get(key);
        if (n != null && Integer.parseInt(n) >= 5) return Result.LOCKED;
        Optional<String> hash = c.jdbc.queryForList("SELECT password_hash FROM users WHERE email = ?", String.class, email).stream().findFirst();
        if (hash.isPresent()) guesses.incrementAndGet();
        if (hash.isPresent() && c.encoder.matches(password, hash.get())) return Result.OK;
        if (hash.isEmpty()) c.encoder.matches(password, "$2a$10$.Qqx4uLp33ami.WRNP./QedMLbVyOPUqXUuwqU7cbdiY9zOafkQQO");
        c.redis.opsForValue().increment(key);
        c.redis.expire(key, java.time.Duration.ofMinutes(15));
        return Result.WRONG;
    }

    /** 正式版。guesses 用「Accounts 找到的是不是受害者」來數 —— 找不到人的變體，連比對的機會都沒有 */
    static Result ours(Ctx c, String email, String password, AtomicInteger guesses) {
        try {
            c.login.login(email, password, c.nextIp());
            return Result.OK;
        } catch (ShopException e) {
            if (e.type() == ProblemType.RATE_LIMITED) return Result.LOCKED;
            if (c.accounts.findByEmail(Email.normalize(email)).isPresent()) guesses.incrementAndGet();
            return Result.WRONG;
        }
    }

    // ───────── ① 回應時間 ─────────

    @Test
    void timing() throws Exception {
        Ctx c = start();
        try {
            System.out.println("═══ 5.2.3 ① 登入的回應時間（各 100 次，依序；密碼都是錯的）═══");
            for (String impl : List.of("naive", "ours")) {
                for (int warm = 0; warm < 20; warm++) call(c, impl, "nobody-" + warm + "@example.com");
                double[] missing = measure(c, impl, i -> "nobody-" + i + "@example.com");
                resetRedis(c);
                double[] wrong = new double[100];
                for (int i = 0; i < 100; i++) {                               // 每 4 次清一次計數：量的是比對密碼，不是鎖定
                    if (i % 4 == 0) resetRedis(c);
                    long s = System.nanoTime(); call(c, impl, VICTIM); wrong[i] = (System.nanoTime() - s) / 1e6;
                }
                Arrays.sort(wrong);
                System.out.printf("  %-6s 帳號不存在 p50 %6.2f ms  p95 %6.2f ms │ 密碼錯誤 p50 %6.2f ms  p95 %6.2f ms │ 差 %6.2f ms%n",
                        impl, missing[50], missing[95], wrong[50], wrong[95], wrong[50] - missing[50]);
                resetRedis(c);
            }
        } finally { cleanup(c); c.app.close(); }
    }

    static void call(Ctx c, String impl, String email) {
        if (impl.equals("naive")) naiveTiming(c, email, "wrong-password-0000");
        else ours(c, email, "wrong-password-0000", new AtomicInteger());
    }

    static double[] measure(Ctx c, String impl, java.util.function.IntFunction<String> email) {
        double[] t = new double[100];
        for (int i = 0; i < 100; i++) { long s = System.nanoTime(); call(c, impl, email.apply(i)); t[i] = (System.nanoTime() - s) / 1e6; }
        Arrays.sort(t);
        return t;
    }

    // ───────── ② 變體 ─────────

    static List<String> variants() {
        List<String> v = new ArrayList<>();
        v.addAll(List.of("F3victim@example.com", "f3Victim@example.com", "f3vIctim@example.com", "f3viCtim@example.com", "f3vicTim@example.com",
                "f3victIm@example.com", "f3victiM@example.com", "F3VICTIM@example.com", "f3victim@Example.com", "f3victim@EXAMPLE.COM"));
        v.addAll(List.of("f3víctim@example.com", "f3vìctim@example.com", "f3vîctim@example.com", "f3vïctim@example.com", "f3victím@example.com",
                "f3victim@éxample.com", "f3victim@èxample.com", "f3victim@exámple.com", "f3victim@exâmple.com", "f3viçtim@example.com"));
        v.addAll(List.of("ｆ3victim@example.com", "f3ｖictim@example.com", "f3vｉctim@example.com", "f3viｃtim@example.com", "f3vicｔim@example.com",
                "f3victｉm@example.com", "f3victiｍ@example.com", "f3victim@ｅxample.com", "f3victim@example.ｃom", "ｆ３ｖｉｃｔｉｍ@example.com"));
        return v;
    }

    @Test
    void variantsBypassLockout() throws Exception {
        Ctx c = start();
        try {
            System.out.println("═══ 5.2.3 ② 30 個 email 變體（10 個大小寫、10 個重音、10 個全形），每個用錯的密碼登入一次 ═══");
            for (String impl : List.of("naive", "ours")) {
                resetRedis(c);
                AtomicInteger guesses = new AtomicInteger();
                Map<Result, Integer> byResult = new EnumMap<>(Result.class);
                int firstLocked = -1, i = 0;
                for (String email : variants()) {
                    i++;
                    Result r = impl.equals("naive") ? naiveLockout(c, email, "guess-" + i, guesses) : ours(c, email, "guess-" + i, guesses);
                    byResult.merge(r, 1, Integer::sum);
                    if (r == Result.LOCKED && firstLocked < 0) firstLocked = i;
                }
                // 最後用「正確的密碼、正規的 email」登入一次：帳號鎖住了嗎？
                Result last = impl.equals("naive") ? naiveLockout(c, VICTIM, PASSWORD, new AtomicInteger()) : ours(c, VICTIM, PASSWORD, new AtomicInteger());
                System.out.printf("  %-6s 結果 %-28s 第一次被鎖在第 %-3s 次 │ 拿受害者的雜湊比對了 %2d 次 │ 之後用正確密碼登入 → %s%n",
                        impl, byResult, firstLocked < 0 ? "—" : String.valueOf(firstLocked), guesses.get(), last);
            }
            Map<String, Long> matched = new LinkedHashMap<>();
            for (String email : variants())
                matched.merge(email.matches("(?i)[a-z0-9@.]+") ? "大小寫" : email.matches(".*[ａ-ｚ０-９].*") ? "全形" : "重音",
                        c.jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE email = ?", Long.class, email), Long::sum);
            System.out.println("  （WHERE email = ? 對到受害者的變體數：" + matched + "）");

            System.out.println("── ②b 只用 20 個重音與全形的變體，每個各猜 5 次（100 次）──");
            for (String impl : List.of("naive", "ours")) {
                resetRedis(c);
                AtomicInteger guesses = new AtomicInteger();
                Map<Result, Integer> byResult = new EnumMap<>(Result.class);
                for (String email : variants().subList(10, 30))
                    for (int k = 0; k < 5; k++)
                        byResult.merge(impl.equals("naive") ? naiveLockout(c, email, "guess-" + k, guesses) : ours(c, email, "guess-" + k, guesses), 1, Integer::sum);
                Result last = impl.equals("naive") ? naiveLockout(c, VICTIM, PASSWORD, new AtomicInteger()) : ours(c, VICTIM, PASSWORD, new AtomicInteger());
                System.out.printf("  %-6s 結果 %-28s │ 拿受害者的雜湊比對了 %3d 次 │ 之後用正確密碼登入 → %s%n", impl, byResult, guesses.get(), last);
            }
        } finally { cleanup(c); c.app.close(); }
    }

    // ───────── ③ 並行 ─────────

    @Test
    void concurrentAttemptsBypassLockout() throws Exception {
        Ctx c = start();
        try {
            System.out.println("═══ 5.2.3 ③ 50 個請求同時送出（同一個 email、錯的密碼、50 個不同的 IP）═══");
            for (String impl : List.of("naive", "ours")) {
                for (int round = 1; round <= 3; round++) {
                    resetRedis(c);
                    AtomicInteger guesses = new AtomicInteger();
                    ExecutorService pool = Executors.newFixedThreadPool(50);
                    CountDownLatch go = new CountDownLatch(1);
                    List<Future<Result>> fs = new ArrayList<>();
                    for (int i = 0; i < 50; i++) {
                        int n = i;
                        fs.add(pool.submit(() -> {
                            go.await();
                            return impl.equals("naive") ? naiveLockout(c, VICTIM, "guess-" + n, guesses) : ours(c, VICTIM, "guess-" + n, guesses);
                        }));
                    }
                    go.countDown();
                    Map<Result, Integer> byResult = new EnumMap<>(Result.class);
                    for (var f : fs) byResult.merge(f.get(), 1, Integer::sum);
                    pool.shutdown();
                    System.out.printf("  %-6s 第 %d 輪 %-26s │ 拿受害者的雜湊比對了 %2d 次（規則：5 次）%n", impl, round, byResult, guesses.get());
                }
            }
        } finally { cleanup(c); c.app.close(); }
    }
}
```

**`src/test/java/com/example/shop/account/internal/F4ConcurrentRefreshTest.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.ShopApplication;
import com.example.shop.shared.error.ShopException;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;
import java.util.concurrent.*;

/**
 * 5.2.4 同一個 refresh token 同時送出 N 次。
 *   naive：先 SELECT 看「用過了沒」，沒用過就 UPDATE used_at、發新的（同一個交易）
 *   ours ：RefreshTokens.rotate() —— 條件式 UPDATE + 影響列數；影響 0 列且已經用過 → 重放 → 撤銷全部（US-ACC-2 AC-5）
 * 每一輪結束時數一次：這個使用者手上還有幾個「活著的」refresh token。
 */
@Tag("experiment")
class F4ConcurrentRefreshTest {

    static final String USER = "f4user@example.com";

    enum Result { NEW_TOKEN, REJECTED }

    @Test
    void sameRefreshTokenAtTheSameTime() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=ERROR", "--shop.order.jobs-enabled=false");
        JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
        TransactionTemplate tx = app.getBean(TransactionTemplate.class);
        RefreshTokens tokens = app.getBean(RefreshTokens.class);
        LoginService login = app.getBean(LoginService.class);
        try {
            cleanup(jdbc);
            long userId = app.getBean(AccountService.class).register(new AuthDtos.RegisterRequest(USER, "f4-password-1234", "F4")).id();

            System.out.println("═══ 5.2.4 同一個 refresh token 同時送出（每種 50 輪）═══");
            for (int n : new int[]{2, 10}) {
                for (String impl : List.of("naive", "ours")) {
                    Map<String, Integer> rounds = new TreeMap<>();
                    for (int round = 0; round < 50; round++) {
                        String raw = tx.execute(s -> tokens.issue(userId));
                        ExecutorService pool = Executors.newFixedThreadPool(n);
                        CountDownLatch go = new CountDownLatch(1);
                        List<Future<Result>> fs = new ArrayList<>();
                        for (int i = 0; i < n; i++) fs.add(pool.submit(() -> {
                            go.await();
                            return impl.equals("naive") ? naive(jdbc, tx, tokens, raw) : ours(login, raw);
                        }));
                        go.countDown();
                        int fresh = 0;
                        for (var f : fs) if (f.get() == Result.NEW_TOKEN) fresh++;
                        pool.shutdown();
                        long alive = jdbc.queryForObject("SELECT COUNT(*) FROM refresh_tokens WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL",
                                Long.class, userId);
                        rounds.merge("換到新 token %2d 個、活著的 token %2d 個".formatted(fresh, alive), 1, Integer::sum);
                        jdbc.update("UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL", userId);
                    }
                    System.out.printf("  %d 個同時 │ %-6s │ %s%n", n, impl, rounds);
                }
            }
        } finally {
            cleanup(jdbc);
            app.close();
        }
    }

    /** 照直覺寫：讀到「沒用過」→ 標記用過 → 發新的 */
    static Result naive(JdbcTemplate jdbc, TransactionTemplate tx, RefreshTokens tokens, String raw) {
        return tx.execute(s -> {
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT user_id, used_at, revoked_at, expires_at > CURRENT_TIMESTAMP(3) AS valid FROM refresh_tokens WHERE token_hash = ?",
                    RefreshTokens.hash(raw));
            if (rows.isEmpty()) return Result.REJECTED;
            Map<String, Object> r = rows.get(0);
            if (r.get("used_at") != null || r.get("revoked_at") != null || ((Number) r.get("valid")).intValue() == 0) return Result.REJECTED;
            jdbc.update("UPDATE refresh_tokens SET used_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ?", RefreshTokens.hash(raw));
            tokens.issue(((Number) r.get("user_id")).longValue());
            return Result.NEW_TOKEN;
        });
    }

    static Result ours(LoginService login, String raw) {
        try {
            login.refresh(raw);
            return Result.NEW_TOKEN;
        } catch (ShopException e) {
            return Result.REJECTED;
        }
    }

    static void cleanup(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM audit_logs WHERE action = 'REFRESH_TOKEN_REUSED' AND actor_id IN (SELECT id FROM users WHERE email = ?)", USER);
        jdbc.update("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ?)", USER);
        jdbc.update("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ?)", USER);
        jdbc.update("DELETE FROM users WHERE email = ?", USER);
    }
}
```

**`src/test/java/com/example/shop/ch05/F6DeniedTimingTest.java`**

```java
package com.example.shop.ch05;

import com.example.shop.ShopApplication;
import com.example.shop.support.TestTokens;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.*;

/**
 * 5.8.3 兩種 404 的回應時間：「存在但不是你的」（多寫一筆 ACCESS_DENIED，REQUIRES_NEW + commit）vs「不存在」。
 * 交錯送出（一個存在、一個不存在），單一連線依序執行，各 N 次。
 */
@Tag("experiment")
class F6DeniedTimingTest {

    static final long ATTACKER = 990_611;
    static final int N = 1_000;

    @Test
    void twoKindsOf404() throws Exception {
        try (var ctx = new SpringApplicationBuilder(ShopApplication.class).run("--server.port=0",
                "--shop.order.jobs-enabled=false", "--spring.main.banner-mode=off", "--logging.level.root=WARN")) {
            JdbcTemplate jdbc = ctx.getBean(JdbcTemplate.class);
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
            jdbc.update("DELETE FROM audit_logs WHERE actor_id = ?", ATTACKER);
            List<String> existing = jdbc.queryForList("SELECT order_no FROM orders WHERE buyer_id <> ? ORDER BY RAND(7) LIMIT ?", String.class, ATTACKER, N + 100);
            Random r = new Random(11);
            List<String> missing = new ArrayList<>();
            while (missing.size() < N + 100) {
                String no = "202608%02d-%06d".formatted(1 + r.nextInt(28), r.nextInt(1_000_000));
                if (jdbc.queryForObject("SELECT COUNT(*) FROM orders WHERE order_no = ?", Long.class, no) == 0) missing.add(no);
            }
            String bearer = TestTokens.bearer(ctx, ATTACKER);
            HttpClient http = HttpClient.newHttpClient();
            for (int i = 0; i < 100; i++) { get(http, port, bearer, existing.get(i)); get(http, port, bearer, missing.get(i)); }   // 暖機

            System.out.printf("═══ 5.8.3 兩種 404 的回應時間（交錯、依序，各 %,d 次）═══%n", N);
            for (int round = 1; round <= 3; round++) {
                double[] a = new double[N], b = new double[N];
                for (int i = 0; i < N; i++) {
                    a[i] = get(http, port, bearer, existing.get(100 + i));
                    b[i] = get(http, port, bearer, missing.get(100 + i));
                }
                Arrays.sort(a);
                Arrays.sort(b);
                System.out.printf("  第 %d 輪 │ 存在但不是你的 p50 %5.2f  p90 %5.2f ms │ 不存在 p50 %5.2f  p90 %5.2f ms │ p50 差 %+5.2f ms │ 「存在」比較慢的比例 %.0f%%%n",
                        round, a[N / 2], a[N * 9 / 10], b[N / 2], b[N * 9 / 10], a[N / 2] - b[N / 2], slowerShare(a, b) * 100);
                jdbc.update("DELETE FROM audit_logs WHERE actor_id = ?", ATTACKER);
            }
        }
    }

    /** 隨機各抽一個，「存在」的比「不存在」慢的機率（= 一次請求就猜對的機率；50% = 完全分不出來） */
    static double slowerShare(double[] a, double[] b) {
        long slower = 0;
        for (double x : a) { int idx = Arrays.binarySearch(b, x); slower += idx >= 0 ? idx : -idx - 1; }
        return slower / ((double) a.length * b.length);
    }

    static double get(HttpClient http, int port, String bearer, String orderNo) throws Exception {
        long s = System.nanoTime();
        HttpResponse<Void> res = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/orders/" + orderNo))
                .header("Authorization", bearer).build(), HttpResponse.BodyHandlers.discarding());
        if (res.statusCode() != 404) throw new IllegalStateException(orderNo + " → " + res.statusCode());
        return (System.nanoTime() - s) / 1e6;
    }
}
```

**`src/test/java/com/example/shop/account/internal/F7RedisDownLoginTest.java`**

```java
package com.example.shop.account.internal;

import com.example.shop.ShopApplication;
import com.example.shop.shared.error.ProblemType;
import com.example.shop.shared.error.ShopException;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 5.6.4 0.6.3 的那一格：「登入 × Redis 掛了 = 200，但暫停失敗 5 次鎖定，並告警」。
 * 真的把 shop-redis-1 停掉（docker stop），依序登入 12 次（前 6 次密碼錯、後 6 次密碼對），量每一次的延遲。
 *   naive：每一次都去碰 Redis，連不上就放行（fail-open，但沒有退避）
 *   ours ：LoginAttempts —— 連不上之後 5 秒內不再碰 Redis
 */
@Tag("experiment")
class F7RedisDownLoginTest {

    static final String USER = "f7user@example.com", PASSWORD = "f7-real-password-123";

    static void docker(String... args) throws Exception {
        List<String> cmd = new ArrayList<>(List.of("docker"));
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        p.waitFor();
    }

    @Test
    void loginWhileRedisIsDown() throws Exception {
        var app = new SpringApplicationBuilder(ShopApplication.class).web(WebApplicationType.NONE)
                .run("--spring.main.banner-mode=off", "--logging.level.root=WARN", "--shop.order.jobs-enabled=false");
        JdbcTemplate jdbc = app.getBean(JdbcTemplate.class);
        StringRedisTemplate redis = app.getBean(StringRedisTemplate.class);
        LoginService login = app.getBean(LoginService.class);
        AtomicInteger ip = new AtomicInteger();
        long auditMark = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM audit_logs", Long.class);
        try {
            jdbc.update("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ?)", USER);
            jdbc.update("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ?)", USER);
            jdbc.update("DELETE FROM users WHERE email = ?", USER);
            app.getBean(AccountService.class).register(new AuthDtos.RegisterRequest(USER, PASSWORD, "F7"));
            redis.delete(LoginAttempts.key(USER));

            System.out.println("═══ 5.6.4 Redis 正常：依序 12 次（前 6 次錯、後 6 次對）═══");
            run("ours", 12, i -> ours(login, i, ip));
            redis.delete(LoginAttempts.key(USER));

            for (String mode : List.of("stop", "pause")) {                     // 停掉（連線被拒絕） vs 卡住（行程凍結，TCP 連線還在）
                docker(mode, "shop-redis-1");
                System.out.println("═══ docker " + mode + " shop-redis-1 ═══");
                run("naive", 12, i -> naive(redis, app.getBean(Accounts.class), app.getBean(org.springframework.security.crypto.password.PasswordEncoder.class), i));
                Thread.sleep(LoginAttempts.DEGRADED_BACKOFF.toMillis() + 500);    // 讓 ours 從「第一次碰到 Redis 失敗」開始
                run("ours", 12, i -> ours(login, i, ip));
                double degraded = app.getBean(MeterRegistry.class).get("shop.login.lockout.degraded").counter().count();
                System.out.printf("  shop.login.lockout.degraded（累計）= %.0f%n", degraded);
                docker(mode.equals("stop") ? "start" : "unpause", "shop-redis-1");
                for (int i = 0; i < 60; i++) {
                    try { redis.opsForValue().get("ping"); break; } catch (DataAccessException e) { Thread.sleep(500); }
                }
                Thread.sleep(LoginAttempts.DEGRADED_BACKOFF.toMillis() + 500);
            }
        } finally {
            docker("unpause", "shop-redis-1");
            docker("start", "shop-redis-1");
            for (int i = 0; i < 60; i++) {
                try { redis.opsForValue().get("ping"); break; } catch (DataAccessException e) { Thread.sleep(500); }
            }
            redis.delete(LoginAttempts.key(USER));
            jdbc.update("DELETE FROM audit_logs WHERE id > ? AND action = 'LOGIN_LOCKED'", auditMark);
            jdbc.update("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ?)", USER);
            jdbc.update("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ?)", USER);
            jdbc.update("DELETE FROM users WHERE email = ?", USER);
            app.close();
        }
    }

    interface Attempt { String run(int i) throws Exception; }

    static void run(String label, int n, Attempt a) throws Exception {
        StringBuilder line = new StringBuilder();
        for (int i = 0; i < n; i++) {
            long s = System.nanoTime();
            String r = a.run(i);
            line.append("%s %4.0f".formatted(r, (System.nanoTime() - s) / 1e6)).append(i == n - 1 ? "" : " │ ");
        }
        System.out.printf("  %-6s %s（ms）%n", label, line);
    }

    static String password(int i) { return i < 6 ? "wrong-" + i : PASSWORD; }

    static String ours(LoginService login, int i, AtomicInteger ip) {
        try {
            login.login(USER, password(i), "198.51.100." + ip.incrementAndGet());
            return "200";
        } catch (ShopException e) {
            return e.type() == ProblemType.RATE_LIMITED ? "429" : e.type() == ProblemType.UNAUTHENTICATED ? "401" : e.type().name();
        }
    }

    /** 照直覺寫的 fail-open：每次都試 Redis，例外就當作「沒有被鎖」 */
    static String naive(StringRedisTemplate redis, Accounts accounts, org.springframework.security.crypto.password.PasswordEncoder encoder, int i) {
        try {
            String n = redis.opsForValue().get(LoginAttempts.key(USER));
            if (n != null && Integer.parseInt(n) >= 5) return "429";
        } catch (DataAccessException e) { /* fail-open */ }
        boolean ok = encoder.matches(password(i), accounts.findByEmail(USER).orElseThrow().passwordHash());
        if (!ok) {
            try { redis.opsForValue().increment(LoginAttempts.key(USER)); } catch (DataAccessException e) { /* fail-open */ }
            return "401";
        }
        return "200";
    }
}
```

**`src/test/java/com/example/shop/ch05/F8SmallFactsTest.java`**

```java
package com.example.shop.ch05;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.nio.charset.StandardCharsets;

/** 5.4.2、5.10 兩個小事實：BCrypt 的 72 bytes，與 ON DUPLICATE KEY UPDATE 回報的列數 */
@Tag("experiment")
class F8SmallFactsTest {

    @Test
    void bcryptTruncatesAt72Bytes() {
        BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder(10);
        String base = "密".repeat(24);                                           // 72 bytes
        String hash = bcrypt.encode(base + "第一個人的後綴");
        System.out.println("═══ 5.4.2 BCrypt 只看前 72 bytes（spring-security-crypto " + BCryptPasswordEncoder.class.getPackage().getImplementationVersion() + "）═══");
        System.out.printf("  註冊的密碼：「%s第一個人的後綴」（%d bytes）%n", base.substring(0, 3) + "…", (base + "第一個人的後綴").getBytes(StandardCharsets.UTF_8).length);
        for (String attempt : new String[]{base + "第一個人的後綴", base + "完全不一樣的東西", base, "密".repeat(23)})
            System.out.printf("  用「%s…%s」（%d bytes）登入 → %s%n", attempt.substring(0, 3), attempt.length() > 24 ? attempt.substring(24) : "",
                    attempt.getBytes(StandardCharsets.UTF_8).length, bcrypt.matches(attempt, hash) ? "通過" : "失敗");
    }

    @Test
    void onDuplicateKeyUpdateRowCount() {
        System.out.println("═══ 5.10 INSERT ... ON DUPLICATE KEY UPDATE 回報的列數 ═══");
        for (String flag : new String[]{"", "&useAffectedRows=true"}) {
            JdbcTemplate jdbc = new JdbcTemplate(new DriverManagerDataSource(
                    "jdbc:mysql://localhost:3306/shop_lab?useSSL=false&allowPublicKeyRetrieval=true" + flag, "shop", "shop"));
            jdbc.execute("DROP TABLE IF EXISTS f8_roles");
            jdbc.execute("CREATE TABLE f8_roles (user_id BIGINT, role VARCHAR(20), PRIMARY KEY (user_id, role))");
            String sql = "INSERT INTO f8_roles (user_id, role) VALUES (1, 'SELLER') ON DUPLICATE KEY UPDATE user_id = user_id";
            int first = jdbc.update(sql), second = jdbc.update(sql);
            System.out.printf("  %-24s 第一次（新增）→ %d │ 第二次（已經有了，什麼都沒改）→ %d%n", flag.isEmpty() ? "Connector/J 預設" : "useAffectedRows=true", first, second);
            jdbc.execute("DROP TABLE f8_roles");
        }
    }
}
```

#### 腳本

**`smoke5.sh`**

```bash
#!/usr/bin/env bash
# 5.11 走完一張訂單（第 05 章版）：身分全部來自 POST /api/auth/login，不再有 X-Debug-User-Id
set -u
BASE=localhost:8080
JSON=(-H "Content-Type: application/json")
SECRET=local-dev-only-payment-callback-secret-0123
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
show() { echo "--- $1"; }
req() { curl -s -w ' [%{http_code}]\n' "$@"; }
login() { curl -s "${JSON[@]}" -d "{\"email\":\"$1\",\"password\":\"password123\"}" $BASE/api/auth/login | sed -E 's/.*"accessToken":"([^"]+)".*/\1/'; }
status() { sed -E 's/.*"status":"([A-Z_]+)".*(\[[0-9]+\])/status=\1 \2/'; }

show "登入（買家 1001、買家 1002、賣家 2、管理員 1）"
BUYER=(-H "Authorization: Bearer $(login buyer00001@example.com)")
OTHER=(-H "Authorization: Bearer $(login buyer00002@example.com)")
SELLER=(-H "Authorization: Bearer $(login seller001@example.com)")
ADMIN=(-H "Authorization: Bearer $(login admin@example.com)")
echo "${BUYER[1]:0:60}…"

show "下單";                 R=$(req -X POST "${BUYER[@]}" "${JSON[@]}" -H "Idempotency-Key: $(uuidgen)" -d '{"items":[{"productId":1,"quantity":2,"unitPrice":149}]}' $BASE/api/orders); echo "${R:0:90}…"
NO=$(echo "$R" | sed -E 's/.*"orderNo":"([^"]+)".*/\1/')
show "別的買家讀這張訂單";    req "${OTHER[@]}" $BASE/api/orders/$NO
show "別的買家讀不存在的訂單"; req "${OTHER[@]}" $BASE/api/orders/19990101-000000
show "沒帶 token";           req $BASE/api/orders/$NO
show "買家呼叫賣家的 API";    req -X POST "${BUYER[@]}" $BASE/api/seller/orders/$NO/start-picking
show "建立付款";             P=$(req -X POST "${BUYER[@]}" $BASE/api/orders/$NO/payments); echo "$P"
PID=$(echo "$P" | sed -E 's/.*"paymentId":([0-9]+).*/\1/')
SIG=$(printf '%s' "$PID|txn-$PID|298.00|SUCCEEDED" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
CB="{\"paymentId\":$PID,\"providerTxnId\":\"txn-$PID\",\"amount\":298.00,\"result\":\"SUCCEEDED\",\"signature\":\"$SIG\"}"
show "簽章錯誤的回呼";        req -X POST "${JSON[@]}" -d "${CB/$SIG/$(printf '0%.0s' {1..64})}" $BASE/api/payments/callback
show "付款成功的回呼";        req -X POST "${JSON[@]}" -d "$CB" $BASE/api/payments/callback
show "賣家開始撿貨";          req -X POST "${SELLER[@]}" $BASE/api/seller/orders/$NO/start-picking | status
show "出貨";                 req -X POST "${SELLER[@]}" "${JSON[@]}" -d '{"carrier":"黑貓宅急便","trackingNo":"TW-0005"}' $BASE/api/seller/orders/$NO/ship | status
show "確認收貨";             req -X POST "${BUYER[@]}" $BASE/api/orders/$NO/confirm-receipt | status
sleep 0.5
show "管理員查這段期間的稽核"
curl -s "${ADMIN[@]}" "$BASE/api/admin/audit-logs?from=$SINCE&to=$(date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)" \
  | python3 -c "import sys,json; [print('  ', r['action'], r['actorId'], r['actorRole'], r['targetType'], r['targetId'], r['ip']) for r in json.load(sys.stdin)['content']]"
```

**`boot-test.sh`**

```bash
#!/usr/bin/env bash
# 5.10 第一個管理員：空資料庫 × 三種環境變數
run() {
  local label=$1; shift
  docker exec shop-mysql-1 mysql -uroot -proot -e "DROP DATABASE IF EXISTS shop_boot; CREATE DATABASE shop_boot; GRANT ALL ON shop_boot.* TO 'shop'@'%';" 2>/dev/null
  java -jar shop/target/shop-0.0.1-SNAPSHOT.jar --spring.profiles.active=local --server.port=18085 --shop.order.jobs-enabled=false \
       "--spring.datasource.url=jdbc:mysql://localhost:3306/shop_boot?useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=UTC" "$@" > boot.log 2>&1 &
  local pid=$!
  for i in $(seq 1 60); do grep -q 'Application run failed\|Started ShopApplication' boot.log && break; sleep 1; done
  sleep 1; kill $pid 2>/dev/null; wait $pid 2>/dev/null
  echo "### $label"
  grep -E 'IllegalStateException: |BOOTSTRAP_ADMIN|Started ShopApplication' boot.log | sed -E 's/^[0-9T:.+-]+ +//; s/^.*IllegalStateException: /  IllegalStateException: /; s/^(INFO|WARN) [0-9]+ --- \[shop\] \[ +main\] /  /' | cut -c1-200 | head -3
  docker exec shop-mysql-1 mysql -uroot -proot shop_boot -N -e "SELECT CONCAT('  users: ', u.id, ' ', u.email, ' ', r.role) FROM users u JOIN user_roles r ON r.user_id = u.id" 2>/dev/null
}
run "沒有給（email、password 都是空的）" --shop.security.bootstrap-admin.email= --shop.security.bootstrap-admin.password=
run "email 不是 email" "--shop.security.bootstrap-admin.email=--shop.security.bootstrap-admin.password=" --shop.security.bootstrap-admin.password=first-deploy-admin-pw
run "密碼太短" --shop.security.bootstrap-admin.email=Ops-Admin@Example.com --shop.security.bootstrap-admin.password=short
run "正確" --shop.security.bootstrap-admin.email=Ops-Admin@Example.com --shop.security.bootstrap-admin.password=first-deploy-admin-pw
```

---

## 5.13 常見誤區

**① 「加了 Spring Security，health 有被放行」**

5.2.1：只加依賴時有（`ManagementWebSecurityAutoConfiguration`）。**寫下第一個自己的 `SecurityFilterChain`，它就退場了**，readiness 變成 401，負載平衡器摘掉每一台。自動設定的退場，會帶走你不知道它在做的事。

**② 「`permitAll` 了，就不會被擋」**

5.2.1 B：CSRF 預設是開的，`permitAll` 的 POST 一樣被擋成 403；而那個 403 被轉發到 `/error`、再被 `authenticated()` 蓋成 401。**一個錯誤藏在另一個錯誤後面。** 無狀態的 API 關掉 CSRF（前提：token 不在 cookie 裡），`/error` 放行。

**③ 「403 跟 404 差不多，都是拿不到」**

5.2.2：6.5 秒、20,000 次猜測、21 個 403，估出每天約 1,050 張訂單（實際 1,187）。**403 回答了「存在嗎？」這個問題。**

**④ 「兩種 404 的內容一樣，就分不出來了」**

5.8.3：多寫一筆稽核，慢 2 ms，一次請求 94～98% 猜對。**狀態碼、內容、時間，三層都要一樣。** 每加一件「只有某一條路徑才做」的事，就要重量一次。

**⑤ 「帳號不存在就不用跑 BCrypt，省一點 CPU」**

5.2.3 ①：省下的 74 ms 就是洩漏。帳號不存在時，拿一個同樣 cost 的假雜湊比一次。

**⑥ 「先查失敗幾次，沒到上限再驗密碼」**

5.2.3 ③：50 個同時送出，50 個都通過檢查。BCrypt 越慢，這個窗口越大。**先 `INCR` 佔名額，再驗密碼。**

**⑦ 「email 轉小寫，就正規化好了」**

5.2.3 ②：`utf8mb4_0900_ai_ci` 不分重音、不分全形。20 個變體各猜 5 次，猜了 100 次，帳號沒被鎖。**不要追著資料庫的等價關係跑，讓查詢用嚴格的比較**（`COLLATE utf8mb4_bin`），讓「找得到」與「被計數」是同一個範圍。

**⑧ 「refresh 時先看 `used_at` 是不是 NULL，再更新」**

5.2.4：10 個同時送，換出 10 個活著的 token，重放偵測一次都沒觸發。**條件寫進 UPDATE 的 WHERE，看影響列數**（0.5.5 的硬規則，第三次）。

**⑨ 「稽核跟業務在同一個交易，就不會不一致」**

5.2.5：被拒絕的動作會 rollback —— 簽章錯誤的稽核 0 筆，永遠 0 筆。**看的是交易的命運：會 rollback 的，稽核要獨立 commit。**

**⑩ 「那就全部用 REQUIRES_NEW，確保稽核一定寫進去」**

5.2.5 的反方向：賣家取消一張已出貨的訂單，409，稽核卻留下「已取消」。**成功了才算數的動作，稽核要跟它同生共死。**

**⑪ 「Redis 掛掉的測試，`docker stop` 一下就好」**

5.6.4：`stop` 量了 5 次，4 次是立刻失敗；`pause` 4 次都等滿 500 ms 的逾時。**「停掉」與「卡住」是兩種故障**，退避只對後者有用，而後者才是比較常見、也比較難在本機重現的那一種。

**⑫ 「JWT 的有效期就是設定的那個值」**

5.5.4：預設的驗證器容許 60 秒的時鐘誤差，15 分鐘的 token 活 16 分鐘。**把需求裡的數字寫成測試，量它的邊界。**

**⑬ 「`@Size(max = 72)` 就擋住 BCrypt 的 72 bytes 了」**

5.4.2：`@Size` 數的是 char，BCrypt 數的是 UTF-8 bytes。25 個中文字是 25 個 char、75 bytes。超過 72 bytes 的部分**默默被忽略**，前 72 bytes 一樣的密碼都會通過。

**⑭ 「打開 `forward-headers-strategy`，就拿得到使用者的 IP」**

5.6.4：從受信任的位址送來的 `X-Forwarded-For` 會被採信 —— 本機換 25 個值登入 25 次，IP 限流一次都沒觸發。**`X-Forwarded-For` 可不可信，取決於誰能直接連到你的應用程式。**

**⑮ 「覆蓋掃描只看狀態碼，不會改到資料」**

5.5.5：路徑變數代入 `1`，帶著三個角色的 token，`POST /api/admin/users/1/suspend` 回 200 —— 種子資料的管理員被停權了。**權限越大的測試 token，越要打在不存在的資源上。**

---

## 5.14 本章小結

**這一章建立了六件事**：

1. **一條 `SecurityFilterChain`**（5.5）：0.8 的表 + `denyAll()`、無狀態、401 / 403 也是 Problem Details；第 03、04 章的 Controller 一行都沒改。`SecurityRouteCoverageTest` 守著「每一支 API 都在表上」。
2. **一個不洩漏的登入**（5.6）：假雜湊讓兩種失敗一樣慢；先 `INCR` 再驗密碼；鎖定的 key 與查詢用同一個嚴格的等價關係；Redis 掛了 fail-open + 退避 + 單機的 IP 限流。
3. **一個 refresh token rotation**（5.7）：條件式 UPDATE + 影響列數；結果在交易裡回傳、在交易外才變成 401；重放偵測的代價（兩個分頁）寫進前端規範。
4. **一個資料層級權限的元件與兩個覆蓋掃描**（5.8）：`OrderAccess`；`IdorMatrixTest` 的 11 格；兩種 404 的內容與時間都一樣。**驗收 Q5 變綠。**
5. **一個三種寫法的稽核**（5.9）：成功才算數 → `record`；會 rollback → `recordRejection`；會從時間洩漏 → `recordRejectionLater`。第 04 章的三個「第 05 章寫進 `audit_logs`」全部兌現。
6. **一組寫成測試的妥協**（5.7.3、5.6.4）：停權最遲 15 分鐘 + 5 秒生效、Redis 掛了不鎖定、重放偵測會登出兩個分頁 —— 每一個都有一個測試或實驗，在有人「修好」它的時候提醒他那是一個決定。

**如果這一章只能記一句話**：

> **攻擊者看的不是你的程式碼，是你的回應：狀態碼、內容、時間。** 每一種「不一樣」，都是一個答案。
> 而防守方要的正好相反：**對攻擊者完全沉默，對自己大聲說話** —— 404 給他，`ACCESS_DENIED` 給你。

### 5.14.1 驗收清單

做得到才往下走：

- [ ] 跑完 F1，說出 A、B、B'、C 四個階段裡 readiness 與 `POST /api/payments/callback` 各是什麼狀態碼、為什麼。
- [ ] 說出 5.2.2 的攻擊者怎麼從 21 個 403 估出每天的訂單量，以及 404 版本的伺服器知道了什麼。
- [ ] 跑完 F3，說出三個洞各自的「查」與「做」是哪兩件事；用 `mysql` 自己試一個會對到 `buyer00001` 的 email 變體。
- [ ] 說出 `findByEmail` 為什麼要兩個條件，並用 `EXPLAIN` 確認它是 `const`。
- [ ] 跑完 F4，說出正式版「活著的 token 0 個」是怎麼來的，以及它對「兩個分頁」意味著什麼。
- [ ] 把 `rotate()` 的重讀改成一般的 `SELECT`，再在 `UPDATE` 前面加一句讀取，跑 F4，看到重放偵測失效。
- [ ] 用 `AuditPlacementTest` 的第一版（5.2.5）跑一次，看到 0 筆與那一筆「已取消」；說出為什麼 `REFRESH_TOKEN_REUSED` 用 `record` 而不是 `recordRejection`。
- [ ] 跑完 F6，說出三個版本的差距各從哪裡來。
- [ ] 跑完 F7，說出 `stop` 與 `pause` 對 naive 版本的延遲有什麼不同，以及退避在哪一種情況下才有用。
- [ ] 在 `SecurityConfig` 拿掉一條規則，看 `SecurityRouteCoverageTest` 紅在哪裡；新增一支帶 `{orderNo}` 的 API，看 `IdorMatrixTest` 紅在哪裡。
- [ ] 跑 `smoke5.sh`，用管理員的 token 查出冒煙腳本留下的兩筆稽核。
- [ ] `mvn clean verify` 顯示 `Tests run: 143, Failures: 0, Errors: 0, Skipped: 5`。

### 5.14.2 本章練習

**練習一（15 分鐘）：406 也要是 Problem Details**

5.2.1 C 階段的最後一列：瀏覽器送 `Accept: text/html`，回應是 406，`type` 是 `about:blank`。在 `GlobalExceptionHandler` 覆寫 `handleHttpMediaTypeNotAcceptable`，讓它回 `/problems/validation`（或新增一個型別）。
**注意**：回應的 `Content-Type` 是什麼？客戶端說了它不接受 JSON —— 你還能回 `application/problem+json` 嗎？

**練習二（30 分鐘）：鎖定本身的 DoS**

5.6.2 的 ⚠️：攻擊者每 15 分鐘故意錯 5 次，就能讓受害者永遠登入不了。設計一個緩解：例如「曾經在這台裝置上成功登入過」的請求（帶一個長期的裝置 cookie 或 header）不受帳號鎖定影響，但受 IP 限流影響。
寫出它的 AC，再寫一個測試證明：攻擊者鎖住了帳號，受害者從常用裝置仍然登入得了。**這個裝置識別碼，本身會不會變成一個新的攻擊面？**

**練習三（20 分鐘）：商品的時間側通道**

`ProductService.owned()` 用 `products.findById(productId)`：「存在但不是你的」會載入 Entity，「不存在」不會 —— 跟 5.8.3 的第二版一樣。仿照 F6 量賣家商品 API 的兩種 404，再仿照第三版修掉它。
**商品 id 是流水號**（`1`、`2`、`3`……）—— 這個時間差洩漏的東西，跟訂單編號洩漏的一樣嗎？

**練習四（40 分鐘）：refresh 的寬限期**

實作 5.7.2 表格裡的 ②：一個 refresh token 被用過之後的 **10 秒內**再被使用，回傳**同一組**新的 token，不判定為重放。需要在 `refresh_tokens` 記下「這個 token 換出了哪一個」（V12 migration）。
重跑 F4 的「2 個同時」：活著的 token 變成幾個？那 10 秒的窗口，對 AC-5 的「被偷了」意味著什麼？

**練習五（20 分鐘）：登出**

加一支 `POST /api/auth/logout`：撤銷帶來的那一個 refresh token（不是全部）。access token 怎麼辦？
寫一個測試：登出之後 refresh → 401；登出之後立刻用 access token 呼叫 `/api/me` → 結果是什麼？把它跟 AC-6 的妥協對照。

**練習六（30 分鐘）：強制下架**

0.8 的 `POST /api/admin/products/{id}/takedown`：管理員把任何賣家的商品下架。它要寫 `audit_logs`（US-AUD-1：「所有管理員動作」）。
`catalog` 模組需要一個管理員專用的方法 —— 它要不要經過 `owned()`？把它加進 `IdorMatrixTest` 的 `MATRIX` 還是 `EXEMPT`？為什麼？

**練習七（30 分鐘）：真正的客戶端 IP**

設定 `server.forward-headers-strategy: native`，並用 `server.tomcat.remoteip.internal-proxies` 只信任負載平衡器的網段。用 5.6.4 的方式重新量一次：從 127.0.0.1 帶 `X-Forwarded-For` 還會被採信嗎？
寫一個測試確認 `audit_logs.ip` 存的是 `X-Forwarded-For` 最右邊那個不受信任的位址。

**練習八（進階，60 分鐘）：即時停權**

把 AC-6 的「最遲 15 分鐘」改成「立即」：停權時把使用者 id 寫進 Redis 的黑名單（TTL = access token 的有效期），`CurrentUserResolver` 每個請求查一次。
量每個請求多了多少延遲；然後把 Redis 停掉（`stop` 與 `pause` 各一次）—— 0.6.3 的降級矩陣，哪幾格要改寫？**fail-open 還是 fail-closed？** 這一次的答案，跟 5.6.4 登入的答案一樣嗎？

---

## 5.15 下一章預告

這一章的好幾個地方，都停在「第 06 章」：

- **限流**：登入只有一個單機的 IP 限流（5.6.4）。0.6.5 的「下單每使用者每分鐘 10 次」（US-ORD-1 AC-8 的 429）、「全域每 IP 每秒 50 次」都還沒有 —— 而 5.2.2 的猜訂單編號、5.8.3 的時間統計、5.4.1 的試註冊，都要靠它把成本拉高。
- **Redis 掛掉的演練**：5.6.4 量出了「停掉」與「卡住」的差別。第 06 章的驗收 **Q8**（Redis 停止 60 秒：商品詳情 200、熱點商品下單 503、一般下單 201、readiness 維持 UP）兩種都要做。
- **熱點庫存**：4.8.1 的搶購壓測，正確性 MySQL 守得住、p99 守不住（200 rps 開放式負載只有 1/4 輪 < 500 ms）。第 06 章把熱點商品的預扣搬到 Redis，DB 落帳；Redis 連不上時熱點商品回 503 —— 0.6.3 那一格的艙壁。

下一章（06）的主題是**快取與熱點庫存**：

- 商品詳情的快取與失效（US-PRD-3 AC-3、AC-4：改價後 1 秒內讀到新價格）、熱門排行（US-RPT-2）。
- Redis 預扣庫存 + DB 落帳，以及「Redis 裡的數字只是 MySQL 的快速副本」那句話（0.3.3）的對帳。
- 分散式鎖包住交易、API 限流。
- **Redis 拔掉 60 秒的降級演練**：驗收 Q8。

門鎖裝好了，也知道誰進過哪一扇門。下一章讓這棟房子在人潮湧進來的時候不會塌。
