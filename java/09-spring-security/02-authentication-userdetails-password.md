# 第 02 章：認證機制

> 01 章 1.3.2 那份 TRACE 日誌裡有三行，我們當時跳過了：
>
> ```
> BasicAuthenticationFilter : Found username 'alice' in Basic Authorization header
> ProviderManager           : Authenticating request with DaoAuthenticationProvider (1/1)
> DaoAuthenticationProvider : Authenticated user
> ```
>
> **三個名字，三層委派。** 這一章要把這三層拆開，然後回答一個 01 章刻意迴避的問題：
>
> > **`BasicAuthenticationFilter` 拿到 `alice / pw` 之後，到底是誰去確認這組帳密是對的？**
>
> 拆開之後你會發現，這三層的分工非常乾淨：
>
> ```
> ① Filter    ── 只負責【從 HTTP 請求裡把憑證挖出來】，它不驗證任何東西
> ② Manager   ── 只負責【找一個能處理這種憑證的人】，它也不驗證任何東西
> ③ Provider  ── 真正驗證的人；它去哪裡查帳號、怎麼比對密碼，是【你】決定的
> ```
>
> 📌 **這一章有三十八個實測。** 其中五個值得先劇透，因為它們會改變你寫程式的方式：
>
> ```
> 2.3.3  已經登入的 session 再帶一次 Basic，密碼【打錯也是 200】
> 2.3.5  同一支端點，Basic 認證 12.8 個/秒、cookie 1368 個/秒 —— 差 107 倍
> 2.5.3  UserDetailsService 把 throw 寫成 return null，00 章那個「22873 倍」時間差就原封不動回來
> 2.6.3  容器裡有【兩個】UserDetailsService bean → 啟動成功，第一次登入 StackOverflowError
> 2.7.7  使用者登入後你把他的帳號鎖起來 —— 他手上的 session 【照樣能用】
> ```
>
> ⚠️ **從這一章開始，帳號不再寫死在 `application.yml`。**
> 00 章 0.8.1 那個 H2 記憶體資料庫換成真的 MySQL，
> 因為「帳號被鎖定 / 密碼過期 / 雜湊被自動升級」這幾件事，**要真的持久化才測得出來**。

---

## 2.1 學習目標與實驗環境

完成本章後，你應該可以：

- 畫出認證的三層委派，並說出每一層**不**負責什麼（2.2）。
- 說明一個 `Authentication` 物件在認證前後的三個狀態，
  以及 `credentials` 是在**哪一行**被抹掉的（2.2.2、2.4.5）。
- 說出 `AbstractAuthenticationProcessingFilter` 的六個步驟，
  並指出 `BasicAuthenticationFilter` 為什麼**不是**它的子類（2.3.1、2.3.3）。
- 解釋 `authenticationIsRequired()` 這個最佳化，
  以及它造成的「**帶錯密碼也通過**」現象（2.3.3 實測）。
- 用數字說明「HTTP Basic 保護的 API 為什麼撐不住流量」，
  並算出你自己的服務在目前 `cost` 下的吞吐量上限（2.3.5 實測：**73.4 個/秒**）。
- 把預設的表單登入改成一支回 JSON 的登入端點（2.3.6）。
- 說出 `ProviderManager` 迴圈的六條規則，
  特別是**哪兩種例外會立刻中止迴圈**、以及 `return null` 與 `throw` 的差別（2.4）。
- 讀懂 `DaoAuthenticationProvider.authenticate()` 的七個步驟，
  並指出計時攻擊防護是**哪一行**（2.5.2）。
- 說出**四種讓那個防護失效的寫法**，其中三種是你自己寫 `UserDetailsService` 時的常見錯誤（2.5.3 實測）。
- 解釋 `AuthenticationManager` 為什麼**不是** bean，並在四種取得方式中選對一種（2.6）。
- 診斷「容器裡有兩個 `UserDetailsService`」造成的 `StackOverflowError`（2.6.3 實測）。
- 把帳號搬到資料庫：設計 schema、實作 `UserDetailsService`，
  並說明**為什麼不要讓 Entity 直接 `implements UserDetails`**（2.7.3 實測：`LazyInitializationException`）。
- 說出 `UserDetails` 五個布林值各自對應什麼例外、在**密碼比對之前還是之後**被檢查（2.7.6）。
- 用 `UserDetailsPasswordService` 做密碼的漸進升級，使用者完全無感（2.8 實測）。
- 寫出一份符合 NIST 800-63B 的密碼規則，並說明「大小寫 + 數字 + 符號」為什麼是**錯的方向**（2.9）。
- 在自訂認證的三個層次中選對一層，並各自實作一次（2.10）。

### 2.1.1 本章的實驗環境

**這一章的每一個數字都在同一個環境上跑出來的**，先把它建起來。

**① 一個真的 MySQL**（00 章的 H2 記憶體資料庫從這一章起換掉）：

```
docker run -d --name sec-mysql -p 33307:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=lab09 \
  mysql:8.0 --max_connections=600
```

**② 兩張表**（2.7.2 會逐欄解釋這些設計決定）：

```sql
CREATE TABLE app_user (
  id                    BIGINT       NOT NULL AUTO_INCREMENT,
  username              VARCHAR(64)  NOT NULL,
  password_hash         VARCHAR(100) NOT NULL COMMENT '含 {演算法} 前綴（00 章 0.7.5）',
  display_name          VARCHAR(64)  NOT NULL,
  enabled               BOOLEAN      NOT NULL DEFAULT TRUE,
  account_non_expired   BOOLEAN      NOT NULL DEFAULT TRUE,
  account_non_locked    BOOLEAN      NOT NULL DEFAULT TRUE,
  credentials_expire_at DATETIME     NULL COMMENT 'NULL = 永不過期',
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_app_user_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE authority (
  id        BIGINT      NOT NULL AUTO_INCREMENT,
  user_id   BIGINT      NOT NULL,
  authority VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_authority (user_id, authority),
  CONSTRAINT fk_authority_user FOREIGN KEY (user_id) REFERENCES app_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**③ 一個 `db` profile 的資料來源設定**（`src/main/resources/application-db.yml`）：

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:33307/lab09?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Taipei
    username: root
    password: root
    driver-class-name: com.mysql.cj.jdbc.Driver
  jpa:
    hibernate:
      ddl-auto: none          # ⚠️ schema 自己管，不要讓 Hibernate 改動帳號表
    open-in-view: false       # 06 站 05 章的結論
    properties:
      hibernate:
        generate_statistics: true    # ★ 2.7.4 / 2.7.5 用它數 SQL 句數
```

**④ 每個情境一個 profile**（用 `@ActiveProfiles` 切換，跟 01 章的做法一樣）：

| profile | 情境 | 用在哪些實測 |
|---|---|---|
| `p3` | 三層委派的探針（記憶體帳號） | 2.2.2、2.2.3 |
| `db` + `db1` | Basic + `STATELESS`，帳號來自 MySQL | 2.7.2、2.7.4、2.7.5、2.7.6 |
| `db` + `db2` | Basic + **明確**存進 session | 2.3.3、2.3.4、2.3.5、2.7.4、2.7.7 |
| `db` + `db3` | 🔴 Entity 直接 `implements UserDetails` | 2.7.3 |
| `db` + `db4` | 預設的表單登入 | 2.3.4 |
| `db` + `db5` | 權限走 LAZY（不 join fetch） | 2.7.5 |
| `db` + `db6` | 表單登入但回 JSON | 2.3.6 |
| `db` + `up` | 密碼漸進升級 | 2.8.2 |
| `am` + `am1`～`am8` | `AuthenticationManager` 的八種寫法 | 2.6.2（七種）、2.6.3（`@Primary`） |
| `ca` + `ca1` / `ca2` | 自訂認證的層次二 / 層次三 | 2.10.2、2.10.3 |

**⑤ 那些 profile 的安全設定**——放在一個類別裡，一個情境一個巢狀 `@Configuration`：

```java
package com.example.lab09.ch02;

import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** 本章實驗用的幾條 chain。成品版的設定在 2.11。 */
public class DbScenario {

    /** db1：Basic + 無狀態（每個請求都重新認證一次） */
    @Configuration
    @Profile("db1")
    static class Db1Stateless {
        @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .httpBasic(Customizer.withDefaults())
                       .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                       .csrf(c -> c.disable())
                       .build();
        }
    }

    /**
     * db2：Basic + 【明確】把認證結果存進 session。
     * ⚠️ Spring Security 6 的 BasicAuthenticationFilter 預設用
     *    RequestAttributeSecurityContextRepository —— 也就是【不存 session】（2.7.4）。
     */
    @Configuration
    @Profile("db2")
    static class Db2Session {
        @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .httpBasic(h -> h.securityContextRepository(
                               new HttpSessionSecurityContextRepository()))
                       .csrf(c -> c.disable())
                       .build();
        }
    }

    /** db3：🔴 故意用 Entity 當 UserDetails —— 2.7.3 的反例 */
    @Configuration
    @Profile("db3")
    static class Db3EntityAsUserDetails {
        @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }

        @Bean UserDetailsService uds(EntityUserRepo repo) {
            return username -> repo.findByUsername(username)
                    .orElseThrow(() -> new UsernameNotFoundException(username));
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .httpBasic(Customizer.withDefaults())
                       .csrf(c -> c.disable())
                       .build();
        }
    }

    /** db4：預設的表單登入 */
    @Configuration
    @Profile("db4")
    static class Db4FormLogin {
        @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .formLogin(Customizer.withDefaults())
                       .build();
        }
    }

    /** db5：不用 join fetch，權限走 LAZY —— 2.7.5 的對照組 */
    @Configuration
    @Profile("db5")
    static class Db5Lazy {
        @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }

        @Bean UserDetailsService uds(AppUserRepo repo, PlatformTransactionManager tx) {
            TransactionTemplate t = new TransactionTemplate(tx);
            return username -> t.execute(status -> {
                AppUser u = repo.findByUsername(username)                 // ← 只查 app_user
                        .orElseThrow(() -> new UsernameNotFoundException(username));
                return new DbUserDetailsService.AppUserDetails(u);        // ← 這裡才碰 authorities
            });
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .httpBasic(Customizer.withDefaults())
                       .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                       .csrf(c -> c.disable())
                       .build();
        }
    }

    /** up：密碼漸進升級（2.8） */
    @Configuration
    @Profile("up")
    static class UpgradeChain {
        @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }
        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .httpBasic(Customizer.withDefaults())
                       .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                       .csrf(c -> c.disable())
                       .build();
        }
    }
}
```

**db3 用到的 repository**（配合 2.7.3 那個反例的 Entity）：

```java
package com.example.lab09.ch02;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface EntityUserRepo extends JpaRepository<EntityAsUserDetails, Long> {
    Optional<EntityAsUserDetails> findByUsername(String username);
}
```

**⑥ 一支公用的測試端點**，本章所有 HTTP 實測都打它：

```java
package com.example.lab09.ch02;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.*;

@RestController
@RequestMapping("/whoami")
public class WhoAmIController {

    @GetMapping
    public Map<String, Object> me(Authentication auth,
                                  @AuthenticationPrincipal DbUserDetailsService.AppUserDetails me) {
        return new LinkedHashMap<>(Map.of(
                "name", auth.getName(),
                "principalType", auth.getPrincipal().getClass().getSimpleName(),
                "displayName", me == null ? "-" : me.getDisplayName(),   // ★ 自訂欄位，2.7.2 會解釋
                "authorities", auth.getAuthorities().toString()));
    }
}
```

**⑦ 七個帳號的固定裝置**，蓋掉 `UserDetails` 五個布林值的每一種狀態（2.7.6）：

```java
package com.example.lab09.ch02;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

public class Seed {

    public static final PasswordEncoder ENC = PasswordEncoderFactories.createDelegatingPasswordEncoder();

    public static void reset(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM authority");
        jdbc.update("DELETE FROM app_user");

        add(jdbc, "alice", "pw", "艾莉絲", true, true, true, null, "ROLE_USER");
        add(jdbc, "bob",   "pw", "巴布",   true, true, true, null, "ROLE_USER");
        add(jdbc, "admin", "pw", "管理員", true, true, true, null, "ROLE_USER", "ROLE_ADMIN", "order:refund");
        add(jdbc, "carol", "pw", "卡蘿",   false, true, true, null, "ROLE_USER");                 // disabled
        add(jdbc, "dave",  "pw", "戴夫",   true, true, false, null, "ROLE_USER");                 // locked
        add(jdbc, "erin",  "pw", "艾琳",   true, false, true, null, "ROLE_USER");                 // 帳號過期
        add(jdbc, "frank", "pw", "法蘭克", true, true, true, "2020-01-01 00:00:00", "ROLE_USER"); // 密碼過期
    }

    public static void add(JdbcTemplate jdbc, String username, String rawPw, String display,
                           boolean enabled, boolean nonExpired, boolean nonLocked,
                           String credExpireAt, String... authorities) {
        jdbc.update("""
                INSERT INTO app_user
                  (username, password_hash, display_name, enabled,
                   account_non_expired, account_non_locked, credentials_expire_at)
                VALUES (?,?,?,?,?,?,?)""",
                username, ENC.encode(rawPw), display, enabled, nonExpired, nonLocked, credExpireAt);
        Long id = jdbc.queryForObject("SELECT id FROM app_user WHERE username=?", Long.class, username);
        for (String a : authorities)
            jdbc.update("INSERT INTO authority (user_id, authority) VALUES (?,?)", id, a);
    }
}
```

⚠️ **這組固定裝置沿用 00 章 0.8.2 的原則：`alice` 與 `bob` 是【同角色的兩個帳號】。**
只有這樣，03 章才測得出「資源層授權」有沒有做。

⚠️ **實驗專案裡，00 章 0.3.0 那組記憶體帳號（`com.example.lab09.shop.Users`）
要標上 `@Profile("!db & !am & !ca")`**——
否則它會跟這一章的 `DbUserDetailsService` 同時存在，
變成「容器裡有兩個 `UserDetailsService`」，直接踩進 2.6.3 那個 `StackOverflowError`。

📌 **這件事本身就是 2.6.3 的預告**：
**「多了一個 `UserDetailsService` bean」在真實專案裡就是這樣不小心發生的。**

⚠️ **同理，實驗專案裡有幾個「成品用」的類別也要標 `@Profile` 隔離**：

| 類別 | 實驗專案裡的 `@Profile` | 為什麼 |
|---|---|---|
| 2.7.2 的 `DbUserDetailsService` | `!am & !ca & !p3` | 它是 `@Service`，會在**每一個**情境裡都變成一個 `UserDetailsService` bean |
| 2.7.7 的 `SessionRegistryConfig` / `AccountAdminService` | `sess` | 需要 `SessionRegistry` 與 `AppUserRepo` |
| 2.9.4 的 `RegisterController` | `strength` | 需要 `PasswordEncoder`，而有些情境沒有、有些情境有兩個 |
| 2.6.3 的 `AuthWiringReporter` | `am` | 只有 2.6 那組實驗需要它的輸出 |

**不隔離的話會怎樣？** `DbUserDetailsService` 是最好的例子：
它一旦在 `am` 那組情境裡也活著，2.6.2 的 **am2 就會變成「兩個 `UserDetailsService`」**——
於是那個「官方寫法」也會 `StackOverflowError`，整組對照就毀了。

📌 **你自己的專案只有一組設定，不需要這樣做。**
這是「一個專案裡塞了十幾種互相矛盾的設定」才會有的問題——
**而它也剛好示範了 2.6.3 那類接線錯誤的長相。**

---

## 2.2 三層委派：一次認證到底經過誰

### 2.2.1 三個名字，三個職責

```
     HTTP 請求
   Authorization: Basic YWxpY2U6cHc=
         │
┌────────▼─────────────────────────────────────────────────────────────┐
│ ① 認證 Filter    BasicAuthenticationFilter                            │
│                  UsernamePasswordAuthenticationFilter                 │
│                  （你自己寫的 JwtAuthenticationFilter……）               │
│                                                                       │
│   職責：把憑證從【這一種傳輸格式】裡挖出來，包成一個 Authentication 物件      │
│   ★ 它【不知道】密碼是不是對的，也【不在乎】帳號存在哪裡                     │
└────────┬─────────────────────────────────────────────────────────────┘
         │  authenticate(未認證的 Authentication)
┌────────▼─────────────────────────────────────────────────────────────┐
│ ② AuthenticationManager    實作幾乎永遠是 ProviderManager               │
│                                                                       │
│   職責：手上有一份 provider 清單，逐個問「你支援這種 token 嗎」            │
│   ★ 它也【不驗證任何東西】，它只是一個派工的                              │
└────────┬─────────────────────────────────────────────────────────────┘
         │  authenticate(同一個物件)
┌────────▼─────────────────────────────────────────────────────────────┐
│ ③ AuthenticationProvider   DaoAuthenticationProvider（帳密）           │
│                            LdapAuthenticationProvider                 │
│                            JwtAuthenticationProvider（05 章）          │
│                                                                       │
│   職責：★ 真的去驗                                                     │
│   帳密這一種再往下拆成兩個可替換的零件：                                   │
│      UserDetailsService ── 帳號從哪裡來                                │
│      PasswordEncoder    ── 密碼怎麼比對                                │
└────────┬─────────────────────────────────────────────────────────────┘
         │  回傳【已認證的】Authentication
         ▼
   Filter 把它放進 SecurityContextHolder（01 章 1.5）
```

📌 **為什麼要拆成三層？** 因為這三件事的變化頻率完全不同：

| 層 | 什麼時候會換 | 例子 |
|---|---|---|
| ① Filter | 換**傳輸方式**時 | 從 Basic 換成 JWT、加一個 API key 標頭 |
| ② Manager | 幾乎不換 | 你這輩子大概不會自己寫一個 `AuthenticationManager` |
| ③ Provider | 換**帳號來源**時 | 從記憶體換成 MySQL、加一個 LDAP、加二階段驗證 |

**這一章的 2.10 會告訴你「我要客製這件事，該動哪一層」——**
**而八成的需求只要動 ③ 底下那個 `UserDetailsService`。**

### 2.2.2 實測：`Authentication` 物件的三個狀態

**`Authentication` 這個介面同時扮演兩個角色**，這是初學最容易卡住的地方：

```java
public interface Authentication extends Principal, Serializable {
    Collection<? extends GrantedAuthority> getAuthorities();
    Object      getCredentials();      // 憑證（密碼 / token）
    Object      getDetails();          // 額外資訊（IP、session id、自訂欄位）
    Object      getPrincipal();        // 身分（認證前是字串，認證後是 UserDetails）
    boolean     isAuthenticated();
    void        setAuthenticated(boolean isAuthenticated) throws IllegalArgumentException;
}
```

```
認證【前】：它是一個「請求」    —— 我說我是 alice，密碼是 pw，請你驗
認證【後】：它是一個「結果」    —— 這個人確實是 alice，他有這些權限
```

**同一個介面，兩種語意。** 用一段程式碼把三個狀態印出來：

```java
package com.example.lab09.ch02;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.userdetails.UserDetails;

/** 把 Authentication 物件的內部狀態攤平成一行 */
public class Probe {

    public static String describe(Authentication a) {
        if (a == null) return "null";
        Object p = a.getPrincipal();
        String principal = (p instanceof UserDetails u) ? "UserDetails(" + u.getUsername() + ")"
                                                        : String.valueOf(p);
        return String.format("%s{ principal=%s, credentials=%s, authenticated=%s, authorities=%s }",
                a.getClass().getSimpleName(), principal,
                a.getCredentials() == null ? "null" : "\"" + a.getCredentials() + "\"",
                a.isAuthenticated(), a.getAuthorities());
    }
}
```

```java
package com.example.lab09.ch02;

import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;

class AuthObjectStateTest {

    @Test
    void objectStates() {
        System.out.println("\n═══ 2.2.2 Authentication 物件的三個狀態 ═══");
        PasswordEncoder enc = new BCryptPasswordEncoder();
        UserDetailsService uds = new InMemoryUserDetailsManager(
                User.withUsername("alice").password(enc.encode("pw")).roles("USER").build());
        DaoAuthenticationProvider dao = new DaoAuthenticationProvider();
        dao.setUserDetailsService(uds);
        dao.setPasswordEncoder(enc);
        ProviderManager pm = new ProviderManager(dao);

        Authentication before = UsernamePasswordAuthenticationToken.unauthenticated("alice", "pw");
        System.out.println("① Filter 建出來的（未認證）:");
        System.out.println("   " + Probe.describe(before));

        Authentication after = pm.authenticate(before);
        System.out.println("② Manager 回傳的（已認證）:");
        System.out.println("   " + Probe.describe(after));

        System.out.println("③ 原本那個物件有沒有被改動:");
        System.out.println("   " + Probe.describe(before));
        System.out.println("   同一個物件嗎: " + (before == after));

        System.out.println("④ eraseCredentials 關掉再跑一次:");
        pm.setEraseCredentialsAfterAuthentication(false);
        Authentication kept = pm.authenticate(
                UsernamePasswordAuthenticationToken.unauthenticated("alice", "pw"));
        System.out.println("   " + Probe.describe(kept));

        System.out.println("⑤ 試著自己 new 一個「已認證」的 token:");
        UsernamePasswordAuthenticationToken forged =
                new UsernamePasswordAuthenticationToken("alice", null, java.util.List.of());
        System.out.println("   " + Probe.describe(forged));
        System.out.println("   （三參數建構子會直接把 authenticated 設成 true）");
    }
}
```

```
═══ 2.2.2 Authentication 物件的三個狀態 ═══
① Filter 建出來的（未認證）:
   UsernamePasswordAuthenticationToken{ principal=alice, credentials="pw", authenticated=false, authorities=[] }
② Manager 回傳的（已認證）:
   UsernamePasswordAuthenticationToken{ principal=UserDetails(alice), credentials=null, authenticated=true, authorities=[ROLE_USER] }
③ 原本那個物件有沒有被改動:
   UsernamePasswordAuthenticationToken{ principal=alice, credentials="pw", authenticated=false, authorities=[] }
   同一個物件嗎: false
④ eraseCredentials 關掉再跑一次:
   UsernamePasswordAuthenticationToken{ principal=UserDetails(alice), credentials="pw", authenticated=true, authorities=[ROLE_USER] }
⑤ 試著自己 new 一個「已認證」的 token:
   UsernamePasswordAuthenticationToken{ principal=alice, credentials=null, authenticated=true, authorities=[] }
   （三參數建構子會直接把 authenticated 設成 true）
```

**四個結論，每一個都會在後面的章節用到**：

| # | 觀察 | 意義 |
|---|---|---|
| ① → ② | `principal` 從**字串**變成 **`UserDetails`** | 認證後你可以在 Controller 拿到完整的使用者物件（2.7.2） |
| ① → ② | `credentials` 從 `"pw"` 變成 **`null`** | `ProviderManager` 主動抹掉的（2.4.5），**不是** provider 做的 |
| ③ | 輸入物件**沒有被改動**，回傳的是**新物件** | 所以 Filter 一定要把回傳值放進 context，不能只呼叫不接 |
| ⑤ | 三參數建構子**直接**把 `authenticated` 設成 `true` | 🔴 這就是「偽造身分」的入口——05 章的 JWT filter 必須小心 |

⚠️ **關於 ⑤**：`UsernamePasswordAuthenticationToken` 有兩個建構子：

```java
// 兩參數：未認證。authenticated = false
public UsernamePasswordAuthenticationToken(Object principal, Object credentials)

// 三參數：★ 已認證。authenticated = true，而且【沒有任何檢查】
public UsernamePasswordAuthenticationToken(Object principal, Object credentials,
                                           Collection<? extends GrantedAuthority> authorities)
```

**6.x 加了兩個靜態工廠方法，就是為了讓這件事在程式碼裡看得出來**：

```java
UsernamePasswordAuthenticationToken.unauthenticated("alice", "pw");        // 明確：這是請求
UsernamePasswordAuthenticationToken.authenticated(user, null, authorities); // 明確：這是結果
```

📌 **新程式碼一律用靜態工廠**——讀 code review 的人可以一眼看出你是在「發問」還是在「宣告答案」。

### 2.2.3 實測：在三層各插一個探針

**光看物件不夠，要看它在鏈上怎麼走。** 把三層各包一層印訊息的殼：

```java
package com.example.lab09.ch02;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.*;
import org.springframework.security.core.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/** 三層委派的探針。describe() 與 2.2.2 那一份相同，原樣搬來。 */
public class Probe {

    public static String describe(Authentication a) {
        if (a == null) return "null";
        Object p = a.getPrincipal();
        String principal = (p instanceof UserDetails u) ? "UserDetails(" + u.getUsername() + ")"
                                                        : String.valueOf(p);
        return String.format("%s{ principal=%s, credentials=%s, authenticated=%s, authorities=%s }",
                a.getClass().getSimpleName(), principal,
                a.getCredentials() == null ? "null" : "\"" + a.getCredentials() + "\"",
                a.isAuthenticated(), a.getAuthorities());
    }

    /** 第一層外面：印出 SecurityContextHolder 此刻的狀態 */
    public static class ContextProbeFilter extends OncePerRequestFilter {
        private final String tag;
        public ContextProbeFilter(String tag) { this.tag = tag; }

        // ⚠️ 兩個同類別的 OncePerRequestFilter 會共用同一個 alreadyFiltered 屬性名，
        //    導致第二個【被安靜地跳過】。這裡給每個探針一個獨立的名字。
        @Override protected String getAlreadyFilteredAttributeName() {
            return getClass().getName() + "[" + tag + "].FILTERED";
        }

        @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain ch)
                throws ServletException, IOException {
            System.out.println("  [" + tag + "] SecurityContextHolder = "
                    + describe(SecurityContextHolder.getContext().getAuthentication()));
            ch.doFilter(req, res);
        }
    }

    /** 第二層：包住 AuthenticationManager */
    public record LoggingManager(AuthenticationManager delegate) implements AuthenticationManager {
        @Override public Authentication authenticate(Authentication a) throws AuthenticationException {
            System.out.println("  [② AuthenticationManager 收到] " + describe(a));
            try {
                Authentication out = delegate.authenticate(a);
                System.out.println("  [② AuthenticationManager 回傳] " + describe(out));
                return out;
            } catch (AuthenticationException e) {
                System.out.println("  [② AuthenticationManager 拋出] " + e.getClass().getSimpleName()
                        + ": " + e.getMessage());
                throw e;
            }
        }
    }

    /** 第三層：包住 AuthenticationProvider */
    public record LoggingProvider(AuthenticationProvider delegate, String name) implements AuthenticationProvider {
        @Override public Authentication authenticate(Authentication a) throws AuthenticationException {
            System.out.println("    [③ " + name + ".authenticate] " + describe(a));
            try {
                Authentication out = delegate.authenticate(a);
                System.out.println("    [③ " + name + " 回傳] " + describe(out));
                return out;
            } catch (AuthenticationException e) {
                System.out.println("    [③ " + name + " 拋出] " + e.getClass().getSimpleName()
                        + ": " + e.getMessage());
                throw e;
            }
        }
        @Override public boolean supports(Class<?> c) {
            boolean s = delegate.supports(c);
            System.out.println("    [③ " + name + ".supports(" + c.getSimpleName() + ")] = " + s);
            return s;
        }
    }
}
```

**設定**——注意 `.authenticationManager(am)`：**這一行會蓋掉自動設定的那一個**。

```java
package com.example.lab09.ch02;

import org.springframework.context.annotation.*;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter;
import org.springframework.security.web.context.SecurityContextHolderFilter;

@Configuration
@Profile("p3")
public class ThreeLayerScenario {

    @Bean PasswordEncoder enc() { return new BCryptPasswordEncoder(); }

    @Bean UserDetailsService uds(PasswordEncoder enc) {
        return new InMemoryUserDetailsManager(
            User.withUsername("alice").password(enc.encode("pw")).roles("USER").build());
    }

    @Bean SecurityFilterChain chain(HttpSecurity http, UserDetailsService uds, PasswordEncoder enc)
            throws Exception {
        DaoAuthenticationProvider dao = new DaoAuthenticationProvider();
        dao.setUserDetailsService(uds);
        dao.setPasswordEncoder(enc);

        AuthenticationManager am = new Probe.LoggingManager(
                new ProviderManager(new Probe.LoggingProvider(dao, "DaoAuthenticationProvider")));

        return http
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .httpBasic(Customizer.withDefaults())
            .csrf(c -> c.disable())
            .authenticationManager(am)
            .addFilterAfter(new Probe.ContextProbeFilter("① BasicAuthenticationFilter 之前"),
                            SecurityContextHolderFilter.class)
            .addFilterAfter(new Probe.ContextProbeFilter("④ BasicAuthenticationFilter 之後"),
                            BasicAuthenticationFilter.class)
            .build();
    }
}
```

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;                       // 00 章 0.8.3 那個不跟隨轉址的 client
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("p3")
class ThreeLayerTest {

    @LocalServerPort int port;

    @Test
    void trace() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.2.3 一次 Basic 認證的三層軌跡（成功）═══");
        HttpResponse<String> ok = http.get("/api/hello", "Authorization", Http.basic("alice", "pw"));
        System.out.println("  → HTTP " + ok.statusCode());

        System.out.println("\n═══ 2.2.3 同一條路徑，密碼打錯 ═══");
        HttpResponse<String> bad = http.get("/api/hello", "Authorization", Http.basic("alice", "WRONG"));
        System.out.println("  → HTTP " + bad.statusCode());

        System.out.println("\n═══ 2.2.3 完全不帶 Authorization 標頭 ═══");
        HttpResponse<String> anon = http.get("/api/hello");
        System.out.println("  → HTTP " + anon.statusCode());
    }
}
```

```
═══ 2.2.3 一次 Basic 認證的三層軌跡（成功）═══
  [① BasicAuthenticationFilter 之前] SecurityContextHolder = null
  [② AuthenticationManager 收到] UsernamePasswordAuthenticationToken{ principal=alice, credentials="pw", authenticated=false, authorities=[] }
    [③ DaoAuthenticationProvider.supports(UsernamePasswordAuthenticationToken)] = true
    [③ DaoAuthenticationProvider.authenticate] UsernamePasswordAuthenticationToken{ principal=alice, credentials="pw", authenticated=false, authorities=[] }
    [③ DaoAuthenticationProvider 回傳] UsernamePasswordAuthenticationToken{ principal=UserDetails(alice), credentials="pw", authenticated=true, authorities=[ROLE_USER] }
  [② AuthenticationManager 回傳] UsernamePasswordAuthenticationToken{ principal=UserDetails(alice), credentials=null, authenticated=true, authorities=[ROLE_USER] }
  [④ BasicAuthenticationFilter 之後] SecurityContextHolder = UsernamePasswordAuthenticationToken{ principal=UserDetails(alice), credentials=null, authenticated=true, authorities=[ROLE_USER] }
  → HTTP 200

═══ 2.2.3 同一條路徑，密碼打錯 ═══
  [① BasicAuthenticationFilter 之前] SecurityContextHolder = null
  [② AuthenticationManager 收到] UsernamePasswordAuthenticationToken{ principal=alice, credentials="WRONG", authenticated=false, authorities=[] }
    [③ DaoAuthenticationProvider.supports(UsernamePasswordAuthenticationToken)] = true
    [③ DaoAuthenticationProvider.authenticate] UsernamePasswordAuthenticationToken{ principal=alice, credentials="WRONG", authenticated=false, authorities=[] }
    [③ DaoAuthenticationProvider 拋出] BadCredentialsException: 憑證錯誤
  [② AuthenticationManager 拋出] BadCredentialsException: 憑證錯誤
  → HTTP 401

═══ 2.2.3 完全不帶 Authorization 標頭 ═══
  [① BasicAuthenticationFilter 之前] SecurityContextHolder = null
  [④ BasicAuthenticationFilter 之後] SecurityContextHolder = null
  → HTTP 401
