# 第 06 章：OAuth2 與 OIDC（第三方登入）

> 前五章的使用者都在**你自己的系統**裡有帳號：
>
> ```
> 02～04 章   使用者 → 你的 /login（帳密）→ session
> 05 章       使用者 → 你的 /api/auth/login（帳密）→ 你簽的 JWT
> ```
>
> 這一章的使用者**根本沒有你的帳號**——他想用 Google / GitHub 登入：
>
> ```
> 06 章       使用者 → 在 Google 登入 → Google 發一張 token → 你【驗】Google 的 token → 綁到你的帳號
> ```
>
> 差別看起來只是「換一個地方登入」，但它翻轉了一件根本的事：
>
> > **密碼不再經過你的系統。** 使用者只把密碼交給 Google，
> > 你的系統從頭到尾**看不到、也不該看到**它。你收到的只是一張「Google 幫你證明過的」token。
>
> 📌 **這一章最大的一個實作決定**：我們在本機跑一台**真的 Authorization Server** 當「Google」。
>
> ```
> 為什麼？ 因為沒辦法在測試裡真的登入 Google。
> 為什麼可以？ OAuth2 / OIDC 是【標準協定】——本機這台跟 Google 說的是同一種語言。
>            這一章看到的每一個 redirect、每一個 token，跟接真 Google 時【一模一樣】。
> ```
>
> 📌 **這一章有十一個實測。** 其中五個值得先劇透：
>
> ```
> 6.2.2  完整授權碼流程：一步一步看封包（redirect → 登入 → code → 換 token）
> 6.3.3  🔴 沒有 PKCE，攔到 code 就能換 token；有 PKCE，攔到也沒用
> 6.4    id_token 與 access_token 的分工 —— 兩張都是 05 章的 JWT
> 6.5.2  oauth2Login：你只寫【一行 + 一個設定】，Spring 把整個流程包了
> 6.7.3  🔴 用 email 當帳號主鍵的災難 —— email 被回收，bob 直接變成 alice
> ```
>
> ⚠️ **這一章有一個貫穿全章的判準**：
>
> > **OAuth2 解決的是「授權」（authorization）——「准許 A 程式代表你去存取 B 的資源」。**
> > **OIDC（OpenID Connect）在它上面加了「認證」（authentication）——「證明你是誰」。**
> > 每次搞混一個設定，先問：**這一步是在「拿存取權」，還是在「證明身分」？**

---

## 6.1 學習目標與實驗環境

完成本章後，你應該可以：

- 說出 OAuth2 的四個角色（Resource Owner / Client / Authorization Server / Resource Server）各是誰（6.1.2）。
- 一步一步描述授權碼流程，說出每一個 redirect 在傳什麼（6.2.2）。
- 解釋 authorization code **為什麼只能用一次**、`state` **擋的是什麼攻擊**（6.2.3、6.2.4）。
- 說明公開 client（SPA / App）**為什麼不能有 client secret**，以及 PKCE 怎麼補這個洞（6.3）。
- 重現「授權碼被攔截」攻擊，並示範 PKCE 如何擋下它（6.3.3）。
- 解釋 `id_token` 與 `access_token` 的**分工**，並用 05 章的 `TokenScope` 證明它們都是 JWT（6.4）。
- 用 `oauth2Login` 接上第三方登入，說出 Spring 幫你做了哪五件事（6.5）。
- 用 `oauth2ResourceServer` 驗「別人發的」token，並說出金鑰是從哪裡來的（6.6）。
- 把第三方身分綁到你自己的 `app_user`，並說出**為什麼主鍵要用 `sub` 不是 `email`**（6.7）。

### 6.1.1 本章的實驗環境

| 項目 | 版本 |
|---|---|
| Spring Boot | 3.2.5 |
| Spring Security | 6.2.4 |
| Spring Authorization Server | 1.2.4（本機那台「Google」） |
| JDK | Temurin 21.0.5 |
| MySQL | 8.0.46（6.7 帳號綁定要用） |
| 機器 | Apple M2 / macOS 14.2.1 |

**① 三個新相依**：

```xml
<!-- 你的網站當 OAuth2 client（oauth2Login，6.5） -->
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-oauth2-client</artifactId></dependency>

<!-- 你的 API 當 Resource Server（6.6）—— 05 章 5.4.4 已經加過 -->
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-oauth2-resource-server</artifactId></dependency>

<!-- ★ 本機那台「Google」（實驗用；正式環境你不會自己跑 AS，除非你就是要當 SSO 提供者） -->
<dependency><groupId>org.springframework.security</groupId><artifactId>spring-security-oauth2-authorization-server</artifactId><version>1.2.4</version></dependency>
```

**② 一張新表：`social_identity`**（6.7 把第三方身分綁到本地帳號）：

```sql
CREATE TABLE social_identity (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider      VARCHAR(32)  NOT NULL,          -- google / github / ...
  subject       VARCHAR(255) NOT NULL,          -- provider 給的【穩定唯一 id】（＝ id_token 的 sub）
  user_id       BIGINT       NOT NULL,          -- 對應你自己的 app_user.id
  email_at_link VARCHAR(255) NULL,              -- 只是記錄綁定當下的 email，【不當鍵】（6.7.3）
  linked_at     DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_provider_subject (provider, subject),   -- ★ 唯一鍵是 (provider, sub)，不是 email
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**③ profile 對照**（這一章的變體）：

```
as        本機 Authorization Server（＝Google）：兩個 client、兩個「Google 帳號」、RS256 簽章
client    你的網站當 OAuth2 client（oauth2Login，6.5）
rs        你的 API 當 Resource Server（6.6）
social    帳號綁定服務（6.7）
```

> 🔴 **實驗專案的一個坑**（跟前幾章同源）：`as` 這個 context 一啟動，
> 前幾章那些「預設就 active」的 bean（`ch02` 的 `DbUserDetailsService`、`shop` 的 `SecurityScenarios.Users`）
> 會跟 AS 的設定打架——尤其後者提供了一個 `BCryptPasswordEncoder`，讓 AS 的 `{noop}` 帳號登不進去。
> 解法跟 04 章的 `& !eq` 一樣：給它們的 `@Profile` 加上 `& !as`。**讀者自己的專案不會有這個問題**（你不會把六章的設定放在同一個 app 裡）。

### 6.1.2 四個角色：先把誰是誰講清楚

OAuth2 的所有混亂，幾乎都來自「搞不清楚現在在講哪個角色」。先記住這四個：

```
┌─────────────────┬──────────────────────────────────────────────┬─────────────────────┐
│ 角色             │ 是誰                                          │ 在本章的例子         │
├─────────────────┼──────────────────────────────────────────────┼─────────────────────┤
│ Resource Owner  │ 使用者本人（資源的主人）                        │ 想登入的那個人        │
│ Client          │ 想「代表使用者」做事的程式                       │ 你的網站 / App       │
│ Authorization   │ 發 token 的那一方（管帳號、驗密碼、發同意書）     │ Google（本章的本機 AS）│
│   Server (AS)   │                                               │                     │
│ Resource Server │ 拿 token 來的人可以存取的資源                    │ 你的 API / Google API │
└─────────────────┴──────────────────────────────────────────────┴─────────────────────┘
```

⚠️ **最容易搞混的一件事**：**Client 不是使用者的瀏覽器，是「你的網站後端」。**
而「你的網站」在這一章有**兩個身分**：

```
用 Google 登入時      → 你的網站是【Client】（6.5）——它去跟 Google 要 token
你的 API 收到 token 時  → 你的 API 是【Resource Server】（6.6）——它驗這張 token
```

這也是為什麼 05 章的 `oauth2ResourceServer`（5.4.4）會在這一章回來：
**驗 token 的那一面，不管 token 是你自己發的（05 章）還是 Google 發的（06 章），都是 Resource Server。**

### 6.1.3 本機的「Google」：Authorization Server

這是整章的地基。它是一台**真的、符合規範的** Authorization Server，提供：

```
兩個註冊過的 client：
  shop-web   機密 client（有 client secret）—— 你的後端網站（6.5）
  shop-spa   公開 client（沒有 secret，強制 PKCE）—— SPA / 手機 App（6.3）
兩個「Google 帳號」：
  user@gmail.com / pw      new-user@gmail.com / pw
