# 第 04 章：Session 與無狀態、CSRF

> 前三章每一條 chain 都有這一行，而理由只給過一句話：
>
> ```java
> .csrf(c -> c.disable())
> ```
>
> 也留下了兩個「改了資料庫卻沒有生效」的問題：
>
> ```
> 02 章 2.7.7   把帳號停用了，那個人手上的 session 照樣能用
> 03 章 3.7.7   把權限收回來了，同一個 session 照樣 200
> ```
>
> **這三件事是同一個問題的三個面向：身分被裝在什麼東西裡。**
>
> ```
> 裝在 session 裡        → 伺服器記得你是誰    → 可以撤銷，但要處理擴展與過期
> 裝在 cookie 裡         → 瀏覽器【自動】送出  → ★ CSRF 攻擊成立
> 裝在 Authorization 裡  → JavaScript 主動放  → CSRF 不成立，但撤銷變難（05 章）
> ```
>
> 📌 **這一章有二十三個實測。** 其中六個值得先劇透：
>
> ```
> 4.2.3  sessionCreationPolicy(STATELESS) 【擋不住】session 被建立
> 4.2.4  一個宣告無狀態的 API，200 個請求長出【200 個】還活著的 session
> 4.3.2  maximumSessions(1) 設了，但一個人可以同時登入無限台 —— 而且沒有任何警告
> 4.4.2  CSRF 關掉 + session 認證：攻擊者的網頁替 alice 轉出了 100000
> 4.4.3  用「檢查 Referer」代替 token —— 攻擊者只要【不送 Referer】就過了
> 4.7.2  同一支端點，session 版 2344 個/秒、Basic 版 13 個/秒 —— 差【兩個數量級】
> ```
>
> ⚠️ **這一章有一個貫穿全章的判準**：
>
> > **問「我的身分是誰送出去的」**——
> > 是**瀏覽器自動送**的（cookie、session、Basic），CSRF 就成立；
> > 是**你的 JavaScript 主動放**進去的（`Authorization` 標頭），才不成立。
> > 4.5.1 會把它展開成一張決策表。

---

## 4.1 學習目標與實驗環境

完成本章後，你應該可以：

- 說出 `JSESSIONID` 是在**哪一個請求**被建立的，以及為什麼匿名請求也可能建立它（4.2.1）。
- 打開一個 session，說出裡面有哪些屬性、各佔多少位元組（4.2.2）。
- 解釋 `sessionCreationPolicy(STATELESS)` **到底關掉了什麼**，以及它沒有關掉什麼（4.2.3）。
- 量出一個「無狀態」服務漏了幾個 session，並說出它在自動擴展環境下的後果（4.2.4）。
- 說出 `SecurityContextRepository` 的四種實作各自把身分存在哪裡（4.2.5）。
- 比較 `sessionFixation` 的四個選項，並說明**哪一個會讓固定攻擊成立**（4.3.1）。
- 診斷「`maximumSessions(1)` 沒有作用」的原因，並修好它（4.3.2）。
- 把一個**還活著**的 session 立刻作廢，回答 02 章 2.7.7 與 03 章 3.7.7 留下的問題（4.3.3）。
- 說出叢集環境下 session 的三個去處與各自的代價（4.3.4）。
- 解釋 CSRF token 從哪裡來、存在哪裡，以及**為什麼同一個 session 每次拿到的值都不一樣**（4.4.1）。
- 完整描述一次 CSRF 攻擊，並說出攻擊者**做得到**與**做不到**的事各有哪些（4.4.2）。
- 說明為什麼「檢查 Referer」不是一個可靠的防線（4.4.3）。
- 用一張決策表判斷一個專案該不該關 CSRF（4.5.1）。
- 指出「JWT 存在 cookie 裡」為什麼會讓 CSRF 重新成立（4.5.2）。
- 說出 `SameSite` 是誰在執行、它擋得住什麼、擋不住什麼（4.5.3）。
- 替前後端分離的專案接上 `CookieCsrfTokenRepository`（4.5.4）。
- 解碼一個 remember-me cookie，說出四個欄位各是什麼（4.6.1）。
- 解釋 `fullyAuthenticated()` 與 `authenticated()` 的分界，以及它為什麼回 401 而不是 403（4.6.2）。
- 實作「提升信任等級」，並指出這個流程**最容易寫錯的一行**（4.6.3）。
- 說出有狀態與無狀態在「身分新鮮度」與「每個請求的成本」上的取捨，並拿數字支持（4.7）。

### 4.1.1 本章的實驗環境

**這一章的每一個數字都在同一個環境上跑出來的**：

| 項目 | 版本 |
|---|---|
| Spring Boot | 3.2.5 |
| Spring Security | 6.2.4 |
| JDK | Temurin 21.0.5 |
| MySQL | 8.0.46（02 章 2.1.1 那個容器，繼續用） |
| 機器 | Apple M2 / macOS 14.2.1（8 顆邏輯核心） |

**① 資料庫與帳號沿用前三章**，這一章**不需要新的表**：

```
docker run -d --name sec-mysql -p 33307:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=lab09 \
  mysql:8.0 --max_connections=600

帳號     密碼   這一章為什麼需要他
──────────────────────────────────────────────────
alice   pw    主角：登入、被攻擊、被踢掉
bob     pw    ★ 跟 alice【同角色】（03 章 3.8 用過，這一章用在 4.3.2）
admin   pw    權限最多 —— 4.7.1 要看「權限被收回」的效果
cs      pw    03 章 3.1.1 加的客服帳號
```

**② 一支觀察 session 用的端點集合。** 這一章的重點是「session 什麼時候生出來」，
所以端點要**刻意分成三類**：完全不碰 session 的、只讀不建的、以及主動建立的。

```java
package com.example.lab09.ch04;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;

import java.io.ByteArrayOutputStream;
import java.io.ObjectOutputStream;
import java.util.*;

/**
 * 04 章觀察 session 用的端點。
 * 分成三類：【不碰】session 的、【只讀】session 的、【主動建立】session 的 ——
 * 4.2.3 要用這三類證明「STATELESS 擋不住 session 被建立」。
 */
@RestController
@RequestMapping("/s")
public class Ch04Endpoints {

    /** ① 完全不碰 session（連 getSession(false) 都不呼叫） */
    @GetMapping("/notouch")
    public Map<String, Object> noTouch(Authentication auth) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("endpoint", "/s/notouch");
        out.put("who", auth == null ? "(null)" : auth.getName());
        return out;
    }

    /** ② 只讀：getSession(false) —— 沒有就回 null，【不會】建立 */
    @GetMapping("/peek")
    public Map<String, Object> peek(HttpServletRequest req) {
        HttpSession s = req.getSession(false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("endpoint", "/s/peek");
        out.put("sessionExists", s != null);
        out.put("sessionId", s == null ? null : s.getId());
        return out;
    }

    /** ③ 🔴 主動建立：getSession() 等同 getSession(true) */
    @GetMapping("/touch")
    public Map<String, Object> touch(HttpServletRequest req) {
        HttpSession s = req.getSession();              // ★ 這一行就是 4.2.3 的兇手
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("endpoint", "/s/touch");
        out.put("sessionId", s.getId());
        out.put("isNew", s.isNew());
        return out;
    }

    /** ④ 把 session 裡【實際存了什麼】攤開：屬性名、型別、序列化後的位元組數 */
    @GetMapping("/dump")
    public Map<String, Object> dump(HttpServletRequest req) {
        HttpSession s = req.getSession(false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("endpoint", "/s/dump");
        if (s == null) { out.put("sessionExists", false); return out; }
        out.put("sessionExists", true);
        out.put("sessionId", s.getId());
        out.put("maxInactiveInterval(秒)", s.getMaxInactiveInterval());
        List<Map<String, Object>> attrs = new ArrayList<>();
        int total = 0;
        for (String name : Collections.list(s.getAttributeNames())) {
            Object v = s.getAttribute(name);
            int bytes = sizeOf(v);
            total += Math.max(bytes, 0);
            Map<String, Object> a = new LinkedHashMap<>();
            a.put("name", name);
            a.put("type", v == null ? "null" : v.getClass().getName());
            a.put("bytes", bytes);
            attrs.add(a);
        }
        out.put("attributes", attrs);
        out.put("總位元組", total);
        return out;
    }

    /** ⑤ 寫一個自訂屬性進 session —— 4.3.1 要用它看「屬性有沒有被搬過去」 */
    @PostMapping("/put")
    public Map<String, Object> put(HttpServletRequest req, @RequestParam String k, @RequestParam String v) {
        HttpSession s = req.getSession();
        s.setAttribute(k, v);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", s.getId());
        out.put("put", k + "=" + v);
        return out;
    }

    @GetMapping("/get")
    public Map<String, Object> get(HttpServletRequest req, @RequestParam String k) {
        HttpSession s = req.getSession(false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionExists", s != null);
        out.put("sessionId", s == null ? null : s.getId());
        out.put(k, s == null ? null : s.getAttribute(k));
        return out;
    }

    /** ⑥ 一支「會改資料」的 POST —— 4.4 的 CSRF 攻擊目標 */
    @PostMapping("/transfer")
    public Map<String, Object> transfer(@RequestParam String to, @RequestParam String amount,
                                        Authentication auth) {
        Bank.log.add((auth == null ? "(匿名)" : auth.getName()) + " → " + to + " " + amount);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("from", auth == null ? "(匿名)" : auth.getName());
        out.put("to", to);
        out.put("amount", amount);
        out.put("轉帳次數", Bank.log.size());
        return out;
    }

    @GetMapping("/transfers")
    public Map<String, Object> transfers() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("轉帳次數", Bank.log.size());
        out.put("明細", new ArrayList<>(Bank.log));
        return out;
    }

    @PostMapping("/transfers/reset")
    public Map<String, Object> reset() { Bank.log.clear(); return Map.of("ok", true); }

    /**
     * ⑦ 把目前這個 session 的 CSRF token 交給前端。
     * 這是單頁應用（SPA）最常見的做法：頁面載入時先打這一支，之後每個寫入請求都帶著它。
     * ⚠️ 它本身必須是 GET —— CsrfFilter 不檢查 GET / HEAD / OPTIONS / TRACE。
     */
    @GetMapping("/csrf")
    public Map<String, Object> csrf(CsrfToken token) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (token == null) { out.put("csrfEnabled", false); return out; }
        out.put("csrfEnabled", true);
        out.put("headerName", token.getHeaderName());
        out.put("parameterName", token.getParameterName());
        out.put("token", token.getToken());
        return out;
    }

    /** ⑧ session 計數 —— 4.2.4 用它量「無狀態服務長出了幾個 session」 */
    @GetMapping("/stats")
    public Map<String, Object> stats() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("建立過", SessionCounter.CREATED.get());
        out.put("銷毀過", SessionCounter.DESTROYED.get());
        out.put("還活著", SessionCounter.live());
        return out;
    }

    @PostMapping("/stats/reset")
    public Map<String, Object> statsReset() { SessionCounter.reset(); return Map.of("ok", true); }

    /** 一個假的「帳本」，只為了讓 CSRF 攻擊【有後果可看】 */
    static class Bank {
        static final List<String> log = Collections.synchronizedList(new ArrayList<>());
    }

    static int sizeOf(Object v) {
        try (ByteArrayOutputStream bos = new ByteArrayOutputStream();
             ObjectOutputStream oos = new ObjectOutputStream(bos)) {
            oos.writeObject(v);
            oos.flush();
            return bos.size();
        } catch (Exception e) { return -1; }          // 不可序列化
    }
}
```

**③ 一個 session 計數器。** 4.2.4 要回答「我的服務到底長出了幾個 session」，
而這個問題只能問容器：

```java
package com.example.lab09.ch04;

import jakarta.servlet.http.HttpSessionEvent;
import jakarta.servlet.http.HttpSessionListener;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * 一個最小的 session 計數器：容器每建立 / 銷毀一個 session 就加一。
 *
 * ⚠️ 這是實驗用的工具，但它在正式環境也值得放 ——
 *    把 live() 接到 metrics（Micrometer）上，session 外洩就會在監控上現形。
 */
@Component
public class SessionCounter implements HttpSessionListener {

    public static final AtomicInteger CREATED = new AtomicInteger();
    public static final AtomicInteger DESTROYED = new AtomicInteger();

    @Override public void sessionCreated(HttpSessionEvent se) { CREATED.incrementAndGet(); }
    @Override public void sessionDestroyed(HttpSessionEvent se) { DESTROYED.incrementAndGet(); }

    public static int live() { return CREATED.get() - DESTROYED.get(); }
    public static void reset() { CREATED.set(0); DESTROYED.set(0); }
}
```

**④ 一個會記住 cookie 的「瀏覽器替身」。**
00 章 0.8.3 的 `Http` 刻意**不帶 cookie**——那是為了看清楚原始回應。
**這一章要觀察的正好是 cookie 本身**，所以在它外面包一層：

```java
package com.example.lab09.ch04;

import com.example.lab09.Http;                        // 00 章 0.8.3：不跟隨轉址的裸 client

import java.net.http.HttpResponse;
import java.util.*;
import java.util.regex.*;

/**
 * 一個【會記住 cookie】的瀏覽器替身：
 * 每次回應的 Set-Cookie 都收進 jar，每次送出時再帶回去。
 */
public class Web {

    private final Http http;
    private final Map<String, String> jar = new LinkedHashMap<>();

    public Web(int port) { this.http = new Http(port); }

    public String cookie(String name) { return jar.get(name); }
    public String sessionId() { return jar.get("JSESSIONID"); }
    public Map<String, String> cookies() { return new LinkedHashMap<>(jar); }
    public void forget(String name) { jar.remove(name); }
    public void forgetAll() { jar.clear(); }

    /** 手動塞一個 cookie —— 4.3.1 要用它把「舊的 session id」送回去 */
    public void setCookie(String name, String value) { jar.put(name, value); }

    public HttpResponse<String> get(String path, String... extraHeaders) {
        return send("GET", path, null, extraHeaders);
    }

    public HttpResponse<String> post(String path, String body, String... extraHeaders) {
        return send("POST", path, body, extraHeaders);
    }

    public HttpResponse<String> send(String method, String path, String body, String... extraHeaders) {
        List<String> h = new ArrayList<>(Arrays.asList(extraHeaders));
        if (!jar.isEmpty()) { h.add("Cookie"); h.add(cookieHeader()); }
        HttpResponse<String> r = http.send(method, path, body, h.toArray(new String[0]));
        absorb(r);
        return r;
    }

    /** 不帶任何 cookie 送一次（但仍然吸收回應的 Set-Cookie） */
    public HttpResponse<String> sendWithoutCookies(String method, String path, String body, String... extraHeaders) {
        HttpResponse<String> r = http.send(method, path, body, extraHeaders);
        absorb(r);
        return r;
    }

    public String cookieHeader() {
        StringBuilder sb = new StringBuilder();
        jar.forEach((k, v) -> { if (!sb.isEmpty()) sb.append("; "); sb.append(k).append('=').append(v); });
        return sb.toString();
    }

    /** 把回應的 Set-Cookie 收進 jar；值為空代表「刪掉這個 cookie」 */
    private void absorb(HttpResponse<String> r) {
        for (String c : r.headers().allValues("set-cookie")) {
            int eq = c.indexOf('=');
            if (eq < 0) continue;
            String name = c.substring(0, eq);
            String value = c.substring(eq + 1).split(";")[0];
            if (value.isEmpty()) jar.remove(name); else jar.put(name, value);
        }
    }

    // ───────── 表單登入：取頁面 → 抓 _csrf → POST ─────────

    private static final Pattern CSRF =
            Pattern.compile("name=\"_csrf\"[^>]*value=\"([^\"]+)\"");

    /** 回傳 POST /login 的狀態碼（預設設定成功是 302）。過程中的 cookie 都會收進 jar。 */
    public int formLogin(String user, String pw) {
        return formLogin(user, pw, true).statusCode();
    }

    /** withCsrf=false 時故意不帶 token —— 4.4 用它證明 CsrfFilter 真的在擋 */
    public HttpResponse<String> formLogin(String user, String pw, boolean withCsrf) {
        HttpResponse<String> page = get("/login");
        String body = "username=" + user + "&password=" + pw;
        if (withCsrf) {
            Matcher m = CSRF.matcher(page.body() == null ? "" : page.body());
            if (m.find()) body += "&_csrf=" + m.group(1);
        }
        return post("/login", body, "Content-Type", "application/x-www-form-urlencoded");
    }

    /** 從任意 HTML 裡挖 _csrf（4.5 的前後端分離情境會用到） */
    public static String csrfOf(String html) {
        Matcher m = CSRF.matcher(html == null ? "" : html);
        return m.find() ? m.group(1) : null;
    }

    public static String basic(String u, String p) { return Http.basic(u, p); }

    /** 把一個回應縮成一行，方便印進矩陣 */
    public static String brief(HttpResponse<String> r, int max) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ");
        if (b.length() > max) b = b.substring(0, max) + "…";
        return r.statusCode() + "  " + b;
    }

    /** 只取 Set-Cookie 裡某個 cookie 的完整宣告（含 HttpOnly / SameSite 這些屬性） */
    public static String setCookieOf(HttpResponse<String> r, String name) {
        return r.headers().allValues("set-cookie").stream()
                .filter(c -> c.startsWith(name + "="))
                .findFirst().orElse(null);
    }
}
```

> ⚠️ **實驗專案的 profile 慣例**（跟 02 章 2.1.1、03 章 3.1.1 一樣）：
> 每一種設定各一個 profile，測試用 `@ActiveProfiles` 切換。
> 本章的 profile 有 `se1`～`se9`（session）、`cs1`～`cs7`（CSRF）、
> `rm1` `rm2`（remember-me）、`eq`（4.3.2 的修好版），
> 全部再加一個共用的 `ch4` 與 02 章的 `db`。
> **你自己的專案只會有一種設定，不需要這些。**

### 4.1.2 一個新工具：身分載體設定報表

前三章各留下了一個啟動時就會印出來的工具：

```
00 章 0.8.4  SecurityChainReporter  → 這條 chain 上有哪些 Filter
02 章 2.6.3  AuthWiringReporter     → 誰在驗密碼
03 章 3.2.4  AuthzRuleReporter      → AuthorizationFilter 手上有幾條規則
```

**這一章補上第四個，它回答的問題是：「我的身分【存在哪裡】、CSRF 開著沒。」**

```java
package com.example.lab09.ch04;

import jakarta.servlet.Filter;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.security.authentication.event.AuthenticationSuccessEvent;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.logout.LogoutFilter;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.security.web.session.ConcurrentSessionFilter;
import org.springframework.stereotype.Component;

import java.lang.reflect.Field;
import java.util.*;

/**
 * 啟動時把【每一條 chain 的身分載體設定】印出來，並對四種組合發警告。
 */
@Component
@Profile("!prod")
public class SessionWiringReporter implements ApplicationListener<ApplicationReadyEvent> {

    private final FilterChainProxy proxy;
    private final Optional<SessionRegistry> registry;

    public SessionWiringReporter(FilterChainProxy proxy, Optional<SessionRegistry> registry) {
        this.proxy = proxy; this.registry = registry;
    }

    @Override public void onApplicationEvent(ApplicationReadyEvent e) { print(); }

    public void print() {
        System.out.println("\n──────── 身分載體設定（每條 chain）────────");
        int i = 0;
        for (SecurityFilterChain chain : proxy.getFilterChains()) {
            List<Filter> fs = chain.getFilters();
            SecurityContextRepository repo = repoOf(fs);
            CsrfFilter csrf = first(fs, CsrfFilter.class);
            boolean stateless = repo != null && !describeRepo(repo).contains("HttpSession");
            boolean hasLogout = first(fs, LogoutFilter.class) != null;

            System.out.printf("chain[%d]  %s（%d 個 Filter）%n", i++,
                    chain instanceof org.springframework.security.web.DefaultSecurityFilterChain d
                            ? d.getRequestMatcher() : "?", fs.size());
            System.out.println("   身分存在哪裡                = " + describeRepo(repo));
            System.out.println("   CSRF                        = "
                    + (csrf == null ? "關閉" : "開啟，token 存在 " + simpleName(field(csrf, "tokenRepository"))));
            System.out.println("   ConcurrentSessionFilter     = "
                    + (first(fs, ConcurrentSessionFilter.class) != null ? "有（有做並行 session 控制）" : "無"));
            System.out.println("   LogoutFilter                = " + (hasLogout ? "有" : "無"));

            // ── 四個警告 ──
            if (!stateless && csrf == null)
                System.out.println("   🔴 警告：身分存在 session（瀏覽器自動攜帶），但 CSRF 被關掉了 —— 4.4.2 那個漏洞");
            if (stateless && csrf != null)
                System.out.println("   ⚠️ 提醒：已經是無狀態（身分不靠 cookie），CSRF 開著只會製造摩擦 —— 4.5.1");
            if (!stateless && !hasLogout)
                System.out.println("   ⚠️ 提醒：用 session 卻沒有 LogoutFilter —— 使用者沒有辦法讓自己的 session 失效");
            if (registry.isPresent() && first(fs, ConcurrentSessionFilter.class) != null)
                System.out.println("   ℹ️ 有 SessionRegistry：請確認 principal 有覆寫 equals/hashCode —— 4.3.2");
        }
        System.out.println("──────────────────────────────────────────\n");
    }

    /** 🔴 4.3.2 的執行期檢查：第一次登入成功時，看看 principal 能不能當 Map 的 key */
    @EventListener
    public void onLogin(AuthenticationSuccessEvent e) {
        Object p = e.getAuthentication().getPrincipal();
        if (p == null || WARNED.contains(p.getClass())) return;
        WARNED.add(p.getClass());
        boolean ok;
        try { ok = !p.getClass().getMethod("equals", Object.class).getDeclaringClass().equals(Object.class); }
        catch (NoSuchMethodException ex) { ok = false; }
        if (!ok && registry.isPresent())
            System.out.println("🔴 " + p.getClass().getSimpleName()
                    + " 沒有覆寫 equals/hashCode —— SessionRegistry 會把同一個人當成好幾個人（4.3.2）");
    }

    private static final Set<Class<?>> WARNED = Collections.synchronizedSet(new HashSet<>());

    static <T> T first(List<Filter> fs, Class<T> type) {
        return fs.stream().filter(type::isInstance).map(type::cast).findFirst().orElse(null);
    }

    static SecurityContextRepository repoOf(List<Filter> fs) {
        SecurityContextHolderFilter f = first(fs, SecurityContextHolderFilter.class);
        return f == null ? null : (SecurityContextRepository) field(f, "securityContextRepository");
    }

    /** DelegatingSecurityContextRepository 會包住好幾個，要拆開才看得出身分到底存哪 */
    static String describeRepo(SecurityContextRepository repo) {
        if (repo == null) return "（找不到 SecurityContextHolderFilter）";
        Object delegates = field(repo, "delegates");
        if (delegates instanceof List<?> list && !list.isEmpty()) {
            List<String> names = new ArrayList<>();
            for (Object d : list) names.add(d.getClass().getSimpleName());
            return repo.getClass().getSimpleName() + " → " + String.join(" + ", names);
        }
        return repo.getClass().getSimpleName();
    }

    static String simpleName(Object o) {
        if (o == null) return "（不明）";
        String n = o.getClass().getSimpleName();
        return o instanceof CsrfTokenRepository && n.startsWith("Cookie") ? n + "（cookie，前端讀得到）" : n;
    }

    static Object field(Object target, String name) {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (ReflectiveOperationException ignore) { }
        }
        return null;
    }
}
```