```

**這份輸出回答了五個問題**：

| 問題 | 答案（看哪一行） |
|---|---|
| 誰建立 `Authentication` 物件？ | Filter。第 ② 行「收到」的那個就是 Filter 建的 |
| `credentials` 在哪一層被抹掉？ | ② 那一層。provider 回傳時 `credentials="pw"` 還在，manager 回傳時變 `null` |
| `supports()` 什麼時候被呼叫？ | `authenticate()` **之前**，而且**每次認證都會問一次** |
| 認證失敗時例外怎麼傳？ | provider 拋 → manager 原樣往外拋 → Filter 接住 → 走 entry point → 401 |
| 沒帶憑證時 Filter 做了什麼？ | **什麼都沒做**，直接放行。401 是後面的 `AuthorizationFilter` 造成的（01 章 1.8.2） |

⚠️ **最後一列是很多人搞錯的地方**：

```
「沒帶憑證 → 401」這件事，【不是】認證 Filter 做的。
認證 Filter 看到沒憑證就【原封不動放行】，
一路走到第 16 個 AuthorizationFilter 才被擋下來，
再由 ExceptionTranslationFilter 換成 401。
```

📌 **這解釋了 01 章 1.4.3 的一個現象**：把 `authorizeHttpRequests` 整段拿掉之後，
鏈上還有 `BasicAuthenticationFilter`，但**任何請求都能過**——
因為認證 Filter 從來就不負責「擋人」。

> 💡 **中文錯誤訊息**：上面的輸出是 `憑證錯誤` 而不是 `Bad credentials`，
> 因為 Spring Security 內建了 `messages_zh_TW.properties`，而這台機器的 locale 是 zh-TW。
> 2.6.4 會講到一個相關的怪現象：**同一個 provider 換一種宣告方式，訊息會變回英文**。

### 2.2.4 四個名詞：principal / credentials / authorities / details

```java
public interface Authentication extends Principal, Serializable {
    Object getPrincipal();      // ① 你是誰
    Object getCredentials();    // ② 你憑什麼說你是你
    Collection<? extends GrantedAuthority> getAuthorities();   // ③ 你能做什麼
    Object getDetails();        // ④ 這次請求的周邊資訊
}
```

| 名詞 | 認證前 | 認證後 | 你在 Controller 拿到什麼 |
|---|---|---|---|
| `principal` | `String`（使用者輸入的帳號） | **`UserDetails`**（你自己的實作） | `@AuthenticationPrincipal AppUserDetails me` |
| `credentials` | 密碼 / token 字串 | **`null`**（被抹掉） | 拿不到，**這是刻意的** |
| `authorities` | 空清單 | `UserDetails.getAuthorities()` 的內容 | 03 章授權規則讀的就是這個 |
| `details` | `WebAuthenticationDetails`（IP + session id） | 同左（原樣複製過去） | 2.10.2 會用它夾帶一次性密碼 |

**`details` 是最少人用、但最好用的擴充點**：

```java
// Spring 預設塞進去的東西
public class WebAuthenticationDetails implements Serializable {
    private final String remoteAddress;   // 來源 IP —— 07 章的暴力破解偵測會用到
    private final String sessionId;
}
```

**它是「跟這一次 HTTP 請求有關、但不屬於帳密」的東西的容器**——
2.10.2 會把一次性密碼放進去，讓 provider 拿得到。

### 2.2.5 一張「誰負責什麼」的對照表

| 我想改變…… | 動哪一層 | 具體做法 | 本章小節 |
|---|---|---|---|
| 帳號存在哪裡（DB / LDAP / 外部 API） | ③ 底下 | 實作 `UserDetailsService` | 2.7 |
| 密碼怎麼雜湊 | ③ 底下 | 換 `PasswordEncoder` | 00 章 0.7 |
| 密碼之外再檢查一個東西（OTP、圖形驗證碼） | ③ | 繼承 `DaoAuthenticationProvider` | 2.10.2 |
| 帳號狀態的判斷規則（例如「試用期過了算停用」） | ③ | 換 `UserDetailsChecker` | 2.7.6 |
| 支援一種全新的憑證（API key、JWT） | ① + ③ | 新 Filter + 新 Token + 新 Provider | 2.10.3、05 章 |
| 登入成功 / 失敗要回什麼 | ① | `successHandler` / `failureHandler` | 2.3.6 |
| 登入要打哪一個網址、欄位叫什麼 | ① | `loginProcessingUrl` / `usernameParameter` | 2.3.2 |
| 同時支援兩種帳號來源 | ② | 給 `ProviderManager` 兩個 provider | 2.6.3 |

---

## 2.3 認證 Filter：只負責把憑證挖出來

### 2.3.1 `AbstractAuthenticationProcessingFilter` 的六個步驟

**Spring Security 大部分的「登入型」Filter 都繼承這一個抽象類別。**
它的 `doFilter` 只有二十幾行，但把「一次登入」的流程定義死了：

```java
// org.springframework.security.web.authentication.AbstractAuthenticationProcessingFilter（6.2.4）
private void doFilter(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws IOException, ServletException {
    if (!requiresAuthentication(request, response)) {          // ① 這是登入請求嗎？
        chain.doFilter(request, response);                     //    不是 → 直接放行
        return;
    }
    try {
        Authentication authenticationResult = attemptAuthentication(request, response);   // ② 子類實作
        if (authenticationResult == null) {
            return;                                            //    子類說「還沒完」（例如多步驟登入）
        }
        this.sessionStrategy.onAuthentication(authenticationResult, request, response);   // ③ 換 session id
        if (this.continueChainBeforeSuccessfulAuthentication) {
            chain.doFilter(request, response);
        }
        successfulAuthentication(request, response, chain, authenticationResult);         // ④ 成功
    }
    catch (InternalAuthenticationServiceException failed) {
        this.logger.error("An internal error occurred while trying to authenticate the user.", failed);
        unsuccessfulAuthentication(request, response, failed);                            // ⑤ 系統錯
    }
    catch (AuthenticationException ex) {
        unsuccessfulAuthentication(request, response, ex);                                // ⑥ 認證失敗
    }
}
```

**六個步驟，每一個都是擴充點**：

| 步驟 | 方法 | 你可以怎麼換 |
|---|---|---|
| ① 這是不是登入請求 | `requiresAuthentication` | `loginProcessingUrl("/api/auth/login")` |
| ② 把憑證挖出來 | `attemptAuthentication`（**抽象**） | 子類必須實作——這是「傳輸格式」的部分 |
| ③ 換 session id | `sessionStrategy` | 04 章：session fixation 防護 |
| ④ 成功後做什麼 | `successHandler` | 2.3.6：改成回 JSON；05 章：簽發 JWT |
| ⑤⑥ 失敗後做什麼 | `failureHandler` | 2.3.6：改成回 JSON；07 章：記錄失敗次數 |

**步驟 ④ 裡面還有一件重要的事**（01 章 1.5.2 的 explicit save）：

```java
// AbstractAuthenticationProcessingFilter.successfulAuthentication
protected void successfulAuthentication(HttpServletRequest request, HttpServletResponse response,
        FilterChain chain, Authentication authResult) throws IOException, ServletException {
    SecurityContext context = this.securityContextHolderStrategy.createEmptyContext();
    context.setAuthentication(authResult);
    this.securityContextHolderStrategy.setContext(context);
    this.securityContextRepository.saveContext(context, request, response);   // ★ 6.x：明確地存
    this.rememberMeServices.loginSuccess(request, response, authResult);
    if (this.eventPublisher != null) {
        this.eventPublisher.publishEvent(new InteractiveAuthenticationSuccessEvent(authResult, this.getClass()));
    }
    this.successHandler.onAuthenticationSuccess(request, response, authResult);
}
```

📌 **`saveContext` 那一行就是 00 章 0.3.6 那個事故的解藥**——
Spring 自己的 Filter 有寫，**你自己寫的 Filter 也必須寫**（2.10.3 會示範）。

### 2.3.2 `UsernamePasswordAuthenticationFilter`

**它的 `attemptAuthentication` 只有十行**，而且十行裡有八行在處理「表單欄位叫什麼」：

```java
// org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter（6.2.4）
public Authentication attemptAuthentication(HttpServletRequest request, HttpServletResponse response)
        throws AuthenticationException {
    if (this.postOnly && !request.getMethod().equals("POST")) {
        throw new AuthenticationServiceException("Authentication method not supported: " + request.getMethod());
    }
    String username = obtainUsername(request);              // request.getParameter("username")
    username = (username != null) ? username.trim() : "";   // ★ 會 trim
    String password = obtainPassword(request);              // request.getParameter("password")
    password = (password != null) ? password : "";          // ★ null 變空字串，不是 null
    UsernamePasswordAuthenticationToken authRequest =
            UsernamePasswordAuthenticationToken.unauthenticated(username, password);
    setDetails(request, authRequest);                       // 塞入 WebAuthenticationDetails
    return this.getAuthenticationManager().authenticate(authRequest);
}
```

**四個預設值，都可以改**：

```java
http.formLogin(f -> f
    .loginPage("/my-login")                 // 未登入時轉去哪（預設 /login，Spring 自動產生一頁）
    .loginProcessingUrl("/api/auth/login")  // POST 打哪（預設 /login）
    .usernameParameter("account")           // 表單欄位名（預設 username）
    .passwordParameter("secret")            // 表單欄位名（預設 password）
    .defaultSuccessUrl("/dashboard", true)  // 成功轉去哪
    .failureUrl("/my-login?bad"));          // 失敗轉去哪
```

⚠️ **兩個細節會咬人**：

```
① username 會被 trim() —— 「 alice 」與「alice」是同一個帳號
   → 你自己的註冊流程也要 trim，否則會出現「註冊得了、登不進去」

② password 【不會】被 trim，而且 null 會變成空字串 ""
   → 空字串會真的送去做一次 BCrypt 比對（不是短路），所以計時是一致的
```

### 2.3.3 `BasicAuthenticationFilter`：它**不是** `AbstractAuthenticationProcessingFilter` 的子類

**這是一個常見的誤解。** `BasicAuthenticationFilter extends OncePerRequestFilter`，
它自己寫了一份流程，而且**跟 2.3.1 那份有三個關鍵差異**：

```java
// org.springframework.security.web.authentication.www.BasicAuthenticationFilter（6.2.4，節錄）
protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws IOException, ServletException {
    try {
        Authentication authRequest = this.authenticationConverter.convert(request);
        if (authRequest == null) {
            chain.doFilter(request, response);      // ① 沒有 Authorization 標頭 → 放行，不是擋下來
            return;
        }
        String username = authRequest.getName();
        if (authenticationIsRequired(username)) {   // ② ★ 這一行是本節的主角
            Authentication authResult = this.authenticationManager.authenticate(authRequest);
            SecurityContext context = this.securityContextHolderStrategy.createEmptyContext();
            context.setAuthentication(authResult);
            this.securityContextHolderStrategy.setContext(context);
            this.rememberMeServices.loginSuccess(request, response, authResult);
            this.securityContextRepository.saveContext(context, request, response);
            onSuccessfulAuthentication(request, response, authResult);
        }
    }
    catch (AuthenticationException ex) {
        this.securityContextHolderStrategy.clearContext();
        this.rememberMeServices.loginFail(request, response);
        onUnsuccessfulAuthentication(request, response, ex);
        if (this.ignoreFailure) {
            chain.doFilter(request, response);
        }
        else {
            this.authenticationEntryPoint.commence(request, response, ex);   // ③ 直接回 401
        }
        return;
    }
    chain.doFilter(request, response);
}
```

| 差異 | `AbstractAuthenticationProcessingFilter` | `BasicAuthenticationFilter` |
|---|---|---|
| 觸發條件 | **只有**特定網址（`/login`） | **每一個**請求都看一眼有沒有標頭 |
| 認證成功後 | `successHandler`（通常轉址） | 什麼都不做，**繼續往下走** |
| 認證失敗後 | `failureHandler`（通常轉址） | 直接 `entryPoint.commence()` → **401** |

**第 ② 行那個 `authenticationIsRequired`**，是一個效能最佳化：

```java
// BasicAuthenticationFilter（6.2.4）
protected boolean authenticationIsRequired(String username) {
    // Only reauthenticate if username doesn't match SecurityContextHolder and user
    // isn't authenticated (see SEC-53)
    Authentication existingAuth = this.securityContextHolderStrategy.getContext().getAuthentication();
    if (existingAuth == null || !existingAuth.getName().equals(username) || !existingAuth.isAuthenticated()) {
        return true;
    }
    return (existingAuth instanceof AnonymousAuthenticationToken);
}
```

**翻譯**：

```
如果 SecurityContext 裡【已經】有一個叫同一個名字的、已認證的身分
→ 這一次【完全不驗密碼】，直接沿用
```

**用實測看看這代表什麼**：

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;                        // 00 章 0.8.3
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db2"})            // db2：Basic + 把認證結果存進 session
class BasicSkipTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }     // 2.7.2 的七個帳號

    @Test
    void skipsWhenSameUser() {
        System.out.println("\n═══ 2.3.3 authenticationIsRequired：同一個帳號不會重驗 ═══");
        record C(String user, String pw, String note) {}
        for (C c : java.util.List.of(
                new C("alice", "pw",            "同一個人、正確密碼"),
                new C("alice", "TOTALLY_WRONG", "同一個人、【錯誤】密碼"),
                new C("bob",   "pw",            "換一個人、正確密碼"),
                new C("bob",   "WRONG",         "換一個人、錯誤密碼"))) {
            Http http = new Http(port);                       // ★ 每個案例都重開一條 session
            String cookie = http.get("/whoami", "Authorization", Http.basic("alice", "pw"))
                    .headers().firstValue("set-cookie").orElseThrow().split(";")[0];
            HttpResponse<String> r = http.get("/whoami", "Cookie", cookie,
                    "Authorization", Http.basic(c.user(), c.pw()));
            System.out.printf("  已登入 alice，再帶 Basic %-22s → HTTP %d  %s%n",
                    c.user() + "/" + c.pw(), r.statusCode(),
                    r.statusCode() == 200 ? r.body().replaceAll(".*\"name\":\"([^\"]+)\".*", "身分=$1") : "");
        }
    }
}
```

```
═══ 2.3.3 authenticationIsRequired：同一個帳號不會重驗 ═══
  已登入 alice，再帶 Basic alice/pw               → HTTP 200  身分=alice
  已登入 alice，再帶 Basic alice/TOTALLY_WRONG    → HTTP 200  身分=alice
  已登入 alice，再帶 Basic bob/pw                 → HTTP 200  身分=bob
  已登入 alice，再帶 Basic bob/WRONG              → HTTP 401
```

**第二行：帶著已登入的 cookie，密碼故意打錯，回 200。**

⚠️ **這【不是】漏洞，但你必須知道它存在**，理由有三個：

```
① 它的前提是「你已經有一個合法的 session」——
   攻擊者要先偷到 cookie，而偷到 cookie 本來就等於拿到身分了。

② 但它會讓你的【測試】說謊：
   「我改了密碼，用舊密碼打 API 還是 200」——你以為改密碼沒生效，
   其實只是那條 session 還活著（2.7.7 是同一個現象的另一個面貌）。

③ 🔴 如果你的 API 是【無狀態】的（STATELESS），這個最佳化就永遠不會生效，
   於是每一個請求都要跑一次 BCrypt —— 那才是真正會出事的地方（2.3.5）。
```

📌 **第三行也值得看**：帶著 alice 的 cookie、送 bob 的正確帳密 → **身分變成 bob**。
Basic 標頭的優先權**高於** session。這在寫「切換帳號」功能時很有用，
但也表示**你不能假設「這條 session 從頭到尾都是同一個人」**。

### 2.3.4 實測：表單登入與 Basic 的完整往返

**同樣一件事「以 alice 的身分讀到 /whoami」，兩種機制的往返次數差很多。**

先看表單登入：

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.regex.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db4"})            // db4：只有 formLogin
class FormLoginTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }

    static String cookie(HttpResponse<String> r) {
        return r.headers().firstValue("set-cookie").map(s -> s.split(";")[0]).orElse(null);
    }
    /** ⚠️ 預設登入頁的隱藏欄位屬性順序是 name → type → value，regex 要照這個順序寫 */
    static String csrf(String html) {
        Matcher m = Pattern.compile("name=\"_csrf\" type=\"hidden\" value=\"([^\"]+)\"").matcher(html);
        return m.find() ? m.group(1) : null;
    }
    static void step(int n, String what, HttpResponse<String> r) {
        System.out.printf("  %d. %-46s → %d %s%n", n, what, r.statusCode(),
                r.headers().firstValue("location").map(l -> "→ " + l.replaceAll("http://[^/]+", "")).orElse(""));
    }

    @Test
    void fullRoundTrip() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.3.4 表單登入：一次成功登入要幾個往返 ═══");

        HttpResponse<String> r1 = http.get("/whoami");
        step(1, "GET /whoami（還沒登入）", r1);

        HttpResponse<String> r2 = http.get("/login");
        String c0 = cookie(r2), token = csrf(r2.body());
        step(2, "GET /login（取登入頁）", r2);
        System.out.println("       登入前 cookie: " + c0);
        System.out.println("       表單裡的 _csrf: " + (token == null ? "(沒抓到)" : token.substring(0, 20) + "…"));

        HttpResponse<String> r3 = http.send("POST", "/login",
                "username=alice&password=pw&_csrf=" + token,
                "Content-Type", "application/x-www-form-urlencoded", "Cookie", c0);
        String c1 = cookie(r3);
        step(3, "POST /login（帳密 + _csrf）", r3);
        System.out.println("       登入後 cookie: " + c1);
        System.out.println("       換了新的 session 嗎: " + !java.util.Objects.equals(c0, c1)
                + "（session fixation 防護）");

        HttpResponse<String> r4 = http.get("/whoami", "Cookie", c1);
        step(4, "GET /whoami（帶新 cookie）", r4);
        System.out.println("       body: " + r4.body());

        System.out.println("\n  ── 同一份設定（只有 formLogin），改帶 Authorization 標頭：");
        HttpResponse<String> b1 = http.get("/whoami", "Authorization", Http.basic("alice", "pw"));
        step(1, "GET /whoami（帶 Authorization: Basic …）", b1);
        System.out.println("       ★ 鏈上沒有 BasicAuthenticationFilter，這個標頭【沒有任何人看】");
    }

    @Test
    void savedRequest() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.3.4 登入後會回到你原本想去的地方（SavedRequest）═══");

        HttpResponse<String> r1 = http.get("/whoami?from=deep-link");
        String c0 = cookie(r1);
        step(1, "GET /whoami?from=deep-link（未登入）", r1);
        System.out.println("       這一步就發了 cookie: " + c0 + "（用來記住你想去哪）");

        HttpResponse<String> page = http.get("/login", "Cookie", c0);
        String token = csrf(page.body());
        HttpResponse<String> r2 = http.send("POST", "/login",
                "username=alice&password=pw&_csrf=" + token,
                "Content-Type", "application/x-www-form-urlencoded", "Cookie", c0);
        step(2, "POST /login", r2);
        System.out.println("       ★ 轉址目標不是首頁，是你原本要去的網址");
    }

    @Test
    void failures() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.3.4 表單登入的四種失敗，回應長什麼樣 ═══");
        String[][] cases = {
                {"alice",  "WRONG", "密碼錯"},
                {"nobody", "pw",    "帳號不存在"},
                {"carol",  "pw",    "帳號被停用（enabled=false）"},
                {"dave",   "pw",    "帳號被鎖定（accountNonLocked=false）"}};
        for (String[] c : cases) {
            HttpResponse<String> page = http.get("/login");
            String c0 = cookie(page), token = csrf(page.body());
            HttpResponse<String> r = http.send("POST", "/login",
                    "username=" + c[0] + "&password=" + c[1] + "&_csrf=" + token,
                    "Content-Type", "application/x-www-form-urlencoded", "Cookie", c0);
            System.out.printf("  %-30s → %d %s%n", c[2], r.statusCode(),
                    r.headers().firstValue("location").map(l -> l.replaceAll("http://[^/]+", "")).orElse(""));
        }
        System.out.println("  ★ 四種失敗，四個一模一樣的回應");
    }
}
```

```
═══ 2.3.4 表單登入：一次成功登入要幾個往返 ═══
  1. GET /whoami（還沒登入）                              → 302 → /login
  2. GET /login（取登入頁）                               → 200 
       登入前 cookie: JSESSIONID=1A4128A527FE4B50A813C584B7DC69EC
       表單裡的 _csrf: M5F6K1n2ImaoGrl_Gnc-…
  3. POST /login（帳密 + _csrf）                        → 302 → /
       登入後 cookie: JSESSIONID=90E268A227A65B9EF207A560C01CE517
       換了新的 session 嗎: true（session fixation 防護）
  4. GET /whoami（帶新 cookie）                         → 200 
       body: {"principalType":"AppUserDetails","displayName":"艾莉絲","name":"alice","authorities":"[ROLE_USER]"}

  ── 同一份設定（只有 formLogin），改帶 Authorization 標頭：
  1. GET /whoami（帶 Authorization: Basic …）          → 302 → /login
       ★ 鏈上沒有 BasicAuthenticationFilter，這個標頭【沒有任何人看】
```

**四個往返**。而 Basic 只要兩個（第一個還可以省掉）：

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db2"})
class BasicRoundTripTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }

    @Test
    void fullRoundTrip() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.3.4 HTTP Basic：同一件事要幾個往返 ═══");

        HttpResponse<String> r1 = http.get("/whoami", "Accept", "application/json");
        System.out.println("  1. GET /whoami（不帶憑證） → " + r1.statusCode());
        System.out.println("     WWW-Authenticate: "
                + r1.headers().firstValue("WWW-Authenticate").orElse("(無)"));

        HttpResponse<String> r2 = http.get("/whoami", "Authorization", Http.basic("alice", "pw"));
        System.out.println("  2. GET /whoami（帶 Authorization） → " + r2.statusCode());
        System.out.println("     body: " + r2.body());
    }
}
```

```
═══ 2.3.4 HTTP Basic：同一件事要幾個往返 ═══
  1. GET /whoami（不帶憑證） → 401
     WWW-Authenticate: Basic realm="Realm"
  2. GET /whoami（帶 Authorization） → 200
     body: {"principalType":"AppUserDetails","displayName":"艾莉絲","name":"alice","authorities":"[ROLE_USER]"}
```

**還有一件表單登入做得到、Basic 做不到的事：登入後回到你原本要去的頁面。**

```
═══ 2.3.4 登入後會回到你原本想去的地方（SavedRequest）═══
  1. GET /whoami?from=deep-link（未登入）                → 302 → /login
       這一步就發了 cookie: JSESSIONID=367DEB58819992D54D1F29EC3D019346（用來記住你想去哪）
  2. POST /login                                    → 302 → /whoami?from=deep-link&continue
       ★ 轉址目標不是首頁，是你原本要去的網址
```

⚠️ **注意第一步就發了 cookie**——**還沒登入就有 session 了**。
那個 session 裡放的是 `SavedRequest`（你原本想去的網址）。
這解釋了 00 章 0.5.5 的一個現象：「明明還沒登入，怎麼就有 `JSESSIONID`」。

📌 **`&continue` 是 Spring Security 6.x 加的標記**，用來讓 `RequestCache` 知道
「這是一個從登入頁轉回來的請求」，避免無窮轉址。

**最後看失敗的回應——四種失敗，四個一模一樣的回應**：

```
═══ 2.3.4 表單登入的四種失敗，回應長什麼樣 ═══
  密碼錯                            → 302 /login?error
  帳號不存在                          → 302 /login?error
  帳號被停用（enabled=false）           → 302 /login?error
  帳號被鎖定（accountNonLocked=false）  → 302 /login?error
  ★ 四種失敗，四個一模一樣的回應
```

**這是 Spring Security 的預設，而且是【對的】預設**（00 章 0.3.4）。
2.3.6 會示範怎麼在**保持對外一致**的前提下，把真正的原因寫進日誌。

### 2.3.5 實測：Basic 每個請求都重跑一次 BCrypt

**2.3.3 那個 `authenticationIsRequired` 的最佳化，在無狀態 API 上永遠不會生效。**
於是每一個請求都要做一次 BCrypt——而 00 章 0.7.3 量過，那是 **68 毫秒**。

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.concurrent.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db2"})
class BasicCostTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }

    static void report(String label, int requests, long nanos) {
        double ms = nanos / 1_000_000.0;
        System.out.printf("  %-34s %5d 個請求  %,8.0f ms   %,8.1f 個/秒   平均 %,6.1f ms%n",
                label, requests, ms, requests * 1000.0 / ms, ms / requests);
    }

    @Test
    void singleThread() {
        Http http = new Http(port);
        String basic = Http.basic("alice", "pw");
        HttpResponse<String> first = http.get("/whoami", "Authorization", basic);
        String cookie = first.headers().firstValue("set-cookie").orElseThrow().split(";")[0];
        for (int i = 0; i < 3; i++) http.get("/whoami", "Cookie", cookie);      // 暖機

        int n = 30;
        System.out.println("\n═══ 2.3.5 單執行緒：Basic vs Cookie ═══");

        long t0 = System.nanoTime();
        for (int i = 0; i < n; i++) http.get("/whoami", "Authorization", basic);
        report("每個請求都帶 Basic（跑 BCrypt）", n, System.nanoTime() - t0);

        long t1 = System.nanoTime();
        for (int i = 0; i < n; i++) http.get("/whoami", "Cookie", cookie);
        report("每個請求只帶 Cookie", n, System.nanoTime() - t1);
    }

    @Test
    void concurrent() throws Exception {
        Http warm = new Http(port);
        String basic = Http.basic("alice", "pw");
        String cookie = warm.get("/whoami", "Authorization", basic)
                .headers().firstValue("set-cookie").orElseThrow().split(";")[0];
        warm.get("/whoami", "Cookie", cookie);

        int threads = 16, perThread = 10;
        System.out.println("\n═══ 2.3.5 " + threads + " 個並行客戶端，各打 " + perThread + " 個請求 ═══");

        for (String mode : new String[]{"Basic", "Cookie"}) {
            ExecutorService pool = Executors.newFixedThreadPool(threads);
            CountDownLatch go = new CountDownLatch(1);
            for (int t = 0; t < threads; t++) {
                pool.submit(() -> {
                    Http h = new Http(port);
                    try { go.await(); } catch (InterruptedException e) { return; }
                    for (int i = 0; i < perThread; i++) {
                        if (mode.equals("Basic")) h.get("/whoami", "Authorization", basic);
                        else h.get("/whoami", "Cookie", cookie);
                    }
                });
            }
            long t0 = System.nanoTime();
            go.countDown();
            pool.shutdown();
            pool.awaitTermination(5, TimeUnit.MINUTES);
            report(mode.equals("Basic") ? "每個請求都帶 Basic" : "每個請求只帶 Cookie",
                    threads * perThread, System.nanoTime() - t0);
        }
        System.out.println("  （這台機器: " + Runtime.getRuntime().availableProcessors() + " 顆邏輯核心）");
    }
}
```

```
═══ 2.3.5 單執行緒：Basic vs Cookie ═══
  每個請求都帶 Basic（跑 BCrypt）                30 個請求     2,345 ms       12.8 個/秒   平均   78.2 ms
  每個請求只帶 Cookie                         30 個請求        22 ms    1,368.3 個/秒   平均    0.7 ms

═══ 2.3.5 16 個並行客戶端，各打 10 個請求 ═══
  每個請求都帶 Basic                         160 個請求     2,179 ms       73.4 個/秒   平均   13.6 ms
  每個請求只帶 Cookie                        160 個請求        44 ms    3,660.5 個/秒   平均    0.3 ms
  （這台機器: 8 顆邏輯核心）
```

**單執行緒 107 倍，八核並行 50 倍。**

📌 **並行那一組更值得看**：**73.4 個/秒**。

```
單執行緒  12.8 個/秒
8 顆核心  73.4 個/秒   ←  12.8 × 8 = 102，實際 73（有排程與 GC 的損耗）
```

**這是一個 CPU 上限，不是 IO 上限——加機器以外沒有別的解法。**

⚠️ **一個很容易寫進事故報告的句子**：

> 「我們的 API 用 HTTP Basic 保護，上線後 QPS 一過 70 就開始逾時，
> 但 CPU 明明只有應用程式在跑，資料庫完全沒有壓力。」

**因為 BCrypt 就是設計成「慢」的**（00 章 0.7.1）。
**它慢是為了讓攻擊者慢，而你把它放在每一個請求的關鍵路徑上。**

**三個解法，代價不同**：

| 解法 | 做法 | 代價 |
|---|---|---|
| ① 用 session | 認證一次，之後靠 cookie | 有狀態，水平擴展要處理 session 共享（04 章） |
| ② 用 token | 認證一次，之後驗簽章（HMAC 約 **1 µs**） | 撤銷困難（05 章 5.6） |
| ③ 快取 `UserDetails` + 認證結果 | 自己包一層 cache | 🔴 **會延後「改密碼 / 鎖帳號」的生效時間**（2.7.8） |

📌 **不要用「把 BCrypt cost 調低」當解法。**
`cost` 從 10 降到 6 可以快 16 倍，但**攻擊者離線破解也快了 16 倍**——
你把「一次登入 68 ms」的成本，換成「整份密碼庫外洩後多撐幾天」的能力。
**要調的是「多久驗一次」，不是「驗得多快」。**

### 2.3.6 把表單登入改成 JSON 介面

**前後端分離之後，`302 → /login` 是沒有用的回應。**
但你**不需要**為此自己寫一個 Filter——`formLogin` 的三個 handler 就夠了：

```java
package com.example.lab09.ch02;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;

import java.io.IOException;
import java.util.Map;

@Configuration
@Profile("db6")
public class JsonFormLoginConfig {

    @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }

    @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(a -> a.requestMatchers("/api/auth/login").permitAll()
                                         .anyRequest().authenticated())
            .formLogin(f -> f
                .loginProcessingUrl("/api/auth/login")            // ① 換掉 POST 的網址
                .successHandler(JsonFormLoginConfig::writeLoginOk)   // ② 不轉址，回 200 + JSON
                .failureHandler(JsonFormLoginConfig::writeLoginFail))// ③ 不轉址，回 401 + JSON
            .exceptionHandling(e -> e.authenticationEntryPoint(   // ④ 未登入不要轉去登入頁
                (req, res, ex) -> write(res, 401, Map.of(
                    "code", "UNAUTHENTICATED", "message", "請先登入", "path", req.getRequestURI()))))
            .csrf(c -> c.disable())      // ⚠️ 只有在【真的無狀態】時才可以關（04 章）
            .build();
    }

    static void writeLoginOk(HttpServletRequest req, HttpServletResponse res, Authentication auth)
            throws IOException {
        write(res, 200, Map.of(
                "name", auth.getName(),
                "authorities", auth.getAuthorities().stream().map(Object::toString).toList(),
                "sessionId", req.getSession(false) == null ? "(無)" : req.getSession().getId()));
    }

    static void writeLoginFail(HttpServletRequest req, HttpServletResponse res, AuthenticationException ex)
            throws IOException {
        // ⚠️ 對外一律同一句話（07 章 7.4 會解釋為什麼），細節只寫進日誌
        System.out.println("    [failureHandler] 內部原因: "
                + ex.getClass().getSimpleName() + " / " + ex.getMessage());
        write(res, 401, Map.of("code", "BAD_CREDENTIALS", "message", "帳號或密碼錯誤"));
    }

    static void write(HttpServletResponse res, int status, Map<String, ?> body) throws IOException {
        res.setStatus(status);
        res.setContentType("application/json;charset=UTF-8");
        res.getWriter().write(new ObjectMapper().writeValueAsString(body));
    }
}
```

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db6"})
class JsonLoginTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }

    HttpResponse<String> login(Http http, String u, String p) {
        return http.send("POST", "/api/auth/login", "username=" + u + "&password=" + p,
                "Content-Type", "application/x-www-form-urlencoded");
    }

    @Test
    void jsonLogin() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.3.6 表單登入改成 JSON 介面 ═══");

        HttpResponse<String> anon = http.get("/whoami", "Accept", "application/json");
        System.out.println("  沒登入打 /whoami → " + anon.statusCode() + " " + anon.body());

        HttpResponse<String> ok = login(http, "alice", "pw");
        String cookie = ok.headers().firstValue("set-cookie").map(s -> s.split(";")[0]).orElse("(無)");
        System.out.println("  POST /api/auth/login（正確）→ " + ok.statusCode() + " " + ok.body());
        System.out.println("     Set-Cookie: " + cookie);

        HttpResponse<String> me = http.get("/whoami", "Cookie", cookie);
        System.out.println("  帶 cookie 打 /whoami → " + me.statusCode() + " " + me.body());

        System.out.println("\n  ── 四種失敗，對外都是同一句話：");
        for (String[] c : new String[][]{{"alice","WRONG"},{"nobody","pw"},{"carol","pw"},{"dave","pw"}}) {
            HttpResponse<String> r = login(http, c[0], c[1]);
            System.out.println("  " + c[0] + "/" + c[1] + " → " + r.statusCode() + " " + r.body());
        }
    }
}
```

```
═══ 2.3.6 表單登入改成 JSON 介面 ═══
  沒登入打 /whoami → 401 {"path":"/whoami","code":"UNAUTHENTICATED","message":"請先登入"}
  POST /api/auth/login（正確）→ 200 {"authorities":["ROLE_USER"],"sessionId":"27370A9B3FC0BEAB48FEF5CE883E3A89","name":"alice"}
     Set-Cookie: JSESSIONID=27370A9B3FC0BEAB48FEF5CE883E3A89
  帶 cookie 打 /whoami → 200 {"authorities":"[ROLE_USER]","principalType":"AppUserDetails","displayName":"艾莉絲","name":"alice"}

  ── 四種失敗，對外都是同一句話：
    [failureHandler] 內部原因: BadCredentialsException / 憑證錯誤
  alice/WRONG → 401 {"message":"帳號或密碼錯誤","code":"BAD_CREDENTIALS"}
    [failureHandler] 內部原因: BadCredentialsException / 憑證錯誤
  nobody/pw → 401 {"message":"帳號或密碼錯誤","code":"BAD_CREDENTIALS"}
    [failureHandler] 內部原因: DisabledException / 使用者已被停用
  carol/pw → 401 {"message":"帳號或密碼錯誤","code":"BAD_CREDENTIALS"}
    [failureHandler] 內部原因: LockedException / 使用者帳號已被鎖定
  dave/pw → 401 {"message":"帳號或密碼錯誤","code":"BAD_CREDENTIALS"}
```

📌 **這份輸出示範了一個重要的分工**：

```
對【外】（HTTP 回應）：四種失敗，同一句話、同一個 code、同一個狀態碼
對【內】（日誌）    ：DisabledException / LockedException / BadCredentialsException 分得清清楚楚
```

**這不是「藏起來」，是「分流」**——
客服要知道「這個人是被鎖定了」，攻擊者不需要知道。
07 章 7.4 會把這件事做完整（含「查詢帳號狀態」的獨立端點）。

⚠️ **兩個常見的踩雷**：

```
① loginProcessingUrl 換了，但沒有加 permitAll()
   → POST /api/auth/login 會先被 AuthorizationFilter 擋下來，
     根本走不到 UsernamePasswordAuthenticationFilter
   → 症狀：登入端點永遠 401，而且日誌裡看不到任何「認證失敗」

② 只換 successHandler / failureHandler，忘了換 authenticationEntryPoint
   → 登入本身回 JSON 了，但「其他端點未登入」還是回 302 → /login
   → 症狀：前端 fetch 收到一個 200 的 HTML 登入頁（因為 fetch 預設跟隨轉址）
```

**②** 就是 00 章 0.8.3 為什麼要寫一個「不跟隨轉址」的 `Http` 工具——
**你的測試工具會替你美化回應，讓這個 bug 在測試裡消失。**