用 RS256 簽 token（5.2.3 的非對稱：私鑰留在 AS，公鑰透過 /oauth2/jwks 公開）
```

```java
package com.example.lab09.ch06;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;
import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.oidc.OidcScopes;
import org.springframework.security.oauth2.server.authorization.client.*;
import org.springframework.security.oauth2.server.authorization.config.annotation.web.configuration.OAuth2AuthorizationServerConfiguration;
import org.springframework.security.oauth2.server.authorization.config.annotation.web.configurers.OAuth2AuthorizationServerConfigurer;
import org.springframework.security.oauth2.server.authorization.settings.*;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.LoginUrlAuthenticationEntryPoint;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.*;
import java.util.UUID;

@Configuration
@Profile("as")
public class AuthServerConfig {

    /** chain[0]：處理 /oauth2/authorize、/oauth2/token、/.well-known/...、/oauth2/jwks、/userinfo 等協定端點 */
    @Bean
    @Order(1)
    SecurityFilterChain authServerChain(HttpSecurity http) throws Exception {
        OAuth2AuthorizationServerConfiguration.applyDefaultSecurity(http);
        http.getConfigurer(OAuth2AuthorizationServerConfigurer.class)
                .oidc(Customizer.withDefaults());          // ★ 打開 OIDC（才有 id_token 與 userinfo）
        http.exceptionHandling(e -> e
                .authenticationEntryPoint(new LoginUrlAuthenticationEntryPoint("/login")));
        // ★ userinfo 端點要能吃 access token（bearer）—— 少了這行，client 呼叫 /userinfo 會被導去登入頁（6.5 踩過）
        http.oauth2ResourceServer(rs -> rs.jwt(Customizer.withDefaults()));
        return http.build();
    }

    /** chain[1]：AS 自己的登入頁（resource owner 在這裡輸入帳密——就是 Google 的登入畫面） */
    @Bean
    @Order(2)
    SecurityFilterChain asLoginChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .formLogin(Customizer.withDefaults());
        return http.build();
    }

    /** 兩個「Google 帳號」 */
    @Bean
    UserDetailsService asUsers() {
        var u1 = User.withUsername("user@gmail.com").password("{noop}pw").authorities("USER").build();
        var u2 = User.withUsername("new-user@gmail.com").password("{noop}pw").authorities("USER").build();
        return new InMemoryUserDetailsManager(u1, u2);
    }

    @Value("${as.web-redirect:http://127.0.0.1:9999/login/oauth2/code/shop}")
    String webRedirect;
    @Value("${as.spa-redirect:http://127.0.0.1:9999/callback}")
    String spaRedirect;

    /** 兩個註冊過的 client（＝在 Google Cloud Console 註冊 OAuth client 的本地版） */
    @Bean
    RegisteredClientRepository registeredClients() {
        // ① shop-web：機密 client（後端保管 secret）
        RegisteredClient web = RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId("shop-web")
                .clientSecret("{noop}shop-web-secret")                       // 機密：有 secret
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
                .redirectUri(webRedirect)
                .scope(OidcScopes.OPENID).scope(OidcScopes.PROFILE).scope(OidcScopes.EMAIL)
                .scope("order:read")
                .clientSettings(ClientSettings.builder().requireProofKey(false).requireAuthorizationConsent(false).build())
                .build();

        // ② shop-spa：公開 client（SPA / App，【沒有】secret，強制 PKCE，6.3）
        RegisteredClient spa = RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId("shop-spa")
                .clientAuthenticationMethod(ClientAuthenticationMethod.NONE)   // ★ 公開：沒有 secret
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri(spaRedirect)
                .scope(OidcScopes.OPENID).scope(OidcScopes.EMAIL).scope("order:read")
                .clientSettings(ClientSettings.builder().requireProofKey(true).requireAuthorizationConsent(false).build())  // ★ 強制 PKCE
                .build();

        return new InMemoryRegisteredClientRepository(web, spa);
    }

    /** RS256 的金鑰（5.2.3）：私鑰留在 AS，公鑰透過 /oauth2/jwks 公開讓大家驗 */
    @Bean
    JWKSource<SecurityContext> jwkSource() {
        KeyPair kp = generateRsa();
        RSAPublicKey pub = (RSAPublicKey) kp.getPublic();
        RSAPrivateKey priv = (RSAPrivateKey) kp.getPrivate();
        com.nimbusds.jose.jwk.RSAKey key = new com.nimbusds.jose.jwk.RSAKey.Builder(pub)
                .privateKey(priv).keyID(UUID.randomUUID().toString()).build();
        return new ImmutableJWKSet<>(new JWKSet(key));
    }

    @Bean
    AuthorizationServerSettings authorizationServerSettings() {
        return AuthorizationServerSettings.builder().build();   // issuer 用 request 推導
    }

    /**
     * 讓本機 AS 更像真 Google：
     *   - sub 換成【不透明的穩定 id】（真 Google 的 sub 是一串數字，不是 email）—— 6.7.2 的重點
     *   - id_token 補上 email / email_verified
     */
    @Bean
    org.springframework.security.oauth2.server.authorization.token.OAuth2TokenCustomizer<
            org.springframework.security.oauth2.server.authorization.token.JwtEncodingContext> tokenCustomizer() {
        return context -> {
            String username = context.getPrincipal().getName();               // user@gmail.com
            String opaqueSub = "sub-" + Integer.toHexString(username.hashCode()).replace("-", "0")
                    + Integer.toHexString(username.length());
            context.getClaims().subject(opaqueSub);
            if ("id_token".equals(context.getTokenType().getValue())) {
                context.getClaims().claim("email", username);
                context.getClaims().claim("email_verified", true);
            }
        };
    }

    private static KeyPair generateRsa() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
            g.initialize(2048);
            return g.generateKeyPair();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
}
```

> 📌 **正式環境你通常不會自己跑 AS**——Google / GitHub / Auth0 / Keycloak 就是那台 AS。
> 但**看懂 AS 在做什麼**，你才知道那些 `application.yml` 的設定各自對應協定的哪一步。
> 這一章剩下的每一節，都是拿這台 AS 當對手，把協定跑一遍。

---

## 6.2 授權碼流程：一步一步看封包

「用 Google 登入」背後跑的是 **Authorization Code Flow（授權碼流程）**。
它有五、六步，每一步都在瀏覽器的網址列跳來跳去。這一節把每一步的封包印出來看。

### 6.2.1 為什麼不是「前端直接把密碼給 Google 換 token」

先破除一個直覺。最「直接」的想法是：前端跳出一個框，讓使用者輸入 Google 密碼，
前端拿密碼去跟 Google 換 token。**這正是 OAuth2 要消滅的東西**：

```
🔴 密碼流過你的前端 → 你（或任何攔截的人）就看得到使用者的 Google 密碼
🔴 你的網站等於握有使用者的 Google 帳號 → 完全違背「第三方登入」的初衷
```

授權碼流程的核心設計，就是**讓密碼只在使用者與 AS（Google）之間**：

```
使用者的密碼    只在 Google 的登入頁輸入 —— 你的網站從頭到尾看不到
你的網站拿到的  是一個【授權碼 code】，再用它去換 token —— 而不是密碼
```

### 6.2.2 實測：完整的授權碼流程

用會記住 cookie 的瀏覽器替身，把整個流程手動跑一遍（Spring 在 6.5 會幫你自動做這些）：

```java
    @Test
    void authorizationCodeFlow() {
        try (As as = new As()) {                       // 起一台本機 AS（＝Google）
            Web browser = as.web();                    // 會記住 cookie 的瀏覽器替身
            String redirectUri = "http://127.0.0.1:9999/login/oauth2/code/shop";
            String state = "xyz-anti-csrf-123";

            // 步驟 1：client 把瀏覽器導去 AS 的 /oauth2/authorize
            String authorize = "/oauth2/authorize?response_type=code"
                    + "&client_id=shop-web"
                    + "&redirect_uri=" + As.enc(redirectUri)
                    + "&scope=" + As.enc("openid email order:read")
                    + "&state=" + state;
            HttpResponse<String> r1 = browser.get(authorize);              // → 302 導去登入頁

            // 步驟 2：resource owner 在 AS 登入（＝Google 的登入畫面）
            int login = browser.formLogin("user@gmail.com", "pw");          // → 302 登入成功

            // 步驟 3：登入後再打 authorize，這次拿到 code
            HttpResponse<String> r3 = browser.get(authorize);
            String code = As.param(r3, "code");
            String returnedState = As.param(r3, "state");

            // 步驟 4：client 後端拿 code 去換 token（帶 client secret，前端看不到這一步）
            String tokenBody = "grant_type=authorization_code&code=" + As.enc(code)
                    + "&redirect_uri=" + As.enc(redirectUri);
            HttpResponse<String> tok = browser.sendWithoutCookies("POST", "/oauth2/token", tokenBody,
                    "Authorization", Web.basic("shop-web", "shop-web-secret"),
                    "Content-Type", "application/x-www-form-urlencoded");

            // 步驟 5：id_token 是一個 JWT —— 用 05 章的 TokenScope 拆開
            String idToken = extract(tok.body(), "id_token");
            TokenScope.dump("id_token", idToken);
        }
    }
