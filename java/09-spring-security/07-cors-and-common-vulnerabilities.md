# 第 07 章：跨來源與常見漏洞

> 前六章都在回答同一個問題：**「這個請求是誰送的、他能不能做這件事。」**
>
> ```
> 02 章   他是誰（認證）
> 03 章   他能做什麼（授權）
> 04 章   身分放在哪（session / cookie）、CSRF
> 05 章   身分換成一張 token（JWT）
> 06 章   身分由第三方證明（OAuth2 / OIDC）
> ```
>
> 這一章換一個角度：**同一套設定，從「瀏覽器」的角度看是什麼樣子。**
>
> 前後端一分家，第一個撞到的牆就是 **CORS**——而且它會跟 04 章的 CSRF 糾纏在一起，
> 因為兩者長得很像（都跟「跨網域」有關）、解法卻完全不同。
> 接下來的五節則是「設定看起來都對、但還是會被打進來」的那一類問題：
> 帳號列舉、暴力破解、安全標頭、機敏資料外洩，以及開放轉址與路徑正規化。
>
> 📌 **這一章有二十三個實測。** 其中六個值得先劇透：
>
> ```
> 7.2.4  🔴 七種 CORS 寫法，只有三種真的生效 —— 而失敗的那幾種【啟動完全不報錯】
> 7.2.5  🔴 那個 403 其實是一個被蓋掉的 401 —— 你在修錯的東西
> 7.2.6  🔴 你把 CORS 設定寫得「更正式」（宣告一個 bean），反而把它關掉了
> 7.2.9  🔴 「我們有 CORS 所以關掉 CSRF」—— 換一支端點，錢就轉走了
> 7.3.4  🔴 錯誤訊息統一了，但註冊端點的【回應時間】差 37 倍，答案還是洩漏出去
> 7.4.5  🔴 「登入失敗鎖帳號」＝ 你親手做了一個 DoS 工具送給攻擊者
> ```
>
> ⚠️ **這一章有一個貫穿全章的判準**：
>
> > 每看到一個防護機制，先問兩個問題：
> > **① 它在哪裡執行？**（瀏覽器 / 你的 Filter / 你的 Controller / 反向代理）
> > **② 它擋的是「讀」還是「寫」？**
> >
> > 這一章絕大多數的坑，都是把這兩個問題的答案搞混造成的——
> > 例如「CORS 在瀏覽器、擋的是讀」vs「CSRF 在伺服器、擋的是寫」。

---

## 7.1 學習目標與實驗環境

完成本章後，你應該可以：

- 說出 CORS 是**誰**在擋、擋的是**什麼**，以及為什麼 `curl` 完全不受影響（7.2.1）。
- 分辨哪些請求會觸發 preflight，並說出 preflight 在問什麼（7.2.2、7.2.3）。
- 排查「CORS 設了還是不通」：分辨那是**授權問題**還是**CORS 問題**（7.2.4、7.2.5）。
- 說出 Spring Boot 3.2 什麼時候會**自動**掛上 CORS、什麼時候**不會**（7.2.6）。
- 解釋 `allowedOrigins("*") + allowCredentials(true)` 為什麼不合法，以及「反射 Origin」為什麼是災難（7.2.7、7.2.8）。
- 說出 CORS 與 CSRF 的分工，並證明 CORS 不能代替 CSRF 防護（7.2.9）。
- 找出系統裡所有會洩漏「這個帳號存不存在」的地方，包含**時間**（7.3）。
- 設計一套登入失敗的鎖定機制，並說出它自己帶來的兩個新攻擊面（7.4）。
- 列出 Spring Security 預設送出的安全標頭，說明每一個擋什麼，並補齊缺的（7.5）。
- 檢查錯誤回應、actuator、log 有沒有把不該給的東西送出去（7.6）。
- 說明開放轉址（open redirect）怎麼變成一封「連結是真的」的釣魚信（7.7）。

### 7.1.1 本章的實驗環境

| 項目 | 版本 |
|---|---|
| Spring Boot | 3.2.5 |
| Spring Security | 6.2.4 |
| Spring Framework | 6.1.6（CORS 的實作在這裡，不在 Security） |
| JDK | Temurin 21.0.5 |
| MySQL | 8.0.46（沿用 02 章的 `app_user` / 03 章的 RBAC 五張表） |
| 機器 | Apple M2 / macOS 14.2.1（8 顆邏輯核心） |

**① 一個新相依**（7.6.2 要用）：

```xml
<!-- 7.6.2：示範 actuator 端點暴露什麼 -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

> ⚠️ **加這個相依有【兩個】會打到前面章節的副作用**（都是實測時撞到的）：
>
> **① 容器裡多了一個 `RequestMappingHandlerMapping`。**
> actuator 會註冊 `controllerEndpointHandlerMapping`，於是 03 章 3.9.4 那個 `CoverageTest` 裡的
> ```java
> @Autowired RequestMappingHandlerMapping mapping;     // 🔴 現在有兩個了
> ```
> 變成 `NoUniqueBeanDefinitionException`，**而且是在測試啟動時才爆**。修法是指名：
> ```java
> @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mapping;
> ```
>
> **② 🔴 `AuthorizationManager` 被包了一層。**
> actuator 帶進 `micrometer-observation`，Spring Security 偵測到 `ObservationRegistry` 之後，
> 會把 `AuthorizationFilter` 手上的 manager 包成 `ObservationAuthorizationManager`：
> ```
> AuthorizationFilter.manager = org.springframework.security.authorization.ObservationAuthorizationManager
>     field ObservationRegistry registry
>     field AuthorizationManager delegate        ← 真正的那個在這裡
> ```
> 於是 03 章 3.2.4 / 3.9.4 那兩個靠反射讀規則的報表，`instanceof
> RequestMatcherDelegatingAuthorizationManager` 永遠不成立——
> **它們不會報錯，只會安靜地印出一張「所有端點都沒有規則」的空表。**
> 修法是在反射之前先剝掉這一層（03 章的 `AuthzRuleReporter.unwrap(...)`，課文已經改好）。
>
> 📌 **這兩件事本身就是本章的主題**：
> 「只是加一個相依」永遠不只是加一個相依——它會帶進 bean、帶進 filter、帶進端點、
> **還會悄悄改變你既有工具看到的東西**。
> ②那一個尤其值得記住：它又是一次「**靜默失效**」——
> 一個原本可靠的安全檢查工具，在你毫不知情的情況下開始回報「一切正常」。
> （本站這一類的完整名單在 08 章 8.13 ⑤。）

**② 這一章不需要新的表。** 帳號沿用 02 章 2.1.1 的七個：

```
alice / bob    一般會員（ROLE_USER、MEMBER）
admin          管理員
cs             客服（03 章加的）
carol          🔴 enabled = false（停用）
dave           🔴 accountNonLocked = false（鎖定）
erin           🔴 accountNonExpired = false（帳號過期）
frank          🔴 密碼已過期（credentials_expire_at 在過去）
```

> carol / dave / erin / frank 這四個在 7.3.3 是主角——它們會示範
> 「Spring 幫你藏了帳號不存在，但**沒有**幫你藏帳號被停用」。

**③ 三支新的觀察端點**（`Ch07Endpoints`）：

```java
package com.example.lab09.ch07;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Profile;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/**
 * 07 章的觀察端點。分成三類：
 *   ① 讀得到【使用者資料】的 —— 跨來源讀取成功 = 資料外洩（7.2.8）
 *   ② 會【改變資料】的       —— 跨來源送達 = CSRF（7.2.9）
 *   ③ 會【爆炸】的           —— 看錯誤回應洩漏多少（7.6）
 */
@RestController
@Profile("ch7")
public class Ch07Endpoints {

    /** ① 一支「回應裡有機敏資料」的端點 —— 跨來源讀到它就是外洩 */
    @GetMapping("/api/profile")
    public Map<String, Object> profile(Authentication auth) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("username", auth == null ? "(匿名)" : auth.getName());
        out.put("email", (auth == null ? "anon" : auth.getName()) + "@example.com");
        out.put("餘額", 128_000);
        return out;
    }

    /** 不需要登入的端點 —— 用來分辨「被 CORS 擋」與「被認證擋」 */
    @GetMapping("/api/public/ping")
    public Map<String, Object> ping() { return Map.of("pong", true); }

    /** ② 會改資料的 POST —— 07 章用它證明「CORS 擋不住 CSRF」 */
    @PostMapping("/api/transfer")
    public Map<String, Object> transfer(@RequestParam String to, @RequestParam String amount,
                                        Authentication auth) {
        Ledger.log.add((auth == null ? "(匿名)" : auth.getName()) + " → " + to + " " + amount);
        return Map.of("ok", true, "轉帳次數", Ledger.log.size());
    }

    /** 🔴 一支【沒有被 CORS 設定涵蓋】的舊端點（不在 /api/** 底下）—— 7.2.9 的主角 */
    @PostMapping("/legacy/transfer")
    public Map<String, Object> legacyTransfer(@RequestParam String to, @RequestParam String amount,
                                              Authentication auth) {
        Ledger.log.add("[legacy] " + (auth == null ? "(匿名)" : auth.getName()) + " → " + to + " " + amount);
        return Map.of("ok", true, "轉帳次數", Ledger.log.size());
    }

    @GetMapping("/api/transfers")
    public Map<String, Object> transfers() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("轉帳次數", Ledger.log.size());
        out.put("明細", new ArrayList<>(Ledger.log));
        return out;
    }

    @PostMapping("/api/transfers/reset")
    public Map<String, Object> reset() { Ledger.log.clear(); return Map.of("ok", true); }

    /** ③ 一支一定會爆的端點 —— 7.6.1 看錯誤回應吐出多少東西 */
    @GetMapping("/api/invoices/{id}")
    public Map<String, Object> invoice(@PathVariable String id) {
        long n = Long.parseLong(id);                       // 傳 "abc" 進來就 NumberFormatException
        return Map.of("invoiceId", n, "amount", 1280);
    }

    /** ③ 另一支：自己丟一個訊息裡帶機敏字串的例外 */
    @GetMapping("/api/invoices/lookup")
    public Map<String, Object> lookup(@RequestParam String q) {
        throw new IllegalStateException(
                "SELECT * FROM ord3 WHERE owner='" + q + "' 查詢失敗（db=lab09, user=root）");
    }

    /** 7.7.1 開放轉址：一支單純顯示「我現在在哪」的端點 */
    @GetMapping("/where")
    public Map<String, Object> where(HttpServletRequest req) {
        return Map.of("path", req.getRequestURI(), "who",
                String.valueOf(req.getUserPrincipal() == null ? "(匿名)" : req.getUserPrincipal().getName()));
    }

    /** 一個假的帳本，只為了讓攻擊【有後果可看】 */
    static class Ledger {
        static final List<String> log = Collections.synchronizedList(new ArrayList<>());
    }
}
```

**④ 兩個測試工具**。第一個是「模擬瀏覽器的最後一步」——

真實的 CORS 檢查是在瀏覽器裡做的，而測試程式不是瀏覽器。
所以我們把那個判斷**自己寫出來**，讓每個實測都能印出「瀏覽器看到這個回應會怎麼做」：

```java
package com.example.lab09.ch07;

import com.example.lab09.Http;
import com.example.lab09.ch03.Seed3;
import com.example.lab09.ch04.Web;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

import java.net.http.HttpResponse;

/** 07 章測試的共用工具：起一個情境 context、種好帳號、給一個裸 Http 與一個會記 cookie 的 Web。 */
public final class Lab7 implements AutoCloseable {

    public final ConfigurableApplicationContext ctx;
    public final Http http;                  // 00 章 0.8.3：不跟隨轉址、不帶 cookie
    public final JdbcTemplate jdbc;
    public final int port;

    public Lab7(String... profiles) { this(new String[0], profiles); }

    public Lab7(String[] properties, String... profiles) {
        String[] all = new String[profiles.length + 2];
        all[0] = "db"; all[1] = "ch7";
        System.arraycopy(profiles, 0, all, 2, profiles.length);
        String[] props = new String[properties.length + 5];
        props[0] = "server.port=0";
        props[1] = "spring.main.banner-mode=off";
        props[2] = "logging.level.root=OFF";
        props[3] = "logging.level.org.apache=OFF";
        props[4] = "logging.level.org.springframework=OFF";
        System.arraycopy(properties, 0, props, 5, properties.length);
        this.ctx = new SpringApplicationBuilder(com.example.lab09.LabApp.class)
                .web(WebApplicationType.SERVLET).profiles(all).properties(props).run();
        this.port = ((WebServerApplicationContext) ctx).getWebServer().getPort();
        this.http = new Http(port);
        this.jdbc = ctx.getBean(JdbcTemplate.class);
        Seed3.reset(jdbc);                                     // 03 章 3.1.1 的帳號 + RBAC
        http.send("POST", "/api/transfers/reset", null);       // 帳本是 static 的，每個情境先清空
    }

    public Web web() { return new Web(port); }                 // 04 章 4.1.1：會記 cookie 的瀏覽器替身

    /** 帶 Basic 認證打一支 API */
    public HttpResponse<String> as(String user, String pw, String method, String path, String... headers) {
        String[] h = new String[headers.length + 2];
        h[0] = "Authorization"; h[1] = Http.basic(user, pw);
        System.arraycopy(headers, 0, h, 2, headers.length);
        return http.send(method, path, null, h);
    }

    /** ★ 送一個 preflight（瀏覽器在「真正的請求」之前自己發的那一個 OPTIONS） */
    public HttpResponse<String> preflight(String path, String origin, String method, String headers) {
        return http.send("OPTIONS", path, null,
                "Origin", origin,
                "Access-Control-Request-Method", method,
                "Access-Control-Request-Headers", headers);
    }

    /** 回應裡跟 CORS 有關的三個標頭，縮成一行 */
    public static String cors(HttpResponse<String> r) {
        String allowOrigin = r.headers().firstValue("access-control-allow-origin").orElse("(無)");
        String allowCred   = r.headers().firstValue("access-control-allow-credentials").orElse("(無)");
        String allowMethod = r.headers().firstValue("access-control-allow-methods").orElse("(無)");
        return "Allow-Origin=" + allowOrigin + "  Allow-Credentials=" + allowCred + "  Allow-Methods=" + allowMethod;
    }

    /**
     * ★ 模擬瀏覽器的最後一步：拿到回應後，決定「這份資料能不能交給 JS」。
     * 這四條就是 CORS 規格的全部重點。
     */
    public static String browserVerdict(HttpResponse<String> r, String origin, boolean withCredentials) {
        String acao = r.headers().firstValue("access-control-allow-origin").orElse(null);
        String acac = r.headers().firstValue("access-control-allow-credentials").orElse(null);
        if (acao == null) return "❌ 瀏覽器丟掉回應（沒有 Access-Control-Allow-Origin）";
        if (withCredentials && "*".equals(acao)) return "❌ 瀏覽器丟掉回應（帶 cookie 時 Allow-Origin 不可以是 *）";
        if (withCredentials && !"true".equals(acac)) return "❌ 瀏覽器丟掉回應（沒有 Allow-Credentials: true）";
        if (!"*".equals(acao) && !acao.equals(origin)) return "❌ 瀏覽器丟掉回應（Allow-Origin 不是 " + origin + "）";
        return "✅ JS 讀得到回應內容";
    }

    /** 從 JSON 裡挖一個數字欄位（測試用的土炮解析，夠用就好） */
    public static String jsonNumber(String json, String key) {
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return "?";
        int c = json.indexOf(':', i) + 1;
        int e = c;
        while (e < json.length() && ",}".indexOf(json.charAt(e)) < 0) e++;
        return json.substring(c, e).trim();
    }

    @Override public void close() { ctx.close(); }
}
```

**⑤ profile 對照**（這一章的變體）：

```
ch7                共用：PasswordEncoder ＋ Ch07Endpoints
c0 c1 c2 c3 c4 c4b ＋ c8   CORS 的七種寫法（7.2.4 的 ①～⑦）
c0opt              「把 OPTIONS 全部 permitAll」的補救寫法（7.2.6）
c5 c6 c8 c9        🔴 四種會出事的 CORS 設定（7.2.7、7.2.8、7.2.4⑦、7.2.9）
c7                 CORS 很嚴 ＋ cookie 認證 ＋ 關掉 CSRF（7.2.9）
e1 e2              帳號列舉：洩漏版 / 補好版（7.3）
b1 b2 b3           暴力破解：無保護 / 鎖帳號＋IP / 🔴 只鎖帳號（7.4）
h1 h2 h3 h4        安全標頭：預設 / 補齊 / 全關 / 允許被 iframe（7.5）
l1 l2 l3           錯誤與 actuator：預設 / 🔴 全開 / ✅ 補好（7.6）
o1 o2              開放轉址：🔴 用參數 / ✅ 只准站內（7.7）
```

> 📌 **讀者自己的專案不需要這樣分 profile**（00 章 0.3.0.1 說過）——
> 你只會有**一組**設定。這裡切成十幾個情境，是為了讓「對照組」可以並排跑在同一個專案裡。

### 7.1.2 先把「誰在哪裡擋」這張圖畫出來

這一章的每一個機制，都可以放進下面這張圖的某一格。**先記住這張圖，後面就不會混淆**：

```
    ┌─────────────────────────────────────────────────────────────────────┐
    │  使用者的瀏覽器                                                        │
    │   ├─ 同源政策（Same-Origin Policy）── 預設：不准讀別的來源的回應           │
    │   ├─ CORS ──────────── 伺服器可以【例外開放】給指定來源讀（7.2）           │
    │   ├─ SameSite cookie ── 決定 cookie 要不要跟著跨站請求送出（04 章 4.5.3）  │
    │   └─ CSP / X-Frame-Options ── 限制頁面能載入誰、能不能被嵌入（7.5）        │
    └──────────────────────────────────┬──────────────────────────────────┘
                                       │  HTTP
    ┌──────────────────────────────────▼──────────────────────────────────┐
    │  反向代理 / WAF                                                       │
    │   └─ X-Forwarded-* 的真相來源（7.4.4）、速率限制、移除 Server 標頭        │
    └──────────────────────────────────┬──────────────────────────────────┘
    ┌──────────────────────────────────▼──────────────────────────────────┐
    │  你的應用程式（Spring Security 的 Filter Chain，01 章）                  │
    │   ├─ StrictHttpFirewall ── 路徑正規化（7.7.2）                         │
    │   ├─ CorsFilter ────────── 回應 preflight、加 CORS 標頭（7.2）          │
    │   ├─ HeaderWriterFilter ── 送出安全標頭（7.5）                          │
    │   ├─ 你的 LockoutFilter ── 登入速率限制（7.4）                          │
    │   ├─ 認證 / 授權 Filter ─── 02、03 章                                  │
    │   └─ CsrfFilter ────────── 擋跨站寫入（04 章）                          │
    └──────────────────────────────────┬──────────────────────────────────┘
    ┌──────────────────────────────────▼──────────────────────────────────┐
    │  你的 Controller / Service                                           │
    │   ├─ 錯誤處理 ── 決定回應吐出多少（7.6.1）                                │
    │   └─ 回應物件 ── 決定資料吐出多少（7.6.3）                                │
    └─────────────────────────────────────────────────────────────────────┘
