# 第 05 章：JWT 認證

> 04 章結尾量了兩個數字，它們一起把這一章的存在理由講完了：
>
> ```
> 4.7.2   Basic + 無狀態 = 13 個/秒        —— 每個請求跑一次 BCrypt
> 4.3.3   expireNow() = 下一個請求就生效   —— 但那需要伺服器【記得】每一個 session
> ```
>
> 前者太慢，後者要狀態。**JWT 想同時擺脫這兩件事**：
>
> ```
> 每個請求便宜   驗一次簽章（本章實測 0.024 ms），不查資料庫、不跑 BCrypt
> ＋ 無狀態      伺服器不用記住任何 session，水平擴展免費
> ```
>
> ⚠️ **而它付出的代價，正好是 04 章最後一節的那一格**：
>
> | | Session（04 章） | JWT（這一章） |
> |---|---|---|
> | 立刻撤銷一個人 | ✅ `expireNow()`（4.3.3） | 🔴 **做不到**——token 發出去就在外面了 |
>
> 這一章的主線，就是**在「便宜又無狀態」與「撤得掉」之間，一步一步把代價補回來**。
>
> 📌 **這一章有二十三個實測。** 其中六個值得先劇透：
>
> ```
> 5.2.1  payload 是【明文】——把密碼放進去，攻擊者一行 base64 -d 就讀出來
> 5.2.6  RS256→HS256 金鑰混淆：驗證方【相信 token 自己說的 alg】就被拿下
> 5.3.2  一個沒有 exp 的 token —— io.jsonwebtoken 不會因為你漏了它而報錯
> 5.5.2  把權限從 DB 拔掉，同一個 token【照樣 200】—— 對照 4.3.3 的 session 立刻擋下
> 5.5.3  同一支 /api/me：JWT 版 2322 個/秒、Basic 版 13 個/秒 —— 差【178 倍】
> 5.6.3  攻擊者重用偷來的 refresh token —— 整條 family 被撤銷，逼真正的使用者重登
> ```
>
> ⚠️ **這一章有一個貫穿全章的判準**（延續 04 章 4.5.1）：
>
> > **JWT 把「身分」從伺服器搬到了 token 裡。**
> > 好處全部來自這件事（無狀態、便宜），
> > 壞處也全部來自這件事（撤不掉、是快照、放錯地方就外洩）。
> > 每一節其實都在回答同一個問題：**「這份搬出去的身分，出事了怎麼辦？」**

---

## 5.1 學習目標與實驗環境

完成本章後，你應該可以：

- 把一個 JWT 拆成三段，說出每一段是什麼，並解釋**為什麼 payload 不能放機敏資料**（5.2.1）。
- 說明簽章保護的是**完整性不是機密性**，並示範改一個字元後簽章驗不過（5.2.2）。
- 比較 HS256 / RS256 / ES256 的簽發成本、驗證成本與金鑰模型，並說出**對外服務為什麼要用非對稱**（5.2.3）。
- 重現並擋下三個經典攻擊：`alg:none`、短金鑰、RS256→HS256 金鑰混淆（5.2.4～5.2.6）。
- 寫一個簽發 access token 的 `JwtService`，並說出**放進 payload 的每一個 claim 各是為了什麼**（5.3.1）。
- 解釋一個**沒有過期時間**的 token 為什麼等於「永遠不會失效的密碼」（5.3.2）。
- 說明時鐘誤差（clock skew）會造成什麼、容錯值該設多少（5.3.3）。
- 寫一個自訂的 `JwtAuthenticationFilter`，並說出它該放在 Filter 鏈的**哪一個位置、為什麼**（5.4.1、5.4.2）。
- 說明驗證失敗時 Filter **該做什麼、不該做什麼**（清 context 往下走，而不是自己回應或 throw）（5.4.3）。
- 用 Spring 內建的 `oauth2ResourceServer` 達到同樣效果，並指出**覆寫 `authenticationManager` 會踩的坑**（5.4.4）。
- 端到端跑一次登入 → 帶 token → 打受保護端點，並量出 JWT 版的吞吐量（5.5.1、5.5.3）。
- 示範「把權限從 DB 拔掉，舊 token 照樣通過」，並說出這是**快照**的必然結果（5.5.2）。
- 設計 access + refresh 雙 token，並實作 **rotation 與重用偵測**（5.6）。
- 比較三種撤銷做法（jti 黑名單 / token 版本號 / 短命 + refresh）的代價，並各實作一個（5.7）。
- 檢查一份 JWT 設定是否有常見漏洞（5.8、5.9）。

### 5.1.1 本章的實驗環境

**這一章的每一個數字都在同一台機器上跑出來的**（跟前四章同一台）：

| 項目 | 版本 |
|---|---|
| Spring Boot | 3.2.5 |
| Spring Security | 6.2.4 |
| JJWT（io.jsonwebtoken） | 0.12.5 |
| JDK | Temurin 21.0.5 |
| MySQL | 8.0.46（02 章 2.1.1 那個容器，繼續用） |
| 機器 | Apple M2 / macOS 14.2.1（8 顆邏輯核心） |

**① 新增一個相依：JJWT。** 這一章用 `io.jsonwebtoken`（社群最常用、預設就安全的一個）：

```xml
<!-- pom.xml：JWT 的簽發與驗證 -->
<dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-api</artifactId><version>0.12.5</version></dependency>
<dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-impl</artifactId><version>0.12.5</version><scope>runtime</scope></dependency>
<dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-jackson</artifactId><version>0.12.5</version><scope>runtime</scope></dependency>

<!-- 5.4.4 對照組會用到 Spring 內建的 resource server -->
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-oauth2-resource-server</artifactId></dependency>
```

> ⚠️ **JJWT 0.11 → 0.12 的 API 改了很多**（`parserBuilder()` → `parser()`、`setSubject()` → `subject()`…）。
> 網路上很多範例還是 0.11 的，照抄會編不過。本章全部用 0.12.5。

**② 資料庫沿用前四章，但這一章加三樣東西**（撤銷與 refresh 要用）：

```sql
-- ① access token 的撤銷（5.7.3 做法二：版本號）
ALTER TABLE app_user ADD COLUMN token_version INT NOT NULL DEFAULT 0;

-- ② refresh token（5.6）—— 只存雜湊，不存原文
CREATE TABLE refresh_token (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,      -- SHA-256(原文)；DB 外洩也拿不到原文
  user_id    BIGINT   NOT NULL,
  family_id  CHAR(36) NOT NULL,             -- 5.6.3：同一條「換發鏈」共用一個 family
  issued_at  DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL,              -- 用過就記上時間；又被用到 = 被偷了
  revoked_at DATETIME(3) NULL,
  KEY idx_family (family_id), KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ③ access token 的撤銷（5.7.2 做法一：jti 黑名單）
CREATE TABLE revoked_jti (
  jti        CHAR(36) PRIMARY KEY,
  revoked_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL           -- token 本來就會過期，過期後就不用再記
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

> ⚠️ 灌 SQL 時記得 `--default-character-set=utf8mb4`（08 站踩過的坑，中文 display_name 才不會變亂碼）。

**帳號沿用 03 章 3.1.1 的五個**（這一章用得到「同角色」與「權限差異」）：

```
帳號     角色        這一章為什麼需要他
──────────────────────────────────────────────────
alice   MEMBER     主角：登入、被撤銷、refresh
bob     MEMBER     跟 alice 同角色（對照用）
cs      CS_AGENT   客服，有部分權限
admin   ADMIN      權限最多 —— 5.5.2 要看「權限被拔掉」的效果
```

**③ 一個 JWT 解剖器 `TokenScope`。** 這一章大量在「把 token 拆開看」，所以先做一個工具。
⚠️ **它刻意【不驗簽章】**——因為 5.2.1 要證明的就是「任何人都讀得到 payload」。

```java
package com.example.lab09.ch05;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 05 章的新工具：JWT 解剖器。
 *
 * 它【不驗簽章】—— 這是刻意的：5.2.1 要證明的就是「任何人都讀得到 payload」。
 * 同時它會對六種常見的危險設定發警告，用法跟前幾章的 reporter 一樣：
 * 把你自己系統發出來的 token 貼進來，看它印什麼。
 */
public final class TokenScope {

    private static final ObjectMapper M = new ObjectMapper();
    private static final DateTimeFormatter T =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault());

    private TokenScope() {}

    /** 只做 Base64URL 解碼 —— 不需要金鑰、不需要任何函式庫 */
    public static String decode(String segment) {
        return new String(Base64.getUrlDecoder().decode(segment), StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> json(String segment) {
        try { return M.readValue(decode(segment), Map.class); }
        catch (Exception e) { throw new IllegalArgumentException("不是合法的 JSON：" + decode(segment), e); }
    }

    public static void dump(String title, String token) {
        System.out.println("\n── " + title + " ──");
        String[] p = token.split("\\.", -1);
        System.out.println("   長度 " + token.length() + " 位元組，切成 " + p.length + " 段"
                + "（" + p[0].length() + " / " + p[1].length() + " / "
                + (p.length > 2 ? p[2].length() : 0) + "）");

        Map<String, Object> header = json(p[0]);
        Map<String, Object> payload = json(p[1]);
        System.out.println("   header  : " + decode(p[0]));
        System.out.println("   payload : " + decode(p[1]));
        System.out.println("   signature(Base64URL): "
                + (p.length > 2 && !p[2].isEmpty() ? p[2].substring(0, Math.min(24, p[2].length())) + "…" : "（空的）"));

        for (String k : List.of("iat", "nbf", "exp")) {
            Object v = payload.get(k);
            if (v instanceof Number n)
                System.out.println("   " + k + " = " + n.longValue() + "  → " + T.format(Instant.ofEpochSecond(n.longValue())));
        }
        warn(header, payload, token);
    }

    /** 六個警告。⚠️ 它們是【提示】不是保證 —— 真正的驗證在 JwtWiringReporter（5.1.2）。 */
    private static void warn(Map<String, Object> header, Map<String, Object> payload, String token) {
        List<String> w = new ArrayList<>();
        Object alg = header.get("alg");
        if ("none".equals(alg))        w.add("🔴 alg=none —— 這個 token 沒有簽章（5.2.4）");
        if (!payload.containsKey("exp")) w.add("🔴 沒有 exp —— 這是一把永遠有效的鑰匙（5.3.2）");
        else if (payload.get("exp") instanceof Number n) {
            long days = (n.longValue() - Instant.now().getEpochSecond()) / 86400;
            if (days > 7) w.add("🔴 exp 在 " + days + " 天後 —— 外洩了就是 " + days + " 天（5.3.2）");
        }
        if (!payload.containsKey("jti")) w.add("⚠️ 沒有 jti —— 要做黑名單撤銷時沒有東西可以當 key（5.7.2）");
        if (!payload.containsKey("iss")) w.add("⚠️ 沒有 iss —— 驗證方無法區分「誰發的」（5.8.2）");
        for (String k : payload.keySet())
            if (k.toLowerCase().contains("password") || k.toLowerCase().contains("secret")
                || k.toLowerCase().contains("card") || k.toLowerCase().contains("ssn"))
                w.add("🔴 payload 有 `" + k + "` —— payload 是【明文】，任何人都讀得到（5.2.1）");
        if (token.length() > 4096) w.add("🔴 token " + token.length() + " 位元組 —— 接近 / 超過多數伺服器的標頭上限（5.8.3）");

        if (w.isEmpty()) System.out.println("   ✅ 沒有發現這六項常見問題");
        else w.forEach(s -> System.out.println("   " + s));
    }
}
```

**這一章的實驗變體用 profile 隔離**（延續前四章的慣例，00 章 0.3.0.1）：

```
jwt          全章共用（PasswordEncoder、Ch05Users、AuthenticationManager）
j1           標準：HS256 + 15 分鐘 + 有 exp，Filter 放對位置
j2           🔴 沒設 exp（5.3.2）
j3           access token 短命 + refresh token（5.6）
j4           token 版本號撤銷（5.7.3）
j5           jti 黑名單撤銷（5.7.2）
jrs          用 Spring 內建 oauth2ResourceServer（5.4.4）
jreport      JWT 設定報表（5.1.2，實驗專案專用）
```

> 📌 **讀者自己的專案只有一組設定，不需要這樣切**。這些 profile 是為了「把好的寫法與壞的寫法放在一起對照」。

### 5.1.2 一個新工具：JWT 設定報表

04 章的 `SessionWiringReporter` 回答「身分存在哪裡、CSRF 開著沒」。
這一章的問題不一樣了——身分現在存在 **token** 裡，所以要問的是：
**token 怎麼驗？撤不撤得掉？** `JwtWiringReporter` 就是逐條 chain 回答這兩個問題。

```java
package com.example.lab09.ch05;

import jakarta.servlet.Filter;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Profile;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/**
 * 5.1.2 的新工具：JWT 設定報表。
 * 對照 04 章 4.1.2 的 SessionWiringReporter —— 那份看「身分存在哪裡」，這份看「token 怎麼驗、撤不撤得掉」。
 *
 * 啟動時對每一條 chain 印出：
 *   - 身分載體是什麼（自訂 JWT filter / Spring 內建 BearerToken / 其他）
 *   - 有沒有接撤銷機制（5.7）
 *   - 三個常見的設定錯誤警告
 */
@Component
@Profile("jreport")   // ← 實驗專案專用；讀者的專案寫 @Profile("!prod")
public class JwtWiringReporter implements ApplicationListener<ApplicationReadyEvent> {

    private final FilterChainProxy proxy;
    private final Optional<TokenRevocation> revocation;

    public JwtWiringReporter(FilterChainProxy proxy, Optional<TokenRevocation> revocation) {
        this.proxy = proxy; this.revocation = revocation;
    }

    @Override public void onApplicationEvent(ApplicationReadyEvent e) { print(); }

    public void print() {
        System.out.println("\n──────── JWT 設定（每條 chain）────────");
        int i = 0;
        for (SecurityFilterChain chain : proxy.getFilterChains()) {
            List<Filter> fs = chain.getFilters();
            boolean customJwt   = has(fs, "JwtAuthenticationFilter");
            boolean bearerToken = has(fs, "BearerTokenAuthenticationFilter");
            boolean basic       = has(fs, "BasicAuthenticationFilter");
            boolean form        = has(fs, "UsernamePasswordAuthenticationFilter");
            boolean csrf        = fs.stream().anyMatch(CsrfFilter.class::isInstance);
            boolean revoke      = revocation.isPresent() && revocation.get() != TokenRevocation.NONE;

            System.out.printf("chain[%d]  %s%n", i++,
                    chain instanceof org.springframework.security.web.DefaultSecurityFilterChain d
                            ? d.getRequestMatcher() : "?");
            System.out.println("   身分載體 = " + carrier(customJwt, bearerToken, basic, form));
            System.out.println("   CSRF     = " + (csrf ? "開啟" : "關閉"));
            System.out.println("   撤銷機制 = " + (revoke ? revocation.get().getClass().getSimpleName() : "無（token 發出去就撤不掉，5.7.1）"));

            boolean jwt = customJwt || bearerToken;
            // ── 三個警告 ──
            if (jwt && csrf)
                System.out.println("   ⚠️ token 靠 Authorization 標頭攜帶，CSRF 開著只是製造摩擦（4.5.1）——"
                        + "除非你把 token 放進 cookie（那才是真的要開 CSRF，4.5.2）");
            if (jwt && !revoke)
                System.out.println("   ⚠️ 沒有撤銷機制：停用帳號 / 收回權限要等 token 過期才生效（5.5.2）"
                        + " —— access token 請設短命 + refresh（5.6）");
            if (customJwt && bearerToken)
                System.out.println("   🔴 同一條 chain 同時有自訂 JWT filter 與內建 BearerToken —— 會驗兩次，挑一個");
        }
        System.out.println("──────────────────────────────────────\n");
    }

    private static String carrier(boolean customJwt, boolean bearer, boolean basic, boolean form) {
        if (customJwt) return "自訂 JwtAuthenticationFilter（5.4.2）";
        if (bearer)    return "Spring 內建 BearerTokenAuthenticationFilter（5.4.4）";
        if (basic)     return "HTTP Basic（04 章的舊寫法，每次跑 BCrypt）";
        if (form)      return "表單登入 + session（後台網頁那條）";
        return "（看不出來）";
    }

    private static boolean has(List<Filter> fs, String simpleName) {
        return fs.stream().anyMatch(f -> f.getClass().getSimpleName().equals(simpleName));
    }
}
```

**啟動後（`j1`，標準 JWT 但還沒接撤銷）印出**：

```
──────── JWT 設定（每條 chain）────────
chain[0]  Or [Mvc [pattern='/api/**'], Mvc [pattern='/error']]
   身分載體 = 自訂 JwtAuthenticationFilter（5.4.2）
   CSRF     = 關閉
   撤銷機制 = 無（token 發出去就撤不掉，5.7.1）
   ⚠️ 沒有撤銷機制：停用帳號 / 收回權限要等 token 過期才生效（5.5.2） —— access token 請設短命 + refresh（5.6）
──────────────────────────────────────
```

**接上版本號撤銷之後（`j4`）**，那個警告就消失了：

```
chain[0]  Or [Mvc [pattern='/api/**'], Mvc [pattern='/error']]
   身分載體 = 自訂 JwtAuthenticationFilter（5.4.2）
   CSRF     = 關閉
   撤銷機制 = TokenVersionRevocation
```

> 📌 **這份報表會在 5.9 的 shop-service 落地時，變成四個啟動檢查裡的第五個。**
> 它現在還印不出很多東西（因為我們還沒開始寫 Filter）——**這一章接下來每加一塊，就回來看它多印了什麼。**

---

## 5.2 JWT 的結構：簽章、Base64，與三個攻擊

在寫任何簽發 / 驗證的程式碼之前，先把一個 token 拆開看清楚。
**這一節的每一個攻擊，都是因為有人沒搞懂「JWT 到底保護了什麼」。**

一句話先講在前面：

```
簽章保護的是【完整性】（沒被改過），不是【機密性】（沒被看過）。
```

### 5.2.1 實測：把一個 token 拆開

先簽一個最普通的 token，然後只用 Base64URL 把它解回來：

```java
package com.example.lab09.ch05;

import com.example.lab09.ch05.TokenScope;
import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.*;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class JwtAnatomyTest {

    /** 一把夠長的 HS256 金鑰（≥256 bit）—— 5.2.5 會示範太短會發生什麼事 */
    static final SecretKey KEY = Keys.hmacShaKeyFor(
            "這是一把長度足夠的示範金鑰-至少要有三十二個位元組才行".getBytes(StandardCharsets.UTF_8));

    static String token;

    @Test @Order(1)
    void a_anatomy() {
        System.out.println("\n═══ 5.2.1 把一個 token 拆開 ═══");
        token = Jwts.builder()
                .subject("alice")
                .claim("displayName", "愛麗絲")
                .claim("roles", java.util.List.of("ROLE_MEMBER"))
                .issuer("shop-service")
                .id("f3a1c9e2")
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + 900_000))
                .signWith(KEY)
                .compact();
        System.out.println("\n完整 token：");
        System.out.println(token);
        String[] p = token.split("\\.");
        System.out.println("\n三段（用 . 隔開）：");
        System.out.println("  [1] header    " + p[0]);
        System.out.println("  [2] payload   " + p[1]);
        System.out.println("  [3] signature " + p[2]);
        System.out.println("\n★ 只用 Base64URL 解碼，不需要金鑰：");
        System.out.println("  header  → " + TokenScope.decode(p[0]));
        System.out.println("  payload → " + TokenScope.decode(p[1]));
        TokenScope.dump("TokenScope 的報告", token);
    }
}
```

**輸出**：

```
═══ 5.2.1 把一個 token 拆開 ═══

