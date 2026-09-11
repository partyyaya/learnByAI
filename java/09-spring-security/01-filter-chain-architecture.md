# 第 01 章：架構與 Filter Chain

> 00 章的六個事故裡，有三個的答案是同一句話：**「這取決於 Filter 的位置。」**
>
> ```
> 0.3.5  同一個 Filter 放三個位置 → 三種行為（401 / 500 / 401）
> 0.4.4  CSRF 失敗回 401 還是 403 → 取決於 ExceptionTranslationFilter 怎麼判斷
> 0.5.2  permitAll 還有安全標頭   → 因為授權是第 16 個，標頭是第 4 個
> ```
>
> **這一章要把那句話拆開，變成你可以預測的東西。**
>
> Spring Security 難學，有一個很具體的原因：
>
> > **你寫的是「設定」，執行的是「一串 Filter」。**
> > **而設定與 Filter 之間的對應關係，文件沒有直接告訴你。**
>
> `http.csrf(c -> c.disable())` 這一行，實際發生的事是「**把 `CsrfFilter` 從鏈上拿掉**」。
> `http.formLogin(...)` 是「**加三個 Filter 上去**」。
> `.anyRequest().authenticated()` 是「**設定第 16 個 Filter 的規則**」。
>
> 📌 **一旦你能把設定翻譯成 Filter 清單，Spring Security 就從「玄學」變成「一串有順序的方法呼叫」。**
>
> 這一章有**八個實測**——一份完整的請求軌跡日誌、
> 七種設定產生 5 到 16 個不等的 Filter、
> `addFilterAt` 其實不會取代任何東西、
> 一個 Filter 因為多標了一個 `@Component` 而跑了兩次、
> 兩條 chain 順序寫反讓第二條**永遠不執行**（而且啟動不會報錯）、
> `web.ignoring()` 產生一條**零個 Filter** 的 chain、
> 同一條 Tomcat 執行緒連續處理四個請求身分完全正確、
> 以及一個把策略改成 `INHERITABLETHREADLOCAL` 之後
> **bob 的請求在執行緒池裡看到 alice** 的身分外洩。

---

## 1.1 學習目標

完成本章後，你應該可以：

- 畫出一個請求從 Tomcat 到 Controller 的**完整軌跡**，並指出
  `DelegatingFilterProxy`、`FilterChainProxy`、`VirtualFilterChain` 三者各自的職責（1.2）。
- 說明為什麼 Spring Security 的 Filter **不是**註冊在 Servlet 容器上的
  （1.2.2：容器上只有**一個** Filter，order = **-100**）。
- 打開 `TRACE` 日誌讀懂一次請求的軌跡，並用它回答「這個請求走了哪一條 chain、
  在第幾個 Filter 被擋下來」（1.3）。
- 說出預設那 16 個 Filter 各自的職責，並指出**哪些是可替換的擴充點**（1.4）。
- 用一張表把七種常見設定對到它們產生的 Filter 清單
  （1.4.3 實測：從 **5 個到 16 個**，而 `formLogin` 一個開關就差 4 個）。
- 說明 Spring Security 6 的 **explicit save**：`SecurityContextHolderFilter` 只載入不儲存，
  以及這件事在什麼情況下會咬你（1.5）。
- 正確選擇 `addFilterBefore` / `addFilterAfter` / `addFilterAt`，
  並說明 **`addFilterAt` 不會取代原本的 Filter**（1.6.3 實測：兩個都在鏈上）。
- 解釋為什麼自訂 Filter 標 `@Component` 會讓它**跑兩次**，
  以及 `OncePerRequestFilter` 為什麼只救了一半（1.6.4 實測）。
- 設計多條 `SecurityFilterChain`，說明比對規則是**第一條匹配就結束**，
  並示範順序寫反的後果（1.7.3 實測：第二條 chain 永遠不執行，**而且啟動不報錯**）。
- 說出 `permitAll()` 與 `web.ignoring()` 的三個差別，並知道什麼時候可以用後者（1.7.5）。
- 追蹤一個 `AccessDeniedException` 從 `AuthorizationFilter` 到 HTTP 回應的完整路徑，
  並說明 401 與 403 的分界是在哪一行程式碼決定的（1.8.2）。
- 把 Filter 層與 Controller 層的錯誤格式**統一**，並說明兩種做法的代價（1.8.5）。
- 說明 `SecurityContextHolder` 是一個 `ThreadLocal`，
  並用實測說出四種執行緒各自看得到什麼（1.9.2），
  以及為什麼 `MODE_INHERITABLETHREADLOCAL` **是一個會造成身分外洩的選項**（1.9.4）。

---

## 1.2 一個請求到底穿過了什麼

**先講結論，再驗證。** 一個請求從網路封包到你的 `@GetMapping` 方法，中間有**三層**：

```
   HTTP 請求
       │
┌──────▼──────────────────────────────────────────────────────┐
│ ① Servlet 容器（Tomcat）的 Filter 鏈                          │
│    characterEncodingFilter    order = Integer.MIN_VALUE      │
│    formContentFilter          order = -9900                  │
│    ★ springSecurityFilterChain order = -100  ← 只有【一個】    │
│    requestContextFilter       order = -105                   │
│    （你自己標 @Component 的 Filter，預設 order = 最低優先）      │
└──────┬──────────────────────────────────────────────────────┘
       │  springSecurityFilterChain 這一個 Filter 進去之後……
┌──────▼──────────────────────────────────────────────────────┐
│ ② DelegatingFilterProxy                                      │
│    一個【殼】：把工作轉給 Spring 容器裡叫做                       │
│    springSecurityFilterChain 的那個 bean                      │
└──────┬──────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│ ③ FilterChainProxy                                           │
│    手上有【N 條】SecurityFilterChain                           │
│    逐條比對 requestMatcher，★ 第一條匹配的就用，其餘不看          │
│    選中之後，用一個內部類 VirtualFilterChain 依序執行那條上的 Filter│
└──────┬──────────────────────────────────────────────────────┘
       │  16 個 Filter 都放行之後……
┌──────▼──────────────────────────────────────────────────────┐
│ ④ DispatcherServlet → HandlerInterceptor → @RestController    │
│    ★ @RestControllerAdvice 掛在這一層                          │
└─────────────────────────────────────────────────────────────┘
```

⚠️ **這張圖解釋了 00 章 0.3.5 那個事故**：
`@RestControllerAdvice` 在 ④，你的自訂 Filter 在 ③——
**③ 拋的例外，④ 永遠不會看到。**

### 1.2.1 實測：Servlet 容器層有哪些 Filter

```java
package com.example.lab09.ch01;

import jakarta.servlet.Filter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.servlet.AbstractFilterRegistrationBean;
import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.context.ApplicationContext;
import org.springframework.core.Ordered;

@SpringBootTest
class ContainerFilterOrderTest {

    @Autowired ApplicationContext ctx;

    @Test
    void orders() {
        System.out.println("═══ 1.2.1 直接是 Filter bean 的（Boot 會自動註冊到容器）═══");
        for (String n : ctx.getBeanNamesForType(Filter.class)) {
            Object b = ctx.getBean(n);
            String ord = (b instanceof Ordered o) ? String.valueOf(o.getOrder()) : "(沒有實作 Ordered)";
            System.out.printf("  %14s  %-34s %s%n", ord, n, b.getClass().getName());
        }

        System.out.println("\n═══ 1.2.1 用 FilterRegistrationBean 註冊的 ═══");
        for (String n : ctx.getBeanNamesForType(ServletContextInitializer.class)) {
            Object b = ctx.getBean(n);
            if (b instanceof AbstractFilterRegistrationBean<?> r) {
                System.out.printf("  %14d  %-34s %s%n", r.getOrder(), n, r.getFilter().getClass().getName());
            }
        }

        System.out.println("\n  SecurityProperties.DEFAULT_FILTER_ORDER = "
            + org.springframework.boot.autoconfigure.security.SecurityProperties.DEFAULT_FILTER_ORDER);
    }
}
```

```
═══ 1.2.1 直接是 Filter bean 的（Boot 會自動註冊到容器）═══
   -2147483648  characterEncodingFilter            org.springframework.boot.web.servlet.filter.OrderedCharacterEncodingFilter
         -9900  formContentFilter                  org.springframework.boot.web.servlet.filter.OrderedFormContentFilter
          -105  requestContextFilter               org.springframework.boot.web.servlet.filter.OrderedRequestContextFilter
   (沒有實作 Ordered)  springSecurityFilterChain    …WebMvcSecurityConfiguration$CompositeFilterChainProxy

═══ 1.2.1 用 FilterRegistrationBean 註冊的 ═══
          -100  securityFilterChainRegistration    org.springframework.boot.web.servlet.DelegatingFilterProxyRegistrationBean$1

  SecurityProperties.DEFAULT_FILTER_ORDER = -100
```

**兩個關鍵事實**：

```
① 容器層【只有一個】Spring Security 的 Filter，叫 springSecurityFilterChain
   → 那 16 個 Filter 對 Tomcat 來說是【不存在】的
   → 所以你不能用 servlet 容器的機制去調整它們的順序

② 它的 order 是 -100（SecurityProperties.DEFAULT_FILTER_ORDER）
   → 比 requestContextFilter（-105）晚
   → 比你自己標 @Component 的 Filter（預設最低優先）早
```

⚠️ **第二點有一個直接後果**（1.6.4 會用它解釋一個事故）：

> **你標 `@Component` 的 Filter，預設會排在 Spring Security【後面】。**
> 也就是說它跑的時候，`SecurityContextHolder` 裡**已經有身分了**——
> 這常常是好事，但也是「為什麼我的 Filter 跑了兩次」的成因之一。

📌 **想把自己的 Filter 排在 Spring Security 前面**，要明確指定 order：

```java
package com.example.lab09.ch01;

import jakarta.servlet.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.*;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

@Configuration
public class TraceIdFilterConfig {

    /** 產生 traceId 的 filter：必須比 Spring Security 早跑，
     *  這樣連「被 401 擋掉的請求」也會有 traceId（02 站 05 章的日誌相關性） */
    static class TraceIdFilter extends OncePerRequestFilter {
        @Override
        protected void doFilterInternal(HttpServletRequest req,
                                        jakarta.servlet.http.HttpServletResponse res,
                                        FilterChain chain) throws ServletException, IOException {
            org.slf4j.MDC.put("traceId", UUID.randomUUID().toString().substring(0, 8));
            try { chain.doFilter(req, res); }
            finally { org.slf4j.MDC.clear(); }
        }
    }

    @Bean
    FilterRegistrationBean<TraceIdFilter> traceIdFilter() {
        FilterRegistrationBean<TraceIdFilter> r = new FilterRegistrationBean<>(new TraceIdFilter());
        r.setOrder(-200);                       // ★ 比 -100 小 = 比 Spring Security 早
        return r;
    }
}
```

⚠️ **注意這裡用 `FilterRegistrationBean` 包起來、而且 `TraceIdFilter` 沒有標 `@Component`。**
這是 1.6.4 那個「跑兩次」事故的正確寫法。

### 1.2.2 `DelegatingFilterProxy`：為什麼要有一個殼

**Servlet 容器不認識 Spring 的 bean。** 容器啟動 Filter 的時機比 Spring 容器早，
而且它用的是 `Class.newInstance()` 的思維——**沒有依賴注入**。

`DelegatingFilterProxy` 解決這件事：

```
容器啟動時   → 建立 DelegatingFilterProxy（一個空殼，只記得一個 bean 名字）
第一次請求時 → 去 Spring 容器裡查名為 springSecurityFilterChain 的 bean
             → 之後每個請求都轉發給它
```

📌 **這就是為什麼那個 bean 的名字不能改**。
如果你在非 Boot 的環境自己註冊，名字寫錯會拿到：

```
NoSuchBeanDefinitionException: No bean named 'springSecurityFilterChain' available
```

**Boot 幫你做掉了這一步**（`SecurityFilterAutoConfiguration`），所以你不會碰到。

### 1.2.3 `FilterChainProxy` 與 `VirtualFilterChain`

`FilterChainProxy` 做兩件事：

**① 選 chain**（1.7 的主題）：

```java
// FilterChainProxy 的核心邏輯（示意）
private List<Filter> getFilters(HttpServletRequest request) {
    for (SecurityFilterChain chain : filterChains) {
        if (chain.matches(request)) {      // ★ 第一條匹配的就回傳
            return chain.getFilters();
        }
    }
    return null;                            // 沒有任何一條匹配 → 完全不經過 Security
}
```

**② 用 `VirtualFilterChain` 跑那條 chain**：

`VirtualFilterChain` 是 `FilterChainProxy` 的一個內部類，
它假裝自己是 Servlet 的 `FilterChain`，但實際上是在走**那條 SecurityFilterChain 上的 16 個 Filter**。
16 個都放行之後，它才呼叫**真正的**容器 `FilterChain`，讓請求繼續往 `DispatcherServlet` 走。

📌 **這就是為什麼 00 章 0.3.5 的堆疊長那樣**：

```
at com.example.lab09.fx.FilterExceptionScenario$TokenFilter.doFilterInternal(…)
at org.springframework.web.filter.OncePerRequestFilter.doFilter(…)
at org.springframework.security.web.FilterChainProxy$VirtualFilterChain.doFilter(…)   ← ★
at org.springframework.security.web.authentication.logout.LogoutFilter.doFilter(…)
at org.springframework.security.web.FilterChainProxy$VirtualFilterChain.doFilter(…)   ← ★
at org.springframework.web.filter.CorsFilter.doFilterInternal(…)
…
```

**每兩層就出現一次 `VirtualFilterChain.doFilter`**——那是它在「往下傳給下一個 Filter」。
**看到這個堆疊，就知道例外發生在 Security 的鏈上，而不是在 Controller 裡。**

**還有一件 `FilterChainProxy` 做的、但很少人知道的事**：

```java
// FilterChainProxy.doFilter（簡化）
public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) {
    boolean clearContext = request.getAttribute(FILTER_APPLIED) == null;
    if (!clearContext) { doFilterInternal(request, response, chain); return; }
    try {
        request.setAttribute(FILTER_APPLIED, Boolean.TRUE);
        doFilterInternal(request, response, chain);
    }
    finally {
        SecurityContextHolder.clearContext();          // ★ 一定會清
        request.removeAttribute(FILTER_APPLIED);
    }
}
```

⚠️ **`finally` 裡那一行 `clearContext()`，是「身分不會殘留在執行緒上」的保證。**
1.9.3 會實測它。

---

## 1.3 把軌跡打開：`TRACE` 日誌

### 1.3.1 一行設定

```yaml
logging:
  level:
    org.springframework.security: TRACE
```

**這一行是這一站投資報酬率最高的一行設定。**
Spring Security 6 的日誌品質非常好——它會明確告訴你**每一個 Filter 做了什麼決定**。

### 1.3.2 讀一份真實的軌跡