```

**輸出**：

```
═══ 6.2.2 授權碼流程：一步一步看封包 ═══
Authorization Server（＝Google）跑在 http://localhost:51776

① 瀏覽器 GET /oauth2/authorize?response_type=code&client_id=shop-web&redi...
   → 302  Location: http://localhost:51776/login（沒登入 → 導去登入頁）

② 使用者在 AS 登入（user@gmail.com / pw）
   → POST /login = 302（302 = 登入成功，導回原本的 authorize 請求）

③ 登入後回到 /oauth2/authorize
   → 302  Location: http://127.0.0.1:9999/login/oauth2/code/shop?code=qbfEBACTZ7URAvgzyfRvZv9Z0iRtRSo9…
   拿到 authorization code = qbfEBACTZ7URAvgzyfRvZv9Z…
   state 原封不動送回來了嗎？ true（擋 CSRF，6.2.4）

④ client 後端 POST /oauth2/token（帶 code + client secret）
   → 200
   回應（JSON）：{"access_token":"eyJraWQiOiJmMmY1MTIxNS...","id_token":"...","token_type":"Bearer",...}

⑤ 裡面的 id_token 就是一個 JWT（05 章 5.2）：

── id_token ──
   header  : {"kid":"f2f51215-...","alg":"RS256"}
   payload : {"sub":"user@gmail.com","aud":"shop-web","azp":"shop-web","auth_time":1789374792,
              "iss":"http://localhost:51776","exp":...,"iat":...,"jti":"...","sid":"..."}
   ✅ 沒有發現這六項常見問題
```

**把五步畫成一張圖**（箭頭上的就是網址列在跳的東西）：

```
   使用者的瀏覽器                你的網站(Client)              Google(AS)
        │                          │                          │
        │  1. 點「用 Google 登入」   │                          │
        │─────────────────────────>│                          │
        │  2. 302 導去 AS/authorize（帶 client_id, redirect_uri, scope, state）
        │<─────────────────────────┤                          │
        │  3. GET /authorize ─────────────────────────────────>│
        │  4. 302 導去登入頁（還沒登入）                          │
        │<─────────────────────────────────────────────────────┤
        │  5. 輸入 Google 帳密（★ 密碼只到這裡，你的網站看不到）──>│
        │  6. 302 導回 redirect_uri?code=…&state=…              │
        │<─────────────────────────────────────────────────────┤
        │  7. GET redirect_uri?code=… ─────────────────────────│ (回到你的網站)
        │─────────────────────────>│                          │
        │                          │  8. POST /token（code + client secret）
        │                          │─────────────────────────>│  ★ 這一步在後端，瀏覽器看不到
        │                          │  9. { access_token, id_token }
        │                          │<─────────────────────────┤
        │  10. 你的網站建立登入 session（放你自己的 cookie）       │
        │<─────────────────────────┤                          │
```

**三個關鍵，每一個對應一個後續小節**：

```
① 為什麼要先給 code、再用 code 換 token？（而不是直接給 token）
   → 因為 code 走「瀏覽器轉址」（看得到），token 走「後端直連」（藏得住）。
     藏 token 的關鍵：換 token 那一步要出示 client secret，而 secret 只有後端有。→ 6.3

② 那 SPA / 手機 App 沒有後端、藏不住 secret 怎麼辦？ → PKCE（6.3）

③ state 那個參數是幹嘛的？ → 擋 CSRF（6.2.4）
```

### 6.2.3 實測：authorization code 只能用一次

code 是「一次性」的——換過一次 token 就作廢。這擋的是「code 被攔截後重複使用」：

```java
    @Test
    void codeIsSingleUse() {
        try (As as = new As()) {
            // ... 跑到拿 code、換第一次 token（略）...
            HttpResponse<String> first  = exchange(code);      // 用 code 換第一次
            HttpResponse<String> second = exchange(code);      // 用【同一個】code 再換一次
        }
    }
```

**輸出**：

```
═══ 6.2.3 authorization code 只能用一次 ═══
① 第一次用 code 換 token → 200（拿到 token）

② 用同一個 code 換第一次 → 200
③ 用【同一個】code 再換一次 → 400  {"error":"invalid_grant"}

★ code 換過一次就作廢（對照 05 章 5.6.3 refresh token 的 rotation）——
  而且很多 AS 偵測到 code 被重用時，會【連同已發出的 token 一起撤銷】，因為那代表 code 可能被攔截了。
```

> 📌 **這跟 05 章 5.6.3 的 refresh token rotation 是同一個安全模式**：
> 「一次性 + 重用即視為外洩」。看到「用第二次」就知道有人手上有它不該有的東西。

### 6.2.4 `state`：擋的是 OAuth 版的 CSRF

`state` 是 client 在步驟 1 產生的隨機值，AS 在步驟 6 **原封不動送回來**。
client 收到 callback 時，比對「送回來的 state」跟「當初存的 state」——對不上就拒絕。

**它擋的是什麼？** 一種 CSRF：攻擊者把**自己的** authorization code 塞給受害者的瀏覽器，
讓受害者的帳號**被綁上攻擊者的 Google 帳號**（login CSRF）。

```
沒有 state：
  攻擊者先自己走一遍流程，拿到一個【他自己帳號的】code，
  然後誘騙受害者的瀏覽器去打 你的網站/callback?code=攻擊者的code
  → 受害者的 session 被綁上【攻擊者的】Google 身分 → 之後受害者存的資料，攻擊者登入就看得到

有 state：
  callback 帶的 state 跟受害者瀏覽器裡存的對不上 → 你的網站直接拒絕
```

> 📌 **這就是 04 章 CSRF 的同一個病，長在 OAuth 流程上。**
> 好消息：`state` 由 Spring 的 `oauth2Login` **自動產生、自動驗證**（6.5 會在封包裡看到它），
> 你不用自己寫。但**如果你手刻 OAuth flow，漏掉 state 是最常見的洞之一。**

---

## 6.3 PKCE：公開的 client 沒有 secret 怎麼辦

6.2 的 shop-web 是**機密 client**：換 token 那一步要出示 `client secret`，而 secret 只有你的後端有。
攻擊者就算攔到 code，沒有 secret 也換不到 token。

**但 SPA 和手機 App 沒有後端**——所有程式碼都在使用者的裝置 / 瀏覽器裡。
你把 secret 寫進去，等於印在傳單上發給全世界。這一節解決這個問題。

### 6.3.1 實測：公開 client 沒有 secret

`shop-spa` 是**公開 client**：`clientAuthenticationMethod(NONE)`、`requireProofKey(true)`。
換 token 時它**沒有 secret 可帶**，只有 `client_id` + 一個叫 `code_verifier` 的東西：

```java
    @Test @Order(1)
    void a_publicClientNoSecret() throws Exception {
        try (As as = new As()) {
            Web b = as.web();
            String v = verifier(), c = challenge(v);   // 見 6.3.2
            String code = getCode(b, c);               // 走 authorize（帶 code_challenge）
            HttpResponse<String> tok = exchange(b, code, v);   // 換 token（帶 code_verifier，沒有 secret）
        }
    }
```

**輸出**：

```
═══ 6.3.1 公開 client（SPA / App）沒有 secret ═══
shop-spa 是公開 client：clientAuthenticationMethod=NONE、requireProofKey=true
→ 換 token 時【沒有 client secret 可帶】，只有 client_id + code_verifier
   帶對的 code_verifier → 200（200 = 換到 token，靠的是 PKCE 不是 secret）