完整 token：
eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJhbGljZSIsImRpc3BsYXlOYW1lIjoi5oSb6bqX57WyIiwicm9sZXMiOlsiUk9MRV9NRU1CRVIiXSwiaXNzIjoic2hvcC1zZXJ2aWNlIiwianRpIjoiZjNhMWM5ZTIiLCJpYXQiOjE3ODkzNjYxMDAsImV4cCI6MTc4OTM2NzAwMH0.Y6-1FeaeKDxhHXzOy9cuRc1beV1C9BMrBFIvN9TRKG_TaD56iF8x1p10AO6CjZnCx29b65RugYdgb4ZcleIA0Q

三段（用 . 隔開）：
  [1] header    eyJhbGciOiJIUzUxMiJ9
  [2] payload   eyJzdWIiOiJhbGljZSIsImRpc3BsYXlOYW1lIjoi5oSb6bqX57WyIiwicm9sZXMiOlsiUk9MRV9NRU1CRVIiXSwiaXNzIjoic2hvcC1zZXJ2aWNlIiwianRpIjoiZjNhMWM5ZTIiLCJpYXQiOjE3ODkzNjYxMDAsImV4cCI6MTc4OTM2NzAwMH0
  [3] signature Y6-1FeaeKDxhHXzOy9cuRc1beV1C9BMrBFIvN9TRKG_TaD56iF8x1p10AO6CjZnCx29b65RugYdgb4ZcleIA0Q

★ 只用 Base64URL 解碼，不需要金鑰：
  header  → {"alg":"HS512"}
  payload → {"sub":"alice","displayName":"愛麗絲","roles":["ROLE_MEMBER"],"iss":"shop-service","jti":"f3a1c9e2","iat":1789366100,"exp":1789367000}
```

三段，用 `.` 隔開：

```
header      {"alg":"HS512"}                     用什麼演算法簽的
payload     {"sub":"alice", ...}                 宣稱（claims）—— 你是誰、有什麼權限、什麼時候過期
signature   Y6-1FeaeKDxhHXz...                   用金鑰對「header.payload」算出來的 HMAC / 簽章
```

> 🤔 **等一下，header 說 `HS512`，我沒有指定啊？**
> 對，`signWith(KEY)` 會**根據金鑰長度自動選演算法**——我給的示範金鑰很長，它就挑了 HS512。
> **這個行為 5.2.3 會展開**，而且會告訴你為什麼**正式程式碼要把演算法寫死**。

**這一節最重要的一件事，全部在這一行輸出裡**：

```
★ 只用 Base64URL 解碼，不需要金鑰：
  payload → {"sub":"alice","displayName":"愛麗絲",...}
```

**payload 是 Base64URL 編碼的，不是加密的。** 任何拿到 token 的人——
瀏覽器、代理伺服器、log 檔、瀏覽器歷史紀錄——都能讀出裡面每一個字。

#### 有人把密碼放進 payload

這是新手最常見的錯誤：以為 payload「看起來是亂碼」就很安全。

```java
    @Test @Order(2)
    void b_leak() {
        System.out.println("\n═══ 5.2.1b 有人把密碼放進 payload ═══");
        String bad = Jwts.builder()
                .subject("alice")
                .claim("password", "pw")
                .claim("creditCardNo", "4111-1111-1111-1111")
                .expiration(new Date(System.currentTimeMillis() + 900_000))
                .signWith(KEY).compact();
        System.out.println("攻擊者【不需要金鑰】，一行指令就讀出來：");
        System.out.println("  $ echo '" + bad.split("\\.")[1] + "' | base64 -d");
        System.out.println("  " + TokenScope.decode(bad.split("\\.")[1]));
        TokenScope.dump("TokenScope 的報告", bad);
    }
```

**輸出**：

```
═══ 5.2.1b 有人把密碼放進 payload ═══
攻擊者【不需要金鑰】，一行指令就讀出來：
  $ echo 'eyJzdWIiOiJhbGljZSIsInBhc3N3b3JkIjoicHciLCJjcmVkaXRDYXJkTm8iOiI0MTExLTExMTEtMTExMS0xMTExIiwiZXhwIjoxNzg5MzY3MDAwfQ' | base64 -d
  {"sub":"alice","password":"pw","creditCardNo":"4111-1111-1111-1111","exp":1789367000}

── TokenScope 的報告 ──
   ...
   🔴 payload 有 `password` —— payload 是【明文】，任何人都讀得到（5.2.1）
   🔴 payload 有 `creditCardNo` —— payload 是【明文】，任何人都讀得到（5.2.1）
```

> 📌 **payload 只放「公開了也沒關係」的東西**：使用者 id、角色、過期時間。
> **不要放**：密碼、信用卡、身分證字號、任何你不想印在 log 上的東西。
> 真的需要藏，那是 **JWE（加密的 JWT）**，不是這一章的 JWS，而且多數情況你其實不需要它。

### 5.2.2 實測：改一個字元會怎樣

既然 payload 是明文，那我把 `"alice"` 改成 `"admin"`，是不是就變管理員了？
**簽章就是為了擋這件事。**

```java
    @Test @Order(3)
    void c_tamper() {
        System.out.println("\n═══ 5.2.2 改一個字元會怎樣 ═══");
        String[] p = token.split("\\.");
        String tamperedPayload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                TokenScope.decode(p[1]).replace("\"alice\"", "\"admin\"").getBytes(StandardCharsets.UTF_8));

        System.out.println("① 原本的 payload : " + TokenScope.decode(p[1]));
        System.out.println("② 改成           : " + TokenScope.decode(tamperedPayload));

        String forged = p[0] + "." + tamperedPayload + "." + p[2];     // 簽章原封不動貼回去
        System.out.println("\n③ 把【原本的簽章】原封不動貼回去，然後拿去驗：");
        try {
            Jwts.parser().verifyWith(KEY).build().parseSignedClaims(forged);
            System.out.println("   🔴 驗過了 ——（不該發生）");
        } catch (JwtException e) {
            System.out.println("   ✅ " + e.getClass().getSimpleName());
            System.out.println("      " + e.getMessage().split("\n")[0]);
        }

        System.out.println("\n④ 但是 TokenScope 照樣讀得到（它不驗簽章）：");
        System.out.println("   " + TokenScope.decode(forged.split("\\.")[1]));
        System.out.println("\n★ 結論：簽章保護的是【完整性】，不是【機密性】。");
    }
```

**輸出**：

```
═══ 5.2.2 改一個字元會怎樣 ═══
① 原本的 payload : {"sub":"alice",...}
② 改成           : {"sub":"admin",...}

③ 把【原本的簽章】原封不動貼回去，然後拿去驗：
   ✅ SignatureException
      JWT signature does not match locally computed signature. JWT validity cannot be asserted and should not be trusted.

④ 但是 TokenScope 照樣讀得到（它不驗簽章）：
   {"sub":"admin",...}

★ 結論：簽章保護的是【完整性】，不是【機密性】。
```

**兩件事同時成立**：

```
② 改 payload           → 做得到（明文，誰都能改）
③ 讓改過的 token 通過驗證 → 做不到（沒有金鑰，簽章對不上）
```

攻擊者可以把 `alice` 改成 `admin`，但**只要他沒有金鑰，就算不出對應的新簽章**——
驗證方一算，發現 header.payload 算出來的簽章跟第三段對不上，直接拒絕。

> ⚠️ **這裡有一個關鍵前提：驗證方【真的算了】那個簽章。**
> 5.2.4 和 5.2.6 兩個攻擊，本質都是「騙驗證方不要算」或「用錯的東西去算」。

### 5.2.3 實測：`signWith(key)` 到底選了哪個演算法

回到 5.2.1 那個「我沒指定卻變成 HS512」的疑問。JJWT 0.12 會**根據金鑰長度自動挑演算法**：

```java
    @Test @Order(1)
    void a_whichAlgDidJjwtPick() {
        System.out.println("\n═══ 5.2.3a signWith(key) 到底選了哪個演算法 ═══");
        System.out.println("金鑰長度               jjwt 0.12 自己選的 alg     token 長度");
        System.out.println("──────────────────────────────────────────────────────────");
        for (int bytes : new int[]{32, 48, 64, 80}) {
            byte[] raw = new byte[bytes];
            java.util.Arrays.fill(raw, (byte) 'k');
            String t = Jwts.builder().subject("alice")
                    .expiration(new Date(System.currentTimeMillis() + 900_000))
                    .signWith(Keys.hmacShaKeyFor(raw)).compact();
            System.out.printf("  %2d 位元組（%3d bit）   →   %-8s              %3d 位元組%n",
                    bytes, bytes * 8, TokenScope.json(t.split("\\.")[0]).get("alg"), t.length());
        }
        System.out.println("\n★ 它【不是】固定 HS256 —— 給多長的金鑰就用多強的演算法。");
        System.out.println("  要指定就寫出來：.signWith(key, Jwts.SIG.HS256)");
    }
```

**輸出**：

```
═══ 5.2.3a signWith(key) 到底選了哪個演算法 ═══
金鑰長度               jjwt 0.12 自己選的 alg     token 長度
──────────────────────────────────────────────────────────
  32 位元組（256 bit）   →   HS256                 108 位元組
  48 位元組（384 bit）   →   HS384                 129 位元組
  64 位元組（512 bit）   →   HS512                 151 位元組
  80 位元組（640 bit）   →   HS512                 151 位元組

★ 它【不是】固定 HS256 —— 給多長的金鑰就用多強的演算法。
  要指定就寫出來：.signWith(key, Jwts.SIG.HS256)