**對著本章四種設定各跑一次**（設定的內容 4.4、4.5 會逐一解釋）：

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest
@ActiveProfiles({"db", "ch4"})
class WiringReportTest {

    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed3.reset(jdbc); }

    @Test
    void report() {
        System.out.println("\n═══ 4.1.2 身分載體設定報表：四種設定各印一次 ═══");
        for (String[] c : new String[][]{
                {"cs2", "🔴 表單登入 + session，但 csrf().disable()"},
                {"cs1", "✅ 表單登入 + session，CSRF 開著（預設）"},
                {"cs4", "✅ Basic + STATELESS，CSRF 關掉"},
                {"cs3", "✅ 前後端分離：CookieCsrfTokenRepository"}}) {
            System.out.println("\n>>> " + c[1] + "（profile " + c[0] + "）");
            try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                    .web(WebApplicationType.SERVLET).profiles("db", "ch4", c[0])
                    .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF").run()) {
                ctx.getBean(SessionWiringReporter.class).print();
            }
        }
    }
}
```

**輸出**：

```
═══ 4.1.2 身分載體設定報表：四種設定各印一次 ═══

>>> 🔴 表單登入 + session，但 csrf().disable()（profile cs2）

──────── 身分載體設定（每條 chain）────────
chain[0]  any request（14 個 Filter）
   身分存在哪裡                = DelegatingSecurityContextRepository → HttpSessionSecurityContextRepository + RequestAttributeSecurityContextRepository
   CSRF                        = 關閉
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
   🔴 警告：身分存在 session（瀏覽器自動攜帶），但 CSRF 被關掉了 —— 4.4.2 那個漏洞
──────────────────────────────────────────


──────── 身分載體設定（每條 chain）────────
chain[0]  any request（14 個 Filter）
   身分存在哪裡                = DelegatingSecurityContextRepository → HttpSessionSecurityContextRepository + RequestAttributeSecurityContextRepository
   CSRF                        = 關閉
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
   🔴 警告：身分存在 session（瀏覽器自動攜帶），但 CSRF 被關掉了 —— 4.4.2 那個漏洞
──────────────────────────────────────────


>>> ✅ 表單登入 + session，CSRF 開著（預設）（profile cs1）

──────── 身分載體設定（每條 chain）────────
chain[0]  any request（15 個 Filter）
   身分存在哪裡                = DelegatingSecurityContextRepository → HttpSessionSecurityContextRepository + RequestAttributeSecurityContextRepository
   CSRF                        = 開啟，token 存在 HttpSessionCsrfTokenRepository
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
──────────────────────────────────────────


──────── 身分載體設定（每條 chain）────────
chain[0]  any request（15 個 Filter）
   身分存在哪裡                = DelegatingSecurityContextRepository → HttpSessionSecurityContextRepository + RequestAttributeSecurityContextRepository
   CSRF                        = 開啟，token 存在 HttpSessionCsrfTokenRepository
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
──────────────────────────────────────────


>>> ✅ Basic + STATELESS，CSRF 關掉（profile cs4）

──────── 身分載體設定（每條 chain）────────
chain[0]  any request（13 個 Filter）
   身分存在哪裡                = RequestAttributeSecurityContextRepository
   CSRF                        = 關閉
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
──────────────────────────────────────────


──────── 身分載體設定（每條 chain）────────
chain[0]  any request（13 個 Filter）
   身分存在哪裡                = RequestAttributeSecurityContextRepository
   CSRF                        = 關閉
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
──────────────────────────────────────────


>>> ✅ 前後端分離：CookieCsrfTokenRepository（profile cs3）

──────── 身分載體設定（每條 chain）────────
chain[0]  any request（15 個 Filter）
   身分存在哪裡                = DelegatingSecurityContextRepository → HttpSessionSecurityContextRepository + RequestAttributeSecurityContextRepository
   CSRF                        = 開啟，token 存在 CookieCsrfTokenRepository（cookie，前端讀得到）
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
──────────────────────────────────────────


──────── 身分載體設定（每條 chain）────────
chain[0]  any request（15 個 Filter）
   身分存在哪裡                = DelegatingSecurityContextRepository → HttpSessionSecurityContextRepository + RequestAttributeSecurityContextRepository
   CSRF                        = 開啟，token 存在 CookieCsrfTokenRepository（cookie，前端讀得到）
   ConcurrentSessionFilter     = 無
   LogoutFilter                = 有
──────────────────────────────────────────
```

📌 **這份輸出的價值在第一行的那個警告。**

```
「身分存在 session」＋「CSRF 關閉」 = 4.4.2 那個可以被任何網站觸發的轉帳漏洞
```

而這個組合在程式碼裡長這樣——**兩行，中間隔了十幾行，沒有人會覺得它們有關係**：

```java
.formLogin(Customizer.withDefaults())     // ← 身分裝進 session
...
.csrf(c -> c.disable())                   // ← 十幾行之後
```

⚠️ **第三條 chain 的 `13 個 Filter` 也值得注意**：
`STATELESS` 的那一條**少了 `CsrfFilter` 與兩個登入頁 Filter**，
而且 `身分存在哪裡` 直接是 `RequestAttributeSecurityContextRepository`——
**「只活在這一個請求裡」**。01 章 1.4.2 那張 16 個 Filter 的表，在這裡開始出現分歧。

---

## 4.2 Session：它存在哪裡、誰建立它

### 4.2.1 實測：`JSESSIONID` 是在哪一步長出來的

**大部分人以為是「登入成功的時候」。** 實際跑一次：

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch4", "se1"})
class SessionCreationTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); }

    static void step(String label, HttpResponse<String> r, Web w) {
        String sc = Web.setCookieOf(r, "JSESSIONID");
        System.out.printf("   %-46s → %-3d  Set-Cookie: %s%n",
                label, r.statusCode(), sc == null ? "（沒有）" : sc);
    }

    @Test
    void whenIsSessionCreated() {
        System.out.println("\n═══ 4.2.1 JSESSIONID 是在哪一步長出來的 ═══");
        Web w = new Web(port);
        step("① GET /api/hello           （permitAll，匿名）", w.get("/api/hello"), w);
        step("② GET /s/notouch           （要登入，匿名）", w.get("/s/notouch"), w);
        step("③ GET /login               （取登入頁）", w.get("/login"), w);
        HttpResponse<String> login = w.formLogin("alice", "pw", true);
        step("④ POST /login              （登入成功）", login, w);
        step("⑤ GET /s/notouch           （已登入）", w.get("/s/notouch"), w);
        step("⑥ GET /s/notouch           （已登入，再一次）", w.get("/s/notouch"), w);
        System.out.println("\n   手上的 cookie：" + w.cookies());
    }
}
```

```
═══ 4.2.1 JSESSIONID 是在哪一步長出來的 ═══
   ① GET /api/hello           （permitAll，匿名）      → 200  Set-Cookie: （沒有）
   ② GET /s/notouch           （要登入，匿名）            → 302  Set-Cookie: JSESSIONID=99925925A4EB869E28A01757CACC43A8; Path=/; HttpOnly
   ③ GET /login               （取登入頁）              → 200  Set-Cookie: （沒有）
   ④ POST /login              （登入成功）              → 302  Set-Cookie: JSESSIONID=7D60A4F8258BA4AE13892C5B7336B1E3; Path=/; HttpOnly
   ⑤ GET /s/notouch           （已登入）               → 200  Set-Cookie: （沒有）
   ⑥ GET /s/notouch           （已登入，再一次）           → 200  Set-Cookie: （沒有）

   手上的 cookie：{JSESSIONID=7D60A4F8258BA4AE13892C5B7336B1E3}
```

**四個發現**：

**① 匿名打 `permitAll` 的端點，【沒有】session。**

這是 Spring Security 6 跟 5 的重要差別之一：不需要存任何東西時，它不會建立 session。

**② 🔴 匿名被擋下來的那一步，session 就建立了 —— 還沒有人登入。**

```
② GET /s/notouch  匿名 → 302，而且 Set-Cookie 了
```

**為什麼？** 因為 `ExceptionTranslationFilter` 在把你導去登入頁之前，
要先把「你原本想去哪」記下來——那份記錄叫 `SavedRequest`，而它**存在 session 裡**（4.2.2 會看到它）。

📌 **所以「還沒登入的人不會佔用 session」是錯的。**
一個對外開放的網站，只要有人（或爬蟲）打到受保護的路徑，就會生出一個 session。

**③ 登入成功時，session id 【換掉了】。**

```
②  411E9E1C…      ← 登入前
④  170A82F6…      ← 登入後
```

這就是 **session fixation 防護**，00 章 0.5.5 量過它，4.3.1 會把四個選項攤開。

**④ 之後就不再發 `Set-Cookie` 了。**

Set-Cookie 只在「session 剛建立」或「id 改變」時出現。
⚠️ **所以「看不到 Set-Cookie」不等於「沒有 session」**——
要看的是**請求**上的 `Cookie` 標頭，或者直接問伺服器（`/s/dump`）。

### 4.2.2 實測：session 裡到底存了什麼

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch4", "se1"})
class SessionContentTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); }

    @Test
    void whatIsInTheSession() {
        System.out.println("\n═══ 4.2.2 session 裡到底存了什麼 ═══");
        Web w = new Web(port);

        System.out.println("\n   ① 匿名被擋下來之後（還沒登入）：");
        w.get("/s/notouch");                       // 302，順便建立 session
        System.out.println("      " + w.get("/s/dump").body());

        System.out.println("\n   ② 登入之後：");
        w.formLogin("alice", "pw", true);
        System.out.println("      " + w.get("/s/dump").body());

        System.out.println("\n   ③ 換成權限多的 admin（authorities 更多）：");
        Web w2 = new Web(port);
        w2.formLogin("admin", "pw", true);
        System.out.println("      " + w2.get("/s/dump").body());
    }
}
```

```
═══ 4.2.2 session 裡到底存了什麼 ═══

   ① 匿名被擋下來之後（還沒登入）：
      {"endpoint":"/s/dump","sessionExists":true,"sessionId":"5A419A453BE8146E4CBE19579B06393A","maxInactiveInterval(秒)":1800,"attributes":[{"name":"SPRING_SECURITY_SAVED_REQUEST","type":"org.springframework.security.web.savedrequest.DefaultSavedRequest","bytes":1194}],"總位元組":1194}

   ② 登入之後：
      {"endpoint":"/s/dump","sessionExists":true,"sessionId":"60C0B7CDBAD443A1D71CA5E790F98B71","maxInactiveInterval(秒)":1800,"attributes":[{"name":"SPRING_SECURITY_CONTEXT","type":"org.springframework.security.core.context.SecurityContextImpl","bytes":1332},{"name":"SPRING_SECURITY_SAVED_REQUEST","type":"org.springframework.security.web.savedrequest.DefaultSavedRequest","bytes":1194}],"總位元組":2526}

   ③ 換成權限多的 admin（authorities 更多）：
      {"endpoint":"/s/dump","sessionExists":true,"sessionId":"0F50F0137892DFDC7FD743E331D36DB3","maxInactiveInterval(秒)":1800,"attributes":[{"name":"SPRING_SECURITY_CONTEXT","type":"org.springframework.security.core.context.SecurityContextImpl","bytes":1348}],"總位元組":1348}
```

**整理成一張表**：

| 屬性 | 誰放的 | 大小 | 內容 |
|---|---|---|---|
| `SPRING_SECURITY_SAVED_REQUEST` | `ExceptionTranslationFilter` | **1194** bytes | 你被擋下來時原本想打的那個請求（URL、方法、標頭、參數） |
| `SPRING_SECURITY_CONTEXT` | `HttpSessionSecurityContextRepository` | **1332** bytes | `SecurityContextImpl` → `Authentication` → principal + authorities |

⚠️ **三件值得記住的事**：

**① 一個「只是被擋下來過」的匿名訪客，就佔掉了 1194 位元組。**

```
1194 bytes × 10000 個匿名訪客 ≈ 11.4 MB
```

**② `SPRING_SECURITY_CONTEXT` 的大小跟【權限數量】成正比。**

```
alice（ROLE_USER）                                 1332 bytes
admin（ROLE_ADMIN, ROLE_USER, order:refund）        1348 bytes
```

📌 **這是 03 章 3.7 那個「權限要放多細」的隱藏成本**：
RBAC 展開成一百個 `GrantedAuthority`，每個登入者的 session 就多幾 KB。
**而在叢集環境下，那些位元組每次都要序列化、傳輸、反序列化**（4.3.4）。

**③ `maxInactiveInterval` 預設是 1800 秒（30 分鐘）。**

```properties
server.servlet.session.timeout=30m     # 這是 Boot 的預設值
```

⚠️ **它是「閒置」時間，不是「總」時間**——只要有請求進來就重新計時。
**沒有內建的「絕對逾時」**（登入超過 8 小時一律重登），那要自己做：
在 session 裡存一個登入時間戳，用一個 Filter 檢查。

### 4.2.3 🔴 實測：`STATELESS` 擋不住 session 被建立

**03 章每一條 chain 都寫了這一行**：

```java
.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
```

**大部分人以為它的意思是「這個服務不會有 session」。不是。**

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

/** 4.2.3：STATELESS 到底關掉了什麼 —— 以及【沒有】關掉什麼。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch4", "se2"})
class StatelessSessionTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); }

    void step(String label, HttpResponse<String> r) {
        String sc = Web.setCookieOf(r, "JSESSIONID");
        System.out.printf("   %-40s → %-3d  Set-Cookie: %-46s %s%n",
                label, r.statusCode(), sc == null ? "（沒有）" : sc, Web.brief(r, 60).substring(4));
    }

    @Test
    void statelessDoesNotPreventSessionCreation() {
        System.out.println("\n═══ 4.2.3 🔴 STATELESS 擋不住 session 被建立 ═══");
        String auth = Web.basic("alice", "pw");

        System.out.println("\n   ① 不碰 session 的端點：");
        Web w1 = new Web(port);
        step("GET /s/notouch", w1.get("/s/notouch", "Authorization", auth));
        step("GET /s/peek   （getSession(false)）", w1.get("/s/peek", "Authorization", auth));

        System.out.println("\n   ② 🔴 Controller 呼叫了一次 request.getSession()：");
        Web w2 = new Web(port);
        step("GET /s/touch  （getSession()）", w2.get("/s/touch", "Authorization", auth));
        step("GET /s/peek   （帶著上一步的 cookie）", w2.get("/s/peek", "Authorization", auth));

        System.out.println("\n   ③ session 真的存在，但 Spring Security 不用它存身分：");
        step("GET /s/dump", w2.get("/s/dump", "Authorization", auth));
        System.out.println("\n   ④ 只帶 cookie、不帶 Authorization（STATELESS 下身分不會從 session 還原）：");
        step("GET /s/notouch", w2.get("/s/notouch"));
    }
}
```

```
═══ 4.2.3 🔴 STATELESS 擋不住 session 被建立 ═══

   ① 不碰 session 的端點：
   GET /s/notouch                           → 200  Set-Cookie: （沒有）                                            {"endpoint":"/s/notouch","who":"alice"}
   GET /s/peek   （getSession(false)）        → 200  Set-Cookie: （沒有）                                            {"endpoint":"/s/peek","sessionExists":false,"sessionId":null…

   ② 🔴 Controller 呼叫了一次 request.getSession()：
   GET /s/touch  （getSession()）             → 200  Set-Cookie: JSESSIONID=3FE6279C4B0B625830288EC01925A586; Path=/; HttpOnly  {"endpoint":"/s/touch","sessionId":"3FE6279C4B0B625830288EC0…
   GET /s/peek   （帶著上一步的 cookie）            → 200  Set-Cookie: JSESSIONID=794161EDA873FF3E3FE9BC8A2DD1A440; Path=/; HttpOnly  {"endpoint":"/s/peek","sessionExists":true,"sessionId":"7941…

   ③ session 真的存在，但 Spring Security 不用它存身分：
   GET /s/dump                              → 200  Set-Cookie: JSESSIONID=F3B1B708F9EAAED965F852A59CA1739C; Path=/; HttpOnly  {"endpoint":"/s/dump","sessionExists":true,"sessionId":"F3B1…

   ④ 只帶 cookie、不帶 Authorization（STATELESS 下身分不會從 session 還原）：
   GET /s/notouch                           → 401  Set-Cookie: （沒有）                                            {"status":401,"e…
```

**`STATELESS` 真正的意思**：

```
✅ 它做的事：叫 Spring Security【不要】用 session 存 SecurityContext
             （身分改存在 RequestAttributeSecurityContextRepository —— 只活在這一個請求裡）

🔴 它【沒有】做的事：
   ① 不會阻止你的 Controller 呼叫 request.getSession()
   ② 不會阻止容器建立 session
   ③ 不會把已經存在的 session 清掉
```

⚠️ **第 ② 列與第 ③ 列的 session id 每次都不一樣，這不是筆誤。**

```
② /s/touch  建立了 0AF2C36F…
   /s/peek   帶著 0AF2C36F… 去，卻拿到 3C418608…
③ /s/dump   帶著 3C418608… 去，又拿到 CF95ECA3…
```

**原因**：Basic 認證在**每一個請求**上都重新認證一次，
而每一次認證成功都會觸發一次 **session fixation 防護**（4.3.1），把 id 換掉。
📌 **在無狀態服務裡，session 不只是多餘的——它連「同一個 session」都維持不住。**

**第 ④ 列則證明了 `STATELESS` 確實有生效**：
cookie 還在，session 也還在，但**身分沒有從 session 還原**，所以是 401。

### 4.2.4 🔴 實測：一個「無狀態」的 API 長出了 200 個 session

**上面那個「多一個 session」看起來無害。把它放大到真實流量**：

```java
package com.example.lab09.ch04;

import com.example.lab09.Http;
import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/**
 * 4.2.4：一個「無狀態」的 API，在什麼情況下會長出一堆 session。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch4", "se2"})
class SessionLeakTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); }

    @Test
    void statelessApiLeaksSessions() {
        System.out.println("\n═══ 4.2.4 一個【宣告 STATELESS】的 API 長出了幾個 session ═══");
        Http http = new Http(port);
        String auth = Http.basic("alice", "pw");
        int N = 200;

        for (String[] c : new String[][]{
                {"/s/notouch", "完全不碰 session 的端點"},
                {"/s/peek",    "只做 getSession(false)"},
                {"/s/touch",   "🔴 呼叫了一次 getSession()"}}) {
            http.send("POST", "/s/stats/reset", null, "Authorization", auth);
            for (int i = 0; i < N; i++)
                http.get(c[0], "Authorization", auth);        // ★ 不帶 cookie —— 就像 App / curl / 伺服器對伺服器
            String stats = http.get("/s/stats", "Authorization", auth).body();
            System.out.printf("   %-28s %d 個請求 → %s%n", c[1], N, stats);
        }

        System.out.println("""
                
                   （「不帶 cookie」不是刻意刁難：App、curl、伺服器對伺服器呼叫、
                     以及任何把 JSESSIONID 丟掉的客戶端，行為都是這樣。）""");
    }
}
```