### 2.3.7 這兩個怎麼選

| | 表單登入 | HTTP Basic |
|---|---|---|
| 憑證放哪 | POST body（一次） | **每一個請求的標頭** |
| 建立 session | 是 | **6.x 預設不會**（2.7.4） |
| 每個請求的 CPU | 只有第一次做 BCrypt | **每次都做**（2.3.5） |
| 登出 | 有意義（清 session） | **沒有意義**（瀏覽器會一直送標頭） |
| CSRF | 需要 | 不需要（沒有 cookie 就沒有 CSRF） |
| 適合 | 瀏覽器、後台網頁 | **內部服務對服務**、CI 腳本、快速實驗 |
| 不適合 | 手機 App、第三方 API | **公開 API**（2.3.5 的吞吐量） |

📌 **本站的建議**（01 章 1.7.6 那兩條 chain 的延伸）：

```
/api/**  → 05 章的 JWT（現在暫時用 Basic 佔位）
其餘      → 表單登入 + session
```

⚠️ **HTTP Basic 有一個常被忽略的問題**：憑證**存在瀏覽器裡，而且清不掉**。
瀏覽器一旦記住某個 realm 的帳密，就會對該網域的每一個請求自動附上——
**沒有「登出」這個概念**。這是它不適合面向使用者的產品的根本原因。

---

## 2.4 `ProviderManager`：`(1/1)` 是什麼意思

### 2.4.1 迴圈的六條規則

01 章那份 TRACE 日誌裡的 `(1/1)`，是「**第 1 個 / 共 1 個** provider」。
這個數字直接印在 `ProviderManager.authenticate()` 的迴圈裡：

```java
// org.springframework.security.authentication.ProviderManager（6.2.4，節錄）
public Authentication authenticate(Authentication authentication) throws AuthenticationException {
    Class<? extends Authentication> toTest = authentication.getClass();
    AuthenticationException lastException = null;
    AuthenticationException parentException = null;
    Authentication result = null;
    Authentication parentResult = null;
    int currentPosition = 0;
    int size = this.providers.size();

    for (AuthenticationProvider provider : getProviders()) {
        if (!provider.supports(toTest)) {
            continue;                                          // 規則①：不支援就跳過
        }
        if (logger.isTraceEnabled()) {
            logger.trace(LogMessage.format("Authenticating request with %s (%d/%d)",
                    provider.getClass().getSimpleName(), ++currentPosition, size));   // ★ (1/1)
        }
        try {
            result = provider.authenticate(authentication);
            if (result != null) {
                copyDetails(authentication, result);
                break;                                         // 規則②：第一個成功的就結束
            }
        }
        catch (AccountStatusException | InternalAuthenticationServiceException ex) {
            prepareException(ex, authentication);
            // SEC-546: Avoid polling additional providers if auth failure is due to
            // invalid account status
            throw ex;                                          // 規則③：這兩種【立刻中止】
        }
        catch (AuthenticationException ex) {
            lastException = ex;                                // 規則④：其餘的記下來，繼續問
        }
    }

    if (result == null && this.parent != null) {
        try {
            parentResult = this.parent.authenticate(authentication);   // 規則⑤：都不行才問 parent
            result = parentResult;
        }
        catch (ProviderNotFoundException ex) { /* ignore */ }
        catch (AuthenticationException ex) { parentException = ex; lastException = ex; }
    }

    if (result != null) {
        if (this.eraseCredentialsAfterAuthentication && (result instanceof CredentialsContainer)) {
            ((CredentialsContainer) result).eraseCredentials();        // ★ credentials 在這裡被抹掉
        }
        if (parentResult == null) {
            this.eventPublisher.publishAuthenticationSuccess(result);
        }
        return result;
    }

    if (lastException == null) {
        lastException = new ProviderNotFoundException(this.messages.getMessage(
                "ProviderManager.providerNotFound",
                new Object[] { toTest.getName() }, "No AuthenticationProvider found for {0}"));
    }                                                          // 規則⑥：沒人處理 → ProviderNotFound
    if (parentException == null) {
        prepareException(lastException, authentication);
    }
    throw lastException;
}
```

**六條規則整理**：

| # | 情況 | 行為 |
|---|---|---|
| ① | `supports()` 回 `false` | 跳過，**連 `authenticate()` 都不呼叫** |
| ② | provider 回傳**非 null** | **成功，迴圈結束**，後面的 provider 完全不會被問到 |
| ③ | 拋 `AccountStatusException` 或 `InternalAuthenticationServiceException` | **立刻中止整個迴圈並往外拋** |
| ④ | 拋其他 `AuthenticationException` | 記進 `lastException`，**繼續問下一個** |
| ⑤ | 迴圈跑完都沒結果 | 交給 `parent`（如果有） |
| ⑥ | parent 也沒有、或根本沒 parent | 拋 `lastException`；一次都沒拋過則拋 `ProviderNotFoundException` |

⚠️ **規則③ 那段註解裡的 `SEC-546` 是 2007 年的一張票**，理由值得記下來：

> **帳號被鎖定，就不該讓後面的 provider 有機會「換一條路」認證成功。**

**這也是「provider 回 `null`」與「provider 拋例外」語意不同的原因**：

```
return null   →「這種 token 我不處理」（跟 supports() 回 false 效果一樣，繼續問下一個）
throw         →「這種 token 我處理，而且我判定失敗」
```

### 2.4.2 實測：三個 provider，誰處理誰

```java
package com.example.lab09.ch02;

import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.authority.AuthorityUtils;

import java.util.List;

/** 一個會把「誰被問到、誰被呼叫」印出來的假 provider */
public class ProviderLoopScenario {

    public static class TypedProvider implements AuthenticationProvider {
        private final String name;
        private final Class<?> accepts;
        private final Outcome outcome;
        public enum Outcome { SUCCESS, BAD_CREDENTIALS, LOCKED, INTERNAL_ERROR, RETURN_NULL }

        public TypedProvider(String name, Class<?> accepts, Outcome outcome) {
            this.name = name; this.accepts = accepts; this.outcome = outcome;
        }

        @Override public boolean supports(Class<?> c) {
            boolean s = accepts.isAssignableFrom(c);
            System.out.println("    supports(" + c.getSimpleName() + ") → " + name + " = " + s);
            return s;
        }

        @Override public Authentication authenticate(Authentication a) throws AuthenticationException {
            System.out.println("    ▶ " + name + ".authenticate() 被呼叫");
            switch (outcome) {
                case SUCCESS -> {
                    return new UsernamePasswordAuthenticationToken(
                            a.getName(), null, AuthorityUtils.createAuthorityList("ROLE_USER"));
                }
                case BAD_CREDENTIALS -> throw new BadCredentialsException(name + " 說：憑證錯誤");
                case LOCKED          -> throw new LockedException(name + " 說：帳號被鎖定");
                case INTERNAL_ERROR  -> throw new InternalAuthenticationServiceException(name + " 說：後端掛了");
                default              -> { return null; }
            }
        }
    }

    /** 一種自訂的 token 型別，用來示範 supports() */
    public static class ApiKeyToken extends AbstractAuthenticationToken {
        private final String key;
        public ApiKeyToken(String key) { super(List.of()); this.key = key; }
        @Override public Object getCredentials() { return key; }
        @Override public Object getPrincipal() { return "api-key"; }
    }
}
```

```java
package com.example.lab09.ch02;

import com.example.lab09.ch02.ProviderLoopScenario.ApiKeyToken;
import com.example.lab09.ch02.ProviderLoopScenario.TypedProvider;
import com.example.lab09.ch02.ProviderLoopScenario.TypedProvider.Outcome;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.authority.AuthorityUtils;

import java.util.List;

class ProviderLoopTest {

    static void run(String title, ProviderManager pm, Authentication in) {
        System.out.println("\n── " + title);
        try {
            Authentication out = pm.authenticate(in);
            System.out.println("  ✅ 成功: " + Probe.describe(out));      // Probe 見 2.2.2
        } catch (AuthenticationException e) {
            System.out.println("  ❌ " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    static Authentication upt() {
        return UsernamePasswordAuthenticationToken.unauthenticated("alice", "pw");
    }

    @Test
    void whoHandles() {
        System.out.println("\n═══ 2.4.2 三個 provider，誰處理誰 ═══");
        ProviderManager pm = new ProviderManager(List.of(
                new TypedProvider("P1-ApiKey", ApiKeyToken.class, Outcome.SUCCESS),
                new TypedProvider("P2-Upt",    UsernamePasswordAuthenticationToken.class, Outcome.SUCCESS),
                new TypedProvider("P3-Upt",    UsernamePasswordAuthenticationToken.class, Outcome.SUCCESS)));

        run("送進去 UsernamePasswordAuthenticationToken", pm, upt());
        run("送進去 ApiKeyToken", pm, new ApiKeyToken("k-123"));
        run("送進去 RememberMeAuthenticationToken（沒人 supports）", pm,
                new RememberMeAuthenticationToken("key", "alice",
                        AuthorityUtils.createAuthorityList("ROLE_USER")));
    }
}
```

```
═══ 2.4.2 三個 provider，誰處理誰 ═══

── 送進去 UsernamePasswordAuthenticationToken
    supports(UsernamePasswordAuthenticationToken) → P1-ApiKey = false
    supports(UsernamePasswordAuthenticationToken) → P2-Upt = true
    ▶ P2-Upt.authenticate() 被呼叫
  ✅ 成功: UsernamePasswordAuthenticationToken{ principal=alice, credentials=null, authenticated=true, authorities=[ROLE_USER] }

── 送進去 ApiKeyToken
    supports(ApiKeyToken) → P1-ApiKey = true
    ▶ P1-ApiKey.authenticate() 被呼叫
  ✅ 成功: UsernamePasswordAuthenticationToken{ principal=api-key, credentials=null, authenticated=true, authorities=[ROLE_USER] }

── 送進去 RememberMeAuthenticationToken（沒人 supports）
    supports(RememberMeAuthenticationToken) → P1-ApiKey = false
    supports(RememberMeAuthenticationToken) → P2-Upt = false
    supports(RememberMeAuthenticationToken) → P3-Upt = false
  ❌ ProviderNotFoundException: 找不到能支援 org.springframework.security.authentication.RememberMeAuthenticationToken 的 AuthenticationProvider
```

**三個觀察**：

```
① P3-Upt 從頭到尾【一次都沒被問到】—— P2 成功之後迴圈就 break 了（規則②）
② 沒人 supports 時，錯誤是 ProviderNotFoundException，【不是】BadCredentialsException
③ ProviderNotFoundException 也是 AuthenticationException 的子類 → 對外還是 401
```

⚠️ **② 是排查「我的自訂 token 完全沒作用」時的第一個線索。**
如果日誌裡看到 `ProviderNotFoundException`，代表你的 provider **根本沒被註冊**，
或者 `supports()` 寫錯了（最常見：用 `==` 比對類別，而 Spring 送進來的是子類）。

```java
// 🔴 常見錯誤：用 equals 比類別
@Override public boolean supports(Class<?> c) { return c.equals(MyToken.class); }

// ✅ 用 isAssignableFrom，讓子類也算數
@Override public boolean supports(Class<?> c) { return MyToken.class.isAssignableFrom(c); }
```

### 2.4.3 實測：例外會不會中止迴圈

**這一組六個案例，把規則③ 與規則④ 的差別攤開。**

```java
package com.example.lab09.ch02;

import com.example.lab09.ch02.ProviderLoopScenario.TypedProvider;
import com.example.lab09.ch02.ProviderLoopScenario.TypedProvider.Outcome;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;

import java.util.List;

class ProviderExceptionRuleTest {

    static void run(String title, ProviderManager pm, Authentication in) {
        System.out.println("\n── " + title);
        try {
            System.out.println("  ✅ 成功: " + Probe.describe(pm.authenticate(in)));
        } catch (AuthenticationException e) {
            System.out.println("  ❌ " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    static Authentication upt() {
        return UsernamePasswordAuthenticationToken.unauthenticated("alice", "pw");
    }

    static ProviderManager pm(Outcome first, Outcome second) {
        return new ProviderManager(List.of(
                new TypedProvider("P1", UsernamePasswordAuthenticationToken.class, first),
                new TypedProvider("P2", UsernamePasswordAuthenticationToken.class, second)));
    }

    @Test
    void exceptionRules() {
        System.out.println("\n═══ 2.4.3 provider 拋例外，迴圈會不會停 ═══");

        System.out.println("\n【A】第一個拋 BadCredentialsException（AuthenticationException 的一般子類）");
        run("預期：記下來，繼續問第二個", pm(Outcome.BAD_CREDENTIALS, Outcome.SUCCESS), upt());

        System.out.println("\n【B】第一個拋 LockedException（AccountStatusException 的子類）");
        run("預期：立刻中止，第二個【不會】被呼叫", pm(Outcome.LOCKED, Outcome.SUCCESS), upt());

        System.out.println("\n【C】第一個拋 InternalAuthenticationServiceException");
        run("預期：立刻中止", pm(Outcome.INTERNAL_ERROR, Outcome.SUCCESS), upt());

        System.out.println("\n【D】第一個回傳 null（不拋例外）");
        run("預期：當成「我不處理」，繼續問第二個", pm(Outcome.RETURN_NULL, Outcome.SUCCESS), upt());

        System.out.println("\n【E】兩個都拋 BadCredentialsException");
        run("預期：拋出【最後一個】的例外", pm(Outcome.BAD_CREDENTIALS, Outcome.BAD_CREDENTIALS), upt());

        System.out.println("\n【F】兩個都回 null");
        run("預期：ProviderNotFoundException", pm(Outcome.RETURN_NULL, Outcome.RETURN_NULL), upt());
    }
}
```

```
═══ 2.4.3 provider 拋例外，迴圈會不會停 ═══

【A】第一個拋 BadCredentialsException（AuthenticationException 的一般子類）

── 預期：記下來，繼續問第二個
    supports(UsernamePasswordAuthenticationToken) → P1 = true
    ▶ P1.authenticate() 被呼叫
    supports(UsernamePasswordAuthenticationToken) → P2 = true
    ▶ P2.authenticate() 被呼叫
  ✅ 成功: UsernamePasswordAuthenticationToken{ principal=alice, credentials=null, authenticated=true, authorities=[ROLE_USER] }

【B】第一個拋 LockedException（AccountStatusException 的子類）

── 預期：立刻中止，第二個【不會】被呼叫
    supports(UsernamePasswordAuthenticationToken) → P1 = true
    ▶ P1.authenticate() 被呼叫
  ❌ LockedException: P1 說：帳號被鎖定

【C】第一個拋 InternalAuthenticationServiceException

── 預期：立刻中止
    supports(UsernamePasswordAuthenticationToken) → P1 = true
    ▶ P1.authenticate() 被呼叫
  ❌ InternalAuthenticationServiceException: P1 說：後端掛了

【D】第一個回傳 null（不拋例外）

── 預期：當成「我不處理」，繼續問第二個
    supports(UsernamePasswordAuthenticationToken) → P1 = true
    ▶ P1.authenticate() 被呼叫
    supports(UsernamePasswordAuthenticationToken) → P2 = true
    ▶ P2.authenticate() 被呼叫
  ✅ 成功: UsernamePasswordAuthenticationToken{ principal=alice, credentials=null, authenticated=true, authorities=[ROLE_USER] }

【E】兩個都拋 BadCredentialsException

── 預期：拋出【最後一個】的例外
    supports(UsernamePasswordAuthenticationToken) → P1 = true
    ▶ P1.authenticate() 被呼叫
    supports(UsernamePasswordAuthenticationToken) → P2 = true
    ▶ P2.authenticate() 被呼叫
  ❌ BadCredentialsException: P2 說：憑證錯誤

【F】兩個都回 null

── 預期：ProviderNotFoundException
    supports(UsernamePasswordAuthenticationToken) → P1 = true
    ▶ P1.authenticate() 被呼叫
    supports(UsernamePasswordAuthenticationToken) → P2 = true
    ▶ P2.authenticate() 被呼叫
  ❌ ProviderNotFoundException: 找不到能支援 …UsernamePasswordAuthenticationToken 的 AuthenticationProvider
```

**六個案例，一張表**：

| 案例 | P1 的行為 | P2 有被呼叫嗎 | 最終結果 |
|---|---|---|---|
| A | `BadCredentialsException` | ✅ 有 | P2 成功 |
| B | `LockedException` | ❌ **沒有** | `LockedException` |
| C | `InternalAuthenticationServiceException` | ❌ **沒有** | 原樣往外拋 |
| D | `return null` | ✅ 有 | P2 成功 |
| E | 兩個都失敗 | ✅ 有 | **P2** 的例外（不是 P1 的） |
| F | 兩個都 `null` | ✅ 有 | `ProviderNotFoundException` |

📌 **案例 E 是排查「錯誤訊息不對」的關鍵**：
你有兩個 provider（例如「本地帳號」與「LDAP」），使用者是本地帳號、密碼打錯，
但**他看到的錯誤訊息來自 LDAP**——因為 `lastException` 被後面那個覆蓋了。

**修法：把最可能成功的 provider 放在最後，或者統一錯誤訊息**（2.3.6 的 `failureHandler`）。

⚠️ **案例 C 會在 2.5.3 回來咬人**：
`UserDetailsService` 回 `null` 會產生 `InternalAuthenticationServiceException`，
於是**整條 provider 鏈立刻中止**——你的「LDAP 備援」永遠不會被執行到。

### 2.4.4 `parent`：兩層 `AuthenticationManager`

**`ProviderManager` 可以有一個 parent。** 這在多條 `SecurityFilterChain` 的場景常見：
每條 chain 有自己的「區域」manager，共用一個「全域」manager。

```java
package com.example.lab09.ch02;

import com.example.lab09.ch02.ProviderLoopScenario.ApiKeyToken;
import com.example.lab09.ch02.ProviderLoopScenario.TypedProvider;
import com.example.lab09.ch02.ProviderLoopScenario.TypedProvider.Outcome;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;

import java.util.List;

class ParentManagerTest {

    static void run(String title, ProviderManager pm, Authentication in) {
        System.out.println("\n── " + title);
        try {
            System.out.println("  ✅ 成功: " + Probe.describe(pm.authenticate(in)));
        } catch (AuthenticationException e) {
            System.out.println("  ❌ " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    @Test
    void parentManager() {
        System.out.println("\n═══ 2.4.4 parent AuthenticationManager ═══");
        ProviderManager parent = new ProviderManager(List.of(
                new TypedProvider("PARENT-Upt", UsernamePasswordAuthenticationToken.class, Outcome.SUCCESS)));
        ProviderManager child = new ProviderManager(
                List.of(new TypedProvider("CHILD-ApiKey", ApiKeyToken.class, Outcome.SUCCESS)),
                parent);

        run("child 沒人 supports → 交給 parent", child,
                UsernamePasswordAuthenticationToken.unauthenticated("alice", "pw"));
        run("child 有人 supports → parent 不會被問到", child, new ApiKeyToken("k-1"));
    }
}
```

```
═══ 2.4.4 parent AuthenticationManager ═══

── child 沒人 supports → 交給 parent
    supports(UsernamePasswordAuthenticationToken) → CHILD-ApiKey = false
    supports(UsernamePasswordAuthenticationToken) → PARENT-Upt = true
    ▶ PARENT-Upt.authenticate() 被呼叫
  ✅ 成功: UsernamePasswordAuthenticationToken{ principal=alice, credentials=null, authenticated=true, authorities=[ROLE_USER] }

── child 有人 supports → parent 不會被問到
    supports(ApiKeyToken) → CHILD-ApiKey = true
    ▶ CHILD-ApiKey.authenticate() 被呼叫
  ✅ 成功: UsernamePasswordAuthenticationToken{ principal=api-key, credentials=null, authenticated=true, authorities=[ROLE_USER] }
```

📌 **這就是 `AuthenticationManagerBuilder` 在多條 chain 下的運作方式**：
每一條 chain 用 `http.authenticationManager(...)` 建自己的，
沒設的就往上走到「全域」的那一個（2.6 會講那個全域的是怎麼組出來的）。

### 2.4.5 `eraseCredentials` 與認證事件

**2.2.2 那個「`credentials` 從 `"pw"` 變成 `null`」，就是這一行做的**：

```java
if (this.eraseCredentialsAfterAuthentication && (result instanceof CredentialsContainer)) {
    ((CredentialsContainer) result).eraseCredentials();
}
```

```java
public interface CredentialsContainer {
    void eraseCredentials();
}
```

**`UsernamePasswordAuthenticationToken` 實作了它，而且會【連 principal 一起清】**：

```java
// AbstractAuthenticationToken.eraseCredentials()
public void eraseCredentials() {
    eraseSecret(getCredentials());
    eraseSecret(getPrincipal());     // ★ principal 若也是 CredentialsContainer，一起清
    eraseSecret(this.details);
}
```

⚠️ **這對你自己的 `UserDetails` 實作有一個實際影響**：

```
Spring 內建的 User 類別實作了 CredentialsContainer，
所以認證成功後，SecurityContext 裡那個 UserDetails 的 getPassword() 會是 null。

→ 如果你在 Controller 裡拿 @AuthenticationPrincipal 出來，想讀 getPassword()：拿到 null。
→ 這是【對的】：認證完成後，記憶體裡不應該還留著密碼雜湊。
```

**2.7.2 的 `AppUserDetails` 刻意【沒有】實作 `CredentialsContainer`**——
它是一個 `record` 風格的不可變快照，本來就不打算被清空。
**如果你的 `UserDetails` 會被放進 session（有狀態 API），
請認真考慮不要把 `passwordHash` 存進去**（2.7.3 的坑之一）。

**關掉它的唯一合理場景**：

```java
ProviderManager pm = new ProviderManager(dao);
pm.setEraseCredentialsAfterAuthentication(false);   // ⚠️ 只有在 parent/child 兩層都要驗時才需要
```

**因為 child 抹掉之後，parent 就拿不到密碼了。**

📌 **順帶一提，`ProviderManager` 還會發事件**：

```java
this.eventPublisher.publishAuthenticationSuccess(result);   // AuthenticationSuccessEvent
prepareException(lastException, authentication);            // AbstractAuthenticationFailureEvent
```

**這是 08 章「登入稽核」的掛載點**——你只要寫一個 `@EventListener` 就能記錄所有登入：

```java
@Component
public class LoginAuditor {
    @EventListener
    public void onSuccess(AuthenticationSuccessEvent e) { /* 08 章 */ }
    @EventListener
    public void onFailure(AbstractAuthenticationFailureEvent e) { /* 07 章的鎖定計數 */ }
}
```

---

## 2.5 `DaoAuthenticationProvider`：把「22873 倍」講完

### 2.5.1 `authenticate()` 的七個步驟

**帳密認證的實作在兩個類別裡**：
`AbstractUserDetailsAuthenticationProvider` 定義流程，`DaoAuthenticationProvider` 填內容。

```java
// org.springframework.security.authentication.dao.AbstractUserDetailsAuthenticationProvider（6.2.4）
public Authentication authenticate(Authentication authentication) throws AuthenticationException {
    Assert.isInstanceOf(UsernamePasswordAuthenticationToken.class, authentication, () -> …);
    String username = determineUsername(authentication);
    boolean cacheWasUsed = true;
    UserDetails user = this.userCache.getUserFromCache(username);          // ① 先看快取
    if (user == null) {
        cacheWasUsed = false;
        try {
            user = retrieveUser(username, (UsernamePasswordAuthenticationToken) authentication);  // ② 查
        }
        catch (UsernameNotFoundException ex) {
            this.logger.debug("Failed to find user '" + username + "'");
            if (!this.hideUserNotFoundExceptions) {
                throw ex;
            }
            throw new BadCredentialsException(this.messages.getMessage(       // ③ 換成一般的憑證錯誤
                    "AbstractUserDetailsAuthenticationProvider.badCredentials", "Bad credentials"));
        }
        Assert.notNull(user, "retrieveUser returned null - a violation of the interface contract");
    }
    try {
        this.preAuthenticationChecks.check(user);                             // ④ ★ 帳號狀態（先！）
        additionalAuthenticationChecks(user, (UsernamePasswordAuthenticationToken) authentication);  // ⑤ 密碼
    }
    catch (AuthenticationException ex) {
        if (!cacheWasUsed) {
            throw ex;
        }
        cacheWasUsed = false;                                                 // 快取可能過期，重查一次
        user = retrieveUser(username, (UsernamePasswordAuthenticationToken) authentication);
        this.preAuthenticationChecks.check(user);
        additionalAuthenticationChecks(user, (UsernamePasswordAuthenticationToken) authentication);
    }
    this.postAuthenticationChecks.check(user);                                // ⑥ 密碼是否過期
    if (!cacheWasUsed) {
        this.userCache.putUserInCache(user);
    }
    Object principalToReturn = user;
    if (this.forcePrincipalAsString) {
        principalToReturn = user.getUsername();
    }
    return createSuccessAuthentication(principalToReturn, authentication, user);  // ⑦ 組出結果
}
```

**七個步驟，四個是擴充點**：

| 步驟 | 做什麼 | 可換的零件 |
|---|---|---|
| ① | 查快取 | `setUserCache(UserCache)` —— 預設是 `NullUserCache`（**不快取**） |
| ② | 查使用者 | **`UserDetailsService`**（2.7） |
| ③ | 隱藏「查無此人」 | `setHideUserNotFoundExceptions(boolean)`（2.5.4） |
| ④ | 檢查帳號狀態 | `setPreAuthenticationChecks(UserDetailsChecker)`（2.7.6） |
| ⑤ | 比對密碼 | **`PasswordEncoder`**（00 章 0.7） |
| ⑥ | 檢查密碼是否過期 | `setPostAuthenticationChecks(UserDetailsChecker)` |
| ⑦ | 組結果（順便升級密碼） | **`UserDetailsPasswordService`**（2.8） |

🔴 **記住 ④ 在 ⑤ 之前。** 這一節後半段會證明它是一個可以被量出來的資訊洩漏。

### 2.5.2 計時攻擊防護：`mitigateAgainstTimingAttack`

**00 章 0.3.4 量到「Spring 的做法是 1.00 倍」，程式碼在這裡**：

```java
// org.springframework.security.authentication.dao.DaoAuthenticationProvider（6.2.4）
private static final String USER_NOT_FOUND_PASSWORD = "userNotFoundPassword";

private volatile String userNotFoundEncodedPassword;

protected final UserDetails retrieveUser(String username, UsernamePasswordAuthenticationToken authentication)
        throws AuthenticationException {
    prepareTimingAttackProtection();                       // ① 先把假雜湊算好（只算一次）
    try {
        UserDetails loadedUser = this.getUserDetailsService().loadUserByUsername(username);
        if (loadedUser == null) {
            throw new InternalAuthenticationServiceException(
                    "UserDetailsService returned null, which is an interface contract violation");
        }
        return loadedUser;
    }
    catch (UsernameNotFoundException ex) {
        mitigateAgainstTimingAttack(authentication);       // ② ★ 只有【這一條】catch 有補做 BCrypt
        throw ex;
    }
    catch (InternalAuthenticationServiceException ex) {
        throw ex;                                          // ③ 沒有補
    }
    catch (Exception ex) {
        throw new InternalAuthenticationServiceException(ex.getMessage(), ex);   // ④ 也沒有補
    }
}

private void prepareTimingAttackProtection() {
    if (this.userNotFoundEncodedPassword == null) {
        this.userNotFoundEncodedPassword = this.passwordEncoder.encode(USER_NOT_FOUND_PASSWORD);
    }
}

private void mitigateAgainstTimingAttack(UsernamePasswordAuthenticationToken authentication) {
    if (authentication.getCredentials() != null) {
        String presentedPassword = authentication.getCredentials().toString();
        this.passwordEncoder.matches(presentedPassword, this.userNotFoundEncodedPassword);
    }
}
```

**整個防護就是一句話**：

> **找不到使用者的時候，仍然對一個假雜湊做一次完整的 BCrypt 比對，把 CPU 工作量補齊。**

⚠️ **請盯著 `retrieveUser` 的四個出口看**：

```
① return loadedUser                       ← 找到了，後面會做真的 BCrypt
② catch UsernameNotFoundException         ← ★ 唯一有補做假 BCrypt 的路徑
③ catch InternalAuthenticationService…    ← 沒補（含「回 null」）
④ catch Exception                         ← 沒補（含你自己拋的任何其他例外）
```

📌 **也就是說：這個防護的前提是「你的 `UserDetailsService` 在查無此人時，
拋出 `UsernameNotFoundException`」。這是一個約定，而編譯器不會幫你檢查。**

**下一節量四種違反約定的寫法，各自漏了多少。**

### 2.5.3 🔴 實測：四種讓計時保護失效的寫法

```java
package com.example.lab09.ch02;

import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.*;

class TimingDeepTest {

    static final PasswordEncoder ENC = new BCryptPasswordEncoder();      // cost = 10
    static final String HASH = ENC.encode("pw");

    record Result(long medianMicros, String exception) {}

    /** 量中位數（µs），並回報最後一次拋出的例外 */
    static Result measure(AuthenticationManager am, String user, String pw, int n) {
        long[] xs = new long[n];
        String ex = "（沒有拋例外）";
        for (int i = 0; i < n; i++) {
            long t0 = System.nanoTime();
            try {
                am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(user, pw));
            } catch (RuntimeException e) {
                ex = e.getClass().getSimpleName() + ": " + e.getMessage();
            }
            xs[i] = System.nanoTime() - t0;
        }
        Arrays.sort(xs);
        return new Result(xs[n / 2] / 1000, ex);
    }

    static void compare(String title, AuthenticationManager am) {
        int n = 25;
        measure(am, "alice", "WRONG", 5);                                 // 暖機
        Result exists = measure(am, "alice", "WRONG", n);
        Result missing = measure(am, "nobody", "WRONG", n);
        System.out.printf("%n── %s%n", title);
        System.out.printf("   帳號【存在】、密碼錯: %,8d µs   %s%n", exists.medianMicros(), exists.exception());
        System.out.printf("   帳號【不存在】      : %,8d µs   %s%n", missing.medianMicros(), missing.exception());
        double ratio = missing.medianMicros() == 0 ? Double.POSITIVE_INFINITY
                : (double) exists.medianMicros() / missing.medianMicros();
        System.out.printf("   差距                : %s%n",
                ratio > 3 ? String.format("🔴 %.0f 倍 —— 帳號存不存在被洩漏", ratio)
                          : String.format("✅ %.2f 倍", ratio));
    }

    static DaoAuthenticationProvider dao(UserDetailsService uds) {
        DaoAuthenticationProvider p = new DaoAuthenticationProvider();
        p.setUserDetailsService(uds);
        p.setPasswordEncoder(ENC);
        return p;
    }

    static UserDetails alice() {
        return User.withUsername("alice").password(HASH).roles("USER").build();
    }

    @Test
    void a_correct() {
        System.out.println("\n═══ 2.5.2 正確寫法：查不到就拋 UsernameNotFoundException ═══");
        compare("UserDetailsService 拋 UsernameNotFoundException（Spring 的約定）",
                new ProviderManager(dao(u -> {
                    if (u.equals("alice")) return alice();
                    throw new UsernameNotFoundException(u);
                })));
    }

    @Test
    void b_returnNull() {
        System.out.println("\n═══ 2.5.3【壞法一】查不到就 return null ═══");
        compare("UserDetailsService 回 null",
                new ProviderManager(dao(u -> u.equals("alice") ? alice() : null)));
    }

    @Test
    void c_swallow() {
        System.out.println("\n═══ 2.5.3【壞法二】自己把例外換成 BadCredentialsException ═══");
        compare("UserDetailsService 直接拋 BadCredentialsException",
                new ProviderManager(dao(u -> {
                    if (u.equals("alice")) return alice();
                    throw new BadCredentialsException("查無此人");
                })));
    }

    @Test
    void d_handRolled() {
        System.out.println("\n═══ 2.5.3【壞法三】自己寫 AuthenticationProvider ═══");
        AuthenticationProvider hand = new AuthenticationProvider() {
            final Map<String, UserDetails> db = Map.of("alice", alice());
            @Override public Authentication authenticate(Authentication a) throws AuthenticationException {
                UserDetails u = db.get(a.getName());
                if (u == null) throw new BadCredentialsException("帳號或密碼錯誤");
                if (!ENC.matches(a.getCredentials().toString(), u.getPassword()))
                    throw new BadCredentialsException("帳號或密碼錯誤");
                return new UsernamePasswordAuthenticationToken(u, null, u.getAuthorities());
            }
            @Override public boolean supports(Class<?> c) {
                return UsernamePasswordAuthenticationToken.class.isAssignableFrom(c);
            }
        };
        compare("回應內容完全一致（都是「帳號或密碼錯誤」），但時間不一致", new ProviderManager(hand));
    }

    @Test
    void e_accountStatus() {
        System.out.println("\n═══ 2.5.3【壞法四？】帳號被停用 —— 這個【不是】你寫錯的 ═══");
        UserDetailsService uds = u -> switch (u) {
            case "alice" -> alice();
            case "carol" -> User.withUsername("carol").password(HASH).roles("USER").disabled(true).build();
            case "dave"  -> User.withUsername("dave").password(HASH).roles("USER").accountLocked(true).build();
            default -> throw new UsernameNotFoundException(u);
        };
        ProviderManager am = new ProviderManager(dao(uds));
        int n = 25;
        measure(am, "alice", "WRONG", 5);
        for (String[] c : new String[][]{
                {"alice（正常帳號）、密碼錯", "alice"},
                {"carol（disabled）、密碼錯 ", "carol"},
                {"dave （locked）  、密碼錯 ", "dave"},
                {"nobody（不存在） 、密碼錯 ", "nobody"}}) {
            Result r = measure(am, c[1], "WRONG", n);
            System.out.printf("   %s: %,8d µs   %s%n", c[0], r.medianMicros(), r.exception());
        }
    }
}
```