```

📌 **這張圖解釋了本章一半的坑**：

```
CORS 設了沒用          → 因為 CorsFilter 不在 chain 裡，或它排在認證【後面】（7.2.4）
CORS 擋不住 CSRF       → 一個在瀏覽器「讀」那一端，一個在伺服器「寫」那一端（7.2.9）
HSTS 設了不出現        → 因為反向代理那一層把 https 變成 http 了（7.5.2）
鎖 IP 鎖不到人         → 因為 IP 的真相在反向代理那一層（7.4.4）
```

---

## 7.2 CORS：誰在擋、擋什麼

### 7.2.1 實測：CORS 是瀏覽器的規則，不是伺服器的防護

先把最根本的誤解拆掉。很多人以為「設了 CORS，別的網站就打不到我的 API」——**完全相反**。

```java
    /** 7.2.1 CORS 是【瀏覽器】的規則 —— 不是瀏覽器的 client 完全不受影響 */
    @Test
    void corsIsABrowserRule() {
        try (Lab7 lab = new Lab7("c1")) {                       // c1：完全沒設 CORS
            HttpResponse<String> r = lab.http.get("/api/profile",
                    "Authorization", Http.basic("alice", "pw"),
                    "Origin", "https://evil.example");          // ★ 假裝自己是 evil.example 的網頁

            System.out.println("狀態碼          ： " + r.statusCode());
            System.out.println("CORS 回應標頭    ： " + Lab7.cors(r));
            System.out.println("拿到的 body     ： " + r.body());
            System.out.println("瀏覽器的判斷      ： " + Lab7.browserVerdict(r, "https://evil.example", true));
        }
    }
```

**輸出**：

```
═══ 7.2.1 CORS 擋的是瀏覽器，不是伺服器 ═══
① 我們（一個 Java HttpClient）帶著 Origin: https://evil.example 去打 /api/profile
   狀態碼          ： 200
   CORS 回應標頭    ： Allow-Origin=(無)  Allow-Credentials=(無)  Allow-Methods=(無)
   拿到的 body     ： {"username":"alice","email":"alice@example.com","餘額":128000}

★ 伺服器【照常】處理、照常回資料 —— 它根本沒有「因為 Origin 不對就拒絕」這回事。
  真正會丟掉這份回應的是【瀏覽器】：
   瀏覽器的判斷    ： ❌ 瀏覽器丟掉回應（沒有 Access-Control-Allow-Origin）

結論：CORS 是【瀏覽器】保護【使用者】的機制，不是伺服器的存取控制。
      curl / Postman / 後端對後端 / 爬蟲 —— 通通不受 CORS 影響。
```

**三句話把 CORS 定位清楚**：

```
① 瀏覽器預設就【不准】一個網站讀另一個來源的回應 —— 這叫「同源政策」，是預設規則。
② CORS 是伺服器對瀏覽器說：「這個來源我准了，你可以把回應交給他。」—— 它是【放寬】，不是【收緊】。
③ 所以「設了 CORS」永遠只會讓事情【更開放】，不會讓 API 更安全。
```

> ⚠️ **最重要的一個推論**：
> **CORS 不是存取控制。** 你的 API 該有的認證（02 章）與授權（03 章）一個都不能少。
> 「我們沒開 CORS 所以別人打不到」是錯的——**任何非瀏覽器的 client 都打得到**。

那「來源」是怎麼算的？**協定 + 主機 + 埠，三個全部相同才叫同源**：

| 從這裡 | 打這裡 | 同源？ | 為什麼 |
|---|---|---|---|
| `https://app.example.com` | `https://app.example.com/api` | ✅ | 完全一樣 |
| `https://app.example.com` | `https://api.example.com` | ❌ | 主機不同（**子網域也算不同**） |
| `https://app.example.com` | `http://app.example.com` | ❌ | 協定不同 |
| `https://app.example.com` | `https://app.example.com:8443` | ❌ | 埠不同 |
| `http://localhost:3000` | `http://localhost:8080` | ❌ | 埠不同（**本機開發第一個踩到的**） |

### 7.2.2 哪些請求會先發 preflight

⚠️ **這一節是一張規則表，不是實測**——它來自 CORS 規格（Fetch Standard），
瀏覽器怎麼分類是**瀏覽器**決定的，伺服器端量不出來。
但這個分類**決定了 7.2.9 的攻擊成不成立**，所以要記牢：

```
═══ 7.2.2 簡單請求 vs 需要 preflight 的請求 ═══
瀏覽器要發的請求                                                   會先發 OPTIONS？
────────────────────────────────────────────────────────────────────────
GET /api/profile（沒有自訂標頭）                                 不會
POST /api/transfer  Content-Type: 表單編碼                      不會
POST /api/transfer  Content-Type: text/plain                  不會
POST /api/transfer  Content-Type: application/json            ★ 會
GET  /api/profile   Authorization: Bearer …                   ★ 會
PUT  /api/profile                                             ★ 會
DELETE /api/invoices/1                                        ★ 會

「簡單請求」的三個條件（全部滿足才不用 preflight）：
  ① 方法是 GET / HEAD / POST
  ② 只有白名單內的標頭（Accept、Accept-Language、Content-Language、Content-Type…）
  ③ Content-Type 只能是 application/x-www-form-urlencoded、multipart/form-data、text/plain

🔴 記住 ①＋③：一個【表單編碼的 POST】不需要 preflight —— 瀏覽器【直接送出去】。
   這就是 7.2.9 要講的：CORS 擋不住 CSRF。
```

**為什麼要有這個分類？** 因為 CORS 是**後來**才加到 Web 上的，而「表單可以送到任何網站」
這件事在 CORS 出現之前就存在了幾十年——一堆網站靠它運作。
所以規格只能規定：**HTML 表單本來就送得出去的那些請求，繼續送得出去**（＝簡單請求），
其餘「只有 JavaScript 才做得到」的請求才需要先問。

> 📌 這個歷史包袱直接造成了 CSRF 這個攻擊類別的存在，也造成 7.2.9 的結論。
> **「跨站的表單 POST 一定送得出去」不是 bug，是 Web 的相容性承諾。**

### 7.2.3 實測：preflight 在問什麼

```java
    /** 7.2.3 preflight 在問什麼、伺服器回什麼 */
    @Test
    void whatPreflightAsks() {
        try (Lab7 lab = new Lab7("c4")) {                       // c4：設定正確的那一組
            HttpResponse<String> r = lab.preflight("/api/profile",
                    "https://app.example.com", "GET", "authorization");
            r.headers().map().entrySet().stream()
                    .filter(e -> e.getKey().startsWith("access-control") || e.getKey().equals("vary"))
                    .sorted(Map.Entry.comparingByKey())
                    .forEach(e -> System.out.println("   " + e.getKey() + ": " + String.join(", ", e.getValue())));

            // 換一個【沒被允許】的來源問同一件事
            HttpResponse<String> bad = lab.preflight("/api/profile", "https://evil.example", "GET", "authorization");
            System.out.println("   狀態碼 " + bad.statusCode() + "  body: " + bad.body());

            // 換一個【沒被允許的方法】
            HttpResponse<String> badMethod = lab.preflight("/api/profile",
                    "https://app.example.com", "PATCH", "authorization");
            System.out.println("   狀態碼 " + badMethod.statusCode());
        }
    }
```

**輸出**：

```
═══ 7.2.3 preflight 到底在問什麼 ═══
① 瀏覽器自己發出的那個 OPTIONS（你的 JS 不會看到它）：
   OPTIONS /api/profile
   Origin: https://app.example.com                ← 我是誰
   Access-Control-Request-Method: GET             ← 我【接下來】想用什麼方法
   Access-Control-Request-Headers: authorization  ← 我【接下來】想帶什麼標頭

② 伺服器的回答：
   狀態碼 200
   access-control-allow-credentials: true
   access-control-allow-headers: authorization
   access-control-allow-methods: GET,POST,PUT,DELETE
   access-control-allow-origin: https://app.example.com
   access-control-expose-headers: X-Total-Count
   access-control-max-age: 3600
   vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers

③ 換一個【沒被允許】的來源問同一件事：
   狀態碼 403   Allow-Origin=(無)  Allow-Credentials=(無)  Allow-Methods=(無)
   body: Invalid CORS request

④ 換一個【沒被允許的方法】：
   狀態碼 403   Allow-Origin=(無)  Allow-Credentials=(無)  Allow-Methods=(無)

★ preflight 被拒絕時，【真正的請求根本不會送出】—— 伺服器永遠不會看到它。
  所以瀏覽器 console 的 CORS 錯誤，常常對應到後端 log 裡【什麼都沒有】。
```

**六個回應標頭各自的意思**：

| 標頭 | 意思 | 漏掉會怎樣 |
|---|---|---|
| `Access-Control-Allow-Origin` | 我准這個來源讀我的回應 | 瀏覽器丟掉回應（**唯一必要的**） |
| `Access-Control-Allow-Methods` | preflight 專用：我准這些方法 | 真正的請求不會送出 |
| `Access-Control-Allow-Headers` | preflight 專用：我准這些自訂標頭 | 帶 `Authorization` 就被擋 |
| `Access-Control-Allow-Credentials` | 我准你帶 cookie / Authorization 來 | `credentials:'include'` 的請求讀不到回應 |
| `Access-Control-Expose-Headers` | JS 可以讀這些**回應**標頭 | `res.headers.get('X-Total-Count')` 回 `null`（分頁常踩） |
| `Access-Control-Max-Age` | preflight 結果可以快取幾秒 | 每一個請求前面都多一趟 OPTIONS |

> 📌 **`Access-Control-Expose-Headers` 是最容易漏的一個。**
> 預設 JS 只讀得到六個「安全」的回應標頭（`Cache-Control`、`Content-Type`、`Expires`…）。
> 你的分頁總數放在 `X-Total-Count`、你的檔名放在 `Content-Disposition`——
> **不列進 expose，前端拿到的就是 `null`，而且沒有任何錯誤訊息。**

> ⚠️ **`Vary: Origin` 也很重要**：它告訴中間的快取「這份回應會隨 Origin 不同而不同」。
> 沒有它，CDN 可能把「給 A 網域的回應」快取起來發給 B 網域——
> 那等於把 CORS 白名單整個繞過。Spring 的 `CorsFilter` 會自動加，**自己手寫的常常忘記**。

### 7.2.4 🔴 實測：七種寫法，preflight 的下場

這是本節的核心。同一個需求（「讓 `https://app.example.com` 打得到我的 API」），七種寫法：

```java
    /** 七種寫法，preflight 的下場 */
    @Test
    void sevenWaysToConfigureCors() {
        record Case(String profile, String desc) {}
        for (Case c : new Case[]{
                new Case("c0",   "① .cors(disable) —— Security 完全不管 CORS"),
                new Case("c1",   "② 什麼都沒設"),
                new Case("c2",   "③ 只有 MVC 的 addCorsMappings"),
                new Case("c4b",  "④ 🔴 有 CorsConfigurationSource bean，忘了 .cors()"),
                new Case("c4",   "⑤ ✅ CorsConfigurationSource bean ＋ .cors()"),
                new Case("c3",   "⑥ addCorsMappings ＋ .cors()"),
                new Case("c8",   "⑦ 🔴 把 CorsFilter 當成一般 @Bean 註冊")}) {
            try (Lab7 lab = new Lab7(c.profile())) {
                HttpResponse<String> pre = lab.preflight("/api/profile",
                        "https://app.example.com", "GET", "authorization");
                boolean hasCorsFilter = lab.ctx.getBean(FilterChainProxy.class).getFilterChains().get(0)
                        .getFilters().stream().anyMatch(f -> f.getClass().getSimpleName().equals("CorsFilter"));
                int sources = lab.ctx.getBeanNamesForType(CorsConfigurationSource.class).length;
                String acao = pre.headers().firstValue("access-control-allow-origin").orElse("(無)");
                System.out.printf("%-48s %-8s %-12s %-26s %d%n",
                        c.desc(), pre.statusCode(), hasCorsFilter ? "有" : "沒有", acao, sources);
            }
        }
    }
```

**輸出**：

```
═══ 7.2.4 七種 CORS 寫法，preflight 的下場 ═══
設定                                                 preflight CorsFilter Allow-Origin               CorsConfigurationSource bean
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
① .cors(disable) —— Security 完全不管 CORS           403      沒有           (無)                        1
② 什麼都沒設                                          403      有            (無)                        1
③ 只有 MVC 的 addCorsMappings                       200      有            https://app.example.com    1
④ 🔴 有 CorsConfigurationSource bean，忘了 .cors()   403      沒有           (無)                        2
⑤ ✅ CorsConfigurationSource bean ＋ .cors()       200      有            https://app.example.com    2 ← 注意
⑥ addCorsMappings ＋ .cors()                      200      有            https://app.example.com    1
⑦ 🔴 把 CorsFilter 當成一般 @Bean 註冊                  403      沒有           (無)                        1

★ 三種結果只有兩種意思：200 = 通了；403 = 沒通。
  但 403 底下藏了【兩個完全不同的故事】—— 下一節把它們拆開。
```

> ⚠️ **最後一欄（`CorsConfigurationSource` bean 的數量）是整張表的鑰匙。**
> ④ 與 ⑤ 都是 **2**（自訂的 `corsConfigurationSource` ＋ MVC 自己的 `mvcHandlerMappingIntrospector`），
> 其餘五種都是 **1**。而 ④ 與 ⑤ 的差別只有「有沒有寫 `.cors()`」——
> 一個 403、一個 200。**為什麼「2」會關掉自動掛載，7.2.6 會給原始碼。**

**四個 🔴 的共同點**：

```
啟動沒有任何錯誤、沒有任何警告。
你要打開瀏覽器、切到 Network 分頁、看到那個紅色的 OPTIONS，才會知道。
而且看到的錯誤訊息長得一模一樣。
```

### 7.2.5 🔴 實測：同樣是 403，兩個完全不同的故事

上一張表裡有四個 403。它們的成因**完全不同**，而且修法相反：

```java
    /** 🔴 那個 403 是誰回的？ */
    @Test
    void whoReturnedThat403() {
        record Case(String profile, String desc) {}
        for (Case c : new Case[]{
                new Case("c0",    "① .cors(disable)"),
                new Case("c1",    "② 什麼都沒設（chain 裡有 CorsFilter）"),
                new Case("c0opt", "③ .cors(disable) ＋ OPTIONS 全部 permitAll"),
                new Case("c4",    "④ ✅ 設定正確")}) {
            try (Lab7 lab = new Lab7(c.profile())) {
                HttpResponse<String> pre = lab.preflight("/api/profile",
                        "https://app.example.com", "GET", "authorization");
                HttpResponse<String> bare = lab.http.send("OPTIONS", "/api/profile", null);  // ★ 不帶 Origin
                String wa = pre.headers().firstValue("www-authenticate").orElse("(無)");
                System.out.printf("%-48s %-28s %-14s %-24s%n",
                        c.desc(), pre.statusCode() + " " + brief(pre), bare.statusCode(), wa);
            }
        }
    }

    /** 把回應 body 縮成一行（只是為了讓表格排得整齊） */
    static String brief(HttpResponse<String> r) {
        String b = r.body() == null ? "" : r.body().replace("\n", " ").trim();
        return b.length() > 22 ? b.substring(0, 22) : b;
    }
```

**輸出**：

```
═══ 7.2.5 🔴 同樣是 403，兩個完全不同的故事 ═══
設定                                               preflight（帶 Origin）        裸 OPTIONS      WWW-Authenticate？
                                                                            (不帶 Origin)    ← 這一欄看得出真兇
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
① .cors(disable)                                 403 Invalid CORS request    401            Basic realm="Realm"
② 什麼都沒設（chain 裡有 CorsFilter）                403 Invalid CORS request    401            (無)
③ .cors(disable) ＋ OPTIONS 全部 permitAll          403 Invalid CORS request    200            (無)
④ ✅ 設定正確                                       200                        401            (無)
```

**①：那個 403 其實是一個被蓋掉的 401。** 事情是這樣發生的：

```
① chain 裡沒有 CorsFilter
② 匿名的 OPTIONS 一路走到 AuthorizationFilter → 拒絕
③ ExceptionTranslationFilter 呼叫 BasicAuthenticationEntryPoint → response.sendError(401)
④ Servlet 容器對 /error 做一次【ERROR dispatch】
⑤ 這一次 dispatch 進了 DispatcherServlet，而【它還是一個 preflight 請求】
⑥ MVC 找不到任何 CORS 設定 → 回 403 `Invalid CORS request`，把原本的 401 蓋掉
```

唯一活下來的證據是 `WWW-Authenticate: Basic realm="Realm"`——那是第 ③ 步留下的標頭。

> 📌 **這是 03 章 3.4.4 那個現象的鏡像**：
> 那裡是「`StrictHttpFirewall` 回 400，被 ERROR dispatch 蓋成 401」；
> 這裡是「Security 回 401，被 ERROR dispatch 蓋成 403」。
> **同一個機制：`sendError()` 會讓請求【再跑一次】，而第二次跑的結果會覆蓋第一次。**

**「裸 OPTIONS」那一欄是更好用的分辨法**。不帶 `Origin` 就不是 preflight，
MVC 的 CORS 處理器不會插手，你看到的就是 Security 的原始答案：

```
401 → 被【認證 / 授權】擋掉    → 去修授權規則，不要碰 CORS 設定
200 → 認證放行了              → 才是真的在修 CORS
```

> 📌 **排查 CORS 問題的第一步，永遠是這一行**：
>
> ```bash
> curl -i -X OPTIONS https://api.example.com/api/profile
> ```
>
> 回 401/403 而且有 `WWW-Authenticate` → 你的問題不是 CORS。
> 先讓這一行回 200，再去看帶 `Origin` 的那個。

### 7.2.6 🔴 Boot 3.2 的自動掛載規則：寫得越正式，越容易關掉它