```

> 🔴 **絕對不要把 client secret 放進 SPA / App。** 前端程式碼可以被任何人下載、反編譯、看原始碼。
> 「機密 client」的「機密」指的是**能保管 secret 的環境**（你的後端伺服器），前端不是。
> 公開 client 的安全**不能靠 secret**——靠的是 PKCE。

### 6.3.2 實測：PKCE 的 `code_challenge` / `code_verifier`

PKCE（Proof Key for Code Exchange，唸 "pixy"）的想法很簡單：

```
① 前端【當場】產生一個隨機的 code_verifier —— 留在自己手上，絕不送出
② 算 code_challenge = BASE64URL(SHA256(code_verifier)) —— 只把這個【單向雜湊】送給 AS（在 authorize 那一步）
③ 換 token 時，才把原始的 code_verifier 送出去
④ AS 自己算 SHA256(verifier)，跟當初收到的 challenge 比 —— 對得上才給 token
```

```java
    static String verifier() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }
    static String challenge(String verifier) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(h);
    }
```

**輸出**：

```
═══ 6.3.2 PKCE 的 code_challenge / code_verifier ═══
① 前端先產生一個隨機的 code_verifier（留在自己手上，絕不送出）：
   code_verifier  = PDfYt4DXRvZgqzmiDOOVjlpXwQwd7CsFoDfNvJLzYvw
② 算出 code_challenge = BASE64URL(SHA256(verifier))，【只送這個】給 AS：
   code_challenge = KGtW66Uaebuy6awTs9HTecj43cdmwV1MLvu__jhpy8k
③ authorize 時送 code_challenge；換 token 時送 code_verifier。
   AS 自己算 SHA256(verifier) 跟當初的 challenge 比 —— 對得上才給 token。

   驗證一次：SHA256(verifier) == challenge ? true
```

**PKCE 用 SHA256 的單向性取代了 secret**：

```
機密 client：  「我知道 secret」證明「我是那個 client」
公開 client：  「我知道當初那個 code_verifier」證明「我就是發起這次流程的那一個」
              —— 而攔到 code 的人，看到的只有 code_challenge（雜湊），算不出 verifier（SHA256 不可逆）
```

### 6.3.3 🔴 實測：PKCE 擋下「授權碼被攔截」

**情境**：手機 App 用「自訂 URL scheme」（例如 `myapp://callback`）接 authorization code。
問題是——**惡意 App 也可以註冊同一個 scheme**，於是 code 在回傳的路上被惡意 App 攔到了。

沒有 PKCE：攔到 code + 公開 client（沒 secret）= 攻擊者直接換到 token。
有 PKCE：攔到 code 也沒用，因為攻擊者沒有 `code_verifier`。

```java
    @Test @Order(3)
    void c_pkceStopsCodeInterception() throws Exception {
        try (As as = new As()) {
            // ① 有 PKCE，但攻擊者【沒有 code_verifier】（那個一直在真 App 手裡）
            String code1 = getCode(realApp, challenge(v));                     // 真 App 發起流程、拿到 code
            HttpResponse<String> attacker = exchange(attackerApp, code1, null); // 攻擊者攔到 code，不帶 verifier

            // ② 攻擊者亂猜一個 code_verifier
            HttpResponse<String> guess = exchange(attackerApp, code2, verifier());  // 隨便給一個

            // ③ 真正的 App 用【對的】code_verifier
            HttpResponse<String> real = exchange(realApp, code3, v3);
        }
    }
```

**輸出**：

```
═══ 6.3.3 PKCE 擋下「授權碼被攔截」 ═══

【情境】手機 App 用自訂 URL scheme 接 code，惡意 App 也註冊了同一個 scheme，攔到了 code。

① 有 PKCE，但攻擊者【沒有 code_verifier】（那個一直在真 App 手裡）：
   攻擊者用攔到的 code 換 token（不帶 verifier）→ 302 Location=http://localhost:.../login（302 回登入 = AS 根本不把它當成一次合法的 token 請求）

② 攻擊者亂猜一個 code_verifier：
   → 400  {"error":"invalid_grant"}

③ 真正的 App 用【對的】code_verifier：
   → 200（200 = 只有握有 verifier 的人換得到）

★ code_challenge 是公開的（送出去了），但 code_verifier 沒送 ——
  攔到 code 的人算不出 verifier（SHA256 不可逆），所以 code 對他沒用。
```

**三種結果對照**：

```
① 不帶 verifier    → AS 拒絕受理（公開 client + 強制 PKCE，沒 verifier 不算合法請求）
② 亂猜 verifier    → 400 invalid_grant（SHA256(亂猜) ≠ 當初的 challenge）
③ 對的 verifier    → 200（只有發起流程、手上有 verifier 的那一個換得到）
```

> 📌 **PKCE 現在是所有 client 的建議做法，不只公開 client。**
> 機密 client 也開 PKCE 沒壞處（多一層保護）。**Spring 的 `oauth2Login` 對公開 client 預設就開 PKCE**，
> 你幾乎不用自己算 verifier / challenge——但你要看得懂封包裡那兩個參數在幹嘛。

---

## 6.4 OIDC：`id_token` 是什麼

到目前為止講的都是 **OAuth2**——它的產物是 `access_token`，用途是「拿去存取資源」。
但「用 Google 登入」其實要的是**另一件事**：**知道登入的人是誰**。
這是 **OIDC（OpenID Connect）** 加上去的，它的產物是 `id_token`。

### 6.4.1 實測：`id_token` 就是一個 JWT

6.2 的 token 回應裡有兩張 token。用 05 章的 `TokenScope` 把它們都拆開：

```java
    @Test @Order(1)
    void a_oidcTokens() {
        try (As as = new As()) {
            String json = as.authCodeTokens("user@gmail.com");
            String idToken = As.jsonField(json, "id_token");
            String accessToken = As.jsonField(json, "access_token");
            TokenScope.dump("id_token", idToken);
            TokenScope.dump("access_token", accessToken);
        }
    }
```

**輸出**：

```
═══ 6.4 OIDC：id_token vs access_token ═══

① id_token（給【client】看的：這個人是誰、什麼時候登入的）：
── id_token ──
   header  : {"kid":"f07e175f-...","alg":"RS256"}
   payload : {"sub":"user@gmail.com","aud":"shop-web","azp":"shop-web","auth_time":1789375038,
              "iss":"http://localhost:51858","exp":...,"iat":...,"jti":"...","sid":"..."}

② access_token（給【Resource Server】看的：這張票能存取什麼）：
── access_token ──
   header  : {"kid":"f07e175f-...","alg":"RS256"}
   payload : {"sub":"user@gmail.com","aud":"shop-web","nbf":...,"scope":["openid","order:read","email"],
              "iss":"http://localhost:51858","exp":...,"iat":...,"jti":"..."}
```

**兩張都是 JWT，都用 AS 的私鑰簽（RS256）**——所以 05 章的每一課（簽章、exp、`TokenScope`）都適用。
差別在 **payload 的內容**，反映了兩張票的**不同用途**：

| | `id_token`（OIDC） | `access_token`（OAuth2） |
|---|---|---|
| 給誰看 | **Client**（你的網站） | **Resource Server**（API） |
| 回答的問題 | 「登入的人是誰？」 | 「這張票能存取什麼？」 |
| 關鍵 claim | `sub`（誰）、`auth_time`（何時登入）、`nonce` | `scope`（能做什麼） |
| client 拿它去打 API 嗎 | ❌ **不要**——它不是給 API 的 | ✅ 就是拿它打 API |
| 壽命 | 短（登入完讀一次就丟） | 短（本章 5 分鐘） |

> 🔴 **最常見的搞混：拿 `id_token` 去打 API。**
> `id_token` 是「給 client 的身分證明」，不是「存取權」。
> 打 API（Resource Server）要用 `access_token`。用錯了，嚴謹的 Resource Server 會拒絕
> （它檢查 `aud` / token 類型）。

### 6.4.2 `nonce`、`auth_time`、`sid`：OIDC 補的三個 claim

```
nonce      client 在 authorize 時放一個隨機值，AS 寫進 id_token —— 擋「重放舊的 id_token」
auth_time  使用者【實際登入】的時間 —— 高敏感操作可以要求「最近 N 分鐘內登入過」（對照 04 章 4.6.3 step-up）
sid        session id —— 支援 OIDC 的「單一登出」（一處登出，各站都登出）
```