```

> 📌 **正式程式碼一定要把演算法寫死**：`.signWith(key, Jwts.SIG.HS256)`。
> 原因不只是「可預期」——5.2.6 會示範，**驗證方如果不寫死接受哪個演算法，會被降級攻擊拿下**。

#### 三種演算法的三個數字

HS256 是**對稱**的（簽和驗用同一把金鑰）；RS256 / ES256 是**非對稱**的（私鑰簽、公鑰驗）。
差別不只是「安不安全」，還有**成本**與**誰能拿到什麼金鑰**：

```java
    @Test @Order(2)
    void b_compare() {
        System.out.println("\n═══ 5.2.3b HS256 / RS256 / ES256 的四個數字 ═══");
        Date exp = new Date(System.currentTimeMillis() + 900_000);

        SecretKey hs = Keys.hmacShaKeyFor("0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8));
        KeyPair rsa = Jwts.SIG.RS256.keyPair().build();
        KeyPair ec  = Jwts.SIG.ES256.keyPair().build();
        // ... 各簽發 / 驗證 N 次取平均（完整程式碼見 lab09 AlgorithmTest）...
    }
```

**輸出**（同一台 M2）：

```
═══ 5.2.3b HS256 / RS256 / ES256 的四個數字 ═══
演算法                     token            簽發            驗證   金鑰
──────────────────────────────────────────────────────────────────────────
HS256（對稱）               108 B      0.023 ms      0.024 ms   簽/驗同一把
RS256（RSA 2048）         407 B      0.909 ms      0.052 ms   私鑰簽 / 公鑰驗
ES256（P-256）            151 B      0.142 ms      0.421 ms   私鑰簽 / 公鑰驗

★ 對照 04 章 4.7.2 的 BCrypt：一次驗證 76.9 ms（13 個/秒）。
```

| | HS256（對稱） | RS256 / ES256（非對稱） |
|---|---|---|
| 金鑰 | **一把**，簽和驗都用它 | 私鑰簽、**公鑰**驗 |
| 誰能發 token | 任何拿到金鑰的服務 | 只有拿到**私鑰**的服務 |
| 誰能驗 token | 必須也給它金鑰（＝也能發！） | 只給**公鑰**，它能驗但**不能偽造** |
| 成本 | 最便宜（0.024 ms） | 簽較貴、驗仍便宜 |
| 什麼時候用 | **同一個團隊、同一個信任邊界**內 | **對外**、或**驗證方不該有簽發能力**時（06 章 Google 就是這樣） |

> 📌 **一句話決策**：
> **自家前後端、自己發自己驗 → HS256**（本章 shop-service 用這個）。
> **要把 token 發給第三方去驗，或驗證方不該能偽造 token → 非對稱**（RS256 / ES256）。
> 對照組：**BCrypt 一次 76.9 ms**——JWT 的 0.024 ms 就是 05 章存在的第一個理由。

### 5.2.4 🔴 實測：`alg:none` 攻擊

RFC 7519 允許一種「不簽章」的 JWT（`alg:none`）。攻擊者的如意算盤是：
**把 header 改成 `{"alg":"none"}`、把簽章刪掉，驗證方會不會就不驗了？**

```java
    @Test @Order(1)
    void a_algNone() {
        System.out.println("\n═══ 5.2.4 alg:none 攻擊 ═══");
        String header  = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"sub\":\"admin\",\"roles\":[\"ROLE_ADMIN\"]}".getBytes(StandardCharsets.UTF_8));
        String forged  = header + "." + payload + ".";      // ★ 第三段【空的】

        System.out.println("攻擊者自己組一個沒有簽章的 token：");
        System.out.println("  " + forged);

        System.out.println("\n拿去給【正確設定】的 parser 驗：");
        try {
            Jwts.parser().verifyWith(KEY).build().parseSignedClaims(forged);
            System.out.println("  🔴 過了 ——（不該發生）");
        } catch (JwtException e) {
            System.out.println("  ✅ 擋下來了：" + e.getClass().getSimpleName());
            System.out.println("     " + e.getMessage().split("\n")[0]);
        }
    }
```

**輸出**：

```
═══ 5.2.4 alg:none 攻擊 ═══
攻擊者自己組一個沒有簽章的 token：
  eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiIsInJvbGVzIjpbIlJPTEVfQURNSU4iXX0.

拿去給【正確設定】的 parser 驗：
  ✅ 擋下來了：UnsupportedJwtException
     Unsecured JWSs (those with an 'alg' (Algorithm) header value of 'none') are disallowed by default
     as mandated by https://www.rfc-editor.org/rfc/rfc7518.html#section-3.6. ...
```

**好消息**：`parseSignedClaims()` 預設就拒絕 `alg:none`。JJWT 把安全設成預設值。

> 🔴 **但是有兩種寫法會讓這個攻擊重新成立**：
> ```
> ① Jwts.parser().build().parse(token)   —— 不呼叫 verifyWith(...)，等於不驗簽章
> ② 自己 split(".") 讀 payload 就信      —— 5.8.1 會示範這種「土炮解析」的災難
> ```
> **教訓**：一定要用 `verifyWith(key).parseSignedClaims(token)`，而且**永遠不要相信沒驗過的 token**。

### 5.2.5 🔴 實測：金鑰太短

HS256 的金鑰就是「簽發能力」本身。金鑰太短 → 可以離線暴力破解 → 等於任何人都能發 token。
JJWT 直接不讓你用太短的金鑰簽：

```java
    @Test @Order(2)
    void b_weakKey() {
        System.out.println("\n═══ 5.2.5 金鑰太短 ═══");
        for (String secret : new String[]{"secret", "my-super-secret-key", "0123456789abcdef0123456789abcdef"}) {
            System.out.printf("%n金鑰 \"%s\"（%d 位元組 = %d bit）%n", secret, secret.length(), secret.length() * 8);
            try {
                Jwts.builder().subject("alice")
                        .expiration(new Date(System.currentTimeMillis() + 900_000))
                        .signWith(Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8)))
                        .compact();
                System.out.println("  ✅ 夠長，可以簽（≥256 bit）");
            } catch (io.jsonwebtoken.security.WeakKeyException e) {
                System.out.println("  🔴 " + e.getMessage().split("\n")[0]);
            }
        }
    }
```

**輸出**：

```
═══ 5.2.5 金鑰太短 ═══

金鑰 "secret"（6 位元組 = 48 bit）
  🔴 The specified key byte array is 48 bits which is not secure enough for any JWT HMAC-SHA algorithm. ...
     keys used with HMAC-SHA algorithms MUST have a size >= 256 bits ...

金鑰 "my-super-secret-key"（19 位元組 = 152 bit）
  🔴 The specified key byte array is 152 bits which is not secure enough ...

金鑰 "0123456789abcdef0123456789abcdef"（32 位元組 = 256 bit）
  ✅ 夠長，可以簽（≥256 bit）
```

> 📌 **金鑰要 ≥ 256 bit（32 位元組），而且要是真的隨機**，不是 `"my-super-secret-key"` 這種背得出來的字串。
> 產生一把：`openssl rand -base64 32`。**存進環境變數 / Secret Manager，不要寫死在程式碼或 git 裡。**

### 5.2.6 🔴 實測：RS256 → HS256 金鑰混淆

這是 JWT 最有名的攻擊，也是「**驗證方不能相信 token 自己宣稱的 alg**」的由來。

**場景**：系統用 RS256（公鑰是公開的，例如放在 `/.well-known/jwks.json`）。
攻擊者拿**公鑰的內容**當 HMAC 的密碼，簽一個 `alg:HS256` 的 token。
如果驗證方**照著 header 說的 alg 去驗**——看到 HS256 就用「金鑰」跑 HMAC，
而它手上的「金鑰」是那把公開的公鑰——**簽章就對上了**。

```java
    @Test @Order(3)
    void c_keyConfusion() throws Exception {
        System.out.println("\n═══ 5.2.6 RS256→HS256 金鑰混淆 ═══");
        KeyPair rsa = Jwts.SIG.RS256.keyPair().build();

        // 攻擊者：用公鑰的 bytes 當 HMAC 密碼，自己簽一個 HS256 的 admin token
        byte[] pubBytes = rsa.getPublic().getEncoded();
        String header  = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"HS256\"}".getBytes());
        String payload = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"sub\":\"admin\",\"roles\":[\"ROLE_ADMIN\"]}".getBytes());
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(pubBytes, "HmacSHA256"));           // 🔴 把公鑰當 HMAC 密碼
        String sig = Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8)));
        String forged = signingInput + "." + sig;

        System.out.println("① 天真的驗證方：只看 payload 說 alg 是什麼，就用什麼 ——");
        var claims = naiveVerifyByAlgInHeader(forged, rsa.getPublic().getEncoded());
        System.out.println("  🔴 驗過了！sub = " + claims);

        System.out.println("\n② 正確的驗證方：寫死「我只接受 RS256、只用這把公鑰」——");
        try {
            Jwts.parser().verifyWith(rsa.getPublic()).build().parseSignedClaims(forged);
            System.out.println("  🔴 過了 ——（不該發生）");
        } catch (JwtException e) {
            System.out.println("  ✅ 擋下來了：" + e.getClass().getSimpleName());
        }
    }

    // 模擬「相信 header 裡 alg」的錯誤驗證方
    private static String naiveVerifyByAlgInHeader(String token, byte[] rsaPublicKeyBytes) throws Exception {
        String[] p = token.split("\\.");
        String alg = (String) TokenScope.json(p[0]).get("alg");
        if (!"HS256".equals(alg)) throw new IllegalStateException("這個示範只處理被降級成 HS256 的情況");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(rsaPublicKeyBytes, "HmacSHA256"));  // 🔴 把公鑰當 HMAC 密碼
        String expected = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal((p[0] + "." + p[1]).getBytes(StandardCharsets.UTF_8)));
        if (!expected.equals(p[2])) throw new SecurityException("簽章不符");
        return (String) TokenScope.json(p[1]).get("sub");
    }
```

**輸出**：

```
═══ 5.2.6 RS256→HS256 金鑰混淆 ═══
系統用 RS256，公鑰是公開的（放在 /.well-known/jwks.json 之類的地方）：
  公鑰(DER) 前 40 字元 = MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC…

攻擊者用【公鑰的 bytes】當 HMAC 密碼，簽了一個 HS256 的 admin token。

① 天真的驗證方：只看 payload 說 alg 是什麼，就用什麼 ——
  🔴 驗過了！sub = admin

② 正確的驗證方：寫死「我只接受 RS256、只用這把公鑰」——
  ✅ 擋下來了：UnsupportedJwtException

★ 教訓：驗證方【不能相信 token 自己宣稱的 alg】。要寫死接受哪一個。
```

**為什麼 `verifyWith(publicKey)` 擋得住？**
因為你把公鑰交給 parser 時，JJWT 就知道「這是一把 RSA 公鑰」，
它只會用 RSA 演算法去驗——看到 header 說 HS256，型別對不上，直接 `UnsupportedJwtException`。
**是你（用金鑰的型別）決定用哪個演算法，不是 token。**

> 📌 **三個「不要相信 token」的鐵則**（5.2.4 + 5.2.6 的總結）：
> ```
> ① 不要用 parse()（不驗簽章）—— 要用 verifyWith(key).parseSignedClaims()
> ② 不要相信 header 裡的 alg —— 由你手上金鑰的型別決定
> ③ 不要自己 split(".") 讀 payload 就信 —— 那等於完全沒有驗證（5.8.1）
> ```

### 5.2.7 小結：payload 放什麼、不放什麼

把前六個實測濃縮成一張表——**這是你每次設計 payload 時要對一遍的清單**：

| claim | 放不放 | 為什麼 |
|---|---|---|
| `sub`（使用者 id / 帳號） | ✅ 放 | 驗證方要知道「你是誰」 |
| `iss`（簽發者） | ✅ 放 | 驗證方要能區分「誰發的」（5.8.2） |
| `exp`（過期時間） | ✅ **一定要放** | 沒有它 = 永遠有效的鑰匙（5.3.2） |
| `iat`（簽發時間） | ✅ 放 | 稽核、以及「iat 之前的 token 全撤」這種撤銷法要用 |
| `jti`（token 唯一 id） | ✅ 放 | 黑名單撤銷的 key（5.7.2） |
| 角色 / 權限 | ⚠️ 可放，但要知道是**快照** | 改權限不會即時生效（5.5.2） |
| 顯示用的暱稱 / 頭像 URL | ⚠️ 可放（省一次查詢），但會變舊 | 同上，是快照 |
| **密碼、信用卡、身分證** | 🔴 **絕對不放** | payload 是明文（5.2.1b） |
| 一大包使用者資料 | 🔴 不放 | token 會變很大，每個請求都在傳（5.8.3） |

---

## 5.3 簽發：登入換 token

現在把「拆 token」倒過來——**登入成功後，簽一個 token 發給前端**。
這一節的主角是 `JwtService`，它同時負責簽發與驗證（驗證在 5.4 的 Filter 裡呼叫）。

### 5.3.1 `JwtService`：簽發與驗證都在這裡

```java
package com.example.lab09.ch05;

import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * 05 章的核心：access token 的簽發與驗證。
 *
 * ★ 這一版是【對照組會用到的可調式版本】——
 *   正常設定就是安全的，但幾個 boolean 開關可以「故意寫壞」，好讓 5.3.2 / 5.8 的實測跑得出來。
 *   成品版（5.9 的 shop）不需要這些開關。
 */
public class JwtService {

    private final SecretKey key;
    private final String issuer;
    private final Duration ttl;
    private final Duration allowedSkew;

    /** 5.3.2 的開關：true = 故意不放 exp（一把永遠有效的鑰匙） */
    private final boolean omitExpiration;

    public JwtService(String secret, String issuer, Duration ttl, Duration allowedSkew, boolean omitExpiration) {
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.issuer = issuer;
        this.ttl = ttl;
        this.allowedSkew = allowedSkew;
        this.omitExpiration = omitExpiration;
    }

    /** 正常用法：HS256、15 分鐘、30 秒容錯、有 exp */
    public static JwtService standard(String secret) {
        return new JwtService(secret, "shop-service", Duration.ofMinutes(15), Duration.ofSeconds(30), false);
    }

    /** 簽發一個 access token。tokenVersion 是 5.7.3 的撤銷用的版本號。 */
    public String issue(UserDetails user, long userId, int tokenVersion) {
        Instant now = Instant.now();
        JwtBuilder b = Jwts.builder()
                .issuer(issuer)
                .subject(user.getUsername())
                .id(UUID.randomUUID().toString())                       // jti：5.7.2 黑名單的 key
                .claim("uid", userId)
                .claim("ver", tokenVersion)                             // 5.7.3：撤銷用
                .claim("authorities", user.getAuthorities().stream()
                        .map(GrantedAuthority::getAuthority).toList())  // ⚠️ 5.5.2：這是【登入當下的快照】
                .issuedAt(Date.from(now))
                .signWith(key, Jwts.SIG.HS256);                        // ★ 寫死 HS256（5.2.6 的教訓）
        if (!omitExpiration)                                            // 🔴 5.3.2：關掉就沒有 exp
            b.expiration(Date.from(now.plus(ttl)));
        return b.compact();
    }

    /** 驗證並回傳 claims。任何問題都會拋 JwtException —— 由 Filter 決定怎麼處理（5.4.3）。 */
    public Jws<Claims> verify(String token) {
        return Jwts.parser()
                .verifyWith(key)
                .requireIssuer(issuer)                                  // 5.8.2：連 iss 一起驗
                .clockSkewSeconds(allowedSkew.toSeconds())             // 5.3.3
                .build()
                .parseSignedClaims(token);
    }
}
```

**這個類別把 5.2 的每一個教訓都寫進去了**：

```
.signWith(key, Jwts.SIG.HS256)   把演算法寫死（5.2.3、5.2.6）
if (!omitExpiration) .expiration  一定有 exp（除非故意關掉來做 5.3.2）
.id(UUID)                         每個 token 有 jti，撤銷才有 key（5.7.2）
verifyWith(key)                   用金鑰型別決定演算法，不看 header（5.2.6）
requireIssuer(issuer)             連「誰發的」一起驗（5.8.2）
clockSkewSeconds                  容忍時鐘誤差（5.3.3）
```

> ⚠️ **為什麼 `authorities` 放進 payload？** 這樣每個請求驗完簽章就知道權限，**不用再查資料庫**——
> 這正是 JWT 便宜的原因。**代價**是它變成「登入當下的快照」，5.5.2 會用實測讓你看到這件事的後果。

### 5.3.2 🔴 實測：一個沒有過期時間的 token

`io.jsonwebtoken` **不會**因為你忘了設 `exp` 而報錯。漏掉它，你就發出了一把永遠有效的鑰匙：

```java
    @Test @Order(1)
    void a_noExpiry() {
        System.out.println("\n═══ 5.3.2 一個沒有過期時間的 token ═══");
        String noExp = Jwts.builder().subject("alice").issuer("shop-service")
                .signWith(KEY, Jwts.SIG.HS256).compact();      // ★ 完全沒呼叫 .expiration(...)

        System.out.println("① 沒呼叫 .expiration() —— 編譯、簽發都【不會】報錯：");
        System.out.println("   payload = " + TokenScope.decode(noExp.split("\\.")[1]));

        System.out.println("\n② 拿去驗，過不過？");
        var claims = Jwts.parser().verifyWith(KEY).requireIssuer("shop-service").build()
                .parseSignedClaims(noExp).getPayload();
        System.out.println("   ✅ 過了。exp = " + claims.getExpiration() + "（null = 永不過期）");

        System.out.println("\n③ TokenScope 的報告：");
        TokenScope.dump("沒有 exp 的 token", noExp);
    }