設定用的是 00 章 0.4.2 的 `S2_Roles`（`/api/admin/**` 要 `ROLE_ADMIN`），
請求是 **alice（`ROLE_USER`）打 `/api/admin/revenue`**——**應該被擋**：

```
FilterChainProxy : Trying to match request against DefaultSecurityFilterChain [RequestMatcher=any request, Filters=[…12 個…]] (1/1)
FilterChainProxy : Securing GET /api/admin/revenue
FilterChainProxy : Invoking DisableEncodeUrlFilter (1/12)
FilterChainProxy : Invoking WebAsyncManagerIntegrationFilter (2/12)
FilterChainProxy : Invoking SecurityContextHolderFilter (3/12)
FilterChainProxy : Invoking HeaderWriterFilter (4/12)
FilterChainProxy : Invoking CorsFilter (5/12)
FilterChainProxy : Invoking LogoutFilter (6/12)
  LogoutFilter   : Did not match request to Or [Ant [pattern='/logout', GET], Ant [pattern='/logout', POST], …]
FilterChainProxy : Invoking BasicAuthenticationFilter (7/12)
  BasicAuthenticationFilter : Found username 'alice' in Basic Authorization header
  ProviderManager            : Authenticating request with DaoAuthenticationProvider (1/1)
  DaoAuthenticationProvider  : Authenticated user
  BasicAuthenticationFilter  : Set SecurityContextHolder to UsernamePasswordAuthenticationToken [Principal=…User [Username=alice, …, Granted Authorities=[ROLE_USER]], …]
FilterChainProxy : Invoking RequestCacheAwareFilter (8/12)
FilterChainProxy : Invoking SecurityContextHolderAwareRequestFilter (9/12)
FilterChainProxy : Invoking AnonymousAuthenticationFilter (10/12)
  AnonymousAuthenticationFilter : Did not set SecurityContextHolder since already authenticated UsernamePasswordAuthenticationToken […alice…]
FilterChainProxy : Invoking ExceptionTranslationFilter (11/12)
FilterChainProxy : Invoking AuthorizationFilter (12/12)
  RequestMatcherDelegatingAuthorizationManager : Authorizing …
  RequestMatcherDelegatingAuthorizationManager : Checking authorization on … using AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]]
  ExceptionTranslationFilter : Sending UsernamePasswordAuthenticationToken […alice…] to access denied handler since access is denied
org.springframework.security.access.AccessDeniedException: Access Denied
	at org.springframework.security.web.access.intercept.AuthorizationFilter.doFilter(AuthorizationFilter.java:98)
	at org.springframework.security.web.FilterChainProxy$VirtualFilterChain.doFilter(FilterChainProxy.java:374)
	at org.springframework.security.web.access.ExceptionTranslationFilter.doFilter(ExceptionTranslationFilter.java:126)
	…
```

**這份日誌把整章的內容都寫出來了。逐段看**：

| 日誌行 | 它在說什麼 |
|---|---|
| `Trying to match request against … (1/1)` | **選 chain**（1.2.3 的 ①）。`(1/1)` 表示總共只有一條 |
| `Securing GET /api/admin/revenue` | 選中了，開始跑 |
| `Invoking XxxFilter (n/12)` | **這條 chain 上有 12 個 Filter**（不是 16 —— 因為關了 CSRF、沒開 formLogin） |
| `LogoutFilter : Did not match request to …` | 每個 Filter 都會說明「我為什麼沒做事」 |
| `Found username 'alice' in Basic Authorization header` | **第 7 個 Filter 才建立身分** |
| `ProviderManager : Authenticating request with DaoAuthenticationProvider (1/1)` | 02 章的主題：認證是委派給 provider 的 |
| `Set SecurityContextHolder to …` | ★ 身分被放進 `SecurityContextHolder` 的**那一刻** |
| `AnonymousAuthenticationFilter : Did not set … since already authenticated` | 第 10 個 Filter 想給匿名身分，發現已經有了就跳過 |
| `Checking authorization … using AuthorityAuthorizationManager[authorities=[ROLE_ADMIN]]` | ★ **授權規則被套用的那一刻**，而且它印出了規則本身 |
| `Sending … to access denied handler since access is denied` | ★ 401/403 的分界（1.8.2） |

**同一次啟動，換成匿名請求打 `permitAll` 的 `/api/hello`**：

```
FilterChainProxy : Invoking BasicAuthenticationFilter (7/12)
  BasicAuthenticationFilter : Did not process authentication request since failed to find username and password in Basic Authorization header
FilterChainProxy : Invoking AnonymousAuthenticationFilter (10/12)
  AnonymousAuthenticationFilter : Set SecurityContextHolder to AnonymousAuthenticationToken [Principal=anonymousUser, …, Granted Authorities=[ROLE_ANONYMOUS]]
FilterChainProxy : Invoking AuthorizationFilter (12/12)
  RequestMatcherDelegatingAuthorizationManager : Checking authorization on … using …AuthorizeHttpRequestsConfigurer$$Lambda…
FilterChainProxy : Secured GET /api/hello
```

**兩個新資訊**：

```
① 匿名請求也走完了全部 12 個 Filter  ← 00 章 0.5.2 那句「permitAll 前面 15 個照跑」的證據
② AnonymousAuthenticationFilter 這次【真的】設了身分：anonymousUser / ROLE_ANONYMOUS
   → 所以你的程式碼裡 SecurityContextHolder.getAuthentication() 幾乎【永遠不是 null】
   → 判斷「有沒有登入」不能寫 auth != null，要用 AuthenticationTrustResolver（1.8.2）
```

📌 **`Secured GET /api/hello` 這一行只在成功時出現**，
它表示「Security 這一段結束了，請求繼續往 `DispatcherServlet` 走」。
**看到 `Securing` 但沒看到 `Secured`，就表示請求在鏈上被擋掉了。**

> ⚠️ **TRACE 日誌是非同步輸出的**，偶爾會看到某一行（例如
> `Set SecurityContextHolder to AnonymousAuthenticationToken`）
> 出現在 `Secured` 之後。**看順序要以 `Invoking (n/12)` 那一系列為準。**

### 1.3.3 這份日誌能回答的五個問題

**這是實務上最常用的除錯清單**：

| 你的症狀 | 在日誌裡找 |
|---|---|
| 「我的設定好像沒生效」 | `Trying to match request against …` —— **看它選了哪一條 chain**（1.7.3 的事故） |
| 「為什麼是 401 不是 403」 | `Sending … to authentication entry point` vs `to access denied handler` |
| 「我的自訂 Filter 沒被呼叫」 | `Invoking … (n/N)` 那一串裡有沒有它；沒有就是沒加上去 |
| 「身分哪裡來的」 | `Set SecurityContextHolder to …` —— 哪個 Filter 印的，身分就是它建的 |
| 「權限規則到底是什麼」 | `using AuthorityAuthorizationManager[authorities=[…]]` —— **它會印出規則** |

### 1.3.4 ⚠️ 不要帶上正式環境

```
Set SecurityContextHolder to UsernamePasswordAuthenticationToken [Principal=…User [Username=alice, Password=[PROTECTED], …
```

**密碼欄位是 `[PROTECTED]`，Spring Security 有處理。**
但這份日誌仍然會印出：**使用者名稱、角色、來源 IP、session id、以及完整的授權規則**。

**正式環境用 `DEBUG` 就好**（保留 `Securing` / `Secured` / 決策結果，不印身分細節），
或者只在需要時臨時打開（`Actuator` 的 `/actuator/loggers` 可以動態改，02 站 05 章）。

---

## 1.4 十六個 Filter，一個一個看

### 1.4.1 先分成四組

**16 個一起背沒有意義。按「它們在做什麼」分成四組就好記了**：

```
【A. 基礎設施】不做認證也不做授權，只是把環境準備好
   1. DisableEncodeUrlFilter
   2. WebAsyncManagerIntegrationFilter
   3. SecurityContextHolderFilter          ★ 身分從 session 載入的地方
   4. HeaderWriterFilter                   ★ 安全標頭
   5. CorsFilter
   6. CsrfFilter

【B. 認證】建立身分。這一組是「你是誰」的答案來源
   7. LogoutFilter                          （反過來：把身分拿掉）
   8. UsernamePasswordAuthenticationFilter  ★ 表單登入
   9. DefaultLoginPageGeneratingFilter
  10. DefaultLogoutPageGeneratingFilter
  11. BasicAuthenticationFilter             ★ HTTP Basic
      （05 章你的 JwtAuthenticationFilter 會插在這一組）

【C. 補完】把前面沒處理的收尾
  12. RequestCacheAwareFilter
  13. SecurityContextHolderAwareRequestFilter
  14. AnonymousAuthenticationFilter         ★ 沒身分的給一個匿名身分

【D. 授權與例外】
  15. ExceptionTranslationFilter            ★ 401 / 403 的分派中心
  16. AuthorizationFilter                   ★ 真正做授權判斷的地方
```

⚠️ **注意 D 組那兩個的順序**：`ExceptionTranslationFilter` 在 `AuthorizationFilter` **前面**。

**這不是筆誤，而是整個例外機制的關鍵**：

```
Filter 鏈是【巢狀】的，不是【平行】的
ExceptionTranslationFilter 在 AuthorizationFilter 之前 = 它【包住】了 AuthorizationFilter
所以 AuthorizationFilter 拋的例外，一定會經過 ExceptionTranslationFilter 的 catch
```

📌 **推論**：`ExceptionTranslationFilter` 只接得到**它後面**（更內層）那些 Filter 拋的例外。
**這就是 00 章 0.3.5 那三個變體的完整解釋**，1.8.4 會再驗證一次。

### 1.4.2 逐個說明與擴充點

| # | Filter | 職責 | 可替換 / 可設定的地方 | 章節 |
|---|---|---|---|---|
| 1 | `DisableEncodeUrlFilter` | 關掉 `response.encodeURL()` 把 `;jsessionid=` 塞進網址 | `sessionManagement(s -> s.enableSessionUrlRewriting(true))`（**設 `true` 才會把這個 Filter 拿掉**，預設 `false`） | 04 |
| 2 | `WebAsyncManagerIntegrationFilter` | 讓 `Callable` / `WebAsyncTask` 的執行緒也拿得到 `SecurityContext` | —— | 1.9 |
| 3 | `SecurityContextHolderFilter` | **載入**：從 `SecurityContextRepository` 取出 `SecurityContext` 放進 `ThreadLocal` | `securityContext().securityContextRepository(...)` | **1.5** |
| 4 | `HeaderWriterFilter` | 寫安全標頭 | `headers(h -> h.contentSecurityPolicy(...))` | 07 |
| 5 | `CorsFilter` | 處理跨來源與 preflight | `cors(c -> c.configurationSource(...))` | 07 |
| 6 | `CsrfFilter` | 驗證 CSRF token | `csrf(c -> c.csrfTokenRepository(...))` | 04 |
| 7 | `LogoutFilter` | 攔 `/logout`，清 session / cookie / context | `logout(l -> l.addLogoutHandler(...))` | 04、05 |
| 8 | `UsernamePasswordAuthenticationFilter` | 攔 `POST /login`，讀表單欄位做認證 | `formLogin(f -> f.loginProcessingUrl(...).successHandler(...))` | 02 |
| 9 | `DefaultLoginPageGeneratingFilter` | 生成登入頁 HTML | 一旦設了 `.loginPage("/my-login")` 就**消失** | 02 |
| 10 | `DefaultLogoutPageGeneratingFilter` | 生成登出確認頁 | 同上 | 02 |
| 11 | `BasicAuthenticationFilter` | 解析 `Authorization: Basic` | `httpBasic(b -> b.authenticationEntryPoint(...))` | 02 |
| 12 | `RequestCacheAwareFilter` | 登入後導回原本要去的頁面 | `requestCache(r -> r.requestCache(new NullRequestCache()))` | 04 |
| 13 | `SecurityContextHolderAwareRequestFilter` | 包一層 request，讓 `request.getUserPrincipal()`、`request.isUserInRole()` 能用 | `servletApi(...)` | —— |
| 14 | `AnonymousAuthenticationFilter` | 沒身分時塞一個 `anonymousUser` / `ROLE_ANONYMOUS` | `anonymous(a -> a.principal("guest"))` | 1.8.2 |
| 15 | `ExceptionTranslationFilter` | catch 兩種例外，分派給 entry point 或 denied handler | `exceptionHandling(e -> e.authenticationEntryPoint(...))` | **1.8** |
| 16 | `AuthorizationFilter` | 執行授權規則 | `authorizeHttpRequests(...)` | 03 |

⚠️ **第 14 個值得單獨講，因為它會影響你寫的每一段判斷身分的程式碼**：

```java
// ❌ 這樣寫幾乎永遠是 true
Authentication auth = SecurityContextHolder.getContext().getAuthentication();
if (auth != null) { /* 「已登入」 */ }

// ❌ 這樣寫也不對：匿名身分的 isAuthenticated() 是 true
if (auth.isAuthenticated()) { /* 「已登入」 */ }

// ✅ 正確：用 AuthenticationTrustResolver
private final AuthenticationTrustResolver resolver = new AuthenticationTrustResolverImpl();
if (auth != null && !resolver.isAnonymous(auth)) { /* 真的登入了 */ }
```

**1.3.2 的日誌證明了這件事**：匿名請求的 `Authentication` 是
`AnonymousAuthenticationToken [Principal=anonymousUser, …, Authenticated=true]`——
**`Authenticated=true`。**

📌 **`AnonymousAuthenticationFilter` 存在的理由是「消除 null 分支」**：
有了它，授權規則可以統一寫成「這個身分有沒有 `ROLE_X`」，
不用到處寫 `if (auth == null)`。**代價就是上面那三行的陷阱。**

### 1.4.3 實測：設定怎麼改變這份清單

**這是這一節最重要的一張表。** 四種設定加上 Boot 預設，各自產生的 chain：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

public class ChainShapeScenarios {

    /** f1：只留授權規則 + Basic，關掉 CSRF */
    @Configuration @Profile("f1")
    static class F1 {
        @Bean SecurityFilterChain c(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .httpBasic(Customizer.withDefaults())
                       .csrf(c -> c.disable())
                       .build();
        }
    }

    /** f2：表單登入 + Basic（等同 Boot 自動配的那條，只是自己寫出來） */
    @Configuration @Profile("f2")
    static class F2 {
        @Bean SecurityFilterChain c(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .formLogin(Customizer.withDefaults())
                       .httpBasic(Customizer.withDefaults())
                       .build();
        }
    }

    /** f3：無狀態 API（05 章 JWT 的形狀） */
    @Configuration @Profile("f3")
    static class F3 {
        @Bean SecurityFilterChain c(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                       .csrf(c -> c.disable())
                       .httpBasic(Customizer.withDefaults())
                       .build();
        }
    }