```
═══ 4.2.4 一個【宣告 STATELESS】的 API 長出了幾個 session ═══
   完全不碰 session 的端點             200 個請求 → {"建立過":0,"銷毀過":0,"還活著":0}
   只做 getSession(false)         200 個請求 → {"建立過":0,"銷毀過":0,"還活著":0}
   🔴 呼叫了一次 getSession()        200 個請求 → {"建立過":200,"銷毀過":0,"還活著":200}

（「不帶 cookie」不是刻意刁難：App、curl、伺服器對伺服器呼叫、
  以及任何把 JSESSIONID 丟掉的客戶端，行為都是這樣。）
```

🔴 **200 個請求 → 200 個還活著的 session，而且一個都沒有被銷毀。**

**它們會活到逾時為止（預設 30 分鐘）。** 算一下規模：

```
100 req/s × 60 × 30 = 180000 個 session 同時活著
每個至少 1 KB                ≈ 180 MB 的 heap，純粹是垃圾
```

⚠️ **這個 bug 的三個特徵，讓它特別難查**：

```
① 功能完全正常 —— 沒有任何請求失敗
② 本機測不出來 —— 開發時的請求量太小，而且瀏覽器會帶 cookie（不會每次都新建）
③ 症狀是「跑一陣子之後記憶體用量爬升、GC 變頻繁」—— 看起來像記憶體洩漏，不像安全設定
```

📌 **`getSession()` 會被誰不小心呼叫到？**

```java
request.getSession()                        // 直接呼叫
session.setAttribute(...)                   // 任何 HttpSession 的用法
@SessionAttributes / @SessionScope          // Spring MVC 的 session 作用域
RequestContextHolder…getSession()           // 某些工具類別內部會碰
Spring Session / Flash attributes           // redirect 時的 flash scope 也走 session
```

✅ **三個處理方式**：

```
① 用 4.1.1 的 SessionCounter 接上監控 —— live() 在無狀態服務上應該長期是 0
② 真的無狀態的服務，把 session 關到底：
     server.servlet.session.timeout=1m        （減少殘留時間，治標）
     或在 Filter 裡包一層 HttpServletRequestWrapper 讓 getSession() 直接丟例外（治本、但要小心）
③ 🔴 最重要的：搞清楚是誰呼叫的。上面那五個來源，用一次 stack trace 就抓得到。
```

### 4.2.5 `SecurityContextRepository`：身分的四個去處

01 章 1.5.3 提過 `SecurityContextHolderFilter` 會從 `SecurityContextRepository` 把身分讀出來。
**這一章要把那個 repository 的選項攤開**：

| 實作 | 身分存在哪 | 下一個請求還認得你嗎 | 用在 |
|---|---|---|---|
| `HttpSessionSecurityContextRepository` | HTTP session | ✅ 認得 | 傳統網頁登入（`formLogin` 預設） |
| `RequestAttributeSecurityContextRepository` | 這一個請求的 attribute | ❌ 不認得 | `STATELESS`（每個請求自己帶憑證） |
| `NullSecurityContextRepository` | **哪裡都不存** | ❌ 不認得 | 完全不需要保存的情境 |
| `DelegatingSecurityContextRepository` | 委派給上面幾個 | 看委派對象 | **6.x 的預設**（同時寫 session 與 request attribute） |

📌 **4.1.2 那份報表印的就是這一欄。** 回頭看那三種設定：

```
表單登入        DelegatingSecurityContextRepository → HttpSession… + RequestAttribute…
STATELESS       RequestAttributeSecurityContextRepository
```

⚠️ **`RequestAttributeSecurityContextRepository` 出現在「預設」那一組裡，是有原因的**：
同一個請求裡，認證發生在 Filter，而 Controller 稍後才讀 `SecurityContextHolder`。
中間如果換了執行緒（`@Async`、`WebAsyncManager`），request attribute 這一份是備援。
**它不是「無狀態專用」，它是「這一趟請求內」的快取。**

---

## 4.3 Session 管理

### 4.3.1 實測：`sessionFixation` 的四個選項

**先講攻擊本身。** Session fixation 的形狀是「**攻擊者先把 session id 塞給你**」：

```
① 攻擊者自己去 shop 拿一個 session id：S1（還沒登入，是匿名的）
② 攻擊者想辦法讓受害者的瀏覽器用【同一個 S1】
     —— 舊網站會把 session id 放在網址上（;jsessionid=S1），寄一個連結就行
     —— 或者透過子網域、XSS 種一個 cookie
③ 受害者在那個頁面【正常登入】了
④ 🔴 如果伺服器登入後【沿用 S1】，攻擊者手上那個 S1 就變成了已登入的 session
```

📌 **關鍵在第 ④ 步：登入成功時，要不要換一個新的 session id。**
Spring Security 提供四個選項：

```java
package com.example.lab09.ch04;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.NullSecurityContextRepository;

/** 4.2～4.3 的 session 情境。每一個只差一兩行，差異全部寫在註解上。 */
public class SessionScenarios {

    /** se1：最普通的表單登入 —— sessionCreationPolicy 預設是 IF_REQUIRED */
    @Configuration
    @Profile("se1")
    static class Se1_FormLogin {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    // /s/dump 等觀察用端點放行，才看得到「還沒登入時」session 長什麼樣
                    .requestMatchers("/error", "/api/hello", "/s/dump", "/s/peek", "/s/put", "/s/get").permitAll()
                    .anyRequest().authenticated())
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())                    // CSRF 留到 4.4，這裡先關掉免得干擾
                .build();
        }
    }

    /** se2：Basic + STATELESS —— 03 章每一條 chain 都是這樣寫的 */
    @Configuration
    @Profile("se2")
    static class Se2_Stateless {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello").permitAll()
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** se3：🔴 sessionFixation().none() —— 登入後【沿用】原本那個 session id */
    @Configuration
    @Profile("se3")
    static class Se3_FixationNone {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                        // ★ 登入【之前】就要能建立 session 並寫一個屬性 —— 4.3.1 的攻擊者就是這樣做的
                        .requestMatchers("/error", "/api/hello", "/s/put", "/s/get", "/s/peek").permitAll()
                        .anyRequest().authenticated())
                .sessionManagement(s -> s.sessionFixation(f -> f.none()))
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** se4：sessionFixation().newSession() —— 建新的，舊屬性【不】搬過去 */
    @Configuration
    @Profile("se4")
    static class Se4_FixationNewSession {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                        // ★ 登入【之前】就要能建立 session 並寫一個屬性 —— 4.3.1 的攻擊者就是這樣做的
                        .requestMatchers("/error", "/api/hello", "/s/put", "/s/get", "/s/peek").permitAll()
                        .anyRequest().authenticated())
                .sessionManagement(s -> s.sessionFixation(f -> f.newSession()))
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** se5：sessionFixation().migrateSession() —— 建新的，舊屬性【會】搬過去 */
    @Configuration
    @Profile("se5")
    static class Se5_FixationMigrate {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                        // ★ 登入【之前】就要能建立 session 並寫一個屬性 —— 4.3.1 的攻擊者就是這樣做的
                        .requestMatchers("/error", "/api/hello", "/s/put", "/s/get", "/s/peek").permitAll()
                        .anyRequest().authenticated())
                .sessionManagement(s -> s.sessionFixation(f -> f.migrateSession()))
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** se6：sessionFixation().changeSessionId() —— ★ Servlet 3.1 起的預設值 */
    @Configuration
    @Profile("se6")
    static class Se6_FixationChangeId {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                        // ★ 登入【之前】就要能建立 session 並寫一個屬性 —— 4.3.1 的攻擊者就是這樣做的
                        .requestMatchers("/error", "/api/hello", "/s/put", "/s/get", "/s/peek").permitAll()
                        .anyRequest().authenticated())
                .sessionManagement(s -> s.sessionFixation(f -> f.changeSessionId()))
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** se9：SecurityContextRepository 換成 Null —— 認證成功了，但【什麼都不存】 */
    @Configuration
    @Profile("se9")
    static class Se9_NullRepository {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                        // ★ 登入【之前】就要能建立 session 並寫一個屬性 —— 4.3.1 的攻擊者就是這樣做的
                        .requestMatchers("/error", "/api/hello", "/s/put", "/s/get", "/s/peek").permitAll()
                        .anyRequest().authenticated())
                .securityContext(c -> c.securityContextRepository(new NullSecurityContextRepository()))
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**四個選項跑同一組動作**：

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.boot.web.context.WebServerApplicationContext;

import java.net.http.HttpResponse;

/**
 * 4.3.1：sessionFixation 的四個選項，在同一組動作下各跑一次。
 *
 * 一次比四種設定，所以不能用 @ActiveProfiles（那只給得起一種）——
 * 改成在測試裡自己起四個 context。
 */
@SpringBootTest
@ActiveProfiles({"db", "ch4"})
class FixationTest {

    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); }

    record Result(String before, String after, String cartAfterLogin, int oldSessionStatus) {}

    @Test
    void fourOptions() {
        System.out.println("""
                
                ═══ 4.3.1 sessionFixation 的四個選項 ═══
                每一種都跑同一組動作：
                  ① 還沒登入，先建立一個 session，並在裡面寫 cart=ABC（模擬購物車 —— 也模擬攻擊者）
                  ② 用同一個 session 登入 alice
                  ③ 看登入後的 session id 換了沒、cart 還在不在
                  ④ 把【登入前那個 id】單獨拿出來打一支要登入的端點 —— 這就是 fixation 攻擊""");

        System.out.printf("%n   %-18s %-12s %-12s %-10s %s%n",
                "設定", "登入前 id", "登入後 id", "cart 還在", "拿舊 id 打受保護端點");
        System.out.println("   " + "─".repeat(86));
        for (String[] c : new String[][]{
                {"se3", "none()"}, {"se4", "newSession()"},
                {"se5", "migrateSession()"}, {"se6", "changeSessionId()★預設"}}) {
            Result r = run(c[0]);
            System.out.printf("   %-18s %-12s %-12s %-10s %s%n",
                    c[1], head(r.before), head(r.after),
                    r.cartAfterLogin == null ? "✗ 不見了" : "✓ " + r.cartAfterLogin,
                    r.oldSessionStatus == 200 ? "🔴 " + r.oldSessionStatus + " 攻擊成功"
                                              : "✅ " + r.oldSessionStatus + " 攻擊失敗");
        }
    }

    static String head(String id) { return id == null ? "(無)" : id.substring(0, 8) + "…"; }

    Result run(String profile) {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                .web(WebApplicationType.SERVLET)
                .profiles("db", "ch4", profile)
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF")
                .run()) {
            int port = ((WebServerApplicationContext) ctx).getWebServer().getPort();

            Web victim = new Web(port);
            victim.post("/s/put?k=cart&v=ABC", null);            // ① 登入前的 session
            String before = victim.sessionId();

            victim.formLogin("alice", "pw", true);               // ② 登入
            String after = victim.sessionId();

            HttpResponse<String> got = victim.get("/s/get?k=cart");   // ③ cart 還在嗎
            String cart = got.body() != null && got.body().contains("\"cart\":\"ABC\"") ? "ABC" : null;

            Web attacker = new Web(port);                        // ④ 只拿登入【前】那個 id
            attacker.setCookie("JSESSIONID", before);
            int status = attacker.get("/s/notouch").statusCode();

            return new Result(before, after, cart, status);
        }
    }
}
```

```
═══ 4.3.1 sessionFixation 的四個選項 ═══
每一種都跑同一組動作：
  ① 還沒登入，先建立一個 session，並在裡面寫 cart=ABC（模擬購物車 —— 也模擬攻擊者）
  ② 用同一個 session 登入 alice
  ③ 看登入後的 session id 換了沒、cart 還在不在
  ④ 把【登入前那個 id】單獨拿出來打一支要登入的端點 —— 這就是 fixation 攻擊

   設定                 登入前 id       登入後 id       cart 還在    拿舊 id 打受保護端點
   ──────────────────────────────────────────────────────────────────────────────────────
   none()             21AC005A…    21AC005A…    ✓ ABC      🔴 200 攻擊成功
   newSession()       5149C2DC…    DFD946CA…    ✗ 不見了      ✅ 302 攻擊失敗
   migrateSession()   4AD6096D…    2E6B21F8…    ✓ ABC      ✅ 302 攻擊失敗
   changeSessionId()★預設 11935D2A…    A6625596…    ✓ ABC      ✅ 302 攻擊失敗
```

**逐欄判讀**：

| 選項 | 換 id 嗎 | 舊屬性保留嗎 | 固定攻擊 | 什麼時候用 |
|---|---|---|---|---|
| `none()` | ❌ | ✓（同一個 session） | 🔴 **成立** | **永遠不要用** |
| `newSession()` | ✅ | ❌ **全部丟掉** | ✅ 失效 | 登入前的東西一律不要（最保守） |
| `migrateSession()` | ✅ | ✓ 搬到新 session | ✅ 失效 | Servlet 3.0 以前的預設 |
| `changeSessionId()` | ✅ | ✓（**同一個 session 換名字**） | ✅ 失效 | ★ **Servlet 3.1 起的預設，用它** |

⚠️ **`migrateSession()` 與 `changeSessionId()` 的差別，在「購物車」那一欄看不出來，但機制不同**：

```
migrateSession()    建一個【新的】session → 把舊的屬性一個一個複製過去 → 讓舊的失效
changeSessionId()   呼叫 Servlet 3.1 的 request.changeSessionId() → 【同一個 session 物件換一個 id】
```

📌 **`changeSessionId()` 比較好的兩個理由**：

```
① 不用複製屬性 —— 購物車很大時省掉一次深拷貝
② 容器層級的操作 —— HttpSessionIdListener 收得到通知，叢集實作（Spring Session）也支援
```

🔴 **`none()` 那一列是這一節的重點**：

```
登入前 id  21AC005A…
登入後 id  21AC005A…      ← 一模一樣
拿舊 id 打受保護端點 → 200  ← 攻擊者手上那個 id 現在是 alice
```

⚠️ **什麼時候有人會寫 `none()`？** 兩個常見的理由，兩個都不夠好：

```
「登入後購物車不見了」          → 用 changeSessionId() 或 migrateSession()，不是 none()
「換 id 會讓我的 WebSocket 斷」  → 那是 WebSocket 要重連，不是安全機制該讓步
```

### 4.3.2 🔴 實測：`maximumSessions(1)` 設了，但一點作用都沒有

**「同一個帳號只能登入一台」**——需求很常見，設定也只有一行：

```java
package com.example.lab09.ch04;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.session.SessionRegistryImpl;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.session.HttpSessionEventPublisher;

/** 4.3.2～4.3.3：同一個帳號能同時登入幾台、以及怎麼把一個還活著的 session 踢掉。 */
public class ConcurrencyScenarios {

    /** se7 / se8 共用的 registry。⚠️ 沒有 HttpSessionEventPublisher 的話，登出/逾時不會從 registry 移除 */
    @Configuration
    @Profile("se7 | se8 | se7eq")
    static class RegistryConfig {
        @Bean SessionRegistry sessionRegistry() { return new SessionRegistryImpl(); }
        @Bean HttpSessionEventPublisher httpSessionEventPublisher() { return new HttpSessionEventPublisher(); }
    }

    /** se7：maximumSessions(1) —— 預設行為是【踢掉舊的】 */
    @Configuration
    @Profile("se7 | se7eq")
    static class Se7_KickOldest {
        @Bean SecurityFilterChain chain(HttpSecurity http, SessionRegistry registry) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/put", "/s/get", "/s/peek").permitAll()
                    .anyRequest().authenticated())
                .sessionManagement(s -> s
                    .maximumSessions(1)
                    .sessionRegistry(registry))                 // maxSessionsPreventsLogin 預設 false
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** se8：maximumSessions(1) + maxSessionsPreventsLogin(true) —— 改成【拒絕新的登入】 */
    @Configuration
    @Profile("se8")
    static class Se8_PreventLogin {
        @Bean SecurityFilterChain chain(HttpSecurity http, SessionRegistry registry) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/put", "/s/get", "/s/peek").permitAll()
                    .anyRequest().authenticated())
                .sessionManagement(s -> s
                    .maximumSessions(1)
                    .maxSessionsPreventsLogin(true)             // ★ 只差這一行
                    .sessionRegistry(registry))
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

**還需要一支「看 registry 裡有誰」的端點**，以及 4.3.3 要用的踢人端點：

```java
package com.example.lab09.ch04;

import org.springframework.context.annotation.Profile;
import org.springframework.security.core.session.SessionInformation;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/**
 * 4.3.3：把「一個還活著的 session」作廢。
 * 02 章 2.7.7 與 03 章 3.7.7 留下的那兩個問題（停用帳號 / 收回權限不會立刻生效），
 * 答案就是這支端點做的事。
 */
@RestController
@RequestMapping("/s/admin")
@Profile("se7 | se8 | se7eq")
public class SessionAdminController {

    private final SessionRegistry registry;
    public SessionAdminController(SessionRegistry registry) { this.registry = registry; }