```

**輸出**：

```
═══ 5.3.2 一個沒有過期時間的 token ═══
① 沒呼叫 .expiration() —— 編譯、簽發都【不會】報錯：
   payload = {"sub":"alice","iss":"shop-service"}

② 拿去驗，過不過？
   ✅ 過了。exp = null（null = 永不過期）

③ TokenScope 的報告：

── 沒有 exp 的 token ──
   長度 113 位元組，切成 3 段（20 / 48 / 43）
   header  : {"alg":"HS256"}
   payload : {"sub":"alice","iss":"shop-service"}
   🔴 沒有 exp —— 這是一把永遠有效的鑰匙（5.3.2）
   ⚠️ 沒有 jti —— 要做黑名單撤銷時沒有東西可以當 key（5.7.2）

★ 這跟「一個永遠不會失效的密碼」是同一個東西 —— 外洩 = 帳號永久被拿走。
```

**同樣的道理，一個「五年後才過期」的 token 也不會有任何警告**：

```java
    @Test @Order(2)
    void b_fiveYears() {
        System.out.println("\n═══ 5.3.2b 五年後才過期 ═══");
        Instant exp = Instant.now().plus(Duration.ofDays(365 * 5));
        String longLived = Jwts.builder().subject("alice").issuer("shop-service")
                .expiration(Date.from(exp)).signWith(KEY, Jwts.SIG.HS256).compact();
        System.out.println("設 exp = " + java.time.LocalDate.now().plusYears(5) + " —— API 一聲不吭就簽了。");
        TokenScope.dump("五年 token", longLived);
    }
```

**輸出**：

```
═══ 5.3.2b 五年後才過期 ═══
設 exp = 2031-09-14 —— API 一聲不吭就簽了。

── 五年 token ──
   payload : {"sub":"alice","iss":"shop-service","exp":1947046701}
   exp = 1947046701  → 2031-09-13 14:18:21
   🔴 exp 在 1825 天後 —— 外洩了就是 1825 天（5.3.2）
```

> 📌 **這就是為什麼要有 refresh token（5.6）**：
> **access token 設短命**（15 分鐘），外洩了損害有上限；
> **refresh token 設長命**（14 天）但**可以撤銷**（存在資料庫、用一次換一張）。
> 你不用在「安全（短命）」和「不用一直登入（長命）」之間二選一——雙 token 兩邊都要。

### 5.3.3 實測：時鐘誤差（clock skew）

兩台伺服器的時鐘不可能一模一樣。如果簽發方的時鐘比驗證方快幾秒，
一個「剛簽好」的 token 到了驗證方那裡可能**看起來還沒生效**，或一個「剛過期」的被過度嚴格地拒絕。
`clockSkewSeconds` 就是容忍這個誤差：

```java
    @Test @Order(3)
    void c_clockSkew() {
        System.out.println("\n═══ 5.3.3 時鐘誤差（clock skew）═══");
        String justExpired = Jwts.builder().subject("alice").issuer("shop-service")
                .expiration(Date.from(Instant.now().minusSeconds(20)))   // 20 秒前就過期了
                .signWith(KEY, Jwts.SIG.HS256).compact();

        System.out.println("② 容錯 0 秒的 parser：");
        try {
            Jwts.parser().verifyWith(KEY).clockSkewSeconds(0).build().parseSignedClaims(justExpired);
        } catch (ExpiredJwtException e) {
            System.out.println("   🔴 ExpiredJwtException —— 兩台機器時鐘差幾秒，使用者就被登出");
        }
        System.out.println("\n③ 容錯 30 秒的 parser（我們 JwtService 的預設）：");
        try {
            Jwts.parser().verifyWith(KEY).clockSkewSeconds(30).build().parseSignedClaims(justExpired);
            System.out.println("   ✅ 過了 —— 20 秒 < 30 秒的容錯範圍");
        } catch (ExpiredJwtException e) {
            System.out.println("   過期");
        }
    }
```

**輸出**：

```
═══ 5.3.3 時鐘誤差（clock skew）═══
① 一個【20 秒前】就過期的 token。

② 容錯 0 秒的 parser：
   🔴 ExpiredJwtException —— 兩台機器時鐘差幾秒，使用者就被登出

③ 容錯 30 秒的 parser（我們 JwtService 的預設）：
   ✅ 過了 —— 20 秒 < 30 秒的容錯範圍

★ 容錯不是越大越好：它等於「過期後還能再用 N 秒」。30～60 秒是常見值。
```

> ⚠️ **容錯是有代價的**：它等於「token 過期後還能再用 N 秒」。
> 設 30～60 秒是合理的；設 3600 秒就等於把過期時間偷偷延長了一小時。**能用 NTP 同步時鐘就先同步。**

### 5.3.4 access token 該設多久

沒有標準答案，但有一個**思考框架**（延續 5.3.2、5.7.1 的邏輯）：

```
access token 的壽命 = 你能忍受「外洩後被濫用」多久
                    = 你「撤銷」機制的反應時間下限

  沒有撤銷機制（5.7.1）     → 壽命就是唯一的防線 → 設短（5～15 分鐘）
  有版本號 / 黑名單（5.7）   → 可以設長一點，但每個請求要查一次狀態（又有狀態了）
  有 refresh（5.6）         → access 設短（15 分鐘），靠 refresh 無痛續期
```

| 場景 | access token | refresh token |
|---|---|---|
| 一般 Web / App | 15 分鐘 | 7～14 天，rotation |
| 高敏感（金流、後台） | 5 分鐘 | 1 天，且重要操作要 step-up（04 章 4.6.3） |
| Server 對 Server | 依 API 呼叫頻率，通常 5～60 分鐘 | 通常不用 refresh，直接重新申請 |

> 📌 **本章 shop-service 用 15 分鐘 access + 14 天 refresh**，是最常見的一組。

---

## 5.4 驗證：自訂 `JwtAuthenticationFilter`

簽發解決了「怎麼發」，現在解決「每個請求進來，怎麼認出它是誰」。
答案是一個 **Filter**——放進 01 章那條 Filter 鏈的正確位置。

### 5.4.1 這個 Filter 要放在鏈的哪一個位置

回顧 01 章：請求穿過一長串 Filter，其中兩個關鍵是——

```
UsernamePasswordAuthenticationFilter   處理表單登入（POST /login 帳密）
AuthorizationFilter                     鏈的最後，決定「這個身分能不能進」
```

我們的 JWT Filter 要做的是「**從 Authorization 標頭認出身分，塞進 SecurityContext**」。
它必須放在 `AuthorizationFilter` **之前**（不然授權時還沒有身分），
而慣例是放在 `UsernamePasswordAuthenticationFilter` **之前**：

```
        ┌─ JwtAuthenticationFilter      ← 我們加的：帶 token 的請求在這裡就認出身分了
        ├─ UsernamePasswordAuthenticationFilter
        ├─ ...
        └─ AuthorizationFilter          ← 這時 SecurityContext 已經有身分了
```

> 📌 **為什麼放在帳密 Filter【之前】？** 因為 API 是無狀態的、根本沒有表單登入。
> 放在前面，帶 token 的請求認出身分後就一路往下，**完全不會碰到表單 / Basic 的邏輯**。

### 5.4.2 Filter 的骨架

```java
package com.example.lab09.ch05;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jws;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 5.4.2 的自訂驗證 Filter。放在 UsernamePasswordAuthenticationFilter 之前（5.4.1）。
 *
 * ★ 三條規則（都對照 01～02 章的 Filter 骨架）：
 *   1. 沒有 Authorization 標頭 → 什麼都不做，往下走（讓後面的規則決定 401）。
 *   2. token 驗過了 → 塞進 SecurityContext。
 *   3. 🔴 token 驗不過 → 不要 throw、不要自己回應：清掉 context、往下走【變匿名】（5.4.3 會解釋為什麼）。
 */
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    public static final String PREFIX = "Bearer ";
    private final JwtService jwt;
    private final TokenRevocation revocation;    // 5.7：可為 null（對照組用）

    public JwtAuthenticationFilter(JwtService jwt, TokenRevocation revocation) {
        this.jwt = jwt;
        this.revocation = revocation;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {

        String header = req.getHeader("Authorization");
        if (header == null || !header.startsWith(PREFIX)) {          // 規則 1
            chain.doFilter(req, res);
            return;
        }

        String token = header.substring(PREFIX.length());
        try {
            Jws<Claims> jws = jwt.verify(token);                     // 規則 2
            Claims c = jws.getPayload();

            if (revocation != null && revocation.isRevoked(c)) {     // 5.7：撤銷檢查
                throw new JwtException("token 已被撤銷 jti=" + c.getId());
            }

            @SuppressWarnings("unchecked")
            List<String> auths = c.get("authorities", List.class);
            var authorities = (auths == null ? List.<String>of() : auths).stream()
                    .map(SimpleGrantedAuthority::new).map(a -> (org.springframework.security.core.GrantedAuthority) a).toList();

            var authentication = new UsernamePasswordAuthenticationToken(c.getSubject(), null, authorities);
            authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(req));
            SecurityContextHolder.getContext().setAuthentication(authentication);

        } catch (JwtException e) {                                   // 規則 3
            SecurityContextHolder.clearContext();
            req.setAttribute("jwt.error", e.getMessage());          // 給 entry point 拿去印（5.4.3）
        }
        chain.doFilter(req, res);
    }
}
```

**跟 01～02 章的 Filter 骨架對照**：

```
繼承 OncePerRequestFilter            每個請求只跑一次（01 章 1.9 的坑：兩個同類別會共用旗標）
沒有標頭就 chain.doFilter 往下走      不是「沒帶 token = 擋下來」，而是「交給後面的規則決定」
驗過就塞進 SecurityContextHolder      跟表單登入成功後做的事一模一樣
setDetails(...)                       補上 IP / session id，稽核（08 章）要用
```

### 5.4.3 🔴 實測：驗證失敗時，Filter 該做什麼

規則 3 是最容易寫錯的地方。**新手常犯的兩個錯**：

```
錯誤 A：在 Filter 裡 res.setStatus(401); res.getWriter().write(...)
        → 你的 401 格式跟其他 Filter（授權失敗）的 401 格式不一樣，前端要處理兩種
錯誤 B：throw new RuntimeException(...)
        → 變成 500，而且把堆疊洩漏出去
```

**正確做法**：清掉 context、往下走，讓請求走到最後被 `AuthorizationFilter` 擋下來，
由**統一的 entry point** 產生 401。這樣「沒帶 token」「token 壞了」「token 過期」——
**全部同一個格式**。實測四種失敗：

```java
    @Test
    void fourKindsOfFailure() {
        try (Jwt lab = new Jwt("j1")) {
            System.out.println("\n═══ 5.4.3 驗證失敗的四種情況 ═══");
            System.out.println("\n① 完全沒有 Authorization 標頭：");
            print(lab.http.get("/api/me"));
            System.out.println("\n② 有標頭但不是 Bearer（Basic）：");
            print(lab.http.get("/api/me", "Authorization", "Basic YWxpY2U6cHc="));
            System.out.println("\n③ Bearer 但 token 是亂碼（not-a-jwt.xxx.yyy）：");
            print(lab.http.get("/api/me", "Authorization", "Bearer not-a-jwt.xxx.yyy"));
            System.out.println("\n④ Bearer 且格式對，但簽章被改過：");
            String t = lab.accessOf("alice", "pw");
            print(lab.withToken("GET", "/api/me", t.substring(0, t.length()-3) + "AAA", null));
        }
    }
    private static void print(java.net.http.HttpResponse<String> r) {
        System.out.println("   狀態 " + r.statusCode() + "  body=" + r.body());
    }
```

**輸出**：

```
═══ 5.4.3 驗證失敗的四種情況 ═══

① 完全沒有 Authorization 標頭：
   狀態 401  body={"error":"UNAUTHENTICATED","message":"需要登入"}

② 有標頭但不是 Bearer（Basic）：
   狀態 401  body={"error":"UNAUTHENTICATED","message":"需要登入"}

③ Bearer 但 token 是亂碼（not-a-jwt.xxx.yyy）：
   狀態 401  body={"error":"UNAUTHENTICATED","message":"Malformed protected header JSON: ..."}

④ Bearer 且格式對，但簽章被改過：
   狀態 401  body={"error":"UNAUTHENTICATED","message":"JWT signature does not match ..."}
```

四種都是 **401、同一個 entry point、同一個 JSON 格式**。差別只在 `message`——
而那是我們**刻意**從 `jwt.error` attribute 帶出來的（entry point 的程式碼在 5.4.4 之後、5.9 的 `ApiErrors`）。

> ⚠️ **上線前把 message 收斂成一句通用的。** 上面 ③④ 把 JJWT 的原始錯誤丟給了前端，
> 那對開發很方便，但對外會**洩漏你用什麼函式庫、版本**。
> 正式環境：`jwt.error` 只寫進**伺服器 log**，回給前端的固定是「請重新登入」。08 章的稽核會用到那份 log。

### 5.4.4 實測：用 `oauth2ResourceServer` 少寫一個 Filter

Spring Security 內建一條處理 Bearer token 的路：`oauth2ResourceServer`。
它自帶一個 `BearerTokenAuthenticationFilter`，你只要提供「怎麼解 token」就好——
**連 Filter 都不用自己寫**：

```java
    @Configuration @Profile("jrs")
    static class Jrs_ResourceServer {
        @Bean JwtService jwtService() { return JwtService.standard(SECRET); }   // 沿用同一把金鑰簽發

        @Bean JwtDecoder jwtDecoder() {
            SecretKeySpec key = new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(key)
                    .macAlgorithm(org.springframework.security.oauth2.jose.jws.MacAlgorithm.HS256).build();
            decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer("shop-service"));  // 連 iss 一起驗
            return decoder;
        }

        @Bean JwtAuthenticationConverter authConverter() {
            var granted = new JwtGrantedAuthoritiesConverter();
            granted.setAuthoritiesClaimName("authorities");   // ★ 我們的 claim 叫 authorities
            granted.setAuthorityPrefix("");                   // ★ 已經含 ROLE_ 前綴了，不要再加
            var conv = new JwtAuthenticationConverter();
            conv.setJwtGrantedAuthoritiesConverter(granted);
            return conv;
        }

        @Bean SecurityFilterChain chain(HttpSecurity http,
                                        JwtDecoder decoder, JwtAuthenticationConverter conv) throws Exception {
            return http
                    .securityMatcher("/api/**", "/error")
                    // ⚠️ 這裡【不能】呼叫 .authenticationManager(am)：
                    //    oauth2ResourceServer 會自己註冊一個 JwtAuthenticationProvider，
                    //    覆蓋掉就變成「只認得帳密、不認得 token」→ 每個帶 token 的請求都 401（5.4.4 踩過）
                    .authorizeHttpRequests(a -> a
                            .requestMatchers("/error", "/api/hello").permitAll()
                            .requestMatchers("/api/auth/**").permitAll()
                            .requestMatchers("/api/reports/**").hasAuthority("report:read")
                            .anyRequest().authenticated())
                    .sessionManagement(so -> so.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                    .csrf(AbstractHttpConfigurer::disable)
                    // ★ 一行取代整個自訂 Filter：
                    .oauth2ResourceServer(o -> o.jwt(j -> j.decoder(decoder).jwtAuthenticationConverter(conv)))
                    .exceptionHandling(e -> e
                            .authenticationEntryPoint(ApiErrors::write401)
                            .accessDeniedHandler(ApiErrors::write403))
                    .build();
        }
    }