    /** f4：能關的全關 —— 最小的一條 chain 長什麼樣 */
    @Configuration @Profile("f4")
    static class F4 {
        @Bean SecurityFilterChain c(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().permitAll())
                       .csrf(c -> c.disable())
                       .headers(h -> h.disable())
                       .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                       .anonymous(a -> a.disable())
                       .requestCache(r -> r.disable())
                       .securityContext(s -> s.disable())
                       .exceptionHandling(e -> e.disable())
                       .servletApi(s -> s.disable())
                       .logout(l -> l.disable())
                       .build();
        }
    }
}
```

**印出來的工具**（00 章 0.8.4 的 `SecurityChainReporter` 的測試版）：

```java
package com.example.lab09.ch01;

import jakarta.servlet.Filter;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;

class ChainShapeTest {

    static void dump(String label, FilterChainProxy proxy) {
        System.out.println("\n═══ " + label + " ═══");
        int ci = 0;
        for (SecurityFilterChain chain : proxy.getFilterChains()) {
            List<Filter> fs = chain.getFilters();
            String matcher = chain.toString().replaceAll(".*RequestMatcher=(.*?), Filters=.*", "$1");
            System.out.println("  chain[" + (ci++) + "] matcher=" + matcher + " filters=" + fs.size());
            System.out.println("    " + fs.stream().map(f -> f.getClass().getSimpleName()).toList());
        }
    }

    @Nested @SpringBootTest @ActiveProfiles("f1") class F1 {
        @Autowired FilterChainProxy p;
        @Test void t() { dump("1.4.3 f1 授權規則 + Basic + csrf disable", p); }
    }
    @Nested @SpringBootTest @ActiveProfiles("f2") class F2 {
        @Autowired FilterChainProxy p;
        @Test void t() { dump("1.4.3 f2 formLogin + httpBasic（等同 Boot 預設）", p); }
    }
    @Nested @SpringBootTest @ActiveProfiles("f3") class F3 {
        @Autowired FilterChainProxy p;
        @Test void t() { dump("1.4.3 f3 STATELESS + csrf disable + Basic", p); }
    }
    @Nested @SpringBootTest @ActiveProfiles("f4") class F4 {
        @Autowired FilterChainProxy p;
        @Test void t() { dump("1.4.3 f4 能關的全關", p); }
    }
}
```

**實測輸出**：

```
═══ 1.4.3 f2 formLogin + httpBasic（等同 Boot 預設）═══
  chain[0] matcher=any request filters=16
    [DisableEncodeUrlFilter, WebAsyncManagerIntegrationFilter, SecurityContextHolderFilter, HeaderWriterFilter,
     CorsFilter, CsrfFilter, LogoutFilter, UsernamePasswordAuthenticationFilter, DefaultLoginPageGeneratingFilter,
     DefaultLogoutPageGeneratingFilter, BasicAuthenticationFilter, RequestCacheAwareFilter,
     SecurityContextHolderAwareRequestFilter, AnonymousAuthenticationFilter, ExceptionTranslationFilter, AuthorizationFilter]

═══ 1.4.3 f1 授權規則 + Basic + csrf disable ═══
  chain[0] matcher=any request filters=12
    [DisableEncodeUrlFilter, WebAsyncManagerIntegrationFilter, SecurityContextHolderFilter, HeaderWriterFilter,
     CorsFilter, LogoutFilter, BasicAuthenticationFilter, RequestCacheAwareFilter,
     SecurityContextHolderAwareRequestFilter, AnonymousAuthenticationFilter, ExceptionTranslationFilter, AuthorizationFilter]

═══ 1.4.3 f3 STATELESS + csrf disable + Basic ═══
  chain[0] matcher=any request filters=13
    [DisableEncodeUrlFilter, WebAsyncManagerIntegrationFilter, SecurityContextHolderFilter, HeaderWriterFilter,
     CorsFilter, LogoutFilter, BasicAuthenticationFilter, RequestCacheAwareFilter,
     SecurityContextHolderAwareRequestFilter, AnonymousAuthenticationFilter, SessionManagementFilter,
     ExceptionTranslationFilter, AuthorizationFilter]

═══ 1.4.3 f4 能關的全關 ═══
  chain[0] matcher=any request filters=5
    [DisableEncodeUrlFilter, WebAsyncManagerIntegrationFilter, CorsFilter, SessionManagementFilter, AuthorizationFilter]
```

**整理成一張對照表**：

| 設定 | Filter 數 | 跟 Boot 預設（16）的差異 |
|---|---|---|
| **Boot 自動組態**（不寫任何 chain bean） | **16** | 基準 |
| `f2`：`formLogin` + `httpBasic` | **16** | **一模一樣**——Boot 的預設就是這兩行 |
| `f1`：`httpBasic` + `csrf.disable()` | **12** | **少 4 個**：`CsrfFilter`、`UsernamePasswordAuthenticationFilter`、兩個 `Default*PageGeneratingFilter` |
| `f3`：`f1` + `STATELESS` | **13** | 比 `f1` **多 1 個**：`SessionManagementFilter` |
| `f4`：能關的全關 | **5** | 只剩 `DisableEncodeUrl`、`WebAsyncManagerIntegration`、`Cors`、`SessionManagement`、`Authorization` |

⚠️ **四個要注意的觀察**：

**① `f2` 跟 Boot 預設一字不差。**
這證明了 00 章 0.5.1 那句話：Boot 的自動組態就是幫你寫了
`formLogin(withDefaults()).httpBasic(withDefaults())`。
**所以「我自己寫一條 chain」的成本是：你要自己補上這兩行。**

**② `formLogin` 一個開關差 3 個 Filter**（`UsernamePasswordAuthenticationFilter` +
兩個 `Default*PageGeneratingFilter`）。
**這解釋了「我自己寫了 chain，然後 `/login` 變成 404」**——
那個登入頁本來就是 `DefaultLoginPageGeneratingFilter` 生成的，關掉 `formLogin` 它就不見了。

**③ `STATELESS` 反而【多】一個 Filter。**
很多人以為「無狀態 = 拿掉 session 相關的東西」，實際上：

```
不設 sessionCreationPolicy  → 用預設的 IF_REQUIRED，SessionManagementFilter 不需要出現
明確設成 STATELESS          → 加上 SessionManagementFilter 來【強制】不建立 session
```

**它是一個「執行這個政策」的 Filter，不是一個「使用 session」的 Filter。**

**④ `f4` 關掉了那麼多東西，`AuthorizationFilter` 還在。**
因為 `f4` 仍然呼叫了 `authorizeHttpRequests(a -> a.anyRequest().permitAll())`——
**即使規則是「全部放行」，那個 Filter 還是會執行、還是會做一次判斷。**

⚠️ **那如果【完全不呼叫】`authorizeHttpRequests` 呢？** 這是一個值得單獨做的實驗：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

/** f8：完全不呼叫 authorizeHttpRequests */
@Configuration
@Profile("f8")
public class F8_NoAuthorizeRules {

    @Bean
    SecurityFilterChain c(HttpSecurity http) throws Exception {
        return http.csrf(x -> x.disable())
                   .httpBasic(Customizer.withDefaults())
                   .build();
    }
}
```

```
═══ 1.4.3 f8 完全不呼叫 authorizeHttpRequests ═══
  chain[0] matcher=any request filters=11
    [DisableEncodeUrlFilter, WebAsyncManagerIntegrationFilter, SecurityContextHolderFilter, HeaderWriterFilter,
     CorsFilter, LogoutFilter, BasicAuthenticationFilter, RequestCacheAwareFilter,
     SecurityContextHolderAwareRequestFilter, AnonymousAuthenticationFilter, ExceptionTranslationFilter]

  匿名 GET /api/orders/1002 → 200 {"id":"1002","ownerUsername":"bob","amount":99000.00,"status":"PAID"}
```

**`AuthorizationFilter` 不見了，而且所有端點全部開放。**

🔴 **這比 00 章 0.3.2 那個 `permitAll()` 更危險，因為它連 TODO 都沒有。**
`permitAll()` 至少是一個「有人做過決定」的痕跡；
**「忘了寫授權規則」看起來就只是一段比較短的設定，而且啟動時沒有任何警告。**

📌 **這正是 00 章 0.8.4 那個 `SecurityChainReporter` 要抓的第五種錯誤**：

```
chain 上沒有 AuthorizationFilter → 這條 chain 覆蓋的路徑【完全沒有授權】
```

**把它加進去**（00 章 0.8.4 的 bean 裡）：

```java
if (filters.stream().noneMatch(f -> f instanceof
        org.springframework.security.web.access.intercept.AuthorizationFilter)) {
    sb.append("      🔴 這條 chain 沒有 AuthorizationFilter —— 它覆蓋的路徑完全沒有授權檢查
");
}
```

**整理一下「最小形狀」的兩個版本**：

```
f4（有授權規則，其他全關）  5 個  ← Spring Security 還在做事的最小形狀
f8（連授權規則都沒有）      11 個 ← 🔴 Filter 比較多，但【等於沒有 Security】
```

⚠️ **Filter 數量多不代表比較安全。** `f8` 有 11 個 Filter、`f4` 只有 5 個，
但 `f4` 至少會執行授權判斷，`f8` 完全不會。
**要看的是「`AuthorizationFilter` 在不在」以及「它的規則是什麼」。**

### 1.4.4 這張表的實務用法

**當你的設定「好像沒生效」，第一件事是把 chain 印出來，數 Filter。**

```
症狀                                    在 chain 上找
──────────────────────────────────────────────────────────────
POST 一直 403                          → CsrfFilter 還在嗎？（在 = CSRF 沒關）
/login 回 404                          → DefaultLoginPageGeneratingFilter 不見了
帶 Authorization: Basic 沒有用          → BasicAuthenticationFilter 不在鏈上
安全標頭全都不見                         → HeaderWriterFilter 不見了（headers().disable()）
                                          或整個路徑被 web.ignoring() 排除（1.7.5）
CORS 預檢一直失敗                        → CorsFilter 不在鏈上（沒開 .cors()）
自訂的 JWT filter 沒被呼叫                → 它根本沒有出現在清單裡
```

---

## 1.5 `SecurityContext` 的載入與儲存

### 1.5.1 `SecurityContextHolderFilter` 做了什麼

**它是第 3 個 Filter，職責只有一句話**：

```
從 SecurityContextRepository 把 SecurityContext 讀出來，放進 SecurityContextHolder
```

**注意「讀出來」——沒有「寫回去」。** 這是 Spring Security 6 的核心改動。

**5.x 的版本叫 `SecurityContextPersistenceFilter`**，它做兩件事：

```java
// 5.x：SecurityContextPersistenceFilter（示意）
public void doFilter(...) {
    SecurityContext contextBeforeChainExecution = repo.loadContext(holder);
    try {
        SecurityContextHolder.setContext(contextBeforeChainExecution);
        chain.doFilter(...);
    } finally {
        SecurityContext contextAfterChainExecution = SecurityContextHolder.getContext();
        SecurityContextHolder.clearContext();
        repo.saveContext(contextAfterChainExecution, holder.getRequest(), holder.getResponse());
        // ★ 每一個請求結束都存一次
    }
}
```

**6.x 的版本**：

```java
// 6.x：SecurityContextHolderFilter（示意）
protected void doFilterInternal(...) {
    Supplier<SecurityContext> deferredContext = repo.loadDeferredContext(request);
    try {
        SecurityContextHolder.setDeferredContext(deferredContext);
        chain.doFilter(request, response);
    } finally {
        SecurityContextHolder.clearContext();
        // ★ 沒有 saveContext
    }
}
```

**兩個改動**：

| 改動 | 為什麼 |
|---|---|
| **不再自動 save** | 舊行為每個請求都寫一次 session，即使身分沒變 |
| **改成 `loadDeferredContext`（延遲載入）** | 舊行為每個請求都讀一次 session；現在只有真的有人呼叫 `getContext()` 才讀 |

📌 **第二點對無狀態 API 的意義**：
一支 `permitAll` 的健康檢查端點，**現在完全不會碰 session**。

### 1.5.2 那誰負責存？

**在正常的登入流程裡，是那些認證 Filter 自己存的**：

```
UsernamePasswordAuthenticationFilter 登入成功
  → successfulAuthentication(...)
    → this.securityContextRepository.saveContext(context, request, response)   ★
```

**所以你用 `formLogin` / `httpBasic` / `oauth2Login` 都不會有問題**——
它們內部都呼叫了 `saveContext`。

⚠️ **會有問題的是「你自己在 Controller 裡設身分」的情況**，
也就是 00 章 0.3.6 那個事故。**再看一次那組實測**：

```
═══ 1.5.2 只設 SecurityContextHolder（Spring Security 5 的寫法）═══
  POST /sc/login                     → 200  {"loggedInAs":"alice"}
  拿到的 cookie: null
  帶著 cookie GET /sc/whoami           → 200  {"authentication":"anonymousUser / AnonymousAuthenticationToken"}
  帶著 cookie GET /sc/secret           → 401

═══ 1.5.2 多呼叫一次 repo.saveContext(...) ═══
  POST /sc/login                     → 200  {"loggedInAs":"alice"}
  拿到的 cookie: JSESSIONID=807E311F57D1B857A045B1EA0A02E8E4
  帶著 cookie GET /sc/whoami           → 200  {"authentication":"alice / UsernamePasswordAuthenticationToken"}
  帶著 cookie GET /sc/secret           → 200  {"secret":42}
```

**本課建議的寫法**（把 repository 注入進來，而不是自己 `new`）：

```java
package com.example.lab09.ch01;

import jakarta.servlet.http.*;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.*;
import org.springframework.context.annotation.Profile;
import org.springframework.security.web.context.*;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@Profile("manual")                   // ← 跟下面那個 ManualLoginConfig 是一組（00 章 0.3.0.1）
public class ManualLoginController {

    private final AuthenticationManager authenticationManager;
    private final SecurityContextRepository securityContextRepository;

    public ManualLoginController(AuthenticationManager authenticationManager,
                                 SecurityContextRepository securityContextRepository) {
        this.authenticationManager = authenticationManager;
        this.securityContextRepository = securityContextRepository;
    }

    @PostMapping("/login-api")
    public Map<String, Object> login(@RequestParam String username, @RequestParam String password,
                                     HttpServletRequest req, HttpServletResponse res) {
        Authentication auth = authenticationManager.authenticate(
                new UsernamePasswordAuthenticationToken(username, password));

        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(auth);
        SecurityContextHolder.setContext(ctx);
        securityContextRepository.saveContext(ctx, req, res);      // ★ 不能省

        return Map.of("loggedInAs", auth.getName(),
                      "authorities", auth.getAuthorities().toString());
    }
}
```

**兩個 bean 都要自己註冊**：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.web.context.*;

@Configuration
@Profile("manual")                   // ← 實驗專案要隔離（00 章 0.3.0.1）
public class ManualLoginConfig {

    /** ⚠️ Spring Security 6 不會自動把 AuthenticationManager 放進容器 */
    @Bean
    AuthenticationManager authenticationManager(AuthenticationConfiguration cfg) throws Exception {
        return cfg.getAuthenticationManager();
    }