**先看基準線**：

```
═══ 2.5.2 正確寫法：查不到就拋 UsernameNotFoundException ═══

── UserDetailsService 拋 UsernameNotFoundException（Spring 的約定）
   帳號【存在】、密碼錯:   72,003 µs   BadCredentialsException: 憑證錯誤
   帳號【不存在】      :   71,456 µs   BadCredentialsException: 憑證錯誤
   差距                : ✅ 1.01 倍
```

**現在是三種常見的寫法**：

```
═══ 2.5.3【壞法一】查不到就 return null ═══

── UserDetailsService 回 null
   帳號【存在】、密碼錯:   71,095 µs   BadCredentialsException: 憑證錯誤
   帳號【不存在】      :        6 µs   InternalAuthenticationServiceException: UserDetailsService returned null, which is an interface contract violation
   差距                : 🔴 11849 倍 —— 帳號存不存在被洩漏

═══ 2.5.3【壞法二】自己把例外換成 BadCredentialsException ═══

── UserDetailsService 直接拋 BadCredentialsException
   帳號【存在】、密碼錯:   69,936 µs   BadCredentialsException: 憑證錯誤
   帳號【不存在】      :        9 µs   InternalAuthenticationServiceException: 查無此人
   差距                : 🔴 7771 倍 —— 帳號存不存在被洩漏

═══ 2.5.3【壞法三】自己寫 AuthenticationProvider ═══

── 回應內容完全一致（都是「帳號或密碼錯誤」），但時間不一致
   帳號【存在】、密碼錯:   71,255 µs   BadCredentialsException: 帳號或密碼錯誤
   帳號【不存在】      :        6 µs   BadCredentialsException: 帳號或密碼錯誤
   差距                : 🔴 11876 倍 —— 帳號存不存在被洩漏
```

**三種寫法，三次把 00 章那個 22873 倍原封不動地放回來。**

⚠️ **壞法二有一個附加傷害，值得單獨看一眼**：

```
你【寫的】是   BadCredentialsException
實際【拋出】的是 InternalAuthenticationServiceException: 查無此人
```

**因為 `retrieveUser` 的第四個 catch 會把「任何其他例外」包成
`InternalAuthenticationServiceException`。** 這帶來兩個後果：

```
① 2.4.3 案例 C：InternalAuthenticationServiceException 會【立刻中止 provider 迴圈】
   → 你的「LDAP 備援 provider」永遠不會被執行到

② 這個例外在 AbstractAuthenticationProcessingFilter 裡走的是 logger.error(...) 那一條
   → 你的錯誤日誌會被「有人打了一個不存在的帳號」灌爆
```

📌 **這是一個「三個 bug 疊在一起、但症狀只有一個」的典型例子。**
而三個都源自同一件事：**沒有遵守「查不到就拋 `UsernameNotFoundException`」這個約定。**

**最後看第四種——這個不是你寫錯的**：

```
═══ 2.5.3【壞法四？】帳號被停用 —— 這個【不是】你寫錯的 ═══
   alice（正常帳號）、密碼錯:   71,254 µs   BadCredentialsException: 憑證錯誤
   carol（disabled）、密碼錯 :       12 µs   DisabledException: 使用者已被停用
   dave （locked）  、密碼錯 :       11 µs   LockedException: 使用者帳號已被鎖定
   nobody（不存在） 、密碼錯 :   70,513 µs   BadCredentialsException: 憑證錯誤
```

🔴 **看清楚這四列的排列**：

```
存在且正常  71,254 µs  ┐
不存在      70,513 µs  ┘ 這兩個一樣 —— 計時保護有效

存在但停用      12 µs  ┐
存在但鎖定      11 µs  ┘ 這兩個【快了六千倍】
```

**因為 2.5.1 的步驟 ④（`preAuthenticationChecks`）在步驟 ⑤（密碼比對）【之前】。**
帳號一旦被停用或鎖定，`DisabledException` / `LockedException` 在跑 BCrypt 之前就拋出來了。

**攻擊者能拿到什麼？**

```
用一個隨便的密碼打一輪
  回應 71 ms → 這個帳號「不存在」或「存在且正常」（分不出來，✅ 保護有效）
  回應 12 µs → ★ 這個帳號【確定存在】，而且【被停用或鎖定】
```

⚠️ **這件事跟 07 章的「登入失敗三次鎖定」放在一起會變得更嚴重**：

```
① 對目標帳號連打三次錯密碼 → 帳號被鎖定
② 再打一次，看回應時間
   12 µs  → 鎖定成功 → ★ 這個帳號【存在】
   71 ms  → 沒被鎖 → 這個帳號不存在
```

**「帳號鎖定」這個防禦機制，反過來變成了「帳號列舉」的工具。**

**兩個修法**（07 章 7.4 會做完整版）：

```java
// 修法 A：把帳號狀態檢查【搬到密碼比對之後】
DaoAuthenticationProvider p = new DaoAuthenticationProvider();
p.setUserDetailsService(uds);
p.setPasswordEncoder(enc);
p.setPreAuthenticationChecks(user -> { });          // ① 前置檢查改成什麼都不做
p.setPostAuthenticationChecks(user -> {             // ② 全部搬到密碼比對之後
    if (!user.isAccountNonLocked()) throw new LockedException("帳號已鎖定");
    if (!user.isEnabled())          throw new DisabledException("帳號已停用");
    if (!user.isAccountNonExpired()) throw new AccountExpiredException("帳號已過期");
    if (!user.isCredentialsNonExpired()) throw new CredentialsExpiredException("密碼已過期");
});
```

**修法 A 的實測（同一組帳號，修前 / 修後）**：

```java
package com.example.lab09.ch02;

import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.Arrays;

class StatusCheckOrderTest {

    static final PasswordEncoder ENC = new BCryptPasswordEncoder();
    static final String HASH = ENC.encode("pw");

    static UserDetailsService uds() {
        return u -> switch (u) {
            case "alice" -> User.withUsername("alice").password(HASH).roles("USER").build();
            case "carol" -> User.withUsername("carol").password(HASH).roles("USER").disabled(true).build();
            case "dave"  -> User.withUsername("dave").password(HASH).roles("USER").accountLocked(true).build();
            default -> throw new UsernameNotFoundException(u);
        };
    }

    static long median(AuthenticationManager am, String u, String pw, int n) {
        long[] xs = new long[n];
        for (int i = 0; i < n; i++) {
            long t0 = System.nanoTime();
            try { am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(u, pw)); }
            catch (RuntimeException ignored) {}
            xs[i] = System.nanoTime() - t0;
        }
        Arrays.sort(xs);
        return xs[n / 2] / 1000;
    }

    static String outcome(AuthenticationManager am, String u, String pw) {
        try { am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(u, pw)); return "✅ 通過"; }
        catch (RuntimeException e) { return e.getClass().getSimpleName() + ": " + e.getMessage(); }
    }

    static void table(String title, AuthenticationManager am) {
        System.out.println("\n── " + title);
        median(am, "alice", "WRONG", 5);                              // 暖機
        for (String[] c : new String[][]{
                {"alice （正常）  密碼錯", "alice", "WRONG"},
                {"carol （停用）  密碼錯", "carol", "WRONG"},
                {"dave  （鎖定）  密碼錯", "dave",  "WRONG"},
                {"nobody（不存在）密碼錯", "nobody","WRONG"},
                {"carol （停用）  密碼對", "carol", "pw"},
                {"dave  （鎖定）  密碼對", "dave",  "pw"},
                {"alice （正常）  密碼對", "alice", "pw"}}) {
            System.out.printf("   %s: %,8d µs   %s%n", c[0], median(am, c[1], c[2], 21),
                    outcome(am, c[1], c[2]));
        }
    }

    static DaoAuthenticationProvider base() {
        DaoAuthenticationProvider p = new DaoAuthenticationProvider();
        p.setUserDetailsService(uds());
        p.setPasswordEncoder(ENC);
        return p;
    }

    @Test
    void beforeAndAfter() {
        System.out.println("\n═══ 2.5.3 修法 A：把帳號狀態檢查搬到密碼比對之後 ═══");
        table("預設（前置檢查在密碼之前）", new ProviderManager(base()));

        DaoAuthenticationProvider fixed = base();
        fixed.setPreAuthenticationChecks(user -> { });
        fixed.setPostAuthenticationChecks(user -> {
            if (!user.isAccountNonLocked())      throw new LockedException("帳號已鎖定");
            if (!user.isEnabled())               throw new DisabledException("帳號已停用");
            if (!user.isAccountNonExpired())     throw new AccountExpiredException("帳號已過期");
            if (!user.isCredentialsNonExpired()) throw new CredentialsExpiredException("密碼已過期");
        });
        table("修法 A（全部搬到 postAuthenticationChecks）", new ProviderManager(fixed));
    }
}
```

```
═══ 2.5.3 修法 A：把帳號狀態檢查搬到密碼比對之後 ═══

── 預設（前置檢查在密碼之前）
   alice （正常）  密碼錯:   69,298 µs   BadCredentialsException: 憑證錯誤
   carol （停用）  密碼錯:       13 µs   DisabledException: 使用者已被停用
   dave  （鎖定）  密碼錯:       14 µs   LockedException: 使用者帳號已被鎖定
   nobody（不存在）密碼錯:   68,893 µs   BadCredentialsException: 憑證錯誤
   carol （停用）  密碼對:       13 µs   DisabledException: 使用者已被停用
   dave  （鎖定）  密碼對:       13 µs   LockedException: 使用者帳號已被鎖定
   alice （正常）  密碼對:   69,946 µs   ✅ 通過

── 修法 A（全部搬到 postAuthenticationChecks）
   alice （正常）  密碼錯:   88,529 µs   BadCredentialsException: 憑證錯誤
   carol （停用）  密碼錯:   93,598 µs   BadCredentialsException: 憑證錯誤
   dave  （鎖定）  密碼錯:   93,944 µs   BadCredentialsException: 憑證錯誤
   nobody（不存在）密碼錯:   91,635 µs   BadCredentialsException: 憑證錯誤
   carol （停用）  密碼對:   85,247 µs   DisabledException: 帳號已停用
   dave  （鎖定）  密碼對:   69,534 µs   LockedException: 帳號已鎖定
   alice （正常）  密碼對:   68,786 µs   ✅ 通過
```

**修後的四個「密碼錯」全部落在同一個量級，而且回同一種例外。**
帳號狀態只有在**密碼正確**時才會被說出來——最後三列。

> 💡 那一輪的絕對值（88～93 ms）比前一輪（69 ms）高，是同一台機器上的背景負載造成的。
> **要看的是【同一組內部】的差距，不是跨組的絕對值**——
> 修前組內差 5000 倍，修後組內差 1.07 倍。

```java
package com.example.lab09.ch02;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 修法 B：在 Filter 層補一個「最短回應時間」的下限。
 * 對 2.5.3 的三種壞法也有效，是一道通用的防線。
 */
public class MinimumDurationFilter extends OncePerRequestFilter {
    private static final long MIN_NANOS = 250_000_000L;      // 250 ms

    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain ch)
            throws ServletException, IOException {
        long t0 = System.nanoTime();
        try {
            ch.doFilter(req, res);
        } finally {
            long remain = MIN_NANOS - (System.nanoTime() - t0);
            if (remain > 0) {
                try { Thread.sleep(remain / 1_000_000L, (int) (remain % 1_000_000L)); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
        }
    }

    @Override protected boolean shouldNotFilter(HttpServletRequest req) {
        return !"/api/auth/login".equals(req.getServletPath());   // 只套在登入端點上
    }
}
```

⚠️ **修法 B 的代價要算清楚**：每個登入請求佔住一條執行緒 250 ms。
以 Tomcat 預設 200 條執行緒計算，登入端點的上限是 **800 個/秒**——
比 2.3.5 那個 73 個/秒好，但你必須知道這個數字存在。
**修法 A 沒有這個代價，優先用 A。**

📌 **修法 A 有一個副作用要接受**：
被鎖定的使用者**必須輸入正確的密碼**，才會看到「你的帳號被鎖定了」。
密碼打錯時他只會看到「帳號或密碼錯誤」。這是**刻意的取捨**——
把「告訴使用者帳號狀態」這件事，往後移到「他證明了自己是本人」之後。

### 2.5.4 `hideUserNotFoundExceptions`

**2.5.1 步驟 ③ 那個開關，預設是 `true`**：

```java
catch (UsernameNotFoundException ex) {
    this.logger.debug("Failed to find user '" + username + "'");
    if (!this.hideUserNotFoundExceptions) {
        throw ex;                                                   // 原樣往外拋
    }
    throw new BadCredentialsException(this.messages.getMessage(     // 換成一般的憑證錯誤
            "AbstractUserDetailsAuthenticationProvider.badCredentials", "Bad credentials"));
}
```

```java
// 🔴 很多教學為了「除錯方便」會叫你關掉它
provider.setHideUserNotFoundExceptions(false);
```

**關掉之後**（00 章 0.3.4 量過）：

```
密碼錯     → BadCredentialsException: 憑證錯誤
帳號不存在 → UsernameNotFoundException: nobody      ← ★ 例外訊息就是那個不存在的帳號名
```

⚠️ **這個開關的危險不在「例外型別不同」，而在於它會沿著三條路徑洩漏出去**：

```
① 你的 @ExceptionHandler 若照型別分流，回應內容就會不同
② failureHandler 若把 ex.getMessage() 寫進回應（很常見的「方便除錯」）
③ 錯誤日誌若被送到前端可讀的地方（例如某些 APM 的 public dashboard）
```

📌 **判準**：

```
本機開發   關掉都無所謂
測試環境   建議開著 —— 你的整合測試才會測到「對外一致」這件事
正式環境   ★ 一定要開著（預設值）
```

**要除錯的話，正確做法是提高日誌等級，不是改行為**：

```yaml
logging:
  level:
    org.springframework.security.authentication.dao.DaoAuthenticationProvider: DEBUG
```

```
DEBUG ... DaoAuthenticationProvider : Failed to find user 'nobody'
```

**同樣的資訊，但只出現在你的日誌裡。**

### 2.5.5 三條可以直接寫進 code review 清單的規則

```
□ 規則一：UserDetailsService 查不到人，一定拋 UsernameNotFoundException
          不可以 return null（壞法一：11849 倍 + 中止 provider 迴圈）
          不可以自己換成 BadCredentialsException（壞法二：7771 倍 + 灌爆錯誤日誌）

□ 規則二：不要自己寫「查帳號 + 比密碼」的 AuthenticationProvider
          要客製就【繼承】DaoAuthenticationProvider，覆寫 additionalAuthenticationChecks
          並且先呼叫 super（壞法三：11876 倍）

□ 規則三：帳號狀態檢查（enabled / locked / expired）要搬到密碼比對【之後】
          用 setPreAuthenticationChecks(user -> {}) + setPostAuthenticationChecks(...)
          否則「被鎖定的帳號」會用回應時間告訴攻擊者它存在（壞法四：快 6000 倍）
```

📌 **這三條的共同形狀，就是 00 章 0.3.7 那張表的第 4 列**：

> **「我的邏輯完全正確」不等於「我的實作是安全的」——**
> **安全性不只看回傳值，還看【執行路徑】。**

---

## 2.6 `AuthenticationManager` 為什麼不是 bean

### 2.6.1 6.x 改了什麼

00 章 0.3.6 踩過這個坑：

```
Parameter 0 of constructor in ...ManualLoginV6 required a bean of type
'org.springframework.security.authentication.AuthenticationManager' that could not be found.
```

**5.x 的時候，`WebSecurityConfigurerAdapter` 會替你註冊一個。**
6.x 把 `WebSecurityConfigurerAdapter` 刪掉了，那個副作用也跟著消失。

📌 **但這不只是「刪掉一個類別的連帶效果」，它是一個刻意的設計決定。理由有三個**：

```
① AuthenticationManager 是【每一條 SecurityFilterChain 各自擁有】的東西（2.4.4 的 parent/child）
   註冊成一個全域 bean，就暗示「全站只有一個」—— 而那在多條 chain 的專案裡是錯的。

② 它的內容取決於容器裡有哪些 UserDetailsService / AuthenticationProvider / PasswordEncoder，
   而那些 bean 可能還沒建好 —— 一個「會依賴半個容器」的 bean 很容易造成循環相依。

③ 大部分人根本【不需要】它。
   你只有在「要自己呼叫認證」時才需要 —— 而那只有兩種場合：
   自訂登入端點（2.3.6 的進階版 / 05 章 JWT），以及測試。
```

### 2.6.2 實測：七種寫法

**把七種常見寫法各啟動一次應用程式，看誰活著、誰能用。**

```java
package com.example.lab09.ch02;

import org.springframework.context.annotation.*;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

public class AuthManagerScenarios {

    /** 七個情境共用：一組記憶體帳號 + 一條最小的 chain */
    @Configuration
    @Profile("am")
    static class Accounts {
        @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }

        @Bean UserDetailsService uds(PasswordEncoder enc) {
            return new InMemoryUserDetailsManager(
                    User.withUsername("alice").password(enc.encode("pw")).roles("USER").build());
        }

        @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.requestMatchers("/am/**", "/error").permitAll()
                                                    .anyRequest().authenticated())
                       .csrf(c -> c.disable())
                       .build();
        }
    }

    /** 一個「需要自己呼叫認證」的端點 —— 05 章的 JWT 登入端點就長這樣 */
    @RestController
    @RequestMapping("/am")
    @Profile("am")
    static class LoginApi {
        private final AuthenticationManager am;
        LoginApi(AuthenticationManager am) { this.am = am; }

        @PostMapping("/login")
        public Map<String, Object> login(@RequestParam String u, @RequestParam String p) {
            try {
                Authentication a = am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(u, p));
                return Map.of("ok", true, "name", a.getName(),
                              "authorities", a.getAuthorities().toString(),
                              "managerClass", am.getClass().getSimpleName());
            } catch (AuthenticationException e) {
                return Map.of("ok", false, "error", e.getClass().getSimpleName() + ": " + e.getMessage());
            } catch (Throwable e) {                       // ★ 抓 Throwable —— am6 會丟 StackOverflowError
                return Map.of("ok", false, "throwable", e.getClass().getName() + ": " + e.getMessage(),
                              "depth", e.getStackTrace().length);
            }
        }
    }

    /** am1：直接 @Autowired AuthenticationManager */
    @Service
    @Profile("am1")
    static class NeedsManager {
        NeedsManager(AuthenticationManager am) {}
    }

    /** am2：✅ 從 AuthenticationConfiguration 拿（Spring Security 官方寫法） */
    @Configuration
    @Profile("am2")
    static class Am2FromConfiguration {
        @Bean AuthenticationManager am(AuthenticationConfiguration cfg) throws Exception {
            return cfg.getAuthenticationManager();
        }
    }

    /** am3：✅ 自己組一個 ProviderManager（最明確，也最容易看懂） */
    @Configuration
    @Profile("am3")
    static class Am3BuildItYourself {
        @Bean AuthenticationManager am(UserDetailsService uds, PasswordEncoder enc) {
            DaoAuthenticationProvider p = new DaoAuthenticationProvider();
            p.setUserDetailsService(uds);
            p.setPasswordEncoder(enc);
            return new ProviderManager(p);
        }
    }

    /** am4：把 AuthenticationManager 注進【另一條】SecurityFilterChain 的 bean 方法 */
    @Configuration
    @Profile("am4")
    static class Am4IntoChain {
        @Bean AuthenticationManager am(AuthenticationConfiguration cfg) throws Exception {
            return cfg.getAuthenticationManager();
        }
        @Bean SecurityFilterChain chain2(HttpSecurity http, AuthenticationManager am) throws Exception {
            return http.securityMatcher("/never/**")
                       .authorizeHttpRequests(a -> a.anyRequest().authenticated())
                       .authenticationManager(am)
                       .build();
        }
    }

    /** am5：宣告一個 AuthenticationProvider bean */
    @Configuration
    @Profile("am5")
    static class Am5ProviderBean {
        @Bean AuthenticationProvider myProvider(UserDetailsService uds, PasswordEncoder enc) {
            DaoAuthenticationProvider p = new DaoAuthenticationProvider();
            p.setUserDetailsService(uds);
            p.setPasswordEncoder(enc);
            return p;
        }
        @Bean AuthenticationManager am(AuthenticationConfiguration cfg) throws Exception {
            return cfg.getAuthenticationManager();
        }
    }

    /** am6：🔴 容器裡有【兩個】UserDetailsService bean */
    @Configuration
    @Profile("am6")
    static class Am6TwoUserDetailsServices {
        @Bean UserDetailsService secondUds(PasswordEncoder enc) {          // ★ 第二個
            return new InMemoryUserDetailsManager(
                    User.withUsername("legacy").password(enc.encode("pw")).roles("USER").build());
        }
        @Bean AuthenticationManager am(AuthenticationConfiguration cfg) throws Exception {
            return cfg.getAuthenticationManager();
        }
    }

    /** am8：兩個 UserDetailsService，其中一個標 @Primary —— 有用嗎？（2.6.3） */
    @Configuration
    @Profile("am8")
    static class Am8Primary {
        @Bean @Primary
        UserDetailsService primaryUds(PasswordEncoder enc) {
            return new InMemoryUserDetailsManager(
                    User.withUsername("alice").password(enc.encode("pw")).roles("USER").build());
        }
        @Bean UserDetailsService secondUds(PasswordEncoder enc) {
            return new InMemoryUserDetailsManager(
                    User.withUsername("legacy").password(enc.encode("pw")).roles("USER").build());
        }
        @Bean AuthenticationManager am(AuthenticationConfiguration cfg) throws Exception {
            return cfg.getAuthenticationManager();
        }
    }

    /** am7：✅ 有兩個來源時，自己把 provider 一個一個列出來 */
    @Configuration
    @Profile("am7")
    static class Am7Explicit {
        @Bean UserDetailsService secondUds(PasswordEncoder enc) {
            return new InMemoryUserDetailsManager(
                    User.withUsername("legacy").password(enc.encode("pw")).roles("USER").build());
        }
        @Bean AuthenticationManager am(UserDetailsService uds, UserDetailsService secondUds, PasswordEncoder enc) {
            return new ProviderManager(daoOf(uds, enc), daoOf(secondUds, enc));
        }
        private static DaoAuthenticationProvider daoOf(UserDetailsService uds, PasswordEncoder enc) {
            DaoAuthenticationProvider p = new DaoAuthenticationProvider();
            p.setUserDetailsService(uds);
            p.setPasswordEncoder(enc);
            return p;
        }
    }
}
```

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import com.example.lab09.LabApp;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;

import java.net.http.HttpResponse;

class AuthManagerTest {

    /** 用指定的 profile 啟一次應用程式，把「啟得起來嗎、拿到什麼、能不能用」印出來 */
    static void boot(String profile, String note) {
        System.out.println("\n── " + profile + "：" + note);
        ConfigurableApplicationContext ctx = null;
        try {
            ctx = new SpringApplicationBuilder(LabApp.class)
                    .web(WebApplicationType.SERVLET)
                    .profiles("am", profile)
                    .properties("server.port=0", "logging.level.root=ERROR", "spring.main.banner-mode=off")
                    .run();
            System.out.println("  ✅ 啟動成功");

            try {
                AuthenticationManager am = ctx.getBean(AuthenticationManager.class);
                System.out.println("  容器裡的 AuthenticationManager: " + am.getClass().getSimpleName());
                if (am instanceof ProviderManager pm)
                    System.out.println("  它手上的 provider: "
                            + pm.getProviders().stream().map(p -> p.getClass().getSimpleName()).toList());
            } catch (Exception e) {
                System.out.println("  ❌ 容器裡沒有 AuthenticationManager: " + e.getClass().getSimpleName());
            }

            int port = ctx.getEnvironment().getProperty("local.server.port", Integer.class, 0);
            if (port > 0) {
                System.out.println("  POST /am/login → "
                        + body(new Http(port).send("POST", "/am/login?u=alice&p=pw", null)));
                System.out.println("  換 legacy 帳號  → "
                        + body(new Http(port).send("POST", "/am/login?u=legacy&p=pw", null)));
                System.out.println("  密碼打錯       → "
                        + body(new Http(port).send("POST", "/am/login?u=alice&p=WRONG", null)));
            }
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            System.out.println("  ❌ 啟動失敗: " + e.getClass().getSimpleName());
            System.out.println("     root cause: " + root.getClass().getSimpleName());
            System.out.println("     " + String.valueOf(root.getMessage()).lines().findFirst().orElse(""));
        } finally {
            if (ctx != null) ctx.close();
        }
    }

    static String body(HttpResponse<String> r) { return r.statusCode() + " " + r.body(); }

    @Test
    void sevenWays() {
        System.out.println("\n═══ 2.6.2 AuthenticationManager 的七種寫法 ═══");
        boot("am1", "直接 @Autowired AuthenticationManager");
        boot("am2", "從 AuthenticationConfiguration 拿");
        boot("am3", "自己 new 一個 ProviderManager");
        boot("am4", "把 AuthenticationManager 注進 SecurityFilterChain 的 bean 方法");
        boot("am5", "宣告一個 AuthenticationProvider bean");
        boot("am6", "容器裡有【兩個】UserDetailsService bean");
        boot("am7", "兩個來源，但自己把 provider 列出來");
    }

    /** 2.6.3：@Primary 救得了 am6 嗎 */
    @Test
    void eighthWay() {
        boot("am8", "兩個 UserDetailsService，其中一個標 @Primary");
    }
}
```

```
═══ 2.6.2 AuthenticationManager 的七種寫法 ═══

── am1：直接 @Autowired AuthenticationManager
  ❌ 啟動失敗: UnsatisfiedDependencyException
     root cause: NoSuchBeanDefinitionException
     No qualifying bean of type 'org.springframework.security.authentication.AuthenticationManager' available: expected at least 1 bean which qualifies as autowire candidate. Dependency annotations: {}

── am2：從 AuthenticationConfiguration 拿
  ✅ 啟動成功
  容器裡的 AuthenticationManager: ProviderManager
  它手上的 provider: [DaoAuthenticationProvider]
  POST /am/login → 200 {"managerClass":"ProviderManager","ok":true,"name":"alice","authorities":"[ROLE_USER]"}
  換 legacy 帳號  → 200 {"error":"BadCredentialsException: 憑證錯誤","ok":false}
  密碼打錯       → 200 {"error":"BadCredentialsException: 憑證錯誤","ok":false}

── am3：自己 new 一個 ProviderManager
  ✅ 啟動成功
  容器裡的 AuthenticationManager: ProviderManager
  它手上的 provider: [DaoAuthenticationProvider]
  POST /am/login → 200 {"managerClass":"ProviderManager","ok":true,"name":"alice","authorities":"[ROLE_USER]"}
  換 legacy 帳號  → 200 {"error":"BadCredentialsException: 憑證錯誤","ok":false}
  密碼打錯       → 200 {"error":"BadCredentialsException: 憑證錯誤","ok":false}

── am4：把 AuthenticationManager 注進 SecurityFilterChain 的 bean 方法
  ✅ 啟動成功
  容器裡的 AuthenticationManager: ProviderManager
  它手上的 provider: [DaoAuthenticationProvider]
  POST /am/login → 200 {"managerClass":"ProviderManager","ok":true,"name":"alice","authorities":"[ROLE_USER]"}

── am5：宣告一個 AuthenticationProvider bean
  ✅ 啟動成功
  容器裡的 AuthenticationManager: ProviderManager
  它手上的 provider: [DaoAuthenticationProvider]
  POST /am/login → 200 {"managerClass":"ProviderManager","ok":true,"name":"alice","authorities":"[ROLE_USER]"}
  換 legacy 帳號  → 200 {"error":"BadCredentialsException: Bad credentials","ok":false}
  密碼打錯       → 200 {"error":"BadCredentialsException: Bad credentials","ok":false}

── am6：容器裡有【兩個】UserDetailsService bean
  ✅ 啟動成功
  容器裡的 AuthenticationManager: $Proxy140
  POST /am/login → 200 {"throwable":"java.lang.StackOverflowError: null","depth":1024,"ok":false}
  換 legacy 帳號  → 200 {"throwable":"java.lang.StackOverflowError: null","depth":1024,"ok":false}
  密碼打錯       → 200 {"throwable":"java.lang.StackOverflowError: null","depth":1024,"ok":false}

── am7：兩個來源，但自己把 provider 列出來
  ✅ 啟動成功
  容器裡的 AuthenticationManager: ProviderManager
  它手上的 provider: [DaoAuthenticationProvider, DaoAuthenticationProvider]
  POST /am/login → 200 {"managerClass":"ProviderManager","ok":true,"name":"alice","authorities":"[ROLE_USER]"}
  換 legacy 帳號  → 200 {"managerClass":"ProviderManager","ok":true,"name":"legacy","authorities":"[ROLE_USER]"}
  密碼打錯       → 200 {"error":"BadCredentialsException: 憑證錯誤","ok":false}
```

**整理成一張表**：

| 寫法 | 啟動 | 拿到什麼 | 判定 |
|---|---|---|---|
| am1 直接注入 | ❌ **失敗** | `NoSuchBeanDefinitionException` | 6.x 不再自動註冊 |
| am2 `AuthenticationConfiguration` | ✅ | `ProviderManager[Dao…]` | ✅ **官方寫法，推薦** |
| am3 自己組 `ProviderManager` | ✅ | `ProviderManager[Dao…]` | ✅ **最明確，也推薦** |
| am4 注進另一條 chain | ✅ | `ProviderManager[Dao…]` | ✅ 可行（但通常不需要） |
| am5 宣告 `AuthenticationProvider` bean | ✅ | `ProviderManager[Dao…]` | ✅ 可行，**但錯誤訊息變英文**（2.6.4） |
| am6 **兩個** `UserDetailsService` | ✅ **啟動成功** | **`$Proxy140`** | 🔴 **第一次登入 `StackOverflowError`** |
| am7 兩個來源 + 明確列出 | ✅ | `ProviderManager[Dao…, Dao…]` | ✅ **兩個帳號都能登入** |

📌 **am7 那一列的最後一格值得看**：`alice` 與 `legacy` **兩個帳號都登得進去**。
這就是「合併兩套帳號系統」的正確做法——
**不要寫一個「先查 A、查不到再查 B」的 `UserDetailsService`**（那會破壞 2.5 的計時保護），
**而是給 `ProviderManager` 兩個 provider，讓 2.4.1 的迴圈幫你做。**

### 2.6.3 🔴 兩個 `UserDetailsService` bean = `StackOverflowError`

**am6 是本章最值得記住的診斷案例：啟動完全正常，第一次登入才炸，而且炸得看不懂。**

**成因在 `AuthenticationConfiguration` 的這十七行**：

```java
// org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration（6.2.4）
public AuthenticationManager getAuthenticationManager() throws Exception {
    if (this.authenticationManagerInitialized) {
        return this.authenticationManager;
    }
    AuthenticationManagerBuilder authBuilder = this.applicationContext.getBean(AuthenticationManagerBuilder.class);
    if (this.buildingAuthenticationManager.getAndSet(true)) {
        return new AuthenticationManagerDelegator(authBuilder);
    }
    for (GlobalAuthenticationConfigurerAdapter config : this.globalAuthConfigurers) {
        authBuilder.apply(config);
    }
    this.authenticationManager = authBuilder.build();
    if (this.authenticationManager == null) {
        this.authenticationManager = getAuthenticationManagerBean();     // ★ 這一行
    }
    this.authenticationManagerInitialized = true;
    return this.authenticationManager;
}
```

**而 `authBuilder.build()` 會不會回傳 `null`，取決於這一段**：

```java
// org.springframework.security.config.annotation.authentication.configuration
//   .InitializeUserDetailsBeanManagerConfigurer$InitializeUserDetailsManagerConfigurer（6.2.4）
@Override
public void configure(AuthenticationManagerBuilder auth) throws Exception {
    if (auth.isConfigured()) {
        return;
    }
    UserDetailsService userDetailsService = getBeanOrNull(UserDetailsService.class);
    if (userDetailsService == null) {
        return;                                            // ★ 什麼都不做，也【不報錯】
    }
    PasswordEncoder passwordEncoder = getBeanOrNull(PasswordEncoder.class);
    UserDetailsPasswordService passwordManager = getBeanOrNull(UserDetailsPasswordService.class);
    DaoAuthenticationProvider provider = new DaoAuthenticationProvider();
    provider.setUserDetailsService(userDetailsService);
    if (passwordEncoder != null) { provider.setPasswordEncoder(passwordEncoder); }
    if (passwordManager != null) { provider.setUserDetailsPasswordService(passwordManager); }
    provider.afterPropertiesSet();
    auth.authenticationProvider(provider);
}

/** @return a bean of the requested class if there's just a single registered component, null otherwise. */
private <T> T getBeanOrNull(Class<T> type) {
    String[] beanNames = InitializeUserDetailsBeanManagerConfigurer.this.context.getBeanNamesForType(type);
    if (beanNames.length != 1) {                           // ★★ 不是【剛好一個】就回 null
        return null;
    }
    return InitializeUserDetailsBeanManagerConfigurer.this.context.getBean(beanNames[0], type);
}
```

**把整條因果鏈串起來**：

```
容器裡有【兩個】UserDetailsService bean
      │
      ▼ getBeanOrNull(UserDetailsService.class) → beanNames.length == 2 → 回 null
      │
      ▼ configure() 直接 return，【一個 provider 都沒加】、【也沒有任何警告】
      │
      ▼ authBuilder.build() 發現沒有 provider 也沒有 parent → 回傳 null
      │
      ▼ getAuthenticationManagerBean() → 回傳一個「型別是 AuthenticationManager 的 bean」的延遲代理
      │
      ▼ 而那個 bean 就是【你自己寫的 @Bean am(AuthenticationConfiguration cfg)】
      │
      ▼ 於是：am 這個 bean = 一個指向 am 自己的代理
      │
      ▼ 第一次呼叫 authenticate() → 無窮遞迴 → StackOverflowError（深度 1024）