6.5 用 `oauth2Login` 跑完整流程時，會在 id_token 的 claim 裡看到 `nonce`——那是 Spring 自動加的。

---

## 6.5 `oauth2Login`：Spring 幫你做完整個流程

6.2 那五、六步——導向、接 callback、驗 state、換 token、驗 id_token 簽章、建立登入 session——
**`oauth2Login` 全部幫你做**。你只要提供**一個 `ClientRegistration`**（＝在 Google 註冊的那個 client 的設定）。

### 6.5.1 設定一個 client

```java
package com.example.lab09.ch06;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.client.registration.*;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.*;

import java.util.*;

@Configuration
@Profile("client")
public class ClientScenario {

    /** 一個 ClientRegistration = 「在 Google Cloud Console 註冊的那個 OAuth client」的本地版 */
    @Bean
    ClientRegistrationRepository clientRegistrationRepository(
            @Value("${client.as-issuer}") String issuer) {
        ClientRegistration shop = ClientRegistration.withRegistrationId("shop")
                .clientId("shop-web")
                .clientSecret("shop-web-secret")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri("{baseUrl}/login/oauth2/code/{registrationId}")   // Spring 自動接的 callback
                .scope("openid", "email", "order:read")
                // 這四個 URI 真接 Google 時是照它的 /.well-known 自動填的；這裡指向本機 AS
                .authorizationUri(issuer + "/oauth2/authorize")
                .tokenUri(issuer + "/oauth2/token")
                .jwkSetUri(issuer + "/oauth2/jwks")
                .userInfoUri(issuer + "/userinfo")
                .userNameAttributeName("sub")
                .issuerUri(issuer)
                .clientName("用 Shop 帳號登入")
                .build();
        return new InMemoryClientRegistrationRepository(shop);
    }

    @Bean
    SecurityFilterChain clientChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(a -> a
                        .requestMatchers("/client/public").permitAll()
                        .anyRequest().authenticated())
            .oauth2Login(Customizer.withDefaults())      // ★ 就這一行，整個流程 Spring 包了
            .csrf(c -> c.disable());
        return http.build();
    }

    @RestController
    @Profile("client")
    static class ClientEndpoints {
        @GetMapping("/client/public")
        public String pub() { return "public"; }

        @GetMapping("/client/me")
        public Map<String, Object> me(@AuthenticationPrincipal OidcUser user) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("sub", user.getSubject());               // Google 給的穩定 id
            m.put("email", user.getEmail());
            m.put("claims", user.getClaims().keySet());
            m.put("authorities", user.getAuthorities().toString());
            return m;
        }
    }
}
```

> 📌 **真接 Google 時，設定更短**——因為 Google 公布了 `/.well-known/openid-configuration`，
> Spring 會自動抓那四個 URI。你的 `application.yml` 只要：
> ```yaml
> spring.security.oauth2.client.registration.google:
>   client-id: ...
>   client-secret: ...
>   scope: openid, email, profile
> spring.security.oauth2.client.provider.google.issuer-uri: https://accounts.google.com
> ```
> Spring Boot 內建了 `google` / `github` / `facebook` / `okta` 的 provider 預設，連 `provider` 那段常常都省了。

### 6.5.2 實測：端到端用「Google」登入

起兩台 server（你的網站 `client` + 本機 AS），用一個瀏覽器替身把整個流程跑完。
**注意輸出裡使用者從頭到尾只在 AS 輸入密碼，你的網站只寫了那一行 `.oauth2Login()`**：

```java
    @Test
    void loginWithGoogle() {
        int asPort = As.freePort(), clientPort = As.freePort();
        try (As as = new As(asPort,
                new String[]{"as.web-redirect=http://localhost:" + clientPort + "/login/oauth2/code/shop"})) {
            // 起你的網站（client），issuer 指向本機 AS，session cookie 改名避免跟 AS 互蓋
            ConfigurableApplicationContext client = new SpringApplicationBuilder(...)
                    .profiles("client")
                    .properties("server.port=" + clientPort,
                            "server.servlet.session.cookie.name=CLIENTSESSION",
                            "client.as-issuer=" + as.issuer).run();
            // 用瀏覽器替身：① 打受保護頁 → ② 被導去 AS → ③ 在 AS 登入 → ④ 跟隨轉址回來
            // 完整程式碼見 lab09 OAuth2LoginTest
        }
    }
```

**輸出**：

```
═══ 6.5.2 端到端：用「Google」登入 ═══
你的網站 client 跑在 :51989，Authorization Server（Google）跑在 :51988

① 沒登入就打受保護的 /client/me：
   → 302  Location: http://localhost:51989/oauth2/authorization/shop（client 把你導向它自己的 oauth2 起點）

② 跟隨到 /oauth2/authorization/shop（Spring 在這裡組出 authorize 請求，導去 AS）：
   → 302
   Location（導去 AS，注意 state 與 scope 都是 Spring 幫你帶的）：
     http://localhost:51988/oauth2/authorize?response_type=code&client_id=shop-web&scope=openid%20email%20order:read&state=c6A48Uw9oLryjUb4BdQTrtmwAo4H_wKC…

③ 跟隨到 AS，沒登入 → AS 的登入頁；在 AS 登入：
   POST AS /login → 302

④ 登入後一路跟隨轉址（AS 發 code → 導回 client callback → client 換 token → 建 session）：
   最終 → 200  body={"sub":"sub-6f5d97fce","email":"user@gmail.com",
                     "claims":["sub","aud","email_verified","azp","auth_time","iss","exp","iat","nonce","email","jti","sid"],
                     "authorities":"[OIDC_USER, SCOPE_email, SCOPE_openid, SCOPE_order:read]"}

★ 使用者從頭到尾沒把密碼給你的網站 —— 只在 AS（Google）輸入。
  你的網站只寫了【一行 .oauth2Login()】+ 一個 ClientRegistration，其餘 Spring 全包。
```

**對照 6.2 手動跑的五步，看 Spring 幫你做了什麼**：

```
6.2 你手動做的                          6.5 oauth2Login 自動做的
────────────────────────────────────────────────────────────
組 authorize URL（帶 state / PKCE）  →  自動（步驟 ②，state 就在 Location 裡）
在 AS 登入                          →  這一步是使用者做的（在 Google）
拿 code                             →  自動接 callback（/login/oauth2/code/shop）
驗 state                           →  自動（對不上就拒絕）
換 token（帶 secret）               →  自動（後端做，步驟 ④）
驗 id_token 簽章（用 AS 的 JWKS）    →  自動（RS256 公鑰驗，5.2.3）
驗 nonce                           →  自動（你在 claims 裡看到的那個 nonce）
建立登入 session                    →  自動（放 CLIENTSESSION cookie）
```

### 6.5.3 登入後拿到什麼：`OidcUser`

`@AuthenticationPrincipal OidcUser user` 就是登入的人。它帶著 id_token 的所有 claim：

```
user.getSubject()      "sub-6f5d97fce"     ← 穩定的 sub（6.7 拿它當帳號主鍵）
user.getEmail()        "user@gmail.com"    ← email（顯示用，不當主鍵，6.7.3）
user.getAuthorities()  [OIDC_USER, SCOPE_email, SCOPE_openid, SCOPE_order:read]
```

> ⚠️ **`OidcUser` 是「Google 說的這個人」，還不是「你系統裡的那個人」。**
> 它沒有你的 `app_user.id`、沒有你的角色 / 權限。
> **把它接到你自己的帳號體系**——這是 6.7，也是「第三方登入」真正的工程量所在。

---

## 6.6 Resource Server：驗「別人發的」token

6.5 是「你的網站當 client 去登入」。這一節換一個角色：**你的 API 收到一張 AS 發的 `access_token`，怎麼驗？**
答案就是 05 章 5.4.4 的 `oauth2ResourceServer`——**差別只在金鑰從哪來**：

```
05 章 5.4.4：token 是【你自己】用對稱金鑰簽的 → 用同一把金鑰驗
06 章 6.6：  token 是【AS】用私鑰簽的        → 去 AS 的 JWKS 端點【抓公鑰】驗（5.2.3 非對稱）
```