    /** 用 Delegating 版本：同時支援 session 與 request attribute，
     *  跟 HttpSecurity 內部用的那一個保持一致 */
    @Bean
    SecurityContextRepository securityContextRepository() {
        return new DelegatingSecurityContextRepository(
                new RequestAttributeSecurityContextRepository(),
                new HttpSessionSecurityContextRepository());
    }
}
```

📌 **為什麼要用 `DelegatingSecurityContextRepository`**：
`HttpSecurity` 從 6.0 起，內部預設就是這個組合。
只用 `HttpSessionSecurityContextRepository` 的話，
**同一個請求裡後續的 Filter 讀不到你剛設的身分**（因為它們讀的是 request attribute）。

### 1.5.3 遷移期的逃生門：`requireExplicitSave(false)`

**如果你在升級一個大專案，可以先把舊行為打開**：

```java
http.securityContext(sc -> sc.requireExplicitSave(false));
```

**這會把 `SecurityContextHolderFilter` 換回 `SecurityContextPersistenceFilter`**（自動存）。

⚠️ **它在 Spring Security 6 已經標記為 `@Deprecated`**，
用途只有一個：**讓你的升級可以分兩步做**（先升版、再改寫法）。
**不要當成長期方案。**

**驗證它有沒有生效，就看 chain**：

```
requireExplicitSave(true)（預設） → 第 3 個是 SecurityContextHolderFilter
requireExplicitSave(false)        → 第 3 個是 SecurityContextPersistenceFilter
```

### 1.5.4 無狀態 API 該用哪個 repository

**05 章的 JWT 會用到這個決定，先講清楚**：

| Repository | 存在哪 | 適用 |
|---|---|---|
| `HttpSessionSecurityContextRepository` | HTTP session | 傳統網頁登入（04 章） |
| `RequestAttributeSecurityContextRepository` | 這一個 request 的 attribute | 一個請求內傳遞，不跨請求 |
| `NullSecurityContextRepository` | **不存** | **完全無狀態的 API**（JWT） |
| `DelegatingSecurityContextRepository` | 委派給多個 | 6.x 的預設組合 |

**無狀態 API 的標準寫法**：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.NullSecurityContextRepository;

@Configuration
@Profile("sless")                    // ← 實驗專案要隔離（00 章 0.3.0.1）
public class StatelessApiConfig {

    @Bean
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        return http
            .securityMatcher("/api/**")
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .securityContext(sc -> sc.securityContextRepository(new NullSecurityContextRepository()))
            .csrf(c -> c.disable())          // ★ 前提：身分不靠 cookie 攜帶（00 章 0.5.6）
            .build();
    }
}
```

⚠️ **`SessionCreationPolicy.STATELESS` 與 `NullSecurityContextRepository` 是兩件事**：

```
STATELESS                    → 不【建立】 session（但如果 session 已經存在，還是讀得到）
NullSecurityContextRepository → 不【讀也不寫】 SecurityContext
```

**兩個都設才是真的無狀態。** 05 章 5.6 會用實測比較「只設一個」的後果。

---

## 1.6 順序：自訂 Filter 該插在哪

### 1.6.1 三個方法

```java
http.addFilterBefore(myFilter, XxxFilter.class)   // 排在 XxxFilter 【前面】
    .addFilterAfter(myFilter, XxxFilter.class)    // 排在 XxxFilter 【後面】
    .addFilterAt(myFilter, XxxFilter.class);      // 排在跟 XxxFilter 【同一個位置】
```

**第二個參數是一個「位置的名字」**——Spring Security 內部維護了一份
`FilterOrderRegistration`，把每個內建 Filter 對應到一個整數順序。
你傳進去的 class 只是用來查那個整數。

⚠️ **所以第二個參數必須是「Spring Security 認識的 Filter 類別」**，
傳一個自己寫的類別會拿到：

```
IllegalArgumentException: The Filter class com.example.MyOtherFilter does not have a registered order
```

### 1.6.2 實測：三個方法各排到哪

```java
package com.example.lab09.ch01;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

public class PlacementScenario {

    /** 一個什麼都不做、只是讓我們看得到它排在哪的 Filter */
    static class MyFilter extends OncePerRequestFilter {
        private final String tag;
        MyFilter(String tag) { this.tag = tag; }

        @Override
        protected void doFilterInternal(HttpServletRequest q, HttpServletResponse s, FilterChain c)
                throws ServletException, IOException { c.doFilter(q, s); }

        @Override public String toString() { return "MyFilter[" + tag + "]"; }
    }

    @Configuration
    @Profile("place")
    static class Cfg {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().permitAll())
                       .csrf(c -> c.disable())
                       .httpBasic(Customizer.withDefaults())
                       .formLogin(Customizer.withDefaults())
                       .addFilterBefore(new MyFilter("before-Basic"),  BasicAuthenticationFilter.class)
                       .addFilterAfter(new MyFilter("after-Basic"),    BasicAuthenticationFilter.class)
                       .addFilterAt(new MyFilter("at-UsernamePassword"), UsernamePasswordAuthenticationFilter.class)
                       .build();
        }
    }
}
```

```
═══ 1.6.2 addFilterBefore / After / At 的結果 ═══
   1. DisableEncodeUrlFilter
   2. WebAsyncManagerIntegrationFilter
   3. SecurityContextHolderFilter
   4. HeaderWriterFilter
   5. CorsFilter
   6. LogoutFilter
   7. ★ MyFilter[at-UsernamePassword]
   8. UsernamePasswordAuthenticationFilter          ← ⚠️ 它還在
   9. DefaultLoginPageGeneratingFilter
  10. DefaultLogoutPageGeneratingFilter
  11. ★ MyFilter[before-Basic]
  12. BasicAuthenticationFilter
  13. ★ MyFilter[after-Basic]
  14. RequestCacheAwareFilter
  15. SecurityContextHolderAwareRequestFilter
  16. AnonymousAuthenticationFilter
  17. ExceptionTranslationFilter
  18. AuthorizationFilter
```

### 1.6.3 ⚠️ `addFilterAt` 不會取代任何東西

**看第 7 與第 8 行**：

```
 7. ★ MyFilter[at-UsernamePassword]
 8. UsernamePasswordAuthenticationFilter        ← 原本的還在
```

**這是一個很多人誤解的 API。** `addFilterAt` 的語意是
「**跟它同一個順序值**」，不是「**取代它**」。
兩個 Filter 順序值一樣時，**它們都會執行**，而相對順序由排序演算法決定（實測是新的在前）。

📌 **如果你真的要取代**（例如自訂的表單登入 Filter），要**先關掉原本的**：

```java
http.formLogin(f -> f.disable())                    // ★ 先把原本那個拿掉
    .addFilterAt(new MyLoginFilter(), UsernamePasswordAuthenticationFilter.class);
```

**不然你會得到兩個都在跑的登入 Filter**——症狀通常是
「登入好像成功了，但又被另一個 Filter 重新處理一次」。

### 1.6.4 事故：`@Component` + `addFilterBefore` = 跑兩次

**這是自訂 Filter 最常見的事故，而且它會靜默地讓你的 Filter 執行兩次。**

**成因是 1.2.1 那兩個事實的組合**：

```
① Spring Boot 會把容器裡【每一個 Filter 型別的 bean】自動註冊到 Servlet 容器
   （ServletContextInitializerBeans 做的）
② 你又用 addFilterBefore 把同一個實例加到 Security 的 chain 上
→ 同一個 Filter 被註冊在【兩個地方】
```

**實測**（兩種寫法各測一次）：

```java
package com.example.lab09.ch01;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.*;

public class DoubleRegistrationScenario {

    /** ① 繼承 OncePerRequestFilter 的版本 */
    @Component
    @Profile("dup")
    public static class OnceFilter extends OncePerRequestFilter {
        @Override
        protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
                throws ServletException, IOException {
            bump(req, "once", new Throwable().getStackTrace()[2].getClassName());
            chain.doFilter(req, res);
        }
    }

    /** ② 直接實作 Filter 的版本（很多人自訂 JWT filter 是這樣寫的） */
    @Component
    @Profile("dup")
    public static class PlainFilter implements Filter {
        @Override
        public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
                throws ServletException, IOException {
            bump((HttpServletRequest) req, "plain", new Throwable().getStackTrace()[1].getClassName());
            chain.doFilter(req, res);
        }
    }

    /** 把「這個請求裡我被呼叫的位置」記進 request attribute */
    @SuppressWarnings("unchecked")
    static void bump(HttpServletRequest req, String key, String caller) {
        List<String> hits = (List<String>) req.getAttribute("hits." + key);
        if (hits == null) { hits = new ArrayList<>(); req.setAttribute("hits." + key, hits); }
        hits.add(caller.substring(caller.lastIndexOf('.') + 1));
    }

    @Configuration
    @Profile("dup")
    static class Cfg {
        @Bean SecurityFilterChain chain(HttpSecurity http, OnceFilter once, PlainFilter plain) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().permitAll())
                       .csrf(c -> c.disable())
                       .httpBasic(Customizer.withDefaults())
                       .addFilterBefore(once,  BasicAuthenticationFilter.class)    // ← 又註冊了一次
                       .addFilterBefore(plain, BasicAuthenticationFilter.class)    // ← 又註冊了一次
                       .build();
        }
    }

    @RestController
    @Profile("dup")
    static class Probe {
        @GetMapping("/dup/probe")
        public Map<String, Object> probe(HttpServletRequest req) {
            return Map.of("OncePerRequestFilter 跑過的位置", req.getAttribute("hits.once"),
                          "Filter 跑過的位置",              req.getAttribute("hits.plain"));
        }
    }
}
```

```
═══ 1.6.4 一次請求裡，兩個自訂 Filter 各跑了幾次 ═══
  {"OncePerRequestFilter 跑過的位置":["FilterChainProxy$VirtualFilterChain"],
   "Filter 跑過的位置":["FilterChainProxy$VirtualFilterChain","ApplicationFilterChain"]}

  security chain 裡的 filter:
    - DisableEncodeUrlFilter
    - WebAsyncManagerIntegrationFilter
    - SecurityContextHolderFilter
    - HeaderWriterFilter
    - CorsFilter
    - LogoutFilter
    - OnceFilter          ← 在
    - PlainFilter         ← 在
    - BasicAuthenticationFilter
    - RequestCacheAwareFilter
    - SecurityContextHolderAwareRequestFilter
    - AnonymousAuthenticationFilter
    - ExceptionTranslationFilter
    - AuthorizationFilter

  servlet 容器層註冊的 filter:
    - requestContextFilter                       → OrderedRequestContextFilter
    - Tomcat WebSocket (JSR356) Filter           → WsFilter
    - doubleRegistrationScenario.PlainFilter     → …DoubleRegistrationScenario$PlainFilter   ← ★ 也在
    - characterEncodingFilter                    → OrderedCharacterEncodingFilter
    - springSecurityFilterChain                  → DelegatingFilterProxyRegistrationBean$1
    - doubleRegistrationScenario.OnceFilter      → …DoubleRegistrationScenario$OnceFilter    ← ★ 也在
    - formContentFilter                          → OrderedFormContentFilter
```

**三件事被證明了**：

```
① 兩個 Filter 都被註冊了【兩次】（security chain 一次 + servlet 容器一次）
② PlainFilter 真的跑了【兩次】
   一次在 VirtualFilterChain（Security 的鏈）
   一次在 ApplicationFilterChain（Tomcat 的鏈）
③ OnceFilter 只跑了【一次】—— OncePerRequestFilter 的「已經跑過」旗標救了它
```

⚠️ **注意 ② 的順序**：`VirtualFilterChain` 在前、`ApplicationFilterChain` 在後。
這是 1.2.1 的推論——`@Component` Filter 的 order 是最低優先，
所以它在容器層排在 `springSecurityFilterChain`（-100）**後面**，
也就是**巢狀在 Security 鏈裡面**。

📌 **`OncePerRequestFilter` 為什麼救得了？**
它會在 request 上設一個屬性（預設是 `類名 + ".FILTERED"`），
第二次進來看到旗標就直接放行。**但這只在「同一個實例」時成立**——
如果你 `new` 了兩個不同的實例、或兩個不同的子類別，旗標名稱一樣但……
更常見的問題是：**旗標救得了「執行兩次」，救不了「順序不對」**。

**這個事故最惡劣的版本是 JWT filter**：

```
你的 JwtFilter 標了 @Component，又 addFilterBefore 進 chain
→ Security 鏈裡跑了一次（正確的位置，身分被設進 SecurityContextHolder）
→ 容器鏈裡【又跑了一次】（在 AuthorizationFilter 之後，設了也沒用）
→ 功能正常，但每個請求多解析一次 JWT（多一次簽章驗證的 CPU）
```

**功能不會壞，只是慢一倍——所以沒有人會發現。**

### 1.6.5 三個修法

**修法一（推薦）：不要標 `@Component`，直接在設定裡 `new`**

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@Profile("fixa")                     // ← 實驗專案要隔離（00 章 0.3.0.1）
public class FilterFixA {

    @Bean
    SecurityFilterChain chain(HttpSecurity http, SomeDependency dep) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                   .csrf(c -> c.disable())
                   // ★ 直接 new，它不是 bean → Boot 不會自動註冊到容器
                   .addFilterBefore(new MyJwtFilter(dep), UsernamePasswordAuthenticationFilter.class)
                   .build();
    }

    // 佔位：實際上是你的 JWT 解析器（05 章）
    static class SomeDependency {}
    static class MyJwtFilter extends org.springframework.web.filter.OncePerRequestFilter {
        MyJwtFilter(SomeDependency dep) {}
        @Override protected void doFilterInternal(jakarta.servlet.http.HttpServletRequest q,
                                                  jakarta.servlet.http.HttpServletResponse s,
                                                  jakarta.servlet.FilterChain c)
                throws jakarta.servlet.ServletException, java.io.IOException { c.doFilter(q, s); }
    }
}
```

**修法二：要當 bean（因為要注入東西），就明確關掉容器註冊**

```java
package com.example.lab09.ch01;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.*;
import org.springframework.stereotype.Component;
import jakarta.servlet.Filter;

@Configuration
@Profile("fixb")                     // ← 實驗專案要隔離（00 章 0.3.0.1）
public class FilterFixB {

    /** ★ 這個 bean 的存在，就是為了叫 Boot「不要」把 myFilter 註冊到 servlet 容器 */
    @Bean
    FilterRegistrationBean<Filter> disableAutoRegistration(MyFilterBean myFilter) {
        FilterRegistrationBean<Filter> reg = new FilterRegistrationBean<>(myFilter);
        reg.setEnabled(false);                 // ★ 關鍵
        return reg;
    }