7.2.4 有一件事很反直覺：**③（只寫 `addCorsMappings`，沒寫 `.cors()`）居然會動，
④（宣告了 `CorsConfigurationSource` bean，也沒寫 `.cors()`）卻不會動。**

```java
    @Test
    void whyDoesThreeWorkButFourNot() {
        for (String p : new String[]{"c1", "c2", "c4b", "c4"}) {
            try (Lab7 lab = new Lab7(p)) {
                String[] names = lab.ctx.getBeanNamesForType(CorsConfigurationSource.class);
                boolean hasCorsFilter = lab.ctx.getBean(FilterChainProxy.class).getFilterChains().get(0)
                        .getFilters().stream().anyMatch(f -> f.getClass().getSimpleName().equals("CorsFilter"));
                System.out.printf("profile %-5s  CorsConfigurationSource bean = %-46s → chain 裡%s CorsFilter%n",
                        p, String.join(", ", names), hasCorsFilter ? "【有】" : "【沒有】");
            }
        }
    }
```

**輸出**：

```
═══ 7.2.6 Boot 3.2 的自動掛載規則 ═══
profile c1     CorsConfigurationSource bean = mvcHandlerMappingIntrospector                  → chain 裡【有】 CorsFilter
profile c2     CorsConfigurationSource bean = mvcHandlerMappingIntrospector                  → chain 裡【有】 CorsFilter
profile c4b    CorsConfigurationSource bean = corsConfigurationSource, mvcHandlerMappingIntrospector → chain 裡【沒有】 CorsFilter
profile c4     CorsConfigurationSource bean = corsConfigurationSource, mvcHandlerMappingIntrospector → chain 裡【有】 CorsFilter
```

原因在 Spring Security 6.2 的 `HttpSecurityConfiguration` 裡，只有五行：

```java
private void applyCorsIfAvailable(HttpSecurity http) throws Exception {
    String[] beanNames = this.context.getBeanNamesForType(CorsConfigurationSource.class);
    if (beanNames.length == 1) {          // ★ 剛好【一個】才自動掛
        http.cors(withDefaults());
    }
}
```

只要 classpath 上有 Spring MVC，容器裡就已經有一個 `mvcHandlerMappingIntrospector`——
它本身就是一個 `CorsConfigurationSource`（負責處理 `addCorsMappings` 與 `@CrossOrigin`）。所以：

```
沒有自訂 bean → 數量 = 1 → 自動掛 .cors() → addCorsMappings / @CrossOrigin 直接生效
有自訂 bean   → 數量 = 2 → 🔴【不再】自動掛 → 你一定要自己寫 .cors()
```

> 🔴 **這條規則的反直覺之處：你把 CORS 設定寫得更正式，反而把它關掉了。**
>
> 典型的演進路線就是災難本身：
> ```
> 第一天  用 addCorsMappings 寫，會動 ✅
> 第三十天 覺得「CORS 是安全設定，應該放在 SecurityConfig」→ 改寫成 CorsConfigurationSource bean
>         → 忘了補 .cors() → 🔴 整個壞掉，而且啟動不報錯
> ```

這條規則還有一個副作用，寫程式時會直接撞到：

```java
// ❌ 編得過，但【啟動就爆】：NoUniqueBeanDefinitionException（容器裡有兩個 CorsConfigurationSource）
@Bean SecurityFilterChain chain(HttpSecurity http, CorsConfigurationSource src) { ... }

// ✅ 在同一個 @Configuration 類別裡直接呼叫自己的 @Bean 方法
@Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
    return http.cors(c -> c.configurationSource(corsConfigurationSource())).build();
}
```

**⑦（把 `CorsFilter` 當成一般 `@Bean`）又是另一個原因**——它排在 Security **後面**：

```
═══ 7.2.6（續）⑦ 為什麼 @Bean CorsFilter 沒用 ═══
preflight → 403   Allow-Origin=(無)  Allow-Credentials=(無)  Allow-Methods=(無)

Servlet 容器層的 Filter 順序（不是 Security chain 裡面的順序）：
   order = -100          springSecurityFilterChain（FilterChainProxy）← 認證授權在這裡
   order = 2147483647    你那個 @Bean CorsFilter（沒設 order 就是最低優先）

★ 你的 CorsFilter 排在 Security【後面】—— 匿名的 OPTIONS 在 Security 就被擋掉了，
  永遠輪不到它。修法有兩個：
   a) 用 `http.cors(...)`（本章建議）
   b) 若真的要用獨立 filter，包成 FilterRegistrationBean 並設 order = Ordered.HIGHEST_PRECEDENCE
```

**還有一種很常見的「補救」**，也一併量給你看：

```
═══ 7.2.6（續）另一種常見補救：.requestMatchers(OPTIONS, "/**").permitAll() ═══
① preflight（OPTIONS 放行後）  → 403   Allow-Origin=(無)  Allow-Credentials=(無)  Allow-Methods=(無)
② 真正的 GET                  → 200   Allow-Origin=(無)  Allow-Credentials=(無)  Allow-Methods=(無)
   瀏覽器的判斷                → ❌ 瀏覽器丟掉回應（沒有 Access-Control-Allow-Origin）

★ preflight 不再是 401 了（它變成 MVC 預設的 OPTIONS 回應），但【真正的 GET 沒有 CORS 標頭】
  —— 瀏覽器一樣丟掉回應。permitAll(OPTIONS) 治的是症狀，`.cors()` 才是治本。
  而且它順手把所有 OPTIONS 開成匿名可達（7.7.2）。
```

**本節的結論，一句話**：

> **`http.cors(...)` 的作用只有一個：把 `CorsFilter` 插在認證與授權【之前】。**
> 沒有它，preflight 這種「匿名的 OPTIONS」永遠走不到你的 CORS 設定。

### 7.2.7 🔴 實測：`allowedOrigins("*")` ＋ `allowCredentials(true)`

這是最常見的第一版 CORS 設定：「先全開讓它動起來」。

```java
    @Configuration @Profile("c5")
    static class C5_StarPlusCredentials {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            CorsConfiguration cfg = new CorsConfiguration();
            cfg.setAllowedOrigins(List.of("*"));            // 🔴 萬用字元
            cfg.setAllowedMethods(List.of("*"));
            cfg.setAllowedHeaders(List.of("*"));
            cfg.setAllowCredentials(true);                  // 🔴 又要帶 cookie
            UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
            src.registerCorsConfiguration("/**", cfg);
            return api(http).cors(c -> c.configurationSource(src)).build();
        }
    }
```

**輸出**：

```
═══ 7.2.7 🔴 allowedOrigins("*") ＋ allowCredentials(true) ═══
① 先送一個【普通的跨來源 GET】（不是 preflight）：
   狀態碼 500   body: {"timestamp":"...","status":500,"error":"Internal Server Error","path":"/api/profile"}

   500。伺服器端丟的是：
   java.lang.IllegalArgumentException:
     When allowCredentials is true, allowedOrigins cannot contain the special value "*"
     since that cannot be set on the "Access-Control-Allow-Origin" response header.
     To allow credentials to a set of origins, list them explicitly
     or consider using "allowedOriginPatterns" instead.
       at CorsConfiguration.validateAllowCredentials(CorsConfiguration.java:572)
       at CorsConfiguration.checkOrigin(CorsConfiguration.java:699)
       at DefaultCorsProcessor.checkOrigin(DefaultCorsProcessor.java:190)
       at CorsFilter.doFilterInternal(CorsFilter.java:87)

② 同一個設定，送 preflight：
   狀態碼 403   body: Invalid CORS request
   → 又是 7.2.5 的那個機制：500 被 ERROR dispatch 蓋成 403 `Invalid CORS request`。
     **同一個設定錯誤，兩種請求看到兩個不同的狀態碼** —— 只有 log 裡的堆疊是誠實的。

③ 這個檢查【不是啟動時】做的：
   `CorsConfiguration.validateAllowCredentials()` 是在 `checkOrigin()` 裡呼叫的，
   也就是【第一個帶 Origin 的請求打進來】才爆。
   本機開發（同源、瀏覽器不送 Origin）永遠測不出來，一上測試環境就 500。
```

**④ 為什麼規格上就不允許這個組合？**

```
`Access-Control-Allow-Origin: *` 的意思是「誰都可以讀，但【不准帶身分】」。
瀏覽器規定：只要請求帶了 cookie / Authorization（credentials），
回應的 Allow-Origin 就【必須是一個具體網域】，不可以是 *。
——「全世界都能讀」＋「帶著受害者的 cookie」＝「全世界都能讀受害者的資料」。
```

> ⚠️ **注意這個錯誤的「發作時機」**：它在**執行期**、而且只在**跨來源請求**時才爆。
> 開發時同源、沒有 `Origin` 標頭 → 一切正常；
> 前端一部署到不同網域 → 每一個請求 500。
> **這是「本機測不出來」這一類問題的教科書範例。**

### 7.2.8 🔴 實測：「改成能動」的那個做法——把 Origin 反射回去

Spring 的錯誤訊息最後一句是「考慮改用 `allowedOriginPatterns`」。很多人就照做了：

```java
cfg.setAllowedOriginPatterns(List.of("*"));     // 🔴 「Spring 說可以用這個」
cfg.setAllowCredentials(true);
```

**輸出**：

```
═══ 7.2.8 🔴 allowedOriginPatterns("*") ＋ credentials＝把大門打開 ═══
請求的 Origin                         狀態碼      Access-Control-Allow-Origin        Allow-Cred 瀏覽器會不會把資料交給 JS
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
https://app.example.com            200      https://app.example.com            true       ✅ JS 讀得到回應內容
https://evil.example               200      https://evil.example               true       ✅ JS 讀得到回應內容
http://localhost:3000              200      http://localhost:3000              true       ✅ JS 讀得到回應內容
null                               200      null                               true       ✅ JS 讀得到回應內容
```

**伺服器把你送來的 `Origin` 原封不動寫回 `Allow-Origin`——這不是白名單，這是「有問必答」。**

攻擊情境（受害者已登入你的網站，cookie 還在）：

```
1. 受害者在 evil.example 點了一個連結
2. evil.example 的 JS 執行 fetch('https://api.example.com/api/profile', {credentials:'include'})
3. 瀏覽器帶著受害者的 cookie 送過去
4. 你的 API 回 Allow-Origin: https://evil.example ＋ Allow-Credentials: true
5. 瀏覽器：「伺服器說可以」→ 把資料交給 evil.example 的 JS
6. 攻擊者讀到受害者的全部資料（餘額、email、訂單…）
```

> 🔴 **這比 CSRF 嚴重**：CSRF 只能**觸發動作**（而且看不到結果），
> 這個是直接**讀走資料**——等於受害者的整個帳號內容被複製一份。

**✅ 正確做法**：

```java
    @Configuration @Profile("c4")
    static class C4_Recommended {
        @Bean CorsConfigurationSource corsConfigurationSource() {
            CorsConfiguration cfg = new CorsConfiguration();
            cfg.setAllowedOrigins(List.of("https://app.example.com"));     // ★ 逐一列舉，不用 *
            cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE"));
            cfg.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-XSRF-TOKEN"));
            cfg.setExposedHeaders(List.of("X-Total-Count"));               // 前端讀得到的回應標頭
            cfg.setAllowCredentials(true);
            cfg.setMaxAge(3600L);                                          // preflight 快取一小時
            UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
            src.registerCorsConfiguration("/api/**", cfg);
            return src;
        }

        // ★ 一定要有這一行（7.2.6）：宣告了自訂 bean 之後，Boot 就不會自動掛了
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return api(http).cors(c -> c.configurationSource(corsConfigurationSource())).build();
        }
    }
```

**`allowedOriginPatterns` 不是不能用**，但樣式要有意義：

| 寫法 | 評價 |
|---|---|
| `setAllowedOrigins(List.of("https://app.example.com"))` | ✅ 最好。每個環境的網域寫進設定檔 |
| `setAllowedOriginPatterns(List.of("https://*.example.com"))` | ⚠️ 可用，但要確認**沒有人能申請你的子網域**（子網域接管是真實攻擊） |
| `setAllowedOriginPatterns(List.of("http://localhost:[*]"))` | ⚠️ 只能出現在開發設定檔裡，上線設定檔不可以有 |
| `setAllowedOriginPatterns(List.of("*"))` ＋ credentials | 🔴 等於沒有白名單 |
| `setAllowedOrigins(List.of("*"))` 且 **不帶** credentials | ⚠️ 對「真正公開的 API」可以接受（例如公開匯率查詢），但要確定它**永遠不會**需要身分 |

### 7.2.9 🔴 實測：CORS 擋不住 CSRF

這一節要拆掉 04 章之後最常見的那句話：「我們設了 CORS，所以可以關掉 CSRF。」

```java
    @Test
    void corsIsNotACsrfDefence() {
        try (Lab7 lab = new Lab7("c7")) {          // c7：CORS 只准 app.example.com、註冊在 /api/**；
            Web victim = lab.web();                //     用 session cookie 認證；CSRF 關掉
            victim.formLogin("alice", "pw");       // ① 受害者登入自家網站

            // ② 受害者逛到 evil.example，那頁上有一個自動送出的表單（表單編碼 POST ＝ 簡單請求，不發 preflight）
            HttpResponse<String> a = victim.post("/api/transfer", "to=attacker&amount=100000",
                    "Content-Type", "application/x-www-form-urlencoded", "Origin", "https://evil.example");
            HttpResponse<String> b = victim.post("/legacy/transfer", "to=attacker&amount=100000",
                    "Content-Type", "application/x-www-form-urlencoded", "Origin", "https://evil.example");
            // ③ 看帳本有沒有變
        }
    }
```

**輸出**：

```
═══ 7.2.9 🔴 「我們設了 CORS，所以可以關掉 CSRF」═══
情境設定（很多前後端分離專案長這樣）：
   CORS  allowedOrigins = https://app.example.com，只註冊在 /api/**   ← 設得很嚴
   認證  session cookie（表單登入）
   CSRF  .csrf(disable)                                              ← 「反正有 CORS」

① 受害者 alice 登入自家網站 → POST /login = 302
   受害者接著逛到 evil.example，那頁上有一個自動送出的表單：
   <form action="https://api.example.com/…" method="POST">
     <input name="to" value="attacker"><input name="amount" value="100000">
   </form><script>document.forms[0].submit()</script>
   表單送的是 `application/x-www-form-urlencoded` 的 POST ——
   照 7.2.2 的表，它是【簡單請求】，瀏覽器不發 preflight，直接送出去。

攻擊目標                           狀態碼        回應                         帳本變了嗎
────────────────────────────────────────────────────────────────────────────────────────────
/api/transfer（有 CORS 設定）       403        Invalid CORS request       沒有（轉帳次數 0）
/legacy/transfer（沒登記）          200        {"轉帳次數":1,"ok":true}       🔴 有！轉帳次數 1

② 再看一種更常見的寫法：手寫一個「只補回應標頭」的 CORS filter
/api/transfer（手寫 CORS）         200        {"轉帳次數":1,"ok":true}       🔴 有！轉帳次數 1
   → 200。手寫版只「加標頭」，從來不「擋請求」——
     這才是 CORS 規格原本的樣子，也是 7.2.1 說的「CORS 不是伺服器的存取控制」。
```

**第一列出乎意料，要解釋清楚**：

```
Spring 的 CorsFilter 比 CORS 規格【多做了一件事】：
  規格上，瀏覽器只是「不把回應交給 JS」，請求還是會送達伺服器、副作用還是會發生；
  但 Spring 的 DefaultCorsProcessor 發現 Origin 不在白名單，就【直接回 403、不往下走】。

→ 所以這一次攻擊真的被擋住了。很多人就是因此相信「CORS 可以代替 CSRF」。
```

**但第二列證明它靠不住**：

```
/legacy/transfer 不在 /api/** 底下 → CorsFilter 查不到設定 →
DefaultCorsProcessor.processRequest() 對【非 preflight】且 config 為 null 的請求
直接 return true（放行）。錢就這樣轉走了。
```

原始碼只有幾行，值得看一眼：

```java
// org.springframework.web.cors.DefaultCorsProcessor
public boolean processRequest(@Nullable CorsConfiguration config, HttpServletRequest request,
                              HttpServletResponse response) throws IOException {
    if (!CorsUtils.isCorsRequest(request)) { return true; }        // 沒有 Origin → 不關我的事
    ...
    if (config == null) {
        if (preFlightRequest) { rejectRequest(...); return false; }  // preflight 沒設定 → 403
        else { return true; }                                        // ★ 非 preflight 沒設定 → 放行
    }
    return handleInternal(serverRequest, serverResponse, config, preFlightRequest);
}
```

**三個結論**：

```
① **CORS 管的是「誰讀得到回應」，CSRF 管的是「誰送得出請求」。** 保護的是完全不同的東西。
② Spring 的 CorsFilter 順手擋掉了一部分跨來源請求 —— 那是【實作的善意】，不是【規格的保證】。
   漏一支端點、換一個框架、改成手寫 filter，這個「附贈的防護」就消失，而且你不會收到通知。
③ 只要身分載體是 cookie（瀏覽器會自動附帶），CSRF 防護就不能關（回到 04 章 4.5.2 的決策表）。
```

**「那我規定 API 只收 `application/json` 呢？」** 這確實會逼出 preflight：

```
═══ 7.2.9（續）「那我規定 API 只收 application/json 呢？」═══
① 如果攻擊者改用 JSON，瀏覽器就會先問 preflight：
   OPTIONS /api/transfer  Origin: https://evil.example → 403  Invalid CORS request
   → preflight 沒過，瀏覽器【不會】送出真正的 POST。這一次攻擊確實被擋住了。

② 所以「只收 JSON」算不算防護？—— 它是一層**很薄**的防護，不能當主線：
   ‧ 只要有任何一支端點吃 form / text/plain，那一支就繞過了（而且通常是最舊的那幾支）
   ‧ Spring MVC 的 @RequestParam 預設就吃表單編碼 —— 你以為只收 JSON，其實兩種都吃
   ‧ 一旦有人為了「相容舊前端」補上 consumes 以外的路徑，防線就無聲消失
   ‧ 它保護不了 GET 觸發的副作用（把改資料寫成 GET 的 API）

★ 真正的防線是 04 章那一套：**CSRF token**（或改用非 cookie 的身分載體，05 章的 JWT）。
  CORS 嚴格設定是【第二層】，不是第一層。
```

### 7.2.10 CORS 的建議設定與檢查清單