```

**輸出**（`jrs`）：

```
═══ 5.4.4 用 oauth2ResourceServer 取代自訂 Filter ═══
① 這條 chain 上跟認證有關的 Filter：
   - BearerTokenAuthenticationFilter
   - AnonymousAuthenticationFilter
   - AuthorizationFilter
   ★ BearerTokenAuthenticationFilter 是 Spring 內建的 —— 我們沒有寫 JwtAuthenticationFilter

② 一樣的三個請求：
   不帶 token /api/me           → 401
   admin token /api/reports/sales → 200
   alice token /api/reports/sales → 403

③ 改一個字元的 token：
   → 401  Bearer error="invalid_token", error_description="An error occurred while attempting to decode the Jwt: Signed JWT rejected: Invalid signature", error_uri="https://tools.ietf.org/html/rfc6750#section-3.1"
```

🔴 **這一節踩到一個坑，值得單獨講**：

```java
// 我一開始在這條 chain 上也寫了 .authenticationManager(am)（跟 j1 一樣），
// 結果【每一個帶 token 的請求都 401】。
//
// 原因：oauth2ResourceServer().jwt() 會偷偷註冊一個 JwtAuthenticationProvider 到
//       這條 chain 的 AuthenticationManager 裡。你手動 .authenticationManager(am)
//       把它換成「只認得帳密的 ProviderManager」→ BearerToken 進來沒有 provider 能處理 → 401。
//
// 修法：這條 chain【不要】呼叫 .authenticationManager(...)，讓它自己建。
//       （/login 用的 am 是另外一個 bean，AuthController 直接注入，跟這條 chain 無關。）
```

**自己寫 vs 內建，怎麼選？**

| | 自訂 `JwtAuthenticationFilter`（5.4.2） | `oauth2ResourceServer`（5.4.4） |
|---|---|---|
| 程式碼量 | 多一個 Filter | 一行 `.oauth2ResourceServer(...)` |
| 撤銷（5.7） | 直接在 Filter 裡查（我們就是這樣） | 要另外接 `OpaqueTokenIntrospector` 或自訂 validator |
| 錯誤格式 | 完全自訂 | 標準 RFC 6750 的 `WWW-Authenticate` |
| claim 對應 | 自己讀 | `JwtAuthenticationConverter` 設定 |
| 什麼時候用 | 要細緻控制撤銷 / 錯誤（本章 shop 用這個） | 標準 OAuth2 場景、驗第三方的 token（**06 章就是這條路**） |

> 📌 **本章接下來仍以自訂 Filter 為主線**——因為 5.7 的撤銷要在 Filter 裡查狀態，自訂版接起來最直接。
> 但你要知道有內建這條路，**06 章驗 Google 發的 token 就會回來用它**。

---

## 5.5 完整跑一次

把 5.3（簽發）與 5.4（驗證）接起來，加上登入端點與受保護端點，端到端跑一遍。

**登入端點**（`/api/auth/login`）——帳密**只在這裡驗一次**，之後每個請求都只驗 token：

```java
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthenticationManager am;      // 02 章的 ProviderManager，只在 /login 用
    private final JwtService jwt;
    private final Ch05Users users;
    // ... refresh / versionRevocation 是 Optional，5.6 / 5.7 才接上 ...

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody LoginReq req) {
        try {
            am.authenticate(new UsernamePasswordAuthenticationToken(req.username(), req.password()));
        } catch (AuthenticationException e) {
            return ResponseEntity.status(401).body(Map.of("error", "BAD_CREDENTIALS"));  // ★ 帳密只在這裡驗一次
        }
        var user = (Ch05Users.AppUserDetails) users.loadUserByUsername(req.username());
        return ResponseEntity.ok(tokens(user));   // 簽 access（+ refresh，如果接上了）
    }
}
```

**受保護端點**：

```java
@RestController
public class Ch05Endpoints {

    @GetMapping("/api/me")                        // 需要登入（任何有效 token）
    public Map<String, Object> me() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return Map.of("name", a.getName(), "authorities", a.getAuthorities().toString());
    }

    @GetMapping("/api/reports/sales")             // 需要 report:read（chain 的規則擋）
    public Map<String, Object> report() { return Map.of("report", "2026-Q3", "total", 8_800_000); }
}
```

**把 Filter 接進一條無狀態 chain**：

```java
    static SecurityFilterChain apiChain(HttpSecurity http, AuthenticationManager am,
                                        JwtService jwt, TokenRevocation revocation) throws Exception {
        return http
                .securityMatcher("/api/**", "/error")
                .authenticationManager(am)
                .authorizeHttpRequests(a -> a
                        .requestMatchers("/error", "/api/hello").permitAll()
                        .requestMatchers("/api/auth/**").permitAll()             // 登入/refresh 不需要 token
                        .requestMatchers("/api/reports/**").hasAuthority("report:read")
                        .anyRequest().authenticated())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(AbstractHttpConfigurer::disable)                           // ✅ token 在標頭，不是 cookie（4.5.1）
                // ★ 5.4.1：放在帳密 Filter【之前】—— 帶 token 的請求根本不會走到表單/Basic
                .addFilterBefore(new JwtAuthenticationFilter(jwt, revocation),
                        UsernamePasswordAuthenticationFilter.class)
                .exceptionHandling(e -> e
                        .authenticationEntryPoint(ApiErrors::write401)
                        .accessDeniedHandler(ApiErrors::write403))
                .build();
    }
```

### 5.5.1 實測：端到端

```java
    @Test
    void endToEnd() {
        try (Jwt lab = new Jwt("j1")) {
            System.out.println("\n═══ 5.5.1 端到端：登入 → 帶 token → 打受保護端點 ═══");
            // ① 不帶 token → ② 登入 → ③ 帶 token → ④ 需要權限的端點 → ⑤ 改壞的 token → ⑥ 權限不足
            // 完整程式碼見 lab09 JwtFlowTest
        }
    }
```

**輸出**：

```
═══ 5.5.1 端到端：登入 → 帶 token → 打受保護端點 ═══

① 不帶 token 打 /api/me：
   狀態 401  body={"error":"UNAUTHENTICATED","message":"需要登入"}

② 登入（POST /api/auth/login，帳密只在這裡驗一次）：
   狀態 200

── 拿到的 access token ──
   長度 400 位元組，切成 3 段（20 / 335 / 43）
   header  : {"alg":"HS256"}
   payload : {"iss":"shop-service","sub":"admin","jti":"2571ab96-...","uid":6433,"ver":0,
              "authorities":["ROLE_ADMIN","order:read","order:read:all","order:refund",
              "order:delete","report:read","user:manage"],"iat":1789366650,"exp":1789367550}
   ✅ 沒有發現這六項常見問題

③ 帶 token 打 /api/me：
   狀態 200  body={"name":"admin","authorities":"[ROLE_ADMIN, order:read, ...]"}

④ 帶 token 打需要 report:read 的 /api/reports/sales：
   狀態 200  body={"report":"2026-Q3","total":8800000}

⑤ 把 token 改一個字元再打：
   狀態 401  body={"error":"UNAUTHENTICATED","message":"JWT signature does not match ..."}

⑥ 用 alice（沒有 report:read）打 /api/reports/sales：
   狀態 403  body={"error":"FORBIDDEN","message":"權限不足"}
```

**一次看懂五個狀態碼**：

```
① 401   沒帶 token          → 沒有身分
③ 200   帶對的 token        → 認出是 admin
④ 200   admin 有 report:read → 授權通過
⑤ 401   token 被改過        → 簽章驗不過（5.2.2 那一課）
⑥ 403   alice 沒有 report:read → 認證成功（401→200）但授權失敗（403）
```

> 📌 **⑥ 是 00 章 401 vs 403 的分界在 JWT 世界的樣子**：
> **401 = 我不知道你是誰**（沒 token / token 壞了）；**403 = 我知道你是誰，但你不能做這件事**。

### 5.5.2 🔴 實測：權限是登入當下的快照

這是 JWT 最重要、也最容易被忽略的一件事。token 的 `authorities` 是**登入那一刻**抄下來的，
之後**改資料庫不會影響已經發出去的 token**：

```java
    @Test
    void permissionsAreASnapshot() {
        try (Jwt lab = new Jwt("j1")) {          // j1 沒有撤銷機制（TokenRevocation.NONE）
            System.out.println("\n═══ 5.5.2 權限是登入當下的快照 ═══");

            System.out.println("\n① admin 登入，拿到 token（payload 裡帶著 report:read）：");
            String token = lab.accessOf("admin", "pw");
            System.out.println("   /api/reports/sales → " + lab.withToken("GET", "/api/reports/sales", token, null).statusCode());

            System.out.println("\n② 現在把 admin 的 report:read 權限從資料庫【拔掉】：");
            int n = lab.jdbc.update("""
                    DELETE rp FROM role_permission rp
                      JOIN app_role r ON r.id = rp.role_id
                      JOIN permission p ON p.id = rp.permission_id
                     WHERE r.code='ADMIN' AND p.code='report:read'""");
            System.out.println("   DELETE role_permission → 影響 " + n + " 列。");

            System.out.println("\n③ 用【同一個 token】再打一次：");
            System.out.println("   /api/reports/sales → " + lab.withToken("GET", "/api/reports/sales", token, null).statusCode());

            System.out.println("\n④ 重新登入，拿一個新的 token：");
            String fresh = lab.accessOf("admin", "pw");
            System.out.println("   /api/reports/sales → " + lab.withToken("GET", "/api/reports/sales", fresh, null).statusCode());
        }
    }
```

**輸出**：

```
═══ 5.5.2 權限是登入當下的快照 ═══

① admin 登入，拿到 token（payload 裡帶著 report:read）：
   /api/reports/sales → 200（200 = 進得去）

② 現在把 admin 的 report:read 權限從資料庫【拔掉】：
   DELETE role_permission → 影響 1 列。DB 裡 admin 已經沒有 report:read 了。

③ 用【同一個 token】再打一次：
   /api/reports/sales → 200  🔴 還是 200！
   原因：Filter 只看 token 裡的 authorities，【根本不查資料庫】。

④ 重新登入，拿一個新的 token：
   /api/reports/sales → 403  ✅ 403，新 token 才反映了新權限
```

**這不是 bug，是 JWT 的定義**：無狀態 = 不查資料庫 = 用 token 裡那份快照。
好處是快（5.5.3 會量），壞處就是**改權限不會即時生效**。

> 📌 **對照 04 章 4.3.3 的 session**：那裡 `expireNow()` 一呼叫，**下一個請求**就被擋下來了。
> 差別的根源在 04 章開頭那句話——**身分裝在什麼東西裡**：
> ```
> session：身分在伺服器 → 伺服器改一下，立刻生效
> JWT：   身分在 token   → token 在使用者手上，你改不到它，只能等它過期或撤銷（5.7）
> ```

### 5.5.3 🔴 實測：吞吐量——JWT vs Basic vs session

回到 04 章 4.7.2 那個把人嚇到的數字：Basic + 無狀態 = **13 個/秒**（每個請求跑一次 BCrypt）。
換成 JWT，同一支端點、同一台機器：

```java
    @Test
    void jwtVsBasic() throws Exception {
        try (Jwt lab = new Jwt("j1")) {
            System.out.println("\n═══ 5.5.3 吞吐量：JWT vs Basic vs session ═══");
            String token = lab.accessOf("alice", "pw");
            double jwt1 = bench(1, () -> lab.withToken("GET", "/api/me", token, null));
            double jwt8 = bench(8, () -> lab.withToken("GET", "/api/me", token, null));
            System.out.printf("   JWT（HS256 驗簽）  單執行緒 %,.0f 個/秒 ，8 執行緒 %,.0f 個/秒%n", jwt1, jwt8);
            // bench：固定時間內狂打，數 200 的次數。完整程式碼見 lab09 ThroughputTest
        }
    }
```

**輸出**：

```
═══ 5.5.3 吞吐量：JWT vs Basic vs session ═══
   暖身：/api/me → 200

   JWT（HS256 驗簽）  單執行緒 2,322 個/秒 ，8 執行緒 13,471 個/秒

   對照 04 章 4.7.2（同一台機器）：
     身分載體            單執行緒       說明
     ────────────────────────────────────────────
     Basic（每次 BCrypt）    13 個/秒    被 BCrypt 的 cost 釘死
     JWT（每次驗簽）      2322 個/秒    跟 session 同一個數量級
     session（查記憶體）  2344 個/秒    04 章 4.7.2 的基準
```

| 身分載體 | 單執行緒吞吐量 | 每個請求做什麼 | 有狀態？ |
|---|---|---|---|
| Basic（04 章） | **13 個/秒** | 一次 BCrypt（76.9 ms） | 無狀態 |
| **JWT（本章）** | **2322 個/秒** | 一次 HMAC 驗簽（0.024 ms） | ✅ 無狀態 |
| session（04 章） | 2344 個/秒 | 查一次記憶體 | 🔴 有狀態 |

**JWT 拿到了兩邊的好處**：跟 session 一樣快（差在誤差內），又跟 Basic 一樣無狀態。

```
Basic → JWT：13 → 2322 個/秒，快了【178 倍】—— 把「每個請求一次 BCrypt」換成「一次 HMAC」
JWT vs session：2322 vs 2344，同一個數量級 —— 但 JWT 不用伺服器記住任何東西
```

> ⚠️ **這兩欄的穩定性不一樣**（重跑會看到）：
> session / JWT 那欄會在 1200～2600 之間跳（受 GC、排程影響）；
> **Basic 那欄永遠被 BCrypt 的 cost 釘死在個位數**——因為那是 CPU 硬算，跟排程無關。
> 這正是 04 章 4.7.2 的重點：**BCrypt 的慢是設計出來的（擋暴力破解），不該放在每個請求的熱路徑上。**

**至此，05 章開頭那兩個問題解決了一個半**：

```
✅ 每個請求便宜   2322 個/秒（5.5.3）
✅ 無狀態         chain 是 STATELESS，伺服器不記 session
🔴 但是撤不掉     5.5.2 剛剛看到：改權限 / 停用帳號都要等 token 過期
```

**剩下的半個問題——「撤不掉」——就是 5.6 與 5.7 的全部內容。**

---

## 5.6 過期與 refresh token

5.3.4 講過取捨：**access token 要短命**（外洩損害有上限），
但短命會逼使用者一直重新登入。**refresh token 就是用來解這個矛盾的**：

```
access token    短命（15 分鐘）、無狀態、不能撤銷 —— 拿來打 API
refresh token   長命（14 天）、有狀態、可以撤銷 —— 只用來「換一張新的 access」
```

### 5.6.1 為什麼 refresh token 是【不透明字串】而不是 JWT

這是最關鍵的設計決定。refresh token **故意不做成 JWT**：

```
access token 是 JWT：要無狀態、要快、每個請求都驗 → 不查資料庫（快照的代價，5.5.2）
refresh token 不是 JWT：只在「換 token」時用一次 → 查資料庫沒關係，而且【就是要能查、能撤銷】
```

所以 refresh token 是一個**隨機字串**，資料庫記著它的狀態（用過沒、撤銷沒、屬於哪個 family）。
而且**資料庫只存雜湊**——就算 DB 外洩，攻擊者也沒有原文：

```java
package com.example.lab09.ch05;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * 5.6：refresh token。
 *
 * ★ 三個設計決定，每一個都對應一個實測：
 *   1. refresh token 是【不透明的隨機字串】，不是 JWT —— 因為它要能被查、被撤銷（5.6.1）。
 *   2. 資料庫只存【雜湊】，不存原文 —— 外洩 DB 不等於外洩所有人的 refresh token（5.6.2）。
 *   3. 用一次就換一張（rotation），舊的標記 used；舊的又被用到 = 偷竊，整個 family 撤銷（5.6.3）。
 */