    /** ⚠️ 它【是】一個 bean —— 這正是 1.6.4 那個事故的前提，也是本修法存在的理由 */
    @Component
    @Profile("fixb")
    static class MyFilterBean implements Filter {
        @Override public void doFilter(jakarta.servlet.ServletRequest q, jakarta.servlet.ServletResponse s,
                                       jakarta.servlet.FilterChain c)
                throws java.io.IOException, jakarta.servlet.ServletException { c.doFilter(q, s); }
    }
}
```

**修法三：本來就想要它在容器層跑（例如 traceId），那就不要加進 Security chain**

**用 1.2.1 那個 `FilterRegistrationBean` + `setOrder(-200)` 的寫法。**

### 1.6.6 一張「我的 Filter 該放哪」的決策表

| 你的 Filter 要做什麼 | 放哪 | 為什麼 |
|---|---|---|
| 產生 traceId / MDC | **容器層，order < -100** | 連被 401 擋掉的請求也要有 traceId |
| 記錄所有請求（access log） | **容器層，order < -100** | 要記到被 Security 擋掉的那些 |
| 解析 JWT、建立身分 | Security chain，`addFilterBefore(…, UsernamePasswordAuthenticationFilter.class)` | 必須在 `AuthorizationFilter` 之前 |
| 檢查 API key | 同上 | 同上 |
| 讀 `SecurityContextHolder` 做稽核 | Security chain，`addFilterAfter(…, AuthorizationFilter.class)` | 要在授權**通過之後**才知道結果 |
| 包裝 request/response（例如可重複讀 body） | **容器層，order < -100** | Security 自己也要讀 body（表單登入） |
| 統一 Filter 層的錯誤格式 | Security chain，最前面 | 1.8.5 |

---

## 1.7 多條 `SecurityFilterChain`

### 1.7.1 為什麼需要兩條

00 章 0.5.4 那個實測留下了一個問題：

```
同一支端點，Accept: text/html → 302 導向 /login
             Accept: application/json → 401
```

**一個同時有「後台網頁」與「REST API」的專案，需要的是兩種完全不同的行為**：

| | 後台網頁 | REST API |
|---|---|---|
| 未登入時 | **302** 導向登入頁 | **401** + JSON 錯誤 |
| 身分怎麼帶 | Cookie / Session | `Authorization: Bearer` |
| Session | 要 | **不要**（無狀態） |
| CSRF | **要開** | 可以關（00 章 0.5.6 的判準） |
| 登入頁 | 要 | 不需要 |

**這五列沒有一列可以「用一條 chain 同時滿足」**——所以要切成兩條。

### 1.7.2 `securityMatcher` 與比對規則

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@Profile("two")                      // ← 實驗專案要隔離（00 章 0.3.0.1）
public class TwoChains {

    /** 第一條：/api/** —— 無狀態、401、關 CSRF */
    @Bean
    @Order(1)                                        // ★ 數字小的先比對
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        return http
            .securityMatcher("/api/**")              // ★ 這條 chain 只負責這些路徑
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .httpBasic(Customizer.withDefaults())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())
            .build();
    }

    /** 第二條：其餘全部 —— 有 session、表單登入 */
    @Bean
    @Order(2)
    SecurityFilterChain webChain(HttpSecurity http) throws Exception {
        return http
            // 沒有 securityMatcher = 匹配【所有】請求 → 一定要排在最後
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .build();
    }
}
```

**兩個容易搞混的方法**：

```java
http.securityMatcher("/api/**")                       // ★ 決定「這【條 chain】負責哪些請求」
    .authorizeHttpRequests(a -> a
        .requestMatchers("/api/public/**").permitAll()  // ★ 決定「這【條規則】套用在哪些請求」
        .anyRequest().authenticated());
```

| 方法 | 層級 | 影響 |
|---|---|---|
| `securityMatcher(...)` | **chain 層級** | 不匹配的請求**完全不會進這條 chain** |
| `requestMatchers(...)` | **規則層級** | 請求已經在這條 chain 裡了，只是套哪一條授權規則 |

**比對規則只有一句話**：

> **`FilterChainProxy` 從第一條開始問「你匹配嗎」，第一條說「匹配」的就用，其餘的完全不看。**

**這是 1.2.3 那段程式碼的直接後果**：

```java
for (SecurityFilterChain chain : filterChains) {
    if (chain.matches(request)) {
        return chain.getFilters();     // ★ return —— 不會繼續往下找
    }
}
```

### 1.7.3 實測：順序寫反，第二條 chain 永遠不執行

**把 1.7.2 那兩個 `@Order` 對調**：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

/** f6：順序寫反 —— 沒有 securityMatcher 的那條排在前面 */
@Configuration
@Profile("f6")
public class F6_WrongOrder {

    @Bean
    @Order(1)                                     // ★ 錯：這條匹配【所有】請求
    SecurityFilterChain web(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                   .formLogin(Customizer.withDefaults())
                   .build();
    }

    @Bean
    @Order(2)                                     // ★ 這條永遠輪不到
    SecurityFilterChain api(HttpSecurity http) throws Exception {
        return http.securityMatcher("/api/**")
                   .authorizeHttpRequests(a -> a.anyRequest().permitAll())
                   .httpBasic(Customizer.withDefaults())
                   .csrf(c -> c.disable())
                   .build();
    }
}
```

**先看 chain 的樣子**（兩條都在，看起來很正常）：

```
═══ 1.7.3 f6 兩條 chain：順序寫反 ═══
  chain[0] matcher=any request                 filters=15
  chain[1] matcher=Or [Mvc [pattern='/api/**']] filters=12
```

**再看行為**：

```
═══ 1.7.3 f6：@Order(1) 是 any request ═══
  匿名 GET /api/hello（本來想 permitAll）         → 302 → http://localhost:57648/login
  alice GET /api/hello（Basic 本來有開）         → 302 → http://localhost:57648/login
  匿名 GET /                                 → 302 → http://localhost:57648/login
```

**對照正確順序**：

```
═══ 1.7.3 f5：@Order(1) 是 /api/**、@Order(2) 是 any request ═══
  匿名 GET /api/hello              → 401
  alice GET /api/hello             → 200 {"msg":"hello"}
  匿名 GET /（走第二條 chain）        → 302 → /login
```

⚠️ **兩個症狀都很誤導**：

```
① 「我明明寫了 permitAll，為什麼還要登入」
   → 因為那條 chain 根本沒被選中

② 「我帶了 Basic 憑證，為什麼還是 302」
   → 因為選中的那條 chain 上【沒有 BasicAuthenticationFilter】
     Authorization 標頭被完全忽略（沒有人去讀它）
```

📌 **診斷方法就是 1.3.3 那一行日誌**：

```
FilterChainProxy : Trying to match request against DefaultSecurityFilterChain [RequestMatcher=any request, …] (1/2)
FilterChainProxy : Securing GET /api/hello
```

**`(1/2)` 表示「總共 2 條，選中第 1 條」**——看到這一行就知道選錯了。

### 1.7.4 實測：`@Order` 不寫會怎樣

**很多人會想「不寫 `@Order` 應該會報錯吧」。實測**：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

/** f7：兩條 chain，都沒有標 @Order */
@Configuration
@Profile("f7")
public class F7_NoOrder {

    @Bean
    SecurityFilterChain web(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                   .formLogin(Customizer.withDefaults())
                   .build();
    }

    @Bean
    SecurityFilterChain api(HttpSecurity http) throws Exception {
        return http.securityMatcher("/api/**")
                   .authorizeHttpRequests(a -> a.anyRequest().permitAll())
                   .csrf(c -> c.disable())
                   .build();
    }
}
```

```
═══ 1.7.4 f7：兩條 chain 都沒標 @Order ═══
  啟動成功（沒有例外）

═══ 1.7.4 f7 的 chain ═══
  chain[0] matcher=any request                 filters=15
  chain[1] matcher=Or [Mvc [pattern='/api/**']] filters=11
```

🔴 **啟動不會報錯，順序變成「方法宣告順序」。**

**這比報錯危險得多**：

```
啟動報錯       → 你當下就會修
啟動成功但錯了  → 上線之後才發現，而且症狀是「某些設定莫名其妙沒生效」
```

⚠️ **而且它是不穩定的**：「方法宣告順序」不是規格保證的東西，
**把兩個方法上下對調、或把它們拆到兩個 `@Configuration` 類別，順序就變了。**

📌 **本課的規則**：

> **只要專案裡有一條以上的 `SecurityFilterChain`，每一條都必須標 `@Order`。**
> **而且沒有 `securityMatcher` 的那一條，`@Order` 必須是最大的數字。**

**這件事可以用測試釘住**（08 章會擴充）：

```java
package com.example.lab09.ch01;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class ChainOrderContractTest {

    @Autowired FilterChainProxy proxy;

    @Test
    void 沒有_securityMatcher_的_chain_必須排在最後() {
        List<SecurityFilterChain> chains = proxy.getFilterChains();
        for (int i = 0; i < chains.size() - 1; i++) {
            String matcher = chains.get(i).toString()
                    .replaceAll(".*RequestMatcher=(.*?), Filters=.*", "$1");
            assertThat(matcher)
                    .as("chain[%d] 匹配所有請求，它後面的 chain 永遠不會被選中", i)
                    .isNotEqualTo("any request");
        }
    }

    @Test
    void 每一條_chain_都必須有_AuthorizationFilter() {
        for (SecurityFilterChain chain : proxy.getFilterChains()) {
            boolean hasAuthz = chain.getFilters().stream().anyMatch(f -> f instanceof
                    org.springframework.security.web.access.intercept.AuthorizationFilter);
            String matcher = chain.toString().replaceAll(".*RequestMatcher=(.*?), Filters=.*", "$1");
            assertThat(hasAuthz)
                    .as("chain(%s) 沒有授權檢查", matcher)
                    .isTrue();
        }
    }
}
```

⚠️ **第二個測試在 `web.ignoring()` 存在時會紅**——那正是下一節的主題。

### 1.7.5 `permitAll()` 與 `web.ignoring()` 的三個差別

**兩者都是「讓這些路徑不用登入」，但機制完全不同**：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.web.SecurityFilterChain;

/** S4：用 web.ignoring() 把 /api/orders/** 整段排除 */
@Configuration
@Profile("s4")
public class S4_Ignoring {

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                   .httpBasic(Customizer.withDefaults())
                   .csrf(c -> c.disable())
                   .build();
    }

    @Bean
    WebSecurityCustomizer ignore() {
        return web -> web.ignoring().requestMatchers("/api/orders/**");
    }
}
```

**先看 chain**：

```
═══ 1.7.5 web.ignoring() 產生的 chain 長什麼樣 ═══
  chain[0] matcher=Ant [pattern='/api/orders/**']  filters=0   ⚠️ 空的
  chain[1] matcher=any request                     filters=12
```

🔴 **`web.ignoring()` 產生了一條「零個 Filter」的 chain，而且它排在最前面。**

**再看回應**：

```
═══ 1.7.5 web.ignoring() 的行為 ═══
  匿名 GET /api/orders/1001（被 ignoring）  → 200  {"id":"1001","ownerUsername":"alice","amount":1280.00,"status":"PAID"}
  安全標頭: X-Frame-Options=(沒有) / Cache-Control=(沒有)

  alice GET /api/hello（正常走 chain）      → 200  {"msg":"hello"}
  安全標頭: X-Frame-Options=DENY / Cache-Control=no-cache, no-store, max-age=0, must-revalidate
```

**三個差別**：

| | `permitAll()` | `web.ignoring()` |
|---|---|---|
| **Filter 有沒有跑** | 全部跑（16 個），只是授權規則放行 | **一個都不跑**（chain 是空的） |
| **安全標頭** | ✅ 照送 | 🔴 **完全沒有** |
| **`SecurityContextHolder`** | 有身分（至少是 `anonymousUser`） | **空的**——你的程式碼讀不到任何身分 |
| **CSRF / CORS** | 照常處理 | 完全不處理 |
| **效能** | 16 個 Filter 的成本 | 幾乎為零 |

⚠️ **`web.ignoring()` 是一把很利的刀**：

```
✅ 適合：/css/**、/js/**、/images/**、favicon.ico
        → 靜態資源，沒有身分概念，也不需要安全標頭

🔴 不適合：任何 /api/** 底下的東西
        → 一旦有人在那個路徑下新增一支端點，它就是完全裸奔的
        → 而且沒有安全標頭
```

📌 **Spring Security 官方文件對 `web.ignoring()` 的立場**：
**它會在啟動時警告你**（如果你用它匹配了會被 `HttpSecurity` 處理的路徑）：

```
WARN: You are asking Spring Security to ignore Ant [pattern='/api/orders/**'].
This is not recommended -- please use permitAll via HttpSecurity#authorizeHttpRequests instead.
```

**本課的規則**：

> **只有靜態資源用 `web.ignoring()`，其他一律 `permitAll()`。**
> **而且 00 章 0.8.4 那個 reporter 要把「filters=0 的 chain」印成警告。**

### 1.7.6 本站建議的兩條 chain

**這是 shop-service 從 02 章開始會一直用的形狀**：

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class ShopSecurityConfig {

    /** ① 靜態資源：完全跳過 Security */
    @Bean
    WebSecurityCustomizer staticResources() {
        return web -> web.ignoring().requestMatchers("/css/**", "/js/**", "/images/**", "/favicon.ico");
    }

    /** ② REST API：無狀態、401、JSON 錯誤 */
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        return http
            .securityMatcher("/api/**")
            .authorizeHttpRequests(a -> a
                .requestMatchers("/api/auth/login", "/api/auth/refresh").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())                     // 前提：身分不靠 cookie（05 章）
            .httpBasic(Customizer.withDefaults())       // 05 章會換成 JWT filter
            .exceptionHandling(e -> e
                .authenticationEntryPoint(ApiErrors::write401)
                .accessDeniedHandler(ApiErrors::write403))
            .build();
    }

    /** ③ 其餘（後台網頁、Actuator）：有 session、表單登入 */
    @Bean
    @Order(2)                                            // ★ 沒有 securityMatcher，一定要最後
    SecurityFilterChain webChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/actuator/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .build();
    }
}
```

`ApiErrors` 就是 00 章 0.4.2 那組（原樣搬來，讓這一段可以直接跑）：

```java
package com.example.lab09.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;

import java.io.IOException;
import java.time.Instant;
import java.util.Map;

public final class ApiErrors {

    private static final ObjectMapper OM = new ObjectMapper();

    private ApiErrors() {}

    public static void write401(HttpServletRequest req, HttpServletResponse res,
                                AuthenticationException ex) throws IOException {
        body(res, 401, "UNAUTHENTICATED", "請先登入", req);
    }

    public static void write403(HttpServletRequest req, HttpServletResponse res,
                                AccessDeniedException ex) throws IOException {
        body(res, 403, "FORBIDDEN", "你的角色不能做這件事", req);
    }