```

⚠️ **這個 bug 的三個特徵，讓它特別難查**：

```
① 啟動完全正常，沒有任何警告 —— 錯誤在【第一次登入】才發生
② 例外是 StackOverflowError（Error，不是 Exception）
   → 你的 catch (AuthenticationException e) 抓不到
   → 你的 @ExceptionHandler 抓不到
   → 使用者看到一個空白的 500
③ 堆疊裡只有 $ProxyNNN.authenticate 重複一千次，【看不到任何你自己的類別】
```

**堆疊實際長這樣**：

```
java.lang.StackOverflowError
  org.springframework.aop.target.LazyInitTargetSource.getTarget(LazyInitTargetSource.java:69)
  org.springframework.aop.framework.JdkDynamicAopProxy.invoke(JdkDynamicAopProxy.java:203)
  jdk.proxy2/jdk.proxy2.$Proxy140.authenticate(Unknown Source)
  java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(…)
  org.springframework.aop.support.AopUtils.invokeJoinpointUsingReflection(AopUtils.java:354)
  org.springframework.aop.framework.JdkDynamicAopProxy.invoke(JdkDynamicAopProxy.java:216)
  jdk.proxy2/jdk.proxy2.$Proxy140.authenticate(Unknown Source)
  …（重複到 1024 層）
```

📌 **看到「`$ProxyNNN.authenticate` 自己呼叫自己」，就直接去數 `UserDetailsService` 有幾個。**

**這種事比想像中容易發生**：

```
① 你自己寫了一個 @Service class DbUserDetailsService implements UserDetailsService
② 同事在另一個 @Configuration 裡留了一個 InMemoryUserDetailsManager 給測試用
③ 或者：某個 starter（例如 spring-boot-starter-oauth2-client 的某些設定）帶進來一個
④ 或者：你為了「兩套帳號系統」刻意宣告了兩個 —— 這就是 am6/am7 的情境
```

**三個修法**：

```java
// 修法一：只留一個 UserDetailsService bean，另一個降級成普通類別
//         （最單純，八成的情況用這個）

// 修法二：標 @Primary —— ⚠️ 沒有用！
//         getBeanOrNull 是數 getBeanNamesForType 的長度，@Primary 不影響它

// 修法三：✅ 自己把 ProviderManager 組出來（am7），不要依賴自動設定
@Bean
AuthenticationManager am(UserDetailsService primary, UserDetailsService legacy, PasswordEncoder enc) {
    return new ProviderManager(daoOf(primary, enc), daoOf(legacy, enc));
}
```

⚠️ **修法二特別要記住：`@Primary` 在這裡【沒有效果】。**
`getBeanOrNull` 檢查的是 `getBeanNamesForType(type).length != 1`，
它在拿到名稱陣列的當下就放棄了，**根本沒有走到「解析 primary」那一步**。
這是很多人第一個嘗試、然後困惑半小時的修法。

**上面 `AuthManagerScenarios` 裡的 `Am8Primary` 就是「am6 加上 `@Primary`」，跑一次看看**：

```
── am8：兩個 UserDetailsService，其中一個標 @Primary
════════ 認證接線檢查 ════════
  UserDetailsService bean: [uds, primaryUds, secondUds]
  PasswordEncoder    bean: [enc]
  🔴 UserDetailsService 不是【剛好一個】—— 自動設定會安靜地放棄，第一次登入可能 StackOverflowError（02 章 2.6.3）
══════════════════════════════
  ✅ 啟動成功
  容器裡的 AuthenticationManager: $Proxy140
  POST /am/login → 200 {"throwable":"java.lang.StackOverflowError: null","depth":1024,"ok":false}
```

📌 **`@Primary` 解決的是「注入時該選哪一個」，
而這裡的問題是「有幾個」——兩個完全不同的問題。**

📌 **一個可以加進 00 章 0.8.4 那個 `SecurityChainReporter` 的啟動檢查**——
**它是上面那份輸出裡「認證接線檢查」那一段的來源**：

```java
package com.example.lab09.ch02;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.*;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.password.PasswordEncoder;

@Configuration
@Profile("!prod")
public class AuthWiringReporter {

    @Bean
    ApplicationListener<ApplicationReadyEvent> reportAuthWiring() {
        return event -> {
            var ctx = event.getApplicationContext();
            String[] uds = ctx.getBeanNamesForType(UserDetailsService.class);
            String[] enc = ctx.getBeanNamesForType(PasswordEncoder.class);

            System.out.println("\n════════ 認證接線檢查 ════════");
            System.out.println("  UserDetailsService bean: " + java.util.Arrays.toString(uds));
            System.out.println("  PasswordEncoder    bean: " + java.util.Arrays.toString(enc));

            if (uds.length != 1)
                System.out.println("  🔴 UserDetailsService 不是【剛好一個】—— "
                        + "自動設定會安靜地放棄，第一次登入可能 StackOverflowError（02 章 2.6.3）");
            if (enc.length != 1)
                System.out.println("  🔴 PasswordEncoder 不是【剛好一個】—— "
                        + "DaoAuthenticationProvider 會退回預設的 DelegatingPasswordEncoder");
            System.out.println("══════════════════════════════");
        };
    }
}
```

### 2.6.4 決策表，與一個會讓你困惑的副作用

| 你的情況 | 用哪一種 | 為什麼 |
|---|---|---|
| 只有一組帳號、不需要自己呼叫認證 | **什麼都不寫** | 自動設定會替你組好，`AuthenticationManager` 你根本用不到 |
| 需要自訂登入端點（JWT / JSON） | **am2**：`AuthenticationConfiguration` | 官方寫法，會沿用所有自動設定 |
| 要精確控制 provider 清單與順序 | **am3 / am7**：自己 `new ProviderManager` | 讀程式碼就知道有哪些 provider、什麼順序 |
| 有兩套以上的帳號來源 | **am7**：自己列出兩個 provider | 自動設定會放棄（2.6.3） |
| 要在測試裡直接呼叫認證 | **am3**：自己組一個 | 測試不該依賴自動設定的細節 |

⚠️ **最後補一個 am5 那一列的副作用**——**它會讓錯誤訊息從中文變成英文**：

```
am2 / am3 / am7 的密碼錯誤: BadCredentialsException: 憑證錯誤
am5 的密碼錯誤            : BadCredentialsException: Bad credentials
```

**原因**：`AbstractUserDetailsAuthenticationProvider implements MessageSourceAware`。

```
它自己的預設是 SpringSecurityMessageSource（內建 messages_zh_TW.properties）

但你一旦把它宣告成【Spring bean】，
Spring 容器會在初始化時呼叫 setMessageSource(applicationContext 的 MessageSource)，
而預設的 DelegatingMessageSource 裡【沒有 Spring Security 的訊息】
→ 於是回退到程式碼裡寫死的英文預設值 "Bad credentials"
```

**這不影響安全性**（三種失敗還是同一句話），但它會讓你在比對兩份日誌時懷疑人生。

**要拿回中文，兩個做法**：

```java
// 做法一：不要把 provider 宣告成 bean（am3 的寫法）
@Bean AuthenticationManager am(UserDetailsService uds, PasswordEncoder enc) {
    DaoAuthenticationProvider p = new DaoAuthenticationProvider();     // ← 它不是 bean
    p.setUserDetailsService(uds);
    p.setPasswordEncoder(enc);
    return new ProviderManager(p);
}

// 做法二：把 Spring Security 的訊息檔掛進你的 MessageSource
@Bean
MessageSource messageSource() {
    ReloadableResourceBundleMessageSource ms = new ReloadableResourceBundleMessageSource();
    ms.setBasenames("classpath:org/springframework/security/messages", "classpath:messages");
    ms.setDefaultEncoding("UTF-8");
    return ms;
}
```

📌 **做法二順便解決另一件事**：你可以**覆寫**那些訊息成自己的文案。
把 `AbstractUserDetailsAuthenticationProvider.badCredentials=帳號或密碼錯誤`
寫進你自己的 `messages.properties` 就好——
**比在 `failureHandler` 裡硬寫字串乾淨，而且不會漏掉任何一條路徑。**

---

## 2.7 `UserDetailsService`：把帳號搬到 MySQL

### 2.7.1 `UserDetails` 這個介面

**它只有七個方法，其中五個是布林值**：

```java
public interface UserDetails extends Serializable {
    Collection<? extends GrantedAuthority> getAuthorities();
    String  getPassword();               // ★ 是【雜湊】，不是明碼
    String  getUsername();
    boolean isAccountNonExpired();       // ┐
    boolean isAccountNonLocked();        // │ 這四個決定「這個帳號現在可不可以用」
    boolean isCredentialsNonExpired();   // │
    boolean isEnabled();                 // ┘
}
```

⚠️ **四個布林值都是「正面命名」**（`NonExpired`、`NonLocked`），
意思是**「回 `true` 才是正常」**。這個命名讓「忘了實作」變成安全的方向嗎？**不是**——

```java
// 🔴 用 Lombok 的 @Data 或 IDE 自動產生，忘了給預設值
private boolean enabled;                 // 預設 false → 所有帳號都登不進去（好，會被發現）
private boolean accountNonLocked;        // 預設 false → 所有帳號都被鎖（好，會被發現）
```

**這一組「忘了設」的方向是安全的**（全部登不進去，測試馬上紅）。
**但反過來就危險了**：

```java
// 🔴 為了「先讓它跑起來」全部回 true —— 然後永遠沒有改回去
@Override public boolean isEnabled() { return true; }            // 停用功能失效
@Override public boolean isAccountNonLocked() { return true; }   // 07 章的鎖定機制失效
```

📌 **判準：這四個方法只要有一個是寫死的 `true`，就在 code review 裡問一句
「那停用 / 鎖定功能是靠什麼實作的？」**——
很多系統的「停用帳號」按鈕按下去什麼事都沒發生，就是這樣來的。

**`GrantedAuthority` 更簡單，只有一個方法**：

```java
public interface GrantedAuthority extends Serializable {
    String getAuthority();
}
```

```java
new SimpleGrantedAuthority("ROLE_ADMIN")     // 角色：習慣加 ROLE_ 前綴
new SimpleGrantedAuthority("order:refund")   // 權限：不加前綴
```

**`ROLE_` 前綴是一個約定，不是規則**——03 章 3.3 會講 `hasRole` 與 `hasAuthority` 的差別
（劇透：`hasRole("ADMIN")` 會自己補上 `ROLE_`，`hasAuthority("ADMIN")` 不會）。

### 2.7.2 Schema 與實作

**先建表**（2.1.1 已經建過，這裡逐欄說明為什麼這樣設計）。這是本站接下來會一直用的兩張表：

```sql
CREATE TABLE app_user (
  id                    BIGINT       NOT NULL AUTO_INCREMENT,
  username              VARCHAR(64)  NOT NULL,
  password_hash         VARCHAR(100) NOT NULL COMMENT '含 {演算法} 前綴（00 章 0.7.5）',
  display_name          VARCHAR(64)  NOT NULL,
  enabled               BOOLEAN      NOT NULL DEFAULT TRUE,
  account_non_expired   BOOLEAN      NOT NULL DEFAULT TRUE,
  account_non_locked    BOOLEAN      NOT NULL DEFAULT TRUE,
  credentials_expire_at DATETIME     NULL COMMENT 'NULL = 永不過期',
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_app_user_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE authority (
  id        BIGINT      NOT NULL AUTO_INCREMENT,
  user_id   BIGINT      NOT NULL,
  authority VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_authority (user_id, authority),
  CONSTRAINT fk_authority_user FOREIGN KEY (user_id) REFERENCES app_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**五個設計決定，每一個都有理由**：

| 決定 | 理由 |
|---|---|
| `password_hash VARCHAR(100)` | `{argon2}` 的雜湊約 96 字元（00 章 0.7.5）。**不要用 60**，那只夠 BCrypt |
| `UNIQUE KEY uk_app_user_username` | 沒有它，兩筆同名帳號會讓 `loadUserByUsername` **隨機**回一筆 |
| `credentials_expire_at DATETIME` 而不是 `credentials_non_expired BOOLEAN` | 布林值需要排程去翻；**存時間點就不用** |
| 權限**另開一張表** | 用逗號分隔字串存在同一欄，會讓「查誰有 ADMIN」變成全表掃描 |
| `uk_authority (user_id, authority)` | 沒有它，重複授權會讓 `getAuthorities()` 回傳重複項 |

⚠️ **`enabled` 這類欄位用 `BOOLEAN`（MySQL 實際是 `TINYINT(1)`）沒問題，
但不要用 `CHAR(1)` 存 `'Y'/'N'`**——JPA 映射會需要 converter，而**忘了寫 converter 的後果
是「所有值都被當成 true」**（非空字串在某些映射下會被當真）。

**Entity**：

```java
package com.example.lab09.ch02;

import jakarta.persistence.*;
import java.time.LocalDateTime;
import java.util.*;

@Entity
@Table(name = "app_user")
public class AppUser {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 64)
    private String username;

    /** 含 {演算法} 前綴的雜湊，例如 {bcrypt}$2a$10$... */
    @Column(name = "password_hash", nullable = false, length = 100)
    private String passwordHash;

    @Column(name = "display_name", nullable = false, length = 64)
    private String displayName;

    @Column(nullable = false)                 private boolean enabled = true;
    @Column(name = "account_non_expired")     private boolean accountNonExpired = true;
    @Column(name = "account_non_locked")      private boolean accountNonLocked = true;
    @Column(name = "credentials_expire_at")   private LocalDateTime credentialsExpireAt;
    @Column(name = "created_at", insertable = false, updatable = false)
    private LocalDateTime createdAt;

    @OneToMany(mappedBy = "user", fetch = FetchType.LAZY, cascade = CascadeType.ALL, orphanRemoval = true)
    private List<AuthorityRow> authorities = new ArrayList<>();

    protected AppUser() {}

    public AppUser(String username, String passwordHash, String displayName) {
        this.username = username; this.passwordHash = passwordHash; this.displayName = displayName;
    }

    public void grant(String authority) { authorities.add(new AuthorityRow(this, authority)); }

    public Long getId() { return id; }
    public String getUsername() { return username; }
    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String h) { this.passwordHash = h; }
    public String getDisplayName() { return displayName; }
    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean e) { this.enabled = e; }
    public boolean isAccountNonExpired() { return accountNonExpired; }
    public void setAccountNonExpired(boolean b) { this.accountNonExpired = b; }
    public boolean isAccountNonLocked() { return accountNonLocked; }
    public void setAccountNonLocked(boolean b) { this.accountNonLocked = b; }
    public LocalDateTime getCredentialsExpireAt() { return credentialsExpireAt; }
    public void setCredentialsExpireAt(LocalDateTime t) { this.credentialsExpireAt = t; }
    public List<AuthorityRow> getAuthorities() { return authorities; }
}
```

```java
package com.example.lab09.ch02;

import jakarta.persistence.*;

@Entity
@Table(name = "authority")
public class AuthorityRow {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id")
    private AppUser user;

    @Column(nullable = false, length = 64)
    private String authority;

    protected AuthorityRow() {}
    public AuthorityRow(AppUser user, String authority) { this.user = user; this.authority = authority; }

    public Long getId() { return id; }
    public AppUser getUser() { return user; }
    public String getAuthority() { return authority; }
}
```

```java
package com.example.lab09.ch02;

import org.springframework.data.jpa.repository.*;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

public interface AppUserRepo extends JpaRepository<AppUser, Long> {

    /** 最單純的查法：只查 app_user 一張表，authorities 是 LAZY */
    Optional<AppUser> findByUsername(String username);

    /** 一句 SQL 把權限一起帶回來 —— 2.7.5 會用實測解釋為什麼要有這一個 */
    @Query("select u from AppUser u left join fetch u.authorities where u.username = :name")
    Optional<AppUser> findByUsernameWithAuthorities(@Param("name") String name);
}
```

**最後是主角**：

```java
package com.example.lab09.ch02;

import org.springframework.context.annotation.Profile;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

@Service
public class DbUserDetailsService implements UserDetailsService {

    /** 只是為了 2.7.4 數呼叫次數；正式程式碼不需要 */
    public static final AtomicInteger CALLS = new AtomicInteger();

    private final AppUserRepo repo;
    public DbUserDetailsService(AppUserRepo repo) { this.repo = repo; }

    @Override
    @Transactional(readOnly = true)
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        CALLS.incrementAndGet();
        AppUser u = repo.findByUsernameWithAuthorities(username)
                .orElseThrow(() -> new UsernameNotFoundException(username));   // ★ 2.5.5 規則一
        return new AppUserDetails(u);                                          // ★ 回 DTO，不是 Entity
    }

    /** 不可變的快照：載入的當下就把要用的東西全部抄下來 */
    public static final class AppUserDetails implements UserDetails {
        private final String username;
        private final String password;
        private final String displayName;
        private final boolean enabled, accountNonExpired, accountNonLocked, credentialsNonExpired;
        private final List<GrantedAuthority> authorities;

        public AppUserDetails(AppUser u) {
            this.username = u.getUsername();
            this.password = u.getPasswordHash();
            this.displayName = u.getDisplayName();
            this.enabled = u.isEnabled();
            this.accountNonExpired = u.isAccountNonExpired();
            this.accountNonLocked = u.isAccountNonLocked();
            this.credentialsNonExpired = u.getCredentialsExpireAt() == null
                    || u.getCredentialsExpireAt().isAfter(LocalDateTime.now());
            this.authorities = u.getAuthorities().stream()
                    .map(a -> (GrantedAuthority) new SimpleGrantedAuthority(a.getAuthority()))
                    .toList();
        }

        public String getDisplayName() { return displayName; }
        @Override public Collection<? extends GrantedAuthority> getAuthorities() { return authorities; }
        @Override public String getPassword() { return password; }
        @Override public String getUsername() { return username; }
        @Override public boolean isAccountNonExpired() { return accountNonExpired; }
        @Override public boolean isAccountNonLocked() { return accountNonLocked; }
        @Override public boolean isCredentialsNonExpired() { return credentialsNonExpired; }
        @Override public boolean isEnabled() { return enabled; }
        @Override public String toString() { return "AppUserDetails(" + username + ")"; }
    }
}
```

**四個設計決定**：

```
① 回傳【自己的 DTO】AppUserDetails，不是 Entity —— 理由在 2.7.3
② 標 @Transactional(readOnly = true) —— join fetch 需要一個交易邊界
③ credentialsNonExpired 由 credentials_expire_at 【算】出來，不是存布林值
④ 多帶一個 displayName —— 這是自訂 UserDetails 最常見的動機（Controller 要顯示名字）
```

**在 Controller 裡拿到它**（和 2.1.1 那支 `/whoami` 相同，原樣搬來）：

```java
package com.example.lab09.ch02;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.*;

@RestController
@RequestMapping("/whoami")
public class WhoAmIController {

    @GetMapping
    public Map<String, Object> me(Authentication auth,
                                  @AuthenticationPrincipal DbUserDetailsService.AppUserDetails me) {
        return new LinkedHashMap<>(Map.of(
                "name", auth.getName(),
                "principalType", auth.getPrincipal().getClass().getSimpleName(),
                "displayName", me == null ? "-" : me.getDisplayName(),   // ★ 直接拿到自訂欄位
                "authorities", auth.getAuthorities().toString()));
    }
}
```

**實測**（`db1` profile：Basic + `STATELESS`，帳號來自 MySQL）：

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db1"})
class PrincipalShapeTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }     // 2.1.1 的七個帳號

    @Test
    void responseShape() {
        System.out.println("\n═══ 2.7.2 回應裡的 principal 是什麼型別 ═══");
        HttpResponse<String> r = new Http(port).get("/whoami", "Authorization", Http.basic("admin", "pw"));
        System.out.println("  HTTP " + r.statusCode());
        System.out.println("  " + r.body());
    }
}
```

```
═══ 2.7.2 回應裡的 principal 是什麼型別 ═══
  HTTP 200
  {"name":"admin","principalType":"AppUserDetails","displayName":"管理員","authorities":"[order:refund, ROLE_ADMIN, ROLE_USER]"}
```

📌 **`@AuthenticationPrincipal` 直接把 `principal` 轉型注入**——
這是 Controller 拿使用者資訊最乾淨的方式，**比 `SecurityContextHolder.getContext()` 好**：

```java
// 🔴 能動，但難測（要在測試裡手動塞 SecurityContext）
var me = (AppUserDetails) SecurityContextHolder.getContext().getAuthentication().getPrincipal();

// ✅ 是一個方法參數，測試直接傳一個進去就好
public Map<String, Object> me(@AuthenticationPrincipal AppUserDetails me) { … }
```

⚠️ **`@AuthenticationPrincipal` 在「未登入」時會注入 `null`，不會拋例外。**
所以 `permitAll()` 的端點一定要判 `null`——**這是 IDOR 的一個常見入口**
（00 章 0.3.1：`me == null` 時你的程式碼往下走了什麼路徑？）。

**本章的固定裝置**（和 2.1.1 相同，原樣搬來——七個帳號蓋掉五個布林值的每一種狀態）：

```java
package com.example.lab09.ch02;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

public class Seed {

    public static final PasswordEncoder ENC = PasswordEncoderFactories.createDelegatingPasswordEncoder();

    public static void reset(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM authority");
        jdbc.update("DELETE FROM app_user");

        add(jdbc, "alice", "pw", "艾莉絲", true, true, true, null, "ROLE_USER");
        add(jdbc, "bob",   "pw", "巴布",   true, true, true, null, "ROLE_USER");
        add(jdbc, "admin", "pw", "管理員", true, true, true, null, "ROLE_USER", "ROLE_ADMIN", "order:refund");
        add(jdbc, "carol", "pw", "卡蘿",   false, true, true, null, "ROLE_USER");                 // disabled
        add(jdbc, "dave",  "pw", "戴夫",   true, true, false, null, "ROLE_USER");                 // locked
        add(jdbc, "erin",  "pw", "艾琳",   true, false, true, null, "ROLE_USER");                 // 帳號過期
        add(jdbc, "frank", "pw", "法蘭克", true, true, true, "2020-01-01 00:00:00", "ROLE_USER"); // 密碼過期
    }

    public static void add(JdbcTemplate jdbc, String username, String rawPw, String display,
                           boolean enabled, boolean nonExpired, boolean nonLocked,
                           String credExpireAt, String... authorities) {
        jdbc.update("""
                INSERT INTO app_user
                  (username, password_hash, display_name, enabled,
                   account_non_expired, account_non_locked, credentials_expire_at)
                VALUES (?,?,?,?,?,?,?)""",
                username, ENC.encode(rawPw), display, enabled, nonExpired, nonLocked, credExpireAt);
        Long id = jdbc.queryForObject("SELECT id FROM app_user WHERE username=?", Long.class, username);
        for (String a : authorities)
            jdbc.update("INSERT INTO authority (user_id, authority) VALUES (?,?)", id, a);
    }
}
```

⚠️ **它沿用了 00 章 0.8.2 的原則：`alice` 與 `bob` 是【同角色的兩個帳號】。**
只有這樣，03 章才測得出「資源層授權」有沒有做。

### 2.7.3 🔴 不要讓 Entity 直接 `implements UserDetails`

**這是網路上最常見的寫法，也是最容易出事的寫法**：

```java
package com.example.lab09.ch02;

import jakarta.persistence.*;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import java.util.*;

/** 🔴 反例：Entity 同時扮演「資料庫映射」與「安全身分」 */
@Entity
@Table(name = "app_user")
public class EntityAsUserDetails implements UserDetails {

    @Id private Long id;
    @Column(unique = true) private String username;
    @Column(name = "password_hash") private String passwordHash;
    @Column(name = "display_name")  private String displayName;
    private boolean enabled;
    @Column(name = "account_non_expired") private boolean accountNonExpired;
    @Column(name = "account_non_locked")  private boolean accountNonLocked;

    @OneToMany(fetch = FetchType.LAZY)          // ★ @OneToMany 預設就是 LAZY
    @JoinColumn(name = "user_id")
    private List<AuthorityRow> rows = new ArrayList<>();

    @Override public Collection<? extends GrantedAuthority> getAuthorities() {
        return rows.stream().map(r -> (GrantedAuthority) new SimpleGrantedAuthority(r.getAuthority())).toList();
    }
    @Override public String getPassword() { return passwordHash; }
    @Override public String getUsername() { return username; }
    @Override public boolean isAccountNonExpired() { return accountNonExpired; }
    @Override public boolean isAccountNonLocked() { return accountNonLocked; }
    @Override public boolean isCredentialsNonExpired() { return true; }
    @Override public boolean isEnabled() { return enabled; }
    public String getDisplayName() { return displayName; }
}
```

```java
@Bean
UserDetailsService uds(EntityUserRepo repo) {
    return username -> repo.findByUsername(username)
            .orElseThrow(() -> new UsernameNotFoundException(username));    // 直接回 Entity
}
```

**看起來省了一個類別。用 `alice / pw`（正確帳密）打一次**：

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db3"})            // db3：UserDetailsService 直接回傳 Entity（2.1.1）
class EntityAsPrincipalTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }

    @Test
    void lazyBlowsUp() {
        System.out.println("\n═══ 2.7.3 讓 Entity 直接 implements UserDetails ═══");
        HttpResponse<String> r = new Http(port).get("/whoami", "Authorization", Http.basic("alice", "pw"));
        System.out.println("  HTTP " + r.statusCode());
        String b = r.body();
        System.out.println("  body: " + (b.length() > 300 ? b.substring(0, 300) + "…" : b));
    }
}
```

```
═══ 2.7.3 讓 Entity 直接 implements UserDetails ═══
  HTTP 401
  body: 
```

**401，帳密是對的。** 日誌裡才看得到真相：

```
ERROR o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() … threw exception

org.hibernate.LazyInitializationException: failed to lazily initialize a collection of role:
    com.example.lab09.ch02.EntityAsUserDetails.rows: could not initialize proxy - no Session
  at org.hibernate.collection.spi.AbstractPersistentCollection.throwLazyInitializationException(…)
  …
  at com.example.lab09.ch02.EntityAsUserDetails.getAuthorities(EntityAsUserDetails.java:28)
  at …AbstractUserDetailsAuthenticationProvider.createSuccessAuthentication(…:197)
  at …DaoAuthenticationProvider.createSuccessAuthentication(DaoAuthenticationProvider.java:132)
  at …AbstractUserDetailsAuthenticationProvider.authenticate(…:168)
  at …ProviderManager.authenticate(ProviderManager.java:182)
  at …BasicAuthenticationFilter.doFilterInternal(BasicAuthenticationFilter.java:187)
```

**堆疊講得很清楚**：

```
① loadUserByUsername 回傳 Entity，交易在 return 的那一刻就結束了（Hibernate Session 關閉）
② 密碼比對通過
③ createSuccessAuthentication 要組結果 → 呼叫 getAuthorities()
④ 這時才第一次碰 LAZY 的 rows → 沒有 Session → LazyInitializationException
```

⚠️ **而且它包成了 `InternalAuthenticationServiceException`**（2.5.2 的第四個 catch），
所以：

```
① 對外是 401 —— 跟「密碼打錯」看起來一模一樣
② 錯誤日誌是 ERROR 等級（AbstractAuthenticationProcessingFilter 的 logger.error）
③ 2.4.3 案例 C：它會【立刻中止 provider 迴圈】
```

**「帳密明明是對的，卻一直 401」——這是最常見的症狀。**

**除了這個之外，Entity 當 `UserDetails` 還有四個問題**：

| # | 問題 | 後果 |
|---|---|---|
| 1 | `LazyInitializationException` | 上面那個。改成 `EAGER` 可以避開，但**每次查使用者都會 join** |
| 2 | **整個 Entity 會被塞進 HTTP session** | 有狀態 API 下，session 裡躺著一個 detached 的 JPA Entity（含 `passwordHash`） |
| 3 | **資料會過期** | session 裡那份是登入當下的快照，DB 改了它不知道（2.7.7） |
| 4 | `equals` / `hashCode` | Entity 通常用 `id` 比對；Spring Security 某些地方（`SessionRegistry`）會拿 principal 當 Map 的 key |
| 5 | **序列化** | Entity 帶著 Hibernate 的 proxy 欄位，換 Redis 存 session 時會爆 |

📌 **這五個問題有一個共同的根**：

> **`UserDetails` 是一個「認證結果的快照」，
> Entity 是一個「有生命週期、綁在交易上的可變物件」。**
> **它們的生命週期完全不同，硬綁在一起就會在生命週期的交界處出事。**

**正確做法就是 2.7.2 那個 `AppUserDetails`：在交易裡把要用的欄位抄成一個不可變物件。**

⚠️ **如果你堅持要用 Entity，最低限度要做兩件事**：

```java
// ① 用 join fetch 把 LAZY 的關聯先抓進來
@Query("select u from AppUser u left join fetch u.authorities where u.username = :name")

// ② 用 @Transactional 包住 loadUserByUsername，並且【在交易裡】先碰一次集合
@Transactional(readOnly = true)
public UserDetails loadUserByUsername(String u) {
    AppUser user = repo.findByUsername(u).orElseThrow(() -> new UsernameNotFoundException(u));
    user.getAuthorities().size();       // 🔴 這種「碰一下讓它載入」的程式碼是一個訊號：
    return user;                        //     你正在對抗這個設計，而不是使用它
}
```

### 2.7.4 實測：一個請求查幾次資料庫

**這是「無狀態」與「有狀態」最實際的差別。**

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

class DbQueryCountTest {