### 6.6.1 設定：`jwkSetUri` 指向 AS

```java
package com.example.lab09.ch06;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.*;

import java.util.*;

@Configuration
@Profile("rs")
public class ResourceServerScenario {

    @Bean
    JwtDecoder jwtDecoder(@Value("${rs.jwks-uri}") String jwksUri,
                          @Value("${rs.issuer}") String issuer) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwksUri).build();
        // ★ 驗 iss（5.8.2）+ 時間 —— 只信「這台 AS 發的」
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(issuer));
        return decoder;
    }

    @Bean
    SecurityFilterChain rsChain(HttpSecurity http, JwtDecoder decoder) throws Exception {
        return http
                .securityMatcher("/rs/**")
                .authorizeHttpRequests(a -> a
                        .requestMatchers("/rs/orders").hasAuthority("SCOPE_order:read")  // ★ scope → SCOPE_ 前綴
                        .anyRequest().authenticated())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(AbstractHttpConfigurer::disable)
                .oauth2ResourceServer(o -> o.jwt(j -> j.decoder(decoder)))               // 5.4.4 那條路
                .build();
    }

    @RestController
    @Profile("rs")
    static class RsEndpoints {
        @GetMapping("/rs/me")
        public Map<String, Object> me(org.springframework.security.core.Authentication a) {
            return new LinkedHashMap<>(Map.of(
                    "name", a.getName(),                                   // = token 的 sub
                    "authorities", a.getAuthorities().toString()));        // scope 轉成的 authority
        }
        @GetMapping("/rs/orders")
        public Map<String, Object> orders() { return Map.of("orders", List.of("A-1001", "A-1002")); }
    }
}
```

> 📌 **真接 Google API 時只要一行設定**：
> ```yaml
> spring.security.oauth2.resourceserver.jwt.issuer-uri: https://accounts.google.com
> ```
> Spring 自動從 `issuer-uri` 抓 `/.well-known/openid-configuration` → 找到 `jwks_uri` → 抓公鑰。
> 而且它會**快取公鑰、自動處理金鑰輪替**——AS 換金鑰時，Resource Server 會自己重新抓。

### 6.6.2 實測：RS 用 AS 的公鑰驗 access_token

```java
    @Test @Order(2)
    void b_resourceServer() {
        try (As as = new As()) {
            String accessToken = As.jsonField(as.authCodeTokens("user@gmail.com"), "access_token");
            try (ConfigurableApplicationContext rs = startRs(as)) {   // JWKS 指向 as.issuer + /oauth2/jwks
                Http http = new Http(rsPort);
                // 不帶 token / 帶 token / 需要 scope 的端點 / 改壞的 token
            }
        }
    }
```

**輸出**：

```
═══ 6.6 Resource Server 驗「AS 發的」token ═══
Resource Server 跑在 :51866，JWKS 指向 AS http://localhost:51864/oauth2/jwks

① 不帶 token 打 /rs/me → 401

② 帶 AS 發的 access_token 打 /rs/me：
   → 200  {"name":"user@gmail.com","authorities":"[SCOPE_openid, SCOPE_order:read, SCOPE_email]"}
   ★ RS 從沒看過這個 token，卻驗得過 —— 因為它去 AS 的 JWKS 抓了公鑰（5.2.3 非對稱）

③ /rs/orders 需要 SCOPE_order:read：
   → 200  {"orders":["A-1001","A-1002"]}（scope "order:read" → authority "SCOPE_order:read"）

④ 亂改一個字元的 token：
   → 401  Bearer error="invalid_token", error_description="...Signed JWT rejected: Invalid signature...",
          error_uri="https://tools.ietf.org/html/rfc6750#section-3.1"
```

**「RS 從沒看過這個 token 卻驗得過」是非對稱的核心價值**（回到 5.2.3）：

```
AS 用【私鑰】簽 → 只有 AS 能發 token
RS 用【公鑰】驗 → 任何人都能驗，但【不能偽造】
→ 你可以有一百個 Resource Server，全部拿 AS 的公鑰驗，沒有一個能發假 token
  （如果用對稱金鑰，每個 RS 都要有金鑰 = 每個 RS 都能發 token = 災難）
```

### 6.6.3 `scope` vs `authority`

注意 ② 的 authorities 是 `SCOPE_openid`、`SCOPE_order:read`——**Spring 把 token 的 `scope` 自動加了 `SCOPE_` 前綴**變成 authority。這跟 03 章的 `ROLE_` 前綴是同一個機制的不同前綴：

```
03 章：角色 ROLE_ADMIN     → URL 層用 hasRole("ADMIN") / hasAuthority("ROLE_ADMIN")
06 章：scope order:read    → 用 hasAuthority("SCOPE_order:read")
```

> ⚠️ **scope 不等於你系統的權限。** scope 是「使用者授權這個 client 能碰的範圍」（例如「讀你的 email」），
> 不是「這個使用者在你系統裡的角色」。真實系統常常是：**scope 決定 client 能問什麼，
> 你自己的 RBAC（03 章）決定這個使用者能做什麼**——兩層是疊加的。

---

## 6.7 與自家帳號綁定

6.5 拿到了 `OidcUser`（Google 說的這個人），但它還不是你系統裡的帳號。
這一節把它接到 `app_user`——**這是「第三方登入」真正的工程量，也是最多人做錯的地方**。

### 6.7.1 / 6.7.2 用 `sub` 認人：第一次建帳號，之後找回同一個

```java
package com.example.lab09.ch06;

import org.springframework.context.annotation.Profile;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;

/**
 * 6.7：把「Google 登入的人」對應到你自己的 app_user。
 *
 * ★ 核心決定：用 (provider, sub) 當【唯一鍵】，不是 email。
 *   - sub 是 provider 保證【穩定且唯一】的 id（真 Google 是一串數字）
 *   - email 會變（使用者改 email）、會被回收（公司信箱離職後給別人）—— 拿 email 當鍵會把兩個人混在一起（6.7.3）
 */
@Service
@Profile("social")
public class SocialAccountService {

    private final JdbcTemplate jdbc;
    public SocialAccountService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public record Result(long userId, boolean created) {}

    /** 第一次登入 → 建 app_user + 建 social_identity；之後 → 用 (provider,sub) 找回同一個 user。 */
    @Transactional
    public Result loginOrRegister(String provider, String sub, String email, String displayName) {
        try {
            Long userId = jdbc.queryForObject(
                    "SELECT user_id FROM social_identity WHERE provider=? AND subject=?",
                    Long.class, provider, sub);
            return new Result(userId, false);                       // 老朋友，用 sub 認出來
        } catch (EmptyResultDataAccessException notLinkedYet) {
            // 第一次用這個 provider 登入 —— 建一個本地帳號（沒有密碼，放不可登入的標記）
            jdbc.update("""
                    INSERT INTO app_user (username, password_hash, display_name, enabled,
                                          account_non_expired, account_non_locked, token_version)
                    VALUES (?, '{noop}!external!', ?, TRUE, TRUE, TRUE, 0)""",
                    provider + ":" + sub, displayName == null ? email : displayName);
            long userId = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
            jdbc.update("""
                    INSERT INTO social_identity (provider, subject, user_id, email_at_link, linked_at)
                    VALUES (?,?,?,?,?)""",
                    provider, sub, userId, email, Timestamp.from(Instant.now()));
            return new Result(userId, true);                        // 新朋友
        }
    }

    /** 帳號連結：把一個 social identity 綁到【已存在】的本地帳號（6.7.4）*/
    @Transactional
    public void link(String provider, String sub, String email, long existingUserId) {
        jdbc.update("""
                INSERT INTO social_identity (provider, subject, user_id, email_at_link, linked_at)
                VALUES (?,?,?,?,?)""",
                provider, sub, existingUserId, email, Timestamp.from(Instant.now()));
    }
}
```

**輸出**：

```
═══ 6.7.1/6.7.2 第一次登入建帳號，之後用 sub 認出同一個人 ═══

① 第一次用 Google 登入（sub=sub-108commonstableid，email=alice@gmail.com）：
   created=true  userId=6895（建了一個新的 app_user）
   social_identity: {id=1, provider=google, subject=sub-108commonstableid, user_id=6895,
                     email_at_link=alice@gmail.com, linked_at=...}

② 同一個人第二次登入（sub 一樣，但 email 改成 alice@newjob.com）：
   created=false  userId=6895
   ★ 認出是同一個人（userId 相同）—— 靠的是 sub，不是 email。email 變了也沒差。
```