    private static void body(HttpServletResponse res, int status, String code, String msg,
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

📌 **注意 `/actuator/health` 放行、`/actuator/**` 要 ADMIN**——
這就是 02 站 05 章留下的「Actuator 端點第 09 站會詳談」。
**規則的順序很重要**：`requestMatchers` 也是「第一條匹配的就用」，
把 `/actuator/**` 寫在 `/actuator/health` 前面，健康檢查就會要登入。

---

## 1.8 例外的出口

### 1.8.1 `ExceptionTranslationFilter` 的位置決定它看得到什麼

**再看一次 1.4.1 的 D 組**：

```
15. ExceptionTranslationFilter      ← 包在外面
16. AuthorizationFilter             ← 被包住
```

**它的實作只有一個 try-catch**：

```java
// ExceptionTranslationFilter.doFilter（簡化）
try {
    chain.doFilter(request, response);          // ★ 往下跑（第 16 個 Filter 與後面的一切）
}
catch (IOException ex) { throw ex; }
catch (Exception ex) {
    // 在例外鏈裡找 AuthenticationException 或 AccessDeniedException
    RuntimeException securityException = (AuthenticationException)
            this.throwableAnalyzer.getFirstThrowableOfType(AuthenticationException.class, causeChain);
    if (securityException == null) {
        securityException = (AccessDeniedException)
                this.throwableAnalyzer.getFirstThrowableOfType(AccessDeniedException.class, causeChain);
    }
    if (securityException == null) {
        rethrow(ex);                            // ★ 不是這兩種就原樣往外丟
    }
    handleSpringSecurityException(request, response, chain, securityException);
}
```

**三個推論**：

```
① 它只接【下游】丟上來的例外  → 你的 Filter 排在它前面，它就看不到（00 章 0.3.5）
② 它只認【兩種】例外          → 其他例外原樣往外丟，最後變成 Tomcat 的 ERROR dispatch
③ 它會在【例外鏈】裡找        → 被包在 ServletException 裡面也找得到
```

### 1.8.2 401 / 403 的分界，在這一行

```java
// ExceptionTranslationFilter.handleSpringSecurityException（簡化）
if (exception instanceof AuthenticationException) {
    sendStartAuthentication(request, response, chain, (AuthenticationException) exception);
    // → AuthenticationEntryPoint → 401（或 302 導登入頁）
}
else if (exception instanceof AccessDeniedException) {
    Authentication authentication = this.securityContextHolderStrategy.getContext().getAuthentication();
    boolean isAnonymous = this.authenticationTrustResolver.isAnonymous(authentication);
    if (isAnonymous || this.authenticationTrustResolver.isRememberMe(authentication)) {   // ★ 就是這一行
        sendStartAuthentication(...);      // → AuthenticationEntryPoint → 401
    }
    else {
        this.accessDeniedHandler.handle(request, response, (AccessDeniedException) exception);
        // → AccessDeniedHandler → 403
    }
}
```

**這一行解釋了 00 章 0.4.4 那個「CSRF 失敗未登入時是 401」的意外**：

```
CsrfFilter 丟 AccessDeniedException
  → ExceptionTranslationFilter 接到
    → 目前身分是 anonymousUser
      → isAnonymous == true
        → 走 401 這一條
```

⚠️ **注意 `isRememberMe` 也走 401 這一條。**

**這是一個很少人注意、但很合理的設計**：

```
「記住我」的身分是【弱】身分（只憑一個長期 cookie，不是這次真的輸入了密碼）
所以碰到權限不足時，系統的態度是：
「你可能是本人，但這次的操作比較重要，請【重新輸入密碼】」→ 401 → 導向登入頁
```

**這就是為什麼很多網站在你按「修改密碼」時會要求重新登入一次。**
04 章 4.6 會實作這個「提升信任等級」的流程。

📌 **1.4.2 那三行判斷身分的程式碼，用的就是這裡的 `AuthenticationTrustResolver`**——
它是 Spring Security 對「什麼叫真的登入了」的正式答案。

### 1.8.3 403 為什麼會走 `/error`

**00 章 0.4.2 留了一個觀察**：

```
401 → body 是【空的】（content-length: 0）
403 → body 是 Boot 的預設錯誤 JSON
```

**原因是兩個 handler 的實作方式不同**：

```
AuthenticationEntryPoint（預設是 BasicAuthenticationEntryPoint）
  → 直接 response.setStatus(401) + 設 WWW-Authenticate 標頭
  → 【自己把回應寫完】，不再往下走

AccessDeniedHandlerImpl
  → request.setAttribute(WebAttributes.ACCESS_DENIED_403, ex)
  → response.sendError(403)                        ★ 關鍵
  → sendError 會讓 Servlet 容器發起一次【ERROR dispatch】到 /error
  → Boot 的 BasicErrorController 產生那個 JSON
```

⚠️ **`response.sendError()` 這個機制是 00 章 0.3.5 那個「空的 401」的同一個機制**：

```
任何走 sendError 或往外拋例外的路徑 → ERROR dispatch 到 /error
而 /error 【也要經過 Security Filter Chain】
如果你的規則沒有放行 /error → 那次 dispatch 拿到 401
→ 前端看到的是 401，而真正的錯誤是別的東西
```

📌 **所以每一條 chain 都要放行 `/error`**：

```java
.authorizeHttpRequests(a -> a
    .requestMatchers("/error").permitAll()          // ★ 幾乎是必備的一行
    …)
```

⚠️ **但這一行有代價**：`/error` 放行之後，1.8.5 的統一格式會變得更重要——
因為錯誤的內容會直接吐給沒有登入的人看。

### 1.8.4 實測：同一個 Filter，三個位置三種行為

**00 章 0.3.5 的三個變體，這裡整理成一張表**（同一個 `TokenFilter`，同樣兩種例外）：

```java
package com.example.lab09.ch01;

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

| 變體 | `/error` 放行？ | Filter 位置 | `IllegalStateException` | `CredentialsExpiredException` |
|---|---|---|---|---|
| **ex** | ❌ | `addFilterBefore(…, BasicAuthenticationFilter.class)`（ETF **之前**） | **401**（空 body） | **401**（空 body） |
| **ex3** | ✅ | 同上 | **500**（Boot 的 `/error` 格式） | **500** |
| **ex4** | ✅ | `addFilterBefore(…, AuthorizationFilter.class)`（ETF **之後**） | **500** | **401**（Boot 的 `/error` 格式） |

**三個結論**：

```
① 不管哪一個變體，@RestControllerAdvice 【一次都沒有】接到
   （怎麼看出來的：body 裡沒有 handledBy 欄位）

② /error 沒放行 → 所有 Filter 例外都變成【空的 401】
   → 這是最誤導的一種，因為它看起來像認證問題

③ 只有把 Filter 放在 ETF【之後】，AuthenticationException 才會被轉成 401
   （CredentialsExpiredException 是 AuthenticationException 的子類）
   而 IllegalStateException 不是那兩種，所以永遠是 500
```

⚠️ **`addFilterBefore(…, AuthorizationFilter.class)` 這個位置有一個代價**：
它排在 `AnonymousAuthenticationFilter` **之後**，
所以如果你的 Filter 是「建立身分」用的（例如 JWT），放這裡就太晚了——
匿名身分已經被設進去了，而且 `AuthorizationFilter` 馬上就要判斷。

**所以 JWT filter 的正確位置是 ETF 之前**，而它的例外要**自己處理**——那就是下一節。

### 1.8.5 讓 Filter 層與 Controller 層的錯誤格式一致 ★

**04 站 03 章要求「Spring Security 的 401/403 也要一致」。這一節把它做完。**

**要處理的有三種來源**：

```
① AuthorizationFilter 丟的 AccessDeniedException      → accessDeniedHandler
② 認證失敗丟的 AuthenticationException                 → authenticationEntryPoint
③ 你自己的 Filter 丟的任何例外                          → ★ 沒有人接
```

**① ② 用 1.7.6 的 `ApiErrors` 就解決了。③ 需要一個「例外轉換 Filter」**：

```java
package com.example.lab09.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Instant;
import java.util.Map;

/**
 * 放在 Security chain 的【最前面】，用 try-catch 包住後面所有的 Filter。
 * 讓 Filter 層丟出來的例外，也能產生跟 Controller 層一樣格式的 JSON。
 */
public class FilterErrorTranslationFilter extends OncePerRequestFilter {   // ★ 放在 shop 套件，1.10 會用到

    private static final ObjectMapper OM = new ObjectMapper();

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        try {
            chain.doFilter(req, res);
        }
        catch (AuthenticationException ex) {
            write(req, res, 401, "UNAUTHENTICATED", ex.getMessage());
        }
        catch (RuntimeException ex) {
            logger.error("filter 層未處理的例外: " + req.getRequestURI(), ex);
            // ⚠️ 不要把 ex.getMessage() 吐給客戶端（07 章 7.6：錯誤訊息洩漏）
            write(req, res, 500, "INTERNAL_ERROR", "系統忙碌中，請稍後再試");
        }
    }

    private void write(HttpServletRequest req, HttpServletResponse res,
                       int status, String code, String message) throws IOException {
        if (res.isCommitted()) return;          // ★ 回應已經送出去就不能再改了
        res.reset();
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        res.setCharacterEncoding("UTF-8");
        OM.writeValue(res.getOutputStream(), Map.of(
                "timestamp", Instant.now().toString(),
                "status",    status,
                "code",      code,
                "message",   message,
                "path",      req.getRequestURI()));
    }
}
```

**掛在最前面**：

```java
package com.example.lab09.ch01;

import com.example.lab09.shop.ApiErrors;
import com.example.lab09.shop.FilterErrorTranslationFilter;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;

@Configuration
@Profile("uerr")                     // ← 實驗專案要隔離（00 章 0.3.0.1）
public class UnifiedFilterErrorConfig {

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        return http
            .securityMatcher("/api/**")
            .authorizeHttpRequests(a -> a
                .requestMatchers("/error").permitAll()
                .anyRequest().authenticated())
            .csrf(c -> c.disable())
            // ★ 放在第一個「能放的」位置，讓它包住後面所有 Filter
            .addFilterBefore(new FilterErrorTranslationFilter(), SecurityContextHolderFilter.class)
            .exceptionHandling(e -> e
                .authenticationEntryPoint(ApiErrors::write401)
                .accessDeniedHandler(ApiErrors::write403))
            .build();
    }
}
```

⚠️ **三個實作細節**：

| 細節 | 為什麼 |
|---|---|
| `res.isCommitted()` 檢查 | 如果後面的 Filter 已經開始寫回應（例如串流下載），就不能 `reset()` |
| **不要吐 `ex.getMessage()`** | 那可能包含 SQL、內部類名、檔案路徑（07 章 7.6） |
| **不要 catch `IOException`** | 客戶端斷線會拋 `IOException`，那不是錯誤，寫回應也沒有意義 |

📌 **這個做法的代價**：
它會 catch 掉**所有** `RuntimeException`，包含那些**本來應該讓 `ExceptionTranslationFilter` 處理的**。
所以它必須放在 `ExceptionTranslationFilter` **之前**（更外層），
讓 ETF 有機會先處理它認得的那兩種——**這正是 1.8.1 那三個推論的應用**。

**實測**（五種錯誤來源，同一個服務）：

```
═══ 1.8.5 五種錯誤來源的格式 ═══
  ① 未認證                                → 401  {"code":"UNAUTHENTICATED","status":401,"path":"/api/orders/1001","timestamp":"…","message":"請先登入"}
  ② 權限不足                               → 403  {"code":"FORBIDDEN","status":403,"path":"/api/admin/revenue","timestamp":"…","message":"你的角色不能做這件事"}
  ③ Filter 拋 IllegalStateException      → 500  {"code":"INTERNAL_ERROR","status":500,"path":"/api/orders/1001","timestamp":"…","message":"系統忙碌中，請稍後再試"}
  ④ Filter 拋 CredentialsExpiredException → 401 {"code":"UNAUTHENTICATED","status":401,"path":"/api/orders/1001","timestamp":"…","message":"token 過期"}
  ⑤ Controller 拋例外                      → 500  {"code":"INTERNAL_ERROR","status":500,"path":"/api/boom","timestamp":"…","message":"系統忙碌中，請稍後再試"}
```

**五種來源、五個一致的格式**（都有 `code` / `status` / `path` / `timestamp` / `message`）。

⚠️ **看 ④ 的 `message`：它是 `ex.getMessage()`，也就是例外自己帶的字串。**
`AuthenticationException` 的訊息通常是安全的（Spring Security 的內建訊息都經過設計），
**但你自己拋的 `AuthenticationException` 子類要自己負責**——
不要在訊息裡寫「使用者 alice 不存在」（00 章 0.3.4 的帳號列舉）。

**用測試把這件事釘住**（08 章會擴充成完整版）：

```java
package com.example.lab09.ch01;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("uerr")              // ← 上面那個 UnifiedFilterErrorConfig 的 profile
class ErrorFormatContractTest {

    @LocalServerPort int port;

    @Test
    void 四種錯誤來源的格式必須一致() {
        com.example.lab09.Http h = new com.example.lab09.Http(port);

        // ① 未認證     ② 權限不足         ③ Filter 拋例外        ④ Controller 拋例外
        for (var r : new java.net.http.HttpResponse[]{
                h.get("/api/orders/1001"),
                h.get("/api/admin/revenue", "Authorization", com.example.lab09.Http.basic("alice", "pw")),
                h.get("/api/orders/1001", "X-Token", "boom"),
                h.get("/api/boom", "Authorization", com.example.lab09.Http.basic("alice", "pw"))}) {
            assertThat((String) r.body())
                    .as("狀態碼 %d 的回應", r.statusCode())
                    .contains("\"code\"").contains("\"timestamp\"").contains("\"path\"");
        }
    }
}
```

---

## 1.9 `SecurityContextHolder` 與執行緒

### 1.9.1 它其實是一個 `ThreadLocal`

**`SecurityContextHolder` 是一個靜態工具類別，背後是一個策略物件**：

```java
public class SecurityContextHolder {
    public static final String MODE_THREADLOCAL = "MODE_THREADLOCAL";                        // 預設
    public static final String MODE_INHERITABLETHREADLOCAL = "MODE_INHERITABLETHREADLOCAL";
    public static final String MODE_GLOBAL = "MODE_GLOBAL";
    …
}
```

**預設策略的實作，去掉樣板之後只有這樣**：

```java
final class ThreadLocalSecurityContextHolderStrategy implements SecurityContextHolderStrategy {

    private static final ThreadLocal<Supplier<SecurityContext>> contextHolder = new ThreadLocal<>();