**一份可以直接抄的設定**（接續 7.2.8 的 `C4_Recommended`，把網域抽到設定檔）：

```java
package com.example.lab09.shop;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.web.cors.*;

import java.util.List;

@Configuration
public class ShopCorsConfig {

    /** 每個環境不同：dev 是 http://localhost:5173，prod 是 https://app.example.com */
    @Value("${app.cors.allowed-origins}")
    private List<String> allowedOrigins;

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(allowedOrigins);                     // ★ 逐一列舉，永遠不要 "*"
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE"));
        cfg.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-XSRF-TOKEN"));
        cfg.setExposedHeaders(List.of("X-Total-Count"));           // 前端讀得到的回應標頭
        cfg.setAllowCredentials(true);                             // 要帶 cookie / Authorization 才需要
        cfg.setMaxAge(3600L);                                      // preflight 快取，省掉每次的 OPTIONS
        UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
        src.registerCorsConfiguration("/api/**", cfg);             // ⚠️ 涵蓋範圍要對齊你的 API 路徑（7.2.9）
        return src;
    }
}
```

**檢查清單**（每一條都對應到本節一個實測）：

```
□ SecurityFilterChain 裡有沒有寫 `.cors(...)`？（7.2.6：宣告了自訂 bean 就不再自動掛）
□ `allowedOrigins` 是不是逐一列舉？有沒有出現 `*` 或 `allowedOriginPatterns("*")`？（7.2.7、7.2.8）
□ 註冊的路徑範圍蓋得住【全部】會被跨來源打的端點嗎？有沒有漏掉舊路徑？（7.2.9）
□ 前端要讀的回應標頭列進 `exposedHeaders` 了嗎？（7.2.3）
□ `curl -i -X OPTIONS <端點>`（不帶 Origin）回 200 嗎？回 401 代表是授權問題（7.2.5）
□ 上線設定檔裡有沒有殘留 `http://localhost:*`？
□ 關掉 CSRF 的理由是「身分載體不是 cookie」，而不是「我們有 CORS」嗎？（7.2.9、04 章 4.5.2）
```

---

## 7.3 帳號列舉：三個「為了使用者體驗」的洞

### 7.3.1 攻擊者要的不是密碼，是一份名單

先講清楚為什麼這件事重要。攻擊者拿到「哪些帳號存在」之後：

```
① 撞庫（credential stuffing）
   拿別處外洩的「email + 密碼」組合來試。一個帳號只試一次 —— 速率限制與鎖定幾乎攔不到（7.4）。
   而且他只會試【確定存在】的帳號，成功率高好幾個數量級。
② 針對性釣魚
   「您在 XX 購物的訂單有問題」—— 收件人確實是該站會員，點擊率比亂槍打鳥高非常多。
③ 帳號存在本身就是機密
   醫療、約會、求職、政治性平台 —— 「這個 email 在這裡有帳號」就已經是要保護的資訊。
```

一支會說「查無此帳號」的忘記密碼端點，就是**一台免費的帳號驗證機**：
丟一百萬個 email 進去，挑出回應不一樣的那些。

### 7.3.2 實測：三支端點，怎麼回答「這個帳號存不存在」

本章準備了同樣的三支端點、兩個版本：

```java
package com.example.lab09.ch07;

import com.example.lab09.ch02.AppUserRepo;
import org.springframework.context.annotation.*;
import org.springframework.core.env.Environment;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.Map;

/**
 * 7.3 帳號列舉。同樣的三支端點，兩個版本：
 *   e1 —— 🔴 會洩漏「這個帳號存不存在」的版本（全部都是「為了使用者體驗」加上去的）
 *   e2 —— ✅ 三支都不洩漏的版本
 */
public class EnumerationScenarios {

    @Configuration @Profile("e1 | e2")
    static class Common {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http
                    .authorizeHttpRequests(a -> a.anyRequest().permitAll())
                    .csrf(AbstractHttpConfigurer::disable)
                    .build();
        }

        /** 🔴 e1 把 hideUserNotFoundExceptions 關掉 —— 「這樣使用者才知道是帳號錯還是密碼錯」 */
        @Bean AuthenticationManager authManager(UserDetailsService uds, PasswordEncoder enc,
                                                Environment env) {
            DaoAuthenticationProvider p = new DaoAuthenticationProvider();
            p.setUserDetailsService(uds);
            p.setPasswordEncoder(enc);
            if (env.matchesProfiles("e1")) p.setHideUserNotFoundExceptions(false);
            return new ProviderManager(p);
        }
    }

    // ───────────────────────── e1：三個洩漏點 ─────────────────────────

    @RestController @Profile("e1")
    static class Leaky {
        private final AppUserRepo repo; private final JdbcTemplate jdbc;
        private final PasswordEncoder enc; private final AuthenticationManager am;
        Leaky(AppUserRepo repo, JdbcTemplate jdbc, PasswordEncoder enc, AuthenticationManager am) {
            this.repo = repo; this.jdbc = jdbc; this.enc = enc; this.am = am;
        }

        /** 🔴 洩漏點一：註冊時直接說「這個帳號已經有人用了」 */
        @PostMapping("/auth/register")
        ResponseEntity<?> register(@RequestParam String username, @RequestParam String password) {
            if (repo.findByUsernameWithAuthorities(username).isPresent())
                return ResponseEntity.status(409).body(Map.of("error", "此帳號已被註冊，請換一個"));
            insert(jdbc, enc, username, password);
            return ResponseEntity.status(201).body(Map.of("ok", true));
        }

        /** 🔴 洩漏點二：忘記密碼時說「查無此帳號」 */
        @PostMapping("/auth/forgot")
        ResponseEntity<?> forgot(@RequestParam String username) {
            if (repo.findByUsernameWithAuthorities(username).isEmpty())
                return ResponseEntity.status(404).body(Map.of("error", "查無此帳號"));
            sendMail(username);
            return ResponseEntity.ok(Map.of("message", "重設密碼的信已寄出"));
        }

        /** 🔴 洩漏點三：登入失敗時把例外原封不動丟給前端 */
        @PostMapping("/auth/login")
        ResponseEntity<?> login(@RequestParam String username, @RequestParam String password) {
            try {
                am.authenticate(new UsernamePasswordAuthenticationToken(username, password));
                return ResponseEntity.ok(Map.of("ok", true));
            } catch (AuthenticationException e) {
                return ResponseEntity.status(401).body(Map.of(
                        "error", e.getClass().getSimpleName(),
                        "message", e.getMessage()));     // ★ 把例外訊息原封不動丟給前端
            }
        }
    }

    // ───────────────────────── e2：三支都補好 ─────────────────────────

    @RestController @Profile("e2")
    static class Safe {
        private final AppUserRepo repo; private final JdbcTemplate jdbc;
        private final PasswordEncoder enc; private final AuthenticationManager am;
        Safe(AppUserRepo repo, JdbcTemplate jdbc, PasswordEncoder enc, AuthenticationManager am) {
            this.repo = repo; this.jdbc = jdbc; this.enc = enc; this.am = am;
        }

        /**
         * ✅ 註冊：不論帳號存不存在，都回同一個 202 ——
         * 「若此帳號可用，我們已寄出一封驗證信；若已被註冊，我們會寄一封提醒信給原主人。」
         * ★ 而且【兩條路都做一次雜湊】，不然時間差會把答案洩漏出去（7.3.4）。
         */
        @PostMapping("/auth/register")
        ResponseEntity<?> register(@RequestParam String username, @RequestParam String password) {
            String hash = enc.encode(password);                       // ★ 無論如何都先做（等成本）
            if (repo.findByUsernameWithAuthorities(username).isEmpty())
                insertHashed(jdbc, username, hash);
            else
                sendMail(username);                                   // 寄「有人想用你的 email 註冊」
            return ResponseEntity.accepted().body(Map.of(
                    "message", "我們已寄出一封信到這個信箱，請依信中指示完成"));
        }

        /** ✅ 忘記密碼：不論存不存在都回同一句 */
        @PostMapping("/auth/forgot")
        ResponseEntity<?> forgot(@RequestParam String username) {
            if (repo.findByUsernameWithAuthorities(username).isPresent()) sendMail(username);
            return ResponseEntity.ok(Map.of("message", "若此帳號存在，重設密碼的信已寄出"));
        }

        /** ✅ 登入：一律「帳號或密碼錯誤」（Spring 預設就是這樣，e1 是特地去關掉的） */
        @PostMapping("/auth/login")
        ResponseEntity<?> login(@RequestParam String username, @RequestParam String password) {
            try {
                am.authenticate(new UsernamePasswordAuthenticationToken(username, password));
                return ResponseEntity.ok(Map.of("ok", true));
            } catch (AuthenticationException e) {
                return ResponseEntity.status(401).body(Map.of("error", "帳號或密碼錯誤"));
            }
        }
    }

    // ───────────────────────── 共用小工具 ─────────────────────────

    static void insert(JdbcTemplate jdbc, PasswordEncoder enc, String username, String password) {
        insertHashed(jdbc, username, enc.encode(password));
    }

    static void insertHashed(JdbcTemplate jdbc, String username, String hash) {
        jdbc.update("""
                INSERT INTO app_user (username, password_hash, display_name, enabled,
                                      account_non_expired, account_non_locked, credentials_expire_at)
                VALUES (?,?,?,?,?,?,?)""",
                username, hash, username, true, true, true, (LocalDateTime) null);
    }

    /** 假裝寄信（真的寄信也要注意：寄信本身的耗時就是一個時間通道） */
    static void sendMail(String to) { /* no-op */ }
}
```

**輸出**：

```
═══ 7.3.2 三支端點，怎麼回答「這個帳號存不存在」 ═══