**接進 6.5 的 `oauth2Login`**：登入成功後，用 `OidcUser` 的 `sub` 呼叫 `loginOrRegister`，
把回傳的 `app_user.id` 放進你自己的 principal（或直接建一個你自己的 session）。
Spring 提供 `OidcUserService` 讓你在登入流程裡掛這一步——把「Google 的人」換成「你系統的人」。

### 6.7.3 🔴 實測：用 `email` 當主鍵的災難

這是第三方登入最經典、也最嚴重的錯誤。很多人覺得「email 不就是唯一的嗎」——**不是**：

```
═══ 6.7.3 🔴 如果用 email 當鍵會怎樣 ═══
【情境一：使用者換 email】
  用 email 當鍵：alice@gmail.com → alice@newjob.com，系統把她當成【新的人】，
  她的訂單、設定全部不見（其實是同一個人，只是換了信箱）。
  用 sub 當鍵：sub 不變，一切正常。

【情境二：email 被回收】🔴 更危險
  alice@company.com 離職，公司把這個信箱給了新員工 bob。
  用 email 當鍵：bob 用 Google 登入，系統用 email 找到了 alice 的帳號 ——
  bob 直接【變成 alice】，看到她所有的訂單。這是真實發生過的資安事故。
  用 sub 當鍵：bob 的 sub 跟 alice 不同，是兩個帳號。安全。

驗證：同一個 email、不同的 sub，會建出【兩個】不同的帳號：
   alice userId=6896（created=true）
   bob   userId=6897（created=true）
   同 email、不同 sub → 不同帳號？ true
```

> 🔴 **鐵則：帳號主鍵用 `(provider, sub)`，永遠不要用 email。**
> `sub` 是 provider 保證「穩定 + 唯一 + 不重新分配」的。email 三者都不保證。
> `email` 只拿來**顯示**和**輔助帳號連結的判斷**（而且要看 `email_verified`）。

### 6.7.4 帳號連結：同一個人綁 Google + 自家密碼

使用者可能先用帳密註冊，之後想「連結 Google 一鍵登入」；或反過來。
`(provider, sub)` 當鍵讓這件事很自然——**一個 `app_user` 可以有多筆 `social_identity`**：

```
═══ 6.7.4 帳號連結：同一個人綁 Google + 自家帳號 ═══
① 本地帳密帳號 alice 的 userId = 6887
② alice 在設定頁點『連結 Google』——把她的 Google identity 綁到【現有】帳號：
   之後她用 Google 登入 → userId=6887（created=false）= 同一個 alice，不是新帳號
```

> ⚠️ **帳號連結有一個安全前提**：連結時要確認「這個 Google 帳號的主人，真的就是現在登入的這個本地使用者」。
> 常見做法：**要求使用者當下已經登入本地帳號**，才能發起連結（而不是「email 一樣就自動合併」——
> 那又踩回 6.7.3 的坑）。自動合併只在 `email_verified=true` **且**你信任該 provider 的 email 驗證時才考慮。

---

## 6.8 常見錯誤用法

**① 把 client secret 放進前端（SPA / App）**（6.3.1）
→ 前端程式碼人人可下載。公開 client 用 PKCE，不用 secret。

**② 手刻 OAuth flow 卻漏了 `state`**（6.2.4）
→ login CSRF：受害者帳號被綁上攻擊者的 Google 身分。用 `oauth2Login` 就自動有 state。

**③ 拿 `id_token` 去打 API**（6.4.1）
→ `id_token` 是「給 client 的身分證明」，`access_token` 才是「存取權」。角色搞反。

**④ 用 `email` 當帳號主鍵**（6.7.3）
→ email 會變、會被回收。用 `(provider, sub)`。

**⑤ 驗 token 不驗 `iss` / `aud`**（回到 5.8.2）
→ 別的 AS（或別的 client）的 token 也被你接受。`issuer-uri` 會自動驗 `iss`；`aud` 要自己確認是給你的。

**⑥ 信任 `email` 沒看 `email_verified`**
→ 有些 provider 允許未驗證的 email。拿它做任何判斷前先看 `email_verified`。

**⑦ 自己跑 AS 卻用 `InMemory...` 上線**
→ 本章的 `InMemoryRegisteredClientRepository` / 記憶體金鑰是**實驗用**。
真要當 SSO 提供者，client、授權紀錄、金鑰都要進資料庫，金鑰要能輪替。

**⑧ scope 當成系統權限**（6.6.3）
→ scope 是「client 能碰的範圍」，不是「使用者的角色」。系統權限用你自己的 RBAC（03 章）。

---

## 6.9 shop-service 落地

05 章的 shop 有兩條 chain：`/api/**`（JWT）與後台網頁（session）。這一章加上**第三方登入**，
但**不打掉原本的帳密登入**——兩者並存，透過 6.7 的 `social_identity` 綁到同一個 `app_user`。

**① 後台網頁那條 chain 加上 `oauth2Login`**（跟原本的 `formLogin` 並存）：

```java
@Bean
@Order(2)
SecurityFilterChain webChain(HttpSecurity http, AuthenticationManager am,
                             SessionRegistry registry) throws Exception {
    return http
        .authorizeHttpRequests(a -> a
            .requestMatchers("/actuator/health", "/login/**", "/oauth2/**").permitAll()
            .anyRequest().authenticated())
        .formLogin(Customizer.withDefaults())            // 04 章：原本的帳密登入，保留
        .oauth2Login(o -> o                              // 06 章：加上「用 Google 登入」
            .userInfoEndpoint(u -> u.oidcUserService(shopOidcUserService)))   // ★ 掛 6.7 的綁定
        // session 管理（04 章 4.8）、CSRF 開著（4.5.1）都不變
        .sessionManagement(s -> s.sessionFixation(f -> f.changeSessionId())
            .maximumSessions(5).sessionRegistry(registry))
        .logout(l -> l.logoutSuccessUrl("/login?logout").invalidateHttpSession(true))
        .build();
}
```

**② 一個 `OidcUserService`：登入成功後，把 Google 的人換成你系統的人**（接 6.7）：

```java
/**
 * 06 章的關鍵接點：oauth2Login 驗完 Google 的 id_token 後呼叫這裡，
 * 我們用 sub 對應 / 建立 app_user，並把 app_user 的角色 / 權限【疊加】上去（6.6.3）。
 */
@Bean
OAuth2UserService<OidcUserRequest, OidcUser> shopOidcUserService(SocialAccountService social,
                                                                 JdbcTemplate jdbc) {
    OidcUserService delegate = new OidcUserService();
    return request -> {
        OidcUser oidc = delegate.loadUser(request);                    // Spring 驗好的「Google 的人」
        String provider = request.getClientRegistration().getRegistrationId();
        var r = social.loginOrRegister(provider, oidc.getSubject(),
                oidc.getEmail(), oidc.getFullName());                  // 6.7：用 sub 綁到 app_user
        // 把你系統的角色 / 權限查出來，疊加到 Google 給的 scope 上（6.6.3）
        Set<GrantedAuthority> authorities = new LinkedHashSet<>(oidc.getAuthorities());
        authorities.addAll(loadAppAuthorities(jdbc, r.userId()));      // 你自己的 RBAC（03 章）
        // 回一個帶著「你系統身分」的 OidcUser（userId 塞進 attributes，之後 @AuthenticationPrincipal 拿得到）
        return new DefaultOidcUser(authorities, oidc.getIdToken(), oidc.getUserInfo(), "sub");
    };
}
```

**③ 本章結束時，shop-service 的登入入口**：

```
帳密登入（05 章）        POST /api/auth/login → JWT；後台 formLogin → session
第三方登入（06 章）      oauth2Login「用 Google 登入」→ 綁到同一個 app_user（6.7）
帳號綁定                social_identity 表：(provider, sub) → app_user.id
權限                    Google 的 scope + 你自己的 RBAC 角色【疊加】（6.6.3）
API 收 token            oauth2ResourceServer 可同時驗「自家 JWT」與「AS 的 token」（多 issuer）
```

⚠️ **還沒有的東西**（交給後面章節）：