    /** 目前 registry 裡有哪些人、各有幾個 session */
    @GetMapping("/sessions")
    public List<Map<String, Object>> sessions() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object p : registry.getAllPrincipals())
            for (SessionInformation si : registry.getAllSessions(p, true)) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("who", p instanceof UserDetails u ? u.getUsername() : String.valueOf(p));
                m.put("sessionId", si.getSessionId());
                m.put("lastRequest", String.valueOf(si.getLastRequest()));
                m.put("expired", si.isExpired());
                out.add(m);
            }
        return out;
    }

    /** registry 是用 principal 當 key 的 —— 這支端點就是在問「它認為有幾個人」 */
    @GetMapping("/principals")
    public Map<String, Object> principals() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("principal 數", registry.getAllPrincipals().size());
        List<String> types = new ArrayList<>();
        for (Object p : registry.getAllPrincipals())
            types.add(p.getClass().getSimpleName() + "  hashCode=" + p.hashCode()
                    + "  sessions=" + registry.getAllSessions(p, false).size());
        out.put("每個 principal", types);
        return out;
    }

    /** 把某個帳號手上【所有】的 session 標記成過期 —— 下一個請求就會被踢掉 */
    @PostMapping("/kick")
    public Map<String, Object> kick(@RequestParam String username) {
        int n = 0;
        for (Object p : registry.getAllPrincipals()) {
            String name = p instanceof UserDetails u ? u.getUsername() : String.valueOf(p);
            if (!name.equals(username)) continue;
            for (SessionInformation si : registry.getAllSessions(p, false)) {
                si.expireNow();                                  // ★ 就是這一行
                n++;
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();      // ⚠️ Map.of() 不保證欄位順序
        out.put("username", username);
        out.put("標記過期的 session 數", n);
        return out;
    }
}
```

**兩台裝置各登入一次**：

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest
@ActiveProfiles({"db", "ch4"})
@TestMethodOrder(MethodOrderer.MethodName.class)
class ConcurrentSessionTest {

    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); }

    interface Body { void run(int port); }

    void withPort(Body b, String... extraProfiles) {
        String[] profiles = new String[extraProfiles.length + 2];
        profiles[0] = "db"; profiles[1] = "ch4";
        System.arraycopy(extraProfiles, 0, profiles, 2, extraProfiles.length);
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                .web(WebApplicationType.SERVLET).profiles(profiles)
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF").run()) {
            b.run(((WebServerApplicationContext) ctx).getWebServer().getPort());
        }
    }

    static void line(String label, HttpResponse<String> r) {
        System.out.printf("      %-34s → %s%n", label, Web.brief(r, 76));
    }

    @Test
    void a_limitSilentlyIgnored() {
        System.out.println("\n═══ 4.3.2 🔴 maximumSessions(1) 設了，但一點作用都沒有 ═══");
        withPort(port -> {
            Web laptop = new Web(port), phone = new Web(port);
            System.out.println("      筆電登入 → " + laptop.formLogin("alice", "pw"));
            System.out.println("      手機登入 → " + phone.formLogin("alice", "pw"));
            line("手機打受保護端點", phone.get("/s/notouch"));
            line("🔴 筆電【應該被踢掉了】", laptop.get("/s/notouch"));
            System.out.println("      registry 認為有幾個人 → " + phone.get("/s/admin/principals").body());
        }, "se7");
    }

    @Test
    void b_fixedWithEquals() {
        System.out.println("\n═══ 4.3.2 principal 補上 equals / hashCode 之後 ═══");
        withPort(port -> {
            Web laptop = new Web(port), phone = new Web(port);
            System.out.println("      筆電登入 → " + laptop.formLogin("alice", "pw"));
            System.out.println("      手機登入 → " + phone.formLogin("alice", "pw"));
            System.out.println("      registry 認為有幾個人 → " + phone.get("/s/admin/principals").body());
            line("手機打受保護端點", phone.get("/s/notouch"));
            line("✅ 筆電【被踢掉了】", laptop.get("/s/notouch"));
        }, "se7eq", "eq");
    }

    @Test
    void c_preventsLogin() {
        System.out.println("\n═══ 4.3.2 maxSessionsPreventsLogin(true)：改成拒絕【新的】登入 ═══");
        withPort(port -> {
            Web laptop = new Web(port), phone = new Web(port);
            System.out.println("      筆電登入 → " + laptop.formLogin("alice", "pw"));
            HttpResponse<String> second = phone.formLogin("alice", "pw", true);
            System.out.println("      手機登入 → " + second.statusCode()
                    + "   Location: " + second.headers().firstValue("location").orElse("(無)"));
            line("手機打受保護端點", phone.get("/s/notouch"));
            line("✅ 筆電還活著", laptop.get("/s/notouch"));
        }, "se8", "eq");
    }

    @Test
    void d_kickALiveSession() {
        System.out.println("\n═══ 4.3.3 把一個【還活著】的 session 立刻作廢 ═══");
        withPort(port -> {
            Web alice = new Web(port), admin = new Web(port);
            alice.formLogin("alice", "pw");
            admin.formLogin("admin", "pw");
            line("alice 打受保護端點", alice.get("/s/notouch"));
            line("admin 把 alice 踢掉", admin.post("/s/admin/kick?username=alice", null));
            line("🔴 alice 的下一個請求", alice.get("/s/notouch"));
            line("alice 再一個請求", alice.get("/s/notouch"));
            line("admin 自己不受影響", admin.get("/s/notouch"));
        }, "se7eq", "eq");
    }
}
```

```
═══ 4.3.2 🔴 maximumSessions(1) 設了，但一點作用都沒有 ═══
      筆電登入 → 302
      手機登入 → 302
      手機打受保護端點                           → 200  {"endpoint":"/s/notouch","who":"alice"}
      🔴 筆電【應該被踢掉了】                      → 200  {"endpoint":"/s/notouch","who":"alice"}
      registry 認為有幾個人 → {"principal 數":2,"每個 principal":["AppUserDetails  hashCode=1648318397  sessions=1","AppUserDetails  hashCode=307873180  sessions=1"]}
```

🔴 **筆電沒有被踢掉。`maximumSessions(1)` 形同不存在——而且啟動不報錯、沒有任何警告。**

**兇手在最後一行**：

```
{"principal 數":2,"每個 principal":["AppUserDetails  hashCode=1648318397  sessions=1",
                                    "AppUserDetails  hashCode=307873180  sessions=1"]}
```

**`SessionRegistry` 是用 principal 當 key 的 `Map`**：

```java
// SessionRegistryImpl（6.2.4，節錄）
private final ConcurrentMap<Object, Set<String>> principals;   // ★ key 是 principal 物件

public void registerNewSession(String sessionId, Object principal) {
    this.principals.compute(principal, (key, sessionsUsedByPrincipal) -> { ... });
}
```

**而 02 章 2.7.2 的 `AppUserDetails` 沒有覆寫 `equals` / `hashCode`**——
於是**每一次登入載入出來的那份快照，都是一個「不同的人」**：

```
第一次登入 → new AppUserDetails(alice)  hashCode=1648318397  → key A，1 個 session
第二次登入 → new AppUserDetails(alice)  hashCode=307873180   → key B，1 個 session

ConcurrentSessionControlAuthenticationStrategy 問的是：
   registry.getAllSessions(這一次的 principal)  →  【0 個】
   0 < 1（上限）→ 沒有超過 → 什麼都不做
```

✅ **修法：在 principal 上補 `equals` / `hashCode`，用【帳號】比對。**

```java
@Override public boolean equals(Object o) {
    return o instanceof AppUserDetails other && username.equals(other.username);
}
@Override public int hashCode() { return username.hashCode(); }
```

> 📌 **這是 02 章 2.7.2 那個類別要改的地方**（本章的對照組用一個獨立的
> `EqUserDetailsService` 來並存，那只是實驗專案的需要）：
>
> ```java
> package com.example.lab09.ch04;

import com.example.lab09.ch02.AppUser;
import com.example.lab09.ch02.AppUserRepo;
import org.springframework.context.annotation.Profile;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;

/**
 * 4.3.2 的對照組：跟 02 章 2.7.2 的 DbUserDetailsService 一模一樣，
 * 差別只有 principal 型別【有沒有 equals / hashCode】。
 *
 * ⚠️ 實驗專案才需要兩個版本並存；你自己的專案是直接在 AppUserDetails 上補那兩個方法。
 */
@Service
@Profile("eq")
public class EqUserDetailsService implements UserDetailsService {

    private final AppUserRepo repo;
    public EqUserDetailsService(AppUserRepo repo) { this.repo = repo; }

    @Override
    @Transactional(readOnly = true)
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        AppUser u = repo.findByUsernameWithAuthorities(username)
                .orElseThrow(() -> new UsernameNotFoundException(username));
        return new EqUserDetails(
                u.getUsername(), u.getPasswordHash(), u.getDisplayName(),
                u.isEnabled(), u.isAccountNonExpired(), u.isAccountNonLocked(),
                u.getCredentialsExpireAt() == null || u.getCredentialsExpireAt().isAfter(LocalDateTime.now()),
                u.getAuthorities().stream()
                        .map(a -> (GrantedAuthority) new SimpleGrantedAuthority(a.getAuthority())).toList());
    }

    /**
     * 跟 AppUserDetails 的欄位完全一樣，只多了 equals / hashCode。
     * ★ 只比 username —— 「同一個人」的定義是帳號，不是「這次載入的那份快照」。
     */
    public static final class EqUserDetails implements UserDetails {
        private final String username, password, displayName;
        private final boolean enabled, accountNonExpired, accountNonLocked, credentialsNonExpired;
        private final List<GrantedAuthority> authorities;

        EqUserDetails(String username, String password, String displayName, boolean enabled,
                      boolean accountNonExpired, boolean accountNonLocked, boolean credentialsNonExpired,
                      List<GrantedAuthority> authorities) {
            this.username = username; this.password = password; this.displayName = displayName;
            this.enabled = enabled; this.accountNonExpired = accountNonExpired;
            this.accountNonLocked = accountNonLocked; this.credentialsNonExpired = credentialsNonExpired;
            this.authorities = authorities;
        }

        @Override public Collection<? extends GrantedAuthority> getAuthorities() { return authorities; }
        @Override public String getPassword() { return password; }
        @Override public String getUsername() { return username; }
        @Override public boolean isAccountNonExpired() { return accountNonExpired; }
        @Override public boolean isAccountNonLocked() { return accountNonLocked; }
        @Override public boolean isCredentialsNonExpired() { return credentialsNonExpired; }
        @Override public boolean isEnabled() { return enabled; }
        public String getDisplayName() { return displayName; }

        @Override public boolean equals(Object o) {
            return o instanceof EqUserDetails other && username.equals(other.username);
        }
        @Override public int hashCode() { return username.hashCode(); }
    }
}
> ```

**補上之後，同一組動作再跑一次**：

```
═══ 4.3.2 principal 補上 equals / hashCode 之後 ═══
      筆電登入 → 302
      手機登入 → 302
      registry 認為有幾個人 → {"principal 數":1,"每個 principal":["EqUserDetails  hashCode=92903040  sessions=1"]}
      手機打受保護端點                           → 200  {"endpoint":"/s/notouch","who":"alice"}
      ✅ 筆電【被踢掉了】                         → 200  This session has been expired (possibly due to multiple concurrent logins be…
```

✅ **`principal 數` 從 2 變成 1，筆電被踢掉了。**

**換成「拒絕新的登入」**（`maxSessionsPreventsLogin(true)`）：

```
═══ 4.3.2 maxSessionsPreventsLogin(true)：改成拒絕【新的】登入 ═══
      筆電登入 → 302
      手機登入 → 302   Location: http://localhost:61653/login?error
      手機打受保護端點                           → 302
      ✅ 筆電還活著                            → 200  {"endpoint":"/s/notouch","who":"alice"}
```

**兩種行為的取捨**：

| | `maxSessionsPreventsLogin(false)`★預設 | `maxSessionsPreventsLogin(true)` |
|---|---|---|
| 行為 | 新的登入成功，**最舊的 session 被作廢** | **新的登入失敗**，舊的繼續用 |
| 使用者看到 | 舊裝置：「你已在其他裝置登入」 | 新裝置：登入失敗 |
| 適合 | 一般消費性服務（換手機要能直接用） | 高風險系統（金融後台、管理介面） |
| 🔴 風險 | 攻擊者**拿到密碼就能把你踢掉** | 攻擊者**可以用錯誤的登入把你鎖在外面**（DoS） |

⚠️ **兩種都有被濫用的可能，所以「上限」通常不是 1**。
比較實務的做法是 `maximumSessions(3~5)` + **在登入通知信裡列出所有活躍裝置**，
讓使用者自己踢——那需要的正是 4.3.3 那支端點。

⚠️ **`HttpSessionEventPublisher` 那個 bean 不能漏**：

```java
@Bean HttpSessionEventPublisher httpSessionEventPublisher() { return new HttpSessionEventPublisher(); }
```

沒有它，**session 逾時或登出時不會從 registry 移除**——
於是一個從來沒有真的登出過的人，幾天後就再也登不進來了（registry 裡累積了一堆死 session）。

📌 **4.1.2 的報表會提醒這件事**：有 `SessionRegistry` 時印一行
`ℹ️ 請確認 principal 有覆寫 equals/hashCode`，
而且第一次登入成功時會**實際檢查一次**並印出 🔴 警告。

### 4.3.3 實測：把一個【還活著】的 session 立刻作廢

**這一節回答兩個舊問題**：

```
02 章 2.7.7   把帳號停用了，那個人手上的 session 照樣能用
03 章 3.7.7   把權限收回來了，同一個 session 照樣 200
```

**答案是同一支 API**（上面 `SessionAdminController` 的 `/kick`），核心只有一行：

```java
for (SessionInformation si : registry.getAllSessions(p, false)) {
    si.expireNow();                                  // ★ 就是這一行
}
```

```
═══ 4.3.3 把一個【還活著】的 session 立刻作廢 ═══
      alice 打受保護端點                       → 200  {"endpoint":"/s/notouch","who":"alice"}
      admin 把 alice 踢掉                   → 200  {"username":"alice","標記過期的 session 數":1}
      🔴 alice 的下一個請求                    → 200  This session has been expired (possibly due to multiple concurrent logins be…
      alice 再一個請求                        → 302
      admin 自己不受影響                       → 200  {"endpoint":"/s/notouch","who":"admin"}
```

**三件事**：

**① `expireNow()` 不是立刻刪掉 session，是【標記】。**

真正把人擋下來的是 `ConcurrentSessionFilter`——它在**下一個請求**進來時發現
`SessionInformation.isExpired()`，才把 session 作廢並回應。
📌 **所以「立刻生效」的精確說法是「下一個請求就生效」**，而那通常是幾秒內。

**② 第一個請求拿到的是 200 + 一段純文字。**

```
🔴 alice 的下一個請求 → 200  This session has been expired (possibly due to multiple concurrent logins…
```

⚠️ **200！** 這是 `ConcurrentSessionFilter` 的預設 `SessionInformationExpiredStrategy`——
它直接把訊息寫進回應本體。**對 API 來說這是錯的**（前端會把它當成成功的回應）。
✅ **一定要換掉**：

```java
.sessionManagement(s -> s
    .maximumSessions(3)
    .sessionRegistry(registry)
    .expiredSessionStrategy(event -> {
        event.getResponse().setStatus(401);
        event.getResponse().setContentType("application/json;charset=UTF-8");
        event.getResponse().getWriter().write(
                "{\"error\":\"SESSION_EXPIRED\",\"message\":\"你的登入已在其他裝置被取代\"}");
    }))
```

**③ 第二個請求變成 302（導回登入頁），而 admin 完全不受影響。**

**這就是「精準撤銷一個人的登入狀態」**——
而它是 **session 相對於 JWT 最大的優勢**（05 章會看到 JWT 為了做到同一件事要付出什麼）。

📌 **接回那兩個舊問題的完整做法**：

```java
// 停用帳號時（02 章 2.7.7）
accountService.disable(username);
sessionAdmin.kick(username);          // ← 補這一行

// 收回權限時（03 章 3.7.7）
roleService.revoke(username, "order:refund");
sessionAdmin.kick(username);          // ← 補這一行（代價：那個人要重新登入）
```

⚠️ **「收回權限就把人踢掉」是最簡單、但不是唯一的做法。**
另一種是**讓權限不要進 session**——每個請求重查（03 章 3.7.7 量過：每個請求 2 句 SQL）。
**4.7 會把這個取捨攤開。**

### 4.3.4 叢集：session 要放哪裡

**單機時 session 在 JVM 的記憶體裡。兩台機器之後，問題就來了**：

```
使用者在 A 機登入 → session 在 A 機的記憶體
下一個請求被負載平衡送到 B 機 → B 機不認得這個 session id → 回到登入頁
```

**三個解法**：

| 做法 | 怎麼做 | 代價 |
|---|---|---|
| **① Sticky session** | 負載平衡器用 cookie 把同一個人固定送到同一台 | 🔴 那台掛掉 = 那批人全部登出；擴展 / 部署時流量不平均 |
| **② Session 複製** | 容器之間互相同步（Tomcat cluster） | 🔴 機器數量一多，同步流量與延遲爆炸；很少用在 4 台以上 |
| **③ 外部 session store** | **Spring Session** + Redis / JDBC | ✅ 主流做法；代價是每個請求多一次 Redis 往返，以及 **session 內容必須可序列化** |

**③ 的設定只有兩件事**：

```xml
<dependency>
  <groupId>org.springframework.session</groupId>
  <artifactId>spring-session-data-redis</artifactId>
</dependency>
```

```properties
spring.session.store-type=redis
spring.session.timeout=30m
```

⚠️ **「必須可序列化」是踩得最兇的一條。** 4.2.2 的 `/s/dump` 就是在量這件事——
它對每個屬性做一次 `ObjectOutputStream`，**寫不出來的會回 `-1`**。

```
SPRING_SECURITY_CONTEXT   1332 bytes    ✅ 可序列化
自己塞的 Entity / Service  -1           🔴 NotSerializableException
```

📌 **三條可以直接用的規則**：

```
① session 裡只放【小的、不可變的、可序列化的】東西 —— 最好只有 id 與幾個字串
🔴 不要放 JPA Entity（02 章 2.7.3 那個 LazyInitializationException 會在反序列化時重演）
🔴 不要放 Spring 的 bean（Service / Repository）—— 它們不可序列化，而且沒有意義
```

⚠️ **還有一個很少人想到的**：換成外部 store 之後，
**4.2.4 那個「漏 session」的 bug 從「浪費記憶體」升級成「每個請求多一次 Redis 寫入」**——
成本從本機 heap 變成網路往返與 Redis 的記憶體。**先把那個 bug 修掉，再上 Spring Session。**

---

## 4.4 CSRF：攻擊怎麼成立的

### 4.4.1 實測：token 從哪來、為什麼每次都不一樣

**先把機制講清楚。`CsrfFilter` 做的事只有四步**：

```
① 從 CsrfTokenRepository 把「這個 session 的 token」拿出來（沒有就產生一個）
② 把它放進 request attribute，讓畫面（Thymeleaf / 你的 JSON 端點）拿得到
③ 如果這是【需要檢查的方法】（不是 GET / HEAD / OPTIONS / TRACE）：
     從請求的 _csrf 參數或 X-CSRF-TOKEN 標頭取出使用者送來的那個，比對
④ 不相等 → 丟 AccessDeniedException（接手的是 ExceptionTranslationFilter，01 章 1.8.2）
```

**三個角色**：

| 角色 | 預設實作 | 負責 |
|---|---|---|
| `CsrfTokenRepository` | `HttpSessionCsrfTokenRepository` | token **存在哪裡**（session / cookie） |
| `CsrfTokenRequestHandler` | `XorCsrfTokenRequestAttributeHandler` | token **怎麼給出去**（6.x 起會做 XOR 遮罩） |
| `RequestMatcher` | `DefaultRequiresCsrfMatcher` | **哪些請求要檢查** |

**實測它**：

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

/** 4.4.1：token 從哪來、存哪裡、為什麼每次看到的值都不一樣。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "ch4", "cs1"})
class CsrfTokenTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void seed() { Seed3.reset(jdbc); }

    /** 從 /s/csrf 的 JSON 挖出 token 值 */
    static String tokenOf(String json) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"token\":\"([^\"]+)\"").matcher(json == null ? "" : json);
        return m.find() ? m.group(1) : null;
    }

    @Test
    void tokenMechanics() {
        System.out.println("\n═══ 4.4.1 同一個 session，連續取三次登入頁的 _csrf ═══");
        Web w = new Web(port);
        w.formLogin("alice", "pw", true);              // ★ 先登入 —— 登入會換 session id，token 也會跟著換
        String[] seen = new String[3];
        for (int i = 0; i < 3; i++) {
            seen[i] = tokenOf(w.get("/s/csrf").body());
            System.out.printf("   第 %d 次  _csrf = %s%n", i + 1, seen[i]);
        }
        System.out.println("   三次都一樣嗎？ " + (seen[0].equals(seen[1]) && seen[1].equals(seen[2])));
        System.out.println("   長度：" + seen[0].length() + " 字元");

        System.out.println("\n   ── 三個值【都】能用嗎（同一個 session）──");
        for (int i = 0; i < 3; i++) {
            HttpResponse<String> r = w.post("/s/transfer?to=t" + i + "&amount=1", null,
                    "Content-Type", "application/x-www-form-urlencoded", "X-CSRF-TOKEN", seen[i]);
            System.out.printf("   用第 %d 次拿到的 token → %d%n", i + 1, r.statusCode());
        }

        System.out.println("\n   ── 換一個 session 的 token 呢 ──");
        Web other = new Web(port);
        String otherToken = tokenOf(other.get("/s/csrf").body());
        HttpResponse<String> r = w.post("/s/transfer?to=x&amount=1", null,
                "Content-Type", "application/x-www-form-urlencoded", "X-CSRF-TOKEN", otherToken);
        System.out.println("   用【別人 session】的 token → " + r.statusCode());

        System.out.println("\n   ── 完全不帶 token ──");
        HttpResponse<String> none = w.post("/s/transfer?to=y&amount=1", null,
                "Content-Type", "application/x-www-form-urlencoded");
        System.out.println("   不帶 token → " + none.statusCode());
    }
}
```

```
═══ 4.4.1 同一個 session，連續取三次登入頁的 _csrf ═══
   第 1 次  _csrf = Fp6qseGnButMj5MpyDSGPE5rbwq-l05bLyFvl1dP39h4G446L6_OhdWVZIph66UcqxmyCXwPQjKJpHd2HEIJozZ377oeLb8D
   第 2 次  _csrf = K9ZhbII2FlsgArcWytIqC908nUTbdjW1F39L302yuJtYbdM_EucFWLYEdDoNZoEjqf8ePu9YsHzsRQyYJBwt6yyKiPk-W-IG
   第 3 次  _csrf = QTL8Ugc1ySJ8qt7XPn-HQ7g9yBbqkDw5eDll6pqD-9xwUfh0eAOYZjMHq0NRzujiXVKzdopZ5S7dowUUS1oD3vu7y74WZ8lN
   三次都一樣嗎？ false
   長度：96 字元

   ── 三個值【都】能用嗎（同一個 session）──
   用第 1 次拿到的 token → 200
   用第 2 次拿到的 token → 200
   用第 3 次拿到的 token → 200

   ── 換一個 session 的 token 呢 ──
   用【別人 session】的 token → 403

   ── 完全不帶 token ──
   不帶 token → 403
```

**四個發現**：

**① 同一個 session，每次拿到的 token 值【都不一樣】。**

這是 Spring Security 6 的預設行為（`XorCsrfTokenRequestAttributeHandler`）：
**真正的 token 只有一個，但每次給出去之前會用一組隨機亂數做 XOR 遮罩。**

```
真 token（存在 session 裡）    ： T
給出去的                       ： random ‖ (T XOR random)     ← 每次的 random 都不同
伺服器收到時                   ： 拆開、還原、跟 T 比對
```

📌 **為什麼要遮罩？** 防的是 **BREACH 攻擊**——
一種透過「壓縮後的回應長度」推測祕密的旁路攻擊。
同一個祕密如果每次都以相同的位元組出現在 HTML 裡，就會被統計出來。

**② 所以三個值【全部都有效】。** 它們只是同一個 token 的三種遮罩。

**③ 別人 session 的 token → 403。** token 是綁在 session 上的，這正是 CSRF 防護的根據。

**④ 完全不帶 → 403。**

⚠️ **遮罩這件事有一個實務後果**：

```
🔴 前端【不能】把 token 存起來重複用嗎？可以，但要存「拿到的那一份」，不能自己拼。
🔴 如果你的前端是從 cookie 讀 token（4.5.4），要把 handler 換成不做遮罩的那個：
     .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler())
   否則 cookie 裡是原始 token，而伺服器期待的是遮罩過的格式 —— 永遠 403。
```

### 4.4.2 🔴 實測：攻擊的完整流程

**先把攻擊者的能力界線劃清楚**——這是整節最重要的一張表：

| 攻擊者（`evil.com` 上的一段 HTML/JS） | 做得到嗎 |
|---|---|
| 讓受害者的瀏覽器對 `shop.com` 送出一個 `POST` | ✅ **做得到**（一個 `<form>` + `submit()`） |
| 讓那個請求**自動帶上** `shop.com` 的 cookie | ✅ **做得到**（瀏覽器的預設行為） |
| **讀取**那個請求的回應 | ❌ 做不到（同源政策擋住） |
| 讀到 `shop.com` 頁面裡的 CSRF token | ❌ 做不到（同源政策） |
| 自己加一個 `X-CSRF-TOKEN` 標頭 | ❌ 做不到（`<form>` 加不了標頭；`fetch` 加得了，但那會觸發 CORS 預檢） |
| 自己加 `Authorization` 標頭 | ❌ **做不到**（同上）——★ 這就是 4.5.1 判準的根據 |

📌 **「做得到送出、做不到讀取」就是 CSRF 的全部。**
攻擊者不需要看到回應——**轉帳這個動作本身就是目的**。

**三個設定各打同一個攻擊**：

```java
package com.example.lab09.ch04;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.*;