── 🔴 e1：常見寫法 ──
端點                         帳號存在（alice）                        帳號不存在（ghost…）                      分得出來嗎
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
POST /auth/register        409 {"error":"此帳號已被註冊，請換一個"}       201 {"ok":true}                    🔴 分得出來
POST /auth/forgot          200 {"message":"重設密碼的信已寄出"}        404 {"error":"查無此帳號"}              🔴 分得出來
POST /auth/login           401 {"error":"BadCredentialsExcept…      401 {"error":"UsernameNotFoundExce… 🔴 分得出來

── ✅ e2：補好之後 ──
端點                         帳號存在（alice）                        帳號不存在（ghost…）                      分得出來嗎
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
POST /auth/register        202 {"message":"我們已寄出一封信到這個信箱，請依信中… 202 {"message":"我們已寄出一封信到這個信箱，請依信中… ✅ 分不出來
POST /auth/forgot          200 {"message":"若此帳號存在，重設密碼的信已寄出"} 200 {"message":"若此帳號存在，重設密碼的信已寄出"} ✅ 分不出來
POST /auth/login           401 {"error":"帳號或密碼錯誤"}            401 {"error":"帳號或密碼錯誤"}            ✅ 分不出來
```

**e2 的註冊值得多看一眼**——它示範了「不洩漏」不等於「不好用」：

```
使用者輸入一個【已經註冊過】的 email：
  舊做法：畫面顯示「此帳號已被註冊」→ 使用者知道要去登入，體驗好，但洩漏
  新做法：畫面顯示「我們寄了一封信給你」→ 同時【真的寄一封信】給原主人：
          「有人用你的 email 嘗試註冊。如果是你，請直接登入；如果不是，請注意帳號安全。」

→ 真正的使用者收得到指引（而且是寄到他【確實擁有】的信箱），
  攻擊者收不到任何資訊。**體驗沒有變差，只是換了一個管道。**
```

### 7.3.3 實測：`hideUserNotFoundExceptions`——Spring 預設是對的

```
═══ 7.3.3 `hideUserNotFoundExceptions` —— Spring 預設是對的 ═══
🔴 e1（`setHideUserNotFoundExceptions(false)`）：
   帳號不存在（ghost）  → {"error":"UsernameNotFoundException","message":"ghost04"}
   密碼錯誤（alice）    → {"error":"BadCredentialsException","message":"憑證錯誤"}
   帳號被停用（carol）  → {"error":"DisabledException","message":"使用者已被停用"}
   帳號被鎖定（dave）   → {"error":"LockedException","message":"使用者帳號已被鎖定"}
   帳號已過期（erin）   → {"error":"AccountExpiredException","message":"使用者帳號已過期"}
   密碼已過期（frank）  → {"error":"CredentialsExpiredException","message":"使用者憑證已過期"}

✅ e2（預設值 true）：
   帳號不存在（ghost）  → {"error":"帳號或密碼錯誤"}
   密碼錯誤（alice）    → {"error":"帳號或密碼錯誤"}
   帳號狀態異常（carol）→ {"error":"帳號或密碼錯誤"}
   帳號狀態異常（dave ）→ {"error":"帳號或密碼錯誤"}
   帳號狀態異常（erin ）→ {"error":"帳號或密碼錯誤"}
   帳號狀態異常（frank）→ {"error":"帳號或密碼錯誤"}
```

**兩個重點**：

```
① `DaoAuthenticationProvider.hideUserNotFoundExceptions` 預設就是 `true`——
   它會把 `UsernameNotFoundException` 換成 `BadCredentialsException`，
   所以「帳號不存在」跟「密碼錯誤」對外一模一樣（02 章 2.5.5 的第一條規則）。
   ★ e1 是【特地把它關掉】才會洩漏 —— 這一格的預設值是對的，不要去動它。

🔴 ② 但帳號狀態的例外【不在】這個保護範圍內：
   `DisabledException` / `LockedException` / `AccountExpiredException` /
   `CredentialsExpiredException` 是【另外】丟出來的，訊息也不一樣。
   → 只要你的錯誤處理「把例外訊息丟給前端」（非常常見的寫法），
     這四個就把「帳號存在」說出去了。
```

**補法**：把訊息統一，真正的原因只寫進 log：

```java
/** ✅ 登入失敗的統一出口：對外一句話，對內記真正的原因（08 章會把它接到稽核） */
@Bean
AuthenticationFailureHandler uniformFailureHandler() {
    return (request, response, ex) -> {
        // log.warn("login failed: user={} reason={}", request.getParameter("username"),
        //          ex.getClass().getSimpleName());          ← 細節只進 log
        response.setStatus(401);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"error\":\"帳號或密碼錯誤\"}");   // ★ 對外永遠這一句
    };
}
```

> ⚠️ **「那使用者帳號被停用了怎麼辦？他永遠不知道為什麼登不進去。」**
> 這是真實的取捨。實務上的處理是：**不在登入頁說，改用另一個管道說**——
> 停用帳號時寄一封信給他（「您的帳號已於 X 月 X 日停用，原因…」）。
> 信寄到他**確實擁有**的信箱，攻擊者收不到。原則跟 7.3.2 的註冊一樣：**換管道，不是不說**。

### 7.3.4 🔴 實測：訊息統一了，時間沒統一

e2 的三支端點回應文字完全相同。那就量時間：

```
═══ 7.3.4 🔴 訊息一樣，時間不一樣 ═══
版本             端點                         帳號存在（中位數）            不存在（中位數）             差幾倍
────────────────────────────────────────────────────────────────────────────────────────────────────
🔴 e1        POST /auth/register        2.10 ms              78.42 ms             37.4 倍
✅ e2        POST /auth/register        75.00 ms             78.40 ms             1.0 倍
✅ e2        POST /auth/forgot          1.73 ms              1.57 ms              0.9 倍
✅ e2        POST /auth/login           78.43 ms             76.76 ms             1.0 倍
```

**逐列解釋**：

```
🔴 e1 的註冊：帳號存在 → 查一次 DB 就回 409；不存在 → BCrypt ＋ INSERT。
   **就算你把 409 的訊息改成跟 201 一模一樣，時間還是把答案說出來了**（差 37 倍，量十次就確定）。

✅ e2 的註冊把 `enc.encode(password)` 提到判斷【之前】—— 兩條路都付一次 BCrypt 的錢，時間拉平。

✅ /auth/login 幾乎沒有差 —— 02 章 2.5.3 講過原因：
   `DaoAuthenticationProvider` 查不到使用者時，會【故意跑一次假的 BCrypt】把時間補平。
   （也就是 02 章 2.5.5 那三條規則的由來：自己寫 `UserDetailsService` 回 null 就毀了這個保護。）

⚠️ /auth/forgot 的差距很小（毫秒級、比例接近 1），但那是**穩定**的差距 ——
   攻擊者可以對同一個帳號量一百次取中位數，雜訊就被平均掉了。
   **「差得不多」不等於「量不出來」。**
```

**三種補法（由弱到強）**：

```
① 兩條路都做「等量的工作」—— 例如註冊時不管存不存在都先 encode 一次密碼（e2 的 register）
② 把耗時的事情（寄信、寫稽核）丟到背景佇列，端點本身只排隊、立刻回應
③ 對整支端點設一個【固定的最短回應時間】（02 章 2.5.3 的 MinimumDurationFilter）
```

### 7.3.5 完整清單與取捨

```
┌────────────────────────┬──────────────────────────────────┬────────────────────────────┐
│ 洩漏管道                │ 怎麼洩漏                           │ 怎麼補                       │
├────────────────────────┼──────────────────────────────────┼────────────────────────────┤
│ 登入失敗訊息             │ 「查無此帳號」vs「密碼錯誤」          │ 統一成一句（Spring 預設就對） │
│ 停用 / 鎖定訊息          │ 「此帳號已停用」＝帳號一定存在         │ failureHandler 統一         │
│ 註冊                    │ 409「已被註冊」                    │ 一律 202 ＋ 寄信告知原主人     │
│ 忘記密碼                │ 404「查無此帳號」                   │ 一律 200 同一句              │
│ 回應時間                │ 存在的帳號多做了事                   │ 等量工作 / 背景化 / 最短耗時   │
│ HTTP 狀態碼             │ 401 vs 404 vs 409                │ 同一個狀態碼                 │
│ 回應大小                │ 錯誤物件欄位數不同 → Content-Length │ 同一個回應物件               │
│ 前端即時檢查             │ /api/users/exists?u=… 這種端點      │ 刪掉，或加上速率限制與驗證碼    │
│ 帳號鎖定                │ 「已鎖定 30 分鐘」＝帳號存在          │ 鎖定訊息也統一（7.4.2）       │
│ 密碼重設連結             │ 存在才寄 → 收不到信也是一種答案       │ 兩種情況都寄（內容不同）       │
└────────────────────────┴──────────────────────────────────┴────────────────────────────┘
```

> ⚠️ **不是每個系統都需要做到滴水不漏。** 先問一個問題：
> 「知道某個 email 在我們這裡有帳號」對攻擊者值多少錢？
>
> ```
> 購物網站                       值一點（釣魚名單、撞庫目標）→ 補登入與忘記密碼就夠
> 醫療 / 約會 / 求職 / 政治平台    🔴 帳號存在【本身】就是敏感資訊 → 全部要補，含時間
> 公開社群平台（帳號名人人看得到）   做這個是白費力氣 —— 名單本來就公開
> 企業內部系統（帳號＝員工編號）     名單本來就可預測 → 力氣花在 MFA 與鎖定（7.4）比較划算
> ```

---

## 7.4 暴力破解與鎖定

### 7.4.1 實測：沒有任何保護時，猜密碼有多快

```
═══ 7.4.1 沒有任何保護時，猜密碼有多快 ═══
單執行緒連續猜 40 次：3.29 秒 → **12.2 次/秒**

攻擊者手上的字典                           單執行緒要跑多久
──────────────────────────────────────────────────────────────────
1,000 組密碼                          1.4 分鐘
10,000 組密碼                         13.7 分鐘
100,000 組密碼                        2.3 小時
1,000,000 組密碼                      22.8 小時
10,000,000 組密碼                     9.5 天
```

**為什麼這麼慢？** BCrypt cost=10 一次要 ~77 ms（00 章 0.7.3 量過）。

> 📌 **密碼雜湊本身就是第一道速率限制**，而且是唯一一道「攻擊者繞不過」的——
> 這正是 00 章 0.7 說「不要用 MD5/SHA-256 存密碼」的理由：
> 那些演算法**快**，快就是問題。把上表的 77 ms 換成 MD5 的 0.001 ms，一千萬組只要 **10 秒**。

**但這張表有三個「大幅縮短」的前提，攻擊者全都有**：

```
① 平行 —— 開 100 條連線就快 100 倍（你的伺服器只有幾顆核心，他有殭屍網路）
② 不需要跑完 —— 「top 1000 常見密碼」通常幾分鐘內就撞到人
③ 撞庫（credential stuffing）—— 拿別處外洩的「帳號＋密碼」組合來試，
   一個帳號只試【一次】，速率限制與鎖定幾乎攔不到
```

> ★ 所以 7.4 的鎖定**不是為了「讓他跑不完」**，而是**為了讓他在跑的過程中被發現、被擋下來**。
> 「跑不完」那一半的工作，00 章的 BCrypt cost 已經做完了。

### 7.4.2 實測：鎖定

先看程式。資料來源是 **Spring Security 自己發的認證事件**——
不用改任何一支 Filter（08 章會把事件講完整）：

```java
package com.example.lab09.ch07;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.*;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.security.authentication.event.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.authentication.WebAuthenticationDetails;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 7.4 暴力破解與鎖定。
 *   b1 —— 沒有任何保護（對照組）
 *   b2 —— 鎖「帳號 ＋ 來源 IP」，並用指數退避
 *   b3 —— 🔴 只鎖「帳號」—— 攻擊者可以拿它當 DoS 工具
 */
public class BruteForceScenarios {

    @Configuration @Profile("b1 | b2 | b3")
    static class Common {
        @Bean SecurityFilterChain chain(HttpSecurity http, ObjectProvider<LockoutFilter> lockout)
                throws Exception {
            http.authorizeHttpRequests(a -> a
                            .requestMatchers("/login", "/error", "/api/public/**").permitAll()
                            .anyRequest().authenticated())
                    // ★ 讓認證事件裡的 remoteAddress 跟 LockoutFilter 看到的是【同一個】來源
                    .formLogin(f -> f.authenticationDetailsSource(ProxyAwareDetails.SOURCE))
                    .csrf(AbstractHttpConfigurer::disable);
            LockoutFilter f = lockout.getIfAvailable();
            // ★ 放在帳密 Filter【之前】—— 被鎖住的請求連 BCrypt 都不該跑
            if (f != null) http.addFilterBefore(f, UsernamePasswordAuthenticationFilter.class);
            return http.build();
        }
    }

    /**
     * 認證事件裡的 `WebAuthenticationDetails.getRemoteAddress()` 預設是 `request.getRemoteAddr()`。
     * 服務放在反向代理後面時，那個值永遠是代理的 IP —— 所有人看起來都來自同一個地方，
     * 於是「鎖 IP」不是鎖不到人，就是一鎖鎖全部。這裡換成跟 `LockoutFilter` 同一套取法。
     */
    public static class ProxyAwareDetails {
        public static final org.springframework.security.authentication.AuthenticationDetailsSource<
                HttpServletRequest, WebAuthenticationDetails> SOURCE =
                req -> new WebAuthenticationDetails(LockoutFilter.clientIp(req),
                        req.getSession(false) == null ? null : req.getSession(false).getId());
    }

    /** 登入失敗計數器 */
    @Component @Profile("b2 | b3")
    public static class LoginAttemptService {

        public static final int THRESHOLD = 5;                 // 幾次之後開始鎖
        private static final Duration MAX_LOCK = Duration.ofMinutes(60);

        private final boolean perIp;                           // b2 = true（帳號＋IP）；b3 = false（只鎖帳號）
        private final Map<String, Record> table = new ConcurrentHashMap<>();
        private Clock clock = Clock.systemUTC();               // 測試要把時間往前撥

        public LoginAttemptService(Environment env) { this.perIp = env.matchesProfiles("b2"); }

        public static final class Record {
            public int failures;
            public Instant lockedUntil = Instant.EPOCH;
        }

        public String key(String username, String ip) { return perIp ? username + "|" + ip : username; }

        /** 指數退避：第 5 次失敗鎖 1 分鐘、第 6 次 2 分鐘、第 7 次 4 分鐘…上限 60 分鐘 */
        public static Duration lockDuration(int failures) {
            if (failures < THRESHOLD) return Duration.ZERO;
            long minutes = 1L << Math.min(failures - THRESHOLD, 20);
            Duration d = Duration.ofMinutes(minutes);
            return d.compareTo(MAX_LOCK) > 0 ? MAX_LOCK : d;
        }

        @EventListener
        public void onFailure(AbstractAuthenticationFailureEvent e) {
            String ip = ipOf(e);
            Record r = table.computeIfAbsent(key(String.valueOf(e.getAuthentication().getName()), ip),
                    k -> new Record());
            r.failures++;
            Duration d = lockDuration(r.failures);
            if (!d.isZero()) r.lockedUntil = clock.instant().plus(d);
        }

        @EventListener
        public void onSuccess(AuthenticationSuccessEvent e) {
            table.remove(key(e.getAuthentication().getName(), ipOf(e)));   // ★ 成功就歸零
        }

        public boolean isLocked(String username, String ip) {
            Record r = table.get(key(username, ip));
            return r != null && clock.instant().isBefore(r.lockedUntil);
        }

        public Duration remaining(String username, String ip) {
            Record r = table.get(key(username, ip));
            if (r == null) return Duration.ZERO;
            Duration d = Duration.between(clock.instant(), r.lockedUntil);
            return d.isNegative() ? Duration.ZERO : d;
        }

        public int failures(String username, String ip) {
            Record r = table.get(key(username, ip));
            return r == null ? 0 : r.failures;
        }

        public int trackedKeys() { return table.size(); }

        private static String ipOf(AbstractAuthenticationEvent e) {
            Object details = e.getAuthentication().getDetails();
            return details instanceof WebAuthenticationDetails w ? w.getRemoteAddress() : "?";
        }
    }

    /** 被鎖住時直接回 429，連認證都不跑 */
    @Component @Profile("b2 | b3")
    public static class LockoutFilter extends org.springframework.web.filter.OncePerRequestFilter {

        private final LoginAttemptService attempts;
        public LockoutFilter(LoginAttemptService attempts) { this.attempts = attempts; }

        @Override
        protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
                throws ServletException, IOException {
            if ("POST".equals(req.getMethod()) && "/login".equals(req.getServletPath())) {
                String username = String.valueOf(req.getParameter("username"));
                String ip = clientIp(req);
                if (attempts.isLocked(username, ip)) {
                    long secs = attempts.remaining(username, ip).toSeconds();
                    res.setStatus(429);
                    res.setHeader("Retry-After", String.valueOf(secs));
                    res.setContentType("application/json;charset=UTF-8");
                    // ⚠️ 訊息刻意不提「這個帳號」—— 不然它就是一台帳號驗證機（7.3）
                    res.getWriter().write("{\"error\":\"嘗試次數過多，請稍後再試\"}");
                    return;
                }
            }
            chain.doFilter(req, res);
        }

        /**
         * 🔴 取來源 IP。這一行在正式環境是一個陷阱：
         * `X-Forwarded-For` 是**請求方寫的**，只有在「你確定前面有一台你自己的反向代理、
         * 而且它會覆寫這個標頭」時才可信。7.4.4 會示範直接相信它的下場。
         */
        public static String clientIp(HttpServletRequest req) {
            String xff = req.getHeader("X-Forwarded-For");
            if (xff != null && !xff.isBlank()) return xff.split(",")[0].trim();
            return req.getRemoteAddr();
        }
    }
}
```

**輸出**：

```
═══ 7.4.2 鎖定：第 5 次失敗之後 ═══
第幾次      動作                             狀態碼          Retry-After      說明
────────────────────────────────────────────────────────────────────────────────────────────
1        用錯的密碼登入                        302          -                302 → /login?error（密碼錯）
2        用錯的密碼登入                        302          -                302 → /login?error（密碼錯）
3        用錯的密碼登入                        302          -                302 → /login?error（密碼錯）
4        用錯的密碼登入                        302          -                302 → /login?error（密碼錯）
5        用錯的密碼登入                        302          -                302 → /login?error（密碼錯）
6        用錯的密碼登入                        429          59               🔒 被鎖了（連 BCrypt 都沒跑）
7        ★ 用【正確的】密碼登入                   429          59               🔒 一樣被擋 —— 鎖的是「嘗試」，不是「密碼對不對」

計數器目前的狀態：失敗 5 次，還要等 59 秒
```

**兩個實作細節值得抄走**：

```
① LockoutFilter 放在 UsernamePasswordAuthenticationFilter【之前】——
   被鎖住的請求連 BCrypt 都不跑。
   不然「鎖定」反而變成一個 CPU 消耗攻擊面：攻擊者只要一直打被鎖的帳號，
   就能讓你的 CPU 一直算 BCrypt（一次 77 ms，幾十條連線就吃滿一台機器）。

② 回應訊息寫「嘗試次數過多」，**不寫「這個帳號已被鎖定」**——
   後者等於告訴攻擊者「這個帳號存在」（7.3.5 的最後一列）。
```

> 📌 **`429 Too Many Requests` ＋ `Retry-After` 是正確的語意**。
> 不要用 401（那是「認證失敗」，前端會以為密碼錯）、也不要用 403。
> `Retry-After` 讓前端可以顯示倒數，而不是讓使用者一直亂試。

🔴 **這個 filter 有兩個「換個寫法就靜默失效」的前提，搬進你的專案前一定要對一遍**：

```
① 它把登入端點【寫死】成 "/login" ＋ 表單編碼的 username 參數。
   ‧ 02 章 2.3.6 把 `loginProcessingUrl` 換成了 `/api/auth/login` —— 路徑就對不上了。
   ‧ 如果登入改成收 JSON body（02 章 2.10 那種自訂認證 filter），
     `req.getParameter("username")` 一律回 null（容器只會解析表單編碼的 body）。
   🔴 兩種情況都是**鎖定完全不會啟動，而且不報錯**——filter 還在鏈上、每個請求都跑，
   只是那個 `if` 永遠不成立。搬進專案時，這兩個值要跟你的 `formLogin` 設定對齊。
   （收 JSON 的版本還要多包一層可重複讀的 request wrapper，
     否則 body 被你讀掉之後，後面的認證 filter 就讀不到了。）

② 🔴 計數用的帳號字串【沒有正規化】，但資料庫的比對是【不分大小寫】的。
   本站的 MySQL 用預設的 `utf8mb4_0900_ai_ci`（ci = case-insensitive），實測：

     Basic 'alice'    → 200  {"username":"alice", …}
     Basic 'Alice'    → 200  {"username":"alice", …}
     Basic 'ALICE'    → 200  {"username":"alice", …}     ← 🔴 四種寫法都登得進去
     Basic 'AlIcE'    → 200  {"username":"alice", …}
     Basic 'alice '   → 401                              （尾端空白不算，NO PAD collation）

   注意回應裡的 `username` 一律是 `alice` —— 認證【成功】後 principal 用的是
   資料庫那一列，不是你送進來的字串。但這個保護只在成功那條路上：
   `LockoutFilter` 讀的是 `req.getParameter("username")`（原始輸入），
   失敗事件的 `getAuthentication().getName()` 也是原始輸入（那時還沒查到人）。
   → `alice`、`Alice`、`ALICE`、`AlIcE`… 在 `ConcurrentHashMap` 裡是幾十個不同的 key，
   每一種各自從 0 開始算。**攻擊者每猜四次就換一種大小寫，門檻永遠達不到。**
   修法：計數用的 key 要跟【查帳號時用的那個字串】套同一套正規化
   （`username.trim().toLowerCase(Locale.ROOT)`），
   或者把 `username` 欄位改成 binary collation 讓登入也真的分大小寫——**兩邊要一致**。
```

> ★ 這兩件事跟 7.4.4 的「換 `X-Forwarded-For`」是同一類：
> **鎖定機制本身沒壞，是「要鎖誰」那個 key 被攻擊者控制了。**
> 每次設計速率限制，先問一句：**這個 key 是誰決定的？**

### 7.4.3 指數退避：為什麼不是「一律鎖 30 分鐘」

```
═══ 7.4.3 指數退避 ═══
累計失敗次數         這次鎖多久            到這一步為止，攻擊者總共被關了多久
────────────────────────────────────────────────────────────────────────
1              不鎖               -
2              不鎖               -
3              不鎖               -
4              不鎖               -
5              1 分鐘             1 分鐘
6              2 分鐘             3 分鐘
7              4 分鐘             7 分鐘
8              8 分鐘             15 分鐘
9              16 分鐘            31 分鐘
10             32 分鐘            63 分鐘
11             60 分鐘            123 分鐘
12             60 分鐘            183 分鐘
13             60 分鐘            243 分鐘
14             60 分鐘            303 分鐘
```

**指數退避在兩個目標之間取平衡**：

```
‧ 對真人：打錯三四次是日常，第五次鎖一分鐘幾乎無感
          （一律鎖 30 分鐘會讓客服電話爆掉，而且使用者會開始把密碼寫在便利貼上）
‧ 對機器：第 10 次之後單次就鎖 32 分鐘，一天只剩個位數的嘗試機會
```

**另外兩個一定要搭配的設計**：

```
‧ 成功登入要【歸零】計數（上面的 onSuccess）—— 不然真人遲早會踩到累積的鎖
‧ 計數器要會過期（例如 24 小時沒失敗就清掉）—— 不然它會無限長大，
  而且「三個月前打錯 4 次」不該影響今天
```

> ⚠️ **這個 `ConcurrentHashMap` 版本只適用於單一節點。**
> 一旦你跑兩個 instance，攻擊者的 5 次嘗試會被分到兩台機器上各算 2～3 次，
> 永遠達不到門檻。多節點要把計數器放進 Redis（10 站會做這件事）——
> **而且要用 `INCR` + `EXPIRE` 這種原子操作，不要用「讀出來加一再寫回去」。**

### 7.4.4 🔴 實測：「鎖 IP」的兩個破法

```
═══ 7.4.4 🔴 「鎖 IP」的兩個破法 ═══
① 攻擊者每一次都換一個 X-Forwarded-For：
   猜 20 次 → 被擋下 0 次
   計數器裡累積了 20 個 key（每個 IP 各自算 5 次）
   🔴 一次都沒鎖到 —— 因為 `X-Forwarded-For` 是【請求方自己寫的】。
```

**✅ 修法**：只在「請求確實來自你自己的反向代理」時才相信這個標頭。

```properties
# 交給框架的 ForwardedHeaderFilter 處理（會同時修正 scheme / host / port，7.5.2 的 HSTS 也要靠它）
server.forward-headers-strategy=framework

# 或交給 Tomcat 的 RemoteIpValve，可以設定信任哪些來源
server.forward-headers-strategy=native
server.tomcat.remoteip.internal-proxies=10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+
```

> ⚠️ **設成 `framework` / `native` 之前，先確定前面真的有一台【你控制的】代理，
> 而且它會【覆寫】（不是附加）`X-Forwarded-For`。**
> 直接對外的服務開這個設定，等於讓任何人自稱任何 IP——比不開更糟。

**第二個破法沒辦法用設定解決**：

```
② 就算 IP 是真的：殭屍網路有幾萬個真 IP，每個 IP 試 4 次就換下一個。
   → 「鎖 IP」擋得住一台機器的暴力破解，擋不住分散式的撞庫。
```

**所以鎖定要分層**，而且要跟 08 章的稽核接起來：

```
第一層   帳號 ＋ IP              擋單機暴力破解（本節的 b2）
第二層   單一帳號的全域失敗數      擋「很多 IP 打同一個帳號」→ 觸發 CAPTCHA / 要求二階段驗證
第三層   全站失敗率的異常偵測      擋「很多 IP 打很多帳號」（撞庫的樣子）→ 告警、全站升級驗證
最後一層 真正的解法              MFA / passkey —— 密碼對了也進不來，暴力破解失去意義
```

> 📌 **第二層刻意「不鎖死、只升級驗證」**，原因就是下一節。

### 7.4.5 🔴 實測：只鎖「帳號」＝ 送給攻擊者一個 DoS 工具

```
═══ 7.4.5 🔴 只鎖「帳號」的副作用 ═══
① 攻擊者從自己的 IP，故意把 alice 猜錯 5 次（他根本不想登入成功）：
   完成。

② 真正的 alice 從【她自己的 IP】、用【正確的密碼】登入：
   狀態碼 429   {"error":"嘗試次數過多，請稍後再試"}
   🔴 她進不去。攻擊者花五個請求，就把一個人鎖在門外。

③ 把同一件事對 admin、對全公司每一個帳號做一遍——整個系統沒有人登得進去。

★ 對照組（b2，key ＝ 帳號＋IP）：
  攻擊者的 IP 被鎖了，alice 從自己的 IP 登入 → 302（302 = 成功）
```

**這一節的取捨是安全設計的典型：每一個防護都會帶來新的攻擊面。**

```
鎖帳號     擋得住針對單一帳號的暴力破解，但被拿來當 DoS
鎖 IP      不會誤傷本人，但擋不住分散式攻擊、而且 IP 可能是偽造的
兩個都鎖   目前的實務做法：
          ‧ 帳號＋IP 做【硬鎖】（429）
          ‧ 單帳號的全域失敗數只用來【升級驗證】（跳 CAPTCHA、要求 email 驗證碼），
            而不是直接鎖死 —— 才不會被拿來 DoS
          ‧ 真正的帳號鎖定（`enabled=false`）留給人工判斷 / 明確的攻擊跡象
```

### 7.4.6 CAPTCHA 與 MFA 放在哪一格

```
┌──────────────┬────────────────────────┬──────────────────────────────────────┐
│ 手段          │ 擋什麼                   │ 放在哪 / 注意什麼                        │
├──────────────┼────────────────────────┼──────────────────────────────────────┤
│ BCrypt cost  │ 把每一次嘗試變貴          │ 00 章 0.7.4：一定要在【你的機器】上量過      │
│ 帳號＋IP 鎖定  │ 單機暴力破解             │ 7.4.2；filter 要在認證之前               │
│ CAPTCHA      │ 自動化腳本               │ **不要一開始就出現** —— 失敗 3 次後才跳；    │
│              │                        │ 它擋不住人工、也擋不住打碼服務              │
│ 裝置指紋 / 風險 │ 「同帳號但完全陌生的環境」  │ 訊號不錯，但誤判成本高，要有 fallback       │
│ MFA / passkey│ 🔴 **密碼對了也進不來**   │ 唯一能真正終結暴力破解與撞庫的手段           │
└──────────────┴────────────────────────┴──────────────────────────────────────┘
```

> ★ 這張表由上往下，**成本遞增、效果也遞增**。
> 如果你只能做一件事：**先把 BCrypt cost 設對（00 章），再做帳號＋IP 的鎖定（7.4.2）。**
> 如果你的系統有「一旦被入侵就完蛋」的帳號（管理後台、財務、客服後台），
> **那幾個帳號直接上 MFA**——比在密碼規則上鑽研划算得多。

---

## 7.5 安全標頭

### 7.5.1 實測：Spring Security 預設送出什麼

```
═══ 7.5.1 Spring Security 預設送出的安全標頭 ═══
GET /api/profile（已認證）→ 200
   cache-control:               no-cache, no-store, max-age=0, must-revalidate
   expires:                     0
   pragma:                      no-cache
   vary:                        Origin, Access-Control-Request-Method, Access-Control-Request-Headers
   x-content-type-options:      nosniff
   x-frame-options:             DENY
   x-xss-protection:            0
```

**逐一解釋**：

```
X-Content-Type-Options: nosniff
    禁止瀏覽器「猜」內容型別。沒有它，一個上傳的 .txt 若內容像 HTML，
    瀏覽器可能當成 HTML 執行 → 儲存型 XSS。

X-Frame-Options: DENY
    禁止任何網站用 iframe 嵌入你的頁面 → 擋 clickjacking（7.5.3）。

X-XSS-Protection: 0
    ★「0」是【故意】的，不是漏設。
    這個舊標頭（瀏覽器內建的 XSS 過濾器）本身有漏洞 —— 攻擊者可以利用它
    「選擇性地把頁面上某一段 script 關掉」，反而製造出新的攻擊。
    現代瀏覽器已經移除它，Spring Security 6 明確送出 0 要求關閉。
    ⚠️ 掃描報告常常把這一行標成「缺陷」，那是掃描工具的規則沒更新。防 XSS 請用 CSP。

Cache-Control: no-cache, no-store, max-age=0, must-revalidate（＋ Pragma / Expires）
    受保護的頁面不要進快取 —— 不然登出後按「上一頁」還看得到內容。
    共用電腦、公司代理快取都是實際發生過的事故。
```

> ⚠️ **注意 `Cache-Control` 是套在所有回應上的**，包含你的 JS / CSS / 圖片。
> 靜態資源要能被快取的話，**不要**整組關掉 `.headers()`（7.5.5），
> 而是把靜態資源拆到另一條 `securityMatcher` 的 chain 上，或單獨
> `.headers(h -> h.cacheControl(c -> c.disable()))`。

### 7.5.2 🔴 實測：HSTS 設定裡有，回應裡沒有

```
═══ 7.5.2 🔴 HSTS：設定裡有，回應裡沒有 ═══
① 一般（http）請求 → Strict-Transport-Security: (沒有)
② 同一支端點，帶 X-Forwarded-Proto: https → Strict-Transport-Security: max-age=31536000 ; includeSubDomains
```

（② 的前提是 `server.forward-headers-strategy=framework`。）

**原因**：`HstsHeaderWriter` 的預設 `requestMatcher` 是 `request.isSecure()`。
在 http 上送 HSTS 沒有意義（中間人一樣可以把它拿掉），所以 Spring 只在 https 上送。

> 🔴 **這造成一個很常見的誤判**：
> 服務跑在反向代理後面（代理處理 TLS、對內走 http）→ `request.isSecure()` 是 `false`
> → HSTS 永遠不出現 → 掃描工具報「缺少 HSTS」→ 有人手寫一個 filter 硬塞這個標頭。
>
> **修法不是手寫標頭，是讓 Spring 知道原始請求是 https**：
>
> ```properties
> server.forward-headers-strategy=framework
> ```
>
> 這一行同時修好 7.4.4 的 IP、`request.isSecure()`、以及 Spring 產生的絕對網址
> （轉址的 `Location`、OAuth2 的 `redirect_uri`，06 章）——**一次修四個問題**。

> ⚠️ **HSTS 是不可逆的承諾**：瀏覽器在 `max-age` 期間內**拒絕**用 http 連你的網域，
> 而且使用者沒辦法點「繼續前往」。上線步驟：
>
> ```
> ① max-age 先設幾分鐘（300），確認全站 https 沒問題
> ② 再拉到一天、一週、一年
> ③ includeSubDomains 之前，確認【每一個】子網域都有有效憑證
>    —— 包含那台「只有內部人用、憑證早就過期」的 admin.example.com
> ④ preload 是【送進瀏覽器內建清單】，移除要等好幾個月。確定要做再加
> ```

### 7.5.3 實測：clickjacking

```
═══ 7.5.3 clickjacking：X-Frame-Options 與 CSP frame-ancestors ═══
設定                                         X-Frame-Options      CSP frame-ancestors
────────────────────────────────────────────────────────────────────────────────────────────────
預設                                       DENY                 (沒有)
🔴 frameOptions().disable()               (沒有)               (沒有)
✅ CSP frame-ancestors 'none'              DENY                 frame-ancestors 'none'
🔴 headers(disable)                       (沒有)               (沒有)
```

**攻擊長這樣**（clickjacking / UI redressing）：

```html
<style>iframe { opacity: 0; position: absolute; top: 0; left: 0; width: 100%; height: 100%; }</style>
<button>點我領取免費點數</button>
<iframe src="https://your-bank.example/transfer?to=attacker&amount=100000"></iframe>
```

```
使用者以為自己點的是那顆按鈕，實際上點到的是【透明 iframe 裡】你網站的「確認轉帳」。
他的 cookie 在、session 在、CSRF token 也在（因為那真的是你的頁面）——

🔴 **04 章的 CSRF token 完全擋不住這個攻擊**，因為請求是使用者【自己點】出來的，
   token 是你的頁面自己帶上去的，每一項檢查都會通過。
```

**兩個標頭的分工**：

```
X-Frame-Options: DENY / SAMEORIGIN      舊標頭，所有瀏覽器都支援，但只能「全禁」或「同源」
CSP frame-ancestors 'none' / 'self' / https://partner.example
                                       現行標準，可以【逐一列舉】允許嵌入你的網站
→ 兩個都送。舊瀏覽器吃 X-Frame-Options，新瀏覽器優先看 frame-ancestors。
```

> 🔴 **`frameOptions().disable()` 幾乎都是真實需求造成的**：
> 「我們的頁面要能被客戶的入口網站 iframe 嵌入。」
> 正確做法不是關掉（那是對**全世界**開放），而是：
>
> ```java
> h.contentSecurityPolicy(c -> c.policyDirectives(
>         "frame-ancestors https://partner-a.example https://partner-b.example"));
> ```

### 7.5.4 實測：補齊之後的樣子

```java
    @Configuration @Profile("h2")
    static class H2_Hardened {
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return base(http)
                    // ⚠️ 這裡刻意寫成【大括號的區塊】而不是一路 `.` 下去：
                    //    `permissionsPolicy(Customizer)` 在 6.2 回傳的是 PermissionsPolicyConfig，
                    //    不是 HeadersConfigurer —— 鏈式寫法會在它之後斷掉（編譯錯誤，不是執行期問題）。
                    .headers(h -> {
                        // ① 只准自己載入，禁止被 iframe 嵌入
                        h.contentSecurityPolicy(c -> c.policyDirectives(
                                "default-src 'self'; "
                              + "script-src 'self'; "
                              + "style-src 'self'; "
                              + "img-src 'self' data:; "
                              + "connect-src 'self' https://api.example.com; "
                              + "frame-ancestors 'none'; "
                              + "base-uri 'self'; "
                              + "form-action 'self'; "
                              + "object-src 'none'"));
                        // ② 一年內只准走 HTTPS（含子網域）
                        h.httpStrictTransportSecurity(hsts -> hsts
                                .maxAgeInSeconds(Duration.ofDays(365).toSeconds())
                                .includeSubDomains(true)
                                .preload(true));
                        // ③ 跳出站外時不要把完整網址（可能含 token / id）送給對方
                        h.referrerPolicy(r -> r.policy(
                                ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN));
                        // ④ 關掉這個網站用不到的瀏覽器功能
                        h.permissionsPolicy(p -> p.policy(
                                "geolocation=(), camera=(), microphone=(), payment=()"));
                        // ⑤ 跨來源隔離（防跨視窗操控與 Spectre 類側通道）
                        h.crossOriginOpenerPolicy(c -> c.policy(
                                CrossOriginOpenerPolicyHeaderWriter.CrossOriginOpenerPolicy.SAME_ORIGIN));
                        h.crossOriginResourcePolicy(c -> c.policy(
                                CrossOriginResourcePolicyHeaderWriter.CrossOriginResourcePolicy.SAME_SITE));
                    })
                    .build();
        }
    }