public class RefreshTokenService {

    private final JdbcTemplate jdbc;
    private final Duration ttl;
    private final SecureRandom rnd = new SecureRandom();

    public RefreshTokenService(JdbcTemplate jdbc, Duration ttl) { this.jdbc = jdbc; this.ttl = ttl; }

    public record Issued(String rawToken, String familyId) {}

    /** 登入時發第一張，開一個新的 family */
    public Issued issueNew(long userId) { return insert(userId, UUID.randomUUID().toString()); }

    private Issued insert(long userId, String familyId) {
        String raw = randomToken();
        Instant now = Instant.now();
        jdbc.update("""
                INSERT INTO refresh_token (token_hash, user_id, family_id, issued_at, expires_at)
                VALUES (?,?,?,?,?)""",
                sha256(raw), userId, familyId, Timestamp.from(now), Timestamp.from(now.plus(ttl)));
        return new Issued(raw, familyId);
    }

    public record Rotated(long userId, Issued next) {}

    /**
     * 5.6.3 的核心：拿一張 refresh token 換一張新的 + 一個新的 access token。
     * 🔴 reuse detection：如果這張已經被用過（used_at 不是 null），代表它被偷了 ——
     *    把整個 family 撤銷，逼真正的使用者重新登入。
     */
    public Rotated rotate(String rawToken) {
        Map<String, Object> row;
        try {
            row = jdbc.queryForMap("""
                    SELECT id, user_id, family_id, expires_at, used_at, revoked_at
                      FROM refresh_token WHERE token_hash = ?""", sha256(rawToken));
        } catch (EmptyResultDataAccessException e) {
            throw new IllegalStateException("REFRESH_UNKNOWN");           // 根本沒發過這張
        }

        long id = ((Number) row.get("id")).longValue();
        long userId = ((Number) row.get("user_id")).longValue();
        String familyId = (String) row.get("family_id");

        if (row.get("revoked_at") != null) throw new IllegalStateException("REFRESH_REVOKED");
        if (toInstant(row.get("expires_at")).isBefore(Instant.now()))
            throw new IllegalStateException("REFRESH_EXPIRED");

        if (row.get("used_at") != null) {                                // 🔴 用過的又出現 = 被偷了
            revokeFamily(familyId);
            throw new IllegalStateException("REFRESH_REUSE_DETECTED");    // 5.6.3
        }

        jdbc.update("UPDATE refresh_token SET used_at = ? WHERE id = ?", Timestamp.from(Instant.now()), id);
        return new Rotated(userId, insert(userId, familyId));            // 同一個 family 續下去
    }

    public void revokeFamily(String familyId) {
        jdbc.update("UPDATE refresh_token SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
                Timestamp.from(Instant.now()), familyId);
    }

    /** 診斷用：某個 family 現在的狀態 */
    public List<Map<String, Object>> familyDump(String familyId) {
        return jdbc.queryForList("""
                SELECT id, LEFT(token_hash,8) AS hash8, used_at, revoked_at
                  FROM refresh_token WHERE family_id = ? ORDER BY id""", familyId);
    }

    private String randomToken() {
        byte[] b = new byte[32];
        rnd.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** MySQL DATETIME 經由 JDBC 可能回 Timestamp 或 LocalDateTime，兩種都吃 */
    private static Instant toInstant(Object o) {
        if (o instanceof Timestamp t) return t.toInstant();
        if (o instanceof java.time.LocalDateTime ldt) return ldt.atZone(java.time.ZoneId.systemDefault()).toInstant();
        throw new IllegalArgumentException("未知的時間型別：" + o.getClass());
    }

    static String sha256(String s) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte x : h) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) { throw new RuntimeException(e); }
    }
}
```

> 📌 **`token_hash CHAR(64) NOT NULL UNIQUE`**：我們比對的是 `sha256(rawToken)`，不是原文。
> 這跟 02 章「密碼要雜湊存」是同一個道理——**refresh token 也是一種憑證，DB 裡不該有原文。**
> （差別：密碼用 BCrypt 慢雜湊擋暴力破解；refresh token 是高熵隨機字串，SHA-256 就夠，不用慢雜湊。）

### 5.6.2 實測：refresh 流程

`j3` 這個情境故意把 access token 設成**只有 2 秒**，好讓我們看到「過期 → 換一張」的完整流程：

```java
    @Test @Order(1)
    void a_refreshFlow() throws Exception {
        try (Jwt lab = new Jwt("j3")) {              // j3：access token 只有 2 秒
            System.out.println("\n═══ 5.6.2 refresh 流程 ═══");
            HttpResponse<String> login = lab.login("alice", "pw");
            String access = Jwt.field(login.body(), "accessToken");
            String refresh = Jwt.field(login.body(), "refreshToken");

            System.out.println("② 立刻打 /api/me → " + lab.withToken("GET", "/api/me", access, null).statusCode());
            System.out.println("\n③ 等 3 秒讓 access token 過期…");
            Thread.sleep(3000);
            System.out.println("   打 /api/me → " + lab.withToken("GET", "/api/me", access, null).statusCode());

            System.out.println("\n④ 拿 refresh token 換一張新的 access（POST /api/auth/refresh）：");
            HttpResponse<String> refreshed = lab.http.send("POST", "/api/auth/refresh",
                    "{\"refreshToken\":\"" + refresh + "\"}", "Content-Type", "application/json");
            String newAccess = Jwt.field(refreshed.body(), "accessToken");
            System.out.println("   新 access → 打 /api/me = " + lab.withToken("GET", "/api/me", newAccess, null).statusCode());
        }
    }
```

**輸出**：

```
═══ 5.6.2 refresh 流程 ═══
① 登入拿到兩張：
   access  (JWT，2 秒後過期) = eyJhbGciOiJIUzI1NiJ9.eyJpc3MiO…
   refresh (不透明隨機字串)  = FaNRNzq-1C1z91mWz37jsGM2PpHmp0…

② 立刻打 /api/me → 200

③ 等 3 秒讓 access token 過期…
   打 /api/me → 401（401 = 過期了）

④ 拿 refresh token 換一張新的 access（POST /api/auth/refresh）：
   狀態 200
   新 access  → 打 /api/me = 200
   ★ 順便換了一張新的 refresh（rotation）：Yg1_-HWqtx800qzAy2QZkgjPUN8fOq…
   新 refresh 跟舊的一樣嗎？ false
```

**注意 ④ 的最後兩行**：換 access 的時候，**refresh 也換成了一張新的**——這叫 **rotation**。
舊的 refresh 被標記 `used`，下次不能再用。為什麼要這樣？下一節就是答案。

### 5.6.3 🔴 實測：refresh token 重用偵測

rotation 的真正價值：**如果一張已經用過的 refresh token 又被拿來換，那一定是被偷了。**
（正常使用者手上永遠只有最新的那一張；舊的被用到，代表有第二個人也有這條鏈。）

偵測到就把**整個 family 撤銷**——寧可讓真正的使用者重新登入一次，也不讓小偷繼續：

```java
    @Test @Order(2)
    void b_reuseDetection() {
        try (Jwt lab = new Jwt("j3")) {
            System.out.println("\n═══ 5.6.3 refresh token 重用偵測 ═══");
            HttpResponse<String> login = lab.login("alice", "pw");
            String r1 = Jwt.field(login.body(), "refreshToken");
            System.out.println("① 登入拿到 refresh #1");

            HttpResponse<String> use1 = lab.http.send("POST", "/api/auth/refresh",
                    "{\"refreshToken\":\"" + r1 + "\"}", "Content-Type", "application/json");
            String r2 = Jwt.field(use1.body(), "refreshToken");
            System.out.println("② 用 #1 換到 #2 —— #1 現在被標記 used");

            System.out.println("\n③ 攻擊者偷到了 #1，也拿去換 —— 但 #1 已經被用過了：");
            HttpResponse<String> attack = lab.http.send("POST", "/api/auth/refresh",
                    "{\"refreshToken\":\"" + r1 + "\"}", "Content-Type", "application/json");
            System.out.println("   狀態 " + attack.statusCode() + "  body=" + attack.body());

            System.out.println("\n④ 這一撤，連【真正使用者】手上的 #2 也一起失效（同一個 family）：");
            HttpResponse<String> victim = lab.http.send("POST", "/api/auth/refresh",
                    "{\"refreshToken\":\"" + r2 + "\"}", "Content-Type", "application/json");
            System.out.println("   #2 → 狀態 " + victim.statusCode() + "  body=" + victim.body());
        }
    }
```

**輸出**：

```
═══ 5.6.3 refresh token 重用偵測 ═══
① 登入拿到 refresh #1
② 用 #1 換到 #2（狀態 200）—— #1 現在被標記 used

③ 攻擊者偷到了 #1，也拿去換 —— 但 #1 已經被用過了：
   狀態 401  body={"error":"REFRESH_REUSE_DETECTED"}

④ 這一撤，連【真正使用者】手上的 #2 也一起失效（同一個 family）：
   #2 → 狀態 401  body={"error":"REFRESH_REVOKED"}
   ★ 這是刻意的：偵測到偷竊時，寧可讓真正的使用者重新登入一次。

⑤ 這個 family 的紀錄：
   {id=7, hash8=cb7e6a91, used_at=2026-09-14T14:22:02.619, revoked_at=2026-09-14T14:22:02.630}
   {id=8, hash8=e62ab896, used_at=null, revoked_at=2026-09-14T14:22:02.630}
```

**這個機制的美在於**：你不知道 ③ 和 ④ 誰是真正的使用者、誰是小偷——但**沒關係**。
只要「同一張 refresh 被用了兩次」，就代表這條鏈已經不安全了，**整條作廢、大家重登**最安全。

```
family（換發鏈）：  #1 → #2 → #3 → ...   每一張只能用一次，用完換下一張
偷竊的訊號：        #1 被用了第二次       → 一定有兩個人拿著這條鏈
反應：              整個 family 撤銷      → 小偷和使用者都被踢，使用者重登、拿一條新 family
```

> 📌 **這是 refresh token 相對「一張長命 access token」的核心優勢**：
> 長命 access token 外洩了，你**完全不知道**，而且撤不掉（5.7.1）；
> refresh token rotation 讓「外洩」變成一個**可偵測、可反應**的事件。

---

## 5.7 撤銷：JWT 最難的一塊

### 5.7.1 JWT 的根本問題

回到 05 章開頭那張表的那一格：

| | Session | JWT |
|---|---|---|
| 立刻撤銷一個人 | ✅ `expireNow()` | 🔴 **做不到** |

**為什麼做不到？** 因為 JWT 的整個賣點就是「無狀態、不查資料庫」。
token 一旦簽發，它就在使用者手上、在某個瀏覽器的 localStorage 裡、在某支 App 的 keychain 裡——
**你（伺服器）根本碰不到它**。它會一直有效，直到 `exp` 到期。

```
session：身分在伺服器 → 刪掉伺服器那份就撤銷了
JWT：   身分在 token   → token 不在伺服器，你能做的只有「下次它來的時候拒絕它」
```

**而「下次它來的時候拒絕它」，就需要伺服器記住「哪些 token 要拒絕」——這就把狀態加回來了。**
所以撤銷的每一種做法，本質都是「**放棄一部分無狀態，換回撤銷能力**」。差別只在放棄多少。

先定義一個介面，三種做法各實作它：

```java
package com.example.lab09.ch05;

import io.jsonwebtoken.Claims;

/** 5.7：怎麼讓一個【已經發出去】的 token 失效。三種做法各有一個實作。 */
public interface TokenRevocation {
    boolean isRevoked(Claims claims);

    /** 什麼都不做 —— 對照組（JWT 的預設行為就是「撤不掉」，5.7.1） */
    TokenRevocation NONE = c -> false;
}
```

（5.5.2 的 `j1` 用的就是 `NONE`——所以那裡改權限永遠不生效。）

### 5.7.2 三種做法的取捨

| 做法 | 記什麼 | 撤銷粒度 | 每個請求的成本 | 適合 |
|---|---|---|---|---|
| **① 短命 + refresh** | 只記 refresh（5.6） | 下次 refresh 時 | 0（access 不查） | 大多數情況的**第一選擇** |
| **② jti 黑名單** | 每一張被撤的 token | **單一 token** | 查一次黑名單 | 要「登出這一台裝置」 |
| **③ token 版本號** | 每個 user 一個整數 | 一個 user 的**全部** token | 查一次版本號 | 要「登出所有裝置」/ 停用帳號 |

**做法① 其實不是「撤銷 access token」**，而是「讓 access token 短命到不值得撤」：
access 15 分鐘就過期，撤銷 refresh 就好（refresh 本來就有狀態）。**最省，但有 15 分鐘的空窗。**

下面把 ② 和 ③ 各實作出來，因為它們示範了「重新引入狀態」的兩種粒度。

**做法③：token 版本號**（每個 user 一個整數，token 裡帶一份）：

```java
package com.example.lab09.ch05;

import io.jsonwebtoken.Claims;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 5.7.2 做法二：token 版本號。每個 user 一個整數 ver，token 裡帶一份。
 *   撤銷 = app_user.token_version + 1。舊 token 的 ver 對不上，全部一次失效。
 * ⚠️ 一樣是有狀態（每個請求查一次 ver），但它能做到 4.3.3 的「踢掉一個人所有裝置」——
 *   而且不用一個個記 jti。代價是【沒辦法只撤銷其中一個裝置】。
 */
public class TokenVersionRevocation implements TokenRevocation {