/** 4.4～4.5 的 CSRF 情境。 */
public class CsrfScenarios {

    /** cs1：什麼都不改 —— CSRF 預設就是開的（00 章 0.5.6 量過） */
    @Configuration
    @Profile("cs1")
    static class Cs1_Default {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/transfers", "/s/transfers/reset", "/s/csrf").permitAll()
                    .anyRequest().authenticated())
                .formLogin(Customizer.withDefaults())
                .build();                                  // ★ 沒有 csrf(...)，就是開著
        }
    }

    /** cs2：🔴 把 CSRF 關掉，但身分還是靠 cookie（session）攜帶 —— 這就是漏洞 */
    @Configuration
    @Profile("cs2")
    static class Cs2_DisabledWithSession {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/transfers", "/s/transfers/reset", "/s/csrf").permitAll()
                    .anyRequest().authenticated())
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())                    // ← 這一行 + 上面那行 formLogin = 漏洞
                .build();
        }
    }

    /** cs3：前後端分離 —— token 放進一個【JS 讀得到】的 cookie，前端再放回標頭 */
    @Configuration
    @Profile("cs3")
    static class Cs3_CookieRepository {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/transfers", "/s/transfers/reset", "/s/csrf").permitAll()
                    .anyRequest().authenticated())
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c
                    .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
                    // ★ 6.x 預設會對 token 做 XOR 遮罩；前端要原樣回傳就要換成這個
                    .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()))
                .build();
        }
    }

    /** cs4：真的無狀態 —— 身分靠 Authorization 標頭，CSRF 關掉是【對的】 */
    @Configuration
    @Profile("cs4")
    static class Cs4_StatelessBearer {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/transfers", "/s/transfers/reset", "/s/csrf").permitAll()
                    .anyRequest().authenticated())
                .httpBasic(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** cs5：cookie 加上 SameSite 屬性（由 server 宣告、由【瀏覽器】執行） */
    @Configuration
    @Profile("cs5")
    static class Cs5_SameSite {
        @Bean org.springframework.boot.web.servlet.server.CookieSameSiteSupplier sameSite() {
            return org.springframework.boot.web.servlet.server.CookieSameSiteSupplier.ofStrict();
        }
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/transfers", "/s/transfers/reset", "/s/csrf").permitAll()
                    .anyRequest().authenticated())
                .formLogin(Customizer.withDefaults())
                .csrf(c -> c.disable())
                .build();
        }
    }
}
```

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

/**
 * 4.4.2：CSRF 攻擊的完整流程。
 *
 * 攻擊者做不到的事：讀受害者的回應、拿到 CSRF token、改 Cookie 標頭。
 * 攻擊者做得到的事：讓受害者的瀏覽器【自動帶著 cookie】送出一個 POST。
 * 下面用同一個 Web（＝同一個瀏覽器的 cookie jar）＋ Origin/Referer 指向攻擊者網站來模擬。
 */
@SpringBootTest
@ActiveProfiles({"db", "ch4"})
@TestMethodOrder(MethodOrderer.MethodName.class)
class CsrfAttackTest {

    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed3.reset(jdbc); }

    static final String EVIL = "https://free-iphone.example.com";

    interface Body { void run(int port); }

    void withPort(String profile, Body b) {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                .web(WebApplicationType.SERVLET).profiles("db", "ch4", profile)
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF").run()) {
            b.run(((WebServerApplicationContext) ctx).getWebServer().getPort());
        }
    }

    /** 攻擊者網站上的那個 <form> 被自動送出時，瀏覽器會發的請求 */
    static HttpResponse<String> evilForm(Web victimBrowser) {
        return victimBrowser.post("/s/transfer?to=attacker&amount=100000", null,
                "Content-Type", "application/x-www-form-urlencoded",
                "Origin", EVIL,                       // ★ 瀏覽器會誠實標示來源
                "Referer", EVIL + "/win.html");
    }

    @Test
    void a_disabledCsrfWithSession() {
        System.out.println("\n═══ 4.4.2 🔴 CSRF 關掉 + session 認證：攻擊成立 ═══");
        withPort("cs2", port -> {
            Web victim = new Web(port);
            victim.post("/s/transfers/reset", null);     // 帳本是全域的，每個情境先歸零
            System.out.println("   ① 受害者在 shop 正常登入 → " + victim.formLogin("alice", "pw"));
            System.out.println("      手上的 cookie：" + victim.cookies());
            System.out.println("   ② 受害者【在另一個分頁】打開了 " + EVIL);
            System.out.println("      那頁有一個會自動送出的 <form action=\"…/s/transfer\">");
            HttpResponse<String> r = evilForm(victim);
            System.out.println("   ③ 瀏覽器送出的請求 → " + Web.brief(r, 100));
            System.out.println("   ④ 伺服器的帳本 → " + victim.get("/s/transfers").body());
        });
    }

    @Test
    void b_csrfEnabled() {
        System.out.println("\n═══ 4.4.2 CSRF 開著（預設）：同一個攻擊 ═══");
        withPort("cs1", port -> {
            Web victim = new Web(port);
            victim.post("/s/transfers/reset", null);     // 帳本是全域的，每個情境先歸零
            System.out.println("   ① 受害者正常登入 → " + victim.formLogin("alice", "pw"));
            HttpResponse<String> r = evilForm(victim);
            System.out.println("   ② 攻擊者的表單 → " + Web.brief(r, 100));
            System.out.println("   ③ 伺服器的帳本 → " + victim.get("/s/transfers").body());
            System.out.println("\n   對照：受害者【自己】在正常頁面上操作（帶得到 token）");
            String token = Web.csrfOf(victim.get("/login").body());
            HttpResponse<String> ok = victim.post("/s/transfer?to=friend&amount=100", null,
                    "Content-Type", "application/x-www-form-urlencoded",
                    "X-CSRF-TOKEN", token == null ? "" : token);
            System.out.println("   ④ 帶著 token 的同一個請求 → " + Web.brief(ok, 100));
        });
    }

    @Test
    void c_statelessBearer() {
        System.out.println("\n═══ 4.4.2 真的無狀態（身分靠 Authorization 標頭）：攻擊不成立 ═══");
        withPort("cs4", port -> {
            Web victim = new Web(port);
            victim.post("/s/transfers/reset", null);     // 帳本是全域的，每個情境先歸零
            System.out.println("   ① 受害者用 Basic 打一次 → "
                    + Web.brief(victim.get("/s/notouch", "Authorization", Web.basic("alice", "pw")), 60));
            System.out.println("      手上的 cookie：" + (victim.cookies().isEmpty() ? "（一個都沒有）" : victim.cookies()));
            HttpResponse<String> r = evilForm(victim);       // 攻擊者【沒辦法】加上 Authorization 標頭
            System.out.println("   ② 攻擊者的表單（帶不了 Authorization）→ " + Web.brief(r, 100));
            System.out.println("   ③ 伺服器的帳本 → " + victim.get("/s/transfers").body());
        });
    }
}
```

**① CSRF 關掉 + session 認證**：

```
═══ 4.4.2 🔴 CSRF 關掉 + session 認證：攻擊成立 ═══
   ① 受害者在 shop 正常登入 → 302
      手上的 cookie：{JSESSIONID=4B1D691A4AE2007C78F3FB836F72D6EA}
   ② 受害者【在另一個分頁】打開了 https://free-iphone.example.com
      那頁有一個會自動送出的 <form action="…/s/transfer">
   ③ 瀏覽器送出的請求 → 200  {"from":"alice","to":"attacker","amount":"100000","轉帳次數":1}
   ④ 伺服器的帳本 → {"轉帳次數":1,"明細":["alice → attacker 100000"]}
```

🔴 **`alice → attacker 100000`。受害者從頭到尾只是「打開了一個網頁」。**

**② CSRF 開著（預設）**：

```
═══ 4.4.2 CSRF 開著（預設）：同一個攻擊 ═══
   ① 受害者正常登入 → 302
   ② 攻擊者的表單 → 403  {"status":403,"error":"Forbidden","path":"/s/transfer"}
   ③ 伺服器的帳本 → {"轉帳次數":1,"明細":["alice → attacker 100000"]}

   對照：受害者【自己】在正常頁面上操作（帶得到 token）
   ④ 帶著 token 的同一個請求 → 200  {"from":"alice","to":"friend","amount":"100","轉帳次數":2}
```

✅ **403。而受害者自己在正常頁面上的同一個操作（帶得到 token）是 200。**

**③ 真的無狀態（身分靠 `Authorization` 標頭）**：

```
═══ 4.4.2 真的無狀態（身分靠 Authorization 標頭）：攻擊不成立 ═══
   ① 受害者用 Basic 打一次 → 200  {"endpoint":"/s/notouch","who":"alice"}
      手上的 cookie：（一個都沒有）
   ② 攻擊者的表單（帶不了 Authorization）→ 401  {"status":401,"error":"Unauthorized","path":"/s/transfer…
   ③ 伺服器的帳本 → {"轉帳次數":0,"明細":[]}
```

✅ **401。** 不是因為有 CSRF 防護——**是因為攻擊者根本放不進 `Authorization` 標頭**。
📌 **這就是「無狀態 API 可以關 CSRF」的真正理由**，而不是「因為它是 REST」。

⚠️ **注意受害者手上的 cookie：一個都沒有。** 這是關 CSRF 的**前提條件**，
而 4.5.2 會示範這個前提不成立時會發生什麼。

### 4.4.3 🔴 實測：用「檢查 Referer」代替 token

**自製方案裡最常見的一種**：既然攻擊來自別的網站，那就檢查 `Referer` 就好了？

```java
package com.example.lab09.ch04;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Arrays;

/** 4.4.3 / 4.5.2：兩個「看起來像無狀態、其實不是」的情境。 */
public class CsrfScenarios2 {

    /**
     * cs6：🔴 token 認證，但 token 存在【cookie】裡。
     * 很多「前後端分離」的專案是這樣做的 —— 因為 cookie 不用前端自己存。
     * 代價：身分又變成「瀏覽器自動攜帶」，CSRF 攻擊重新成立。
     */
    @Configuration
    @Profile("cs6")
    static class Cs6_TokenInCookie {

        /** 一個極簡的「讀 cookie 裡的 token 就當你登入」的過濾器（05 章的 JWT 版本會取代它） */
        static class CookieTokenFilter extends OncePerRequestFilter {
            @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                                      FilterChain chain) throws ServletException, IOException {
                Cookie[] cs = req.getCookies();
                if (cs != null) Arrays.stream(cs)
                        .filter(c -> c.getName().equals("AUTH"))
                        .findFirst()
                        .ifPresent(c -> {
                            var ctx = SecurityContextHolder.createEmptyContext();
                            ctx.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                                    c.getValue(), null, AuthorityUtils.createAuthorityList("ROLE_USER")));
                            SecurityContextHolder.setContext(ctx);
                        });
                chain.doFilter(req, res);
            }
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/transfers", "/s/transfers/reset", "/s/csrf", "/s/login-cookie").permitAll()
                    .anyRequest().authenticated())
                .addFilterBefore(new CookieTokenFilter(), BasicAuthenticationFilter.class)
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable())               // 🔴「反正是 token 認證」—— 但 token 在 cookie 裡
                .build();
        }
    }

    /**
     * cs7：🔴 用「檢查 Referer」代替 CSRF token。
     * 這是最常見的自製方案，而它的漏洞就在「沒有 Referer 的時候怎麼辦」。
     */
    @Configuration
    @Profile("cs7")
    static class Cs7_RefererCheck {

        static class RefererFilter extends OncePerRequestFilter {
            @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                                      FilterChain chain) throws ServletException, IOException {
                String m = req.getMethod();
                if (!m.equals("GET") && !m.equals("HEAD") && !m.equals("OPTIONS")) {
                    String referer = req.getHeader("Referer");
                    // 🔴 這一行就是洞：「沒有 Referer」被當成安全的
                    if (referer != null && !referer.startsWith("http://localhost")) {
                        res.setStatus(403);
                        res.getWriter().write("{\"error\":\"bad referer\"}");
                        return;
                    }
                }
                chain.doFilter(req, res);
            }
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/transfers", "/s/transfers/reset", "/s/csrf").permitAll()
                    .anyRequest().authenticated())
                .addFilterBefore(new RefererFilter(), BasicAuthenticationFilter.class)
                .formLogin(org.springframework.security.config.Customizer.withDefaults())
                .csrf(c -> c.disable())              // 用自製的 Referer 檢查取代
                .build();
        }
    }
}
```

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest
@ActiveProfiles({"db", "ch4"})
@TestMethodOrder(MethodOrderer.MethodName.class)
class CsrfDefenceTest {

    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed3.reset(jdbc); }

    static final String EVIL = "https://free-iphone.example.com";

    interface Body { void run(int port); }

    void withPort(String profile, Body b) {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                .web(WebApplicationType.SERVLET).profiles("db", "ch4", profile)
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF").run()) {
            b.run(((WebServerApplicationContext) ctx).getWebServer().getPort());
        }
    }

    static void line(String label, HttpResponse<String> r) {
        System.out.printf("   %-42s → %s%n", label, Web.brief(r, 82));
    }

    @Test
    void a_refererCheckIsNotEnough() {
        System.out.println("\n═══ 4.4.3 🔴 用「檢查 Referer」代替 CSRF token ═══");
        withPort("cs7", port -> {
            Web victim = new Web(port);
            victim.post("/s/transfers/reset", null);
            victim.formLogin("alice", "pw");
            line("① 攻擊者的表單（Referer = 攻擊者網站）",
                    victim.post("/s/transfer?to=attacker&amount=1", null, "Referer", EVIL + "/win.html"));
            line("② 🔴 同一個攻擊，【不送 Referer】",
                    victim.post("/s/transfer?to=attacker&amount=99999", null));
            line("③ 伺服器的帳本", victim.get("/s/transfers"));
            System.out.println("""
                    
                       攻擊者要拿掉 Referer 有好幾種現成的方法，都不需要任何特殊權限：
                         <meta name="referrer" content="no-referrer">
                         <a rel="noreferrer">、<img referrerpolicy="no-referrer">
                         Referrer-Policy: no-referrer 回應標頭
                         從 https 頁面送到 http 目標（瀏覽器本來就會拿掉）""");
        });
    }

    @Test
    void b_tokenInCookieBringsCsrfBack() {
        System.out.println("\n═══ 4.5.2 🔴 token 認證，但 token 存在 cookie 裡 ═══");
        withPort("cs6", port -> {
            Web victim = new Web(port);
            victim.post("/s/transfers/reset", null);
            line("① 受害者登入（token 被放進 cookie）", victim.post("/s/login-cookie?u=alice", null));
            System.out.println("      手上的 cookie：" + victim.cookies());
            line("② 正常請求", victim.get("/s/notouch"));
            line("③ 🔴 攻擊者的表單（跨站，帶不了標頭 —— 但 cookie 會自己去）",
                    victim.post("/s/transfer?to=attacker&amount=100000", null,
                            "Origin", EVIL, "Referer", EVIL + "/win.html"));
            line("④ 伺服器的帳本", victim.get("/s/transfers"));
        });
    }

    @Test
    void c_spaWithCookieRepository() {
        System.out.println("\n═══ 4.5.4 前後端分離：CookieCsrfTokenRepository ═══");
        withPort("cs3", port -> {
            Web spa = new Web(port);
            spa.post("/s/transfers/reset", null);
            spa.formLogin("alice", "pw");
            HttpResponse<String> boot = spa.get("/s/csrf");
            System.out.println("   ① 前端開機時打 GET /s/csrf → " + Web.brief(boot, 150));
            System.out.println("      回應順便種下的 cookie：" + Web.setCookieOf(boot, "XSRF-TOKEN"));
            System.out.println("      （HttpOnly 沒有出現 —— 這是刻意的，前端 JS 要讀得到）");
            String fromCookie = spa.cookie("XSRF-TOKEN");
            line("② 前端把 cookie 值放進 X-XSRF-TOKEN 標頭",
                    spa.post("/s/transfer?to=friend&amount=1", null, "X-XSRF-TOKEN", fromCookie));
            line("③ 🔴 攻擊者：cookie 會自己去，但【標頭放不進去】",
                    spa.post("/s/transfer?to=attacker&amount=100000", null,
                            "Origin", EVIL, "Referer", EVIL + "/win.html"));
            line("④ 伺服器的帳本", spa.get("/s/transfers"));
        });
    }

    @Test
    void d_sameSite() {
        System.out.println("\n═══ 4.5.3 SameSite：伺服器只能【宣告】，執行的是瀏覽器 ═══");
        for (String[] c : new String[][]{{"cs2", "沒有設定 SameSite"}, {"cs5", "CookieSameSiteSupplier.ofStrict()"}}) {
            withPort(c[0], port -> {
                Web w = new Web(port);
                w.formLogin("alice", "pw", true);
                HttpResponse<String> r = w.get("/s/notouch");
                // 登入那一步才會發 Set-Cookie，重新登入一次抓它
                Web w2 = new Web(port);
                HttpResponse<String> login = w2.formLogin("alice", "pw", true);
                System.out.printf("   %-34s Set-Cookie: %s%n", c[1], Web.setCookieOf(login, "JSESSIONID"));
            });
        }
    }
}
```

```
═══ 4.4.3 🔴 用「檢查 Referer」代替 CSRF token ═══
   ① 攻擊者的表單（Referer = 攻擊者網站）                  → 403  {"error":"bad referer"}
   ② 🔴 同一個攻擊，【不送 Referer】                    → 200  {"from":"alice","to":"attacker","amount":"99999","轉帳次數":1}
   ③ 伺服器的帳本                                   → 200  {"轉帳次數":1,"明細":["alice → attacker 99999"]}

攻擊者要拿掉 Referer 有好幾種現成的方法，都不需要任何特殊權限：
  <meta name="referrer" content="no-referrer">
  <a rel="noreferrer">、<img referrerpolicy="no-referrer">
  Referrer-Policy: no-referrer 回應標頭
  從 https 頁面送到 http 目標（瀏覽器本來就會拿掉）