    /** Hibernate 的統計功能：spring.jpa.properties.hibernate.generate_statistics=true */
    static Statistics stats(EntityManagerFactory emf) {
        Statistics s = emf.unwrap(SessionFactory.class).getStatistics();
        s.clear();
        return s;
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    @ActiveProfiles({"db", "db1"})           // db1：Basic + STATELESS
    class Stateless {
        @LocalServerPort int port;
        @Autowired JdbcTemplate jdbc;
        @Autowired EntityManagerFactory emf;
        @BeforeEach void seed() { Seed.reset(jdbc); }

        @Test
        void queriesPerRequest() {
            Http http = new Http(port);
            String auth = Http.basic("alice", "pw");
            http.get("/whoami", "Authorization", auth);            // 暖機

            System.out.println("\n═══ 2.7.4 無狀態（STATELESS）：一個請求查幾次 DB ═══");
            Statistics st = stats(emf);
            DbUserDetailsService.CALLS.set(0);
            for (int i = 0; i < 5; i++) http.get("/whoami", "Authorization", auth);

            System.out.println("  打了 5 個請求");
            System.out.println("  loadUserByUsername 被呼叫: " + DbUserDetailsService.CALLS.get() + " 次");
            System.out.println("  Hibernate prepared statement: " + st.getPrepareStatementCount() + " 句");
        }
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    @ActiveProfiles({"db", "db2"})           // db2：Basic + 明確把結果存進 session
    class WithSession {
        @LocalServerPort int port;
        @Autowired JdbcTemplate jdbc;
        @Autowired EntityManagerFactory emf;
        @BeforeEach void seed() { Seed.reset(jdbc); }

        @Test
        void queriesPerRequest() {
            Http http = new Http(port);
            HttpResponse<String> first = http.get("/whoami", "Authorization", Http.basic("alice", "pw"));
            String cookie = first.headers().firstValue("set-cookie").orElseThrow().split(";")[0];

            System.out.println("\n═══ 2.7.4 有 session：一個請求查幾次 DB ═══");
            System.out.println("  第一個請求（帶 Basic）拿到: " + cookie);

            Statistics st = stats(emf);
            DbUserDetailsService.CALLS.set(0);
            for (int i = 0; i < 5; i++) http.get("/whoami", "Cookie", cookie);

            System.out.println("  接下來 5 個請求【只帶 cookie】");
            System.out.println("  loadUserByUsername 被呼叫: " + DbUserDetailsService.CALLS.get() + " 次");
            System.out.println("  Hibernate prepared statement: " + st.getPrepareStatementCount() + " 句");

            HttpResponse<String> r = http.get("/whoami", "Cookie", cookie);
            System.out.println("  身分還在嗎: HTTP " + r.statusCode() + "  " + r.body());
        }
    }
}
```

```
═══ 2.7.4 無狀態（STATELESS）：一個請求查幾次 DB ═══
  打了 5 個請求
  loadUserByUsername 被呼叫: 5 次
  Hibernate prepared statement: 5 句

═══ 2.7.4 有 session：一個請求查幾次 DB ═══
  第一個請求（帶 Basic）拿到: JSESSIONID=D3830CA997DA4350D45A59D31CBD3D2C
  接下來 5 個請求【只帶 cookie】
  loadUserByUsername 被呼叫: 0 次
  Hibernate prepared statement: 0 句
  身分還在嗎: HTTP 200  {"name":"alice","authorities":"[ROLE_USER]","principalType":"AppUserDetails","displayName":"艾莉絲"}
```

**5 次 vs 0 次。**

⚠️ **配合 2.3.5 的數字，一個無狀態 + Basic 的服務，每一個請求的固定成本是**：

```
1 句 SQL（約 1 ms）  +  1 次 BCrypt（約 68 ms）  =  ★ 69 ms，而且【與你的商業邏輯無關】
```

📌 **這一節也順便回答了 2.3.4 那個「Basic 為什麼沒發 cookie」**：

```java
// org.springframework.security.web.authentication.www.BasicAuthenticationFilter（6.2.4）
private SecurityContextRepository securityContextRepository = new RequestAttributeSecurityContextRepository();
```

**Spring Security 6 的 `BasicAuthenticationFilter` 預設用
`RequestAttributeSecurityContextRepository`——認證結果只活在【這一個請求】裡，不進 session。**

**要它進 session，得自己指定**：

```java
http.httpBasic(h -> h.securityContextRepository(new HttpSessionSecurityContextRepository()));
```

⚠️ **這是 5.x → 6.x 的行為改變。** 5.x 的 Basic 會建立 session；
6.x 不會。**升級後「登入一次之後都不用再帶標頭」的行為會消失**，
而你的整合測試如果都帶著標頭，就測不出來。

### 2.7.5 實測：權限怎麼載入

**`findByUsername`（LAZY）與 `findByUsernameWithAuthorities`（join fetch）差幾句 SQL？**

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

class AuthorityLoadingTest {

    static void measure(String label, Http http, EntityManagerFactory emf, String user) {
        Statistics st = emf.unwrap(SessionFactory.class).getStatistics();
        st.clear();
        http.get("/whoami", "Authorization", Http.basic(user, "pw"));
        System.out.printf("  %-34s %s → %d 句 SQL%n", label, user, st.getPrepareStatementCount());
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    @ActiveProfiles({"db", "db1"})     // db1：DbUserDetailsService（join fetch）
    class JoinFetch {
        @LocalServerPort int port;
        @Autowired JdbcTemplate jdbc;
        @Autowired EntityManagerFactory emf;
        @BeforeEach void seed() { Seed.reset(jdbc); }

        @Test void t() {
            Http http = new Http(port);
            http.get("/whoami", "Authorization", Http.basic("alice", "pw"));   // 暖機
            System.out.println("\n═══ 2.7.5 權限怎麼載入：一次登入打幾句 SQL ═══");
            measure("join fetch（一句抓完）", http, emf, "alice");
            measure("join fetch（三個權限）", http, emf, "admin");
        }
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    @ActiveProfiles({"db", "db5"})     // db5：findByUsername（LAZY），在交易裡才碰 authorities
    class Lazy {
        @LocalServerPort int port;
        @Autowired JdbcTemplate jdbc;
        @Autowired EntityManagerFactory emf;
        @BeforeEach void seed() { Seed.reset(jdbc); }

        @Test void t() {
            Http http = new Http(port);
            http.get("/whoami", "Authorization", Http.basic("alice", "pw"));
            measure("LAZY（用到才查）", http, emf, "alice");
            measure("LAZY（三個權限）", http, emf, "admin");
        }
    }
}
```

```
═══ 2.7.5 權限怎麼載入：一次登入打幾句 SQL ═══
  join fetch（一句抓完）                   alice → 1 句 SQL
  join fetch（三個權限）                   admin → 1 句 SQL
  LAZY（用到才查）                         alice → 2 句 SQL
  LAZY（三個權限）                         admin → 2 句 SQL
```

**1 句 vs 2 句。** 差距不大，但有三件事值得說清楚：

```
① 差距【不會】隨權限數量增加 —— admin 有三個權限，還是 2 句
   因為 LAZY 的集合是「一次載入整個集合」，不是「一個權限一句」

② 真正的 N+1 在【列出使用者清單】的時候：
   查 100 個使用者 → join fetch 1 句，LAZY 101 句

③ 在無狀態 API 下，這一句 SQL【每個請求都會跑】（2.7.4）
   一句 1 ms × 每天一千萬個請求 = 你的 DB 多了一千萬次查詢
```

📌 **本站選 join fetch 的真正理由不是效能，是 2.7.3 那個 `LazyInitializationException`**——
**用 join fetch，你就不需要「在交易裡先碰一下集合」那種對抗設計的程式碼。**

⚠️ **join fetch + `@OneToMany` 有一個 06 站 04 章講過的副作用**：
`left join fetch` 會讓 `app_user` 的欄位**依權限數量重複**
（admin 有三個權限 → 三列）。Hibernate 會自己去重成一個物件，
但**如果你同時 join fetch 兩個集合，就會變成笛卡兒積**——那時要改用 `@BatchSize` 或兩次查詢。

### 2.7.6 實測：五個布林值分別長什麼樣

**誰在檢查它們？** 2.5.1 的步驟 ④ 與 ⑥，程式碼在這裡：

```java
// AbstractUserDetailsAuthenticationProvider（6.2.4）
private class DefaultPreAuthenticationChecks implements UserDetailsChecker {
    @Override
    public void check(UserDetails user) {
        if (!user.isAccountNonLocked()) {
            throw new LockedException(… "AbstractUserDetailsAuthenticationProvider.locked",
                                          "User account is locked");
        }
        if (!user.isEnabled()) {
            throw new DisabledException(… "AbstractUserDetailsAuthenticationProvider.disabled",
                                          "User is disabled");
        }
        if (!user.isAccountNonExpired()) {
            throw new AccountExpiredException(… "AbstractUserDetailsAuthenticationProvider.expired",
                                          "User account has expired");
        }
    }
}

private class DefaultPostAuthenticationChecks implements UserDetailsChecker {
    @Override
    public void check(UserDetails user) {
        if (!user.isCredentialsNonExpired()) {
            throw new CredentialsExpiredException(… "AbstractUserDetailsAuthenticationProvider.credentialsExpired",
                                          "User credentials have expired");
        }
    }
}
```

**一張表**：

| 方法 | 例外 | 在密碼比對之前 / 之後 | 語意 |
|---|---|---|---|
| `isAccountNonLocked()` | `LockedException` | **之前** | 暫時性：連續登入失敗、風控 |
| `isEnabled()` | `DisabledException` | **之前** | 管理性：管理員停用、還沒驗證 email |
| `isAccountNonExpired()` | `AccountExpiredException` | **之前** | 帳號本身有效期（約聘、試用） |
| `isCredentialsNonExpired()` | `CredentialsExpiredException` | **之後** | 密碼有效期（90 天強制換） |

**四個例外都是 `AccountStatusException` 的子類**——回想 2.4.3 規則③：
**它們會【立刻中止 provider 迴圈】。**

```
AuthenticationException
 ├─ BadCredentialsException          （一般失敗 → 繼續問下一個 provider）
 ├─ UsernameNotFoundException        （一般失敗，但預設會被換成 BadCredentials）
 ├─ ProviderNotFoundException
 ├─ InternalAuthenticationServiceException  （★ 中止迴圈）
 └─ AccountStatusException           （★ 中止迴圈）
     ├─ LockedException
     ├─ DisabledException
     ├─ AccountExpiredException
     └─ CredentialsExpiredException
```

**用七個帳號各打一次**：

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.List;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db1"})
class AccountStateTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }

    record Case(String user, String pw, String desc) {}

    @Test
    void accountStates() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.7.6 五個布林值：七個帳號各拿到什麼 ═══");
        System.out.printf("  %-8s %-28s %-6s %s%n", "帳號", "狀態", "HTTP", "WWW-Authenticate");
        for (Case c : List.of(
                new Case("alice", "pw",    "正常"),
                new Case("alice", "WRONG", "密碼錯"),
                new Case("carol", "pw",    "enabled=false"),
                new Case("dave",  "pw",    "accountNonLocked=false"),
                new Case("erin",  "pw",    "accountNonExpired=false"),
                new Case("frank", "pw",    "credentials 已過期"),
                new Case("nobody","pw",    "帳號不存在"))) {
            HttpResponse<String> r = http.get("/whoami", "Authorization", Http.basic(c.user(), c.pw()));
            System.out.printf("  %-8s %-28s %-6d %s%n", c.user(), c.desc(), r.statusCode(),
                    r.headers().firstValue("WWW-Authenticate").orElse("(無)"));
        }
    }
}
```

```
═══ 2.7.6 五個布林值：七個帳號各拿到什麼 ═══
  帳號       狀態                           HTTP   WWW-Authenticate
  alice    正常                           200    (無)
  alice    密碼錯                          401    Basic realm="Realm"
  carol    enabled=false                401    Basic realm="Realm"
  dave     accountNonLocked=false       401    Basic realm="Realm"
  erin     accountNonExpired=false      401    Basic realm="Realm"
  frank    credentials 已過期              401    Basic realm="Realm"
  nobody   帳號不存在                        401    Basic realm="Realm"
```

**六種失敗，六個一模一樣的回應。**（HTTP 層面看不出任何差別——這是對的預設。）

📌 **但你自己的日誌看得到**（2.3.6 的 `failureHandler` 輸出）：

```
[failureHandler] 內部原因: BadCredentialsException / 憑證錯誤
[failureHandler] 內部原因: DisabledException / 使用者已被停用
[failureHandler] 內部原因: LockedException / 使用者帳號已被鎖定
```

⚠️ **`credentials 已過期`（frank）值得單獨看一眼**：
它是**唯一一個在密碼比對【之後】才被檢查**的。
這代表 frank 必須輸入**正確的密碼**，才會被判定「密碼過期」——
**這正是 2.5.3 修法 A 想達成的形狀**（把狀態資訊藏在「證明本人」之後）。

**要讓「密碼過期」有意義，你還需要一個出口**：

```java
// 密碼過期的使用者，應該被導去「強制改密碼」頁，而不是單純被擋在門外
http.formLogin(f -> f.failureHandler((req, res, ex) -> {
    if (ex instanceof CredentialsExpiredException) {
        res.sendRedirect("/password/expired");     // ★ 這一步很多系統忘了做
        return;
    }
    res.sendRedirect("/login?error");
}));
```

**沒有這個出口，「密碼 90 天過期」的功能就等於「帳號 90 天後自動報廢」。**

### 2.7.7 實測：登入後把帳號鎖起來，舊 session 還能用嗎

**這是 2.7.4「有 session 就不查 DB」的必然後果，但它值得單獨量一次。**

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "db2"})           // db2：Basic + 存進 session
class StaleSessionTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void seed() { Seed.reset(jdbc); }

    @Test
    void staleAfterLock() {
        Http http = new Http(port);
        String cookie = http.get("/whoami", "Authorization", Http.basic("alice", "pw"))
                .headers().firstValue("set-cookie").orElseThrow().split(";")[0];

        System.out.println("\n═══ 2.7.7 登入後把帳號鎖起來，舊 session 還能不能用 ═══");
        System.out.println("  鎖定前: HTTP " + http.get("/whoami", "Cookie", cookie).statusCode());

        jdbc.update("UPDATE app_user SET account_non_locked = FALSE WHERE username = 'alice'");
        System.out.println("  DB 已改 account_non_locked = FALSE");

        HttpResponse<String> after = http.get("/whoami", "Cookie", cookie);
        System.out.println("  鎖定後（帶舊 cookie）: HTTP " + after.statusCode() + "  " + after.body());
        System.out.println("  鎖定後（重新 Basic）  : HTTP "
                + http.get("/whoami", "Authorization", Http.basic("alice", "pw")).statusCode());
    }
}
```

```
═══ 2.7.7 登入後把帳號鎖起來，舊 session 還能不能用 ═══
  鎖定前: HTTP 200
  DB 已改 account_non_locked = FALSE
  鎖定後（帶舊 cookie）: HTTP 200  {"name":"alice","authorities":"[ROLE_USER]","principalType":"AppUserDetails","displayName":"艾莉絲"}
  鎖定後（重新 Basic）  : HTTP 401
```

🔴 **帳號鎖了，舊 session 照樣 200。**

**為什麼**：`UserDetails` 的五個布林值**只在認證那一刻被檢查一次**。
之後每個請求只是從 session 讀回那個快照，**沒有人再去問資料庫一次**。

⚠️ **這句話換成事故報告的說法**：

> 「我們發現某個員工在做壞事，立刻在後台把他的帳號停用。
> 但他的瀏覽器分頁還開著，接下來三十分鐘他繼續操作了十七次。」

**四個解法，代價與生效時間不同**：

| 解法 | 生效時間 | 代價 |
|---|---|---|
| ① 什麼都不做，等 session 過期 | 最長 = session timeout（預設 30 分鐘） | 0 |
| ② 停用時**主動踢掉 session**（`SessionRegistry`） | 立即 | 需要 `HttpSessionEventPublisher` + 記憶體/Redis 追蹤 |
| ③ 每個請求**重查一次** `UserDetails` | 立即 | 每個請求 1 句 SQL（2.7.4 那 5 句）—— 可加快取 |
| ④ 無狀態 + 短期 token | 最長 = token 存活時間 | 05 章 5.6 的撤銷問題 |

**解法 ②，這一站建議的做法**：

```java
package com.example.lab09.ch02;

import org.springframework.boot.web.servlet.ServletListenerRegistrationBean;
import org.springframework.context.annotation.*;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.session.SessionRegistryImpl;
import org.springframework.security.web.session.HttpSessionEventPublisher;

@Configuration
public class SessionRegistryConfig {

    @Bean SessionRegistry sessionRegistry() { return new SessionRegistryImpl(); }

    /** ⚠️ 沒有這個 listener，session 過期時 registry 不會被清乾淨（會記憶體洩漏） */
    @Bean ServletListenerRegistrationBean<HttpSessionEventPublisher> sessionEventPublisher() {
        return new ServletListenerRegistrationBean<>(new HttpSessionEventPublisher());
    }
}
```

```java
package com.example.lab09.ch02;

import org.springframework.security.core.session.SessionInformation;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountAdminService {

    private final AppUserRepo repo;
    private final SessionRegistry sessions;

    public AccountAdminService(AppUserRepo repo, SessionRegistry sessions) {
        this.repo = repo; this.sessions = sessions;
    }

    @Transactional
    public int disable(String username) {
        AppUser u = repo.findByUsername(username).orElseThrow();
        u.setEnabled(false);                                   // ① 改 DB

        int killed = 0;                                        // ② ★ 把他現有的 session 全部作廢
        for (Object principal : sessions.getAllPrincipals()) {
            if (principal instanceof DbUserDetailsService.AppUserDetails d
                    && d.getUsername().equals(username)) {
                for (SessionInformation s : sessions.getAllSessions(principal, false)) {
                    s.expireNow();
                    killed++;
                }
            }
        }
        return killed;
    }
}
```

⚠️ **`SessionRegistry` 要能運作，chain 上必須開 `sessionManagement`**：

```java
http.sessionManagement(s -> s
    .maximumSessions(-1)                       // 不限制數量，但要註冊進 registry
    .sessionRegistry(sessionRegistry));
```

📌 **這件事 04 章 4.3 會做完整版**（含「同一帳號只能登入一台」與叢集環境）。
這裡先讓你知道：**「改了資料庫」不等於「立刻生效」**——
**這中間隔著一個 session，而那個 session 是你自己選擇要留的。**

### 2.7.8 要不要快取 `UserDetails`

**2.7.4 量到無狀態下每個請求 1 句 SQL。想省掉它，`DaoAuthenticationProvider` 有內建的快取位**：

```java
DaoAuthenticationProvider p = new DaoAuthenticationProvider();
p.setUserCache(new SpringCacheBasedUserCache(cacheManager.getCache("users")));
```

**預設是 `NullUserCache`（不快取）。** 那麼掛上去之後省了多少？

```java
package com.example.lab09.ch02;

import org.junit.jupiter.api.Test;
import org.springframework.cache.concurrent.ConcurrentMapCache;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.core.userdetails.cache.SpringCacheBasedUserCache;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.HashMap;
import java.util.Map;

class UserCacheTest {

    static final PasswordEncoder ENC = new BCryptPasswordEncoder();

    /** 一個假的「資料庫」，並且數 loadUserByUsername 被呼叫幾次 */
    static class FakeDb {
        final Map<String, String> hashes = new HashMap<>();
        int hits = 0;
        UserDetailsService uds() {
            return u -> {
                hits++;
                String h = hashes.get(u);
                if (h == null) throw new UsernameNotFoundException(u);
                return User.withUsername(u).password(h).roles("USER").build();
            };
        }
    }

    static String outcome(AuthenticationManager am, String u, String pw) {
        try { am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(u, pw)); return "✅ 登入成功"; }
        catch (RuntimeException e) { return "❌ " + e.getClass().getSimpleName(); }
    }

    static ProviderManager manager(FakeDb db, SpringCacheBasedUserCache cache, boolean erase) {
        DaoAuthenticationProvider p = new DaoAuthenticationProvider();
        p.setUserDetailsService(db.uds());
        p.setPasswordEncoder(ENC);
        p.setUserCache(cache);
        ProviderManager pm = new ProviderManager(p);
        pm.setEraseCredentialsAfterAuthentication(erase);
        return pm;
    }

    @Test
    void a_doesTheCacheSaveAnything() {
        System.out.println("\n═══ 2.7.8 內建的 UserCache 到底有沒有省下查詢 ═══");
        for (boolean erase : new boolean[]{true, false}) {
            FakeDb db = new FakeDb();
            db.hashes.put("alice", ENC.encode("pw"));
            SpringCacheBasedUserCache cache = new SpringCacheBasedUserCache(new ConcurrentMapCache("u" + erase));
            ProviderManager am = manager(db, cache, erase);

            outcome(am, "alice", "pw");                                  // 第一次：一定要查 DB
            UserDetails cached = cache.getUserFromCache("alice");
            db.hits = 0;
            for (int i = 0; i < 5; i++) outcome(am, "alice", "pw");      // 之後五次

            System.out.printf("  eraseCredentialsAfterAuthentication = %-5s%n", erase);
            System.out.println("    快取裡那份 UserDetails 的 getPassword(): "
                    + (cached == null ? "(沒進快取)" : cached.getPassword()));
            System.out.println("    後續 5 次登入，查了 DB " + db.hits + " 次");
        }
    }

    /** 洞一：改密碼之後，舊密碼繼續有效 */
    @Test
    void b_stalePassword() {
        System.out.println("\n═══ 2.7.8 快取真的生效時，改密碼多久才生效 ═══");
        FakeDb db = new FakeDb();
        db.hashes.put("alice", ENC.encode("OLD-pw"));
        SpringCacheBasedUserCache cache = new SpringCacheBasedUserCache(new ConcurrentMapCache("stale"));
        ProviderManager am = manager(db, cache, false);          // ★ 快取要生效，就得關掉 erase

        System.out.println("  ① 用 OLD-pw 登入（把 UserDetails 灌進快取）: " + outcome(am, "alice", "OLD-pw"));
        System.out.println("  ② 使用者改密碼 → DB 換成 NEW-pw 的雜湊（沒有清快取）");
        db.hashes.put("alice", ENC.encode("NEW-pw"));
        System.out.println("  ③ 用【舊】密碼 OLD-pw 登入: " + outcome(am, "alice", "OLD-pw"));
        System.out.println("  ④ 用【新】密碼 NEW-pw 登入: " + outcome(am, "alice", "NEW-pw"));
        System.out.println("  ⑤ 清掉快取（changePassword 應該做的事）");
        cache.removeUserFromCache("alice");
        System.out.println("     用【舊】密碼 OLD-pw 登入: " + outcome(am, "alice", "OLD-pw"));
        cache.removeUserFromCache("alice");
        System.out.println("     用【新】密碼 NEW-pw 登入: " + outcome(am, "alice", "NEW-pw"));
    }

    /** 洞二：停用帳號之後，帳號還能繼續登入 */
    @Test
    void c_staleAccountStatus() {
        System.out.println("\n═══ 2.7.8 快取真的生效時，停用帳號多久才生效 ═══");
        Map<String, Boolean> enabled = new HashMap<>(Map.of("alice", true));
        String hash = ENC.encode("pw");
        int[] hits = {0};
        UserDetailsService uds = u -> {
            hits[0]++;
            return User.withUsername(u).password(hash).roles("USER")
                       .disabled(!enabled.getOrDefault(u, false)).build();
        };
        DaoAuthenticationProvider p = new DaoAuthenticationProvider();
        p.setUserDetailsService(uds);
        p.setPasswordEncoder(ENC);
        SpringCacheBasedUserCache cache = new SpringCacheBasedUserCache(new ConcurrentMapCache("st"));
        p.setUserCache(cache);
        ProviderManager am = new ProviderManager(p);
        am.setEraseCredentialsAfterAuthentication(false);

        System.out.println("  ① 登入一次: " + outcome(am, "alice", "pw"));
        System.out.println("  ② 管理員把 alice 停用（只改 DB）");
        enabled.put("alice", false);
        hits[0] = 0;
        System.out.println("  ③ 再登入: " + outcome(am, "alice", "pw")
                + "   （這一次查了 DB " + hits[0] + " 次）");
    }
}
```

```
═══ 2.7.8 內建的 UserCache 到底有沒有省下查詢 ═══
  eraseCredentialsAfterAuthentication = true 
    快取裡那份 UserDetails 的 getPassword(): null
    後續 5 次登入，查了 DB 5 次
  eraseCredentialsAfterAuthentication = false
    快取裡那份 UserDetails 的 getPassword(): $2a$10$hfY2qX/qgS2gGd6bkThZlOs3OVWGQNPz3I206pIk6Ekkj6dW2QZYG
    後續 5 次登入，查了 DB 0 次
```

🔴 **用預設值掛上快取，省下的查詢是【零】。**

**原因是 2.4.5 那個 `eraseCredentials` 與這個快取撞在一起了**：

```
① DaoAuthenticationProvider 把【UserDetails 物件本身】放進快取（putUserInCache(user)）
② 認證成功後，ProviderManager 呼叫 result.eraseCredentials()
③ AbstractAuthenticationToken.eraseCredentials() 會【連 principal 一起清】
   而 principal 就是 ①【放進快取的那一個物件】（同一個參考）
④ 於是快取裡那份的 getPassword() 變成 null
⑤ 下一次登入：快取命中 → 用 null 當雜湊去比對 → 一定失敗
   → 走進 2.5.1 那個 catch → cacheWasUsed 是 true → ★ 重查一次 DB、重驗一次
⑥ 結果：每次都還是查了 DB，而且【多做了一次白費的 BCrypt 比對】
```

📌 **這是一個「掛上去覺得有效、量了才知道沒有」的設定。**
如果你的專案裡有 `setUserCache(...)`，**先量一次 `loadUserByUsername` 的呼叫次數**再說。

**要讓它真的生效，必須同時關掉 `eraseCredentials`**——而那會打開兩個洞。

**洞一：改密碼之後，舊密碼繼續有效。**

**上面那個 `UserCacheTest` 的第二個測試方法**（再貼一次，方便對照輸出）：

```java
@Test
void b_stalePassword() {
    System.out.println("\n═══ 2.7.8 快取真的生效時，改密碼多久才生效 ═══");
    FakeDb db = new FakeDb();
    db.hashes.put("alice", ENC.encode("OLD-pw"));
    SpringCacheBasedUserCache cache = new SpringCacheBasedUserCache(new ConcurrentMapCache("stale"));
    ProviderManager am = manager(db, cache, false);          // ★ 快取要生效，就得關掉 erase

    System.out.println("  ① 用 OLD-pw 登入（把 UserDetails 灌進快取）: " + outcome(am, "alice", "OLD-pw"));
    System.out.println("  ② 使用者改密碼 → DB 換成 NEW-pw 的雜湊（沒有清快取）");
    db.hashes.put("alice", ENC.encode("NEW-pw"));
    System.out.println("  ③ 用【舊】密碼 OLD-pw 登入: " + outcome(am, "alice", "OLD-pw"));
    System.out.println("  ④ 用【新】密碼 NEW-pw 登入: " + outcome(am, "alice", "NEW-pw"));
    System.out.println("  ⑤ 清掉快取（changePassword 應該做的事）");
    cache.removeUserFromCache("alice");
    System.out.println("     用【舊】密碼 OLD-pw 登入: " + outcome(am, "alice", "OLD-pw"));
    cache.removeUserFromCache("alice");
    System.out.println("     用【新】密碼 NEW-pw 登入: " + outcome(am, "alice", "NEW-pw"));
}
```

```
═══ 2.7.8 快取真的生效時，改密碼多久才生效 ═══
  ① 用 OLD-pw 登入（把 UserDetails 灌進快取）: ✅ 登入成功
  ② 使用者改密碼 → DB 換成 NEW-pw 的雜湊（沒有清快取）
  ③ 用【舊】密碼 OLD-pw 登入: ✅ 登入成功
  ④ 用【新】密碼 NEW-pw 登入: ✅ 登入成功
  ⑤ 清掉快取（changePassword 應該做的事）
     用【舊】密碼 OLD-pw 登入: ❌ BadCredentialsException
     用【新】密碼 NEW-pw 登入: ✅ 登入成功
```

🔴 **第 ③ 與第 ④ 同時成立：新舊兩個密碼都能登入。**

**④ 之所以也成功，是因為 2.5.1 那個 `catch` 的補救**——
快取那份驗不過就重查 DB，於是新密碼也通得過。
**Spring 幫你保證了「新密碼一定能用」，但沒有辦法保證「舊密碼一定不能用」。**

**洞二：停用帳號之後，帳號還能繼續登入。**（同一個類別的第三個測試方法）

```java
@Test
void c_staleAccountStatus() {
    System.out.println("\n═══ 2.7.8 快取真的生效時，停用帳號多久才生效 ═══");
    Map<String, Boolean> enabled = new HashMap<>(Map.of("alice", true));
    String hash = ENC.encode("pw");
    int[] hits = {0};
    UserDetailsService uds = u -> {
        hits[0]++;
        return User.withUsername(u).password(hash).roles("USER")
                   .disabled(!enabled.getOrDefault(u, false)).build();
    };
    DaoAuthenticationProvider p = new DaoAuthenticationProvider();
    p.setUserDetailsService(uds);
    p.setPasswordEncoder(ENC);
    SpringCacheBasedUserCache cache = new SpringCacheBasedUserCache(new ConcurrentMapCache("st"));
    p.setUserCache(cache);
    ProviderManager am = new ProviderManager(p);
    am.setEraseCredentialsAfterAuthentication(false);

    System.out.println("  ① 登入一次: " + outcome(am, "alice", "pw"));
    System.out.println("  ② 管理員把 alice 停用（只改 DB）");
    enabled.put("alice", false);
    hits[0] = 0;
    System.out.println("  ③ 再登入: " + outcome(am, "alice", "pw")
            + "   （這一次查了 DB " + hits[0] + " 次）");
}
```

```
═══ 2.7.8 快取真的生效時，停用帳號多久才生效 ═══
  ① 登入一次: ✅ 登入成功
  ② 管理員把 alice 停用（只改 DB）
  ③ 再登入: ✅ 登入成功   （這一次查了 DB 0 次）
```

🔴 **停用了，還登得進去，而且完全沒碰資料庫。**

**這個洞比 2.7.7 那個更深**：2.7.7 至少「重新用帳密登入」會被擋；
這裡連**重新登入都擋不住**，因為連 `loadUserByUsername` 都沒被呼叫。

📌 **整理成判準**：

| 情況 | 建議 | 理由 |
|---|---|---|
| 有 session 的網頁應用 | **不要用 `UserCache`** | 2.7.4 量到每個請求本來就 0 句 SQL |
| 無狀態 API + Basic | **不要用 `UserCache`，改用 token**（05 章） | 預設設定下它省不到任何查詢 |
| 真的要用 | 必須 `eraseCredentials=false` + **TTL ≤ 60 秒** + **改密碼 / 停用時主動 evict** | 上面兩個洞 |

```java
@Transactional
public void changePassword(String username, String newRawPassword) {
    AppUser u = repo.findByUsername(username).orElseThrow();
    u.setPasswordHash(encoder.encode(newRawPassword));
    userCache.removeUserFromCache(username);        // 🔴 忘了這一行，舊密碼會繼續有效
    // 而且別忘了 2.7.7：現有的 session 也要一起作廢
}
```

⚠️ **`eraseCredentials=false` 還有一個不在這一節範圍內的代價**：
`SecurityContext` 裡會一直留著密碼雜湊。
有狀態應用下它會被序列化進 session（甚至進 Redis），
**等於把整份密碼雜湊表的一部分，複製到了一個你沒有在保護的地方。**


---

## 2.8 密碼漸進升級：`UserDetailsPasswordService`

### 2.8.1 `upgradeEncoding` 對哪些雜湊回 `true`

00 章 0.7.7 介紹過 `PasswordEncoder` 的第三個方法：

```java
public interface PasswordEncoder {
    String  encode(CharSequence rawPassword);
    boolean matches(CharSequence rawPassword, String encodedPassword);
    default boolean upgradeEncoding(String encodedPassword) { return false; }   // ★
}
```

**`DelegatingPasswordEncoder` 對它的實作，是「這個雜湊的演算法是不是我現在的預設」**：

```java
package com.example.lab09.ch02;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

class UpgradeEncodingTest {

    @Test
    void whatUpgradeEncodingChecks() {
        System.out.println("\n═══ 2.8.1 upgradeEncoding 對哪些雜湊回 true ═══");
        PasswordEncoder del = PasswordEncoderFactories.createDelegatingPasswordEncoder();
        String[][] samples = {
                {"{bcrypt}" + new BCryptPasswordEncoder(4).encode("pw"),  "bcrypt cost=4（太弱）"},
                {"{bcrypt}" + new BCryptPasswordEncoder(10).encode("pw"), "bcrypt cost=10（今天的預設）"},
                {"{bcrypt}" + new BCryptPasswordEncoder(12).encode("pw"), "bcrypt cost=12（比預設強）"},
                {"{noop}pw", "明碼"},
                {"{MD5}{salt}0123456789abcdef0123456789abcdef", "MD5"},
                {"{pbkdf2@SpringSecurity_v5_8}" + "0".repeat(64), "PBKDF2"}};
        for (String[] s : samples) {
            String verdict;
            try { verdict = String.valueOf(del.upgradeEncoding(s[0])); }
            catch (Exception e) { verdict = e.getClass().getSimpleName(); }
            System.out.printf("  %-32s upgradeEncoding = %s%n", s[1], verdict);
        }
    }
}
```

```
═══ 2.8.1 upgradeEncoding 對哪些雜湊回 true ═══
  bcrypt cost=4（太弱）                upgradeEncoding = true
  bcrypt cost=10（今天的預設）            upgradeEncoding = false
  bcrypt cost=12（比預設強）             upgradeEncoding = false
  明碼                               upgradeEncoding = true
  MD5                              upgradeEncoding = true
  PBKDF2                           upgradeEncoding = true
```

**三個要注意的行為**：

| 觀察 | 說明 |
|---|---|
| `cost=4` → `true` | `BCryptPasswordEncoder.upgradeEncoding` 會**解析出 cost 並比較**，比預設低就要升 |
| `cost=12` → **`false`** | **比預設強的【不會】被降級**——這是對的 |
| PBKDF2 → `true` | 只要「不是目前的預設演算法（bcrypt）」就回 `true` |

⚠️ **最後一列有一個陷阱**：如果你**刻意**把 PBKDF2 當主力，卻沒有改
`createDelegatingPasswordEncoder()` 的預設 id，
**每一次登入都會把 PBKDF2 的雜湊「升級」成 BCrypt**——方向剛好相反。

```java
// 要指定預設演算法，用完整版的建構子
Map<String, PasswordEncoder> encoders = Map.of(
        "argon2", Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8(),
        "bcrypt", new BCryptPasswordEncoder(),
        "noop",   NoOpPasswordEncoder.getInstance());
DelegatingPasswordEncoder enc = new DelegatingPasswordEncoder("argon2", encoders);   // ★ 預設是 argon2
enc.setDefaultPasswordEncoderForMatches(new BCryptPasswordEncoder());   // 沒有前綴的舊資料怎麼驗
```

### 2.8.2 實測：登入一次，資料庫裡的雜湊自己換掉

**接線只需要三個條件**：

```
① 你的 UserDetailsService 之外，另外提供一個 UserDetailsPasswordService bean
② PasswordEncoder 要是能回報 upgradeEncoding 的（DelegatingPasswordEncoder 就是）
③ ★ 兩者都要被同一個 DaoAuthenticationProvider 認得
   —— 自動設定會做（2.6.3 那段 InitializeUserDetailsManagerConfigurer 有處理），
      但如果你自己組 ProviderManager，要記得 setUserDetailsPasswordService(...)
```

```java
package com.example.lab09.ch02;

import org.springframework.context.annotation.Profile;
import org.springframework.security.core.userdetails.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.concurrent.atomic.AtomicInteger;

/** 登入成功的當下，把過期演算法的雜湊換掉（使用者完全無感） */
@Service
@Profile("up")
public class PasswordUpgradeService implements UserDetailsPasswordService {

    public static final AtomicInteger UPGRADES = new AtomicInteger();     // 只為了實測數次數

    private final AppUserRepo repo;
    public PasswordUpgradeService(AppUserRepo repo) { this.repo = repo; }

    @Override
    @Transactional
    public UserDetails updatePassword(UserDetails user, String newPassword) {
        AppUser row = repo.findByUsernameWithAuthorities(user.getUsername())
                .orElseThrow(() -> new UsernameNotFoundException(user.getUsername()));
        row.setPasswordHash(newPassword);          // ★ 這裡拿到的已經是【新演算法的雜湊】
        UPGRADES.incrementAndGet();
        return new DbUserDetailsService.AppUserDetails(row);   // 2.7.2 那個 DTO
    }
}
```

⚠️ **`newPassword` 參數是【已經 encode 過的雜湊】，不是明碼。**
Spring 在呼叫之前就已經用新演算法 encode 好了：

```java
// DaoAuthenticationProvider.createSuccessAuthentication（6.2.4）
protected Authentication createSuccessAuthentication(Object principal, Authentication authentication,
        UserDetails user) {
    boolean upgradeEncoding = this.userDetailsPasswordService != null
            && this.passwordEncoder.upgradeEncoding(user.getPassword());
    if (upgradeEncoding) {
        String presentedPassword = authentication.getCredentials().toString();   // ★ 這一刻手上有明碼
        String newPassword = this.passwordEncoder.encode(presentedPassword);
        user = this.userDetailsPasswordService.updatePassword(user, newPassword);
    }
    return super.createSuccessAuthentication(principal, authentication, user);
}
```