```

**輸出**：

```
═══ 7.5.4 補齊之後的樣子 ═══
   cache-control:                 no-cache, no-store, max-age=0, must-revalidate
   content-security-policy:       default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.example.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
   cross-origin-opener-policy:    same-origin
   cross-origin-resource-policy:  same-site
   expires:                       0
   permissions-policy:            geolocation=(), camera=(), microphone=(), payment=()
   pragma:                        no-cache
   referrer-policy:               strict-origin-when-cross-origin
   strict-transport-security:     max-age=31536000 ; includeSubDomains ; preload
   vary:                          Origin, Access-Control-Request-Method, Access-Control-Request-Headers
   x-content-type-options:        nosniff
   x-frame-options:               DENY
   x-xss-protection:              0
```

**新增的五個各擋什麼**：

| 標頭 | 擋什麼 | 備註 |
|---|---|---|
| `Content-Security-Policy` | XSS 的**後果**（外部 script 載不進來、資料送不出去） | 唯一會把網站弄壞的一個，見下方導入步驟 |
| `Strict-Transport-Security` | 降級成 http 的中間人攻擊 | 7.5.2；不可逆 |
| `Referrer-Policy` | 跳出站外時把「完整網址」送給對方 | 你的網址裡有 token / 訂單編號時特別重要 |
| `Permissions-Policy` | 頁面（或被嵌入的第三方）偷用相機 / 定位 | 用不到的一律關掉，成本幾乎是零 |
| `Cross-Origin-Opener-Policy` | 別的視窗透過 `window.opener` 操控你的頁面 | 也是啟用 `SharedArrayBuffer` 的前提 |

> ⚠️ **CSP 是這張清單裡唯一一個會把網站弄壞的標頭。** 導入順序：
>
> ```
> ① 先用 `Content-Security-Policy-Report-Only` ＋ `report-uri` 上線，只收報告不阻擋
> ② 看幾天報告，把真正需要的來源補進政策（通常是 CDN、分析工具、字型）
> ③ 確認報告乾淨了，再換成 `Content-Security-Policy`
> ④ `'unsafe-inline'` 是最常見的妥協 —— 想拿掉它，inline script 要改用 nonce 或 hash
> ```

> ★ **這些標頭不是防線，是減災。**
> 它們擋不住「你的 API 沒驗權限」這種問題，
> 但能讓一個 XSS 從「偷走所有 cookie、打任意 API」變成「什麼都做不了」。

### 7.5.5 實測：`.headers(disable)` 之後少了什麼

```
═══ 7.5.5 對照：`.headers(disable)` 之後少了什麼 ═══
標頭                                 預設（h1）                                       .headers(disable)（h3）
────────────────────────────────────────────────────────────────────────────────────────────────────────
cache-control                      no-cache, no-store, max-age=0, must-revalidate 🔴 沒有了
expires                            0                                            🔴 沒有了
pragma                             no-cache                                     🔴 沒有了
x-content-type-options             nosniff                                      🔴 沒有了
x-frame-options                    DENY                                         🔴 沒有了
x-xss-protection                   0                                            🔴 沒有了
```

> ★ 會寫 `.headers(disable)` 幾乎都是為了解一個**具體**問題
> （通常是 `Cache-Control` 擋掉了靜態資源快取，或 `X-Frame-Options` 擋掉了嵌入）。
> **關掉整組是最貴的解法**——正確做法是只關那一個：
>
> ```java
> .headers(h -> h.cacheControl(c -> c.disable()))    // 只關快取控制
> ```
>
> 或把靜態資源拆到另一條 `securityMatcher` 的 chain 上（01 章 1.7）。

---

## 7.6 機敏資料外洩

### 7.6.1 實測：一支會爆的端點，回應裡有什麼

```
═══ 7.6.1 一支會爆的端點，回應裡有什麼 ═══

── ① Spring Boot 的預設 ──
   GET /api/invoices/abc → 500
   {"timestamp":"2026-09-15T04:59:30.660+00:00","status":500,"error":"Internal Server Error","path":"/api/invoices/abc"}
   GET /api/invoices/lookup?q=alice → 500
   {"timestamp":"2026-09-15T04:59:30.751+00:00","status":500,"error":"Internal Server Error","path":"/api/invoices/lookup"}

── ② 🔴 「為了方便除錯」打開的三個開關 ──
   server.error.include-message=always
   server.error.include-stacktrace=always
   server.error.include-exception=true

   GET /api/invoices/abc → 500
   {"timestamp":"…","status":500,"error":"Internal Server Error",
    "exception":"java.lang.NumberFormatException",
    "trace":"java.lang.NumberFormatException: For input string: \"abc\"
             at java.base/java.lang.NumberFormatException.forInputString(NumberFormatException.java:67)
             at java.base/java.lang.Long.parseLong(Long.java:709) …(略)

   GET /api/invoices/lookup?q=alice → 500
   {"timestamp":"…","status":500,"error":"Internal Server Error",
    "exception":"java.lang.IllegalStateException",
    "trace":"java.lang.IllegalStateException: SELECT * FROM ord3 WHERE owner='alice' 查詢失敗（db=lab09, user=root）
             at com.example.lab09.ch07.Ch07Endpoints.lookup(Ch07Endpoints.java:72) …(略)

── ③ ✅ 自己接管錯誤出口（@RestControllerAdvice） ──
   GET /api/invoices/abc → 500
   {"message":"系統忙碌中，請稍後再試","error":"SERVER_ERROR","traceId":"616980c6"}
   GET /api/invoices/lookup?q=alice → 500
   {"message":"系統忙碌中，請稍後再試","error":"SERVER_ERROR","traceId":"32252225"}
```

**一份堆疊會告訴攻擊者**：

```
‧ 你用的框架與【精確版本】（spring-web-6.1.6.jar）→ 直接去查這個版本的已知漏洞
‧ 你的套件結構與類別名（com.example.lab09.ch07.…）→ 猜得出還有哪些端點
‧ 你掛了哪些 filter、有沒有 Security、用哪一種 ORM → 決定要不要繼續試
‧ 例外訊息本身 —— 上面那個 IllegalStateException 把【SQL 與資料庫帳號】一起印出來了
```

> ⚠️ **`include-message=always` 常常被單獨打開**（「至少讓前端看得到錯誤原因」）。
> 但**例外訊息是全公司最不受控的字串**：任何人 `throw` 的時候都可能把資料庫欄位、
> 檔案路徑、內部服務網址、甚至使用者資料寫進去。
> **要給前端看的訊息，必須是你【明確決定】要給的那一句**，不能是「剛好被丟出來的那一句」。

**✅ 建議做法**：對外一個固定格式 ＋ 一個 `traceId`：

```java
/** ✅ 統一的錯誤出口：對外一句話，對內（08 章的稽核）才記細節 */
@RestControllerAdvice
class SafeErrors {

    private static final Logger log = LoggerFactory.getLogger(SafeErrors.class);

    @ExceptionHandler(Exception.class)
    ResponseEntity<?> any(Exception e, HttpServletRequest req) {
        String traceId = UUID.randomUUID().toString().substring(0, 8);
        log.error("[{}] {} {}", traceId, req.getRequestURI(), e.toString(), e);   // ← 細節只進 log
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                "error", "SERVER_ERROR",
                "message", "系統忙碌中，請稍後再試",
                "traceId", traceId));            // ★ 使用者回報時報這個編號，工程師去 log 撈
    }
}
```

> 📌 **`traceId` 是這個設計的關鍵**，不是裝飾。
> 沒有它，「對外不說細節」就等於「客服拿到一句『系統忙碌中』，工程師完全查不到是哪一筆」。
> 有了它，兩邊都拿到自己需要的東西：**使用者拿到一個編號，工程師拿到完整堆疊。**
> 如果你已經有分散式追蹤（traceparent / X-B3-TraceId），直接用那個 id，不要另外生一個。

⚠️ 注意 `@RestControllerAdvice` **接不到 Filter 層丟出來的例外**（它在 DispatcherServlet 裡面）。
認證 / 授權的錯誤要另外處理——那是 01 章 1.8 的 `AuthenticationEntryPoint` / `AccessDeniedHandler`。

### 7.6.2 🔴 實測：actuator——一句 permitAll 換來的東西

```
═══ 7.6.2 🔴 actuator：一句 permitAll 換來的東西 ═══