```

🔴 **第二列：攻擊者只要【不送 Referer】，那道檢查就整個被跳過。**

**兇手是這一行**：

```java
if (referer != null && !referer.startsWith("http://localhost")) {   // 🔴 null 被當成安全的
```

⚠️ **那為什麼不寫成「沒有 Referer 就擋掉」？** 因為那會擋掉真實使用者：

```
使用者的瀏覽器 / 擴充套件設了 Referrer-Policy: no-referrer
公司的 proxy 把 Referer 拿掉（很常見的隱私政策）
從 https 頁面送到 http 目標 —— 瀏覽器【規範上】就會拿掉
書籤、手動輸入網址、某些 App 的 WebView
```

📌 **所以 Referer 檢查落入一個兩難**：

```
寬鬆（null 放行）  → 4.4.3 這個洞
嚴格（null 擋掉）  → 一部分真實使用者被擋在外面，而且你查不出原因
```

✅ **正確的做法是 `Origin` + `Sec-Fetch-Site`，而且是【加在 token 之上】，不是取代它**：

```
Origin 在【所有跨來源的寫入請求】上都會出現，而且不受 Referrer-Policy 影響
Sec-Fetch-Site: cross-site 是現代瀏覽器自動加的，攻擊者也改不掉
```

⚠️ **但兩者都依賴「瀏覽器有送」**，所以**它們是縱深防禦，不是主防線**。
**主防線永遠是 token。**

### 4.4.4 `CsrfFilter` 不檢查哪些請求

```java
// DefaultRequiresCsrfMatcher（6.2.4）
private static final HashSet<String> ALLOWED_METHODS =
        new HashSet<>(Arrays.asList("GET", "HEAD", "TRACE", "OPTIONS"));
```

**這四個方法完全不檢查。** 理由是它們**按定義應該是安全的**（不改變伺服器狀態）。

🔴 **所以一個「用 GET 改資料」的端點，等於自己把 CSRF 防護關掉**：

```java
@GetMapping("/admin/users/{id}/delete")        // 🔴 一個 <img src> 就能觸發
public void delete(@PathVariable Long id) { ... }
```

📌 **這是 00 章 0.5.7 那張「預設沒擋的六件事」之外，第七件預設擋不住的事**——
因為 Spring Security **沒辦法知道**你的 GET 端點會不會改資料。

✅ **兩條規則**：

```
① 會改變狀態的操作，一律用 POST / PUT / PATCH / DELETE —— 這不只是 REST 風格，是安全需求
② 03 章 3.9.4 的覆蓋表掃描，順手加一條：GET 端點的方法名有 delete/update/create 就報警
```

---

## 4.5 什麼時候可以關 CSRF

### 4.5.1 決策表

**00 章 0.5.6 給過一句話的判準。這裡把它展開**：

> **問一個問題：我的身分是【誰】送出去的？**

```
瀏覽器【自動】送的   → 攻擊者的網站也能讓它自動送 → ★ CSRF 成立，不可以關
你的 JS【主動】放的  → 攻擊者的網站放不進去        → CSRF 不成立，可以關
```

**展開成表**：

| 身分放在哪 | 誰送出去的 | CSRF | 該怎麼做 |
|---|---|---|---|
| **Session cookie**（`formLogin` 預設） | 瀏覽器自動 | 🔴 成立 | **開**（預設就是開的，別關） |
| **HTTP Basic**（瀏覽器記住憑證後） | 瀏覽器自動 | 🔴 成立 | **開**；更好的做法是不要用 Basic 做瀏覽器登入 |
| **`Authorization: Bearer …`**，token 存在 JS 記憶體 / `localStorage` | JS 主動放 | ✅ 不成立 | 可以關 |
| 🔴 **token 存在 cookie**，伺服器從 cookie 讀 | 瀏覽器自動 | 🔴 **成立** | **開**（4.5.2 實測） |
| **token 存在 cookie，但伺服器只從【標頭】讀** | JS 主動放 | ✅ 不成立 | 可以關（這是 4.5.4 的做法） |
| **API key / mTLS / 伺服器對伺服器** | 呼叫方主動放 | ✅ 不成立 | 可以關 |

⚠️ **第四列與第五列只差一個字，但結果相反**：

```
伺服器【從 cookie 讀 token】     → 瀏覽器會自動附上 → 🔴 CSRF 成立
伺服器【只從標頭讀 token】       → 瀏覽器不會自動放進標頭 → ✅ 不成立
   （cookie 只是「把 token 交給前端」的管道，不是認證的依據）
```

📌 **一句話版本**：

> **「有沒有 cookie」不是判準，「伺服器認不認 cookie 裡的東西當身分」才是。**

### 4.5.2 🔴 實測：token 存在 cookie 裡

**「我們是前後端分離、用 token 認證，所以 CSRF 關掉」**——
這句話在 token **存在 cookie 裡**的時候是錯的：

```
═══ 4.5.2 🔴 token 認證，但 token 存在 cookie 裡 ═══
   ① 受害者登入（token 被放進 cookie）                  → 200  {"issued":"alice"}
      手上的 cookie：{AUTH=alice-token}
   ② 正常請求                                     → 200  {"endpoint":"/s/notouch","who":"alice-token"}
   ③ 🔴 攻擊者的表單（跨站，帶不了標頭 —— 但 cookie 會自己去）     → 200  {"from":"alice-token","to":"attacker","amount":"100000","轉帳次數":1}
   ④ 伺服器的帳本                                   → 200  {"轉帳次數":1,"明細":["alice-token → attacker 100000"]}
```

🔴 **攻擊重新成立。** 而這個專案的設定看起來完全符合「無狀態」的樣子：

```java
.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
.csrf(c -> c.disable())               // 🔴「反正是 token 認證」—— 但 token 在 cookie 裡
```

⚠️ **為什麼會有人把 token 放 cookie？** 理由都很合理：

```
① localStorage 會被 XSS 讀走，cookie 可以設 HttpOnly
② 前端不用自己管 token 的存放與附加
③ 多個子網域可以共用
```

📌 **而 `HttpOnly` 正是最容易誤解的一個**：

```
HttpOnly 擋的是【XSS 讀走 token】
HttpOnly 【完全不影響】瀏覽器自動送出它 —— 所以 CSRF 一點都沒有變難
```

✅ **把 token 放 cookie 是可以的，但那就是「有狀態載體」，必須補上 CSRF 防護**：

```
① CSRF token（4.5.4）
② SameSite=Lax 或 Strict（4.5.3）—— 縱深防禦，不能當唯一防線
③ 檢查 Origin（4.4.3）—— 同上
```

### 4.5.3 實測：`SameSite`

```
═══ 4.5.3 SameSite：伺服器只能【宣告】，執行的是瀏覽器 ═══
   沒有設定 SameSite                      Set-Cookie: JSESSIONID=2566DE224D09295951F984A00E9578B0; Path=/; HttpOnly
   CookieSameSiteSupplier.ofStrict()  Set-Cookie: JSESSIONID=36026BD8EBFDCD7FF47A3F4D8A246CA5; Path=/; HttpOnly; SameSite=Strict
```

**`SameSite` 是 cookie 的一個屬性，由【瀏覽器】執行**：

| 值 | 跨站請求會帶這個 cookie 嗎 | 說明 |
|---|---|---|
| `Strict` | ❌ **都不帶** | 從別的網站點連結過來也不帶 → 使用者會看到「未登入」 |
| `Lax` | 只有**頂層導航的 GET** 會帶 | ★ 現代瀏覽器的預設值；`<form method="post">` 跨站送出**不帶** |
| `None` | ✅ 都帶 | 必須同時加 `Secure`；嵌入式情境（iframe、第三方 SDK）才需要 |

📌 **`Lax` 這一列就是 4.4.2 那個攻擊在現代瀏覽器上的實際結果**：
攻擊者的 `<form method="post">` 是跨站的非導航請求，**cookie 不會被帶上**。

⚠️ **所以 CSRF 已經被瀏覽器解決了嗎？【不是】，有四個缺口**：

```
① 舊瀏覽器 / 舊 WebView 不認識 SameSite —— 它們會忽略這個屬性，回到「全部都帶」
② 🔴 Lax 仍然允許【跨站的 GET 導航】帶 cookie
     → 4.4.4 那個「用 GET 改資料」的端點在 SameSite=Lax 下【照樣被打穿】
③ 子網域不算跨站（evil.shop.com 對 shop.com 是 same-site）
     → 有子網域被接管或開放給第三方時，SameSite 一點忙都幫不上
④ 它是【瀏覽器】的行為 —— 不是瀏覽器的客戶端（curl、腳本、被改造的 App）完全不受約束
```

📌 **本課的立場**：

```
✅ SameSite 要設（Lax 是很好的預設，敏感系統用 Strict）
🔴 但它是【第二道】防線 —— 第一道永遠是 CSRF token
```

**Spring Boot 的設法**（不是 Spring Security 的設定，是 Servlet 容器的）：

```java
@Bean
CookieSameSiteSupplier sameSite() {
    return CookieSameSiteSupplier.ofStrict();      // 或 .ofLax()
}
```

```properties
# 或者只針對 session cookie：
server.servlet.session.cookie.same-site=lax
server.servlet.session.cookie.secure=true
server.servlet.session.cookie.http-only=true
```

### 4.5.4 實測：前後端分離要怎麼給 token

**問題**：CSRF token 預設存在 session 裡，而且只會被塞進 Spring 產生的 HTML 表單。
**前端是獨立的 React / Vue，它要怎麼拿到那個 token？**

**兩種做法**：

```
① 開一支 GET /csrf 端點，前端開機時打一次      ← 4.1.1 的 /s/csrf
② 用 CookieCsrfTokenRepository：伺服器把 token 寫進一個【JS 讀得到】的 cookie
   前端從 cookie 讀出來、放進 X-XSRF-TOKEN 標頭   ← Angular / axios 的預設慣例
```

**②的設定**（就是 4.4.2 那個 `Cs3_CookieRepository`）：

```java
.csrf(c -> c
    .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
    // ★ 6.x 預設會對 token 做 XOR 遮罩；前端要原樣回傳就要換成這個
    .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()))
```

```
═══ 4.5.4 前後端分離：CookieCsrfTokenRepository ═══
   ① 前端開機時打 GET /s/csrf → 200  {"csrfEnabled":true,"headerName":"X-XSRF-TOKEN","parameterName":"_csrf","token":"76a09eb6-855a-4885-b021-82bbab685647"}
      回應順便種下的 cookie：XSRF-TOKEN=76a09eb6-855a-4885-b021-82bbab685647; Path=/
      （HttpOnly 沒有出現 —— 這是刻意的，前端 JS 要讀得到）
   ② 前端把 cookie 值放進 X-XSRF-TOKEN 標頭           → 200  {"from":"alice","to":"friend","amount":"1","轉帳次數":2}
   ③ 🔴 攻擊者：cookie 會自己去，但【標頭放不進去】             → 403  {"status":403,"error":"Forbidden","pat…
   ④ 伺服器的帳本                                   → 200  {"轉帳次數":2,"明細":["alice-token → attacker 100000","alice → friend 1"]}
```

**這份輸出裡有三個重點**：

**① 那個 cookie 【故意】沒有 `HttpOnly`。**

```
XSRF-TOKEN=76a09eb6-855a-4885-b021-82bbab685647; Path=/
                                                  ↑ 沒有 HttpOnly
```

**必須這樣**——前端 JS 要讀得到才能放進標頭。
⚠️ **這不是漏洞**：CSRF token **不是祕密憑證**，它只是「證明這個請求是從你的頁面發出來的」。
攻擊者讀不到它的原因是**同源政策**，不是 `HttpOnly`。

**② 攻擊者的請求帶得到 cookie，但放不進標頭 → 403。**

```
cookie 自動去了 ✅   標頭放不進去 ❌   →  伺服器比對「cookie 的值」與「標頭的值」→ 不符 → 403
```

📌 **這個模式有一個名字：Double Submit Cookie。**
它的安全性建立在「**攻擊者能讓 cookie 被送出，但讀不到它的值**」。

**③ 🔴 它有一個前提：沒有子網域可以寫你的 cookie。**

```
evil.shop.com 可以替 .shop.com 種 XSRF-TOKEN
→ 攻擊者就能讓「cookie 的值」與「他自己送的標頭」一致 → 繞過
```

✅ **所以 `CookieCsrfTokenRepository` 的正確用法是搭配 `__Host-` 前綴**：

```java
CookieCsrfTokenRepository repo = CookieCsrfTokenRepository.withHttpOnlyFalse();
repo.setCookieName("__Host-XSRF-TOKEN");     // __Host- 要求 Secure + Path=/ + 沒有 Domain
```

**`__Host-` 前綴讓瀏覽器強制**：必須 `Secure`、`Path=/`、**不能設 `Domain`**
——於是子網域寫不了它。⚠️ 需要 HTTPS，本機開發要另外處理。

### 4.5.5 六條檢查清單

```
□ 我的身分是【瀏覽器自動送】還是【JS 主動放】？（4.5.1 的那張表）
□ 如果有任何一條 chain 用 session / cookie 認證 → 那條 chain 的 CSRF 必須是開的
□ csrf().disable() 那一行旁邊，有沒有一句註解說明【為什麼】可以關？
□ 有沒有「用 GET 改資料」的端點？（4.4.4）
□ session cookie 有沒有 SameSite + Secure + HttpOnly？（4.5.3）
□ 前後端分離的話，token 是怎麼給前端的？從 cookie 讀的話有沒有 __Host- 前綴？（4.5.4）
```

📌 **最後一條可以自動化**：4.1.2 那份報表的第一個警告
（`身分存在 session` + `CSRF 關閉`）就是第 2 條的機械化版本，
把它接進啟動流程，這個組合就再也不會悄悄溜進正式環境。

---

## 4.6 remember-me 與提升信任等級

### 4.6.1 實測：remember-me cookie 裡面是什麼

**「記住我」讓使用者關掉瀏覽器隔天回來還是登入狀態。它靠的是一個【獨立於 session】的 cookie**：

```java
package com.example.lab09.ch04;

import org.springframework.context.annotation.*;
import org.springframework.security.authentication.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.web.bind.annotation.*;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.*;

/** 4.6：remember-me 是【弱身分】，以及怎麼把它提升成強身分。 */
public class RememberMeScenarios {

    /** rm1：開 remember-me，並且把一支「敏感端點」標成 fullyAuthenticated */
    @Configuration
    @Profile("rm1 | rm2")
    static class Rm1_RememberMe {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                .authorizeHttpRequests(a -> a
                    .requestMatchers("/error", "/api/hello", "/s/csrf").permitAll()
                    .requestMatchers("/s/whoami").authenticated()            // 一般端點：remember-me 就夠
                    // 🔴 提升端點【自己】不能要求 fullyAuthenticated —— 那就永遠提升不了
                    .requestMatchers("/s/reauth").authenticated()
                    .requestMatchers("/s/password").fullyAuthenticated()     // ★ 敏感端點
                    .anyRequest().authenticated())
                .formLogin(Customizer.withDefaults())
                .rememberMe(r -> r.key("lab09").alwaysRemember(true))
                .csrf(c -> c.disable())
                .build();
        }
    }

    /** 4.6.1 / 4.6.2 的觀察窗：目前這個身分是「哪一種」 */
    @RestController
    @Profile("rm1 | rm2")
    static class WhoAmI {
        @GetMapping("/s/whoami")
        public Map<String, Object> whoami(Authentication auth) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("name", auth == null ? "(null)" : auth.getName());
            out.put("token 型別", auth == null ? "-" : auth.getClass().getSimpleName());
            out.put("是完整登入嗎", auth instanceof UsernamePasswordAuthenticationToken);
            out.put("是 remember-me 嗎", auth instanceof RememberMeAuthenticationToken);
            return out;
        }

        /** 一支「敏感」端點 —— 規則是 fullyAuthenticated */
        @PostMapping("/s/password")
        public Map<String, Object> changePassword(@RequestParam String newPw) {
            Map<String, Object> out = new LinkedHashMap<>();      // ⚠️ Map.of() 不保證欄位順序
            out.put("改密碼成功", true);
            out.put("長度", newPw.length());
            return out;
        }
    }

    /**
     * rm2：提升信任等級（step-up）。
     * 使用者手上只有 remember-me 身分時，讓他【重新輸入一次密碼】就換成完整身分，
     * 不必整個登出再登入 —— 這就是 01 章 1.8.2 那個「401 導向登入頁」的正確收尾。
     */
    @RestController
    @Profile("rm2")
    static class StepUp {

        private final AuthenticationManager am;
        private final SecurityContextRepository repo = new HttpSessionSecurityContextRepository();
        StepUp(AuthenticationManager am) { this.am = am; }

        @PostMapping("/s/reauth")
        public Map<String, Object> reauth(@RequestParam String password,
                                          HttpServletRequest req, HttpServletResponse res) {
            Authentication current = SecurityContextHolder.getContext().getAuthentication();
            Map<String, Object> out = new LinkedHashMap<>();
            try {
                // ★ 用【目前這個身分的帳號】＋ 剛輸入的密碼，走一次完整認證
                Authentication full = am.authenticate(
                        UsernamePasswordAuthenticationToken.unauthenticated(current.getName(), password));
                var ctx = SecurityContextHolder.createEmptyContext();
                ctx.setAuthentication(full);
                SecurityContextHolder.setContext(ctx);
                repo.saveContext(ctx, req, res);            // ★ 存回 session，下一個請求才算數
                out.put("提升成功", true);
                out.put("現在的 token 型別", full.getClass().getSimpleName());
            } catch (AuthenticationException e) {
                out.put("提升成功", false);
                out.put("原因", e.getClass().getSimpleName());
            }
            return out;
        }
    }

    /** rm2 需要一個 AuthenticationManager bean（02 章 2.6 的結論：它預設不是 bean） */
    @Configuration
    @Profile("rm2")
    static class AmConfig {
        @Bean AuthenticationManager authenticationManager(
                UserDetailsService uds,
                org.springframework.security.crypto.password.PasswordEncoder enc) {
            DaoAuthenticationProvider p = new DaoAuthenticationProvider();
            p.setUserDetailsService(uds);
            p.setPasswordEncoder(enc);
            return new ProviderManager(p);
        }
    }
}
```

```java
package com.example.lab09.ch04;

import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.Base64;

@SpringBootTest
@ActiveProfiles({"db", "ch4"})
@TestMethodOrder(MethodOrderer.MethodName.class)
class RememberMeTest {

    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed3.reset(jdbc); }

    interface Body { void run(int port); }

    void withPort(String profile, Body b) {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                .web(WebApplicationType.SERVLET).profiles("db", "ch4", profile)
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF").run()) {
            b.run(((WebServerApplicationContext) ctx).getWebServer().getPort());
        }
    }

    static void line(String label, HttpResponse<String> r) {
        System.out.printf("   %-40s → %s%n", label, Web.brief(r, 84));
    }

    @Test
    void a_cookieStructure() {
        System.out.println("\n═══ 4.6.1 remember-me cookie 裡面是什麼 ═══");
        withPort("rm1", port -> {
            Web w = new Web(port);
            HttpResponse<String> login = w.formLogin("alice", "pw", true);
            String raw = Web.setCookieOf(login, "remember-me");
            System.out.println("   Set-Cookie: " + raw);
            String value = raw.split("=", 2)[1].split(";")[0];
            String decoded = new String(Base64.getDecoder().decode(
                    value + "=".repeat((4 - value.length() % 4) % 4)));
            System.out.println("   base64 解開 → " + decoded);
            String[] parts = decoded.split(":");
            System.out.println("   共 " + parts.length + " 段：");
            System.out.println("   ① 帳號      = " + parts[0]);
            System.out.println("   ② 到期時間  = " + new java.util.Date(Long.parseLong(parts[1])));
            System.out.println("   ③ 演算法    = " + parts[2]);
            System.out.println("   ④ 簽章      = " + parts[3].substring(0, 24) + "…（" + parts[3].length() + " 字元）");
        });
    }

    @Test
    void b_weakIdentity() {
        System.out.println("\n═══ 4.6.2 remember-me 是【弱身分】 ═══");
        withPort("rm1", port -> {
            Web full = new Web(port);
            full.formLogin("alice", "pw", true);
            String rememberMe = full.cookie("remember-me");

            System.out.println("\n   ① 完整登入（手上有 JSESSIONID）：");
            line("GET /s/whoami", full.get("/s/whoami"));
            line("POST /s/password（fullyAuthenticated）", full.post("/s/password?newPw=abcd1234", null));

            System.out.println("\n   ② 只帶 remember-me（關掉瀏覽器隔天再打開）：");
            Web weak = new Web(port);
            weak.setCookie("remember-me", rememberMe);
            line("GET /s/whoami", weak.get("/s/whoami"));
            line("🔴 POST /s/password（fullyAuthenticated）", weak.post("/s/password?newPw=abcd1234", null));
        });
    }

    @Test
    void c_stepUp() {
        System.out.println("\n═══ 4.6.3 提升信任等級：重新輸入密碼，不用整個重登 ═══");
        withPort("rm2", port -> {
            Web full = new Web(port);
            full.formLogin("alice", "pw", true);
            String rememberMe = full.cookie("remember-me");

            Web weak = new Web(port);
            weak.setCookie("remember-me", rememberMe);
            line("① 目前身分", weak.get("/s/whoami"));
            line("② 改密碼（還沒提升）", weak.post("/s/password?newPw=abcd1234", null));
            line("③ 🔴 密碼打錯的提升", weak.post("/s/reauth?password=wrong", null));
            line("④ ✅ 密碼正確的提升", weak.post("/s/reauth?password=pw", null));
            line("⑤ 提升後的身分", weak.get("/s/whoami"));
            line("⑥ 再改一次密碼", weak.post("/s/password?newPw=abcd1234", null));
        });
    }
}
```

```
═══ 4.6.1 remember-me cookie 裡面是什麼 ═══
   Set-Cookie: remember-me=YWxpY2U6MTc5MDU3MTAxMzgwMTpTSEEyNTY6MTlhYjM0NjQ0MGZhOWRmYWZiOGRmMjk5YzkyMWUwMjlmNTMxYjMwMmJmOTQ5OWJhODg0MWU0MjExYjBjMzZjOQ; Max-Age=1209600; Expires=Mon, 28 Sep 2026 04:50:13 GMT; Path=/; HttpOnly
   base64 解開 → alice:1790571013801:SHA256:19ab346440fa9dfafb8df299c921e029f531b302bf9499ba8841e4211b0c36c9
   共 4 段：
   ① 帳號      = alice
   ② 到期時間  = Mon Sep 28 12:50:13 CST 2026
   ③ 演算法    = SHA256
   ④ 簽章      = 19ab346440fa9dfafb8df299…（64 字元）
```

**四個欄位**：

```
alice : 1790571013801 : SHA256 : 19ab346440fa9dfa…
  ①        ②             ③           ④