    @Override public SecurityContext getContext() { … return contextHolder.get().get(); }
    @Override public void setContext(SecurityContext context) { contextHolder.set(() -> context); }
    @Override public void clearContext() { contextHolder.remove(); }
}
```

> **一句話：身分是綁在「處理這個請求的那條執行緒」上的。**

**這一句話推出這一節剩下的全部內容。**

### 1.9.2 實測：四種執行緒，三種拿不到身分

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Async;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.concurrent.*;

@RestController
@RequestMapping("/ctx")
@Profile({"ctx", "ctx2"})
public class CtxController {

    private final AsyncWorker worker;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);

    public CtxController(AsyncWorker worker) { this.worker = worker; }

    /** ⚠️ 這個 helper 不能叫 who()：會跟下面的端點方法撞名 */
    static String current() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a == null ? "null（SecurityContext 是空的）" : a.getName() + " " + a.getAuthorities();
    }

    @GetMapping("/who")
    public Map<String, Object> who() throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("1. Controller 執行緒", Thread.currentThread().getName());
        out.put("2. Controller 看到的身分", current());

        // ② 自己的執行緒池
        Future<String> f = pool.submit((Callable<String>) CtxController::current);
        out.put("3. 丟進自己的執行緒池後看到的身分", f.get());

        // ③ @Async
        out.put("4. @Async 方法看到的身分", worker.workAndReport().get(3, TimeUnit.SECONDS));

        // ④ CompletableFuture 的預設池（ForkJoinPool.commonPool）
        out.put("5. new Thread() 看到的身分", CompletableFuture.supplyAsync(CtxController::current).get());

        // ⑤ 把 context 明確包過去
        var ctx = SecurityContextHolder.getContext();
        ExecutorService wrapped = new org.springframework.security.concurrent
                .DelegatingSecurityContextExecutorService(pool, ctx);
        out.put("6. 用 DelegatingSecurityContextExecutorService 包過的池",
                wrapped.submit((Callable<String>) CtxController::current).get());
        return out;
    }

    @Service
    public static class AsyncWorker {
        @Async
        public CompletableFuture<String> workAndReport() {
            return CompletableFuture.completedFuture(current());
        }
    }
}
```

**實測（預設設定）**：

```
═══ 1.9.2 ctx：預設狀態下，SecurityContextHolder 在不同執行緒看到什麼 ═══
{"1. Controller 執行緒":"http-nio-auto-2-exec-1",
 "2. Controller 看到的身分":"alice [ROLE_USER]",
 "3. 丟進自己的執行緒池後看到的身分":"null（SecurityContext 是空的）",
 "4. @Async 方法看到的身分":"null（SecurityContext 是空的）",
 "5. new Thread() 看到的身分":"null（SecurityContext 是空的）",
 "6. 用 DelegatingSecurityContextExecutorService 包過的池":"alice [ROLE_USER]"}
```

**四種「離開請求執行緒」的方式，三種拿不到身分。**

⚠️ **這件事的後果不只是「拿不到名字」**：

```
在非同步任務裡呼叫一個標了 @PreAuthorize 的方法
  → SecurityContextHolder 是空的
  → 授權判斷拿到 null
  → 拋 AuthenticationCredentialsNotFoundException
  → 症狀是「這段程式碼同步跑沒事，改成 @Async 就炸了」
```

📌 **02 站 06 章留下的那句「要用 `DelegatingSecurityContextAsyncTaskExecutor`」，就是在說這件事。**

### 1.9.3 實測：請求結束後，身分有沒有被清掉

**1.2.3 說 `FilterChainProxy` 的 `finally` 一定會 `clearContext()`。驗證它。**

**Tomcat 的執行緒是重複使用的**，所以只要把執行緒池壓成 1 條，
就能讓「同一條執行緒連續處理不同身分的請求」一定發生：

```java
package com.example.lab09.ch01;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.tomcat.threads.max=1", "server.tomcat.threads.min-spare=1"})
@ActiveProfiles("clean")
class ContextCleanupTest {

    @LocalServerPort int port;

    @Test
    void reuse() {
        com.example.lab09.Http h = new com.example.lab09.Http(port);
        System.out.println("═══ 1.9.3 同一個執行緒連續處理四個請求 ═══");
        System.out.println("  ① alice 的請求 : " + h.get("/clean/who",
                "Authorization", com.example.lab09.Http.basic("alice", "pw")).body());
        System.out.println("  ② 匿名的請求   : " + h.get("/clean/who").body());
        System.out.println("  ③ alice 再一次 : " + h.get("/clean/who",
                "Authorization", com.example.lab09.Http.basic("alice", "pw")).body());
        System.out.println("  ④ 匿名再一次   : " + h.get("/clean/who").body());
    }
}
```

```
═══ 1.9.3 同一個執行緒連續處理四個請求 ═══
  ① alice 的請求 : {"authentication":"alice (UsernamePasswordAuthenticationToken)","thread":"http-nio-auto-1-exec-1"}
  ② 匿名的請求   : {"authentication":"anonymousUser (AnonymousAuthenticationToken)","thread":"http-nio-auto-1-exec-1"}
  ③ alice 再一次 : {"authentication":"alice (UsernamePasswordAuthenticationToken)","thread":"http-nio-auto-1-exec-1"}
  ④ 匿名再一次   : {"authentication":"anonymousUser (AnonymousAuthenticationToken)","thread":"http-nio-auto-1-exec-1"}
```

**四個請求全部在 `http-nio-auto-1-exec-1` 這一條執行緒上，身分完全正確。**

📌 **這是 `FilterChainProxy` 那個 `finally` 的功勞。**
如果沒有它，第 ② 個請求會看到 alice——**那是一個跨使用者的身分外洩。**

⚠️ **但這個保證有一個前提：請求必須真的經過 `FilterChainProxy`。**
`web.ignoring()` 那條空 chain 也會經過（1.7.5 實測 chain 還在，只是沒有 Filter），
所以那個 `finally` 依然會執行。**但下一節的策略換掉之後，保證就沒了。**

### 1.9.4 🔴 `MODE_INHERITABLETHREADLOCAL` 會造成身分外洩

**這是這一章最該記住的一個實測。**

網路上有一種很流行的「解決 `@Async` 拿不到身分」的做法：

```java
SecurityContextHolder.setStrategyName(SecurityContextHolder.MODE_INHERITABLETHREADLOCAL);
```

**它的原理是把 `ThreadLocal` 換成 `InheritableThreadLocal`**——
子執行緒**建立時**會複製父執行緒的值。看起來很合理。

**實測**（一條執行緒的池，讓「重複使用」一定發生）：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.concurrent.*;

public class InheritableLeakScenario {

    @Configuration @Profile("leak")
    static class Cfg {
        Cfg() {
            SecurityContextHolder.setStrategyName(SecurityContextHolder.MODE_INHERITABLETHREADLOCAL);
        }
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a
                        .requestMatchers("/leak/**").permitAll()
                        .anyRequest().authenticated())
                       .httpBasic(Customizer.withDefaults())
                       .csrf(c -> c.disable())
                       .build();
        }
    }

    @RestController @Profile("leak")
    static class C {
        /** 只有一條執行緒的池：讓「重複使用同一條執行緒」一定發生 */
        private final ExecutorService pool = Executors.newFixedThreadPool(1);

        static String current() {
            Authentication a = SecurityContextHolder.getContext().getAuthentication();
            return a == null ? "null" : a.getName();
        }

        @GetMapping("/leak/who")
        public Map<String, Object> who() throws Exception {
            String inRequest = current();
            String inPool = pool.submit((Callable<String>) C::current).get();
            return new LinkedHashMap<>(Map.of(
                    "1_請求執行緒看到的", inRequest,
                    "2_執行緒池看到的",   inPool));
        }

        @GetMapping("/leak/strategy")
        public String strategy() {
            return SecurityContextHolder.getContextHolderStrategy().getClass().getSimpleName();
        }
    }
}
```

```
═══ 1.9.4 MODE_INHERITABLETHREADLOCAL + 執行緒池 ═══
  目前策略: 200 InheritableThreadLocalSecurityContextHolderStrategy
  ① alice 的請求: 200 {"2_執行緒池看到的":"alice",  "1_請求執行緒看到的":"alice"}
  ② 匿名的請求  : 200 {"2_執行緒池看到的":"alice",  "1_請求執行緒看到的":"anonymousUser"}
  ③ bob 的請求  : 200 {"2_執行緒池看到的":"alice",  "1_請求執行緒看到的":"bob"}
  ④ 匿名的請求  : 200 {"2_執行緒池看到的":"alice",  "1_請求執行緒看到的":"anonymousUser"}
```

🔴 **第 ③ 行：bob 的請求，執行緒池裡看到的是 alice。**

**成因**：

```
① 第一個請求（alice）觸發池子【建立】那條工作執行緒
   → 建立的當下，InheritableThreadLocal 把 alice 的 context 複製過去

② 池子的執行緒【不會結束】，它會一直活著等下一個任務
   → 那份複製過去的 alice context【永遠不會被清掉】
   → FilterChainProxy 的 clearContext() 只清得到【請求執行緒】，清不到池子裡那條

③ 之後不管誰的請求丟任務進去，池子看到的都是 alice
```

⚠️ **這個外洩的嚴重程度**：

| 場景 | 後果 |
|---|---|
| 非同步寄信、通知 | bob 的訂單通知寄到 alice 的信箱 |
| 非同步寫稽核日誌 | 所有操作都記成 alice 做的 |
| 非同步任務裡有 `@PreAuthorize` | **bob 用到了 alice 的權限** |
| 非同步任務裡用 `currentUser()` 查資料 | **bob 看到 alice 的資料** |

📌 **而它最惡劣的地方是「第一個請求是對的」**——
所以你手動測一次會覺得「修好了」。
**只有在「不同使用者交替使用同一個池」時才會出錯，而那是正式環境的常態。**

> 🔴 **本課的規則：不要用 `MODE_INHERITABLETHREADLOCAL`。**
> **它解決的問題（子執行緒拿不到身分）有更好的解法（1.9.5），**
> **而它製造的問題（池子裡的身分永久殘留）沒有解法。**

### 1.9.5 正確的傳遞方式

**Spring Security 提供了一整組「包裝器」，原理都一樣：在任務執行前後設定與清除 context。**

| 你要包的東西 | 用這個 |
|---|---|
| `Runnable` | `DelegatingSecurityContextRunnable` |
| `Callable` | `DelegatingSecurityContextCallable` |
| `Executor` | `DelegatingSecurityContextExecutor` |
| `ExecutorService` | `DelegatingSecurityContextExecutorService` |
| `ScheduledExecutorService` | `DelegatingSecurityContextScheduledExecutorService` |
| Spring 的 `TaskExecutor`（`@Async` 用的） | `DelegatingSecurityContextAsyncTaskExecutor` |

**`@Async` 的修法**：

```java
package com.example.lab09.ch01;

import org.springframework.context.annotation.*;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.security.task.DelegatingSecurityContextAsyncTaskExecutor;

@Configuration
@EnableAsync
public class AsyncSecurityConfig {

    /** 覆蓋 Boot 的預設 applicationTaskExecutor，讓 @Async 也拿得到身分 */
    @Bean
    TaskExecutor applicationTaskExecutor() {
        ThreadPoolTaskExecutor pool = new ThreadPoolTaskExecutor();
        pool.setCorePoolSize(4);
        pool.setMaxPoolSize(16);
        pool.setQueueCapacity(200);
        pool.setThreadNamePrefix("async-");
        pool.initialize();
        return new DelegatingSecurityContextAsyncTaskExecutor(pool);
    }
}
```

**實測（同一支 `/ctx/who`，只換了這個 bean）**：

```
═══ 1.9.5 ctx2：把 @Async 的池換成 DelegatingSecurityContextAsyncTaskExecutor ═══
{"1. Controller 執行緒":"http-nio-auto-1-exec-1",
 "2. Controller 看到的身分":"alice [ROLE_USER]",
 "3. 丟進自己的執行緒池後看到的身分":"null（SecurityContext 是空的）",
 "4. @Async 方法看到的身分":"alice [ROLE_USER]",        ← ★ 修好了
 "5. new Thread() 看到的身分":"null（SecurityContext 是空的）",
 "6. 用 DelegatingSecurityContextExecutorService 包過的池":"alice [ROLE_USER]"}
```

⚠️ **注意第 3 行還是 null**——**包裝器只對「被包起來的那個池」有效。**
你程式碼裡自己 `new` 的 `ExecutorService`，還是拿不到身分。

📌 **這跟 1.9.4 的差別在哪？**

```
DelegatingSecurityContext* → 【每一個任務】執行前設、執行後【清掉】
                            → 池子裡的執行緒在兩個任務之間是乾淨的

MODE_INHERITABLETHREADLOCAL → 執行緒【建立時】複製一次，之後再也不動
                            → 池子裡的執行緒永遠留著第一次那個身分
```

**一個是「跟著任務走」，一個是「跟著執行緒走」。前者才對。**

### 1.9.6 6.x 的 `getContextHolderStrategy()`

**Spring Security 6 開始，官方建議不要直接呼叫 `SecurityContextHolder` 的靜態方法**：

```java
// 6.x 之前的寫法（仍然可以用）
Authentication auth = SecurityContextHolder.getContext().getAuthentication();

// 6.x 建議的寫法
private final SecurityContextHolderStrategy securityContextHolderStrategy
        = SecurityContextHolder.getContextHolderStrategy();

Authentication auth = this.securityContextHolderStrategy.getContext().getAuthentication();
```

**差別是什麼？**

```
靜態呼叫 → 每次都去讀那個【全域的】策略欄位
取出 strategy 存成欄位 → 拿到的是【當下】那個策略的參考
```

**這件事的實際意義**：

| 場景 | 為什麼要用 strategy |
|---|---|
| **測試** | 可以替換成一個測試用的 strategy，不用碰全域狀態 |
| **多租戶 / 多個 Security 設定並存** | 不同 chain 可以用不同的 strategy |
| **效能** | 少一次靜態欄位的間接存取（影響很小） |

📌 **本課的立場**：
**新寫的框架級程式碼（Filter、`AuthorizationManager`）用 strategy；
一般商業邏輯裡直接用 `SecurityContextHolder` 沒有問題。**

**但商業邏輯其實兩個都不該用**——03 章會給更好的做法：

```java
// ❌ Service 層直接讀 SecurityContextHolder：測試難寫、跟 Web 層耦合
public Order get(String id) {
    String me = SecurityContextHolder.getContext().getAuthentication().getName();
    …
}

// ✅ 把「現在是誰」變成一個介面（04 站 07 章那個 CurrentUser 的完成版）
public Order get(String id, ActorId actor) { … }
```

---

## 1.10 shop-service 落地

**這一章的成果，整理成 shop-service 的基準設定**（02 章開始會在這上面加東西）：

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;

@Configuration
public class ShopSecurityConfig {

    /** ① 靜態資源：完全跳過 Security（1.7.5 的唯一合法用途） */
    @Bean
    WebSecurityCustomizer staticResources() {
        return web -> web.ignoring().requestMatchers("/css/**", "/js/**", "/images/**", "/favicon.ico");
    }

    /** ② REST API：無狀態、JSON 錯誤 */
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        return http
            .securityMatcher("/api/**", "/error")
            .authorizeHttpRequests(a -> a
                .requestMatchers("/error").permitAll()                       // 1.8.3
                .requestMatchers("/api/auth/login", "/api/auth/refresh").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())                                          // 00 章 0.5.6 的判準
            .httpBasic(Customizer.withDefaults())                            // 05 章換成 JWT filter
            // 1.8.5：包住後面所有 Filter，讓 Filter 層例外也有一致的 JSON
            .addFilterBefore(new FilterErrorTranslationFilter(), SecurityContextHolderFilter.class)
            .exceptionHandling(e -> e
                .authenticationEntryPoint(ApiErrors::write401)
                .accessDeniedHandler(ApiErrors::write403))
            .build();
    }

    /** ③ 其餘（後台網頁、Actuator）：有 session、表單登入 */
    @Bean
    @Order(2)                                                                // 1.7.4：一定要最後
    SecurityFilterChain webChain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health").permitAll()             // 順序：具體的寫前面
                .requestMatchers("/actuator/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            .build();
    }
}
```