── 🔴 l2：management.endpoints.web.exposure.include=* ＋ /actuator/** permitAll ──
端點（匿名存取）                   狀態碼      回應片段
────────────────────────────────────────────────────────────────────────────────────────────
/actuator                  200      {"_links":{"self":{"href":"http://localhost:63778/actuator","t …(略)
/actuator/health           200      {"status":"UP"}
/actuator/env              200      {"activeProfiles":["db","ch7","l2"],"propertySources":[{"name" …(略)
/actuator/configprops      200      {"contexts":{"application":{"beans":{"spring.transaction-org.s …(略)
/actuator/beans            200      {"contexts":{"application":{"beans":{"spring.jpa-org.springfra …(略)
/actuator/mappings         200      {"contexts":{"application":{"mappings":{"dispatcherServlets":{ …(略)
/actuator/loggers          200      {"levels":["OFF","ERROR","WARN","INFO","DEBUG","TRACE"],"logge …(略)
/actuator/threaddump       200      {"threads":[{"threadName":"main","threadId":1,"blockedTime":-1 …(略)

特別看 /actuator/env 裡的資料庫設定：
   spring.datasource.url        → "******"
   spring.datasource.username   → "******"
   spring.datasource.password   → "******"

── 🔴 再加一行「這樣 env 才看得到東西」：management.endpoint.env.show-values=ALWAYS ──
   spring.datasource.url        → "jdbc:mysql://localhost:33307/lab09?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Taipei"
   spring.datasource.username   → "root"
   spring.datasource.password   → "root"

── ✅ l3：只開 health / info，其餘要 ROLE_ADMIN ──
端點                         匿名           alice        admin
──────────────────────────────────────────────────────────────────────
/actuator/health           200          200          200
/actuator/env              401          403          200
/actuator/beans            401          403          200
```

**三件事要記住**：

```
① Boot 3 預設只暴露 `health`（而且 health 預設不顯示細節）——
   **是 `exposure.include=*` 這一行把門打開的**，不是 Boot 的預設不安全。

② Boot 3 的 /actuator/env 預設把【所有】值都遮成 `******`（`show-values=NEVER`）——
   但正因為「遮到看不出東西」，很多人會補上 `show-values=ALWAYS`，
   於是資料庫連線字串、帳號、密碼原封不動印出來。
   ⚠️ 就算遮住值，**屬性名稱與 activeProfiles 還是全部列出來**：
      看得到你用了哪些中介軟體、哪些外部服務、環境叫什麼名字。

③ /actuator/beans 與 /actuator/mappings 把你的【全部端點與類別】列出來 ——
   等於把 API 地圖送給攻擊者（包含你以為沒人知道的那幾支內部端點）；
   /actuator/heapdump 更直接：整個記憶體，裡面有 session、token、剛查出來的使用者資料。
```

**✅ 建議設定**：

```properties
# ① 逐一列舉要開的端點，不要用 *
management.endpoints.web.exposure.include=health,info,prometheus

# ② health 的細節只給有授權的人看
management.endpoint.health.show-details=when-authorized
management.endpoint.health.roles=ADMIN

# ③ 最有效的一招：把管理端點換到另一個【只有內網打得到】的埠
management.server.port=9001
management.server.address=127.0.0.1
```

```java
// ④ 就算換了埠，授權規則照樣要寫 —— 內網不等於可信（縱深防禦）
.requestMatchers("/actuator/health", "/actuator/info").permitAll()
.requestMatchers("/actuator/**").hasRole("ADMIN")
```

> ⚠️ **「/actuator/health 要給 k8s 的 liveness probe 打，所以一定要 permitAll」**——
> 這是真的，但 permitAll 的只需要是 `/actuator/health`（甚至 `/actuator/health/liveness`），
> **不是 `/actuator/**`**。那個 `**` 就是整節的問題所在。

### 7.6.3 完整清單

```
┌──────────────────┬──────────────────────────────────────┬──────────────────────────────┐
│ 管道              │ 常見的外洩內容                          │ 怎麼補                        │
├──────────────────┼──────────────────────────────────────┼──────────────────────────────┤
│ 錯誤回應          │ 堆疊、框架版本、SQL、內部路徑              │ 統一錯誤出口 ＋ traceId（7.6.1）│
│ actuator         │ 設定、bean、端點清單、heapdump          │ 逐一 include ＋ 換埠 ＋ 授權     │
│ log              │ token、密碼、身分證字號、完整請求 body     │ 遮罩 ＋ 禁止印 Authorization    │
│ 回應物件          │ 多回了 passwordHash / internalNote     │ DTO 白名單，不要直接回 Entity    │
│ HTTP 標頭         │ Server: Apache-Coyote/1.1、X-Powered-By│ 反向代理移除                   │
│ 原始碼 / sourcemap│ 前端 bundle 裡的 API key、內部端點       │ 上線不出 sourcemap             │
│ git               │ .env、application-prod.yml 被 commit  │ pre-commit 掃描 ＋ 金鑰輪替     │
│ 404 vs 403       │ 「存在但沒權限」vs「不存在」（03 章 3.8.4）│ 統一回 404                    │
│ 備份 / 匯出檔      │ /backup.sql 放在 web 根目錄            │ 不要放進可公開的目錄            │
└──────────────────┴──────────────────────────────────────┴──────────────────────────────┘
```

> 🔴 **log 是最容易被忽略的一個**，因為它「不是給外人看的」——
> 但 log 會進 ELK、會被外包廠商看、會被截圖貼進聊天室、會跟著容器映像跑到測試環境。
>
> 回到 05 章 5.4.3：**access token 印進 log ＝ 那把鑰匙從此躺在一個沒有存取控制的地方**。

**三條可以現在就做的規則**：

```
① 永遠不要印整個 HttpServletRequest / 整個標頭 Map（Authorization 就在裡面）
② 印 token 一律只印前 8 碼 ＋ 長度；印 email 一律遮中間
③ logging.level.org.springframework.security=DEBUG 只開在本機 ——
   它會把認證物件（含 principal 細節）印出來
```

**「回應物件」那一列也值得單獨提醒**——它是最常見、也最容易修的一個：

```java
// 🔴 直接回 Entity：passwordHash、internalNote、deletedAt 全部一起出去
@GetMapping("/api/users/{id}")
public AppUser get(@PathVariable Long id) { return repo.findById(id).orElseThrow(); }

// ✅ 回一個 record DTO：欄位是【白名單】，新增欄位到 Entity 不會意外外洩
public record UserView(Long id, String username, String displayName) {}

@GetMapping("/api/users/{id}")
public UserView get(@PathVariable Long id) {
    AppUser u = repo.findById(id).orElseThrow();
    return new UserView(u.getId(), u.getUsername(), u.getDisplayName());
}
```

> 📌 **這是「白名單 vs 黑名單」的經典對比**（跟 03 章 3.3.2 的授權規則順序同一個道理）：
> `@JsonIgnore` 是黑名單——**你要記得每一個該擋的欄位**，漏掉一個就外洩，
> 而且下一個人加欄位時不會想到要標。DTO 是白名單——**沒列出來的就不會出去**。

---

## 7.7 其他常見漏洞

### 7.7.1 🔴 實測：開放轉址

需求很合理：使用者被導去登入頁時，登入完要回到原本想去的那一頁。
常見實作：`SimpleUrlAuthenticationSuccessHandler.setTargetUrlParameter("next")`。

```java
    @Configuration @Profile("o1 | o2")
    static class OpenRedirect {
        @Bean SecurityFilterChain chain(HttpSecurity http, Environment env) throws Exception {
            SimpleUrlAuthenticationSuccessHandler handler = new SimpleUrlAuthenticationSuccessHandler("/where");
            handler.setTargetUrlParameter("next");        // 「登入後回到原本那一頁」
            if (env.matchesProfiles("o2"))
                handler.setRedirectStrategy(new SameSiteOnlyRedirectStrategy());   // ✅ 只准站內
            return http
                    .authorizeHttpRequests(a -> a
                            .requestMatchers("/login", "/error").permitAll()
                            .anyRequest().authenticated())
                    .formLogin(f -> f.successHandler(handler))
                    .csrf(AbstractHttpConfigurer::disable)
                    .build();
        }
    }

    /** ✅ 只允許「以單一 `/` 開頭」的站內路徑；其餘一律回首頁 */
    static class SameSiteOnlyRedirectStrategy extends DefaultRedirectStrategy {
        @Override
        public void sendRedirect(HttpServletRequest request, HttpServletResponse response, String url)
                throws IOException {
            super.sendRedirect(request, response, isSafe(url) ? url : "/where");
        }

        /**
         * 這三個判斷少一個都可能被繞過：
         *   "https://evil.example"  → 絕對網址
         *   "//evil.example"        → protocol-relative，瀏覽器當成絕對網址
         *   "/\\evil.example"       → 某些環境會把 \ 正規化成 /，變成 //evil.example
         */
        static boolean isSafe(String url) {
            if (url == null || !url.startsWith("/")) return false;
            if (url.startsWith("//") || url.startsWith("/\\")) return false;
            return !url.contains("://");
        }
    }
```

**輸出**：

```
═══ 7.7.1 🔴 開放轉址：登入後被送到攻擊者的網站 ═══

── 🔴 o1：直接用 next 參數 ──
?next=                             狀態碼        Location（登入成功後被送去哪）
────────────────────────────────────────────────────────────────────────────────────────────────
/where                             302        http://localhost:63858/where
https://evil.example/phish         302        https://evil.example/phish          ← 🔴
//evil.example/phish               302        http://evil.example/phish           ← 🔴
/\evil.example/phish               302        http://localhost:63858/\evil.example/phish
/where?x=1                         302        http://localhost:63858/where?x=1

── ✅ o2：自訂 RedirectStrategy ──
?next=                             狀態碼        Location（登入成功後被送去哪）
────────────────────────────────────────────────────────────────────────────────────────────────
/where                             302        http://localhost:63877/where
https://evil.example/phish         302        http://localhost:63877/where
//evil.example/phish               302        http://localhost:63877/where
/\evil.example/phish               302        http://localhost:63877/where
/where?x=1                         302        http://localhost:63877/where?x=1
```

> ⚠️ 實測顯示 `/\evil.example/phish` 在 `DefaultRedirectStrategy` 底下**沒有**跑到外站
> （它把網址補成以本機為基底的絕對路徑）。但這條檢查仍然要留著——
> 一旦這段邏輯被改成 `response.sendRedirect(param)`（很多人重寫時會這樣簡化），它就會生效。
> **安全檢查不要依賴「現在的實作剛好幫我擋掉」。**

**攻擊怎麼用它？釣魚，但連結是真的**：

```
攻擊者寄一封信：「您的訂單有問題，請登入確認」
  連結 → https://shop.example.com/login?next=https://evil.example/login

‧ 網域是真的 shop.example.com，憑證是真的，使用者檢查網址列也看不出問題
‧ 使用者在【真的網站】輸入帳密 → 登入成功 → 被 302 送到 evil.example 的假登入頁
‧ 假頁面說「登入失敗，請再試一次」→ 使用者再輸入一次 → 密碼進了攻擊者手裡

進階版：next 指向攻擊者的頁面，而那個頁面立刻用 OAuth 流程把使用者
導回你的網站（06 章）—— 中間就能把 code / token 攔下來。
```

**★ Spring 的預設其實是安全的**：

```
SavedRequestAwareAuthenticationSuccessHandler（Spring 的預設）用的是
【伺服器端存的】SavedRequest —— 04 章 4.2.2 量過它佔 1194 位元組。
那是「這個瀏覽器剛剛真的被擋下來的那個請求」，攻擊者塞不進去。

**是 `setTargetUrlParameter(...)` 這一行把控制權交給了網址參數。**
```

**✅ 一定要用參數的話，驗證規則三條缺一不可**：

```
① 必須以 `/` 開頭（相對路徑）
② 不可以是 `//` 或 `/\` 開頭（那是 protocol-relative，等同絕對網址）
③ 不可以含 `://`

或者更省事：**只接受白名單裡的路徑名**（next=orders / next=cart），不接受自由字串。
```

> ⚠️ 同樣的問題也出現在：`logoutSuccessUrl`、密碼重設信裡的 `return_to`、
> 06 章 OAuth2 的 `redirect_uri`（那裡的答案一樣是【精確比對的白名單】，6.10 誤區 4）。

### 7.7.2 實測：Spring 已經幫你擋掉的幾件事

```
═══ 7.7.2 Spring 已經幫你擋掉的幾件事 ═══
請求                                             狀態碼        誰擋的
────────────────────────────────────────────────────────────────────────────────────────────
GET /api/../api/profile                        400        StrictHttpFirewall（路徑走訪：..）
GET /api//profile                              400        StrictHttpFirewall（重複的斜線）
GET /api/profile;jsessionid=x                  400        StrictHttpFirewall（路徑參數（;））
GET /api/%2e%2e/profile                        400        StrictHttpFirewall（編碼過的 ..）
TRACE /api/profile                             400        StrictHttpFirewall（TRACE 方法）
```

**為什麼要擋這些？** 因為**授權規則比對的是字串**：

```
你寫了     .requestMatchers("/admin/**").hasRole("ADMIN")
攻擊者送   GET /public/../admin/secret
          GET /admin/./secret
          GET /admin//secret
          GET /%61dmin/secret

→ 如果「同一個資源有好幾種寫法」，那規則比對過的就不一定是實際存取的那一個。
  這是真實存在過的繞過手法（不只 Spring，各家框架都出過）。
```

> 🔴 **最危險的一句設定是 `HttpFirewall firewall = new DefaultHttpFirewall();`**
> 通常是因為「我們的網址裡有 `//`（或中文、或分號），Spring 一直回 400」。
>
> 正確做法是**逐項放寬**：
>
> ```java
> @Bean
> HttpFirewall firewall() {
>     StrictHttpFirewall f = new StrictHttpFirewall();
>     f.setAllowUrlEncodedSlash(true);       // ★ 只開你真的需要的那一個
>     // f.setAllowSemicolon(true);
>     // f.setAllowUrlEncodedPercent(true);
>     return f;
> }
> ```
>
> **一次只開一個，而且要在 commit 訊息裡寫清楚為什麼。**

**另外三個一起提醒**：

```
‧ TRACE 被擋掉是好事 —— 它會把請求原封不動回顯（含 cookie），是 XST 攻擊的材料
‧ 7.2.4 那個「OPTIONS 全部 permitAll」的補救，就是在這裡多開了一個洞
‧ 03 章 3.4.4 量過：firewall 回 400 之後，若 /error 沒 permitAll，會被 ERROR dispatch
  蓋成 401 —— 跟 7.2.5 是同一個現象
```

---

## 7.8 shop-service 落地

06 章結束時，shop-service 有兩條 chain：`/api/**`（JWT，05 章）與後台網頁（session + oauth2Login，06 章）。
這一章把「面向瀏覽器」的那一面補完。

**① CORS：抽到設定檔，每個環境不同**

```java
package com.example.lab09.shop;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.web.cors.*;

import java.util.List;

@Configuration
public class ShopCorsConfig {

    @Value("${app.cors.allowed-origins}")
    private List<String> allowedOrigins;      // dev: http://localhost:5173 / prod: https://app.example.com

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(allowedOrigins);                     // ★ 永遠不要 "*"（7.2.7）
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE"));
        cfg.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-XSRF-TOKEN"));
        cfg.setExposedHeaders(List.of("X-Total-Count"));           // 前端的分頁要讀它（7.2.3）
        cfg.setAllowCredentials(true);
        cfg.setMaxAge(3600L);
        UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
        src.registerCorsConfiguration("/api/**", cfg);             // ⚠️ 涵蓋範圍要對齊 API 路徑（7.2.9）
        return src;
    }
}
```

**② 這條 chain 需要的四個零件，各自從哪裡來**：

```
JwtAuthenticationFilter                 05 章 5.4.1（API chain 用它驗 token）
LockoutFilter ＋ LoginAttemptService     7.4.2（本章；@Component，注入即可）
AuthenticationFailureHandler            7.3.3 的 uniformFailureHandler() bean（登入失敗統一一句）
OAuth2UserService<OidcUserRequest,…>    06 章 6.9 的 shopOidcUserService() bean（把 Google 的人綁到 app_user）
```

⚠️ **四個都是既有的 bean，這一節不新增類別** —— 它只是把它們接到兩條 chain 上。
如果你的專案裡還沒有其中任何一個，先回去把那一節做完再接。

**③ 兩條 chain 各自加上這一章的東西**：

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.oauth2.client.oidc.userinfo.OidcUserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.header.writers.*;
import org.springframework.web.cors.CorsConfigurationSource;

import com.example.lab09.ch05.JwtAuthenticationFilter;                   // 05 章 5.4.1
import com.example.lab09.ch07.BruteForceScenarios;                       // 7.4.2
import com.example.lab09.ch07.BruteForceScenarios.LockoutFilter;         // 7.4.2

import java.time.Duration;

/**
 * 07 章的 shop 落地：在 06 章的兩條 chain 上補 CORS、安全標頭、登入速率限制。
 * ⚠️ 這個類別【取代】06 章 6.9 的同名設定（同名 bean，舊的要刪掉）。
 */
@Configuration
public class ShopWebHardeningConfig {