📌 **注意 `createSuccessAuthentication` 這個名字**：它只在**認證成功之後**才被呼叫。
**密碼打錯的人不會觸發升級**——這很重要，下面會量它。

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"db", "up"})
class PasswordUpgradeTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired PasswordEncoder encoder;

    String hashOf(String user) {
        return jdbc.queryForObject("SELECT password_hash FROM app_user WHERE username=?", String.class, user);
    }

    @BeforeEach void seed() {
        jdbc.update("DELETE FROM authority");
        jdbc.update("DELETE FROM app_user");
        // alice 的密碼是【三年前】用 cost=4 存的
        String old = "{bcrypt}" + new BCryptPasswordEncoder(4).encode("pw");
        jdbc.update("""
                INSERT INTO app_user (username, password_hash, display_name, enabled,
                                      account_non_expired, account_non_locked)
                VALUES ('alice', ?, '艾莉絲', TRUE, TRUE, TRUE)""", old);
        Long id = jdbc.queryForObject("SELECT id FROM app_user WHERE username='alice'", Long.class);
        jdbc.update("INSERT INTO authority (user_id, authority) VALUES (?, 'ROLE_USER')", id);
        // bob 用今天的預設存（Seed 見 2.7.2）
        Seed.add(jdbc, "bob", "pw", "巴布", true, true, true, null, "ROLE_USER");
        PasswordUpgradeService.UPGRADES.set(0);
    }

    @Test
    void upgradeOnLogin() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.8.2 登入一次，資料庫裡的雜湊自己換掉 ═══");

        String before = hashOf("alice");
        System.out.println("  登入前 alice 的雜湊: " + before);
        System.out.println("    → 今天的 encoder 認為要升級嗎: " + encoder.upgradeEncoding(before));

        HttpResponse<String> r = http.get("/whoami", "Authorization", Http.basic("alice", "pw"));
        System.out.println("  GET /whoami（Basic alice/pw）→ HTTP " + r.statusCode());

        String after = hashOf("alice");
        System.out.println("  登入後 alice 的雜湊: " + after);
        System.out.println("    → 換掉了嗎: " + !before.equals(after));
        System.out.println("    → 今天的 encoder 認為要升級嗎: " + encoder.upgradeEncoding(after));
        System.out.println("  updatePassword 被呼叫: " + PasswordUpgradeService.UPGRADES.get() + " 次");

        System.out.println("\n  ── bob（本來就是最新格式）");
        String b1 = hashOf("bob");
        http.get("/whoami", "Authorization", Http.basic("bob", "pw"));
        System.out.println("  登入前後有沒有變: " + !b1.equals(hashOf("bob"))
                + "（updatePassword 累計 " + PasswordUpgradeService.UPGRADES.get() + " 次）");

        System.out.println("\n  ── alice 再登入五次");
        for (int i = 0; i < 5; i++) http.get("/whoami", "Authorization", Http.basic("alice", "pw"));
        System.out.println("  updatePassword 累計: " + PasswordUpgradeService.UPGRADES.get() + " 次（升過就不再升）");

        System.out.println("\n  ── 密碼打錯，會不會被升級？");
        int callsBefore = PasswordUpgradeService.UPGRADES.get();
        HttpResponse<String> bad = http.get("/whoami", "Authorization", Http.basic("alice", "WRONG"));
        System.out.println("  HTTP " + bad.statusCode()
                + "，updatePassword 又被呼叫了 " + (PasswordUpgradeService.UPGRADES.get() - callsBefore) + " 次");
    }
}
```

```
═══ 2.8.2 登入一次，資料庫裡的雜湊自己換掉 ═══
  登入前 alice 的雜湊: {bcrypt}$2a$04$M6UqzkPc96GAcgIQdJ6eQucjSJqyJKQIt96SSoMerpQoDKGaazXay
    → 今天的 encoder 認為要升級嗎: true
  GET /whoami（Basic alice/pw）→ HTTP 200
  登入後 alice 的雜湊: {bcrypt}$2a$10$VFhvA2v0.Rdir6EQlK/ufO2pBAvK6LVA.5FkEW85xSjtoB7wrWkNu
    → 換掉了嗎: true
    → 今天的 encoder 認為要升級嗎: false
  updatePassword 被呼叫: 1 次

  ── bob（本來就是最新格式）
  登入前後有沒有變: false（updatePassword 累計 1 次）

  ── alice 再登入五次
  updatePassword 累計: 1 次（升過就不再升）

  ── 密碼打錯，會不會被升級？
  HTTP 401，updatePassword 又被呼叫了 0 次
```

**`$2a$04$…` 變成 `$2a$10$…`，使用者完全無感。**

**四個行為都符合預期**：

```
① 舊格式的帳號登入一次 → 自動升級（1 次）
② 已經是最新格式的帳號 → 完全不動（累計還是 1 次）
③ 升級過的帳號再登入五次 → 不再升級（累計還是 1 次）
④ 密碼打錯 → 不升級（0 次）
```

📌 **③ 與 ④ 是這個機制能上線的關鍵**：
它**不是**「每次登入都重算一次雜湊」，
而是「只有在 `upgradeEncoding` 說要升的時候才多做一次 encode」。
一年之後，活躍使用者全部升級完成，這段程式碼就等於不存在。

### 2.8.3 四個必須先想清楚的問題

**這個機制很甜，但它會在「登入」這條路徑上加一次資料庫寫入。**

**① 讀寫分離的資料庫**

```
登入通常打【唯讀 replica】，而 updatePassword 是【寫入】
→ 如果你用 @Transactional(readOnly = true) 的 routing datasource，這裡會拋例外
→ 而且那個例外會在 createSuccessAuthentication 裡發生
   → 被包成 InternalAuthenticationServiceException
   → ★ 使用者看到 401，密碼明明是對的
```

**修法：`updatePassword` 明確標成寫入交易**（本節的實作用了 `@Transactional`，
沒有 `readOnly`，就是為了這件事），**並且在 routing datasource 裡確認它會被導到主庫**。

**② 升級失敗要不要讓登入失敗**

```java
@Override
@Transactional
public UserDetails updatePassword(UserDetails user, String newPassword) {
    try {
        AppUser row = repo.findByUsernameWithAuthorities(user.getUsername()).orElseThrow();
        row.setPasswordHash(newPassword);
        return new DbUserDetailsService.AppUserDetails(row);
    } catch (RuntimeException e) {
        // ★ 判斷：升級是「加分項」，不該讓一次成功的認證失敗
        log.warn("密碼升級失敗，使用者 {} 這次先用舊雜湊登入", user.getUsername(), e);
        return user;                     // 回傳原本那個，登入照常成功
    }
}
```

⚠️ **但要小心「每次登入都失敗、每次登入都多寫一次日誌」**——
如果你的 `app_user` 表在某個時段是唯讀的，這會變成一場日誌洪水。
**加一個「同一個帳號 N 分鐘內只嘗試升級一次」的節流，或者直接關掉這個功能。**

**③ 提高 cost 會讓登入變慢兩倍**

```
升級當下：驗一次舊密碼（cost=4，約 4 ms） + encode 一次新的（cost=10，約 68 ms）
        = 72 ms，比平常多 68 ms

如果你是【一次性大量升級】（例如公告後一週內大家都回來登入），
這段期間登入端點的平均延遲會明顯上升 —— 而且是【每個人只發生一次】的那種上升。
```

📌 **在 cost 從 10 調到 12 的時候，這件事會更明顯**（cost 每 +1，時間 ×2）。
**上線前先算：現有帳號數 × 一次 encode 的時間 ÷ 預期的回流期間。**

**④ 它只升級「登入過的人」**

```
一年後：活躍使用者 100% 升級完成
       半年沒登入的：還是舊雜湊

→ 資料庫外洩時，舊雜湊【還在那裡】
→ 所以「漸進升級」不能取代「MD5 這種必須立刻處理的情況」
```

**MD5 / SHA-1 / 明碼這三種，要的是【立刻讓它不可用】**：

```sql
-- 給一個截止日；過了就強制走「忘記密碼」流程
UPDATE app_user SET credentials_expire_at = '2026-12-31 00:00:00'
 WHERE password_hash LIKE '{MD5}%' OR password_hash LIKE '{noop}%';
```

**這樣 2.7.6 那個 `CredentialsExpiredException` 就會替你把關**——
到期後這些人**必須**改密碼才能繼續用，而在到期之前他們每次登入都會被自動升級。

📌 **兩個機制搭起來，就是一份完整的密碼遷移計畫**：

```
今天       掛上 UserDetailsPasswordService  → 活躍使用者無感升級
今天       設 credentials_expire_at         → 給舊雜湊一個死線
死線之後   剩下的人走「忘記密碼」流程           → 舊雜湊歸零
```

---

## 2.9 密碼強度規則

### 2.9.1 為什麼「大小寫 + 數字 + 符號」是錯的方向

**NIST SP 800-63B（2017 年首次提出，後續修訂維持相同立場）明確建議**：

| NIST 說 | 大部分系統在做 |
|---|---|
| ✅ 最少 8 字元，**建議至少 15**，最多至少允許 64 | 8～16 字元（**設上限** 🔴） |
| ✅ **比對已外洩的密碼字典** | 沒做 |
| ✅ 允許**所有**可列印字元，包含空白與 Unicode | 禁止空白、禁止某些符號 🔴 |
| ❌ **不要**強制字元組合規則 | 強制大小寫 + 數字 + 符號 🔴 |
| ❌ **不要**定期強制換密碼 | 90 天強制換 🔴 |
| ❌ **不要**用密碼提示問題 | 「你的母親叫什麼名字」🔴 |

**為什麼「不要強制字元組合」？** 因為人類面對規則的反應是**可預測的**：

```
規則：至少一個大寫、一個數字、一個符號
人類：password → Password1!
      把大寫放第一個、數字放倒數第二、符號放最後

→ 破解字典【也知道這個規則】，它們就是照這個模式生成的
→ 你把搜尋空間從「所有 8 字元組合」縮小成「常見單字 + 常見變形」
```

**同樣的道理，「90 天強制換」的結果是**：

```
Summer2026! → Autumn2026! → Winter2026! → Spring2027!
```

**現在來量。**

### 2.9.2 實測：同一批密碼，兩套規則的判定

```java
package com.example.lab09.ch02;

import java.util.*;

/**
 * 依據 NIST SP 800-63B：長度優先、比對外洩字典，
 * 【不要】強制字元組合、【不要】定期強制換。
 */
public class PasswordPolicy {

    /** 真實世界的字典檔會有幾十萬筆；這裡放最常見的幾十筆示意 */
    private static final Set<String> BLOCKLIST = Set.of(
            "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111",
            "1234567", "dragon", "123123", "baseball", "abc123", "football", "monkey", "letmein",
            "shadow", "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890",
            "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212", "000000",
            "passw0rd", "p@ssw0rd", "password1", "password123", "qwerty123", "admin",
            "welcome", "iloveyou", "sunshine", "princess", "admin123", "changeme");

    /** 鍵盤上的連續序列 */
    private static final String[] SEQUENCES = {
            "qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "abcdefghijklmnopqrstuvwxyz"};

    public record Verdict(boolean ok, List<String> problems) {
        public String describe() { return ok ? "✅ 通過" : "❌ " + String.join("；", problems); }
    }

    // ── 規則 A：很多公司在用的「字元組合」規則 ──────────────────────
    public static Verdict compositionRule(String pw) {
        List<String> bad = new ArrayList<>();
        if (pw.length() < 8) bad.add("至少 8 個字元");
        if (pw.chars().noneMatch(Character::isUpperCase)) bad.add("要有大寫");
        if (pw.chars().noneMatch(Character::isLowerCase)) bad.add("要有小寫");
        if (pw.chars().noneMatch(Character::isDigit)) bad.add("要有數字");
        if (pw.chars().allMatch(Character::isLetterOrDigit)) bad.add("要有特殊符號");
        return new Verdict(bad.isEmpty(), bad);
    }

    // ── 規則 B：NIST 800-63B 建議的做法 ──────────────────────────
    public static Verdict nistRule(String pw, String username, String displayName) {
        List<String> bad = new ArrayList<>();

        if (pw.codePointCount(0, pw.length()) < 12)
            bad.add("至少 12 個字元（目前 " + pw.codePointCount(0, pw.length()) + "）");
        if (pw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 72)
            bad.add("超過 BCrypt 的 72 位元組上限（00 章 0.7.6）");

        String lower = pw.toLowerCase(Locale.ROOT);
        if (BLOCKLIST.contains(lower)) bad.add("這是外洩字典裡的常見密碼");
        for (String common : BLOCKLIST)
            if (common.length() >= 6 && lower.contains(common) && !BLOCKLIST.contains(lower)) {
                bad.add("包含常見密碼片段「" + common + "」");
                break;
            }

        if (username != null && !username.isBlank() && lower.contains(username.toLowerCase(Locale.ROOT)))
            bad.add("不能包含帳號");
        if (displayName != null && !displayName.isBlank() && lower.contains(displayName.toLowerCase(Locale.ROOT)))
            bad.add("不能包含名字");

        for (String seq : SEQUENCES)
            for (int i = 0; i + 5 <= seq.length(); i++)
                if (lower.contains(seq.substring(i, i + 5))) {
                    bad.add("包含鍵盤連續序列「" + seq.substring(i, i + 5) + "」");
                    i = seq.length();
                    break;
                }

        if (pw.chars().distinct().count() <= 2)
            bad.add("只用了 " + pw.chars().distinct().count() + " 種字元");

        return new Verdict(bad.isEmpty(), bad);
    }

    /** 粗估的猜測空間（bits）—— 只拿來排序，不要當成安全保證 */
    public static double entropyBits(String pw) {
        int space = 0;
        if (pw.chars().anyMatch(Character::isLowerCase)) space += 26;
        if (pw.chars().anyMatch(Character::isUpperCase)) space += 26;
        if (pw.chars().anyMatch(Character::isDigit)) space += 10;
        if (pw.chars().anyMatch(c -> !Character.isLetterOrDigit(c) && c < 128)) space += 33;
        if (pw.chars().anyMatch(c -> c > 127)) space += 20000;          // 中文之類
        return space == 0 ? 0 : pw.codePointCount(0, pw.length()) * (Math.log(space) / Math.log(2));
    }
}
```

```java
package com.example.lab09.ch02;

import org.junit.jupiter.api.Test;

import java.util.List;

class PasswordPolicyTest {

    record Candidate(String pw, String note) {}

    static final List<Candidate> CANDIDATES = List.of(
            new Candidate("P@ssw0rd",           "教科書上的「強密碼」範本"),
            new Candidate("Passw0rd!",          "改一下加個驚嘆號"),
            new Candidate("Qwerty123!",         "鍵盤第一排"),
            new Candidate("Summer2026!",        "季節 + 年份，企業最常見"),
            new Candidate("aA1!aA1!",           "剛好符合每一條組合規則"),
            new Candidate("alice2026",          "帳號 + 年份"),
            new Candidate("correct horse battery staple", "四個隨機英文字（passphrase）"),
            new Candidate("我家門前有小河後面有山坡", "中文長句"),
            new Candidate("k7#Qm2$Lp9!Zx4&Vt", "密碼管理器產生的"));

    @Test
    void twoRules() {
        System.out.println("\n═══ 2.9.2 同一批密碼，兩套規則的判定 ═══");
        System.out.printf("%-32s %-6s %-32s %s%n", "密碼", "熵(bit)", "字元組合規則", "NIST 規則");
        for (Candidate c : CANDIDATES) {
            var a = PasswordPolicy.compositionRule(c.pw());
            var b = PasswordPolicy.nistRule(c.pw(), "alice", "艾莉絲");
            System.out.printf("%-32s %6.0f %-32s %s%n",
                    c.pw(), PasswordPolicy.entropyBits(c.pw()), a.describe(), b.describe());
        }
    }
}
```

```
═══ 2.9.2 同一批密碼，兩套規則的判定 ═══
密碼                               熵(bit) 字元組合規則                           NIST 規則
P@ssw0rd                             53 ✅ 通過                             ❌ 至少 12 個字元（目前 8）；這是外洩字典裡的常見密碼
Passw0rd!                            59 ✅ 通過                             ❌ 至少 12 個字元（目前 9）；包含常見密碼片段「passw0rd」
Qwerty123!                           66 ✅ 通過                             ❌ 至少 12 個字元（目前 10）；包含常見密碼片段「qwerty」；包含鍵盤連續序列「qwert」
Summer2026!                          72 ✅ 通過                             ❌ 至少 12 個字元（目前 11）
aA1!aA1!                             53 ✅ 通過                             ❌ 至少 12 個字元（目前 8）
alice2026                            47 ❌ 要有大寫；要有特殊符號                    ❌ 至少 12 個字元（目前 9）；不能包含帳號
correct horse battery staple        165 ❌ 要有大寫；要有數字                      ✅ 通過
我家門前有小河後面有山坡                        171 ❌ 要有大寫；要有小寫；要有數字；要有特殊符號          ✅ 通過
k7#Qm2$Lp9!Zx4&Vt                   112 ✅ 通過                             ✅ 通過
```

🔴 **看第一列與倒數第三列**：

```
P@ssw0rd                        熵 53 bit   字元組合規則 ✅ 通過
correct horse battery staple    熵 165 bit  字元組合規則 ❌ 被【拒絕】
```

**字元組合規則放行了一個爛密碼，並且拒絕了一個好三倍的密碼。**

📌 **「熵」那一欄要小心解讀**——它假設「每個字元都是隨機挑的」，
而 `P@ssw0rd` 的 53 bit 是**虛的**：它其實只是字典裡的一個項目，
真實的猜測成本是「字典的第 N 個」，不是 2⁵³。
**這正是「用外洩字典比對」比「算熵」有意義的原因。**

### 2.9.3 實測：字典攻擊要多久

```java
package com.example.lab09.ch02;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

class DictionaryCostTest {

    static String human(double sec) {
        if (sec < 60) return String.format("%.1f 秒", sec);
        if (sec < 3600) return String.format("%.1f 分鐘", sec / 60);
        if (sec < 86400) return String.format("%.1f 小時", sec / 3600);
        if (sec < 86400 * 365) return String.format("%.1f 天", sec / 86400);
        return String.format("%.1f 年", sec / 86400 / 365);
    }

    @Test
    void dictionaryCost() {
        System.out.println("\n═══ 2.9.3 「通過組合規則」的密碼，用字典要試多久 ═══");
        BCryptPasswordEncoder e10 = new BCryptPasswordEncoder(10);
        String hash = e10.encode("P@ssw0rd");
        long t0 = System.nanoTime();
        int tries = 20;
        for (int i = 0; i < tries; i++) e10.matches("guess" + i, hash);
        double perTry = (System.nanoTime() - t0) / 1e6 / tries;

        System.out.printf("  BCrypt cost=10 一次比對: %.1f ms（這台機器）%n", perTry);
        for (long size : new long[]{10_000L, 1_000_000L, 100_000_000L, 14_000_000_000L}) {
            System.out.printf("  字典 %,15d 筆 → 單執行緒 %s%n", size, human(size * perTry / 1000.0));
        }
        System.out.println("  ★ 但字典是【依常見度排序】的：P@ssw0rd 排在前一萬名以內");
        System.out.printf("  ★ 也就是說，它撐不過 %s%n", human(10_000 * perTry / 1000.0));
        System.out.println("  ★ 對照 00 章 0.3.3：同一批密碼用 MD5 存，整份字典 0.3 毫秒跑完");
    }
}
```

```
═══ 2.9.3 「通過組合規則」的密碼，用字典要試多久 ═══
  BCrypt cost=10 一次比對: 69.1 ms（這台機器）
  字典          10,000 筆 → 單執行緒 11.5 分鐘
  字典       1,000,000 筆 → 單執行緒 19.2 小時
  字典     100,000,000 筆 → 單執行緒 79.9 天
  字典  14,000,000,000 筆 → 單執行緒 30.7 年
  ★ 但字典是【依常見度排序】的：P@ssw0rd 排在前一萬名以內
  ★ 也就是說，它撐不過 11.5 分鐘
  ★ 對照 00 章 0.3.3：同一批密碼用 MD5 存，整份字典 0.3 毫秒跑完
```

**11.5 分鐘。** 而且那還是**單執行緒、用 CPU**——
攻擊者用 GPU 或租雲端機器，這個數字要再除以兩三個數量級。

📌 **把兩章的數字並排，這件事就完整了**：

| 存法 | 破解 `P@ssw0rd` | 出處 |
|---|---|---|
| MD5 | **0.3 毫秒**（整份字典） | 00 章 0.3.3 |
| BCrypt cost=10 | **11.5 分鐘**（前一萬筆） | 2.9.3 |
| BCrypt cost=10 + `correct horse battery staple` | 不在字典裡，要暴力 → 2¹⁶⁵ | 2.9.2 |

> 📌 **BCrypt 買到的是「時間」，不是「安全」。**
> **它讓一個爛密碼從 0.3 毫秒撐到 11.5 分鐘——
> 那足夠你發現外洩並發出通知，但不足以讓那個密碼繼續安全。**
> **兩件事都要做：慢雜湊（00 章）＋ 不讓爛密碼進來（這一節）。**

### 2.9.4 接到註冊 / 改密碼流程上

**密碼規則不屬於 Spring Security 的任何一個介面**——它是你自己的商業規則。
**用 Bean Validation 掛上去最乾淨**：

```java
package com.example.lab09.ch02;

import jakarta.validation.*;
import java.lang.annotation.*;

@Documented
@Constraint(validatedBy = StrongPasswordValidator.class)
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
public @interface StrongPassword {
    String message() default "密碼強度不足";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
```

```java
package com.example.lab09.ch02;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

public class StrongPasswordValidator implements ConstraintValidator<StrongPassword, String> {

    @Override
    public boolean isValid(String pw, ConstraintValidatorContext ctx) {
        if (pw == null) return true;                       // null 交給 @NotNull 管
        // ⚠️ 這裡拿不到 username —— 跨欄位的檢查要用類別層級的 constraint（見下）
        PasswordPolicy.Verdict v = PasswordPolicy.nistRule(pw, null, null);
        if (v.ok()) return true;

        ctx.disableDefaultConstraintViolation();
        ctx.buildConstraintViolationWithTemplate(String.join("；", v.problems()))
           .addConstraintViolation();
        return false;
    }
}
```

**「密碼不能包含帳號」是跨欄位規則，要掛在類別上**：

```java
package com.example.lab09.ch02;

import jakarta.validation.constraints.*;

public record RegisterRequest(
        @NotBlank @Size(min = 3, max = 64) String username,
        @NotBlank @Size(max = 64) String displayName,
        @NotBlank @StrongPassword String password) {

    /** 跨欄位規則：用 @AssertTrue，訊息掛在這個「虛擬屬性」上 */
    @AssertTrue(message = "密碼不能包含帳號或名字")
    public boolean isPasswordUnrelatedToIdentity() {
        if (password == null) return true;
        return PasswordPolicy.nistRule(password, username, displayName).problems().stream()
                .noneMatch(p -> p.startsWith("不能包含"));
    }
}
```

```java
package com.example.lab09.ch02;

import jakarta.validation.Valid;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class RegisterController {

    private final AppUserRepo repo;
    private final PasswordEncoder encoder;

    public RegisterController(AppUserRepo repo, PasswordEncoder encoder) {
        this.repo = repo; this.encoder = encoder;
    }

    @PostMapping("/register")
    @Transactional
    public Map<String, Object> register(@Valid @RequestBody RegisterRequest req) {
        String username = req.username().trim();                 // ★ 2.3.2：登入時會 trim，註冊也要
        if (repo.findByUsername(username).isPresent()) {
            // ⚠️ 這一句就是「帳號列舉」的洩漏點 —— 07 章 7.4 會處理
            throw new IllegalStateException("帳號已存在");
        }
        AppUser u = new AppUser(username, encoder.encode(req.password()), req.displayName());
        u.grant("ROLE_USER");
        repo.save(u);
        return Map.of("username", u.getUsername());
    }
}
```

⚠️ **`register` 這支端點自己就是一個帳號列舉的入口**——
「帳號已存在」這個回應等於在說「這個 email 有註冊」。
**07 章 7.4 會給完整解法**（提示：改成「我們寄了一封信給你」，不論帳號存不存在）。

### 2.9.5 註冊與改密碼還有五件事

```
① 改密碼要驗【舊密碼】—— 不然任何拿到 session 的人都能鎖死帳號
② 改密碼成功要【作廢其他 session】（2.7.7 的 SessionRegistry）
③ 改密碼 / 改 email 要寄通知信 —— 這是使用者發現帳號被盜的主要管道
④ 密碼欄位不要設【上限太低】—— 至少允許 64 字元
   ⚠️ 但 BCrypt 只吃前 72 位元組（00 章 0.7.6），中文只有 24 個字
     → 要嘛換 Argon2，要嘛在規則裡把 72 位元組寫成硬限制（2.9.2 的實作有做）
⑤ 註冊表單不要即時回報「這個帳號已被使用」—— 那是一支免費的帳號列舉 API
```

**② 的實作**（Spring Security 6 有內建的支援）：

```java
// 改密碼成功後，把這個使用者的其他 session 全部作廢
@Bean
SessionRegistry sessionRegistry() { return new SessionRegistryImpl(); }

@Transactional
public void changePassword(String username, String oldRaw, String newRaw) {
    AppUser u = repo.findByUsername(username).orElseThrow();
    if (!encoder.matches(oldRaw, u.getPasswordHash()))          // ① 驗舊密碼
        throw new BadCredentialsException("舊密碼錯誤");
    PasswordPolicy.Verdict v = PasswordPolicy.nistRule(newRaw, username, u.getDisplayName());
    if (!v.ok()) throw new IllegalArgumentException(String.join("；", v.problems()));
    u.setPasswordHash(encoder.encode(newRaw));                  // ② 換雜湊

    for (Object p : sessionRegistry.getAllPrincipals())         // ③ 踢掉其他 session
        if (p instanceof DbUserDetailsService.AppUserDetails d && d.getUsername().equals(username))
            sessionRegistry.getAllSessions(p, false).forEach(SessionInformation::expireNow);
}
```

---

## 2.10 自訂認證的三個層次

### 2.10.1 先選層次，再寫程式碼

**八成的「我要客製認證」，其實只要動最底下那一層。**

```
┌─────────────────────────────────────────────────────────────────────┐
│ 層次三：新的 Filter + 新的 Token + 新的 Provider                       │
│   什麼時候需要：出現了一種【全新的憑證傳輸方式】                          │
│   例子：API key 標頭、JWT、簡訊驗證碼登入、掃碼登入                       │
│   成本：三個類別 + 一段設定 + 要自己處理 SecurityContext 的儲存           │
├─────────────────────────────────────────────────────────────────────┤
│ 層次二：自訂 AuthenticationProvider                                   │
│   什麼時候需要：憑證還是帳密，但【驗證邏輯】不一樣                        │
│   例子：帳密 + 一次性密碼、帳密 + 圖形驗證碼、對外部系統驗證               │
│   成本：一個類別（而且應該【繼承】DaoAuthenticationProvider）             │
├─────────────────────────────────────────────────────────────────────┤
│ 層次一：換 UserDetailsService（★ 八成的需求在這裡）                     │
│   什麼時候需要：帳號在別的地方、或者 UserDetails 要多帶欄位               │
│   例子：帳號在 MySQL / LDAP / 另一個微服務、principal 要帶部門與租戶      │
│   成本：一個類別                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**2.7 已經做完層次一了。** 這一節做另外兩層。

### 2.10.2 層次二：在密碼之外再檢查一個一次性密碼

**關鍵是【繼承】而不是【重寫】**——2.5.5 規則二。

**先解決一個問題：OTP 從哪裡進來？** 它不在 `username` / `password` 裡，
所以要用 2.2.4 那個 `details`：

```java
package com.example.lab09.ch02;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.authentication.AuthenticationDetailsSource;
import org.springframework.security.web.authentication.WebAuthenticationDetails;

public class OtpDetails extends WebAuthenticationDetails {
    private final String otp;

    public OtpDetails(HttpServletRequest req) {
        super(req);                                  // 父類別會抓 remoteAddress 與 sessionId
        this.otp = req.getHeader("X-OTP");           // ★ 多抓一個標頭
    }

    public String getOtp() { return otp; }

    /** Filter 要用這個工廠來產生 details */
    public static class Source implements AuthenticationDetailsSource<HttpServletRequest, OtpDetails> {
        @Override public OtpDetails buildDetails(HttpServletRequest req) { return new OtpDetails(req); }
    }
}
```

**然後覆寫 `additionalAuthenticationChecks`——並且第一行就呼叫 `super`**：

```java
package com.example.lab09.ch02;

import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.userdetails.UserDetails;

public class OtpAwareDaoProvider extends DaoAuthenticationProvider {

    /** 真實系統會查 TOTP；這裡用「使用者名稱長度 × 111」當作可預測的假驗證碼 */
    static String expectedOtp(String username) { return String.valueOf(username.length() * 111); }

    @Override
    protected void additionalAuthenticationChecks(UserDetails user,
            UsernamePasswordAuthenticationToken authentication) throws AuthenticationException {

        super.additionalAuthenticationChecks(user, authentication);   // ① 先驗密碼（含計時保護）

        Object details = authentication.getDetails();
        String otp = (details instanceof OtpDetails d) ? d.getOtp() : null;
        if (otp == null || !otp.equals(expectedOtp(user.getUsername())))
            throw new BadCredentialsException("一次性密碼錯誤");      // ② 再驗 OTP
    }
}
```

**設定時要把兩件事接起來**：

```java
package com.example.lab09.ch02;

import org.springframework.context.annotation.*;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@Profile("ca1")
public class OtpConfig {

    @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }

    @Bean UserDetailsService uds(PasswordEncoder enc) {
        return new InMemoryUserDetailsManager(
                User.withUsername("alice").password(enc.encode("pw")).roles("USER").build());
    }

    @Bean SecurityFilterChain chain(HttpSecurity http, UserDetailsService uds, PasswordEncoder enc)
            throws Exception {
        OtpAwareDaoProvider p = new OtpAwareDaoProvider();
        p.setUserDetailsService(uds);
        p.setPasswordEncoder(enc);
        return http
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .httpBasic(h -> h.authenticationDetailsSource(new OtpDetails.Source()))   // ★ 換 details 來源
            .authenticationManager(new ProviderManager(p))                            // ★ 換 provider
            .csrf(c -> c.disable())
            .build();
    }
}
```

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.List;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"ca", "ca1"})
class OtpTest {

    @LocalServerPort int port;

    record C(String pw, String otp, String note) {}

    @Test void twoFactor() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.10.2 層次二：在密碼之外再檢查一個一次性密碼 ═══");
        System.out.println("  alice 的正確 OTP = " + OtpAwareDaoProvider.expectedOtp("alice"));

        for (C c : List.of(
                new C("pw", "555", "密碼對、OTP 對"),
                new C("pw", "000", "密碼對、OTP 錯"),
                new C("pw", null,  "密碼對、沒帶 OTP"),
                new C("WRONG", "555", "密碼錯、OTP 對"))) {
            HttpResponse<String> r = http.get("/api/hello",
                    "Authorization", Http.basic("alice", c.pw()), "X-OTP", c.otp());
            System.out.printf("  %-22s → HTTP %d%n", c.note(), r.statusCode());
        }
    }
}
```

```
═══ 2.10.2 層次二：在密碼之外再檢查一個一次性密碼 ═══
  alice 的正確 OTP = 555
  密碼對、OTP 對              → HTTP 200
  密碼對、OTP 錯              → HTTP 401
  密碼對、沒帶 OTP             → HTTP 401
  密碼錯、OTP 對              → HTTP 401
```

📌 **`super.additionalAuthenticationChecks(...)` 那一行是這個做法的全部價值**：
你自動繼承了 2.5.2 的計時攻擊防護、2.5.4 的例外隱藏、以及 2.8 的密碼升級。
**自己從頭寫一個 `AuthenticationProvider`，這三樣全部要重做（而且大概率會漏）。**

⚠️ **順序也有講究：先驗密碼、再驗 OTP。**

```
🔴 反過來寫（先驗 OTP 再驗密碼）會怎樣：
   OTP 錯的時候，回應【不做 BCrypt】→ 快 68 ms
   → 攻擊者可以用時間差判斷「我的 OTP 對不對」，把兩個因素拆開各別暴力破解
   → 這正是 2.5.3 那個問題的變形
```

⚠️ **真正的二階段驗證還缺三樣**（本節只示範接線）：

```
① OTP 要有【時效】與【一次性】—— 用過就作廢，否則攔截到一次就能重放
② OTP 錯誤要【單獨計數並鎖定】—— 六位數只有一百萬種，不鎖就能暴力破解
③ 要有【備用碼】—— 手機掉了怎麼辦，這是真實系統最常被忽略的一環
```

### 2.10.3 層次三：一條鏈上同時支援兩種憑證

**目標**：同一組 API，人類用 Basic 帳密，機器用 `X-API-Key` 標頭。

**要三個東西：一種 token、一個 provider、一個 filter。**

```java
package com.example.lab09.ch02;

import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;

import java.util.Collection;

public class ApiKeyToken extends AbstractAuthenticationToken {

    private final String key;
    private final String clientId;

    /** 未認證：Filter 挖出憑證之後建的 */
    public ApiKeyToken(String key) {
        super(null);
        this.key = key;
        this.clientId = null;
        setAuthenticated(false);
    }

    /** 已認證：Provider 驗過之後建的 */
    public ApiKeyToken(String clientId, Collection<? extends GrantedAuthority> authorities) {
        super(authorities);
        this.key = null;                 // ★ 認證後不留憑證
        this.clientId = clientId;
        super.setAuthenticated(true);
    }

    @Override public Object getCredentials() { return key; }
    @Override public Object getPrincipal() { return clientId == null ? "(unknown client)" : clientId; }
}
```

```java
package com.example.lab09.ch02;