```
🔴 CORS 還沒設 —— 前後端分離 + 第三方登入的跳轉一定會遇到                → 07 章
🔴 登入失敗 / 異常登入的偵測與鎖定                                      → 07 章
🔴 稽核：誰在什麼時候用什麼方式（密碼 / Google）登入                     → 08 章
🔴 單一登出（OIDC back-channel logout，用到 6.4.2 的 sid）              → 視需求
```

---

## 6.10 常見誤區

**誤區 1：「OAuth2 是拿來登入的」**
→ OAuth2 是**授權**（拿存取權）。**登入（認證）是 OIDC** 加上去的（`id_token`）。
很多「OAuth 登入」的坑，都來自把純 OAuth2（只有 access_token）當成登入用——
那樣你只知道「有人授權了」，不知道「他是誰」。

**誤區 2：「用 Google 登入，我就不用管密碼安全了」**
→ 你不管 Google 帳號的密碼，但你要管：帳號綁定（6.7）、session（04 章）、
你自己發的 token（如果登入後你還發 JWT，05 章那一整套撤銷 / 過期都還在）。

**誤區 3：「access_token 和 id_token 差不多，用哪個都行」**
→ 6.4：打 API 用 access_token，識別使用者用 id_token。用錯會被嚴謹的 Resource Server 拒絕。

**誤區 4：「redirect_uri 設寬一點比較方便」**
→ redirect_uri 必須**精確比對**且**白名單**。設成萬用或開放轉址，等於把 code 送去攻擊者的網址。
本章 AS 對 redirect_uri 精確比對就是這個原因（6.1.3 的 `webRedirect`）。

**誤區 5：「PKCE 只有手機 App 要用」**
→ 現在的建議是**所有 client 都用 PKCE**，包括機密 client。多一層沒壞處（6.3.3）。

**誤區 6：「email 一樣就是同一個人」**
→ 6.7.3：email 會變、會被回收。用 `(provider, sub)`。

**誤區 7：「自己 render 一個框讓使用者輸入 Google 密碼」**
→ 6.2.1：那正是 OAuth2 要消滅的。密碼只能在 Google 的頁面輸入，你的網站永遠看不到。

---

## 6.11 本章小結

```
6.1  角色      四個角色；你的網站同時是 Client（登入）與 Resource Server（驗 token）
6.2  授權碼流程  五、六步的 redirect；code 一次性；state 擋 CSRF
6.3  PKCE      公開 client 沒 secret，用 SHA256 單向性取代；擋授權碼攔截
6.4  OIDC      id_token（給 client：誰）vs access_token（給 API：能做什麼）—— 都是 JWT
6.5  oauth2Login  一行 + 一個 ClientRegistration，Spring 包了整個流程
6.6  Resource Server  用 AS 的公鑰（JWKS）驗 token —— 5.4.4 的路，換金鑰來源
6.7  帳號綁定   用 (provider, sub) 對應 app_user；🔴 永遠不用 email 當鍵
```

**一句話帶走**：

> **OAuth2 讓密碼只留在 AS，你的網站只拿到「被證明過的」token。**
> 這一章的每一個機制（code、state、PKCE、id/access token、sub）都在回答同一個問題：
> **「怎麼在不碰密碼的前提下，安全地知道『這個人是誰』、並拿到『代表他做事』的權限。」**

### 6.11.1 驗收清單

```
□ OAuth2 的四個角色各是誰？你的網站什麼時候是 Client、什麼時候是 Resource Server？
□ 授權碼流程的五、六步，每一步在傳什麼？密碼在哪一步、只到哪裡？
□ 為什麼要「先給 code、再用 code 換 token」，而不是直接給 token？
□ authorization code 為什麼只能用一次？重用會怎樣？
□ state 擋的是什麼攻擊？漏了它會怎樣？
□ 公開 client 為什麼不能有 secret？PKCE 怎麼補？
□ code_challenge / code_verifier 的關係？攔到 code 的人為什麼換不到 token？
□ id_token 與 access_token 的分工？各給誰看？拿錯會怎樣？
□ nonce / auth_time / sid 各是做什麼的？
□ oauth2Login 幫你自動做了哪八件事（對照 6.2 手動的五步）？
□ Resource Server 驗 AS 的 token，公鑰從哪來？為什麼「沒看過的 token」也驗得過？
□ 對稱 vs 非對稱，為什麼多個 Resource Server 一定要用非對稱？
□ scope 和你系統的權限一樣嗎？SCOPE_ 前綴？
□ 帳號主鍵為什麼用 (provider, sub) 不用 email？email 被回收的災難是什麼？
□ 帳號連結的安全前提是什麼？
```

### 6.11.2 本章練習

**練習一（觀察）：把你自己的 Google id_token 拆開**
1. 用任何一個「Google 登入」的網站登入，從 devtools 撈出 id_token（或用 Google OAuth Playground）。
2. 貼進 05 章的 `TokenScope`。看 `iss`（是不是 `accounts.google.com`）、`sub`（一串數字）、`aud`（你的 client_id）、`exp`。
3. **注意 `sub` 不是你的 email** —— 這就是 6.7.2 說的。

**練習二（動手）：接一個真的 provider**
1. 去 GitHub Developer Settings 註冊一個 OAuth App，拿 client id / secret。
2. `application.yml` 設 `spring.security.oauth2.client.registration.github`。
3. 加 `.oauth2Login()`，跑起來，點「用 GitHub 登入」。
4. 用 `@AuthenticationPrincipal OAuth2User` 印出 GitHub 給你的 attributes。

**練習三（攻擊思考）：畫出你系統漏掉 state 會怎樣**
1. 假設你手刻 OAuth flow 且沒驗 state。
2. 寫出攻擊者怎麼把「他自己的 code」塞給受害者，讓受害者帳號綁上攻擊者的 Google。
3. 對照 `oauth2Login` 的封包（6.5.2），找出 Spring 在哪一步驗了 state。

**練習四（設計）：畫出你系統的「帳號綁定」表**
```
一個 app_user 可以有幾筆 social_identity？（多筆 = 支援綁多個 provider）
使用者先帳密註冊、後綁 Google —— 綁定時怎麼確認「這個 Google 帳號真的是他的」？
兩個 provider 回報同一個 email —— 要自動合併嗎？email_verified 是 true 嗎？
使用者「解除綁定 Google」—— 如果他【只有】Google 登入、沒設密碼，能解除嗎？
```

**練習五（判斷）：id_token 還是 access_token？**
對你系統的每一個用途，選一個：
```
判斷「登入頁要顯示誰的名字」        → id_token / access_token ?
呼叫 /api/orders 帶的那張票        → id_token / access_token ?
後端記錄「誰登入了」的稽核          → id_token / access_token ?
```

---

## 6.12 下一章預告

**07 章：CORS 與常見漏洞。**

這一章讓「第三方登入」跑起來了，但只要**前後端分離**（前端一個網域、API 另一個網域），
下一個馬上撞到的牆就是 **CORS**——而 CORS 跟 Security、跟 04 章的 CSRF 會互相糾纏。

```
06 章：使用者 → Google → 你的網站（同一條 server 端流程）
07 章：前端(app.example.com) → 你的 API(api.example.com) —— 跨網域，瀏覽器先問「你准我打嗎」
```

📌 **07 章會回答的問題**：

```
① CORS 到底是誰在擋（瀏覽器，不是你的伺服器）？preflight（OPTIONS）在問什麼？
② CorsFilter 與 Spring Security 的順序 —— 為什麼 CORS 設了還是被擋（401 先發生）
③ 帳號列舉：登入失敗訊息、註冊、忘記密碼 —— 三個地方洩漏「這個帳號存不存在」
④ 暴力破解與鎖定：登入失敗計數、指數退避、什麼時候該上 CAPTCHA
⑤ 安全標頭：CSP、HSTS、X-Content-Type-Options —— Spring Security 預設給了哪些
⑥ 機敏資料外洩：錯誤訊息、堆疊、log 裡的 token（回到 5.4.3）
```

⚠️ **順帶預告一個 07 章的實測**：
一個設定成 `allowedOrigins("*")` **且** `allowCredentials(true)` 的 CORS——
07 章會用一個實測告訴你，為什麼這個組合**瀏覽器直接拒絕**，以及為什麼「改成能動」的那個常見做法
（反射 `Origin` 回去）其實是把大門打開。