```

| | 欄位 | 說明 |
|---|---|---|
| ① | 帳號 | 明碼 |
| ② | 到期時間（epoch 毫秒） | 預設 14 天（`Max-Age=1209600`） |
| ③ | 演算法 | **6.x 起是 SHA256**；5.x 是 MD5 |
| ④ | 簽章 | `SHA256(username + ":" + expiry + ":" + 密碼雜湊 + ":" + key)` |

⚠️ **第 ④ 個欄位有三個重要的後果**：

```
① 密碼雜湊是簽章的一部分 → ✅ 改密碼會讓【所有】remember-me cookie 立刻失效
② key 是伺服器的祕密 → 沒有它就偽造不出簽章；🔴 但 key 外洩 = 任何人都能偽造任何帳號的身分
③ 🔴 它【無法個別撤銷】—— 伺服器沒有記錄發過哪些 cookie，只能驗算
```

📌 **`key` 一定要自己設，而且要當成密碼等級的祕密**：

```java
.rememberMe(r -> r.key("${app.remember-me.key}"))     // 🔴 不設的話 Spring 每次啟動隨機產生
```

⚠️ **不設 `key` 的後果很隱晦**：**每次重啟，所有人的 remember-me 都失效**。
開發時看不出來（本來就常重啟），上線後變成「每次部署使用者都要重登」。

**兩種實作的對照**：

| | `TokenBasedRememberMeServices`★預設 | `PersistentTokenBasedRememberMeServices` |
|---|---|---|
| 伺服器要存東西嗎 | ❌ 不用（純簽章驗算） | ✅ 要一張表（`persistent_logins`） |
| 能個別撤銷嗎 | 🔴 **不能** | ✅ 刪那一列就好 |
| 偵測 cookie 被竊 | ❌ 不能 | ✅ 可以（每次使用就換一次 token，重複使用舊的 → 判定被竊，作廢全部） |
| 代價 | 0 | 每次 remember-me 登入 1 次讀 + 1 次寫 |

📌 **本課建議**：**有「登出所有裝置」需求的系統，用 `PersistentTokenBasedRememberMeServices`。**
它跟 4.3.3 那支 `/kick` 是互補的——一個管 session，一個管 remember-me cookie。

### 4.6.2 實測：remember-me 是【弱身分】

```
═══ 4.6.2 remember-me 是【弱身分】 ═══

   ① 完整登入（手上有 JSESSIONID）：
   GET /s/whoami                            → 200  {"name":"alice","token 型別":"UsernamePasswordAuthenticationToken","是完整登入嗎":true,"是 re…
   POST /s/password（fullyAuthenticated）     → 200  {"改密碼成功":true,"長度":8}

   ② 只帶 remember-me（關掉瀏覽器隔天再打開）：
   GET /s/whoami                            → 200  {"name":"alice","token 型別":"RememberMeAuthenticationToken","是完整登入嗎":false,"是 remembe…
   🔴 POST /s/password（fullyAuthenticated）  → 302
```

**兩種身分的差別**：

| | 完整登入 | remember-me |
|---|---|---|
| `Authentication` 的型別 | `UsernamePasswordAuthenticationToken` | `RememberMeAuthenticationToken` |
| `authenticated()` | ✅ 通過 | ✅ 通過 |
| `fullyAuthenticated()` | ✅ 通過 | 🔴 **不通過** |
| `isAuthenticated()` | true | true |

⚠️ **`fullyAuthenticated()` 被擋時回的是 302（導向登入頁），不是 403。**

**這就是 01 章 1.8.2 那一段的實際效果**：

```
AccessDeniedException 冒出來
  → ExceptionTranslationFilter 問 AuthenticationTrustResolver
    → isRememberMe() == true
      → 「你可能是本人，但這次的操作比較重要」→ AuthenticationEntryPoint → 導向登入
```

📌 **這個設計是對的**：使用者看到的是「請重新登入」，不是「你沒有權限」。
**03 章 3.3.6 那個「remember-me 打 fullyAuthenticated 端點拿到 401」就是這一段的 API 版本。**

✅ **哪些端點該用 `fullyAuthenticated()`？** 一條判準：

> **「如果這個操作被冒用，使用者要花多久才能救回來？」**
> 救不回來或很麻煩的，就要 `fullyAuthenticated()`。

```
改密碼、改綁定信箱 / 手機、關閉兩步驟驗證     ← 被改掉就拿不回帳號了
新增 API key、新增信任裝置、轉帳、下大額訂單
刪除帳號、匯出全部個資
```

### 4.6.3 實測：提升信任等級（step-up）

**問題**：使用者手上只有 remember-me 身分，他想改密碼。
**把他整個登出再重登**是最簡單的做法，但體驗很差（表單填到一半的內容全沒了）。

✅ **正確的做法：讓他【就地】重新輸入一次密碼，把身分換成完整的。**

```
═══ 4.6.3 提升信任等級：重新輸入密碼，不用整個重登 ═══
   ① 目前身分                                   → 200  {"name":"alice","token 型別":"RememberMeAuthenticationToken","是完整登入嗎":false,"是 remembe…
   ② 改密碼（還沒提升）                              → 302
   ③ 🔴 密碼打錯的提升                             → 200  {"提升成功":false,"原因":"BadCredentialsException"}
   ④ ✅ 密碼正確的提升                              → 200  {"提升成功":true,"現在的 token 型別":"UsernamePasswordAuthenticationToken"}
   ⑤ 提升後的身分                                 → 200  {"name":"alice","token 型別":"UsernamePasswordAuthenticationToken","是完整登入嗎":true,"是 re…
   ⑥ 再改一次密碼                                 → 200  {"改密碼成功":true,"長度":8}
```

**實作的核心只有五行**（完整版在上面的 `RememberMeScenarios.StepUp`）：

```java
Authentication full = am.authenticate(
        UsernamePasswordAuthenticationToken.unauthenticated(current.getName(), password));
var ctx = SecurityContextHolder.createEmptyContext();
ctx.setAuthentication(full);
SecurityContextHolder.setContext(ctx);
repo.saveContext(ctx, req, res);            // ★ 存回 session，下一個請求才算數
```

🔴 **這個流程最容易寫錯的兩行**：

**① 忘了 `repo.saveContext(...)`。**

`SecurityContextHolder` 是 `ThreadLocal`（01 章 1.9）——**請求結束就清掉了**。
不存回 `SecurityContextRepository`，下一個請求又變回 remember-me 身分。
📌 **症狀**：「提升的那一次成功，但下一個請求又被擋」——**而且完全沒有錯誤訊息**。

**② 🔴 把提升端點自己標成 `fullyAuthenticated()`。**

```java
.requestMatchers("/s/password", "/s/reauth").fullyAuthenticated()     // 🔴 雞生蛋
```

**提升端點必須是 `authenticated()`**——不然使用者永遠到不了它：

```java
.requestMatchers("/s/reauth").authenticated()        // ✅
.requestMatchers("/s/password").fullyAuthenticated()
```

⚠️ **本課在寫這一節時就踩了這個坑**：測試裡的 `③ 密碼打錯的提升`、`④ 密碼正確的提升`
一開始全部回 302——**看起來像「密碼驗證失敗」，實際上是請求根本沒進到 Controller**。
📌 **診斷方法**：**403/302 分不清楚時，先看請求有沒有進到你的方法**（印一行就知道）。

**三個實務補充**：

```
① 提升後要有【有效期限】—— 業界常見是 5～15 分鐘，之後回到弱身分
   做法：在 session 裡存提升的時間戳，用一個 Filter 或 @PreAuthorize 的 SpEL 檢查
② 提升【不應該】只接受密碼 —— 有兩步驟驗證的系統應該要求第二因子
③ 提升失敗要計數（07 章 7.5）—— 它跟登入一樣是猜密碼的入口
```

---

## 4.7 有狀態 vs 無狀態

### 4.7.1 實測：session 裡的權限是【登入當下的快照】

**03 章 3.7.7 留下的問題，在這裡有完整的形狀**：

```java
package com.example.lab09.ch04;

import com.example.lab09.Http;
import com.example.lab09.ch03.Seed3;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

/** 4.7：有狀態與無狀態的兩個實際差別 —— 身分新鮮度，與每個請求的成本。 */
@SpringBootTest
@ActiveProfiles({"db", "ch4"})
@TestMethodOrder(MethodOrderer.MethodName.class)
class StatefulVsStatelessTest {

    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed3.reset(jdbc); }

    interface Body { void run(int port); }

    void withPort(String profile, Body b) {
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                .web(WebApplicationType.SERVLET).profiles("db", "ch4", profile)
                .properties("server.port=0", "spring.main.banner-mode=off", "logging.level.root=OFF").run()) {
            b.run(((WebServerApplicationContext) ctx).getWebServer().getPort());
        }
    }

    @Test
    void a_authoritiesAreASnapshot() {
        System.out.println("\n═══ 4.7.1 session 裡的權限是【登入當下的快照】 ═══");
        withPort("se1", port -> {
            Web w = new Web(port);
            w.formLogin("admin", "pw", true);
            System.out.println("   ① 登入後   " + w.get("/api/me/authorities").body());

            jdbc.update("DELETE FROM authority WHERE authority='order:refund' AND user_id="
                    + "(SELECT id FROM app_user WHERE username='admin')");
            System.out.println("   ② 從資料庫把 order:refund 刪掉（DELETE 影響 1 列）");

            System.out.println("   ③ 同一個 session  " + w.get("/api/me/authorities").body());

            Web fresh = new Web(port);
            fresh.formLogin("admin", "pw", true);
            System.out.println("   ④ 重新登入一次    " + fresh.get("/api/me/authorities").body());
        });
    }

    @Test
    void b_costPerRequest() {
        System.out.println("\n═══ 4.7.2 每一個請求的成本：session vs Basic ═══");
        int N = 300;

        withPort("se1", port -> {
            Web w = new Web(port);
            w.formLogin("alice", "pw", true);
            long t0 = System.nanoTime();
            for (int i = 0; i < N; i++) w.get("/s/notouch");
            long ms = (System.nanoTime() - t0) / 1_000_000;
            System.out.printf("   session（帶 JSESSIONID）  %d 個請求 → %d ms，%.0f 個/秒%n",
                    N, ms, N * 1000.0 / ms);
        });

        withPort("se2", port -> {
            Http http = new Http(port);
            String auth = Http.basic("alice", "pw");
            long t0 = System.nanoTime();
            for (int i = 0; i < N; i++) http.get("/s/notouch", "Authorization", auth);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            System.out.printf("   Basic（每次都驗一次密碼）   %d 個請求 → %d ms，%.0f 個/秒%n",
                    N, ms, N * 1000.0 / ms);
        });

        System.out.println("""
                
                   兩者的差別【不是】網路，是 BCrypt：
                   Basic 的每一個請求都要跑一次 loadUserByUsername + 一次 BCrypt 比對（02 章 2.3.5、2.7.4），
                   session 版只在登入那一次跑。""");
    }
}
```

```
═══ 4.7.1 session 裡的權限是【登入當下的快照】 ═══
   ① 登入後   {"name":"admin","authorities":["ROLE_ADMIN","ROLE_USER","order:refund"]}
   ② 從資料庫把 order:refund 刪掉（DELETE 影響 1 列）
   ③ 同一個 session  {"name":"admin","authorities":["ROLE_ADMIN","ROLE_USER","order:refund"]}
   ④ 重新登入一次    {"name":"admin","authorities":["ROLE_ADMIN","ROLE_USER"]}
```

🔴 **資料庫已經改了，但同一個 session 看到的還是舊的。**

**為什麼？** 因為 4.2.2 量到的那 1332 個位元組——

```
登入時   loadUserByUsername() → 把 authorities 抄進 SecurityContextImpl → 存進 session
之後     每個請求直接從 session 反序列化那份【抄本】，不再查資料庫
```

📌 **這不是 bug，是【設計】。** 它就是有狀態架構省下每個請求 2 句 SQL 的代價。

**一句話的通則**：

> **快取身分省下的每一句 SQL，都換成一段「資料過期」的時間。**

**三個處理方向，對應三種容忍度**：

| 做法 | 生效延遲 | 成本 | 適合 |
|---|---|---|---|
| **① 什麼都不做** | 到下次登入 / session 逾時（最長 30 分鐘） | 0 | 權限很少變的系統 |
| **② 改權限時踢掉 session**（4.3.3） | 下一個請求 | 要一支管理 API；那個人要重新登入 | ★ 大多數系統 |
| **③ 每個請求重查權限** | 立即 | 每個請求 +1～2 句 SQL（03 章 3.7.4 量過） | 權限變動頻繁、或法遵要求「立即撤銷」 |

**③ 的做法**（不是把 `UserDetails` 重查，而是只重查 authorities）：

```java
// 一個把 authorities 改成「每次重查」的 Filter —— 代價看得見，別無聲無息地加上去
http.addFilterAfter(new RefreshAuthoritiesFilter(authorityRepo), SecurityContextHolderFilter.class);
```

⚠️ **選 ③ 之前先量**：03 章 3.7.4 量到「每個請求 2 句 SQL」；
在一個每秒 1000 個請求的服務上，那是 **每秒 2000 句查詢**只為了處理一件很少發生的事。
📌 **② 幾乎永遠是對的答案**，而它需要的就是 4.3.3 那支 `/kick`。

### 4.7.2 實測：每個請求的成本

```
═══ 4.7.2 每一個請求的成本：session vs Basic ═══
   session（帶 JSESSIONID）  300 個請求 → 128 ms，2344 個/秒
   Basic（每次都驗一次密碼）   300 個請求 → 23233 ms，13 個/秒

兩者的差別【不是】網路，是 BCrypt：
Basic 的每一個請求都要跑一次 loadUserByUsername + 一次 BCrypt 比對（02 章 2.3.5、2.7.4），
session 版只在登入那一次跑。
```

**差了兩個數量級。** 而差別完全不在網路：

```
session 版   登入時跑一次 BCrypt，之後每個請求只是「從 session 反序列化」
Basic 版     🔴 每一個請求都跑一次 loadUserByUsername + 一次 BCrypt 比對
```

📌 **這個數字跟 02 章 2.3.5 是同一件事的兩面**：
那裡量到 Basic 在 8 核上的吞吐量上限是 73 個/秒（本章是單執行緒，所以是 13 個/秒）。
**BCrypt 是【故意】慢的（00 章 0.7），而無狀態認證把它放進了每一個請求。**

⚠️ **session 那一欄的絕對值在你的機器上會不一樣**（重跑幾次，本課量到 1250～2600 個/秒都有——
JIT 暖機、GC、連線池狀態都會影響）。
**Basic 那一欄不會**：它被 BCrypt 的 `cost` 綁死，而 `cost` 是你自己設的（00 章 0.7.4）。
📌 **要看的是「Basic 版被釘在 13 個/秒」這件事，不是比值。**

⚠️ **所以「無狀態比較快」是個誤解**——精確的說法是：

```
無狀態【比較好擴展】（不用共享 session），但【每個請求的成本比較高】
  → 除非那個憑證的驗證是便宜的
  → 而那正是 JWT 的賣點：驗一次簽章 ≈ 幾十微秒，不用查資料庫、不用跑 BCrypt（05 章）
```

📌 **這一格是 05 章存在的理由**：

```
Basic + STATELESS   無狀態 ✅   每個請求成本 🔴 高（BCrypt）
Session             無狀態 ❌   每個請求成本 ✅ 低
JWT                 無狀態 ✅   每個請求成本 ✅ 低      ← 05 章
                    代價：撤銷變難（4.3.3 那支 /kick 在 JWT 上做不到）
```

### 4.7.3 一張決策表

| 問題 | Session | 無狀態 Token |
|---|---|---|
| 水平擴展 | 要外部 store（4.3.4） | ✅ 不用 |
| 立刻撤銷一個人 | ✅ `expireNow()`（4.3.3） | 🔴 要黑名單（等於又有狀態了，05 章） |
| 權限變更何時生效 | 下次登入 / 踢掉 session | token 過期為止 |
| 每個請求的成本 | ✅ 低 | 看憑證：BCrypt 🔴 / JWT 簽章 ✅ |
| CSRF | 🔴 必須處理 | ✅ 不用（前提：token 不在 cookie 裡） |
| 手機 App / 第三方 API | ❌ 彆扭 | ✅ 自然 |
| 伺服器記憶體 | 🔴 每個人 1～3 KB | ✅ 0 |
| 出事時的鑑識 | ✅ 伺服器有紀錄 | 🔴 只有你自己記的日誌 |

📌 **本課的建議，不是二選一**：

```
✅ 同一個服務可以有兩條 chain（01 章 1.7）：
     /api/**  → 無狀態（給 App 與前端）
     其餘     → session（給後台網頁）
   —— 03 章 3.10 的 shop-service 已經是這個形狀了

⚠️ 但兩條 chain 就是兩套撤銷邏輯、兩套 CSRF 判斷。
   4.1.2 那份報表會【逐條】印出來，就是為了這件事。
```

---

## 4.8 shop-service 落地

**03 章 3.10 留下的五個「還沒有的東西」，這一章補掉兩個**：

```
🔴 停用帳號不會立刻踢掉現有 session（02 章 2.7.7）        → ✅ 這一章（4.3.3）
🔴 權限收回來要等下一次登入（03 章 3.7.7）                 → ✅ 這一章（4.3.3 + 4.7.1）
🔴 CSRF 直接 disable 了 —— 那是對的，但要說得出理由        → ✅ 這一章（4.5.1）
🔴 API 用 HTTP Basic —— 每個請求跑一次 BCrypt（4.7.2）    → 05 章換 JWT
🔴 沒有任何稽核紀錄                                       → 08 章
```

**① `ShopAuthzConfig` 加上 session 管理與 CSRF 的理由**

⚠️ **這個類別取代 03 章 3.10 的同名類別**（同名 bean，兩個一起留著會
`BeanDefinitionOverrideException`）。**兩條 chain 的差別，現在是有理由的**：

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.session.SessionRegistryImpl;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.session.HttpSessionEventPublisher;

@Configuration
@EnableMethodSecurity                     // 03 章 3.5.2
public class ShopAuthzConfig {

    /** 4.3.2：並行 session 控制與 4.3.3 的「踢人」都靠它 */
    @Bean SessionRegistry sessionRegistry() { return new SessionRegistryImpl(); }

    /** ⚠️ 少了它，登出與逾時不會從 registry 移除 —— 幾天後那個人就登不進來了（4.3.2） */
    @Bean HttpSessionEventPublisher httpSessionEventPublisher() { return new HttpSessionEventPublisher(); }

    /**
     * REST API：無狀態。
     * ✅ CSRF 可以關，理由是【身分靠 Authorization 標頭攜帶，瀏覽器不會自動送】（4.5.1）。
     *    ⚠️ 這個理由在 05 章把 Basic 換成 JWT 之後仍然成立 ——
     *       前提是 JWT【不放進 cookie】（4.5.2 示範過放進 cookie 的後果）。
     */
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http, AuthenticationManager am) throws Exception {
        return http
            .securityMatcher("/api/**", "/error")
            .authenticationManager(am)
            .authorizeHttpRequests(a -> a
                .requestMatchers("/error").permitAll()                   // 03 章 3.3.5
                .requestMatchers("/api/auth/login", "/api/auth/register").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                .requestMatchers(HttpMethod.POST,   "/api/orders/*/refund").hasAuthority("order:refund")
                .requestMatchers(HttpMethod.DELETE, "/api/orders/**").hasAuthority("order:delete")
                .requestMatchers("/api/reports/**").hasAuthority("report:read")
                .requestMatchers("/api/admin/**").hasAuthority("user:manage")
                .anyRequest().authenticated())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())                                      // ★ 理由見上面的 javadoc
            .httpBasic(Customizer.withDefaults())                        // ⚠️ 暫時的，05 章換 JWT
            .exceptionHandling(e -> e
                .authenticationEntryPoint(ApiErrors::write401)           // 01 章 1.8.5
                .accessDeniedHandler(ApiErrors::write403))
            .build();
    }

    /**
     * 後台網頁：有 session、表單登入。
     * 🔴 這一條的 CSRF【絕對不能關】—— 身分靠 JSESSIONID，是瀏覽器自動送的（4.4.2）。
     */
    @Bean
    @Order(2)                                                            // 01 章 1.7.4：一定要最後
    SecurityFilterChain webChain(HttpSecurity http, AuthenticationManager am,
                                 SessionRegistry registry) throws Exception {
        return http
            .authenticationManager(am)
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/actuator/**").hasAuthority("user:manage")
                .anyRequest().authenticated())
            .formLogin(Customizer.withDefaults())
            // ★ 這裡【沒有】csrf(...) —— 預設就是開的，這是刻意的（4.5.1）
            .sessionManagement(s -> s
                .sessionFixation(f -> f.changeSessionId())               // 4.3.1：預設值，寫出來讓它可被 review
                .maximumSessions(5)                                      // 4.3.2：不是 1，理由見 4.3.2 那張表
                .sessionRegistry(registry)
                .expiredSessionStrategy(event -> {                       // 4.3.3：預設會回 200 純文字
                    event.getResponse().setStatus(401);
                    event.getResponse().setContentType("application/json;charset=UTF-8");
                    event.getResponse().getWriter().write(
                            "{\"error\":\"SESSION_EXPIRED\",\"message\":\"你的登入已失效，請重新登入\"}");
                }))
            .logout(l -> l.logoutSuccessUrl("/login?logout").invalidateHttpSession(true))
            .build();
    }
}
```

**② `ShopUserDetails` 要明確寫出 `equals` / `hashCode`**

⚠️ **03 章 3.10 把它寫成 `record`，而 record 的 `equals` 會比對【所有】欄位。**
**目前它「剛好」能用**（同一個人每次載入的欄位值都一樣），
**但那是巧合**——只要有人加一個 `lastLoginAt`，或 authorities 的順序變了，
4.3.2 那個「一個人變成好幾個人」的 bug 就會無聲無息地回來。

```java
package com.example.lab09.shop;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;

/**
 * 取代 03 章 3.10 的同名類別：查詢一個字都沒改，
 * 差別只有 ShopUserDetails 多了明確的 equals / hashCode（4.3.2）。
 */
@Service
public class ShopUserDetailsService implements UserDetailsService {

    private final JdbcTemplate jdbc;
    public ShopUserDetailsService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    @Transactional(readOnly = true)
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        Map<String, Object> u;
        try {
            u = jdbc.queryForMap("""
                    SELECT id, username, password_hash, display_name, enabled,
                           account_non_expired, account_non_locked, credentials_expire_at
                      FROM app_user WHERE username = ?""", username);
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            throw new UsernameNotFoundException(username);          // ★ 02 章 2.5.5 規則一
        }

        Set<String> authorities = new LinkedHashSet<>();
        jdbc.query("""
                SELECT r.code AS role_code, p.code AS perm_code
                  FROM user_role ur
                  JOIN app_role r              ON r.id = ur.role_id
                  LEFT JOIN role_permission rp ON rp.role_id = r.id
                  LEFT JOIN permission p       ON p.id = rp.permission_id
                 WHERE ur.user_id = ?""",
                rs -> {
                    authorities.add("ROLE_" + rs.getString("role_code"));   // ★ 前綴只加這一次
                    String p = rs.getString("perm_code");
                    if (p != null) authorities.add(p);
                }, u.get("id"));

        java.sql.Timestamp exp = (java.sql.Timestamp) u.get("credentials_expire_at");
        return new ShopUserDetails(
                (Long) u.get("id"),
                (String) u.get("username"),
                (String) u.get("password_hash"),
                (String) u.get("display_name"),
                (Boolean) u.get("enabled"),
                (Boolean) u.get("account_non_expired"),
                (Boolean) u.get("account_non_locked"),
                exp == null || exp.toLocalDateTime().isAfter(LocalDateTime.now()),
                authorities.stream().map(a -> (GrantedAuthority) new SimpleGrantedAuthority(a)).toList());
    }

    /** 03 章 3.10 的 record，補上明確的 equals / hashCode（4.3.2） */
    public record ShopUserDetails(Long userId, String username, String password, String displayName,
                                  boolean enabled, boolean accountNonExpired, boolean accountNonLocked,
                                  boolean credentialsNonExpired,
                                  List<GrantedAuthority> grantedAuthorities) implements UserDetails {

        @Override public Collection<? extends GrantedAuthority> getAuthorities() { return grantedAuthorities; }
        @Override public String getPassword() { return password; }
        @Override public String getUsername() { return username; }
        @Override public boolean isAccountNonExpired() { return accountNonExpired; }
        @Override public boolean isAccountNonLocked() { return accountNonLocked; }
        @Override public boolean isCredentialsNonExpired() { return credentialsNonExpired; }
        @Override public boolean isEnabled() { return enabled; }

        /**
         * ★ 「同一個人」的定義是 userId，不是「這次載入的那份快照」。
         *   SessionRegistry 用 principal 當 Map 的 key —— 少了這兩個方法，
         *   maximumSessions 與 4.3.3 的 kick 都會靜默失效（4.3.2）。
         *
         *   ⚠️ record 【本來就有】自動產生的 equals —— 但它比對【所有】欄位，
         *      只要有人加一個 lastLoginAt，那個 bug 就會無聲無息地回來。
         */
        @Override public boolean equals(Object o) {
            return o instanceof ShopUserDetails other && Objects.equals(userId, other.userId);
        }
        @Override public int hashCode() { return Objects.hashCode(userId); }
    }
}
```

**③ 一支「讓某個人的登入立刻失效」的服務**

```java
package com.example.lab09.shop;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.session.SessionInformation;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 02 章 2.7.7 與 03 章 3.7.7 那兩個「改了資料庫卻沒生效」的問題，答案在這裡（4.3.3）。
 * ⚠️ 停用帳號 / 收回權限的每一條路徑，都要呼叫這裡的方法。
 */