    /** ① API：無狀態 ＋ JWT（05 章 5.9）＋ CORS（07 章） */
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http,
                                 CorsConfigurationSource cors,
                                 JwtAuthenticationFilter jwtFilter) throws Exception {
        return http
                .securityMatcher("/api/**")
                .authorizeHttpRequests(a -> a
                        .requestMatchers("/api/auth/**").permitAll()
                        .requestMatchers("/api/admin/**").hasAuthority("user:manage")
                        .anyRequest().authenticated())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                // ★ 07 章：一定要寫這一行（7.2.6 —— 宣告了自訂 bean 之後就不再自動掛）
                .cors(c -> c.configurationSource(cors))
                // ✅ CSRF 可以關，理由是【身分載體是 Authorization 標頭，不是 cookie】（04 章 4.5.2）
                //    —— 不是因為「我們有 CORS」（7.2.9）
                .csrf(AbstractHttpConfigurer::disable)
                .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class)
                .build();
    }

    /** ② 後台網頁：session ＋ formLogin ＋ oauth2Login（06 章）＋ 安全標頭 ＋ 登入鎖定（07 章） */
    @Bean
    @Order(2)
    SecurityFilterChain webChain(HttpSecurity http,
                                 SessionRegistry registry,
                                 LockoutFilter lockoutFilter,                                  // 7.4.2
                                 AuthenticationFailureHandler uniformFailureHandler,           // 7.3.3
                                 OAuth2UserService<OidcUserRequest, OidcUser> shopOidcUserService  // 06 章 6.9
                                 ) throws Exception {
        return http
                .authorizeHttpRequests(a -> a
                        .requestMatchers("/actuator/health", "/actuator/info").permitAll()   // ✅ 只開這兩支
                        .requestMatchers("/actuator/**").hasRole("ADMIN")                    // 7.6.2
                        .requestMatchers("/login/**", "/oauth2/**", "/error").permitAll()
                        .anyRequest().authenticated())
                // ★ 07 章：登入速率限制，放在帳密 Filter【之前】（7.4.2）
                .addFilterBefore(lockoutFilter, UsernamePasswordAuthenticationFilter.class)
                .formLogin(f -> f
                        // ★ 07 章：登入失敗一律同一句，真正的原因只進 log（7.3.3）
                        .failureHandler(uniformFailureHandler)
                        // ★ 讓認證事件裡的 IP 跟 LockoutFilter 看到的一致（7.4.2）
                        .authenticationDetailsSource(BruteForceScenarios.ProxyAwareDetails.SOURCE)
                        // ⚠️ 不設 targetUrlParameter —— 用 Spring 預設的 SavedRequest（7.7.1）
                        .permitAll())
                .oauth2Login(o -> o.userInfoEndpoint(u -> u.oidcUserService(shopOidcUserService)))   // 06 章 6.9
                .sessionManagement(s -> s.sessionFixation(fx -> fx.changeSessionId())
                        .maximumSessions(5).sessionRegistry(registry))                           // 04 章 4.8
                .logout(l -> l.logoutSuccessUrl("/login?logout").invalidateHttpSession(true))
                // ✅ 這條 chain 的身分載體是 cookie → CSRF 必須開著（04 章 4.5.1）
                // ★ 07 章：補齊安全標頭（7.5.4）
                .headers(h -> {
                    h.contentSecurityPolicy(c -> c.policyDirectives(
                            "default-src 'self'; script-src 'self'; style-src 'self'; "
                          + "img-src 'self' data:; frame-ancestors 'none'; "
                          + "base-uri 'self'; form-action 'self'; object-src 'none'"));
                    h.httpStrictTransportSecurity(hsts -> hsts
                            .maxAgeInSeconds(Duration.ofDays(365).toSeconds()).includeSubDomains(true));
                    h.referrerPolicy(r -> r.policy(
                            ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN));
                    h.permissionsPolicy(p -> p.policy("geolocation=(), camera=(), microphone=(), payment=()"));
                })
                .build();
    }
}
```

**④ 三個設定檔的變動**：

```properties
# ★ 讓 Spring 看得到原始請求的 scheme 與 IP —— 一次修好 HSTS（7.5.2）與 IP 鎖定（7.4.4）
server.forward-headers-strategy=framework

# ★ 錯誤回應不吐細節（7.6.1）—— 這三個都是 Boot 的預設值，明確寫出來避免有人改掉
server.error.include-message=never
server.error.include-stacktrace=never
server.error.include-exception=false

# ★ actuator 逐一列舉 ＋ 換到內網埠（7.6.2）
management.endpoints.web.exposure.include=health,info,prometheus
management.endpoint.health.show-details=when-authorized
management.server.port=9001

# ★ 每個環境不同的前端網域（7.2.10）
app.cors.allowed-origins=https://app.example.com
```

**⑤ 本章結束時，shop-service 面向瀏覽器的那一面**：

```
CORS         逐一列舉網域、只註冊在 /api/**、exposedHeaders 有 X-Total-Count
CSRF         API chain 關掉（載體是標頭）、web chain 開著（載體是 cookie）
安全標頭      CSP + HSTS + Referrer-Policy + Permissions-Policy，frame-ancestors 'none'
帳號列舉      登入失敗統一一句；註冊 / 忘記密碼一律同一個回應；等成本處理
登入速率限制   帳號＋IP、指數退避、429 + Retry-After，filter 在認證之前
錯誤          統一格式 ＋ traceId，細節只進 log
actuator     只開 health/info，其餘 ROLE_ADMIN，換到 9001 埠
轉址          用 Spring 預設的 SavedRequest，不開放 next 參數
```

⚠️ **還沒有的東西**（交給下一章）：

```
🔴 上面每一個「擋下來」的事件，都【沒有被記錄下來】                       → 08 章
   誰在什麼時候從哪個 IP 登入失敗？誰的權限被拒絕？誰改了別人的資料？
🔴 這一整章的設定，【沒有任何一個測試在保護它】                          → 08 章
   下次有人為了解 bug 加一句 permitAll，不會有任何東西告訴你
🔴 上線前的檢查清單                                                  → 08 章 8.8
```

---

## 7.9 常見錯誤用法

**① 以為「不開 CORS 別人就打不到我的 API」**（7.2.1）
→ CORS 是瀏覽器的規則。`curl` / 後端對後端 / 爬蟲完全不受影響。認證授權一個都不能少。

**② 宣告了 `CorsConfigurationSource` bean 卻沒寫 `.cors()`**（7.2.6）
→ Boot 只在「剛好一個 `CorsConfigurationSource` bean」時自動掛。你一加自訂 bean 就變兩個，自動掛消失。

**③ 用 `permitAll(OPTIONS, "/**")` 解 CORS 問題**（7.2.6）
→ 治症狀不治本：preflight 過了，真正的請求還是沒有 CORS 標頭。而且多開一個洞。

**④ `allowedOrigins("*")` ＋ `allowCredentials(true)`**（7.2.7）
→ 執行期 `IllegalArgumentException`，而且只有跨來源請求才會爆，本機測不出來。

**⑤ 改用 `allowedOriginPatterns("*")` 讓它「動起來」**（7.2.8）
→ 把 Origin 反射回去＝對全世界開放，攻擊者可以帶著受害者的 cookie 讀走全部資料。

**⑥ 「我們有 CORS 所以關掉 CSRF」**（7.2.9）
→ CORS 管「誰讀得到回應」，CSRF 管「誰送得出請求」。換一支沒登記路徑的端點就破功。

**⑦ 登入失敗訊息分「帳號不存在」與「密碼錯誤」**（7.3.3）
→ Spring 預設已經幫你藏好了，`setHideUserNotFoundExceptions(false)` 是主動打開洞。

**⑧ 訊息統一了，但兩條路的耗時不同**（7.3.4）
→ 註冊端點差 37 倍。要嘛兩條路做等量的工作，要嘛設一個最短回應時間。

**⑨ 登入失敗只鎖帳號**（7.4.5）
→ 攻擊者五個請求就能把任何人鎖在門外。要鎖「帳號＋IP」，全域計數只用來升級驗證。

**⑩ 直接相信 `X-Forwarded-For`**（7.4.4）
→ 那是請求方自己寫的。要先設 `server.forward-headers-strategy` 並確認前面真的有你的代理。

**⑪ `.headers(disable)` 或 `frameOptions().disable()`**（7.5.3、7.5.5）
→ 為了一個具體問題關掉一整組。只關那一個，或改用 CSP `frame-ancestors` 列舉。

**⑫ `server.error.include-stacktrace=always` 留在上線設定**（7.6.1）
→ 框架版本、套件結構、SQL、資料庫帳號一起送出去。

**⑬ `/actuator/**` permitAll ＋ `exposure.include=*`**（7.6.2）
→ 設定、bean 清單、端點地圖、heapdump 全部匿名可讀。

**⑭ `setTargetUrlParameter("next")` 卻沒驗證**（7.7.1）
→ 開放轉址：一封「連結是真的」的釣魚信。

**⑮ 把 `StrictHttpFirewall` 換成 `DefaultHttpFirewall`**（7.7.2）
→ 為了讓一個含 `//` 的網址能動，把整套路徑正規化的保護拿掉。逐項放寬就好。

---

## 7.10 常見誤區

**誤區 1：「CORS 是一種安全機制，設得越嚴我的 API 越安全」**
→ CORS 只會讓事情更**開放**。它的預設（同源政策）才是安全的那一邊。
「設 CORS」＝「開一個例外」，所以問題永遠是「這個例外開得夠小嗎」。

**誤區 2：「瀏覽器 console 顯示 CORS 錯誤，所以是 CORS 設定的問題」**
→ 7.2.5：那個錯誤訊息底下可能是 401（授權問題）、403（CORS 問題）、
甚至 500（設定組合非法）。**先用不帶 `Origin` 的 `curl -X OPTIONS` 分辨。**

**誤區 3：「CORS 和 CSRF 都是跨網域的問題，設一個就好」**
→ 7.2.9：一個在「讀回應」那一端（瀏覽器），一個在「送請求」那一端（伺服器）。
它們甚至不在同一個位置執行。

**誤區 4：「帳號列舉不是漏洞，反正帳號本來就是 email」**
→ 要看系統。7.3.5 的取捨表：購物網站值一點、醫療/約會/求職平台
「帳號存在本身」就是要保護的資訊、公開社群平台做了是白費力氣。
**重點是你要【知道自己選了哪一邊】，而不是從沒想過。**

**誤區 5：「我們有鎖定機制，所以密碼規則可以放寬」**
→ 7.4.1：鎖定擋不住撞庫（一個帳號只試一次）。
BCrypt cost、密碼規則、鎖定、MFA 是四層獨立的防護，不能互相抵扣。

**誤區 6：「安全標頭是前端的事」**
→ 它們是**HTTP 回應標頭**，由後端送出。前端改不了。
而且 `Cache-Control` / `X-Frame-Options` 設錯時，壞掉的是前端——所以更需要後端理解它們。

**誤區 7：「CSP 太麻煩，等有空再做」**
→ 部分同意：CSP 確實是這一章成本最高的一項。
但另外四個（HSTS、Referrer-Policy、Permissions-Policy、frame-ancestors）幾乎零成本零風險，
**今天就可以加**。不要因為 CSP 難就連那四個也不做。

**誤區 8：「錯誤訊息詳細一點使用者才知道怎麼辦」**
→ 7.6.1：使用者需要的是「怎麼辦」（重試、聯絡客服、報這個編號），
不是「哪一行 Java 爆了」。詳細的部分給 log，編號給使用者。

**誤區 9：「actuator 在內網，不用管」**
→ 內網不等於可信（一台被打下的機器、一個 SSRF、一個誤設的 ingress 就破功）。
而且 7.6.2 的 `/actuator/env` 只要一個 `show-values=ALWAYS` 就把資料庫密碼送出去。

**誤區 10：「這一章的東西掃描工具會幫我找出來」**
→ 掃描工具找得到「缺少 HSTS」這種**有無題**，找不到
「`allowedOriginPatterns("*")`」「只鎖帳號」「註冊端點的時間差」這種**設計題**。
而且它會誤報 `X-XSS-Protection: 0`（7.5.1）。

---

## 7.11 本章小結

```
7.2  CORS        瀏覽器的規則，不是伺服器的防護；`.cors()` 決定 CorsFilter 在不在 chain 裡；
                 逐一列舉來源；CORS 擋不住 CSRF
7.3  帳號列舉      訊息、狀態碼、回應大小、**時間** —— 四個管道都要一致
7.4  暴力破解      BCrypt 是第一道；鎖「帳號＋IP」＋指數退避；只鎖帳號＝DoS 工具；MFA 才是終局
7.5  安全標頭      預設四個 ＋ 建議補五個；CSP 最貴但最有效；HSTS 要先修 forward-headers
7.6  資料外洩      錯誤統一出口 ＋ traceId；actuator 逐一 include ＋ 換埠；log 是最容易漏的
7.7  其他          開放轉址用白名單；StrictHttpFirewall 逐項放寬，不要整套換掉
```

**一句話帶走**：

> **這一章的每一個坑，都是「設定看起來對、但執行的位置不對」。**
> CORS 設在 MVC 而不是 Security、CorsFilter 排在認證後面、HSTS 卡在反向代理、
> 鎖定的 filter 排在 BCrypt 後面、錯誤處理的 advice 接不到 filter 的例外——
> **永遠先問：這段程式碼在哪一層執行？它前面還有誰？**

### 7.11.1 驗收清單

```
□ CORS 是誰在擋？為什麼 curl 不受影響？「設 CORS」是放寬還是收緊？
□ 哪些請求會觸發 preflight？為什麼「表單編碼的 POST」不會？
□ preflight 的三個請求標頭、六個回應標頭各是什麼意思？
□ `http.cors(...)` 到底做了什麼？不寫它會怎樣？
□ Boot 3.2 什麼時候會自動掛 CORS？為什麼「宣告 bean」反而會關掉它？
□ preflight 回 403，怎麼分辨那是 CORS 問題還是授權問題？
□ `allowedOrigins("*")` + `allowCredentials(true)` 為什麼不合法？什麼時候才會爆？
□ 「反射 Origin」為什麼比 CSRF 嚴重？
□ CORS 和 CSRF 各自管什麼？為什麼不能互相取代？
□ 系統裡有哪幾個地方會洩漏「帳號存不存在」？包含時間嗎？
□ `hideUserNotFoundExceptions` 的預設值是什麼？它【沒有】蓋到哪些例外？
□ 沒有保護時，一個字典要跑多久？為什麼那個數字其實沒有參考價值？
□ 鎖定的 filter 為什麼要放在認證之前？
□ 只鎖帳號會怎樣？只鎖 IP 會怎樣？實務怎麼組合？
□ Spring Security 預設送出哪四個標頭？`X-XSS-Protection: 0` 為什麼是對的？
□ HSTS 設了卻不出現，原因與修法？
□ CSP 的 `frame-ancestors` 跟 `X-Frame-Options` 的關係？CSRF token 為什麼擋不住 clickjacking？
□ 錯誤回應該給什麼、不該給什麼？`traceId` 解決了什麼？
□ actuator 該怎麼設？為什麼「內網」不是理由？
□ 開放轉址怎麼變成釣魚？Spring 的預設為什麼是安全的？
```

### 7.11.2 本章練習

**練習一（觀察）：找出你系統的 CORS 真相**
1. 對你的 API 送一個**不帶 `Origin`** 的 `curl -i -X OPTIONS <端點>`，記下狀態碼。
2. 再送一個帶 `Origin: https://evil.example` 與 `Access-Control-Request-Method: GET` 的。
3. 對照 7.2.5 的表，判斷你現在在哪一格。
4. 把 `CorsConfigurationSource` 的 bean 數量印出來（`ctx.getBeanNamesForType(...)`），
   確認你的 `.cors()` 有沒有真的生效。

**練習二（動手）：把帳號列舉補起來**
1. 列出你系統裡所有「會依帳號存不存在而回應不同」的端點（至少檢查：登入、註冊、忘記密碼、
   前端的「帳號可用性即時檢查」）。
2. 對每一支量「存在 vs 不存在」的**回應時間中位數**（跑 15 次）。
3. 把差距超過 2 倍的補成等成本。
4. 寫一個測試把這件事釘住（下一章會教怎麼寫）。

**練習三（設計）：畫出你的鎖定策略**
```
門檻是幾次？鎖多久？指數退避還是固定？
key 是什麼？（帳號 / IP / 帳號＋IP / 裝置指紋）
多節點怎麼共用計數？（Redis 的 INCR + EXPIRE）
誰來解鎖？（自動過期 / 使用者收信 / 客服人工）
被鎖的人看到什麼訊息？那句話會不會洩漏帳號存在？
哪些帳號要直接上 MFA？
```

**練習四（攻擊思考）：用 7.5 的清單掃自己**
1. `curl -I https://你的網站` 把所有回應標頭抓下來。
2. 對照 7.5.4 的表，列出你少了哪幾個。
3. 挑出「零風險」的三個（Referrer-Policy、Permissions-Policy、frame-ancestors）先加上去。
4. 用 `Content-Security-Policy-Report-Only` 上一版 CSP，收一週報告。

**練習五（判斷）：這幾個設定，哪些可以上線？**
```
① cfg.setAllowedOrigins(List.of("*")); cfg.setAllowCredentials(false);     → 可以 / 不可以？
② cfg.setAllowedOriginPatterns(List.of("https://*.example.com"));          → 可以 / 不可以？
③ .requestMatchers("/actuator/**").permitAll()                             → 可以 / 不可以？
④ server.error.include-message=always                                      → 可以 / 不可以？
⑤ .csrf(disable) 且 API 用 Authorization 標頭帶 JWT                          → 可以 / 不可以？
⑥ .csrf(disable) 且 API 用 cookie 帶 JWT                                    → 可以 / 不可以？
```
（每一題都要能說出「在什麼條件下可以」，而不只是可以或不可以。）

---

## 7.12 下一章預告

**08 章：稽核與安全測試。**

這一章擋下了很多攻擊——但你**完全不知道它們發生過**。

```
7.4.2  第 6 次登入被 429 擋下 → log 裡沒有任何一行
7.2.9  跨來源的轉帳被 403 擋下 → 沒有人知道有人在試
03 章   一個帳號被拒絕存取別人的訂單 → 也沒有紀錄
```

而且，**這兩章寫的每一條規則，都沒有任何測試在保護它**。
下一次有人為了解 bug 加一句 `permitAll()`，CI 會全綠。

📌 **08 章會回答的問題**：

```
① Spring Security 自己發了哪些事件？哪些【預設就有】、哪些要自己打開？
② 稽核日誌要記什麼、不能記什麼？誰、何時、從哪、做了什麼、成功還是失敗
③ 🔴 為什麼「授權失敗回滾了交易，連稽核紀錄也一起回滾掉」——以及怎麼修
④ `@WithMockUser` 的三個坑：ROLE_ 前綴、principal 型別、不走 UserDetailsService
⑤ `spring-security-test`：`user()` / `jwt()` / `oauth2Login()` / `csrf()` 各用在哪
⑥ 授權矩陣測試：一次釘住「誰能打哪一支端點」，改壞了就紅燈
⑦ 上線前的安全檢查清單 —— 把 00～07 章的每一個 🔴 變成一條可以勾的項目
```

⚠️ **順帶預告兩個 08 章的實測**：

```
① 一個標了 @Transactional 的 service：先寫一筆「這次操作失敗了」的稽核，再做事；
   業務規則不通過丟例外 → 交易回滾 → **那筆稽核紀錄也跟著不見了**。
   最該被記下來的那一種事件，剛好是最容易記不下來的那一種。
   （如果你覺得這個情境很眼熟——沒錯，它是 03 章 3.5.6 那個問題的另一面。）

② `AuthenticationFailureBadCredentialsEvent` 裡，有使用者剛剛打錯的那個【明碼密碼】。
   而它的 toString() 印出來是 `Credentials=[PROTECTED]` —— 又一次「看起來被遮住」。
```