    private final JdbcTemplate jdbc;
    public TokenVersionRevocation(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public boolean isRevoked(Claims c) {
        Long uid = c.get("uid", Long.class);
        Integer tokenVer = c.get("ver", Integer.class);
        if (uid == null || tokenVer == null) return true;               // 沒帶 = 當作無效
        Integer current = jdbc.queryForObject(
                "SELECT token_version FROM app_user WHERE id = ?", Integer.class, uid);
        return current == null || !current.equals(tokenVer);            // 對不上 = 已撤銷
    }

    /** 踢掉某個人手上所有 token（對照 04 章 4.3.3 的 expireNow） */
    public void revokeAll(long userId) {
        jdbc.update("UPDATE app_user SET token_version = token_version + 1 WHERE id = ?", userId);
    }
}
```

**做法②：jti 黑名單**（記下每一張要撤的 token 的 jti）：

```java
package com.example.lab09.ch05;

import io.jsonwebtoken.Claims;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Instant;

/**
 * 5.7.2 做法一：黑名單。把要作廢的 token 的 jti 記下來，每個請求查一次。
 * ⚠️ 代價：又變成【有狀態】了 —— 每個請求都要查一次共享儲存（跟 session 一樣）。
 *   好處是只需要記「被撤銷的少數」，不是「所有活著的 token」。
 */
public class JtiBlacklist implements TokenRevocation {

    private final JdbcTemplate jdbc;
    public JtiBlacklist(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** 撤銷一個 token：記下它的 jti，直到它本來就會過期為止（過期後就不用記了） */
    public void revoke(String jti, Instant tokenExp) {
        jdbc.update("""
                INSERT INTO revoked_jti (jti, revoked_at, expires_at) VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE revoked_at = VALUES(revoked_at)""",
                jti, Timestamp.from(Instant.now()), Timestamp.from(tokenExp));
    }

    @Override
    public boolean isRevoked(Claims c) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM revoked_jti WHERE jti = ?", Integer.class, c.getId());
        return n != null && n > 0;
    }

    /** 定期清掉已經過期的 jti（過期的 token 本來就無效，不用再記） */
    public int purgeExpired() {
        return jdbc.update("DELETE FROM revoked_jti WHERE expires_at < ?", Timestamp.from(Instant.now()));
    }
}
```

> 📌 **黑名單只記「被撤的少數」，不是「所有活著的」**——這是它比 session 省的地方。
> 而且被撤的 token 過期後就可以從黑名單刪掉（`purgeExpired`），因為過期的 token 本來就無效。
> **實務上黑名單常放 Redis**（設 TTL = token 剩餘壽命，自動過期，連清理都省了）。

### 5.7.3 🔴 實測：版本號撤銷——立刻生效

`j4` 接上 `TokenVersionRevocation`。這一次，5.5.2 那個「改權限不生效」的問題有解了：

```java
    @Test @Order(1)
    void a_tokenVersion() {
        try (Jwt lab = new Jwt("j4")) {
            System.out.println("\n═══ 5.7.3 token 版本號撤銷 ═══");
            long uid = lab.uid("admin");
            String token = lab.accessOf("admin", "pw");
            System.out.println("① admin 登入（token 裡 ver=0）");
            System.out.println("   /api/me → " + lab.withToken("GET", "/api/me", token, null).statusCode());

            System.out.println("\n② 呼叫 logout-all（等於 04 章 4.3.3 的 kick）：");
            lab.http.send("POST", "/api/auth/logout-all", "{\"uid\":\"" + uid + "\"}", "Content-Type", "application/json");

            System.out.println("\n③ 用【同一個 token】再打（它的 ver 還是 0，DB 已經是 1）：");
            System.out.println("   /api/me → " + lab.withToken("GET", "/api/me", token, null).statusCode());
        }
    }
```

**輸出**：

```
═══ 5.7.3 token 版本號撤銷 ═══
① admin 登入（token 裡 ver=0）
   /api/me → 200

② 呼叫 logout-all（等於 04 章 4.3.3 的 kick）：
   {"revoked":"all-tokens-of-uid-6505"}  → app_user.token_version 變成 1

③ 用【同一個 token】再打（它的 ver 還是 0，DB 已經是 1）：
   /api/me → 401  body={"error":"UNAUTHENTICATED","message":"token 已被撤銷 jti=9de12085-..."}
   ✅ 立刻擋下來了 —— 對照 5.5.2 的 j1（沒有撤銷機制，永遠 200）

④ 重新登入拿新 token（ver=1）→ 200

★ 代價：每個請求多查一次 app_user.token_version（又有狀態了，但只查一個整數）。
```

**跟 5.5.2 對照著看，就是這一章的主線**：

```
5.5.2（j1，NONE）：   把權限拔掉 → 同一個 token 照樣 200 → 🔴 撤不掉
5.7.3（j4，版本號）：  呼叫撤銷   → 同一個 token 立刻 401 → ✅ 撤得掉

代價：j1 每個請求查 0 次資料庫；j4 每個請求查 1 次（token_version）。
     —— 這就是「用一部分無狀態，換回撤銷能力」的具體樣子。
```

**jti 黑名單（`j5`）的實測**則展示了另一種粒度——**只撤單一一張**：

```
═══ 5.7.2 jti 黑名單撤銷 ═══
① admin 登入，token 的 jti = f8d299f1-...
   /api/me → 200
② 把【這一張】token 的 jti 加進黑名單
③ 用這張 token 再打 → 401（被撤銷）
④ 但【重新登入】拿到的新 token（不同 jti）不受影響 → 200
```

### 5.7.4 對照 04 章 4.3.3 的 `expireNow()`

這一章開頭那格「JWT 撤不掉」，現在可以補完了：

| | Session（04 章 4.3.3） | JWT（本章 5.7） |
|---|---|---|
| 怎麼撤 | `SessionInformation.expireNow()` | 版本號 +1 / jti 進黑名單 |
| 撤銷後何時生效 | 下一個請求 | 下一個請求 |
| 記什麼 | 伺服器記著每一個 session | 記一個整數（版本號）或被撤的 jti |
| **代價** | 每個請求查一次 session store | 每個請求查一次版本號 / 黑名單 |
| 還算無狀態嗎 | ❌ 本來就有狀態 | ⚠️ **打了折的無狀態**——查一個整數，比查整包 session 輕 |

> 📌 **這就是全章的收束**：JWT 的「無狀態、便宜」不是免費的午餐。
> 一旦你需要**立刻撤銷**，就得把一部分狀態加回來——差別只在你加回來的是
> 「一整包 session」（04 章）還是「一個整數」（5.7.3）。
> **能接受 15 分鐘空窗的話，做法①（短命 + refresh）最省，連那個整數都不用查。**

**shop-service 的選擇**（5.9 會落地）：

```
access token   15 分鐘 + token 版本號（停用帳號 / 收回權限要立刻生效 → 用做法③）
refresh token  14 天 + rotation + reuse detection（5.6）
「登出所有裝置」 = token_version + 1（一次撤全部）
```

---

## 5.8 常見錯誤用法

5.2 講了三個攻擊（`alg:none`、短金鑰、金鑰混淆），那些是「別人怎麼攻你」。
這一節講「你自己怎麼把門打開」——三個最常見的自殘寫法。

### 5.8.1 🔴 自己 `split(".")` 讀 payload 就信

這是所有 JWT 錯誤裡最嚴重的一個：**根本沒有驗證**。
有人覺得「我只是要拿 payload 裡的 userId，不用那麼麻煩」，於是：

```java
    @Test @Order(1)
    void a_diyParsing() {
        // 攻擊者自己組一個 admin token，簽章亂填
        String forged = header + "." + payload + ".AAAAAAAAAAAAAAAAAAAAAA";   // payload = {"sub":"admin",...}

        System.out.println("① 土炮解析：直接 split，讀 payload 就當真");
        String[] p = forged.split("\\.");
        String sub = (String) TokenScope.json(p[1]).get("sub");
        System.out.println("   → 這個「使用者」= " + sub);
    }
```

**輸出**：

```
═══ 5.8.1 土炮解析（split 就信）═══
① 土炮解析：直接 split，讀 payload 就當真
   → 這個「使用者」= admin  🔴 攻擊者直接變 admin（完全沒驗簽章）

② 正確做法：verifyWith(key).parseSignedClaims()
   ✅ SignatureException —— 簽章對不上，擋下來
```

**土炮解析 = 把 5.2.2 的簽章保護整個丟掉。** payload 是明文，攻擊者想寫什麼寫什麼。
**永遠用 `verifyWith(key).parseSignedClaims(token)`**，哪怕你只想拿一個 userId。

### 5.8.2 不驗 `iss`：別的系統的 token 也放進來

很多公司多個服務**共用一把 JWT 金鑰**（本身就不太好，但很常見）。
如果驗證方不檢查 `iss`，那 A 服務簽的 token 可以拿去打 B 服務：

```java
    @Test @Order(2)
    void b_issuer() {
        String otherSystem = Jwts.builder().subject("admin").issuer("some-other-app")
                .expiration(...).signWith(KEY, Jwts.SIG.HS256).compact();

        System.out.println("① 不驗 iss 的 parser：");
        var c1 = Jwts.parser().verifyWith(KEY).build().parseSignedClaims(otherSystem).getPayload();
        System.out.println("   ✅ 接受了 —— iss=" + c1.getIssuer());
    }
```

**輸出**：

```
═══ 5.8.2 不驗 iss 的後果 ═══
① 不驗 iss 的 parser：
   ✅ 接受了 —— iss=some-other-app  🔴 別的系統的 token 也能進

② requireIssuer("shop-service") 的 parser：
   ✅ IncorrectClaimException —— iss 對不上，擋下來
```

> 📌 **`requireIssuer(...)` 是一行的事**（我們的 `JwtService.verify()` 已經有了）。
> 更好的做法是**每個服務用自己的金鑰**——但只要有共用金鑰的可能，就一定要驗 `iss`。
> 同理還有 `audience`（`aud`，這個 token 是發給哪個服務用的），對外場景（06 章）會用到。

### 5.8.3 payload 塞太多：token 撐爆標頭

token 每個請求都在 `Authorization` 標頭裡傳。有人把「整包使用者資料」都塞進 payload
（想省後端一次查詢），結果 token 大到超過伺服器的標頭上限：

```java
    @Test @Order(3)
    void c_tokenSize() {
        String small = Jwts.builder().subject("alice").issuer("shop-service").expiration(...).signWith(...).compact();
        // 塞 200 個權限字串 + 一包 profile
        String fat = Jwts.builder()....claim("permissions", 兩百個權限).claim("profile", 一大包).compact();
    }
```

**輸出**：

```
═══ 5.8.3 payload 塞太多，token 變多大 ═══
① 只放必要 claim         → 136 位元組
② 塞 200 個權限 + 一包 profile → 7869 位元組

★ token 每個請求都在 Authorization 標頭裡傳。
  多數伺服器 / 反向代理的標頭上限是 8 KB（Nginx 預設 large_client_header_buffers 8k）——
  一超過，使用者會收到 431 或 400，而且很難查。payload 要瘦。
```

**7869 位元組已經逼近 8 KB**——再多幾個權限就會撐爆。而且症狀很難查：
不是每個請求都爆（權限少的使用者沒事），只有權限多的（例如 admin）才爆，
而且錯誤發生在**反向代理**而不是你的應用，log 裡什麼都看不到。

> 📌 **payload 只放 id 和「粗粒度」的角色，不放細粒度的權限清單。**
> 需要細粒度授權時，用角色去查權限（03 章的 RBAC），而不是把幾百個權限塞進 token。
> 對照 5.2.7 那張「放什麼」的表——**能不放就不放，token 越小越好。**

### 5.8.4 其他三個一句話帶過的坑

```
🔴 access token 放進 localStorage → XSS 一旦得手就能讀走它（04 章 4.5 的 cookie 對照）
     → 折衷：access 放記憶體變數、refresh 放 HttpOnly cookie（但那樣 refresh 就要處理 CSRF，4.5.2）
🔴 把 access token 也放進 cookie → CSRF 重新成立（4.5.2 實測過）—— 除非配 SameSite + CSRF token
🔴 對外服務用【對稱】金鑰簽發給第三方 → 等於把簽發能力送出去（5.2.3）—— 對外一定用非對稱
```

> ⚠️ **「JWT 存哪裡」沒有完美解**，這是前端安全的經典難題（04 章 4.5 已經鋪陳過）。
> 常見折衷：**access token 存在 JavaScript 變數（記憶體，關頁面就沒了）**，
> **refresh token 存在 `HttpOnly` + `Secure` + `SameSite=Strict` 的 cookie**，
> refresh 端點因此要處理 CSRF。細節屬於前端，這裡只點出「放 localStorage 最省事但最不安全」。

---

## 5.9 shop-service 落地

04 章 4.8 的 shop-service 留了一個 🔴：

```
🔴 API 用 HTTP Basic —— 每個請求跑一次 BCrypt（4.7.2 量到 13 個/秒）  → 05 章換 JWT
```

這一章就把它換掉。**API chain 的每一個設計，5.7.3 的 `j4` 已經端到端驗過了**
（STATELESS + JWT filter + 版本號撤銷 + `report:read` 規則），這裡是把它組進 shop 的形狀。

> 📌 **這一節的四個新類別，本質就是把 5.3～5.7 的 `ch05` 元件搬進 `shop` 套件、換上正式的名字。**
> 差別只有：金鑰從環境變數讀、`ShopUserDetails` 多帶一個 `tokenVersion`、撤銷路徑接進 04 章的 `ShopSessionAdmin`。

**① 金鑰從環境變數讀，不寫死**（5.2.5 的教訓）：

```yaml
# application.yml —— 本機開發用；正式環境用真正的 Secret Manager
shop:
  jwt:
    secret: ${JWT_SECRET:请用-openssl-rand-base64-32-產生一把至少32位元組的隨機金鑰}
    access-ttl: 15m
    refresh-ttl: 14d
```

**② `ShopUserDetails` 多帶 `tokenVersion`**（撤銷要用，5.7.3）：

⚠️ **這取代 04 章 4.8 的同名 record**（04 章那版已經把 `equals`/`hashCode` 改成只比 `userId`）。
只多一個欄位 `tokenVersion`，以及查詢多讀一個 `token_version` 欄位：

```java
public record ShopUserDetails(Long userId, String username, String password, String displayName,
                              boolean enabled, boolean accountNonExpired, boolean accountNonLocked,
                              boolean credentialsNonExpired, int tokenVersion,      // ★ 05 章多的
                              List<GrantedAuthority> grantedAuthorities) implements UserDetails {
    // getAuthorities / getPassword / ... 同 04 章
    @Override public boolean equals(Object o) {                       // 04 章 4.3.2：只比 userId
        return o instanceof ShopUserDetails other && java.util.Objects.equals(userId, other.userId);
    }
    @Override public int hashCode() { return java.util.Objects.hashCode(userId); }
}
```

**③ `ShopAuthzConfig` 的 API chain：Basic → JWT**

⚠️ **這取代 04 章 4.8 的同名類別**（同名 bean，兩個一起留著會 `BeanDefinitionOverrideException`）。
**只有 apiChain 改了**——web chain（後台網頁那條，session + CSRF）**一個字都不動**：

```java
@Configuration
@EnableMethodSecurity
public class ShopAuthzConfig {

    // web chain 的 SessionRegistry / HttpSessionEventPublisher 照 04 章 4.8，不變

    @Bean JwtService jwtService(@Value("${shop.jwt.secret}") String secret) {
        return JwtService.standard(secret);                    // HS256、15 分鐘、有 exp、驗 iss（5.3.1）
    }
    @Bean TokenVersionRevocation tokenRevocation(JdbcTemplate jdbc) {
        return new TokenVersionRevocation(jdbc);               // 停用帳號 / 收回權限要立刻生效（5.7.3）
    }
    @Bean RefreshTokenService refreshTokenService(JdbcTemplate jdbc,
                                                  @Value("${shop.jwt.refresh-ttl}") Duration ttl) {
        return new RefreshTokenService(jdbc, ttl);             // 14 天 + rotation（5.6）
    }