import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.authority.AuthorityUtils;

import java.util.Map;

public class ApiKeyProvider implements AuthenticationProvider {

    // ⚠️ 正式環境的 API key 要【雜湊之後存資料庫】，跟密碼一樣（00 章 0.7）
    private static final Map<String, String> KEYS = Map.of(
            "sk_live_9f3a...", "billing-batch",
            "sk_live_2b7c...", "warehouse-sync");

    @Override public Authentication authenticate(Authentication a) throws AuthenticationException {
        String key = String.valueOf(a.getCredentials());
        String client = KEYS.get(key);
        if (client == null) throw new BadCredentialsException("API key 無效");
        return new ApiKeyToken(client, AuthorityUtils.createAuthorityList("ROLE_SERVICE"));
    }

    @Override public boolean supports(Class<?> c) {
        return ApiKeyToken.class.isAssignableFrom(c);      // ★ 2.4.2：用 isAssignableFrom
    }
}
```

**Filter 的四個步驟，跟 2.3.1 的骨架一一對應**：

```java
package com.example.lab09.ch02;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.context.*;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.context.*;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

public class ApiKeyFilter extends OncePerRequestFilter {

    private final AuthenticationManager manager;
    private final SecurityContextRepository repo = new RequestAttributeSecurityContextRepository();
    private final AuthenticationEntryPoint entryPoint =
            (req, res, ex) -> res.sendError(401, "API key 無效或未提供");

    public ApiKeyFilter(AuthenticationManager manager) { this.manager = manager; }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String key = req.getHeader("X-API-Key");
        if (key == null) { chain.doFilter(req, res); return; }        // ① 沒有憑證 → 放行給後面的人

        try {
            Authentication result = manager.authenticate(new ApiKeyToken(key));   // ② 交給 manager

            SecurityContext ctx = SecurityContextHolder.createEmptyContext();
            ctx.setAuthentication(result);
            SecurityContextHolder.setContext(ctx);
            repo.saveContext(ctx, req, res);                          // ③ ★ 6.x 要自己存（01 章 1.5）

            chain.doFilter(req, res);
        } catch (AuthenticationException e) {
            SecurityContextHolder.clearContext();                     // ④ 失敗要清乾淨、走 entry point
            entryPoint.commence(req, res, e);
        }
    }
}
```

⚠️ **這個 Filter 的四個步驟，每一個都對應一個常見的 bug**：

| 步驟 | 漏掉會怎樣 |
|---|---|
| ① 沒憑證就放行 | 寫成 `throw` 的話，**Basic 認證與匿名存取全部壞掉** |
| ② 交給 manager | 自己在 Filter 裡驗證 = 2.5.5 規則二的錯誤 |
| ③ `repo.saveContext` | 00 章 0.3.6 那個事故：登入成功但下一步說沒登入 |
| ④ `clearContext` + entry point | 不清乾淨 → 01 章 1.9.3 的執行緒污染；不走 entry point → 例外散出去變 500 |

**設定**：

```java
package com.example.lab09.ch02;

import org.springframework.context.annotation.*;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter;

@Configuration
@Profile("ca2")
public class ApiKeyConfig {

    @Bean PasswordEncoder enc() { return PasswordEncoderFactories.createDelegatingPasswordEncoder(); }

    @Bean UserDetailsService uds(PasswordEncoder enc) {
        return new InMemoryUserDetailsManager(
                User.withUsername("alice").password(enc.encode("pw")).roles("USER").build());
    }

    @Bean SecurityFilterChain chain(HttpSecurity http, UserDetailsService uds, PasswordEncoder enc)
            throws Exception {
        DaoAuthenticationProvider dao = new DaoAuthenticationProvider();
        dao.setUserDetailsService(uds);
        dao.setPasswordEncoder(enc);

        // ★ 一個 manager，兩個 provider —— 2.4.1 的迴圈負責派工
        AuthenticationManager manager = new ProviderManager(new ApiKeyProvider(), dao);

        return http
            .authorizeHttpRequests(a -> a
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .httpBasic(Customizer.withDefaults())
            .authenticationManager(manager)
            .addFilterBefore(new ApiKeyFilter(manager), BasicAuthenticationFilter.class)   // ★ 放在 Basic 之前
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())
            .build();
    }
}
```

```java
package com.example.lab09.ch02;

import com.example.lab09.Http;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import java.net.http.HttpResponse;
import java.util.List;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles({"ca", "ca2"})
class ApiKeyTest {

    @LocalServerPort int port;

    record C(String header, String value, String note) {}

    @Test void twoCredentialTypes() {
        Http http = new Http(port);
        System.out.println("\n═══ 2.10.3 層次三：一條鏈上同時支援兩種憑證 ═══");

        for (C c : List.of(
                new C("X-API-Key", "sk_live_9f3a...", "有效的 API key"),
                new C("X-API-Key", "sk_live_0000...", "無效的 API key"),
                new C("Authorization", Http.basic("alice", "pw"), "Basic 帳密"),
                new C("Authorization", Http.basic("alice", "WRONG"), "Basic 密碼錯"),
                new C("Accept", "application/json", "什麼憑證都沒帶"))) {
            HttpResponse<String> r = http.get("/api/hello", c.header(), c.value());
            System.out.printf("  %-18s → HTTP %-4d %s%n", c.note(), r.statusCode(),
                    r.statusCode() == 200 ? r.body() : r.headers()
                            .firstValue("WWW-Authenticate").map(v -> "WWW-Authenticate: " + v).orElse(""));
        }

        System.out.println("\n  ── API key 拿到的是什麼身分？");
        HttpResponse<String> r = http.get("/api/admin/revenue", "X-API-Key", "sk_live_9f3a...");
        System.out.println("  打 /api/admin/revenue（需要 ROLE_ADMIN）→ HTTP " + r.statusCode()
                + "（API key 的角色是 ROLE_SERVICE）");
    }
}
```

```
═══ 2.10.3 層次三：一條鏈上同時支援兩種憑證 ═══
  有效的 API key        → HTTP 200  {"msg":"hello"}
  無效的 API key        → HTTP 401  WWW-Authenticate: Basic realm="Realm"
  Basic 帳密           → HTTP 200  {"msg":"hello"}
  Basic 密碼錯          → HTTP 401  WWW-Authenticate: Basic realm="Realm"
  什麼憑證都沒帶            → HTTP 401  WWW-Authenticate: Basic realm="Realm"

  ── API key 拿到的是什麼身分？
  打 /api/admin/revenue（需要 ROLE_ADMIN）→ HTTP 403（API key 的角色是 ROLE_SERVICE）
```

**兩種憑證在同一條鏈上共存。** 四個細節值得指出來：

```
① 有效的 API key → 200，而且【完全沒有經過 BasicAuthenticationFilter】
   （因為 ApiKeyFilter 已經把身分放進 context，而 Basic 那邊沒有 Authorization 標頭）

② 無效的 API key → 401，但 WWW-Authenticate 標頭寫的是 Basic
   —— 我的 entryPoint 用 sendError(401)，而回應被 chain 上的 BasicAuthenticationEntryPoint 補了標頭
   ⚠️ 這是一個「兩個 entry point 打架」的訊號，2.10.4 會講怎麼處理

③ 什麼都沒帶 → 401，兩個 filter 都放行，被第 16 個 AuthorizationFilter 擋下來（2.2.3）

④ API key 的身分是 ROLE_SERVICE，打 admin 端點 → 403 而不是 401
   —— 這正是 00 章 0.4.2 的分界：【已認證但權限不足】
```

⚠️ **關於 ②，正式環境應該讓錯誤格式一致**（01 章 1.8.5）：

```java
// 用 DelegatingAuthenticationEntryPoint：依請求特徵挑一個 entry point
@Bean
AuthenticationEntryPoint entryPoint() {
    LinkedHashMap<RequestMatcher, AuthenticationEntryPoint> map = new LinkedHashMap<>();
    map.put(req -> req.getHeader("X-API-Key") != null,
            (req, res, ex) -> ApiErrors.write401(req, res, ex));       // 帶了 key → JSON 錯誤
    DelegatingAuthenticationEntryPoint entry = new DelegatingAuthenticationEntryPoint(map);
    entry.setDefaultEntryPoint(new BasicAuthenticationEntryPoint());   // 其餘 → Basic 挑戰
    return entry;
}
```

### 2.10.4 三個層次的決策表

| 需求 | 層次 | 動什麼 | 注意 |
|---|---|---|---|
| 帳號改從 MySQL / LDAP 查 | **一** | `UserDetailsService` | 拋 `UsernameNotFoundException`（2.5.5） |
| `principal` 要多帶部門 / 租戶 | **一** | 自訂 `UserDetails` | 不要用 Entity（2.7.3） |
| 帳號狀態規則不一樣（例如「試用期過了算停用」） | **一** | 在 `UserDetails` 的布林值裡算 | 或換 `UserDetailsChecker`（2.5.3 修法 A） |
| 密碼 + 圖形驗證碼 / OTP | **二** | 繼承 `DaoAuthenticationProvider` | **第一行呼叫 `super`**（2.10.2） |
| 對外部系統驗證（另一個微服務） | **二** | 自訂 provider | 自己補計時保護與例外一致 |
| 兩套帳號系統並存 | **二** | 兩個 provider（2.6.2 am7） | 不要寫「查不到再查另一個」的 UDS |
| API key / JWT / 掃碼登入 | **三** | Filter + Token + Provider | 四個步驟一個都不能漏（2.10.3） |
| 登入成功 / 失敗要回什麼 | — | `successHandler` / `failureHandler` | 不用動 provider（2.3.6） |
| 登入端點的網址、欄位名 | — | `loginProcessingUrl` 等 | 不用動 provider（2.3.2） |

📌 **一條可以用來自我檢查的判準**：

> **如果你寫的類別裡出現了 `passwordEncoder.matches(...)`，
> 而它不是在 `additionalAuthenticationChecks` 的 `super` 呼叫底下——**
> **停下來，回頭看 2.5.5 的三條規則。**

---

## 2.11 shop-service 落地

**01 章 1.10 留下的四個「還沒有的東西」，這一章補掉三個**：

```
✅ 帳號還是寫死在 application.yml 的 spring.security.user.*   → 2.7 搬到 MySQL
✅ 角色只有 ROLE_USER / ROLE_ADMIN 兩種，而且是硬編碼           → authority 表
✅ 沒有註冊、沒有改密碼、沒有帳號鎖定                            → 2.9.4 / 2.9.5 / 2.7.6
⏳ IDOR 還在（00 章 0.3.1 那個事故一行都沒修）                   → 03 章
```

**這一章結束時，shop-service 的認證設定長這樣**：

⚠️ **`ShopAuthConfig` 的 `passwordEncoder` 取代 00 章 0.3.0 `Users` 裡的那一個**——
兩者的 bean 名都是 `passwordEncoder`，同時留著會 `BeanDefinitionOverrideException`。
`Users` 那組記憶體帳號從這一章起由 MySQL 取代，**把整個 `Users` 類別刪掉**
（實驗專案要留著做對照的話，照 2.1.1 標 `@Profile("!db & !am & !ca")`）。

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.*;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.userdetails.UserDetailsPasswordService;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

@Configuration
public class ShopAuthConfig {

    /** ① 分派式雜湊：新的存 bcrypt，舊的（含 {MD5} / {noop}）還驗得過（00 章 0.7.5） */
    @Bean
    PasswordEncoder passwordEncoder() {
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }

    /**
     * ② 明確組出 AuthenticationManager（2.6.2 am3）。
     *    不依賴自動設定，是為了：
     *      - 未來要加第二個 provider 時不會踩到 2.6.3 的 StackOverflowError
     *      - 錯誤訊息維持 Spring Security 內建的 i18n（2.6.4）
     */
    @Bean
    AuthenticationManager authenticationManager(UserDetailsService uds,
                                                PasswordEncoder encoder,
                                                UserDetailsPasswordService pwUpgrade) {
        DaoAuthenticationProvider dao = new DaoAuthenticationProvider();
        dao.setUserDetailsService(uds);
        dao.setPasswordEncoder(encoder);
        dao.setUserDetailsPasswordService(pwUpgrade);              // ③ 密碼漸進升級（2.8）

        // ④ 帳號狀態檢查搬到密碼比對【之後】—— 2.5.3 修法 A
        dao.setPreAuthenticationChecks(user -> { });
        dao.setPostAuthenticationChecks(user -> {
            if (!user.isAccountNonLocked())
                throw new org.springframework.security.authentication.LockedException("帳號已鎖定");
            if (!user.isEnabled())
                throw new org.springframework.security.authentication.DisabledException("帳號已停用");
            if (!user.isAccountNonExpired())
                throw new org.springframework.security.authentication.AccountExpiredException("帳號已過期");
            if (!user.isCredentialsNonExpired())
                throw new org.springframework.security.authentication.CredentialsExpiredException("密碼已過期");
        });

        // ⑤ 不掛 UserCache —— 2.7.8 量過，預設設定下它省不到查詢，關掉 erase 又會開兩個洞
        return new ProviderManager(dao);
    }
}
```

**接到 01 章 1.10 那兩條 chain 上**：

```java
package com.example.lab09.shop;

import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;

@Configuration
public class ShopSecurityConfig {

    /** ① 靜態資源：完全跳過 Security（01 章 1.7.5 的唯一合法用途） */
    @Bean
    WebSecurityCustomizer staticResources() {
        return web -> web.ignoring().requestMatchers("/css/**", "/js/**", "/images/**", "/favicon.ico");
    }

    /** ② REST API：無狀態、JSON 錯誤 */
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http, AuthenticationManager am) throws Exception {
        return http
            .securityMatcher("/api/**", "/error")
            .authenticationManager(am)                                       // ★ 02 章：明確指定
            .authorizeHttpRequests(a -> a
                .requestMatchers("/error").permitAll()                       // 01 章 1.8.3
                .requestMatchers("/api/auth/login", "/api/auth/register").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(c -> c.disable())                                          // 00 章 0.5.6 的判準
            // ⚠️ Basic 只是【暫時】的：2.3.5 量過它撐不住流量，05 章換成 JWT
            .httpBasic(Customizer.withDefaults())
            // 01 章 1.8.5：包住後面所有 Filter，讓 Filter 層例外也有一致的 JSON
            .addFilterBefore(new FilterErrorTranslationFilter(), SecurityContextHolderFilter.class)
            .exceptionHandling(e -> e
                .authenticationEntryPoint(ApiErrors::write401)
                .accessDeniedHandler(ApiErrors::write403))
            .build();
    }

    /** ③ 其餘（後台網頁、Actuator）：有 session、表單登入 */
    @Bean
    @Order(2)                                                                // 01 章 1.7.4：一定要最後
    SecurityFilterChain webChain(HttpSecurity http, AuthenticationManager am) throws Exception {
        return http
            .authenticationManager(am)
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/actuator/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .formLogin(f -> f
                // 2.7.6：密碼過期的人要有出口，不然等於帳號報廢
                .failureHandler((req, res, ex) -> res.sendRedirect(
                    ex instanceof org.springframework.security.authentication.CredentialsExpiredException
                            ? "/password/expired" : "/login?error")))
            .build();
    }
}
```

**再加上兩個啟動檢查**：

```
00 章 0.8.4 的 SecurityChainReporter   → 印出每一條 chain 上的 Filter，並對三種設定錯誤發警告
2.6.3 的 AuthWiringReporter            → 印出 UserDetailsService / PasswordEncoder 各有幾個 bean
```

⚠️ **兩個都已經標了 `@Profile("!prod")`，直接放進專案就好，不需要改**——
它們是**啟動時**的檢查，不是執行期的行為，所以不會影響正式環境。

📌 **這兩份輸出合起來，就是「我的安全設定到底長什麼樣」的完整答案**：
一份回答「請求會經過哪些 Filter」（01 章），一份回答「誰在驗密碼」（這一章）。

**本章結束時，shop-service 的樣子**：

```
帳號來源      MySQL 的 app_user / authority 兩張表
密碼          DelegatingPasswordEncoder（{bcrypt} cost=10），登入時自動升級舊格式
帳號狀態      五個布林值都接上了，而且【檢查在密碼比對之後】（不洩漏帳號是否存在）
註冊          有規則檢查（NIST 800-63B），密碼不能包含帳號
錯誤格式      Filter 層與 Controller 層一致（01 章 1.8.5）
啟動檢查      Filter Chain + 認證接線，兩份都會印出來
```

⚠️ **還沒有的東西**（後面章節補）：

```
🔴 IDOR 還在 —— alice 依然讀得到 bob 的訂單（00 章 0.3.1）        → 03 章
🔴 API 用 HTTP Basic —— 2.3.5 量過它的吞吐量上限是 73 個/秒        → 05 章換 JWT
🔴 停用帳號不會立刻踢掉現有 session（2.7.7 只給了骨架）             → 04 章
🔴 登入失敗沒有計數、沒有鎖定                                      → 07 章
🔴 沒有任何稽核紀錄 —— 誰在什麼時候登入過，查不到                    → 08 章
```

---

## 2.12 常見誤區

**誤區 1：「`UserDetailsService` 查不到人，回 `null` 就好了」**

→ 2.5.3 實測：時間差從 1.01 倍變成 **11849 倍**，帳號是否存在完全洩漏。
而且 `null` 會變成 `InternalAuthenticationServiceException`，
**中止整條 provider 迴圈**（2.4.3 案例 C）並灌爆 ERROR 日誌。
**一定要拋 `UsernameNotFoundException`。**

---

**誤區 2：「自己寫一個 `AuthenticationProvider` 比較單純，反正就是查帳號比密碼」**

→ 2.5.3 壞法三：**11876 倍**。
你需要重新實作的東西有：計時攻擊防護（2.5.2）、例外隱藏（2.5.4）、
帳號狀態檢查的四種例外（2.7.6）、密碼漸進升級（2.8）、快取重試（2.5.1）。
**要客製就【繼承】`DaoAuthenticationProvider`，並且第一行呼叫 `super`。**

---

**誤區 3：「讓 Entity 直接 `implements UserDetails` 可以少寫一個類別」**

→ 2.7.3 實測：`LazyInitializationException` → **帳密正確卻回 401**。
另外還有四個問題：整個 Entity 被塞進 session、資料會過期、
`equals`/`hashCode` 語意衝突、序列化到 Redis 會爆。
**`UserDetails` 是快照，Entity 是有生命週期的可變物件。**

---

**誤區 4：「`AuthenticationManager` 注入不進來，那我自己宣告一個就好」**

→ 對，但要選對寫法。2.6.2 實測七種：
`am1` 直接注入**啟動就失敗**、`am2`/`am3` 都可以、
而 `am6`（容器裡有兩個 `UserDetailsService`）會**啟動成功、第一次登入 `StackOverflowError`**。
**`@Primary` 在這裡沒有用**（2.6.3）。

---

**誤區 5：「HTTP Basic 很單純，API 就用它」**

→ 2.3.5 實測：單執行緒 **12.8 個/秒**，八核並行 **73.4 個/秒**。
因為每一個請求都要跑一次 BCrypt（68 ms），而那是 CPU 上限。
**Basic 適合內部服務對服務、CI 腳本；公開 API 要用 token（05 章）。**

---

**誤區 6：「我把帳號停用了，那個人就進不來了」**

→ 2.7.7 實測：**帶著舊 cookie 照樣 200**。
五個布林值只在**認證那一刻**被檢查一次。
**要立刻生效，得主動作廢他的 session（`SessionRegistry`）。**

---

**誤區 7：「掛個 `UserCache` 可以省下每個請求那句 SQL」**

→ 2.7.8 實測：**用預設值省下的是零**。
`eraseCredentials` 會把快取裡那份的密碼清成 `null`，
於是每次都驗不過、每次都重查一次 DB，還多做了一次白費的 BCrypt。
**關掉 `eraseCredentials` 它才會生效——然後改密碼與停用帳號都不會立刻生效。**

---

**誤區 8：「密碼規則要嚴格：大小寫 + 數字 + 符號 + 90 天強制換」**

→ 2.9.2 實測：這套規則**放行 `P@ssw0rd`（11.5 分鐘破解）**，
**拒絕 `correct horse battery staple`（熵高三倍）**。
NIST 800-63B 的建議剛好相反：**長度優先 + 比對外洩字典 + 不強制組合 + 不定期換。**

---

**誤區 9：「登入失敗要給明確的訊息，不然使用者不知道錯在哪」**

→ 2.3.4 / 2.7.6 實測：Spring 的預設是**六種失敗、六個一模一樣的回應**，這是對的。
**正確的做法是「對外一致、對內分流」**（2.3.6）：
HTTP 回應永遠是「帳號或密碼錯誤」，真正的原因只寫進日誌。

---

**誤區 10：「帳號被鎖定的人，回應要告訴他『你被鎖定了』」**

→ 這會製造一個帳號列舉工具（2.5.3 壞法四）：
被鎖定的帳號回應**快 6000 倍**，攻擊者連讀回應內容都不用，量時間就夠了。
**修法是把狀態檢查搬到密碼比對之後**——他必須先證明自己是本人。

---

**誤區 11：「`hideUserNotFoundExceptions` 關掉方便除錯」**

→ 2.5.4：關掉之後例外訊息會**直接印出那個不存在的帳號名**，
而它會沿著 `@ExceptionHandler`、`failureHandler`、錯誤日誌三條路徑洩漏出去。
**要除錯就開 DEBUG 日誌，不要改行為。**

---

**誤區 12：「`UsernamePasswordAuthenticationToken` 就是拿來 new 的」**

→ 2.2.2 實測：**三參數建構子會直接把 `authenticated` 設成 `true`**，不做任何檢查。
**新程式碼一律用 `unauthenticated(...)` / `authenticated(...)` 這兩個靜態工廠**——
讓「這是請求」還是「這是結果」在程式碼裡看得出來。05 章會再遇到一次。

---

## 2.13 本章小結

**這一章把「誰在驗你的密碼」這個問題拆成了三層，然後把每一層的坑量了一遍。**

**一、認證是三層委派，而且每一層都【只做一件事】（2.2）。**

```
Filter    把憑證從 HTTP 挖出來 ── 它不驗證任何東西
Manager   找一個能處理的 provider ── 它也不驗證任何東西
Provider  真的去驗 ── 底下再拆成 UserDetailsService + PasswordEncoder
```

**「沒帶憑證 → 401」不是認證 Filter 做的**——它只是放行，
一路走到第 16 個 `AuthorizationFilter` 才被擋（2.2.3）。

**二、`ProviderManager` 的迴圈有六條規則，其中兩條會咬人（2.4）。**

```
第一個成功的就結束，後面的 provider 完全不會被問到
AccountStatusException 與 InternalAuthenticationServiceException 會【立刻中止迴圈】
return null 與 throw 語意不同：前者是「我不處理」，後者是「我判定失敗」
兩個 provider 都失敗時，往外拋的是【最後一個】的例外
```

**三、`DaoAuthenticationProvider` 替你避開了三個你不知道存在的坑，
而它們都可以被你自己的程式碼弄壞（2.5）。**

```
✅ 正確寫法（拋 UsernameNotFoundException）      1.01 倍
🔴 UserDetailsService 回 null                  11849 倍
🔴 自己換成 BadCredentialsException             7771 倍
🔴 自己寫一個 AuthenticationProvider            11876 倍
🔴 帳號被停用 / 鎖定（★ 這個是【預設行為】）        快 6000 倍
```

**最後一個不是你寫錯的**——`preAuthenticationChecks` 在密碼比對之前，
修法是把它搬到 `postAuthenticationChecks`（2.5.3 修法 A，已實測）。

**四、帳號搬到資料庫之後，有四個量得出來的取捨（2.7）。**

```
無狀態 + Basic   每個請求 1 句 SQL + 1 次 BCrypt = 69 ms（2.7.4、2.3.5）
有 session      後續請求 0 句 SQL —— 但帳號停用不會立刻生效（2.7.7）
Entity 當 UserDetails   LazyInitializationException → 帳密正確卻 401（2.7.3）
掛 UserCache    預設設定下省不到任何查詢；關掉 erase 才有效，然後開兩個洞（2.7.8）
```

**五、`AuthenticationManager` 不是 bean 是刻意的（2.6）。**

```
它是【每條 chain 各自擁有】的東西，不該是全域單例
七種寫法裡，am2（AuthenticationConfiguration）與 am3（自己組）是對的
🔴 容器裡有兩個 UserDetailsService → 啟動成功、第一次登入 StackOverflowError
   而 @Primary 沒有用 —— 它檢查的是「有幾個」，不是「該選哪個」
```

**六、密碼這件事，00 章講「怎麼存」，這一章講「怎麼換」與「怎麼擋」（2.8、2.9）。**

```
UserDetailsPasswordService  登入一次，cost=4 自動換成 cost=10，使用者無感
credentials_expire_at       給舊雜湊一個死線，兩者搭配就是完整的遷移計畫
NIST 800-63B                長度優先、比對外洩字典；不要強制字元組合、不要定期強制換
P@ssw0rd                    通過所有組合規則，字典攻擊 11.5 分鐘破解
```

### 2.13.1 驗收清單

```
□ 認證的三層各自負責什麼？哪一層【不】驗證任何東西？
□ Authentication 物件在認證前後差在哪三個地方？credentials 是誰抹掉的？
□ 三參數的 UsernamePasswordAuthenticationToken 建構子做了什麼危險的事？
□ AbstractAuthenticationProcessingFilter 的六個步驟？哪一步是抽象的？
□ BasicAuthenticationFilter 為什麼不是它的子類？三個差異是什麼？
□ authenticationIsRequired() 是什麼？為什麼「帶錯密碼也是 200」？
□ 一支用 HTTP Basic 保護的 API，吞吐量上限由什麼決定？怎麼算？
□ 表單登入要幾個往返？SavedRequest 是什麼？為什麼還沒登入就有 JSESSIONID？
□ 要把登入改成 JSON 介面，要換哪三個東西？漏了哪一個會讓前端收到 HTML？
□ ProviderManager 迴圈的六條規則？哪兩種例外會立刻中止？
□ provider 回 null 與 throw 的語意差別？兩個都失敗時拋哪一個例外？
□ DaoAuthenticationProvider.authenticate() 的七個步驟？帳號狀態在第幾步？
□ mitigateAgainstTimingAttack 在哪一個 catch 裡？另外三個出口為什麼沒有？
□ 三種讓計時保護失效的寫法？各自量到幾倍？
□ 為什麼「帳號被鎖定」會洩漏帳號存在？兩個修法的代價各是什麼？
□ hideUserNotFoundExceptions 關掉會沿著哪三條路徑洩漏？
□ AuthenticationManager 為什麼不是 bean？三個理由？
□ 容器裡有兩個 UserDetailsService 會怎樣？為什麼 @Primary 沒用？
□ UserDetails 的五個布林值分別對應什麼例外？哪一個在密碼比對【之後】？
□ 為什麼不要讓 Entity 直接 implements UserDetails？五個問題？
□ 無狀態與有 session，一個請求各查幾次 DB？
□ 帳號停用後舊 session 還能用多久？四個解法的生效時間？
□ 掛上 UserCache 之後省下幾句 SQL？為什麼？
□ UserDetailsPasswordService 的 newPassword 參數是明碼還是雜湊？
□ 密碼打錯會不會觸發升級？為什麼？
□ 「大小寫 + 數字 + 符號」為什麼是錯的方向？NIST 建議什麼？
□ P@ssw0rd 在 BCrypt cost=10 下撐多久？用 MD5 呢？
□ 自訂認證的三個層次分別在什麼時候用？
□ 自訂 Filter 的四個步驟，各自漏掉會發生什麼事？
```

### 2.13.2 本章練習

**練習一（動手）：把 2.5.3 的四種壞法在你自己的專案上量一次**

1. 把你專案裡的 `UserDetailsService` 找出來，確認查不到人時拋的是什麼。
2. 用 2.5.3 的 `measure()` 量「存在的帳號 + 錯密碼」與「不存在的帳號」的中位數。
3. 如果差距大於 3 倍，找出是四種壞法的哪一種。
4. 修好之後再量一次，確認落回 1.0x 附近。

**練習二（動手）：算出你的服務的登入吞吐量上限**

1. 用 2.3.5 的 `report()` 量單執行緒的「每個請求都帶 Basic」。
2. 乘上你的核心數，得到理論上限。
3. 回答：如果今天有一次行銷活動帶來每秒 500 個登入，會發生什麼？
4. 再回答：把 BCrypt cost 從 10 降到 8 能解決嗎？代價是什麼？

**練習三（動手）：重現 2.6.3 的 `StackOverflowError`**

1. 在你的專案裡多宣告一個 `@Bean UserDetailsService`（隨便一個 `InMemoryUserDetailsManager`）。
2. 確認應用程式**啟動成功**。
3. 打一次登入，確認你拿到 `StackOverflowError`。
4. 試著用 `@Primary` 修——確認它**沒有用**。
5. 用 2.6.2 的 am7 寫法修好，確認**兩組帳號都登得進去**。

**練習四（動手）：讓「停用帳號」立刻生效**

1. 用 2.7.7 的程式碼重現「停用後舊 cookie 照樣 200」。
2. 加上 `SessionRegistry` + `HttpSessionEventPublisher`，實作 `AccountAdminService.disable()`。
3. 確認停用後舊 cookie 立刻變成 401。
4. 回答：如果你的服務跑在三台機器上（session 沒共享），第 2 步還有效嗎？

**練習五（動手）：做一次密碼演算法遷移**

1. 在資料庫裡插三筆帳號，雜湊分別是 `{noop}`、`{bcrypt}` cost=4、`{bcrypt}` cost=10。
2. 掛上 `UserDetailsPasswordService`，讓三個帳號各登入一次。
3. 查資料庫，確認哪幾筆變了、哪幾筆沒變。
4. 把 `PasswordEncoder` 的預設換成 `argon2`，再各登入一次，確認全部變成 `{argon2}`。
5. 回答：`{noop}` 那一筆在步驟 2 之前，如果被外洩了，你要做什麼？

**練習六（動手）：加一層二階段驗證**

1. 照 2.10.2 實作 `OtpDetails` + `OtpAwareDaoProvider`。
2. 把 `expectedOtp` 換成真的 TOTP（`java.util.Base32` + `HmacSHA1`，或用 `dev.samstevens.totp`）。
3. 加上「OTP 用過就作廢」與「OTP 錯五次鎖定」。
4. 回答：如果 `super.additionalAuthenticationChecks(...)` 那一行被移到 OTP 檢查【之後】，
   攻擊者能多知道什麼？

**練習七（讀原始碼）：找出「快取為什麼沒生效」**

打開 `org.springframework.security.authentication.dao.AbstractUserDetailsAuthenticationProvider`，
找到 `authenticate(Authentication)`。

- `cacheWasUsed` 這個變數控制了什麼行為？
- 為什麼「快取命中但驗證失敗」時要重查一次？它防的是什麼情況？
- 再打開 `AbstractAuthenticationToken.eraseCredentials()`，
  想清楚它為什麼會讓 2.7.8 那個快取變成無效。
- 如果 Spring 改成「放進快取前先複製一份」，2.7.8 的兩個洞會消失嗎？

**練習八（思考題）：兩套帳號系統要怎麼合併**

公司併購，你要讓兩套系統的使用者都能登入同一個服務。

- 用一個 `UserDetailsService`「先查 A、查不到再查 B」——這樣為什麼不好？
  （提示：2.5.2 的計時保護會發生什麼事？）
- 用兩個 provider（2.6.2 am7）——如果兩邊有同名帳號，會發生什麼？
- 如果 B 系統的密碼是 MD5 存的，你要怎麼設計遷移路徑？（提示：2.8.3 的第 ④ 點）

---

## 2.14 下一章預告

**03 章：授權與權限模型。**

這一章從頭到尾在回答「**你是誰**」。而 00 章 0.3.1 那個事故，
到現在**一行都沒有修**：

```
alice 登入了（✅ 這一章做完了）
alice 打 GET /api/orders/1002（bob 的訂單）
→ 200，完整的訂單內容
```

**因為「登入」與「可以看這一筆」是兩個問題**（00 章 0.4）。

**這一章留下了三個線索**，03 章會用到：

| 這一章的東西 | 03 章要用它做什麼 |
|---|---|
| `authority` 表與 `getAuthorities()` | 角色（`ROLE_ADMIN`）與權限（`order:refund`）的差別，以及 RBAC 的資料表設計 |
| `@AuthenticationPrincipal AppUserDetails me` | 方法層授權的輸入——`@PreAuthorize` 的運算式裡可以直接讀 `principal` 的欄位（03 章會替它加上 `userId`） |
| 2.7.2 那個「多帶一個 `displayName`」 | 同樣的手法可以多帶 `tenantId`、`departmentId`——**資料層級授權的鑰匙** |

**還有四個 03 章要處理的問題**：

```
① hasRole("ADMIN") 與 hasAuthority("ADMIN") 差在哪？為什麼會有 ROLE_ 這個前綴
② URL 層規則（authorizeHttpRequests）與方法層註解（@PreAuthorize），什麼時候用哪一個
③ @PreAuthorize 與 @PostAuthorize 的差別 —— 以及【後者會先把資料查出來】的代價
④ 「買家只能看自己的訂單」這種規則，寫在哪一層？
   寫在 Controller、Service、還是 Repository？三個位置的取捨是什麼？
```

📌 **03 章結束時，00 章 0.3.1 那個事故會被修掉**——
而且會用**同角色的兩個帳號（alice 與 bob）**證明它真的修好了（00 章 0.8.2 的固定裝置就是為此準備的）。

⚠️ **順帶預告一個 03 章的實測**：
`@PreAuthorize` 標在 `private` 方法上、或者被同一個類別的方法直接呼叫時，
**它完全不會生效，而且不會有任何警告**——
這是 02 站 04 章那個 AOP 自我呼叫問題，在安全設定上的版本。