@Service
public class ShopSessionAdmin {

    private final SessionRegistry registry;
    private final JdbcTemplate jdbc;
    public ShopSessionAdmin(SessionRegistry registry, JdbcTemplate jdbc) {
        this.registry = registry; this.jdbc = jdbc;
    }

    /** 把某個 userId 手上所有的 session 標記過期 —— 下一個請求就會被擋下來 */
    public int kick(Long userId) {
        int n = 0;
        for (Object p : registry.getAllPrincipals()) {
            if (!(p instanceof ShopUserDetailsService.ShopUserDetails u)) continue;
            if (!u.userId().equals(userId)) continue;
            for (SessionInformation si : registry.getAllSessions(p, false)) { si.expireNow(); n++; }
        }
        return n;
    }

    /** 停用帳號 = 改資料庫 + 踢掉現有 session（02 章 2.7.7 少的就是第二步） */
    @Transactional
    public void disable(Long userId) {
        jdbc.update("UPDATE app_user SET enabled = FALSE WHERE id = ?", userId);
        kick(userId);                                   // ★ 少了這一行，那個人手上的 session 照樣能用
    }
}
```

**④ cookie 的三個屬性**

```properties
server.servlet.session.cookie.http-only=true     # 預設就是 true，寫出來讓它可被 review
server.servlet.session.cookie.secure=true        # ⚠️ 只走 HTTPS；本機開發要關掉
server.servlet.session.cookie.same-site=lax      # 4.5.3：第二道防線
server.servlet.session.timeout=30m
```

**⑤ 四個啟動檢查 + 一個 CI 防線**

```
00 章 0.8.4  SecurityChainReporter   → 每條 chain 上有哪些 Filter
02 章 2.6.3  AuthWiringReporter      → UserDetailsService / PasswordEncoder 各有幾個 bean
03 章 3.2.4  AuthzRuleReporter       → AuthorizationFilter 手上有幾條規則、順序是什麼
04 章 4.1.2  SessionWiringReporter   → 身分存在哪裡、CSRF 開著沒  ← 這一章加的
03 章 3.9.4  AuthzCoverageReporter   → CI 裡跑，新端點沒規則就變紅
```

**本章結束時，shop-service 的樣子**：

```
API（/api/**）   無狀態；CSRF 關掉，而且【寫得出理由】；05 章要把 Basic 換成 JWT
後台（其餘）      session；CSRF 開著；changeSessionId + maximumSessions(5)
撤銷             ShopSessionAdmin.kick(userId) —— 停用帳號 / 收回權限都要呼叫它
principal        ShopUserDetails 明確覆寫 equals/hashCode（比 userId）
cookie           HttpOnly + Secure + SameSite=Lax
過期回應          401 + JSON，不是預設的 200 純文字
啟動檢查          四個 reporter，其中一個會對「session + 關 CSRF」發紅色警告
```

⚠️ **還沒有的東西**：

```
🔴 Basic 撐不住流量（4.7.2 量到 13 個/秒）                 → 05 章
🔴 remember-me 沒有開；開了就要處理「無法個別撤銷」（4.6.1） → 視需求
🔴 叢集還沒處理（4.3.4 只給了方向）                         → 視部署方式
🔴 沒有稽核（誰在什麼時候登入 / 被踢掉）                     → 08 章
🔴 登入失敗沒有計數、沒有鎖定                               → 07 章
```

---

## 4.9 常見誤區

**誤區 1：「我設了 `STATELESS`，所以這個服務不會有 session」**

→ 4.2.3 實測：`STATELESS` 只是叫 Spring Security 不要用 session 存身分，
**擋不住你的 Controller 呼叫 `request.getSession()`**。
4.2.4 量到 200 個請求長出 200 個永遠不會被回收的 session。

**誤區 2：「還沒登入的人不會佔用 session」**

→ 4.2.1 實測：**匿名打一支受保護的端點，session 就建立了**——
因為 `ExceptionTranslationFilter` 要把 `SavedRequest` 存起來（1194 位元組）。

**誤區 3：「`maximumSessions(1)` 就是同一個帳號只能登入一台」**

→ 4.3.2 實測：principal 沒有 `equals` / `hashCode` 時，
**`SessionRegistry` 會把同一個人當成好幾個人**，那條設定形同不存在——
**而且啟動不報錯、沒有警告、單看程式碼完全正確。**

**誤區 4：「`HttpOnly` 可以防 CSRF」**

→ 4.5.2 實測：`HttpOnly` 擋的是 **XSS 讀走 cookie**，
**完全不影響瀏覽器自動送出它**——CSRF 一點都沒有變難。

**誤區 5：「我們是 token 認證，所以 CSRF 關掉」**

→ 4.5.2 實測：**token 存在 cookie 裡的話，CSRF 重新成立**。
判準不是「有沒有用 token」，是**「伺服器認不認 cookie 裡的東西當身分」**（4.5.1）。

**誤區 6：「檢查 Referer 就好了」**

→ 4.4.3 實測：攻擊者**不送 Referer** 就過了，而「沒有 Referer 就擋掉」會擋掉真實使用者。
`Origin` / `Sec-Fetch-Site` 是好的**補強**，但不是主防線。

**誤區 7：「現在瀏覽器都有 SameSite=Lax 了，CSRF 已經解決了」**

→ 4.5.3：`Lax` 仍然允許**跨站的 GET 導航**帶 cookie，
所以 4.4.4 那種「用 GET 改資料」的端點照樣被打穿；
子網域不算跨站；而且它是**瀏覽器**的行為，非瀏覽器客戶端完全不受約束。

**誤區 8：「CSRF token 是祕密，所以要設 `HttpOnly`」**

→ 4.5.4：CSRF token **不是憑證**，它只證明「這個請求是從你的頁面發出來的」。
前後端分離時它**必須**讓 JS 讀得到。攻擊者讀不到它靠的是**同源政策**。

**誤區 9：「把權限收回來了就生效了」**

→ 4.7.1 實測：session 裡存的是**登入當下的快照**，同一個 session 看到的還是舊權限。
要立刻生效就得踢掉 session（4.3.3），或每個請求重查（代價見 4.7.1 那張表）。

**誤區 10：「無狀態比較快」**

→ 4.7.2 實測：**session 版 1250 個/秒、Basic 版 13 個/秒**。
無狀態**比較好擴展**，但每個請求的成本取決於憑證怎麼驗——
BCrypt 很貴，JWT 簽章很便宜（05 章）。

**誤區 11：「remember-me 就是登入」**

→ 4.6.2 實測：它是 `RememberMeAuthenticationToken`，
`authenticated()` 過得了、`fullyAuthenticated()` 過不了。
**敏感操作要用 `fullyAuthenticated()`**，並提供 4.6.3 的提升流程。

**誤區 12：「提升信任等級的端點也要 `fullyAuthenticated()`」**

→ 4.6.3：那是雞生蛋——使用者永遠到不了那支端點。
**提升端點必須是 `authenticated()`。**

---

## 4.10 本章小結

**一、身分裝在什麼東西裡，決定了其他所有事。**

```
裝在 session      → 可以精準撤銷（4.3.3）、每個請求便宜（4.7.2）、但要處理擴展（4.3.4）
裝在 cookie       → 瀏覽器【自動】送 → ★ CSRF 成立（4.4.2）
裝在標頭          → 攻擊者放不進去 → CSRF 不成立（4.4.2 ③）、但撤銷變難（05 章）
```

**二、`STATELESS` 沒有你以為的那麼「無狀態」（4.2）。**

```
它做的：叫 Spring Security 不要用 session 存 SecurityContext
🔴 它沒做的：阻止 session 被建立 —— 200 個請求長出 200 個 session（4.2.4）
🔴 匿名被擋下來那一步就會建立 session（4.2.1）—— SavedRequest 佔 1194 位元組
```

**三、`sessionFixation` 有四個選項，只有一個是錯的（4.3.1）。**

```
none()             🔴 固定攻擊成立 —— 永遠不要用
newSession()       換 id、丟掉舊屬性
migrateSession()   換 id、複製舊屬性
changeSessionId()  ★ 預設值：同一個 session 換名字，不用複製
```

**四、`maximumSessions` 會因為一個【不存在的方法】而靜默失效（4.3.2）。**

```
SessionRegistry 用 principal 當 Map 的 key
principal 沒有 equals / hashCode → 同一個人 = 好幾個 key → 上限永遠不會被觸發
🔴 啟動不報錯、沒有警告、程式碼看起來完全正確
```

**五、`expireNow()` 回答了前兩章留下的兩個問題（4.3.3）。**

```
02 章 2.7.7 停用帳號不生效   → 停用時順手 kick
03 章 3.7.7 收回權限不生效   → 收回時順手 kick
⚠️ 預設的過期回應是【200 + 純文字】—— API 一定要換掉
```

**六、CSRF 的判準只有一句話（4.5.1）。**

```
問：我的身分是【誰】送出去的？
    瀏覽器自動送 → 🔴 不可以關
    JS 主動放    → ✅ 可以關
🔴 token 存在 cookie 裡 = 瀏覽器自動送 = 不可以關（4.5.2）
```

**七、CSRF 的防線有主次之分（4.4、4.5）。**

```
主防線   CSRF token（綁在 session 上，攻擊者讀不到）
第二道   SameSite=Lax/Strict —— 🔴 但 Lax 擋不住跨站 GET 導航（4.5.3）
第三道   Origin / Sec-Fetch-Site —— 🔴 Referer 不行（4.4.3）
🔴 會改資料的端點不要用 GET —— CsrfFilter 根本不檢查它（4.4.4）
```

**八、有狀態與無狀態不是二選一（4.7.3）。**

```
同一個服務可以有兩條 chain：API 無狀態、後台有 session
代價是兩套撤銷邏輯與兩套 CSRF 判斷 —— 所以 4.1.2 的報表是【逐條】印的
```

### 4.10.1 驗收清單

```
□ JSESSIONID 是在哪一個請求被建立的？為什麼匿名請求也會建立它？
□ session 裡有哪兩個 Spring Security 的屬性？各佔多少位元組？
□ maxInactiveInterval 是「閒置」還是「總共」？怎麼做絕對逾時？
□ sessionCreationPolicy(STATELESS) 做了什麼？沒做什麼？
□ 一個無狀態服務為什麼會長出 session？哪五種寫法會觸發？
□ 為什麼 STATELESS + Basic 下，session id 每個請求都會變？
□ SecurityContextRepository 的四種實作各存在哪裡？6.x 的預設是哪一個？
□ sessionFixation 四個選項的差別？哪一個會讓固定攻擊成立？
□ changeSessionId() 比 migrateSession() 好在哪兩點？
□ maximumSessions(1) 沒有作用的原因是什麼？怎麼診斷？怎麼修？
□ HttpSessionEventPublisher 不宣告的話會發生什麼？
□ maxSessionsPreventsLogin 的 true / false 各有什麼被濫用的風險？
□ expireNow() 是立刻生效嗎？真正把人擋下來的是哪一個 Filter？
□ 預設的 expiredSessionStrategy 回什麼？為什麼 API 一定要換掉？
□ 叢集下 session 的三個去處？外部 store 的前提條件是什麼？
□ CsrfFilter 的四個步驟？三個角色分別負責什麼？
□ 為什麼同一個 session 每次拿到的 _csrf 值都不一樣？防的是什麼攻擊？
□ 攻擊者做得到與做不到的事各有哪些？（那張表）
□ 為什麼「無狀態 API 可以關 CSRF」—— 真正的理由是什麼？
□ 「檢查 Referer」的兩難是什麼？正確的補強是什麼？
□ CsrfFilter 不檢查哪四個方法？後果是什麼？
□ 判斷「能不能關 CSRF」的那一句話是什麼？
□ token 存在 cookie 裡為什麼 CSRF 會重新成立？HttpOnly 有幫助嗎？
□ SameSite 的三個值？Lax 擋不住哪三種情況？
□ CookieCsrfTokenRepository 為什麼要 withHttpOnlyFalse？為什麼那不是漏洞？
□ Double Submit Cookie 的前提是什麼？__Host- 前綴解決了什麼？
□ remember-me cookie 的四個欄位？改密碼為什麼會讓它失效？
□ 不設 rememberMe 的 key 會怎樣？症狀在什麼時候才會出現？
□ TokenBased 與 PersistentTokenBased 的三個差別？
□ fullyAuthenticated() 與 authenticated() 的差別？被擋時為什麼是 302/401 不是 403？
□ 哪些端點應該用 fullyAuthenticated()？判準是什麼？
□ 提升信任等級最容易寫錯的兩行是什麼？
□ session 裡的權限為什麼是快照？三種處理方向的延遲與成本？
□ session 版與 Basic 版的吞吐量差幾倍？差在哪裡？
□ 有狀態 vs 無狀態的八個比較項？
```

### 4.10.2 本章練習

**練習一（動手）：找出你的服務漏了幾個 session**

1. 把 4.1.1 的 `SessionCounter` 放進你的專案（它只依賴 Servlet API）。
2. 用壓測工具打 1000 個**不帶 cookie** 的請求到你的 API。
3. 看 `live()`。**不是 0 的話，用 stack trace 找出是誰呼叫了 `getSession()`。**
4. 把 `live()` 接上 Micrometer，變成一條可以告警的曲線。

**練習二（動手）：把 4.1.2 的報表放進你的專案**

1. 貼上 `SessionWiringReporter`，啟動。
2. **每一條 chain 都看一遍**：身分存在哪裡？CSRF 開著沒？
3. 有紅色警告的話，對照 4.5.1 那張表判斷它是不是真的漏洞。
4. 沒有警告的話，也要能說出**每一條 chain 為什麼是現在這個組合**。

**練習三（診斷）：`maximumSessions` 為什麼沒有作用**

1. 在你的專案裡開 `maximumSessions(1)`，用同一個帳號登入兩次。
2. 舊的沒被踢掉的話，打一支端點印出
   `registry.getAllPrincipals().size()`——它應該是 1。
3. 是 2 的話，**檢查你的 `UserDetails` 實作有沒有 `equals` / `hashCode`**。
4. 補上之後再跑一次。

**練習四（攻擊）：對自己的系統打一次 CSRF**

1. 寫一個最小的 HTML 檔（不要放在你的網域下，用 `file://` 開就可以）：

```html
<body onload="document.forms[0].submit()">
  <form action="http://localhost:8080/你的寫入端點" method="post">
    <input name="任意參數" value="任意值">
  </form>
</body>
```

2. 先在另一個分頁**正常登入**你的系統，再打開這個檔案。
3. **成功了的話，去看 4.5.1 那張表，找出你的身分是誰送出去的。**
4. 把 CSRF 打開，再打一次，確認變成 403。

**練習五（設計）：寫出你的專案的「撤銷路徑」清單**

列出所有「應該讓某個人的登入立刻失效」的情境，以及每一條路徑現在有沒有呼叫 `kick`：

```
停用帳號          →  有 / 沒有
使用者自己改密碼   →  有 / 沒有（改密碼之後舊 session 該不該留？）
管理員重設密碼     →  有 / 沒有
收回角色 / 權限    →  有 / 沒有
偵測到異常登入     →  有 / 沒有
使用者按「登出所有裝置」→ 有 / 沒有（remember-me cookie 也要處理嗎？4.6.1）
```

**練習六（判斷）：把 `csrf().disable()` 的理由寫成註解**

翻出你專案裡每一個 `csrf(...)` 的設定，在旁邊補一句話說明：

```java
.csrf(c -> c.disable())     // ✅ 身分靠 Authorization: Bearer 攜帶，token 不放 cookie（4.5.1）
```

**寫不出理由的那一條，就是要修的那一條。**

---

## 4.11 下一章預告

**05 章：JWT 認證。**

這一章量出了兩個數字，而它們一起把 05 章的存在理由講完了：

```
4.7.2   Basic + 無狀態 = 13 個/秒       —— 每個請求跑一次 BCrypt
4.3.3   expireNow() = 下一個請求就生效  —— 但那需要伺服器記得每一個 session
```

📌 **JWT 想同時拿到兩邊的好處**：

```
無狀態（不用共享 session，水平擴展免費）
+ 每個請求便宜（驗一次簽章，不查資料庫、不跑 BCrypt）
```

⚠️ **而它付出的代價，正好是這一章最後一節的那一格**：

| | Session | JWT |
|---|---|---|
| 立刻撤銷一個人 | ✅ `expireNow()`（4.3.3） | 🔴 **做不到**——token 發出去就在外面了 |

**05 章會處理的五個問題**：

```
① JWT 的三段結構與簽章 —— 以及「Base64 不是加密」這件事有多少人搞錯
② 自己寫一個驗證 Filter，接進 01 章那條 chain 的正確位置
③ 過期時間要設多久？refresh token 是什麼、它憑什麼比較安全
④ 🔴 撤銷：黑名單 / 短 token + refresh / token 版本號 —— 三種做法的代價
⑤ 常見的錯誤用法（把角色寫死在 payload、沒設過期、alg:none、用對稱金鑰簽發給第三方）
```

**這一章留下的四個線索，05 章會用到**：

| 這一章的東西 | 05 章要用它做什麼 |
|---|---|
| 4.5.1 的判準表 | JWT 放 cookie 還是放標頭 —— 那一格決定 CSRF 要不要開 |
| 4.5.2 的「token 存 cookie」實測 | 這是 JWT 最常見的錯誤部署方式，05 章會再打一次 |
| 4.3.3 的 `expireNow()` | 對照組：JWT 要做到同一件事，得自己蓋一個 registry |
| 4.7.1 的「權限快照」 | JWT 的 payload 是**更長命**的快照——改權限要等 token 過期 |

⚠️ **順帶預告一個 05 章的實測**：
一個**沒有設過期時間**的 JWT，跟一個**永遠不會失效的密碼**是同一個東西——
而 `io.jsonwebtoken` 的 API **不會**因為你沒呼叫 `setExpiration()` 而報錯。
**05 章會用一個五年後才過期的 token 示範這件事的後果。**