    /**
     * REST API：無狀態 + JWT。
     * ✅ CSRF 可以關，理由是【身分靠 Authorization: Bearer 攜帶，瀏覽器不會自動送】（4.5.1）。
     *    ⚠️ 前提是 token【不放進 cookie】（4.5.2、5.8.4）。
     */
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http, AuthenticationManager am,
                                 JwtService jwt, TokenVersionRevocation revocation) throws Exception {
        return http
            .securityMatcher("/api/**", "/error")
            .authenticationManager(am)                          // 只有 /api/auth/login 會用到它
            .authorizeHttpRequests(a -> a
                .requestMatchers("/error").permitAll()
                .requestMatchers("/api/auth/login", "/api/auth/refresh", "/api/auth/register").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/products/**").permitAll()
                .requestMatchers(HttpMethod.POST,   "/api/orders/*/refund").hasAuthority("order:refund")
                .requestMatchers(HttpMethod.DELETE, "/api/orders/**").hasAuthority("order:delete")
                .requestMatchers("/api/reports/**").hasAuthority("report:read")
                .requestMatchers("/api/admin/**").hasAuthority("user:manage")
                .anyRequest().authenticated())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())                             // ★ 理由見上面的 javadoc（4.5.1）
            // ★ 04 章的 .httpBasic(...) 換成這一行（5.4.1、5.5）：
            .addFilterBefore(new JwtAuthenticationFilter(jwt, revocation),
                    UsernamePasswordAuthenticationFilter.class)
            .exceptionHandling(e -> e
                .authenticationEntryPoint(ApiErrors::write401)  // 401 只寫通用訊息，細節進 log（5.4.3）
                .accessDeniedHandler(ApiErrors::write403))
            .build();
    }

    // webChain（後台網頁，session + 表單登入 + CSRF 開著 + maximumSessions）：完全照 04 章 4.8，此處省略
}
```

**④ `ShopSessionAdmin.disable()` 現在要踢兩種身分**

04 章的 `kick(userId)` 只踢 session。現在同一個人可能同時有 session（後台）和 JWT（API），
所以「停用帳號」要**同時**踢 session **和** bump token_version：

```java
@Service
public class ShopSessionAdmin {

    private final SessionRegistry registry;                    // 04 章：踢 session
    private final TokenVersionRevocation jwtRevocation;        // 05 章：撤 JWT
    private final JdbcTemplate jdbc;
    // 建構子注入三個

    /** 停用帳號 = 改 DB + 踢 session（04 章）+ 撤所有 JWT（05 章）*/
    @Transactional
    public void disable(Long userId) {
        jdbc.update("UPDATE app_user SET enabled = FALSE WHERE id = ?", userId);
        kickSessions(userId);                                  // 04 章 4.3.3：expireNow()
        jwtRevocation.revokeAll(userId);                       // 05 章 5.7.3：token_version + 1
    }
}
```

> 🔴 **這是 02 章 2.7.7、03 章 3.7.7、04 章、05 章一路追下來的那個問題的完整答案**：
> 「停用一個帳號」要動的地方，隨著身分載體變多而變多——
> 改 DB（帳號本身）→ 踢 session（後台）→ 撤 JWT（API）。
> **少任何一步，那個人就從某一個入口繼續有效。** 這就是「撤銷路徑清單」（本章練習五）存在的理由。

**⑤ 本章結束時，shop-service 的樣子**：

```
API（/api/**）   無狀態 + JWT（HS256，15 分鐘）；CSRF 關掉且【寫得出理由】
                 撤銷：token 版本號（停用帳號 / 收回權限立刻生效，5.7.3）
                 續期：refresh token 14 天 + rotation + reuse detection（5.6）
後台（其餘）      session + 表單登入 + CSRF 開著（04 章 4.8，不變）
撤銷路徑         ShopSessionAdmin.disable() 同時踢 session + 撤 JWT
principal        ShopUserDetails 比 userId，多帶 tokenVersion
啟動檢查          五個 reporter，其中 JwtWiringReporter 對「JWT 但沒撤銷機制」發警告（5.1.2）
```

⚠️ **還沒有的東西**（交給後面章節）：

```
🔴 refresh token 存哪裡（前端）—— localStorage / HttpOnly cookie 的取捨（5.8.4）  → 視前端
🔴 第三方登入（Google / GitHub）                                              → 06 章
🔴 CORS 還沒設（前後端分離一定會遇到）                                          → 07 章
🔴 登入失敗計數、帳號鎖定、密碼列舉防護                                          → 07 章
🔴 稽核：誰在什麼時候登入 / token 被撤銷                                         → 08 章
```

---

## 5.10 常見誤區

**誤區 1：「payload 看起來是亂碼，所以放密碼沒關係」**

→ 5.2.1b 實測：payload 只是 Base64URL，`base64 -d` 一行就解開。
**任何拿到 token 的人都讀得到 payload 的每一個字。** 密碼、信用卡、身分證一律不放。

**誤區 2：「我驗了簽章，所以 token 一定是我發的」**

→ 5.2.6 實測：如果你**相信 header 裡的 `alg`**，攻擊者可以把 RS256 降級成 HS256、
用你的公鑰當 HMAC 密碼偽造 token。**要由你手上金鑰的型別決定用哪個演算法，不是 token。**
而且要 `requireIssuer`（5.8.2），否則別的系統用同一把金鑰簽的 token 也會被接受。

**誤區 3：「JWT 是無狀態的，所以不能撤銷，只能等過期」**

→ 半對。**預設**確實撤不掉（5.5.2、5.7.1），但可以用版本號 / 黑名單撤（5.7）——
代價是**重新引入一點狀態**（每個請求查一個整數）。
真正的重點是：**能接受 15 分鐘空窗的話，短命 access + refresh 最省**，連那個整數都不用查。

**誤區 4：「改了權限，重新登入卻還是舊的」**

→ 反過來——**沒重新登入才會是舊的**（5.5.2）。token 裡的權限是登入當下的快照，
改 DB 不影響已發出的 token。要嘛等它過期、要嘛主動撤銷（5.7）。
**這不是 bug，是無狀態的定義。** 把角色 / 權限放進 token 之前，先想清楚這件事。

**誤區 5：「refresh token 也做成 JWT 比較一致」**

→ 5.6.1：refresh token **故意不是 JWT**。它要能被查、被撤銷、被 rotation——
這些全都需要狀態，而 JWT 的賣點正好是無狀態。**access 用 JWT（無狀態、快），refresh 用不透明字串（有狀態、可撤）**，兩者分工不同。

**誤區 6：「access token 設長一點，使用者比較不會被登出」**

→ 5.3.2 + 5.7.1：長命 access token = 外洩後長時間被濫用，而且**撤不掉**。
正確做法是 access 短命（15 分鐘）+ refresh 無痛續期（5.6）——
使用者體感上不會被登出，但外洩的損害有 15 分鐘上限。

**誤區 7：「我只是要拿 userId，`split(".")` 讀一下就好」**

→ 5.8.1：土炮解析 = 完全沒有驗證，攻擊者想寫什麼 userId 就寫什麼。
**哪怕只拿一個欄位，也要 `verifyWith(key).parseSignedClaims(token)`。**

**誤區 8：「JWT 存哪裡都可以，反正有簽章」**

→ 5.8.4 + 04 章 4.5.2：存 cookie 會讓 CSRF 重新成立；存 localStorage 會被 XSS 讀走。
沒有完美解，但**「把 access token 放進 cookie 又關掉 CSRF」是最糟的組合**（4.5.2 實測過）。

---

## 5.11 本章小結

這一章從「Basic 太慢、session 要狀態」出發，用 JWT 同時解決兩者，
然後**一步一步把 JWT 為此付出的代價補回來**：

```
5.2  結構與攻擊   payload 是明文；簽章保完整性不保機密性；三個經典攻擊
5.3  簽發         JwtService；exp 一定要有；clock skew
5.4  驗證         自訂 Filter 的位置與骨架；失敗不 throw 不自己回應；oauth2ResourceServer 對照
5.5  跑一次       端到端；權限是快照（🔴 撤不掉的伏筆）；吞吐量 2322 vs 13
5.6  refresh      access 短命 + refresh 長命可撤；rotation + 重用偵測
5.7  撤銷         三種做法的取捨；版本號讓「改權限」立刻生效；補完開頭那張表的那一格
5.8  錯誤用法     土炮解析、不驗 iss、payload 撐爆標頭
5.9  落地         shop 的 API 從 Basic 換成 JWT；停用帳號要同時踢 session + 撤 JWT
```

**一句話帶走**：

> **JWT 把身分從伺服器搬到 token 裡。** 好處（無狀態、便宜）與壞處（撤不掉、是快照）
> 是同一件事的兩面。這一章的每一節，都在回答「這份搬出去的身分，出事了怎麼辦」。

### 5.11.1 驗收清單

```
□ JWT 三段各是什麼？payload 為什麼不能放機敏資料？
□ 簽章保護的是完整性還是機密性？改一個字元會發生什麼？
□ signWith(key) 怎麼決定演算法？為什麼正式程式碼要寫死？
□ HS256 / RS256 / ES256 的金鑰模型與成本差在哪？對外服務為什麼要用非對稱？
□ alg:none 攻擊怎麼成立？jjwt 預設擋得住嗎？哪兩種寫法會讓它重新成立？
□ RS256→HS256 金鑰混淆的原理？verifyWith(publicKey) 為什麼擋得住？
□ 一個沒有 exp 的 token 會怎樣？jjwt 會報錯嗎？
□ clock skew 是什麼？容錯值設多少？設太大的後果？
□ JwtAuthenticationFilter 該放在鏈的哪個位置？為什麼在帳密 Filter 之前？
□ 驗證失敗時 Filter 該做什麼、不該做什麼？（清 context、往下走）
□ oauth2ResourceServer 跟自訂 Filter 怎麼選？.authenticationManager(am) 那個坑是什麼？
□ 帶 token 打 /api/me 的五個狀態碼（401/200/200/401/403）各代表什麼？
□ 為什麼把權限從 DB 拔掉，同一個 token 照樣 200？這對照 session 的什麼？
□ JWT 版與 Basic 版的吞吐量差幾倍？差在哪裡？跟 session 比呢？
□ refresh token 為什麼不做成 JWT？為什麼 DB 只存雜湊？
□ rotation 是什麼？reuse detection 怎麼偵測偷竊？為什麼撤整個 family？
□ JWT 為什麼「預設撤不掉」？三種撤銷做法的記什麼、粒度、成本？
□ token 版本號怎麼讓「改權限」立刻生效？代價是什麼？
□ 停用一個帳號要動哪三個地方？（DB / session / JWT）
□ 土炮 split(".") 解析的災難是什麼？
□ 不驗 iss 會怎樣？payload 太大會怎樣？
```

### 5.11.2 本章練習

**練習一（動手）：把你系統的 token 貼進 `TokenScope`**

1. 從你的系統登入，複製出一個 access token。
2. 貼進 `TokenScope.dump(...)`，看它印什麼。
3. **有任何一個 🔴 就是要修的**：沒 exp？exp 太遠？payload 有機敏資料？

**練習二（攻擊）：對自己的驗證方打 alg:none**

1. 手動組一個 `{"alg":"none"}` 的 token（5.2.4 的程式碼）。
2. 打你的受保護端點。**過了的話，你的 parser 一定用了 `parse()` 或土炮解析——馬上修。**

**練習三（診斷）：量你的 access token 撤銷延遲**

1. 登入拿 token，打一個受保護端點（200）。
2. 在 DB 把你的帳號停用 / 收回權限。
3. **用同一個 token 再打。還是 200 的話，延遲就是「token 剩餘壽命」**——
   對照 5.7，決定你要不要加撤銷機制。

**練習四（設計）：畫出你系統的雙 token 生命週期**

```
登入        → 發 access（多久？）+ refresh（多久？）
access 過期  → 前端怎麼知道？怎麼自動 refresh？
refresh 過期 → 使用者要重新登入嗎？
登出        → 撤 refresh？撤 access（怎麼撤）？
偵測到異常   → 撤整個 family 嗎？
```

**練習五（設計）：寫出你系統的「撤銷路徑」清單**（延續 04 章練習五，加上 JWT）

```
停用帳號          → 改 DB / 踢 session / 撤 JWT —— 三個都做了嗎？
使用者改密碼       → 舊的 access / refresh 要不要一起失效？
管理員收回權限     → 立刻生效還是等過期？（5.5.2 vs 5.7.3）
使用者按「登出所有裝置」→ token_version + 1 + 撤所有 refresh family
```

**練習六（判斷）：你的專案該用哪種撤銷？**

對照 5.7.2 那張表，回答：

```
□ 你能接受「改權限後 15 分鐘才生效」嗎？ → 能：短命 + refresh（最省）
□ 你需要「登出這一台裝置」嗎？          → 需要：jti 黑名單
□ 你需要「一鍵登出所有裝置」嗎？        → 需要：token 版本號
```

---

## 5.12 下一章預告

**06 章：OAuth2 與 OIDC（第三方登入）。**

這一章的使用者是**你自己的帳號系統**發 token。06 章要處理的是——
**使用者根本沒有你的帳號，他想用 Google / GitHub 登入**。

```
05 章：使用者 → 你的 /api/auth/login（帳密）→ 你簽的 JWT
06 章：使用者 → Google 登入 → Google 發的 token → 你【驗】Google 的 token → 綁到你的帳號
```

📌 **05 章留下的四個線索，06 章會直接接上**：

| 這一章的東西 | 06 章要用它做什麼 |
|---|---|
| 5.2.3 的非對稱（RS256） | Google 用私鑰簽、你用**它公開的公鑰**驗——你不可能有 Google 的私鑰 |
| 5.4.4 的 `oauth2ResourceServer` | 驗 Google 的 token 就是走這條路（`.jwt()` 換成 Google 的 issuer / jwks） |
| 5.2.6 的「不要相信 token 自己說的 alg」 | 驗第三方 token 時，這件事更重要——要驗 `iss`、`aud`、金鑰來源 |
| 5.9 的「綁到自家帳號」 | OAuth2 登入成功後，怎麼跟你 `app_user` 裡的帳號對應起來 |

**06 章會回答的五個問題**：

```
① 授權碼流程（Authorization Code + PKCE）到底在傳什麼——一步一步看封包
② oauth2Login：Spring 幫你把「跳去 Google、拿 code、換 token」全包了，你只要設 client
③ OIDC 的 id_token 跟 05 章的 JWT 有什麼關係（答案：它就是一個 JWT）
④ Resource Server：你的 API 怎麼驗「別人發的」token（回到 5.4.4）
⑤ 第一次用 Google 登入的人，怎麼在你的 app_user 裡建帳號、之後怎麼認出是同一個人
```

⚠️ **順帶預告一個 06 章的實測**：
很多教學會叫你「把 client secret 寫在前端」——
06 章會用一個**攔截封包**的實測告訴你，為什麼**公開的前端（SPA / App）不能有 client secret**，
以及 **PKCE** 是怎麼在「沒有 secret」的情況下擋掉授權碼被攔截的攻擊。