**再加上兩個「訊號」**（00 章 0.8.4 的 reporter 加上 1.4.3 的檢查）：

⚠️ **這是 00 章 0.8.4 那個類別的【擴充版，不是新類別】**——
套件與類別名都不變（`com.example.lab09.SecurityChainReporter`），**直接覆蓋掉舊的那一份**。
另外開一個同名類別會讓兩者的 bean 名稱都是 `securityChainReporter`，
啟動時直接 `ConflictingBeanDefinitionException`。

```java
package com.example.lab09;          // ← 跟 00 章 0.8.4 同一個類別，覆蓋它

import jakarta.servlet.Filter;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.*;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;

import java.util.List;

@Configuration
@Profile("!prod")
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
                sb.append("\n  chain[").append(c).append("]  matcher = ").append(matcher)
                  .append("   （").append(filters.size()).append(" 個 filter）\n");

                if (filters.isEmpty()) {
                    sb.append("      ⚠️ 沒有任何 filter —— 這是 web.ignoring() 的形狀（1.7.5）\n");
                }
                else if (filters.stream().noneMatch(f -> f instanceof AuthorizationFilter)) {
                    sb.append("      🔴 沒有 AuthorizationFilter —— 這條 chain 覆蓋的路徑完全沒有授權檢查（1.4.3）\n");
                }
                if (c < chains.size() - 1 && "any request".equals(matcher)) {
                    sb.append("      🔴 這條匹配所有請求，但後面還有 chain —— 那些永遠不會被選中（1.7.3）\n");
                }
                int i = 0;
                for (Filter f : filters) {
                    sb.append(String.format("      %2d. %s%n", ++i, f.getClass().getSimpleName()));
                }
                c++;
            }
            sb.append("═══════════════════════════════════════");
            System.out.println(sb);
        };
    }
}
```

**本章結束時，shop-service 的安全設定長這樣**：

```
三條 chain（一條 ignoring + 兩條真的）
  /css/** /js/** /images/** favicon.ico   → 0 個 filter
  /api/**、/error                         → 無狀態、JSON 錯誤、統一格式
  其餘                                     → session + 表單登入

錯誤格式已經統一（1.8.5 實測：五種來源同一個形狀）
啟動時會印出整條 chain，並對三種常見錯誤發出警告
```

⚠️ **還沒有的東西**（02 章開始補）：

```
帳號還是寫死在 application.yml 的 spring.security.user.*
角色只有 ROLE_USER / ROLE_ADMIN 兩種，而且是硬編碼
沒有註冊、沒有改密碼、沒有帳號鎖定
IDOR 還在（00 章 0.3.1 那個事故一行都沒修）
```

---

## 1.11 常見誤區

**誤區 1：「Spring Security 的那些 Filter 是註冊在 Tomcat 上的」**

→ 1.2.1 實測：**容器上只有一個** `springSecurityFilterChain`（order = -100）。
那 16 個對 Tomcat 來說**不存在**，所以你不能用容器的機制調它們的順序。

**誤區 2：「`addFilterAt` 會取代原本的 Filter」**

→ 1.6.3 實測：**兩個都在鏈上**（第 7 與第 8）。
要取代必須先 `.formLogin(f -> f.disable())`。

**誤區 3：「Filter 標 `@Component` 比較方便」**

→ 1.6.4 實測：**它會被註冊兩次**，`Filter` 版本真的跑了兩次
（一次在 `VirtualFilterChain`，一次在 `ApplicationFilterChain`）。
`OncePerRequestFilter` 救得了「跑兩次」，救不了「順序不對」。

**誤區 4：「兩條 chain 沒標 `@Order` 應該會報錯」**

→ 1.7.4 實測：**啟動成功，順序變成方法宣告順序**。
比報錯危險得多，因為它會活到上線。

**誤區 5：「`permitAll()` 跟 `web.ignoring()` 差不多，後者比較快」**

→ 1.7.5 實測：`web.ignoring()` 的路徑**沒有任何安全標頭**、
`SecurityContextHolder` 是空的、CSRF 與 CORS 完全不處理。
而且 Spring Security 啟動時就會警告你：
`You are asking Spring Security to ignore … This is not recommended`。

**誤區 6：「`ExceptionTranslationFilter` 會接住所有例外」**

→ 1.8.1：它只接**兩種**（`AuthenticationException` / `AccessDeniedException`），
而且只接**下游**丟上來的。你的 Filter 排在它前面，它就看不到。

**誤區 7：「Filter 的錯誤可以用 `@RestControllerAdvice` 統一格式」**

→ 1.8.4 實測：**三個變體，一次都沒接到**。
`@RestControllerAdvice` 在 `DispatcherServlet` 上，Filter 在它外面。
統一格式要用 1.8.5 那個「例外轉換 Filter」。

**誤區 8：「`/error` 不用特別放行」**

→ 1.8.3：`sendError` 與往外拋的例外都會觸發 ERROR dispatch 到 `/error`，
而 `/error` **也要經過 Security chain**。沒放行的話，
所有 500 都會變成**空的 401**（00 章 0.3.5）。

**誤區 9：「`auth != null` 就是登入了」**

→ 1.4.2：`AnonymousAuthenticationFilter` 讓它幾乎永遠不是 `null`，
而且匿名身分的 `isAuthenticated()` 也是 `true`。
要用 `AuthenticationTrustResolver.isAnonymous(auth)`。

**誤區 10：「用 `MODE_INHERITABLETHREADLOCAL` 就能解決 `@Async` 的問題」**

→ 1.9.4 實測：**bob 的請求在執行緒池裡看到 alice**，
而且第一個請求是對的，所以手動測會以為修好了。
正解是 `DelegatingSecurityContext*` 系列（1.9.5）。

**誤區 11：「`STATELESS` 就是完全無狀態」**

→ 1.5.4：`STATELESS` 只是「不**建立** session」，
`SecurityContext` 仍然可能從既有 session 讀出來。
真的無狀態要再加 `NullSecurityContextRepository`。

**誤區 12：「Filter 數量越多越安全」**

→ 1.4.3 的兩個最小形狀：`f8` 有 11 個 Filter 但**完全沒有授權**，
`f4` 只有 5 個但至少會做授權判斷。
**要看的是 `AuthorizationFilter` 在不在、以及它的規則是什麼。**

---

## 1.12 本章小結

**這一章把「設定」翻譯成「一串有順序的 Filter」。** 四個核心結論：

**一、請求穿過三層，而且它們是巢狀的（1.2）。**

```
Servlet 容器（只有一個 springSecurityFilterChain，order = -100）
  └─ FilterChainProxy（選一條 chain，第一條匹配的就用）
      └─ VirtualFilterChain（依序跑那條上的 N 個 Filter）
          └─ DispatcherServlet（@RestControllerAdvice 在這裡）
```

**這張圖解釋了為什麼 Filter 的例外進不了 `@RestControllerAdvice`。**

**二、設定 = Filter 清單（1.4.3）。**

```
Boot 預設             16 個
關 CSRF + 只留 Basic   12 個
再加 STATELESS         13 個（多一個 SessionManagementFilter）
能關的全關              5 個
不寫 authorizeHttpRequests  11 個 —— 🔴 沒有 AuthorizationFilter，全部開放
```

**「我的設定沒生效」的第一個診斷動作，就是把 chain 印出來數 Filter。**

**三、順序決定行為（1.6、1.7、1.8）。**

```
自訂 Filter 放 ETF 前面 → 它的例外沒人接
自訂 Filter 放 ETF 後面 → AuthenticationException 會變成 401，但太晚建立身分
兩條 chain 順序寫反      → 第二條永遠不執行，而且啟動不報錯
```

**四、身分綁在執行緒上（1.9）。**

```
✅ 請求執行緒                              拿得到
❌ 自己的 ExecutorService                  拿不到
❌ @Async（預設池）                        拿不到
❌ CompletableFuture.supplyAsync           拿不到
✅ DelegatingSecurityContext* 包過的       拿得到
🔴 MODE_INHERITABLETHREADLOCAL             拿得到，但會把身分【永久留在池子裡】
```

### 1.12.1 驗收清單

```
□ 一個請求從 Tomcat 到 Controller 穿過哪三層？@RestControllerAdvice 在哪一層？
□ Servlet 容器上有幾個 Spring Security 的 Filter？它的 order 是多少？
□ 為什麼堆疊裡會出現一堆 FilterChainProxy$VirtualFilterChain.doFilter？
□ 打開 TRACE 之後，哪一行告訴你「選了哪一條 chain」？哪一行告訴你「授權規則是什麼」？
□ Boot 預設有幾個 Filter？授權是第幾個？把 formLogin 關掉會少幾個？
□ STATELESS 為什麼反而多一個 Filter？
□ 完全不呼叫 authorizeHttpRequests 會怎樣？
□ Spring Security 6 的 explicit save 改了什麼？什麼情況會踩到？
□ addFilterBefore / After / At 的差別？addFilterAt 會取代原本的嗎？
□ 自訂 Filter 標 @Component 為什麼會跑兩次？OncePerRequestFilter 為什麼只救一半？
□ 多條 chain 的比對規則是什麼？沒標 @Order 會怎樣？
□ permitAll 與 web.ignoring 的三個差別？後者只適合什麼？
□ ExceptionTranslationFilter 接得到哪些例外？401 與 403 的分界在哪一行？
□ 為什麼 403 有 body、401 沒有？
□ 為什麼每一條 chain 都要放行 /error？
□ SecurityContextHolder 的預設策略是什麼？四種執行緒各自看得到什麼？
□ MODE_INHERITABLETHREADLOCAL 為什麼是錯的？它跟 DelegatingSecurityContext* 差在哪？
```

### 1.12.2 本章練習

**練習一（動手）：把你自己專案的 chain 印出來**

1. 把 1.10 那個 `SecurityChainReporter` 放進你手上任何一個 Spring Boot 專案。
2. 數一數有幾條 chain、每條幾個 Filter。
3. 回答：有沒有 chain 沒有 `AuthorizationFilter`？有沒有 `any request` 排在中間？

**練習二（動手）：重現 1.6.4 的「跑兩次」**

1. 寫一個 `implements Filter` 的類別，標上 `@Component`，同時 `addFilterBefore` 進 chain。
2. 在裡面印一行 `new Throwable().getStackTrace()[1].getClassName()`。
3. 確認你看到 `VirtualFilterChain` 與 `ApplicationFilterChain` 各一次。
4. 用 1.6.5 的三個修法各修一次，確認每次都只剩一行。

**練習三（動手）：讓錯誤格式一致**

1. 用 1.10 那份設定，加上一個會拋例外的 Filter。
2. 用 `Http` 打出五種錯誤（未認證 / 權限不足 / Filter 拋 `RuntimeException` /
   Filter 拋 `AuthenticationException` / Controller 拋例外）。
3. 確認五個回應都有 `code`、`status`、`path`、`timestamp`、`message`。
4. **然後把 `/error` 的 `permitAll()` 拿掉，看哪幾個壞掉、變成什麼。**

**練習四（動手）：重現 1.9.4 的身分外洩**

1. 照 1.9.4 建那個 `leak` 情境。
2. 用 alice、bob、匿名交替打十次，記錄「執行緒池看到的」。
3. 換成 `DelegatingSecurityContextExecutorService`，再打十次。
4. 回答：如果那個池子是用來寄通知信的，第 2 步會造成什麼事故？

**練習五（讀原始碼）：找出「第一條匹配就結束」**

打開 `org.springframework.security.web.FilterChainProxy`，找到 `getFilters(HttpServletRequest)`。

- 它回傳 `null` 的時候會發生什麼？（提示：看 `doFilterInternal`）
- 如果**沒有任何一條 chain 匹配**，這個請求會經過 Security 嗎？
- `FILTER_APPLIED` 這個 request attribute 是做什麼的？
  （提示：跟 1.6.4 的「跑兩次」有關，但解決的是另一個問題）

**練習六（思考題）：兩條 chain 的分界該畫在哪**

1.7.6 用 `/api/**` 當分界。但實務上常常沒那麼乾淨：

- 如果後台網頁也要呼叫 `/api/**`（同一個瀏覽器、同一個 session），會發生什麼？
- 如果 `/api/**` 底下有一支端點需要 session（例如購物車），要怎麼辦？
- 有沒有第三種分界方式？（提示：`securityMatcher` 可以吃的不只是路徑）

---

## 1.13 下一章預告

**02 章：認證機制。**

這一章從頭到尾都在講「Filter 怎麼排」，但刻意迴避了一件事：

> **`BasicAuthenticationFilter` 拿到 `alice / pw` 之後，到底是誰去確認這組帳密是對的？**

1.3.2 那份 TRACE 日誌其實已經洩漏了答案：

```
BasicAuthenticationFilter : Found username 'alice' in Basic Authorization header
ProviderManager           : Authenticating request with DaoAuthenticationProvider (1/1)
DaoAuthenticationProvider : Authenticated user
```

**三個名字，三層委派**——而 02 章要處理的就是這三層：

| 這一章看到的 | 02 章要處理的問題 |
|---|---|
| `BasicAuthenticationFilter` | 認證 Filter 只負責「從請求裡把憑證挖出來」，它不驗證任何東西 |
| `ProviderManager` | `(1/1)` 是什麼意思？可以有很多個 provider 嗎？**它們是怎麼決定誰處理的**？ |
| `DaoAuthenticationProvider` | 它去哪裡查使用者？（`UserDetailsService`）密碼怎麼比對？（`PasswordEncoder`） |

**還有五個這一章沒提的認證問題**：

```
① 帳號從 application.yml 搬到資料庫 —— UserDetailsService 要怎麼實作
② UserDetails 的五個布林值（enabled / accountNonLocked / …）各自在什麼時候被檢查
③ 00 章 0.7.7 那個 upgradeEncoding —— 要怎麼接上去自動升級密碼
④ AuthenticationManager 為什麼不是 bean（1.5.2 踩過一次）
⑤ 自訂登入流程：加驗證碼、加二階段驗證、加「登入失敗三次鎖定」
```

📌 **02 章結束時，00 章 0.3.4 那個「22873 倍」的時間差會被完整解釋**——
包含 `DaoAuthenticationProvider` 那段 dummy password check 的原始碼，
以及**它在什麼情況下會失效**（提示：跟你自己實作 `UserDetailsService` 的方式有關）。
